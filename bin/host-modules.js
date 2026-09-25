'use strict';
const path = require('node:path');

// Helper modules only the terminal host process runs, required lazily from host.js
// verb handlers. A host reload drops them from require.cache along with host.js, so
// `git pull` + `keep host reload` serves their new code too; without that the host
// kept the first-loaded copy until a full restart.
//
// usage.js and nodes.js stay out on purpose: they are shared config readers that
// the rest of keep loads too, and shared modules stay cached across a reload.
const HOST_ONLY_MODULES = Object.freeze([
  './node-stats.js',
  './node-inventory.js',
  './node-transcript.js',
  './launch-prep.js',
  './session-artifacts.js',
  './account-handoff-node.js',
  './process-table.js',
  './node-update.js',
]);

const HOST_MODULES_FILE = __filename;

const validList = (list) => Array.isArray(list) && list.every((file) => typeof file === 'string' && file);

// require.cache keys, built by hand. Never require.resolve: a helper a pull renamed
// or deleted must not throw in the middle of a reload.
function hostOnlyModulePaths(list = HOST_ONLY_MODULES) {
  return (validList(list) ? list : HOST_ONLY_MODULES).map((file) => path.resolve(__dirname, file));
}

// Drops whichever of the helpers are cached; a missing one is simply skipped.
function dropHostOnlyModules(list = HOST_ONLY_MODULES) {
  for (const file of hostOnlyModulePaths(list)) delete require.cache[file];
}

// The list as this file reads on disk now, so an addition takes effect through a
// reload. A file that is missing or does not load keeps the copy already loaded.
function readHostOnlyModules() {
  const cached = require.cache[HOST_MODULES_FILE];
  delete require.cache[HOST_MODULES_FILE];
  try {
    const fresh = require(HOST_MODULES_FILE).HOST_ONLY_MODULES;
    if (validList(fresh)) return fresh;
  } catch {}
  if (cached) require.cache[HOST_MODULES_FILE] = cached;
  else delete require.cache[HOST_MODULES_FILE];
  return HOST_ONLY_MODULES;
}

// The cache entries a reload replaces (the core, this file and the helpers), so a
// reload that falls back can put the previous core's own modules back.
function snapshotModules(files) {
  const snapshot = new Map();
  for (const file of files) snapshot.set(file, require.cache[file]);
  return snapshot;
}

function restoreModules(snapshot) {
  for (const [file, entry] of snapshot) {
    if (entry) require.cache[file] = entry;
    else delete require.cache[file];
  }
}

module.exports = {
  HOST_ONLY_MODULES,
  HOST_MODULES_FILE,
  hostOnlyModulePaths,
  dropHostOnlyModules,
  readHostOnlyModules,
  snapshotModules,
  restoreModules,
};
