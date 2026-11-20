// The forge's shared store: one in-memory data model that all four surfaces (git smart HTTP, REST,
// GraphQL, MCP) read and write, so an object created on one surface is the same object on the others.
//
// Determinism: the suite's scenario is a pure function of a published seed, and the trial token is
// opaque, so the viewer's identity is a constant of the scenario (computed from the kit's wire.ts).
// No wall clock and no randomness feed any response: timestamps come from a logical clock seeded by
// MAKEFUN_TRIAL_NOW when the harness provides it, else a fixed epoch, and advanced by a counter.

export interface GHUser {
  login: string;
  id: number;
  name: string;
  email: string;
  type: 'User' | 'Organization';
}

function user(id: number, login: string, first: string, last: string): GHUser {
  return { login, id, name: `${first} ${last}`, email: `${login}@example.invalid`, type: 'User' };
}

/** The scenario's people, by login. The token owner (viewer) is adaiversen, id 1000. */
export const USERS: Readonly<Record<string, GHUser>> = Object.freeze({
  adaiversen: user(1000, 'adaiversen', 'ada', 'iversen'),
  quinnkeller: user(1001, 'quinnkeller', 'quinn', 'keller'),
  olgabauer: user(1002, 'olgabauer', 'olga', 'bauer'),
  dmitriquist: user(1003, 'dmitriquist', 'dmitri', 'quist'),
  adanovak: user(1004, 'adanovak', 'ada', 'novak'),
  zanerossi: user(1005, 'zanerossi', 'zane', 'rossi'),
  pavelcosta: user(1006, 'pavelcosta', 'pavel', 'costa'),
  wrenkeller: user(1007, 'wrenkeller', 'wren', 'keller'),
  coraquist: user(1008, 'coraquist', 'cora', 'quist'),
  elenaulrich: user(1009, 'elenaulrich', 'elena', 'ulrich'),
  tesssato: user(1010, 'tesssato', 'tess', 'sato'),
  svenrossi: user(1011, 'svenrossi', 'sven', 'rossi'),
  'faint-meadow-org': { login: 'faint-meadow-org', id: 2000, name: 'faint-meadow-org', email: 'faint-meadow-org@example.invalid', type: 'Organization' },
});

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER: GHUser = USERS[VIEWER_LOGIN]!;

/** The identity server-created commits (contents API, merges) are authored with. */
export const COMMITTER_IDENT = `${VIEWER.name} <${VIEWER.email}>`;

// ---------------------------------------------------------------------------
// Logical clock
// ---------------------------------------------------------------------------

const SCENARIO_EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z

function seedEpochSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) return Math.floor(asNumber > 1e12 ? asNumber / 1000 : asNumber);
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return SCENARIO_EPOCH_SEC;
}

let clockSec = seedEpochSec();

/** Advance the logical clock by one second and return the new time as an ISO string. */
export function tickIso(): string {
  clockSec += 1;
  return new Date(clockSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The current logical time as an ISO string, without advancing. */
export function nowIso(): string {
  return new Date(clockSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The current logical time in epoch seconds (for git ident timestamps). */
export function nowEpochSec(): number {
  return clockSec;
}

// ---------------------------------------------------------------------------
// Repositories, issues, pull requests
// ---------------------------------------------------------------------------

export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface IssueComment {
  id: number;
  body: string;
  authorLogin: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labelNames: string[];
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
  comments: IssueComment[];
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  /** The databaseId: one counter across the whole forge, stable for the repo's life. */
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** Git objects by sha; strictly per-repo so nothing leaks across repositories. */
  objects: Map<string, GitObject>;
  /** Full ref names ('refs/heads/main') to commit shas. */
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
}

const repos = new Map<string, Repo>();
let nextRepoId = 700001;
let nextLabelId = 5001;
let nextCommentId = 900001;

function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function createRepo(owner: string, name: string, description = '', isPrivate = false): Repo {
  const stamp = tickIso();
  const repo: Repo = {
    id: nextRepoId,
    owner,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    createdAt: stamp,
    updatedAt: stamp,
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    nextNumber: 1,
  };
  nextRepoId += 1;
  repos.set(repoKey(owner, name), repo);
  return repo;
}

export function findRepo(owner: string, name: string): Repo | null {
  return repos.get(repoKey(owner, name)) ?? null;
}

export function deleteRepo(repo: Repo): void {
  repos.delete(repoKey(repo.owner, repo.name));
}

export function reposOfOwner(owner: string): Repo[] {
  const out: Repo[] = [];
  for (const repo of repos.values()) if (repo.owner.toLowerCase() === owner.toLowerCase()) out.push(repo);
  return out;
}

export function allRepos(): Repo[] {
  return [...repos.values()];
}

export function repoNameTaken(owner: string, name: string): boolean {
  return repos.has(repoKey(owner, name));
}

export function newLabelId(): number {
  const id = nextLabelId;
  nextLabelId += 1;
  return id;
}

export function newCommentId(): number {
  const id = nextCommentId;
  nextCommentId += 1;
  return id;
}

/** A numeric REST id for an issue or pull request: unique per repo, stable across reads. */
export function issueRestId(repo: Repo, number: number): number {
  return repo.id * 100000 + number;
}

// ---------------------------------------------------------------------------
// Global (GraphQL) ids: base64 of a typed string, decodable by node(id:).
// ---------------------------------------------------------------------------

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.id);
}

export function issueGlobalId(repo: Repo, number: number): string {
  return globalId('Issue', repo.id, number);
}

export function pullGlobalId(repo: Repo, number: number): string {
  return globalId('PullRequest', repo.id, number);
}

export function userGlobalId(u: GHUser): string {
  return globalId('User', u.id);
}

export function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return globalId('IssueComment', repo.id, issueNumber, commentId);
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2 || parts[0] === '') return null;
    return { kind: parts[0]!, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

export function repoByDatabaseId(id: number): Repo | null {
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return null;
}
