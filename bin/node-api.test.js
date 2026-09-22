'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const keepConsole = require('./console.js');
const { nodeApiListen } = require('./node-registry.js');
const { matchRoute, routeDenial } = require('./serve/routes.js');
const nodeApi = require('./serve/node-api.js');

function configEnv(t, value, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-node-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  if (value) fs.writeFileSync(file, JSON.stringify({ version: 1, ...value }));
  return { KEEP_CONFIG: file, KEEP_DIR: dir, ...extra };
}

const TWO_NODES = { daemonNode: 'main', nodes: { main: {}, aws1: { transport: 'tcp', address: '100.64.0.2:7780' } } };

test('the node listener is absent unless configured on a daemon with another node', (t) => {
  assert.equal(nodeApiListen(configEnv(t, null)).enabled, false, 'no configuration at all');
  assert.equal(nodeApiListen(configEnv(t, {})).enabled, false, 'an empty configuration');
  assert.equal(nodeApiListen(configEnv(t, TWO_NODES)).enabled, false, 'nodes but no nodeApi');
  const single = nodeApiListen(configEnv(t, { nodeApi: { listen: '100.64.0.1:7781' } }));
  assert.equal(single.enabled, false, 'a single-node install never listens for nodes');
  assert.equal(single.error, undefined);
  const same = nodeApiListen(configEnv(t, { daemonNode: 'main', nodes: { main: {} }, nodeApi: { listen: '100.64.0.1:7781' } }));
  assert.equal(same.enabled, false, 'a node list naming only the daemon is still one node');

  const on = nodeApiListen(configEnv(t, { ...TWO_NODES, nodeApi: { listen: '100.64.0.1:7781' } }));
  assert.deepEqual(on, { enabled: true, listen: '100.64.0.1:7781', address: '100.64.0.1', port: 7781, url: 'http://100.64.0.1:7781' });

  const override = nodeApiListen(configEnv(t, TWO_NODES, { KEEP_NODE_API_LISTEN: '100.64.0.9:7790' }));
  assert.equal(override.enabled, true);
  assert.equal(override.listen, '100.64.0.9:7790');

  const remote = nodeApiListen(configEnv(t, { ...TWO_NODES, nodeApi: { listen: '100.64.0.1:7781' } },
    { KEEP_NODE_NAME: 'aws1', KEEP_DAEMON_NODE: 'main' }));
  assert.equal(remote.enabled, false, 'only the daemon node listens for nodes');
});

