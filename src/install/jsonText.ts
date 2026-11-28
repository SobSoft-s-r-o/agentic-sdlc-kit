/**
 * Edits JSON text in place. A small scanner records where every object member and array element sits
 * in the source, and the helpers here turn one change into one splice (`start`, `end`, `text`) that
 * touches only the bytes of that change. Everything else in the file (inline arrays, blank lines,
 * `é` escapes, `1.0`, `1e3`, integers beyond 2^53, line endings) is never parsed and re-written, so
 * it comes back byte for byte.
 *
 * The scanner expects text that `JSON.parse` already accepted; it throws a plain `Error` on anything
 * else, and the caller turns that into its own message.
 */

export interface JsonMember {
  key: string;
  /** Offset of the opening quote of the key. */
  start: number;
  /** Offset just after the value. */
  end: number;
  value: JsonNode;
}

export interface ObjectNode {
  kind: 'object';
  /** Offset of `{`. */
  start: number;
  /** Offset just after `}`. */
  end: number;
  members: JsonMember[];
}

export interface ArrayNode {
  kind: 'array';
  start: number;
  end: number;
  elements: JsonNode[];
}

export interface ScalarNode {
  kind: 'scalar';
  start: number;
  end: number;
}

export type JsonNode = ObjectNode | ArrayNode | ScalarNode;

const WHITESPACE = ' \t\n\r';
const DELIMITERS = `,]}${WHITESPACE}`;

/** Scans a JSON text whose top level is an object. */
export function scanJsonObject(text: string): ObjectNode {
  let pos = 0;
  const fail = (what: string): never => {
    throw new Error(`unexpected ${what} at offset ${pos}`);
  };
  const skipWhitespace = (): void => {
    while (pos < text.length && WHITESPACE.includes(text.charAt(pos))) pos += 1;
  };
  const skipString = (): void => {
    pos += 1;
    for (;;) {
      const ch = text.charAt(pos);
      if (ch === '') fail('end of text in a string');
      if (ch === '\\') pos += 2;
      else if (ch === '"') {
        pos += 1;
        return;
      } else pos += 1;
    }
  };

  const readValue = (): JsonNode => {
    skipWhitespace();
    const start = pos;
    const ch = text.charAt(pos);
    if (ch === '{') {
      pos += 1;
      const members: JsonMember[] = [];
      skipWhitespace();
      if (text.charAt(pos) === '}') {
        pos += 1;
        return { kind: 'object', start, end: pos, members };
      }
      for (;;) {
        skipWhitespace();
        if (text.charAt(pos) !== '"') fail('token');
        const keyStart = pos;
        skipString();
        const key: unknown = JSON.parse(text.slice(keyStart, pos));
        skipWhitespace();
        if (text.charAt(pos) !== ':') fail('token');
        pos += 1;
        const value = readValue();
        members.push({ key: String(key), start: keyStart, end: value.end, value });
        skipWhitespace();
        const next = text.charAt(pos);
        pos += 1;
        if (next === '}') return { kind: 'object', start, end: pos, members };
        if (next !== ',') {
          pos -= 1;
          fail('token');
        }
      }
    }
    if (ch === '[') {
      pos += 1;
      const elements: JsonNode[] = [];
      skipWhitespace();
      if (text.charAt(pos) === ']') {
        pos += 1;
        return { kind: 'array', start, end: pos, elements };
      }
      for (;;) {
        elements.push(readValue());
        skipWhitespace();
        const next = text.charAt(pos);
        pos += 1;
        if (next === ']') return { kind: 'array', start, end: pos, elements };
        if (next !== ',') {
          pos -= 1;
          fail('token');
        }
      }
    }
    if (ch === '"') {
      skipString();
      return { kind: 'scalar', start, end: pos };
    }
    while (pos < text.length && !DELIMITERS.includes(text.charAt(pos))) pos += 1;
    if (pos === start) fail('token');
    return { kind: 'scalar', start, end: pos };
  };

  const root = readValue();
  skipWhitespace();
  if (pos !== text.length) fail('text after the value');
  if (root.kind !== 'object') fail('top-level value (an object is required)');
  return root as ObjectNode;
}

/** The member with `key`; with duplicate keys the last one, which is the one `JSON.parse` keeps. */
export function findMember(object: ObjectNode, key: string): JsonMember | undefined {
  for (let i = object.members.length - 1; i >= 0; i--) {
    const member = object.members[i];
    if (member?.key === key) return member;
  }
  return undefined;
}

export interface Located {
  /** `chain[k]` is the object at `pointer[0..k-1]`; `chain[0]` is the root. It ends where the objects do. */
  chain: ObjectNode[];
  /** `holders[k - 1]` is the member whose value is `chain[k]`. */
  holders: JsonMember[];
  /** The member at the whole pointer; `undefined` when a step is missing or is not an object. */
  leaf?: JsonMember;
}

