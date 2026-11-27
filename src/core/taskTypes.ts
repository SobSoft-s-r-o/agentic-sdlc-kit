import type { Phase, TaskTypeDef } from './types.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const FULL_LIFECYCLE: readonly Phase[] = [
  'intake',
  'brainstorming',
  'planning',
  'implementation',
  'verification',
  'review',
  'delivery',
];

const fullLifecycle = (): Phase[] => [...FULL_LIFECYCLE];

export const BUILTIN_TYPES: readonly TaskTypeDef[] = [
  {
    id: 'feature',
    label: 'Feature',
    phases: fullLifecycle(),
    endsOn: 'deploy',
    requiresBeforeReview: [],
    targetsRequired: true,
  },
  {
    id: 'bugfix',
    label: 'Bug fix',
    phases: fullLifecycle().map(p => (p === 'brainstorming' ? 'debugging' : p)),
    endsOn: 'deploy',
    requiresBeforeReview: [],
    targetsRequired: true,
  },
  {
    id: 'tooling',
    label: 'Tooling',
    phases: fullLifecycle(),
    endsOn: 'merge',
    requiresBeforeReview: [],
    targetsRequired: false,
  },
  {
    id: 'analysis',
    label: 'Analysis',
    phases: ['intake', 'analysis', 'delivery'],
    endsOn: 'owner_acceptance',
    requiresBeforeReview: [],
    targetsRequired: false,
  },
  {
    id: 'production-data',
    label: 'Production data',
    phases: fullLifecycle(),
    endsOn: 'owner_confirmation',
    requiresBeforeReview: ['backup', 'dry_run'],
    targetsRequired: false,
  },
  {
    id: 'artifact',
    label: 'Artifact',
    phases: ['intake', 'brainstorming', 'creation', 'review', 'delivery'],
    endsOn: 'merge_or_acceptance',
    requiresBeforeReview: [],
    targetsRequired: false,
  },
  {
    id: 'spike',
    label: 'Spike',
    phases: ['intake', 'exploration', 'delivery'],
    endsOn: 'owner_acceptance',
    requiresBeforeReview: [],
    targetsRequired: false,
  },
];

/**
 * Builds the task type registry from the enabled built-in ids plus all custom types.
 * Throws ConfigError if an enabled id is not a built-in or is listed twice, a custom id shadows
 * a built-in, or two custom types share an id.
 */
export function buildTypeRegistry(
  enabled: string[],
  custom: TaskTypeDef[],
): Map<string, TaskTypeDef> {
  const builtins = new Map(BUILTIN_TYPES.map(t => [t.id, t]));
  const problems: string[] = [];
  const registry = new Map<string, TaskTypeDef>();

  const seenEnabled = new Set<string>();
  for (const id of enabled) {
    if (seenEnabled.has(id)) {
      problems.push(`duplicate enabled task type id "${id}"`);
      continue;
    }
    seenEnabled.add(id);
    const def = builtins.get(id);
    if (def) {
      registry.set(id, def);
    } else {
      problems.push(
        `unknown task type "${id}" in enabled list (built-in types: ${[...builtins.keys()].join(', ')})`,
      );
    }
  }

  const seenCustom = new Set<string>();
  for (const def of custom) {
    if (builtins.has(def.id)) {
      problems.push(`custom task type "${def.id}" collides with a built-in type`);
    } else if (seenCustom.has(def.id)) {
      problems.push(`duplicate custom task type id "${def.id}"`);
    } else {
      seenCustom.add(def.id);
      registry.set(def.id, def);
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(`Invalid task types: ${problems.join('; ')}`);
  }
  return registry;
}
