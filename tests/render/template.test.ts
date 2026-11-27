import { describe, expect, it } from 'vitest';
import { renderTemplate, TemplateError } from '../../src/render/template.js';

const render = (source: string, data: Record<string, unknown> = {}) => renderTemplate(source, data, 't.md');

describe('values', () => {
  it('passes plain text through untouched', () => {
    expect(render('just text\nand more\n')).toBe('just text\nand more\n');
    expect(render('')).toBe('');
  });

  it('prints strings and numbers, by dotted path, with optional spaces in the tag', () => {
    const data = { name: 'sdlc', n: 0, cfg: { stack: { gate: 'npm test', retries: 3 } } };
    expect(render('{{name}} {{n}} {{cfg.stack.gate}} {{ cfg.stack.retries }}', data)).toBe('sdlc 0 npm test 3');
  });

  it('does not escape the value', () => {
    expect(render('{{v}}', { v: '<a href="x">&</a>' })).toBe('<a href="x">&</a>');
  });

  it('errors on an array, an object, a boolean and null', () => {
    expect(() => render('{{arr}}', { arr: ['a'] })).toThrow(TemplateError);
    expect(() => render('x\n{{arr}}', { arr: ['a'] })).toThrow(
      't.md: value "arr" is an array, not a string or number at line 2',
    );
    expect(() => render('{{o}}', { o: { a: 1 } })).toThrow('value "o" is an object');
    expect(() => render('{{b}}', { b: true })).toThrow('value "b" is a boolean');
    expect(() => render('{{z}}', { z: null })).toThrow('value "z" is null');
  });

  it('throws TemplateError with the name, the path and the line for an unknown value', () => {
    const source = 'line one\nline two\n{{cfg.missing}}\n';
    expect(() => render(source, { cfg: {} })).toThrow(TemplateError);
    expect(() => render(source, { cfg: {} })).toThrow('t.md: unknown value "cfg.missing" at line 3');
    expect(() => renderTemplate('{{a}}', {}, 'agents/x.md')).toThrow('agents/x.md: unknown value "a" at line 1');
  });

  it('does not resolve inherited properties', () => {
    expect(() => render('{{constructor}}')).toThrow('unknown value "constructor"');
    expect(() => render('{{__proto__.x}}')).toThrow('unknown value "__proto__.x"');
    expect(() => render('{{a.toString}}', { a: {} })).toThrow('unknown value "a.toString"');
  });

  it('treats an undefined value as unknown', () => {
    expect(() => render('{{a}}', { a: undefined })).toThrow('unknown value "a"');
  });
});

describe('if / else', () => {
  const truthy = (value: unknown) => render('{{#if v}}Y{{else}}N{{/if}}', { v: value });

  it('picks the branch by truthiness', () => {
    expect(truthy('text')).toBe('Y');
    expect(truthy(['a'])).toBe('Y');
    expect(truthy(true)).toBe('Y');
    expect(truthy(2)).toBe('Y');
    expect(truthy({ a: 1 })).toBe('Y');
    expect(truthy('')).toBe('N');
    expect(truthy([])).toBe('N');
    expect(truthy(false)).toBe('N');
    expect(truthy(0)).toBe('N');
    expect(truthy(null)).toBe('N');
    expect(truthy({})).toBe('N');
  });

  it('works without an else branch', () => {
    expect(render('a{{#if v}}b{{/if}}c', { v: true })).toBe('abc');
    expect(render('a{{#if v}}b{{/if}}c', { v: false })).toBe('ac');
  });

  it('errors on an unknown path, with the line', () => {
    expect(() => render('a\n{{#if nope}}x{{/if}}')).toThrow('t.md: unknown value "nope" at line 2');
  });

  it('only evaluates the branch that is taken', () => {
    expect(render('{{#if v}}ok{{else}}{{missing}}{{/if}}', { v: true })).toBe('ok');
  });
});

describe('unless', () => {
  it('renders when the value is falsy', () => {
    expect(render('{{#unless v}}no{{/unless}}', { v: false })).toBe('no');
    expect(render('{{#unless v}}no{{/unless}}', { v: [] })).toBe('no');
    expect(render('{{#unless v}}no{{/unless}}', { v: 'x' })).toBe('');
  });

  it('accepts an else branch', () => {
    expect(render('{{#unless v}}A{{else}}B{{/unless}}', { v: 1 })).toBe('B');
  });
});

