import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import type { DoctorContext } from '../../src/commands/doctor.js';
import { loadConfigFromString, type Config } from '../../src/config/schema.js';
import { desiredFields } from '../../src/github/board.js';
import { applyPlan, planApply } from '../../src/install/apply.js';
import { describeError, hookEnvironment, parseTokenScopes, runDoctor, runPreflight, type Check, type DoctorEnv } from '../../src/install/doctor.js';
import { MANIFEST_PATH } from '../../src/install/manifest.js';
import type { GitRunner } from '../../src/install/provision.js';
import { renderAll } from '../../src/render/plan.js';
import { scanFileName } from '../../src/secrets/scan.js';
import { fakeGh, type FakeGh, type FakeGhStep } from '../support/fakeGh.js';
import { memoryFs, type MemoryFs } from '../support/memoryFs.js';
import { githubToken } from '../support/secrets.js';

const HEADER = `version: 1
mode: observe
github: { repo: acme/shop, default_branch: main, project: { owner: acme, owner_type: org, number: 7 } }
owners: [shop-owner]
task_types: { enabled: [tooling, analysis] }
`;
/** claude + codex, Actions on, the default MCP server (github) in project scope. */
const CONFIG = `${HEADER}harnesses: [claude, codex]\nstack: { actions: true }\n`;
const configWith = (extra: string, harnesses = '[claude, codex]'): string => `${HEADER}harnesses: ${harnesses}\n${extra}`;
const cfgOf = (text: string): Config => loadConfigFromString(text);

const PREFLIGHT_IDS = [
  'git.repo',
  'node.version',
  'gh.installed',
  'gh.auth',
  'gh.scopes',
  'repo.remote',
  'repo.instructionFiles',
  'config.present',
];
const INSTALL_IDS = [
  'config.valid',
  'manifest.present',
  'files.managed',
  'git.hooksPath',
  'git.legacyHooks',
  'sdlc.onPath',
  'kit.ref',
  'board.fields',
  'labels',
  'actions.workflow',
  'actions.secret',
  'mcp.token',
  'mcp.claude',
  'secrets.guard',
  'secrets.pushProtection',
  'secrets.trackedFiles',
  'approvals.trust',
];

// --- fakes ----------------------------------------------------------------------------------------

/** `gh auth status` as gh prints it (the token itself is masked by gh; here it is not even a prefix). */
const AUTH_OK = [
  'github.com',
  '  ✓ Logged in to github.com account octocat (keyring)',
  '  - Active account: true',
  '  - Git operations protocol: https',
  '  - Token: ********',
  "  - Token scopes: 'gist', 'project', 'read:org', 'repo', 'workflow'",
  '',
].join('\n');
const authWithScopes = (scopes: string): string => AUTH_OK.replace("'gist', 'project', 'read:org', 'repo', 'workflow'", scopes);

const VIEWS = ['Board', 'In flight', 'Awaiting deployment', 'Waiting on owner'];
const LABELS = ['sdlc:task', 'sdlc:partial', 'type:tooling', 'type:analysis'];
const SECURITY_ON = JSON.stringify({ secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } });

/** A board that already has every field, option and view of `cfg`. */
function boardOf(
  cfg: Config,
  mutate: (nodes: Array<Record<string, unknown>>) => Array<Record<string, unknown>> = n => n,
  views: string[] = VIEWS,
): FakeGhStep {
  const nodes = mutate([
    { id: 'F_title', name: 'Title', dataType: 'TITLE' },
    ...desiredFields(cfg).map((f, i) => ({
      id: `PF_${i}`,
      name: f.name,
      dataType: f.dataType,
      ...(f.options && { options: f.options.map((name, j) => ({ id: `PF_${i}_${j}`, name })) }),
    })),
  ]);
  return {
    match: ['graphql'],
    stdout: JSON.stringify({
      data: { owner: { projectV2: { id: 'PVT_1', number: 7, fields: { nodes }, views: { nodes: views.map(name => ({ name })) } } } },
    }),
  };
}

type GhSlot = 'auth' | 'repo' | 'board' | 'labels' | 'secrets' | 'security';

/** The `gh` calls of a full doctor run, in order, with everything in place; `over` replaces one answer. */
function ghScript(cfg: Config, over: Partial<Record<GhSlot, FakeGhStep | null>> = {}): FakeGhStep[] {
  return [
    over.auth ?? { match: ['auth', 'status'], stdout: AUTH_OK },
    over.repo ?? { match: ['repo', 'view'], stdout: JSON.stringify({ nameWithOwner: 'acme/shop', defaultBranchRef: { name: 'main' } }) },
    // `null`: a config without a board number, which a dry run does not query.
    ...(over.board === null ? [] : [over.board ?? boardOf(cfg)]),
    over.labels ?? { match: ['label', 'list'], stdout: JSON.stringify(LABELS.map(name => ({ name }))) },
    ...(cfg.stack.actions ? [over.secrets ?? { match: ['secret', 'list'], stdout: JSON.stringify([{ name: 'SDLC_TOKEN' }, { name: 'OTHER' }]) }] : []),
    over.security ?? { match: ['api', 'repos/acme/shop', '--jq'], stdout: SECURITY_ON },
  ];
}

interface GitState {
  inside?: boolean;
  /** `undefined` leaves core.hooksPath unset. */
  hooksPath?: string;
  tracked?: string[];
}
type FakeGit = GitRunner & { calls: string[][] };

