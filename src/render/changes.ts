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

/**
 * Keys the kit owns in a JSON file; `pointer` is the key path, for example `['mcpServers', 'github']`.
 *
 * An entry with `items` owns only some elements of the array at `pointer`, not the array: `value` is
 * an array of items, each of which contains `items.marker` (a string) once serialized with
 * `JSON.stringify`. The merge removes the elements that contain the marker, appends `value`'s
 * items, and leaves every other element (the user's) in place. The marker must stay the same
 * between kit versions: it is how the kit finds its items again. An `items` entry and a plain entry
 * never share a pointer.
 */
export interface JsonKeysChange {
  kind: 'json-keys';
  path: string;
  entries: Array<{ pointer: string[]; value: unknown; items?: { marker: string } }>;
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
