'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ledger = require('./restart-ledger');
const jobs = require('./background-jobs');
const row = (type, payload) => ({ type, payload });
const meta = (id, parent) => row('session_meta', { id, parent_thread_id: parent });
const done = () => row('event_msg', { type: 'task_complete' });
function fixture(run, agent = 'codex') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-restart-ledger-'));
  const file = id => path.join(root, `${id}.jsonl`);
  let at = Date.now();
  const append = (id, value) => fs.appendFileSync(file(id), JSON.stringify({ timestamp: new Date(++at).toISOString(), ...value }) + '\n');
  const verify = options => ledger.verify({ root, agent, sid: 'parent', file: file('parent'), instance: { id: 'pane:10:11', since: 1, live: true }, resolveChild: file, ...options });
  try { run({ root, file, append, verify }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('cold bootstrap persists proof; warm verification reads no conversation history', () => fixture(({ root, append, verify }) => {
  append('parent', meta('parent')); append('parent', done());
  verify()();
  const original = fs.readSync;
  let bytes = 0;
  fs.readSync = (...args) => { const n = original(...args); bytes += n; return n; };
  try { verify()(); } finally { fs.readSync = original; }
  assert.ok(bytes <= 128, 'only the checkpoint anchor is read');
  const state = jobs.read(root, 'codex', 'parent');
  assert.equal(state.caughtUp, true);
}));

test('an aborted child can be quiescent but outstanding calls and aborted parents remain protected', () => fixture(({ append, verify }) => {
  append('parent', meta('parent')); append('child', meta('child', 'parent'));
  append('parent', row('event_msg', { item: { type: 'SubAgentActivity', kind: 'completed', id: 'spawn', agent_thread_id: 'child' } }));
  append('parent', done());
  append('child', row('event_msg', { type: 'turn_aborted' }));
  verify()();
  append('child', row('response_item', { type: 'function_call', call_id: 'work', name: 'exec_command', arguments: '{}' }));
  append('child', row('event_msg', { type: 'turn_aborted' }));
  assert.throws(verify, /not verifiably complete/);
  append('child', row('response_item', { type: 'function_call_output', call_id: 'work', output: '{"exit_code":0}' }));
  verify()();
  append('parent', row('event_msg', { type: 'turn_aborted' }));
  assert.throws(verify, /not verifiably complete/);
}));

test('legacy Claude child final text requires a fresh parent acknowledgement and no newer activity', () => fixture(({ append, verify }) => {
  append('parent', { sessionId: 'parent', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'spawn', name: 'Agent', input: {} }] } });
  append('parent', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'spawn', content: 'Async agent launched successfully. agentId: child' }] } });
  append('child', { sessionId: 'parent', type: 'assistant', message: { stop_reason: null, content: [{ type: 'text', text: 'Finished review' }] } });
  append('parent', { type: 'assistant', message: { stop_reason: 'end_turn', content: [] } });
  assert.throws(verify, /not verifiably complete/);
  const ack = result => {
    append('parent', { type: 'user', message: { content: `<task-notification><task-id>child</task-id><status>completed</status><result>${result}</result></task-notification>` } });
    append('parent', { type: 'assistant', message: { stop_reason: 'end_turn', content: [] } });
  };
  ack('first'); verify()();
  append('child', { type: 'user', message: { content: 'Continue review' } });
  assert.throws(verify, /not verifiably complete/);
  append('child', { type: 'assistant', message: { stop_reason: null, content: [{ type: 'text', text: 'Next review finished' }] } });
  assert.throws(verify, /not verifiably complete/);
  ack('second'); verify()();
  append('child', { type: 'assistant', message: { stop_reason: null, content: [{ type: 'tool_use', id: 'busy', name: 'Bash', input: {} }] } });
  ack('third'); assert.throws(verify, /not verifiably complete/);
}, 'claude'));

test('same-time and untimestamped child prompts invalidate legacy final-text evidence', () => {
  const { consume } = require('./restart-evidence');
  const at = '2026-09-09T12:00:00.000Z';
  for (const timestamp of [at, undefined]) {
    const state = {};
    const final = { type: 'assistant', timestamp: at, message: { stop_reason: null, content: [{ type: 'text', text: 'Done' }] } };
    consume(state, final, 'claude');
    assert.ok(state.restart.finalTextAt);
    consume(state, { type: 'user', timestamp, message: { content: 'Continue' } }, 'claude');
    assert.equal(state.restart.finalTextAt, 0);
    consume(state, final, 'claude');
    assert.equal(state.restart.finalTextAt, 0, 'ambiguous ordering cannot reuse an old acknowledgement');
  }
});

