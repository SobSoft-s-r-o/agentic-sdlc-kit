import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ChangeKind } from '../render/changes.js';
import { packageVersion } from '../version.js';
import type { RepoFs } from './repoFs.js';
import {
  blockBody,
  canonicalJson,
  jsonValueAt,
  parseJsonObject,
  tomlTableText,
  type BlockKind,
} from './merge.js';

export { canonicalJson };

/** The install manifest: what the kit wrote, so upgrades and uninstalls know what is theirs. */
export const MANIFEST_PATH = '.sdlc/manifest.json';

export interface ManifestEntry {
  path: string;
  kind: ChangeKind;
  /**
   * For `json-keys` the pointer joined by `/`; for `toml-block` the table name of a per-table entry.
   * A `toml-block` entry without a key describes the whole block.
   */
  key?: string;
  /** `sha256:<hex>`, see `entryDiskHash` for what is hashed. */
  hash: string;
  /**
   * `json-keys` only: the file did not exist when the kit first wrote these keys. Uninstall may then
   * prune the objects it leaves empty and delete the file once it holds nothing else; a file the user
   * created is never deleted, and their empty objects stay.
   */
  createdFile?: true;
  /**
   * `json-keys` only, in a file the user had: the objects the kit created on the way to its keys, as
   * manifest keys (`mcpServers`). Uninstall removes one of them once it is empty; an object the user
   * had is never listed and never removed. Every entry of the path carries the same list.
   */
  createdParents?: string[];
}

export interface Manifest {
  version: 1;
  /** The kit version that wrote it. */
  kit: string;
  /** Sorted by path, then key, so the file is deterministic. */
  entries: ManifestEntry[];
}

/**
 * `sha256:<hex>` of the text with CRLF turned into LF, so a checkout that converted line endings does
 * not look like a user edit. For text the kit wrote (LF) this is the plain sha256.
 */
export function hashText(text: string): string {
  return `sha256:${createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')}`;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const sortEntries = (entries: ManifestEntry[]): ManifestEntry[] =>
  [...entries].sort((a, b) => compare(a.path, b.path) || compare(a.key ?? '', b.key ?? '') || compare(a.kind, b.kind));

export function newManifest(entries: ManifestEntry[]): Manifest {
  return { version: 1, kit: packageVersion(), entries: sortEntries(entries) };
}

/** Pretty JSON, 2-space indent, trailing newline, entry fields in a fixed order. */
export function serializeManifest(manifest: Manifest): string {
  const entries = sortEntries(manifest.entries).map(e => ({
    path: e.path,
    kind: e.kind,
    ...(e.key === undefined ? {} : { key: e.key }),
    hash: e.hash,
    ...(e.createdFile === true ? { createdFile: true } : {}),
    ...(e.createdParents === undefined || e.createdParents.length === 0 ? {} : { createdParents: e.createdParents }),
  }));
  return `${JSON.stringify({ version: 1, kit: manifest.kit, entries }, null, 2)}\n`;
}

const ENTRY_KINDS = ['file', 'md-block', 'line-block', 'json-keys', 'toml-block'] as const satisfies readonly ChangeKind[];

const ManifestSchema = z.object({
  version: z.number(),
  kit: z.string(),
  entries: z.array(
    z.object({
      path: z.string().min(1),
      kind: z.enum(ENTRY_KINDS),
      key: z.string().optional(),
      hash: z.string().regex(/^sha256:/),
      createdFile: z.literal(true).optional(),
      createdParents: z.array(z.string()).optional(),
    }),
  ),
});

/** Parses and checks a manifest; the messages name the manifest so a caller can print them as they are. */
export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${MANIFEST_PATH} is not valid JSON; fix or remove it`);
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${MANIFEST_PATH} is not a valid manifest: ${issue?.path.join('.') || 'document'}: ${issue?.message}`);
  }
  if (parsed.data.version !== 1) {
    throw new Error(`${MANIFEST_PATH} has version ${parsed.data.version}, but this kit reads version 1; upgrade the kit`);
  }
  return {
    version: 1,
    kit: parsed.data.kit,
    entries: parsed.data.entries.map(e => ({
      path: e.path,
      kind: e.kind,
      ...(e.key === undefined ? {} : { key: e.key }),
      hash: e.hash,
      ...(e.createdFile === true ? { createdFile: true as const } : {}),
      ...(e.createdParents === undefined || e.createdParents.length === 0 ? {} : { createdParents: [...e.createdParents] }),
    })),
  };
}

/** The manifest on disk, `undefined` when the repository has none. Throws when it is damaged. */
export function readManifest(fs: RepoFs): Manifest | undefined {
  const text = fs.read(MANIFEST_PATH);
  return text === undefined ? undefined : parseManifest(text);
}

/**
 * Hashes what is on disk for one manifest entry, the way the entry's own hash was made:
 * - `file`: the whole file;
 * - `md-block` / `line-block` / `toml-block` without a key: the block body between the markers;
 * - `toml-block` with a key: the text of that table inside the block;
 * - `json-keys`: the canonical JSON of the value at the key.
 *
 * `undefined` means the region is not there (no file, no markers, no such table or key). Throws
 * `MergeError` when the markers are damaged or the JSON is invalid.
 */
export function entryDiskHash(entry: ManifestEntry, text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  switch (entry.kind) {
    case 'file':
      return hashText(text);
    case 'md-block':
    case 'line-block':
    case 'toml-block': {
      const body = blockBody(text, entry.kind as BlockKind);
      if (body === undefined) return undefined;
      if (entry.kind === 'toml-block' && entry.key !== undefined) {
        const table = tomlTableText(body, entry.key);
        return table === undefined ? undefined : hashText(table);
      }
      return hashText(body);
    }
    case 'json-keys': {
      const found = jsonValueAt(parseJsonObject(text, entry.path), (entry.key ?? '').split('/'));
      return found.found ? hashText(canonicalJson(found.value)) : undefined;
    }
  }
}