function fakeGit(state: GitState = {}): FakeGit {
  const calls: string[][] = [];
  const run: GitRunner = async args => {
    calls.push(args);
    const line = args.join(' ');
    if (line === 'rev-parse --is-inside-work-tree') {
      return state.inside === false
        ? { stdout: '', code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' }
        : { stdout: 'true\n', code: 0, stderr: '' };
    }
    if (line === 'config --get core.hooksPath') {
      return state.hooksPath === undefined ? { stdout: '', code: 1, stderr: '' } : { stdout: `${state.hooksPath}\n`, code: 0, stderr: '' };
    }
    if (line === 'rev-parse --git-common-dir') return { stdout: '.git\n', code: 0, stderr: '' };
    if (line === 'ls-files -z') {
      const tracked = state.tracked ?? ['README.md', 'src/index.ts'];
      return { stdout: tracked.map(path => `${path}\0`).join(''), code: 0, stderr: '' };
    }
    throw new Error(`unexpected git call: ${line}`);
  };
  return Object.assign(run, { calls });
}

type ExecResult = { stdout: string; code: number; stderr: string };
const CLAUDE_LIST = [
  'Checking MCP server health...',
  '',
  'github: https://api.githubcopilot.com/mcp/ (HTTP) - ✓ Connected',
  'context7: npx -y @upstash/context7-mcp - ✓ Connected',
  '',
].join('\n');

interface EnvOptions {
  cfg?: Config;
  fs?: MemoryFs;
  gh?: FakeGhStep[];
  git?: GitState;
  /** The commands `which` finds. */
  installed?: string[];
  /** What `exec` answers per command; a thrown value rejects. `git` is `git ls-remote` of kit.ref (found by default). */
  exec?: { npx?: ExecResult | Error; claude?: ExecResult | Error; git?: ExecResult | Error };
  /** The repository's own hooks in `.git/hooks`, by name. */
  legacyHooks?: Record<string, 'executable' | 'not-executable'>;
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  /** The config file's text; `null` is no file. */
  configText?: string | null;
}

interface Harness {
  env: DoctorEnv;
  gh: FakeGh;
  git: FakeGit;
  fs: MemoryFs;
  cfg: Config;
  execCalls: Array<[string, string[]]>;
  /** The environment of each exec and which call, in order. */
  execEnvs: Array<NodeJS.ProcessEnv | undefined>;
  whichEnvs: Array<NodeJS.ProcessEnv | undefined>;
}

const TOKEN_VAR = 'GITHUB_PERSONAL_ACCESS_TOKEN';

/** Installs the kit for `cfg` into a memory repository, the way `sdlc init` does, and returns it. */
function installedFs(cfg: Config, files: Record<string, string> = {}): MemoryFs {
  const fs = memoryFs(files);
  const { changes } = renderAll(cfg, fs);
  const result = applyPlan(planApply(changes, fs, undefined, { overwriteModified: false }), fs, { removeObsolete: false });
  expect(result.errors).toEqual([]);
  return fs;
}

function harness(options: EnvOptions = {}): Harness {
  const cfg = options.cfg ?? cfgOf(CONFIG);
  const fs = options.fs ?? installedFs(cfg);
  const gh = fakeGh(options.gh ?? ghScript(cfg));
  const git = fakeGit({ hooksPath: '.sdlc/githooks', ...options.git });
  const installed = new Set(options.installed ?? ['git', 'gh', 'sdlc', 'npx', 'claude']);
  const execCalls: Array<[string, string[]]> = [];
  const execEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
  const whichEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
  const configText = options.configText === undefined ? CONFIG : options.configText;
  const answers = options.exec ?? {};
  const env: DoctorEnv = {
    run: gh,
    git,
    fs,
    which: async (cmd, whichEnv) => {
      whichEnvs.push(whichEnv);
      return installed.has(cmd);
    },
    hookProbe: path => {
      const prefix = '/memory/.git/hooks/';
      return path.startsWith(prefix) ? (options.legacyHooks?.[path.slice(prefix.length)] ?? 'missing') : 'missing';
    },
    exec: async (cmd, args, execOptions) => {
      execCalls.push([cmd, args]);
      execEnvs.push(execOptions?.env);
      const answer =
        cmd === 'claude'
          ? (answers.claude ?? { stdout: CLAUDE_LIST, code: 0, stderr: '' })
          : cmd === 'npx'
            ? (answers.npx ?? { stdout: '', code: 1, stderr: 'npx: not found' })
            : cmd === 'git'
              ? (answers.git ?? { stdout: 'abc123\trefs/tags/v0.1.0\n', code: 0, stderr: '' })
              : undefined;
      if (answer === undefined) throw new Error(`unexpected exec: ${cmd}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    env: { [TOKEN_VAR]: githubToken(), ...options.env },
    nodeVersion: options.nodeVersion ?? 'v22.3.0',
    config: { path: 'sdlc.config.yaml', read: () => (configText === null ? undefined : configText) },
  };
  return { env, gh, git, fs, cfg, execCalls, execEnvs, whichEnvs };
}

const byId = (checks: Check[], id: string): Check => {
  const found = checks.find(check => check.id === id);
  if (found === undefined) throw new Error(`no check ${id}; have ${checks.map(c => c.id).join(', ')}`);
  return found;
};
const statuses = (checks: Check[]): Array<[string, string]> => checks.map(c => [c.id, c.status]);
const notOk = (checks: Check[]): Array<[string, string]> => statuses(checks).filter(([, status]) => status !== 'ok');

/** A `gh` call that changes something on GitHub. */
function isMutation(args: string[], input: string | undefined): boolean {
  // A GraphQL call reads or writes by its body (`--input -` is how both are sent).
  if (args.includes('graphql')) return /\bmutation\b/.test(input ?? '');
  return args.includes('create') || args.includes('-X') || args.includes('set') || args.includes('--input');
}
const mutations = (gh: FakeGh): string[][] => gh.calls.filter((args, i) => isMutation(args, gh.inputs[i]));

// --- runPreflight ---------------------------------------------------------------------------------

describe('runPreflight', () => {
  it('reports the eight preflight checks in order, all ok on a healthy machine', async () => {
    const h = harness();
    const checks = await runPreflight(h.env);

    expect(checks.map(c => c.id)).toEqual(PREFLIGHT_IDS);
    expect(notOk(checks)).toEqual([]);
    expect(h.gh.calls).toEqual([['auth', 'status'], ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef']]);
  });

  it('works without a config file: config.present is a warning that points at config suggest', async () => {
    const h = harness({ configText: null });
    const checks = await runPreflight(h.env);

    expect(notOk(checks)).toEqual([['config.present', 'warn']]);
    expect(byId(checks, 'config.present').fix).toBe('run sdlc config suggest');
  });

  it('does not read the manifest or the config for the install checks', async () => {
    const h = harness({ fs: memoryFs() });
    const checks = await runPreflight(h.env);

    expect(checks.map(c => c.id)).toEqual(PREFLIGHT_IDS);
    expect(h.git.calls.map(call => call.join(' '))).toEqual(['rev-parse --is-inside-work-tree']);
  });

  describe('git.repo', () => {
    it('is ok inside a work tree and fails outside one', async () => {
      expect(byId(await runPreflight(harness().env), 'git.repo').status).toBe('ok');

      const outside = byId(await runPreflight(harness({ git: { inside: false } }).env), 'git.repo');
      expect(outside.status).toBe('fail');
      expect(outside.message).toMatch(/not inside a git work tree/i);
      expect(outside.fix).toMatch(/git init/);
    });
  });

  describe('node.version', () => {
    it.each(['v20.0.0', '20.11.1', 'v22.3.0', 'v100.0.0'])('accepts %s', async nodeVersion => {
      expect(byId(await runPreflight(harness({ nodeVersion }).env), 'node.version').status).toBe('ok');
    });

    it.each(['v18.19.0', '19.9.9', 'v8.0.0', 'unknown', ''])('fails for %j and says to install Node 20 or newer', async nodeVersion => {
      const check = byId(await runPreflight(harness({ nodeVersion }).env), 'node.version');
      expect(check.status).toBe('fail');
      expect(check.fix).toMatch(/Node(\.js)? 20/);
    });
  });

  describe('gh.installed, gh.auth and what depends on them', () => {
    it('fails when gh is not installed, and the checks that need gh say they were not run', async () => {
      const h = harness({ installed: ['git', 'sdlc'], gh: [] });
      const checks = await runPreflight(h.env);

      const installed = byId(checks, 'gh.installed');
      expect(installed.status).toBe('fail');
      expect(installed.fix).toContain('https://cli.github.com');
      for (const id of ['gh.auth', 'gh.scopes', 'repo.remote']) {
        expect(byId(checks, id).status).toBe('warn');
        expect(byId(checks, id).message).toMatch(/^not checked: gh is not installed/);
      }
      expect(h.gh.calls).toEqual([]);
    });

    it('fails when gh auth status fails: neutral wording with the exit code and the first line of stderr, and gh auth login as the fix', async () => {
      const h = harness({
        gh: [{ match: ['auth', 'status'], code: 1, stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login\nsecond line\n' }],
      });
      const checks = await runPreflight(h.env);

      const auth = byId(checks, 'gh.auth');
      expect(auth.status).toBe('fail');
      expect(auth.message).toBe('gh auth status failed (exit 1): You are not logged into any GitHub hosts. To log in, run: gh auth login');
      expect(auth.message).not.toContain('second line');
      expect(auth.message).not.toMatch(/not logged in:/);
      expect(auth.fix).toBe('gh auth login');
      expect(byId(checks, 'gh.scopes').message).toMatch(/^not checked/);
      expect(byId(checks, 'repo.remote').message).toMatch(/^not checked/);
      expect(h.gh.calls).toEqual([['auth', 'status']]);
    });

    it('does not claim the user is logged out, and never prints stdout, when gh auth status fails for another reason', async () => {
      const h = harness({ gh: [{ match: ['auth', 'status'], code: 4, stdout: 'Token: sensitive-stdout-line\n', stderr: '' }] });
      const auth = byId(await runPreflight(h.env), 'gh.auth');

      expect(auth.status).toBe('fail');
      expect(auth.message).toBe('gh auth status failed (exit 4)');
      expect(auth.message).not.toContain('sensitive');
      expect(auth.fix).toBe('gh auth login');
    });

    it('names the account gh is logged in as', async () => {
      const auth = byId(await runPreflight(harness().env), 'gh.auth');
      expect(auth.message).toContain('octocat');
      expect(auth.message).toContain('github.com');
    });
  });

  describe('gh.scopes', () => {
    const scopesCheck = async (stdout: string, options: { actions?: boolean } = {}): Promise<Check> => {
      const h = harness({ gh: [{ match: ['auth', 'status'], stdout }, { match: ['repo'] }] });
      return byId(await runPreflight(h.env, options), 'gh.scopes');
    };

    it('is ok for the token scopes of a real gh auth status', async () => {
      const check = await scopesCheck(AUTH_OK);
      expect(check.status).toBe('ok');
      expect(check.message).toContain('repo');
      expect(check.message).toContain('project');
    });

    it('also reads gh output that went to stderr', async () => {
      const h = harness({ gh: [{ match: ['auth', 'status'], stderr: AUTH_OK }, { match: ['repo'] }] });
      expect(byId(await runPreflight(h.env), 'gh.scopes').status).toBe('ok');
    });

    it('fails without the project scope and says which one to add', async () => {
      const check = await scopesCheck(authWithScopes("'gist', 'read:org', 'repo', 'workflow'"));
      expect(check.status).toBe('fail');
      expect(check.message).toContain('project');
      expect(check.message).not.toMatch(/\brepo\b.*missing|missing.*\brepo\b/);
      expect(check.fix).toBe('gh auth refresh -s project');
    });

    it('fails without the repo scope, and names both when both are missing', async () => {
      const noRepo = await scopesCheck(authWithScopes("'project', 'workflow'"));
      expect(noRepo.status).toBe('fail');
      expect(noRepo.fix).toBe('gh auth refresh -s repo');
      const neither = await scopesCheck(authWithScopes("'gist', 'workflow'"));
      expect(neither.status).toBe('fail');
      expect(neither.fix).toBe('gh auth refresh -s repo -s project');
    });

    it('warns when only workflow is missing and Actions will be used (the default without a config)', async () => {
      const text = authWithScopes("'project', 'repo'");
      for (const options of [{}, { actions: true }]) {
        const check = await scopesCheck(text, options);
        expect(check.status).toBe('warn');
        expect(check.message).toContain('workflow');
        expect(check.fix).toBe('gh auth refresh -s workflow');
      }
    });

    it('does not ask for workflow when Actions are off', async () => {
      expect((await scopesCheck(authWithScopes("'project', 'repo'"), { actions: false })).status).toBe('ok');
    });

    it('reports a missing required scope together with a missing workflow scope', async () => {
      const check = await scopesCheck(authWithScopes("'repo'"));
      expect(check.status).toBe('fail');
      expect(check.fix).toBe('gh auth refresh -s project -s workflow');
    });

    it('reads the unquoted list of older gh versions', async () => {
      const check = await scopesCheck(authWithScopes('gist, project, read:org, repo, workflow'));
      expect(check.status).toBe('ok');
    });

    it('warns, not fails, when gh lists no scopes (fine-grained token, or none shown)', async () => {
      const withoutLine = AUTH_OK.split('\n').filter(line => !line.includes('Token scopes')).join('\n');
      for (const stdout of [withoutLine, authWithScopes('none'), authWithScopes('')]) {
        const check = await scopesCheck(stdout);
        expect(check.status).toBe('warn');
        expect(check.message).toMatch(/cannot be verified|not listed|does not list/i);
      }
    });

    it('uses the active account when gh lists several', async () => {
      const several = [
        'github.com',
        '  ✓ Logged in to github.com account old (keyring)',
        '  - Active account: false',
        "  - Token scopes: 'gist'",
        '  ✓ Logged in to github.com account octocat (keyring)',
        '  - Active account: true',
        "  - Token scopes: 'project', 'repo', 'workflow'",
        '',
      ].join('\n');
      expect((await scopesCheck(several)).status).toBe('ok');
    });
  });

  describe('parseTokenScopes', () => {
    it('reads the quoted list of the real-format sample', () => {
      expect(parseTokenScopes("  - Token scopes: 'gist', 'project', 'read:org', 'repo', 'workflow'\n")).toEqual([
        'gist',
        'project',
        'read:org',
        'repo',
        'workflow',
      ]);
    });

    it('returns undefined when there is no scopes line and an empty list for none', () => {
      expect(parseTokenScopes('github.com\n  ✓ Logged in to github.com account a (keyring)\n')).toBeUndefined();
      expect(parseTokenScopes('  - Token scopes: none\n')).toEqual([]);
    });
  });

  describe('repo.remote', () => {
    it('reports the repository and its default branch', async () => {
      const check = byId(await runPreflight(harness().env), 'repo.remote');
      expect(check.status).toBe('ok');
      expect(check.message).toContain('acme/shop');
      expect(check.message).toContain('main');
    });

    it('fails when gh cannot see a repository, with the reason', async () => {
      const h = harness({
        gh: [
          { match: ['auth', 'status'], stdout: AUTH_OK },
          { match: ['repo', 'view'], code: 1, stderr: 'no git remotes found\n' },
        ],
      });
      const check = byId(await runPreflight(h.env), 'repo.remote');
      expect(check.status).toBe('fail');
      expect(check.message).toContain('no git remotes found');
      expect(check.fix).toMatch(/remote|gh repo create/);
    });

    it('fails on an answer that is not what gh repo view prints', async () => {
      const h = harness({ gh: [{ match: ['auth', 'status'], stdout: AUTH_OK }, { match: ['repo', 'view'], stdout: 'not json' }] });
      expect(byId(await runPreflight(h.env), 'repo.remote').status).toBe('fail');
    });
  });

  describe('repo.instructionFiles', () => {
    it('lists the instruction files that exist, as information', async () => {
      const h = harness({ fs: memoryFs({ 'CLAUDE.md': '# x', 'GEMINI.md': '# y', 'README.md': '# z' }) });
      const check = byId(await runPreflight(h.env), 'repo.instructionFiles');
      expect(check.status).toBe('ok');
      expect(check.message).toContain('CLAUDE.md');
      expect(check.message).toContain('GEMINI.md');
      expect(check.message).not.toContain('AGENTS.md');
    });

    it('is still ok when there are none', async () => {
      const check = byId(await runPreflight(harness({ fs: memoryFs() }).env), 'repo.instructionFiles');
      expect(check.status).toBe('ok');
      expect(check.message).toMatch(/none/i);
    });
  });

  describe('config.present', () => {
    it('is ok when the config file exists', async () => {
      const check = byId(await runPreflight(harness().env), 'config.present');
      expect(check.status).toBe('ok');
      expect(check.message).toContain('sdlc.config.yaml');
    });
  });

  describe('isolation', () => {
    it('turns an exception in one check into that check failing, single-line, and runs the others', async () => {
      const h = harness();
      h.env.git = async () => {
        throw new Error('git not found;\n  install https://git-scm.com\u001b[31m');
      };
      const checks = await runPreflight(h.env);

      expect(checks.map(c => c.id)).toEqual(PREFLIGHT_IDS);
      const repo = byId(checks, 'git.repo');
      expect(repo.status).toBe('fail');
      expect(repo.message).toBe('git not found; install https://git-scm.com');
      expect(byId(checks, 'node.version').status).toBe('ok');
      expect(byId(checks, 'gh.auth').status).toBe('ok');
    });

    it('does the same for gh that cannot run at all', async () => {
      const h = harness({ gh: [] });
      h.env.run = async () => {
        throw new Error('gh CLI not found; install https://cli.github.com');
      };
      const checks = await runPreflight(h.env);

      expect(byId(checks, 'gh.auth').status).toBe('fail');
      expect(byId(checks, 'gh.auth').message).toContain('gh CLI not found');
      expect(byId(checks, 'gh.scopes').status).toBe('warn');
      expect(byId(checks, 'repo.instructionFiles').status).toBe('ok');
    });
  });
});

describe('describeError', () => {
  it('is one printable line, trimmed and bounded', () => {
    expect(describeError(new Error('a\nb\r\n  c\u0007\td'))).toBe('a b c d');
    expect(describeError('plain')).toBe('plain');
    expect(describeError(new Error(''))).toBe('unknown error');
    const long = describeError(new Error('x'.repeat(1000)));
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long.endsWith('…')).toBe(true);
  });
});

// --- runDoctor ------------------------------------------------------------------------------------

describe('runDoctor', () => {
  it('runs the preflight and then the install checks, in the order of the brief, all ok on a healthy install', async () => {
    const h = harness();
    const checks = await runDoctor(h.env, h.cfg);

    expect(checks.map(c => c.id)).toEqual([...PREFLIGHT_IDS, ...INSTALL_IDS]);
    expect(notOk(checks)).toEqual([]);
    // read-only: the board is only planned (dry run) and nothing is written to GitHub
    expect(mutations(h.gh)).toEqual([]);
    expect(h.gh.calls.map(call => call[0])).toEqual(['auth', 'repo', 'api', 'label', 'secret', 'api']);
  });

  it('never prints the value of an environment variable', async () => {
    const h = harness();
    const checks = await runDoctor(h.env, h.cfg);
    expect(JSON.stringify(checks)).not.toContain(githubToken());
  });

  it('config.valid is ok for a config that was loaded', async () => {
    expect(byId(await runDoctor(harness().env, harness().cfg), 'config.valid').status).toBe('ok');
  });

  describe('manifest.present and files.managed', () => {
    it('fails without a manifest, with sdlc init as the fix, and does not check the files', async () => {
      const h = harness({ fs: memoryFs() });
      const checks = await runDoctor(h.env, h.cfg);

      expect(byId(checks, 'manifest.present')).toMatchObject({ status: 'fail', fix: 'sdlc init' });
      expect(byId(checks, 'files.managed')).toMatchObject({ status: 'warn' });
      expect(byId(checks, 'files.managed').message).toMatch(/^not checked/);
    });

    it('fails on a damaged manifest and says so in one line', async () => {
      const fs = installedFs(cfgOf(CONFIG));
      fs.write(MANIFEST_PATH, '{ nope');
      const checks = await runDoctor(harness({ fs }).env, cfgOf(CONFIG));

      const manifest = byId(checks, 'manifest.present');
      expect(manifest.status).toBe('fail');
      expect(manifest.message).toContain('not valid JSON');
      expect(byId(checks, 'files.managed').message).toMatch(/^not checked/);
    });

    it('is ok when every managed file, block and key matches the manifest, also after edits outside the managed parts', async () => {
      const fs = installedFs(cfgOf(CONFIG), { 'CLAUDE.md': '# My project\n', '.mcp.json': '{ "mcpServers": { "mine": { "command": "x" } } }\n' });
      fs.write('CLAUDE.md', `${fs.read('CLAUDE.md')}\nMy own notes after the block.\n`);
      const checks = await runDoctor(harness({ fs }).env, cfgOf(CONFIG));

      expect(byId(checks, 'manifest.present').status).toBe('ok');
      expect(byId(checks, 'files.managed').status).toBe('ok');
    });

    it('warns and names a managed block, key or file that was modified', async () => {
      const fs = installedFs(cfgOf(CONFIG));
      fs.write('CLAUDE.md', (fs.read('CLAUDE.md') as string).replace('<!-- sdlc:begin -->', '<!-- sdlc:begin -->\nhand edit'));
      const mcp = JSON.parse(fs.read('.mcp.json') as string) as { mcpServers: { github: { url: string } } };
      mcp.mcpServers.github.url = 'https://elsewhere.test/mcp';
      fs.write('.mcp.json', JSON.stringify(mcp));
      fs.write('.claude/agents/sdlc-developer.md', 'my own developer\n');
      const check = byId(await runDoctor(harness({ fs }).env, cfgOf(CONFIG)), 'files.managed');

      expect(check.status).toBe('warn');
      expect(check.message).toContain('CLAUDE.md');
      expect(check.message).toContain('.mcp.json');
      expect(check.message).toContain('mcpServers/github');
      expect(check.message).toContain('.claude/agents/sdlc-developer.md');
      expect(check.message).not.toContain('AGENTS.md');
      expect(check.fix).toContain('--overwrite-modified');
    });

    it('fails and names a managed file, block or key that is gone', async () => {
      const fs = installedFs(cfgOf(CONFIG));
      fs.remove('.sdlc/githooks/pre-commit');
      fs.write('AGENTS.md', '# no block any more\n');
      fs.write('.mcp.json', '{}');
      const check = byId(await runDoctor(harness({ fs }).env, cfgOf(CONFIG)), 'files.managed');

      expect(check.status).toBe('fail');
      expect(check.message).toContain('.sdlc/githooks/pre-commit');
      expect(check.message).toContain('AGENTS.md');
      expect(check.message).toContain('mcpServers/github');
      expect(check.fix).toBe('sdlc init');
    });

    it('fails when files are missing even if others were only modified, and says both', async () => {
      const fs = installedFs(cfgOf(CONFIG));
      fs.remove('.sdlc/githooks/pre-push');
      fs.write('.sdlc/githooks/pre-commit', '#!/bin/sh\nexit 0\n');
      const check = byId(await runDoctor(harness({ fs }).env, cfgOf(CONFIG)), 'files.managed');

      expect(check.status).toBe('fail');
      expect(check.message).toMatch(/missing: .*pre-push/);
      expect(check.message).toMatch(/modified: .*pre-commit/);
    });

    it('treats a block whose markers were damaged, or a JSON file that no longer parses, as modified', async () => {
      const fs = installedFs(cfgOf(CONFIG));
      fs.write('CLAUDE.md', (fs.read('CLAUDE.md') as string).replace('<!-- sdlc:end -->', ''));
      fs.write('.mcp.json', '{ broken');
      const check = byId(await runDoctor(harness({ fs }).env, cfgOf(CONFIG)), 'files.managed');

      expect(check.status).toBe('warn');
      expect(check.message).toContain('CLAUDE.md');
      expect(check.message).toContain('.mcp.json');
    });
  });

  describe('git.hooksPath', () => {
    it.each(['.sdlc/githooks', './.sdlc/githooks/', '.sdlc/githooks//'])('is ok for %s', async hooksPath => {
      const checks = await runDoctor(harness({ git: { hooksPath } }).env, cfgOf(CONFIG));
      expect(byId(checks, 'git.hooksPath').status).toBe('ok');
    });

    it('fails when core.hooksPath is unset, with sdlc init as the fix', async () => {
      const h = harness();
      h.env.git = fakeGit({});
      const check = byId(await runDoctor(h.env, h.cfg), 'git.hooksPath');
      expect(check).toMatchObject({ status: 'fail', fix: 'sdlc init' });
    });

    it('fails when core.hooksPath is another directory, and names it', async () => {
      const check = byId(await runDoctor(harness({ git: { hooksPath: '.husky/_' } }).env, cfgOf(CONFIG)), 'git.hooksPath');
      expect(check.status).toBe('fail');
      expect(check.message).toContain('.husky/_');
      expect(check.fix).toContain('git config core.hooksPath .sdlc/githooks');
    });

    it('fails when git cannot say', async () => {
      const h = harness();
      h.env.git = async args => (args[0] === 'config' ? { stdout: '', code: 128, stderr: 'fatal: bad config' } : fakeGit()(args));
      const check = byId(await runDoctor(h.env, h.cfg), 'git.hooksPath');
      expect(check.status).toBe('fail');
      expect(check.message).toContain('fatal: bad config');
    });
  });

  describe('git.legacyHooks', () => {
    it('is ok and says so when there are no hooks of the repository\'s own', async () => {
      const check = byId(await runDoctor(harness().env, cfgOf(CONFIG)), 'git.legacyHooks');
      expect(check).toEqual({ id: 'git.legacyHooks', status: 'ok', message: 'no hooks of your own in .git/hooks to chain' });
    });

    it('is ok and lists the hooks the sdlc hooks chain', async () => {
      const h = harness({ legacyHooks: { 'pre-commit': 'executable', 'pre-push': 'executable' } });
      const check = byId(await runDoctor(h.env, h.cfg), 'git.legacyHooks');
      expect(check.status).toBe('ok');
      expect(check.message).toBe('the sdlc hooks run your hooks in .git/hooks after the sdlc step: pre-commit, pre-push');
    });

    it('warns when one is not executable, with the chmod that fixes it', async () => {
      const h = harness({ legacyHooks: { 'pre-commit': 'executable', 'post-merge': 'not-executable' } });
      const check = byId(await runDoctor(h.env, h.cfg), 'git.legacyHooks');
      expect(check.status).toBe('warn');
      expect(check.message).toBe('not executable, so the sdlc hooks do not run them: post-merge in .git/hooks; chained: pre-commit');
      expect(check.fix).toBe('chmod +x .git/hooks/post-merge');
    });

    it('with core.hooksPath unset, says the sdlc hooks are not active and git runs your hooks itself; nothing to chmod', async () => {
      const h = harness({ git: { hooksPath: undefined }, legacyHooks: { 'pre-commit': 'executable', 'post-merge': 'not-executable' } });
      const check = byId(await runDoctor(h.env, h.cfg), 'git.legacyHooks');
      expect(check.status).toBe('ok');
      expect(check.message).toBe(
        'core.hooksPath is not set, so the sdlc hooks are not active and git runs your own hooks itself (pre-commit in .git/hooks; not executable, so skipped: post-merge); ' +
          'once it is set, the sdlc hooks run them after their own step',
      );
    });

    it('with core.hooksPath at another manager, says neither the sdlc hooks nor yours run', async () => {
      const h = harness({ git: { hooksPath: '.husky' }, legacyHooks: { 'pre-commit': 'executable' } });
      const check = byId(await runDoctor(h.env, h.cfg), 'git.legacyHooks');
      expect(check.status).toBe('ok');
      expect(check.message).toBe('core.hooksPath is .husky, so git runs the hooks there: neither the sdlc hooks nor your hooks in .git/hooks (pre-commit) run; see git.hooksPath');
    });

    it('warns, and does not fail, when git cannot name its directory', async () => {
      const h = harness();
      const base = h.env.git;
      h.env.git = async args => (args[0] === 'rev-parse' && args[1] === '--git-common-dir' ? { stdout: '', code: 128, stderr: 'fatal: nope' } : base(args));
      const check = byId(await runDoctor(h.env, h.cfg), 'git.legacyHooks');
      expect(check.status).toBe('warn');
      expect(check.message).toContain('cannot check for hooks of your own');
    });
  });

  describe('kit.ref', () => {
    it('is ok when git ls-remote finds the ref in the kit repository, asked without a prompt and with a timeout', async () => {
      const h = harness({ cfg: cfgOf(`${CONFIG}kit_ref: main\n`) });
      const check = byId(await runDoctor(h.env, h.cfg), 'kit.ref');
      expect(check).toEqual({ id: 'kit.ref', status: 'ok', message: "kit_ref main exists in the kit's repository" });
      const index = h.execCalls.findIndex(([command]) => command === 'git');
      expect(h.execCalls[index]).toEqual(['git', ['ls-remote', '--exit-code', 'https://github.com/SobSoft-s-r-o/agentic-sdlc-kit.git', 'main']]);
      expect(h.execEnvs[index]?.GIT_TERMINAL_PROMPT).toBe('0');
      expect(h.execEnvs[index]?.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes');
    });

    it('keeps a GIT_SSH_COMMAND the owner set', async () => {
      const h = harness({ env: { GIT_SSH_COMMAND: 'ssh -i ~/.ssh/other' } });
      await runDoctor(h.env, h.cfg);
      const index = h.execCalls.findIndex(([command]) => command === 'git');
      expect(h.execEnvs[index]?.GIT_SSH_COMMAND).toBe('ssh -i ~/.ssh/other');
    });

    it('warns when the ref does not exist, and says how to fix it', async () => {
      const h = harness({ exec: { git: { stdout: '', code: 2, stderr: '' } } });
      const check = byId(await runDoctor(h.env, h.cfg), 'kit.ref');
      expect(check.status).toBe('warn');
      expect(check.message).toMatch(/^kit_ref v\d+\.\d+\.\d+\S* does not exist in https:\/\/github\.com\/SobSoft-s-r-o\/agentic-sdlc-kit\.git/);
      expect(check.fix).toContain('main until a release tag exists');
    });

    it('warns "cannot verify" on a network failure or a timeout, never fails', async () => {
      for (const git of [
        { stdout: '', code: 128, stderr: 'fatal: unable to access: Could not resolve host: github.com\n' },
        new Error('git timed out after 15s'),
      ]) {
        const check = byId(await runDoctor(harness({ exec: { git } }).env, cfgOf(CONFIG)), 'kit.ref');
        expect(check.status).toBe('warn');
        expect(check.message).toMatch(/^cannot verify kit_ref /);
      }
    });

    it('does not look up a commit sha', async () => {
      const h = harness({ cfg: cfgOf(`${CONFIG}kit_ref: 0123abcd\n`) });
      expect(byId(await runDoctor(h.env, h.cfg), 'kit.ref').status).toBe('ok');
      expect(h.execCalls.some(([command]) => command === 'git')).toBe(false);
    });
  });

  describe('sdlc.onPath', () => {
    it('is ok when sdlc is on the PATH, without running anything', async () => {
      const h = harness();
      const check = byId(await runDoctor(h.env, h.cfg), 'sdlc.onPath');
      expect(check.status).toBe('ok');
      expect(h.execCalls.filter(([command]) => command === 'npx')).toEqual([]);
    });

    it('under npx, looks for sdlc without the PATH entries npx added: a temporary package does not make the hooks work', async () => {
      const path = ['/home/u/.npm/_npx/1a2b/node_modules/.bin', '/repo/node_modules/.bin', '/usr/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin', '/usr/bin'].join(':');
      const h = harness({
        installed: ['git', 'gh', 'npx'],
        env: { PATH: path, npm_command: 'exec', npm_lifecycle_event: 'npx', npm_config_yes: 'true' },
        exec: { npx: { stdout: '', code: 1, stderr: 'npm error npx canceled due to missing packages' } },
      });
      const check = byId(await runDoctor(h.env, h.cfg), 'sdlc.onPath');
      expect(check.status).toBe('warn');
      expect(check.message).toContain('the PATH entries npx added for this run were left out');
      // other checks look up their tools with the process environment (undefined); the sdlc probe passes the hook's
      const hookEnvs = [...h.whichEnvs.filter(seen => seen !== undefined), h.execEnvs[h.execCalls.findIndex(([command]) => command === 'npx')]];
      expect(hookEnvs.length).toBeGreaterThanOrEqual(3);
      for (const seen of hookEnvs) {
        expect(seen?.PATH).toBe('/usr/bin');
        expect(seen?.npm_command).toBeUndefined();
        expect(seen?.npm_config_yes).toBeUndefined();
      }
      expect(byId(await runDoctor(h.env, h.cfg), 'secrets.guard').status).toBe('fail');
    });

    it('falls back to npx --no-install, the probe the git hooks use', async () => {
      const h = harness({ installed: ['git', 'gh', 'npx'], exec: { npx: { stdout: '0.1.0\n', code: 0, stderr: '' } } });
      const check = byId(await runDoctor(h.env, h.cfg), 'sdlc.onPath');
      expect(check.status).toBe('ok');
      expect(check.message).toContain('npx');
      expect(h.execCalls.filter(([command]) => command !== 'git')).toEqual([['npx', ['--no-install', 'sdlc', '--version']]]);
    });

    it('warns when neither finds sdlc: the git hooks skip', async () => {
      for (const options of [
        { installed: ['git', 'gh', 'npx'] },
        { installed: ['git', 'gh', 'npx'], exec: { npx: new Error('could not run npx: ENOENT') } },
        { installed: ['git', 'gh'] },
      ]) {
        const h = harness(options);
        const check = byId(await runDoctor(h.env, h.cfg), 'sdlc.onPath');
        expect(check.status).toBe('warn');
        expect(check.message).toMatch(/git hooks skip/);
        expect(check.fix).toMatch(/INSTALL\.md/);
      }
    });

    it('does not run npx when it is not installed', async () => {
      const h = harness({ installed: ['git', 'gh'] });
      await runDoctor(h.env, h.cfg);
      expect(h.execCalls.filter(([command]) => command !== 'git')).toEqual([]);
    });
  });

  describe('board.fields', () => {
    it('is ok when the board has every field, option and view', async () => {
      const check = byId(await runDoctor(harness().env, harness().cfg), 'board.fields');
      expect(check.status).toBe('ok');
      expect(check.message).toContain('#7');
    });

    it('fails with the planned changes and sdlc board ensure as the fix', async () => {
      const cfg = cfgOf(CONFIG);
      const h = harness({ gh: ghScript(cfg, { board: boardOf(cfg, nodes => nodes.filter(node => node['name'] !== 'Status')) }) });
      const check = byId(await runDoctor(h.env, cfg), 'board.fields');

      expect(check.status).toBe('fail');
      expect(check.message).toContain('Status');
      expect(check.fix).toBe('sdlc board ensure');
      expect(mutations(h.gh)).toEqual([]);
    });

    it('warns, not fails, when only views are missing, and says to create them manually if the API cannot', async () => {
      const cfg = cfgOf(CONFIG);
      const h = harness({ gh: ghScript(cfg, { board: boardOf(cfg, undefined, ['Board', 'In flight']) }) });
      const check = byId(await runDoctor(h.env, cfg), 'board.fields');

      expect(check.status).toBe('warn');
      expect(check.message).toContain('missing views: Awaiting deployment, Waiting on owner');
      expect(check.message).toContain('run sdlc board ensure; if the API cannot create them, create them manually');
      expect(check.message).not.toContain('missing fields');
      expect(check.fix).toBe('sdlc board ensure');
      expect(mutations(h.gh)).toEqual([]);
    });

    it('fails when fields and views are both missing, naming both', async () => {
      const cfg = cfgOf(CONFIG);
      const h = harness({ gh: ghScript(cfg, { board: boardOf(cfg, nodes => nodes.filter(node => node['name'] !== 'Status'), ['Board']) }) });
      const check = byId(await runDoctor(h.env, cfg), 'board.fields');

      expect(check.status).toBe('fail');
      expect(check.message).toContain('missing fields: Status');
      expect(check.message).toContain('missing views: In flight');
      expect(check.fix).toBe('sdlc board ensure');
    });

    it('fails when an option of a field is missing', async () => {
      const cfg = cfgOf(CONFIG);
      const h = harness({
        gh: ghScript(cfg, {
          board: boardOf(cfg, nodes =>
            nodes.map(node => {
              const options = node['options'] as Array<{ name: string }> | undefined;
              return node['name'] === 'Status' && options ? { ...node, options: options.slice(1) } : node;
            }),
          ),
        }),
      });
      const check = byId(await runDoctor(h.env, cfg), 'board.fields');

      expect(check.status).toBe('fail');
      expect(check.message).toMatch(/Status/);
      expect(check.fix).toBe('sdlc board ensure');
    });

    it('fails when no board is configured', async () => {
      const cfg = cfgOf(CONFIG.replace(', number: 7', ''));
      const h = harness({ cfg, fs: installedFs(cfg), gh: ghScript(cfg, { board: null }) });
      const checks = await runDoctor(h.env, cfg);
      const check = byId(checks, 'board.fields');

      expect(check.status).toBe('fail');
      expect(check.message).toMatch(/no board|project number/i);
      expect(check.fix).toBe('sdlc board ensure');
      expect(byId(checks, 'labels').status).toBe('ok');
      expect(mutations(h.gh)).toEqual([]);
    });

    it('fails with the message of an error (a field with another data type) and goes on', async () => {
      const cfg = cfgOf(CONFIG);
      const h = harness({ gh: ghScript(cfg, { board: boardOf(cfg, nodes => nodes.map(node => (node['name'] === 'Status' ? { ...node, dataType: 'TEXT', options: undefined } : node))) }) });
      const checks = await runDoctor(h.env, cfg);

      expect(byId(checks, 'board.fields').status).toBe('fail');
      expect(byId(checks, 'board.fields').message).toContain('another data type');
      expect(byId(checks, 'labels').status).toBe('ok');
    });
  });

  describe('labels', () => {
    it('fails and names the missing labels, with sdlc init as the fix', async () => {
      const cfg = cfgOf(CONFIG);
      const h = harness({ gh: ghScript(cfg, { labels: { match: ['label', 'list'], stdout: JSON.stringify([{ name: 'sdlc:task' }, { name: 'type:tooling' }]) } }) });
      const check = byId(await runDoctor(h.env, cfg), 'labels');

      expect(check.status).toBe('fail');
      expect(check.message).toContain('sdlc:partial');
      expect(check.message).toContain('type:analysis');
      expect(check.message).not.toContain('sdlc:task');
      expect(check.fix).toBe('sdlc init');
      expect(mutations(h.gh)).toEqual([]);
    });

    it('matches names without regard to case, as GitHub does', async () => {
      const cfg = cfgOf(CONFIG);
      const h = harness({ gh: ghScript(cfg, { labels: { match: ['label', 'list'], stdout: JSON.stringify(LABELS.map(name => ({ name: name.toUpperCase() }))) } }) });
      expect(byId(await runDoctor(h.env, cfg), 'labels').status).toBe('ok');
    });
  });

  describe('actions.workflow and actions.secret', () => {
    it('are not run without stack.actions', async () => {
      const cfg = cfgOf(`${HEADER}harnesses: [claude]\nstack: { actions: false }\n`);
      const h = harness({ cfg, fs: installedFs(cfg), configText: `${HEADER}harnesses: [claude]\nstack: { actions: false }\n` });
      const checks = await runDoctor(h.env, cfg);

      expect(checks.map(c => c.id)).toEqual([...PREFLIGHT_IDS, ...INSTALL_IDS.filter(id => !id.startsWith('actions.'))]);
      expect(h.gh.calls.some(call => call.includes('secret'))).toBe(false);
      expect(notOk(checks)).toEqual([]);
    });

    it('fails when the workflow file is missing', async () => {
      const fs = installedFs(cfgOf(CONFIG));
      fs.remove('.github/workflows/sdlc-reconcile.yml');
      const check = byId(await runDoctor(harness({ fs }).env, cfgOf(CONFIG)), 'actions.workflow');
      expect(check).toMatchObject({ status: 'fail', fix: 'sdlc init' });
      expect(check.message).toContain('sdlc-reconcile.yml');
    });

    it('is ok when SDLC_TOKEN is among the repository secrets, reading only names', async () => {
      const h = harness();
      const checks = await runDoctor(h.env, h.cfg);

      expect(byId(checks, 'actions.workflow').status).toBe('ok');
      expect(byId(checks, 'actions.secret').status).toBe('ok');
      expect(h.gh.calls).toContainEqual(['secret', 'list', '--repo', 'acme/shop', '--json', 'name']);
    });

    it('fails when SDLC_TOKEN is not set, with gh secret set as the fix', async () => {
      const cfg = cfgOf(CONFIG);
      const h = harness({ gh: ghScript(cfg, { secrets: { match: ['secret', 'list'], stdout: JSON.stringify([{ name: 'OTHER' }]) } }) });
      const check = byId(await runDoctor(h.env, cfg), 'actions.secret');
      expect(check.status).toBe('fail');
      expect(check.message).toContain('SDLC_TOKEN');
      expect(check.message).toContain('(organization-level secrets are not visible to this check)');
      expect(check.fix).toBe('gh secret set SDLC_TOKEN');
    });

    it('warns that it cannot verify SDLC_TOKEN when GitHub answers 403 (listing secrets needs admin access)', async () => {
      const cfg = cfgOf(CONFIG);
      const h = harness({ gh: ghScript(cfg, { secrets: { match: ['secret', 'list'], code: 1, stderr: 'HTTP 403: Resource not accessible by personal access token\n' } }) });
      const check = byId(await runDoctor(h.env, cfg), 'actions.secret');
      expect(check.status).toBe('warn');
      expect(check.message).toBe('cannot verify SDLC_TOKEN (needs admin access to list secrets)');
    });

    it('fails with the reason when the secrets cannot be listed for another reason', async () => {
      const cfg = cfgOf(CONFIG);
      const h = harness({ gh: ghScript(cfg, { secrets: { match: ['secret', 'list'], code: 1, stderr: 'HTTP 500: Server Error\nsecond line\n' } }) });
      const check = byId(await runDoctor(h.env, cfg), 'actions.secret');
      expect(check.status).toBe('fail');
      expect(check.message).toContain('500');
      expect(check.message).not.toContain('\n');
    });
  });

  describe('gh-dependent checks without a usable gh', () => {
    it('say they were not checked instead of failing again, and make no gh call', async () => {
      const cfg = cfgOf(CONFIG);
      const h = harness({ gh: [{ match: ['auth', 'status'], code: 1, stderr: 'not logged in' }] });
      const checks = await runDoctor(h.env, cfg);

      for (const id of ['board.fields', 'labels', 'actions.secret', 'secrets.pushProtection']) {
        expect(byId(checks, id).status).toBe('warn');
        expect(byId(checks, id).message).toMatch(/^not checked: gh/);
      }
      expect(byId(checks, 'git.hooksPath').status).toBe('ok');
      expect(h.gh.calls).toEqual([['auth', 'status']]);
    });
  });

  describe('mcp.token', () => {
    it('is ok when the variable the servers read is set, and names it without its value', async () => {
      const check = byId(await runDoctor(harness().env, harness().cfg), 'mcp.token');
      expect(check.status).toBe('ok');
      expect(check.message).toContain(TOKEN_VAR);
      expect(check.message).not.toContain(githubToken());
    });

    it('warns when it is unset or empty', async () => {
      for (const env of [{ [TOKEN_VAR]: undefined }, { [TOKEN_VAR]: '' }]) {
        const check = byId(await runDoctor(harness({ env }).env, cfgOf(CONFIG)), 'mcp.token');
        expect(check.status).toBe('warn');
        expect(check.message).toContain(TOKEN_VAR);
        expect(check.fix).toContain(`export ${TOKEN_VAR}="$(security find-generic-password -s <service> -w)"`);
        expect(check.fix).toContain('from the OS keystore');
        expect(check.fix).not.toMatch(/=<token>|=\S*<token/);
      }
    });

    it('needs no variable for servers that read none, and for an AGENTS.md-only setup', async () => {
      const noVars = cfgOf(configWith('mcp: { servers: [context7] }\n'));
      const withoutToken = { [TOKEN_VAR]: undefined };
      const a = byId(await runDoctor(harness({ cfg: noVars, fs: installedFs(noVars), env: withoutToken }).env, noVars), 'mcp.token');
      expect(a.status).toBe('ok');
      expect(a.message).toMatch(/no .*environment variable/i);

      const agentsOnly = cfgOf(configWith('', '[agents-md]'));
      const b = byId(await runDoctor(harness({ cfg: agentsOnly, fs: installedFs(agentsOnly), env: withoutToken }).env, agentsOnly), 'mcp.token');
      expect(b.status).toBe('ok');
    });
  });

  describe('mcp.claude', () => {
    it('is skipped when claude is not a configured harness', async () => {
      const cfg = cfgOf(configWith('', '[codex]'));
      const h = harness({ cfg, fs: installedFs(cfg) });
      const check = byId(await runDoctor(h.env, cfg), 'mcp.claude');
      expect(check.status).toBe('ok');
      expect(check.message).toMatch(/skipped/);
      expect(h.execCalls.filter(([command]) => command !== 'git')).toEqual([]);
    });

    it('is ok, and skipped, when the claude CLI is not on the PATH', async () => {
      const h = harness({ installed: ['git', 'gh', 'sdlc'] });
      const check = byId(await runDoctor(h.env, h.cfg), 'mcp.claude');
      expect(check).toMatchObject({ status: 'ok', message: 'claude CLI not found; skipped' });
      expect(h.execCalls.filter(([command]) => command !== 'git')).toEqual([]);
    });

    it('is ok when claude mcp list names every configured server', async () => {
      const h = harness();
      const check = byId(await runDoctor(h.env, h.cfg), 'mcp.claude');
      expect(check.status).toBe('ok');
      expect(check.message).toContain('github');
      expect(h.execCalls.filter(([command]) => command !== 'git')).toEqual([['claude', ['mcp', 'list']]]);
    });

    it('warns for a configured server claude does not list, naming it', async () => {
      const cfg = cfgOf(configWith('mcp: { servers: [github, context7, playwright] }\n'));
      const h = harness({ cfg, fs: installedFs(cfg) });
      const check = byId(await runDoctor(h.env, cfg), 'mcp.claude');

      expect(check.status).toBe('warn');
      expect(check.message).toContain('playwright');
      expect(check.message).not.toMatch(/\bgithub\b.*not listed|not listed.*\bcontext7\b/);
      expect(check.fix).toBe('approve the server in Claude Code or run the printed claude mcp add command');
    });

    it('does not take a longer name for a configured server', async () => {
      const h = harness({ exec: { claude: { stdout: 'github-enterprise: https://x.test (HTTP) - ✓ Connected\n', code: 0, stderr: '' } } });
      const check = byId(await runDoctor(h.env, h.cfg), 'mcp.claude');
      expect(check.status).toBe('warn');
      expect(check.message).toContain('github');
    });

    it('on a failing claude mcp list prints the exit code and the first line of stderr only, never stdout', async () => {
      const claude = {
        stdout: `other: https://x.test/mcp?token=${githubToken()} (HTTP) - failed\n`,
        code: 2,
        stderr: 'boom\u001b[31m happened\nsecond line\n',
      };
      const check = byId(await runDoctor(harness({ exec: { claude } }).env, cfgOf(CONFIG)), 'mcp.claude');

      expect(check.status).toBe('warn');
      expect(check.message).toBe('claude mcp list failed (exit 2): boom happened');
      expect(check.message).not.toContain(githubToken());
      expect(check.message).not.toContain('other');
    });

    it('with a failing claude mcp list and an empty stderr says only the exit code, not stdout', async () => {
      const claude = { stdout: `leak ${githubToken()}\n`, code: 1, stderr: '' };
      const check = byId(await runDoctor(harness({ exec: { claude } }).env, cfgOf(CONFIG)), 'mcp.claude');

      expect(check.status).toBe('warn');
      expect(check.message).toBe('claude mcp list failed (exit 1)');
    });

    it('warns, and does not fail, when claude mcp list fails or cannot run', async () => {
      for (const claude of [{ stdout: '', code: 1, stderr: 'boom' }, new Error('claude timed out after 120s')]) {
        const check = byId(await runDoctor(harness({ exec: { claude } }).env, cfgOf(CONFIG)), 'mcp.claude');
        expect(check.status).toBe('warn');
        expect(check.message).toMatch(/claude mcp list/);
      }
    });

    it('is ok when no MCP server is configured', async () => {
      const cfg = cfgOf(configWith('mcp: { servers: [] }\n'));
      const h = harness({ cfg, fs: installedFs(cfg) });
      expect(byId(await runDoctor(h.env, cfg), 'mcp.claude').status).toBe('ok');
      expect(h.execCalls.filter(([command]) => command !== 'git')).toEqual([]);
    });
  });

  describe('secrets.guard', () => {
    it('is ok when core.hooksPath is active and sdlc is resolvable', async () => {
      expect(byId(await runDoctor(harness().env, harness().cfg), 'secrets.guard').status).toBe('ok');
    });

    it('fails as inactive when the hooks path is wrong, with sdlc init as the fix', async () => {
      const check = byId(await runDoctor(harness({ git: { hooksPath: '.husky/_' } }).env, cfgOf(CONFIG)), 'secrets.guard');
      expect(check.status).toBe('fail');
      expect(check.message).toMatch(/^secret guard inactive/);
      expect(check.fix).toContain('sdlc init');
    });

    it('fails as inactive when sdlc cannot be found, with install sdlc as the fix', async () => {
      const check = byId(await runDoctor(harness({ installed: ['git', 'gh'] }).env, cfgOf(CONFIG)), 'secrets.guard');
      expect(check.status).toBe('fail');
      expect(check.message).toMatch(/^secret guard inactive/);
      expect(check.fix).toMatch(/install sdlc/);
      expect(check.fix).not.toContain('sdlc init');
    });

    it('says it could not verify the hooks path, still failing, when git cannot read core.hooksPath', async () => {
      const h = harness();
      const base = h.env.git;
      h.env.git = async args =>
        args.join(' ') === 'config --get core.hooksPath' ? { stdout: '', code: 128, stderr: 'fatal: bad config line 1 in file .git/config' } : base(args);
      const check = byId(await runDoctor(h.env, h.cfg), 'secrets.guard');

      expect(check.status).toBe('fail');
      expect(check.message).toMatch(/^secret guard cannot be verified: could not read core\.hooksPath \(.*bad config line 1/);
      expect(check.message).not.toMatch(/inactive|is not \.sdlc\/githooks/);
      expect(check.fix).toContain('git config --get core.hooksPath');
      expect(check.fix).not.toContain('sdlc init');
    });

    it('is inactive, not just unverifiable, when core.hooksPath cannot be read and sdlc cannot be found', async () => {
      const h = harness({ installed: ['git', 'gh'] });
      const base = h.env.git;
      h.env.git = async args => (args.join(' ') === 'config --get core.hooksPath' ? { stdout: '', code: 128, stderr: 'fatal: bad config' } : base(args));
      const check = byId(await runDoctor(h.env, h.cfg), 'secrets.guard');

      expect(check.status).toBe('fail');
      expect(check.message).toMatch(/^secret guard inactive: could not read core\.hooksPath .*; sdlc cannot be found/);
      expect(check.fix).toMatch(/install sdlc/);
    });

    it('gives both fixes when both are wrong', async () => {
      const check = byId(await runDoctor(harness({ installed: ['git', 'gh'], git: { hooksPath: 'other' } }).env, cfgOf(CONFIG)), 'secrets.guard');
      expect(check.status).toBe('fail');
      expect(check.fix).toContain('sdlc init');
      expect(check.fix).toMatch(/install sdlc/);
    });
  });

  describe('secrets.pushProtection', () => {
    const security = (cfg: Config, step: FakeGhStep): Harness => harness({ gh: ghScript(cfg, { security: step }) });
    const cfg = cfgOf(CONFIG);

    it('is ok when secret scanning and push protection are enabled', async () => {
      expect(byId(await runDoctor(harness().env, cfg), 'secrets.pushProtection').status).toBe('ok');
    });

    it('warns when push protection is not enabled, and says what GitHub reports', async () => {
      const off = JSON.stringify({ secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'disabled' } });
      const h = security(cfg, { match: ['api'], stdout: off });
      const check = byId(await runDoctor(h.env, cfg), 'secrets.pushProtection');

      expect(check.status).toBe('warn');
      expect(check.message).toContain('push protection: disabled');
      expect(check.message).toContain('secret scanning: enabled');
      expect(check.fix).toBe('sdlc init');
      expect(mutations(h.gh)).toEqual([]);
    });

    it('warns with the reason when GitHub shows no security settings to this account', async () => {
      for (const stdout of ['null\n', '', '{}']) {
        const check = byId(await runDoctor(security(cfg, { match: ['api'], stdout }).env, cfg), 'secrets.pushProtection');
        expect(check.status).toBe('warn');
        expect(check.message).toMatch(/not shown|cannot be verified|admin/i);
      }
    });

    it('warns with the reason gh gives when the settings cannot be read (plan, rights)', async () => {
      const step: FakeGhStep = { match: ['api'], code: 1, stderr: 'gh: Resource not accessible by integration (HTTP 403)\nmore\n' };
      const check = byId(await runDoctor(security(cfg, step).env, cfg), 'secrets.pushProtection');
      expect(check.status).toBe('warn');
      expect(check.message).toContain('Resource not accessible by integration');
      expect(check.message).not.toContain('\n');
    });

    it('fails on any other error (a rate limit, the network) like every check does', async () => {
      const step: FakeGhStep = { match: ['api'], code: 1, stderr: 'gh: Server Error (HTTP 500)' };
      const check = byId(await runDoctor(security(cfg, step).env, cfg), 'secrets.pushProtection');
      expect(check.status).toBe('fail');
      expect(check.message).toContain('500');
    });
  });

  describe('secrets.trackedFiles', () => {
    const tracked = async (files: string[], cfg = cfgOf(CONFIG)): Promise<Check> =>
      byId(await runDoctor(harness({ cfg, fs: installedFs(cfg), git: { tracked: files } }).env, cfg), 'secrets.trackedFiles');

    it('is ok when no tracked file name looks like it holds a secret', async () => {
      expect((await tracked(['README.md', '.env.example', 'src/keys.ts', 'docs/credentials.md'])).status).toBe('ok');
    });

    it('warns (spec 14a) and lists only the paths of tracked files matching the file-name rules', async () => {
      const files = ['.env', 'deploy/server.pem', 'README.md', 'a/b/id_rsa', '.env.example'];
      const check = await tracked(files);

      expect(check.status).toBe('warn');
      for (const hit of ['.env', 'deploy/server.pem', 'a/b/id_rsa']) expect(check.message).toContain(hit);
      expect(check.message).not.toContain('README.md');
      expect(check.message).not.toContain('.env.example');
      expect(check.fix).toBe('git rm --cached <file>, rotate the secret, store it in the keystore');
    });

    it('agrees with the commit guard on what a secret file name is', async () => {
      const names = ['.env.local', 'client.key', 'keystore.p12', 'credentials.json', 'id_ed25519', 'plain.txt'];
      const expected = names.filter(name => scanFileName(name) !== undefined);
      expect(expected.length).toBeGreaterThan(0);
      const check = await tracked(names);
      for (const name of names) expect(check.message.includes(name)).toBe(expected.includes(name));
    });

    it('skips a file whose fingerprint the owner accepted in secrets.allow', async () => {
      const finding = scanFileName('config/service.pem');
      expect(finding).toBeDefined();
      const cfg = cfgOf(configWith(`secrets: { allow: ["${finding?.fingerprint}"] }\n`));
      const check = await tracked(['config/service.pem', '.env'], cfg);

      expect(check.status).toBe('warn');
      expect(check.message).not.toContain('service.pem');
      expect(check.message).toContain('.env');
    });

    it('prints a path with control characters as one safe line', async () => {
      const check = await tracked(['dir/.env.\u001b[2K\nboom']);
      expect(check.status).toBe('warn');
      expect(check.message).toContain('dir/.env.');
      expect(check.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    });

    it('fails with the reason when git ls-files fails', async () => {
      const h = harness();
      const base = h.env.git;
      h.env.git = async args => (args[0] === 'ls-files' ? { stdout: '', code: 128, stderr: 'fatal: not a git repository' } : base(args));
      const check = byId(await runDoctor(h.env, h.cfg), 'secrets.trackedFiles');
      expect(check.status).toBe('fail');
      expect(check.message).toContain('fatal: not a git repository');
    });
  });

  describe('approvals.trust', () => {
    const trust = async (mode: string, extra: string): Promise<Check> => {
      const cfg = cfgOf(`${HEADER.replace('mode: observe', `mode: ${mode}`)}harnesses: [claude, codex]\n${extra}`);
      return byId(await runDoctor(harness({ cfg, fs: installedFs(cfg), gh: ghScript(cfg) }).env, cfg), 'approvals.trust');
    };

    it('warns in enforce mode with Actions and no agents', async () => {
      const check = await trust('enforce', 'stack: { actions: true }\n');
      expect(check.status).toBe('warn');
      expect(check.message).toBe(
        "comment approvals from the Actions token's login are ignored in enforce mode; run agents under a separate account listed in agents (see INSTALL.md)",
      );
    });

    it('is ok with agents listed, in observe mode, and without Actions', async () => {
      expect((await trust('enforce', 'stack: { actions: true }\nagents: [shop-bot]\n')).status).toBe('ok');
      expect((await trust('observe', 'stack: { actions: true }\n')).status).toBe('ok');
      expect((await trust('enforce', 'stack: { actions: false }\n')).status).toBe('ok');
    });
  });

  describe('isolation', () => {
    it('keeps every other check when one throws', async () => {
      const cfg = cfgOf(CONFIG);
      const h = harness({ gh: ghScript(cfg, { labels: { match: ['label', 'list'], stdout: '{{{' } }) });
      const checks = await runDoctor(h.env, cfg);

      expect(checks.map(c => c.id)).toEqual([...PREFLIGHT_IDS, ...INSTALL_IDS]);
      expect(byId(checks, 'labels').status).toBe('fail');
      expect(byId(checks, 'labels').message).not.toContain('\n');
      expect(notOk(checks)).toEqual([['labels', 'fail']]);
    });
  });
});

