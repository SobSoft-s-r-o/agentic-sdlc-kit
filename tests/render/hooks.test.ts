import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfigFromString, type Config, type Harness } from '../../src/config/schema.js';
import { applyPlan, planApply, planUninstall } from '../../src/install/apply.js';
import { MANIFEST_PATH, readManifest } from '../../src/install/manifest.js';
import type { Change, FileChange, JsonKeysChange } from '../../src/render/changes.js';
import {
  HOOK_LAUNCHER,
  HOOK_MARKER,
  HOOK_TIMEOUT_S,
  hookCommand,
  hookNotes,
  renderHookLauncher,
  renderHooks,
} from '../../src/render/hooks.js';
import { mergeChanges } from '../../src/render/plan.js';
import { expectGolden } from '../support/golden.js';
import { memoryFs } from '../support/memoryFs.js';

const HEADER = `version: 1
mode: enforce
github: { repo: acme/shop, default_branch: main, project: { owner: acme, owner_type: org, number: 7 } }
owners: [shop-owner]
task_types: { enabled: [tooling] }
`;
const cfgOf = (harnesses: Harness[]): Config => loadConfigFromString(`${HEADER}harnesses: [${harnesses.join(', ')}]\n`);
const ALL: Harness[] = ['claude', 'codex', 'gemini', 'agents-md'];

const jsonChange = (changes: Change[]): JsonKeysChange => {
  expect(changes).toHaveLength(1);
  const [change] = changes;
  if (change?.kind !== 'json-keys') throw new Error(`expected a json-keys change, got ${change?.kind}`);
  return change;
};

const entryOf = (change: JsonKeysChange, event: string) => {
  const entry = change.entries.find(e => e.pointer.join('/') === `hooks/${event}`);
  if (!entry) throw new Error(`no entry for hooks/${event}`);
  return entry;
};

const cmd = (harness: 'claude' | 'codex' | 'gemini', event: 'session-start' | 'prompt' | 'pre-tool'): string =>
  `"$(git rev-parse --show-toplevel)/.sdlc/hooks/run.sh" ${harness} ${event}`;

describe('constants', () => {
  it('names the launcher, uses its path as the marker and has the rendered timeouts', () => {
    expect(HOOK_LAUNCHER).toBe('.sdlc/hooks/run.sh');
    expect(HOOK_MARKER).toBe(HOOK_LAUNCHER);
    expect(HOOK_TIMEOUT_S).toEqual({ 'session-start': 30, prompt: 30, 'pre-tool': 15 });
  });

  it('hookCommand resolves the launcher from the git root and passes the harness and event', () => {
    expect(hookCommand('claude', 'session-start')).toBe(
      '"$(git rev-parse --show-toplevel)/.sdlc/hooks/run.sh" claude session-start',
    );
    expect(hookCommand('gemini', 'pre-tool')).toBe('"$(git rev-parse --show-toplevel)/.sdlc/hooks/run.sh" gemini pre-tool');
  });
});

describe('renderHooks, claude (.claude/settings.json)', () => {
  const change = jsonChange(renderHooks(cfgOf(['claude']), 'claude'));

  it('is one json-keys change of the three hook events, nothing else', () => {
    expect(change.path).toBe('.claude/settings.json');
    expect(change.entries.map(e => e.pointer)).toEqual([
      ['hooks', 'SessionStart'],
      ['hooks', 'UserPromptSubmit'],
      ['hooks', 'PreToolUse'],
    ]);
  });

  it('calls the launcher for session start and the prompt, 30 seconds each, for every session', () => {
    expect(entryOf(change, 'SessionStart').value).toEqual([
      { hooks: [{ type: 'command', command: cmd('claude', 'session-start'), timeout: 30 }] },
    ]);
    expect(entryOf(change, 'UserPromptSubmit').value).toEqual([
      { hooks: [{ type: 'command', command: cmd('claude', 'prompt'), timeout: 30 }] },
    ]);
  });

  it('gates the edit, shell and subagent tools before use, 15 seconds', () => {
    expect(entryOf(change, 'PreToolUse').value).toEqual([
      {
        matcher: 'Write|Edit|NotebookEdit|Bash|PowerShell|Agent|Task',
        hooks: [{ type: 'command', command: cmd('claude', 'pre-tool'), timeout: 15 }],
      },
    ]);
  });
});

