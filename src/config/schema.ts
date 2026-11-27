import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { buildTypeRegistry, ConfigError } from '../core/taskTypes.js';
import type { EndsOn, EvidenceKind, Phase, TaskTypeDef } from '../core/types.js';

/** Type-level guard: resolves to `never` unless `V` lists every member of the union `T`. */
type Exhaustive<T extends string, V extends readonly T[]> = Exclude<T, V[number]> extends never
  ? V
  : never;

const PHASES = [
  'intake',
  'debugging',
  'brainstorming',
  'analysis',
  'exploration',
  'creation',
  'planning',
  'implementation',
  'verification',
  'review',
  'delivery',
] as const;
const ENDS_ON = [
  'deploy',
  'merge',
  'owner_acceptance',
  'owner_confirmation',
  'merge_or_acceptance',
] as const;
const EVIDENCE_KINDS = ['backup', 'dry_run'] as const;
const HARNESSES = ['claude', 'codex', 'gemini', 'agents-md'] as const;
const DEPLOY_VIA = ['script', 'actions', 'manual', 'release'] as const;

export type Harness = (typeof HARNESSES)[number];

/** Lowercase kebab-case: safe inside `type:<id>` labels and comma-separated `Targets:` lists. */
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const nonEmpty = z.string().min(1);

const CustomTypeSchema = z
  .strictObject({
    id: z.string().regex(SLUG, 'must be lowercase kebab-case (letters, digits, hyphens)'),
    label: nonEmpty,
    phases: z.array(z.enum(PHASES satisfies Exhaustive<Phase, typeof PHASES>)).min(1),
    ends_on: z.enum(ENDS_ON satisfies Exhaustive<EndsOn, typeof ENDS_ON>),
    requires_before_review: z
      .array(z.enum(EVIDENCE_KINDS satisfies Exhaustive<EvidenceKind, typeof EVIDENCE_KINDS>))
      .default([]),
    targets_required: z.boolean().default(false),
  })
  .transform(
    (t): TaskTypeDef => ({
      id: t.id,
      label: t.label,
      phases: t.phases,
      endsOn: t.ends_on,
      requiresBeforeReview: t.requires_before_review,
      targetsRequired: t.targets_required,
    }),
  );

const RawTargetSchema = z.strictObject({
  name: z.string().regex(SLUG, 'must be lowercase kebab-case (letters, digits, hyphens)'),
  environment: nonEmpty.optional(),
  deploy: z.strictObject({
    via: z.enum(DEPLOY_VIA),
    command: nonEmpty.optional(),
    workflow: nonEmpty.optional(),
  }),
  paths: z.array(nonEmpty).default([]),
});

const ModelTiersSchema = z.strictObject({ deep: nonEmpty, standard: nonEmpty, fast: nonEmpty });

export interface TargetConfig {
  name: string;
  environment: string;
  deploy: { via: (typeof DEPLOY_VIA)[number]; command?: string; workflow?: string };
  paths: string[];
}

