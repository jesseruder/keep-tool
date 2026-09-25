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
const LOCK_RETRIES = 4;
const LOCK_WAIT_MS = 10;
const MAX_NUMBER = 999999;

function directory(root) { return path.join(root, '.keep'); }
function registryFile(root) { return path.join(directory(root), 'session-numbers.json'); }
function lockFile(root) { return path.join(directory(root), 'session-numbers.lock'); }
// Kept beside the registry so a registry changed from outside Keep can be noticed and
// repaired: a mirror of the last registry Keep itself wrote, and hourly copies of it.
function mirrorFile(root) { return path.join(directory(root), 'session-numbers.last.json'); }
function backupDir(root) { return path.join(directory(root), 'session-numbers-backups'); }
const BACKUPS_KEPT = 48;

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
  try { value = JSON.parse(fs.readFileSync(options.file || registryFile(root), 'utf8')); } catch { return emptyRegistry(); }
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
  require('./config').refuseLiveRegistryUnderTest({ ...process.env, KEEP_DIR: root });
  const dir = directory(root);
  const file = registryFile(root);
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.mkdirSync(dir, { recursive: true });
  // A repair's registry is not shaped like an allocation, so its mirror goes first: a
  // crash between the two then leaves a mirror ahead of the registry, which the next
  // repair restores from, rather than Keep's own output looking like outside damage.
  if (options.mirrorFirst) writeJson(mirrorFile(root), registry);
  fs.writeFileSync(tmp, `${JSON.stringify(registry)}\n`);
  fs.renameSync(tmp, file);
  // Best effort: the registry is written; these only make a later loss recoverable.
  if (!options.mirrorFirst) try { writeJson(mirrorFile(root), registry); } catch {}
  try { snapshot(root, registry, options); } catch {}
}

function writeJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  fs.renameSync(tmp, file);
}

function readMirror(root) {
  if (!fs.existsSync(mirrorFile(root))) return null;
  const mirror = read({ root, file: mirrorFile(root) });
  // A mirror that is itself damaged is no reference; the next scan rewrites it.
  return Object.keys(mirror.ids).length && consistent(mirror) ? mirror : null;
}

// One copy per hour, the last BACKUPS_KEPT of them.
function snapshot(root, registry, options = {}) {
  const dir = backupDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const hour = new Date(options.now || Date.now()).toISOString().slice(0, 13);
  writeJson(path.join(dir, `${hour}.json`), registry);
  const kept = fs.readdirSync(dir).filter((name) => /^\d{4}-\d\d-\d\dT\d\d\.json$/.test(name)).sort();
  for (const name of kept.slice(0, Math.max(0, kept.length - BACKUPS_KEPT))) {
    try { fs.unlinkSync(path.join(dir, name)); } catch {}
  }
}

// Keep only ever adds sessions and raises next, so a registry that lost or changed any
// number Keep last wrote, or would hand out a lower one, was changed from outside Keep;
// the one time that happened a test fixture wrote over it and every session was renumbered.
function regressed(registry, root) {
  // Two sessions sharing a number is damage whatever the mirror says.
  if (!consistent(registry)) return true;
  const mirror = readMirror(root);
  if (!mirror) return false;
  return !extends_(registry, mirror) || !keepShaped(registry, mirror);
}

// What Keep's own allocation adds to the registry it last mirrored: sessions numbered
// consecutively from the mirror's next, and next just past them. Anything else, such as
// a number past next or next raised on its own, came from outside.
function keepShaped(later, earlier) {
  const added = Object.entries(later.ids).filter(([id]) => !Object.hasOwn(earlier.ids, id))
    .map(([, num]) => num).sort((a, b) => a - b);
  return later.next === earlier.next + added.length && added.every((num, index) => num === earlier.next + index);
}

// Every number unique; read() already keeps next past the highest.
function consistent(registry) {
  const nums = Object.values(registry.ids);
  return new Set(nums).size === nums.length;
}

// `later` is `earlier` plus sessions: every number kept, next not lower.
function extends_(later, earlier) {
  if (later.next < earlier.next) return false;
  return Object.entries(earlier.ids).every(([id, num]) => later.ids[id] === num);
}

