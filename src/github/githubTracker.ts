import type { Config } from '../config/schema.js';
import { parsePrBody } from '../core/prBody.js';
import type { BoardFields } from '../core/projection.js';
import {
  parseStateComment,
  renderStateComment,
  STATE_MARKER,
  StateCommentError,
} from '../core/stateComment.js';
import type { TaskState } from '../core/types.js';
import {
  NoStateCommentError,
  StateChangedError,
  type DeploymentInfo,
  type ExpectedStateComment,
  type IssueComment,
  type IssueInfo,
  type PostedComment,
  type PrInfo,
  type ReleaseInfo,
  type ScanOptions,
  type TrackedTask,
  type TaskScan,
  type Tracker,
  type UntrackedIssue,
} from '../tracker/types.js';
import { trustedLogins } from '../core/trust.js';
import { BoardError, FIELD_NAMES, resolveFieldIds, type FieldMap } from './board.js';
import { GhError, ghJson, ghText, graphql, type GhRunner } from './gh.js';

/** What `gh api` prints when GitHub refuses to edit a comment: not the author's, or no longer there. */
const EDIT_REFUSED = /\bHTTP (?:403|404)\b/;
/** A 403 that is GitHub throttling, not refusing: posting a new comment instead would duplicate it. */
const RATE_LIMITED = /rate limit|secondary rate|abuse/i;
/** What `gh pr view` prints for a number that is not a pull request. */
const PR_NOT_FOUND = /could not resolve to a pullrequest|no pull requests? found/i;
/**
 * `gh issue list` and `gh pr list` cap their output; reaching the cap means results may be missing.
 * The closed list goes through GitHub's search, which serves at most 1000 results.
 */
const OPEN_ISSUE_LIMIT = 2000;
const CLOSED_ISSUE_LIMIT = 1000;
/** `scanTasks()` without a lookback: one query over open and closed issues. */
const ALL_ISSUE_LIMIT = 2000;
const PR_LIST_LIMIT = 100;
/** Largest page size of GitHub's REST list endpoints. */
const MAX_PER_PAGE = 100;
/** How many per-issue or per-deployment requests run at once. */
const FETCH_CONCURRENCY = 8;
/**
 * A deployment whose latest status is one of these has succeeded. GitHub marks a successful
 * deployment `inactive` once a later one to the same environment succeeds, and only adds that
 * status to deployments that had succeeded, so a past success stays visible.
 */
const SUCCEEDED = new Set(['success', 'inactive']);
/** Statuses read per deployment, newest first: the first decides success, the newest success gives the link. */
const RECENT_STATUSES = 10;
/** What a GraphQL write says when a field or option id no longer exists on the board. */
const STALE_ID_ERROR =
  /could not resolve to a node|\b(?:field|option)\b[^.\n]*\b(?:not found|does not exist|invalid|unknown)\b|\b(?:invalid|unknown)\b[^.\n]*\b(?:field|option)\b/i;

/** The board fields `syncFields` writes, in write order. */
const BOARD_FIELD_KEYS = Object.keys({
  status: 0,
  phase: 0,
  type: 0,
  waitingOn: 0,
  summary: 0,
  currentStep: 0,
  nextStep: 0,
  pendingTargets: 0,
  agent: 0,
  lastUpdate: 0,
} satisfies Record<keyof BoardFields, 0>) as (keyof BoardFields)[];

interface IssueRow {
  number: number;
  title: string;
  state: string;
  /** `COMPLETED`, `NOT_PLANNED`, `REOPENED`, or empty. */
  stateReason?: string | null;
}

const ISSUE_FIELDS = 'number,title,state,stateReason';

const CLOSE_REASONS: Record<string, 'completed' | 'not_planned'> = { COMPLETED: 'completed', NOT_PLANNED: 'not_planned' };

interface RestComment {
  id: number;
  html_url: string;
  user: { login: string } | null;
  body: string | null;
  created_at: string;
  /** Equals `created_at` until the comment is edited. */
  updated_at?: string;
}

interface PrRow {
  number: number;
  url: string;
  mergedAt: string | null;
  mergeCommit: { oid: string } | null;
  baseRefName: string;
  body: string | null;
}

interface DeploymentRow {
  id: number;
  sha: string;
  environment: string;
  url: string;
  created_at: string;
}

interface ReleaseRow {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
}

