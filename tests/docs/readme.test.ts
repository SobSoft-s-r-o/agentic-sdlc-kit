import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli.js';
import { loadConfigFromString } from '../../src/config/schema.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
/** The text of a document in the repository root; empty when it does not exist (a test then says so). */
const doc = (name: string): string => (existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : '');
const readme = doc('README.md');
const install = doc('INSTALL.md');

const BOOTSTRAP_PROMPT =
  'Install agentic-sdlc-kit from https://github.com/SobSoft-s-r-o/agentic-sdlc-kit into this repository. Follow its INSTALL.md.';

// --- reading the commands a document mentions ------------------------------------------------------

/** The lines of the fenced code blocks of a Markdown document without their trailing ` # comment`, then its inline `code spans`. */
function codeSnippets(markdown: string): string[] {
  const fenced: string[] = [];
  const prose = markdown.replace(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm, (_block, body: string) => {
    fenced.push(...body.split('\n').map(line => line.replace(/\s#(?:\s.*)?$/, '')));
    return '';
  });
  const inline = [...prose.matchAll(/`([^`\n]+)`/g)].map(match => match[1] ?? '');
  return [...fenced, ...inline];
}

interface Mention {
  /** The word after `sdlc`: `init`, `config`, ... */
  command: string;
  /** The next word, when it is a lowercase word (`suggest` in `sdlc config suggest`). */
  next?: string;
  /** Every `--flag` of the same command (the code up to the next `&&`, `||`, `;` or `|`). */
  flags: string[];
  /** The code the mention was read from, for the failure message. */
  code: string;
}

/**
 * A command mentioned in code is written in one of three forms, each followed by the command word:
 * `sdlc <word>` (a global install, or a name in running text),
 * `npx --no-install sdlc <word>` (the project dependency), and
 * `npx [-y] github:<owner>/agentic-sdlc-kit#<ref> <word>` (the first run, before it is installed).
 * Prose is not read, so a sentence such as "sdlc not found" is not a mention; a line is cut at `&&`,
 * `||`, `;` and `|` so each command keeps only its own flags.
 */
const CALL = /(?:\bnpx\s+--no-install\s+sdlc|\bnpx\s+(?:-y\s+)?\S*agentic-sdlc-kit#\S+|\bsdlc)\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/;

function mentions(markdown: string): Mention[] {
  const found: Mention[] = [];
  for (const snippet of codeSnippets(markdown)) {
    for (const part of snippet.split(/\s*(?:&&|\|\||[;|])\s*/)) {
      const call = CALL.exec(part);
      if (call === null) continue;
      // The flags of the sdlc command only: not npx's own (`--no-install`), which come before it.
      const rest = part.slice(call.index + call[0].length);
      const flags = [...rest.matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)].map(match => match[1] ?? '');
      found.push({ command: call[1] ?? '', ...(call[2] === undefined ? {} : { next: call[2] }), flags, code: part.trim() });
    }
  }
  return found;
}

const program = buildProgram();
const commandNamed = (parent: Command, name: string): Command | undefined => parent.commands.find(command => command.name() === name);
const optionsOf = (command: Command): string[] => command.options.flatMap(option => (option.long === undefined ? [] : [option.long]));
/** The options every command accepts: the program's own, and `--help`. */
const GLOBAL_FLAGS = [...optionsOf(program), '--help'];

/** The `sdlc <command>` words of `markdown` that `buildProgram()` does not have, and the like for subcommands and flags. */
function unknownMentions(markdown: string): string[] {
  const problems: string[] = [];
  for (const mention of mentions(markdown)) {
    const command = commandNamed(program, mention.command);
    if (command === undefined) {
      problems.push(`unknown command "${mention.command}" in: ${mention.code}`);
      continue;
    }
    let target = command;
    if (command.commands.length > 0 && mention.next !== undefined) {
      const sub = commandNamed(command, mention.next);
      if (sub === undefined) {
        problems.push(`unknown subcommand "${mention.command} ${mention.next}" in: ${mention.code}`);
        continue;
      }
      target = sub;
    }
    const known = [...optionsOf(target), ...GLOBAL_FLAGS];
    for (const flag of mention.flags) {
      if (!known.includes(flag)) problems.push(`unknown option ${flag} for "${mention.command}${target === command ? '' : ` ${target.name()}`}" in: ${mention.code}`);
    }
  }
  return problems;
}

const mentioned = (markdown: string): Set<string> =>
  new Set(mentions(markdown).map(mention => (mention.next === undefined ? mention.command : `${mention.command} ${mention.next}`)));

// --- the extractor itself ---------------------------------------------------------------------------

describe('the command extractor', () => {
  it('reads the three forms, and only code', () => {
    const text = [
      'Not code: sdlc nothing at all.',
      '```sh',
      'sdlc doctor',
      'npx --no-install sdlc config suggest --write   # sdlc to the rescue',
      'npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#<ref> init --dry-run && git status',
      '```',
      'Inline `npx --no-install sdlc review handoff <n> --pr <pr>` and `git commit` and `sdlc board`.',
    ].join('\n');
    expect(mentions(text).map(({ command, next, flags }) => ({ command, next, flags }))).toEqual([
      { command: 'doctor', flags: [] },
      { command: 'config', next: 'suggest', flags: ['--write'] },
      { command: 'init', flags: ['--dry-run'] },
      { command: 'review', next: 'handoff', flags: ['--pr'] },
      { command: 'board', flags: [] },
    ]);
  });

  it('does not take the flags of npx for the flags of sdlc', () => {
    expect(unknownMentions('`npx --no-install sdlc doctor --preflight`')).toEqual([]);
    expect(unknownMentions('`npx --no-install sdlc doctor --bogus`')).toHaveLength(1);
  });
});

// --- README ---------------------------------------------------------------------------------------------

describe('README', () => {
  it('states the current status: the core CLI, the installer and the harness hooks are available, the npm package is next', () => {
    const status = readme.split('\n').find(line => line.startsWith('> Status:'));
    expect(status).toBe('> Status: core CLI, installer and harness hooks available; npm package next');
  });

  it('gives the bootstrap prompt, exactly, in a code block', () => {
    const blocks = [...readme.matchAll(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm)].map(match => (match[1] ?? '').trim());
    expect(blocks).toContain(BOOTSTRAP_PROMPT);
  });

  it('has a two-minute walkthrough and points to INSTALL.md', () => {
    expect(readme).toMatch(/^#{2,3} .*(two|2)[- ]minute/im);
    expect(readme).toContain('(INSTALL.md)');
  });

  it('lists the installer commands', () => {
    const words = mentioned(readme);
    for (const command of ['init', 'upgrade', 'uninstall', 'doctor', 'config', 'githook']) {
      expect(words.has(command) || [...words].some(word => word.startsWith(`${command} `)), `README mentions sdlc ${command}`).toBe(true);
    }
  });

  it('mentions only commands, subcommands and options that sdlc has', () => {
    expect(mentions(readme).length).toBeGreaterThan(10);
    expect(unknownMentions(readme)).toEqual([]);
  });

  it('lists every command that sdlc registers, and every subcommand', () => {
    const words = mentioned(readme);
    // The command list writes sibling subcommands as one span: `sdlc worktree start | finish`.
    for (const snippet of codeSnippets(readme)) {
      const span = /^sdlc\s+([a-z][a-z-]*)\s+(.*)$/.exec(snippet);
      if (span === null) continue;
      for (const alternative of (span[2] ?? '').split('|')) {
        const name = /^\s*([a-z][a-z-]*)(?:\s|$)/.exec(alternative)?.[1];
        if (name !== undefined) words.add(`${span[1] ?? ''} ${name}`);
      }
    }
    const missing: string[] = [];
    for (const command of program.commands) {
      if (command.commands.length === 0) {
        if (!words.has(command.name())) missing.push(command.name());
        continue;
      }
      for (const sub of command.commands) {
        if (!words.has(`${command.name()} ${sub.name()}`)) missing.push(`${command.name()} ${sub.name()}`);
      }
    }
    expect(missing, 'commands the README does not mention').toEqual([]);
  });

  it('walks through the install in the order that works', () => {
    const walkthrough = readme.slice(readme.search(/^## Two-minute walkthrough/m), readme.search(/^## CLI/m));
    expect(walkthrough).toContain('`<ref>` is the kit version: a release tag such as `v0.2.0`, or `main`');
    const steps = ['doctor --preflight', 'config suggest --write', 'set kit_ref to <ref>', 'init --dry-run', 'init  ', 'set github.project.number to N', 'npm install --save-dev', 'npx --no-install sdlc doctor'];
    const positions = steps.map(step => walkthrough.indexOf(step));
    expect(positions.map((position, index) => (position < 0 ? steps[index] : ''))).toEqual(steps.map(() => ''));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(walkthrough).toContain('expect only actions.secret and mcp.token to complain');
    expect(walkthrough).not.toMatch(/every check should pass/i);
  });
});

// --- INSTALL.md -----------------------------------------------------------------------------------------

/** The install questions of the design's section 6, in its order: the heading each gets and the config keys it settles. */
const QUESTION_TOPICS: Array<{ topic: string; heading: RegExp; terms: string[] }> = [
  { topic: 'harnesses', heading: /harnesses/i, terms: ['Key `harnesses`', '`agents-md`'] },
  { topic: 'board', heading: /board/i, terms: ['`github.project`', '`owner_type`', '`config suggest` never sets `number`'] },
  { topic: 'enforcement mode', heading: /mode/i, terms: ['Key `mode`', '`observe`', '`enforce`'] },
  { topic: 'task types', heading: /task types/i, terms: ['`task_types.enabled`', '`task_types.custom`'] },
  { topic: 'deploy targets', heading: /targets/i, terms: ['Key `targets`', '`deploy.via`', '`environment`'] },
  { topic: 'quality gate', heading: /quality gate/i, terms: ['Key `quality_gate`'] },
  { topic: 'merge policy', heading: /merge policy/i, terms: ['Key `merge_policy`', '`owner_only`', '`agent_on_request`'] },
  { topic: 'MCP servers and scope', heading: /mcp servers/i, terms: ['`mcp.servers`', '`mcp.scope`', '`mcp.github_transport`', 'there is one `mcp.scope` for all of them'] },
  { topic: 'secrets storage', heading: /secrets/i, terms: ['`secrets.local_store`', '`secrets.production_store`'] },
  { topic: 'models', heading: /models/i, terms: ['Key `models.<harness>`', '`{ deep, standard, fast }`'] },
  { topic: 'stack', heading: /stack/i, terms: ['`stack.superpowers`', '`stack.graphify`', '`stack.branch_protection`', '`stack.actions`'] },
  { topic: 'owners and agents', heading: /owners/i, terms: ['`owners`:', '`agents`:'] },
  { topic: 'content language', heading: /language/i, terms: ['Key `content_language`'] },
];

/** What INSTALL.md has to say, so that an edit cannot silently drop it. Phrases, not single words. */
const REQUIRED_TOPICS: Array<{ about: string; terms: string[] }> = [
  { about: 'the preflight', terms: ['doctor --preflight', 'token scopes `repo` and `project`', 'gh auth refresh -s repo -s project -s workflow'] },
  { about: 'the install PR', terms: ['chore: install agentic-sdlc-kit', 'task/<n>-install-agentic-sdlc-kit', 'task new --type tooling', 'Related to #<n>', 'sdlc review handoff <n> --pr'] },
  { about: 'the owner-only steps', terms: ['gh secret set SDLC_TOKEN', 'export `GITHUB_PERSONAL_ACCESS_TOKEN` from it in the shell profile', 'claude mcp list', '`CODEX_HOME`', 'trust the project in Codex'] },
  {
    about: 'the keystore commands',
    terms: [
      'security add-generic-password -a "$USER" -s github-mcp -w',
      'security find-generic-password -s github-mcp -w',
      'secret-tool store --label=github-mcp service github-mcp',
      'secret-tool lookup service github-mcp',
      'Install-Module Microsoft.PowerShell.SecretManagement',
      'Set-Secret -Name github-mcp -Vault CredMan',
      'Get-Secret -Name github-mcp -Vault CredMan -AsPlainText',
      "op read 'op://<vault>/<item>/<field>'",
    ],
  },
  { about: 'the local_store values', terms: ['`auto` on macOS', '`keychain` (macOS Keychain', '`secret-service` (Linux', '`wincred` (Windows Credential Manager'] },
  { about: 'creating the GitHub token', terms: ['https://github.com/settings/personal-access-tokens', 'https://github.com/settings/tokens', 'the scopes `repo` and `project`', 'never pasted into the chat'] },
  {
    about: 'the secret guard',
    terms: [
      'sdlc:allow-secret',
      'It skips the whole line',
      'Quote every fingerprint',
      '`git commit --no-verify` skips the local hooks',
      'GitHub secret scanning push protection',
      'A repository that uses rulesets',
      'A file marked `binary` or `-diff`',
      '`google-services.json` and `GoogleService-Info.plist` are not blocked by name',
      '(starting `AIza`)',
      'It fails closed.',
    ],
  },
  { about: 'the git hooks needing sdlc', terms: ['`core.hooksPath` to `.sdlc/githooks`', 'npx --no-install sdlc', 'the secret guard is NOT active', 'move the dev dependency to the same version'] },
  {
    about: 'every clone setting the hooks path',
    terms: [
      '**Every clone.**',
      '`core.hooksPath` is local git config',
      'git config core.hooksPath || git config core.hooksPath .sdlc/githooks',
      'every cloud agent sandbox',
      "the repository's package manager install",
      '(husky or another hook manager), do not change it',
      '"prepare": "git config core.hooksPath || git config core.hooksPath .sdlc/githooks || exit 0"',
    ],
  },
  { about: 'the hooks the repository already has', terms: ['each kit hook runs the one of the same name after its own step', '`git.legacyHooks`'] },
  { about: 'kit_ref existing', terms: ['until that release tag exists, set it to `main` or the ref you installed from', '`kit.ref`'] },
  {
    about: 'pnpm and the build of a git dependency',
    terms: ['pnpm 10.26 to 10.x', 'onlyBuiltDependencies', 'pnpm 11 and newer', '`allowBuilds:` map', 'A bare package name never approves a git dependency', 'pnpm approve-builds', 'The simple path is npm'],
  },
  { about: 'the fine-grained token for an organization board', terms: ['add the organization permission Projects', 'they use a classic token'] },
  { about: 'the cost of the hourly workflow', terms: ['**Actions minutes.**', 'On a private repository each run counts'] },
  { about: 'doctor under npx -y', terms: ['missing packages', 'Step 4 was skipped', 'it ignores the temporary package npx put on its own PATH'] },
  { about: 'how sdlc is run after the install', terms: ['plain `sdlc` works only after a global install', 'A global install protects only that machine'] },
  { about: 'the dev dependency', terms: ['the PR body of Step 5 must list it', 'pnpm add -D', 'yarn add -D', 'the repository\'s own package manager'] },
  { about: 'the stack installs', terms: ['/plugin install superpowers@claude-plugins-official', 'gemini extensions install https://github.com/obra/superpowers', 'uv tool install graphifyy'] },
  { about: 'owner, agents and tokens', terms: ['## Owner, agents and tokens', 'Agents should write under a separate account', "authored by the agent's own login", 'Use a token with the scopes `repo` and `project`'] },
  { about: 'custom agent roles', terms: ['.sdlc/agents/custom', 'To write a literal `{{`, put a backslash before it (`\\{{`)'] },
];

describe('INSTALL.md', () => {
  it('exists', () => {
    expect(existsSync(join(root, 'INSTALL.md'))).toBe(true);
    expect(install.length).toBeGreaterThan(1000);
  });

  it('is linked from the README and has a title', () => {
    expect(readme).toContain('(INSTALL.md)');
    expect(install).toMatch(/^# /m);
  });

  it('starts with the preflight, as the design says, run through npx', () => {
    expect(install).toContain('npx -y github:SobSoft-s-r-o/agentic-sdlc-kit#<ref> doctor --preflight');
  });

  it.each(QUESTION_TOPICS)('asks the $topic question', ({ heading, terms }) => {
    const headings = install.split('\n').filter(line => /^#{3,4} /.test(line));
    expect(headings.some(line => heading.test(line)), `a heading for ${heading}`).toBe(true);
    for (const term of terms) expect(install, term).toContain(term);
  });

  it('asks the questions in the order of the design', () => {
    const headings = install.split('\n').filter(line => /^#{3,4} \d+\./.test(line));
    const positions = QUESTION_TOPICS.map(({ heading }) => headings.findIndex(line => heading.test(line)));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('reads a Windows secret with the same command as the instruction block', () => {
    const block = readFileSync(join(root, 'templates/instructions/block.md'), 'utf8');
    const read = /Get-Secret -Name (\S+) -Vault CredMan -AsPlainText/;
    expect(install).toMatch(read);
    expect(block).toMatch(read);
    const generic = (text: string) => (read.exec(text)?.[0] ?? '').replace(read, 'Get-Secret -Name <name> -Vault CredMan -AsPlainText');
    expect(generic(block)).toBe(generic(install));
    for (const text of [install, block]) expect(text).not.toContain('Get-StoredCredential');
  });

  it.each(REQUIRED_TOPICS)('covers $about', ({ terms }) => {
    for (const term of terms) expect(install, term).toContain(term);
  });

  it('mentions only commands, subcommands and options that sdlc has', () => {
    const words = mentioned(install);
    for (const word of ['doctor', 'config suggest', 'config validate', 'init', 'upgrade', 'uninstall', 'task new', 'review handoff']) {
      expect(words.has(word), `INSTALL.md mentions sdlc ${word}`).toBe(true);
    }
    expect(unknownMentions(install)).toEqual([]);
  });

  it('has an example config that loads', () => {
    const examples = [...install.matchAll(/^```ya?ml\n([\s\S]*?)^```[ \t]*$/gm)].map(match => match[1] ?? '').filter(text => /^version: 1$/m.test(text));
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) expect(() => loadConfigFromString(example)).not.toThrow();
  });

  it('has a secrets.allow example that loads, with the all-digit fingerprint kept as text', () => {
    const fragments = [...install.matchAll(/^```ya?ml\n([\s\S]*?)^```[ \t]*$/gm)].map(match => match[1] ?? '').filter(text => !/^version:/m.test(text) && /^secrets:/m.test(text));
    expect(fragments).toHaveLength(1);
    const minimal = [
      'version: 1',
      'harnesses: [claude]',
      'mode: observe',
      'github: { repo: owner/name, default_branch: main, project: { owner: owner, owner_type: org } }',
      'owners: [owner-login]',
      'task_types: { enabled: [tooling] }',
    ].join('\n');
    const cfg = loadConfigFromString(`${minimal}\n${fragments[0]}`);
    expect(cfg.secrets.allow).toEqual(['3f9a1c0b7d2e4a58', '1234567890123456']);
  });
});

describe.each([
  ['README.md', readme],
  ['INSTALL.md', install],
])('%s', (_name, text) => {
  it('has no email address', () => {
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  });

  it('runs sdlc in copyable blocks as npx, never as a bare command that a project install does not put on the PATH', () => {
    const blocks = [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm)].flatMap(match => (match[1] ?? '').split('\n'));
    expect(blocks.filter(line => /^\s*sdlc\s/.test(line))).toEqual([]);
  });
});
