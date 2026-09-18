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

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function fileIdentity(file) {
  try {
    const stat = fs.statSync(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function sameFileIdentity(before, after) {
  if (!before || !after) return before === after;
  return before.mtimeMs === after.mtimeMs && before.size === after.size && before.ino === after.ino;
}

function acquireStateLock(file, timeoutMs) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      fs.mkdirSync(lock);
      return lock;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`claude state file is locked: ${file}`);
    sleepSync(Math.min(50, remaining));
  }
}

// Which directory key, if any, makes this account trust `cwd`: the directory itself or
// the nearest ancestor the operator has already accepted the folder-trust dialog for.
// Read-only, and a missing or unreadable state file is simply no trust.
function trustedProjectFor(account, cwd) {
  let state;
  try { state = readJSON(stateFile(account), {}); } catch { return null; }
  const projects = state && typeof state === 'object' && !Array.isArray(state) ? state.projects : null;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return null;
  let directory;
  try { directory = fs.realpathSync(cwd); } catch { directory = path.resolve(String(cwd || '')); }
  for (let current = directory; ; current = path.dirname(current)) {
    const entry = projects[current];
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry.hasTrustDialogAccepted === true) return current;
    if (path.dirname(current) === current) return null;
  }
}

function trustProject(account, cwd, options = {}) {
  const file = stateFile(account);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = acquireStateLock(file, options.lockTimeoutMs ?? 2_000);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = fileIdentity(file);
      const state = readJSON(file, {});
      if (!state || typeof state !== 'object' || Array.isArray(state)) {
        throw new Error(`invalid JSON object in ${file}`);
      }
      const project = fs.realpathSync(cwd);
      const projects = state.projects && typeof state.projects === 'object' && !Array.isArray(state.projects)
        ? state.projects : {};
      const entry = projects[project] && typeof projects[project] === 'object' && !Array.isArray(projects[project])
        ? projects[project] : {};
      if (entry.hasTrustDialogAccepted === true) return false;
      state.projects = { ...projects, [project]: { ...entry, hasTrustDialogAccepted: true } };

      const temporary = `${file}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        if (!sameFileIdentity(before, fileIdentity(file))) {
          fs.unlinkSync(temporary);
          continue;
        }
        fs.renameSync(temporary, file);
        return true;
      } catch (error) {
        try { fs.unlinkSync(temporary); } catch {}
        throw error;
      }
    }
    throw new Error(`claude state file changed while updating: ${file}`);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
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
  if (keepGenerated(generated, generatedText, { desired, legacy })) return desired;
  throw new Error(`managed MCP configuration conflicts for ${canonical(cwd)}`);
}

function mcpConfigPath(configDir, cwd) {
  return path.join(configDir, 'projects', projectKey(cwd), '.keep-mcp.json');
}

function mcpText(servers) {
  return JSON.stringify({ mcpServers: servers }, null, 2) + '\n';
}

// Keep records the digest of every .keep-mcp.json it writes, so a file generated from an
// older source server set can be told apart from a hand edit.
function mcpRecordPath(file) {
  return file + '.sha256';
}

function textDigest(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function readMcpRecord(file) {
  try { return fs.readFileSync(mcpRecordPath(file), 'utf8').trim(); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function recordMcpConfig(file, text) {
  fs.writeFileSync(mcpRecordPath(file), textDigest(text) + '\n', { mode: 0o600 });
}

function writeMcpConfig(file, servers) {
  writeJSON(file, { mcpServers: servers });
  recordMcpConfig(file, mcpText(servers));
}

function keepGenerated(file, text, sets) {
  const recorded = readMcpRecord(file);
  if (recorded) return recorded === textDigest(text);
  // Files from before Keep recorded its writes: accept the former global-plus-exact-cwd
  // output, or Keep's exact, non-empty serialization whose every server the source still
  // defines identically in one of those sets (an older subset, as when a server was added).
  // A deletion-only edit looks the same and is rewritten; removed or changed servers conflict.
  if (text === mcpText(sets.legacy)) return true;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return false; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).join() !== 'mcpServers') return false;
  const servers = parsed.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers) || text !== mcpText(servers)) return false;
  const entries = Object.entries(servers);
  return entries.length > 0 && [sets.desired, sets.legacy].some((set) => entries
    .every(([name, value]) => Object.hasOwn(set, name) && digest(set[name]) === digest(value)));
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
    if (Object.keys(servers).length) { writeMcpConfig(path.join(stage, 'projects', key, '.keep-mcp.json'), servers); mcpProjects++; }
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

// Read-only counterpart of verifyManaged: which shared entries are no longer the
// link the manifest recorded, so `keep doctor` can report drift without repairing
// it. A Codex account has its own manifest and its own preview.
function previewRefresh(account) {
  const manifest = account?.agent === 'claude' && account.configDir ? readSetup(account) : null;
  if (!manifest) return { managed: false, entries: [] };
  const source = canonical(manifest.sourceConfigDir), target = canonical(account.configDir);
  const entries = (manifest.sharedEntries || [])
    .filter((name) => !expectedLink(path.join(source, name), path.join(target, name)));
  return { managed: true, sourceAccountId: manifest.sourceAccountId, entries, plugins: missingPlugins(account) };
}

// Plugins are per profile: the install record and the cache belong to that home, so
// setup never links them. Nor does it call `claude plugin install`, which edits
// `enabledPlugins` in settings.json — the source's own file behind a shared link — and
// can prompt for approval. The shared settings already enable the plugins; what the
// target lacks is the installed copy. Setup copies the exact cache version the source
// recorded, through a private staging directory, and adds the source's record with its
// install path moved into the target home. Claude refuses to load a plugin whose
// marketplace the profile does not know, so a marketplace the target lacks is copied the
// same way from the source's clone, with its record in known_marketplaces.json. Only a
// cache or clone inside the source's own plugins directory is copied; anything else is
// reported, never guessed at.
function pluginRecords(configDir) {
  const plugins = readJSON(path.join(configDir, 'plugins', 'installed_plugins.json'), {})?.plugins;
  return plugins && typeof plugins === 'object' && !Array.isArray(plugins) ? plugins : {};
}

function userEntry(records, id) {
  return Array.isArray(records[id]) ? records[id].find((entry) => entry?.scope === 'user') : null;
}

function pluginSource(account) {
  const manifest = account?.agent === 'claude' && account.configDir ? readSetup(account) : null;
  return manifest ? canonical(manifest.sourceConfigDir) : null;
}

function missingPlugins(account) {
  const source = pluginSource(account);
  if (!source) return [];
  const sourceRecords = pluginRecords(source), targetRecords = pluginRecords(account.configDir);
  return Object.keys(sourceRecords).filter((id) => userEntry(sourceRecords, id) && !userEntry(targetRecords, id)).sort();
}

// Runtime markers Claude keeps beside a cache version for the sessions of the profile
// that owns it; a copy starts without them.
const PLUGIN_RUNTIME_MARKERS = new Set(['.in_use', '.orphaned_at']);

// `targetRoot` is `<target>/plugins/<kind>` spelled from the target's physical path, so
// a symlinked plugins, cache or marketplaces directory, or any symlinked parent below
// it, resolves elsewhere and is refused before anything is staged or accepted.
function copyPluginDir(sourceRoot, targetRoot, relative) {
  const destination = path.join(targetRoot, relative);
  // Create each parent one level at a time, refusing a symlink before anything is
  // written through it.
  let parent = targetRoot;
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  for (const part of path.dirname(relative).split(path.sep).filter((entry) => entry && entry !== '.')) {
    parent = path.join(parent, part);
    const stat = fs.lstatSync(parent, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error(`${relative} resolves outside the target profile`);
    if (!stat) fs.mkdirSync(parent, { mode: 0o700 });
  }
  if (canonical(path.dirname(destination)) !== path.dirname(destination)) {
    throw new Error(`${relative} resolves outside the target profile`);
  }
  const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (existing) {
    if (!existing.isDirectory()) throw new Error(`target ${relative} exists and is not a directory`);
    return destination;
  }
  const stage = fs.mkdtempSync(path.join(path.dirname(destination), `.${path.basename(destination)}.copy-`));
  const from = path.join(sourceRoot, relative);
  try {
    fs.cpSync(from, path.join(stage, 'plugin'), { recursive: true, verbatimSymlinks: true,
      filter: (file) => !(path.dirname(file) === from && PLUGIN_RUNTIME_MARKERS.has(path.basename(file))) });
    fs.renameSync(path.join(stage, 'plugin'), destination);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  return destination;
}

// Read-modify-write of a JSON file a running Claude may also write. `update` gets the
// current value and returns the value to write, or null for no change. The rename only
// lands if the file is still the one that was read; otherwise it reads again.
function updateJSON(file, fallback, update) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = fileIdentity(file);
    const next = update(readJSON(file, fallback));
    if (next == null) return;
    const temporary = `${file}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (!sameFileIdentity(before, fileIdentity(file))) { fs.unlinkSync(temporary); continue; }
    fs.renameSync(temporary, file);
    return;
  }
  throw new Error(`${file} kept changing while updating it`);
}

