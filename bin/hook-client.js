'use strict';
// A Claude, Codex or Pi hook on a pane-only node that knows where its daemon is.
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
//   ~/.keep-node/hook-queue.state.json  { stalled: { <sid>: at } }: the sessions whose
//                                    entries a replay could not deliver; they go last
//                                    in the next replays, for an hour at most.
//   ~/.keep-node/link.json           { bytesPerSec, at }: how fast transcript chunks
//                                    have reached the daemon, which sizes the next
//                                    ones; an hour old, it is no longer believed.
//   ~/.keep-node/hook.log            what the queue dropped, and why.
//   ~/.keep-node/hook-context.json   { at, steps, sessions: { <sid>: { repairSession, at } } }:
//                                    what GET /api/hook/context last said, asked
//                                    again after a minute and kept past it.
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

const CLAUDE_EVENTS = ['session-start', 'session-end', 'stop', 'notification', 'pre-question', 'lifecycle', 'pre-bash', 'post-bash'];
// A Codex session's hooks, `keep hook codex <action>` posted as `codex-<action>`.
const CODEX_EVENTS = ['codex-start', 'codex-end', 'codex-client-end', 'codex-stop', 'codex-question', 'codex-approval',
  'codex-complete', 'codex-lifecycle', 'codex-pre-tool', 'codex-post-tool'];
// A Pi session's hooks, `keep hook pi <action>` posted as `pi-<action>`: the three the
// Keep Pi extension (integrations/pi/keep.ts) calls. Pi keeps no transcript Keep reads
// through a hook, so none of them carries one.
const PI_EVENTS = ['pi-start', 'pi-end', 'pi-pre-tool'];
const EVENTS = [...CLAUDE_EVENTS, ...CODEX_EVENTS, ...PI_EVENTS];
// Codex kills a hook at the timeout its hooks.json gives it (3 s for start, end,
// question and approval; 10 s for stop; 5 s for lifecycle; 20 s for the tool hooks),
// and a killed hook prints nothing, so every Codex budget ends inside that timeout
// with room left for what the node does after the post (a start's pane bind).
const BUDGET_MS = Object.freeze({
  'session-start': 8000, 'session-end': 2000, stop: 10000, notification: 3000, lifecycle: 3000, 'pre-question': 3000,
  'pre-bash': 5000, 'post-bash': 3000,
  'codex-start': 2000, 'codex-end': 2000, 'codex-client-end': 3000, 'codex-stop': 9000, 'codex-question': 2500,
  'codex-approval': 2500, 'codex-complete': 2500, 'codex-lifecycle': 3000, 'codex-pre-tool': 5000, 'codex-post-tool': 3000,
  // The Pi extension kills its hook at 5 s and takes that as a failure (a pre-tool
  // failure blocks the call), so each budget leaves room for the node's own work after
  // it: a start's pane bind, a pre-tool's local guard when the daemon does not answer.
  'pi-start': 3000, 'pi-end': 2000, 'pi-pre-tool': 3000,
});
// The events whose post carries no transcript bytes: the daemon's hook for them
// reads the command and the repository facts, never the transcript, and a pre-bash
// stands in front of every command the session runs. A Codex post-tool does carry
// them: the daemon reads the command's exit code from the rollout.
const TRANSCRIPTLESS = new Set(['pre-bash', 'post-bash', 'codex-pre-tool', 'codex-client-end', ...PI_EVENTS]);
// What is worth delivering late. A question's moment has passed, and a session's end
// is answered by the pane release this node does itself. A post-bash only records
// (a deploy, a step run), so it is as good late; a pre-bash is not.
// A Pi start and end are: the daemon's pane record (and the released stamp a later
// /new or /resume in the same pane rebinds by) is written whenever they arrive.
const QUEUED = new Set(['session-start', 'stop', 'notification', 'lifecycle', 'post-bash',
  'codex-start', 'codex-stop', 'codex-approval', 'codex-complete', 'codex-lifecycle', 'codex-post-tool',
  'pi-start', 'pi-end']);
