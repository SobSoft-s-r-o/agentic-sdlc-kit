import { parse, stringify } from 'yaml';

const OPEN = /^---[ \t]*\r?\n/;

/**
 * Splits `text` into its YAML front matter and the rest. Front matter is a first line `---`, YAML,
 * and a closing line `---`; the body is everything after the closing line's newline, byte for byte.
 * Text without front matter gives `{ data: {}, body: text }`. Key order is the file's order.
 * Throws when the header is not closed, is not valid YAML (a duplicate key counts), or is not a
 * mapping.
 */
export function parseFrontMatter(text: string): { data: Record<string, unknown>; body: string } {
  const opening = OPEN.exec(text);
  if (!opening) return { data: {}, body: text };

  const headerStart = opening[0].length;
  let lineStart = headerStart;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    if (/^---[ \t]*\r?$/.test(text.slice(lineStart, lineEnd))) {
      return { data: parseHeader(text.slice(headerStart, lineStart)), body: newline === -1 ? '' : text.slice(newline + 1) };
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  throw new Error('front matter is not closed: expected a closing "---" line');
}

function parseHeader(yaml: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = parse(yaml);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid front matter: ${reason}`, { cause: error });
  }
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('front matter must be a YAML mapping');
  return value as Record<string, unknown>;
}

/**
 * `---`, the YAML for `data` in its key order (long lines are not folded), `---`, then `body`.
 * Empty `data` gives an empty header. `parseFrontMatter` then `emitFrontMatter` returns the same
 * text for LF files whose YAML is already in the form the `yaml` package writes.
 */
export function emitFrontMatter(data: Record<string, unknown>, body: string): string {
  const header = Object.keys(data).length === 0 ? '' : stringify(data, { lineWidth: 0 });
  return `---\n${header}---\n${body}`;
}
