'use strict';

// This runs in the daemon, independent of open browser tabs. getSummary owns
// caching, deduplication, the bounded worker queue and failure backoff.
function createWarmer({ snapshot, prepare, onError = () => {} }) {
  const prepared = new Map();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const state = await snapshot();
      const live = new Set((state.panes || []).filter((p) => p.alive).map((p) => p.meta?.sessionId));
      const sessions = state.sessions || [];
      const ids = new Set(sessions.map((s) => s.id));
      for (const id of prepared.keys()) if (!ids.has(id)) prepared.delete(id);
      const eligible = sessions.filter((s) => live.has(s.id) && !s.reviewer && !s.exited
        && (s.endedTurn === true || s.activity?.needsInput));
      eligible.sort((a, b) => Number(Boolean(b.activity?.needsInput)) - Number(Boolean(a.activity?.needsInput)) || b.mtime - a.mtime);
      for (const session of eligible) {
        if (prepared.has(session.id) && prepared.get(session.id) === session.mtime) continue;
        try {
          const result = await prepare(session, { priority: session.activity?.needsInput ? 0 : 2 });
          if (result?.fresh) prepared.set(session.id, session.mtime);
        } catch (error) { onError(error); }
      }
    } catch (error) { onError(error); }
    finally { busy = false; }
  };
  return { tick };
}

function startScheduler(options) {
  const warmer = createWarmer(options);
  void warmer.tick();
  const timer = setInterval(warmer.tick, 10000);
  timer.unref();
  return { ...warmer, stop: () => clearInterval(timer) };
}

module.exports = { createWarmer, startScheduler };
