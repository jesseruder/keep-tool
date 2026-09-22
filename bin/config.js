'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function configFile(env = process.env) {
  return path.resolve((env.KEEP_CONFIG || path.join(os.homedir(), '.config', 'keep', 'config.json')).replace(/^~(?=\/|$)/, os.homedir()));
}

function load(env = process.env) {
  const file = configFile(env);
  if (!fs.existsSync(file)) return {};
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || value.version !== 1 || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`unsupported Keep configuration: ${file}`);
  }
  return value;
}

const NODE_NAME_RE = /^[a-z0-9]+$/;

// A Keep install names its machines. Exactly one of them, `daemonNode`, runs the
// daemon; a config that mentions neither is the single-node install called 'main'.
function nodeConfig(value = {}) {
  const daemon = value.daemonNode === undefined ? 'main' : value.daemonNode;
  if (typeof daemon !== 'string' || !NODE_NAME_RE.test(daemon)) {
    throw new Error(`invalid Keep node name for daemonNode: ${JSON.stringify(value.daemonNode)}`);
  }
  if (value.nodes === undefined) return { nodes: { [daemon]: {} }, daemonNode: daemon };
  if (!value.nodes || typeof value.nodes !== 'object' || Array.isArray(value.nodes)) {
    throw new Error('invalid Keep configuration: nodes must be an object');
  }
  for (const [name, entry] of Object.entries(value.nodes)) {
    if (!NODE_NAME_RE.test(name)) throw new Error(`invalid Keep node name: ${name}`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`invalid Keep node configuration: ${name}`);
  }
  if (!Object.prototype.hasOwnProperty.call(value.nodes, daemon)) {
    throw new Error(`daemonNode ${daemon} is not one of the configured nodes`);
  }
  return { nodes: { ...value.nodes }, daemonNode: daemon };
}

function nodeNames(value = {}) { return Object.keys(nodeConfig(value).nodes); }
function daemonNode(value = {}) { return nodeConfig(value).daemonNode; }

function apply(env = process.env) {
  // An explicit data directory is an isolated registry (also used by tests).
  // Do not silently import another registry's settings into it.
  const value = env.KEEP_DIR && !env.KEEP_CONFIG ? {} : load(env);
  if (!env.KEEP_DIR && value.dataDir) {
    // KEEP_DIR came from this config rather than from the caller. Preserve that
    // provenance in the environment so later modules and child processes do not
    // mistake the configured registry for an explicitly isolated one.
    const file = configFile(env);
    env.KEEP_DIR = path.resolve(String(value.dataDir).replace(/^~(?=\/|$)/, os.homedir()));
    if (!env.KEEP_CONFIG) env.KEEP_CONFIG = file;
  }
  for (const [key, entry] of Object.entries(value.env || {})) {
    if (!/^KEEP_[A-Z0-9_]+$/.test(key) || ['KEEP_DIR', 'KEEP_CONFIG', 'KEEP_ALLOW_PUSH'].includes(key)) {
      throw new Error(`unsupported Keep configuration key: ${key}`);
    }
    if (!['string', 'number', 'boolean'].includes(typeof entry)) throw new Error(`invalid value for ${key}`);
    if (env[key] === undefined) env[key] = String(entry);
  }
  // Projected into the environment so a child process reads the same answer as
  // its parent, including one started with an isolated KEEP_DIR.
  for (const [key, envKey] of [['scopes', 'KEEP_SCOPES'], ['projectCatalog', 'KEEP_PROJECT_CATALOG'], ['modelBudgets', 'KEEP_MODEL_BUDGETS'], ['features', 'KEEP_FEATURES']]) {
    if (value[key] !== undefined && env[envKey] === undefined) env[envKey] = JSON.stringify(value[key]);
  }
  const { daemonNode: daemon } = nodeConfig(value);
  // Projected like the keys above so a child process, a host, and the daemon all
  // agree on which machine they are without re-reading the configuration.
  if (env.KEEP_DAEMON_NODE === undefined) env.KEEP_DAEMON_NODE = daemon;
  if (env.KEEP_NODE_NAME === undefined) env.KEEP_NODE_NAME = env.KEEP_DAEMON_NODE;
  require('../web/app/shared/scope-rules').validate(env.KEEP_SCOPES ? JSON.parse(env.KEEP_SCOPES) : undefined);
  require('./preferences').modelBudgets(env);
  return value;
}

module.exports = { configFile, load, apply, nodeConfig, nodeNames, daemonNode, NODE_NAME_RE };
