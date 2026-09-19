'use strict';

// Terminal bytes arrive in whatever shape the network chose: a spinner is a few
// bytes sixty times a second, a build log is kilobytes at once. Neither rate is a
// frame rate, so the screen is repainted on a clock of its own and the rows that
// changed in between are coalesced.
//
// This module is the clock and the coalescing, with no React and no emulator in it,
// so the awkward parts — a burst that spans the interval, a resize landing between
// two byte flushes, a flush arriving after the screen is gone — can be tested as
// plain calls. The consumer supplies `onFlush({ rows, full })` and does the drawing.
//
// The first invalidation after a quiet period paints immediately (a keystroke's echo
// must not wait 33 ms to appear); anything that follows within the interval is held
// until the interval is up and then painted once. That is a leading-edge throttle,
// which is what a terminal renderer wants and what xterm's own renderer does.

const DEFAULT_INTERVAL_MS = 33; // ~30 fps, the rate the mobile plan settled on

function createRenderQueue(options = {}) {
  const {
    onFlush,
    intervalMs = DEFAULT_INTERVAL_MS,
  } = options;
  if (typeof onFlush !== 'function') throw new Error('createRenderQueue needs an onFlush');
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const now = options.now || (() => Date.now());

  let rows = new Set();
  let full = false;
  let timer = null;
  let lastFlushAt = -Infinity;
  let disposed = false;

  const deliver = () => {
    const payload = full
      ? { rows: [], full: true }
      : { rows: [...rows].sort((a, b) => a - b), full: false };
    rows = new Set();
    full = false;
    lastFlushAt = now();
    onFlush(payload);
  };

  const schedule = () => {
    if (timer !== null || disposed) return;
    const waited = now() - lastFlushAt;
    if (waited >= intervalMs) { deliver(); return; }
    timer = setTimer(() => {
      timer = null;
      if (disposed) return;
      // A trailing timer can outlive the work that scheduled it, when a forced
      // flush already drained the queue. Painting an empty frame is harmless but
      // pointless, and in React it is a state update for nothing.
      if (!full && rows.size === 0) { lastFlushAt = now(); return; }
      deliver();
    }, intervalMs - waited);
  };

  return {
    // `next` is the emulator's dirty row list. An empty list still schedules, since
    // the cursor can move without any row's contents changing.
    invalidate(next) {
      if (disposed) return;
      // Once the frame is a full redraw there is nothing a row index can add to it.
      if (full) { schedule(); return; }
      if (Array.isArray(next)) for (const row of next) rows.add(row | 0);
      else if (Number.isInteger(next)) rows.add(next);
      schedule();
    },

    // A resize, an alternate-screen switch or the end of a replay: the previous row
    // list describes a screen that no longer exists, so it is dropped rather than
    // merged, and the consumer is told to redraw everything.
    invalidateAll() {
      if (disposed) return;
      full = true;
      rows = new Set();
      schedule();
    },

    // Paint now, whatever the clock says — the consumer uses this when it must be
    // certain the next read sees the current screen (the end of a replay, going to
    // the foreground). A flush with nothing pending is a no-op.
    flush() {
      if (disposed) return false;
      if (!full && rows.size === 0) return false;
      if (timer !== null) { clearTimer(timer); timer = null; }
      deliver();
      return true;
    },

    pending() {
      return { rows: [...rows].sort((a, b) => a - b), full, scheduled: timer !== null };
    },

    dispose() {
      disposed = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
      rows = new Set();
      full = false;
    },
  };
}

module.exports = { createRenderQueue, DEFAULT_INTERVAL_MS };
