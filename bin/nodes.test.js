'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('./config');
const nodes = require('./nodes');

function withConfig(value, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-nodes-test-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, ...value }));
    return run({ KEEP_CONFIG: file }, dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('an install that names no nodes is the single node main', () => {
  withConfig({}, (env) => {
    const value = config.apply(env);
    assert.deepEqual(config.nodeNames(value), ['main']);
    assert.equal(config.daemonNode(value), 'main');
    assert.equal(env.KEEP_DAEMON_NODE, 'main');
    assert.equal(env.KEEP_NODE_NAME, 'main');
    assert.equal(nodes.daemonNode(env), 'main');
    assert.equal(nodes.localNode(env), 'main');
    assert.equal(nodes.isDaemonNode(env), true);
  });
});

test('configured nodes name the daemon node and default this machine to it', () => {
  withConfig({ nodes: { mini: {}, laptop: { label: 'laptop' } }, daemonNode: 'mini' }, (env) => {
    const value = config.apply(env);
    assert.deepEqual(config.nodeNames(value), ['mini', 'laptop']);
    assert.equal(config.daemonNode(value), 'mini');
    assert.equal(env.KEEP_DAEMON_NODE, 'mini');
    assert.equal(env.KEEP_NODE_NAME, 'mini');
    assert.equal(nodes.localNode(env), 'mini');
  });
  withConfig({ nodes: { mini: {}, laptop: {} }, daemonNode: 'mini' }, (env) => {
    config.apply({ ...env, KEEP_NODE_NAME: 'laptop' });
    const local = { ...env, KEEP_NODE_NAME: 'laptop', KEEP_DAEMON_NODE: 'mini' };
    assert.equal(nodes.localNode(local), 'laptop');
    assert.equal(nodes.daemonNode(local), 'mini');
    assert.equal(nodes.isDaemonNode(local), false);
  });
});

test('an explicit node name in the environment wins over the configuration', () => {
  withConfig({ nodes: { mini: {}, laptop: {} }, daemonNode: 'mini' }, (env) => {
    const explicit = { ...env, KEEP_NODE_NAME: 'laptop' };
    config.apply(explicit);
    assert.equal(explicit.KEEP_NODE_NAME, 'laptop');
    assert.equal(explicit.KEEP_DAEMON_NODE, 'mini');
  });
});

test('an entry that is not usable is reported by name, not thrown over the whole map', () => {
  // One bad entry used to take the fleet down to a single node, which is how a node
  // that still exists starts to look like a machine with no panes.
  withConfig({ nodes: { main: {}, 'Mini Server': {}, aws1: null, laptop: {} }, daemonNode: 'main' }, (env) => {
    const value = config.apply(env);
    assert.deepEqual(config.nodeNames(value), ['main', 'laptop']);
    assert.deepEqual(config.nodeConfig(value).invalid, {
      'Mini Server': 'invalid Keep node name: Mini Server',
      aws1: 'invalid Keep node configuration: aws1',
    });
  });
  // What is left to work with, though, is still checked: a daemon node that names
  // nothing usable, and a nodes map that is not a map, are both fatal.
  withConfig({ nodes: { main: null }, daemonNode: 'main' }, (env) => {
    assert.throws(() => config.apply(env), /invalid Keep node configuration: main/);
  });
  withConfig({ nodes: { 'Mini Server': {} }, daemonNode: 'main' }, (env) => {
    assert.throws(() => config.apply(env), /daemonNode main is not one of the configured nodes/);
  });
  withConfig({ nodes: { mini: {} }, daemonNode: 'Mini' }, (env) => {
    assert.throws(() => config.apply(env), /invalid Keep node name for daemonNode/);
  });
  withConfig({ nodes: [], daemonNode: 'main' }, (env) => {
    assert.throws(() => config.apply(env), /nodes must be an object/);
  });
  // And the file-level shape is rejected exactly as it was.
  withConfig({}, (env, dir) => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 2 }));
    assert.throws(() => config.load(env), /unsupported Keep configuration/);
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
    assert.throws(() => config.load(env), /JSON/);
  });
  assert.throws(() => nodes.localNode({ KEEP_NODE_NAME: 'Laptop' }), /invalid node name in KEEP_NODE_NAME/);
  assert.throws(() => nodes.daemonNode({ KEEP_DAEMON_NODE: 'main node' }), /invalid node name in KEEP_DAEMON_NODE/);
});

test('the daemon node must be one of the configured nodes', () => {
  withConfig({ nodes: { laptop: {} }, daemonNode: 'mini' }, (env) => {
    assert.throws(() => config.apply(env), /daemonNode mini is not one of the configured nodes/);
  });
  withConfig({ nodes: { laptop: {} } }, (env) => {
    assert.throws(() => config.apply(env), /daemonNode main is not one of the configured nodes/);
  });
});

