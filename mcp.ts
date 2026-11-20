// The MCP endpoint: Streamable HTTP JSON-RPC at /mcp. Modern revision 2026-07-28 via
// server/discover (with the legacy initialize handshake answered too), a static tools/list, and
// tools/call over the same store as REST and GraphQL — an object made here is the same object there.

import { addIssue, createPull, mergePull } from './domain.ts';
import { issueJson, pullJson, repoJson } from './serialize.ts';
import {
  createRepo,
  findRepo,
  repoNameTaken,
  reposOfOwner,
  VIEWER_LOGIN,
  type Repo,
} from './store.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, additionalProperties: true, required } };
}

const TOOLS: ToolDef[] = [
  tool('create_repo', 'Create a new repository for the authenticated user.', {
    name: { type: 'string', description: 'Repository name' },
    description: { type: 'string', description: 'Repository description' },
    private: { type: 'boolean', description: 'Whether the repository is private' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'Repository owner login' },
    repo: { type: 'string', description: 'Repository name' },
  }, ['owner', 'repo']),
  tool('list_repos', 'List repositories owned by a user.', {
    owner: { type: 'string', description: 'Owner login (defaults to the authenticated user)' },
  }, []),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'Repository owner login' },
    repo: { type: 'string', description: 'Repository name' },
    title: { type: 'string', description: 'Issue title' },
    body: { type: 'string', description: 'Issue body' },
  }, ['owner', 'repo', 'title']),
  tool('get_issue', 'Get one issue by number.', {
    owner: { type: 'string', description: 'Repository owner login' },
    repo: { type: 'string', description: 'Repository name' },
    issue_number: { type: 'number', description: 'Issue number' },
  }, ['owner', 'repo', 'issue_number']),
  tool('list_issues', 'List issues in a repository.', {
    owner: { type: 'string', description: 'Repository owner login' },
    repo: { type: 'string', description: 'Repository name' },
    state: { type: 'string', description: 'Filter by state: open, closed or all' },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request between two branches.', {
    owner: { type: 'string', description: 'Repository owner login' },
    repo: { type: 'string', description: 'Repository name' },
    title: { type: 'string', description: 'Pull request title' },
    head: { type: 'string', description: 'Head branch name' },
    base: { type: 'string', description: 'Base branch name' },
    body: { type: 'string', description: 'Pull request body' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request (squash by default).', {
    owner: { type: 'string', description: 'Repository owner login' },
    repo: { type: 'string', description: 'Repository name' },
    pull_number: { type: 'number', description: 'Pull request number' },
  }, ['owner', 'repo', 'pull_number']),
];

const TOOLS_JSON = JSON.stringify({ tools: TOOLS });

interface ToolOutcome {
  value?: unknown;
  errorText?: string;
}

function needRepo(owner: unknown, repo: unknown): Repo | { errorText: string } {
  const found = findRepo(String(owner ?? ''), String(repo ?? ''));
  if (found === null) return { errorText: `repository ${String(owner)}/${String(repo)} not found` };
  return found;
}

function runTool(name: string, args: Record<string, unknown>): ToolOutcome | 'unknown-tool' {
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      if (repoName === '') return { errorText: 'name is required' };
      if (repoNameTaken(VIEWER_LOGIN, repoName)) return { errorText: `repository ${repoName} already exists` };
      const repo = createRepo(VIEWER_LOGIN, repoName, String(args.description ?? ''), args.private === true);
      return { value: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = needRepo(args.owner, args.repo);
      if ('errorText' in repo) return repo;
      return { value: repoJson(repo) };
    }
    case 'list_repos': {
      const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER_LOGIN;
      return { value: reposOfOwner(owner).map((repo) => repoJson(repo)) };
    }
    case 'create_issue': {
      const repo = needRepo(args.owner, args.repo);
      if ('errorText' in repo) return repo;
      const title = String(args.title ?? '');
      if (title === '') return { errorText: 'title is required' };
      const issue = addIssue(repo, { title, body: String(args.body ?? '') });
      return { value: issueJson(repo, issue) };
    }
    case 'get_issue': {
      const repo = needRepo(args.owner, args.repo);
      if ('errorText' in repo) return repo;
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return { errorText: `issue ${String(args.issue_number)} not found` };
      return { value: issueJson(repo, issue) };
    }
    case 'list_issues': {
      const repo = needRepo(args.owner, args.repo);
      if ('errorText' in repo) return repo;
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
      list.sort((a, b) => a.number - b.number);
      return { value: list.map((issue) => issueJson(repo, issue)) };
    }
    case 'create_pull_request': {
      const repo = needRepo(args.owner, args.repo);
      if ('errorText' in repo) return repo;
      const result = createPull(repo, {
        title: String(args.title ?? ''),
        body: String(args.body ?? ''),
        headRef: String(args.head ?? ''),
        baseRef: String(args.base ?? ''),
      });
      if ('error' in result) return { errorText: result.error };
      return { value: pullJson(repo, result.pull) };
    }
    case 'merge_pull_request': {
      const repo = needRepo(args.owner, args.repo);
      if ('errorText' in repo) return repo;
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return { errorText: `pull request ${String(args.pull_number)} not found` };
      const result = mergePull(repo, pull, 'squash');
      if ('error' in result) return { errorText: result.error === 'conflict' ? 'pull request is not mergeable' : 'pull request is not open' };
      return { value: { ...pullJson(repo, pull), sha: result.sha, merged: true } };
    }
    default:
      return 'unknown-tool';
  }
}

export interface McpResult {
  status: number;
  body: string | null;
}

/**
 * Handle one POST /mcp body. `hasAuth` is whether an Authorization header was present.
 * Parse errors answer 400/-32700 before auth is judged (the body names no method); a parseable
 * tools/call without credentials answers 401, as the contract requires.
 */
export function handleMcp(bodyText: string, hasAuth: boolean): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }) };
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and are answered with an empty 202.
  if (id === undefined) return { status: 202, body: null };

  if (!hasAuth) {
    return { status: 401, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Unauthorized' } }) };
  }

  const ok = (result: unknown): McpResult => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) });
  const rpcError = (code: number, message: string): McpResult => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
  });

  switch (method) {
    case 'server/discover':
      return ok({
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-06-18';
      return ok({ protocolVersion: chosen, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return { status: 200, body: `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${TOOLS_JSON}}` };
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
      const def = TOOLS.find((t) => t.name === toolName);
      if (def === undefined) return rpcError(-32602, `unknown tool: ${toolName}`);
      const missing = (def.inputSchema.required as string[]).filter((key) => toolArgs[key] === undefined || toolArgs[key] === null || toolArgs[key] === '');
      if (missing.length > 0) {
        return ok({
          content: [{ type: 'text', text: `missing required arguments: ${missing.join(', ')}` }],
          isError: true,
        });
      }
      const outcome = runTool(toolName, toolArgs);
      if (outcome === 'unknown-tool') return rpcError(-32602, `unknown tool: ${toolName}`);
      if (outcome.errorText !== undefined) {
        return ok({ content: [{ type: 'text', text: outcome.errorText }], isError: true });
      }
      return ok({
        content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
        structuredContent: outcome.value,
      });
    }
    default:
      return rpcError(-32601, `method not found: ${method}`);
  }
}
