import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTransportError } from '../../src/outbox/outbox.js';
import { createGhRunner, defaultGhRunner, GH_TIMEOUT_MS, GhError, ghJson, graphql } from '../../src/github/gh.js';
import { fakeGh } from '../support/fakeGh.js';

describe('ghJson', () => {
  it('parses stdout JSON', async () => {
    const run = fakeGh([{ match: ['api', 'repos/o/r'], stdout: '{"name":"r","stars":3}' }]);
    const result = await ghJson<{ name: string; stars: number }>(run, ['api', 'repos/o/r']);
    expect(result).toEqual({ name: 'r', stars: 3 });
    expect(run.calls).toEqual([['api', 'repos/o/r']]);
  });

  it('stringifies input to stdin and passes args through', async () => {
    const run = fakeGh([{ match: ['api'], stdout: '{}' }]);
    await ghJson(run, ['api', '--input', '-'], { title: 'T', labels: ['a'] });
    expect(run.calls).toEqual([['api', '--input', '-']]);
    expect(run.inputs).toEqual(['{"title":"T","labels":["a"]}']);
  });

  it('sends no stdin when no input is given', async () => {
    const run = fakeGh([{ match: ['api'], stdout: '[]' }]);
    await ghJson(run, ['api', 'x']);
    expect(run.inputs).toEqual([undefined]);
  });

  it('returns undefined for empty stdout', async () => {
    const run = fakeGh([{ match: ['api'], stdout: '  \n' }]);
    expect(await ghJson(run, ['api', 'x'])).toBeUndefined();
  });

  it('throws GhError carrying stderr on non-zero exit', async () => {
    const run = fakeGh([{ match: ['api'], code: 1, stderr: 'HTTP 404: Not Found', stdout: '{"ignored":true}' }]);
    const error = await ghJson(run, ['api', 'repos/o/missing']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GhError);
    const ghError = error as GhError;
    expect(ghError.args).toEqual(['api', 'repos/o/missing']);
    expect(ghError.stderr).toBe('HTTP 404: Not Found');
    expect(ghError.message).toContain('HTTP 404: Not Found');
    expect(ghError.message).toContain('repos/o/missing');
  });

  it('throws GhError mentioning invalid JSON', async () => {
    const run = fakeGh([{ match: ['api'], stdout: '<html>oops</html>' }]);
    const error = await ghJson(run, ['api', 'x']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).message).toContain('invalid JSON');
  });

  it('keeps long arguments out of the error message', async () => {
    const run = fakeGh([{ match: ['api'], code: 1, stderr: 'nope' }]);
    const error = (await ghJson(run, ['api', 'x'.repeat(5000)]).catch((e: unknown) => e)) as GhError;
    expect(error.message.length).toBeLessThan(500);
    expect(error.args[1]).toHaveLength(5000);
  });
});

describe('graphql', () => {
  it('posts query and variables on stdin and returns data', async () => {
    const run = fakeGh([{ match: ['api', 'graphql', '--input', '-'], stdout: '{"data":{"viewer":{"login":"me"}}}' }]);
    const data = await graphql<{ viewer: { login: string } }>(run, 'query($n:Int){viewer{login}}', { n: 1 });
    expect(data).toEqual({ viewer: { login: 'me' } });
    expect(run.calls).toEqual([['api', 'graphql', '--input', '-']]);
    expect(JSON.parse(run.inputs[0]!)).toEqual({ query: 'query($n:Int){viewer{login}}', variables: { n: 1 } });
  });

  it('throws on errors array', async () => {
    const run = fakeGh([
      {
        match: ['graphql'],
        stdout: '{"data":null,"errors":[{"message":"Could not resolve"},{"message":"Bad field"}]}',
      },
    ]);
    const error = await graphql(run, 'query{x}', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).message).toContain('Could not resolve');
    expect((error as GhError).message).toContain('Bad field');
  });

  it('ignores an empty errors array', async () => {
    const run = fakeGh([{ match: ['graphql'], stdout: '{"data":{"ok":true},"errors":[]}' }]);
    expect(await graphql(run, 'query{x}', {})).toEqual({ ok: true });
  });

  it('throws GhError on non-zero exit', async () => {
    const run = fakeGh([{ match: ['graphql'], code: 1, stderr: 'gh: bad credentials' }]);
    const error = await graphql(run, 'query{x}', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).stderr).toBe('gh: bad credentials');
  });

  it('throws when the response carries no data', async () => {
    const run = fakeGh([{ match: ['graphql'], stdout: '{}' }]);
    const error = await graphql(run, 'query{x}', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).message).toContain('no data');
  });
});