describe('renderHooks, codex (.codex/hooks.json)', () => {
  const change = jsonChange(renderHooks(cfgOf(['codex']), 'codex'));

  it('writes hooks.json, not config.toml', () => {
    expect(change.path).toBe('.codex/hooks.json');
    expect(change.entries.map(e => e.pointer)).toEqual([
      ['hooks', 'SessionStart'],
      ['hooks', 'UserPromptSubmit'],
      ['hooks', 'PreToolUse'],
    ]);
  });

  it('has the same three events with timeouts in seconds and a regex matcher on the pre-tool group', () => {
    expect(entryOf(change, 'SessionStart').value).toEqual([
      { hooks: [{ type: 'command', command: cmd('codex', 'session-start'), timeout: 30 }] },
    ]);
    expect(entryOf(change, 'UserPromptSubmit').value).toEqual([
      { hooks: [{ type: 'command', command: cmd('codex', 'prompt'), timeout: 30 }] },
    ]);
    expect(entryOf(change, 'PreToolUse').value).toEqual([
      {
        matcher: '^(apply_patch|Edit|Write|Bash|spawn_agent|Agent)$',
        hooks: [{ type: 'command', command: cmd('codex', 'pre-tool'), timeout: 15 }],
      },
    ]);
  });

  it('adds no field Codex does not know (its hooks file rejects unknown fields): no name, no top-level key but hooks', () => {
    for (const entry of change.entries) {
      expect(entry.pointer[0]).toBe('hooks');
      for (const group of entry.value as Array<{ hooks: Array<Record<string, unknown>> }>) {
        expect(Object.keys(group).filter(key => key !== 'matcher')).toEqual(['hooks']);
        for (const handler of group.hooks) expect(Object.keys(handler)).toEqual(['type', 'command', 'timeout']);
      }
    }
  });
});

describe('renderHooks, gemini (.gemini/settings.json)', () => {
  const change = jsonChange(renderHooks(cfgOf(['gemini']), 'gemini'));

  it('uses the Gemini event names', () => {
    expect(change.path).toBe('.gemini/settings.json');
    expect(change.entries.map(e => e.pointer)).toEqual([
      ['hooks', 'SessionStart'],
      ['hooks', 'BeforeAgent'],
      ['hooks', 'BeforeTool'],
    ]);
  });

  it('names each handler sdlc-<event> and gives the timeouts in milliseconds', () => {
    expect(entryOf(change, 'SessionStart').value).toEqual([
      { hooks: [{ name: 'sdlc-session-start', type: 'command', command: cmd('gemini', 'session-start'), timeout: 30000 }] },
    ]);
    expect(entryOf(change, 'BeforeAgent').value).toEqual([
      { hooks: [{ name: 'sdlc-prompt', type: 'command', command: cmd('gemini', 'prompt'), timeout: 30000 }] },
    ]);
    expect(entryOf(change, 'BeforeTool').value).toEqual([
      {
        matcher: '^(write_file|replace|run_shell_command|invoke_agent)$',
        hooks: [{ name: 'sdlc-pre-tool', type: 'command', command: cmd('gemini', 'pre-tool'), timeout: 15000 }],
      },
    ]);
  });
});

describe('renderHooks, all harnesses', () => {
  it('gives agents-md no hooks', () => {
    expect(renderHooks(cfgOf(['agents-md']), 'agents-md')).toEqual([]);
  });

  it.each(['claude', 'codex', 'gemini'] as const)(
    '%s: every entry owns array items marked with the launcher path, and each item contains the marker',
    harness => {
      const change = jsonChange(renderHooks(cfgOf([harness]), harness));
      expect(change.entries).toHaveLength(3);
      for (const entry of change.entries) {
        expect(entry.items).toEqual({ marker: HOOK_MARKER });
        expect(Array.isArray(entry.value)).toBe(true);
        for (const item of entry.value as unknown[]) expect(JSON.stringify(item)).toContain(HOOK_MARKER);
      }
    },
  );

  it('does not depend on which other harnesses are configured', () => {
    for (const harness of ['claude', 'codex', 'gemini'] as const) {
      expect(renderHooks(cfgOf(ALL), harness)).toEqual(renderHooks(cfgOf([harness]), harness));
    }
  });
});

