import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decidePreCommit,
  decidePrePush,
  describeCheckout,
  HOOK_NAMES,
  lookupTrackedTask,
  registerGitHookCommand,
  RECONCILE_LOG,
  runGitHook,
  spawnDetachedLogged,
  type GitHookContext,
  type TaskLookup,
} from '../../src/commands/githook.js';
import { ConfigError } from '../../src/core/taskTypes.js';
import { loadConfig, typeRegistry, type Config } from '../../src/config/schema.js';
import { newTask } from '../../src/core/stateMachine.js';
import { STATE_MARKER } from '../../src/core/stateComment.js';
import type { TaskState } from '../../src/core/types.js';
import { GhError } from '../../src/github/gh.js';
import type { GitRunner } from '../../src/install/provision.js';
import type { Tracker } from '../../src/tracker/types.js';
import { FakeTracker } from '../support/fakeTracker.js';

const base = loadConfig(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/config/valid.yaml'));
const observe: Config = { ...base, mode: 'observe' };
const enforce: Config = { ...base, mode: 'enforce' };
const MODES: Array<[string, Config]> = [
  ['observe', observe],
  ['enforce', enforce],
];
const ZEROS = '0'.repeat(40);
const SHA = 'a'.repeat(40);
const NOW = '2026-06-01T00:00:00.000Z';

/** A `git push` stdin line: local ref, local sha, remote ref, remote sha. */
const pushLine = (remoteRef: string, localSha = SHA, localRef = 'refs/heads/work'): string =>
  `${localRef} ${localSha} ${remoteRef} ${ZEROS}`;

describe('decidePreCommit', () => {
  it('observe: warns about a commit on the default branch and lets it through', () => {
    expect(decidePreCommit('main', observe)).toEqual({
      exitCode: 0,
      messages: [
        { level: 'warn', text: 'committing directly to main; work on a task branch (task/<issue>-<slug>)' },
      ],
    });
  });

  it('enforce: the same text is an error and blocks', () => {
    expect(decidePreCommit('main', enforce)).toEqual({
      exitCode: 1,
      messages: [
        { level: 'error', text: 'committing directly to main; work on a task branch (task/<issue>-<slug>)' },
      ],
    });
  });

  it.each(MODES)('%s: task branches, other branches and a detached HEAD are silent', (_mode, cfg) => {
    for (const branch of ['task/12-fix-login', 'feature/x', 'main-2', undefined]) {
      expect(decidePreCommit(branch, cfg)).toEqual({ exitCode: 0, messages: [] });
    }
  });

  it('uses github.defaultBranch, not the name "main"', () => {
    const trunk: Config = { ...enforce, github: { ...enforce.github, defaultBranch: 'trunk' } };

    expect(decidePreCommit('main', trunk).exitCode).toBe(0);
    expect(decidePreCommit('trunk', trunk).exitCode).toBe(1);
  });
});

describe('decidePrePush', () => {
  const tracked: TaskLookup = async () => true;
  const untracked: TaskLookup = async () => false;
  const offline: TaskLookup = async () => {
    throw new Error('network is unreachable');
  };
  const never: TaskLookup = async () => {
    throw new Error('lookup must not run');
  };

  it('observe: warns about a push to the default branch', async () => {
    expect(await decidePrePush([pushLine('refs/heads/main')], observe, never)).toEqual({
      exitCode: 0,
      messages: [{ level: 'warn', text: 'pushing directly to main; work on a task branch (task/<issue>-<slug>)' }],
    });
  });

  it('enforce: blocks a push to the default branch', async () => {
    expect(await decidePrePush([pushLine('refs/heads/main')], enforce, never)).toEqual({
      exitCode: 1,
      messages: [{ level: 'error', text: 'pushing directly to main; work on a task branch (task/<issue>-<slug>)' }],
    });
  });

  it('judges the remote ref, not the local branch name', async () => {
    const result = await decidePrePush([pushLine('refs/heads/main', SHA, 'refs/heads/task/5-x')], enforce, never);

    expect(result.exitCode).toBe(1);
  });

  it.each(MODES)('%s: a task branch with a tracked task is fine', async (_mode, cfg) => {
    const asked: number[] = [];

    const result = await decidePrePush([pushLine('refs/heads/task/12-fix-login')], cfg, async n => {
      asked.push(n);
      return true;
    });

    expect(result).toEqual({ exitCode: 0, messages: [] });
    expect(asked).toEqual([12]);
  });

  it('observe: warns when the task branch has no tracked task', async () => {
    expect(await decidePrePush([pushLine('refs/heads/task/12-fix-login')], observe, untracked)).toEqual({
      exitCode: 0,
      messages: [
        {
          level: 'warn',
          text: 'branch task/12-fix-login has no tracked task #12; run sdlc task new or sdlc task new --issue 12',
        },
      ],
    });
  });

  it('enforce: blocks when the task branch has no tracked task', async () => {
    expect(await decidePrePush([pushLine('refs/heads/task/12-fix-login')], enforce, untracked)).toEqual({
      exitCode: 1,
      messages: [
        {
          level: 'error',
          text: 'branch task/12-fix-login has no tracked task #12; run sdlc task new or sdlc task new --issue 12',
        },
      ],
    });
  });

  it.each(MODES)('%s: a failed lookup (offline) warns and allows the push', async (_mode, cfg) => {
    expect(await decidePrePush([pushLine('refs/heads/task/12-fix-login')], cfg, offline)).toEqual({
      exitCode: 0,
      messages: [
        { level: 'warn', text: 'could not verify task #12 (network is unreachable); push allowed' },
      ],
    });
  });

  it.each(MODES)('%s: deleting a branch is ignored, whatever the branch', async (_mode, cfg) => {
    const lines = [
      pushLine('refs/heads/task/12-fix-login', ZEROS, '(delete)'),
      pushLine('refs/heads/main', ZEROS, '(delete)'),
    ];

    expect(await decidePrePush(lines, cfg, never)).toEqual({ exitCode: 0, messages: [] });
  });

  it.each(MODES)('%s: other branches, tags and unreadable lines are ignored', async (_mode, cfg) => {
    const lines = [
      pushLine('refs/heads/feature/x'),
      pushLine('refs/heads/task/no-number'),
      pushLine('refs/heads/task/12'),
      pushLine('refs/tags/v1'),
      pushLine('refs/heads/task/0-zero'),
      'garbage',
      '',
    ];

    expect(await decidePrePush(lines, cfg, never)).toEqual({ exitCode: 0, messages: [] });
  });

  it('reports every ref, blocks when any blocks, and asks once per task', async () => {
    const asked: number[] = [];
    const lines = [
      pushLine('refs/heads/main'),
      pushLine('refs/heads/task/7-a'),
      pushLine('refs/heads/task/7-b'),
      pushLine('refs/heads/task/8-c'),
    ];

    const result = await decidePrePush(lines, enforce, async n => {
      asked.push(n);
      return n === 8;
    });

    expect(result.exitCode).toBe(1);
    expect(result.messages.map(m => m.text)).toEqual([
      'pushing directly to main; work on a task branch (task/<issue>-<slug>)',
      'branch task/7-a has no tracked task #7; run sdlc task new or sdlc task new --issue 7',
      'branch task/7-b has no tracked task #7; run sdlc task new or sdlc task new --issue 7',
    ]);
    expect(asked).toEqual([7, 8]);
  });

  it('a failed lookup does not hide a block from another ref', async () => {
    const lines = [pushLine('refs/heads/main'), pushLine('refs/heads/task/3-x')];

    const result = await decidePrePush(lines, enforce, offline);

    expect(result.exitCode).toBe(1);
    expect(result.messages.map(m => m.level)).toEqual(['error', 'warn']);
  });
});

describe('lookupTrackedTask', () => {
  const types = typeRegistry(base);
  const state = (issue: number): TaskState => newTask({ issue, type: types.get('feature')!, summary: 's', now: NOW });

  it('is true for a tracked task and false for an issue without a state comment', async () => {
    const tracker = new FakeTracker();
    tracker.owners = [...base.owners];
    tracker.seedTask(state(4));
    tracker.issues.push({ number: 5, title: 'plain issue', body: '', labels: [], open: true, onBoard: false });
    const lookup = lookupTrackedTask(tracker);

    expect(await lookup(4)).toBe(true);
    expect(await lookup(5)).toBe(false);
  });

  it('is false for a state comment that cannot be read', async () => {
    const tracker = new FakeTracker();
    tracker.issues.push({ number: 6, title: 'broken', body: '', labels: ['sdlc:task'], open: true, onBoard: false });
    tracker.seedComment(6, { body: `${STATE_MARKER}\nnot json`, author: tracker.login });

    expect(await lookupTrackedTask(tracker)(6)).toBe(false);
  });

  it('is false when GitHub has no such issue', async () => {
    const tracker = {
      getTask: async () => {
        throw new GhError(['issue', 'view', '99'], 'GraphQL: Could not resolve to an Issue with the number of 99.');
      },
    } as unknown as Tracker;

    expect(await lookupTrackedTask(tracker)(99)).toBe(false);
  });

  it('rejects with the failure of any other error, so the push is not judged on it', async () => {
    const tracker = {
      getTask: async () => {
        throw new GhError(['issue', 'view', '4'], 'error connecting to api.github.com');
      },
    } as unknown as Tracker;

    await expect(lookupTrackedTask(tracker)(4)).rejects.toThrow('error connecting to api.github.com');
  });
});

describe('describeCheckout', () => {
  const types = typeRegistry(base);

  it('is one line: status, phase and the next step', () => {
    const state: TaskState = {
      ...newTask({ issue: 12, type: types.get('feature')!, summary: 's', now: NOW }),
      phase: 'planning',
      nextStep: 'Write the plan',
    };

    expect(describeCheckout(state)).toBe('task #12: In progress · Planning · next: Write the plan');
  });

  it('shows a dash for an empty next step and keeps multi-line text on one line', () => {
    const empty = newTask({ issue: 3, type: types.get('feature')!, summary: 's', now: NOW });

    expect(describeCheckout(empty)).toBe('task #3: In progress · Intake · next: —');
    expect(describeCheckout({ ...empty, nextStep: 'one\n  two\u001b[31m' })).toBe(
      'task #3: In progress · Intake · next: one two [31m',
    );
  });
});

// -- runGitHook ----------------------------------------------------------------------------------

interface Harness {
  ctx: GitHookContext;
  out: string[];
  err: string[];
  tracker: FakeTracker;
  spawned: string[];
  gitCalls: string[][];
  configLoads: number;
  trackerBuilds: number;
}

interface Options {
  branch?: string | undefined;
  cfg?: Config;
  configError?: Error;
  stdin?: string;
  spawnFails?: Error;
  repoRoot?: string;
}

function setup(options: Options = {}): Harness {
  const tracker = new FakeTracker();
  tracker.owners = [...base.owners];
  const harness: Harness = {
    out: [],
    err: [],
    tracker,
    spawned: [],
    gitCalls: [],
    configLoads: 0,
    trackerBuilds: 0,
    ctx: undefined as unknown as GitHookContext,
  };
  const git: GitRunner = async args => {
    harness.gitCalls.push(args);
    if (args.join(' ') !== 'symbolic-ref --short -q HEAD') return { stdout: '', stderr: 'unexpected', code: 128 };
    const branch = 'branch' in options ? options.branch : 'main';
    return branch === undefined ? { stdout: '', stderr: '', code: 1 } : { stdout: `${branch}\n`, stderr: '', code: 0 };
  };
  harness.ctx = {
    repoRoot: options.repoRoot ?? '/repo',
    git,
    loadConfig: () => {
      harness.configLoads += 1;
      if (options.configError) throw options.configError;
      return options.cfg ?? observe;
    },
    makeTracker: () => {
      harness.trackerBuilds += 1;
      return tracker;
    },
    readStdin: async () => options.stdin ?? '',
    spawnReconcile: logPath => {
      if (options.spawnFails) throw options.spawnFails;
      harness.spawned.push(logPath);
    },
    out: text => harness.out.push(text),
    err: text => harness.err.push(text),
  };
  return harness;
}

const taskState = (issue: number, overrides: Partial<TaskState> = {}): TaskState => ({
  ...newTask({ issue, type: typeRegistry(base).get('feature')!, summary: `Task ${issue}`, now: NOW }),
  ...overrides,
});

describe('runGitHook pre-commit', () => {
  it('observe on the default branch: warns on stderr, exits 0', async () => {
    const h = setup({ branch: 'main', cfg: observe });

    expect(await runGitHook('pre-commit', [], h.ctx)).toBe(0);
    expect(h.err).toEqual(['sdlc: warning: committing directly to main; work on a task branch (task/<issue>-<slug>)']);
    expect(h.out).toEqual([]);
  });

  it('enforce on the default branch: prints the error, exits 1', async () => {
    const h = setup({ branch: 'main', cfg: enforce });

    expect(await runGitHook('pre-commit', [], h.ctx)).toBe(1);
    expect(h.err).toEqual(['sdlc: error: committing directly to main; work on a task branch (task/<issue>-<slug>)']);
  });

  it('on a task branch: silent, exit 0', async () => {
    const h = setup({ branch: 'task/12-fix-login', cfg: enforce });

    expect(await runGitHook('pre-commit', [], h.ctx)).toBe(0);
    expect(h.err).toEqual([]);
    expect(h.out).toEqual([]);
  });

  it('on a detached HEAD: exit 0 without reading the config', async () => {
    const h = setup({ branch: undefined, cfg: enforce });

    expect(await runGitHook('pre-commit', [], h.ctx)).toBe(0);
    expect(h.err).toEqual([]);
    expect(h.configLoads).toBe(0);
  });

  it('never builds the tracker', async () => {
    const h = setup({ branch: 'main', cfg: enforce });

    await runGitHook('pre-commit', [], h.ctx);

    expect(h.trackerBuilds).toBe(0);
  });

  it('a config that cannot be loaded warns and exits 0, in observe and enforce alike', async () => {
    const h = setup({ branch: 'main', configError: new ConfigError('Cannot read config file /repo/sdlc.config.yaml: ENOENT') });

    expect(await runGitHook('pre-commit', [], h.ctx)).toBe(0);
    expect(h.err).toEqual([
      'sdlc: warning: could not load the config (Cannot read config file /repo/sdlc.config.yaml: ENOENT); git hook pre-commit skipped',
    ]);
  });

  it('reports only the first line of a multi-line config error', async () => {
    const h = setup({ branch: 'main', configError: new Error('Invalid config:\n  - mode: bad\n  - version: 3') });

    await runGitHook('pre-commit', [], h.ctx);

    expect(h.err).toEqual(['sdlc: warning: could not load the config (Invalid config:); git hook pre-commit skipped']);
  });
});

describe('runGitHook pre-push', () => {
  it('reads the updates from stdin; a push to the default branch is blocked in enforce', async () => {
    const h = setup({ cfg: enforce, stdin: `${pushLine('refs/heads/main')}\n` });

    expect(await runGitHook('pre-push', ['origin', 'git@example.test:a/b.git'], h.ctx)).toBe(1);
    expect(h.err).toEqual(['sdlc: error: pushing directly to main; work on a task branch (task/<issue>-<slug>)']);
  });

  it('looks the task up on the tracker: tracked is silent', async () => {
    const h = setup({ cfg: enforce, stdin: `${pushLine('refs/heads/task/12-fix-login')}\n` });
    h.tracker.seedTask(taskState(12));

    expect(await runGitHook('pre-push', [], h.ctx)).toBe(0);
    expect(h.err).toEqual([]);
    expect(h.trackerBuilds).toBe(1);
  });

  it('an issue with no task state blocks in enforce and warns in observe', async () => {
    const stdin = `${pushLine('refs/heads/task/12-fix-login')}\n`;
    const blocked = setup({ cfg: enforce, stdin });
    const warned = setup({ cfg: observe, stdin });
    for (const h of [blocked, warned]) {
      h.tracker.issues.push({ number: 12, title: 'plain', body: '', labels: [], open: true, onBoard: false });
    }

    expect(await runGitHook('pre-push', [], blocked.ctx)).toBe(1);
    expect(await runGitHook('pre-push', [], warned.ctx)).toBe(0);
    expect(blocked.err[0]).toBe(
      'sdlc: error: branch task/12-fix-login has no tracked task #12; run sdlc task new or sdlc task new --issue 12',
    );
    expect(warned.err[0]).toMatch(/^sdlc: warning: branch task\/12-fix-login has no tracked task #12/);
  });

  it('a tracker failure (offline) warns and allows the push in enforce', async () => {
    const h = setup({ cfg: enforce, stdin: `${pushLine('refs/heads/task/12-fix-login')}\n` });
    h.tracker.failNext('getTask');

    expect(await runGitHook('pre-push', [], h.ctx)).toBe(0);
    expect(h.err).toEqual([
      'sdlc: warning: could not verify task #12 (FakeTracker.getTask failed (injected by failNext)); push allowed',
    ]);
  });

  it('with only deletions or no lines, exits 0 without reading the config or the tracker', async () => {
    const h = setup({ cfg: enforce, stdin: `${pushLine('refs/heads/main', ZEROS, '(delete)')}\n` });

    expect(await runGitHook('pre-push', [], h.ctx)).toBe(0);
    expect(await runGitHook('pre-push', [], setup({ cfg: enforce, stdin: '' }).ctx)).toBe(0);
    expect(h.configLoads).toBe(0);
    expect(h.trackerBuilds).toBe(0);
  });

  it('a config that cannot be loaded warns and exits 0', async () => {
    const h = setup({ configError: new Error('boom'), stdin: `${pushLine('refs/heads/main')}\n` });

    expect(await runGitHook('pre-push', [], h.ctx)).toBe(0);
    expect(h.err).toEqual(['sdlc: warning: could not load the config (boom); git hook pre-push skipped']);
  });
});

describe('runGitHook post-merge', () => {
  it('on the default branch: starts reconcile with the log path, says so, exits 0', async () => {
    const h = setup({ branch: 'main', repoRoot: '/work/shop' });

    expect(await runGitHook('post-merge', ['0'], h.ctx)).toBe(0);
    expect(h.spawned).toEqual([join('/work/shop', '.sdlc', 'cache', 'reconcile.log')]);
    expect(h.out).toEqual(['sdlc: reconcile started in the background (log: .sdlc/cache/reconcile.log)']);
    expect(RECONCILE_LOG).toBe('.sdlc/cache/reconcile.log');
  });

  it.each(['task/12-fix-login', undefined])('on %s: does nothing', async branch => {
    const h = setup({ branch });

    expect(await runGitHook('post-merge', ['0'], h.ctx)).toBe(0);
    expect(h.spawned).toEqual([]);
    expect(h.out).toEqual([]);
  });

  it('a spawn failure warns, does not claim a start, and still exits 0', async () => {
    const h = setup({ branch: 'main', spawnFails: new Error('EACCES: log') });

    expect(await runGitHook('post-merge', [], h.ctx)).toBe(0);
    expect(h.out).toEqual([]);
    expect(h.err).toEqual(['sdlc: warning: could not start reconcile in the background (EACCES: log)']);
  });

  it('a config that cannot be loaded warns and exits 0', async () => {
    const h = setup({ branch: 'main', configError: new Error('boom') });

    expect(await runGitHook('post-merge', [], h.ctx)).toBe(0);
    expect(h.spawned).toEqual([]);
    expect(h.err).toEqual(['sdlc: warning: could not load the config (boom); git hook post-merge skipped']);
  });
});

describe('runGitHook post-checkout', () => {
  const PREV = 'b'.repeat(40);

  it('prints one status line when a task branch is checked out', async () => {
    const h = setup({ branch: 'task/12-fix-login', cfg: enforce });
    h.tracker.seedTask(taskState(12, { phase: 'planning', nextStep: 'Write the plan' }));

    expect(await runGitHook('post-checkout', [PREV, SHA, '1'], h.ctx)).toBe(0);
    expect(h.out).toEqual(['task #12: In progress · Planning · next: Write the plan']);
    expect(h.err).toEqual([]);
  });

  it('a file checkout (flag 0) does nothing, not even a git call', async () => {
    const h = setup({ branch: 'task/12-fix-login' });

    expect(await runGitHook('post-checkout', [PREV, SHA, '0'], h.ctx)).toBe(0);
    expect(h.out).toEqual([]);
    expect(h.gitCalls).toEqual([]);
  });

  it.each(['main', 'feature/x', undefined])('on %s: prints nothing and does not read the config', async branch => {
    const h = setup({ branch });

    expect(await runGitHook('post-checkout', [PREV, SHA, '1'], h.ctx)).toBe(0);
    expect(h.out).toEqual([]);
    expect(h.err).toEqual([]);
    expect(h.configLoads).toBe(0);
  });

  it('prints nothing when the task is not tracked, the tracker fails or the config is broken', async () => {
    const missing = setup({ branch: 'task/12-fix-login' });
    const offline = setup({ branch: 'task/12-fix-login' });
    offline.tracker.seedTask(taskState(12));
    offline.tracker.failNext('getTask');
    const broken = setup({ branch: 'task/12-fix-login', configError: new Error('boom') });

    for (const h of [missing, offline, broken]) {
      expect(await runGitHook('post-checkout', [PREV, SHA, '1'], h.ctx)).toBe(0);
      expect(h.out).toEqual([]);
      expect(h.err).toEqual([]);
    }
  });

  it('prints nothing when git itself fails', async () => {
    const h = setup({ branch: 'task/12-fix-login' });
    h.ctx.git = async () => {
      throw new Error('git not found');
    };

    expect(await runGitHook('post-checkout', [PREV, SHA, '1'], h.ctx)).toBe(0);
    expect(h.err).toEqual([]);
  });
});

describe('runGitHook in general', () => {
  it('knows the four hooks', () => {
    expect([...HOOK_NAMES]).toEqual(['pre-commit', 'pre-push', 'post-merge', 'post-checkout']);
  });

  it('ignores an unknown hook name with a warning, so a newer script never blocks git', async () => {
    const h = setup();

    expect(await runGitHook('pre-rebase', [], h.ctx)).toBe(0);
    expect(h.err).toEqual(['sdlc: warning: unknown git hook "pre-rebase"; ignored']);
  });

  it('an unexpected failure in pre-commit warns and does not block', async () => {
    const h = setup();
    h.ctx.git = async () => {
      throw new Error('git not found; install https://git-scm.com');
    };

    expect(await runGitHook('pre-commit', [], h.ctx)).toBe(0);
    expect(h.err).toEqual(['sdlc: warning: git hook pre-commit failed (git not found; install https://git-scm.com); skipped']);
  });
});

// -- spawnDetachedLogged ---------------------------------------------------------------------------

describe('spawnDetachedLogged', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sdlc-spawn-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The log once it holds `text`; the child is detached, so there is nothing to await but the file. */
  async function logWith(file: string, text: string): Promise<string> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const content = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (content.includes(text)) return content;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return existsSync(file) ? readFileSync(file, 'utf8') : '(no log)';
  }

  it('creates .sdlc/cache, appends stdout and stderr to the log and does not wait for the command', async () => {
    const logPath = join(dir, '.sdlc', 'cache', 'reconcile.log');

    spawnDetachedLogged({
      command: process.execPath,
      args: ['-e', 'console.log("to stdout"); console.error("to stderr")'],
      cwd: dir,
      logPath,
    });

    const log = await logWith(logPath, 'to stderr');
    expect(log).toContain('to stdout\n');
    expect(log).toContain('to stderr\n');
  });

  it('appends to a log that exists, keeping what is there', async () => {
    const logPath = join(dir, '.sdlc', 'cache', 'reconcile.log');
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, 'earlier run\n');

    spawnDetachedLogged({ command: process.execPath, args: ['-e', 'console.log("later run")'], cwd: dir, logPath });

    expect(await logWith(logPath, 'later run')).toBe('earlier run\nlater run\n');
  });

  it('runs in the given directory', async () => {
    const logPath = join(dir, 'log.txt');

    spawnDetachedLogged({ command: process.execPath, args: ['-e', 'console.log(process.cwd())'], cwd: dir, logPath });

    expect(realpathOf(await logWith(logPath, dir.slice(-6)))).toBe(realpathOf(`${dir}\n`));
  });

  it('writes a command that cannot start to the log instead of crashing', async () => {
    const logPath = join(dir, 'log.txt');
    const missing = join(dir, 'does-not-exist');

    expect(() => spawnDetachedLogged({ command: missing, args: [], cwd: dir, logPath })).not.toThrow();

    expect(await logWith(logPath, 'ENOENT')).toBe(`could not start ${missing}: spawn ${missing} ENOENT\n`);
  });
});

