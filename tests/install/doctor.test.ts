import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli.js';
import { runHook } from '../../src/commands/hook.js';
import type { DoctorContext } from '../../src/commands/doctor.js';
import { loadConfigFromString, type Config } from '../../src/config/schema.js';
import type { TaskState } from '../../src/core/types.js';
import { GhError } from '../../src/github/gh.js';
import { desiredFields } from '../../src/github/board.js';
import { applyPlan, planApply } from '../../src/install/apply.js';
import { describeError, hookEnvironment, parseTokenScopes, runDoctor, runPreflight, type Check, type DoctorEnv, type ExecOptions } from '../../src/install/doctor.js';
import { MANIFEST_PATH } from '../../src/install/manifest.js';
import type { GitRunner } from '../../src/install/provision.js';
import { graphifyInstall, superpowersInstall } from '../../src/install/stack.js';
import { renderAll } from '../../src/render/plan.js';
import { scanFileName } from '../../src/secrets/scan.js';
import { fakeGh, labelListStep, type FakeGh, type FakeGhStep } from '../support/fakeGh.js';
import { memoryFs, type MemoryFs } from '../support/memoryFs.js';
import { githubToken } from '../support/secrets.js';
import { NoStateCommentError, type TrackedTask, type Tracker } from '../../src/tracker/types.js';

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
  'git.version',
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
  'mcp.codex',
  'mcp.gemini',
  'stack.superpowers',
  'stack.graphify',
  'hooks.claude',
  'hooks.codex',
  'hooks.gemini',
  'hooks.switches',
  'hooks.roundtrip',
  'secrets.guard',
  'secrets.pushProtection',
  'secrets.trackedFiles',
  'approvals.trust',
  'outbox.pending',
  'worktrees.orphans',
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
    over.labels ?? labelListStep(LABELS),
    ...(cfg.stack.actions ? [over.secrets ?? { match: ['secret', 'list'], stdout: JSON.stringify([{ name: 'SDLC_TOKEN' }, { name: 'OTHER' }]) }] : []),
    over.security ?? { match: ['api', 'repos/acme/shop', '--jq'], stdout: SECURITY_ON },
  ];
}

interface GitState {
  inside?: boolean;
  /** `undefined` leaves core.hooksPath unset. */
  hooksPath?: string;
  tracked?: string[];
  /** What `git --version` prints; defaults to a recent git. */
  version?: string;
  /** Whether the hook launcher is in `HEAD` (default); false is a launcher that was never committed. */
  launcherCommitted?: boolean;
  /** The mode `git ls-tree HEAD` shows for the launcher (the committed one); defaults to the executable 100755. `null` makes the call fail. */
  launcherMode?: string | null;
  /** The output of `git worktree list --porcelain`; defaults to the one main checkout, `/memory`. */
  worktrees?: string;
  /** Makes `git worktree list` fail. */
  worktreesFail?: boolean;
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
    if (line === '--version') return { stdout: `${state.version ?? 'git version 2.43.0'}\n`, code: 0, stderr: '' };
    if (line === 'cat-file -e HEAD:.sdlc/hooks/run.sh') {
      return state.launcherCommitted === false
        ? { stdout: '', code: 128, stderr: "fatal: path '.sdlc/hooks/run.sh' exists on disk, but not in 'HEAD'" }
        : { stdout: '', code: 0, stderr: '' };
    }
    if (line === 'ls-tree HEAD -- .sdlc/hooks/run.sh') {
      if (state.launcherMode === null) return { stdout: '', code: 128, stderr: 'fatal: not a tree object' };
      return { stdout: `${state.launcherMode ?? '100755'} blob 0123456789abcdef0123456789abcdef01234567\t.sdlc/hooks/run.sh\n`, code: 0, stderr: '' };
    }
    if (line === 'worktree list --porcelain') {
      return state.worktreesFail === true
        ? { stdout: '', code: 128, stderr: 'fatal: this operation must be run in a work tree' }
        : { stdout: state.worktrees ?? 'worktree /memory\nHEAD 0123456789abcdef\nbranch refs/heads/main\n\n', code: 0, stderr: '' };
    }
    if (line === 'ls-files -z') {
      const tracked = state.tracked ?? ['README.md', 'src/index.ts'];
      return { stdout: tracked.map(path => `${path}\0`).join(''), code: 0, stderr: '' };
    }
    throw new Error(`unexpected git call: ${line}`);
  };
  return Object.assign(run, { calls });
}

