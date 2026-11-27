import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadConfigFromString, type Config } from '../../src/config/schema.js';
import { parsePrBody } from '../../src/core/prBody.js';
import { applyPlan, planApply } from '../../src/install/apply.js';
import type { Change, FileChange, LineBlockChange } from '../../src/render/changes.js';
import { renderGithub } from '../../src/render/github.js';
import { renderData } from '../../src/render/instructions.js';
import { expectGolden } from '../support/golden.js';
import { memoryFs } from '../support/memoryFs.js';

const HEADER = `
version: 1
harnesses: [claude]
mode: enforce
github:
  repo: acme/shop
  default_branch: main
  project: { owner: acme, owner_type: org, number: 7 }
owners: [shop-owner]
kit_ref: v1.2.3
`;

const TARGETS = `
targets:
  - name: web
    environment: production-web
    deploy: { via: actions, workflow: .github/workflows/deploy-web.yml }
  - name: api
    deploy: { via: script, command: "./scripts/deploy-api.sh" }
`;

/** Targets, Actions and graphify all on. */
const FULL = `${HEADER}task_types: { enabled: [tooling, feature] }${TARGETS}stack: { graphify: true, actions: true }
`;
/** No targets, no Actions, no graphify. */
const MINIMAL = `${HEADER}task_types: { enabled: [tooling] }
stack: { graphify: false, actions: false }
`;

const cfgOf = (yaml: string): Config => loadConfigFromString(yaml);
const render = (cfg: Config): Change[] => renderGithub(cfg, renderData(cfg));

const fileAt = (changes: Change[], path: string): FileChange | undefined =>
  changes.find((c): c is FileChange => c.kind === 'file' && c.path === path);

const WORKFLOW_PATH = '.github/workflows/sdlc-reconcile.yml';
const PR_TEMPLATE_PATH = '.github/pull_request_template.md';

interface Step {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  run?: string;
}
interface Workflow {
  name: string;
  on: Record<string, unknown>;
  jobs: Record<
    string,
    {
      if?: string;
      'runs-on': string;
      'timeout-minutes': number;
      concurrency: { group: string; 'cancel-in-progress': boolean };
      permissions: Record<string, string>;
      steps: Step[];
    }
  >;
}
const workflowOf = (changes: Change[]): { text: string; doc: Workflow; job: Workflow['jobs'][string] } => {
  const text = fileAt(changes, WORKFLOW_PATH)!.content;
  const doc = parseYaml(text) as Workflow;
  return { text, doc, job: Object.values(doc.jobs)[0]! };
};

describe('renderGithub goldens', () => {
  it('renders the PR template, workflow and .gitignore block for a full config', () => {
    expectGolden('github/full', render(cfgOf(FULL)));
  });

  it('renders only the PR template and the .gitignore block when there are no targets, no Actions and no graphify', () => {
    expectGolden('github/minimal', render(cfgOf(MINIMAL)));
  });
});

