/**
 * Managed merges. Pure functions, string in and string out: they never touch the disk. Each kit-owned
 * region of a user's file is found by its markers, and every byte outside it is returned untouched.
 *
 * - Markdown (`<!-- sdlc:begin -->` / `<!-- sdlc:end -->`), line files such as `.gitignore`
 *   (`# sdlc:begin` / `# sdlc:end`) and `.codex/config.toml` share one block engine.
 * - JSON files only get the keys the caller says the kit owns, spliced into the user's text (see
 *   `jsonText.ts`): what the user wrote around them is never re-formatted.
 *
 * A marker is a whole line (surrounding whitespace is ignored). Damaged markers are never repaired
 * or guessed at: the merge throws a `MergeError` that names the markers and the line.
 */

import {
  appendEntry,
  applySplice,
  findMember,
  locate as locateJson,
  ownLineIndent,
  removeEntry,
  renderValue,
  replaceMemberValue,
  scanJsonObject,
  type ArrayNode,
  type JsonMember,
  type Layout,
  type ObjectNode,
} from './jsonText.js';

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
  /**
   * Set when the entry owns only some elements of the array at `pointer`: those whose
   * `JSON.stringify` contains `marker`. `value` is then the array of items to keep there.
   * `previousMarker` is the marker an earlier kit version used: its elements are the kit's too and go
   * with the others.
   */
  items?: { marker: string; previousMarker?: string };
}

