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

test('node names are rejected by name when they are not usable', () => {
  withConfig({ nodes: { 'Mini Server': {} }, daemonNode: 'main' }, (env) => {
    assert.throws(() => config.apply(env), /invalid Keep node name: Mini Server/);
  });
  withConfig({ nodes: { mini: {} }, daemonNode: 'Mini' }, (env) => {
    assert.throws(() => config.apply(env), /invalid Keep node name for daemonNode/);
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
  const names = ['main', 'aws1'];
  const env = { KEEP_DAEMON_NODE: 'main' };
  const ref = (value) => nodes.parsePaneRef(value, { env, nodes: names });
  assert.deepEqual(ref('1a2b3c4d'), { node: 'main', paneId: '1a2b3c4d', qualified: false });
  assert.deepEqual(ref('aws1-1a2b3c4d'), { node: 'aws1', paneId: '1a2b3c4d', qualified: true });
  // A name that is not a configured node is part of the pane id, not a prefix:
  // `keep pane new --name build-1` makes one, and it belongs to the daemon node.
  assert.deepEqual(ref('build-1'), { node: 'main', paneId: 'build-1', qualified: false });
  assert.deepEqual(ref('aws1-build-1'), { node: 'aws1', paneId: 'build-1', qualified: true });
  assert.deepEqual(ref('-leading'), { node: 'main', paneId: '-leading', qualified: false });
  assert.deepEqual(ref(''), { node: 'main', paneId: '', qualified: false });
  assert.deepEqual(ref(undefined), { node: 'main', paneId: '', qualified: false });

  assert.equal(nodes.formatPaneRef('main', '1a2b3c4d', env), '1a2b3c4d');
  assert.equal(nodes.formatPaneRef('aws1', '1a2b3c4d', env), 'aws1-1a2b3c4d');
  assert.deepEqual(ref(nodes.formatPaneRef('aws1', 'build-1', env)),
    { node: 'aws1', paneId: 'build-1', qualified: true });
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
