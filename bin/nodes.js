'use strict';

// Node identity for the running process. The configuration is read once, by
// config.apply(), which projects the answers into the environment; everything
// else asks here so no other module parses the node configuration itself.
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

module.exports = { NODE_NAME_RE, daemonNode, localNode, isDaemonNode };