interface IssueBoard {
  issueId: string;
  projectId: string;
  /** The issue's item on the configured project, with its field values keyed by field id. */
  item?: { id: string; values: Map<string, string> };
}

interface BoardQueryData {
  repository: {
    issue: {
      id: string;
      projectItems: {
        pageInfo?: { hasNextPage: boolean };
        nodes: {
          id: string;
          project: { id: string };
          fieldValues: {
            pageInfo?: { hasNextPage: boolean };
            nodes: { text?: string; optionId?: string; field?: { id?: string } }[];
          };
        }[];
      };
    } | null;
  } | null;
  boardOwner: { projectV2: { id: string } | null } | null;
}

/** One board write: set a field value, or clear it. */
interface PlannedWrite {
  key: keyof BoardFields;
  clear: boolean;
  input: Record<string, unknown>;
}

export interface GitHubTrackerOptions {
  /** Directory holding `.sdlc/cache/` for board field ids; defaults to the git root of the working directory. */
  repoRoot?: string;
}

/**
 * The top-level JSON values of `text`. `gh api --paginate` prints either one stitched array or one
 * array per page, depending on its version; this reads both. Brackets inside strings are skipped.
 */
function jsonValues(text: string): string[] {
  const values: string[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '[' || char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === ']' || char === '}') {
      depth -= 1;
      if (depth < 0) throw new Error('unbalanced brackets');
      if (depth === 0) values.push(text.slice(start, i + 1));
    }
  }
  if (depth !== 0 || inString) throw new Error('output ends inside a JSON value');
  return values;
}

/** Every item of a REST list endpoint, across all pages. */
async function ghPaginated<T>(run: GhRunner, endpoint: string): Promise<T[]> {
  const args = ['api', '--paginate', endpoint];
  const text = await ghText(run, args);
  const items: T[] = [];
  try {
    for (const value of jsonValues(text)) {
      const page: unknown = JSON.parse(value);
      if (!Array.isArray(page)) throw new Error('a page is not a JSON array');
      for (const item of page as T[]) items.push(item);
    }
  } catch (error) {
    throw new GhError(args, '', `gh api --paginate ${endpoint} returned unusable JSON: ${(error as Error).message}`);
  }
  return items;
}

/** Applies `fn` to the items `size` at a time, keeping the order of the results. */
async function mapInChunks<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    for (const result of await Promise.all(items.slice(i, i + size).map(fn))) results.push(result);
  }
  return results;
}

function assertNotCut(count: number, limit: number, what: string): void {
  if (count >= limit) {
    throw new Error(`${what} returned ${count} results, its limit of ${limit}; some may be missing`);
  }
}

const isStateMarker = (comment: RestComment): boolean =>
  (comment.body ?? '').trimStart().startsWith(STATE_MARKER);

const updatedAt = (comment: RestComment): number => Date.parse(comment.updated_at ?? comment.created_at);

/**
 * The state comment: of the state-marker comments written by a trusted author (lowercase logins in
 * `trusted`), the one updated last, the newer id winning a tie. Anyone else's are ignored.
 */
function stateCommentOf(comments: RestComment[], trusted: ReadonlySet<string>): RestComment | undefined {
  let newest: RestComment | undefined;
  for (const c of comments) {
    if (!isStateMarker(c) || !trusted.has((c.user?.login ?? '').toLowerCase())) continue;
    if (!newest || updatedAt(c) > updatedAt(newest) || (updatedAt(c) === updatedAt(newest) && c.id > newest.id)) {
      newest = c;
    }
  }
  return newest;
}

function readState(comment: RestComment): TaskState {
  const state = parseStateComment(comment.body ?? '');
  if (!state) throw new StateCommentError('comment is not a state comment');
  return state;
}

const toIssueComment = (c: RestComment): IssueComment => ({
  id: String(c.id),
  url: c.html_url,
  author: c.user?.login ?? '',
  body: c.body ?? '',
  createdAt: c.created_at,
  updatedAt: c.updated_at ?? c.created_at,
});

const toPrInfo = (pr: PrRow): PrInfo => ({
  number: pr.number,
  url: pr.url,
  merged: pr.mergedAt !== null,
  ...(pr.mergeCommit && { mergeSha: pr.mergeCommit.oid }),
  ...(pr.mergedAt !== null && { mergedAt: pr.mergedAt }),
  baseRef: pr.baseRefName,
  body: pr.body ?? '',
});

