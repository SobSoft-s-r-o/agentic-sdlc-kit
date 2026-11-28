import { describe, expect, it } from 'vitest';
import {
  MergeError,
  assertJsonPointer,
  blockBody,
  filterTomlBody,
  mergeJsonKeys,
  mergeLineBlock,
  mergeMdBlock,
  mergeTomlBlock,
  ownedItems,
  removeJsonKeys,
  removeLineBlock,
  removeMdBlock,
  removeTomlBlock,
  tomlTableText,
} from '../../src/install/merge.js';
import { HOOK_MARKER, hookCommand } from '../../src/render/hooks.js';

const MD_BEGIN = '<!-- sdlc:begin -->';
const MD_END = '<!-- sdlc:end -->';
const LINE_BEGIN = '# sdlc:begin';
const LINE_END = '# sdlc:end';
const TOML_BEGIN = '# >>> sdlc:begin (managed by agentic-sdlc-kit; edits inside are overwritten) >>>';
const TOML_END = '# <<< sdlc:end <<<';

const GITHUB_TABLE = ['[mcp_servers.github]', 'url = "https://api.githubcopilot.com/mcp/"', 'bearer_token_env_var = "GITHUB_PERSONAL_ACCESS_TOKEN"'].join('\n');
const CONTEXT7_TABLE = ['[mcp_servers.context7]', 'command = "npx"', 'args = ["-y", "@upstash/context7-mcp"]'].join('\n');
const TOML_BODY = `${GITHUB_TABLE}\n\n${CONTEXT7_TABLE}`;
const OWNED = ['mcp_servers.github', 'mcp_servers.context7'];

describe('mergeMdBlock', () => {
  it('creates the block when the file is absent', () => {
    expect(mergeMdBlock(undefined, 'hello\nworld')).toBe(`${MD_BEGIN}\nhello\nworld\n${MD_END}\n`);
  });

  it('appends the block after one blank line when the markers are absent', () => {
    expect(mergeMdBlock('# Mine\n', 'body')).toBe(`# Mine\n\n${MD_BEGIN}\nbody\n${MD_END}\n`);
    expect(mergeMdBlock('# Mine', 'body')).toBe(`# Mine\n\n${MD_BEGIN}\nbody\n${MD_END}\n`);
  });

  it('uses the block alone for an empty existing file', () => {
    expect(mergeMdBlock('', 'body')).toBe(`${MD_BEGIN}\nbody\n${MD_END}\n`);
  });

  it('replaces only what is between the markers', () => {
    const existing = `before\n\n${MD_BEGIN}\nold\nold2\n${MD_END}\n\nafter\n`;
    expect(mergeMdBlock(existing, 'new')).toBe(`before\n\n${MD_BEGIN}\nnew\n${MD_END}\n\nafter\n`);
  });

  it('is idempotent and ignores trailing newlines on the body', () => {
    const once = mergeMdBlock('# Mine\n', 'body\n\n');
    expect(once).toBe(`# Mine\n\n${MD_BEGIN}\nbody\n${MD_END}\n`);
    expect(mergeMdBlock(once, 'body')).toBe(once);
  });

  it('keeps an end marker without a final newline as it was', () => {
    expect(mergeMdBlock(`x\n${MD_BEGIN}\nold\n${MD_END}`, 'new')).toBe(`x\n${MD_BEGIN}\nnew\n${MD_END}`);
  });

  it('writes the block with the line endings of a CRLF file and leaves the user bytes alone', () => {
    const existing = '# Mine\r\n\r\nusers text\r\n';
    const merged = mergeMdBlock(existing, 'a\nb');
    expect(merged).toBe(`${existing}\r\n${MD_BEGIN}\r\na\r\nb\r\n${MD_END}\r\n`);
    expect(removeMdBlock(merged)).toBe(existing);
    expect(mergeMdBlock(merged, 'c')).toBe(`${existing}\r\n${MD_BEGIN}\r\nc\r\n${MD_END}\r\n`);
  });

  it('recognises a block whose marker lines carry trailing spaces', () => {
    const existing = `x\n${MD_BEGIN}  \nold\n${MD_END}\t\ny\n`;
    expect(blockBody(existing, 'md-block')).toBe('old');
    expect(mergeMdBlock(existing, 'new')).toBe(`x\n${MD_BEGIN}\nnew\n${MD_END}\t\ny\n`);
  });
});

describe('blockBody', () => {
  it('returns the body between the markers, or undefined without markers', () => {
    expect(blockBody(`a\n${MD_BEGIN}\nl1\nl2\n${MD_END}\nb\n`, 'md-block')).toBe('l1\nl2');
    expect(blockBody(`a\n${MD_BEGIN}\n\n${MD_END}\n`, 'md-block')).toBe('');
    expect(blockBody('a\nb\n', 'md-block')).toBeUndefined();
    expect(blockBody(`${LINE_BEGIN}\n.env\n${LINE_END}\n`, 'line-block')).toBe('.env');
    expect(blockBody(`${TOML_BEGIN}\n[x]\n${TOML_END}\n`, 'toml-block')).toBe('[x]');
  });

  it('does not mix the marker families', () => {
    expect(blockBody(`${LINE_BEGIN}\nx\n${LINE_END}\n`, 'md-block')).toBeUndefined();
    expect(blockBody(`${MD_BEGIN}\nx\n${MD_END}\n`, 'line-block')).toBeUndefined();
  });
});

