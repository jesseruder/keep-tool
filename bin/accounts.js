'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AGENTS = ['claude', 'codex'];
const CUSTOM_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ID_RE = /^(?:[a-z0-9][a-z0-9_-]{0,63}|(?:claude|codex)\/default)$/;

function expand(value) {
  return path.resolve(String(value).replace(/^~(?=\/|$)/, os.homedir()));
}
function physical(value) {
  try { return fs.realpathSync(value); } catch {
    let parent = path.dirname(value);
    while (parent !== path.dirname(parent)) {
      try { return path.join(fs.realpathSync(parent), path.relative(parent, value)); } catch { parent = path.dirname(parent); }
    }
    return value;
  }
}

function builtIn(agent) {
  return {
    id: `${agent}/default`,
    label: agent === 'claude' ? 'Claude (default)' : 'Codex (default)',
    agent,
    configDir: path.join(os.homedir(), `.${agent}`),
    builtIn: true,
  };
}

function rawConfig(env = process.env) {
  // Match config.apply(): an explicit data directory is an isolated registry.
  if (env.KEEP_DIR && !env.KEEP_CONFIG) return { version: 1 };
  const file = require('./config').configFile(env);
  if (!fs.existsSync(file)) return { version: 1 };
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || value.version !== 1 || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`unsupported Keep configuration: ${file}`);
  }
  return value;
}

function validated(env = process.env, config = rawConfig(env)) {
  if (config.accounts != null && !Array.isArray(config.accounts)) throw new Error('accounts must be an array');
  const configured = config.accounts || [];
  const records = [];
  const ids = new Set();
  const dirs = new Set();
  for (const entry of configured) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('each account must be an object');
    const id = String(entry.id || '');
    const label = String(entry.label || '').trim();
    const agent = String(entry.agent || '');
    if (!ID_RE.test(id)) throw new Error(`invalid account id: ${id || '(empty)'}`);
    if (!label || label.length > 100 || /[\r\n]/.test(label)) throw new Error(`invalid account label for ${id}`);
    if (!AGENTS.includes(agent)) throw new Error(`invalid agent for account ${id}`);
    if (typeof entry.configDir !== 'string' || !entry.configDir.trim() || /[\r\n]/.test(entry.configDir)) {
      throw new Error(`invalid configDir for account ${id}`);
    }
    const configDir = expand(entry.configDir);
    if (ids.has(id)) throw new Error(`duplicate account id: ${id}`);
    const dirKey = `${agent}:${physical(configDir)}`;
    if (dirs.has(dirKey)) throw new Error(`duplicate ${agent} configDir: ${configDir}`);
    ids.add(id); dirs.add(dirKey);
    let credentialService;
    if (entry.credentialService != null) {
      credentialService = String(entry.credentialService);
      if (agent !== 'claude' || !credentialService || credentialService.length > 200 || /[\r\n\0]/.test(credentialService)) {
        throw new Error(`invalid credentialService for account ${id}`);
      }
    }
    const useDefaultConfig = entry.useDefaultConfig === true;
    if (entry.useDefaultConfig != null && typeof entry.useDefaultConfig !== 'boolean') throw new Error(`invalid useDefaultConfig for account ${id}`);
    if (useDefaultConfig && configDir !== builtIn(agent).configDir) throw new Error(`useDefaultConfig for ${id} requires ${builtIn(agent).configDir}`);
    records.push(Object.freeze({ id, label, agent, configDir, builtIn: useDefaultConfig, managed: configured.length > 0,
      ...(credentialService ? { credentialService } : {}) }));
  }
  for (const agent of AGENTS) {
    if (!records.some((entry) => entry.agent === agent)) {
      const fallback = builtIn(agent);
      if (ids.has(fallback.id)) throw new Error(`account ${fallback.id} has the wrong agent`);
      records.push(Object.freeze({ ...fallback, managed: configured.length > 0 })); ids.add(fallback.id);
    }
  }
  const defaults = {};
  const configuredAgents = new Set(configured.map((entry) => entry && entry.agent).filter((agent) => AGENTS.includes(agent)));
  const rawDefaults = config.defaultAccounts == null ? {} : config.defaultAccounts;
  if (!rawDefaults || typeof rawDefaults !== 'object' || Array.isArray(rawDefaults)) throw new Error('defaultAccounts must be an object');
  for (const agent of AGENTS) {
    const id = rawDefaults[agent];
    if (id == null) {
      if (configuredAgents.has(agent)) throw new Error(`defaultAccounts.${agent} is required when ${agent} accounts are configured`);
      defaults[agent] = builtIn(agent).id;
      continue;
    }
    const account = records.find((entry) => entry.id === id);
    if (!account || account.agent !== agent) throw new Error(`defaultAccounts.${agent} must name a ${agent} account`);
    defaults[agent] = account.id;
  }
  const rawAutomation = config.automationAccounts == null ? {} : config.automationAccounts;
  if (!rawAutomation || typeof rawAutomation !== 'object' || Array.isArray(rawAutomation)) throw new Error('automationAccounts must be an object');
  const automationAccounts = {};
  for (const [purpose, id] of Object.entries(rawAutomation)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(purpose) || typeof id !== 'string' || !ids.has(id)) {
      throw new Error(`invalid automation account ${purpose}`);
    }
    automationAccounts[purpose] = id;
  }
  for (const agent of AGENTS) if (!automationAccounts[agent]) automationAccounts[agent] = defaults[agent];
  return { config, records, defaults, automationAccounts };
}

