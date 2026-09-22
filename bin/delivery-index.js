'use strict';
// The turn index as a second witness that a delivered message arrived.
//
// `received()` in delivery.js reads one transcript file from one byte offset. When
// that file is not where the message landed - a resumed session writing a new
// rollout, a transcript path resolved wrongly at send time - the receipt never
// appears, and on 2026-09-17 a `keep tell` into a Codex session was reported
// unconfirmed while the message sat in that session's transcript all along. The turn
// index keys messages by session id rather than by file, so it can see the message
// wherever the agent recorded it.
//
// What it can confirm: a user message the agent's own transcript recorded. What it
// cannot: text still sitting in an input box (no transcript line exists yet), a
// Claude message absorbed into a running turn from the queue (no user record), or a
// slash command (indexed as `command`, not compared here). It lags a live session by
// up to one hook or one 30 s daemon tick, so callers ask it once as a last check, not
// in a poll loop.
//
// Loaded lazily by delivery.js, and node:sqlite is loaded only inside a lookup, so a
// CLI that never reaches this path pays nothing for it.
const fs = require('node:fs');

// A delivery must never wait on the index for longer than this. Readers on a WAL
// database are rarely blocked, but a checkpoint or a migration can hold the lock.
const BUSY_TIMEOUT_MS = 250;
// How far before the journal's createdAt a matching row may be. The journal is
// written before the first key is typed, and the agent writes its transcript line
// after Enter, on the same machine and clock, so a row for this attempt is never
// earlier than createdAt except by timestamp granularity (transcripts carry
// milliseconds; a turn's started_at may round). Anything wider is a false-positive
// window: a repeated identical message - a watcher "continue", a retried tell -
// recorded just before this attempt would confirm it, and a confirmed delivery that
// was really lost is worse than an unconfirmed one. Two seconds covers granularity
// and nothing else.
const WINDOW_SLACK_MS = 2e3;

const turnIndex = () => require('./turn-index.js');
const textCap = () => turnIndex().TEXT_CAP;

// The index stores `text.trim()` cut at TEXT_CAP characters. For a message longer
// than that the journal cannot compare its whole-text hash with the stored row, so it
// records the hash of the part the index keeps. Null for a message that fits.
function prefixHash(text, hash) {
  const trimmed = String(text || '').trim();
  const cap = textCap();
  return trimmed.length > cap ? hash(trimmed.slice(0, cap)) : null;
}

// `entry` is a delivery journal entry: { sessionId, hash, createdAt, indexPrefixHash? }.
// `text` is the sent text when the caller still has it (the send path does; reconcile
// and inspect do not - the journal stores only hashes).
//
// Matching rule, per candidate row (same session, role user, kind human or keep,
// turn started at or after createdAt - 60 s):
//   1. hash(row.text) === entry.hash. `hash` is delivery.js's, which normalises NFC
//      and collapses whitespace exactly as the transcript receipt does, so the
//      index's trim and its '\n\n' block join compare equal to userText's '\n'.
//   2. Only when the row was cut at TEXT_CAP (its length reached the cap): with the
//      sent text, the row's normalised text is a strict prefix of the sent text's;
//      without it, hash(row.text) equals the journal's indexPrefixHash.
function lookup(entry, { text, hash, normalize, db, trace = () => {}, busyTimeoutMs = BUSY_TIMEOUT_MS } = {}) {
  if (!entry || typeof entry.sessionId !== 'string' || !entry.sessionId || !/^[a-f0-9]{64}$/.test(String(entry.hash || ''))) return null;
  const createdAt = Number(entry.createdAt);
  // Without a send time there is no window, and an old identical message would do.
  if (!(Number.isFinite(createdAt) && createdAt > 0)) return null;
  let file;
  try { file = db || turnIndex().databaseFile(); } catch { trace('index-unavailable'); return null; }
  // Never create the database from here: turn-index's own open() makes the
  // directory and runs migrations, which is a write the delivery path must not do.
  if (!fs.existsSync(file)) { trace('index-missing'); return null; }
  let handle;
  try {
    const { DatabaseSync } = require('node:sqlite');
    handle = new DatabaseSync(file, { readOnly: true });
    handle.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    const rows = handle.prepare(`SELECT m.seq, m.text, COALESCE(t.started_at, m.ts) AS started_at
        FROM messages m LEFT JOIN turns t ON t.id = m.turn_id
       WHERE m.session_id = ? AND m.role = 'user' AND m.kind IN ('human', 'keep')
         AND COALESCE(t.started_at, m.ts) >= ?
       ORDER BY m.seq LIMIT 500`).all(entry.sessionId, createdAt - WINDOW_SLACK_MS);
    const cap = textCap();
    const sent = typeof text === 'string' ? normalize(text) : null;
    for (const row of rows) {
      const stored = typeof row.text === 'string' ? row.text : '';
      if (!stored) continue;
      let match = hash(stored) === entry.hash;
      if (!match && stored.length >= cap) {
        if (sent !== null) {
          const head = normalize(stored);
          match = head.length > 0 && sent.length > head.length && sent.startsWith(head);
        } else if (entry.indexPrefixHash) {
          match = hash(stored) === entry.indexPrefixHash;
        }
      }
      if (match) return { confirmed: true, source: 'turn-index', seq: Number(row.seq), startedAt: Number(row.started_at) };
    }
    return null;
  } catch (error) {
    // Busy, an old schema, a corrupt file: the index is a second witness, and its
    // absence only means the first witness stands alone, as it did before.
    trace(/SQLITE_BUSY|database is locked/i.test(String(error && error.message)) ? 'index-busy' : 'index-error');
    return null;
  } finally {
    try { handle && handle.close(); } catch {}
  }
}

module.exports = { lookup, prefixHash, BUSY_TIMEOUT_MS, WINDOW_SLACK_MS };
