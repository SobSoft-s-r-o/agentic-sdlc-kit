import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../vitest.config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every file under `dir`, as a path relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(entry => statSync(join(dir, entry)).isFile());
}

// `tests/cli.test.ts` runs the built `dist/cli.js` and `tests/packaging.test.ts` packs `dist/`. When each
// ran its own `tsc` into `dist/` they raced: one read a file the other was rewriting. One build, made
// before any test file starts, serves both.
describe('one build for the whole run', () => {
  it('is made by a global setup that runs before any test file', () => {
    expect(config.test?.globalSetup).toEqual(['tests/support/globalBuild.ts']);
  });

  it('left dist/ as fresh as src/', () => {
    const stale = filesUnder(join(root, 'src'))
      .filter(file => file.endsWith('.ts'))
      .filter(file => {
        const built = join(root, 'dist', file.replace(/\.ts$/, '.js'));
        try {
          return statSync(built).mtimeMs < statSync(join(root, 'src', file)).mtimeMs;
        } catch {
          return true;
        }
      });
    expect(stale).toEqual([]);
  });

  it.each(['tests/cli.test.ts', 'tests/packaging.test.ts'])('%s does not build into dist/ itself', file => {
    const source = readFileSync(join(root, file), 'utf8');
    expect(source).not.toMatch(/bin['"],\s*['"]tsc|run['"],\s*['"]build|npm run build/);
  });
});
