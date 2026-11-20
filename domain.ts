// Domain operations shared by REST, GraphQL and MCP: issues, comments and pull requests over the
// store + git layer. Keeping them here means every surface creates and merges the very same objects.

import {
  buildTree,
  commitTreeSha,
  diffFileMaps,
  flattenTree,
  getCommit,
  makeCommit,
  mergeBase,
  mergeFileMaps,
  type FileDiff,
} from './git.ts';
import {
  newCommentId,
  tickIso,
  VIEWER_LOGIN,
  type Issue,
  type IssueComment,
  type PullRequest,
  type Repo,
} from './store.ts';

export function addIssue(
  repo: Repo,
  input: { title: string; body: string; labelNames?: string[]; authorLogin?: string },
): Issue {
  const stamp = tickIso();
  const issue: Issue = {
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    labelNames: input.labelNames ?? [],
    authorLogin: input.authorLogin ?? VIEWER_LOGIN,
    createdAt: stamp,
    updatedAt: stamp,
    comments: [],
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function addComment(repo: Repo, issue: Issue, body: string, authorLogin = VIEWER_LOGIN): IssueComment {
  const comment: IssueComment = { id: newCommentId(), body, authorLogin, createdAt: tickIso() };
  issue.comments.push(comment);
  issue.updatedAt = comment.createdAt;
  return comment;
}

/** The current tip sha of a branch (short name), or the stored fallback when the ref is gone. */
export function branchTip(repo: Repo, branch: string, fallback = ''): string {
  return repo.refs.get(`refs/heads/${branch}`) ?? fallback;
}

/** Flat file map of a commit's tree. */
export function filesOfCommit(repo: Repo, commitSha: string): Map<string, { sha: string; mode: string }> {
  const tree = commitTreeSha(repo, commitSha);
  if (tree === null) return new Map();
  return flattenTree(repo, tree);
}

export function createPull(
  repo: Repo,
  input: { title: string; body: string; headRef: string; baseRef: string; authorLogin?: string },
): { pull: PullRequest } | { error: string } {
  const headSha = repo.refs.get(`refs/heads/${input.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${input.baseRef}`);
  if (headSha === undefined) return { error: `head ref ${input.headRef} does not exist` };
  if (baseSha === undefined) return { error: `base ref ${input.baseRef} does not exist` };
  const stamp = tickIso();
  const pull: PullRequest = {
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: input.headRef,
    baseRef: input.baseRef,
    headSha,
    baseSha,
    authorLogin: input.authorLogin ?? VIEWER_LOGIN,
    createdAt: stamp,
    updatedAt: stamp,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return { pull };
}

/** The merge-base commit of a pull request's current head and base tips, or null. */
export function pullMergeBase(repo: Repo, pull: PullRequest): string | null {
  const head = branchTip(repo, pull.headRef, pull.headSha);
  const base = branchTip(repo, pull.baseRef, pull.baseSha);
  if (getCommit(repo, head) === null || getCommit(repo, base) === null) return null;
  return mergeBase(repo, base, head);
}

/** The files a pull request changes: merge-base tree -> head tree. */
export function pullFiles(repo: Repo, pull: PullRequest): FileDiff[] {
  const head = branchTip(repo, pull.headRef, pull.headSha);
  const mb = pullMergeBase(repo, pull);
  const from = mb !== null ? filesOfCommit(repo, mb) : new Map<string, { sha: string; mode: string }>();
  const to = filesOfCommit(repo, head);
  return diffFileMaps(repo, from, to);
}

export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

/** File-level three-way mergeability of a pull request against its base's current tip. */
export function pullMergeable(repo: Repo, pull: PullRequest): Mergeable {
  if (pull.state !== 'open') return 'UNKNOWN';
  const mb = pullMergeBase(repo, pull);
  if (mb === null) return 'UNKNOWN';
  const base = branchTip(repo, pull.baseRef, pull.baseSha);
  const head = branchTip(repo, pull.headRef, pull.headSha);
  const { conflicts } = mergeFileMaps(filesOfCommit(repo, mb), filesOfCommit(repo, base), filesOfCommit(repo, head));
  return conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
}

export type MergeMethod = 'squash' | 'merge' | 'rebase';

/**
 * Merge a pull request into its base branch. Squash (and rebase, approximated the same way) lands
 * one commit with the merged tree on the base tip; merge makes a two-parent commit.
 */
export function mergePull(
  repo: Repo,
  pull: PullRequest,
  method: MergeMethod,
): { sha: string } | { error: 'conflict' | 'not-open' | 'no-base' } {
  if (pull.state !== 'open' || pull.merged) return { error: 'not-open' };
  const base = branchTip(repo, pull.baseRef, pull.baseSha);
  const head = branchTip(repo, pull.headRef, pull.headSha);
  const mb = pullMergeBase(repo, pull);
  if (mb === null || getCommit(repo, base) === null) return { error: 'no-base' };
  const { merged, conflicts } = mergeFileMaps(filesOfCommit(repo, mb), filesOfCommit(repo, base), filesOfCommit(repo, head));
  if (conflicts.length > 0) return { error: 'conflict' };
  const tree = buildTree(repo, merged);
  let sha: string;
  if (method === 'merge') {
    sha = makeCommit(repo, tree, [base, head], `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`);
  } else {
    const message = pull.body !== '' ? `${pull.title} (#${pull.number})\n\n${pull.body}` : `${pull.title} (#${pull.number})`;
    sha = makeCommit(repo, tree, [base], message);
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = tickIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  return { sha };
}
