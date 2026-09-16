'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const toml = require('@iarna/toml');

const MANIFEST = '.keep-codex-capabilities.json';
// What a profile can do: tables whose entries are individual capabilities.
const CONFIG_ROOTS = ['features', 'plugins', 'mcp_servers', 'apps', 'marketplaces', 'hooks', 'experimental_hooks'];
// How a profile behaves: top-level preferences a second profile has no reason to
// diverge on. `project_doc_fallback_filenames` is why Codex reads CLAUDE.md, and
// `projects` carries per-directory trust, so a profile without them behaves
// differently in every repository. Scalars and arrays are single leaves; tables
// merge per entry, so trust entries union and the target keeps its own.
// Deliberately not managed, because they are per-profile or per-machine:
// `notify`, `tui`, `desktop`, `notice`, and the target's own `auth.json`,
// `history`, and `model_provider` routing. `hooks.state` is inside a managed
// root but its trusted-hash keys name the profile's own hooks.json path, so
// `managedLeaves` splits it per hook path and `rebaseValue` rewrites the keys
// into the target home; a hash recorded for a source-only path never applies to
// the target. `marketplaces` sources inside the source home are rebased the same
// way and linked into the target.
const PREFERENCE_ROOTS = ['model', 'model_reasoning_effort', 'service_tier', 'project_doc_fallback_filenames',
  'shell_environment_policy', 'projects'];
const MANAGED_ROOTS = [...CONFIG_ROOTS, ...PREFERENCE_ROOTS];
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
  for (const root of MANAGED_ROOTS) {
    if (!Object.prototype.hasOwnProperty.call(config, root)) continue;
    const value = config[root];
    // A scalar or an array is one value, not a container of values: an array
    // merges whole so a reordered or trimmed list stays a single decision.
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
  for (const root of MANAGED_ROOTS) {
    if (Object.prototype.hasOwnProperty.call(sourceConfig, root)) desired[root] = rebaseValue(sourceConfig[root], sourceDir, targetDir);
  }
  return desired;
}

function mergeConfig(sourceConfig, targetConfig, previous, sourceDir, targetDir, deferred = []) {
  const desired = desiredConfig(sourceConfig, sourceDir, targetDir);
  const sourceLeaves = managedLeaves(desired);
  const targetLeaves = managedLeaves(targetConfig);
  const old = new Map((previous || []).map((entry) => [JSON.stringify(entry.path), entry]));
  const keys = new Set([...sourceLeaves.keys(), ...targetLeaves.keys(), ...old.keys()]);
  const frozen = new Set(deferred.map((trail) => JSON.stringify(trail)));
  const result = structuredClone(targetConfig);
  const decisions = [];
  const conflicts = [];

  for (const key of [...keys].sort()) {
    // A frozen leaf takes part in no decision this run: not written, not
    // compared, and its prior record travels forward untouched below.
    if (frozen.has(key)) continue;
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
  if (conflicts.length) {
    // The list travels on the error so a read-only preview can report the paths
    // without parsing the message.
    throw Object.assign(new Error(`Codex capability sync conflicts at ${conflicts.join(', ')}`), { conflicts });
  }

  const records = decisions.map(({ path: trail, managed }) => ({
    path: trail,
    sourceHash: digest(getAt(desired, trail)),
    targetHash: digest(getAt(result, trail)),
    managed,
  }));
  // A frozen leaf keeps the record it already had, byte for byte, so the merge
  // that runs after the swap sees the state from before it. A leaf with no prior
  // record gets none this run.
  for (const key of frozen) if (old.has(key)) records.push(structuredClone(old.get(key)));
  records.sort((a, b) => JSON.stringify(a.path) < JSON.stringify(b.path) ? -1 : 1);
  return { config: result, records, desired, deferred: [...frozen].map((key) => JSON.parse(key)) };
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

const PLUGIN_MANIFEST = '.keep-codex-plugin.json';

function generatedPluginFile(relative) {
  return path.basename(relative) === 'extension-host-config.json' || path.basename(relative) === PLUGIN_MANIFEST;
}

function materializePluginTree(source, target, sourceDir, targetDir, relative = '') {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(source)) {
    const childRelative = relative ? path.join(relative, name) : name;
    if (generatedPluginFile(childRelative)) continue;
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
      if (generatedPluginFile(relative)) continue;
      const file = path.join(directory, name);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) visit(file, relative);
      else if (stat.isFile()) result.set(relative, file);
    }
  }
  visit(root);
  return result;
}

