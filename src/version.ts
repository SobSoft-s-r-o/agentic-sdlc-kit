import { readFileSync } from 'node:fs';

let cached: string | undefined;

/**
 * The version in this package's `package.json`. `src/` and `dist/` sit at the same depth under
 * the package root, so the same relative URL works under vitest and from the built CLI.
 */
export function packageVersion(): string {
  if (cached === undefined) {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    cached = manifest.version ?? '0.0.0';
  }
  return cached;
}
