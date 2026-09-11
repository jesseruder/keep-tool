'use strict';
const IDLE_MS = 8 * 3600e3;
const DEFAULT_DONE_IDLE_MS = 15 * 60e3;

function timeMs(value) {
  if (Number.isFinite(value)) return Number(value);
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function cardsForSession(tasks, sessionId) {
  return (tasks || []).filter((task) => (task.fm?.sessions || task.sessions || [])
    .some((entry) => entry?.id === sessionId));
}

// Both paths request a graceful exit only. Unknown activity is unsafe.
function refusal(session, pane, pinned, now = Date.now(), options = {}) {
  if (!session || !pane || !pane.alive || pane.meta?.sessionId !== session.id || pane.meta?.agent !== session.kind) return 'No matching live agent pane';
  if (options.restart) {
    const reason = require('./session-restart').refusal(session, pane);
    return reason || (!Number.isFinite(session.mtime) ? 'Session activity time is unknown' : null);
  }
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
  if ((!['idle', 'done'].includes(session.state) && !nextInstruction && !manualAttention && !manualScheduled) || session.endedTurn !== true || session.toolRunning || session.pendingBackground || session.unknownBackgroundJobs?.length || session.waitingFor || session.pendingQuestion || session.pendingPlan || session.rateLimit || (session.activity?.needsInput && !nextInstruction && !manualAttention)) return 'Session is active, waiting, needs input, or activity is unknown';
  if (!Number.isFinite(session.mtime)) return 'Session activity time is unknown';
  const idleMs = Number.isFinite(options.idleMs) ? options.idleMs : IDLE_MS;
  const activityAt = Math.max(session.mtime, Number(options.activityAt) || 0);
  const idleLabel = idleMs === IDLE_MS ? '8 hours' : `${Math.ceil(idleMs / 60e3)} minutes`;
  if (!options.manual && now - activityAt < idleMs) return `Session has activity within the last ${idleLabel}`;
  if (options.automatic && pane.attached !== 0) return 'Attached session or unknown viewer state is protected';
  const outputAt = timeMs(pane.lastOutputAt);
  if (options.automatic && (!Number.isFinite(outputAt) || now - outputAt < idleMs)) return 'Pane has recent or unknown output activity';
  const inputAt = timeMs(pane.lastInputAt);
  if (options.automatic && inputAt !== null && now - inputAt < idleMs) return 'Pane has recent input activity';
  const readAt = timeMs(pane.lastReadAt);
  if (options.requireRead && (readAt === null || readAt < outputAt)) return 'Pane has unread output';
  return null;
}

function doneClosePlan(session, pane, state, now = Date.now(), options = {}) {
  const tasks = state.allTasks || state.tasks || [];
  const cards = cardsForSession(tasks, session?.id);
  if (!cards.length) return { reason: 'Session is not linked to a card', cards: [] };
  if (cards.some((task) => (task.fm || task).status !== 'done')) {
    return { reason: 'Session is linked to a card that is not done', cards };
  }
  if ((state.companion?.jobs || []).some((job) => [job?.sessionId, job?.session_id, job?.ownerSessionId]
    .includes(session.id) && ['queued', 'running'].includes(job.status))) {
    return { reason: 'Session has a running Codex companion job', cards };
  }
  const legacyDoneAt = options.legacyDoneAt || (() => now);
  const doneTimes = cards.map((task) => {
    const fm = task.fm || task;
    const exact = timeMs(fm.done_at);
    if (exact !== null) return exact;
    const observed = Number(legacyDoneAt(task));
    const updated = timeMs(fm.updated) || 0;
    return Math.max(Number.isFinite(observed) ? observed : now, updated);
  });
  const activity = [session?.mtime, pane?.lastInputAt, pane?.lastOutputAt, pane?.lastActivityAt]
    .map(timeMs).filter((value) => value !== null);
  const sinceAt = Math.max(...doneTimes, ...activity);
  const idleMs = Number.isFinite(options.idleMs) ? options.idleMs : DEFAULT_DONE_IDLE_MS;
  const reason = refusal(session, pane, state.pinned || new Set(), now, {
    automatic: true, done: true, idleMs, activityAt: sinceAt, requireRead: true,
  });
  return {
    reason,
    cards,
    sinceAt,
    idleMinutes: Math.max(0, Math.floor((now - sinceAt) / 60e3)),
  };
}

// At most one pass at a time, and one attempt per session per hour. Refusals
// remain cheap on subsequent ticks; the close function rechecks everything.
function startScheduler({ snapshot, close, closeShell, record, onError = () => {}, now = Date.now,
  intervalMs = 5 * 60e3, doneIdleMs = DEFAULT_DONE_IDLE_MS }) {
  const attempted = new Map();
  const legacyDoneObserved = new Map();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const state = await snapshot();
      const ids = new Set([...state.sessions.map((s) => s.id), ...state.panes.map(p => `shell:${p.id}`)]);
      for (const id of attempted.keys()) if (!ids.has(id)) attempted.delete(id);
      for (const session of state.sessions) {
        const pane = state.panes.find((p) => p.id === session.pane);
        const at = now();
        const plan = doneClosePlan(session, pane, state, at, {
          idleMs: doneIdleMs,
          legacyDoneAt: (task) => {
            if (!legacyDoneObserved.has(task.id)) legacyDoneObserved.set(task.id, at);
            return legacyDoneObserved.get(task.id);
          },
        });
        if (plan.reason) continue;
        if (attempted.has(session.id) && now() - attempted.get(session.id) < 3600e3) continue;
        attempted.set(session.id, now());
        let outcome;
        try {
          await close({
            sessionId: session.id,
            pane: pane.id,
            cardIds: plan.cards.map((task) => task.id),
            idleMinutes: plan.idleMinutes,
            doneIdleMs,
            legacyDoneAt: Object.fromEntries(plan.cards.filter((task) => !timeMs((task.fm || task).done_at))
              .map((task) => [task.id, legacyDoneObserved.get(task.id)])),
          });
          outcome = 'closed after done';
        }
        catch (error) { outcome = `not closed: ${error.message}`; }
        await record({ at: now(), sessionId: session.id, pane: pane.id, outcome });
      }
      if (closeShell) for (const pane of state.panes) {
        if (require('./shell-cleanup').refusal(pane, state, now())) continue;
        const key = `shell:${pane.id}`;
        if (attempted.has(key) && now() - attempted.get(key) < 3600e3) continue;
        attempted.set(key, now());
        let outcome;
        try { await closeShell(pane); outcome = 'shell exit requested'; }
        catch (error) { outcome = `shell not closed: ${error.message}`; }
        await record({ at: now(), sessionId: pane.meta?.sessionId || null, pane: pane.id, outcome });
      }
    } catch (error) { onError(error); }
    finally { busy = false; }
  };
  // No startup burst: give hosts, viewers and schedulers time to reconnect.
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}

module.exports = { refusal, doneClosePlan, startScheduler, IDLE_MS, DEFAULT_DONE_IDLE_MS };
