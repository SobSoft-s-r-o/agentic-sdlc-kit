import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli.js';
import { loadConfigFromString, type Config, type Harness } from '../../src/config/schema.js';
import type { Change, MdBlockChange } from '../../src/render/changes.js';
import { parseFrontMatter } from '../../src/render/frontMatter.js';
import {
  KIT_PACKAGE,
  kitCommand,
  renderData,
  renderInstructions,
  type RenderData,
  type RenderRole,
} from '../../src/render/instructions.js';
import { expectGolden } from '../support/golden.js';

const HEADER = `
version: 1
harnesses: [claude, codex, gemini, agents-md]
mode: enforce
github:
  repo: acme/shop
  default_branch: main
  project: { owner: acme, owner_type: org, number: 7 }
owners: [shop-owner, shop-lead]
kit_ref: v1.2.3
`;

const FULL = `${HEADER}
content_language: en
quality_gate: ["npm test", "npm run lint"]
task_types:
  enabled: [feature, bugfix, tooling, analysis, production-data, artifact, spike]
  custom:
    - id: infra-change
      label: Infra change
      phases: [intake, brainstorming, planning, implementation, review, delivery]
      ends_on: deploy
      requires_before_review: [backup]
      targets_required: true
targets:
  - name: web
    environment: production-web
    deploy: { via: actions, workflow: .github/workflows/deploy-web.yml }
    paths: ["apps/web/**"]
  - name: api
    deploy: { via: script, command: "./scripts/deploy-api.sh" }
    paths: ["apps/api/**"]
stack: { superpowers: true, graphify: true }
`;

const MINIMAL = `${HEADER.replace('mode: enforce', 'mode: observe')}
task_types: { enabled: [tooling] }
stack: { superpowers: false, graphify: false }
`;

const HARNESSES: Harness[] = ['claude', 'codex', 'gemini', 'agents-md'];
const SKILLS = ['sdlc-task-tracking', 'sdlc-delivery', 'sdlc-orientation'] as const;
const INSTRUCTION_FILE: Record<Harness, string> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
  gemini: 'GEMINI.md',
  'agents-md': 'AGENTS.md',
};
const SKILL_DIR: Record<Harness, string> = {
  claude: '.claude/skills',
  codex: '.agents/skills',
  gemini: '.agents/skills',
  'agents-md': '.agents/skills',
};

const full = (extra = ''): Config => loadConfigFromString(`${FULL}${extra}`);
const minimal = (extra = ''): Config => loadConfigFromString(`${MINIMAL}${extra}`);

const changesFor = (cfg: Config, harness: Harness, data: RenderData = renderData(cfg)): Change[] =>
  renderInstructions(cfg, harness, data);

function block(changes: Change[]): MdBlockChange {
  const blocks = changes.filter((c): c is MdBlockChange => c.kind === 'md-block');
  expect(blocks).toHaveLength(1);
  return blocks[0]!;
}

const blockText = (cfg: Config, harness: Harness = 'claude'): string => block(changesFor(cfg, harness)).content;

const files = (changes: Change[]): Array<Extract<Change, { kind: 'file' }>> =>
  changes.filter((c): c is Extract<Change, { kind: 'file' }> => c.kind === 'file');

const ROLES: RenderRole[] = [
  'analyst',
  'architect',
  'developer',
  'tester',
  'reviewer',
  'final-reviewer',
  'security-reviewer',
  'diagnostician',
  'release-manager',
  'docs-writer',
  'scout',
].map(role => ({ role, description: `Does the ${role} part of the work, and reports back in one line.`, tier: 'standard' }));

const GITHUB_KIT = 'github:SobSoft-s-r-o/agentic-sdlc-kit';

