'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const accounts = require('./accounts.js');
const launcher = require('./agent-launcher.js');

const CACHE_ROOT = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'openai-codex', 'codex');
const LEGACY_PLUGIN_DATA = path.join(os.homedir(), '.claude', 'plugins', 'data', 'codex-openai-codex');
const MANIFEST = 'account.json';
const COMMANDS = new Set(['task', 'task-resume-candidate', 'status', 'result', 'cancel']);
const BROKER_ENV = ['CODEX_COMPANION_APP_SERVER_ENDPOINT', 'CODEX_COMPANION_APP_SERVER_PID_FILE',
  'CODEX_COMPANION_APP_SERVER_LOG_FILE'];
const exitStatus = (code, signal) => code ?? (128 + (os.constants.signals[signal] || 1));

function displayText(value) {
  return String(value || '').replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]/g, '');
}

function rootOf(options = {}) {
  return options.root || options.env?.KEEP_DIR || process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
}

function canonical(value, io = fs) {
  try { return io.realpathSync.native(value); } catch { return path.resolve(value); }
}

function accountKey(account, io = fs) {
  const id = account.id || account.accountId;
  const slug = id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'codex';
  const identity = `${id}\0${canonical(account.configDir, io)}`;
  return `${slug}-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
}

function namespaceFor(account, options = {}) {
  const pluginData = path.join(rootOf(options), '.keep', 'codex-companion', 'accounts', accountKey(account, options.fs || fs));
  return {
    accountId: account.id,
    agent: account.agent,
    configDir: canonical(account.configDir, options.fs || fs),
    builtIn: account.builtIn === true,
    managed: account.managed === true,
    pluginData,
    stateRoot: path.join(pluginData, 'state'),
  };
}

function manifestFor(namespace) {
  return { version: 1, accountId: namespace.accountId, agent: namespace.agent,
    configDir: namespace.configDir, builtIn: namespace.builtIn, managed: namespace.managed };
}

function sameManifestIdentity(current, expected) {
  return current?.version === expected.version && current.accountId === expected.accountId
    && current.agent === expected.agent && current.configDir === expected.configDir;
}

function writeManifest(file, value, io) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  io.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  io.renameSync(temp, file);
}

function ensureNamespace(namespace, options = {}) {
  const io = options.fs || fs;
  const file = path.join(namespace.pluginData, MANIFEST);
  const expected = manifestFor(namespace);
  let current = null;
  try { current = JSON.parse(io.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Codex companion account namespace is unreadable: ${file}`); }
  if (current && !sameManifestIdentity(current, expected)) {
    throw new Error(`Codex companion account namespace identity changed: ${namespace.accountId}`);
  }
  if (!current || JSON.stringify(current) !== JSON.stringify(expected)) writeManifest(file, expected, io);
  return namespace;
}

function readNamespaces(options = {}) {
  const io = options.fs || fs;
  const base = path.join(rootOf(options), '.keep', 'codex-companion', 'accounts');
  let entries = [];
  let readable = true;
  try { entries = io.readdirSync(base, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') readable = false; }
  const namespaces = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginData = path.join(base, entry.name);
    try {
      const value = JSON.parse(io.readFileSync(path.join(pluginData, MANIFEST), 'utf8'));
      if (value?.version !== 1 || value.agent !== 'codex' || !accounts.ID_RE.test(value.accountId || '')
          || typeof value.configDir !== 'string' || !path.isAbsolute(value.configDir)
          || typeof value.builtIn !== 'boolean' || typeof value.managed !== 'boolean'
          || entry.name !== accountKey(value, io)) throw new Error('invalid manifest');
      namespaces.push({ accountId: value.accountId, agent: 'codex', configDir: value.configDir,
        builtIn: value.builtIn === true, managed: value.managed === true,
        pluginData, stateRoot: path.join(pluginData, 'state') });
    } catch { readable = false; }
  }
  return { namespaces, readable };
}

function inventoryStateRoots(options = {}) {
  if (Array.isArray(options.codexStateRoots)) return { readable: true,
    roots: options.codexStateRoots.map((entry) => typeof entry === 'string' ? { stateRoot: entry } : entry) };
  if (options.codexStateRoot) return { readable: true, roots: [{ stateRoot: options.codexStateRoot }] };
  const saved = readNamespaces(options);
  return { readable: saved.readable, roots: [
    { stateRoot: options.legacyCodexStateRoot || path.join(LEGACY_PLUGIN_DATA, 'state'), pluginData: LEGACY_PLUGIN_DATA, legacy: true },
    ...saved.namespaces,
  ] };
}

function companionScript(options = {}) {
  if (options.companionScript) return options.companionScript;
  const io = options.fs || fs;
  const cacheRoot = options.cacheRoot || CACHE_ROOT;
  let versions;
  try { versions = io.readdirSync(cacheRoot).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); }
  catch { return null; }
  for (const version of versions.reverse()) {
    const file = path.join(cacheRoot, version, 'scripts', 'codex-companion.mjs');
    if (io.existsSync(file)) return file;
  }
  return null;
}

