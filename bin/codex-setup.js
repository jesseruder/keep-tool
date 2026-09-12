'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
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

function rewriteJsonMetadata(source, destination, sourceDir, targetDir, strict = false) {
  let value;
  try { value = readJSON(source); }
  catch (error) {
    if (strict) throw error;
    return fs.copyFileSync(source, destination);
  }
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

const GENERATED_PLUGIN_FILES = new Set(['extension-host-config.json']);

function materializePluginTree(source, target, sourceDir, targetDir, relative = '') {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(source)) {
    const childRelative = relative ? path.join(relative, name) : name;
    if (GENERATED_PLUGIN_FILES.has(childRelative)) continue;
    const from = path.join(source, name), to = path.join(target, name);
    const stat = fs.statSync(from);
    if (stat.isDirectory()) materializePluginTree(from, to, sourceDir, targetDir, childRelative);
    else if (stat.isFile() && name.endsWith('.json')) {
      const strict = name === '.mcp.json' || childRelative === path.join('.codex-plugin', 'plugin.json');
      rewriteJsonMetadata(from, to, sourceDir, targetDir, strict);
    }
    else if (stat.isFile()) {
      fs.copyFileSync(from, to);
      fs.chmodSync(to, stat.mode & 0o777);
    }
  }
}

function pluginPackages(configDir) {
  const root = path.join(configDir, 'plugins', 'cache');
  const versions = [], aliases = [];
  let marketplaces = [];
  try { marketplaces = fs.readdirSync(root); } catch { return { versions, aliases }; }
  for (const marketplace of marketplaces) {
    const marketRoot = path.join(root, marketplace);
    if (!fs.statSync(marketRoot).isDirectory()) continue;
    for (const plugin of fs.readdirSync(marketRoot)) {
      const pluginRoot = path.join(marketRoot, plugin);
      if (!fs.statSync(pluginRoot).isDirectory()) continue;
      for (const version of fs.readdirSync(pluginRoot)) {
        const versionRoot = path.join(pluginRoot, version);
        const relative = path.join(marketplace, plugin, version);
        if (fs.lstatSync(versionRoot).isSymbolicLink()) {
          const resolved = canonical(versionRoot);
          if (resolved.startsWith(canonical(pluginRoot) + path.sep)) {
            aliases.push({ relative, version: path.basename(resolved) });
          }
        } else if (fs.statSync(versionRoot).isDirectory() && pathExists(path.join(versionRoot, '.codex-plugin', 'plugin.json'))) {
          versions.push({ relative, source: versionRoot });
        }
      }
    }
  }
  return { versions, aliases };
}

function filesIn(root) {
  const result = new Map();
  function visit(directory, prefix = '') {
    for (const name of fs.readdirSync(directory)) {
      const relative = prefix ? path.join(prefix, name) : name;
      const file = path.join(directory, name);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) visit(file, relative);
      else if (stat.isFile()) result.set(relative, file);
    }
  }
  visit(root);
  return result;
}

function fileDigest(file) {
  if (!file || !pathExists(file)) return 'missing';
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function publishFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.copyFileSync(source, temporary);
  fs.chmodSync(temporary, fs.statSync(source).mode & 0o777);
  fs.renameSync(temporary, target);
}

function syncPluginVersion(entry, destination, sourceDir, targetDir, previous, options) {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(parent, `.${path.basename(destination)}.keep-stage-`));
  try {
    materializePluginTree(entry.source, stage, sourceDir, targetDir);
    options.beforePluginCommit?.(stage, destination);
    const desired = filesIn(stage);
    if (!pathExists(destination)) {
      const records = Object.fromEntries([...desired].map(([relative, file]) => [relative,
        { sourceHash: fileDigest(file), targetHash: fileDigest(file), managed: true }]));
      fs.renameSync(stage, destination);
      return records;
    }
    if (!previous) return null;
    const targetFiles = filesIn(destination);
    const keys = new Set([...desired.keys(), ...targetFiles.keys(), ...Object.keys(previous)]);
    const decisions = new Map(), conflicts = [];
    for (const relative of [...keys].sort()) {
      if (GENERATED_PLUGIN_FILES.has(relative) && !desired.has(relative)) continue;
      const sourceHash = fileDigest(desired.get(relative));
      const targetHash = fileDigest(targetFiles.get(relative));
      const prior = previous[relative];
      let managed = false;
      if (!prior) {
        managed = sourceHash !== 'missing' && (targetHash === 'missing' || sourceHash === targetHash);
      } else {
        const sourceChanged = sourceHash !== prior.sourceHash;
        const targetChanged = targetHash !== prior.targetHash;
        managed = prior.managed === true;
        if (sourceChanged && targetChanged && sourceHash !== targetHash) conflicts.push(relative);
        else if (managed && targetChanged && !sourceChanged) managed = false;
        else if (sourceChanged && targetChanged && sourceHash === targetHash) managed = true;
      }
      decisions.set(relative, { sourceHash, targetHash, managed, prior });
    }
    if (conflicts.length) throw new Error(`Codex plugin sync conflicts at ${entry.relative}/${conflicts.join(`, ${entry.relative}/`)}`);
    for (const [relative, decision] of decisions) {
      const desiredFile = desired.get(relative), targetFile = path.join(destination, relative);
      const sourceChanged = !decision.prior || decision.sourceHash !== decision.prior.sourceHash;
      const targetChanged = !decision.prior || decision.targetHash !== decision.prior.targetHash;
      if (decision.managed && decision.sourceHash !== decision.targetHash && (!targetChanged || !decision.prior)) {
        if (desiredFile) publishFile(desiredFile, targetFile);
        else if (pathExists(targetFile)) fs.unlinkSync(targetFile);
      } else if (decision.managed && sourceChanged && !targetChanged) {
        if (desiredFile) publishFile(desiredFile, targetFile);
        else if (pathExists(targetFile)) fs.unlinkSync(targetFile);
      }
    }
    for (const [relative, decision] of decisions) decision.targetHash = fileDigest(path.join(destination, relative));
    return Object.fromEntries([...decisions].map(([relative, { sourceHash, targetHash, managed }]) =>
      [relative, { sourceHash, targetHash, managed }]));
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function linkValue(file, pluginRoot) {
  try {
    if (!fs.lstatSync(file).isSymbolicLink()) return null;
    const resolved = path.resolve(path.dirname(file), fs.readlinkSync(file));
    return resolved.startsWith(pluginRoot + path.sep) ? path.basename(resolved) : `external:${resolved}`;
  } catch { return null; }
}

function publishAlias(file, version) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.symlinkSync(version, temporary);
  fs.renameSync(temporary, file);
}

