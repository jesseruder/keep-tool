'use strict';

// Where each Keep node is and how to reach it. bin/nodes.js answers who *this*
// process is; this module answers where the *others* are, which is a question only
// the configuration can settle. Nothing else parses config.json's `nodes`.
const os = require('node:os');
const path = require('node:path');
const config = require('./config.js');
const { parseListenAddress } = require('./host.js');

const DEFAULT_TRANSPORTS = { daemon: 'unix', other: 'tcp' };

// The same rule bin/keep-core.js uses, spelled out here rather than required: a
// node agent runs on a machine that may hold no registry at all, and requiring
// keep.js is what creates one.
function registryRoot(env = process.env) {
  return env.KEEP_DIR || path.join(os.homedir(), 'keep');
}

function expand(value, env = process.env) {
  return path.resolve(String(value).replace(/^~(?=\/|$)/, env.HOME || os.homedir()));
}

// An explicit data directory is an isolated registry, as in config.apply(): do not
// read the machine's own node list into it.
function configuration(env = process.env) {
  return config.nodeConfig(env.KEEP_DIR && !env.KEEP_CONFIG ? {} : config.load(env));
}

function capabilityList(name, value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    throw new Error(`invalid capabilities for Keep node ${name}`);
  }
  return [...value];
}

function describeNode(name, entry, daemonNode, env) {
  const daemon = name === daemonNode;
  const transport = entry.transport === undefined
    ? (daemon ? DEFAULT_TRANSPORTS.daemon : DEFAULT_TRANSPORTS.other)
    : String(entry.transport);
  if (!['unix', 'tcp'].includes(transport)) {
    throw new Error(`invalid transport for Keep node ${name}: ${JSON.stringify(entry.transport)}`);
  }
  const common = { name, transport, daemon, capabilities: capabilityList(name, entry.capabilities) };
  if (transport === 'unix') {
    // The daemon node is reached exactly as it always was, so a single-node
    // install goes through the same socket lookup it used before nodes existed.
    return {
      ...common,
      sock: entry.sock ? expand(entry.sock, env) : require('./hostclient.js').socketPath(),
    };
  }
  if (!entry.address) throw new Error(`Keep node ${name} needs an address`);
  const address = String(entry.address);
  parseListenAddress(address);
  return {
    ...common,
    address,
    tokenFile: entry.tokenFile
      ? expand(entry.tokenFile, env)
      : path.join(registryRoot(env), '.keep', 'node-tokens', name),
  };
}

function resolveNode(name, env = process.env) {
  const { nodes, daemonNode } = configuration(env);
  const wanted = String(name || '') || daemonNode;
  if (!Object.prototype.hasOwnProperty.call(nodes, wanted)) throw new Error(`unknown Keep node: ${wanted}`);
  return describeNode(wanted, nodes[wanted], daemonNode, env);
}

// The daemon node first: a caller that fans out and merges wants the node whose
// pane ids stay bare to be the one it reads first.
function listNodes(env = process.env) {
  const { nodes, daemonNode } = configuration(env);
  return Object.keys(nodes)
    .sort((a, b) => (a === daemonNode ? -1 : b === daemonNode ? 1 : a.localeCompare(b)))
    .map((name) => describeNode(name, nodes[name], daemonNode, env));
}

function isRemote(name, env = process.env) {
  return !resolveNode(name, env).daemon;
}

module.exports = { resolveNode, listNodes, isRemote, registryRoot };
