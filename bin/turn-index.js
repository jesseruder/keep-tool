'use strict';
// A SQLite index of agent turns. One row per Claude Code / Codex CLI message and
// one per turn, so a week of fleet history can be searched and measured without
// re-reading gigabytes of JSONL every time.
//
// Ingestion is incremental: each transcript file keeps a byte offset, and only
// the bytes appended since the last pass are parsed. That is what makes the Stop
// hook affordable (a typical delta is a few KiB) and what lets the daemon sweep
// every live session on a 30s tick.
//
// node:sqlite is experimental in Node 22; bin/keep passes
// --disable-warning=ExperimentalWarning so hooks and the CLI stay quiet.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 11;

// Text caps. Transcripts contain whole files and 100k-line build logs; the index
// exists to find and count turns, not to be a second copy of the corpus.
const TEXT_CAP = 16 * 1024;
const TOOL_CAP = 2 * 1024;
const OPENER_CAP = 2 * 1024;
const LAST_ASSISTANT_CAP = 4 * 1024;
// The command column is what the release carve-out reads when a tool input was
// too long to keep as JSON, so it holds the command itself rather than a preview
// of one: a `&& git push` 600 characters in is exactly what a preview drops.
const COMMAND_CAP = 4096;

const CHUNK_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 32 * 1024 * 1024; // a line longer than this is abandoned
const DEFAULT_BACKFILL_DAYS = 14;
const MARKER_TTL_MS = 30e3;

// One pass never parses more than this, so no caller can be surprised by a
// multi-hundred-megabyte cold read. Whatever is left comes back as partial.
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const HEAD_FINGERPRINT_BYTES = 4096;
const JOURNAL_SIZE_LIMIT = 64 * 1024 * 1024;
const DEFAULT_PRUNE_DAYS = 120;

// A "nudge" is a turn Owner spent only to restart an agent that stopped early.
// This is the metric the turn watcher is meant to drive down.
const NUDGE_RE = /^(ok |yes |please )?(continue|keep going|go ahead|go on|proceed|anything else.*|anything left.*|what'?s next|check (now|again)|done)[.!?]*$/;

const CLAUDE_COMMAND_RE = /^<(?:command-name|command-message|command-args|local-command|bash-input|bash-stdout|bash-stderr)\b/;
const CLAUDE_WRAPPER_RE = /^<(?:system-reminder|task-notification|cross-session-message|user-prompt-submit-hook)\b/;
const CODEX_PREAMBLE_RE = /^(?:<(?:recommended_plugins|available_plugins|environment_context|user_instructions|permissions|collaboration_mode|turn_aborted|system-reminder|task-notification|cross-session-message)\b|# AGENTS\.md instructions)/;
// Codex delivers hook output as a user message: `<hook_prompt hook_run_id="stop:14:…">[keep] Your card …`.
// It is Keep talking to the agent, not Owner, so it must never read as a human
// turn — nor, later, as evidence of what Owner would have typed.
const HOOK_PROMPT_RE = /^<hook_prompt\b/i;
// Keep speaking to the agent, in any of its voices: `[keep]` from the hooks,
// `[keep watcher]` from live delivery, `[keep coordination]` and whatever comes
// next. This is load-bearing for the watcher's never-chain rule — an automated
// message that read as human would let the watcher answer itself forever — and
// for the nudge metric, which must only ever count what Owner typed.
const KEEP_OPENER_RE = /^\[keep(?:\s[\w-]+)?\]/;
// Keep's own headless runs (`keep runs`, the Slack classifier, tab naming, the
// brief) and Owner's `claude -p` batch jobs all open with a system-style "You are
// …" prompt; a person opening a conversation that way is rare enough to accept.
const HEADLESS_PROMPT_RE = /^(?:You are\b|You classify\b)/;
// `git commit` prints the new sha in brackets: `[wt/turn-index 1a2b3c4] message`.
const COMMIT_RE = /\[[^\]\s]+(?:\s+\(root-commit\))?\s+([0-9a-f]{7,40})\]/g;
const PATH_TOKEN_RE = /(?:^|[\s='"(])((?:~|\.{0,2})?\/?[\w.@+-]*\/[\w./@+-]*\.[A-Za-z0-9]{1,8})(?=$|[\s'")\];,:])/g;
const APPLY_PATCH_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit', 'NotebookRead']);
const SHELL_TOOLS = new Set(['Bash', 'BashOutput', 'shell', 'local_shell', 'container.exec', 'exec_command']);

let db = null;
let dbPath = null;
let busyTimeoutMs = null;
let markerCache = { at: 0, spawned: new Set(), reviewer: new Set() };
let liveCursor = 0;

// ---------- paths ----------

function registryRoot() {
  // Deliberately not `require('./keep.js').ROOT`: keep.js loads this module for
  // its hooks, and a top-level cycle between the two would be fragile.
  return process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
}

function databaseFile() {
  return process.env.KEEP_TURN_INDEX_DB || path.join(registryRoot(), '.keep', 'turns.sqlite');
}

function debug(message) {
  if (process.env.KEEP_DEBUG) process.stderr.write(`keep turn-index: ${message}\n`);
}

// ---------- schema ----------

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY, agent TEXT NOT NULL, kind TEXT NOT NULL, cwd TEXT,
     project TEXT, account_id TEXT, file TEXT, parent_id TEXT,
     started_at INTEGER, last_at INTEGER, title TEXT, card_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS messages (
     id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER,
     role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT, tool_name TEXT, tool_id TEXT,
     files TEXT, command TEXT, stop_reason TEXT, tokens_in INTEGER, tokens_out INTEGER,
     turn_id INTEGER, UNIQUE(session_id, seq))`,
  `CREATE TABLE IF NOT EXISTS turns (
     id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, n INTEGER NOT NULL,
     started_at INTEGER, ended_at INTEGER, opener_kind TEXT, opener_text TEXT,
     assistant_text TEXT, last_assistant TEXT, tool_count INTEGER NOT NULL DEFAULT 0,
     tools TEXT, files TEXT, commits TEXT, stop_reason TEXT, ended INTEGER NOT NULL DEFAULT 0,
     verdict TEXT, verdict_reason TEXT, state_line TEXT, verdict_at INTEGER,
     UNIQUE(session_id, n))`,
  `CREATE TABLE IF NOT EXISTS ingest_state (
     file TEXT PRIMARY KEY, session_id TEXT, "offset" INTEGER NOT NULL DEFAULT 0,
     size INTEGER, mtime INTEGER, seq INTEGER NOT NULL DEFAULT 0,
     open_turn INTEGER, updated_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS messages_session_seq ON messages(session_id, seq)`,
  `CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts)`,
  // Turn rows are recomputed from their own messages, so this one is load-bearing.
  `CREATE INDEX IF NOT EXISTS messages_turn ON messages(turn_id)`,
  `CREATE INDEX IF NOT EXISTS turns_session_n ON turns(session_id, n)`,
  `CREATE INDEX IF NOT EXISTS turns_started ON turns(started_at)`,
  `CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project)`,
  `CREATE INDEX IF NOT EXISTS sessions_last ON sessions(last_at)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
     text, content='messages', content_rowid='id', tokenize='unicode61')`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
     INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
   END`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
     INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
   END`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
     INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
     INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
   END`,
];

