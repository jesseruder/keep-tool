'use strict';

// The rows above the screen, mirrored out of the emulator so they can be mounted as
// native views without re-reading the whole buffer every frame.
//
// A line that has scrolled off the top normally never changes again, which is what
// makes collecting them cheap: read each one once, as it goes past. Three things
// break that promise, and each has to be handled rather than assumed away.
//
// - The buffer fills up. Past its limit it drops its oldest line for every new one,
//   so the collection stops being contiguous with the screen. From there the mounted
//   window is read straight from the buffer instead, and the rows are a window onto
//   something sliding, not a record of what went past.
// - The pane is resized. xterm reflows: lines re-wrap, and they move between the
//   viewport and the scrollback in both directions, so `baseY` can fall as well as
//   rise and every row already collected was laid out at a width that is gone. The
//   only correct answer is to throw the collection away and read the buffer again.
// - The screen is replayed. A replay opens with a reset, so the buffer starts over.
//
// The mirror answers all three the same way: when what it holds cannot be reconciled
// with what the buffer says, it rebuilds from the buffer.

const DEFAULT_PAGE = 300;
const DEFAULT_MAX = 10000;

function createScrollbackMirror(options = {}) {
  const page = Number.isInteger(options.page) && options.page > 0 ? options.page : DEFAULT_PAGE;
  const max = Number.isInteger(options.max) && options.max > 0 ? options.max : DEFAULT_MAX;

  // `seq` is how many lines the buffer had put above the screen before the first row
  // held here, so `seq + rows.length` is what the mirror believes the buffer's
  // scrollback length to be. Keys are that same number, which makes them stable
  // across appends — except while sliding, when no row keeps its place.
  let seq = 0;
  let rows = [];
  let sliding = false;
  // A resize declared while a full-screen program is running. The alternate screen has
  // no scrollback of its own, so there is nothing to rebuild from at the time — but
  // xterm reflows the normal buffer underneath it all the same, and the rows held here
  // are already wrong. Widening leaves no trace to notice later (the buffer's length
  // does not fall), so the request is remembered rather than dropped.
  let pendingRebuild = false;

  const rebuild = (emulator, window, length, saturated) => {
    const want = Math.max(page, Number(window) || 0);
    const read = emulator.scrollbackRows(want, want);
    const first = Math.max(0, length - read.length);
    rows = read.map((row, index) => ({
      key: saturated ? `sbw:${index}` : `sb:${first + index}`,
      row,
    }));
    seq = first;
    sliding = saturated;
    return rows;
  };

  return {
    rows() { return rows; },
    // What the mirror believes the buffer's scrollback length is; only meaningful
    // against the emulator's own, which is the point of comparing them.
    length() { return seq + rows.length; },
    sliding() { return sliding; },

    reset() {
      seq = 0;
      rows = [];
      sliding = false;
      pendingRebuild = false;
      return rows;
    },

    // Returns the rows to mount when they changed, and null when nothing did, so the
    // caller can leave its state alone rather than re-rendering an identical list.
    // `options.rebuild` is the geometry change: the caller knows the buffer was
    // reflowed and that nothing held here survived it.
    sync(emulator, window, syncOptions = {}) {
      if (syncOptions.rebuild) pendingRebuild = true;
      if (emulator.isAlternate()) return null;
      const { length, saturated } = emulator.normalScrollback();
      // Sliding, reflowed, or a buffer that is somehow shorter than what is held
      // (a reset, or a reflow that moved lines back onto the screen): read it again.
      if (saturated || pendingRebuild || length < seq + rows.length) {
        pendingRebuild = false;
        return rebuild(emulator, window, length, saturated);
      }
      if (sliding) {
        // Back under the limit, which only a reset does; start collecting again.
        seq = 0;
        rows = [];
        sliding = false;
      }
      const grown = length - (seq + rows.length);
      if (grown <= 0) return null;
      const added = emulator.scrollbackRows(grown, grown).map((row, index) => ({
        key: `sb:${seq + rows.length + index}`,
        row,
      }));
      rows = [...rows, ...added];
      if (rows.length > max) {
        const dropped = rows.length - max;
        rows = rows.slice(dropped);
        seq += dropped;
      }
      return rows;
    },
  };
}

module.exports = { createScrollbackMirror, DEFAULT_MAX, DEFAULT_PAGE };