interface DeploymentStatusRow {
  state: string;
  environment_url?: string;
  log_url?: string;
}

/**
 * The deployment with a link a person can open, never the REST API URL: the `environment_url` of
 * its newest success status, else that status's `log_url`, else the environment's page on GitHub.
 */
function toDeploymentInfo(d: DeploymentRow, repo: string, statuses: readonly DeploymentStatusRow[] = []): DeploymentInfo {
  const success = statuses.find(s => s.state === 'success');
  const url =
    success?.environment_url ||
    success?.log_url ||
    `https://github.com/${repo}/deployments/${encodeURIComponent(d.environment)}`;
  return { id: d.id, sha: d.sha, environment: d.environment, url, createdAt: d.created_at };
}

function findOption(options: Record<string, string>, value: string): string | undefined {
  const wanted = value.trim().toLowerCase();
  return Object.entries(options).find(([name]) => name.trim().toLowerCase() === wanted)?.[1];
}

function isStaleIdError(error: unknown): boolean {
  return error instanceof GhError && STALE_ID_ERROR.test(error.message);
}

/**
 * The `Tracker` backed by GitHub: issues and comments through `gh issue`/`gh pr`/`gh api`, the
 * Projects v2 board through `gh api graphql`. Every failed GitHub call rejects; nothing is retried
 * or swallowed except where noted on a method.
 */
export class GitHubTracker implements Tracker {
  private login: Promise<string | undefined> | undefined;

  constructor(
    private readonly run: GhRunner,
    private readonly cfg: Config,
    private readonly options: GitHubTrackerOptions = {},
  ) {}

  private get repo(): string {
    return this.cfg.github.repo;
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<{ number: number; url: string }> {
    const created = await this.send<{ number: number; html_url: string }>('POST', `repos/${this.repo}/issues`, {
      title,
      body,
      labels,
    });
    if (typeof created?.number !== 'number') throw new Error('GitHub did not return the created issue');
    return { number: created.number, url: created.html_url };
  }

  async addToBoard(issue: number): Promise<void> {
    const board = await this.loadIssueBoard(issue);
    if (!board.item) await this.addItem(board.projectId, board.issueId);
  }

  async listTrackedTasks(): Promise<TrackedTask[]> {
    return (await this.scanTasks()).tracked;
  }

  async listUntracked(): Promise<UntrackedIssue[]> {
    return (await this.scanTasks()).untracked;
  }

  async getTask(issue: number): Promise<TrackedTask> {
    const row = await ghJson<IssueRow>(this.run, [
      'issue', 'view', String(issue), '--repo', this.repo, '--json', ISSUE_FIELDS,
    ]);
    const comment = await this.findStateComment(issue);
    if (!comment) throw new NoStateCommentError(issue);
    return this.toTrackedTask(row, comment, readState(comment));
  }

  async getIssue(issue: number): Promise<IssueInfo> {
    const row = await ghJson<IssueRow & { url: string }>(this.run, [
      'issue', 'view', String(issue), '--repo', this.repo, '--json', 'number,title,url,state',
    ]);
    return { number: row.number, title: row.title, url: row.url, open: row.state.toUpperCase() === 'OPEN' };
  }

  /**
   * Patches the state comment. Posts a new one when the issue has none (or only an untrusted one),
   * or when GitHub refuses the edit with 403 or 404 (an owner's comment the token may not edit): the
   * new comment is then the newest, so it is the one read from now on. Any other failure rejects.
   * With `expected`, a state comment that is not the one read (another id, edited since, or with a
   * different body, which catches an edit within the same second) is a `StateChangedError` and
   * nothing is written.
   */
  async writeState(issue: number, state: TaskState, expected?: ExpectedStateComment): Promise<void> {
    const body = renderStateComment(state);
    const existing = await this.findStateComment(issue);
    if (
      expected &&
      (!existing ||
        String(existing.id) !== expected.id ||
        updatedAt(existing) !== Date.parse(expected.updatedAt) ||
        (existing.body ?? '').trim() !== expected.body.trim())
    ) {
      throw new StateChangedError(issue);
    }
    if (existing) {
      try {
        await this.send('PATCH', `repos/${this.repo}/issues/comments/${existing.id}`, { body });
        return;
      } catch (error) {
        if (!(error instanceof GhError && EDIT_REFUSED.test(error.stderr)) || RATE_LIMITED.test(error.stderr)) {
          throw error;
        }
      }
    }
    await this.send('POST', `repos/${this.repo}/issues/${issue}/comments`, { body });
  }

  async postComment(issue: number, body: string): Promise<PostedComment> {
    const created = await this.send<{ id: number; created_at: string }>(
      'POST',
      `repos/${this.repo}/issues/${issue}/comments`,
      { body },
    );
    if (typeof created?.id !== 'number' || typeof created.created_at !== 'string') {
      throw new Error('GitHub did not return the created comment');
    }
    return { id: String(created.id), createdAt: created.created_at };
  }

  /**
   * Works for issues and pull requests. GitHub's `since` filters on update time, so the creation
   * time is checked here too; sending `since` as well only saves pages, because a comment created
   * after it was also updated after it.
   */
  async listComments(issue: number, sinceIso?: string): Promise<IssueComment[]> {
    const since = sinceIso === undefined ? undefined : Date.parse(sinceIso);
    if (since !== undefined && Number.isNaN(since)) throw new Error(`Invalid since timestamp "${sinceIso}"`);
    const sinceParam = since === undefined ? '' : `&since=${encodeURIComponent(new Date(since).toISOString())}`;
    const rows = await ghPaginated<RestComment>(
      this.run,
      `repos/${this.repo}/issues/${issue}/comments?per_page=${MAX_PER_PAGE}${sinceParam}`,
    );
    return rows
      .filter(c => since === undefined || Date.parse(c.created_at) > since)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id)
      .map(toIssueComment);
  }

