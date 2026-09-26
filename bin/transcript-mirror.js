'use strict';
// The daemon's copy of a transcript that lives on another node.
//
// A Claude session on a pane-only node writes its transcript on that node, and the
// daemon's hook code (the Stop evaluator, attention markers, lifecycle offsets, the
// turn index) reads a transcript from a path. The node's hook sends the bytes the
// daemon does not have yet; they are appended here, and the daemon's own hook runs
// against this file exactly as it runs against a local one.
//
// Layout: <root>/.keep/transcript-mirrors/<node>/<sessionId>.jsonl, with a sidecar
// <sessionId>.json { generation, size, mtimeMs, sourcePath, updatedAt, seededAt? }. The path is
// built from a validated node name and session id only, every directory on the way
// must be a real directory (never a symlink), and the files are opened with
// O_NOFOLLOW, so nothing a request says can place a write anywhere else. The
// transcript bytes are data: they are written to one file and never interpreted
// here. `sourcePath` is the node's path, recorded for people and never opened.
//
// Continuity: a post names the offset its bytes start at, and it must be the
// mirror's current size, or nothing is written and the answer says where to start
// (`needFrom`). A new generation (the node's file was replaced) or a source smaller
// than the mirror (it was truncated) starts the mirror again from 0.
//
// Seeding: when `keep move` carries a session onto a node, the daemon already holds
// the transcript's bytes (its own file, or its mirror of the source node). `seed`
// writes them into the target's mirror, checked against the digest the target listed
// for its copy and stamped with that copy's generation, so the target's hook client
// finds the mirror current and sends only what the session appends after the move,
// not the whole transcript again over the link.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { NODE_NAME_RE } = require('./config.js');

const DIR_NAME = 'transcript-mirrors';
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const GENERATION_RE = /^[A-Za-z0-9:._-]{1,128}$/;
const POST_CAP_BYTES = 4 * 1024 * 1024;
const MIRROR_CAP_BYTES = 512 * 1024 * 1024;
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60e3;
const SOURCE_PATH_MAX = 4096;
const HASH_RE = /^[a-f0-9]{64}$/;
const SEED_CHUNK_BYTES = 1024 * 1024;
// A seed's or a reset's temporary file: `.seed.<sid>.<pid>.<hex>.tmp`, `.reset.…`, or a
// seed's temporary sidecar `.seedside.…`, in the node's mirror directory. The leading dot
// keeps every one of them out of SESSION_RE, so prune never takes one for a session.
const SEED_TEMP_RE = /^\.(?:seed|seedside|reset)\.[A-Za-z0-9_-]{1,128}\.\d+\.[a-f0-9]+\.tmp$/;
const SEED_TEMP_MAX_AGE_MS = 60 * 60e3;

class MirrorError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function refuse(status, message) { throw new MirrorError(status, message); }

// appendAsync and seed run their body on a chain per mirror (node and session). They
// are called from different places (the hook route's posts, a move's or an account
// handoff's seed in serve.js), and two of them on one session would otherwise
// interleave: an append that had read the old sidecar and size could land its bytes on
// the inode a seed just renamed away, then write its old generation's sidecar over the
// seed's, leaving the file and the sidecar disagreeing. Here rather than in each caller,
// so no caller can forget it. Per mirror, so a large seed holds back only that
// session's posts while it hashes (they then see the seeded mirror), never another
// session's. A chain's entry is dropped once its tail settles with nothing queued
// behind it. pruneAsync takes it for each session it removes (see there). The synchronous append and prune do
// not take it either; they are for the CLI and tests, never the daemon's path.
const writeTails = new Map();
function serialized(node, sessionId, fn) {
  const key = `${node}/${sessionId}`;
  const run = (writeTails.get(key) || Promise.resolve()).then(() => fn());
  const tail = run.then(() => {}, () => {});
  writeTails.set(key, tail);
  tail.then(() => { if (writeTails.get(key) === tail) writeTails.delete(key); });
  return run;
}

function mirrorRoot(root) { return path.join(root, '.keep', DIR_NAME); }

function checkedNode(node) {
  if (typeof node !== 'string' || !NODE_NAME_RE.test(node)) refuse(400, 'invalid node name');
  return node;
}

function checkedSession(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) refuse(400, 'invalid session id');
  return sessionId;
}

// The three paths for one session, from validated parts only.
function paths(root, node, sessionId) {
  const dir = path.join(mirrorRoot(root), checkedNode(node));
  const sid = checkedSession(sessionId);
  return { dir, file: path.join(dir, `${sid}.jsonl`), sidecar: path.join(dir, `${sid}.json`) };
}

