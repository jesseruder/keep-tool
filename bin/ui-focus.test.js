'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const selection = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/app/selection.js'), 'utf8').replaceAll('export function', 'function'), selection);
const key = (item) => item.sessionId;
const section = (item) => `${item.kind}:${key(item)}`;

test('selection survives reorder, activity group changes and absence from collapsed groups', () => {
  const current = { kind: 'running', sessionId: 'typing' };
  const other = { kind: 'running', sessionId: 'other' };
  assert.equal(selection.selectionIndex([other, current], section(current), current, 0, key, section), 1);
  const pinned = { ...current, kind: 'pinned' };
  assert.equal(selection.selectionIndex([other, pinned], section(current), current, 0, key, section), 1);
  const fresh = { ...current, kind: 'recent', pane: 'reopened' };
  const retained = selection.retainSelection([other], { ...current, question: 'answered', options: ['obsolete'], pane: 'old' }, section(current), key, section, () => fresh);
  assert.equal(retained[0], fresh);
  assert.equal(retained[0].options, undefined);
  assert.equal(retained[0].pane, 'reopened');
  assert.equal(selection.selectionIndex([other, ...retained], section(current), current, 0, key, section), 1);
  assert.equal(selection.retainSelection([other], current, section(current), key, section, () => false).length, 0, 'dismissed/filter-excluded sessions must not be retained');
  assert.equal(selection.retainSelection([other], current, section(other), key, section, () => true).length, 0, 'explicit selection wins');
  const shell = { kind: 'pinned', pane: 'shell-pane' };
  const agent = { kind: 'pinned', pane: 'shell-pane', sessionId: 'new-agent' };
  assert.equal(selection.selectionIndex([other, agent], 'pinned:shell-pane', shell, 0, key, section), 1, 'shell-to-agent metadata transition preserves the physical terminal');
});

test('deferred terminal focus cannot target an old render or override a newer user focus', () => {
  const source = fs.readFileSync(path.join(__dirname, '../web/app/app.js'), 'utf8');
  const fn = source.slice(source.indexOf('function scheduleFocus('), source.indexOf('function scheduleTerminalFit('));
  let callback, focuses = 0;
  const origin = {}, body = {};
  const mounted = { element: { isConnected: true, getClientRects: () => [1] }, focus: () => focuses++ };
  const ctx = vm.createContext({ focusFrame: 0, terminalRender: 1, visibleTerminals: [mounted], document: { activeElement: origin, body },
    captureFocusIntent() { const origin = ctx.document.activeElement; return () => ctx.document.activeElement === origin || ctx.document.activeElement === body; },
    cancelAnimationFrame() {}, requestAnimationFrame(fn) { callback = fn; return 1; } });
  vm.runInContext(fn, ctx);
  ctx.scheduleFocus(mounted); callback(); assert.equal(focuses, 1);
  ctx.scheduleFocus(mounted); mounted.element.parentElement = {}; callback(); assert.equal(focuses, 1);
  ctx.scheduleFocus(mounted); ctx.document.activeElement = {}; callback(); assert.equal(focuses, 1);
  ctx.scheduleFocus(mounted); ctx.visibleTerminals = []; callback(); assert.equal(focuses, 1);
});

test('focus intent expires on newer input even when the new target leaves focus on body', async () => {
  const { captureFocusIntent } = await import('../web/app/focus-intent.js');
  const events = new Map(), windowEvents = new Map();
  const doc = { body: {}, activeElement: {}, visibilityState: 'visible',
    addEventListener: (name, fn) => events.set(name, fn), defaultView: { addEventListener: (name, fn) => windowEvents.set(name, fn) } };
  let wanted = captureFocusIntent(doc);
  doc.activeElement = doc.body;
  assert.equal(wanted(), true, 'DOM reparenting alone may restore focus');
  for (const event of ['pointerdown', 'keydown']) {
    wanted = captureFocusIntent(doc); events.get(event)();
    assert.equal(wanted(), false, event);
  }
  wanted = captureFocusIntent(doc); windowEvents.get('blur')(); assert.equal(wanted(), false);
  wanted = captureFocusIntent(doc); doc.visibilityState = 'hidden'; assert.equal(wanted(), false);
});

test('UI diagnostics bound storage, strip unknown text fields, and expire after an hour', () => {
  const debug = require('./ui-debug');
  for (let i = 0; i < 1100; i++) debug.record([{ event: 'focusout', target: 'textarea.xterm', text: 'SECRET', key: 'x', at: i }], 1000);
  assert.equal(debug.read(1000).length, 1000);
  assert.equal(JSON.stringify(debug.read(1000)).includes('SECRET'), false);
  assert.throws(() => debug.record(Array(51).fill({})), /at most 50/);
  assert.equal(debug.read(3601001).length, 0);
});

