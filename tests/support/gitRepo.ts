import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';

/**
 * The environment of every real git run in a test: none of the developer's own git settings (a
 * global `commit.gpgsign` or `core.hooksPath`, a `GIT_DIR` inherited from a hook this test run is
 * itself inside of) can reach it. Same as `isolatedEnv` in tests/cli.test.ts.
 */
export function isolatedEnv(home: string, path = process.env.PATH ?? ''): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  mkdirSync(home, { recursive: true });
  return {
    ...env,
    PATH: path,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

/** A throwaway repository on `main` and the way to run git in it; call `cleanup` when done. */
export interface TestRepo {
  root: string;
  env: NodeJS.ProcessEnv;
  git(...args: string[]): string;
  write(path: string, content: string): void;
  commit(message: string): void;
  cleanup(): void;
}

/**
 * Creates the repository, and makes the process itself use the isolated environment (the code
 * under test spawns `git` with `process.env`); the stubs are undone by `vi.unstubAllEnvs()`.
 */
export function createTestRepo(): TestRepo {
  const base = mkdtempSync(join(tmpdir(), 'sdlc-repo-'));
  const root = join(base, 'repo');
  const env = isolatedEnv(join(base, 'home'));
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) vi.stubEnv(key, undefined);
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) vi.stubEnv(key, env[key]);
  mkdirSync(root);
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  return {
    root,
    env,
    git,
    write: (path, content) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    },
    commit: message => {
      git('add', '-A');
      git('commit', '-q', '-m', message);
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
