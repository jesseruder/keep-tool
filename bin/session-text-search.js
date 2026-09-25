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

// Only what a person typed and the agents' prose: tool calls and their output are
// four fifths of the index and would bury every conversation in build logs.
// `exclude` names sessions the console never lists here (the reviewer and the
// standing agents): they write the most prose, and would otherwise fill the caps.
function searchDatabase(handle, query, options = {}) {
  const match = ftsMatch(query);
  if (!match) return [];
  const exclude = JSON.stringify(Array.isArray(options.exclude) ? options.exclude.map(String) : []);
  const rows = handle.prepare(`SELECT m.session_id AS sessionId, m.ts, m.role,
      snippet(messages_fts, 0, char(2), char(3), '…', 14) AS snippet
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
    JOIN sessions s ON s.id = m.session_id
    WHERE messages_fts MATCH ? AND m.kind IN ('human', 'text') AND s.kind = 'interactive'
      AND m.session_id NOT IN (SELECT value FROM json_each(?))
    ORDER BY messages_fts.rowid DESC LIMIT ?`).all(match, exclude, options.hitLimit || HIT_LIMIT);
  const bySession = new Map();
  for (const row of rows) {
    const hit = bySession.get(row.sessionId);
    if (hit) { hit.hits += 1; continue; }
    if (bySession.size >= (options.sessionLimit || SESSION_LIMIT)) continue;
    bySession.set(row.sessionId, {
      sessionId: row.sessionId, ts: row.ts, role: row.role, hits: 1,
      snippet: String(row.snippet || '').replace(/\s+/g, ' ').trim(),
    });
  }
  return [...bySession.values()];
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
    ensure().postMessage({ id: running.id, query: running.query, exclude: running.exclude });
  };
  return {
    search(query, exclude = []) {
      if (!ftsMatch(query)) return Promise.resolve([]);
      return new Promise((resolve, reject) => {
        if (queued) settle(queued, null, null);
        queued = { id: ++sequence, query: String(query), exclude, resolve, reject };
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

module.exports = { ftsMatch, searchDatabase, createSessionTextSearch, OPEN, CLOSE, BUSY_TIMEOUT_MS };
