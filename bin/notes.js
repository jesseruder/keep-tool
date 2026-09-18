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
const { ref: sessionRef } = require('./session-numbers.js');
const os = require('os');
const crypto = require('crypto');

const MESSAGE_LIMIT = 300;
const RETENTION_MS = 7 * 86400e3;
// How long a note that nobody confirmed stays visible, dimmed, after it expires.
const EXPIRED_VISIBLE_MS = 24 * 3600e3;
const SWEEP_EVERY_MS = 60e3;
// A nag whose author is merely busy is retried, not thrown away — but not
// forever: after this many sweeps the note is Owner's, and the brief and lint
// carry it from there.
const NAG_ATTEMPT_LIMIT = 6;

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
const SCRUB_CLASS_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const SCRUB_SPACE_RE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/;

function offends(text) {
  return SCRUB_CLASS_RE.test(text) || SCRUB_SPACE_RE.test(text);
}

// An ESC byte is a control character, so `scrub` already replaces it with a
// space — but that leaves `[2J` behind as visible junk, and a reader cannot tell
// the remains of a screen-clear from something somebody typed. These remove the
// whole sequence instead: CSI (`ESC [ … final`), OSC and the other string
// introducers up to their terminator, and a lone two-character escape.
//
// This matters wherever text written by somebody else is typed into a terminal.
// An alert title, a Grafana annotation or a Slack reply reaches a pane through
// the same keystrokes a person's message does, and a pane is a real terminal: a
// CSI sequence in that text is interpreted, not displayed.
const ESCAPE_SEQUENCE_RE = /\x1b(?:[P_^\]X][\s\S]*?(?:\x1b\\|\x07|$)|\[[0-?]*[ -/]*[@-~]|[ -/]*[0-~]|$)/g;

function stripEscapes(value) {
  return String(value == null ? '' : value).replace(ESCAPE_SEQUENCE_RE, '');
}

