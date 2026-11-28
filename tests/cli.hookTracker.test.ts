import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../src/cli.js';
import type { HookContext } from '../src/commands/hook.js';
import { loadConfig } from '../src/config/schema.js';
import { fakeGh, type FakeGh } from './support/fakeGh.js';

// The real `gh` is never run: the default runner the CLI builds its trackers with answers from `script`.
const gh = vi.hoisted(() => ({ run: undefined as unknown as FakeGh }));
vi.mock('../src/github/gh.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/github/gh.js')>()),
  defaultGhRunner: (args: string[], input?: string) => gh.run(args, input),
}));
// The context factory the CLI hands to the `hook` command, which is otherwise out of reach.
const hook = vi.hoisted(() => ({ makeContext: undefined as undefined | (() => HookContext | Promise<HookContext>) }));
vi.mock('../src/commands/hook.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/commands/hook.js')>();
  return {
    ...actual,
    registerHookCommand: (...args: Parameters<typeof actual.registerHookCommand>) => {
      hook.makeContext = args[1];
      actual.registerHookCommand(...args);
    },
  };
});

const cfg = loadConfig(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'config', 'valid.yaml'));
const PR_ROW = {
  id: 'PR_kwDOAcme7',
  number: 7,
  url: 'https://github.com/acme/shop/pull/7',
  mergedAt: null,
  mergeCommit: null,
  baseRefName: 'main',
  body: 'Related to #12',
  labels: [],
};

describe('the tracker of a harness hook', () => {
  it('reports a skipped read to stderr as "warning: <text>", and writes nothing to stdout', async () => {
    // `gh pr view` answers; the GraphQL query for the body edit time fails, which the tracker skips with a warning.
    gh.run = fakeGh([
      { match: ['pr', 'view', '7'], stdout: JSON.stringify(PR_ROW) },
      { match: ['graphql'], code: 1, stderr: 'gh: Bad Gateway (HTTP 502)\n' },
    ]);
    const out: string[] = [];
    const err: string[] = [];
    buildProgram({ out: text => out.push(text), err: text => err.push(text) });
    const ctx = await (hook.makeContext as () => HookContext | Promise<HookContext>)();
    const stdout = vi.spyOn(process.stdout, 'write');

    try {
      const pr = await ctx.makeTracker(cfg, process.cwd()).getPr(7);

      expect(pr?.number).toBe(7);
      expect(err).toHaveLength(1);
      expect(err[0]).toMatch(/^warning: could not read when the body of PR #7 was last edited \(.*502/);
      expect(out).toEqual([]);
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });
});
