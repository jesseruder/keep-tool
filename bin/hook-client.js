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
//   ~/.keep-node/hook.log            what the queue dropped, and why.
//
// An event is delivered against the transcript as it stood when the event fired:
// its generation and size are taken first, and the delta in front of it stops at
// that size, whenever it is sent. A replay therefore shows the daemon the mirror
// that event saw, never a later turn's bytes (the next event sends those), and an
// entry whose transcript was replaced since is dropped.
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
function logFile(env) { return path.join(stateDir(env), 'hook.log'); }
const LOG_MAX_BYTES = 1024 * 1024;

// One line to ~/.keep-node/hook.log, the file cut short when it grows past 1 MiB.
function logLine(env, text) {
  try {
    const file = logFile(env);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try { if (fs.statSync(file).size > LOG_MAX_BYTES) fs.truncateSync(file, 0); } catch {}
    fs.appendFileSync(file, `${new Date().toISOString()} ${text}\n`, { mode: 0o600 });
  } catch {}
}

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

// The transcript as it stands now: what an event fired against. null when there is
// no transcript to send.
function snapshotOf(transcriptPath) {
  const stat = transcriptStat(transcriptPath);
  return stat ? { generation: generationOf(stat), size: stat.size, mtimeMs: stat.mtimeMs } : null;
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

// Delivers one event, with the transcript delta in front of it, up to `snapshot`:
// the transcript's { generation, size, mtimeMs } when the event fired (null: it had
// none, and none is sent). Resolves { ok: true, value } with the daemon's answer, or
// { ok: false, retry, why } where `retry` says whether a later resend could succeed;
// `stale` says the transcript was replaced since the event fired.
async function deliver({ event, input, identity, key, transcriptPath, snapshot, deadline, where, token, env, deps }) {
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
    const stat = snapshot ? transcriptStat(transcriptPath) : null;
    let plan = null;
    if (snapshot) {
      const generation = stat ? generationOf(stat) : null;
      if (generation !== snapshot.generation) {
        return { ok: false, retry: false, stale: true, why: 'the transcript was replaced after the event fired' };
      }
      const cursor = readCursor(env, sid);
      if (from === null) from = cursor && cursor.generation === generation && cursor.sent <= stat.size ? cursor.sent : 0;
      if (from > stat.size) from = 0;
      // `size` is the source's size now, so a mirror that is ahead is never taken
      // for a truncated source; the bytes stop where the event saw the file end.
      const end = Math.min(stat.size, snapshot.size);
      plan = { generation, size: stat.size, end, mtimeMs: end === snapshot.size ? snapshot.mtimeMs : stat.mtimeMs, path: transcriptPath };
      // The mirror already holds more than this event saw (another hook sent it):
      // the event goes without bytes, and the mirror is left as it is.
      if (from > end) plan = null;
    }
    const piece = (start, end) => ({
      path: plan.path, generation: plan.generation, fromOffset: start, size: plan.size, mtimeMs: plan.mtimeMs,
      bytes: readRange(plan.path, start, end).toString('base64'),
    });
    const advance = (sent) => { try { writeAtomic(cursorFile(env, sid), { generation: plan.generation, sent }); } catch {} };
    let response;
    try {
      // Every chunk of a long delta but the last goes on its own.
      while (plan && plan.end - from > CHUNK_BYTES) {
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
      response = await send({ event, input, identity, transcript: plan ? piece(from, plan.end) : null, idempotencyKey: key });
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
      if (plan) advance(plan.end);
      return { ok: response.status === 200, retry: false, value, why: response.status === 504 ? 'the daemon stopped the hook' : '' };
    }
    return { ok: false, retry: response.status >= 500, why: value.error || `HTTP ${response.status}` };
  }
}

function queueFiles(env) {
  try { return fs.readdirSync(queueDir(env)).filter((name) => /^\d{16}\.json$/.test(name)).sort(); } catch { return []; }
}

// Kept for later, oldest dropped past QUEUE_MAX. The transcript bytes are not kept,
// only where the transcript ended when the event fired: a replay sends what the
// mirror is missing up to there, and no further.
function enqueue(env, entry) {
  const dir = queueDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const counter = path.join(stateDir(env), 'hook-queue.seq');
  const names = queueFiles(env);
  const last = names.length ? Number(names.at(-1).slice(0, 16)) : 0;
  let seq = Math.max(last, Number(readJson(counter)) || 0) + 1;
  // Two hooks may enqueue at once and pick the same number. The entry is written
  // aside and linked into place, which fails when the name is taken (and never
  // shows a replay a half-written file); the loser takes the next number.
  const temp = path.join(stateDir(env), `hook-queue.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const queuedAt = new Date().toISOString();
  try {
    for (let attempt = 0; ; attempt += 1) {
      fs.writeFileSync(temp, `${JSON.stringify({ seq, ...entry, queuedAt })}\n`, { mode: 0o600 });
      try {
        fs.linkSync(temp, path.join(dir, `${String(seq).padStart(16, '0')}.json`));
        break;
      } catch (error) {
        if (error.code !== 'EEXIST' || attempt >= QUEUE_MAX) throw error;
        seq += 1;
      }
    }
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
  try { writeAtomic(counter, Math.max(seq, Number(readJson(counter)) || 0)); } catch {}
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
      transcriptPath: entry.body.transcriptPath, snapshot: entry.body.transcript || null, deadline, where, token, env, deps,
    });
    if (!result.ok && result.retry) break;
    if (result.stale) {
      logLine(env, `dropped queued ${entry.event} for session ${entry.body.identity.sessionId} (seq ${entry.seq}): ${result.why}`);
    }
    try { fs.unlinkSync(file); } catch {}
    sent += 1;
  }
  return sent;
}

// Removes a session's queued events. A session's end is the last thing it sends:
// a start or a stop replayed after it would bind or mark a session that is gone.
function dropSession(env, sessionId) {
  let dropped = 0;
  for (const name of queueFiles(env)) {
    const file = path.join(queueDir(env), name);
    const entry = readJson(file);
    if (!entry || !entry.body || !entry.body.identity || entry.body.identity.sessionId !== sessionId) continue;
    try { fs.unlinkSync(file); dropped += 1; } catch {}
    logLine(env, `dropped queued ${entry.event} for session ${sessionId} (seq ${entry.seq}): the session ended`);
  }
  return dropped;
}

// One hook event, delivered. Resolves null when this event is not carried (the
// caller keeps today's behaviour), else { delivered, value?, why? }.
async function runHook(event, input, where, deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  if (!EVENTS.includes(event) || env.KEEP_RUN) return null;
  if (!input || typeof input !== 'object' || typeof input.session_id !== 'string' || !SESSION_RE.test(input.session_id)) return null;
  const started = now();
  // First, before any wait: the transcript as this event saw it.
  const snapshot = snapshotOf(input.transcript_path);
  const budget = (deps.budgets || BUDGET_MS)[event];
  const deadline = started + budget;
  const identity = identityOf(input, env, where);
  const key = newKey();
  const fired = { snapshot, firedAt: Date.now() };
  if (event === 'session-end') dropSession(env, input.session_id);
  let token;
  try {
    require('./remote-cli.js').daemonBase(where.url);
    token = deps.token || require('./remote-cli.js').nodeToken(env, deps.readToken);
  } catch (error) {
    return { delivered: false, why: error.message, queued: queue(event, input, identity, key, fired, env) };
  }
  // What an earlier event could not deliver goes first, so the daemon sees them in
  // order; never more than half this event's own wait.
  try {
    await replayQueue({ env, where, token, deadline: Math.min(started + REPLAY_MS, started + budget / 2), deps });
  } catch {}
  const result = await deliver({ event, input, identity, key, transcriptPath: input.transcript_path, snapshot, deadline, where, token, env, deps });
  if (result.ok) return { delivered: true, value: result.value };
  // A hook the daemon stopped has run and been journalled: a resend would only
  // replay it. Anything else it answered is a refusal a resend would repeat.
  return { delivered: false, why: result.why, queued: result.retry ? queue(event, input, identity, key, fired, env) : false };
}

function queue(event, input, identity, key, fired, env) {
  if (!QUEUED.has(event)) return false;
  // A stop delivered late cannot hold a turn that has already ended: replayed with
  // stop_hook_active it never blocks, because the evaluator returns before it scans,
  // so the turn's evidence is left for the next live stop to judge. What the replay
  // does write is the completion marker, stamped with `firedAt`, and the turn index.
  const replayInput = event === 'stop' ? { ...input, stop_hook_active: true } : input;
  try {
    enqueue(env, { event, body: {
      input: replayInput, identity: { ...identity, firedAt: fired.firedAt }, idempotencyKey: key,
      transcriptPath: input.transcript_path, transcript: fired.snapshot,
    } });
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
  runHook, deliver, replayQueue, enqueue, dropSession, report, generationOf, snapshotOf, stateDir, queueDir, cursorFile, logFile,
  EVENTS, BUDGET_MS, QUEUE_MAX, CHUNK_BYTES,
};
