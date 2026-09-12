'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const toml = require('@iarna/toml');

function unavailable(message) {
  return Object.assign(new Error(`Codex native handoff unavailable: ${message}`), { status: 409, code: 'KEEP_CODEX_HANDOFF_UNSUPPORTED' });
}
function onlyKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}
function absolute(value) { return typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'); }
function special(kind, access) { return { path: { type: 'special', value: { kind } }, access }; }
function localPath(file, access, missing = false) {
  return { path: { type: 'path', path: file }, access, ...(missing ? { missing_path_behavior: 'skip' } : {}) };
}
function sameEntries(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const rest = [...b];
  for (const item of a) {
    const i = rest.findIndex((entry) => isDeepStrictEqual(item, entry));
    if (i < 0) return false;
    rest.splice(i, 1);
  }
  return true;
}

// Compare the effective permission profile as well as the legacy sandbox label.
// A custom profile can otherwise say workspace-write while protecting more paths.
function policyArgs(context) {
  const policy = context.sandbox_policy;
  const mode = policy?.type;
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(mode)) throw unavailable('sandbox policy cannot be reproduced; use a fresh handoff');
  const active = context.active_permission_profile;
  if (active != null && (!onlyKeys(active, ['id']) || active.id !== `:${mode}`)) throw unavailable('named permission profile requires a fresh handoff');
  const approval = context.approval_policy;
  if (!['never', 'on-request', 'untrusted'].includes(approval)) throw unavailable('approval policy cannot be reproduced');
  const reviewer = context.approvals_reviewer ?? 'user';
  if (!['user', 'auto_review', 'guardian_subagent'].includes(reviewer)) throw unavailable('approval reviewer cannot be reproduced');
  const roots = context.workspace_roots;
  if (!absolute(context.cwd) || !Array.isArray(roots) || roots.length !== 1 || roots[0] !== context.cwd) throw unavailable('multiple or unknown workspace roots require a fresh handoff');
  const argv = ['--sandbox', mode, '--ask-for-approval', approval, '-c', `approvals_reviewer=${JSON.stringify(reviewer)}`];
  let expected;
  if (mode === 'danger-full-access') {
    if (!onlyKeys(policy, ['type'])) throw unavailable('custom unrestricted policy requires a fresh handoff');
    expected = { type: 'disabled' };
  } else {
    const entries = [special('root', 'read')];
    let network = 'restricted';
    if (mode === 'read-only') {
      if (!onlyKeys(policy, ['type'])) throw unavailable('custom read restrictions require a fresh handoff');
    } else {
      if (!onlyKeys(policy, ['type', 'writable_roots', 'network_access', 'exclude_tmpdir_env_var', 'exclude_slash_tmp'])
          || ['network_access', 'exclude_tmpdir_env_var', 'exclude_slash_tmp'].some((key) => policy[key] != null && typeof policy[key] !== 'boolean')) throw unavailable('custom workspace policy requires a fresh handoff');
      const writable = policy.writable_roots ?? [];
      if (!Array.isArray(writable) || writable.some((root) => !absolute(root)) || new Set(writable).size !== writable.length) throw unavailable('invalid writable roots');
      const writeRoots = [...new Set([context.cwd, ...writable])];
      for (const root of writeRoots) entries.push(localPath(root, 'write'));
      if (!policy.exclude_slash_tmp) entries.push(special('slash_tmp', 'write'));
      if (!policy.exclude_tmpdir_env_var) entries.push(special('tmpdir', 'write'));
      for (const root of writeRoots) for (const name of ['.git', '.agents', '.codex']) entries.push(localPath(path.join(root, name), 'read', true));
      for (const key of ['network_access', 'exclude_tmpdir_env_var', 'exclude_slash_tmp']) argv.push('-c', `sandbox_workspace_write.${key}=${policy[key] === true}`);
      // Override the target's additional writable roots, including an empty list.
      argv.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(writable)}`);
      network = policy.network_access ? 'enabled' : 'restricted';
    }
    expected = { type: 'managed', file_system: { type: 'restricted', entries }, network };
  }
  const profile = context.permission_profile;
  const matches = mode === 'danger-full-access' ? isDeepStrictEqual(profile, expected)
    : onlyKeys(profile, ['type', 'file_system', 'network']) && profile.type === expected.type && profile.network === expected.network
      && onlyKeys(profile.file_system, ['type', 'entries']) && profile.file_system.type === 'restricted'
      && sameEntries(profile.file_system.entries, expected.file_system.entries);
  if (!matches) throw unavailable('effective permissions differ from the standard sandbox policy; use a fresh handoff');
  return argv;
}

function readResumeSpec(file, sessionId, options = {}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId || '')) throw unavailable('source session identity is invalid');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let contents;
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > (options.maxBytes || 128 * 1024 * 1024)) throw unavailable('rollout is not a bounded regular file');
    contents = fs.readFileSync(fd, 'utf8');
    const after = fs.fstatSync(fd);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some((key) => before[key] !== after[key])) throw unavailable('rollout changed while reading launch settings');
  } finally { fs.closeSync(fd); }
  let meta, context;
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { throw unavailable('rollout has incomplete records'); }
    if (row.type === 'session_meta') {
      if (meta) throw unavailable('rollout has multiple session identities');
      meta = row.payload;
    }
    if (row.type === 'turn_context') context = row.payload;
  }
  if (!meta || meta.id !== sessionId || (meta.session_id && meta.session_id !== sessionId)) throw unavailable('rollout identity does not match the source');
  if (meta.parent_thread_id || meta.source?.subagent) throw unavailable('transfer the owning root conversation instead of a child');
  if (!context) throw unavailable('effective turn settings are missing');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(context.model || '') || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(context.effort)) throw unavailable('model or reasoning effort is unavailable');
  const provider = meta.model_provider || 'openai';
  if (!/^[A-Za-z0-9_-]+$/.test(provider)) throw unavailable('model provider is invalid');
  const argv = ['codex', ...policyArgs(context), '-m', context.model, '-c', `model_reasoning_effort=${JSON.stringify(context.effort)}`, 'resume', sessionId];
  const spec = { sessionId, cwd: context.cwd, model: context.model, effort: context.effort, provider, argv };
  return { ...spec, digest: crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex') };
}

function compatible(source, target, spec) {
  try {
    if (source?.agent !== 'codex' || target?.agent !== 'codex') throw unavailable('source and destination must both be Codex');
    const config = (account) => {
      try { return toml.parse(fs.readFileSync(path.join(account.configDir, 'config.toml'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    };
    const a = config(source), b = config(target);
    if ((a.model_provider || 'openai') !== spec.provider || (b.model_provider || 'openai') !== spec.provider) throw unavailable('destination uses a different model provider');
    const provider = (value) => {
      const definition = { ...(value.model_providers?.[spec.provider] || {}) };
      delete definition.env_key; delete definition.experimental_bearer_token;
      return definition;
    };
    if (!isDeepStrictEqual(provider(a), provider(b))) throw unavailable('provider endpoint or protocol settings differ');
    return { ok: true, reasons: [], mcpConfig: null };
  } catch (error) { return { ok: false, reasons: [error.code ? error.message : 'Codex provider configuration could not be verified'], mcpConfig: null }; }
}

function runAuthStatus(account, options = {}) {
  return new Promise((resolve) => {
    const command = (options.profileCommand || require('./agent-launcher').profileCommand)(['codex', 'login', 'status'], account);
    const child = spawn('/bin/zsh', ['-lic', `exec ${command}`], { env: options.env || process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, failed = false;
    const stop = () => { failed = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(stop, options.timeoutMs || 15000);
    const collect = (chunk) => { size += chunk.length; if (size > 256 * 1024) stop(); else chunks.push(chunk); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(!failed && code === 0 && /(?:^|\n)Logged in using (?:ChatGPT|API key)\b/.test(Buffer.concat(chunks).toString()));
    });
  });
}
async function authPreflight(account, options = {}) {
  if (account?.agent !== 'codex' || !absolute(account.configDir)) return false;
  try { return await (options.runAuthStatus || runAuthStatus)(account, options) === true; } catch { return false; }
}

module.exports = { readResumeSpec, policyArgs, compatible, authPreflight };
