import type { Config } from '../config/schema.js';
import { canonicalJson } from '../install/merge.js';
import type { RepoFs } from '../install/repoFs.js';
import { loadRoles, renderAgents } from './agents.js';
import type { Change, JsonKeysChange, TomlBlockChange } from './changes.js';
import { renderGitHooks, renderGithub } from './github.js';
import { renderData, renderInstructions } from './instructions.js';
import { mcpNotes, renderMcp } from './mcp.js';

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Everything `sdlc init` and `sdlc upgrade` apply: the instructions, skills and agents of every
 * harness, the MCP wiring, the GitHub files and the git hooks, as one list of changes with each
 * path at most once, sorted by path. `userCommands` are the steps the owner runs themselves (MCP
 * servers in user scope); `notes` say what is left to do or what was decided for them (custom
 * roles that replace built-in ones, variables to export). Pure: it reads only through `fs`, for the
 * custom roles.
 */
export function renderAll(cfg: Config, fs: RepoFs): { changes: Change[]; userCommands: string[]; notes: string[] } {
  const { roles, notices } = loadRoles(fs);
  const data = renderData(cfg, roles);
  const changes: Change[] = [];
  const userCommands: string[] = [];
  for (const harness of cfg.harnesses) {
    changes.push(...renderInstructions(cfg, harness, data), ...renderAgents(cfg, harness, roles));
    const mcp = renderMcp(cfg, harness);
    changes.push(...mcp.changes);
    userCommands.push(...mcp.userCommands);
  }
  changes.push(...renderGithub(cfg, data), ...renderGitHooks());
  return { changes: mergeChanges(changes), userCommands, notes: [...notices, ...mcpNotes(cfg)] };
}

/**
 * One change per path, sorted by path. Harnesses that share a file render it more than once
 * (`AGENTS.md` for Codex and AGENTS.md-only setups, the `.agents` skills); the copies must be
 * identical. `json-keys` of one path become one change holding every entry, and so do `toml-block`s
 * (bodies joined by a blank line). A conflict between renderers is a bug in the kit, so it throws.
 */
export function mergeChanges(changes: Change[]): Change[] {
  const byPath = new Map<string, Change[]>();
  for (const change of changes) {
    const group = byPath.get(change.path);
    if (group) group.push(change);
    else byPath.set(change.path, [change]);
  }
  return [...byPath.keys()].sort(compare).map(path => mergeGroup(path, byPath.get(path) ?? []));
}

function mergeGroup(path: string, group: Change[]): Change {
  const [first] = group;
  if (first === undefined) throw new Error(`no change for ${path}`);
  const kinds = [...new Set(group.map(change => change.kind))];
  if (kinds.length > 1) throw new Error(`conflicting changes for ${path}: ${kinds.join(' and ')}`);

  switch (first.kind) {
    case 'json-keys':
      return mergeJsonKeys(path, group as JsonKeysChange[]);
    case 'toml-block':
      return mergeTomlBlocks(path, group as TomlBlockChange[]);
    default:
      for (const change of group) {
        if (!sameChange(first, change)) throw new Error(`${path} is rendered twice with different content`);
      }
      return first;
  }
}

/** Whether two `file`, `md-block` or `line-block` changes of one path would write the same bytes. */
function sameChange(a: Change, b: Change): boolean {
  if (a.kind === 'file' && b.kind === 'file') return a.content === b.content && a.mode === b.mode;
  if (a.kind === 'line-block' && b.kind === 'line-block') return a.content === b.content && a.comment === b.comment;
  if (a.kind === 'md-block' && b.kind === 'md-block') return a.content === b.content;
  return false;
}

function mergeJsonKeys(path: string, group: JsonKeysChange[]): JsonKeysChange {
  const entries: JsonKeysChange['entries'] = [];
  const seen = new Map<string, string>();
  for (const change of group) {
    for (const entry of change.entries) {
      const key = JSON.stringify(entry.pointer);
      // an items entry differs from a plain one, and from one with another marker, even for equal values
      const value = canonicalJson([entry.value, entry.items ?? null]);
      const earlier = seen.get(key);
      if (earlier === undefined) {
        seen.set(key, value);
        entries.push(entry);
      } else if (earlier !== value) {
        throw new Error(`${path}: ${entry.pointer.join('/')} is rendered twice with different values`);
      }
    }
  }
  return { kind: 'json-keys', path, entries };
}

function mergeTomlBlocks(path: string, group: TomlBlockChange[]): TomlBlockChange {
  const bodies: string[] = [];
  const ownedTables: string[] = [];
  for (const change of group) {
    if (bodies.includes(change.content)) continue;
    const shared = change.ownedTables.find(table => ownedTables.includes(table));
    if (shared !== undefined) throw new Error(`${path}: table ${shared} is rendered twice with different content`);
    bodies.push(change.content);
    ownedTables.push(...change.ownedTables);
  }
  return { kind: 'toml-block', path, content: bodies.join('\n\n'), ownedTables };
}