type ExecResult = { stdout: string; code: number; stderr: string };
const PLUGINS = {
  claude: JSON.stringify([{ id: 'superpowers@claude-plugins-official', version: '7.0.2', scope: 'user', enabled: true }]),
  codex: JSON.stringify({ installed: [{ pluginId: 'superpowers@openai-curated', name: 'superpowers', version: '7.0.2', enabled: true }], available: [] }),
  gemini: JSON.stringify([{ name: 'superpowers', version: '7.0.2', isActive: true }]),
};
const CODEX_MCP = JSON.stringify([{ name: 'github', enabled: true }, { name: 'context7', enabled: true }]);
const GEMINI_MCP = [
  'Configured MCP servers:',
  '',
  '✓ github: https://api.githubcopilot.com/mcp/ (http) - Connected',
  '✓ context7: npx -y @upstash/context7-mcp (stdio) - Connected',
  '',
].join('\n');
const stdoutOf = (stdout: string): ExecResult => ({ stdout, code: 0, stderr: '' });

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
  /**
   * What `exec` answers per command; a thrown value rejects. `git` is `git ls-remote` of kit.ref for a branch (found by default),
   * `npm` is `npm view` of kit.ref for a release tag (published by default), `claude` is `claude mcp list`. The others are the list commands of the stack and MCP checks, each answering what a healthy machine does.
   */
  exec?: {
    npx?: ExecResult | Error;
    npm?: ExecResult | Error;
    claude?: ExecResult | Error;
    git?: ExecResult | Error;
    claudePlugins?: ExecResult | Error;
    codexPlugins?: ExecResult | Error;
    geminiPlugins?: ExecResult | Error;
    codexMcp?: ExecResult | Error;
    geminiMcp?: ExecResult | Error;
    graphify?: ExecResult | Error;
  };
  /** Replaces the in-process `runHook` of the round trip. */
  hookRunner?: DoctorEnv['hookRunner'];
  /** Replaces the GitHub tracker the orphan worktree check asks for tasks. */
  makeTracker?: DoctorEnv['makeTracker'];
  platform?: NodeJS.Platform;
  /** The repository's own hooks in `.git/hooks`, by name. */
  legacyHooks?: Record<string, 'executable' | 'not-executable'>;
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  /** The config file's text; `null` is no file. */
  configText?: string | null;
  /** Files of the home directory, by path relative to it. */
  userFiles?: Record<string, string>;
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
  execOptions: Array<ExecOptions | undefined>;
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
  const installed = new Set(options.installed ?? ['git', 'gh', 'sdlc', 'npx', 'claude', 'graphify']);
  const execCalls: Array<[string, string[]]> = [];
  const execEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
  const execOptions: Array<ExecOptions | undefined> = [];
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
    exec: async (cmd, args, execOpts) => {
      execCalls.push([cmd, args]);
      execEnvs.push(execOpts?.env);
      execOptions.push(execOpts);
      const plugin = args[0] === 'plugin' || args[0] === 'extensions';
      const answer =
        cmd === 'claude'
          ? plugin
            ? (answers.claudePlugins ?? stdoutOf(PLUGINS.claude))
            : (answers.claude ?? { stdout: CLAUDE_LIST, code: 0, stderr: '' })
          : cmd === 'codex'
            ? plugin
              ? (answers.codexPlugins ?? stdoutOf(PLUGINS.codex))
              : (answers.codexMcp ?? stdoutOf(CODEX_MCP))
            : cmd === 'gemini'
              ? plugin
                ? (answers.geminiPlugins ?? stdoutOf(PLUGINS.gemini))
                : (answers.geminiMcp ?? stdoutOf(GEMINI_MCP))
              : cmd === 'graphify'
                ? (answers.graphify ?? stdoutOf('graphify 0.9.122\n'))
                : cmd === 'npx'
                  ? (answers.npx ?? { stdout: '', code: 1, stderr: 'npx: not found' })
                  : cmd === 'npm'
                    ? (answers.npm ?? { stdout: `${JSON.stringify(args[1]?.replace(/^.*@/, ''))}\n`, code: 0, stderr: '' })
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
    ...(options.hookRunner === undefined ? {} : { hookRunner: options.hookRunner }),
    ...(options.makeTracker === undefined ? {} : { makeTracker: options.makeTracker }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    userFile: path => options.userFiles?.[path],
  };
  return { env, gh, git, fs, cfg, execCalls, execEnvs, execOptions, whichEnvs };
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
    expect(h.gh.calls.map(call => call[0])).toEqual(['auth', 'repo', 'api', 'api', 'secret', 'api']);
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
    const NPM_E404 = {
      stdout: '{\n  "error": {\n    "code": "E404",\n    "summary": "No match found for version 0.3.0"\n  }\n}\n',
      code: 1,
      stderr: "npm error code E404\nnpm error 404 No match found for version 0.3.0\n",
    };
    const npmCalls = (h: Harness): Array<[string, string[]]> => h.execCalls.filter(([command]) => command === 'npm');
    const gitCalls = (h: Harness): Array<[string, string[]]> => h.execCalls.filter(([command]) => command === 'git');

    it('is ok when git ls-remote finds a branch in the kit repository, asked without a prompt and with a timeout', async () => {
      const h = harness({ cfg: cfgOf(`${CONFIG}kit_ref: main\n`) });
      const check = byId(await runDoctor(h.env, h.cfg), 'kit.ref');
      expect(check).toEqual({ id: 'kit.ref', status: 'ok', message: "kit_ref main exists in the kit's repository" });
      const index = h.execCalls.findIndex(([command]) => command === 'git');
      expect(h.execCalls[index]).toEqual(['git', ['ls-remote', '--exit-code', 'https://github.com/SobSoft-s-r-o/agentic-sdlc-kit.git', 'main']]);
      expect(h.execEnvs[index]?.GIT_TERMINAL_PROMPT).toBe('0');
      expect(h.execEnvs[index]?.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes');
      expect(npmCalls(h)).toEqual([]);
    });

    it('keeps a GIT_SSH_COMMAND the owner set', async () => {
      const h = harness({ cfg: cfgOf(`${CONFIG}kit_ref: main\n`), env: { GIT_SSH_COMMAND: 'ssh -i ~/.ssh/other' } });
      await runDoctor(h.env, h.cfg);
      const index = h.execCalls.findIndex(([command]) => command === 'git');
      expect(h.execEnvs[index]?.GIT_SSH_COMMAND).toBe('ssh -i ~/.ssh/other');
    });

    it('warns when a branch does not exist, and says how to fix it', async () => {
      const h = harness({ cfg: cfgOf(`${CONFIG}kit_ref: release/9\n`), exec: { git: { stdout: '', code: 2, stderr: '' } } });
      const check = byId(await runDoctor(h.env, h.cfg), 'kit.ref');
      expect(check.status).toBe('warn');
      expect(check.message).toMatch(/^kit_ref release\/9 does not exist in https:\/\/github\.com\/SobSoft-s-r-o\/agentic-sdlc-kit\.git/);
      expect(check.fix).toContain('main');
      expect(check.fix).toContain('v0.3.0 or later');
    });

    it('warns "cannot verify" on a network failure or a timeout of a branch lookup, never fails', async () => {
      for (const git of [
        { stdout: '', code: 128, stderr: 'fatal: unable to access: Could not resolve host: github.com\n' },
        new Error('git timed out after 15s'),
      ]) {
        const check = byId(await runDoctor(harness({ cfg: cfgOf(`${CONFIG}kit_ref: main\n`), exec: { git } }).env, cfgOf(`${CONFIG}kit_ref: main\n`)), 'kit.ref');
        expect(check.status).toBe('warn');
        expect(check.message).toMatch(/^cannot verify kit_ref /);
      }
    });

    it('does not look up a commit sha', async () => {
      const h = harness({ cfg: cfgOf(`${CONFIG}kit_ref: 0123abcd\n`) });
      expect(byId(await runDoctor(h.env, h.cfg), 'kit.ref').status).toBe('ok');
      expect(gitCalls(h)).toEqual([]);
      expect(npmCalls(h)).toEqual([]);
    });

    describe('a release tag is checked against the npm registry', () => {
      const release = (ref = 'v0.3.0'): Config => cfgOf(`${CONFIG}kit_ref: ${ref}\n`);

      it('asks npm view for exactly that version, with a timeout, and never git ls-remote', async () => {
        const h = harness({ cfg: release(), exec: { npm: { stdout: '"0.3.0"\n', code: 0, stderr: '' } } });
        const check = byId(await runDoctor(h.env, h.cfg), 'kit.ref');
        expect(check).toEqual({ id: 'kit.ref', status: 'ok', message: 'kit_ref v0.3.0 is published on npm' });
        expect(npmCalls(h)).toEqual([['npm', ['view', 'agentic-sdlc-kit@0.3.0', 'version', '--json']]]);
        const index = h.execCalls.findIndex(([command]) => command === 'npm');
        expect(h.execOptions[index]?.timeoutMs).toBeGreaterThan(0);
        expect(gitCalls(h)).toEqual([]);
      });

      it('takes the version of a pre-release tag whole', async () => {
        const h = harness({ cfg: release('v1.0.0-rc.1'), exec: { npm: { stdout: '"1.0.0-rc.1"\n', code: 0, stderr: '' } } });
        expect(byId(await runDoctor(h.env, h.cfg), 'kit.ref').status).toBe('ok');
        expect(npmCalls(h)).toEqual([['npm', ['view', 'agentic-sdlc-kit@1.0.0-rc.1', 'version', '--json']]]);
      });

      it('fails on E404, and says how to fix it', async () => {
        const h = harness({ cfg: release(), exec: { npm: NPM_E404 } });
        const check = byId(await runDoctor(h.env, h.cfg), 'kit.ref');
        expect(check).toEqual({
          id: 'kit.ref',
          status: 'fail',
          message: 'kit_ref v0.3.0 is not published on npm',
          fix: 'set kit_ref to a published version (v0.3.0 or later) or main',
        });
        expect(gitCalls(h)).toEqual([]);
      });

      it('recognises E404 on stderr alone', async () => {
        const h = harness({ cfg: release(), exec: { npm: { stdout: '', code: 1, stderr: 'npm ERR! code E404\nnpm ERR! 404 Not Found\n' } } });
        expect(byId(await runDoctor(h.env, h.cfg), 'kit.ref').status).toBe('fail');
      });

      it('warns "cannot verify" on any other failure: a network error, a timeout, a missing npm', async () => {
        for (const npm of [
          { stdout: '', code: 1, stderr: 'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org failed\n' },
          { stdout: '', code: 1, stderr: '' },
          new Error('npm timed out after 15s'),
          new Error('spawn npm ENOENT'),
        ]) {
          const h = harness({ cfg: release(), exec: { npm } });
          const check = byId(await runDoctor(h.env, h.cfg), 'kit.ref');
          expect(check.status).toBe('warn');
          expect(check.message).toMatch(/^cannot verify kit_ref v0\.3\.0: /);
        }
      });

      it('warns "cannot verify" when npm answers something else than the version', async () => {
        for (const stdout of ['', 'not json', '"9.9.9"\n']) {
          const h = harness({ cfg: release(), exec: { npm: { stdout, code: 0, stderr: '' } } });
          const check = byId(await runDoctor(h.env, h.cfg), 'kit.ref');
          expect(check.status).toBe('warn');
          expect(check.message).toMatch(/^cannot verify kit_ref v0\.3\.0: /);
        }
      });

      it('shows nothing the registry said beyond the failure line', async () => {
        const h = harness({ cfg: release(), exec: { npm: { stdout: 'token=secret-value-123', code: 1, stderr: 'npm error code ECONNRESET\n' } } });
        const check = byId(await runDoctor(h.env, h.cfg), 'kit.ref');
        expect(JSON.stringify(check)).not.toContain('secret-value-123');
      });
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
      expect(h.execCalls.filter(([command]) => command !== 'git' && command !== 'npm')).toEqual([['npx', ['--no-install', 'sdlc', '--version']]]);
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
      expect(h.execCalls.filter(([command]) => command !== 'git' && command !== 'npm')).toEqual([]);
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
      const h = harness({ gh: ghScript(cfg, { labels: labelListStep(['sdlc:task', 'type:tooling']) }) });
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
      const h = harness({ gh: ghScript(cfg, { labels: labelListStep(LABELS.map(name => name.toUpperCase())) }) });
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
      expect(mcpCalls(h)).toEqual([]);
    });

    it('is ok, and skipped, when the claude CLI is not on the PATH', async () => {
      const h = harness({ installed: ['git', 'gh', 'sdlc'] });
      const check = byId(await runDoctor(h.env, h.cfg), 'mcp.claude');
      expect(check).toMatchObject({ status: 'ok', message: 'claude CLI not found; skipped' });
      expect(mcpCalls(h)).toEqual([]);
    });

    it('is ok when claude mcp list names every configured server', async () => {
      const h = harness();
      const check = byId(await runDoctor(h.env, h.cfg), 'mcp.claude');
      expect(check.status).toBe('ok');
      expect(check.message).toContain('github');
      expect(mcpCalls(h)).toEqual([['claude', ['mcp', 'list']]]);
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
      expect(mcpCalls(h)).toEqual([]);
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
      const h = harness({ gh: ghScript(cfg, { labels: { ...labelListStep([]), code: 1, stderr: 'gh: Bad Gateway (HTTP 502)' } }) });
      const checks = await runDoctor(h.env, cfg);

      expect(checks.map(c => c.id)).toEqual([...PREFLIGHT_IDS, ...INSTALL_IDS]);
      expect(byId(checks, 'labels').status).toBe('fail');
      expect(byId(checks, 'labels').message).not.toContain('\n');
      expect(notOk(checks)).toEqual([['labels', 'fail']]);
    });
  });
});

// --- the checks of the stack, the harnesses' MCP servers and hooks, and the local queues -----------

const ALL_CLIS = ['git', 'gh', 'sdlc', 'npx', 'claude', 'codex', 'gemini', 'graphify'];
const THREE = '[claude, codex, gemini]';
const threeHarnesses = (extra = ''): Config => cfgOf(configWith(extra, THREE));
/** All three harnesses in `mode` (the test config is in observe mode). */
const inMode = (mode: 'enforce' | 'observe', harnesses = THREE): Config => cfgOf(configWith('', harnesses).replace('mode: observe', `mode: ${mode}`));

