import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import type { InstallContext } from '../../src/commands/install.js';
import { FIELD_NAMES, desiredFields } from '../../src/github/board.js';
import { loadConfigFromString, type Config } from '../../src/config/schema.js';
import { readManifest } from '../../src/install/manifest.js';
import type { GitRunner, HookFileState } from '../../src/install/provision.js';
import type { RepoFs } from '../../src/install/repoFs.js';
import type { Change, JsonKeysChange } from '../../src/render/changes.js';
import { mergeChanges, renderAll } from '../../src/render/plan.js';
import { packageVersion } from '../../src/version.js';
import { fakeGh, type FakeGh, type FakeGhStep } from '../support/fakeGh.js';
import { memoryFs, type MemoryFs } from '../support/memoryFs.js';

const HEADER = `version: 1
mode: observe
github: { repo: acme/shop, default_branch: main, project: { owner: acme, owner_type: org, number: 7 } }
owners: [shop-owner]
task_types: { enabled: [tooling, analysis] }
`;
/** claude + codex, Actions on, the default MCP server (github) in project scope. */
const CONFIG = `${HEADER}harnesses: [claude, codex]
stack: { actions: true }
`;
const configWith = (extra: string, harnesses = '[claude, codex]'): string => `${HEADER}harnesses: ${harnesses}\n${extra}`;

const ROLES = [
  'analyst',
  'architect',
  'developer',
  'diagnostician',
  'docs-writer',
  'final-reviewer',
  'release-manager',
  'reviewer',
  'scout',
  'security-reviewer',
  'tester',
];
const SKILLS = ['sdlc-delivery', 'sdlc-orientation', 'sdlc-task-tracking'];
const GITHOOKS = ['post-checkout', 'post-merge', 'pre-commit', 'pre-push'].map(name => `.sdlc/githooks/${name}`);

/** Every file `sdlc init` creates for CONFIG in an empty repository, sorted. */
const INIT_PATHS = [
  '.agents/skills/sdlc-delivery/SKILL.md',
  '.agents/skills/sdlc-orientation/SKILL.md',
  '.agents/skills/sdlc-task-tracking/SKILL.md',
  ...ROLES.map(role => `.claude/agents/sdlc-${role}.md`),
  ...SKILLS.map(skill => `.claude/skills/${skill}/SKILL.md`),
  '.claude/settings.json',
  ...ROLES.map(role => `.codex/agents/sdlc-${role}.toml`),
  '.codex/config.toml',
  '.codex/hooks.json',
  '.github/pull_request_template.md',
  '.github/workflows/sdlc-reconcile.yml',
  '.gitignore',
  '.mcp.json',
  ...GITHOOKS,
  '.sdlc/hooks/run.sh',
  '.sdlc/manifest.json',
  'AGENTS.md',
  'CLAUDE.md',
].sort();

// --- fakes ----------------------------------------------------------------------------------------

interface FakeGit {
  run: GitRunner;
  calls: string[][];
  hooksPath(): string | undefined;
}

/** Answers the three `git config` calls the commands make and keeps the value of `core.hooksPath`. */
function fakeGit(initial?: string): FakeGit {
  let hooksPath = initial;
  const calls: string[][] = [];
  const ok = { stdout: '', code: 0, stderr: '' };
  const run: GitRunner = async args => {
    calls.push(args);
    const [command, a, b] = args;
    if (command === 'config' && a === '--get' && b === 'core.hooksPath') {
      return hooksPath === undefined ? { stdout: '', code: 1, stderr: '' } : { stdout: `${hooksPath}\n`, code: 0, stderr: '' };
    }
    if (command === 'config' && a === 'core.hooksPath' && b !== undefined) {
      hooksPath = b;
      return ok;
    }
    if (command === 'config' && a === '--unset' && b === 'core.hooksPath') {
      hooksPath = undefined;
      return ok;
    }
    if (command === 'rev-parse' && a === '--git-common-dir') return { stdout: '.git\n', code: 0, stderr: '' };
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  return { run, calls, hooksPath: () => hooksPath };
}

const VIEWS = ['Board', 'In flight', 'Awaiting deployment', 'Waiting on owner'];
const LABELS = ['sdlc:task', 'sdlc:partial', 'type:tooling', 'type:analysis'];
const PROTECTION = ['api', 'repos/acme/shop/branches/main/protection'];

/** A board that already has every field, option and view of `cfg`: ensureBoard finds nothing to do. */
function provisionedBoard(cfg: Config): FakeGhStep {
  const nodes = [
    { id: 'F_title', name: 'Title', dataType: 'TITLE' },
    ...desiredFields(cfg).map((f, i) => ({
      id: `PF_${i}`,
      name: f.name,
      dataType: f.dataType,
      ...(f.options && { options: f.options.map((name, j) => ({ id: `PF_${i}_${j}`, name })) }),
    })),
  ];
  return {
    match: ['graphql'],
    stdout: JSON.stringify({
      data: { owner: { projectV2: { id: 'PVT_1', number: 7, fields: { nodes }, views: { nodes: VIEWS.map(name => ({ name })) } } } },
    }),
  };
}

/** GitHub as it is before init: nothing set up. Real runs and dry runs make the same four reads and a real run then writes. */
function emptyGithub(cfg: Config, dryRun: boolean): FakeGhStep[] {
  return [
    provisionedBoard(cfg),
    { match: ['label', 'list'], stdout: '[]' },
    ...(dryRun ? [] : LABELS.map((): FakeGhStep => ({ match: ['label', 'create'] }))),
    { match: PROTECTION, code: 1, stderr: 'gh: Branch not protected (HTTP 404)' },
    ...(dryRun ? [] : [{ match: ['PUT'] }]),
    { match: ['api', 'repos/acme/shop', '--jq'], stdout: '' },
    ...(dryRun ? [] : [{ match: ['PATCH'] }]),
  ];
}

/** GitHub with everything in place already. */
function readyGithub(cfg: Config): FakeGhStep[] {
  return [
    provisionedBoard(cfg),
    { match: ['label', 'list'], stdout: JSON.stringify(LABELS.map(name => ({ name }))) },
    { match: PROTECTION, stdout: '{}' },
    {
      match: ['api', 'repos/acme/shop', '--jq'],
      stdout: JSON.stringify({ secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } }),
    },
  ];
}

/** A `gh` call that changes something on GitHub. */
function isMutation(args: string[], input: string | undefined): boolean {
  if (args.includes('create') || args.includes('-X')) return true;
  if (args.includes('graphql')) return /\bmutation\b/.test(input ?? '');
  return false;
}
const mutations = (gh: FakeGh): string[][] => gh.calls.filter((args, i) => isMutation(args, gh.inputs[i]));

// --- harness --------------------------------------------------------------------------------------

interface Report {
  steps: Array<{ name: string; status: 'ok' | 'skipped' | 'failed'; details: string[] }>;
  plan: {
    writes: Array<{ path: string; action: string }>;
    notices: Array<{ path: string; message: string }>;
    errors: Array<{ path: string; message: string }>;
  };
}

interface Harness {
  fs: MemoryFs;
  git: FakeGit;
  gh: FakeGh;
  out: string[];
  err: string[];
  context: InstallContext;
  /** Replaces what `gh` answers, for the next command. */
  useGh(script: FakeGhStep[]): FakeGh;
  setConfig(text: string): void;
  go(args: string[]): Promise<void>;
  /** The JSON report of the last `--json` run. */
  report(): Report;
  text(): string;
  stepStatuses(): Array<[string, string]>;
}

