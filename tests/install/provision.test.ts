import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfigFromString, type Config } from '../../src/config/schema.js';
import { ConfigError } from '../../src/core/taskTypes.js';
import { GhError } from '../../src/github/gh.js';
import {
  createGitRunner,
  defaultGitRunner,
  ensureBranchProtection,
  ensureLabels,
  ensurePushProtection,
  findLegacyHooks,
  HOOKS_PATH,
  nodeHookProbe,
  setHooksPath,
  type GitRunner,
} from '../../src/install/provision.js';
import { fakeGh, labelListArgs, labelListStep } from '../support/fakeGh.js';

const HEADER = `
version: 1
harnesses: [claude]
mode: observe
github:
  repo: acme/shop
  default_branch: main
  project: { owner: acme, owner_type: org, number: 7 }
owners: [shop-owner]
`;

const cfgOf = (extra = 'task_types: { enabled: [tooling, analysis] }\n'): Config =>
  loadConfigFromString(`${HEADER}${extra}`);

const PROTECTION_URL = 'repos/acme/shop/branches/main/protection';
const PROTECTION_BODY = {
  required_pull_request_reviews: { required_approving_review_count: 0 },
  enforce_admins: false,
  required_status_checks: null,
  restrictions: null,
  allow_force_pushes: false,
  allow_deletions: false,
};

