import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { graphifyInstall, mcpListArgs, mcpNames, superpowersInstall, superpowersInstalled, superpowersListArgs } from '../../src/install/stack.js';

describe('superpowersInstall', () => {
  it('names the install command of each harness', () => {
    expect(superpowersInstall('claude')).toBe('claude plugin install superpowers@claude-plugins-official');
    expect(superpowersInstall('codex')).toBe('codex plugin add superpowers@openai-curated');
    expect(superpowersInstall('gemini')).toBe('gemini extensions install https://github.com/obra/superpowers --consent');
  });
});

describe('graphifyInstall', () => {
  it('installs the tool, then registers the skill for each harness', () => {
    expect(graphifyInstall(['claude', 'codex', 'gemini'])).toEqual([
      'uv tool install graphifyy',
      'graphify install',
      'graphify install --platform codex',
      'graphify install --platform gemini',
    ]);
  });

  it('registers only the harnesses it is given, once each, and skips AGENTS.md', () => {
    expect(graphifyInstall(['gemini', 'agents-md', 'gemini'])).toEqual(['uv tool install graphifyy', 'graphify install --platform gemini']);
    expect(graphifyInstall(['agents-md'])).toEqual(['uv tool install graphifyy']);
  });
});

describe('the list commands', () => {
  it('asks each harness CLI for its plugins and its MCP servers in the form that is parsed here', () => {
    expect(superpowersListArgs('claude')).toEqual(['plugin', 'list', '--json']);
    expect(superpowersListArgs('codex')).toEqual(['plugin', 'list', '--json']);
    expect(superpowersListArgs('gemini')).toEqual(['extensions', 'list', '-o', 'json']);
    expect(mcpListArgs('claude')).toEqual(['mcp', 'list']);
    expect(mcpListArgs('codex')).toEqual(['mcp', 'list', '--json']);
    expect(mcpListArgs('gemini')).toEqual(['mcp', 'list']);
  });
});

