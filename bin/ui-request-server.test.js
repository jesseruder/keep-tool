'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createUiRequestServer, MAX_SESSIONS } = require('./ui-request-server.js');

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
    digest: '# legacy digest',
    tasks: [{ id: 'task-1', body: 'full body', fm: { title: 'One' }, lastLog: 'latest log' }],
    sessions: [], panes: [], attention: [], reviewQueue: { items: [{ id: 'review-1', title: 'Needle', body: 'full review' }] },
  };
  f.ui.publish({ version: 7, generatedAt: 1234, mutationFence: 'epoch:1', state, portableTransfers: [{ id: 'transfer-1' }] });
  const full = await request(f.port, '/api/state');
  assert.equal(full.status, 200);
  assert.equal(full.headers['x-keep-state-generated-at'], '1234');
  assert.equal(full.headers['x-keep-state-version'], '7');
  assert.equal(JSON.parse(full.body).tasks[0].body, 'full body');
  const consoleEnvelope = JSON.parse((await request(f.port, '/api/state?console=1&delta=1')).body);
  assert.match(consoleEnvelope.instance, /^[0-9a-f-]{36}$/);
  assert.equal(consoleEnvelope.version, 7);
  const consoleBody = consoleEnvelope.full;
  assert.equal(consoleBody.tasks[0].body, undefined);
  assert.equal(consoleBody.tasks[0].lastLog, undefined);
  assert.equal(consoleBody.digest, undefined, 'the console projection drops the fields it never renders');
  assert.deepEqual(Object.keys(consoleBody).sort(), ['attention', 'generatedAt', 'panes', 'reviewQueue', 'sessions', 'tasks']);
  const legacyConsole = JSON.parse((await request(f.port, '/api/state?console=1')).body);
  assert.equal(legacyConsole.full, undefined, 'without delta=1 the projection is bare, for consoles running code that predates the envelope');
  assert.deepEqual(legacyConsole, consoleBody);
  assert.equal(JSON.parse((await request(f.port, `/api/state?console=1&since=${consoleEnvelope.instance}:7`)).body).full, undefined,
    'since without delta=1 is ignored the same way');
  assert.equal(JSON.parse((await request(f.port, '/api/state?summary=1')).body).tasks[0].body, 'full body',
    'the retired summary flag is ignored, not a separate projection');
  assert.equal(JSON.parse((await request(f.port, '/api/state', { headers: { referer: `http://localhost:${f.port}/app/` } })).body).tasks[0].body, 'full body',
    'a console referer no longer trims the full response');
  assert.equal(JSON.parse((await request(f.port, '/api/dashboard-detail?kind=task&id=task-1')).body).value.body, 'full body');
  assert.deepEqual(JSON.parse((await request(f.port, '/api/dashboard-review-search?q=needle')).body).ids, ['review-1']);
  assert.deepEqual(JSON.parse((await request(f.port, '/api/portable-transfers', { headers: { 'x-keep': '1' } })).body).transfers, [{ id: 'transfer-1' }]);

  // The legacy board is gone: the frontend serves nothing at / and falls through
  // to the daemon, which answers 404 for it.
  await request(f.port, '/');
  assert.equal(f.seen.at(-1)?.url, '/', 'the frontend no longer serves a page at /');

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
      'x-keep': '1', 'x-keep-proxy-token': 'attacker', 'x-keep-node-token': 'attacker-node',
      'x-forwarded-for': '127.0.0.1',
    }, body: '{}',
  });
  assert.equal(response.status, 200);
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].headers['x-keep-proxy-token'], 'private-secret');
  assert.equal(f.seen[0].headers['x-keep-node-token'], undefined, 'nothing through this hop may claim to be a node');
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

function publication(version, overrides = {}) {
  return {
    version,
    generatedAt: version * 100,
    mutationFence: 'epoch:1',
    portableTransfers: [],
    state: {
      generatedAt: version * 100,
      digest: '# dropped',
      tasks: [{ id: 'card-a', fm: { title: 'A' }, body: 'full body' }],
      sessions: [{ id: 's-1', title: 'One', pane: 'p-1' }, { id: 's-2', title: 'Two', pane: 'p-2' }],
      panes: [{ id: 'p-1', alive: true }, { id: 'p-2', alive: true }],
      attention: [],
      reviewQueue: { counts: { open: 1 }, items: [{ id: 'r-1', title: 'R' }] },
      health: { daemon: { pid: 1 }, schedulers: [{ name: 'review', state: 'ok' }] },
      ...overrides,
    },
  };
}

