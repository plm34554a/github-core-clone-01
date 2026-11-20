// A small GraphQL implementation for the forge's schema: lexer, parser (operations, fragments,
// variables, input objects, directives), and a resolver-driven executor with connections, cursors,
// introspection, node(id:) and the mutations the suite drives. It runs over the same store as REST,
// so global ids and objects agree across surfaces.

import { addComment, addIssue, createPull, mergePull, pullFiles, pullMergeable, branchTip } from './domain.ts';
import { getCommit } from './git.ts';
import {
  commentGlobalId,
  createRepo,
  decodeGlobalId,
  findRepo,
  globalId,
  issueGlobalId,
  issueRestId,
  pullGlobalId,
  repoByDatabaseId,
  repoGlobalId,
  tickIso,
  USERS,
  userGlobalId,
  VIEWER,
  VIEWER_LOGIN,
  type GHUser,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// Lexer / parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  directives: Record<string, Record<string, ValueNode>>;
  selectionSet?: SelectionNode[];
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition?: string; directives: Record<string, Record<string, ValueNode>>; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string; directives: Record<string, Record<string, ValueNode>> };

interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  varDefaults: Record<string, ValueNode>;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  typeCondition: string;
  selectionSet: SelectionNode[];
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        const raw = source.slice(i + 3, end === -1 ? source.length : end);
        tokens.push(`"${raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(value));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j]!)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  private skipType(): void {
    // A type reference: Name, [Type], with optional trailing !.
    if (this.peek() === '[') {
      this.next();
      this.skipType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.pos < this.tokens.length) {
      const head = this.peek()!;
      if (head === '{') {
        operations.push({ type: 'query', varDefaults: {}, selectionSet: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation' || head === 'subscription') {
        const type = this.next() === 'mutation' ? 'mutation' : 'query';
        let name: string | undefined;
        if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{' && this.peek() !== '@') name = this.next();
        const varDefaults: Record<string, ValueNode> = {};
        if (this.peek() === '(') {
          this.next();
          while (this.peek() !== ')') {
            this.expect('$');
            const varName = this.next();
            this.expect(':');
            this.skipType();
            if (this.peek() === '=') {
              this.next();
              varDefaults[varName] = this.parseValue();
            }
            this.parseDirectives(); // variable directives, ignored
          }
          this.expect(')');
        }
        this.parseDirectives();
        operations.push({ type, name, varDefaults, selectionSet: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        this.parseDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private parseDirectives(): Record<string, Record<string, ValueNode>> {
    const directives: Record<string, Record<string, ValueNode>> = {};
    while (this.peek() === '@') {
      this.next();
      const name = this.next();
      directives[name] = this.peek() === '(' ? this.parseArgs() : {};
    }
    return directives;
  }

  private parseArgs(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expect('(');
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token === '[') {
      const items: ValueNode[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Record<string, ValueNode> = {};
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields[name] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'null') return { kind: 'null' };
    if (token === 'true') return { kind: 'bool', value: true };
    if (token === 'false') return { kind: 'bool', value: false };
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          const directives = this.parseDirectives();
          selections.push({ kind: 'inline', typeCondition, directives, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.next();
          const directives = this.parseDirectives();
          selections.push({ kind: 'spread', name, directives });
        }
        continue;
      }
      let name = this.next();
      let alias: string | undefined;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args = this.peek() === '(' ? this.parseArgs() : {};
      const directives = this.parseDirectives();
      const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : undefined;
      selections.push({ kind: 'field', alias, name, args, directives, selectionSet });
    }
    this.expect('}');
    return selections;
  }
}

// ---------------------------------------------------------------------------
// Schema metadata (introspection)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'user', 'organization', 'search', 'rateLimit', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'createRepository'],
  User: ['id', 'login', 'name', 'email', 'databaseId', 'url', 'avatarUrl', 'isViewer', 'createdAt', 'updatedAt'],
  Organization: ['id', 'login', 'name', 'email', 'databaseId', 'url', 'createdAt', 'updatedAt'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled', 'url', 'createdAt', 'updatedAt',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'ref', 'labels', 'isFork', 'stargazerCount', 'forkCount',
  ],
  Ref: ['id', 'name', 'prefix', 'qualifiedName', 'target'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'committedDate', 'authoredDate', 'author', 'tree', 'url'],
  GitActor: ['name', 'email', 'date', 'user'],
  Tree: ['id', 'oid'],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'bodyText', 'state', 'author', 'labels', 'comments',
    'createdAt', 'updatedAt', 'closedAt', 'url', 'repository',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommit',
    'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'author', 'files',
    'createdAt', 'updatedAt', 'closedAt', 'url', 'repository', 'isDraft',
  ],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  LabelEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CreateRepositoryPayload: ['repository', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'ofType', 'possibleTypes', 'inputFields', 'specifiedByURL'],
  __Field: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __Directive: ['name', 'description', 'locations', 'args'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
  RepositoryVisibility: ['PUBLIC', 'PRIVATE', 'INTERNAL'],
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

type GObj = Record<string, unknown> & { __type: string };

interface Ctx {
  vars: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function gobj(type: string, data: Record<string, unknown>): GObj {
  return { __type: type, ...data };
}

function userObj(u: GHUser): GObj {
  return gobj(u.type === 'Organization' ? 'Organization' : 'User', { user: u });
}

function repoObj(repo: Repo): GObj {
  return gobj('Repository', { repo });
}

function issueObj(repo: Repo, issue: Issue): GObj {
  return gobj('Issue', { repo, issue });
}

function pullObj(repo: Repo, pull: PullRequest): GObj {
  return gobj('PullRequest', { repo, pull });
}

function evalValue(node: ValueNode, ctx: Ctx): unknown {
  switch (node.kind) {
    case 'var':
      return ctx.vars[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evalValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = evalValue(value, ctx);
      return out;
    }
  }
}

function evalArgs(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = evalValue(value, ctx);
  return out;
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
    return match === null ? -1 : Number.parseInt(match[1]!, 10);
  } catch {
    return -1;
  }
}

/** Slice `items` (already in final order) per first/after and wrap as a connection object. */
function connection(type: string, edgeType: string, items: GObj[], args: Record<string, unknown>): GObj {
  const afterIndex = indexOfCursor(args.after);
  const start = afterIndex + 1;
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : 100;
  const slice = items.slice(start, start + first);
  const edges = slice.map((node, i) => gobj(edgeType, { node, cursor: cursorOf(start + i) }));
  return gobj(type, {
    nodesRaw: slice,
    edgesRaw: edges,
    totalCount: items.length,
    hasNextPage: start + slice.length < items.length,
    hasPreviousPage: start > 0,
    startCursor: edges.length > 0 ? edges[0]!.cursor : null,
    endCursor: edges.length > 0 ? edges[edges.length - 1]!.cursor : null,
  });
}

function sortedIssues(repo: Repo, args: Record<string, unknown>): Issue[] {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  list.sort((a, b) => a.number - b.number);
  if (direction !== 'ASC') list.reverse();
  return list;
}

function sortedPulls(repo: Repo, args: Record<string, unknown>): PullRequest[] {
  let list = [...repo.pulls.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    list = list.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  list.sort((a, b) => a.number - b.number);
  if (direction !== 'ASC') list.reverse();
  return list;
}

function nodeForId(id: string): GObj | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const { kind, parts } = decoded;
  if (kind === 'Repository') {
    const repo = repoByDatabaseId(Number(parts[0]));
    return repo === null ? null : repoObj(repo);
  }
  if (kind === 'Issue' || kind === 'PullRequest') {
    const repo = repoByDatabaseId(Number(parts[0]));
    if (repo === null) return null;
    const number = Number(parts[1]);
    if (kind === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueObj(repo, issue);
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : pullObj(repo, pull);
  }
  if (kind === 'User' || kind === 'Organization') {
    const found = Object.values(USERS).find((u) => u.id === Number(parts[0]));
    return found === undefined ? null : userObj(found);
  }
  if (kind === 'IssueComment') {
    const repo = repoByDatabaseId(Number(parts[0]));
    const issue = repo?.issues.get(Number(parts[1]));
    const comment = issue?.comments.find((c) => c.id === Number(parts[2]));
    if (repo === null || repo === undefined || issue === undefined || comment === undefined) return null;
    return gobj('IssueComment', { repo, issueNumber: issue.number, comment });
  }
  return null;
}

function typeObj(name: string): GObj | null {
  if (TYPE_FIELDS[name] !== undefined) return gobj('__Type', { name, kind: 'OBJECT', fieldsList: TYPE_FIELDS[name], enumList: null });
  if (ENUM_VALUES[name] !== undefined) return gobj('__Type', { name, kind: 'ENUM', fieldsList: null, enumList: ENUM_VALUES[name] });
  if (['String', 'Int', 'Float', 'Boolean', 'ID'].includes(name)) return gobj('__Type', { name, kind: 'SCALAR', fieldsList: null, enumList: null });
  return null;
}

function resolveField(typeName: string, source: GObj | null, field: FieldNode, ctx: Ctx): unknown {
  const name = field.name;
  const args = evalArgs(field, ctx);
  if (name === '__typename') return typeName;

  switch (typeName) {
    case 'Query': {
      switch (name) {
        case 'viewer':
          return userObj(VIEWER);
        case 'user':
        case 'organization': {
          const found = USERS[String(args.login ?? '')];
          return found === undefined ? null : userObj(found);
        }
        case 'repository': {
          const repo = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
          return repo === null ? null : repoObj(repo);
        }
        case 'node':
          return typeof args.id === 'string' ? nodeForId(args.id) : null;
        case '__type':
          return typeof args.name === 'string' ? typeObj(args.name) : null;
        case '__schema':
          return gobj('__Schema', {});
        default:
          break;
      }
      break;
    }
    case 'Mutation': {
      const input = (args.input ?? args) as Record<string, unknown>;
      switch (name) {
        case 'createIssue': {
          const repo = repoByDatabaseId(Number(decodeGlobalId(String(input.repositoryId ?? ''))?.parts[0] ?? NaN));
          if (repo === null) {
            ctx.errors.push({ message: 'Could not resolve repository' });
            return null;
          }
          const issue = addIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
          return gobj('CreateIssuePayload', { issue: issueObj(repo, issue), clientMutationId: input.clientMutationId ?? null });
        }
        case 'closeIssue':
        case 'reopenIssue': {
          const target = typeof input.issueId === 'string' ? nodeForId(input.issueId) : null;
          if (target === null || target.__type !== 'Issue') {
            ctx.errors.push({ message: 'Could not resolve issue' });
            return null;
          }
          const issue = target.issue as Issue;
          issue.state = name === 'closeIssue' ? 'closed' : 'open';
          issue.updatedAt = tickIso();
          return gobj('CloseIssuePayload', { issue: target, clientMutationId: input.clientMutationId ?? null });
        }
        case 'createPullRequest': {
          const repo = repoByDatabaseId(Number(decodeGlobalId(String(input.repositoryId ?? ''))?.parts[0] ?? NaN));
          if (repo === null) {
            ctx.errors.push({ message: 'Could not resolve repository' });
            return null;
          }
          const result = createPull(repo, {
            title: String(input.title ?? ''),
            body: String(input.body ?? ''),
            headRef: String(input.headRefName ?? ''),
            baseRef: String(input.baseRefName ?? ''),
          });
          if ('error' in result) {
            ctx.errors.push({ message: result.error });
            return null;
          }
          return gobj('CreatePullRequestPayload', { pullRequest: pullObj(repo, result.pull), clientMutationId: input.clientMutationId ?? null });
        }
        case 'mergePullRequest': {
          const target = typeof input.pullRequestId === 'string' ? nodeForId(input.pullRequestId) : null;
          if (target === null || target.__type !== 'PullRequest') {
            ctx.errors.push({ message: 'Could not resolve pull request' });
            return null;
          }
          const repo = target.repo as Repo;
          const pull = target.pull as PullRequest;
          const methodRaw = String(input.mergeMethod ?? 'MERGE').toLowerCase();
          const method = methodRaw === 'squash' ? 'squash' : methodRaw === 'rebase' ? 'rebase' : 'merge';
          const result = mergePull(repo, pull, method);
          if ('error' in result) {
            ctx.errors.push({ message: result.error === 'conflict' ? 'Pull Request is not mergeable' : 'Pull Request is not open' });
            return null;
          }
          return gobj('MergePullRequestPayload', { pullRequest: target, clientMutationId: input.clientMutationId ?? null });
        }
        case 'addComment': {
          const target = typeof input.subjectId === 'string' ? nodeForId(input.subjectId) : null;
          if (target === null || target.__type !== 'Issue') {
            ctx.errors.push({ message: 'Could not resolve subject' });
            return null;
          }
          const repo = target.repo as Repo;
          const issue = target.issue as Issue;
          const comment = addComment(repo, issue, String(input.body ?? ''));
          const node = gobj('IssueComment', { repo, issueNumber: issue.number, comment });
          return gobj('AddCommentPayload', {
            commentEdge: gobj('IssueCommentEdge', { node, cursor: cursorOf(issue.comments.length - 1) }),
            subject: target,
            clientMutationId: input.clientMutationId ?? null,
          });
        }
        case 'createRepository': {
          const repo = createRepo(VIEWER_LOGIN, String(input.name ?? ''), String(input.description ?? ''), String(input.visibility ?? 'PUBLIC') === 'PRIVATE');
          return gobj('CreateRepositoryPayload', { repository: repoObj(repo), clientMutationId: input.clientMutationId ?? null });
        }
        default:
          break;
      }
      break;
    }
    case 'User':
    case 'Organization': {
      const u = source!.user as GHUser;
      switch (name) {
        case 'id':
          return u.type === 'Organization' ? globalId('Organization', u.id) : userGlobalId(u);
        case 'login':
          return u.login;
        case 'name':
          return u.name;
        case 'email':
          return u.email;
        case 'databaseId':
          return u.id;
        case 'url':
          return `https://github.com/${u.login}`;
        case 'avatarUrl':
          return '';
        case 'isViewer':
          return u.login === VIEWER_LOGIN;
        case 'createdAt':
        case 'updatedAt':
          return '2025-01-01T00:00:00Z';
        default:
          break;
      }
      break;
    }
    case 'Repository': {
      const repo = source!.repo as Repo;
      switch (name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'description':
          return repo.description === '' ? null : repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'owner': {
          const found = USERS[repo.owner];
          return found === undefined ? userObj({ login: repo.owner, id: 0, name: repo.owner, email: '', type: 'User' }) : userObj(found);
        }
        case 'defaultBranchRef': {
          const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return sha === undefined ? null : gobj('Ref', { repo, name: repo.defaultBranch, qualifiedName: `refs/heads/${repo.defaultBranch}`, sha });
        }
        case 'ref': {
          const qualified = String(args.qualifiedName ?? '');
          const sha = repo.refs.get(qualified);
          if (sha === undefined) return null;
          return gobj('Ref', { repo, name: qualified.replace(/^refs\/(heads|tags)\//, ''), qualifiedName: qualified, sha });
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
        case 'hasPullRequestsEnabled':
          return true;
        case 'isFork':
          return false;
        case 'stargazerCount':
        case 'forkCount':
          return 0;
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}`;
        case 'createdAt':
          return repo.createdAt;
        case 'updatedAt':
          return repo.updatedAt;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueObj(repo, issue);
        }
        case 'issues':
          return connection('IssueConnection', 'IssueEdge', sortedIssues(repo, args).map((i) => issueObj(repo, i)), args);
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullObj(repo, pull);
        }
        case 'pullRequests':
          return connection('PullRequestConnection', 'PullRequestEdge', sortedPulls(repo, args).map((p) => pullObj(repo, p)), args);
        case 'labels': {
          const labels = [...repo.labels.values()].map((label) => gobj('Label', { repo, label }));
          return connection('LabelConnection', 'LabelEdge', labels, args);
        }
        default:
          break;
      }
      break;
    }
    case 'Ref': {
      switch (name) {
        case 'id':
          return globalId('Ref', (source!.repo as Repo).id, source!.qualifiedName as string);
        case 'name':
          return source!.name;
        case 'prefix':
          return String(source!.qualifiedName).startsWith('refs/tags/') ? 'refs/tags/' : 'refs/heads/';
        case 'qualifiedName':
          return source!.qualifiedName;
        case 'target':
          return gobj('Commit', { repo: source!.repo as Repo, sha: source!.sha as string });
        default:
          break;
      }
      break;
    }
    case 'Commit': {
      const repo = source!.repo as Repo;
      const sha = source!.sha as string;
      const commit = getCommit(repo, sha);
      switch (name) {
        case 'id':
          return globalId('Commit', sha);
        case 'oid':
          return sha;
        case 'message':
          return commit?.message ?? '';
        case 'messageHeadline':
          return (commit?.message ?? '').split('\n')[0] ?? '';
        case 'committedDate':
        case 'authoredDate': {
          const match = / (\d{10}) [+-]\d{4}$/.exec(commit?.committer ?? '');
          return match === null ? '2025-01-01T00:00:00Z' : new Date(Number(match[1]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        }
        case 'author': {
          const match = /^(.*?) <(.*?)>/.exec(commit?.author ?? '');
          return gobj('GitActor', { name: match?.[1] ?? '', email: match?.[2] ?? '', date: null, repo, sha });
        }
        case 'tree':
          return gobj('Tree', { oid: commit?.tree ?? '' });
        case 'url':
          return `https://github.com/commit/${sha}`;
        default:
          break;
      }
      break;
    }
    case 'GitActor': {
      switch (name) {
        case 'name':
          return source!.name;
        case 'email':
          return source!.email;
        case 'date':
          return null;
        case 'user': {
          const found = Object.values(USERS).find((u) => u.email === source!.email);
          return found === undefined ? null : userObj(found);
        }
        default:
          break;
      }
      break;
    }
    case 'Tree': {
      if (name === 'id') return globalId('Tree', source!.oid as string);
      if (name === 'oid') return source!.oid;
      break;
    }
    case 'Issue': {
      const repo = source!.repo as Repo;
      const issue = source!.issue as Issue;
      switch (name) {
        case 'id':
          return issueGlobalId(repo, issue.number);
        case 'databaseId':
          return issueRestId(repo, issue.number);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
        case 'bodyText':
          return issue.body;
        case 'state':
          return issue.state.toUpperCase();
        case 'author': {
          const found = USERS[issue.authorLogin];
          return found === undefined ? null : userObj(found);
        }
        case 'labels': {
          const labels = issue.labelNames
            .map((labelName) => repo.labels.get(labelName))
            .filter((l) => l !== undefined)
            .map((label) => gobj('Label', { repo, label }));
          return connection('LabelConnection', 'LabelEdge', labels, args);
        }
        case 'comments': {
          const comments = issue.comments.map((comment) => gobj('IssueComment', { repo, issueNumber: issue.number, comment }));
          return connection('IssueCommentConnection', 'IssueCommentEdge', comments, args);
        }
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'closedAt':
          return issue.state === 'closed' ? issue.updatedAt : null;
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'repository':
          return repoObj(repo);
        default:
          break;
      }
      break;
    }
    case 'PullRequest': {
      const repo = source!.repo as Repo;
      const pull = source!.pull as PullRequest;
      switch (name) {
        case 'id':
          return pullGlobalId(repo, pull.number);
        case 'databaseId':
          return issueRestId(repo, pull.number);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'mergedAt':
          return pull.mergedAt;
        case 'mergeCommit':
          return pull.mergeCommitSha === null ? null : gobj('Commit', { repo, sha: pull.mergeCommitSha });
        case 'mergeable':
          return pullMergeable(repo, pull);
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'headRefOid':
          return branchTip(repo, pull.headRef, pull.headSha);
        case 'baseRefOid':
          return branchTip(repo, pull.baseRef, pull.baseSha);
        case 'isDraft':
          return false;
        case 'author': {
          const found = USERS[pull.authorLogin];
          return found === undefined ? null : userObj(found);
        }
        case 'files': {
          const files = pullFiles(repo, pull).map((file) =>
            gobj('PullRequestChangedFile', {
              path: file.filename,
              additions: file.additions,
              deletions: file.deletions,
              changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
            }),
          );
          return connection('PullRequestChangedFileConnection', 'PullRequestChangedFileEdge', files, args);
        }
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'closedAt':
          return pull.state === 'closed' ? pull.updatedAt : null;
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'repository':
          return repoObj(repo);
        default:
          break;
      }
      break;
    }
    case 'PullRequestChangedFile': {
      if (name === 'path' || name === 'additions' || name === 'deletions' || name === 'changeType') return source![name];
      break;
    }
    case 'IssueComment': {
      const repo = source!.repo as Repo;
      const comment = source!.comment as { id: number; body: string; authorLogin: string; createdAt: string };
      switch (name) {
        case 'id':
          return commentGlobalId(repo, source!.issueNumber as number, comment.id);
        case 'databaseId':
          return comment.id;
        case 'body':
          return comment.body;
        case 'author': {
          const found = USERS[comment.authorLogin];
          return found === undefined ? null : userObj(found);
        }
        case 'createdAt':
        case 'updatedAt':
          return comment.createdAt;
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}/issues/${String(source!.issueNumber)}#issuecomment-${comment.id}`;
        default:
          break;
      }
      break;
    }
    case 'Label': {
      const repo = source!.repo as Repo;
      const label = source!.label as { id: number; name: string; color: string; description: string | null };
      switch (name) {
        case 'id':
          return globalId('Label', repo.id, label.name);
        case 'name':
          return label.name;
        case 'color':
          return label.color;
        case 'description':
          return label.description;
        default:
          break;
      }
      break;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return source!.hasNextPage;
      if (name === 'hasPreviousPage') return source!.hasPreviousPage;
      if (name === 'startCursor') return source!.startCursor;
      if (name === 'endCursor') return source!.endCursor;
      break;
    }
    case '__Type': {
      switch (name) {
        case 'name':
          return source!.name;
        case 'kind':
          return source!.kind;
        case 'description':
          return null;
        case 'fields':
          return (source!.fieldsList as string[] | null)?.map((fieldName) => gobj('__Field', { name: fieldName })) ?? null;
        case 'enumValues':
          return (source!.enumList as string[] | null)?.map((valueName) => gobj('__EnumValue', { name: valueName })) ?? null;
        case 'ofType':
        case 'possibleTypes':
        case 'inputFields':
          return null;
        case 'specifiedByURL':
          return null;
        default:
          break;
      }
      break;
    }
    case '__Field': {
      switch (name) {
        case 'name':
          return source!.name;
        case 'description':
          return null;
        case 'type':
          return gobj('__Type', { name: 'String', kind: 'SCALAR', fieldsList: null, enumList: null });
        case 'args':
          return [];
        case 'isDeprecated':
          return false;
        case 'deprecationReason':
          return null;
        default:
          break;
      }
      break;
    }
    case '__EnumValue': {
      if (name === 'name') return source!.name;
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      break;
    }
    case '__Schema': {
      switch (name) {
        case 'types':
          return [...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_VALUES)].map((typeName) => typeObj(typeName)).filter((t) => t !== null);
        case 'queryType':
          return typeObj('Query');
        case 'mutationType':
          return typeObj('Mutation');
        case 'subscriptionType':
          return null;
        case 'directives':
          return [];
        default:
          break;
      }
      break;
    }
    default:
      break;
  }

  // Connection-shaped types share nodes/edges/pageInfo/totalCount.
  if (typeName.endsWith('Connection')) {
    switch (name) {
      case 'nodes':
        return source!.nodesRaw;
      case 'edges':
        return source!.edgesRaw;
      case 'totalCount':
        return source!.totalCount;
      case 'pageInfo':
        return gobj('PageInfo', {
          hasNextPage: source!.hasNextPage,
          hasPreviousPage: source!.hasPreviousPage,
          startCursor: source!.startCursor,
          endCursor: source!.endCursor,
        });
      default:
        break;
    }
  }
  if (typeName.endsWith('Edge')) {
    if (name === 'node') return source!.node;
    if (name === 'cursor') return source!.cursor;
  }
  // Payload passthrough fields (issue, pullRequest, repository, commentEdge, subject, clientMutationId).
  if (source !== null && name in source && name !== '__type') return source[name];

  ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${typeName}'` });
  return null;
}