describe('each', () => {
  it('iterates strings with {{.}}', () => {
    expect(render('{{#each xs}}[{{.}}]{{/each}}', { xs: ['a', 'b', 3] })).toBe('[a][b][3]');
  });

  it('renders nothing for an empty array', () => {
    expect(render('a{{#each xs}}x{{/each}}b', { xs: [] })).toBe('ab');
  });

  it('reads fields with {{item.field}} and with a bare field name', () => {
    const data = { roles: [{ role: 'dev', tier: 1 }, { role: 'qa', tier: 2 }] };
    expect(render('{{#each roles}}{{item.role}}:{{item.tier}};{{/each}}', data)).toBe('dev:1;qa:2;');
    expect(render('{{#each roles}}{{role}}/{{tier}};{{/each}}', data)).toBe('dev/1;qa/2;');
  });

  it('keeps the root reachable as @root, with and without a dotted path', () => {
    const data = { title: 'Team', cfg: { lang: 'en' }, xs: ['a', 'b'] };
    expect(render('{{#each xs}}{{@root.title}}-{{.}}-{{@root.cfg.lang}};{{/each}}', data)).toBe(
      'Team-a-en;Team-b-en;',
    );
    expect(render('{{@root.title}}', data)).toBe('Team');
  });

  it('resolves another path against the item first, when it is an object with that first key, else the root', () => {
    const data = { shared: 'S', role: 'ROOT-ROLE', xs: [{ role: 'item-role' }, { other: 1 }] };
    // First item has `role`; the second has not, so `role` falls back to the root value.
    expect(render('{{#each xs}}{{role}} {{shared}};{{/each}}', data)).toBe('item-role S;ROOT-ROLE S;');
  });

  it('does not look into a string or array item for a path', () => {
    const data = { length: 'root-length', xs: ['abc'] };
    expect(render('{{#each xs}}{{length}}{{/each}}', data)).toBe('root-length');
  });

  it('item. always reads from the innermost item, even when the root has an item key', () => {
    const data = { item: { name: 'root-item' }, xs: [{ name: 'x1' }] };
    expect(render('{{#each xs}}{{item.name}}{{/each}}|{{item.name}}', data)).toBe('x1|root-item');
  });

  it('errors on {{item.field}} when the item has no such field', () => {
    expect(() => render('{{#each xs}}{{item.nope}}{{/each}}', { xs: [{ a: 1 }] })).toThrow(
      'unknown value "item.nope" at line 1',
    );
    expect(() => render('{{#each xs}}{{item.a}}{{/each}}', { xs: ['str'] })).toThrow('unknown value "item.a"');
  });

  it('errors on {{.}} outside each and on a value that is not an array', () => {
    expect(() => render('{{.}}')).toThrow('t.md: unknown value "." at line 1');
    expect(() => render('{{#each v}}x{{/each}}', { v: 'str' })).toThrow('"v" is a string, not an array at line 1');
    expect(() => render('{{#each v}}x{{/each}}', { v: { a: 1 } })).toThrow('"v" is an object, not an array');
    expect(() => render('{{#each nope}}x{{/each}}')).toThrow('unknown value "nope" at line 1');
  });

  it('errors on {{.}} when the item is not printable', () => {
    expect(() => render('{{#each xs}}{{.}}{{/each}}', { xs: [['nested']] })).toThrow('value "." is an array');
  });

  it('lets if test the item', () => {
    expect(render('{{#each xs}}{{#if .}}+{{else}}-{{/if}}{{/each}}', { xs: ['a', '', 'b'] })).toBe('+-+');
  });
});

