import { describe, expect, it } from 'vitest';
import { editsAllowed } from '../../src/core/edits.js';
import { newTask } from '../../src/core/stateMachine.js';
import { BUILTIN_TYPES } from '../../src/core/taskTypes.js';
import type { Phase, TaskState, TaskTypeDef } from '../../src/core/types.js';
import {
  decide,
  editViolations,
  isUserHarnessFile,
  needsTask,
  subagentViolation,
  type PathCheck,
  type Violation,
} from '../../src/hooks/policy.js';

const MODES = ['observe', 'enforce'] as const;

const typeDef = (id: string): TaskTypeDef => {
  const def = BUILTIN_TYPES.find(t => t.id === id);
  if (!def) throw new Error(`no built-in type ${id}`);
  return def;
};

const APPROVAL = {
  source: 'comment',
  ref: 'https://example.test/issues/5#issuecomment-1',
  by: 'owner-login',
  at: '2026-01-01T02:00:00.000Z',
} as const;

/** A feature task #5 in `phase`, with or without an approved plan. */
const feature = (phase: Phase, planApproved: boolean, status: TaskState['status'] = 'in_progress'): TaskState => ({
  ...newTask({ issue: 5, type: typeDef('feature'), summary: 'Do the thing', now: '2026-01-01T00:00:00.000Z' }),
  phase,
  status,
  stages: planApproved ? { planning: { revision: 1, publishedAt: '2026-01-01T01:00:00.000Z', approval: APPROVAL } } : {},
});

const taskCheck = (state: TaskState, relPath = 'src/a.ts'): PathCheck => ({
  path: `/work/proj/${relPath}`,
  inProject: true,
  relPath,
  issue: state.issue,
  branch: `task/${state.issue}-x`,
  lookup: 'ok',
  state,
  type: typeDef(state.type),
});

const noTaskCheck = (relPath: string, branch?: string): PathCheck => ({
  path: `/work/proj/${relPath}`,
  inProject: true,
  relPath,
  ...(branch === undefined ? {} : { branch }),
  lookup: 'none',
});

describe('subagentViolation', () => {
  it('requires a role', () => {
    expect(subagentViolation({ category: 'subagent', name: 'Agent' })).toEqual({
      rule: 'subagent-role',
      text: 'subagent dispatch needs a role: use an sdlc-<role> agent',
    });
    expect(subagentViolation({ category: 'subagent', name: 'Agent', role: '', model: 'haiku' })?.rule).toBe('subagent-role');
    expect(subagentViolation({ category: 'subagent', name: 'Agent', role: '  ' })?.rule).toBe('subagent-role');
  });

  it('requires a model tier of a role that is not an sdlc agent', () => {
    expect(subagentViolation({ category: 'subagent', name: 'Agent', role: 'Explore' })).toEqual({
      rule: 'subagent-tier',
      text: 'subagent Explore needs a model tier: pass a model or use an sdlc-<role> agent',
    });
    expect(subagentViolation({ category: 'subagent', name: 'Agent', role: 'Explore', model: '' })?.rule).toBe('subagent-tier');
  });

  it('passes a role with a model', () => {
    expect(subagentViolation({ category: 'subagent', name: 'Agent', role: 'Explore', model: 'haiku' })).toBeUndefined();
  });

  it('passes an sdlc role without a model, since its agent file pins one', () => {
    expect(subagentViolation({ category: 'subagent', name: 'Agent', role: 'sdlc-reviewer' })).toBeUndefined();
  });
});