describe('ensureLabels', () => {
  const LIST = labelListArgs();
  const create = (name: string, color: string, description: string): string[] => [
    'label', 'create', name, '--repo', 'acme/shop', '--color', color, '--description', description,
  ];

  it('creates sdlc:task, sdlc:partial and one type:<id> label per enabled type, with these exact arguments', async () => {
    const run = fakeGh([
      labelListStep([]),
      { match: ['label', 'create'] },
      { match: ['label', 'create'] },
      { match: ['label', 'create'] },
      { match: ['label', 'create'] },
    ]);
    const result = await ensureLabels(run, cfgOf(), { dryRun: false });
    expect(result).toEqual({
      created: ['sdlc:task', 'sdlc:partial', 'type:tooling', 'type:analysis'],
      existing: [],
    });
    expect(run.calls).toEqual([
      LIST,
      create('sdlc:task', '0e8a16', 'Tracked by agentic-sdlc-kit'),
      create('sdlc:partial', 'fbca04', 'A partial PR landed; the task stays open'),
      create('type:tooling', '1d76db', 'Task type: Tooling'),
      create('type:analysis', '1d76db', 'Task type: Analysis'),
    ]);
  });

  it('includes custom types and leaves out disabled built-in types', async () => {
    const cfg = cfgOf(`task_types:
  enabled: [tooling]
  custom:
    - id: infra-change
      label: Infra change
      phases: [intake, planning, implementation, review, delivery]
      ends_on: merge
`);
    const run = fakeGh([labelListStep([]), ...Array.from({ length: 4 }, () => ({ match: ['label', 'create'] }))]);
    const { created } = await ensureLabels(run, cfg, { dryRun: false });
    expect(created).toEqual(['sdlc:task', 'sdlc:partial', 'type:tooling', 'type:infra-change']);
  });

  it('creates only the missing labels and never edits an existing one', async () => {
    const run = fakeGh([
      labelListStep(['bug', 'sdlc:task', 'type:tooling']),
      { match: ['label', 'create'] },
      { match: ['label', 'create'] },
    ]);
    const result = await ensureLabels(run, cfgOf(), { dryRun: false });
    expect(result).toEqual({ created: ['sdlc:partial', 'type:analysis'], existing: ['sdlc:task', 'type:tooling'] });
    expect(run.calls.map(args => args.slice(0, 3))).toEqual([
      ['api', 'repos/acme/shop/labels', '--paginate'],
      ['label', 'create', 'sdlc:partial'],
      ['label', 'create', 'type:analysis'],
    ]);
    for (const args of run.calls) {
      expect(args).not.toContain('--force');
      expect(args).not.toContain('edit');
      expect(args).not.toContain('delete');
    }
  });

  it('matches label names the way GitHub does, ignoring case', async () => {
    const run = fakeGh([
      labelListStep(['SDLC:Task', 'sdlc:partial', 'Type:Tooling', 'type:analysis']),
    ]);
    const result = await ensureLabels(run, cfgOf(), { dryRun: false });
    expect(result.created).toEqual([]);
    expect(result.existing).toHaveLength(4);
    expect(run.calls).toHaveLength(1);
  });

  it('on a dry run reads the labels, reports what it would create and creates nothing', async () => {
    const run = fakeGh([labelListStep(['sdlc:task'])]);
    const result = await ensureLabels(run, cfgOf(), { dryRun: true });
    expect(result).toEqual({ created: ['sdlc:partial', 'type:tooling', 'type:analysis'], existing: ['sdlc:task'] });
    expect(run.calls).toEqual([LIST]);
  });

  it('reads every label of the repository through the paginated API, not a first page of 500', async () => {
    const run = fakeGh([labelListStep([])]);
    await ensureLabels(run, cfgOf(), { dryRun: true });
    expect(run.calls).toEqual([['api', 'repos/acme/shop/labels', '--paginate', '--jq', '.[].name']]);
  });

  it('labels beyond 500 are seen', async () => {
    const others = Array.from({ length: 596 }, (_, i) => `label-${i + 1}`);
    // The kit's labels sit past the 500th, where `gh label list --limit 500` stopped reading.
    const all = [...others, 'sdlc:task', 'sdlc:partial', 'type:tooling', 'type:analysis'];
    expect(all).toHaveLength(600);
    const run = fakeGh([labelListStep(all)]);
    const result = await ensureLabels(run, cfgOf(), { dryRun: true });
    expect(result.created).toEqual([]);
    expect(result.existing).toEqual(['sdlc:task', 'sdlc:partial', 'type:tooling', 'type:analysis']);
    expect(run.calls).toHaveLength(1);
  });

  it('ignores blank lines and Windows line ends in the listing', async () => {
    const run = fakeGh([
      { match: ['api', 'repos/acme/shop/labels'], stdout: '\nsdlc:task\r\n\r\nsdlc:partial\r\ntype:tooling\n type:analysis \n' },
    ]);
    const result = await ensureLabels(run, cfgOf(), { dryRun: true });
    expect(result.created).toEqual([]);
  });

  it('treats a label that appeared since the listing as existing, and fails on any other error', async () => {
    const raced = fakeGh([
      labelListStep([]),
      { match: ['label', 'create'], code: 1, stderr: 'label with name "sdlc:task" already exists; use `--force` to update its color and description' },
      { match: ['label', 'create'] },
      { match: ['label', 'create'] },
      { match: ['label', 'create'] },
    ]);
    const result = await ensureLabels(raced, cfgOf(), { dryRun: false });
    expect(result.existing).toEqual(['sdlc:task']);
    expect(result.created).toEqual(['sdlc:partial', 'type:tooling', 'type:analysis']);

    const broken = fakeGh([
      labelListStep([]),
      { match: ['label', 'create'], code: 1, stderr: 'HTTP 403: Resource not accessible' },
    ]);
    await expect(ensureLabels(broken, cfgOf(), { dryRun: false })).rejects.toBeInstanceOf(GhError);
  });

  const customType = (id: string): Config =>
    cfgOf(`task_types:
  enabled: [tooling]
  custom:
    - id: ${id}
      label: Long one
      phases: [intake, planning, implementation, review, delivery]
      ends_on: merge
`);

  it('refuses a type id whose label exceeds GitHub\'s 50 characters, naming the type, before any gh call', async () => {
    const id = `a${'b'.repeat(45)}`; // "type:" + 46 characters = 51
    expect(`type:${id}`).toHaveLength(51);
    const run = fakeGh([]);
    const failure = await ensureLabels(run, customType(id), { dryRun: false }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as Error).message).toContain(`"${id}"`);
    expect((failure as Error).message).toMatch(/50/);
    expect(run.calls).toEqual([]);
    // A dry run checks too.
    await expect(ensureLabels(fakeGh([]), customType(id), { dryRun: true })).rejects.toBeInstanceOf(ConfigError);
  });

  it('accepts a type id whose label is exactly 50 characters', async () => {
    const id = `a${'b'.repeat(44)}`; // "type:" + 45 characters = 50
    const run = fakeGh([labelListStep([]), ...Array.from({ length: 4 }, () => ({ match: ['label', 'create'] }))]);
    const { created } = await ensureLabels(run, customType(id), { dryRun: false });
    expect(created).toContain(`type:${id}`);
  });

  it('fails when the labels cannot be listed', async () => {
    const run = fakeGh([{ ...labelListStep([]), code: 1, stderr: 'gh: Not Found (HTTP 404)' }]);
    await expect(ensureLabels(run, cfgOf(), { dryRun: false })).rejects.toThrow(/404/);
  });
});