test('duplicate startup prompts before the first final do not reuse prior completion evidence', () => {
  const { consume } = require('./restart-evidence');
  const state = {}, timestamp = '2026-09-09T12:00:00.000Z';
  const prompt = { type: 'user', timestamp, message: { content: 'Review this' } };
  consume(state, prompt, 'claude');
  consume(state, prompt, 'claude');
  consume(state, { type: 'assistant', timestamp: '2026-09-09T12:00:01.000Z',
    message: { stop_reason: null, content: [{ type: 'text', text: 'Done' }] } }, 'claude');
  assert.ok(state.restart.finalTextAt);
  assert.equal(state.restart.finalTextSeen, Date.parse('2026-09-09T12:00:01.000Z'));
  const resumed = { ...prompt, timestamp: '2026-09-09T12:00:02.000Z' };
  consume(state, resumed, 'claude');
  consume(state, resumed, 'claude');
  assert.equal(state.restart.finalTextBlocked, false);
  consume(state, prompt, 'claude');
  assert.equal(state.restart.finalTextAt, 0);
  assert.equal(state.restart.finalTextBlocked, true);
});

test('exact Claude interruption evidence completes only the interrupted foreground turn', () => fixture(({ append, verify }) => {
  const interrupted = (text = '[Request interrupted by user]', extra = {}) => ({
    type: 'user', sessionId: 'parent', interruptedMessageId: 'message-one',
    message: { content: [{ type: 'text', text }] }, ...extra,
  });
  append('parent', { type: 'user', sessionId: 'parent', message: { content: 'Start work' } });
  append('parent', { type: 'assistant', sessionId: 'parent', message: { content: [{ type: 'text', text: 'Working' }], stop_reason: null } });
  append('parent', interrupted());
  verify()();

  append('parent', { type: 'user', sessionId: 'parent', message: { content: 'Do something else' } });
  assert.throws(verify, /not verifiably complete/, 'later human activity starts a new turn');
  append('parent', interrupted('[Request interrupted by user for tool use]'));
  verify()();
  append('parent', { type: 'assistant', sessionId: 'parent', message: { content: [{ type: 'text', text: 'Continuing' }], stop_reason: null } });
  assert.throws(verify, /not verifiably complete/, 'later assistant activity supersedes the interruption');
}, 'claude'));

test('inexact Claude interruption text and pending tools remain protected', () => {
  const { consume } = require('./restart-evidence');
  const exact = { type: 'user', interruptedMessageId: 'message-one', message: { content: [
    { type: 'text', text: '[Request interrupted by user]' },
  ] } };
  for (const row of [
    { ...exact, interruptedMessageId: undefined },
    { ...exact, message: { content: [{ type: 'text', text: 'quoted: [Request interrupted by user]' }] } },
    { ...exact, message: { content: [{ type: 'text', text: '[Request interrupted by user] trailing' }] } },
    { ...exact, message: { content: [...exact.message.content, { type: 'text', text: 'extra' }] } },
  ]) {
    const state = {};
    consume(state, row, 'claude');
    assert.equal(state.restart.completed, false);
  }

  const state = {};
  consume(state, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'busy', name: 'Bash', input: {} }], stop_reason: 'tool_use' } }, 'claude');
  state.calls = { 'call:busy': { name: 'Bash' } };
  consume(state, exact, 'claude');
  assert.equal(state.restart.completed, true);
  assert.ok(state.calls['call:busy'], 'interruption evidence does not resolve a pending tool call');
});

test('yielded jobs survive restart and an unrelated completion cannot clear them', () => fixture(({ append, verify }) => {
  append('parent', meta('parent'));
  const call = (id, name, input) => append('parent', row('response_item', { type: 'function_call', call_id: id, name, arguments: JSON.stringify(input) }));
  const result = (id, output) => append('parent', row('response_item', { type: 'function_call_output', call_id: id, output: JSON.stringify(output) }));
  call('start', 'exec_command', {}); result('start', { session_id: 123 }); append('parent', done());
  assert.throws(verify, /unresolved/);
  call('wrong', 'write_stdin', { session_id: 456 }); result('wrong', { exit_code: 0 }); append('parent', done());
  assert.throws(verify, /unresolved/);
  call('right', 'write_stdin', { session_id: 123 }); result('right', { exit_code: 0 }); append('parent', done());
  verify()();
}));

