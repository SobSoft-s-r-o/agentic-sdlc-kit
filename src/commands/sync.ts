import { execFile, type ExecFileException } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { StateCommentError } from '../core/stateComment.js';
import { TransitionError } from '../core/stateMachine.js';
import { ConfigError } from '../core/taskTypes.js';
import type { Gap } from '../core/types.js';
import { appendJsonLine, cachePath, GAPS_FILE, isLoggedGap, type LoggedGap } from '../hooks/localLog.js';
import {
  appendRawLines,
  errorChain,
  EXIT_TEMPFAIL,
  GAPS_SYNCING_FILE,
  isOutboxEntry,
  isQueueableArgv,
  isTransportError,
  NO_QUEUE_ENV,
  OUTBOX_FAILED_FILE,
  OUTBOX_FILE,
  readOutbox,
  readRawLines,
  removeLines,
  SYNC_LOCK,
  type OutboxEntry,
} from '../outbox/outbox.js';
import { StateChangedError } from '../tracker/types.js';
import { commit, type CommandContext } from './context.js';
import { errorAsJson, formatCliError } from './errors.js';
import { isNoTaskError } from './githook.js';

/**
 * `sdlc sync`: replays the commands the outbox holds (task commands that could not reach GitHub)
 * and records the gaps the harness hooks logged locally into the state comments of their tasks.
 * The session-start hook starts it in the background when something is queued.
 */

/** Everything `sdlc sync` touches outside its own process; the real one is built in `cli.ts`. */
export interface SyncContext {
  /** The root of the MAIN checkout: the queue, the failed file, the gaps and the lock are in its `.sdlc/cache/`. */
  repoRoot: string;
  /**
   * Runs `sdlc <argv>` as a separate process with `SDLC_NO_QUEUE=1`, so it never queues itself again;
   * `code` is its exit code (`EXIT_TEMPFAIL` when GitHub is still unreachable). Rejects when it cannot be run.
   */
  replay(argv: string[]): Promise<{ code: number; stderr: string }>;
  /** The context to record gaps with; asked for only when a gap names a task, so sync needs no config before that. */
  makeCommandContext(): Promise<CommandContext>;
  now(): string;
  out(text: string): void;
  err(text: string): void;
}

export type SyncContextFactory = () => SyncContext | Promise<SyncContext>;

export interface SyncResult {
  /** Queued commands that ran and are gone from the outbox. */
  replayed: number;
  /** Queued commands that failed for good, now in `outbox-failed.jsonl`; `argv` is empty for a line that was no command. */
  failed: { argv: string[]; error: string }[];
  /** Queued commands still in the outbox afterwards. */
  remaining: number;
  /** Gap lines recorded into the state comment of their task. */
  gapsFlushed: number;
  /** Gap lines thrown away: they name no task, or a task that cannot hold them. */
  gapsDropped: number;
  /** Why the sync stopped before it was through: another sync is running, or GitHub is unreachable. */
  stopped?: 'already_running' | 'unreachable';
  /** A dry run only: what a real sync would do. */
  plan?: { replay: string[][]; gaps: { issue: number; count: number }[]; dropped: number };
}

/** A lock younger than this is a running sync; an older one is left by a sync that died. */
export const LOCK_STALE_MS = 10 * 60_000;
/** Longest one replayed command may take; one that takes longer is killed and counts as GitHub being unreachable. */
export const REPLAY_TIMEOUT_MS = 120_000;
const MALFORMED_LINE = 'malformed outbox line';
const NOT_QUEUEABLE = 'not a queueable command';
const MAX_REPLAY_OUTPUT = 16 * 1024 * 1024;

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The last non-blank line of `text`; the failure of a command is the last thing it said. */
const lastLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
    .at(-1) ?? '';

const lockPathOf = (ctx: SyncContext): string => join(ctx.repoRoot, ...SYNC_LOCK.split('/'));

const lockContent = (ctx: SyncContext, token: string): string =>
  JSON.stringify({ pid: process.pid, at: ctx.now(), token });

/** The lock as written; `undefined` when it is gone or cannot be read as one. */
async function readLock(path: string): Promise<{ at?: string; token?: string } | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return typeof value === 'object' && value !== null ? (value as { at?: string; token?: string }) : undefined;
  } catch {
    return undefined;
  }
}

