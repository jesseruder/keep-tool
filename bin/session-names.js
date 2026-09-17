'use strict';

// Names Owner types by hand for a session. The AI title generator renames a
// session whenever the effort moves, which is what most sessions want; a session
// Owner has named is not one of them, so a name here both replaces the title
// everywhere it shows and switches generation off for that session (the `renamed`
// flag bin/titles.js reads). Clearing the name hands the session back to the
// generator.
//
// The registry is one small JSON file written atomically under a lock, because
// two writers exist: the daemon's rename route, and `keep rename` writing the
// file itself while the daemon is down. Each set is a read-modify-write of the
// whole file, so without the lock one writer could drop the other's entry.

const fs = require('fs');
const path = require('path');
const sessionNumbers = require('./session-numbers.js');

const MAX_TITLE = 120;
const LOCK_RETRIES = 20;

function directory(root) { return path.join(root, '.keep'); }
function registryFile(root) { return path.join(directory(root), 'session-names.json'); }
function lockFile(root) { return path.join(directory(root), 'session-names.lock'); }

// Session ids are route input, so the map has no prototype: `constructor` or
// `__proto__` must be an absent key, not an inherited value.
function emptyRegistry() { return { version: 1, names: Object.create(null) }; }

// Owner's text, not a model's: strip what would corrupt a line of console UI
// (control, bidi-override and zero-width characters), then collapse and cap.
function sanitize(text) {
  return String(text == null ? '' : text)
    // Newlines and tabs become the space they read as; only then are the
    // remaining invisible characters dropped, so words are not glued together.
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE)
    .trim();
}

function read(options = {}) {
  const root = options.root;
  let value = null;
  try { value = JSON.parse(fs.readFileSync(registryFile(root), 'utf8')); } catch { return emptyRegistry(); }
  if (!value || typeof value !== 'object' || value.version !== 1) return emptyRegistry();
  const source = value.names && typeof value.names === 'object' && !Array.isArray(value.names) ? value.names : {};
  const names = Object.create(null);
  for (const [id, entry] of Object.entries(source)) {
    if (!Object.hasOwn(source, id)) continue;
    const title = sanitize(entry && entry.title);
    if (!title) continue;
    names[id] = { title, at: Number.isFinite(entry.at) ? entry.at : 0 };
  }
  return { version: 1, names };
}

function write(value, options = {}) {
  const file = registryFile(options.root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

// An empty title deletes the entry: that is how Owner hands the session back to
// automatic titling.
function set(sessionId, title, options = {}) {
  const id = String(sessionId == null ? '' : sessionId);
  const clean = sanitize(title);
  const lockOptions = { root: options.root, lockFile: lockFile(options.root), lockRetries: LOCK_RETRIES, ...options };
  const locked = sessionNumbers.withLock(lockOptions, () => {
    const registry = read(options);
    if (clean) registry.names[id] = { title: clean, at: Date.now() };
    else delete registry.names[id];
    write(registry, options);
  });
  if (!locked) throw new Error('the session-name registry is busy; try again');
  return { sessionId: id, title: clean || null };
}

function lookup(sessionId, options = {}) {
  const id = String(sessionId == null ? '' : sessionId);
  if (!id) return null;
  return read(options).names[id]?.title || null;
}

// Stamps every named session with its name and the flag that stops generation.
// The row's own title moves to baseTitle first (applyLiveTitles would have done
// that, but it skips renamed rows), so a row that arrives from a cache filled
// while it still had a name gets that title back, and the flag removed, once the
// name is cleared; otherwise the old name would be adopted as the base title and
// shown for ever. Never throws: a scan that cannot read the registry is still a
// usable scan.
function apply(sessions, options = {}) {
  const rows = Array.isArray(sessions) ? sessions : [];
  if (!options.root || !rows.length) return rows;
  try {
    const { names } = read(options);
    for (const session of rows) {
      if (!session || typeof session !== 'object') continue;
      const name = typeof session.id === 'string' ? names[session.id] : null;
      if (name) {
        if (session.baseTitle == null) session.baseTitle = session.title ?? '';
        session.title = name.title;
        session.renamed = true;
      } else if (session.renamed) {
        delete session.renamed;
        if (typeof session.baseTitle === 'string') session.title = session.baseTitle;
      }
    }
  } catch {}
  return rows;
}

module.exports = { apply, lookup, read, set, write, sanitize, registryFile, lockFile, MAX_TITLE };