// The events that end a session: what it still has queued is dropped.
const ENDS = new Set(['session-end', 'codex-end', 'pi-end']);
const QUEUE_MAX = 200;
const REPLAY_MS = 5000;
// A long delta goes in chunks sized to the link, so that each one lands inside the
// time this event has left and every hook moves the cursor, however slow the link:
// a fixed 4 MiB chunk over a slow link never finished inside a 3 s hook, so the
// cursor never moved and the same bytes went up again with every hook. A chunk is
// half of what the measured rate carries in the time left (at most 2 s of it), never
// under CHUNK_MIN nor over CHUNK_MAX, the daemon's cap on one post's transcript bytes
// (bin/transcript-mirror.js POST_CAP_BYTES). Before any rate is known the link is
// taken to carry CHUNK_FIRST a second, which makes CHUNK_FIRST the largest chunk.
const CHUNK_MIN = 64 * 1024;
const CHUNK_MAX = 4 * 1024 * 1024;
const CHUNK_FIRST = 256 * 1024;
const CHUNK_BYTES = CHUNK_MAX;
const CHUNK_WINDOW_MS = 2000;
// A chunk is not started with less than this left: it could not land, and a post cut
// off by the deadline costs the link its bytes for nothing.
const CHUNK_FLOOR_MS = 300;
// A chunk measures the link only when it carried this much: a small one is all
// latency. The event's own post never does: its time includes the daemon running
// the hook, and a slow stop would shrink every later chunk.
const RATE_SAMPLE_BYTES = 64 * 1024;
const RATE_ALPHA = 0.5;
// A measurement this old says nothing about the link now.
const LINK_TTL_MS = 60 * 60 * 1000;
// A chunk's request waits a few times what the rate says its transfer takes (at least
// a second, never past the deadline), not the whole budget: a chunk too large for the
// link as it is now fails soon enough to leave the other sessions their time.
const CHUNK_TIMEOUT_FACTOR = 4;
const CHUNK_TIMEOUT_MIN_MS = 1000;
// A stall record older than this orders nothing: its session is long gone, or has
// long since had its chance to go first again.
const STALL_TTL_MS = 60 * 60 * 1000;
// The bound on asking the daemon how much of a transcript its mirror holds.
const MIRROR_ASK_MS = 1500;
const NEED_FROM_RETRIES = 3;
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
// The daemon's caps (bin/hook-route.js): the whole stdin object, and the fields it
// refuses past a length. What is longer is cut here, never refused there.
const INPUT_MAX_BYTES = 256 * 1024;
const TEXT_CAPS = Object.freeze({ last_assistant_message: 64 * 1024, message: 4096, title: 1024 });
// What the daemon's hook needs to run at all, never dropped to fit.
const KEPT_FIELDS = new Set(['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'stop_hook_active', 'permission_mode',
  'source', 'reason', 'notification_type', 'tool_name', 'agent_id', 'prompt_id', 'tool_use_id',
  'turn_id', 'call_id', 'client_token', 'repo_facts', 'instance', 'pid']);
const ACCOUNT_RE = /^(?:[a-z0-9][a-z0-9_-]{0,63}|(?:claude|codex|pi)\/default)$/;
// The session's own environment the daemon's hook reads, and the shape the daemon
// accepts for each (bin/hook-route.js FORWARDED_ENV). Nothing else is sent.
const FORWARDED_ENV = Object.freeze({
  KEEP_REVIEWER: /^(?:0|1|true|false)$/,
  KEEP_AUTO_CONTINUE: /^(?:0|1|true|false)$/,
  CLAUDE_CODE_ENTRYPOINT: /^[A-Za-z0-9_.-]{1,128}$/,
  KEEP_DELEGATION_ID: /^[A-Za-z0-9_-]{1,128}$/,
  KEEP_STEP_OK: /^[A-Za-z0-9_.-]{1,32}$/,
  KEEP_RAW_CLAUDE: /^[A-Za-z0-9_.-]{1,32}$/,
  KEEP_CODEX_CLIENT_TOKEN: /^[A-Za-z0-9._-]{1,128}$/,
  KEEP_CODEX_PARENT_SESSION: /^[A-Za-z0-9_-]{1,128}$/,
});

function stateDir(env = process.env) { return path.join(env.HOME || os.homedir(), '.keep-node'); }
function contextFile(env) { return path.join(stateDir(env), 'hook-context.json'); }
function cursorFile(env, sid) { return path.join(stateDir(env), 'mirror', `${sid}.json`); }
function queueDir(env) { return path.join(stateDir(env), 'hook-queue'); }
function logFile(env) { return path.join(stateDir(env), 'hook.log'); }
function linkFile(env) { return path.join(stateDir(env), 'link.json'); }
function replayStateFile(env) { return path.join(stateDir(env), 'hook-queue.state.json'); }
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

function identityOf(input, env, where, event) {
  const nodes = require('./nodes.js');
  const codex = CODEX_EVENTS.includes(event);
  const piEvent = PI_EVENTS.includes(event);
  const identity = { agent: codex ? 'codex' : piEvent ? 'pi' : 'claude' };
  if (typeof input.session_id === 'string') identity.sessionId = input.session_id;
  if (env.KEEP_PANE) identity.pane = nodes.formatPaneRef(where.local, env.KEEP_PANE, env);
  if (ACCOUNT_RE.test(env.KEEP_AGENT_ACCOUNT_ID || '')) identity.accountId = env.KEEP_AGENT_ACCOUNT_ID;
  // A Codex session started from a Claude one inherits the Claude session's id; the
  // daemon's hook reads it as the parent (recordCodexParent), under its own name.
  const source = codex && env.CLAUDE_CODE_SESSION_ID ? { ...env, KEEP_CODEX_PARENT_SESSION: env.CLAUDE_CODE_SESSION_ID } : env;
  const forwarded = {};
  for (const [key, re] of Object.entries(FORWARDED_ENV)) {
    if (!codex && key.startsWith('KEEP_CODEX_')) continue;
    // A Pi hook reads only the step guard's bypass and a delegation's id (its start
    // binds a delegated session, as on the daemon node) of its session's environment.
    if (piEvent && key !== 'KEEP_STEP_OK' && key !== 'KEEP_DELEGATION_ID') continue;
    if (typeof source[key] === 'string' && re.test(source[key])) forwarded[key] = source[key];
  }
  if (Object.keys(forwarded).length) identity.env = forwarded;
  return identity;
}