test('running list does not reorder on output updates or return from idle', () => {
  const ranks = new Map();
  const known = new Set(['a', 'b', 'c']);
  const ids = (items) => Array.from(selection.stableSessionOrder(items.map((id) => ({ id })), ranks, known), (item) => item.id);
  assert.deepEqual(ids(['a', 'b']), ['a', 'b']);
  assert.deepEqual(ids(['b', 'a']), ['a', 'b']);
  assert.deepEqual(ids(['b']), ['b']);
  assert.deepEqual(ids(['c', 'b', 'a']), ['a', 'b', 'c']);
  known.delete('a'); ids(['b', 'c']);
  assert.equal(ranks.has('a'), false);
});

test('running and waiting sessions retain their slots through status changes', () => {
  const ranks = new Map();
  const known = new Set(['a', 'b', 'c', 'd']);
  const order = (items) => Array.from(selection.stableSessionOrder(items, ranks, known), (item) => item.id);
  const a = { id: 'a', state: 'waiting' }, b = { id: 'b', state: 'running' };
  const c = { id: 'c', state: 'waiting' }, d = { id: 'd', state: 'running' };
  assert.deepEqual(order([a, b, c, d]), ['a', 'b', 'c', 'd']);
  assert.deepEqual(order([d, c, b, a]), ['a', 'b', 'c', 'd']);
  assert.deepEqual(order([d, c, b, { ...a, state: 'running' }]), ['a', 'b', 'c', 'd']);
  assert.deepEqual(order([d, c, b, a]), ['a', 'b', 'c', 'd']);
});

test('running panel orders by task creation age regardless of activity and refresh order', () => {
  const source = fs.readFileSync(path.join(__dirname, '../web/app/app.js'), 'utf8');
  const data = {
    tasks: [{ id: 'old', fm: { created: '2026-01-01' } }, { id: 'new', fm: { created: '2026-02-01' } }],
    sessions: [{ id: 'new', taskId: 'new', state: 'running', mtime: 1 },
      { id: 'shell', pane: 'p', state: 'waiting', mtime: 2 },
      { id: 'old', taskId: 'old', state: 'waiting', mtime: 3 }],
  };
  const ctx = vm.createContext({ data, runningOrder: new Map(), stableSessionOrder: selection.stableSessionOrder,
    paneMap: () => new Map([['p', { createdAt: '2026-01-15' }]]), isClosingSession: () => false,
    sessionItem: (kind, session) => session });
  vm.runInContext(source.slice(source.indexOf('function runningItems('), source.indexOf('function pinnedItems(')), ctx);
  const order = () => Array.from(ctx.runningItems(), item => item.id);
  assert.deepEqual(order(), ['old', 'shell', 'new']);
  data.sessions.reverse();
  for (const session of data.sessions) { session.state = session.state === 'running' ? 'waiting' : 'running'; session.mtime += 1000; }
  assert.deepEqual(order(), ['old', 'shell', 'new']);
  ctx.runningOrder.clear();
  assert.deepEqual(order(), ['old', 'shell', 'new'], 'reload uses creation age too');
  data.tasks[0] = { id: 'old', fm: { created: '2026-02-01' }, body: '## 2026-02-01 09:00 — created\nOlder task' };
  data.tasks[1] = { id: 'new', fm: { created: '2026-02-01' }, body: '## 2026-02-01 14:00 — created\nNewer task' };
  assert.deepEqual(order(), ['shell', 'old', 'new'], 'same-day tasks use precise creation logs');
  data.sessions.reverse(); ctx.runningOrder.clear();
  assert.deepEqual(order(), ['shell', 'old', 'new']);
  data.tasks[0].body = ''; data.tasks[1].body = '';
  const tied = order();
  data.sessions.reverse(); ctx.runningOrder.clear();
  assert.deepEqual(order(), tied, 'missing creation logs have deterministic ties across reloads');
});

test('scheduled idle sessions can be dismissed without changing their scheduled task', () => {
  const serve = require('./serve');
  const session = { id: 'location', state: 'waiting', mtime: 1000, taskId: 'backup' };
  const candidates = serve.setAsideCandidates([], [session]);
  assert.equal(candidates[0].sessionId, 'location');
  const store = { version: 1, items: { location: { kind: 'dismiss', at: 2000, until: null, since: 1000 } } };
  assert.ok(serve.applySetAside(candidates, { store, now: 3000, write: false }).value.items.location);
  assert.equal(serve.applySetAside(serve.setAsideCandidates([], [{ ...session, mtime: 4000 }]), { store, now: 5000, write: false }).value.items.location, undefined);
  assert.equal(session.taskId, 'backup');
});