/** A healthy machine with all three harnesses configured and installed. */
function allThree(options: EnvOptions = {}): Harness {
  const cfg = options.cfg ?? threeHarnesses();
  return harness({ cfg, fs: installedFs(cfg), installed: ALL_CLIS, ...options });
}

/** The `mcp list` calls of the harness CLIs. */
const mcpCalls = (h: Harness): Array<[string, string[]]> => h.execCalls.filter(([, args]) => args[0] === 'mcp');

/** The exec calls of the harness CLIs that are not `git`, as `command args`. */
const execLines = (h: Harness, ...commands: string[]): string[] =>
  h.execCalls.filter(([command]) => commands.includes(command)).map(([command, args]) => `${command} ${args.join(' ')}`);

describe('git.version', () => {
  it('is ok for git 2.31 and newer, whatever follows the number', async () => {
    for (const version of ['git version 2.43.0', 'git version 2.31.0', 'git version 2.39.3 (Apple Git-146)', 'git version 2.45.1.windows.1', 'git version 3.0.0']) {
      const h = harness({ git: { version } });
      const check = byId(await runDoctor(h.env, h.cfg), 'git.version');
      expect(check.status, version).toBe('ok');
      expect(check.message).toContain(version.replace('git version ', ''));
    }
  });

  it('warns for an older git, naming the version and the fix', async () => {
    for (const version of ['git version 2.30.2', 'git version 2.25.1', 'git version 1.9.5']) {
      const h = harness({ git: { version } });
      const check = byId(await runDoctor(h.env, h.cfg), 'git.version');
      expect(check.status, version).toBe('warn');
      expect(check.message).toContain(version.replace('git version ', ''));
      expect(check.fix).toBe('upgrade git to 2.31 or later');
    }
  });

  it('warns, and does not fail, when the version cannot be read', async () => {
    const h = harness({ git: { version: 'not a version' } });
    const check = byId(await runDoctor(h.env, h.cfg), 'git.version');
    expect(check.status).toBe('warn');
    expect(check.message).toMatch(/could not read the git version/);
  });
});

describe('stack.superpowers', () => {
  it('is ok when every configured harness has it, asking each CLI for its plugin list in JSON', async () => {
    const h = allThree();
    const check = byId(await runDoctor(h.env, h.cfg), 'stack.superpowers');

    expect(check.status).toBe('ok');
    expect(check.message).toMatch(/claude, codex, gemini/);
    expect(execLines(h, 'claude', 'codex', 'gemini').filter(line => / (plugin|extensions) /.test(line))).toEqual([
      'claude plugin list --json',
      'codex plugin list --json',
      'gemini extensions list -o json',
    ]);
  });

  it('warns naming the harness that lacks it, with its install command as the fix', async () => {
    const h = allThree({ exec: { codexPlugins: stdoutOf(JSON.stringify({ installed: [{ name: 'other' }], available: [{ name: 'superpowers' }] })) } });
    const check = byId(await runDoctor(h.env, h.cfg), 'stack.superpowers');

    expect(check.status).toBe('warn');
    expect(check.message).toContain('codex');
    expect(check.message).not.toMatch(/claude|gemini/);
    expect(check.fix).toBe(superpowersInstall('codex'));
  });

  it('joins the install commands of several harnesses with &&', async () => {
    const h = allThree({ exec: { claudePlugins: stdoutOf('[]'), geminiPlugins: stdoutOf('[]') } });
    const check = byId(await runDoctor(h.env, h.cfg), 'stack.superpowers');

    expect(check.status).toBe('warn');
    expect(check.message).toMatch(/claude.*gemini/);
    expect(check.fix).toBe(`${superpowersInstall('claude')} && ${superpowersInstall('gemini')}`);
  });

  it('says "not checked" for a harness whose CLI is not on the PATH, and does not warn for it', async () => {
    const h = allThree({ installed: ['git', 'gh', 'sdlc', 'npx', 'claude', 'graphify'] });
    const check = byId(await runDoctor(h.env, h.cfg), 'stack.superpowers');

    expect(check.status).toBe('ok');
    expect(check.message).toContain('codex: not checked (codex not on PATH)');
    expect(check.message).toContain('gemini: not checked (gemini not on PATH)');
    expect(execLines(h, 'codex', 'gemini')).toEqual([]);
  });

  it('warns "could not read <cli> plugin list" for output that is not the list, a failing command and one that cannot run', async () => {
    for (const codexPlugins of [stdoutOf('Plugins: none'), stdoutOf('[]'), { stdout: '', code: 2, stderr: 'boom' }, new Error('codex timed out after 15s')]) {
      const h = allThree({ exec: { codexPlugins } });
      const check = byId(await runDoctor(h.env, h.cfg), 'stack.superpowers');

      expect(check.status).toBe('warn');
      expect(check.message).toMatch(/could not read codex plugin list/);
      // Not knowing is no reason to say how to install it.
      expect(check.fix).toBeUndefined();
    }
  });

  it('names a missing plugin and an unreadable list together', async () => {
    const h = allThree({ exec: { claudePlugins: stdoutOf('[]'), geminiPlugins: stdoutOf('nope') } });
    const check = byId(await runDoctor(h.env, h.cfg), 'stack.superpowers');

    expect(check.status).toBe('warn');
    expect(check.message).toMatch(/claude/);
    expect(check.message).toMatch(/could not read gemini plugin list/);
    expect(check.fix).toBe(superpowersInstall('claude'));
  });

  it('is skipped when stack.superpowers is off, and runs no command', async () => {
    const cfg = cfgOf(configWith('stack: { superpowers: false }', THREE));
    const h = allThree({ cfg });
    const check = byId(await runDoctor(h.env, cfg), 'stack.superpowers');

    expect(check).toMatchObject({ status: 'ok' });
    expect(check.message).toMatch(/skipped/);
    expect(execLines(h, 'claude', 'codex', 'gemini').filter(line => / (plugin|extensions) /.test(line))).toEqual([]);
  });

  it('only asks the harnesses that are configured', async () => {
    const cfg = cfgOf(configWith('', '[gemini, agents-md]'));
    const h = allThree({ cfg });
    const check = byId(await runDoctor(h.env, cfg), 'stack.superpowers');

    expect(check.status).toBe('ok');
    expect(execLines(h, 'claude', 'codex', 'gemini').filter(line => / (plugin|extensions) /.test(line))).toEqual(['gemini extensions list -o json']);
  });

  describe('a plugin that is installed but not in use', () => {
    const claudeList = (extra: Record<string, unknown>): ExecResult =>
      stdoutOf(JSON.stringify([{ id: 'superpowers@claude-plugins-official', version: '7.0.2', enabled: true, ...extra }]));

    it('warns for a disabled plugin, in each harness, with the install command as the fix', async () => {
      const h = allThree({
        exec: {
          claudePlugins: claudeList({ scope: 'user', enabled: false }),
          codexPlugins: stdoutOf(JSON.stringify({ installed: [{ name: 'superpowers', enabled: false }], available: [] })),
          geminiPlugins: stdoutOf(JSON.stringify([{ name: 'superpowers', isActive: false }])),
        },
      });
      const check = byId(await runDoctor(h.env, h.cfg), 'stack.superpowers');

      expect(check.status).toBe('warn');
      expect(check.message).toContain('claude, codex, gemini');
      expect(check.fix).toBe(['claude', 'codex', 'gemini'].map(name => superpowersInstall(name as 'claude')).join(' && '));
    });

    it('claude: a project-scope plugin counts for the repository it was installed in, and only there', async () => {
      const here = allThree({ exec: { claudePlugins: claudeList({ scope: 'project', projectPath: '/memory' }) } });
      expect(byId(await runDoctor(here.env, here.cfg), 'stack.superpowers').status).toBe('ok');

      for (const scope of ['project', 'local']) {
        const elsewhere = allThree({ exec: { claudePlugins: claudeList({ scope, projectPath: '/somewhere/else' }) } });
        const check = byId(await runDoctor(elsewhere.env, elsewhere.cfg), 'stack.superpowers');
        expect(check.status, scope).toBe('warn');
        expect(check.message).toContain('claude');
        expect(check.fix).toBe(superpowersInstall('claude'));
      }
      const noPath = allThree({ exec: { claudePlugins: claudeList({ scope: 'local' }) } });
      expect(byId(await runDoctor(noPath.env, noPath.cfg), 'stack.superpowers').status).toBe('warn');
    });

    it('claude: a user-scope plugin counts whatever its project path, and so does one installed in the main checkout of this worktree', async () => {
      const user = allThree({ exec: { claudePlugins: claudeList({ scope: 'user', projectPath: '/somewhere/else' }) } });
      expect(byId(await runDoctor(user.env, user.cfg), 'stack.superpowers').status).toBe('ok');

      const worktrees = 'worktree /main\nHEAD 0123456789abcdef\nbranch refs/heads/main\n\nworktree /memory\nHEAD 0123456789abcdef\nbranch refs/heads/task/5-x\n\n';
      const main = allThree({ git: { worktrees }, exec: { claudePlugins: claudeList({ scope: 'project', projectPath: '/main' }) } });
      expect(byId(await runDoctor(main.env, main.cfg), 'stack.superpowers').status).toBe('ok');
    });
  });

  it('runs every CLI in the environment of a hook, with a time limit', async () => {
    const h = allThree({ env: { PATH: '/usr/bin:/tmp/x/_npx/1/node_modules/.bin:/bin', npm_command: 'exec' } });
    await runDoctor(h.env, h.cfg);

    const calls = h.execCalls.flatMap(([command, args], index) => (['claude', 'codex', 'gemini', 'graphify'].includes(command) ? [{ command, args, index }] : []));
    // an mcp list and a plugin list for each of the three, and graphify --version
    expect(calls).toHaveLength(7);
    for (const { index, command, args } of calls) {
      // `mcp list` health-checks every server (Claude took 22 s, Gemini waits up to 10 s per unreachable one)
      expect(h.execOptions[index]?.timeoutMs, `${command} ${args.join(' ')}`).toBe(args[0] === 'mcp' ? 60_000 : 15_000);
      expect(h.execOptions[index]?.env?.PATH, `${command} ${args.join(' ')}`).toBe('/usr/bin:/bin');
      expect(h.execOptions[index]?.env?.npm_command).toBeUndefined();
    }
  });
});

