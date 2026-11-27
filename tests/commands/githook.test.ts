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
  exitAfterFlush,
  HOOK_NAMES,
  lookupTrackedTask,
  POST_CHECKOUT_LOOKUP_TIMEOUT_MS,
  PRE_PUSH_LOOKUP_TIMEOUT_MS,
  registerGitHookCommand,
  RECONCILE_LOG,
  runGitHook,
  runSteps,
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
import { fingerprintOf } from '../../src/secrets/scan.js';
import type { ExecResult } from '../../src/secrets/gitleaks.js';
import type { Tracker } from '../../src/tracker/types.js';
import { FakeTracker } from '../support/fakeTracker.js';
import { githubToken, sampleFor, SAMPLES } from '../support/secrets.js';

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

  it('a lookup that throws at once is a failed lookup, and keeps the block of an earlier ref', async () => {
    const lines = [pushLine('refs/heads/main'), pushLine('refs/heads/task/3-x')];
    const throwsAtOnce: TaskLookup = () => {
      throw new Error('boom');
    };

    const result = await decidePrePush(lines, enforce, throwsAtOnce);

    expect(result).toEqual({
      exitCode: 1,
      messages: [
        { level: 'error', text: 'pushing directly to main; work on a task branch (task/<issue>-<slug>)' },
        { level: 'warn', text: 'could not verify task #3 (boom); push allowed' },
      ],
    });
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
  execCalls: Array<[string, string[]]>;
  whichCalls: string[];
  exits: number[];
  configLoads: number;
  trackerBuilds: number;
  stdinReads: number;
}

interface Options {
  branch?: string | undefined;
  cfg?: Config;
  configError?: Error;
  stdin?: string;
  /** The staged diff (`git diff --cached -U0 …`) and the staged names. */
  staged?: string;
  stagedNames?: string[];
  /** The diff of the pushed commits (`git log -p …`) and their names. */
  pushed?: string;
  pushedNames?: string[];
  /** Answers a git command before the defaults do: a result, or an error for a git that cannot run. */
  git?: (args: string[]) => Awaited<ReturnType<GitRunner>> | Error | undefined;
  /** gitleaks: whether it is on the PATH, and what running it gives. */
  gitleaks?: { present?: boolean; result?: ExecResult | Error };
  readStdinFails?: Error;
  spawnFails?: Error;
  repoRoot?: string;
  timeouts?: { prePushMs?: number; postCheckoutMs?: number };
}

/** A `git diff`/`git log -p` text that adds `lines` to `path` from line 1. */
const patchOf = (path: string, lines: string[]): string =>
  [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map(line => `+${line}`),
    '',
  ].join('\n');

function setup(options: Options = {}): Harness {
  const tracker = new FakeTracker();
  tracker.owners = [...base.owners];
  const harness: Harness = {
    out: [],
    err: [],
    tracker,
    spawned: [],
    gitCalls: [],
    exits: [],
    execCalls: [],
    whichCalls: [],
    configLoads: 0,
    trackerBuilds: 0,
    stdinReads: 0,
    ctx: undefined as unknown as GitHookContext,
  };
  const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });
  const git: GitRunner = async args => {
    harness.gitCalls.push(args);
    const override = options.git?.(args);
    if (override instanceof Error) throw override;
    if (override !== undefined) return override;
    if (args.join(' ') === 'symbolic-ref --short -q HEAD') {
      const branch = 'branch' in options ? options.branch : 'main';
      return branch === undefined ? { stdout: '', stderr: '', code: 1 } : ok(`${branch}\n`);
    }
    const names = args.includes('--name-only');
    if (args[0] === 'diff') return ok(names ? (options.stagedNames ?? []).map(name => `${name}\0`).join('') : (options.staged ?? ''));
    if (args[0] === 'log') return ok(names ? (options.pushedNames ?? []).map(name => `${name}\0`).join('') : (options.pushed ?? ''));
    return { stdout: '', stderr: 'unexpected', code: 128 };
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
    readStdin: async () => {
      harness.stdinReads += 1;
      if (options.readStdinFails) throw options.readStdinFails;
      return options.stdin ?? '';
    },
    which: command => {
      harness.whichCalls.push(command);
      return options.gitleaks?.present ? '/usr/bin/gitleaks' : undefined;
    },
    exec: async (command, args) => {
      harness.execCalls.push([command, args]);
      const result = options.gitleaks?.result ?? { code: 0, stdout: '', stderr: '' };
      if (result instanceof Error) throw result;
      return result;
    },
    spawnReconcile: logPath => {
      if (options.spawnFails) throw options.spawnFails;
      harness.spawned.push(logPath);
    },
    out: text => harness.out.push(text),
    err: text => harness.err.push(text),
    exit: code => harness.exits.push(code),
    ...(options.timeouts && { timeouts: options.timeouts }),
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
      'sdlc: warning: sdlc.config.yaml could not be loaded (Cannot read config file /repo/sdlc.config.yaml: ENOENT); branch rules skipped, secret guard still active',
    ]);
  });

  it('reports only the first line of a multi-line config error', async () => {
    const h = setup({ branch: 'main', configError: new Error('Invalid config:\n  - mode: bad\n  - version: 3') });

    await runGitHook('pre-commit', [], h.ctx);

    expect(h.err).toEqual([
      'sdlc: warning: sdlc.config.yaml could not be loaded (Invalid config:); branch rules skipped, secret guard still active',
    ]);
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
    expect(h.err).toEqual([
      'sdlc: warning: sdlc.config.yaml could not be loaded (boom); branch rules skipped, secret guard still active',
    ]);
  });
});

