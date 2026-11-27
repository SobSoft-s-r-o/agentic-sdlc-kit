import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyPlan,
  formatPlan,
  planApply,
  planUninstall,
  type ApplyPlan,
} from '../../src/install/apply.js';
import {
  MANIFEST_PATH,
  canonicalJson,
  entryDiskHash,
  hashText,
  parseManifest,
  readManifest,
  type Manifest,
} from '../../src/install/manifest.js';
import { blockBody } from '../../src/install/merge.js';
import { nodeRepoFs, type RepoFs } from '../../src/install/repoFs.js';
import type { Change } from '../../src/render/changes.js';
import { packageVersion } from '../../src/version.js';
import { memoryFs, type MemoryFs } from '../support/memoryFs.js';

const AGENT = '.claude/agents/sdlc-dev.md';
const SKILL = '.claude/skills/sdlc-review/SKILL.md';
const HOOK = '.sdlc/githooks/pre-commit';
const MODIFIED = 'modified locally; kept (rerun with --overwrite-modified to replace)';
const UNMANAGED = 'exists, not managed by sdlc; kept';

const GITHUB_TABLE = '[mcp_servers.github]\nurl = "https://api.githubcopilot.com/mcp/"\nbearer_token_env_var = "GITHUB_PERSONAL_ACCESS_TOKEN"';
const CONTEXT7_TABLE = '[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]';
const TOML_BODY = `${GITHUB_TABLE}\n\n${CONTEXT7_TABLE}`;

