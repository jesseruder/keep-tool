'use strict';

// Everything that reaches the parser, in the order it was meant to arrive.
//
// xterm's write queue is asynchronous: `write()` returns long before the bytes have
// been parsed. A resize is not — it changes the buffer the moment it is called. So a
// resize applied the instant a pane frame reports one can overtake bytes that are
// still sitting in the queue, and those bytes are then laid out at a geometry they
// were never written for: a progress bar drawn for 169 columns wraps at 80, and the
// screen stays wrong until something redraws it.
//
// This puts the two on one line. A write is queued, and the next thing waits for it
// to be parsed; a resize drains everything ahead of it first, then applies, then the
// consumer is told to rebuild what it derived from the old geometry.

function createTerminalStream(options = {}) {
  const { emulator, onParsed, onResized } = options;
  if (!emulator) throw new Error('createTerminalStream needs an emulator');
  let tail = Promise.resolve();
  let disposed = false;

  // Each step runs after the one before it, whether that one settled or threw: a
  // failed write must not strand every frame behind it.
  const chain = (task) => {
    const next = tail.then(
      () => (disposed ? undefined : task()),
      () => (disposed ? undefined : task()),
    );
    tail = next.then(() => {}, () => {});
    return next;
  };

  return {
    write(data) {
      return chain(() => new Promise((resolve) => {
        // A disposed emulator's write never calls back, which would strand the line.
        if (disposed) { resolve(); return; }
        emulator.write(data, () => {
          if (!disposed && onParsed) onParsed();
          resolve();
        });
      }));
    },

    // The observer adopting the pane's geometry. Nothing written before this point is
    // laid out at the new size, and nothing written after it at the old one.
    resize(cols, rows) {
      return chain(() => Promise.resolve(emulator.drain()).then(() => {
        if (disposed) return;
        emulator.resize(cols, rows);
        if (onResized) onResized(cols, rows);
      }));
    },

    // Resolves when everything queued so far has been applied.
    idle() { return tail; },

    dispose() { disposed = true; },
  };
}

module.exports = { createTerminalStream };