function setup(
  options: {
    files?: Record<string, string>;
    config?: string;
    hooksPath?: string;
    gh?: FakeGhStep[];
    wrapFs?: (fs: MemoryFs) => RepoFs;
    /** The repository's own hooks in `.git/hooks`, by name. */
    legacyHooks?: Record<string, HookFileState>;
  } = {},
): Harness {
  const fs = memoryFs(options.files ?? {});
  const git = fakeGit(options.hooksPath);
  const out: string[] = [];
  const err: string[] = [];
  let configText = options.config ?? CONFIG;
  const context: InstallContext = {
    fs: options.wrapFs ? options.wrapFs(fs) : fs,
    git: git.run,
    gh: fakeGh(options.gh ?? []),
    hookProbe: path => {
      const prefix = '/memory/.git/hooks/';
      return path.startsWith(prefix) ? (options.legacyHooks?.[path.slice(prefix.length)] ?? 'missing') : 'missing';
    },
    loadConfig: () => loadConfigFromString(configText),
    out: text => out.push(text),
    err: text => err.push(text),
  };
  const h: Harness = {
    fs,
    git,
    get gh() {
      return context.gh as FakeGh;
    },
    out,
    err,
    context,
    useGh(script) {
      const gh = fakeGh(script);
      context.gh = gh;
      return gh;
    },
    setConfig: text => {
      configText = text;
    },
    go: args => {
      out.length = 0;
      err.length = 0;
      return runCli(args, { makeInstallContext: () => context, out: t => out.push(t), err: t => err.push(t) });
    },
    report: () => JSON.parse(out.join('\n')) as Report,
    text: () => out.join('\n'),
    stepStatuses: () => h.report().steps.map(s => [s.name, s.status]),
  };
  return h;
}

let exitCode: typeof process.exitCode;
beforeEach(() => {
  exitCode = process.exitCode;
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = exitCode;
});

const cfgOf = (text: string): Config => loadConfigFromString(text);
const sorted = (paths: string[]): string[] => [...paths].sort();

/** Runs `sdlc init` for real against an empty GitHub, as the first step of the tests that need an installed repository. */
async function installed(files: Record<string, string> = {}, config = CONFIG): Promise<Harness> {
  const h = setup({ files, config });
  h.useGh(emptyGithub(cfgOf(config), false));
  await h.go(['init']);
  expect(process.exitCode).toBeUndefined();
  return h;
}

// --- renderAll ------------------------------------------------------------------------------------

describe('renderAll', () => {
  const all = (text: string, fs: RepoFs = memoryFs()) => renderAll(cfgOf(text), fs);

  it('renders every harness once, sorted by path, with no path twice', () => {
    const { changes } = all(configWith('', '[claude, codex, gemini, agents-md]'));
    const paths = changes.map(c => c.path);
    expect(paths).toEqual(sorted(paths));
    expect(new Set(paths).size).toBe(paths.length);
    // codex and agents-md share AGENTS.md and the .agents skills, rendered identically
    expect(paths.filter(p => p === 'AGENTS.md')).toHaveLength(1);
    expect(paths).toContain('GEMINI.md');
    expect(paths).toContain('.gemini/settings.json');
    expect(paths).toContain('.sdlc/githooks/pre-commit');
    expect(paths).toContain('.gitignore');
  });

  it('renders the hook files of each hook harness and the launcher once; agents-md alone gets none', () => {
    const { changes } = all(configWith('', '[claude, codex, gemini, agents-md]'));
    const paths = changes.map(c => c.path);
    expect(paths).toContain('.claude/settings.json');
    expect(paths).toContain('.codex/hooks.json');
    expect(paths.filter(p => p === '.sdlc/hooks/run.sh')).toHaveLength(1);
    expect(changes.find(c => c.path === '.sdlc/hooks/run.sh')).toMatchObject({ kind: 'file', mode: 0o755 });

    const agentsOnly = all(configWith('', '[agents-md]')).changes.map(c => c.path);
    expect(agentsOnly).not.toContain('.sdlc/hooks/run.sh');
    expect(agentsOnly.filter(p => p.endsWith('settings.json') || p.endsWith('hooks.json'))).toEqual([]);
  });

  it('fuses the Gemini hooks with its MCP servers in one .gemini/settings.json change', () => {
    const { changes } = all(configWith('', '[gemini]'));
    const settings = changes.filter(c => c.path === '.gemini/settings.json');
    expect(settings).toHaveLength(1);
    const [change] = settings as JsonKeysChange[];
    expect(change?.entries.map(e => e.pointer.join('/'))).toEqual([
      'mcpServers/github',
      'hooks/SessionStart',
      'hooks/BeforeAgent',
      'hooks/BeforeTool',
    ]);
  });

  it('names how to trust the Codex and Gemini hooks in the notes', () => {
    const { notes } = all(configWith('', '[claude, codex, gemini]'));
    expect(notes).toContain(
      'Codex runs project hooks only in a trusted project after you review them: open codex in this repository, trust it, then run /hooks and approve the sdlc hooks.',
    );
    expect(notes).toContain(
      'Gemini CLI loads project hooks only in a trusted folder: run gemini in this repository and trust the folder.',
    );
    expect(all(configWith('', '[claude]')).notes.filter(note => note.includes('hooks'))).toEqual([]);
  });

  it('returns the user-scope commands and the notes, with the notices of custom roles first', () => {
    const custom = '---\nrole: developer\ndescription: Ours.\ntier: standard\ncan_edit: true\nreturns: a report\nescalate_when: unsure\n---\nYou build.\n';
    const fs = memoryFs({ '.sdlc/agents/custom/developer.md': custom });
    const { userCommands, notes, changes } = all(configWith('mcp: { scope: user }'), fs);
    expect(userCommands).toHaveLength(2);
    expect(userCommands[0]).toMatch(/^claude mcp add /);
    expect(userCommands[1]).toMatch(/^codex mcp add /);
    expect(notes[0]).toContain('custom role "developer"');
    expect(notes).toContain('export GITHUB_PERSONAL_ACCESS_TOKEN before starting your agent');
    expect(changes.some(c => c.path === '.mcp.json')).toBe(false);
  });
});

