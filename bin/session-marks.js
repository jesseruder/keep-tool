'use strict';

// Marks Owner puts on a session by hand: a color, an emoji, or both. A mark is
// pure decoration for finding a session again — it is independent of the
// session's name and of the AI title, nothing ever assigns one automatically,
// and it never changes what the title generator does.
//
// The storage copies bin/session-names.js exactly: one file per marked session
// under `<root>/.keep/session-marks/`, named `<id>.json`. Two writers exist — the
// daemon's `/api/mark-session` route, and `keep mark` writing the file itself
// while the daemon is down — and one file per session is what keeps them out of
// each other's way: a mark replaces (or unlinks) one session's file and never
// rewrites anybody else's entry, so no lock is needed and a crashed writer cannot
// wedge every later mark. A session id is checked against the same pattern the
// route and the CLI check, so it can only ever name a file inside that directory.

const fs = require('fs');
const path = require('path');

// The console hardcodes these same eight names in this same order; a new color
// belongs at the end of both lists.
const PALETTE = Object.freeze(['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink']);
const ID = /^[A-Za-z0-9_-]+$/;
// One emoji can be a long cluster (a four-person family is 11 code units), but
// nothing legitimate is longer than this, and the cap keeps a pathological
// cluster out of every console row before the segmenter ever runs.
const MAX_EMOJI_UNITS = 16;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function directory(root) { return path.join(root, '.keep', 'session-marks'); }

function markFile(root, sessionId) {
  const id = String(sessionId == null ? '' : sessionId);
  if (!ID.test(id)) throw new Error('bad session id');
  return path.join(directory(root), `${id}.json`);
}

// A palette name or null. Owner types this, so case and stray spaces are his
// shell's business, not a refusal; anything that is not one of the eight is.
function normalizeColor(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().toLowerCase();
  return PALETTE.includes(name) ? name : null;
}

// Exactly one emoji, kept as typed — the variation selector in `❤️` and the skin
// tone in `👍🏽` are part of what Owner chose, so nothing is stripped. Anything
// that is not a single emoji cluster (a letter, a digit, punctuation, two emoji,
// a word) is null, because a console row has room for one glyph.
function normalizeEmoji(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > MAX_EMOJI_UNITS) return null;
  let clusters = 0;
  for (const _ of graphemes.segment(text)) {
    clusters += 1;
    if (clusters > 1) return null;
  }
  if (clusters !== 1) return null;
  for (const codePoint of text) {
    if (/\p{Extended_Pictographic}/u.test(codePoint) || /\p{Emoji_Presentation}/u.test(codePoint)) return text;
  }
  return null;
}

// The mark a file holds, re-normalized, or null for anything unreadable, corrupt
// or empty: a color this build no longer knows and an emoji that is not one are
// dropped the way a missing field is, and a file left with neither is no mark at
// all. A bad file is one missing mark, never a thrown scan.
function readEntry(file) {
  let value = null;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const color = normalizeColor(value.color);
  const emoji = normalizeEmoji(value.emoji);
  if (!color && !emoji) return null;
  return {
    ...(color ? { color } : {}),
    ...(emoji ? { emoji } : {}),
    at: Number.isFinite(value.at) ? value.at : 0,
  };
}

function markOf(entry) {
  if (!entry) return null;
  const { at: _at, ...mark } = entry;
  return mark;
}

// Session ids are route input, so the map has no prototype: `constructor` or
// `__proto__` must be an absent key, not an inherited value.
function read(options = {}) {
  const marks = Object.create(null);
  let entries = [];
  try { entries = fs.readdirSync(directory(options.root)); } catch { return { version: 1, marks }; }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -'.json'.length);
    if (!ID.test(id)) continue;
    const value = readEntry(path.join(directory(options.root), entry));
    if (value) marks[id] = value;
  }
  return { version: 1, marks };
}

function lookup(sessionId, options = {}) {
  let file = null;
  try { file = markFile(options.root, sessionId); } catch { return null; }
  return markOf(readEntry(file));
}

// `patch` is `{ color?, emoji? }`, where each field is an instruction rather than
// a value: absent leaves that half of the mark alone, null or '' removes it, and
// a string sets it (an unusable one throws, so the CLI and the route can both say
// what was wrong instead of silently dropping it). A mark with neither half left
// deletes the file — that is how Owner unmarks a session.
function set(sessionId, patch, options = {}) {
  const file = markFile(options.root, sessionId);
  const id = path.basename(file, '.json');
  const request = patch && typeof patch === 'object' ? patch : {};
  const current = markOf(readEntry(file)) || {};

  let color = current.color || null;
  if (request.color !== undefined) {
    if (request.color === null || request.color === '') color = null;
    else {
      color = normalizeColor(request.color);
      if (!color) throw new Error('bad color');
    }
  }
  let emoji = current.emoji || null;
  if (request.emoji !== undefined) {
    if (request.emoji === null || request.emoji === '') emoji = null;
    else {
      emoji = normalizeEmoji(request.emoji);
      if (!emoji) throw new Error('bad emoji');
    }
  }

  if (!color && !emoji) {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { sessionId: id, mark: null };
  }

  const mark = { ...(color ? { color } : {}), ...(emoji ? { emoji } : {}) };
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ ...mark, at: Date.now() }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
  return { sessionId: id, mark };
}

// Stamps every marked session with its mark, and removes the field from a row
// that carries one it no longer has — a row served from a cache filled while the
// session was marked must not keep showing it. Never throws: a scan that cannot
// read the registry is still a usable scan.
function apply(sessions, options = {}) {
  const rows = Array.isArray(sessions) ? sessions : [];
  if (!options.root || !rows.length) return rows;
  try {
    const { marks } = read(options);
    for (const session of rows) {
      if (!session || typeof session !== 'object') continue;
      const mark = markOf(typeof session.id === 'string' ? marks[session.id] : null);
      if (mark) session.mark = mark;
      else if (session.mark !== undefined) delete session.mark;
    }
  } catch {}
  return rows;
}

module.exports = {
  apply, lookup, read, set, normalizeColor, normalizeEmoji, directory, markFile, PALETTE, MAX_EMOJI_UNITS,
};