/** When the lock was last written: the time it says, else the time of its file; `undefined` when it is gone. */
async function lockTime(path: string): Promise<number | undefined> {
  const written = Date.parse((await readLock(path))?.at ?? '');
  if (!Number.isNaN(written)) return written;
  // A lock that is still being written, or one nobody can read: judge it by its file.
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Takes the lock and returns the token that proves it is ours: the file is created with `wx`, so only
 * one sync gets it, and read back to confirm the token (a sync that took over the same stale lock
 * meanwhile would have replaced it). A lock older than `LOCK_STALE_MS` is taken over. `undefined`
 * when another sync holds it.
 */
async function acquireLock(ctx: SyncContext): Promise<string | undefined> {
  const path = lockPathOf(ctx);
  await mkdir(dirname(path), { recursive: true });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx');
      try {
        await handle.writeFile(lockContent(ctx, token));
      } finally {
        await handle.close();
      }
      return (await readLock(path))?.token === token ? token : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const written = await lockTime(path);
    if (written !== undefined && Date.parse(ctx.now()) - written <= LOCK_STALE_MS) return undefined;
    await unlink(path).catch(() => undefined);
  }
  return undefined;
}

/** Writes the time into the lock again, so a long sync is not mistaken for a dead one; a lock that is no longer ours is left alone. */
async function refreshLock(ctx: SyncContext, token: string): Promise<void> {
  const path = lockPathOf(ctx);
  if ((await readLock(path))?.token !== token) return;
  await writeFile(path, lockContent(ctx, token)).catch(() => undefined);
}

/** Gives the lock back, unless another sync has taken it over since. */
async function releaseLock(ctx: SyncContext, token: string): Promise<void> {
  const path = lockPathOf(ctx);
  if ((await readLock(path))?.token === token) await unlink(path).catch(() => undefined);
}

const parseLine = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

/** A gap line grouped by the task it names; the lines it came from go with it so they can be taken out. */
interface TaskGaps {
  lines: string[];
  gaps: Gap[];
}

/** The gap `lines` by task, and what cannot be recorded: `dropped` lines name no task, `unreadable` ones are no gap. */
function groupGapLines(lines: readonly string[]): {
  byIssue: Map<number, TaskGaps>;
  dropped: string[];
  unreadable: string[];
} {
  const byIssue = new Map<number, TaskGaps>();
  const dropped: string[] = [];
  const unreadable: string[] = [];
  for (const line of lines) {
    const value = parseLine(line);
    if (!isLoggedGap(value)) {
      unreadable.push(line);
      continue;
    }
    const { issue, at, rule, text, harness, blocked }: LoggedGap = value;
    if (issue === undefined) {
      dropped.push(line);
      continue;
    }
    const group = byIssue.get(issue) ?? { lines: [], gaps: [] };
    group.lines.push(line);
    // Only the fields of a gap go into the state comment, whatever else the line carries.
    group.gaps.push({ at, rule, text, harness, blocked });
    byIssue.set(issue, group);
  }
  return { byIssue, dropped, unreadable };
}

/** Records `gaps` on the task; a state that changed meanwhile is read again and tried once more. */
async function recordGaps(ctx: CommandContext, issue: number, gaps: Gap[]): Promise<void> {
  try {
    await commit(ctx, issue, { kind: 'gap_recorded', gaps });
  } catch (error) {
    if (![...errorChain(error)].some(link => link instanceof StateChangedError)) throw error;
    await commit(ctx, issue, { kind: 'gap_recorded', gaps });
  }
}

/** The task cannot take a gap, now or later: it is not tracked, its type is gone, or the state refuses the event. */
const cannotTakeGaps = (error: unknown): boolean =>
  [...errorChain(error)].some(
    link =>
      isNoTaskError(link) || link instanceof StateCommentError || link instanceof ConfigError || link instanceof TransitionError,
  );

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const syncingExists = (root: string): Promise<boolean> =>
  stat(cachePath(root, GAPS_SYNCING_FILE)).then(
    () => true,
    () => false,
  );

/**
 * Takes the gap lines the hooks logged: `gaps.jsonl` is renamed to `gaps.jsonl.syncing`, which is
 * atomic, and the hooks, which open the file afresh for every line, start a new `gaps.jsonl`.
 * False when there was nothing to take.
 */
