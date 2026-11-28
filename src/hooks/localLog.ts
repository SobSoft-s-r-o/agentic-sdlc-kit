import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Gap } from '../core/types.js';

/**
 * The hook's local files, under `<repository root>/.sdlc/cache/` (git-ignored). A hook writes
 * here instead of to GitHub on every tool call; `sdlc sync` flushes the gaps later.
 */
export const CACHE_DIR = '.sdlc/cache';
/** One `LoggedGap` per line. */
export const GAPS_FILE = 'gaps.jsonl';
/** One prompt record per line (a hash, never the prompt text). */
export const PROMPTS_FILE = 'prompts.jsonl';
/** The task states the edit rule has read lately, keyed by issue. */
export const TASK_CACHE_FILE = 'hook-tasks.json';
/** One queued command line (`{argv}`) per line; `sdlc sync` re-runs them when GitHub is reachable again. */
export const OUTBOX_FILE = 'outbox.jsonl';
/** Where the background `sdlc sync` started by the session-start hook writes its output. */
export const SYNC_LOG_FILE = 'sync.log';

/** A gap as the hook logs it: the issue is the task the violation was found for, when there is one. */
export interface LoggedGap extends Gap {
  issue?: number;
}

/**
 * Whether `value` is a gap as the hook logs it. Only such a line is counted and flushed: the gaps go
 * into the state comment, and one with a missing field there would make the task unreadable.
 */
export function isLoggedGap(value: unknown): value is LoggedGap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const gap = value as Record<string, unknown>;
  return (
    typeof gap.at === 'string' &&
    typeof gap.rule === 'string' &&
    typeof gap.text === 'string' &&
    typeof gap.harness === 'string' &&
    typeof gap.blocked === 'boolean' &&
    (gap.issue === undefined || (Number.isSafeInteger(gap.issue) && (gap.issue as number) > 0))
  );
}

/** A prompt as the hook records it: when, where from, and a hash. The text of a prompt is never kept. */
export interface LoggedPrompt {
  at: string;
  harness: string;
  sessionId?: string;
  promptId?: string;
  /** The task of the checked-out branch, when there is one. */
  issue?: number;
  /** The full hex SHA-256 of the prompt text. */
  sha256: string;
}

/** The path of `file` in the cache directory of the repository at `root`. */
export const cachePath = (root: string, file: string): string => join(root, ...CACHE_DIR.split('/'), file);

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** Appends `value` as one JSON line, creating the cache directory and the file when needed. */
export async function appendJsonLine(root: string, file: string, value: unknown): Promise<void> {
  const path = cachePath(root, file);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`);
}

/** The lines of a JSON-lines file, oldest first. A missing file is empty; a line that is not JSON is skipped. */
export async function readJsonLines<T>(root: string, file: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(cachePath(root, file), 'utf8');
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const values: T[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      values.push(JSON.parse(line) as T);
    } catch {
      // A line cut short by a crash, or edited by hand: the rest of the file is still good.
    }
  }
  return values;
}

/** A JSON file of the cache; `undefined` when it is missing or not JSON. */
export async function readJsonFile<T>(root: string, file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(cachePath(root, file), 'utf8')) as T;
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** Replaces a JSON file of the cache; written aside and renamed, so a reader never sees half of it. */
export async function writeJsonFile(root: string, file: string, value: unknown): Promise<void> {
  const path = cachePath(root, file);
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value)}\n`);
  await rename(temporary, path);
}
