'use strict';
// Cached, best-effort scanning of top-level Codex session rollouts.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { StringDecoder } = require('string_decoder');
const sessionStatus = require('./session-status.js');

const SESSION_WINDOW_MS = 48 * 3600e3;
const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 256 * 1024;
const scanCache = new Map(); // file -> { mtimeMs, size, info }
const sessionPathCache = new Map(); // session id -> { file, accountId, configDir }
const sessionParseCache = new Map(); // file -> { mtimeMs, size, info }
const questionCache = new Map(); // incremental question lifecycle, independent of the text tail
const SESSION_LOOKUP_CACHE_LIMIT = 300;
const indexCache = new Map(); // index file -> { mtimeMs, size, titles }
let rolloutFiles = new Map(); // session id -> { file, accountId, configDir }, replaced after each scan

function cacheSessionLookup(cache, key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > SESSION_LOOKUP_CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function configuredRoots(env = process.env) {
  const records = require('./accounts.js').list(env).filter((account) => account.agent === 'codex');
  return records.map((account) => {
    // In no-config compatibility mode honor the process's HOME (and test homes)
    // exactly as the old single-root scanner did.
    const configDir = account.builtIn && !account.managed ? path.join(os.homedir(), '.codex') : account.configDir;
    return { accountId: account.id, configDir };
  });
}

function recentDateDirs(configDir = path.join(os.homedir(), '.codex')) {
  const dirs = [];
  const now = new Date();
  // Rollout dirs are UTC-dated; local time (UTC-10) can lag a day behind, so
  // include tomorrow. Go back 90 days because RESUMED sessions append to the
  // rollout in their ORIGINAL date dir — a live session can sit in an old dir
  // (the per-file mtime filter in scan() keeps the window at 48h regardless).
  for (let daysAgo = -1; daysAgo <= 90; daysAgo += 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    dirs.push(path.join(configDir, 'sessions', year, month, day));
  }
  return dirs;
}

function readTail(file) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - TAIL_BYTES);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buffer, 0, length, start); } finally { fs.closeSync(fd); }
  let text = buffer.toString('utf8');
  if (start > 0) {
    const newline = text.indexOf('\n');
    text = newline === -1 ? '' : text.slice(newline + 1);
  }
  return text;
}

function readSessionMeta(file) {
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, HEAD_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buffer, 0, length, 0); } finally { fs.closeSync(fd); }
  const text = buffer.toString('utf8');
  const newline = text.indexOf('\n');
  const line = newline === -1 ? text : text.slice(0, newline);
  const record = JSON.parse(line);
  if (!record || record.type !== 'session_meta' || !record.payload) return null;
  return record.payload;
}

function loadTitles(configDir = path.join(os.homedir(), '.codex')) {
  const file = path.join(configDir, 'session_index.jsonl');
  let cached = indexCache.get(file);
  let stat;
  try { stat = fs.statSync(file); } catch {
    indexCache.delete(file);
    return new Map();
  }
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.titles;
  const titles = new Map();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record && typeof record.id === 'string' && typeof record.thread_name === 'string') {
        titles.set(record.id, record.thread_name);
      }
    }
  } catch {}
  cached = { mtimeMs: stat.mtimeMs, size: stat.size, titles };
  indexCache.set(file, cached);
  return titles;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item && ['input_text', 'output_text', 'text'].includes(item.type) && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n\n');
}

function recentText(file) {
  const messages = [];
  for (const line of readTail(file).split('\n')) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = record && record.payload;
    if (!payload || typeof payload !== 'object') continue;
    let role = '';
    let text = '';
    if (record.type === 'event_msg' && payload.type === 'user_message') {
      role = 'User';
      text = typeof payload.message === 'string' ? payload.message : '';
    } else if (record.type === 'event_msg' && payload.type === 'agent_message') {
      role = 'Assistant';
      text = typeof payload.message === 'string' ? payload.message : '';
    } else if (record.type === 'response_item' && payload.type === 'message') {
      role = payload.role === 'user' ? 'User' : payload.role === 'assistant' ? 'Assistant' : '';
      text = textOf(payload.content);
    }
    text = text.trim();
    if (role && text) messages.push(`${role}: ${text}`);
  }
  return messages.join('\n\n').slice(-6000);
}

function isChildSession(meta) {
  return Boolean(meta && (meta.originator === 'Claude Code' || meta.parent_thread_id
    || meta.thread_source === 'subagent' || meta.source?.subagent));
}

function isHeadlessSession(meta) {
  return meta?.source === 'exec' || meta?.originator === 'codex_exec';
}

