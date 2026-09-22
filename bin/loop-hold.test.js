'use strict';

// The event-loop hold tracker: what it measures, what it logs, and whom the lag
// probe blames for a late window. Driven with its own clock and immediate queue.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
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

test('run passes the result and a throw through and closes the hold when it settles', async () => {
  const h = harness();
  assert.equal(h.holds.run('sync', (a, b) => a + b, 2, 3), 5);
  assert.throws(() => h.holds.run('throws', () => { throw new Error('boom'); }), /boom/);
  let resolve;
  const pending = h.holds.run('async', () => new Promise((r) => { resolve = r; }));
  const open = h.holds.recent().find((hold) => hold.name === 'async');
  assert.equal(open.leftAt, null, 'an async tick stays open until it settles');
  h.advance(10);
  resolve('done');
  assert.equal(await pending, 'done');
  assert.equal(open.leftAt, 10);
  await assert.rejects(h.holds.run('rejects', () => Promise.reject(new Error('no'))), /no/);
  h.flush();
  assert.deepEqual(h.lines, [], 'nothing held the loop');
});

// A rejection nobody handled used to crash the daemon (and launchd restarted it).
// The wrapper must neither swallow it nor add a second one to a handled rejection.
test('a dropped rejection stays exactly one unhandled rejection; a handled one stays none', () => {
  const script = `
    const { createLoopHold } = require(${JSON.stringify(path.join(__dirname, 'loop-hold.js'))});
    const holds = createLoopHold({ write: () => {} });
    let unhandled = 0;
    process.on('unhandledRejection', () => { unhandled += 1; });
    holds.run('dropped', () => Promise.reject(new Error('dropped')));
    holds.run('handled', () => Promise.reject(new Error('handled'))).catch(() => {});
    setTimeout(() => { process.stdout.write(String(unhandled)); }, 50);
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10e3 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '1');
});

test('a synchronous segment over the threshold is logged once, with its length', () => {
  const h = harness();
  h.holds.run('handoff-queue', () => { h.advance(2400); });
  assert.deepEqual(h.lines, [], 'reported from the check phase, once');
  h.flush();
  assert.deepEqual(h.lines, ['keep serve: handoff-queue held the loop 2400ms\n']);
});

test('the immediate measure covers an open tick\'s continuations, bounded by its lifetime', async () => {
  const h = harness();
  h.holds.run('turn-ticks', () => new Promise(() => {}));
  h.advance(900); // a continuation after the entry returned, while still open
  h.flush();
  assert.deepEqual(h.lines, ['keep serve: turn-ticks held the loop 900ms\n']);

  const g = harness();
  g.holds.run('background-jobs', () => {});
  g.holds.run('stalled', () => { g.advance(1200); });
  g.flush();
  assert.deepEqual(g.lines, ['keep serve: stalled held the loop 1200ms\n'],
    'the quick tick is not blamed for time a later hold spent');

  // An unwrapped 6 s callback after a tick that returned at once is not the tick's.
  const k = harness();
  k.holds.run('background-jobs', () => {});
  k.advance(6000);
  k.flush();
  assert.deepEqual(k.lines, [], 'a tick that settled synchronously is credited its synchronous time only');

  const m = harness();
  let resolve;
  const pending = m.holds.run('auto-compact', () => new Promise((r) => { resolve = r; }));
  m.advance(100);
  resolve();
  await pending;
  m.advance(6000);
  m.flush();
  assert.deepEqual(m.lines, [], 'nor past the moment an async tick settled');
});

test('attribution: a measured hold is named, guesses are marked likely, late or short ticks are not named', () => {
  const h = harness();
  // The probe landed at 1000 and was due at 2000; it lands at 4400.
  h.set(1100);
  h.holds.run('background-jobs', () => {});
  h.set(1500);
  h.holds.run('handoff-queue', () => { h.advance(2800); });
  assert.deepEqual(h.holds.attribute({ since: 1000, due: 2000, at: 4400 }), { name: 'handoff-queue', likely: false });

  const g = harness();
  g.set(500);
  g.holds.run('auto-compact', () => new Promise(() => {}));
  g.set(1200);
  g.holds.run('background-jobs', () => {});
  g.flush();
  assert.deepEqual(g.holds.attribute({ since: 1000, due: 2000, at: 4400 }), { name: 'auto-compact', likely: true },
    'an async tick open across the window is a guess at the unmeasured part');

  const k = harness();
  k.set(1200);
  k.holds.run('background-jobs', () => {});
  assert.equal(k.holds.attribute({ since: 1000, due: 2000, at: 4400 }), null,
    'a tick whose synchronous time is known short is not named, measured or not');
  k.set(4300);
  const leave = k.holds.enter('GET /api/state');
  assert.equal(k.holds.attribute({ since: 1000, due: 2000, at: 4400 }), null,
    'a hold entered after the probe was due (the overdue timer firing just before it) is not named');
  leave();
  k.set(1500);
  const quick = k.holds.enter('GET /api/quick');
  quick();
  assert.equal(k.holds.attribute({ since: 1000, due: 2000, at: 4400 }), null,
    'a hold that settled within the threshold is not named');
  const slow = k.holds.enter('POST /api/send');
  k.set(3500);
  slow();
  assert.deepEqual(k.holds.attribute({ since: 1000, due: 2000, at: 4400 }), { name: 'POST /api/send', likely: true },
    'an unmeasured hold entered before the due time and open past it is the last guess');
});

test('an open hold survives the ring filling with quick ticks', () => {
  const h = harness();
  h.set(0);
  h.holds.run('wt-gc', () => new Promise(() => {}));
  for (let index = 0; index < 1000; index++) {
    h.set(10 + index);
    h.holds.run('background-jobs', () => {});
  }
  h.flush();
  assert.equal(h.holds.recent().some((hold) => hold.name === 'wt-gc'), false, 'evicted from the ring');
  assert.deepEqual(h.holds.attribute({ since: 1000, due: 2000, at: 4400 }), { name: 'wt-gc', likely: true },
    'but still known while open');
});