// -- the secret guard ----------------------------------------------------------------------------------

const ADVICE =
  'Move the secret to the keystore / production secret storage. False positive? add "sdlc:allow-secret" on the line, or add the fingerprint to secrets.allow in sdlc.config.yaml.';

/** Everything a run printed, to look for a secret in. */
const everything = (h: Harness): string => [...h.err, ...h.out].join('\n');

describe('runGitHook pre-commit: the secret guard', () => {
  const token = githubToken();
  const tokenFingerprint = fingerprintOf('github-token', token);
  const staged = (lines: string[] = [`const t = "${token}";`]) => ({ staged: patchOf('src/app.ts', lines) });

  it.each(MODES)('%s: a staged token blocks the commit, with the exact output of the brief', async (_mode, cfg) => {
    const h = setup({ branch: 'task/12-x', cfg, ...staged(['const a = 1;', `const t = "${token}";`]) });

    expect(await runGitHook('pre-commit', [], h.ctx)).toBe(1);
    expect(h.err).toEqual([
      'sdlc secret guard: commit blocked',
      // Line 2 of the new file; the first 4 characters of the match and its length are all that is shown.
      `src/app.ts:2 github-token ghp_…(40 chars) (fingerprint ${tokenFingerprint})`,
      ADVICE,
    ]);
    expect(h.out).toEqual([]);
  });

  it.each(MODES)('%s: nothing printed holds the token, or more than 4 characters of any secret', async (_mode, cfg) => {
    for (const sample of SAMPLES) {
      const h = setup({ cfg, staged: patchOf('src/app.ts', [sample.text]) });

      expect(await runGitHook('pre-commit', [], h.ctx)).toBe(1);
      expect(everything(h)).not.toContain(sample.secret);
      expect(everything(h)).not.toContain(sample.secret.slice(0, 8));
      expect(h.err[0]).toBe('sdlc secret guard: commit blocked');
    }
  });

  it.each(MODES)('%s: a staged secret file name blocks, an example file does not', async (_mode, cfg) => {
    const blocked = setup({ cfg, branch: 'task/1-a', stagedNames: ['.env.local'] });
    const fine = setup({ cfg, branch: 'task/1-a', stagedNames: ['.env.example', 'id_ed25519.pub', 'src/app.ts'] });

    expect(await runGitHook('pre-commit', [], blocked.ctx)).toBe(1);
    expect(blocked.err[1]).toMatch(/^\.env\.local env-file \.env\.local \(fingerprint [0-9a-f]{16}\)$/);
    expect(await runGitHook('pre-commit', [], fine.ctx)).toBe(0);
    expect(fine.err).toEqual([]);
  });

  it('runs the guard before the branch rules, and both report: a token on the default branch in enforce', async () => {
    const h = setup({ branch: 'main', cfg: enforce, ...staged() });

    expect(await runGitHook('pre-commit', [], h.ctx)).toBe(1);
    expect(h.err.map(line => line.slice(0, 40))).toEqual([
      'sdlc secret guard: commit blocked',
      expect.stringContaining('github-token'),
      ADVICE.slice(0, 40),
      'sdlc: error: committing directly to main',
    ]);
  });

  it('observe mode: a clean commit on the default branch still only warns', async () => {
    const h = setup({ branch: 'main', cfg: observe, ...staged(['const a = 1;']) });

    expect(await runGitHook('pre-commit', [], h.ctx)).toBe(0);
    expect(h.err).toEqual(['sdlc: warning: committing directly to main; work on a task branch (task/<issue>-<slug>)']);
  });

  it('scans on a detached HEAD too, and reads the config only to look up the allowed fingerprints', async () => {
    const blocked = setup({ branch: undefined, cfg: observe, ...staged() });
    const clean = setup({ branch: undefined, cfg: observe });

    expect(await runGitHook('pre-commit', [], blocked.ctx)).toBe(1);
    expect(blocked.configLoads).toBe(1);
    expect(await runGitHook('pre-commit', [], clean.ctx)).toBe(0);
    expect(clean.configLoads).toBe(0);
  });

  it('a config that cannot be loaded still blocks: with an empty allow list, and says the guard is active', async () => {
    const h = setup({ branch: 'main', configError: new ConfigError('Cannot read config file /repo/sdlc.config.yaml'), ...staged() });

    expect(await runGitHook('pre-commit', [], h.ctx)).toBe(1);
    expect(h.err).toEqual([
      'sdlc: warning: sdlc.config.yaml could not be loaded (Cannot read config file /repo/sdlc.config.yaml); branch rules skipped, secret guard still active',
      'sdlc secret guard: commit blocked',
      `src/app.ts:1 github-token ghp_…(40 chars) (fingerprint ${tokenFingerprint})`,
      ADVICE,
    ]);
    expect(h.configLoads).toBe(1);
  });

  it('a config error with nothing staged warns once and lets the commit through', async () => {
    const h = setup({ branch: 'main', configError: new Error('boom') });

    expect(await runGitHook('pre-commit', [], h.ctx)).toBe(0);
    expect(h.err).toEqual([
      'sdlc: warning: sdlc.config.yaml could not be loaded (boom); branch rules skipped, secret guard still active',
    ]);
  });

  it('secrets.allow: an allowed fingerprint passes, another one still blocks', async () => {
    const aws = sampleFor('aws-access-key').secret;
    const cfg: Config = { ...enforce, secrets: { ...enforce.secrets, allow: [tokenFingerprint] } };
    const allowed = setup({ branch: 'task/1-a', cfg, ...staged() });
    const other = setup({ branch: 'task/1-a', cfg, ...staged([`const t = "${token}"; const k = "${aws}";`]) });

    expect(await runGitHook('pre-commit', [], allowed.ctx)).toBe(0);
    expect(allowed.err).toEqual([]);
    expect(await runGitHook('pre-commit', [], other.ctx)).toBe(1);
    expect(other.err[1]).toContain('aws-access-key');
    expect(other.err).toHaveLength(3);
  });

  it('an allowed file-name fingerprint passes', async () => {
    const fingerprint = fingerprintOf('env-file', 'config/.env.test');
    const cfg: Config = { ...enforce, secrets: { ...enforce.secrets, allow: [fingerprint] } };
    const h = setup({ branch: 'task/1-a', cfg, stagedNames: ['config/.env.test'] });

    expect(await runGitHook('pre-commit', [], h.ctx)).toBe(0);
  });

  it('a line with sdlc:allow-secret passes', async () => {
    const h = setup({ branch: 'task/1-a', ...staged([`const t = "${token}"; // sdlc:allow-secret`]) });

    expect(await runGitHook('pre-commit', [], h.ctx)).toBe(0);
    expect(h.err).toEqual([]);
  });

  it('lists at most 50 findings and counts the rest', async () => {
    const lines = Array.from({ length: 60 }, () => `const t = "${token}";`);
    const h = setup({ cfg: observe, branch: 'task/1-a', ...staged(lines) });

    expect(await runGitHook('pre-commit', [], h.ctx)).toBe(1);
    expect(h.err).toHaveLength(1 + 50 + 1 + 1);
    expect(h.err[51]).toBe('… and 10 more');
  });

  describe('fails closed: a guard that cannot scan blocks, in both modes', () => {
    it.each(MODES)('%s: git diff fails', async (_mode, cfg) => {
      const h = setup({
        cfg,
        branch: 'task/1-a',
        git: args => (args[0] === 'diff' ? { stdout: '', stderr: 'fatal: index file corrupt\nmore', code: 128 } : undefined),
      });

      expect(await runGitHook('pre-commit', [], h.ctx)).toBe(1);
      expect(h.err).toEqual(['sdlc secret guard: could not scan (git diff failed: fatal: index file corrupt); commit blocked']);
    });

    it('the names command fails', async () => {
      const h = setup({
        branch: 'task/1-a',
        git: args => (args.includes('--name-only') ? { stdout: '', stderr: '', code: 1 } : undefined),
      });

      expect(await runGitHook('pre-commit', [], h.ctx)).toBe(1);
      expect(h.err).toEqual(['sdlc secret guard: could not scan (git diff failed: exit code 1); commit blocked']);
    });

    it('git cannot run at all', async () => {
      const h = setup({ git: () => new Error('git not found; install https://git-scm.com') });

      expect(await runGitHook('pre-commit', [], h.ctx)).toBe(1);
      expect(h.err[0]).toBe('sdlc secret guard: could not scan (git not found; install https://git-scm.com); commit blocked');
    });

    it('the diff cannot be read, or the guard throws something unexpected', async () => {
      const unreadable = setup({ branch: 'task/1-a', staged: 'diff --git a/x b/x\n+++ b/x\n@@ garbage @@\n+x\n' });
      const crash = setup({ branch: 'task/1-a', staged: patchOf('x', [`t = "${token}"`]) });
      // An allow list that is not a list: the guard breaks after it found something.
      crash.ctx.loadConfig = () => ({ ...enforce, secrets: { ...enforce.secrets, allow: 5 as unknown as string[] } });

      expect(await runGitHook('pre-commit', [], unreadable.ctx)).toBe(1);
      expect(unreadable.err[0]).toMatch(/^sdlc secret guard: could not scan \(unreadable hunk header: .*\); commit blocked$/);
      expect(await runGitHook('pre-commit', [], crash.ctx)).toBe(1);
      expect(crash.err).toHaveLength(1);
      expect(crash.err[0]).toMatch(/^sdlc secret guard: could not scan \(.*\); commit blocked$/);
      expect(everything(crash)).not.toContain(token);
    });

    it('the reason is one printable line and holds no diff text', async () => {
      const h = setup({ git: () => new Error(`first\u001b[31m line\nsecond ${token}`) });

      expect(await runGitHook('pre-commit', [], h.ctx)).toBe(1);
      expect(h.err[0]).toBe('sdlc secret guard: could not scan (first [31m line); commit blocked');
      expect(h.err[0]).not.toMatch(/[\u0000-\u001f]/);
      expect(everything(h)).not.toContain(token);
    });
  });

  describe('gitleaks', () => {
    const args = ['git', '--pre-commit', '--staged', '--redact', '--no-banner'];

    it('absent from the PATH: not called', async () => {
      const h = setup({ cfg: enforce, branch: 'task/1-a', gitleaks: { present: false, result: { code: 1, stdout: 'leaks', stderr: '' } } });

      expect(await runGitHook('pre-commit', [], h.ctx)).toBe(0);
      expect(h.whichCalls).toEqual(['gitleaks']);
      expect(h.execCalls).toEqual([]);
    });

    it('present and clean: runs on the staged changes and lets the commit through', async () => {
      const h = setup({ cfg: enforce, branch: 'task/1-a', gitleaks: { present: true } });

      expect(await runGitHook('pre-commit', [], h.ctx)).toBe(0);
      expect(h.execCalls).toEqual([['gitleaks', args]]);
      expect(h.err).toEqual([]);
    });

    it.each(MODES)('%s: exit 1 blocks with its output, though the built-in guard found nothing', async (_mode, cfg) => {
      const h = setup({
        cfg,
        branch: 'task/1-a',
        gitleaks: { present: true, result: { code: 1, stdout: 'Finding: REDACTED\nFile: src/a.ts\n', stderr: 'leaks found: 1\n' } },
      });

      expect(await runGitHook('pre-commit', [], h.ctx)).toBe(1);
      expect(h.err).toEqual([
        'sdlc secret guard: commit blocked',
        'gitleaks found secrets (its output is redacted):',
        '  Finding: REDACTED',
        '  File: src/a.ts',
        '  leaks found: 1',
        'Run "gitleaks git --pre-commit --staged --redact -v" for the details.',
        ADVICE,
      ]);
    });

    it('both find something: both are listed under one header', async () => {
      const h = setup({
        cfg: observe,
        staged: patchOf('a.ts', [`t = "${token}"`]),
        gitleaks: { present: true, result: { code: 1, stdout: 'Finding: REDACTED', stderr: '' } },
      });

      expect(await runGitHook('pre-commit', [], h.ctx)).toBe(1);
      expect(h.err.filter(line => line === 'sdlc secret guard: commit blocked')).toHaveLength(1);
      expect(h.err.some(line => line.includes('github-token'))).toBe(true);
      expect(h.err.some(line => line.includes('Finding: REDACTED'))).toBe(true);
    });

    it.each(MODES)('%s: exit 2 warns, and the built-in result decides: clean passes', async (_mode, cfg) => {
      const h = setup({ cfg, branch: 'task/1-a', gitleaks: { present: true, result: { code: 2, stdout: '', stderr: 'oops' } } });

      expect(await runGitHook('pre-commit', [], h.ctx)).toBe(0);
      expect(h.err).toEqual(['sdlc: warning: gitleaks failed (2); built-in guard only']);
    });

    it('exit 2 with a built-in finding: blocked by the built-in guard', async () => {
      const h = setup({
        cfg: observe,
        staged: patchOf('a.ts', [`t = "${token}"`]),
        gitleaks: { present: true, result: { code: 2, stdout: '', stderr: '' } },
      });

      expect(await runGitHook('pre-commit', [], h.ctx)).toBe(1);
      expect(h.err[0]).toBe('sdlc: warning: gitleaks failed (2); built-in guard only');
      expect(h.err[1]).toBe('sdlc secret guard: commit blocked');
    });

    it('a gitleaks that cannot start warns and leaves the decision to the built-in guard', async () => {
      const h = setup({ cfg: observe, branch: 'task/1-a', gitleaks: { present: true, result: new Error('spawn gitleaks EACCES') } });

      expect(await runGitHook('pre-commit', [], h.ctx)).toBe(0);
      expect(h.err).toEqual(['sdlc: warning: gitleaks failed (spawn gitleaks EACCES); built-in guard only']);
    });

    it('is not used when the staged changes cannot be read (the guard blocks first)', async () => {
      const h = setup({ git: () => ({ stdout: '', stderr: 'x', code: 128 }), gitleaks: { present: true } });

      expect(await runGitHook('pre-commit', [], h.ctx)).toBe(1);
      expect(h.execCalls).toEqual([]);
    });

    it('a context without exec and which just does without gitleaks', async () => {
      const h = setup({ branch: 'task/1-a' });
      delete h.ctx.exec;
      delete h.ctx.which;

      expect(await runGitHook('pre-commit', [], h.ctx)).toBe(0);
    });
  });
});

