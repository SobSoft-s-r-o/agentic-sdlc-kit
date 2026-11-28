import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DEADLINE_MS,
  effectiveMode,
  GIT_TIMEOUT_MS,
  registerHookCommand,
  runHook,
  type HookContext,
} from '../../src/commands/hook.js';
import { loadConfig, typeRegistry, type Config } from '../../src/config/schema.js';
import { promptRef } from '../../src/hooks/session.js';
import { StateCommentError } from '../../src/core/stateComment.js';
import { newTask } from '../../src/core/stateMachine.js';
import type { Approval, Phase, TaskState } from '../../src/core/types.js';
import { GhError } from '../../src/github/gh.js';
import { createGitRunner, type GitRunner } from '../../src/install/provision.js';
import type { HookEventName, HookHarness } from '../../src/hooks/types.js';
import { CASE_INSENSITIVE_FS, recased } from '../support/caseFs.js';
import { FakeTracker } from '../support/fakeTracker.js';
import { createTestRepo, type TestRepo } from '../support/gitRepo.js';

const base = loadConfig(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/config/valid.yaml'));
const enforce: Config = { ...base, mode: 'enforce' };
const observe: Config = { ...base, mode: 'observe' };
const NOW = '2026-06-01T00:00:00.000Z';
const MINUTE = 60_000;

const APPROVAL: Approval = {
  source: 'comment',
  ref: 'https://example.test/issues/5#issuecomment-1',
  by: 'shop-owner',
  at: '2026-05-31T00:00:00.000Z',
};

/** A feature task in planning, with or without an approved plan. */
function feature(issue: number, planApproved: boolean, phase: Phase = 'planning'): TaskState {
  const type = typeRegistry(enforce).get('feature');
  if (!type) throw new Error('no feature type');
  return {
    ...newTask({ issue, type, summary: 'Do the thing', now: '2026-05-30T00:00:00.000Z' }),
    phase,
    stages: planApproved ? { planning: { revision: 1, publishedAt: '2026-05-30T01:00:00.000Z', approval: APPROVAL } } : {},
  };
}

interface Run {
  code: 0;
  /** Everything written to stdout, joined; the hook writes at most one text. */
  stdout: string;
  stderr: string[];
  ctx: HookContext;
}

let repo: TestRepo;
let tracker: FakeTracker;
/** The repository root as git reports it (the temp directory is a symlink on macOS). */
let root: string;

beforeEach(() => {
  repo = createTestRepo();
  repo.write('README.md', 'x\n');
  repo.commit('init');
  root = realpathSync(repo.root);
  tracker = new FakeTracker();
});
afterEach(() => {
  repo.cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const payload = (cwd: string, tool: string, input: Record<string, unknown>): string =>
  JSON.stringify({ session_id: 's1', cwd, tool_name: tool, tool_input: input });

const claudeWrite = (file: string, cwd = repo.root): string => payload(cwd, 'Write', { file_path: file });

const taskBranch = (branch: string): void => {
  repo.git('checkout', '-q', '-b', branch);
};

interface Options {
  stdin: string;
  readStdin?: () => Promise<string>;
  gitFor?: HookContext['gitFor'];
  cfg?: Config | undefined | 'throw';
  /** Replaces `cfg` with a config by checkout root (the worktree and the main checkout may differ). */
  loadConfig?: HookContext['loadConfig'];
  /** The command line named the config file (`--config`). */
  explicitConfig?: boolean;
  makeTracker?: HookContext['makeTracker'];
  now?: () => string;
  deadlineMs?: number;
  exit?: (code: number) => void;
  spawnSync?: (root: string) => void;
  readOnly?: boolean;
  env?: Record<string, string | undefined>;
}

async function run(harness: HookHarness, event: HookEventName, options: Options): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const cfg = 'cfg' in options ? options.cfg : enforce;
  const ctx: HookContext = {
    cwd: repo.root,
    readStdin: options.readStdin ?? (async () => options.stdin),
    loadConfig:
      options.loadConfig ??
      (() => {
        if (cfg === 'throw') throw new Error('Invalid config:\n  - mode: bad');
        return cfg;
      }),
    makeTracker: options.makeTracker ?? (() => tracker),
    gitFor: options.gitFor ?? (dir => createGitRunner(dir)),
    ...(options.explicitConfig === undefined ? {} : { explicitConfig: options.explicitConfig }),
    now: options.now ?? (() => NOW),
    out: text => out.push(text),
    err: text => err.push(text),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.exit === undefined ? {} : { exit: options.exit }),
    ...(options.spawnSync === undefined ? {} : { spawnSync: options.spawnSync }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    // Never the environment of the test run itself: the harness may have set its project variables there.
    env: options.env ?? {},
  };
  const code = await runHook(harness, event, ctx);
  return { code, stdout: out.join(''), stderr: err, ctx };
}

const claudePreTool = (stdin: string, extra: Partial<Options> = {}): Promise<Run> =>
  run('claude', 'pre-tool', { stdin, ...extra });

const gapLines = (): Array<Record<string, unknown>> => {
  const file = join(repo.root, '.sdlc', 'cache', 'gaps.jsonl');
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line) as Record<string, unknown>)
    : [];
};

