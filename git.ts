// The git layer: a per-repo object store, tree/commit plumbing, packfile encode and decode, and the
// smart-HTTP protocol (v2 and v0) implemented from scratch on the standard library — no git binary.
//
// Objects are stored loose in memory as {type, data}; a sha is sha1("<type> <len>\0" + data), exactly
// git's. Packs we send are plain (no deltas — always legal); packs we receive are fully resolved,
// including OFS- and REF-deltas, before anything is stored.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { COMMITTER_IDENT, nowEpochSec, type GitObject, type Repo } from './store.ts';

export const ZERO_SHA = '0000000000000000000000000000000000000000';
const PKT_MAX = 65520; // largest legal pkt-line, length prefix included

// ---------------------------------------------------------------------------
// Object store plumbing
// ---------------------------------------------------------------------------

export function hashObject(type: GitObject['type'], data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function storeObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function getCommit(repo: Repo, sha: string): CommitInfo | null {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data);
}

/** An ident line ("Name <email> timestamp tz") for a server-created commit at the logical now. */
export function serverIdent(): string {
  return `${COMMITTER_IDENT} ${nowEpochSec()} +0000`;
}

export function makeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
  const ident = serverIdent();
  const lines = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`), `author ${ident}`, `committer ${ident}`];
  return storeObject(repo, 'commit', Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8'));
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const mode = data.toString('utf8', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree-entry sort: names compare as bytes, directories as if suffixed with '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function writeTree(repo: Repo, entries: TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    chunks.push(Buffer.from(entry.sha, 'hex'));
  }
  return storeObject(repo, 'tree', Buffer.concat(chunks));
}

export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface FileEntry {
  sha: string;
  mode: string;
}

/** Flatten a tree into path -> blob entry, recursively. */
export function flattenTree(repo: Repo, treeSha: string, prefix = '', out = new Map<string, FileEntry>()): Map<string, FileEntry> {
  if (treeSha === EMPTY_TREE_SHA) return out;
  const obj = repo.objects.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
  return out;
}

/** Build (and store) a tree hierarchy from a flat path -> blob map; returns the root tree sha. */
export function buildTree(repo: Repo, files: Map<string, FileEntry>): string {
  interface Node {
    files: Map<string, FileEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      if (!node.dirs.has(part)) node.dirs.set(part, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(part)!;
    }
    node.files.set(parts[parts.length - 1]!, entry);
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, sha: entry.sha });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: emit(child) });
    return writeTree(repo, entries);
  };
  return emit(root);
}

/** Look up one path in a tree; returns the entry (file or dir) or null. */
export function lookupPath(repo: Repo, treeSha: string, path: string): { sha: string; mode: string; isDir: boolean } | null {
  const parts = path.split('/').filter((p) => p !== '');
  let current = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) return { sha: entry.sha, mode: entry.mode, isDir: entry.mode === '40000' };
    if (entry.mode !== '40000') return null;
    current = entry.sha;
  }
  return { sha: treeSha, mode: '40000', isDir: true };
}

/** The tree sha of a commit, resolving through tags if needed; null when unresolvable. */
export function commitTreeSha(repo: Repo, sha: string): string | null {
  let current = sha;
  for (let hop = 0; hop < 8; hop += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return parseCommit(obj.data).tree;
    if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match === null) return null;
      current = match[1]!;
      continue;
    }
    return null;
  }
  return null;
}

/** Peel any object to a commit sha (through tags); null when it does not reach a commit. */
export function peelToCommit(repo: Repo, sha: string): string | null {
  let current = sha;
  for (let hop = 0; hop < 8; hop += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match === null) return null;
      current = match[1]!;
      continue;
    }
    return null;
  }
  return null;
}

/** All commits reachable from `start` (inclusive), breadth-first, newest generation first. */
export function walkCommits(repo: Repo, start: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [start];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    const commit = getCommit(repo, sha);
    if (commit === null) continue;
    seen.add(sha);
    order.push(sha);
    for (const parent of commit.parents) queue.push(parent);
  }
  return order;
}

/** The set of all ancestors of `sha`, including itself. */
export function ancestorSet(repo: Repo, sha: string): Set<string> {
  return new Set(walkCommits(repo, sha));
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  return ancestorSet(repo, descendant).has(ancestor);
}

/** A best common ancestor of two commits (lowest total BFS depth), or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const depthOf = (start: string): Map<string, number> => {
    const depth = new Map<string, number>();
    const queue: Array<[string, number]> = [[start, 0]];
    while (queue.length > 0) {
      const [sha, d] = queue.shift()!;
      if (depth.has(sha)) continue;
      const commit = getCommit(repo, sha);
      if (commit === null) continue;
      depth.set(sha, d);
      for (const parent of commit.parents) queue.push([parent, d + 1]);
    }
    return depth;
  };
  const da = depthOf(a);
  const db = depthOf(b);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [sha, d] of da) {
    const other = db.get(sha);
    if (other !== undefined && d + other < bestScore) {
      bestScore = d + other;
      best = sha;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Tree diffs and three-way merges (file level)
// ---------------------------------------------------------------------------

function linesOf(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** {additions, deletions} between two blob contents, via an LCS length (two-row DP). */
export function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const a = linesOf(oldData);
  const b = linesOf(newData);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  if (a.length * b.length > 16_000_000) return { additions: b.length, deletions: a.length }; // size guard
  let prev = new Uint32Array(b.length + 1);
  let curr = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  const lcs = prev[b.length]!;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

/** Diff two flat file maps (merge-base tree -> head tree, typically). */
export function diffFileMaps(repo: Repo, from: Map<string, FileEntry>, to: Map<string, FileEntry>): FileDiff[] {
  const out: FileDiff[] = [];
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = from.get(path);
    const newEntry = to.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.sha === newEntry.sha) continue;
    const oldData = oldEntry !== undefined ? (repo.objects.get(oldEntry.sha)?.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const newData = newEntry !== undefined ? (repo.objects.get(newEntry.sha)?.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const { additions, deletions } = lineDiff(oldData, newData);
    out.push({
      filename: path,
      status: oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: newEntry?.sha ?? oldEntry!.sha,
    });
  }
  return out;
}

/**
 * File-level three-way merge of flat file maps. A path conflicts when both sides changed it
 * differently (including modify/delete and add/add with different content).
 */
export function mergeFileMaps(
  base: Map<string, FileEntry>,
  ours: Map<string, FileEntry>,
  theirs: Map<string, FileEntry>,
): { merged: Map<string, FileEntry>; conflicts: string[] } {
  const merged = new Map<string, FileEntry>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const same = (x: FileEntry | undefined, y: FileEntry | undefined): boolean =>
    (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.sha === y.sha && x.mode === y.mode);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) merged.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  return { merged, conflicts };
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const TYPE_CODES: Record<GitObject['type'], number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObject['type']> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The pack entry header: type in bits 4-6 of byte 0, size as a little-endian varint. */
function packEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  let rest = size >> 4;
  if (rest > 0) first |= 0x80;
  bytes.push(first);
  while (rest > 0) {
    let byte = rest & 0x7f;
    rest >>= 7;
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** A pack containing the given objects whole (no deltas — always a legal pack). */
export function createPack(repo: Repo, shas: string[]): Buffer {
  const present = shas.filter((sha) => repo.objects.has(sha));
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(present.length, 8);
  chunks.push(header);
  for (const sha of present) {
    const obj = repo.objects.get(sha)!;
    chunks.push(packEntryHeader(TYPE_CODES[obj.type], obj.data.length));
    chunks.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate one zlib stream starting at `pos`, knowing its inflated size; returns data + bytes used. */
function inflateEntry(buf: Buffer, pos: number, expectedSize: number): { data: Buffer; used: number } {
  // inflateSync tolerates trailing bytes, and any prefix at least as long as the stream inflates to the
  // same bytes — so the consumed length is the smallest prefix that inflates to the expected size.
  // Bracket it by doubling, then binary-search inside the bracket.
  const remaining = buf.length - pos;
  const tryInflate = (len: number): Buffer | null => {
    try {
      const out = inflateSync(buf.subarray(pos, pos + len));
      return out.length === expectedSize ? out : null;
    } catch {
      return null;
    }
  };
  let hi = Math.min(remaining, 64);
  let data = tryInflate(hi);
  while (data === null && hi < remaining) {
    hi = Math.min(remaining, hi * 2);
    data = tryInflate(hi);
  }
  if (data === null) throw new Error('pack entry does not inflate');
  let lo = Math.max(1, Math.floor(hi / 2));
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (tryInflate(mid) !== null) hi = mid;
    else lo = mid + 1;
  }
  return { data, used: lo };
}

/** Apply a git delta buffer to a base object's data. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if ((op & 0x01) !== 0) { offset = delta[pos]!; pos += 1; }
      if ((op & 0x02) !== 0) { offset |= delta[pos]! << 8; pos += 1; }
      if ((op & 0x04) !== 0) { offset |= delta[pos]! << 16; pos += 1; }
      if ((op & 0x08) !== 0) { offset |= delta[pos]! << 24; pos += 1; }
      if ((op & 0x10) !== 0) { size = delta[pos]!; pos += 1; }
      if ((op & 0x20) !== 0) { size |= delta[pos]! << 8; pos += 1; }
      if ((op & 0x40) !== 0) { size |= delta[pos]! << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

export interface PackEntry {
  type: GitObject['type'];
  data: Buffer;
  sha: string;
}

/**
 * Parse a whole pack into resolved objects. Deltas are applied against bases from the pack itself
 * or, for REF-deltas, from the repo's existing store (thin packs). Throws on malformed input.
 */
export function parsePack(repo: Repo, pack: Buffer): PackEntry[] {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  let pos = 12;
  interface Raw {
    kind: 'full' | 'ofs' | 'ref';
    type?: GitObject['type'];
    data?: Buffer;
    baseOffset?: number;
    baseSha?: string;
    offset: number;
  }
  const raws: Raw[] = [];
  const byOffset = new Map<number, number>();
  for (let i = 0; i < count; i += 1) {
    const entryOffset = pos;
    let byte = pack[pos]!;
    pos += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[pos]!;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let raw: Raw;
    if (typeCode === 6) {
      // OFS-delta: a negative offset encoded in a special varint.
      let b = pack[pos]!;
      pos += 1;
      let offset = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = pack[pos]!;
        pos += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      raw = { kind: 'ofs', baseOffset: entryOffset - offset, offset: entryOffset };
    } else if (typeCode === 7) {
      const baseSha = pack.toString('hex', pos, pos + 20);
      pos += 20;
      raw = { kind: 'ref', baseSha, offset: entryOffset };
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack type ${typeCode}`);
      raw = { kind: 'full', type, offset: entryOffset };
    }
    const { data, used } = inflateEntry(pack, pos, size);
    pos += used;
    raw.data = data;
    byOffset.set(entryOffset, raws.length);
    raws.push(raw);
  }
  const resolved: Array<PackEntry | null> = raws.map(() => null);
  const resolve = (index: number): PackEntry => {
    const existing = resolved[index];
    if (existing !== null) return existing;
    const raw = raws[index]!;
    let entry: PackEntry;
    if (raw.kind === 'full') {
      entry = { type: raw.type!, data: raw.data!, sha: hashObject(raw.type!, raw.data!) };
    } else {
      let base: PackEntry;
      if (raw.kind === 'ofs') {
        const baseIndex = byOffset.get(raw.baseOffset!);
        if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
        base = resolve(baseIndex);
      } else {
        const inPack = raws.findIndex((r) => r.kind === 'full' && hashObject(r.type!, r.data!) === raw.baseSha);
        if (inPack !== -1) base = resolve(inPack);
        else {
          const stored = repo.objects.get(raw.baseSha!);
          if (stored === undefined) throw new Error('ref-delta base not found');
          base = { type: stored.type, data: stored.data, sha: raw.baseSha! };
        }
      }
      const data = applyDelta(base.data, raw.data!);
      entry = { type: base.type, data, sha: hashObject(base.type, data) };
    }
    resolved[index] = entry;
    return entry;
  };
  const out: PackEntry[] = [];
  for (let i = 0; i < raws.length; i += 1) out.push(resolve(i));
  return out;
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const prefix = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(prefix, 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Parse a pkt-line stream; returns payload lines and where the non-pkt tail (a pack) starts. */
export function parsePktLines(buf: Buffer, start = 0): { lines: string[]; special: Array<'flush' | 'delim'>; end: number; events: Array<{ kind: 'line' | 'flush' | 'delim'; text?: string }> } {
  const lines: string[] = [];
  const special: Array<'flush' | 'delim'> = [];
  const events: Array<{ kind: 'line' | 'flush' | 'delim'; text?: string }> = [];
  let pos = start;
  while (pos + 4 <= buf.length) {
    const header = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      special.push('flush');
      events.push({ kind: 'flush' });
      pos += 4;
      break; // a flush ends the pkt section; what follows is a new section or a pack
    }
    if (length === 1) {
      special.push('delim');
      events.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (length === 2 || length === 3 || pos + length > buf.length) break;
    const text = buf.toString('utf8', pos + 4, pos + length);
    lines.push(text);
    events.push({ kind: 'line', text });
    pos += length;
  }
  return { lines, special, end: pos, events };
}

/** Parse an entire pkt-line request body into sections (split on flush, sub-split on delim). */
export function parsePktSections(buf: Buffer): { sections: string[][]; tail: Buffer } {
  const sections: string[][] = [];
  let current: string[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const header = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      sections.push(current);
      current = [];
      pos += 4;
      // After a flush, either another pkt section or a raw pack follows; a pack starts with 'PACK'.
      if (buf.toString('ascii', pos, pos + 4) === 'PACK') break;
      continue;
    }
    if (length === 1) {
      sections.push(current);
      current = [];
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > buf.length) break;
    current.push(buf.toString('utf8', pos + 4, pos + length));
    pos += length;
  }
  if (current.length > 0) sections.push(current);
  return { sections, tail: buf.subarray(pos) };
}