// Each entry brings the database from version n-1 to n and runs exactly once, so
// a fresh database is built by running all of them in order.
const MIGRATIONS = [
  { version: 1, statements: SCHEMA },
  // A file can be replaced in place without ever shrinking (a rewritten rollout,
  // a restored backup). A fingerprint of the head catches that; existing rows
  // simply acquire one on their next pass rather than being re-ingested.
  { version: 2, statements: ['ALTER TABLE ingest_state ADD COLUMN head_sha TEXT'] },
  // Looking a directory up among sessions already indexed is what keeps the
  // worktree-to-main-checkout git call from running once per hook process.
  { version: 3, statements: ['CREATE INDEX IF NOT EXISTS sessions_cwd ON sessions(cwd)'] },
  // What the turn watcher writes back (bin/turn-watcher.js). The verdict columns
  // themselves were reserved from version 1; these carry the message Owner would
  // have typed, how sure the model was, which model said so, and the shadow
  // decision it produced.
  { version: 4, statements: [
    'ALTER TABLE turns ADD COLUMN verdict_message TEXT',
    'ALTER TABLE turns ADD COLUMN verdict_confidence REAL',
    'ALTER TABLE turns ADD COLUMN verdict_model TEXT',
    'ALTER TABLE turns ADD COLUMN verdict_ms INTEGER',
    'ALTER TABLE turns ADD COLUMN decision_id TEXT',
    'ALTER TABLE turns ADD COLUMN card_id TEXT',
    'CREATE INDEX IF NOT EXISTS turns_verdict ON turns(ended, verdict_at)',
  ] },
  // The dashboard asks for the newest verdict of each of a handful of sessions
  // on every state build; without this it scans every judged turn they have.
  { version: 5, statements: ['CREATE INDEX IF NOT EXISTS turns_session_verdict ON turns(session_id, verdict_at)'] },
  { version: 6, statements: [
    // An atomic claim, so two judges cannot both spend a model call on one turn
    // and both write a decision (bin/turn-watcher.js).
    'ALTER TABLE turns ADD COLUMN judging_at INTEGER',
    // The newest verdict, denormalized onto the session. The dashboard asks for
    // it on every state build; ranking each session's verdict history to answer
    // that was work proportional to history rather than to what is displayed.
    'ALTER TABLE sessions ADD COLUMN state_line TEXT',
    'ALTER TABLE sessions ADD COLUMN last_verdict TEXT',
    'ALTER TABLE sessions ADD COLUMN last_verdict_at INTEGER',
    // One-time backfill of the above from the history that already exists.
    `UPDATE sessions SET
       state_line = (SELECT t.state_line FROM turns t WHERE t.session_id = sessions.id AND t.verdict IS NOT NULL
                     ORDER BY COALESCE(t.verdict_at, 0) DESC, t.n DESC LIMIT 1),
       last_verdict = (SELECT t.verdict FROM turns t WHERE t.session_id = sessions.id AND t.verdict IS NOT NULL
                       ORDER BY COALESCE(t.verdict_at, 0) DESC, t.n DESC LIMIT 1),
       last_verdict_at = (SELECT COALESCE(t.verdict_at, 0) FROM turns t WHERE t.session_id = sessions.id AND t.verdict IS NOT NULL
                          ORDER BY COALESCE(t.verdict_at, 0) DESC, t.n DESC LIMIT 1)
     WHERE EXISTS (SELECT 1 FROM turns t WHERE t.session_id = sessions.id AND t.verdict IS NOT NULL)`,
    // A forced re-ingest recreates turn rows, which would otherwise erase every
    // verdict and orphan its ledger decision. Verdicts wait here in between.
    `CREATE TABLE IF NOT EXISTS turn_verdicts_kept (
       session_id TEXT NOT NULL, n INTEGER NOT NULL, opener_text TEXT,
       verdict TEXT, verdict_reason TEXT, verdict_message TEXT, state_line TEXT,
       verdict_confidence REAL, verdict_model TEXT, verdict_ms INTEGER, verdict_at INTEGER,
       decision_id TEXT, card_id TEXT, kept_at INTEGER,
       PRIMARY KEY (session_id, n))`,
  ] },
  // A verdict judges what the session said and did, so the assistant side is
  // part of the turn's identity for the purpose of keeping one across a rebuild.
  { version: 7, statements: ['ALTER TABLE turn_verdicts_kept ADD COLUMN shape TEXT'] },
  // The console shows the verdict's confidence beside the state line, and the
  // dashboard read must stay one row per session.
  { version: 8, statements: [
    'ALTER TABLE sessions ADD COLUMN last_verdict_confidence REAL',
    `UPDATE sessions SET last_verdict_confidence = (
       SELECT t.verdict_confidence FROM turns t WHERE t.session_id = sessions.id AND t.verdict IS NOT NULL
       ORDER BY COALESCE(t.verdict_at, 0) DESC, t.n DESC LIMIT 1)
     WHERE last_verdict IS NOT NULL`,
  ] },
  // When a live verdict was actually delivered into the session
  // (bin/watcher-live.js). Also the "never twice for the same turn" guard and
  // the window both rate limits are counted over.
  { version: 9, statements: [
    'ALTER TABLE turns ADD COLUMN delivered_at INTEGER',
    'CREATE INDEX IF NOT EXISTS turns_delivered ON turns(delivered_at)',
  ] },
  // A delivery is reserved before it is sent, so two daemon workers racing at the
  // last slot cannot both decide there is room. turn_id is the primary key, which
  // is also the "never twice for the same turn" guard.
  { version: 10, statements: [
    `CREATE TABLE IF NOT EXISTS deliveries (
       turn_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, type TEXT,
       reserved_at INTEGER NOT NULL, sent_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS deliveries_session ON deliveries(session_id, reserved_at)',
    'CREATE INDEX IF NOT EXISTS deliveries_reserved ON deliveries(reserved_at)',
  ] },
  // Who holds a reservation. Only the attempt that took a row may give it back,
  // so an abort from a previous attempt cannot free the slot a live one is
  // sending under (bin/watcher-live.js).
  { version: 11, statements: ['ALTER TABLE deliveries ADD COLUMN token TEXT'] },
];

function migrate(handle) {
  const current = Number(handle.prepare('PRAGMA user_version').get().user_version || 0);
  if (current >= SCHEMA_VERSION) return;
  handle.exec('BEGIN IMMEDIATE');
  try {
    for (const step of MIGRATIONS) {
      if (step.version <= current) continue;
      for (const sql of step.statements) handle.exec(sql);
    }
    handle.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    handle.exec('COMMIT');
  } catch (error) {
    try { handle.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function open(file = databaseFile(), options = {}) {
  if (db && dbPath === file) {
    if (options.busyTimeoutMs != null) setBusyTimeout(db, options.busyTimeoutMs);
    return db;
  }
  if (db) close();
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = new DatabaseSync(file);
  try {
    handle.exec('PRAGMA journal_mode = WAL');
    handle.exec('PRAGMA synchronous = NORMAL');
    // Without a limit the WAL keeps whatever a backfill grew it to, forever.
    handle.exec(`PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT}`);
    busyTimeoutMs = null;
    // The caller's timeout has to be in force for migrate() too: schema creation
    // takes the write lock, and a hook racing another process's migration must
    // give up in its own quarter second rather than the five-second default.
    setBusyTimeout(handle, options.busyTimeoutMs == null ? DEFAULT_BUSY_TIMEOUT_MS : options.busyTimeoutMs);
    migrate(handle);
  } catch (error) {
    try { handle.close(); } catch {}
    busyTimeoutMs = null;
    throw error;
  }
  db = handle;
  dbPath = file;
  return db;
}

// A hook waits at most a quarter second for the lock; a backfill can afford five
// seconds. The pragma is per connection, so it is re-applied when it changes.
function setBusyTimeout(handle, ms) {
  const value = Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : DEFAULT_BUSY_TIMEOUT_MS;
  if (busyTimeoutMs === value) return;
  handle.exec(`PRAGMA busy_timeout = ${value}`);
  busyTimeoutMs = value;
}

function close() {
  if (!db) return;
  try { db.close(); } catch {}
  db = null;
  dbPath = null;
  busyTimeoutMs = null;
}

// Backfill runs millions of inserts; re-preparing each one dominates the cost.
const statementCache = new WeakMap();

function statement(handle, sql) {
  let cache = statementCache.get(handle);
  if (!cache) { cache = new Map(); statementCache.set(handle, cache); }
  let prepared = cache.get(sql);
  if (!prepared) { prepared = handle.prepare(sql); cache.set(sql, prepared); }
  return prepared;
}

function isBusy(error) {
  const text = String((error && error.message) || error);
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(text);
}

// ---------- small helpers ----------

function cap(value, limit) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  return text.length > limit ? text.slice(0, limit) : text;
}

function jsonArray(values) {
  const list = [...new Set(values.filter(Boolean))];
  return list.length ? JSON.stringify(list) : null;
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function tsOf(record) {
  const parsed = Date.parse(record && record.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

const projectMemo = new Map();

// Cards are filed under a repository's main checkout, so a worktree transcript
// must fold onto the same project string or per-project queries split in two.
function canonicalProject(cwd) {
  if (!cwd) return '';
  if (projectMemo.has(cwd)) return projectMemo.get(cwd);
  let canonical = cwd;
  try {
    const wt = require('./wt.js');
    if (wt.isLinkedWorktree(cwd)) canonical = wt.mainCheckout(cwd) || cwd;
  } catch {}
  const normalized = normalizeProject(canonical);
  projectMemo.set(cwd, normalized);
  return normalized;
}

function normalizeProject(value) {
  if (!value) return '';
  const expanded = String(value).replace(/^~(?=\/|$)/, os.homedir());
  const absolute = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(expanded);
  if (absolute === os.homedir()) return '~';
  return absolute.startsWith(os.homedir() + path.sep) ? `~${absolute.slice(os.homedir().length)}` : absolute;
}

// Keep writes a marker file per headless run and per reviewer session; those are
// the authority for those two kinds, since neither is visible in the transcript.
function markers() {
  const now = Date.now();
  if (now - markerCache.at < MARKER_TTL_MS) return markerCache;
  const read = (name) => {
    try { return new Set(fs.readdirSync(path.join(registryRoot(), '.keep', name))); } catch { return new Set(); }
  };
  markerCache = { at: now, spawned: read('spawned'), reviewer: read('reviewer') };
  return markerCache;
}

let accountRootsMemo = null;

function accountRoots() {
  if (accountRootsMemo) return accountRootsMemo;
  const roots = [];
  try {
    for (const entry of require('./accounts.js').projectRoots()) roots.push({ id: entry.accountId, dir: entry.root });
  } catch {}
  try {
    for (const entry of require('./codex.js').configuredRoots()) roots.push({ id: entry.accountId, dir: entry.configDir });
  } catch {}
  accountRootsMemo = roots;
  return roots;
}

function accountIdFor(file) {
  const resolved = path.resolve(file);
  for (const root of accountRoots()) {
    if (resolved === root.dir || resolved.startsWith(root.dir + path.sep)) return root.id;
  }
  return null;
}

function agentForFile(file) {
  const base = path.basename(file);
  if (base.startsWith('rollout-')) return 'codex';
  return path.resolve(file).split(path.sep).includes('.codex') ? 'codex' : 'claude';
}

// ---------- text and tool extraction ----------

function claudeText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text).join('\n\n');
}

function codexText(payload) {
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.message === 'string') return payload.message;
  const content = payload.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && typeof block.text === 'string'
      && ['input_text', 'output_text', 'text'].includes(block.type))
    .map((block) => block.text).join('\n\n');
}

function toolResultText(block) {
  const content = block && block.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('\n');
}

function shellCommand(input) {
  if (!input || typeof input !== 'object') return '';
  // `cmd` is what Codex's exec_command tool uses; `command` is the shell tool's.
  // A command the index does not record is a command the watcher's release
  // carve-out cannot see, so both spellings have to land here.
  const value = input.command !== undefined ? input.command : input.cmd;
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  // Codex's shell tool spells a command as ["bash", "-lc", "<script>"].
  const script = value.length > 2 && /^(?:ba)?sh$/.test(String(value[0])) ? value[value.length - 1] : value.join(' ');
  return String(script);
}

function filesFromCommand(command) {
  const found = [];
  for (const match of String(command).matchAll(PATH_TOKEN_RE)) {
    found.push(match[1]);
    if (found.length >= 10) break;
  }
  return found;
}

function filesFromTool(name, input, rawInput) {
  const files = [];
  if (input && typeof input === 'object') {
    for (const key of ['file_path', 'notebook_path', 'path', 'filePath']) {
      if (typeof input[key] === 'string' && input[key]) files.push(input[key]);
    }
    if (Array.isArray(input.file_paths)) files.push(...input.file_paths.filter((value) => typeof value === 'string'));
  }
  if (name === 'apply_patch' || /apply_patch/.test(name)) {
    const patch = typeof rawInput === 'string' ? rawInput : (input && typeof input.input === 'string' ? input.input : '');
    for (const match of String(patch).matchAll(APPLY_PATCH_RE)) files.push(match[1].trim());
  }
  if (SHELL_TOOLS.has(name)) files.push(...filesFromCommand(shellCommand(input)));
  return files.slice(0, 20);
}

function parseToolInput(payload) {
  const raw = payload.arguments != null ? payload.arguments : payload.input;
  if (raw && typeof raw === 'object') return { input: raw, raw: JSON.stringify(raw) };
  if (typeof raw !== 'string') return { input: {}, raw: '' };
  try { return { input: JSON.parse(raw), raw }; } catch { return { input: {}, raw }; }
}

// ---------- user message classification ----------

function claudeUserKind(record, text) {
  if (record.isMeta) return 'meta';
  if (CLAUDE_COMMAND_RE.test(text)) return 'command';
  if (KEEP_OPENER_RE.test(text) || HOOK_PROMPT_RE.test(text)) return 'keep';
  if (CLAUDE_WRAPPER_RE.test(text)) return 'preamble';
  return 'human';
}

function codexUserKind(text) {
  if (CODEX_PREAMBLE_RE.test(text)) return 'preamble';
  if (KEEP_OPENER_RE.test(text) || HOOK_PROMPT_RE.test(text)) return 'keep';
  if (/^<(?:command-name|local-command|bash-input)\b/.test(text)) return 'command';
  return 'human';
}

function opensTurn(kind) {
  return kind === 'human' || kind === 'keep' || kind === 'command';
}

// ---------- incremental line reader ----------

// Reads whole lines from [from, to) and returns how many bytes of complete lines
// were consumed, so a partial trailing line is simply re-read next pass.
// maxBytes stops the read at the first chunk boundary past the budget; a single
// line longer than the budget still completes, because dropping a 5 MB tool
// result would lose a real record rather than defer it.
function readLines(file, from, to, maxBytes, onLine) {
  if (to <= from) return 0;
  const budget = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : Infinity;
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.alloc(CHUNK_BYTES);
  let leftover = Buffer.alloc(0);
  let consumed = 0;
  let position = from;
  try {
    while (position < to) {
      // Never read past the budget in one go, or the cap would only bite at chunk
      // granularity. consumed < budget here, so the read size stays positive and
      // an over-long line keeps getting fed until its newline arrives.
      const want = Math.min(CHUNK_BYTES, to - position, Math.max(budget - consumed, 1));
      const got = fs.readSync(fd, chunk, 0, want, position);
      if (!got) break;
      position += got;
      const buffer = leftover.length
        ? Buffer.concat([leftover, chunk.subarray(0, got)])
        : Buffer.from(chunk.subarray(0, got));
      let start = 0;
      let newline = buffer.indexOf(0x0a, start);
      while (newline !== -1) {
        consumed += newline + 1 - start;
        if (newline > start) onLine(buffer.subarray(start, newline).toString('utf8'));
        start = newline + 1;
        newline = buffer.indexOf(0x0a, start);
      }
      leftover = buffer.subarray(start);
      if (leftover.length > MAX_LINE_BYTES) { consumed += leftover.length; leftover = Buffer.alloc(0); }
      if (consumed >= budget) break; // consumed is 0 until a line completes, so progress is guaranteed
    }
  } finally {
    fs.closeSync(fd);
  }
  return consumed;
}

// ---------- ingest ----------

function loadIngestState(handle, file) {
  const row = statement(handle, 'SELECT * FROM ingest_state WHERE file = ?').get(file);
  return row || { file, session_id: null, offset: 0, size: 0, mtime: 0, seq: 0, open_turn: null, head_sha: null };
}

// Identity of the file's opening bytes. A transcript that is rewritten in place
// rather than appended to keeps its size but not its head.
//
// The covered length is stored with the digest, because a file smaller than the
// window grows its own head: without recording how many bytes were hashed, every
// append to a short transcript would look like a replacement.
function headFingerprint(file, bytes) {
  const length = Math.min(Number(bytes) || 0, HEAD_FINGERPRINT_BYTES);
  if (!length) return null;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  let got = 0;
  try { got = fs.readSync(fd, buffer, 0, length, 0); } finally { fs.closeSync(fd); }
  if (got < length) return null;
  return `${length}:${crypto.createHash('sha1').update(buffer).digest('hex')}`;
}

// True when the bytes the stored fingerprint covered are no longer those bytes.
function headReplaced(file, stat, stored) {
  if (!stored) return false;
  const length = Number(String(stored).split(':')[0]);
  if (!Number.isFinite(length) || length <= 0) return false;
  if (stat.size < length) return true;
  let current = null;
  try { current = headFingerprint(file, length); } catch {}
  return current !== stored;
}

const KEPT_VERDICT_COLUMNS = ['verdict', 'verdict_reason', 'verdict_message', 'state_line',
  'verdict_confidence', 'verdict_model', 'verdict_ms', 'verdict_at', 'decision_id', 'card_id'];

// Always scoped to one session id. A subagent file resetting must never reach
// into its parent's rows, which is exactly what a wrong id here would do.
//
// `keepVerdicts` is for a re-ingest, where the turns are about to be rebuilt
// from the same transcript: the watcher's verdicts (and the ledger decisions
// they point at) are parked so the rebuilt rows can take them back. Prune passes
// it false, because there the session is going for good.
function clearSession(handle, sessionId, { keepVerdicts = false } = {}) {
  if (!sessionId) return;
  if (keepVerdicts) parkVerdicts(handle, sessionId);
  statement(handle, 'DELETE FROM messages WHERE session_id = ?').run(sessionId);
  statement(handle, 'DELETE FROM turns WHERE session_id = ?').run(sessionId);
}

// The turn's identity for the purpose of keeping a verdict: what the session
// said and how much it did. A verdict is a judgment about that, so if either
// changes the judgment no longer applies.
// Everything the judge was shown about the turn, in one digest: if any of it
// changed, the parked verdict is a judgment about a turn that no longer exists.
// `tools`, `files` and `commits` matter as much as the prose — a turn that ran
// the same number of tools but different ones did different work.
const SHAPE_FIELDS = ['last_assistant', 'tool_count', 'tools', 'files', 'commits', 'stop_reason'];

function turnShape(turn) {
  const parts = SHAPE_FIELDS.map((field) => (turn && turn[field] == null ? '' : String(turn[field])));
  return crypto.createHash('sha1').update(parts.join(' ')).digest('hex');
}

function parkVerdicts(handle, sessionId) {
  const columns = KEPT_VERDICT_COLUMNS.join(', ');
  const rows = statement(handle,
    `SELECT n, opener_text, ${SHAPE_FIELDS.join(', ')}, ${columns} FROM turns
     WHERE session_id = ? AND verdict IS NOT NULL`).all(sessionId);
  const at = Date.now();
  for (const row of rows) {
    statement(handle, `INSERT OR REPLACE INTO turn_verdicts_kept
      (session_id, n, opener_text, shape, ${columns}, kept_at)
      VALUES (?, ?, ?, ?, ${KEPT_VERDICT_COLUMNS.map(() => '?').join(', ')}, ?)`).run(
      sessionId, row.n, row.opener_text, turnShape(row),
      ...KEPT_VERDICT_COLUMNS.map((column) => row[column]), at);
  }
}

// A parked verdict only comes back onto a turn with the same number, the same
// opener text AND the same shape (everything the judge was shown). Any of those
// changing means the turn is not the one that was judged, and a verdict about a
// turn that no longer exists is worse than no verdict.
//
// Only ever called on the final pass of a file: a capped re-ingest rebuilds the
// assistant side over several passes, so a mid-way turn has not finished being
// itself yet and would fail the comparison for the wrong reason.
function restoreVerdicts(handle, sessionId) {
  const rows = statement(handle, 'SELECT * FROM turn_verdicts_kept WHERE session_id = ?').all(sessionId);
  if (!rows.length) return 0;
  const assignments = KEPT_VERDICT_COLUMNS.map((column) => `${column} = ?`).join(', ');
  let restored = 0;
  for (const row of rows) {
    const turn = statement(handle,
      `SELECT id, opener_text, ${SHAPE_FIELDS.join(', ')} FROM turns WHERE session_id = ? AND n = ?`)
      .get(sessionId, row.n);
    if (!turn || turn.opener_text !== row.opener_text) continue;
    // A null shape is a verdict parked by a pre-v7 build; it cannot be compared,
    // so it is dropped rather than restored onto a turn that may have changed.
    if (!row.shape || turnShape(turn) !== row.shape) continue;
    statement(handle, `UPDATE turns SET ${assignments} WHERE id = ?`)
      .run(...KEPT_VERDICT_COLUMNS.map((column) => row[column]), turn.id);
    restored += 1;
  }
  return restored;
}

function dropParkedVerdicts(handle, sessionId) {
  statement(handle, 'DELETE FROM turn_verdicts_kept WHERE session_id = ?').run(sessionId);
}

function hasParkedVerdicts(handle, sessionId) {
  return Boolean(statement(handle, 'SELECT 1 AS hit FROM turn_verdicts_kept WHERE session_id = ? LIMIT 1').get(sessionId));
}

// The dashboard reads these three columns, so a dropped verdict must not leave
// them describing a turn that is no longer in the table.
function refreshSessionVerdictState(handle, sessionId) {
  const newest = statement(handle,
    `SELECT state_line, verdict, verdict_at, verdict_confidence FROM turns
     WHERE session_id = ? AND verdict IS NOT NULL
     ORDER BY COALESCE(verdict_at, 0) DESC, n DESC LIMIT 1`).get(sessionId);
  statement(handle, `UPDATE sessions SET state_line = ?, last_verdict = ?, last_verdict_at = ?,
      last_verdict_confidence = ? WHERE id = ?`)
    .run(newest ? newest.state_line : null, newest ? newest.verdict : null,
      newest ? newest.verdict_at : null, newest ? newest.verdict_confidence : null, sessionId);
}

function earliest(a, b) {
  const values = [a, b].filter((value) => Number.isFinite(value));
  return values.length ? Math.min(...values) : null;
}

function latest(a, b) {
  const values = [a, b].filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

// Folding a worktree onto its main checkout costs a git subprocess (~110 ms), and
// a hook is a fresh process every turn, so an in-process memo alone would pay it
// on every single Stop. The answer is the same for every session in a directory
// and never changes, so the index itself is the cache: the call happens once per
// directory across the whole fleet, not once per hook.
function directoryExists(value) {
  if (!value) return false;
  try { return fs.statSync(String(value).replace(/^~(?=\/|$)/, os.homedir())).isDirectory(); } catch { return false; }
}

function projectForCwd(handle, cwd) {
  if (!cwd) return '';
  // Take the most recent session in this exact directory, not an arbitrary one:
  // a path can be deleted and reused by a different repository, and the newest
  // answer is the only one that could still be right.
  const known = statement(handle,
    `SELECT project FROM sessions WHERE cwd = ? AND project IS NOT NULL AND project != ''
     ORDER BY COALESCE(last_at, started_at, 0) DESC LIMIT 1`).get(cwd);
  // A cached answer is only trusted while the checkout it names is still there.
  // The stat costs microseconds; the git call it saves costs ~110 ms. When the
  // working directory itself is gone (a recycled worktree, a deleted repo) there
  // is nothing better to compute, so the historical answer stands.
  if (known && known.project && (directoryExists(known.project) || !directoryExists(cwd))) return known.project;
  // A directory already recorded as some session's project is a main checkout,
  // so it canonicalizes to itself and needs no git call either.
  const normalized = normalizeProject(cwd);
  if (directoryExists(normalized)
      && statement(handle, 'SELECT 1 AS hit FROM sessions WHERE project = ? LIMIT 1').get(normalized)) {
    return normalized;
  }
  return canonicalProject(cwd);
}

function resolveSessionProject(session, existing) {
  const cwd = session.cwd || '';
  // A session that moved directories must be re-resolved. Keeping the old
  // project would leave a (new cwd, old project) row behind, and that row is
  // exactly what projectForCwd reads for every later session in that directory.
  const moved = Boolean(existing && cwd && existing.cwd && existing.cwd !== cwd);
  if (existing && existing.project && !moved) return existing.project;
  const computed = typeof session.project === 'function' ? session.project() : session.project;
  return computed || (existing && existing.project) || '';
}

function upsertSession(handle, session) {
  const existing = statement(handle, 'SELECT * FROM sessions WHERE id = ?').get(session.id);
  if (!existing) {
    statement(handle, `INSERT INTO sessions
      (id, agent, kind, cwd, project, account_id, file, parent_id, started_at, last_at, title, card_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      session.id, session.agent, session.kind, session.cwd || '', resolveSessionProject(session, null),
      session.accountId || null, session.file, session.parentId || null,
      session.startedAt == null ? null : session.startedAt, session.lastAt == null ? null : session.lastAt,
      session.title || null, session.cardId || null);
    return;
  }
  statement(handle, `UPDATE sessions SET agent = ?, kind = ?, cwd = ?, project = ?, account_id = ?, file = ?,
      parent_id = ?, started_at = ?, last_at = ?, title = ?, card_id = ? WHERE id = ?`).run(
    session.agent, session.kind, session.cwd || existing.cwd || '',
    resolveSessionProject(session, existing), session.accountId || existing.account_id || null,
    session.file, session.parentId || existing.parent_id || null,
    earliest(existing.started_at, session.startedAt), latest(existing.last_at, session.lastAt),
    session.title || existing.title || null, session.cardId || existing.card_id || null, session.id);
}