function scanRollout(file, { includeChild = false, includeHeadless = false } = {}) {
  const meta = readSessionMeta(file);
  // Multi-agent rollouts share session_id with their parent, but id identifies
  // the actual thread. Children must never compete with the parent by mtime.
  if (!meta || (!includeChild && (isChildSession(meta) || (!includeHeadless && isHeadlessSession(meta))))) return null;
  const id = typeof meta.id === 'string' && meta.id ? meta.id : meta.session_id;
  if (typeof id !== 'string' || !id) return null;
  // A completion marker is written at the end of every finished turn. Default
  // open so a very large in-progress turn remains running even after its user
  // message has fallen outside the tail window.
  const out = { id, cwd: typeof meta.cwd === 'string' ? meta.cwd : '', lastUser: '', lastAssistant: '', endedTurn: false };
  const pending = new Map();
  let nonMetadata = false;
  for (const line of readTail(file).split('\n')) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type !== 'session_meta') nonMetadata = true;
    const payload = record && record.payload;
    if (!payload || typeof payload !== 'object') continue;
    if (((record.type === 'event_msg' && ['user_message', 'task_started'].includes(payload.type))
        || (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user'))
        && Number.isFinite(Date.parse(record.timestamp))) out.turnStartedAt = Date.parse(record.timestamp);
    if (((record.type === 'event_msg' && ['user_message', 'agent_message', 'task_started', 'task_complete', 'turn_aborted'].includes(payload.type))
        || (record.type === 'response_item' && ['message', 'function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output'].includes(payload.type)))
        && Number.isFinite(Date.parse(record.timestamp))) out.attentionAt = Date.parse(record.timestamp);
    if (record.type === 'event_msg') {
      if (payload.type === 'user_message' && typeof payload.message === 'string') {
        out.lastUser = payload.message;
        out.endedTurn = false;
        out.pendingQuestion = null;
      }
      else if (payload.type === 'agent_message' && typeof payload.message === 'string') out.lastAssistant = payload.message;
      else if (payload.type === 'task_started') out.endedTurn = false;
      else if (['task_complete', 'turn_aborted'].includes(payload.type)) out.endedTurn = true;
    } else if (record.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(payload.type)) {
      let input = {};
      try { input = JSON.parse(payload.arguments || payload.input || '{}'); } catch {}
      const name = String(payload.name || '');
      pending.set(payload.call_id, { name, waitingFor: sessionStatus.toolWaitReason(name, input) });
      out.endedTurn = false;
      if (/request_user_input(?:_async)?$/.test(name)) {
        const question = input.questions?.[0];
        if (question) out.pendingQuestion = {
          question: question.question || question.title || '',
          options: question.options?.map((option) => typeof option === 'string' ? option : option.label) || [],
          callId: payload.call_id, async: name.endsWith('_async'),
        };
      }
    } else if (record.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
      pending.delete(payload.call_id);
      if (out.pendingQuestion?.callId === payload.call_id && !out.pendingQuestion.async) out.pendingQuestion = null;
    } else if (record.type === 'response_item' && payload.type === 'message') {
      const text = textOf(payload.content);
      if (payload.role === 'user' && text) {
        out.lastUser = text;
        out.endedTurn = false;
        out.pendingQuestion = null;
      }
      else if (payload.role === 'assistant' && text) out.lastAssistant = text;
    }
  }
  // Starting the TUI can leave a metadata-only rollout without any submitted
  // turn. Only decide this from the complete file, never a truncated tail.
  if (!nonMetadata && fs.statSync(file).size <= TAIL_BYTES) {
    if (!includeHeadless && !includeChild) return null;
    out.endedTurn = true;
  }
  out.waitingFor = [...pending.values()].find((tool) => tool.waitingFor)?.waitingFor || null;
  out.toolRunning = pending.size > 0;
  out.pendingQuestion = scanQuestion(file);
  out.lastUserAt = questionCache.get(file)?.lastUserAt;
  out.turnStartedAt = questionCache.get(file)?.turnStartedAt || out.turnStartedAt;
  return out;
}

