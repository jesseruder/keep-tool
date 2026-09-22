'use strict';

// Who is holding the daemon's event loop.
//
// `keep serve` runs every scheduler tick and every HTTP route on one thread, so a
// tick that does a synchronous directory walk or spawns a child synchronously
// stalls everything else, host requests included. The lag probe in
// bin/serve/schedulers.js notices a stall after the fact (its one-second timer
// lands late); this module is what lets it say who it was.
//
// Wrapped code calls enter(name) at its synchronous entry and the returned leave()
// once its promise settles. That costs one small object and one setImmediate per
// tick: no stack capture, no timers per hold, nothing on the hot path that grows.
// Two measurements come out of it:
//
//   - run() times the synchronous entry segment exactly, from the call to its
//     return. That is the part of a tick that cannot yield.
//   - the setImmediate queued at entry runs in the check phase after the current
//     one, so its delay also covers the microtask continuations the entry kicked
//     off (an `await` of something already resolved, then a long loop). The same
//     delay also covers any other callback that ran in between, so the credit is
//     bounded twice: it only counts when no other wrapped hold was entered since,
//     and never beyond the hold's own lifetime (a tick that already settled cannot
//     have held the loop after it settled; one that returned synchronously is
//     credited exactly its synchronous time). An unwrapped callback that runs
//     while a hold is still open can still be credited to it; that is the
//     residual error.
//
// Either measurement over the threshold logs `keep serve: <name> held the loop Nms`
// once per tick, which catches a hold even when the probe's own timer happened to
// land inside it and so saw no lateness.
//
// Times come from performance.now(), the monotonic clock Node's timers run on. The
// lag probe measures on the same clock, so the two compare directly, and neither
// counts time the machine spent asleep.

const { performance } = require('node:perf_hooks');

const DEFAULT_THRESHOLD_MS = 500;
// The ring of recent holds. The 500 ms background-jobs tick alone enters two a
// second, so this covers a couple of minutes even with a busy route mix; memory is
// bounded no matter how many ticks run. Open holds are kept separately (below), so
// a long tick is never evicted while it is still running.
const RECENT_LIMIT = 256;
// Open holds are few (the slow ticks in flight, routes waiting on a lock). The cap
// only guards against a caller that never settles.
const OPEN_LIMIT = 64;

function createLoopHold({
  now = () => performance.now(),
  setImmediate: si = setImmediate,
  write = (line) => process.stderr.write(line),
  thresholdMs = DEFAULT_THRESHOLD_MS,
} = {}) {
  let seq = 0;
  const recent = [];
  const open = new Set();

  function begin(name) {
    const hold = { name: String(name || 'unknown'), at: now(), seq: ++seq, syncMs: null, heldMs: 0, leftAt: null, measured: false };
    recent.push(hold);
    if (recent.length > RECENT_LIMIT) recent.shift();
    open.add(hold);
    if (open.size > OPEN_LIMIT) open.delete(open.values().next().value);
    const immediate = si(() => {
      const waited = now() - hold.at;
      // Only this hold's own time when nothing else wrapped started meanwhile
      // (otherwise the later hold's measurement owns it), and never past the
      // moment it settled: a tick that returned at once is not the one that held
      // the loop afterwards.
      let credit = seq === hold.seq ? waited : 0;
      if (hold.leftAt !== null) credit = Math.min(credit, hold.leftAt - hold.at);
      hold.heldMs = Math.max(hold.heldMs, credit, hold.syncMs || 0);
      hold.measured = true;
      if (hold.heldMs > thresholdMs) write(`keep serve: ${hold.name} held the loop ${Math.round(hold.heldMs)}ms\n`);
    });
    immediate?.unref?.();
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      hold.leftAt = now();
      open.delete(hold);
    };
    return { hold, leave };
  }

  // The public entry: returns leave(). Idempotent, so a wrapper can call it from
  // both a finally and an error path without double counting.
  function enter(name) {
    return begin(name).leave;
  }

  // Runs fn as one wrapped tick: the synchronous segment is timed exactly, and the
  // hold stays open until the returned promise settles.
  //
  // For a promise, the caller gets the chained promise back, not the original: it
  // settles the same way at the same time, and it is the only promise left whose
  // rejection can go unhandled. A rejection the caller drops still reaches
  // unhandledRejection exactly once (and crashes the daemon as it did before the
  // wrapper), and one the caller handles is not reported at all.
  function run(name, fn, ...args) {
    const { hold, leave } = begin(name);
    let result;
    try {
      result = fn(...args);
    } catch (error) {
      hold.syncMs = now() - hold.at;
      hold.heldMs = Math.max(hold.heldMs, hold.syncMs);
      leave();
      throw error;
    }
    hold.syncMs = now() - hold.at;
    hold.heldMs = Math.max(hold.heldMs, hold.syncMs);
    if (result && typeof result.then === 'function') {
      return result.then((value) => { leave(); return value; }, (error) => { leave(); throw error; });
    }
    leave();
    return result;
  }

  function wrap(name, fn) {
    return (...args) => run(name, fn, ...args);
  }

  // Who most likely held the loop between `since` (the probe's previous landing)
  // and `at` (this landing), given the probe was due at `due`. Returns
  // { name, likely } or null. In order:
  //   1. a measured hold that reached past `due` and accounts for at least half of
  //      the lateness: the direct evidence (likely: false);
  //   2. the most recently entered hold that was already open when the window
  //      started and still open at `due` - an async tick whose continuation may be
  //      the unmeasured part. A guess: a route waiting on a lock is open too;
  //   3. the most recently entered hold that started before `due` and was not
  //      measured short. Also a guess.
  // Null when none applies: naming a tick that demonstrably returned in a
  // millisecond, or one that only started after the stall, would be worse than
  // naming nothing.
  function attribute({ since, due, at }) {
    const lag = Math.max(0, at - due);
    const holds = [...new Set([...recent, ...open])].sort((a, b) => a.seq - b.seq);
    let best = null;
    for (const hold of holds) {
      if (hold.at > at || hold.at + hold.heldMs < due) continue;
      if (hold.heldMs < lag / 2) continue;
      if (!best || hold.heldMs > best.heldMs) best = hold;
    }
    if (best) return { name: best.name, likely: false };
    for (let index = holds.length - 1; index >= 0; index--) {
      const hold = holds[index];
      if (hold.at > since) continue;
      if (hold.leftAt === null || hold.leftAt >= due) return { name: hold.name, likely: true };
    }
    for (let index = holds.length - 1; index >= 0; index--) {
      const hold = holds[index];
      if (hold.at > due) continue;
      if (hold.at < since) break;
      // A hold that settled within the threshold cannot have held the loop longer.
      if (hold.leftAt !== null && hold.leftAt - hold.at <= thresholdMs) continue;
      if (hold.measured && hold.heldMs <= thresholdMs) continue;
      return { name: hold.name, likely: true };
    }
    return null;
  }

  return { enter, run, wrap, attribute, recent: () => recent.slice(), open: () => [...open] };
}

// The daemon's one tracker. Everything in the process shares it, so the probe
// sees every wrapped tick and route without being handed them.
const shared = createLoopHold();

module.exports = {
  createLoopHold,
  DEFAULT_THRESHOLD_MS,
  enter: shared.enter,
  run: shared.run,
  wrap: shared.wrap,
  attribute: shared.attribute,
  recent: shared.recent,
  shared,
};