const RawConfigSchema = z
  .strictObject({
    version: z.literal(1),
    harnesses: z.array(z.enum(HARNESSES)),
    mode: z.enum(['observe', 'enforce']),
    github: z.strictObject({
      repo: z.string().regex(REPO_SLUG, 'must be "owner/name"'),
      default_branch: nonEmpty,
      project: z.strictObject({
        owner: nonEmpty,
        owner_type: z.enum(['org', 'user']),
        number: z.number().int().positive().optional(),
      }),
    }),
    owners: z.array(nonEmpty).min(1),
    content_language: nonEmpty.default('en'),
    merge_policy: z.enum(['owner_only', 'agent_on_request']).default('owner_only'),
    quality_gate: z.array(nonEmpty).default([]),
    task_types: z.strictObject({
      enabled: z.array(nonEmpty),
      custom: z.array(CustomTypeSchema).default([]),
    }),
    targets: z.array(RawTargetSchema).default([]),
    models: z.partialRecord(z.enum(HARNESSES), ModelTiersSchema).default({}),
    stack: z
      .strictObject({
        superpowers: z.boolean().default(true),
        graphify: z.boolean().default(true),
        branch_protection: z.boolean().default(true),
        actions: z.boolean().default(true),
      })
      .prefault({}),
  })
  .superRefine((cfg, ctx) => {
    const environments = resolveEnvironments(cfg.targets);

    const namesSeen = new Set<string>();
    const envFirstIndex = new Map<string, number>();
    cfg.targets.forEach((target, i) => {
      if (namesSeen.has(target.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['targets', i, 'name'],
          message: `duplicate target name "${target.name}"`,
        });
      }
      namesSeen.add(target.name);

      const env = environments[i];
      const first = envFirstIndex.get(env);
      if (first === undefined) {
        envFirstIndex.set(env, i);
      } else {
        ctx.addIssue({
          code: 'custom',
          path: ['targets', i, 'environment'],
          message: `each target needs a unique environment; "${env}" is already used by targets[${first}]`,
        });
      }
    });

    let registry: Map<string, TaskTypeDef>;
    try {
      registry = buildTypeRegistry(cfg.task_types.enabled, cfg.task_types.custom);
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      ctx.addIssue({ code: 'custom', path: ['task_types'], message: err.message });
      return;
    }

    if (cfg.targets.length === 0) {
      for (const def of registry.values()) {
        if (def.endsOn === 'deploy') {
          ctx.addIssue({
            code: 'custom',
            path: ['targets'],
            message: `task type "${def.id}" ends on deploy and requires at least one target (add a target or disable the type)`,
          });
        }
      }
    }
  });

/** One target keeps `production`; several each get `production-<name>` unless set explicitly. */
function resolveEnvironments(targets: ReadonlyArray<{ name: string; environment?: string }>): string[] {
  return targets.map(t =>
    t.environment ?? (targets.length === 1 ? 'production' : `production-${t.name}`),
  );
}

export const ConfigSchema = RawConfigSchema.transform(raw => {
  const environments = resolveEnvironments(raw.targets);
  const targets: TargetConfig[] = raw.targets.map((t, i) => ({
    name: t.name,
    environment: environments[i],
    deploy: t.deploy,
    paths: t.paths,
  }));
  return {
    version: raw.version,
    harnesses: raw.harnesses,
    mode: raw.mode,
    github: {
      repo: raw.github.repo,
      defaultBranch: raw.github.default_branch,
      project: {
        owner: raw.github.project.owner,
        ownerType: raw.github.project.owner_type,
        number: raw.github.project.number,
      },
    },
    owners: raw.owners,
    contentLanguage: raw.content_language,
    mergePolicy: raw.merge_policy,
    qualityGate: raw.quality_gate,
    taskTypes: { enabled: raw.task_types.enabled, custom: raw.task_types.custom },
    targets,
    models: raw.models,
    stack: {
      superpowers: raw.stack.superpowers,
      graphify: raw.stack.graphify,
      branchProtection: raw.stack.branch_protection,
      actions: raw.stack.actions,
    },
  };
});

export type Config = z.output<typeof ConfigSchema>;

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return '(root)';
  return path.reduce<string>(
    (acc, seg) =>
      typeof seg === 'number' ? `${acc}[${seg}]` : acc ? `${acc}.${String(seg)}` : String(seg),
    '',
  );
}

/** Parses and validates `sdlc.config.yaml` text. Throws ConfigError listing every issue path. */
export function parseConfig(text: string): Config {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`Invalid config: YAML syntax error: ${(err as Error).message}`);
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(i => `  - ${formatPath(i.path)}: ${i.message}`);
    throw new ConfigError(`Invalid config:\n${lines.join('\n')}`);
  }
  return result.data;
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read config file ${path}: ${(err as Error).message}`);
  }
  return parseConfig(text);
}

/** Registry of enabled built-in types plus all custom types. */
export function typeRegistry(cfg: Config): Map<string, TaskTypeDef> {
  return buildTypeRegistry(cfg.taskTypes.enabled, cfg.taskTypes.custom);
}

export function targetByName(cfg: Config, name: string): TargetConfig {
  const target = cfg.targets.find(t => t.name === name);
  if (!target) {
    const known = cfg.targets.map(t => t.name).join(', ') || '(none)';
    throw new ConfigError(`Unknown target "${name}" (configured targets: ${known})`);
  }
  return target;
}
