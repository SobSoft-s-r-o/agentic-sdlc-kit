/**
 * Managed merges. Pure functions, string in and string out: they never touch the disk. Each kit-owned
 * region of a user's file is found by its markers, and every byte outside it is returned untouched.
 *
 * - Markdown (`<!-- sdlc:begin -->` / `<!-- sdlc:end -->`), line files such as `.gitignore`
 *   (`# sdlc:begin` / `# sdlc:end`) and `.codex/config.toml` share one block engine.
 * - JSON files only get the keys the caller says the kit owns.
 *
 * A marker is a whole line (surrounding whitespace is ignored). Damaged markers are never repaired
 * or guessed at: the merge throws a `MergeError` that names the markers and the line.
 */

export class MergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeError';
  }
}

export type BlockKind = 'md-block' | 'line-block' | 'toml-block';

interface Markers {
  begin: string;
  end: string;
}

const MARKERS: Record<BlockKind, Markers> = {
  'md-block': { begin: '<!-- sdlc:begin -->', end: '<!-- sdlc:end -->' },
  'line-block': { begin: '# sdlc:begin', end: '# sdlc:end' },
  'toml-block': {
    begin: '# >>> sdlc:begin (managed by agentic-sdlc-kit; edits inside are overwritten) >>>',
    end: '# <<< sdlc:end <<<',
  },
};

interface Located {
  /** Offset of the begin marker line. */
  start: number;
  /** Offset just after the begin line's newline: where the body starts. */
  bodyStart: number;
  /** Offset of the end marker line: where the body stops. */
  endLineStart: number;
  /** Offset just after the end marker text; the rest of that line, and its newline, stay as they were. */
  end: number;
}

interface MarkerLine {
  lineNo: number;
  start: number;
  next: number;
  end: number;
}

/** Finds the one block in `text`, `undefined` when there is none, throws when the markers are damaged. */
function locate(text: string, markers: Markers): Located | undefined {
  const begins: MarkerLine[] = [];
  const ends: MarkerLine[] = [];
  let offset = 0;
  let lineNo = 1;
  for (;;) {
    const newline = text.indexOf('\n', offset);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(offset, lineEnd);
    const trimmed = line.trim();
    const found = {
      lineNo,
      start: offset,
      next: newline === -1 ? text.length : newline + 1,
      end: offset + line.trimEnd().length,
    };
    if (trimmed === markers.begin) begins.push(found);
    else if (trimmed === markers.end) ends.push(found);
    if (newline === -1) break;
    offset = newline + 1;
    lineNo += 1;
  }

  const { begin, end } = markers;
  const lines = (list: MarkerLine[]): string => list.map(l => l.lineNo).join(' and ');
  if (begins.length > 1) {
    throw new MergeError(
      `more than one "${begin}" marker (lines ${lines(begins)}); keep one managed block and remove the extra markers`,
    );
  }
  if (ends.length > 1) {
    throw new MergeError(
      `more than one "${end}" marker (lines ${lines(ends)}); keep one managed block and remove the extra markers`,
    );
  }
  const [first] = begins;
  const [last] = ends;
  if (first === undefined && last === undefined) return undefined;
  if (first === undefined && last !== undefined) {
    throw new MergeError(`"${end}" at line ${last.lineNo} has no "${begin}" before it; add the begin marker or remove this one`);
  }
  if (first !== undefined && last === undefined) {
    throw new MergeError(`"${begin}" at line ${first.lineNo} has no matching "${end}"; add the end marker or remove this one`);
  }
  if (first === undefined || last === undefined) return undefined;
  if (last.start < first.start) {
    throw new MergeError(`"${end}" at line ${last.lineNo} comes before "${begin}" at line ${first.lineNo}; fix the order or remove both markers`);
  }
  return { start: first.start, bodyStart: first.next, endLineStart: last.start, end: last.end };
}

const toLf = (text: string): string => text.replace(/\r\n/g, '\n');
const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');

/** The body as the kit means it: LF line endings and no trailing newlines. */
export function canonicalBody(body: string): string {
  return toLf(body).replace(/\n+$/, '');
}

