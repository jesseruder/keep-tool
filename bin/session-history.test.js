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

test('an unbound pane keeps its place, migrates to its registered session, and is not rebound on reuse', () => {
  const store = storage();
  const h = context.createSessionHistory(store);
  h.visit(entry('before'));
  h.visit({ paneId: 'new-pane', view: 'triage', title: 'New session', project: '/tmp/project', at: 2 });
  h.visit(entry('after'));
  assert.equal(h.move(-1).paneId, 'new-pane', 'Back returns to the new session before registration');
  assert.equal(h.bindPane('new-pane', 'registered', { title: 'Registered session' }), true);
  assert.deepEqual({ sessionId: h.current.sessionId, paneId: h.current.paneId, title: h.current.title },
    { sessionId: 'registered', paneId: 'new-pane', title: 'Registered session' });
  assert.equal(h.bindPane('new-pane', 'replacement'), false, 'pane reuse cannot rewrite conversation history');
  assert.equal(h.current.sessionId, 'registered');
  const restored = context.createSessionHistory(store);
  assert.equal(restored.current.sessionId, 'registered');
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

test('history navigation restores a live pane before it has a session id', () => {
  const state = { layouts: [{ name: 'Pinned', ids: [] }], focusMode: false };
  const pane = { id: 'new-pane', alive: true, meta: { project: '/tmp/project' } };
  const data = { sessions: [] };
  const history = { bindPane: () => assert.fail('an unbound pane must not bind') };
  const c = vm.createContext({ state, data, sessionHistory: history, paneMap: () => new Map([[pane.id, pane]]),
    entityForPane: () => ({ pane, session: null, project: '/tmp/project', title: 'New session' }),
    toggleFocus: () => {}, sessionItem: () => assert.fail('no session exists'),
    triageKey: (item) => `${item.kind}:${item.sessionId || item.pane}`, localStorage: storage(),
  });
  vm.runInContext(functionText('navigateHistory', '\nconst ctx ='), c);
  c.navigateHistory({ paneId: pane.id, view: 'triage', title: 'New session', project: '/tmp/project' });
  assert.equal(state.currentItem.pane, pane.id);
  assert.equal(state.paneTarget.pane, pane.id);
  assert.equal(state.focusPane, pane.id);
});

test('bound history never follows a reused pane when its recorded session is gone', () => {
  const state = { layouts: [{ name: 'Pinned', ids: [] }], focusMode: false };
  const pane = { id: 'reused-pane', alive: true };
  const data = { sessions: [{ id: 'replacement', pane: pane.id }] };
  const c = vm.createContext({ state, data, sessionHistory: { bindPane: () => assert.fail('already bound') },
    paneMap: () => new Map([[pane.id, pane]]), entityForPane: () => assert.fail('must not inspect a reused pane'),
    toggleFocus: () => {}, sessionItem: () => assert.fail('the old session is gone'),
    triageKey: (item) => `${item.kind}:${item.sessionId || item.pane}`, localStorage: storage(),
  });
  vm.runInContext(functionText('navigateHistory', '\nconst ctx ='), c);
  c.navigateHistory({ sessionId: 'old-session', paneId: pane.id, view: 'triage', title: 'Old session' });
  assert.equal(state.currentItem.sessionId, 'old-session');
  assert.equal(state.paneTarget, null);
  assert.equal(state.focusPane, null);
});

test('only explicit queue selection records history and requests terminal focus', () => {
  const state = { selected: 0, focusMode: false, focusPane: null, historyTarget: null };
  const visits = [];
  const c = vm.createContext({ state, focusDebug: () => {}, triageItems: () => [{ sessionId: 'a', pane: 'p' }],
    triageKey: (item) => item.sessionId, rememberItem: (...args) => visits.push(args), paneMap: () => new Map([['p', { alive: true }]]),
  });
  vm.runInContext(functionText('setSelected', '\nfunction moveQueue'), c);
  c.setSelected(0); assert.equal(visits.length, 0); assert.equal(state.focusPane, null);
  c.setSelected(0, true); assert.equal(visits.length, 1); assert.equal(state.focusPane, 'p');
});

test('a missing shell selection is not fabricated as an empty history row', () => {
  const state = { historyTarget: null };
  const c = vm.createContext({ state, isClosingSession: () => false, sessionFor: () => undefined,
    matchesTriageFilter: () => true, sessionItem: () => { throw new Error('unexpected session'); } });
  vm.runInContext(functionText('retainedSelectionItem', '\nfunction triageItems'), c);
  assert.equal(c.retainedSelectionItem({ kind: 'pinned', pane: 'shell' }), null);

  state.historyTarget = { sessionId: 'gone', title: 'Gone' };
  assert.equal(c.retainedSelectionItem({ kind: 'recent', sessionId: 'gone' }).sessionId, 'gone');
});

test('an exited or vanished unbound history pane is retained as its own read-only row', () => {
  const state = { historyTarget: { paneId: 'new-pane', view: 'triage', title: 'New session', project: '/tmp/project' },
    paneTarget: null };
  let panes = new Map([['new-pane', { id: 'new-pane', alive: false }]]);
  const c = vm.createContext({ state, isClosingSession: () => false, sessionFor: () => undefined,
    matchesTriageFilter: () => true, paneMap: () => panes });
  vm.runInContext(functionText('retainedSelectionItem', '\nfunction triageItems'), c);
  const exited = c.retainedSelectionItem({ kind: 'running', pane: 'new-pane', project: '/tmp/project' });
  assert.equal(exited.pane, 'new-pane');
  assert.equal(exited.state, 'exited');
  panes = new Map();
  const missing = c.retainedSelectionItem({ ...state.historyTarget, kind: 'recent', pane: null, state: 'exited' });
  assert.equal(missing.pane, null);
  assert.equal(missing.paneId, 'new-pane');
  assert.equal(missing.title, 'New session');

  panes = new Map([['new-pane', { id: 'new-pane', alive: true }]]);
  state.historyTarget = { sessionId: 'old-session', paneId: 'new-pane', title: 'Old session', project: '/tmp/project' };
  const rebound = c.retainedSelectionItem({ ...state.historyTarget, kind: 'recent', pane: 'new-pane', state: 'exited' });
  assert.equal(rebound.sessionId, 'old-session');
  assert.equal(rebound.pane, null, 'bound history cannot follow a reused live pane');
});

// An agent is listed by its Agents row alone. A retained row for its session
// would be a second listing of the same pane, and an invisible last queue item
// for j/k and the number keys to land on.
test('an agent’s session is never retained as a queue row', () => {
  const agentSession = { id: 'sess-1', agentName: 'sandboxes' };
  const context = (session) => {
    const state = { historyTarget: null, paneTarget: { pane: 'pane-1', kind: 'running' } };
    const c = vm.createContext({ state, isClosingSession: () => false, sessionFor: () => session,
      matchesTriageFilter: () => true, triageVisible: () => true,
      paneMap: () => new Map([['pane-1', { id: 'pane-1', alive: true }]]),
      entityForPane: () => ({ session, project: '~/keep', title: 'sandboxes', state: 'running' }),
      sessionItem: (kind, from, pane) => ({ kind, sessionId: from.id, pane }) });
    vm.runInContext(functionText('retainedSelectionItem', '\nfunction triageItems'), c);
    return { state, c };
  };

  // The pane stand-in openReviewPane leaves behind, and the session-backed row it
  // would otherwise hand over to.
  const opened = context(agentSession);
  assert.equal(opened.c.retainedSelectionItem({ kind: 'running', pane: 'pane-1' }), null);
  assert.equal(opened.state.paneTarget, null, 'the stand-in has nothing left to hand over to');
  const listed = context(agentSession);
  assert.equal(listed.c.retainedSelectionItem({ kind: 'recent', sessionId: 'sess-1', pane: 'pane-1' }), null);

  // The reviewer's session is the same case, and carries `reviewer` instead.
  const reviewer = context({ id: 'r1', reviewer: true });
  assert.equal(reviewer.c.retainedSelectionItem({ kind: 'recent', sessionId: 'r1', pane: 'pane-1' }), null);

  // A working session still gets its retained row.
  const working = context({ id: 'sess-2' });
  assert.deepEqual(working.c.retainedSelectionItem({ kind: 'recent', sessionId: 'sess-2', pane: 'pane-1' }),
    { kind: 'recent', sessionId: 'sess-2', pane: undefined });
});

test('Close follows Dismiss and acts immediately without a confirmation', () => {
  const triage = fs.readFileSync(path.join(__dirname, '../web/app/triage.js'), 'utf8');
  const header = triage.split('\n').find((line) => line.includes("querySelector('.quick-actions')"));
  assert.ok(header.indexOf('data-close-session') > header.indexOf('data-dismiss'));
  const close = fs.readFileSync(path.join(__dirname, '../web/app/close-session.js'), 'utf8');
  assert.doesNotMatch(close, /confirmAction|window.confirm/);
});

test('explicit selection of a different waiting row overrides automatic Focus mode', () => {
  const state = { focusMode: true, focusPane: null };
  const c = vm.createContext({ state, focusDebug: () => {}, triageItems: () => [{ sessionId: 'a', pane: 'pa' }, { sessionId: 'b', pane: 'pb' }],
    triageKey: (item) => `waiting:${item.sessionId}`, rememberItem: () => {}, paneMap: () => new Map([['pb', { alive: true }]]),
    toggleFocus: (value) => { state.focusMode = value; },
  });
  vm.runInContext(functionText('setSelected', '\nfunction moveQueue'), c);
  c.setSelected(1, true);
  assert.equal(state.focusMode, false); assert.equal(state.focusPane, 'pb'); assert.equal(state.selectedKey, 'waiting:b');
});
