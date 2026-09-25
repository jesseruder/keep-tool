'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSecretService, consoleRequests, storeFile } = require('./secret-requests.js');
const { routes, matchRoute, routeDenial } = require('./serve/routes.js');

const SESSION = '11111111-2222-3333-4444-555555555555';
const VALUE = 'sk-SECRETVALUE-abc';

function setup(t, overrides = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-secret-req-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = { host: [], local: [], told: [], changes: 0 };
  let clock = 1_000_000;
  const service = createSecretService({
    root,
    daemonNode: () => 'main',
    hostRequest: async (type, params, options) => {
      calls.host.push({ type, params, options });
      if (type === 'hello') return { secretWrite: 1 };
      return { path: params.path, key: params.key, replaced: false, bytes: params.value.length };
    },
    writeLocal: (params) => { calls.local.push(params); return { path: params.path, replaced: false, bytes: params.value.length }; },
    notifySession: async (sessionId, text) => { calls.told.push({ sessionId, text }); },
    onChange: () => { calls.changes += 1; },
    now: () => clock,
    log: () => {},
    ...overrides,
  });
  return { root, service, calls, advance: (ms) => { clock += ms; } };
}

const ask = (extra = {}) => ({ name: 'GITHUB_TOKEN', sessionId: SESSION, path: '/home/u/app/.env', key: 'GITHUB_TOKEN', purpose: 'release script', ...extra });

test('a node request is recorded against the node that sent it, not what its body claims', (t) => {
  const { service, root } = setup(t);
  const result = service.request({ class: 'node', node: 'aws1' }, ask({ node: 'main', pane: 'p1@aws1' }));
  assert.equal(result.status, 200);
  assert.equal(result.body.request.node, 'aws1');
  assert.equal(result.body.request.status, 'pending');
  assert.equal(fs.statSync(storeFile(root)).mode & 0o777, 0o600);
  const local = service.request({ class: 'local' }, ask({ path: '/home/u/other' , key: null }));
  assert.equal(local.body.request.node, 'main');
});

test('the same pending request is not recorded twice', (t) => {
  const { service } = setup(t);
  const first = service.request({ class: 'local' }, ask());
  const again = service.request({ class: 'local' }, ask());
  assert.equal(again.body.existing, true);
  assert.equal(again.body.request.id, first.body.request.id);
  assert.equal(consoleRequests(setup(t).root).length, 0, 'a fresh root has none');
});

test('refuses requests without a session, a name, or an absolute path', (t) => {
  const { service } = setup(t);
  assert.equal(service.request({ class: 'local' }, ask({ sessionId: '' })).status, 400);
  assert.equal(service.request({ class: 'local' }, ask({ name: '1bad' })).status, 400);
  assert.equal(service.request({ class: 'local' }, ask({ path: 'rel/x' })).status, 400);
  assert.equal(service.request({ class: 'local' }, ask({ key: 'no-dash' })).status, 400);
});

test('fulfilling a remote request writes through the node host and tells the session the path only', async (t) => {
  const { service, calls, root } = setup(t);
  const { id } = service.request({ class: 'node', node: 'aws1' }, ask({ pane: 'p1@aws1' })).body.request;
  const result = await service.fulfill({ id, value: VALUE });
  assert.equal(result.status, 200);
  assert.equal(result.body.request.status, 'delivered');
  const write = calls.host.find((c) => c.type === 'secret-write');
  assert.equal(write.options.node, 'aws1');
  assert.equal(write.params.value, VALUE);
  assert.equal(write.params.key, 'GITHUB_TOKEN');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.told.length, 1);
  assert.equal(calls.told[0].sessionId, SESSION);
  assert.match(calls.told[0].text, /\/home\/u\/app\/\.env as GITHUB_TOKEN on aws1/);
  assert.ok(!calls.told[0].text.includes(VALUE));
  assert.ok(calls.told[0].text.length <= 200, `one typing chunk: ${calls.told[0].text.length}`);
  assert.ok(!fs.readFileSync(storeFile(root), 'utf8').includes(VALUE), 'the store never holds a value');
  assert.ok(!JSON.stringify(result.body).includes(VALUE));
  assert.equal(consoleRequests(root, 1_000_000).length, 0);
  assert.equal((await service.fulfill({ id, value: VALUE })).status, 409, 'a delivered request cannot be written again');
});