describe('preserves user content in every merge kind', () => {
  it('Markdown: every byte outside the block is kept', () => {
    const before = '# My project\n\nHand written rules.\n\n';
    const after = '\n## More\nuser text without a final newline';
    const existing = `${before}${MD_BEGIN}\nold body\n${MD_END}\n${after}`;
    const merged = mergeMdBlock(existing, 'new body');
    expect(merged.startsWith(before)).toBe(true);
    expect(merged.endsWith(after)).toBe(true);
    expect(merged).toBe(`${before}${MD_BEGIN}\nnew body\n${MD_END}\n${after}`);
  });

  it('JSON: a user server `db` and a user `github` stay as they are, `github` is reported as skipped', () => {
    const existing = JSON.stringify(
      { mcpServers: { db: { command: 'db-server' }, github: { command: 'my-own-github' } }, theme: 'dark' },
      null,
      2,
    );
    const result = mergeJsonKeys(
      existing,
      [
        { pointer: ['mcpServers', 'github'], value: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } },
        { pointer: ['mcpServers', 'context7'], value: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] } },
      ],
      new Set(),
    );
    expect(result.skipped).toEqual(['mcpServers/github']);
    const parsed = JSON.parse(result.text);
    expect(parsed.mcpServers.db).toEqual({ command: 'db-server' });
    expect(parsed.mcpServers.github).toEqual({ command: 'my-own-github' });
    expect(parsed.mcpServers.context7).toEqual({ command: 'npx', args: ['-y', '@upstash/context7-mcp'] });
    expect(parsed.theme).toBe('dark');
    expect(Object.keys(parsed.mcpServers)).toEqual(['db', 'github', 'context7']);
    expect(Object.keys(parsed)).toEqual(['mcpServers', 'theme']);
    // the user's file had no final newline, and the rewrite does not add one
    expect(result.text.endsWith('}\n')).toBe(false);
    expect(result.text.endsWith('}')).toBe(true);
  });

  it('TOML: root keys and the user table stay, the block is appended and holds no github table', () => {
    const existing = ['model = "gpt-5"', 'approval_policy = "on-request"', '', '[mcp_servers.github]', 'command = "my-own-github"', ''].join('\n');
    const result = mergeTomlBlock(existing, TOML_BODY, OWNED);
    expect(result.skipped).toEqual(['mcp_servers.github']);
    expect(result.text.startsWith(`${existing}\n${TOML_BEGIN}\n`)).toBe(true);
    expect(result.text.endsWith(`${TOML_END}\n`)).toBe(true);
    const block = blockBody(result.text, 'toml-block')!;
    expect(block).toBe(CONTEXT7_TABLE);
    expect(block).not.toContain('[mcp_servers.github]');
    expect(result.text.split('[mcp_servers.github]')).toHaveLength(2);
  });
});

describe('refuses damaged markers', () => {
  const cases: Array<[string, (text: string) => unknown, string, string]> = [
    ['mergeMdBlock', t => mergeMdBlock(t, 'x'), MD_BEGIN, MD_END],
    ['removeMdBlock', t => removeMdBlock(t), MD_BEGIN, MD_END],
    ['mergeLineBlock', t => mergeLineBlock(t, 'x'), LINE_BEGIN, LINE_END],
    ['removeLineBlock', t => removeLineBlock(t), LINE_BEGIN, LINE_END],
    ['mergeTomlBlock', t => mergeTomlBlock(t, '[a]\nb = 1', ['a']), TOML_BEGIN, TOML_END],
    ['removeTomlBlock', t => removeTomlBlock(t), TOML_BEGIN, TOML_END],
  ];

  for (const [name, run, begin, end] of cases) {
    it(`${name}: a begin without an end`, () => {
      const text = `user\n${begin}\nbody\nmore user text\n`;
      expect(() => run(text)).toThrow(MergeError);
      expect(() => run(text)).toThrow(/has no matching/);
      expect(() => run(text)).toThrow(/line 2/);
    });

    it(`${name}: two begins`, () => {
      const text = `${begin}\na\n${end}\nuser\n${begin}\nb\n${end}\n`;
      expect(() => run(text)).toThrow(MergeError);
      expect(() => run(text)).toThrow(/more than one/);
      // two begins and a single end: the begin check itself must catch it, naming both lines
      expect(() => run(`${begin}\na\n${begin}\nb\n${end}\n`)).toThrow(`more than one "${begin}" marker (lines 1 and 3)`);
      expect(() => run(`${begin}\na\n${end}\n${end}\n`)).toThrow(`more than one "${end}" marker (lines 3 and 4)`);
    });

    it(`${name}: an end before the begin`, () => {
      const text = `${end}\nuser\n${begin}\nb\n`;
      expect(() => run(text)).toThrow(/comes before/);
    });

    it(`${name}: an end without a begin`, () => {
      expect(() => run(`user\n${end}\n`)).toThrow(/has no .* before it/);
    });
  }

  it('blockBody refuses them too', () => {
    expect(() => blockBody(`${MD_BEGIN}\nx\n`, 'md-block')).toThrow(MergeError);
  });
});

describe('remove functions restore the original text when init created the block', () => {
  const originals = ['', 'one line\n', '# Title\n\nParagraph.\n\n- a\n- b\n', 'first\n\n\nsecond\n'];

  it('Markdown', () => {
    for (const original of originals) {
      expect(removeMdBlock(mergeMdBlock(original, 'rules\nmore rules'))).toBe(original);
    }
    expect(removeMdBlock(mergeMdBlock(undefined, 'rules'))).toBe('');
  });

  it('line block', () => {
    for (const original of originals) {
      expect(removeLineBlock(mergeLineBlock(original, '.env\n.env.*'))).toBe(original);
    }
    expect(removeLineBlock(mergeLineBlock(undefined, '.env'))).toBe('');
  });

  it('line block uses the # markers', () => {
    expect(mergeLineBlock('node_modules/\n', '.sdlc/cache/\n.env')).toBe(
      `node_modules/\n\n${LINE_BEGIN}\n.sdlc/cache/\n.env\n${LINE_END}\n`,
    );
  });

  it('TOML', () => {
    for (const original of originals) {
      const merged = mergeTomlBlock(original, TOML_BODY, OWNED).text;
      expect(removeTomlBlock(merged)).toBe(original);
    }
    expect(removeTomlBlock(mergeTomlBlock(undefined, TOML_BODY, OWNED).text)).toBe('');
  });

  it('JSON', () => {
    const original = `${JSON.stringify({ editor: 'vim' }, null, 2)}\n`;
    const entries = [{ pointer: ['mcpServers', 'github'], value: { url: 'https://x.example/mcp' } }];
    const merged = mergeJsonKeys(original, entries, new Set()).text;
    expect(removeJsonKeys(merged, [['mcpServers', 'github']])).toBe(original);
  });

  it('a block with user text on both sides loses only its own lines and the blank line before it', () => {
    const existing = `a\n\n${MD_BEGIN}\nx\n${MD_END}\n\nb\n`;
    expect(removeMdBlock(existing)).toBe('a\n\nb\n');
    expect(removeMdBlock(`${MD_BEGIN}\nx\n${MD_END}\nafter\n`)).toBe('after\n');
  });

  it('leave a file without markers alone', () => {
    expect(removeMdBlock('nothing here\n')).toBe('nothing here\n');
    expect(removeLineBlock('nothing here\n')).toBe('nothing here\n');
    expect(removeTomlBlock('nothing here\n')).toBe('nothing here\n');
  });
});

