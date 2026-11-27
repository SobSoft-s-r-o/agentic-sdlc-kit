import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
// Type-only: this module is loaded by `config/schema.ts` (it validates `mcp.servers` with
// `validateMcpIds`), so it must not import the schema at run time.
import type { Config, Harness } from '../config/schema.js';
import type { Change, JsonKeysChange, TomlBlockChange } from './changes.js';
import { loadTemplate } from './templates.js';
import { tomlString } from './toml.js';

/**
 * The MCP server catalog (`templates/mcp/catalog.yaml`) and how each harness gets its entries.
 *
 * No value of a credential is ever read or written: an entry names the environment variable (the
 * harness reads it when it starts the server), and the files get a reference to that name in the
 * syntax the harness expands (`${VAR}` for Claude, `$VAR` for Gemini) or its own field (Codex).
 */

const ID = /^[a-z0-9][a-z0-9-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const nonEmpty = z.string().min(1);
const envName = z.string().regex(ENV_NAME, 'must be an environment variable name (letters, digits, "_")');

const RemoteSchema = z.strictObject({
  url: z.url({ protocol: /^https$/ }),
  /** `Authorization: Bearer $env`; the only scheme the harness files can express. */
  auth: z
    .strictObject({
      header: z.literal('Authorization'),
      scheme: z.literal('Bearer'),
      env: envName,
    })
    .optional(),
});

const LocalSchema = z.strictObject({
  command: nonEmpty,
  args: z.array(z.string()),
  /** Names of the variables forwarded to the server process; never values. */
  env: z.array(envName).optional(),
});

const McpServerSchema = z
  .strictObject({
    id: z.string().regex(ID, 'must be lowercase kebab-case (a-z, 0-9 and hyphens, e.g. "my-server")'),
    description: nonEmpty,
    default: z.boolean(),
    remote: RemoteSchema.optional(),
    local: LocalSchema.optional(),
  })
  .superRefine((server, ctx) => {
    if (server.remote === undefined && server.local === undefined) {
      ctx.addIssue({ code: 'custom', message: `server "${server.id}" needs a remote or local transport` });
    }
  });

export type McpServerDef = z.output<typeof McpServerSchema>;

/** The catalog text is wrong: a bug in the kit (or in a catalog handed to the renderer), not in a user's config. */
export class McpCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpCatalogError';
  }
}

/** Parses and validates catalog YAML: a non-empty list of servers with unique ids. */
export function parseMcpCatalog(text: string): McpServerDef[] {
  const result = z.array(McpServerSchema).min(1).safeParse(parseYaml(text));
  if (!result.success) {
    const lines = result.error.issues.map(issue => {
      const path = issue.path.reduce<string>(
        (acc, seg) => (typeof seg === 'number' ? `${acc}[${seg}]` : acc ? `${acc}.${String(seg)}` : String(seg)),
        '',
      );
      return `  - ${path || '(root)'}: ${issue.message}`;
    });
    throw new McpCatalogError(`Invalid MCP catalog:\n${lines.join('\n')}`);
  }
  const seen = new Set<string>();
  for (const { id } of result.data) {
    if (seen.has(id)) throw new McpCatalogError(`Invalid MCP catalog: duplicate id "${id}"`);
    seen.add(id);
  }
  return result.data;
}

let catalog: readonly McpServerDef[] | undefined;

/** The built-in catalog, read from the templates once. */
export function loadMcpCatalog(): McpServerDef[] {
  catalog ??= parseMcpCatalog(loadTemplate('mcp/catalog.yaml'));
  return [...catalog];
}

const idList = (defs: readonly McpServerDef[]): string => defs.map(def => def.id).join(', ') || 'none';

/**
 * One message per problem in the `mcp.servers` ids: an id listed twice (reported once however often
 * it repeats) and an id the catalog does not have. An empty list is valid: it is the explicit
 * opt-out, and renders no MCP changes or notes. This is what the config schema asks by default,
 * so a config that names a server the catalog lacks never loads.
 */
export function validateMcpIds(ids: string[]): string[] {
  const known = loadMcpCatalog();
  const messages: string[] = [];
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      if (!reported.has(id)) messages.push(`duplicate MCP server "${id}"; list each server once`);
      reported.add(id);
      continue;
    }
    seen.add(id);
    if (!known.some(def => def.id === id)) {
      messages.push(`unknown MCP server "${id}" (catalog ids: ${idList(known)})`);
    }
  }
  return messages;
}

// --- Transport choice ---------------------------------------------------------------------------

type Auth = NonNullable<z.output<typeof RemoteSchema>['auth']>;

type Resolved =
  | { id: string; kind: 'remote'; url: string; auth?: Auth }
  | { id: string; kind: 'local'; command: string; args: string[]; env: string[] };