async function takeGaps(root: string): Promise<boolean> {
  try {
    await rename(cachePath(root, GAPS_FILE), cachePath(root, GAPS_SYNCING_FILE));
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/**
 * Records the gaps of `gaps.jsonl.syncing` into the state comments, one `gap_recorded` per task (the
 * state keeps the newest `MAX_GAPS`). A line that names no task, or is no gap, is thrown away (and
 * counted as dropped); so are the gaps of a task that cannot hold them. What could not be recorded
 * now (GitHub unreachable, a state that keeps changing) goes back to `gaps.jsonl` for the next sync,
 * and the `.syncing` file is deleted. Only sync (under its lock) writes the `.syncing` file, so
 * lines are taken out of it one task at a time with `removeLines`. Returns how many lines went back.
 */
async function flushTaken(
  ctx: SyncContext,
  result: SyncResult,
  commandContext: () => Promise<CommandContext>,
): Promise<number> {
  const root = ctx.repoRoot;
  const { byIssue, dropped, unreadable } = groupGapLines(await readRawLines(root, GAPS_SYNCING_FILE));
  result.gapsDropped += dropped.length + unreadable.length;
  if (dropped.length + unreadable.length > 0) await removeLines(root, GAPS_SYNCING_FILE, [...dropped, ...unreadable]);

  if (byIssue.size > 0) {
    let recordWith: CommandContext | undefined;
    try {
      recordWith = await commandContext();
    } catch (error) {
      ctx.err(`could not record the gaps: ${reasonOf(error)}`);
    }

    for (const issue of recordWith === undefined ? [] : [...byIssue.keys()].sort((a, b) => a - b)) {
      const group = byIssue.get(issue) as TaskGaps;
      try {
        await recordGaps(recordWith as CommandContext, issue, group.gaps);
        result.gapsFlushed += group.gaps.length;
        await removeLines(root, GAPS_SYNCING_FILE, group.lines);
      } catch (error) {
        if (isTransportError(error)) {
          result.stopped = 'unreachable';
          ctx.err(`GitHub is unreachable: the gaps of #${issue} and later tasks stay queued`);
          break;
        }
        if (cannotTakeGaps(error)) {
          result.gapsDropped += group.gaps.length;
          await removeLines(root, GAPS_SYNCING_FILE, group.lines);
          ctx.err(`dropped ${group.gaps.length} gap(s) of #${issue}: ${reasonOf(error)}`);
        } else {
          ctx.err(`could not record the gaps of #${issue}, kept for the next sync: ${reasonOf(error)}`);
        }
      }
    }
  }

  // Back first, deleted after: a sync that dies in between leaves duplicates (which merge), not a loss.
  const rest = await readRawLines(root, GAPS_SYNCING_FILE);
  await appendRawLines(root, GAPS_FILE, rest);
  await unlink(cachePath(root, GAPS_SYNCING_FILE)).catch(() => undefined);
  return rest.length;
}

/**
 * Records the logged gaps. A `.syncing` file left by a sync that died is processed first; then (when
 * that went through) what the hooks logged since is taken and processed.
 */
async function flushGaps(ctx: SyncContext, result: SyncResult): Promise<void> {
  // The config is loaded once, and only when a gap names a task.
  let made: Promise<CommandContext> | undefined;
  const commandContext = (): Promise<CommandContext> => (made ??= ctx.makeCommandContext());

  if (await syncingExists(ctx.repoRoot)) {
    const kept = await flushTaken(ctx, result, commandContext);
    if (kept > 0 || result.stopped !== undefined) return;
  }
  if (await takeGaps(ctx.repoRoot)) await flushTaken(ctx, result, commandContext);
}

/** Replays the outbox in order; a command that failed for good moves to the failed file, one that met an unreachable GitHub ends the replay. */
async function replayOutbox(ctx: SyncContext, result: SyncResult, token: string): Promise<void> {
  for (const line of await readRawLines(ctx.repoRoot, OUTBOX_FILE)) {
    const value = parseLine(line);
    if (!isOutboxEntry(value)) {
      await appendJsonLine(ctx.repoRoot, OUTBOX_FAILED_FILE, { failedAt: ctx.now(), error: MALFORMED_LINE, line });
      await removeLines(ctx.repoRoot, OUTBOX_FILE, [line]);
      result.failed.push({ argv: [], error: MALFORMED_LINE });
      continue;
    }

    const entry: OutboxEntry = value;
    // The outbox is a file anyone can write: only the queueable commands, without options that change what they do, are ever run.
    if (!isQueueableArgv(entry.argv)) {
      await appendJsonLine(ctx.repoRoot, OUTBOX_FAILED_FILE, { ...entry, failedAt: ctx.now(), error: NOT_QUEUEABLE });
      await removeLines(ctx.repoRoot, OUTBOX_FILE, [line]);
      result.failed.push({ argv: entry.argv, error: NOT_QUEUEABLE });
      continue;
    }
    const { code, stderr } = await ctx.replay(entry.argv);
    if (code === EXIT_TEMPFAIL) {
      result.stopped = 'unreachable';
      return;
    }
    if (code === 0) {
      result.replayed += 1;
    } else {
      const error = lastLine(stderr) || `exit code ${code}`;
      await appendJsonLine(ctx.repoRoot, OUTBOX_FAILED_FILE, { ...entry, failedAt: ctx.now(), error });
      result.failed.push({ argv: entry.argv, error });
    }
    await removeLines(ctx.repoRoot, OUTBOX_FILE, [line]);
    await refreshLock(ctx, token);
  }
}

/** What a real sync would do, changing nothing (no lock either). */
async function planSync(ctx: SyncContext): Promise<SyncResult> {
  const entries = await readOutbox(ctx.repoRoot);
  const { byIssue, dropped, unreadable } = groupGapLines([
    ...(await readRawLines(ctx.repoRoot, GAPS_SYNCING_FILE)),
    ...(await readRawLines(ctx.repoRoot, GAPS_FILE)),
  ]);
  return {
    replayed: 0,
    failed: [],
    remaining: entries.length,
    gapsFlushed: 0,
    gapsDropped: 0,
    plan: {
      replay: entries.map(entry => entry.argv),
      gaps: [...byIssue.entries()].sort(([a], [b]) => a - b).map(([issue, group]) => ({ issue, count: group.gaps.length })),
      dropped: dropped.length + unreadable.length,
    },
  };
}

/**
 * Replays the queued commands, then records the logged gaps. Only one sync runs at a time (a lock
 * file in the cache, owned by a token); with `dryRun` nothing is changed, not even the lock. When
 * GitHub turns out to be unreachable (a replay exits `EXIT_TEMPFAIL`) the rest of the queue and the
 * gaps stay for the next sync. Each replayed command leaves the outbox as soon as it ran, so a sync
 * that is killed repeats at most the one command that was running.
 */
export async function syncAll(ctx: SyncContext, opts: { dryRun?: boolean } = {}): Promise<SyncResult> {
  if (opts.dryRun === true) return planSync(ctx);

  const token = await acquireLock(ctx);
  if (token === undefined) {
    return {
      replayed: 0,
      failed: [],
      remaining: (await readOutbox(ctx.repoRoot)).length,
      gapsFlushed: 0,
      gapsDropped: 0,
      stopped: 'already_running',
    };
  }
  try {
    const result: SyncResult = { replayed: 0, failed: [], remaining: 0, gapsFlushed: 0, gapsDropped: 0 };
    await replayOutbox(ctx, result, token);
    if (result.stopped === undefined) await flushGaps(ctx, result);
    result.remaining = (await readOutbox(ctx.repoRoot)).length;
    return result;
  } finally {
    await releaseLock(ctx, token);
  }
}

/**
 * The replay of the real `sdlc sync`: the program at `entry` run by this Node, in `cwd`, with queueing turned off.
 * `cwd` is the main checkout, where the outbox is: a command queued from a task worktree replays from
 * there, with the main checkout's config (its mode and owners), not the worktree's.
 */
export function spawnReplay(entry: string, cwd: string, timeoutMs = REPLAY_TIMEOUT_MS): SyncContext['replay'] {
  return argv =>
    new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [entry, ...argv],
        {
          cwd,
          env: { ...process.env, [NO_QUEUE_ENV]: '1' },
          timeout: timeoutMs,
          maxBuffer: MAX_REPLAY_OUTPUT,
          encoding: 'utf8',
        },
        (error, _stdout, stderr) => {
          if (!error) {
            resolve({ code: 0, stderr });
            return;
          }
          const failure = error as ExecFileException;
          if (typeof failure.code === 'number') {
            resolve({ code: failure.code, stderr });
          } else if (failure.killed || failure.signal) {
            // Out of time: GitHub did not answer, as far as the replay can tell.
            resolve({ code: EXIT_TEMPFAIL, stderr: stderr || `terminated by ${failure.signal ?? 'a signal'}` });
          } else {
            reject(new Error(`could not run sdlc ${argv.join(' ')}: ${failure.message}`));
          }
        },
      );
      child.stdin?.on('error', () => undefined);
      child.stdin?.end();
    });
}