describe.each(MODES)('editViolations (%s)', mode => {
  it('ignores a path outside the project', () => {
    const check: PathCheck = { path: '/etc/hosts', inProject: false, lookup: 'none' };
    expect(editViolations([check], mode)).toEqual({ violations: [], warnings: [] });
  });

  it('returns nothing for no checks', () => {
    expect(editViolations([], mode)).toEqual({ violations: [], warnings: [] });
  });

  it.each(['docs/x.ts', 'docs/deep/er/y.json', 'README.md', 'a/b/notes.md', 'CHANGELOG.MD'])(
    'lets %s be edited without a task',
    relPath => {
      expect(editViolations([noTaskCheck(relPath)], mode)).toEqual({ violations: [], warnings: [] });
    },
  );

  it('does not exempt a look-alike of docs/', () => {
    expect(editViolations([noTaskCheck('mydocs/x.ts')], mode).violations.map(v => v.rule)).toEqual(['no-task']);
    expect(editViolations([noTaskCheck('src/docs/x.ts')], mode).violations.map(v => v.rule)).toEqual(['no-task']);
  });

  it('reports an edit outside any task, with the exact text', () => {
    expect(editViolations([noTaskCheck('src/a.ts')], mode).violations).toEqual([
      {
        rule: 'no-task',
        text: 'editing src/a.ts outside a task: create one with `sdlc task new` and work in its worktree',
      },
    ]);
  });

  it('names the branch when it is known', () => {
    const [violation] = editViolations([noTaskCheck('src/a.ts', 'main')], mode).violations;
    expect(violation?.rule).toBe('no-task');
    expect(violation?.text).toBe(
      'editing src/a.ts outside a task: create one with `sdlc task new` and work in its worktree (current branch: main)',
    );
  });

  it('reports no-task when the issue has no tracked task', () => {
    const check: PathCheck = { ...noTaskCheck('src/a.ts'), issue: 9, branch: 'task/9-x' };
    expect(editViolations([check], mode).violations.map(v => v.rule)).toEqual(['no-task']);
  });

  it('warns, and does not block, when the task could not be read', () => {
    const check: PathCheck = { path: '/work/proj/src/a.ts', inProject: true, relPath: 'src/a.ts', issue: 5, lookup: 'failed' };
    expect(editViolations([check], mode)).toEqual({
      violations: [],
      warnings: ['could not read task #5; edit allowed'],
    });
  });

  it('gives the rule and text of editsAllowed when it refuses', () => {
    const state = feature('planning', false);
    const verdict = editsAllowed(state, typeDef('feature'));
    if (verdict.allowed) throw new Error('expected a refusal');
    expect(editViolations([taskCheck(state)], mode)).toEqual({
      violations: [{ rule: 'plan-not-approved', text: verdict.text }],
      warnings: [],
    });
  });

  it('gives task-done for a done task', () => {
    const [violation] = editViolations([taskCheck(feature('delivery', true, 'done'))], mode).violations;
    expect(violation?.rule).toBe('task-done');
    expect(violation?.text).toContain('#5 is done');
  });

  it('allows an edit once the plan is approved', () => {
    expect(editViolations([taskCheck(feature('implementation', false))], mode)).toEqual({ violations: [], warnings: [] });
    expect(editViolations([taskCheck(feature('planning', true))], mode)).toEqual({ violations: [], warnings: [] });
  });

  it('keeps .sdlc/agents/custom/ editable', () => {
    expect(editViolations([noTaskCheck('.sdlc/agents/custom/x.md')], mode).violations).toEqual([]);
  });

  it('collapses identical violations across paths and keeps distinct ones', () => {
    const state = feature('planning', false);
    const same = editViolations([taskCheck(state, 'src/a.ts'), taskCheck(state, 'src/b.ts')], mode);
    expect(same.violations.map(v => v.rule)).toEqual(['plan-not-approved']);

    const different = editViolations([noTaskCheck('src/a.ts'), noTaskCheck('src/b.ts')], mode);
    expect(different.violations).toHaveLength(2);
    expect(different.violations.every(v => v.rule === 'no-task')).toBe(true);
  });

  it('collapses identical warnings across paths', () => {
    const failed = (relPath: string): PathCheck => ({
      path: `/work/proj/${relPath}`,
      inProject: true,
      relPath,
      issue: 5,
      lookup: 'failed',
    });
    expect(editViolations([failed('src/a.ts'), failed('src/b.ts')], mode).warnings).toEqual([
      'could not read task #5; edit allowed',
    ]);
  });
});