// A string cut to at most \`max\` UTF-8 bytes, on a character boundary.
function clipBytes(value, max) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= max) return value;
  let end = max;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));

// The stdin object cut to what the daemon accepts: the capped text fields
// truncated (a long final report is still a stop, and the daemon's hook reads only
// its first 12000 characters), then, while the whole is still too large, the
// largest other field dropped. The daemon's own caps stay refusals.
function fitInput(input) {
  const out = { ...input };
  for (const [key, max] of Object.entries(TEXT_CAPS)) {
    if (typeof out[key] === 'string') out[key] = clipBytes(out[key], max);
  }
  while (jsonBytes(out) > INPUT_MAX_BYTES) {
    let largest = null;
    for (const key of Object.keys(out)) {
      if (KEPT_FIELDS.has(key) || out[key] === undefined) continue;
      const size = jsonBytes(out[key]);
      if (!largest || size > largest.size) largest = { key, size };
    }
    if (!largest) break;
    delete out[largest.key];
  }
  return out;
}

// The link rate this node measured within the hour before `at`, in bytes a second,
// or null when none is known.
function readLinkRate(env, at) {
  const value = readJson(linkFile(env));
  if (!value || !Number.isFinite(value.bytesPerSec) || !(value.bytesPerSec > 0) || !Number.isFinite(value.at)) return null;
  return at - value.at < LINK_TTL_MS ? value.bytesPerSec : null;
}

function writeLinkRate(env, bytesPerSec, at) {
  try { writeAtomic(linkFile(env), { bytesPerSec: Math.max(1, Math.round(bytesPerSec)), at }); } catch {}
}

// A chunk that landed, its bytes and how long its request took, folded into the
// stored rate as a moving average: one slow or fast chunk moves it, and does not
// replace it.
function recordLinkRate(env, bytes, elapsedMs, at) {
  if (!(bytes >= RATE_SAMPLE_BYTES)) return;
  const sample = bytes / (Math.max(1, elapsedMs) / 1000);
  const stored = readLinkRate(env, at);
  writeLinkRate(env, stored ? RATE_ALPHA * sample + (1 - RATE_ALPHA) * stored : sample, at);
}

// A chunk that did not land. Its bytes over the time spent on it is more than the
// link carried, and a stored rate it failed under is at least twice too high: the
// lower of the two replaces the rate, so a link that slowed after a fast measurement
// brings the chunks down with it instead of timing every one of them out.
function recordLinkFailure(env, bytes, elapsedMs, at) {
  const seen = bytes / (Math.max(1, elapsedMs) / 1000);
  const stored = readLinkRate(env, at);
  writeLinkRate(env, stored ? Math.min(seen, stored / 2) : seen, at);
}

// How many transcript bytes one post may carry with `leftMs` left of the event's budget.
function chunkSize(env, leftMs, at = Date.now()) {
  const rate = readLinkRate(env, at);
  const size = Math.round((rate || CHUNK_FIRST) * (Math.min(Math.max(0, leftMs), CHUNK_WINDOW_MS) / 1000) * 0.5);
  return Math.min(rate ? CHUNK_MAX : CHUNK_FIRST, Math.max(CHUNK_MIN, size));
}

// How long one chunk of `bytes` may take, with `leftMs` left.
function chunkTimeout(env, bytes, leftMs, at = Date.now()) {
  const rate = readLinkRate(env, at) || CHUNK_FIRST;
  return Math.min(leftMs, Math.max(CHUNK_TIMEOUT_MIN_MS, Math.round(CHUNK_TIMEOUT_FACTOR * bytes / rate * 1000)));
}

function newKey() { return crypto.randomBytes(16).toString('hex'); }

function parsed(response) {
  try { return JSON.parse(response.data); } catch { return null; }
}