function mergeBlock(existing: string | undefined, body: string, kind: BlockKind): string {
  const markers = MARKERS[kind];
  const eol = existing === undefined ? '\n' : eolOf(existing);
  const text = canonicalBody(body).split('\n').join(eol);
  const block = `${markers.begin}${eol}${text}${eol}${markers.end}`;
  if (existing === undefined || existing === '') return `${block}${eol}`;
  const at = locate(existing, markers);
  if (at) return existing.slice(0, at.start) + block + existing.slice(at.end);
  return `${existing}${existing.endsWith('\n') ? eol : eol + eol}${block}${eol}`;
}

/**
 * Removes the block, the rest of its end-marker line, and the one blank line that was added before
 * it. A text that has no block is returned as it is; one that has nothing else left becomes ''.
 */
function removeBlock(existing: string, kind: BlockKind): string {
  const at = locate(existing, MARKERS[kind]);
  if (!at) return existing;
  const prefix = existing.slice(0, at.start).replace(/(\r?\n)\r?\n$/, '$1');
  const suffix = existing.slice(at.end).replace(/^[^\n]*\n?/, '');
  const result = prefix + suffix;
  return result.trim() === '' ? '' : result;
}

/**
 * The body between the markers of `kind` (LF line endings, no trailing newline), or `undefined` when
 * the text has no markers. Throws `MergeError` when the markers are damaged.
 */
export function blockBody(existing: string, kind: BlockKind): string | undefined {
  const at = locate(existing, MARKERS[kind]);
  if (!at) return undefined;
  return toLf(existing.slice(at.bodyStart, at.endLineStart)).replace(/\n$/, '');
}

export const mergeMdBlock = (existing: string | undefined, body: string): string => mergeBlock(existing, body, 'md-block');
export const removeMdBlock = (existing: string): string => removeBlock(existing, 'md-block');
export const mergeLineBlock = (existing: string | undefined, body: string): string => mergeBlock(existing, body, 'line-block');
export const removeLineBlock = (existing: string): string => removeBlock(existing, 'line-block');
export const removeTomlBlock = (existing: string): string => removeBlock(existing, 'toml-block');

// --- JSON -----------------------------------------------------------------------------------------

export interface JsonEntry {
  pointer: string[];
  value: unknown;
}

