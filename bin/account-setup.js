'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MANIFEST = '.keep-shared-setup.json';
const SHARED_NAMES = ['CLAUDE.md', 'skills', 'rules', 'commands', 'agents'];
const SETTINGS = ['settings.json', 'settings.local.json'];
const ROUTING_ENV = /(?:API[_-]?KEY|AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|BASE[_-]?URL|BEDROCK|VERTEX|FOUNDRY|AWS_|GOOGLE_|^ANTHROPIC_|^CLAUDE_CODE_USE_)/i;

function canonical(value) {
  const resolved = path.resolve(String(value || ''));
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function stateFile(account) {
  if (account.builtIn) {
    return path.join(path.dirname(account.configDir), '.claude.json');
  }
  return path.join(account.configDir, '.claude.json');
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw new Error(`invalid JSON in ${file}`); }
}

function unsafeSetting(value, trail = []) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    const next = [...trail, key];
    if (/(?:api.?key|token|secret|password|credential|provider|base.?url|bedrock|vertex|foundry)/i.test(key)) return next;
    if (key === 'env' && child && typeof child === 'object' && !Array.isArray(child)) {
      const variable = Object.keys(child).find((name) => ROUTING_ENV.test(name));
      if (variable) return [...next, variable];
    }
    const found = unsafeSetting(child, next);
    if (found) return found;
  }
  return null;
}

function validateSettings(sourceDir) {
  for (const name of SETTINGS) {
    const file = path.join(sourceDir, name);
    if (!fs.existsSync(file)) continue;
    const found = unsafeSetting(readJSON(file), []);
    if (found) throw new Error(`${name} contains account-specific credential or provider routing at ${found.join('.')}; move that setting to account-local configuration before sharing`);
  }
}

function projectKey(cwd) {
  return canonical(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

function gitPath(cwd, argument) {
  const result = spawnSync('git', ['-C', canonical(cwd), 'rev-parse', '--path-format=absolute', argument], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024,
  });
  return result.status === 0 && result.stdout.trim() ? canonical(result.stdout.trim()) : null;
}

function repositoryRoot(cwd) {
  const result = spawnSync('git', ['-C', canonical(cwd), 'worktree', 'list', '--porcelain', '-z'], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024,
  });
  if (result.status === 0) {
    const main = result.stdout.split('\0').find((field) => field.startsWith('worktree '));
    if (main) return canonical(main.slice('worktree '.length));
  }
  return gitPath(cwd, '--show-toplevel') || canonical(cwd);
}

function worktreeRoot(cwd) {
  return gitPath(cwd, '--show-toplevel') || canonical(cwd);
}

function explicitMemoryDirectory(cwd) {
  const root = worktreeRoot(cwd);
  let configured;
  for (const name of ['settings.json', 'settings.local.json']) {
    const value = readJSON(path.join(root, '.claude', name), {});
    if (value.autoMemoryDirectory !== undefined) configured = value.autoMemoryDirectory;
  }
  if (configured === undefined) return null;
  if (typeof configured !== 'string' || !configured.trim() || /[\r\n\0]/.test(configured)) {
    throw new Error(`invalid project autoMemoryDirectory for ${root}`);
  }
  const expanded = configured.replace(/^~(?=\/|$)/, os.homedir());
  return canonical(path.isAbsolute(expanded) ? expanded : path.join(root, expanded));
}

function projectEntry(state, cwd) {
  const wanted = canonical(cwd);
  return Object.entries(state.projects || {}).find(([candidate]) => {
    try { return canonical(candidate) === wanted; } catch { return false; }
  })?.[1] || {};
}

function mcpServerSets(state, cwd) {
  const exact = canonical(cwd);
  const scopes = [...new Set([repositoryRoot(exact), worktreeRoot(exact), exact].map(canonical))];
  const desired = { ...(state.mcpServers || {}) };
  for (const scope of scopes) Object.assign(desired, projectEntry(state, scope).mcpServers || {});
  const legacy = { ...(state.mcpServers || {}), ...(projectEntry(state, exact).mcpServers || {}) };
  return { desired, legacy };
}