describe('nesting', () => {
  it('nests if inside if, each inside if and if inside each', () => {
    const source = '{{#if a}}A{{#if b}}B{{else}}b{{/if}}{{#each xs}}<{{.}}{{#if @root.c}}!{{/if}}>{{/each}}{{/if}}';
    expect(render(source, { a: true, b: false, c: true, xs: [1, 2] })).toBe('Ab<1!><2!>');
    expect(render(source, { a: true, b: true, c: false, xs: [1] })).toBe('AB<1>');
    expect(render(source, { a: false, b: true, c: true, xs: [1] })).toBe('');
  });

  it('nests each inside each, the item being the innermost one', () => {
    const data = { groups: [{ name: 'g1', members: ['a', 'b'] }, { name: 'g2', members: ['c'] }] };
    const source = '{{#each groups}}{{name}}:{{#each members}}{{.}},{{/each}};{{/each}}';
    expect(render(source, data)).toBe('g1:a,b,;g2:c,;');
  });

  it('nests if inside else', () => {
    const source = '{{#if a}}A{{else}}{{#if b}}B{{else}}C{{/if}}{{/if}}';
    expect(render(source, { a: false, b: true })).toBe('B');
    expect(render(source, { a: false, b: false })).toBe('C');
  });
});

describe('standalone block tag lines', () => {
  it('removes a line holding only a block tag together with its newline', () => {
    expect(render('a\n{{#if x}}\nb\n{{/if}}\nc', { x: true })).toBe('a\nb\nc');
    expect(render('a\n{{#if x}}\nb\n{{/if}}\nc', { x: false })).toBe('a\nc');
  });

  it('applies to else, unless and each lines, and to indented tags', () => {
    const source = ['l1', '  {{#if x}}', 'yes', '  {{else}}', 'no', '  {{/if}}', '{{#unless x}}', 'u', '{{/unless}}', '{{#each xs}}', '- {{.}}', '{{/each}}', 'end'].join('\n');
    expect(render(source, { x: true, xs: ['p', 'q'] })).toBe('l1\nyes\n- p\n- q\nend');
    expect(render(source, { x: false, xs: [] })).toBe('l1\nno\nu\nend');
  });

  it('keeps the indentation of the content lines', () => {
    expect(render('{{#each xs}}\n  * {{.}}\n{{/each}}\n', { xs: ['a', 'b'] })).toBe('  * a\n  * b\n');
  });

  it('does not touch a block tag that shares its line with text or another tag', () => {
    expect(render('a {{#if x}}b{{/if}} c', { x: true })).toBe('a b c');
    // The opening tag is alone on its line (removed); the closing tag has text after it (kept inline).
    expect(render('{{#if x}}\n{{/if}} tail\n', { x: true })).toBe(' tail\n');
    expect(render('{{#if x}}{{#if y}}\nz\n{{/if}}{{/if}}', { x: true, y: true })).toBe('\nz\n');
  });

  it('does not remove a line that holds a value tag', () => {
    expect(render('{{v}}\n', { v: 'x' })).toBe('x\n');
    expect(render('  {{v}}  \nnext', { v: 'x' })).toBe('  x  \nnext');
  });

  it('removes a trailing tag line that has no newline', () => {
    expect(render('a\n{{#if x}}\nb\n{{/if}}', { x: true })).toBe('a\nb\n');
  });

  it('handles CRLF line endings', () => {
    expect(render('a\r\n{{#if x}}\r\nb\r\n{{/if}}\r\nc', { x: true })).toBe('a\r\nb\r\nc');
  });

  it('keeps every blank line the author wrote', () => {
    expect(render('a\n\n{{#if x}}\nb\n{{/if}}\n\nc', { x: true })).toBe('a\n\nb\n\nc');
  });
});

