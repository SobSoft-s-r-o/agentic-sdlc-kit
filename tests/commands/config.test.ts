import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { runCli } from '../../src/cli.js';
import type { ConfigCommandContext } from '../../src/commands/config.js';
import { loadConfigFromString } from '../../src/config/schema.js';
import { fakeGh, type FakeGhStep } from '../support/fakeGh.js';

const validConfig = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/config/valid.yaml');

const repoView: FakeGhStep = {
  match: ['repo', 'view'],
  stdout: JSON.stringify({
    nameWithOwner: 'acme/shop',
    defaultBranchRef: { name: 'main' },
    owner: { login: 'acme' },
    isInOrganization: true,
  }),
};
const apiUser: FakeGhStep = { match: ['api', 'user'], stdout: 'shop-owner\n' };

let dir: string;
let exitCode: typeof process.exitCode;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sdlc-config-cmd-'));
  exitCode = process.exitCode;
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = exitCode;
});

/** `login`: who the tool runs as (`null`: GitHub cannot say). */
function harness(options: { script?: FakeGhStep[]; configPath?: string; login?: string | null } = {}) {
  const run = fakeGh(options.script ?? [repoView, apiUser]);
  const out: string[] = [];
  const err: string[] = [];
  const configPath = options.configPath ?? join(dir, 'sdlc.config.yaml');
  const login = options.login === null ? undefined : (options.login ?? 'shop-owner');
  const logins: string[] = [];
  const context: ConfigCommandContext = {
    run,
    repoRoot: dir,
    configPath,
    login: () => {
      logins.push('asked');
      return Promise.resolve(login);
    },
    out: t => out.push(t),
    err: t => err.push(t),
  };
  const go = (args: string[]) =>
    runCli(['config', ...args], { makeConfigContext: () => context, out: t => out.push(t), err: t => err.push(t) });
  return { run, out, err, configPath, go, logins };
}

const INVALID = `version: 1
harnesses: [claude]
mode: enforce
github: { repo: acme/shop, default_branch: main, project: { owner: acme, owner_type: org } }
owners: [shop-owner]
task_types: { enabled: [tooling] }
reconcile: { closed_lookback_days: 0 }
mcp: { servers: [nope] }
`;

