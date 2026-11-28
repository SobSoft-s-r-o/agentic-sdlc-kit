import { posix } from 'node:path';
import type { Config } from '../config/schema.js';
import { editsAllowed } from '../core/edits.js';
import type { GapRule, TaskState, TaskTypeDef } from '../core/types.js';
import type { HookOutcome, ToolCall } from './types.js';

export type HookMode = Config['mode'];

/** A rule an agent broke, as the hook found it. The text is what the agent is told. */
export interface Violation {
  rule: GapRule;
  text: string;
}

/**
 * The subagent rule: a dispatch names a role, and either names a model or uses a rendered
 * `sdlc-<role>` agent, whose file pins the model.
 */
export function subagentViolation(tool: Extract<ToolCall, { category: 'subagent' }>): Violation | undefined {
  const role = tool.role?.trim();
  if (!role) {
    return { rule: 'subagent-role', text: 'subagent dispatch needs a role: use an sdlc-<role> agent' };
  }
  if (role.startsWith('sdlc-') || tool.model?.trim()) return undefined;
  return {
    rule: 'subagent-tier',
    text: `subagent ${role} needs a model tier: pass a model or use an sdlc-<role> agent`,
  };
}

/** One edited file, resolved by the hook entrypoint before the edit rule looks at it. */
export interface PathCheck {
  /** Absolute path of the file. */
  path: string;
  /** The file is in this repository or one of its worktrees. */
  inProject: boolean;
  /** Path relative to the root of the checkout that holds the file; set when `inProject`. */
  relPath?: string;
  /** The task issue of that checkout's branch, when it names one. */
  issue?: number;
  branch?: string;
  /** `ok`: the task was read; `none`: there is no tracked task; `failed`: reading it failed. */
  lookup: 'ok' | 'none' | 'failed';
  state?: TaskState;
  type?: TaskTypeDef;
}

/** Normalized for matching: forward slashes, no `./` or `..` segments. Case is kept. */
const normalizePath = (relPath: string): string => posix.normalize(relPath.replace(/\\/g, '/'));

/**
 * `sdlc.config.yaml` and everything under `.sdlc/` except `.sdlc/agents/custom/`. Matched without
 * regard to case, since the default macOS filesystem would open the same file.
 */
function isProtectedPath(relPath: string): boolean {
  const path = normalizePath(relPath).toLowerCase();
  return path === 'sdlc.config.yaml' || (path.startsWith('.sdlc/') && !path.startsWith('.sdlc/agents/custom/'));
}

/** Files that never need a task: anything under `docs/` and any Markdown file. */
function isDocsPath(relPath: string): boolean {
  const path = normalizePath(relPath);
  return path.startsWith('docs/') || /\.md$/i.test(path);
}

/**
 * The edit rule, per edited file, in this order:
 * 1. a file outside the project is not ours to police;
 * 2. a protected file (`isProtectedPath`) is a `protected-path` violation in enforce and nothing in
 *    observe; either way the checks below do not apply to it;
 * 3. `docs/**` and `*.md` need no task;
 * 4. no issue, or no tracked task for it, is `no-task`;
 * 5. a failed task lookup is a warning, never a violation: the edit is allowed;
 * 6. otherwise `editsAllowed` decides.
 * Identical violations and warnings across files appear once.
 */
export function editViolations(
  checks: PathCheck[],
  mode: HookMode,
): { violations: Violation[]; warnings: string[] } {
  const violations = new Map<string, Violation>();
  const warnings = new Set<string>();
  const add = (v: Violation): void => void violations.set(`${v.rule}:${v.text}`, v);

  for (const check of checks) {
    if (!check.inProject) continue;
    const relPath = check.relPath ?? check.path;

    if (isProtectedPath(relPath)) {
      if (mode === 'enforce') {
        add({
          rule: 'protected-path',
          text: `${relPath} is protected: only the owner changes sdlc.config.yaml and .sdlc/ (except .sdlc/agents/custom/); ask the owner`,
        });
      }
      continue;
    }
    if (isDocsPath(relPath)) continue;

    if (check.issue === undefined || check.lookup === 'none') {
      const where = check.branch === undefined ? '' : ` (current branch: ${check.branch})`;
      add({
        rule: 'no-task',
        text: `editing ${relPath} outside a task: create one with \`sdlc task new\` and work in its worktree${where}`,
      });
    } else if (check.lookup === 'failed') {
      warnings.add(`could not read task #${check.issue}; edit allowed`);
    } else if (check.state !== undefined && check.type !== undefined) {
      const verdict = editsAllowed(check.state, check.type);
      if (!verdict.allowed) add({ rule: verdict.rule, text: verdict.text });
    }
  }
  return { violations: [...violations.values()], warnings: [...warnings] };
}

/**
 * What the hook does about the violations it found. Enforce blocks on the first one. Observe
 * warns about every one and blocks nothing, except `hook-spoof`, which blocks in both modes.
 * `harnessWarnings` (a failed task lookup, say) are appended to the warnings either way.
 */
export function decide(violations: Violation[], mode: HookMode, harnessWarnings: string[] = []): HookOutcome {
  const blocking = mode === 'enforce' ? violations[0] : violations.find(v => v.rule === 'hook-spoof');
  const warnings = [
    ...(mode === 'observe' ? violations.map(v => `sdlc (observe): ${v.text}`) : []),
    ...harnessWarnings.map(w => `sdlc: ${w}`),
  ];
  return {
    ...(blocking === undefined ? {} : { block: `sdlc (${mode}): ${blocking.text}` }),
    context: [],
    warnings,
  };
}