describe('runGitHook pre-push: the secret guard', () => {
  const token = githubToken();
  const pushed = (lines: string[] = [`const t = "${token}";`]) => ({ pushed: patchOf('src/app.ts', lines) });
  const toTopic = `${pushLine('refs/heads/topic', SHA)}\n`;

  it.each(MODES)('%s: a commit range that contains a token blocks the push', async (_mode, cfg) => {
    const h = setup({ cfg, stdin: toTopic, ...pushed() });

    expect(await runGitHook('pre-push', ['origin', 'u'], h.ctx)).toBe(1);
    expect(h.err).toEqual([
      'sdlc secret guard: push blocked',
      `src/app.ts:1 github-token ghp_…(40 chars) (fingerprint ${fingerprintOf('github-token', token)})`,
      ADVICE,
    ]);
    expect(everything(h)).not.toContain(token);
  });

  it('scans <remote sha>..<local sha>, or the new branch against the remotes, and the names too', async () => {
    const update = `refs/heads/work ${SHA} refs/heads/topic ${'b'.repeat(40)}\n`;
    const fresh = setup({ cfg: enforce, stdin: toTopic, pushedNames: ['.env'] });
    const known = setup({ cfg: enforce, stdin: update });

    expect(await runGitHook('pre-push', [], fresh.ctx)).toBe(1);
    expect(fresh.err[1]).toMatch(/^\.env env-file \.env \(fingerprint [0-9a-f]{16}\)$/);
    expect(fresh.gitCalls.map(call => call.slice(-3))).toEqual([[SHA, '--not', '--remotes'], [SHA, '--not', '--remotes']]);
    expect(await runGitHook('pre-push', [], known.ctx)).toBe(0);
    expect(known.gitCalls.map(call => call.at(-1))).toEqual([`${'b'.repeat(40)}..${SHA}`, `${'b'.repeat(40)}..${SHA}`]);
  });

  it('runs the guard before the branch rules: a token pushed to the default branch in enforce reports both', async () => {
    const h = setup({ cfg: enforce, stdin: `${pushLine('refs/heads/main')}\n`, ...pushed() });

    expect(await runGitHook('pre-push', [], h.ctx)).toBe(1);
    expect(h.err[0]).toBe('sdlc secret guard: push blocked');
    expect(h.err.at(-1)).toBe('sdlc: error: pushing directly to main; work on a task branch (task/<issue>-<slug>)');
  });

  it('observe mode: a clean push to the default branch still only warns', async () => {
    const h = setup({ cfg: observe, stdin: `${pushLine('refs/heads/main')}\n` });

    expect(await runGitHook('pre-push', [], h.ctx)).toBe(0);
    expect(h.err).toEqual(['sdlc: warning: pushing directly to main; work on a task branch (task/<issue>-<slug>)']);
  });

  it('a config that cannot be loaded still blocks, with an empty allow list', async () => {
    const h = setup({ configError: new Error('boom'), stdin: toTopic, ...pushed() });

    expect(await runGitHook('pre-push', [], h.ctx)).toBe(1);
    expect(h.err[0]).toBe(
      'sdlc: warning: sdlc.config.yaml could not be loaded (boom); branch rules skipped, secret guard still active',
    );
    expect(h.err[1]).toBe('sdlc secret guard: push blocked');
  });

  it('secrets.allow lets an accepted fingerprint through', async () => {
    const cfg: Config = { ...enforce, secrets: { ...enforce.secrets, allow: [fingerprintOf('github-token', token)] } };
    const h = setup({ cfg, stdin: toTopic, ...pushed() });

    expect(await runGitHook('pre-push', [], h.ctx)).toBe(0);
    expect(h.err).toEqual([]);
  });

  it('deleting a branch scans nothing (no git, no config, no stdin problem)', async () => {
    const h = setup({ cfg: enforce, stdin: `${pushLine('refs/heads/old', ZEROS, '(delete)')}\n` });

    expect(await runGitHook('pre-push', [], h.ctx)).toBe(0);
    expect(h.gitCalls).toEqual([]);
    expect(h.configLoads).toBe(0);
  });

  it('gitleaks is not used for a push', async () => {
    const h = setup({ cfg: enforce, stdin: toTopic, gitleaks: { present: true, result: { code: 1, stdout: 'leaks', stderr: '' } } });

    expect(await runGitHook('pre-push', [], h.ctx)).toBe(0);
    expect(h.whichCalls).toEqual([]);
    expect(h.execCalls).toEqual([]);
  });

  it('reads stdin once, for the guard and the branch rules together', async () => {
    const h = setup({ cfg: enforce, stdin: `${pushLine('refs/heads/task/12-x')}\n` });
    h.tracker.seedTask(taskState(12));

    expect(await runGitHook('pre-push', [], h.ctx)).toBe(0);
    expect(h.stdinReads).toBe(1);
  });

  describe('fails closed', () => {
    it.each(MODES)('%s: stdin cannot be read', async (_mode, cfg) => {
      const h = setup({ cfg, readStdinFails: new Error('EIO: read failed\nmore') });

      expect(await runGitHook('pre-push', [], h.ctx)).toBe(1);
      expect(h.err[0]).toBe('sdlc secret guard: could not scan (the push input could not be read: EIO: read failed); push blocked');
      expect(h.err).toHaveLength(2);
      expect(h.err[1]).toBe('sdlc: warning: git hook pre-push failed (EIO: read failed); skipped');
      expect(h.stdinReads).toBe(1);
    });

    it('stdin that throws before it returns a promise', async () => {
      const h = setup({ cfg: enforce });
      h.ctx.readStdin = () => {
        throw new Error('sync failure');
      };

      expect(await runGitHook('pre-push', [], h.ctx)).toBe(1);
      expect(h.err[0]).toBe('sdlc secret guard: could not scan (the push input could not be read: sync failure); push blocked');
    });

    it('a line of the push input that cannot be read', async () => {
      const h = setup({ cfg: enforce, stdin: `${toTopic}garbage here\n` });

      expect(await runGitHook('pre-push', [], h.ctx)).toBe(1);
      expect(h.err[0]).toBe('sdlc secret guard: could not scan (the push input has a line that cannot be read); push blocked');
    });

    it('an object name that is not one', async () => {
      const h = setup({ cfg: enforce, stdin: 'refs/heads/w --output=x refs/heads/topic 0000\n' });

      expect(await runGitHook('pre-push', [], h.ctx)).toBe(1);
      expect(h.err[0]).toBe('sdlc secret guard: could not scan (unexpected object name in the push update); push blocked');
      expect(h.gitCalls).toEqual([]);
    });

    it.each(MODES)('%s: git log fails', async (_mode, cfg) => {
      const h = setup({
        cfg,
        stdin: toTopic,
        git: args => (args[0] === 'log' ? { stdout: '', stderr: 'fatal: bad object', code: 128 } : undefined),
      });

      expect(await runGitHook('pre-push', [], h.ctx)).toBe(1);
      expect(h.err[0]).toBe('sdlc secret guard: could not scan (git log failed: fatal: bad object); push blocked');
    });

    it('git cannot run', async () => {
      const h = setup({ cfg: enforce, stdin: toTopic, git: () => new Error('git not found') });

      expect(await runGitHook('pre-push', [], h.ctx)).toBe(1);
      expect(h.err[0]).toBe('sdlc secret guard: could not scan (git not found); push blocked');
    });
  });
});

