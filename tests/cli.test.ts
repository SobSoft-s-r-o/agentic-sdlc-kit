import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatCliError, runCli } from '../src/cli.js';
import type { CommandContext } from '../src/commands/context.js';
import { loadConfig, typeRegistry } from '../src/config/schema.js';
import { renderGitHooks } from '../src/render/github.js';
import { newTask } from '../src/core/stateMachine.js';
import { GhError, type GhRunner } from '../src/github/gh.js';
import { FakeTracker } from './support/fakeTracker.js';
import { githubToken } from './support/secrets.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(root, 'dist', 'cli.js');
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
const validConfig = join(root, 'tests', 'fixtures', 'config', 'valid.yaml');

const COMMANDS = ['task', 'stage', 'evidence', 'review', 'approve', 'deploy', 'reconcile', 'status', 'sync', 'board', 'config', 'githook', 'hook', 'init', 'upgrade', 'uninstall', 'doctor'];

let dir: string;
beforeAll(() => {
  // The spawned CLI is the built one, so build it here instead of trusting a stale `dist`.
  execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', root], {
    cwd: root,
    stdio: 'pipe',
  });
}, 120_000);
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sdlc-cli-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Spawned {
  status: number | null;
  stdout: string;
  stderr: string;
}

function sdlc(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; script?: string; input?: string } = {},
): Spawned {
  const result = spawnSync(process.execPath, [options.script ?? cliPath, ...args], {
    cwd: options.cwd ?? dir,
    env: options.env ?? process.env,
    input: options.input,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** An environment where `gh` cannot be found. */
const withoutGh: NodeJS.ProcessEnv = { ...process.env, PATH: '' };

describe('cli (built)', () => {
  it('cli --help lists every command', () => {
    const result = sdlc(['--help']);

    expect(result.status).toBe(0);
    for (const command of COMMANDS) expect(result.stdout).toMatch(new RegExp(`^\\s+${command}\\b`, 'm'));
  });

  it('starts with a node shebang', () => {
    expect(readFileSync(cliPath, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node');
  });

  it('--help and --version work without a config file and without gh', () => {
    const help = sdlc(['--help'], { env: withoutGh });
    const versionResult = sdlc(['--version'], { env: withoutGh });

    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--config');
    expect(versionResult.status).toBe(0);
    expect(versionResult.stdout.trim()).toBe(version);
  });

  it('runs through a symlink, like the installed bin', () => {
    const link = join(dir, 'sdlc');
    symlinkSync(cliPath, link);

    const result = sdlc(['--version'], { script: link });

    expect(result.stdout.trim()).toBe(version);
  });

  it('shows a command help without a config file', () => {
    const result = sdlc(['status', '--help'], { env: withoutGh });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--stale-days');
  });

  it('fails clearly outside a git repository unless --config is given', () => {
    const result = sdlc(['status']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('git repository');
    expect(result.stderr).toContain('--config');
  });

  it('with --config outside a git repository, gets as far as reading the config', () => {
    const missing = join(dir, 'nope.yaml');

    const result = sdlc(['--config', missing, 'status']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Cannot read config file ${missing}`);
    expect(result.stderr).not.toContain('git repository');
  });

  it('reads sdlc.config.yaml from the git root, also when run from a subdirectory', () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(join(dir, 'sub'));
    const result = sdlc(['status'], { cwd: join(dir, 'sub') });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(realpathSync(dir), 'sdlc.config.yaml'));
  });

  it('prints a JSON error with --json when the config cannot be read', () => {
    const missing = join(dir, 'nope.yaml');

    const result = sdlc(['--json', '--config', missing, 'status']);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ error: expect.stringContaining('Cannot read config file') });
  });

  it('config validate reads --config and needs neither a git repository nor gh', () => {
    const result = sdlc(['--config', validConfig, 'config', 'validate'], { env: withoutGh });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('Config OK');
  });

  it('config validate lists the issues and exits 1', () => {
    const bad = join(dir, 'bad.yaml');
    writeFileSync(bad, readFileSync(validConfig, 'utf8').replace('version: 1', 'version: 1\nreconcile: { closed_lookback_days: 0 }'));

    const result = sdlc(['--config', bad, 'config', 'validate'], { env: withoutGh });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('reconcile.closed_lookback_days');
  });

  it('config suggest --write keeps an existing sdlc.config.yaml in the git root', () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, 'sdlc.config.yaml'), 'keep: me\n');
    mkdirSync(join(dir, 'sub'));

    // The real environment: git must be found to resolve the root. gh is never reached.
    const result = sdlc(['config', 'suggest', '--write'], { cwd: join(dir, 'sub') });

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('sdlc.config.yaml exists; edit it instead');
    expect(readFileSync(join(dir, 'sdlc.config.yaml'), 'utf8')).toBe('keep: me\n');
  });

  it('config suggest without gh fails with the gh error, not a stack trace', () => {
    const result = sdlc(['config', 'suggest'], { env: withoutGh });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('gh CLI not found');
  });

  it('doctor needs no config, git or gh: it reports what is missing as checks, exits 1 and prints JSON with --json', () => {
    const result = sdlc(['doctor', '--json'], { env: withoutGh });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as { checks: Array<{ id: string; status: string }>; ok: boolean };
    expect(report.ok).toBe(false);
    expect(report.checks.map(check => check.id)).toEqual([
      'git.repo',
      'node.version',
      'gh.installed',
      'gh.auth',
      'gh.scopes',
      'repo.remote',
      'repo.instructionFiles',
      'config.present',
    ]);
    const status = Object.fromEntries(report.checks.map(check => [check.id, check.status]));
    expect(status).toMatchObject({ 'git.repo': 'fail', 'node.version': 'ok', 'gh.installed': 'fail', 'config.present': 'warn' });
  });

  it('doctor prints the checks with a mark each, and its fix', () => {
    const result = sdlc(['doctor', '--preflight'], { env: withoutGh });

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^✗ gh\.installed: gh CLI not found\n {2}fix: install the GitHub CLI: https:\/\/cli\.github\.com$/m);
    expect(result.stdout).toMatch(/^✓ node\.version: /m);
    expect(result.stdout).toMatch(/^! config\.present: .*\n {2}fix: run sdlc config suggest$/m);
  });

  it('rejects an unknown command', () => {
    const result = sdlc(['frobnicate']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown command');
  });
});

describe('sdlc githook (built)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * The environment of every git (and sdlc) run in these tests, with `path` as the PATH: none of the
   * developer's own git settings (a global `commit.gpgsign` or `core.hooksPath`, a `GIT_DIR` inherited
   * from a hook this test run is itself inside of) can reach it.
   */
  function isolatedEnv(path: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
    const home = join(dir, 'home');
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

  /** A fresh repository on `main` with the valid test config in the given mode. */
  function repo(mode: 'observe' | 'enforce'): string {
    const root = join(dir, 'repo');
    const env = isolatedEnv(process.env.PATH ?? '');
    mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root, env });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: root, env });
    writeFileSync(join(root, 'sdlc.config.yaml'), readFileSync(validConfig, 'utf8').replace('mode: observe', `mode: ${mode}`));
    return root;
  }

  /** A PATH that finds git (and `cat`, which pre-push uses to keep its stdin) and nothing else, so no hook can reach `gh` and the real GitHub. */
  function onlyGit(): NodeJS.ProcessEnv {
    const bin = join(dir, 'only-git');
    if (!existsSync(bin)) {
      mkdirSync(bin);
      for (const tool of ['git', 'cat']) {
        symlinkSync(execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), join(bin, tool));
      }
    }
    return isolatedEnv(bin);
  }

  /** An empty commit in `root` (hooks are not installed yet); returns its sha. */
  function commitEmpty(root: string): string {
    const env = isolatedEnv(process.env.PATH ?? '');
    const args = ['-c', 'user.name=Test', '-c', 'user.email=test@example.test'];
    execFileSync('git', [...args, 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: root, env });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env, encoding: 'utf8' }).trim();
  }

  /** Installs the rendered hook scripts in `root`; returns the environment to run git in (it finds `sdlc` and git only). */
  function installRenderedHooks(root: string): NodeJS.ProcessEnv {
    const hooks = join(root, '.sdlc', 'githooks');
    mkdirSync(hooks, { recursive: true });
    for (const change of renderGitHooks()) {
      if (change.kind !== 'file') throw new Error('hooks are files');
      writeFileSync(join(root, change.path), change.content, { mode: change.mode });
    }
    execFileSync('git', ['config', 'core.hooksPath', '.sdlc/githooks'], { cwd: root, env: isolatedEnv(process.env.PATH ?? '') });
    const env = onlyGit();
    // The scripts find `sdlc` on the PATH, as they do for an installed package.
    writeFileSync(join(dir, 'only-git', 'sdlc'), `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" "$@"\n`, { mode: 0o755 });
    return env;
  }

  /** Real git in `root` with `env`: `git` gives the result, `mustGit` the output or an error. */
  function gitIn(root: string, env: NodeJS.ProcessEnv) {
    const git = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], { cwd: root, env, encoding: 'utf8' });
    const mustGit = (...args: string[]): string => {
      const result = git(...args);
      if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      return result.stdout.trim();
    };
    return { git, mustGit };
  }

  it('pre-commit on the default branch warns in observe mode and blocks in enforce mode', () => {
    const warned = sdlc(['githook', 'pre-commit'], { cwd: repo('observe'), env: onlyGit() });
    rmSync(join(dir, 'repo'), { recursive: true });
    const blocked = sdlc(['githook', 'pre-commit'], { cwd: repo('enforce'), env: onlyGit() });

    expect(warned.status).toBe(0);
    expect(warned.stderr.trim()).toBe(
      'sdlc: warning: committing directly to main; work on a task branch (task/<issue>-<slug>)',
    );
    expect(blocked.status).toBe(1);
    expect(blocked.stderr.trim()).toBe(
      'sdlc: error: committing directly to main; work on a task branch (task/<issue>-<slug>)',
    );
  });

  it('pre-push reads the updates from stdin', () => {
    const root = repo('enforce');
    const update = `refs/heads/work ${commitEmpty(root)} refs/heads/main ${'0'.repeat(40)}\n`;

    const result = sdlc(['githook', 'pre-push', 'origin', 'git@example.test:acme/shop.git'], {
      cwd: root,
      env: onlyGit(),
      input: update,
    });

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(
      'sdlc: error: pushing directly to main; work on a task branch (task/<issue>-<slug>)',
    );
  });

  it('a missing config warns and exits 0 when nothing is staged: the branch rules are skipped, the guard is not', () => {
    const root = repo('enforce');
    rmSync(join(root, 'sdlc.config.yaml'));

    const result = sdlc(['githook', 'pre-commit'], { cwd: root, env: onlyGit() });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('sdlc: warning: sdlc.config.yaml could not be loaded (Cannot read config file');
    expect(result.stderr).toContain('branch rules skipped, secret guard still active');
  });

  it('a missing config does not switch the guard off: a staged secret still blocks', () => {
    const root = repo('enforce');
    rmSync(join(root, 'sdlc.config.yaml'));
    const env = onlyGit();
    const token = githubToken();
    writeFileSync(join(root, 'app.ts'), `const t = "${token}";\n`);
    execFileSync('git', ['add', 'app.ts'], { cwd: root, env });

    const result = sdlc(['githook', 'pre-commit'], { cwd: root, env });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('branch rules skipped, secret guard still active');
    expect(result.stderr).toContain('sdlc secret guard: commit blocked');
    expect(result.stderr).toContain('app.ts:1 github-token ghp_…(40 chars)');
    expect(result.stderr).not.toContain(token);
  });

  it('outside a git repository the guard cannot scan, so it blocks (fails closed)', () => {
    const result = sdlc(['githook', 'pre-commit'], { env: onlyGit() });

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toMatch(/^sdlc secret guard: could not scan \(git diff failed: .+\); commit blocked$/);
  });

  it.each(['observe', 'enforce'] as const)('%s: a staged secret blocks the commit and only a masked match is printed', mode => {
    const root = repo(mode);
    const env = onlyGit();
    const token = githubToken();
    execFileSync('git', ['checkout', '-q', '-b', 'task/1-first'], { cwd: root, env });
    writeFileSync(join(root, 'app.ts'), `const a = 1;\nconst t = "${token}";\n`);
    writeFileSync(join(root, '.env.local'), 'A=1\n');
    execFileSync('git', ['add', 'app.ts', '.env.local'], { cwd: root, env });

    const result = sdlc(['githook', 'pre-commit'], { cwd: root, env });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    const lines = result.stderr.trim().split('\n');
    expect(lines[0]).toBe('sdlc secret guard: commit blocked');
    expect(lines.filter(line => line.startsWith('app.ts:2 github-token ghp_…(40 chars) (fingerprint '))).toHaveLength(1);
    expect(lines.filter(line => line.startsWith('.env.local env-file .env.local (fingerprint '))).toHaveLength(1);
    expect(lines.at(-1)).toContain('sdlc:allow-secret');
    expect(result.stderr).not.toContain(token);
    expect(result.stderr).not.toContain(token.slice(0, 8));
  });

  it('a push of an object git does not have cannot be scanned, so it is blocked', () => {
    const root = repo('observe');
    const update = `refs/heads/work ${'a'.repeat(40)} refs/heads/topic ${'0'.repeat(40)}\n`;

    const result = sdlc(['githook', 'pre-push', 'origin', 'x'], { cwd: root, env: onlyGit(), input: update });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('sdlc secret guard: could not scan (git log failed: ');
    expect(result.stderr).toContain('); push blocked');
  });

  it('the rendered scripts work under real git: a commit on main warns or blocks, one on a task branch passes', () => {
    // The developer's own settings must not matter: a signing requirement, a foreign hooks path, an inherited GIT_DIR.
    const hostile = join(dir, 'hostile-gitconfig');
    writeFileSync(hostile, '[commit]\n\tgpgsign = true\n[core]\n\thooksPath = /nonexistent\n');
    vi.stubEnv('GIT_CONFIG_GLOBAL', hostile);
    vi.stubEnv('GIT_DIR', join(dir, 'not-a-repository'));
    vi.stubEnv('GIT_INDEX_FILE', join(dir, 'not-an-index'));
    const root = repo('enforce');
    const env = installRenderedHooks(root);
    const commit = () =>
      spawnSync(
        'git',
        ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'x'],
        { cwd: root, env, encoding: 'utf8' },
      );

    const onMain = commit();
    execFileSync('git', ['checkout', '-q', '-b', 'task/1-first'], { cwd: root, env });
    const onTask = commit();

    expect(onMain.status).toBe(1);
    expect(onMain.stderr).toContain('sdlc: error: committing directly to main');
    expect(onTask.status).toBe(0);
    expect(onTask.stderr).toBe('');
  }, 30_000);

  it('the rendered scripts chain the legacy .git/hooks/pre-commit under real git: it runs after sdlc, and its failure blocks the commit', () => {
    const root = repo('enforce');
    const env = installRenderedHooks(root);
    const { git, mustGit } = gitIn(root, env);
    mustGit('checkout', '-q', '-b', 'task/1-first');
    const legacy = join(root, '.git', 'hooks', 'pre-commit');
    mkdirSync(dirname(legacy), { recursive: true });

    writeFileSync(legacy, '#!/bin/sh\necho "legacy pre-commit refused" >&2\nexit 1\n', { mode: 0o755 });
    const refused = git('commit', '--allow-empty', '-m', 'refused');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('legacy pre-commit refused');
    expect(git('rev-parse', '--verify', '-q', 'HEAD').status).not.toBe(0);

    writeFileSync(legacy, '#!/bin/sh\necho "legacy pre-commit ran" >&2\nexit 0\n', { mode: 0o755 });
    const passed = git('commit', '--allow-empty', '-m', 'passed');
    expect(passed.status).toBe(0);
    expect(passed.stderr).toContain('legacy pre-commit ran');
    expect(mustGit('rev-list', '--count', 'HEAD')).toBe('1');

    // The sdlc step runs first and decides on its own: on main in enforce mode it blocks before the legacy hook runs.
    mustGit('checkout', '-q', '-b', 'main');
    const onMain = git('commit', '--allow-empty', '-m', 'on main');
    expect(onMain.status).toBe(1);
    expect(onMain.stderr).toContain('sdlc: error: committing directly to main');
    expect(onMain.stderr).not.toContain('legacy pre-commit ran');
  }, 30_000);

  it('the rendered scripts block a secret under real git, in observe mode: the commit, then the push of a history that holds it', () => {
    const root = repo('observe');
    const remote = join(dir, 'remote.git');
    const token = githubToken();
    const env = installRenderedHooks(root);
    const { git, mustGit } = gitIn(root, env);
    const remoteRefs = () => execFileSync('git', ['for-each-ref', '--format=%(refname)'], { cwd: remote, env, encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '-q', '--bare', remote], { env });
    mustGit('remote', 'add', 'origin', remote);

    // A clean commit and push pass (the observe-mode warnings about main are not blocks).
    expect(git('commit', '--allow-empty', '-m', 'base').status).toBe(0);
    const cleanPush = git('push', 'origin', 'main');
    expect(cleanPush.status).toBe(0);
    expect(remoteRefs()).toBe('refs/heads/main');

    // The commit with a staged token is refused, and nothing is committed.
    mustGit('checkout', '-q', '-b', 'task/1-leak');
    writeFileSync(join(root, 'app.ts'), `export const t = "${token}";\n`);
    mustGit('add', 'app.ts');
    const refused = git('commit', '-m', 'leak');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('sdlc secret guard: commit blocked');
    expect(refused.stderr).toContain('app.ts:1 github-token ghp_…(40 chars)');
    expect(refused.stderr).not.toContain(token);
    expect(mustGit('rev-list', '--count', 'HEAD')).toBe('1');

    // --no-verify skips the pre-commit hook (a git feature), but the pre-push hook still stops the push.
    expect(git('commit', '--no-verify', '-m', 'leak').status).toBe(0);
    const pushed = git('push', 'origin', 'task/1-leak');
    expect(pushed.status).not.toBe(0);
    expect(pushed.stderr).toContain('sdlc secret guard: push blocked');
    expect(pushed.stderr).toContain('app.ts:1 github-token ghp_…(40 chars)');
    expect(pushed.stderr).not.toContain(token);
    expect(remoteRefs()).toBe('refs/heads/main');

    // Deleting the file in a later commit does not help: the pushed history still holds the secret.
    mustGit('rm', '-q', 'app.ts');
    expect(git('commit', '-m', 'remove it').status).toBe(0);
    expect(git('push', 'origin', 'task/1-leak').status).not.toBe(0);
    expect(remoteRefs()).toBe('refs/heads/main');

    // A line that says so is let through, commit and push.
    mustGit('checkout', '-q', '-b', 'task/2-allowed', 'main');
    writeFileSync(join(root, 'fixture.ts'), `export const t = "${token}"; // sdlc:allow-secret\n`);
    mustGit('add', 'fixture.ts');
    expect(git('commit', '-m', 'fixture').status).toBe(0);
    expect(git('push', 'origin', 'task/2-allowed').status).toBe(0);
    expect(remoteRefs()).toBe('refs/heads/main\nrefs/heads/task/2-allowed');
  }, 30_000);

  it('git settings that change what a diff shows cannot hide a secret from the rendered hooks: root commit, textconv, type change', () => {
    const root = repo('observe');
    const remote = join(dir, 'remote.git');
    const token = githubToken();
    const env = installRenderedHooks(root);
    const { git, mustGit } = gitIn(root, env);
    execFileSync('git', ['init', '-q', '--bare', remote], { env });
    mustGit('remote', 'add', 'origin', remote);
    mustGit('config', 'log.showRoot', 'false');
    mustGit('config', 'diff.mnemonicPrefix', 'true');
    mustGit('config', 'diff.hide.textconv', 'echo hidden');

    // A root commit made with --no-verify: the push of it is refused although log.showRoot is false.
    writeFileSync(join(root, '.gitattributes'), '*.txt diff=hide\n');
    writeFileSync(join(root, 'app.ts'), `export const t = "${token}";\n`);
    mustGit('add', '.gitattributes', 'app.ts');
    expect(git('commit', '--no-verify', '-m', 'root').status).toBe(0);
    const pushed = git('push', 'origin', 'main');
    expect(pushed.status).not.toBe(0);
    expect(pushed.stderr).toContain('sdlc secret guard: push blocked');
    expect(pushed.stderr).toContain('app.ts:1 github-token ghp_…(40 chars)');
    expect(pushed.stderr).not.toContain(token);
    expect(execFileSync('git', ['for-each-ref'], { cwd: remote, env, encoding: 'utf8' })).toBe('');

    // A textconv driver on *.txt would print "hidden" instead of the file: the commit is still refused.
    mustGit('checkout', '-q', '-b', 'task/1-text');
    writeFileSync(join(root, 'notes.txt'), `token = "${token}"\n`);
    mustGit('add', 'notes.txt');
    const text = git('commit', '-m', 'notes');
    expect(text.status).toBe(1);
    expect(text.stderr).toContain('notes.txt:1 github-token ghp_…(40 chars)');
    mustGit('reset', '-q', '--', 'notes.txt');
    rmSync(join(root, 'notes.txt'));

    // A symlink that becomes a file with a token is a type change, and it is scanned.
    symlinkSync('target', join(root, 'link'));
    mustGit('add', 'link');
    expect(git('commit', '-m', 'a link').status).toBe(0);
    rmSync(join(root, 'link'));
    writeFileSync(join(root, 'link'), `export const t = "${token}";\n`);
    mustGit('add', 'link');
    const typeChange = git('commit', '-m', 'a file');
    expect(typeChange.status).toBe(1);
    expect(typeChange.stderr).toContain('link:1 github-token ghp_…(40 chars)');
    expect(typeChange.stderr).not.toContain(token);
  }, 30_000);

  it('a hook gives up a hanging tracker call at its deadline and really exits, though the call is still running', () => {
    // The tracker call is a real child process that outlives the 100 ms deadline by seconds.
    const script = `
      import { execFile } from 'node:child_process';
      const { runGitHook, exitAfterFlush } = await import(process.argv[1]);
      const ctx = {
        repoRoot: '/repo',
        git: async () => ({ stdout: 'main\\n', stderr: '', code: 0 }),
        loadConfig: () => ({ mode: 'enforce', github: { defaultBranch: 'main' } }),
        makeTracker: () => ({
          getTask: () => new Promise(() => {
            const child = execFile(process.execPath, ['-e', 'setTimeout(() => {}, 4000)']);
            process.stdout.write('child ' + child.pid + '\\n');
          }),
        }),
        readStdin: async () => 'refs/heads/w ' + 'a'.repeat(40) + ' refs/heads/task/12-x ' + '0'.repeat(40) + '\\n',
        spawnReconcile() {},
        out: text => console.log(text),
        err: text => console.error(text),
        timeouts: { prePushMs: 100 },
        exit: code => exitAfterFlush(code),
      };
      process.exitCode = await runGitHook('pre-push', [], ctx);
    `;
    const started = Date.now();

    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, pathToFileURL(join(root, 'dist', 'commands', 'githook.js')).href],
      { encoding: 'utf8', timeout: 20_000 },
    );
    const elapsed = Date.now() - started;
    const pid = /child (\d+)/.exec(result.stdout)?.[1];
    if (pid !== undefined) {
      try {
        process.kill(Number(pid));
      } catch {
        // Already gone.
      }
    }

    expect(result.stderr).toContain('sdlc: warning: could not verify task #12 (timed out after 0.1s); push allowed');
    expect(result.status).toBe(0);
    expect(elapsed).toBeLessThan(3_000);
  });

  it('post-merge on the default branch starts a detached reconcile that logs to .sdlc/cache/reconcile.log', async () => {
    const root = repo('observe');

    const result = sdlc(['githook', 'post-merge', '0'], { cwd: root, env: onlyGit() });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('sdlc: reconcile started in the background (log: .sdlc/cache/reconcile.log)');
    const log = join(root, '.sdlc', 'cache', 'reconcile.log');
    let text = '';
    for (let attempt = 0; attempt < 200 && !text.includes('gh CLI not found'); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
      text = existsSync(log) ? readFileSync(log, 'utf8') : '';
    }
    // The child is the real `sdlc reconcile`; with no gh on its PATH it stops at the first call.
    expect(text).toContain('gh CLI not found');
  });
});

describe('sdlc hook (built)', () => {
  /** No git setting of the developer's own, and no GIT_* variable from a hook this run may be inside of. */
  function hookEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    return { ...env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  }

  /** A repository on `main` with the valid test config in enforce mode (or none). */
  function hookRepo(withConfig = true): string {
    const root = join(dir, 'repo');
    mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root, env: hookEnv() });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: root, env: hookEnv() });
    if (withConfig) {
      writeFileSync(join(root, 'sdlc.config.yaml'), readFileSync(validConfig, 'utf8').replace('mode: observe', 'mode: enforce'));
    }
    return root;
  }

  /** A PATH that finds git and nothing else, so the hook cannot reach `gh` and the real GitHub. */
  function gitOnlyPath(): string {
    const bin = join(dir, 'only-git');
    mkdirSync(bin);
    symlinkSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), join(bin, 'git'));
    return bin;
  }

  const payload = (cwd: string, tool: string, input: Record<string, unknown>): string =>
    JSON.stringify({ session_id: 's1', cwd, tool_name: tool, tool_input: input });

  it('answers a forbidden command with the deny protocol, exit 0, and logs the gap', () => {
    const root = hookRepo();

    const result = sdlc(['hook', 'claude', 'pre-tool'], {
      cwd: root,
      env: hookEnv(),
      input: payload(root, 'Bash', { command: 'gh pr merge 1 --admin' }),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const answer = JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(answer.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(answer.hookSpecificOutput.permissionDecisionReason).toMatch(/^sdlc \(enforce\): /);
    const gaps = readFileSync(join(root, '.sdlc', 'cache', 'gaps.jsonl'), 'utf8').trim().split('\n');
    expect(gaps).toHaveLength(1);
    expect(JSON.parse(gaps[0] as string)).toMatchObject({ rule: 'admin-merge', harness: 'claude', blocked: true });
  });

  it('allows silently an edit that needs no task (docs), without reaching GitHub', () => {
    const root = hookRepo();

    const result = sdlc(['hook', 'codex', 'pre-tool'], {
      cwd: root,
      env: { ...hookEnv(), PATH: gitOnlyPath() },
      input: payload(root, 'apply_patch', { command: '*** Begin Patch\n*** Add File: docs/new.md\n+x\n*** End Patch' }),
    });

    expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
  });

  it.each([
    ['claude', ''],
    ['codex', ''],
    ['gemini', '{}\n'],
  ])('%s: stdin that is not JSON is skipped with one stderr line and exit 0', (harness, stdout) => {
    const result = sdlc(['hook', harness, 'pre-tool'], { cwd: hookRepo(), env: hookEnv(), input: 'not json' });

    expect(result).toEqual({ status: 0, stdout, stderr: 'sdlc: hook skipped: stdin is not valid JSON\n' });
  });

  it('a repository without a config is skipped, exit 0', () => {
    const root = hookRepo(false);

    const result = sdlc(['hook', 'claude', 'pre-tool'], {
      cwd: root,
      env: hookEnv(),
      input: payload(root, 'Bash', { command: 'gh pr merge 1 --admin' }),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^sdlc: hook skipped: no sdlc\.config\.yaml in .+\n$/);
  });

  it.each([
    [['hook', 'bogus', 'pre-tool'], 'unknown harness "bogus"'],
    [['hook', 'claude', 'bogus'], 'unknown event "bogus"'],
    [['hook'], 'unknown harness ""'],
  ])('%j is skipped, exit 0', (args, reason) => {
    const result = sdlc(args, { cwd: hookRepo(), env: hookEnv(), input: '{}' });

    expect(result).toEqual({ status: 0, stdout: '', stderr: `sdlc: hook skipped: ${reason}\n` });
  });

  it('session-start on a branch without a task says so, without reaching GitHub', () => {
    const root = hookRepo();

    const result = sdlc(['hook', 'claude', 'session-start'], {
      cwd: root,
      env: { ...hookEnv(), PATH: gitOnlyPath() },
      input: JSON.stringify({ session_id: 's1', cwd: root, source: 'startup' }),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          'sdlc: mode enforce. No task on branch main. New work starts with `sdlc task new`; status questions use `sdlc status`.',
      },
    });
  });

  it('session-start with queued gaps starts a detached sdlc sync that logs to .sdlc/cache/sync.log', async () => {
    const root = hookRepo();
    mkdirSync(join(root, '.sdlc', 'cache'), { recursive: true });
    // A gap that names no task: the real sync drops it without needing the config or `gh`.
    const gaps = join(root, '.sdlc', 'cache', 'gaps.jsonl');
    writeFileSync(
      gaps,
      `${JSON.stringify({ at: '2026-06-01T00:00:00.000Z', rule: 'no-task', text: 'edit src/a.ts', harness: 'claude', blocked: false })}\n`,
    );

    const result = sdlc(['hook', 'claude', 'session-start'], {
      cwd: root,
      env: { ...hookEnv(), PATH: gitOnlyPath() },
      input: JSON.stringify({ session_id: 's1', cwd: root, source: 'startup' }),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const log = join(root, '.sdlc', 'cache', 'sync.log');
    let text = '';
    for (let attempt = 0; attempt < 200 && text === ''; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
      text = existsSync(log) ? readFileSync(log, 'utf8') : '';
    }
    // The child is the real program started with `sync`: it took the gap file, dropped the gap and gave the lock back.
    expect(text).toContain('Dropped 1 gap(s) that could not be recorded.');
    expect(existsSync(gaps)).toBe(false);
    expect(existsSync(`${gaps}.syncing`)).toBe(false);
    expect(existsSync(join(root, '.sdlc', 'cache', 'sync.lock'))).toBe(false);
  });

  it('a prompt is recorded by its hash, and /approve without a task is told so', () => {
    const root = hookRepo();

    const result = sdlc(['hook', 'claude', 'prompt'], {
      cwd: root,
      env: { ...hookEnv(), PATH: gitOnlyPath() },
      input: JSON.stringify({ session_id: 's1', prompt_id: 'p1', cwd: root, prompt: '/approve\nlooks good' }),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'sdlc: no task on this branch; the approval was not recorded.',
      },
    });
    const lines = readFileSync(join(root, '.sdlc', 'cache', 'prompts.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ harness: 'claude', sessionId: 's1', promptId: 'p1' });
    expect(lines[0]).not.toContain('looks good');
  });
});

describe('runCli', () => {
  const cfg = loadConfig(validConfig);
  const NOW = '2026-06-01T00:00:00.000Z';

  function setup() {
    const tracker = new FakeTracker();
    tracker.owners = [...cfg.owners];
    tracker.seedTask({
      ...newTask({ issue: 1, type: typeRegistry(cfg).get('feature')!, summary: 'Add search', now: NOW }),
      status: 'in_progress',
    });
    const out: unknown[] = [];
    const ctx: CommandContext = { tracker, cfg, now: () => NOW, out: data => out.push(data) };
    const io = { out: [] as string[], err: [] as string[] };
    const deps = { makeContext: () => ctx, out: (t: string) => io.out.push(t), err: (t: string) => io.err.push(t) };
    return { ctx, out, io, deps };
  }

  let exitCode: typeof process.exitCode;
  beforeEach(() => {
    exitCode = process.exitCode;
  });
  afterEach(() => {
    process.exitCode = exitCode;
  });

  const printed = (out: unknown[]): { byStatus: { in_progress: { issue: number }[] } } =>
    JSON.parse(out[0] as string);

  it('treats the global --json like the per-command one', async () => {
    for (const argv of [['--json', 'status'], ['status', '--json'], ['--json', 'status', '--json']]) {
      const h = setup();

      await runCli(argv, h.deps);

      expect(printed(h.out).byStatus.in_progress.map(t => t.issue)).toEqual([1]);
    }
  });

  it('prints human text without --json', async () => {
    const h = setup();

    await runCli(['status'], h.deps);

    expect(h.out[0]).toContain('In progress (1)');
  });

  it('applies the global --json to nested commands too', async () => {
    const h = setup();
    const run: GhRunner = async () => {
      throw new GhError(['api', 'x'], 'boom');
    };

    await runCli(['--json', 'board', 'ensure'], { ...h.deps, makeBoardContext: () => ({ run, config: cfg }) });

    expect(JSON.parse(h.io.out[0])).toMatchObject({ error: expect.stringContaining('boom') });
    expect(process.exitCode).toBe(1);
  });

  it('prints the gh arguments and stderr of a GhError and exits 1', async () => {
    const h = setup();
    const run: GhRunner = async args => ({ stdout: '', code: 1, stderr: `HTTP 401: Bad credentials (${args[0]})` });

    await runCli(['board', 'ensure'], { ...h.deps, makeBoardContext: () => ({ run, config: cfg }) });

    expect(h.io.err.join('\n')).toContain('gh api graphql');
    expect(h.io.err.join('\n')).toContain('HTTP 401: Bad credentials');
    expect(process.exitCode).toBe(1);
  });

  it('prints the message of any other error and exits 1', async () => {
    const h = setup();

    await runCli(['board', 'ensure'], {
      ...h.deps,
      makeBoardContext: () => {
        throw new Error('config is broken');
      },
    });

    expect(h.io.err).toEqual(['config is broken']);
    expect(process.exitCode).toBe(1);
  });
});

describe('sdlc sync (built)', () => {
  /** A `PATH` with git and a `gh` that always fails with `stderr`: the network, or GitHub, answering badly. */
  function pathWithGh(stderr: string): string {
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const gh = join(bin, 'gh');
    writeFileSync(gh, `#!/bin/sh\necho '${stderr}' >&2\nexit 1\n`, { mode: 0o755 });
    const git = join(bin, 'git');
    if (!existsSync(git)) symlinkSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), git);
    return bin;
  }

  function env(path: string): NodeJS.ProcessEnv {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    return { HOME: home, PATH: path, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  }

  function repoWithConfig(): string {
    const repoRoot = join(dir, 'repo');
    mkdirSync(repoRoot);
    execFileSync('git', ['init', '-q'], { cwd: repoRoot, env: env(pathWithGh('x')) });
    writeFileSync(join(repoRoot, 'sdlc.config.yaml'), readFileSync(validConfig, 'utf8'));
    return repoRoot;
  }

  const cacheDir = (repoRoot: string): string => join(repoRoot, '.sdlc', 'cache');
  const outboxLines = (repoRoot: string, file = 'outbox.jsonl'): Record<string, unknown>[] =>
    readFileSync(join(cacheDir(repoRoot), file), 'utf8')
      .split('\n')
      .filter(line => line !== '')
      .map(line => JSON.parse(line) as Record<string, unknown>);

  it('queues a task command while GitHub is unreachable, and sync keeps it until GitHub answers', () => {
    const repoRoot = repoWithConfig();
    const offline = env(pathWithGh('dial tcp: could not resolve host: api.github.com'));

    const queued = sdlc(['approve', '5', 'approve', '--unverified'], { cwd: repoRoot, env: offline });

    expect(queued.status).toBe(0);
    expect(queued.stdout).toBe('queued for `sdlc sync` (GitHub unreachable): sdlc approve 5 approve --unverified\n');
    expect(outboxLines(repoRoot)).toEqual([
      { id: expect.any(String), at: expect.any(String), argv: ['approve', '5', 'approve', '--unverified'] },
    ]);

    const plan = sdlc(['sync', '--dry-run'], { cwd: repoRoot, env: offline });
    expect(plan.status).toBe(0);
    expect(plan.stdout).toBe('Would replay 1 queued command(s):\n  sdlc approve 5 approve --unverified\n');

    // The replay runs the command with queueing off: it exits 75 and stays queued instead of queueing itself again.
    const still = sdlc(['sync'], { cwd: repoRoot, env: offline });
    expect(still.status).toBe(75);
    expect(still.stdout).toContain('GitHub is unreachable');
    expect(outboxLines(repoRoot)).toHaveLength(1);
    expect(existsSync(join(repoRoot, '.sdlc', 'cache', 'sync.lock'))).toBe(false);
  });

  it('moves a queued command that fails for good to outbox-failed.jsonl', () => {
    const repoRoot = repoWithConfig();
    sdlc(['approve', '5', 'approve', '--unverified'], {
      cwd: repoRoot,
      env: env(pathWithGh('dial tcp: could not resolve host: api.github.com')),
    });

    const result = sdlc(['sync', '--json'], { cwd: repoRoot, env: env(pathWithGh('HTTP 404: Not Found')) });

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as { replayed: number; failed: { argv: string[]; error: string }[]; remaining: number };
    expect(report).toMatchObject({ replayed: 0, remaining: 0 });
    expect(report.failed).toEqual([{ argv: ['approve', '5', 'approve', '--unverified'], error: expect.stringContaining('HTTP 404') }]);
    expect(outboxLines(repoRoot)).toEqual([]);
    expect(outboxLines(repoRoot, 'outbox-failed.jsonl')).toEqual([
      expect.objectContaining({ argv: ['approve', '5', 'approve', '--unverified'], error: expect.stringContaining('HTTP 404') }),
    ]);
  });

  it('never runs a forged outbox line: it moves to outbox-failed.jsonl as not a queueable command', () => {
    const repoRoot = repoWithConfig();
    const before = readFileSync(join(repoRoot, 'sdlc.config.yaml'), 'utf8');
    mkdirSync(cacheDir(repoRoot), { recursive: true });
    writeFileSync(
      join(cacheDir(repoRoot), 'outbox.jsonl'),
      `${JSON.stringify({ id: 'forged', at: '2026-06-01T00:00:00.000Z', argv: ['config', 'set', 'mode', 'observe'] })}\n`,
    );

    const result = sdlc(['sync'], { cwd: repoRoot, env: env(pathWithGh('dial tcp: could not resolve host: api.github.com')) });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('not a queueable command');
    expect(outboxLines(repoRoot)).toEqual([]);
    expect(outboxLines(repoRoot, 'outbox-failed.jsonl')).toEqual([
      expect.objectContaining({ id: 'forged', error: 'not a queueable command' }),
    ]);
    expect(readFileSync(join(repoRoot, 'sdlc.config.yaml'), 'utf8')).toBe(before);
  });

  it('queues the command line without --json, and does not queue one given --config', () => {
    const repoRoot = repoWithConfig();
    const offline = env(pathWithGh('dial tcp: could not resolve host: api.github.com'));

    const queued = sdlc(['--json', 'approve', '5', 'approve', '--unverified'], { cwd: repoRoot, env: offline });
    expect(queued.status).toBe(0);
    expect(outboxLines(repoRoot).map(entry => entry.argv)).toEqual([['approve', '5', 'approve', '--unverified']]);

    const withConfig = sdlc(['--config', 'sdlc.config.yaml', 'approve', '6', 'approve', '--unverified'], { cwd: repoRoot, env: offline });
    expect(withConfig.status).toBe(1);
    expect(outboxLines(repoRoot)).toHaveLength(1);
  });

  it('does not queue a command that fails for another reason', () => {
    const repoRoot = repoWithConfig();

    const result = sdlc(['approve', '5', 'approve', '--unverified'], {
      cwd: repoRoot,
      env: env(pathWithGh('HTTP 404: Not Found')),
    });

    expect(result.status).toBe(1);
    expect(existsSync(join(cacheDir(repoRoot), 'outbox.jsonl'))).toBe(false);
  });

  it('exits 75 instead of queueing when SDLC_NO_QUEUE=1', () => {
    const repoRoot = repoWithConfig();

    const result = sdlc(['approve', '5', 'approve', '--unverified'], {
      cwd: repoRoot,
      env: { ...env(pathWithGh('dial tcp: could not resolve host: api.github.com')), SDLC_NO_QUEUE: '1' },
    });

    expect(result.status).toBe(75);
    expect(existsSync(join(cacheDir(repoRoot), 'outbox.jsonl'))).toBe(false);
  });

  it('queues into the main checkout when run from a worktree', () => {
    const repoRoot = repoWithConfig();
    const offline = env(pathWithGh('dial tcp: could not resolve host: api.github.com'));
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: repoRoot, env: offline, encoding: 'utf8' });
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'init');
    git('worktree', 'add', '-q', '-b', 'task/5-x', join(repoRoot, '.worktrees', '5-x'));

    const result = sdlc(['approve', '5', 'approve', '--unverified'], { cwd: join(repoRoot, '.worktrees', '5-x'), env: offline });

    expect(result.status).toBe(0);
    expect(outboxLines(repoRoot)).toHaveLength(1);
    expect(existsSync(join(repoRoot, '.worktrees', '5-x', '.sdlc', 'cache', 'outbox.jsonl'))).toBe(false);
  });
});

describe('formatCliError', () => {
  it('lists the gh arguments and stderr of a GhError', () => {
    const error = new GhError(['api', 'repos/acme/shop/issues', '-f', 'title=Hi'], 'HTTP 404: Not Found\n');

    const text = formatCliError(error);

    expect(text).toContain('gh api repos/acme/shop/issues -f title=Hi');
    expect(text).toContain('HTTP 404: Not Found');
  });

  it('says so when gh printed nothing', () => {
    expect(formatCliError(new GhError(['api', 'x'], ''))).toContain('no error output');
  });

  it('is the message of any other error, or the text of a thrown value', () => {
    expect(formatCliError(new Error('boom'))).toBe('boom');
    expect(formatCliError('plain')).toBe('plain');
  });
});