describe('ensureBranchProtection', () => {
  const GET = ['api', PROTECTION_URL];
  const PUT = ['api', '-X', 'PUT', PROTECTION_URL, '--input', '-'];

  it('puts a minimal protection on an unprotected default branch', async () => {
    const run = fakeGh([
      { match: ['api'], code: 1, stderr: 'gh: Branch not protected (HTTP 404)' },
      { match: ['api', 'PUT'], stdout: '{}' },
    ]);
    const result = await ensureBranchProtection(run, cfgOf(), { dryRun: false });
    expect(result.status).toBe('created');
    expect(result.message).toContain('main');
    expect(run.calls).toEqual([GET, PUT]);
    expect(run.inputs[0]).toBeUndefined();
    expect(JSON.parse(run.inputs[1]!)).toEqual(PROTECTION_BODY);
    expect(run.inputs[1]).toBe(JSON.stringify(PROTECTION_BODY));
  });

  it('reads a custom default branch', async () => {
    const cfg = loadConfigFromString(`${HEADER.replace('default_branch: main', 'default_branch: release/2')}task_types: { enabled: [tooling] }\n`);
    const run = fakeGh([{ match: ['api'], stdout: '{}' }]);
    await ensureBranchProtection(run, cfg, { dryRun: false });
    expect(run.calls).toEqual([['api', 'repos/acme/shop/branches/release/2/protection']]);
  });

  it('leaves an existing protection alone', async () => {
    const run = fakeGh([{ match: ['api'], stdout: '{"url":"https://api.github.com/x"}' }]);
    const result = await ensureBranchProtection(run, cfgOf(), { dryRun: false });
    expect(result.status).toBe('exists');
    expect(result.message).toContain('main');
    expect(run.calls).toEqual([GET]);
  });

  it('reports a plan restriction as unavailable, not as an error, when reading', async () => {
    const message = 'Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)';
    const run = fakeGh([{ match: ['api'], code: 1, stderr: `gh: ${message}` }]);
    const result = await ensureBranchProtection(run, cfgOf(), { dryRun: false });
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('Upgrade to GitHub Pro');
    expect(run.calls).toEqual([GET]);
  });

  it('reports a plan restriction as unavailable when the PUT is refused', async () => {
    const run = fakeGh([
      { match: ['api'], code: 1, stderr: 'gh: Branch not protected (HTTP 404)' },
      { match: ['api', 'PUT'], code: 1, stderr: 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)' },
    ]);
    const result = await ensureBranchProtection(run, cfgOf(), { dryRun: false });
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('Upgrade to GitHub Pro');
  });

  it('reports a missing admin right as unavailable too', async () => {
    const run = fakeGh([{ match: ['api'], code: 1, stderr: 'gh: Must have admin rights to Repository. (HTTP 403)' }]);
    expect((await ensureBranchProtection(run, cfgOf(), { dryRun: false })).status).toBe('unavailable');
  });

  it('fails on a rate limit, a plain 404 and any other error', async () => {
    const limited = fakeGh([{ match: ['api'], code: 1, stderr: 'gh: API rate limit exceeded for user (HTTP 403)' }]);
    await expect(ensureBranchProtection(limited, cfgOf(), { dryRun: false })).rejects.toBeInstanceOf(GhError);
    const missing = fakeGh([{ match: ['api'], code: 1, stderr: 'gh: Not Found (HTTP 404)' }]);
    await expect(ensureBranchProtection(missing, cfgOf(), { dryRun: false })).rejects.toThrow(/Not Found/);
    const boom = fakeGh([
      { match: ['api'], code: 1, stderr: 'gh: Branch not protected (HTTP 404)' },
      { match: ['api', 'PUT'], code: 1, stderr: 'gh: Server Error (HTTP 500)' },
    ]);
    await expect(ensureBranchProtection(boom, cfgOf(), { dryRun: false })).rejects.toThrow(/500/);
  });

  it('on a dry run reads, reports it would protect the branch and sends no PUT', async () => {
    const run = fakeGh([{ match: ['api'], code: 1, stderr: 'gh: Branch not protected (HTTP 404)' }]);
    const result = await ensureBranchProtection(run, cfgOf(), { dryRun: true });
    expect(result.status).toBe('created');
    expect(result.message).toMatch(/dry run/i);
    expect(run.calls).toEqual([GET]);
  });

  it('is skipped, without any call, when stack.branch_protection is false', async () => {
    const run = fakeGh([]);
    const cfg = cfgOf('task_types: { enabled: [tooling] }\nstack: { branch_protection: false }\n');
    const result = await ensureBranchProtection(run, cfg, { dryRun: false });
    expect(result.status).toBe('skipped');
    expect(result.message).toContain('branch_protection');
    expect(run.calls).toEqual([]);
  });
});

