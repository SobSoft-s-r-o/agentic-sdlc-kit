import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
/** The text of a file in the repository; empty when it does not exist (a test then says so). */
const read = (name: string): string => (existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : '');

const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE = 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1';
const PRIVATE_REPORT = 'https://github.com/SobSoft-s-r-o/agentic-sdlc-kit/security/advisories/new';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  id?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
interface Job {
  'runs-on': string;
  needs?: string;
  permissions?: Record<string, string>;
  strategy?: { matrix: { os: string[]; node: number[]; include: Array<{ os: string; node: number }> } };
  steps: Step[];
}
interface Workflow {
  on: { push?: { branches?: string[]; tags?: string[] }; pull_request?: unknown };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}
/** A parsed workflow; an empty one when the file is missing, so each test fails on its own. */
const workflow = (name: string): Workflow => {
  const text = read(`.github/workflows/${name}`);
  return text === '' ? { on: {}, jobs: {} } : (parse(text) as Workflow);
};
const emptyJob: Job = { 'runs-on': '', steps: [] };
/** The `uses:` values of a workflow, as written (action and ref, without the trailing comment). */
const usesOf = (text: string): string[] => [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map(match => match[1] ?? '');
/** The commands of a job's steps, in order. */
const commandsOf = (job: Job): string[] => job.steps.flatMap(step => (step.run === undefined ? [] : [step.run.trim()]));

describe('open-source files', () => {
  it.each(['CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'CHANGELOG.md'])('has %s', name => {
    expect(existsSync(join(root, name)), name).toBe(true);
    expect(read(name).length, name).toBeGreaterThan(200);
  });

  it('does not carry its own pull request template: init renders the managed one', () => {
    expect(existsSync(join(root, '.github/pull_request_template.md'))).toBe(false);
  });

  it('SECURITY.md sends reports through GitHub private reporting and points at the threat model', () => {
    const security = read('SECURITY.md');
    expect(security).toContain(PRIVATE_REPORT);
    expect(security).toContain('docs/threat-model.md');
    expect(existsSync(join(root, 'docs/threat-model.md'))).toBe(true);
    expect(security).toMatch(/latest minor/i);
  });

  it('CODE_OF_CONDUCT.md is the Contributor Covenant 2.1 and enforces through private reporting', () => {
    const conduct = read('CODE_OF_CONDUCT.md');
    expect(conduct).toContain('# Contributor Covenant Code of Conduct');
    expect(conduct).toContain('https://www.contributor-covenant.org/version/2/1/code_of_conduct.html');
    for (const heading of ['## Our Pledge', '## Our Standards', '## Enforcement Responsibilities', '## Scope', '## Enforcement', '## Enforcement Guidelines', '## Attribution']) {
      expect(conduct, heading).toContain(`\n${heading}\n`);
    }
    for (const rung of ['### 1. Correction', '### 2. Warning', '### 3. Temporary Ban', '### 4. Permanent Ban']) expect(conduct, rung).toContain(rung);
    expect(conduct).toContain(PRIVATE_REPORT);
    expect(conduct).not.toContain('[INSERT CONTACT METHOD]');
  });

  it('no Markdown file at the root has an email address', () => {
    const documents = readdirSync(root).filter(name => name.endsWith('.md'));
    expect(documents).toEqual(expect.arrayContaining(['README.md', 'INSTALL.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'CHANGELOG.md']));
    for (const name of documents) {
      expect(read(name), name).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
      expect(read(name), name).not.toMatch(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
    }
  });

  it('CONTRIBUTING.md covers setup, goldens, the e2e gate, commit style and dependencies', () => {
    const contributing = read('CONTRIBUTING.md');
    for (const term of [
      'npm ci',
      'npm test',
      'npm run typecheck',
      'npm run build',
      'UPDATE_GOLDEN=1',
      'SDLC_E2E_REPO',
      'Commit style',
      'runtime dependencies',
      'CODE_OF_CONDUCT.md',
      'SECURITY.md',
    ]) {
      expect(contributing, term).toContain(term);
    }
  });

  it('CHANGELOG.md keeps the Keep a Changelog layout, newest first', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toContain('keepachangelog.com');
    const headings = changelog.split('\n').filter(line => line.startsWith('## '));
    // Newer releases are added between `[Unreleased]` and `[0.2.0]`.
    expect(headings[0]).toBe('## [Unreleased]');
    const at = (heading: string): number => headings.indexOf(heading);
    expect(at('## [0.2.0] - 2026-11-28'), '0.2.0 is listed').toBeGreaterThan(0);
    expect(at('## [0.1.0] - 2026-11-28'), '0.1.0 follows 0.2.0').toBeGreaterThan(at('## [0.2.0] - 2026-11-28'));
    expect(changelog).toContain('## [0.2.0]');
  });

  it('README links to the new files and lists the requirements', () => {
    const readme = read('README.md');
    for (const link of ['(CONTRIBUTING.md)', '(SECURITY.md)', '(CHANGELOG.md)', '(CODE_OF_CONDUCT.md)']) expect(readme, link).toContain(link);
    const requirements = readme.slice(readme.search(/^## Requirements/m));
    expect(requirements).toContain('Node.js 20 or newer');
    expect(requirements).toContain('git 2.31 or newer');
    expect(requirements).toMatch(/`gh`.*logged in/);
    expect(readme).toContain('npm install --save-dev agentic-sdlc-kit');
  });
});

describe('workflows', () => {
  it('pin actions by full SHA, the same two pins as the reconcile template, and nothing else', () => {
    const template = usesOf(read('templates/github/sdlc-reconcile.yml'));
    expect(template.sort()).toEqual([CHECKOUT, SETUP_NODE]);
    for (const name of ['ci.yml', 'release.yml']) {
      const uses = usesOf(read(`.github/workflows/${name}`));
      expect(uses.length, `${name} uses actions`).toBeGreaterThan(0);
      expect([...new Set(uses)].sort(), name).toEqual([CHECKOUT, SETUP_NODE]);
    }
  });

  it('install no dependency cache', () => {
    for (const name of ['ci.yml', 'release.yml']) {
      const setups = Object.values(workflow(name).jobs).flatMap(job => job.steps.filter(step => step.uses?.startsWith('actions/setup-node@')));
      expect(setups.length, `${name} sets up Node`).toBeGreaterThan(0);
      for (const setup of setups) expect(setup.with?.['package-manager-cache'], name).toBe(false);
    }
  });

  describe('ci.yml', () => {
    const ci = workflow('ci.yml');
    const job = ci.jobs.test ?? emptyJob;

    it('runs on pushes to main and on pull requests, read-only', () => {
      expect(ci.on.push?.branches).toEqual(['main']);
      expect(ci.on).toHaveProperty('pull_request');
      expect(ci.permissions).toEqual({ contents: 'read' });
    });

    it('covers Ubuntu on Node 20, 22 and 24, and macOS on Node 22', () => {
      expect(job.strategy?.matrix.os).toEqual(['ubuntu-latest']);
      expect(job.strategy?.matrix.node).toEqual([20, 22, 24]);
      expect(job.strategy?.matrix.include).toEqual([{ os: 'macos-latest', node: 22 }]);
      expect(job['runs-on']).toBe('${{ matrix.os }}');
    });

    it('installs, checks types, tests, builds and smoke-tests the tarball, in that order', () => {
      expect(commandsOf(job)).toEqual(['npm ci', 'npm run typecheck', 'npm test', 'npm run build', 'node scripts/pack-smoke.mjs']);
    });
  });

  describe('release.yml', () => {
    const text = read('.github/workflows/release.yml');
    const release = workflow('release.yml');
    const test = release.jobs.test ?? emptyJob;
    const publish = release.jobs.publish ?? emptyJob;
    const order = (job: Job): string[] => job.steps.map(step => step.run?.trim() ?? step.uses ?? '');

    it('publishes with trusted publishing: id-token, the npm registry, and no token secret', () => {
      expect(text).toContain('id-token: write');
      expect(text).toContain('registry-url: https://registry.npmjs.org');
      expect(text).not.toContain('NPM_TOKEN');
      expect(text).not.toMatch(/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets/);
      expect(text).not.toMatch(/secrets\./);
      expect(release.permissions).toEqual({ contents: 'read' });
      expect(publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
      expect(publish['runs-on']).toBe('ubuntu-latest');
    });

    it('splits the work: the job that runs the repository code cannot ask for an OIDC token', () => {
      expect(Object.keys(release.jobs).sort()).toEqual(['publish', 'test']);
      expect(test.permissions).toEqual({ contents: 'read' });
      expect(test.steps.some(step => step.with?.['registry-url'] !== undefined)).toBe(false);
      expect(publish.needs).toBe('test');
      expect(test.needs).toBeUndefined();
      // id-token: write appears once, on the publish job.
      expect(text.match(/id-token: write/g)).toHaveLength(1);
    });

    it('runs on version tags only', () => {
      expect(release.on.push).toEqual({ tags: ['v*'] });
      expect(release.on).not.toHaveProperty('pull_request');
    });

    it('uses Node 24 and refuses an npm older than 11.5.1 before publishing', () => {
      const setup = publish.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
      expect(setup?.with?.['node-version']).toBe(24);
      const check = publish.steps.find(step => step.run?.includes('npm --version'));
      expect(check?.run).toContain('11.5.1');
      expect(check?.run).toContain('exit 1');
    });

    it('tests, and checks the tag against package.json, in the test job', () => {
      expect(commandsOf(test)).toContain('npm ci');
      expect(commandsOf(test)).toContain('npm test');
      expect(text).toContain('${GITHUB_REF_NAME}');
      expect(text).toContain(`require('./package.json').version`);
      const tag = test.steps.find(step => step.run?.includes('GITHUB_REF_NAME'));
      expect(tag?.run).toContain('exit 1');
      expect(order(test).findIndex(entry => entry.includes('GITHUB_REF_NAME'))).toBeLessThan(order(test).indexOf('npm test'));
    });

    it('installs without dependency scripts, builds, and publishes unless the version is already on npm', () => {
      const steps = order(publish);
      expect(steps).toContain('npm ci --ignore-scripts');
      expect(commandsOf(publish)).not.toContain('npm ci');
      expect(commandsOf(publish)).not.toContain('npm test');
      expect(steps.indexOf('npm ci --ignore-scripts')).toBeLessThan(steps.indexOf('npm run build'));
      expect(steps.indexOf('npm run build')).toBeLessThan(steps.indexOf('npm publish'));
      const probe = publish.steps.find(step => step.id === 'published');
      expect(probe?.run).toContain('npm view');
      expect(probe?.run).toContain('agentic-sdlc-kit@');
      expect(probe?.run).toContain('skip=true');
      expect(steps.findIndex(entry => entry.includes('npm view'))).toBeLessThan(steps.indexOf('npm publish'));
      const published = publish.steps.filter(step => step.run?.trim() === 'npm publish');
      expect(published).toHaveLength(1);
      expect(published[0]?.if).toBe("steps.published.outputs.skip != 'true'");
    });

    it('treats only a 404 as not published; any other npm view failure fails the job', () => {
      const probe = publish.steps.find(step => step.id === 'published')?.run ?? '';
      expect(probe).toContain('E404');
      expect(probe).toContain('skip=false');
      // Three branches: success -> skip=true, E404 -> skip=false, anything else -> print the output and exit 1.
      expect(probe).toMatch(/if output="\$\(npm view [^)]*2>&1\)"; then[\s\S]*skip=true[\s\S]*elif[\s\S]*E404[\s\S]*skip=false[\s\S]*else[\s\S]*\$output[\s\S]*exit 1[\s\S]*fi/);
    });
  });
});

describe('scripts/pack-smoke.mjs', () => {
  const script = read('scripts/pack-smoke.mjs');

  it('exists and exercises the packed tarball through the installed binary', () => {
    expect(script.length).toBeGreaterThan(200);
    for (const term of ['npm', 'pack', '--json', '--no-audit', '--no-fund', '--no-install', 'config', 'validate', 'tests/fixtures/config/valid.yaml']) {
      expect(script, term).toContain(term);
    }
  });

  it('removes only its own temporary directory', () => {
    expect(script).toMatch(/rm\(\s*\w+,\s*\{\s*recursive:\s*true\s*\}\s*\)/);
    expect(script).not.toMatch(/rm\s+-rf/);
    expect(script).not.toMatch(/force:\s*true/);
  });
});