describe('kitCommand', () => {
  it('names the package', () => {
    expect(KIT_PACKAGE).toBe('agentic-sdlc-kit');
  });

  it.each([
    { ref: 'v0.3.0', source: 'npm', spec: 'agentic-sdlc-kit@0.3.0' },
    { ref: 'v1.0.0-rc.1', source: 'npm', spec: 'agentic-sdlc-kit@1.0.0-rc.1' },
    { ref: 'v12.34.56', source: 'npm', spec: 'agentic-sdlc-kit@12.34.56' },
    { ref: 'main', source: 'github', spec: `${GITHUB_KIT}#main` },
    { ref: 'release/x', source: 'github', spec: `${GITHUB_KIT}#release/x` },
    { ref: '0123456789abcdef0123456789abcdef01234567', source: 'github', spec: `${GITHUB_KIT}#0123456789abcdef0123456789abcdef01234567` },
    { ref: '0.3.0', source: 'github', spec: `${GITHUB_KIT}#0.3.0` },
    { ref: 'v0.3', source: 'github', spec: `${GITHUB_KIT}#v0.3` },
    { ref: 'v0.3.0.1', source: 'github', spec: `${GITHUB_KIT}#v0.3.0.1` },
    { ref: 'v0.3.0/evil', source: 'github', spec: `${GITHUB_KIT}#v0.3.0/evil` },
  ] as const)('kitCommand picks the source: $ref is $source', ({ ref, source, spec }) => {
    expect(kitCommand(ref)).toEqual({ npx: `npx -y ${spec}`, devDependency: spec, source });
  });
});

describe('renderData', () => {
  it('renders a branch or a commit as the github form of the kit command', () => {
    const data = renderData(loadConfigFromString(FULL.replace('kit_ref: v1.2.3', 'kit_ref: release/2.0')));
    expect(data.kit).toEqual({ ref: 'release/2.0', npx: 'npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#release/2.0' });
  });

  it('carries the config, the kit reference and the switches', () => {
    const cfg = full();
    const data = renderData(cfg);
    expect(data.cfg).toBe(cfg);
    expect(data.kit).toEqual({ ref: 'v1.2.3', npx: 'npx -y agentic-sdlc-kit@1.2.3' });
    expect(data.enforce).toBe(true);
    expect(data.mergeOwnerOnly).toBe(true);
    expect(data.graphify).toBe(true);
    expect(data.superpowers).toBe(true);
    expect(data.contentLanguage).toBe('en');
    expect(data.defaultBranch).toBe('main');
    expect(data.qualityGate).toEqual(['npm test', 'npm run lint']);
    expect(data.roles).toHaveLength(11);
    expect(renderData(cfg, []).roles).toEqual([]);

    const other = renderData(minimal('merge_policy: agent_on_request\ncontent_language: sk\n'));
    expect(other.enforce).toBe(false);
    expect(other.mergeOwnerOnly).toBe(false);
    expect(other.graphify).toBe(false);
    expect(other.superpowers).toBe(false);
    expect(other.contentLanguage).toBe('sk');
    expect(other.qualityGate).toEqual([]);
  });

  it('describes every enabled type, built-in and custom, with its phases and how it ends', () => {
    const { types } = renderData(full());
    expect(types.map(t => t.id)).toEqual([
      'feature',
      'bugfix',
      'tooling',
      'analysis',
      'production-data',
      'artifact',
      'spike',
      'infra-change',
    ]);
    const byId = Object.fromEntries(types.map(t => [t.id, t]));
    expect(byId.feature).toMatchObject({
      label: 'Feature',
      endsOn: 'deploy',
      phasesText: 'intake → brainstorming → planning → implementation → verification → review → delivery',
    });
    expect(byId.bugfix!.phasesText).toBe('intake → debugging → planning → implementation → verification → review → delivery');
    expect(byId.feature!.endsOnText).toMatch(/successful deployment/);
    expect(byId.tooling!.endsOnText).toMatch(/merged to `main`/);
    expect(byId.analysis!.endsOnText).toMatch(/\/accept/);
    expect(byId['production-data']!.endsOnText).toMatch(/\/ran/);
    expect(byId.artifact!.endsOnText).toMatch(/merged to `main`.*\/accept/);
    expect(byId.feature!.evidenceText).toBe('');
    expect(byId['production-data']!.evidenceText).toBe('backup and dry-run');
    expect(byId['infra-change']!.evidenceText).toBe('backup');
    expect(new Set(types.map(t => t.endsOnText)).size).toBe(5);
  });

  it('knows whether the production-data type is enabled', () => {
    expect(renderData(full()).productionData).toBe(true);
    expect(renderData(minimal()).productionData).toBe(false);
  });

  it('lists the targets with their environment and how each deploys', () => {
    const { targets } = renderData(full());
    expect(targets).toEqual([
      { name: 'web', environment: 'production-web', via: 'actions', deployText: 'Actions workflow `.github/workflows/deploy-web.yml`' },
      { name: 'api', environment: 'production-api', via: 'script', deployText: 'script `./scripts/deploy-api.sh`' },
    ]);
    expect(renderData(minimal()).targets).toEqual([]);
  });

  it('says which OS keystore commands to show for secrets.local_store', () => {
    const flags = (store: string) => {
      const { secrets } = renderData(minimal(`secrets: { local_store: ${store} }\n`));
      return [secrets.localMacos, secrets.localLinux, secrets.localWindows, secrets.localOther];
    };
    expect(flags('auto')).toEqual([true, true, true, false]);
    expect(flags('keychain')).toEqual([true, false, false, false]);
    expect(flags('secret-service')).toEqual([false, true, false, false]);
    expect(flags('wincred')).toEqual([false, false, true, false]);
    expect(flags('op')).toEqual([false, false, false, true]);
  });
});