const taskCache = (): Record<string, unknown> | undefined => {
  const file = join(repo.root, '.sdlc', 'cache', 'hook-tasks.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : undefined;
};

const denyReason = (stdout: string): string => {
  const parsed = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  return parsed.hookSpecificOutput.permissionDecisionReason;
};

describe('the time the hook may take', () => {
  /** The `timeout` the harness settings get for the pre-tool hook. */
  const PRE_TOOL_TIMEOUT_MS = 15_000;

  it('fits the pre-tool timeout in the worst case: the checkout of the cwd and of a file (two git calls each), then GitHub', () => {
    expect(GIT_TIMEOUT_MS).toBe(2000);
    expect(DEFAULT_DEADLINE_MS).toBe(6000);
    expect(4 * GIT_TIMEOUT_MS + DEFAULT_DEADLINE_MS).toBeLessThan(PRE_TOOL_TIMEOUT_MS);
  });
});

describe('runHook pre-tool: edits', () => {
  it('denies an edit before the plan is approved and records the gap', async () => {
    taskBranch('task/5-x');
    tracker.seedTask(feature(5, false));

    const result = await claudePreTool(claudeWrite(join(repo.root, 'src', 'a.ts')));

    expect(result.code).toBe(0);
    expect(result.stderr).toEqual([]);
    const reason = denyReason(result.stdout);
    expect(reason).toMatch(/^sdlc \(enforce\): #5 is in planning and its plan is not approved yet/);
    expect(gapLines()).toEqual([
      { at: NOW, rule: 'plan-not-approved', text: reason.replace('sdlc (enforce): ', ''), harness: 'claude', blocked: true, issue: 5 },
    ]);
    // A "not allowed" answer is never cached, so the owner's approval counts on the next edit.
    expect(taskCache()).toBeUndefined();
  });

  it('observe: warns instead, and records the gap as not blocked', async () => {
    taskBranch('task/5-x');
    tracker.seedTask(feature(5, false));

    const result = await claudePreTool(claudeWrite(join(repo.root, 'src', 'a.ts')), { cfg: observe });

    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
      systemMessage: string;
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.systemMessage).toMatch(/^sdlc \(observe\): #5 is in planning and its plan is not approved yet/);
    expect(parsed.hookSpecificOutput.additionalContext).toBe(parsed.systemMessage);
    expect(gapLines()).toMatchObject([{ rule: 'plan-not-approved', blocked: false, issue: 5, harness: 'claude' }]);
  });

  it('allows an edit once the plan is approved, and caches the task for ten minutes', async () => {
    taskBranch('task/5-x');
    tracker.seedTask(feature(5, true));
    const getTask = vi.spyOn(tracker, 'getTask');
    const stdin = claudeWrite(join(repo.root, 'src', 'a.ts'));

    const first = await claudePreTool(stdin);
    expect(first.stdout).toBe('');
    expect(first.stderr).toEqual([]);
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(Object.keys(taskCache() ?? {})).toEqual(['5']);
    expect(gapLines()).toEqual([]);

    const second = await claudePreTool(stdin, { now: () => new Date(Date.parse(NOW) + 9 * MINUTE).toISOString() });
    expect(second.stdout).toBe('');
    expect(getTask).toHaveBeenCalledTimes(1);

    const later = await claudePreTool(stdin, { now: () => new Date(Date.parse(NOW) + 11 * MINUTE).toISOString() });
    expect(later.stdout).toBe('');
    expect(getTask).toHaveBeenCalledTimes(2);
  });

  it('does not take a cached allow for a task whose state is no longer allowed once the entry has expired', async () => {
    taskBranch('task/5-x');
    tracker.seedTask(feature(5, true));
    const stdin = claudeWrite(join(repo.root, 'src', 'a.ts'));
    await claudePreTool(stdin);

    // The owner takes the task back to planning without an approval, and the entry expires.
    tracker.comments = [];
    tracker.issues = [];
    tracker.seedTask(feature(5, false));
    const result = await claudePreTool(stdin, { now: () => new Date(Date.parse(NOW) + 11 * MINUTE).toISOString() });

    expect(denyReason(result.stdout)).toContain('its plan is not approved yet');
  });

  it('reads the task from the worktree that holds the file, not from the cwd checkout', async () => {
    repo.git('worktree', 'add', '-q', '-b', 'task/7-y', '.worktrees/7-y');
    tracker.seedTask(feature(7, false));
    const getTask = vi.spyOn(tracker, 'getTask');

    const result = await claudePreTool(claudeWrite(join(repo.root, '.worktrees', '7-y', 'src', 'new.ts')));

    expect(getTask).toHaveBeenCalledTimes(1);
    expect(getTask).toHaveBeenCalledWith(7);
    expect(denyReason(result.stdout)).toContain('#7 is in planning');
    expect(gapLines()).toMatchObject([{ rule: 'plan-not-approved', issue: 7 }]);
  });

  it('judges the protected-path rule against the root of the checkout that holds the file', async () => {
    repo.git('worktree', 'add', '-q', '-b', 'task/7-x', '.worktrees/7-x');

    const result = await claudePreTool(claudeWrite(join(repo.root, '.worktrees', '7-x', 'sdlc.config.yaml')));

    expect(denyReason(result.stdout)).toContain('sdlc.config.yaml is protected');
    expect(gapLines()).toMatchObject([{ rule: 'protected-path', blocked: true, issue: 7 }]);
  });

  it('lets a file outside the project be edited, and asks no task', async () => {
    taskBranch('task/5-x');
    const getTask = vi.spyOn(tracker, 'getTask');

    const result = await claudePreTool(claudeWrite('/tmp/sdlc-outside/notes.txt'));

    expect(result.stdout).toBe('');
    expect(getTask).not.toHaveBeenCalled();
    expect(gapLines()).toEqual([]);
  });

  it('leaves a file of another repository alone, whatever its branch says', async () => {
    taskBranch('task/5-x');
    const other = createTestRepo();
    try {
      other.write('README.md', 'x\n');
      other.commit('init');
      other.git('checkout', '-q', '-b', 'task/9-z');
      const getTask = vi.spyOn(tracker, 'getTask');

      const result = await claudePreTool(claudeWrite(join(other.root, 'src', 'a.ts')));

      expect(result.stdout).toBe('');
      expect(getTask).not.toHaveBeenCalled();
      expect(gapLines()).toEqual([]);
    } finally {
      other.cleanup();
    }
  });

  describe('the git directory', () => {
    it.each(['.git/config', '.git/hooks/pre-commit'])('denies a write to %s in enforce, asking no task', async file => {
      taskBranch('task/5-x');
      const getTask = vi.spyOn(tracker, 'getTask');

      const result = await claudePreTool(claudeWrite(join(repo.root, file)));

      expect(denyReason(result.stdout)).toContain(`${file} is protected`);
      expect(getTask).not.toHaveBeenCalled();
      expect(gapLines()).toMatchObject([{ rule: 'protected-path', blocked: true, issue: 5 }]);
    });

    it.each(['.git/config', '.git/hooks/pre-commit'])('allows a write to %s in observe, like the other protected paths', async file => {
      const result = await claudePreTool(claudeWrite(join(repo.root, file)), { cfg: observe });

      expect(result.stdout).toBe('');
      expect(result.stderr).toEqual([]);
      expect(gapLines()).toEqual([]);
    });

    it('denies the config and hooks of the shared git directory from a worktree, and the .git file of the worktree itself', async () => {
      repo.git('worktree', 'add', '-q', '-b', 'task/7-x', '.worktrees/7-x');
      const cwd = join(repo.root, '.worktrees', '7-x');

      for (const [file, shown] of [
        [join(repo.root, '.git', 'hooks', 'pre-commit'), '.git/hooks/pre-commit'],
        [join(repo.root, '.git', 'worktrees', '7-x', 'config.worktree'), '.git/worktrees/7-x/config.worktree'],
        [join(cwd, '.git'), '.git'],
      ] as const) {
        const result = await claudePreTool(claudeWrite(file, cwd));

        expect(denyReason(result.stdout), file).toContain(`${shown} is protected`);
      }
    });

    it('denies a mis-cased .GIT/ as well', async () => {
      const result = await claudePreTool(claudeWrite(join(repo.root, '.GIT', 'hooks', 'pre-push')));

      expect(denyReason(result.stdout)).toContain('is protected');
    });
  });

  it.skipIf(!CASE_INSENSITIVE_FS)('does not let the case of a path hide sdlc.config.yaml (case-insensitive filesystems)', async () => {
    const miscased = join(dirname(repo.root), recased('repo') as string, 'sdlc.config.yaml');

    const result = await claudePreTool(claudeWrite(miscased));

    expect(denyReason(result.stdout)).toContain('sdlc.config.yaml is protected');
    expect(gapLines()).toMatchObject([{ rule: 'protected-path', blocked: true }]);
  });

  it('treats a file that is in the project but not under its checkout root as protected: enforce denies, observe says nothing', async () => {
    // Git and the path disagree about the root (the case bug of a case-insensitive filesystem), simulated.
    const gitFor = (dir: string): GitRunner => {
      const real = createGitRunner(dir);
      return async args => {
        const result = await real(args);
        if (args[0] !== 'rev-parse') return result;
        const [top, ...rest] = result.stdout.split('\n');
        return { ...result, stdout: [(top ?? '').toUpperCase(), ...rest].join('\n') };
      };
    };
    const stdin = claudeWrite(join(repo.root, 'sdlc.config.yaml'));

    const enforced = await claudePreTool(stdin, { gitFor });
    const observed = await claudePreTool(stdin, { gitFor, cfg: observe });

    expect(denyReason(enforced.stdout)).toContain('is protected');
    expect(observed.stdout).toBe('');
    expect(gapLines()).toMatchObject([{ rule: 'protected-path', blocked: true }]);
  });

  it('counts a git call killed on its time limit as no checkout for that file: the edit is allowed', async () => {
    taskBranch('task/5-x');
    const getTask = vi.spyOn(tracker, 'getTask');
    let calls = 0;
    const gitFor = (dir: string): GitRunner => {
      const real = createGitRunner(dir);
      // The first checkout (the cwd, two git calls) is found; the one of the file times out.
      return args => (++calls <= 2 ? real(args) : Promise.resolve({ stdout: '', code: 1, stderr: 'terminated by SIGTERM' }));
    };

    const result = await claudePreTool(claudeWrite(join(repo.root, 'src', 'a.ts')), { gitFor });

    expect(result.stdout).toBe('');
    expect(result.stderr).toEqual([]);
    expect(getTask).not.toHaveBeenCalled();
  });

  it('leaves an edit alone when git is killed before it names the branch of the file: unresolved, not a branch-less checkout', async () => {
    taskBranch('task/5-x');
    const getTask = vi.spyOn(tracker, 'getTask');
    let calls = 0;
    const gitFor = (dir: string): GitRunner => {
      const real = createGitRunner(dir);
      // Calls 1 and 2 find the checkout of the cwd; 3 and 4 are rev-parse and symbolic-ref of the file's.
      return args =>
        ++calls === 4 ? Promise.resolve({ stdout: '', code: 1, stderr: 'terminated by SIGTERM' }) : real(args);
    };

    const result = await claudePreTool(claudeWrite(join(repo.root, 'src', 'a.ts')), { gitFor });

    expect(calls).toBe(4);
    expect(result.stdout).toBe('');
    expect(result.stderr).toEqual([]);
    expect(getTask).not.toHaveBeenCalled();
    expect(gapLines()).toEqual([]);
  });

  it('does not call the tracker for Markdown and docs edits (Codex apply_patch)', async () => {
    taskBranch('task/5-x');
    const getTask = vi.spyOn(tracker, 'getTask');
    const patch = '*** Begin Patch\n*** Update File: docs/a.md\n@@\n-a\n+b\n*** Add File: docs/new/b.txt\n+x\n*** End Patch';

    const result = await run('codex', 'pre-tool', {
      stdin: payload(repo.root, 'apply_patch', { command: patch }),
    });

    expect(result.stdout).toBe('');
    expect(result.stderr).toEqual([]);
    expect(getTask).not.toHaveBeenCalled();
  });

  it('reports a branch with no task as no-task', async () => {
    const result = await claudePreTool(claudeWrite(join(repo.root, 'src', 'a.ts')));

    expect(denyReason(result.stdout)).toContain('editing src/a.ts outside a task');
    expect(gapLines()).toMatchObject([{ rule: 'no-task', blocked: true }]);
    expect(gapLines()[0]).not.toHaveProperty('issue');
  });

  it('reports a task branch whose issue has no tracked task as no-task', async () => {
    taskBranch('task/9-x');
    tracker.issues.push({ number: 9, title: 'x', body: '', labels: [], open: true, onBoard: false });

    const result = await claudePreTool(claudeWrite(join(repo.root, 'src', 'a.ts')));

    expect(denyReason(result.stdout)).toContain('editing src/a.ts outside a task');
    expect(gapLines()).toMatchObject([{ rule: 'no-task', issue: 9 }]);
  });

  it('records one gap per violation, each with the issue of its file', async () => {
    repo.git('worktree', 'add', '-q', '-b', 'task/7-y', '.worktrees/7-y');
    taskBranch('task/5-x');
    tracker.seedTask(feature(5, false));
    tracker.seedTask(feature(7, false));
    const patch = '*** Begin Patch\n*** Add File: src/a.ts\n+a\n*** Add File: .worktrees/7-y/src/b.ts\n+b\n*** End Patch';

    const result = await run('codex', 'pre-tool', { stdin: payload(repo.root, 'apply_patch', { command: patch }) });

    expect(denyReason(result.stdout)).toContain('#5 is in planning');
    expect(gapLines()).toMatchObject([
      { rule: 'plan-not-approved', issue: 5, blocked: true, harness: 'codex' },
      { rule: 'plan-not-approved', issue: 7, blocked: true, harness: 'codex' },
    ]);
  });

  it('asks the tracker once per issue when several files share a task', async () => {
    taskBranch('task/5-x');
    tracker.seedTask(feature(5, true));
    const getTask = vi.spyOn(tracker, 'getTask');
    const patch = '*** Begin Patch\n*** Add File: src/a.ts\n+a\n*** Add File: src/deep/b.ts\n+b\n*** Update File: lib/c.ts\n+c\n*** End Patch';

    const result = await run('codex', 'pre-tool', { stdin: payload(repo.root, 'apply_patch', { command: patch }) });

    expect(result.stdout).toBe('');
    expect(getTask).toHaveBeenCalledTimes(1);
  });

  it('resolves a relative Gemini path against the cwd', async () => {
    taskBranch('task/5-x');
    tracker.seedTask(feature(5, false));

    const result = await run('gemini', 'pre-tool', {
      stdin: payload(repo.root, 'write_file', { file_path: 'src/a.ts', content: 'x' }),
    });

    const parsed = JSON.parse(result.stdout) as { decision: string; reason: string };
    expect(parsed.decision).toBe('deny');
    expect(parsed.reason).toContain('#5 is in planning');
    expect(gapLines()).toMatchObject([{ harness: 'gemini', issue: 5 }]);
  });
});

describe('runHook pre-tool: harness settings', () => {
  /** The home directory of the test (createTestRepo points HOME at it). */
  const home = (): string => realpathSync(process.env.HOME as string);

  it.each(['.claude/settings.json', 'apps/web/.claude/settings.local.json', '.codex/hooks.json', '.gemini/settings.json', '.mcp.json'])(
    'enforce refuses an edit of %s in the project, even in a task with an approved plan',
    async file => {
      taskBranch('task/5-x');
      tracker.seedTask(feature(5, true, 'implementation'));
      const result = await claudePreTool(claudeWrite(join(repo.root, file)));
      expect(denyReason(result.stdout)).toContain(`${file} is protected`);
      expect(gapLines()).toMatchObject([{ rule: 'protected-path', blocked: true }]);
    },
  );

  it.each(['.claude/settings.json', '.claude/settings.local.json', '.codex/config.toml', '.codex/hooks.json', '.gemini/settings.json', '.claude.json'])(
    'enforce refuses an edit of the user-level ~/%s and logs it as a gap',
    async file => {
      const target = join(home(), file);
      const result = await claudePreTool(claudeWrite(target));
      expect(denyReason(result.stdout)).toContain(`${target} is protected`);
      expect(gapLines()).toMatchObject([{ rule: 'protected-path', blocked: true }]);
    },
  );

  it('observe lets a user-level settings file be edited, without a gap', async () => {
    const result = await claudePreTool(claudeWrite(join(home(), '.claude', 'settings.json')), { cfg: observe });
    expect(result.stdout).toBe('');
    expect(gapLines()).toEqual([]);
  });

  it('leaves other files of the home directory alone', async () => {
    const result = await claudePreTool(claudeWrite(join(home(), '.claude', 'agents', 'x.md')));
    expect(result.stdout).toBe('');
  });
});

describe('runHook pre-tool: a working directory without a checkout', () => {
  const outside = (): string => realpathSync(dirname(repo.root));

  it.each([
    ['claude', 'CLAUDE_PROJECT_DIR'],
    ['gemini', 'GEMINI_PROJECT_DIR'],
  ] as const)('%s: falls back to %s when it is in a checkout', async (harness, variable) => {
    taskBranch('task/5-x');
    const stdin =
      harness === 'claude'
        ? payload(outside(), 'Bash', { command: 'git push --force' })
        : payload(outside(), 'run_shell_command', { command: 'git push --force' });
    const result = await run(harness, 'pre-tool', { stdin, env: { [variable]: repo.root } });
    expect(result.stdout).toContain('force-pushing is not allowed');
    expect(result.stdout).toContain('deny');
    expect(gapLines()).toMatchObject([{ rule: 'force-push', blocked: true, issue: 5 }]);
  });

  it('codex has no project variable: CLAUDE_PROJECT_DIR is not read for it', async () => {
    const stdin = payload(outside(), 'Bash', { command: 'git push --force' });
    const result = await run('codex', 'pre-tool', { stdin, env: { CLAUDE_PROJECT_DIR: repo.root } });
    // Not resolved through the variable: the force push only warns, as without a config.
    expect(result.stdout).not.toContain('deny');
    expect(gapLines()).toEqual([]);
  });

  it('judges an edited file by its own checkout when neither the cwd nor a variable resolves', async () => {
    const result = await claudePreTool(claudeWrite(join(repo.root, 'sdlc.config.yaml'), outside()));
    expect(denyReason(result.stdout)).toContain('sdlc.config.yaml is protected');
    expect(gapLines()).toMatchObject([{ rule: 'protected-path', blocked: true }]);
  });

  it('still applies the rules that block in every mode to a shell command', async () => {
    const removal = await claudePreTool(payload(outside(), 'Bash', { command: 'sdlc uninstall' }));
    expect(denyReason(removal.stdout)).toContain('only the owner removes or overwrites the sdlc install');

    const warned = await claudePreTool(payload(outside(), 'Bash', { command: 'git push --force' }));
    expect(warned.stdout).not.toContain('deny');
    expect(warned.stdout).toContain('force-pushing is not allowed');
  });

  it('skips when nothing resolves', async () => {
    const result = await claudePreTool(claudeWrite(join(outside(), 'x.txt'), outside()), { env: { CLAUDE_PROJECT_DIR: outside() } });
    expect(result.stdout).toBe('');
    expect(result.stderr[0]).toContain('git repository');
  });
});

describe('runHook pre-tool: shell and subagent', () => {
  it('denies an admin merge without asking the tracker', async () => {
    taskBranch('task/5-x');
    const getTask = vi.spyOn(tracker, 'getTask');

    const result = await claudePreTool(payload(repo.root, 'Bash', { command: 'gh pr merge 1 --admin' }));

    expect(denyReason(result.stdout)).toContain('sdlc (enforce):');
    expect(getTask).not.toHaveBeenCalled();
    // The issue is the one of the cwd checkout's branch.
    expect(gapLines()).toMatchObject([{ rule: 'admin-merge', blocked: true, issue: 5, harness: 'claude' }]);
  });

  it('observe: a shell violation warns only', async () => {
    const result = await claudePreTool(payload(repo.root, 'Bash', { command: 'git push --force origin x' }), {
      cfg: observe,
    });

    expect(JSON.parse(result.stdout)).toHaveProperty('systemMessage');
    expect(result.stdout).not.toContain('deny');
    expect(gapLines()).toMatchObject([{ rule: 'force-push', blocked: false }]);
  });

  it('hook-spoof blocks in observe mode too, and its text is shown once', async () => {
    const result = await claudePreTool(payload(repo.root, 'Bash', { command: 'sdlc hook claude prompt < x.json' }), {
      cfg: observe,
    });

    const reason = denyReason(result.stdout);
    expect(result.stdout.split(reason)).toHaveLength(2);
    expect(result.stdout).not.toContain('systemMessage');
    expect(gapLines()).toMatchObject([{ rule: 'hook-spoof', blocked: true }]);
  });

  it('records every violation of one command, all marked blocked when the call is denied', async () => {
    const result = await claudePreTool(
      payload(repo.root, 'Bash', { command: 'gh pr merge 1 --admin && git push --force origin x' }),
    );

    denyReason(result.stdout);
    expect(gapLines().map(gap => [gap.rule, gap.blocked])).toEqual([
      ['admin-merge', true],
      ['force-push', true],
    ]);
  });

  it('denies a subagent with no role (Gemini protocol)', async () => {
    const result = await run('gemini', 'pre-tool', { stdin: payload(repo.root, 'invoke_agent', {}) });

    expect(JSON.parse(result.stdout)).toMatchObject({ decision: 'deny' });
    expect(gapLines()).toMatchObject([{ rule: 'subagent-role', harness: 'gemini', blocked: true }]);
  });

  it('says nothing for a tool it does not police', async () => {
    const result = await claudePreTool(payload(repo.root, 'Read', { file_path: join(repo.root, 'src', 'a.ts') }));

    expect(result.stdout).toBe('');
    expect(result.stderr).toEqual([]);
    expect(gapLines()).toEqual([]);
  });

  it('uses the mode of the config of the repository root found from the event cwd', async () => {
    const seen: string[] = [];
    const out: string[] = [];
    repo.git('worktree', 'add', '-q', '-b', 'task/7-y', '.worktrees/7-y');
    const cwd = join(repo.root, '.worktrees', '7-y');

    await runHook('claude', 'pre-tool', {
      cwd: repo.root,
      readStdin: async () => payload(cwd, 'Bash', { command: 'ls' }),
      loadConfig: dir => {
        seen.push(dir);
        return enforce;
      },
      makeTracker: () => tracker,
      gitFor: dir => createGitRunner(dir),
      now: () => NOW,
      out: text => out.push(text),
      err: text => out.push(text),
    });

    // The worktree's own config first, then the main checkout's, for the mode only.
    expect(seen).toEqual([join(root, '.worktrees', '7-y'), root]);
  });
});

describe('runHook: the mode comes from the main checkout', () => {
  const worktreeDir = (): string => join(repo.root, '.worktrees', '7-y');
  /** An edit outside any task, from a worktree on a branch that names none. */
  const editFromWorktree = (): string => claudeWrite(join(worktreeDir(), 'src', 'a.ts'), worktreeDir());
  const byRoot =
    (worktree: Config | undefined | 'throw', main: Config | undefined | 'throw'): HookContext['loadConfig'] =>
    dir => {
      const cfg = dir === root ? main : worktree;
      if (cfg === 'throw') throw new Error('Invalid config:\n  - mode: bad');
      return cfg;
    };

  beforeEach(() => {
    repo.git('worktree', 'add', '-q', '-b', 'topic/y', '.worktrees/7-y');
  });

  it('mode comes from the main checkout: a worktree config on observe is enforced when main says enforce', async () => {
    const result = await claudePreTool(editFromWorktree(), { loadConfig: byRoot(observe, enforce) });

    expect(result.stderr).toEqual([]);
    expect(denyReason(result.stdout)).toMatch(/^sdlc \(enforce\): editing src\/a\.ts outside a task/);
    expect(gapLines()).toMatchObject([{ rule: 'no-task', blocked: true }]);
  });

  it('and the other way round: main on observe only warns, whatever the worktree config says', async () => {
    const result = await claudePreTool(editFromWorktree(), { loadConfig: byRoot(enforce, observe) });

    expect(result.stdout).not.toContain('deny');
    expect((JSON.parse(result.stdout) as { systemMessage: string }).systemMessage).toMatch(/^sdlc \(observe\): editing src\/a\.ts/);
    expect(gapLines()).toMatchObject([{ rule: 'no-task', blocked: false }]);
  });

  it('takes nothing but the mode from main: the worktree keeps its own owners and the rest', async () => {
    repo.git('worktree', 'add', '-q', '-b', 'task/8-z', '.worktrees/8-z');
    tracker.seedTask(feature(8, true));
    const seen: Config[] = [];
    const worktree = { ...observe, owners: ['worktree-owner'] };

    const result = await run('claude', 'session-start', {
      stdin: sessionStart({}, join(repo.root, '.worktrees', '8-z')),
      loadConfig: byRoot(worktree, { ...enforce, owners: ['main-owner'] }),
      makeTracker: cfg => {
        seen.push(cfg);
        return tracker;
      },
    });

    expect(result.stderr).toEqual([]);
    expect(seen).toMatchObject([{ mode: 'enforce', owners: ['worktree-owner'] }]);
  });

  it.each([
    ['is missing', undefined],
    ['holds invalid YAML', 'throw'],
  ] as const)('mode falls back to the worktree config when the main config %s: no throw, exit 0', async (_name, main) => {
    const denied = await claudePreTool(editFromWorktree(), { loadConfig: byRoot(enforce, main) });
    expect(denied.code).toBe(0);
    expect(denied.stderr).toEqual([]);
    expect(denyReason(denied.stdout)).toMatch(/^sdlc \(enforce\):/);

    const warned = await claudePreTool(editFromWorktree(), { loadConfig: byRoot(observe, main) });
    expect(warned.code).toBe(0);
    expect(warned.stderr).toEqual([]);
    expect(warned.stdout).not.toContain('deny');
    expect((JSON.parse(warned.stdout) as { systemMessage: string }).systemMessage).toMatch(/^sdlc \(observe\):/);
  });

  it('--config wins over both: the explicit file decides, and main is not asked', async () => {
    const seen: string[] = [];
    const result = await claudePreTool(editFromWorktree(), {
      explicitConfig: true,
      loadConfig: dir => {
        seen.push(dir);
        return dir === root ? enforce : observe;
      },
    });

    expect(result.stdout).not.toContain('deny');
    expect(result.stdout).toContain('sdlc (observe)');
    expect(seen).toEqual([join(root, '.worktrees', '7-y')]);
  });

  it('asks the config once when the event is in the main checkout itself', async () => {
    const seen: string[] = [];
    await claudePreTool(claudeWrite(join(repo.root, 'src', 'a.ts')), {
      loadConfig: dir => {
        seen.push(dir);
        return enforce;
      },
    });

    expect(seen).toEqual([root]);
  });

  it('applies to session start as well: the line for the agent names the main checkout mode', async () => {
    const result = await run('claude', 'session-start', {
      stdin: JSON.stringify({ session_id: 's1', cwd: worktreeDir(), source: 'startup' }),
      loadConfig: byRoot(observe, enforce),
    });

    expect(result.stderr).toEqual([]);
    expect(result.stdout).toMatch(/enforce/);
    expect(result.stdout).not.toMatch(/observe/);
  });
});

describe('effectiveMode', () => {
  it('is the main checkout mode, unless the config was named explicitly or main has none', () => {
    expect(effectiveMode(observe, enforce, false)).toBe('enforce');
    expect(effectiveMode(enforce, observe, false)).toBe('observe');
    expect(effectiveMode(observe, enforce, true)).toBe('observe');
    expect(effectiveMode(enforce, undefined, false)).toBe('enforce');
    expect(effectiveMode(observe, undefined, true)).toBe('observe');
  });
});

describe('runHook: local files live in the main checkout', () => {
  const worktreeCwd = (): string => join(repo.root, '.worktrees', '7-x');

  it('writes the gaps log of a violation found from a worktree to the main checkout', async () => {
    repo.git('worktree', 'add', '-q', '-b', 'task/7-x', '.worktrees/7-x');

    const result = await claudePreTool(payload(worktreeCwd(), 'Bash', { command: 'gh pr merge 1 --admin' }));

    denyReason(result.stdout);
    expect(gapLines()).toMatchObject([{ rule: 'admin-merge', issue: 7, blocked: true }]);
    expect(existsSync(join(worktreeCwd(), '.sdlc'))).toBe(false);
  });

  it('writes the gaps log of an edit found from a worktree to the main checkout', async () => {
    repo.git('worktree', 'add', '-q', '-b', 'task/7-x', '.worktrees/7-x');
    tracker.seedTask(feature(7, false));

    await claudePreTool(claudeWrite(join(worktreeCwd(), 'src', 'a.ts'), worktreeCwd()));

    expect(gapLines()).toMatchObject([{ rule: 'plan-not-approved', issue: 7 }]);
    expect(existsSync(join(worktreeCwd(), '.sdlc'))).toBe(false);
  });

  it('keeps the task cache in the main checkout too, shared by every worktree', async () => {
    repo.git('worktree', 'add', '-q', '-b', 'task/7-x', '.worktrees/7-x');
    tracker.seedTask(feature(7, true));
    const getTask = vi.spyOn(tracker, 'getTask');
    const stdin = claudeWrite(join(worktreeCwd(), 'src', 'a.ts'), worktreeCwd());

    await claudePreTool(stdin);
    await claudePreTool(stdin);

    expect(Object.keys(taskCache() ?? {})).toEqual(['7']);
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(existsSync(join(worktreeCwd(), '.sdlc'))).toBe(false);
  });
});

describe('runHook: a prompt with nothing to answer', () => {
  it.each([
    ['claude', 'prompt', ''],
    ['codex', 'prompt', ''],
    ['gemini', 'prompt', '{}'],
  ] as const)('%s %s gives an empty outcome', async (harness, event, expected) => {
    const result = await run(harness, event, { stdin: JSON.stringify({ cwd: repo.root, session_id: 's', prompt: 'hi' }) });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(expected);
    expect(result.stderr).toEqual([]);
  });
});

describe('runHook: fails open', () => {
  const expectSkipped = (result: Run, harness: HookHarness): void => {
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(harness === 'gemini' ? '{}' : '');
    expect(result.stderr).toHaveLength(1);
    expect(result.stderr[0]).toMatch(/^sdlc: hook skipped: \S/);
    expect(result.stderr[0]).not.toContain('\n');
  };

  it.each(['claude', 'codex', 'gemini'] as const)('%s: stdin that is not JSON', async harness => {
    const result = await run(harness, 'pre-tool', { stdin: 'not json' });

    expectSkipped(result, harness);
    expect(result.stderr[0]).toContain('not valid JSON');
  });

  it.each(['claude', 'gemini'] as const)('%s: empty stdin', async harness => {
    expectSkipped(await run(harness, 'pre-tool', { stdin: '' }), harness);
  });

  it('a payload that is not a hook payload', async () => {
    const result = await claudePreTool(JSON.stringify({ tool_name: 'Write' }));

    expectSkipped(result, 'claude');
    expect(result.stderr[0]).toContain('no cwd');
  });

  it('stdin that cannot be read', async () => {
    const result = await claudePreTool('', {
      readStdin: async () => {
        throw new Error('stream closed');
      },
    });

    expectSkipped(result, 'claude');
    expect(result.stderr[0]).toBe('sdlc: hook skipped: stream closed');
  });

  it.each(['claude', 'gemini'] as const)('%s: no config', async harness => {
    const result = await run(harness, 'pre-tool', { stdin: claudeWrite(join(repo.root, 'src', 'a.ts')), cfg: undefined });

    expectSkipped(result, harness);
    expect(result.stderr[0]).toContain('sdlc.config.yaml');
  });

  it('a config that cannot be loaded, reduced to one line', async () => {
    const result = await claudePreTool(claudeWrite(join(repo.root, 'src', 'a.ts')), { cfg: 'throw' });

    expectSkipped(result, 'claude');
    expect(result.stderr[0]).toBe('sdlc: hook skipped: Invalid config: - mode: bad');
  });

  it('a cwd outside any git repository', async () => {
    const result = await claudePreTool(claudeWrite('/tmp/x.txt', '/tmp'));

    expectSkipped(result, 'claude');
    expect(result.stderr[0]).toContain('git repository');
  });

  it.each(['claude', 'gemini'] as const)('%s: git that cannot run', async harness => {
    const result = await run(harness, 'pre-tool', {
      stdin: claudeWrite(join(repo.root, 'src', 'a.ts')),
      gitFor: () => async () => {
        throw new Error('git not found; install https://git-scm.com');
      },
    });

    expectSkipped(result, harness);
    expect(result.stderr[0]).toBe('sdlc: hook skipped: git not found; install https://git-scm.com');
  });

  it('a task of a type the config does not define is a task that cannot be read: warning, edit allowed', async () => {
    taskBranch('task/5-x');
    tracker.seedTask({ ...feature(5, false), type: 'ghost-type' });

    const result = await claudePreTool(claudeWrite(join(repo.root, 'src', 'a.ts')));

    expect((JSON.parse(result.stdout) as { systemMessage: string }).systemMessage).toBe(
      'sdlc: could not read task #5; edit allowed',
    );
    expect(taskCache()).toBeUndefined();
  });

  it('a state comment that cannot be read is a task that cannot be read: warning, edit allowed (not no-task)', async () => {
    taskBranch('task/5-x');
    vi.spyOn(tracker, 'getTask').mockRejectedValue(new StateCommentError('state comment is not valid JSON'));

    const result = await claudePreTool(claudeWrite(join(repo.root, 'src', 'a.ts')));

    expect(result.stderr).toEqual([]);
    expect((JSON.parse(result.stdout) as { systemMessage: string }).systemMessage).toBe(
      'sdlc: could not read task #5; edit allowed',
    );
    expect(result.stdout).not.toContain('deny');
    expect(gapLines()).toEqual([]);
    expect(taskCache()).toBeUndefined();
  });

  it('ignores a cache file it cannot use and reads the tracker instead', async () => {
    taskBranch('task/5-x');
    tracker.seedTask(feature(5, true));
    const getTask = vi.spyOn(tracker, 'getTask');
    const stdin = claudeWrite(join(repo.root, 'src', 'a.ts'));
    const file = (content: string): void => repo.write('.sdlc/cache/hook-tasks.json', content);

    for (const content of [
      '{"5": {',
      '[]',
      '{"5": 3}',
      '{"5": {"at": "x", "state": 3}}',
      // From the future (a clock that went back): not trusted.
      JSON.stringify({ '5': { at: new Date(Date.parse(NOW) + MINUTE).toISOString(), state: feature(5, true) } }),
      // Another issue's state under this key.
      JSON.stringify({ '5': { at: NOW, state: feature(6, true) } }),
    ]) {
      file(content);
      getTask.mockClear();

      const result = await claudePreTool(stdin);

      expect(result.stdout).toBe('');
      expect(result.stderr).toEqual([]);
      expect(getTask).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps the cached entries of other issues when it caches one', async () => {
    taskBranch('task/5-x');
    tracker.seedTask(feature(5, true));
    repo.write('.sdlc/cache/hook-tasks.json', JSON.stringify({ '8': { at: NOW, state: feature(8, true) } }));

    await claudePreTool(claudeWrite(join(repo.root, 'src', 'a.ts')));

    expect(Object.keys(taskCache() ?? {}).sort()).toEqual(['5', '8']);
  });

  it('a failed task read is a warning and the edit is allowed, not a skipped hook', async () => {
    taskBranch('task/5-x');
    vi.spyOn(tracker, 'getTask').mockRejectedValue(new GhError(['issue', 'view', '5'], 'HTTP 502', 'gh failed'));

    const result = await claudePreTool(claudeWrite(join(repo.root, 'src', 'a.ts')));

    expect(result.stderr).toEqual([]);
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string }; systemMessage: string };
    expect(parsed.systemMessage).toBe('sdlc: could not read task #5; edit allowed');
    expect(result.stdout).not.toContain('deny');
    expect(taskCache()).toBeUndefined();
    expect(gapLines()).toEqual([]);
  });

  it('a task read that outlives the deadline is allowed with the same warning, and the process may end', async () => {
    taskBranch('task/5-x');
    vi.spyOn(tracker, 'getTask').mockReturnValue(new Promise(() => undefined));
    const exit = vi.fn();

    const result = await claudePreTool(claudeWrite(join(repo.root, 'src', 'a.ts')), { deadlineMs: 50, exit });

    expect(result.stderr).toEqual([]);
    expect((JSON.parse(result.stdout) as { systemMessage: string }).systemMessage).toBe(
      'sdlc: could not read task #5; edit allowed',
    );
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('does not end the process when no tracker call was abandoned', async () => {
    taskBranch('task/5-x');
    tracker.seedTask(feature(5, true));
    const exit = vi.fn();

    await claudePreTool(claudeWrite(join(repo.root, 'src', 'a.ts')), { exit });

    expect(exit).not.toHaveBeenCalled();
  });

  it('a gaps log that cannot be written does not turn a deny into an allow', async () => {
    repo.write('.sdlc/cache', 'a file where the directory should be');

    const result = await claudePreTool(payload(repo.root, 'Bash', { command: 'gh pr merge 1 --admin' }));

    expect(result.stderr).toEqual([]);
    denyReason(result.stdout);
  });
});

// -- session-start and prompt -------------------------------------------------------------------------

/** The lines of the additionalContext of a hook answer (any harness); fails when there is no context. */
const contextLines = (stdout: string): string[] => {
  const parsed = JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } };
  return parsed.hookSpecificOutput.additionalContext.split('\n');
};

const cacheFile = (name: string, at = repo.root): string => join(at, '.sdlc', 'cache', name);

const jsonLines = (name: string, at = repo.root): Array<Record<string, unknown>> =>
  existsSync(cacheFile(name, at))
    ? readFileSync(cacheFile(name, at), 'utf8')
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line) as Record<string, unknown>)
    : [];