describe('stack.graphify', () => {
  it('is ok with the version graphify prints', async () => {
    const h = harness();
    const check = byId(await runDoctor(h.env, h.cfg), 'stack.graphify');

    expect(check.status).toBe('ok');
    expect(check.message).toContain('0.9.122');
    expect(execLines(h, 'graphify')).toEqual(['graphify --version']);
  });

  it('warns for a missing binary with the install commands, joined by &&, as the fix', async () => {
    const h = harness({ installed: ['git', 'gh', 'sdlc', 'npx', 'claude'] });
    const check = byId(await runDoctor(h.env, h.cfg), 'stack.graphify');

    expect(check.status).toBe('warn');
    expect(check.message).toMatch(/graphify/);
    expect(check.fix).toBe(graphifyInstall(h.cfg.harnesses).join(' && '));
    expect(check.fix).toBe('uv tool install graphifyy && graphify install && graphify install --platform codex');
    expect(execLines(h, 'graphify')).toEqual([]);
  });

  it('warns when graphify is there but --version fails or cannot run', async () => {
    for (const graphify of [{ stdout: '', code: 1, stderr: 'ModuleNotFoundError' }, new Error('graphify timed out after 15s')]) {
      const h = harness({ exec: { graphify } });
      const check = byId(await runDoctor(h.env, h.cfg), 'stack.graphify');
      expect(check.status).toBe('warn');
      expect(check.message).toMatch(/graphify --version/);
      expect(check.fix).toBe(graphifyInstall(h.cfg.harnesses).join(' && '));
    }
  });

  it('is skipped when stack.graphify is off', async () => {
    const cfg = cfgOf(configWith('stack: { graphify: false }'));
    const h = harness({ cfg, fs: installedFs(cfg), installed: ['git', 'gh', 'sdlc'] });
    const check = byId(await runDoctor(h.env, cfg), 'stack.graphify');

    expect(check.status).toBe('ok');
    expect(check.message).toMatch(/skipped/);
    expect(execLines(h, 'graphify')).toEqual([]);
  });
});

describe.each([
  ['codex', ['mcp', 'list', '--json'], 'codex mcp list', 'codex mcp list --json'],
  ['gemini', ['mcp', 'list'], 'gemini mcp list', 'gemini mcp list'],
] as const)('mcp.%s', (name, args, shown, line) => {
  const id = `mcp.${name}`;
  const answer = (result: ExecResult | Error): EnvOptions['exec'] => (name === 'codex' ? { codexMcp: result } : { geminiMcp: result });

  it('is skipped when the harness is not configured, and runs nothing', async () => {
    const cfg = cfgOf(configWith('', '[claude]'));
    const h = harness({ cfg, fs: installedFs(cfg), installed: ALL_CLIS });
    const check = byId(await runDoctor(h.env, cfg), id);

    expect(check.status).toBe('ok');
    expect(check.message).toMatch(/skipped/);
    expect(execLines(h, name)).toEqual([]);
  });

  it('is ok, and skipped, when the CLI is not on the PATH', async () => {
    const h = allThree({ installed: ALL_CLIS.filter(cli => cli !== name) });
    expect(byId(await runDoctor(h.env, h.cfg), id)).toMatchObject({ status: 'ok', message: `${name} CLI not found; skipped` });
  });

  it('is ok when the list names every configured server, and asks for it in the form that is parsed', async () => {
    const h = allThree();
    const check = byId(await runDoctor(h.env, h.cfg), id);

    expect(check.status).toBe('ok');
    expect(check.message).toBe(`${shown} shows github`);
    expect(h.execCalls.filter(([command, a]) => command === name && a[0] === 'mcp')).toEqual([[name, [...args]]]);
    expect(execLines(h, name)).toContain(line);
  });

  it('warns for a configured server the list does not show, naming it, with a fix', async () => {
    const cfg = threeHarnesses('mcp: { servers: [github, context7, playwright] }\n');
    const h = allThree({ cfg });
    const check = byId(await runDoctor(h.env, cfg), id);

    expect(check.status).toBe('warn');
    expect(check.message).toBe(`${shown} does not show: playwright`);
    expect(check.fix).toMatch(/\S/);
  });

  it('does not take a longer name for a configured server', async () => {
    const text = name === 'codex' ? JSON.stringify([{ name: 'github-enterprise' }]) : '✓ github-enterprise: https://x.test (http) - Connected\n';
    const h = allThree({ exec: answer(stdoutOf(text)) });
    const check = byId(await runDoctor(h.env, h.cfg), id);

    expect(check.status).toBe('warn');
    expect(check.message).toContain('github');
  });

  it('on a failing list prints the exit code and the first line of stderr only, never stdout', async () => {
    const result = { stdout: `other: https://x.test/mcp?token=${githubToken()}\n`, code: 2, stderr: 'boom\u001b[31m happened\nsecond line\n' };
    const check = byId(await runDoctor(allThree({ exec: answer(result) }).env, threeHarnesses()), id);

    expect(check.status).toBe('warn');
    expect(check.message).toBe(`${shown} failed (exit 2): boom happened`);
    expect(JSON.stringify(check)).not.toContain(githubToken());
  });

  it('warns, and does not fail, when the list cannot run', async () => {
    const check = byId(await runDoctor(allThree({ exec: answer(new Error(`${name} timed out after 15s`)) }).env, threeHarnesses()), id);
    expect(check.status).toBe('warn');
    expect(check.message).toMatch(new RegExp(`could not run ${shown}`));
  });

  it('is ok when no MCP server is configured', async () => {
    const cfg = threeHarnesses('mcp: { servers: [] }\n');
    const h = allThree({ cfg });
    expect(byId(await runDoctor(h.env, cfg), id).status).toBe('ok');
    expect(mcpCalls(h)).toEqual([]);
  });

  it('runs in the environment of a hook, with a time limit', async () => {
    const h = allThree();
    await runDoctor(h.env, h.cfg);
    const index = h.execCalls.findIndex(([command, a]) => command === name && a[0] === 'mcp');
    expect(h.execOptions[index]).toMatchObject({ timeoutMs: 60_000 });
    expect(h.execOptions[index]?.env).toBeDefined();
  });
});

describe('mcp.codex, on text that is not the --json list', () => {
  it('warns "could not read codex mcp list" instead of reporting every server missing', async () => {
    const h = allThree({ exec: { codexMcp: stdoutOf('No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.') } });
    const check = byId(await runDoctor(h.env, h.cfg), 'mcp.codex');
    expect(check.status).toBe('warn');
    expect(check.message).toMatch(/could not read codex mcp list/);
  });
});

describe('the mcp list checks', () => {
  it('mcp.claude runs claude mcp list with the long time limit of the mcp lists, and the hook environment', async () => {
    const h = harness();
    await runDoctor(h.env, h.cfg);
    const index = h.execCalls.findIndex(([command, a]) => command === 'claude' && a[0] === 'mcp');
    expect(h.execOptions[index]).toMatchObject({ timeoutMs: 60_000 });
    expect(h.execOptions[index]?.env).toBeDefined();
  });

  it('starts the three lists together, so a slow one does not hold up the others', async () => {
    const h = allThree();
    const inner = h.env.exec;
    const started: string[] = [];
    const seenAtStart: Record<string, number> = {};
    let release: () => void = () => undefined;
    const allStarted = new Promise<void>(resolve => {
      release = resolve;
    });
    h.env.exec = async (cmd, args, options) => {
      if (args[0] !== 'mcp') return inner(cmd, args, options);
      started.push(cmd);
      if (started.length === 3) release();
      // a sequential run never gets to three: give up waiting, and let the assertion below say so
      await Promise.race([allStarted, new Promise(resolve => setTimeout(resolve, 300))]);
      seenAtStart[cmd] = started.length;
      return inner(cmd, args, options);
    };
    const checks = await runDoctor(h.env, h.cfg);

    expect(seenAtStart).toEqual({ claude: 3, codex: 3, gemini: 3 });
    // The results come in the order of the harnesses all the same.
    const ids = checks.map(check => check.id).filter(id => id.startsWith('mcp.'));
    expect(ids).toEqual(['mcp.token', 'mcp.claude', 'mcp.codex', 'mcp.gemini']);
    for (const id of ['mcp.claude', 'mcp.codex', 'mcp.gemini']) expect(byId(checks, id).status).toBe('ok');
  });

  it('one list that throws or fails does not change the others', async () => {
    const h = allThree({ exec: { codexMcp: new Error('codex timed out after 60s') } });
    const checks = await runDoctor(h.env, h.cfg);
    expect(byId(checks, 'mcp.codex').status).toBe('warn');
    expect(byId(checks, 'mcp.claude').status).toBe('ok');
    expect(byId(checks, 'mcp.gemini').status).toBe('ok');
  });
});