describe('editViolations: protected paths', () => {
  const PROTECTED = ['sdlc.config.yaml', '.sdlc/manifest.json', '.sdlc/hooks/run.sh', '.sdlc/agents/sdlc-x.md', '.sdlc/README.md'];

  it.each(PROTECTED)('blocks %s in enforce, whatever the task state', relPath => {
    const approved = taskCheck(feature('implementation', true), relPath);
    for (const check of [approved, noTaskCheck(relPath)]) {
      const { violations, warnings } = editViolations([check], 'enforce');
      expect(violations.map(v => v.rule)).toEqual(['protected-path']);
      expect(violations[0]?.text).toContain(relPath);
      expect(warnings).toEqual([]);
    }
  });

  it.each(PROTECTED)('reports nothing for %s in observe', relPath => {
    expect(editViolations([noTaskCheck(relPath)], 'observe')).toEqual({ violations: [], warnings: [] });
    expect(editViolations([taskCheck(feature('implementation', true), relPath)], 'observe')).toEqual({
      violations: [],
      warnings: [],
    });
  });

  it('sees through ./, .. and letter case', () => {
    for (const relPath of ['./sdlc.config.yaml', 'src/../sdlc.config.yaml', '.sdlc/agents/custom/../../manifest.json', 'SDLC.config.yaml', '.Sdlc/manifest.json']) {
      expect(editViolations([noTaskCheck(relPath)], 'enforce').violations.map(v => v.rule)).toEqual(['protected-path']);
    }
  });

  it('does not protect look-alikes', () => {
    for (const relPath of ['src/sdlc.config.yaml', 'docs/.sdlc/x.ts', '.sdlc-notes/x.ts']) {
      expect(editViolations([taskCheck(feature('implementation', true), relPath)], 'enforce').violations, relPath).toEqual([]);
    }
    // '.sdlc/agents/customer/' is not '.sdlc/agents/custom/'.
    expect(editViolations([noTaskCheck('.sdlc/agents/customer/x.ts')], 'enforce').violations.map(v => v.rule)).toEqual(['protected-path']);
  });

  it('protects the git directory: .git/ in the checkout, however the case', () => {
    for (const relPath of ['.git', '.git/config', '.git/hooks/pre-commit', '.git/worktrees/7-x/config.worktree', '.GIT/hooks/x', 'src/../.git/config']) {
      const found = editViolations([noTaskCheck(relPath)], 'enforce');
      expect(found.violations.map(v => v.rule), relPath).toEqual(['protected-path']);
      expect(editViolations([noTaskCheck(relPath)], 'observe')).toEqual({ violations: [], warnings: [] });
      expect(needsTask(relPath), relPath).toBe(false);
    }
  });

  it('does not protect look-alikes of .git', () => {
    for (const relPath of ['.gitignore', '.github/workflows/ci.yml', '.gitattributes', 'src/.git/x.ts']) {
      expect(editViolations([taskCheck(feature('implementation', true), relPath)], 'enforce').violations, relPath).toEqual([]);
    }
  });

  it('never lets a path outside its checkout root pass: protected in enforce, nothing in observe', () => {
    for (const relPath of ['..', '../CASEREPO/sdlc.config.yaml', '../../x/a.ts', '/etc/hosts', 'C:/x/a.ts', 'src/../../a.ts']) {
      const approved = taskCheck(feature('implementation', true), relPath);
      for (const check of [approved, noTaskCheck(relPath)]) {
        expect(editViolations([check], 'enforce').violations.map(v => v.rule), relPath).toEqual(['protected-path']);
        expect(editViolations([check], 'observe')).toEqual({ violations: [], warnings: [] });
      }
      expect(needsTask(relPath), relPath).toBe(false);
    }
  });

  it('does not take a name that merely starts with two dots for an escape', () => {
    expect(editViolations([taskCheck(feature('implementation', true), '..notes/a.ts')], 'enforce').violations).toEqual([]);
  });

  it('keeps .sdlc/agents/custom/ code subject to the task rules', () => {
    expect(editViolations([noTaskCheck('.sdlc/agents/custom/x.toml')], 'enforce').violations.map(v => v.rule)).toEqual(['no-task']);
  });
});

describe('editViolations: harness settings', () => {
  const SETTINGS = [
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.codex/hooks.json',
    '.codex/config.toml',
    '.gemini/settings.json',
    'apps/web/.claude/settings.json',
    'packages/x/.codex/hooks.json',
    'a/b/.gemini/settings.json',
    '.CLAUDE/Settings.Local.json',
    '.mcp.json',
    '.MCP.json',
  ];

  it.each(SETTINGS)('protects %s in enforce, nothing in observe', relPath => {
    const approved = taskCheck(feature('implementation', true), relPath);
    for (const check of [approved, noTaskCheck(relPath)]) {
      const { violations } = editViolations([check], 'enforce');
      expect(violations.map(v => v.rule)).toEqual(['protected-path']);
      expect(violations[0]?.text).toContain('harness settings');
      expect(editViolations([check], 'observe')).toEqual({ violations: [], warnings: [] });
    }
    expect(needsTask(relPath)).toBe(false);
  });

  it('does not protect look-alikes', () => {
    for (const relPath of ['apps/web/.mcp.json', '.claude/agents/x.md', '.claude/commands/x.json', 'src/settings.json', 'my.claude/settings.json', '.codex/agents/sdlc-x.toml']) {
      expect(editViolations([taskCheck(feature('implementation', true), relPath)], 'enforce').violations, relPath).toEqual([]);
    }
  });

  it('protects user-level harness files outside the project in enforce only', () => {
    const userFile: PathCheck = { path: '/home/u/.claude/settings.json', inProject: false, userHarnessFile: true, lookup: 'none' };
    const { violations } = editViolations([userFile], 'enforce');
    expect(violations.map(v => v.rule)).toEqual(['protected-path']);
    expect(violations[0]?.text).toContain('/home/u/.claude/settings.json');
    expect(editViolations([userFile], 'observe')).toEqual({ violations: [], warnings: [] });
  });
});