describe('runSteps', () => {
  const stepsHarness = () => setup();

  it('gives the highest exit code of the steps', async () => {
    const h = stepsHarness();

    expect(await runSteps(h.ctx, 'pre-commit', [() => 0, async () => 1, () => 0])).toBe(1);
    expect(await runSteps(h.ctx, 'pre-commit', [() => 0, () => 0])).toBe(0);
    expect(await runSteps(h.ctx, 'pre-commit', [])).toBe(0);
    expect(h.err).toEqual([]);
  });

  it('a step that throws warns and counts as 0, so it cannot erase an earlier block', async () => {
    const h = stepsHarness();
    const steps = [
      async () => 1,
      async () => {
        throw new Error('git not found\nsecond line');
      },
    ];

    expect(await runSteps(h.ctx, 'pre-commit', steps)).toBe(1);
    expect(h.err).toEqual(['sdlc: warning: git hook pre-commit failed (git not found); skipped']);
  });

  it('a step that throws does not stop the steps after it, even one that throws synchronously', async () => {
    const h = stepsHarness();
    const ran: string[] = [];
    const steps = [
      () => {
        throw new Error('first');
      },
      () => {
        ran.push('second');
        return 1;
      },
    ];

    expect(await runSteps(h.ctx, 'pre-push', steps)).toBe(1);
    expect(ran).toEqual(['second']);
    expect(h.err).toEqual(['sdlc: warning: git hook pre-push failed (first); skipped']);
  });
});

