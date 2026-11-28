import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfigFromString, type Config } from '../../src/config/schema.js';
import {
  BUILTIN_ROLES,
  CUSTOM_ROLES_DIR,
  builtinRoles,
  loadRoles,
  modelFor,
  renderAgents,
  type RoleDef,
} from '../../src/render/agents.js';
import type { Change, FileChange, MdBlockChange } from '../../src/render/changes.js';
import { parseFrontMatter } from '../../src/render/frontMatter.js';
import { renderData, renderInstructions } from '../../src/render/instructions.js';
import { templatesDir } from '../../src/render/templates.js';
import { expectGolden } from '../support/golden.js';
import { memoryFs } from '../support/memoryFs.js';

const HEADER = `
version: 1
harnesses: [claude, codex, gemini, agents-md]
mode: enforce
github:
  repo: acme/shop
  default_branch: main
  project: { owner: acme, owner_type: org, number: 7 }
owners: [shop-owner]
kit_ref: v1.2.3
task_types: { enabled: [tooling] }
`;

const CODEX_MODELS = 'models:\n  codex: { deep: deep-model, standard: standard-model, fast: fast-model }\n';
const GEMINI_MODELS = 'models:\n  gemini: { deep: deep-model, standard: standard-model, fast: fast-model }\n';
const CLAUDE_MODELS = 'models:\n  claude: { deep: opus-x, standard: sonnet-x, fast: haiku-x }\n';

const cfgWith = (extra = ''): Config => loadConfigFromString(`${HEADER}${extra}`);

const EXPECTED = [
  { role: 'analyst', tier: 'standard', canEdit: true },
  { role: 'architect', tier: 'deep', canEdit: false },
  { role: 'developer', tier: 'standard', canEdit: true },
  { role: 'tester', tier: 'standard', canEdit: true },
  { role: 'reviewer', tier: 'standard', canEdit: false },
  { role: 'final-reviewer', tier: 'deep', canEdit: false },
  { role: 'security-reviewer', tier: 'standard', canEdit: false },
  { role: 'diagnostician', tier: 'deep', canEdit: false },
  { role: 'release-manager', tier: 'standard', canEdit: true },
  { role: 'docs-writer', tier: 'standard', canEdit: true },
  { role: 'scout', tier: 'fast', canEdit: false },
] as const;

const NAMES = EXPECTED.map(e => e.role);

/** The four lines every built-in role prompt ends with, as written in the templates. */
const SHARED_RULES = [
  '- Never spawn further agents.',
  '- Never launch another AI CLI or model (claude, codex, gemini, aider, cursor, ollama, ...) as a helper.',
  "- Never deploy without the owner's explicit confirmation in this conversation, never run scripts against production data, never bypass branch protection (`gh pr merge --admin` or any other bypass), and never use `--force`, `git worktree prune` or `rm -rf`.",
  '- Report back in this shape: {{returns}}',
].join('\n');

/** The shared rule lines as the `role()` helper's custom role renders them (`returns` filled in). */
const RENDERED_RULES = SHARED_RULES.replace('{{returns}}', 'a short report');

const customRole = (name: string, header: Record<string, string> = {}, body = 'You are a custom role.\n'): string => {
  const fields: Record<string, string> = {
    role: name,
    description: 'A project role.',
    tier: 'standard',
    can_edit: 'true',
    returns: 'a short report',
    escalate_when: 'something is unclear',
    ...header,
  };
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
};

const customPath = (name: string): string => `${CUSTOM_ROLES_DIR}/${name}.md`;

const files = (changes: Change[]): FileChange[] =>
  changes.filter((c): c is FileChange => c.kind === 'file');

const byPath = (changes: Change[], path: string): FileChange => {
  const found = files(changes).find(c => c.path === path);
  if (!found) throw new Error(`no change for ${path}; have ${changes.map(c => c.path).join(', ')}`);
  return found;
};

