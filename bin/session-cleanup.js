'use strict';

// Both paths request a graceful exit only. Unknown activity is unsafe.
function refusal(session, pane, pinned, now = Date.now(), options = {}) {
  if (!session || !pane || !pane.alive || pane.meta?.sessionId !== session.id || pane.meta?.agent !== session.kind) return 'No matching live agent pane';
  if (session.reviewer) return 'Fleet reviewer is protected';
  if (!options.manual && pinned.has(pane.id)) return 'Pinned session is protected; unpin it first';
  const nextInstruction = session.state === 'needs-input' && session.activity?.reason === 'next instruction';
  const manualScheduled = options.manual && session.state === 'waiting' && session.activity?.label === 'Waiting: scheduled check';
  // Card reviews and prose follow-up questions are not terminal dialogs.
  // Explicit Close preserves their history; unattended cleanup protects them.
  const manualAttention = options.manual && session.state === 'needs-input' && (
    session.activity?.reason === 'your review' ||
    (session.activity?.reason === 'question' && session.activity?.request?.kind === 'input')
  );
  if ((!['idle', 'done'].includes(session.state) && !nextInstruction && !manualAttention && !manualScheduled) || session.endedTurn !== true || session.toolRunning || session.pendingBackground || session.waitingFor || session.pendingQuestion || session.pendingPlan || session.rateLimit || (session.activity?.needsInput && !nextInstruction && !manualAttention)) return 'Session is active, waiting, needs input, or activity is unknown';
  if (!Number.isFinite(session.mtime)) return 'Session activity time is unknown';
  if (!options.manual && now - session.mtime < 24 * 3600e3) return 'Session has activity within the last 24 hours';
  if (options.automatic && pane.attached !== 0) return 'Attached session or unknown viewer state is protected';
  if (options.automatic && (!Number.isFinite(Date.parse(pane.lastOutputAt)) || now - Date.parse(pane.lastOutputAt) < 24 * 3600e3)) return 'Pane has recent or unknown output activity';
  return null;
}

// At most one pass at a time, and one attempt per session per hour. Refusals
// remain cheap on subsequent ticks; the close function rechecks everything.
function startScheduler({ snapshot, close, record, onError = () => {}, now = Date.now, intervalMs = 5 * 60e3 }) {
  const attempted = new Map();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const state = await snapshot();
      const ids = new Set(state.sessions.map((s) => s.id));
      for (const id of attempted.keys()) if (!ids.has(id)) attempted.delete(id);
      for (const session of state.sessions) {
        const pane = state.panes.find((p) => p.id === session.pane);
        if (refusal(session, pane, state.pinned, now(), { automatic: true })) continue;
        if (attempted.has(session.id) && now() - attempted.get(session.id) < 3600e3) continue;
        attempted.set(session.id, now());
        let outcome;
        try { await close({ sessionId: session.id, pane: pane.id }); outcome = 'exit requested'; }
        catch (error) { outcome = `not closed: ${error.message}`; }
        await record({ at: now(), sessionId: session.id, pane: pane.id, outcome });
      }
    } catch (error) { onError(error); }
    finally { busy = false; }
  };
  // No startup burst: give hosts, viewers and schedulers time to reconnect.
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}

module.exports = { refusal, startScheduler };