function list(env = process.env) { return validated(env).records.slice(); }
function get(id, env = process.env) { return validated(env).records.find((entry) => entry.id === id) || null; }
function defaultFor(agent, env = process.env) {
  if (!AGENTS.includes(agent)) throw new Error(`unsupported agent: ${agent}`);
  const state = validated(env);
  return state.records.find((entry) => entry.id === state.defaults[agent]);
}
function automationFor(agent, purpose, env = process.env) {
  if (typeof purpose !== 'string') { env = purpose || env; purpose = ''; }
  const state = validated(env);
  const id = state.automationAccounts[purpose] || state.automationAccounts[agent] || state.defaults[agent];
  const account = state.records.find((entry) => entry.id === id);
  if (!account || account.agent !== agent) throw new Error(`automation account ${purpose || agent} is not a ${agent} account`);
  return account;
}
function hasMultiple(agent, env = process.env) { return list(env).filter((entry) => entry.agent === agent).length > 1; }

function envFor(accountOrId, baseEnv = {}, env = process.env) {
  const account = typeof accountOrId === 'string' ? get(accountOrId, env) : accountOrId;
  if (!account || !AGENTS.includes(account.agent)) throw new Error('unknown account');
  return require('./agent-launcher').profileEnvironment(account.agent, account, baseEnv);
}

function projectRoots(env = process.env) {
  return list(env).filter((entry) => entry.agent === 'claude')
    .map((entry) => ({ accountId: entry.id, root: path.join(entry.configDir, 'projects') }));
}

function authorityDir(root) { return path.join(root, '.keep', 'session-accounts'); }
function authorityFile(root, sessionId) { return path.join(authorityDir(root), `${sessionId}.json`); }
function readRecord(root, sessionId) {
  const file = authorityFile(root, sessionId);
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || value.version !== 1 || value.sessionId !== sessionId || !AGENTS.includes(value.agent) || !ID_RE.test(value.accountId || '')) {
      throw new Error(`invalid session account authority: ${file}`);
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function writeRecord(root, value) {
  const file = authorityFile(root, value.sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function authority(root) {
  const result = {};
  let names;
  try { names = fs.readdirSync(authorityDir(root)); } catch { return result; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    try { result[id] = readRecord(root, id); } catch {}
  }
  return result;
}

function locateClaudeFiles(sessionId, env = process.env) {
  const found = [];
  for (const entry of projectRoots(env)) {
    let projectNames;
    try { projectNames = fs.readdirSync(entry.root); } catch { continue; }
    for (const projectName of projectNames) {
      const file = path.join(entry.root, projectName, `${sessionId}.jsonl`);
      try {
        if (fs.statSync(file).isFile()) found.push({ accountId: entry.accountId, file, projectName });
      } catch {}
    }
  }
  return found;
}

function forSession(sessionId, agent = 'claude', options = {}) {
  const root = options.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
  const env = options.env || process.env;
  const record = readRecord(root, sessionId);
  if (record) {
    if (record.agent !== agent) throw new Error(`session ${sessionId} is pinned to ${record.agent}`);
    if (record.stagedAccountId && !options.preferStaged && !options.allowStagedSource) {
      throw new Error(`session ${sessionId} has an unfinished account handoff; retry the explicit handoff`);
    }
    const id = options.preferStaged && record.stagedAccountId ? record.stagedAccountId : record.accountId;
    const account = get(id, env);
    if (!account || account.agent !== agent) throw new Error(`session ${sessionId} is pinned to unavailable account ${id}`);
    return account;
  }
  if (options.allowDiscovery === false) return null;
  if (agent === 'claude') {
    const matches = locateClaudeFiles(sessionId, env);
    const ids = [...new Set(matches.map((entry) => entry.accountId))];
    if (ids.length === 1) return get(ids[0], env);
    if (ids.length > 1) throw new Error(`session ${sessionId} exists in multiple accounts without authority`);
  }
  return null;
}

function pinSession(sessionId, agent, accountId, options = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId || ''))) throw new Error('invalid session id');
  const root = options.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
  const env = options.env || process.env;
  const account = get(accountId, env);
  if (!account || account.agent !== agent) throw new Error(`account ${accountId} is not a ${agent} account`);
  const current = readRecord(root, sessionId);
  if (current && current.agent !== agent) throw new Error(`session ${sessionId} is already pinned to ${current.agent}`);
  if (current && current.accountId !== accountId && !options.transfer) {
    throw new Error(`session ${sessionId} is already pinned to account ${current.accountId}`);
  }
  const value = { version: 1, sessionId, agent, accountId, updatedAt: Date.now(), ...(options.transactionId ? { transactionId: options.transactionId } : {}) };
  writeRecord(root, value);
  return value;
}