// Delivers one event, with the transcript delta in front of it, up to `snapshot`:
// the transcript's { generation, size, mtimeMs } when the event fired (null: it had
// none, and none is sent). Resolves { ok: true, value } with the daemon's answer, or
// { ok: false, retry, why } where `retry` says whether a later resend could succeed;
// `stale` says the transcript was replaced since the event fired, and `link` that the
// daemon did not answer at all (the request failed, or timed out).
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
  attempt: for (;;) {
    const stat = snapshot ? transcriptStat(transcriptPath) : null;
    let plan = null;
    if (snapshot) {
      const generation = stat ? generationOf(stat) : null;
      if (generation !== snapshot.generation) {
        return { ok: false, retry: false, stale: true, why: 'the transcript was replaced after the event fired' };
      }
      const cursor = readCursor(env, sid);
      if (from === null) {
        const usable = cursor && cursor.generation === generation && cursor.sent <= stat.size;
        from = usable ? cursor.sent : 0;
        // No cursor to go by (a fresh node home, a lost state directory) and more to
        // send than a first chunk: the daemon's mirror may already hold most of it,
        // so it is asked before the whole transcript goes up again.
        if (!usable && Math.min(stat.size, snapshot.size) > CHUNK_FIRST) {
          const held = await mirrorOffset({ request, where, token, sid, generation, size: stat.size,
            timeoutMs: Math.min(MIRROR_ASK_MS, deadline - now()) });
          if (held !== null) {
            from = held;
            try { writeAtomic(cursorFile(env, sid), { generation, sent: held }); } catch {}
          }
        }
      }
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
      // Every chunk of a long delta but the last goes on its own, each sized to what
      // the link carries in the time left. Each one that lands moves the cursor, so a
      // hook that runs out of time leaves the next hook to go on from there.
      while (plan) {
        const size = chunkSize(env, deadline - now(), now());
        if (plan.end - from <= size) break;
        const left = deadline - now();
        if (left < CHUNK_FLOOR_MS) return { ok: false, retry: true, why: 'out of time' };
        const timeoutMs = chunkTimeout(env, size, left, now());
        const began = now();
        let chunk;
        try {
          chunk = await request(where.url, '/api/hook', { payload: { event: 'transcript', identity, transcript: piece(from, from + size) }, token, timeoutMs });
        } catch (error) {
          recordLinkFailure(env, size, now() - began, now());
          // Cut off by its own bound with time still left: the chunk was too large for
          // the link as it is now. The next one is smaller; meanwhile a replay goes on
          // to other sessions, whose entries may be small enough to land.
          if (timeoutMs < left && /timed out/.test(error.message)) {
            return { ok: false, retry: true, why: `a chunk of ${size} bytes did not land in ${timeoutMs} ms` };
          }
          throw error;
        }
        const value = parsed(chunk) || {};
        if (chunk.status === 200) {
          recordLinkRate(env, size, now() - began, now());
          from += size;
          advance(from);
          continue;
        }
        if (chunk.status === 409 && Number.isSafeInteger(value.needFrom) && resends < NEED_FROM_RETRIES) {
          resends += 1;
          from = value.needFrom;
          // Planned again: the mirror may now hold more than this event saw.
          continue attempt;
        }
        return { ok: false, retry: chunk.status >= 500, why: value.error || `HTTP ${chunk.status}` };
      }
      // The event's own post, when it carries bytes, keeps the chunks' floor: cut off
      // at the deadline it would read as a daemon that does not answer.
      if (plan && plan.end > from && deadline - now() < CHUNK_FLOOR_MS) return { ok: false, retry: true, why: 'out of time' };
      response = await send({ event, input, identity, transcript: plan ? piece(from, plan.end) : null, idempotencyKey: key });
    } catch (error) {
      // The request itself failed: the daemon did not answer at all (refused, reset,
      // timed out), which `link` tells apart from a daemon that answered a failure.
      return { ok: false, retry: true, link: true, why: error.message };
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
    return { ok: false, retry: response.status >= 500, why: value.error || `HTTP ${response.status}`,
      ...(typeof value.code === 'string' ? { code: value.code } : {}) };
  }
}