// A directory that is really one: created when missing, refused when it is a
// symlink or anything else.
function realDirectory(dir, create) {
  let stat;
  try { stat = fs.lstatSync(dir); } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    fs.mkdirSync(dir, { mode: 0o700 });
    stat = fs.lstatSync(dir);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) refuse(403, `${path.basename(dir)} in the mirror directory is not a plain directory`);
}

// Every directory from .keep down to the node's, checked, and the resolved node
// directory required to be exactly where the validated parts put it.
function checkedDirectory(root, node, create) {
  const meta = path.join(root, '.keep');
  if (create) fs.mkdirSync(meta, { recursive: true });
  const top = mirrorRoot(root);
  const { dir } = paths(root, node, 'x');
  realDirectory(top, create);
  realDirectory(dir, create);
  const expected = path.join(fs.realpathSync(meta), DIR_NAME, node);
  if (fs.realpathSync(dir) !== expected) refuse(403, 'the mirror directory resolves outside .keep/transcript-mirrors');
  return dir;
}

async function realDirectoryAsync(dir, create) {
  let stat;
  try { stat = await fs.promises.lstat(dir); } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error;
    try { await fs.promises.mkdir(dir, { mode: 0o700 }); }
    catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
    stat = await fs.promises.lstat(dir);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) refuse(403, `${path.basename(dir)} in the mirror directory is not a plain directory`);
}

async function checkedDirectoryAsync(root, node, create) {
  const meta = path.join(root, '.keep');
  if (create) await fs.promises.mkdir(meta, { recursive: true });
  const top = mirrorRoot(root);
  const { dir } = paths(root, node, 'x');
  await realDirectoryAsync(top, create);
  await realDirectoryAsync(dir, create);
  const expected = path.join(await fs.promises.realpath(meta), DIR_NAME, node);
  if (await fs.promises.realpath(dir) !== expected) refuse(403, 'the mirror directory resolves outside .keep/transcript-mirrors');
  return dir;
}

function readSidecar(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && typeof value.generation === 'string' ? value : null;
  } catch { return null; }
}

// A failed write or rename takes its temporary file with it: a write that fails part
// way (ENOSPC) leaves a partial one, and nothing else would ever remove it (prune takes
// only a seed's or a reset's). EEXIST is left alone: that file is not this write's.
function writeSidecar(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } catch (error) {
    if (error.code !== 'EEXIST') { try { fs.unlinkSync(temp); } catch {} }
    throw error;
  }
}

async function readSidecarAsync(file) {
  try {
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile()) return null;
    const value = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return value && typeof value === 'object' && typeof value.generation === 'string' ? value : null;
  } catch { return null; }
}

async function writeSidecarAsync(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.promises.rename(temp, file);
  } catch (error) {
    if (error.code !== 'EEXIST') await fs.promises.unlink(temp).catch(() => {});
    throw error;
  }
}

function checkedSourcePath(sourcePath) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || sourcePath.includes('\0')
    || /[\r\n]/.test(sourcePath) || Buffer.byteLength(sourcePath) > SOURCE_PATH_MAX) refuse(400, 'invalid transcript source path');
  return sourcePath;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) refuse(400, `${name} must be a non-negative integer`);
  return value;
}

// The mirror's current size, from the file itself (the sidecar may lag a crash).
function currentSize(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) refuse(403, 'the mirror is not a plain file');
    return stat.size;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

