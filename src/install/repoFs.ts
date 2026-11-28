import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * The only door to the repository. Rendering and planning read through it; only `apply` writes.
 * Paths are repo-relative and use `/`.
 */
export interface RepoFs {
  /** The repository root, for messages. */
  root: string;
  /** The file's text, `undefined` when there is no such file. */
  read(p: string): string | undefined;
  /** Creates parent directories as needed; `mode` is set after writing. */
  write(p: string, content: string, mode?: number): void;
  /** Removes a file or an empty directory; a path that is not there is not an error. */
  remove(p: string): void;
  /** Files and directories below `dir` (no trailing slash), at most `depth` levels deep, sorted. */
  list(dir: string, depth: number): string[];
}

const SKIPPED_WHEN_LISTING = new Set(['.git', 'node_modules']);

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/**
 * A `RepoFs` over a real directory. Every operation refuses a path that resolves outside `root`
 * (`..`, an absolute path elsewhere, or a symlink pointing out) with
 * `refusing to write outside the repository: <p>`; reads and listings use the same rule so a path
 * outside the repository is never touched in any way.
 */
export function nodeRepoFs(root: string): RepoFs {
  const absoluteRoot = resolve(root);
  const realRoot = realpathOrSelf(absoluteRoot);

  const inside = (target: string, base: string): boolean => {
    const rel = relative(base, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };

  /** The absolute path of `p`; throws when it, or the nearest existing part of it, is outside the root. */
  const locate = (p: string, followFinal = true): string => {
    const refuse = (): never => {
      throw new Error(`refusing to write outside the repository: ${p}`);
    };
    const absolute = resolve(absoluteRoot, p);
    if (!inside(absolute, absoluteRoot)) return refuse();
    // Resolve symlinks on the part that exists, so a link cannot lead out of the repository.
    let probe = followFinal ? absolute : dirname(absolute);
    for (;;) {
      const real = realpathOrUndefined(probe);
      if (real !== undefined) {
        if (!inside(real, realRoot)) refuse();
        break;
      }
      // Nothing resolves here; a dangling symlink would still be followed when writing.
      if (lstatOrUndefined(probe)?.isSymbolicLink()) refuse();
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    return absolute;
  };

  return {
    root: absoluteRoot,

    read(p) {
      const absolute = locate(p);
      try {
        return readFileSync(absolute, 'utf8');
      } catch (error) {
        if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'EISDIR') return undefined;
        throw error;
      }
    },

    write(p, content, mode) {
      const absolute = locate(p);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
      if (mode !== undefined) chmodSync(absolute, mode);
    },

    remove(p) {
      const absolute = locate(p, false);
      let isDirectory: boolean;
      try {
        isDirectory = lstatSync(absolute).isDirectory();
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      if (isDirectory) rmdirSync(absolute);
      else unlinkSync(absolute);
    },

    list(dir, depth) {
      const base = locate(dir);
      const found: string[] = [];
      const walk = (absolute: string, level: number): void => {
        let names: Array<{ name: string; directory: boolean }>;
        try {
          names = readdirSync(absolute, { withFileTypes: true }).map(e => ({ name: e.name, directory: e.isDirectory() }));
        } catch {
          return;
        }
        names.sort((a, b) => byName(a.name, b.name));
        for (const { name, directory } of names) {
          if (SKIPPED_WHEN_LISTING.has(name)) continue;
          const child = join(absolute, name);
          found.push(relative(absoluteRoot, child).split(sep).join('/'));
          if (directory && level < depth) walk(child, level + 1);
        }
      };
      walk(base, 1);
      return found;
    },
  };
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function realpathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function realpathOrSelf(path: string): string {
  return realpathOrUndefined(path) ?? path;
}