// How much of this transcript generation the daemon's mirror holds, when it holds a
// prefix of it: its size, or null for anything else (another generation, no mirror,
// a daemon without the route, no answer in time).
async function mirrorOffset({ request, where, token, sid, generation, size, timeoutMs }) {
  if (!(timeoutMs > 0)) return null;
  try {
    const query = new URLSearchParams({ session: sid });
    const response = await request(where.url, `/api/hook/mirror?${query}`, { method: 'GET', token, timeoutMs });
    const value = response.status === 200 ? parsed(response) : null;
    if (value && value.generation === generation && Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= size) return value.size;
  } catch {}
  return null;
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

// Replays the queue until it is empty, the daemon stops answering, or the time is
// up. An entry the daemon answered, or refused for good, is removed.
//
// Each session's entries go in their order: an event never overtakes its own
// session's earlier ones. Sessions do not wait on each other. One whose entry could
// not be delivered (a transcript too large for the link, a daemon that refuses it for
// now) is recorded as stalled, and every stalled session goes last in the next
// replays (among themselves in queue order), so none of them can spend the others'
// replay time. A failure the daemon answered skips only that
// session's remaining entries; one it did not answer, or the time running out, stops
// the replay, since the next entry would meet the same link.
async function replayQueue({ env, where, token, deadline, deps }) {
  const now = deps.now || Date.now;
  const stalled = readStalled(env, now());
  const entries = [];
  for (const name of queueFiles(env)) {
    const file = path.join(queueDir(env), name);
    const entry = readJson(file);
    if (!entry || !EVENTS.includes(entry.event) || !entry.body || !entry.body.identity) { try { fs.unlinkSync(file); } catch {} continue; }
    entries.push({ file, entry, session: entry.body.identity.sessionId });
  }
  const isStalled = (item) => Object.hasOwn(stalled, item.session);
  const ordered = [...entries.filter((item) => !isStalled(item)), ...entries.filter(isStalled)];
  const failed = new Set();
  let sent = 0;
  for (const { file, entry, session } of ordered) {
    if (now() >= deadline) break;
    if (failed.has(session)) continue;
    // Another hook's replay may have delivered it since the queue was read.
    if (!fs.existsSync(file)) continue;
    const result = await deliver({
      event: entry.event, input: entry.body.input, identity: entry.body.identity, key: entry.body.idempotencyKey,
      transcriptPath: entry.body.transcriptPath, snapshot: entry.body.transcript || null, deadline, where, token, env, deps,
    });
    if (!result.ok && result.retry) {
      failed.add(session);
      stalled[session] = now();
      writeStalled(env, stalled);
      if (result.link || result.why === 'out of time') break;
      continue;
    }
    if (result.stale) {
      logLine(env, `dropped queued ${entry.event} for session ${entry.body.identity.sessionId} (seq ${entry.seq}): ${result.why}`);
    }
    try { fs.unlinkSync(file); } catch {}
    sent += 1;
  }
  // A stalled session whose entries have all gone no longer goes last.
  for (const session of Object.keys(stalled)) {
    if (!failed.has(session) && !pendingFor(env, session)) delete stalled[session];
  }
  writeStalled(env, stalled);
  return sent;
}

// The stalled sessions and when each last stalled, those older than an hour left out:
// a session long gone, or one that has long since had its chance to go first again.
function readStalled(env, at) {
  const state = readJson(replayStateFile(env));
  const out = {};
  if (state && state.stalled && typeof state.stalled === 'object' && !Array.isArray(state.stalled)) {
    for (const [session, when] of Object.entries(state.stalled)) {
      if (Number.isFinite(when) && at - when < STALL_TTL_MS) out[session] = when;
    }
  }
  return out;
}

function writeStalled(env, stalled) {
  const file = replayStateFile(env);
  if (!Object.keys(stalled).length) {
    try { fs.unlinkSync(file); } catch {}
    return;
  }
  // Nothing written when nothing changed: most replays find the record as it was.
  const current = readJson(file);
  if (current && JSON.stringify(current.stalled) === JSON.stringify(stalled)) return;
  try { writeAtomic(file, { stalled }); } catch {}
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

// Whether any of this session's events still wait in the queue.
function pendingFor(env, sessionId) {
  return queueFiles(env).some((name) => {
    const entry = readJson(path.join(queueDir(env), name));
    return Boolean(entry && entry.body && entry.body.identity && entry.body.identity.sessionId === sessionId);
  });
}

// One hook event, delivered. Resolves null when this event is not carried (the
// caller keeps today's behaviour), else { delivered, value?, why? }.
async function runHook(event, input, where, deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  if (!EVENTS.includes(event) || env.KEEP_RUN) return null;
  // A Codex client-end is the launcher's, with only the launch token: it names no
  // session, is never queued, and waits behind nothing.
  const sessionless = event === 'codex-client-end';
  if (!input || typeof input !== 'object') return null;
  if (sessionless ? input.session_id !== undefined && !SESSION_RE.test(String(input.session_id))
    : typeof input.session_id !== 'string' || !SESSION_RE.test(input.session_id)) return null;
  // A Bash hook's budget runs from before it read the context and the repository.
  const started = Number.isFinite(deps.startedAt) ? deps.startedAt : now();
  // First, before any wait: the transcript as this event saw it.
  const snapshot = TRANSCRIPTLESS.has(event) ? null : snapshotOf(input.transcript_path);
  input = fitInput(input);
  const budget = (deps.budgets || BUDGET_MS)[event];
  const deadline = started + budget;
  const identity = identityOf(input, env, where, event);
  // A caller that posts one event twice (a Codex start after its late bind) passes its key.
  const key = typeof deps.idempotencyKey === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(deps.idempotencyKey) ? deps.idempotencyKey : newKey();
  const fired = { snapshot, firedAt: Date.now() };
  if (ENDS.has(event)) dropSession(env, input.session_id);
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
  // The replay ran out of time (or the daemon stopped answering) with this
  // session's earlier events still waiting: this one must not overtake them. It
  // waits behind them, and gets its safe default now; the next hook drains more.
  if (!sessionless && pendingFor(env, input.session_id)) {
    return { delivered: false, why: 'earlier events of this session are still queued', queued: queue(event, input, identity, key, fired, env) };
  }
  const result = await deliver({ event, input, identity, key, transcriptPath: input.transcript_path, snapshot, deadline, where, token, env, deps });
  if (result.ok) return { delivered: true, value: result.value };
  // A hook the daemon stopped has run and been journalled: a resend would only
  // replay it. Anything else it answered is a refusal a resend would repeat.
  return { delivered: false, why: result.why, ...(result.code ? { code: result.code } : {}),
    queued: result.retry ? queue(event, input, identity, key, fired, env) : false };
}

function queue(event, input, identity, key, fired, env) {
  if (!QUEUED.has(event)) return false;
  // A stop delivered late cannot hold a turn that has already ended: replayed with
  // stop_hook_active it never blocks, because the evaluator returns before it scans,
  // so the turn's evidence is left for the next live stop to judge. What the replay
  // does write is the completion marker, stamped with `firedAt`, and the turn index.
  // A Codex stop the same way: the daemon's Codex Stop guard returns before it scans too.
  const replayInput = event === 'stop' || event === 'codex-stop' ? { ...input, stop_hook_active: true } : input;
  try {
    enqueue(env, { event, body: {
      input: replayInput, identity: { ...identity, firedAt: fired.firedAt }, idempotencyKey: key,
      transcriptPath: input.transcript_path, transcript: fired.snapshot,
    } });
    return true;
  } catch { return false; }
}

// ---------- the daemon's hook context ----------

const CONTEXT_TTL_MS = 60e3;
const CONTEXT_FETCH_MS = 1500;
const CONTEXT_SESSIONS_MAX = 64;
const FINGERPRINTS_MAX = 256;
const FINGERPRINT_MAX_BYTES = 200;

// The published fingerprints, if that is what they are: at most 256 printable
// one-line strings of at most 200 bytes. Anything else is not a list to match by.
function validSteps(value) {
  return Array.isArray(value) && value.length <= FINGERPRINTS_MAX && value.every((item) => typeof item === 'string'
    && item.trim() && !/[\u0000-\u001f\u007f]/.test(item) && Buffer.byteLength(item) <= FINGERPRINT_MAX_BYTES);
}

function readContextCache(env) {
  const value = readJson(contextFile(env));
  if (!value || !Number.isFinite(value.at) || !validSteps(value.steps)) return null;
  const sessions = value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions) ? value.sessions : {};
  return { at: value.at, steps: value.steps, sessions };
}

// What the daemon says a pre-bash hook needs: { steps, repairSession, fresh }. From
// the cache while it is under a minute old for this session; else asked, within
// `timeoutMs`. When the daemon does not answer, the cache as it stands, however old,
// with `fresh: false`: a node that cannot reach its daemon still refuses by the
// last list it had. repairSession is null when nothing has ever been said of it.
//
// `agent` and `pane` name the session as its posts do, so the daemon can adopt a Codex
// session it never heard register before it answers (bin/late-adoption.js). That runs
// under the adoption's own deadline, and this ask never waits past `timeoutMs`: a slow
// adoption answers as the daemon not answering does.
async function hookContext({ env, where, token, sessionId, agent, pane, timeoutMs = CONTEXT_FETCH_MS, deps = {} }) {
  const now = deps.now || Date.now;
  const cached = readContextCache(env);
  const known = cached && cached.sessions[sessionId] && typeof cached.sessions[sessionId].repairSession === 'boolean'
    ? cached.sessions[sessionId] : null;
  if (cached && known && now() - cached.at < CONTEXT_TTL_MS && now() - (known.at || 0) < CONTEXT_TTL_MS) {
    return { steps: cached.steps, repairSession: known.repairSession, fresh: true };
  }
  const stale = { steps: cached ? cached.steps : [], repairSession: known ? known.repairSession : null, fresh: false };
  if (!(timeoutMs > 0) || !token) return stale;
  let answer;
  try {
    const request = deps.request || require('./remote-cli.js').nodeApiRequest;
    const query = new URLSearchParams({ session: sessionId });
    if (typeof agent === 'string' && agent) query.set('agent', agent);
    if (typeof pane === 'string' && pane) query.set('pane', pane);
    const response = await request(where.url, `/api/hook/context?${query}`, { method: 'GET', token, timeoutMs });
    answer = response.status === 200 ? parsed(response) : null;
  } catch { answer = null; }
  if (!answer || !validSteps(answer.steps) || typeof answer.repairSession !== 'boolean') return stale;
  const at = now();
  const sessions = { ...(cached ? cached.sessions : {}), [sessionId]: { repairSession: answer.repairSession, at } };
  const kept = Object.entries(sessions).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, CONTEXT_SESSIONS_MAX);
  try { writeAtomic(contextFile(env), { at, steps: answer.steps, sessions: Object.fromEntries(kept) }); } catch {}
  return { steps: answer.steps, repairSession: answer.repairSession, fresh: true };
}

