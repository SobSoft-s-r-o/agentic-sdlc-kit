import type { GhRunner } from '../../src/github/gh.js';

export interface FakeGhStep {
  /** Strings that must all appear among the call's args, in any position or order. */
  match: string[];
  stdout?: string;
  code?: number;
  stderr?: string;
}

export type FakeGh = GhRunner & {
  /** The args of every call so far, matched or not. */
  calls: string[][];
  /** The stdin passed with every call so far (`undefined` when none). */
  inputs: (string | undefined)[];
};

/**
 * A scripted `GhRunner`: the n-th call is answered by the n-th step. A call that does not match
 * its step, or comes after the script ran out, rejects with an Error listing its args.
 */
export function fakeGh(script: FakeGhStep[]): FakeGh {
  const calls: string[][] = [];
  const inputs: (string | undefined)[] = [];

  const run = async (args: string[], input?: string) => {
    const index = calls.length;
    calls.push(args);
    inputs.push(input);
    const step = script[index];
    if (!step) {
      throw new Error(`unexpected gh call #${index + 1} (script has ${script.length}): ${args.join(' ')}`);
    }
    if (!step.match.every(token => args.includes(token))) {
      throw new Error(
        `gh call #${index + 1} does not match [${step.match.join(', ')}]: ${args.join(' ')}`,
      );
    }
    return { stdout: step.stdout ?? '', code: step.code ?? 0, stderr: step.stderr ?? '' };
  };

  return Object.assign(run, { calls, inputs });
}

/** The `gh` arguments of reading every label of `repo`, as `ensureLabels` (and `sdlc doctor`) make the call. */
export const labelListArgs = (repo = 'acme/shop'): string[] => [
  'api', `repos/${repo}/labels?per_page=100`, '--paginate', '--jq', '.[].name',
];

/** The answer to `labelListArgs`: `--jq '.[].name'` prints one label name per line, across all pages. */
export function labelListStep(names: readonly string[], repo = 'acme/shop'): FakeGhStep {
  return { match: ['api', `repos/${repo}/labels?per_page=100`, '--paginate'], stdout: names.map(name => `${name}\n`).join('') };
}
