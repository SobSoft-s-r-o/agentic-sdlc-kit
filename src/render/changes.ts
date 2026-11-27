/**
 * What the renderers produce and the apply engine consumes. A `Change` describes one managed region
 * of one repository file; `path` is always repo-relative and uses `/`.
 */

/** A whole file the kit owns. `mode` is set for the git hooks, which must be executable. */
export interface FileChange {
  kind: 'file';
  path: string;
  content: string;
  mode?: 0o755;
}

/** The body between `<!-- sdlc:begin -->` and `<!-- sdlc:end -->` in a Markdown file. */
export interface MdBlockChange {
  kind: 'md-block';
  path: string;
  content: string;
}

/** The body between `# sdlc:begin` and `# sdlc:end` in a line-oriented file such as `.gitignore`. */
export interface LineBlockChange {
  kind: 'line-block';
  path: string;
  content: string;
  comment: '#';
}

/** Keys the kit owns in a JSON file; `pointer` is the key path, for example `['mcpServers', 'github']`. */
export interface JsonKeysChange {
  kind: 'json-keys';
  path: string;
  entries: Array<{ pointer: string[]; value: unknown }>;
}

/**
 * The body between the TOML markers. `ownedTables` lists the table headers the body defines, for
 * example `mcp_servers.github`.
 */
export interface TomlBlockChange {
  kind: 'toml-block';
  path: string;
  content: string;
  ownedTables: string[];
}

export type Change = FileChange | MdBlockChange | LineBlockChange | JsonKeysChange | TomlBlockChange;

export type ChangeKind = Change['kind'];
