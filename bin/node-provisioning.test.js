'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const setup = require('./setup.js');
// Loaded before a test pretends to be Linux: node-pty picks its native build by platform.
require('./host.js');
const keepConsole = require('./console.js');
const { routes, matchRoute, routeDenial } = require('./serve/routes.js');
const nodeApi = require('./serve/node-api.js');
const { createRegistryService } = require('./registry-route.js');

function tempDir(t, prefix = 'keep-node-provision-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function capture(body) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  return Promise.resolve().then(body).finally(() => { console.log = original; }).then(() => lines.join('\n'));
}

function asLinux(t) {
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', { value: platform, configurable: true }));
}

test('keep node init writes KEEP_DAEMON_URL into the host service only when given one', async (t) => {
  asLinux(t);
  const home = tempDir(t);
  const tokenFile = path.join(home, 'node.token');
  fs.writeFileSync(tokenFile, `${'b'.repeat(64)}\n`, { mode: 0o600 });
  const unitFile = path.join(home, '.config', 'systemd', 'user', 'keep-host.service');
  const base = ['init', 'aws1', '--daemon-node', 'main', '--listen', '100.64.0.2:7777', '--token-file', tokenFile, '--sock', path.join(home, 'host.sock')];

  assert.throws(() => setup.node([...base, '--daemon-url', 'https://100.64.0.1:7781'], '/tmp/r', home), /KEEP_DAEMON_URL must be http/);
  assert.throws(() => setup.node([...base, '--daemon-url', 'http://100.64.0.1:7781/api'], '/tmp/r', home), /KEEP_DAEMON_URL must be http/);
  assert.equal(fs.existsSync(unitFile), false, 'nothing is written for a URL the CLI would refuse');

  const output = await capture(() => setup.node([...base, '--daemon-url', 'http://100.64.0.1:7781'], '/tmp/r', home));
  const unit = fs.readFileSync(unitFile, 'utf8');
  assert.ok(unit.includes('Environment=KEEP_DAEMON_URL="http://100.64.0.1:7781"'), unit);
  assert.match(output, /registry commands go to the daemon's node API at http:\/\/100\.64\.0\.1:7781/);

  fs.rmSync(unitFile);
  const plain = await capture(() => setup.node(base, '/tmp/r', home));
  assert.doesNotMatch(fs.readFileSync(unitFile, 'utf8'), /KEEP_DAEMON_URL/);
  assert.doesNotMatch(plain, /node API/);
});

// keep nodes writes config.json and the token directory, so both are temporary.
function withRegistry(t, initial) {
  const root = tempDir(t, 'keep-nodes-provision-');
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify(initial, null, 2)}\n`);
  const previous = { KEEP_CONFIG: process.env.KEEP_CONFIG, KEEP_DIR: process.env.KEEP_DIR };
  process.env.KEEP_CONFIG = configFile;
  process.env.KEEP_DIR = root;
  const core = require('./keep-core.js');
  const previousRoot = core.ROOT;
  Object.defineProperty(core, 'ROOT', { value: root, configurable: true, writable: true });
  t.after(() => {
    Object.defineProperty(core, 'ROOT', { value: previousRoot, configurable: true, writable: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return { root, configFile };
}

test('keep nodes add prints the daemon URL in the init line once the daemon listens for nodes', async (t) => {
  const { commands } = require('./commands/nodes.js');
  withRegistry(t, { version: 1, nodeApi: { listen: '100.64.0.1:7781' } });
  const output = await capture(() => commands.nodes(['add', 'aws1', '--address', '100.64.0.2:7777']));
  assert.match(output, /keep node init aws1 --daemon-node main --listen 100\.64\.0\.2:7777 --token-file ~\/\.keep-node-token --daemon-url http:\/\/100\.64\.0\.1:7781$/m);
});

test('keep nodes add prints the init line it always did without a node API', async (t) => {
  const { commands } = require('./commands/nodes.js');
  withRegistry(t, { version: 1 });
  const output = await capture(() => commands.nodes(['add', 'aws1', '--address', '100.64.0.2:7777']));
  assert.match(output, /keep node init aws1 --daemon-node main --listen 100\.64\.0\.2:7777 --token-file ~\/\.keep-node-token$/m);
  assert.doesNotMatch(output, /daemon-url/);
});

test('keep nodes shows the node API address on the daemon row, and only there', async (t) => {
  const { commands } = require('./commands/nodes.js');
  const nodes = { main: {}, aws1: { transport: 'tcp', address: '100.64.0.2:7777' } };
  const connect = async () => ({ descriptor: { protocol: 3, bootId: 'b', platform: 'linux', home: os.homedir(), panes: 0 }, close() {} });
  withRegistry(t, { version: 1, daemonNode: 'main', nodes, nodeApi: { listen: '100.64.0.1:7781' } });
  const rows = JSON.parse(await capture(() => commands.nodes(['--json'], { connect })));
  assert.equal(rows.find((row) => row.name === 'main').nodeApi, '100.64.0.1:7781');
  assert.equal('nodeApi' in rows.find((row) => row.name === 'aws1'), false);
  const table = await capture(() => commands.nodes(['ls'], { connect }));
  assert.match(table.split('\n').find((line) => line.startsWith('main')), /\(node api 100\.64\.0\.1:7781\)/);

  const plain = await capture(() => commands.nodes(['--json'], { connect, nodeApiListen: () => ({ enabled: false }) }));
  assert.equal(JSON.parse(plain).some((row) => 'nodeApi' in row), false);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// The node listener in front of the real route list, as serve.js assembles it.
async function nodeListener(t) {
  const root = tempDir(t);
  const registryService = createRegistryService({ root, daemonNode: () => 'main', location: () => null, env: { PATH: '/usr/bin', HOME: root } });
  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const list = routes({ json, nodeApiEnabled: () => true, registryService });
  const handler = nodeApi.createNodeApiHandler({
    routes: list, matchRoute, routeDenial, principal: keepConsole.principal, json, log: () => {},
    tokenStore: nodeApi.createNodeTokenStore({ initial: { aws1: 'aws1-secret' }, read: () => ({ aws1: 'aws1-secret' }) }),
    readBody: () => Promise.resolve({}),
  });
  const server = http.createServer(handler);
  const port = await listen(server);
  t.after(() => server.close());
  return `http://127.0.0.1:${port}`;
}