describe('the built-in role templates', () => {
  it('are the eleven roles, one template file each', () => {
    expect([...BUILTIN_ROLES]).toEqual(NAMES);
    const onDisk = readdirSync(join(templatesDir(), 'agents')).sort();
    expect(onDisk).toEqual(NAMES.map(name => `${name}.md`).sort());
  });

  it('load and validate, with the tier and the edit right the spec gives each role', () => {
    const { roles, notices } = loadRoles(memoryFs());
    expect(notices).toEqual([]);
    expect(roles.map(r => ({ role: r.role, tier: r.tier, canEdit: r.canEdit }))).toEqual(EXPECTED);
    expect(builtinRoles().map(r => r.role)).toEqual(NAMES);
    for (const role of roles) {
      expect(role.source).toBe('built-in');
      expect(role.file).toBe(`agents/${role.role}.md`);
    }
  });

  it('describe the role in one line and say what it returns and when it escalates', () => {
    for (const role of builtinRoles()) {
      for (const text of [role.description, role.returns, role.escalateWhen]) {
        expect(text.trim()).not.toBe('');
        expect(text).not.toMatch(/[\r\n]/);
      }
      expect(role.description).not.toMatch(/`/);
    }
  });

  it('have terse English prompts of at most 40 lines that end with the shared rule lines', () => {
    for (const role of builtinRoles()) {
      const lines = role.body.replace(/\n+$/, '').split('\n');
      expect(lines.length, role.role).toBeLessThanOrEqual(40);
      expect(lines.length, role.role).toBeGreaterThan(8);
      expect(role.body.replace(/\n+$/, ''), role.role).toMatch(new RegExp(`${escapeRegExp(SHARED_RULES)}$`));
      expect(role.body, role.role).toMatch(/^[\x20-\x7e\n]*$/);
    }
  });

  it('tell the roles that do not edit never to edit, and the others to stay in scope', () => {
    for (const role of builtinRoles()) {
      if (role.canEdit) expect(role.body, role.role).not.toMatch(/never edit/i);
      else expect(role.body, role.role).toMatch(/never edit files/i);
    }
  });

  it('keep the reviewers read-only and the final reviewer on the deep tier', () => {
    const roles = new Map(builtinRoles().map(r => [r.role, r]));
    for (const name of ['reviewer', 'final-reviewer', 'security-reviewer']) expect(roles.get(name)!.canEdit).toBe(false);
    expect(roles.get('final-reviewer')!.tier).toBe('deep');
  });

  it('carry the delivery prohibitions where the role could act on them', () => {
    const roles = new Map(builtinRoles().map(r => [r.role, r.body]));
    for (const name of ['developer', 'release-manager']) {
      expect(roles.get(name), name).toMatch(/explicit confirmation/i);
      expect(roles.get(name), name).toMatch(/production data/i);
    }
    expect(roles.get('developer')).toMatch(/push --force/);
    expect(roles.get('developer')).toMatch(/Related to #/);
  });

  it('contain nothing from a private project', () => {
    const text = builtinRoles()
      .map(r => `${r.description}\n${r.body}`)
      .join('\n');
    expect(text).not.toMatch(/\b(?:eps|ai_industry|flutter|riverpod|firestore)\b/i);
  });
});

describe('loadRoles', () => {
  it('adds custom roles after the built-ins, sorted by name, from .sdlc/agents/custom/*.md only', () => {
    const fs = memoryFs({
      [customPath('zeta')]: customRole('zeta'),
      [customPath('alpha')]: customRole('alpha', { tier: 'fast', can_edit: 'false' }),
      [`${CUSTOM_ROLES_DIR}/notes.txt`]: 'not a role',
      [`${CUSTOM_ROLES_DIR}/README.md`]: '# How to write a custom role\n',
      [`${CUSTOM_ROLES_DIR}/nested/deep.md`]: customRole('deep'),
      '.sdlc/agents/other/ignored.md': customRole('ignored'),
    });
    const { roles, notices } = loadRoles(fs);
    expect(roles.map(r => r.role)).toEqual([...NAMES, 'alpha', 'zeta']);
    expect(notices).toEqual([]);
    const alpha = roles.find(r => r.role === 'alpha')!;
    expect(alpha).toMatchObject({
      description: 'A project role.',
      tier: 'fast',
      canEdit: false,
      returns: 'a short report',
      escalateWhen: 'something is unclear',
      source: 'custom',
      file: customPath('alpha'),
    });
    expect(alpha.body.trim()).toBe('You are a custom role.');
  });

  it('lets a custom role replace the built-in one of the same name, in place, with a notice', () => {
    const fs = memoryFs({ [customPath('reviewer')]: customRole('reviewer', { tier: 'deep', description: 'Our reviewer.' }) });
    const { roles, notices } = loadRoles(fs);
    expect(roles.map(r => r.role)).toEqual(NAMES);
    expect(roles[NAMES.indexOf('reviewer')]).toMatchObject({ source: 'custom', tier: 'deep', description: 'Our reviewer.' });
    expect(notices).toEqual([
      `custom role "reviewer" (${customPath('reviewer')}) overrides the built-in role of the same name`,
    ]);
  });

  it('does not change the built-in library', () => {
    loadRoles(memoryFs({ [customPath('reviewer')]: customRole('reviewer', { description: 'Our reviewer.' }) }));
    expect(builtinRoles().find(r => r.role === 'reviewer')!.source).toBe('built-in');
  });

  it('works when the custom directory does not exist', () => {
    expect(loadRoles(memoryFs({ 'README.md': 'x' })).roles).toHaveLength(11);
  });

  const invalid: Array<[string, string, RegExp]> = [
    ['a tier that does not exist', customRole('qa', { tier: 'huge' }), /tier/],
    ['can_edit that is not a boolean', customRole('qa', { can_edit: 'maybe' }), /can_edit/],
    ['a missing description', customRole('qa', { description: '' }), /description/],
    ['a missing returns line', customRole('qa', { returns: '' }), /returns/],
    ['a missing escalate_when line', customRole('qa', { escalate_when: '' }), /escalate_when/],
    ['an unknown key', customRole('qa', { tools: 'Read' }), /tools/],
    ['a role name that is not the file name', customRole('other'), /file name/],
    ['a role name that is not kebab-case', customRole('QA Role'), /role/],
    ['an empty body', customRole('qa', {}, '\n\n'), /body/],
    ['no front matter', 'You are a role without a header.\n', /role/],
    ['a description over several lines', '---\nrole: qa\ndescription: |\n  one\n  two\ntier: standard\ncan_edit: true\nreturns: x\nescalate_when: y\n---\nBody\n', /one line/],
    ['a header that is not closed', '---\nrole: qa\n', /not closed/],
  ];
  it.each(invalid)('refuses a custom role with %s, naming the file', (_label, text, pattern) => {
    expect(() => loadRoles(memoryFs({ [customPath('qa')]: text }))).toThrow(pattern);
    expect(() => loadRoles(memoryFs({ [customPath('qa')]: text }))).toThrow(customPath('qa'));
  });
});

describe('modelFor', () => {
  it('gives Claude opus, sonnet and haiku unless the config overrides them', () => {
    const cfg = cfgWith();
    expect(modelFor(cfg, 'claude', 'deep')).toBe('opus');
    expect(modelFor(cfg, 'claude', 'standard')).toBe('sonnet');
    expect(modelFor(cfg, 'claude', 'fast')).toBe('haiku');
    const custom = cfgWith(CLAUDE_MODELS);
    expect(modelFor(custom, 'claude', 'deep')).toBe('opus-x');
    expect(modelFor(custom, 'claude', 'standard')).toBe('sonnet-x');
    expect(modelFor(custom, 'claude', 'fast')).toBe('haiku-x');
  });

  it('has no default for Codex and Gemini, and uses only their own config', () => {
    const none = cfgWith();
    for (const harness of ['codex', 'gemini'] as const) {
      for (const tier of ['deep', 'standard', 'fast'] as const) expect(modelFor(none, harness, tier)).toBeUndefined();
    }
    // The Claude models do not leak into another harness.
    expect(modelFor(cfgWith(CLAUDE_MODELS), 'codex', 'deep')).toBeUndefined();
    expect(modelFor(cfgWith(CODEX_MODELS), 'codex', 'fast')).toBe('fast-model');
    expect(modelFor(cfgWith(CODEX_MODELS), 'gemini', 'fast')).toBeUndefined();
    expect(modelFor(cfgWith(GEMINI_MODELS), 'gemini', 'standard')).toBe('standard-model');
  });

  it('has none for agents-md', () => {
    expect(modelFor(cfgWith(), 'agents-md', 'deep')).toBeUndefined();
  });
});

describe('renderAgents', () => {
  const library = (): RoleDef[] => loadRoles(memoryFs()).roles;

  it('writes nothing for agents-md; its roles live in the instruction block', () => {
    expect(renderAgents(cfgWith(), 'agents-md', library())).toEqual([]);
  });

  it('renders no role for an empty library', () => {
    for (const harness of ['claude', 'codex', 'gemini'] as const) expect(renderAgents(cfgWith(), harness, [])).toEqual([]);
  });

  it.each(['claude', 'codex', 'gemini'] as const)('%s: one managed file per role at the harness path', harness => {
    const ext = harness === 'codex' ? 'toml' : 'md';
    const changes = renderAgents(cfgWith(), harness, library());
    expect(changes.map(c => ({ kind: c.kind, path: c.path }))).toEqual(
      NAMES.map(name => ({ kind: 'file', path: `.${harness}/agents/sdlc-${name}.${ext}` })),
    );
  });

  describe('claude', () => {
    const changes = renderAgents(cfgWith(), 'claude', library());

    it('writes name, description and model, then the prompt as the body', () => {
      for (const def of library()) {
        const { data, body } = parseFrontMatter(byPath(changes, `.claude/agents/sdlc-${def.role}.md`).content);
        expect(Object.keys(data).slice(0, 3), def.role).toEqual(['name', 'description', 'model']);
        expect(data.name).toBe(`sdlc-${def.role}`);
        expect(data.description).toBe(def.description);
        expect(data.model).toBe({ deep: 'opus', standard: 'sonnet', fast: 'haiku' }[def.tier]);
        expect(body.startsWith(`${def.body.split('\n')[0]}`)).toBe(true);
        expect(body.endsWith('\n')).toBe(true);
        expect(body.endsWith('\n\n')).toBe(false);
      }
    });

    it('takes the edit tools away from the roles that do not edit, and only from them', () => {
      for (const def of library()) {
        const { data } = parseFrontMatter(byPath(changes, `.claude/agents/sdlc-${def.role}.md`).content);
        if (def.canEdit) {
          expect(Object.keys(data), def.role).not.toContain('disallowedTools');
        } else {
          expect(data.disallowedTools, def.role).toBe('Edit, Write, NotebookEdit');
          expect(Object.keys(data), def.role).toEqual(['name', 'description', 'model', 'disallowedTools']);
        }
      }
      const read = EXPECTED.filter(e => !e.canEdit).map(e => e.role);
      expect(read).toEqual(['architect', 'reviewer', 'final-reviewer', 'security-reviewer', 'diagnostician', 'scout']);
    });

    it('takes the models from the config', () => {
      const custom = renderAgents(cfgWith(CLAUDE_MODELS), 'claude', library());
      const model = (role: string): unknown =>
        parseFrontMatter(byPath(custom, `.claude/agents/sdlc-${role}.md`).content).data.model;
      expect(model('architect')).toBe('opus-x');
      expect(model('developer')).toBe('sonnet-x');
      expect(model('scout')).toBe('haiku-x');
    });

    it('renders the placeholders of the prompt from the front matter of the role', () => {
      const reviewer = library().find(r => r.role === 'reviewer')!;
      const { body } = parseFrontMatter(byPath(changes, '.claude/agents/sdlc-reviewer.md').content);
      expect(body).not.toContain('{{');
      expect(body).toContain(`- Report back in this shape: ${reviewer.returns}`);
      expect(body).toContain(reviewer.escalateWhen);
      expect(body.trimEnd().split('\n').slice(-4)).toEqual([
        '- Never spawn further agents.',
        '- Never launch another AI CLI or model (claude, codex, gemini, aider, cursor, ollama, ...) as a helper.',
        "- Never deploy without the owner's explicit confirmation in this conversation, never run scripts against production data, never bypass branch protection (`gh pr merge --admin` or any other bypass), and never use `--force`, `git worktree prune` or `rm -rf`.",
        `- Report back in this shape: ${reviewer.returns}`,
      ]);
    });

    it('golden', () => {
      expectGolden('agents/claude', changes);
    });
  });

  describe('codex', () => {
    it('writes name, description and developer_instructions, and no model without config', () => {
      const changes = renderAgents(cfgWith(), 'codex', library());
      for (const def of library()) {
        const text = byPath(changes, `.codex/agents/sdlc-${def.role}.toml`).content;
        expect(text).toMatch(/^name = "sdlc-[a-z-]+"$/m);
        expect(text).toContain(`name = "sdlc-${def.role}"`);
        expect(text).toContain(`description = ${JSON.stringify(def.description)}`);
        expect(text).toMatch(/^developer_instructions = """\n/m);
        expect(text).not.toMatch(/^model\b/m);
        expect(text.endsWith('\n"""\n')).toBe(true);
      }
    });

    it('adds model for the tier when models.codex is configured', () => {
      const changes = renderAgents(cfgWith(CODEX_MODELS), 'codex', library());
      const model = (role: string): string | undefined =>
        /^model = (".*")$/m.exec(byPath(changes, `.codex/agents/sdlc-${role}.toml`).content)?.[1];
      expect(model('architect')).toBe('"deep-model"');
      expect(model('developer')).toBe('"standard-model"');
      expect(model('scout')).toBe('"fast-model"');
      // another harness's models do not apply
      const other = renderAgents(cfgWith(GEMINI_MODELS), 'codex', library());
      expect(byPath(other, '.codex/agents/sdlc-scout.toml').content).not.toMatch(/^model\b/m);
    });

    it('puts the rendered prompt in a multi-line basic string, backslashes escaped', () => {
      const custom = [role('qa', { body: 'Use \\n in a path like C:\\tmp and "quotes".\n- Report back in this shape: {{returns}}\n' })];
      const text = byPath(renderAgents(cfgWith(), 'codex', custom), '.codex/agents/sdlc-qa.toml').content;
      expect(text).toContain('Use \\\\n in a path like C:\\\\tmp and "quotes".');
      expect(text).toContain('- Report back in this shape: a short report');
    });

    it('fails at render time, naming the role, when a prompt holds three quotes in a row', () => {
      const custom = [role('qa', { body: 'Say """hello""" to them.\n' })];
      expect(() => renderAgents(cfgWith(), 'codex', custom)).toThrow(/role "qa".*"""/);
      // The same prompt is fine for the Markdown harnesses.
      expect(() => renderAgents(cfgWith(), 'claude', custom)).not.toThrow();
      expect(() => renderAgents(cfgWith(), 'gemini', custom)).not.toThrow();
    });

    it('golden', () => {
      expectGolden('agents/codex', renderAgents(cfgWith(), 'codex', library()));
    });

    it('golden with models', () => {
      const some = library().filter(r => ['analyst', 'architect', 'scout'].includes(r.role));
      expectGolden('agents/codex-models', renderAgents(cfgWith(CODEX_MODELS), 'codex', some));
    });
  });

  describe('gemini', () => {
    it('writes name and description, and model only when configured', () => {
      const without = renderAgents(cfgWith(), 'gemini', library());
      const withModels = renderAgents(cfgWith(GEMINI_MODELS), 'gemini', library());
      for (const def of library()) {
        const path = `.gemini/agents/sdlc-${def.role}.md`;
        const plain = parseFrontMatter(byPath(without, path).content);
        expect(Object.keys(plain.data), def.role).toEqual(['name', 'description']);
        expect(plain.data.name).toBe(`sdlc-${def.role}`);
        expect(plain.data.name).toMatch(/^[a-z0-9_-]+$/);
        expect(plain.data.description).toBe(def.description);
        const modelled = parseFrontMatter(byPath(withModels, path).content);
        expect(Object.keys(modelled.data), def.role).toEqual(['name', 'description', 'model']);
        expect(modelled.data.model).toBe({ deep: 'deep-model', standard: 'standard-model', fast: 'fast-model' }[def.tier]);
        expect(modelled.body).toBe(plain.body);
      }
    });

    it('does not take the edit tools away by front matter (the prompt says never edit)', () => {
      const changes = renderAgents(cfgWith(), 'gemini', library());
      const { data, body } = parseFrontMatter(byPath(changes, '.gemini/agents/sdlc-reviewer.md').content);
      expect(Object.keys(data)).not.toContain('disallowedTools');
      expect(body).toMatch(/never edit files/i);
    });

    it('golden', () => {
      expectGolden('agents/gemini', renderAgents(cfgWith(), 'gemini', library()));
    });
  });

  describe('custom roles', () => {
    it('render like built-ins in every harness', () => {
      const fs = memoryFs({
        [customPath('qa-lead')]: customRole('qa-lead', { tier: 'fast', can_edit: 'false' }, 'You lead QA. Never edit files.\n'),
      });
      const { roles } = loadRoles(fs);
      const claude = renderAgents(cfgWith(), 'claude', roles);
      expect(claude).toHaveLength(12);
      const { data, body } = parseFrontMatter(byPath(claude, '.claude/agents/sdlc-qa-lead.md').content);
      expect(data).toEqual({
        name: 'sdlc-qa-lead',
        description: 'A project role.',
        model: 'haiku',
        disallowedTools: 'Edit, Write, NotebookEdit',
      });
      expect(body).toBe(`You lead QA. Never edit files.\n\n${RENDERED_RULES}\n`);
      expect(byPath(renderAgents(cfgWith(), 'codex', roles), '.codex/agents/sdlc-qa-lead.toml').content).toContain(
        'name = "sdlc-qa-lead"',
      );
      expect(byPath(renderAgents(cfgWith(), 'gemini', roles), '.gemini/agents/sdlc-qa-lead.md').content).toContain(
        'name: sdlc-qa-lead',
      );
    });

    describe('shared rule lines', () => {
      const paths = {
        claude: '.claude/agents/sdlc-qa.md',
        codex: '.codex/agents/sdlc-qa.toml',
        gemini: '.gemini/agents/sdlc-qa.md',
      } as const;
      const rendered = (harness: keyof typeof paths, body: string): string =>
        byPath(renderAgents(cfgWith(), harness, [role('qa', { body })]), paths[harness]).content;
      /** The prompt as the harness file holds it. */
      const promptIn = (harness: keyof typeof paths, content: string): string =>
        harness === 'codex'
          ? content.slice(content.indexOf('developer_instructions = """\n') + 'developer_instructions = """\n'.length, -'"""\n'.length)
          : parseFrontMatter(content).body;

      it.each(['claude', 'codex', 'gemini'] as const)('%s: a prompt without them gets them appended', harness => {
        const prompt = promptIn(harness, rendered(harness, 'You are the QA lead.\n\nHow to work:\n- Test.\n'));
        expect(prompt).toBe(`You are the QA lead.\n\nHow to work:\n- Test.\n\n${RENDERED_RULES}\n`);
      });

      it.each(['claude', 'codex', 'gemini'] as const)('%s: a prompt that already ends with them is not changed', harness => {
        // once with the placeholder, once with the text already filled in
        for (const rules of [SHARED_RULES, RENDERED_RULES]) {
          const body = `You are the QA lead.\n\n${rules}\n`;
          expect(promptIn(harness, rendered(harness, body))).toBe(`You are the QA lead.\n\n${RENDERED_RULES}\n`);
        }
      });

      it('adds them once however often the output is used as the prompt again', () => {
        const first = promptIn('claude', rendered('claude', 'Do the work.\n'));
        const second = promptIn('claude', rendered('claude', first));
        expect(second).toBe(first);
        expect(first.split('Never spawn further agents').length - 1).toBe(1);
      });

      it('adds all four lines when only some of them end the prompt, or they do not start a line', () => {
        const partial = 'Do the work.\n\n- Never spawn further agents.\n- Report back in this shape: {{returns}}\n';
        expect(promptIn('claude', rendered('claude', partial))).toBe(`${partial.replace('{{returns}}', 'a short report').trimEnd()}\n\n${RENDERED_RULES}\n`);
        const inline = `See: ${SHARED_RULES}\n`;
        expect(promptIn('claude', rendered('claude', inline)).endsWith(`\n\n${RENDERED_RULES}\n`)).toBe(true);
      });

      it('end the prompt of every built-in role the same way, nothing appended', () => {
        for (const def of builtinRoles()) {
          const prompt = promptIn('claude', byPath(renderAgents(cfgWith(), 'claude', [def]), `.claude/agents/sdlc-${def.role}.md`).content);
          expect(prompt.split('Never spawn further agents').length - 1, def.role).toBe(1);
          expect(prompt.trimEnd().split('\n').slice(-4).join('\n'), def.role).toBe(
            RENDERED_RULES.replace('a short report', def.returns),
          );
        }
      });
    });

    it('an override renders instead of the built-in, at the same path', () => {
      const fs = memoryFs({ [customPath('scout')]: customRole('scout', { tier: 'deep', description: 'Our scout.' }) });
      const { roles } = loadRoles(fs);
      const changes = renderAgents(cfgWith(), 'claude', roles);
      expect(changes).toHaveLength(11);
      const { data } = parseFrontMatter(byPath(changes, '.claude/agents/sdlc-scout.md').content);
      expect(data).toMatchObject({ description: 'Our scout.', model: 'opus' });
      expect(Object.keys(data)).not.toContain('disallowedTools');
    });

    it('fail with the role named when the prompt holds an unknown placeholder', () => {
      const custom = [role('qa', { body: 'Hello {{who}}.\n' })];
      expect(() => renderAgents(cfgWith(), 'claude', custom)).toThrow(/qa/);
      expect(() => renderAgents(cfgWith(), 'claude', custom)).toThrow(/who/);
    });

    it('can write a literal {{ with a backslash', () => {
      const custom = [role('qa', { body: 'Write \\{{ in the text.\n' })];
      const { body } = parseFrontMatter(byPath(renderAgents(cfgWith(), 'claude', custom), '.claude/agents/sdlc-qa.md').content);
      expect(body.startsWith('Write {{ in the text.\n\n- Never spawn further agents.')).toBe(true);
    });
  });
});

describe('the roles in the instruction block', () => {
  const instructionBlock = (cfg: Config, roles?: RoleDef[]): MdBlockChange => {
    const changes = renderInstructions(cfg, 'agents-md', renderData(cfg, roles));
    return changes.find((c): c is MdBlockChange => c.kind === 'md-block')!;
  };

  it('are populated from the built-in library by default, with role, description and tier', () => {
    const data = renderData(cfgWith());
    expect(data.roles).toEqual(builtinRoles().map(r => ({ role: r.role, description: r.description, tier: r.tier })));
    expect(data.roles).toHaveLength(11);
  });

  it('list the eleven roles with their tier in the block', () => {
    const text = instructionBlock(cfgWith()).content;
    expect(text).toMatch(/^### Roles$/m);
    for (const def of builtinRoles()) {
      expect(text).toContain(`- \`${def.role}\` (${def.tier}): ${def.description}`);
    }
    expect(text.split('\n').length).toBeLessThan(150);
  });

  it('include a custom role, and show an override instead of the built-in line', () => {
    const fs = memoryFs({
      [customPath('qa-lead')]: customRole('qa-lead', { description: 'Leads QA.' }),
      [customPath('scout')]: customRole('scout', { description: 'Our scout.', tier: 'standard' }),
    });
    const text = instructionBlock(cfgWith(), loadRoles(fs).roles).content;
    expect(text).toContain('- `qa-lead` (standard): Leads QA.');
    expect(text).toContain('- `scout` (standard): Our scout.');
    expect(text).not.toContain('- `scout` (fast)');
  });

  it('leave the Roles section out when the library is empty', () => {
    expect(instructionBlock(cfgWith(), []).content).not.toMatch(/^### Roles/m);
  });
});

function role(name: string, parts: { body: string }): RoleDef {
  return {
    role: name,
    description: 'A project role.',
    tier: 'standard',
    canEdit: true,
    returns: 'a short report',
    escalateWhen: 'something is unclear',
    body: parts.body,
    source: 'custom',
    file: customPath(name),
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
