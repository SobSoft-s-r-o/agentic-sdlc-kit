import { execFile, type ExecFileException } from 'node:child_process';

/** Runs `gh` with the given arguments, optionally feeding `input` to stdin. */
export type GhRunner = (
  args: string[],
  input?: string,
) => Promise<{ stdout: string; code: number; stderr: string }>;

const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_ARGS_IN_MESSAGE = 200;

/** The command line for an error message; long arguments (comment bodies, queries) are cut off. */
function describeCommand(args: string[]): string {
  const line = `gh ${args.join(' ')}`;
  return line.length > MAX_ARGS_IN_MESSAGE ? `${line.slice(0, MAX_ARGS_IN_MESSAGE)}…` : line;
}

/** A failed `gh` invocation. `args` is complete; only the message abbreviates it. */
export class GhError extends Error {
  readonly args: string[];
  readonly stderr: string;

  constructor(args: string[], stderr: string, message?: string) {
    super(message ?? `${describeCommand(args)} failed: ${stderr.trim() || 'no error output'}`);
    this.name = 'GhError';
    this.args = args;
    this.stderr = stderr;
  }
}

/** How long one `gh` call may take before it is killed; a hung `gh` (an auth prompt, a stalled network) would stall the command, the hook and the Actions job. */
export const GH_TIMEOUT_MS = 60_000;

/**
 * A runner for the real `gh` CLI. A non-zero exit is returned, not thrown; it rejects only when `gh`
 * cannot be run at all (not installed, output over the buffer limit, ...) or runs longer than `timeoutMs`
 * (`GH_TIMEOUT_MS` by default): then it is sent SIGTERM and the error says so. The error text matches what
 * the outbox counts as GitHub being unreachable, so a command that timed out is queued like one that could
 * not connect.
 */
export function createGhRunner(opts: { timeoutMs?: number } = {}): GhRunner {
  const timeoutMs = opts.timeoutMs ?? GH_TIMEOUT_MS;
  return (args, input) =>
    new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const child = execFile(
        'gh',
        args,
        { maxBuffer: MAX_BUFFER, encoding: 'utf8' },
        (error, stdout, stderr) => {
          clearTimeout(timer);
          if (!error) {
            resolve({ stdout, code: 0, stderr });
            return;
          }
          const failure = error as ExecFileException;
          if (failure.code === 'ENOENT') {
            reject(new GhError(args, '', 'gh CLI not found; install https://cli.github.com'));
          } else if (typeof failure.code === 'number') {
            resolve({ stdout, code: failure.code, stderr });
          } else if (failure.signal) {
            // The process ran but was killed: report it like a failed exit.
            resolve({ stdout, code: 1, stderr: stderr || `terminated by ${failure.signal}` });
          } else {
            reject(new GhError(args, stderr, `could not run ${describeCommand(args)}: ${failure.message}`));
          }
        },
      );
      // Rejecting here, not when the process is gone: a `gh` that ignores SIGTERM must not hold the caller.
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        const stderr = `gh timed out after ${timeoutMs / 1000} s`;
        reject(new GhError(args, stderr, `${stderr}: ${describeCommand(args)}`));
      }, timeoutMs);
      // `gh` may exit before reading stdin; that must not surface as an unhandled stream error.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input);
    });
}

/** The runner every command uses: the real `gh`, with the default timeout. */
export const defaultGhRunner: GhRunner = createGhRunner();

/**
 * Runs `gh` and parses stdout as JSON. `input`, when given, is JSON-stringified to stdin (the
 * caller adds `--input -` to `args`). Empty stdout yields `undefined`.
 */
export async function ghJson<T>(run: GhRunner, args: string[], input?: unknown): Promise<T> {
  const result = await run(args, input === undefined ? undefined : JSON.stringify(input));
  if (result.code !== 0) {
    throw new GhError(
      args,
      result.stderr,
      `${describeCommand(args)} exited with code ${result.code}: ${result.stderr.trim() || 'no error output'}`,
    );
  }
  if (result.stdout.trim() === '') return undefined as T;
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new GhError(
      args,
      result.stderr,
      `${describeCommand(args)} returned invalid JSON: ${(error as Error).message}`,
    );
  }
}

/** Runs `gh` and returns stdout as text; a failed run throws. */
export async function ghText(run: GhRunner, args: string[]): Promise<string> {
  const result = await run(args);
  if (result.code !== 0) throw new GhError(args, result.stderr);
  return result.stdout;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: { message?: string }[];
}

/** Runs a GraphQL operation through `gh api graphql` and returns its `data`. */
export async function graphql<T>(
  run: GhRunner,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const args = ['api', 'graphql', '--input', '-'];
  const response = await ghJson<GraphqlResponse<T> | undefined>(run, args, { query, variables });
  if (response?.errors && response.errors.length > 0) {
    const messages = response.errors.map(e => e.message ?? 'unknown GraphQL error').join('; ');
    throw new GhError(args, messages, `GraphQL error: ${messages}`);
  }
  if (typeof response !== 'object' || response === null || !('data' in response)) {
    throw new GhError(args, '', 'GraphQL response has no data');
  }
  return response.data as T;
}
