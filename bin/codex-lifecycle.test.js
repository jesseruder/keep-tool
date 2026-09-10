'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const hooks = require('./codex-lifecycle');
const lifecycle = require('./session-lifecycle');

test('Codex foreground hooks validate thread identity and persist no prompt/tool data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-hooks-'));
  try {
    const file = path.join(root, 'parent.jsonl');
    const meta = (payload) => fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload }) + '\n');
    meta({ id: 'parent', session_id: 'parent' });
    const base = { session_id: 'parent', transcript_path: file, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'secret' };
    assert.equal(hooks.record(root, base, 1000), true);
    assert.equal(hooks.state(root, { id: 'parent', attentionAt: 900 }, 1100).lifecycleForeground.state, 'running');
    assert.equal(hooks.state(root, { id: 'parent', attentionAt: 1001 }, 1100).lifecycleForeground, null);
    assert.equal(hooks.state(root, { id: 'parent' }, 31000).lifecycleForeground, null);
    hooks.record(root, { ...base, hook_event_name: 'PreToolUse', tool_use_id: 't', tool_name: 'Bash', tool_input: { command: 'keep wait --no-hold /repo --scope lock', secret: 'secret' } }, 1100);
    assert.equal(hooks.state(root, { id: 'parent' }, 1200).lifecycleForeground.state, 'waiting');
    hooks.record(root, { ...base, hook_event_name: 'PostToolUse', tool_use_id: 't', tool_name: 'Bash' }, 1300);
    assert.equal(hooks.state(root, { id: 'parent' }, 1400).lifecycleForeground.state, 'running');
    hooks.record(root, { ...base, hook_event_name: 'PermissionRequest' }, 1500);
    assert.equal(hooks.state(root, { id: 'parent' }, 1600).lifecycleForeground.state, 'needs-input');
    hooks.record(root, { ...base, hook_event_name: 'Stop' }, 1700);
    assert.equal(hooks.state(root, { id: 'parent' }, 1800).lifecycleForeground, null);
    assert.ok(!JSON.stringify(lifecycle.read(root, 'parent', 1800)).includes('secret'));
    assert.equal(hooks.record(root, { ...base, session_id: 'wrong' }), false);
    meta({ id: 'child', session_id: 'parent', parent_thread_id: 'parent' });
    assert.equal(hooks.record(root, base), false, 'child foreground cannot alter parent');
    assert.equal(hooks.record(root, { ...base, hook_event_name: 'SubagentStart', agent_id: 'child' }), true);
    assert.equal(hooks.record(root, { ...base, hook_event_name: 'SubagentStart', agent_id: 'other' }), false);
    const run = spawnSync(process.execPath, ['bin/keep.js', 'hook', 'codex', 'lifecycle'], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, KEEP_DIR: root, HOME: root },
      input: JSON.stringify({ ...base, hook_event_name: 'SubagentStop', agent_id: 'child' }), encoding: 'utf8', timeout: 10000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '{}\n', 'observation never injects text or blocks the turn');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Codex child starts and blocked stops reconcile against child transcript completion and resume', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-children-'));
  try {
    const date = new Date();
    const dir = path.join(root, '.codex', 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'rollout-child.jsonl');
    const script = `
      const fs=require('fs'), h=require('./bin/codex-lifecycle'), l=require('./bin/session-lifecycle');
      const root=${JSON.stringify(root)}, file=${JSON.stringify(file)};
      function write(type, at) { fs.writeFileSync(file, [
        {type:'session_meta',payload:{id:'child',session_id:'parent',parent_thread_id:'parent'}},
        {timestamp:new Date(at).toISOString(),type:'event_msg',payload:{type}}
      ].map(JSON.stringify).join('\\n')+'\\n'); }
      const event={session_id:'parent',agent_id:'child',hook_event_name:'SubagentStart'};
      l.record(root,event,1000); write('task_started',1100);
      const pending=()=>h.state(root,{id:'parent',endedTurn:true},2000).lifecycleAgents;
      const realRead=fs.readdirSync; let walks=0;
      fs.readdirSync=(p,...args)=>{if(String(p).includes('/.codex/sessions/'))walks++;return realRead(p,...args)};
      const start=pending(); const initialWalks=walks; pending();
      if(walks!==initialWalks)throw new Error('repeated child path walk');
      l.record(root,{...event,hook_event_name:'SubagentStop'},1200);
      const blockedStop=pending(); write('task_complete',1300); const done=pending();
      write('task_started',1500); const resumed=pending();
      write('task_complete',1600); const redone=pending();
      const parentFile=require('path').join(require('path').dirname(file),'rollout-parent.jsonl');
      fs.writeFileSync(parentFile,[{type:'session_meta',payload:{id:'parent',session_id:'parent'}},
        {timestamp:new Date(Date.now()-1000).toISOString(),type:'event_msg',payload:{type:'task_complete'}}].map(JSON.stringify).join('\\n')+'\\n');
      h.record(root,{session_id:'parent',transcript_path:parentFile,hook_event_name:'UserPromptSubmit',turn_id:'new-turn'});
      const session=require('./bin/codex').sessionFor('parent');
      const foreground=session.lifecycleForeground?.state;
      console.log(JSON.stringify({start,blockedStop,done,resumed,redone,foreground}));
    `;
    const run = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: { ...process.env, HOME: root, KEEP_DIR: root }, encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { start: ['child'], blockedStop: ['child'], done: [], resumed: ['child'], redone: [], foreground: 'running' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unanswered async questions remain actionable through foreground tool hints', () => {
  const status = require('./session-status');
  const session = { id: 'parent', endedTurn: false, pendingQuestion: { async: true, question: 'Approve?' } };
  for (const hint of [{ state: 'running', reason: 'tool activity' }, { state: 'waiting', reason: 'subagent' }]) {
    assert.equal(status.activity({ ...session, lifecycleForeground: hint }).needsInput, true);
  }
  assert.equal(status.activity({ ...session, lifecycleForeground: { state: 'running', reason: 'turn started' } }).state, 'running');
  assert.equal(status.activity({ ...session, lifecycleForeground: { state: 'needs-input', reason: 'permission' } }).request.kind, 'permission');
});
