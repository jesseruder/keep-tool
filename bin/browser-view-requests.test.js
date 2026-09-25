'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBrowserViewService, consoleRequests, storeFile } = require('./browser-view-requests.js');
const { routes, matchRoute, routeDenial } = require('./serve/routes.js');

const SESSION = '11111111-2222-3333-4444-555555555555';

function setup(t, overrides = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-browser-view-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = 1_000_000;
  const calls = { changes: 0 };
  const service = createBrowserViewService({
    root,
    daemonNode: () => 'main',
    now: () => clock,
    onChange: () => { calls.changes += 1; },
    ...overrides,
  });
  return { root, service, calls, advance: (ms) => { clock += ms; } };
}

const ask = (extra = {}) => ({ sessionId: SESSION, pane: 'p1@aws1', browserSession: '#42 fix-login', note: 'sign in to Discord', ...extra });
const node = { class: 'node', node: 'aws1' };

test('a node asks for a view of its own session, recorded with its number and machine', async (t) => {
  const { service, root, calls } = setup(t);
  const result = await service.open(node, ask({ tabId: '17' }));
  assert.equal(result.status, 200);
  const { num, node: machine, tabId, note } = result.body.request;
  assert.deepEqual({ num, machine, tabId, note }, { num: 42, machine: 'aws1', tabId: 17, note: 'sign in to Discord' });
  assert.equal(calls.changes, 1);
  assert.equal(fs.statSync(storeFile(root)).mode & 0o777, 0o600);
  assert.equal(consoleRequests(root, 1_000_001).length, 1);
});

test('a node may not ask for another machine\'s pane, or a pane its session is not in', async (t) => {
  const { service } = setup(t, { sessionPane: () => 'p9@aws1' });
  assert.equal((await service.open(node, ask({ pane: 'p1@main' }))).status, 403);
  assert.equal((await service.open(node, ask())).status, 403);
});

test('a session without a Keep-named browser is told why, not shown an empty view', async (t) => {
  const { service } = setup(t);
  const result = await service.open(node, ask({ browserSession: 'claude-main #1234' }));
  assert.equal(result.status, 400);
  assert.match(result.body.error, /BROWSER_BRIDGE_SESSION_NAME/);
  assert.equal((await service.open(node, ask({ tabId: 'first' }))).status, 400);
});

test('asking again replaces the session\'s view; closing removes it; old ones expire', async (t) => {
  const { service, root, advance } = setup(t);
  const first = (await service.open(node, ask())).body.request;
  const second = (await service.open(node, ask({ tabId: 3 }))).body.request;
  assert.notEqual(first.id, second.id);
  assert.deepEqual(consoleRequests(root, 1_000_000).map((r) => r.id), [second.id]);

  assert.equal((await service.close({ class: 'proxy' }, { id: second.id })).body.closed, true);
  assert.equal(consoleRequests(root, 1_000_000).length, 0);

  await service.open(node, ask());
  advance(3 * 60 * 60 * 1000);
  assert.equal((await service.status(SESSION)).body.request, null);
});

test('overlapping opens from two sessions both land', async (t) => {
  const { service, root } = setup(t);
  await Promise.all([
    service.open(node, ask()),
    service.open(node, ask({ sessionId: 'another-session', pane: 'p2@aws1', browserSession: '#43' })),
  ]);
  assert.equal(consoleRequests(root, 1_000_000).length, 2);
});

test('a node closes a view only by naming its session\'s pane', async (t) => {
  const { service } = setup(t);
  await service.open(node, ask());
  assert.equal((await service.close(node, { sessionId: SESSION })).status, 403);
  assert.equal((await service.close({ class: 'node', node: 'other' }, { sessionId: SESSION, pane: 'p1@aws1' })).status, 403);
  assert.equal((await service.close(node, { sessionId: SESSION, pane: 'p1@aws1' })).body.closed, true);
});

test('routes: nodes, the daemon machine and the console may open and close views', () => {
  const list = routes({ browserViewService: {} });
  const find = (method, pathname) => matchRoute(list, { req: { method }, url: new URL(`http://x${pathname}`) });
  for (const principal of [node, { class: 'local' }, { class: 'proxy' }]) {
    assert.equal(routeDenial(find('POST', '/api/browser-view/open'), principal), null);
    assert.equal(routeDenial(find('POST', '/api/browser-view/close'), principal), null);
    assert.equal(routeDenial(find('GET', '/api/browser-view'), principal), null);
  }
});
