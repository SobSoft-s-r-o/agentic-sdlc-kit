import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** `name` with its letter case changed, or `undefined` when it has no letters. */
export function recased(name: string): string | undefined {
  const other = name.toUpperCase() === name ? name.toLowerCase() : name.toUpperCase();
  return other === name ? undefined : other;
}

/**
 * Whether the filesystem of the temp directory opens a path whatever its letter case (the default
 * on macOS and Windows). A test of a mis-cased path runs only where this is true.
 */
export const CASE_INSENSITIVE_FS: boolean = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-case-'));
  try {
    const other = recased(basename(dir));
    return other !== undefined && existsSync(join(dirname(dir), other));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
