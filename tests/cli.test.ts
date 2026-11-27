import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formatCliError, runCli } from '../src/cli.js';
import type { CommandContext } from '../src/commands/context.js';
import { loadConfig, typeRegistry } from '../src/config/schema.js';
import { renderGitHooks } from '../src/render/github.js';
import { newTask } from '../src/core/stateMachine.js';
import { GhError, type GhRunner } from '../src/github/gh.js';
import { FakeTracker } from './support/fakeTracker.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(root, 'dist', 'cli.js');
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
const validConfig = join(root, 'tests', 'fixtures', 'config', 'valid.yaml');

const COMMANDS = ['task', 'stage', 'evidence', 'review', 'approve', 'deploy', 'reconcile', 'status', 'board', 'config', 'githook'];

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

  it('rejects an unknown command', () => {
    const result = sdlc(['frobnicate']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown command');
  });
});

describe('sdlc githook (built)', () => {
  /** A fresh repository on `main` with the valid test config in the given mode. */
  function repo(mode: 'observe' | 'enforce'): string {
    const root = join(dir, 'repo');
    mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: root });
    writeFileSync(join(root, 'sdlc.config.yaml'), readFileSync(validConfig, 'utf8').replace('mode: observe', `mode: ${mode}`));
    return root;
  }

  /** A PATH that finds git and nothing else, so no hook can reach `gh` and the real GitHub. */
  function onlyGit(): NodeJS.ProcessEnv {
    const bin = join(dir, 'only-git');
    if (!existsSync(bin)) {
      mkdirSync(bin);
      symlinkSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), join(bin, 'git'));
    }
    return { ...process.env, PATH: bin };
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
    const update = `refs/heads/work ${'a'.repeat(40)} refs/heads/main ${'0'.repeat(40)}\n`;

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

  it('a missing config warns and exits 0', () => {
    const root = repo('enforce');
    rmSync(join(root, 'sdlc.config.yaml'));

    const result = sdlc(['githook', 'pre-commit'], { cwd: root, env: onlyGit() });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('sdlc: warning: could not load the config (Cannot read config file');
    expect(result.stderr).toContain('git hook pre-commit skipped');
  });

  it('outside a git repository there is no branch to judge: exit 0', () => {
    const result = sdlc(['githook', 'pre-commit'], { env: onlyGit() });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('the rendered scripts work under real git: a commit on main warns or blocks, one on a task branch passes', () => {
    const root = repo('enforce');
    const hooks = join(root, '.sdlc', 'githooks');
    mkdirSync(hooks, { recursive: true });
    for (const change of renderGitHooks()) {
      if (change.kind !== 'file') throw new Error('hooks are files');
      writeFileSync(join(root, change.path), change.content, { mode: change.mode });
    }
    execFileSync('git', ['config', 'core.hooksPath', '.sdlc/githooks'], { cwd: root });
    const env = onlyGit();
    // The scripts find `sdlc` on the PATH, as they do for an installed package.
    writeFileSync(join(dir, 'only-git', 'sdlc'), `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" "$@"\n`, { mode: 0o755 });
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
