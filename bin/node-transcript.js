'use strict';
// The `transcript` verb: a node's host answering for the transcript of a session it
// runs, so the daemon can confirm a delivery (and read a session's state) without a
// file of its own. What it will read is decided here, on the node, and never taken
// from the caller: the request names an agent kind, a session id and an account
// ({ id, configDir }), the account must be one this node itself has configured for
// that agent, and the file is found by the same lookups the daemon uses locally
// (transcripts.claudeFilesIn, codex.rolloutFilesIn, pi.fileFor), under that account's
// directory. The file is opened O_NOFOLLOW, its real path must sit under the real
// config directory, and the descriptor that is read must be the file that check
// looked at. Reads are bounded: 256 KiB at a time, 256 KiB of tail, and 32 MiB in
// total for one request, however long it waits.
//
//   stat  -> { path, size, mtimeMs, generation }
//   tail  -> { ...stat, bytes: base64 of the last `length` bytes, from }
//   match -> { ...stat, matched, checkedTo }: delivery.matchesFrom from `fromOffset`
//            for `hash`, looked at again every 500 ms until it matches or
//            `timeoutMs` (at most 9 s) runs out.
//   find  -> { rollouts: [{ path, size, mtimeMs, generation, id, cwd, createdMs, model,
//            originator, child, headless }] }: Codex only, and with no session id: the
//            newest (at most 20) rollouts under the account's own sessions directory
//            begun since `sinceMs` (session_meta's timestamp, else the file's birth),
//            each with what its session_meta line says, and only those whose cwd is
//            `cwd` when one is given. How the daemon finds a fresh Codex
//            launch's session, which names itself nowhere else until its first turn.
//            Every file is opened as `open` opens one, and only its first 256 KiB read.
//   meta  -> { ...stat, meta, model }: Codex only, naming a session: its rollout's
//            session_meta line (id, cwd, model, originator, parent thread, child,
//            headless) from at most its first 256 KiB, and the model of the last
//            turn_context (what it last ran on), found reading back from the end
//            256 KiB at a time, at most 32 MiB, or null. How a move learns what a
//            Codex session on a node runs on.
//   pi-event -> { event }: Pi only, naming a session and no account: the phase file the
//            Keep Pi extension (integrations/pi/keep.ts) writes on this node,
//            <KEEP_DIR || ~/keep>/.keep/pi-events/<id>.json, parsed, or null when there
//            is none. The path is this node's own, built here from the id; a file that
//            is there and cannot be read or parsed is an error, not "none". How the
//            daemon follows a Pi session's turn state on a node.
//
// Every refusal carries a code, so the daemon can tell "this node will not read
// that" (transcript-refused), "there is nothing to read yet" (transcript-missing)
// and "the request was malformed" (transcript-invalid) from a host that is gone.

const fs = require('node:fs');
const path = require('node:path');

const KINDS = new Set(['claude', 'codex', 'pi']);
const OPS = new Set(['stat', 'tail', 'match', 'find', 'meta', 'pi-event', 'close-proof']);
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ACCOUNT_ID_RE = /^(?:[a-z0-9][a-z0-9_-]{0,63}|(?:claude|codex|pi)\/default)$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const TAIL_MAX_BYTES = 256 * 1024;
const MATCH_MAX_WAIT_MS = 9000;
const MATCH_POLL_MS = 500;
const REQUEST_MAX_READ_BYTES = 32 * 1024 * 1024;
const FIND_MAX = 20;
const FIND_SCAN_MAX = 2000;
const META_MAX_BYTES = 256 * 1024;
const ROLLOUT_NAME_RE = /^rollout-[^/]*\.jsonl$/;
// The id shape the Pi extension names its phase file by.
const PI_EVENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PI_EVENT_MAX_BYTES = 64 * 1024;
const PI_PHASES = new Set(['start', 'running', 'settled', 'shutdown', 'prompt']);

