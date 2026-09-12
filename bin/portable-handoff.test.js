'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const portable = require('./portable-handoff');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-portable-'));
  let cwd = path.join(root, 'worktree'); fs.mkdirSync(cwd); cwd = fs.realpathSync(cwd);
  const context = path.join(root, 'context.md'); fs.writeFileSync(context, 'Reply TRANSFER READY, summarize, then wait.');
  const transcript = path.join(root, 'rollout-source-session-1234.jsonl');
  const rows = [
    { type: 'session_meta', payload: { id: 'source-session-1234', cwd } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Implement the portable handoff.' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Implement the portable handoff.' }] } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'raw tool secret sk-tool-result-123456789' } },
    { type: 'event_msg', payload: { type: 'user_message', message: '<environment_context>OPENAI_API_KEY=secret</environment_context>' } },
    { type: 'compacted', payload: { replacement_history: [
      { role: 'assistant', content: [{ type: 'output_text', text: 'Earlier summary used sk-ant-abcdefghijklmnop.' }] },
    ] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'The implementation is ready for validation.' } },
  ];
  fs.writeFileSync(transcript, rows.map(JSON.stringify).join('\n') + '\n');
  const task = { id: 'portable-card', fm: { title: 'Portable handoff', status: 'active', project: cwd } };
  const target = { id: 'codex-secondary', label: 'Codex secondary', agent: 'codex' };
  const stored = [], opened = [];
  const deps = {
    root,
    env: { KEEP_DIR: root },
    accounts: { get: (id) => id === target.id ? target : null },
    sourceFor: () => ({ agent: 'codex', accountId: 'codex/default', cwd, file: transcript, title: 'Source' }),
    taskForSession: () => task,
    nextStep: () => ({ state: 'doing', text: 'Validate the fresh destination and wait.' }),
    taskFile: () => path.join(root, 'tasks', `${task.id}.md`),
    gitSnapshot: () => ({ available: true, cwd, top: cwd, commonDir: path.join(root, '.git'),
      head: '0123456789abcdef', branch: 'wt/portable', status: ' M bin/portable-handoff.js' }),
    storePackage: ({ cardId, fileName, content }) => {
      const directory = path.join(root, '.keep', 'artifacts', cardId); fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, fileName); fs.writeFileSync(file, content); stored.push({ cardId, file, content }); return file;
    },
    open: async (payload) => { opened.push(payload); return { sessionId: 'destination-session-5678', pane: 'pane-destination', accountId: target.id }; },
  };
  return { root, cwd, context, transcript, task, target, stored, opened, deps };
}