async function currentSizeAsync(file) {
  try {
    const stat = await fs.promises.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) refuse(403, 'the mirror is not a plain file');
    return stat.size;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

// Appends one post's bytes. Answers { ok: true, size, reset } after a write,
// { ok: false, needFrom } when the post does not start at the mirror's end (nothing
// written), and { ok: false, status, reason } when a cap refuses it. Throws
// MirrorError for a request that does not make sense. Synchronous, so it does not
// take the write chain the async writers share: it is not the daemon's path.
function append(options = {}) {
  const { root, node, sessionId, generation, fromOffset, size, mtimeMs, sourcePath } = options;
  const now = options.now || Date.now;
  if (!root) throw new Error('transcript-mirror.append needs the registry root');
  const where = paths(root, node, sessionId);
  if (typeof generation !== 'string' || !GENERATION_RE.test(generation)) refuse(400, 'invalid transcript generation');
  nonNegativeInteger(fromOffset, 'fromOffset');
  nonNegativeInteger(size, 'size');
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) refuse(400, 'mtimeMs must be a positive number');
  checkedSourcePath(sourcePath);
  const bytes = options.bytes || Buffer.alloc(0);
  if (!Buffer.isBuffer(bytes)) refuse(400, 'bytes must be a buffer');
  if (bytes.length > POST_CAP_BYTES) return { ok: false, status: 413, reason: `a post carries at most ${POST_CAP_BYTES} bytes` };
  if (fromOffset + bytes.length > size) refuse(400, 'the bytes run past the size the source reports');

  checkedDirectory(root, node, true);
  const sidecar = readSidecar(where.sidecar);
  const actual = currentSize(where.file);
  const reset = !sidecar || sidecar.generation !== generation || size < actual;
  const from = reset ? 0 : actual;
  if (fromOffset !== from) return { ok: false, needFrom: from };
  if (from + bytes.length > MIRROR_CAP_BYTES) {
    return { ok: false, status: 413, reason: `a mirror holds at most ${MIRROR_CAP_BYTES} bytes; this transcript is past it` };
  }
  const writeAll = (fd) => {
    let written = 0;
    while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written);
    // What readers take as activity evidence is the source's time, not the append's.
    fs.futimesSync(fd, now() / 1000, mtimeMs / 1000);
  };
  if (reset) {
    // A reset is a new file renamed over the mirror, never the old one truncated: a
    // reader that remembers the mirror's identity (the background-job ledger's
    // checkpoint) sees a new inode, as it does when a local agent's transcript is
    // rewritten, even when the new bytes happen to end like the old ones.
    const temp = path.join(where.dir, `.reset.${sessionId}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    let placed = false;
    try {
      const fd = fs.openSync(temp,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { writeAll(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, where.file);
      placed = true;
    } finally {
      if (!placed) { try { fs.unlinkSync(temp); } catch {} }
    }
  } else {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW;
    const fd = fs.openSync(where.file, flags, 0o600);
    try {
      if (!fs.fstatSync(fd).isFile()) refuse(403, 'the mirror is not a plain file');
      writeAll(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  const total = from + bytes.length;
  writeSidecar(where.sidecar, { generation, size: total, mtimeMs, sourcePath, updatedAt: now() });
  return { ok: true, size: total, reset };
}

// The hook route uses this equivalent implementation so directory metadata and a
// multi-megabyte append yield the daemon event loop. The synchronous API remains
// for CLI/library callers; both keep the same no-follow and atomic-reset rules.
// Serialized with a seed of the same mirror (see `serialized`).
function appendAsync(options = {}) { return serialized(options.node, options.sessionId, () => appendAsyncNow(options)); }

async function appendAsyncNow(options = {}) {
  const { root, node, sessionId, generation, fromOffset, size, mtimeMs, sourcePath } = options;
  const now = options.now || Date.now;
  if (!root) throw new Error('transcript-mirror.append needs the registry root');
  const where = paths(root, node, sessionId);
  if (typeof generation !== 'string' || !GENERATION_RE.test(generation)) refuse(400, 'invalid transcript generation');
  nonNegativeInteger(fromOffset, 'fromOffset');
  nonNegativeInteger(size, 'size');
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) refuse(400, 'mtimeMs must be a positive number');
  checkedSourcePath(sourcePath);
  const bytes = options.bytes || Buffer.alloc(0);
  if (!Buffer.isBuffer(bytes)) refuse(400, 'bytes must be a buffer');
  if (bytes.length > POST_CAP_BYTES) return { ok: false, status: 413, reason: `a post carries at most ${POST_CAP_BYTES} bytes` };
  if (fromOffset + bytes.length > size) refuse(400, 'the bytes run past the size the source reports');

  await checkedDirectoryAsync(root, node, true);
  const sidecar = await readSidecarAsync(where.sidecar);
  const actual = await currentSizeAsync(where.file);
  const reset = !sidecar || sidecar.generation !== generation || size < actual;
  const from = reset ? 0 : actual;
  if (fromOffset !== from) return { ok: false, needFrom: from };
  if (from + bytes.length > MIRROR_CAP_BYTES) {
    return { ok: false, status: 413, reason: `a mirror holds at most ${MIRROR_CAP_BYTES} bytes; this transcript is past it` };
  }
  const writeAll = async (handle) => {
    let written = 0;
    while (written < bytes.length) written += (await handle.write(bytes, written, bytes.length - written)).bytesWritten;
    await handle.utimes(now() / 1000, mtimeMs / 1000);
  };
  if (reset) {
    const temp = path.join(where.dir, `.reset.${sessionId}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    let placed = false;
    let handle = null;
    try {
      handle = await fs.promises.open(temp,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      await writeAll(handle);
      await handle.close();
      handle = null;
      await fs.promises.rename(temp, where.file);
      placed = true;
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (!placed) await fs.promises.unlink(temp).catch(() => {});
    }
  } else {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW;
    const handle = await fs.promises.open(where.file, flags, 0o600);
    try {
      if (!(await handle.stat()).isFile()) refuse(403, 'the mirror is not a plain file');
      await writeAll(handle);
    } finally { await handle.close(); }
  }
  const total = from + bytes.length;
  await writeSidecarAsync(where.sidecar, { generation, size: total, mtimeMs, sourcePath, updatedAt: now() });
  return { ok: true, size: total, reset };
}

// Replaces a node's mirror of a session with the first `size` bytes of `fromFile`, a
// file the daemon already holds. The bytes are streamed into a temporary file in the
// mirror directory while they are hashed, and only bytes that hash to `sha256` (the
// digest the node listed for its own copy) replace the mirror: a short file, other
// bytes, or a transcript past the mirror cap answer { ok: false, reason } and leave
// the mirror as it was. The new sidecar is written to its own temporary file before
// the mirror is touched, so a sidecar that cannot be written also leaves the mirror as
// it was; then the mirror is renamed into place, then the sidecar. The mirror carries
// the source's mtime as an append does. Answers { ok: true, size } after a seed;
// throws MirrorError for a request that does not make sense, as append does.
//
// Once the request is validated, an I/O failure answers { ok: false, reason } and never
// throws, and no temporary file is left behind. What it leaves: a failure before the
// mirror's rename (reading the source, writing the temporary mirror or sidecar, the
// rename itself) changes nothing, the old mirror and sidecar stand. A failure renaming
// the sidecar after that leaves the new mirror under the old sidecar, so the seed
// writes the sidecar again directly; if that fails too it answers ok:false, and the
// node's next post finds a generation or size that disagrees and starts the mirror
// again from 0, as before seeding existed.
//
// Asynchronous: a transcript can be hundreds of megabytes, and the daemon's loop is
// not held while it is hashed. Serialized with appendAsync on the same mirror.
function seed(options = {}) { return serialized(options.node, options.sessionId, () => seedNow(options)); }

async function seedNow(options = {}) {
  const { root, node, sessionId, fromFile, size, sha256, generation, mtimeMs, sourcePath } = options;
  const now = options.now || Date.now;
  if (!root) throw new Error('transcript-mirror.seed needs the registry root');
  const where = paths(root, node, sessionId);
  if (typeof generation !== 'string' || !GENERATION_RE.test(generation)) refuse(400, 'invalid transcript generation');
  nonNegativeInteger(size, 'size');
  if (typeof sha256 !== 'string' || !HASH_RE.test(sha256)) refuse(400, 'invalid transcript digest');
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) refuse(400, 'mtimeMs must be a positive number');
  checkedSourcePath(sourcePath);
  if (typeof fromFile !== 'string' || !path.isAbsolute(fromFile)) refuse(400, 'the seed needs an absolute file to read');
  if (size > MIRROR_CAP_BYTES) return { ok: false, reason: `a mirror holds at most ${MIRROR_CAP_BYTES} bytes; this transcript is past it` };

  await checkedDirectoryAsync(root, node, true);
  // Named so neither prune nor a session id can ever match them.
  const tag = `${sessionId}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  const temp = path.join(where.dir, `.seed.${tag}.tmp`);
  const sideTemp = path.join(where.dir, `.seedside.${tag}.tmp`);
  let source = null;
  let target = null;
  let placed = false;
  let sidePlaced = false;
  const failed = (error) => error.code || error.message;
  try {
    source = await fs.promises.open(fromFile, fs.constants.O_RDONLY);
    target = await fs.promises.open(temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(SEED_CHUNK_BYTES, size)));
    let copied = 0;
    while (copied < size) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, size - copied), copied);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < bytesRead) written += (await target.write(chunk, written, bytesRead - written)).bytesWritten;
      copied += bytesRead;
    }
    if (copied < size) return { ok: false, reason: `the daemon's copy holds ${copied} of the ${size} bytes the target listed` };
    if (hash.digest('hex') !== sha256) return { ok: false, reason: 'the daemon\'s copy does not match the digest the target listed' };
    // What readers take as activity evidence is the source's time, as after an append.
    await target.utimes(now() / 1000, mtimeMs / 1000);
    await target.close();
    target = null;
    const at = now();
    const side = { generation, size, mtimeMs, sourcePath, updatedAt: at, seededAt: at };
    try {
      await fs.promises.writeFile(sideTemp, `${JSON.stringify(side)}\n`, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      return { ok: false, reason: `the seeded mirror's sidecar could not be written (${failed(error)})` };
    }
    // Past this rename the new mirror is in place under the old sidecar until the
    // sidecar's rename (or its fallback) lands; a crash in between is met by the next
    // append, which finds a generation other than its own (or a size that disagrees)
    // and starts the mirror again from 0, which is what it did before seeding existed.
    await fs.promises.rename(temp, where.file);
    placed = true;
    try {
      await fs.promises.rename(sideTemp, where.sidecar);
      sidePlaced = true;
    } catch {
      try { await writeSidecarAsync(where.sidecar, side); }
      catch (error) {
        return { ok: false, reason: `the mirror was replaced but its sidecar could not be written (${failed(error)}); the next post starts the mirror again` };
      }
    }
  } catch (error) {
    if (error instanceof MirrorError) throw error;
    return { ok: false, reason: `the seed could not be written (${failed(error)})` };
  } finally {
    if (source) await source.close().catch(() => {});
    if (target) await target.close().catch(() => {});
    if (!placed) await fs.promises.unlink(temp).catch(() => {});
    if (!sidePlaced) await fs.promises.unlink(sideTemp).catch(() => {});
  }
  return { ok: true, size };
}