const GITHUB_SERVER = { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' } };
const CONTEXT7_SERVER = { command: 'npx', args: ['-y', '@upstash/context7-mcp'] };

interface Versions {
  agent?: string;
  skill?: boolean;
  rules?: string;
  servers?: Array<'github' | 'context7'>;
  toml?: boolean;
}

/** The changes a small install renders; `v` varies them the way a template or config change would. */
function changes(v: Versions = {}): Change[] {
  const servers = v.servers ?? ['github', 'context7'];
  const list: Change[] = [
    { kind: 'file', path: AGENT, content: v.agent ?? 'agent v1\n' },
    { kind: 'file', path: HOOK, content: '#!/bin/sh\nexit 0\n', mode: 0o755 },
    { kind: 'md-block', path: 'CLAUDE.md', content: v.rules ?? 'rules v1' },
    { kind: 'line-block', path: '.gitignore', content: '.sdlc/cache/\n.env', comment: '#' },
    {
      kind: 'json-keys',
      path: '.mcp.json',
      entries: servers.map(id => ({ pointer: ['mcpServers', id], value: id === 'github' ? GITHUB_SERVER : CONTEXT7_SERVER })),
    },
  ];
  if (v.skill !== false) list.push({ kind: 'file', path: SKILL, content: 'skill v1\n' });
  if (v.toml !== false) {
    list.push({
      kind: 'toml-block',
      path: '.codex/config.toml',
      content: TOML_BODY,
      ownedTables: ['mcp_servers.github', 'mcp_servers.context7'],
    });
  }
  return list;
}

function plan(cs: Change[], fs: RepoFs, opts: { overwriteModified?: boolean } = {}): ApplyPlan {
  return planApply(cs, fs, readManifest(fs), { overwriteModified: opts.overwriteModified ?? false });
}

function install(cs: Change[], fs: RepoFs, opts: { overwriteModified?: boolean; removeObsolete?: boolean } = {}) {
  const p = plan(cs, fs, opts);
  const result = applyPlan(p, fs, { removeObsolete: opts.removeObsolete ?? false });
  return { plan: p, result };
}

const manifestOf = (fs: RepoFs): Manifest => readManifest(fs)!;
const find = (m: Manifest, path: string, key?: string) => m.entries.filter(e => e.path === path && e.key === key);

describe('manifest helpers', () => {
  it('hashText is sha256 of the text with line endings normalised', () => {
    expect(hashText('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashText('a\r\nb')).toBe(hashText('a\nb'));
  });

  it('canonicalJson sorts keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
    expect(hashText(canonicalJson({ x: 1, y: 2 }))).toBe(hashText(canonicalJson({ y: 2, x: 1 })));
  });

  it('parseManifest rejects what is not a version 1 manifest', () => {
    expect(() => parseManifest('not json')).toThrow(/not valid JSON/);
    expect(() => parseManifest('{"version":2,"kit":"1","entries":[]}')).toThrow(/version 2/);
    expect(() => parseManifest('{"version":1,"kit":"1","entries":[{"path":"a"}]}')).toThrow(/manifest/);
    const ok = parseManifest('{"version":1,"kit":"0.1.0","entries":[{"path":"a","kind":"file","hash":"sha256:00"}]}');
    expect(ok.entries).toEqual([{ path: 'a', kind: 'file', hash: 'sha256:00' }]);
  });

  it('readManifest is undefined without a manifest and throws on a damaged one', () => {
    expect(readManifest(memoryFs())).toBeUndefined();
    expect(() => readManifest(memoryFs({ [MANIFEST_PATH]: '{' }))).toThrow(`${MANIFEST_PATH} is not valid JSON`);
  });
});

describe('planApply and applyPlan', () => {
  let fs: MemoryFs;
  beforeEach(() => {
    fs = memoryFs();
  });

  it('creates everything from an empty repository', () => {
    const p = plan(changes(), fs);
    expect(p.errors).toEqual([]);
    expect(p.notices).toEqual([]);
    expect(p.writes.map(w => `${w.action} ${w.path}`)).toEqual([
      'create .claude/agents/sdlc-dev.md',
      'create .claude/skills/sdlc-review/SKILL.md',
      'create .codex/config.toml',
      'create .gitignore',
      'create .mcp.json',
      'create .sdlc/githooks/pre-commit',
      'create CLAUDE.md',
    ]);
    expect(fs.log).toEqual([]);

    const result = applyPlan(p, fs, { removeObsolete: false });
    expect(result.errors).toEqual([]);
    expect(result.written).toHaveLength(7);
    expect(fs.read(AGENT)).toBe('agent v1\n');
    expect(fs.read('CLAUDE.md')).toBe('<!-- sdlc:begin -->\nrules v1\n<!-- sdlc:end -->\n');
    expect(fs.read('.gitignore')).toBe('# sdlc:begin\n.sdlc/cache/\n.env\n# sdlc:end\n');
    expect(JSON.parse(fs.read('.mcp.json')!)).toEqual({ mcpServers: { github: GITHUB_SERVER, context7: CONTEXT7_SERVER } });
    expect(fs.read('.codex/config.toml')).toContain(`${TOML_BODY}\n# <<< sdlc:end <<<\n`);
    expect(fs.modes.get(HOOK)).toBe(0o755);
    expect(fs.modes.has(AGENT)).toBe(false);
  });

  it('writes the manifest last, with sorted entries and the hashes of what it wrote', () => {
    install(changes(), fs);
    expect(fs.log.at(-1)).toBe(`write ${MANIFEST_PATH}`);
    const text = fs.read(MANIFEST_PATH)!;
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);

    const manifest = manifestOf(fs);
    expect(manifest.version).toBe(1);
    expect(manifest.kit).toBe(packageVersion());
    expect(manifest.entries.some(e => e.path === MANIFEST_PATH)).toBe(false);
    const order = manifest.entries.map(e => `${e.path}\u0000${e.key ?? ''}`);
    expect(order).toEqual([...order].sort());

    expect(find(manifest, AGENT)).toEqual([{ path: AGENT, kind: 'file', hash: hashText('agent v1\n') }]);
    expect(find(manifest, 'CLAUDE.md')).toEqual([{ path: 'CLAUDE.md', kind: 'md-block', hash: hashText('rules v1') }]);
    expect(find(manifest, '.gitignore')).toEqual([
      { path: '.gitignore', kind: 'line-block', hash: hashText('.sdlc/cache/\n.env') },
    ]);
    // .mcp.json did not exist, so the kit created it and says so (uninstall may then tidy up after itself)
    expect(find(manifest, '.mcp.json', 'mcpServers/github')).toEqual([
      {
        path: '.mcp.json',
        kind: 'json-keys',
        key: 'mcpServers/github',
        hash: hashText(canonicalJson(GITHUB_SERVER)),
        createdFile: true,
      },
    ]);
    expect(find(manifest, '.codex/config.toml')).toEqual([
      { path: '.codex/config.toml', kind: 'toml-block', hash: hashText(TOML_BODY) },
    ]);
    expect(find(manifest, '.codex/config.toml', 'mcp_servers.github')).toEqual([
      { path: '.codex/config.toml', kind: 'toml-block', key: 'mcp_servers.github', hash: hashText(GITHUB_TABLE) },
    ]);
    expect(find(manifest, '.codex/config.toml', 'mcp_servers.context7')[0]?.hash).toBe(hashText(CONTEXT7_TABLE));
  });

  it('a second plan has no writes and says everything is up to date', () => {
    install(changes(), fs);
    fs.log.length = 0;
    const second = install(changes(), fs);
    expect(second.plan.writes).toEqual([]);
    expect(second.plan.notices).toEqual([]);
    expect(second.plan.obsolete).toEqual([]);
    expect(formatPlan(second.plan, false)).toBe('Everything is up to date');
    expect(fs.log).toEqual([]);
  });

  it('every entry on disk matches its manifest hash after an install', () => {
    install(changes(), fs);
    for (const entry of manifestOf(fs).entries) {
      expect(entryDiskHash(entry, fs.read(entry.path))).toBe(entry.hash);
    }
  });

  it('updates managed content that nobody touched, and leaves user text around the blocks alone', () => {
    fs = memoryFs({ 'CLAUDE.md': '# Mine\n' });
    install(changes(), fs);
    fs.write('CLAUDE.md', `${fs.read('CLAUDE.md')!}\nAdded by the user after the block.\n`);
    const second = install(changes({ agent: 'agent v2\n', rules: 'rules v2', servers: ['github'] }), fs);
    expect(second.plan.writes.map(w => `${w.action} ${w.path}`)).toEqual([
      'update .claude/agents/sdlc-dev.md',
      'update CLAUDE.md',
    ]);
    expect(fs.read(AGENT)).toBe('agent v2\n');
    expect(fs.read('CLAUDE.md')).toBe(
      '# Mine\n\n<!-- sdlc:begin -->\nrules v2\n<!-- sdlc:end -->\n\nAdded by the user after the block.\n',
    );
    // context7 is no longer produced, but without removeObsolete it stays managed and in the file.
    expect(second.plan.obsolete.map(e => e.key)).toEqual(['mcpServers/context7']);
    expect(JSON.parse(fs.read('.mcp.json')!).mcpServers.context7).toEqual(CONTEXT7_SERVER);
    expect(find(manifestOf(fs), '.mcp.json', 'mcpServers/context7')).toHaveLength(1);
  });

  describe('keeps locally modified managed content', () => {
    it('an edited agent file is kept with a notice, no write and no error; --overwrite-modified replaces it', () => {
      install(changes(), fs);
      fs.write(AGENT, 'agent edited by the owner\n');
      fs.log.length = 0;

      const kept = install(changes({ agent: 'agent v2\n' }), fs);
      expect(kept.plan.notices).toEqual([{ path: AGENT, message: MODIFIED }]);
      expect(kept.plan.writes).toEqual([]);
      expect(kept.result.errors).toEqual([]);
      expect(kept.result.notices).toEqual([{ path: AGENT, message: MODIFIED }]);
      expect(fs.read(AGENT)).toBe('agent edited by the owner\n');
      expect(fs.log).toEqual([]);
      expect(find(manifestOf(fs), AGENT)[0]?.hash).toBe(hashText('agent v1\n'));
      expect(formatPlan(kept.plan, false)).toBe(`keep ${AGENT} (${MODIFIED})\nEverything is up to date`);

      // the notice repeats until the owner decides
      expect(install(changes({ agent: 'agent v2\n' }), fs).plan.notices).toHaveLength(1);

      const forced = install(changes({ agent: 'agent v2\n' }), fs, { overwriteModified: true });
      expect(forced.plan.notices).toEqual([]);
      expect(forced.plan.writes).toEqual([
        { action: 'update', path: AGENT, content: 'agent v2\n', previous: [{ path: AGENT, kind: 'file', hash: hashText('agent v1\n') }] },
      ]);
      expect(fs.read(AGENT)).toBe('agent v2\n');
      expect(find(manifestOf(fs), AGENT)[0]?.hash).toBe(hashText('agent v2\n'));
    });

    it('an edit that already equals the new content is accepted without a write or a notice', () => {
      install(changes(), fs);
      fs.write(AGENT, 'agent v2\n');
      const second = install(changes({ agent: 'agent v2\n' }), fs);
      expect(second.plan.writes).toEqual([]);
      expect(second.plan.notices).toEqual([]);
      expect(find(manifestOf(fs), AGENT)[0]?.hash).toBe(hashText('agent v2\n'));
    });

    const JSON_KEY = 'mcpServers/context7';
    it.each([
      ['an edit inside the Markdown block', 'CLAUDE.md', MODIFIED, (t: string) => t.replace('rules v1', 'rules v1 EDITED')],
      ['a Markdown block whose markers were deleted', 'CLAUDE.md', MODIFIED, () => '# Mine\n'],
      ['an edit inside the .gitignore block', '.gitignore', MODIFIED, (t: string) => t.replace('.env', '.env\nsecret.txt')],
      ['an edit inside the TOML block', '.codex/config.toml', MODIFIED, (t: string) => t.replace('npx', 'node')],
      [
        'an edited JSON server',
        '.mcp.json',
        `${JSON_KEY}: ${MODIFIED}`,
        (t: string) => t.replace('@upstash/context7-mcp', '@upstash/context7-mcp@1'),
      ],
      [
        'a JSON server the owner deleted',
        '.mcp.json',
        `${JSON_KEY}: ${MODIFIED}`,
        (t: string) => {
          const o = JSON.parse(t);
          delete o.mcpServers.context7;
          return `${JSON.stringify(o, null, 2)}\n`;
        },
      ],
    ])('%s', (_name, path, message, edit) => {
      install(changes(), fs);
      const edited = edit(fs.read(path)!);
      fs.write(path, edited);
      fs.log.length = 0;

      const kept = install(changes({ rules: 'rules v2', servers: ['github', 'context7'] }), fs);
      const notice = kept.plan.notices.find(n => n.path === path);
      expect(notice?.message).toBe(message);
      expect(fs.read(path)).toBe(edited);
      expect(fs.log.filter(l => l === `write ${path}`)).toEqual([]);
      expect(kept.result.errors).toEqual([]);
    });

    it('with --overwrite-modified a block is replaced and a deleted block comes back', () => {
      install(changes(), fs);
      fs.write('CLAUDE.md', '# Mine\n');
      install(changes({ rules: 'rules v2' }), fs, { overwriteModified: true });
      expect(fs.read('CLAUDE.md')).toBe('# Mine\n\n<!-- sdlc:begin -->\nrules v2\n<!-- sdlc:end -->\n');
    });

    it('with --overwrite-modified a deleted JSON server comes back', () => {
      install(changes(), fs);
      const o = JSON.parse(fs.read('.mcp.json')!);
      delete o.mcpServers.context7;
      fs.write('.mcp.json', JSON.stringify(o));
      install(changes(), fs, { overwriteModified: true });
      expect(JSON.parse(fs.read('.mcp.json')!).mcpServers.context7).toEqual(CONTEXT7_SERVER);
    });

    it('a managed file the owner deleted is created again', () => {
      install(changes(), fs);
      fs.remove(AGENT);
      const second = plan(changes(), fs);
      expect(second.writes.map(w => `${w.action} ${w.path}`)).toEqual([`create ${AGENT}`]);
      expect(second.notices).toEqual([]);
    });
  });

  it('keeps an existing file it does not manage, with a notice, even with --overwrite-modified', () => {
    fs = memoryFs({ [AGENT]: 'my own agent\n' });
    for (const overwriteModified of [false, true]) {
      const { plan: p, result } = install(changes(), fs, { overwriteModified });
      expect(p.notices).toEqual([{ path: AGENT, message: UNMANAGED }]);
      expect(p.writes.some(w => w.path === AGENT)).toBe(false);
      expect(result.errors).toEqual([]);
      expect(fs.read(AGENT)).toBe('my own agent\n');
      expect(manifestOf(fs).entries.some(e => e.path === AGENT)).toBe(false);
    }
  });

  describe('a customized repository', () => {
    const userClaude = '# My project\n\nHand written rules.\n';
    const userMcp = `${JSON.stringify({ mcpServers: { db: { command: 'db-server' }, github: { command: 'my-own-github' } } }, null, 2)}\n`;
    const userToml = 'model = "gpt-5"\napproval_policy = "on-request"\n\n[mcp_servers.github]\ncommand = "my-own-github"\n';
    const userIgnore = 'node_modules/\ndist/\n';

    beforeEach(() => {
      fs = memoryFs({ 'CLAUDE.md': userClaude, '.mcp.json': userMcp, '.codex/config.toml': userToml, '.gitignore': userIgnore });
    });

    it('keeps every byte outside the managed regions and does not take over the user github server', () => {
      const { plan: p, result } = install(changes(), fs);
      expect(result.errors).toEqual([]);
      expect(p.notices).toEqual([
        { path: '.codex/config.toml', message: 'mcp_servers.github already defined by you; kept' },
        { path: '.mcp.json', message: 'mcpServers/github already defined by you; kept' },
      ]);

      expect(fs.read('CLAUDE.md')!.startsWith(`${userClaude}\n<!-- sdlc:begin -->\n`)).toBe(true);
      expect(fs.read('.gitignore')!.startsWith(`${userIgnore}\n# sdlc:begin\n`)).toBe(true);
      const toml = fs.read('.codex/config.toml')!;
      expect(toml.startsWith(`${userToml}\n# >>> sdlc:begin`)).toBe(true);
      expect(blockBody(toml, 'toml-block')).toBe(CONTEXT7_TABLE);

      const mcp = JSON.parse(fs.read('.mcp.json')!);
      expect(mcp.mcpServers.db).toEqual({ command: 'db-server' });
      expect(mcp.mcpServers.github).toEqual({ command: 'my-own-github' });
      expect(mcp.mcpServers.context7).toEqual(CONTEXT7_SERVER);

      const manifest = manifestOf(fs);
      expect(find(manifest, '.mcp.json', 'mcpServers/github')).toEqual([]);
      expect(find(manifest, '.mcp.json', 'mcpServers/context7')).toHaveLength(1);
      expect(find(manifest, '.codex/config.toml', 'mcp_servers.github')).toEqual([]);
      expect(find(manifest, '.codex/config.toml', 'mcp_servers.context7')).toHaveLength(1);
    });

    it('a second run writes nothing, still names the user servers, and exits clean', () => {
      install(changes(), fs);
      fs.log.length = 0;
      const second = install(changes(), fs);
      expect(second.plan.writes).toEqual([]);
      expect(second.result.errors).toEqual([]);
      expect(second.plan.notices).toHaveLength(2);
      expect(fs.log).toEqual([]);
    });
  });

  describe('obsolete entries', () => {
    it('removes what no change produces any more when removeObsolete is set, and keeps the user parts', () => {
      fs = memoryFs({ '.codex/config.toml': 'model = "x"\n' });
      install(changes(), fs);
      const next = changes({ skill: false, toml: false, servers: ['github'] });
      const second = install(next, fs, { removeObsolete: true });

      expect(second.plan.obsolete.map(e => `${e.path}|${e.kind}|${e.key ?? ''}`)).toEqual([
        '.claude/skills/sdlc-review/SKILL.md|file|',
        '.codex/config.toml|toml-block|',
        '.mcp.json|json-keys|mcpServers/context7',
      ]);
      expect(second.result.errors).toEqual([]);
      expect(fs.read(SKILL)).toBeUndefined();
      expect(fs.read('.codex/config.toml')).toBe('model = "x"\n');
      expect(JSON.parse(fs.read('.mcp.json')!)).toEqual({ mcpServers: { github: GITHUB_SERVER } });
      const manifest = manifestOf(fs);
      expect(manifest.entries.some(e => e.path === SKILL || e.path === '.codex/config.toml')).toBe(false);
      expect(find(manifest, '.mcp.json', 'mcpServers/context7')).toEqual([]);
      expect(second.result.removed).toContain(SKILL);
    });

    it('a file we created whole is deleted, and a file left as {} is deleted', () => {
      install(changes(), fs);
      install(changes({ toml: false, servers: [] }).filter(c => c.kind !== 'json-keys'), fs, { removeObsolete: true });
      expect(fs.read('.codex/config.toml')).toBeUndefined();
      expect(fs.read('.mcp.json')).toBeUndefined();
    });

    it('keeps an obsolete file the owner modified, with a notice, and stops managing it', () => {
      install(changes(), fs);
      fs.write(SKILL, 'skill edited\n');
      const second = install(changes({ skill: false }), fs, { removeObsolete: true });
      expect(fs.read(SKILL)).toBe('skill edited\n');
      expect(second.result.notices).toEqual([
        { path: SKILL, message: 'no longer generated by sdlc and modified locally; kept' },
      ]);
      expect(second.result.errors).toEqual([]);
      expect(manifestOf(fs).entries.some(e => e.path === SKILL)).toBe(false);
      // and it does not nag the next time
      expect(install(changes({ skill: false }), fs, { removeObsolete: true }).result.notices).toEqual([]);
    });

    it('without removeObsolete nothing is removed and the entries stay in the manifest', () => {
      install(changes(), fs);
      const second = install(changes({ skill: false }), fs, { removeObsolete: false });
      expect(second.plan.obsolete.map(e => e.path)).toEqual([SKILL]);
      expect(fs.read(SKILL)).toBe('skill v1\n');
      expect(find(manifestOf(fs), SKILL)).toHaveLength(1);
      expect(formatPlan(second.plan, false)).toContain(`keep ${SKILL} (no longer generated; run sdlc upgrade to remove)`);
      expect(formatPlan(second.plan, false, { removeObsolete: true })).toContain(`remove ${SKILL} (no longer generated)`);
    });

    it('a file entry whose path is now produced as a block is not deleted from under that change', () => {
      install([...changes(), { kind: 'file', path: 'NOTES.md', content: 'notes\n' }], fs);
      const second = install([...changes(), { kind: 'md-block', path: 'NOTES.md', content: 'notes' }], fs, {
        removeObsolete: true,
      });
      expect(second.plan.obsolete).toEqual([]);
      expect(second.result.errors).toEqual([]);
      expect(fs.read('NOTES.md')).toBe('notes\n\n<!-- sdlc:begin -->\nnotes\n<!-- sdlc:end -->\n');
    });
  });

  describe('an error in one file never stops the others', () => {
    it('refuses damaged markers with a precise error and writes nothing to that file', () => {
      const damaged = 'user text\n<!-- sdlc:begin -->\nhalf a block\n';
      fs = memoryFs({ 'CLAUDE.md': damaged });
      const { plan: p, result } = install(changes(), fs);
      expect(p.errors).toHaveLength(1);
      expect(p.errors[0]?.path).toBe('CLAUDE.md');
      expect(p.errors[0]?.message).toMatch(/"<!-- sdlc:begin -->" at line 2 has no matching "<!-- sdlc:end -->"/);
      expect(result.errors).toHaveLength(1);
      expect(fs.read('CLAUDE.md')).toBe(damaged);
      expect(fs.read(AGENT)).toBe('agent v1\n');
      expect(fs.read('.gitignore')).toBeDefined();
      expect(fs.read('.codex/config.toml')).toBeDefined();
      expect(manifestOf(fs).entries.some(e => e.path === 'CLAUDE.md')).toBe(false);
      expect(formatPlan(p, false)).toContain('error CLAUDE.md: ');
    });

    it('refuses two begin markers', () => {
      const damaged = '<!-- sdlc:begin -->\na\n<!-- sdlc:end -->\n<!-- sdlc:begin -->\nb\n<!-- sdlc:end -->\n';
      fs = memoryFs({ 'CLAUDE.md': damaged });
      const { result } = install(changes(), fs);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toMatch(/more than one/);
      expect(fs.read('CLAUDE.md')).toBe(damaged);
    });

    it.each([
      ['.gitignore', '# sdlc:begin\n.env\n'],
      ['.codex/config.toml', 'model = "x"\n# >>> sdlc:begin (managed by agentic-sdlc-kit; edits inside are overwritten) >>>\n[a]\n'],
    ])('refuses damaged markers in %s and leaves it alone', (path, damaged) => {
      fs = memoryFs({ [path]: damaged });
      const { result } = install(changes(), fs);
      expect(result.errors.map(e => e.path)).toEqual([path]);
      expect(result.errors[0]?.message).toMatch(/has no matching/);
      expect(fs.read(path)).toBe(damaged);
      expect(fs.read(AGENT)).toBe('agent v1\n');
    });

    it('refuses an invalid JSON file by name', () => {
      fs = memoryFs({ '.mcp.json': '{ broken' });
      const { result } = install(changes(), fs);
      expect(result.errors).toEqual([{ path: '.mcp.json', message: '.mcp.json is not valid JSON; fix or remove it' }]);
      expect(fs.read('.mcp.json')).toBe('{ broken');
      expect(fs.read(AGENT)).toBe('agent v1\n');
    });

    it('keeps the entries it had for a file that is damaged later, so they are not treated as obsolete', () => {
      install(changes(), fs);
      fs.write('CLAUDE.md', '<!-- sdlc:begin -->\nbroken\n');
      const second = install(changes({ rules: 'rules v2' }), fs, { removeObsolete: true });
      expect(second.result.errors).toHaveLength(1);
      expect(second.plan.obsolete).toEqual([]);
      expect(find(manifestOf(fs), 'CLAUDE.md')).toHaveLength(1);
      expect(fs.read('CLAUDE.md')).toBe('<!-- sdlc:begin -->\nbroken\n');
    });

    it('a write that fails is reported once, the other files are written, and a retry creates it', () => {
      const realWrite = fs.write;
      fs.write = (p, content, mode) => {
        if (p === AGENT) throw new Error('disk full');
        realWrite(p, content, mode);
      };
      const { result } = install(changes(), fs);
      expect(result.errors).toEqual([{ path: AGENT, message: 'disk full' }]);
      expect(result.written).toHaveLength(6);
      expect(fs.read(SKILL)).toBe('skill v1\n');
      expect(manifestOf(fs).entries.some(e => e.path === AGENT)).toBe(false);

      fs.write = realWrite;
      const retry = install(changes(), fs);
      expect(retry.result.errors).toEqual([]);
      expect(retry.plan.writes.map(w => w.path)).toEqual([AGENT]);
      expect(find(manifestOf(fs), AGENT)).toHaveLength(1);
    });

    it('a failed update keeps the previous manifest entry', () => {
      install(changes(), fs);
      const realWrite = fs.write;
      fs.write = (p, content, mode) => {
        if (p === AGENT) throw new Error('read-only');
        realWrite(p, content, mode);
      };
      const { result } = install(changes({ agent: 'agent v2\n' }), fs);
      expect(result.errors).toHaveLength(1);
      expect(find(manifestOf(fs), AGENT)[0]?.hash).toBe(hashText('agent v1\n'));
    });
  });

  it('writes a byte-identical manifest however the changes are ordered and however often it runs', () => {
    const a = memoryFs();
    const b = memoryFs();
    install(changes(), a);
    install([...changes()].reverse(), b);
    expect(a.read(MANIFEST_PATH)).toBe(b.read(MANIFEST_PATH));
    const before = a.read(MANIFEST_PATH);
    install(changes(), a);
    install(changes(), a);
    expect(a.read(MANIFEST_PATH)).toBe(before);
  });

  it('records two changes to one path as an error instead of guessing', () => {
    const { result } = install(
      [
        { kind: 'md-block', path: 'AGENTS.md', content: 'one' },
        { kind: 'md-block', path: 'AGENTS.md', content: 'two' },
      ],
      fs,
    );
    expect(result.errors).toEqual([{ path: 'AGENTS.md', message: 'more than one change targets AGENTS.md' }]);
    expect(fs.read('AGENTS.md')).toBeUndefined();
  });

  it('refuses a path outside the repository through the fs', () => {
    const { result } = install([{ kind: 'file', path: '../escape.txt', content: 'x' }, ...changes()], fs);
    expect(result.errors.map(e => e.message)).toEqual(['refusing to write outside the repository: ../escape.txt']);
    expect(fs.read(AGENT)).toBe('agent v1\n');
  });
});

describe('formatPlan', () => {
  it('lists create, update, remove, keep and error lines and counts the changes', () => {
    const p: ApplyPlan = {
      writes: [
        { path: 'a', action: 'create', content: 'x' },
        { path: 'b', action: 'update', content: 'x' },
        { path: 'c', action: 'remove' },
      ],
      notices: [{ path: 'd', message: 'exists, not managed by sdlc; kept' }],
      errors: [{ path: 'e', message: 'bad markers' }],
      manifest: { version: 1, kit: '0.1.0', entries: [] },
      obsolete: [],
    };
    expect(formatPlan(p, false)).toBe(
      ['create a', 'update b', 'remove c', 'keep d (exists, not managed by sdlc; kept)', 'error e: bad markers', '3 changes'].join('\n'),
    );
    expect(formatPlan(p, true).split('\n').at(-1)).toBe('3 changes (dry run: nothing written)');
    expect(formatPlan({ ...p, writes: p.writes.slice(0, 1) }, false).split('\n').at(-1)).toBe('1 change');
  });

  it('says everything is up to date when there is nothing to write', () => {
    const p: ApplyPlan = { writes: [], notices: [], errors: [], manifest: { version: 1, kit: '0.1.0', entries: [] }, obsolete: [] };
    expect(formatPlan(p, true)).toBe('Everything is up to date');
  });
});

describe('planUninstall', () => {
  const userClaude = '# My project\n\nHand written rules.\n';
  const userMcp = `${JSON.stringify({ mcpServers: { db: { command: 'db-server' }, github: { command: 'my-own-github' } } }, null, 2)}\n`;
  const userToml = 'model = "gpt-5"\n\n[mcp_servers.github]\ncommand = "my-own-github"\n';
  const userIgnore = 'node_modules/\n';

  function customized(): MemoryFs {
    return memoryFs({ 'CLAUDE.md': userClaude, '.mcp.json': userMcp, '.codex/config.toml': userToml, '.gitignore': userIgnore });
  }

  it('removes only unmodified managed content, leaves user servers and text, and removes the manifest last', () => {
    const fs = customized();
    install(changes(), fs);

    fs.write(SKILL, 'skill edited by the owner\n');
    const mcp = JSON.parse(fs.read('.mcp.json')!);
    mcp.mcpServers.mine = { command: 'mine' };
    fs.write('.mcp.json', `${JSON.stringify(mcp, null, 2)}\n`);
    fs.write('CLAUDE.md', `${fs.read('CLAUDE.md')!}\nUser addition after the block.\n`);

    const p = planUninstall(fs, manifestOf(fs));
    expect(p.errors).toEqual([]);
    expect(p.notices).toEqual([{ path: SKILL, message: 'modified locally; kept' }]);
    expect(p.writes.at(-1)).toMatchObject({ path: MANIFEST_PATH, action: 'remove' });
    expect(p.writes.map(w => `${w.action} ${w.path}`)).toEqual([
      'remove .claude/agents/sdlc-dev.md',
      'update .codex/config.toml',
      'update .gitignore',
      'update .mcp.json',
      'remove .sdlc/githooks/pre-commit',
      'update CLAUDE.md',
      `remove ${MANIFEST_PATH}`,
    ]);

    const result = applyPlan(p, fs, { removeObsolete: false });
    expect(result.errors).toEqual([]);
    expect(fs.log.at(-1)).toBe(`remove ${MANIFEST_PATH}`);
    expect(fs.snapshot()).toEqual({
      '.codex/config.toml': userToml,
      '.gitignore': userIgnore,
      '.mcp.json': `${JSON.stringify({ mcpServers: { db: { command: 'db-server' }, github: { command: 'my-own-github' }, mine: { command: 'mine' } } }, null, 2)}\n`,
      [SKILL]: 'skill edited by the owner\n',
      'CLAUDE.md': `${userClaude}\nUser addition after the block.\n`,
    });
  });

  it('restores a repository to its pre-install bytes when nothing was edited', () => {
    const fs = customized();
    const before = fs.snapshot();
    install(changes(), fs);
    applyPlan(planUninstall(fs, manifestOf(fs)), fs, { removeObsolete: false });
    expect(fs.snapshot()).toEqual(before);
  });

  it('deletes files that only we created, including a .mcp.json that is left as {}', () => {
    const fs = memoryFs();
    install(changes(), fs);
    applyPlan(planUninstall(fs, manifestOf(fs)), fs, { removeObsolete: false });
    expect(fs.snapshot()).toEqual({});
  });

  it('keeps a modified block with a notice and still removes the manifest', () => {
    const fs = customized();
    install(changes(), fs);
    fs.write('CLAUDE.md', fs.read('CLAUDE.md')!.replace('rules v1', 'rules v1 edited'));
    const p = planUninstall(fs, manifestOf(fs));
    expect(p.notices).toEqual([{ path: 'CLAUDE.md', message: 'modified locally; kept' }]);
    applyPlan(p, fs, { removeObsolete: false });
    expect(fs.read('CLAUDE.md')).toContain('rules v1 edited');
    expect(fs.read(MANIFEST_PATH)).toBeUndefined();
  });

  it('skips a file that is already gone without a notice', () => {
    const fs = memoryFs();
    install(changes(), fs);
    fs.remove(AGENT);
    const p = planUninstall(fs, manifestOf(fs));
    expect(p.notices).toEqual([]);
    expect(p.writes.some(w => w.path === AGENT)).toBe(false);
  });

  it('an unreadable file is an error for that file only, and its entries stay in the manifest', () => {
    const fs = memoryFs();
    install(changes(), fs);
    fs.write('CLAUDE.md', '<!-- sdlc:begin -->\ndamaged\n');
    const p = planUninstall(fs, manifestOf(fs));
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]?.path).toBe('CLAUDE.md');
    expect(p.writes.some(w => w.path === MANIFEST_PATH)).toBe(false);
    const result = applyPlan(p, fs, { removeObsolete: false });
    expect(result.errors).toHaveLength(1);
    expect(fs.read(AGENT)).toBeUndefined();
    expect(find(manifestOf(fs), 'CLAUDE.md')).toHaveLength(1);
  });

  it('a removal that fails keeps the manifest, with that entry in it', () => {
    const fs = memoryFs();
    install(changes(), fs);
    const realRemove = fs.remove;
    fs.remove = p => {
      if (p === AGENT) throw new Error('locked');
      realRemove(p);
    };
    const result = applyPlan(planUninstall(fs, manifestOf(fs)), fs, { removeObsolete: false });
    expect(result.errors).toEqual([{ path: AGENT, message: 'locked' }]);
    expect(manifestOf(fs).entries.map(e => e.path)).toEqual([AGENT]);
  });
});