describe('mergeChanges', () => {
  const json = (...entries: Array<[string[], unknown]>): Change => ({
    kind: 'json-keys',
    path: 'x.json',
    entries: entries.map(([pointer, value]) => ({ pointer, value })),
  });
  const toml = (content: string, ...tables: string[]): Change => ({ kind: 'toml-block', path: 'c.toml', content, ownedTables: tables });

  it('concatenates json-keys entries of one path and keeps a duplicate pointer with the same value once', () => {
    const [merged] = mergeChanges([
      json([['mcpServers', 'a'], { url: 'u' }]),
      json([['mcpServers', 'b'], { url: 'v' }], [['mcpServers', 'a'], { url: 'u' }]),
    ]);
    expect(merged).toEqual(json([['mcpServers', 'a'], { url: 'u' }], [['mcpServers', 'b'], { url: 'v' }]));
  });

  it('throws for a pointer with two different values', () => {
    expect(() => mergeChanges([json([['mcpServers', 'a'], { url: 'u' }]), json([['mcpServers', 'a'], { url: 'w' }])])).toThrow(
      /mcpServers\/a/,
    );
  });

  describe('items entries', () => {
    const hook = (command: string) => ({ matcher: 'Bash', hooks: [{ type: 'command', command }] });
    const items = (event: string, value: unknown[], marker = 'sdlc hook') => ({ pointer: ['hooks', event], value, items: { marker } });
    const gemini = (...entries: JsonKeysChange['entries']): Change => ({ kind: 'json-keys', path: '.gemini/settings.json', entries });
    const server = { pointer: ['mcpServers', 'github'], value: { httpUrl: 'u' } };

    it('fuses a plain mcpServers entry and a hooks items entry of one file into one change, items intact', () => {
      const mcp = gemini(server);
      const hooks = gemini(items('BeforeTool', [hook('sdlc hook before-tool')]));
      expect(mergeChanges([mcp, hooks])).toEqual([gemini(server, items('BeforeTool', [hook('sdlc hook before-tool')]))]);
      expect(mergeChanges([hooks, mcp])).toEqual([gemini(items('BeforeTool', [hook('sdlc hook before-tool')]), server)]);
    });

    it('keeps an identical items entry once and throws when the items or the marker differ', () => {
      const a = gemini(items('BeforeTool', [hook('sdlc hook a')]));
      expect(mergeChanges([a, a])).toEqual([a]);
      expect(() => mergeChanges([a, gemini(items('BeforeTool', [hook('sdlc hook b')]))])).toThrow(/hooks\/BeforeTool/);
      expect(() => mergeChanges([a, gemini(items('BeforeTool', [hook('sdlc hook a')], 'sdlc hook a'))])).toThrow(/hooks\/BeforeTool/);
      expect(() => mergeChanges([a, gemini({ pointer: ['hooks', 'BeforeTool'], value: [hook('sdlc hook a')] })])).toThrow(/hooks\/BeforeTool/);
    });
  });

  it('joins toml-block bodies of one path with a blank line and lists every table', () => {
    const [merged] = mergeChanges([toml('[mcp_servers.a]\nx = 1', 'mcp_servers.a'), toml('[mcp_servers.b]\ny = 2', 'mcp_servers.b')]);
    expect(merged).toEqual(toml('[mcp_servers.a]\nx = 1\n\n[mcp_servers.b]\ny = 2', 'mcp_servers.a', 'mcp_servers.b'));
  });

  it('keeps file, md-block and line-block duplicates once when identical and throws when they differ', () => {
    const file = (content: string): Change => ({ kind: 'file', path: 'f.md', content });
    const md = (content: string): Change => ({ kind: 'md-block', path: 'A.md', content });
    expect(mergeChanges([file('a'), md('b'), file('a'), md('b')])).toEqual([md('b'), file('a')]);
    expect(() => mergeChanges([file('a'), file('b')])).toThrow(/f\.md/);
    expect(() => mergeChanges([md('a'), md('b')])).toThrow(/A\.md/);
    expect(() => mergeChanges([file('a'), { kind: 'md-block', path: 'f.md', content: 'a' }])).toThrow(/f\.md/);
  });
});

// --- init -----------------------------------------------------------------------------------------

