import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitRunner, type GitRunner } from '../../src/install/provision.js';
import { checkoutOf, mainRootOf, realPathOf } from '../../src/hooks/resolve.js';
import { CASE_INSENSITIVE_FS, recased } from '../support/caseFs.js';
import { createTestRepo, type TestRepo } from '../support/gitRepo.js';

let repo: TestRepo;
let plain: string | undefined;
/** The repository root as git reports it (the temp directory is a symlink on macOS). */
let root: string;
const gitFor = (cwd: string): GitRunner => createGitRunner(cwd);

beforeEach(() => {
  repo = createTestRepo();
  repo.write('README.md', 'x\n');
  repo.commit('init');
  root = realpathSync(repo.root);
});
afterEach(() => {
  repo.cleanup();
  if (plain !== undefined) rmSync(plain, { recursive: true, force: true });
  plain = undefined;
  vi.unstubAllEnvs();
});

describe('checkoutOf', () => {
  it('resolves a worktree under .worktrees to its own root, branch and issue, whatever the caller runs in', async () => {
    repo.git('worktree', 'add', '-q', '-b', 'task/7-x', '.worktrees/7-x');

    const checkout = await checkoutOf(join(repo.root, '.worktrees', '7-x', 'src'), gitFor);

    expect(checkout).toEqual({
      root: join(root, '.worktrees', '7-x'),
      commonDir: join(root, '.git'),
      branch: 'task/7-x',
      issue: 7,
    });
  });

  it('gives the main checkout and a worktree the same common dir', async () => {
    repo.git('worktree', 'add', '-q', '-b', 'task/7-x', '.worktrees/7-x');

    const main = await checkoutOf(repo.root, gitFor);
    const worktree = await checkoutOf(join(repo.root, '.worktrees', '7-x'), gitFor);

    expect(main?.root).toBe(root);
    expect(main?.commonDir).toBe(worktree?.commonDir);
    expect(main?.root).not.toBe(worktree?.root);
  });

  it('has an issue only on a task branch', async () => {
    const main = await checkoutOf(repo.root, gitFor);
    expect(main).toEqual({ root, commonDir: join(root, '.git'), branch: 'main' });
    expect(main).not.toHaveProperty('issue');
  });

  it('leaves branch and issue out on a detached HEAD', async () => {
    repo.git('checkout', '-q', '--detach');

    const checkout = await checkoutOf(repo.root, gitFor);

    expect(checkout).toEqual({ root, commonDir: join(root, '.git') });
  });

  it('resolves through the nearest existing ancestor when the directories do not exist yet', async () => {
    const checkout = await checkoutOf(join(repo.root, 'src', 'not', 'there', 'yet'), gitFor);

    expect(checkout?.root).toBe(root);
  });

  it('resolves through the directory of a path that is a file', async () => {
    repo.write('src/a.ts', 'x\n');

    const checkout = await checkoutOf(join(repo.root, 'src', 'a.ts'), gitFor);

    expect(checkout?.root).toBe(root);
  });

  describe('a symbolic-ref that does not answer', () => {
    /** Real git, except `symbolic-ref`, which gives `result`. */
    const withSymbolicRef =
      (result: { stdout: string; code: number; stderr: string }) =>
      (cwd: string): GitRunner => {
        const real = createGitRunner(cwd);
        return args => (args[0] === 'symbolic-ref' ? Promise.resolve(result) : real(args));
      };

    it('is unresolved when git was killed, not a detached HEAD', async () => {
      // How createGitRunner reports a killed git: code 1 and "terminated by <signal>".
      const killed = withSymbolicRef({ stdout: '', code: 1, stderr: 'terminated by SIGTERM' });

      expect(await checkoutOf(repo.root, killed)).toBeUndefined();
    });

    it('is unresolved when git fails for any other reason', async () => {
      const failed = withSymbolicRef({ stdout: '', code: 128, stderr: 'fatal: bad object HEAD' });

      expect(await checkoutOf(repo.root, failed)).toBeUndefined();
    });

    it('is a detached HEAD only on git\'s own answer: exit 1 and nothing said', async () => {
      const detached = withSymbolicRef({ stdout: '', code: 1, stderr: '' });

      expect(await checkoutOf(repo.root, detached)).toEqual({ root, commonDir: join(root, '.git') });
    });
  });

  it('gives undefined for a directory outside any repository', async () => {
    plain = mkdtempSync(join(tmpdir(), 'sdlc-plain-'));

    expect(await checkoutOf(join(plain, 'not', 'there'), gitFor)).toBeUndefined();
  });

  it('runs git in the nearest existing directory, with the documented argument lists', async () => {
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const spy = (cwd: string): GitRunner => {
      const real = createGitRunner(cwd);
      return args => {
        calls.push({ cwd, args });
        return real(args);
      };
    };

    await checkoutOf(join(repo.root, 'a', 'b'), spy);

    expect(calls.map(call => call.args)).toEqual([
      ['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir'],
      ['symbolic-ref', '--short', '-q', 'HEAD'],
    ]);
    expect(calls[0]?.cwd).toBe(realpathSync(repo.root));
  });
});

describe('realPathOf', () => {
  it('resolves symlinks in the existing part and keeps the part that does not exist', () => {
    mkdirSync(join(repo.root, 'src'));
    writeFileSync(join(repo.root, 'src', 'a.ts'), 'x\n');

    expect(realPathOf(join(repo.root, 'src', 'a.ts'))).toBe(join(root, 'src', 'a.ts'));
    expect(realPathOf(join(repo.root, 'src', 'new', 'deep', 'b.ts'))).toBe(join(root, 'src', 'new', 'deep', 'b.ts'));
  });
});

describe('realPathOf: letter case', () => {
  it.skipIf(!CASE_INSENSITIVE_FS)('gives a path the case it has on disk, which is how git reports it', async () => {
    const other = recased('repo') as string;
    const miscased = join(dirname(repo.root), other, 'src', 'a.ts');

    expect(realPathOf(miscased)).toBe(join(root, 'src', 'a.ts'));
    // Git and the path now agree on the checkout root, so the path sits under it.
    const checkout = await checkoutOf(dirname(realPathOf(miscased)), gitFor);
    expect(realPathOf(miscased).startsWith(`${checkout?.root}/`)).toBe(true);
  });
});

describe('mainRootOf', () => {
  it('is the root of the main checkout, also from one of its worktrees', async () => {
    repo.git('worktree', 'add', '-q', '-b', 'task/7-x', '.worktrees/7-x');

    const main = await checkoutOf(repo.root, gitFor);
    const worktree = await checkoutOf(join(repo.root, '.worktrees', '7-x'), gitFor);

    expect(main && mainRootOf(main)).toBe(root);
    expect(worktree && mainRootOf(worktree)).toBe(root);
  });

  it('falls back to the checkout root when the common directory is not a `.git` directory (a bare repository)', () => {
    expect(mainRootOf({ root: '/work/wt', commonDir: '/srv/shop.git' })).toBe('/work/wt');
  });
});
