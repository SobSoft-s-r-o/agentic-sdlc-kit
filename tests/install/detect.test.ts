import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadConfigFromString } from '../../src/config/schema.js';
import {
  detectConfig,
  probeRepo,
  scanWorkflowEnvironments,
  type RepoProbe,
} from '../../src/install/detect.js';
import { packageVersion } from '../../src/version.js';
import { fakeGh } from '../support/fakeGh.js';

function probe(overrides: Partial<RepoProbe> = {}): RepoProbe {
  return {
    repo: 'acme/shop',
    defaultBranch: 'main',
    ownerType: 'org',
    login: 'shop-owner',
    files: ['README.md'],
    workflowEnvironments: [],
    packageScripts: {},
    ...overrides,
  };
}

const detect = (overrides: Partial<RepoProbe> = {}) => {
  const result = detectConfig(probe(overrides));
  return { ...result, parsed: parseYaml(result.yaml) as Record<string, any> };
};

const WEB_DEPLOY = { workflow: '.github/workflows/deploy-web.yml', environment: 'production' };

describe('detectConfig', () => {
  describe('harnesses', () => {
    it('detects claude from CLAUDE.md', () => {
      expect(detect({ files: ['CLAUDE.md'] }).parsed.harnesses).toEqual(['claude']);
    });

    it('detects gemini from GEMINI.md', () => {
      const { parsed, notes } = detect({ files: ['GEMINI.md'] });
      expect(parsed.harnesses).toEqual(['gemini']);
      expect(notes).not.toContain('no harness files found; defaulting to claude');
    });

    it('detects codex from a .codex directory', () => {
      for (const files of [['.codex/config.toml'], ['.codex/'], ['.codex']]) {
        expect(detect({ files }).parsed.harnesses).toEqual(['codex']);
      }
    });

    it('detects codex from AGENTS.md and tells the owner to choose', () => {
      const { parsed, notes } = detect({ files: ['AGENTS.md'] });
      expect(parsed.harnesses).toEqual(['codex']);
      expect(notes).toContain('AGENTS.md found: choose codex or agents-md');
    });

    it('lists every harness found, in a stable order', () => {
      const { parsed } = detect({ files: ['GEMINI.md', 'CLAUDE.md', '.codex/config.toml'] });
      expect(parsed.harnesses).toEqual(['claude', 'codex', 'gemini']);
    });

    it('does not mistake nested or look-alike files for harness files', () => {
      const { parsed, notes } = detect({ files: ['docs/CLAUDE.md', 'AGENTS.md.bak', '.codexrc'] });
      expect(parsed.harnesses).toEqual(['claude']);
      expect(notes).toContain('no harness files found; defaulting to claude');
    });

    it('defaults to claude with a note when no harness file exists', () => {
      const { parsed, notes } = detect({ files: ['README.md'] });
      expect(parsed.harnesses).toEqual(['claude']);
      expect(notes).toContain('no harness files found; defaulting to claude');
    });
  });

  describe('targets', () => {
    it('turns a workflow environment into an actions target', () => {
      const { parsed } = detect({ workflowEnvironments: [WEB_DEPLOY] });
      expect(parsed.targets).toEqual([
        {
          name: 'web',
          environment: 'production',
          deploy: { via: 'actions', workflow: '.github/workflows/deploy-web.yml' },
        },
      ]);
    });

    it('names a target after the environment when the workflow is not called deploy-<name>', () => {
      const { parsed } = detect({
        workflowEnvironments: [
          { workflow: '.github/workflows/release.yml', environment: 'staging' },
          { workflow: '.github/workflows/deploy.yml', environment: 'production' },
        ],
      });
      expect(parsed.targets.map((t: { name: string }) => t.name)).toEqual(['staging', 'production']);
    });

    it('keeps names and environments unique', () => {
      const { parsed, notes } = detect({
        workflowEnvironments: [
          { workflow: '.github/workflows/deploy-web.yml', environment: 'production' },
          { workflow: '.github/workflows/deploy-web.yml', environment: 'staging' },
          { workflow: '.github/workflows/ci.yml', environment: 'production' },
        ],
      });
      expect(parsed.targets.map((t: { name: string; environment: string }) => [t.name, t.environment])).toEqual([
        ['web', 'production'],
        ['staging', 'staging'],
      ]);
      expect(notes.some(n => n.includes('"production"') && n.includes('.github/workflows/ci.yml'))).toBe(true);
    });

    it('prefers a deploy workflow when several use the same environment', () => {
      const { parsed } = detect({
        workflowEnvironments: [
          { workflow: '.github/workflows/build.yml', environment: 'production' },
          { workflow: '.github/workflows/deploy-api.yml', environment: 'production' },
        ],
      });
      expect(parsed.targets).toEqual([
        {
          name: 'api',
          environment: 'production',
          deploy: { via: 'actions', workflow: '.github/workflows/deploy-api.yml' },
        },
      ]);
    });

    it('slugifies names to lowercase kebab-case', () => {
      const { parsed } = detect({
        workflowEnvironments: [{ workflow: '.github/workflows/deploy-Web_App.yml', environment: 'Prod Env' }],
      });
      expect(parsed.targets[0].name).toBe('web-app');
      expect(parsed.targets[0].environment).toBe('Prod Env');
    });
  });

  describe('quality gate', () => {
    it('uses npm test when package.json has a test script', () => {
      expect(detect({ packageScripts: { test: 'vitest run' } }).parsed.quality_gate).toEqual(['npm test']);
    });

    it('is empty without a test script', () => {
      expect(detect({ packageScripts: { build: 'tsc' } }).parsed.quality_gate).toEqual([]);
      expect(detect().parsed.quality_gate).toEqual([]);
    });

    it('ignores the placeholder script npm init writes', () => {
      const placeholder = 'echo "Error: no test specified" && exit 1';
      expect(detect({ packageScripts: { test: placeholder } }).parsed.quality_gate).toEqual([]);
    });
  });

  describe('task types', () => {
    it('disables feature and bugfix without targets, and says so', () => {
      const { parsed, notes } = detect();
      expect(parsed.task_types.enabled).toEqual(['tooling', 'analysis', 'production-data', 'artifact', 'spike']);
      expect(notes).toContain('no deploy targets detected; feature/bugfix disabled until you add a target');
    });

    it('enables all seven built-ins when there is a target', () => {
      const { parsed, notes } = detect({ workflowEnvironments: [WEB_DEPLOY] });
      expect(parsed.task_types.enabled).toEqual([
        'feature',
        'bugfix',
        'tooling',
        'analysis',
        'production-data',
        'artifact',
        'spike',
      ]);
      expect(notes.some(n => n.includes('no deploy targets'))).toBe(false);
    });
  });

  describe('repository facts', () => {
    it('fills github, owners and agents from the probe', () => {
      const { parsed } = detect({ repo: 'me/tool', defaultBranch: 'trunk', ownerType: 'user', login: 'me' });
      expect(parsed.version).toBe(1);
      expect(parsed.github).toEqual({
        repo: 'me/tool',
        default_branch: 'trunk',
        project: { owner: 'me', owner_type: 'user' },
      });
      expect(parsed.owners).toEqual(['me']);
      expect(parsed.agents).toEqual([]);
    });

    it('starts in observe mode with the owner-only merge policy', () => {
      const { parsed } = detect();
      expect(parsed.mode).toBe('observe');
      expect(parsed.merge_policy).toBe('owner_only');
    });
  });

  describe('kit_ref', () => {
    it('writes kit_ref explicitly, v<version> by default, with a comment on when to change it', () => {
      const { yaml, parsed } = detect();
      expect(parsed.kit_ref).toBe(`v${packageVersion()}`);
      expect(yaml).toMatch(/\n# Until a release tag exists, set main or the ref you installed from[^\n]*\nkit_ref: v\d/);
      expect(loadConfigFromString(yaml).kitRef).toBe(`v${packageVersion()}`);
    });
  });

  describe('round trip', () => {
    it('emits YAML that loadConfigFromString accepts, without targets', () => {
      const cfg = loadConfigFromString(detectConfig(probe()).yaml);
      expect(cfg.github.repo).toBe('acme/shop');
      expect(cfg.targets).toEqual([]);
      expect(cfg.owners).toEqual(['shop-owner']);
    });

    it('emits YAML that loadConfigFromString accepts, with several targets and every field set', () => {
      const text = detectConfig(
        probe({
          files: ['CLAUDE.md', 'GEMINI.md', 'AGENTS.md', '.codex/config.toml'],
          workflowEnvironments: [
            WEB_DEPLOY,
            { workflow: '.github/workflows/deploy-api.yml', environment: 'production-api' },
          ],
          packageScripts: { test: 'vitest run' },
        }),
      ).yaml;
      const cfg = loadConfigFromString(text);
      expect(cfg.harnesses).toEqual(['claude', 'codex', 'gemini']);
      expect(cfg.targets.map(t => t.name)).toEqual(['web', 'api']);
      expect(cfg.qualityGate).toEqual(['npm test']);
      expect(cfg.taskTypes.enabled).toHaveLength(7);
    });

    it('keeps notes out of the YAML body', () => {
      const { yaml, notes } = detectConfig(probe());
      expect(notes.length).toBeGreaterThan(0);
      for (const note of notes) expect(yaml).not.toContain(note);
    });
  });
});

describe('scanWorkflowEnvironments', () => {
  it('finds a scalar environment', () => {
    expect(scanWorkflowEnvironments('jobs:\n  deploy:\n    environment: production\n')).toEqual(['production']);
  });

  it('finds quoted values and ignores trailing comments', () => {
    const text = `jobs:
  a:
    environment: "staging"
  b:
    environment: 'prod-eu' # europe
`;
    expect(scanWorkflowEnvironments(text)).toEqual(['staging', 'prod-eu']);
  });

  it('finds the name in a mapping or flow mapping', () => {
    const text = `jobs:
  a:
    environment:
      name: production
      url: https://example.com
  b:
    environment: { name: staging, url: https://example.com }
`;
    expect(scanWorkflowEnvironments(text)).toEqual(['production', 'staging']);
  });

  it('skips expressions and de-duplicates', () => {
    const text = `jobs:
  a:
    environment: \${{ inputs.environment }}
  b:
    environment: production
  c:
    environment: production
`;
    expect(scanWorkflowEnvironments(text)).toEqual(['production']);
  });

  it('returns nothing for a workflow without environments', () => {
    expect(scanWorkflowEnvironments('on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n')).toEqual([]);
  });
});

describe('probeRepo', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sdlc-probe-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const write = (path: string, text = '') => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  const repoView = {
    match: ['repo', 'view'],
    stdout: JSON.stringify({
      nameWithOwner: 'acme/shop',
      defaultBranchRef: { name: 'trunk' },
      owner: { login: 'acme' },
      isInOrganization: true,
    }),
  };
  const apiUser = { match: ['api', 'user'], stdout: 'shop-owner\n' };

  it('reads the repository from gh, then lists files, workflow environments and scripts', async () => {
    write('CLAUDE.md');
    write('package.json', JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc' } }));
    write(
      '.github/workflows/deploy-web.yml',
      'jobs:\n  deploy:\n    environment: production\n    runs-on: ubuntu-latest\n',
    );
    write('.github/workflows/ci.yaml', 'jobs:\n  test:\n    runs-on: ubuntu-latest\n');
    write('.github/workflows/notes.txt', 'environment: ignored\n');
    const run = fakeGh([repoView, apiUser]);

    const result = await probeRepo(run, root);

    expect(run.calls[0]).toEqual([
      'repo',
      'view',
      '--json',
      'nameWithOwner,defaultBranchRef,owner,isInOrganization',
    ]);
    expect(run.calls[1]).toEqual(['api', 'user', '--jq', '.login']);
    expect(result).toMatchObject({
      repo: 'acme/shop',
      defaultBranch: 'trunk',
      ownerType: 'org',
      login: 'shop-owner',
      workflowEnvironments: [{ workflow: '.github/workflows/deploy-web.yml', environment: 'production' }],
      packageScripts: { test: 'vitest run', build: 'tsc' },
    });
    expect(result.files).toEqual(
      expect.arrayContaining(['CLAUDE.md', 'package.json', '.github', '.github/workflows/deploy-web.yml']),
    );
  });

  it('reports a user-owned repository and falls back to main without a default branch', async () => {
    const run = fakeGh([
      {
        match: ['repo', 'view'],
        stdout: JSON.stringify({
          nameWithOwner: 'me/tool',
          defaultBranchRef: null,
          owner: { login: 'me' },
          isInOrganization: false,
        }),
      },
      { match: ['api', 'user'], stdout: 'me\n' },
    ]);

    expect(await probeRepo(run, root)).toMatchObject({
      repo: 'me/tool',
      defaultBranch: 'main',
      ownerType: 'user',
      login: 'me',
    });
  });

  it('lists files to depth 3 and skips .git and node_modules', async () => {
    write('a.txt');
    write('one/b.txt');
    write('one/two/c.txt');
    write('one/two/three/d.txt');
    write('.git/config');
    write('node_modules/pkg/index.js');
    write('sub/node_modules/pkg/index.js');
    const run = fakeGh([repoView, apiUser]);

    const { files } = await probeRepo(run, root);

    expect(files).toEqual(
      expect.arrayContaining(['a.txt', 'one', 'one/b.txt', 'one/two', 'one/two/c.txt', 'one/two/three']),
    );
    expect(files).not.toContain('one/two/three/d.txt');
    expect(files.some(f => f === '.git' || f.startsWith('.git/'))).toBe(false);
    expect(files.some(f => f.includes('node_modules'))).toBe(false);
  });

  it('does not follow symlinked directories', async () => {
    write('real/inner.txt');
    symlinkSync(join(root, 'real'), join(root, 'link'));
    const run = fakeGh([repoView, apiUser]);

    const { files } = await probeRepo(run, root);

    expect(files).toContain('link');
    expect(files).not.toContain('link/inner.txt');
  });

  it('tolerates a missing or malformed package.json and missing workflows', async () => {
    write('package.json', '{ not json');
    const run = fakeGh([repoView, apiUser]);

    const result = await probeRepo(run, root);

    expect(result.packageScripts).toEqual({});
    expect(result.workflowEnvironments).toEqual([]);
  });

  it('keeps only string scripts', async () => {
    write('package.json', JSON.stringify({ scripts: { test: 'vitest run', odd: 5 } }));
    const run = fakeGh([repoView, apiUser]);

    expect((await probeRepo(run, root)).packageScripts).toEqual({ test: 'vitest run' });
  });

  it('fails with the gh error when the repository cannot be read', async () => {
    const run = fakeGh([{ match: ['repo', 'view'], code: 1, stderr: 'not a git repository' }]);

    await expect(probeRepo(run, root)).rejects.toThrow('not a git repository');
  });
});