async function consoleEnvelope(port, since) {
  const response = await request(port, `/api/state?console=1&delta=1${since ? `&since=${encodeURIComponent(since)}` : ''}`);
  assert.equal(response.status, 200, response.body);
  return { response, body: JSON.parse(response.body) };
}

test('the console delta channel serves a chain from the snapshot a console already holds', async (t) => {
  const f = await fixture(t);
  const { applyConsoleDelta } = require('../web/app/shared/state-delta.js');
  f.ui.publish(publication(1));
  const first = await consoleEnvelope(f.port, '');
  assert.match(first.body.instance, /^[0-9a-f-]{36}$/);
  assert.equal(first.body.version, 1);
  assert.equal(first.body.deltas, undefined);
  const instance = first.body.instance;

  // A console already holding the newest publication is told there is nothing to apply.
  const level = await consoleEnvelope(f.port, `${instance}:1`);
  assert.deepEqual(level.body, { instance, version: 1, since: 1, deltas: [] });

  const renamed = [{ id: 's-1', title: 'One renamed', pane: 'p-1' }, { id: 's-2', title: 'Two', pane: 'p-2' }];
  f.ui.publish(publication(2, { sessions: renamed }));
  f.ui.publish(publication(3, {
    sessions: renamed,
    reviewQueue: { counts: { open: 9 }, items: [{ id: 'r-1', title: 'R' }] },
  }));
  const chained = await consoleEnvelope(f.port, `${instance}:1`);
  assert.equal(chained.body.since, 1);
  assert.equal(chained.body.version, 3);
  assert.equal(chained.body.deltas.length, 2, 'one delta per publication, in order');
  assert.deepEqual(chained.body.deltas[0].keyed.sessions.upsert.map((row) => row.id), ['s-1']);
  assert.deepEqual(chained.body.deltas[1].nested.reviewQueue.set.counts, { open: 9 });
  const rebuilt = chained.body.deltas.reduce((state, delta) => applyConsoleDelta(state, delta), first.body.full);
  assert.deepEqual(rebuilt, (await consoleEnvelope(f.port, '')).body.full,
    'the chain rebuilds the latest projection exactly');
  assert.ok(JSON.stringify(chained.body).length < JSON.stringify(first.body).length,
    'the chain is smaller than the projection it replaces');

  // A console holding the middle publication gets only the tail of the chain.
  assert.equal((await consoleEnvelope(f.port, `${instance}:2`)).body.deltas.length, 1);
});

test('the delta channel falls back to a full projection whenever it cannot name a chain', async (t) => {
  const f = await fixture(t, { deltaHistory: 2 });
  f.ui.publish(publication(1));
  const instance = (await consoleEnvelope(f.port, '')).body.instance;
  for (const version of [2, 3, 4]) f.ui.publish(publication(version));

  const evicted = await consoleEnvelope(f.port, `${instance}:1`);
  assert.equal(evicted.body.deltas, undefined, 'a version older than the ring gets the projection');
  assert.equal(evicted.body.version, 4);
  assert.equal(evicted.body.full.generatedAt, 400);
  assert.equal((await consoleEnvelope(f.port, `${instance}:3`)).body.deltas.length, 1, 'the ring still holds the tail');

  assert.equal((await consoleEnvelope(f.port, 'some-other-worker:3')).body.deltas, undefined, 'a foreign instance');
  assert.equal((await consoleEnvelope(f.port, `${instance}:99`)).body.deltas, undefined, 'a version ahead of the worker');
  assert.equal((await consoleEnvelope(f.port, `${instance}:nope`)).body.deltas, undefined, 'an unparsable version');
  assert.equal((await consoleEnvelope(f.port, instance)).body.deltas, undefined, 'a malformed since');

  // A version that does not advance stops identifying one snapshot, so the worker
  // starts a fresh chain and every console holding an old one reloads in full.
  f.ui.publish(publication(4, { attention: [{ kind: 'input', key: 'k' }] }));
  const restarted = await consoleEnvelope(f.port, `${instance}:3`);
  assert.equal(restarted.body.deltas, undefined, 'a repeated version breaks the chain');
  assert.notEqual(restarted.body.instance, instance, 'and renames it, so the stale version cannot be reused');
  f.ui.publish(publication(5));
  assert.equal((await consoleEnvelope(f.port, `${instance}:4`)).body.deltas, undefined,
    'the retired chain cannot name the ambiguous version either');
  assert.equal((await consoleEnvelope(f.port, `${restarted.body.instance}:4`)).body.deltas.length, 1,
    'the new chain serves deltas from its own first publication');
});