  async setIssueOpen(issue: number, open: boolean, reason?: 'completed' | 'not_planned'): Promise<void> {
    const change = open ? { state: 'open' } : { state: 'closed', ...(reason && { state_reason: reason }) };
    await this.send('PATCH', `repos/${this.repo}/issues/${issue}`, change);
  }

  /** Removes first, so a label named in both lists ends up added. Removing an absent label is not an error. */
  async setLabels(issue: number, add: string[], remove: string[]): Promise<void> {
    for (const label of remove) {
      try {
        await this.send('DELETE', `repos/${this.repo}/issues/${issue}/labels/${encodeURIComponent(label)}`);
      } catch (error) {
        if (!(error instanceof GhError && /label does not exist/i.test(error.stderr))) throw error;
      }
    }
    if (add.length > 0) await this.send('POST', `repos/${this.repo}/issues/${issue}/labels`, { labels: add });
  }

  /**
   * Writes the fields that differ from the board to the issue's project item, adding the issue to
   * the board first when it is not there. A field set to an empty string is cleared. When a write
   * names a field or option id that no longer exists, the cached ids are refreshed once and the
   * remaining writes are planned again.
   */
  async syncFields(issue: number, fields: BoardFields): Promise<void> {
    const idOptions = { repoRoot: this.options.repoRoot };
    let map = await resolveFieldIds(this.run, this.cfg, idOptions);
    const board = await this.loadIssueBoard(issue);
    const itemId = board.item?.id ?? (await this.addItem(board.projectId, board.issueId));
    // Values are only known for an item that was read; one just added may be an existing item.
    const current = board.item?.values;
    const plan = (keys: (keyof BoardFields)[]): PlannedWrite[] =>
      this.planWrites(keys, map, fields, current, board.projectId, itemId);

    let pending = plan(BOARD_FIELD_KEYS);
    let refreshed = false;
    while (pending.length > 0) {
      const [write, ...rest] = pending;
      try {
        await this.applyWrite(write);
        pending = rest;
      } catch (error) {
        if (refreshed || !isStaleIdError(error)) throw error;
        refreshed = true;
        map = await resolveFieldIds(this.run, this.cfg, { ...idOptions, refresh: true });
        pending = plan(BOARD_FIELD_KEYS.slice(BOARD_FIELD_KEYS.indexOf(write.key)));
      }
    }
  }

