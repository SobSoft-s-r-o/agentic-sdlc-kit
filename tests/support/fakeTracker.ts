import {
  parseStateComment,
  renderStateComment,
  STATE_MARKER,
  StateCommentError,
} from '../../src/core/stateComment.js';
import type { BoardFields } from '../../src/core/projection.js';
import type { TaskState } from '../../src/core/types.js';
import {
  StateChangedError,
  type DeploymentInfo,
  type ExpectedStateComment,
  type IssueComment,
  type PrInfo,
  type ReleaseInfo,
  type TrackedTask,
  type TaskScan,
  type Tracker,
  type UntrackedIssue,
} from '../../src/tracker/types.js';

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  open: boolean;
  closeReason?: 'completed' | 'not_planned';
  onBoard: boolean;
}

/**
 * A comment on an issue or pull request, keyed by its number. `updatedAt` is GitHub's `updated_at`:
 * the creation time until the comment is edited.
 */
export type FakeComment = IssueComment & { issue: number; updatedAt: string };
/** A pull request linked to the task issue `issue` (the real tracker finds these by PR body). */
export type FakePr = PrInfo & { issue: number };
/** `target` and `description` record what `createDeployment` was given. */
export type FakeDeployment = DeploymentInfo & { target?: string; description?: string };

const CLOCK_START = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;

/** The login the Actions runner comments as; its state comments count like the tracker's own. */
const ACTIONS_BOT = 'github-actions[bot]';

const toPrInfo = ({ number, url, merged, mergeSha, mergedAt, baseRef, body }: FakePr): PrInfo => ({
  number,
  url,
  merged,
  ...(mergeSha !== undefined && { mergeSha }),
  ...(mergedAt !== undefined && { mergedAt }),
  baseRef,
  body,
});

const maxOf = (numbers: number[]): number => numbers.reduce((max, n) => Math.max(max, n), 0);

/**
 * In-memory `Tracker` for tests. State is held in public fields so tests can seed and assert on
 * it directly. Task state is stored as the real hidden state comment, so the fake exercises the
 * same render/parse format as production. All timestamps come from one fake clock that advances
 * one minute per use, starting at 2026-01-01T00:01:00.000Z. As in production, only a state-marker
 * comment written by `login`, one of `owners` or `agents`, or the Actions bot (compared case-insensitively) holds
 * state, and when several do, the one updated last is the state; anyone else's is an ordinary comment.
 */
export class FakeTracker implements Tracker {
  issues: FakeIssue[] = [];
  /** Includes the hidden state comments, as GitHub would. */
  comments: FakeComment[] = [];
  prs: FakePr[] = [];
  /** Every entry counts as a successful deployment. */
  deployments: FakeDeployment[] = [];
  /** Every entry counts as a published release (no drafts or prereleases). */
  releases: ReleaseInfo[] = [];
  fields = new Map<number, BoardFields>();
  /** Ancestry facts as `"<ancestorSha>><descendantSha>"` pairs; a commit is its own ancestor. */
  ancestors = new Set<string>();
  defaultBranchShas = new Set<string>();
  /** Mutating calls that were attempted and not failed by `failNext`; reads are not counted. */
  writes = 0;
  /** Author of the comments the tracker itself posts. */
  login = 'sdlc-bot';
  /** The configured owners; their state comments are trusted as well. */
  owners: string[] = [];
  /** The configured agent logins; their state comments are trusted as well. */
  agents: string[] = [];

  private pendingFailures = new Map<keyof Tracker, number>();
  private concurrentWrites = new Set<number>();
  private clock = 0;

  /**
   * Makes the next `writeState` on `issue` find its state comment edited by someone else since it
   * was read (its `updatedAt` moves on), as a concurrent writer would leave it.
   */
  concurrentWriteBeforeNextWriteState(issue: number): void {
    this.concurrentWrites.add(issue);
  }

  /** Makes the next call of `method` (once per `failNext` call) reject, without applying it. */
  failNext(method: keyof Tracker): void {
    this.pendingFailures.set(method, (this.pendingFailures.get(method) ?? 0) + 1);
  }