// ---------- Bash hooks ----------

// What a Bash call answered, cut to what the daemon takes: each output field at
// most `max` bytes, its end kept (where a failure, and the artifact the step
// recorder looks for, are), the exit code and whether it was interrupted.
const RESPONSE_TEXT_MAX = 64 * 1024;
function clipTail(value, max) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= max) return value;
  let start = bytes.length - max;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}
function responseOf(value, max = RESPONSE_TEXT_MAX) {
  if (typeof value === 'string') return clipTail(value, max);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const key of ['stdout', 'stderr', 'output']) if (typeof value[key] === 'string') out[key] = clipTail(value[key], max);
  for (const key of ['exit_code', 'exitCode']) if (Number.isSafeInteger(value[key])) out[key] = value[key];
  if (typeof value.interrupted === 'boolean') out.interrupted = value.interrupted;
  return out;
}

// The step fingerprints the daemon last published and this command's repository
// facts, computed inside the first half of the hook's budget. `incomplete` says a
// repository did not answer in time.
async function commandFacts({ event, agent, sessionId, cwd, command, where, deps, budget, started }) {
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  const facts = require('./repo-facts.js');
  let token = null;
  try {
    require('./remote-cli.js').daemonBase(where.url);
    token = deps.token || require('./remote-cli.js').nodeToken(env, deps.readToken);
  } catch { token = null; }
  // The pane as a post's identity names it (identityOf).
  let pane = null;
  try { pane = env.KEEP_PANE ? require('./nodes.js').formatPaneRef(where.local, env.KEEP_PANE, env) : null; } catch { pane = null; }
  const context = sessionId
    ? await hookContext({ env, where, token, sessionId, agent, pane, timeoutMs: token ? Math.min(CONTEXT_FETCH_MS, budget / 4) : 0, deps })
    : { steps: [], repairSession: null, fresh: false };
  let repo = null;
  try {
    repo = (deps.computeRepoFacts || facts.computeRepoFacts)({
      cwd, command, event, fingerprints: context.steps, home: env.HOME || os.homedir(),
      budgetMs: Math.max(0, Math.min(facts.BUDGET_MS, started + budget / 2 - now())),
    });
  } catch { repo = null; }
  return {
    context, incomplete: !repo || repo.incomplete === true,
    repoFacts: repo ? { paths: repo.paths, deploy: repo.deploy, head: repo.head } : { paths: {}, deploy: null, head: {} },
  };
}