function sidebandWrap(data: Buffer, band = 1): Buffer {
  const chunks: Buffer[] = [];
  const maxPayload = PKT_MAX - 5;
  for (let pos = 0; pos < data.length; pos += maxPayload) {
    const slice = data.subarray(pos, Math.min(data.length, pos + maxPayload));
    chunks.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Ref advertisement
// ---------------------------------------------------------------------------

export function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

const UPLOAD_CAPS = 'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not object-format=sha1 agent=forge/1.0.0';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k quiet ofs-delta object-format=sha1 agent=forge/1.0.0';

function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const chunks: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS} symref=HEAD:${headTarget(repo)}` : RECEIVE_CAPS;
  const refs = sortedRefs(repo);
  const headSha = repo.refs.get(headTarget(repo));
  const lines: string[] = [];
  if (headSha !== undefined) lines.push(`${headSha} HEAD`);
  for (const [ref, sha] of refs) {
    lines.push(`${sha} ${ref}`);
    const peeled = peelToCommit(repo, sha);
    if (peeled !== null && peeled !== sha) lines.push(`${peeled} ${ref}^{}`);
  }
  if (lines.length === 0) {
    chunks.push(pktLine(`${ZERO_SHA} capabilities^{}\0${caps}\n`));
  } else {
    lines[0] = `${lines[0]}\0${caps}`;
    for (const line of lines) chunks.push(pktLine(`${line}\n`));
  }
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

function advertisementV2(service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const chunks: Buffer[] = [pktLine('version 2\n'), pktLine('agent=forge/1.0.0\n')];
  if (service === 'git-upload-pack') {
    chunks.push(pktLine('ls-refs=unborn\n'));
    chunks.push(pktLine('fetch=shallow wait-for-done\n'));
  } else {
    chunks.push(pktLine('push-options\n'));
  }
  chunks.push(pktLine('object-format=sha1\n'));
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

export function handleInfoRefs(repo: Repo, service: string, protocolV2: boolean): GitHttpResult {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return { status: 403, contentType: 'text/plain', body: Buffer.from('forbidden\n') };
  }
  const body = protocolV2 ? advertisementV2(service) : advertisementV0(repo, service);
  return { status: 200, contentType: `application/x-${service}-advertisement`, body };
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const chunks: Buffer[] = [];
  const target = headTarget(repo);
  const headSha = repo.refs.get(target);
  if (headSha !== undefined) {
    if (matches('HEAD') || matches(target)) {
      let line = `${headSha} HEAD`;
      if (wantSymrefs) line += ` symref-target:${target}`;
      chunks.push(pktLine(`${line}\n`));
    }
  } else if (wantUnborn) {
    chunks.push(pktLine(`unborn HEAD symref-target:${target}\n`));
  }
  for (const [ref, sha] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${sha} ${ref}`;
    if (wantPeel) {
      const peeled = peelToCommit(repo, sha);
      if (peeled !== null && peeled !== sha) line += ` peeled:${peeled}`;
    }
    chunks.push(pktLine(`${line}\n`));
  }
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Fetch (upload-pack)
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowIn: string[];
  deepen: number | null;
  done: boolean;
  waitForDone: boolean;
  sideBand: boolean;
}

