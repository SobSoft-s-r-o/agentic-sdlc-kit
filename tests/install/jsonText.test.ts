import { describe, expect, it } from 'vitest';
import {
  appendEntry,
  applySplice,
  findMember,
  locate,
  removeEntry,
  scanJsonObject,
  type ArrayNode,
  type Layout,
  type ObjectNode,
} from '../../src/install/jsonText.js';

const LF: Layout = { indent: '  ', eol: '\n' };
const slice = (text: string, node: { start: number; end: number }): string => text.slice(node.start, node.end);

describe('scanJsonObject', () => {
  it('records the source span of every member and value, whitespace and number spellings included', () => {
    const text = '{ "a" : 1.0 ,\n  "b":[ 1e3, "x\\"]" , {"c":null} ],"d":{}}';
    const root = scanJsonObject(text);
    expect(root.members.map(m => m.key)).toEqual(['a', 'b', 'd']);
    expect(slice(text, root)).toBe(text);
    const [a, b, d] = root.members;
    expect(slice(text, a!.value)).toBe('1.0');
    expect(slice(text, a!)).toBe('"a" : 1.0');
    const array = b!.value as ArrayNode;
    expect(array.elements.map(e => slice(text, e))).toEqual(['1e3', '"x\\"]"', '{"c":null}']);
    expect(slice(text, d!.value)).toBe('{}');
  });

  it('decodes keys (an escaped key is the same key) and a duplicate key resolves to the last one', () => {
    const text = '{"caf\\u00e9": 1, "k": 1, "k": 2}';
    const root = scanJsonObject(text);
    expect(findMember(root, 'café')?.key).toBe('café');
    expect(slice(text, findMember(root, 'k')!.value)).toBe('2');
  });

  it('keeps big integers, literals and negative numbers as one token each', () => {
    const text = '{"n":12345678901234567890,"t":true,"f":false,"z":null,"m":-0.5E+2}';
    const root = scanJsonObject(text);
    expect(root.members.map(m => slice(text, m.value))).toEqual(['12345678901234567890', 'true', 'false', 'null', '-0.5E+2']);
  });

  it('rejects what is not a JSON object', () => {
    for (const bad of ['[1]', '"x"', '{"a":1', '{"a" 1}', '{"a":1,}x', '{a:1}', '{"a":1} x', '{"a":"x', '']) {
      expect(() => scanJsonObject(bad)).toThrow();
    }
  });
});

describe('locate', () => {
  const text = '{"a":{"b":{"c":1}},"arr":[1]}';
  const root = scanJsonObject(text);

  it('returns the objects on the way, the members that hold them and the leaf', () => {
    const found = locate(root, ['a', 'b', 'c']);
    expect(found.chain).toHaveLength(3);
    expect(found.holders.map(h => h.key)).toEqual(['a', 'b']);
    expect(slice(text, found.leaf!.value)).toBe('1');
  });

  it('stops at a missing step or at a value that is not an object', () => {
    expect(locate(root, ['a', 'x', 'y']).leaf).toBeUndefined();
    expect(locate(root, ['arr', 'x']).leaf).toBeUndefined();
    expect(locate(root, ['arr']).leaf?.value.kind).toBe('array');
  });
});

describe('appendEntry and removeEntry', () => {
  const render = (value: string) => (): string => value;

  it('appends on its own line with the indentation of an existing entry that starts a line', () => {
    const text = '{\n    "a": 1,\n    "b": 2\n}';
    const root = scanJsonObject(text);
    const out = applySplice(text, appendEntry(text, root, LF, true, (_m, indent) => `"c":${indent.length}`));
    expect(out).toBe('{\n    "a": 1,\n    "b": 2,\n    "c":4\n}');
  });

  it('appends on the same line when the entries share one', () => {
    const text = '{"a":1, "b":2}';
    const root = scanJsonObject(text);
    expect(applySplice(text, appendEntry(text, root, LF, true, render('"c":3')))).toBe('{"a":1, "b":2, "c":3}');
  });

  it('spreads an empty container over lines or keeps it on one line', () => {
    const text = '{\n  "a": {  }\n}';
    const inner = scanJsonObject(text).members[0]!.value as ObjectNode;
    expect(applySplice(text, appendEntry(text, inner, LF, true, render('"x":1')))).toBe('{\n  "a": {\n    "x":1\n  }\n}');
    expect(applySplice(text, appendEntry(text, inner, LF, false, render('"x":1')))).toBe('{\n  "a": {"x":1}\n}');
  });

  it('uses the file\'s line ending', () => {
    const crlf: Layout = { indent: '\t', eol: '\r\n' };
    const text = '{\r\n\t"a": 1\r\n}';
    const out = applySplice(text, appendEntry(text, scanJsonObject(text), crlf, true, render('"b": 2')));
    expect(out).toBe('{\r\n\t"a": 1,\r\n\t"b": 2\r\n}');
  });

  it('removes the first, a middle and the last entry with one separating comma, and the only one to an empty container', () => {
    const text = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}';
    const root = scanJsonObject(text);
    expect(applySplice(text, removeEntry(root, 0))).toBe('{\n  "b": 2,\n  "c": 3\n}');
    expect(applySplice(text, removeEntry(root, 1))).toBe('{\n  "a": 1,\n  "c": 3\n}');
    expect(applySplice(text, removeEntry(root, 2))).toBe('{\n  "a": 1,\n  "b": 2\n}');
    const one = '{ "a": 1 }';
    expect(applySplice(one, removeEntry(scanJsonObject(one), 0))).toBe('{}');
  });

  it('removes array elements the same way', () => {
    const text = '{"a": [1, 2, 3]}';
    const array = scanJsonObject(text).members[0]!.value as ArrayNode;
    expect(applySplice(text, removeEntry(array, 0))).toBe('{"a": [2, 3]}');
    expect(applySplice(text, removeEntry(array, 2))).toBe('{"a": [1, 2]}');
  });
});