test('an isolated registry reads no configuration and is the single node main', () => {
  withConfig({ nodes: { mini: {}, laptop: {} }, daemonNode: 'mini' }, (env, dir) => {
    const isolated = { KEEP_DIR: dir };
    assert.deepEqual(config.apply(isolated), {});
    assert.equal(isolated.KEEP_DAEMON_NODE, 'main');
    assert.equal(isolated.KEEP_NODE_NAME, 'main');
    assert.equal(nodes.localNode(isolated), 'main');
    assert.equal(env.KEEP_CONFIG !== undefined, true);
  });
});

test('a pane ref is bare on the daemon node and qualified everywhere else', () => {
  const env = { KEEP_DAEMON_NODE: 'main' };
  const ref = (value) => nodes.parsePaneRef(value, { env });
  assert.deepEqual(ref('1a2b3c4d'), { node: 'main', paneId: '1a2b3c4d', qualified: false });
  assert.deepEqual(ref('1a2b3c4d@aws1'), { node: 'aws1', paneId: '1a2b3c4d', qualified: true });
  // A hyphen is a legal pane-id character, so it can never be the separator: a pane
  // named after the daemon node, or after another node, is still a local pane.
  assert.deepEqual(ref('main-build'), { node: 'main', paneId: 'main-build', qualified: false });
  assert.deepEqual(ref('ab-build'), { node: 'main', paneId: 'ab-build', qualified: false });
  assert.deepEqual(ref('ab-build@ab'), { node: 'ab', paneId: 'ab-build', qualified: true });
  // The last '@' wins, and a ref naming the daemon node is normalised back to bare.
  assert.deepEqual(ref('a@b@aws1'), { node: 'aws1', paneId: 'a@b', qualified: true });
  assert.deepEqual(ref('1a2b@main'), { node: 'main', paneId: '1a2b', qualified: false });
  assert.deepEqual(ref(''), { node: 'main', paneId: '', qualified: false });
  assert.deepEqual(ref(undefined), { node: 'main', paneId: '', qualified: false });

  assert.equal(nodes.formatPaneRef('main', '1a2b3c4d', env), '1a2b3c4d');
  assert.equal(nodes.formatPaneRef('aws1', '1a2b3c4d', env), '1a2b3c4d@aws1');
  // Round trip: every ref the fleet can build parses back to itself.
  for (const value of ['1a2b3c4d', 'main-build', 'ab-build', '1a2b3c4d@aws1', 'main-build@aws1', 'ab-build@ab']) {
    const parsed = ref(value);
    assert.equal(nodes.formatPaneRef(parsed.node, parsed.paneId, env), value, value);
  }
  // A pane id the host could mint never contains the separator, whatever it is named.
  const PANE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
  assert.equal(PANE_ID_PATTERN.test(nodes.PANE_REF_SEPARATOR), false);
});

test('the configured node names come from the configuration and fall back to the daemon node', () => {
  withConfig({ nodes: { mini: {}, laptop: { transport: 'tcp', address: '127.0.0.1:1' } }, daemonNode: 'mini' }, (env) => {
    assert.deepEqual(nodes.configuredNodeNames({ ...env, KEEP_DAEMON_NODE: 'mini' }).sort(), ['laptop', 'mini']);
  });
  // An isolated registry reads no configuration, so it is the single node main —
  // the same answer config.apply() projects into such an environment.
  const isolated = { KEEP_DIR: os.tmpdir() };
  assert.deepEqual(nodes.configuredNodeNames(isolated), ['main']);
});

test('one predicate answers whether a pane is on another machine', () => {
  const env = { KEEP_DAEMON_NODE: 'main' };
  // A ref is self-describing, and one naming this node is this node's.
  assert.equal(nodes.isRemotePane('1a2b3c4d', env), false);
  assert.equal(nodes.isRemotePane('1a2b3c4d@main', env), false);
  assert.equal(nodes.isRemotePane('1a2b3c4d@aws1', env), true);
  assert.equal(nodes.isRemotePane('main-build', env), false);
  assert.equal(nodes.isRemotePane('', env), false);
  assert.equal(nodes.isRemotePane(undefined, env), false);
  // A pane row from a fleet listing carries the node beside its qualified id.
  assert.equal(nodes.isRemotePane({ id: '1a2b3c4d', node: 'main' }, env), false);
  assert.equal(nodes.isRemotePane({ id: '1a2b3c4d@aws1', node: 'aws1' }, env), true);
  // What a single-node install produces: no node key at all, and no configuration
  // read to say so.
  assert.equal(nodes.isRemotePane({ id: '1a2b3c4d' }, env), false);
  assert.equal(nodes.isRemotePane({ id: '1a2b3c4d', node: '' }, env), false);
  assert.equal(nodes.isRemotePane(null, env), false);
  // The daemon node's name comes from the environment, so a node that calls itself
  // something else reads the same pane the other way round.
  assert.equal(nodes.isRemotePane({ node: 'aws1' }, { KEEP_DAEMON_NODE: 'aws1' }), false);
  assert.equal(nodes.isRemotePane({ node: 'main' }, { KEEP_DAEMON_NODE: 'aws1' }), true);
});
