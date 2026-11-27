import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultGhRunner, GhError, ghJson, graphql } from '../../src/github/gh.js';
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

  it('rejects with a GhError when gh is not installed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sdlc-empty-'));
    dirs.push(dir);
    process.env.PATH = dir;
    const error = await defaultGhRunner(['api']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).message).toBe('gh CLI not found; install https://cli.github.com');
  });
});