// A post-tool's response cut further while the whole input would not fit: fitInput
// would otherwise drop it, and a recorder without it cannot tell a failure.
function fitResponse(carried, response) {
  if (response === undefined || response === null) return;
  for (let max = RESPONSE_TEXT_MAX; ; max = Math.floor(max / 2)) {
    carried.tool_response = responseOf(response, max);
    if (jsonBytes(carried) <= INPUT_MAX_BYTES - 1024 || max <= 1024) break;
  }
  if (carried.tool_response === undefined) delete carried.tool_response;
}

// A pre-bash or post-bash hook: the daemon's context (the step fingerprints), the
// repository facts for this command computed here, then the post. The input posted is
// rebuilt from what the daemon's hook reads, and nothing else of the tool call.
// Resolves as runHook does, plus `context`, what the daemon last published, so a
// caller that has to fail closed has the fingerprints to refuse by.
async function runBashHook(event, input, where, deps = {}) {
  const now = deps.now || Date.now;
  const started = now();
  const budget = (deps.budgets || BUDGET_MS)[event];
  const command = input && input.tool_input && typeof input.tool_input.command === 'string' ? input.tool_input.command : '';
  const sessionId = input && typeof input.session_id === 'string' && SESSION_RE.test(input.session_id) ? input.session_id : '';
  // A Pi pre-tool is a pre-bash in everything the facts are computed for.
  const pre = event === 'pre-bash' || event === 'pi-pre-tool';
  const { context, incomplete, repoFacts } = await commandFacts({
    event: pre ? 'pre-bash' : event, agent: PI_EVENTS.includes(event) ? 'pi' : 'claude',
    sessionId, cwd: input.cwd, command, where, deps, budget, started,
  });
  // A command that could be a gated step, in a repository that did not answer: the
  // daemon would judge it on facts that are not there, so it is not asked.
  if (pre && incomplete && require('./repo-facts.js').fingerprintMatch(command, context.steps)) {
    return { delivered: false, why: 'the repository did not answer in time', context, incomplete };
  }
  const carried = { session_id: input.session_id, cwd: input.cwd, tool_name: 'Bash', tool_input: { command }, repo_facts: repoFacts };
  for (const key of ['transcript_path', 'hook_event_name', 'permission_mode', 'tool_use_id']) {
    if (input[key] !== undefined && input[key] !== null) carried[key] = input[key];
  }
  if (event === 'post-bash') fitResponse(carried, input.tool_response);
  const outcome = await runHook(event, carried, where, { ...deps, startedAt: started });
  return { ...(outcome || { delivered: false, why: 'this hook is not carried' }), context, incomplete };
}

