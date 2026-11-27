import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandError, runCommand, type CommandContext } from '../../src/commands/context.js';
import { errorAsJson, formatCliError } from '../../src/commands/errors.js';
import { GhError } from '../../src/github/gh.js';
import { FakeTracker } from '../support/fakeTracker.js';

const ghFailure = (): GhError => new GhError(['api', '-X', 'PATCH', 'repos/acme/shop/issues/comments/9'], 'HTTP 422: Validation Failed\n');
/** A gh failure wrapped as a command step, as `trackerStep` wraps it. */
const wrapped = (): CommandError =>
  new CommandError('writeState failed for #3: gh api failed', 'writeState', { cause: ghFailure() });

let exitCode: typeof process.exitCode;
beforeEach(() => {
  exitCode = process.exitCode;
});
afterEach(() => {
  process.exitCode = exitCode;
});

describe('formatCliError and errorAsJson', () => {
  it('find a GhError anywhere in the cause chain', () => {
    const text = formatCliError(new Error('outer', { cause: wrapped() }));
    expect(text.split('\n')).toEqual([
      'outer',
      '  command: gh api -X PATCH repos/acme/shop/issues/comments/9',
      '  stderr: HTTP 422: Validation Failed',
    ]);
    expect(errorAsJson(wrapped())).toEqual({
      error: 'writeState failed for #3: gh api failed',
      args: ['api', '-X', 'PATCH', 'repos/acme/shop/issues/comments/9'],
      stderr: 'HTTP 422: Validation Failed\n',
    });
  });

  it('stop at a cause cycle', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(formatCliError(a)).toBe('a');
  });
});

describe('runCommand', () => {
  function context(): { ctx: CommandContext; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const ctx: CommandContext = {
      tracker: new FakeTracker(),
      cfg: {} as CommandContext['cfg'],
      now: () => '2026-06-01T00:00:00.000Z',
      out: data => out.push(String(data)),
      err: text => err.push(text),
    };
    return { ctx, out, err };
  }

  it('prints the gh command and stderr behind a failed step', async () => {
    const h = context();
    await runCommand(() => h.ctx, {}, () => Promise.reject(wrapped()), () => '');
    expect(h.err).toEqual([
      [
        'writeState failed for #3: gh api failed',
        '  command: gh api -X PATCH repos/acme/shop/issues/comments/9',
        '  stderr: HTTP 422: Validation Failed',
      ].join('\n'),
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('puts them in the JSON error with --json', async () => {
    const h = context();
    await runCommand(() => h.ctx, { json: true }, () => Promise.reject(wrapped()), () => '');
    expect(JSON.parse(h.out[0]!)).toEqual({
      error: 'writeState failed for #3: gh api failed',
      args: ['api', '-X', 'PATCH', 'repos/acme/shop/issues/comments/9'],
      stderr: 'HTTP 422: Validation Failed\n',
    });
  });

  it('prints only the message of an error without a gh failure behind it', async () => {
    const h = context();
    await runCommand(() => h.ctx, {}, () => Promise.reject(new Error('plain')), () => '');
    expect(h.err).toEqual(['plain']);
  });
});
