'use strict';

// Short, stable numbers for sessions. The console lists dozens of sessions whose
// only durable handle is a uuid; a number Owner can read off the screen and type
// back ("#12") is what the CLI and the open API accept wherever an id is accepted.
//
// Numbers are allocated once, in ascending order of the session's earliest known
// timestamp, and never reused or renumbered: a session that scrolls out of the
// scan window and comes back keeps the number it had. The registry is a single
// small JSON file, written atomically, guarded by a lock file because the daemon
// and its dashboard worker thread both scan.

const fs = require('fs');
const path = require('path');

const LOCK_STALE_MS = 5000;
const LOCK_RETRIES = 6;
const LOCK_WAIT_MS = 25;
const MAX_NUMBER = 999999;

function directory(root) { return path.join(root, '.keep'); }
function registryFile(root) { return path.join(directory(root), 'session-numbers.json'); }
function lockFile(root) { return path.join(directory(root), 'session-numbers.lock'); }

function emptyRegistry() { return { next: 1, ids: {} }; }

// `#12`, `12` and `s12` all name session 12. An 8+ character token is an id
// prefix even when it happens to be all digits, so ids are never shadowed.
function parseNumber(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 && value <= MAX_NUMBER ? value : null;
  }
  const match = /^[#sS]?([0-9]{1,6})$/.exec(String(value == null ? '' : value).trim());
  if (!match) return null;
  const number = Number(match[1]);
  return number >= 1 && number <= MAX_NUMBER ? number : null;
}

function label(num) {
  const number = parseNumber(num);
  return number ? `#${number}` : '';
}

function read(options = {}) {
  const root = options.root;
  let value = null;
  try { value = JSON.parse(fs.readFileSync(registryFile(root), 'utf8')); } catch { return emptyRegistry(); }
  if (!value || typeof value !== 'object') return emptyRegistry();
  const ids = {};
  let highest = 0;
  for (const [id, num] of Object.entries(value.ids && typeof value.ids === 'object' ? value.ids : {})) {
    if (!Number.isInteger(num) || num < 1 || num > MAX_NUMBER) continue;
    ids[id] = num;
    if (num > highest) highest = num;
  }
  const next = Number.isInteger(value.next) && value.next > highest ? value.next : highest + 1;
  return { next, ids };
}

function write(registry, options = {}) {
  const root = options.root;
  const dir = directory(root);
  const file = registryFile(root);
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(registry)}\n`);
  fs.renameSync(tmp, file);
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

// Returns null when the lock could not be taken; the caller then labels what it
// knows and leaves allocation to the next scan rather than racing.
function withLock(options, run) {
  const root = options.root;
  const file = lockFile(root);
  const retries = Number.isInteger(options.lockRetries) ? options.lockRetries : LOCK_RETRIES;
  const waitMs = Number.isInteger(options.lockWaitMs) ? options.lockWaitMs : LOCK_WAIT_MS;
  const staleMs = Number.isInteger(options.lockStaleMs) ? options.lockStaleMs : LOCK_STALE_MS;
  try { fs.mkdirSync(directory(root), { recursive: true }); } catch { return null; }
  let handle = null;
  for (let attempt = 0; attempt <= retries && handle === null; attempt++) {
    try { handle = fs.openSync(file, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') return null;
      // A crashed writer must not stop every later scan from numbering anything.
      let stale = false;
      try { stale = Date.now() - fs.statSync(file).mtimeMs > staleMs; } catch { stale = true; }
      if (stale) { try { fs.unlinkSync(file); } catch {} continue; }
      if (attempt < retries) sleepSync(waitMs);
    }
  }
  if (handle === null) return null;
  try { return { value: run() }; }
  finally {
    try { fs.closeSync(handle); } catch {}
    try { fs.unlinkSync(file); } catch {}
  }
}

// The first timestamp a session can show. Backfilling an existing fleet this way
// numbers the oldest transcripts lowest, so the numbers read like a history.
function startedAt(session) {
  for (const key of ['startedAt', 'createdAt', 'firstSeen', 'firstUserAt', 'mtime']) {
    const value = session && session[key];
    const time = typeof value === 'number' ? value : Date.parse(value);
    if (Number.isFinite(time) && time > 0) return time;
  }
  return Number.MAX_SAFE_INTEGER;
}

// Sets `session.num` on every session the registry knows, allocating numbers for
// the ones it does not. Never throws: a scan that cannot number its sessions is
// still a usable scan.
function assign(sessions, options = {}) {
  const rows = Array.isArray(sessions) ? sessions : [];
  if (!options.root) return rows;
  let registry;
  try { registry = read(options); } catch { return rows; }
  const unknown = [];
  for (const session of rows) {
    const id = session && typeof session.id === 'string' ? session.id : '';
    if (!id) continue;
    const known = registry.ids[id];
    if (known) session.num = known;
    else if (!unknown.some((candidate) => candidate.id === id)) unknown.push(session);
  }
  if (!unknown.length) return rows;
  try {
    const taken = withLock(options, () => {
      // Re-read under the lock: the other scanner may have allocated since.
      const current = read(options);
      let next = current.next;
      const ordered = [...unknown].sort((a, b) => startedAt(a) - startedAt(b)
        || String(a.id).localeCompare(String(b.id)));
      let added = 0;
      for (const session of ordered) {
        const known = current.ids[session.id];
        if (known) { session.num = known; continue; }
        if (next > MAX_NUMBER) break;
        current.ids[session.id] = next;
        session.num = next;
        next += 1;
        added += 1;
      }
      current.next = next;
      if (added) write(current, options);
      return current;
    });
    if (!taken) {
      // Lock contention: the holder may have numbered these very sessions while we
      // waited, so read once more, label whatever it wrote, and allocate next scan.
      const current = read(options);
      for (const session of unknown) {
        const known = current.ids[session.id];
        if (known) session.num = known;
      }
    }
  } catch {}
  return rows;
}

// Read-only: the CLI resolves numbers through this and never allocates.
function lookup(idOrNumber, options = {}) {
  if (idOrNumber == null || idOrNumber === '') return null;
  let registry;
  try { registry = read(options); } catch { return null; }
  const number = parseNumber(idOrNumber);
  if (number) {
    const found = Object.entries(registry.ids).find(([, num]) => num === number);
    return found ? { id: found[0], num: number } : null;
  }
  const id = String(idOrNumber);
  const num = registry.ids[id];
  return num ? { id, num } : null;
}

module.exports = { assign, lookup, read, write, parseNumber, label, registryFile, lockFile, MAX_NUMBER };