  /**
   * PRs whose body links the issue with `Related to #N`. The search can miss PRs; the body is
   * parsed again here because search also matches text that is not a link (closing keywords, `#120`).
   */
  async listTaskPrs(issue: number): Promise<PrInfo[]> {
    const rows =
      (await ghJson<PrRow[] | undefined>(this.run, [
        'pr', 'list', '--repo', this.repo, '--state', 'all',
        '--search', `"Related to #${issue}" in:body`,
        '--json', 'number,url,mergedAt,mergeCommit,baseRefName,body',
        '--limit', String(PR_LIST_LIMIT),
      ])) ?? [];
    assertNotCut(rows.length, PR_LIST_LIMIT, 'gh pr list');
    return rows
      .filter(pr => parsePrBody(pr.body ?? '').issues.includes(issue))
      .sort((a, b) => a.number - b.number)
      .map(toPrInfo);
  }

  /** `gh pr view`: no search index, so a PR opened seconds ago is found too. */
  async getPr(pr: number): Promise<PrInfo | undefined> {
    try {
      const row = await ghJson<PrRow>(this.run, [
        'pr', 'view', String(pr), '--repo', this.repo, '--json', 'number,url,mergedAt,mergeCommit,baseRefName,body',
      ]);
      return toPrInfo(row);
    } catch (error) {
      if (error instanceof GhError && PR_NOT_FOUND.test(error.stderr)) return undefined;
      throw error;
    }
  }