describe('hooks.<harness>', () => {
  /** Rewrites the JSON file `path` of the installed repository. */
  function editJson(fs: MemoryFs, path: string, edit: (json: { hooks: Record<string, unknown> }) => void): void {
    const json = JSON.parse(fs.read(path) ?? '{}') as { hooks: Record<string, unknown> };
    edit(json);
    fs.write(path, JSON.stringify(json, null, 2));
  }
  const FILES = { claude: '.claude/settings.json', codex: '.codex/hooks.json', gemini: '.gemini/settings.json' } as const;
  const EVENTS = {
    claude: ['SessionStart', 'UserPromptSubmit', 'PreToolUse'],
    codex: ['SessionStart', 'UserPromptSubmit', 'PreToolUse'],
    gemini: ['SessionStart', 'BeforeAgent', 'BeforeTool'],
  } as const;

  it.each(['claude', 'codex', 'gemini'] as const)('%s: is ok when its file calls the launcher for each of the three events and the launcher exists', async name => {
    const h = allThree();
    const check = byId(await runDoctor(h.env, h.cfg), `hooks.${name}`);

    expect(check.status).toBe('ok');
    expect(check.message).toContain(FILES[name]);
    for (const event of EVENTS[name]) expect(check.message).toContain(event);
  });

  it('codex: the ok message says it runs only after trust and approval', async () => {
    const check = byId(await runDoctor(allThree().env, threeHarnesses()), 'hooks.codex');
    expect(check.message.endsWith(' (Codex runs it only after you trust the project and approve it in /hooks)')).toBe(true);
    expect(byId(await runDoctor(allThree().env, threeHarnesses()), 'hooks.claude').message).not.toContain('approve it in /hooks');
  });

  it('is skipped for a harness that is not configured', async () => {
    const h = harness();
    const check = byId(await runDoctor(h.env, h.cfg), 'hooks.gemini');
    expect(check.status).toBe('ok');
    expect(check.message).toMatch(/skipped/);
  });

  it('is ok, and skipped, for agents-md alone, which has no hooks', async () => {
    const cfg = cfgOf(configWith('', '[agents-md]'));
    const checks = await runDoctor(harness({ cfg, fs: installedFs(cfg) }).env, cfg);
    for (const id of ['hooks.claude', 'hooks.codex', 'hooks.gemini', 'hooks.roundtrip']) expect(byId(checks, id).status).toBe('ok');
    expect(byId(checks, 'hooks.roundtrip').message).toMatch(/skipped/);
  });

  it.each(['claude', 'codex', 'gemini'] as const)('%s: warns listing the events that have no sdlc item, with sdlc upgrade as the fix', async name => {
    const h = allThree();
    const [first, , last] = EVENTS[name];
    editJson(h.fs, FILES[name], json => {
      delete json.hooks[first];
      delete json.hooks[last];
    });
    const check = byId(await runDoctor(h.env, h.cfg), `hooks.${name}`);

    expect(check.status).toBe('warn');
    expect(check.message).toContain(first);
    expect(check.message).toContain(last);
    expect(check.message).not.toContain(EVENTS[name][1]);
    expect(check.fix).toBe('sdlc upgrade');
  });

  it("does not count another tool's hook on the event: only an item with the launcher does", async () => {
    const h = allThree();
    editJson(h.fs, FILES.claude, json => {
      json.hooks.PreToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo checked' }] }];
    });
    const check = byId(await runDoctor(h.env, h.cfg), 'hooks.claude');

    expect(check.status).toBe('warn');
    expect(check.message).toContain('PreToolUse');
    expect(check.message).not.toContain('SessionStart');
  });

  it('counts the sdlc item next to the hooks of the user', async () => {
    const h = allThree();
    editJson(h.fs, FILES.claude, json => {
      json.hooks.PreToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo checked' }] }, ...(json.hooks.PreToolUse as unknown[])];
    });
    expect(byId(await runDoctor(h.env, h.cfg), 'hooks.claude').status).toBe('ok');
  });

  it('warns when the file is missing, and when it is not JSON', async () => {
    const missing = allThree();
    missing.fs.remove(FILES.codex);
    const gone = byId(await runDoctor(missing.env, missing.cfg), 'hooks.codex');
    expect(gone.status).toBe('warn');
    expect(gone.message).toContain(FILES.codex);
    expect(gone.fix).toBe('sdlc upgrade');

    const broken = allThree();
    broken.fs.write(FILES.gemini, '{ not json');
    const bad = byId(await runDoctor(broken.env, broken.cfg), 'hooks.gemini');
    expect(bad.status).toBe('warn');
    expect(bad.message).toMatch(/not valid JSON/);
  });

  it('warns when the launcher file is missing', async () => {
    const h = allThree();
    h.fs.remove('.sdlc/hooks/run.sh');
    const check = byId(await runDoctor(h.env, h.cfg), 'hooks.claude');

    expect(check.status).toBe('warn');
    expect(check.message).toContain('.sdlc/hooks/run.sh');
    expect(check.fix).toBe('sdlc upgrade');
  });

  it('warns when the launcher is not committed: new worktrees and clones would not run the hooks', async () => {
    const h = allThree({ git: { launcherCommitted: false } });
    const checks = await runDoctor(h.env, h.cfg);

    for (const name of ['claude', 'codex', 'gemini']) {
      expect(byId(checks, `hooks.${name}`)).toEqual({
        id: `hooks.${name}`,
        status: 'warn',
        message: '.sdlc/hooks/run.sh is not committed; new worktrees and clones will not run the sdlc hooks',
        fix: 'commit .sdlc/hooks/run.sh',
      });
    }
    expect(h.git.calls.filter(call => call[0] === 'cat-file')).toHaveLength(1);
  });

  it('asks git about the launcher only when a harness has hooks', async () => {
    const cfg = cfgOf(configWith('', '[agents-md]'));
    const h = harness({ cfg, fs: installedFs(cfg) });
    await runDoctor(h.env, cfg);
    expect(h.git.calls.filter(call => call[0] === 'cat-file')).toEqual([]);
  });

  it('warns when the committed launcher is not executable (mode 100644), with the command that fixes it', async () => {
    const h = allThree({ git: { launcherMode: '100644' } });
    const checks = await runDoctor(h.env, h.cfg);

    for (const name of ['claude', 'codex', 'gemini']) {
      const check = byId(checks, `hooks.${name}`);
      expect(check.status).toBe('warn');
      expect(check.message).toContain('.sdlc/hooks/run.sh is committed with mode 100644, not 100755');
      expect(check.fix).toBe('git update-index --chmod=+x .sdlc/hooks/run.sh');
    }
    // asked once for all three, for the mode committed in HEAD (not the index, which a chmod alone changes)
    expect(h.git.calls.filter(call => call[0] === 'ls-tree')).toEqual([['ls-tree', 'HEAD', '--', '.sdlc/hooks/run.sh']]);
  });

  it('is ok for the executable mode, and does not warn when git cannot say what the mode is', async () => {
    const executable = allThree({ git: { launcherMode: '100755' } });
    expect(byId(await runDoctor(executable.env, executable.cfg), 'hooks.claude').status).toBe('ok');

    const unknown = allThree({ git: { launcherMode: null } });
    expect(byId(await runDoctor(unknown.env, unknown.cfg), 'hooks.claude').status).toBe('ok');
  });

  it('a launcher that is not committed says so only, and git is not asked for its mode', async () => {
    const h = allThree({ git: { launcherCommitted: false, launcherMode: '100644' } });
    const check = byId(await runDoctor(h.env, h.cfg), 'hooks.claude');

    expect(check.message).not.toContain('mode');
    expect(check.fix).toBe('commit .sdlc/hooks/run.sh');
    expect(h.git.calls.filter(call => call[0] === 'ls-tree')).toEqual([]);
  });

  it('gemini on Windows: warns that its hooks run through PowerShell, which sdlc hooks cannot use', async () => {
    const h = allThree({ platform: 'win32' });
    const checks = await runDoctor(h.env, h.cfg);

    expect(byId(checks, 'hooks.gemini')).toMatchObject({
      status: 'warn',
      message: 'Gemini CLI runs hooks through PowerShell on Windows; sdlc hooks need a POSIX shell',
    });
    expect(byId(checks, 'hooks.claude').status).toBe('ok');

    const linux = allThree({ platform: 'linux' });
    expect(byId(await runDoctor(linux.env, linux.cfg), 'hooks.gemini').status).toBe('ok');
  });
});

