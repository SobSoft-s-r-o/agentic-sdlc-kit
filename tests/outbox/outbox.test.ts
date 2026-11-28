import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import { CommandError, runCommand, type CommandContext } from '../../src/commands/context.js';
import { loadConfig, typeRegistry } from '../../src/config/schema.js';
import { newTask } from '../../src/core/stateMachine.js';
import type { TaskState } from '../../src/core/types.js';
import { GhError } from '../../src/github/gh.js';
import { GAPS_FILE, OUTBOX_FILE as LOG_OUTBOX_FILE, type LoggedGap } from '../../src/hooks/localLog.js';
import {
  EXIT_TEMPFAIL,
  enqueue,
  isOutboxEntry,
  isTransportError,
  OUTBOX_FAILED_FILE,
  OUTBOX_FILE,
  queuedCounts,
  readOutbox,
  readRawLines,
  removeLines,
  SYNC_LOCK,
  type OutboxEntry,
} from '../../src/outbox/outbox.js';
import { FakeTracker } from '../support/fakeTracker.js';

const cfg = loadConfig(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/config/valid.yaml'));
const NOW = '2026-06-01T00:00:00.000Z';

let root: string;
let exitCode: typeof process.exitCode;
let noQueue: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sdlc-outbox-'));
  exitCode = process.exitCode;
  noQueue = process.env.SDLC_NO_QUEUE;
  delete process.env.SDLC_NO_QUEUE;
});
afterEach(() => {
  process.exitCode = exitCode;
  if (noQueue === undefined) delete process.env.SDLC_NO_QUEUE;
  else process.env.SDLC_NO_QUEUE = noQueue;
  rmSync(root, { recursive: true, force: true });
});

const cacheFile = (file: string): string => join(root, '.sdlc', 'cache', file);
const writeCache = (file: string, text: string): void => {
  mkdirSync(join(root, '.sdlc', 'cache'), { recursive: true });
  writeFileSync(cacheFile(file), text);
};
const readCache = (file: string): string => (existsSync(cacheFile(file)) ? readFileSync(cacheFile(file), 'utf8') : '');
const entriesOf = (file: string): OutboxEntry[] =>
  readCache(file)
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as OutboxEntry);

const gap = (issue?: number): LoggedGap => ({
  at: NOW,
  rule: 'no-task',
  text: 'edit src/a.ts',
  harness: 'claude',
  blocked: false,
  ...(issue === undefined ? {} : { issue }),
});

describe('names', () => {
  it('uses the file names the hook, status and sync agree on', () => {
    expect(OUTBOX_FILE).toBe('outbox.jsonl');
    expect(OUTBOX_FILE).toBe(LOG_OUTBOX_FILE);
    expect(OUTBOX_FAILED_FILE).toBe('outbox-failed.jsonl');
    expect(SYNC_LOCK).toBe('.sdlc/cache/sync.lock');
    expect(EXIT_TEMPFAIL).toBe(75);
  });
});

describe('isTransportError', () => {
  const ghError = (stderr: string): GhError => new GhError(['api', 'x'], stderr);

  it.each([
    'dial tcp: lookup api.github.com: could not resolve host: api.github.com',
    'Post "https://api.github.com/graphql": connection refused',
    'read tcp 10.0.0.1:5555: Connection reset by peer',
    'net/http: request canceled (Client.Timeout exceeded) timed out',
    'operation timeout',
    'connect ETIMEDOUT 140.82.112.5:443',
    'read ECONNRESET',
    'getaddrinfo EAI_AGAIN api.github.com',
    'API rate limit exceeded for user ID 1',
    'gh: Bad Gateway (HTTP 502)',
    'gh: Service Unavailable (HTTP 503)',
    'gh: Gateway Timeout (HTTP 504)',
  ])('treats a gh failure saying "%s" as transport', stderr => {
    expect(isTransportError(ghError(stderr))).toBe(true);
  });

  it.each([
    'HTTP 404: Not Found',
    'HTTP 403: Resource not accessible by integration',
    'HTTP 422: Validation Failed',
    'GraphQL error: Could not resolve to an Issue with the number of 99.',
    '',
  ])('does not treat a gh failure saying "%s" as transport', stderr => {
    expect(isTransportError(ghError(stderr))).toBe(false);
  });

  it('finds the gh failure behind the error of a tracker step', () => {
    const wrapped = new CommandError('getTask failed for #5', 'getTask', {
      cause: ghError('could not resolve host: api.github.com'),
    });
    expect(isTransportError(wrapped)).toBe(true);
  });

  it('is false for errors that are not a gh failure, whatever their message says', () => {
    expect(isTransportError(new Error('connection refused'))).toBe(false);
    expect(isTransportError('could not resolve host')).toBe(false);
    expect(isTransportError(undefined)).toBe(false);
    expect(isTransportError(new CommandError('x', 'getTask', { cause: new Error('timed out') }))).toBe(false);
  });
});