describe('ensurePushProtection', () => {
  const GET = ['api', 'repos/acme/shop', '--jq', '.security_and_analysis'];
  const PATCH = ['api', '-X', 'PATCH', 'repos/acme/shop', '--input', '-'];
  const BODY = {
    security_and_analysis: {
      secret_scanning: { status: 'enabled' },
      secret_scanning_push_protection: { status: 'enabled' },
    },
  };
  const UNAVAILABLE =
    'GitHub push protection unavailable for this repository; the local commit guard still blocks secrets';
  const on = JSON.stringify({
    secret_scanning: { status: 'enabled' },
    secret_scanning_push_protection: { status: 'enabled' },
  });

  it('does nothing when secret scanning and push protection are both on', async () => {
    const run = fakeGh([{ match: ['api'], stdout: `${on}\n` }]);
    const result = await ensurePushProtection(run, cfgOf(), { dryRun: false });
    expect(result.status).toBe('already');
    expect(run.calls).toEqual([GET]);
  });

  it('enables both with this exact PATCH body when either is off', async () => {
    const half = JSON.stringify({
      secret_scanning: { status: 'enabled' },
      secret_scanning_push_protection: { status: 'disabled' },
    });
    const run = fakeGh([{ match: ['api'], stdout: half }, { match: ['api', 'PATCH'], stdout: '{}' }]);
    const result = await ensurePushProtection(run, cfgOf(), { dryRun: false });
    expect(result.status).toBe('enabled');
    expect(run.calls).toEqual([GET, PATCH]);
    expect(run.inputs[1]).toBe(JSON.stringify(BODY));
    expect(run.inputs[1]).toBe(
      '{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}',
    );
  });

  it('enables them when GitHub reports no security settings at all', async () => {
    for (const stdout of ['null\n', '', '{}']) {
      const run = fakeGh([{ match: ['api'], stdout }, { match: ['api', 'PATCH'] }]);
      expect((await ensurePushProtection(run, cfgOf(), { dryRun: false })).status).toBe('enabled');
    }
  });

  it('reports 422 and 403 as unavailable, with the guard message, not as an error', async () => {
    for (const stderr of [
      'gh: Secret scanning is not available for this repository. (HTTP 422)',
      'gh: Must have admin rights to Repository. (HTTP 403)',
    ]) {
      const run = fakeGh([{ match: ['api'], stdout: 'null' }, { match: ['api', 'PATCH'], code: 1, stderr }]);
      const result = await ensurePushProtection(run, cfgOf(), { dryRun: false });
      expect(result).toEqual({ status: 'unavailable', message: UNAVAILABLE });
    }
  });

  it('fails on a rate limit and on any other error', async () => {
    const limited = fakeGh([
      { match: ['api'], stdout: 'null' },
      { match: ['api', 'PATCH'], code: 1, stderr: 'gh: API rate limit exceeded (HTTP 403)' },
    ]);
    await expect(ensurePushProtection(limited, cfgOf(), { dryRun: false })).rejects.toBeInstanceOf(GhError);
    const broken = fakeGh([{ match: ['api'], code: 1, stderr: 'gh: Not Found (HTTP 404)' }]);
    await expect(ensurePushProtection(broken, cfgOf(), { dryRun: false })).rejects.toThrow(/404/);
    const boom = fakeGh([
      { match: ['api'], stdout: 'null' },
      { match: ['api', 'PATCH'], code: 1, stderr: 'gh: Server Error (HTTP 500)' },
    ]);
    await expect(ensurePushProtection(boom, cfgOf(), { dryRun: false })).rejects.toThrow(/500/);
  });

  it('on a dry run reads, reports it would enable them and sends no PATCH', async () => {
    const run = fakeGh([{ match: ['api'], stdout: 'null' }]);
    const result = await ensurePushProtection(run, cfgOf(), { dryRun: true });
    expect(result.status).toBe('enabled');
    expect(result.message).toMatch(/dry run/i);
    expect(run.calls).toEqual([GET]);
  });
});

