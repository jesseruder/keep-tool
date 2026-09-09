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
    cancelAnimationFrame() {}, requestAnimationFrame(fn) { callback = fn; return 1; } });
  vm.runInContext(fn, ctx);
  ctx.scheduleFocus(mounted); callback(); assert.equal(focuses, 1);
  ctx.scheduleFocus(mounted); mounted.element.parentElement = {}; callback(); assert.equal(focuses, 1);
  ctx.scheduleFocus(mounted); ctx.document.activeElement = {}; callback(); assert.equal(focuses, 1);
  ctx.scheduleFocus(mounted); ctx.visibleTerminals = []; callback(); assert.equal(focuses, 1);
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

test('running sessions precede waiting sessions with stable ordering inside each group', () => {
  const ranks = new Map();
  const known = new Set(['a', 'b', 'c', 'd']);
  const order = (items) => Array.from(selection.stableSessionOrder(items, ranks, known), (item) => item.id);
  const a = { id: 'a', state: 'waiting' }, b = { id: 'b', state: 'running' };
  const c = { id: 'c', state: 'waiting' }, d = { id: 'd', state: 'running' };
  assert.deepEqual(order([a, b, c, d]), ['b', 'd', 'a', 'c']);
  assert.deepEqual(order([d, c, b, a]), ['b', 'd', 'a', 'c']);
  assert.deepEqual(order([d, c, b, { ...a, state: 'running' }]), ['a', 'b', 'd', 'c']);
  assert.deepEqual(order([d, c, b, a]), ['b', 'd', 'a', 'c']);
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