function selectedAccount(accountId, options = {}) {
  const store = options.accounts || accounts;
  const env = options.env || process.env;
  const account = accountId == null ? store.defaultFor('codex', env) : store.get(accountId, env);
  if (!account) throw new Error(`unknown account ${accountId}`);
  if (account.agent !== 'codex') throw new Error(`account ${account.id} is not a Codex account`);
  return account;
}

function companionEnvironment(account, namespace, options = {}) {
  const base = { ...(options.baseEnv || options.env || process.env) };
  for (const key of [...BROKER_ENV, 'KEEP_PANE', 'KEEP_CODEX_CLIENT_TOKEN', 'KEEP_AGENT_ACCOUNT_ID']) delete base[key];
  const env = (options.profileEnvironment || launcher.profileEnvironment)('codex', account, base);
  env.CLAUDE_PLUGIN_DATA = namespace.pluginData;
  return env;
}

function environmentForNamespace(namespace, options = {}) {
  if (!namespace?.accountId || !namespace.configDir) {
    const env = { ...(options.baseEnv || options.env || process.env) };
    for (const key of [...BROKER_ENV, 'KEEP_PANE', 'KEEP_CODEX_CLIENT_TOKEN', 'KEEP_AGENT_ACCOUNT_ID']) delete env[key];
    if (namespace?.pluginData) env.CLAUDE_PLUGIN_DATA = namespace.pluginData;
    return env;
  }
  const account = { id: namespace.accountId, agent: 'codex', configDir: namespace.configDir,
    builtIn: namespace.builtIn === true, managed: namespace.managed === true };
  return companionEnvironment(account, namespace, options);
}

function workspaceRoot(cwd, options = {}) {
  const run = options.execFileSync || execFileSync;
  try { return String(run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })).trim(); }
  catch { return cwd; }
}

function workspaceStateDir(workspace, stateRoot, io = fs) {
  const physical = canonical(workspace, io);
  const slug = (path.basename(workspace) || 'workspace').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  const hash = crypto.createHash('sha256').update(physical).digest('hex').slice(0, 16);
  return path.join(stateRoot, `${slug}-${hash}`);
}

function context(account, namespace, script, cwd, options = {}) {
  const workspace = workspaceRoot(cwd, options);
  const stateDir = workspaceStateDir(workspace, namespace.stateRoot, options.fs || fs);
  return { accountId: account.id, label: account.label, agent: account.agent,
    workspace, stateDir, jobsDir: path.join(stateDir, 'jobs'), script };
}

async function run(argv, options = {}) {
  const raw = [...argv];
  let accountId = null;
  if (raw[0] === '--account') {
    accountId = raw[1];
    if (!accountId) throw new Error('--account needs a registered Codex account id');
    raw.splice(0, 2);
  }
  const command = raw.shift();
  if (command === 'context') {
    if (raw.some((arg) => arg !== '--json')) throw new Error('usage: keep codex [--account <codex-id>] context [--json]');
  } else if (!COMMANDS.has(command)) {
    throw new Error('usage: keep codex [--account <codex-id>] <context|task|task-resume-candidate|status|result|cancel> [args]');
  }
  const account = selectedAccount(accountId, options);
  const namespace = namespaceFor(account, options);
  const script = companionScript(options);
  if (!script) throw new Error('Codex companion is not installed');
  const cwd = path.resolve(options.cwd || process.cwd());
  const info = context(account, namespace, script, cwd, options);
  if (command === 'context') {
    const json = raw.includes('--json');
    (options.stdout || process.stdout).write(json ? `${JSON.stringify(info, null, 2)}\n`
      : `Codex account: ${displayText(info.label)} (${info.accountId})\nWorkspace: ${info.workspace}\nJobs: ${info.jobsDir}\n`);
    return { code: 0, context: info };
  }

  ensureNamespace(namespace, options);
  (options.prepareProfile || launcher.prepareProfile)('codex', account, { env: options.env || process.env,
    accounts: options.accounts || accounts, setup: options.setup });
  const env = companionEnvironment(account, namespace, options);
  (options.stderr || process.stderr).write(`keep codex: using ${displayText(account.label)} (${account.id})\n`);
  const start = options.spawn || spawn;
  const child = start(process.execPath, [script, command, ...raw], { cwd, env, stdio: 'inherit', windowsHide: true });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code: exitStatus(code, signal), signal, context: info }));
  });
}

module.exports = {
  CACHE_ROOT, LEGACY_PLUGIN_DATA, BROKER_ENV, COMMANDS,
  accountKey, namespaceFor, ensureNamespace, readNamespaces, inventoryStateRoots,
  companionScript, selectedAccount, companionEnvironment, environmentForNamespace, workspaceRoot, workspaceStateDir,
  context, run,
};
