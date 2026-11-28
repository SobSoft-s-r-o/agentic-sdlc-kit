import { describe, expect, it } from 'vitest';
import { emitFrontMatter, parseFrontMatter } from '../../src/render/frontMatter.js';

const AGENT = [
  '---',
  'name: sdlc-developer',
  'description: Implements one task end to end; reports what it changed, and why.',
  'model: sonnet',
  '---',
  '# Developer',
  '',
  'Body text with --- inside it.',
  '',
].join('\n');

describe('parseFrontMatter', () => {
  it('splits the YAML header from the body and keeps key order', () => {
    const { data, body } = parseFrontMatter(AGENT);
    expect(Object.keys(data)).toEqual(['name', 'description', 'model']);
    expect(data).toEqual({
      name: 'sdlc-developer',
      description: 'Implements one task end to end; reports what it changed, and why.',
      model: 'sonnet',
    });
    expect(body).toBe('# Developer\n\nBody text with --- inside it.\n');
  });

  it('returns empty data and the whole text when there is no front matter', () => {
    expect(parseFrontMatter('# Title\n\ntext\n')).toEqual({ data: {}, body: '# Title\n\ntext\n' });
    expect(parseFrontMatter('')).toEqual({ data: {}, body: '' });
  });

  it('reads an empty header and keeps a blank line that starts the body', () => {
    expect(parseFrontMatter('---\n---\nbody\n')).toEqual({ data: {}, body: 'body\n' });
    expect(parseFrontMatter('---\nname: a\n---\n\nbody\n').body).toBe('\nbody\n');
  });

  it('reads nested values, lists and CRLF line endings', () => {
    const { data, body } = parseFrontMatter('---\r\nname: a\r\ntools:\r\n  - Read\r\n  - Bash\r\nmeta:\r\n  tier: 2\r\n---\r\nbody\r\n');
    expect(data).toEqual({ name: 'a', tools: ['Read', 'Bash'], meta: { tier: 2 } });
    expect(body).toBe('body\r\n');
  });

  it('errors when the header is not closed, is not a mapping, or is not valid YAML', () => {
    expect(() => parseFrontMatter('---\nname: a\nbody\n')).toThrow('front matter is not closed');
    expect(() => parseFrontMatter('---\n- a\n- b\n---\nbody')).toThrow('front matter must be a YAML mapping');
    expect(() => parseFrontMatter('---\njust a string\n---\nbody')).toThrow('front matter must be a YAML mapping');
    expect(() => parseFrontMatter('---\nname: [unclosed\n---\nbody')).toThrow('invalid front matter');
    expect(() => parseFrontMatter('---\nname: a\nname: b\n---\nbody')).toThrow('invalid front matter');
  });
});

describe('emitFrontMatter', () => {
  it('writes the header, then the body', () => {
    expect(emitFrontMatter({ name: 'a', model: 'opus' }, 'text\n')).toBe('---\nname: a\nmodel: opus\n---\ntext\n');
  });

  it('keeps key order and does not fold long lines', () => {
    const description = 'word '.repeat(60).trim();
    const out = emitFrontMatter({ z: 1, a: 2, description }, 'b');
    expect(out).toBe(`---\nz: 1\na: 2\ndescription: ${description}\n---\nb`);
  });

  it('quotes values that need it and writes an empty header for no data', () => {
    expect(emitFrontMatter({ description: 'Use when: asked' }, '')).toBe('---\ndescription: "Use when: asked"\n---\n');
    expect(emitFrontMatter({}, 'body\n')).toBe('---\n---\nbody\n');
  });
});

describe('round trip', () => {
  it('parse then emit is byte-identical for name, description and model', () => {
    const { data, body } = parseFrontMatter(AGENT);
    expect(emitFrontMatter(data, body)).toBe(AGENT);
  });

  it('is byte-identical for a long description and a list', () => {
    const text = `---\nname: sdlc-reviewer\ndescription: ${'long '.repeat(40).trim()}\nmodel: opus\ntools:\n  - Read\n  - Grep\n---\nBody\n`;
    const { data, body } = parseFrontMatter(text);
    expect(emitFrontMatter(data, body)).toBe(text);
  });

  it('parse of an emitted header returns the same data', () => {
    const data = { name: 'x', description: 'Use when: a, b; c "d"', n: 3, flag: true };
    expect(parseFrontMatter(emitFrontMatter(data, 'b\n'))).toEqual({ data, body: 'b\n' });
  });
});
