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
//
// Every refusal carries a code, so the daemon can tell "this node will not read
// that" (transcript-refused), "there is nothing to read yet" (transcript-missing)
// and "the request was malformed" (transcript-invalid) from a host that is gone.

const fs = require('node:fs');
const path = require('node:path');

const KINDS = new Set(['claude', 'codex', 'pi']);
const OPS = new Set(['stat', 'tail', 'match']);
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ACCOUNT_ID_RE = /^(?:[a-z0-9][a-z0-9_-]{0,63}|(?:claude|codex|pi)\/default)$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const TAIL_MAX_BYTES = 256 * 1024;
const MATCH_MAX_WAIT_MS = 9000;
const MATCH_POLL_MS = 500;
const REQUEST_MAX_READ_BYTES = 32 * 1024 * 1024;

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
  if (!OPS.has(params.op)) throw invalid('transcript op must be stat, tail or match');
  if (!KINDS.has(params.kind)) throw invalid('transcript kind must be claude, codex or pi');
  if (typeof params.sessionId !== 'string' || !SESSION_ID_RE.test(params.sessionId)) {
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

async function handle(params, options = {}) {
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
  handle, open, validate, generationOf,
  TAIL_MAX_BYTES, MATCH_MAX_WAIT_MS, MATCH_POLL_MS, REQUEST_MAX_READ_BYTES,
};
