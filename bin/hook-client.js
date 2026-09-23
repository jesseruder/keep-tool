'use strict';
// A Claude hook on a pane-only node that knows where its daemon is.
//
// The node posts the event to the daemon's POST /api/hook (bin/hook-route.js) with
// the transcript bytes the daemon's mirror does not have yet, and prints what the
// daemon's own `keep hook <event>` printed. Nothing here reads or writes a registry:
// what this node keeps is under ~/.keep-node, and it is only delivery state.
//
//   ~/.keep-node/mirror/<sid>.json   { generation, sent }: how much of this
//                                    session's transcript the daemon has.
//   ~/.keep-node/hook-queue/<seq>.json  events that could not be delivered, replayed
//                                    in order, with their own keys, before the next post.
//
// Every wait is bounded per event, because Claude waits on the hook. A daemon that
// does not answer in time gets each event's safe default: a stop is let through, a
// question is allowed, a session start says it is unmanaged.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EVENTS = ['session-start', 'session-end', 'stop', 'notification', 'pre-question', 'lifecycle'];
const BUDGET_MS = Object.freeze({
  'session-start': 8000, 'session-end': 2000, stop: 10000, notification: 3000, lifecycle: 3000, 'pre-question': 3000,
});
// What is worth delivering late. A question's moment has passed, and a session's end
// is answered by the pane release this node does itself.
const QUEUED = new Set(['session-start', 'stop', 'notification', 'lifecycle']);
const QUEUE_MAX = 200;
const REPLAY_MS = 5000;
const CHUNK_BYTES = 4 * 1024 * 1024;
const NEED_FROM_RETRIES = 3;
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ACCOUNT_RE = /^(?:[a-z0-9][a-z0-9_-]{0,63}|(?:claude|codex|pi)\/default)$/;

function stateDir(env = process.env) { return path.join(env.HOME || os.homedir(), '.keep-node'); }
function cursorFile(env, sid) { return path.join(stateDir(env), 'mirror', `${sid}.json`); }
function queueDir(env) { return path.join(stateDir(env), 'hook-queue'); }

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readCursor(env, sid) {
  const value = readJson(cursorFile(env, sid));
  return value && typeof value.generation === 'string' && Number.isSafeInteger(value.sent) && value.sent >= 0 ? value : null;
}

// The source file's identity. Not its ctime, which every append changes: the inode,
// its device and its birth time name one file for as long as it exists.
function generationOf(stat) {
  return `${stat.dev}:${stat.ino}:${Math.round(stat.birthtimeMs || 0)}`;
}

function transcriptStat(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !path.isAbsolute(transcriptPath)) return null;
  try {
    const stat = fs.statSync(transcriptPath);
    return stat.isFile() ? stat : null;
  } catch { return null; }
}

function readRange(file, from, to) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(to - from);
    let got = 0;
    while (got < buffer.length) {
      const n = fs.readSync(fd, buffer, got, buffer.length - got, from + got);
      if (!n) break;
      got += n;
    }
    return buffer.subarray(0, got);
  } finally { fs.closeSync(fd); }
}

function identityOf(input, env, where) {
  const nodes = require('./nodes.js');
  const identity = { agent: 'claude', sessionId: input.session_id };
  if (env.KEEP_PANE) identity.pane = nodes.formatPaneRef(where.local, env.KEEP_PANE, env);
  if (ACCOUNT_RE.test(env.KEEP_AGENT_ACCOUNT_ID || '')) identity.accountId = env.KEEP_AGENT_ACCOUNT_ID;
  return identity;
}

function newKey() { return crypto.randomBytes(16).toString('hex'); }

function parsed(response) {
  try { return JSON.parse(response.data); } catch { return null; }
}

// Delivers one event, with the transcript delta in front of it. Resolves
// { ok: true, value } with the daemon's answer, or { ok: false, retry, why } where
// `retry` says whether a later resend could succeed.
async function deliver({ event, input, identity, key, transcriptPath, deadline, where, token, env, deps }) {
  const request = deps.request || require('./remote-cli.js').nodeApiRequest;
  const now = deps.now || Date.now;
  const sid = identity.sessionId;
  const send = async (payload) => {
    const left = deadline - now();
    if (left <= 0) throw new Error('out of time');
    return request(where.url, '/api/hook', { payload, token, timeoutMs: left });
  };
  let resends = 0;
  let from = null;
  for (;;) {
    const stat = transcriptStat(transcriptPath);
    let plan = null;
    if (stat) {
      const generation = generationOf(stat);
      const cursor = readCursor(env, sid);
      if (from === null) from = cursor && cursor.generation === generation && cursor.sent <= stat.size ? cursor.sent : 0;
      if (from > stat.size) from = 0;
      plan = { generation, size: stat.size, mtimeMs: stat.mtimeMs, path: transcriptPath };
    }
    const piece = (start, end) => ({
      path: plan.path, generation: plan.generation, fromOffset: start, size: plan.size, mtimeMs: plan.mtimeMs,
      bytes: readRange(plan.path, start, end).toString('base64'),
    });
    const advance = (sent) => { try { writeAtomic(cursorFile(env, sid), { generation: plan.generation, sent }); } catch {} };
    let response;
    try {
      // Every chunk of a long delta but the last goes on its own.
      while (plan && plan.size - from > CHUNK_BYTES) {
        const chunk = await send({ event: 'transcript', identity, transcript: piece(from, from + CHUNK_BYTES) });
        const value = parsed(chunk) || {};
        if (chunk.status === 200) { from += CHUNK_BYTES; advance(from); continue; }
        if (chunk.status === 409 && Number.isSafeInteger(value.needFrom) && resends < NEED_FROM_RETRIES) {
          resends += 1;
          from = value.needFrom;
          continue;
        }
        return { ok: false, retry: chunk.status >= 500, why: value.error || `HTTP ${chunk.status}` };
      }
      response = await send({ event, input, identity, transcript: plan ? piece(from, plan.size) : null, idempotencyKey: key });
    } catch (error) {
      return { ok: false, retry: true, why: error.message };
    }
    const value = parsed(response) || {};
    if (response.status === 409 && Number.isSafeInteger(value.needFrom) && resends < NEED_FROM_RETRIES) {
      resends += 1;
      from = value.needFrom;
      continue;
    }
    if ((response.status === 200 || response.status === 504) && Number.isInteger(value.status)) {
      if (plan) advance(plan.size);
      return { ok: response.status === 200, retry: false, value, why: response.status === 504 ? 'the daemon stopped the hook' : '' };
    }
    return { ok: false, retry: response.status >= 500, why: value.error || `HTTP ${response.status}` };
  }
}