  /**
   * Adds an issue carrying `state` as its state comment, bypassing the `Tracker` interface (no
   * write is counted). The issue number is `state.issue`.
   */
  seedTask(
    state: TaskState,
    options: {
      title?: string;
      labels?: string[];
      open?: boolean;
      /** For a closed issue; defaults to the reason the state's outcome closes it with. */
      closeReason?: 'completed' | 'not_planned';
      onBoard?: boolean;
    } = {},
  ): void {
    if (this.issues.some(i => i.number === state.issue)) {
      throw new Error(`FakeTracker: issue #${state.issue} already exists`);
    }
    const open = options.open ?? true;
    const closeReason = options.closeReason ?? (state.outcome === 'cancelled' ? 'not_planned' : 'completed');
    this.issues.push({
      number: state.issue,
      title: options.title ?? state.summary,
      body: '',
      labels: options.labels ?? ['sdlc:task', `type:${state.type}`],
      open,
      ...(!open && { closeReason }),
      onBoard: options.onBoard ?? true,
    });
    this.comments.push(this.newComment(state.issue, renderStateComment(state), this.login));
  }

  /** Adds a comment on an issue or PR, bypassing the `Tracker` interface; returns its id. */
  seedComment(
    thread: number,
    comment: { body: string; author: string; createdAt?: string; updatedAt?: string },
  ): string {
    const created = this.newComment(thread, comment.body, comment.author, comment.createdAt);
    if (comment.updatedAt !== undefined) created.updatedAt = comment.updatedAt;
    this.comments.push(created);
    return created.id;
  }

  /** Always `login`; a failure can be injected like any other call. */
  async authenticatedLogin(): Promise<string | undefined> {
    this.begin('authenticatedLogin');
    return this.login;
  }

  async createIssue(
    title: string,
    body: string,
    labels: string[],
  ): Promise<{ number: number; url: string }> {
    this.begin('createIssue', true);
    const number = maxOf([...this.issues.map(i => i.number), ...this.prs.map(p => p.number)]) + 1;
    this.issues.push({ number, title, body, labels: [...labels], open: true, onBoard: false });
    return { number, url: `https://github.test/issues/${number}` };
  }

  async addToBoard(issue: number): Promise<void> {
    this.begin('addToBoard', true);
    this.issue(issue).onBoard = true;
  }

  /** `sdlc:task` issues, oldest first; one whose state comment is missing or corrupt is skipped. */
  async listTrackedTasks(): Promise<TrackedTask[]> {
    this.begin('listTrackedTasks');
    return this.trackedOf();
  }

  /** Both lists from one call, as the real tracker reads them from one scan. */
  async scanTasks(): Promise<TaskScan> {
    this.begin('scanTasks');
    const [tracked, untracked] = [this.trackedOf(), this.untrackedOf()];
    return { tracked, untracked };
  }

  /** `sdlc:task` issues without a parseable state comment, oldest issue first. */
  async listUntracked(): Promise<UntrackedIssue[]> {
    this.begin('listUntracked');
    return this.untrackedOf();
  }

  async getTask(issue: number): Promise<TrackedTask> {
    this.begin('getTask');
    const found = this.issue(issue);
    const stateComment = this.findStateComment(issue);
    if (!stateComment) throw new Error(`FakeTracker: issue #${issue} has no state comment`);
    return this.toTrackedTask(found, stateComment);
  }

  async writeState(issue: number, state: TaskState, expected?: ExpectedStateComment): Promise<void> {
    this.begin('writeState', true);
    this.issue(issue);
    const body = renderStateComment(state);
    const existing = this.findStateComment(issue);
    if (existing && this.concurrentWrites.delete(issue)) existing.updatedAt = this.tick();
    if (expected && (!existing || existing.id !== expected.id || existing.updatedAt !== expected.updatedAt)) {
      throw new StateChangedError(issue);
    }
    if (existing) {
      existing.body = body;
      existing.updatedAt = this.tick();
    } else this.comments.push(this.newComment(issue, body, this.login));
  }

