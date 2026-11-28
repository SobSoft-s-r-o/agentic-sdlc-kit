import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendJsonLine,
  CACHE_DIR,
  GAPS_FILE,
  PROMPTS_FILE,
  readJsonFile,
  readJsonLines,
  TASK_CACHE_FILE,
  writeJsonFile,
  type LoggedGap,
} from '../../src/hooks/localLog.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sdlc-log-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const gap = (text: string, issue?: number): LoggedGap => ({
  at: '2026-06-01T00:00:00.000Z',
  rule: 'no-task',
  text,
  harness: 'claude',
  blocked: true,
  ...(issue === undefined ? {} : { issue }),
});

describe('local log files', () => {
  it('uses the names the sync and the hooks agree on', () => {
    expect([CACHE_DIR, GAPS_FILE, PROMPTS_FILE, TASK_CACHE_FILE]).toEqual([
      '.sdlc/cache',
      'gaps.jsonl',
      'prompts.jsonl',
      'hook-tasks.json',
    ]);
  });

  it('appends one JSON line per value, creating the directory', async () => {
    await appendJsonLine(root, GAPS_FILE, gap('one', 5));
    await appendJsonLine(root, GAPS_FILE, gap('two'));

    const lines = readFileSync(join(root, '.sdlc', 'cache', 'gaps.jsonl'), 'utf8').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(await readJsonLines<LoggedGap>(root, GAPS_FILE)).toEqual([gap('one', 5), gap('two')]);
  });

  it('keeps a value whose text holds a newline on one line', async () => {
    await appendJsonLine(root, GAPS_FILE, gap('a\nb'));

    expect(readFileSync(join(root, '.sdlc', 'cache', 'gaps.jsonl'), 'utf8').split('\n')).toHaveLength(2);
    expect((await readJsonLines<LoggedGap>(root, GAPS_FILE))[0]?.text).toBe('a\nb');
  });

  it('reads a missing file as empty', async () => {
    expect(await readJsonLines(root, GAPS_FILE)).toEqual([]);
  });

  it('skips lines that are not JSON, and blank lines', async () => {
    mkdirSync(join(root, '.sdlc', 'cache'), { recursive: true });
    writeFileSync(
      join(root, '.sdlc', 'cache', 'gaps.jsonl'),
      `${JSON.stringify(gap('first'))}\n{"at": "cut off\n\nnot json at all\n${JSON.stringify(gap('last'))}\n`,
    );

    expect((await readJsonLines<LoggedGap>(root, GAPS_FILE)).map(g => g.text)).toEqual(['first', 'last']);
  });

  it('rejects when the cache directory cannot be created (a file is in the way)', async () => {
    writeFileSync(join(root, '.sdlc'), 'a file');

    await expect(appendJsonLine(root, GAPS_FILE, gap('x'))).rejects.toThrow();
  });

  it('writes a JSON file whole, replaces it, and leaves no temporary file behind', async () => {
    await writeJsonFile(root, TASK_CACHE_FILE, { '5': { at: 'a' } });
    await writeJsonFile(root, TASK_CACHE_FILE, { '7': { at: 'b' } });

    expect(await readJsonFile(root, TASK_CACHE_FILE)).toEqual({ '7': { at: 'b' } });
    expect(readdirSync(join(root, '.sdlc', 'cache'))).toEqual([TASK_CACHE_FILE]);
  });

  it('reads a missing or damaged JSON file as undefined', async () => {
    expect(await readJsonFile(root, TASK_CACHE_FILE)).toBeUndefined();
    mkdirSync(join(root, '.sdlc', 'cache'), { recursive: true });
    writeFileSync(join(root, '.sdlc', 'cache', TASK_CACHE_FILE), '{"5": {');

    expect(await readJsonFile(root, TASK_CACHE_FILE)).toBeUndefined();
    expect(existsSync(join(root, '.sdlc', 'cache', TASK_CACHE_FILE))).toBe(true);
  });
});