function coded(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
const invalid = (message) => coded(message, 'transcript-invalid');
const refused = (message) => coded(message, 'transcript-refused');

function realpath(value) {
  try { return fs.realpathSync(value); } catch { return null; }
}

function generationOf(stat) {
  return `${stat.dev}:${stat.ino}:${Math.round(stat.birthtimeMs || 0)}`;
}

function validate(params) {
  if (!params || typeof params !== 'object') throw invalid('a transcript request must be an object');
  if (!OPS.has(params.op)) throw invalid('transcript op must be stat, tail, match, find, meta, pi-event or close-proof');
  if (!KINDS.has(params.kind)) throw invalid('transcript kind must be claude, codex or pi');
  if (params.op === 'meta' && params.kind !== 'codex') throw invalid('transcript meta is for codex rollouts');
  if (params.op === 'pi-event') {
    if (params.kind !== 'pi') throw invalid('transcript pi-event is for pi sessions');
    if (typeof params.sessionId !== 'string' || !PI_EVENT_ID_RE.test(params.sessionId)) throw invalid('transcript session id is not a session id');
    return;
  }
  if (params.op === 'find') {
    if (params.kind !== 'codex') throw invalid('transcript find is for codex rollouts');
    if (params.sessionId !== undefined) throw invalid('transcript find names no session');
    if (!Number.isSafeInteger(params.sinceMs) || params.sinceMs < 0) throw invalid('transcript find needs sinceMs');
    if (params.cwd !== undefined && (typeof params.cwd !== 'string' || !path.isAbsolute(params.cwd) || /[\0\r\n]/.test(params.cwd))) {
      throw invalid('transcript find cwd must be an absolute path');
    }
  } else if (typeof params.sessionId !== 'string' || !SESSION_ID_RE.test(params.sessionId)) {
    throw invalid('transcript session id is not a session id');
  }
  const account = params.account;
  if (!account || typeof account !== 'object' || typeof account.id !== 'string' || !ACCOUNT_ID_RE.test(account.id)
      || typeof account.configDir !== 'string' || !path.isAbsolute(account.configDir) || /[\0\r\n]/.test(account.configDir)) {
    throw invalid('transcript account must name an id and an absolute config directory');
  }
}

// The account the request names, as this node has it configured. Both halves must
// agree: an id the node knows under another directory, or a directory it knows under
// another id, is not the account the daemon thinks it is asking about.
function nodeAccount(params, options = {}) {
  const list = options.accounts || (() => require('./accounts.js').list(options.env || process.env));
  let accounts;
  try { accounts = list(); } catch (error) { throw refused(`this node's accounts could not be read: ${error.message}`); }
  const wantedDir = realpath(params.account.configDir);
  const match = (Array.isArray(accounts) ? accounts : []).find((entry) => entry && entry.agent === params.kind
    && entry.id === params.account.id && typeof entry.configDir === 'string'
    && wantedDir && realpath(entry.configDir) === wantedDir);
  if (!match) throw refused(`${params.account.id} is not a ${params.kind} account on this node`);
  return { id: match.id, configDir: match.configDir, root: wantedDir };
}

function candidates(params, account) {
  if (params.kind === 'claude') {
    return require('./transcripts.js').claudeFilesIn(account.configDir, params.sessionId).map((entry) => entry.file);
  }
  if (params.kind === 'codex') {
    return require('./codex.js').rolloutFilesIn(account.configDir, params.sessionId)
      .sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.file);
  }
  const found = require('./pi.js').fileFor(params.sessionId, { sessionsDir: path.join(account.configDir, 'agent', 'sessions') });
  return found ? [found] : [];
}

// Opens the session's transcript for reading and proves it is the file it claims to
// be: under the account's real directory, not reached through a link at its last
// component (O_NOFOLLOW), and the same inode the real-path check looked at.
function open(params, options = {}) {
  validate(params);
  const account = nodeAccount(params, options);
  const file = candidates(params, account)[0];
  if (!file) throw coded(`no ${params.kind} transcript for ${params.sessionId} on this node`, 'transcript-missing');
  return openChecked(params, account, file);
}

function openChecked(params, account, file) {
  const real = realpath(file);
  if (!real || !real.startsWith(account.root + path.sep)) throw refused('the transcript is not under its account directory');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error && error.code === 'ELOOP') throw refused('the transcript is a symbolic link');
    if (error && error.code === 'ENOENT') throw coded(`no ${params.kind} transcript for ${params.sessionId} on this node`, 'transcript-missing');
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    const checked = fs.statSync(real);
    if (!stat.isFile() || stat.dev !== checked.dev || stat.ino !== checked.ino) {
      throw refused('the transcript changed while it was being opened');
    }
    return { fd, file, stat };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function describe(file, stat) {
  return { path: file, size: stat.size, mtimeMs: stat.mtimeMs, generation: generationOf(stat) };
}

