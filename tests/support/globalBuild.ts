import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Builds `dist/` once, before any test file starts (vitest `globalSetup`). The tests that need the
 * built CLI (`tests/cli.test.ts`) or pack it (`tests/packaging.test.ts`) run in parallel, and two
 * `tsc` runs into the same `dist/` race: one reads a file the other is rewriting. A stale `dist/`
 * is never trusted either, so a build that fails stops the run.
 */
export default function setup(): void {
  execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', root], {
    cwd: root,
    stdio: 'pipe',
  });
}
