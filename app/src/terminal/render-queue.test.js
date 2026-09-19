'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createRenderQueue } = require('./render-queue.js');

// A controllable clock, because the whole point of the module is when it fires.
function harness(intervalMs = 33) {
  const flushes = [];
  let clock = 1000;
  let timer = null;
  const queue = createRenderQueue({
    intervalMs,
    now: () => clock,
    setTimeout: (fn, ms) => { timer = { fn, at: clock + ms }; return timer; },
    clearTimeout: (entry) => { if (timer === entry) timer = null; },
    onFlush: (payload) => flushes.push(payload),
  });
  return {
    queue,
    flushes,
    advance(ms) { clock += ms; },
    // Fire the pending timer the way the runtime would once its delay is up.
    fire() {
      if (!timer) return false;
      clock = Math.max(clock, timer.at);
      const entry = timer;
      timer = null;
      entry.fn();
      return true;
    },
    scheduledIn() { return timer ? timer.at - clock : null; },
  };
}

test('the first invalidation paints at once and the rest of the burst coalesces into one frame', () => {
  const h = harness();
  h.queue.invalidate([3, 1]);
  assert.deepEqual(h.flushes, [{ rows: [1, 3], full: false }], 'a quiet screen repaints immediately');

  h.advance(5);
  h.queue.invalidate([7]);
  h.advance(5);
  h.queue.invalidate([2, 7, 7]);
  assert.equal(h.flushes.length, 1, 'everything inside the interval waits for one frame');
  assert.equal(h.scheduledIn(), 33 - 10, 'the frame is due when the interval since the last paint is up');

  h.fire();
  assert.deepEqual(h.flushes[1], { rows: [2, 7], full: false }, 'duplicate rows collapse and the list is ordered');

  h.advance(100);
  h.queue.invalidate([4]);
  assert.equal(h.flushes.length, 3, 'after an idle gap the next byte paints immediately again');
});

test('a full invalidation replaces the row list and survives further row updates', () => {
  const h = harness();
  h.queue.invalidate([1]);
  h.advance(1);
  h.queue.invalidateAll();
  h.queue.invalidate([5]);
  assert.deepEqual(h.queue.pending(), { rows: [], full: true, scheduled: true });
  h.fire();
  assert.deepEqual(h.flushes[1], { rows: [], full: true },
    'a resize invalidates a screen the pending row indices no longer describe');

  h.advance(100);
  h.queue.invalidate([2]);
  assert.deepEqual(h.flushes[2], { rows: [2], full: false }, 'the full flag does not stick');
});

test('an explicit flush paints the pending frame and cancels the timer', () => {
  const h = harness();
  h.queue.invalidate([1]);
  h.advance(2);
  h.queue.invalidate([6]);
  assert.equal(h.scheduledIn(), 31);
  assert.equal(h.queue.flush(), true);
  assert.deepEqual(h.flushes[1], { rows: [6], full: false });
  assert.equal(h.scheduledIn(), null, 'the scheduled frame is dropped, not fired twice');
  assert.equal(h.queue.flush(), false, 'flushing an empty queue paints nothing');
});

test('a timer that outlives its work paints nothing, and disposal silences the queue', () => {
  const h = harness();
  h.queue.invalidate([1]);
  h.advance(1);
  h.queue.invalidate([2]);
  h.queue.flush();
  assert.equal(h.flushes.length, 2);
  h.fire();
  assert.equal(h.flushes.length, 2, 'the trailing timer had nothing left to paint');

  h.advance(100);
  h.queue.invalidate([9]);
  assert.equal(h.flushes.length, 3);
  h.advance(1);
  h.queue.invalidate([9]);
  h.queue.dispose();
  h.fire();
  h.queue.invalidate([1]);
  h.queue.invalidateAll();
  assert.equal(h.queue.flush(), false);
  assert.equal(h.flushes.length, 3, 'nothing paints into an unmounted screen');
});
