'use strict';
// The node's half of an account transfer (bin/account-handoff.js) for a session whose
// pane is on this machine: the questions about an account's configuration that only
// the machine holding that configuration can answer. They ride on the `artifacts`
// verb (bin/session-artifacts.js), version 3, next to the walk that copies the
// session's files between the two accounts.
//
//   auth          { account, kind }                  -> { account, loggedIn, configDirectory }
//                 `claude auth status --json` (Codex: `codex login status`) through the
//                 login shell under the account's profile, as the daemon runs it for an
//                 account of its own. Bounded in time and output; never returns what the
//                 CLI printed, only whether it said logged in and which config directory.
//   shared-setup  { account, cwd }                   -> { account, managed, mcpConfig }
//                 A Claude account's shared setup for one working directory, prepared
//                 here as a launch here would prepare it (the MCP config path the
//                 session's own argv names).
//   compatible    { account, target, kind, cwd?, provider? } -> { ok, reasons }
//                 The source and target account setups compared on this machine, the
//                 same comparison the daemon makes for two accounts of its own.
//   resume-spec   { account, kind: 'codex', sessionId, relPath } -> the Codex resume policy
//                 read from this account's root rollout of the session (the relative path
//                 its artifact list names), with the rollout's path.
//   project-trust { account, path, trust? }          -> { trusted } | { trusted, changed }
//                 Which directory key this Claude account trusts for `path`; with
//                 `trust: true`, accept the folder-trust dialog for exactly `path`.
//
// Every account named must be one this node has configured, with the same id, agent
// and real config directory (the check node-transcript's nodeAccount makes); nothing
// here takes a path to act on beyond an absolute working directory, which is only
// ever read or used as a trust key.

const fs = require('node:fs');
const path = require('node:path');

const OPS = new Set(['auth', 'shared-setup', 'compatible', 'resume-spec', 'project-trust']);
const KINDS = new Set(['claude', 'codex']);
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MESSAGE_MAX = 400;

function coded(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
const invalid = (message) => coded(message, 'artifacts-invalid');
const refused = (message) => coded(message, 'artifacts-refused');
const short = (value) => String(value && value.message || value || '').replace(/[\r\n]+/g, ' ').slice(0, MESSAGE_MAX);

function realpath(value) {
  try { return fs.realpathSync(value); } catch { return null; }
}

function validKind(params, fallback = 'claude') {
  const kind = params.kind === undefined ? fallback : params.kind;
  if (!KINDS.has(kind)) throw invalid('account handoff kind must be claude or codex');
  return kind;
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096 || /[\0\r\n]/.test(value)) {
    throw invalid(`${label} must be an absolute path`);
  }
  return value;
}

// The account as this node has it configured: the whole record (its profile flags
// decide how a login shell runs it), matched on id, agent and real config directory.
function nodeAccount(value, kind, options = {}) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.configDir !== 'string'
      || !path.isAbsolute(value.configDir) || /[\0\r\n]/.test(value.configDir)) {
    throw invalid('account handoff account must name an id and an absolute config directory');
  }
  const list = options.accounts || (() => require('./accounts.js').list(options.env || process.env));
  let accounts;
  try { accounts = list(); } catch (error) { throw refused(`this node's accounts could not be read: ${short(error)}`); }
  const wanted = realpath(value.configDir);
  const match = (Array.isArray(accounts) ? accounts : []).find((entry) => entry && entry.agent === kind
    && entry.id === value.id && typeof entry.configDir === 'string' && wanted && realpath(entry.configDir) === wanted);
  if (!match) throw refused(`${value.id} is not a ${kind} account on this node`);
  return match;
}

async function auth(params, options = {}) {
  const kind = validKind(params);
  const account = nodeAccount(params.account, kind, options);
  const env = options.env || process.env;
  if (kind === 'codex') {
    const loggedIn = await (options.codexAuth || require('./codex-handoff-support.js').authPreflight)(account, { env });
    return { account: account.id, loggedIn: loggedIn === true, configDirectory: null };
  }
  const status = await (options.claudeAuth || require('./account-handoff.js').authStatus)(account, { env });
  return {
    account: account.id,
    loggedIn: Boolean(status && status.loggedIn === true),
    configDirectory: status && typeof status.configDirectory === 'string' ? status.configDirectory.slice(0, 4096) : null,
  };
}