function sourceState(account, override) {
  const setup = readSetup(account);
  const file = override || setup?.originStateFile || setup?.sourceStateFile || stateFile(account);
  return { file, value: readJSON(file, {}) };
}

function effectiveMcpServers(sourceAccount, cwd, options = {}) {
  const managed = readSetup(sourceAccount);
  const state = sourceState(sourceAccount, options.sourceStateFile).value;
  const { desired, legacy } = mcpServerSets(state, cwd);
  if (!managed) return desired;
  const generated = mcpConfigPath(sourceAccount.configDir, cwd);
  if (!fs.existsSync(generated)) return desired;
  const generatedText = fs.readFileSync(generated, 'utf8');
  const actual = readJSON(generated, {}).mcpServers || {};
  if (digest(actual) === digest(desired)) return actual;
  const legacyText = JSON.stringify({ mcpServers: legacy }, null, 2) + '\n';
  if (generatedText === legacyText) return desired;
  throw new Error(`managed MCP configuration conflicts for ${canonical(cwd)}`);
}

function mcpConfigPath(configDir, cwd) {
  return path.join(configDir, 'projects', projectKey(cwd), '.keep-mcp.json');
}

function memoryPath(configDir, cwd) {
  return path.join(configDir, 'projects', projectKey(cwd), 'memory');
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

function link(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.symlinkSync(canonical(source), destination);
}

function pathExists(file) {
  try { fs.lstatSync(file); return true; } catch { return false; }
}

function ensureMemoryAliases(configDir, cwds, authority, label) {
  const aliases = [...new Set(cwds.map((cwd) => memoryPath(configDir, cwd)))];
  for (const alias of aliases) {
    if (alias === authority) continue;
    if (!pathExists(alias)) link(authority, alias);
    else if (canonical(alias) !== canonical(authority)) {
      throw new Error(`${label} project memory conflicts at ${alias}`);
    }
  }
  return aliases;
}

function existingProjects(sourceAccount, state) {
  const values = new Set(Object.keys(state.projects || {}).map((cwd) => canonical(cwd)));
  const root = path.join(sourceAccount.configDir, 'projects');
  const memoryKeys = [];
  try {
    for (const name of fs.readdirSync(root)) {
      const memory = path.join(root, name, 'memory');
      try { if (fs.statSync(memory).isDirectory()) memoryKeys.push(name); } catch {}
    }
  } catch {}
  return { cwds: [...values].filter((value) => path.isAbsolute(value)), memoryKeys, root };
}

function assertAccounts(sourceAccount, targetAccount) {
  if (!sourceAccount || !targetAccount || sourceAccount.agent !== 'claude' || targetAccount.agent !== 'claude') {
    throw new Error('shared setup currently supports Claude accounts only');
  }
  const source = canonical(sourceAccount.configDir), target = canonical(targetAccount.configDir);
  if (source === target || target.startsWith(source + path.sep) || source.startsWith(target + path.sep)) {
    throw new Error('source and target Claude config directories must be separate');
  }
  if (!fs.statSync(source).isDirectory()) throw new Error(`source Claude config directory does not exist: ${source}`);
  return { source, target };
}

function manifestFor(targetDir) {
  return readJSON(path.join(targetDir, MANIFEST), null);
}

function expectedLink(source, destination) {
  try { return fs.lstatSync(destination).isSymbolicLink() && canonical(destination) === canonical(source); }
  catch { return false; }
}

function verifyManaged(sourceDir, targetDir, manifest) {
  if (!manifest || manifest.version !== 1 || canonical(manifest.sourceConfigDir) !== sourceDir) {
    throw new Error('target Claude config directory is not an existing setup from this source');
  }
  for (const name of manifest.sharedEntries || []) {
    if (!expectedLink(path.join(sourceDir, name), path.join(targetDir, name))) {
      throw new Error(`target shared entry conflicts: ${name}`);
    }
  }
}

function populate(stage, sourceAccount, sourceDir, sourceStateFile) {
  const state = sourceState(sourceAccount, sourceStateFile);
  const sourceSetup = readSetup(sourceAccount);
  const sharedEntries = [];
  for (const name of [...SHARED_NAMES, ...SETTINGS]) {
    const source = path.join(sourceDir, name);
    if (!fs.existsSync(source)) continue;
    link(source, path.join(stage, name));
    sharedEntries.push(name);
  }
  const projects = existingProjects(sourceAccount, state.value);
  let memoryProjects = 0, mcpProjects = 0;
  for (const key of projects.memoryKeys) {
    link(path.join(sourceDir, 'projects', key, 'memory'), path.join(stage, 'projects', key, 'memory'));
    memoryProjects++;
  }
  for (const cwd of projects.cwds) {
    const key = projectKey(cwd);
    const sourceMemory = path.join(sourceDir, 'projects', key, 'memory');
    const targetMemory = path.join(stage, 'projects', key, 'memory');
    if (fs.existsSync(sourceMemory) && !fs.existsSync(targetMemory)) { link(sourceMemory, targetMemory); memoryProjects++; }
    const servers = effectiveMcpServers(sourceAccount, cwd, { sourceStateFile: state.file });
    if (Object.keys(servers).length) { writeJSON(path.join(stage, 'projects', key, '.keep-mcp.json'), { mcpServers: servers }); mcpProjects++; }
  }
  const manifest = { version: 1, sourceAccountId: sourceAccount.id, sourceConfigDir: sourceDir,
    sourceStateFile: state.file,
    originConfigDir: sourceSetup?.originConfigDir || sourceSetup?.sourceConfigDir || sourceDir,
    originStateFile: sourceSetup?.originStateFile || sourceSetup?.sourceStateFile || state.file,
    sharedEntries, createdAt: new Date().toISOString() };
  writeJSON(path.join(stage, MANIFEST), manifest);
  return { manifest, memoryProjects, mcpProjects };
}

function shareSetup(sourceAccount, targetAccount, options = {}) {
  if (sourceAccount?.agent === 'codex' || targetAccount?.agent === 'codex') {
    return require('./codex-setup').shareSetup(sourceAccount, targetAccount, options);
  }
  const { source, target } = assertAccounts(sourceAccount, targetAccount);
  validateSettings(source);
  if (fs.existsSync(target)) {
    const names = fs.readdirSync(target);
    if (names.length) {
      const manifest = manifestFor(target);
      verifyManaged(source, target, manifest);
      return { ok: true, idempotent: true, targetConfigDir: target, sharedEntries: manifest.sharedEntries || [] };
    }
  }

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(path.dirname(target), `.${path.basename(target)}.setup-`));
  fs.chmodSync(stage, 0o700);
  let removedEmptyTarget = false;
  try {
    const populated = populate(stage, sourceAccount, source, options.sourceStateFile);
    options.beforeCommit?.(stage);
    if (fs.existsSync(target)) { fs.rmdirSync(target); removedEmptyTarget = true; }
    fs.renameSync(stage, target);
    return { ok: true, idempotent: false, targetConfigDir: target, sharedEntries: populated.manifest.sharedEntries,
      memoryProjects: populated.memoryProjects, mcpProjects: populated.mcpProjects };
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    if (removedEmptyTarget && !fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o700 });
    throw error;
  }
}

