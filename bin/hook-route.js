'use strict';
// POST /api/hook — a Claude session's hook on a pane-only node, run on the daemon.
//
// The node's hook sends the event, its stdin JSON and the transcript bytes the
// daemon does not have yet. The bytes are appended to the session's transcript
// mirror (bin/transcript-mirror.js); the stdin object is validated field by field,
// everything unknown dropped, its transcript_path rewritten to the mirror, and the
// daemon's own `keep hook <event>` runs on it in a subprocess, exactly the code a
// session on the daemon node runs. Its stdout is what the node prints to Claude.
//
// Nothing from the body is run: the program is this checkout's bin/keep.js, the
// argv is `hook <event>` from a fixed list, and the stdin is the rewritten object.
// A node acts only for a Claude session the location record places on it, only on
// that session's mirror, and only with a pane on itself. The run goes through the
// registry route's journal (bin/registry-route.js), so a resent event replays its
// answer instead of running again, and a restart waits for it. The transcript
// append is outside the journal and needs none: a post must start where the mirror
// ends, so a resend of bytes already appended writes nothing and says where to go on.
const crypto = require('node:crypto');
const path = require('node:path');
const mirror = require('./transcript-mirror.js');
const { RegistryError } = require('./registry-route.js');

const EVENTS = ['session-start', 'session-end', 'stop', 'notification', 'pre-question', 'lifecycle'];
// A post that carries only transcript bytes: every chunk of a long delta but the last.
const TRANSCRIPT_ONLY = 'transcript';
const HOOK_TIMEOUT_MS = 20e3;
const INPUT_MAX_BYTES = 256 * 1024;
const BODY_MAX_BYTES = 7 * 1024 * 1024;
const TEXT_MAX = 64 * 1024;
const PATH_MAX = 4096;
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PANE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const ACCOUNT_RE = /^(?:[a-z0-9][a-z0-9_-]{0,63}|(?:claude|codex|pi)\/default)$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const HOOK_EVENT_NAMES = {
  'session-start': ['SessionStart'],
  'session-end': ['SessionEnd'],
  stop: ['Stop'],
  notification: ['Notification'],
  'pre-question': ['PreToolUse'],
  // session-lifecycle.js EVENTS: what `keep hook lifecycle` records.
  lifecycle: ['SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
    'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'Interrupt'],
};
const PRUNE_EVERY_MS = 60 * 60e3;
// What the daemon's hook code reads from a session's own environment, forwarded by
// the node in identity.env: a flag, a short token or an id each, never more. Any
// other key is dropped; a listed one of another shape refuses the request.
const FORWARDED_ENV = Object.freeze({
  KEEP_REVIEWER: /^(?:0|1|true|false)$/,
  KEEP_AUTO_CONTINUE: /^(?:0|1|true|false)$/,
  CLAUDE_CODE_ENTRYPOINT: /^[A-Za-z0-9_.-]{1,128}$/,
  KEEP_DELEGATION_ID: /^[A-Za-z0-9_-]{1,128}$/,
});

function refuse(status, message) { throw new RegistryError(status, message); }

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function absolutePath(value, name) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value) || value.includes('\0') || /[\r\n]/.test(value)
    || Buffer.byteLength(value) > PATH_MAX) refuse(400, `${name} must be an absolute path`);
  if (value.split(/[\\/]+/).includes('..')) refuse(400, `${name} may not contain ..`);
  return value;
}

function text(value, name, max = TEXT_MAX) {
  if (typeof value !== 'string') refuse(400, `${name} must be a string`);
  if (value.includes('\0')) refuse(400, `${name} may not contain NUL`);
  if (Buffer.byteLength(value) > max) refuse(400, `${name} is longer than ${max} bytes`);
  return value;
}

// A string cut to at most \`max\` UTF-8 bytes, on a character boundary.
function clipBytes(value, max) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= max) return value;
  let end = max;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

// AskUserQuestion's input, reduced to a bounded shape: at most four questions, each
// question at most 4 KiB, a header and up to twenty option labels of 256 bytes,
// and multiSelect. Nothing else of it reaches the hook.
function questionInput(tool) {
  const questions = [];
  for (const question of Array.isArray(tool.questions) ? tool.questions.slice(0, 4) : []) {
    if (!isObject(question)) continue;
    const item = {};
    if (typeof question.question === 'string') item.question = clipBytes(question.question, 4096);
    if (typeof question.header === 'string') item.header = clipBytes(question.header, 256);
    if (Array.isArray(question.options)) {
      item.options = question.options.slice(0, 20).map((option) => {
        if (typeof option === 'string') return clipBytes(option, 256);
        return isObject(option) && typeof option.label === 'string' ? { label: clipBytes(option.label, 256) } : null;
      }).filter(Boolean);
    }
    if (typeof question.multiSelect === 'boolean') item.multiSelect = question.multiSelect;
    questions.push(item);
  }
  return { questions };
}

