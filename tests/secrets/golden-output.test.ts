import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatFinding, scanAddedLines, scanFileName } from '../../src/secrets/scan.js';

/** `tests/golden/`: everything the kit renders into a user's repository (instructions, agents, MCP, hooks, workflows). */
const GOLDEN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../golden');

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

describe('the secret guard on the output of the kit', () => {
  const files = filesUnder(GOLDEN_ROOT);

  it('has rendered output to scan', () => {
    // The MCP configurations are the ones that name an environment variable that holds a token.
    const paths = files.map(file => relative(GOLDEN_ROOT, file).split(sep).join('/'));
    expect(files.length).toBeGreaterThan(50);
    expect(paths).toContain('mcp/gemini-local/.gemini/settings.json');
    expect(paths).toContain('mcp/claude-local/.mcp.json');
    expect(paths).toContain('githooks/.sdlc/githooks/pre-commit');
  });

  it('reports nothing in any file the kit renders, so a user can commit it', () => {
    const findings = files.flatMap(file => {
      const path = relative(GOLDEN_ROOT, file).split(sep).join('/');
      const lines = readFileSync(file, 'utf8')
        .split('\n')
        .map((text, index) => ({ line: index + 1, text }));
      const byName = scanFileName(path);
      return [...(byName ? [byName] : []), ...scanAddedLines(path, lines, [])];
    });

    // Only masked matches are in the message, so a failure never prints a secret.
    expect(findings.map(formatFinding)).toEqual([]);
  });
});