function assertNoDirectoryLinks(root, label) {
  function visit(directory, prefix = '') {
    for (const name of fs.readdirSync(directory)) {
      const relative = prefix ? path.join(prefix, name) : name;
      const file = path.join(directory, name);
      const link = fs.lstatSync(file);
      if (link.isSymbolicLink() && fs.statSync(file).isDirectory()) {
        throw new Error(`Codex plugin sync conflicts at ${label}/${relative}`);
      }
      if (link.isDirectory()) visit(file, relative);
    }
  }
  visit(root);
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
      writeJSON(path.join(stage, PLUGIN_MANIFEST), { version: 1, sourceConfigDir: sourceDir,
        pluginVersion: entry.relative, files: records });
      fs.renameSync(stage, destination);
      return records;
    }
    if (fs.lstatSync(destination).isSymbolicLink()) {
      if (canonical(destination) !== canonical(entry.source)) return null;
      const records = Object.fromEntries([...desired].map(([relative, file]) => [relative,
        { sourceHash: fileDigest(file), targetHash: fileDigest(file), managed: true }]));
      writeJSON(path.join(stage, PLUGIN_MANIFEST), { version: 1, sourceConfigDir: sourceDir,
        pluginVersion: entry.relative, files: records });
      fs.unlinkSync(destination);
      fs.renameSync(stage, destination);
      return records;
    }
    const ownership = readJSON(path.join(destination, PLUGIN_MANIFEST), null);
    if (ownership?.version === 1 && ownership.pluginVersion === entry.relative
        && canonical(ownership.sourceConfigDir) === canonical(sourceDir)) previous = ownership.files;
    previous ||= {};
    assertNoDirectoryLinks(destination, entry.relative);
    const targetFiles = filesIn(destination);
    const keys = new Set([...desired.keys(), ...targetFiles.keys(), ...Object.keys(previous)]);
    const decisions = new Map(), conflicts = [];
    for (const relative of [...keys].sort()) {
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
      if (!decision.prior && decision.managed && desiredFile) {
        publishFile(desiredFile, targetFile);
      } else if (decision.managed && decision.sourceHash !== decision.targetHash && (!targetChanged || !decision.prior)) {
        if (desiredFile) publishFile(desiredFile, targetFile);
        else if (pathExists(targetFile)) fs.unlinkSync(targetFile);
      } else if (decision.managed && sourceChanged && !targetChanged) {
        if (desiredFile) publishFile(desiredFile, targetFile);
        else if (pathExists(targetFile)) fs.unlinkSync(targetFile);
      }
    }
    for (const [relative, decision] of decisions) decision.targetHash = fileDigest(path.join(destination, relative));
    const records = Object.fromEntries([...decisions].map(([relative, { sourceHash, targetHash, managed }]) =>
      [relative, { sourceHash, targetHash, managed }]));
    writeJSON(path.join(destination, PLUGIN_MANIFEST), { version: 1, sourceConfigDir: sourceDir,
      pluginVersion: entry.relative, files: records });
    return records;
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

// A Codex fallback compaction rewrites `model` and `model_reasoning_effort` in
// the account's own config.toml and restores them when it ends, recording the
// transaction in `<keep>/.keep/compact/<session>.swap.json`. That rewrite is a
// transaction, not an account-local choice: left to the ordinary merge, a
// refresh inside that window would record the swapped value as a target edit and
// demote the leaf to an override, or — if the source moved too — raise a
// conflict and stop the launch. While a swap for this profile is pending both
// leaves are frozen instead, and the merge after the restore picks up where it
// left off.
const SWAP_DEFERRED = [['model'], ['model_reasoning_effort']];
const SWAP_REASON = 'compaction swap pending';

function pendingSwap(targetDir) {
  let compact;
  try { compact = require('./codex-compact'); } catch { return false; }
  let directory, names;
  try { directory = compact.compactDir(); names = fs.readdirSync(directory); } catch { return false; }
  const wanted = path.join(canonical(targetDir), 'config.toml');
  for (const name of names) {
    if (!name.endsWith('.swap.json')) continue;
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); } catch { continue; }
    if (!compact.isCodexCompactSwap(record) || typeof record.configFile !== 'string') continue;
    const file = path.join(canonical(path.dirname(record.configFile)), path.basename(record.configFile));
    if (file === wanted) return true;
  }
  return false;
}

function deferredLeaves(targetDir) {
  return pendingSwap(targetDir) ? SWAP_DEFERRED.map((trail) => [...trail]) : [];
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
  const frozen = deferredLeaves(target);
  let merged = mergeConfig(sourceConfig, targetConfig, previous?.config, source, target, frozen);
  const assets = { ...syncSimpleAssets(source, target, previous?.assets),
    ...syncMarketplaceAssets(sourceConfig, source, target, previous?.assets) };
  const legacyPlugins = previous?.pluginFiles || {};
  const plugins = syncPlugins(source, target, legacyPlugins, { ...options, previousAliases: previous?.pluginAliases });
  options.beforeConfigCommit?.();
  if (fileDigest(targetConfigFile) !== targetConfigHash) throw new Error('target Codex config changed during capability sync');
  // Asset and plugin sync takes time, and a compaction can record its swap in
  // that window before it touches the config — so the unchanged-config check
  // above passes and the first scan is already stale. The config on disk is
  // provably identical, so re-merging with the wider frozen set is pure.
  const late = deferredLeaves(target);
  if (late.length > frozen.length) merged = mergeConfig(sourceConfig, targetConfig, previous?.config, source, target, late);
  if (!isDeepStrictEqual(merged.config, targetConfig)) writeToml(targetConfigFile, merged.config);
  const manifest = { version: 1, sourceAccountId: sourceAccount.id, sourceConfigDir: source,
    config: merged.records, assets, pluginVersions: plugins.versions, pluginFiles: plugins.pluginFiles,
    pluginAliases: plugins.aliases, updatedAt: new Date().toISOString() };
  writeJSON(manifestFile, manifest);
  return { ok: true, idempotent: Boolean(previous), targetConfigDir: target,
    deferred: merged.deferred.map((trail) => ({ path: displayPath(trail), reason: SWAP_REASON })),
    sharedEntries: [...Object.keys(assets), ...plugins.versions.map((entry) => path.join('plugins/cache', entry))] };
}