// An async question can outlive megabytes of subsequent tool output. Track its
// lifecycle across the full rollout, reading only appended bytes after startup.
function scanQuestion(file) {
  const stat = fs.statSync(file);
  let state = questionCache.get(file);
  if (!state || state.ino !== stat.ino || stat.size < state.offset
      || (stat.size === state.offset && stat.mtimeMs !== state.mtimeMs)) {
    state = { ino: stat.ino, offset: 0, tail: '', decoder: new StringDecoder('utf8'), question: null };
  }
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(TAIL_BYTES);
  try {
    while (state.offset < stat.size) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - state.offset), state.offset);
      if (!count) break;
      state.offset += count;
      const lines = (state.tail + state.decoder.write(buffer.subarray(0, count))).split('\n');
      state.tail = lines.pop();
      for (const line of lines) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        const p = row.payload;
        if (!p) continue;
        if (((row.type === 'event_msg' && ['user_message', 'task_started'].includes(p.type))
            || (row.type === 'response_item' && p.type === 'message' && p.role === 'user'))
            && Number.isFinite(Date.parse(row.timestamp))) state.turnStartedAt = Date.parse(row.timestamp);
        if ((row.type === 'event_msg' && p.type === 'user_message')
            || (row.type === 'response_item' && p.type === 'message' && p.role === 'user')) {
          state.question = null;
          // Track actual user events across the full file, even after a large
          // tool result pushes the request out of the rollout tail.
          const text = p.message || textOf(p.content);
          if (text && !/^\s*(?:\[keep\]|<(?:environment_context|user_instructions|system-reminder|task-notification|cross-session-message)\b|# AGENTS\.md)/i.test(text)
              && Number.isFinite(Date.parse(row.timestamp))) state.lastUserAt = Date.parse(row.timestamp);
        } else if (row.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type)
            && /request_user_input(?:_async)?$/.test(p.name || '')) {
          let input;
          try { input = JSON.parse(p.arguments || p.input || '{}'); } catch { continue; }
          const question = input?.questions?.[0];
          if (question) state.question = {
            question: question.question || question.title || '',
            options: question.options?.map((option) => typeof option === 'string' ? option : option.label) || [],
            callId: p.call_id, async: p.name.endsWith('_async'),
          };
        } else if (row.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(p.type)
            && state.question?.callId === p.call_id && !state.question.async) state.question = null;
      }
    }
  } finally { fs.closeSync(fd); }
  state.mtimeMs = stat.mtimeMs;
  cacheSessionLookup(questionCache, file, state);
  return state.question;
}

function sessionFromRollout(info, stat, title, now, accountId) {
  const ageMs = now - stat.mtimeMs;
  const lifecycle = require('./codex-lifecycle').state(process.env.KEEP_DIR || path.join(os.homedir(), 'keep'), info, now);
  return {
    id: info.id,
    kind: 'codex',
    accountId,
    project: info.cwd,
    title,
    lastUser: info.lastUser.slice(0, 300),
    lastUserAt: info.lastUserAt,
    turnStartedAt: info.turnStartedAt,
    lastAssistant: info.lastAssistant.slice(0, 300),
    lastAssistantFull: info.lastAssistant.slice(0, 12000),
    mtime: stat.mtimeMs,
    attentionAt: info.attentionAt,
    size: stat.size,
    endedTurn: info.endedTurn,
    pendingQuestion: info.pendingQuestion,
    waitingFor: info.waitingFor,
    toolRunning: info.toolRunning,
    ...lifecycle,
    askedProse: sessionStatus.proseRequest(info.lastAssistant),
    state: info.endedTurn ? (ageMs < 3600e3 ? 'idle' : 'recent') : 'running',
  };
}

function scan() {
  const candidatesById = new Map();
  const nextRolloutFiles = new Map();
  const now = Date.now();
  const seen = new Set();
  for (const root of configuredRoots()) {
    const titles = loadTitles(root.configDir);
    for (const dir of recentDateDirs(root.configDir)) {
      let files;
      try { files = fs.readdirSync(dir).filter((name) => /^rollout-.*\.jsonl$/.test(name)); } catch { continue; }
      for (const name of files) {
        const file = path.join(dir, name);
        let stat;
        try { stat = fs.statSync(file); } catch { continue; }
        if (!stat.isFile() || now - stat.mtimeMs > SESSION_WINDOW_MS) continue;
        seen.add(file);
        let info;
        const cached = scanCache.get(file);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          info = cached.info;
        } else {
          try { info = scanRollout(file); } catch { continue; }
          scanCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, info });
        }
        if (!info) continue;
        const title = titles.get(info.id) || '';
        if (title.startsWith('Codex Companion Task:')) continue;
        const candidate = { file, accountId: root.accountId, configDir: root.configDir,
          session: sessionFromRollout(info, stat, title, now, root.accountId) };
        const list = candidatesById.get(info.id) || [];
        list.push(candidate);
        candidatesById.set(info.id, list);
      }
    }
  }
  for (const file of scanCache.keys()) if (!seen.has(file)) scanCache.delete(file);
  const sessions = [];
  for (const [id, candidates] of candidatesById) {
    let pinned = null;
    try { pinned = require('./accounts.js').forSession(id, 'codex', {
      root: process.env.KEEP_DIR || path.join(os.homedir(), 'keep'), allowDiscovery: false,
    }); } catch { continue; }
    const eligible = pinned ? candidates.filter((entry) => entry.accountId === pinned.id) : candidates;
    if (!pinned && new Set(eligible.map((entry) => entry.accountId)).size > 1) continue;
    eligible.sort((a, b) => b.session.mtime - a.session.mtime);
    const chosen = eligible[0];
    if (!chosen) continue;
    nextRolloutFiles.set(id, chosen);
    sessions.push(chosen.session);
  }
  rolloutFiles = nextRolloutFiles;
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