test('a request on the daemon node is written in-process', async (t) => {
  const { service, calls } = setup(t);
  const { id } = service.request({ class: 'local' }, ask()).body.request;
  assert.equal((await service.fulfill({ id, value: VALUE })).status, 200);
  assert.equal(calls.local.length, 1);
  assert.equal(calls.host.length, 0);
});

test('a failed write leaves the request pending with the error, never the value', async (t) => {
  const failing = async (type) => {
    if (type === 'hello') return { secretWrite: 1 };
    throw Object.assign(new Error('/home/u/app/.env is inside the git repository /home/u/app and is not gitignored'), { code: 'secret-destination' });
  };
  const { service, root } = setup(t, { hostRequest: failing });
  const { id } = service.request({ class: 'node', node: 'aws1' }, ask({ pane: 'p1@aws1' })).body.request;
  const result = await service.fulfill({ id, value: VALUE });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /not gitignored/);
  const [pending] = consoleRequests(root, 1_000_000);
  assert.equal(pending.status, 'pending');
  assert.match(pending.lastError, /not gitignored/);
  assert.ok(!fs.readFileSync(storeFile(root), 'utf8').includes(VALUE));
});

test('an old node host is refused by name', async (t) => {
  const { service } = setup(t, { hostRequest: async () => ({}) });
  const { id } = service.request({ class: 'node', node: 'aws1' }, ask({ pane: 'p1@aws1' })).body.request;
  const result = await service.fulfill({ id, value: VALUE });
  assert.equal(result.status, 502);
  assert.match(result.body.error, /predates secret handoff/);
});

test('declining tells the session the reason; expiry needs no sweep', async (t) => {
  const { service, calls, root, advance } = setup(t);
  const a = service.request({ class: 'local' }, ask()).body.request;
  const b = service.request({ class: 'local' }, ask({ path: '/home/u/b', key: null })).body.request;
  assert.equal(service.decline({ id: a.id, reason: 'use the staging key' }).status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(calls.told[0].text, /declined.*use the staging key/);
  advance(25 * 60 * 60 * 1000);
  assert.equal(consoleRequests(root, 1_000_000 + 25 * 60 * 60 * 1000).length, 0);
  assert.equal(service.list({ class: 'local' }, { id: b.id }).body.requests[0].status, 'expired');
  assert.equal((await service.fulfill({ id: b.id, value: VALUE })).status, 409);
});

test('a node lists only its own requests', (t) => {
  const { service } = setup(t);
  service.request({ class: 'node', node: 'aws1' }, ask({ pane: 'p1@aws1' }));
  service.request({ class: 'local' }, ask({ path: '/home/u/mac' }));
  assert.equal(service.list({ class: 'node', node: 'aws1' }, {}).body.requests.length, 1);
  assert.equal(service.list({ class: 'local' }, {}).body.requests.length, 2);
});

test('routes: a node may ask and read, only the console and the daemon machine may answer', () => {
  const list = routes({ secretService: {} });
  const find = (method, pathname) => matchRoute(list, { req: { method }, url: new URL(`http://x${pathname}`) });
  const node = { class: 'node', node: 'aws1' };
  assert.equal(routeDenial(find('POST', '/api/secrets/request'), node), null);
  assert.equal(routeDenial(find('GET', '/api/secrets'), node), null);
  assert.ok(routeDenial(find('POST', '/api/secrets/fulfill'), node));
  assert.ok(routeDenial(find('POST', '/api/secrets/decline'), node));
  assert.equal(routeDenial(find('POST', '/api/secrets/cancel'), node), null);
  assert.ok(routeDenial(find('POST', '/api/secrets/cancel'), { class: 'proxy' }), 'the console declines; it does not cancel');
  assert.equal(routeDenial(find('POST', '/api/secrets/fulfill'), { class: 'proxy' }), null);
  assert.ok(routeDenial(find('POST', '/api/secrets/request'), { class: 'proxy' }), 'the console does not make requests');
});

test('the asking session can cancel its own pending request, and nobody else can', async (t) => {
  const { service, root, calls } = setup(t);
  const node = { class: 'node', node: 'aws1' };
  const r = service.request(node, ask({ pane: 'p1@aws1' })).body.request;
  assert.equal(service.cancel(node, { id: r.id, sessionId: 'someone-else', pane: 'p1@aws1' }).status, 404);
  assert.equal(service.cancel({ class: 'node', node: 'aws2' }, { id: r.id, sessionId: SESSION, pane: 'p1@aws2' }).status, 404);
  assert.equal(service.cancel(node, { id: r.id, sessionId: SESSION, pane: 'p9@main' }).status, 403);
  const done = service.cancel(node, { id: r.id, sessionId: SESSION, pane: 'p1@aws1', reason: 'got it from AWS' });
  assert.equal(done.status, 200);
  assert.equal(done.body.request.status, 'cancelled');
  assert.equal(done.body.request.reason, 'got it from AWS');
  assert.deepEqual(consoleRequests(root, 1_000_000), [], 'the panel goes away');
  assert.equal(service.cancel(node, { id: r.id, sessionId: SESSION, pane: 'p1@aws1' }).status, 409);
  assert.equal((await service.fulfill({ id: r.id, value: VALUE })).status, 409);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.told, [], 'the session is not told what it did itself');
});

