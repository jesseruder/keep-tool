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

module.exports = { NODE_NAME_RE, daemonNode, localNode, isDaemonNode, nodeTokens, writeNodeToken };
