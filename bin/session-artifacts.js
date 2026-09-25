'use strict';
// The `artifacts` verb: what a node's host does so a session can be moved onto it or
// off it. A Claude session's artifacts are its transcript, its session trees (the
// primary `<sid>/` beside the transcript and any `<sid>.superseded-*` tree under any
// project) and its file history. A Codex session's (`kind: 'codex'`) are its root
// rollout, `sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl`, and the rollout of every
// child thread whose parent chain leads back to it (each rollout's own session_meta
// says whose it is), under `sessions/` or `archived_sessions/`; never the account's
// session index, history or sqlite files, which are not a conversation's state. Either
// way everything is under one account's config directory. Every node shares the home
// path, so the same relative paths name the same artifacts on both machines, and that
// is all that ever travels: a path relative to the account directory, checked here
// against the shapes a session's artifacts can have.
//
// Every request may name `kind` ('claude' when it names none, which is all an older
// daemon sends); the account must be one of this node's accounts of that agent.
//
//   list    { sessionId, account }                    -> { projectName, files: [{ relPath, size, mtimeMs, mode, sha256, generation, owned }], bytes }
//             `generation` names the file as the hook client does (hook-client.js
//             generationOf), so a daemon seeding its mirror of this node's copy
//             stamps it with the identity the node's hook posts will carry. `owned`
//             (version 3) says a move or a transfer put exactly these bytes here, so
//             a publish may replace them: an account transfer asks before it stops
//             anything whether its publish would be refused.
//   read   { sessionId, account, relPath, from, length ≤ 4 MiB } -> { relPath, size, mtimeMs, from, bytes, eof }
//   stage   { sessionId, account, tx, relPath, from, bytes, size, sha256 }
//                                                      -> { relPath, staged, complete } | { relPath, staged, needFrom }
//   publish { sessionId, account, tx, entries: [{ relPath, sha256, size }] } -> { published: [{ relPath, sha256, size, action }] }
//   release { sessionId, account }                    -> { files }: the session left this node; what it left behind is ours to replace
//   abort   { account, tx }                           -> { removed }
//   cwd     { path }                                  -> { path, exists, directory }
//   account { account }                               -> { account, directory: true }: this node has the account, and its directory
//   drop-session { sessionId }                        -> { dropped }: this node's hook queue and mirror cursor for the session
//   auth, shared-setup, compatible, resume-spec, project-trust (version 3): an account
//             transfer's questions about this node's own account configuration, answered
//             by bin/account-handoff-node.js.
//
// Nothing here takes a path from the caller beyond a relative one that must name a
// session artifact of the session asked about. The account must be one this node has
// configured (node-transcript's nodeAccount, the same check the transcript verb
// makes), every directory below the account's real path is walked with lstat and a
// link anywhere refuses, files are opened O_NOFOLLOW, and staged bytes live under
// `<configDir>/.keep-move/<tx>/` until a publish renames them into place. A publish
// never replaces a file that differs from what the move carries unless a move put
// that file there (the provenance a publish or a release records): a live transcript
// nobody moved is refused, not overwritten.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SLUG_RE = /^[A-Za-z0-9._-]{1,255}$/;
const NAME_RE = /^[A-Za-z0-9._@+=-]{1,255}$/;
const TX_RE = /^[A-Za-z0-9_-]{8,128}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const REQUEST_MAX_BYTES = 4 * 1024 * 1024;
const TX_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILES = 50000;
const MOVE_DIR = '.keep-move';
const HANDOFF_OPS = new Set(['auth', 'shared-setup', 'compatible', 'resume-spec', 'project-trust']);
const OPS = new Set(['list', 'read', 'stage', 'publish', 'release', 'abort', 'cwd', 'drop-session', 'account', ...HANDOFF_OPS]);
const KINDS = new Set(['claude', 'codex']);
const ROLLOUT_NAME_RE = /^rollout-[A-Za-z0-9._:+=@-]+\.jsonl$/;
const META_MAX_BYTES = 256 * 1024;
const ROLLOUT_ID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const CODEX_GRAPH_DEPTH = 8;
const CODEX_GRAPH_MAX = 128;

