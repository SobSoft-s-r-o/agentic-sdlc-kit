import { z } from 'zod';
import type { Config, Harness } from '../config/schema.js';
import type { RepoFs } from '../install/repoFs.js';
import type { Change, FileChange } from './changes.js';
import { emitFrontMatter, parseFrontMatter } from './frontMatter.js';
import { renderTemplate } from './template.js';
import { loadTemplate } from './templates.js';
import { tomlMultilineString, tomlString } from './toml.js';

/** The model classes a role asks for; `models.<harness>` in the config maps them to real models. */
export const TIERS = ['deep', 'standard', 'fast'] as const;
export type Tier = (typeof TIERS)[number];

/** Where project-specific roles live. The source is user-owned; the files rendered from it are managed. */
export const CUSTOM_ROLES_DIR = '.sdlc/agents/custom';

/** The built-in library: `templates/agents/<role>.md` for each name, in the order they are listed. */
export const BUILTIN_ROLES = [
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
] as const;

/** One role, built-in or custom, validated. */
export type RoleDef = {
  /** Kebab-case, equal to the file name; rendered as the agent `sdlc-<role>`. */
  role: string;
  /** One line: what the role does and when to use it. */
  description: string;
  tier: Tier;
  /** `false` takes the edit tools away where the harness lets the file do that. */
  canEdit: boolean;
  /** One line: what the role reports back. The prompt's last rule line shows it. */
  returns: string;
  /** One line: when the role stops and hands back instead of guessing. */
  escalateWhen: string;
  /**
   * The role prompt, as written in the file; `{{returns}}` and the like are filled in at render
   * time, and the shared rule lines are appended when it does not end with them.
   */
  body: string;
  source: 'built-in' | 'custom';
  /** Where it was read from: `agents/<role>.md` in the templates, or `.sdlc/agents/custom/<role>.md`. */
  file: string;
};

/** A role file that cannot be used; the message starts with the file. */
export class RoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleError';
  }
}

const ROLE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const oneLine = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .regex(/^[^\r\n]+$/, 'must be one line');

/** The front matter of a role file. Unknown keys are errors, so a typo does not silently do nothing. */
const RoleHeaderSchema = z.strictObject({
  role: z.string().regex(ROLE_NAME, 'must be lowercase kebab-case (a-z, 0-9 and hyphens, e.g. "qa-lead")'),
  description: oneLine,
  tier: z.enum(TIERS),
  can_edit: z.boolean(),
  returns: oneLine,
  escalate_when: oneLine,
});

