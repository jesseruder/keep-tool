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
  if (value.nodes === undefined) return { nodes: { [daemon]: {} }, invalid: {}, daemonNode: daemon };
  if (!value.nodes || typeof value.nodes !== 'object' || Array.isArray(value.nodes)) {
    throw new Error('invalid Keep configuration: nodes must be an object');
  }
  // One unusable entry is reported, by name and reason, rather than thrown over the
  // whole map. Throwing here collapsed the fleet to the daemon node, and a node that
  // has silently ceased to exist is a node whose panes look gone — which is how a
  // pending message on it would be thrown away. The map's own shape, and a daemonNode
  // that names nothing usable, are still fatal: neither leaves anything to work with.
  const nodes = {};
  const invalid = {};
  for (const [name, entry] of Object.entries(value.nodes)) {
    if (!NODE_NAME_RE.test(name)) invalid[name] = `invalid Keep node name: ${name}`;
    else if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid[name] = `invalid Keep node configuration: ${name}`;
    else nodes[name] = entry;
  }
  if (!Object.prototype.hasOwnProperty.call(nodes, daemon)) {
    throw new Error(invalid[daemon] || `daemonNode ${daemon} is not one of the configured nodes`);
  }
  return { nodes, invalid, daemonNode: daemon };
}

// Where work goes when nobody says. `default` is the node a fresh session lands on,
// and `projects` names a node per project, keyed by the project exactly as a card
// writes it. Both name a configured node.
//
// One entry that does not resolve is reported and dropped, exactly as nodeConfig
// treats one unusable node entry: a placement is a preference, and a preference
// naming a machine this install no longer has must not be able to stop `keep serve`
// from booting or `keep nodes rm` from finishing the removal that caused it. The
// placement map's own shape is still fatal, because a malformed one leaves nothing
// to work with. An *edit* that writes such an entry is still refused, by update
// below — introducing it is a mistake, inheriting it is a fact.
function placementConfig(value = {}) {
  const { nodes } = nodeConfig(value);
  const placement = value.placement;
  const invalid = {};
  if (placement === undefined) return { default: null, projects: {}, invalid };
  if (!placement || typeof placement !== 'object' || Array.isArray(placement)) {
    throw new Error('invalid Keep configuration: placement must be an object');
  }
  for (const key of Object.keys(placement)) {
    if (!['default', 'projects'].includes(key)) throw new Error(`unsupported Keep placement key: ${key}`);
  }
  const configured = (name, where) => {
    const reason = typeof name !== 'string' || !NODE_NAME_RE.test(name)
      ? `invalid Keep node name in placement ${where}: ${JSON.stringify(name)}`
      : !Object.prototype.hasOwnProperty.call(nodes, name)
        ? `Keep placement ${where} names a node that is not configured: ${name}`
        : null;
    if (!reason) return name;
    invalid[where] = reason;
    return null;
  };
  const projects = {};
  if (placement.projects !== undefined) {
    if (!placement.projects || typeof placement.projects !== 'object' || Array.isArray(placement.projects)) {
      throw new Error('invalid Keep configuration: placement.projects must be an object');
    }
    for (const [project, name] of Object.entries(placement.projects)) {
      if (!project) throw new Error('invalid Keep placement: a project key cannot be empty');
      const target = configured(name, `projects.${project}`);
      if (target) projects[project] = target;
    }
  }
  return {
    default: placement.default === undefined ? null : configured(placement.default, 'default'),
    projects,
    invalid,
  };
}

// Rewrites config.json in place, atomically, keeping every key it does not touch
// and the file's own mode. `mutate` is handed the parsed configuration and returns
// the one to write; a result that would not load again is refused before the write,
// so a bad edit cannot leave an install unable to start.
function update(mutate, env = process.env) {
  // The same rule accounts keep: an explicit data directory is an isolated
  // registry, and config.json belongs to the machine, not to it. Without this a
  // `keep nodes add` run inside a test or a scratch registry would rewrite the
  // operator's real node list.
  if (env.KEEP_DIR && !env.KEEP_CONFIG) {
    throw new Error('Keep configuration changes require KEEP_CONFIG when KEEP_DIR is explicitly set');
  }
  const file = configFile(env);
  const current = fs.existsSync(file) ? load(env) : { version: 1 };
  const next = mutate(current);
  if (!next || typeof next !== 'object' || Array.isArray(next) || next.version !== 1) {
    throw new Error('a Keep configuration must stay a version 1 object');
  }
  // An edit may not introduce an entry nothing can use. One that was already there
  // is not this edit's fault and must not block fixing the rest of the file.
  const before = (() => { try { return nodeConfig(current).invalid; } catch { return {}; } })();
  const after = nodeConfig(next).invalid;
  for (const [name, reason] of Object.entries(after)) {
    if (!Object.prototype.hasOwnProperty.call(before, name)) throw new Error(reason);
  }
  // The same rule for placement. `keep nodes rm` is what makes an entry stop
  // resolving, so it clears the entries it invalidates itself rather than leaving
  // one here for the next edit to trip over.
  const placedBefore = (() => { try { return placementConfig(current).invalid; } catch { return {}; } })();
  for (const [where, reason] of Object.entries(placementConfig(next).invalid)) {
    if (!Object.prototype.hasOwnProperty.call(placedBefore, where)) throw new Error(reason);
  }
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode });
  fs.renameSync(temp, file);
  return next;
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
  // Resolved here and projected in its checked form, so nothing downstream parses
  // the file again. An entry naming a machine this install no longer has is said out
  // loud and left out: the daemon still starts, and the sessions that entry would
  // have placed land where they would have without it.
  const placement = placementConfig(value);
  for (const [where, reason] of Object.entries(placement.invalid)) {
    try { process.stderr.write(`keep: ignoring placement ${where}: ${reason}\n`); } catch {}
  }
  if (env.KEEP_PLACEMENT === undefined) {
    env.KEEP_PLACEMENT = JSON.stringify({ default: placement.default, projects: placement.projects });
  }
  require('../web/app/shared/scope-rules').validate(env.KEEP_SCOPES ? JSON.parse(env.KEEP_SCOPES) : undefined);
  require('./preferences').modelBudgets(env);
  return value;
}

module.exports = { configFile, load, update, apply, nodeConfig, placementConfig, nodeNames, daemonNode, NODE_NAME_RE };