/** `github` follows `mcp.github_transport`; every other server is local when it has a local form, else remote. */
function resolve(cfg: Config, def: McpServerDef): Resolved {
  // The id becomes a TOML table name and a JSON key; a catalog that went through `parseMcpCatalog` is safe already.
  if (!ID.test(def.id)) throw new McpCatalogError(`MCP server id "${def.id}" must be lowercase kebab-case`);
  const kind = def.id === 'github' ? cfg.mcp.githubTransport : def.local !== undefined ? 'local' : 'remote';
  if (kind === 'remote') {
    if (def.remote === undefined) throw new McpCatalogError(`MCP server "${def.id}" has no remote transport`);
    return { id: def.id, kind, url: def.remote.url, ...(def.remote.auth ? { auth: def.remote.auth } : {}) };
  }
  if (def.local === undefined) throw new McpCatalogError(`MCP server "${def.id}" has no local transport`);
  return { id: def.id, kind, command: def.local.command, args: def.local.args, env: def.local.env ?? [] };
}

/** The configured servers, in the order of `mcp.servers`, with their transport. */
function selected(cfg: Config, defs: readonly McpServerDef[]): Resolved[] {
  return cfg.mcp.servers.map(id => {
    const def = defs.find(d => d.id === id);
    if (def === undefined) throw new McpCatalogError(`unknown MCP server "${id}" (catalog ids: ${idList(defs)})`);
    return resolve(cfg, def);
  });
}

// --- Project scope: files -----------------------------------------------------------------------

/** How a harness's own config refers to an environment variable: Claude `${VAR}`, Gemini `$VAR`. */
const envRef = (harness: 'claude' | 'gemini', name: string): string =>
  harness === 'claude' ? `\${${name}}` : `$${name}`;

/**
 * One `mcpServers.<id>` object for a JSON file. Claude: `${VAR}`, remote = `type: "http"` + `url`.
 * Gemini: `$VAR`, remote = `httpUrl` and no `type`. Both: stdio = `command`, `args`, `env`.
 */
function jsonServer(t: Resolved, harness: 'claude' | 'gemini'): Record<string, unknown> {
  const ref = (name: string): string => envRef(harness, name);
  if (t.kind === 'remote') {
    return {
      ...(harness === 'claude' ? { type: 'http', url: t.url } : { httpUrl: t.url }),
      ...(t.auth ? { headers: { [t.auth.header]: `${t.auth.scheme} ${ref(t.auth.env)}` } } : {}),
    };
  }
  return {
    command: t.command,
    args: t.args,
    ...(t.env.length > 0 ? { env: Object.fromEntries(t.env.map(name => [name, ref(name)])) } : {}),
  };
}

function jsonKeys(path: string, servers: Resolved[], harness: 'claude' | 'gemini'): JsonKeysChange {
  return {
    kind: 'json-keys',
    path,
    entries: servers.map(t => ({ pointer: ['mcpServers', t.id], value: jsonServer(t, harness) })),
  };
}

/** Codex: `url` + `bearer_token_env_var`, or `command` + `args` + `env_vars`; Codex does not expand `${VAR}`. */
function tomlTable(t: Resolved): string {
  const lines = [`[mcp_servers.${t.id}]`];
  if (t.kind === 'remote') {
    lines.push(`url = ${tomlString(t.url)}`);
    if (t.auth) lines.push(`bearer_token_env_var = ${tomlString(t.auth.env)}`);
  } else {
    lines.push(`command = ${tomlString(t.command)}`);
    lines.push(`args = [${t.args.map(tomlString).join(', ')}]`);
    if (t.env.length > 0) lines.push(`env_vars = [${t.env.map(tomlString).join(', ')}]`);
  }
  return lines.join('\n');
}

function tomlBlock(servers: Resolved[]): TomlBlockChange {
  return {
    kind: 'toml-block',
    path: '.codex/config.toml',
    content: servers.map(tomlTable).join('\n\n'),
    ownedTables: servers.map(t => `mcp_servers.${t.id}`),
  };
}

// --- User scope: commands -----------------------------------------------------------------------

/** A shell word: as it is when it holds only plain characters, else in single quotes. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command the owner runs for one server. A credential is only ever passed as a reference the
 * harness stores and expands itself, so every `$` sits inside single quotes (`shellWord` quotes any
 * word that holds one): the owner's shell must not expand it, or the harness would write the token
 * into the owner's own config file (`~/.claude.json`, `~/.gemini/settings.json`).
 *
 * Gemini's `mcp add` reads `-e` as `--env` and takes unknown options as arguments, so a local
 * server's own arguments follow a `--`, and its environment is forwarded with `-e NAME=$NAME`, the
 * same reference the project-scope settings file holds. Codex's `mcp add` cannot forward variables
 * to a stdio server; `mcpNotes` tells the owner to add `env_vars` by hand.
 */
