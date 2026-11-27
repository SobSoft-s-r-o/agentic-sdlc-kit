import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { basename, join } from 'node:path';
import { Document, isMap, isScalar, visit } from 'yaml';
import type { Harness } from '../config/schema.js';
import { BUILTIN_TYPES } from '../core/taskTypes.js';
import { ghJson, ghText, type GhRunner } from '../github/gh.js';

/** What `detectConfig` knows about a repository; `probeRepo` collects it. */
export interface RepoProbe {
  /** `owner/name`. */
  repo: string;
  defaultBranch: string;
  ownerType: 'org' | 'user';
  /** The GitHub login `gh` is authenticated as. */
  login: string;
  /** Repo-relative paths (files and directories) to depth 3; `.git` and `node_modules` are skipped. */
  files: string[];
  workflowEnvironments: Array<{ workflow: string; environment: string }>;
  packageScripts: Record<string, string>;
}

export interface DetectedConfig {
  /** A complete `sdlc.config.yaml` that passes `loadConfigFromString`. */
  yaml: string;
  /** What the owner should look at or decide; kept out of the YAML. */
  notes: string[];
}

const NO_HARNESS_NOTE = 'no harness files found; defaulting to claude';
const AGENTS_MD_NOTE = 'AGENTS.md found: choose codex or agents-md';
const NO_TARGETS_NOTE = 'no deploy targets detected; feature/bugfix disabled until you add a target';
/** The script `npm init` writes; running it only fails. */
const NPM_PLACEHOLDER_TEST = /no test specified/i;

const DEPLOY_ENDING_TYPES = ['feature', 'bugfix'];

interface TargetSuggestion {
  name: string;
  environment: string;
  deploy: { via: 'actions'; workflow: string };
}

const stripSlashes = (path: string): string => path.replace(/\/+$/, '');

function detectHarnesses(files: string[], notes: string[]): Harness[] {
  const paths = files.map(stripSlashes);
  const hasFile = (name: string): boolean => paths.includes(name);
  const inDir = (dir: string): boolean => paths.some(p => p === dir || p.startsWith(`${dir}/`));

  const harnesses: Harness[] = [];
  if (hasFile('CLAUDE.md')) harnesses.push('claude');
  if (inDir('.codex') || hasFile('AGENTS.md')) harnesses.push('codex');
  if (hasFile('GEMINI.md')) harnesses.push('gemini');
  if (hasFile('AGENTS.md')) notes.push(AGENTS_MD_NOTE);
  if (harnesses.length === 0) {
    harnesses.push('claude');
    notes.push(NO_HARNESS_NOTE);
  }
  return harnesses;
}

/** Lowercase kebab-case; empty when nothing usable is left. */
const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const workflowStem = (workflow: string): string => basename(workflow).replace(/\.ya?ml$/i, '');
const isDeployWorkflow = (workflow: string): boolean => /^deploy/i.test(workflowStem(workflow));

/**
 * One target per environment, in the order the environments first appear. An environment used by
 * several workflows goes to the deploy workflow when there is one, else the first. The name is the
 * workflow file name without `deploy-`, else the environment name; a name already taken falls back
 * to the environment name, then gets a number.
 */
function deriveTargets(
  entries: RepoProbe['workflowEnvironments'],
  notes: string[],
): TargetSuggestion[] {
  const workflowsByEnvironment = new Map<string, string[]>();
  for (const { workflow, environment } of entries) {
    const workflows = workflowsByEnvironment.get(environment) ?? [];
    if (!workflows.includes(workflow)) workflows.push(workflow);
    workflowsByEnvironment.set(environment, workflows);
  }

  const taken = new Set<string>();
  const targets: TargetSuggestion[] = [];
  for (const [environment, workflows] of workflowsByEnvironment) {
    const workflow = workflows.find(isDeployWorkflow) ?? workflows[0];
    if (workflows.length > 1) {
      notes.push(
        `environment "${environment}" is used by several workflows (${workflows.join(', ')}); using ${workflow}`,
      );
    }

    const stem = workflowStem(workflow);
    const fromWorkflow = /^deploy-/i.test(stem) ? slugify(stem.slice('deploy-'.length)) : '';
    const candidates = [fromWorkflow, slugify(environment)].filter(name => name !== '');
    let name = candidates.find(candidate => !taken.has(candidate));
    if (name === undefined) {
      const base = candidates[0] ?? 'target';
      let n = 2;
      while (taken.has(`${base}-${n}`)) n += 1;
      name = `${base}-${n}`;
    }
    taken.add(name);
    targets.push({ name, environment, deploy: { via: 'actions', workflow } });
  }
  return targets;
}