function insertMessage(handle, row) {
  const insert = () => statement(handle, `INSERT INTO messages
    (session_id, seq, ts, role, kind, text, tool_name, tool_id, files, command, stop_reason, tokens_in, tokens_out, turn_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.sessionId, row.seq, row.ts, row.role, row.kind, row.text, row.toolName || null,
    row.toolId || null, row.files || null, row.command || null, row.stopReason || null,
    row.tokensIn == null ? null : row.tokensIn, row.tokensOut == null ? null : row.tokensOut, row.turnId || null);
  try { return insert(); } catch (error) {
    if (!/UNIQUE/i.test(String(error && error.message))) throw error;
    // Re-ingesting the same bytes must not duplicate or desync the FTS shadow.
    statement(handle, 'DELETE FROM messages WHERE session_id = ? AND seq = ?').run(row.sessionId, row.seq);
    return insert();
  }
}

function lastTurnNumber(handle, sessionId) {
  const last = statement(handle, 'SELECT MAX(n) AS n FROM turns WHERE session_id = ?').get(sessionId);
  return Number(last && last.n ? last.n : 0);
}

function insertTurn(handle, sessionId, n, turn) {
  statement(handle, `INSERT INTO turns (session_id, n, started_at, opener_kind, opener_text, tool_count, ended)
    VALUES (?, ?, ?, ?, ?, 0, 0)`).run(sessionId, n, turn.startedAt, turn.openerKind, turn.openerText);
  return statement(handle, 'SELECT id FROM turns WHERE session_id = ? AND n = ?').get(sessionId, n).id;
}

// Turn rows are derived, never accumulated: recomputing from the turn's own
// messages is what keeps a turn that spans several ingest passes correct.
// What a recorded tool_use actually ran, read back out of the stored input.
// `undefined` means the input could not be read at all (it was truncated), which
// is different from a tool that ran no command.
function toolInputCommand(text) {
  if (typeof text !== 'string' || !text) return undefined;
  let input;
  try { input = JSON.parse(text); } catch { return undefined; }
  if (!input || typeof input !== 'object') return undefined;
  if (typeof input.arguments === 'string') {
    try { input = JSON.parse(input.arguments) || input; } catch { /* keep the outer object */ }
  } else if (input.arguments && typeof input.arguments === 'object') {
    input = input.arguments;
  }
  const value = input.command !== undefined ? input.command : input.cmd;
  return value === undefined ? null : value;
}

function refreshTurn(handle, turnId, { ended, stopReason } = {}) {
  if (!turnId) return;
  const rows = statement(handle, 
    'SELECT ts, role, kind, text, tool_name, tool_id, files, command, stop_reason FROM messages WHERE turn_id = ? ORDER BY seq',
  ).all(turnId);
  // Which tool calls actually ran a git commit. A sha is read only out of one of
  // their results: transcripts are full of commit-shaped text — a README, a test
  // fixture, a pasted log — and a commit the turn did not make would carry a
  // whole turn past the watcher's release carve-out.
  const commitCalls = new Set();
  for (const row of rows) {
    if (row.kind !== 'tool_use' || !row.tool_id) continue;
    // The full input, so an argv array is read as an argv array: `["git","commit
    // --help"]` runs no commit, and joining it into a string is what would say it
    // did. The column is the fallback for an input too long to have been kept.
    const ran = toolInputCommand(row.text);
    const candidate = ran === undefined ? row.command : ran;
    if (candidate === undefined || candidate === null || candidate === '') continue;
    try { if (require('./steps.js').runsGitCommit(candidate)) commitCalls.add(row.tool_id); } catch {}
  }
  const assistant = [];
  const tools = [];
  const files = [];
  const commits = [];
  let toolCount = 0;
  let lastAssistant = '';
  let endedAt = null;
  let seenStop = stopReason || null;
  for (const row of rows) {
    if (row.role === 'assistant' && row.kind === 'text' && row.text) {
      assistant.push(row.text);
      lastAssistant = row.text;
      endedAt = row.ts == null ? endedAt : row.ts;
    }
    if (row.role === 'assistant' && row.kind === 'tool_use') {
      toolCount += 1;
      if (row.tool_name) tools.push(row.tool_name);
      endedAt = row.ts == null ? endedAt : row.ts;
    }
    files.push(...parseJsonArray(row.files));
    if (row.stop_reason) seenStop = row.stop_reason;
    const haystack = row.role === 'tool' && row.tool_id && commitCalls.has(row.tool_id) ? row.text : null;
    if (haystack) for (const match of String(haystack).matchAll(COMMIT_RE)) commits.push(match[1]);
  }
  const existing = statement(handle, 'SELECT ended, stop_reason, ended_at FROM turns WHERE id = ?').get(turnId);
  statement(handle, `UPDATE turns SET ended_at = ?, assistant_text = ?, last_assistant = ?, tool_count = ?,
      tools = ?, files = ?, commits = ?, stop_reason = ?, ended = ? WHERE id = ?`).run(
    endedAt == null ? (existing && existing.ended_at) || null : endedAt,
    cap(assistant.join('\n\n'), TEXT_CAP), cap(lastAssistant, LAST_ASSISTANT_CAP), toolCount,
    jsonArray(tools), jsonArray(files), jsonArray(commits),
    seenStop || (existing && existing.stop_reason) || null,
    ended || (existing && existing.ended) ? 1 : 0, turnId);
}

function claudeSessionKind(file, sessionId, firstHumanText) {
  if (path.resolve(file).split(path.sep).includes('subagents')) return 'subagent';
  const marks = markers();
  if (marks.reviewer.has(sessionId)) return 'reviewer';
  if (marks.spawned.has(sessionId) || HEADLESS_PROMPT_RE.test(String(firstHumanText || ''))) return 'headless';
  return 'interactive';
}

function codexSessionKind(meta, sessionId) {
  const codex = require('./codex.js');
  if (meta && (meta.thread_source === 'subagent' || codex.isChildSession(meta))) return 'subagent';
  if (codex.isHeadlessSession(meta)) return 'headless';
  if (markers().reviewer.has(sessionId)) return 'reviewer';
  return 'interactive';
}

// One parser state machine, fed line by line, shared by both agents. It writes
// nothing: rows and turns accumulate in memory so the SQLite transaction that
// applies them is as short as possible, which is what keeps a Stop hook cheap.
function createIngestContext(handle, file, agent, state, options) {
  return {
    handle,
    file,
    agent,
    subagent: isSubagentFile(file) && agent === 'claude',
    sessionId: state.session_id || null,
    idFromName: false,
    seq: Number(state.seq || 0),
    // -1 means the turn already open from a previous pass (state.open_turn).
    turnRef: -1,
    carried: { ended: false, stopReason: null, touched: false },
    rows: [],
    newTurns: [],
    cwd: '',
    parentId: null,
    title: null,
    meta: null,
    startedAt: null,
    lastAt: null,
    firstHuman: null,
    kind: null,
    cardId: options.cardId || null,
    messages: 0,
    turns: 0,
  };
}

// Claude files subagent transcripts as <project>/subagents/agent-<id>.jsonl and
// <project>/<parent-session>/subagents/agent-<id>.jsonl.
function isSubagentFile(file) {
  return path.resolve(file).split(path.sep).includes('subagents');
}

// Runs inside the apply transaction, where the prior session row is visible.
function ensureSession(context) {
  if (!context.sessionId) return false;
  if (context.kind) return true;
  // A later pass sees neither the opening prompt nor the Codex session_meta, and
  // run/reviewer markers age out, so a kind once decided is never downgraded.
  const prior = statement(context.handle, 'SELECT kind FROM sessions WHERE id = ?').get(context.sessionId);
  if (prior && prior.kind && prior.kind !== 'interactive') { context.kind = prior.kind; return true; }
  context.kind = context.agent === 'codex'
    ? codexSessionKind(context.meta, context.sessionId)
    : claudeSessionKind(context.file, context.sessionId, context.firstHuman);
  return true;
}

function emit(context, row) {
  row.seq = context.seq++;
  row.turnRef = context.turnRef;
  if (context.turnRef === -1) context.carried.touched = true;
  context.rows.push(row);
  context.messages += 1;
  if (Number.isFinite(row.ts)) {
    context.startedAt = context.startedAt == null ? row.ts : Math.min(context.startedAt, row.ts);
    context.lastAt = context.lastAt == null ? row.ts : Math.max(context.lastAt, row.ts);
  }
}

function currentTurn(context) {
  return context.turnRef === -1 ? context.carried : context.newTurns[context.turnRef];
}

function startTurn(context, ts, kind, text) {
  const previous = currentTurn(context);
  if (previous) previous.ended = true; // the next opener closes whatever was open
  context.newTurns.push({
    startedAt: ts, openerKind: kind, openerText: cap(text, OPENER_CAP), ended: false, stopReason: null,
  });
  context.turnRef = context.newTurns.length - 1;
  context.turns += 1;
}

function endTurn(context, stopReason) {
  const turn = currentTurn(context);
  if (!turn) return;
  turn.ended = true;
  turn.stopReason = stopReason || turn.stopReason;
  if (context.turnRef === -1) context.carried.touched = true;
}

function handleClaudeLine(context, record) {
  // In a subagent file every record carries the PARENT's uuid in sessionId and
  // the subagent's own identity in agentId. Taking sessionId here would file the
  // subagent's messages under its parent and, worse, point the parent's row at
  // the subagent's file — so the two identities are read from opposite fields.
  if (context.subagent) {
    if (typeof record.agentId === 'string' && record.agentId && (!context.sessionId || context.idFromName)) {
      context.sessionId = record.agentId;
      context.idFromName = false;
    }
    if (typeof record.sessionId === 'string' && record.sessionId && !context.parentId) {
      context.parentId = record.sessionId;
    }
  } else if (typeof record.sessionId === 'string' && record.sessionId && (!context.sessionId || context.idFromName)) {
    // The records' own id outranks the filename guess, which is only there so a
    // resumed pass that starts past the first line still knows whose rows these are.
    context.sessionId = record.sessionId;
    context.idFromName = false;
  }
  if (typeof record.cwd === 'string' && record.cwd && !context.cwd) context.cwd = record.cwd;
  if (record.type === 'summary' && typeof record.summary === 'string' && !context.title) context.title = record.summary;
  if (record.type === 'ai-title' && typeof record.title === 'string' && !context.title) context.title = record.title;
  if (record.type !== 'user' && record.type !== 'assistant') return;
  // In a parent's own file a sidechain record is a subagent's conversation, not
  // the parent's turn. In a subagent file every record is sidechain and those
  // records ARE the conversation.
  if (record.isSidechain && !context.subagent) return;
  const ts = tsOf(record);
  const message = record.message || {};
  const content = message.content;

  if (record.type === 'user') {
    const blocks = Array.isArray(content) ? content : [];
    const results = blocks.filter((block) => block && block.type === 'tool_result');
    if (results.length) {
      for (const block of results) {
        emit(context, {
          ts, role: 'tool', kind: 'tool_result', text: cap(toolResultText(block), TOOL_CAP),
          toolId: typeof block.tool_use_id === 'string' ? block.tool_use_id : null,
        });
      }
      return;
    }
    const text = claudeText(content).trim();
    if (!text) return;
    const kind = claudeUserKind(record, text);
    if (kind === 'human' && !context.firstHuman) context.firstHuman = text;
    if (opensTurn(kind)) startTurn(context, ts, kind, text);
    emit(context, { ts, role: 'user', kind, text: cap(text, TEXT_CAP) });
    return;
  }

  const blocks = Array.isArray(content) ? content : [];
  const usage = message.usage || {};
  const tokensIn = Number.isFinite(usage.input_tokens) ? usage.input_tokens : null;
  const tokensOut = Number.isFinite(usage.output_tokens) ? usage.output_tokens : null;
  const stopReason = typeof message.stop_reason === 'string' ? message.stop_reason : null;
  let first = true;
  const attach = () => {
    const extra = first ? { tokensIn, tokensOut, stopReason } : {};
    first = false;
    return extra;
  };
  const text = claudeText(content).trim();
  if (text) emit(context, { ts, role: 'assistant', kind: 'text', text: cap(text, TEXT_CAP), ...attach() });
  for (const block of blocks) {
    if (!block || block.type !== 'tool_use') continue;
    const name = String(block.name || '');
    const input = block.input && typeof block.input === 'object' ? block.input : {};
    const command = SHELL_TOOLS.has(name) ? cap(shellCommand(input), COMMAND_CAP) : null;
    emit(context, {
      ts, role: 'assistant', kind: 'tool_use', text: cap(JSON.stringify(input), TOOL_CAP),
      toolName: name, toolId: typeof block.id === 'string' ? block.id : null,
      files: jsonArray(FILE_TOOLS.has(name) || SHELL_TOOLS.has(name) ? filesFromTool(name, input, null) : []),
      command, ...attach(),
    });
  }
  if (stopReason === 'end_turn') endTurn(context, stopReason);
}

function handleCodexLine(context, record) {
  const payload = record.payload;
  if (record.type === 'session_meta' && payload && typeof payload === 'object') {
    context.meta = payload;
    // session_meta is the rollout's own identity and outranks the filename guess.
    const declared = String(payload.id || payload.session_id || '');
    if (declared) { context.sessionId = declared; context.idFromName = false; }
    if (typeof payload.cwd === 'string' && payload.cwd) context.cwd = payload.cwd;
    if (typeof payload.parent_thread_id === 'string') context.parentId = payload.parent_thread_id;
    const started = Date.parse(payload.timestamp);
    if (Number.isFinite(started)) {
      context.startedAt = context.startedAt == null ? started : Math.min(context.startedAt, started);
    }
    return;
  }
  if (!payload || typeof payload !== 'object') return;
  const ts = tsOf(record);
  if (record.type === 'event_msg') {
    // Codex writes each user and assistant message twice (event_msg and
    // response_item); indexing only response_item keeps counts honest.
    if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
      endTurn(context, payload.type === 'turn_aborted' ? 'aborted' : 'task_complete');
    }
    return;
  }
  if (record.type !== 'response_item') return;

  if (payload.type === 'message' && payload.role === 'user') {
    const text = codexText(payload).trim();
    if (!text) return;
    const kind = codexUserKind(text);
    if (kind === 'human' && !context.firstHuman) context.firstHuman = text;
    if (opensTurn(kind)) startTurn(context, ts, kind, text);
    emit(context, { ts, role: 'user', kind, text: cap(text, TEXT_CAP) });
    return;
  }
  if (payload.type === 'agent_message' || (payload.type === 'message' && payload.role === 'assistant')) {
    const text = codexText(payload).trim();
    if (!text) return;
    emit(context, { ts, role: 'assistant', kind: 'text', text: cap(text, TEXT_CAP) });
    return;
  }
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    const name = String(payload.name || '');
    const { input, raw } = parseToolInput(payload);
    const command = SHELL_TOOLS.has(name) ? cap(shellCommand(input), COMMAND_CAP) : null;
    emit(context, {
      ts, role: 'assistant', kind: 'tool_use', text: cap(raw, TOOL_CAP), toolName: name,
      toolId: typeof payload.call_id === 'string' ? payload.call_id : null,
      files: jsonArray(filesFromTool(name, input, raw)), command,
    });
    return;
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const output = payload.output;
    const text = typeof output === 'string' ? output : JSON.stringify(output == null ? '' : output);
    emit(context, {
      ts, role: 'tool', kind: 'tool_result', text: cap(text, TOOL_CAP),
      toolId: typeof payload.call_id === 'string' ? payload.call_id : null,
    });
  }
}