test('since changes nothing about the fence, the other projections, or caching', async (t) => {
  const f = await fixture(t);
  f.ui.publish(publication(1));
  const instance = (await consoleEnvelope(f.port, '')).body.instance;

  // The mobile and full projections ignore since entirely — no envelope.
  const full = JSON.parse((await request(f.port, `/api/state?since=${instance}:1`)).body);
  assert.equal(full.tasks[0].body, 'full body', 'the full projection is unwrapped');
  assert.equal(full.full, undefined);
  const mobile = JSON.parse((await request(f.port, `/api/state?view=notifications&since=${instance}:1`)).body);
  assert.equal(mobile.full, undefined);
  assert.equal(mobile.deltas, undefined);

  // The post-mutation fence still holds a since request back.
  const write = await request(f.port, '/api/action', { method: 'POST', headers: { 'x-keep': '1' }, body: '{}' });
  assert.equal(write.headers['x-keep-mutation-fence'], 'epoch:2');
  const behind = await request(f.port, `/api/state?console=1&delta=1&since=${instance}:1`, { headers: { 'x-keep-after-mutation': 'epoch:2' } });
  assert.equal(behind.status, 503);
  assert.match(behind.body, /refresh is pending/);
  f.ui.publish({ ...publication(2), mutationFence: 'epoch:2' });
  const released = await request(f.port, `/api/state?console=1&delta=1&since=${instance}:1`, { headers: { 'x-keep-after-mutation': 'epoch:2' } });
  assert.equal(released.status, 200);
  assert.equal(JSON.parse(released.body).deltas.length, 1);

  // ETag and 304 work on the envelope exactly as on the bare projection.
  const envelope = await request(f.port, '/api/state?console=1&delta=1');
  assert.ok(envelope.headers.etag);
  assert.equal(envelope.headers['x-keep-state-version'], '2');
  const repeat = await request(f.port, '/api/state?console=1&delta=1', { headers: { 'if-none-match': envelope.headers.etag } });
  assert.equal(repeat.status, 304);
  const deltaResponse = await request(f.port, `/api/state?console=1&delta=1&since=${instance}:1`);
  assert.notEqual(deltaResponse.headers.etag, envelope.headers.etag, 'a delta body is not the projection body');
  assert.equal((await request(f.port, `/api/state?console=1&delta=1&since=${instance}:1`,
    { headers: { 'if-none-match': deltaResponse.headers.etag } })).status, 304);
});

test('a republished state object breaks the chain instead of hiding an in-place edit', async (t) => {
  const f = await fixture(t);
  const first = publication(1, { notifications: [{ id: 'n-1', text: 'unread', read: false }] });
  f.ui.publish(first);
  const held = await consoleEnvelope(f.port, '');
  assert.equal(held.body.full.notifications[0].read, false);

  // consoleState passes notifications through by reference, so an edit to the same
  // state object is already inside the previous projection and invisible to the
  // diff. The worker does not guess: the same object means a new chain.
  first.state.notifications[0].read = true;
  f.ui.publish({ ...first, version: 2, generatedAt: 200 });
  const aliased = await consoleEnvelope(f.port, `${held.body.instance}:1`);
  assert.equal(aliased.body.deltas, undefined, 'an aliased publication answers with the projection');
  assert.notEqual(aliased.body.instance, held.body.instance);
  assert.equal(aliased.body.full.notifications[0].read, true, 'which does carry the edit');

  // The real caller hands over a fresh graph every publication — bin/serve.js
  // publishes through createUiRequestWorker, and child.send JSON-serializes it —
  // and then the very same edit arrives as a delta.
  const fresh = JSON.parse(JSON.stringify(first.state));
  fresh.notifications[0].text = 'read at last';
  f.ui.publish({ version: 3, generatedAt: 300, mutationFence: 'epoch:1', portableTransfers: [], state: fresh });
  const chained = await consoleEnvelope(f.port, `${aliased.body.instance}:2`);
  assert.equal(chained.body.deltas.length, 1);
  assert.deepEqual(chained.body.deltas[0].keyed.notifications.upsert,
    [{ id: 'n-1', text: 'read at last', read: true }]);
});