const command = (argv: string[]): string => `sdlc ${argv.join(' ')}`;

/** The plain-text answer of `sdlc sync`. */
export function describeSync(result: SyncResult): string {
  if (result.stopped === 'already_running') return 'sync already running';

  const { plan } = result;
  if (plan !== undefined) {
    const lines: string[] = [];
    if (plan.replay.length > 0) lines.push(`Would replay ${plan.replay.length} queued command(s):`, ...plan.replay.map(argv => `  ${command(argv)}`));
    for (const { issue, count } of plan.gaps) lines.push(`Would record ${count} gap(s) on #${issue}`);
    if (plan.dropped > 0) lines.push(`Would drop ${plan.dropped} gap line(s) that name no task or are unreadable`);
    return lines.length > 0 ? lines.join('\n') : 'Nothing to sync.';
  }

  const lines: string[] = [];
  if (result.replayed > 0) lines.push(`Replayed ${result.replayed} queued command(s).`);
  for (const { argv, error } of result.failed) {
    const what = argv.length > 0 ? command(argv) : MALFORMED_LINE;
    lines.push(`Failed: ${what}: ${error} (moved to .sdlc/cache/${OUTBOX_FAILED_FILE})`);
  }
  if (result.gapsFlushed > 0) lines.push(`Recorded ${result.gapsFlushed} gap(s) on their tasks.`);
  if (result.gapsDropped > 0) lines.push(`Dropped ${result.gapsDropped} gap(s) that could not be recorded.`);
  if (result.stopped === 'unreachable') lines.push('GitHub is unreachable; what is left stays queued for the next sync.');
  if (result.remaining > 0) lines.push(`${result.remaining} queued command(s) remain.`);
  return lines.length > 0 ? lines.join('\n') : 'Nothing to sync.';
}

