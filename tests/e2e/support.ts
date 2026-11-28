import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { CommandContext } from '../../src/commands/context.js';
import { loadConfig, type Config } from '../../src/config/schema.js';
import { defaultGhRunner, GhError, ghJson, ghText, type GhRunner } from '../../src/github/gh.js';
import { ensureBoard } from '../../src/github/board.js';
import { GitHubTracker, type GitHubTrackerOptions } from '../../src/github/githubTracker.js';
import { ensureLabels } from '../../src/install/provision.js';

/** The label on every issue the suite opens; `afterAll` closes the open ones that carry it. */
export const E2E_LABEL = 'e2e';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const sleepFor = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** What the environment asks for; see CONTRIBUTING.md. */
export interface E2eEnv {
  /** `SDLC_E2E_REPO`: the sandbox repository, `owner/name`. */
  repo: string;
  /** `SDLC_E2E_PROJECT_OWNER`: the login that owns the project; the repository's owner by default. */
  projectOwner: string;
  /** `SDLC_E2E_PROJECT`: an existing project number; without it the suite creates a user project. */
  project?: number;
}

/** The suite's settings, `undefined` without `SDLC_E2E_REPO`: every e2e test is then skipped. */
export function readE2eEnv(env: NodeJS.ProcessEnv = process.env): E2eEnv | undefined {
  const repo = env.SDLC_E2E_REPO?.trim();
  if (!repo) return undefined;
  if (!REPO.test(repo)) throw new Error(`SDLC_E2E_REPO must be "owner/name", got "${repo}"`);
  const projectText = env.SDLC_E2E_PROJECT?.trim();
  if (projectText && !/^[1-9]\d*$/.test(projectText)) {
    throw new Error(`SDLC_E2E_PROJECT must be a project number such as 3, got "${projectText}"`);
  }
  return {
    repo,
    projectOwner: env.SDLC_E2E_PROJECT_OWNER?.trim() || (repo.split('/')[0] as string),
    ...(projectText ? { project: Number(projectText) } : {}),
  };
}

/** The repositories a `gh` argument list names, lowercase: `--repo X`, `-R X`, `--repo=X` and `repos/X/...`. */
export function namedRepos(args: readonly string[]): string[] {
  const names: string[] = [];
  args.forEach((arg, i) => {
    const flag = arg === '--repo' || arg === '-R' ? args[i + 1] : arg.startsWith('--repo=') ? arg.slice('--repo='.length) : undefined;
    if (flag) names.push(flag.toLowerCase());
    const endpoint = /^repos\/([^/?]+\/[^/?]+)/.exec(arg);
    if (endpoint) names.push((endpoint[1] as string).toLowerCase());
  });
  return names;
}

/**
 * A runner that refuses any call naming a repository other than the sandbox, so a code path that
 * strayed (a missing `--repo`, a hard-coded repository) fails the suite instead of writing elsewhere.
 * Calls that name none (GraphQL, `gh api user`, `gh project ...`) pass through.
 */
export function sandboxRunner(repo: string, inner: GhRunner = defaultGhRunner): GhRunner {
  const sandbox = repo.toLowerCase();
  return (args, input) => {
    const stray = namedRepos(args).find(name => name !== sandbox);
    if (stray !== undefined) {
      return Promise.reject(new Error(`e2e guard: refusing a gh call on ${stray}; the sandbox is ${repo}`));
    }
    return inner(args, input);
  };
}

/** The tracker of the suite: every issue it opens carries the `e2e` label, and its number is remembered. */
export class E2eTracker extends GitHubTracker {
  constructor(
    run: GhRunner,
    cfg: Config,
    options: GitHubTrackerOptions,
    private readonly onCreated: (issue: number) => void,
  ) {
    super(run, cfg, options);
  }

  override async createIssue(title: string, body: string, labels: string[]): Promise<{ number: number; url: string }> {
    const created = await super.createIssue(title, body, [...labels, E2E_LABEL]);
    this.onCreated(created.number);
    return created;
  }
}

export interface IssueView {
  state: string;
  stateReason: string | null;
  title: string;
  labels: string[];
}

export interface BoardItem {
  title: string;
  /** The item's `Status` value as `gh project item-list` prints it. */
  status: string | undefined;
}

export interface Sandbox {
  repo: string;
  /** The login `gh` is authenticated as: the owner and the tool's own login in the config. */
  login: string;
  /** Marks every title the suite writes, so its issues can be told apart from anybody else's. */
  titlePrefix: string;
  run: GhRunner;
  cfg: Config;
  ctx: CommandContext;
  /** A scratch directory for the suite's files; removed by `cleanup`. */
  dir: string;
  projectOwner: string;
  projectNumber: number;
  /** Warnings the tracker raised (it only warns about reads it skipped). */
  warnings: string[];
  issueView(issue: number): Promise<IssueView>;
  /** The board item whose title is `title`, `undefined` when the board has none. */
  boardItem(title: string): Promise<BoardItem | undefined>;
  /** Posts `body` as the logged-in user, as an owner would, and returns the comment's URL. */
  commentOn(issue: number, body: string): Promise<string>;
  /** Waits, for the clock of GitHub, which stamps comments to the second. */
  pause(ms?: number): Promise<void>;
  /** Closes the open issues the suite opened and removes the scratch directory; never deletes the repository or the project. */
  cleanup(): Promise<void>;
}