function queueFiles(env) {
  try { return fs.readdirSync(queueDir(env)).filter((name) => /^\d{16}\.json$/.test(name)).sort(); } catch { return []; }
}

// Kept for later, oldest dropped past QUEUE_MAX. The transcript bytes are not kept:
// a replay sends whatever the mirror is missing when it runs.
function enqueue(env, entry) {
  const dir = queueDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const counter = path.join(stateDir(env), 'hook-queue.seq');
  const names = queueFiles(env);
  const last = names.length ? Number(names.at(-1).slice(0, 16)) : 0;
  const seq = Math.max(last, Number(readJson(counter)) || 0) + 1;
  writeAtomic(counter, seq);
  writeAtomic(path.join(dir, `${String(seq).padStart(16, '0')}.json`), { seq, ...entry, queuedAt: new Date().toISOString() });
  const all = queueFiles(env);
  for (const name of all.slice(0, Math.max(0, all.length - QUEUE_MAX))) { try { fs.unlinkSync(path.join(dir, name)); } catch {} }
}

// Replays the queue in order until it is empty, the daemon stops answering, or the
// time is up. An entry the daemon answered, or refused for good, is removed.
async function replayQueue({ env, where, token, deadline, deps }) {
  const now = deps.now || Date.now;
  let sent = 0;
  for (const name of queueFiles(env)) {
    if (now() >= deadline) break;
    const file = path.join(queueDir(env), name);
    const entry = readJson(file);
    if (!entry || !EVENTS.includes(entry.event) || !entry.body || !entry.body.identity) { try { fs.unlinkSync(file); } catch {} continue; }
    const result = await deliver({
      event: entry.event, input: entry.body.input, identity: entry.body.identity, key: entry.body.idempotencyKey,
      transcriptPath: entry.body.transcriptPath, deadline, where, token, env, deps,
    });
    if (!result.ok && result.retry) break;
    try { fs.unlinkSync(file); } catch {}
    sent += 1;
  }
  return sent;
}

// One hook event, delivered. Resolves null when this event is not carried (the
// caller keeps today's behaviour), else { delivered, value?, why? }.
async function runHook(event, input, where, deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  if (!EVENTS.includes(event) || env.KEEP_RUN) return null;
  if (!input || typeof input !== 'object' || typeof input.session_id !== 'string' || !SESSION_RE.test(input.session_id)) return null;
  const started = now();
  const budget = (deps.budgets || BUDGET_MS)[event];
  const deadline = started + budget;
  const identity = identityOf(input, env, where);
  const key = newKey();
  let token;
  try {
    require('./remote-cli.js').daemonBase(where.url);
    token = deps.token || require('./remote-cli.js').nodeToken(env, deps.readToken);
  } catch (error) {
    return { delivered: false, why: error.message, queued: queue(event, input, identity, key, env) };
  }
  // What an earlier event could not deliver goes first, so the daemon sees them in
  // order; never more than half this event's own wait.
  try {
    await replayQueue({ env, where, token, deadline: Math.min(started + REPLAY_MS, started + budget / 2), deps });
  } catch {}
  const result = await deliver({ event, input, identity, key, transcriptPath: input.transcript_path, deadline, where, token, env, deps });
  if (result.ok) return { delivered: true, value: result.value };
  // A hook the daemon stopped has run and been journalled: a resend would only
  // replay it. Anything else it answered is a refusal a resend would repeat.
  return { delivered: false, why: result.why, queued: result.retry ? queue(event, input, identity, key, env) : false };
}

function queue(event, input, identity, key, env) {
  if (!QUEUED.has(event)) return false;
  // A stop delivered late cannot hold a turn that has already ended; replayed, it
  // records the turn and never nags.
  const replayInput = event === 'stop' ? { ...input, stop_hook_active: true } : input;
  try {
    enqueue(env, { event, body: { input: replayInput, identity, idempotencyKey: key, transcriptPath: input.transcript_path } });
    return true;
  } catch { return false; }
}

// For `keep doctor` on a node: how much is waiting, and the newest cursor.
function report(env = process.env) {
  const queued = queueFiles(env).length;
  let newest = null;
  const dir = path.join(stateDir(env), 'mirror');
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')); } catch {}
  for (const name of names) {
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { session: name.slice(0, -5), mtimeMs: stat.mtimeMs, ...(readJson(path.join(dir, name)) || {}) };
    } catch {}
  }
  return { queued, newest };
}

module.exports = {
  runHook, deliver, replayQueue, enqueue, report, generationOf, stateDir, queueDir, cursorFile,
  EVENTS, BUDGET_MS, QUEUE_MAX, CHUNK_BYTES,
};