/** The exit code of a finished sync: 1 when a command failed for good, 75 when GitHub was unreachable, else 0. */
function exitCodeOf(result: SyncResult): number {
  if (result.failed.length > 0) return 1;
  return result.stopped === 'unreachable' ? EXIT_TEMPFAIL : 0;
}

const printLine = (stream: NodeJS.WriteStream) => (text: string) => void stream.write(`${text}\n`);

/** Registers `sdlc sync [--dry-run] [--json]`. */
export function registerSyncCommand(program: Command, makeContext: SyncContextFactory): void {
  program
    .command('sync')
    .description('Replay commands queued while GitHub was unreachable and record the gaps the hooks logged')
    .option('--dry-run', 'list what would be replayed and recorded; change nothing')
    .option('--json', 'print machine-readable JSON')
    .addHelpText(
      'after',
      [
        '',
        'Exit codes:',
        '  0   everything queued ran or nothing was queued; also when another sync is already running',
        '  1   a queued command failed for good or a queue line was malformed (moved to',
        '      .sdlc/cache/outbox-failed.jsonl), or sync itself failed',
        `  ${EXIT_TEMPFAIL}  GitHub is still unreachable; what is left stays queued for the next sync`,
      ].join('\n'),
    )
    .action(async (options: { dryRun?: boolean; json?: boolean }) => {
      let ctx: SyncContext | undefined;
      try {
        ctx = await makeContext();
        const result = await syncAll(ctx, { dryRun: options.dryRun === true });
        ctx.out(options.json ? JSON.stringify(result, null, 2) : describeSync(result));
        const code = exitCodeOf(result);
        if (code !== 0) process.exitCode = code;
      } catch (error) {
        process.exitCode = 1;
        if (options.json) (ctx?.out ?? printLine(process.stdout))(JSON.stringify(errorAsJson(error), null, 2));
        else (ctx?.err ?? printLine(process.stderr))(formatCliError(error));
      }
    });
}
