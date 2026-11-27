import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  loadConfig,
  parseConfig,
  targetByName,
  typeRegistry,
} from '../../src/config/schema.js';
import { ConfigError } from '../../src/core/taskTypes.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/config/valid.yaml');

const HEADER = `
version: 1
harnesses: [claude]
mode: enforce
github:
  repo: acme/shop
  default_branch: main
  project: { owner: acme, owner_type: org }
owners: [shop-owner]
`;

/** Builds a minimal valid config text, overriding the task_types/targets sections. */
function config(sections: { taskTypes?: string; targets?: string; header?: string } = {}): string {
  return [
    sections.header ?? HEADER,
    sections.taskTypes ?? 'task_types:\n  enabled: [tooling]\n',
    sections.targets ?? '',
  ].join('\n');
}

const messageOf = (text: string): string => {
  try {
    parseConfig(text);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).message;
  }
  throw new Error('expected parseConfig to throw');
};

describe('parseConfig / loadConfig', () => {
  it('parses the valid fixture', () => {
    const cfg = loadConfig(FIXTURE);
    expect(cfg.github.repo).toBe('acme/shop');
    expect(cfg.github.defaultBranch).toBe('main');
    expect(cfg.github.project).toEqual({ owner: 'acme', ownerType: 'org', number: 7 });
    expect(cfg.mergePolicy).toBe('owner_only');
    expect(cfg.contentLanguage).toBe('en');
    expect(cfg.qualityGate).toEqual(['npm test']);
    expect(cfg.targets[0].environment).toBe('production-web');
    expect(cfg.targets[1].environment).toBe('production-api');
    expect(cfg.targets[1].deploy).toEqual({ via: 'script', command: './scripts/deploy-api.sh' });
    expect(cfg.stack).toEqual({
      superpowers: true,
      graphify: true,
      branchProtection: true,
      actions: false,
    });
    expect(cfg.models.claude).toEqual({ deep: 'opus', standard: 'sonnet', fast: 'haiku' });
  });

  it('maps custom types from snake_case YAML to TaskTypeDef', () => {
    const cfg = loadConfig(FIXTURE);
    expect(cfg.taskTypes.custom).toEqual([
      {
        id: 'infra-change',
        label: 'Infra change',
        phases: ['intake', 'brainstorming', 'planning', 'implementation', 'review', 'delivery'],
        endsOn: 'deploy',
        requiresBeforeReview: ['backup'],
        targetsRequired: true,
      },
    ]);
  });

  it('applies defaults for optional fields', () => {
    const cfg = parseConfig(config());
    expect(cfg.contentLanguage).toBe('en');
    expect(cfg.mergePolicy).toBe('owner_only');
    expect(cfg.qualityGate).toEqual([]);
    expect(cfg.targets).toEqual([]);
    expect(cfg.models).toEqual({});
    expect(cfg.taskTypes.custom).toEqual([]);
    expect(cfg.github.project.number).toBeUndefined();
    expect(cfg.stack).toEqual({
      superpowers: true,
      graphify: true,
      branchProtection: true,
      actions: true,
    });
  });

  it('defaults custom type fields: requires_before_review to [] and targets_required to false', () => {
    const cfg = parseConfig(
      config({
        taskTypes: `task_types:
  enabled: []
  custom:
    - { id: runbook, label: Runbook, phases: [intake, delivery], ends_on: merge }
`,
      }),
    );
    expect(cfg.taskTypes.custom[0]).toEqual({
      id: 'runbook',
      label: 'Runbook',
      phases: ['intake', 'delivery'],
      endsOn: 'merge',
      requiresBeforeReview: [],
      targetsRequired: false,
    });
  });

  it('defaults environment to production for a single target and production-<name> for several', () => {
    const single = parseConfig(
      config({
        targets: `targets:
  - { name: web, deploy: { via: manual } }
`,
      }),
    );
    expect(single.targets.map(t => t.environment)).toEqual(['production']);

    const several = parseConfig(
      config({
        targets: `targets:
  - { name: web, deploy: { via: manual } }
  - { name: api, deploy: { via: release } }
`,
      }),
    );
    expect(several.targets.map(t => t.environment)).toEqual(['production-web', 'production-api']);
    expect(several.targets.map(t => t.paths)).toEqual([[], []]);
  });

  it('refuses two targets sharing an environment', () => {
    const msg = messageOf(
      config({
        targets: `targets:
  - { name: web, environment: production, deploy: { via: manual } }
  - { name: api, environment: production, deploy: { via: manual } }
`,
      }),
    );
    expect(msg).toContain('unique environment');
    expect(msg).toContain('targets[1].environment');
  });

  it('refuses a defaulted environment that collides with an explicit one', () => {
    const msg = messageOf(
      config({
        targets: `targets:
  - { name: api, environment: production-web, deploy: { via: manual } }
  - { name: web, deploy: { via: manual } }
`,
      }),
    );
    expect(msg).toContain('unique environment');
  });

  it('refuses duplicate target names', () => {
    const msg = messageOf(
      config({
        targets: `targets:
  - { name: web, environment: production-a, deploy: { via: manual } }
  - { name: web, environment: production-b, deploy: { via: manual } }
`,
      }),
    );
    expect(msg).toContain('duplicate target name "web"');
  });

  it('refuses deploy-ending types enabled with no targets', () => {
    const msg = messageOf(
      config({ taskTypes: 'task_types:\n  enabled: [feature]\n', targets: 'targets: []\n' }),
    );
    expect(msg).toContain('requires at least one target');
    expect(msg).toContain('feature');
  });

  it('refuses a custom deploy-ending type with no targets', () => {
    const msg = messageOf(
      config({
        taskTypes: `task_types:
  enabled: []
  custom:
    - { id: infra-change, label: Infra change, phases: [intake, delivery], ends_on: deploy }
`,
      }),
    );
    expect(msg).toContain('requires at least one target');
    expect(msg).toContain('infra-change');
  });

  it('accepts deploy-ending types once a target exists', () => {
    const cfg = parseConfig(
      config({
        taskTypes: 'task_types:\n  enabled: [feature, bugfix]\n',
        targets: 'targets:\n  - { name: web, deploy: { via: manual } }\n',
      }),
    );
    expect(cfg.targets).toHaveLength(1);
  });

  it('refuses invalid repo slug and empty owners', () => {
    const badRepo = HEADER.replace('acme/shop', 'not-a-slug');
    expect(() => parseConfig(config({ header: badRepo }))).toThrow(ConfigError);
    expect(messageOf(config({ header: badRepo }))).toContain('github.repo');

    const noOwners = HEADER.replace('owners: [shop-owner]', 'owners: []');
    expect(() => parseConfig(config({ header: noOwners }))).toThrow(ConfigError);
    expect(messageOf(config({ header: noOwners }))).toContain('owners');
  });

  it('lists every issue path in a single ConfigError', () => {
    const header = HEADER.replace('acme/shop', 'nope').replace('owners: [shop-owner]', 'owners: []');
    const msg = messageOf(header + 'task_types:\n  enabled: [tooling]\n');
    expect(msg).toContain('github.repo');
    expect(msg).toContain('owners');
  });

  it('refuses unknown enabled type ids', () => {
    const msg = messageOf(config({ taskTypes: 'task_types:\n  enabled: [feature, hotfix]\n' }));
    expect(msg).toContain('task_types');
    expect(msg).toContain('hotfix');
  });

  it('refuses a custom type that shadows a built-in', () => {
    const msg = messageOf(
      config({
        taskTypes: `task_types:
  enabled: []
  custom:
    - { id: feature, label: Feature, phases: [intake], ends_on: merge }
`,
      }),
    );
    expect(msg).toContain('collides with a built-in');
  });

  it('refuses duplicate custom type ids', () => {
    const msg = messageOf(
      config({
        taskTypes: `task_types:
  enabled: []
  custom:
    - { id: runbook, label: Runbook, phases: [intake], ends_on: merge }
    - { id: runbook, label: Runbook 2, phases: [intake], ends_on: merge }
`,
      }),
    );
    expect(msg).toContain('duplicate custom task type id "runbook"');
  });

  it('requires phases and label on custom types', () => {
    const noPhases = messageOf(
      config({
        taskTypes: `task_types:
  enabled: []
  custom:
    - { id: runbook, label: Runbook, ends_on: merge }
`,
      }),
    );
    expect(noPhases).toContain('task_types.custom[0].phases');

    const noLabel = messageOf(
      config({
        taskTypes: `task_types:
  enabled: []
  custom:
    - { id: runbook, phases: [intake], ends_on: merge }
`,
      }),
    );
    expect(noLabel).toContain('task_types.custom[0].label');
  });

  it('rejects unknown keys and bad enum values', () => {
    expect(messageOf(config({ header: HEADER + 'merge_polcy: owner_only\n' }))).toContain(
      'merge_polcy',
    );
    expect(messageOf(config({ header: HEADER.replace('enforce', 'strict') }))).toContain('mode');
    expect(
      messageOf(config({ header: HEADER + 'merge_policy: anyone\n' })),
    ).toContain('merge_policy');
  });

  it('wraps YAML syntax errors in ConfigError', () => {
    expect(() => parseConfig('version: [1')).toThrow(ConfigError);
    expect(() => parseConfig('')).toThrow(ConfigError);
  });
});

