'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/app/session-history.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.replaceAll('export function', 'function'), context);
const entry = (sessionId, view = 'triage') => ({ sessionId, view, title: sessionId, at: 1 });
const storage = () => { let value = null; return { getItem: () => value, setItem: (_, next) => { value = next; } }; };

test('history deduplicates repeat selections, traverses without duplicating, and preserves branched-away recents', () => {
  const h = context.createSessionHistory(storage());
  h.visit(entry('a')); h.visit(entry('a')); h.visit(entry('b')); h.visit(entry('c'));
  assert.equal(h.move(-1).sessionId, 'b');
  assert.equal(h.move(-1).sessionId, 'a');
  assert.equal(h.canBack, false);
  assert.equal(h.move(1).sessionId, 'b');
  h.visit(entry('d'));
  assert.equal(h.canForward, false);
  assert.equal(h.move(-1).sessionId, 'b');
  assert.ok(h.recent.some((e) => e.sessionId === 'c'));
});

test('history persists view/layout and cursor; bounds visits and recent sessions to 50', () => {
  const store = storage();
  const h = context.createSessionHistory(store);
  for (let i = 0; i < 70; i++) h.visit({ ...entry(`s${i}`, 'watch'), layout: 'Pinned' });
  h.move(-1);
  const restored = context.createSessionHistory(store);
  assert.equal(restored.current.sessionId, 's68');
  assert.equal(restored.current.layout, 'Pinned');
  assert.equal(restored.current.view, 'watch');
  assert.equal(restored.recent.length, 50);
  let count = 1; while (restored.move(-1)) count++;
  assert.equal(count, 49);
});

test('history fails safely for corrupt or inaccessible storage and ignores unknown modes', () => {
  for (const store of [{ getItem: () => 'bad' }, { getItem: () => { throw new Error(); }, setItem: () => { throw new Error(); } }]) {
    const h = context.createSessionHistory(store);
    assert.equal(h.canBack, false);
    h.visit(entry('a', 'fleet')); assert.equal(h.current, undefined);
    h.visit(entry('a')); assert.equal(h.current.sessionId, 'a');
  }
});

const app = fs.readFileSync(path.join(__dirname, '../web/app/app.js'), 'utf8');
function functionText(name, next) { return app.slice(app.indexOf(`function ${name}(`), app.indexOf(next, app.indexOf(`function ${name}(`))); }

test('history navigation restores Watch layout; missing/closed panes stay closed in Triage', () => {
  const state = { layouts: [{ name: 'Other', ids: [] }, { name: 'Pinned', ids: ['p'] }], focusMode: true };
  const data = { sessions: [{ id: 'a', pane: 'p', title: 'A' }] };
  const pane = { id: 'p', alive: true };
  const c = vm.createContext({ state, data, paneMap: () => new Map([['p', pane]]),
    toggleFocus: (value) => { state.focusMode = value; }, sessionItem: (kind, s) => ({ kind, sessionId: s.id, pane: s.pane }),
    triageKey: (item) => `${item.kind}:${item.sessionId}`, localStorage: storage(),
  });
  vm.runInContext(functionText('navigateHistory', '\nconst ctx ='), c);
  c.navigateHistory({ ...entry('a', 'watch'), layout: 'Pinned' });
  assert.equal(state.mode, 'watch'); assert.equal(state.layout, 1); assert.equal(state.focusPane, 'p');
  assert.equal(state.focusMode, false);
  pane.alive = false;
  c.navigateHistory(entry('a', 'watch'));
  assert.equal(state.mode, 'triage'); assert.equal(state.focusPane, null);
  data.sessions = [];
  c.navigateHistory(entry('a'));
  assert.equal(state.currentItem.sessionId, 'a'); assert.equal(state.currentItem.pane, null);
  assert.equal(state.currentItem.state, 'exited');
});

test('only explicit queue selection records history and requests terminal focus', () => {
  const state = { selected: 0, focusMode: false, focusPane: null, historyTarget: null };
  const visits = [];
  const c = vm.createContext({ state, focusDebug: () => {}, triageItems: () => [{ sessionId: 'a', pane: 'p' }],
    triageKey: (item) => item.sessionId, rememberSession: (...args) => visits.push(args), paneMap: () => new Map([['p', { alive: true }]]),
  });
  vm.runInContext(functionText('setSelected', '\nfunction moveQueue'), c);
  c.setSelected(0); assert.equal(visits.length, 0); assert.equal(state.focusPane, null);
  c.setSelected(0, true); assert.equal(visits.length, 1); assert.equal(state.focusPane, 'p');
});

test('Close follows Dismiss and acts immediately without a confirmation', () => {
  const triage = fs.readFileSync(path.join(__dirname, '../web/app/triage.js'), 'utf8');
  const header = triage.split('\n').find((line) => line.includes("stage.querySelector('.shead')"));
  assert.ok(header.indexOf('data-close-session') > header.indexOf('data-dismiss'));
  const close = fs.readFileSync(path.join(__dirname, '../web/app/close-session.js'), 'utf8');
  assert.doesNotMatch(close, /confirmAction|window.confirm/);
});

test('explicit selection of a different waiting row overrides automatic Focus mode', () => {
  const state = { focusMode: true, focusPane: null };
  const c = vm.createContext({ state, focusDebug: () => {}, triageItems: () => [{ sessionId: 'a', pane: 'pa' }, { sessionId: 'b', pane: 'pb' }],
    triageKey: (item) => `waiting:${item.sessionId}`, rememberSession: () => {}, paneMap: () => new Map([['pb', { alive: true }]]),
    toggleFocus: (value) => { state.focusMode = value; },
  });
  vm.runInContext(functionText('setSelected', '\nfunction moveQueue'), c);
  c.setSelected(1, true);
  assert.equal(state.focusMode, false); assert.equal(state.focusPane, 'pb'); assert.equal(state.selectedKey, 'waiting:b');
});