function tail(fd, stat, length) {
  const from = Math.max(0, stat.size - length);
  const buffer = Buffer.alloc(stat.size - from);
  let read = 0;
  while (read < buffer.length) {
    const n = fs.readSync(fd, buffer, read, Math.min(TAIL_MAX_BYTES, buffer.length - read), from + read);
    if (!n) break;
    read += n;
  }
  return { bytes: buffer.subarray(0, read).toString('base64'), from };
}

// The session_meta line a rollout starts with, from at most its first 256 KiB.
function sessionMetaOf(fd, size) {
  const buffer = Buffer.alloc(Math.min(size, META_MAX_BYTES));
  let got = 0;
  while (got < buffer.length) {
    const n = fs.readSync(fd, buffer, got, buffer.length - got, got);
    if (!n) break;
    got += n;
  }
  const text = buffer.subarray(0, got).toString('utf8');
  const newline = text.indexOf('\n');
  if (newline === -1 && got >= META_MAX_BYTES) return null;
  let record;
  try { record = JSON.parse(newline === -1 ? text : text.slice(0, newline)); } catch { return null; }
  return record && record.type === 'session_meta' && record.payload && typeof record.payload === 'object' ? record.payload : null;
}

const shortText = (value, max = 256) => (typeof value === 'string' && value.length <= max ? value : null);

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]/-]{0,127}$/;

// The model of the last turn_context in the rollout, or null: what a resumed Codex
// conversation last ran on. Read back from the end 256 KiB at a time, whole lines
// only (a line cut by a chunk's start is finished by the next chunk back), stopping
// at the first turn_context found, and never more than `maxBytes` in all: a long
// turn of tool output can put the last turn_context megabytes before the end.
const TURN_SCAN_MAX_BYTES = REQUEST_MAX_READ_BYTES;

function lastTurnModel(fd, size, maxBytes = TURN_SCAN_MAX_BYTES) {
  let position = size;
  let carry = Buffer.alloc(0);
  let spent = 0;
  while (position > 0 && spent < maxBytes) {
    const from = Math.max(0, position - TAIL_MAX_BYTES, size - maxBytes);
    const chunk = Buffer.alloc(position - from);
    let got = 0;
    while (got < chunk.length) {
      const n = fs.readSync(fd, chunk, got, chunk.length - got, from + got);
      if (!n) break;
      got += n;
    }
    if (got < chunk.length) return null;
    spent += chunk.length;
    let body = Buffer.concat([chunk, carry]);
    if (from > 0) {
      const newline = body.indexOf(10);
      if (newline === -1) { carry = body; position = from; continue; }
      carry = body.subarray(0, newline);
      body = body.subarray(newline + 1);
    }
    const lines = body.toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index].includes('"turn_context"')) continue;
      let record;
      try { record = JSON.parse(lines[index]); } catch { continue; }
      if (record && record.type === 'turn_context' && record.payload && typeof record.payload.model === 'string') {
        return MODEL_RE.test(record.payload.model) ? record.payload.model : null;
      }
    }
    position = from;
  }
  return null;
}

// What one opened rollout says about its conversation: its session_meta (bounded, as
// `find` reads one) and its last turn's model. Shared by the `meta` op and the
// daemon's own read of a rollout on its machine (rolloutMeta).
function describeRollout(fd, stat) {
  const codex = require('./codex.js');
  const meta = sessionMetaOf(fd, stat.size);
  return {
    meta: meta ? {
      id: shortText(meta.id, 128) || shortText(meta.session_id, 128), cwd: shortText(meta.cwd, 4096),
      model: shortText(meta.model, 128), originator: shortText(meta.originator),
      parentThreadId: shortText(meta.parent_thread_id, 160), child: codex.isChildSession(meta), headless: codex.isHeadlessSession(meta),
    } : null,
    model: lastTurnModel(fd, stat.size),
  };
}

// The `meta` op: the session's newest rollout under the account, opened and checked
// as `open` opens one.
function rolloutMetaOp(params, options = {}) {
  const { fd, file, stat } = open(params, options);
  try { return { ...describe(file, stat), ...describeRollout(fd, stat) }; }
  finally { fs.closeSync(fd); }
}

// The same answer for a rollout on this machine under a config directory the caller
// has already resolved (the daemon's own account record), or null when it has none.
function rolloutMeta(configDir, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId) || typeof configDir !== 'string') return null;
  const found = require('./codex.js').rolloutFilesIn(configDir, sessionId).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!found) return null;
  let fd;
  try { fd = fs.openSync(found.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); } catch { return null; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    return { ...describe(found.file, stat), ...describeRollout(fd, stat) };
  } finally { fs.closeSync(fd); }
}

