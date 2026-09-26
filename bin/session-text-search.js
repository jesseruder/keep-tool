'use strict';
// ⌘F in the console searches what was said, not only session titles. The turn
// index (turn-index.js) already keeps an FTS5 table over every message; this asks
// it for the newest matches and returns one hit per session.
//
// Measured on a 780 MB index (362k messages) on 2026-09-25: ordering by the FTS
// rowid, which is ingestion order, answers a common word in ~15 ms, where ORDER BY
// ts took 40 s for "the". A one- or two-letter prefix still costs over a second,
// so only a last word of three or more letters is matched as a prefix.
//
// The query runs in a worker thread: the UI worker that serves it also streams
// every terminal, and node:sqlite is synchronous.
const path = require('node:path');
const { mentionIndex } = require('../web/app/shared/session-mentions.js');

const MIN_QUERY = 3;
const MIN_PREFIX = 3;
const MAX_WORDS = 8;
const HIT_LIMIT = 300;
const SESSION_LIMIT = 20;
const BUSY_TIMEOUT_MS = 250;
const TIMEOUT_MS = 3000;
// Snippet delimiters the console splits on; control characters never appear in
// the indexed text's words, so they cannot collide with what was said.
const OPEN = '\u0002';
const CLOSE = '\u0003';

// Every word is quoted so FTS5 reads `home-only` or `NOT` as text, and all must
// match. A last word still being typed also matches longer words.
function ftsMatch(query) {
  // A NUL or other control character ends an FTS5 string early; none belongs in a query.
  const text = String(query || '').slice(0, 200).replace(/[\u0000-\u001f\u007f]/g, ' ');
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  if (text.trim().length < MIN_QUERY || !words.length) return null;
  const typing = !/\s$/.test(text);
  return words.map((word, index) => {
    const quoted = `"${word.replace(/"/g, '""')}"`;
    return typing && index === words.length - 1 && word.length >= MIN_PREFIX ? `${quoted}*` : quoted;
  }).join(' ');
}

// By default only what a person typed and the agents' prose, in interactive
// sessions: tool calls and their output are four fifths of the index and would bury
// every conversation in build logs. `all` searches every message of every session.
//
// `sessions`, when given, names the only sessions to search: the console's finder
// passes the ones it can list. The index keeps 120 days of every session, the
// reviewer and standing agents included, and without the list they write enough
// prose to fill the caps with rows the finder would throw away. `since`, `project`
// and `agent` narrow the search as `keep turns search` names them.
function searchDatabase(handle, query, options = {}) {
  const match = ftsMatch(query);
  if (!match) return [];
  if (Array.isArray(options.sessions) && !options.sessions.length) return [];
  const sessionLimit = options.sessionLimit || SESSION_LIMIT;
  const bySession = new Map();
  collect(bySession, queryHits(handle, LIVE, match, options, sessionLimit), sessionLimit, false);
  // Sessions the prune has taken leave their words in the archive (turn-index.js
  // migration 15); they are older than anything live, so they only fill what is left.
  if (bySession.size < sessionLimit && hasArchive(handle)) {
    collect(bySession, queryHits(handle, ARCHIVE, match, options, sessionLimit), sessionLimit, true);
  }
  return [...bySession.values()];
}

