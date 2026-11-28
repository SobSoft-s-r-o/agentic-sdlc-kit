import { describe, expect, it } from 'vitest';
import {
  isPathUnder,
  listWorktrees,
  orphanWorktrees,
  parseWorktreeList,
  taskSlug,
  type Worktree,
} from '../../src/git/worktrees.js';
import type { GitRunner } from '../../src/install/provision.js';

const PORCELAIN = [
  'worktree /repo',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree /repo/.worktrees/5-add-login',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/task/5-add-login',
  '',
  'worktree /repo/.worktrees/old',
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  '',
  'worktree /repo/.worktrees/7-gone',
  'HEAD 4444444444444444444444444444444444444444',
  'branch refs/heads/task/7-gone',
  'locked waiting for the owner',
  'prunable gitdir file points to non-existent location',
  '',
  'worktree /bare.git',
  'bare',
  '',
].join('\n');

describe('parseWorktreeList', () => {
  it('reads the main checkout, a branch worktree, a detached one, a locked prunable one and a bare repository', () => {
    expect(parseWorktreeList(PORCELAIN)).toEqual<Worktree[]>([
      {
        path: '/repo',
        head: '1'.repeat(40),
        branch: 'main',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: '/repo/.worktrees/5-add-login',
        head: '2'.repeat(40),
        branch: 'task/5-add-login',
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      { path: '/repo/.worktrees/old', head: '3'.repeat(40), detached: true, bare: false, locked: false, prunable: false },
      {
        path: '/repo/.worktrees/7-gone',
        head: '4'.repeat(40),
        branch: 'task/7-gone',
        detached: false,
        bare: false,
        locked: true,
        prunable: true,
      },
      { path: '/bare.git', detached: false, bare: true, locked: false, prunable: false },
    ]);
  });

  it('reads a bare `locked` and `prunable` line without a reason, and CRLF line ends', () => {
    const text = ['worktree /w', 'HEAD abc', 'branch refs/heads/x', 'locked', 'prunable', ''].join('\r\n');

    expect(parseWorktreeList(text)).toEqual([
      { path: '/w', head: 'abc', branch: 'x', detached: false, bare: false, locked: true, prunable: true },
    ]);
  });

  it('is empty for no output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });

  it('keeps a path with spaces whole', () => {
    expect(parseWorktreeList('worktree /my repo/.worktrees/1-a b\nHEAD abc\ndetached\n')[0]?.path).toBe(
      '/my repo/.worktrees/1-a b',
    );
  });
});

describe('listWorktrees', () => {
  it('runs git worktree list --porcelain and parses it', async () => {
    const calls: string[][] = [];
    const git: GitRunner = async args => {
      calls.push(args);
      return { stdout: PORCELAIN, stderr: '', code: 0 };
    };

    const list = await listWorktrees(git);

    expect(calls).toEqual([['worktree', 'list', '--porcelain']]);
    expect(list.map(worktree => worktree.path)).toEqual([
      '/repo',
      '/repo/.worktrees/5-add-login',
      '/repo/.worktrees/old',
      '/repo/.worktrees/7-gone',
      '/bare.git',
    ]);
  });

  it('throws when git fails, with its reason', async () => {
    const git: GitRunner = async () => ({ stdout: '', stderr: 'fatal: not a git repository\n', code: 128 });

    await expect(listWorktrees(git)).rejects.toThrow('git worktree list failed: fatal: not a git repository');
  });
});

describe('taskSlug', () => {
  it('lowercases and turns every run of other characters into one dash', () => {
    expect(taskSlug('Fix: Login – crash on iOS 18!')).toBe('fix-login-crash-on-ios-18');
  });

  it('trims dashes at both ends', () => {
    expect(taskSlug('  --Hello, World--  ')).toBe('hello-world');
  });

  it('is `task` when nothing is left', () => {
    expect(taskSlug('')).toBe('task');
    expect(taskSlug('!!! – ???')).toBe('task');
    expect(taskSlug('řý')).toBe('task');
  });

  it('keeps a slug of 40 characters as it is', () => {
    const forty = `${'a'.repeat(19)}-${'b'.repeat(20)}`;
    expect(forty).toHaveLength(40);
    expect(taskSlug(forty)).toBe(forty);
  });

  it('cuts a longer slug at the last dash that keeps it within 40 characters', () => {
    const slug = taskSlug('Implement the new login flow with passkeys and fallback codes');

    expect(slug).toBe('implement-the-new-login-flow-with');
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it('keeps the whole words when the cut falls exactly on a dash', () => {
    // 20 + dash + 19 = 40 characters, then a dash and more words.
    const title = `${'a'.repeat(20)} ${'b'.repeat(19)} cc`;

    expect(taskSlug(title)).toBe(`${'a'.repeat(20)}-${'b'.repeat(19)}`);
  });

  it('cuts at 40 characters when there is no dash to cut at', () => {
    expect(taskSlug('x'.repeat(60))).toBe('x'.repeat(40));
  });

  it('never ends in a dash', () => {
    expect(taskSlug(`${'a'.repeat(39)} b`)).toBe('a'.repeat(39));
  });
});

describe('isPathUnder', () => {
  it('is true for a path inside the directory, not for the directory itself or a sibling that shares a prefix', () => {
    expect(isPathUnder('/repo/.worktrees', '/repo/.worktrees/1-a')).toBe(true);
    expect(isPathUnder('/repo/.worktrees', '/repo/.worktrees/1-a/src')).toBe(true);
    expect(isPathUnder('/repo/.worktrees', '/repo/.worktrees')).toBe(false);
    expect(isPathUnder('/repo/.worktrees', '/repo/.worktrees-old/1-a')).toBe(false);
    expect(isPathUnder('/repo/.worktrees', '/repo')).toBe(false);
    expect(isPathUnder('/repo/.worktrees', '/elsewhere/.worktrees/1-a')).toBe(false);
  });
});

describe('orphanWorktrees', () => {
  const wt = (path: string, overrides: Partial<Worktree> = {}): Worktree => ({
    path,
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
    ...overrides,
  });
  const tasks = new Map<number, { status: 'in_progress' | 'done' | 'ready' }>([
    [4, { status: 'done' }],
    [5, { status: 'in_progress' }],
  ]);

  it('reports a task branch whose task is not tracked', () => {
    const list = [wt('/repo/.worktrees/9-x', { branch: 'task/9-x' })];

    expect(orphanWorktrees(list, '/repo', tasks)).toEqual([
      { path: '/repo/.worktrees/9-x', branch: 'task/9-x', reason: 'no-task' },
    ]);
  });

  it('reports a worktree whose task is done', () => {
    const list = [wt('/repo/.worktrees/4-y', { branch: 'task/4-y' })];

    expect(orphanWorktrees(list, '/repo', tasks)).toEqual([
      { path: '/repo/.worktrees/4-y', branch: 'task/4-y', reason: 'task-done' },
    ]);
  });

  it('reports a detached worktree, without a branch', () => {
    const list = [wt('/repo/.worktrees/old', { detached: true })];

    expect(orphanWorktrees(list, '/repo', tasks)).toEqual([{ path: '/repo/.worktrees/old', reason: 'detached' }]);
  });

  it('reports a prunable worktree first, whatever else is true of it', () => {
    const list = [wt('/repo/.worktrees/9-x', { branch: 'task/9-x', prunable: true })];

    expect(orphanWorktrees(list, '/repo', tasks)).toEqual([
      { path: '/repo/.worktrees/9-x', branch: 'task/9-x', reason: 'prunable' },
    ]);
  });

  it('leaves out a worktree of a live task', () => {
    const list = [wt('/repo/.worktrees/5-add-login', { branch: 'task/5-add-login' })];

    expect(orphanWorktrees(list, '/repo', tasks)).toEqual([]);
  });

  it('gives nothing for paths outside <repoRoot>/.worktrees/, the main checkout and a bare repository included', () => {
    const list = [
      wt('/repo', { branch: 'main' }),
      wt('/elsewhere/9-x', { branch: 'task/9-x' }),
      wt('/repo/other/9-x', { branch: 'task/9-x' }),
      wt('/repo/.worktrees-old/9-x', { branch: 'task/9-x' }),
      wt('/repo/.worktrees', { detached: true }),
      wt('/bare.git', { bare: true }),
      wt('/other-repo/.worktrees/9-x', { branch: 'task/9-x' }),
    ];

    expect(orphanWorktrees(list, '/repo', tasks)).toEqual([]);
  });

  it('leaves out a branch that is not a task branch: it is not ours to judge', () => {
    const list = [wt('/repo/.worktrees/plan', { branch: 'feat/plan' })];

    expect(orphanWorktrees(list, '/repo', tasks)).toEqual([]);
  });

  it('keeps the order git listed them in', () => {
    const list = [
      wt('/repo/.worktrees/9-x', { branch: 'task/9-x' }),
      wt('/repo/.worktrees/4-y', { branch: 'task/4-y' }),
      wt('/repo/.worktrees/old', { detached: true }),
    ];

    expect(orphanWorktrees(list, '/repo', tasks).map(orphan => orphan.reason)).toEqual([
      'no-task',
      'task-done',
      'detached',
    ]);
  });
});
