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

/** The lines of the fenced code blocks of a Markdown document, then its inline `code spans`. */
function codeSnippets(markdown: string): string[] {
  const fenced: string[] = [];
  const prose = markdown.replace(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm, (_block, body: string) => {
    fenced.push(...body.split('\n'));
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
 * A command mentioned in code is `sdlc <word>` or, for the first run through npx,
 * `npx [-y] github:<owner>/agentic-sdlc-kit#<ref> <word>`. Prose is not read, so a sentence such as "sdlc not found" is not a
 * mention; a line is cut at `&&`, `||`, `;` and `|` so each command keeps only its own flags.
 */
function mentions(markdown: string): Mention[] {
  const found: Mention[] = [];
  for (const snippet of codeSnippets(markdown)) {
    for (const part of snippet.split(/\s*(?:&&|\|\||[;|])\s*/)) {
      const call = /(?:\bsdlc|\bnpx\s+(?:-y\s+)?\S*agentic-sdlc-kit#\S+)\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/.exec(part);
      if (call === null) continue;
      const flags = [...part.matchAll(/(?<![\w-])(--[a-z][a-z-]*)/g)].map(match => match[1] ?? '');
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

// --- README ---------------------------------------------------------------------------------------------

describe('README', () => {
  it('states the current status: the core CLI and the installer are available, the harness hooks are next', () => {
    const status = readme.split('\n').find(line => line.startsWith('> Status:'));
    expect(status).toBe('> Status: core CLI and installer available; harness hooks next');
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
});

// --- INSTALL.md -----------------------------------------------------------------------------------------

/** The install questions of the design's section 6, in its order: the heading each gets and the config keys it settles. */
const QUESTION_TOPICS: Array<{ topic: string; heading: RegExp; terms: string[] }> = [
  { topic: 'harnesses', heading: /harnesses/i, terms: ['harnesses', 'agents-md'] },
  { topic: 'board', heading: /board/i, terms: ['github.project', 'owner_type'] },
  { topic: 'enforcement mode', heading: /mode/i, terms: ['observe', 'enforce'] },
  { topic: 'task types', heading: /task types/i, terms: ['task_types'] },
  { topic: 'deploy targets', heading: /targets/i, terms: ['targets', 'environment', 'deploy'] },
  { topic: 'quality gate', heading: /quality gate/i, terms: ['quality_gate'] },
  { topic: 'merge policy', heading: /merge policy/i, terms: ['merge_policy', 'owner_only', 'agent_on_request'] },
  { topic: 'MCP servers and scope', heading: /mcp servers/i, terms: ['mcp.servers', 'mcp.scope'] },
  { topic: 'secrets storage', heading: /secrets/i, terms: ['secrets.local_store', 'secrets.production_store'] },
  { topic: 'models', heading: /models/i, terms: ['models', 'deep', 'standard', 'fast'] },
  { topic: 'stack', heading: /stack/i, terms: ['stack.superpowers', 'stack.graphify', 'stack.branch_protection', 'stack.actions'] },
  { topic: 'owners and agents', heading: /owners/i, terms: ['owners', 'agents'] },
  { topic: 'content language', heading: /language/i, terms: ['content_language'] },
];

/** What INSTALL.md has to say, so that an edit cannot silently drop it. */
const REQUIRED_TOPICS: Array<{ about: string; terms: string[] }> = [
  { about: 'the preflight', terms: ['doctor --preflight', 'repo', 'project', 'workflow'] },
  { about: 'the install PR', terms: ['chore: install agentic-sdlc-kit', 'task/<n>-install-agentic-sdlc-kit', 'tooling'] },
  { about: 'the owner-only steps', terms: ['gh secret set SDLC_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'claude mcp list', 'CODEX_HOME'] },
  { about: 'the keystore commands', terms: ['security add-generic-password', 'security find-generic-password', 'secret-tool store', 'secret-tool lookup', 'SecretManagement', 'op read'] },
  { about: 'the local_store values', terms: ['`auto`', '`keychain`', '`secret-service`', '`wincred`'] },
  { about: 'the secret guard', terms: ['sdlc:allow-secret', 'secrets.allow', 'fingerprint', '--no-verify', 'push protection', 'rulesets', '.gitattributes', 'google-services.json', 'fails closed'] },
  { about: 'the git hooks needing sdlc', terms: ['core.hooksPath', 'dev dependency', 'NOT active', 'same version'] },
  { about: 'owner, agents and tokens', terms: ['## Owner, agents and tokens', 'SDLC_TOKEN', 'enforce'] },
  { about: 'custom agent roles', terms: ['.sdlc/agents/custom', '\\{{'] },
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
});

describe.each([
  ['README.md', readme],
  ['INSTALL.md', install],
])('%s', (_name, text) => {
  it('has no email address', () => {
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  });
});