describe('the outbox file', () => {
  it('appends {id, at, argv} lines, each with its own id', async () => {
    const first = await enqueue(root, ['stage', 'start', '5', 'planning'], NOW);
    const second = await enqueue(root, ['approve', '5', 'approve'], NOW);

    expect(first).toEqual({ id: expect.any(String), at: NOW, argv: ['stage', 'start', '5', 'planning'] });
    expect(second.id).not.toBe(first.id);
    expect(entriesOf(OUTBOX_FILE)).toEqual([first, second]);
    expect(await readOutbox(root)).toEqual([first, second]);
  });

  it('reads nothing from a missing file', async () => {
    expect(await readOutbox(root)).toEqual([]);
    expect(await queuedCounts(root)).toEqual({ outbox: 0, gaps: 0 });
  });

  it.each([
    [{ id: 'a', at: NOW, argv: ['status'] }, true],
    [{ id: 'a', at: NOW, argv: [] }, false],
    [{ id: 'a', at: NOW, argv: ['stage', 5] }, false],
    [{ id: 'a', at: NOW }, false],
    [{ id: 1, at: NOW, argv: ['status'] }, false],
    [{ argv: ['status'] }, false],
    [['status'], false],
    [null, false],
    ['status', false],
  ])('%j is well-formed: %s', (value, wellFormed) => {
    expect(isOutboxEntry(value)).toBe(wellFormed);
  });

  it('skips a line that is cut short, not JSON or not an entry, without throwing', async () => {
    const good = { id: 'a', at: NOW, argv: ['stage', 'start', '5', 'planning'] };
    writeCache(OUTBOX_FILE, `${JSON.stringify(good)}\n{"id":"b","at"\nnot json\n{"rule":"no-task"}\n42\n\n`);

    expect(await readOutbox(root)).toEqual([good]);
  });

  it('counts only the well-formed lines of the outbox and of the gaps', async () => {
    writeCache(OUTBOX_FILE, `${JSON.stringify({ id: 'a', at: NOW, argv: ['status'] })}\ngarbage\n{"argv":["x"]}\n`);
    writeCache(
      GAPS_FILE,
      `${JSON.stringify(gap(5))}\n${JSON.stringify(gap())}\n{"rule":"no-task"}\n{"at":\n${JSON.stringify({ ...gap(), issue: 'five' })}\n`,
    );

    expect(await queuedCounts(root)).toEqual({ outbox: 1, gaps: 2 });
  });

  it('counts a file that cannot be read as empty', async () => {
    mkdirSync(cacheFile(OUTBOX_FILE), { recursive: true });

    expect(await queuedCounts(root)).toEqual({ outbox: 0, gaps: 0 });
  });
});

describe('removeLines', () => {
  it('removes the lines it is given and keeps the others, the lines added since included', async () => {
    writeCache('q.jsonl', 'a\nb\nc\n');
    const seen = await readRawLines(root, 'q.jsonl');
    writeCache('q.jsonl', 'a\nb\nc\nlate\n');

    await removeLines(root, 'q.jsonl', [seen[0] as string, seen[2] as string]);

    expect(readCache('q.jsonl')).toBe('b\nlate\n');
  });

  it('removes one line for each line given, so a repeated line is not lost', async () => {
    writeCache('q.jsonl', 'x\nx\ny\n');

    await removeLines(root, 'q.jsonl', ['x']);

    expect(readCache('q.jsonl')).toBe('x\ny\n');
  });

  it('leaves an empty file when nothing is left, and does nothing for a missing one', async () => {
    writeCache('q.jsonl', 'a\n');
    await removeLines(root, 'q.jsonl', ['a']);
    expect(readCache('q.jsonl')).toBe('');
    expect(existsSync(cacheFile('q.jsonl'))).toBe(true);

    await removeLines(root, 'missing.jsonl', ['a']);
    expect(existsSync(cacheFile('missing.jsonl'))).toBe(false);
  });

  it('reads the non-blank lines raw', async () => {
    writeCache('q.jsonl', 'a\n\n  \nb');
    expect(await readRawLines(root, 'q.jsonl')).toEqual(['a', 'b']);
    expect(await readRawLines(root, 'missing.jsonl')).toEqual([]);
  });
});