// A Codex pre-tool or post-tool on a shell call, as runBashHook does a Claude
// pre-bash or post-bash. `normalized` is what the daemon's own reading of the call
// gives (hook.js codexToolInput, run here on this node's rollout): the command as
// one script, its directory, and for a post-tool the response with the exit code the
// rollout recorded. The post carries that command and directory, so the daemon's
// reading of it finds the same, and the repository facts are for that directory.
async function runCodexToolHook(event, input, normalized, where, deps = {}) {
  const now = deps.now || Date.now;
  const started = now();
  const budget = (deps.budgets || BUDGET_MS)[event];
  const pre = event === 'codex-pre-tool';
  const command = normalized && normalized.tool_input && typeof normalized.tool_input.command === 'string' ? normalized.tool_input.command : '';
  const sessionId = input && typeof input.session_id === 'string' && SESSION_RE.test(input.session_id) ? input.session_id : '';
  const base = input && typeof input.cwd === 'string' && path.isAbsolute(input.cwd) ? input.cwd : process.cwd();
  const workdir = path.resolve(base, normalized && typeof normalized.cwd === 'string' ? normalized.cwd : base);
  const { context, incomplete, repoFacts } = await commandFacts({
    event: pre ? 'pre-bash' : 'post-bash', agent: 'codex', sessionId, cwd: workdir, command, where, deps, budget, started,
  });
  if (pre && incomplete && require('./repo-facts.js').fingerprintMatch(command, context.steps)) {
    return { delivered: false, why: 'the repository did not answer in time', context, incomplete };
  }
  const carried = { session_id: input.session_id, cwd: path.resolve(base), tool_name: String(input.tool_name || input.toolName || ''),
    tool_input: { command, workdir }, repo_facts: repoFacts };
  for (const key of ['transcript_path', 'hook_event_name', 'turn_id']) {
    if (input[key] !== undefined && input[key] !== null) carried[key] = input[key];
  }
  if (normalized.tool_use_id) carried.tool_use_id = String(normalized.tool_use_id);
  if (!pre) fitResponse(carried, normalized.tool_response);
  const outcome = await runHook(event, carried, where, { ...deps, startedAt: started });
  return { ...(outcome || { delivered: false, why: 'this hook is not carried' }), context, incomplete };
}

// A Pi hook (`keep hook pi <action>`), carried as `pi-<action>`. The input posted is
// rebuilt from what the daemon's `keep hook pi` reads: the session, its directory and
// the extension instance (whose end may release only what its own start bound), and
// for a pre-tool the command with this node's repository facts, as runBashHook
// carries a Claude pre-bash. A background worker's job id and token are never sent:
// Pi workers do not run on nodes. Resolves as runHook does (runBashHook for pre-tool).
// `deps.startedAt` (a start's: when its process started) is where the budget runs from.
async function runPiHook(action, input, where, deps = {}) {
  const event = `pi-${action}`;
  if (!PI_EVENTS.includes(event) || !input || typeof input !== 'object') return null;
  if (event === 'pi-pre-tool') return runBashHook(event, input, where, deps);
  const carried = { session_id: input.session_id, cwd: input.cwd };
  if (typeof input.instance === 'string') carried.instance = input.instance;
  if (Number.isSafeInteger(input.pid) && input.pid > 0) carried.pid = input.pid;
  return runHook(event, carried, where, deps);
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
  runHook, runBashHook, runCodexToolHook, runPiHook, deliver, logLine, replayQueue, enqueue, dropSession, fitInput, report, generationOf, snapshotOf, stateDir, queueDir, cursorFile, logFile,
  hookContext, contextFile, CONTEXT_TTL_MS, linkFile, replayStateFile, chunkSize, chunkTimeout,
  EVENTS, CLAUDE_EVENTS, CODEX_EVENTS, PI_EVENTS, TRANSCRIPTLESS, QUEUED, ENDS, BUDGET_MS, QUEUE_MAX,
  CHUNK_BYTES, CHUNK_MIN, CHUNK_MAX, CHUNK_FIRST, CHUNK_FLOOR_MS, STALL_TTL_MS, LINK_TTL_MS, INPUT_MAX_BYTES, TEXT_CAPS, FORWARDED_ENV,
};
