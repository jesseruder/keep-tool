'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function request(port, pathname, options = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname,
      method: options.method || 'GET', headers: { host: `localhost:${port}`, ...(options.headers || {}) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'), elapsed: Date.now() - started }));
    });
    req.on('error', reject);
    req.end(options.body || undefined);
  });
}

function nextMessage(child, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('fixture message timed out')); }, timeoutMs);
    const onMessage = (message) => { if (!predicate(message)) return; cleanup(); resolve(message); };
    const onExit = (code) => { cleanup(); reject(new Error(`fixture exited ${code}`)); };
    const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

test('forked frontend serves a full reload and SSE during a 10.5 second core stall, then recovers after worker loss', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-ui-worker-'));
  fs.mkdirSync(path.join(root, '.keep'));
  fs.writeFileSync(path.join(root, '.keep', 'layouts.json'), JSON.stringify({ layouts: [{ name: 'Pinned', ids: [], cols: 0, role: 'pinned' }] }));
  const port = await freePort();
  const child = fork(path.join(__dirname, 'fixtures', 'ui-request-worker-fixture.js'), [], {
    env: { ...process.env, KEEP_UI_FIXTURE_PORT: String(port), KEEP_UI_FIXTURE_ROOT: root },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => {
    if (child.connected) child.send({ type: 'shutdown' });
    child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  });
  await nextMessage(child, (message) => message?.type === 'published' && message.version === 1);

  const block = request(port, '/api/block', { method: 'POST', headers: { 'x-keep': '1' }, body: '{}' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const heartbeat = new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `localhost:${port}` } }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
        if (!body.includes(': keepalive')) return;
        req.destroy();
        resolve({ status: res.statusCode, elapsed: Date.now() - started });
      });
    });
    req.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
  });
  const responses = await Promise.all([
    request(port, '/app'),
    request(port, '/app/app.js'),
    request(port, '/vendor/xterm.js'),
    request(port, '/api/state'),
    request(port, '/api/layouts'),
    request(port, '/api/portable-transfers', { headers: { 'x-keep': '1' } }),
    heartbeat,
  ]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.ok(response.elapsed < 1000, `frontend response took ${response.elapsed}ms while core was blocked`);
  }
  assert.equal(JSON.parse(responses[3].body).marker, 1);
  assert.equal((await block).status, 200);

  // The legacy board is deleted: the frontend serves no page at /, and the
  // request falls through to the core, which has no route for it either.
  assert.equal((await request(port, '/')).status, 404, 'nothing is served at /');

  const action = await request(port, '/api/action', { method: 'POST', headers: { 'x-keep': '1' }, body: '{}' });
  assert.deepEqual(JSON.parse(action.body), { ok: true, actions: 1 });
  const actionCount = nextMessage(child, (message) => message?.type === 'actions');
  child.send({ type: 'actions' });
  assert.equal((await actionCount).actions, 1, 'the frontend never retries a proxied write');

  const restarted = nextMessage(child, (message) => message?.type === 'published' && message.readyCount >= 2, 8000);
  child.send({ type: 'kill-ui' });
  await restarted;
  const recovered = await request(port, '/api/state');
  assert.equal(recovered.status, 200, stderr);
  assert.equal(JSON.parse(recovered.body).marker, 1, 'the supervisor republishes its retained snapshot');

  const fresh = nextMessage(child, (message) => message?.type === 'published' && message.version === 2);
  child.send({ type: 'publish', marker: 2 });
  await fresh;
  const updated = await request(port, '/api/state');
  assert.equal(updated.headers['x-keep-state-version'], '2');
  assert.equal(JSON.parse(updated.body).marker, 2);
});