test('portable extraction keeps bounded conversation prose and compaction while excluding tool and environment records', () => {
  const text = [
    { type: 'event_msg', payload: { type: 'user_message', message: 'Ship this change.' } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'tool output must stay private' } },
    { type: 'event_msg', payload: { type: 'user_message', message: '<environment_context>secret env</environment_context>' } },
    { type: 'compacted', payload: { replacement_history: [{ role: 'assistant', content: [{ type: 'output_text', text: 'Summary sk-ant-abcdefghijklmnop' }] }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Ready.' } },
  ].map(JSON.stringify).join('\n');
  const excerpt = portable.extractConversation('codex', text);
  assert.match(excerpt, /Ship this change/);
  assert.match(excerpt, /Assistant \(compaction context\)/);
  assert.match(excerpt, /Summary \[redacted token\]/);
  assert.match(excerpt, /Ready/);
  assert.doesNotMatch(excerpt, /tool output|secret env|abcdefghijklmnop/);
});

test('prepared portable package launches once in the exact worktree and stays idempotent after source appends', async () => {
  const f = fixture();
  try {
    const request = { sourceSessionId: 'source-session-1234', accountId: f.target.id, contextFile: f.context,
      cwd: f.cwd, prepareOnly: true };
    const prepared = await portable.run(request, f.deps);
    assert.equal(prepared.status, 'prepared'); assert.equal(f.opened.length, 0); assert.equal(f.stored.length, 1);
    const content = fs.readFileSync(prepared.artifactFile, 'utf8');
    assert.match(content, /fresh codex conversation/);
    assert.match(content, /Source session: source-session-1234/);
    assert.match(content, /Destination account: codex-secondary/);
    assert.match(content, /wt\/portable/);
    assert.match(content, /Reply TRANSFER READY, summarize, then wait/);
    assert.match(content, /Earlier summary used \[redacted token\]/);
    assert.doesNotMatch(content, /raw tool secret|OPENAI_API_KEY=secret|abcdefghijklmnop/);

    fs.appendFileSync(f.transcript, JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Command replay row' } }) + '\n');
    const launched = await portable.run({ ...request, prepareOnly: false }, f.deps);
    assert.equal(launched.status, 'done'); assert.equal(launched.destinationSessionId, 'destination-session-5678');
    assert.equal(f.stored.length, 1); assert.equal(f.opened.length, 1);
    assert.deepEqual({ taskId: f.opened[0].taskId, fresh: f.opened[0].fresh, agent: f.opened[0].agent,
      accountId: f.opened[0].accountId, cwd: f.opened[0].cwd }, {
      taskId: f.task.id, fresh: true, agent: 'codex', accountId: f.target.id, cwd: f.cwd,
    });
    assert.match(f.opened[0].message, /fresh conversation, not a native session resume/);

    fs.appendFileSync(f.transcript, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Another replay row' } }) + '\n');
    const repeated = await portable.run({ ...request, prepareOnly: false }, f.deps);
    assert.equal(repeated.repeated, true); assert.equal(repeated.destinationSessionId, launched.destinationSessionId);
    assert.equal(f.stored.length, 1); assert.equal(f.opened.length, 1, 'ambient source appends never create a second launch');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('ambiguous launch blocks replay until an explicit destination resolution', async () => {
  const f = fixture();
  try {
    const request = { sourceSessionId: 'source-session-1234', accountId: f.target.id, contextFile: f.context, cwd: f.cwd };
    let calls = 0;
    f.deps.open = async () => { calls++; throw new Error('connection closed after spawn'); };
    await assert.rejects(portable.run(request, f.deps), (error) => error.code === 'KEEP_PORTABLE_TRANSFER_AMBIGUOUS');
    fs.appendFileSync(f.transcript, JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'CLI retry append' } }) + '\n');
    await assert.rejects(portable.run(request, f.deps), /--resolve-session/);
    assert.equal(calls, 1, 'an ambiguous API result is never launched twice');
    await assert.rejects(portable.run({ ...request, resolveSessionId: 'wrong-session-9999' }, {
      ...f.deps, validateResolution: async () => false,
    }), /does not match/);
    const resolved = await portable.run({ ...request, resolveSessionId: 'destination-session-5678' }, {
      ...f.deps, validateResolution: async (id, account, task) => id === 'destination-session-5678'
        && account.id === f.target.id && task.id === f.task.id,
    });
    assert.equal(resolved.status, 'done'); assert.equal(resolved.destinationSessionId, 'destination-session-5678');
    const repeated = await portable.run(request, f.deps);
    assert.equal(repeated.repeated, true); assert.equal(calls, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('portable transfer rejects an unknown target, same account, missing card, and oversized context before storage', async () => {
  const f = fixture();
  try {
    const base = { sourceSessionId: 'source-session-1234', accountId: f.target.id, contextFile: f.context, cwd: f.cwd, prepareOnly: true };
    await assert.rejects(portable.run({ ...base, accountId: 'missing-account' }, f.deps), /unknown destination/);
    await assert.rejects(portable.run(base, { ...f.deps,
      sourceFor: () => ({ agent: 'codex', accountId: f.target.id, cwd: f.cwd, file: f.transcript }) }), /same/);
    await assert.rejects(portable.run(base, { ...f.deps, taskForSession: () => null }), /not linked/);
    fs.writeFileSync(f.context, Buffer.alloc(512 * 1024 + 1));
    await assert.rejects(portable.run(base, f.deps), /too large/);
    assert.equal(f.stored.length, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('transfer CLI passes the explicit account, context, cwd, and prepare-only contract', async (t) => {
  const keep = require('./keep.js');
  let captured;
  t.mock.method(console, 'log', () => {});
  const result = await keep.transferCommandCli([
    'source-session-1234', '--account', 'codex-secondary', '--context', '/tmp/handoff.md',
    '--cwd', '/tmp/worktree', '--prepare-only',
  ], {
    accounts: {},
    portable: { run: async (request, deps) => {
      captured = { request, deps };
      return { status: 'prepared', requestKey: 'a'.repeat(64), artifactFile: '/tmp/package.md' };
    } },
    sourceFor: () => {}, taskForSession: () => {}, nextStep: () => {}, taskFile: () => '/tmp/card.md',
    storePackage: () => {}, gitSnapshot: () => {}, open: () => {},
  });
  assert.equal(result.status, 'prepared');
  assert.deepEqual(captured.request, {
    sourceSessionId: 'source-session-1234', accountId: 'codex-secondary', contextFile: '/tmp/handoff.md',
    cwd: '/tmp/worktree', prepareOnly: true, resolveSessionId: undefined,
  });
  assert.equal(captured.deps.accounts && typeof captured.deps.accounts, 'object');
  assert.equal(captured.deps.taskFile({}), '/tmp/card.md');
  assert.equal(typeof captured.deps.open, 'function');
  assert.match(keep.commandUsage('transfer'), /--resolve-session/);
});
