import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli.js';
import { registerWorktreeCommand, type WorktreeContext } from '../../src/commands/worktree.js';
import { loadConfig, typeRegistry } from '../../src/config/schema.js';
import { newTask } from '../../src/core/stateMachine.js';
import type { TaskState } from '../../src/core/types.js';
import { createGitRunner, type GitRunner } from '../../src/install/provision.js';
import { isQueueableCommandPath } from '../../src/outbox/outbox.js';
import { FakeTracker } from '../support/fakeTracker.js';
import { createTestRepo, type TestRepo } from '../support/gitRepo.js';

const cfg = loadConfig(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/config/valid.yaml'));
const types = typeRegistry(cfg);
const NOW = '2026-06-01T00:00:00.000Z';
const SHA = 'a'.repeat(40);
const BRANCH = 'task/5-add-login';
const DIR = '.worktrees/5-add-login';

/** A feature task #`issue` that has not merged anything yet. */
const taskState = (issue: number, overrides: Partial<TaskState> = {}): TaskState => ({
  ...newTask({ issue, type: types.get('feature')!, summary: `Task ${issue}`, now: NOW }),
  ...overrides,
});

/** The state of a task whose final PR merged. */
const merged: Partial<TaskState> = { prs: [{ number: 50, scope: 'final', mergeSha: SHA }] };

interface Harness {
  repo: TestRepo;
  /** The real path of the main checkout. */
  root: string;
  tracker: FakeTracker;
  ctx: WorktreeContext;
  out: string[];
  err: string[];
  /** Every git call the command made. */
  calls: string[][];
  /** Runs git in `dir` (the main checkout by default) and returns its output. */
  git(args: string[], dir?: string): string;
  /** The absolute path of the worktree of #5. */
  worktree: string;
}

const cleanups: (() => void)[] = [];
let exitCode: typeof process.exitCode;
beforeEach(() => {
  exitCode = process.exitCode;
});
afterEach(() => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllEnvs();
});

/** A repository on `main` with one commit, an `origin` bare remote that has it, and task #5 titled `Add login`. */
function setup(state: Partial<TaskState> = {}): Harness {
  const repo = createTestRepo();
  cleanups.push(() => repo.cleanup());
  repo.write('README.md', 'one\n');
  // What `sdlc init` writes: the worktrees are never part of the main checkout's changes.
  repo.write('.gitignore', '.worktrees/\n');
  repo.commit('init');
  const remote = join(dirname(repo.root), 'origin.git');
  execFileSync('git', ['init', '--bare', '-q', '--initial-branch=main', remote], { env: repo.env, stdio: 'pipe' });
  repo.git('remote', 'add', 'origin', remote);
  repo.git('push', '-q', 'origin', 'main');

  const root = realpathSync(repo.root);
  const tracker = new FakeTracker();
  tracker.owners = [...cfg.owners];
  tracker.seedTask(taskState(5, state), { title: 'Add login' });
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[][] = [];
  const real = createGitRunner(root);
  const git: GitRunner = args => {
    calls.push(args);
    return real(args);
  };
  const ctx: WorktreeContext = {
    tracker,
    cfg,
    now: () => NOW,
    out: data => out.push(String(data)),
    err: text => err.push(text),
    repoRoot: root,
    cwd: root,
    git,
  };
  return {
    repo,
    root,
    tracker,
    ctx,
    out,
    err,
    calls,
    worktree: join(root, DIR),
    git: (args, dir = root) =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], {
        cwd: dir,
        env: repo.env,
        encoding: 'utf8',
        stdio: 'pipe',
      }),
  };
}

async function run(h: Harness, ...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerWorktreeCommand(program, () => h.ctx);
  await program.parseAsync(['node', 'sdlc', 'worktree', ...args]);
}

/** Starts the worktree of #5, then forgets what that printed and called. */
async function started(h: Harness): Promise<void> {
  await run(h, 'start', '5');
  expect(h.err).toEqual([]);
  h.out.length = 0;
  h.calls.length = 0;
}

/** Commits a file in the worktree of #5 and returns the new commit. */
function commitInWorktree(h: Harness, file = 'feature.txt'): string {
  writeFileSync(join(h.worktree, file), 'feature\n');
  h.git(['add', '-A'], h.worktree);
  h.git(['commit', '-q', '-m', 'feat: login'], h.worktree);
  return h.git(['rev-parse', 'HEAD'], h.worktree).trim();
}

/** Where `args` is among the recorded git calls, as a prefix; -1 when it is not. */
const indexOfCall = (calls: string[][], ...prefix: string[]): number =>
  calls.findIndex(call => prefix.every((word, index) => call[index] === word));

