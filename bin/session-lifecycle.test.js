'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { record, read, pendingAgents, foreground } = require('./session-lifecycle');
const { spawnSync } = require('child_process');

test('stop intent is text-free, corroborated by end-turn, and cleared by a new user turn', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-stop-intent-'));
  try {
    const { stopReason } = require('./session-lifecycle');
    record(root, { session_id: 's', hook_event_name: 'Stop', last_assistant_message: 'Waiting for the deploy. PRIVATE' }, 1000);
    const events = read(root, 's', 1001);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
    assert.deepEqual(stopReason(events, { endedTurn: true, lastUserAt: 900 }), { intent: 'waiting', at: 1000 });
    assert.equal(stopReason(events, { endedTurn: false, lastUserAt: 900 }), null);
    assert.equal(stopReason(events, { endedTurn: true, lastUserAt: 1100 }), null);
    assert.equal(stopReason(events, { endedTurn: true, lastUserAt: 900, attentionAt: 1100 }), null);
    record(root, { session_id: 's', hook_event_name: 'UserPromptSubmit' }, 1100);
    assert.equal(stopReason(read(root, 's', 1101), { endedTurn: true }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('CLI hook is silent, nonblocking, and drives waiting status without input attention', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-lifecycle-cli-'));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'hook', 'lifecycle'], {
      input: JSON.stringify({ session_id: 'session', hook_event_name: 'SubagentStart', agent_id: 'child' }),
      env: { ...process.env, KEEP_DIR: root }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    const agents = pendingAgents(read(root, 'session'), '/tmp/session.jsonl', () => { throw new Error('not created'); });
    const session = { id: 'session', pane: 'pane', endedTurn: true, pendingBackground: agents.length > 0, lifecycleAgents: agents };
    const status = require('./session-status');
    assert.equal(status.activity(session).label, 'Waiting: subagent');
    assert.equal(status.attention(session), null);
    assert.equal(status.activity({ ...session, pendingQuestion: { question: 'Which account?', options: [] } }).needsInput, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('lifecycle records survive restart, deduplicate, and omit content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-lifecycle-'));
  try {
    const input = { session_id: 'session', hook_event_name: 'SubagentStart', agent_id: 'child', prompt: 'secret', tool_input: { secret: true } };
    assert.equal(record(root, input, 1000), true);
    record(root, input, 1001);
    const events = read(root, 'session', 1100);
    assert.equal(events.length, 1);
    assert.equal(events[0].at, 1000);
    assert.ok(!JSON.stringify(events).includes('secret'));
    assert.equal(record(root, { ...input, agent_id: '../../oops' }), false);
    assert.equal(record(root, { ...input, hook_event_name: 'PreToolUse', tool_use_id: 'tool' }), false);
    assert.equal(record(root, { session_id: 'session', hook_event_name: 'PermissionRequest', tool_name: 'Bash' }, 1100), true, 'PermissionRequest has no tool_use_id');
    assert.equal(foreground(read(root, 'session', 1200), {}, 1200).state, 'needs-input');
    assert.deepEqual(read(root, 'session', 86401100), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('subagent hooks reconcile completion, resume gaps, missing stops and continued children', () => {
  const start = { event: 'SubagentStart', entity: 'child', at: 1000 };
  const stop = { ...start, event: 'SubagentStop', at: 2000 };
  const parent = '/tmp/session.jsonl';
  const pending = (events, state, now = 3000) => pendingAgents(events, parent, () => state, now);
  assert.deepEqual(pending([start], { explicitEndTurn: true, attentionAt: 900 }), ['child']);
  assert.deepEqual(pending([start], { explicitEndTurn: true, attentionAt: 1500 }), []);
  assert.deepEqual(pending([start, stop], { explicitEndTurn: true, attentionAt: 1900 }), []);
  assert.deepEqual(pending([start, stop], { explicitEndTurn: false, attentionAt: 2500 }), ['child']);
  assert.deepEqual(pending([start, stop, { ...start, at: 2800 }], { explicitEndTurn: true, attentionAt: 1900 }), ['child']);
  assert.deepEqual(pending([start], { explicitEndTurn: true, attentionAt: 900 }, 122000), []);
  assert.deepEqual(pendingAgents([start], parent, () => { throw new Error('missing'); }, 122000), []);
  assert.deepEqual(pendingAgents([start], parent, () => ({ explicitEndTurn: false, attentionAt: 1400 }), 3000, { child: 1500 }), [], 'parent cancellation clears a mid-tool child');
  assert.deepEqual(pendingAgents([{ ...start, at: 2000 }], parent, () => ({ explicitEndTurn: false, attentionAt: 2400 }), 3000, { child: 1500 }), ['child'], 'old cancellation does not clear a resumed child');
  assert.deepEqual(pendingAgents([start], parent, () => ({ explicitEndTurn: false, attentionAt: 2400 }), 3000, { child: 1500 }), ['child'], 'new child activity beats delayed old completion delivery');
});

test('lifecycle files stay bounded per session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-lifecycle-'));
  try {
    for (let i = 0; i < 270; i++) record(root, { session_id: 'session', hook_event_name: 'SubagentStart', agent_id: `child-${i}` });
    assert.equal(fs.readdirSync(path.join(root, '.keep/lifecycle/session')).length, 256);
    for (let i = 0; i < 70; i++) record(root, { session_id: 'session', hook_event_name: 'PreToolUse', tool_use_id: `tool-${i}`, tool_name: 'Read' });
    const events = read(root, 'session');
    assert.equal(events.filter((event) => event.event === 'SubagentStart').length, 256, 'tool churn cannot evict child evidence');
    assert.equal(events.filter((event) => event.event === 'PreToolUse').length, 64);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fresh turn/tool signals supersede stale dependency and prompt state, then reconcile', () => {
  const event = { event: 'UserPromptSubmit', entity: 'turn', at: 2000 };
  const old = { attentionAt: 1000, endedTurn: true, pendingQuestion: { question: 'Old question' }, taskStatus: 'waiting' };
  const status = require('./session-status');
  assert.equal(status.activity({ ...old, lifecycleForeground: foreground([event], old, 2100) }).state, 'running');
  assert.equal(foreground([event], { ...old, attentionAt: 2001 }, 2100), null, 'new transcript wins');
  assert.equal(foreground([event], old, 32000), null, 'missing end hook cannot stick');
  assert.equal(foreground([{ ...event, event: 'Stop' }], old, 2100), null, 'Stop hook is not proof a blocked stop finished');
  const permission = { ...event, event: 'PermissionRequest', at: 2001 };
  assert.equal(status.activity({ ...old, lifecycleForeground: foreground([event, permission], old, 2100) }).reason, 'permission');
  const wait = { ...event, event: 'PreToolUse', tool: 'Bash', wait: 'lock' };
  assert.equal(foreground([wait], old, 2100).state, 'waiting');
  assert.equal(foreground([wait, { ...wait, event: 'PostToolUse', at: 2002 }], old, 2100).state, 'running');
  assert.equal(foreground([{ ...wait, tool: 'AskUserQuestion' }], old, 2100), null);
});
