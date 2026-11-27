import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The package's `templates/` directory. `src/render/` and `dist/render/` sit at the same depth
 * under the package root, so the same relative URL works under vitest and from the built CLI.
 */
export function templatesDir(): string {
  return resolve(fileURLToPath(new URL('../../templates/', import.meta.url)));
}

/** The text of `templates/<relPath>`. `relPath` may not leave the templates directory. */
export function loadTemplate(relPath: string): string {
  const dir = templatesDir();
  const file = resolve(dir, relPath);
  const fromDir = relative(dir, file);
  if (fromDir === '' || fromDir === '..' || fromDir.startsWith(`..${sep}`) || isAbsolute(fromDir) || isAbsolute(relPath)) {
    throw new Error(`template path is outside the templates directory: ${relPath}`);
  }
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`template not found: ${relPath}`, { cause: error });
    }
    throw error;
  }
}