function stageSession(sessionId, targetAccountId, transactionId, options = {}) {
  const root = options.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
  const env = options.env || process.env;
  const current = readRecord(root, sessionId);
  if (!current) throw new Error(`session ${sessionId} has no account authority`);
  const target = get(targetAccountId, env);
  if (!target || target.agent !== current.agent) throw new Error(`account ${targetAccountId} is not a ${current.agent} account`);
  const value = { ...current, stagedAccountId: targetAccountId, transactionId, updatedAt: Date.now() };
  writeRecord(root, value);
  return value;
}
function commitStaged(sessionId, transactionId, options = {}) {
  const root = options.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
  const current = readRecord(root, sessionId);
  if (!current || current.transactionId !== transactionId || !current.stagedAccountId) throw new Error('staged account authority changed');
  const value = { version: 1, sessionId, agent: current.agent, accountId: current.stagedAccountId, transactionId, updatedAt: Date.now() };
  writeRecord(root, value);
  return value;
}
function clearStaged(sessionId, transactionId, options = {}) {
  const root = options.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
  const current = readRecord(root, sessionId);
  if (current && current.transactionId === transactionId && current.stagedAccountId) {
    writeRecord(root, { version: 1, sessionId, agent: current.agent, accountId: current.accountId, updatedAt: Date.now() });
  }
}

function publicState(env = process.env) {
  const state = validated(env);
  return {
    accounts: state.records.map((entry) => ({
      id: entry.id, label: entry.label, agent: entry.agent,
      isDefault: state.defaults[entry.agent] === entry.id,
      handoffSupported: ['claude', 'codex'].includes(entry.agent),
    })),
    defaults: { ...state.defaults },
    automationAccounts: { ...state.automationAccounts },
  };
}

function writeConfig(config, env = process.env) {
  if (env.KEEP_DIR && !env.KEEP_CONFIG) {
    throw new Error('account configuration changes require KEEP_CONFIG when KEEP_DIR is explicitly set');
  }
  const file = require('./config').configFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function add(entry, env = process.env) {
  if (!CUSTOM_ID_RE.test(String(entry.id || ''))) throw new Error('custom account ids use lowercase letters, digits, underscores, and hyphens');
  const original = rawConfig(env);
  const config = structuredClone(original);
  const accounts = Array.isArray(config.accounts) ? config.accounts.slice() : [];
  if (!accounts.some((candidate) => candidate && candidate.agent === entry.agent)) {
    const fallback = builtIn(entry.agent);
    accounts.push({ id: fallback.id, label: fallback.label, agent: fallback.agent, configDir: fallback.configDir, useDefaultConfig: true });
  }
  if (accounts.some((candidate) => candidate && candidate.id === entry.id)) throw new Error(`account already exists: ${entry.id}`);
  accounts.push({ id: entry.id, label: entry.label, agent: entry.agent, configDir: entry.configDir,
    ...(entry.credentialService ? { credentialService: entry.credentialService } : {}) });
  config.accounts = accounts;
  config.defaultAccounts = { ...(config.defaultAccounts || {}) };
  if (!config.defaultAccounts[entry.agent]) config.defaultAccounts[entry.agent] = builtIn(entry.agent).id;
  validated(env, config);
  if (entry.agent === 'codex') {
    const source = defaultFor('codex', env);
    require('./codex-setup').shareSetup(source, {
      id: entry.id, label: entry.label, agent: entry.agent, configDir: expand(entry.configDir), builtIn: false, managed: true,
    });
  }
  writeConfig(config, env);
  return get(entry.id, env);
}
function setDefault(agent, accountId, env = process.env) {
  const account = get(accountId, env);
  if (!account || account.agent !== agent) throw new Error(`account ${accountId} is not a ${agent} account`);
  const config = structuredClone(rawConfig(env));
  config.defaultAccounts = { ...(config.defaultAccounts || {}), [agent]: accountId };
  validated(env, config);
  writeConfig(config, env);
  return account;
}

module.exports = {
  AGENTS, ID_RE, CUSTOM_ID_RE, list, get, defaultFor, automationFor, hasMultiple, envFor, projectRoots,
  publicState, authority, authorityFile, locateClaudeFiles, forSession, pinSession,
  stageSession, commitStaged, clearStaged, add, setDefault,
};