function shouldSkip(directives: Record<string, Record<string, ValueNode>>, ctx: Ctx): boolean {
  for (const [name, dirArgs] of Object.entries(directives)) {
    const ifArg = dirArgs.if !== undefined ? evalValue(dirArgs.if, ctx) : undefined;
    if (name === 'skip' && ifArg === true) return true;
    if (name === 'include' && ifArg === false) return true;
  }
  return false;
}

function executeSelectionSet(typeName: string, source: GObj | null, selections: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (shouldSkip(selection.directives, ctx)) continue;
      const key = selection.alias ?? selection.name;
      const raw = resolveField(typeName, source, selection, ctx);
      out[key] = completeValue(raw, selection.selectionSet, ctx);
    } else if (selection.kind === 'inline') {
      if (shouldSkip(selection.directives, ctx)) continue;
      if (selection.typeCondition === undefined || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(typeName, source, selection.selectionSet, ctx));
      }
    } else {
      if (shouldSkip(selection.directives, ctx)) continue;
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment '${selection.name}'` });
        continue;
      }
      if (fragment.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(typeName, source, fragment.selectionSet, ctx));
      }
    }
  }
  return out;
}

function completeValue(value: unknown, selectionSet: SelectionNode[] | undefined, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, selectionSet, ctx));
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    const g = value as GObj;
    if (selectionSet === undefined) return null;
    return executeSelectionSet(g.__type, g, selectionSet, ctx);
  }
  return value;
}

/** Execute one GraphQL document; returns the payload object ({data} and/or {errors}). */
export function executeGraphQL(body: { query?: unknown; variables?: unknown; operationName?: unknown }): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  let variables: Record<string, unknown> = {};
  if (typeof body.variables === 'string') {
    try {
      variables = JSON.parse(body.variables) as Record<string, unknown>;
    } catch {
      variables = {};
    }
  } else if (body.variables !== null && typeof body.variables === 'object') {
    variables = body.variables as Record<string, unknown>;
  }
  let document: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    document = new Parser(query).parseDocument();
  } catch (error) {
    return { errors: [{ message: `Syntax error: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  const operation = document.operations.find((op) => operationName === undefined || op.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation found' }] };
  const ctx: Ctx = { vars: { ...variables }, fragments: document.fragments, errors: [] };
  for (const [varName, defaultNode] of Object.entries(operation.varDefaults)) {
    if (ctx.vars[varName] === undefined) ctx.vars[varName] = evalValue(defaultNode, ctx);
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, null, operation.selectionSet, ctx);
  const payload: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) payload.errors = ctx.errors;
  return payload;
}