describe('sdlc init', () => {
  it('init into an empty repository creates exactly the managed files and reports every step', async () => {
    const h = setup();
    h.useGh(emptyGithub(cfgOf(CONFIG), false));

    await h.go(['init', '--json']);

    expect(Object.keys(h.fs.snapshot())).toEqual(INIT_PATHS);
    expect(process.exitCode).toBeUndefined();
    const report = h.report();
    expect(report.steps.map(s => [s.name, s.status])).toEqual([
      ['config', 'ok'],
      ['files', 'ok'],
      ['git hooks path', 'ok'],
      ['board', 'ok'],
      ['labels', 'ok'],
      ['branch protection', 'ok'],
      ['push protection', 'ok'],
      ['next steps', 'ok'],
    ]);
    expect(report.plan.writes.map(w => w.path)).toEqual(INIT_PATHS.filter(p => p !== '.sdlc/manifest.json'));
    expect(new Set(report.plan.writes.map(w => w.action))).toEqual(new Set(['create']));
    expect(report.plan.notices).toEqual([]);
    expect(report.plan.errors).toEqual([]);

    // hooks are executable, the manifest lists what was written, and git points at the hooks
    expect(h.fs.modes.get('.sdlc/githooks/pre-commit')).toBe(0o755);
    expect(h.fs.modes.get('.sdlc/hooks/run.sh')).toBe(0o755);
    expect(readManifest(h.fs)?.kit).toBe(packageVersion());
    expect(h.git.hooksPath()).toBe('.sdlc/githooks');
    // GitHub was provisioned: labels, branch protection and push protection
    expect(mutations(h.gh).map(args => args.slice(0, 2).join(' '))).toEqual([
      'label create',
      'label create',
      'label create',
      'label create',
      'api -X',
      'api -X',
    ]);
  });

  it('init merges hooks into customized settings', async () => {
    const original =
      '{\n' +
      '  "permissions": {\n    "allow": ["Bash(npm test)"]\n  },\n' +
      '  "hooks": {\n' +
      '    "PreToolUse": [\n' +
      '      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "./scripts/our-check.sh" }] }\n' +
      '    ]\n' +
      '  }\n' +
      '}\n';
    const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/our-check.sh' }] };
    const h = await installed({ '.claude/settings.json': original });

    const settings = JSON.parse(h.fs.files.get('.claude/settings.json') as string) as {
      permissions: unknown;
      hooks: Record<string, unknown[]>;
    };
    // the user's permissions and their own PreToolUse hook are kept; ours are appended after theirs
    expect(settings.permissions).toEqual({ allow: ['Bash(npm test)'] });
    expect(Object.keys(settings.hooks)).toEqual(['PreToolUse', 'SessionStart', 'UserPromptSubmit']);
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(settings.hooks.PreToolUse?.[0]).toEqual(mine);
    expect(JSON.stringify(settings.hooks.PreToolUse?.[1])).toContain('.sdlc/hooks/run.sh');
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);

    // a second init changes nothing
    await h.go(['init']);
    expect(JSON.parse(h.fs.files.get('.claude/settings.json') as string)).toEqual(settings);

    await h.go(['uninstall']);

    expect(h.fs.files.get('.claude/settings.json')).toBe(original);
    expect(h.fs.files.has('.sdlc/hooks/run.sh')).toBe(false);
  });

  it('prints the plan, the steps, the user commands, the notes and the next steps for a person', async () => {
    const h = setup();
    h.useGh(emptyGithub(cfgOf(CONFIG), false));

    await h.go(['init']);

    const text = h.text();
    expect(text).toContain('[ok] config');
    expect(text).toContain('[ok] files');
    expect(text).toContain('create CLAUDE.md');
    expect(text).toContain(`${INIT_PATHS.length - 1} changes`);
    expect(text).toContain('[ok] git hooks path');
    expect(text).toContain('[ok] labels');
    expect(text).toContain('export GITHUB_PERSONAL_ACCESS_TOKEN before starting your agent');
    expect(text).toContain('commit the changes on a branch and open the install PR "chore: install agentic-sdlc-kit"');
    expect(text).toContain('run sdlc doctor');
    expect(text).toContain('add the SDLC_TOKEN secret: gh secret set SDLC_TOKEN');
    expect(text.indexOf('[ok] config')).toBeLessThan(text.indexOf('[ok] files'));
    expect(text.indexOf('[ok] files')).toBeLessThan(text.indexOf('[ok] board'));
    expect(h.err).toEqual([]);
  });

  it('prints the commands the owner runs themselves for user-scope MCP servers, in the report and the JSON', async () => {
    const config = configWith('stack: { actions: true }\nmcp: { scope: user }');
    const { userCommands } = renderAll(cfgOf(config), memoryFs());
    expect(userCommands).toHaveLength(2);
    const h = setup({ config });
    h.useGh(emptyGithub(cfgOf(config), false));

    await h.go(['init']);

    for (const command of userCommands) expect(h.text()).toContain(`  run yourself: ${command}`);
    // user scope: nothing is written to the project's MCP files
    expect(h.fs.files.has('.mcp.json')).toBe(false);
    expect(h.fs.files.has('.codex/config.toml')).toBe(false);

    const json = setup({ config });
    json.useGh(emptyGithub(cfgOf(config), false));
    await json.go(['init', '--json']);
    const next = json.report().steps.find(step => step.name === 'next steps');
    expect(next?.details.filter(line => line.startsWith('run yourself: '))).toEqual(userCommands.map(c => `run yourself: ${c}`));
  });

  it('leaves out the SDLC_TOKEN step when Actions are off', async () => {
    const h = setup({ config: configWith('stack: { actions: false }') });
    h.useGh(emptyGithub(cfgOf(CONFIG), false));

    await h.go(['init']);

    expect(h.text()).toContain('run sdlc doctor');
    expect(h.text()).not.toContain('SDLC_TOKEN');
    expect(h.fs.files.has('.github/workflows/sdlc-reconcile.yml')).toBe(false);
  });

  it('a second init is a no-op: no write, everything up to date, nothing changed on GitHub', async () => {
    const h = await installed();
    const writesAfterFirst = [...h.fs.log];
    const manifest = h.fs.files.get('.sdlc/manifest.json');
    const gitCallsAfterFirst = h.git.calls.length;
    const gh = h.useGh(readyGithub(cfgOf(CONFIG)));

    await h.go(['init', '--json']);

    expect(h.fs.log).toEqual(writesAfterFirst);
    expect(h.fs.files.get('.sdlc/manifest.json')).toBe(manifest);
    const report = h.report();
    expect(report.plan).toEqual({ writes: [], notices: [], errors: [] });
    expect(report.steps.find(s => s.name === 'files')?.details).toContain('Everything is up to date');
    expect(report.steps.every(s => s.status === 'ok')).toBe(true);
    expect(mutations(gh)).toEqual([]);
    // the hooks path is already set, so nothing is written to the git config
    expect(h.git.calls.slice(gitCallsAfterFirst)).toEqual([['config', '--get', 'core.hooksPath'], ['rev-parse', '--git-common-dir']]);
    expect(process.exitCode).toBeUndefined();
  });

  describe('into a customized repository', () => {
    const USER_CLAUDE = '# Shop\n\nOur own rules.\n';
    const USER_MCP = `${JSON.stringify({ mcpServers: { github: { command: 'our-github-mcp' } } }, null, 2)}\n`;
    const USER_TOML = 'model = "gpt-5"\napproval_policy = "on-request"\n';
    const USER_IGNORE = 'node_modules/\ndist/\n';
    const USER_FILES = {
      'CLAUDE.md': USER_CLAUDE,
      '.mcp.json': USER_MCP,
      '.codex/config.toml': USER_TOML,
      '.gitignore': USER_IGNORE,
      'src/index.ts': 'export {};\n',
    };

    it('keeps every byte outside its managed regions and does not take over the user server', async () => {
      const h = setup({ files: USER_FILES });
      h.useGh(emptyGithub(cfgOf(CONFIG), false));

      await h.go(['init', '--json']);

      const files = h.fs.snapshot();
      expect(files['CLAUDE.md']?.startsWith(USER_CLAUDE)).toBe(true);
      expect(files['CLAUDE.md']).toContain('<!-- sdlc:begin -->');
      expect(files['.codex/config.toml']?.startsWith(USER_TOML)).toBe(true);
      expect(files['.codex/config.toml']).toContain('[mcp_servers.github]');
      expect(files['.gitignore']?.startsWith(USER_IGNORE)).toBe(true);
      expect(files['src/index.ts']).toBe('export {};\n');
      // the user's own github server stays as it is, and the manifest does not claim it
      expect(files['.mcp.json']).toBe(USER_MCP);
      expect(readManifest(h.fs)?.entries.some(e => e.path === '.mcp.json')).toBe(false);
      expect(h.report().plan.notices).toEqual([{ path: '.mcp.json', message: 'mcpServers/github already defined by you; kept' }]);
      expect(process.exitCode).toBeUndefined();
    });

    it('skips a whole file it would create that is not its own, with a notice', async () => {
      const h = setup({ files: { '.github/pull_request_template.md': 'Our template\n' } });
      h.useGh(emptyGithub(cfgOf(CONFIG), false));

      await h.go(['init', '--json']);

      expect(h.fs.files.get('.github/pull_request_template.md')).toBe('Our template\n');
      expect(h.report().plan.notices).toEqual([
        { path: '.github/pull_request_template.md', message: 'exists, not managed by sdlc; kept' },
      ]);
      expect(h.text()).toContain('keep .github/pull_request_template.md (exists, not managed by sdlc; kept)');
      expect(process.exitCode).toBeUndefined();
    });
  });

  it('lists the existing .git/hooks it chains, in a dry run and a real run, and the ones it cannot run', async () => {
    for (const dryRun of [true, false]) {
      const h = setup({ legacyHooks: { 'pre-commit': 'executable', 'pre-push': 'executable', 'post-merge': 'not-executable' } });
      h.useGh(emptyGithub(cfgOf(CONFIG), dryRun));

      await h.go(['init', ...(dryRun ? ['--dry-run'] : []), '--json']);

      const details = h.report().steps.find(s => s.name === 'git hooks path')?.details ?? [];
      expect(details).toContain(
        `${dryRun ? 'dry run: the sdlc hooks would chain' : 'the sdlc hooks chain'} your existing hooks in .git/hooks: pre-commit, pre-push ` +
          '(each runs after the sdlc step, with the same arguments, and its exit code counts)',
      );
      expect(details).toContain('not executable, so not run: .git/hooks/post-merge (chmod +x to run it after the sdlc step)');
    }
  });

  it('says nothing about legacy hooks when there are none', async () => {
    const h = setup();
    h.useGh(emptyGithub(cfgOf(CONFIG), false));

    await h.go(['init', '--json']);

    expect(h.report().steps.find(s => s.name === 'git hooks path')?.details).toEqual(['core.hooksPath set to .sdlc/githooks']);
  });

  it('--dry-run writes nothing, changes nothing in git and makes only read calls to GitHub', async () => {
    const h = setup();
    const gh = h.useGh(emptyGithub(cfgOf(CONFIG), true));

    await h.go(['init', '--dry-run', '--json']);

    expect(h.fs.log).toEqual([]);
    expect(h.fs.snapshot()).toEqual({});
    expect(gh.calls).toHaveLength(4);
    expect(mutations(gh)).toEqual([]);
    expect(h.git.calls).toEqual([['config', '--get', 'core.hooksPath'], ['rev-parse', '--git-common-dir']]);
    expect(h.git.hooksPath()).toBeUndefined();
    const report = h.report();
    // everything a real run would write is still listed, and the steps that would change something did not run
    expect(report.plan.writes.map(w => w.path)).toEqual(INIT_PATHS.filter(p => p !== '.sdlc/manifest.json'));
    expect(report.steps.map(s => [s.name, s.status])).toEqual([
      ['config', 'ok'],
      ['files', 'skipped'],
      ['git hooks path', 'skipped'],
      ['board', 'ok'],
      ['labels', 'skipped'],
      ['branch protection', 'skipped'],
      ['push protection', 'skipped'],
      ['next steps', 'ok'],
    ]);
    const details = (name: string): string => report.steps.find(s => s.name === name)?.details.join('\n') ?? '';
    expect(details('files')).toContain('(dry run: nothing written)');
    expect(details('labels')).toContain('dry run: would create labels: sdlc:task, sdlc:partial, type:tooling, type:analysis');
    expect(details('branch protection')).toContain('dry run: would protect main');
    expect(details('push protection')).toContain('dry run: would enable secret scanning and push protection');
    expect(details('next steps')).toContain('rerun without --dry-run');
    expect(details('next steps')).not.toContain('open the install PR');
    expect(process.exitCode).toBeUndefined();
  });

  it('--skip-github makes no gh call and reports the GitHub steps as skipped', async () => {
    const h = setup();
    const gh = h.useGh([]);

    await h.go(['init', '--skip-github', '--json']);

    expect(gh.calls).toEqual([]);
    expect(Object.keys(h.fs.snapshot())).toEqual(INIT_PATHS);
    const report = h.report();
    expect(report.steps.map(s => [s.name, s.status])).toEqual([
      ['config', 'ok'],
      ['files', 'ok'],
      ['git hooks path', 'ok'],
      ['board', 'skipped'],
      ['labels', 'skipped'],
      ['branch protection', 'skipped'],
      ['push protection', 'skipped'],
      ['next steps', 'ok'],
    ]);
    expect(report.steps.find(s => s.name === 'board')?.details).toEqual(['--skip-github']);
    expect(process.exitCode).toBeUndefined();
  });

  describe('without github.project.number', () => {
    const NEW_CONFIG = `${HEADER.replace(', number: 7', '')}harnesses: [claude]\n`;
    const URL = 'https://github.com/orgs/acme/projects/12';
    const created = (): FakeGhStep[] => [
      { match: ['graphql'], stdout: JSON.stringify({ data: { owner: { id: 'O_acme' }, repo: { id: 'R_shop' } } }) },
      { match: ['graphql'], stdout: JSON.stringify({ data: { createProjectV2: { projectV2: { id: 'PVT_new', number: 12, url: URL } } } }) },
    ];
    const newProject = (cfg: Config): FakeGhStep => {
      const nodes = [
        { id: 'F_title', name: 'Title', dataType: 'TITLE' },
        ...desiredFields(cfg).map((f, i) => ({
          id: `PF_${i}`,
          name: f.name,
          dataType: f.dataType,
          ...(f.options && { options: f.options.map((name, j) => ({ id: `PF_${i}_${j}`, name })) }),
        })),
      ];
      return { match: ['graphql'], stdout: JSON.stringify({ data: { node: { id: 'PVT_new', number: 12, fields: { nodes }, views: { nodes: [] } } } }) };
    };

    it('prints the number of the project it created with the instruction to set it, and never edits the config', async () => {
      const cfg = cfgOf(NEW_CONFIG);
      const h = setup({ config: NEW_CONFIG });
      h.useGh([
        ...created(),
        newProject(cfg),
        { match: ['api', '/orgs/acme/projectsV2/12/fields?per_page=100'], stdout: JSON.stringify(Object.values(FIELD_NAMES).map((name, id) => ({ id, name }))) },
        ...VIEWS.map((): FakeGhStep => ({ match: ['api', '-X', 'POST', '/orgs/acme/projectsV2/12/views'] })),
        { match: ['label', 'list'], stdout: '[]' },
        ...LABELS.map((): FakeGhStep => ({ match: ['label', 'create'] })),
        { match: PROTECTION, stdout: '{}' },
        { match: ['api', 'repos/acme/shop', '--jq'], stdout: JSON.stringify({ secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } }) },
      ]);

      await h.go(['init', '--json']);

      const board = h.report().steps.find(s => s.name === 'board');
      expect(board?.status).toBe('ok');
      const text = board?.details.join('\n') ?? '';
      expect(text).toContain(`Created project #12 (${URL})`);
      expect(text).toContain('set github.project.number: 12 in sdlc.config.yaml');
      expect(text).toContain('init never edits your config');
      expect(h.report().steps.map(s => s.status)).not.toContain('failed');
      // init wrote managed files only: the config it was given is not among them
      expect(h.fs.files.has('sdlc.config.yaml')).toBe(false);
      expect(h.fs.log.some(entry => entry.includes('sdlc.config'))).toBe(false);
      expect(process.exitCode).toBeUndefined();
    });

    it('keeps the number in the report when provisioning the new project fails, and exits 1', async () => {
      const h = setup({ config: NEW_CONFIG });
      h.useGh([
        ...created(),
        newProject(cfgOf(NEW_CONFIG)),
        { match: ['api', '/orgs/acme/projectsV2/12/fields?per_page=100'], code: 1, stderr: 'gh: Server Error (HTTP 500)' },
        { match: ['label', 'list'], stdout: '[]' },
        ...LABELS.map((): FakeGhStep => ({ match: ['label', 'create'] })),
        { match: PROTECTION, stdout: '{}' },
        { match: ['api', 'repos/acme/shop', '--jq'], stdout: '{}' },
        { match: ['PATCH'] },
      ]);

      await h.go(['init', '--json']);

      const report = h.report();
      const board = report.steps.find(s => s.name === 'board');
      expect(board?.status).toBe('failed');
      const text = board?.details.join('\n') ?? '';
      expect(text).toContain(`Created project #12 (${URL})`);
      expect(text).toContain('Failed views:');
      expect(text).toContain('HTTP 500');
      // the other steps still ran
      expect(report.steps.filter(s => s.name !== 'board').every(s => s.status === 'ok')).toBe(true);
      expect(process.exitCode).toBe(1);
    });
  });

  it('stops at an invalid config: one failed step, nothing written, no gh call, exit code 1', async () => {
    const h = setup({ config: configWith('mcp: { servers: [nope] }') });
    const gh = h.useGh([]);

    await h.go(['init', '--json']);

    const report = h.report();
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]).toMatchObject({ name: 'config', status: 'failed' });
    expect(report.steps[0]?.details.join('\n')).toContain('mcp.servers');
    expect(report.plan).toEqual({ writes: [], notices: [], errors: [] });
    expect(h.fs.log).toEqual([]);
    expect(gh.calls).toEqual([]);
    expect(h.git.calls).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('a failed write exits 1 but the other files and the later steps still run and are reported', async () => {
    const h = setup({
      wrapFs: fs => ({
        ...fs,
        write(p, content, mode) {
          if (p === '.mcp.json') throw new Error('EACCES: permission denied');
          fs.write(p, content, mode);
        },
      }),
    });
    h.useGh(emptyGithub(cfgOf(CONFIG), false));

    await h.go(['init', '--json']);

    expect(process.exitCode).toBe(1);
    const report = h.report();
    expect(report.steps.map(s => [s.name, s.status])).toEqual([
      ['config', 'ok'],
      ['files', 'failed'],
      ['git hooks path', 'skipped'],
      ['board', 'ok'],
      ['labels', 'ok'],
      ['branch protection', 'ok'],
      ['push protection', 'ok'],
      ['next steps', 'ok'],
    ]);
    expect(report.plan.errors).toEqual([{ path: '.mcp.json', message: 'EACCES: permission denied' }]);
    expect(report.steps[1]?.details.join('\n')).toContain('error .mcp.json: EACCES: permission denied');
    // the hook scripts may be missing, so git is not pointed at them
    expect(report.steps[2]?.details.join('\n')).toContain('core.hooksPath not changed: writing the files failed');
    expect(h.git.hooksPath()).toBeUndefined();
    expect(h.fs.files.has('CLAUDE.md')).toBe(true);
    expect(h.fs.files.has('.mcp.json')).toBe(false);
    // the manifest does not claim the file that was not written
    expect(readManifest(h.fs)?.entries.some(e => e.path === '.mcp.json')).toBe(false);
  });

  it('--overwrite-modified replaces a managed file the user edited', async () => {
    const h = await installed();
    const path = '.claude/agents/sdlc-developer.md';
    const original = h.fs.files.get(path) as string;
    h.fs.files.set(path, `${original}\nmy tweak\n`);
    h.useGh(readyGithub(cfgOf(CONFIG)));

    await h.go(['init']);
    expect(h.fs.files.get(path)).toBe(`${original}\nmy tweak\n`);
    expect(h.text()).toContain(`keep ${path} (modified locally; kept (rerun with --overwrite-modified to replace))`);
    expect(process.exitCode).toBeUndefined();

    h.useGh(readyGithub(cfgOf(CONFIG)));
    await h.go(['init', '--overwrite-modified']);
    expect(h.fs.files.get(path)).toBe(original);
  });

  it('a failing GitHub step is reported as failed with the gh command, and the other steps still run', async () => {
    const cfg = cfgOf(CONFIG);
    const h = setup();
    h.useGh([
      provisionedBoard(cfg),
      { match: ['label', 'list'], code: 1, stderr: 'gh: Bad credentials (HTTP 401)' },
      { match: PROTECTION, stdout: '{}' },
      { match: ['api', 'repos/acme/shop', '--jq'], stdout: JSON.stringify({ secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } }) },
    ]);

    await h.go(['init', '--json']);

    expect(h.stepStatuses()).toEqual([
      ['config', 'ok'],
      ['files', 'ok'],
      ['git hooks path', 'ok'],
      ['board', 'ok'],
      ['labels', 'failed'],
      ['branch protection', 'ok'],
      ['push protection', 'ok'],
      ['next steps', 'ok'],
    ]);
    expect(h.report().steps.find(s => s.name === 'labels')?.details.join('\n')).toContain('Bad credentials');
    expect(process.exitCode).toBe(1);
  });

  it('says so when another core.hooksPath is set: the hooks are not active, nothing is changed', async () => {
    const h = setup({ hooksPath: '.husky' });
    h.useGh(emptyGithub(cfgOf(CONFIG), false));

    await h.go(['init', '--json']);

    expect(h.git.hooksPath()).toBe('.husky');
    const step = h.report().steps.find(s => s.name === 'git hooks path');
    expect(step?.status).toBe('skipped');
    expect(step?.details.join('\n')).toContain('core.hooksPath is already set to ".husky"');
    expect(process.exitCode).toBeUndefined();
  });
});

