'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalize, attachRuntime } = require('./session-model');
const { activity, attention } = require('./session-status');
const { scanTranscript } = require('./serve');
const { scanRollout } = require('./codex');
const { foreground } = require('./session-lifecycle');
const { createTrace } = require('./session-debug');

function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-reliability-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, '');
  let at = Date.parse('2026-09-10T00:00:00Z');
  const append = (record) => { at += 1000; fs.appendFileSync(file, JSON.stringify({ timestamp: new Date(at).toISOString(), ...record }) + '\n'); };
  try { run({ file, append, now: () => at }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const pane = (pid = 10, alive = true) => ({ id: 'pane', pid, alive, createdAt: `instance-${pid}`, meta: { sessionId: 's' } });
const claude = (type, content, stop_reason = null) => ({ type, message: { content, stop_reason } });
const tool = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const result = (id, content) => ({ type: 'tool_result', tool_use_id: id, content });
const text = (value) => ({ type: 'text', text: value });

test('Claude lifecycle replay: unknown job, question, completion, close and replacement', () => fixture(({ file, append }) => {
  const snapshot = (expected, patch = {}, panes = [pane()]) => {
    const info = scanTranscript(file);
    const session = { ...info, id: 's', kind: 'claude', ...patch };
    attachRuntime([session], panes);
    session.activity = activity(session);
    assert.equal(session.activity.state, expected);
    assert.deepEqual(activity({ ...scanTranscript(file), id: 's', kind: 'claude', ...patch, runtime: session.runtime }), session.activity,
      'cold transcript reconstruction agrees with the same observations');
    return session;
  };
  append(claude('user', 'Start the build'));
  snapshot('running');
  append(claude('assistant', [tool('build', 'Bash', { command: 'bash arbitrary-poller.sh', run_in_background: true })], 'tool_use'));
  append(claude('user', [result('build', 'Command running in background with ID: build-job.')]));
  append(claude('assistant', [text('I will continue after the job finishes.')], 'end_turn'));
  let session = snapshot('waiting');
  assert.equal(session.activity.decision.rule, 'conversation-wait');
  assert.equal(session.activity.decision.confidence, 'inferred');
  assert.equal(attention(session), null);
  append(claude('assistant', [tool('q', 'AskUserQuestion', { questions: [{ question: 'Which device?' }] })], 'tool_use'));
  assert.equal(snapshot('needs-input').activity.decision.rule, 'pending-question');
  append(claude('user', [result('q', 'Use the tablet.')]));
  snapshot('running');
  append(claude('assistant', [text('Continuing after the build.')], 'end_turn'));
  snapshot('waiting');
  for (let duplicate = 0; duplicate < 2; duplicate++) {
    append(claude('user', '<task-notification><task-id>build-job</task-id><status>completed</status></task-notification>'));
  }
  append(claude('assistant', [text('Build complete.')], 'end_turn'));
  session = snapshot('needs-input');
  assert.equal(session.activity.decision.rule, 'conversation-ready');
  session = snapshot('exited', { ownerQuestion: { question: 'Old approval?' } }, [pane(10, false)]);
  assert.ok(session.activity.decision.alternatives.some((x) => x.rule === 'owner-question'));
  session = snapshot('needs-input', {}, [pane(10, false), pane(11)]);
  assert.equal(session.runtime.pid, 11);
  assert.equal(normalize(session).identity.conversationId, 's');
}));

test('Codex replay: wait, asynchronous question, answer and completed turn', () => fixture(({ file, append }) => {
  append({ type: 'session_meta', payload: { id: 's', source: 'cli' } });
  assert.equal(scanRollout(file), null, 'startup is not running work');
  const event = (type, extra = {}) => append({ type: 'event_msg', payload: { type, ...extra } });
  const call = (id, name, args) => append({ type: 'response_item', payload: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) } });
  const output = (id) => append({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: 'accepted' } });
  const state = () => activity({ ...scanRollout(file), kind: 'codex', pane: 'pane' });
  event('user_message', { message: 'Deploy' });
  assert.equal(state().state, 'running');
  call('wait', 'functions.wait', {});
  assert.equal(state().state, 'waiting');
  call('question', 'functions.request_user_input_async', { questions: [{ title: 'Which region?' }] });
  output('question');
  assert.equal(state().state, 'needs-input');
  event('user_message', { message: 'West' });
  assert.equal(state().state, 'waiting', 'outstanding wait is still independent of answered question');
  output('wait');
  assert.equal(state().state, 'running');
  event('task_complete');
  assert.equal(state().decision.rule, 'conversation-ready');
}));

test('new hook evidence supersedes old task/prose state and expires without becoming permanent truth', () => {
  const info = { id: 's', endedTurn: true, attentionAt: 1000, lastAssistant: 'Send me the URL.', taskStatus: 'waiting' };
  const hooks = [{ event: 'UserPromptSubmit', at: 2000 }];
  const live = { ...info, lifecycleForeground: foreground(hooks, info, 3000) };
  assert.equal(activity(live).decision.rule, 'foreground-hook');
  assert.equal(activity(live).decision.source, 'hook');
  assert.equal(activity({ ...info, lifecycleForeground: foreground(hooks, info, 33000) }).decision.rule, 'prose-request');
  assert.equal(foreground(hooks, { attentionAt: 3000 }, 4000), null);
});

test('known service and unknown background job are separate facts', () => fixture(({ file, append }) => {
  append(claude('assistant', [tool('server', 'Bash', { command: 'npm run dev', run_in_background: true })]));
  append(claude('user', [result('server', 'Command running in background with ID: service.')]));
  append(claude('assistant', [text('Ready.')], 'end_turn'));
  assert.deepEqual(scanTranscript(file).unknownBackgroundJobs, []);
  assert.equal(activity({ ...scanTranscript(file), pane: 'pane' }).needsInput, true);
}));

test('decision traces are bounded, deduplicated, copied and contain no prompt text', () => {
  const trace = createTrace(3, 1000);
  const session = { id: 's', endedTurn: true, pane: 'p', ownerQuestion: { question: 'SECRET' } };
  session.activity = activity(session);
  trace.record(session, 10); trace.record(session, 20);
  assert.equal(trace.read(null, 20).length, 1);
  assert.equal(JSON.stringify(trace.read(null, 20)).includes('SECRET'), false);
  const copy = trace.read(null, 20); copy[0].alternatives.length = 0;
  assert.ok(trace.read(null, 20)[0].alternatives.length);
  for (let i = 0; i < 10; i++) trace.record({ ...session, id: `s${i}` }, 30 + i);
  assert.equal(trace.read(null, 40).length, 3);
  assert.equal(trace.read('s9', 40).length, 1);
  assert.equal(trace.read(null, 2000).length, 0);
});