// One pass over one file: at most `maxBytes` of appended transcript, waiting at
// most `busyTimeoutMs` for the write lock. `partial: true` means there is more
// to read and some later pass (the daemon tick, the next hook) should come back.
function ingestFile(file, options = {}) {
  if (!file || typeof file !== 'string') return { ok: false, skipped: 'no-file' };
  let stat;
  try { stat = fs.statSync(file); } catch { return { ok: false, skipped: 'missing' }; }
  if (!stat.isFile()) return { ok: false, skipped: 'not-a-file' };
  const agent = options.agent === 'codex' || options.agent === 'claude' ? options.agent : agentForFile(file);
  let handle;
  try {
    handle = open(options.db || databaseFile(), { busyTimeoutMs: options.busyTimeoutMs });
  } catch (error) {
    // Creating the schema takes the write lock, so a first-ever hook can lose
    // that race too; it is a skip like any other, not a failure.
    if (isBusy(error)) { debug(`busy opening ${file}`); return { ok: false, skipped: 'busy' }; }
    debug(`open failed: ${error.message}`);
    return { ok: false, skipped: 'open-failed' };
  }
  try {
    return ingestPass(handle, file, agent, stat, options);
  } catch (error) {
    try { handle.exec('ROLLBACK'); } catch {}
    if (isBusy(error)) { debug(`busy: ${file}`); return { ok: false, skipped: 'busy' }; }
    debug(`ingest failed for ${file}: ${error.message}`);
    return { ok: false, skipped: 'error', error: error.message };
  }
}

