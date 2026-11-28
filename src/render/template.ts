/**
 * A tiny template engine for the files `sdlc init` renders (instruction blocks, agents, skills).
 *
 * Syntax:
 * - `{{path.to.value}}` prints a string or a number. Anything else (array, object, boolean, null)
 *   is an error, so a template bug cannot leak `[object Object]` into a generated file.
 * - `{{#if path}}…{{else}}…{{/if}}` and `{{#unless path}}…{{else}}…{{/unless}}`. Truthy: a
 *   non-empty string, array or object, `true`, a non-zero number. `else` is optional.
 * - `{{#each path}}…{{/each}}` over an array.
 * - Blocks nest. A missing path is an error, never an empty string.
 * - A line that holds only a block tag (`#if`, `else`, `/if`, `#unless`, `/unless`, `#each`,
 *   `/each`), with optional spaces or tabs around it, is removed together with its newline. Value
 *   tags are never standalone.
 *
 * Paths and scope. Inside `each`, the innermost item is "the current item":
 * - `.` is the current item; a bare `item` is the same.
 * - `item.field` reads from the current item (it shadows a root key called `item`).
 * - `@root.path` reads from the root data, in or out of `each`.
 * - Any other path resolves against the current item first when that item is a plain object that
 *   has the path's first key as its own property; otherwise it resolves against the root.
 * Outside `each`, `.` is unknown and every other path resolves against the root. Lookups only see
 * own properties of plain objects, so `constructor` or `__proto__.x` are unknown values.
 *
 * Escape. A backslash directly before `{{` (`\{{`) drops the backslash and makes the `{{` literal
 * text; nothing from there up to and including the next `}}` is parsed or evaluated, so
 * `$\{{ secrets.X }}` renders `${{ secrets.X }}` (GitHub Actions expressions). Without a later
 * `}}`, only the `{{` is literal. A tag the escape swallows does not count as a block tag, and a
 * line holding one is never standalone. A backslash anywhere else is plain text, and there is no
 * way to write a literal backslash right before a real tag.
 *
 * Parsing is one pass over the source into a tree; evaluation walks the tree.
 */

/** A template that cannot be parsed or evaluated; the message starts with the template's name. */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

type Block = 'if' | 'unless' | 'each';

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'value'; path: string; line: number }
  | { kind: 'if'; negate: boolean; path: string; line: number; then: Node[]; otherwise: Node[] }
  | { kind: 'each'; path: string; line: number; body: Node[] };

type Tag =
  | { kind: 'value'; path: string }
  | { kind: 'open'; block: Block; path: string }
  | { kind: 'else' }
  | { kind: 'close'; block: Block };

/** An open block while parsing: where its content goes now, and where it was opened. */
interface Frame {
  block: Block;
  path: string;
  line: number;
  out: Node[];
  otherwise: Node[] | undefined;
  inElse: boolean;
}

const SEGMENT = '[A-Za-z0-9_-]+';
const PATH = new RegExp(`^(?:\\.|@root(?:\\.${SEGMENT})*|${SEGMENT}(?:\\.${SEGMENT})*)$`);
const BLOCKS: readonly string[] = ['if', 'unless', 'each'];

const isBlock = (name: string): name is Block => BLOCKS.includes(name);

/** The text of an opening tag, for messages. */
const openText = (block: Block, path: string): string => `{{#${block} ${path}}}`;

/** Reads one tag's trimmed inner text; `undefined` when it is not a valid tag. Throws on an unknown block name. */
function classify(raw: string, fail: (message: string) => TemplateError, line: number): Tag | undefined {
  if (raw === 'else') return { kind: 'else' };
  if (raw.startsWith('/')) {
    const block = raw.slice(1);
    return isBlock(block) ? { kind: 'close', block } : undefined;
  }
  if (raw.startsWith('#')) {
    const match = /^#(\S+)\s+(\S+)$/.exec(raw);
    if (!match) return undefined;
    const [, block = '', path = ''] = match;
    if (!isBlock(block)) throw fail(`unknown block "#${block}" at line ${line}`);
    return PATH.test(path) ? { kind: 'open', block, path } : undefined;
  }
  return PATH.test(raw) ? { kind: 'value', path: raw } : undefined;
}

/**
 * When the tag at `[start, end)` is alone on its line (only spaces or tabs around it), the index
 * where the next line starts and the index where the removed whitespace before the tag begins;
 * otherwise `undefined`.
 */
function standalone(source: string, start: number, end: number): { resume: number; cut: number } | undefined {
  let cut = start;
  while (cut > 0 && (source[cut - 1] === ' ' || source[cut - 1] === '\t')) cut--;
  if (cut > 0 && source[cut - 1] !== '\n') return undefined;
  let after = end;
  while (after < source.length && (source[after] === ' ' || source[after] === '\t')) after++;
  if (after === source.length) return { resume: after, cut };
  if (source[after] === '\n') return { resume: after + 1, cut };
  if (source[after] === '\r' && source[after + 1] === '\n') return { resume: after + 2, cut };
  return undefined;
}

function countNewlines(source: string, from: number, to: number): number {
  let count = 0;
  for (let i = source.indexOf('\n', from); i !== -1 && i < to; i = source.indexOf('\n', i + 1)) count++;
  return count;
}