describe('renderGithub PR template', () => {
  it('is always rendered, as a whole file', () => {
    for (const yaml of [FULL, MINIMAL]) {
      const template = fileAt(render(cfgOf(yaml)), PR_TEMPLATE_PATH);
      expect(template).toBeDefined();
      expect(template!.mode).toBeUndefined();
    }
  });

  it('has the Related to, Scope, Verification and Notes parts', () => {
    const text = fileAt(render(cfgOf(MINIMAL)), PR_TEMPLATE_PATH)!.content;
    expect(text).toMatch(/^Related to #$/m);
    expect(text).toMatch(/^Scope: final$/m);
    expect(text).toMatch(/^<!--.*`?partial`?.*-->$/m);
    expect(text).toMatch(/^## Verification$/m);
    expect(text).toMatch(/^## Notes$/m);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('lists the configured target names on a Targets: line only when targets exist', () => {
    const withTargets = fileAt(render(cfgOf(FULL)), PR_TEMPLATE_PATH)!.content;
    expect(withTargets).toMatch(/^Targets: web, api$/m);
    const without = fileAt(render(cfgOf(MINIMAL)), PR_TEMPLATE_PATH)!.content;
    expect(without).not.toMatch(/Targets/);
  });

  it('is read back by the PR body parser: final scope, the targets, and no closing keyword', () => {
    const text = fileAt(render(cfgOf(FULL)), PR_TEMPLATE_PATH)!.content;
    const filled = text.replace(/^Related to #$/m, 'Related to #12');
    expect(parsePrBody(filled)).toEqual({ issues: [12], scope: 'final', scopeRecognized: true, targets: ['web', 'api'] });
    // The unfilled template names no issue, so it cannot link or close anything by itself.
    expect(parsePrBody(text).issues).toEqual([]);
    expect(text).not.toMatch(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#/i);
  });

  it('explains partial scope in a comment whose lines the parser does not read as a Scope line', () => {
    const text = fileAt(render(cfgOf(MINIMAL)), PR_TEMPLATE_PATH)!.content;
    const comment = text.split('\n').filter(line => line.includes('partial'));
    expect(comment.length).toBeGreaterThan(0);
    for (const line of comment) expect(line.trimStart().startsWith('<!--')).toBe(true);
    expect(parsePrBody(text).scope).toBe('final');
  });
});

describe('renderGithub workflow', () => {
  it('is rendered only with stack.actions', () => {
    expect(fileAt(render(cfgOf(FULL)), WORKFLOW_PATH)).toBeDefined();
    expect(fileAt(render(cfgOf(MINIMAL)), WORKFLOW_PATH)).toBeUndefined();
    expect(render(cfgOf(MINIMAL)).map(c => c.path)).toEqual([PR_TEMPLATE_PATH, '.gitignore']);
  });

  it('is valid YAML with exactly the reconcile triggers', () => {
    const { doc } = workflowOf(render(cfgOf(FULL)));
    expect(Object.keys(doc.on).sort()).toEqual(
      ['deployment_status', 'issue_comment', 'issues', 'pull_request', 'release', 'schedule', 'workflow_dispatch'].sort(),
    );
    expect(doc.on.pull_request).toEqual({ types: ['closed'] });
    expect(doc.on.release).toEqual({ types: ['published'] });
    expect(doc.on.issue_comment).toEqual({ types: ['created'] });
    expect(doc.on.issues).toEqual({ types: ['closed', 'reopened'] });
    expect(doc.on.schedule).toEqual([{ cron: '17 * * * *' }]);
  });

  it('keeps the hourly schedule and says why', () => {
    const { text } = workflowOf(render(cfgOf(FULL)));
    expect(text).toMatch(/^\s*#.*at least once per/im);
    expect(text).toMatch(/^\s*#.*search lag/im);
  });

  it('has one job: serialised runs, a time limit and read-only contents', () => {
    const { doc, job } = workflowOf(render(cfgOf(FULL)));
    expect(Object.keys(doc.jobs)).toHaveLength(1);
    expect(job.concurrency).toEqual({ group: 'sdlc-reconcile', 'cancel-in-progress': false });
    expect(job.permissions).toEqual({ contents: 'read' });
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job['timeout-minutes']).toBe(15);
  });

  it('describes the concurrency queue as GitHub runs it', () => {
    const { text } = workflowOf(render(cfgOf(FULL)));
    expect(text).toMatch(/^\s*#.*a run in progress finishes; a newer waiting run replaces an older waiting one/im);
    expect(text).not.toMatch(/waiting run finishes instead of being cancelled/i);
  });

  it('only runs for a command comment, a same-repository PR and a successful deployment', () => {
    const { job } = workflowOf(render(cfgOf(FULL)));
    expect(job.if).toBe(
      "(github.event_name != 'issue_comment' || startsWith(github.event.comment.body, '/'))" +
        " && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)" +
        " && (github.event_name != 'deployment_status' || github.event.deployment_status.state == 'success')",
    );
  });

  it('says that merges of fork PRs are picked up by the hourly schedule', () => {
    const { text } = workflowOf(render(cfgOf(FULL)));
    expect(text).toMatch(/^\s*#.*fork.*hourly schedule/im);
  });

  it('checks the token first, then checks out, sets up Node 20 and runs reconcile through npx at kit_ref', () => {
    const { job } = workflowOf(render(cfgOf(FULL)));
    expect(job.steps).toHaveLength(4);
    const [check, checkout, node, reconcile] = job.steps as [Step, Step, Step, Step];
    expect(check.run).toContain('::error::Add the SDLC_TOKEN secret (a token with repo and project scopes); see INSTALL.md');
    expect(checkout).toEqual({
      uses: 'actions/checkout@v4',
      with: { ref: '${{ github.event.repository.default_branch }}' },
    });
    expect(node).toEqual({ uses: 'actions/setup-node@v4', with: { 'node-version': 20 } });
    expect(reconcile.run).toBe('npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#v1.2.3 reconcile');
    expect(reconcile.env).toEqual({ GH_TOKEN: '${{ secrets.SDLC_TOKEN }}' });
  });

  it('checks out the default branch and says why, so the configuration it reads is the merged one', () => {
    const { text } = workflowOf(render(cfgOf(FULL)));
    expect(text).toMatch(/^\s*#.*default branch/im);
    expect(text).toMatch(/^\s*#.*sdlc\.config\.yaml/im);
  });

  it('follows kit_ref', () => {
    const cfg = cfgOf(FULL.replace('kit_ref: v1.2.3', 'kit_ref: release/2.0'));
    const { job } = workflowOf(render(cfg));
    expect(job.steps.at(-1)!.run).toBe('npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#release/2.0 reconcile');
  });

  it('never prints the secret: only env mappings mention it, and the check step reads a variable', () => {
    const { text, job } = workflowOf(render(cfgOf(FULL)));
    for (const step of job.steps) expect(step.run ?? '').not.toMatch(/\$\{\{|secrets/);
    const check = job.steps[0]!;
    expect(check.env).toEqual({ SDLC_TOKEN: '${{ secrets.SDLC_TOKEN }}' });
    expect(check.run).toContain('"$SDLC_TOKEN"');
    expect(check.run).toContain('exit 1');
    expect(check.run).not.toMatch(/echo[^\n]*\$SDLC_TOKEN/);
    // Every `${{ secrets` in the file sits on an env value line.
    const mentions = text.split('\n').filter(line => line.includes('secrets.'));
    expect(mentions).toHaveLength(2);
    for (const line of mentions) expect(line).toMatch(/^\s+(SDLC_TOKEN|GH_TOKEN): \$\{\{ secrets\.SDLC_TOKEN \}\}$/);
  });

  it('writes the template escapes out as plain GitHub expressions', () => {
    const { text } = workflowOf(render(cfgOf(FULL)));
    expect(text).toContain('${{ secrets.SDLC_TOKEN }}');
    expect(text).not.toContain('\\');
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('renderGithub .gitignore block', () => {
  const block = (cfg: Config): LineBlockChange => {
    const found = render(cfg).filter((c): c is LineBlockChange => c.kind === 'line-block');
    expect(found).toHaveLength(1);
    return found[0]!;
  };

  it('is a # line block for .gitignore that keeps secrets and local state out of git', () => {
    const change = block(cfgOf(MINIMAL));
    expect(change.path).toBe('.gitignore');
    expect(change.comment).toBe('#');
    const lines = change.content.split('\n');
    expect(lines).toEqual(expect.arrayContaining(['.sdlc/cache/', '.env', '.env.*', '!.env.example', '.worktrees/']));
    expect(lines.indexOf('!.env.example')).toBeGreaterThan(lines.indexOf('.env.*'));
    expect(change.content.endsWith('\n')).toBe(false);
  });

  it('adds graphify-out/ only with stack.graphify', () => {
    expect(block(cfgOf(FULL)).content.split('\n')).toContain('graphify-out/');
    expect(block(cfgOf(MINIMAL)).content.split('\n')).not.toContain('graphify-out/');
  });

  it('is the same whether or not Actions are on', () => {
    const on = block(cfgOf(FULL.replace('graphify: true', 'graphify: false')));
    const off = block(cfgOf(MINIMAL));
    expect(on.content).toBe(off.content);
  });
});

describe('renderGithub applied to a repository', () => {
  it('writes the files and adds the block to an existing .gitignore without touching its lines', () => {
    const fs = memoryFs({ '.gitignore': 'node_modules/\ndist/\n' });
    const plan = planApply(render(cfgOf(FULL)), fs, undefined, { overwriteModified: false });
    expect(plan.errors).toEqual([]);
    expect(applyPlan(plan, fs, { removeObsolete: false }).errors).toEqual([]);
    expect([...fs.files.keys()].sort()).toEqual([
      '.github/pull_request_template.md',
      '.github/workflows/sdlc-reconcile.yml',
      '.gitignore',
      '.sdlc/manifest.json',
    ]);
    const ignore = fs.files.get('.gitignore')!;
    expect(ignore.startsWith('node_modules/\ndist/\n')).toBe(true);
    expect(ignore).toMatch(/# sdlc:begin\n\.sdlc\/cache\/\n[\s\S]*!\.env\.example\n[\s\S]*# sdlc:end/);
  });
});