describe('renderInstructions: files and paths', () => {
  it.each(HARNESSES)('%s: one block in its instruction file and the three skills', harness => {
    const changes = changesFor(full(), harness);
    expect(changes.filter(c => c.kind === 'md-block').map(c => c.path)).toEqual([INSTRUCTION_FILE[harness]]);
    expect(files(changes).map(c => c.path)).toEqual(SKILLS.map(skill => `${SKILL_DIR[harness]}/${skill}/SKILL.md`));
    expect(changes).toHaveLength(4);
  });

  it.each(HARNESSES)('%s: every skill has a name matching its directory and a description', harness => {
    for (const change of files(changesFor(full(), harness))) {
      const { data, body } = parseFrontMatter(change.content);
      const dir = change.path.split('/').at(-2);
      expect(data.name).toBe(dir);
      expect(String(data.description).length).toBeGreaterThan(40);
      expect(body.trim().length).toBeGreaterThan(200);
      expect(Object.keys(data).sort()).toEqual(['description', 'name']);
    }
  });

  it('codex and agents-md render one identical AGENTS.md block and identical skills', () => {
    const cfg = full();
    const both = [...changesFor(cfg, 'codex'), ...changesFor(cfg, 'agents-md')];
    const byPath = new Map<string, Change[]>();
    for (const change of both) byPath.set(change.path, [...(byPath.get(change.path) ?? []), change]);
    const deduped = [...byPath.values()].map(group => {
      for (const other of group) expect(other).toEqual(group[0]);
      return group[0]!;
    });
    expect(deduped.filter(c => c.kind === 'md-block')).toHaveLength(1);
    expect(deduped.filter(c => c.kind === 'md-block' && c.path === 'AGENTS.md')).toHaveLength(1);
    expect(deduped).toHaveLength(4);
  });

  it('writes LF text with no template syntax left and nothing that could break the managed markers', () => {
    for (const cfg of [full(), minimal()]) {
      for (const harness of HARNESSES) {
        for (const change of changesFor(cfg, harness)) {
          const content = (change as { content: string }).content;
          expect(content).not.toMatch(/\{\{|\}\}/);
          expect(content).not.toContain('\r');
          expect(content).not.toContain('<!-- sdlc:');
          expect(content).not.toMatch(/undefined|\[object/);
        }
        expect(block(changesFor(cfg, harness)).content).not.toMatch(/\n$/);
      }
    }
  });
});

describe('the managed block', () => {
  it.each(HARNESSES)('%s: carries every prohibition (golden)', harness => {
    expectGolden(`instructions/${harness}`, changesFor(full(), harness));
  });

  it('minimal config (golden)', () => {
    expectGolden('instructions/minimal', changesFor(minimal(), 'claude'));
  });

  const PROHIBITIONS = [
    /--admin/,
    /rm -rf/,
    /worktree prune/,
    /push --force/,
    /production data/i,
    /another AI/i,
    /explicit confirmation/i,
    /Related to #/,
  ];

  it.each(HARNESSES)('%s: every prohibition is present, in a full and a minimal config', harness => {
    for (const cfg of [full(), minimal(), minimal('merge_policy: agent_on_request\n')]) {
      const text = blockText(cfg, harness);
      for (const prohibition of PROHIBITIONS) expect(text).toMatch(prohibition);
    }
  });

  it('is under 150 lines for the full config, also with the eleven roles listed', () => {
    const cfg = full();
    expect(blockText(cfg).split('\n').length).toBeLessThan(150);
    const roles = block(changesFor(cfg, 'agents-md', { ...renderData(cfg), roles: ROLES })).content;
    expect(roles).toMatch(/^### Roles$/m);
    for (const role of ROLES) expect(roles).toContain(`\`${role.role}\``);
    expect(roles.split('\n').length).toBeLessThan(150);
  });

  it('explains what it is, how to start work, and the phases of every enabled type', () => {
    const text = blockText(full());
    expect(text).toMatch(/sdlc task new/);
    expect(text).toMatch(/status question/i);
    expect(text).toMatch(/continuation/i);
    expect(text).toContain('npx -y agentic-sdlc-kit@1.2.3');
    for (const type of renderData(full()).types) {
      expect(text).toContain(`\`${type.id}\``);
      expect(text).toContain(type.phasesText);
    }
    expect(text).toMatch(/sdlc stage publish/);
    expect(text).toMatch(/\/approve/);
    expect(text).toMatch(/backup and dry-run/);
  });

  it('covers review, PR rules, the quality gate, worktrees and context survival', () => {
    const text = blockText(full());
    expect(text).toMatch(/task\/<issue>-<slug>/);
    expect(text).toMatch(/Scope: partial/);
    expect(text).toMatch(/`Targets:`/);
    expect(text).toMatch(/sdlc review handoff/);
    expect(text).toContain('`npm test`');
    expect(text).toContain('`npm run lint`');
    expect(text).toMatch(/\.worktrees\/<issue>-<slug>/);
    expect(text).toMatch(/origin\/main/);
    expect(text).toMatch(/git worktree remove/);
    expect(text).toMatch(/git branch -d/);
    expect(text).toMatch(/work index/i);
    expect(text).toMatch(/sdlc task checkpoint/);
  });

  it('shows the configured targets and how each deploys, only when there are targets', () => {
    const withTargets = blockText(full());
    expect(withTargets).toContain('`web`');
    expect(withTargets).toContain('`production-web`');
    expect(withTargets).toContain('.github/workflows/deploy-web.yml');
    expect(withTargets).toContain('`./scripts/deploy-api.sh`');
    expect(withTargets).toMatch(/sdlc deploy record/);

    const without = blockText(minimal());
    expect(without).not.toMatch(/Targets:/);
    expect(without).not.toMatch(/Deployment targets/);
  });

  it('lists the quality gate, or says there is none', () => {
    expect(blockText(full())).not.toMatch(/No quality gate/);
    expect(blockText(minimal())).toMatch(/No quality gate is configured/);
    expect(blockText(minimal())).not.toMatch(/npm test/);
  });

  it('keeps every optional section out of a minimal config', () => {
    const text = blockText(minimal());
    expect(text).not.toMatch(/Superpowers/i);
    expect(text).not.toMatch(/writing-plans|systematic-debugging|subagent-driven-development/);
    expect(text).not.toMatch(/graphify/i);
    expect(text).not.toMatch(/^### Production data/m);
    expect(text).not.toMatch(/sdlc evidence add/);
    // the sections every config has
    for (const heading of ['What this is', 'Starting work', 'Phases', 'Review and pull requests', 'Merge and deploy authority', 'Worktrees', 'Secrets', 'Context survival']) {
      expect(text).toMatch(new RegExp(`^### ${heading}`, 'm'));
    }
  });

  it('adds the Superpowers route, graphify and production-data sections when they apply', () => {
    const text = blockText(full());
    expect(text).toMatch(/^### Superpowers route$/m);
    for (const skill of ['brainstorming', 'writing-plans', 'systematic-debugging', 'subagent-driven-development', 'requesting-code-review', 'verification-before-completion']) {
      expect(text).toContain(`\`${skill}\``);
    }
    expect(text).toMatch(/^### graphify$/m);
    expect(text).toMatch(/graphify query/);
    expect(text).toMatch(/graphify update \./);
    expect(text).toMatch(/graphify-out\/.*not committed|never committed/);
    expect(text).toMatch(/^### Production data$/m);
    expect(text).toMatch(/sdlc evidence add <issue> --kind backup/);
    expect(text).toMatch(/--kind dry_run/);
    expect(text).toMatch(/owner runs it/i);
  });

  it('enables each optional section on its own switch', () => {
    const onlyGraphify = blockText(loadConfigFromString(MINIMAL.replace('graphify: false', 'graphify: true')));
    expect(onlyGraphify).toMatch(/^### graphify$/m);
    expect(onlyGraphify).not.toMatch(/^### Superpowers route$/m);
    expect(onlyGraphify).not.toMatch(/^### Production data$/m);
    const onlySuperpowers = blockText(loadConfigFromString(MINIMAL.replace('superpowers: false', 'superpowers: true')));
    expect(onlySuperpowers).toMatch(/^### Superpowers route$/m);
    expect(onlySuperpowers).not.toMatch(/graphify/i);
    expect(onlySuperpowers).not.toMatch(/^### Production data$/m);
    const onlyProductionData = blockText(loadConfigFromString(MINIMAL.replace('[tooling]', '[tooling, production-data]')));
    expect(onlyProductionData).toMatch(/^### Production data$/m);
    expect(onlyProductionData).toMatch(/sdlc evidence add <issue> --kind backup/);
    expect(onlyProductionData).not.toMatch(/^### Superpowers route$/m);
    expect(onlyProductionData).not.toMatch(/graphify/i);
  });

  it('lists the roles with their tier when there are roles, and not otherwise', () => {
    const cfg = full();
    expect(block(changesFor(cfg, 'agents-md', renderData(cfg, []))).content).not.toMatch(/^### Roles/m);
    const text = block(changesFor(cfg, 'agents-md', { ...renderData(cfg), roles: ROLES.slice(0, 2) })).content;
    expect(text).toMatch(/^### Roles$/m);
    expect(text).toContain('- `analyst` (standard): Does the analyst part of the work, and reports back in one line.');
    expect(text).toContain('- `architect` (standard)');
  });

  it('words merge authority by merge policy', () => {
    const ownerOnly = blockText(full());
    const onRequest = blockText(full('merge_policy: agent_on_request\n'));
    expect(ownerOnly).not.toBe(onRequest);
    expect(ownerOnly).toMatch(/Only the owner merges/);
    expect(onRequest).not.toMatch(/Only the owner merges/);
    expect(onRequest).toMatch(/only when the owner explicitly asks/i);
    expect(onRequest).toMatch(/--admin/);
  });

  it('words the mode: enforce blocks, observe only warns', () => {
    expect(blockText(full())).toMatch(/Mode: \*\*enforce\*\*/);
    expect(blockText(full())).not.toMatch(/observe/);
    expect(blockText(minimal())).toMatch(/Mode: \*\*observe\*\*/);
    expect(blockText(minimal())).not.toMatch(/Mode: \*\*enforce\*\*/);
  });

  it('names the content language', () => {
    expect(blockText(full())).toMatch(/Language[^\n]*`en`/);
    expect(blockText(loadConfigFromString(FULL.replace('content_language: en', 'content_language: sk')))).toMatch(
      /Language[^\n]*`sk`/,
    );
  });
});

describe('the Secrets section', () => {
  it.each(HARNESSES)('%s: is present, names the keystore and forbids --no-verify', harness => {
    for (const cfg of [full(), minimal()]) {
      const text = blockText(cfg, harness);
      expect(text).toMatch(/^### Secrets$/m);
      expect(text).toMatch(/keystore/i);
      expect(text).toMatch(/--no-verify/);
      expect(text).toMatch(/connection strings/);
      expect(text).toMatch(/gitignored/);
    }
  });

  it('shows the configured production store', () => {
    expect(blockText(full())).toContain('GitHub Actions environment secrets');
    const custom = blockText(full('secrets: { production_store: "Vault path secret/shop" }\n'));
    expect(custom).toContain('Vault path secret/shop');
    expect(custom).not.toContain('GitHub Actions environment secrets');
  });

  it('auto lists the macOS, Linux and Windows commands', () => {
    const text = blockText(full());
    expect(text).toContain('security find-generic-password -s <service> -w');
    expect(text).toContain('secret-tool lookup service <service>');
    expect(text).toContain('Get-Secret -Name <service> -Vault CredMan -AsPlainText');
  });

  it('keychain shows only the macOS command', () => {
    const text = blockText(full('secrets: { local_store: keychain }\n'));
    expect(text).toContain('security find-generic-password -s <service> -w');
    expect(text).not.toContain('secret-tool');
    expect(text).not.toContain('Get-Secret -Name <service> -Vault CredMan -AsPlainText');
  });

  it('secret-service shows only the Linux command and wincred only the Windows one', () => {
    const linux = blockText(full('secrets: { local_store: secret-service }\n'));
    expect(linux).toContain('secret-tool lookup service <service>');
    expect(linux).not.toContain('security find-generic-password');
    expect(linux).not.toContain('Get-Secret -Name <service> -Vault CredMan -AsPlainText');
    const windows = blockText(full('secrets: { local_store: wincred }\n'));
    expect(windows).toContain('Get-Secret -Name <service> -Vault CredMan -AsPlainText');
    expect(windows).not.toContain('security find-generic-password');
    expect(windows).not.toContain('secret-tool');
  });

  it('a password-manager CLI is named, with no OS keystore command', () => {
    const text = blockText(full('secrets: { local_store: op }\n'));
    expect(text).toContain('`op`');
    expect(text).not.toContain('security find-generic-password');
    expect(text).not.toContain('secret-tool');
    expect(text).not.toContain('Get-Secret -Name <service> -Vault CredMan -AsPlainText');
  });
});

describe('the skills', () => {
  const skill = (name: (typeof SKILLS)[number], cfg: Config = full(), harness: Harness = 'claude'): string =>
    files(changesFor(cfg, harness)).find(c => c.path.endsWith(`${name}/SKILL.md`))!.content;

  it('sdlc-task-tracking gives the exact commands', () => {
    const text = skill('sdlc-task-tracking');
    for (const command of [
      'sdlc task new --type',
      'sdlc task new --issue',
      'sdlc stage start',
      'sdlc stage publish',
      '--needs-approval',
      'sdlc approve <issue> approve',
      '--comment-url',
      'sdlc evidence add <issue> --kind backup',
      'sdlc review handoff <issue> --pr',
      'sdlc status',
      'sdlc reconcile',
      'sdlc task checkpoint',
      'sdlc task set-type',
    ]) {
      expect(text).toContain(command);
    }
    expect(text).toMatch(/never paste logs/i);
    expect(text).toContain('npx -y agentic-sdlc-kit@1.2.3');
    expect(text).toContain('`shop-owner`');
    expect(text).toContain('`shop-lead`');
  });

  it('sdlc-delivery walks review, merge, deploy, record, reconcile and Done', () => {
    const text = skill('sdlc-delivery');
    for (const part of [
      'sdlc review handoff',
      'sdlc deploy record --target',
      '--sha',
      '--verify',
      'sdlc reconcile',
      'Scope: partial',
      'Scope: final',
      'cancel',
      'explicit confirmation',
      'Done',
    ]) {
      expect(text).toContain(part);
    }
    expect(text).toContain('`web`');
    expect(text).toContain('.github/workflows/deploy-web.yml');
    expect(text).toMatch(/Only the owner merges/);
    expect(skill('sdlc-delivery', full('merge_policy: agent_on_request\n'))).not.toMatch(/Only the owner merges/);
  });

  it('sdlc-delivery has no deploy section without targets', () => {
    const text = skill('sdlc-delivery', minimal());
    expect(text).not.toMatch(/sdlc deploy record/);
    expect(text).not.toMatch(/Deployment targets/);
  });

  it('sdlc-orientation is a template with marked placeholders', () => {
    const text = skill('sdlc-orientation');
    expect(text.match(/\[FILL IN:/g)!.length).toBeGreaterThanOrEqual(5);
    for (const heading of ['Purpose', 'Architecture map', 'Commands', 'Gotchas']) {
      expect(text).toMatch(new RegExp(`^## ${heading}`, 'm'));
    }
    expect(text).toContain('`npm test`');
    expect(text).toContain('`main`');
  });

  it('the skills are the same for every harness except where they live', () => {
    const cfg = full();
    const strip = (harness: Harness) => files(changesFor(cfg, harness)).map(c => c.content);
    expect(strip('claude')).toEqual(strip('gemini'));
    expect(strip('codex')).toEqual(strip('agents-md'));
    expect(strip('claude')).toEqual(strip('codex'));
  });
});

/** Every `sdlc ...` command the generated text shows must exist, with the options it uses. */
describe('the commands the text shows exist', () => {
  const program = buildProgram();

  /** The `sdlc ...` spans in `text`: inline code and the lines of fenced blocks. */
  function spans(text: string): string[] {
    const found: string[] = [];
    let fenced = false;
    for (const line of text.split('\n')) {
      if (line.trimStart().startsWith('```')) {
        fenced = !fenced;
        continue;
      }
      if (fenced) {
        const code = line.replace(/\s+#.*$/, '').trim();
        if (code.startsWith('sdlc ')) found.push(code);
        continue;
      }
      for (const match of line.matchAll(/`([^`]+)`/g)) {
        if (match[1]!.startsWith('sdlc ')) found.push(match[1]!);
      }
    }
    return found;
  }

  /** Words outside double quotes. */
  function words(span: string): string[] {
    const out: string[] = [];
    let quoted = false;
    let current = '';
    for (const ch of span) {
      if (ch === '"') {
        quoted = !quoted;
        current += ch;
      } else if (!quoted && /\s/.test(ch)) {
        if (current) out.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current) out.push(current);
    return out.filter(w => !w.startsWith('"'));
  }

  const longFlags = (command: Command): string[] => command.options.map(o => o.long ?? '');

  function check(span: string): string[] {
    const problems: string[] = [];
    const [, ...rest] = words(span);
    let command: Command = program;
    let i = 0;
    while (i < rest.length) {
      const next = command.commands.find(c => c.name() === rest[i]);
      if (!next) break;
      command = next;
      i++;
    }
    if (command === program) return [`"${span}": not a command`];
    if (command.commands.length > 0) problems.push(`"${span}": needs a subcommand`);
    for (const word of rest.slice(i)) {
      if (!word.startsWith('--')) continue;
      const flag = word.replace(/=.*$/, '');
      if (!longFlags(command).includes(flag) && !longFlags(program).includes(flag)) {
        problems.push(`"${span}": ${command.name()} has no ${flag}`);
      }
    }
    return problems;
  }

  it('finds the spans it is meant to check', () => {
    expect(spans('Run `sdlc task new --type x` now.\n```\nsdlc status   # read-only\n```\n')).toEqual([
      'sdlc task new --type x',
      'sdlc status',
    ]);
    expect(check('sdlc task new --type x --title "a --b"')).toEqual([]);
    expect(check('sdlc task nope')).not.toEqual([]);
    expect(check('sdlc task new --nope')).not.toEqual([]);
    expect(check('sdlc task')).not.toEqual([]);
  });

  it.each(HARNESSES)('%s: block and skills only use real commands and options', harness => {
    const cfg = full();
    const data = { ...renderData(cfg), roles: ROLES.slice(0, 1) };
    const problems: string[] = [];
    let checked = 0;
    for (const change of changesFor(cfg, harness, data)) {
      for (const span of spans((change as { content: string }).content)) {
        checked++;
        problems.push(...check(span));
      }
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(30);
  });
});
