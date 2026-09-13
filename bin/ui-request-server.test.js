'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createUiRequestServer } = require('./ui-request-server.js');

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname,
      method: options.method || 'GET', headers: { host: `localhost:${port}`, ...(options.headers || {}) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(options.body || undefined);
  });
}

async function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-ui-server-'));
  fs.mkdirSync(path.join(root, '.keep'));
  const backendSock = path.join('/tmp', `keep-ui-test-${process.pid}-${Math.random().toString(16).slice(2)}.sock`);
  const seen = [];
  const held = [];
  const backend = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.url === '/api/hold') { held.push(res); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'x-keep-mutation-fence': 'epoch:2' });
    res.end(JSON.stringify({ ok: true, count: seen.length }));
  });
  await new Promise((resolve) => backend.listen(backendSock, resolve));
  const bridge = overrides.bridge || { handleUpgrade(_req, socket) {
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  }, close() {} };
  const ui = createUiRequestServer({
    root, backendSock, backendToken: 'private-secret', token: 'public-secret', bridge,
    webRoot: path.join(__dirname, '..', 'web'), modulesRoot: path.join(__dirname, '..', 'node_modules'),
    heartbeatMs: 100, ...overrides,
  });
  await new Promise((resolve) => ui.listen(0, '127.0.0.1', resolve));
  const port = ui.server.address().port;
  t.after(async () => {
    await new Promise((resolve) => ui.close(resolve));
    await new Promise((resolve) => backend.close(resolve));
    try { fs.unlinkSync(backendSock); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, ui, port, seen, releaseHeld() {
    for (const res of held.splice(0)) { res.writeHead(200); res.end('released'); }
  } };
}

test('frontend returns loading until a real snapshot and serves every projection from one publication', async (t) => {
  const f = await fixture(t);
  assert.equal((await request(f.port, '/api/state')).status, 503);
  assert.equal((await request(f.port, '/api/portable-transfers', { headers: { 'x-keep': '1' } })).status, 503);
  const state = {
    generatedAt: 1234,
    tasks: [{ id: 'task-1', body: 'full body', fm: { title: 'One' } }],
    sessions: [], panes: [], attention: [], reviewQueue: { items: [{ id: 'review-1', title: 'Needle', body: 'full review' }] },
  };
  f.ui.publish({ version: 7, generatedAt: 1234, mutationFence: 'epoch:1', state, portableTransfers: [{ id: 'transfer-1' }] });
  const full = await request(f.port, '/api/state');
  assert.equal(full.status, 200);
  assert.equal(full.headers['x-keep-state-generated-at'], '1234');
  assert.equal(full.headers['x-keep-state-version'], '7');
  assert.equal(JSON.parse(full.body).tasks[0].body, 'full body');
  assert.equal(JSON.parse((await request(f.port, '/api/state?summary=1')).body).tasks[0].body, undefined);
  assert.equal(JSON.parse((await request(f.port, '/api/state', { headers: { referer: `http://localhost:${f.port}/app/` } })).body).tasks[0].body, undefined);
  assert.equal(JSON.parse((await request(f.port, '/api/dashboard-detail?kind=task&id=task-1')).body).value.body, 'full body');
  assert.deepEqual(JSON.parse((await request(f.port, '/api/dashboard-review-search?q=needle')).body).ids, ['review-1']);
  assert.deepEqual(JSON.parse((await request(f.port, '/api/portable-transfers', { headers: { 'x-keep': '1' } })).body).transfers, [{ id: 'transfer-1' }]);

  const write = await request(f.port, '/api/action', { method: 'POST', headers: { 'x-keep': '1' }, body: '{}' });
  assert.equal(write.headers['x-keep-mutation-fence'], 'epoch:2');
  assert.equal((await request(f.port, '/api/state', { headers: { 'x-keep-after-mutation': 'epoch:2' } })).status, 503,
    'an immediate post-write reload cannot consume the snapshot that predates the write');
  f.ui.publish({ version: 8, generatedAt: 2345, mutationFence: 'epoch:2', state: { ...state, generatedAt: 2345 }, portableTransfers: [] });
  assert.equal((await request(f.port, '/api/state', { headers: { 'x-keep-after-mutation': 'epoch:2' } })).status, 200);
});

test('frontend preserves public auth and strips spoofed backend identity before proxying once', async (t) => {
  const f = await fixture(t);
  assert.equal((await request(f.port, '/app', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await request(f.port, '/app', { headers: { host: 'evil.example', 'x-keep-token': 'public-secret' } })).status, 200);
  assert.equal((await request(f.port, '/api/portable-transfers')).status, 403);
  const response = await request(f.port, '/api/action', {
    method: 'POST', headers: {
      'x-keep': '1', 'x-keep-proxy-token': 'attacker', 'x-forwarded-for': '127.0.0.1',
    }, body: '{}',
  });
  assert.equal(response.status, 200);
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].headers['x-keep-proxy-token'], 'private-secret');
  assert.equal(f.seen[0].headers['x-forwarded-for'], undefined);
  assert.equal(f.seen[0].headers.host, 'keep-private');
});

test('frontend owns SSE heartbeat and terminal upgrade without touching the backend', async (t) => {
  let upgrades = 0;
  const f = await fixture(t, { bridge: { handleUpgrade(_req, socket) { upgrades += 1;
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'); }, close() {} } });
  const heartbeat = new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: f.port, path: '/api/events', headers: { host: `localhost:${f.port}` } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; if (body.includes(': keepalive')) { req.destroy(); resolve(body); } });
    });
    req.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
  });
  assert.match(await heartbeat, /data: hello/);
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(f.port, '127.0.0.1', () => socket.write([
      'GET /ws/pane/p-1?viewer=v HTTP/1.1', `Host: localhost:${f.port}`,
      `Origin: http://localhost:${f.port}`, 'Connection: Upgrade', 'Upgrade: websocket', '', '',
    ].join('\r\n')));
    socket.once('data', (chunk) => { assert.match(String(chunk), /101 Switching Protocols/); socket.destroy(); resolve(); });
    socket.once('error', reject);
  });
  assert.equal(upgrades, 1);
  assert.equal(f.seen.length, 0);
});

test('frontend bounds requests waiting on a stalled core', async (t) => {
  const f = await fixture(t, { maxProxyInFlight: 1 });
  const held = request(f.port, '/api/hold', { method: 'POST', headers: { 'x-keep': '1' }, body: '{}' });
  while (f.seen.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const refused = await request(f.port, '/api/action', { method: 'POST', headers: { 'x-keep': '1' }, body: '{}' });
  assert.equal(refused.status, 503);
  assert.match(refused.body, /queue is full/);
  assert.equal(f.seen.length, 1, 'the refused action never reaches the core');
  f.releaseHeld();
  assert.equal((await held).status, 200);
});
