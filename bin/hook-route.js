'use strict';
// POST /api/hook — a Claude, Codex or Pi session's hook on a pane-only node, run on the daemon.
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
// A node acts only for a session the location record places on it with the agent the
// event is for (a Claude event for a Claude session, a codex-* event for a Codex
// one, whose mirror is its rollout, a pi-* event for a Pi one, which has no mirror),
// only on that session's mirror, and only with a pane on itself. A fresh Codex open of
// the daemon's with no location record yet, whose pane on the caller now names it, is
// adopted first (bin/late-adoption.js), as is a Pi session a /new or /resume started in
// the Pi process of a session the daemon opened there.
// The run goes through the registry route's journal (bin/registry-route.js), so a
// resent event replays its answer instead of running again, and a restart waits for
// it. The transcript append is outside the journal and needs none: a post must start
// where the mirror ends, so a resend of bytes already appended writes nothing and
// says where to go on.
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const mirror = require('./transcript-mirror.js');
const { RegistryError } = require('./registry-route.js');

const EVENTS = ['session-start', 'session-end', 'stop', 'notification', 'pre-question', 'lifecycle', 'pre-bash', 'post-bash'];
// A Codex session's hooks: `codex-<action>` runs the daemon's `keep hook codex <action>`.
const CODEX_ACTIONS = ['start', 'end', 'client-end', 'stop', 'question', 'approval', 'complete', 'lifecycle', 'pre-tool', 'post-tool'];
const CODEX_EVENTS = CODEX_ACTIONS.map((action) => `codex-${action}`);
// A Pi session's hooks, the three the Keep Pi extension calls: `pi-<action>` runs the
// daemon's `keep hook pi <action>`. None carries a transcript.
const PI_ACTIONS = ['start', 'end', 'pre-tool'];
const PI_EVENTS = PI_ACTIONS.map((action) => `pi-${action}`);
const agentOf = (event) => (CODEX_EVENTS.includes(event) ? 'codex' : PI_EVENTS.includes(event) ? 'pi' : 'claude');
const isHookEvent = (event) => EVENTS.includes(event) || CODEX_EVENTS.includes(event) || PI_EVENTS.includes(event);
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
  'pre-bash': ['PreToolUse'],
  'post-bash': ['PostToolUse'],
  // session-lifecycle.js EVENTS: what `keep hook lifecycle` records.
  lifecycle: ['SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
    'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'Interrupt'],
  // What Codex names the events its hooks.json wires to `keep hook codex <action>`.
  'codex-start': ['SessionStart'],
  'codex-end': ['SessionEnd'],
  'codex-client-end': [],
  'codex-stop': ['Stop'],
  'codex-question': ['PreToolUse'],
  'codex-approval': ['PermissionRequest'],
  'codex-complete': ['Stop'],
  'codex-pre-tool': ['PreToolUse'],
  'codex-post-tool': ['PostToolUse'],
  'codex-lifecycle': ['SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
    'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'Interrupt'],
};
const PRUNE_EVERY_MS = 60 * 60e3;
// What GET /api/hook/context publishes of the step registries: the command
// fingerprints the step guard matches, as strings, and no more of them than this.
const FINGERPRINTS_MAX = 256;
const FINGERPRINT_MAX_BYTES = 200;
// What the daemon's hook code reads from a session's own environment, forwarded by
// the node in identity.env: a flag, a short token or an id each, never more. Any
// other key is dropped; a listed one of another shape refuses the request.
const FORWARDED_ENV = Object.freeze({
  KEEP_REVIEWER: /^(?:0|1|true|false)$/,
  KEEP_AUTO_CONTINUE: /^(?:0|1|true|false)$/,
  CLAUDE_CODE_ENTRYPOINT: /^[A-Za-z0-9_.-]{1,128}$/,
  KEEP_DELEGATION_ID: /^[A-Za-z0-9_-]{1,128}$/,
  // The two bypasses a session sets for itself, trusted as they are on the daemon
  // node. KEEP_REPAIR is not among them: the daemon decides that (isRepairSession).
  KEEP_STEP_OK: /^[A-Za-z0-9_.-]{1,32}$/,
  KEEP_RAW_CLAUDE: /^[A-Za-z0-9_.-]{1,32}$/,
  // A Codex session's launch token (bin/agent-launcher.js), which its attention
  // markers carry and its client-end clears by; and the Claude session a Codex one
  // was started from, which the daemon records only when it is on the same node.
  KEEP_CODEX_CLIENT_TOKEN: /^[A-Za-z0-9._-]{1,128}$/,
  KEEP_CODEX_PARENT_SESSION: /^[A-Za-z0-9_-]{1,128}$/,
});
// A Bash command, and the repository facts the node posts with it (bin/repo-facts.js).
const COMMAND_MAX_BYTES = 64 * 1024;
const FACT_PATHS_MAX = 8;
const DIRTY_MAX_BYTES = 4096;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

function refuse(status, message, code) { throw new RegistryError(status, message, code); }
// The refusal of a session the location record does not place on the caller: named, so
// a node's Codex start can tell it from any other refusal (bin/commands/hook.js).
const SESSION_NOT_ON_NODE = 'SESSION_NOT_ON_NODE';

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

// A path in the node's repository facts: absolute, no .., and under the fleet's
// shared home, which is the only place a registered step's project can be.
function homePath(value, name, home) {
  absolutePath(value, name);
  if (value !== home && !value.startsWith(home + path.sep)) refuse(400, `${name} must be under the home`);
  return value;
}

function table(value, name) {
  if (!isObject(value)) refuse(400, `${name} must be an object`);
  const keys = Object.keys(value);
  if (keys.length > FACT_PATHS_MAX) refuse(400, `${name} names more than ${FACT_PATHS_MAX} paths`);
  return keys;
}

// input.repo_facts, rebuilt: { paths: { base: { top, main } }, deploy, head }. Data
// the daemon's hook reads in place of the git it would run for a local session;
// nothing in it is ever run, and a field of the wrong shape refuses the request.
function cleanRepoFacts(value, home) {
  if (!isObject(value)) refuse(400, 'input.repo_facts is required for a Bash hook');
  const out = { paths: {}, deploy: null, head: {} };
  if (value.paths !== undefined) {
    for (const base of table(value.paths, 'repo_facts.paths')) {
      homePath(base, 'a repo_facts path', home);
      const entry = value.paths[base];
      if (!isObject(entry)) refuse(400, 'a repo_facts.paths entry must be an object');
      const fact = {};
      for (const key of ['top', 'main']) {
        fact[key] = entry[key] === null || entry[key] === undefined ? null : homePath(entry[key], `repo_facts ${key}`, home);
      }
      out.paths[base] = fact;
    }
  }
  if (value.head !== undefined) {
    for (const top of table(value.head, 'repo_facts.head')) {
      homePath(top, 'a repo_facts.head path', home);
      out.head[top] = matching(value.head[top], SHA_RE, 'repo_facts.head sha');
    }
  }
  if (value.deploy !== undefined && value.deploy !== null) {
    const deploy = value.deploy;
    if (!isObject(deploy)) refuse(400, 'repo_facts.deploy must be an object or null');
    if (!Array.isArray(deploy.dirty)) refuse(400, 'repo_facts.deploy.dirty must be a list');
    let bytes = 0;
    const dirty = deploy.dirty.map((file) => {
      text(file, 'a repo_facts.deploy.dirty entry', DIRTY_MAX_BYTES);
      bytes += Buffer.byteLength(file);
      return file;
    });
    if (bytes > DIRTY_MAX_BYTES) refuse(400, `repo_facts.deploy.dirty is longer than ${DIRTY_MAX_BYTES} bytes`);
    if (deploy.onOrigin !== null && deploy.onOrigin !== undefined && typeof deploy.onOrigin !== 'boolean') {
      refuse(400, 'repo_facts.deploy.onOrigin must be a boolean or null');
    }
    out.deploy = {
      dir: homePath(deploy.dir, 'repo_facts.deploy.dir', home),
      repo: homePath(deploy.repo, 'repo_facts.deploy.repo', home),
      sha: matching(deploy.sha, SHA_RE, 'repo_facts.deploy.sha'),
      dirty,
      branch: deploy.branch === null || deploy.branch === undefined ? null : matching(deploy.branch, BRANCH_RE, 'repo_facts.deploy.branch'),
      onOrigin: typeof deploy.onOrigin === 'boolean' ? deploy.onOrigin : null,
    };
  }
  return out;
}

// What a Bash call answered, as the deploy and step-run recorders read it: its
// output fields as strings of at most 64 KiB, its exit code, whether it was
// interrupted. A bare string is output. Nothing else of it reaches the hook.
function bashResponse(value) {
  if (typeof value === 'string') return text(value, 'input.tool_response', TEXT_MAX);
  if (!isObject(value)) refuse(400, 'input.tool_response must be an object or a string');
  const out = {};
  for (const key of ['stdout', 'stderr', 'output']) {
    if (value[key] !== undefined && value[key] !== null) out[key] = text(value[key], `input.tool_response.${key}`, TEXT_MAX);
  }
  for (const key of ['exit_code', 'exitCode']) {
    if (value[key] === undefined || value[key] === null) continue;
    if (!Number.isSafeInteger(value[key])) refuse(400, `input.tool_response.${key} must be an integer`);
    out[key] = value[key];
  }
  if (value.interrupted !== undefined && value.interrupted !== null) {
    if (typeof value.interrupted !== 'boolean') refuse(400, 'input.tool_response.interrupted must be a boolean');
    out.interrupted = value.interrupted;
  }
  return out;
}

// A Bash hook's tool call: the command and nothing else of its input.
function bashInput(input, event, out, home) {
  if (input.tool_name !== 'Bash') refuse(400, `${event} is for Bash only`);
  out.tool_name = 'Bash';
  if (!isObject(input.tool_input)) refuse(400, 'input.tool_input must be an object');
  out.tool_input = { command: text(input.tool_input.command, 'input.tool_input.command', COMMAND_MAX_BYTES) };
  if (input.tool_use_id !== undefined && input.tool_use_id !== null) out.tool_use_id = matching(input.tool_use_id, ID_RE, 'input.tool_use_id');
  out.repo_facts = cleanRepoFacts(input.repo_facts, home);
}

// The hook's stdin, as Claude Code sends it for this event, rebuilt from the fields
// the daemon's hook code reads. Anything else is dropped; a known field of the
// wrong shape refuses the request.
function cleanInput(event, input, sessionId, options = {}) {
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
  if (event === 'pre-bash' || event === 'post-bash') bashInput(input, event, out, options.home || os.homedir());
  if (event === 'post-bash' && input.tool_response !== undefined && input.tool_response !== null) {
    out.tool_response = bashResponse(input.tool_response);
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

const CLIENT_TOKEN_RE = /^[A-Za-z0-9._-]{1,256}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const COMMAND_ARGS_MAX = 256;

// A Codex shell call's command: a script, or an argv array of strings, bounded as a
// Bash command is. Nothing of it is run; the daemon's step guard and recorders read it.
function codexCommand(value) {
  if (typeof value === 'string') return text(value, 'input.tool_input.command', COMMAND_MAX_BYTES);
  if (!Array.isArray(value) || !value.length || value.length > COMMAND_ARGS_MAX) {
    refuse(400, 'input.tool_input.command must be a string or a list of at most 256 strings');
  }
  let bytes = 0;
  for (const arg of value) {
    text(arg, 'an input.tool_input.command entry', COMMAND_MAX_BYTES);
    bytes += Buffer.byteLength(arg);
  }
  if (bytes > COMMAND_MAX_BYTES) refuse(400, `input.tool_input.command is longer than ${COMMAND_MAX_BYTES} bytes`);
  return [...value];
}

// A Codex hook's stdin, rebuilt from the fields `keep hook codex <action>` reads, as
// cleanInput does for Claude's. client-end carries only its launch token and no
// session: the daemon's hook clears the markers that carry that token, and only for
// sessions on the calling node (KEEP_HOOK_NODE).
function cleanCodexInput(event, input, sessionId, options = {}) {
  if (!isObject(input)) refuse(400, 'input must be the hook\'s stdin object');
  let size;
  try { size = Buffer.byteLength(JSON.stringify(input)); } catch { refuse(400, 'input is not JSON'); }
  if (size > INPUT_MAX_BYTES) refuse(400, `input is larger than ${INPUT_MAX_BYTES} bytes`);
  const has = (key) => input[key] !== undefined && input[key] !== null;
  if (event === 'codex-client-end') return { client_token: matching(input.client_token, CLIENT_TOKEN_RE, 'input.client_token') };
  if (input.session_id !== sessionId) refuse(400, 'input.session_id must be the identity\'s session');
  const out = { session_id: sessionId, cwd: absolutePath(input.cwd, 'input.cwd') };
  if (has('transcript_path')) text(input.transcript_path, 'input.transcript_path', PATH_MAX);
  if (has('hook_event_name')) {
    out.hook_event_name = matching(input.hook_event_name, /^[A-Za-z]{1,64}$/, 'input.hook_event_name');
    if (!HOOK_EVENT_NAMES[event].includes(out.hook_event_name)) refuse(400, `input.hook_event_name ${out.hook_event_name} is not a ${event} event`);
  } else if (event === 'codex-lifecycle') refuse(400, 'input.hook_event_name is required for codex-lifecycle');
  // The Stop guard reads the permission mode (a session in plan mode is not nagged), so
  // it is admitted. Codex's names are hyphenated (on-request, on-failure); one of
  // another shape is dropped and the event kept, because refusing a stop would lose its
  // completion marker. Codex's model and agent type are read by none of its hooks, and
  // are dropped with everything else unknown.
  if (typeof input.permission_mode === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(input.permission_mode)) {
    out.permission_mode = input.permission_mode;
  }
  if (has('source')) out.source = matching(input.source, /^[a-z_]{1,32}$/, 'input.source');
  for (const key of ['turn_id', 'agent_id']) if (has(key)) out[key] = matching(input[key], ID_RE, `input.${key}`);
  if (has('stop_hook_active')) {
    if (typeof input.stop_hook_active !== 'boolean') refuse(400, 'input.stop_hook_active must be a boolean');
    out.stop_hook_active = input.stop_hook_active;
  }
  if (has('last_assistant_message')) out.last_assistant_message = text(input.last_assistant_message, 'input.last_assistant_message');
  if (has('tool_name')) out.tool_name = matching(input.tool_name, TOOL_NAME_RE, 'input.tool_name');
  for (const key of ['tool_use_id', 'call_id']) if (has(key)) out[key] = matching(input[key], ID_RE, `input.${key}`);
  if (event === 'codex-question' && has('tool_input')) {
    if (!isObject(input.tool_input)) refuse(400, 'input.tool_input must be an object');
    out.tool_input = questionInput(input.tool_input);
    // codexAttentionMarker reads a question's title where it has no question text.
    const first = Array.isArray(input.tool_input.questions) && isObject(input.tool_input.questions[0]) ? input.tool_input.questions[0] : null;
    if (first && typeof first.title === 'string' && out.tool_input.questions[0]) out.tool_input.questions[0].title = clipBytes(first.title, 4096);
  }
  if (event === 'codex-approval' && has('tool_input')) {
    if (!isObject(input.tool_input)) refuse(400, 'input.tool_input must be an object');
    const tool = {};
    if (typeof input.tool_input.description === 'string') tool.description = clipBytes(input.tool_input.description, 4096);
    for (const key of ['tool_name', 'toolName']) {
      if (typeof input.tool_input[key] === 'string') tool[key] = matching(input.tool_input[key], TOOL_NAME_RE, `input.tool_input.${key}`);
    }
    out.tool_input = tool;
  }
  if (event === 'codex-pre-tool' || event === 'codex-post-tool') {
    if (!out.tool_name) refuse(400, `${event} needs input.tool_name`);
    if (!isObject(input.tool_input)) refuse(400, 'input.tool_input must be an object');
    const tool = { command: codexCommand(input.tool_input.command) };
    for (const key of ['workdir', 'cwd']) {
      if (input.tool_input[key] !== undefined && input.tool_input[key] !== null) tool[key] = absolutePath(input.tool_input[key], `input.tool_input.${key}`);
    }
    out.tool_input = tool;
    out.repo_facts = cleanRepoFacts(input.repo_facts, options.home || os.homedir());
    if (event === 'codex-post-tool' && has('tool_response')) out.tool_response = bashResponse(input.tool_response);
  }
  if (event === 'codex-lifecycle' && has('tool_input')) {
    if (!isObject(input.tool_input)) refuse(400, 'input.tool_input must be an object');
    const tool = {};
    for (const key of ['command', 'cmd', 'code', 'description']) {
      if (typeof input.tool_input[key] === 'string') tool[key] = input.tool_input[key].slice(0, 4096);
    }
    out.tool_input = tool;
  }
  return out;
}

// The Pi extension's instance id (a random UUID), which a Pi end must match to
// release what its start bound.
const PI_INSTANCE_RE = /^[a-f0-9-]{36}$/;

// A Pi hook's stdin, rebuilt from what `keep hook pi <action>` reads: the session,
// its directory, the extension instance and process, and for a pre-tool the Bash
// command with the node's repository facts (bashInput, as for Claude's pre-bash). A
// background worker's job id and token are dropped: Pi workers do not run on nodes.
function cleanPiInput(event, input, sessionId, options = {}) {
  if (!isObject(input)) refuse(400, 'input must be the hook\'s stdin object');
  let size;
  try { size = Buffer.byteLength(JSON.stringify(input)); } catch { refuse(400, 'input is not JSON'); }
  if (size > INPUT_MAX_BYTES) refuse(400, `input is larger than ${INPUT_MAX_BYTES} bytes`);
  if (input.session_id !== sessionId) refuse(400, 'input.session_id must be the identity\'s session');
  const out = { session_id: sessionId, cwd: absolutePath(input.cwd, 'input.cwd') };
  const has = (key) => input[key] !== undefined && input[key] !== null;
  if (has('instance')) out.instance = matching(input.instance, PI_INSTANCE_RE, 'input.instance');
  if (has('pid')) {
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0) refuse(400, 'input.pid must be a process id');
    out.pid = input.pid;
  }
  if (event === 'pi-pre-tool') bashInput(input, event, out, options.home || os.homedir());
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
  if (event !== TRANSCRIPT_ONLY && !isHookEvent(event)) {
    refuse(400, `${JSON.stringify(String(event))} is not a hook event`);
  }
  const identity = body.identity;
  if (!isObject(identity)) refuse(400, 'identity is required');
  if (!['claude', 'codex', 'pi'].includes(identity.agent)) refuse(400, 'only Claude, Codex and Pi hooks are carried to the daemon');
  const agent = identity.agent;
  if (agent === 'pi' && event === TRANSCRIPT_ONLY) refuse(400, 'a Pi session posts no transcript');
  if (event !== TRANSCRIPT_ONLY && agentOf(event) !== agent) {
    if (agent === 'pi' || agentOf(event) === 'pi') refuse(400, `${event} is a ${agentOf(event)} hook, not a ${agent} one; a Pi session posts pi-* events`);
    refuse(400, agent === 'codex' ? `${event} is a Claude hook; a Codex session posts codex-* events` : `${event} is a Codex hook, not a Claude one`);
  }
  // A Codex client-end is the launcher's, after the TUI exited: it names no session,
  // only the launch token, and the daemon's hook acts on this node's sessions alone.
  const sessionless = event === 'codex-client-end' && (identity.sessionId === undefined || identity.sessionId === null);
  const sessionId = sessionless ? null : matching(identity.sessionId, SESSION_RE, 'session id');
  let accountId = null;
  if (identity.accountId !== undefined && identity.accountId !== null) accountId = matching(identity.accountId, ACCOUNT_RE, 'account id');
  if (!sessionless) {
    let where = null;
    try { where = deps.location(sessionId); } catch { where = null; }
    if (!where || where.node !== caller) refuse(403, `session ${sessionId} is not on node ${caller}`, SESSION_NOT_ON_NODE);
    if (where.agent !== agent) refuse(403, `session ${sessionId} is a ${where.agent} session, not ${agent}`);
    if (accountId && where.accountId && accountId !== where.accountId) {
      refuse(403, `session ${sessionId} runs on account ${where.accountId}, not ${accountId}`);
    }
    // The daemon's record is the authority; the node's word only fills a gap in it.
    if (typeof where.accountId === 'string' && ACCOUNT_RE.test(where.accountId)) accountId = where.accountId;
  }
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
  if (agent === 'pi' && transcript) refuse(400, 'a Pi hook carries no transcript');
  if (event === TRANSCRIPT_ONLY) {
    if (!transcript) refuse(400, 'a transcript post carries a transcript');
    return { event, agent, sessionId, accountId, pane, transcript, firedAt, env };
  }
  if (sessionless && transcript) refuse(400, 'a client-end without a session carries no transcript');
  if (typeof body.idempotencyKey !== 'string' || !KEY_RE.test(body.idempotencyKey)) {
    refuse(400, 'idempotencyKey must be 16-128 letters, digits, _ or -');
  }
  const input = agent === 'codex'
    ? cleanCodexInput(event, body.input, sessionId, { home: deps.home })
    : agent === 'pi' ? cleanPiInput(event, body.input, sessionId, { home: deps.home })
    : cleanInput(event, body.input, sessionId, { home: deps.home });
  return { event, agent, sessionId, accountId, pane, transcript, firedAt, env, input, idempotencyKey: body.idempotencyKey };
}

// The transcript is left out: its bytes are applied before the journal is read,
// and a resend of the same event may carry a different delta. So is firedAt, which
// only a queued resend of an event carries.
function digestOf(request) {
  return crypto.createHash('sha256').update(`hook:${JSON.stringify([
    request.event, request.input, request.sessionId, request.pane, request.accountId, request.env,
  ])}`).digest('hex');
}

// Every guarded step's command fingerprints (steps.stepFingerprints), deduplicated
// and bounded: what a node's pre-bash hook needs to tell whether a command could be
// a gated step before it computes that command's repository facts, and what it
// refuses by when the daemon cannot answer. Data only; a fingerprint that is not
// one printable line is left out.
function publishedFingerprints(root) {
  const stepRegistry = require('./steps.js');
  const out = new Set();
  for (const registry of stepRegistry.registeredSteps(root)) {
    for (const step of Object.values(registry.steps || {})) {
      let list = [];
      try { list = stepRegistry.stepFingerprints(step); } catch { list = []; }
      for (const value of list) {
        const text = String(value).trim();
        if (!text || /[\u0000-\u001f\u007f]/.test(text) || Buffer.byteLength(text) > FINGERPRINT_MAX_BYTES) continue;
        out.add(text);
      }
    }
  }
  return [...out].sort().slice(0, FINGERPRINTS_MAX);
}

// Whether the daemon's self-repair scheduler launched this session for a repair
// card. Never the node's word: its KEEP_REPAIR is not forwarded. cardForSession
// reads a state file that loadState answers as empty when it is corrupt, so the
// file is checked first: one that is there and unreadable answers yes, as does a
// lookup that throws. Yes only ever refuses more.
function isRepairSession(deps, sessionId, root) {
  try {
    if (deps.stateUnreadable(root)) return true;
    return Boolean(deps.cardForSession(sessionId, root));
  } catch { return true; }
}

function createHookService(options = {}) {
  const registry = options.registry;
  if (!registry || !registry.shared) throw new Error('createHookService needs the registry service');
  const shared = registry.shared;
  const root = options.root || shared.root;
  const stopping = options.stopping || (() => false);
  const timeoutMs = options.timeoutMs || HOOK_TIMEOUT_MS;
  const now = shared.now;
  // The fleet shares one home path; the node's repository facts must lie under it.
  const home = options.home || (shared.baseEnv && shared.baseEnv.HOME) || os.homedir();
  const repairDeps = {
    cardForSession: options.cardForSession || ((sessionId, at) => require('./self-repair.js').cardForSession(sessionId, at)),
    stateUnreadable: options.repairStateUnreadable || ((at) => require('./self-repair.js').stateUnreadable(at)),
  };
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
      const deps = { location: shared.location, parsePaneRef: shared.parsePaneRef, formatPaneRef: shared.formatPaneRef, now, home };
      // A session the caller's host shows but the daemon never heard register
      // (bin/late-adoption.js), asked only for a well-formed event of its agent, and
      // only for a post that is otherwise sound: checked first as if the session were
      // on the caller, so a post the route would refuse on its own pins nothing. A post
      // that names no pane is not from one of Keep's panes (every host pane carries
      // KEEP_PANE, and the node's own bind needs it), so it never asks the node's host.
      // A Pi session is asked about only from its start: the one Pi post that names the
      // extension instance and process a /new or /resume inside Pi is adopted by.
      const identity = isObject(body) && isObject(body.identity) ? body.identity : null;
      const piStart = identity && identity.agent === 'pi' && body.event === 'pi-start';
      const ofItsAgent = identity && typeof identity.pane === 'string' && identity.pane !== ''
        && (piStart || (identity.agent !== 'pi' && (body.event === TRANSCRIPT_ONLY
        || ((EVENTS.includes(body.event) || CODEX_EVENTS.includes(body.event)) && agentOf(body.event) === identity.agent))));
      if (ofItsAgent && typeof shared.adopt === 'function' && shared.unlocated(identity.sessionId)) {
        const checked = validateRequest(body, caller, { ...deps, location: () => ({ node: caller, agent: identity.agent }) });
        // And again inside the adoption, with the account it would pin, before it pins:
        // a post naming another account is refused with nothing pinned.
        const verify = (where) => validateRequest(body, caller, { ...deps, location: () => where });
        await shared.adopt(caller, identity.sessionId, identity.agent, { pane: identity.pane, verify,
          ...(piStart ? { pi: { instance: checked.input.instance, pid: checked.input.pid } } : {}) });
      }
      const request = validateRequest(body, caller, deps);
      if (stopping()) return { status: 503, body: { error: 'daemon restarting' } };
      pruneMirrors();
      const scope = request.sessionId || '\0client-end';
      return await inSession(`${caller}\0${scope}`, async () => {
        if (request.transcript) {
          const applied = applyTranscript(request, caller);
          if (applied.status) return applied;
          if (request.event === TRANSCRIPT_ONLY) return { status: 200, body: { ok: true, size: applied.size } };
        }
        // The daemon never reads the node's path: the hook reads the mirror, whether
        // or not this post carried bytes for it. A client-end names no session and
        // reads no transcript, and a Pi hook has none.
        const input = request.sessionId && request.agent !== 'pi'
          ? { ...request.input, transcript_path: mirror.paths(root, caller, request.sessionId).file } : request.input;
        const hookRequest = { ...request, input };
        const argv = request.agent === 'codex' ? ['hook', 'codex', request.event.slice('codex-'.length)]
          : request.agent === 'pi' ? ['hook', 'pi', request.event.slice('pi-'.length)]
          : ['hook', request.event];
        // The forwarded session env first, so nothing it names can replace the
        // route's own variables below it.
        const env = {
          ...request.env,
          ...shared.childEnv({ session: request.sessionId, agent: request.agent, pane: request.pane }, caller, daemon),
          KEEP_HOOK_NODE: caller,
          ...(request.accountId ? { KEEP_AGENT_ACCOUNT_ID: request.accountId } : {}),
          ...(request.firedAt ? { KEEP_HOOK_FIRED_AT: String(request.firedAt) } : {}),
          // The self-repair guard's marker, from the daemon's own record of which
          // sessions it launched to repair it, never from the node.
          ...((request.event === 'pre-bash' || request.event === 'pi-pre-tool')
            && isRepairSession(repairDeps, request.sessionId, root) ? { KEEP_REPAIR: '1' } : {}),
        };
        const answer = await shared.journaled({
          caller, key: request.idempotencyKey, digest: digestOf(hookRequest), queue: `hook\0${caller}\0${scope}`,
          run: () => shared.spawnKeep(argv, { cwd: root, env, stdin: JSON.stringify(input), timeoutMs }),
          what: `keep ${argv.join(' ')} for ${request.sessionId ? `session ${request.sessionId}` : `node ${caller}`}`,
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
      if (error instanceof RegistryError) return { status: error.status, body: { error: error.message, ...(error.code ? { code: error.code } : {}) } };
      return { status: 500, body: { error: error.message } };
    }
  }

  // GET /api/hook/context?session=<id>: what a node's pre-bash hook reads before
  // it posts, and falls back on when the daemon does not answer the post. Only for
  // a Claude, Codex or Pi session the location record places on the calling node.
  // `pane` and `agent` are the node's identity for the session, as a post carries them:
  // a Codex session the daemon never heard register is adopted first, as handle()
  // adopts one, so a pre-tool that asks before any post has been admitted is answered.
  // A request naming no pane never asks the node's host.
  async function context(principal, sessionId, options = {}) {
    try {
      const caller = shared.callerNode(principal);
      if (caller === shared.daemonNode()) refuse(403, 'the hook route is for sessions on other nodes');
      const session = matching(sessionId, SESSION_RE, 'session id');
      const agent = options.agent === undefined || options.agent === null || options.agent === '' ? null : options.agent;
      if (agent !== null && !['claude', 'codex', 'pi'].includes(agent)) refuse(400, 'agent must be claude, codex or pi');
      let pane = null;
      if (options.pane !== undefined && options.pane !== null && options.pane !== '') {
        if (typeof options.pane !== 'string') refuse(400, 'invalid pane ref');
        let parsed;
        try { parsed = shared.parsePaneRef(options.pane); } catch { refuse(400, 'invalid pane ref'); }
        if (!parsed || !PANE_ID_RE.test(parsed.paneId)) refuse(400, 'invalid pane ref');
        if (parsed.node !== caller) refuse(403, `pane ${options.pane} is not on node ${caller}`);
        pane = shared.formatPaneRef(parsed.node, parsed.paneId);
      }
      if (agent === 'codex' && pane && typeof shared.adopt === 'function' && shared.unlocated(session)) {
        const verify = (where) => {
          if (!where || where.node !== caller) refuse(403, `session ${session} is not on node ${caller}`, SESSION_NOT_ON_NODE);
          if (where.agent !== agent) refuse(403, `session ${session} is a ${where.agent} session, not ${agent}`);
        };
        await shared.adopt(caller, session, agent, { pane, verify });
      }
      let where = null;
      try { where = shared.location(session); } catch { where = null; }
      if (!where || where.node !== caller) refuse(403, `session ${session} is not on node ${caller}`, SESSION_NOT_ON_NODE);
      // A Codex session's pre-tool, and a Pi one's, refuse by the same fingerprints a
      // Claude one's pre-bash does, and compute their repository facts by them.
      if (!['claude', 'codex', 'pi'].includes(where.agent)) refuse(403, `session ${session} is a ${where.agent} session, not claude, codex or pi`);
      return { status: 200, body: { steps: publishedFingerprints(root), repairSession: isRepairSession(repairDeps, session, root) } };
    } catch (error) {
      if (error instanceof RegistryError) return { status: error.status, body: { error: error.message, ...(error.code ? { code: error.code } : {}) } };
      return { status: 500, body: { error: error.message } };
    }
  }

  return { handle, context };
}

module.exports = {
  createHookService, validateRequest, cleanInput, cleanCodexInput, cleanPiInput, digestOf, publishedFingerprints,
  cleanRepoFacts, EVENTS, CODEX_EVENTS, CODEX_ACTIONS, PI_EVENTS, PI_ACTIONS, FINGERPRINTS_MAX, FINGERPRINT_MAX_BYTES, COMMAND_MAX_BYTES, TRANSCRIPT_ONLY, HOOK_TIMEOUT_MS, INPUT_MAX_BYTES, BODY_MAX_BYTES, TEXT_MAX, FORWARDED_ENV,
};