describe('hooks.switches', () => {
  const enforceThree = (): Config => cfgOf(configWith('', '[claude, codex, gemini]').replace('mode: observe', 'mode: enforce'));
  const setJson = (fs: MemoryFs, path: string, extra: Record<string, unknown>): void => {
    fs.write(path, JSON.stringify({ ...(JSON.parse(fs.read(path) ?? '{}') as object), ...extra }, null, 2));
  };

  it('is ok when no switch is set', async () => {
    const check = byId(await runDoctor(allThree().env, threeHarnesses()), 'hooks.switches');
    expect(check.status).toBe('ok');
  });

  it.each([
    ['.claude/settings.json', { disableAllHooks: true }],
    ['.claude/settings.local.json', { disableAllHooks: true }],
    ['.gemini/settings.json', { hooksConfig: { enabled: false } }],
  ] as const)('fails in enforce and warns in observe when %s switches the hooks off', async (path, extra) => {
    const enforced = allThree({ cfg: enforceThree() });
    setJson(enforced.fs, path, extra);
    const failed = byId(await runDoctor(enforced.env, enforced.cfg), 'hooks.switches');
    expect(failed.status).toBe('fail');
    expect(failed.message).toContain(path);

    const observed = allThree();
    setJson(observed.fs, path, extra);
    expect(byId(await runDoctor(observed.env, observed.cfg), 'hooks.switches').status).toBe('warn');
  });

  it('reads the Gemini list of disabled hooks for the sdlc ones', async () => {
    const h = allThree({ cfg: enforceThree() });
    setJson(h.fs, '.gemini/settings.json', { hooksConfig: { disabled: ['sdlc-pre-tool'] } });
    const check = byId(await runDoctor(h.env, h.cfg), 'hooks.switches');
    expect(check.status).toBe('fail');
    expect(check.message).toContain('sdlc-pre-tool');
  });

  it.each([
    '[features]\nhooks = false\n',
    '# mine\n[features]\n  hooks=false # off\n',
    '[features]\ncodex_hooks = false\n',
    'features.hooks = false\n',
    'features = { hooks = false }\n',
    'features = { other = 1, codex_hooks = false } # x\n',
    'features={hooks=false}# x\n',
    '"features" = { "hooks" = false }\n',
    "'features' = { 'codex_hooks' = false }\n",
    'features = { note = "a } # b", hooks = false }\n',
    '[ "features" ]\n"hooks" = false\n',
  ])('fails in enforce when .codex/config.toml has %j', async toml => {
    const h = allThree({ cfg: enforceThree() });
    // Before the kit's tables: a top-level key after a table header would belong to that table.
    h.fs.write('.codex/config.toml', `${toml}\n${h.fs.read('.codex/config.toml') ?? ''}`);
    const check = byId(await runDoctor(h.env, h.cfg), 'hooks.switches');
    expect(check.status).toBe('fail');
    expect(check.message).toContain('.codex/config.toml');
  });

  it('does not take other Codex settings for the switch', async () => {
    const h = allThree({ cfg: enforceThree() });
    h.fs.write('.codex/config.toml', '[features]\nhooks = true\n[other]\nhooks = false\n');
    expect(byId(await runDoctor(h.env, h.cfg), 'hooks.switches').status).toBe('ok');
  });

  it.each([
    ['features = { hooks = false }\n', 'features.hooks is false'],
    ['features = { other = 1, codex_hooks = false } # x\n', 'features.codex_hooks is false'],
  ])('names the inline-table switch of %j', async (toml, message) => {
    const h = allThree({ cfg: enforceThree() });
    h.fs.write('.codex/config.toml', toml);
    const check = byId(await runDoctor(h.env, h.cfg), 'hooks.switches');
    expect(check.status).toBe('fail');
    expect(check.message).toContain(`.codex/config.toml: ${message}`);
  });

  it.each([
    'features = { hooks = true }\n',
    '[profile]\nfeatures = { hooks = false }\n',
    'features = { other = { hooks = false }, hooks = true }\n',
    'features = { "a.hooks" = false }\n',
    'features = { note = "hooks = false" }\n',
    'other = { hooks = false }\n',
    '# features = { hooks = false }\n',
  ])('does not take %j for a Codex switch', async toml => {
    const h = allThree({ cfg: enforceThree() });
    h.fs.write('.codex/config.toml', toml);
    expect(byId(await runDoctor(h.env, h.cfg), 'hooks.switches').status).toBe('ok');
  });

  it('only warns, in enforce too, for a switch in the user-level settings', async () => {
    for (const [path, text] of [
      ['.claude/settings.json', '{ "disableAllHooks": true }'],
      ['.gemini/settings.json', '{ "hooksConfig": { "enabled": false } }'],
      ['.codex/config.toml', '[features]\nhooks = false\n'],
    ] as const) {
      const h = allThree({ cfg: enforceThree(), userFiles: { [path]: text } });
      const check = byId(await runDoctor(h.env, h.cfg), 'hooks.switches');
      expect(check.status, path).toBe('warn');
      expect(check.message).toContain(`~/${path}`);
    }
  });

  it('checks only the configured harnesses', async () => {
    const h = harness();
    h.fs.write('.gemini/settings.json', '{ "hooksConfig": { "enabled": false } }');
    expect(byId(await runDoctor(h.env, h.cfg), 'hooks.switches').status).toBe('ok');
  });
});