test('a chain that outgrew the projection is answered with the projection', async (t) => {
  const f = await fixture(t);
  // A big field nothing changes inflates the projection; a smaller one that changes
  // every publication is resent whole in every delta of the chain.
  const catalog = Object.fromEntries(Array.from({ length: 60 },
    (_, i) => [`/tmp/project-${i}`, { icon: 'x'.repeat(100), label: `Project ${i}` }]));
  const churn = (n) => ({ events: Array.from({ length: 12 }, (_, i) => ({ at: n * 1000 + i, kind: 'tick', detail: 'y'.repeat(60) })), stats: { seen: n } });
  const bulky = (version) => publication(version, { projectCatalog: catalog, review: churn(version) });

  f.ui.publish(bulky(1));
  const first = await consoleEnvelope(f.port, '');
  const instance = first.body.instance;
  const fullSize = first.response.body.length;

  f.ui.publish(bulky(2));
  const short = await consoleEnvelope(f.port, `${instance}:1`);
  assert.equal(short.body.deltas.length, 1, 'one copy of the churning field still beats the projection');
  assert.ok(short.response.body.length < fullSize);

  for (const version of [3, 4, 5, 6, 7, 8, 9, 10]) f.ui.publish(bulky(version));
  const long = await consoleEnvelope(f.port, `${instance}:1`);
  assert.equal(long.body.deltas, undefined, 'nine copies of it do not, so the projection is cheaper');
  assert.equal(long.body.version, 10);
  assert.equal((await consoleEnvelope(f.port, `${instance}:9`)).body.deltas.length, 1,
    'and the tail of the same ring is still served as a delta');
});

test('the shell trades its token for a cookie once, and the cookie carries the whole console', async (t) => {
  const f = await fixture(t);
  const lan = { host: '10.0.0.4:7777' };

  const granted = await request(f.port, '/app?token=public-secret', { headers: lan });
  assert.equal(granted.status, 302);
  assert.equal(granted.headers.location, '/app');
  const [setCookie, clearedCookie] = granted.headers['set-cookie'];
  assert.match(setCookie, /^keep-session=[A-Za-z0-9_-]{43}; Max-Age=34560000; Path=\/; HttpOnly; SameSite=Strict$/);
  assert.equal(/public-secret/.test(setCookie), false, 'the cookie is an opaque id, never the daemon token');
  assert.equal(/Secure/.test(setCookie), false, 'the private network is plain HTTP');
  assert.equal(clearedCookie, 'keep-token=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict',
    'the bootstrap also expires the token cookie an earlier design would have set');
  assert.equal(granted.headers['set-cookie'].length, 2);
  assert.equal(granted.headers['cache-control'], 'no-store');
  assert.equal(granted.body, '', 'the token is never echoed');
  assert.equal((await request(f.port, '/app?token=wrong', { headers: lan })).status, 403);
  assert.equal((await request(f.port, '/app', { headers: lan })).status, 403);

  const cookie = { ...lan, cookie: setCookie.split(';')[0] };
  assert.equal((await request(f.port, '/app', { headers: cookie })).status, 200);
  assert.equal((await request(f.port, '/app/app.js', { headers: cookie })).status, 200);
  assert.equal((await request(f.port, '/vendor/xterm.js', { headers: cookie })).status, 200);
  assert.equal((await request(f.port, '/app', { headers: { ...cookie, host: '10.0.0.9:7777' } })).status, 403,
    'a session is only valid for the host it was issued for');
  assert.equal((await request(f.port, '/app', { headers: { ...lan, cookie: 'keep-token=public-secret' } })).status, 403,
    'a raw-token cookie is not a session');
  assert.equal((await request(f.port, '/app', { headers: { ...lan, cookie: 'keep-session=made-up' } })).status, 403);

  assert.equal((await request(f.port, '/api/state', { headers: cookie })).status, 403,
    'without x-keep a session reaches nothing but the page and its stream');
  assert.equal((await request(f.port, '/api/state', { headers: { ...cookie, 'x-keep': '1' } })).status, 503,
    'loading, not unauthorized');
  assert.equal((await request(f.port, '/api/layouts', { headers: cookie })).status, 403);
  assert.equal((await request(f.port, '/api/layouts', { headers: { ...cookie, 'x-keep': '1' } })).status, 200);
  assert.equal((await request(f.port, '/api/portable-transfers', { headers: cookie })).status, 403);
  assert.equal((await request(f.port, '/api/portable-transfers', { headers: { ...cookie, 'x-keep': '1' } })).status, 503);
  assert.equal((await request(f.port, '/api/action', { method: 'POST', headers: cookie, body: '{}' })).status, 403,
    'a same-site page cannot add x-keep without a preflight nothing here answers');
  assert.equal(f.seen.length, 0, 'none of that reached the daemon');
  assert.equal((await request(f.port, '/api/state')).status, 503,
    'loopback and header clients never meet the x-keep rule');

  const proxied = await request(f.port, '/api/action', {
    method: 'POST', headers: { ...cookie, 'x-keep': '1' }, body: '{}',
  });
  assert.equal(proxied.status, 200);
  assert.equal(f.seen.at(-1).headers.cookie, undefined, 'the daemon hop never sees the browser cookie');
  assert.equal(f.seen.at(-1).headers['x-keep-proxy-token'], 'private-secret');
});