function syncPluginAliases(entries, targetDir, previous = {}) {
  const records = {};
  for (const entry of entries) {
    const file = path.join(targetDir, 'plugins', 'cache', entry.relative);
    const pluginRoot = path.dirname(file);
    const target = linkValue(file, pluginRoot);
    const prior = previous[entry.relative];
    let managed = false;
    if (!prior) {
      if (!pathExists(file)) { publishAlias(file, entry.version); managed = true; }
      else managed = target === entry.version;
    } else {
      const sourceChanged = entry.version !== prior.sourceTarget;
      const targetChanged = target !== prior.targetTarget;
      managed = prior.managed === true;
      if (sourceChanged && targetChanged && entry.version !== target) {
        throw new Error(`Codex plugin sync conflicts at ${entry.relative}`);
      }
      if (managed && sourceChanged && !targetChanged) publishAlias(file, entry.version);
      else if (managed && targetChanged && !sourceChanged) managed = false;
    }
    records[entry.relative] = { sourceTarget: entry.version, targetTarget: linkValue(file, pluginRoot), managed };
  }
  return records;
}

function syncPlugins(sourceDir, targetDir, previous = {}, options = {}) {
  const packages = pluginPackages(sourceDir);
  const pluginFiles = {}, versions = [];
  for (const entry of packages.versions) {
    const destination = path.join(targetDir, 'plugins', 'cache', entry.relative);
    const records = syncPluginVersion(entry, destination, sourceDir, targetDir, previous[entry.relative], options);
    if (records) { pluginFiles[entry.relative] = records; versions.push(entry.relative); }
  }
  return { versions, pluginFiles, aliases: syncPluginAliases(packages.aliases, targetDir, options.previousAliases) };
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

function shareSetup(sourceAccount, targetAccount, options = {}) {
  const { source, target } = assertAccounts(sourceAccount, targetAccount);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const manifestFile = path.join(target, MANIFEST);
  const previous = readJSON(manifestFile, null);
  if (previous && (previous.version !== 1 || canonical(previous.sourceConfigDir) !== canonical(source))) {
    throw new Error('target Codex profile is already managed from a different source');
  }
  const sourceConfig = readToml(path.join(source, 'config.toml'));
  const targetConfigFile = path.join(target, 'config.toml');
  const targetConfigHash = fileDigest(targetConfigFile);
  const targetConfig = readToml(targetConfigFile);
  const merged = mergeConfig(sourceConfig, targetConfig, previous?.config, source, target);
  const assets = { ...syncSimpleAssets(source, target, previous?.assets),
    ...syncMarketplaceAssets(sourceConfig, source, target, previous?.assets) };
  const legacyPlugins = previous?.pluginFiles || {};
  const plugins = syncPlugins(source, target, legacyPlugins, { ...options, previousAliases: previous?.pluginAliases });
  options.beforeConfigCommit?.();
  if (fileDigest(targetConfigFile) !== targetConfigHash) throw new Error('target Codex config changed during capability sync');
  if (!isDeepStrictEqual(merged.config, targetConfig)) writeToml(targetConfigFile, merged.config);
  const manifest = { version: 1, sourceAccountId: sourceAccount.id, sourceConfigDir: source,
    config: merged.records, assets, pluginVersions: plugins.versions, pluginFiles: plugins.pluginFiles,
    pluginAliases: plugins.aliases, updatedAt: new Date().toISOString() };
  writeJSON(manifestFile, manifest);
  return { ok: true, idempotent: Boolean(previous), targetConfigDir: target,
    sharedEntries: [...Object.keys(assets), ...plugins.versions.map((entry) => path.join('plugins/cache', entry))] };
}

function refresh(account, options = {}) {
  const manifest = readSetup(account);
  if (!manifest) return { ok: true, managed: false };
  const source = options.sourceAccount || { id: manifest.sourceAccountId, agent: 'codex', configDir: manifest.sourceConfigDir };
  return { ...shareSetup(source, account), managed: true };
}

module.exports = { MANIFEST, CONFIG_ROOTS, readSetup, shareSetup, refresh, mergeConfig, desiredConfig };