function matching(value, re, name) {
  if (typeof value !== 'string' || !re.test(value)) refuse(400, `invalid ${name}`);
  return value;
}

// The hook's stdin, as Claude Code sends it for this event, rebuilt from the fields
// the daemon's hook code reads. Anything else is dropped; a known field of the
// wrong shape refuses the request.
function cleanInput(event, input, sessionId) {
  if (!isObject(input)) refuse(400, 'input must be the hook\'s stdin object');
  let size;
  try { size = Buffer.byteLength(JSON.stringify(input)); } catch { refuse(400, 'input is not JSON'); }
  if (size > INPUT_MAX_BYTES) refuse(400, `input is larger than ${INPUT_MAX_BYTES} bytes`);
  if (input.session_id !== sessionId) refuse(400, 'input.session_id must be the identity\'s session');
  const out = { session_id: sessionId, cwd: absolutePath(input.cwd, 'input.cwd') };
  if (input.transcript_path !== undefined) text(input.transcript_path, 'input.transcript_path', PATH_MAX);
  const has = (key) => input[key] !== undefined && input[key] !== null;
  if (has('hook_event_name')) {
    out.hook_event_name = matching(input.hook_event_name, /^[A-Za-z]{1,64}$/, 'input.hook_event_name');
    if (!HOOK_EVENT_NAMES[event].includes(out.hook_event_name)) refuse(400, `input.hook_event_name ${out.hook_event_name} is not a ${event} event`);
  } else if (event === 'lifecycle') refuse(400, 'input.hook_event_name is required for lifecycle');
  if (has('permission_mode')) out.permission_mode = matching(input.permission_mode, /^[A-Za-z]{1,32}$/, 'input.permission_mode');
  if (event === 'session-start' || event === 'lifecycle') {
    if (has('source')) out.source = matching(input.source, /^[a-z_]{1,32}$/, 'input.source');
  }
  if (event === 'session-end' && has('reason')) out.reason = matching(input.reason, /^[a-z_]{1,64}$/, 'input.reason');
  if (event === 'stop') {
    if (has('stop_hook_active')) {
      if (typeof input.stop_hook_active !== 'boolean') refuse(400, 'input.stop_hook_active must be a boolean');
      out.stop_hook_active = input.stop_hook_active;
    }
  }
  if ((event === 'stop' || event === 'lifecycle') && has('last_assistant_message')) {
    out.last_assistant_message = text(input.last_assistant_message, 'input.last_assistant_message');
  }
  if (event === 'notification') {
    if (has('message')) out.message = text(input.message, 'input.message', 4096);
    if (has('title')) out.title = text(input.title, 'input.title', 1024);
    if (has('notification_type')) out.notification_type = matching(input.notification_type, /^[a-z_]{1,64}$/, 'input.notification_type');
  }
  if (event === 'pre-question') {
    if (input.tool_name !== 'AskUserQuestion') refuse(400, 'pre-question is for AskUserQuestion only');
    out.tool_name = 'AskUserQuestion';
    if (has('tool_input')) {
      if (!isObject(input.tool_input)) refuse(400, 'input.tool_input must be an object');
      out.tool_input = questionInput(input.tool_input);
    }
    if (has('tool_use_id')) out.tool_use_id = matching(input.tool_use_id, ID_RE, 'input.tool_use_id');
  }
  if (event === 'lifecycle') {
    for (const key of ['agent_id', 'prompt_id', 'tool_use_id']) {
      if (has(key)) out[key] = matching(input[key], ID_RE, `input.${key}`);
    }
    if (has('tool_name')) out.tool_name = matching(input.tool_name, /^[A-Za-z0-9_.:-]{1,100}$/, 'input.tool_name');
    // Only what session-status.toolWaitReason reads, as strings.
    if (has('tool_input')) {
      if (!isObject(input.tool_input)) refuse(400, 'input.tool_input must be an object');
      const tool = {};
      for (const key of ['command', 'cmd', 'code', 'description']) {
        if (typeof input.tool_input[key] === 'string') tool[key] = input.tool_input[key].slice(0, 4096);
      }
      out.tool_input = tool;
    }
  }
  return out;
}