describe('renderHookLauncher', () => {
  it('is one executable whole file at .sdlc/hooks/run.sh', () => {
    const [change, ...rest] = renderHookLauncher(cfgOf(['claude']));
    expect(rest).toEqual([]);
    expect(change?.kind).toBe('file');
    expect(change?.path).toBe(HOOK_LAUNCHER);
    expect((change as FileChange).mode).toBe(0o755);
  });

  it('is rendered for any hook harness, and not for an AGENTS.md-only setup', () => {
    for (const harnesses of [['claude'], ['codex'], ['gemini'], ['agents-md', 'gemini']] as Harness[][]) {
      expect(renderHookLauncher(cfgOf(harnesses)).map(c => c.path)).toEqual([HOOK_LAUNCHER]);
    }
    expect(renderHookLauncher(cfgOf(['agents-md']))).toEqual([]);
  });

  it('is the same file whichever harnesses are configured', () => {
    expect(renderHookLauncher(cfgOf(ALL))).toEqual(renderHookLauncher(cfgOf(['codex'])));
  });
});

describe('hookNotes', () => {
  const CODEX =
    'Codex runs project hooks only in a trusted project after you review them: open codex in this repository, trust it, then run /hooks and approve the sdlc hooks.';
  const GEMINI = 'Gemini CLI loads project hooks only in a trusted folder: run gemini in this repository and trust the folder.';

  it('tells the owner how to trust the hooks of Codex and Gemini', () => {
    expect(hookNotes(cfgOf(['codex']))).toEqual([CODEX]);
    expect(hookNotes(cfgOf(['gemini']))).toEqual([GEMINI]);
    expect(hookNotes(cfgOf(ALL))).toEqual([CODEX, GEMINI]);
  });

  it('has no note for Claude Code or an AGENTS.md-only setup', () => {
    expect(hookNotes(cfgOf(['claude']))).toEqual([]);
    expect(hookNotes(cfgOf(['agents-md']))).toEqual([]);
  });
});

describe('golden files', () => {
  for (const harness of ['claude', 'codex', 'gemini'] as const) {
    it(`${harness}`, () => {
      expectGolden(`hooks/${harness}`, renderHooks(cfgOf([harness]), harness));
    });
  }

  it('all: every harness with the launcher, merged like the install plan', () => {
    const cfg = cfgOf(ALL);
    const changes = [...(['claude', 'codex', 'gemini', 'agents-md'] as const).flatMap(h => renderHooks(cfg, h)), ...renderHookLauncher(cfg)];
    expectGolden('hooks/all', mergeChanges(changes));
  });
});

describe('through the apply engine', () => {
  it('creates the three files and the launcher from nothing, and uninstall takes them all away', () => {
    const fs = memoryFs();
    const cfg = cfgOf(ALL);
    const changes = mergeChanges([...(['claude', 'codex', 'gemini'] as const).flatMap(h => renderHooks(cfg, h)), ...renderHookLauncher(cfg)]);
    const plan = planApply(changes, fs, undefined, { overwriteModified: false });
    expect(plan.errors).toEqual([]);
    expect(applyPlan(plan, fs, { removeObsolete: false }).errors).toEqual([]);

    expect(Object.keys(fs.snapshot())).toEqual([
      '.claude/settings.json',
      '.codex/hooks.json',
      '.gemini/settings.json',
      '.sdlc/hooks/run.sh',
      MANIFEST_PATH,
    ]);
    expect(fs.modes.get('.sdlc/hooks/run.sh')).toBe(0o755);
    const codex = JSON.parse(fs.read('.codex/hooks.json') ?? '') as Record<string, unknown>;
    expect(Object.keys(codex)).toEqual(['hooks']);

    const manifest = readManifest(fs);
    if (manifest === undefined) throw new Error('no manifest');
    expect(applyPlan(planUninstall(fs, manifest), fs, { removeObsolete: true }).errors).toEqual([]);
    expect(fs.snapshot()).toEqual({});
  });
});

// --- the launcher script, run under /bin/sh ------------------------------------------------------

