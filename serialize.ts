// REST v3 JSON shapes for the forge's objects. One serializer per object, used by the REST routes
// and by the MCP tools, so every surface presents the same object the same way.

import { branchTip } from './domain.ts';
import { getCommit, lookupPath, parseTree } from './git.ts';
import {
  commentGlobalId,
  globalId,
  issueGlobalId,
  issueRestId,
  pullGlobalId,
  repoGlobalId,
  USERS,
  type GHUser,
  type Issue,
  type IssueComment,
  type Label,
  type PullRequest,
  type Repo,
} from './store.ts';

export function userJson(u: GHUser): Record<string, unknown> {
  return {
    login: u.login,
    id: u.id,
    node_id: globalId(u.type === 'Organization' ? 'Organization' : 'User', u.id),
    type: u.type,
    name: u.name,
    email: u.email,
    avatar_url: '',
    url: `/api/v3/users/${u.login}`,
    html_url: `https://github.com/${u.login}`,
    site_admin: false,
  };
}

export function ownerJson(login: string): Record<string, unknown> {
  const found = USERS[login];
  if (found !== undefined) return userJson(found);
  return { login, id: 0, node_id: '', type: 'User', avatar_url: '', url: `/api/v3/users/${login}`, html_url: `https://github.com/${login}` };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: ownerJson(repo.owner),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description === '' ? null : repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', label.name),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: '',
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueRestId(repo, issue.number),
    node_id: issueGlobalId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: ownerJson(issue.authorLogin),
    labels: issue.labelNames.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(label) : { id: 0, node_id: '', name, color: 'ededed', description: null, default: false, url: '' };
    }),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(repo, issue.number, comment.id),
    body: comment.body,
    user: ownerJson(comment.authorLogin),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef, pull.headSha);
  const baseSha = branchTip(repo, pull.baseRef, pull.baseSha);
  return {
    id: issueRestId(repo, pull.number),
    node_id: pullGlobalId(repo, pull.number),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: ownerJson(pull.authorLogin),
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: ownerJson(repo.owner),
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      user: ownerJson(repo.owner),
      repo: repoJson(repo),
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function branchJson(repo: Repo, name: string): Record<string, unknown> {
  const sha = repo.refs.get(`refs/heads/${name}`) ?? '';
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
    _links: {},
  };
}

function identJson(ident: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(ident);
  if (match === null) return { name: ident, email: '', date: '2025-01-01T00:00:00Z' };
  return {
    name: match[1]!,
    email: match[2]!,
    date: new Date(Number(match[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

export function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const commit = getCommit(repo, sha);
  if (commit === null) return null;
  return {
    sha,
    node_id: globalId('Commit', sha),
    commit: {
      author: identJson(commit.author),
      committer: identJson(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree, url: '' },
      url: '',
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: commit.parents.map((parent) => ({ sha: parent, url: '', html_url: '' })),
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

export function refJson(ref: string, sha: string, type = 'commit'): Record<string, unknown> {
  return { ref, node_id: globalId('Ref', ref), url: '', object: { type, sha, url: '' } };
}

/** Contents API shapes for one path at one commit; null when the path does not exist. */
export function contentsJson(repo: Repo, treeSha: string, path: string): Record<string, unknown> | Array<Record<string, unknown>> | null {
  if (path === '') {
    const obj = repo.objects.get(treeSha);
    if (obj === undefined || obj.type !== 'tree') return null;
    return parseTree(obj.data).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: entry.name,
      sha: entry.sha,
      size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.sha)?.data.length ?? 0),
      url: '',
      html_url: '',
      git_url: '',
      download_url: null,
      _links: {},
    }));
  }
  const found = lookupPath(repo, treeSha, path);
  if (found === null) return null;
  const slash = path.lastIndexOf('/');
  const name = slash === -1 ? path : path.slice(slash + 1);
  if (found.isDir) {
    const obj = repo.objects.get(found.sha);
    if (obj === undefined || obj.type !== 'tree') return null;
    return parseTree(obj.data).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: `${path}/${entry.name}`,
      sha: entry.sha,
      size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.sha)?.data.length ?? 0),
      url: '',
      html_url: '',
      git_url: '',
      download_url: null,
      _links: {},
    }));
  }
  const blob = repo.objects.get(found.sha);
  if (blob === undefined) return null;
  return {
    type: 'file',
    encoding: 'base64',
    content: blob.data.toString('base64'),
    sha: found.sha,
    size: blob.data.length,
    name,
    path,
    url: '',
    html_url: '',
    git_url: '',
    download_url: null,
    _links: {},
  };
}
