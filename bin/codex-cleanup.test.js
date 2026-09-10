'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { verify } = require('./codex-cleanup');
const row = (type, payload) => JSON.stringify({ type, payload }) + '\n';
const done = row('event_msg', { type: 'task_complete' });
const start = row('event_msg', { type: 'task_started' });
const meta = (id, parent) => row('session_meta', { id, parent_thread_id: parent, source: 'cli' });
const activity = (id, kind = 'completed') => row('event_msg', { item: { type: 'SubAgentActivity', id: 'spawn', kind, agent_thread_id: id } });

test('large completed transcripts stream without a total-size cutoff', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-large-proof-'));
  const file = path.join(root, 'parent.jsonl');
  try {
    fs.writeFileSync(file, meta('parent'));
    const padding = row('response_item', { type: 'message', role: 'assistant', content: 'x'.repeat(1024 * 1024) });
    for (let i = 0; i < 70; i++) fs.appendFileSync(file, padding);
    fs.appendFileSync(file, done);
    const check = verify(file, 'parent');
    check();
    fs.appendFileSync(file, start);
    assert.throws(check, /changed/);
    assert.throws(() => verify(file, 'parent'), /not verifiably complete/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('yielded commands require matching terminal completion, not prose or unrelated results', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-job-proof-'));
  const file = path.join(root, 'parent.jsonl');
  const call = (id, name, args) => row('response_item', { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
  const output = (id, value) => row('response_item', { type: 'function_call_output', call_id: id, output: value });
  try {
    const launch = meta('parent') + call('launch', 'exec_command', {}) + output('launch', 'Process running with session ID 123');
    for (const [target, code, expected] of [[123, 0, true], [123, 1, true], [999, 0, false]]) {
      fs.writeFileSync(file, launch + call('poll', 'write_stdin', { session_id: target }) + output('poll', JSON.stringify({ exit_code: code })) + done);
      if (expected) verify(file, 'parent');
      else assert.throws(() => verify(file, 'parent'), /yielded background/);
    }
    fs.writeFileSync(file, launch + output('unrelated', 'Process exited with code 0') + done);
    assert.throws(() => verify(file, 'parent'), /yielded background/);
    const codePoll = row('response_item', { type: 'custom_tool_call', call_id: 'poll', name: 'exec', input: 'text(await tools.exec_command({cmd:"true"}));\ntext(await tools.write_stdin({session_id:123,chars:""}));' });
    const blocks = (first, second) => row('response_item', { type: 'custom_tool_call_output', call_id: 'poll', output: [
      { type: 'input_text', text: 'Script completed\nOutput:\n' },
      { type: 'input_text', text: JSON.stringify(first) }, { type: 'input_text', text: JSON.stringify(second) },
    ] });
    fs.writeFileSync(file, launch + codePoll + blocks({ exit_code: 0 }, { exit_code: 0 }) + done);
    verify(file, 'parent');
    fs.writeFileSync(file, launch + codePoll + blocks({ exit_code: 0 }, { session_id: 123 }) + done);
    assert.throws(() => verify(file, 'parent'), /yielded background/);
    fs.writeFileSync(file, launch + codePoll + blocks({ session_id: 999 }, { exit_code: 0 }) + done);
    assert.throws(() => verify(file, 'parent'), /yielded background/, 'another launched job remains protected');
    fs.writeFileSync(file, meta('parent') + call('launch', 'exec', {}) + output('launch', 'Script running with cell ID abc') +
      call('poll', 'wait', { cell_id: 'abc' }) + output('poll', 'Script completed\nOutput:\n') + done);
    verify(file, 'parent');
    fs.writeFileSync(file, meta('parent') + call('launch', 'exec', {}) + output('launch', 'Script running with cell ID abc') +
      call('poll', 'wait', { cell_id: 'abc' }) + output('poll', 'Script completed\nOutput:\n{"session_id":123}') + done);
    assert.throws(() => verify(file, 'parent'), /unresolved evidence/);
    const stamp = (text, at) => text.split('\n').filter(Boolean).map(line => JSON.stringify({ ...JSON.parse(line), timestamp: at }) + '\n').join('');
    fs.writeFileSync(file, meta('parent') + stamp(call('launch', 'exec', {}), '2026-09-09T01:00:00Z') +
      stamp(row('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', process_id: '123', status: 'completed' } }), '2026-09-09T01:00:01Z') +
      stamp(output('launch', [{ type: 'input_text', text: 'Script completed\nOutput:\n' }, { type: 'input_text', text: '{"session_id":123}' }]), '2026-09-09T01:00:02Z') + done);
    verify(file, 'parent');
    fs.writeFileSync(file, meta('parent') + call('failed', 'spawn_agent', {}) + output('failed', 'collab spawn failed: agent thread limit reached') + done);
    verify(file, 'parent');
    fs.writeFileSync(file, meta('parent') + call('example', 'exec_command', { cmd: 'echo spawn_agent' }) + output('example', 'Process exited with code 0\nOutput:\nProcess running with session ID 123') + done);
    verify(file, 'parent');
    fs.writeFileSync(file, meta('parent') + row('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'nested', input: 'text(await tools.spawn_agent({message:"work"}));' }) + output('nested', 'Script completed') + done);
    assert.throws(() => verify(file, 'parent'), /no verified identity/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('code-mode poll mapping counts literal labels but rejects unknown control flow and side effects', () => {
  const { polls, hasChildCall } = require('./code-mode-polls');
  assert.equal(hasChildCall('text(await tools.exec_command({cmd:"echo spawn_agent"}));'), false);
  assert.equal(hasChildCall('text(await tools.spawn_agent({}));'), true);
  assert.equal(hasChildCall('const launch = tools["spawn_agent"];'), true);
  assert.equal(hasChildCall('const {spawn_agent: launch} = tools; text(await launch({}));'), true);
  assert.equal(hasChildCall('text(await tools.mcp__collaboration__spawn_agent({}));'), true);
  assert.deepEqual(polls('text(await tools.write_stdin({session_id:123,chars:""}));'), [{ index: 1, count: 1, name: 'write_stdin', target: '123' }]);
  assert.deepEqual(polls('text("extra"); text(await tools.write_stdin({session_id:123}));'), [{ index: 2, count: 2, name: 'write_stdin', target: '123' }]);
  for (const code of [
    'if (false) text(await tools.write_stdin({session_id:123}));',
    'text(await tools.write_stdin({session_id:target}));',
    'text(await tools.exec_command({cmd: text("extra")})); text(await tools.write_stdin({session_id:123}));',
    'text("tools.write_stdin({session_id:123})");',
  ]) assert.deepEqual(polls(code), [], code);
});

test('automatic Codex child proof requires completed matching descendants and detects races', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-child-proof-'));
  const parent = path.join(root, 'parent.jsonl'), child = path.join(root, 'child.jsonl');
  try {
    fs.writeFileSync(parent, meta('parent') + activity('child') + done);
    fs.writeFileSync(child, meta('child', 'parent') + activity('parent', 'interacted') + done);
    const resolve = (id) => id === 'parent' ? parent : child;
    const check = verify(parent, 'parent', resolve);
    check();
    fs.appendFileSync(child, start);
    assert.throws(check, /changed/);
    assert.throws(() => verify(parent, 'parent', resolve), /not verifiably complete/);
    fs.writeFileSync(child, meta('child', 'different') + done);
    assert.throws(() => verify(parent, 'parent', resolve), /ownership/);
    fs.writeFileSync(child, meta('child', 'parent') + row('event_msg', { type: 'turn_aborted' }));
    assert.throws(() => verify(parent, 'parent', () => child), /not verifiably complete/);
    fs.writeFileSync(child, meta('child', 'parent') + activity('grandchild') + done);
    assert.throws(() => verify(parent, 'parent', (id) => id === 'child' ? child : null), /unverified/);
    fs.writeFileSync(child, meta('child', 'parent') + done + '{');
    assert.throws(() => verify(parent, 'parent', () => child), /still being written/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unmapped launches, unanswered questions and yielded commands remain protected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-child-proof-'));
  const file = path.join(root, 'parent.jsonl');
  try {
    for (const [name, args, output, error] of [
      ['collaboration.spawn_agent', '{}', '{}', /no verified identity/],
      ['followup_task', '{}', '{}', /no verified identity/],
      ['collaboration.followup_task', '{}', '{}', /no verified identity/],
      ['request_user_input_async', JSON.stringify({ questions: [{ title: 'Decide?' }] }), '{}', /not verifiably complete/],
      ['exec_command', '{}', 'Process running with session ID 123', /yielded background/],
    ]) {
      fs.writeFileSync(file, meta('parent') + row('response_item', { type: 'function_call', call_id: 'call', name, arguments: args }) +
        row('response_item', { type: 'function_call_output', call_id: 'call', output }) + done);
      assert.throws(() => verify(file, 'parent'), error);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
