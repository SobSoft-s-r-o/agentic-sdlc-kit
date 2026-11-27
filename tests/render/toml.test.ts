import { describe, expect, it } from 'vitest';
import { tomlMultilineString, tomlString } from '../../src/render/toml.js';

const SHORT_ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

/** A reader for the strings the writers produce: strips the delimiters and decodes the escapes. */
function decode(literal: string, multiline = false): string {
  const delimiter = multiline ? '"""' : '"';
  expect(literal.startsWith(delimiter)).toBe(true);
  expect(literal.endsWith(delimiter)).toBe(true);
  let inner = literal.slice(delimiter.length, literal.length - delimiter.length);
  // A newline right after the opening delimiter is not part of the value.
  if (multiline && inner.startsWith('\n')) inner = inner.slice(1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = inner[++i]!;
    if (next === 'u') {
      out += String.fromCharCode(parseInt(inner.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (next === 'U') {
      out += String.fromCodePoint(parseInt(inner.slice(i + 1, i + 9), 16));
      i += 8;
    } else {
      const decoded = SHORT_ESCAPES[next];
      if (decoded === undefined) throw new Error(`bad escape \\${next}`);
      out += decoded;
    }
  }
  return out;
}

describe('tomlString', () => {
  it('writes a plain string in double quotes', () => {
    expect(tomlString('sdlc-analyst')).toBe('"sdlc-analyst"');
    expect(tomlString('')).toBe('""');
  });

  it('escapes the quote, the backslash and the control characters', () => {
    expect(tomlString('say "hi"')).toBe('"say \\"hi\\""');
    expect(tomlString('C:\\temp')).toBe('"C:\\\\temp"');
    expect(tomlString('a\nb\tc\rd\be\ff')).toBe('"a\\nb\\tc\\rd\\be\\ff"');
    expect(tomlString('\u0000\u001f\u007f')).toBe('"\\u0000\\u001F\\u007F"');
  });

  it('never lets a raw newline or control character into the output', () => {
    for (let code = 0; code < 0x20; code++) {
      expect(tomlString(`a${String.fromCharCode(code)}b`)).toMatch(/^"[^\u0000-\u001f\u007f]*"$/);
    }
  });

  it('keeps non-ASCII text as it is', () => {
    expect(tomlString('Ľúbo, žltý kôň, 日本語, 😀')).toBe('"Ľúbo, žltý kôň, 日本語, 😀"');
  });

  it('round-trips every ASCII character and some hard strings', () => {
    const all = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)).join('');
    for (const value of [all, '"""', '\\"', '\\\\n', '\\u0041', 'x"\\\n"y', '😀\u2028\u0085']) {
      expect(decode(tomlString(value))).toBe(value);
    }
  });

  it('refuses a lone surrogate, which TOML cannot hold', () => {
    expect(() => tomlString('a\uD800b')).toThrow(/surrogate/);
    expect(() => tomlString('\uDC00')).toThrow(/surrogate/);
    expect(() => tomlString('ok 😀')).not.toThrow();
  });
});

describe('tomlMultilineString', () => {
  it('opens on its own line, and the value is exactly what is between the delimiters', () => {
    expect(tomlMultilineString('one\ntwo\n')).toBe('"""\none\ntwo\n"""');
    expect(tomlMultilineString('one\ntwo')).toBe('"""\none\ntwo"""');
    expect(decode(tomlMultilineString('\nstarts with a newline\n'), true)).toBe('\nstarts with a newline\n');
  });

  it('keeps newlines raw, escapes backslashes and control characters', () => {
    const out = tomlMultilineString('a\\b\nc\td\u0001e\r\n');
    expect(out).toBe('"""\na\\\\b\nc\td\\u0001e\\r\n"""');
  });

  it('allows one or two quotes in a row, also at the end of a line and of the value', () => {
    for (const value of ['say "hi" and ""\nthen "\n', 'ends with a quote"', 'ends with two ""']) {
      expect(tomlMultilineString(value)).toBe(`"""\n${value}"""`);
      expect(decode(tomlMultilineString(value), true)).toBe(value);
    }
  });

  it('refuses three quotes in a row', () => {
    expect(() => tomlMultilineString('a """ b')).toThrow('"""');
    expect(() => tomlMultilineString('""""')).toThrow('"""');
  });

  it('round-trips text with a trailing newline and backslashes before a newline', () => {
    for (const value of ['line\\\nnext\n', 'a\n\n\nb\n', 'tab\there\n']) {
      expect(decode(tomlMultilineString(value), true)).toBe(value);
    }
  });

  it('refuses a lone surrogate', () => {
    expect(() => tomlMultilineString('a\uD800b')).toThrow(/surrogate/);
  });
});