describe('mergeJsonKeys', () => {
  const entry = { pointer: ['mcpServers', 'github'], value: { url: 'u' } };

  it('creates the file text when the file is absent', () => {
    const result = mergeJsonKeys(undefined, [entry], new Set());
    expect(result.skipped).toEqual([]);
    expect(result.text).toBe(`${JSON.stringify({ mcpServers: { github: { url: 'u' } } }, null, 2)}\n`);
  });

  it('treats an empty file as an empty object', () => {
    expect(JSON.parse(mergeJsonKeys('  \n', [entry], new Set()).text)).toEqual({ mcpServers: { github: { url: 'u' } } });
  });

  it('overwrites a key it owns and keeps its position', () => {
    const existing = JSON.stringify({ mcpServers: { github: { url: 'old' }, db: { command: 'x' } } });
    const result = mergeJsonKeys(existing, [entry], new Set(['mcpServers/github']));
    expect(result.skipped).toEqual([]);
    const parsed = JSON.parse(result.text);
    expect(parsed.mcpServers.github).toEqual({ url: 'u' });
    expect(Object.keys(parsed.mcpServers)).toEqual(['github', 'db']);
  });

  it('reports a present key it does not own and leaves it', () => {
    const existing = JSON.stringify({ mcpServers: { github: { url: 'mine' } } });
    const result = mergeJsonKeys(existing, [entry], new Set());
    expect(result.skipped).toEqual(['mcpServers/github']);
    expect(JSON.parse(result.text).mcpServers.github).toEqual({ url: 'mine' });
  });

  it('refuses invalid JSON with a precise message', () => {
    expect(() => mergeJsonKeys('{ not json', [entry], new Set(), '.mcp.json')).toThrow(MergeError);
    expect(() => mergeJsonKeys('{ not json', [entry], new Set(), '.mcp.json')).toThrow(
      '.mcp.json is not valid JSON; fix or remove it',
    );
    expect(() => removeJsonKeys('{ not json', [['a']], '.mcp.json')).toThrow('.mcp.json is not valid JSON; fix or remove it');
  });

  it('refuses a document that is not an object, and a parent that is not an object', () => {
    expect(() => mergeJsonKeys('[1, 2]', [entry], new Set(), 'a.json')).toThrow(/a\.json must contain a JSON object/);
    expect(() => mergeJsonKeys('{"mcpServers": "nope"}', [entry], new Set(), 'a.json')).toThrow(
      /a\.json: "mcpServers" is not an object/,
    );
  });

  it('keeps a tab or N-space indentation and the final newline (or its absence) of the file', () => {
    const doc = { editor: 'vim', mcpServers: { db: { command: 'x' } } };
    const expectedDoc = { editor: 'vim', mcpServers: { db: { command: 'x' }, github: { url: 'u' } } };
    for (const indent of ['    ', '\t', '  ', ' ']) {
      for (const tail of ['\n', '']) {
        const result = mergeJsonKeys(JSON.stringify(doc, null, indent) + tail, [entry], new Set());
        expect(result.text).toBe(JSON.stringify(expectedDoc, null, indent) + tail);
      }
    }
  });

  it('keeps CRLF line endings', () => {
    const text = `${JSON.stringify({ editor: 'vim' }, null, 4).split('\n').join('\r\n')}\r\n`;
    const out = mergeJsonKeys(text, [entry], new Set()).text;
    expect(out).toBe(`${JSON.stringify({ editor: 'vim', mcpServers: { github: { url: 'u' } } }, null, 4).split('\n').join('\r\n')}\r\n`);
  });

  it('uses two spaces and a final newline for a new file or an empty one', () => {
    const two = `${JSON.stringify({ mcpServers: { github: { url: 'u' } } }, null, 2)}\n`;
    expect(mergeJsonKeys(undefined, [entry], new Set()).text).toBe(two);
    expect(mergeJsonKeys('', [entry], new Set()).text).toBe(two);
    expect(mergeJsonKeys('  \n', [entry], new Set()).text).toBe(two);
  });

  it('keeps a file written on one line on one line, and its final newline (or its absence)', () => {
    // the user's text is not reflowed: the new member joins the line
    expect(mergeJsonKeys('{"a":1}\n', [entry], new Set()).text).toBe('{"a":1, "mcpServers": {"github":{"url":"u"}}}\n');
    expect(mergeJsonKeys('{"a":1}', [entry], new Set()).text).toBe('{"a":1, "mcpServers": {"github":{"url":"u"}}}');
    // an empty top-level object is spread over lines, as a new file is
    expect(mergeJsonKeys('{}', [entry], new Set()).text).toBe(JSON.stringify({ mcpServers: { github: { url: 'u' } } }, null, 2));
  });

  it('returns the input untouched when no key is set: all skipped, or all already in sync', () => {
    const odd = '{\n      "mcpServers": {"github":    {"url": "mine"}},\n"x":1}';
    const skippedOnly = mergeJsonKeys(odd, [entry], new Set());
    expect(skippedOnly.text).toBe(odd);
    expect(skippedOnly.skipped).toEqual(['mcpServers/github']);

    const inSync = '{"mcpServers":{"github":{"url":"u"}}}  \n\n';
    const owned = mergeJsonKeys(inSync, [entry], new Set(['mcpServers/github']));
    expect(owned.text).toBe(inSync);
    expect(owned.skipped).toEqual([]);
    // key order inside the value does not make it a change
    const reordered = mergeJsonKeys('{"mcpServers":{"github":{"b":2,"a":1}}}', [{ pointer: ['mcpServers', 'github'], value: { a: 1, b: 2 } }], new Set(['mcpServers/github']));
    expect(reordered.text).toBe('{"mcpServers":{"github":{"b":2,"a":1}}}');
  });

  it('rewrites when an owned value really changed', () => {
    const out = mergeJsonKeys('{"mcpServers":{"github":{"url":"old"}}}', [entry], new Set(['mcpServers/github']));
    expect(JSON.parse(out.text).mcpServers.github).toEqual({ url: 'u' });
  });

  it('reports the objects it had to create on the way, outermost first, and none that were there', () => {
    expect(mergeJsonKeys(undefined, [entry], new Set()).createdParents).toEqual(['mcpServers']);
    expect(mergeJsonKeys('{"theme":"dark"}', [entry], new Set()).createdParents).toEqual(['mcpServers']);
    expect(mergeJsonKeys('{"mcpServers":{}}', [entry], new Set()).createdParents).toEqual([]);
    expect(mergeJsonKeys('{"mcpServers":{"db":{}}}', [entry], new Set()).createdParents).toEqual([]);
    expect(mergeJsonKeys('{"a":{}}', [{ pointer: ['a', 'b', 'c'], value: 1 }], new Set()).createdParents).toEqual(['a/b']);
    expect(mergeJsonKeys('{}', [{ pointer: ['a', 'b', 'c'], value: 1 }], new Set()).createdParents).toEqual(['a', 'a/b']);
    // two entries share one new parent: reported once
    const two = [entry, { pointer: ['mcpServers', 'db'], value: { command: 'x' } }];
    expect(mergeJsonKeys('{}', two, new Set()).createdParents).toEqual(['mcpServers']);
    // a skipped or in-sync entry creates nothing
    expect(mergeJsonKeys('{"mcpServers":{"github":{"url":"mine"}}}', [entry], new Set()).createdParents).toEqual([]);
  });

  it('refuses a pointer segment that contains "/"', () => {
    expect(() => mergeJsonKeys(undefined, [{ pointer: ['mcpServers', 'a/b'], value: 1 }], new Set(), '.mcp.json')).toThrow(
      '.mcp.json: key segment "a/b" must not contain "/"',
    );
    expect(() => assertJsonPointer(['ok', 'also/bad'], 'x.json')).toThrow(MergeError);
    expect(() => assertJsonPointer(['ok', 'fine'], 'x.json')).not.toThrow();
  });

  it('does not let a key named __proto__ reach the prototype', () => {
    const result = mergeJsonKeys(undefined, [{ pointer: ['mcpServers', '__proto__'], value: { polluted: true } }], new Set());
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(JSON.parse(result.text).mcpServers)).toEqual(['__proto__']);
  });
});

