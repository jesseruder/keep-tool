'use strict';
// Intent is turn-scoped. A task's durable obligations are not a conversation's
// reason for stopping. Prose is only a hint and never invents a dependency.
function stopHint(text) {
  const value = String(text || '').replace(/```[\s\S]*?```/g, '').replace(/^\s*>.*$/gm, '').trim();
  if (require('./session-status').proseRequest(value)) return 'needs-input';
  if (/\b(?:I will continue|continuing) after (?:the )?(?:job|build|review|deploy|test)\b/i.test(value)) return 'waiting';
  if (/^(?:still (?:in review|pending|waiting)|no (?:change|update)(?: yet)?)[\s.,!—-]/i.test(value)) return 'waiting';
  if (/(?:^|[.!?]\s+|\n)(?:I(?:'m| am) )?[Ii]dling until (?:the )?next (?:scheduled )?(?:tick|check|poll)\b/.test(value)) return 'waiting';
  if (/(?:^|[.!?]\s+|\n)(?:[-*]\s+)?(?:I(?:'m| am|'ll| will)?|we(?:'re| are|'ll| will)?|still|now)?\s*(?:waiting (?:on|for)|awaiting|blocked (?:on|by)|(?:keep |continue )?(?:watching|monitoring|polling)|wait for|check again)\b/i.test(value)) return 'waiting';
  if (/(?:^|[.!?]\s+|\n)Nothing (?:else )?(?:needed|required) from you until\b/i.test(value)) return 'waiting';
  return 'unknown';
}
function resolve(session, model, now = Date.now()) {
  const observedTurn = Math.max(session.turnStartedAt || 0, session.backgroundJobs?.caughtUp === true ? session.backgroundJobs.turnStartedAt || 0 : 0);
  const turnAt = Math.max(observedTurn, session.lastUserAt || 0, session.lifecycleTurnAt || 0, model.process.observedAt || 0);
  const task = model.task;
  const handoff = observedTurn > 0 && task.scheduledAt >= turnAt && task.scheduledAt <= now
    && task.scheduledBy === model.identity.conversationId && task.checkAfter && task.hasCheck
    && task.scheduledFor === task.checkAfter && task.status !== 'done'
    && ['waiting', 'needs-input'].includes(task.scheduledIntent) ? task.scheduledIntent : null;
  const hook = ['waiting', 'needs-input'].includes(session.lifecycleStop?.intent)
    && session.lifecycleStop.at >= Math.max(session.lastUserAt || 0, session.attentionAt || 0) ? session.lifecycleStop : null;
  const prose = session.askedProse && !model.background.pending ? 'needs-input' : stopHint(session.lastAssistantFull || session.lastAssistant);
  const hint = handoff === 'needs-input' || hook?.intent === 'needs-input' || prose === 'needs-input' ? 'needs-input' : handoff || (hook && hook.at >= (session.lastUserAt || 0) ? hook.intent
    : prose);
  const jobs = (session.backgroundJobs?.jobs || []).filter(j => j.status === 'pending');
  const jobInstance = Object.hasOwn(model.process, 'jobInstance') ? model.process.jobInstance : model.process.instance;
  const scheduled = jobs.filter(j => model.process.state === 'live' && j.kind === 'scheduled' && j.recurring === true && j.instance && j.instance === jobInstance && j.expiresAt > now);
  const currentJobs = jobs.filter(j => j.kind !== 'service' && j.kind !== 'scheduled'
    && (!session.lastUserAt || j.startedAt >= session.lastUserAt));
  const concrete = model.background.pending || model.background.uncertain.length || model.background.agents.length || scheduled.length
    || model.task.dependencies.length || model.task.checkAfter;
  const intentional = hint === 'waiting' && Boolean(concrete);
  // Legacy adapters without job identities still provide bounded live-job evidence.
  const jobWait = model.background.pending && (!session.backgroundJobs || session.backgroundJobs.caughtUp !== true || currentJobs.length > 0);
  return { hint, waiting: intentional || (hint !== 'needs-input' && jobWait),
    reason: handoff === 'waiting' ? 'scheduled check' : intentional && scheduled.length ? 'scheduled check' : intentional && model.task.dependencies.length ? 'dependency'
      : intentional && model.task.checkAfter ? 'scheduled check' : model.background.agents.length ? 'subagent' : require('./session-status').waitReason(session.lastAssistantFull || session.lastAssistant),
    scheduled: scheduled.map(j => ({ id: j.id, expiresAt: j.expiresAt })),
    handoff: handoff ? { taskId: task.id, checkAfter: task.checkAfter, at: task.scheduledAt, intent: handoff } : null,
    source: handoff && hint === handoff ? 'registry' : hook ? 'hook' : 'conversation', confidence: handoff && hint === handoff ? 'observed' : 'inferred' };
}
module.exports = { stopHint, resolve };
