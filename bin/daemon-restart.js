'use strict';

// Admission is synchronous: no new compaction can start between checking the
// durable restore records and reserving a daemon shutdown.
function createGate({ pending = () => [], busy = () => false } = {}) {
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
      if (active || busy()) throw Error('Compaction or model restoration is in flight; retry when it finishes');
      const records = pending();
      if (records.length) throw Error(`Pending model restoration prevents daemon restart (${records.length} record(s))`);
      stopping = true;
      return { ok: true, pid: process.pid };
    },
  };
}
module.exports = { createGate };
