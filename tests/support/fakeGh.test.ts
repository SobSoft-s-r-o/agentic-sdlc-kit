import { describe, expect, it } from 'vitest';
import { fakeGh } from './fakeGh.js';

describe('fakeGh', () => {
  it('answers calls in script order and records them', async () => {
    const run = fakeGh([
      { match: ['issue', 'create'], stdout: 'https://github.test/o/r/issues/1\n' },
      { match: ['api'], code: 2, stderr: 'bad' },
    ]);
    expect(await run(['issue', 'create', '--title', 'T'])).toEqual({
      stdout: 'https://github.test/o/r/issues/1\n',
      code: 0,
      stderr: '',
    });
    expect(await run(['api', 'x'], 'body')).toEqual({ stdout: '', code: 2, stderr: 'bad' });
    expect(run.calls).toEqual([['issue', 'create', '--title', 'T'], ['api', 'x']]);
    expect(run.inputs).toEqual([undefined, 'body']);
  });

  it('matches regardless of position or order of the match strings', async () => {
    const run = fakeGh([{ match: ['--paginate', 'api'], stdout: 'ok' }]);
    expect((await run(['x', 'api', 'repos', '--paginate'])).stdout).toBe('ok');
  });

  it('rejects a call that does not match, listing its args', async () => {
    const run = fakeGh([{ match: ['issue', 'close'] }]);
    await expect(run(['issue', 'reopen', '5'])).rejects.toThrow(/issue reopen 5/);
    expect(run.calls).toEqual([['issue', 'reopen', '5']]);
  });

  it('rejects calls beyond the end of the script', async () => {
    const run = fakeGh([{ match: ['api'] }]);
    await run(['api']);
    await expect(run(['api'])).rejects.toThrow(/unexpected gh call/);
  });
});