describe('setHooksPath', () => {
  /** A scripted git: answers each call in order and records the arguments. */
  const fakeGit = (answers: Array<{ stdout?: string; code?: number; stderr?: string }>): GitRunner & { calls: string[][] } => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      const answer = answers[calls.length];
      calls.push(args);
      if (!answer) throw new Error(`unexpected git call: ${args.join(' ')}`);
      return { stdout: answer.stdout ?? '', code: answer.code ?? 0, stderr: answer.stderr ?? '' };
    };
    return Object.assign(run, { calls });
  };

  it('sets .sdlc/githooks when core.hooksPath is unset', async () => {
    const git = fakeGit([{ code: 1 }, {}]);
    await expect(setHooksPath(git, { dryRun: false })).resolves.toBe('set');
    expect(git.calls).toEqual([
      ['config', '--get', 'core.hooksPath'],
      ['config', 'core.hooksPath', '.sdlc/githooks'],
    ]);
    expect(HOOKS_PATH).toBe('.sdlc/githooks');
  });

  it('is already done when core.hooksPath is .sdlc/githooks', async () => {
    for (const stdout of ['.sdlc/githooks\n', './.sdlc/githooks\n', '.sdlc/githooks/\n']) {
      const git = fakeGit([{ stdout }]);
      await expect(setHooksPath(git, { dryRun: false })).resolves.toBe('already');
      expect(git.calls).toHaveLength(1);
    }
  });

  it('reports a conflict for any other value, overwrites nothing and says both paths', async () => {
    const git = fakeGit([{ stdout: '.husky/_\n' }]);
    const notices: string[] = [];
    await expect(setHooksPath(git, { dryRun: false, notice: m => notices.push(m) })).resolves.toBe('conflict');
    expect(git.calls).toEqual([['config', '--get', 'core.hooksPath']]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('.husky/_');
    expect(notices[0]).toContain('.sdlc/githooks');
    expect(notices[0]).toMatch(/not active/);
  });

  it('on a dry run reports what it would do and never writes', async () => {
    const unset = fakeGit([{ code: 1 }]);
    await expect(setHooksPath(unset, { dryRun: true })).resolves.toBe('set');
    expect(unset.calls).toEqual([['config', '--get', 'core.hooksPath']]);
    const conflict = fakeGit([{ stdout: 'other\n' }]);
    await expect(setHooksPath(conflict, { dryRun: true })).resolves.toBe('conflict');
  });

  it('fails when git itself fails', async () => {
    const broken = fakeGit([{ code: 128, stderr: 'fatal: not a git repository' }]);
    await expect(setHooksPath(broken, { dryRun: false })).rejects.toThrow(/not a git repository/);
    const refused = fakeGit([{ code: 1 }, { code: 255, stderr: 'error: could not lock config file' }]);
    await expect(setHooksPath(refused, { dryRun: false })).rejects.toThrow(/could not lock/);
  });
});

