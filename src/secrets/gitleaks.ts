import { execFile, type ExecFileException } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** What running a program gave: its exit code and what it wrote. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `command`; it rejects only when the program cannot run at all (not found, not allowed, too slow). */
export type Exec = (command: string, args: string[]) => Promise<ExecResult>;

/** The path of `command` on the PATH, or `undefined` when it is not there. */
export type Which = (command: string) => string | undefined | Promise<string | undefined>;

export interface GitleaksResult {
  /** gitleaks found secrets (exit code 1). */
  blocked: boolean;
  /** Its output, without blank lines, when it blocked. */
  output: string[];
  /** Why gitleaks could not be used, when it could not; the built-in guard then decides alone. */
  warning?: string;
}

export const GITLEAKS_ARGS = ['git', '--pre-commit', '--staged', '--redact', '--no-banner'];

const firstLine = (text: string): string => text.split('\n')[0]?.trim() ?? '';
const reasonOf = (error: unknown): string => firstLine(error instanceof Error ? error.message : String(error));

/**
 * Runs gitleaks on the staged changes when it is on the PATH (the built-in guard runs anyway; either
 * finding blocks). Exit code 1 means it found secrets; any other failure is a warning and leaves the
 * decision to the built-in guard. `--redact` keeps secrets out of its output.
 */
export async function runGitleaks(exec: Exec, which: Which): Promise<GitleaksResult> {
  try {
    if ((await which('gitleaks')) === undefined) return { blocked: false, output: [] };
    const result = await exec('gitleaks', GITLEAKS_ARGS);
    if (result.code === 0) return { blocked: false, output: [] };
    if (result.code === 1) {
      const output = `${result.stdout}\n${result.stderr}`
        .split('\n')
        .map(line => line.trimEnd())
        .filter(line => line.trim() !== '');
      return { blocked: true, output };
    }
    return { blocked: false, output: [], warning: `gitleaks failed (${result.code}); built-in guard only` };
  } catch (error) {
    return { blocked: false, output: [], warning: `gitleaks failed (${reasonOf(error)}); built-in guard only` };
  }
}

// -- real I/O ------------------------------------------------------------------------------------------

const MAX_BUFFER = 16 * 1024 * 1024;

/** The real thing: runs programs in `cwd`, giving up after `timeoutMs`. */
export function execProgram(cwd: string, timeoutMs = 120_000): Exec {
  return (command, args) =>
    new Promise((resolve, reject) => {
      execFile(command, args, { cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8', timeout: timeoutMs }, (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const failure = error as ExecFileException;
        if (typeof failure.code === 'number') resolve({ code: failure.code, stdout, stderr });
        else if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new Error(`${command} wrote too much output`));
        else if (failure.killed) reject(new Error(`${command} timed out after ${timeoutMs / 1000}s`));
        else reject(new Error(`could not run ${command}: ${failure.message}`));
      });
    });
}

/** Looks `command` up on the PATH of `env` (with the extensions of PATHEXT on Windows). */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const extensions = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here; try the next one.
      }
    }
  }
  return undefined;
}