export function locate(root: ObjectNode, pointer: string[]): Located {
  const chain: ObjectNode[] = [root];
  const holders: JsonMember[] = [];
  let node = root;
  for (let i = 0; i < pointer.length; i++) {
    const member = findMember(node, pointer[i] as string);
    if (member === undefined) return { chain, holders };
    if (i === pointer.length - 1) return { chain, holders, leaf: member };
    if (member.value.kind !== 'object') return { chain, holders };
    holders.push(member);
    chain.push(member.value);
    node = member.value;
  }
  return { chain, holders };
}

// --- edits ----------------------------------------------------------------------------------------

/** Replace `text[start, end)` with `text`. */
export interface Splice {
  start: number;
  end: number;
  text: string;
}

export const applySplice = (source: string, splice: Splice): string =>
  source.slice(0, splice.start) + splice.text + source.slice(splice.end);

/** The indentation unit for what the kit writes, and the line ending of the file. */
export interface Layout {
  indent: string;
  eol: string;
}

const lineStart = (text: string, pos: number): number => (pos === 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1);

/** The leading whitespace of the line that `pos` is on. */
export const lineIndent = (text: string, pos: number): string => /^[ \t]*/.exec(text.slice(lineStart(text, pos)))?.[0] ?? '';

/** The whitespace before `pos` when only whitespace precedes it on its line, else `undefined`. */
export function ownLineIndent(text: string, pos: number): string | undefined {
  const prefix = text.slice(lineStart(text, pos), pos);
  return /^[ \t]*$/.test(prefix) ? prefix : undefined;
}

/**
 * A value as the kit writes it: `JSON.stringify` with `layout.indent`, every line after the first
 * moved to `indent` (the indentation of the line the value starts on), or on one line when not `multiline`.
 */
export function renderValue(value: unknown, layout: Layout, indent: string, multiline: boolean): string {
  if (!multiline) return JSON.stringify(value) ?? 'null';
  return (JSON.stringify(value, null, layout.indent) ?? 'null').split('\n').join(layout.eol + indent);
}

const entriesOf = (container: ObjectNode | ArrayNode): Array<{ start: number; end: number }> =>
  container.kind === 'object' ? container.members : container.elements;

/**
 * Adds one entry (an object member or an array element) after the last one. `render(multiline, indent)`
 * gives its text. The layout follows the container: when an entry already sits first on its line, the
 * new one goes on its own line with that indentation; when all entries share a line, it is added on
 * that line; an empty container is spread over lines (one more level than the line its bracket is on)
 * when `multilineWhenEmpty`, else it stays on one line.
 */
export function appendEntry(
  text: string,
  container: ObjectNode | ArrayNode,
  layout: Layout,
  multilineWhenEmpty: boolean,
  render: (multiline: boolean, indent: string) => string,
): Splice {
  const entries = entriesOf(container);
  const last = entries[entries.length - 1];
  if (last === undefined) {
    const inner = { start: container.start + 1, end: container.end - 1 };
    if (!multilineWhenEmpty) return { ...inner, text: render(false, '') };
    const base = lineIndent(text, container.start);
    const indent = base + layout.indent;
    return { ...inner, text: `${layout.eol}${indent}${render(true, indent)}${layout.eol}${base}` };
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const indent = ownLineIndent(text, (entries[i] as { start: number }).start);
    if (indent !== undefined) return { start: last.end, end: last.end, text: `,${layout.eol}${indent}${render(true, indent)}` };
  }
  return { start: last.end, end: last.end, text: `, ${render(false, '')}` };
}

/**
 * Removes entry `index` with its separating comma. The last remaining entry leaves the container
 * empty (`{}` or `[]`).
 */
export function removeEntry(container: ObjectNode | ArrayNode, index: number): Splice {
  const entries = entriesOf(container);
  const entry = entries[index];
  if (entry === undefined) throw new Error(`no entry ${index}`);
  if (entries.length === 1) return { start: container.start + 1, end: container.end - 1, text: '' };
  const next = entries[index + 1];
  if (next !== undefined) return { start: entry.start, end: next.start, text: '' };
  const previous = entries[index - 1] as { end: number };
  return { start: previous.end, end: entry.end, text: '' };
}

/**
 * Replaces the value of `member`. It keeps the member's shape: spread over lines when the old value
 * was (or when it was a scalar and the member sits on its own line), on one line otherwise.
 */
export function replaceMemberValue(text: string, member: JsonMember, value: unknown, layout: Layout): Splice {
  const { start, end, kind } = member.value;
  const multiline = text.slice(start, end).includes('\n') || (kind === 'scalar' && ownLineIndent(text, member.start) !== undefined);
  return { start, end, text: renderValue(value, layout, lineIndent(text, start), multiline) };
}