// What repair starts from: the mirror, or a backup that extends it with more sessions (a
// backup taken after the mirror's write was lost), or with no mirror, the fullest backup.
// A copy that contradicts the mirror is never used, and a healthy registry only gains
// sessions, so a damaged copy (which lost them) never wins on count.
function bestCopy(root) {
  const mirror = readMirror(root);
  let names = [];
  try { names = fs.readdirSync(backupDir(root)).filter((name) => name.endsWith('.json')); } catch {}
  let best = mirror;
  for (const name of names) {
    const copy = read({ root, file: path.join(backupDir(root), name) });
    const size = Object.keys(copy.ids).length;
    if (!size || !consistent(copy) || (mirror && !extends_(copy, mirror))) continue;
    const bestSize = best ? Object.keys(best.ids).length : -1;
    if (size > bestSize || (size === bestSize && copy.next > best.next)) best = copy;
  }
  return best;
}

// Under the lock. Every session the copy numbered keeps that number; a session only the
// damaged registry knows keeps its number when no other session holds it, and is otherwise
// dropped to be numbered again. Allocation resumes past everything ever handed out.
function repair(options) {
  const root = options.root;
  const current = read(options);
  if (!regressed(current, root)) return current;
  const mirror = readMirror(root);
  const copy = bestCopy(root) || { next: 1, ids: {} };
  const ids = { ...copy.ids };
  const held = new Set(Object.values(ids));
  let dropped = 0;
  for (const [id, num] of Object.entries(current.ids)) {
    if (Object.hasOwn(ids, id)) continue;
    if (held.has(num)) { dropped += 1; continue; }
    ids[id] = num;
    held.add(num);
  }
  // Not the damaged file's own next, which may have been raised from outside: past the
  // copy, the mirror, and every number kept.
  const next = Object.values(ids).reduce((most, num) => Math.max(most, num + 1), Math.max(copy.next, mirror?.next || 0));
  const repaired = { next, ids };
  write(repaired, { ...options, mirrorFirst: true });
  try {
    process.stderr.write(`keep: session numbers were changed from outside Keep (next ${current.next}, `
      + `${Object.keys(current.ids).length} sessions; Keep last wrote next ${mirror?.next}, `
      + `${mirror ? Object.keys(mirror.ids).length : 0}); restored ${Object.keys(copy.ids).length} from a copy, renumbering ${dropped}\n`);
  } catch {}
  return repaired;
}