test('completed child notices do not authorize retirement of an active child', () => fixture(({ append, verify }) => {
  append('parent', meta('parent')); append('child', meta('child', 'parent'));
  append('parent', row('response_item', { type: 'function_call', call_id: 'spawn', name: 'spawn_agent', arguments: '{}' }));
  append('parent', row('response_item', { type: 'function_call_output', call_id: 'spawn', output: '{}' }));
  append('parent', row('event_msg', { item: { type: 'SubAgentActivity', kind: 'completed', id: 'spawn', agent_thread_id: 'child' } }));
  append('parent', done());
  assert.throws(verify, /turn is not/);
  append('child', done()); const proof = verify(); proof();
  append('child', row('event_msg', { type: 'task_started' }));
  assert.throws(proof, /changed/);
  assert.throws(verify, /turn is not/);
}));

test('completed child turns with unanswered asynchronous questions remain protected', () => fixture(({ append, verify }) => {
  append('parent', meta('parent')); append('child', meta('child', 'parent'));
  append('parent', row('event_msg', { item: { type: 'SubAgentActivity', kind: 'started', id: 'spawn', agent_thread_id: 'child' } }));
  append('parent', done());
  append('child', row('response_item', { type: 'function_call', name: 'functions.request_user_input_async', call_id: 'question', arguments: JSON.stringify({ questions: [{ title: 'Approve?' }] }) }));
  append('child', row('response_item', { type: 'function_call_output', call_id: 'question', output: '{}' }));
  append('child', done());
  assert.throws(verify, /pending input/);
  append('child', row('event_msg', { type: 'user_message', message: 'yes' })); append('child', done());
  verify()();
}));

test('unknown child launch and mismatched ownership remain hard failures', () => fixture(({ append, verify }) => {
  append('parent', meta('parent'));
  append('parent', row('response_item', { type: 'custom_tool_call', call_id: 'spawn', name: 'functions.exec', input: 'await tools.spawn_agent({task:"x"})' }));
  append('parent', row('response_item', { type: 'custom_tool_call_output', call_id: 'spawn', output: 'Script completed' }));
  append('parent', done()); assert.throws(verify, /no verified/);
  append('child', meta('child', 'other')); append('child', done());
  append('parent', row('event_msg', { item: { type: 'SubAgentActivity', kind: 'started', id: 'spawn', agent_thread_id: 'child' } }));
  assert.throws(verify, /ownership/);
}));

test('new hook activity invalidates proof and Stop does not clear unflushed activity', () => fixture(({ root, file, append, verify }) => {
  append('parent', meta('parent')); append('parent', done());
  const proof = verify();
  jobs.recordHook(root, 'codex', 'parent', { event: 'PreToolUse', entity: 'new', at: 200000, offset: fs.statSync(file('parent')).size });
  assert.throws(proof, /hook activity/);
  assert.throws(verify, ledger.Recovering);
  jobs.recordHook(root, 'codex', 'parent', { event: 'Stop', entity: 'turn', at: 200001, offset: fs.statSync(file('parent')).size });
  assert.throws(verify, ledger.Recovering);
  append('parent', row('event_msg', { type: 'task_started' })); assert.throws(verify, /turn is not/);
  append('parent', done()); verify()();
}));

test('a consumed hook still invalidates an existing proof while an idle tick does not', () => fixture(({ root, file, append, verify }) => {
  append('parent', meta('parent')); append('parent', done()); const proof = verify();
  jobs.sync({ root, agent: 'codex', sid: 'parent', file: file('parent') }); proof();
  jobs.recordHook(root, 'codex', 'parent', { event: 'SubagentStart', entity: 'child', at: Date.now(), offset: fs.statSync(file('parent')).size });
  jobs.sync({ root, agent: 'codex', sid: 'parent', file: file('parent') });
  assert.throws(proof, /evidence changed/);
  assert.throws(verify, /identity|ENOENT/);
}));

