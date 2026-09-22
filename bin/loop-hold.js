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
//     delay also covers any other callback that ran in between, so it only counts
//     for this hold when no other wrapped hold was entered since. Unwrapped
//     callbacks can still slip in; that is the residual error, and why the probe
//     prefers the exact synchronous number when it has one.
//
// Either measurement over the threshold logs `keep serve: <name> held the loop Nms`
// once per tick, which catches a hold even when the probe's own timer happened to
// land inside it and so saw no lateness.

const DEFAULT_THRESHOLD_MS = 500;
// Enough recent holds to cover a stall window with a busy route mix; the ring
// bounds memory no matter how many ticks run.
const RECENT_LIMIT = 64;

function createLoopHold({
  now = Date.now,
  setImmediate: si = setImmediate,
  write = (line) => process.stderr.write(line),
  thresholdMs = DEFAULT_THRESHOLD_MS,
} = {}) {
  let seq = 0;
  const recent = [];

  function begin(name) {
    const hold = { name: String(name || 'unknown'), at: now(), seq: ++seq, syncMs: null, heldMs: 0, leftAt: 0, measured: false };
    recent.push(hold);
    if (recent.length > RECENT_LIMIT) recent.shift();
    const immediate = si(() => {
      const waited = now() - hold.at;
      // Only this hold's own time when nothing else wrapped started meanwhile;
      // otherwise the later hold's measurement owns that time.
      const attributable = seq === hold.seq ? waited : 0;
      hold.heldMs = Math.max(hold.heldMs, attributable, hold.syncMs || 0);
      hold.measured = true;
      if (hold.heldMs > thresholdMs) write(`keep serve: ${hold.name} held the loop ${Math.round(hold.heldMs)}ms\n`);
    });
    immediate?.unref?.();
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      hold.leftAt = now();
    };
    return { hold, leave };
  }

  // The public entry: returns leave(). Idempotent, so a wrapper can call it from
  // both a finally and an error path without double counting.
  function enter(name) {
    return begin(name).leave;
  }

  // Runs fn as one wrapped tick: the synchronous segment is timed exactly, and the
  // hold stays open until the returned promise settles. The result (or the throw)
  // is passed through untouched, so wrapping never changes what a caller sees.
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
      // Settling must not create an unhandled rejection of its own: the caller
      // still gets `result` and handles it exactly as before.
      result.then(leave, leave);
    } else leave();
    return result;
  }

  function wrap(name, fn) {
    return (...args) => run(name, fn, ...args);
  }

  // Who most likely held the loop between `since` (the probe's previous landing)
  // and `at` (this landing), given the probe was due at `due`. In order:
  //   1. a measured hold that reached past `due` and accounts for at least half of
  //      the lateness: the direct evidence;
  //   2. the most recently entered hold that was already open when the window
  //      started and still open at `due` - an async tick whose continuation may be
  //      the unmeasured part;
  //   3. the most recently entered hold in the window that was not measured short.
  // Null when none applies: naming a tick that demonstrably returned in a
  // millisecond would be worse than naming nothing.
  function attribute({ since, due, at }) {
    const lag = Math.max(0, at - due);
    let best = null;
    for (const hold of recent) {
      if (hold.at > at || hold.at + hold.heldMs < due) continue;
      if (hold.heldMs < lag / 2) continue;
      if (!best || hold.heldMs > best.heldMs) best = hold;
    }
    if (best) return best.name;
    for (let index = recent.length - 1; index >= 0; index--) {
      const hold = recent[index];
      if (hold.at > since) continue;
      if (hold.leftAt === 0 || hold.leftAt >= due) return hold.name;
    }
    for (let index = recent.length - 1; index >= 0; index--) {
      const hold = recent[index];
      if (hold.at > at) continue;
      if (hold.at < since) break;
      if (hold.measured && hold.heldMs <= thresholdMs) continue;
      return hold.name;
    }
    return null;
  }

  return { enter, run, wrap, attribute, recent: () => recent.slice() };
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
