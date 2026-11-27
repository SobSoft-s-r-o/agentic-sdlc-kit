import type { RepoFs } from '../../src/install/repoFs.js';

/** An in-memory `RepoFs`: `files` is the whole repository and `modes` records the mode of each write. */
export interface MemoryFs extends RepoFs {
  files: Map<string, string>;
  modes: Map<string, number>;
  /** Every `write` and every `remove` that deleted a file, in order, as `write <path>` / `remove <path>`. */
  log: string[];
  /** The repository as a plain object, sorted by path. */
  snapshot(): Record<string, string>;
}

const OUTSIDE = (p: string): string => `refusing to write outside the repository: ${p}`;

/** Normalises `a/./b`, rejects anything that leaves the repository. */
function normalize(p: string): string {
  if (p.startsWith('/')) throw new Error(OUTSIDE(p));
  const parts: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') throw new Error(OUTSIDE(p));
    parts.push(part);
  }
  return parts.join('/');
}

export function memoryFs(initial: Record<string, string> = {}): MemoryFs {
  const files = new Map<string, string>(Object.entries(initial).map(([path, text]) => [normalize(path), text]));
  const modes = new Map<string, number>();
  const log: string[] = [];

  return {
    root: '/memory',
    files,
    modes,
    log,
    read: p => files.get(normalize(p)),
    write(p, content, mode) {
      const path = normalize(p);
      files.set(path, content);
      if (mode === undefined) modes.delete(path);
      else modes.set(path, mode);
      log.push(`write ${path}`);
    },
    remove(p) {
      const path = normalize(p);
      modes.delete(path);
      if (files.delete(path)) log.push(`remove ${path}`);
    },
    list(dir, depth) {
      const base = normalize(dir);
      const prefix = base === '' ? '' : `${base}/`;
      const found = new Set<string>();
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const segments = file.slice(prefix.length).split('/');
        for (let i = 1; i <= Math.min(segments.length, depth); i++) {
          found.add(prefix + segments.slice(0, i).join('/'));
        }
      }
      // depth-first, siblings by name: the order `nodeRepoFs.list` returns
      const order = (path: string): string => path.split('/').join('\u0000');
      return [...found].sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
    },
    snapshot: () => Object.fromEntries([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
}
