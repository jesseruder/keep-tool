'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const toml = require('@iarna/toml');

const MANIFEST = '.keep-codex-capabilities.json';
const CONFIG_ROOTS = ['features', 'plugins', 'mcp_servers', 'apps', 'marketplaces', 'hooks', 'experimental_hooks'];
const FILE_ASSETS = ['AGENTS.md', 'hooks.json'];
const DIRECTORY_ASSETS = ['skills', 'agents'];
const MISSING = Symbol('missing');

function canonical(value) {
  const resolved = path.resolve(String(value || ''));
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function pathExists(file) {
  try { fs.lstatSync(file); return true; } catch { return false; }
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw new Error(`invalid JSON in ${file}`); }
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readToml(file) {
  try { return toml.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`invalid TOML in ${file}: ${error.message.split('\n')[0]}`);
  }
}

function writeToml(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, toml.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function digest(value) {
  if (value === MISSING) return 'missing';
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isObject(value) { return value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date); }

function managedLeaves(config) {
  const result = new Map();
  for (const root of CONFIG_ROOTS) {
    if (!Object.prototype.hasOwnProperty.call(config, root)) continue;
    const value = config[root];
    if (!isObject(value)) {
      result.set(JSON.stringify([root]), { path: [root], value });
      continue;
    }
    for (const [name, entry] of Object.entries(value)) {
      if (root === 'hooks' && name === 'state' && isObject(entry)) {
        for (const [hookPath, hookState] of Object.entries(entry)) {
          const trail = [root, name, hookPath];
          result.set(JSON.stringify(trail), { path: trail, value: hookState });
        }
      } else {
        const trail = [root, name];
        result.set(JSON.stringify(trail), { path: trail, value: entry });
      }
    }
  }
  return result;
}

function getAt(value, trail) {
  let current = value;
  for (const key of trail) {
    if (!isObject(current) || !Object.prototype.hasOwnProperty.call(current, key)) return MISSING;
    current = current[key];
  }
  return current;
}

function setAt(value, trail, next) {
  let current = value;
  for (const key of trail.slice(0, -1)) {
    if (!isObject(current[key])) current[key] = {};
    current = current[key];
  }
  const key = trail.at(-1);
  if (next === MISSING) {
    delete current[key];
    for (let length = trail.length - 1; length > 0; length--) {
      const parent = getAt(value, trail.slice(0, length - 1));
      if (!isObject(parent)) break;
      const childKey = trail[length - 1];
      if (isObject(parent[childKey]) && Object.keys(parent[childKey]).length === 0) delete parent[childKey];
      else break;
    }
  } else current[key] = structuredClone(next);
}

function displayPath(trail) {
  return trail.map((part) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(part) ? part : JSON.stringify(part)).join('.');
}

function rebaseString(value, sourceDir, targetDir) {
  return value === sourceDir || value.startsWith(sourceDir + path.sep) ? targetDir + value.slice(sourceDir.length) : value;
}

function rebaseValue(value, sourceDir, targetDir) {
  if (typeof value === 'string') return rebaseString(value, sourceDir, targetDir);
  if (Array.isArray(value)) return value.map((child) => rebaseValue(child, sourceDir, targetDir));
  if (isObject(value)) {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      const rebasedKey = rebaseString(key, sourceDir, targetDir);
      result[rebasedKey] = rebaseValue(child, sourceDir, targetDir);
    }
    return result;
  }
  return value;
}

function desiredConfig(sourceConfig, sourceDir, targetDir) {
  const desired = {};
  for (const root of CONFIG_ROOTS) {
    if (Object.prototype.hasOwnProperty.call(sourceConfig, root)) desired[root] = rebaseValue(sourceConfig[root], sourceDir, targetDir);
  }
  return desired;
}