// Folding is how a lookalike is *detected*, never what gets stored. Storing the
// folded form would quietly rewrite legitimate text — the ligature in a filename,
// the unit in a measurement, half-width katakana someone actually typed — and a
// note is quoted back to the session that wrote it. So every character is judged
// on its own folded form and either kept exactly as written or replaced with a
// plain space.
function scrub(value) {
  const text = stripEscapes(value);
  let out = '';
  for (const character of text) {
    let folded = character;
    try { folded = character.normalize('NFKC'); } catch {}
    out += offends(character) || offends(folded) ? ' ' : character;
  }
  return out
    .replace(/<<<|>>>/g, '---')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitize(value, limit = MESSAGE_LIMIT) {
  return scrub(value).slice(0, limit);
}

// `scrub` for text that is going to be typed into a terminal rather than stored
// as a note. Same threat — controls, escape sequences, bidi overrides, invisible
// format characters, forged fence markers — but it is deliberately NOT a
// whitespace normalizer: a note is prose Keep rewrote once, while this is a
// rendered table whose columns are runs of spaces, and a caller that lines events
// up in columns must not have them collapsed out from under it. `a  b` survives
// as `a  b`.
//
// Newlines survive too, because a fenced block's line breaks are its structure.
// Every other C0/C1 control is removed rather than replaced, a tab becomes a
// single space, and a CR (alone or in a CRLF) becomes a newline — a bare CR
// would otherwise let somebody overwrite the line a reader has already seen.
const SCRUB_KEEP_SPACES_RE = /[\p{Cf}\p{Zl}\p{Zp}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

function scrubControls(value) {
  return stripEscapes(value)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(SCRUB_KEEP_SPACES_RE, '')
    .replace(/<<<|>>>/g, '---');
}

// The same thing for a field that has to stay on one line. The newlines go — a
// field that forged a line break would forge a row in the caller's table — and
// nothing else about the spacing changes.
function scrubControlsOneLine(value) {
  return scrubControls(value).replace(/\n+/g, ' ');
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

// The registry lock, the same one cards are written under. Every writer below
// is a read-modify-write of a whole file, and the daemon's expiry sweep runs on
// a clock that does not care what a CLI is in the middle of: without this, a nag
// mark and a new note on the same project lose each other. Falls back to running
// uncontended if keep.js cannot be loaded, so this module stays usable alone.
function withRegistryLock(fn) {
  let keep = null;
  try { keep = require('./keep.js'); } catch {}
  return keep && typeof keep.withLock === 'function' ? keep.withLock(fn) : fn();
}

// Read-modify-write on one project's file, under the registry lock.
function updateNote(id, root, mutate) {
  return withRegistryLock(() => {
    const found = findNote(id, root);
    if (!found) return null;
    const notes = readFileNotes(found.file);
    const note = notes.find((candidate) => candidate.id === id);
    if (!note) return null;
    const result = mutate(note);
    if (result === false) return note;
    writeFileNotes(found.file, found.project || note.project, notes);
    return note;
  });
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
  return withRegistryLock(() => {
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
    nagAttempts: 0,
  };
  notes.push(note);
  writeFileNotes(file, project, notes, now);
  return note;
  });
}

function extendNote(id, until, { root, now = Date.now() } = {}) {
  return updateNote(id, root, (note) => {
    if (note.cleared) return false;
    note.extended = [...(note.extended || []), { at: stampOf(new Date(now)), until }];
    note.until = until;
    // A fresh window deserves a fresh nag: the note is being asserted again, so
    // the author owes an answer at the new expiry too. Documented, because it is
    // the one place a note's nag state is deliberately rewound.
    note.nagged = null;
    note.nagAttempts = 0;
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
// `null` (or a missing argument) means every project — the brief asks for that.
// An empty string means *no* project, and returns nothing: a caller that failed
// to resolve a project must not silently get the whole fleet's notes.
function activeNotes(project, now = Date.now(), options = {}) {
  const root = options.root;
  const scopes = options.scope ? (Array.isArray(options.scope) ? options.scope : [options.scope]) : [];
  const everywhere = project === null || project === undefined;
  if (!everywhere && !String(project).trim()) return { active: [], expired: [] };
  const rows = everywhere ? allNotes(root) : loadNotes(project, root);
  const wanted = everywhere ? '' : normalizeProject(project);
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
  return sessionRef((note.by && note.by.sessionId));
}

function describeNote(note) {
  const by = note.by || {};
  const sid = shortSession(note);
  return `[${(note.scopes || []).join(', ') || 'unscoped'}] ${note.message}`
    + ` — ${by.agent || 'manual'}${sid ? ` ${sid}` : ''}, until ${String(note.until).slice(11, 16) || note.until}`;
}

// ---------- the broadcast ----------

const ANNOUNCE_PREFIX = '[keep] ';

// What a note's own state says happened to it, rather than what a caller claims.
// The announce endpoint is reachable by anything that can talk to the daemon, and
// a caller-supplied event let a `create` be replayed as a `clear` — a message
// telling every sibling session that a constraint had been lifted when it had
// not. Derived here, from the note, or not at all.
function announceEventFor(note) {
  if (!note) return null;
  if (note.cleared) return 'clear';
  return (note.extended || []).length ? 'extend' : 'create';
}

// One announcement per event. `extend` is counted rather than flagged, because a
// note extended twice has two things to say and the second is not a replay.
function announcedAlready(note, event) {
  const marks = (note && note.announcedAt) || {};
  if (event === 'clear') return Boolean(marks.clear);
  if (event === 'extend') return Number(marks.extendCount || 0) >= ((note.extended || []).length);
  return Boolean(marks.create);
}

function markAnnounced(id, event, at, root) {
  return updateNote(id, root, (note) => {
    const marks = { ...(note.announcedAt || {}) };
    marks[event] = at;
    if (event === 'extend') marks.extendCount = (note.extended || []).length;
    note.announcedAt = marks;
  });
}

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

// The author is there but cannot take a message right now. That is a reason to
// come back in a minute, not a reason to give the note to Owner forever — but a
// session that stays busy for six sweeps is not going to answer either.
function deferNag(id, root, now, reason) {
  return updateNote(id, root, (note) => {
    if (note.nagged) return false;
    const attempts = Number(note.nagAttempts || 0) + 1;
    note.nagAttempts = attempts;
    note.lastNagAttempt = { at: now, reason };
    if (attempts >= NAG_ATTEMPT_LIMIT) {
      note.nagged = { at: now, owner: true, reason: `${reason}, after ${attempts} attempts` };
    }
  });
}

// One nag per note, ever. A note whose author has gone is marked `owner` at once
// and left to the brief and to lint; nothing chases a session that is not there.
async function sweep(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const root = options.root;
  const due = dueForNag(now, root);
  if (!due.length) return { changed: 0, nagged: 0, owner: 0, deferred: 0 };
  const live = require('./watcher-live.js');
  let sessions = [];
  try { sessions = (options.sessions ? options.sessions() : []) || []; } catch {}
  let nagged = 0;
  let owner = 0;
  let deferred = 0;
  for (const note of due) {
    const sessionId = (note.by && note.by.sessionId) || '';
    const session = sessionId ? sessions.find((candidate) => candidate && candidate.id === sessionId) : null;
    const gone = !session || session.exited === true || session.state === 'exited';
    if (gone || typeof options.send !== 'function') {
      markNagged(note.id, { at: now, owner: true, reason: session ? 'the session has exited' : 'no live session' }, root);
      owner += 1;
      continue;
    }
    // Reviewer, mid-turn, question on screen, tool running: all transient.
    const notReady = live.sessionReady(session);
    if (notReady) {
      const updated = deferNag(note.id, root, now, notReady);
      if (updated && updated.nagged) owner += 1;
      else deferred += 1;
      continue;
    }
    try {
      await options.send(sessionId, nagFor(note));
      markNagged(note.id, { at: now, sessionId }, root);
      nagged += 1;
    } catch (error) {
      // A terminal that could not take the message is not a note to give up on;
      // leave it unnagged so the next sweep tries once more.
      deferNag(note.id, root, now, `delivery failed: ${error.message}`);
      deferred += 1;
      if (process.env.KEEP_DEBUG) process.stderr.write(`keep notes: nag failed: ${error.message}\n`);
    }
  }
  return { changed: nagged + owner, nagged, owner, deferred };
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
  defaultRoot, notesDir, noteFile, projectKey, scrub, sanitize, stripEscapes,
  scrubControls, scrubControlsOneLine, stampOf,
  loadNotes, allNotes, findNote, addNote, extendNote, clearNote, writeFileNotes,
  activeNotes, describeNote, announcementFor, nagFor,
  announceEventFor, announcedAlready, markAnnounced,
  dueForNag, markNagged, deferNag, sweep, startScheduler, NAG_ATTEMPT_LIMIT,
};