describe('JSON files keep the layout the user gave them', () => {
  const mcp = (servers: Array<'github' | 'context7'> = ['github', 'context7']): Change => ({
    kind: 'json-keys',
    path: '.mcp.json',
    entries: servers.map(id => ({ pointer: ['mcpServers', id], value: id === 'github' ? GITHUB_SERVER : CONTEXT7_SERVER })),
  });
  const uninstall = (fs: RepoFs) => applyPlan(planUninstall(fs, readManifest(fs)!), fs, { removeObsolete: false });

  describe.each([
    ['4 spaces', '    '],
    ['a tab', '\t'],
    ['2 spaces', '  '],
  ])('a user .mcp.json indented with %s', (_name, indent) => {
    for (const [tailName, tail] of [['a final newline', '\n'], ['no final newline', '']] as const) {
      it(`init writes in that layout and uninstall gives the original bytes back (${tailName})`, () => {
        const user = JSON.stringify({ editor: 'vim', mcpServers: { db: { command: 'db-server' } } }, null, indent) + tail;
        const fs = memoryFs({ '.mcp.json': user });

        const first = install([mcp()], fs);
        expect(first.result.errors).toEqual([]);
        expect(fs.read('.mcp.json')).toBe(
          JSON.stringify(
            { editor: 'vim', mcpServers: { db: { command: 'db-server' }, github: GITHUB_SERVER, context7: CONTEXT7_SERVER } },
            null,
            indent,
          ) + tail,
        );

        fs.log.length = 0;
        expect(install([mcp()], fs).plan.writes).toEqual([]);
        expect(fs.log).toEqual([]);

        expect(uninstall(fs).errors).toEqual([]);
        expect(fs.read('.mcp.json')).toBe(user);
        expect(fs.snapshot()).toEqual({ '.mcp.json': user });
      });
    }
  });

  it('a new .mcp.json gets two spaces and a final newline', () => {
    const fs = memoryFs();
    install([mcp(['context7'])], fs);
    expect(fs.read('.mcp.json')).toBe(`${JSON.stringify({ mcpServers: { context7: CONTEXT7_SERVER } }, null, 2)}\n`);
  });

  it('plans no write for .mcp.json when no key would be set, and leaves its bytes alone', () => {
    const user = '{ "mcpServers":\n      {"github":{"command":"mine"},   "context7":{"command":"mine too"}}  }\n\n';
    const fs = memoryFs({ '.mcp.json': user });
    const { plan: p, result } = install([mcp()], fs);
    expect(p.writes).toEqual([]);
    expect(p.notices).toEqual([
      { path: '.mcp.json', message: 'mcpServers/github already defined by you; kept' },
      { path: '.mcp.json', message: 'mcpServers/context7 already defined by you; kept' },
    ]);
    expect(result.errors).toEqual([]);
    expect(fs.read('.mcp.json')).toBe(user);
    expect(fs.log).not.toContain('write .mcp.json');
  });
});

