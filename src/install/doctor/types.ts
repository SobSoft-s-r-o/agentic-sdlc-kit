import type { HookContext } from '../../commands/hook.js';
import type { Config, Harness } from '../../config/schema.js';
import { GhError, type GhRunner } from '../../github/gh.js';
import type { HookEventName, HookHarness } from '../../hooks/types.js';
import type { Tracker } from '../../tracker/types.js';
import type { GitRunner, HookProbe } from '../provision.js';
import type { RepoFs } from '../repoFs.js';

/** The shapes the doctor checks share (`Check`, `DoctorEnv`) and the small helpers every check uses. */

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  id: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

/** All the IO of the checks, injected. */
export interface DoctorEnv {
  run: GhRunner;
  git: GitRunner;
  fs: RepoFs;
  /** Whether `cmd` is an executable on the PATH of `env` (the process's own by default). */
  which(cmd: string, env?: NodeJS.ProcessEnv): Promise<boolean>;
  /**
   * Runs a program in the repository root with its stdin closed, with `options.env` instead of the
   * process's environment and giving up after `options.timeoutMs`; a non-zero exit is returned, a
   * program that cannot run (or times out) rejects.
   */
  exec(cmd: string, args: string[], options?: ExecOptions): Promise<{ stdout: string; code: number; stderr: string }>;
  /** Looks at the repository's own hook files (`.git/hooks/<name>`); defaults to the real file system. */
  hookProbe?: HookProbe;
  /** Only the names of variables are ever reported, never their values. */
  env: NodeJS.ProcessEnv;
  /** `process.version`, e.g. `v22.3.0`. */
  nodeVersion: string;
  /** The config file: its name for messages, and its text (`undefined` when there is no such file; throws when it cannot be read). */
  config: { path: string; read(): string | undefined };
  /**
   * Runs one hook event in process, for `hooks.roundtrip`; defaults to the real `runHook`. A seam for
   * tests, which swap in a runner whose answer is wrong.
   */
  hookRunner?: (harness: HookHarness, event: HookEventName, ctx: HookContext) => Promise<unknown>;
  /** The tracker `worktrees.orphans` asks for tasks, read only; defaults to GitHub through `run`. */
  makeTracker?: (cfg: Config) => Tracker;
  /** `process.platform` (the hooks of Gemini CLI cannot run under PowerShell, which it uses on Windows). */
  platform?: NodeJS.Platform;
  /**
   * The text of a file of the user's home directory, by path relative to it (`undefined` when it
   * cannot be read); only read, for `hooks.switches`. Defaults to the real home directory.
   */
  userFile?: (path: string) => string | undefined;
}

export interface ExecOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface PreflightOptions {
  /** Whether the GitHub Actions workflow will be used (`stack.actions`); decides if a missing `workflow` scope matters. Defaults to true. */
  actions?: boolean;
}

// --- helpers --------------------------------------------------------------------------------------

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;
const MESSAGE_LIMIT = 300;

/** The text of an error as one printable line: no escape sequences or line breaks, at most 300 characters. */
export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw.replace(ANSI, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (text === '') return 'unknown error';
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT - 1)}…` : text;
}

/** A name or path for a message: every control character shown as `?`. */
export const printable = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');

export const ok = (id: string, message: string): Check => ({ id, status: 'ok', message });
export const warn = (id: string, message: string, fix?: string): Check => ({ id, status: 'warn', message, ...(fix === undefined ? {} : { fix }) });
export const fail = (id: string, message: string, fix?: string): Check => ({ id, status: 'fail', message, ...(fix === undefined ? {} : { fix }) });
export const notChecked = (id: string, why: string): Check => warn(id, `not checked: ${why}`);

/** Runs one check; whatever it throws is that check failing, in one line. */
export async function isolated(id: string, run: () => Check | Promise<Check>): Promise<Check> {
  try {
    return await run();
  } catch (error) {
    return fail(id, describeError(error));
  }
}

/** The reason a failed `gh` call gives: the first line of its stderr without the `gh: ` prefix, else the error's own text. */
export function ghReason(error: unknown): string {
  if (error instanceof GhError) {
    const first = error.stderr.trim().split('\n')[0]?.replace(/^gh:\s*/, '') ?? '';
    if (first.trim() !== '') return describeError(first);
  }
  return describeError(error);
}

/** `failed (exit N)` and, when the program said something on stderr, its first line as one printable line. Never stdout: it can hold other people's credentials. */
export function failure(code: number, stderr: string): string {
  const first = stderr.split('\n').map(line => line.trim()).find(line => line !== '');
  return first === undefined ? `failed (exit ${code})` : `failed (exit ${code}): ${describeError(first)}`;
}

export const list = (items: readonly string[], max = 8): string =>
  items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', ');

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The harnesses of `cfg` that have hooks, plugins and an `mcp list` of their own (all but `agents-md`), in configured order. */
export const cliHarnesses = (cfg: Config): HookHarness[] => cfg.harnesses.filter((harness: Harness): harness is HookHarness => harness !== 'agents-md');
