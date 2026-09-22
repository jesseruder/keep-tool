'use strict';

// Node identity for the running process. The configuration is read once, by
// config.apply(), which projects the answers into the environment; everything
// else asks here so no other module parses the node configuration itself.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { NODE_NAME_RE } = require('./config');

function checked(name, source) {
  if (typeof name !== 'string' || !NODE_NAME_RE.test(name)) throw new Error(`invalid node name in ${source}: ${name}`);
  return name;
}

// A single-node install sets neither variable and is called 'main'.
function daemonNode(env = process.env) {
  return checked(env.KEEP_DAEMON_NODE || 'main', 'KEEP_DAEMON_NODE');
}

function localNode(env = process.env) {
  return env.KEEP_NODE_NAME ? checked(env.KEEP_NODE_NAME, 'KEEP_NODE_NAME') : daemonNode(env);
}

function isDaemonNode(env = process.env) { return localNode(env) === daemonNode(env); }

// Pane ids are the daemon node's own, bare, exactly as they always were; a pane on
// another node is named `<node>-<id>` so that one id identifies one pane across the
// whole fleet. Every id-keyed surface — session.pane, layouts, delivery records, the
// console DOM, `keep pane <id>` — therefore keeps working untouched on one node.
//
// The node list comes from the configuration, so this is memoised: a pane list asks
// once per pane, and the answer changes only when `keep nodes add` rewrites the file.
let nodeNameMemo = { at: 0, key: null, names: null };

function configuredNodeNames(env = process.env) {
  const key = `${env.KEEP_CONFIG || ''}\u0000${env.KEEP_DIR || ''}`;
  const now = Date.now();
  if (nodeNameMemo.names && nodeNameMemo.key === key && now - nodeNameMemo.at < 1000) return nodeNameMemo.names;
  let names;
  try { names = require('./node-registry.js').listNodes(env).map((node) => node.name); }
  catch { names = [daemonNode(env)]; }
  nodeNameMemo = { at: now, key, names };
  return names;
}

function parsePaneRef(id, options = {}) {
  const env = options.env || process.env;
  const value = String(id == null ? '' : id);
  const dash = value.indexOf('-');
  if (dash <= 0) return { node: daemonNode(env), paneId: value, qualified: false };
  const prefix = value.slice(0, dash);
  const names = options.nodes || configuredNodeNames(env);
  if (!names.includes(prefix)) return { node: daemonNode(env), paneId: value, qualified: false };
  return { node: prefix, paneId: value.slice(dash + 1), qualified: true };
}

// The inverse: a pane on the daemon node keeps the id the host gave it.
function formatPaneRef(node, paneId, env = process.env) {
  return node === daemonNode(env) ? String(paneId) : `${node}-${paneId}`;
}

// One secret per node, each in its own file so a node can be added or revoked
// without rewriting a shared one. A node presents its token to the daemon in
// x-keep-node-token; nothing else in the registry grants that class.
function tokenDir(root) { return path.join(root, '.keep', 'node-tokens'); }

function nodeTokens(root) {
  const result = {};
  let names;
  try { names = fs.readdirSync(tokenDir(root)); } catch { return result; }
  for (const name of names) {
    if (!NODE_NAME_RE.test(name)) continue;
    let token;
    try { token = fs.readFileSync(path.join(tokenDir(root), name), 'utf8').trim(); } catch { continue; }
    if (token) result[name] = token;
  }
  return result;
}

// Mints a node's token, refusing to overwrite one that already exists: a second
// call would silently lock out the node holding the first.
function writeNodeToken(root, name) {
  checked(name, 'node token');
  const dir = tokenDir(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dir, name), `${token}\n`, { mode: 0o600, flag: 'wx' });
  return token;
}

module.exports = {
  NODE_NAME_RE, daemonNode, localNode, isDaemonNode, nodeTokens, writeNodeToken,
  configuredNodeNames, parsePaneRef, formatPaneRef,
};
