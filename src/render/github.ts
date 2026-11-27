import type { Config } from '../config/schema.js';
import type { Change } from './changes.js';
import type { RenderData } from './instructions.js';
import { renderTemplate } from './template.js';
import { loadTemplate } from './templates.js';

const PR_TEMPLATE_PATH = '.github/pull_request_template.md';
const WORKFLOW_PATH = '.github/workflows/sdlc-reconcile.yml';

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
