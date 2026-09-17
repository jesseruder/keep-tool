'use strict';

// Names Owner types by hand for a session. The AI title generator renames a
// session whenever the effort moves, which is what most sessions want; a session
// Owner has named is not one of them, so a name here both replaces the title
// everywhere it shows and switches generation off for that session (the `renamed`
// flag bin/titles.js reads). Clearing the name hands the session back to the
// generator.
//
// Each named session is its own file under `<root>/.keep/session-names/`, named
// `<id>.json`. Two writers exist — the daemon's rename route, and `keep rename`
// writing the file itself while the daemon is down — and one file per session is
// what keeps them out of each other's way: a rename replaces (or unlinks) one
// session's file and never rewrites anybody else's entry, so no lock is needed
// and a crashed writer cannot wedge every later rename. A session id is checked
// against the same pattern the route and the CLI check, so it can only ever name
// a file inside that directory.

const fs = require('fs');
const path = require('path');

const MAX_TITLE = 120;
const ID = /^[A-Za-z0-9_-]+$/;

function directory(root) { return path.join(root, '.keep', 'session-names'); }

function nameFile(root, sessionId) {
  const id = String(sessionId == null ? '' : sessionId);
  if (!ID.test(id)) throw new Error('bad session id');
  return path.join(directory(root), `${id}.json`);
}

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

// A stored entry, or null for anything unreadable, corrupt or empty: a bad file
// is one missing name, never a thrown scan.
function readEntry(file) {
  let value = null;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.title !== 'string') return null;
  const title = sanitize(value.title);
  if (!title) return null;
  return { title, at: Number.isFinite(value.at) ? value.at : 0 };
}

// Session ids are route input, so the map has no prototype: `constructor` or
// `__proto__` must be an absent key, not an inherited value.
function read(options = {}) {
  const names = Object.create(null);
  let entries = [];
  try { entries = fs.readdirSync(directory(options.root)); } catch { return { version: 2, names }; }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -'.json'.length);
    if (!ID.test(id)) continue;
    const value = readEntry(path.join(directory(options.root), entry));
    if (value) names[id] = value;
  }
  return { version: 2, names };
}

// An empty title deletes the file: that is how Owner hands the session back to
// automatic titling.
function set(sessionId, title, options = {}) {
  const file = nameFile(options.root, sessionId);
  const id = path.basename(file, '.json');
  const clean = sanitize(title);
  if (!clean) {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { sessionId: id, title: null };
  }
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ title: clean, at: Date.now() }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
  return { sessionId: id, title: clean };
}

function lookup(sessionId, options = {}) {
  let file = null;
  try { file = nameFile(options.root, sessionId); } catch { return null; }
  return readEntry(file)?.title || null;
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

module.exports = { apply, lookup, read, set, sanitize, directory, nameFile, MAX_TITLE };
