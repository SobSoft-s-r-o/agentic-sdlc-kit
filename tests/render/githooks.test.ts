import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Change, FileChange } from '../../src/render/changes.js';
import { HOOKS_PATH } from '../../src/install/provision.js';
import { renderGitHooks } from '../../src/render/github.js';
import { expectGolden } from '../support/golden.js';

const NAMES = ['pre-commit', 'pre-push', 'post-merge', 'post-checkout'] as const;

const changes = (): FileChange[] =>
  renderGitHooks().map((change: Change) => {
    if (change.kind !== 'file') throw new Error(`expected a file change, got ${change.kind}`);
    return change;
  });
const scriptOf = (name: string): FileChange => {
  const found = changes().find(change => change.path === `.sdlc/githooks/${name}`);
  if (!found) throw new Error(`no hook ${name}`);
  return found;
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sdlc-githooks-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes an executable stand-in for a command into a fresh bin directory. */
function fakeBin(name: string, body: string, bin = join(dir, 'bin')): string {
  mkdirSync(bin, { recursive: true });
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return bin;
}

/** Runs the rendered hook with `/bin/sh` and a PATH of only `bins`: nothing else on the machine is visible to it. */
function runHook(name: string, args: string[], bins: string[], input = '') {
  const script = join(dir, `${name}.sh`);
  writeFileSync(script, scriptOf(name).content);
  const emptyPath = join(dir, 'empty');
  mkdirSync(emptyPath, { recursive: true });
  const result = spawnSync('/bin/sh', [script, ...args], {
    env: { PATH: [...bins, emptyPath].join(':') },
    input,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('renderGitHooks', () => {
  it('creates the four hooks as executable whole files under .sdlc/githooks', () => {
    expect(renderGitHooks().map(change => [change.kind, change.path, (change as FileChange).mode])).toEqual(
      NAMES.map(name => ['file', `.sdlc/githooks/${name}`, 0o755]),
    );
  });

  it('writes where core.hooksPath points', () => {
    expect(renderGitHooks().every(change => change.path.startsWith(`${HOOKS_PATH}/`))).toBe(true);
  });

  it('matches the golden scripts', () => {
    expectGolden('githooks', renderGitHooks());
  });

  it.each(NAMES)('%s is POSIX sh that sdlc githook can run: shebang, quoted "$@", no bashisms', name => {
    const { content } = scriptOf(name);

    expect(content.startsWith('#!/bin/sh\n')).toBe(true);
    const feed = name === 'pre-push' ? `printf '%s' "$sdlc_stdin" | ` : '';
    expect(content).toContain(`\n  ${feed}sdlc githook ${name} "$@"\n`);
    expect(content).toContain(`\n  ${feed}npx --no-install sdlc githook ${name} "$@"\n`);
    expect(content).toContain(`\n${feed}"$sdlc_legacy" "$@"\nexit $?\n`);
    expect(content).not.toMatch(/\[\[|\bbash\b|\bfunction\b|<\(|\$\{[^}]*[#%/:^,][^}]*\}/);
    expect(content).not.toMatch(/\$@(?!")|(?<!")\$@/);
    expect(content.endsWith('\n')).toBe(true);
  });

  it.each(NAMES)('%s has no syntax errors under sh -n', name => {
    const file = join(dir, name);
    writeFileSync(file, scriptOf(name).content);

    expect(() => execFileSync('sh', ['-n', file], { stdio: 'pipe' })).not.toThrow();
  });

  it('adds "the secret guard is NOT active" to the skipped message of pre-commit and pre-push only', () => {
    for (const name of NAMES) {
      const skipped = `sdlc not found; agentic-sdlc-kit git hook ${name} skipped (install: see INSTALL.md)`;
      const guarded = ['pre-commit', 'pre-push'].includes(name);

      expect(scriptOf(name).content).toContain(guarded ? `${skipped}; the secret guard is NOT active"` : `${skipped}"`);
    }
  });
});

describe('the rendered scripts, run under /bin/sh', () => {
  it.each(NAMES)('%s without sdlc and without npx prints the message to stderr and exits 0', name => {
    const result = runHook(name, ['a', 'b'], []);

    const note = `sdlc not found; agentic-sdlc-kit git hook ${name} skipped (install: see INSTALL.md)`;
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe(
      ['pre-commit', 'pre-push'].includes(name) ? `${note}; the secret guard is NOT active` : note,
    );
  });

  it('runs sdlc githook <name> with the hook arguments intact, and gives back its exit code', () => {
    const bin = fakeBin('sdlc', 'for a in "$@"; do echo "arg:[$a]"; done; exit 3');

    const result = runHook('post-checkout', ['abc def', 'two  spaces', '1'], [bin]);

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('arg:[githook]\narg:[post-checkout]\narg:[abc def]\narg:[two  spaces]\narg:[1]\n');
  });

  it('pre-push hands its stdin to sdlc unchanged', () => {
    const bin = fakeBin('sdlc', 'while read -r line; do echo "stdin:[$line]"; done');
    const updates = 'refs/heads/a 1111 refs/heads/task/1-x 0000\nrefs/heads/b 2222 refs/heads/main 3333\n';

    const result = runHook('pre-push', ['origin', 'git@example.test:acme/shop.git'], [bin], updates);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      'stdin:[refs/heads/a 1111 refs/heads/task/1-x 0000]\nstdin:[refs/heads/b 2222 refs/heads/main 3333]\n',
    );
  });

  it('falls back to npx --no-install when sdlc is not on the PATH and npx resolves it', () => {
    const bin = fakeBin(
      'npx',
      'if [ "$*" = "--no-install sdlc --version" ]; then exit 0; fi; for a in "$@"; do echo "npx:[$a]"; done; exit 4',
    );

    const result = runHook('pre-commit', [], [bin]);

    expect(result.status).toBe(4);
    expect(result.stdout).toBe('npx:[--no-install]\nnpx:[sdlc]\nnpx:[githook]\nnpx:[pre-commit]\n');
  });

  it('skips when npx cannot resolve sdlc, without running the hook', () => {
    const calls = join(dir, 'npx-calls.txt');
    const bin = fakeBin('npx', `echo "$*" >> "${calls}"; exit 1`);

    const result = runHook('pre-push', [], [bin]);

    expect(result.status).toBe(0);
    expect(readFileSync(calls, 'utf8')).toBe('--no-install sdlc --version\n');
    expect(result.stderr).toContain('sdlc not found; agentic-sdlc-kit git hook pre-push skipped');
  });

  it('the npx probe never reads stdin: pre-push hands all of it to the real command', () => {
    const probe = join(dir, 'probe.txt');
    const bin = fakeBin(
      'npx',
      `if [ "$3" = "--version" ]; then read -r seen; echo "probe saw:[$seen]" >> "${probe}"; exit 0; fi; ` +
        'while read -r line; do echo "stdin:[$line]"; done',
    );

    const result = runHook('pre-push', ['origin'], [bin], 'first\nsecond\n');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('stdin:[first]\nstdin:[second]\n');
    expect(readFileSync(probe, 'utf8')).toBe('probe saw:[]\n');
  });

  it('without git on the PATH there is no legacy hook to find: the sdlc result stands', () => {
    const bin = fakeBin('sdlc', 'exit 0');

    const result = runHook('pre-commit', [], [bin]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('prefers sdlc on the PATH over npx', () => {
    const bin = fakeBin('sdlc', 'echo "sdlc ran"');
    fakeBin('npx', 'echo "npx ran"', bin);

    const result = runHook('post-merge', [], [bin]);

    expect(result.stdout).toBe('sdlc ran\n');
  });
});

describe('chaining the legacy hook in $(git rev-parse --git-common-dir)/hooks', () => {
  /** A bin directory with sdlc (exit `sdlcExit`), a git that names `common` as the common dir, and the tools the scripts use. */
  function setupBins(common: string, sdlcExit = 0): string[] {
    const bin = fakeBin('sdlc', `cat >/dev/null 2>&1; echo "sdlc ran"; exit ${sdlcExit}`);
    fakeBin('git', `if [ "$*" = "rev-parse --git-common-dir" ]; then echo "${common}"; exit 0; fi; exit 1`, bin);
    const tools = join(dir, 'tools');
    mkdirSync(tools, { recursive: true });
    for (const tool of ['cat']) {
      const found = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
      writeFileSync(join(tools, tool), `#!/bin/sh\nexec ${found} "$@"\n`);
      chmodSync(join(tools, tool), 0o755);
    }
    return [bin, tools];
  }

  function legacy(common: string, name: string, body: string, mode = 0o755): void {
    mkdirSync(join(common, 'hooks'), { recursive: true });
    writeFileSync(join(common, 'hooks', name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(common, 'hooks', name), mode);
  }

  it('runs the legacy hook after sdlc passes, with the same arguments, and exits with its code', () => {
    const common = join(dir, 'common');
    legacy(common, 'post-checkout', 'for a in "$@"; do echo "legacy:[$a]"; done; exit 5');

    const result = runHook('post-checkout', ['a b', '1'], setupBins(common));

    expect(result.status).toBe(5);
    expect(result.stdout).toBe('sdlc ran\nlegacy:[a b]\nlegacy:[1]\n');
  });

  it('does not run the legacy hook when sdlc fails', () => {
    const common = join(dir, 'common');
    legacy(common, 'pre-commit', 'echo "legacy ran"; exit 0');

    const result = runHook('pre-commit', [], setupBins(common, 1));

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('sdlc ran\n');
  });

  it('pre-push replays the same stdin to the legacy hook', () => {
    const common = join(dir, 'common');
    legacy(common, 'pre-push', 'while read -r line; do echo "legacy:[$line]"; done');
    const bins = setupBins(common);
    fakeBin('sdlc', 'while read -r line; do echo "sdlc:[$line]"; done', bins[0]);

    const result = runHook('pre-push', ['origin'], bins, 'refs/heads/a 1 refs/heads/a 0\nrefs/heads/b 2 refs/heads/b 0\n');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      'sdlc:[refs/heads/a 1 refs/heads/a 0]\nsdlc:[refs/heads/b 2 refs/heads/b 0]\n' +
        'legacy:[refs/heads/a 1 refs/heads/a 0]\nlegacy:[refs/heads/b 2 refs/heads/b 0]\n',
    );
  });

  it('still runs the legacy hook when sdlc is not installed', () => {
    const common = join(dir, 'common');
    legacy(common, 'pre-commit', 'echo "legacy ran"; exit 2');
    const bins = setupBins(common);
    rmSync(join(bins[0] as string, 'sdlc'));

    const result = runHook('pre-commit', [], bins);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('legacy ran\n');
    expect(result.stderr).toContain('the secret guard is NOT active');
  });

  it('skips a legacy hook that is not executable, with a note', () => {
    const common = join(dir, 'common');
    legacy(common, 'pre-commit', 'echo "legacy ran"; exit 2', 0o644);

    const result = runHook('pre-commit', [], setupBins(common));

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('sdlc ran\n');
    expect(result.stderr).toContain('hooks/pre-commit is not executable, so it was not run');
  });

  it('does not run itself when the legacy hook is this very script', () => {
    const common = join(dir, 'common');
    mkdirSync(join(common, 'hooks'), { recursive: true });
    const script = join(common, 'hooks', 'pre-commit');
    writeFileSync(script, scriptOf('pre-commit').content);
    chmodSync(script, 0o755);

    const result = spawnSync('/bin/sh', [script], { env: { PATH: setupBins(common).join(':') }, encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('sdlc ran\n');
  });

  it('does not chain again inside a chained hook', () => {
    const common = join(dir, 'common');
    legacy(common, 'pre-commit', 'echo "legacy ran"');
    const script = join(dir, 'pre-commit.sh');
    writeFileSync(script, scriptOf('pre-commit').content);

    const result = spawnSync('/bin/sh', [script], {
      env: { PATH: setupBins(common).join(':'), SDLC_CHAINED_HOOK: 'pre-commit' },
      encoding: 'utf8',
    });

    expect(result.stdout).toBe('sdlc ran\n');
  });
});