describe('loadConfig', () => {
  it('wraps a missing file in ConfigError naming the path', () => {
    expect(() => loadConfig('/nonexistent/sdlc.config.yaml')).toThrow(ConfigError);
    expect(() => loadConfig('/nonexistent/sdlc.config.yaml')).toThrow('/nonexistent/sdlc.config.yaml');
  });
});

describe('typeRegistry', () => {
  it('combines enabled built-ins with custom types', () => {
    const reg = typeRegistry(loadConfig(FIXTURE));
    expect([...reg.keys()]).toEqual([
      'feature',
      'bugfix',
      'tooling',
      'analysis',
      'production-data',
      'artifact',
      'spike',
      'infra-change',
    ]);
    expect(reg.get('infra-change')?.endsOn).toBe('deploy');
  });
});

describe('targetByName', () => {
  it('returns the named target', () => {
    const cfg = loadConfig(FIXTURE);
    expect(targetByName(cfg, 'api').environment).toBe('production-api');
  });

  it('throws ConfigError listing configured targets for an unknown name', () => {
    const cfg = loadConfig(FIXTURE);
    expect(() => targetByName(cfg, 'mobile')).toThrow(ConfigError);
    expect(() => targetByName(cfg, 'mobile')).toThrow('web, api');
  });
});