// Who wrote a session's `#n`: the sessions whose typed messages or prose name it,
// newest first, the session itself left out. FTS5 splits `#453` into the token
// `453`, which also matches "453 ms", so every row the token finds is checked for
// the literal `#453` standing alone before it counts.
function searchMentions(handle, num, options = {}) {
  const number = Number(num);
  if (!Number.isInteger(number) || number < 1) return [];
  const sessionLimit = options.sessionLimit || MENTION_LIMIT;
  const pageSize = options.pageSize || MENTION_PAGE;
  const bySession = new Map();
  for (const source of hasArchive(handle) ? [LIVE, ARCHIVE] : [LIVE]) {
    const query = handle.prepare(`SELECT ${source.fts}.rowid AS rowid, m.session_id AS sessionId, m.ts, m.role, m.kind, m.text,
        ${source.title} AS title, s.card_id AS card, s.project, s.agent
      FROM ${source.fts}
      JOIN ${source.messages} m ON m.id = ${source.fts}.rowid
      JOIN ${source.sessions} s ON s.id = m.session_id
      WHERE ${source.fts} MATCH ? AND ${source.fts}.rowid < ? AND instr(m.text, ?) > 0 AND m.session_id <> ?
        ${source.archive ? '' : "AND m.kind IN ('human', 'text') AND s.kind = 'interactive'"}
      ORDER BY ${source.fts}.rowid DESC LIMIT ?`);
    // Pages newest first until enough sessions, the rows run out, or MENTION_SCAN
    // rows are read: near-misses (`repo#7`, `PR #7`) pass the literal check but not
    // the mention rule, and must not use up the budget real mentions need.
    let cursor = Number.MAX_SAFE_INTEGER;
    let scanned = 0;
    let rows;
    do {
      rows = query.all(`"${number}"`, cursor, `#${number}`, String(options.exclude || ''), pageSize);
      scanned += rows.length;
      if (rows.length) cursor = rows[rows.length - 1].rowid;
      for (const row of rows) {
        const text = String(row.text || '');
        const at = mentionIndex(text, number);
        if (at < 0) continue;
        const hit = bySession.get(row.sessionId);
        if (hit) { hit.hits += 1; continue; }
        if (bySession.size >= sessionLimit) continue;
        const from = Math.max(0, at - 60);
        bySession.set(row.sessionId, {
          sessionId: row.sessionId, ts: row.ts, role: row.role, kind: row.kind, hits: 1,
          title: row.title || '', card: row.card || '', project: row.project || '', agent: row.agent || '',
          snippet: `${from ? '…' : ''}${text.slice(from, at + 100).replace(/\s+/g, ' ').trim()}${at + 100 < text.length ? '…' : ''}`,
          ...(source.archive ? { archived: true } : {}),
        });
      }
    } while (rows.length === pageSize && bySession.size < sessionLimit && scanned < MENTION_SCAN);
    if (bySession.size >= sessionLimit) break;
  }
  return [...bySession.values()];
}
const MENTION_LIMIT = 8;
const MENTION_PAGE = 400;
const MENTION_SCAN = 4000;

const LIVE = { fts: 'messages_fts', messages: 'messages', sessions: 'sessions', title: 's.title', archive: false };
const ARCHIVE = { fts: 'archive_fts', messages: 'archive_messages', sessions: 'archive_sessions', title: "''", archive: true };

