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
  './process-table.js',
]);

// Absolute paths, resolved relative to this directory (host.js lives beside it).
function hostOnlyModulePaths(list = HOST_ONLY_MODULES) {
  return list.map((file) => require.resolve(path.resolve(__dirname, file)));
}

function dropHostOnlyModules(list = HOST_ONLY_MODULES) {
  for (const file of hostOnlyModulePaths(list)) delete require.cache[file];
}

module.exports = { HOST_ONLY_MODULES, hostOnlyModulePaths, dropHostOnlyModules };