function emptyIngestState(file) {
  return { file, session_id: null, offset: 0, size: 0, mtime: 0, seq: 0, open_turn: null, head_sha: null };
}

function ingestPass(handle, file, agent, stat, options) {
  // Phase 1: decide what to read. Reads outside a transaction; WAL readers never
  // block a writer, and nothing here is worth holding the write lock for.
  const state = loadIngestState(handle, file);
  const expected = { offset: Number(state.offset || 0), seq: Number(state.seq || 0) };
  let headSha = null;
  try { headSha = headFingerprint(file, stat.size); } catch {}
  // A rewritten file can keep its size, so the offset alone cannot prove the
  // bytes behind it are still the same bytes.
  const replaced = headReplaced(file, stat, state.head_sha);
  const reset = options.force === true || stat.size < expected.offset || replaced;
  const from = reset ? 0 : expected.offset;
  if (!reset && from === stat.size && Number(state.mtime || 0) === Math.floor(stat.mtimeMs)
      && state.head_sha === headSha) {
    return { ok: true, skipped: 'unchanged', file, sessionId: state.session_id, messages: 0, turns: 0, bytes: 0 };
  }

  // Phase 2: read and parse into memory. The expensive part, and no lock is held.
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES;
  const context = createIngestContext(handle, file, agent, reset ? emptyIngestState(file) : state, options);
  // A Codex rollout's identity lives only in its first line; a resumed pass must
  // not lose it, so the ingest state carries the session id forward, and the
  // filename stands in until a record says otherwise.
  if (!context.sessionId) {
    context.sessionId = sessionIdFromName(file, agent);
    context.idFromName = Boolean(context.sessionId);
  }
  const handler = agent === 'codex' ? handleCodexLine : handleClaudeLine;
  const consumed = readLines(file, from, stat.size, maxBytes, (line) => {
    let record;
    try { record = JSON.parse(line); } catch { return; }
    if (!record || typeof record !== 'object') return;
    try { handler(context, record); } catch (error) { debug(`record skipped: ${error.message}`); }
  });
  const partial = from + consumed < stat.size;
  // Advancing past rows we cannot file would lose them permanently.
  if (!context.sessionId && context.rows.length) return { ok: false, skipped: 'no-session', file };

  // Phase 3: write. Only inserts and updates happen under the lock.
  return applyPass(handle, file, agent, stat, {
    context, expected, reset, from, consumed, partial, headSha,
    carriedTurnId: reset ? null : state.open_turn || null,
  });
}