  async postComment(issue: number, body: string): Promise<string> {
    this.begin('postComment', true);
    this.requireThread(issue);
    const comment = this.newComment(issue, body, this.login);
    this.comments.push(comment);
    return comment.id;
  }

  /** Oldest first; `sinceIso` keeps only comments created strictly after it. */
  async listComments(issue: number, sinceIso?: string): Promise<IssueComment[]> {
    this.begin('listComments');
    this.requireThread(issue);
    const since = sinceIso === undefined ? -Infinity : Date.parse(sinceIso);
    if (Number.isNaN(since)) throw new Error(`FakeTracker: invalid since timestamp "${sinceIso}"`);
    return this.comments
      .filter(c => c.issue === issue && Date.parse(c.createdAt) > since)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map(({ id, url, author, body, createdAt, updatedAt }) => ({ id, url, author, body, createdAt, updatedAt }));
  }

  async setIssueOpen(
    issue: number,
    open: boolean,
    reason?: 'completed' | 'not_planned',
  ): Promise<void> {
    this.begin('setIssueOpen', true);
    const found = this.issue(issue);
    found.open = open;
    if (open || reason === undefined) delete found.closeReason;
    else found.closeReason = reason;
  }

  async setLabels(issue: number, add: string[], remove: string[]): Promise<void> {
    this.begin('setLabels', true);
    const found = this.issue(issue);
    found.labels = [...new Set([...found.labels.filter(l => !remove.includes(l)), ...add])];
  }

  async syncFields(issue: number, fields: BoardFields): Promise<void> {
    this.begin('syncFields', true);
    this.issue(issue);
    this.fields.set(issue, { ...fields });
  }

  async listTaskPrs(issue: number): Promise<PrInfo[]> {
    this.begin('listTaskPrs');
    return this.prs.filter(pr => pr.issue === issue).map(toPrInfo);
  }

  /** Any PR by number, whatever `issue` it is filed under (as `gh pr view` reads it directly). */
  async getPr(pr: number): Promise<PrInfo | undefined> {
    this.begin('getPr');
    const found = this.prs.find(candidate => candidate.number === pr);
    return found && toPrInfo(found);
  }

