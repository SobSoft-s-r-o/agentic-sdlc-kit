/**
 * TOML string writers for the files the kit renders (`.codex/agents/*.toml` and, in Task 6, the
 * `.codex/config.toml` block). Both write basic strings: double quoted, with escapes.
 */

const SHORT_ESCAPES: Record<string, string> = {
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\f': '\\f',
  '\r': '\\r',
  '"': '\\"',
  '\\': '\\\\',
};

/** A UTF-16 surrogate with no partner: not a Unicode scalar value, so TOML cannot hold it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const unicodeEscape = (ch: string): string => `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

function assertScalarValues(value: string): void {
  if (LONE_SURROGATE.test(value)) throw new Error('a TOML string cannot hold a lone surrogate');
}

/**
 * `value` as a TOML basic string on one line: `"` and `\` are escaped, so are the control
 * characters (short escapes where TOML has them, `\uXXXX` otherwise, DEL included). Everything
 * else, non-ASCII text too, is written as it is.
 */
export function tomlString(value: string): string {
  assertScalarValues(value);
  const body = value.replace(/[\u0000-\u001f"\\\u007f]/g, ch => SHORT_ESCAPES[ch] ?? unicodeEscape(ch));
  return `"${body}"`;
}

/**
 * `value` as a TOML multi-line basic string: `"""`, a newline, the text, `"""`. The newline after
 * the opening delimiter is not part of the value, so the value is exactly `value`; end `value`
 * with a newline to close the string on a line of its own. Newlines and tabs stay as they are,
 * backslashes and the other control characters are escaped. Three quotes in a row are an error
 * (they would end the string); one or two are fine.
 */
export function tomlMultilineString(value: string): string {
  assertScalarValues(value);
  if (value.includes('"""')) throw new Error('a TOML multi-line string cannot contain """');
  const body = value.replace(/[\u0000-\u0008\u000b-\u001f\\\u007f]/g, ch => SHORT_ESCAPES[ch] ?? unicodeEscape(ch));
  return `"""\n${body}"""`;
}