describe('mergeJsonKeys with owned array items', () => {
  const MARKER = 'sdlc hook';
  const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: './mine.sh' }] };
  const ours = (command: string) => ({ matcher: 'Bash', hooks: [{ type: 'command', command }] });
  const items = (...commands: string[]) => ({
    pointer: ['hooks', 'PreToolUse'],
    value: commands.map(ours),
    items: { marker: MARKER },
  });
  const text = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;
  const userDoc = { permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [mine] } };

  it('appends after the user items in a conventionally formatted file (hand-written layouts: see the splice tests)', () => {
    const user = text(userDoc);
    const result = mergeJsonKeys(user, [items('sdlc hook pre-tool')], new Set(), 's.json');
    expect(result.text).toBe(
      text({ permissions: userDoc.permissions, hooks: { PreToolUse: [mine, ours('sdlc hook pre-tool')] } }),
    );
    // the bytes before the hooks key are the user's own
    expect(result.text.startsWith(user.slice(0, user.indexOf('  "hooks"')))).toBe(true);
    expect(result.skipped).toEqual([]);
    expect(result.createdParents).toEqual([]);
  });

  it('keeps the indentation, line endings and final newline of the file', () => {
    for (const indent of ['    ', '\t']) {
      const user = `${JSON.stringify(userDoc, null, indent).split('\n').join('\r\n')}\r\n`;
      const expected = { ...userDoc, hooks: { PreToolUse: [mine, ours('sdlc hook a')] } };
      expect(mergeJsonKeys(user, [items('sdlc hook a')], new Set()).text).toBe(
        `${JSON.stringify(expected, null, indent).split('\n').join('\r\n')}\r\n`,
      );
    }
  });

  it('creates the array and the parents it needs, and reports them outermost first', () => {
    const created = mergeJsonKeys(undefined, [items('sdlc hook a')], new Set());
    expect(JSON.parse(created.text)).toEqual({ hooks: { PreToolUse: [ours('sdlc hook a')] } });
    expect(created.createdParents).toEqual(['hooks', 'hooks/PreToolUse']);
    expect(mergeJsonKeys('{"hooks":{}}', [items('sdlc hook a')], new Set()).createdParents).toEqual(['hooks/PreToolUse']);
    expect(mergeJsonKeys('{"hooks":{"PreToolUse":[]}}', [items('sdlc hook a')], new Set()).createdParents).toEqual([]);
  });

  it('replaces only the elements that contain the marker and appends the new ones last', () => {
    const before = text({ hooks: { PreToolUse: [ours('sdlc hook old'), mine, ours('sdlc hook old 2')] } });
    const result = mergeJsonKeys(before, [items('sdlc hook new', 'sdlc hook new 2')], new Set());
    expect(JSON.parse(result.text).hooks.PreToolUse).toEqual([mine, ours('sdlc hook new'), ours('sdlc hook new 2')]);
  });

  it('returns the input untouched when the owned items are already what the entry says', () => {
    const before = `{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"command":"sdlc hook a","type":"command"}]}]}}  \n\n`;
    expect(mergeJsonKeys(before, [items('sdlc hook a')], new Set()).text).toBe(before);
    const withUser = text({ hooks: { PreToolUse: [mine, ours('sdlc hook a')] } });
    expect(mergeJsonKeys(withUser, [items('sdlc hook a')], new Set()).text).toBe(withUser);
  });

  it('mixes with plain entries in one call, including in the same parent', () => {
    const entries = [
      { pointer: ['mcpServers', 'github'], value: { url: 'u' } },
      { pointer: ['hooks', 'BeforeTool'], value: [ours('sdlc hook a')], items: { marker: MARKER } },
    ];
    const result = mergeJsonKeys('{"theme":"dark"}', entries, new Set());
    expect(JSON.parse(result.text)).toEqual({
      theme: 'dark',
      mcpServers: { github: { url: 'u' } },
      hooks: { BeforeTool: [ours('sdlc hook a')] },
    });
    expect(result.createdParents).toEqual(['mcpServers', 'hooks', 'hooks/BeforeTool']);
  });

  it('refuses a value at the pointer that is not an array', () => {
    const before = text({ hooks: { PreToolUse: { matcher: 'Bash' } } });
    expect(() => mergeJsonKeys(before, [items('sdlc hook a')], new Set(), 's.json')).toThrow(MergeError);
    expect(() => mergeJsonKeys(before, [items('sdlc hook a')], new Set(), 's.json')).toThrow(
      'expected an array at hooks/PreToolUse',
    );
    expect(() => mergeJsonKeys('{"hooks":{"PreToolUse":null}}', [items('sdlc hook a')], new Set())).toThrow(
      'expected an array at hooks/PreToolUse',
    );
  });

  it('refuses an entry whose items do not all contain the marker, or that has none', () => {
    const bad = { pointer: ['hooks', 'PreToolUse'], value: [ours('sdlc hook a'), ours('other')], items: { marker: MARKER } };
    expect(() => mergeJsonKeys(undefined, [bad], new Set(), 's.json')).toThrow(
      's.json: hooks/PreToolUse: every item must contain "sdlc hook"',
    );
    expect(() => mergeJsonKeys(undefined, [{ ...bad, value: [] }], new Set(), 's.json')).toThrow(
      's.json: hooks/PreToolUse: the value must be a non-empty array',
    );
    expect(() => mergeJsonKeys(undefined, [{ ...bad, value: 'x' }], new Set(), 's.json')).toThrow(
      's.json: hooks/PreToolUse: the value must be a non-empty array',
    );
    expect(() => mergeJsonKeys(undefined, [{ ...bad, items: { marker: '' } }], new Set(), 's.json')).toThrow(
      's.json: hooks/PreToolUse: the marker must not be empty',
    );
  });
});