function parse(source: string, name: string): Node[] {
  const fail = (message: string) => new TemplateError(`${name}: ${message}`);
  const root: Node[] = [];
  const stack: Frame[] = [];
  let out = root;
  let textStart = 0;
  let line = 1;
  let counted = 0;

  const pushText = (end: number) => {
    if (end > textStart) out.push({ kind: 'text', text: source.slice(textStart, end) });
  };

  for (let open = source.indexOf('{{'); open !== -1; open = source.indexOf('{{', textStart)) {
    if (open > 0 && source[open - 1] === '\\') {
      // Escaped: keep `{{` and everything through the next `}}` as text, without the backslash.
      pushText(open - 1);
      const swallowed = source.indexOf('}}', open + 2);
      const literalEnd = swallowed === -1 ? open + 2 : swallowed + 2;
      out.push({ kind: 'text', text: source.slice(open, literalEnd) });
      textStart = literalEnd;
      continue;
    }
    line += countNewlines(source, counted, open);
    counted = open;
    const close = source.indexOf('}}', open + 2);
    if (close === -1) throw fail(`unclosed tag "{{" at line ${line}`);
    const raw = source.slice(open + 2, close).trim();
    const end = close + 2;
    const tag = classify(raw, fail, line);
    if (!tag) throw fail(`invalid tag "{{${raw}}}" at line ${line}`);

    const alone = tag.kind === 'value' ? undefined : standalone(source, open, end);
    pushText(alone ? alone.cut : open);
    textStart = alone ? alone.resume : end;

    if (tag.kind === 'value') {
      out.push({ kind: 'value', path: tag.path, line });
    } else if (tag.kind === 'open') {
      const frame: Frame = { block: tag.block, path: tag.path, line, out: [], otherwise: undefined, inElse: false };
      if (tag.block === 'each') {
        out.push({ kind: 'each', path: tag.path, line, body: frame.out });
      } else {
        frame.otherwise = [];
        out.push({ kind: 'if', negate: tag.block === 'unless', path: tag.path, line, then: frame.out, otherwise: frame.otherwise });
      }
      stack.push(frame);
      out = frame.out;
    } else if (tag.kind === 'else') {
      const top = stack[stack.length - 1];
      if (!top || !top.otherwise) throw fail(`unexpected {{else}} at line ${line}`);
      if (top.inElse) throw fail(`duplicate {{else}} at line ${line}`);
      top.inElse = true;
      top.out = top.otherwise;
      out = top.out;
    } else {
      const top = stack[stack.length - 1];
      if (!top) throw fail(`unexpected {{/${tag.block}}} at line ${line}`);
      if (top.block !== tag.block) {
        throw fail(
          `{{/${tag.block}}} at line ${line} does not match ${openText(top.block, top.path)} opened at line ${top.line}`,
        );
      }
      stack.pop();
      out = stack.length > 0 ? stack[stack.length - 1]!.out : root;
    }
  }

  pushText(source.length);
  const unclosed = stack[stack.length - 1];
  if (unclosed) throw fail(`unclosed ${openText(unclosed.block, unclosed.path)} opened at line ${unclosed.line}`);
  return root;
}

const MISSING = Symbol('missing');

interface Scope {
  /** The innermost `each` item; meaningful only when `inEach`. */
  item: unknown;
  inEach: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOwn = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

function walk(start: unknown, keys: string[]): unknown {
  let value = start;
  for (const key of keys) {
    if (!isRecord(value) || !hasOwn(value, key)) return MISSING;
    value = value[key];
  }
  return value === undefined ? MISSING : value;
}

function resolve(path: string, root: Record<string, unknown>, scope: Scope): unknown {
  if (path === '.') return scope.inEach && scope.item !== undefined ? scope.item : MISSING;
  const keys = path.split('.');
  const first = keys[0]!;
  if (first === '@root') return walk(root, keys.slice(1));
  if (scope.inEach) {
    if (first === 'item') return walk(scope.item, keys.slice(1));
    if (isRecord(scope.item) && hasOwn(scope.item, first)) return walk(scope.item, keys);
  }
  return walk(root, keys);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

function truthy(value: unknown): boolean {
  if (typeof value === 'string' || Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (isRecord(value)) return Object.keys(value).length > 0;
  return value === true;
}

function evaluate(nodes: Node[], root: Record<string, unknown>, scope: Scope, name: string): string {
  const fail = (message: string) => new TemplateError(`${name}: ${message}`);
  const lookup = (path: string, line: number): unknown => {
    const value = resolve(path, root, scope);
    if (value === MISSING) throw fail(`unknown value "${path}" at line ${line}`);
    return value;
  };

  let result = '';
  for (const node of nodes) {
    if (node.kind === 'text') {
      result += node.text;
    } else if (node.kind === 'value') {
      const value = lookup(node.path, node.line);
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw fail(`value "${node.path}" is ${describe(value)}, not a string or number at line ${node.line}`);
      }
      result += String(value);
    } else if (node.kind === 'if') {
      const branch = truthy(lookup(node.path, node.line)) !== node.negate ? node.then : node.otherwise;
      result += evaluate(branch, root, scope, name);
    } else {
      const items = lookup(node.path, node.line);
      if (!Array.isArray(items)) throw fail(`"${node.path}" is ${describe(items)}, not an array at line ${node.line}`);
      for (const item of items as unknown[]) result += evaluate(node.body, root, { item, inEach: true }, name);
    }
  }
  return result;
}

/**
 * Renders `source` with `data`. `name` identifies the template in error messages
 * (`<name>: unknown value "<path>" at line <n>`); it is not read from disk.
 */
export function renderTemplate(source: string, data: Record<string, unknown>, name: string): string {
  return evaluate(parse(source, name), data, { item: undefined, inEach: false }, name);
}