/** #`issue` is in `phase` and that stage is published, waiting for the owner. */
const publishedStage = (phase: Phase, issue = 5): TaskState => ({
  ...feature(issue, false, phase),
  status: 'paused',
  waitingOn: 'owner',
  stages: { [phase]: { revision: 1, publishedAt: '2026-05-30T01:00:00.000Z' } },
});
/** #`issue` is in planning and its plan is published, waiting for the owner. */
const publishedPlan = (issue = 5): TaskState => publishedStage('planning', issue);

const sessionStart = (extra: Record<string, unknown> = {}, cwd = repo.root): string =>
  JSON.stringify({ session_id: 's1', cwd, source: 'startup', ...extra });

const claudePrompt = (prompt: string, extra: Record<string, unknown> = {}, cwd = repo.root): string =>
  JSON.stringify({ session_id: 's1', prompt_id: 'p1', cwd, prompt, ...extra });

describe('runHook session-start', () => {
  it('gives the agent the mode, the task and its next step', async () => {
    taskBranch('task/5-x');
    tracker.seedTask({ ...feature(5, true), nextStep: 'Write the code' }, { title: 'Add search' });

    const result = await run('claude', 'session-start', { stdin: sessionStart() });

    expect(result.stderr).toEqual([]);
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(contextLines(result.stdout)).toEqual([
      'sdlc: mode enforce. Task #5 "Add search": task #5: In progress · Planning · next: Write the code. Next step: Write the code.',
    ]);
  });

  it('answers a Gemini session start in its own event name', async () => {
    taskBranch('task/5-x');
    tracker.seedTask(feature(5, true), { title: 'Add search' });

    const result = await run('gemini', 'session-start', { stdin: sessionStart() });

    expect(JSON.parse(result.stdout)).toHaveProperty('hookSpecificOutput.hookEventName', 'SessionStart');
    expect(contextLines(result.stdout)[0]).toMatch(/^sdlc: mode enforce\. Task #5 "Add search": /);
  });

  it('points a branch without a task at sdlc task new, and asks GitHub nothing', async () => {
    const getTask = vi.spyOn(tracker, 'getTask');

    const result = await run('claude', 'session-start', { stdin: sessionStart(), cfg: observe });

    expect(contextLines(result.stdout)).toEqual([
      'sdlc: mode observe. No task on branch main. New work starts with `sdlc task new`; status questions use `sdlc status`.',
    ]);
    expect(getTask).not.toHaveBeenCalled();
  });

  it('says there is no task for a task branch whose issue has no tracked task', async () => {
    taskBranch('task/9-x');
    tracker.issues.push({ number: 9, title: 'x', body: '', labels: [], open: true, onBoard: false });

    const result = await run('claude', 'session-start', { stdin: sessionStart() });

    expect(contextLines(result.stdout)).toEqual([
      'sdlc: mode enforce. No task on branch task/9-x. New work starts with `sdlc task new`; status questions use `sdlc status`.',
    ]);
  });

  it('says the task could not be read, not that there is none, when GitHub cannot be asked', async () => {
    taskBranch('task/5-x');
    vi.spyOn(tracker, 'getTask').mockRejectedValue(new GhError(['issue', 'view', '5'], 'HTTP 502', 'gh failed'));

    const result = await run('claude', 'session-start', { stdin: sessionStart() });

    expect(result.stderr).toEqual([]);
    expect(contextLines(result.stdout)).toEqual([
      'sdlc: mode enforce. Task #5 could not be read from GitHub just now; its state is not shown.',
    ]);
  });

  it('gives up on a task read that outlives the deadline, with the same line, and lets the process end', async () => {
    taskBranch('task/5-x');
    vi.spyOn(tracker, 'getTask').mockReturnValue(new Promise(() => undefined));
    const exit = vi.fn();

    const result = await run('claude', 'session-start', { stdin: sessionStart(), deadlineMs: 50, exit });

    expect(result.stderr).toEqual([]);
    expect(contextLines(result.stdout)).toEqual([
      'sdlc: mode enforce. Task #5 could not be read from GitHub just now; its state is not shown.',
    ]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  describe('pending reconcile', () => {
    /** #5's plan is published; the owner has commented `/approve` since, and nothing has recorded it yet. */
    function ownerApprovedOnGitHub(): void {
      tracker.seedTask(publishedPlan());
      tracker.seedComment(5, { body: '/approve', author: 'shop-owner', createdAt: '2026-05-31T00:00:00.000Z' });
    }

    it('counts what a reconcile would do (the approval, and the board fields it moves), from a dry run that writes nothing', async () => {
      taskBranch('task/5-x');
      ownerApprovedOnGitHub();
      const writes = tracker.writes;

      const result = await run('claude', 'session-start', { stdin: sessionStart() });

      expect(contextLines(result.stdout)).toEqual([
        expect.stringMatching(/^sdlc: mode enforce\. Task #5 /),
        'Pending reconcile for #5: 2 action(s); run `sdlc reconcile`.',
      ]);
      expect(tracker.writes).toBe(writes);
    });

    it('leaves the line out when the dry run fails, with no error', async () => {
      taskBranch('task/5-x');
      ownerApprovedOnGitHub();
      tracker.failNext('listTaskPrs');

      const result = await run('claude', 'session-start', { stdin: sessionStart() });

      expect(result.stderr).toEqual([]);
      expect(contextLines(result.stdout)).toEqual([expect.stringMatching(/^sdlc: mode enforce\. Task #5 /)]);
    });

    it('leaves the line out when the dry run outlives the deadline', async () => {
      taskBranch('task/5-x');
      ownerApprovedOnGitHub();
      vi.spyOn(tracker, 'listTaskPrs').mockReturnValue(new Promise(() => undefined));
      const exit = vi.fn();

      const result = await run('claude', 'session-start', { stdin: sessionStart(), deadlineMs: 100, exit });

      expect(result.stderr).toEqual([]);
      expect(contextLines(result.stdout)).toEqual([expect.stringMatching(/^sdlc: mode enforce\. Task #5 /)]);
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  describe('the queue for sdlc sync', () => {
    beforeEach(() => {
      taskBranch('task/5-x');
      tracker.seedTask(feature(5, true));
    });

    // Lines `sdlc sync` can act on: a gap as the hooks log it, a command as the outbox queues it.
    const gapLine = JSON.stringify({ at: NOW, rule: 'no-task', text: 'edit src/a.ts', harness: 'claude', blocked: false });
    const entryLine = JSON.stringify({ id: 'a', at: NOW, argv: ['approve', '5'] });

    it('starts no sync, and says nothing of a queue, when nothing is queued', async () => {
      const spawnSync = vi.fn();
      repo.write('.sdlc/cache/gaps.jsonl', '');
      repo.write('.sdlc/cache/outbox.jsonl', '\n');

      const result = await run('claude', 'session-start', { stdin: sessionStart(), spawnSync });

      expect(spawnSync).not.toHaveBeenCalled();
      expect(contextLines(result.stdout)).toHaveLength(1);
    });

    it('counts only the lines sync would act on: malformed ones start no sync and are not named', async () => {
      const spawnSync = vi.fn();
      repo.write('.sdlc/cache/gaps.jsonl', `{"rule":"no-task"}\n{not json\n[]\n`);
      repo.write('.sdlc/cache/outbox.jsonl', `{"argv":["approve","5","approve"]}\n{not json\n`);

      const result = await run('claude', 'session-start', { stdin: sessionStart(), spawnSync });

      expect(spawnSync).not.toHaveBeenCalled();
      expect(contextLines(result.stdout)).toHaveLength(1);
    });

    it('does not count a malformed line next to good ones', async () => {
      const spawnSync = vi.fn();
      repo.write('.sdlc/cache/gaps.jsonl', `${gapLine}\n{not json\n${gapLine}\n`);
      repo.write('.sdlc/cache/outbox.jsonl', `{not json\n${entryLine}\n`);

      const result = await run('claude', 'session-start', { stdin: sessionStart(), spawnSync });

      expect(spawnSync).toHaveBeenCalledTimes(1);
      expect(contextLines(result.stdout).at(-1)).toBe(
        'Queued for sync: 1 write(s), 2 gap(s); `sdlc sync` is running in the background.',
      );
    });

    it.each([
      ['gaps.jsonl', `${gapLine}\n${gapLine}\n`, 'Queued for sync: 0 write(s), 2 gap(s); `sdlc sync` is running in the background.'],
      ['outbox.jsonl', `${entryLine}\n`, 'Queued for sync: 1 write(s), 0 gap(s); `sdlc sync` is running in the background.'],
    ])('starts sync for the repository when %s has lines, and says what is queued', async (file, content, line) => {
      const spawnSync = vi.fn();
      repo.write(`.sdlc/cache/${file}`, content);

      const result = await run('claude', 'session-start', { stdin: sessionStart(), spawnSync });

      expect(spawnSync).toHaveBeenCalledTimes(1);
      expect(spawnSync).toHaveBeenCalledWith(root);
      expect(contextLines(result.stdout).at(-1)).toBe(line);
    });

    it('starts sync with the main checkout, whose cache holds the queue, when the session is in a worktree', async () => {
      repo.git('worktree', 'add', '-q', '-b', 'task/7-y', '.worktrees/7-y');
      tracker.seedTask(feature(7, true));
      repo.write('.sdlc/cache/gaps.jsonl', `${gapLine}\n`);
      const spawnSync = vi.fn();

      const result = await run('claude', 'session-start', {
        stdin: sessionStart({}, join(repo.root, '.worktrees', '7-y')),
        spawnSync,
      });

      expect(spawnSync).toHaveBeenCalledWith(root);
      expect(contextLines(result.stdout)[0]).toContain('Task #7');
    });

    it('is not stopped by a sync that cannot be started: a warning on stderr, the context as usual', async () => {
      repo.write('.sdlc/cache/gaps.jsonl', `${gapLine}\n`);
      const spawnSync = vi.fn(() => {
        throw new Error('spawn denied');
      });

      const result = await run('claude', 'session-start', { stdin: sessionStart(), spawnSync });

      expect(result.stderr).toEqual(['sdlc: warning: could not start sdlc sync in the background (spawn denied)']);
      const lines = contextLines(result.stdout);
      expect(lines[0]).toMatch(/^sdlc: mode enforce\. Task #5 /);
      // The queue is still named, but the agent is not told that sync runs.
      expect(lines.at(-1)).toBe('Queued for sync: 0 write(s), 1 gap(s); run `sdlc sync`.');
    });

    it('works without a way to start sync, and says to run it', async () => {
      repo.write('.sdlc/cache/gaps.jsonl', `${gapLine}\n`);

      const result = await run('claude', 'session-start', { stdin: sessionStart() });

      expect(result.stderr).toEqual([]);
      expect(contextLines(result.stdout).at(-1)).toBe('Queued for sync: 0 write(s), 1 gap(s); run `sdlc sync`.');
    });
  });

  it('is skipped like any event when the repository has no config', async () => {
    const result = await run('claude', 'session-start', { stdin: sessionStart(), cfg: undefined });

    expect(result.stdout).toBe('');
    expect(result.stderr).toEqual([expect.stringMatching(/^sdlc: hook skipped: no sdlc\.config\.yaml in /)]);
  });
});

describe('runHook prompt: the prompt record', () => {
  it('appends the hash, never the text, to prompts.jsonl of the main checkout', async () => {
    taskBranch('task/5-x');

    const result = await run('claude', 'prompt', { stdin: claudePrompt('please continue') });

    expect(result.stdout).toBe('');
    expect(result.stderr).toEqual([]);
    const lines = jsonLines('prompts.jsonl');
    expect(lines).toEqual([
      {
        at: NOW,
        harness: 'claude',
        sessionId: 's1',
        promptId: 'p1',
        issue: 5,
        sha256: createHash('sha256').update('please continue').digest('hex'),
      },
    ]);
    expect(Object.keys(lines[0] as object)).toEqual(['at', 'harness', 'sessionId', 'promptId', 'issue', 'sha256']);
    expect(readFileSync(cacheFile('prompts.jsonl'), 'utf8')).not.toContain('please continue');
  });

  it('keeps one line per prompt, in order', async () => {
    await run('claude', 'prompt', { stdin: claudePrompt('one', { prompt_id: 'p1' }) });
    await run('claude', 'prompt', { stdin: claudePrompt('two', { prompt_id: 'p2' }) });

    expect(jsonLines('prompts.jsonl').map(line => line.promptId)).toEqual(['p1', 'p2']);
  });

  it('leaves out what the payload does not say: no issue off a task branch, no prompt id for Gemini, no session', async () => {
    await run('gemini', 'prompt', { stdin: JSON.stringify({ cwd: repo.root, prompt: 'hello' }) });

    const lines = jsonLines('prompts.jsonl');
    expect(Object.keys(lines[0] as object)).toEqual(['at', 'harness', 'sha256']);
    expect(lines[0]).toMatchObject({ harness: 'gemini' });
  });

  it('records the prompt of a Codex turn with the turn id', async () => {
    await run('codex', 'prompt', { stdin: JSON.stringify({ session_id: 'thr', turn_id: 'turn-1', cwd: repo.root, prompt: 'hi' }) });

    expect(jsonLines('prompts.jsonl')).toMatchObject([{ harness: 'codex', sessionId: 'thr', promptId: 'turn-1' }]);
  });

  it('writes the record to the main checkout when the session is in a worktree', async () => {
    repo.git('worktree', 'add', '-q', '-b', 'task/7-y', '.worktrees/7-y');
    const cwd = join(repo.root, '.worktrees', '7-y');

    await run('claude', 'prompt', { stdin: claudePrompt('hi', {}, cwd) });

    expect(jsonLines('prompts.jsonl')).toMatchObject([{ issue: 7 }]);
    expect(existsSync(join(cwd, '.sdlc'))).toBe(false);
  });

  it('records nothing for a prompt from a subagent', async () => {
    const claude = await run('claude', 'prompt', { stdin: claudePrompt('hi', { agent_id: 'a1' }) });
    const codex = await run('codex', 'prompt', {
      stdin: JSON.stringify({ session_id: 's', turn_id: 't', cwd: repo.root, prompt: 'hi', agent_id: 'a1' }),
    });

    expect(claude.stdout).toBe('');
    expect(codex.stdout).toBe('');
    expect(existsSync(cacheFile('prompts.jsonl'))).toBe(false);
  });

  it('records nothing for a payload with no prompt', async () => {
    const result = await run('claude', 'prompt', { stdin: JSON.stringify({ session_id: 's1', cwd: repo.root }) });

    expect(result.stdout).toBe('');
    expect(result.stderr).toEqual([]);
    expect(existsSync(cacheFile('prompts.jsonl'))).toBe(false);
  });

  it('a record that cannot be written does not stop the hook', async () => {
    taskBranch('task/5-x');
    tracker.seedTask(publishedPlan());
    repo.write('.sdlc/cache', 'a file where the directory should be');

    const result = await run('claude', 'prompt', { stdin: claudePrompt('/approve') });

    expect(result.stderr).toEqual([]);
    expect(contextLines(result.stdout)).toEqual(["sdlc: recorded the owner's approve for #5 (planning) from this prompt."]);
  });
});

describe('runHook prompt: owner approvals', () => {
  const stateOf = async (issue = 5): Promise<TaskState> => (await tracker.getTask(issue)).state;
  const APPROVE = '/approve\nlooks good';

  beforeEach(() => {
    taskBranch('task/5-x');
  });

  it("records the owner's /approve as a prompt approval and tells the agent", async () => {
    tracker.seedTask(publishedPlan());

    const result = await run('claude', 'prompt', { stdin: claudePrompt(APPROVE) });

    expect(result.stderr).toEqual([]);
    expect(contextLines(result.stdout)).toEqual(["sdlc: recorded the owner's approve for #5 (planning) from this prompt."]);
    expect((await stateOf()).stages.planning?.approval).toEqual({
      source: 'prompt',
      ref: promptRef('claude', 's1', 'p1', 'approve-planning', APPROVE),
      by: 'shop-owner',
      at: NOW,
    });
    expect((await stateOf()).status).toBe('in_progress');
    // The prompt is still recorded, by its hash.
    expect(jsonLines('prompts.jsonl')).toHaveLength(1);
  });

  it('records it in observe mode too', async () => {
    tracker.seedTask(publishedPlan());

    await run('claude', 'prompt', { stdin: claudePrompt(APPROVE), cfg: observe });

    expect((await stateOf()).stages.planning?.approval).toMatchObject({ source: 'prompt', by: 'shop-owner' });
  });

  it('records it once: the same prompt (same prompt id) again says it was already recorded and writes nothing', async () => {
    tracker.seedTask(publishedPlan());
    await run('claude', 'prompt', { stdin: claudePrompt(APPROVE) });
    const writes = tracker.writes;
    const before = await stateOf();

    const again = await run('claude', 'prompt', { stdin: claudePrompt(APPROVE) });

    expect(contextLines(again.stdout)).toEqual(['sdlc: this approval was already recorded for #5 (planning).']);
    expect(tracker.writes).toBe(writes);
    expect(await stateOf()).toEqual(before);
  });

  it('records two concurrent copies of the same prompt once', async () => {
    tracker.seedTask(publishedPlan());

    const [a, b] = await Promise.all([
      run('claude', 'prompt', { stdin: claudePrompt(APPROVE) }),
      run('claude', 'prompt', { stdin: claudePrompt(APPROVE) }),
    ]);

    const texts = [a, b].map(result => contextLines(result.stdout)[0]);
    expect(texts.filter(text => text?.startsWith("sdlc: recorded the owner's approve"))).toHaveLength(1);
    expect((await stateOf()).stages.planning?.approval?.source).toBe('prompt');
  });

  it('treats the same text in another session, or from another harness, as a new decision', async () => {
    tracker.seedTask(publishedPlan());
    await run('claude', 'prompt', { stdin: claudePrompt(APPROVE) });

    const other = await run('claude', 'prompt', { stdin: claudePrompt(APPROVE, { session_id: 's2' }) });

    expect(contextLines(other.stdout)).toEqual(["sdlc: recorded the owner's approve for #5 (planning) from this prompt."]);
    expect((await stateOf()).stages.planning?.approval?.ref).toBe(
      promptRef('claude', 's2', 'p1', 'approve-planning', APPROVE),
    );
  });

  describe('the same text for a later stage', () => {
    /** Publishes `phase` on #5 as an agent would after the stage before it was approved. */
    const publish = async (phase: Phase): Promise<void> => {
      const { state } = await tracker.getTask(5);
      await tracker.writeState(5, {
        ...state,
        phase,
        status: 'paused',
        waitingOn: 'owner',
        stages: { ...state.stages, [phase]: { revision: 1, publishedAt: '2026-05-30T02:00:00.000Z' } },
      });
    };

    it('is recorded for Claude when the prompt id is new, and refused when that prompt id comes again', async () => {
      tracker.seedTask(publishedStage('brainstorming'));
      await run('claude', 'prompt', { stdin: claudePrompt(APPROVE, { prompt_id: 'p1' }) });
      await publish('planning');

      const later = await run('claude', 'prompt', { stdin: claudePrompt(APPROVE, { prompt_id: 'p2' }) });

      expect(contextLines(later.stdout)).toEqual(["sdlc: recorded the owner's approve for #5 (planning) from this prompt."]);
      const { stages } = await stateOf();
      expect(stages.brainstorming?.approval?.ref).toBe(promptRef('claude', 's1', 'p1', 'approve-brainstorming', APPROVE));
      expect(stages.planning?.approval?.ref).toBe(promptRef('claude', 's1', 'p2', 'approve-planning', APPROVE));

      const writes = tracker.writes;
      const again = await run('claude', 'prompt', { stdin: claudePrompt(APPROVE, { prompt_id: 'p2' }) });

      expect(contextLines(again.stdout)).toEqual(['sdlc: this approval was already recorded for #5 (planning).']);
      expect(tracker.writes).toBe(writes);
    });

    it('is recorded for Codex by its turn id in the same way', async () => {
      tracker.seedTask(publishedStage('brainstorming'));
      const turn = (turn_id: string): string =>
        JSON.stringify({ session_id: 'thr', turn_id, cwd: repo.root, prompt: '/approve' });
      await run('codex', 'prompt', { stdin: turn('t1') });
      await publish('planning');

      const later = await run('codex', 'prompt', { stdin: turn('t2') });
      const again = await run('codex', 'prompt', { stdin: turn('t2') });

      expect(contextLines(later.stdout)).toEqual(["sdlc: recorded the owner's approve for #5 (planning) from this prompt."]);
      expect(contextLines(again.stdout)).toEqual(['sdlc: this approval was already recorded for #5 (planning).']);
    });

    it('is recorded for Gemini, which has no prompt id, once per stage', async () => {
      tracker.seedTask(publishedStage('brainstorming'));
      const stdin = JSON.stringify({ session_id: 'g1', cwd: repo.root, prompt: '/approve' });
      const first = await run('gemini', 'prompt', { stdin });
      await publish('planning');

      const later = await run('gemini', 'prompt', { stdin });
      const sameStage = await run('gemini', 'prompt', { stdin });

      expect(contextLines(first.stdout)).toEqual(["sdlc: recorded the owner's approve for #5 (brainstorming) from this prompt."]);
      expect(contextLines(later.stdout)).toEqual(["sdlc: recorded the owner's approve for #5 (planning) from this prompt."]);
      expect(contextLines(sameStage.stdout)).toEqual(['sdlc: this approval was already recorded for #5 (planning).']);
      const { stages } = await stateOf();
      expect(stages.brainstorming?.approval?.ref).toBe(promptRef('gemini', 'g1', undefined, 'approve-brainstorming', '/approve'));
      expect(stages.planning?.approval?.ref).toBe(promptRef('gemini', 'g1', undefined, 'approve-planning', '/approve'));
    });
  });

  describe('an owner decision that is no stage approval', () => {
    /** An analysis task whose result is published, waiting for the owner to accept it. */
    const analysisResult = (): TaskState => {
      const type = typeRegistry(enforce).get('analysis');
      if (!type) throw new Error('no analysis type');
      return {
        ...newTask({ issue: 5, type, summary: 'Look into it', now: '2026-05-30T00:00:00.000Z' }),
        phase: 'analysis',
        status: 'paused',
        waitingOn: 'owner',
        stages: { analysis: { revision: 1, publishedAt: '2026-05-30T01:00:00.000Z' } },
        resultPublishedAt: '2026-05-30T01:00:00.000Z',
      };
    };

    it('names no stage in the line, and is told "already recorded" without one', async () => {
      tracker.seedTask(analysisResult());

      const first = await run('claude', 'prompt', { stdin: claudePrompt('/accept') });
      const again = await run('claude', 'prompt', { stdin: claudePrompt('/accept') });

      expect(contextLines(first.stdout)).toEqual(["sdlc: recorded the owner's accept for #5 from this prompt."]);
      expect(contextLines(again.stdout)).toEqual(['sdlc: this approval was already recorded for #5.']);
      expect((await stateOf()).outcomeApproval?.ref).toBe(promptRef('claude', 's1', 'p1', 'accept', '/accept'));
    });
  });

  it('says there is no task for /approve on a branch without one, and records nothing', async () => {
    repo.git('checkout', '-q', 'main');
    const getTask = vi.spyOn(tracker, 'getTask');

    const result = await run('claude', 'prompt', { stdin: claudePrompt('/approve') });

    expect(contextLines(result.stdout)).toEqual(['sdlc: no task on this branch; the approval was not recorded.']);
    expect(getTask).not.toHaveBeenCalled();
    expect(tracker.writes).toBe(0);
  });

  it.each(['/merge', '/merge now', 'please /approve this', '> /approve', '/approved', '/approve type tooling', 'looks good'])(
    'does not read %j as an approval: no context, nothing written',
    async prompt => {
      tracker.seedTask(publishedPlan());
      const getTask = vi.spyOn(tracker, 'getTask');

      const result = await run('claude', 'prompt', { stdin: claudePrompt(prompt) });

      expect(result.stdout).toBe('');
      expect(getTask).not.toHaveBeenCalled();
      expect(tracker.writes).toBe(0);
    },
  );

  it('refuses /cancel without a reason and says why, writing nothing', async () => {
    tracker.seedTask(publishedPlan());

    const result = await run('claude', 'prompt', { stdin: claudePrompt('/cancel') });

    expect(contextLines(result.stdout)).toEqual([
      'sdlc: approval not recorded: /cancel needs a reason on the same line, as in "/cancel no longer needed".',
    ]);
    expect(tracker.writes).toBe(0);
    expect((await stateOf()).status).toBe('paused');
  });

  it('cancels the task for /cancel with a reason, as a prompt approval, and posts the cancel report', async () => {
    tracker.seedTask(publishedPlan());

    const result = await run('claude', 'prompt', { stdin: claudePrompt('/cancel no longer needed') });

    expect(contextLines(result.stdout)).toEqual(["sdlc: recorded the owner's cancel for #5 from this prompt."]);
    const state = await stateOf();
    expect(state).toMatchObject({ status: 'done', outcome: 'cancelled', cancelReason: 'no longer needed' });
    expect(state.outcomeApproval).toMatchObject({ source: 'prompt', by: 'shop-owner' });
    expect(tracker.comments.some(comment => comment.body.includes('**Reason:** no longer needed'))).toBe(true);
  });

  it('says why when the approval does not fit the task, and writes nothing', async () => {
    tracker.seedTask(feature(5, false));

    const result = await run('claude', 'prompt', { stdin: claudePrompt('/approve') });

    expect(contextLines(result.stdout)).toEqual([
      'sdlc: approval not recorded: stage "planning" has not been published, nothing to approve',
    ]);
    expect(tracker.writes).toBe(0);
  });

  it('keeps an error message that spans lines on one line', async () => {
    tracker.seedTask(publishedPlan());
    vi.spyOn(tracker, 'getTask').mockRejectedValue(new Error('first line\nsdlc: second line'));

    const result = await run('claude', 'prompt', { stdin: claudePrompt('/approve') });

    expect(contextLines(result.stdout)).toEqual([
      'sdlc: approval not recorded: getTask failed for #5: first line sdlc: second line',
    ]);
  });

  describe('who approves', () => {
    const two: Config = { ...enforce, owners: ['owner-a', 'owner-b'], agents: ['agent-bot'] };

    it('refuses, with several owners, a login that is not one of them, and writes nothing', async () => {
      tracker.login = 'agent-bot';
      tracker.seedTask(publishedPlan());

      const result = await run('claude', 'prompt', { stdin: claudePrompt('/approve'), cfg: two });

      expect(contextLines(result.stdout)).toEqual([
        'sdlc: prompt approval not recorded: agent-bot is not an owner and several owners are configured; approve by comment',
      ]);
      expect(tracker.writes).toBe(0);
    });

    it('records, with several owners, for the owner whose login the tool runs as', async () => {
      tracker.login = 'owner-b';
      tracker.seedTask(publishedPlan());

      await run('claude', 'prompt', { stdin: claudePrompt('/approve'), cfg: two });

      expect((await stateOf()).stages.planning?.approval).toMatchObject({ source: 'prompt', by: 'owner-b' });
    });

    it('records for the one owner whatever login the tool runs as, without asking GitHub who that is', async () => {
      tracker.login = 'agent-bot';
      tracker.seedTask(publishedPlan());
      const login = vi.spyOn(tracker, 'authenticatedLogin');

      await run('claude', 'prompt', { stdin: claudePrompt('/approve') });

      expect((await stateOf()).stages.planning?.approval).toMatchObject({ by: 'shop-owner' });
      expect(login).not.toHaveBeenCalled();
    });
  });

  describe('only a human prompt approves', () => {
    it('ignores /approve in a prompt from a subagent (Claude and Codex): nothing recorded, no context', async () => {
      tracker.seedTask(publishedPlan());
      const getTask = vi.spyOn(tracker, 'getTask');

      const claude = await run('claude', 'prompt', { stdin: claudePrompt('/approve', { agent_id: 'a1' }) });
      const codex = await run('codex', 'prompt', {
        stdin: JSON.stringify({ session_id: 's', turn_id: 't', cwd: repo.root, prompt: '/approve', agent_id: 'a1' }),
      });

      expect(claude.stdout).toBe('');
      expect(codex.stdout).toBe('');
      expect(getTask).not.toHaveBeenCalled();
      expect(tracker.writes).toBe(0);
    });

    it.each([
      ['a Bash command', 'Bash', { command: '/approve' }],
      ['a Write of /approve', 'Write', { file_path: 'notes.txt', content: '/approve' }],
    ])('ignores /approve in the payload of a tool call (%s)', async (_name, tool, input) => {
      tracker.seedTask(publishedPlan());

      const result = await run('claude', 'pre-tool', {
        stdin: JSON.stringify({ session_id: 's1', cwd: repo.root, tool_name: tool, tool_input: input, prompt: '/approve' }),
      });

      expect(tracker.writes).toBe(0);
      expect((await stateOf()).stages.planning?.approval).toBeUndefined();
      expect(result.stderr).toEqual([]);
    });

    it('ignores /approve in a session-start payload', async () => {
      tracker.seedTask(publishedPlan());

      await run('claude', 'session-start', { stdin: sessionStart({ prompt: '/approve' }) });

      expect(tracker.writes).toBe(0);
    });

    it('applies a Gemini BeforeAgent prompt, answering in its event name', async () => {
      tracker.seedTask(publishedPlan());

      const result = await run('gemini', 'prompt', { stdin: JSON.stringify({ session_id: 'g1', cwd: repo.root, prompt: '/approve' }) });

      expect(JSON.parse(result.stdout)).toHaveProperty('hookSpecificOutput.hookEventName', 'BeforeAgent');
      expect((await stateOf()).stages.planning?.approval).toMatchObject({
        source: 'prompt',
        ref: promptRef('gemini', 'g1', undefined, 'approve-planning', '/approve'),
      });
    });
  });

  describe('when GitHub cannot be reached', () => {
    const OFFLINE = 'sdlc: could not reach GitHub; approval not recorded, ask again or approve by comment';

    it('says so when the tracker outlives the deadline, and still records the prompt', async () => {
      tracker.seedTask(publishedPlan());
      vi.spyOn(tracker, 'getTask').mockReturnValue(new Promise(() => undefined));
      const exit = vi.fn();

      const result = await run('claude', 'prompt', { stdin: claudePrompt('/approve'), deadlineMs: 50, exit });

      expect(result.stderr).toEqual([]);
      expect(contextLines(result.stdout)).toEqual([OFFLINE]);
      expect(exit).toHaveBeenCalledWith(0);
      expect(jsonLines('prompts.jsonl')).toHaveLength(1);
    });

    it('says so when the deadline passes between the read and the write', async () => {
      tracker.seedTask(publishedPlan());
      vi.spyOn(tracker, 'writeState').mockReturnValue(new Promise(() => undefined));
      const exit = vi.fn();

      const result = await run('claude', 'prompt', { stdin: claudePrompt('/approve'), deadlineMs: 100, exit });

      expect(contextLines(result.stdout)).toEqual([OFFLINE]);
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('names the failure of any other tracker error', async () => {
      tracker.seedTask(publishedPlan());
      vi.spyOn(tracker, 'getTask').mockRejectedValue(new GhError(['issue', 'view', '5'], 'HTTP 502', 'gh failed'));

      const result = await run('claude', 'prompt', { stdin: claudePrompt('/approve') });

      expect(result.stderr).toEqual([]);
      expect(contextLines(result.stdout)).toEqual(['sdlc: approval not recorded: getTask failed for #5: gh failed']);
    });

    it('names a state that changed under the write, and records nothing', async () => {
      tracker.seedTask(publishedPlan());
      tracker.concurrentWriteBeforeNextWriteState(5);

      const result = await run('claude', 'prompt', { stdin: claudePrompt('/approve') });

      expect(contextLines(result.stdout)[0]).toMatch(/^sdlc: approval not recorded: writeState failed for #5: /);
      expect((await stateOf()).stages.planning?.approval).toBeUndefined();
    });
  });
});

describe('registerHookCommand', () => {
  const program = (ctx: HookContext): Command => {
    const command = new Command().exitOverride();
    registerHookCommand(command, () => ctx);
    return command;
  };
  const contextFor = (stdin: string, out: string[], err: string[]): HookContext => ({
    cwd: repo.root,
    readStdin: async () => stdin,
    loadConfig: () => enforce,
    makeTracker: () => tracker,
    gitFor: dir => createGitRunner(dir),
    now: () => NOW,
    out: text => out.push(text),
    err: text => err.push(text),
  });

  it('runs the event and exits 0', async () => {
    const out: string[] = [];
    const err: string[] = [];
    process.exitCode = undefined;

    await program(contextFor(payload(repo.root, 'Bash', { command: 'gh pr merge 1 --admin' }), out, err)).parseAsync(
      ['hook', 'claude', 'pre-tool'],
      { from: 'user' },
    );

    expect(process.exitCode).toBe(0);
    expect(JSON.parse(out.join(''))).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    expect(err).toEqual([]);
    process.exitCode = undefined;
  });

  it('skips, exit 0, when the context cannot be built', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    process.exitCode = undefined;
    const command = new Command().exitOverride();
    registerHookCommand(command, () => {
      throw new Error('no environment');
    });

    await command.parseAsync(['hook', 'gemini', 'pre-tool'], { from: 'user' });

    expect(process.exitCode).toBe(0);
    expect(stderr).toHaveBeenCalledWith('sdlc: hook skipped: no environment\n');
    expect(stdout).toHaveBeenCalledWith('{}\n');
    process.exitCode = undefined;
  });

  it.each([
    [['hook', 'bogus', 'pre-tool'], 'unknown harness "bogus"', ''],
    [['hook', 'claude', 'bogus'], 'unknown event "bogus"', ''],
    [['hook', 'gemini', 'bogus'], 'unknown event "bogus"', '{}'],
    [['hook'], 'unknown harness ""', ''],
  ])('%j: prints the skip line, exits 0', async (argv, reason, stdout) => {
    const out: string[] = [];
    const err: string[] = [];
    process.exitCode = undefined;

    await program(contextFor('{}', out, err)).parseAsync(argv, { from: 'user' });

    expect(process.exitCode).toBe(0);
    expect(out.join('')).toBe(stdout);
    expect(err).toEqual([`sdlc: hook skipped: ${reason}`]);
    process.exitCode = undefined;
  });
});

describe('runHook with readOnly: the answer without any trace', () => {
  const cacheDir = (): string => join(repo.root, '.sdlc', 'cache');

  it('answers a violation like any hook, and writes no gap', async () => {
    taskBranch('task/5-x');
    const stdin = payload(repo.root, 'Bash', { command: 'gh pr merge 1 --admin' });

    const readOnly = await claudePreTool(stdin, { readOnly: true });

    expect(denyReason(readOnly.stdout)).toContain('sdlc (enforce):');
    expect(gapLines()).toEqual([]);

    // The same run without the flag logs the gap and gives the same answer.
    const normal = await claudePreTool(stdin);
    expect(normal.stdout).toBe(readOnly.stdout);
    expect(gapLines()).toHaveLength(1);

    // And a read-only run after it adds no second line.
    await claudePreTool(stdin, { readOnly: true });
    expect(gapLines()).toHaveLength(1);
  });

  it('creates no cache directory at all, for a violation, a recorded prompt or a cached task', async () => {
    taskBranch('task/5-x');
    tracker.seedTask(feature(5, true));

    await claudePreTool(payload(repo.root, 'Bash', { command: 'gh pr merge 1 --admin' }), { readOnly: true });
    await run('claude', 'prompt', { stdin: claudePrompt('please continue'), readOnly: true });
    const edit = await claudePreTool(claudeWrite(join(repo.root, 'src', 'a.ts')), { readOnly: true });

    // The task was read from the tracker, and allowed: normally that would be cached.
    expect(edit.stdout).toBe('');
    expect(existsSync(cacheDir())).toBe(false);
  });

  it('records no approval from a /approve prompt: nothing is written to the task, and it says so', async () => {
    taskBranch('task/5-x');
    tracker.seedTask(publishedPlan());
    const writes = tracker.writes;
    const before = (await tracker.getTask(5)).state;

    const result = await run('claude', 'prompt', { stdin: claudePrompt('/approve\nlooks good'), readOnly: true });

    expect(contextLines(result.stdout)).toEqual(['sdlc: read-only run; the approval was not recorded.']);
    expect(tracker.writes).toBe(writes);
    expect((await tracker.getTask(5)).state).toEqual(before);
    expect(existsSync(cacheDir())).toBe(false);

    // The same prompt in a normal run still records it.
    await run('claude', 'prompt', { stdin: claudePrompt('/approve\nlooks good') });
    expect((await tracker.getTask(5)).state.stages.planning?.approval).toMatchObject({ source: 'prompt', by: 'shop-owner' });
  });

  it('does not start sdlc sync, even when something is queued', async () => {
    taskBranch('task/5-x');
    tracker.seedTask(feature(5, true));
    repo.write('.sdlc/cache/outbox.jsonl', `${JSON.stringify({ id: 'a', at: NOW, argv: ['approve', '5'] })}\n`);
    const spawnSync = vi.fn();

    const result = await run('claude', 'session-start', { stdin: sessionStart(), spawnSync, readOnly: true });

    expect(spawnSync).not.toHaveBeenCalled();
    expect(contextLines(result.stdout).at(-1)).toBe('Queued for sync: 1 write(s), 0 gap(s); run `sdlc sync`.');
  });
});