// Read-side: a registry changed from outside Keep names nothing until a scan repairs it,
// so `#n` never resolves to whichever session a damaged file gives that number.
function trusted(registry, root) {
  try { return regressed(registry, root) ? emptyRegistry() : registry; } catch { return emptyRegistry(); }
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

// Returns null when the lock could not be taken; the caller then labels what it
// knows and leaves allocation to the next scan rather than racing.
function withLock(options, run) {
  const root = options.root;
  // The registry a bare test run once replaced: refuse it before touching even its lock,
  // for a caller that never booted through config.apply.
  require('./config').refuseLiveRegistryUnderTest({ ...process.env, KEEP_DIR: root });
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
      // Claim the stale lock by renaming it: rename is atomic, so of two scanners
      // that both judge it stale only one succeeds, and a lock the holder released
      // and someone else re-took in between is never deleted from under them.
      if (stale) {
        const claimed = `${file}.stale-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
        try { fs.renameSync(file, claimed); fs.unlinkSync(claimed); } catch {}
        continue;
      }
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
  // Repaired before anything is labelled from it: a session shown the number a damaged
  // registry gives it would repeat that number back.
  if (options.readOnly !== true) {
    try {
      if (regressed(registry, options.root)) {
        const repaired = withLock(options, () => repair(options));
        // Without the lock, another scanner may be repairing it now: take its answer.
        registry = repaired ? repaired.value : read(options);
      } else if (Object.keys(registry.ids).length && !extends_(readMirror(options.root) || { next: 0, ids: {} }, registry)) {
        // A mirror behind a healthy registry: one from before these records existed, or a
        // write whose mirror was lost to a crash. Bring it up to what this scan read, but
        // only if that is still what is on disk, not a file that replaced it since.
        const seen = JSON.stringify(registry);
        withLock(options, () => {
          const current = read(options);
          if (JSON.stringify(current) !== seen) return;
          writeJson(mirrorFile(options.root), current);
          snapshot(options.root, current, options);
        });
      }
    } catch {}
  }
  // Still damaged (a read-only scan, or a repair that could not run): label nothing from it.
  try { if (regressed(registry, options.root)) return rows; } catch { return rows; }
  const unknown = [];
  for (const session of rows) {
    const id = session && typeof session.id === 'string' ? session.id : '';
    if (!id) continue;
    const known = registry.ids[id];
    if (known) session.num = known;
    else if (!unknown.some((candidate) => candidate.id === id)) unknown.push(session);
  }
  if (!unknown.length) return rows;
  // A read-only scan labels whatever the registry already knows and allocates nothing.
  // Allocation writes the registry file, and a caller that promised to change nothing —
  // `keep tell --dry` — must not. The next ordinary scan
  // numbers these.
  if (options.readOnly === true) return rows;
  try {
    const taken = withLock(options, () => {
      // Re-read under the lock: the other scanner may have allocated since, and the file
      // may have been replaced since the check above, so it is repaired here as well.
      const current = repair(options);
      let next = current.next;
      const ordered = [...unknown].sort((a, b) => startedAt(a) - startedAt(b)
        || String(a.id).localeCompare(String(b.id)));
      // Numbers reach the rows only once the registry holding them is on disk: a
      // number shown for a write that failed could be handed to another session.
      const pending = [];
      for (const session of ordered) {
        const known = current.ids[session.id];
        if (known) { session.num = known; continue; }
        if (next > MAX_NUMBER) break;
        current.ids[session.id] = next;
        pending.push([session, next]);
        next += 1;
      }
      current.next = next;
      if (pending.length) write(current, options);
      for (const [session, num] of pending) session.num = num;
      return current;
    });
    if (!taken) {
      // Lock contention: the holder may have numbered these very sessions while we
      // waited, so read once more, label whatever it wrote, and allocate next scan.
      const current = read(options);
      if (regressed(current, options.root)) return rows;
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
  try { registry = trusted(read(options), options.root); } catch { return null; }
  const number = parseNumber(idOrNumber);
  if (number) {
    const found = Object.entries(registry.ids).find(([, num]) => num === number);
    return found ? { id: found[0], num: number } : null;
  }
  const id = String(idOrNumber);
  const num = registry.ids[id];
  return num ? { id, num } : null;
}

// How Keep names a session in text an agent or Owner reads. Agents copy whatever
// handle they are shown into check-ins and messages, so every place that would print
// a short id prints the session's number instead, and falls back to the 8-character
// prefix only for a session the registry has not numbered yet. Reads are cached on
// the registry file's mtime: a bundle or listing may name hundreds of sessions.
let cached = { file: '', key: '', ids: {} };

function numberFor(id, options = {}) {
  const root = options.root || process.env.KEEP_DIR || path.join(require('os').homedir(), 'keep');
  const file = registryFile(root);
  let stat = null;
  try { stat = fs.statSync(file); } catch { return null; }
  // The mirror decides whether the registry is trusted, so a change to either re-reads.
  let mirror = null;
  try { mirror = fs.statSync(mirrorFile(root)); } catch {}
  const key = `${stat.mtimeMs}:${stat.size}:${mirror ? `${mirror.mtimeMs}:${mirror.size}` : '-'}`;
  if (cached.file !== file || cached.key !== key) {
    let ids = {};
    try { ids = trusted(read({ root }), root).ids; } catch {}
    cached = { file, key, ids };
  }
  return Object.prototype.hasOwnProperty.call(cached.ids, id) ? cached.ids[id] : null;
}

// `#12`, or `4f1c2a9e` for a session with no number yet.
function ref(id, options = {}) {
  const text = String(id == null ? '' : id);
  if (!text) return '';
  const num = numberFor(text, options);
  return num ? label(num) : text.slice(0, 8);
}

// `#12 (<full id>)` where the full id is still needed, e.g. to pass back to a command.
function named(id, options = {}) {
  const text = String(id == null ? '' : id);
  if (!text) return '';
  const num = numberFor(text, options);
  return num ? `${label(num)} (${text})` : text;
}

// The registry for a caller that labels or resolves from it: empty while it is damaged.
function readTrusted(options = {}) { return trusted(read(options), options.root); }

module.exports = { assign, lookup, read, readTrusted, write, parseNumber, label, ref, named, numberFor, registryFile, lockFile, MAX_NUMBER };
