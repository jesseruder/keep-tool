'use strict';

// A normalized observation, not a second mutable registry. Conversation identity,
// physical process, foreground turn, background work and task state have separate
// lifetimes. Rebuild from current evidence; never feed a displayed label back in.
function normalize(session, context = {}) {
  const task = context.task?.fm || context.task || {};
  const runtime = session.runtime;
  const live = typeof context.live === 'boolean' ? context.live
    : runtime ? runtime.state === 'live' : Boolean(session.pane) && session.alive !== false;
  const ended = session.endedTurn === true || (session.endedTurn == null && session.notify?.type === 'complete');
  const model = {
    version: 1,
    identity: { conversationId: session.id || null, agent: session.kind || null, interactive: live, reviewer: Boolean(session.reviewer) },
    process: runtime || { state: session.exited || session.state === 'exited' ? 'exited'
      : session.deadMidTurn ? 'missing' : live ? 'live' : 'unknown', paneId: session.pane || null, pid: null },
    foreground: { state: session.toolRunning || session.endedTurn === false ? 'active' : ended ? 'stopped' : 'unknown',
      toolRunning: Boolean(session.toolRunning), wait: session.waitingFor || null,
      at: session.attentionAt || null, hook: session.lifecycleForeground || null },
    background: { pending: Boolean(session.pendingBackground),
      uncertain: (session.unknownBackgroundJobs || []).slice(0, 100),
      agents: (session.lifecycleAgents || []).slice(0, 100) },
    requests: { question: Boolean(session.pendingQuestion), async: Boolean(session.pendingQuestion?.async),
      plan: Boolean(session.pendingPlan), owner: Boolean(session.ownerQuestion), notification: session.notify?.type || null },
    task: { id: session.taskId || null, status: task.status || session.taskStatus || null,
      dependencies: context.dependencies || [], checkAfter: task.check_after || null, needs: Boolean(task.needs?.length),
      hasCheck: Boolean(task.check), scheduledBy: task.scheduled_by || null, scheduledAt: Date.parse(task.scheduled_at || '') || null,
      scheduledFor: task.scheduled_for || null, scheduledIntent: task.scheduled_intent || null },
  };
  model.conversation = require('./conversation-intent').resolve(session, model, context.now);
  return model;
}

function attachRuntime(sessions, panes = [], independentLive) {
  const bySession = new Map();
  for (const pane of panes) {
    const id = pane.meta?.sessionId;
    if (!id) continue;
    if (!bySession.has(id)) bySession.set(id, []);
    bySession.get(id).push(pane);
  }
  for (const session of sessions) {
    const matching = bySession.get(session.id) || [];
    const live = matching.filter((p) => p.alive && p.agentAlive !== false);
    // Stable choice in the rare case two panes resume one conversation. Identity
    // remains conversation-based; the physical instance is separately recorded.
    const selected = (live.length ? live : matching).slice().sort((a, b) =>
      String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(a.id).localeCompare(String(b.id)))[0];
    const exited = matching.some((p) => p.alive === false || p.agentAlive === false);
    session.runtime = { state: live.length ? 'live' : independentLive?.has(session.id) ? 'external'
      : exited ? 'exited' : session.deadMidTurn ? 'missing' : 'unknown',
      paneId: selected?.id || null, pid: selected?.pid || null,
      instance: selected ? `${selected.id}:${selected.pid}:${selected.createdAt || ''}` : null,
      observedAt: Date.parse(selected?.exitedAt || selected?.createdAt || '') || null,
      liveInstances: live.length };
    if (session.runtime.state === 'exited') session.exited = true;
  }
}

module.exports = { normalize, attachRuntime };
