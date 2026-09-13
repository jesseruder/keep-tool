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

const SCHEMA_VERSION = 1;

// Text caps. Transcripts contain whole files and 100k-line build logs; the index
// exists to find and count turns, not to be a second copy of the corpus.
const TEXT_CAP = 16 * 1024;
const TOOL_CAP = 2 * 1024;
const OPENER_CAP = 2 * 1024;
const LAST_ASSISTANT_CAP = 4 * 1024;
const COMMAND_CAP = 500;

const CHUNK_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 32 * 1024 * 1024; // a line longer than this is abandoned
const DEFAULT_BACKFILL_DAYS = 14;
const MARKER_TTL_MS = 30e3;

// A "nudge" is a turn Owner spent only to restart an agent that stopped early.
// This is the metric the turn watcher is meant to drive down.
const NUDGE_RE = /^(ok |yes |please )?(continue|keep going|go ahead|go on|proceed|anything else.*|anything left.*|what'?s next|check (now|again)|done)[.!?]*$/;

const CLAUDE_COMMAND_RE = /^<(?:command-name|command-message|command-args|local-command|bash-input|bash-stdout|bash-stderr)\b/;
const CLAUDE_WRAPPER_RE = /^<(?:system-reminder|task-notification|cross-session-message|user-prompt-submit-hook)\b/;
const CODEX_PREAMBLE_RE = /^(?:<(?:recommended_plugins|available_plugins|environment_context|user_instructions|permissions|collaboration_mode|turn_aborted|system-reminder|task-notification|cross-session-message)\b|# AGENTS\.md instructions)/;
// Keep's own headless runs (`keep runs`, the Slack classifier, tab naming, the
// brief) and Owner's `claude -p` batch jobs all open with a system-style "You are
// …" prompt; a person opening a conversation that way is rare enough to accept.
const HEADLESS_PROMPT_RE = /^(?:You are\b|You classify\b)/;
// `git commit` prints the new sha in brackets: `[wt/turn-index 1a2b3c4] message`.
const COMMIT_RE = /\[[^\]\s]+(?:\s+\(root-commit\))?\s+([0-9a-f]{7,40})\]/g;
const PATH_TOKEN_RE = /(?:^|[\s='"(])((?:~|\.{0,2})?\/?[\w.@+-]*\/[\w./@+-]*\.[A-Za-z0-9]{1,8})(?=$|[\s'")\];,:])/g;
const APPLY_PATCH_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit', 'NotebookRead']);
const SHELL_TOOLS = new Set(['Bash', 'BashOutput', 'shell', 'local_shell', 'container.exec']);

let db = null;
let dbPath = null;
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

function migrate(handle) {
  const current = Number(handle.prepare('PRAGMA user_version').get().user_version || 0);
  if (current >= SCHEMA_VERSION) return;
  handle.exec('BEGIN IMMEDIATE');
  try {
    for (const sql of SCHEMA) handle.exec(sql);
    handle.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    handle.exec('COMMIT');
  } catch (error) {
    try { handle.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function open(file = databaseFile()) {
  if (db && dbPath === file) return db;
  if (db) close();
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = new DatabaseSync(file);
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA busy_timeout = 5000');
  handle.exec('PRAGMA synchronous = NORMAL');
  migrate(handle);
  db = handle;
  dbPath = file;
  return db;
}

function close() {
  if (!db) return;
  try { db.close(); } catch {}
  db = null;
  dbPath = null;
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
  const value = input.command;
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
  if (/^\[keep\]/.test(text)) return 'keep';
  if (CLAUDE_WRAPPER_RE.test(text)) return 'preamble';
  return 'human';
}

function codexUserKind(text) {
  if (CODEX_PREAMBLE_RE.test(text)) return 'preamble';
  if (/^\[keep\]/.test(text)) return 'keep';
  if (/^<(?:command-name|local-command|bash-input)\b/.test(text)) return 'command';
  return 'human';
}

function opensTurn(kind) {
  return kind === 'human' || kind === 'keep' || kind === 'command';
}

// ---------- incremental line reader ----------

// Reads whole lines from [from, to) and returns how many bytes of complete lines
// were consumed, so a partial trailing line is simply re-read next pass.
function readLines(file, from, to, onLine) {
  if (to <= from) return 0;
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.alloc(CHUNK_BYTES);
  let leftover = Buffer.alloc(0);
  let consumed = 0;
  let position = from;
  try {
    while (position < to) {
      const want = Math.min(CHUNK_BYTES, to - position);
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
    }
  } finally {
    fs.closeSync(fd);
  }
  return consumed;
}

// ---------- ingest ----------

function loadIngestState(handle, file) {
  const row = statement(handle, 'SELECT * FROM ingest_state WHERE file = ?').get(file);
  return row || { file, session_id: null, offset: 0, size: 0, mtime: 0, seq: 0, open_turn: null };
}

function clearSession(handle, sessionId) {
  if (!sessionId) return;
  statement(handle, 'DELETE FROM messages WHERE session_id = ?').run(sessionId);
  statement(handle, 'DELETE FROM turns WHERE session_id = ?').run(sessionId);
}

function earliest(a, b) {
  const values = [a, b].filter((value) => Number.isFinite(value));
  return values.length ? Math.min(...values) : null;
}

function latest(a, b) {
  const values = [a, b].filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

function upsertSession(handle, session) {
  const existing = statement(handle, 'SELECT * FROM sessions WHERE id = ?').get(session.id);
  if (!existing) {
    statement(handle, `INSERT INTO sessions
      (id, agent, kind, cwd, project, account_id, file, parent_id, started_at, last_at, title, card_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      session.id, session.agent, session.kind, session.cwd || '', session.project || '',
      session.accountId || null, session.file, session.parentId || null,
      session.startedAt == null ? null : session.startedAt, session.lastAt == null ? null : session.lastAt,
      session.title || null, session.cardId || null);
    return;
  }
  statement(handle, `UPDATE sessions SET agent = ?, kind = ?, cwd = ?, project = ?, account_id = ?, file = ?,
      parent_id = ?, started_at = ?, last_at = ?, title = ?, card_id = ? WHERE id = ?`).run(
    session.agent, session.kind, session.cwd || existing.cwd || '',
    session.project || existing.project || '', session.accountId || existing.account_id || null,
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

function openTurnRow(handle, sessionId, startedAt, openerKind, openerText) {
  const last = statement(handle, 'SELECT MAX(n) AS n FROM turns WHERE session_id = ?').get(sessionId);
  const n = Number(last && last.n ? last.n : 0) + 1;
  statement(handle, `INSERT INTO turns (session_id, n, started_at, opener_kind, opener_text, tool_count, ended)
    VALUES (?, ?, ?, ?, ?, 0, 0)`).run(sessionId, n, startedAt, openerKind, cap(openerText, OPENER_CAP));
  return statement(handle, 'SELECT id FROM turns WHERE session_id = ? AND n = ?').get(sessionId, n).id;
}

// Turn rows are derived, never accumulated: recomputing from the turn's own
// messages is what keeps a turn that spans several ingest passes correct.
function refreshTurn(handle, turnId, { ended, stopReason } = {}) {
  if (!turnId) return;
  const rows = statement(handle, 
    'SELECT ts, role, kind, text, tool_name, files, command, stop_reason FROM messages WHERE turn_id = ? ORDER BY seq',
  ).all(turnId);
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
    const haystack = row.role === 'tool' ? row.text : row.command;
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

// One parser state machine, fed line by line, shared by both agents. It emits
// message rows and opens/closes turns; everything durable goes straight to SQLite.
function createIngestContext(handle, file, agent, state, options) {
  return {
    handle,
    file,
    agent,
    sessionId: state.session_id || null,
    idFromName: false,
    seq: Number(state.seq || 0),
    turnId: state.open_turn || null,
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
    touchedTurns: new Set(),
  };
}

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
  if (!context.sessionId) return;
  row.sessionId = context.sessionId;
  row.seq = context.seq++;
  row.turnId = context.turnId;
  insertMessage(context.handle, row);
  context.messages += 1;
  if (row.turnId) context.touchedTurns.add(row.turnId);
  if (Number.isFinite(row.ts)) {
    context.startedAt = context.startedAt == null ? row.ts : Math.min(context.startedAt, row.ts);
    context.lastAt = context.lastAt == null ? row.ts : Math.max(context.lastAt, row.ts);
  }
}

function startTurn(context, ts, kind, text) {
  if (context.turnId) {
    refreshTurn(context.handle, context.turnId, { ended: true });
    context.touchedTurns.delete(context.turnId);
  }
  context.turnId = openTurnRow(context.handle, context.sessionId, ts, kind, text);
  context.turns += 1;
  context.touchedTurns.add(context.turnId);
}

function endTurn(context, stopReason) {
  if (!context.turnId) return;
  refreshTurn(context.handle, context.turnId, { ended: true, stopReason });
  context.touchedTurns.delete(context.turnId);
}

function handleClaudeLine(context, record) {
  // The records' own id outranks the filename guess, which is only there so a
  // resumed pass that starts past the first line still knows whose rows these are.
  if (typeof record.sessionId === 'string' && record.sessionId && (!context.sessionId || context.idFromName)) {
    context.sessionId = record.sessionId;
    context.idFromName = false;
  }
  if (typeof record.cwd === 'string' && record.cwd && !context.cwd) context.cwd = record.cwd;
  if (record.type === 'summary' && typeof record.summary === 'string' && !context.title) context.title = record.summary;
  if (record.type === 'ai-title' && typeof record.title === 'string' && !context.title) context.title = record.title;
  if (record.type !== 'user' && record.type !== 'assistant') return;
  // Sidechain records are a subagent's conversation written into the parent's
  // file. They are not the parent's turns, and Keep indexes subagent transcripts
  // only where Claude writes them as their own file.
  if (record.isSidechain) return;
  const ts = tsOf(record);
  const message = record.message || {};
  const content = message.content;

  if (record.type === 'user') {
    const blocks = Array.isArray(content) ? content : [];
    const results = blocks.filter((block) => block && block.type === 'tool_result');
    if (results.length) {
      if (!ensureSession(context)) return;
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
    if (!ensureSession(context)) return;
    if (opensTurn(kind)) startTurn(context, ts, kind, text);
    emit(context, { ts, role: 'user', kind, text: cap(text, TEXT_CAP) });
    return;
  }

  if (!ensureSession(context)) return;
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
      if (ensureSession(context)) endTurn(context, payload.type === 'turn_aborted' ? 'aborted' : 'task_complete');
    }
    return;
  }
  if (record.type !== 'response_item') return;

  if (payload.type === 'message' && payload.role === 'user') {
    const text = codexText(payload).trim();
    if (!text) return;
    const kind = codexUserKind(text);
    if (kind === 'human' && !context.firstHuman) context.firstHuman = text;
    if (!ensureSession(context)) return;
    if (opensTurn(kind)) startTurn(context, ts, kind, text);
    emit(context, { ts, role: 'user', kind, text: cap(text, TEXT_CAP) });
    return;
  }
  if (payload.type === 'agent_message' || (payload.type === 'message' && payload.role === 'assistant')) {
    const text = codexText(payload).trim();
    if (!text || !ensureSession(context)) return;
    emit(context, { ts, role: 'assistant', kind: 'text', text: cap(text, TEXT_CAP) });
    return;
  }
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    if (!ensureSession(context)) return;
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
    if (!ensureSession(context)) return;
    const output = payload.output;
    const text = typeof output === 'string' ? output : JSON.stringify(output == null ? '' : output);
    emit(context, {
      ts, role: 'tool', kind: 'tool_result', text: cap(text, TOOL_CAP),
      toolId: typeof payload.call_id === 'string' ? payload.call_id : null,
    });
  }
}

function ingestFile(file, options = {}) {
  if (!file || typeof file !== 'string') return { ok: false, skipped: 'no-file' };
  let stat;
  try { stat = fs.statSync(file); } catch { return { ok: false, skipped: 'missing' }; }
  if (!stat.isFile()) return { ok: false, skipped: 'not-a-file' };
  const agent = options.agent === 'codex' || options.agent === 'claude' ? options.agent : agentForFile(file);
  let handle;
  try { handle = open(options.db || databaseFile()); } catch (error) {
    debug(`open failed: ${error.message}`);
    return { ok: false, skipped: 'open-failed' };
  }
  try {
    return ingestWithinTransaction(handle, file, agent, stat, options);
  } catch (error) {
    try { handle.exec('ROLLBACK'); } catch {}
    if (isBusy(error)) { debug(`busy: ${file}`); return { ok: false, skipped: 'busy' }; }
    debug(`ingest failed for ${file}: ${error.message}`);
    return { ok: false, skipped: 'error', error: error.message };
  }
}

function ingestWithinTransaction(handle, file, agent, stat, options) {
  handle.exec('BEGIN IMMEDIATE');
  let state = loadIngestState(handle, file);
  let from = Number(state.offset || 0);
  const truncated = stat.size < from;
  if (options.force || truncated) {
    clearSession(handle, state.session_id);
    statement(handle, 'DELETE FROM ingest_state WHERE file = ?').run(file);
    state = loadIngestState(handle, file);
    from = 0;
  }
  if (from === stat.size && Number(state.mtime || 0) === Math.floor(stat.mtimeMs)) {
    handle.exec('COMMIT');
    return { ok: true, skipped: 'unchanged', file, sessionId: state.session_id, messages: 0, turns: 0 };
  }

  const context = createIngestContext(handle, file, agent, state, options);
  const handler = agent === 'codex' ? handleCodexLine : handleClaudeLine;
  // A Codex rollout's identity lives only in its first line; a resumed pass must
  // not lose it, so the ingest state carries the session id forward, and the
  // filename stands in until a record says otherwise.
  if (!context.sessionId) {
    context.sessionId = sessionIdFromName(file, agent);
    context.idFromName = Boolean(context.sessionId);
  }
  const consumed = readLines(file, from, stat.size, (line) => {
    let record;
    try { record = JSON.parse(line); } catch { return; }
    if (!record || typeof record !== 'object') return;
    try { handler(context, record); } catch (error) { debug(`record skipped: ${error.message}`); }
  });

  if (context.sessionId) {
    ensureSession(context);
    upsertSession(handle, {
      id: context.sessionId, agent, kind: context.kind || 'interactive', cwd: context.cwd,
      project: canonicalProject(context.cwd), accountId: accountIdFor(file), file,
      parentId: context.parentId, startedAt: context.startedAt, lastAt: context.lastAt,
      title: context.title, cardId: context.cardId,
    });
    for (const turnId of context.touchedTurns) refreshTurn(handle, turnId);
  }

  statement(handle, `INSERT INTO ingest_state (file, session_id, "offset", size, mtime, seq, open_turn, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file) DO UPDATE SET session_id = excluded.session_id, "offset" = excluded."offset",
      size = excluded.size, mtime = excluded.mtime, seq = excluded.seq,
      open_turn = excluded.open_turn, updated_at = excluded.updated_at`).run(
    file, context.sessionId, from + consumed, stat.size, Math.floor(stat.mtimeMs),
    context.seq, context.turnId, Date.now());
  handle.exec('COMMIT');
  return {
    ok: true, file, agent, sessionId: context.sessionId, kind: context.kind,
    messages: context.messages, turns: context.turns, bytes: consumed,
  };
}

// A Claude transcript is named <session-id>.jsonl and a Codex rollout
// rollout-<stamp>-<thread-id>.jsonl, so an id is available before the first line.
function sessionIdFromName(file, agent) {
  const base = path.basename(file, '.jsonl');
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

// The daemon sweeps live sessions on a timer. Bounded and round-robin so one
// tick never walks the whole fleet, and never throws into the daemon loop.
function ingestSessionsFromLiveState(sessions, options = {}) {
  const list = Array.isArray(sessions) ? sessions.filter(Boolean) : [];
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 64;
  const results = [];
  if (!list.length) return { ingested: 0, skipped: 0, results };
  const start = liveCursor % list.length;
  let skipped = 0;
  for (let i = 0; i < Math.min(limit, list.length); i += 1) {
    const session = list[(start + i) % list.length];
    const file = resolveSessionFile(session);
    if (!file) { skipped += 1; continue; }
    const agent = session.agent || (session.kind === 'codex' ? 'codex' : 'claude');
    const result = ingestFile(file, { agent, cardId: session.cardId || null });
    if (!result.ok) skipped += 1;
    results.push(result);
  }
  liveCursor = (start + Math.min(limit, list.length)) % list.length;
  return { ingested: results.filter((row) => row.ok).length, skipped, results };
}

function claudeBackfillDirs() {
  const dirs = [];
  let roots = [];
  try { roots = require('./accounts.js').projectRoots().map((entry) => entry.root); } catch {}
  for (const root of roots) {
    let names;
    try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      dirs.push(dir);
      // Newer Claude builds file subagent transcripts in their own subdirectory.
      const nested = path.join(dir, 'subagents');
      try { if (fs.statSync(nested).isDirectory()) dirs.push(nested); } catch {}
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
      const result = ingestFile(file, { agent, force: options.force === true });
      summary.files += 1;
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
  open, close, databaseFile, ingestFile, ingestSessionsFromLiveState, backfill,
  search, turnsForSession, sessionRow, stats, isNudge, normalizeProject,
  SCHEMA_VERSION, TEXT_CAP, TOOL_CAP, NUDGE_RE,
};