test('migration retains hook-only children and source replacement evidence', () => fixture(({ root, file, append, verify }) => {
  append('parent', meta('parent')); append('parent', done()); verify();
  jobs.recordHook(root, 'codex', 'parent', { event: 'SubagentStart', entity: 'child', at: Date.now(), offset: 0 });
  jobs.sync({ root, agent: 'codex', sid: 'parent', file: file('parent') });
  const snapshot = path.join(root, '.keep/background-jobs/codex/parent/state.json');
  const old = JSON.parse(fs.readFileSync(snapshot)); delete old.restartVersion; delete old.restart;
  fs.writeFileSync(snapshot, JSON.stringify(old));
  assert.throws(verify, /identity|ENOENT|recovery/);
  assert.ok(jobs.read(root, 'codex', 'parent').jobs.some(j => j.id === 'child' && j.status === 'pending'));
  delete old.restartVersion; fs.writeFileSync(snapshot, JSON.stringify(old));
  fs.writeFileSync(file('parent'), JSON.stringify(meta('parent')) + '\n' + JSON.stringify(done()) + '\n');
  assert.throws(verify, /incomplete/);
}));

test('Claude evidence migration keeps a pruned child ownership edge fail closed', () => fixture(({ root, file, append, verify }) => {
  append('parent', { sessionId: 'parent', type: 'assistant', message: { content: [], stop_reason: 'end_turn' } });
  verify()();
  append('child', { sessionId: 'parent', type: 'user', message: { content: 'Still working' } });
  const snapshot = path.join(root, '.keep/background-jobs/claude/parent/state.json');
  const state = JSON.parse(fs.readFileSync(snapshot));
  state.restartVersion = 1;
  state.restart.children['child'] = 'owned';
  assert.equal(Object.values(state.jobs).some(job => job.id === 'child'), false, 'the child tombstone is absent');
  fs.writeFileSync(snapshot, JSON.stringify(state));
  assert.throws(verify, /not verifiably complete/);
  const migrated = JSON.parse(fs.readFileSync(snapshot));
  assert.equal(migrated.restart.children.child, 'owned');
}, 'claude'));

test('partial writes recover, replacement fails closed, large records have a separate bound', () => fixture(({ file, append, verify }) => {
  append('parent', meta('parent')); append('parent', done()); verify()();
  fs.appendFileSync(file('parent'), '{"type":"event_msg"'); assert.throws(verify, ledger.Recovering);
  fs.appendFileSync(file('parent'), ',"payload":{"type":"task_complete"}}\n'); verify()();
  append('parent', row('response_item', { type: 'message', role: 'assistant', content: 'x'.repeat(5000) }));
  verify({ budget: 1024 })();
  fs.writeFileSync(file('parent'), JSON.stringify(meta('parent')) + '\n' + JSON.stringify(done()) + '\n');
  assert.throws(verify, /incomplete/);
}));

test('Claude process-local cron and services block restart; Stop hook alone is insufficient', () => fixture(({ append, verify }) => {
  const assistant = (content, stop_reason) => ({ type: 'assistant', sessionId: 'parent', message: { content, stop_reason } });
  const call = (id, name, input) => append('parent', assistant([{ type: 'tool_use', id, name, input }], 'tool_use'));
  const result = (id, content) => append('parent', { type: 'user', sessionId: 'parent', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  append('parent', assistant([], 'end_turn')); verify()();
  call('cron', 'CronCreate', {}); result('cron', 'Scheduled recurring job tick (* * * * *).');
  append('parent', assistant([], 'end_turn')); assert.throws(verify, /unresolved scheduled/);
  call('cancel', 'CronDelete', { id: 'tick' }); result('cancel', 'Cancelled job tick.');
  append('parent', assistant([], 'end_turn')); verify()();
  call('service', 'Bash', { run_in_background: true }); result('service', 'Command running in background with ID: server');
  append('parent', assistant([], 'end_turn')); assert.throws(verify, /unresolved/);
}, 'claude'));

test('terminal Claude quota errors are allowed only by explicit handoff proof and never with unresolved work', () => fixture(({ append, verify }) => {
  append('parent', { type: 'user', sessionId: 'parent', message: { content: 'Continue the task' } });
  append('parent', { type: 'assistant', sessionId: 'parent', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429,
    message: { content: [], stop_reason: null } });
  assert.throws(verify, /not verifiably complete/, 'normal restart remains strict');
  verify({ allowTerminalRateLimit: true })();
  append('parent', { type: 'assistant', sessionId: 'parent', message: { content: [{ type: 'tool_use', id: 'busy', name: 'Bash', input: {} }], stop_reason: 'tool_use' } });
  append('parent', { type: 'assistant', sessionId: 'parent', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429,
    message: { content: [], stop_reason: null } });
  assert.throws(() => verify({ allowTerminalRateLimit: true }), /calls|complete/);
}, 'claude'));