function mergeConfig(sourceConfig, targetConfig, previous, sourceDir, targetDir) {
  const desired = desiredConfig(sourceConfig, sourceDir, targetDir);
  const sourceLeaves = managedLeaves(desired);
  const targetLeaves = managedLeaves(targetConfig);
  const old = new Map((previous || []).map((entry) => [JSON.stringify(entry.path), entry]));
  const keys = new Set([...sourceLeaves.keys(), ...targetLeaves.keys(), ...old.keys()]);
  const result = structuredClone(targetConfig);
  const decisions = [];
  const conflicts = [];

  for (const key of [...keys].sort()) {
    const source = sourceLeaves.get(key)?.value ?? MISSING;
    const target = targetLeaves.get(key)?.value ?? MISSING;
    const prior = old.get(key);
    let managed = false;
    if (!prior) {
      if (source !== MISSING && target === MISSING) { setAt(result, sourceLeaves.get(key).path, source); managed = true; }
      else if (source !== MISSING && digest(source) === digest(target)) managed = true;
    } else {
      const sourceChanged = digest(source) !== prior.sourceHash;
      const targetChanged = digest(target) !== prior.targetHash;
      managed = prior.managed === true;
      if (sourceChanged && targetChanged && digest(source) !== digest(target)) {
        conflicts.push(displayPath(prior.path));
      } else if (managed && sourceChanged && !targetChanged) {
        setAt(result, prior.path, source);
      } else if (managed && targetChanged && !sourceChanged) {
        managed = false;
      } else if (sourceChanged && targetChanged && digest(source) === digest(target)) {
        managed = true;
      }
    }
    decisions.push({ path: sourceLeaves.get(key)?.path || targetLeaves.get(key)?.path || prior.path, managed });
  }
  if (conflicts.length) throw new Error(`Codex capability sync conflicts at ${conflicts.join(', ')}`);

  const records = decisions.map(({ path: trail, managed }) => ({
    path: trail,
    sourceHash: digest(getAt(desired, trail)),
    targetHash: digest(getAt(result, trail)),
    managed,
  }));
  return { config: result, records, desired };
}

function expectedLink(source, target) {
  try {
    if (!fs.lstatSync(target).isSymbolicLink()) return false;
    const linked = fs.readlinkSync(target);
    const resolved = path.resolve(path.dirname(target), linked);
    return path.resolve(resolved) === path.resolve(source) || canonical(resolved) === canonical(source);
  } catch { return false; }
}

function ensureLink(source, target, priorManaged) {
  if (!pathExists(source)) {
    if (priorManaged && expectedLink(priorManaged, target)) fs.unlinkSync(target);
    return null;
  }
  if (pathExists(target)) return expectedLink(source, target) ? canonical(source) : null;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.symlinkSync(canonical(source), target);
  return canonical(source);
}

function syncSimpleAssets(sourceDir, targetDir, previous = {}) {
  const assets = {};
  for (const name of FILE_ASSETS) {
    const managed = ensureLink(path.join(sourceDir, name), path.join(targetDir, name), previous[name]);
    if (managed) assets[name] = managed;
  }
  for (const container of DIRECTORY_ASSETS) {
    const sourceRoot = path.join(sourceDir, container), targetRoot = path.join(targetDir, container);
    if (!pathExists(sourceRoot)) continue;
    if (expectedLink(sourceRoot, targetRoot)) { assets[container] = canonical(sourceRoot); continue; }
    if (!pathExists(targetRoot)) fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
    if (!fs.statSync(targetRoot).isDirectory()) continue;
    const names = fs.readdirSync(sourceRoot);
    for (const name of names) {
      const relative = path.join(container, name);
      const managed = ensureLink(path.join(sourceRoot, name), path.join(targetRoot, name), previous[relative]);
      if (managed) assets[relative] = managed;
    }
    for (const [relative, oldSource] of Object.entries(previous)) {
      if (path.dirname(relative) !== container || names.includes(path.basename(relative))) continue;
      ensureLink(path.join(sourceRoot, path.basename(relative)), path.join(targetRoot, path.basename(relative)), oldSource);
    }
  }
  return assets;
}

function syncMarketplaceAssets(sourceConfig, sourceDir, targetDir, previous = {}) {
  const assets = {};
  for (const [name, definition] of Object.entries(sourceConfig.marketplaces || {})) {
    const source = typeof definition?.source === 'string' ? path.resolve(definition.source) : null;
    if (!source || !(source === sourceDir || source.startsWith(sourceDir + path.sep)) || !pathExists(source)) continue;
    const relative = path.relative(sourceDir, source);
    const target = path.join(targetDir, relative);
    const key = `marketplaces/${name}`;
    const managed = ensureLink(source, target, previous[key]);
    if (managed) assets[key] = managed;
  }
  return assets;
}

function rewriteJsonMetadata(source, destination, sourceDir, targetDir) {
  const value = readJSON(source);
  function rebaseMetadata(child) {
    if (typeof child === 'string') {
      const rebased = rebaseString(child, sourceDir, targetDir);
      if (rebased !== child) return rebased;
      if (/^\s*[\[{]/.test(child)) {
        try { return JSON.stringify(rebaseMetadata(JSON.parse(child))); } catch {}
      }
      return child;
    }
    if (Array.isArray(child)) return child.map(rebaseMetadata);
    if (isObject(child)) return Object.fromEntries(Object.entries(child).map(([key, item]) => [key, rebaseMetadata(item)]));
    return child;
  }
  writeJSON(destination, rebaseMetadata(value));
}

function materializePluginTree(source, target, sourceDir, targetDir) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isDirectory()) materializePluginTree(from, to, sourceDir, targetDir);
    else if (entry.isFile() && entry.name.endsWith('.json')) rewriteJsonMetadata(from, to, sourceDir, targetDir);
    else if (entry.isFile() && entry.name === 'SKILL.md') {
      if (pathExists(to) && fs.lstatSync(to).isSymbolicLink()) fs.unlinkSync(to);
      fs.copyFileSync(from, to);
    }
    else if (!pathExists(to)) fs.symlinkSync(canonical(from), to);
  }
}