// Locate a rollout by session id without reading any file: the id is embedded in
// the filename. rolloutFileFor() only knows sessions that a prior scan() walked, so
// CLI callers (which never scan) must use this instead.
function findRolloutRecord(sessionId) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId || ''))) return null;
  const suffix = `-${sessionId}.jsonl`;
  let pinned = null;
  try { pinned = require('./accounts.js').forSession(sessionId, 'codex', {
    root: process.env.KEEP_DIR || path.join(os.homedir(), 'keep'), allowDiscovery: false,
  }); } catch { return null; }
  const matches = [];
  for (const root of configuredRoots()) {
    if (pinned && root.accountId !== pinned.id) continue;
    for (const dir of recentDateDirs(root.configDir)) {
      let names;
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.startsWith('rollout-') || !name.endsWith(suffix)) continue;
        const file = path.join(dir, name);
        try {
          const stat = fs.statSync(file);
          if (stat.isFile()) matches.push({ file, mtimeMs: stat.mtimeMs, accountId: root.accountId, configDir: root.configDir });
        } catch {}
      }
    }
  }
  if (!pinned && new Set(matches.map((entry) => entry.accountId)).size > 1) return null;
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0] || null;
}

function findRolloutFile(sessionId) {
  return findRolloutRecord(sessionId)?.file || null;
}

function sessionMetaFor(sessionId) {
  try {
    const file = findRolloutFile(sessionId);
    return file ? readSessionMeta(file) : null;
  } catch { return null; }
}

function rolloutFileFor(sessionId) {
  return rolloutFiles.get(String(sessionId || ''))?.file || null;
}

function sessionFor(sessionId) {
  const id = String(sessionId || '');
  let record = rolloutFiles.get(id) || sessionPathCache.get(id) || null;
  let file = record && record.file;
  const roots = new Map(configuredRoots().map((root) => [root.accountId, root]));
  let pinned = null;
  try { pinned = require('./accounts.js').forSession(id, 'codex', {
    root: process.env.KEEP_DIR || path.join(os.homedir(), 'keep'), allowDiscovery: false,
  }); } catch { return null; }
  if (record && (!roots.has(record.accountId) || (pinned && pinned.id !== record.accountId))) {
    sessionPathCache.delete(id);
    record = null;
    file = null;
  }
  let stat;
  if (file) {
    try { stat = fs.statSync(file); } catch {
      sessionPathCache.delete(id);
      sessionParseCache.delete(file);
      file = null;
    }
    if (file && !stat.isFile()) {
      sessionPathCache.delete(id);
      sessionParseCache.delete(file);
      file = null;
    }
  }
  if (!file) {
    record = findRolloutRecord(id);
    file = record && record.file;
    if (!record || !file) return null;
    try { stat = fs.statSync(file); } catch { return null; }
    if (!stat.isFile()) return null;
    cacheSessionLookup(sessionPathCache, id, record);
  }
  let info;
  const cached = sessionParseCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    info = cached.info;
  } else {
    // An explicitly hosted/resumed exec-origin conversation is now interactive.
    // Only fleet discovery excludes headless jobs; exact lookup keeps its history.
    info = scanRollout(file, { includeHeadless: true });
    cacheSessionLookup(sessionParseCache, file, { mtimeMs: stat.mtimeMs, size: stat.size, info });
  }
  if (!info) return null;
  return sessionFromRollout(info, stat, loadTitles(record.configDir).get(info.id) || '', Date.now(), record.accountId);
}

module.exports = { scan, scanRollout, sessionFor, rolloutFileFor, findRolloutFile, readTail, recentText, readSessionMeta, sessionMetaFor, isChildSession, configuredRoots, recentDateDirs };