const has = (calls: string[][], ...prefix: string[]): boolean => indexOfCall(calls, ...prefix) >= 0;

const FORBIDDEN = ['--force', '-f', '-D', '--delete', 'prune'];
const expectNoDestructiveGit = (calls: string[][]): void => {
  expect(calls.flat().filter(arg => FORBIDDEN.includes(arg))).toEqual([]);
};

const branches = (h: Harness): string[] =>
  h.git(['branch', '--list', 'task/*', '--format=%(refname:short)'])
    .split('\n')
    .filter(Boolean);

describe('sdlc worktree start', () => {
  it('fetches the default branch and adds the worktree and branch from origin/main', async () => {
    const h = setup();

    await run(h, 'start', '5');

    expect(h.err).toEqual([]);
    expect(process.exitCode).toBe(exitCode);
    expect(has(h.calls, 'fetch', 'origin', 'main')).toBe(true);
    expect(h.calls).toContainEqual(['worktree', 'add', '-b', BRANCH, DIR, 'origin/main']);
    expect(indexOfCall(h.calls, 'fetch')).toBeLessThan(indexOfCall(h.calls, 'worktree', 'add'));
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).toContain(h.worktree);
    expect(h.out[0]).toContain(BRANCH);
    expect(existsSync(join(h.worktree, 'README.md'))).toBe(true);
    expect(h.git(['branch', '--show-current'], h.worktree).trim()).toBe(BRANCH);
    expect(h.git(['rev-parse', 'HEAD'], h.worktree)).toBe(h.git(['rev-parse', 'origin/main']));
    expectNoDestructiveGit(h.calls);
  });

  it('uses the configured default branch', async () => {
    const h = setup();
    h.repo.git('branch', 'trunk');
    h.repo.git('push', '-q', 'origin', 'trunk');
    h.ctx.cfg = { ...cfg, github: { ...cfg.github, defaultBranch: 'trunk' } };

    await run(h, 'start', '5');

    expect(h.err).toEqual([]);
    expect(has(h.calls, 'fetch', 'origin', 'trunk')).toBe(true);
    expect(h.calls).toContainEqual(['worktree', 'add', '-b', BRANCH, DIR, 'origin/trunk']);
  });

  it('starts from the fetched origin/main, not from a stale local main', async () => {
    const h = setup();
    // Someone else's commit reaches origin; the local main does not have it.
    const other = join(dirname(h.root), 'other');
    h.git(['clone', '-q', join(dirname(h.root), 'origin.git'), other], dirname(h.root));
    writeFileSync(join(other, 'theirs.txt'), 'x\n');
    h.git(['add', '-A'], other);
    h.git(['commit', '-q', '-m', 'theirs'], other);
    h.git(['push', '-q', 'origin', 'HEAD:main'], other);

    await run(h, 'start', '5');

    expect(existsSync(join(h.worktree, 'theirs.txt'))).toBe(true);
    expect(existsSync(join(h.root, 'theirs.txt'))).toBe(false);
  });

  it('refuses when the branch already exists, and adds nothing', async () => {
    const h = setup();
    h.git(['branch', BRANCH]);

    await run(h, 'start', '5');

    expect(h.err).toEqual([`${BRANCH} already exists`]);
    expect(process.exitCode).toBe(1);
    expect(has(h.calls, 'worktree', 'add')).toBe(false);
    expect(h.out).toEqual([]);
  });

  it('refuses when a branch of #5 exists under an earlier title', async () => {
    const h = setup();
    h.git(['branch', 'task/5-old-title']);

    await run(h, 'start', '5');

    expect(h.err[0]).toContain('task/5-old-title already exists');
    expect(process.exitCode).toBe(1);
    expect(has(h.calls, 'worktree', 'add')).toBe(false);
  });

  it('does not take the branch of another issue with the same first digits for #5', async () => {
    const h = setup();
    h.git(['branch', 'task/50-other']);

    await run(h, 'start', '5');

    expect(h.err).toEqual([]);
    expect(existsSync(h.worktree)).toBe(true);
  });

  it('refuses when the path already exists, and adds nothing', async () => {
    const h = setup();
    mkdirSync(h.worktree, { recursive: true });

    await run(h, 'start', '5');

    expect(h.err[0]).toContain(`${BRANCH} already exists`);
    expect(h.err[0]).toContain(DIR);
    expect(process.exitCode).toBe(1);
    expect(has(h.calls, 'worktree', 'add')).toBe(false);
    expect(has(h.calls, 'fetch')).toBe(false);
  });

  it('does not create a worktree from a stale base when the fetch fails', async () => {
    const h = setup();
    h.git(['remote', 'set-url', 'origin', join(dirname(h.root), 'gone.git')]);

    await run(h, 'start', '5');

    expect(h.err[0]).toContain('git fetch origin main failed');
    expect(process.exitCode).toBe(1);
    expect(has(h.calls, 'worktree', 'add')).toBe(false);
    expect(existsSync(h.worktree)).toBe(false);
  });

  it('reports a failed worktree add with git\'s reason', async () => {
    const h = setup();
    // `.worktrees` is a file, so git cannot create the worktree directory in it.
    writeFileSync(join(h.root, '.worktrees'), 'in the way\n');

    await run(h, 'start', '5');

    expect(h.err[0]).toContain('git worktree add failed');
    expect(process.exitCode).toBe(1);
    expect(h.out).toEqual([]);
    expect(branches(h)).toEqual([]);
  });

  it('does nothing but print the plan with --dry-run', async () => {
    const h = setup();

    await run(h, 'start', '5', '--dry-run');

    expect(h.err).toEqual([]);
    expect(has(h.calls, 'fetch')).toBe(false);
    expect(has(h.calls, 'worktree', 'add')).toBe(false);
    expect(existsSync(join(h.root, '.worktrees'))).toBe(false);
    expect(h.out[0]).toContain(h.worktree);
    expect(h.out[0]).toContain('git fetch origin main');
    expect(h.out[0]).toContain(`git worktree add -b ${BRANCH} ${DIR} origin/main`);
    expect(h.out[0]).toMatch(/would/i);
  });

  it('still refuses an existing branch with --dry-run', async () => {
    const h = setup();
    h.git(['branch', BRANCH]);

    await run(h, 'start', '5', '--dry-run');

    expect(h.err).toEqual([`${BRANCH} already exists`]);
    expect(process.exitCode).toBe(1);
  });

  it('prints the result as JSON with --json', async () => {
    const h = setup();

    await run(h, 'start', '5', '--json');

    expect(JSON.parse(h.out[0] as string)).toEqual({
      issue: 5,
      branch: BRANCH,
      path: h.worktree,
      base: 'origin/main',
      dryRun: false,
    });
  });

  it('adds the plan to the JSON of a dry run', async () => {
    const h = setup();

    await run(h, 'start', '5', '--dry-run', '--json');

    expect(JSON.parse(h.out[0] as string)).toEqual({
      issue: 5,
      branch: BRANCH,
      path: h.worktree,
      base: 'origin/main',
      dryRun: true,
      plan: ['git fetch origin main', `git worktree add -b ${BRANCH} ${DIR} origin/main`],
    });
  });

  it('names the branch after the title as it is now', async () => {
    const h = setup();
    h.tracker.issues.find(issue => issue.number === 5)!.title = 'Fix: Login – crash on iOS 18!';

    await run(h, 'start', '5');

    expect(h.calls).toContainEqual([
      'worktree',
      'add',
      '-b',
      'task/5-fix-login-crash-on-ios-18',
      '.worktrees/5-fix-login-crash-on-ios-18',
      'origin/main',
    ]);
  });

  it('fails for an issue that is not tracked, before touching git', async () => {
    const h = setup();

    await run(h, 'start', '9');

    expect(h.err).toHaveLength(1);
    expect(h.err[0]).toContain('getTask');
    expect(process.exitCode).toBe(1);
    expect(h.calls).toEqual([]);
  });

  it('rejects an issue that is not a number', async () => {
    const h = setup();

    await run(h, 'start', 'five');

    expect(h.err[0]).toContain('Invalid issue number "five"');
    expect(process.exitCode).toBe(1);
  });
});

