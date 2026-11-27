import type { Config } from '../config/schema.js';
import type { Change } from './changes.js';
import type { RenderData } from './instructions.js';
import { renderTemplate } from './template.js';
import { loadTemplate } from './templates.js';

const PR_TEMPLATE_PATH = '.github/pull_request_template.md';
export const WORKFLOW_PATH = '.github/workflows/sdlc-reconcile.yml';
/** Where the hook scripts go; `core.hooksPath` is set to it (`HOOKS_PATH` in install/provision.ts, which a test keeps equal). */
const HOOKS_DIR = '.sdlc/githooks';

function renderFile(path: string, template: string, data: Record<string, unknown>): Change {
  return { kind: 'file', path, content: renderTemplate(loadTemplate(template), data, template) };
}

/**
 * The lines the kit keeps out of git, inside the `# sdlc:begin` / `# sdlc:end` block of
 * `.gitignore`. `!.env.example` must stay after `.env.*`, or the example file would be ignored too.
 */
function gitignoreLines(cfg: Config): string[] {
  return [
    '.sdlc/cache/',
    // The instructions tell agents to create their worktrees here.
    '.worktrees/',
    '.env',
    '.env.*',
    '!.env.example',
    ...(cfg.stack.graphify ? ['graphify-out/'] : []),
  ];
}

/**
 * The GitHub-side files: the PR template (always), the reconcile workflow (with `stack.actions`)
 * and the managed `.gitignore` block. The PR template pre-lists every configured target on its
 * `Targets:` line; the author deletes the ones the PR does not deploy.
 */
export function renderGithub(cfg: Config, data: RenderData): Change[] {
  const templateData = { ...data, targetsText: data.targets.map(target => target.name).join(', ') };
  const changes: Change[] = [renderFile(PR_TEMPLATE_PATH, 'github/pull_request_template.md', templateData)];
  if (cfg.stack.actions) changes.push(renderFile(WORKFLOW_PATH, 'github/sdlc-reconcile.yml', templateData));
  changes.push({ kind: 'line-block', path: '.gitignore', content: gitignoreLines(cfg).join('\n'), comment: '#' });
  return changes;
}

/** The git hooks, in the order `git` is likely to run them. */
const GIT_HOOKS = ['pre-commit', 'pre-push', 'post-merge', 'post-checkout'] as const;

/** The hooks that carry the secret guard: when sdlc is missing, they say the guard is off. */
const GUARDED_HOOKS: ReadonlySet<string> = new Set(['pre-commit', 'pre-push']);

/**
 * The four git hook scripts at `.sdlc/githooks/<name>` (mode 0755; `core.hooksPath` points there).
 * Each one hands over to `sdlc githook <name>`, or skips with a notice when sdlc is not installed,
 * so a missing install never blocks a commit.
 */
export function renderGitHooks(): Change[] {
  return GIT_HOOKS.map(
    (name): Change => ({
      kind: 'file',
      path: `${HOOKS_DIR}/${name}`,
      content: renderTemplate(loadTemplate('githooks/hook.sh'), { name, guard: GUARDED_HOOKS.has(name) }, 'githooks/hook.sh'),
      mode: 0o755,
    }),
  );
}