function applyPass(handle, file, agent, stat, plan) {
  const { context, expected, reset, from, consumed, partial, headSha } = plan;
  handle.exec('BEGIN IMMEDIATE');
  try {
    // Another hook or the daemon tick may have ingested this same delta while we
    // were parsing it. Its pass is as good as ours; ours is simply dropped.
    const current = loadIngestState(handle, file);
    if (Number(current.offset || 0) !== expected.offset || Number(current.seq || 0) !== expected.seq) {
      handle.exec('ROLLBACK');
      return { ok: false, skipped: 'raced', file };
    }
    if (reset) clearSession(handle, current.session_id, { keepVerdicts: true });

    if (context.sessionId) {
      ensureSession(context);
      upsertSession(handle, {
        id: context.sessionId, agent, kind: context.kind || 'interactive', cwd: context.cwd,
        project: () => projectForCwd(handle, context.cwd), accountId: accountIdFor(file), file,
        parentId: context.parentId, startedAt: context.startedAt, lastAt: context.lastAt,
        title: context.title, cardId: context.cardId,
      });
    }

    let carriedTurnId = plan.carriedTurnId;
    if (carriedTurnId) {
      const row = statement(handle, 'SELECT session_id FROM turns WHERE id = ?').get(carriedTurnId);
      if (!row || row.session_id !== context.sessionId) carriedTurnId = null;
    }
    let n = context.sessionId ? lastTurnNumber(handle, context.sessionId) : 0;
    const turnIds = context.newTurns.map((turn) => insertTurn(handle, context.sessionId, ++n, turn));
    const turnIdFor = (ref) => (ref === -1 ? carriedTurnId : turnIds[ref]);

    for (const row of context.rows) {
      insertMessage(handle, { ...row, sessionId: context.sessionId, turnId: turnIdFor(row.turnRef) });
    }
    if (carriedTurnId && (context.carried.touched || context.carried.ended)) {
      refreshTurn(handle, carriedTurnId, { ended: context.carried.ended, stopReason: context.carried.stopReason });
    }
    turnIds.forEach((id, index) => refreshTurn(handle, id, {
      ended: context.newTurns[index].ended, stopReason: context.newTurns[index].stopReason,
    }));
    // Verdicts parked by a reset come back onto the rebuilt rows, but only once
    // the file is fully read: a capped re-ingest rebuilds a turn's assistant side
    // over several passes, and comparing it half-built would drop every verdict.
    if (context.sessionId && !partial && hasParkedVerdicts(handle, context.sessionId)) {
      restoreVerdicts(handle, context.sessionId);
      dropParkedVerdicts(handle, context.sessionId);
      // Whatever did not come back is gone, so the session's denormalized copy
      // has to be recomputed from what is actually left.
      refreshSessionVerdictState(handle, context.sessionId);
    }

    statement(handle, `INSERT INTO ingest_state (file, session_id, "offset", size, mtime, seq, open_turn, head_sha, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file) DO UPDATE SET session_id = excluded.session_id, "offset" = excluded."offset",
        size = excluded.size, mtime = excluded.mtime, seq = excluded.seq,
        open_turn = excluded.open_turn, head_sha = excluded.head_sha, updated_at = excluded.updated_at`).run(
      file, context.sessionId, from + consumed, stat.size, Math.floor(stat.mtimeMs),
      context.seq, turnIdFor(context.turnRef), headSha, Date.now());
    handle.exec('COMMIT');
  } catch (error) {
    try { handle.exec('ROLLBACK'); } catch {}
    throw error;
  }
  return {
    ok: true, file, agent, sessionId: context.sessionId, kind: context.kind,
    messages: context.messages, turns: context.turns, bytes: consumed, partial,
    ...(reset ? { reset: true } : {}),
  };
}