/** Suggests a `sdlc.config.yaml` from what the repository already has. Pure. */
export function detectConfig(probe: RepoProbe): DetectedConfig {
  const notes: string[] = [];
  const harnesses = detectHarnesses(probe.files, notes);
  const targets = deriveTargets(probe.workflowEnvironments, notes);

  const testScript = probe.packageScripts.test;
  const qualityGate = testScript !== undefined && !NPM_PLACEHOLDER_TEST.test(testScript) ? ['npm test'] : [];

  let enabled = BUILTIN_TYPES.map(type => type.id);
  if (targets.length === 0) {
    enabled = enabled.filter(id => !DEPLOY_ENDING_TYPES.includes(id));
    notes.push(NO_TARGETS_NOTE);
  }

  const [owner = probe.login] = probe.repo.split('/');
  const document = new Document({
    version: 1,
    harnesses,
    mode: 'observe',
    github: {
      repo: probe.repo,
      default_branch: probe.defaultBranch,
      project: { owner, owner_type: probe.ownerType },
    },
    owners: [probe.login],
    agents: [],
    merge_policy: 'owner_only',
    quality_gate: qualityGate,
    task_types: { enabled, custom: [] },
    targets,
  });
  document.commentBefore = ' Suggested by "sdlc config suggest". Review every value, then run "sdlc config validate".';
  visit(document, {
    Seq(_key, node) {
      if (node.items.every(item => isScalar(item))) node.flow = true;
    },
    Pair(_key, pair) {
      if (isScalar(pair.key) && (pair.key.value === 'project' || pair.key.value === 'deploy') && isMap(pair.value)) {
        pair.value.flow = true;
      }
    },
  });
  return { yaml: document.toString({ lineWidth: 0, flowCollectionPadding: false }), notes };
}

/** The value of a YAML scalar: quotes removed, trailing comment dropped; `undefined` for an expression or nothing. */
function scalarValue(raw: string): string | undefined {
  const text = raw.trim();
  const quoted = /^(["'])(.*?)\1/.exec(text);
  const value = quoted ? quoted[2] : text.replace(/\s+#.*$/, '').trim();
  return value === '' || value.includes('${{') ? undefined : value;
}

/**
 * The GitHub environment names a workflow's text mentions after `environment:`, as a scalar, as
 * `name:` of a block mapping, or inside a flow mapping. A line scan, not a YAML parse: it does not
 * tell a job's environment from an action input of the same name. Expressions are skipped.
 */
export function scanWorkflowEnvironments(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const found: string[] = [];
  lines.forEach((line, i) => {
    const match = /^(\s*)environment:\s*(.*)$/.exec(line);
    if (!match) return;
    const indent = match[1].length;
    const rest = match[2].trim();

    let name: string | undefined;
    if (rest === '' || rest.startsWith('#')) {
      for (const next of lines.slice(i + 1)) {
        const trimmed = next.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        if (next.length - next.trimStart().length <= indent) break;
        const nameLine = /^\s*name:\s*(.*)$/.exec(next);
        if (nameLine) {
          name = scalarValue(nameLine[1]);
          break;
        }
      }
    } else if (rest.startsWith('{')) {
      const inline = /\bname:\s*("[^"]*"|'[^']*'|[^,}#]+)/.exec(rest);
      name = inline ? scalarValue(inline[1]) : undefined;
    } else {
      name = scalarValue(rest);
    }
    if (name !== undefined && !found.includes(name)) found.push(name);
  });
  return found;
}

const MAX_DEPTH = 3;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);

/** Files and directories below `root`, at most `MAX_DEPTH` path segments deep; symlinks are listed, not followed. */
function listFiles(root: string): string[] {
  const paths: string[] = [];
  const walk = (relative: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      paths.push(path);
      if (entry.isDirectory() && depth < MAX_DEPTH) walk(path, depth + 1);
    }
  };
  walk('', 1);
  return paths;
}

const WORKFLOWS_DIR = '.github/workflows';

function readWorkflowEnvironments(root: string): RepoProbe['workflowEnvironments'] {
  let names: string[];
  try {
    names = readdirSync(join(root, WORKFLOWS_DIR)).filter(name => /\.ya?ml$/i.test(name)).sort();
  } catch {
    return [];
  }
  const result: RepoProbe['workflowEnvironments'] = [];
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(root, WORKFLOWS_DIR, name), 'utf8');
    } catch {
      continue;
    }
    for (const environment of scanWorkflowEnvironments(text)) {
      result.push({ workflow: `${WORKFLOWS_DIR}/${name}`, environment });
    }
  }
  return result;
}

function readPackageScripts(root: string): Record<string, string> {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: unknown };
    const scripts = manifest.scripts;
    if (typeof scripts !== 'object' || scripts === null) return {};
    return Object.fromEntries(
      Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
}

interface RepoView {
  nameWithOwner?: string;
  defaultBranchRef?: { name?: string } | null;
  isInOrganization?: boolean;
}

/**
 * Reads what `detectConfig` needs: the repository and the authenticated login from `gh` (the
 * repository `gh` finds from the current directory), the file tree, the workflows' environments
 * and the `package.json` scripts from `root`. Read-only.
 */
export async function probeRepo(run: GhRunner, root: string): Promise<RepoProbe> {
  const view = await ghJson<RepoView | undefined>(run, [
    'repo',
    'view',
    '--json',
    'nameWithOwner,defaultBranchRef,owner,isInOrganization',
  ]);
  if (!view?.nameWithOwner) throw new Error('gh repo view returned no repository name');
  const login = (await ghText(run, ['api', 'user', '--jq', '.login'])).trim();

  return {
    repo: view.nameWithOwner,
    defaultBranch: view.defaultBranchRef?.name || 'main',
    ownerType: view.isInOrganization ? 'org' : 'user',
    login,
    files: listFiles(root),
    workflowEnvironments: readWorkflowEnvironments(root),
    packageScripts: readPackageScripts(root),
  };
}