function pluginVersions(configDir) {
  const root = path.join(configDir, 'plugins', 'cache');
  const result = [];
  let marketplaces = [];
  try { marketplaces = fs.readdirSync(root); } catch { return result; }
  for (const marketplace of marketplaces) {
    const marketRoot = path.join(root, marketplace);
    if (!fs.statSync(marketRoot).isDirectory()) continue;
    for (const plugin of fs.readdirSync(marketRoot)) {
      const pluginRoot = path.join(marketRoot, plugin);
      if (!fs.statSync(pluginRoot).isDirectory()) continue;
      for (const version of fs.readdirSync(pluginRoot)) {
        const versionRoot = path.join(pluginRoot, version);
        if (fs.statSync(versionRoot).isDirectory() && pathExists(path.join(versionRoot, '.codex-plugin', 'plugin.json'))) {
          result.push({ relative: path.join(marketplace, plugin, version), source: versionRoot });
        }
      }
    }
  }
  return result;
}

function syncPlugins(sourceDir, targetDir, previous = []) {
  const managed = [];
  for (const entry of pluginVersions(sourceDir)) {
    const destination = path.join(targetDir, 'plugins', 'cache', entry.relative);
    const wasManaged = previous.includes(entry.relative);
    if (pathExists(destination) && !wasManaged) continue;
    if (!pathExists(destination)) materializePluginTree(entry.source, destination, sourceDir, targetDir);
    managed.push(entry.relative);
  }
  return managed;
}

function assertAccounts(sourceAccount, targetAccount) {
  if (!sourceAccount || !targetAccount || sourceAccount.agent !== 'codex' || targetAccount.agent !== 'codex') {
    throw new Error('Codex capability sharing requires two Codex accounts');
  }
  const source = path.resolve(sourceAccount.configDir), target = path.resolve(targetAccount.configDir);
  const sourcePhysical = canonical(source), targetPhysical = canonical(target);
  if (sourcePhysical === targetPhysical || targetPhysical.startsWith(sourcePhysical + path.sep) || sourcePhysical.startsWith(targetPhysical + path.sep)) {
    throw new Error('source and target Codex config directories must be separate');
  }
  if (!fs.statSync(source).isDirectory()) throw new Error(`source Codex config directory does not exist: ${source}`);
  return { source, target };
}

function readSetup(account) {
  if (!account?.configDir) return null;
  const value = readJSON(path.join(account.configDir, MANIFEST), null);
  return value?.version === 1 ? value : null;
}

function shareSetup(sourceAccount, targetAccount) {
  const { source, target } = assertAccounts(sourceAccount, targetAccount);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const manifestFile = path.join(target, MANIFEST);
  const previous = readJSON(manifestFile, null);
  if (previous && (previous.version !== 1 || canonical(previous.sourceConfigDir) !== canonical(source))) {
    throw new Error('target Codex profile is already managed from a different source');
  }
  const sourceConfig = readToml(path.join(source, 'config.toml'));
  const targetConfig = readToml(path.join(target, 'config.toml'));
  const merged = mergeConfig(sourceConfig, targetConfig, previous?.config, source, target);
  const assets = { ...syncSimpleAssets(source, target, previous?.assets),
    ...syncMarketplaceAssets(sourceConfig, source, target, previous?.assets) };
  const pluginVersions = syncPlugins(source, target, previous?.pluginVersions);
  writeToml(path.join(target, 'config.toml'), merged.config);
  const manifest = { version: 1, sourceAccountId: sourceAccount.id, sourceConfigDir: source,
    config: merged.records, assets, pluginVersions, updatedAt: new Date().toISOString() };
  writeJSON(manifestFile, manifest);
  return { ok: true, idempotent: Boolean(previous), targetConfigDir: target,
    sharedEntries: [...Object.keys(assets), ...pluginVersions.map((entry) => path.join('plugins/cache', entry))] };
}

function refresh(account, options = {}) {
  const manifest = readSetup(account);
  if (!manifest) return { ok: true, managed: false };
  const source = options.sourceAccount || { id: manifest.sourceAccountId, agent: 'codex', configDir: manifest.sourceConfigDir };
  return { ...shareSetup(source, account), managed: true };
}

module.exports = { MANIFEST, CONFIG_ROOTS, readSetup, shareSetup, refresh, mergeConfig, desiredConfig };