function refresh(account, options = {}) {
  const manifest = readSetup(account);
  if (!manifest) return { ok: true, managed: false };
  const source = options.sourceAccount || { id: manifest.sourceAccountId, agent: 'codex', configDir: manifest.sourceConfigDir };
  return { ...shareSetup(source, account), managed: true };
}

// Exactly the two things a refresh does to shared links, decided the way
// `ensureLink` decides them: add a link the target does not have yet, and remove
// one Keep still manages whose source is gone. A target that holds its own file
// there is an intentional override, and a link Keep no longer manages is the
// target's to keep, so neither is reported.
function assetChanges(sourceConfig, sourceDir, targetDir, previous = {}) {
  const changes = [];
  const consider = (source, target, name) => {
    if (pathExists(source)) { if (!pathExists(target)) changes.push(`${name} (add)`); }
    else if (previous[name] && expectedLink(previous[name], target)) changes.push(`${name} (remove)`);
  };
  for (const name of FILE_ASSETS) consider(path.join(sourceDir, name), path.join(targetDir, name), name);
  for (const container of DIRECTORY_ASSETS) {
    const sourceRoot = path.join(sourceDir, container), targetRoot = path.join(targetDir, container);
    if (!pathExists(sourceRoot) || expectedLink(sourceRoot, targetRoot)) continue;
    if (pathExists(targetRoot) && !fs.statSync(targetRoot).isDirectory()) continue;
    const names = fs.readdirSync(sourceRoot);
    for (const name of names) consider(path.join(sourceRoot, name), path.join(targetRoot, name), path.join(container, name));
    for (const relative of Object.keys(previous)) {
      if (path.dirname(relative) !== container || names.includes(path.basename(relative))) continue;
      consider(path.join(sourceRoot, path.basename(relative)), path.join(targetRoot, path.basename(relative)), relative);
    }
  }
  // Marketplace links are only ever added; a refresh never removes one.
  for (const [name, definition] of Object.entries(sourceConfig.marketplaces || {})) {
    const source = typeof definition?.source === 'string' ? path.resolve(definition.source) : null;
    if (!source || !(source === sourceDir || source.startsWith(sourceDir + path.sep)) || !pathExists(source)) continue;
    consider(source, path.join(targetDir, path.relative(sourceDir, source)), `marketplaces/${name}`);
  }
  return changes;
}

// The same reads and the same merge as shareSetup, with nothing written: what a
// refresh would change, so `keep doctor` can report drift without repairing it.
function preview(sourceAccount, targetAccount) {
  const { source, target } = assertAccounts(sourceAccount, targetAccount);
  const previous = readJSON(path.join(target, MANIFEST), null);
  if (previous && (previous.version !== 1 || canonical(previous.sourceConfigDir) !== canonical(source))) {
    throw new Error('target Codex profile is already managed from a different source');
  }
  const sourceConfig = readToml(path.join(source, 'config.toml'));
  const targetConfig = readToml(path.join(target, 'config.toml'));
  const frozen = deferredLeaves(target);
  const deferred = frozen.map((trail) => ({ path: displayPath(trail), reason: SWAP_REASON }));
  const configChanges = [], conflicts = [];
  try {
    const merged = mergeConfig(sourceConfig, targetConfig, previous?.config, source, target, frozen);
    for (const record of merged.records) {
      if (digest(getAt(merged.config, record.path)) !== digest(getAt(targetConfig, record.path))) {
        configChanges.push(displayPath(record.path));
      }
    }
  } catch (error) {
    if (!Array.isArray(error.conflicts)) throw error;
    conflicts.push(...error.conflicts);
  }
  return { managed: Boolean(previous), configChanges,
    assetChanges: assetChanges(sourceConfig, source, target, previous?.assets),
    conflicts, deferred };
}

function previewRefresh(account) {
  const manifest = readSetup(account);
  if (!manifest) return { managed: false, configChanges: [], assetChanges: [], conflicts: [], deferred: [] };
  const source = { id: manifest.sourceAccountId, agent: 'codex', configDir: manifest.sourceConfigDir };
  return { ...preview(source, account), managed: true, sourceAccountId: manifest.sourceAccountId };
}

module.exports = { MANIFEST, CONFIG_ROOTS, PREFERENCE_ROOTS, MANAGED_ROOTS,
  readSetup, shareSetup, refresh, preview, previewRefresh, mergeConfig, desiredConfig };
