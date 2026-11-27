import type { BoardFields } from '../core/projection.js';
import type { TaskState } from '../core/types.js';

/** A task as stored on the tracker: the issue plus the state read from its hidden state comment. */
export interface TrackedTask {
  issue: number;
  title: string;
  issueOpen: boolean;
  /** Why a closed issue was closed, when GitHub says; `undefined` for an open issue. */
  closeReason?: 'completed' | 'not_planned';
  state: TaskState;
  stateCommentId: string;
  /** The state comment's `updated_at` when read: `writeState` refuses to write over a newer one. */
  stateCommentUpdatedAt: string;
}

/** The issue has no trusted state comment: it is not a tracked task (yet). */
export class NoStateCommentError extends Error {
  constructor(issue: number) {
    super(`Issue #${issue} has no state comment`);
    this.name = 'NoStateCommentError';
  }
}

/** An issue as `getIssue` reads it. */
export interface IssueInfo {
  number: number;
  title: string;
  url: string;
  open: boolean;
}

/** The state comment a write expects to replace, as it was read. */
export interface ExpectedStateComment {
  id: string;
  updatedAt: string;
}

/** The state comment changed between reading and writing it: re-running reads the new state. */
export class StateChangedError extends Error {
  constructor(issue: number) {
    super(`state of #${issue} changed since it was read; re-run`);
    this.name = 'StateChangedError';
  }
}

/** A `sdlc:task` issue the tool cannot read state from; `reason` says why, for the user. */
export interface UntrackedIssue {
  issue: number;
  title: string;
  /** `missing state comment`, or the message of the error from reading a corrupt state comment. */
  reason: string;
}

/** Every `sdlc:task` issue, sorted into those with readable state and those without. */
export interface TaskScan {
  tracked: TrackedTask[];
  untracked: UntrackedIssue[];
}

export interface IssueComment {
  id: string;
  url: string;
  author: string;
  body: string;
  createdAt: string;
  /** GitHub's `updated_at`: equals `createdAt` until the comment is edited. */
  updatedAt: string;
}

export interface PrInfo {
  number: number;
  url: string;
  merged: boolean;
  mergeSha?: string;
  /** When the PR merged, ISO 8601. */
  mergedAt?: string;
  baseRef: string;
  body: string;
}

/** A comment just posted: its id and GitHub's creation time. */
export interface PostedComment {
  id: string;
  createdAt: string;
}

export interface DeploymentInfo {
  id: number;
  sha: string;
  environment: string;
  /** A page a person can open: the environment URL, else the log URL, else the environment on GitHub. */
  url: string;
  createdAt: string;
}

/** A published GitHub Release: not a draft, not a prerelease. */
export interface ReleaseInfo {
  tag: string;
  /** The commit the tag points to (an annotated tag is resolved to its commit). */
  sha: string;
  /** The release page (`html_url`). */
  url: string;
  /** When the release was published, ISO 8601. */
  publishedAt: string;
}

/**
 * The I/O boundary to the issue tracker, the project board and the repository. The production
 * implementation talks to GitHub through the `gh` CLI; tests use an in-memory fake.
 */
export interface Tracker {
  /**
   * The login the tool writes as, or `undefined` when the token may not read it (the Actions
   * `GITHUB_TOKEN`). Recorded as `by` on approvals the tool records itself.
   */
  authenticatedLogin(): Promise<string | undefined>;
  createIssue(title: string, body: string, labels: string[]): Promise<{ number: number; url: string }>;
  addToBoard(issue: number): Promise<void>;
  /**
   * `sdlc:task` issues with a readable state comment, oldest issue first. A state comment counts
   * only when its author is the tracker's own login, a configured owner or the Actions bot (any
   * letter case); of several, the one updated last is the state. Issues whose state comment is
   * missing or corrupt are skipped, never thrown on; `listUntracked` reports them.
   */
  listTrackedTasks(): Promise<TrackedTask[]>;
  /** `sdlc:task` issues with no state comment, or one that cannot be parsed, oldest issue first. */
  listUntracked(): Promise<UntrackedIssue[]>;
  /** `listTrackedTasks` and `listUntracked` from one scan of the `sdlc:task` issues. */
  scanTasks(): Promise<TaskScan>;
  /** Throws `NoStateCommentError` when the issue has no state comment, and `StateCommentError` when it is corrupt. */
  getTask(issue: number): Promise<TrackedTask>;
  /** Reads one issue, tracked or not. */
  getIssue(issue: number): Promise<IssueInfo>;
  /**
   * Updates the state comment in place, or posts one when there is none (or an edit is refused).
   * With `expected`, the state comment is read again first and `StateChangedError` is thrown,
   * writing nothing, unless it is still that comment with that `updated_at`.
   */
  writeState(issue: number, state: TaskState, expected?: ExpectedStateComment): Promise<void>;
  /** Posts a comment and returns its id and the time GitHub created it. */
  postComment(issue: number, body: string): Promise<PostedComment>;
  /**
   * Lists comments oldest first. `issue` may be an issue or a pull request number: GitHub's
   * issue-comments API serves both. With `sinceIso`, only comments created after it are returned.
   */
  listComments(issue: number, sinceIso?: string): Promise<IssueComment[]>;
  setIssueOpen(issue: number, open: boolean, reason?: 'completed' | 'not_planned'): Promise<void>;
  setLabels(issue: number, add: string[], remove: string[]): Promise<void>;
  syncFields(issue: number, fields: BoardFields): Promise<void>;
  listTaskPrs(issue: number): Promise<PrInfo[]>;
  /** Reads one pull request directly (not through search); `undefined` when `pr` is not a pull request. */
  getPr(pr: number): Promise<PrInfo | undefined>;
  /** Successful deployments to `environment`, newest first, at most `limit`. */
  listSuccessfulDeployments(environment: string, limit: number): Promise<DeploymentInfo[]>;
  /**
   * Published releases (no drafts, no prereleases), newest first, at most `limit`, each with its
   * tag resolved to a commit sha.
   */
  listReleases(limit: number): Promise<ReleaseInfo[]>;
  isAncestor(ancestorSha: string, descendantSha: string): Promise<boolean>;
  isOnDefaultBranch(sha: string): Promise<boolean>;
  createDeployment(input: {
    environment: string;
    sha: string;
    target: string;
    description: string;
  }): Promise<DeploymentInfo>;
}