describe('runGitHook when the tracker cannot be used', () => {
  it('a tracker that cannot even be built is a failed lookup: the block of another ref stays', async () => {
    const h = setup({
      cfg: enforce,
      stdin: `${pushLine('refs/heads/main')}\n${pushLine('refs/heads/task/3-x')}\n`,
    });
    h.ctx.makeTracker = () => {
      throw new Error('no gh');
    };

    expect(await runGitHook('pre-push', [], h.ctx)).toBe(1);
    expect(h.err).toEqual([
      'sdlc: error: pushing directly to main; work on a task branch (task/<issue>-<slug>)',
      'sdlc: warning: could not verify task #3 (no gh); push allowed',
    ]);
  });

  it('a tracker call that throws at once is a failed lookup', async () => {
    const h = setup({ cfg: enforce, stdin: `${pushLine('refs/heads/main')}\n${pushLine('refs/heads/task/3-x')}\n` });
    h.tracker.getTask = (() => {
      throw new Error('sync boom');
    }) as unknown as FakeTracker['getTask'];

    expect(await runGitHook('pre-push', [], h.ctx)).toBe(1);
    expect(h.err[1]).toBe('sdlc: warning: could not verify task #3 (sync boom); push allowed');
  });
});

describe('the deadline on tracker calls', () => {
  const hang = (h: Harness): void => {
    h.tracker.getTask = (() => new Promise(() => undefined)) as FakeTracker['getTask'];
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses 10 seconds for pre-push and 5 for post-checkout', () => {
    expect(PRE_PUSH_LOOKUP_TIMEOUT_MS).toBe(10_000);
    expect(POST_CHECKOUT_LOOKUP_TIMEOUT_MS).toBe(5_000);
  });

  it('pre-push: a lookup that hangs is a failed lookup, the push is allowed and the process is told to exit', async () => {
    const h = setup({ cfg: enforce, stdin: `${pushLine('refs/heads/task/12-x')}\n`, timeouts: { prePushMs: 20 } });
    hang(h);

    expect(await runGitHook('pre-push', [], h.ctx)).toBe(0);
    expect(h.err).toEqual(['sdlc: warning: could not verify task #12 (timed out after 0.02s); push allowed']);
    expect(h.exits).toEqual([0]);
  });

  it('pre-push: a block decided from the other refs survives a hanging lookup, and exit gets its code', async () => {
    const h = setup({
      cfg: enforce,
      stdin: `${pushLine('refs/heads/main')}\n${pushLine('refs/heads/task/12-x')}\n`,
      timeouts: { prePushMs: 20 },
    });
    hang(h);

    expect(await runGitHook('pre-push', [], h.ctx)).toBe(1);
    expect(h.exits).toEqual([1]);
  });

  it('pre-push: the deadline is shared, so the lookups after it are not even started', async () => {
    const h = setup({
      cfg: enforce,
      stdin: `${pushLine('refs/heads/task/1-a')}\n${pushLine('refs/heads/task/2-b')}\n${pushLine('refs/heads/task/3-c')}\n`,
      timeouts: { prePushMs: 20 },
    });
    const asked: number[] = [];
    h.tracker.getTask = ((issue: number) => {
      asked.push(issue);
      return new Promise(() => undefined);
    }) as FakeTracker['getTask'];

    expect(await runGitHook('pre-push', [], h.ctx)).toBe(0);
    expect(asked).toEqual([1]);
    expect(h.err.map(line => line.replace(/ \(timed out.*/, ''))).toEqual([
      'sdlc: warning: could not verify task #1',
      'sdlc: warning: could not verify task #2',
      'sdlc: warning: could not verify task #3',
    ]);
  });

  it('pre-push: a lookup that answers in time does not ask the process to exit', async () => {
    const h = setup({ cfg: enforce, stdin: `${pushLine('refs/heads/task/12-x')}\n`, timeouts: { prePushMs: 5_000 } });
    h.tracker.seedTask(taskState(12));

    expect(await runGitHook('pre-push', [], h.ctx)).toBe(0);
    expect(h.exits).toEqual([]);
  });

  it('post-checkout: a call that hangs prints nothing, exits 0 and asks the process to exit', async () => {
    const h = setup({ branch: 'task/12-x', timeouts: { postCheckoutMs: 20 } });
    hang(h);

    expect(await runGitHook('post-checkout', ['a', 'b', '1'], h.ctx)).toBe(0);
    expect(h.out).toEqual([]);
    expect(h.err).toEqual([]);
    expect(h.exits).toEqual([0]);
  });

  it('the defaults are 10 s for pre-push and 5 s for post-checkout', async () => {
    vi.useFakeTimers();
    const push = setup({ cfg: enforce, stdin: `${pushLine('refs/heads/task/12-x')}\n` });
    const checkout = setup({ branch: 'task/12-x' });
    hang(push);
    hang(checkout);
    const settled: string[] = [];
    void runGitHook('pre-push', [], push.ctx).then(() => settled.push('pre-push'));
    void runGitHook('post-checkout', ['a', 'b', '1'], checkout.ctx).then(() => settled.push('post-checkout'));

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual(['post-checkout']);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toEqual(['post-checkout']);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual(['post-checkout', 'pre-push']);
    expect(push.err).toEqual(['sdlc: warning: could not verify task #12 (timed out after 10s); push allowed']);
  });
});