function collectFetchObjects(
  repo: Repo,
  req: FetchRequest,
): { objects: string[]; shallow: string[]; unshallow: string[] } {
  const haveCommits = req.haves.filter((h) => getCommit(repo, h) !== null);
  const haveClosure = new Set<string>();
  for (const have of haveCommits) for (const c of walkCommits(repo, have)) haveClosure.add(c);

  // Distance (in generations, want = 1) from the wants, never crossing into have-closure commits.
  const dist = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const want of req.wants) {
    const commitSha = peelToCommit(repo, want);
    if (commitSha !== null && !dist.has(commitSha)) queue.push([commitSha, 1]);
  }
  while (queue.length > 0) {
    const [sha, d] = queue.shift()!;
    if (dist.has(sha) || haveClosure.has(sha)) continue;
    const commit = getCommit(repo, sha);
    if (commit === null) continue;
    dist.set(sha, d);
    for (const parent of commit.parents) queue.push([parent, d + 1]);
  }

  let limit = Infinity;
  if (req.deepen !== null) {
    if (req.shallowIn.length === 0) {
      limit = req.deepen;
    } else {
      let base = 0;
      for (const s of req.shallowIn) {
        const commitSha = peelToCommit(repo, s);
        if (commitSha !== null && dist.has(commitSha)) base = Math.max(base, dist.get(commitSha)!);
      }
      limit = base > 0 ? base + req.deepen : req.deepen;
    }
  }

  const included = new Set<string>();
  for (const [sha, d] of dist) if (d <= limit) included.add(sha);

  const shallow: string[] = [];
  const unshallow: string[] = [];
  const shallowInSet = new Set(req.shallowIn.map((s) => peelToCommit(repo, s) ?? s));
  for (const sha of included) {
    const commit = getCommit(repo, sha);
    if (commit === null) continue;
    const missingParent = commit.parents.some((p) => !included.has(p) && !haveClosure.has(p));
    if (missingParent && commit.parents.length > 0) shallow.push(sha);
    if (shallowInSet.has(sha) && !missingParent) unshallow.push(sha);
  }
  // Former boundary commits that stayed included but whose parents are now in are unshallowed above;
  // boundary commits no longer wanted at all need no line.

  // Object closure of a commit set: the commits themselves plus every tree and blob they reach.
  // `only` restricts which commits are walked (the depth-limited included set); trees and blobs of
  // walked commits always come along.
  const collectClosure = (tips: Set<string>, only: Set<string> | null, into: Set<string>): void => {
    const stack: string[] = [...tips];
    const seenCommits = new Set<string>();
    while (stack.length > 0) {
      const commitSha = stack.pop()!;
      if (seenCommits.has(commitSha)) continue;
      if (only !== null && !only.has(commitSha)) continue;
      seenCommits.add(commitSha);
      const commit = getCommit(repo, commitSha);
      if (commit === null) continue;
      into.add(commitSha);
      const treeStack: string[] = [commit.tree];
      while (treeStack.length > 0) {
        const treeSha = treeStack.pop()!;
        if (into.has(treeSha)) continue;
        const obj = repo.objects.get(treeSha);
        if (obj === undefined || obj.type !== 'tree') continue;
        into.add(treeSha);
        for (const entry of parseTree(obj.data)) {
          if (entry.mode === '40000') treeStack.push(entry.sha);
          else into.add(entry.sha);
        }
      }
      for (const parent of commit.parents) stack.push(parent);
    }
  };
  const haveObjects = new Set<string>();
  collectClosure(haveClosure, null, haveObjects);
  const wantedObjects = new Set<string>();
  collectClosure(included, included, wantedObjects);
  const objects: string[] = [];
  for (const sha of wantedObjects) {
    if (haveObjects.has(sha)) continue;
    if (!repo.objects.has(sha)) continue;
    objects.push(sha);
  }
  // A want that names a tag object needs the tag object itself in the pack too.
  for (const want of req.wants) {
    const obj = repo.objects.get(want);
    if (obj !== undefined && obj.type === 'tag' && !objects.includes(want)) objects.push(want);
  }
  // Commits first (BFS order), then trees, then blobs: a friendly order for the receiving side.
  const rank = (sha: string): number => {
    const t = repo.objects.get(sha)?.type;
    return t === 'commit' ? 0 : t === 'tree' ? 1 : t === 'tag' ? 2 : 3;
  };
  objects.sort((a, b) => rank(a) - rank(b));
  return { objects, shallow, unshallow };
}