function sharedSetup(params, options = {}) {
  const account = nodeAccount(params.account, 'claude', options);
  const cwd = absolutePath(params.cwd, 'shared setup cwd');
  const setup = options.accountSetup || require('./account-setup.js');
  let manifest;
  try { manifest = setup.readSetup(account); } catch (error) { throw coded(`account shared setup is unavailable: ${short(error)}`, 'shared-setup'); }
  if (!manifest) return { account: account.id, managed: false, mcpConfig: null };
  try {
    return { account: account.id, managed: true, mcpConfig: setup.ensureSharedMemory(account, cwd).mcpConfig || null };
  } catch (error) { throw coded(`account shared setup is unavailable: ${short(error)}`, 'shared-setup'); }
}

function compatible(params, options = {}) {
  const kind = validKind(params);
  const source = nodeAccount(params.account, kind, options);
  const target = nodeAccount(params.target, kind, options);
  let result;
  if (kind === 'codex') {
    if (typeof params.provider !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(params.provider)) {
      throw invalid('a Codex compatibility check names the model provider');
    }
    result = (options.codexSupport || require('./codex-handoff-support.js')).compatible(source, target, { provider: params.provider });
  } else {
    const cwd = absolutePath(params.cwd, 'compatibility cwd');
    result = (options.accountSetup || require('./account-setup.js')).compatible(source, target, cwd);
  }
  return {
    ok: Boolean(result && result.ok === true),
    reasons: (Array.isArray(result && result.reasons) ? result.reasons : []).slice(0, 20).map(short),
  };
}

function resumeSpec(params, options = {}) {
  if (validKind(params, 'codex') !== 'codex') throw invalid('a resume spec is read from a Codex rollout');
  const account = nodeAccount(params.account, 'codex', options);
  if (typeof params.sessionId !== 'string' || !SESSION_ID_RE.test(params.sessionId)) throw invalid('resume spec session id is not a session id');
  // The root rollout by the relative path the account's own artifact list gave, checked
  // against the shape a root rollout has and walked below the account's real directory
  // with no link on the way, as the walk that copies it reads it.
  const artifacts = require('./session-artifacts.js');
  const parts = artifacts.scopedParts(params.relPath, params.sessionId, 'codex');
  if (parts[0] !== 'sessions' || !parts[parts.length - 1].endsWith(`-${params.sessionId}.jsonl`)) {
    throw refused(`${params.relPath} is not the root rollout of ${params.sessionId}`);
  }
  const root = realpath(account.configDir);
  if (!root) throw refused(`${account.id}'s config directory is not on this node`);
  const file = artifacts.resolveUnder(root, parts);
  let spec;
  try { spec = (options.codexSupport || require('./codex-handoff-support.js')).readResumeSpec(file, params.sessionId); }
  catch (error) { throw coded(short(error), 'resume-unavailable'); }
  return { ...spec, file };
}

function projectTrust(params, options = {}) {
  const account = nodeAccount(params.account, 'claude', options);
  const cwd = absolutePath(params.path, 'project trust path');
  const setup = options.accountSetup || require('./account-setup.js');
  if (params.trust !== true) return { trusted: setup.trustedProjectFor(account, cwd) || null };
  let changed;
  try { changed = setup.trustProject(account, cwd) === true; }
  catch (error) { throw coded(`${account.id} could not pre-trust ${cwd}: ${short(error)}`, 'trust-failed'); }
  return { trusted: setup.trustedProjectFor(account, cwd) || null, changed };
}

async function handle(params, options = {}) {
  if (!params || typeof params !== 'object' || !OPS.has(params.op)) throw invalid('not an account handoff op');
  if (params.op === 'auth') return auth(params, options);
  if (params.op === 'shared-setup') return sharedSetup(params, options);
  if (params.op === 'compatible') return compatible(params, options);
  if (params.op === 'resume-spec') return resumeSpec(params, options);
  return projectTrust(params, options);
}

module.exports = { handle, OPS };