describe('hooks.roundtrip', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  /** A real, empty directory as the repository root, so that a write of the round trip would show. */
  function realRoot(fs: MemoryFs): string {
    const dir = mkdtempSync(join(tmpdir(), 'sdlc-roundtrip-'));
    tmpDirs.push(dir);
    Object.assign(fs, { root: dir });
    return dir;
  }

  it.each(['enforce', 'observe'] as const)('%s: runs the real pre-tool hook of each configured harness on an admin merge and finds the answer it should', async mode => {
    const cfg = inMode(mode);
    expect(cfg.mode).toBe(mode);
    const h = allThree({ cfg });
    const root = realRoot(h.fs);
    const check = byId(await runDoctor(h.env, cfg), 'hooks.roundtrip');

    expect(check.status).toBe('ok');
    for (const name of ['claude', 'codex', 'gemini']) expect(check.message).toContain(name);
    expect(check.message).toContain(mode === 'enforce' ? 'denies' : 'warns');
    // No trace: the cache of the repository was not even created.
    expect(existsSync(join(root, '.sdlc'))).toBe(false);
  });

  it('calls the hook runner once per configured hook harness, for pre-tool, with the shell payload of that harness', async () => {
    const calls: Array<{ harness: string; event: string; stdin: string; readOnly: boolean | undefined }> = [];
    const hookRunner: NonNullable<DoctorEnv['hookRunner']> = async (name, event, ctx) => {
      calls.push({ harness: name, event, stdin: await ctx.readStdin(), readOnly: ctx.readOnly });
      return runHook(name, event, ctx);
    };
    const h = allThree({ hookRunner });
    await runDoctor(h.env, h.cfg);

    expect(calls.map(call => [call.harness, call.event])).toEqual([['claude', 'pre-tool'], ['codex', 'pre-tool'], ['gemini', 'pre-tool']]);
    expect(calls.every(call => call.readOnly === true)).toBe(true);
    const payloads = calls.map(call => JSON.parse(call.stdin) as { cwd: string; tool_name: string; tool_input: { command: string } });
    expect(payloads.map(payload => payload.tool_name)).toEqual(['Bash', 'Bash', 'run_shell_command']);
    for (const payload of payloads) {
      expect(payload.tool_input.command).toBe('gh pr merge 1 --admin');
      expect(payload.cwd).toBe('/memory');
    }
  });

  it('touches neither GitHub nor the task state, and writes nothing to the repository', async () => {
    const h = allThree();
    const before = h.fs.log.length;
    const checks = await runDoctor(h.env, h.cfg);

    expect(byId(checks, 'hooks.roundtrip').status).toBe('ok');
    expect(mutations(h.gh)).toEqual([]);
    expect(h.gh.calls.map(call => call[0])).toEqual(['auth', 'repo', 'api', 'api', 'secret', 'api']);
    expect(h.fs.log).toHaveLength(before);
    // The round trip needs no git of the repository either: it answers for a repository of its own.
    expect(h.git.calls.filter(call => call[0] === 'symbolic-ref' || call.includes('--show-toplevel'))).toEqual([]);
  });

  it('fails, quoting the output, when the renderer of the answer is broken', async () => {
    const hookRunner: NonNullable<DoctorEnv['hookRunner']> = (name, event, ctx) =>
      runHook(name, event, { ...ctx, out: text => ctx.out(text.replace('deny', 'allow').replace('"decision"', '"verdict"')) });
    const cfg = inMode('enforce');
    const h = allThree({ cfg, hookRunner });
    const check = byId(await runDoctor(h.env, cfg), 'hooks.roundtrip');

    expect(check.status).toBe('fail');
    expect(check.message).toContain('claude');
    expect(check.message).toContain('allow');
    expect(check.message).toContain('verdict');
    expect(check.message).not.toContain('\n');
    expect(check.fix).toMatch(/\S/);
  });

  it('fails for output that is not a deny or the warning, however it fails', async () => {
    const outputs: Array<[string | undefined, RegExp]> = [
      [undefined, /no output/],
      ['allowed', /not JSON.*allowed/],
      ['{"ok":true}', /\{"ok":true\}/],
      ['[]', /\[\]/],
    ];
    for (const [output, expected] of outputs) {
      const hookRunner: NonNullable<DoctorEnv['hookRunner']> = async (_name, _event, ctx) => {
        if (output !== undefined) ctx.out(output);
        return 0;
      };
      const h = allThree({ hookRunner });
      const check = byId(await runDoctor(h.env, h.cfg), 'hooks.roundtrip');
      expect(check.status, String(output)).toBe('fail');
      expect(check.message, String(output)).toMatch(expected);
    }
  });

  it('observe: a deny is wrong too, and the warning must carry the observe text', async () => {
    const cfg = inMode('observe');
    const alwaysDeny: NonNullable<DoctorEnv['hookRunner']> = async (name, _event, ctx) => {
      ctx.out(JSON.stringify(name === 'gemini' ? { decision: 'deny', reason: 'x' } : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x' } }));
      return 0;
    };
    const wrongText: NonNullable<DoctorEnv['hookRunner']> = async (_name, _event, ctx) => {
      ctx.out(JSON.stringify({ systemMessage: 'hello' }));
      return 0;
    };
    for (const hookRunner of [alwaysDeny, wrongText]) {
      const h = allThree({ cfg, hookRunner });
      expect(byId(await runDoctor(h.env, cfg), 'hooks.roundtrip').status).toBe('fail');
    }
  });

  it('enforce: a warning is not a deny, and a deny of the wrong shape is no deny', async () => {
    const claudeShapeForGemini: NonNullable<DoctorEnv['hookRunner']> = async (_name, _event, ctx) => {
      ctx.out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x' } }));
      return 0;
    };
    const cfg = inMode('enforce', '[gemini]');
    const h = harness({ cfg, fs: installedFs(cfg), hookRunner: claudeShapeForGemini });
    expect(byId(await runDoctor(h.env, cfg), 'hooks.roundtrip').status).toBe('fail');
  });

  describe('a deny must carry the whole output contract', () => {
    const deny = (name: string, over: Record<string, unknown> = {}, drop: string[] = []): string => {
      const body: Record<string, unknown> =
        name === 'gemini'
          ? { decision: 'deny', reason: 'sdlc (enforce): no', ...over }
          : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'sdlc (enforce): no', ...over } };
      const target = (name === 'gemini' ? body : body.hookSpecificOutput) as Record<string, unknown>;
      for (const key of drop) delete target[key];
      return JSON.stringify(body);
    };
    const runnerOf = (output: (name: string) => string): NonNullable<DoctorEnv['hookRunner']> => async (name, _event, ctx) => {
      ctx.out(output(name));
      return 0;
    };
    const verdict = async (output: (name: string) => string, harnesses = '[claude, codex, gemini]'): Promise<Check> => {
      const cfg = inMode('enforce', harnesses);
      const h = harness({ cfg, fs: installedFs(cfg), installed: ALL_CLIS, hookRunner: runnerOf(output) });
      return byId(await runDoctor(h.env, cfg), 'hooks.roundtrip');
    };

    it('passes for the exact output of each harness', async () => {
      expect((await verdict(name => deny(name))).status).toBe('ok');
    });

    it.each(['claude', 'codex'] as const)('%s: fails for a deny without hookEventName, or with the name of another event', async name => {
      const missing = await verdict(n => deny(n, {}, ['hookEventName']), `[${name}]`);
      expect(missing.status).toBe('fail');
      expect(missing.message).toContain(name);
      expect(missing.message).toContain('hookEventName');

      const wrong = await verdict(n => deny(n, { hookEventName: 'UserPromptSubmit' }), `[${name}]`);
      expect(wrong.status).toBe('fail');
      expect(wrong.message).toContain('PreToolUse');
    });

    it.each(['claude', 'codex', 'gemini'] as const)('%s: fails for a deny with an empty reason, or none', async name => {
      const key = name === 'gemini' ? 'reason' : 'permissionDecisionReason';
      for (const over of [{ [key]: '' }, { [key]: '   ' }, { [key]: 5 }]) {
        const check = await verdict(n => deny(n, over), `[${name}]`);
        expect(check.status, JSON.stringify(over)).toBe('fail');
        expect(check.message).toContain(name);
        expect(check.message).toContain('reason');
      }
      const none = await verdict(n => deny(n, {}, [key]), `[${name}]`);
      expect(none.status).toBe('fail');
    });

    it('gemini names no event in its deny, so none is asked for', async () => {
      expect(JSON.parse(deny('gemini'))).toEqual({ decision: 'deny', reason: 'sdlc (enforce): no' });
      expect((await verdict(n => deny(n), '[gemini]')).status).toBe('ok');
    });

    it('uses the event name of the hook output, not a copy of it', async () => {
      // Gemini's own name for the pre-tool event is BeforeTool; a gemini hook that answers in the claude/codex shape is no deny
      const check = await verdict(() => deny('claude'), '[gemini]');
      expect(check.status).toBe('fail');
    });

    it('observe: the warning of claude and codex must name the event too, and carry text', async () => {
      const cfg = inMode('observe', '[claude, codex]');
      const warning = (over: Record<string, unknown>): string =>
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'sdlc (observe): x', ...over }, systemMessage: 'sdlc (observe): x' });
      const good = harness({ cfg, fs: installedFs(cfg), hookRunner: runnerOf(() => warning({})) });
      expect(byId(await runDoctor(good.env, cfg), 'hooks.roundtrip').status).toBe('ok');
      for (const over of [{ hookEventName: 'SessionStart' }, { hookEventName: undefined }]) {
        const bad = harness({ cfg, fs: installedFs(cfg), hookRunner: runnerOf(() => warning(over)) });
        expect(byId(await runDoctor(bad.env, cfg), 'hooks.roundtrip').status, JSON.stringify(over)).toBe('fail');
      }
    });
  });

  it('quotes why a hook was skipped when it printed nothing', async () => {
    const hookRunner: NonNullable<DoctorEnv['hookRunner']> = async (_name, _event, ctx) => {
      ctx.err('sdlc: hook skipped: stdin is not valid JSON');
      return 0;
    };
    const h = allThree({ hookRunner });
    const check = byId(await runDoctor(h.env, h.cfg), 'hooks.roundtrip');
    expect(check.status).toBe('fail');
    expect(check.message).toContain('hook skipped: stdin is not valid JSON');
  });

  it('fails, with the reason, when the runner throws', async () => {
    const hookRunner: NonNullable<DoctorEnv['hookRunner']> = async () => {
      throw new Error('boom\nhappened');
    };
    const h = allThree({ hookRunner });
    const check = byId(await runDoctor(h.env, h.cfg), 'hooks.roundtrip');
    expect(check.status).toBe('fail');
    expect(check.message).toContain('boom happened');
  });

  it('never gives the hook a tracker it could read tasks with', async () => {
    let made = 0;
    const hookRunner: NonNullable<DoctorEnv['hookRunner']> = async (name, event, ctx) => {
      const tracker = ctx.makeTracker(cfgOf(CONFIG), '/memory');
      await expect(tracker.getTask(5)).rejects.toThrow(/round trip/);
      await expect(tracker.scanTasks()).rejects.toThrow(/round trip/);
      made += 1;
      return runHook(name, event, ctx);
    };
    const h = allThree({ hookRunner });
    expect(byId(await runDoctor(h.env, h.cfg), 'hooks.roundtrip').status).toBe('ok');
    expect(made).toBe(3);
  });
});

describe('outbox.pending', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const entry = (id: string): string => JSON.stringify({ id, at: '2026-06-01T00:00:00.000Z', argv: ['approve', '5'] });
  const gap = JSON.stringify({ at: '2026-06-01T00:00:00.000Z', rule: 'no-task', text: 'edit src/a.ts', harness: 'claude', blocked: false });

  /** A repository on disk with these files in its cache, as the main checkout of a worktree list. */
  function checkout(cache: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'sdlc-outbox-'));
    tmpDirs.push(dir);
    mkdirSync(join(dir, '.sdlc', 'cache'), { recursive: true });
    for (const [file, text] of Object.entries(cache)) writeFileSync(join(dir, '.sdlc', 'cache', file), text);
    return dir;
  }
  const porcelain = (dir: string): string => `worktree ${dir}\nHEAD 0123456789abcdef\nbranch refs/heads/main\n\n`;

  it('is ok when nothing is queued or recorded, also without a cache directory', async () => {
    const h = harness();
    expect(byId(await runDoctor(h.env, h.cfg), 'outbox.pending')).toMatchObject({ status: 'ok' });

    const dir = checkout({});
    const empty = harness({ git: { worktrees: porcelain(dir) } });
    expect(byId(await runDoctor(empty.env, empty.cfg), 'outbox.pending').status).toBe('ok');
  });

  it('warns with the counts of queued writes and failed ones, and says to run sdlc sync', async () => {
    const dir = checkout({
      'outbox.jsonl': `${entry('a')}\n${entry('b')}\n{not json\n`,
      'outbox-failed.jsonl': `${JSON.stringify({ id: 'c', at: 'x', argv: ['approve', '9'], failedAt: 'y', error: 'boom' })}\n`,
    });
    const h = harness({ git: { worktrees: porcelain(dir) } });
    const check = byId(await runDoctor(h.env, h.cfg), 'outbox.pending');

    expect(check.status).toBe('warn');
    expect(check.message).toBe('2 queued write(s), 1 failed; run sdlc sync');
    expect(check.fix).toBe('sdlc sync');
  });

  it('reports gaps only as a note: a queue of gaps alone is ok, not a warning', async () => {
    const dir = checkout({ 'gaps.jsonl': `${gap}\n${gap}\n` });
    const h = harness({ git: { worktrees: porcelain(dir) } });
    const check = byId(await runDoctor(h.env, h.cfg), 'outbox.pending');

    expect(check.status).toBe('ok');
    expect(check.message).toContain('2 gap(s) waiting for sync');
    expect(check.fix).toBeUndefined();
  });

  it('keeps the message for queued writes the same when there are gaps too', async () => {
    const dir = checkout({ 'outbox.jsonl': `${entry('a')}\n`, 'gaps.jsonl': `${gap}\n` });
    const h = harness({ git: { worktrees: porcelain(dir) } });
    const check = byId(await runDoctor(h.env, h.cfg), 'outbox.pending');

    expect(check.status).toBe('warn');
    expect(check.message).toBe('1 queued write(s), 0 failed; run sdlc sync');
  });

  it('warns for failed writes alone', async () => {
    const dir = checkout({ 'outbox-failed.jsonl': `${JSON.stringify({ id: 'c', at: 'x', argv: ['approve', '9'], failedAt: 'y', error: 'boom' })}\n` });
    const h = harness({ git: { worktrees: porcelain(dir) } });
    const check = byId(await runDoctor(h.env, h.cfg), 'outbox.pending');

    expect(check.status).toBe('warn');
    expect(check.message).toBe('0 queued write(s), 1 failed; run sdlc sync');
  });

  it('reads the cache of the main checkout, whichever worktree doctor runs in', async () => {
    const main = checkout({ 'outbox.jsonl': `${entry('a')}\n` });
    const worktree = `${main}/.worktrees/5-x`;
    const text = `${porcelain(main)}worktree ${worktree}\nHEAD abc\nbranch refs/heads/task/5-x\n\n`;
    const h = harness({ git: { worktrees: text }, makeTracker: () => trackerWith({ 5: 'in_progress' }).tracker });
    expect(byId(await runDoctor(h.env, h.cfg), 'outbox.pending').message).toMatch(/^1 queued write\(s\)/);
  });

  it('is not an error when git cannot list the worktrees: the cache of the repository root is read', async () => {
    const h = harness({ git: { worktreesFail: true } });
    expect(byId(await runDoctor(h.env, h.cfg), 'outbox.pending').status).toBe('ok');
  });
});