describe('mergeJsonKeys with the hook launcher as the marker', () => {
  const group = (command: string) => ({ hooks: [{ type: 'command', command }] });
  const rendered = group(hookCommand('claude', 'prompt'));
  const earlier = group('"$(git rev-parse --show-toplevel)/.sdlc/hooks/run.sh" claude prompt');
  const mentions = group('./audit.sh --skip .sdlc/hooks/run.sh');
  const entry = { pointer: ['hooks', 'UserPromptSubmit'], value: [rendered], items: { marker: HOOK_MARKER } };

  it('replaces the items of the earlier shape and keeps a user hook that merely mentions the launcher', () => {
    const doc = JSON.stringify({ hooks: { UserPromptSubmit: [mentions, earlier] } });
    const merged = JSON.parse(mergeJsonKeys(doc, [entry], new Set()).text) as unknown;
    expect(merged).toEqual({ hooks: { UserPromptSubmit: [mentions, rendered] } });
    expect(ownedItems([mentions, earlier, rendered], HOOK_MARKER)).toEqual([earlier, rendered]);
  });

  it('uninstall leaves the user hook that mentions the launcher', () => {
    const doc = JSON.stringify({ hooks: { UserPromptSubmit: [mentions, rendered] } });
    const removed = JSON.parse(removeJsonKeys(doc, [{ pointer: ['hooks', 'UserPromptSubmit'], marker: HOOK_MARKER }], 'a.json')) as unknown;
    expect(removed).toEqual({ hooks: { UserPromptSubmit: [mentions] } });
  });
});

describe('mergeJsonKeys with a renamed marker', () => {
  it('removes the elements of the previous marker as well, and keeps every other element', () => {
    const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: './mine.sh' }] };
    const old = { matcher: 'Bash', hooks: [{ type: 'command', command: 'sdlc hook pre-tool' }] };
    const fresh = { matcher: 'Bash', hooks: [{ type: 'command', command: 'sdlc-kit run pre-tool' }] };
    const doc = `${JSON.stringify({ hooks: { PreToolUse: [old, mine] } }, null, 2)}\n`;
    const out = mergeJsonKeys(
      doc,
      [{ pointer: ['hooks', 'PreToolUse'], value: [fresh], items: { marker: 'sdlc-kit run', previousMarker: 'sdlc hook' } }],
      new Set(),
    ).text;
    expect(JSON.parse(out).hooks.PreToolUse).toEqual([mine, fresh]);
    // without the previous marker the old item is the user's
    const kept = mergeJsonKeys(doc, [{ pointer: ['hooks', 'PreToolUse'], value: [fresh], items: { marker: 'sdlc-kit run' } }], new Set()).text;
    expect(JSON.parse(kept).hooks.PreToolUse).toEqual([old, mine, fresh]);
  });
});

