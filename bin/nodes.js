'use strict';

// Node identity for the running process. The configuration is read once, by
// config.apply(), which projects the answers into the environment; everything
// else asks here so no other module parses the node configuration itself.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { NODE_NAME_RE } = require('./config');

const NODE_NAME_MEMO_MS = 1000;

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

// The node list comes from the configuration, so this is memoised: a caller may ask
// once per pane, and the answer changes only when `keep nodes add` rewrites the file.
let nodeEntryMemo = { at: 0, key: null, entries: null };
let nodeNameWarning = null;

// Every configured node, including the ones whose entry does not make sense: a
// caller that fans out has to know a node exists before it can report that it
// cannot be reached. Dropping them here is how a typo turns into "that machine has
// no panes" instead of "that machine's entry is unusable".
function configuredNodeEntries(env = process.env) {
  const key = `${env.KEEP_CONFIG || ''}\u0000${env.KEEP_DIR || ''}`;
  const now = Date.now();
  if (nodeEntryMemo.entries && nodeEntryMemo.key === key && now - nodeEntryMemo.at < NODE_NAME_MEMO_MS) {
    return nodeEntryMemo.entries;
  }
  let entries;
  try {
    entries = require('./node-registry.js')
      .listNodes(env)
      .map((node) => ({ name: node.name, invalid: node.invalid === true, reason: node.reason || null }));
    nodeNameWarning = null;
  } catch (error) {
    // Falling back silently would make a broken configuration look like a
    // single-node install, which is exactly the shape a fleet must not mistake.
    // Said once per distinct reason so a five-second scheduler cannot flood a log.
    entries = [{ name: daemonNode(env), invalid: false, reason: null }];
    const message = `keep: cannot read the node list (${error.message}); assuming the single node ${entries[0].name}`;
    if (nodeNameWarning !== message) {
      nodeNameWarning = message;
      try { process.stderr.write(`${message}\n`); } catch {}
    }
  }
  nodeEntryMemo = { at: now, key, entries };
  return entries;
}

function configuredNodeNames(env = process.env) {
  return configuredNodeEntries(env).filter((entry) => !entry.invalid).map((entry) => entry.name);
}

// Pane ids are the daemon node's own, bare, exactly as they always were; a pane on
// another node is named `<id>@<node>`. Every id-keyed surface — session.pane,
// layouts, delivery records, the console DOM, `keep pane <id>` — therefore keeps
// working untouched on one node.
//
// The separator is `@` and not `-` because a pane id may legally contain a hyphen:
// `keep pane new --name main-build` makes one, and with a hyphen a local pane could
// be read as another node's. `@` is outside the host's pane-id alphabet, so a bare
// id can never contain one and the split is unambiguous without reading any
// configuration at all. The last `@` wins, and a ref that names the daemon node is
// accepted and normalised back to bare.
const PANE_REF_SEPARATOR = '@';

function parsePaneRef(id, options = {}) {
  const env = options.env || process.env;
  const daemon = daemonNode(env);
  const value = String(id == null ? '' : id);
  const at = value.lastIndexOf(PANE_REF_SEPARATOR);
  if (at < 0) return { node: daemon, paneId: value, qualified: false };
  const node = value.slice(at + 1);
  const paneId = value.slice(0, at);
  if (node === daemon) return { node: daemon, paneId, qualified: false };
  return { node, paneId, qualified: true };
}

// The inverse: a pane on the daemon node keeps the id the host gave it.
function formatPaneRef(node, paneId, env = process.env) {
  return node === daemonNode(env) ? String(paneId) : `${paneId}${PANE_REF_SEPARATOR}${node}`;
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
  NODE_NAME_RE, PANE_REF_SEPARATOR, NODE_NAME_MEMO_MS,
  daemonNode, localNode, isDaemonNode, nodeTokens, writeNodeToken,
  configuredNodeEntries, configuredNodeNames, parsePaneRef, formatPaneRef,
};
