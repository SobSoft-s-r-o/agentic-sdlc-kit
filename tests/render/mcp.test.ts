import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPlan, planApply } from '../../src/install/apply.js';
import { loadConfigFromString, setMcpIdValidator, type Config, type Harness } from '../../src/config/schema.js';
import type { Change, JsonKeysChange } from '../../src/render/changes.js';
import {
  loadMcpCatalog,
  mcpNotes,
  parseMcpCatalog,
  renderMcp,
  validateMcpIds,
  type McpServerDef,
} from '../../src/render/mcp.js';
import { expectGolden } from '../support/golden.js';
import { memoryFs } from '../support/memoryFs.js';

const HEADER = `
version: 1
harnesses: [claude, codex, gemini, agents-md]
mode: enforce
github:
  repo: acme/shop
  default_branch: main
  project: { owner: acme, owner_type: org, number: 7 }
owners: [shop-owner]
kit_ref: v1.2.3
task_types: { enabled: [tooling] }
`;

const cfgWith = (mcp = ''): Config => loadConfigFromString(`${HEADER}${mcp}`);
const ALL = 'mcp:\n  servers: [github, context7, playwright]\n';
const LOCAL_GITHUB = 'mcp:\n  servers: [github]\n  github_transport: local\n';
const USER_SCOPE = (servers: string, transport = 'remote'): string =>
  `mcp:\n  servers: [${servers}]\n  scope: user\n  github_transport: ${transport}\n`;

const TOKEN_NAME = 'GITHUB_PERSONAL_ACCESS_TOKEN';
const GITHUB_URL = 'https://api.githubcopilot.com/mcp/';
const DOCKER_ARGS = ['run', '-i', '--rm', '-e', TOKEN_NAME, 'ghcr.io/github/github-mcp-server'];

/** A config for a server the built-in catalog lacks: the id check is switched off for the call. */
const cfgWithCustom = (mcp: string): Config => {
  const restore = setMcpIdValidator(() => []);
  try {
    return cfgWith(mcp);
  } finally {
    restore();
  }
};

const only = <K extends Change['kind']>(changes: Change[], kind: K): Extract<Change, { kind: K }> => {
  expect(changes).toHaveLength(1);
  const [change] = changes;
  expect(change?.kind).toBe(kind);
  return change as Extract<Change, { kind: K }>;
};

const servers = (change: JsonKeysChange): Record<string, unknown> =>
  Object.fromEntries(
    change.entries.map(entry => {
      expect(entry.pointer).toHaveLength(2);
      expect(entry.pointer[0]).toBe('mcpServers');
      return [entry.pointer[1], entry.value];
    }),
  );

describe('MCP catalog', () => {
  it('lists github, context7 and playwright with the verified endpoints and commands', () => {
    expect(loadMcpCatalog()).toEqual([
      {
        id: 'github',
        description: "GitHub's official MCP server: repositories, issues, pull requests and Actions.",
        default: true,
        remote: { url: GITHUB_URL, auth: { header: 'Authorization', scheme: 'Bearer', env: TOKEN_NAME } },
        local: { command: 'docker', args: DOCKER_ARGS, env: [TOKEN_NAME] },
      },
      {
        id: 'context7',
        description: 'Up-to-date library documentation for the agent to look things up in.',
        default: false,
        local: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
      },
      {
        id: 'playwright',
        description: 'Browser automation and page inspection through Playwright.',
        default: false,
        local: { command: 'npx', args: ['@playwright/mcp@latest'] },
      },
    ]);
  });

  it('refuses an entry without a transport, a duplicate id and a malformed field', () => {
    const entry = (extra: string): string => `- id: demo\n  description: A demo.\n  default: false\n${extra}`;
    expect(() => parseMcpCatalog(entry(''))).toThrow(/demo.*remote or local/);
    expect(() => parseMcpCatalog(`${entry('  local: { command: x, args: [] }\n')}${entry('  local: { command: x, args: [] }\n')}`)).toThrow(
      /duplicate.*demo/,
    );
    expect(() => parseMcpCatalog(entry('  local: { command: x, args: [], env: ["not a name"] }\n'))).toThrow(/env/);
    expect(() =>
      parseMcpCatalog(entry('  remote: { url: "https://x.test/", auth: { header: Cookie, scheme: Bearer, env: TOKEN } }\n')),
    ).toThrow(/Authorization/);
    expect(() => parseMcpCatalog(entry('  local: { command: x, args: [], extra: 1 }\n'))).toThrow();
    expect(() => parseMcpCatalog('- id: "Bad Id"\n  description: d\n  default: false\n  local: { command: x, args: [] }\n')).toThrow(
      /id/,
    );
    expect(() => parseMcpCatalog('not: a list\n')).toThrow();
  });
});