test('a request being written cannot be cancelled', async (t) => {
  let release;
  const { service } = setup(t, { writeLocal: () => new Promise((resolve) => { release = resolve; }) });
  const r = service.request({ class: 'local' }, ask()).body.request;
  const writing = service.fulfill({ id: r.id, value: VALUE });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.cancel({ class: 'local' }, { id: r.id, sessionId: SESSION }).status, 409);
  release({ replaced: false, bytes: 1 });
  assert.equal((await writing).status, 200);
});

test('the session is told in one typing chunk even for a long path, name and reason', async (t) => {
  const { service, calls } = setup(t);
  const deep = `/home/u/${'very-long-directory-name/'.repeat(18)}service-account.json`;
  const a = service.request({ class: 'local' }, ask({ name: `N${'x'.repeat(63)}`, path: deep, key: null })).body.request;
  assert.equal((await service.fulfill({ id: a.id, value: VALUE })).status, 200);
  const b = service.request({ class: 'local' }, ask({ path: '/home/u/other', key: null })).body.request;
  service.decline({ id: b.id, reason: 'r'.repeat(400) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.told.length, 2);
  for (const told of calls.told) assert.ok(told.text.length <= 200, `${told.text.length}: ${told.text}`);
  assert.match(calls.told[0].text, /…\/service-account\.json on main/);
});

test('a node may only ask for a session in one of its own panes', (t) => {
  const { service } = setup(t, { sessionPane: (id) => (id === SESSION ? 'p9@aws1' : null) });
  const node = { class: 'node', node: 'aws1' };
  assert.equal(service.request(node, ask()).status, 403, 'no pane');
  assert.equal(service.request(node, ask({ pane: 'p1' })).status, 403, 'a daemon-node pane');
  assert.equal(service.request(node, ask({ pane: 'p1@other' })).status, 403, 'another node');
  assert.equal(service.request(node, ask({ pane: 'p1@aws1' })).status, 403, 'not where the session runs');
  assert.equal(service.request(node, ask({ pane: 'p9@aws1' })).status, 200);
});

test('asking again updates the purpose; a different --replace replaces the pending one', (t) => {
  const { service, root } = setup(t);
  const first = service.request({ class: 'local' }, ask()).body.request;
  const again = service.request({ class: 'local' }, ask({ purpose: 'clearer purpose' })).body;
  assert.equal(again.request.id, first.id);
  assert.equal(again.request.purpose, 'clearer purpose');
  const replacing = service.request({ class: 'local' }, ask({ replace: true })).body;
  assert.notEqual(replacing.request.id, first.id);
  assert.equal(replacing.request.replace, true);
  assert.deepEqual(replacing.superseded, [first.id]);
  assert.deepEqual(consoleRequests(root, 1_000_000).map((r) => r.id), [replacing.request.id], 'Owner sees one panel');
  const old = service.list({ class: 'local' }, { id: first.id }).body.requests[0];
  assert.equal(old.status, 'superseded');
  assert.equal(old.supersededBy, replacing.request.id);
});

test('delivering a secret closes the other requests for that destination', async (t) => {
  const { service, root } = setup(t);
  // Stored as the old service left them: two pending asks for one key.
  const a = service.request({ class: 'local' }, ask()).body.request;
  const stored = JSON.parse(fs.readFileSync(storeFile(root), 'utf8'));
  stored.requests.push({ ...stored.requests[0], id: 'bbbbbbbb', replace: true });
  fs.writeFileSync(storeFile(root), JSON.stringify(stored));
  const other = service.request({ class: 'local' }, ask({ key: 'OTHER_TOKEN' })).body.request;
  assert.equal((await service.fulfill({ id: a.id, value: VALUE })).status, 200);
  assert.deepEqual(consoleRequests(root, 1_000_000).map((r) => r.id), [other.id]);
  const dup = service.list({ class: 'local' }, { id: 'bbbbbbbb' }).body.requests[0];
  assert.equal(dup.status, 'superseded');
  assert.equal(dup.supersededBy, a.id);
  assert.equal((await service.fulfill({ id: 'bbbbbbbb', value: VALUE })).status, 409);
});

test('two open asks for one destination are never written at once', async (t) => {
  let release;
  const { service, root } = setup(t, { writeLocal: () => new Promise((resolve) => { release = resolve; }) });
  const a = service.request({ class: 'local' }, ask()).body.request;
  const stored = JSON.parse(fs.readFileSync(storeFile(root), 'utf8'));
  stored.requests.push({ ...stored.requests[0], id: 'cccccccc', replace: true });
  fs.writeFileSync(storeFile(root), JSON.stringify(stored));
  const first = service.fulfill({ id: a.id, value: VALUE });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await service.fulfill({ id: 'cccccccc', value: VALUE })).status, 409);
  release({ replaced: false, bytes: 1 });
  assert.equal((await first).status, 200);
  assert.equal(service.list({ class: 'local' }, { id: 'cccccccc' }).body.requests[0].status, 'superseded');
});