describe('runCommand with a command line to queue', () => {
  const type = typeRegistry(cfg).get('feature')!;
  const offline = (): GhError => new GhError(['api', 'graphql'], 'dial tcp: could not resolve host: api.github.com');

  function setup(overrides: Partial<CommandContext> = {}) {
    const tracker = new FakeTracker();
    tracker.owners = [...cfg.owners];
    const state: TaskState = newTask({ issue: 5, type, summary: 'Add search', now: NOW });
    tracker.seedTask(state);
    const out: unknown[] = [];
    const err: string[] = [];
    const ctx: CommandContext = {
      tracker,
      cfg,
      now: () => NOW,
      out: data => out.push(data),
      err: text => err.push(text),
      repoRoot: root,
      ...overrides,
    };
    return { tracker, ctx, out, err };
  }

  const argv = ['stage', 'start', '5', 'planning'];
  const goOffline = (tracker: FakeTracker): void => {
    tracker.getTask = async () => {
      throw offline();
    };
  };
  const failing = async (): Promise<never> => {
    throw new CommandError('getTask failed for #5', 'getTask', { cause: offline() });
  };

  it('queues the command line when the tracker is unreachable, says so and exits 0', async () => {
    const { ctx, out, err } = setup();

    await runCommand(() => ctx, { queueArgv: argv }, failing, () => 'done');

    const [entry] = entriesOf(OUTBOX_FILE);
    expect(entriesOf(OUTBOX_FILE)).toEqual([{ id: expect.any(String), at: NOW, argv }]);
    expect(out).toEqual([`queued for \`sdlc sync\` (GitHub unreachable): sdlc stage start 5 planning`]);
    expect(entry?.id).not.toBe('');
    expect(err).toEqual([]);
    expect(process.exitCode).toBe(exitCode);
  });

  it('answers {"queued":true,"id":...} with --json', async () => {
    const { ctx, out } = setup();

    await runCommand(() => ctx, { json: true, queueArgv: argv }, failing, () => 'done');

    const [entry] = entriesOf(OUTBOX_FILE);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] as string)).toEqual({ queued: true, id: entry?.id });
    expect(process.exitCode).toBe(exitCode);
  });

  it('queues the failure of a real command when its tracker is unreachable', async () => {
    const { tracker, ctx, out } = setup();
    goOffline(tracker);
    const { stageStart } = await import('../../src/commands/stage.js');

    await runCommand(() => ctx, { queueArgv: argv }, c => stageStart(c, 5, 'planning'), () => 'done');

    expect(entriesOf(OUTBOX_FILE)).toHaveLength(1);
    expect(out).toHaveLength(1);
  });

  it('exits 75 and queues nothing when SDLC_NO_QUEUE=1 (a replay must not queue itself again)', async () => {
    process.env.SDLC_NO_QUEUE = '1';
    const { ctx, out, err } = setup();

    await runCommand(() => ctx, { queueArgv: argv }, failing, () => 'done');

    expect(process.exitCode).toBe(EXIT_TEMPFAIL);
    expect(existsSync(cacheFile(OUTBOX_FILE))).toBe(false);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('could not resolve host');
  });

  it('exits 75 with the error as JSON when queueing is off and --json is given', async () => {
    process.env.SDLC_NO_QUEUE = '1';
    const { ctx, out } = setup();

    await runCommand(() => ctx, { json: true, queueArgv: argv }, failing, () => 'done');

    expect(process.exitCode).toBe(EXIT_TEMPFAIL);
    expect(JSON.parse(out[0] as string)).toHaveProperty('error');
  });

  it('does not queue an error that is not a transport failure, and exits 1', async () => {
    const { ctx, err } = setup();

    await runCommand(
      () => ctx,
      { queueArgv: argv },
      async () => {
        throw new CommandError('getTask failed for #5', 'getTask', { cause: new GhError(['api'], 'HTTP 404: Not Found') });
      },
      () => 'done',
    );

    expect(existsSync(cacheFile(OUTBOX_FILE))).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(err).toHaveLength(1);
  });

  it('does not queue when the command names no command line (a command that is not queueable)', async () => {
    const { ctx } = setup();

    await runCommand(() => ctx, {}, failing, () => 'done');

    expect(existsSync(cacheFile(OUTBOX_FILE))).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('does not queue when the context has no repository root to queue in', async () => {
    const { ctx, err } = setup({ repoRoot: undefined });

    await runCommand(() => ctx, { queueArgv: argv }, failing, () => 'done');

    expect(process.exitCode).toBe(1);
    expect(err).toHaveLength(1);
  });

  it('reports the original error, exit 1, when the queue cannot be written', async () => {
    mkdirSync(cacheFile(OUTBOX_FILE), { recursive: true });
    const { ctx, err } = setup();

    await runCommand(() => ctx, { queueArgv: argv }, failing, () => 'done');

    expect(process.exitCode).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('getTask failed for #5');
  });

  it('prints the result as before when the command works', async () => {
    const { ctx, out } = setup();

    await runCommand(() => ctx, { queueArgv: argv }, async () => 'ok', result => `result ${result}`);

    expect(out).toEqual(['result ok']);
    expect(existsSync(cacheFile(OUTBOX_FILE))).toBe(false);
  });
});

