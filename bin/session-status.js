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
  const result = (state, label, reason = null, request = null) => ({ state, label, reason, needsInput: Boolean(request), request });
  if (session.exited || session.state === 'exited') return result('exited', 'Exited');
  if (session.deadMidTurn) return result('inactive', 'Inactive', 'process no longer detected');
  const notify = session.notify || {};
  // Real prompts take precedence over a card's broader dependency status.
  if (session.pendingQuestion) return result('needs-input', 'Needs input', 'question', {
    kind: 'question', question: session.pendingQuestion.question, options: session.pendingQuestion.options,
  });
  if (session.pendingPlan) return result('needs-input', 'Needs input', 'plan approval', { kind: 'plan' });
  if (notify.type === 'question') return result('needs-input', 'Needs input', 'question', {
    kind: 'question', question: notify.message, options: notify.options,
  });
  if (notify.type === 'permission') return result('needs-input', 'Needs input', 'permission', { kind: 'permission', detail: notify.message });
  if (session.rateLimit) return result('waiting', 'Waiting: rate limit', 'rate limit');
  const text = session.lastAssistantFull || session.lastAssistant || '';
  const ended = session.endedTurn === true || (session.endedTurn == null && notify.type === 'complete');
  if (ended && !session.toolRunning && (session.askedProse || proseRequest(text))) {
    return result('needs-input', 'Needs input', 'question', { kind: 'input', detail: text });
  }
  if (session.waitingFor) return result('waiting', `Waiting: ${session.waitingFor}`, session.waitingFor);
  if (session.endedTurn === false || session.toolRunning) return result('running', 'Running');
  if (session.pendingBackground) {
    const waiting = text.match(/\b(?:waiting (?:on|for)|awaiting|blocked (?:on|by))\b[^.!?\n]*/i)?.[0];
    const reason = waitReason(waiting);
    return result('waiting', `Waiting: ${reason}`, reason);
  }
  // An in-flight turn may be doing useful work despite a card dependency.
  const task = context.task?.fm || context.task || {};
  const taskStatus = task.status || session.taskStatus;
  if (taskStatus !== 'done' && task.needs?.length) {
    return result('needs-input', 'Needs input', 'requested input', { kind: 'input', detail: task.needs.map((need) => need.text).filter(Boolean).join('\n') });
  }
  if (taskStatus === 'done') return result('done', 'Done');
  if (taskStatus === 'review') return result('needs-input', 'Needs input', 'your review', { kind: 'input', detail: 'Ready for your review.' });
  if (context.dependencies?.length) return result('waiting', 'Waiting: dependency', context.dependencies.join(', '));
  if (task.check_after) return result('waiting', 'Waiting: scheduled check', task.check_after);
  if (taskStatus === 'waiting') return result('waiting', 'Waiting: dependency', 'dependency');
  if (taskStatus === 'landing') return result('waiting', 'Waiting: land', 'land');
  // Completion prose can describe an older card, deploy, or already-finished
  // job. It may name a reason for a live wait above, but cannot create one.
  if (taskStatus === 'blocked') return result('waiting', 'Waiting: blocked', 'blocker not specified');
  const live = context.live === true || session.alive === true || (Boolean(session.pane) && session.alive !== false);
  if (ended && live && !session.reviewer) {
    return result('needs-input', 'Needs instruction', 'next instruction', {
      kind: 'input', detail: 'Ready for your next instruction.',
    });
  }
  return result('idle', 'Idle');
}

function attention(session, context) {
  if (session.reviewer || session.exited || session.state === 'exited') return null;
  const status = context ? activity(session, context) : session.activity || activity(session);
  if (!status.needsInput) return null;
  return {
    pri: 0, ...status.request, sessionId: session.id, project: session.project,
    title: session.title, taskId: session.taskId || undefined, since: session.mtime,
    ...(session.kind === 'codex' ? { codex: true } : {}),
  };
}

module.exports = { activity, attention, proseRequest, toolWaitReason, waitReason };