test('sessions are bounded, host-bound, and forgotten when the worker is replaced', async (t) => {
  const f = await fixture(t);
  const lan = { host: '10.0.0.4:7777' };
  const issue = async () => {
    const response = await request(f.port, '/app?token=public-secret', { headers: lan });
    return response.headers['set-cookie'][0].split(';')[0];
  };
  const first = await issue();
  const cookies = [first];
  for (let index = 1; index < MAX_SESSIONS; index += 1) cookies.push(await issue());
  assert.equal((await request(f.port, '/app', { headers: { ...lan, cookie: first } })).status, 200,
    'the ring is exactly full, so the first session is still there');
  const overflow = await issue();
  assert.equal((await request(f.port, '/app', { headers: { ...lan, cookie: first } })).status, 403,
    'the oldest session is evicted at the limit');
  assert.equal((await request(f.port, '/app', { headers: { ...lan, cookie: cookies[1] } })).status, 200);
  assert.equal((await request(f.port, '/app', { headers: { ...lan, cookie: overflow } })).status, 200);

  const replacement = await fixture(t);
  assert.equal((await request(replacement.port, '/app', { headers: { ...lan, cookie: overflow } })).status, 403,
    'sessions live in the worker process and die with it');
});

test('a session nobody has used within the idle limit is refused and dropped', async (t) => {
  const f = await fixture(t, { sessionIdleMs: 40 });
  const lan = { host: '10.0.0.4:7777' };
  const issued = await request(f.port, '/app?token=public-secret', { headers: lan });
  const cookie = issued.headers['set-cookie'][0].split(';')[0];
  const use = () => request(f.port, '/app', { headers: { ...lan, cookie } });

  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal((await use()).status, 200, 'each request refreshes the session it authorizes');
  }
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal((await use()).status, 403, 'an idle session is gone');
  // Swept, not merely refused: it cannot come back, and the ring is free again.
  assert.equal((await use()).status, 403);
  assert.equal(f.ui.sessionCount(), 0);
});

test('a session streams events and opens a pane socket from its own origin, without the header', async (t) => {
  let upgrades = 0;
  const f = await fixture(t, { bridge: { handleUpgrade(_req, socket) { upgrades += 1;
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'); }, close() {} } });
  const issued = await request(f.port, '/app?token=public-secret', { headers: { host: '10.0.0.4:7777' } });
  const cookie = issued.headers['set-cookie'][0].split(';')[0];
  const hello = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: f.port, path: '/api/events',
      headers: { host: '10.0.0.4:7777', cookie } }, (res) => {
      if (res.statusCode !== 200) { req.destroy(); resolve(`status ${res.statusCode}`); return; }
      res.on('data', (chunk) => { req.destroy(); resolve(String(chunk)); });
    });
    req.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
  });
  assert.match(hello, /data: hello/);

  const upgrade = (origin, sent = '') => new Promise((resolve, reject) => {
    const lines = ['GET /ws/pane/p-1?viewer=v HTTP/1.1', 'Host: 10.0.0.4:7777', `Origin: ${origin}`];
    if (sent) lines.push(`Cookie: ${sent}`);
    lines.push('Connection: Upgrade', 'Upgrade: websocket', '', '');
    const socket = net.createConnection(f.port, '127.0.0.1', () => socket.write(lines.join('\r\n')));
    socket.once('data', (chunk) => { socket.destroy(); resolve(String(chunk)); });
    socket.once('error', reject);
  });
  assert.match(await upgrade('http://10.0.0.4:7777', cookie), /101 Switching Protocols/);
  assert.equal(upgrades, 1);
  assert.match(await upgrade('http://10.0.0.4:7777'), /403 Forbidden/, 'the matching origin is not itself authorization');
  assert.match(await upgrade('http://evil.example', cookie), /403 Forbidden/);
  assert.match(await upgrade('http://10.0.0.4:7777', 'keep-session=made-up'), /403 Forbidden/);
  assert.equal(upgrades, 1);
  assert.equal(f.seen.length, 0);
});