describe('renderMcp, project scope, claude (.mcp.json)', () => {
  it('writes the remote github server with an env reference, never a value', () => {
    const { changes, userCommands } = renderMcp(cfgWith(), 'claude');
    expect(userCommands).toEqual([]);
    const change = only(changes, 'json-keys');
    expect(change.path).toBe('.mcp.json');
    expect(change.entries).toEqual([
      {
        pointer: ['mcpServers', 'github'],
        value: { type: 'http', url: GITHUB_URL, headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' } },
      },
    ]);
  });

  it('writes the local github server as docker with the variable forwarded by reference', () => {
    const change = only(renderMcp(cfgWith(LOCAL_GITHUB), 'claude').changes, 'json-keys');
    expect(servers(change)).toEqual({
      github: { command: 'docker', args: DOCKER_ARGS, env: { [TOKEN_NAME]: '${GITHUB_PERSONAL_ACCESS_TOKEN}' } },
    });
  });

  it('writes context7 and playwright as stdio servers with no env and no type', () => {
    const change = only(renderMcp(cfgWith(ALL), 'claude').changes, 'json-keys');
    expect(Object.keys(servers(change))).toEqual(['github', 'context7', 'playwright']);
    expect(servers(change)['context7']).toEqual({ command: 'npx', args: ['-y', '@upstash/context7-mcp'] });
    expect(servers(change)['playwright']).toEqual({ command: 'npx', args: ['@playwright/mcp@latest'] });
  });
});

describe('renderMcp, project scope, codex (.codex/config.toml)', () => {
  it('writes the remote github server with bearer_token_env_var', () => {
    const { changes, userCommands } = renderMcp(cfgWith(), 'codex');
    expect(userCommands).toEqual([]);
    const change = only(changes, 'toml-block');
    expect(change.path).toBe('.codex/config.toml');
    expect(change.ownedTables).toEqual(['mcp_servers.github']);
    expect(change.content).toBe(
      ['[mcp_servers.github]', `url = "${GITHUB_URL}"`, `bearer_token_env_var = "${TOKEN_NAME}"`].join('\n'),
    );
  });

  it('writes the local github server with env_vars', () => {
    const change = only(renderMcp(cfgWith(LOCAL_GITHUB), 'codex').changes, 'toml-block');
    expect(change.ownedTables).toEqual(['mcp_servers.github']);
    expect(change.content).toBe(
      [
        '[mcp_servers.github]',
        'command = "docker"',
        `args = ["run", "-i", "--rm", "-e", "${TOKEN_NAME}", "ghcr.io/github/github-mcp-server"]`,
        `env_vars = ["${TOKEN_NAME}"]`,
      ].join('\n'),
    );
  });

  it('separates the tables with a blank line and lists every owned table', () => {
    const change = only(renderMcp(cfgWith(ALL), 'codex').changes, 'toml-block');
    expect(change.ownedTables).toEqual(['mcp_servers.github', 'mcp_servers.context7', 'mcp_servers.playwright']);
    expect(change.content).toBe(
      [
        '[mcp_servers.github]',
        `url = "${GITHUB_URL}"`,
        `bearer_token_env_var = "${TOKEN_NAME}"`,
        '',
        '[mcp_servers.context7]',
        'command = "npx"',
        'args = ["-y", "@upstash/context7-mcp"]',
        '',
        '[mcp_servers.playwright]',
        'command = "npx"',
        'args = ["@playwright/mcp@latest"]',
      ].join('\n'),
    );
  });
});

describe('renderMcp, project scope, gemini (.gemini/settings.json)', () => {
  it('writes the remote github server with httpUrl and a $VAR header', () => {
    const { changes, userCommands } = renderMcp(cfgWith(), 'gemini');
    expect(userCommands).toEqual([]);
    const change = only(changes, 'json-keys');
    expect(change.path).toBe('.gemini/settings.json');
    expect(change.entries).toEqual([
      {
        pointer: ['mcpServers', 'github'],
        value: { httpUrl: GITHUB_URL, headers: { Authorization: 'Bearer $GITHUB_PERSONAL_ACCESS_TOKEN' } },
      },
    ]);
  });

  it('writes the local github server and the stdio servers with $VAR env', () => {
    const local = only(renderMcp(cfgWith(LOCAL_GITHUB), 'gemini').changes, 'json-keys');
    expect(servers(local)).toEqual({
      github: { command: 'docker', args: DOCKER_ARGS, env: { [TOKEN_NAME]: '$GITHUB_PERSONAL_ACCESS_TOKEN' } },
    });
    const all = only(renderMcp(cfgWith(ALL), 'gemini').changes, 'json-keys');
    expect(servers(all)['context7']).toEqual({ command: 'npx', args: ['-y', '@upstash/context7-mcp'] });
  });
});

describe('renderMcp, other cases', () => {
  it('writes nothing for an AGENTS.md-only harness', () => {
    expect(renderMcp(cfgWith(ALL), 'agents-md')).toEqual({ changes: [], userCommands: [] });
    expect(renderMcp(cfgWith(USER_SCOPE('github, context7')), 'agents-md')).toEqual({ changes: [], userCommands: [] });
  });

  it('takes the github transport from the config and leaves the other servers on local', () => {
    const remote = only(renderMcp(cfgWith(ALL), 'claude').changes, 'json-keys');
    expect((servers(remote)['github'] as { type?: string }).type).toBe('http');
    expect(servers(remote)['context7']).toHaveProperty('command', 'npx');

    const local = only(renderMcp(cfgWith(`${ALL}  github_transport: local\n`), 'claude').changes, 'json-keys');
    expect(servers(local)['github']).toHaveProperty('command', 'docker');
    expect(servers(local)['context7']).toHaveProperty('command', 'npx');
  });

  it('keeps the order of mcp.servers and emits one change per path', () => {
    const cfg = cfgWith('mcp:\n  servers: [playwright, github]\n');
    for (const harness of ['claude', 'codex', 'gemini'] as const) {
      const { changes } = renderMcp(cfg, harness);
      expect(changes).toHaveLength(1);
    }
    const change = only(renderMcp(cfg, 'claude').changes, 'json-keys');
    expect(Object.keys(servers(change))).toEqual(['playwright', 'github']);
    expect(only(renderMcp(cfg, 'codex').changes, 'toml-block').ownedTables).toEqual([
      'mcp_servers.playwright',
      'mcp_servers.github',
    ]);
  });

  it('uses a remote transport for a server that has no local one', () => {
    const catalog = parseMcpCatalog(
      [
        '- id: hosted',
        '  description: A hosted server.',
        '  default: false',
        '  remote: { url: "https://hosted.test/mcp" }',
      ].join('\n'),
    );
    const cfg = cfgWithCustom('mcp:\n  servers: [hosted]\n');
    const claude = only(renderMcp(cfg, 'claude', catalog).changes, 'json-keys');
    expect(servers(claude)['hosted']).toEqual({ type: 'http', url: 'https://hosted.test/mcp' });
    const gemini = only(renderMcp(cfg, 'gemini', catalog).changes, 'json-keys');
    expect(servers(gemini)['hosted']).toEqual({ httpUrl: 'https://hosted.test/mcp' });
    expect(only(renderMcp(cfg, 'codex', catalog).changes, 'toml-block').content).toBe(
      '[mcp_servers.hosted]\nurl = "https://hosted.test/mcp"',
    );
    const user = renderMcp(cfgWithCustom(USER_SCOPE('hosted')), 'claude', catalog).userCommands;
    expect(user).toEqual(['claude mcp add --scope user --transport http hosted https://hosted.test/mcp']);
  });

  it('throws when a configured id is not in the catalog it is given', () => {
    expect(() => renderMcp(cfgWith(), 'claude', [])).toThrow(/github/);
  });

  it('throws when the github transport the config asks for is not defined', () => {
    const catalog = loadMcpCatalog().map(def => (def.id === 'github' ? { id: def.id, description: def.description, default: def.default, local: def.local } : def));
    expect(() => renderMcp(cfgWith(), 'claude', catalog as McpServerDef[])).toThrow(/github.*remote/);
  });

  it('escapes TOML strings with the shared writer and quotes shell words only when needed', () => {
    const catalog = parseMcpCatalog(
      [
        '- id: odd',
        '  description: Odd arguments.',
        '  default: false',
        '  local: { command: run, args: ["say \\"hi\\"", "back\\\\slash", "two words", "it\'s"] }',
      ].join('\n'),
    );
    const toml = only(renderMcp(cfgWithCustom('mcp:\n  servers: [odd]\n'), 'codex', catalog).changes, 'toml-block').content;
    expect(toml).toBe(
      ['[mcp_servers.odd]', 'command = "run"', 'args = ["say \\"hi\\"", "back\\\\slash", "two words", "it\'s"]'].join('\n'),
    );
    const [command] = renderMcp(cfgWithCustom(USER_SCOPE('odd')), 'claude', catalog).userCommands;
    expect(command).toBe(`claude mcp add --scope user odd -- run 'say "hi"' 'back\\slash' 'two words' 'it'\\''s'`);
  });
});

describe('mcp.servers: [] (explicit opt-out)', () => {
  for (const scope of ['project', 'user']) {
    it(`renders no changes, commands or notes for any harness in ${scope} scope`, () => {
      const cfg = cfgWith(`mcp:\n  servers: []\n  scope: ${scope}\n`);
      for (const harness of ['claude', 'codex', 'gemini', 'agents-md'] as const) {
        expect(renderMcp(cfg, harness)).toEqual({ changes: [], userCommands: [] });
      }
      expect(mcpNotes(cfg)).toEqual([]);
    });
  }
});

describe('renderMcp, user scope', () => {
  const COMMANDS: Record<Exclude<Harness, 'agents-md'>, { remote: string; local: string }> = {
    // Every `$` is inside single quotes: the harness stores the reference, never the owner's token.
    claude: {
      remote: `claude mcp add --scope user --transport http github ${GITHUB_URL} --header 'Authorization: Bearer \${GITHUB_PERSONAL_ACCESS_TOKEN}'`,
      local: 'claude mcp add --scope user github -- docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server',
    },
    codex: {
      remote: `codex mcp add github --url ${GITHUB_URL} --bearer-token-env-var GITHUB_PERSONAL_ACCESS_TOKEN`,
      local: 'codex mcp add github -- docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server',
    },
    gemini: {
      remote: `gemini mcp add --scope user --transport http --header 'Authorization: Bearer $GITHUB_PERSONAL_ACCESS_TOKEN' github ${GITHUB_URL}`,
      // `--` keeps docker's own `-e` away from gemini, whose `-e` is `--env`; the variable is forwarded by reference.
      local:
        "gemini mcp add --scope user -e 'GITHUB_PERSONAL_ACCESS_TOKEN=$GITHUB_PERSONAL_ACCESS_TOKEN' github docker -- run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server",
    },
  };

  for (const harness of ['claude', 'codex', 'gemini'] as const) {
    it(`prints the exact ${harness} commands and writes no file`, () => {
      const remote = renderMcp(cfgWith(USER_SCOPE('github, context7, playwright')), harness);
      expect(remote.changes).toEqual([]);
      const stdio = (name: string, command: string, args: string): string =>
        harness === 'gemini'
          ? `gemini mcp add --scope user ${name} ${command} -- ${args}`
          : harness === 'codex'
            ? `codex mcp add ${name} -- ${command} ${args}`
            : `claude mcp add --scope user ${name} -- ${command} ${args}`;
      expect(remote.userCommands).toEqual([
        COMMANDS[harness].remote,
        stdio('context7', 'npx', '-y @upstash/context7-mcp'),
        stdio('playwright', 'npx', '@playwright/mcp@latest'),
      ]);

      const local = renderMcp(cfgWith(USER_SCOPE('github', 'local')), harness);
      expect(local.changes).toEqual([]);
      expect(local.userCommands).toEqual([COMMANDS[harness].local]);
    });
  }

  it('keeps every environment reference inside single quotes, so the owner shell cannot expand a token into the harness config', () => {
    const printed: string[] = [];
    for (const transport of ['remote', 'local']) {
      for (const harness of ['claude', 'codex', 'gemini'] as const) {
        printed.push(...renderMcp(cfgWith(USER_SCOPE('github, context7, playwright', transport)), harness).userCommands);
      }
    }
    expect(printed.length).toBeGreaterThan(10);
    for (const command of printed) {
      const outsideSingleQuotes = command.replace(/'(?:[^']|'\\'')*'/g, '');
      expect(outsideSingleQuotes, command).not.toContain('$');
    }
    // not vacuous: the references are there, quoted
    const all = printed.join('\n');
    expect(all).toContain("'Authorization: Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}'");
    expect(all).toContain("'Authorization: Bearer $GITHUB_PERSONAL_ACCESS_TOKEN'");
    expect(all).toContain("-e 'GITHUB_PERSONAL_ACCESS_TOKEN=$GITHUB_PERSONAL_ACCESS_TOKEN'");
  });

  it('puts the arguments of a gemini stdio server after "--" and leaves out the "--" when there are none', () => {
    const catalog = parseMcpCatalog(
      ['- id: bare', '  description: No arguments.', '  default: false', '  local: { command: bare-server, args: [] }'].join('\n'),
    );
    const cfg = cfgWithCustom(USER_SCOPE('bare'));
    expect(renderMcp(cfg, 'gemini', catalog).userCommands).toEqual(['gemini mcp add --scope user bare bare-server']);
    expect(renderMcp(cfg, 'codex', catalog).userCommands).toEqual(['codex mcp add bare -- bare-server']);
  });
});