/** An owned element to remove: the elements of the array at `pointer` that contain `marker`. */
export interface JsonItemsRemoval {
  pointer: string[];
  marker: string;
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

/** Whether an array element is one of the kit's items: its JSON text contains the marker. */
const hasMarker = (element: unknown, marker: string): boolean => (JSON.stringify(element) ?? '').includes(marker);

/** The elements of `array` that contain `marker`, in order. */
export const ownedItems = (array: unknown[], marker: string): unknown[] => array.filter(element => hasMarker(element, marker));

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

const DEFAULT_LAYOUT: Layout = { indent: '  ', eol: '\n' };

/**
 * The indentation unit for what the kit adds (a tab, or the spaces of the first indented line; two
 * spaces when nothing is indented) and the file's line ending. A new or empty file gets two spaces.
 */
function detectLayout(existing: string | undefined): Layout {
  if (existing === undefined || existing.trim() === '') return DEFAULT_LAYOUT;
  const lead = /^([ \t]+)\S/m.exec(existing)?.[1];
  return {
    indent: lead === undefined ? DEFAULT_LAYOUT.indent : lead.startsWith('\t') ? '\t' : lead.slice(0, 10),
    eol: eolOf(existing),
  };
}

/** The text is valid JSON (the caller parsed it), so a scan that fails is an error in the file for us. */
function scan(text: string, path: string): ObjectNode {
  try {
    return scanJsonObject(text);
  } catch {
    throw new MergeError(`${path} is not valid JSON; fix or remove it`);
  }
}

/** A pointer segment becomes part of the manifest key, which joins segments with `/`. */
export function assertJsonPointer(pointer: string[], path = 'file'): void {
  for (const segment of pointer) {
    if (segment.includes('/')) throw new MergeError(`${path}: key segment "${segment}" must not contain "/"`);
  }
}

/** An entry with `items` needs a marker and a non-empty array of items that all contain it. */
export function assertJsonEntry(entry: JsonEntry, path = 'file'): void {
  assertJsonPointer(entry.pointer, path);
  if (entry.items === undefined) return;
  const where = `${path}: ${jsonKey(entry.pointer)}`;
  const { marker } = entry.items;
  if (marker === '') throw new MergeError(`${where}: the marker must not be empty`);
  if (!Array.isArray(entry.value) || entry.value.length === 0) {
    throw new MergeError(`${where}: the value must be a non-empty array`);
  }
  if (!entry.value.every(item => hasMarker(item, marker))) {
    throw new MergeError(`${where}: every item must contain "${marker}"`);
  }
}

const notAnArray = (pointer: string[]): MergeError => new MergeError(`expected an array at ${jsonKey(pointer)}`);

/** Items go into an array: the key may be absent, but a value that is not an array is the user's to fix. */
export function assertItemsTarget(current: { found: boolean; value?: unknown }, pointer: string[]): void {
  if (current.found && !Array.isArray(current.value)) throw notAnArray(pointer);
}

/** The array at `pointer` as a node together with the member that holds it. */
function arrayAt(text: string, pointer: string[], path: string): { member: JsonMember; array: ArrayNode } {
  const member = locateJson(scan(text, path), pointer).leaf;
  if (member === undefined || member.value.kind !== 'array') throw notAnArray(pointer);
  return { member, array: member.value };
}

/** The parsed elements of an array node. */
const elementsOf = (text: string, array: ArrayNode): unknown[] => JSON.parse(text.slice(array.start, array.end)) as unknown[];

/** Removes the elements of the array at `pointer` that `isOurs` accepts, one splice each, last first. */
function removeElements(text: string, pointer: string[], isOurs: (element: unknown) => boolean, path: string): string {
  let out = text;
  for (;;) {
    const { array } = arrayAt(out, pointer, path);
    const elements = elementsOf(out, array);
    let index = elements.length - 1;
    while (index >= 0 && !isOurs(elements[index])) index -= 1;
    if (index < 0) return out;
    out = applySplice(out, removeEntry(array, index));
  }
}

/** Adds `key: value` to `holder`, an empty one in the layout of the line `holderMember` is on. */
function insertMember(
  text: string,
  holder: ObjectNode,
  holderMember: JsonMember | undefined,
  key: string,
  value: unknown,
  layout: Layout,
): string {
  const multilineWhenEmpty = holderMember === undefined || ownLineIndent(text, holderMember.start) !== undefined;
  return applySplice(
    text,
    appendEntry(text, holder, layout, multilineWhenEmpty, (multiline, indent) =>
      `${JSON.stringify(key)}: ${renderValue(value, layout, indent, multiline)}`,
    ),
  );
}

/** `{ rest[0]: { rest[1]: ... value } }`, the objects that have to be created below a new key. */
function nest(rest: string[], value: unknown): unknown {
  const [first, ...others] = rest;
  if (first === undefined) return value;
  const object: JsonObject = {};
  setOwn(object, first, nest(others, value));
  return object;
}

/**
 * Puts `items` into the array at `pointer`: removes its elements that contain a marker and appends
 * `items`, so the user's other elements stay where they are and ours come last. An array whose owned
 * items already equal `items` is left as it is. Returns `undefined` for that no-op.
 */
function mergeOwnedItems(
  text: string,
  pointer: string[],
  items: unknown[],
  markers: string[],
  layout: Layout,
  path: string,
): string | undefined {
  const isOurs = (element: unknown): boolean => markers.some(marker => hasMarker(element, marker));
  const { array } = arrayAt(text, pointer, path);
  if (canonicalJson(elementsOf(text, array).filter(isOurs)) === canonicalJson(items)) return undefined;

  let out = removeElements(text, pointer, isOurs, path);
  for (const item of items) {
    const { member, array: target } = arrayAt(out, pointer, path);
    const multilineWhenEmpty = ownLineIndent(out, member.start) !== undefined;
    out = applySplice(
      out,
      appendEntry(out, target, layout, multilineWhenEmpty, (multiline, indent) => renderValue(item, layout, indent, multiline)),
    );
  }
  return out;
}

interface MergeState {
  skipped: string[];
  createdParents: string[];
  changed: boolean;
}

/** Merges one entry into `text`; returns the new text. */
function mergeEntry(text: string, entry: JsonEntry, owned: Set<string>, layout: Layout, path: string, state: MergeState): string {
  const { pointer, value, items } = entry;
  const leaf = pointer[pointer.length - 1];
  if (leaf === undefined) throw new Error('a JSON pointer needs at least one segment');
  const key = jsonKey(pointer);

  let holder = scan(text, path);
  let holderMember: JsonMember | undefined;
  for (let i = 0; i < pointer.length - 1; i++) {
    const member = findMember(holder, pointer[i] as string);
    if (member === undefined) {
      // From here down nothing exists: add one member that holds the rest of the path.
      for (let j = i; j < pointer.length - 1; j++) state.createdParents.push(jsonKey(pointer.slice(0, j + 1)));
      if (items !== undefined) state.createdParents.push(key);
      state.changed = true;
      return insertMember(text, holder, holderMember, pointer[i] as string, nest(pointer.slice(i + 1), value), layout);
    }
    if (member.value.kind !== 'object') {
      throw new MergeError(`${path}: "${jsonKey(pointer.slice(0, i + 1))}" is not an object; fix or remove it`);
    }
    holder = member.value;
    holderMember = member;
  }

  const current = findMember(holder, leaf);
  if (current === undefined) {
    if (items !== undefined) state.createdParents.push(key);
    state.changed = true;
    return insertMember(text, holder, holderMember, leaf, value, layout);
  }
  if (items !== undefined) {
    if (current.value.kind !== 'array') throw notAnArray(pointer);
    const markers = [items.marker, ...(items.previousMarker === undefined || items.previousMarker === items.marker ? [] : [items.previousMarker])];
    const merged = mergeOwnedItems(text, pointer, value as unknown[], markers, layout, path);
    if (merged === undefined) return text;
    state.changed = true;
    return merged;
  }
  if (!owned.has(key)) {
    state.skipped.push(key);
    return text;
  }
  const onDisk: unknown = JSON.parse(text.slice(current.value.start, current.value.end));
  if (canonicalJson(onDisk) === canonicalJson(value)) return text;
  state.changed = true;
  return applySplice(text, replaceMemberValue(text, current, value, layout));
}

/**
 * Sets each entry whose key is absent or in `owned` (manifest keys, see `jsonKey`). A present key
 * that is not owned belongs to the user: it is left alone and reported in `skipped`. An entry with
 * `items` is different: the array is the user's, only the elements that contain its marker are the
 * kit's, so they are replaced whatever `owned` says (the caller decides whether that is allowed); the
 * array must be absent or an array, else this throws.
 *
 * The edits are spliced into `existing`, so everything the user wrote stays byte for byte: key order,
 * indentation, line endings, inline arrays, blank lines, number spellings, the final newline. What
 * the kit adds follows the layout around it: a new member goes after the last one with the indentation
 * of its siblings (on the same line in a file written on one line), a new nested value is indented with
 * a tab or the spaces of the file's first indented line (two spaces for a new file). When no key is
 * actually set or changed, `existing` is returned as it is. `createdParents` lists the objects this
 * call had to create on the way to the keys (manifest keys, outermost first): `mcpServers` in a file
 * that had none, and the array of an `items` entry that did not exist. Uninstall may take those back
 * once they are empty; objects and arrays that were there are not listed.
 */
export function mergeJsonKeys(
  existing: string | undefined,
  entries: JsonEntry[],
  owned: Set<string>,
  path = 'file',
): { text: string; skipped: string[]; createdParents: string[] } {
  parseJsonObject(existing, path);
  const layout = detectLayout(existing);
  const blank = existing === undefined || existing.trim() === '';
  const state: MergeState = { skipped: [], createdParents: [], changed: false };
  let text = blank ? `{}${layout.eol}` : existing;
  for (const entry of entries) {
    assertJsonEntry(entry, path);
    text = mergeEntry(text, entry, owned, layout, path, state);
  }
  const { skipped, createdParents } = state;
  if (!state.changed && existing !== undefined) return { text: existing, skipped, createdParents };
  return { text, skipped, createdParents };
}

/**
 * Deletes the keys. A `{ pointer, marker }` removal deletes only the elements of the array at that
 * pointer that contain the marker; the array itself goes when none is left and `pruneEmpty` allows
 * it. `pruneEmpty` says which objects (and owned arrays) on the way may go once they are left empty
 * (for us that is `mcpServers`, or `hooks/SessionStart`): `true` (the default) every one, `false`
 * none, or a list of manifest keys (`['mcpServers']`) for exactly those the kit created. An object
 * or array that still holds something is never removed. The edits are spliced into `existing` like
 * those of `mergeJsonKeys`: text without those keys is returned unchanged, and the rest of the file
 * keeps its bytes. A container left empty becomes `{}` or `[]`. A document left as `{}` is the
 * caller's to delete.
 */
export function removeJsonKeys(
  existing: string,
  removals: Array<string[] | JsonItemsRemoval>,
  path = 'file',
  opts: { pruneEmpty?: boolean | string[] } = {},
): string {
  const prune = opts.pruneEmpty ?? true;
  const mayPrune = (pointer: string[], depth: number): boolean =>
    prune === true || (prune !== false && prune.includes(jsonKey(pointer.slice(0, depth))));
  parseJsonObject(existing, path);
  let text = existing;
  for (const removal of removals) {
    const { pointer, marker } = Array.isArray(removal) ? { pointer: removal, marker: undefined } : removal;
    const { chain, holders, leaf } = locateJson(scan(text, path), pointer);
    if (leaf === undefined) continue;
    if (marker !== undefined) {
      if (leaf.value.kind !== 'array') continue;
      const elements = elementsOf(text, leaf.value);
      const ours = elements.filter(element => hasMarker(element, marker));
      if (ours.length === 0) continue;
      if (ours.length < elements.length || !mayPrune(pointer, pointer.length)) {
        text = removeElements(text, pointer, element => hasMarker(element, marker), path);
        continue;
      }
    }
    // Remove the member, and every object above it that this leaves empty and may go.
    let container = chain[pointer.length - 1] as ObjectNode;
    let member = leaf;
    for (let depth = pointer.length - 1; depth > 0; depth--) {
      if (container.members.length !== 1 || !mayPrune(pointer, depth)) break;
      member = holders[depth - 1] as JsonMember;
      container = chain[depth - 1] as ObjectNode;
    }
    text = applySplice(text, removeEntry(container, container.members.indexOf(member)));
  }
  return text;
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
