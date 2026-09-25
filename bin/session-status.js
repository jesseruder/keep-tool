'use strict';

// Dashboard activity is independent of whether a process exists, a turn ended,
// or a completion notification is unread. Triage includes explicit requests and
// live, stopped sessions that need the next instruction.
function waitReason(text) {
  const value = String(text || '');
  if (/\b(lock|mutex|semaphore|flock)\b/i.test(value)) return 'lock';
  if (/\b(review|reviewer|reviews)\b/i.test(value)) return 'review';
  if (/\b(deploy\w*|rollout|bake|AMI|instance refresh)\b/i.test(value)) return 'deploy';
  return 'background work';
}

function toolWaitReason(name, input = {}) {
  input = input || {};
  const command = String(input.command || input.cmd || input.code || '');
  const text = `${name} ${command} ${input.description || ''}`;
  if (/wait_agent|wait_for|wait_tool|(?:^|[_.])wait$|(?:^|[_.])sleep$|^TaskOutput$|^AgentOutputTool$/i.test(name)
      || /\b(?:keep\s+(?:wait|step\b[^\n]*--wait)|flock|sleep)\b/.test(command)) return waitReason(text);
  return null;
}

function proseRequest(text) {
  // A bare idle prompt/completion is not a request. Recognize a final question
  // and direct requests for Owner to supply/approve something, in either agent.
  const value = String(text || '').replace(/```[\s\S]*?```/g, '').replace(/^\s*>.*$/gm, '').trim().replace(/[\s*_`]+$/, '');
  return /\?\s*$/.test(value)
    || /(?:^|[.!?]\s+|\n)(?:[-*]\s+)?(?:please\s+(?:choose|confirm|approve|provide|send|tell|enter)|I need (?:you to|your\b)|(?:send|give|tell|show)\s+me\b|(?:share|provide|paste)\s+(?:the|your)\s+(?:url|link|key|token|code|answer|choice)\b|let me know\s+(?:which|what|where|when|whether|your)\b|reply with\b)/i.test(value);
}

function activity(session, context = {}) {
  const model = require('./session-model').normalize(session, context);
  const candidates = [];
  const add = (when, rule, source, state, label, reason = null, request = null, confidence = 'observed',
    at = ['transcript', 'background', 'prose', 'conversation'].includes(source) ? model.foreground.at : null) => {
    if (when) candidates.push({ rule, source, state, label, reason, request, confidence, at });
  };
  // Ordered policy over independent facts. Keep every applicable candidate so
  // an unexpected decision can be explained without logging conversation text.
  const processExited = session.exited || session.state === 'exited' || model.process.state === 'exited';
  add(processExited && session.retirement?.automatic !== true,
    'process-exited', 'process', 'exited', 'Exited', null, null, 'observed', model.process.observedAt || null);
  add(session.deadMidTurn, 'process-missing', 'process', 'inactive', 'Inactive', 'process no longer detected');
  const notify = session.notify || {};
  add(notify.type === 'permission', 'permission-notification', 'notification', 'needs-input', 'Needs input', 'permission', { kind: 'permission', detail: notify.message });
  const foreground = model.foreground.hook;
  add(model.requests.async && ['running', 'waiting'].includes(foreground?.state)
      && foreground.reason !== 'turn started', 'async-question', 'transcript', 'needs-input', 'Needs input', 'question', {
    kind: 'question', question: session.pendingQuestion?.question, options: session.pendingQuestion?.options,
  });
  add(foreground?.state === 'running', 'foreground-hook', 'hook', 'running', 'Running', foreground?.reason, null, 'observed', foreground?.at);
  add(foreground?.state === 'waiting', 'foreground-wait-hook', 'hook', 'waiting', `Waiting: ${foreground?.reason}`, foreground?.reason, null, 'observed', foreground?.at);
  add(foreground?.state === 'needs-input', 'permission-hook', 'hook', 'needs-input', 'Needs input', 'permission', { kind: 'permission' }, 'observed', foreground?.at);
  add(model.requests.question, 'pending-question', 'transcript', 'needs-input', 'Needs input', 'question', {
    kind: 'question', question: session.pendingQuestion?.question, options: session.pendingQuestion?.options,
  });
  add(model.requests.plan, 'pending-plan', 'transcript', 'needs-input', 'Needs input', 'plan approval', { kind: 'plan' });
  add(notify.type === 'question', 'question-notification', 'notification', 'needs-input', 'Needs input', 'question', {
    kind: 'question', question: notify.message, options: notify.options,
  });
  add(session.rateLimit, 'rate-limit', 'transcript', 'waiting', 'Waiting: rate limit', 'rate limit');
  const text = session.lastAssistantFull || session.lastAssistant || '';
  const ended = session.endedTurn === true || (session.endedTurn == null && notify.type === 'complete');
  add(model.foreground.wait, 'foreground-wait', 'transcript', 'waiting', `Waiting: ${model.foreground.wait}`, model.foreground.wait);
  add(model.foreground.state === 'active', 'foreground-active', 'transcript', 'running', 'Running');
  const waiting = text.match(/\b(?:waiting (?:on|for)|awaiting|blocked (?:on|by))\b[^.!?\n]*/i)?.[0];
  const reason = model.background.agents.length ? 'subagent' : waitReason(waiting);
  add(ended && model.conversation.handoff?.intent === 'needs-input', 'handoff-input', 'registry', 'needs-input', 'Needs input', 'question', { kind: 'input', detail: 'Ready for your decision.' }, 'observed', model.conversation.handoff?.at);
  const task = context.task?.fm || context.task || {};
  const taskStatus = model.task.status;
  // The turn-end model verdict (bin/stop-classifier.js) outranks the prose rules and
  // tracked-job waits below, but not a stop intent a hook or card handoff declared.
  // It sees only the message, so it cannot hide the card's own review or needs, and
  // cannot pull a session out of a scheduled or dependency wait it does not see.
  const verdict = ended && model.identity.interactive && !model.identity.reviewer
    && !['hook', 'registry'].includes(model.conversation.source) ? session.stopVerdict : null;
  const cardAsks = taskStatus === 'review' || (taskStatus !== 'done' && model.task.needs);
  const durableWait = model.conversation.waiting && ['scheduled check', 'dependency'].includes(model.conversation.reason);
  const heldReason = verdict?.verdict === 'pending' ? 'classifying' : verdict?.reason || 'background work';
  add(['running', 'pending'].includes(verdict?.verdict) && !cardAsks, 'model-running', 'model', 'waiting', `Waiting: ${heldReason}`, heldReason, null,
    verdict?.verdict === 'pending' ? 'uncertain' : 'inferred');
  const asks = model.conversation.hint === 'needs-input';
  // The agent's own words stay the row's (and a push's) detail when it asked something.
  add(verdict?.verdict === 'needs-input' && !durableWait && !cardAsks, 'model-needs-input', 'model', 'needs-input', asks ? 'Needs an answer' : 'Ready for next instruction',
    asks ? 'question' : 'next instruction', { kind: 'input', detail: asks ? text : verdict?.reason || 'Ready for your next instruction.' }, 'inferred');
  add(ended && model.conversation.hint === 'needs-input', 'prose-request', 'prose', 'needs-input', 'Needs an answer', 'question', { kind: 'input', detail: text }, 'inferred');
  add(model.conversation.waiting, 'conversation-wait', model.conversation.source, 'waiting', `Waiting: ${model.conversation.reason}`, model.conversation.reason, null, model.conversation.confidence, model.conversation.handoff?.at ?? model.foreground.at);
  add(!model.identity.interactive && model.background.pending, 'background-pending', 'background', 'waiting', `Waiting: ${reason}`, reason);
  add(taskStatus !== 'done' && model.task.needs, 'task-needs', 'registry', 'needs-input', 'Needs input', 'requested input', { kind: 'input', detail: (task.needs || []).map((need) => need.text).filter(Boolean).join('\n') });
  // A session Keep opened for a program (a check, a delegated task, an agent) ends
  // its turns on statements nobody is meant to answer. Its ended turn is "finished",
  // listed with what it said but never "waiting for your input": that row notified
  // on every turn and made a real question, which the rules above still catch
  // (a prose question, a --handoff needs-input, a pending AskUserQuestion), look
  // exactly like the last twenty turns that needed nothing.
  const unattended = session.unattended === true;
  add(ended && unattended && !model.identity.reviewer, 'unattended-finished', 'conversation', 'idle', 'Finished', 'finished',
    { kind: 'finished', detail: text }, 'inferred');
  const ready = ended && model.identity.interactive && !model.identity.reviewer && !unattended;
  const readyRequest = { kind: 'input', detail: 'Ready for your next instruction.' };
  add(ready, 'conversation-ready', 'conversation', 'needs-input', 'Ready for next instruction', 'next instruction', readyRequest, 'inferred');
  add(taskStatus === 'done' && ready, 'completed-task-ready', 'conversation', 'needs-input', 'Ready for next instruction', 'next instruction', readyRequest, 'inferred');
  add(taskStatus === 'done', 'task-done', 'registry', 'done', 'Done');
  add(taskStatus === 'review', 'task-review', 'registry', 'needs-input', 'Needs input', 'your review', { kind: 'input', detail: 'Ready for your review.' });
  add(model.task.dependencies.length, 'task-dependency', 'registry', 'waiting', 'Waiting: dependency', model.task.dependencies.join(', '));
  add(model.task.checkAfter, 'scheduled-check', 'registry', 'waiting', 'Waiting: scheduled check', model.task.checkAfter);
  add(taskStatus === 'waiting', 'task-waiting', 'registry', 'waiting', 'Waiting: dependency', 'dependency');
  add(taskStatus === 'landing', 'task-landing', 'registry', 'waiting', 'Waiting: land', 'land');
  add(taskStatus === 'blocked', 'task-blocked', 'registry', 'waiting', 'Waiting: blocked', 'blocker not specified');
  // Automatic retirement stops only the process. The conversation and its
  // durable request remain actionable, so explicit question/review/check/card
  // candidates above keep their precedence after the process exits. An ordinary
  // exit still reads Exited and is not put back into attention by attention().
  add(processExited && session.retirement?.automatic === true,
    'process-exited', 'process', 'exited', 'Exited', null, null, 'observed', model.process.observedAt || null);
  add(true, 'no-current-work', 'fallback', 'idle', 'Idle', null, null, model.foreground.state === 'unknown' ? 'uncertain' : 'inferred');
  const chosen = candidates[0];
  const evidence = ({ rule, source, confidence, at, state }) => ({ rule, source, confidence, at: at ?? null, state });
  return { state: chosen.state, label: chosen.label, reason: chosen.reason, needsInput: Boolean(chosen.request), request: chosen.request,
    background: { pending: model.background.pending, uncertain: model.background.uncertain, scheduled: model.conversation.scheduled,
      checkAfter: model.task.checkAfter, dependencies: model.task.dependencies },
    decision: { ...evidence(chosen), alternatives: candidates.slice(1).filter((c) => c.rule !== 'no-current-work').map(evidence) } };
}

function attention(session, context) {
  // A standing agent's session is watched through its own row under Agents, the
  // same as the reviewer's: nobody triages it from "Waiting on you", and a row
  // there would be a second listing of a pane that already has one.
  if (session.reviewer || session.agentName
      || ((session.exited || session.state === 'exited') && session.retirement?.automatic !== true)) return null;
  const status = context ? activity(session, context) : session.activity || activity(session);
  if (!status.needsInput) return null;
  // A finished unattended turn is listed for its result and never pushed, counted
  // or notified: the console, the phone and the badge all key on pri 0.
  const finished = status.request && status.request.kind === 'finished';
  return {
    pri: finished ? 1 : 0, ...status.request, sessionId: session.id, project: session.project,
    title: session.title, taskId: session.taskId || undefined, since: session.attentionAt ?? session.mtime,
    attentionLabel: finished ? 'Finished' : status.reason === 'next instruction' ? 'Ready for next instruction' : 'Needs an answer',
    ...(Number.isFinite(session.lastUserAt) ? { lastUserAt: session.lastUserAt } : {}),
    ...(session.kind === 'codex' ? { codex: true } : {}),
  };
}

module.exports = { activity, attention, proseRequest, toolWaitReason, waitReason };