const realpathOf = (text: string): string => text.replace(/^\/private/, '');

// -- the commander command -------------------------------------------------------------------------

describe('registerGitHookCommand', () => {
  let exitCode: typeof process.exitCode;
  beforeEach(() => {
    exitCode = process.exitCode;
  });
  afterEach(() => {
    process.exitCode = exitCode;
  });

  const program = (h: Harness): Command => {
    const root = new Command().exitOverride();
    registerGitHookCommand(root, () => h.ctx);
    return root;
  };

  it('passes the hook name and its arguments through and sets the exit code from the hook', async () => {
    const h = setup({ branch: 'main', cfg: enforce });
    const run = vi.spyOn(h.ctx, 'loadConfig');

    await program(h).parseAsync(['githook', 'pre-commit', 'extra', 'args'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(run).toHaveBeenCalled();
    expect(h.err[0]).toContain('committing directly to main');
  });

  it('gives post-checkout its arguments', async () => {
    const h = setup({ branch: 'task/12-fix-login', cfg: observe });
    h.tracker.seedTask(taskState(12, { nextStep: 'go' }));

    await program(h).parseAsync(['githook', 'post-checkout', SHA, SHA, '1'], { from: 'user' });

    expect(process.exitCode).toBe(0);
    expect(h.out).toEqual(['task #12: In progress · Intake · next: go']);
  });

  it('tolerates an argument that looks like an option', async () => {
    const h = setup({ branch: 'feature/x', cfg: enforce });

    await program(h).parseAsync(['githook', 'pre-push', '--weird', 'origin'], { from: 'user' });

    expect(process.exitCode).toBe(0);
  });

  it('exit code 0 when the hook allows', async () => {
    const h = setup({ branch: 'feature/x', cfg: enforce });
    process.exitCode = 5;

    await program(h).parseAsync(['githook', 'pre-commit'], { from: 'user' });

    expect(process.exitCode).toBe(0);
  });
});