/** The manifest key of a JSON pointer: its segments joined by `/`. */
export const jsonKey = (pointer: string[]): string => pointer.join('/');

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOwn = (object: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

/** `defineProperty` so that a key such as `__proto__` becomes a plain own property. */
function setOwn(object: JsonObject, key: string, value: unknown): void {
  Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
}

export function parseJsonObject(text: string | undefined, path: string): JsonObject {
  if (text === undefined || text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MergeError(`${path} is not valid JSON; fix or remove it`);
  }
  if (!isObject(parsed)) throw new MergeError(`${path} must contain a JSON object at the top level; fix or remove it`);
  return parsed;
}

/** The value at `pointer`, or `{ found: false }` when any step is missing or not an object. */
export function jsonValueAt(root: JsonObject, pointer: string[]): { found: boolean; value?: unknown } {
  let node: unknown = root;
  for (const segment of pointer) {
    if (!isObject(node) || !hasOwn(node, segment)) return { found: false };
    node = node[segment];
  }
  return { found: true, value: node };
}

/** `JSON.stringify` with the keys of every object sorted, so equal values give equal text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isObject(value)) {
    const sorted: JsonObject = {};
    for (const key of Object.keys(value).sort()) setOwn(sorted, key, sortKeys(value[key]));
    return sorted;
  }
  return value;
}

/** How the user's JSON file is laid out, so a rewrite does not reformat it. */
interface JsonFormat {
  indent: string;
  finalNewline: boolean;
  eol: string;
}

const DEFAULT_JSON_FORMAT: JsonFormat = { indent: '  ', finalNewline: true, eol: '\n' };

/**
 * Indentation from the first indented line (a tab, or that line's spaces; two spaces when nothing is
 * indented), the line ending, and whether the text ends with a newline. A new or empty file gets the
 * default: two spaces and a final newline.
 */
function detectJsonFormat(existing: string | undefined): JsonFormat {
  if (existing === undefined || existing.trim() === '') return DEFAULT_JSON_FORMAT;
  const indented = /^([ \t]+)\S/m.exec(existing);
  const lead = indented?.[1];
  return {
    indent: lead === undefined ? DEFAULT_JSON_FORMAT.indent : lead.startsWith('\t') ? '\t' : lead.slice(0, 10),
    finalNewline: existing.endsWith('\n'),
    eol: eolOf(existing),
  };
}

function serialize(value: unknown, format: JsonFormat): string {
  const text = JSON.stringify(value, null, format.indent).split('\n').join(format.eol);
  return format.finalNewline ? text + format.eol : text;
}

/** A pointer segment becomes part of the manifest key, which joins segments with `/`. */
export function assertJsonPointer(pointer: string[], path = 'file'): void {
  for (const segment of pointer) {
    if (segment.includes('/')) throw new MergeError(`${path}: key segment "${segment}" must not contain "/"`);
  }
}

/**
 * Sets each entry whose key is absent or in `owned` (manifest keys, see `jsonKey`). A present key
 * that is not owned belongs to the user: it is left alone and reported in `skipped`. The file keeps
 * its key order (new keys go last), its indentation (a tab or N spaces; two spaces for a new file or
 * one with no indentation), its line endings and whether it ends with a newline. When no key is
 * actually set or changed, `existing` is returned as it is. `createdParents` lists the objects this
 * call had to create on the way to the keys (manifest keys, outermost first): `mcpServers` in a file
 * that had none. Uninstall may take those back once they are empty; objects that were there are not listed.
 */
export function mergeJsonKeys(
  existing: string | undefined,
  entries: JsonEntry[],
  owned: Set<string>,
  path = 'file',
): { text: string; skipped: string[]; createdParents: string[] } {
  const root = parseJsonObject(existing, path);
  const skipped: string[] = [];
  const createdParents: string[] = [];
  let changed = false;
  for (const { pointer, value } of entries) {
    assertJsonPointer(pointer, path);
    const leaf = pointer[pointer.length - 1];
    if (leaf === undefined) throw new Error('a JSON pointer needs at least one segment');
    let node = root;
    for (let i = 0; i < pointer.length - 1; i++) {
      const segment = pointer[i] as string;
      const next = hasOwn(node, segment) ? node[segment] : undefined;
      if (next === undefined) {
        const created: JsonObject = {};
        setOwn(node, segment, created);
        node = created;
        createdParents.push(jsonKey(pointer.slice(0, i + 1)));
        changed = true;
      } else if (isObject(next)) {
        node = next;
      } else {
        throw new MergeError(`${path}: "${jsonKey(pointer.slice(0, i + 1))}" is not an object; fix or remove it`);
      }
    }
    const key = jsonKey(pointer);
    if (!hasOwn(node, leaf)) {
      setOwn(node, leaf, value);
      changed = true;
    } else if (!owned.has(key)) {
      skipped.push(key);
    } else if (canonicalJson(node[leaf]) !== canonicalJson(value)) {
      setOwn(node, leaf, value);
      changed = true;
    }
  }
  if (!changed && existing !== undefined) return { text: existing, skipped, createdParents };
  return { text: serialize(root, detectJsonFormat(existing)), skipped, createdParents };
}

/**
 * Deletes the keys. `pruneEmpty` says which objects on their path may go once they are left empty
 * (for us that is `mcpServers`): `true` (the default) every one, `false` none, or a list of manifest
 * keys (`['mcpServers']`) for exactly those the kit created. An object that still holds something is
 * never removed. Text without those keys is returned unchanged; otherwise the file keeps its
 * indentation, line endings and final newline. A document left as `{}` is the caller's to delete.
 */
export function removeJsonKeys(
  existing: string,
  pointers: string[][],
  path = 'file',
  opts: { pruneEmpty?: boolean | string[] } = {},
): string {
  const prune = opts.pruneEmpty ?? true;
  const mayPrune = (pointer: string[], depth: number): boolean =>
    prune === true || (prune !== false && prune.includes(jsonKey(pointer.slice(0, depth))));
  const root = parseJsonObject(existing, path);
  let changed = false;
  for (const pointer of pointers) {
    const chain: JsonObject[] = [root];
    let node: unknown = root;
    for (let i = 0; i < pointer.length - 1; i++) {
      node = isObject(node) && hasOwn(node, pointer[i] as string) ? node[pointer[i] as string] : undefined;
      if (!isObject(node)) break;
      chain.push(node);
    }
    const leaf = pointer[pointer.length - 1];
    const parent = chain[pointer.length - 1];
    if (leaf === undefined || parent === undefined || !hasOwn(parent, leaf)) continue;
    delete parent[leaf];
    changed = true;
    for (let depth = pointer.length - 1; depth > 0; depth--) {
      const holder = chain[depth];
      if (holder === undefined || Object.keys(holder).length > 0 || !mayPrune(pointer, depth)) break;
      delete (chain[depth - 1] as JsonObject)[pointer[depth - 1] as string];
    }
  }
  return changed ? serialize(root, detectJsonFormat(existing)) : existing;
}

// --- TOML -----------------------------------------------------------------------------------------

interface TomlSection {
  /** `a.b` for a `[a.b]` header; undefined for text before the first header or for `[[array]]` headers. */
  name?: string;
  /** The section's lines, newline included, up to the next header. */
  raw: string;
  isHeader: boolean;
}

const TABLE_HEADER = /^\[([^[\]]+)\][ \t]*(#.*)?$/;

/** Splits a TOML body into sections at each line that starts with `[`. */
function splitSections(body: string): TomlSection[] {
  const sections: TomlSection[] = [];
  for (const line of toLf(body).split(/(?<=\n)/)) {
    if (line.startsWith('[')) {
      const match = TABLE_HEADER.exec(line.replace(/\n$/, '').trimEnd());
      const name = match?.[1]?.trim();
      sections.push({ ...(name === undefined ? {} : { name }), raw: line, isHeader: true });
    } else {
      const current = sections[sections.length - 1];
      if (current) current.raw += line;
      else sections.push({ raw: line, isHeader: false });
    }
  }
  return sections;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Drops the tables the user already defines outside the block. A table `[t]` counts as defined when a
 * header line `[t]` (surrounding spaces and a trailing comment allowed) is in the text outside the
 * managed block; its child tables `[t.x]` go with it. Returns what is left of the body, '' when no
 * table is left, and the dropped tables in `ownedTables` order.
 */
export function filterTomlBody(
  existing: string | undefined,
  body: string,
  ownedTables: string[],
): { body: string; skipped: string[] } {
  const outside = existing === undefined ? '' : removeBlock(existing, 'toml-block');
  const skipped = ownedTables.filter(table =>
    new RegExp(`^[ \\t]*\\[[ \\t]*${escapeRegExp(table)}[ \\t]*\\][ \\t]*(#.*)?\\r?$`, 'm').test(outside),
  );
  const kept = splitSections(body).filter(
    section => !skipped.some(table => section.name === table || section.name?.startsWith(`${table}.`)),
  );
  if (!kept.some(section => section.isHeader)) return { body: '', skipped };
  return { body: canonicalBody(kept.map(section => section.raw).join('')), skipped };
}

/** The text of the section `[table]` in a TOML body, without its trailing blank lines. */
export function tomlTableText(body: string, table: string): string | undefined {
  const section = splitSections(body).find(s => s.isHeader && s.name === table);
  return section === undefined ? undefined : section.raw.replace(/\n+$/, '');
}

/**
 * Appends (or replaces) the managed block. Tables the user already defines are dropped from the body
 * and reported in `skipped`; when none is left, no block is written and a stale one is removed.
 */
export function mergeTomlBlock(
  existing: string | undefined,
  body: string,
  ownedTables: string[],
): { text: string; skipped: string[] } {
  const filtered = filterTomlBody(existing, body, ownedTables);
  if (filtered.body === '') {
    return { text: existing === undefined ? '' : removeBlock(existing, 'toml-block'), skipped: filtered.skipped };
  }
  return { text: mergeBlock(existing, filtered.body, 'toml-block'), skipped: filtered.skipped };
}
