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
  // How the step in flight is ended from outside. A disposed emulator answers no
  // callbacks at all, so without this the step it was in the middle of would never
  // settle: `idle()` would wait forever and the whole line — every queued frame and
  // the closures it holds — would stay alive behind an unmounted screen.
  let settleCurrent = null;

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

  // The step's promise, with its resolver parked where dispose() can reach it. `run`
  // is handed a `finish` that settles the step exactly once and clears the parking
  // spot, so a callback arriving after disposal is a no-op rather than a second
  // settle of someone else's step.
  const step = (run) => new Promise((resolve) => {
    if (disposed) { resolve(); return; }
    let done = false;
    const finish = () => {
      if (done) return false;
      done = true;
      if (settleCurrent === finish) settleCurrent = null;
      resolve();
      return true;
    };
    settleCurrent = finish;
    run(finish);
  });

  return {
    write(data) {
      return chain(() => step((finish) => {
        emulator.write(data, () => {
          const first = finish();
          if (first && !disposed && onParsed) onParsed();
        });
      }));
    },

    // The observer adopting the pane's geometry. Nothing written before this point is
    // laid out at the new size, and nothing written after it at the old one.
    resize(cols, rows) {
      return chain(() => step((finish) => {
        const applied = () => {
          if (disposed) { finish(); return; }
          emulator.resize(cols, rows);
          const first = finish();
          if (first && onResized) onResized(cols, rows);
        };
        Promise.resolve(emulator.drain()).then(applied, applied);
      }));
    },

    // Resolves when everything queued so far has been applied — or, after disposal,
    // as soon as the line has unwound.
    idle() { return tail; },

    dispose() {
      disposed = true;
      const settle = settleCurrent;
      settleCurrent = null;
      if (settle) settle();
    },
  };
}

module.exports = { createTerminalStream };
