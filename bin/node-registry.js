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
//
// One unusable entry is reported as an unusable entry, by name and reason, and
// never throws: a typo in one node's address must not take the whole fleet — the
// daemon's own node included — out of every listing that reads this.
function listNodes(env = process.env) {
  const { nodes, invalid, daemonNode } = configuration(env);
  const unusable = (name, reason) => ({
    name, transport: null, daemon: name === daemonNode, capabilities: [], invalid: true, reason,
  });
  const described = Object.keys(nodes)
    .sort((a, b) => (a === daemonNode ? -1 : b === daemonNode ? 1 : a.localeCompare(b)))
    .map((name) => {
      try { return describeNode(name, nodes[name], daemonNode, env); }
      catch (error) { return unusable(name, error.message); }
    });
  // The entries the configuration itself could not make sense of travel with them:
  // a node nobody can reach is still a node whose panes must not be called gone.
  return [...described, ...Object.entries(invalid || {}).map(([name, reason]) => unusable(name, reason))];
}

function isRemote(name, env = process.env) {
  return !resolveNode(name, env).daemon;
}

// The daemon's own listener for its nodes: an `<ip>:<port>` in config.json's
// `nodeApi.listen`, or KEEP_NODE_API_LISTEN. It is separate from the public UI
// server on purpose — that one's proxy stamps the admin token — and it knows only
// node tokens.
//
// Answers { enabled: false } unless every condition holds: an address is given, this
// process is the daemon node, and the configuration names at least one other node.
// A single-node install therefore never starts it, whatever the file says. An
// address that does not parse, or that names a wildcard, is { enabled: false, error }:
// a listener nobody can reason about is not started.
function nodeApiListen(env = process.env) {
  let raw;
  try { raw = env.KEEP_DIR && !env.KEEP_CONFIG ? {} : config.load(env); }
  catch (error) { return { enabled: false, error: error.message }; }
  let text = null;
  if (raw.nodeApi !== undefined) {
    const entry = raw.nodeApi;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { enabled: false, error: 'invalid Keep configuration: nodeApi must be an object' };
    }
    const extra = Object.keys(entry).find((key) => key !== 'listen');
    if (extra) return { enabled: false, error: `unsupported Keep nodeApi key: ${extra}` };
    if (entry.listen !== undefined && typeof entry.listen !== 'string') {
      return { enabled: false, error: 'invalid Keep configuration: nodeApi.listen must be a string' };
    }
    if (entry.listen) text = entry.listen;
  }
  if (typeof env.KEEP_NODE_API_LISTEN === 'string' && env.KEEP_NODE_API_LISTEN.trim()) text = env.KEEP_NODE_API_LISTEN;
  if (!text) return { enabled: false, reason: 'not configured' };
  const nodes = require('./nodes.js');
  let daemon;
  try {
    if (!nodes.isDaemonNode(env)) return { enabled: false, reason: 'not the daemon node' };
    daemon = nodes.daemonNode(env);
  } catch (error) { return { enabled: false, error: error.message }; }
  let configured;
  try { configured = Object.keys(config.nodeConfig(raw).nodes); }
  catch (error) { return { enabled: false, error: error.message }; }
  if (!configured.some((name) => name !== daemon)) return { enabled: false, reason: 'no other node is configured' };
  const host = require('./host.js');
  let parsed;
  try {
    parsed = parseListenAddress(text);
    host.assertBindable(parsed.address, text);
  } catch (error) { return { enabled: false, error: error.message }; }
  if (parsed.port < 1) return { enabled: false, error: `a node API address needs a port between 1 and 65535: ${text}` };
  const shown = parsed.address.includes(':') ? `[${parsed.address}]:${parsed.port}` : `${parsed.address}:${parsed.port}`;
  return { enabled: true, listen: shown, address: parsed.address, port: parsed.port, url: `http://${shown}` };
}

module.exports = { resolveNode, listNodes, isRemote, registryRoot, nodeApiListen };
