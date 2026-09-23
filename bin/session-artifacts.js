'use strict';
// The `artifacts` verb: what a node's host does so a Claude session can be moved onto
// it or off it. A session's artifacts are its transcript, its session trees (the
// primary `<sid>/` beside the transcript and any `<sid>.superseded-*` tree under any
// project) and its file history, all under one account's config directory. Every
// node shares the home path, so the same relative paths name the same artifacts on
// both machines, and that is all that ever travels: a path relative to the account
// directory, checked here against the shapes a session's artifacts can have.
//
//   list    { sessionId, account }                    -> { projectName, files: [{ relPath, size, mtimeMs, mode, sha256 }], bytes }
//   read    { sessionId, account, relPath, from, length ≤ 4 MiB } -> { relPath, size, mtimeMs, from, bytes, eof }
//   stage   { sessionId, account, tx, relPath, from, bytes, size, sha256 }
//                                                      -> { relPath, staged, complete } | { relPath, staged, needFrom }
//   publish { sessionId, account, tx, entries: [{ relPath, sha256, size }] } -> { published: [{ relPath, sha256, size, action }] }
//   release { sessionId, account }                    -> { files }: the session left this node; what it left behind is ours to replace
//   abort   { account, tx }                           -> { removed }
//   cwd     { path }                                  -> { path, exists, directory }
//   account { account }                               -> { account, directory: true }: this node has the account, and its directory
//   drop-session { sessionId }                        -> { dropped }: this node's hook queue and mirror cursor for the session
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
const OPS = new Set(['list', 'read', 'stage', 'publish', 'release', 'abort', 'cwd', 'drop-session', 'account']);

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
  if (typeof params.tx !== 'string' || !TX_RE.test(params.tx)) throw invalid('artifacts transaction id is not a transaction id');
  return params.tx;
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
  let account;
  try {
    account = require('./node-transcript.js').nodeAccount({ kind: 'claude', account: params.account }, options);
  } catch (error) { throw refused(error.message); }
  let stat;
  try { stat = fs.statSync(account.root); } catch { stat = null; }
  if (!stat || !stat.isDirectory()) throw refused(`${account.id}'s config directory is not a directory on this node`);
  return account.root;
}

// A relative path the session's artifacts can have, split into its parts, or a
// refusal. The shapes are exactly the ones account-artifacts moves between accounts.
function scopedParts(relPath, sessionId) {
  if (typeof relPath !== 'string' || !relPath || relPath.length > 4096 || relPath.includes('\\')) {
    throw invalid('artifacts path must be a relative path');
  }
  const parts = relPath.split('/');
  if (!parts.every((part) => plainName(part, NAME_RE))) throw invalid(`artifacts path has a part that is not a plain name: ${relPath}`);
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
    return { sha256: await hashFd(fd), size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777 };
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

function artifactParts(root, sessionId) {
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

async function list(root, sessionId) {
  const { projectName, files } = artifactParts(root, sessionId);
  const out = [];
  let bytes = 0;
  for (const parts of files) {
    const digest = await fileDigest(path.join(root, ...parts));
    if (!digest) throw coded(`${parts.join('/')} disappeared while it was listed`, 'artifacts-missing');
    bytes += digest.size;
    if (bytes > TX_MAX_BYTES) throw refused('the session\'s artifacts are larger than a move carries');
    out.push({ relPath: parts.join('/'), size: digest.size, mtimeMs: digest.mtimeMs, mode: digest.mode, sha256: digest.sha256 });
  }
  return { sessionId, projectName, files: out, bytes };
}

// ---------- read ----------

function wholeNumber(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw invalid(`${label} must be a whole number up to ${max}`);
  return value;
}

function read(root, params) {
  const parts = scopedParts(params.relPath, params.sessionId);
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

async function stage(root, params) {
  const sessionId = params.sessionId;
  const tx = validTx(params);
  const parts = scopedParts(params.relPath, sessionId);
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

async function publish(root, params) {
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
    const parts = scopedParts(entry.relPath, sessionId);
    if (seen.has(entry.relPath)) throw invalid(`${entry.relPath} is published twice`);
    seen.add(entry.relPath);
    return { relPath: entry.relPath, sha256: entry.sha256, size: wholeNumber(entry.size, 'published size', TX_MAX_BYTES), parts };
  });
  if (!entries.some((entry) => entry.parts[0] === 'projects' && entry.parts.length === 3)) {
    throw invalid('a publish carries the session\'s transcript');
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
    plan.push({ ...entry, target, stagedFile, action: current ? 'replaced' : 'created' });
  }
  for (const item of plan) {
    if (item.action === 'unchanged') continue;
    if (item.action === 'replaced') {
      const backup = resolveUnder(dir, ['backup', ...item.parts], { create: true });
      if (lstatOrNull(backup)) throw coded(`a backup of ${item.relPath} is already in move transaction ${tx}`, 'artifacts-conflict');
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
async function release(root, sessionId) {
  const listed = await list(root, sessionId);
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
  const root = accountRoot(params, options);
  // Asked before a move stops anything: the account is one this node has configured,
  // and its directory is there to receive the session.
  if (params.op === 'account') return { account: params.account.id, directory: true };
  if (params.op === 'abort') return abort(root, params);
  const sessionId = validSession(params);
  if (params.op === 'list') return list(root, sessionId);
  if (params.op === 'read') return read(root, params);
  if (params.op === 'stage') return stage(root, params);
  if (params.op === 'publish') return publish(root, params);
  return release(root, sessionId);
}

module.exports = {
  handle, scopedParts, REQUEST_MAX_BYTES, TX_MAX_BYTES, TX_RE, MOVE_DIR,
};