function cleanTranscript(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) refuse(400, 'transcript must be an object or null');
  const sourcePath = absolutePath(value.path, 'transcript.path');
  if (typeof value.generation !== 'string' || !mirror.GENERATION_RE.test(value.generation)) refuse(400, 'invalid transcript.generation');
  for (const key of ['fromOffset', 'size']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) refuse(400, `transcript.${key} must be a non-negative integer`);
  }
  if (!Number.isFinite(value.mtimeMs) || value.mtimeMs <= 0) refuse(400, 'transcript.mtimeMs must be a positive number');
  const encoded = value.bytes === undefined ? '' : value.bytes;
  if (typeof encoded !== 'string' || !BASE64_RE.test(encoded) || encoded.length % 4 !== 0) refuse(400, 'transcript.bytes must be base64');
  if (encoded.length > Math.ceil(mirror.POST_CAP_BYTES / 3) * 4) refuse(413, `a post carries at most ${mirror.POST_CAP_BYTES} transcript bytes`);
  return {
    sourcePath, generation: value.generation, fromOffset: value.fromOffset, size: value.size, mtimeMs: value.mtimeMs,
    bytes: Buffer.from(encoded, 'base64'),
  };
}

// The request, checked. `location` and the pane helpers come from the registry route.
function validateRequest(body, caller, deps) {
  if (!isObject(body)) refuse(400, 'the request body must be an object');
  const { event } = body;
  if (event !== TRANSCRIPT_ONLY && !EVENTS.includes(event)) refuse(400, `${JSON.stringify(String(event))} is not a hook event`);
  const identity = body.identity;
  if (!isObject(identity)) refuse(400, 'identity is required');
  if (identity.agent !== 'claude') refuse(400, 'only Claude hooks are carried to the daemon');
  const sessionId = matching(identity.sessionId, SESSION_RE, 'session id');
  let accountId = null;
  if (identity.accountId !== undefined && identity.accountId !== null) accountId = matching(identity.accountId, ACCOUNT_RE, 'account id');
  let where = null;
  try { where = deps.location(sessionId); } catch { where = null; }
  if (!where || where.node !== caller) refuse(403, `session ${sessionId} is not on node ${caller}`);
  if (where.agent !== 'claude') refuse(403, `session ${sessionId} is a ${where.agent} session, not claude`);
  if (accountId && where.accountId && accountId !== where.accountId) {
    refuse(403, `session ${sessionId} runs on account ${where.accountId}, not ${accountId}`);
  }
  // The daemon's record is the authority; the node's word only fills a gap in it.
  if (typeof where.accountId === 'string' && ACCOUNT_RE.test(where.accountId)) accountId = where.accountId;
  // When a replayed event fired, on the node's clock: the time its attention marker
  // carries. Never later than now.
  let firedAt = null;
  if (identity.firedAt !== undefined && identity.firedAt !== null) {
    if (!Number.isSafeInteger(identity.firedAt) || identity.firedAt <= 0) refuse(400, 'identity.firedAt must be a time in milliseconds');
    firedAt = Math.min(identity.firedAt, deps.now ? deps.now() : Date.now());
  }
  const env = {};
  if (identity.env !== undefined && identity.env !== null) {
    if (!isObject(identity.env)) refuse(400, 'identity.env must be an object');
    for (const [key, re] of Object.entries(FORWARDED_ENV)) {
      if (identity.env[key] === undefined || identity.env[key] === null) continue;
      env[key] = matching(identity.env[key], re, `identity.env.${key}`);
    }
  }
  let pane = null;
  if (identity.pane !== undefined && identity.pane !== null) {
    if (typeof identity.pane !== 'string') refuse(400, 'invalid pane ref');
    const parsed = deps.parsePaneRef(identity.pane);
    if (!PANE_ID_RE.test(parsed.paneId)) refuse(400, 'invalid pane ref');
    if (parsed.node !== caller) refuse(403, `pane ${identity.pane} is not on node ${caller}`);
    pane = deps.formatPaneRef(parsed.node, parsed.paneId);
  }
  const transcript = cleanTranscript(body.transcript);
  if (event === TRANSCRIPT_ONLY) {
    if (!transcript) refuse(400, 'a transcript post carries a transcript');
    return { event, sessionId, accountId, pane, transcript, firedAt, env };
  }
  if (typeof body.idempotencyKey !== 'string' || !KEY_RE.test(body.idempotencyKey)) {
    refuse(400, 'idempotencyKey must be 16-128 letters, digits, _ or -');
  }
  const input = cleanInput(event, body.input, sessionId);
  return { event, sessionId, accountId, pane, transcript, firedAt, env, input, idempotencyKey: body.idempotencyKey };
}

// The transcript is left out: its bytes are applied before the journal is read,
// and a resend of the same event may carry a different delta. So is firedAt, which
// only a queued resend of an event carries.
function digestOf(request) {
  return crypto.createHash('sha256').update(`hook:${JSON.stringify([
    request.event, request.input, request.sessionId, request.pane, request.accountId, request.env,
  ])}`).digest('hex');
}