function queryHits(handle, source, match, options, sessionLimit) {
  const where = [`${source.fts} MATCH ?`];
  const params = [match];
  // The archive holds only typed messages and prose from interactive sessions.
  if (!options.all && !source.archive) where.push("m.kind IN ('human', 'text')", "s.kind = 'interactive'");
  if (Array.isArray(options.sessions)) {
    where.push('m.session_id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(options.sessions.map(String)));
  }
  if (Number.isFinite(options.since)) { where.push('m.ts >= ?'); params.push(options.since); }
  if (options.project) { where.push('s.project = ?'); params.push(String(options.project)); }
  if (options.agent) { where.push('s.agent = ?'); params.push(String(options.agent)); }
  params.push(options.hitLimit || Math.max(HIT_LIMIT, sessionLimit * 15));
  return handle.prepare(`SELECT m.session_id AS sessionId, m.ts, m.role, m.kind,
      ${source.title} AS title, s.card_id AS card, s.project, s.agent,
      snippet(${source.fts}, 0, char(2), char(3), '…', 14) AS snippet
    FROM ${source.fts}
    JOIN ${source.messages} m ON m.id = ${source.fts}.rowid
    JOIN ${source.sessions} s ON s.id = m.session_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${source.fts}.rowid DESC LIMIT ?`).all(...params);
}

function collect(bySession, rows, sessionLimit, archived) {
  const fresh = new Set();
  for (const row of rows) {
    const hit = bySession.get(row.sessionId);
    // A session resumed after its prune has live rows and archived ones; the live
    // hit stands, and the archive's copies of the same words are not counted again.
    if (hit) { if (!archived || fresh.has(row.sessionId)) hit.hits += 1; continue; }
    if (bySession.size >= sessionLimit) continue;
    if (archived) fresh.add(row.sessionId);
    bySession.set(row.sessionId, {
      sessionId: row.sessionId, ts: row.ts, role: row.role, kind: row.kind, hits: 1,
      title: row.title || '', card: row.card || '', project: row.project || '', agent: row.agent || '',
      snippet: String(row.snippet || '').replace(/\s+/g, ' ').trim(),
      ...(archived ? { archived: true } : {}),
    });
  }
}

// A database no newer Keep has opened yet has no archive; a read-only handle cannot
// create one, so search simply does without it.
// Only a yes is remembered: the daemon may migrate while a reader holds its handle.
const archiveKnown = new WeakSet();
function hasArchive(handle) {
  if (archiveKnown.has(handle)) return true;
  if (!handle.prepare("SELECT 1 AS found FROM sqlite_master WHERE name = 'archive_fts'").get()) return false;
  archiveKnown.add(handle);
  return true;
}

// One long-lived worker holding one read-only handle. A newer query supersedes any
// that has not started, and a query that overruns its deadline takes the worker
// down with it; the next search starts a fresh one.
function createSessionTextSearch(options = {}) {
  const { Worker } = require('node:worker_threads');
  const WorkerClass = options.Worker || Worker;
  const workerFile = options.workerFile || path.join(__dirname, 'session-text-search-worker.js');
  const timeoutMs = options.timeoutMs || TIMEOUT_MS;
  let worker = null;
  let running = null;
  let queued = null;
  let sequence = 0;

  const stop = () => {
    const current = worker;
    worker = null;
    if (current) current.terminate().catch(() => {});
  };
  const settle = (job, error, value) => {
    clearTimeout(job.timer);
    if (error) job.reject(error); else job.resolve(value);
  };
  const failRunning = (error) => {
    const job = running;
    running = null;
    stop();
    if (job) settle(job, error);
    next();
  };
  const ensure = () => {
    if (worker) return worker;
    worker = new WorkerClass(workerFile, { workerData: { db: options.db || null } });
    worker.unref?.();
    const current = worker;
    current.on('message', (message) => {
      if (current !== worker || !running || message?.id !== running.id) return;
      const job = running;
      running = null;
      if (message.error) settle(job, new Error(message.error));
      else settle(job, null, message.results || []);
      next();
    });
    current.on('error', (error) => { if (current === worker) failRunning(error); });
    current.on('exit', () => { if (current === worker) failRunning(new Error('session search worker exited')); });
    return worker;
  };
  const next = () => {
    if (running || !queued) return;
    running = queued;
    queued = null;
    running.timer = setTimeout(() => failRunning(Object.assign(new Error('session search timed out'), { status: 504 })), timeoutMs);
    ensure().postMessage({ id: running.id, query: running.query, sessions: running.sessions, mentions: running.mentions });
  };
  return {
    search(query, sessions = []) {
      if (!ftsMatch(query)) return Promise.resolve([]);
      return new Promise((resolve, reject) => {
        if (queued) settle(queued, null, null);
        queued = { id: ++sequence, query: String(query), sessions, resolve, reject };
        next();
      });
    },
    // The sessions that mention `#num`, `exclude` (its own id) left out. It shares
    // the queue, so give it an instance of its own beside the finder's.
    mentions(num, exclude = '') {
      if (!Number.isInteger(Number(num)) || Number(num) < 1) return Promise.resolve([]);
      return new Promise((resolve, reject) => {
        if (queued) settle(queued, null, null);
        queued = { id: ++sequence, mentions: { num: Number(num), exclude: String(exclude || '') }, resolve, reject };
        next();
      });
    },
    close() {
      if (queued) settle(queued, null, null);
      queued = null;
      if (running) settle(running, null, null);
      running = null;
      stop();
    },
  };
}

module.exports = { ftsMatch, searchDatabase, searchMentions, createSessionTextSearch, OPEN, CLOSE, BUSY_TIMEOUT_MS };
