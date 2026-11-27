import { describe, expect, it } from 'vitest';
import { BUILTIN_TYPES, ConfigError, buildTypeRegistry } from '../../src/core/taskTypes.js';
import type { TaskTypeDef } from '../../src/core/types.js';

const infraChange: TaskTypeDef = {
  id: 'infra-change',
  label: 'Infra change',
  phases: ['intake', 'brainstorming', 'planning', 'implementation', 'review', 'delivery'],
  endsOn: 'deploy',
  requiresBeforeReview: ['backup'],
  targetsRequired: true,
};

describe('built-in task types', () => {
  it('defines the seven built-in types with spec end conditions', () => {
    const ids = BUILTIN_TYPES.map(t => t.id);
    expect(ids).toEqual(['feature', 'bugfix', 'tooling', 'analysis', 'production-data', 'artifact', 'spike']);
    const by = Object.fromEntries(BUILTIN_TYPES.map(t => [t.id, t]));
    expect(by.feature.endsOn).toBe('deploy');
    expect(by.feature.targetsRequired).toBe(true);
    expect(by.bugfix.phases[1]).toBe('debugging');
    expect(by.tooling.endsOn).toBe('merge');
    expect(by.analysis.phases).toEqual(['intake', 'analysis', 'delivery']);
    expect(by.analysis.endsOn).toBe('owner_acceptance');
    expect(by['production-data'].endsOn).toBe('owner_confirmation');
    expect(by['production-data'].requiresBeforeReview).toEqual(['backup', 'dry_run']);
    expect(by.artifact.phases).toEqual(['intake', 'brainstorming', 'creation', 'review', 'delivery']);
    expect(by.artifact.endsOn).toBe('merge_or_acceptance');
    expect(by.spike.phases).toEqual(['intake', 'exploration', 'delivery']);
  });

  it('uses the shared full-lifecycle phases, with debugging replacing brainstorming for bugfix', () => {
    const full = ['intake', 'brainstorming', 'planning', 'implementation', 'verification', 'review', 'delivery'];
    const by = Object.fromEntries(BUILTIN_TYPES.map(t => [t.id, t]));
    expect(by.feature.phases).toEqual(full);
    expect(by.tooling.phases).toEqual(full);
    expect(by['production-data'].phases).toEqual(full);
    expect(by.bugfix.phases).toEqual(full.map(p => (p === 'brainstorming' ? 'debugging' : p)));
  });

  it('carries labels, end conditions, target and evidence requirements per type', () => {
    const summary = BUILTIN_TYPES.map(t => ({
      id: t.id,
      label: t.label,
      endsOn: t.endsOn,
      targetsRequired: t.targetsRequired,
      requiresBeforeReview: t.requiresBeforeReview,
    }));
    expect(summary).toEqual([
      { id: 'feature', label: 'Feature', endsOn: 'deploy', targetsRequired: true, requiresBeforeReview: [] },
      { id: 'bugfix', label: 'Bug fix', endsOn: 'deploy', targetsRequired: true, requiresBeforeReview: [] },
      { id: 'tooling', label: 'Tooling', endsOn: 'merge', targetsRequired: false, requiresBeforeReview: [] },
      { id: 'analysis', label: 'Analysis', endsOn: 'owner_acceptance', targetsRequired: false, requiresBeforeReview: [] },
      {
        id: 'production-data',
        label: 'Production data',
        endsOn: 'owner_confirmation',
        targetsRequired: false,
        requiresBeforeReview: ['backup', 'dry_run'],
      },
      { id: 'artifact', label: 'Artifact', endsOn: 'merge_or_acceptance', targetsRequired: false, requiresBeforeReview: [] },
      { id: 'spike', label: 'Spike', endsOn: 'owner_acceptance', targetsRequired: false, requiresBeforeReview: [] },
    ]);
  });
});

describe('buildTypeRegistry', () => {
  it('builds a registry of enabled + custom types', () => {
    const registry = buildTypeRegistry(['feature'], [infraChange]);
    expect([...registry.keys()]).toEqual(['feature', 'infra-change']);
    expect(registry.get('feature')).toBe(BUILTIN_TYPES.find(t => t.id === 'feature'));
    expect(registry.get('infra-change')).toBe(infraChange);
  });

  it('rejects unknown enabled ids and custom ids that shadow built-ins', () => {
    expect(() => buildTypeRegistry(['feature', 'nonexistent'], [])).toThrow(ConfigError);
    expect(() => buildTypeRegistry(['feature'], [{ ...infraChange, id: 'feature' }])).toThrow(ConfigError);
  });

  it('names the offending id in the error message', () => {
    expect(() => buildTypeRegistry(['nonexistent'], [])).toThrow(/nonexistent/);
    expect(() => buildTypeRegistry([], [{ ...infraChange, id: 'spike' }])).toThrow(/spike/);
  });
});