// --- sdlc doctor ----------------------------------------------------------------------------------

describe('sdlc doctor', () => {
  let exitCode: typeof process.exitCode;
  beforeEach(() => {
    exitCode = process.exitCode;
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = exitCode;
  });

  interface Run {
    out: string[];
    err: string[];
    exit: typeof process.exitCode;
  }

  async function doctor(h: Harness, args: string[]): Promise<Run> {
    const out: string[] = [];
    const err: string[] = [];
    const context: DoctorContext = { env: h.env, out: text => out.push(text), err: text => err.push(text) };
    await runCli(args, { makeDoctorContext: () => context, out: text => out.push(text), err: text => err.push(text) });
    return { out, err, exit: process.exitCode };
  }
  const json = (run: Run): { checks: Check[]; ok: boolean } => JSON.parse(run.out.join('\n')) as { checks: Check[]; ok: boolean };

  it('runs every check against an installed repository and exits 0 when none fails', async () => {
    const h = harness();
    const run = await doctor(h, ['doctor']);

    expect(run.exit).toBeUndefined();
    expect(run.err).toEqual([]);
    const lines = run.out.join('\n').split('\n');
    expect(lines).toHaveLength(PREFLIGHT_IDS.length + INSTALL_IDS.length);
    expect(lines.every(line => line.startsWith('✓ '))).toBe(true);
    expect(lines[0]).toMatch(/^✓ git\.repo: /);
  });

  it('prints ✓, ! and ✗ with the message and an indented fix, and exits 1 when a check fails', async () => {
    const h = harness({ git: { hooksPath: '.husky/_' }, installed: ['git', 'gh', 'npx', 'claude'] });
    const run = await doctor(h, ['doctor']);
    const text = run.out.join('\n');

    expect(run.exit).toBe(1);
    expect(text).toMatch(/^! sdlc\.onPath: .*git hooks skip\n {2}fix: .*INSTALL\.md/m);
    expect(text).toMatch(/^✗ git\.hooksPath: .*\n {2}fix: git config core\.hooksPath \.sdlc\/githooks/m);
    expect(text).toMatch(/^✓ git\.repo: /m);
    expect(text.split('\n').every(line => /^(✓|!|✗) \S+: /.test(line) || line.startsWith('  fix: '))).toBe(true);
  });

  it('exits 0 with only warnings', async () => {
    const human = await doctor(harness({ env: { [TOKEN_VAR]: undefined } }), ['doctor']);
    const machine = await doctor(harness({ env: { [TOKEN_VAR]: undefined } }), ['doctor', '--json']);

    expect(human.exit).toBeUndefined();
    expect(human.out.join('\n')).toMatch(/^! mcp\.token: .*\n {2}fix: export /m);
    expect(machine.exit).toBeUndefined();
    expect(json(machine).ok).toBe(true);
    expect(byId(json(machine).checks, 'mcp.token').status).toBe('warn');
  });

  it('prints {checks, ok} with --json, wherever the flag stands', async () => {
    for (const args of [['doctor', '--json'], ['--json', 'doctor']]) {
      const run = await doctor(harness(), args);
      const report = json(run);

      expect(Object.keys(report)).toEqual(['checks', 'ok']);
      expect(report.ok).toBe(true);
      expect(report.checks.map(c => c.id)).toEqual([...PREFLIGHT_IDS, ...INSTALL_IDS]);
      for (const check of report.checks) {
        expect(Object.keys(check).every(key => ['id', 'status', 'message', 'fix'].includes(key))).toBe(true);
        expect(['ok', 'warn', 'fail']).toContain(check.status);
      }
      expect(run.exit).toBeUndefined();
    }
  });

  it('has ok false and exit code 1 in --json when a check fails', async () => {
    const run = await doctor(harness({ nodeVersion: 'v18.0.0' }), ['doctor', '--json']);

    expect(run.exit).toBe(1);
    const report = json(run);
    expect(report.ok).toBe(false);
    expect(byId(report.checks, 'node.version')).toMatchObject({ status: 'fail' });
  });

  it('without a config file runs the preflight only: config.present warns and the exit code follows the failures', async () => {
    const h = harness({ configText: null, fs: memoryFs(), gh: ghScript(cfgOf(CONFIG)).slice(0, 2) });
    const run = await doctor(h, ['doctor', '--json']);

    const report = json(run);
    expect(report.checks.map(c => c.id)).toEqual(PREFLIGHT_IDS);
    expect(byId(report.checks, 'config.present')).toMatchObject({ status: 'warn', fix: 'run sdlc config suggest' });
    expect(report.ok).toBe(true);
    expect(run.exit).toBeUndefined();

    const failing = await doctor(harness({ configText: null, nodeVersion: 'v16.0.0', gh: ghScript(cfgOf(CONFIG)).slice(0, 2) }), ['doctor']);
    expect(failing.exit).toBe(1);
  });

  it('with an invalid config fails config.valid, skips the checks that need the config, and does not crash', async () => {
    const h = harness({ configText: CONFIG.replace('mode: observe', 'mode: sometimes'), gh: ghScript(cfgOf(CONFIG)).slice(0, 2) });
    const run = await doctor(h, ['doctor', '--json']);

    expect(run.exit).toBe(1);
    expect(run.err).toEqual([]);
    const report = json(run);
    expect(report.checks.map(c => c.id)).toEqual([...PREFLIGHT_IDS, 'config.valid']);
    const valid = byId(report.checks, 'config.valid');
    expect(valid.status).toBe('fail');
    expect(valid.message).not.toContain('\n');
    expect(valid.message).toMatch(/mode/);
    expect(valid.fix).toBe('sdlc config validate');
    expect(report.ok).toBe(false);
  });

  it('with an unreadable config file fails config.valid with the reason', async () => {
    const h = harness({ gh: ghScript(cfgOf(CONFIG)).slice(0, 2) });
    h.env.config = {
      path: 'sdlc.config.yaml',
      read: () => {
        throw new Error('EACCES: permission denied, open sdlc.config.yaml');
      },
    };
    const run = await doctor(h, ['doctor', '--json']);

    const report = json(run);
    expect(byId(report.checks, 'config.present').status).toBe('fail');
    expect(byId(report.checks, 'config.valid').status).toBe('fail');
    expect(byId(report.checks, 'config.valid').message).toContain('EACCES');
    expect(run.exit).toBe(1);
  });

  it('--preflight runs only the preflight, even with a valid config and an installed repository', async () => {
    const h = harness({ gh: ghScript(cfgOf(CONFIG)).slice(0, 2) });
    const run = await doctor(h, ['doctor', '--preflight', '--json']);

    expect(json(run).checks.map(c => c.id)).toEqual(PREFLIGHT_IDS);
    expect(h.git.calls.map(call => call.join(' '))).toEqual(['rev-parse --is-inside-work-tree']);
    expect(run.exit).toBeUndefined();
  });

  it('--preflight in a bare repository: a failing preflight exits 1 and the install is not looked at', async () => {
    const h = harness({ configText: null, fs: memoryFs(), installed: ['git'], gh: [] });
    const run = await doctor(h, ['doctor', '--preflight']);

    expect(run.exit).toBe(1);
    expect(run.out.join('\n')).toMatch(/^✗ gh\.installed: /m);
  });

  it('reports a failure that stops it before any check like the other commands: on stderr, exit 1, or as {error} with --json', async () => {
    const err: string[] = [];
    await runCli(['doctor'], {
      makeDoctorContext: () => {
        throw new Error('cannot build the context');
      },
      err: text => err.push(text),
    });
    expect(process.exitCode).toBe(1);
    expect(err).toEqual(['cannot build the context']);

    process.exitCode = undefined;
    const out: string[] = [];
    await runCli(['doctor', '--json'], {
      makeDoctorContext: () => {
        throw new Error('cannot build the context');
      },
      out: text => out.push(text),
    });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(out.join('\n'))).toEqual({ error: 'cannot build the context' });
  });

  it('never prints a secret value or the contents of a tracked secret file', async () => {
    const h = harness({ git: { tracked: ['.env'] } });
    h.fs.write('.env', `${TOKEN_VAR}=${githubToken()}\n`);
    const run = await doctor(h, ['doctor', '--json']);

    const all = run.out.join('\n') + run.err.join('\n');
    expect(all).not.toContain(githubToken());
    expect(byId(json(run).checks, 'secrets.trackedFiles').message).toContain('.env');
  });
});

