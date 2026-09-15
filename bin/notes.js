'use strict';

// State notes — what is true about a shared resource right now.
//
// The staging incident of 2026-09-11/12: one session put staging into home-only
// mode with no deck-persistence config, and a sibling session validating through
// the staging UI spent an afternoon on a dead end nobody had told it about. A
// hold would have been the wrong tool — the first session was not asking anyone
// to wait, it had changed how the thing behaves — and a check-in on its own card
// was invisible to the other session.
//
// So: an expiring, non-blocking sentence, scoped to a declared resource, visible
// everywhere holds are visible and broadcast to sibling sessions as information.
// NOTHING BLOCKS ON A NOTE. `keep wait --no-hold` does not see one, `keep step
// claim` does not consult one, and an expired note stops nobody — it only nags
// its own author, once, to say whether it is still true.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MESSAGE_LIMIT = 300;
const RETENTION_MS = 7 * 86400e3;
// How long a note that nobody confirmed stays visible, dimmed, after it expires.
const EXPIRED_VISIBLE_MS = 24 * 3600e3;
const SWEEP_EVERY_MS = 60e3;

function defaultRoot() {
  return process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
}

function notesDir(root) {
  return path.join(root || defaultRoot(), '.keep', 'notes');
}

function normalizeProject(value) {
  return require('./steps.js').normalizeProject(value);
}

// One file per project. The basename makes it readable by hand; the digest keeps
// two projects with the same basename (a repo and its worktree) apart.
function projectKey(project) {
  const normalized = normalizeProject(project);
  const base = path.basename(normalized).replace(/[^A-Za-z0-9_.-]/g, '-') || 'project';
  return `${base}-${crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 8)}`;
}

function noteFile(project, root) {
  return path.join(notesDir(root), `${projectKey(project)}.json`);
}

function stampOf(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function atMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : NaN;
}

// Agent-written text that ends up in another session's terminal, a model's
// context, and the reviewer bundle. Stripping C0/C1 and the fence markers is not
// enough: a bidi override (U+202E) reorders what a reader sees without changing a
// byte of what was stored, a zero-width space hides a word boundary, and an
// isolate can swallow the rest of a line. bin/watcher-live.js refuses text like
// that outright, because a delivered message has to be the one Owner graded; a
// note is stored rather than delivered verbatim, so the same class is stripped
// here instead. Same set either way: controls, format characters, line and
// paragraph separators, and every space that is not a plain one.
const SCRUB_CLASS_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
const SCRUB_SPACE_RE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;

// Folded first: a compatibility spelling of a separator is the same separator,
// and stripping only the canonical one leaves the lookalike standing.
function scrub(value) {
  const text = String(value == null ? '' : value);
  const folded = (() => { try { return text.normalize('NFKC'); } catch { return text; } })();
  return folded
    .replace(SCRUB_CLASS_RE, ' ')
    .replace(SCRUB_SPACE_RE, ' ')
    .replace(/<<<|>>>/g, '---')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitize(value, limit = MESSAGE_LIMIT) {
  return scrub(value).slice(0, limit);
}


// ---------- storage ----------

function readFileNotes(file) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  return value && Array.isArray(value.notes) ? value.notes.filter((note) => note && note.id) : [];
}

// Bounded, unlike holds: a cleared or long-expired note has nothing left to say,
// and the file is rewritten often enough that a sweep costs nothing.
function prune(notes, now) {
  return notes.filter((note) => {
    if (note.cleared) return now - atMs(note.cleared) <= RETENTION_MS;
    const until = atMs(note.until);
    return !Number.isFinite(until) || now - until <= RETENTION_MS;
  });
}

function writeFileNotes(file, project, notes, now = Date.now()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const value = { project: normalizeProject(project), notes: prune(notes, now) };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  return value.notes;
}

function loadNotes(project, root) {
  return readFileNotes(noteFile(project, root));
}

// Every note in the registry, for the daemon sweep and lint. Each row carries
// the file it came from so a writer does not have to resolve the project again.
function allNotes(root) {
  const dir = notesDir(root);
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    for (const note of readFileNotes(file)) out.push({ ...note, file });
  }
  return out;
}