describe('superpowersInstalled', () => {
  it('claude: an id that starts superpowers@', () => {
    const list = JSON.stringify([{ id: 'other@market', enabled: true }, { id: 'superpowers@claude-plugins-official', version: '7.0.2', enabled: true }]);
    expect(superpowersInstalled('claude', list)).toBe(true);
    expect(superpowersInstalled('claude', JSON.stringify([{ id: 'superpowers-extra@market' }, { id: 'other@superpowers@x' }]))).toBe(false);
    expect(superpowersInstalled('claude', '[]')).toBe(false);
  });

  it('codex: an installed plugin named superpowers', () => {
    const installed = (...names: string[]): string => JSON.stringify({ installed: names.map(name => ({ pluginId: `${name}@openai-curated`, name })), available: [] });
    expect(superpowersInstalled('codex', installed('superpowers'))).toBe(true);
    expect(superpowersInstalled('codex', installed('other'))).toBe(false);
    expect(superpowersInstalled('codex', installed())).toBe(false);
    // `available` is not installed
    expect(superpowersInstalled('codex', JSON.stringify({ installed: [], available: [{ name: 'superpowers' }] }))).toBe(false);
  });

  it('gemini: an extension named superpowers', () => {
    expect(superpowersInstalled('gemini', JSON.stringify([{ name: 'superpowers', version: '7.0.2', isActive: true }]))).toBe(true);
    expect(superpowersInstalled('gemini', JSON.stringify([{ name: 'superpowers-lite' }]))).toBe(false);
    expect(superpowersInstalled('gemini', '[]')).toBe(false);
  });

  describe('an installed plugin that is not in use', () => {
    const superpowers = (extra: Record<string, unknown>): string => JSON.stringify([{ id: 'superpowers@claude-plugins-official', version: '7.0.2', ...extra }]);
    const dirs: string[] = [];
    afterEach(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });
    const tempDir = (): string => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-stack-')));
      dirs.push(dir);
      return dir;
    };

    it('claude: a disabled plugin does not count; one with no enabled field does', () => {
      expect(superpowersInstalled('claude', superpowers({ scope: 'user', enabled: false }))).toBe(false);
      expect(superpowersInstalled('claude', superpowers({ scope: 'user', enabled: true }))).toBe(true);
      expect(superpowersInstalled('claude', superpowers({ scope: 'user' }))).toBe(true);
      expect(superpowersInstalled('claude', JSON.stringify([{ id: 'superpowers@a', enabled: false }, { id: 'superpowers@b', enabled: true }]))).toBe(true);
    });

    it('claude: a project or local plugin counts only for the repository it was installed in', () => {
      const repo = tempDir();
      const other = tempDir();
      for (const scope of ['project', 'local']) {
        expect(superpowersInstalled('claude', superpowers({ scope, enabled: true, projectPath: repo }), [repo]), scope).toBe(true);
        expect(superpowersInstalled('claude', superpowers({ scope, enabled: true, projectPath: other }), [repo]), scope).toBe(false);
        expect(superpowersInstalled('claude', superpowers({ scope, enabled: true }), [repo]), `${scope} without projectPath`).toBe(false);
        expect(superpowersInstalled('claude', superpowers({ scope, enabled: true, projectPath: repo }), []), `${scope} with no repository`).toBe(false);
      }
      // a user-scope plugin is for every repository, and projectPath is ignored there
      expect(superpowersInstalled('claude', superpowers({ scope: 'user', enabled: true, projectPath: other }), [repo])).toBe(true);
    });

    it('claude: the project path is compared by its real path, and any of the given roots matches', () => {
      const repo = tempDir();
      const main = tempDir();
      const link = join(tempDir(), 'link');
      symlinkSync(repo, link);
      mkdirSync(join(repo, 'sub'));
      expect(superpowersInstalled('claude', superpowers({ scope: 'project', enabled: true, projectPath: link }), [repo])).toBe(true);
      expect(superpowersInstalled('claude', superpowers({ scope: 'project', enabled: true, projectPath: repo }), [link])).toBe(true);
      expect(superpowersInstalled('claude', superpowers({ scope: 'project', enabled: true, projectPath: main }), [repo, main])).toBe(true);
      // a subdirectory is another project
      expect(superpowersInstalled('claude', superpowers({ scope: 'project', enabled: true, projectPath: join(repo, 'sub') }), [repo])).toBe(false);
      // a path that does not exist is compared as written
      expect(superpowersInstalled('claude', superpowers({ scope: 'project', enabled: true, projectPath: '/no/such/repo' }), ['/no/such/repo'])).toBe(true);
    });

    it('codex: a plugin with enabled: false does not count', () => {
      const installed = (plugin: Record<string, unknown>): string => JSON.stringify({ installed: [{ name: 'superpowers', ...plugin }], available: [] });
      expect(superpowersInstalled('codex', installed({ enabled: false }))).toBe(false);
      expect(superpowersInstalled('codex', installed({ enabled: true }))).toBe(true);
      expect(superpowersInstalled('codex', installed({}))).toBe(true);
    });

    it('gemini: an extension with isActive: false does not count', () => {
      const list = (extension: Record<string, unknown>): string => JSON.stringify([{ name: 'superpowers', ...extension }]);
      expect(superpowersInstalled('gemini', list({ isActive: false }))).toBe(false);
      expect(superpowersInstalled('gemini', list({ isActive: true }))).toBe(true);
      expect(superpowersInstalled('gemini', list({}))).toBe(true);
    });
  });

  it('throws for output that is not the list it expects', () => {
    for (const [harness, text] of [
      ['claude', 'no plugins'],
      ['claude', '{"id":"superpowers@x"}'],
      ['codex', '[]'],
      ['codex', '{"available":[]}'],
      ['gemini', 'No extensions installed.'],
      ['gemini', '{"name":"superpowers"}'],
    ] as const) {
      expect(() => superpowersInstalled(harness, text), `${harness}: ${text}`).toThrow();
    }
  });
});

describe('mcpNames', () => {
  it('claude: the word before ": " on each line, whole names only', () => {
    const text = ['Checking MCP server health...', '', 'github: https://api.githubcopilot.com/mcp/ (HTTP) - ✓ Connected', 'context7: npx -y @upstash/context7-mcp - ✓ Connected', ''].join('\n');
    expect([...mcpNames('claude', text)]).toEqual(['github', 'context7']);
    expect(mcpNames('claude', 'github-enterprise: https://x.test (HTTP) - ✓ Connected').has('github')).toBe(false);
    expect(mcpNames('claude', 'No MCP servers configured.').size).toBe(0);
  });

  it('codex: the name of each entry of the --json array', () => {
    const text = JSON.stringify([{ name: 'github', enabled: true }, { name: 'context7', enabled: false, disabled_reason: 'x' }]);
    expect([...mcpNames('codex', text)]).toEqual(['github', 'context7']);
    expect(mcpNames('codex', '[]').size).toBe(0);
    expect(() => mcpNames('codex', 'No MCP servers configured yet.')).toThrow();
    expect(() => mcpNames('codex', '{"name":"github"}')).toThrow();
  });

  it('gemini: the name after the status glyph, whichever glyph it is', () => {
    const text = [
      'Configured MCP servers:',
      '',
      '✓ github: https://api.githubcopilot.com/mcp/ (http) - Connected',
      '✗ sse-server: https://x.test/sse (sse) - Disconnected',
      '○ off-server: npx -y thing (stdio) - Disabled',
      '',
    ].join('\n');
    expect([...mcpNames('gemini', text)]).toEqual(['github', 'sse-server', 'off-server']);
    expect(mcpNames('gemini', 'No MCP servers configured.').size).toBe(0);
    expect(mcpNames('gemini', 'Configured MCP servers:').size).toBe(0);
  });
});