describe('identical content is adopted without a word', () => {
  const agent = (content: string): Change => ({ kind: 'file', path: AGENT, content });
  const mcp: Change = {
    kind: 'json-keys',
    path: '.mcp.json',
    entries: [
      { pointer: ['mcpServers', 'github'], value: GITHUB_SERVER },
      { pointer: ['mcpServers', 'context7'], value: CONTEXT7_SERVER },
    ],
  };

  it('a file that already equals the desired content gets a manifest entry: no notice, no write', () => {
    const fs = memoryFs({ [AGENT]: 'agent v1\r\n' });
    const first = install([agent('agent v1\n')], fs);
    expect(first.plan.notices).toEqual([]);
    expect(first.plan.writes).toEqual([]);
    expect(first.result.errors).toEqual([]);
    expect(fs.log).toEqual([`write ${MANIFEST_PATH}`]);
    expect(fs.read(AGENT)).toBe('agent v1\r\n');
    expect(manifestOf(fs).entries).toEqual([{ path: AGENT, kind: 'file', hash: hashText('agent v1\n') }]);

    // it is ours from now on: an unmodified file is updated, and uninstall removes it
    install([agent('agent v2\n')], fs);
    expect(fs.read(AGENT)).toBe('agent v2\n');
    applyPlan(planUninstall(fs, manifestOf(fs)), fs, { removeObsolete: false });
    expect(fs.read(AGENT)).toBeUndefined();
  });

  it('a different existing file is still the user\'s, even with --overwrite-modified', () => {
    const fs = memoryFs({ [AGENT]: 'something else\n' });
    for (const overwriteModified of [false, true]) {
      const { plan: p } = install([agent('agent v1\n')], fs, { overwriteModified });
      expect(p.notices).toEqual([{ path: AGENT, message: UNMANAGED }]);
      expect(fs.read(AGENT)).toBe('something else\n');
    }
  });

  it('a user server equal to ours becomes owned with no notice; a different one stays theirs', () => {
    const sameButReordered = { headers: GITHUB_SERVER.headers, url: GITHUB_SERVER.url, type: GITHUB_SERVER.type };
    const user = `${JSON.stringify({ mcpServers: { github: sameButReordered } }, null, 2)}\n`;
    const fs = memoryFs({ '.mcp.json': user });

    const first = install([mcp], fs);
    expect(first.plan.notices).toEqual([]);
    expect(find(manifestOf(fs), '.mcp.json', 'mcpServers/github')).toEqual([
      { path: '.mcp.json', kind: 'json-keys', key: 'mcpServers/github', hash: hashText(canonicalJson(GITHUB_SERVER)) },
    ]);
    const parsed = JSON.parse(fs.read('.mcp.json')!);
    expect(Object.keys(parsed.mcpServers.github)).toEqual(['headers', 'url', 'type']);
    expect(parsed.mcpServers.context7).toEqual(CONTEXT7_SERVER);

    // owned now: a changed server config updates it
    const changed = { ...mcp, entries: [{ pointer: ['mcpServers', 'github'], value: { type: 'http', url: 'https://new.example/mcp' } }] };
    install([changed], fs, { removeObsolete: false });
    expect(JSON.parse(fs.read('.mcp.json')!).mcpServers.github).toEqual({ type: 'http', url: 'https://new.example/mcp' });

    const other = memoryFs({ '.mcp.json': `${JSON.stringify({ mcpServers: { github: { command: 'mine' } } }, null, 2)}\n` });
    expect(install([mcp], other).plan.notices).toEqual([
      { path: '.mcp.json', message: 'mcpServers/github already defined by you; kept' },
    ]);
  });
});

