import type { BoardFields } from '../core/projection.js';
import type { TaskState } from '../core/types.js';

/** A task as stored on the tracker: the issue plus the state read from its hidden state comment. */
export interface TrackedTask {
  issue: number;
  title: string;
  issueOpen: boolean;
  state: TaskState;
  stateCommentId: string;
}

export interface IssueComment {
  id: string;
  url: string;
  author: string;
  body: string;
  createdAt: string;
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

export interface DeploymentInfo {
  id: number;
  sha: string;
  environment: string;
  url: string;
  createdAt: string;
}

/**
 * The I/O boundary to the issue tracker, the project board and the repository. The production
 * implementation talks to GitHub through the `gh` CLI; tests use an in-memory fake.
 */
export interface Tracker {
  createIssue(title: string, body: string, labels: string[]): Promise<{ number: number; url: string }>;
  addToBoard(issue: number): Promise<void>;
  listTrackedTasks(): Promise<TrackedTask[]>;
  getTask(issue: number): Promise<TrackedTask>;
  writeState(issue: number, state: TaskState): Promise<void>;
  /** Posts a comment and returns its id. */
  postComment(issue: number, body: string): Promise<string>;
  /**
   * Lists comments oldest first. `issue` may be an issue or a pull request number: GitHub's
   * issue-comments API serves both. With `sinceIso`, only comments created after it are returned.
   */
  listComments(issue: number, sinceIso?: string): Promise<IssueComment[]>;
  setIssueOpen(issue: number, open: boolean, reason?: 'completed' | 'not_planned'): Promise<void>;
  setLabels(issue: number, add: string[], remove: string[]): Promise<void>;
  syncFields(issue: number, fields: BoardFields): Promise<void>;
  listTaskPrs(issue: number): Promise<PrInfo[]>;
  /** Successful deployments to `environment`, newest first, at most `limit`. */
  listSuccessfulDeployments(environment: string, limit: number): Promise<DeploymentInfo[]>;
  isAncestor(ancestorSha: string, descendantSha: string): Promise<boolean>;
  isOnDefaultBranch(sha: string): Promise<boolean>;
  createDeployment(input: {
    environment: string;
    sha: string;
    target: string;
    description: string;
  }): Promise<DeploymentInfo>;
}