  /** Newest first by creation time, ties broken by id. */
  async listSuccessfulDeployments(environment: string, limit: number): Promise<DeploymentInfo[]> {
    this.begin('listSuccessfulDeployments');
    return this.deployments
      .filter(d => d.environment === environment)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id)
      .slice(0, Math.max(0, limit))
      .map(({ id, sha, environment: env, url, createdAt }) => ({ id, sha, environment: env, url, createdAt }));
  }

  /** Newest first by publication time, ties kept in the order they were added. */
  async listReleases(limit: number): Promise<ReleaseInfo[]> {
    this.begin('listReleases');
    return [...this.releases]
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .slice(0, Math.max(0, limit))
      .map(({ tag, sha, url, publishedAt }) => ({ tag, sha, url, publishedAt }));
  }

  async isAncestor(ancestorSha: string, descendantSha: string): Promise<boolean> {
    this.begin('isAncestor');
    return ancestorSha === descendantSha || this.ancestors.has(`${ancestorSha}>${descendantSha}`);
  }

  async isOnDefaultBranch(sha: string): Promise<boolean> {
    this.begin('isOnDefaultBranch');
    return this.defaultBranchShas.has(sha);
  }

  async createDeployment(input: {
    environment: string;
    sha: string;
    target: string;
    description: string;
  }): Promise<DeploymentInfo> {
    this.begin('createDeployment', true);
    const id = maxOf(this.deployments.map(d => d.id)) + 1;
    const deployment: FakeDeployment = {
      id,
      sha: input.sha,
      environment: input.environment,
      url: `https://github.test/deployments/${id}`,
      createdAt: this.tick(),
      target: input.target,
      description: input.description,
    };
    this.deployments.push(deployment);
    return {
      id,
      sha: deployment.sha,
      environment: deployment.environment,
      url: deployment.url,
      createdAt: deployment.createdAt,
    };
  }

  /** Runs at the start of every interface method; throwing here rejects the (async) call. */
  private begin(method: keyof Tracker, mutating = false): void {
    const pending = this.pendingFailures.get(method) ?? 0;
    if (pending > 0) {
      this.pendingFailures.set(method, pending - 1);
      throw new Error(`FakeTracker.${method} failed (injected by failNext)`);
    }
    if (mutating) this.writes += 1;
  }

  private tick(): string {
    this.clock += 1;
    return new Date(CLOCK_START + this.clock * MINUTE).toISOString();
  }

  private sortedIssues(): FakeIssue[] {
    return [...this.issues].sort((a, b) => a.number - b.number);
  }

  private issue(number: number): FakeIssue {
    const found = this.issues.find(i => i.number === number);
    if (!found) throw new Error(`FakeTracker: issue #${number} not found`);
    return found;
  }

  /** Issue comments are served for pull requests too, so a PR number is a valid thread. */
  private requireThread(number: number): void {
    if (!this.issues.some(i => i.number === number) && !this.prs.some(p => p.number === number)) {
      throw new Error(`FakeTracker: issue or PR #${number} not found`);
    }
  }

  private newComment(thread: number, body: string, author: string, createdAt?: string): FakeComment {
    const id = String(maxOf(this.comments.map(c => Number(c.id) || 0)) + 1);
    const created = createdAt ?? this.tick();
    return {
      issue: thread,
      id,
      url: `https://github.test/issues/${thread}#issuecomment-${id}`,
      author,
      body,
      createdAt: created,
      updatedAt: created,
    };
  }

  /**
   * The state comment: among the state-marker comments by a trusted author (`login`, an owner, an
   * agent or the Actions bot, in any letter case), the one updated last; the newer id wins a tie.
   */
  private findStateComment(issue: number): FakeComment | undefined {
    const trusted = new Set([this.login, ...this.owners, ...this.agents, ACTIONS_BOT].map(name => name.toLowerCase()));
    return this.comments
      .filter(
        c =>
          c.issue === issue &&
          c.body.trimStart().startsWith(STATE_MARKER) &&
          trusted.has(c.author.toLowerCase()),
      )
      .reduce<FakeComment | undefined>(
        (newest, c) =>
          !newest || Date.parse(c.updatedAt) > Date.parse(newest.updatedAt) ||
          (Date.parse(c.updatedAt) === Date.parse(newest.updatedAt) && Number(c.id) > Number(newest.id))
            ? c
            : newest,
        undefined,
      );
  }

  private trackedOf(): TrackedTask[] {
    return this.sortedIssues()
      .filter(issue => issue.labels.includes('sdlc:task'))
      .flatMap(issue => {
        const stateComment = this.findStateComment(issue.number);
        if (!stateComment) return [];
        try {
          return [this.toTrackedTask(issue, stateComment)];
        } catch (error) {
          if (error instanceof StateCommentError) return [];
          throw error;
        }
      });
  }

  private untrackedOf(): UntrackedIssue[] {
    return this.sortedIssues()
      .filter(issue => issue.labels.includes('sdlc:task'))
      .flatMap(issue => {
        const stateComment = this.findStateComment(issue.number);
        if (!stateComment) return [{ issue: issue.number, title: issue.title, reason: 'missing state comment' }];
        try {
          this.toTrackedTask(issue, stateComment);
          return [];
        } catch (error) {
          if (!(error instanceof StateCommentError)) throw error;
          return [{ issue: issue.number, title: issue.title, reason: error.message }];
        }
      });
  }

  private toTrackedTask(issue: FakeIssue, stateComment: FakeComment): TrackedTask {
    const state = parseStateComment(stateComment.body);
    if (!state) throw new Error(`FakeTracker: comment ${stateComment.id} is not a state comment`);
    return {
      issue: issue.number,
      title: issue.title,
      issueOpen: issue.open,
      ...(!issue.open && issue.closeReason && { closeReason: issue.closeReason }),
      state,
      stateCommentId: stateComment.id,
      stateCommentUpdatedAt: stateComment.updatedAt,
    };
  }
}