function readSetup(account) {
  if (!account?.configDir) return null;
  const manifest = manifestFor(account.configDir);
  if (!manifest || manifest.version !== 1) return null;
  return manifest;
}

function ensureSharedMemory(account, cwd) {
  const manifest = readSetup(account);
  if (!account || account.agent !== 'claude' || !account.configDir) throw new Error('shared memory requires a Claude account');
  if (manifest) verifyManaged(canonical(manifest.sourceConfigDir), canonical(account.configDir), manifest);
  const sourceDir = canonical(manifest?.originConfigDir || manifest?.sourceConfigDir || account.configDir);
  const sourceAccount = { id: manifest?.sourceAccountId || account.id, agent: 'claude', configDir: sourceDir,
    builtIn: !manifest && account.builtIn === true };
  const explicitMemory = explicitMemoryDirectory(cwd);
  let targetMemory;
  if (explicitMemory) {
    fs.mkdirSync(explicitMemory, { recursive: true, mode: 0o700 });
    targetMemory = explicitMemory;
  } else {
    const commonRoot = repositoryRoot(cwd);
    const currentRoot = worktreeRoot(cwd);
    const lookupCwds = [canonical(cwd), currentRoot, commonRoot];
    const sourceMemory = memoryPath(sourceDir, commonRoot);
    if (!pathExists(sourceMemory)) {
      const existing = [...new Set(lookupCwds.map((entry) => memoryPath(sourceDir, entry)))]
        .filter((entry) => entry !== sourceMemory && pathExists(entry));
      if (existing.length) {
        const resolved = [...new Set(existing.map(canonical))];
        if (resolved.length !== 1) throw new Error(`source project memory conflicts for ${canonical(cwd)}`);
        link(existing[0], sourceMemory);
      } else fs.mkdirSync(sourceMemory, { recursive: true, mode: 0o700 });
    }
    ensureMemoryAliases(sourceDir, lookupCwds, sourceMemory, 'source');
    if (canonical(account.configDir) !== sourceDir) {
      ensureMemoryAliases(account.configDir, lookupCwds, sourceMemory, 'target');
    }
    targetMemory = memoryPath(account.configDir, currentRoot);
  }

  const sourceStateFile = manifest?.originStateFile || manifest?.sourceStateFile;
  const servers = effectiveMcpServers(sourceAccount, cwd, { sourceStateFile });
  let mcpConfig = null;
  if (manifest) {
    mcpConfig = mcpConfigPath(account.configDir, cwd);
    const desired = JSON.stringify({ mcpServers: servers }, null, 2) + '\n';
    if (fs.existsSync(mcpConfig)) {
      const actual = fs.readFileSync(mcpConfig, 'utf8');
      if (actual !== desired) {
        const state = sourceState(sourceAccount, sourceStateFile).value;
        const legacy = JSON.stringify({ mcpServers: mcpServerSets(state, cwd).legacy }, null, 2) + '\n';
        if (actual !== legacy) throw new Error(`managed MCP configuration conflicts for ${canonical(cwd)}`);
        writeJSON(mcpConfig, { mcpServers: servers });
      }
    } else writeJSON(mcpConfig, { mcpServers: servers });
  }
  return { memoryDir: targetMemory, autoMemoryDirectory: explicitMemory || targetMemory,
    mcpConfig, mcpServerCount: Object.keys(servers).length, mcpServers: servers };
}

