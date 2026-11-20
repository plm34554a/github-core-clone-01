// The HTTP surface: one server routing the env's health probe, git smart HTTP, REST v3, GraphQL and
// MCP, all over the shared store. Every API reply is JSON with a request id, as GitHub answers.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { addComment, addIssue, branchTip, createPull, mergePull, pullFiles } from './domain.ts';
import {
  buildTree,
  commitTreeSha,
  flattenTree,
  getCommit,
  handleInfoRefs,
  handleReceivePack,
  handleUploadPack,
  makeCommit,
  storeObject,
  walkCommits,
} from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { branchJson, commentJson, commitJson, contentsJson, issueJson, labelJson, pullJson, refJson, repoJson, userJson } from './serialize.ts';
import {
  createRepo,
  deleteRepo,
  findRepo,
  newLabelId,
  repoNameTaken,
  reposOfOwner,
  tickIso,
  USERS,
  VIEWER,
  VIEWER_LOGIN,
  type Repo,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `F${requestCounter.toString(16).toUpperCase().padStart(7, '0')}:A1B2:${requestCounter.toString(16).toUpperCase()}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': nextRequestId() });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
}

function validationFailed(res: ServerResponse, message = 'Validation Failed'): void {
  sendJson(res, 422, { message, documentation_url: 'https://docs.github.com/rest' });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > 256 * 1024 * 1024) throw new Error('body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Pagination (Link: rel="next", same origin, per_page respected)
// ---------------------------------------------------------------------------

interface Page {
  perPage: number;
  page: number;
}

function pageOf(url: URL): Page {
  const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

function paginate<T>(req: IncomingMessage, res: ServerResponse, url: URL, items: T[]): T[] {
  const { perPage, page } = pageOf(url);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const next = new URL(url.pathname, `http://${host}`);
    for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    const last = new URL(url.pathname, `http://${host}`);
    for (const [key, value] of url.searchParams) last.searchParams.set(key, value);
    last.searchParams.set('page', String(Math.ceil(items.length / perPage)));
    last.searchParams.set('per_page', String(perPage));
    res.setHeader('link', `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`);
  }
  return slice;
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function parseJsonBody(raw: Buffer): Json | null {
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Json;
  } catch {
    return null;
  }
}

function repoFromParams(res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = findRepo(owner, name);
  if (repo === null) {
    notFound(res);
    return null;
  }
  return repo;
}