describe('the rendered launcher, run under /bin/sh', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sdlc-hook-launcher-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const script = (): string => {
    const [change] = renderHookLauncher(cfgOf(['claude']));
    if (change?.kind !== 'file') throw new Error('expected a file change');
    return change.content;
  };

  /** Writes an executable stand-in for a command into a bin directory. */
  function fakeBin(name: string, body: string, bin = join(dir, 'bin')): string {
    mkdirSync(bin, { recursive: true });
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return bin;
  }

  /** A bin directory with only `cat`, for the stand-ins that copy stdin to stdout (every system has it). */
  function catOnly(): string {
    const tools = join(dir, 'cat-only');
    mkdirSync(tools, { recursive: true });
    const found = execFileSync('sh', ['-c', 'command -v cat'], { encoding: 'utf8' }).trim();
    writeFileSync(join(tools, 'cat'), `#!/bin/sh\nexec ${found} "$@"\n`);
    chmodSync(join(tools, 'cat'), 0o755);
    return tools;
  }

  /** Runs the launcher with a PATH of only `bins` and `cat`: nothing else on the machine (no sdlc, no npx) is visible to it. */
  function run(args: string[], bins: string[], input = '') {
    const file = join(dir, 'run.sh');
    writeFileSync(file, script());
    const result = spawnSync('/bin/sh', [file, ...args], { env: { PATH: [...bins, catOnly()].join(':') }, input, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('is POSIX sh: shebang, quoted "$@", no bashisms, syntax checks under sh -n', () => {
    const text = script();
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    expect(text).toContain('sdlc hook "$@"');
    expect(text).toContain('npx --no-install sdlc hook "$@"');
    expect(text).not.toMatch(/\[\[|\bbash\b|\bfunction\b|<\(/);
    expect(text).not.toMatch(/\$@(?!")|(?<!")\$@/);
    expect(text.endsWith('\n')).toBe(true);

    const file = join(dir, 'syntax.sh');
    writeFileSync(file, text);
    expect(() => execFileSync('sh', ['-n', file], { stdio: 'pipe' })).not.toThrow();
  });

  it('without sdlc and without npx prints nothing to stdout, one line to stderr and exits 0', () => {
    const result = run(['claude', 'pre-tool'], [], '{"tool_name":"Bash"}');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('sdlc: hook skipped: sdlc not found\n');
  });

  it('runs sdlc hook with the harness and event, and passes stdin and stdout through', () => {
    const bin = fakeBin('sdlc', 'for a in "$@"; do echo "arg:[$a]"; done; cat');
    const payload = '{"hook_event_name":"PreToolUse","tool_input":{"command":"echo \\"a  b\\""}}\n';

    const result = run(['gemini', 'pre-tool'], [bin], payload);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`arg:[hook]\narg:[gemini]\narg:[pre-tool]\n${payload}`);
    expect(result.stderr).toBe('');
  });

  it('falls back to npx --no-install when sdlc is not on the PATH and npx resolves it, forwarding stdin', () => {
    const bin = fakeBin(
      'npx',
      'if [ "$*" = "--no-install sdlc --version" ]; then exit 0; fi; for a in "$@"; do echo "npx:[$a]"; done; cat',
    );

    const result = run(['codex', 'prompt'], [bin], 'payload\n');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('npx:[--no-install]\nnpx:[sdlc]\nnpx:[hook]\nnpx:[codex]\nnpx:[prompt]\npayload\n');
  });

  it('the npx probe does not read stdin', () => {
    const probe = join(dir, 'probe.txt');
    const bin = fakeBin(
      'npx',
      `if [ "$3" = "--version" ]; then read -r seen; echo "probe saw:[$seen]" >> "${probe}"; exit 0; fi; cat`,
    );

    const result = run(['claude', 'prompt'], [bin], 'first\nsecond\n');

    expect(result.stdout).toBe('first\nsecond\n');
    expect(readFileSync(probe, 'utf8')).toBe('probe saw:[]\n');
  });

  it('skips when npx cannot resolve sdlc, without running the hook', () => {
    const calls = join(dir, 'npx-calls.txt');
    const bin = fakeBin('npx', `echo "$*" >> "${calls}"; exit 1`);

    const result = run(['claude', 'session-start'], [bin]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(readFileSync(calls, 'utf8')).toBe('--no-install sdlc --version\n');
    expect(result.stderr).toBe('sdlc: hook skipped: sdlc not found\n');
  });

  it('prefers sdlc on the PATH over npx', () => {
    const bin = fakeBin('sdlc', 'echo "sdlc ran"');
    fakeBin('npx', 'echo "npx ran"', bin);

    expect(run(['claude', 'prompt'], [bin]).stdout).toBe('sdlc ran\n');
  });

  it('exits 0 even when sdlc fails, so no harness reads a crash as a block', () => {
    const bin = fakeBin('sdlc', 'echo "partial"; exit 2');

    const result = run(['claude', 'pre-tool'], [bin]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('partial\n');
    expect(result.stderr).toBe('sdlc: hook skipped: sdlc exited with status 2\n');
  });
});