async function createLabel(run: GhRunner, repo: string): Promise<void> {
  const args = ['label', 'create', E2E_LABEL, '--repo', repo, '--color', 'ededed', '--description', 'Opened by the sdlc e2e suite'];
  const result = await run(args);
  if (result.code !== 0 && !/already exists/i.test(result.stderr)) throw new GhError(args, result.stderr);
}

/** Creates a user or organization project the suite owns, and says so loudly: the number is what to delete. */
async function createProject(run: GhRunner, owner: string, runId: string): Promise<number> {
  const title = `sdlc-e2e-${runId}`;
  const created = await ghJson<{ number?: number; url?: string }>(run, [
    'project', 'create', '--owner', owner, '--title', title, '--format', 'json',
  ]);
  if (typeof created?.number !== 'number') throw new Error('gh project create did not return a project number');
  console.log(`e2e: created project #${created.number} "${title}" for ${owner}${created.url ? ` (${created.url})` : ''}; delete it when you are done`);
  return created.number;
}

/**
 * Sets the sandbox up: reads who is logged in, creates the project when none is given, writes the
 * config (observe mode, the login as the only owner, task types `tooling` and `spike`) and makes
 * sure the labels and the board fields exist. Everything is written to the sandbox repository and
 * to the one project, and nowhere else.
 */
export async function createSandbox(env: E2eEnv): Promise<Sandbox> {
  const run = sandboxRunner(env.repo);
  const runId = randomBytes(4).toString('hex');
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-e2e-'));
  const opened: number[] = [];
  const titlePrefix = `sdlc-e2e-${runId}`;
  try {
    const login = (await ghText(run, ['api', 'user', '-q', '.login'])).trim();
    if (!login) throw new Error('gh is not logged in: run "gh auth login"');
    const ownerKind = (await ghText(run, ['api', `users/${env.projectOwner}`, '-q', '.type'])).trim();
    const projectNumber = env.project ?? (await createProject(run, env.projectOwner, runId));

    const configPath = join(dir, 'sdlc.config.yaml');
    writeFileSync(
      configPath,
      stringify({
        version: 1,
        harnesses: ['claude'],
        mode: 'observe',
        github: {
          repo: env.repo,
          default_branch: 'main',
          project: { owner: env.projectOwner, owner_type: ownerKind === 'Organization' ? 'org' : 'user', number: projectNumber },
        },
        owners: [login],
        task_types: { enabled: ['tooling', 'spike'] },
      }),
    );
    const cfg = loadConfig(configPath);

    await ensureLabels(run, cfg, { dryRun: false });
    await createLabel(run, env.repo);
    const board = await ensureBoard(run, cfg, { dryRun: false });
    for (const failure of board.viewsFailed) console.warn(`e2e: board view "${failure.name}" was not created: ${failure.error}`);

    const warnings: string[] = [];
    // `repoRoot` is the scratch directory, so the field-id cache lands there and not in the working tree.
    const tracker = new E2eTracker(run, cfg, { repoRoot: dir, warn: text => warnings.push(text) }, issue => void opened.push(issue));
    const ctx: CommandContext = {
      tracker,
      cfg,
      now: () => new Date().toISOString(),
      out: () => undefined,
      err: text => warnings.push(text),
    };

    const view = async (issue: number): Promise<IssueView> => {
      const row = await ghJson<{ state: string; stateReason?: string | null; title: string; labels: { name: string }[] }>(run, [
        'issue', 'view', String(issue), '--repo', env.repo, '--json', 'state,stateReason,title,labels',
      ]);
      return { state: row.state, stateReason: row.stateReason ?? null, title: row.title, labels: row.labels.map(label => label.name) };
    };

    return {
      repo: env.repo,
      login,
      titlePrefix,
      run,
      cfg,
      ctx,
      dir,
      projectOwner: env.projectOwner,
      projectNumber,
      warnings,
      issueView: view,
      async boardItem(title) {
        const list = await ghJson<{ items?: { title?: string; content?: { title?: string }; [field: string]: unknown }[] }>(run, [
          'project', 'item-list', String(projectNumber), '--owner', env.projectOwner, '--limit', '500', '--format', 'json',
        ]);
        const item = (list?.items ?? []).find(candidate => (candidate.content?.title ?? candidate.title) === title);
        if (!item) return undefined;
        const key = Object.keys(item).find(name => name.toLowerCase() === 'status');
        const status = key === undefined ? undefined : item[key];
        return { title, status: typeof status === 'string' ? status : undefined };
      },
      async commentOn(issue, body) {
        const url = (await ghText(run, ['issue', 'comment', String(issue), '--repo', env.repo, '--body', body])).trim();
        if (!/#issuecomment-\d+$/.test(url)) throw new Error(`gh issue comment did not print the comment URL: "${url}"`);
        return url;
      },
      pause: (ms = 2000) => sleepFor(ms),
      async cleanup() {
        try {
          // The issues whose creation this run saw, plus any open `e2e` issue of this run whose creation
          // finished on GitHub but not here (the call failed after the issue existed).
          const strays = await ghJson<{ number: number; title: string }[] | undefined>(run, [
            'issue', 'list', '--repo', env.repo, '--label', E2E_LABEL, '--state', 'open', '--json', 'number,title', '--limit', '100',
          ]);
          const numbers = new Set([...opened, ...(strays ?? []).filter(row => row.title.startsWith(titlePrefix)).map(row => row.number)]);
          for (const issue of numbers) {
            if ((await view(issue)).state.toUpperCase() !== 'OPEN') continue;
            await ghText(run, ['issue', 'close', String(issue), '--repo', env.repo, '--reason', 'not planned']);
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