// The sidecar and the mirror's real size, or null when there is no mirror.
function stat(root, node, sessionId) {
  const where = paths(root, node, sessionId);
  const sidecar = readSidecar(where.sidecar);
  let size;
  try {
    const info = fs.lstatSync(where.file);
    if (!info.isFile()) return null;
    size = info.size;
  } catch { return null; }
  return { ...(sidecar || {}), size, path: where.file };
}

function read(root, node, sessionId, { from = 0, length } = {}) {
  const where = paths(root, node, sessionId);
  const fd = fs.openSync(where.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.min(Math.max(0, from), size);
    const count = Math.min(length == null ? size - start : length, size - start);
    const buffer = Buffer.alloc(count);
    let got = 0;
    while (got < count) {
      const n = fs.readSync(fd, buffer, got, count - got, start + got);
      if (!n) break;
      got += n;
    }
    return buffer.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

// Bytes per node, for `keep doctor` on the daemon.
function usage(root) {
  const out = {};
  let nodes;
  try { nodes = fs.readdirSync(mirrorRoot(root), { withFileTypes: true }); } catch { return out; }
  for (const entry of nodes) {
    if (!entry.isDirectory() || !NODE_NAME_RE.test(entry.name)) continue;
    const dir = path.join(mirrorRoot(root), entry.name);
    const row = { bytes: 0, mirrors: 0 };
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const name of names) {
      try {
        const info = fs.lstatSync(path.join(dir, name));
        if (!info.isFile()) continue;
        row.bytes += info.size;
        if (name.endsWith('.jsonl')) row.mirrors += 1;
      } catch {}
    }
    out[entry.name] = row;
  }
  return out;
}

// Mirrors nobody has appended to in a month: the sidecar's updatedAt (its mtime
// when unreadable) decides, and a mirror with no sidecar goes by its own mtime.
// A seed's (or a reset's) temporary file left by a daemon that died mid-write (it can be as large as
// a mirror) goes once it is an hour old. Its age is the later of its mtime and ctime:
// a seed stamps the source's mtime on the file just before renaming it, which moves
// the ctime to now, so a seed still running is never taken for a dead one. Those
// files are not sessions and are not in the answer. Like append, the synchronous
// prune takes no write chain.
function prune(root, { olderThanMs = PRUNE_AFTER_MS, now = Date.now } = {}) {
  const removed = [];
  const cutoff = now() - olderThanMs;
  const seedCutoff = now() - SEED_TEMP_MAX_AGE_MS;
  let nodes;
  try { nodes = fs.readdirSync(mirrorRoot(root), { withFileTypes: true }); } catch { return removed; }
  for (const entry of nodes) {
    if (!entry.isDirectory() || !NODE_NAME_RE.test(entry.name)) continue;
    const dir = path.join(mirrorRoot(root), entry.name);
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const name of names.filter((value) => SEED_TEMP_RE.test(value))) {
      const temp = path.join(dir, name);
      try {
        const info = fs.lstatSync(temp);
        if (info.isFile() && Math.max(info.mtimeMs, info.ctimeMs) < seedCutoff) fs.unlinkSync(temp);
      } catch {}
    }
    const sessions = new Set(names.map((name) => name.replace(/\.(jsonl|json)$/, '')).filter((name) => SESSION_RE.test(name)));
    for (const sid of sessions) {
      const sidecar = path.join(dir, `${sid}.json`);
      const file = path.join(dir, `${sid}.jsonl`);
      let at = null;
      const value = readSidecar(sidecar);
      if (value && Number.isFinite(value.updatedAt)) at = value.updatedAt;
      if (at === null) { try { at = fs.lstatSync(sidecar).mtimeMs; } catch {} }
      if (at === null) { try { at = fs.lstatSync(file).mtimeMs; } catch {} }
      if (at === null || at >= cutoff) continue;
      for (const target of [file, sidecar]) { try { fs.unlinkSync(target); } catch {} }
      removed.push(`${entry.name}/${sid}`);
    }
  }
  return removed;
}