describe('exitAfterFlush', () => {
  it('exits with the code only after every stream has flushed, in order', async () => {
    const events: string[] = [];
    const stream = (name: string) => ({
      write: (chunk: string, callback: () => void) => {
        events.push(`write ${name}`);
        setTimeout(() => {
          events.push(`flushed ${name}`);
          callback();
        }, 5);
        return true;
      },
    });

    exitAfterFlush(3, code => events.push(`exit ${code}`), [stream('stdout'), stream('stderr')] as never);
    expect(events).toEqual(['write stdout']);
    await new Promise(resolve => setTimeout(resolve, 40));

    expect(events).toEqual(['write stdout', 'flushed stdout', 'write stderr', 'flushed stderr', 'exit 3']);
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

  it('a git that cannot run blocks pre-commit (the guard fails closed); the branch rules only warn', async () => {
    const h = setup();
    h.ctx.git = async () => {
      throw new Error('git not found; install https://git-scm.com');
    };

    expect(await runGitHook('pre-commit', [], h.ctx)).toBe(1);
    expect(h.err).toEqual([
      'sdlc secret guard: could not scan (git not found; install https://git-scm.com); commit blocked',
      'sdlc: warning: git hook pre-commit failed (git not found; install https://git-scm.com); skipped',
    ]);
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