// --- upgrade --------------------------------------------------------------------------------------

describe('sdlc upgrade', () => {
  const TWO_SERVERS = configWith('stack: { actions: true }\nmcp: { servers: [github, context7] }');

  it('reports the kit versions, with "none" for a repository without a manifest', async () => {
    const h = setup();

    await h.go(['upgrade', '--json']);

    expect(h.report().steps[1]?.details[0]).toBe(`kit none → ${packageVersion()}`);
    // upgrade never touches GitHub
    expect((h.context.gh as FakeGh).calls).toEqual([]);
  });

  it('with no template change writes nothing and says everything is up to date', async () => {
    const h = await installed();
    const log = [...h.fs.log];
    const gh = h.useGh([]);

    await h.go(['upgrade', '--json']);

    expect(h.fs.log).toEqual(log);
    expect(gh.calls).toEqual([]);
    const files = h.report().steps.find(s => s.name === 'files');
    expect(files?.details).toEqual([`kit ${packageVersion()} → ${packageVersion()}`, 'Everything is up to date']);
    expect(h.report().steps.map(s => s.name)).toEqual(['config', 'files', 'git hooks path']);
    expect(process.exitCode).toBeUndefined();
  });

  it('updates what a changed config renders and removes what it no longer renders; a modified file is kept', async () => {
    const h = await installed({}, TWO_SERVERS);
    const manifest = h.fs.files.get('.sdlc/manifest.json') as string;
    h.fs.files.set('.sdlc/manifest.json', manifest.replace(`"kit": "${packageVersion()}"`, '"kit": "0.0.9"'));
    const modified = '.claude/agents/sdlc-developer.md';
    const edited = `${h.fs.files.get(modified)}\nmy tweak\n`;
    h.fs.files.set(modified, edited);
    // the new config drops the context7 server and the codex harness
    h.setConfig(configWith('stack: { actions: true }\nmcp: { servers: [github] }', '[claude]'));
    const gh = h.useGh([]);

    await h.go(['upgrade', '--json']);

    const report = h.report();
    expect(report.steps.find(s => s.name === 'files')?.details[0]).toBe(`kit 0.0.9 → ${packageVersion()}`);
    const files = h.fs.snapshot();
    expect(Object.keys(files).filter(p => p.startsWith('.codex/') || p.startsWith('.agents/') || p === 'AGENTS.md')).toEqual([]);
    expect(JSON.parse(files['.mcp.json'] as string)).toEqual({
      mcpServers: { github: expect.objectContaining({ url: expect.any(String) }) },
    });
    expect(files[modified]).toBe(edited);
    expect(report.plan.writes).toEqual(
      expect.arrayContaining([
        { path: '.mcp.json', action: 'update' },
        { path: '.codex/config.toml', action: 'remove' },
        { path: '.codex/agents/sdlc-developer.toml', action: 'remove' },
        { path: '.agents/skills/sdlc-delivery/SKILL.md', action: 'remove' },
      ]),
    );
    expect(report.plan.notices).toEqual([{ path: modified, message: 'modified locally; kept (rerun with --overwrite-modified to replace)' }]);
    expect(readManifest(h.fs)?.kit).toBe(packageVersion());
    expect(process.exitCode).toBeUndefined();
    expect(gh.calls).toEqual([]);
  });

  it('dropping codex removes only our hooks from a .codex/hooks.json the user already had, and restores it byte for byte', async () => {
    const original =
      '{\n' +
      '  "hooks": {\n' +
      '    "PreToolUse": [\n' +
      '      { "matcher": "^Bash$", "hooks": [{ "type": "command", "command": "./scripts/our-check.sh", "timeout": 5 }] }\n' +
      '    ]\n' +
      '  }\n' +
      '}\n';
    const h = await installed({ '.codex/hooks.json': original });
    const hooks = (JSON.parse(h.fs.files.get('.codex/hooks.json') as string) as { hooks: Record<string, unknown[]> }).hooks;
    // their hook first, ours after it; the events they did not use were added whole
    expect(Object.keys(hooks)).toEqual(['PreToolUse', 'SessionStart', 'UserPromptSubmit']);
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(JSON.stringify(hooks.PreToolUse?.[0])).toContain('our-check.sh');
    expect(JSON.stringify(hooks.PreToolUse?.[1])).toContain('.sdlc/hooks/run.sh');
    h.setConfig(configWith('stack: { actions: true }', '[claude]'));

    await h.go(['upgrade']);

    expect(process.exitCode).toBeUndefined();
    expect(h.fs.files.get('.codex/hooks.json')).toBe(original);
    // claude is still configured: its hooks and the launcher stay
    expect(JSON.stringify(h.fs.files.get('.claude/settings.json'))).toContain('.sdlc/hooks/run.sh');
    expect(h.fs.files.has('.sdlc/hooks/run.sh')).toBe(true);
  });

  it('--dry-run lists the update and the removals and changes nothing', async () => {
    const h = await installed({}, TWO_SERVERS);
    const before = h.fs.snapshot();
    const logLength = h.fs.log.length;
    const gitCalls = h.git.calls.length;
    h.setConfig(configWith('stack: { actions: true }\nmcp: { servers: [github] }', '[claude]'));

    await h.go(['upgrade', '--dry-run']);

    expect(h.fs.snapshot()).toEqual(before);
    expect(h.fs.log).toHaveLength(logLength);
    expect(h.git.calls.slice(gitCalls).every(args => args.includes('--get') || args.includes('rev-parse'))).toBe(true);
    const text = h.text();
    expect(text).toContain('update .mcp.json');
    expect(text).toContain('remove .codex/agents/sdlc-developer.toml (no longer generated)');
    expect(text).toContain('(dry run: nothing written)');
  });

  describe('an obsolete file the user modified', () => {
    const MODIFIED = '.codex/agents/sdlc-developer.toml';
    const claudeOnly = configWith('stack: { actions: true }', '[claude]');
    const count = (text: string): string => `${text.split('\n').filter(line => /^(create|update|remove) /.test(line)).length} changes`;

    const filesStep = (report: Report): string[] => report.steps.find(step => step.name === 'files')?.details ?? [];

    it('is kept: no remove line for it, a keep line instead, and it is not counted', async () => {
      const h = await installed();
      const edited = `${h.fs.files.get(MODIFIED)}\n# my tweak\n`;
      h.fs.files.set(MODIFIED, edited);
      h.setConfig(claudeOnly);

      await h.go(['upgrade', '--json']);

      const details = filesStep(h.report()).join('\n');
      expect(h.fs.files.get(MODIFIED)).toBe(edited);
      expect(details).not.toContain(`remove ${MODIFIED}`);
      expect(details).toContain(`keep ${MODIFIED} (no longer generated by sdlc and modified locally; kept)`);
      // the others were removed, and the last line counts exactly the create/update/remove lines
      expect(details).toContain('remove .codex/agents/sdlc-analyst.toml (no longer generated)');
      expect(details.split('\n').at(-1)).toBe(count(details));
      // 10 codex agents (not the modified one) + .codex/config.toml + the AGENTS.md block + 3 .agents skills
      // + the 3 hook events of .codex/hooks.json, which goes away with them
      expect(count(details)).toBe('18 changes');
      expect(h.fs.files.has('.codex/hooks.json')).toBe(false);
      expect(h.fs.files.has('.codex/agents/sdlc-analyst.toml')).toBe(false);
      expect(process.exitCode).toBeUndefined();
    });

    it('is reported the same way in JSON, and a dry run says the same as the real run', async () => {
      const h = await installed();
      h.fs.files.set(MODIFIED, `${h.fs.files.get(MODIFIED)}\n# my tweak\n`);
      h.setConfig(claudeOnly);

      await h.go(['upgrade', '--dry-run', '--json']);
      const dry = h.report();
      await h.go(['upgrade', '--json']);
      const real = h.report();

      expect(real.plan.writes.map(w => w.path)).not.toContain(MODIFIED);
      expect(real.plan.notices).toContainEqual({ path: MODIFIED, message: 'no longer generated by sdlc and modified locally; kept' });
      expect(dry.plan.writes.map(w => w.path)).toEqual(real.plan.writes.map(w => w.path));
      expect(dry.plan.notices).toEqual(real.plan.notices);
      expect(dry.plan.errors).toEqual(real.plan.errors);
      expect(filesStep(dry).join('\n').replace(' (dry run: nothing written)', '')).toBe(filesStep(real).join('\n'));
    });

    it('is not counted as a removal for an obsolete file that is already gone', async () => {
      const h = await installed();
      h.fs.files.delete(MODIFIED);
      h.setConfig(claudeOnly);

      await h.go(['upgrade']);

      expect(h.text()).not.toContain(MODIFIED);
      expect(h.text()).toContain('remove .codex/agents/sdlc-analyst.toml (no longer generated)');
    });
  });

  it('a failed write exits 1 but the other files and the later steps still run and are reported', async () => {
    const h = setup({
      wrapFs: fs => ({
        ...fs,
        write(p, content, mode) {
          if (p === '.mcp.json') throw new Error('EACCES: permission denied');
          fs.write(p, content, mode);
        },
      }),
    });

    await h.go(['upgrade', '--json']);

    expect(process.exitCode).toBe(1);
    expect(h.stepStatuses()).toEqual([
      ['config', 'ok'],
      ['files', 'failed'],
      ['git hooks path', 'skipped'],
    ]);
    expect(h.report().plan.errors).toEqual([{ path: '.mcp.json', message: 'EACCES: permission denied' }]);
    expect(h.fs.files.has('CLAUDE.md')).toBe(true);
    expect(h.fs.files.has('.mcp.json')).toBe(false);
    expect((h.context.gh as FakeGh).calls).toEqual([]);
  });

  it('--overwrite-modified replaces the edited file', async () => {
    const h = await installed();
    const path = '.claude/agents/sdlc-developer.md';
    const original = h.fs.files.get(path) as string;
    h.fs.files.set(path, 'rewritten by the user\n');

    await h.go(['upgrade', '--overwrite-modified']);

    expect(h.fs.files.get(path)).toBe(original);
  });

  it('an invalid config fails the config step and stops', async () => {
    const h = setup({ config: configWith('mcp: { servers: [nope] }') });

    await h.go(['upgrade', '--json']);

    expect(h.stepStatuses()).toEqual([['config', 'failed']]);
    expect(process.exitCode).toBe(1);
  });
});