describe('config validate', () => {
  it('prints Config OK for a valid file', async () => {
    const h = harness({ configPath: validConfig });

    await h.go(['validate']);

    expect(h.out).toEqual(['Config OK']);
    expect(h.err).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it('lists the issues on stderr and exits 1 for an invalid file', async () => {
    const path = join(dir, 'bad.yaml');
    writeFileSync(path, INVALID);
    const h = harness({ configPath: path });

    await h.go(['validate']);

    expect(h.out).toEqual([]);
    const text = h.err.join('\n');
    expect(text).toContain('Invalid config');
    expect(text).toContain('reconcile.closed_lookback_days');
    expect(text).toContain('github, context7, playwright');
    expect(process.exitCode).toBe(1);
  });

  it('reports a missing file and exits 1', async () => {
    const h = harness({ configPath: join(dir, 'missing.yaml') });

    await h.go(['validate']);

    expect(h.err.join('\n')).toContain('Cannot read config file');
    expect(process.exitCode).toBe(1);
  });

  it('with --json prints {ok: true}', async () => {
    const h = harness({ configPath: validConfig });

    await h.go(['validate', '--json']);

    expect(JSON.parse(h.out[0])).toEqual({ ok: true, path: validConfig });
    expect(process.exitCode).toBeUndefined();
  });

  it('with the global --json prints each issue and exits 1', async () => {
    const path = join(dir, 'bad.yaml');
    writeFileSync(path, INVALID);
    const run = fakeGh([]);
    const out: string[] = [];

    await runCli(['--json', 'config', 'validate'], {
      makeConfigContext: () => ({
        run,
        repoRoot: dir,
        configPath: path,
        login: () => Promise.resolve(undefined),
        out: t => out.push(t),
        err: () => undefined,
      }),
      out: t => out.push(t),
    });

    const result = JSON.parse(out[0]) as { ok: boolean; issues: { path: string; message: string }[] };
    expect(result.ok).toBe(false);
    expect(result.issues.map(i => i.path)).toContain('reconcile.closed_lookback_days');
    expect(process.exitCode).toBe(1);
  });

  it('never calls gh', async () => {
    const h = harness({ configPath: validConfig, script: [] });

    await h.go(['validate']);

    expect(h.run.calls).toEqual([]);
  });
});

describe('config suggest', () => {
  it('prints a YAML that loads as a config, and the notes on stderr', async () => {
    const h = harness();

    await h.go(['suggest']);

    expect(h.run.calls).toHaveLength(2);
    expect(h.out).toHaveLength(1);
    const cfg = loadConfigFromString(h.out[0]);
    expect(cfg.github.repo).toBe('acme/shop');
    expect(cfg.owners).toEqual(['shop-owner']);
    expect(h.err.join('\n')).toContain('no harness files found; defaulting to claude');
    expect(h.err.join('\n')).toContain('no deploy targets detected');
    expect(existsSync(h.configPath)).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('prints the YAML alone on stdout, ready to redirect to a file', async () => {
    const h = harness();

    await h.go(['suggest']);

    expect(h.out[0].endsWith('\n')).toBe(false);
    expect(h.out[0]).not.toContain('note');
  });

  it('--write writes sdlc.config.yaml when it does not exist', async () => {
    const h = harness();

    await h.go(['suggest', '--write']);

    expect(readFileSync(h.configPath, 'utf8')).toBe(`${h.out[0]}\n`);
    expect(h.err.join('\n')).toContain('Wrote sdlc.config.yaml');
    expect(process.exitCode).toBeUndefined();
  });

  it('--write refuses to touch an existing file, without calling gh', async () => {
    const h = harness();
    writeFileSync(h.configPath, 'keep: me\n');

    await h.go(['suggest', '--write']);

    expect(h.err).toEqual(['sdlc.config.yaml exists; edit it instead']);
    expect(h.out).toEqual([]);
    expect(h.run.calls).toEqual([]);
    expect(readFileSync(h.configPath, 'utf8')).toBe('keep: me\n');
    expect(process.exitCode).toBe(1);
  });

  it('--write --dry-run writes nothing and says what it would write', async () => {
    const h = harness();

    await h.go(['suggest', '--write', '--dry-run']);

    expect(existsSync(h.configPath)).toBe(false);
    expect(h.err.join('\n')).toContain('Would write sdlc.config.yaml');
    expect(process.exitCode).toBeUndefined();
  });

  it('--json prints the YAML, the notes and whether it was written', async () => {
    const h = harness();

    await h.go(['suggest', '--json']);

    const result = JSON.parse(h.out[0]) as { yaml: string; notes: string[]; written: boolean };
    expect(parseYaml(result.yaml)).toMatchObject({ version: 1 });
    expect(result.notes).toContain('no harness files found; defaulting to claude');
    expect(result.written).toBe(false);
    expect(h.err).toEqual([]);
  });

  it('--json --write reports the written path; an existing file is a JSON error', async () => {
    const written = harness();
    await written.go(['suggest', '--write', '--json']);
    expect(JSON.parse(written.out[0])).toMatchObject({ written: true, path: written.configPath });

    const existing = harness();
    writeFileSync(existing.configPath, 'keep: me\n');
    await existing.go(['suggest', '--write', '--json']);
    expect(JSON.parse(existing.out[0])).toEqual({ error: 'sdlc.config.yaml exists; edit it instead' });
    expect(process.exitCode).toBe(1);
  });

  it('prints the gh failure and exits 1', async () => {
    const h = harness({ script: [{ match: ['repo', 'view'], code: 1, stderr: 'no git remotes found' }] });

    await h.go(['suggest']);

    expect(h.err.join('\n')).toContain('no git remotes found');
    expect(h.out).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
});

describe('config set mode', () => {
  const COMMENTED = `# Hand-edited; keep the comments.
${readFileSync(validConfig, 'utf8').replace('mode: observe', '# owner notes: enforce once the gaps are quiet\nmode: observe  # warn only')}# trailing comment
`;
  const withAgents = (text: string) => `${text}agents: [shop-bot]\n`;
  const seed = (path: string, text = COMMENTED) => writeFileSync(path, text);

  it('lets an owner switch the mode, keeps the comments and says what to run next', async () => {
    const h = harness();
    seed(h.configPath);

    await h.go(['set', 'mode', 'enforce']);

    expect(h.out).toEqual(['mode: observe -> enforce. Run `sdlc upgrade` so the instructions and hooks match.']);
    expect(h.err).toEqual([]);
    expect(readFileSync(h.configPath, 'utf8')).toBe(
      COMMENTED.replace('mode: observe  # warn only', 'mode: enforce  # warn only'),
    );
    expect(loadConfigFromString(readFileSync(h.configPath, 'utf8')).mode).toBe('enforce');
    expect(process.exitCode).toBeUndefined();
  });

  it('works the other way round, and compares logins case-insensitively', async () => {
    const h = harness({ login: 'Shop-Owner' });
    seed(h.configPath, readFileSync(validConfig, 'utf8').replace('mode: observe', 'mode: enforce'));

    await h.go(['set', 'mode', 'observe']);

    expect(h.out).toEqual(['mode: enforce -> observe. Run `sdlc upgrade` so the instructions and hooks match.']);
    expect(loadConfigFromString(readFileSync(h.configPath, 'utf8')).mode).toBe('observe');
  });

  it('refuses a login listed in agents', async () => {
    const h = harness({ login: 'Shop-Bot' });
    seed(h.configPath, withAgents(COMMENTED));

    await h.go(['set', 'mode', 'enforce']);

    expect(h.err).toEqual(['config set must be run by an owner; Shop-Bot is listed in agents']);
    expect(h.out).toEqual([]);
    expect(readFileSync(h.configPath, 'utf8')).toBe(withAgents(COMMENTED));
    expect(process.exitCode).toBe(1);
  });

  it('refuses a login that is not an owner and lists the owners', async () => {
    const h = harness({ login: 'someone-else' });
    seed(h.configPath);

    await h.go(['set', 'mode', 'enforce']);

    expect(h.err).toEqual(['config set must be run by an owner (owners: shop-owner)']);
    expect(readFileSync(h.configPath, 'utf8')).toBe(COMMENTED);
    expect(process.exitCode).toBe(1);
  });

  it('refuses when GitHub cannot confirm the login', async () => {
    const h = harness({ login: null });
    seed(h.configPath);

    await h.go(['set', 'mode', 'enforce']);

    expect(h.err).toEqual(["cannot confirm the owner's GitHub login; run gh auth login"]);
    expect(readFileSync(h.configPath, 'utf8')).toBe(COMMENTED);
    expect(process.exitCode).toBe(1);
  });

  it('--dry-run checks the owner, says what would change and writes nothing', async () => {
    const h = harness();
    seed(h.configPath);

    await h.go(['set', 'mode', 'enforce', '--dry-run']);

    expect(h.out).toEqual(['mode: observe -> enforce (dry run: nothing written)']);
    expect(readFileSync(h.configPath, 'utf8')).toBe(COMMENTED);
    expect(process.exitCode).toBeUndefined();

    const refused = harness({ login: 'someone-else' });
    seed(refused.configPath);
    await refused.go(['set', 'mode', 'enforce', '--dry-run']);
    expect(refused.err).toEqual(['config set must be run by an owner (owners: shop-owner)']);
    expect(process.exitCode).toBe(1);
  });

  it('says so and writes nothing when the mode is already set', async () => {
    const h = harness();
    seed(h.configPath);

    await h.go(['set', 'mode', 'observe']);

    expect(h.out).toEqual(['mode is already observe']);
    expect(readFileSync(h.configPath, 'utf8')).toBe(COMMENTED);
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses a key other than mode, before reading anything', async () => {
    const h = harness({ configPath: join(dir, 'missing.yaml') });

    await h.go(['set', 'foo', 'bar']);

    expect(h.err).toEqual(['only "mode" can be set']);
    expect(h.logins).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('refuses an unknown mode', async () => {
    const h = harness();
    seed(h.configPath);

    await h.go(['set', 'mode', 'strict']);

    expect(h.err).toEqual(['mode must be observe or enforce, got "strict"']);
    expect(h.logins).toEqual([]);
    expect(readFileSync(h.configPath, 'utf8')).toBe(COMMENTED);
    expect(process.exitCode).toBe(1);
  });

  it('reports a missing config file and exits 1', async () => {
    const h = harness({ configPath: join(dir, 'missing.yaml') });

    await h.go(['set', 'mode', 'enforce']);

    expect(h.err.join('\n')).toContain('Cannot read config file');
    expect(h.logins).toEqual([]);
    expect(existsSync(h.configPath)).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('reports an invalid config and leaves it as it was', async () => {
    const h = harness();
    seed(h.configPath, INVALID);

    await h.go(['set', 'mode', 'observe']);

    expect(h.err.join('\n')).toContain('Invalid config');
    expect(h.err.join('\n')).toContain('reconcile.closed_lookback_days');
    expect(readFileSync(h.configPath, 'utf8')).toBe(INVALID);
    expect(process.exitCode).toBe(1);
  });

  it('--json prints what changed', async () => {
    const h = harness();
    seed(h.configPath);

    await h.go(['set', 'mode', 'enforce', '--json']);

    expect(JSON.parse(h.out[0])).toEqual({
      mode: 'enforce',
      previous: 'observe',
      changed: true,
      dryRun: false,
      path: h.configPath,
    });
  });

  it('--json --dry-run and --json on an unchanged mode report changed accordingly', async () => {
    const dry = harness();
    seed(dry.configPath);
    await dry.go(['set', 'mode', 'enforce', '--dry-run', '--json']);
    expect(JSON.parse(dry.out[0])).toMatchObject({ changed: false, dryRun: true, mode: 'enforce', previous: 'observe' });
    expect(readFileSync(dry.configPath, 'utf8')).toBe(COMMENTED);

    const same = harness();
    seed(same.configPath);
    await same.go(['set', 'mode', 'observe', '--json']);
    expect(JSON.parse(same.out[0])).toMatchObject({ changed: false, dryRun: false, mode: 'observe', previous: 'observe' });
  });

  it('--json prints a refusal as {error}', async () => {
    const h = harness({ login: 'someone-else' });
    seed(h.configPath);

    await h.go(['set', 'mode', 'enforce', '--json']);

    expect(JSON.parse(h.out[0])).toEqual({ error: 'config set must be run by an owner (owners: shop-owner)' });
    expect(process.exitCode).toBe(1);
  });
});
