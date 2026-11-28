import type { Harness } from '../config/schema.js';
import type { HookHarness } from '../hooks/types.js';

/**
 * The commands and outputs of the stack the kit recommends next to itself: Superpowers (a plugin of
 * each harness) and graphify (one tool, registered as a skill per harness), and the `mcp list`
 * commands of the harness CLIs. The install commands are what `sdlc init` lists for the owner to run
 * (`renderAll` puts them in `userCommands`); the list commands and their parsers are what
 * `sdlc doctor` checks the result with. The formats are the ones recorded in
 * `docs/notes/harness-hooks-2026-11.md`; none of the commands is run by the kit on its own.
 */

/** The install command of Superpowers for one harness. */
export function superpowersInstall(harness: HookHarness): string {
  switch (harness) {
    case 'claude':
      return 'claude plugin install superpowers@claude-plugins-official';
    case 'codex':
      return 'codex plugin add superpowers@openai-curated';
    case 'gemini':
      return 'gemini extensions install https://github.com/obra/superpowers --consent';
  }
}

const GRAPHIFY_PLATFORM: Record<HookHarness, string[]> = {
  claude: [],
  codex: ['--platform', 'codex'],
  gemini: ['--platform', 'gemini'],
};

/**
 * Installs graphify (the PyPI package is `graphifyy`) and registers its skill for each of the
 * harnesses, once each; `agents-md` has no skill directory of its own, so it adds nothing.
 */
export function graphifyInstall(harnesses: readonly Harness[]): string[] {
  const registered = new Set<HookHarness>();
  for (const harness of harnesses) {
    if (harness !== 'agents-md') registered.add(harness);
  }
  return [
    'uv tool install graphifyy',
    ...[...registered].map(harness => ['graphify', 'install', ...GRAPHIFY_PLATFORM[harness]].join(' ')),
  ];
}

/** The arguments of the plugin list command, in the form `superpowersInstalled` reads (JSON). */
export function superpowersListArgs(harness: HookHarness): string[] {
  return harness === 'gemini' ? ['extensions', 'list', '-o', 'json'] : ['plugin', 'list', '--json'];
}

/** The arguments of the MCP list command, in the form `mcpNames` reads. Only Codex has a JSON form. */
export function mcpListArgs(harness: HookHarness): string[] {
  return harness === 'codex' ? ['mcp', 'list', '--json'] : ['mcp', 'list'];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `text` as JSON; throws a one-line error when it is not. */
function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} is not JSON`);
  }
}

function jsonArray(text: string, what: string): unknown[] {
  const value = parseJson(text, what);
  if (!Array.isArray(value)) throw new Error(`${what} is not a JSON array`);
  return value;
}

/**
 * Whether the plugin list of `harness` (the stdout of `superpowersListArgs`) holds Superpowers:
 * Claude a JSON array with an `id` that starts `superpowers@`, Codex `{installed: [{name}]}` (what
 * is merely `available` does not count), Gemini a JSON array with an extension named `superpowers`.
 * Throws when the text is not the list it expects, which is not the same as Superpowers missing.
 */
export function superpowersInstalled(harness: HookHarness, stdout: string): boolean {
  const what = `${harness} plugin list`;
  if (harness === 'codex') {
    const value = parseJson(stdout, what);
    if (!isRecord(value) || !Array.isArray(value.installed)) throw new Error(`${what} has no installed list`);
    return value.installed.some(plugin => isRecord(plugin) && plugin.name === 'superpowers');
  }
  const entries = jsonArray(stdout, what);
  return harness === 'claude'
    ? entries.some(plugin => isRecord(plugin) && typeof plugin.id === 'string' && plugin.id.startsWith('superpowers@'))
    : entries.some(plugin => isRecord(plugin) && plugin.name === 'superpowers');
}

/** `<name>: ...` per line, the name being everything before the first `: ` (Claude). */
function claudeNames(stdout: string): string[] {
  return stdout.split('\n').flatMap(line => {
    const at = line.indexOf(': ');
    return at > 0 ? [line.slice(0, at).trim()] : [];
  });
}

/** `<glyph> <name>: ...` per line, whichever glyph the status has (Gemini); the header line has none. */
function geminiNames(stdout: string): string[] {
  return stdout.split('\n').flatMap(line => {
    const name = /^\s*\S\s+([^:\s]+):/.exec(line)?.[1];
    return name === undefined ? [] : [name];
  });
}

/**
 * The names of the MCP servers `harness` lists (the stdout of `mcpListArgs`): the word before `: `
 * on each line for Claude, the `name` of each entry of the `--json` array for Codex (throws when it
 * is not one), the name after the status glyph for Gemini. A name counts only as a whole word.
 */
export function mcpNames(harness: HookHarness, stdout: string): Set<string> {
  if (harness === 'codex') {
    return new Set(
      jsonArray(stdout, 'codex mcp list').flatMap(entry =>
        isRecord(entry) && typeof entry.name === 'string' ? [entry.name] : [],
      ),
    );
  }
  return new Set(harness === 'claude' ? claudeNames(stdout) : geminiNames(stdout));
}
