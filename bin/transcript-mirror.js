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

class MirrorError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function refuse(status, message) { throw new MirrorError(status, message); }

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

function readSidecar(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && typeof value.generation === 'string' ? value : null;
  } catch { return null; }
}

function writeSidecar(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
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

// Appends one post's bytes. Answers { ok: true, size, reset } after a write,
// { ok: false, needFrom } when the post does not start at the mirror's end (nothing
// written), and { ok: false, status, reason } when a cap refuses it. Throws
// MirrorError for a request that does not make sense.
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
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(where.file, flags, 0o600);
  try {
    if (!fs.fstatSync(fd).isFile()) refuse(403, 'the mirror is not a plain file');
    if (reset) fs.ftruncateSync(fd, 0);
    let written = 0;
    while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written);
    // What readers take as activity evidence is the source's time, not the append's.
    fs.futimesSync(fd, now() / 1000, mtimeMs / 1000);
  } finally {
    fs.closeSync(fd);
  }
  const total = from + bytes.length;
  writeSidecar(where.sidecar, { generation, size: total, mtimeMs, sourcePath, updatedAt: now() });
  return { ok: true, size: total, reset };
}

// Replaces a node's mirror of a session with the first `size` bytes of `fromFile`, a
// file the daemon already holds. The bytes are streamed into a temporary file in the
// mirror directory while they are hashed, and only bytes that hash to `sha256` (the
// digest the node listed for its own copy) replace the mirror: a short file, other
// bytes, or a transcript past the mirror cap answer { ok: false, reason } and leave
// the mirror as it was. The mirror is renamed into place before its sidecar is
// written, and it carries the source's mtime as an append does. Answers
// { ok: true, size } after a seed; throws MirrorError for a request that does not
// make sense, as append does. Asynchronous: a transcript can be hundreds of
// megabytes, and the daemon's loop is not held while it is hashed.
async function seed(options = {}) {
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

  checkedDirectory(root, node, true);
  // Named so neither prune nor a session id can ever match it.
  const temp = path.join(where.dir, `.seed.${sessionId}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let source = null;
  let target = null;
  let placed = false;
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
    fs.renameSync(temp, where.file);
    placed = true;
  } finally {
    if (source) await source.close().catch(() => {});
    if (target) await target.close().catch(() => {});
    if (!placed) { try { fs.unlinkSync(temp); } catch {} }
  }
  const at = now();
  writeSidecar(where.sidecar, { generation, size, mtimeMs, sourcePath, updatedAt: at, seededAt: at });
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
function prune(root, { olderThanMs = PRUNE_AFTER_MS, now = Date.now } = {}) {
  const removed = [];
  const cutoff = now() - olderThanMs;
  let nodes;
  try { nodes = fs.readdirSync(mirrorRoot(root), { withFileTypes: true }); } catch { return removed; }
  for (const entry of nodes) {
    if (!entry.isDirectory() || !NODE_NAME_RE.test(entry.name)) continue;
    const dir = path.join(mirrorRoot(root), entry.name);
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
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

module.exports = {
  append, seed, stat, read, prune, usage, paths, mirrorRoot, MirrorError,
  POST_CAP_BYTES, MIRROR_CAP_BYTES, PRUNE_AFTER_MS, GENERATION_RE, SESSION_RE,
};