describe('the real git runner', () => {
  it('returns a failing exit code instead of throwing (read-only commands only)', async () => {
    const version = await defaultGitRunner(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(/^git version/);

    const dir = await mkdtemp(join(tmpdir(), 'sdlc-git-'));
    try {
      const outside = await createGitRunner(dir)(['rev-parse', '--git-dir']);
      expect(outside.code).not.toBe(0);
      expect(outside.stderr).not.toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the real git runner: time limit', () => {
  afterEach(() => vi.unstubAllEnvs());

  /** A `git` that never answers, first on PATH. */
  async function hangingGit(dir: string): Promise<void> {
    const file = join(dir, 'git');
    await writeFile(file, '#!/bin/sh\nexec sleep 30\n');
    await chmod(file, 0o755);
    vi.stubEnv('PATH', `${dir}:${process.env.PATH ?? ''}`);
  }

  it('gives up on a git that outlives timeoutMs, as a failing result and not a hang', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sdlc-fakegit-'));
    try {
      await hangingGit(dir);
      const started = Date.now();

      const result = await createGitRunner(dir, { timeoutMs: 150 })(['rev-parse', '--show-toplevel']);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/terminated by SIGTERM/);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('has no time limit unless one is given', async () => {
    const result = await createGitRunner()(['--version']);
    expect(result.code).toBe(0);
  });
});

describe('findLegacyHooks', () => {
  const gitSaying = (stdout: string, code = 0): GitRunner => async () => ({ stdout, code, stderr: code === 0 ? '' : 'fatal: not a git repository' });

  it('lists the kit-named hooks in the common dir: the executable ones are chained, the others reported', async () => {
    const seen: string[] = [];
    const found = await findLegacyHooks(gitSaying('.git\n'), '/repo', path => {
      seen.push(path);
      return path.endsWith('/pre-commit') ? 'executable' : path.endsWith('/post-checkout') ? 'not-executable' : 'missing';
    });

    expect(found).toEqual({ dir: '.git/hooks', chained: ['pre-commit'], notExecutable: ['post-checkout'] });
    expect(seen).toEqual(['pre-commit', 'pre-push', 'post-merge', 'post-checkout'].map(name => `/repo/.git/hooks/${name}`));
  });

  it('uses an absolute common dir as it is (a linked worktree)', async () => {
    const found = await findLegacyHooks(gitSaying('/main/.git\n'), '/repo/.worktrees/x', path =>
      path === '/main/.git/hooks/pre-push' ? 'executable' : 'missing',
    );
    expect(found).toEqual({ dir: '/main/.git/hooks', chained: ['pre-push'], notExecutable: [] });
  });

  it('chains nothing when the hooks directory is the kit\'s own (a symlink to it)', async () => {
    const { mkdir, symlink } = await import('node:fs/promises');
    const root = await mkdtemp(join(tmpdir(), 'sdlc-legacy-'));
    try {
      await mkdir(join(root, '.sdlc', 'githooks'), { recursive: true });
      await mkdir(join(root, '.git'));
      await symlink(join(root, '.sdlc', 'githooks'), join(root, '.git', 'hooks'));
      const found = await findLegacyHooks(gitSaying('.git\n'), root, () => 'executable');
      expect(found).toEqual({ dir: '.git/hooks', chained: [], notExecutable: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('throws when git cannot say', async () => {
    await expect(findLegacyHooks(gitSaying('', 128), '/repo', () => 'missing')).rejects.toThrow(/git rev-parse --git-common-dir failed: fatal/);
  });

  it('the real probe tells a missing, a plain and an executable file apart', async () => {
    const { chmod, writeFile } = await import('node:fs/promises');
    const dir = await mkdtemp(join(tmpdir(), 'sdlc-probe-'));
    try {
      await writeFile(join(dir, 'plain'), '#!/bin/sh\n');
      await writeFile(join(dir, 'run'), '#!/bin/sh\n');
      await chmod(join(dir, 'run'), 0o755);
      await chmod(join(dir, 'plain'), 0o644);
      expect(nodeHookProbe(join(dir, 'none'))).toBe('missing');
      expect(nodeHookProbe(dir)).toBe('missing');
      expect(nodeHookProbe(join(dir, 'run'))).toBe('executable');
      if (process.platform !== 'win32') expect(nodeHookProbe(join(dir, 'plain'))).toBe('not-executable');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