test('a node listener address is refused, not bound, when it is a wildcard or not an address', (t) => {
  for (const listen of ['0.0.0.0:7781', '[::]:7781', '[::ffff:0.0.0.0]:7781', 'laptop.tail:7781', '100.64.0.1', '100.64.0.1:0']) {
    const answer = nodeApiListen(configEnv(t, { ...TWO_NODES, nodeApi: { listen } }));
    assert.equal(answer.enabled, false, listen);
    assert.match(answer.error, /./, listen);
  }
  assert.match(nodeApiListen(configEnv(t, { ...TWO_NODES, nodeApi: '100.64.0.1:7781' })).error, /nodeApi must be an object/);
  assert.match(nodeApiListen(configEnv(t, { ...TWO_NODES, nodeApi: { listen: '100.64.0.1:7781', port: 1 } })).error, /unsupported Keep nodeApi key/);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, { method = 'GET', pathname, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: {
      host: `localhost:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers,
    } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function nodeServer(t, { tokens, rereadMs = 5000, read } = {}) {
  const calls = [];
  const routes = [
    { method: 'GET', path: '/api/state', handle: async ({ res }) => { calls.push('state'); res.end('{}'); } },
    { method: 'GET', path: '/api/node-only', allow: ['node'], handle: async ({ res, principal }) => {
      calls.push(principal);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ node: principal.node }));
    } },
    { method: 'POST', path: '/api/node-post', allow: ['node'], handle: async ({ res, body }) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ body }));
    } },
  ];
  let current = { ...tokens };
  const store = nodeApi.createNodeTokenStore({ initial: { ...tokens }, read: read || (() => current), rereadMs });
  const handler = nodeApi.createNodeApiHandler({
    routes, matchRoute, routeDenial, principal: keepConsole.principal, tokenStore: store,
    readBody: (req) => new Promise((resolve) => { let data = ''; req.on('data', (c) => { data += c; }); req.on('end', () => resolve(data ? JSON.parse(data) : {})); }),
    log: () => {},
  });
  const server = http.createServer(handler);
  const port = await listen(server);
  t.after(() => server.close());
  return { port, calls, setTokens: (value) => { current = value; } };
}

test('the node listener answers only node tokens, and only on routes that allow a node', async (t) => {
  const { port, calls } = await nodeServer(t, { tokens: { aws1: 'aws1-secret' } });
  // Loopback, with a loopback Host header: 'local' on the public server, nothing here.
  assert.equal((await request(port, { pathname: '/api/state' })).status, 403);
  assert.equal((await request(port, { pathname: '/api/node-only' })).status, 403);
  // The admin token and the proxy token are not identities on this listener.
  assert.equal((await request(port, { pathname: '/api/node-only', headers: { 'x-keep-token': 'aws1-secret' } })).status, 403);
  assert.equal((await request(port, { pathname: '/api/node-only', headers: { 'x-keep-proxy-token': 'aws1-secret' } })).status, 403);
  assert.equal((await request(port, { pathname: '/api/node-only', headers: { 'x-keep-node-token': 'wrong' } })).status, 403);
  // A route that does not name 'node' is refused to a node.
  const plain = await request(port, { pathname: '/api/state', headers: { 'x-keep-node-token': 'aws1-secret' } });
  assert.deepEqual(plain, { status: 403, body: { error: 'forbidden for node' } });
  const allowed = await request(port, { pathname: '/api/node-only', headers: { 'x-keep-node-token': 'aws1-secret' } });
  assert.deepEqual(allowed, { status: 200, body: { node: 'aws1' } });
  assert.deepEqual(calls, [{ class: 'node', node: 'aws1' }]);
  // A POST still needs the header that forces a CORS preflight.
  assert.equal((await request(port, { method: 'POST', pathname: '/api/node-post', headers: { 'x-keep-node-token': 'aws1-secret' }, body: {} })).status, 403);
  const posted = await request(port, { method: 'POST', pathname: '/api/node-post', headers: { 'x-keep-node-token': 'aws1-secret', 'x-keep': '1' }, body: { a: 1 } });
  assert.deepEqual(posted, { status: 200, body: { body: { a: 1 } } });
  assert.equal((await request(port, { pathname: '/api/nothing', headers: { 'x-keep-node-token': 'aws1-secret' } })).status, 404);
});

test('a token minted after boot is honoured without a restart, and the re-read is rate limited', async (t) => {
  let reads = 0;
  let current = {};
  let clock = 0;
  const store = nodeApi.createNodeTokenStore({ initial: {}, read: () => { reads += 1; return current; }, now: () => clock });
  assert.equal(store.refresh(), true);
  assert.equal(reads, 1);
  current = { aws1: 'fresh' };
  clock += 1000;
  assert.equal(store.refresh(), false, 'a second miss inside five seconds does not re-read');
  assert.deepEqual(store.current(), {});
  clock += 5000;
  assert.equal(store.refresh(), true);
  assert.deepEqual(store.current(), { aws1: 'fresh' });

  const server = await nodeServer(t, { tokens: {}, rereadMs: 0 });
  assert.equal((await request(server.port, { pathname: '/api/node-only', headers: { 'x-keep-node-token': 'late' } })).status, 403);
  server.setTokens({ aws1: 'late' });
  assert.equal((await request(server.port, { pathname: '/api/node-only', headers: { 'x-keep-node-token': 'late' } })).status, 200);
});

test('the public listener never takes a node token as an identity', () => {
  const { apiRequestAuthError } = require('./serve.js');
  const req = { method: 'GET', headers: { host: '100.64.0.1:7777', 'x-keep-node-token': 'aws1-secret' }, socket: { remoteAddress: '100.64.0.2' } };
  const deps = { isLocal: () => false, token: 'admin', internalToken: 'proxy', nodeTokens: { aws1: 'aws1-secret' }, acceptNodeTokens: false };
  assert.deepEqual(apiRequestAuthError(req, deps), { status: 403, error: 'unauthorized' });
  assert.equal(keepConsole.principal(req, deps), null);
});

test('startNodeApi binds nothing when the listener is disabled', () => {
  const logged = [];
  assert.equal(nodeApi.startNodeApi({ listen: { enabled: false, reason: 'not configured' }, handler: () => {}, log: (l) => logged.push(l) }), null);
  assert.deepEqual(logged, []);
  assert.equal(nodeApi.startNodeApi({ listen: { enabled: false, error: 'refusing to bind 0.0.0.0' }, handler: () => {}, log: (l) => logged.push(l) }), null);
  assert.deepEqual(logged, ['keep serve: node api not started: refusing to bind 0.0.0.0']);
});

test('startNodeApi binds the configured address and says so once', async (t) => {
  const lines = [];
  const server = nodeApi.startNodeApi({
    listen: { enabled: true, listen: '127.0.0.1:0', address: '127.0.0.1', port: 0 },
    handler: (req, res) => res.end('x'), announce: (line) => lines.push(line), log: () => {},
  });
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  assert.deepEqual(lines, ['node api listening 127.0.0.1:0']);
});

// After a reboot the daemon can start before Tailscale has brought the address up.
// The bind is retried, 5 s doubling to 60 s, and each change of state is said once.
test('a listener whose address is not up yet keeps trying until it binds', async (t) => {
  const lines = [];
  const announced = [];
  const states = [];
  const timers = [];
  const failures = ['EADDRNOTAVAIL', 'EADDRNOTAVAIL', 'EADDRNOTAVAIL', 'EADDRNOTAVAIL', 'EADDRNOTAVAIL', 'EADDRINUSE'];
  let binds = 0;
  const server = nodeApi.startNodeApi({
    listen: { enabled: true, listen: '127.0.0.1:0', address: '127.0.0.1', port: 0 },
    handler: (req, res) => res.end('x'),
    log: (line) => lines.push(line), announce: (line) => announced.push(line), onState: (value) => states.push(value),
    bind: (srv, port, address) => {
      binds += 1;
      const code = failures.shift();
      if (!code) return srv.listen(port, address);
      const error = new Error(`listen ${code}: address not available ${address}:${port}`);
      error.code = code;
      return process.nextTick(() => srv.emit('error', error));
    },
    setTimer: (fn, ms) => { timers.push(ms); setImmediate(fn); return { ms }; },
    clearTimer: () => {},
  });
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  assert.equal(binds, 7);
  assert.deepEqual(timers, [5000, 10000, 20000, 40000, 60000, 60000]);
  assert.deepEqual(lines, [
    'keep serve: node api on 127.0.0.1:0 failed: listen EADDRNOTAVAIL: address not available 127.0.0.1:0; retrying until it binds',
    'keep serve: node api on 127.0.0.1:0 failed: listen EADDRINUSE: address not available 127.0.0.1:0; retrying until it binds',
  ]);
  assert.deepEqual(announced, ['node api listening 127.0.0.1:0']);
  assert.deepEqual(states.map((value) => value.state), ['retrying', 'retrying', 'listening']);
  assert.equal(states[2].pid, process.pid);
  assert.equal(states[2].listen, '127.0.0.1:0');
});

test('a bind that cannot succeed later is not retried, and a closed listener stops retrying', () => {
  const lines = [];
  const timers = [];
  const refused = nodeApi.startNodeApi({
    listen: { enabled: true, listen: '127.0.0.1:1', address: '127.0.0.1', port: 1 },
    handler: () => {}, log: (line) => lines.push(line), announce: () => {},
    bind: () => { const error = new Error('listen EACCES'); error.code = 'EACCES'; throw error; },
    setTimer: (fn, ms) => { timers.push(ms); return {}; },
  });
  assert.deepEqual(timers, []);
  assert.deepEqual(lines, ['keep serve: node api on 127.0.0.1:1 failed: listen EACCES']);
  refused.close(() => {});

  let pending = null;
  let cleared = false;
  const retrying = nodeApi.startNodeApi({
    listen: { enabled: true, listen: '127.0.0.1:1', address: '127.0.0.1', port: 1 },
    handler: () => {}, log: () => {}, announce: () => {},
    bind: () => { const error = new Error('listen EADDRNOTAVAIL'); error.code = 'EADDRNOTAVAIL'; throw error; },
    setTimer: (fn) => { pending = fn; return { id: 1 }; },
    clearTimer: () => { cleared = true; },
  });
  assert.ok(pending);
  retrying.close(() => {});
  assert.equal(cleared, true);
});

test('the listener state is written where doctor reads it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-node-api-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.keep'));
  assert.equal(nodeApi.readState(dir), null);
  nodeApi.writeState(dir, { pid: 1, listen: '100.64.0.1:7781', state: 'listening' });
  assert.deepEqual(nodeApi.readState(dir), { pid: 1, listen: '100.64.0.1:7781', state: 'listening' });
});