// A Claude transcript is named <session-id>.jsonl and a Codex rollout
// rollout-<stamp>-<thread-id>.jsonl, so an id is available before the first line.
function sessionIdFromName(file, agent) {
  const base = path.basename(file, '.jsonl');
  // agent-<id>.jsonl names a subagent by its agentId; strip the prefix so the
  // filename and the records' own agentId field resolve to the same identity.
  if (agent === 'claude' && isSubagentFile(file) && base.startsWith('agent-')) {
    const id = base.slice('agent-'.length);
    return /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
  }
  if (agent === 'claude') return /^[A-Za-z0-9_-]+$/.test(base) ? base : null;
  const match = base.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match ? match[1] : null;
}

// ---------- ingest entry points ----------

function resolveSessionFile(session) {
  if (session && typeof session.file === 'string' && session.file) return session.file;
  const id = session && session.id;
  if (!id) return null;
  try {
    if (session.agent === 'codex' || session.kind === 'codex') return require('./codex.js').findRolloutFile(id);
    return require('./transcripts.js').findSessionFile(id);
  } catch { return null; }
}

// The daemon sweeps live sessions on a timer. The bound that matters is time and
// bytes, not file count: one tick of a busy fleet must not become a long
// synchronous stall in the daemon's event loop. The round-robin cursor survives
// the tick, so whatever the budget cut off is where the next tick starts.
function ingestSessionsFromLiveState(sessions, options = {}) {
  const list = Array.isArray(sessions) ? sessions.filter(Boolean) : [];
  const budgetMs = Number.isFinite(options.budgetMs) && options.budgetMs >= 0 ? options.budgetMs : 150;
  const byteBudget = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : 8 * 1024 * 1024;
  const busy = Number.isFinite(options.busyTimeoutMs) ? options.busyTimeoutMs : 250;
  // The clock can only be checked between files, so one file must not be able to
  // blow the wall-clock budget on its own: ~1 MiB is under 100 ms of parsing.
  const perFile = Number.isFinite(options.perFileMaxBytes) && options.perFileMaxBytes > 0
    ? options.perFileMaxBytes : 1024 * 1024;
  const startedAt = Date.now();
  const results = [];
  let skipped = 0;
  let bytes = 0;
  let files = 0;
  let partial = false;
  if (!list.length) return { ingested: 0, skipped: 0, files: 0, bytes: 0, ms: 0, partial: false, results };
  const start = liveCursor % list.length;
  let index = 0;
  for (; index < list.length; index += 1) {
    if (Date.now() - startedAt >= budgetMs || bytes >= byteBudget) { partial = true; break; }
    const session = list[(start + index) % list.length];
    const file = resolveSessionFile(session);
    if (!file) { skipped += 1; continue; }
    const agent = session.agent || (session.kind === 'codex' ? 'codex' : 'claude');
    const result = ingestFile(file, {
      agent, cardId: session.cardId || null, busyTimeoutMs: busy,
      maxBytes: Math.min(Math.max(byteBudget - bytes, 64 * 1024), perFile),
    });
    files += 1;
    bytes += result.bytes || 0;
    if (!result.ok) skipped += 1;
    if (result.partial) partial = true;
    results.push(result);
  }
  liveCursor = (start + index) % list.length;
  return {
    ingested: results.filter((row) => row.ok).length, skipped, files, bytes,
    ms: Date.now() - startedAt, partial, results,
  };
}

function claudeBackfillDirs() {
  const dirs = [];
  let roots = [];
  try { roots = require('./accounts.js').projectRoots().map((entry) => entry.root); } catch {}
  const addSubagents = (dir) => {
    const nested = path.join(dir, 'subagents');
    try { if (fs.statSync(nested).isDirectory()) dirs.push(nested); } catch {}
  };
  for (const root of roots) {
    let names;
    try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      dirs.push(dir);
      // Claude files subagents either directly under the project
      // (<project>/subagents) or under the parent session
      // (<project>/<parent-session>/subagents); both shapes exist on disk.
      addSubagents(dir);
      let children;
      try { children = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const child of children) {
        if (child.isDirectory() && child.name !== 'subagents') addSubagents(path.join(dir, child.name));
      }
    }
  }
  return dirs;
}

function codexBackfillDirs() {
  const dirs = [];
  let roots = [];
  try { roots = require('./codex.js').configuredRoots().map((entry) => path.join(entry.configDir, 'sessions')); } catch {}
  for (const root of roots) walkDateDirs(root, 0, dirs);
  return dirs;
}

// ~/.codex/sessions is YYYY/MM/DD; recursing by depth avoids a full-tree walk.
function walkDateDirs(dir, depth, out) {
  if (depth === 3) { out.push(dir); return; }
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) walkDateDirs(path.join(dir, entry.name), depth + 1, out);
  }
}

