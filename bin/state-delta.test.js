'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { consoleState } = require('./dashboard-state.js');
const { KEYED_PATHS, diffConsoleState, applyConsoleDelta } = require('../web/app/shared/state-delta.js');

// A round trip is exact when the applied result serializes identically to the next
// projection: the delta channel transports JSON, so that is the whole contract.
function roundTrip(previous, next, message) {
  const frozen = JSON.parse(JSON.stringify(previous));
  const delta = diffConsoleState(previous, next);
  const applied = applyConsoleDelta(previous, delta);
  assert.deepEqual(JSON.parse(JSON.stringify(applied)), JSON.parse(JSON.stringify(next)), message);
  assert.deepEqual(previous, frozen, 'applying a delta never mutates the base');
  return delta;
}

function projection(overrides = {}) {
  return {
    generatedAt: 1000,
    scopes: { names: ['work', 'personal'], default: 'personal', rules: [] },
    tasks: [
      { id: 'card-a', fm: { title: 'A', status: 'doing' }, createdAt: '2026-01-01T00:00', hasCheck: false, _detailVersion: 'a1' },
      { id: 'card-b', fm: { title: 'B', status: 'todo' }, createdAt: '2026-01-02T00:00', hasCheck: true, _detailVersion: 'b1' },
    ],
    sessions: [
      { id: 's-1', kind: 'claude', title: 'One', pane: 'p-1', state: 'idle', _detailVersion: 'v1' },
      { id: 's-2', kind: 'codex', title: 'Two', pane: 'p-2', state: 'running', _detailVersion: 'v2' },
    ],
    panes: [
      { id: 'p-1', alive: true, cwd: '/tmp/one', meta: { sessionId: 's-1' } },
      { id: 'p-2', alive: true, cwd: '/tmp/two', meta: { sessionId: 's-2' } },
    ],
    attention: [{ kind: 'input', key: 's-1', sessionId: 's-1' }],
    setAside: { 's-1': { kind: 'dismiss' } },
    notifications: [{ id: 'n-1', at: 10, text: 'hello', read: false }],
    limitResume: { waiting: [{ id: 's-2', type: 'claude', hitAt: 5 }], sent: [], stalled: [] },
    health: {
      daemon: { pid: 4, uptimeMs: 10 },
      schedulers: [
        { name: 'review', lastRunAt: 1, state: 'ok' },
        { name: 'usage', lastRunAt: 2, state: 'ok' },
      ],
    },
    usage: { accounts: {} },
    reviewQueue: {
      counts: { open: 1, done: 4 },
      items: [
        { id: 'r-1', type: 'finding', card: 'card-a', title: 'Needle', status: 'open', _detailVersion: 'r1' },
        { id: 'r-2', type: 'finding', card: 'card-b', title: 'Other', status: 'done', _detailVersion: 'r2' },
      ],
    },
    accounts: [{ id: 'default', label: 'Default', agent: 'claude' }],
    handoffs: [{ id: 'h-1', sessionId: 's-1', status: 'done' }],
    handoffQueue: [],
    review: { events: [{ at: 5, kind: 'tick', title: 'tick' }], stats: { seen: 1 } },
    agents: [{ name: 'incident', role: 'responder', unseen: 0 }],
    hostStatus: {},
    ...overrides,
  };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

test('an unchanged projection produces an empty delta', () => {
  const base = projection();
  assert.deepEqual(diffConsoleState(base, clone(base)), {});
  assert.deepEqual(applyConsoleDelta(base, {}), base);
});

test('top-level fields are added, replaced, and removed wholesale', () => {
  const base = projection();
  const next = clone(base);
  next.generatedAt = 2000;
  next.projectCatalog = { '~/work/keep': {} };
  delete next.hostStatus;
  const delta = roundTrip(base, next);
  assert.deepEqual(Object.keys(delta).sort(), ['remove', 'set']);
  assert.deepEqual(delta.remove, ['hostStatus']);
  assert.deepEqual(Object.keys(delta.set).sort(), ['generatedAt', 'projectCatalog']);
});

test('a field whose next value is undefined reads as removed, matching what JSON sends', () => {
  const base = projection();
  const next = clone(base);
  next.hostStatus = undefined;
  const delta = diffConsoleState(base, next);
  assert.deepEqual(delta.remove, ['hostStatus']);
  assert.equal(Object.hasOwn(applyConsoleDelta(base, delta), 'hostStatus'), false);
});

test('a keyed list sends only the rows that changed', () => {
  const base = projection();
  const next = clone(base);
  next.sessions[1].title = 'Two renamed';
  const delta = roundTrip(base, next);
  assert.deepEqual(Object.keys(delta), ['keyed']);
  assert.deepEqual(Object.keys(delta.keyed), ['sessions']);
  assert.deepEqual(delta.keyed.sessions.upsert.map((row) => row.id), ['s-2']);
  assert.equal(delta.keyed.sessions.order, undefined, 'an unchanged id order is not resent');
  assert.equal(delta.keyed.sessions.remove, undefined);
});

test('one changed session and a new generatedAt carry nothing else', () => {
  const base = projection();
  const next = clone(base);
  next.generatedAt = 2000;
  next.sessions[0].state = 'running';
  const delta = roundTrip(base, next);
  assert.deepEqual(Object.keys(delta).sort(), ['keyed', 'set']);
  assert.deepEqual(delta.set, { generatedAt: 2000 });
  assert.deepEqual(Object.keys(delta.keyed), ['sessions']);
  assert.deepEqual(delta.keyed.sessions.upsert, [next.sessions[0]]);
});

test('keyed rows are added, removed, and reordered with an explicit order', () => {
  const base = projection();
  const added = clone(base);
  added.tasks.push({ id: 'card-c', fm: { title: 'C' }, _detailVersion: 'c1' });
  const addDelta = roundTrip(base, added, 'an added row');
  assert.deepEqual(addDelta.keyed.tasks.order, ['card-a', 'card-b', 'card-c']);
  assert.deepEqual(addDelta.keyed.tasks.upsert.map((row) => row.id), ['card-c']);

  const removed = clone(base);
  removed.tasks.shift();
  const removeDelta = roundTrip(base, removed, 'a removed row');
  assert.deepEqual(removeDelta.keyed.tasks.remove, ['card-a']);
  assert.deepEqual(removeDelta.keyed.tasks.order, ['card-b']);
  assert.equal(removeDelta.keyed.tasks.upsert, undefined);

  const reordered = clone(base);
  reordered.tasks.reverse();
  const reorderDelta = roundTrip(base, reordered, 'a reordered list');
  assert.deepEqual(reorderDelta.keyed.tasks.order, ['card-b', 'card-a']);
  assert.equal(reorderDelta.keyed.tasks.upsert, undefined, 'reordering resends no row bodies');

  const churned = clone(base);
  churned.tasks = [{ id: 'card-c', fm: { title: 'C' } }, { ...churned.tasks[1], hasCheck: false }];
  roundTrip(base, churned, 'an add, a remove, a change and a reorder at once');
});

test('a nested container splits its own fields from its keyed list', () => {
  const base = projection();
  const itemsOnly = clone(base);
  itemsOnly.reviewQueue.items[0].status = 'closed';
  const itemsDelta = roundTrip(base, itemsOnly, 'only an item changed');
  assert.deepEqual(Object.keys(itemsDelta.nested.reviewQueue), ['keyed']);
  assert.deepEqual(itemsDelta.nested.reviewQueue.keyed.items.upsert.map((row) => row.id), ['r-1']);

  const countsOnly = clone(base);
  countsOnly.reviewQueue.counts.open = 2;
  const countsDelta = roundTrip(base, countsOnly, 'only the counts changed');
  assert.deepEqual(countsDelta.nested.reviewQueue, { set: { counts: { open: 2, done: 4 } } });

  const both = clone(base);
  both.reviewQueue.counts.open = 3;
  both.reviewQueue.items.pop();
  const bothDelta = roundTrip(base, both, 'counts and items together');
  assert.deepEqual(Object.keys(bothDelta.nested.reviewQueue).sort(), ['keyed', 'set']);

  const schedulers = clone(base);
  schedulers.health.schedulers[1].lastRunAt = 9;
  schedulers.health.daemon.uptimeMs = 20;
  const healthDelta = roundTrip(base, schedulers, 'health splits daemon from schedulers');
  assert.deepEqual(Object.keys(healthDelta.nested.health).sort(), ['keyed', 'set']);
  assert.deepEqual(healthDelta.nested.health.keyed.schedulers.upsert.map((row) => row.name), ['usage']);

  const waiting = clone(base);
  waiting.limitResume.waiting.push({ id: 's-1', type: 'codex', hitAt: 8 });
  waiting.limitResume.stalled = [{ id: 's-9' }];
  roundTrip(base, waiting, 'limitResume keys two of its three lists');
});

test('a list whose rows lack a unique key stays wholesale', () => {
  const base = projection();
  const next = clone(base);
  next.review.events.push({ at: 5, kind: 'tick', title: 'tick' });
  const delta = roundTrip(base, next);
  assert.deepEqual(Object.keys(delta.set), ['review'], 'review.events has no id, so review is one field');

  // attention rows collide on `key`; the whole list is one field.
  const attention = clone(base);
  attention.attention.push({ kind: 'unblocked', key: 'card-a', taskId: 'card-a' });
  assert.deepEqual(Object.keys(roundTrip(base, attention).set), ['attention']);

  // A keyed path whose rows lose their ids falls back rather than guessing.
  const unkeyed = clone(base);
  unkeyed.tasks = [{ fm: { title: 'nameless' } }];
  assert.deepEqual(Object.keys(roundTrip(base, unkeyed).set), ['tasks']);
});

test('a list that becomes something else, or appears for the first time, is sent whole', () => {
  const base = projection();
  const replaced = clone(base);
  replaced.panes = {};
  roundTrip(base, replaced, 'an array replaced by an object');

  const fresh = clone(base);
  delete fresh.accounts;
  roundTrip(fresh, base, 'a keyed list that was absent before');
  roundTrip(base, fresh, 'a keyed list that goes away');
});

test('the keyed path table covers every list the console projection keys', () => {
  assert.deepEqual(Object.keys(KEYED_PATHS).sort(), [
    'accounts', 'agents', 'handoffs', 'health.schedulers', 'limitResume.sent',
    'limitResume.waiting', 'notifications', 'panes', 'reviewQueue.items', 'sessions', 'tasks',
  ]);
});

test('a real consoleState projection round trips through a delta', () => {
  const state = {
    generatedAt: 111,
    digest: '# dropped',
    landed: ['dropped'],
    tasks: [
      { id: 'card-a', body: 'full body', fm: { title: 'One', status: 'doing' }, lastLog: 'log' },
      { id: 'card-b', body: 'other body', fm: { title: 'Two', status: 'todo' }, lastLog: 'log' },
    ],
    sessions: [
      { id: 's-1', title: 'One', pane: 'p-1', lastAssistantFull: 'tail', observation: { deep: true } },
      { id: 's-2', title: 'Two', pane: 'p-2', exited: true, state: 'exited', lastAssistantFull: 'tail' },
    ],
    panes: [
      { id: 'p-1', alive: true, cols: 80, rows: 24, cwd: '/tmp/one', meta: { sessionId: 's-1' } },
      { id: 'p-2', alive: false, agentAlive: false, cols: 80, cwd: '/tmp/two', meta: { sessionId: 's-2', openRequestId: 'r' } },
    ],
    attention: [{ kind: 'input', key: 's-1', sessionId: 's-1' }],
    notifications: [{ id: 'n-1', text: 'hi', read: false }],
    reviewQueue: { counts: { open: 1 }, items: [{ id: 'r-1', card: 'card-a', title: 'T', body: 'dropped' }] },
    health: { daemon: { pid: 1 }, schedulers: [{ name: 'review', state: 'ok' }] },
    accounts: [{ id: 'default', label: 'Default' }],
    agents: [{ name: 'incident', unseen: 0 }],
    panesOnly: undefined,
  };
  const previous = consoleState(state);
  const changed = JSON.parse(JSON.stringify(state));
  changed.generatedAt = 222;
  changed.sessions[0].title = 'One renamed';
  changed.notifications.push({ id: 'n-2', text: 'second', read: false });
  changed.health.schedulers[0].lastRunAt = 9;
  const next = consoleState(changed);

  const delta = roundTrip(previous, next, 'a projection built by consoleState');
  assert.deepEqual(Object.keys(delta).sort(), ['keyed', 'nested', 'set']);
  assert.deepEqual(delta.set, { generatedAt: 222 });
  assert.deepEqual(Object.keys(delta.keyed).sort(), ['notifications', 'sessions']);
  assert.deepEqual(delta.keyed.sessions.upsert.map((row) => row.id), ['s-1']);
  assert.deepEqual(Object.keys(delta.nested), ['health']);
  // The unchanged half of an 800 KB projection never reaches the wire.
  assert.ok(JSON.stringify(delta).length < JSON.stringify(next).length / 2);
});

test('a chain of deltas applies in order', () => {
  const one = projection();
  const two = clone(one);
  two.generatedAt = 2000;
  two.sessions[0].state = 'running';
  const three = clone(two);
  three.generatedAt = 3000;
  three.tasks.push({ id: 'card-c', fm: { title: 'C' } });
  three.reviewQueue.counts.open = 7;

  const deltas = [diffConsoleState(one, two), diffConsoleState(two, three)];
  const applied = deltas.reduce((state, delta) => applyConsoleDelta(state, delta), one);
  assert.deepEqual(clone(applied), clone(three));
  assert.deepEqual(one, projection(), 'the base survives a whole chain untouched');
});

test('a corrupt delta throws instead of producing a wrong list', () => {
  const base = projection();
  assert.throws(() => applyConsoleDelta(base, { keyed: { sessions: { key: 'id', order: ['nope'] } } }),
    /orders an unknown row/);
  assert.throws(() => applyConsoleDelta(base, { keyed: { sessions: { key: 'id', upsert: [{ id: 'new' }] } } }),
    /adds a row without an order/);
  assert.throws(() => applyConsoleDelta(base, { keyed: { sessions: { key: 'id', remove: ['s-1'] } } }),
    /removes rows without an order/);
  assert.throws(() => applyConsoleDelta(base, { keyed: { generatedAt: { key: 'id', order: [] } } }),
    /applies to an array/);
  assert.throws(() => diffConsoleState(null, base), /needs two projections/);
});