describe('removeJsonKeys', () => {
  it('deletes the keys and the mcpServers object they leave empty', () => {
    const text = `${JSON.stringify({ mcpServers: { github: { a: 1 } }, other: true }, null, 2)}\n`;
    expect(removeJsonKeys(text, [['mcpServers', 'github']])).toBe(`${JSON.stringify({ other: true }, null, 2)}\n`);
  });

  it('keeps a user server that sits next to ours', () => {
    const text = JSON.stringify({ mcpServers: { github: { a: 1 }, db: { b: 2 } } });
    expect(JSON.parse(removeJsonKeys(text, [['mcpServers', 'github']]))).toEqual({ mcpServers: { db: { b: 2 } } });
  });

  it('leaves `{}` when nothing else is in the file, with the final newline the file had', () => {
    expect(removeJsonKeys(JSON.stringify({ mcpServers: { github: {} } }), [['mcpServers', 'github']])).toBe('{}');
    expect(removeJsonKeys(`${JSON.stringify({ mcpServers: { github: {} } })}\n`, [['mcpServers', 'github']])).toBe('{}\n');
  });

  it('keeps an object it leaves empty when pruneEmpty is false (the user made it)', () => {
    const text = `${JSON.stringify({ mcpServers: { github: { a: 1 } }, other: true }, null, 2)}\n`;
    expect(removeJsonKeys(text, [['mcpServers', 'github']], 'a.json', { pruneEmpty: false })).toBe(
      `${JSON.stringify({ mcpServers: {}, other: true }, null, 2)}\n`,
    );
    const only = `${JSON.stringify({ mcpServers: { github: { a: 1 } } }, null, 2)}\n`;
    expect(removeJsonKeys(only, [['mcpServers', 'github']], 'a.json', { pruneEmpty: false })).toBe(
      `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`,
    );
  });

  it('prunes only the emptied objects named in a list, and only up to the first one not named', () => {
    const text = `${JSON.stringify({ a: { b: { c: 1 } }, keep: true }, null, 2)}\n`;
    const pointer = [['a', 'b', 'c']];
    const pruned = (list: string[]) => JSON.parse(removeJsonKeys(text, pointer, 'a.json', { pruneEmpty: list }));
    expect(pruned([])).toEqual({ a: { b: {} }, keep: true });
    expect(pruned(['a/b'])).toEqual({ a: {}, keep: true });
    expect(pruned(['a'])).toEqual({ a: { b: {} }, keep: true }); // a is not empty while b stays
    expect(pruned(['a/b', 'a'])).toEqual({ keep: true });
    // an object that is not empty is never pruned, named or not
    const shared = JSON.stringify({ mcpServers: { github: 1, mine: 2 } });
    expect(JSON.parse(removeJsonKeys(shared, [['mcpServers', 'github']], 'a.json', { pruneEmpty: ['mcpServers'] }))).toEqual({
      mcpServers: { mine: 2 },
    });
  });

  it('keeps the indentation, the line endings and the final newline of the file', () => {
    const doc = { mcpServers: { github: { a: 1 }, db: { b: 2 } }, other: true };
    for (const indent of ['    ', '\t', '  ', ' ']) {
      for (const tail of ['\n', '']) {
        const text = JSON.stringify(doc, null, indent) + tail;
        const expected = JSON.stringify({ mcpServers: { db: { b: 2 } }, other: true }, null, indent) + tail;
        expect(removeJsonKeys(text, [['mcpServers', 'github']])).toBe(expected);
      }
    }
    const crlf = `${JSON.stringify(doc, null, 2).split('\n').join('\r\n')}\r\n`;
    const out = removeJsonKeys(crlf, [['mcpServers', 'github']]);
    expect(out.includes('\r\n')).toBe(true);
    expect(out.replace(/\r\n/g, '')).not.toMatch(/\n/);
    expect(out.endsWith('}\r\n')).toBe(true);
  });

  it('returns the text unchanged when the key is not there', () => {
    const text = '{"a":   1}';
    expect(removeJsonKeys(text, [['mcpServers', 'github']])).toBe(text);
  });

  describe('owned array items', () => {
    const MARKER = 'sdlc hook';
    const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: './mine.sh' }] };
    const ours = (command: string) => ({ matcher: 'Bash', hooks: [{ type: 'command', command }] });
    const pre = { pointer: ['hooks', 'PreToolUse'], marker: MARKER };
    const start = { pointer: ['hooks', 'SessionStart'], marker: MARKER };
    const text = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;

    it('removes the marker elements and keeps the others, in order', () => {
      const before = text({ a: 1, hooks: { PreToolUse: [mine, ours('sdlc hook a'), { other: true }, ours('sdlc hook b')] } });
      expect(removeJsonKeys(before, [pre])).toBe(text({ a: 1, hooks: { PreToolUse: [mine, { other: true }] } }));
    });

    it('returns the text unchanged when no element has the marker, or the key is missing or not an array', () => {
      const plain = text({ hooks: { PreToolUse: [mine] } });
      expect(removeJsonKeys(plain, [pre])).toBe(plain);
      expect(removeJsonKeys('{"hooks":{}}', [pre])).toBe('{"hooks":{}}');
      expect(removeJsonKeys('{"hooks":{"PreToolUse":{"x":"sdlc hook"}}}', [pre])).toBe('{"hooks":{"PreToolUse":{"x":"sdlc hook"}}}');
    });

    it('removes an array that is left empty, and the empty parents, by default', () => {
      const before = text({ theme: 'dark', hooks: { PreToolUse: [ours('sdlc hook a')] } });
      expect(removeJsonKeys(before, [pre])).toBe(text({ theme: 'dark' }));
    });

    it('prunes the array only when pruneEmpty allows its key; a parent needs its own entry in the list', () => {
      const before = text({ hooks: { PreToolUse: [ours('sdlc hook a')], SessionStart: [ours('sdlc hook b')], Stop: [mine] } });
      const run = (list: boolean | string[]) => JSON.parse(removeJsonKeys(before, [pre, start], 'a.json', { pruneEmpty: list }));
      expect(run(false).hooks).toEqual({ PreToolUse: [], SessionStart: [], Stop: [mine] });
      expect(run([]).hooks).toEqual({ PreToolUse: [], SessionStart: [], Stop: [mine] });
      expect(run(['hooks/SessionStart']).hooks).toEqual({ PreToolUse: [], Stop: [mine] });
      expect(run(['hooks/PreToolUse', 'hooks/SessionStart', 'hooks']).hooks).toEqual({ Stop: [mine] });
      const alone = text({ hooks: { PreToolUse: [ours('sdlc hook a')] } });
      expect(removeJsonKeys(alone, [pre], 'a.json', { pruneEmpty: ['hooks/PreToolUse'] })).toBe(text({ hooks: {} }));
      expect(removeJsonKeys(alone, [pre], 'a.json', { pruneEmpty: ['hooks/PreToolUse', 'hooks'] })).toBe('{}\n');
    });

    it('keeps an array that still holds a user element even when it may be pruned', () => {
      const before = text({ hooks: { PreToolUse: [mine, ours('sdlc hook a')] } });
      expect(removeJsonKeys(before, [pre], 'a.json', { pruneEmpty: true })).toBe(text({ hooks: { PreToolUse: [mine] } }));
    });

    it('works together with plain pointers in one call', () => {
      const before = text({ mcpServers: { github: {} }, hooks: { PreToolUse: [mine, ours('sdlc hook a')] } });
      expect(removeJsonKeys(before, [['mcpServers', 'github'], pre])).toBe(text({ hooks: { PreToolUse: [mine] } }));
    });
  });
});