describe('sdlc worktree finish', () => {
  it('fast-forwards the main checkout, removes the worktree, then deletes the branch', async () => {
    const h = setup(merged);
    await started(h);
    commitInWorktree(h);
    // The PR merged on GitHub: its commit is now the head of origin/main.
    h.git(['push', '-q', 'origin', 'HEAD:main'], h.worktree);

    await run(h, 'finish', '5');

    expect(h.err).toEqual([]);
    expect(process.exitCode).toBe(exitCode);
    const merge = indexOfCall(h.calls, 'merge', '--ff-only', 'origin/main');
    const remove = indexOfCall(h.calls, 'worktree', 'remove');
    const branch = indexOfCall(h.calls, 'branch', '-d', BRANCH);
    expect(merge).toBeGreaterThanOrEqual(0);
    expect(merge).toBeLessThan(remove);
    expect(remove).toBeLessThan(branch);
    expect(h.calls[remove]).toEqual(['worktree', 'remove', h.worktree]);
    expect(existsSync(h.worktree)).toBe(false);
    expect(branches(h)).toEqual([]);
    expect(readFileSync(join(h.root, 'feature.txt'), 'utf8')).toBe('feature\n');
    expect(h.out.join('\n')).toContain(DIR);
    expect(h.out.join('\n')).not.toContain('kept');
    expectNoDestructiveGit(h.calls);
  });

  it('fetches origin/main before it merges', async () => {
    const h = setup(merged);
    await started(h);
    commitInWorktree(h);
    h.git(['push', '-q', 'origin', 'HEAD:main'], h.worktree);

    await run(h, 'finish', '5');

    const fetch = indexOfCall(h.calls, 'fetch', 'origin', 'main');
    expect(fetch).toBeGreaterThanOrEqual(0);
    expect(fetch).toBeLessThan(indexOfCall(h.calls, 'merge'));
  });

  it('refuses while the worktree has changes, listing them, and removes nothing', async () => {
    const h = setup(merged);
    await started(h);
    writeFileSync(join(h.worktree, 'notes.txt'), 'draft\n');
    writeFileSync(join(h.worktree, 'README.md'), 'changed\n');

    await run(h, 'finish', '5');

    expect(process.exitCode).toBe(1);
    expect(h.err).toHaveLength(1);
    expect(h.err[0]).toContain(`${DIR} has changes`);
    expect(h.err[0]).toContain('?? notes.txt');
    expect(h.err[0]).toContain(' M README.md');
    expect(has(h.calls, 'worktree', 'remove')).toBe(false);
    expect(has(h.calls, 'merge')).toBe(false);
    expect(has(h.calls, 'branch', '-d')).toBe(false);
    expect(existsSync(h.worktree)).toBe(true);
    expect(branches(h)).toEqual([BRANCH]);
  });

  it('still sees untracked files when the user hides them from git status', async () => {
    const h = setup(merged);
    await started(h);
    h.git(['config', 'status.showUntrackedFiles', 'no']);
    writeFileSync(join(h.worktree, 'notes.txt'), 'draft\n');
    // The setting does hide them from a plain status, which is what a naive check would read.
    expect(h.git(['status', '--porcelain'], h.worktree)).toBe('');

    await run(h, 'finish', '5');

    expect(process.exitCode).toBe(1);
    expect(h.err).toHaveLength(1);
    expect(h.err[0]).toContain(`${DIR} has changes`);
    expect(h.err[0]).toContain('?? notes.txt');
    expect(has(h.calls, 'worktree', 'remove')).toBe(false);
    expect(existsSync(join(h.worktree, 'notes.txt'))).toBe(true);
    expect(branches(h)).toEqual([BRANCH]);
  });

  it('counts untracked files of the main checkout as changes when the user hides them from git status', async () => {
    const h = setup(merged);
    await started(h);
    h.git(['config', 'status.showUntrackedFiles', 'no']);
    writeFileSync(join(h.root, 'scratch.txt'), 'mine\n');

    await run(h, 'finish', '5');

    expect(has(h.calls, 'merge')).toBe(false);
    expect(h.out.join('\n')).toContain('main checkout not updated: it has changes');
    expect(readFileSync(join(h.root, 'scratch.txt'), 'utf8')).toBe('mine\n');
    expect(existsSync(h.worktree)).toBe(false);
  });

  describe('ignored files', () => {
    /** Ignores local settings, build output and dependencies in every worktree of the repository. */
    const ignoreLocalFiles = (h: Harness): void => {
      appendFileSync(join(h.root, '.git', 'info', 'exclude'), '.env\n.env.*\ndist/\nnode_modules/\n');
    };

    it('refuses while the worktree holds an ignored .env file, naming it, and removes nothing', async () => {
      const h = setup(merged);
      ignoreLocalFiles(h);
      await started(h);
      writeFileSync(join(h.worktree, '.env'), 'TOKEN=x\n');
      mkdirSync(join(h.worktree, 'config'));
      writeFileSync(join(h.worktree, 'config', '.env.production'), 'TOKEN=y\n');

      await run(h, 'finish', '5');

      expect(process.exitCode).toBe(1);
      expect(h.err).toHaveLength(1);
      expect(h.err[0]).toContain(`${DIR} holds ignored local files (.env, config/.env.production)`);
      expect(h.err[0]).toContain('move them out, then run `sdlc worktree finish 5` again');
      expect(has(h.calls, 'worktree', 'remove')).toBe(false);
      expect(has(h.calls, 'merge')).toBe(false);
      expect(readFileSync(join(h.worktree, '.env'), 'utf8')).toBe('TOKEN=x\n');
      expect(branches(h)).toEqual([BRANCH]);
    });

    it('finishes once the .env file has been moved out', async () => {
      const h = setup(merged);
      ignoreLocalFiles(h);
      await started(h);
      writeFileSync(join(h.worktree, '.env'), 'TOKEN=x\n');
      await run(h, 'finish', '5');
      expect(process.exitCode).toBe(1);
      process.exitCode = exitCode;
      h.err.length = 0;
      rmSync(join(h.worktree, '.env'));

      await run(h, 'finish', '5');

      expect(h.err).toEqual([]);
      expect(existsSync(h.worktree)).toBe(false);
    });

    it('does not mind other ignored files: build output and dependencies go with the worktree', async () => {
      const h = setup(merged);
      ignoreLocalFiles(h);
      await started(h);
      mkdirSync(join(h.worktree, 'dist'));
      writeFileSync(join(h.worktree, 'dist', 'app.js'), 'built\n');
      mkdirSync(join(h.worktree, 'node_modules'));
      writeFileSync(join(h.worktree, 'node_modules', 'dep.js'), 'dep\n');
      expect(h.git(['status', '--porcelain', '--ignored'], h.worktree)).toContain('!! dist/');

      await run(h, 'finish', '5');

      expect(h.err).toEqual([]);
      expect(process.exitCode).toBe(exitCode);
      expect(existsSync(h.worktree)).toBe(false);
      expect(branches(h)).toEqual([]);
    });

    it('reports an ignored .env file together with the other reasons, and also with --dry-run', async () => {
      const h = setup();
      ignoreLocalFiles(h);
      await started(h);
      writeFileSync(join(h.worktree, '.env'), 'TOKEN=x\n');
      writeFileSync(join(h.worktree, 'notes.txt'), 'draft\n');

      await run(h, 'finish', '5', '--dry-run');

      expect(h.err).toHaveLength(1);
      expect(h.err[0]).toContain('#5 has no merged PR yet');
      expect(h.err[0]).toContain('?? notes.txt');
      expect(h.err[0]).toContain('holds ignored local files (.env)');
      expect(h.err[0]).not.toContain('!! .env');
      expect(process.exitCode).toBe(1);
    });

    it('says in its --help that ignored files are removed with the worktree', () => {
      const h = setup();
      const program = new Command();
      registerWorktreeCommand(program, () => h.ctx);
      const finish = program.commands.find(c => c.name() === 'worktree')?.commands.find(c => c.name() === 'finish');
      const help: string[] = [];
      finish!.configureOutput({ writeOut: text => help.push(text), writeErr: text => help.push(text) });

      finish!.outputHelp();

      expect(help.join('')).toMatch(/ignored files .* are removed together with (it|the worktree)/i);
      expect(help.join('')).toContain('.env');
    });
  });

  it('refuses while #5 has no merged PR and is not awaiting deployment or done', async () => {
    const h = setup({ prs: [{ number: 50, scope: 'final' }] });
    await started(h);

    await run(h, 'finish', '5');

    expect(process.exitCode).toBe(1);
    expect(h.err).toEqual(['#5 has no merged PR yet']);
    expect(has(h.calls, 'worktree', 'remove')).toBe(false);
    expect(existsSync(h.worktree)).toBe(true);
  });

  it.each(['awaiting_deployment', 'done'] as const)('lets a task that is %s finish without a PR record', async status => {
    const h = setup({ status, phase: 'delivery', waitingOn: 'none' });
    await started(h);

    await run(h, 'finish', '5');

    expect(h.err).toEqual([]);
    expect(existsSync(h.worktree)).toBe(false);
  });

  it('reports every reason it refuses in one go', async () => {
    const h = setup();
    await started(h);
    writeFileSync(join(h.worktree, 'notes.txt'), 'draft\n');

    await run(h, 'finish', '5');

    expect(h.err).toHaveLength(1);
    expect(h.err[0]).toContain('#5 has no merged PR yet');
    expect(h.err[0]).toContain('?? notes.txt');
    expect(process.exitCode).toBe(1);
  });

  it('refuses to remove the worktree it is running in, and says to run it from the main checkout', async () => {
    const h = setup(merged);
    await started(h);
    h.ctx.cwd = join(h.worktree, 'sub', 'dir');
    mkdirSync(h.ctx.cwd, { recursive: true });

    await run(h, 'finish', '5');

    expect(process.exitCode).toBe(1);
    expect(h.err).toHaveLength(1);
    expect(h.err[0]).toContain('from the main checkout');
    expect(h.err[0]).toContain(h.root);
    expect(has(h.calls, 'worktree', 'remove')).toBe(false);
    expect(existsSync(h.worktree)).toBe(true);
  });

  it('is not fooled by a symlink to the worktree', async () => {
    const h = setup(merged);
    await started(h);
    const link = join(dirname(h.root), 'link');
    execFileSync('ln', ['-s', h.worktree, link]);
    h.ctx.cwd = link;

    await run(h, 'finish', '5');

    expect(h.err[0]).toContain('from the main checkout');
    expect(existsSync(h.worktree)).toBe(true);
  });

  it('can run from another linked worktree', async () => {
    const h = setup(merged);
    await started(h);
    h.git(['worktree', 'add', '-q', '-b', 'task/6-other', '.worktrees/6-other', 'origin/main']);
    h.ctx.cwd = join(h.root, '.worktrees', '6-other');

    await run(h, 'finish', '5');

    expect(h.err).toEqual([]);
    expect(existsSync(h.worktree)).toBe(false);
    expect(existsSync(h.ctx.cwd)).toBe(true);
  });

  it('finds the worktree by its task branch, whatever the title is now', async () => {
    const h = setup(merged);
    await started(h);
    h.tracker.issues.find(issue => issue.number === 5)!.title = 'A completely different title';

    await run(h, 'finish', '5');

    expect(h.err).toEqual([]);
    expect(existsSync(h.worktree)).toBe(false);
    expect(h.calls).toContainEqual(['branch', '-d', BRANCH]);
  });

  it('fails when #5 has no worktree under .worktrees/', async () => {
    const h = setup(merged);

    await run(h, 'finish', '5');

    expect(process.exitCode).toBe(1);
    expect(h.err[0]).toContain('no worktree');
    expect(h.err[0]).toContain('#5');
    expect(has(h.calls, 'worktree', 'remove')).toBe(false);
  });

  it('does not touch the worktree of a branch of #5 that lives outside .worktrees/', async () => {
    const h = setup(merged);
    const elsewhere = join(dirname(h.root), 'elsewhere');
    h.git(['worktree', 'add', '-q', '-b', BRANCH, elsewhere, 'origin/main']);

    await run(h, 'finish', '5');

    expect(process.exitCode).toBe(1);
    expect(h.err[0]).toContain('no worktree');
    expect(existsSync(elsewhere)).toBe(true);
  });

  it('does not take the worktree of issue #50 for #5', async () => {
    const h = setup(merged);
    h.git(['worktree', 'add', '-q', '-b', 'task/50-big', '.worktrees/50-big', 'origin/main']);

    await run(h, 'finish', '5');

    expect(h.err[0]).toContain('no worktree');
    expect(existsSync(join(h.root, '.worktrees', '50-big'))).toBe(true);
  });

  it('refuses when two worktrees claim #5, naming them', async () => {
    const h = setup(merged);
    h.git(['worktree', 'add', '-q', '-b', 'task/5-a', '.worktrees/5-a', 'origin/main']);
    h.git(['worktree', 'add', '-q', '-b', 'task/5-b', '.worktrees/5-b', 'origin/main']);

    await run(h, 'finish', '5');

    expect(process.exitCode).toBe(1);
    expect(h.err[0]).toContain('.worktrees/5-a');
    expect(h.err[0]).toContain('.worktrees/5-b');
    expect(has(h.calls, 'worktree', 'remove')).toBe(false);
  });

  it('only reports when the main checkout is not on the default branch, and still finishes', async () => {
    const h = setup(merged);
    await started(h);
    h.git(['checkout', '-q', '-b', 'scratch']);

    await run(h, 'finish', '5');

    expect(h.err).toEqual([]);
    expect(process.exitCode).toBe(exitCode);
    expect(has(h.calls, 'merge')).toBe(false);
    expect(h.out.join('\n')).toContain('main checkout not updated: it is on scratch, not main');
    expect(existsSync(h.worktree)).toBe(false);
    expect(h.git(['branch', '--show-current']).trim()).toBe('scratch');
  });

  it('only reports when the main checkout is detached', async () => {
    const h = setup(merged);
    await started(h);
    h.git(['checkout', '-q', '--detach']);

    await run(h, 'finish', '5');

    expect(has(h.calls, 'merge')).toBe(false);
    expect(h.out.join('\n')).toContain('main checkout not updated: HEAD is detached');
    expect(existsSync(h.worktree)).toBe(false);
  });

  it('only reports when the main checkout has changes, and leaves them alone', async () => {
    const h = setup(merged);
    await started(h);
    writeFileSync(join(h.root, 'README.md'), 'mine\n');

    await run(h, 'finish', '5');

    expect(has(h.calls, 'merge')).toBe(false);
    expect(h.out.join('\n')).toContain('main checkout not updated: it has changes');
    expect(readFileSync(join(h.root, 'README.md'), 'utf8')).toBe('mine\n');
    expect(existsSync(h.worktree)).toBe(false);
  });

  it('only reports when the main checkout cannot be fast-forwarded', async () => {
    const h = setup(merged);
    await started(h);
    // The local main has a commit of its own that origin/main does not.
    writeFileSync(join(h.root, 'local.txt'), 'x\n');
    h.git(['add', '-A']);
    h.git(['commit', '-q', '-m', 'local']);
    const other = join(dirname(h.root), 'other');
    h.git(['clone', '-q', join(dirname(h.root), 'origin.git'), other], dirname(h.root));
    writeFileSync(join(other, 'theirs.txt'), 'x\n');
    h.git(['add', '-A'], other);
    h.git(['commit', '-q', '-m', 'theirs'], other);
    h.git(['push', '-q', 'origin', 'HEAD:main'], other);

    await run(h, 'finish', '5');

    expect(has(h.calls, 'merge', '--ff-only', 'origin/main')).toBe(true);
    expect(process.exitCode).toBe(exitCode);
    expect(h.out.join('\n')).toContain('main checkout not updated: git merge --ff-only origin/main was refused');
    expect(existsSync(h.worktree)).toBe(false);
  });

  it('only reports when it cannot fetch, and finishes with what it has', async () => {
    const h = setup(merged);
    await started(h);
    h.git(['remote', 'set-url', 'origin', join(dirname(h.root), 'gone.git')]);

    await run(h, 'finish', '5');

    expect(has(h.calls, 'merge')).toBe(false);
    expect(h.out.join('\n')).toContain('main checkout not updated: git fetch origin main failed');
    expect(existsSync(h.worktree)).toBe(false);
    expect(process.exitCode).toBe(exitCode);
  });

  it('keeps a branch git will not delete, says so, and exits 0', async () => {
    const h = setup(merged);
    await started(h);
    commitInWorktree(h);
    // A squash merge: origin/main moved on, but without this branch's commit.
    writeFileSync(join(h.root, 'squashed.txt'), 'x\n');
    h.git(['add', '-A']);
    h.git(['commit', '-q', '-m', 'feat: login (squashed)']);
    h.git(['push', '-q', 'origin', 'main']);

    await run(h, 'finish', '5');

    expect(h.err).toEqual([]);
    expect(process.exitCode).toBe(exitCode);
    expect(h.calls).toContainEqual(['branch', '-d', BRANCH]);
    expect(h.out.join('\n')).toContain(
      `branch ${BRANCH} kept: git branch -d refused (squash merge?); check it and delete it yourself`,
    );
    expect(existsSync(h.worktree)).toBe(false);
    expect(branches(h)).toEqual([BRANCH]);
    expectNoDestructiveGit(h.calls);
  });

  it('reports a worktree git will not remove, and leaves the branch alone', async () => {
    const h = setup(merged);
    await started(h);
    h.git(['worktree', 'lock', '--reason', 'in use', h.worktree]);

    await run(h, 'finish', '5');

    expect(process.exitCode).toBe(1);
    expect(h.err[0]).toContain('git worktree remove failed');
    expect(h.err[0]).toContain('locked');
    expect(has(h.calls, 'branch', '-d')).toBe(false);
    expect(existsSync(h.worktree)).toBe(true);
    expectNoDestructiveGit(h.calls);
  });

  it('finishes a worktree whose directory is already gone, without looking at its changes', async () => {
    const h = setup(merged);
    await started(h);
    rmSync(h.worktree, { recursive: true });

    await run(h, 'finish', '5');

    expect(h.err).toEqual([]);
    expect(h.calls.some(call => call[0] === '-C')).toBe(false);
    expect(h.calls).toContainEqual(['worktree', 'remove', h.worktree]);
    expect(h.git(['worktree', 'list', '--porcelain'])).not.toContain('5-add-login');
    expect(branches(h)).toEqual([]);
    expectNoDestructiveGit(h.calls);
  });

  it('only prints the plan with --dry-run', async () => {
    const h = setup(merged);
    await started(h);

    await run(h, 'finish', '5', '--dry-run');

    expect(h.err).toEqual([]);
    expect(process.exitCode).toBe(exitCode);
    for (const writing of [['fetch'], ['merge'], ['worktree', 'remove'], ['branch', '-d']]) {
      expect(has(h.calls, ...writing), `ran git ${writing.join(' ')}`).toBe(false);
    }
    expect(existsSync(h.worktree)).toBe(true);
    expect(branches(h)).toEqual([BRANCH]);
    const text = h.out[0] as string;
    expect(text).toMatch(/would/i);
    expect(text).toContain('git merge --ff-only origin/main');
    expect(text).toContain(`git worktree remove ${h.worktree}`);
    expect(text).toContain(`git branch -d ${BRANCH}`);
  });

  it('refuses with --dry-run for the same reasons', async () => {
    const h = setup();
    await started(h);

    await run(h, 'finish', '5', '--dry-run');

    expect(h.err).toEqual(['#5 has no merged PR yet']);
    expect(process.exitCode).toBe(1);
  });

  it('leaves the merge out of a dry-run plan when the main checkout would not be updated', async () => {
    const h = setup(merged);
    await started(h);
    h.git(['checkout', '-q', '-b', 'scratch']);

    await run(h, 'finish', '5', '--dry-run');

    const text = h.out[0] as string;
    expect(text).not.toContain('git merge');
    expect(text).toContain('main checkout not updated: it is on scratch, not main');
  });

  it('prints the result as JSON with --json', async () => {
    const h = setup(merged);
    await started(h);
    commitInWorktree(h);
    h.git(['push', '-q', 'origin', 'HEAD:main'], h.worktree);

    await run(h, 'finish', '5', '--json');

    expect(JSON.parse(h.out[0] as string)).toMatchObject({
      issue: 5,
      branch: BRANCH,
      path: h.worktree,
      dryRun: false,
      mainCheckoutUpdated: true,
      worktreeRemoved: true,
      branchDeleted: true,
      notes: expect.any(Array),
    });
  });

  it('says in the JSON that the branch was kept', async () => {
    const h = setup(merged);
    await started(h);
    commitInWorktree(h);
    writeFileSync(join(h.root, 'squashed.txt'), 'x\n');
    h.git(['add', '-A']);
    h.git(['commit', '-q', '-m', 'squashed']);
    h.git(['push', '-q', 'origin', 'main']);

    await run(h, 'finish', '5', '--json');

    expect(JSON.parse(h.out[0] as string)).toMatchObject({ worktreeRemoved: true, branchDeleted: false });
  });

  it('never runs a destructive git command, whatever the state', async () => {
    for (const prepare of [
      (h: Harness) => commitInWorktree(h),
      (h: Harness) => writeFileSync(join(h.worktree, 'dirty.txt'), 'x\n'),
      (h: Harness) => h.git(['worktree', 'lock', h.worktree]),
    ]) {
      const h = setup(merged);
      await started(h);
      prepare(h);

      await run(h, 'finish', '5');
      await run(h, 'finish', '5', '--dry-run');

      expectNoDestructiveGit(h.calls);
    }
  });
});

