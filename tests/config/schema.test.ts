import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ConfigValidationError,
  loadConfig,
  loadConfigFromString,
  parseConfig,
  setMcpIdValidator,
  targetByName,
  typeRegistry,
} from '../../src/config/schema.js';
import { ConfigError } from '../../src/core/taskTypes.js';

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8')) as {
    version: string;
  }
).version;

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

  it('refuses target names that are not lowercase kebab-case', () => {
    for (const name of ['Web', 'web_app', 'web app', '-web']) {
      const msg = messageOf(
        config({ targets: `targets:\n  - { name: "${name}", deploy: { via: manual } }\n` }),
      );
      expect(msg).toContain('targets[0].name');
      expect(msg).toContain('lowercase kebab-case');
    }
  });

  it('refuses custom type ids that are not lowercase kebab-case', () => {
    for (const id of ['Infra', 'infra_change', 'infra change']) {
      const msg = messageOf(
        config({
          taskTypes: `task_types:
  enabled: []
  custom:
    - { id: "${id}", label: Infra, phases: [intake], ends_on: merge }
`,
        }),
      );
      expect(msg).toContain('task_types.custom[0].id');
      expect(msg).toContain('lowercase kebab-case');
    }
  });

  it('refuses any version other than 1', () => {
    const msg = messageOf(config({ header: HEADER.replace('version: 1', 'version: 2') }));
    expect(msg).toContain('version');
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

  it('refuses a custom type that requires targets when no target is configured', () => {
    const msg = messageOf(
      config({
        taskTypes: `task_types:
  enabled: []
  custom:
    - { id: rollout, label: Rollout, phases: [intake, delivery], ends_on: merge, targets_required: true }
`,
      }),
    );
    expect(msg).toContain('requires at least one target');
    expect(msg).toContain('rollout');
  });

  it('accepts a custom targets_required type once a target exists', () => {
    const cfg = parseConfig(
      config({
        taskTypes: `task_types:
  enabled: []
  custom:
    - { id: rollout, label: Rollout, phases: [intake, delivery], ends_on: merge, targets_required: true }
`,
        targets: 'targets:\n  - { name: web, deploy: { via: manual } }\n',
      }),
    );
    expect(cfg.taskTypes.custom[0].targetsRequired).toBe(true);
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

  it('defaults agents to an empty list and reads agent logins', () => {
    expect(parseConfig(config()).agents).toEqual([]);
    const header = HEADER.replace('owners: [shop-owner]', 'owners: [shop-owner]\nagents: [agent-bot, \"deploy-app[bot]\"]');
    expect(parseConfig(config({ header })).agents).toEqual(['agent-bot', 'deploy-app[bot]']);
  });

  it('refuses a login listed both as owner and as agent, in any letter case', () => {
    const header = HEADER.replace('owners: [shop-owner]', 'owners: [shop-owner]\nagents: [Shop-Owner]');
    expect(messageOf(config({ header }))).toContain(
      'agents[0]: "Shop-Owner" is also listed under owners; a login is either an owner or an agent',
    );
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

  it('refuses duplicate enabled type ids', () => {
    const msg = messageOf(config({ taskTypes: 'task_types:\n  enabled: [tooling, spike, tooling]\n' }));
    expect(msg).toContain('duplicate enabled task type id "tooling"');
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

/** A minimal valid config whose header is extended with extra top-level sections. */
const withSections = (sections: string): string => config({ header: `${HEADER}${sections}` });

describe('mcp section', () => {
  it('defaults to the github server, project scope and the remote transport', () => {
    expect(parseConfig(config()).mcp).toEqual({
      servers: ['github'],
      scope: 'project',
      githubTransport: 'remote',
    });
  });

  it('maps snake_case YAML to camelCase', () => {
    const cfg = parseConfig(
      withSections('mcp:\n  servers: [github, context7]\n  scope: user\n  github_transport: local\n'),
    );
    expect(cfg.mcp).toEqual({ servers: ['github', 'context7'], scope: 'user', githubTransport: 'local' });
  });

  it('accepts a partial section and fills the rest', () => {
    expect(parseConfig(withSections('mcp:\n  scope: user\n')).mcp).toEqual({
      servers: ['github'],
      scope: 'user',
      githubTransport: 'remote',
    });
  });

  it('refuses an unknown server id, naming the catalog ids', () => {
    const message = messageOf(withSections('mcp:\n  servers: [nope]\n'));
    expect(message).toContain('mcp.servers');
    expect(message).toContain('nope');
    expect(message).toContain('github, context7, playwright');
  });

  it('refuses a bad scope or transport and unknown keys', () => {
    expect(messageOf(withSections('mcp:\n  scope: global\n'))).toContain('mcp.scope');
    expect(messageOf(withSections('mcp:\n  github_transport: ssh\n'))).toContain('mcp.github_transport');
    expect(messageOf(withSections('mcp:\n  extra: 1\n'))).toContain('mcp');
  });

  it('asks an injected validator, so the catalog can replace the built-in list', () => {
    const restore = setMcpIdValidator(ids => ids.map(id => `custom check rejects ${id}`));
    try {
      expect(messageOf(withSections('mcp:\n  servers: [github]\n'))).toContain('custom check rejects github');
    } finally {
      restore();
    }
    expect(parseConfig(withSections('mcp:\n  servers: [github]\n')).mcp.servers).toEqual(['github']);
  });
});

describe('kit_ref', () => {
  it('defaults to v<package version>', () => {
    expect(parseConfig(config()).kitRef).toBe(`v${PACKAGE_VERSION}`);
  });

  it('can be set to a tag or branch', () => {
    expect(parseConfig(withSections('kit_ref: main\n')).kitRef).toBe('main');
    expect(parseConfig(withSections('kit_ref: feat/plan-2\n')).kitRef).toBe('feat/plan-2');
  });

  it('refuses a value that is not a plain git ref name', () => {
    expect(messageOf(withSections('kit_ref: "main; rm -rf ."\n'))).toContain('kit_ref');
    expect(messageOf(withSections('kit_ref: ""\n'))).toContain('kit_ref');
  });
});

describe('reconcile section', () => {
  it('defaults closed_lookback_days to 30', () => {
    expect(parseConfig(config()).reconcile).toEqual({ closedLookbackDays: 30 });
  });

  it('reads closed_lookback_days', () => {
    expect(parseConfig(withSections('reconcile: { closed_lookback_days: 7 }\n')).reconcile).toEqual({
      closedLookbackDays: 7,
    });
  });

  it('refuses zero, negative and fractional values', () => {
    for (const bad of ['0', '-3', '1.5']) {
      expect(messageOf(withSections(`reconcile: { closed_lookback_days: ${bad} }\n`))).toContain(
        'reconcile.closed_lookback_days',
      );
    }
  });
});

describe('secrets section', () => {
  it('has defaults', () => {
    expect(parseConfig(config()).secrets).toEqual({
      localStore: 'auto',
      productionStore: 'GitHub Actions environment secrets',
      allow: [],
    });
  });

  it('maps snake_case YAML to camelCase; any other local store is a password-manager CLI name', () => {
    const cfg = parseConfig(
      withSections(
        'secrets:\n  local_store: op\n  production_store: GCP Secret Manager\n  allow: ["0123456789abcdef"]\n',
      ),
    );
    expect(cfg.secrets).toEqual({
      localStore: 'op',
      productionStore: 'GCP Secret Manager',
      allow: ['0123456789abcdef'],
    });
  });

  it('refuses an allow entry that is not a 16-character hex fingerprint', () => {
    for (const bad of ['xyz', '0123456789ABCDEF', '0123456789abcde', '0123456789abcdef0']) {
      const message = messageOf(withSections(`secrets:\n  allow: ["${bad}"]\n`));
      expect(message).toContain('secrets.allow[0]');
      expect(message).toContain('16');
      expect(message).toContain('hex');
    }
  });

  it('refuses an empty store name', () => {
    expect(messageOf(withSections('secrets:\n  local_store: ""\n'))).toContain('secrets.local_store');
  });
});

describe('loadConfigFromString', () => {
  it('parses config text like parseConfig', () => {
    const text = config();
    expect(loadConfigFromString(text)).toEqual(parseConfig(text));
  });

  it('throws a ConfigValidationError carrying one entry per issue', () => {
    try {
      loadConfigFromString(withSections('reconcile: { closed_lookback_days: 0 }\nsecrets: { allow: [xyz] }\n'));
      throw new Error('expected loadConfigFromString to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigValidationError).issues.map(i => i.path)).toEqual([
        'reconcile.closed_lookback_days',
        'secrets.allow[0]',
      ]);
    }
  });

  it('reports a YAML syntax error as one root issue', () => {
    try {
      loadConfigFromString('a: [unclosed');
      throw new Error('expected loadConfigFromString to throw');
    } catch (err) {
      expect((err as ConfigValidationError).issues).toEqual([
        { path: '(root)', message: expect.stringContaining('YAML syntax error') },
      ]);
    }
  });
});
