'use strict';

// The event-loop hold tracker: what it measures, what it logs, and whom the lag
// probe blames for a late window. Driven with its own clock and immediate queue.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createLoopHold } = require('./loop-hold.js');

function harness() {
  let clock = 0;
  const immediates = [];
  const lines = [];
  const holds = createLoopHold({
    now: () => clock,
    setImmediate: (fn) => { immediates.push(fn); return { unref() {} }; },
    write: (line) => lines.push(line),
  });
  return {
    holds, lines,
    advance: (ms) => { clock += ms; },
    set: (at) => { clock = at; },
    flush: () => { while (immediates.length) immediates.shift()(); },
  };
}

test('run passes the result and a throw through untouched and closes the hold', async () => {
  const h = harness();
  assert.equal(h.holds.run('sync', (a, b) => a + b, 2, 3), 5);
  assert.throws(() => h.holds.run('throws', () => { throw new Error('boom'); }), /boom/);
  let resolve;
  const pending = h.holds.run('async', () => new Promise((r) => { resolve = r; }));
  const open = h.holds.recent().find((hold) => hold.name === 'async');
  assert.equal(open.leftAt, 0, 'an async tick stays open until it settles');
  h.advance(10);
  resolve('done');
  assert.equal(await pending, 'done');
  await new Promise((r) => setImmediate(r));
  assert.equal(open.leftAt, 10);
  const rejected = h.holds.run('rejects', () => Promise.reject(new Error('no')));
  await assert.rejects(rejected, /no/);
  h.flush();
  assert.deepEqual(h.lines, [], 'nothing held the loop');
});

test('a synchronous segment over the threshold is logged once, with its length', () => {
  const h = harness();
  h.holds.run('handoff-queue', () => { h.advance(2400); });
  assert.deepEqual(h.lines, [], 'reported from the check phase, once');
  h.flush();
  assert.deepEqual(h.lines, ['keep serve: handoff-queue held the loop 2400ms\n']);
});

test('the immediate measure covers continuations, but only while no other hold entered', () => {
  const h = harness();
  h.holds.run('turn-index', () => Promise.resolve());
  h.advance(900); // a continuation after the entry returned
  h.flush();
  assert.deepEqual(h.lines, ['keep serve: turn-index held the loop 900ms\n']);

  const g = harness();
  g.holds.run('background-jobs', () => {});
  g.holds.run('stalled', () => { g.advance(1200); });
  g.flush();
  assert.deepEqual(g.lines, ['keep serve: stalled held the loop 1200ms\n'],
    'the quick tick is not blamed for time a later hold spent');
});

test('attribution prefers a measured hold, then an open one, then a recent unmeasured one', () => {
  const h = harness();
  // The probe landed at 1000 and was due at 2000; it lands at 4400.
  h.set(1100);
  h.holds.run('background-jobs', () => {});
  h.set(1500);
  h.holds.run('handoff-queue', () => { h.advance(2800); });
  assert.equal(h.holds.attribute({ since: 1000, due: 2000, at: 4400 }), 'handoff-queue');

  const g = harness();
  g.set(500);
  g.holds.run('auto-compact', () => new Promise(() => {}));
  g.set(1200);
  g.holds.run('background-jobs', () => {});
  g.flush();
  assert.equal(g.holds.attribute({ since: 1000, due: 2000, at: 4400 }), 'auto-compact',
    'an async tick open across the window is the likeliest holder of its unmeasured part');

  const k = harness();
  k.set(1200);
  k.holds.run('background-jobs', () => {});
  k.flush();
  assert.equal(k.holds.attribute({ since: 1000, due: 2000, at: 4400 }), null,
    'a tick measured to have returned at once is not named');
  const enter = k.holds.enter('GET /api/state');
  enter();
  assert.equal(k.holds.attribute({ since: 1000, due: 2000, at: 4400 }), 'GET /api/state',
    'an unmeasured hold in the window is the fallback');
});
