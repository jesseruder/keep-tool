'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { connect, resolveNode } = require('./hostclient.js');
const { listNodes, isRemote } = require('./node-registry.js');
const { withTwoNodes } = require('./fixtures/two-node-hosts.js');

test('the registry resolves the daemon node to its socket and a remote node to its address', async (t) => {
  await withTwoNodes(t, async ({ sock, address, tokenFile }) => {
    assert.deepEqual(resolveNode('main'), {
      name: 'main', transport: 'unix', daemon: true, capabilities: [], sock,
    });
    assert.deepEqual(resolveNode('aws1'), {
      name: 'aws1', transport: 'tcp', daemon: false, capabilities: [], address, tokenFile,
    });
    assert.equal(isRemote('main'), false);
    assert.equal(isRemote('aws1'), true);
    assert.deepEqual(listNodes().map((node) => node.name), ['main', 'aws1']);
    assert.throws(() => resolveNode('nope'), /unknown Keep node: nope/);
  });
});

test('a unix node connects token-free and a tcp node connects with its token', async (t) => {
  await withTwoNodes(t, async ({ sock, main, aws1 }) => {
    const local = await connect({ node: 'main' });
    try {
      assert.equal(local.node, 'main');
      assert.equal(local.sock, sock);
      assert.equal(local.descriptor, undefined, 'the local socket needs no hello to be usable');
      assert.equal((await local.request('hello')).node, 'main');
    } finally { local.close(); }

    const remote = await connect({ node: 'aws1' });
    try {
      assert.equal(remote.node, 'aws1');
      assert.equal(remote.descriptor.node, 'aws1');
      assert.equal(remote.descriptor.protocol, 1);
      assert.equal(remote.descriptor.bootId, aws1.bootId);
      assert.notEqual(remote.descriptor.bootId, main.bootId);
      const { pane } = await remote.request('spawn', { cmd: '/bin/sh', args: ['-c', 'sleep 5'] });
      assert.deepEqual((await remote.request('list')).panes.map((entry) => entry.id), [pane.id]);
      // The pane lives on the remote host alone; the daemon node never saw it.
      const local = await connect({ node: 'main' });
      try { assert.deepEqual((await local.request('list')).panes, []); } finally { local.close(); }
    } finally { remote.close(); }
  });
});

test('a node that answers for another name is refused', async (t) => {
  await withTwoNodes(t, async ({ configFile, config, address, tokenFile }) => {
    fs.writeFileSync(configFile, JSON.stringify({
      ...config,
      nodes: { ...config.nodes, other: { transport: 'tcp', address, tokenFile } },
    }));
    await assert.rejects(connect({ node: 'other' }), /answers for Keep node aws1, not other/);
  });
});

test('a wrong token is refused by the host and surfaces as a closed connection', async (t) => {
  await withTwoNodes(t, async ({ root, configFile, config, address }) => {
    const wrong = `${root}/wrong.token`;
    fs.writeFileSync(wrong, 'not-the-token\n', { mode: 0o600 });
    fs.chmodSync(wrong, 0o600);
    fs.writeFileSync(configFile, JSON.stringify({
      ...config,
      nodes: { ...config.nodes, aws1: { transport: 'tcp', address, tokenFile: wrong } },
    }));
    await assert.rejects(connect({ node: 'aws1' }), /hello required/);
  });
});

test('an unnamed connect still reaches the daemon node socket unchanged', async (t) => {
  await withTwoNodes(t, async ({ sock }) => {
    const client = await connect();
    try {
      assert.equal(client.sock, sock);
      assert.equal(client.node, undefined);
      assert.equal((await client.request('hello')).node, 'main');
    } finally { client.close(); }
  });
});

test('a node prepares a launch on its own machine, and says so when it cannot', async (t) => {
  await withTwoNodes(t, async ({ root }) => {
    const path = require('node:path');
    const project = path.join(root, 'project');
    const configDir = path.join(root, 'claude-config');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    const account = { id: 'claude/default', agent: 'claude', configDir, builtIn: false, managed: false };
    const remote = await connect({ node: 'aws1' });
    try {
      const prepared = await remote.request('prepare-launch', {
        agent: 'claude',
        account,
        cwd: project,
        bypass: true,
        argv: ['claude', '--dangerously-skip-permissions', { insert: 'mcpConfig' }, '--session-id', 'abc'],
        pi: null,
      });
      assert.deepEqual(prepared.argv, ['claude', '--dangerously-skip-permissions', '--session-id', 'abc']);
      assert.equal(prepared.mcpConfig, '');
      // Prepared where the agent will run: the trust record is that machine's file.
      assert.equal(prepared.trusted, true);
      const state = JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8'));
      assert.equal(state.projects[fs.realpathSync(project)].hasTrustDialogAccepted, true);
      assert.equal(prepared.command,
        require('./agent-launcher.js').profileCommand(prepared.argv, account));

      // A refusal is an answer the caller can report, not a dropped connection.
      const refused = await remote.request('prepare-launch', {
        agent: 'claude', account: { id: 'x' }, cwd: project, bypass: false, argv: ['claude'], pi: null,
      }).then(() => null, (error) => error);
      assert.match(refused.message, /needs an account profile/);
      // The connection is still good.
      assert.equal((await remote.request('hello')).node, 'aws1');
    } finally { remote.close(); }
  });
});