function findNote(id, root) {
  for (const note of allNotes(root)) if (note.id === id) return note;
  return null;
}

// Read-modify-write on one project's file. Small files, one writer at a time in
// practice, and a lost update costs a note rather than a card.
function updateNote(id, root, mutate) {
  const found = findNote(id, root);
  if (!found) return null;
  const notes = readFileNotes(found.file);
  const note = notes.find((candidate) => candidate.id === id);
  if (!note) return null;
  const result = mutate(note);
  if (result === false) return note;
  writeFileNotes(found.file, found.project || note.project, notes);
  return note;
}

function nextId(notes, now) {
  let id = `note-${now.toString(36)}`;
  let suffix = 0;
  while (notes.some((note) => note.id === id)) {
    suffix += 1;
    id = `note-${now.toString(36)}${suffix.toString(36)}`;
  }
  return id;
}

function addNote({ project, scopes, by, task, message, until, root, now = Date.now() }) {
  const file = noteFile(project, root);
  const notes = readFileNotes(file);
  const note = {
    id: nextId(notes, now),
    project: normalizeProject(project),
    scopes: [...scopes],
    by: { sessionId: (by && by.sessionId) || '', agent: (by && by.agent) || 'manual' },
    task: task || '',
    message: sanitize(message),
    from: stampOf(new Date(now)),
    until,
    cleared: '',
    extended: [],
    nagged: null,
  };
  notes.push(note);
  writeFileNotes(file, project, notes, now);
  return note;
}

function extendNote(id, until, { root, now = Date.now() } = {}) {
  return updateNote(id, root, (note) => {
    if (note.cleared) return false;
    note.extended = [...(note.extended || []), { at: stampOf(new Date(now)), until }];
    note.until = until;
    // A fresh window deserves a fresh nag: the note is being asserted again.
    note.nagged = null;
  });
}

function clearNote(id, message, { root, now = Date.now() } = {}) {
  return updateNote(id, root, (note) => {
    if (note.cleared) return false;
    note.cleared = stampOf(new Date(now));
    if (message) note.message = sanitize(`${note.message} — cleared: ${message}`);
  });
}

// ---------- reading ----------

function scopeMatches(note, scopes) {
  if (!scopes || !scopes.length) return true;
  return (note.scopes || []).some((scope) => scopes.includes(scope));
}

// Mirrors activeHolds: lazy expiry on read, no writes. Expired-but-unconfirmed
// notes come back separately rather than disappearing, so every view can show
// them dimmed for a day and Owner can see what nobody answered for.
function activeNotes(project, now = Date.now(), options = {}) {
  const root = options.root;
  const scopes = options.scope ? (Array.isArray(options.scope) ? options.scope : [options.scope]) : [];
  const rows = project ? loadNotes(project, root) : allNotes(root);
  const wanted = project ? normalizeProject(project) : '';
  const active = [];
  const expired = [];
  for (const note of rows) {
    if (note.cleared) continue;
    if (wanted && normalizeProject(note.project) !== wanted) continue;
    if (!scopeMatches(note, scopes)) continue;
    const until = atMs(note.until);
    if (!Number.isFinite(until) || until > now) active.push(note);
    else if (now - until <= EXPIRED_VISIBLE_MS) expired.push(note);
  }
  const byUntil = (a, b) => String(a.until).localeCompare(String(b.until));
  return { active: active.sort(byUntil), expired: expired.sort(byUntil) };
}

function shortSession(note) {
  return String((note.by && note.by.sessionId) || '').slice(0, 8);
}

function describeNote(note) {
  const by = note.by || {};
  const sid = shortSession(note);
  return `[${(note.scopes || []).join(', ') || 'unscoped'}] ${note.message}`
    + ` — ${by.agent || 'manual'}${sid ? ` ${sid}` : ''}, until ${String(note.until).slice(11, 16) || note.until}`;
}

// ---------- the broadcast ----------

const ANNOUNCE_PREFIX = '[keep] ';