describe('golden files', () => {
  for (const harness of ['claude', 'codex', 'gemini'] as const) {
    it(`${harness}: all three servers, remote github`, () => {
      expectGolden(`mcp/${harness}`, renderMcp(cfgWith(ALL), harness).changes);
    });
    it(`${harness}: local github`, () => {
      expectGolden(`mcp/${harness}-local`, renderMcp(cfgWith(LOCAL_GITHUB), harness).changes);
    });
  }
});

describe('secrets', () => {
  // Built at run time, so this repository never holds a literal that a secret scanner would flag.
  const FAKE = ['ghp', 'secretvalue0123456789'].join('_');
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[TOKEN_NAME];
    process.env[TOKEN_NAME] = FAKE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[TOKEN_NAME];
    else process.env[TOKEN_NAME] = saved;
  });

  it('never puts the token value into a change, a command or a note', () => {
    const outputs: string[] = [];
    for (const transport of ['remote', 'local']) {
      for (const scope of ['project', 'user']) {
        const text = `mcp:\n  servers: [github, context7, playwright]\n  scope: ${scope}\n  github_transport: ${transport}\n`;
        const cfg = cfgWith(text);
        for (const harness of ['claude', 'codex', 'gemini', 'agents-md'] as const) {
          outputs.push(JSON.stringify(renderMcp(cfg, harness)));
        }
        outputs.push(JSON.stringify(mcpNotes(cfg)));
      }
    }
    const all = outputs.join('\n');
    expect(all).not.toContain(FAKE);
    expect(all).not.toContain('secretvalue');
    // not vacuous: every harness refers to the variable by name
    expect(all).toContain('${GITHUB_PERSONAL_ACCESS_TOKEN}');
    expect(all).toContain('$GITHUB_PERSONAL_ACCESS_TOKEN');
    expect(all).toContain('bearer_token_env_var');
    expect(all).toContain('env_vars');
  });
});

