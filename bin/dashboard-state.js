'use strict';

// The console only displays card histories in its notification inbox. Keep the
// full API shape for legacy/read-only clients and all internal safety decisions.
function compactState(state) {
  const cards = new Set((state.notifications || []).map(entry => entry.card).filter(Boolean));
  return {
    ...state,
    tasks: (state.tasks || []).map(task => {
      if (cards.has(task.id)) return task;
      const { body, ...summary } = task;
      return summary;
    }),
    sessions: (state.sessions || []).map(session => {
      const { backgroundJobs, ...summary } = session;
      return summary;
    }),
  };
}

function wantsCompactState(req, url) {
  if (url.searchParams.has('compact')) return url.searchParams.get('compact') === '1';
  // Already-open consoles retain their JS across daemon restarts. Their field
  // requirements are the same, so no window reload or PTY interruption is needed.
  // The legacy dashboard lives at / and keeps the full response.
  try { return /^\/app(?:\/|$)/.test(new URL(req.headers.referer).pathname); }
  catch { return false; }
}

function createJobChangeTracker() {
  const signatures = new Map();
  return (key, result) => {
    // Lock contention provides no new evidence about the last observed jobs.
    if (result.uncertain?.includes('ledger-busy')) return false;
    // Reconciliation timestamps and bytes read are bookkeeping, not a state
    // transition. Confidence changes and child-only completions still notify.
    const signature = JSON.stringify({
      pending: result.pending, uncertain: result.uncertain, recovering: result.recovering, gap: result.gap,
      jobs: (result.jobs || []).map(({ lastCorroboratedAt, ...job }) => job),
    });
    const changed = signatures.get(key) !== signature;
    signatures.set(key, signature);
    return changed;
  };
}
module.exports = { compactState, wantsCompactState, createJobChangeTracker };