describe('block errors', () => {
  it('names the line of an unclosed block', () => {
    expect(() => render('a\n\n{{#if x}}\nb', { x: true })).toThrow(TemplateError);
    expect(() => render('a\n\n{{#if x}}\nb', { x: true })).toThrow('t.md: unclosed {{#if x}} opened at line 3');
    expect(() => render('{{#each xs}}\n{{#unless y}}x{{/unless}}', { xs: [], y: 1 })).toThrow(
      'unclosed {{#each xs}} opened at line 1',
    );
  });

  it('names both lines of a mismatched close', () => {
    expect(() => render('{{#if x}}\n\n{{/each}}', { x: true })).toThrow(
      't.md: {{/each}} at line 3 does not match {{#if x}} opened at line 1',
    );
  });

  it('reports a close or else with no open block', () => {
    expect(() => render('a\n{{/if}}')).toThrow('t.md: unexpected {{/if}} at line 2');
    expect(() => render('{{else}}')).toThrow('t.md: unexpected {{else}} at line 1');
    expect(() => render('{{#each xs}}{{else}}{{/each}}', { xs: [] })).toThrow('unexpected {{else}} at line 1');
    expect(() => render('{{#if x}}{{else}}{{else}}{{/if}}', { x: 1 })).toThrow('duplicate {{else}} at line 1');
  });

  it('reports a tag that is never terminated', () => {
    expect(() => render('a\nb {{x')).toThrow('t.md: unclosed tag "{{" at line 2');
  });

  it('reports a malformed tag with its line', () => {
    expect(() => render('\n{{}}')).toThrow('t.md: invalid tag "{{}}" at line 2');
    expect(() => render('{{a b}}', { a: 1 })).toThrow('invalid tag "{{a b}}" at line 1');
    expect(() => render('{{#if}}x{{/if}}')).toThrow('invalid tag "{{#if}}" at line 1');
    expect(() => render('{{#with a}}x{{/with}}')).toThrow('unknown block "#with" at line 1');
    expect(() => render('{{else if x}}')).toThrow('invalid tag "{{else if x}}"');
  });

  it('counts lines across the whole source, including removed tag lines', () => {
    const source = '{{#if x}}\nok\n{{/if}}\n{{#if x}}\n{{missing}}\n{{/if}}';
    expect(() => render(source, { x: true })).toThrow('unknown value "missing" at line 5');
  });
});

describe('escaped braces', () => {
  it('renders \\{{ as a literal {{ and leaves the tag text alone', () => {
    expect(render('x: $\\{{ secrets.SDLC_TOKEN }}')).toBe('x: ${{ secrets.SDLC_TOKEN }}');
    expect(render('GH_TOKEN: ${{ secrets.X }}'.replace('${{', '$\\{{'))).toBe('GH_TOKEN: ${{ secrets.X }}');
  });

  it('does not evaluate or parse what is between the escaped {{ and the next }}', () => {
    expect(render('\\{{#if nope}}')).toBe('{{#if nope}}');
    expect(render('\\{{/each}} \\{{else}}')).toBe('{{/each}} {{else}}');
    expect(render('\\{{ {{missing}} }}')).toBe('{{ {{missing}} }}');
    expect(render('\\{{a b c}}')).toBe('{{a b c}}');
  });

  it('keeps a real tag after the escaped text working', () => {
    expect(render('\\{{ lit }} {{v}} \\{{ lit2 }}', { v: 'real' })).toBe('{{ lit }} real {{ lit2 }}');
    expect(render('{{v}}\\{{x}}{{v}}', { v: 'a' })).toBe('a{{x}}a');
  });

  it('is plain text when no }} follows', () => {
    expect(render('open \\{{ and never closed')).toBe('open {{ and never closed');
    expect(render('{{v}} \\{{ lit\nmore', { v: 'a' })).toBe('a {{ lit\nmore');
    // A later tag's }} closes the escaped span, so that tag stays literal too.
    expect(render('\\{{ lit\n{{v}}', { v: 'a' })).toBe('{{ lit\n{{v}}');
  });

  it('works inside blocks and keeps the standalone-line rule', () => {
    expect(render('a\n{{#if x}}\n\\{{ lit }}\n{{/if}}\nb', { x: true })).toBe('a\n{{ lit }}\nb');
    expect(render('{{#each xs}}\n  \\{{ {{.}} }}\n{{/each}}\n', { xs: [1, 2] })).toBe('  {{ {{.}} }}\n  {{ {{.}} }}\n');
    expect(render('a\n  \\{{#if x}}\nb', {})).toBe('a\n  {{#if x}}\nb');
  });

  it('counts the lines inside an escaped span', () => {
    expect(() => render('\\{{ a\nb }}\n{{missing}}')).toThrow('unknown value "missing" at line 3');
  });

  it('only a backslash directly before {{ escapes', () => {
    expect(render('a\\b {{v}}', { v: 'c' })).toBe('a\\b c');
  });
});