describe('mcpNotes', () => {
  it('asks for the token and explains the harness approval steps', () => {
    expect(mcpNotes(cfgWith())).toEqual([
      'export GITHUB_PERSONAL_ACCESS_TOKEN before starting your agent',
      'Codex loads .codex/config.toml only for trusted projects',
      'approve the project MCP servers when Claude Code asks',
    ]);
  });

  it('follows the configured harnesses and servers', () => {
    const claudeOnly = loadConfigFromString(`${HEADER.replace('[claude, codex, gemini, agents-md]', '[claude]')}`);
    expect(mcpNotes(claudeOnly)).toEqual([
      'export GITHUB_PERSONAL_ACCESS_TOKEN before starting your agent',
      'approve the project MCP servers when Claude Code asks',
    ]);
    const codexOnly = loadConfigFromString(`${HEADER.replace('[claude, codex, gemini, agents-md]', '[codex, gemini]')}`);
    expect(mcpNotes(codexOnly)).toEqual([
      'export GITHUB_PERSONAL_ACCESS_TOKEN before starting your agent',
      'Codex loads .codex/config.toml only for trusted projects',
    ]);
  });

  it('has no token note without github, and no harness notes in user scope or without MCP files', () => {
    expect(mcpNotes(cfgWith('mcp:\n  servers: [context7]\n'))).toEqual([
      'Codex loads .codex/config.toml only for trusted projects',
      'approve the project MCP servers when Claude Code asks',
    ]);
    expect(mcpNotes(cfgWith(USER_SCOPE('github')))).toEqual(['export GITHUB_PERSONAL_ACCESS_TOKEN before starting your agent']);
    const agentsOnly = loadConfigFromString(HEADER.replace('[claude, codex, gemini, agents-md]', '[agents-md]'));
    expect(mcpNotes(agentsOnly)).toEqual([]);
  });

  it('tells a Codex user to add env_vars by hand when "codex mcp add" cannot forward a variable (user scope, local server with env)', () => {
    const note =
      'Codex cannot forward variables through "codex mcp add": add env_vars = ["GITHUB_PERSONAL_ACCESS_TOKEN"] to [mcp_servers.github] in ~/.codex/config.toml';
    expect(mcpNotes(cfgWith(USER_SCOPE('github, context7', 'local')))).toEqual([
      'export GITHUB_PERSONAL_ACCESS_TOKEN before starting your agent',
      note,
    ]);
    // remote github uses --bearer-token-env-var, servers without env need nothing, project scope writes env_vars itself
    expect(mcpNotes(cfgWith(USER_SCOPE('github, context7', 'remote')))).toEqual([
      'export GITHUB_PERSONAL_ACCESS_TOKEN before starting your agent',
    ]);
    expect(mcpNotes(cfgWith(USER_SCOPE('context7')))).toEqual([]);
    expect(mcpNotes(cfgWith(LOCAL_GITHUB))).not.toContain(note);
    // no Codex harness, no Codex note
    const noCodex = loadConfigFromString(
      `${HEADER.replace('[claude, codex, gemini, agents-md]', '[claude, gemini]')}${USER_SCOPE('github', 'local')}`,
    );
    expect(mcpNotes(noCodex)).toEqual(['export GITHUB_PERSONAL_ACCESS_TOKEN before starting your agent']);
  });
});