describe('createdFile on json-keys entries', () => {
  const mcp = (servers: Array<'github' | 'context7'> = ['github', 'context7']): Change => ({
    kind: 'json-keys',
    path: '.mcp.json',
    entries: servers.map(id => ({ pointer: ['mcpServers', id], value: id === 'github' ? GITHUB_SERVER : CONTEXT7_SERVER })),
  });
  const uninstall = (fs: RepoFs) => applyPlan(planUninstall(fs, readManifest(fs)!), fs, { removeObsolete: false });
  const flags = (fs: RepoFs) => manifestOf(fs).entries.map(e => e.createdFile);

  it('is recorded when the file did not exist, kept on later writes, and absent for a file the user had', () => {
    const fs = memoryFs();
    install([mcp()], fs);
    expect(flags(fs)).toEqual([true, true]);

    install([mcp(['github'])], fs, { removeObsolete: true });
    expect(flags(fs)).toEqual([true]);
    const edited = { ...mcp(['github']), entries: [{ pointer: ['mcpServers', 'github'], value: { type: 'http', url: 'https://v2.example' } }] };
    install([edited], fs);
    expect(flags(fs)).toEqual([true]);
    expect(manifestOf(fs).entries[0]?.hash).toBe(hashText(canonicalJson({ type: 'http', url: 'https://v2.example' })));

    const users = memoryFs({ '.mcp.json': `${JSON.stringify({ other: 1 }, null, 2)}\n` });
    install([mcp()], users);
    expect(flags(users)).toEqual([undefined, undefined]);
    expect(users.read(MANIFEST_PATH)).not.toContain('createdFile');
  });

  it('is recorded again when the owner deleted the file and the kit wrote it anew', () => {
    const fs = memoryFs({ '.mcp.json': `${JSON.stringify({ other: 1 }, null, 2)}\n` });
    install([mcp()], fs);
    fs.remove('.mcp.json');
    install([mcp()], fs);
    expect(flags(fs)).toEqual([true, true]);
  });

  it('a user `{"mcpServers": {}}` comes back byte-identical after init and uninstall', () => {
    for (const user of [
      `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`,
      JSON.stringify({ mcpServers: {} }, null, 4),
      `${JSON.stringify({ mcpServers: {} }, null, '\t')}\n`,
    ]) {
      const fs = memoryFs({ '.mcp.json': user });
      install([mcp()], fs);
      expect(JSON.parse(fs.read('.mcp.json')!).mcpServers).toEqual({ github: GITHUB_SERVER, context7: CONTEXT7_SERVER });
      expect(uninstall(fs).errors).toEqual([]);
      expect(fs.snapshot()).toEqual({ '.mcp.json': user });
    }
  });

  it('a file the kit created is tidied: mcpServers is pruned, a `{}` file is deleted, other keys stay', () => {
    const fs = memoryFs();
    install([mcp()], fs);
    uninstall(fs);
    expect(fs.snapshot()).toEqual({});

    install([mcp()], fs);
    const withTheme = { ...JSON.parse(fs.read('.mcp.json')!), theme: 'dark' };
    fs.write('.mcp.json', `${JSON.stringify(withTheme, null, 2)}\n`);
    uninstall(fs);
    expect(fs.snapshot()).toEqual({ '.mcp.json': `${JSON.stringify({ theme: 'dark' }, null, 2)}\n` });
  });

  it('a file the user had is never deleted, even when only `{}` is left of it', () => {
    const user = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;
    const fs = memoryFs({ '.mcp.json': user });
    install([mcp()], fs);
    uninstall(fs);
    expect(fs.read('.mcp.json')).toBe(user);

    // a file without the key we added: the object we added stays (we cannot tell it from the user's)
    const bare = memoryFs({ '.mcp.json': '{}\n' });
    install([mcp()], bare);
    uninstall(bare);
    expect(bare.read('.mcp.json')).toBe(`${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
  });

  it('survives the manifest round trip: the manifest is byte-identical on a second run', () => {
    const fs = memoryFs();
    install([mcp()], fs);
    const first = fs.read(MANIFEST_PATH);
    install([mcp()], fs);
    expect(fs.read(MANIFEST_PATH)).toBe(first);
    expect(first).toContain('"createdFile": true');
    expect(() => parseManifest(first ?? '')).not.toThrow();
  });
});

describe('a JSON pointer segment with a slash', () => {
  const bad: Change = { kind: 'json-keys', path: '.mcp.json', entries: [{ pointer: ['mcpServers', 'a/b'], value: { command: 'x' } }] };

  it('is an error for that file at plan time; the other files carry on and nothing is written to it', () => {
    const fs = memoryFs();
    const cs = [...changes().filter(c => c.path !== '.mcp.json'), bad];
    const p = plan(cs, fs);
    expect(p.errors).toEqual([{ path: '.mcp.json', message: '.mcp.json: key segment "a/b" must not contain "/"' }]);
    expect(p.writes.some(w => w.path === '.mcp.json')).toBe(false);
    expect(p.writes.some(w => w.path === AGENT)).toBe(true);

    const result = applyPlan(p, fs, { removeObsolete: false });
    expect(result.errors).toEqual(p.errors);
    expect(fs.read('.mcp.json')).toBeUndefined();
    expect(fs.read(AGENT)).toBe('agent v1\n');
  });

  it('keeps the entries the file had, so they are not treated as obsolete', () => {
    const fs = memoryFs();
    install(changes(), fs);
    const p = plan([...changes({ agent: 'agent v2\n' }).filter(c => c.path !== '.mcp.json'), bad], fs);
    expect(p.errors).toHaveLength(1);
    expect(p.obsolete).toEqual([]);
    expect(find(p.manifest, '.mcp.json', 'mcpServers/github')).toHaveLength(1);
    expect(p.writes.map(w => w.path)).toEqual([AGENT]);
  });

  it('a slash in the file name part of the pointer is rejected the same way, anywhere in the pointer', () => {
    const fs = memoryFs();
    const first = { ...bad, entries: [{ pointer: ['a/b', 'c'], value: 1 }] };
    expect(plan([first], fs).errors).toEqual([{ path: '.mcp.json', message: '.mcp.json: key segment "a/b" must not contain "/"' }]);
  });
});

describe('a TOML block whose tables are all the user\'s now', () => {
  const owned = ['mcp_servers.github'];
  const toml = (content = GITHUB_TABLE, tables = owned): Change => ({
    kind: 'toml-block',
    path: '.codex/config.toml',
    content,
    ownedTables: tables,
  });
  const count = (text: string, header: string): number => text.split('\n').filter(l => l.trim() === header).length;
  const userTable = '\n[mcp_servers.github]\ncommand = "my-own-github"\n';

  it('plans the removal of the stale block instead of leaving a duplicate table', () => {
    const fs = memoryFs({ '.codex/config.toml': 'model = "gpt-5"\n' });
    install([toml()], fs);
    expect(count(fs.read('.codex/config.toml')!, '[mcp_servers.github]')).toBe(1);

    fs.write('.codex/config.toml', fs.read('.codex/config.toml')! + userTable);
    expect(count(fs.read('.codex/config.toml')!, '[mcp_servers.github]')).toBe(2);

    const second = install([toml()], fs);
    expect(second.plan.errors).toEqual([]);
    expect(second.plan.writes).toEqual([
      expect.objectContaining({ path: '.codex/config.toml', action: 'update' }),
    ]);
    expect(second.plan.notices).toEqual([
      { path: '.codex/config.toml', message: 'mcp_servers.github already defined by you; kept' },
    ]);
    const text = fs.read('.codex/config.toml')!;
    expect(count(text, '[mcp_servers.github]')).toBe(1);
    expect(text).not.toContain('sdlc:begin');
    expect(text).toBe(`model = "gpt-5"\n${userTable}`);
    expect(manifestOf(fs).entries.filter(e => e.path === '.codex/config.toml')).toEqual([]);
    expect(second.plan.obsolete).toEqual([]);
  });

  it('is stable afterwards: the next run writes nothing and nothing is obsolete', () => {
    const fs = memoryFs();
    install([toml()], fs);
    fs.write('.codex/config.toml', fs.read('.codex/config.toml')! + userTable);
    install([toml()], fs);
    fs.log.length = 0;
    const third = install([toml()], fs);
    expect(third.plan.writes).toEqual([]);
    expect(third.plan.obsolete).toEqual([]);
    expect(fs.log).toEqual([]);
  });

  it('keeps a block the owner edited, with a notice, unless --overwrite-modified', () => {
    const fs = memoryFs();
    install([toml()], fs);
    const edited = fs.read('.codex/config.toml')!.replace('url = ', 'url_edited = ') + userTable;
    fs.write('.codex/config.toml', edited);

    const kept = install([toml()], fs);
    expect(kept.plan.writes).toEqual([]);
    expect(kept.plan.notices).toEqual([
      { path: '.codex/config.toml', message: MODIFIED },
      { path: '.codex/config.toml', message: 'mcp_servers.github already defined by you; kept' },
    ]);
    expect(fs.read('.codex/config.toml')).toBe(edited);
    expect(manifestOf(fs).entries.some(e => e.path === '.codex/config.toml' && e.key === undefined)).toBe(true);

    install([toml()], fs, { overwriteModified: true });
    expect(count(fs.read('.codex/config.toml')!, '[mcp_servers.github]')).toBe(1);
    expect(fs.read('.codex/config.toml')).not.toContain('sdlc:begin');
  });

  it('deletes a file that held only the block when the block is now empty', () => {
    const fs = memoryFs();
    install([toml()], fs);
    const p = plan([toml('# nothing to manage\n', [])], fs);
    expect(p.writes).toEqual([expect.objectContaining({ path: '.codex/config.toml', action: 'remove' })]);
    applyPlan(p, fs, { removeObsolete: false });
    expect(fs.read('.codex/config.toml')).toBeUndefined();
  });

  it('writes nothing for a user who defined every table before the first install', () => {
    const fs = memoryFs({ '.codex/config.toml': `${userTable.trimStart()}` });
    const { plan: p } = install([toml()], fs);
    expect(p.writes).toEqual([]);
    expect(p.notices).toEqual([{ path: '.codex/config.toml', message: 'mcp_servers.github already defined by you; kept' }]);
    expect(fs.read('.codex/config.toml')).toBe(userTable.trimStart());
  });
});

describe('nodeRepoFs', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'sdlc-fs-'));
    root = join(base, 'repo');
    outside = join(base, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
  });
  afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }));

  it('refuses any path that resolves outside the repository', () => {
    const fs = nodeRepoFs(root);
    const message = (p: string) => `refusing to write outside the repository: ${p}`;
    expect(() => fs.write('../x', 'y')).toThrow(message('../x'));
    expect(() => fs.write('a/../../x', 'y')).toThrow(message('a/../../x'));
    expect(() => fs.write(join(outside, 'abs.txt'), 'y')).toThrow(message(join(outside, 'abs.txt')));
    expect(() => fs.read('../x')).toThrow(message('../x'));
    expect(() => fs.remove('../x')).toThrow(message('../x'));
    expect(() => fs.list('..', 1)).toThrow(message('..'));
    expect(existsSync(join(root, '..', 'x'))).toBe(false);
    expect(existsSync(join(outside, 'abs.txt'))).toBe(false);
  });

  it('refuses to write through a symlink that leaves the repository', () => {
    symlinkSync(outside, join(root, 'link'));
    writeFileSync(join(outside, 'target.txt'), 'original');
    symlinkSync(join(outside, 'target.txt'), join(root, 'file-link'));
    const fs = nodeRepoFs(root);
    expect(() => fs.write('link/x.txt', 'y')).toThrow('refusing to write outside the repository: link/x.txt');
    expect(() => fs.write('file-link', 'y')).toThrow('refusing to write outside the repository: file-link');
    expect(readFileSync(join(outside, 'target.txt'), 'utf8')).toBe('original');
    expect(existsSync(join(outside, 'x.txt'))).toBe(false);
  });

  it('writes with parent directories and a mode, reads, lists and removes inside the repository', () => {
    const fs = nodeRepoFs(root);
    expect(fs.root).toBe(root);
    expect(fs.read('a/b.txt')).toBeUndefined();
    fs.write('a/b/hook', '#!/bin/sh\n', 0o755);
    fs.write('a/c.txt', 'c');
    expect(fs.read('a/b/hook')).toBe('#!/bin/sh\n');
    expect(statSync(join(root, 'a/b/hook')).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, 'a/c.txt')).mode & 0o111).toBe(0);
    expect(fs.list('a', 1)).toEqual(['a/b', 'a/c.txt']);
    expect(fs.list('a', 2)).toEqual(['a/b', 'a/b/hook', 'a/c.txt']);
    expect(fs.list('', 1)).toEqual(['a']);
    expect(fs.list('missing', 3)).toEqual([]);

    fs.remove('a/b/hook');
    expect(fs.read('a/b/hook')).toBeUndefined();
    fs.remove('a/b/hook');
    fs.remove('a/b');
    expect(fs.list('a', 3)).toEqual(['a/c.txt']);
    expect(() => fs.remove('a')).toThrow();
    expect(fs.read('a/c.txt')).toBe('c');
  });

  it('skips .git and node_modules when listing', () => {
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, '.git', 'HEAD'), 'x');
    writeFileSync(join(root, 'keep.txt'), 'x');
    expect(nodeRepoFs(root).list('', 3)).toEqual(['keep.txt']);
  });

  it('installs and uninstalls on a real directory and removes the empty directories it created', () => {
    const fs = nodeRepoFs(root);
    mkdirSync(join(root, '.claude/agents'), { recursive: true });
    writeFileSync(join(root, '.claude/agents/user-agent.md'), 'mine');
    writeFileSync(join(root, 'CLAUDE.md'), '# Mine\n');

    const { result } = install(changes(), fs);
    expect(result.errors).toEqual([]);
    expect(statSync(join(root, HOOK)).mode & 0o777).toBe(0o755);
    expect(existsSync(join(root, SKILL))).toBe(true);

    const uninstall = applyPlan(planUninstall(fs, manifestOf(fs)), fs, { removeObsolete: false });
    expect(uninstall.errors).toEqual([]);
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('# Mine\n');
    expect(existsSync(join(root, '.claude/agents/user-agent.md'))).toBe(true);
    expect(existsSync(join(root, AGENT))).toBe(false);
    expect(existsSync(join(root, '.claude/skills'))).toBe(false);
    expect(existsSync(join(root, '.sdlc'))).toBe(false);
    expect(existsSync(join(root, '.codex/config.toml'))).toBe(false);
  });

  it('keeps .sdlc while the user still has files in it', () => {
    const fs = nodeRepoFs(root);
    install(changes(), fs);
    mkdirSync(join(root, '.sdlc/agents/custom'), { recursive: true });
    writeFileSync(join(root, '.sdlc/agents/custom/mine.md'), 'mine');
    applyPlan(planUninstall(fs, manifestOf(fs)), fs, { removeObsolete: false });
    expect(existsSync(join(root, '.sdlc/agents/custom/mine.md'))).toBe(true);
    expect(existsSync(join(root, '.sdlc/githooks'))).toBe(false);
    expect(existsSync(join(root, MANIFEST_PATH))).toBe(false);
  });
});