describe('which commands queue (cli)', () => {
  const type = typeRegistry(cfg).get('feature')!;
  const startDir = process.cwd();
  // Relative paths of the command line are resolved against the directory it runs in.
  beforeEach(() => {
    writeFileSync(join(root, 'summary.md'), 'Goal: add search.');
    process.chdir(root);
  });
  afterEach(() => {
    process.chdir(startDir);
  });

  function setup() {
    const fake = new FakeTracker();
    fake.seedTask(newTask({ issue: 5, type, summary: 'Add search', now: NOW }));
    // Every call fails as it does with no network.
    const tracker = new Proxy(fake, {
      get: (target, property) =>
        typeof target[property as keyof FakeTracker] === 'function'
          ? async () => {
              throw new GhError(['api', 'graphql'], 'could not resolve host: api.github.com');
            }
          : target[property as keyof FakeTracker],
    });
    const out: string[] = [];
    const err: string[] = [];
    const ctx: CommandContext = {
      tracker,
      cfg,
      now: () => NOW,
      out: data => out.push(String(data)),
      err: text => err.push(text),
      repoRoot: root,
    };
    return { ctx, out, err, deps: { makeContext: () => ctx, out: (t: string) => out.push(t), err: (t: string) => err.push(t) } };
  }

  const run = (args: string[], deps: ReturnType<typeof setup>['deps'], argv = args) => runCli(args, { ...deps, argv });

  it.each([
    [['stage', 'start', '5', 'planning']],
    [['stage', 'publish', '5', 'planning', '--needs-approval']],
    [['evidence', 'add', '5', '--kind', 'backup', '--ref', 'b1']],
    [['review', 'handoff', '5', '--pr', '9']],
    [['approve', '5', 'approve', '--unverified']],
    [['task', 'checkpoint', '5', '--current', 'writing the plan']],
  ])('queues %j when GitHub is unreachable', async args => {
    const { deps, out } = setup();
    const withFile = args[1] === 'publish' ? [...args, '--file', 'summary.md'] : args;

    await run(withFile, deps);

    const [entry] = entriesOf(OUTBOX_FILE);
    expect(entriesOf(OUTBOX_FILE)).toHaveLength(1);
    // A relative path is resolved here: sync runs in another directory.
    expect(entry?.argv).toEqual(args[1] === 'publish' ? [...args, '--file', resolve('summary.md')] : args);
    expect(out.join('\n')).toContain('queued for `sdlc sync` (GitHub unreachable): sdlc ');
    expect(process.exitCode).toBe(exitCode);
  });

  it.each([
    [['task', 'new', '--title', 'T', '--summary', 'S', '--type', 'feature']],
    [['task', 'set-type', '5', 'bugfix']],
    [['task', 'reopen', '5']],
    [['deploy', 'record', '--target', 'web', '--sha', 'abc1234']],
    [['reconcile']],
    [['status']],
  ])('does not queue %j', async args => {
    const { deps } = setup();

    await run(args, deps);

    expect(existsSync(cacheFile(OUTBOX_FILE))).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('resolves the config path of the queued command line too, whichever form it is given in', async () => {
    const { deps } = setup();
    const args = ['--config', 'cfg/sdlc.config.yaml', 'stage', 'start', '5', 'planning'];

    await run(args, deps);
    await run(['stage', 'start', '5', 'planning', '--config=other.yaml'], deps);

    const [first, second] = entriesOf(OUTBOX_FILE);
    expect(first?.argv).toEqual(['--config', resolve('cfg/sdlc.config.yaml'), 'stage', 'start', '5', 'planning']);
    expect(second?.argv).toEqual(['stage', 'start', '5', 'planning', `--config=${resolve('other.yaml')}`]);
    for (const value of [first?.argv[1], resolve('other.yaml')]) expect(isAbsolute(value as string)).toBe(true);
  });

  it('keeps a file path that is already absolute and the other arguments as given', async () => {
    const { deps } = setup();
    const file = join(root, 'summary.md');

    await run(['stage', 'publish', '5', 'planning', `--file=${file}`], deps);

    expect(entriesOf(OUTBOX_FILE)[0]?.argv).toEqual(['stage', 'publish', '5', 'planning', `--file=${file}`]);
  });
});
