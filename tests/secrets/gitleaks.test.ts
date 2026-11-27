import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execProgram, findOnPath, GITLEAKS_ARGS, runGitleaks, type Exec } from '../../src/secrets/gitleaks.js';

const present = () => '/usr/local/bin/gitleaks';
const absent = () => undefined;

function recorder(answer: Awaited<ReturnType<Exec>> | Error): { exec: Exec; calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = [];
  return {
    calls,
    exec: async (command, args) => {
      calls.push([command, args]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

describe('runGitleaks', () => {
  it('is the staged, redacted scan of the brief', () => {
    expect(GITLEAKS_ARGS).toEqual(['git', '--pre-commit', '--staged', '--redact', '--no-banner']);
  });

  it('absent from the PATH: not called, nothing to report', async () => {
    const { exec, calls } = recorder({ code: 1, stdout: 'leaks', stderr: '' });

    expect(await runGitleaks(exec, absent)).toEqual({ blocked: false, output: [] });
    expect(calls).toEqual([]);
  });

  it('exit 0: no findings', async () => {
    const { exec, calls } = recorder({ code: 0, stdout: 'no leaks found', stderr: '' });

    expect(await runGitleaks(exec, present)).toEqual({ blocked: false, output: [] });
    expect(calls).toEqual([['gitleaks', GITLEAKS_ARGS]]);
  });

  it('exit 1: findings, blocked with its output (stdout then stderr, no blank lines)', async () => {
    const { exec } = recorder({ code: 1, stdout: 'Finding: REDACTED\nFile: a.ts\n\n', stderr: 'WRN leaks found: 1\n' });

    expect(await runGitleaks(exec, present)).toEqual({
      blocked: true,
      output: ['Finding: REDACTED', 'File: a.ts', 'WRN leaks found: 1'],
    });
  });

  it('any other exit code: warns and does not block', async () => {
    const { exec } = recorder({ code: 2, stdout: '', stderr: 'bad flag' });

    expect(await runGitleaks(exec, present)).toEqual({
      blocked: false,
      output: [],
      warning: 'gitleaks failed (2); built-in guard only',
    });
  });

  it('a gitleaks that cannot run, or a lookup that throws, warns with the reason and does not block', async () => {
    const broken = recorder(new Error('spawn gitleaks EACCES\nsecond line'));
    const lookup = async (): Promise<string | undefined> => {
      throw new Error('PATH is unreadable');
    };

    expect(await runGitleaks(broken.exec, present)).toEqual({
      blocked: false,
      output: [],
      warning: 'gitleaks failed (spawn gitleaks EACCES); built-in guard only',
    });
    expect(await runGitleaks(recorder({ code: 0, stdout: '', stderr: '' }).exec, lookup)).toEqual({
      blocked: false,
      output: [],
      warning: 'gitleaks failed (PATH is unreadable); built-in guard only',
    });
  });

  it('accepts an asynchronous which', async () => {
    const { exec, calls } = recorder({ code: 0, stdout: '', stderr: '' });

    await runGitleaks(exec, async () => '/bin/gitleaks');

    expect(calls).toHaveLength(1);
  });
});

describe('findOnPath', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('finds an executable file on the PATH, and nothing else', () => {
    dir = mkdtempSync(join(tmpdir(), 'sdlc-path-'));
    const bin = join(dir, 'bin');
    const other = join(dir, 'other');
    mkdirSync(bin);
    mkdirSync(other);
    writeFileSync(join(bin, 'tool'), '#!/bin/sh\n');
    chmodSync(join(bin, 'tool'), 0o755);
    writeFileSync(join(other, 'plain'), 'not executable');
    chmodSync(join(other, 'plain'), 0o644);
    mkdirSync(join(bin, 'adir'));
    const env = { PATH: [other, bin].join(delimiter) };

    expect(findOnPath('tool', env)).toBe(join(bin, 'tool'));
    expect(findOnPath('plain', env)).toBeUndefined();
    expect(findOnPath('adir', env)).toBeUndefined();
    expect(findOnPath('missing', env)).toBeUndefined();
    expect(findOnPath('tool', { PATH: '' })).toBeUndefined();
    expect(findOnPath('tool', {})).toBeUndefined();
  });
});

describe('execProgram', () => {
  const node = process.execPath;

  it('gives the exit code and the output of a program, also when it fails', async () => {
    const exec = execProgram(process.cwd());

    expect(await exec(node, ['-e', 'console.log("out"); console.error("err"); process.exit(3)'])).toEqual({
      code: 3,
      stdout: 'out\n',
      stderr: 'err\n',
    });
    expect((await exec(node, ['-e', '0'])).code).toBe(0);
  });

  it('rejects when the program cannot start or runs past the deadline', async () => {
    await expect(execProgram(process.cwd())('sdlc-no-such-program', [])).rejects.toThrow(/sdlc-no-such-program/);
    await expect(execProgram(process.cwd(), 100)(node, ['-e', 'setTimeout(() => {}, 5000)'])).rejects.toThrow(
      'timed out',
    );
  });
});