// Each session's decide-and-unlink runs on that mirror's chain (see `serialized`), and
// reads the sidecar there: a seed of a session idle past PRUNE_AFTER_MS (a handoff of an
// old session) can otherwise land between prune reading the old sidecar and unlinking,
// and prune would delete the mirror the seed had just installed. On the chain the seed
// either ran first, so prune reads its fresh sidecar and keeps the mirror, or runs after
// the unlink and installs its mirror anew. The hook route also runs prune on its own
// chain with its posts. The directory walk and the temporary files stay off the chain:
// a temporary file goes only once it is an hour old, while a seed's own are seconds old.
async function pruneAsync(root, { olderThanMs = PRUNE_AFTER_MS, now = Date.now } = {}) {
  const removed = [];
  const cutoff = now() - olderThanMs;
  const seedCutoff = now() - SEED_TEMP_MAX_AGE_MS;
  let nodes;
  try { nodes = await fs.promises.readdir(mirrorRoot(root), { withFileTypes: true }); } catch { return removed; }
  for (const entry of nodes) {
    if (!entry.isDirectory() || !NODE_NAME_RE.test(entry.name)) continue;
    const dir = path.join(mirrorRoot(root), entry.name);
    let names = [];
    try { names = await fs.promises.readdir(dir); } catch {}
    for (const name of names.filter((value) => SEED_TEMP_RE.test(value))) {
      const temp = path.join(dir, name);
      try {
        const info = await fs.promises.lstat(temp);
        if (info.isFile() && Math.max(info.mtimeMs, info.ctimeMs) < seedCutoff) await fs.promises.unlink(temp);
      } catch {}
    }
    const sessions = new Set(names.map((name) => name.replace(/\.(jsonl|json)$/, '')).filter((name) => SESSION_RE.test(name)));
    for (const sid of sessions) {
      // A mirror with a write in flight (an append, a seed) is being used now, so it
      // is not expired: it is skipped rather than waited for. The hook route holds its
      // own chain around this prune, so a wait here behind one large seed would hold
      // every other session's posts behind it too.
      if (writeTails.has(`${entry.name}/${sid}`)) continue;
      if (await serialized(entry.name, sid, () => pruneSessionAsync(dir, sid, cutoff))) removed.push(`${entry.name}/${sid}`);
    }
  }
  return removed;
}

// One session's expiry decision and unlink, run on its mirror's chain; true when removed.
async function pruneSessionAsync(dir, sid, cutoff) {
  const sidecar = path.join(dir, `${sid}.json`);
  const file = path.join(dir, `${sid}.jsonl`);
  let at = null;
  const value = await readSidecarAsync(sidecar);
  if (value && Number.isFinite(value.updatedAt)) at = value.updatedAt;
  if (at === null) { try { at = (await fs.promises.lstat(sidecar)).mtimeMs; } catch {} }
  if (at === null) { try { at = (await fs.promises.lstat(file)).mtimeMs; } catch {} }
  if (at === null || at >= cutoff) return false;
  for (const target of [file, sidecar]) { try { await fs.promises.unlink(target); } catch {} }
  return true;
}

module.exports = {
  append, appendAsync, seed, stat, read, prune, pruneAsync, usage, paths, mirrorRoot, MirrorError,
  POST_CAP_BYTES, MIRROR_CAP_BYTES, PRUNE_AFTER_MS, GENERATION_RE, SESSION_RE,
};
