import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { GhError } from '../github/gh.js';
import {
  appendJsonLine,
  cachePath,
  GAPS_FILE,
  isLoggedGap,
  OUTBOX_FILE,
  readJsonLines,
} from '../hooks/localLog.js';

/**
 * The outbox: task commands that could not reach GitHub, kept as command lines (`argv`), not as
 * tracker writes. `sdlc sync` re-runs them when GitHub is reachable again, so each runs against the
 * state of that moment and a stale state is never written back. The files live in the cache of the
 * MAIN checkout (`.sdlc/cache/`), so removing a worktree never loses a queued command.
 */
export { OUTBOX_FILE };

/** Where `sdlc sync` moves a queued command that failed for good (and a line it cannot read). */
export const OUTBOX_FAILED_FILE = 'outbox-failed.jsonl';
/** The lock of a running `sdlc sync`, relative to the repository root. */
export const SYNC_LOCK = '.sdlc/cache/sync.lock';
/** `EX_TEMPFAIL`: a queueable command that failed because GitHub is unreachable and was not queued. */
export const EXIT_TEMPFAIL = 75;
/** Set to `1` to keep a command from queueing itself: `sdlc sync` replays commands with it. */
export const NO_QUEUE_ENV = 'SDLC_NO_QUEUE';

/** One queued command line, as `sdlc` was run (minus `node` and the program). */
export interface OutboxEntry {
  id: string;
  at: string;
  argv: string[];
}

const TRANSPORT_FAILURE =
  /could not resolve host|connection (refused|reset)|timed? ?out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|rate limit|HTTP (502|503|504)/i;

/** `error` and what it was caused by, outermost first (bounded, in case a cause loops). */
export function* errorChain(error: unknown): Generator<unknown> {
  let current = error;
  for (let depth = 0; depth < 6; depth += 1) {
    yield current;
    if (!(current instanceof Error) || current.cause === undefined) return;
    current = current.cause;
  }
}

/**
 * Whether `error` is a `gh` call that failed because GitHub could not be reached or answered
 * "try again later": no network, a timeout, a rate limit, a gateway error. A command that failed
 * this way may succeed later, which is what the outbox is for. The `gh` failure may sit behind the
 * error of a tracker step (`CommandError.cause`).
 */
export function isTransportError(error: unknown): boolean {
  for (const link of errorChain(error)) {
    if (link instanceof GhError && TRANSPORT_FAILURE.test(link.stderr)) return true;
  }
  return false;
}

/** Whether `value` is an outbox line `sdlc sync` can replay: an id, a time and a command line. */
export function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.at === 'string' &&
    Array.isArray(entry.argv) &&
    entry.argv.length > 0 &&
    entry.argv.every(arg => typeof arg === 'string')
  );
}

/** Queues `argv` for `sdlc sync` in the cache of the repository at `root`. */
export async function enqueue(root: string, argv: string[], at: string): Promise<OutboxEntry> {
  const entry: OutboxEntry = { id: randomUUID(), at, argv: [...argv] };
  await appendJsonLine(root, OUTBOX_FILE, entry);
  return entry;
}

/** The queued commands, oldest first. A line that is not an entry is skipped. */
export async function readOutbox(root: string): Promise<OutboxEntry[]> {
  return (await readJsonLines<unknown>(root, OUTBOX_FILE)).filter(isOutboxEntry);
}

/**
 * What waits for `sdlc sync`: queued commands and recorded gaps. Only well-formed lines count, the
 * ones sync would act on; a file that cannot be read counts as empty.
 */
export async function queuedCounts(root: string): Promise<{ outbox: number; gaps: number }> {
  const count = async (file: string, wellFormed: (value: unknown) => boolean): Promise<number> => {
    try {
      return (await readJsonLines<unknown>(root, file)).filter(wellFormed).length;
    } catch {
      return 0;
    }
  };
  return { outbox: await count(OUTBOX_FILE, isOutboxEntry), gaps: await count(GAPS_FILE, isLoggedGap) };
}

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** The non-blank lines of a cache file as written, oldest first; a missing file is empty. */
export async function readRawLines(root: string, file: string): Promise<string[]> {
  try {
    return (await readFile(cachePath(root, file), 'utf8')).split('\n').filter(line => line.trim() !== '');
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/**
 * Takes `lines` (as `readRawLines` gave them) out of a cache file: one line for each one given.
 * The file is read again first, so a line appended since is kept; it is written aside and renamed,
 * so a reader never sees half of it. A missing file stays missing; one left with no line is empty.
 */
export async function removeLines(root: string, file: string, lines: readonly string[]): Promise<void> {
  const path = cachePath(root, file);
  const owed = new Map<string, number>();
  for (const line of lines) owed.set(line, (owed.get(line) ?? 0) + 1);

  let current: string[];
  try {
    current = (await readFile(path, 'utf8')).split('\n').filter(line => line.trim() !== '');
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const kept = current.filter(line => {
    const due = owed.get(line) ?? 0;
    if (due === 0) return true;
    owed.set(line, due - 1);
    return false;
  });

  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, kept.map(line => `${line}\n`).join(''));
  await rename(temporary, path);
}