function insideDirectory(file, root) {
  return file.startsWith(root + path.sep) && fs.statSync(file, { throwIfNoEntry: false })?.isDirectory() === true;
}

// Copies each marketplace the named plugins need and the target does not know. Returns
// the marketplaces that could not be provided, so their plugins are reported, not copied.
function syncMarketplaces(source, targetDir, ids) {
  const knownFile = (dir) => path.join(dir, 'plugins', 'known_marketplaces.json');
  const sourceKnown = readJSON(knownFile(source), {});
  const targetKnown = readJSON(knownFile(targetDir), {});
  const sourceRoot = canonical(path.join(source, 'plugins', 'marketplaces'));
  const targetRoot = path.join(targetDir, 'plugins', 'marketplaces');
  const unavailable = new Map(), additions = {};
  for (const name of new Set(ids.map((id) => id.slice(id.lastIndexOf('@') + 1)))) {
    if (targetKnown[name]) {
      // The target's own marketplace is kept as it is, but a record whose clone is gone
      // would make Claude reject every plugin from it.
      const own = targetKnown[name].installLocation;
      if (typeof own !== 'string' || !fs.statSync(own, { throwIfNoEntry: false })?.isDirectory()) {
        unavailable.set(name, `the target's marketplace ${name} has no clone at its recorded location`);
      }
      continue;
    }
    const entry = sourceKnown[name];
    const location = entry?.installLocation ? canonical(entry.installLocation) : '';
    if (!insideDirectory(location, sourceRoot)) { unavailable.set(name, `marketplace ${name} is not cloned in the source profile`); continue; }
    try { additions[name] = { ...entry, installLocation: copyPluginDir(sourceRoot, targetRoot, path.relative(sourceRoot, location)) }; }
    catch (error) { unavailable.set(name, error.message); }
  }
  if (Object.keys(additions).length) {
    updateJSON(knownFile(targetDir), {}, (current) => {
      for (const [name, entry] of Object.entries(additions)) if (!current[name]) current[name] = entry;
      return current;
    });
  }
  return unavailable;
}