function announcementFor(note, event = 'create') {
  const by = note.by || {};
  const sid = shortSession(note);
  const who = `${by.agent || 'manual'}${sid ? ` ${sid}` : ''}`;
  const where = path.basename(normalizeProject(note.project)) || note.project;
  const scope = (note.scopes || []).join(', ') || 'unscoped';
  const until = String(note.until || '').slice(11, 16);
  const head = `${ANNOUNCE_PREFIX}state note on ${scope} (${where})`;
  if (event === 'clear') {
    return `${head} cleared: ${note.message} — by ${who}. Information only; nothing is blocked.`;
  }
  const verb = event === 'extend' ? ' extended' : '';
  return `${head}${verb}: ${note.message} — by ${who}, until ${until}. Information only; nothing is blocked.`;
}

function nagFor(note) {
  const scope = (note.scopes || []).join(', ') || 'unscoped';
  return `${ANNOUNCE_PREFIX}your state note on ${scope} expired: is "${note.message}" still true?`
    + ` keep note --extend ${note.id} --for +2h, or keep note --clear ${note.id}.`;
}

// ---------- the expiry nag ----------

function dueForNag(now, root) {
  return allNotes(root).filter((note) => {
    if (note.cleared || note.nagged) return false;
    const until = atMs(note.until);
    return Number.isFinite(until) && until <= now;
  });
}

function markNagged(id, value, root) {
  return updateNote(id, root, (note) => {
    if (note.nagged) return false;
    note.nagged = value;
  });
}

// One nag per note, ever. A note whose author is gone is marked `owner` and left
// to the brief and to lint; nothing chases a session that is not there.
async function sweep(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const root = options.root;
  const due = dueForNag(now, root);
  if (!due.length) return { changed: 0, nagged: 0, owner: 0 };
  const live = require('./watcher-live.js');
  let sessions = [];
  try { sessions = (options.sessions ? options.sessions() : []) || []; } catch {}
  let nagged = 0;
  let owner = 0;
  for (const note of due) {
    const sessionId = (note.by && note.by.sessionId) || '';
    const session = sessionId ? sessions.find((candidate) => candidate && candidate.id === sessionId) : null;
    const notReady = live.sessionReady(session);
    if (!session || notReady || typeof options.send !== 'function') {
      markNagged(note.id, { at: now, owner: true, reason: notReady || 'no session' }, root);
      owner += 1;
      continue;
    }
    try {
      await options.send(sessionId, nagFor(note));
      markNagged(note.id, { at: now, sessionId }, root);
      nagged += 1;
    } catch (error) {
      // A terminal that could not take the message is not a note to give up on;
      // leave it unnagged so the next sweep tries once more.
      if (process.env.KEEP_DEBUG) process.stderr.write(`keep notes: nag failed: ${error.message}\n`);
    }
  }
  return { changed: nagged + owner, nagged, owner };
}

function startScheduler(options = {}) {
  const health = options.health || require('./health.js');
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await sweep(options);
      if (result.changed && options.onChange) options.onChange();
      health.record('notes', {
        ok: true, cadenceMs: SWEEP_EVERY_MS, skipped: !result.changed,
        detail: result.changed ? `${result.nagged} nagged, ${result.owner} left to Owner` : 'nothing due',
      });
    } catch (error) {
      health.record('notes', { ok: false, cadenceMs: SWEEP_EVERY_MS, error });
      process.stderr.write(`keep notes: sweep failed: ${error.message}\n`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, SWEEP_EVERY_MS);
  timer.unref();
  setTimeout(() => { void tick(); }, 7e3).unref();
  return { tick, timer };
}

module.exports = {
  MESSAGE_LIMIT, RETENTION_MS, EXPIRED_VISIBLE_MS, SWEEP_EVERY_MS, ANNOUNCE_PREFIX,
  defaultRoot, notesDir, noteFile, projectKey, scrub, sanitize, stampOf,
  loadNotes, allNotes, findNote, addNote, extendNote, clearNote, writeFileNotes,
  activeNotes, describeNote, announcementFor, nagFor,
  dueForNag, markNagged, sweep, startScheduler,
};