// The Codex rollouts this node's account has written since `sinceMs`: newest first,
// at most FIND_MAX, each opened and checked as `open` does one.
function find(params, options = {}) {
  validate(params);
  const account = nodeAccount(params, options);
  const codex = require('./codex.js');
  const seen = [];
  let scanned = 0;
  for (const dir of codex.recentDateDirs(account.configDir)) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!ROLLOUT_NAME_RE.test(name) || scanned >= FIND_SCAN_MAX) continue;
      scanned += 1;
      const file = path.join(dir, name);
      let stat;
      try { stat = fs.lstatSync(file); } catch { continue; }
      if (stat.isFile() && stat.mtimeMs >= params.sinceMs) seen.push({ file, mtimeMs: stat.mtimeMs });
    }
  }
  seen.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
  const rollouts = [];
  for (const { file } of seen) {
    if (rollouts.length >= FIND_MAX) break;
    let opened;
    try { opened = openChecked(params, account, file); } catch { continue; }
    try {
      const meta = sessionMetaOf(opened.fd, opened.stat.size);
      const id = meta && (shortText(meta.id, 128) || shortText(meta.session_id, 128));
      if (!id || !SESSION_ID_RE.test(id)) continue;
      const cwd = shortText(meta.cwd, 4096);
      if (params.cwd !== undefined && (!cwd || path.resolve(cwd) !== path.resolve(params.cwd))) continue;
      // When the session began, not when it last wrote: a session already running in
      // the same directory keeps writing its rollout, and is not a launch since then.
      const began = Date.parse(shortText(meta.timestamp, 64) || '');
      const createdMs = Number.isFinite(began) ? began : (opened.stat.birthtimeMs > 0 ? opened.stat.birthtimeMs : opened.stat.mtimeMs);
      if (createdMs < params.sinceMs) continue;
      rollouts.push({
        ...describe(file, opened.stat), id, cwd, createdMs, model: shortText(meta.model), originator: shortText(meta.originator),
        child: codex.isChildSession(meta), headless: codex.isHeadlessSession(meta),
      });
    } finally { fs.closeSync(opened.fd); }
  }
  return { rollouts };
}

// The Pi extension's phase file for one session on this node: parsed and checked as
// the daemon's own pi.eventFor checks one (its id, a known phase), or null when there
// is none, or none that is this session's. Read O_NOFOLLOW and bounded; a file that
// exists and cannot be read is an error, so the daemon can tell it from "no signal yet".
function piEvent(params, options = {}) {
  validate(params);
  const env = options.env || process.env;
  const root = env.KEEP_DIR || path.join(env.HOME || require('node:os').homedir(), 'keep');
  const file = path.join(root, '.keep', 'pi-events', `${params.sessionId}.json`);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error && error.code === 'ENOENT') return { event: null };
    if (error && error.code === 'ELOOP') throw refused('the Pi phase file is a symbolic link');
    throw coded(`the Pi phase file could not be read: ${error.message}`, 'transcript-unreadable');
  }
  let text;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw refused('the Pi phase file is not a file');
    if (stat.size > PI_EVENT_MAX_BYTES) throw coded('the Pi phase file is too large', 'transcript-unreadable');
    const buffer = Buffer.alloc(stat.size);
    let got = 0;
    while (got < buffer.length) {
      const n = fs.readSync(fd, buffer, got, buffer.length - got, got);
      if (!n) break;
      got += n;
    }
    text = buffer.subarray(0, got).toString('utf8');
  } finally { fs.closeSync(fd); }
  let value;
  try { value = JSON.parse(text); } catch (error) {
    throw coded(`the Pi phase file is not JSON: ${error.message}`, 'transcript-unreadable');
  }
  if (!value || typeof value !== 'object' || value.id !== params.sessionId || !PI_PHASES.has(value.phase)) return { event: null };
  const short = (entry, max = 256) => (typeof entry === 'string' && entry.length <= max ? entry : null);
  return { event: {
    id: value.id, phase: value.phase, at: short(value.at, 64),
    ...(Number.isSafeInteger(value.pid) ? { pid: value.pid } : {}),
    instance: short(value.instance, 64), sessionFile: short(value.sessionFile, 4096), leafId: short(value.leafId, 128),
  } };
}

// What an automatic close has to know that only a whole-transcript read can tell:
// for Claude, whether any background command ran and is still unfinished; for Codex,
// whether the session ever launched a child agent. The daemon runs the same scan in a
// worker over a local file (serve.js inspectCloseTranscript); for a session on this
// node the file is here, so the scan is too. Transcript verb 5.
const CLOSE_PROOF_TIMEOUT_MS = 60e3;