test('the ping route answers a node through the node listener, and nothing else there', async (t) => {
  const url = await nodeListener(t);
  const remote = require('./remote-cli.js');
  const ping = await remote.nodeApiRequest(url, '/api/registry/ping', { method: 'GET', token: 'aws1-secret' });
  assert.equal(ping.status, 200);
  const value = JSON.parse(ping.data);
  assert.equal(value.ok, true);
  assert.equal(value.node, 'aws1');
  assert.equal(value.daemon, 'main');
  assert.ok(Number.isFinite(Date.parse(value.now)));
  assert.equal((await remote.nodeApiRequest(url, '/api/registry/ping', { method: 'GET', token: 'wrong' })).status, 403);
  assert.equal((await remote.nodeApiRequest(url, '/api/state', { method: 'GET', token: 'aws1-secret' })).status, 403,
    'a route that does not allow a node is refused on the node listener');
});

test('doctor reports the node API from the daemon side', async () => {
  let state = null;
  const report = (listen, others = []) => setup.nodeApiReport({
    env: {}, nodeApiListen: () => listen, listNodes: () => [{ name: 'main', daemon: true }, ...others],
    readState: () => state, pidAlive: (pid) => pid === 4242,
  });
  assert.deepEqual(await report({ enabled: false, reason: 'not configured' }), [], 'a single-node install hears nothing about it');
  const on = { enabled: true, listen: '100.64.0.1:7781' };
  // Configured, but the daemon has said nothing: not proof of a bound listener.
  const silent = await report(on);
  assert.equal(silent[0].status, 'optional');
  assert.match(silent[0].text, /configured at 100\.64\.0\.1:7781; the running daemon has not reported binding it/);
  state = { pid: 4242, listen: '100.64.0.1:7781', state: 'listening' };
  assert.deepEqual(await report(on), [{ status: 'ok', text: 'node API listening at 100.64.0.1:7781' }]);
  state = { pid: 4242, listen: '100.64.0.1:7781', state: 'retrying', error: 'listen EADDRNOTAVAIL' };
  const retrying = await report(on);
  assert.equal(retrying[0].status, 'FAIL');
  assert.match(retrying[0].text, /not bound: listen EADDRNOTAVAIL; the daemon keeps retrying/);
  state = { pid: 9999, listen: '100.64.0.1:7781', state: 'listening' };
  assert.equal((await report(on))[0].status, 'optional', 'a record from a daemon that is gone');
  state = { pid: 4242, listen: '100.64.0.1:7790', state: 'listening' };
  assert.equal((await report(on))[0].status, 'optional', 'a record for another address');
  const absent = await report({ enabled: false, reason: 'not configured' }, [{ name: 'aws1', daemon: false }]);
  assert.equal(absent[0].status, 'optional');
  assert.match(absent[0].text, /node API listener absent/);
  const bad = await report({ enabled: false, error: 'refusing to bind 0.0.0.0' });
  assert.equal(bad[0].status, 'FAIL');
  assert.match(bad[0].text, /refusing to bind 0\.0\.0\.0/);
});

test('doctor on a pane-only node says whether KEEP_DAEMON_URL reaches the daemon', async (t) => {
  const url = await nodeListener(t);
  const env = { KEEP_NODE_NAME: 'aws1', KEEP_DAEMON_NODE: 'main', KEEP_NODE_TOKEN_FILE: '/unused' };
  const unset = await setup.nodeApiReport({ env });
  assert.equal(unset[0].status, 'optional');
  assert.match(unset[0].text, /KEEP_DAEMON_URL is not set/);
  const reached = await setup.nodeApiReport({ env: { ...env, KEEP_DAEMON_URL: url }, readToken: () => 'aws1-secret' });
  assert.equal(reached[0].status, 'ok', reached[0].text);
  assert.match(reached[0].text, /^daemon main answers at http:\/\/127\.0\.0\.1:\d+/);
  const refused = await setup.nodeApiReport({ env: { ...env, KEEP_DAEMON_URL: url }, readToken: () => 'wrong' });
  assert.equal(refused[0].status, 'FAIL');
  assert.match(refused[0].text, /refused this node: unauthorized/);
  const misnamed = await setup.nodeApiReport({ env: { ...env, KEEP_NODE_NAME: 'mini', KEEP_DAEMON_URL: url }, readToken: () => 'aws1-secret' });
  assert.equal(misnamed[0].status, 'FAIL');
  assert.match(misnamed[0].text, /answered as main for node aws1, not main for mini/);
  const down = await setup.nodeApiReport({ env: { ...env, KEEP_DAEMON_URL: 'http://127.0.0.1:1' }, readToken: () => 'aws1-secret' });
  assert.equal(down[0].status, 'FAIL');
  assert.match(down[0].text, /does not reach the daemon/);
});