function parseFetchArgs(lines: string[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallowIn: [], deepen: null, done: false, waitForDone: false, sideBand: true };
  for (const rawLine of lines) {
    const line = rawLine.replace(/\n$/, '');
    if (line.startsWith('want ')) req.wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) req.haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) req.shallowIn.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) req.deepen = Number.parseInt(line.slice(7), 10) || null;
    else if (line === 'done') req.done = true;
    else if (line === 'wait-for-done') req.waitForDone = true;
  }
  return req;
}

export function handleUploadPack(repo: Repo, body: Buffer, protocolV2: boolean): GitHttpResult {
  try {
    if (protocolV2) return uploadPackV2(repo, body);
    return uploadPackV0(repo, body);
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('bad request\n') };
  }
}

function uploadPackV2(repo: Repo, body: Buffer): GitHttpResult {
  const { sections } = parsePktSections(body);
  const first = sections[0] ?? [];
  const command = first.find((l) => l.startsWith('command='));
  if (command === 'command=ls-refs') {
    const args = sections[1] ?? [];
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleLsRefs(repo, args.map((l) => l.replace(/\n$/, ''))) };
  }
  if (command !== 'command=fetch') {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: pktLine('ERR unknown command\n') };
  }
  const argLines = sections.slice(1).flat();
  const req = parseFetchArgs(argLines);
  for (const want of req.wants) {
    if (!repo.objects.has(want)) {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: pktLine(`ERR upload-pack: not our ref ${want}\n`) };
    }
  }
  const chunks: Buffer[] = [];
  if (req.haves.length > 0) {
    const ackLines: string[] = ['acknowledgments\n'];
    const common = req.haves.filter((h) => repo.objects.has(h));
    if (common.length === 0) {
      ackLines.push('NAK\n');
    } else {
      for (const have of common) ackLines.push(`ACK ${have}\n`);
      ackLines.push('ready\n');
    }
    for (const line of ackLines) chunks.push(pktLine(line));
    chunks.push(PKT_FLUSH);
  }
  if (req.waitForDone && !req.done) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(chunks) };
  }
  const { objects, shallow, unshallow } = collectFetchObjects(repo, req);
  if (req.deepen !== null || req.shallowIn.length > 0) {
    const lines: string[] = ['shallow-info\n'];
    for (const sha of shallow) lines.push(`shallow ${sha}\n`);
    for (const sha of unshallow) lines.push(`unshallow ${sha}\n`);
    if (lines.length > 1) {
      for (const line of lines) chunks.push(pktLine(line));
      chunks.push(PKT_FLUSH);
    }
  }
  chunks.push(pktLine('packfile\n'));
  const pack = createPack(repo, objects);
  chunks.push(sidebandWrap(pack, 1));
  chunks.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(chunks) };
}