/** Parses and validates one role file; `name` is the file name without `.md`, `file` is for messages. */
function parseRole(text: string, name: string, file: string, source: RoleDef['source']): RoleDef {
  const fail = (reason: string): never => {
    throw new RoleError(`${file}: ${reason}`);
  };
  let parsed: ReturnType<typeof parseFrontMatter>;
  try {
    parsed = parseFrontMatter(text);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const header = RoleHeaderSchema.safeParse(parsed.data);
  if (!header.success) {
    return fail(header.error.issues.map(i => `${i.path.join('.') || '(front matter)'}: ${i.message}`).join('; '));
  }
  const { role, description, tier, can_edit, returns, escalate_when } = header.data;
  if (role !== name) fail(`role "${role}" must be the file name "${name}"`);
  const body = parsed.body.trim();
  if (body === '') fail('the body is empty; it is the role prompt');
  return { role, description, tier, canEdit: can_edit, returns, escalateWhen: escalate_when, body: `${body}\n`, source, file };
}

let builtins: readonly RoleDef[] | undefined;

/** The eleven built-in roles, read from the templates once. */
export function builtinRoles(): RoleDef[] {
  builtins ??= BUILTIN_ROLES.map(name => {
    const file = `agents/${name}.md`;
    return parseRole(loadTemplate(file), name, file, 'built-in');
  });
  return [...builtins];
}

/**
 * The built-in roles plus the custom ones in `.sdlc/agents/custom/*.md` (that directory only, not
 * below it; `README.md` is skipped). A custom role with a built-in name replaces it where it
 * stands and adds a notice; the others follow the built-ins, sorted by name. A custom file that
 * does not validate throws a `RoleError` that names it.
 */
export function loadRoles(fs: RepoFs): { roles: RoleDef[]; notices: string[] } {
  const roles = builtinRoles();
  const notices: string[] = [];
  const prefix = `${CUSTOM_ROLES_DIR}/`;
  const custom = fs
    .list(CUSTOM_ROLES_DIR, 1)
    .filter(path => path.startsWith(prefix) && path.endsWith('.md') && !path.slice(prefix.length).includes('/'))
    .filter(path => path.slice(prefix.length).toLowerCase() !== 'readme.md');
  for (const path of custom) {
    const text = fs.read(path);
    if (text === undefined) continue;
    const def = parseRole(text, path.slice(prefix.length, -'.md'.length), path, 'custom');
    const index = roles.findIndex(r => r.role === def.role);
    if (index === -1) {
      roles.push(def);
    } else {
      roles[index] = def;
      notices.push(`custom role "${def.role}" (${path}) overrides the built-in role of the same name`);
    }
  }
  return { roles, notices };
}

const CLAUDE_MODELS: Record<Tier, string> = { deep: 'opus', standard: 'sonnet', fast: 'haiku' };

/**
 * The model a role of `tier` runs on in `harness`: `cfg.models[harness]`, else for Claude
 * `opus`/`sonnet`/`haiku`. Codex and Gemini have no default (`undefined`): their agent files then
 * leave `model` out and the harness picks its own.
 */
export function modelFor(cfg: Config, harness: Harness, tier: Tier): string | undefined {
  return cfg.models[harness]?.[tier] ?? (harness === 'claude' ? CLAUDE_MODELS[tier] : undefined);
}

const optional = (key: string, value: string | undefined): Record<string, string> =>
  value === undefined ? {} : { [key]: value };

/**
 * The four lines every role prompt ends with: the built-in templates carry them, and a custom
 * prompt that does not end with them gets them appended (see `promptOf`).
 */
const SHARED_RULES = [
  '- Never spawn further agents.',
  '- Never launch another AI CLI or model (claude, codex, gemini, aider, cursor, ollama, ...) as a helper.',
  "- Never deploy without the owner's explicit confirmation in this conversation, never run scripts against production data, never bypass branch protection (`gh pr merge --admin` or any other bypass), and never use `--force`, `git worktree prune` or `rm -rf`.",
  '- Report back in this shape: {{returns}}',
].join('\n');

/**
 * The role prompt with `returns`, `escalate_when` and the other header fields filled in, ending in
 * the shared rule lines and one newline. A prompt that already ends with the rule lines (whole
 * lines, in this order, `returns` filled in) is left as it is; otherwise they are appended after a
 * blank line, so a custom role cannot drop them and rendering never repeats them.
 */
function promptOf(def: RoleDef): string {
  const data = {
    role: def.role,
    description: def.description,
    tier: def.tier,
    can_edit: def.canEdit,
    returns: def.returns,
    escalate_when: def.escalateWhen,
  };
  // A template error starts with this name, so it says which role's prompt is wrong.
  const text = renderTemplate(def.body, data, `role "${def.role}" (${def.file})`).replace(/\s+$/, '');
  const rules = renderTemplate(SHARED_RULES, data, 'shared role rules');
  const complete = text === rules || text.endsWith(`\n${rules}`);
  return `${complete ? text : `${text}\n\n${rules}`}\n`;
}

/** The Markdown agent file shared by Claude and Gemini: front matter, then the prompt. */
function markdownAgent(path: string, header: Record<string, unknown>, def: RoleDef): FileChange {
  return { kind: 'file', path, content: emitFrontMatter(header, promptOf(def)) };
}

function codexAgent(path: string, def: RoleDef, model: string | undefined): FileChange {
  let instructions: string;
  try {
    instructions = tomlMultilineString(promptOf(def));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RoleError(`role "${def.role}" (${def.file}): ${reason}; rewrite the prompt without it`);
  }
  const lines = [
    `name = ${tomlString(`sdlc-${def.role}`)}`,
    `description = ${tomlString(def.description)}`,
    ...(model === undefined ? [] : [`model = ${tomlString(model)}`]),
    `developer_instructions = ${instructions}`,
  ];
  return { kind: 'file', path, content: `${lines.join('\n')}\n` };
}

/**
 * One managed agent file per role for `harness`; `agents-md` has no agent files (its roles reach the
 * AGENTS.md block through `RenderData.roles`).
 *
 * - claude: `.claude/agents/sdlc-<role>.md`, front matter `name`, `description`, `model`, and for a
 *   role that cannot edit `disallowedTools: Edit, Write, NotebookEdit`.
 * - codex: `.codex/agents/sdlc-<role>.toml`, `model` only when `models.codex` sets it; a prompt
 *   holding `"""` throws a `RoleError` naming the role.
 * - gemini: `.gemini/agents/sdlc-<role>.md`, `model` only when `models.gemini` sets it.
 */
export function renderAgents(cfg: Config, harness: Harness, roles: readonly RoleDef[]): Change[] {
  switch (harness) {
    case 'agents-md':
      return [];
    case 'claude':
      return roles.map(def =>
        markdownAgent(
          `.claude/agents/sdlc-${def.role}.md`,
          {
            name: `sdlc-${def.role}`,
            description: def.description,
            ...optional('model', modelFor(cfg, harness, def.tier)),
            ...(def.canEdit ? {} : { disallowedTools: 'Edit, Write, NotebookEdit' }),
          },
          def,
        ),
      );
    case 'codex':
      return roles.map(def => codexAgent(`.codex/agents/sdlc-${def.role}.toml`, def, modelFor(cfg, harness, def.tier)));
    case 'gemini':
      return roles.map(def =>
        markdownAgent(
          `.gemini/agents/sdlc-${def.role}.md`,
          { name: `sdlc-${def.role}`, description: def.description, ...optional('model', modelFor(cfg, harness, def.tier)) },
          def,
        ),
      );
  }
}
