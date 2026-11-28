import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { Change } from '../../src/render/changes.js';

/** `tests/golden/`, next to this file's directory. */
const GOLDEN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../golden');

/** The listing file in every golden directory: one `<kind> <path>[ mode=<octal>]` line per change. */
export const GOLDEN_INDEX = '_changes.txt';

function bodyOf(change: Change): string {
  switch (change.kind) {
    case 'file':
      return change.content;
    case 'md-block':
    case 'line-block':
    case 'toml-block':
      // These are bodies without a trailing newline (the merge writes the markers around them).
      return `${change.content}\n`;
    case 'json-keys':
      return `${JSON.stringify(change.entries, null, 2)}\n`;
  }
}

/**
 * The golden layout of `changes`: every change's content at its own repo-relative path, plus
 * `_changes.txt` listing each change's kind (and mode), so a block and a whole file at the same
 * place cannot be mistaken for each other. Two changes for one path cannot share a golden file.
 */
export function goldenLayout(changes: readonly Change[]): Map<string, string> {
  const files = new Map<string, string>();
  const index: string[] = [];
  for (const change of changes) {
    if (change.path === GOLDEN_INDEX) throw new Error(`a change cannot use the golden index name ${GOLDEN_INDEX}`);
    if (files.has(change.path)) {
      throw new Error(`two changes for ${change.path}: a golden directory holds one file per path`);
    }
    files.set(change.path, bodyOf(change));
    const mode = change.kind === 'file' && change.mode !== undefined ? ` mode=${change.mode.toString(8)}` : '';
    index.push(`${change.kind} ${change.path}${mode}`);
  }
  files.set(GOLDEN_INDEX, `${index.sort().join('\n')}\n`);
  return files;
}

function readTree(root: string, dir = root): Map<string, string> {
  const found = new Map<string, string>();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries.sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      for (const [file, text] of readTree(root, full)) found.set(file, text);
    } else {
      found.set(relative(root, full).split(sep).join('/'), readFileSync(full, 'utf8'));
    }
  }
  return found;
}

/**
 * Compares `changes` with the golden files in `tests/golden/<dir>/`: the same set of files with
 * the same text. With `UPDATE_GOLDEN=1` it rewrites that directory instead (and removes files
 * the changes no longer produce). Read what it writes before committing it.
 */
export function expectGolden(dir: string, changes: readonly Change[]): void {
  const root = resolve(GOLDEN_ROOT, dir);
  const inside = relative(GOLDEN_ROOT, root);
  if (inside === '' || inside.startsWith('..') || resolve(GOLDEN_ROOT, inside) !== root) {
    throw new Error(`golden directory must be inside tests/golden: ${dir}`);
  }
  const actual = goldenLayout(changes);

  if (process.env.UPDATE_GOLDEN === '1') {
    rmSync(root, { recursive: true, force: true });
    for (const [file, text] of actual) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    return;
  }

  const expected = readTree(root);
  expect([...actual.keys()].sort(), `golden files of ${dir} (rerun with UPDATE_GOLDEN=1 to rewrite them)`).toEqual(
    [...expected.keys()].sort(),
  );
  for (const [file, text] of actual) {
    expect(text, `golden ${dir}/${file} (rerun with UPDATE_GOLDEN=1 to rewrite it)`).toBe(expected.get(file));
  }
}
