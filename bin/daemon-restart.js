'use strict';

// Admission is synchronous: no new compaction can start between checking that none is
// in flight and reserving a daemon shutdown. A pending model restore is not a reason to
// refuse: its record is durable, and the next daemon's restore pass picks it up exactly
// as this one would. Only a compaction or restore that is typing into a pane right now is.
function createGate({ busy = () => false } = {}) {
  let active = 0, stopping = false;
  return {
    get stopping() { return stopping; },
    enter() {
      if (stopping) throw Error('Daemon restart is pending; compaction is paused');
      active++;
      let released = false;
      return () => { if (!released) { released = true; active--; } };
    },
    prepare() {
      if (active || busy()) {
        const error = Error('Compaction or model restoration is in flight; retry when it finishes');
        error.inFlight = true;
        throw error;
      }
      stopping = true;
      return { ok: true, pid: process.pid };
    },
    // The same admission, waiting out a compaction or restore that is mid-input instead
    // of handing the refusal back to whoever asked for the restart.
    async prepareWhenIdle({ timeoutMs = 60e3, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now } = {}) {
      const deadline = now() + timeoutMs;
      for (;;) {
        try { return this.prepare(); } catch (error) {
          if (!error.inFlight || now() >= deadline) throw error;
          await sleep(500);
        }
      }
    },
  };
}
module.exports = { createGate };