describe('isUserHarnessFile', () => {
  const home = '/home/u';
  it.each([
    '/home/u/.claude/settings.json',
    '/home/u/.claude/settings.local.json',
    '/home/u/.codex/config.toml',
    '/home/u/.codex/hooks.json',
    '/home/u/.gemini/settings.json',
    '/home/u/.claude.json',
    '/home/u/.Claude/SETTINGS.json',
  ])('%s is one', path => {
    expect(isUserHarnessFile(path, home)).toBe(true);
  });

  it.each(['/home/u/.claude/agents/x.md', '/home/u/project/.claude.json', '/home/other/.claude.json', '/home/u2/.claude.json', '/etc/hosts'])(
    '%s is not',
    path => {
      expect(isUserHarnessFile(path, home)).toBe(false);
    },
  );

  it('matches the home directory without regard to case', () => {
    expect(isUserHarnessFile('/Users/U/.gemini/settings.json', '/Users/u')).toBe(true);
  });
});

describe('decide', () => {
  const noTask: Violation = { rule: 'no-task', text: 'editing a.ts outside a task' };
  const noVerify: Violation = { rule: 'no-verify', text: '--no-verify skips the git hooks and the secret guard' };
  const spoof: Violation = { rule: 'hook-spoof', text: 'sdlc hooks are run by the harness only' };

  it('allows with no violations in either mode', () => {
    expect(decide([], 'enforce')).toEqual({ context: [], warnings: [] });
    expect(decide([], 'observe')).toEqual({ context: [], warnings: [] });
  });

  it('blocks on the first violation in enforce, with the mode prefix', () => {
    expect(decide([noTask, noVerify], 'enforce')).toEqual({
      block: 'sdlc (enforce): editing a.ts outside a task',
      context: [],
      warnings: [],
    });
  });

  it('warns about every violation in observe and does not block', () => {
    const outcome = decide([noTask, noVerify], 'observe');
    expect(outcome.block).toBeUndefined();
    expect(outcome.context).toEqual([]);
    expect(outcome.warnings).toEqual([
      'sdlc (observe): editing a.ts outside a task',
      'sdlc (observe): --no-verify skips the git hooks and the secret guard',
    ]);
  });

  it('blocks hook-spoof in observe too', () => {
    const outcome = decide([noTask, spoof], 'observe');
    expect(outcome.block).toBe('sdlc (observe): sdlc hooks are run by the harness only');
    expect(outcome.warnings).toContain('sdlc (observe): editing a.ts outside a task');
  });

  it('blocks kit-removal in observe too', () => {
    const removal: Violation = { rule: 'kit-removal', text: 'only the owner removes or overwrites the sdlc install' };
    expect(decide([noTask, removal], 'observe').block).toBe('sdlc (observe): only the owner removes or overwrites the sdlc install');
    expect(decide([removal], 'enforce').block).toBe('sdlc (enforce): only the owner removes or overwrites the sdlc install');
  });

  it('blocks hook-spoof in enforce with the enforce prefix', () => {
    expect(decide([spoof], 'enforce').block).toBe('sdlc (enforce): sdlc hooks are run by the harness only');
  });

  it('appends harness warnings in both modes, prefixed', () => {
    const lookup = 'could not read task #5; edit allowed';
    expect(decide([], 'enforce', [lookup])).toEqual({ context: [], warnings: [`sdlc: ${lookup}`] });
    expect(decide([noTask], 'observe', [lookup]).warnings).toEqual([
      'sdlc (observe): editing a.ts outside a task',
      `sdlc: ${lookup}`,
    ]);
    expect(decide([noTask], 'enforce', [lookup])).toEqual({
      block: 'sdlc (enforce): editing a.ts outside a task',
      context: [],
      warnings: [`sdlc: ${lookup}`],
    });
  });
});

describe('needsTask', () => {
  it.each(['src/a.ts', 'mydocs/x.ts', 'apps/web/index.html'])('%s needs the task', relPath => {
    expect(needsTask(relPath)).toBe(true);
  });

  it.each(['docs/a.ts', 'README.md', 'sdlc.config.yaml', '.sdlc/config.json', 'SDLC.CONFIG.YAML'])(
    '%s is decided by its path alone',
    relPath => {
      expect(needsTask(relPath)).toBe(false);
    },
  );

  it('still needs the task for the custom agents directory, which is not protected', () => {
    expect(needsTask('.sdlc/agents/custom/a.toml')).toBe(true);
  });
});
