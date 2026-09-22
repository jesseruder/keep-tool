'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('./config.js');
const registry = require('./node-registry.js');
const { commands } = require('./commands/nodes.js');
const { withTwoNodes } = require('./fixtures/two-node-hosts.js');

// `keep nodes` writes to the registry root and to config.json, so both are
// temporary here and restored afterwards.
function withRegistry(t, initial = { version: 1 }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-nodes-cmd-')));
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify(initial, null, 2)}\n`);
  const previous = { KEEP_CONFIG: process.env.KEEP_CONFIG, KEEP_DIR: process.env.KEEP_DIR };
  process.env.KEEP_CONFIG = configFile;
  process.env.KEEP_DIR = root;
  // keep-core caches ROOT at require time, and the commands read it through it.
  const core = require('./keep-core.js');
  const previousRoot = core.ROOT;
  Object.defineProperty(core, 'ROOT', { value: root, configurable: true, writable: true });
  t.after(() => {
    Object.defineProperty(core, 'ROOT', { value: previousRoot, configurable: true, writable: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, configFile, read: () => JSON.parse(fs.readFileSync(configFile, 'utf8')) };
}

function capture(body) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  return Promise.resolve()
    .then(body)
    .finally(() => { console.log = original; })
    .then(() => lines.join('\n'));
}

test('keep nodes add mints a token, writes the entry, and prints the line to run on the node', async (t) => {
  const registryDir = withRegistry(t, { version: 1, dataDir: '/somewhere', env: { KEEP_PORT: 8888 } });
  const output = await capture(() => commands.nodes(['add', 'aws1', '--address', '100.64.0.2:7777', '--capabilities', 'build, gpu']));
  const written = registryDir.read();
  // The daemon node is written alongside it: a nodes map without it would not load.
  assert.deepEqual(written.nodes, {
    main: {},
    aws1: { transport: 'tcp', address: '100.64.0.2:7777', capabilities: ['build', 'gpu'] },
  });
  assert.equal(written.dataDir, '/somewhere', 'every other key survives the rewrite');
  assert.deepEqual(written.env, { KEEP_PORT: 8888 });
  assert.equal(written.daemonNode, 'main');
  const tokenFile = path.join(registryDir.root, '.keep', 'node-tokens', 'aws1');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert.ok(output.includes(token), 'the token is printed once');
  assert.match(output, /keep node init aws1 --daemon-node main --listen 100\.64\.0\.2:7777 --token-file/);

  // The registry sees it at once, with the defaults filled in.
  assert.deepEqual(registry.resolveNode('aws1'), {
    name: 'aws1', transport: 'tcp', daemon: false, capabilities: ['build', 'gpu'],
    address: '100.64.0.2:7777', tokenFile,
  });
});

test('keep nodes add refuses the daemon node, a duplicate, and a bad name', async (t) => {
  withRegistry(t);
  await capture(() => commands.nodes(['add', 'aws1', '--address', '100.64.0.2:7777']));
  await assert.rejects(commands.nodes(['add', 'aws1', '--address', '100.64.0.2:7777']), /already has a token/);
  await assert.rejects(commands.nodes(['add', 'main', '--address', '100.64.0.2:7777']), /daemon node/);
  await assert.rejects(commands.nodes(['add', 'Aws-2', '--address', '100.64.0.2:7777']), /lowercase letters and digits/);
  await assert.rejects(commands.nodes(['add', 'aws2']), /usage: keep nodes add/);
});

test('keep nodes rm takes the entry and the token away, and refuses the daemon node', async (t) => {
  const registryDir = withRegistry(t);
  await capture(() => commands.nodes(['add', 'aws1', '--address', '100.64.0.2:7777']));
  const tokenFile = path.join(registryDir.root, '.keep', 'node-tokens', 'aws1');
  assert.equal(fs.existsSync(tokenFile), true);
  await capture(() => commands.nodes(['rm', 'aws1']));
  assert.deepEqual(registryDir.read().nodes, { main: {} });
  assert.equal(fs.existsSync(tokenFile), false);
  await assert.rejects(commands.nodes(['rm', 'aws1']), /no such node/);
  await assert.rejects(commands.nodes(['rm', 'main']), /daemon node/);
});

test('a configuration that would not load again is never written', async (t) => {
  const registryDir = withRegistry(t);
  assert.throws(() => config.update(() => ({ version: 1, nodes: { main: {}, 'Bad Name': {} } })), /invalid Keep node name/);
  assert.deepEqual(registryDir.read(), { version: 1 });
});

test('keep nodes lists every node with a live hello check', async (t) => {
  await withTwoNodes(t, async ({ address, aws1 }) => {
    const first = await capture(() => commands.nodes([], { timeoutMs: 2000 }));
    assert.match(first, /^name\s+transport\s+endpoint\s+capabilities\s+status/m);
    assert.match(first, /main \(daemon\)\s+unix\s+\S+host\.sock\s+-\s+ok protocol 1/);
    assert.match(first, new RegExp(`aws1\\s+tcp\\s+${address.replace('.', '\\.')}\\s+-\\s+ok protocol 1`));
    const json = JSON.parse(await capture(() => commands.nodes(['ls', '--json'], { timeoutMs: 2000 })));
    assert.deepEqual(json.map((row) => [row.name, row.reachable]), [['main', true], ['aws1', true]]);
    assert.equal(json[1].bootId, aws1.bootId);

    await aws1.close();
    const down = await capture(() => commands.nodes(['ls'], { timeoutMs: 500 }));
    assert.match(down, /aws1\s+tcp\s+\S+\s+-\s+unreachable:/);
    assert.match(down, /main \(daemon\)\s+unix\s+\S+\s+-\s+ok protocol 1/, 'a node that is down says nothing about the others');
  });
});