function syncPlugins(account) {
  const source = pluginSource(account);
  const installed = [], failed = [];
  if (!source) return { installed, failed };
  const sourceCache = canonical(path.join(source, 'plugins', 'cache'));
  const targetCache = path.join(canonical(account.configDir), 'plugins', 'cache');
  const sourceRecords = pluginRecords(source);
  const missing = missingPlugins(account);
  for (const relative of ['plugins', 'plugins/cache', 'plugins/marketplaces']) {
    if (fs.lstatSync(path.join(canonical(account.configDir), relative), { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`target ${relative} is a symlink; Keep copies plugins only into the profile's own directory`);
    }
  }
  fs.mkdirSync(path.join(account.configDir, 'plugins'), { recursive: true, mode: 0o700 });
  const unavailable = syncMarketplaces(source, canonical(account.configDir), missing);
  const additions = {};
  for (const id of missing) {
    const entry = userEntry(sourceRecords, id);
    const installPath = entry.installPath ? canonical(entry.installPath) : '';
    const marketplace = unavailable.get(id.slice(id.lastIndexOf('@') + 1));
    if (marketplace) { failed.push({ id, error: marketplace }); continue; }
    if (!insideDirectory(installPath, sourceCache)) {
      failed.push({ id, error: 'source install is not a directory in its plugins/cache' });
      continue;
    }
    try {
      const destination = copyPluginDir(sourceCache, targetCache, path.relative(sourceCache, installPath));
      additions[id] = { ...entry, installPath: destination };
    } catch (error) { failed.push({ id, error: error.message }); }
  }
  if (Object.keys(additions).length) {
    updateJSON(path.join(account.configDir, 'plugins', 'installed_plugins.json'), { version: 2, plugins: {} }, (state) => {
      const plugins = state.plugins && typeof state.plugins === 'object' && !Array.isArray(state.plugins) ? state.plugins : {};
      installed.length = 0;
      for (const [id, entry] of Object.entries(additions)) {
        if (userEntry(plugins, id)) continue;
        plugins[id] = [...(Array.isArray(plugins[id]) ? plugins[id] : []), entry];
        installed.push(id);
      }
      return installed.length ? { ...state, version: state.version || 2, plugins } : null;
    });
  }
  return { installed, failed };
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
    const desired = mcpText(servers);
    if (fs.existsSync(mcpConfig)) {
      const actual = fs.readFileSync(mcpConfig, 'utf8');
      if (actual !== desired) {
        const state = sourceState(sourceAccount, sourceStateFile).value;
        if (!keepGenerated(mcpConfig, actual, mcpServerSets(state, cwd))) {
          throw new Error(`managed MCP configuration conflicts for ${canonical(cwd)}`);
        }
        writeMcpConfig(mcpConfig, servers);
      } else if (readMcpRecord(mcpConfig) !== textDigest(desired)) recordMcpConfig(mcpConfig, desired);
    } else writeMcpConfig(mcpConfig, servers);
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

// comparableSettings strips hooks on purpose — they name an absolute keep path and
// are not portable state. They are still the restart guard and the raw-resume
// guard, so a handoff must not put a session in an account that lacks one the
// source has; that is its own reason rather than a settings difference.
function keepHookActions(configDir) {
  let text = '';
  try { text = fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'); } catch {}
  return require('./setup').HOOK_ACTIONS.filter((action) => text.includes(` hook ${action}`));
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
  const targetHooks = keepHookActions(targetAccount.configDir);
  const missingHooks = keepHookActions(sourceAccount.configDir).filter((action) => !targetHooks.includes(action));
  if (missingHooks.length) reasons.push(`target account is missing Keep hooks: ${missingHooks.join(', ')}`);
  if (digest(source.mcpServers) !== digest(target.mcpServers)) reasons.push('effective MCP servers differ');
  if (canonical(source.memoryDir) !== canonical(target.memoryDir)) reasons.push('project memory differs');
  return { ok: reasons.length === 0, reasons, mcpConfig: target.mcpConfig,
    memoryDir: target.memoryDir, autoMemoryDirectory: target.autoMemoryDirectory };
}

module.exports = { MANIFEST, shareSetup, readSetup, previewRefresh, missingPlugins, syncPlugins, ensureSharedMemory, compatible, effectiveMcpServers,
  projectKey, repositoryRoot, stateFile, trustProject, trustedProjectFor, mcpConfigPath };