describe.skipIf(process.platform === 'win32')('defaultGhRunner', () => {
  const originalPath = process.env.PATH;
  const dirs: string[] = [];

  afterEach(async () => {
    process.env.PATH = originalPath;
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  async function withFakeGh(script: string): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'sdlc-gh-'));
    dirs.push(dir);
    const file = join(dir, 'gh');
    await writeFile(file, `#!/bin/sh\n${script}\n`);
    await chmod(file, 0o755);
    process.env.PATH = `${dir}:${originalPath}`;
  }

  it('returns stdout and writes input to stdin', async () => {
    await withFakeGh('printf "%s|" "$@"; cat');
    const result = await defaultGhRunner(['api', 'x'], 'payload');
    expect(result).toEqual({ stdout: 'api|x|payload', code: 0, stderr: '' });
  });

  it('closes stdin when no input is given', async () => {
    await withFakeGh('cat; printf done');
    const result = await defaultGhRunner(['api']);
    expect(result.stdout).toBe('done');
  });

  it('does not throw on non-zero exit', async () => {
    await withFakeGh('echo boom >&2; echo partial; exit 3');
    const result = await defaultGhRunner(['api']);
    expect(result).toEqual({ stdout: 'partial\n', code: 3, stderr: 'boom\n' });
  });

  it('reports a process killed by a signal as a failed exit', async () => {
    await withFakeGh('kill -9 $$');
    const result = await defaultGhRunner(['api']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('SIGKILL');
  });

  it('rejects with a GhError when gh runs longer than the timeout', async () => {
    await withFakeGh('sleep 5');
    const started = Date.now();

    const error = await createGhRunner({ timeoutMs: 100 })(['api', 'x']).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).message).toMatch(/^gh timed out after 0\.1 s: gh api x$/);
    expect((error as GhError).args).toEqual(['api', 'x']);
    expect(Date.now() - started).toBeLessThan(3000);
    // The outbox sees a timeout like any other "GitHub did not answer", so the command is queued.
    expect(isTransportError(error)).toBe(true);
  });

  it('kills the gh process when it times out', async () => {
    const marker = join(await mkdtemp(join(tmpdir(), 'sdlc-gh-')), 'pid');
    dirs.push(dirname(marker));
    await withFakeGh(`[ "$1" = warm ] && exit 0\necho $$ > ${marker}\nexec sleep 5`);
    // The first run of a new executable can be slow (the OS scans it); the timed run must not pay for that.
    await defaultGhRunner(['warm']);

    await createGhRunner({ timeoutMs: 500 })(['api']).catch(() => undefined);

    const pid = Number((await readFile(marker, 'utf8')).trim());
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2000 });
  });

  it('words the timeout in seconds', async () => {
    await withFakeGh('sleep 5');
    const error = await createGhRunner({ timeoutMs: 2000 })(['api']).catch((e: unknown) => e);
    expect((error as GhError).message).toMatch(/^gh timed out after 2 s: gh api$/);
  });

  it('allows a minute by default', () => {
    expect(GH_TIMEOUT_MS).toBe(60_000);
  });

  it('does not time out a gh that answers in time', async () => {
    await withFakeGh('printf ok');
    expect(await createGhRunner({ timeoutMs: 5000 })(['api'])).toEqual({ stdout: 'ok', code: 0, stderr: '' });
  });

  it('rejects with a GhError when gh is not installed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sdlc-empty-'));
    dirs.push(dir);
    process.env.PATH = dir;
    const error = await defaultGhRunner(['api']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).message).toBe('gh CLI not found; install https://cli.github.com');
  });
});