function coded(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
const invalid = (message) => coded(message, 'artifacts-invalid');
const refused = (message) => coded(message, 'artifacts-refused');

const plainName = (value, re) => typeof value === 'string' && re.test(value) && value !== '.' && value !== '..';

function validSession(params) {
  if (!plainName(params.sessionId, SESSION_ID_RE)) throw invalid('artifacts session id is not a session id');
  return params.sessionId;
}

function validTx(params) {
  // `provenance` is the directory beside the transactions, never one of them.
  if (typeof params.tx !== 'string' || !TX_RE.test(params.tx) || params.tx === 'provenance') {
    throw invalid('artifacts transaction id is not a transaction id');
  }
  return params.tx;
}

function validKind(params) {
  const kind = params.kind === undefined ? 'claude' : params.kind;
  if (!KINDS.has(kind)) throw invalid('artifacts kind must be claude or codex');
  return kind;
}

function validAccount(params) {
  const account = params.account;
  if (!account || typeof account !== 'object' || typeof account.id !== 'string'
      || typeof account.configDir !== 'string' || !path.isAbsolute(account.configDir) || /[\0\r\n]/.test(account.configDir)) {
    throw invalid('artifacts account must name an id and an absolute config directory');
  }
}

// The account as this node has it configured, with the real path everything below
// is resolved against.
function accountRoot(params, options = {}) {
  validAccount(params);
  const kind = validKind(params);
  let account;
  try {
    account = require('./node-transcript.js').nodeAccount({ kind, account: params.account }, options);
  } catch (error) { throw refused(error.message); }
  let stat;
  try { stat = fs.statSync(account.root); } catch { stat = null; }
  if (!stat || !stat.isDirectory()) throw refused(`${account.id}'s config directory is not a directory on this node`);
  return account.root;
}

// A Codex rollout's shape: dated under `sessions/`, or flat under `archived_sessions/`
// for a child thread. The root rollout names the session at the end of its file name;
// an archived root is refused by name, as the account handoff refuses one. Child
// rollouts name their own threads, so the shape is all that can be checked here, and
// a read checks the file's own session_meta besides (codexRolloutReadable).
function codexScopedParts(parts, relPath, sessionId) {
  const name = parts[parts.length - 1];
  if (parts[0] === 'sessions' && parts.length === 5 && /^\d{4}$/.test(parts[1]) && /^\d{2}$/.test(parts[2])
      && /^\d{2}$/.test(parts[3]) && ROLLOUT_NAME_RE.test(name)) return parts;
  if (parts[0] === 'archived_sessions' && parts.length === 2 && ROLLOUT_NAME_RE.test(name)) {
    if (name.endsWith(`-${sessionId}.jsonl`)) {
      throw coded(`Codex session ${sessionId} is archived on this node; unarchive it before moving it`, 'artifacts-archived');
    }
    return parts;
  }
  throw refused(`${relPath} is not an artifact of session ${sessionId}`);
}

// A relative path the session's artifacts can have, split into its parts, or a
// refusal. The shapes are exactly the ones account-artifacts moves between accounts.
function scopedParts(relPath, sessionId, kind = 'claude') {
  if (typeof relPath !== 'string' || !relPath || relPath.length > 4096 || relPath.includes('\\')) {
    throw invalid('artifacts path must be a relative path');
  }
  const parts = relPath.split('/');
  if (!parts.every((part) => plainName(part, NAME_RE))) throw invalid(`artifacts path has a part that is not a plain name: ${relPath}`);
  if (kind === 'codex') return codexScopedParts(parts, relPath, sessionId);
  if (parts[0] === 'projects' && parts.length >= 3 && plainName(parts[1], SLUG_RE)) {
    if (parts.length === 3 && parts[2] === `${sessionId}.jsonl`) return parts;
    if (parts.length >= 4 && (parts[2] === sessionId || parts[2].startsWith(`${sessionId}.superseded-`))) return parts;
  }
  if (parts[0] === 'file-history' && parts.length >= 3 && parts[1] === sessionId) return parts;
  throw refused(`${relPath} is not an artifact of session ${sessionId}`);
}

function lstatOrNull(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Walks `parts` below `root`, refusing a link or a non-directory on the way. With
// `create`, missing directories are made (0700). Returns the full path of the last
// part, which is not itself checked beyond not being a link.
function resolveUnder(root, parts, options = {}) {
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]);
    const last = index === parts.length - 1;
    const stat = lstatOrNull(cursor);
    if (!stat) {
      if (last || !options.create) {
        if (last) return cursor;
        // Nothing below a missing directory exists either.
        return path.join(cursor, ...parts.slice(index + 1));
      }
      fs.mkdirSync(cursor, { mode: 0o700 });
      continue;
    }
    if (stat.isSymbolicLink()) throw refused(`${path.relative(root, cursor)} is a symbolic link`);
    if (!last && !stat.isDirectory()) throw refused(`${path.relative(root, cursor)} is not a directory`);
  }
  return cursor;
}

