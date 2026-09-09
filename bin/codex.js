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
const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const SESSION_INDEX = path.join(os.homedir(), '.codex', 'session_index.jsonl');

const scanCache = new Map(); // file -> { mtimeMs, size, info }
const sessionPathCache = new Map(); // session id -> rollout file
const sessionParseCache = new Map(); // file -> { mtimeMs, size, info }
const questionCache = new Map(); // incremental question lifecycle, independent of the text tail
const SESSION_LOOKUP_CACHE_LIMIT = 300;
let indexCache = { mtimeMs: null, size: null, titles: new Map() };
let rolloutFiles = new Map(); // session id -> rollout file, replaced after each scan

function cacheSessionLookup(cache, key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > SESSION_LOOKUP_CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function recentDateDirs() {
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
    dirs.push(path.join(SESSIONS_DIR, year, month, day));
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

function loadTitles() {
  let stat;
  try { stat = fs.statSync(SESSION_INDEX); } catch {
    indexCache = { mtimeMs: null, size: null, titles: new Map() };
    return indexCache.titles;
  }
  if (indexCache.mtimeMs === stat.mtimeMs && indexCache.size === stat.size) return indexCache.titles;
  const titles = new Map();
  try {
    for (const line of fs.readFileSync(SESSION_INDEX, 'utf8').split('\n')) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record && typeof record.id === 'string' && typeof record.thread_name === 'string') {
        titles.set(record.id, record.thread_name);
      }
    }
  } catch {}
  indexCache = { mtimeMs: stat.mtimeMs, size: stat.size, titles };
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

function scanRollout(file) {
  const meta = readSessionMeta(file);
  if (!meta || typeof meta.session_id !== 'string' || meta.originator === 'Claude Code') return null;
  // A completion marker is written at the end of every finished turn. Default
  // open so a very large in-progress turn remains running even after its user
  // message has fallen outside the tail window.
  const out = { id: meta.session_id, cwd: typeof meta.cwd === 'string' ? meta.cwd : '', lastUser: '', lastAssistant: '', endedTurn: false };
  const pending = new Map();
  for (const line of readTail(file).split('\n')) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = record && record.payload;
    if (!payload || typeof payload !== 'object') continue;
    if (record.type === 'event_msg') {
      if (payload.type === 'user_message' && typeof payload.message === 'string') {
        out.lastUser = payload.message;
        out.endedTurn = false;
        out.pendingQuestion = null;
      }
      else if (payload.type === 'agent_message' && typeof payload.message === 'string') out.lastAssistant = payload.message;
      else if (payload.type === 'task_started') out.endedTurn = false;
      else if (payload.type === 'task_complete') out.endedTurn = true;
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
  out.waitingFor = [...pending.values()].find((tool) => tool.waitingFor)?.waitingFor || null;
  out.toolRunning = pending.size > 0;
  out.pendingQuestion = scanQuestion(file);
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
        if ((row.type === 'event_msg' && p.type === 'user_message')
            || (row.type === 'response_item' && p.type === 'message' && p.role === 'user')) {
          state.question = null;
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

function sessionFromRollout(info, stat, title, now) {
  const ageMs = now - stat.mtimeMs;
  return {
    id: info.id,
    kind: 'codex',
    project: info.cwd,
    title,
    lastUser: info.lastUser.slice(0, 300),
    lastAssistant: info.lastAssistant.slice(0, 300),
    lastAssistantFull: info.lastAssistant.slice(0, 12000),
    mtime: stat.mtimeMs,
    size: stat.size,
    endedTurn: info.endedTurn,
    pendingQuestion: info.pendingQuestion,
    waitingFor: info.waitingFor,
    toolRunning: info.toolRunning,
    askedProse: sessionStatus.proseRequest(info.lastAssistant),
    state: info.endedTurn ? (ageMs < 3600e3 ? 'idle' : 'recent') : 'running',
  };
}

function scan() {
  const sessionsById = new Map();
  const nextRolloutFiles = new Map();
  const now = Date.now();
  const titles = loadTitles();
  const seen = new Set();
  for (const dir of recentDateDirs()) {
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
      if (sessionsById.has(info.id) && sessionsById.get(info.id).mtime >= stat.mtimeMs) continue;
      nextRolloutFiles.set(info.id, file);
      sessionsById.set(info.id, sessionFromRollout(info, stat, title, now));
    }
  }
  for (const file of scanCache.keys()) if (!seen.has(file)) scanCache.delete(file);
  rolloutFiles = nextRolloutFiles;
  const sessions = [...sessionsById.values()];
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

// Locate a rollout by session id without reading any file: the id is embedded in
// the filename. rolloutFileFor() only knows sessions that a prior scan() walked, so
// CLI callers (which never scan) must use this instead.
function findRolloutFile(sessionId) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId || ''))) return null;
  const suffix = `-${sessionId}.jsonl`;
  let newest = null;
  let newestMtime = -Infinity;
  for (const dir of recentDateDirs()) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith(suffix)) continue;
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile() && stat.mtimeMs > newestMtime) { newest = file; newestMtime = stat.mtimeMs; }
      } catch {}
    }
  }
  return newest;
}

function sessionMetaFor(sessionId) {
  try {
    const file = findRolloutFile(sessionId);
    return file ? readSessionMeta(file) : null;
  } catch { return null; }
}

function rolloutFileFor(sessionId) {
  return rolloutFiles.get(String(sessionId || '')) || null;
}

function sessionFor(sessionId) {
  const id = String(sessionId || '');
  let file = rolloutFiles.get(id) || sessionPathCache.get(id) || null;
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
    file = findRolloutFile(id) || rolloutFileFor(id);
    if (!file) return null;
    try { stat = fs.statSync(file); } catch { return null; }
    if (!stat.isFile()) return null;
    cacheSessionLookup(sessionPathCache, id, file);
  }
  let info;
  const cached = sessionParseCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    info = cached.info;
  } else {
    info = scanRollout(file);
    cacheSessionLookup(sessionParseCache, file, { mtimeMs: stat.mtimeMs, size: stat.size, info });
  }
  if (!info) return null;
  return sessionFromRollout(info, stat, loadTitles().get(info.id) || '', Date.now());
}

module.exports = { scan, scanRollout, sessionFor, rolloutFileFor, findRolloutFile, readTail, recentText, readSessionMeta, sessionMetaFor };
