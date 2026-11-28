import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerHookCommand, runHook, type HookContext } from '../../src/commands/hook.js';
import { loadConfig, typeRegistry, type Config } from '../../src/config/schema.js';
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
  now?: () => string;
  deadlineMs?: number;
  exit?: (code: number) => void;
}

async function run(harness: HookHarness, event: HookEventName, options: Options): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const cfg = 'cfg' in options ? options.cfg : enforce;
  const ctx: HookContext = {
    cwd: repo.root,
    readStdin: options.readStdin ?? (async () => options.stdin),
    loadConfig: () => {
      if (cfg === 'throw') throw new Error('Invalid config:\n  - mode: bad');
      return cfg;
    },
    makeTracker: () => tracker,
    gitFor: options.gitFor ?? (dir => createGitRunner(dir)),
    now: options.now ?? (() => NOW),
    out: text => out.push(text),
    err: text => err.push(text),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.exit === undefined ? {} : { exit: options.exit }),
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

    expect(seen).toEqual([join(root, '.worktrees', '7-y')]);
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

describe('runHook: events that only render context for now', () => {
  it.each([
    ['claude', 'session-start', ''],
    ['codex', 'prompt', ''],
    ['gemini', 'session-start', '{}'],
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