describe('the worktree command from the real program', () => {
  /** Runs `sdlc <args>` through `runCli` with the process believed to be in `cwd`. */
  async function runIn(h: Harness, cwd: string, ...args: string[]): Promise<void> {
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    await runCli(args, {
      makeContext: () => ({
        tracker: h.tracker,
        cfg,
        now: () => NOW,
        out: data => h.out.push(String(data)),
        err: text => h.err.push(text),
      }),
      out: text => h.out.push(text),
      err: text => h.err.push(text),
    });
  }

  it('creates the worktree under the main checkout when it runs from a linked worktree', async () => {
    const h = setup(merged);
    h.tracker.seedTask(taskState(6), { title: 'Second' });
    await started(h);

    await runIn(h, h.worktree, 'worktree', 'start', '6');

    expect(h.err).toEqual([]);
    expect(existsSync(join(h.root, '.worktrees', '6-second', 'README.md'))).toBe(true);
    expect(existsSync(join(h.worktree, '.worktrees'))).toBe(false);
    expect(h.out[0]).toContain(join(h.root, '.worktrees', '6-second'));
  });

  it('refuses to finish the worktree it runs in', async () => {
    const h = setup(merged);
    await started(h);

    await runIn(h, h.worktree, 'worktree', 'finish', '5');

    expect(process.exitCode).toBe(1);
    expect(h.err[0]).toContain('from the main checkout');
    expect(existsSync(h.worktree)).toBe(true);
  });

  it('finishes from the main checkout', async () => {
    const h = setup(merged);
    await started(h);

    await runIn(h, h.root, 'worktree', 'finish', '5');

    expect(h.err).toEqual([]);
    expect(existsSync(h.worktree)).toBe(false);
  });

  it.each(['worktree start', 'worktree finish'])('does not queue %s for sync', async path => {
    expect(isQueueableCommandPath(path)).toBe(false);
  });

  it('fails as any other command when GitHub cannot be reached', async () => {
    const h = setup(merged);
    h.tracker.failNext('getTask');

    await runIn(h, h.root, 'worktree', 'start', '5');

    expect(process.exitCode).toBe(1);
    expect(h.err[0]).toContain('getTask');
    expect(has(h.calls, 'worktree', 'add')).toBe(false);
  });
});