function closeProof(params, options = {}) {
  const { fd, file, stat } = open(params, options);
  fs.closeSync(fd);
  const run = options.inspectCloseTranscript || ((target, kind) => new Promise((resolve, reject) => {
    const { Worker } = require('node:worker_threads');
    const worker = new Worker(path.join(__dirname, 'close-transcript-worker.js'), { workerData: { file: target, kind } });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      finish(coded(`close transcript scan timed out after ${CLOSE_PROOF_TIMEOUT_MS / 1000}s`, 'transcript-timeout'));
      try { worker.terminate(); } catch {}
    }, CLOSE_PROOF_TIMEOUT_MS);
    worker.once('message', (message) => {
      if (message && message.error) finish(new Error(message.error.message || String(message.error)));
      else finish(null, (message && message.result) || {});
    });
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => finish(new Error(code ? `close transcript worker exited ${code}` : 'close transcript worker exited without a result')));
  }));
  return Promise.resolve(run(file, params.kind)).then((result) => ({
    ...describe(file, stat),
    ...(params.kind === 'claude'
      ? { hasBackgroundCommands: result.hasBackgroundCommands === true, pendingBackground: result.pendingBackground === true }
      : { launched: result.launched === true }),
  }));
}

async function handle(params, options = {}) {
  if (params && params.op === 'find') return find(params, options);
  if (params && params.op === 'close-proof') { validate(params); return closeProof(params, options); }
  if (params && params.op === 'pi-event') return piEvent(params, options);
  if (params && params.op === 'meta') return rolloutMetaOp(params, options);
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now || Date.now;
  const closed = options.closed || (() => false);
  let length = TAIL_MAX_BYTES;
  let timeoutMs = 0;
  if (params && params.op === 'tail' && params.length !== undefined) {
    if (!Number.isSafeInteger(params.length) || params.length < 1 || params.length > TAIL_MAX_BYTES) {
      throw invalid(`transcript tail length must be 1 to ${TAIL_MAX_BYTES} bytes`);
    }
    length = params.length;
  }
  if (params && params.op === 'match') {
    if (!Number.isSafeInteger(params.fromOffset) || params.fromOffset < 0) throw invalid('transcript match needs a fromOffset');
    if (typeof params.hash !== 'string' || !HASH_RE.test(params.hash)) throw invalid('transcript match needs a hash');
    if (params.timeoutMs !== undefined) {
      if (!Number.isSafeInteger(params.timeoutMs) || params.timeoutMs < 0 || params.timeoutMs > MATCH_MAX_WAIT_MS) {
        throw invalid(`transcript match timeoutMs must be 0 to ${MATCH_MAX_WAIT_MS}`);
      }
      timeoutMs = params.timeoutMs;
    }
  }
  const { fd, file, stat } = open(params, options);
  try {
    if (params.op === 'stat') return describe(file, stat);
    if (params.op === 'tail') return { ...describe(file, stat), ...tail(fd, stat, length) };
    const { matchesFrom } = require('./delivery.js');
    const deadline = now() + timeoutMs;
    let budget = options.maxReadBytes || REQUEST_MAX_READ_BYTES;
    // Each poll picks up where the last one stopped (offset, partial line, decoder),
    // so the budget is spent on bytes read once, not on the same bytes every 500 ms.
    const resume = {};
    for (;;) {
      const current = fs.fstatSync(fd);
      const result = matchesFrom(fd, params.fromOffset, { kind: params.kind, hash: params.hash, maxBytes: budget, resume });
      budget -= result.bytesRead;
      const answer = { ...describe(file, current), matched: result.matched, checkedTo: result.checkedTo };
      if (result.matched) return answer;
      // Out of reading budget is an answer too, and the one it gives is "not seen":
      // a receipt is only ever claimed for text the node read.
      if (budget <= 0) return { ...answer, capped: true };
      const left = deadline - now();
      if (left <= 0 || closed()) return answer;
      await sleep(Math.min(MATCH_POLL_MS, left));
    }
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  handle, open, find, piEvent, rolloutMeta, lastTurnModel, validate, generationOf, nodeAccount, FIND_MAX,
  TAIL_MAX_BYTES, MATCH_MAX_WAIT_MS, MATCH_POLL_MS, REQUEST_MAX_READ_BYTES,
};