describe('JSON merges splice into the user\'s own text', () => {
  const eol = '\r\n';
  const lines = (...rows: string[]): string => rows.join(eol) + eol;
  // Hand-written on purpose: inline arrays, blank lines, a literal and an escaped é, 1.0 and 1e3,
  // an integer beyond 2^53, odd spacing, CRLF. JSON.stringify would change every one of them.
  const HAND_WRITTEN = lines(
    '{',
    '  "editor":   "vim",',
    '  "tags": ["a",   "b", "c"],',
    '',
    '  "name": "caf\\u00e9 é",',
    '  "ratio": 1.0,',
    '  "big": 1e3,',
    '  "id": 12345678901234567890,',
    '',
    '  "mcpServers": {',
    '    "db": { "command": "x", "args": ["--a", "--b"] }',
    '  },',
    '  "hooks": {',
    '    "PreToolUse": [',
    '      { "matcher": "Edit", "hooks": [{ "type": "command", "command": "user hook" }] }',
    '    ],',
    '',
    '    "Stop": [ { "hooks": [] } ]',
    '  }',
    '}',
  );
  const github = { pointer: ['mcpServers', 'github'], value: { url: 'u' } };
  const OURS = (command: string): unknown => ({ matcher: 'Bash', hooks: [{ type: 'command', command }] });
  const ownItems = (pointer: string[], ...items: unknown[]) => ({ pointer, value: items, items: { marker: 'sdlc hook' } });

  /** `original` with `inserted` put at `at`: what a pure insertion must produce, nothing else changes. */
  const insertAt = (original: string, at: string, inserted: string): string => {
    const i = original.indexOf(at);
    expect(i).toBeGreaterThanOrEqual(0);
    return original.slice(0, i + at.length) + inserted + original.slice(i + at.length);
  };

  it('adds a member and takes it away again, byte for byte', () => {
    const merged = mergeJsonKeys(HAND_WRITTEN, [github], new Set()).text;
    // only the new member is added: after "db", indented like its sibling, with the file's CRLF
    const member = `,${eol}    "github": {${eol}      "url": "u"${eol}    }`;
    expect(merged).toBe(insertAt(HAND_WRITTEN, '"args": ["--a", "--b"] }', member));
    for (const kept of ['"tags": ["a",   "b", "c"],', '"name": "caf\\u00e9 é",', '"ratio": 1.0,', '"big": 1e3,', '"id": 12345678901234567890,']) {
      expect(merged).toContain(kept);
    }
    expect(removeJsonKeys(merged, [['mcpServers', 'github']], 'a.json', { pruneEmpty: false })).toBe(HAND_WRITTEN);
  });

  it('adds a missing top-level object and removes it again with its separating comma', () => {
    const entry = { pointer: ['permissions', 'allow'], value: ['Bash(ls)'] };
    const merged = mergeJsonKeys(HAND_WRITTEN, [entry], new Set());
    expect(merged.createdParents).toEqual(['permissions']);
    const member = `,${eol}  "permissions": {${eol}    "allow": [${eol}      "Bash(ls)"${eol}    ]${eol}  }`;
    expect(merged.text).toBe(insertAt(HAND_WRITTEN, '"Stop": [ { "hooks": [] } ]' + eol + '  }', member));
    expect(removeJsonKeys(merged.text, [['permissions', 'allow']], 'a.json', { pruneEmpty: ['permissions'] })).toBe(HAND_WRITTEN);
  });

  it('replaces only an owned value and leaves every other line as the user wrote it', () => {
    const entry = { pointer: ['mcpServers', 'db'], value: { command: 'y' } };
    const merged = mergeJsonKeys(HAND_WRITTEN, [entry], new Set(['mcpServers/db'])).text;
    const before = HAND_WRITTEN.split(eol);
    const after = merged.split(eol);
    expect(after).toHaveLength(before.length);
    const changed = after.flatMap((line, i) => (line === before[i] ? [] : [i]));
    expect(changed).toEqual([10]);
    expect(after[10]).toBe('    "db": {"command":"y"}');
  });

  it('appends an owned item to an inline array, and uninstall restores the file byte for byte', () => {
    const entry = ownItems(['hooks', 'Stop'], OURS('sdlc hook stop'));
    const merged = mergeJsonKeys(HAND_WRITTEN, [entry], new Set()).text;
    expect(merged).toBe(
      insertAt(HAND_WRITTEN, '{ "hooks": [] }', `, ${JSON.stringify(OURS('sdlc hook stop'))}`),
    );
    const marker = [{ pointer: ['hooks', 'Stop'], marker: 'sdlc hook' }];
    expect(removeJsonKeys(merged, marker, 'a.json', { pruneEmpty: false })).toBe(HAND_WRITTEN);
  });

  it('appends owned items to an array spread over lines in its layout, and takes them back out', () => {
    const entry = ownItems(['hooks', 'PreToolUse'], OURS('sdlc hook pre-tool'));
    const merged = mergeJsonKeys(HAND_WRITTEN, [entry], new Set()).text;
    const item = JSON.stringify(OURS('sdlc hook pre-tool'), null, 2).split('\n').join(`${eol}      `);
    expect(merged).toBe(
      insertAt(HAND_WRITTEN, '"command": "user hook" }] }', `,${eol}      ${item}`),
    );
    expect(merged).toContain('{ "matcher": "Edit", "hooks": [{ "type": "command", "command": "user hook" }] }');
    const marker = [{ pointer: ['hooks', 'PreToolUse'], marker: 'sdlc hook' }];
    expect(removeJsonKeys(merged, marker, 'a.json', { pruneEmpty: false })).toBe(HAND_WRITTEN);
  });

  it('refreshes an owned item in place of the old one and leaves the user items byte for byte', () => {
    const v1 = mergeJsonKeys(HAND_WRITTEN, [ownItems(['hooks', 'PreToolUse'], OURS('sdlc hook v1'))], new Set()).text;
    const v2 = mergeJsonKeys(v1, [ownItems(['hooks', 'PreToolUse'], OURS('sdlc hook v2'))], new Set()).text;
    expect(v2).toBe(
      mergeJsonKeys(HAND_WRITTEN, [ownItems(['hooks', 'PreToolUse'], OURS('sdlc hook v2'))], new Set()).text,
    );
    expect(v2).not.toContain('sdlc hook v1');
  });

  it('creates an owned array under an existing object and uninstall removes it with its comma', () => {
    const entry = ownItems(['hooks', 'SessionStart'], OURS('sdlc hook session-start'));
    const merged = mergeJsonKeys(HAND_WRITTEN, [entry], new Set());
    expect(merged.createdParents).toEqual(['hooks/SessionStart']);
    const member = `,${eol}    "SessionStart": [${eol}      ${JSON.stringify(OURS('sdlc hook session-start'), null, 2).split('\n').join(`${eol}      `)}${eol}    ]`;
    expect(merged.text).toBe(insertAt(HAND_WRITTEN, '"Stop": [ { "hooks": [] } ]', member));
    const marker = [{ pointer: ['hooks', 'SessionStart'], marker: 'sdlc hook' }];
    expect(removeJsonKeys(merged.text, marker, 'a.json', { pruneEmpty: ['hooks/SessionStart'] })).toBe(HAND_WRITTEN);
  });

  it('never rewrites what it does not touch: the 20-digit integer, 1.0 and 1e3 survive a merge and a removal', () => {
    const merged = mergeJsonKeys(HAND_WRITTEN, [github, ownItems(['hooks', 'Stop'], OURS('sdlc hook stop'))], new Set()).text;
    for (const kept of ['12345678901234567890', '1.0,', '1e3,', 'caf\\u00e9 é', '"tags": ["a",   "b", "c"],']) {
      expect(merged).toContain(kept);
    }
    const blank = (text: string): number => text.split(eol).filter(line => line === '').length;
    expect(blank(merged)).toBe(blank(HAND_WRITTEN));
    const restored = removeJsonKeys(
      merged,
      [['mcpServers', 'github'], { pointer: ['hooks', 'Stop'], marker: 'sdlc hook' }],
      'a.json',
      { pruneEmpty: false },
    );
    expect(restored).toBe(HAND_WRITTEN);
  });

  it('keeps LF files LF and tab-indented files tab-indented', () => {
    const lf = '{\n\t"a": [1,2],\n\n\t"mcpServers": {\n\t\t"db": {}\n\t}\n}';
    const merged = mergeJsonKeys(lf, [github], new Set()).text;
    expect(merged).toBe(insertAt(lf, '"db": {}', ',\n\t\t"github": {\n\t\t\t"url": "u"\n\t\t}'));
    expect(merged.includes('\r')).toBe(false);
    expect(removeJsonKeys(merged, [['mcpServers', 'github']], 'a.json', { pruneEmpty: false })).toBe(lf);
  });

  it('is not fooled by braces, brackets, commas and escapes inside strings', () => {
    const tricky = lines('{', '  "note": "a } ] , \\" { [ \\\\",', '  "mcpServers": { "db": { "command": "}" } }', '}');
    const merged = mergeJsonKeys(tricky, [github], new Set()).text;
    expect(JSON.parse(merged)).toEqual({ note: 'a } ] , " { [ \\', mcpServers: { db: { command: '}' }, github: { url: 'u' } } });
    expect(merged.startsWith(`{${eol}  "note": "a } ] , \\" { [ \\\\",${eol}`)).toBe(true);
    expect(removeJsonKeys(merged, [['mcpServers', 'github']], 'a.json', { pruneEmpty: false })).toBe(tricky);
  });

  it('refuses a file with comments instead of guessing, leaving it for the user to fix', () => {
    expect(() => mergeJsonKeys('{\n  // note\n  "a": 1\n}', [github], new Set(), 'a.json')).toThrow(/a\.json is not valid JSON/);
  });
});