function uploadPackV0(repo: Repo, body: Buffer): GitHttpResult {
  const { sections } = parsePktSections(body);
  const lines = sections.flat();
  const req: FetchRequest = { wants: [], haves: [], shallowIn: [], deepen: null, done: false, waitForDone: false, sideBand: false };
  for (const rawLine of lines) {
    const line = rawLine.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      req.wants.push(line.slice(5, 45));
      const caps = line.slice(45);
      if (caps.includes('side-band-64k') || caps.includes('side-band')) req.sideBand = true;
    } else if (line.startsWith('have ')) req.haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) req.shallowIn.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) req.deepen = Number.parseInt(line.slice(7), 10) || null;
    else if (line === 'done') req.done = true;
  }
  for (const want of req.wants) {
    if (!repo.objects.has(want)) return { status: 400, contentType: 'text/plain', body: Buffer.from('not our ref\n') };
  }
  const { objects } = collectFetchObjects(repo, req);
  const pack = createPack(repo, objects);
  const chunks: Buffer[] = [];
  const common = req.haves.filter((h) => repo.objects.has(h));
  chunks.push(pktLine(common.length > 0 ? `ACK ${common[common.length - 1]}\n` : 'NAK\n'));
  if (req.sideBand) {
    chunks.push(sidebandWrap(pack, 1));
    chunks.push(PKT_FLUSH);
  } else {
    chunks.push(pack);
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(chunks) };
}