function openNoFollow(file, flags, mode) {
  try {
    return fs.openSync(file, flags | (fs.constants.O_NOFOLLOW || 0), mode);
  } catch (error) {
    if (error && error.code === 'ELOOP') throw refused(`${path.basename(file)} is a symbolic link`);
    throw error;
  }
}

async function hashFd(fd) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  for (;;) {
    const n = await new Promise((resolve, reject) => {
      fs.read(fd, buffer, 0, buffer.length, position, (error, bytes) => (error ? reject(error) : resolve(bytes)));
    });
    if (!n) break;
    hash.update(buffer.subarray(0, n));
    position += n;
  }
  return hash.digest('hex');
}

// The digest of a regular file reached through no link, or null when it is absent.
async function fileDigest(file) {
  let fd;
  try { fd = openNoFollow(file, fs.constants.O_RDONLY); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw refused(`${path.basename(file)} is not a regular file`);
    return { sha256: await hashFd(fd), size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777,
      generation: require('./hook-client.js').generationOf(stat) };
  } finally { fs.closeSync(fd); }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function writeJson(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = openNoFollow(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}

// ---------- list ----------

function names(dir) {
  try { return fs.readdirSync(dir).sort(); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// Every file under one session tree, as relative parts. A link, a device or a name
// that is not plain refuses the whole list: a move that cannot carry a file must not
// quietly leave it behind.
function walkTree(root, parts, out) {
  const dir = path.join(root, ...parts);
  for (const name of names(dir)) {
    if (!plainName(name, NAME_RE)) throw refused(`${[...parts, name].join('/')} has a name a move cannot carry`);
    const child = [...parts, name];
    const stat = fs.lstatSync(path.join(root, ...child));
    if (stat.isSymbolicLink()) throw refused(`${child.join('/')} is a symbolic link`);
    if (stat.isDirectory()) walkTree(root, child, out);
    else if (stat.isFile()) out.push(child);
    else throw refused(`${child.join('/')} is not a regular file`);
    if (out.length > MAX_FILES) throw refused(`session has more than ${MAX_FILES} artifact files`);
  }
}

// The session_meta of an open rollout, from its first line only: read 4 KiB at a
// time up to the first newline, never past 256 KiB. { id, parent } or null.
function firstLineMeta(fd) {
  const chunks = [];
  let position = 0;
  for (;;) {
    const buffer = Buffer.alloc(Math.min(4096, META_MAX_BYTES - position));
    if (!buffer.length) return null;
    const n = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (!n) break;
    const newline = buffer.subarray(0, n).indexOf(10);
    chunks.push(buffer.subarray(0, newline === -1 ? n : newline));
    position += n;
    if (newline !== -1) break;
  }
  scanStats.firstLineReads += 1;
  let row = null;
  try { row = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
  const meta = row && row.type === 'session_meta' && row.payload && typeof row.payload === 'object' ? row.payload : null;
  if (!meta) return null;
  const id = meta.id || meta.session_id;
  const parent = meta.parent_thread_id || (meta.source && meta.source.subagent && meta.source.subagent.thread_spawn
    && meta.source.subagent.thread_spawn.parent_thread_id) || null;
  return {
    id: typeof id === 'string' && ROLLOUT_ID_RE.test(id) ? id : null,
    parent: typeof parent === 'string' && ROLLOUT_ID_RE.test(parent) ? parent : null,
    child: Boolean(parent || (meta.source && meta.source.subagent)),
  };
}

// First lines already read, by path, with the (inode, size, mtime) they were read
// at: a move lists a session several times, and only a rollout that changed (a
// resumed one grows) is opened again. A rollout's first line never changes once it
// is written, so this is only ever a cost saving, never a stale answer.
const firstLines = new Map();
const FIRST_LINES_MAX = 20000;
// Counted for the tests: how many first lines were actually read from disk.
const scanStats = { firstLineReads: 0 };

function cachedFirstLine(file, stat) {
  const known = firstLines.get(file);
  if (known && known.ino === stat.ino && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.meta;
  const fd = openNoFollow(file, fs.constants.O_RDONLY);
  let meta;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== stat.ino) throw refused(`${path.basename(file)} changed while it was read`);
    meta = firstLineMeta(fd);
  } finally { fs.closeSync(fd); }
  firstLines.delete(file);
  firstLines.set(file, { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, meta });
  while (firstLines.size > FIRST_LINES_MAX) firstLines.delete(firstLines.keys().next().value);
  return meta;
}

// Every rollout file of the account by name alone (directory reads, no file opened):
// `sessions/YYYY/MM/DD/rollout-*.jsonl` and `archived_sessions/rollout-*.jsonl`. A link
// or anything but a plain directory or file on the way refuses, as a move that could
// not see a thread must not leave it behind.
function rolloutNames(root) {
  const out = [];
  const plainDir = (parts) => {
    const stat = lstatOrNull(path.join(root, ...parts));
    if (!stat) return false;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw refused(`${parts.join('/')} is not a plain directory`);
    return true;
  };
  const files = (parts) => {
    for (const name of names(path.join(root, ...parts))) {
      if (!ROLLOUT_NAME_RE.test(name)) continue;
      const stat = fs.lstatSync(path.join(root, ...parts, name));
      if (stat.isSymbolicLink() || !stat.isFile()) throw refused(`${[...parts, name].join('/')} is not a regular file`);
      out.push({ parts: [...parts, name], stat });
      if (out.length > MAX_FILES) throw refused(`the account has more than ${MAX_FILES} rollouts`);
    }
  };
  if (plainDir(['sessions'])) {
    for (const year of names(path.join(root, 'sessions')).filter((name) => /^\d{4}$/.test(name))) {
      if (!plainDir(['sessions', year])) continue;
      for (const month of names(path.join(root, 'sessions', year)).filter((name) => /^\d{2}$/.test(name))) {
        if (!plainDir(['sessions', year, month])) continue;
        for (const day of names(path.join(root, 'sessions', year, month)).filter((name) => /^\d{2}$/.test(name))) {
          if (plainDir(['sessions', year, month, day])) files(['sessions', year, month, day]);
        }
      }
    }
  }
  if (plainDir(['archived_sessions'])) files(['archived_sessions']);
  return out;
}

// The dated folder a day before `day` (YYYY/MM/DD): the slack a child is given, since
// a machine that changed time zone between a root and its child can file the child
// under an earlier date.
function dayBefore(day) {
  const [year, month, date] = day.split('/').map(Number);
  const earlier = new Date(Date.UTC(year, month - 1, date - 1));
  return [String(earlier.getUTCFullYear()), String(earlier.getUTCMonth() + 1).padStart(2, '0'),
    String(earlier.getUTCDate()).padStart(2, '0')].join('/');
}

// A Codex session's rollouts: the root, found by its file name and confirmed by its
// session_meta, and every child rollout whose parent chain leads back to it. Children
// begin after their root, so only rollouts filed no earlier than the day before the
// root's folder, and the archive, are candidates, and of those only the first line is
// read, once per file per change (cachedFirstLine). A duplicate id, a cycle, or a
// graph deeper or larger than a conversation has refuses the list.
function codexArtifactParts(root, sessionId) {
  const all = rolloutNames(root);
  const suffix = `-${sessionId}.jsonl`;
  const named = all.filter((entry) => entry.parts[entry.parts.length - 1].endsWith(suffix));
  if (named.some((entry) => entry.parts[0] === 'archived_sessions')) {
    throw coded(`Codex session ${sessionId} is archived on this node; unarchive it before moving it`, 'artifacts-archived');
  }
  if (!named.length) throw coded(`no Codex rollout for ${sessionId} on this node`, 'artifacts-missing');
  if (named.length > 1) throw refused(`session ${sessionId} has more than one rollout on this node`);
  const [rootEntry] = named;
  const rootFile = path.join(root, ...rootEntry.parts);
  const rootMeta = cachedFirstLine(rootFile, rootEntry.stat);
  if (!rootMeta || rootMeta.id !== sessionId) throw refused(`${rootEntry.parts.join('/')} does not begin with the session_meta of ${sessionId}`);
  if (rootMeta.child) throw refused(`${sessionId} is a child thread${rootMeta.parent ? ` of ${rootMeta.parent}` : ''}; move the conversation it belongs to`);
  const earliest = dayBefore(rootEntry.parts.slice(1, 4).join('/'));
  const byParent = new Map();
  const seenIds = new Map([[sessionId, rootEntry]]);
  for (const entry of all) {
    if (entry === rootEntry) continue;
    if (entry.parts[0] === 'sessions' && entry.parts.slice(1, 4).join('/') < earliest) continue;
    const meta = cachedFirstLine(path.join(root, ...entry.parts), entry.stat);
    if (!meta || !meta.parent || !meta.id) continue;
    if (!byParent.has(meta.parent)) byParent.set(meta.parent, []);
    byParent.get(meta.parent).push({ ...entry, id: meta.id });
  }
  const files = [rootEntry.parts];
  const visit = (id, depth) => {
    if (depth > CODEX_GRAPH_DEPTH) throw refused(`the thread graph of ${sessionId} is deeper than ${CODEX_GRAPH_DEPTH}`);
    const children = (byParent.get(id) || []).sort((a, b) => a.parts.join('/').localeCompare(b.parts.join('/')));
    for (const child of children) {
      if (seenIds.has(child.id)) throw refused(`thread ${child.id} of ${sessionId} appears more than once, or in a cycle`);
      seenIds.set(child.id, child);
      files.push(child.parts);
      if (files.length > CODEX_GRAPH_MAX) throw refused(`session ${sessionId} has more than ${CODEX_GRAPH_MAX} threads`);
      visit(child.id, depth + 1);
    }
  };
  visit(sessionId, 1);
  for (const parts of files) codexScopedParts(parts, parts.join('/'), parts === files[0] ? sessionId : '');
  return { projectName: null, files };
}

// Whether an open rollout may be read for this session: it is the session's own (its
// session_meta names it) or a child thread's (it names a parent). Never another
// top-level conversation of the account, whose file name merely has the shape.
function codexRolloutReadable(fd, sessionId) {
  const meta = firstLineMeta(fd);
  return Boolean(meta && (meta.id === sessionId || meta.child));
}

function artifactParts(root, sessionId, kind = 'claude') {
  if (kind === 'codex') return codexArtifactParts(root, sessionId);
  const projects = path.join(root, 'projects');
  const projectsStat = lstatOrNull(projects);
  if (projectsStat && (projectsStat.isSymbolicLink() || !projectsStat.isDirectory())) throw refused('projects is not a plain directory');
  const transcripts = [];
  const trees = [];
  for (const slug of projectsStat ? names(projects) : []) {
    if (!plainName(slug, SLUG_RE)) continue;
    const slugStat = fs.lstatSync(path.join(projects, slug));
    if (!slugStat.isDirectory() || slugStat.isSymbolicLink()) continue;
    for (const name of names(path.join(projects, slug))) {
      if (name === `${sessionId}.jsonl`) {
        const stat = fs.lstatSync(path.join(projects, slug, name));
        if (stat.isSymbolicLink() || !stat.isFile()) throw refused(`projects/${slug}/${name} is not a regular file`);
        transcripts.push(['projects', slug, name]);
      } else if (name === sessionId || name.startsWith(`${sessionId}.superseded-`)) {
        if (!plainName(name, NAME_RE)) throw refused(`projects/${slug}/${name} has a name a move cannot carry`);
        const stat = fs.lstatSync(path.join(projects, slug, name));
        if (stat.isSymbolicLink()) throw refused(`projects/${slug}/${name} is a symbolic link`);
        if (stat.isDirectory()) trees.push(['projects', slug, name]);
      }
    }
  }
  if (!transcripts.length) throw coded(`no Claude transcript for ${sessionId} on this node`, 'artifacts-missing');
  if (transcripts.length > 1) throw refused(`session ${sessionId} has a transcript under more than one project`);
  const files = [transcripts[0]];
  for (const tree of trees) walkTree(root, tree, files);
  const historyRoot = lstatOrNull(path.join(root, 'file-history'));
  if (historyRoot && !historyRoot.isSymbolicLink() && historyRoot.isDirectory()) {
    const history = lstatOrNull(path.join(root, 'file-history', sessionId));
    if (history) {
      if (history.isSymbolicLink() || !history.isDirectory()) throw refused(`file-history/${sessionId} is not a plain directory`);
      walkTree(root, ['file-history', sessionId], files);
    }
  }
  return { projectName: transcripts[0][1], files };
}

async function list(root, sessionId, kind = 'claude') {
  const { projectName, files } = artifactParts(root, sessionId, kind);
  const owned = (readProvenance(root, sessionId) || {}).files || {};
  const out = [];
  let bytes = 0;
  for (const parts of files) {
    const digest = await fileDigest(path.join(root, ...parts));
    if (!digest) throw coded(`${parts.join('/')} disappeared while it was listed`, 'artifacts-missing');
    bytes += digest.size;
    if (bytes > TX_MAX_BYTES) throw refused('the session\'s artifacts are larger than a move carries');
    out.push({ relPath: parts.join('/'), size: digest.size, mtimeMs: digest.mtimeMs, mode: digest.mode, sha256: digest.sha256,
      generation: digest.generation, owned: owned[parts.join('/')] === digest.sha256 });
  }
  return { sessionId, projectName, files: out, bytes };
}

// ---------- read ----------

function wholeNumber(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw invalid(`${label} must be a whole number up to ${max}`);
  return value;
}

function read(root, params, kind = 'claude') {
  const parts = scopedParts(params.relPath, params.sessionId, kind);
  const from = wholeNumber(params.from, 'artifacts read from');
  const length = wholeNumber(params.length, 'artifacts read length', REQUEST_MAX_BYTES);
  const file = resolveUnder(root, parts);
  let fd;
  try { fd = openNoFollow(file, fs.constants.O_RDONLY); }
  catch (error) {
    if (error.code === 'ENOENT') throw coded(`${params.relPath} is not on this node`, 'artifacts-missing');
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw refused(`${params.relPath} is not a regular file`);
    if (kind === 'codex' && !codexRolloutReadable(fd, params.sessionId)) {
      throw refused(`${params.relPath} is not a rollout of session ${params.sessionId} or of one of its threads`);
    }
    const want = Math.max(0, Math.min(length, stat.size - from));
    const buffer = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = fs.readSync(fd, buffer, got, want - got, from + got);
      if (!n) break;
      got += n;
    }
    return { relPath: params.relPath, size: stat.size, mtimeMs: stat.mtimeMs, from,
      bytes: buffer.subarray(0, got).toString('base64'), eof: from + got >= stat.size };
  } finally { fs.closeSync(fd); }
}

// ---------- stage, publish, abort ----------

function txDir(root, tx, create) {
  const parts = [MOVE_DIR, tx];
  const dir = resolveUnder(root, parts, { create });
  if (create) {
    const stat = lstatOrNull(dir);
    if (!stat) fs.mkdirSync(dir, { mode: 0o700 });
    else if (stat.isSymbolicLink() || !stat.isDirectory()) throw refused(`${MOVE_DIR}/${tx} is not a plain directory`);
  }
  return dir;
}

function readMeta(dir) {
  const meta = readJson(path.join(dir, 'meta.json'));
  if (meta && (meta.version !== 1 || typeof meta.sessionId !== 'string' || !meta.files || typeof meta.files !== 'object')) {
    throw refused('the move transaction\'s record is not one this node wrote');
  }
  return meta;
}

function decodeBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw invalid('artifacts bytes must be base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > REQUEST_MAX_BYTES) throw invalid(`artifacts stage carries at most ${REQUEST_MAX_BYTES} bytes`);
  return bytes;
}

async function stage(root, params, kind = 'claude') {
  const sessionId = params.sessionId;
  const tx = validTx(params);
  const parts = scopedParts(params.relPath, sessionId, kind);
  const size = wholeNumber(params.size, 'artifacts stage size', TX_MAX_BYTES);
  const from = wholeNumber(params.from, 'artifacts stage from', size);
  if (typeof params.sha256 !== 'string' || !HASH_RE.test(params.sha256)) throw invalid('artifacts stage needs the file\'s sha256');
  const bytes = decodeBytes(params.bytes);
  if (from + bytes.length > size) throw invalid('artifacts stage runs past the size it declares');
  const dir = txDir(root, tx, true);
  const meta = readMeta(dir) || { version: 1, sessionId, accountId: params.account.id, files: {}, createdAt: Date.now() };
  if (meta.sessionId !== sessionId) throw refused(`move transaction ${tx} belongs to another session`);
  const declared = meta.files[params.relPath];
  if (declared && (declared.size !== size || declared.sha256 !== params.sha256)) {
    throw refused(`${params.relPath} was declared with another size or digest in move transaction ${tx}`);
  }
  if (!declared) {
    const total = Object.values(meta.files).reduce((sum, entry) => sum + entry.size, 0) + size;
    if (total > TX_MAX_BYTES) throw refused('a move transaction carries at most 2 GiB');
    meta.files[params.relPath] = { size, sha256: params.sha256 };
    writeJson(path.join(dir, 'meta.json'), meta);
  }
  const file = resolveUnder(dir, ['files', ...parts], { create: true });
  const fd = openNoFollow(file, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
  let staged;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw refused(`the stage for ${params.relPath} is not a regular file`);
    staged = stat.size;
    if (staged === from) {
      let written = 0;
      while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written, from + written);
      staged = from + bytes.length;
    } else if (staged >= from + bytes.length && staged <= size) {
      // A retransmit of a piece already staged: the same bytes are a no-op, other
      // bytes at the same place are a different file.
      const check = Buffer.alloc(bytes.length);
      fs.readSync(fd, check, 0, bytes.length, from);
      if (!check.equals(bytes)) throw refused(`${params.relPath} was staged with other bytes at ${from}`);
    } else if (staged > size) {
      throw refused(`the stage for ${params.relPath} is longer than the file it is for`);
    } else {
      return { relPath: params.relPath, staged, needFrom: staged };
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (staged < size) return { relPath: params.relPath, staged, complete: false };
  const digest = await fileDigest(file);
  if (!digest || digest.sha256 !== params.sha256) {
    fs.rmSync(file, { force: true });
    throw coded(`${params.relPath} did not stage to the digest it was sent with`, 'artifacts-digest');
  }
  return { relPath: params.relPath, staged, complete: true };
}

function provenanceFile(root, sessionId, create) {
  const dir = resolveUnder(root, [MOVE_DIR, 'provenance'], { create });
  if (create && !lstatOrNull(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  return path.join(dir, `${sessionId}.json`);
}

function readProvenance(root, sessionId) {
  const value = readJson(provenanceFile(root, sessionId, false));
  return value && value.version === 1 && value.sessionId === sessionId && value.files && typeof value.files === 'object'
    ? value : null;
}

function writeProvenance(root, sessionId, files, extra = {}) {
  writeJson(provenanceFile(root, sessionId, true), { version: 1, sessionId, files, updatedAt: Date.now(), ...extra });
}

async function publish(root, params, kind = 'claude') {
  const sessionId = params.sessionId;
  const tx = validTx(params);
  if (!Array.isArray(params.entries) || !params.entries.length || params.entries.length > MAX_FILES) {
    throw invalid('artifacts publish needs its entries');
  }
  const seen = new Set();
  const entries = params.entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.sha256 !== 'string' || !HASH_RE.test(entry.sha256)) {
      throw invalid('each published entry names a path and a sha256');
    }
    const parts = scopedParts(entry.relPath, sessionId, kind);
    if (seen.has(entry.relPath)) throw invalid(`${entry.relPath} is published twice`);
    seen.add(entry.relPath);
    return { relPath: entry.relPath, sha256: entry.sha256, size: wholeNumber(entry.size, 'published size', TX_MAX_BYTES), parts };
  });
  if (kind === 'codex'
    ? !entries.some((entry) => entry.parts[0] === 'sessions' && entry.parts[4].endsWith(`-${sessionId}.jsonl`))
    : !entries.some((entry) => entry.parts[0] === 'projects' && entry.parts.length === 3)) {
    throw invalid(kind === 'codex' ? 'a publish carries the session\'s root rollout' : 'a publish carries the session\'s transcript');
  }
  const dir = txDir(root, tx, false);
  const meta = lstatOrNull(dir) ? readMeta(dir) : null;
  if (!meta || meta.sessionId !== sessionId) throw coded(`move transaction ${tx} has nothing staged on this node`, 'artifacts-unstaged');
  const owned = { ...((readProvenance(root, sessionId) || {}).files || {}) };
  const priorPublish = readJson(path.join(dir, 'published.json'));
  const mine = priorPublish && priorPublish.files && typeof priorPublish.files === 'object' ? priorPublish.files : {};
  // Everything is decided before anything moves: a refusal leaves the node as it was.
  const plan = [];
  for (const entry of entries) {
    const target = resolveUnder(root, entry.parts);
    const current = await fileDigest(target);
    if (current && current.sha256 === entry.sha256) { plan.push({ ...entry, target, action: 'unchanged' }); continue; }
    const stagedFile = resolveUnder(dir, ['files', ...entry.parts]);
    const staged = await fileDigest(stagedFile);
    if (!staged || staged.size !== entry.size || staged.sha256 !== entry.sha256) {
      throw coded(`${entry.relPath} is not staged whole in move transaction ${tx}`, 'artifacts-unstaged');
    }
    if (current && owned[entry.relPath] !== current.sha256 && mine[entry.relPath] !== current.sha256) {
      throw coded(`${entry.relPath} on this node differs from what the move carries, and no move put it there`, 'artifacts-conflict');
    }
    if (current) {
      // Where the replaced file will be kept, decided now: a link on the way refuses
      // (resolveUnder), and so does a backup already there.
      const backup = resolveUnder(dir, ['backup', ...entry.parts]);
      if (lstatOrNull(backup)) throw coded(`a backup of ${entry.relPath} is already in move transaction ${tx}`, 'artifacts-conflict');
    }
    plan.push({ ...entry, target, stagedFile, action: current ? 'replaced' : 'created' });
  }
  for (const item of plan) {
    if (item.action === 'unchanged') continue;
    if (item.action === 'replaced') {
      const backup = resolveUnder(dir, ['backup', ...item.parts], { create: true });
      fs.renameSync(item.target, backup);
    }
    const target = resolveUnder(root, item.parts, { create: true });
    fs.renameSync(item.stagedFile, target);
  }
  const files = Object.fromEntries(plan.map((item) => [item.relPath, item.sha256]));
  writeJson(path.join(dir, 'published.json'), { version: 1, sessionId, files: { ...mine, ...files }, publishedAt: Date.now() });
  writeProvenance(root, sessionId, { ...owned, ...files }, { tx });
  return { sessionId, published: plan.map((item) => ({ relPath: item.relPath, sha256: item.sha256, size: item.size, action: item.action })) };
}

// The session has moved away from this account: what is here now is a copy the
// session left behind, and a later move back may replace it.
async function release(root, sessionId, kind = 'claude') {
  const listed = await list(root, sessionId, kind);
  const owned = (readProvenance(root, sessionId) || {}).files || {};
  const files = { ...owned, ...Object.fromEntries(listed.files.map((file) => [file.relPath, file.sha256])) };
  writeProvenance(root, sessionId, files, { released: true });
  return { sessionId, files: listed.files.length };
}

function abort(root, params) {
  const tx = validTx(params);
  const dir = txDir(root, tx, false);
  const stat = lstatOrNull(dir);
  if (!stat) return { tx, removed: false };
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw refused(`${MOVE_DIR}/${tx} is not a plain directory`);
  fs.rmSync(dir, { recursive: true, force: true });
  return { tx, removed: true };
}

function cwd(params) {
  if (typeof params.path !== 'string' || !path.isAbsolute(params.path) || params.path.length > 4096 || /[\0\r\n]/.test(params.path)) {
    throw invalid('artifacts cwd needs an absolute path');
  }
  let stat = null;
  try { stat = fs.statSync(params.path); } catch {}
  return { path: params.path, exists: Boolean(stat), directory: Boolean(stat && stat.isDirectory()) };
}

function dropSession(params, options = {}) {
  const sessionId = validSession(params);
  const env = options.env || process.env;
  const hookClient = require('./hook-client.js');
  const dropped = hookClient.dropSession(env, sessionId);
  let cursor = false;
  try { fs.unlinkSync(hookClient.cursorFile(env, sessionId)); cursor = true; } catch {}
  return { sessionId, dropped, cursor };
}

async function handle(params, options = {}) {
  if (!params || typeof params !== 'object') throw invalid('an artifacts request must be an object');
  if (!OPS.has(params.op)) throw invalid(`artifacts op must be one of ${[...OPS].join(', ')}`);
  if (params.op === 'cwd') return cwd(params);
  if (params.op === 'drop-session') return dropSession(params, options);
  // An account transfer's questions about this node's own account configuration
  // (verb version 3): bin/account-handoff-node.js checks its accounts itself.
  if (HANDOFF_OPS.has(params.op)) return require('./account-handoff-node.js').handle(params, options);
  const root = accountRoot(params, options);
  const kind = validKind(params);
  // Asked before a move stops anything: the account is one this node has configured,
  // and its directory is there to receive the session.
  if (params.op === 'account') return { account: params.account.id, directory: true };
  if (params.op === 'abort') return abort(root, params);
  const sessionId = validSession(params);
  if (params.op === 'list') return list(root, sessionId, kind);
  if (params.op === 'read') return read(root, params, kind);
  if (params.op === 'stage') return stage(root, params, kind);
  if (params.op === 'publish') return publish(root, params, kind);
  return release(root, sessionId, kind);
}

module.exports = {
  handle, scopedParts, resolveUnder, REQUEST_MAX_BYTES, TX_MAX_BYTES, TX_RE, MOVE_DIR, scanStats,
};