function userCommand(harness: Exclude<Harness, 'agents-md'>, t: Resolved): string {
  const header = (auth: Auth, ref: string): string => shellWord(`${auth.header}: ${auth.scheme} ${ref}`);
  let words: string[];
  if (t.kind === 'remote') {
    switch (harness) {
      case 'claude':
        words = ['claude', 'mcp', 'add', '--scope', 'user', '--transport', 'http', t.id, shellWord(t.url)];
        if (t.auth) words.push('--header', header(t.auth, envRef('claude', t.auth.env)));
        break;
      case 'codex':
        words = ['codex', 'mcp', 'add', t.id, '--url', shellWord(t.url)];
        if (t.auth) words.push('--bearer-token-env-var', t.auth.env);
        break;
      case 'gemini':
        words = ['gemini', 'mcp', 'add', '--scope', 'user', '--transport', 'http'];
        if (t.auth) words.push('--header', header(t.auth, envRef('gemini', t.auth.env)));
        words.push(t.id, shellWord(t.url));
        break;
    }
  } else {
    const run = [t.command, ...t.args].map(shellWord);
    switch (harness) {
      case 'claude':
        words = ['claude', 'mcp', 'add', '--scope', 'user', t.id, '--', ...run];
        break;
      case 'codex':
        words = ['codex', 'mcp', 'add', t.id, '--', ...run];
        break;
      case 'gemini': {
        const [command = '', ...args] = run;
        words = ['gemini', 'mcp', 'add', '--scope', 'user'];
        for (const name of t.env) words.push('-e', shellWord(`${name}=${envRef('gemini', name)}`));
        words.push(t.id, command);
        if (args.length > 0) words.push('--', ...args);
        break;
      }
    }
  }
  return words.join(' ');
}

// --- Public ---------------------------------------------------------------------------------------

/**
 * The MCP wiring of `cfg.mcp.servers` for one harness. Pure; `catalog` is the built-in one unless a
 * test passes its own.
 *
 * - scope `project`: one change for the harness's MCP file (`.mcp.json` for Claude,
 *   `.codex/config.toml` for Codex, `.gemini/settings.json` for Gemini); none for `agents-md`.
 * - scope `user`: no change; `userCommands` holds the command that adds each server for the owner to
 *   run (the kit never writes to the user's own harness configuration).
 *
 * Throws `McpCatalogError` for an id the catalog lacks or a transport the entry does not define.
 */
export function renderMcp(
  cfg: Config,
  harness: Harness,
  defs: readonly McpServerDef[] = loadMcpCatalog(),
): { changes: Change[]; userCommands: string[] } {
  if (harness === 'agents-md') return { changes: [], userCommands: [] };
  const servers = selected(cfg, defs);
  if (cfg.mcp.scope === 'user') {
    return { changes: [], userCommands: servers.map(t => userCommand(harness, t)) };
  }
  if (servers.length === 0) return { changes: [], userCommands: [] };
  switch (harness) {
    case 'claude':
      return { changes: [jsonKeys('.mcp.json', servers, 'claude')], userCommands: [] };
    case 'gemini':
      return { changes: [jsonKeys('.gemini/settings.json', servers, 'gemini')], userCommands: [] };
    case 'codex':
      return { changes: [tomlBlock(servers)], userCommands: [] };
  }
}

/**
 * What the owner has to do before the servers work, as short fragments for the install summary:
 * export each variable the configured servers read (in either scope), and the one-time approval
 * Codex and Claude Code ask for the project files (project scope only; those files do not exist
 * in user scope), and, in user scope for Codex, the `env_vars` line its add command cannot write.
 * Nothing for a config whose harnesses are all AGENTS.md-only.
 */
export function mcpNotes(cfg: Config, defs: readonly McpServerDef[] = loadMcpCatalog()): string[] {
  // An AGENTS.md-only setup has no MCP file or command, so there is nothing to prepare.
  if (cfg.harnesses.every(harness => harness === 'agents-md')) return [];
  const servers = selected(cfg, defs);
  const variables = new Set<string>();
  for (const t of servers) {
    if (t.kind === 'remote' && t.auth) variables.add(t.auth.env);
    if (t.kind === 'local') t.env.forEach(name => variables.add(name));
  }
  const notes = [...variables].map(name => `export ${name} before starting your agent`);
  if (cfg.mcp.scope === 'project' && servers.length > 0) {
    if (cfg.harnesses.includes('codex')) notes.push('Codex loads .codex/config.toml only for trusted projects');
    if (cfg.harnesses.includes('claude')) notes.push('approve the project MCP servers when Claude Code asks');
  }
  if (cfg.mcp.scope === 'user' && cfg.harnesses.includes('codex')) {
    // `codex mcp add` has no way to forward a variable to a stdio server.
    for (const t of servers) {
      if (t.kind === 'local' && t.env.length > 0) {
        notes.push(
          `Codex cannot forward variables through "codex mcp add": add env_vars = [${t.env.map(tomlString).join(', ')}] to [mcp_servers.${t.id}] in ~/.codex/config.toml`,
        );
      }
    }
  }
  return notes;
}