  /**
   * Looks at the newest `limit` deployments to `environment` (paging past GitHub's 100 per page
   * when needed) and returns those that succeeded, newest first.
   */
  async listSuccessfulDeployments(environment: string, limit: number): Promise<DeploymentInfo[]> {
    if (!(limit > 0)) return [];
    const perPage = Math.min(limit, MAX_PER_PAGE);
    const found: DeploymentInfo[] = [];
    let examined = 0;
    for (let page = 1; examined < limit; page += 1) {
      const rows =
        (await ghJson<DeploymentRow[] | undefined>(this.run, [
          'api',
          `repos/${this.repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=${perPage}` +
            (page > 1 ? `&page=${page}` : ''),
        ])) ?? [];
      const batch = rows.slice(0, limit - examined);
      const statuses = await mapInChunks(batch, FETCH_CONCURRENCY, d => this.recentStatuses(d.id));
      batch.forEach((deployment, i) => {
        const recent = statuses[i] ?? [];
        if (SUCCEEDED.has(recent[0]?.state ?? '')) found.push(toDeploymentInfo(deployment, this.repo, recent));
      });
      examined += batch.length;
      if (rows.length < perPage) break;
    }
    return found.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id);
  }

  /**
   * Looks through the newest releases (paging past GitHub's 100 per page when needed) until `limit`
   * published ones are found, skipping drafts and prereleases, and resolves each tag to its commit.
   */
  async listReleases(limit: number): Promise<ReleaseInfo[]> {
    if (!(limit > 0)) return [];
    const perPage = Math.min(limit, MAX_PER_PAGE);
    const published: (ReleaseRow & { published_at: string })[] = [];
    for (let page = 1; published.length < limit; page += 1) {
      const rows =
        (await ghJson<ReleaseRow[] | undefined>(this.run, [
          'api',
          `repos/${this.repo}/releases?per_page=${perPage}` + (page > 1 ? `&page=${page}` : ''),
        ])) ?? [];
      for (const row of rows) {
        if (!row.draft && !row.prerelease && row.published_at) {
          published.push({ ...row, published_at: row.published_at });
        }
      }
      if (rows.length < perPage) break;
    }
    const newest = published
      .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
      .slice(0, limit);
    const shas = await mapInChunks(newest, FETCH_CONCURRENCY, async row => {
      const tag = row.tag_name.split('/').map(encodeURIComponent).join('/');
      const sha = (await ghText(this.run, ['api', `repos/${this.repo}/commits/${tag}`, '--jq', '.sha'])).trim();
      if (!sha) throw new Error(`Could not resolve the tag "${row.tag_name}" to a commit`);
      return sha;
    });
    return newest.map((row, i) => ({
      tag: row.tag_name,
      sha: shas[i] as string,
      url: row.html_url,
      publishedAt: row.published_at,
    }));
  }

  /**
   * `a` is an ancestor of `b` when comparing `a...b` shows `b` ahead of `a` or identical. Only the
   * status is wanted, so the diff is cut to one commit and `--jq` keeps just that field.
   */
  async isAncestor(ancestorSha: string, descendantSha: string): Promise<boolean> {
    try {
      const status = await ghText(this.run, [
        'api',
        `repos/${this.repo}/compare/${ancestorSha}...${descendantSha}?per_page=1`,
        '--jq',
        '.status',
      ]);
      return status.trim() === 'ahead' || status.trim() === 'identical';
    } catch (error) {
      // Unrelated histories are not an error, just not ancestry; any other failure is.
      if (error instanceof GhError && /no common ancestor/i.test(error.stderr)) return false;
      throw error;
    }
  }

  async isOnDefaultBranch(sha: string): Promise<boolean> {
    const branch = this.cfg.github.defaultBranch.split('/').map(encodeURIComponent).join('/');
    const head = await ghJson<{ commit?: { sha?: string } } | undefined>(this.run, [
      'api',
      `repos/${this.repo}/branches/${branch}`,
    ]);
    const headSha = head?.commit?.sha;
    if (!headSha) throw new Error(`Could not read the head of branch "${this.cfg.github.defaultBranch}"`);
    return this.isAncestor(sha, headSha);
  }

  /** Creates the deployment without waiting for checks, then records it as successful. */
  async createDeployment(input: {
    environment: string;
    sha: string;
    target: string;
    description: string;
  }): Promise<DeploymentInfo> {
    const created = await this.send<DeploymentRow>('POST', `repos/${this.repo}/deployments`, {
      ref: input.sha,
      environment: input.environment,
      auto_merge: false,
      required_contexts: [],
      payload: { sdlc_target: input.target },
      description: input.description,
    });
    if (typeof created?.id !== 'number') {
      throw new Error(`GitHub did not create the deployment: ${JSON.stringify(created)}`);
    }
    let status: DeploymentStatusRow | undefined;
    try {
      status = await this.send<DeploymentStatusRow>('POST', `repos/${this.repo}/deployments/${created.id}/statuses`, {
        state: 'success',
      });
    } catch (error) {
      throw new Error(
        `Deployment ${created.id} was created but marking it successful failed: ${(error as Error).message}`,
        { cause: error },
      );
    }
    return toDeploymentInfo(created, this.repo, status ? [status] : []);
  }

  // --- internals -------------------------------------------------------------------------------

  /** A REST write through `gh api`, with `body` as the JSON request body. */
  private send<T = unknown>(
    method: 'POST' | 'PATCH' | 'DELETE',
    endpoint: string,
    body?: unknown,
  ): Promise<T> {
    const args = ['api', '-X', method, endpoint, ...(body === undefined ? [] : ['--input', '-'])];
    return ghJson<T>(this.run, args, body);
  }

  /**
   * The logins whose state comments are trusted, lowercase: the authenticated user, the configured
   * owners and agents, and the Actions bot. Owners and agents may run `sdlc` under different
   * logins, and each must see the state the other wrote.
   */
  private async trustedAuthors(): Promise<ReadonlySet<string>> {
    const login = await this.authenticatedLogin();
    return trustedLogins(this.cfg, login);
  }

  /**
   * The login the tool comments as, looked up once per instance. A token that may not read
   * `/user` (the Actions `GITHUB_TOKEN`) yields `undefined`: only the owners, the agents and the
   * Actions bot are then trusted. Any other failure is not remembered, so the next call looks again.
   */
  authenticatedLogin(): Promise<string | undefined> {
    if (!this.login) {
      const lookup = ghText(this.run, ['api', 'user', '-q', '.login']).then(
        text => text.trim() || undefined,
        (error: unknown) => {
          if (error instanceof GhError && /HTTP 403|not accessible by integration/i.test(error.stderr)) {
            return undefined;
          }
          throw error;
        },
      );
      this.login = lookup;
      lookup.catch(() => {
        if (this.login === lookup) this.login = undefined;
      });
    }
    return this.login;
  }

  private fetchComments(issue: number): Promise<RestComment[]> {
    return ghPaginated<RestComment>(this.run, `repos/${this.repo}/issues/${issue}/comments?per_page=${MAX_PER_PAGE}`);
  }

  private async findStateComment(issue: number): Promise<RestComment | undefined> {
    const trusted = await this.trustedAuthors();
    return stateCommentOf(await this.fetchComments(issue), trusted);
  }

  private toTrackedTask(row: IssueRow, comment: RestComment, state: TaskState): TrackedTask {
    const issueOpen = row.state.toUpperCase() === 'OPEN';
    const closeReason = issueOpen ? undefined : CLOSE_REASONS[(row.stateReason ?? '').toUpperCase()];
    return {
      issue: row.number,
      title: row.title,
      issueOpen,
      ...(closeReason && { closeReason }),
      state,
      stateCommentId: String(comment.id),
      stateCommentUpdatedAt: comment.updated_at ?? comment.created_at,
      stateCommentBody: comment.body ?? '',
    };
  }

  /**
   * Reads the comments of the `sdlc:task` issues and sorts the issues into tracked and untracked.
   *
   * With `closedSince` that is every open issue (limit 2000) and then the closed issues updated on
   * or after that date (limit 1000), two queries each asserted not cut. An issue in both (closed
   * between the two reads) counts once, as the closed, later snapshot.
   *
   * A closed issue not updated since before `closedSince` has nothing left to converge, by
   * construction: reopening it updates it, so it is read again; a deployment never reopens a done
   * task; and a task that is not done under an issue someone closed has that issue reopened (and
   * so updated) by the first reconcile run after. Running reconcile at least once per lookback
   * period therefore misses nothing. Without `closedSince`, one `--state all` query reads
   * everything (limit 2000), the way `--all` asks.
   */
  async scanTasks(opts: ScanOptions = {}): Promise<TaskScan> {
    const rows = await this.listTaskIssues(opts);
    const issues = [...rows].sort((a, b) => a.number - b.number);
    const tracked: TrackedTask[] = [];
    const untracked: UntrackedIssue[] = [];
    if (issues.length === 0) return { tracked, untracked };

    const trusted = await this.trustedAuthors();
    const stateComments = await mapInChunks(issues, FETCH_CONCURRENCY, async row =>
      stateCommentOf(await this.fetchComments(row.number), trusted),
    );
    issues.forEach((row, i) => {
      const comment = stateComments[i];
      if (!comment) {
        untracked.push({ issue: row.number, title: row.title, reason: 'missing state comment' });
        return;
      }
      try {
        tracked.push(this.toTrackedTask(row, comment, readState(comment)));
      } catch (error) {
        if (!(error instanceof StateCommentError)) throw error;
        untracked.push({ issue: row.number, title: row.title, reason: error.message });
      }
    });
    return { tracked, untracked };
  }

  /** The `sdlc:task` issues of a scan, by issue number; see `scanTasks` for what is read. */
  private async listTaskIssues({ closedSince }: ScanOptions): Promise<IssueRow[]> {
    const list = async (state: string, limit: number, search?: string): Promise<IssueRow[]> => {
      const rows =
        (await ghJson<IssueRow[] | undefined>(this.run, [
          'issue', 'list', '--repo', this.repo, '--label', 'sdlc:task', '--state', state,
          ...(search === undefined ? [] : ['--search', search]),
          '--json', ISSUE_FIELDS, '--limit', String(limit),
        ])) ?? [];
      assertNotCut(rows.length, limit, 'gh issue list');
      return rows;
    };
    if (closedSince === undefined) return list('all', ALL_ISSUE_LIMIT);

    const open = await list('open', OPEN_ISSUE_LIMIT);
    const closed = await list('closed', CLOSED_ISSUE_LIMIT, `updated:>=${closedSince}`);
    const byNumber = new Map<number, IssueRow>();
    for (const row of [...open, ...closed]) byNumber.set(row.number, row);
    return [...byNumber.values()];
  }

  private async recentStatuses(deployment: number): Promise<DeploymentStatusRow[]> {
    const statuses = await ghJson<DeploymentStatusRow[] | undefined>(this.run, [
      'api',
      `repos/${this.repo}/deployments/${deployment}/statuses?per_page=${RECENT_STATUSES}`,
    ]);
    return statuses ?? [];
  }

  // --- board -----------------------------------------------------------------------------------

  /** The issue's node id, the configured project's id and the issue's item on that project, if any. */
  private async loadIssueBoard(issue: number): Promise<IssueBoard> {
    const { owner, ownerType, number } = this.cfg.github.project;
    if (number === undefined) {
      throw new BoardError('github.project.number is not set; run "sdlc board ensure" first');
    }
    const [repoOwner, repoName] = this.repo.split('/') as [string, string];
    const root = ownerType === 'org' ? 'organization' : 'user';
    const data = await graphql<BoardQueryData>(
      this.run,
      `query($repoOwner: String!, $repoName: String!, $issue: Int!, $projectOwner: String!, $projectNumber: Int!) {
        repository(owner: $repoOwner, name: $repoName) {
          issue(number: $issue) {
            id
            projectItems(first: 50) {
              pageInfo { hasNextPage }
              nodes {
                id
                project { id }
                fieldValues(first: 50) {
                  pageInfo { hasNextPage }
                  nodes {
                    ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id } } }
                    ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2FieldCommon { id } } }
                  }
                }
              }
            }
          }
        }
        boardOwner: ${root}(login: $projectOwner) { projectV2(number: $projectNumber) { id } }
      }`,
      { repoOwner, repoName, issue, projectOwner: owner, projectNumber: number },
    );
    const found = data.repository?.issue;
    if (!found) throw new Error(`Issue #${issue} not found in ${this.repo}`);
    const projectId = data.boardOwner?.projectV2?.id;
    if (!projectId) throw new BoardError(`Project #${number} not found for ${ownerType} "${owner}"`);

    if (found.projectItems.pageInfo?.hasNextPage) {
      throw new Error(
        `Issue #${issue} is on more than 50 project boards; cannot tell whether it is on project #${number}`,
      );
    }
    const node = found.projectItems.nodes.find(n => n.project.id === projectId);
    if (!node) return { issueId: found.id, projectId };
    if (node.fieldValues.pageInfo?.hasNextPage) {
      throw new Error(`Issue #${issue} has more than 50 field values on project #${number}; some are not visible`);
    }
    const values = new Map<string, string>();
    for (const value of node.fieldValues.nodes) {
      const fieldId = value.field?.id;
      if (fieldId === undefined) continue;
      if (typeof value.optionId === 'string') values.set(fieldId, value.optionId);
      else if (typeof value.text === 'string') values.set(fieldId, value.text);
    }
    return { issueId: found.id, projectId, item: { id: node.id, values } };
  }

  /** Adds the issue to the project (GitHub returns the existing item when it is already there). */
  private async addItem(projectId: string, issueId: string): Promise<string> {
    const data = await graphql<{ addProjectV2ItemById: { item: { id: string } | null } | null }>(
      this.run,
      `mutation($input: AddProjectV2ItemByIdInput!) {
        addProjectV2ItemById(input: $input) { item { id } }
      }`,
      { input: { projectId, contentId: issueId } },
    );
    const id = data.addProjectV2ItemById?.item?.id;
    if (!id) throw new Error('GitHub did not return the new board item');
    return id;
  }

  /**
   * The writes that bring `keys` in line with `fields`, given the item's `current` values. Throws
   * before anything is written when a single-select value has no option on the board. A read item
   * has no value where the board shows none, so an empty field needs no clear; when the item's
   * values were not read (`current` is undefined) a stale one may be there, so every empty field
   * is cleared.
   */
  private planWrites(
    keys: (keyof BoardFields)[],
    map: FieldMap,
    fields: BoardFields,
    current: Map<string, string> | undefined,
    projectId: string,
    itemId: string,
  ): PlannedWrite[] {
    const writes: PlannedWrite[] = [];
    for (const key of keys) {
      const entry = map[key];
      const value = fields[key];
      const have = current?.get(entry.id);
      const target = { projectId, itemId, fieldId: entry.id };
      if (value === '') {
        if (current === undefined || (have !== undefined && have !== '')) {
          writes.push({ key, clear: true, input: target });
        }
      } else if (entry.options) {
        const optionId = findOption(entry.options, value);
        if (optionId === undefined) {
          throw new Error(
            `Board field "${FIELD_NAMES[key]}" has no option "${value}"; run "sdlc board ensure" to add it`,
          );
        }
        if (have !== optionId) {
          writes.push({ key, clear: false, input: { ...target, value: { singleSelectOptionId: optionId } } });
        }
      } else if (have !== value) {
        writes.push({ key, clear: false, input: { ...target, value: { text: value } } });
      }
    }
    return writes;
  }

  private async applyWrite(write: PlannedWrite): Promise<void> {
    if (write.clear) {
      await graphql(
        this.run,
        `mutation($input: ClearProjectV2ItemFieldValueInput!) {
          clearProjectV2ItemFieldValue(input: $input) { projectV2Item { id } }
        }`,
        { input: write.input },
      );
    } else {
      await graphql(
        this.run,
        `mutation($input: UpdateProjectV2ItemFieldValueInput!) {
          updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } }
        }`,
        { input: write.input },
      );
    }
  }
}