test('another session writing the same file waits its turn', async (t) => {
  let release;
  const { service } = setup(t, { writeLocal: () => new Promise((resolve) => { release = resolve; }) });
  const a = service.request({ class: 'local' }, ask()).body.request;
  const b = service.request({ class: 'local' }, ask({ sessionId: 'other-session', key: 'OTHER' })).body.request;
  const first = service.fulfill({ id: a.id, value: VALUE });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await service.fulfill({ id: b.id, value: VALUE })).status, 409);
  release({ replaced: false, bytes: 1 });
  assert.equal((await first).status, 200);
  assert.equal(service.list({ class: 'local' }, { id: b.id }).body.requests[0].status, 'pending', 'another session is not superseded');
});

test('re-asking with other terms waits while the pending one is being written', async (t) => {
  let release;
  const { service } = setup(t, { writeLocal: () => new Promise((resolve) => { release = resolve; }) });
  const a = service.request({ class: 'local' }, ask()).body.request;
  const writing = service.fulfill({ id: a.id, value: VALUE });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.request({ class: 'local' }, ask({ replace: true })).status, 409);
  release({ replaced: false, bytes: 1 });
  assert.equal((await writing).status, 200);
});

test('a retry after a lost reply carries the request id and never widens to replace', async (t) => {
  const sent = [];
  const flaky = async (type, params) => {
    if (type === 'hello') return { secretWrite: 1 };
    sent.push(params);
    if (sent.length === 1) throw new Error('host request timed out (secret-write)');
    return { path: params.path, replaced: false, bytes: 1, repeated: true };
  };
  const { service } = setup(t, { hostRequest: flaky });
  const { id } = service.request({ class: 'node', node: 'aws1' }, ask({ pane: 'p1@aws1' })).body.request;
  assert.equal((await service.fulfill({ id, value: VALUE })).status, 502);
  assert.equal((await service.fulfill({ id, value: VALUE })).status, 200);
  assert.deepEqual(sent.map((p) => [p.requestId, p.replace]), [[id, false], [id, false]]);
});

test('expired requests are dropped a week after they expire', (t) => {
  const { service, root, advance } = setup(t);
  service.request({ class: 'local' }, ask());
  advance(24 * 60 * 60 * 1000 + 8 * 24 * 60 * 60 * 1000);
  service.request({ class: 'local' }, ask({ path: '/home/u/other', key: null }));
  const stored = JSON.parse(fs.readFileSync(storeFile(root), 'utf8')).requests;
  assert.deepEqual(stored.map((r) => r.path), ['/home/u/other']);
});