/** A tracker that knows only these tasks (by status); an unknown issue has no state comment, an `Error` is thrown. */
function trackerWith(tasks: Record<number, TaskState['status'] | Error>): { tracker: Tracker; asked: number[] } {
  const asked: number[] = [];
  const tracker = new Proxy({} as Tracker, {
    get: (_target, property) =>
      property === 'getTask'
        ? async (issue: number): Promise<TrackedTask> => {
            asked.push(issue);
            const found = tasks[issue];
            if (found === undefined) throw new NoStateCommentError(issue);
            if (found instanceof Error) throw found;
            return { issue, title: `task ${issue}`, state: { status: found } } as unknown as TrackedTask;
          }
        : undefined,
  });
  return { tracker, asked };
}

describe('worktrees.orphans', () => {
  const MAIN = '/memory';
  const record = (path: string, branch: string | undefined, extra = ''): string =>
    `worktree ${path}\nHEAD 0123456789abcdef\n${branch === undefined ? 'detached' : `branch refs/heads/${branch}`}\n${extra}\n`;
  const porcelain = (...records: string[]): string => `${record(MAIN, 'main')}${records.join('')}`;

  it('is ok when there is only the main checkout, asking neither git for more nor GitHub for tasks', async () => {
    const h = harness();
    const check = byId(await runDoctor(h.env, h.cfg), 'worktrees.orphans');
    expect(check.status).toBe('ok');
    expect(check.message).toMatch(/no orphan/);
    expect(h.gh.calls.map(call => call[0])).toEqual(['auth', 'repo', 'api', 'api', 'secret', 'api']);
  });

  it('is ok for worktrees of live tasks and for ones that are none of the kit (a branch of your own, outside .worktrees)', async () => {
    const { tracker, asked } = trackerWith({ 5: 'in_progress' });
    const text = porcelain(record(`${MAIN}/.worktrees/5-x`, 'task/5-x'), record(`${MAIN}/.worktrees/mine`, 'my-branch'), record('/elsewhere/7-y', 'task/7-y'));
    const h = harness({ git: { worktrees: text }, makeTracker: () => tracker });

    expect(byId(await runDoctor(h.env, h.cfg), 'worktrees.orphans').status).toBe('ok');
    expect(asked).toEqual([5]);
  });

  it('warns listing a worktree whose branch names no task, a done task, a detached HEAD and a missing directory', async () => {
    const { tracker } = trackerWith({ 6: 'done' });
    const text = porcelain(
      record(`${MAIN}/.worktrees/5-x`, 'task/5-x'),
      record(`${MAIN}/.worktrees/6-y`, 'task/6-y'),
      record(`${MAIN}/.worktrees/loose`, undefined),
      record(`${MAIN}/.worktrees/gone`, 'task/8-z', 'prunable gitdir file points to non-existent location'),
    );
    const h = harness({ git: { worktrees: text }, makeTracker: () => tracker });
    const check = byId(await runDoctor(h.env, h.cfg), 'worktrees.orphans');

    expect(check.status).toBe('warn');
    expect(check.message).toContain(`${MAIN}/.worktrees/5-x (task/5-x): no-task`);
    expect(check.message).toContain(`${MAIN}/.worktrees/6-y (task/6-y): task-done`);
    expect(check.message).toContain(`${MAIN}/.worktrees/loose: detached`);
    expect(check.message).toContain(`${MAIN}/.worktrees/gone (task/8-z): prunable`);
    expect(check.fix).toContain('sdlc worktree finish 6');
    expect(check.fix).toContain('git worktree prune');
  });

  it('needs no task lookup for a detached or prunable worktree', async () => {
    const { tracker, asked } = trackerWith({});
    const text = porcelain(record(`${MAIN}/.worktrees/loose`, undefined), record(`${MAIN}/.worktrees/gone`, 'task/8-z', 'prunable'));
    const h = harness({ git: { worktrees: text }, makeTracker: () => tracker });
    const check = byId(await runDoctor(h.env, h.cfg), 'worktrees.orphans');

    expect(check.status).toBe('warn');
    expect(asked).toEqual([]);
  });

  it('treats a task whose state comment is unreadable as no task', async () => {
    const { tracker } = trackerWith({});
    const h = harness({ git: { worktrees: porcelain(record(`${MAIN}/.worktrees/5-x`, 'task/5-x')) }, makeTracker: () => tracker });
    expect(byId(await runDoctor(h.env, h.cfg), 'worktrees.orphans').message).toContain('no-task');
  });

  it('warns "not checked (tasks unavailable)" when the tasks cannot be listed, and judges nothing', async () => {
    const { tracker } = trackerWith({ 5: new GhError(['issue', 'view', '5'], 'could not resolve host: api.github.com', 'gh failed') });
    const h = harness({ git: { worktrees: porcelain(record(`${MAIN}/.worktrees/5-x`, 'task/5-x')) }, makeTracker: () => tracker });
    const check = byId(await runDoctor(h.env, h.cfg), 'worktrees.orphans');

    expect(check.status).toBe('warn');
    expect(check.message).toMatch(/^not checked \(tasks unavailable/);
    expect(check.message).not.toContain('no-task');
  });

  it('with gh unusable asks no tracker at all and says the tasks are unavailable', async () => {
    const h = harness({
      installed: ['git', 'sdlc', 'npx', 'claude', 'graphify'],
      gh: [],
      git: { worktrees: porcelain(record(`${MAIN}/.worktrees/5-x`, 'task/5-x')) },
    });
    const check = byId(await runDoctor(h.env, h.cfg), 'worktrees.orphans');

    expect(check.message).toMatch(/^not checked \(tasks unavailable/);
    expect(check.message).toContain('gh is not installed');
    expect(h.gh.calls).toEqual([]);
  });

  it('does not wait for ever on a task lookup that hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const hanging = new Proxy({} as Tracker, { get: () => () => new Promise(() => undefined) });
      const h = harness({ git: { worktrees: porcelain(record(`${MAIN}/.worktrees/5-x`, 'task/5-x')) }, makeTracker: () => hanging });
      let settled = false;
      const done = runDoctor(h.env, h.cfg).finally(() => {
        settled = true;
      });
      // The deadline starts when the lookup does, after real file reads: advance until the run is over.
      for (let step = 0; step < 100 && !settled; step += 1) await vi.advanceTimersByTimeAsync(1_000);
      const check = byId(await done, 'worktrees.orphans');

      expect(check.status).toBe('warn');
      expect(check.message).toMatch(/^not checked \(tasks unavailable.*timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes no GitHub mutation, and asks only about the issues of worktrees no task was found for', async () => {
    const { tracker, asked } = trackerWith({ 5: 'in_progress', 6: 'done' });
    const text = porcelain(record(`${MAIN}/.worktrees/5-x`, 'task/5-x'), record(`${MAIN}/.worktrees/6-y`, 'task/6-y'), record(`${MAIN}/.worktrees/7-z`, 'task/7-z'));
    const h = harness({ git: { worktrees: text }, makeTracker: () => tracker });
    await runDoctor(h.env, h.cfg);

    expect(mutations(h.gh)).toEqual([]);
    expect(asked.sort()).toEqual([5, 6, 7]);
  });

  it('warns "not checked" when git cannot list the worktrees', async () => {
    const h = harness({ git: { worktreesFail: true } });
    const check = byId(await runDoctor(h.env, h.cfg), 'worktrees.orphans');
    expect(check.status).toBe('warn');
    expect(check.message).toMatch(/^not checked: .*worktree/);
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