describe('catalog defaults', () => {
  it('the servers marked default in the catalog are what mcp.servers defaults to', () => {
    const defaults = loadMcpCatalog()
      .filter(def => def.default)
      .map(def => def.id);
    expect(defaults).toEqual(['github']);
    expect(cfgWith().mcp.servers).toEqual(defaults);
  });
});

describe('mcp.servers validation through the config', () => {
  const messageOf = (mcp: string): string => {
    try {
      cfgWith(mcp);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('the config was accepted');
  };

  it('rejects an unknown id through loadConfigFromString and names the catalog ids', () => {
    const message = messageOf('mcp:\n  servers: [github, nope]\n');
    expect(message).toContain('mcp.servers');
    expect(message).toContain('unknown MCP server "nope"');
    expect(message).toContain('github, context7, playwright');
  });

  it('accepts an empty list as the explicit opt-out, and keeps [github] when mcp is omitted', () => {
    expect(cfgWith('mcp:\n  servers: []\n').mcp.servers).toEqual([]);
    expect(cfgWith().mcp.servers).toEqual(['github']);
  });

  it('rejects a duplicate id once, however often it repeats', () => {
    const message = messageOf('mcp:\n  servers: [github, context7, github, github]\n');
    expect(message).toContain('mcp.servers');
    expect(message.match(/duplicate MCP server "github"/g)).toHaveLength(1);
  });

  it('accepts every catalog id, and validateMcpIds reports each problem as one message', () => {
    expect(cfgWith(ALL).mcp.servers).toEqual(['github', 'context7', 'playwright']);
    expect(validateMcpIds(['github', 'context7'])).toEqual([]);
    expect(validateMcpIds([])).toEqual([]);
    expect(validateMcpIds(['a', 'github', 'github'])).toHaveLength(2);
  });

  it('is what the config asks by default, and an injected validator still replaces it', () => {
    const restore = setMcpIdValidator(ids => ids.map(id => `custom check rejects ${id}`));
    try {
      expect(messageOf('mcp:\n  servers: [github]\n')).toContain('custom check rejects github');
    } finally {
      restore();
    }
    expect(cfgWith('mcp:\n  servers: [github]\n').mcp.servers).toEqual(['github']);
    expect(messageOf('mcp:\n  servers: [nope]\n')).toContain('unknown MCP server "nope"');
  });
});

describe('through the apply engine', () => {
  it('merges into the files a user already has and keeps their content', () => {
    const fs = memoryFs({
      '.mcp.json': '{\n  "mcpServers": {\n    "mine": { "command": "mine" }\n  }\n}\n',
      '.codex/config.toml': 'model = "gpt-x"\n\n[mcp_servers.mine]\ncommand = "mine"\n',
      '.gemini/settings.json': '{\n  "theme": "dark"\n}\n',
    });
    const cfg = cfgWith(ALL);
    const changes = (['claude', 'codex', 'gemini'] as const).flatMap(h => renderMcp(cfg, h).changes);
    const plan = planApply(changes, fs, undefined, { overwriteModified: false });
    expect(plan.errors).toEqual([]);
    expect(applyPlan(plan, fs, { removeObsolete: false }).errors).toEqual([]);

    const claude = JSON.parse(fs.read('.mcp.json') ?? '') as { mcpServers: Record<string, unknown> };
    expect(Object.keys(claude.mcpServers)).toEqual(['mine', 'github', 'context7', 'playwright']);
    const gemini = JSON.parse(fs.read('.gemini/settings.json') ?? '') as { theme: string; mcpServers: Record<string, unknown> };
    expect(gemini.theme).toBe('dark');
    expect(Object.keys(gemini.mcpServers)).toEqual(['github', 'context7', 'playwright']);
    const toml = fs.read('.codex/config.toml') ?? '';
    expect(toml.startsWith('model = "gpt-x"\n\n[mcp_servers.mine]\ncommand = "mine"\n')).toBe(true);
    for (const id of ['github', 'context7', 'playwright']) expect(toml).toContain(`[mcp_servers.${id}]`);
  });
});