// --- uninstall ------------------------------------------------------------------------------------

describe('sdlc uninstall', () => {
  const FIXTURE: Record<string, string> = {
    'CLAUDE.md': '# Shop\n\nOur own rules.\n',
    '.mcp.json': `${JSON.stringify({ mcpServers: { mine: { command: 'our-mcp' } } }, null, 2)}\n`,
    '.codex/config.toml': 'model = "gpt-5"\n',
    '.gitignore': 'node_modules/\n',
    'src/index.ts': 'export {};\n',
  };

  it('removes everything init wrote from an empty repository, the manifest last, and unsets the hooks path', async () => {
    const h = await installed();

    await h.go(['uninstall', '--json']);

    expect(h.fs.snapshot()).toEqual({});
    expect(h.git.hooksPath()).toBeUndefined();
    expect(h.stepStatuses()).toEqual([
      ['files', 'ok'],
      ['git hooks path', 'ok'],
      ['kept', 'ok'],
    ]);
    expect(h.fs.log.at(-1)).toBe('remove .sdlc/manifest.json');
    expect(process.exitCode).toBeUndefined();
  });

  it('leaves user content: the repository equals the fixture byte for byte except the user edits made in between', async () => {
    const custom = '---\nrole: dba\ndescription: Our DBA.\ntier: standard\ncan_edit: true\nreturns: a report\nescalate_when: unsure\n---\nYou tune queries.\n';
    const h = await installed({ ...FIXTURE, '.sdlc/agents/custom/dba.md': custom });
    expect(h.fs.files.has('.claude/agents/sdlc-dba.md')).toBe(true);

    // the user keeps working: a rule above the managed block, one more MCP server, a tweaked agent, a new file
    const claude = h.fs.files.get('CLAUDE.md') as string;
    h.fs.files.set('CLAUDE.md', `Read this first.\n\n${claude}`);
    const mcp = JSON.parse(h.fs.files.get('.mcp.json') as string) as { mcpServers: Record<string, unknown> };
    mcp.mcpServers.extra = { command: 'extra-mcp' };
    h.fs.files.set('.mcp.json', `${JSON.stringify(mcp, null, 2)}\n`);
    const developer = '.claude/agents/sdlc-developer.md';
    h.fs.files.set(developer, `${h.fs.files.get(developer)}\nmy tweak\n`);
    const tweaked = h.fs.files.get(developer) as string;
    h.fs.files.set('notes.txt', 'mine\n');

    await h.go(['uninstall', '--json']);

    expect(h.fs.snapshot()).toEqual({
      'CLAUDE.md': `Read this first.\n\n${FIXTURE['CLAUDE.md']}`,
      '.mcp.json': `${JSON.stringify({ mcpServers: { mine: { command: 'our-mcp' }, extra: { command: 'extra-mcp' } } }, null, 2)}\n`,
      '.codex/config.toml': FIXTURE['.codex/config.toml'],
      '.gitignore': FIXTURE['.gitignore'],
      'src/index.ts': FIXTURE['src/index.ts'],
      '.sdlc/agents/custom/dba.md': custom,
      [developer]: tweaked,
      'notes.txt': 'mine\n',
    });
    const report = h.report();
    expect(report.plan.notices).toEqual([{ path: developer, message: 'modified locally; kept' }]);
    expect(report.steps.find(s => s.name === 'kept')?.details.join('\n')).toContain(developer);
    expect(report.steps.find(s => s.name === 'kept')?.details).toContain(
      '.gitignore: the sdlc block was removed, so .env, .env.*, .sdlc/cache/ and .worktrees/ are no longer ignored; ' +
        'add the lines you still need back by hand, or a .env file can be committed',
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('uninstall after init into the fixture restores it exactly', async () => {
    const h = await installed(FIXTURE);

    await h.go(['uninstall']);

    expect(h.fs.snapshot()).toEqual(FIXTURE);
  });

  it('never touches GitHub and says that the board, labels and issues remain', async () => {
    const h = await installed();
    const gh = h.useGh([]);

    await h.go(['uninstall']);

    expect(gh.calls).toEqual([]);
    expect(h.text()).toMatch(/GitHub was not touched: .*board.*labels.*issues.* remain/);
  });

  it('keeps core.hooksPath when it is not the kit hooks directory', async () => {
    const h = await installed();
    await h.git.run(['config', 'core.hooksPath', '.husky']);

    await h.go(['uninstall', '--json']);

    expect(h.git.hooksPath()).toBe('.husky');
    expect(h.git.calls.some(args => args.includes('--unset'))).toBe(false);
    const step = h.report().steps.find(s => s.name === 'git hooks path');
    expect(step?.details.join('\n')).toContain('".husky"');
  });

  it('--dry-run removes nothing and unsets nothing', async () => {
    const h = await installed();
    const before = h.fs.snapshot();
    const logLength = h.fs.log.length;

    await h.go(['uninstall', '--dry-run']);

    expect(h.fs.snapshot()).toEqual(before);
    expect(h.fs.log).toHaveLength(logLength);
    expect(h.git.hooksPath()).toBe('.sdlc/githooks');
    expect(h.git.calls.some(args => args.includes('--unset'))).toBe(false);
    expect(h.text()).toContain('remove .sdlc/githooks/pre-commit');
    expect(h.text()).toContain('(dry run: nothing written)');
  });

  it('without a manifest has nothing to remove and says so', async () => {
    const h = setup({ files: FIXTURE });

    await h.go(['uninstall', '--json']);

    expect(h.fs.snapshot()).toEqual(FIXTURE);
    const files = h.report().steps.find(s => s.name === 'files');
    expect(files?.status).toBe('skipped');
    expect(files?.details.join('\n')).toContain('.sdlc/manifest.json');
    expect(process.exitCode).toBeUndefined();
  });

  it('lists the files it updated as well as the ones it removed, and a dry run lists the same paths', async () => {
    const h = await installed(FIXTURE);

    await h.go(['uninstall', '--dry-run', '--json']);
    const dry = h.report();
    await h.go(['uninstall', '--json']);
    const real = h.report();

    // the user's files had content of their own: only the kit's part went, so they are updates
    expect(real.plan.writes).toEqual(
      expect.arrayContaining([
        { path: 'CLAUDE.md', action: 'update' },
        { path: '.mcp.json', action: 'update' },
        { path: '.codex/config.toml', action: 'update' },
        { path: '.gitignore', action: 'update' },
        { path: '.claude/agents/sdlc-developer.md', action: 'remove' },
        { path: 'AGENTS.md', action: 'remove' },
      ]),
    );
    expect(real.plan.writes.map(w => w.path)).not.toContain('.sdlc/manifest.json');
    expect(dry.plan.writes).toEqual(real.plan.writes);
    expect(dry.plan).toEqual(real.plan);
    expect(h.fs.snapshot()).toEqual(FIXTURE);
  });

  it('unsets core.hooksPath when it is written as ./.sdlc/githooks/', async () => {
    const h = await installed();
    await h.git.run(['config', 'core.hooksPath', './.sdlc/githooks/']);

    await h.go(['uninstall']);

    expect(h.git.hooksPath()).toBeUndefined();
    expect(h.git.calls.filter(args => args.includes('--unset'))).toEqual([['config', '--unset', 'core.hooksPath']]);
  });

  it('exits 1 and keeps the manifest when a removal fails; core.hooksPath stays set so the hooks stay active', async () => {
    const h = await installed();
    h.context.fs = {
      ...h.fs,
      remove(p) {
        if (p === 'CLAUDE.md') throw new Error('EBUSY: resource busy');
        h.fs.remove(p);
      },
    };

    await h.go(['uninstall', '--json']);

    expect(process.exitCode).toBe(1);
    expect(h.report().plan.errors).toEqual([{ path: 'CLAUDE.md', message: 'EBUSY: resource busy' }]);
    expect(h.fs.files.has('CLAUDE.md')).toBe(true);
    expect(h.fs.files.has('.sdlc/manifest.json')).toBe(true);
    // the later steps still ran, but the hooks path was not unset while the kit's hooks are still installed
    expect(h.stepStatuses()).toEqual([
      ['files', 'failed'],
      ['git hooks path', 'skipped'],
      ['kept', 'ok'],
    ]);
    expect(h.git.hooksPath()).toBe('.sdlc/githooks');
    expect(h.git.calls.some(args => args.includes('--unset'))).toBe(false);
    expect(h.report().steps[1]?.details.join('\n')).toContain('left as it is');
  });

  it('with a damaged manifest removes nothing and leaves core.hooksPath set', async () => {
    const h = await installed();
    h.fs.files.set('.sdlc/manifest.json', '{ not json');
    const before = h.fs.snapshot();

    await h.go(['uninstall', '--json']);

    expect(process.exitCode).toBe(1);
    expect(h.fs.snapshot()).toEqual(before);
    expect(h.stepStatuses()).toEqual([
      ['files', 'failed'],
      ['git hooks path', 'skipped'],
      ['kept', 'ok'],
    ]);
    expect(h.git.hooksPath()).toBe('.sdlc/githooks');
    expect(h.git.calls.some(args => args.includes('--unset'))).toBe(false);
  });
});