describe('mergeTomlBlock', () => {
  it('creates the block when the file is absent', () => {
    const result = mergeTomlBlock(undefined, TOML_BODY, OWNED);
    expect(result.skipped).toEqual([]);
    expect(result.text).toBe(`${TOML_BEGIN}\n${TOML_BODY}\n${TOML_END}\n`);
  });

  it('replaces between the markers and leaves what follows alone', () => {
    const existing = `model = "x"\n\n${TOML_BEGIN}\n[old]\na = 1\n${TOML_END}\n\n[user]\nb = 2\n`;
    const result = mergeTomlBlock(existing, TOML_BODY, OWNED);
    expect(result.text).toBe(`model = "x"\n\n${TOML_BEGIN}\n${TOML_BODY}\n${TOML_END}\n\n[user]\nb = 2\n`);
  });

  it('is idempotent: tables inside the block do not count as defined by the user', () => {
    const once = mergeTomlBlock('model = "x"\n', TOML_BODY, OWNED);
    const twice = mergeTomlBlock(once.text, TOML_BODY, OWNED);
    expect(twice.skipped).toEqual([]);
    expect(twice.text).toBe(once.text);
  });

  it('detects a user table header with spaces and a trailing comment, and drops its child sections', () => {
    const body = `${GITHUB_TABLE}\n\n[mcp_servers.github.http_headers]\nX = "1"\n\n${CONTEXT7_TABLE}`;
    const existing = '  [mcp_servers.github]  # mine\ncommand = "x"\n';
    const result = mergeTomlBlock(existing, body, OWNED);
    expect(result.skipped).toEqual(['mcp_servers.github']);
    expect(blockBody(result.text, 'toml-block')).toBe(CONTEXT7_TABLE);
  });

  it('does not mistake a similar table for the owned one', () => {
    const existing = '[mcp_servers.github_enterprise]\nurl = "x"\n';
    expect(mergeTomlBlock(existing, TOML_BODY, OWNED).skipped).toEqual([]);
  });

  it('writes no block when the user already defines every table', () => {
    const existing = '[mcp_servers.github]\na = 1\n\n[mcp_servers.context7]\nb = 2\n';
    const result = mergeTomlBlock(existing, TOML_BODY, OWNED);
    expect(result.skipped).toEqual(['mcp_servers.github', 'mcp_servers.context7']);
    expect(result.text).toBe(existing);
    expect(mergeTomlBlock(undefined, GITHUB_TABLE, ['mcp_servers.github']).text).toContain(TOML_BEGIN);
  });

  it('removes a stale block when the user now defines every table', () => {
    const stale = `[mcp_servers.github]\na = 1\n\n${TOML_BEGIN}\n${GITHUB_TABLE.replace('[mcp_servers.github]', '[mcp_servers.other]')}\n${TOML_END}\n`;
    const result = mergeTomlBlock(stale, '[mcp_servers.github]\nx = 1', ['mcp_servers.github']);
    expect(result.text).toBe('[mcp_servers.github]\na = 1\n');
  });
});

describe('filterTomlBody and tomlTableText', () => {
  it('filterTomlBody reports the dropped tables and returns the remaining body', () => {
    const existing = '[mcp_servers.context7]\nx = 1\n';
    expect(filterTomlBody(existing, TOML_BODY, OWNED)).toEqual({ body: GITHUB_TABLE, skipped: ['mcp_servers.context7'] });
  });

  it('tomlTableText returns one table section without its trailing blank lines', () => {
    expect(tomlTableText(TOML_BODY, 'mcp_servers.github')).toBe(GITHUB_TABLE);
    expect(tomlTableText(TOML_BODY, 'mcp_servers.context7')).toBe(CONTEXT7_TABLE);
    expect(tomlTableText(TOML_BODY, 'mcp_servers.nope')).toBeUndefined();
  });
});
