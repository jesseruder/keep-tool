// Local pending operations survive stale state snapshots. A completed close is
// retired only once the backend observes exit (or a different process identity).
export function createClosingSessions() {
  const entries = new Map();
  return {
    has(sessionId, pane) { return [...entries.values()].some(e => e.sessionId === sessionId || pane && e.pane === pane); },
    begin(sessionId, pane, pid) {
      if (this.has(sessionId, pane)) return false;
      entries.set(sessionId, { sessionId, pane, pid, confirmed: false });
      return true;
    },
    confirm(sessionId) { const entry = entries.get(sessionId); if (entry) entry.confirmed = true; },
    cancel(sessionId) { entries.delete(sessionId); },
    reconcile(data) {
      for (const [id, entry] of entries) {
        if (!entry.confirmed) continue;
        const pane = data.panes?.find(p => p.id === entry.pane);
        const session = data.sessions?.find(s => s.id === id);
        if (pane?.alive === false || !pane && (!session || session.exited || session.state === 'exited')
            || pane && entry.pid && pane.pid && pane.pid !== entry.pid
            || session?.pane && session.pane !== entry.pane) entries.delete(id);
      }
    },
  };
}