// ---------------------------------------------------------------------------
// Push (receive-pack)
// ---------------------------------------------------------------------------

export function handleReceivePack(repo: Repo, body: Buffer): GitHttpResult {
  try {
    return receivePack(repo, body);
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('bad request\n') };
  }
}

function receivePack(repo: Repo, body: Buffer): GitHttpResult {
  const { sections, tail } = parsePktSections(body);
  const commandLines = (sections[0] ?? []).map((l) => l.replace(/\n$/, ''));
  let caps = '';
  interface RefUpdate {
    oldSha: string;
    newSha: string;
    ref: string;
  }
  const updates: RefUpdate[] = [];
  commandLines.forEach((line, index) => {
    let text = line;
    if (index === 0) {
      const nul = text.indexOf('\0');
      if (nul !== -1) {
        caps = text.slice(nul + 1);
        text = text.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length >= 3) updates.push({ oldSha: parts[0]!, newSha: parts[1]!, ref: parts[2]! });
  });

  // Unpack first: objects land in the store before any ref is judged, as git does.
  let unpackOk = true;
  if (tail.length >= 12 && tail.toString('ascii', 0, 4) === 'PACK') {
    try {
      const entries = parsePack(repo, tail);
      for (const entry of entries) {
        if (!repo.objects.has(entry.sha)) repo.objects.set(entry.sha, { type: entry.type, data: entry.data });
      }
    } catch {
      unpackOk = false;
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const update of updates) {
    const fail = (reason: string): void => {
      results.push({ ref: update.ref, ok: false, reason });
    };
    if (!unpackOk) {
      fail('unpack failed');
      continue;
    }
    const current = repo.refs.get(update.ref) ?? ZERO_SHA;
    if (update.newSha === ZERO_SHA) {
      // Delete.
      if (current === ZERO_SHA) fail('reference does not exist');
      else {
        repo.refs.delete(update.ref);
        results.push({ ref: update.ref, ok: true });
      }
      continue;
    }
    const newCommit = peelToCommit(repo, update.newSha);
    if (newCommit === null) {
      fail('invalid object');
      continue;
    }
    if (current !== ZERO_SHA && current !== update.newSha) {
      const oldCommit = peelToCommit(repo, current);
      if (oldCommit === null || !isAncestor(repo, oldCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(update.ref, update.newSha);
    results.push({ ref: update.ref, ok: true });
  }
  if (!caps.includes('report-status')) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  }
  const report: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : 'unpack index-pack failed\n')];
  for (const result of results) {
    report.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  report.push(PKT_FLUSH);
  const reportBytes = Buffer.concat(report);
  if (caps.includes('side-band-64k') || caps.includes('side-band')) {
    return {
      status: 200,
      contentType: 'application/x-git-receive-pack-result',
      body: Buffer.concat([sidebandWrap(reportBytes, 1), PKT_FLUSH]),
    };
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: reportBytes };
}