/** Create a commit on a branch from a file-map mutation (contents API machinery). */
function commitFileChange(
  repo: Repo,
  branch: string,
  mutate: (files: Map<string, { sha: string; mode: string }>) => void,
  message: string,
): { commitSha: string } {
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  const files = tip !== undefined ? flattenTree(repo, commitTreeSha(repo, tip) ?? '') : new Map<string, { sha: string; mode: string }>();
  mutate(files);
  const tree = buildTree(repo, files);
  const commitSha = makeCommit(repo, tree, tip !== undefined ? [tip] : [], message);
  repo.refs.set(refName, commitSha);
  repo.updatedAt = tickIso();
  return { commitSha };
}

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, rawBody: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const segments = url.pathname.replace(/^\/api\/v3\/?/, '').split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));

  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        rate_limit_url: '/api/v3/rate_limit',
      }, { 'x-oauth-scopes': 'repo, read:org, write:org, admin:org' });
      return;
    }
    notFound(res);
    return;
  }

  const [head, second, third] = segments;

  if (head === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '3.10.0', is_authenticated: true });
    return;
  }

  if (head === 'user' && segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, userJson(VIEWER));
      return;
    }
    notFound(res);
    return;
  }

  if (head === 'users' && segments.length === 2 && method === 'GET') {
    const found = USERS[second!];
    if (found === undefined) notFound(res);
    else sendJson(res, 200, userJson(found));
    return;
  }

  if (head === 'user' && second === 'repos') {
    if (method === 'POST') {
      const body = parseJsonBody(rawBody);
      if (body === null) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        validationFailed(res, 'Repository creation failed.');
        return;
      }
      if (repoNameTaken(VIEWER_LOGIN, name)) {
        sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
        return;
      }
      const repo = createRepo(VIEWER_LOGIN, name, typeof body.description === 'string' ? body.description : '', body.private === true);
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const mine = reposOfOwner(VIEWER_LOGIN).sort((a, b) => a.id - b.id);
      sendJson(res, 200, paginate(req, res, url, mine).map((repo) => repoJson(repo)));
      return;
    }
    notFound(res);
    return;
  }

  if (head !== 'repos' || second === undefined || third === undefined) {
    notFound(res);
    return;
  }

  const owner = second;
  const repoName = third;
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') {
      const repo = repoFromParams(res, owner, repoName);
      if (repo !== null) sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const repo = repoFromParams(res, owner, repoName);
      if (repo === null) return;
      const body = parseJsonBody(rawBody);
      if (body === null) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
      repo.updatedAt = tickIso();
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      const repo = repoFromParams(res, owner, repoName);
      if (repo === null) return;
      deleteRepo(repo);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    notFound(res);
    return;
  }

  const repo = repoFromParams(res, owner, repoName);
  if (repo === null) return;
  const resource = rest[0]!;

  // --- branches -------------------------------------------------------------
  if (resource === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const names = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length)).sort();
      sendJson(res, 200, paginate(req, res, url, names).map((name) => branchJson(repo, name)));
      return;
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      if (!repo.refs.has(`refs/heads/${branch}`)) {
        notFound(res);
        return;
      }
      sendJson(res, 200, branchJson(repo, branch));
      return;
    }
    notFound(res);
    return;
  }

  // --- commits ---------------------------------------------------------------
  if (resource === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const shaParam = url.searchParams.get('sha');
      let start: string | undefined;
      if (shaParam !== null && shaParam !== '') {
        start = repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(shaParam) ?? (getCommit(repo, shaParam) !== null ? shaParam : undefined);
      } else {
        start = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      }
      if (start === undefined) {
        sendJson(res, 409, { message: 'Git Repository is empty.', documentation_url: 'https://docs.github.com/rest' });
        return;
      }
      const shas = walkCommits(repo, start);
      const commits = paginate(req, res, url, shas).map((sha) => commitJson(repo, sha)).filter((c) => c !== null);
      sendJson(res, 200, commits);
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      const commit = commitJson(repo, rest[1]!);
      if (commit === null) notFound(res);
      else sendJson(res, 200, commit);
      return;
    }
    notFound(res);
    return;
  }

  // --- git refs ----------------------------------------------------------------
  if (resource === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = parseJsonBody(rawBody);
      if (body === null) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || sha === '' || !repo.objects.has(sha)) {
        validationFailed(res);
        return;
      }
      if (repo.refs.has(ref)) {
        validationFailed(res, 'Reference already exists');
        return;
      }
      repo.refs.set(ref, sha);
      repo.updatedAt = tickIso();
      sendJson(res, 201, refJson(ref, sha, repo.objects.get(sha)?.type ?? 'commit'));
      return;
    }
    if (method === 'GET') {
      if (rest.length === 2) {
        const all = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([ref, sha]) => refJson(ref, sha, repo.objects.get(sha)?.type ?? 'commit'));
        sendJson(res, 200, paginate(req, res, url, all));
        return;
      }
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) {
        const prefix = `${ref}/`;
        const under = [...repo.refs.entries()].filter(([r]) => r.startsWith(prefix)).map(([r, s]) => refJson(r, s, repo.objects.get(s)?.type ?? 'commit'));
        if (under.length > 0) {
          sendJson(res, 200, under);
          return;
        }
        notFound(res);
        return;
      }
      sendJson(res, 200, refJson(ref, sha, repo.objects.get(sha)?.type ?? 'commit'));
      return;
    }
    if (method === 'DELETE' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      if (!repo.refs.has(ref)) {
        notFound(res);
        return;
      }
      repo.refs.delete(ref);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    notFound(res);
    return;
  }

  // --- contents ------------------------------------------------------------
  if (resource === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const refParam = url.searchParams.get('ref');
      let commitSha: string | undefined;
      if (refParam !== null && refParam !== '') {
        commitSha = repo.refs.get(`refs/heads/${refParam}`) ?? repo.refs.get(refParam) ?? (getCommit(repo, refParam) !== null ? refParam : undefined);
      } else {
        commitSha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      }
      if (commitSha === undefined) {
        notFound(res);
        return;
      }
      const tree = commitTreeSha(repo, commitSha);
      if (tree === null) {
        notFound(res);
        return;
      }
      const contents = contentsJson(repo, tree, path);
      if (contents === null) notFound(res);
      else sendJson(res, 200, contents);
      return;
    }
    if (method === 'PUT') {
      const body = parseJsonBody(rawBody);
      if (body === null) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const branch = typeof body.branch === 'string' ? body.branch.replace(/^refs\/heads\//, '') : repo.defaultBranch;
      const refName = `refs/heads/${branch}`;
      const tip = repo.refs.get(refName);
      if (tip === undefined && repo.refs.size > 0) {
        notFound(res);
        return;
      }
      const files = tip !== undefined ? flattenTree(repo, commitTreeSha(repo, tip) ?? '') : new Map<string, { sha: string; mode: string }>();
      const existing = files.get(path);
      const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
      if (existing !== undefined) {
        if (givenSha === undefined) {
          validationFailed(res, 'sha is required when updating a file');
          return;
        }
        if (givenSha !== existing.sha) {
          sendJson(res, 409, { message: `Conflict: the file's sha does not match`, documentation_url: 'https://docs.github.com/rest' });
          return;
        }
      }
      const contentBase64 = typeof body.content === 'string' ? body.content : '';
      const data = Buffer.from(contentBase64.replace(/\s/g, ''), 'base64');
      const blobSha = storeObject(repo, 'blob', data);
      const message = typeof body.message === 'string' && body.message !== '' ? body.message : existing !== undefined ? `Update ${path}` : `Create ${path}`;
      const { commitSha } = commitFileChange(repo, branch, (map) => {
        map.set(path, { sha: blobSha, mode: existing?.mode ?? '100644' });
      }, message);
      const commit = getCommit(repo, commitSha);
      sendJson(res, existing !== undefined ? 200 : 201, {
        content: {
          name: path.slice(path.lastIndexOf('/') + 1),
          path,
          sha: blobSha,
          size: data.length,
          type: 'file',
          encoding: 'base64',
          url: '',
          html_url: '',
          git_url: '',
          download_url: null,
          _links: {},
        },
        commit: { sha: commitSha, message: commit?.message ?? message, tree: { sha: commit?.tree ?? '' }, parents: (commit?.parents ?? []).map((p) => ({ sha: p })) },
      });
      return;
    }
    if (method === 'DELETE') {
      const body = parseJsonBody(rawBody);
      if (body === null) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const branch = typeof body.branch === 'string' ? body.branch.replace(/^refs\/heads\//, '') : repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) {
        notFound(res);
        return;
      }
      const files = flattenTree(repo, commitTreeSha(repo, tip) ?? '');
      const existing = files.get(path);
      if (existing === undefined) {
        notFound(res);
        return;
      }
      const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
      if (givenSha !== undefined && givenSha !== existing.sha) {
        sendJson(res, 409, { message: 'Conflict: the file\'s sha does not match' });
        return;
      }
      const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${path}`;
      const { commitSha } = commitFileChange(repo, branch, (map) => {
        map.delete(path);
      }, message);
      const commit = getCommit(repo, commitSha);
      sendJson(res, 200, { content: null, commit: { sha: commitSha, message: commit?.message ?? message, tree: { sha: commit?.tree ?? '' }, parents: (commit?.parents ?? []).map((p) => ({ sha: p })) } });
      return;
    }
    notFound(res);
    return;
  }

  // --- labels ---------------------------------------------------------------
  if (resource === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const body = parseJsonBody(rawBody);
      if (body === null) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        validationFailed(res);
        return;
      }
      if (repo.labels.has(name)) {
        validationFailed(res, 'Validation Failed: label already exists');
        return;
      }
      const label = {
        id: newLabelId(),
        name,
        color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
        description: typeof body.description === 'string' ? body.description : null,
      };
      repo.labels.set(name, label);
      sendJson(res, 201, labelJson(label));
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      const labels = paginate(req, res, url, [...repo.labels.values()]);
      sendJson(res, 200, labels.map((label) => labelJson(label)));
      return;
    }
    if (method === 'GET' && rest.length === 2) {
      const label = repo.labels.get(rest[1]!);
      if (label === undefined) notFound(res);
      else sendJson(res, 200, labelJson(label));
      return;
    }
    notFound(res);
    return;
  }

  // --- issues ---------------------------------------------------------------
  if (resource === 'issues') {
    if (method === 'POST' && rest.length === 1) {
      const body = parseJsonBody(rawBody);
      if (body === null) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') {
        validationFailed(res);
        return;
      }
      const labelNames = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const labelName of labelNames) {
        if (!repo.labels.has(labelName)) {
          validationFailed(res, `Validation Failed: label '${labelName}' does not exist`);
          return;
        }
      }
      const issue = addIssue(repo, { title, body: typeof body.body === 'string' ? body.body : '', labelNames });
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      const state = url.searchParams.get('state') ?? 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      const labelsParam = url.searchParams.get('labels');
      if (labelsParam !== null && labelsParam !== '') {
        const wanted = labelsParam.split(',').map((s) => s.trim()).filter((s) => s !== '');
        list = list.filter((issue) => wanted.every((w) => issue.labelNames.includes(w)));
      }
      const direction = url.searchParams.get('direction') ?? 'desc';
      list.sort((a, b) => a.number - b.number);
      if (direction !== 'asc') list.reverse();
      const page = paginate(req, res, url, list);
      sendJson(res, 200, page.map((issue) => issueJson(repo, issue)));
      return;
    }
    if (rest.length >= 2) {
      const number = Number.parseInt(rest[1]!, 10);
      const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
      if (rest.length === 2 && method === 'GET') {
        if (issue === undefined) notFound(res);
        else sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (rest.length === 2 && method === 'PATCH') {
        if (issue === undefined) {
          notFound(res);
          return;
        }
        const body = parseJsonBody(rawBody);
        if (body === null) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
        if (Array.isArray(body.labels)) {
          const names = body.labels.filter((l): l is string => typeof l === 'string');
          for (const labelName of names) {
            if (!repo.labels.has(labelName)) {
              validationFailed(res, `Validation Failed: label '${labelName}' does not exist`);
              return;
            }
          }
          issue.labelNames = names;
        }
        issue.updatedAt = tickIso();
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (issue === undefined) {
          notFound(res);
          return;
        }
        if (method === 'POST') {
          const body = parseJsonBody(rawBody);
          if (body === null) {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          const comment = addComment(repo, issue, typeof body.body === 'string' ? body.body : '');
          sendJson(res, 201, commentJson(repo, issue, comment));
          return;
        }
        if (method === 'GET') {
          const page = paginate(req, res, url, issue.comments);
          sendJson(res, 200, page.map((comment) => commentJson(repo, issue, comment)));
          return;
        }
      }
      if (rest.length === 3 && rest[2] === 'labels' && method === 'GET') {
        if (issue === undefined) {
          notFound(res);
          return;
        }
        sendJson(res, 200, issue.labelNames.map((name) => {
          const label = repo.labels.get(name);
          return label !== undefined ? labelJson(label) : { name };
        }));
        return;
      }
    }
    notFound(res);
    return;
  }

  // --- pull requests ----------------------------------------------------------
  if (resource === 'pulls') {
    if (method === 'POST' && rest.length === 1) {
      const body = parseJsonBody(rawBody);
      if (body === null) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const stripOwner = (ref: string): string => (ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref);
      const headRef = stripOwner(typeof body.head === 'string' ? body.head : '');
      const baseRef = stripOwner(typeof body.base === 'string' ? body.base : '');
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '' || headRef === '' || baseRef === '') {
        validationFailed(res);
        return;
      }
      const result = createPull(repo, { title, body: typeof body.body === 'string' ? body.body : '', headRef, baseRef });
      if ('error' in result) {
        validationFailed(res, result.error);
        return;
      }
      sendJson(res, 201, pullJson(repo, result.pull));
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      const state = url.searchParams.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((pull) => pull.state === state);
      const direction = url.searchParams.get('direction') ?? 'desc';
      list.sort((a, b) => a.number - b.number);
      if (direction !== 'asc') list.reverse();
      const page = paginate(req, res, url, list);
      sendJson(res, 200, page.map((pull) => pullJson(repo, pull)));
      return;
    }
    if (rest.length >= 2) {
      const number = Number.parseInt(rest[1]!, 10);
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (rest.length === 2 && method === 'GET') {
        if (pull === undefined) notFound(res);
        else sendJson(res, 200, pullJson(repo, pull));
        return;
      }
      if (rest.length === 2 && method === 'PATCH') {
        if (pull === undefined) {
          notFound(res);
          return;
        }
        const body = parseJsonBody(rawBody);
        if (body === null) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        if (typeof body.title === 'string') pull.title = body.title;
        if (typeof body.body === 'string') pull.body = body.body;
        if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed') && !pull.merged) pull.state = body.state;
        pull.updatedAt = tickIso();
        sendJson(res, 200, pullJson(repo, pull));
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (pull === undefined) {
          notFound(res);
          return;
        }
        const files = pullFiles(repo, pull).map((file) => ({
          sha: file.sha,
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
        }));
        sendJson(res, 200, paginate(req, res, url, files));
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (pull === undefined) {
          notFound(res);
          return;
        }
        if (method === 'GET') {
          if (pull.merged) {
            res.writeHead(204, { 'x-github-request-id': nextRequestId() });
            res.end();
          } else {
            notFound(res);
          }
          return;
        }
        if (method === 'PUT') {
          const body = parseJsonBody(rawBody);
          if (body === null) {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          if (pull.merged || pull.state !== 'open') {
            sendJson(res, 405, { message: 'Pull Request is not mergeable', documentation_url: 'https://docs.github.com/rest' });
            return;
          }
          const methodRaw = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
          const mergeMethod = methodRaw === 'squash' ? 'squash' : methodRaw === 'rebase' ? 'rebase' : 'merge';
          const result = mergePull(repo, pull, mergeMethod);
          if ('error' in result) {
            sendJson(res, 405, { message: 'Pull Request is not mergeable', documentation_url: 'https://docs.github.com/rest' });
            return;
          }
          sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
          return;
        }
      }
    }
    notFound(res);
    return;
  }

  notFound(res);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method === 'GET' && path === '/') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const raw = await readBody(req);
    const result = handleMcp(raw.toString('utf8'), typeof req.headers.authorization === 'string' && req.headers.authorization !== '');
    if (result.body === null) {
      res.writeHead(result.status, { 'x-github-request-id': nextRequestId() });
      res.end();
    } else {
      res.writeHead(result.status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(result.body), 'x-github-request-id': nextRequestId() });
      res.end(result.body);
    }
    return;
  }

  if (path === '/api/graphql') {
    if (typeof req.headers.authorization !== 'string' || req.headers.authorization === '') {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    if (method === 'GET') {
      const query = url.searchParams.get('query') ?? '';
      sendJson(res, 200, executeGraphQL({ query }));
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    if (Array.isArray(parsed)) {
      sendJson(res, 200, parsed.map((entry) => executeGraphQL((entry ?? {}) as Record<string, unknown>)));
      return;
    }
    sendJson(res, 200, executeGraphQL((parsed ?? {}) as Record<string, unknown>));
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (typeof req.headers.authorization !== 'string' || req.headers.authorization === '') {
      sendJson(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
      return;
    }
    const raw = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    await handleRest(req, res, url, raw);
    return;
  }

  const gitMatch = GIT_PATH.exec(path);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1]!);
    const name = decodeURIComponent(gitMatch[2]!);
    const action = gitMatch[3]!;
    const repo = findRepo(owner, name);
    if (repo === null) {
      sendRaw(res, 404, 'text/plain', Buffer.from('not found\n'));
      return;
    }
    const protocolV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (action === 'info/refs' && method === 'GET') {
      const result = handleInfoRefs(repo, url.searchParams.get('service') ?? '', protocolV2);
      sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    if (action === 'git-upload-pack' && method === 'POST') {
      const raw = await readBody(req);
      const result = handleUploadPack(repo, raw, protocolV2);
      sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    if (action === 'git-receive-pack' && method === 'POST') {
      const raw = await readBody(req);
      const result = handleReceivePack(repo, raw);
      sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    notFound(res);
    return;
  }

  notFound(res);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch(() => {
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      } catch {
        // The socket is gone; nothing more to do.
      }
    });
  });
}