describe('hookEnvironment', () => {
  it('always drops _npx package directories, and keeps everything else outside npx', () => {
    const { env, stripped } = hookEnvironment({ PATH: '/a/_npx/x/node_modules/.bin:/repo/node_modules/.bin:/usr/bin', npm_config_x: '1', HOME: '/h' });
    expect(env).toEqual({ PATH: '/repo/node_modules/.bin:/usr/bin', npm_config_x: '1', HOME: '/h' });
    expect(stripped).toBe(1);
  });

  it('under npm exec also drops the node_modules/.bin and node-gyp-bin directories and the npm_ variables', () => {
    const { env, stripped } = hookEnvironment({
      PATH: '/repo/node_modules/.bin:/node-gyp-bin:/usr/local/bin',
      npm_command: 'exec',
      HOME: '/h',
    });
    expect(env).toEqual({ PATH: '/usr/local/bin', HOME: '/h' });
    expect(stripped).toBe(2);
  });

  it('on Windows strips the PATH under the name it has (`Path`), split and joined at `;`', () => {
    const { env, stripped } = hookEnvironment(
      { Path: 'C:\\npm-cache\\_npx\\1a\\node_modules\\.bin;C:\\repo\\node_modules\\.bin;C:\\Windows', npm_command: 'exec' },
      'win32',
    );
    expect(env).toEqual({ Path: 'C:\\Windows' });
    expect(stripped).toBe(2);
  });

  it('on Windows strips the PATH of a case-insensitive environment like the real process.env', () => {
    const stored: Record<string, string> = { Path: 'C:\\npm-cache\\_npx\\1a\\node_modules\\.bin;C:\\Windows', HOME: 'C:\\h' };
    const find = (key: string | symbol) => (typeof key === 'string' ? Object.keys(stored).find(k => k.toUpperCase() === key.toUpperCase()) : undefined);
    const processLike = new Proxy(stored, {
      get: (target, key) => { const k = find(key); return k === undefined ? undefined : target[k]; },
      has: (_target, key) => find(key) !== undefined,
    }) as NodeJS.ProcessEnv;
    const { env, stripped } = hookEnvironment(processLike, 'win32');
    expect(env).toEqual({ Path: 'C:\\Windows', HOME: 'C:\\h' });
    expect(stripped).toBe(1);
  });

  it('reads Windows paths too', () => {
    expect(/[\\/]_npx[\\/]/.test('C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\1a\\node_modules\\.bin')).toBe(true);
  });
});