function backfill(options = {}) {
  const since = Number.isFinite(options.since) ? options.since
    : Date.now() - DEFAULT_BACKFILL_DAYS * 86400e3;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const explicit = Array.isArray(options.roots) && options.roots.length ? options.roots : null;
  const targets = explicit
    ? explicit.map((dir) => ({ dir, agent: null }))
    : [
      ...claudeBackfillDirs().map((dir) => ({ dir, agent: 'claude' })),
      ...codexBackfillDirs().map((dir) => ({ dir, agent: 'codex' })),
    ];
  const startedAt = Date.now();
  const summary = { files: 0, sessions: new Set(), messages: 0, turns: 0, skipped: 0, seconds: 0 };
  for (const target of targets) {
    let entries;
    try { entries = fs.readdirSync(target.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(target.dir, entry.name);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (stat.mtimeMs < since) continue;
      const agent = target.agent || agentForFile(file);
      // A pass is byte-capped, so a 300 MB rollout takes several; backfill is the
      // one caller that should finish a file before moving on.
      let result = ingestFile(file, { agent, force: options.force === true });
      summary.files += 1;
      let guard = 0;
      while (result.ok && result.partial && (guard += 1) < 10000) {
        if (result.sessionId) summary.sessions.add(result.sessionId);
        summary.messages += result.messages || 0;
        summary.turns += result.turns || 0;
        result = ingestFile(file, { agent });
      }
      if (result.ok) {
        if (result.sessionId) summary.sessions.add(result.sessionId);
        summary.messages += result.messages || 0;
        summary.turns += result.turns || 0;
      } else summary.skipped += 1;
      if (summary.files % 100 === 0) onProgress({ ...summary, sessions: summary.sessions.size, file });
    }
  }
  summary.seconds = Math.round((Date.now() - startedAt) / 100) / 10;
  return { ...summary, sessions: summary.sessions.size };
}

// ---------- retention ----------

// The index is a derived cache over transcripts Claude and Codex keep forever;
// without a cutoff it grows for the life of the machine. Sessions with no
// timestamp at all are never pruned — an unknown age is not an old age.
function pruneCutoff(options = {}) {
  if (Number.isFinite(options.cutoff)) return options.cutoff;
  const olderThanMs = Number.isFinite(options.olderThanMs) && options.olderThanMs > 0
    ? options.olderThanMs : DEFAULT_PRUNE_DAYS * 86400e3;
  return Date.now() - olderThanMs;
}

// Which sessions are stale right now. Exposed so a caller can look before it
// deletes; prune re-checks each one under the write lock regardless.
function pruneCandidates(options = {}) {
  const handle = open(options.db || databaseFile());
  // The daemon prunes on its event loop, so a first sweep after a big backfill
  // must not delete tens of thousands of sessions in one go; it passes a limit
  // and comes back next tick while `more` is set. Oldest first.
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : -1;
  return statement(handle,
    `SELECT id FROM sessions WHERE COALESCE(last_at, started_at) IS NOT NULL
       AND COALESCE(last_at, started_at) < ?
     ORDER BY COALESCE(last_at, started_at) LIMIT ?`).all(pruneCutoff(options), limit).map((row) => row.id);
}

function prune(options = {}) {
  const handle = open(options.db || databaseFile());
  const cutoff = pruneCutoff(options);
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : -1;
  const chosen = Array.isArray(options.candidates) ? options.candidates.filter(Boolean) : null;
  const candidates = chosen || pruneCandidates({ ...options, cutoff });
  const countIn = (sql, id) => Number(statement(handle, sql).get(id).n || 0);
  const counts = {
    cutoff, sessions: 0, messages: 0, turns: 0, files: 0,
    more: !chosen && limit > 0 && candidates.length === limit,
  };
  if (!candidates.length) return options.dry === true ? { ...counts, dry: true } : counts;
  if (options.dry === true) {
    for (const id of candidates) {
      counts.sessions += 1;
      counts.messages += countIn('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?', id);
      counts.turns += countIn('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?', id);
      counts.files += countIn('SELECT COUNT(*) AS n FROM ingest_state WHERE session_id = ?', id);
    }
    return { ...counts, dry: true };
  }
  setBusyTimeout(handle, options.busyTimeoutMs);
  handle.exec('BEGIN IMMEDIATE');
  try {
    for (const id of candidates) {
      // Selection happened outside the lock, so a session may have received a
      // turn since. The cutoff is re-checked here, in the same statement that
      // deletes: only a session that is still stale loses its rows, and the
      // counts report what actually went rather than what was planned.
      const deleted = statement(handle,
        `DELETE FROM sessions WHERE id = ? AND COALESCE(last_at, started_at) IS NOT NULL
           AND COALESCE(last_at, started_at) < ?`).run(id, cutoff);
      if (!Number(deleted.changes)) continue;
      counts.sessions += 1;
      counts.messages += countIn('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?', id);
      counts.turns += countIn('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?', id);
      counts.files += countIn('SELECT COUNT(*) AS n FROM ingest_state WHERE session_id = ?', id);
      // The messages delete fires the FTS delete trigger, so the shadow table
      // shrinks with the real one.
      clearSession(handle, id);
      dropParkedVerdicts(handle, id); // the session is going for good, not being rebuilt
      statement(handle, 'DELETE FROM ingest_state WHERE session_id = ?').run(id);
    }
    handle.exec('COMMIT');
  } catch (error) {
    try { handle.exec('ROLLBACK'); } catch {}
    throw error;
  }
  return counts;
}

// ---------- queries ----------

function search(query, options = {}) {
  const handle = open(options.db || databaseFile());
  const text = String(query || '').trim();
  if (!text) return [];
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 500) : 25;
  // FTS5 reads `-`, `:` and bare `NOT`/`OR` as operators, so "home-only" is a
  // syntax error rather than a phrase. Quote every whitespace-separated token
  // (implicit AND) unless the caller asks for raw FTS syntax.
  const match = options.raw ? text
    : text.split(/\s+/).map((token) => `"${token.replace(/"/g, '""')}"`).join(' ');
  const where = ['messages_fts MATCH ?'];
  const params = [match];
  if (Number.isFinite(options.since)) { where.push('m.ts >= ?'); params.push(options.since); }
  if (options.project) { where.push('s.project = ?'); params.push(normalizeProject(options.project)); }
  if (options.agent) { where.push('s.agent = ?'); params.push(options.agent); }
  params.push(limit);
  return statement(handle, `SELECT m.id, m.session_id, m.ts, m.role, m.kind, m.tool_name,
      s.agent, s.project, snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
    JOIN sessions s ON s.id = m.session_id
    WHERE ${where.join(' AND ')}
    ORDER BY m.ts DESC LIMIT ?`).all(...params);
}

function turnsForSession(id, options = {}) {
  const handle = open(options.db || databaseFile());
  const last = Number.isInteger(options.last) && options.last > 0 ? options.last : 20;
  const rows = statement(handle, 
    'SELECT * FROM turns WHERE session_id = ? ORDER BY n DESC LIMIT ?',
  ).all(String(id), last);
  return rows.reverse();
}

function sessionRow(id, options = {}) {
  const handle = open(options.db || databaseFile());
  return statement(handle, 'SELECT * FROM sessions WHERE id = ?').get(String(id)) || null;
}

function isNudge(text) {
  const trimmed = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.length > 60) return false;
  return NUDGE_RE.test(trimmed);
}

function stats(options = {}) {
  const handle = open(options.db || databaseFile());
  const since = Number.isFinite(options.since) ? options.since : 0;
  const buckets = new Map();
  const bucket = (agent, kind) => {
    const key = `${agent}⁣${kind}`;
    if (!buckets.has(key)) {
      buckets.set(key, { agent, kind, sessions: 0, turns: 0, humanOpeners: 0, keepOpeners: 0, nudges: 0 });
    }
    return buckets.get(key);
  };
  for (const row of statement(handle, 
    'SELECT agent, kind, COUNT(*) AS n FROM sessions WHERE COALESCE(last_at, 0) >= ? GROUP BY agent, kind',
  ).all(since)) bucket(row.agent, row.kind).sessions = row.n;
  for (const row of statement(handle, 
    `SELECT s.agent AS agent, s.kind AS kind, t.opener_kind AS opener_kind, t.opener_text AS opener_text
     FROM turns t JOIN sessions s ON s.id = t.session_id
     WHERE COALESCE(t.started_at, 0) >= ?`,
  ).all(since)) {
    const entry = bucket(row.agent, row.kind);
    entry.turns += 1;
    if (row.opener_kind === 'keep') entry.keepOpeners += 1;
    if (row.opener_kind !== 'human') continue;
    entry.humanOpeners += 1;
    if (isNudge(row.opener_text)) entry.nudges += 1;
  }
  const rows = [...buckets.values()].sort((a, b) => a.agent.localeCompare(b.agent) || a.kind.localeCompare(b.kind));
  const totals = rows.reduce((sum, row) => ({
    sessions: sum.sessions + row.sessions, turns: sum.turns + row.turns,
    humanOpeners: sum.humanOpeners + row.humanOpeners, keepOpeners: sum.keepOpeners + row.keepOpeners,
    nudges: sum.nudges + row.nudges,
  }), { sessions: 0, turns: 0, humanOpeners: 0, keepOpeners: 0, nudges: 0 });
  return { since, rows, totals };
}

module.exports = {
  open, close, databaseFile, ingestFile, ingestSessionsFromLiveState, backfill, prune, pruneCandidates,
  search, turnsForSession, sessionRow, stats, isNudge, normalizeProject,
  SCHEMA_VERSION, TEXT_CAP, TOOL_CAP, COMMAND_CAP, NUDGE_RE, DEFAULT_PRUNE_DAYS,
  toolInputCommand,
};