function createHookService(options = {}) {
  const registry = options.registry;
  if (!registry || !registry.shared) throw new Error('createHookService needs the registry service');
  const shared = registry.shared;
  const root = options.root || shared.root;
  const stopping = options.stopping || (() => false);
  const timeoutMs = options.timeoutMs || HOOK_TIMEOUT_MS;
  const now = shared.now;
  // One request at a time per session, from the append to the answer: the mirror's
  // continuity check and the run that reads it must not interleave.
  const sessions = new Map();
  let prunedAt = -Infinity;

  function inSession(key, fn) {
    const tail = sessions.get(key) || Promise.resolve();
    const run = tail.then(fn, fn);
    const settled = run.then(() => {}, () => {});
    sessions.set(key, settled);
    settled.then(() => { if (sessions.get(key) === settled) sessions.delete(key); });
    return run;
  }

  function pruneMirrors() {
    if (now() - prunedAt < PRUNE_EVERY_MS) return;
    prunedAt = now();
    try { mirror.prune(root, { now }); } catch {}
  }

  function applyTranscript(request, caller) {
    const { transcript } = request;
    let result;
    try {
      result = mirror.append({
        root, node: caller, sessionId: request.sessionId, generation: transcript.generation,
        fromOffset: transcript.fromOffset, bytes: transcript.bytes, size: transcript.size,
        mtimeMs: transcript.mtimeMs, sourcePath: transcript.sourcePath, now,
      });
    } catch (error) {
      if (error instanceof mirror.MirrorError) refuse(error.status, error.message);
      throw error;
    }
    if (result.ok) return result;
    if (Number.isInteger(result.needFrom)) {
      return { status: 409, body: { error: `the mirror is at ${result.needFrom}; resend from there`, needFrom: result.needFrom } };
    }
    return { status: result.status || 413, body: { error: result.reason } };
  }

  async function handle(principal, body) {
    try {
      const caller = shared.callerNode(principal);
      const daemon = shared.daemonNode();
      // Only for a session on another node: the daemon's own sessions run their hooks
      // themselves, and a caller naming the daemon would route its panes to itself.
      if (caller === daemon) refuse(403, 'the hook route is for sessions on other nodes');
      const request = validateRequest(body, caller, {
        location: shared.location, parsePaneRef: shared.parsePaneRef, formatPaneRef: shared.formatPaneRef, now,
      });
      if (stopping()) return { status: 503, body: { error: 'daemon restarting' } };
      pruneMirrors();
      return await inSession(`${caller}\0${request.sessionId}`, async () => {
        if (request.transcript) {
          const applied = applyTranscript(request, caller);
          if (applied.status) return applied;
          if (request.event === TRANSCRIPT_ONLY) return { status: 200, body: { ok: true, size: applied.size } };
        }
        // The daemon never reads the node's path: the hook reads the mirror, whether
        // or not this post carried bytes for it.
        const input = { ...request.input, transcript_path: mirror.paths(root, caller, request.sessionId).file };
        const hookRequest = { ...request, input };
        // The forwarded session env first, so nothing it names can replace the
        // route's own variables below it.
        const env = {
          ...request.env,
          ...shared.childEnv({ session: request.sessionId, agent: 'claude', pane: request.pane }, caller, daemon),
          KEEP_HOOK_NODE: caller,
          ...(request.accountId ? { KEEP_AGENT_ACCOUNT_ID: request.accountId } : {}),
          ...(request.firedAt ? { KEEP_HOOK_FIRED_AT: String(request.firedAt) } : {}),
        };
        const answer = await shared.journaled({
          caller, key: request.idempotencyKey, digest: digestOf(hookRequest), queue: `hook\0${caller}\0${request.sessionId}`,
          run: () => shared.spawnKeep(['hook', request.event], { cwd: root, env, stdin: JSON.stringify(input), timeoutMs }),
          what: `keep hook ${request.event} for session ${request.sessionId}`,
        });
        if (answer.status !== 200 && answer.status !== 504) return answer;
        const value = answer.body || {};
        return {
          status: answer.status,
          body: {
            ok: value.ok === true, status: value.status, stdout: value.stdout || '', stderr: value.stderr || '',
            replayed: value.replayed === true,
            ...(value.timedOut ? { timedOut: true } : {}), ...(value.journaled === false ? { journaled: false } : {}),
          },
        };
      });
    } catch (error) {
      if (error instanceof RegistryError) return { status: error.status, body: { error: error.message } };
      return { status: 500, body: { error: error.message } };
    }
  }

  return { handle };
}

module.exports = {
  createHookService, validateRequest, cleanInput, digestOf,
  EVENTS, TRANSCRIPT_ONLY, HOOK_TIMEOUT_MS, INPUT_MAX_BYTES, BODY_MAX_BYTES, TEXT_MAX, FORWARDED_ENV,
};