function comparableSettings(configDir) {
  const result = {};
  for (const name of SETTINGS) {
    const value = readJSON(path.join(configDir, name), {});
    if (name === 'settings.json') {
      const { hooks, statusLine, model, ...portable } = value;
      result[name] = portable;
    } else result[name] = value;
  }
  return result;
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function compatible(sourceAccount, targetAccount, cwd) {
  const reasons = [];
  let source, target;
  try {
    source = ensureSharedMemory(sourceAccount, cwd);
    target = ensureSharedMemory(targetAccount, cwd);
  }
  catch (error) { return { ok: false, reasons: [error.message], mcpConfig: null }; }
  if (digest(comparableSettings(sourceAccount.configDir)) !== digest(comparableSettings(targetAccount.configDir))) {
    reasons.push('portable Claude settings differ');
  }
  if (digest(source.mcpServers) !== digest(target.mcpServers)) reasons.push('effective MCP servers differ');
  if (canonical(source.memoryDir) !== canonical(target.memoryDir)) reasons.push('project memory differs');
  return { ok: reasons.length === 0, reasons, mcpConfig: target.mcpConfig,
    memoryDir: target.memoryDir, autoMemoryDirectory: target.autoMemoryDirectory };
}

module.exports = { MANIFEST, shareSetup, readSetup, ensureSharedMemory, compatible, effectiveMcpServers,
  projectKey, repositoryRoot, stateFile, mcpConfigPath };
