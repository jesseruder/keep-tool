'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
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
    accounts: { get: (id) => id === target.id ? target : null, list: () => [target] },
    sourceFor: () => ({ agent: 'codex', accountId: 'codex/default', cwd, file: transcript, title: 'Source' }),
    taskForSession: () => task,
    nextStep: () => ({ state: 'doing', text: 'Validate the fresh destination and wait.' }),
    taskFile: () => path.join(root, 'tasks', `${task.id}.md`),
    gitSnapshot: () => ({ available: true, cwd, top: cwd, commonDir: path.join(root, '.git'),
      head: '0123456789abcdef', branch: 'wt/portable', status: ' M bin/portable-handoff.js',
      contentDigest: 'git-content-v1' }),
    storePackage: ({ cardId, fileName, content }) => {
      const directory = path.join(root, '.keep', 'artifacts', cardId); fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, fileName); fs.writeFileSync(file, content); stored.push({ cardId, file, content }); return file;
    },
    open: async (payload) => { opened.push(payload); return { sessionId: 'destination-session-5678', pane: 'pane-destination', accountId: target.id }; },
    inspectSource: async () => ({ session: { endedTurn: true, state: 'needs-input', project: cwd } }),
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
    const listed = portable.list(f.root);
    assert.equal(listed.length, 1);
    assert.deepEqual({ id: listed[0].id, status: listed[0].status, sourceSessionId: listed[0].sourceSessionId,
      targetAccountId: listed[0].targetAccountId }, {
      id: prepared.requestKey, status: 'prepared', sourceSessionId: 'source-session-1234', targetAccountId: f.target.id,
    });
    assert.equal(Object.hasOwn(listed[0], 'contextFile'), false);
    assert.equal(Object.hasOwn(listed[0], 'sourceTranscriptDigest'), false);
    const content = fs.readFileSync(prepared.artifactFile, 'utf8');
    assert.match(content, /fresh codex conversation/);
    assert.match(content, /Source session: source-session-1234/);
    assert.match(content, /Destination account: codex-secondary/);
    assert.match(content, /wt\/portable/);
    assert.match(content, /Reply TRANSFER READY, summarize, then wait/);
    assert.match(content, /Earlier summary used \[redacted token\]/);
    assert.doesNotMatch(content, /raw tool secret|OPENAI_API_KEY=secret|abcdefghijklmnop/);

    fs.appendFileSync(f.transcript, JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Command replay row' } }) + '\n');
    const launched = await portable.launchPrepared(prepared.requestKey, f.deps);
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
    await assert.rejects(portable.run(base, { ...f.deps, taskForSession: () => null }), /Link this session/);
    fs.writeFileSync(f.context, Buffer.alloc(512 * 1024 + 1));
    await assert.rejects(portable.run(base, f.deps), /too large/);
    assert.equal(f.stored.length, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('desktop draft and immutable preview include the pause contract and exact destination model', async () => {
  const f = fixture();
  try {
    const draft = await portable.draft({ sourceSessionId: 'source-session-1234' }, f.deps);
    assert.equal(draft.accountId, f.target.id);
    assert.equal(draft.context.includes('After you are asked to resume'), true);
    assert.match(draft.pausePolicy, /Automated card and Stop-hook reminders do not resume/);
    const prepared = await portable.run({ sourceSessionId: 'source-session-1234', accountId: f.target.id,
      model: 'gpt-5.6-sol', contextText: 'After Jesse asks, finish validation.', prepareOnly: true }, f.deps);
    assert.equal(prepared.policyVersion, 2);
    assert.equal(prepared.model, 'gpt-5.6-sol');
    const preview = portable.readPreview(prepared.requestKey, { root: f.root });
    assert.equal(preview.transfer.id, prepared.requestKey);
    assert.deepEqual(preview.inputs, { accountId: f.target.id, model: 'gpt-5.6-sol', cwd: f.cwd,
      context: 'After Jesse asks, finish validation.' });
    assert.match(preview.preview, /After Jesse asks, finish validation/);
    assert.match(preview.preview, /then WAIT for a new instruction from Jesse or the user/);
    assert.doesNotMatch(preview.preview, /Follow the explicit continuation context's next instruction exactly/);
    await assert.rejects(portable.run({ sourceSessionId: 'source-session-1234', accountId: f.target.id,
      model: 'claude-fable-5-1', contextText: 'wrong provider', prepareOnly: true }, f.deps), /not compatible with codex/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('desktop launch refuses stale source or package bytes and requires authoritative readiness inspection', async () => {
  const f = fixture();
  try {
    const request = { sourceSessionId: 'source-session-1234', accountId: f.target.id,
      contextText: 'Review this exact draft.', prepareOnly: true };
    await assert.rejects(portable.run(request, { ...f.deps, inspectSource: undefined }), /inspection is unavailable/);
    await assert.rejects(portable.run(request, { ...f.deps,
      gitSnapshot: () => ({ available: false, error: 'capture exceeded bound' }) }),
    (error) => error.code === 'KEEP_PORTABLE_TRANSFER_GIT');
    const staleSource = await portable.run(request, f.deps);
    fs.appendFileSync(f.transcript, `${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'new work' } })}\n`);
    await assert.rejects(portable.launchPrepared(staleSource.requestKey, f.deps),
      (error) => error.code === 'KEEP_PORTABLE_TRANSFER_STALE');

    fs.writeFileSync(f.transcript, fs.readFileSync(f.transcript, 'utf8').replace(/\{"type":"event_msg"[^\n]+new work[^\n]+\}\n$/, ''));
    const fresh = await portable.run({ ...request, contextText: 'Second exact draft.' }, f.deps);
    fs.appendFileSync(fresh.artifactFile, '\nmutated after review\n');
    await assert.rejects(portable.launchPrepared(fresh.requestKey, f.deps),
      (error) => error.code === 'KEEP_PORTABLE_TRANSFER_STALE');
    await assert.rejects(portable.launchPrepared(staleSource.requestKey, {
      ...f.deps, inspectSource: async () => ({ session: { endedTurn: false, toolRunning: true } }),
    }), (error) => error.code === 'KEEP_PORTABLE_TRANSFER_SOURCE_BUSY');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('desktop launch binds the reviewed source account, card fields, and delivered opening receipt', async () => {
  const accountChanged = fixture();
  try {
    const prepared = await portable.run({ sourceSessionId: 'source-session-1234', accountId: accountChanged.target.id,
      contextText: 'Review the source identity.', prepareOnly: true }, accountChanged.deps);
    accountChanged.deps.sourceFor = () => ({ agent: 'codex', accountId: 'codex/other', cwd: accountChanged.cwd,
      file: accountChanged.transcript, title: 'Source' });
    await assert.rejects(portable.launchPrepared(prepared.requestKey, accountChanged.deps),
      (error) => error.code === 'KEEP_PORTABLE_TRANSFER_STALE');
  } finally { fs.rmSync(accountChanged.root, { recursive: true, force: true }); }

  const cardChanged = fixture();
  try {
    const prepared = await portable.run({ sourceSessionId: 'source-session-1234', accountId: cardChanged.target.id,
      contextText: 'Review the card identity.', prepareOnly: true }, cardChanged.deps);
    cardChanged.task.fm.status = 'paused';
    await assert.rejects(portable.launchPrepared(prepared.requestKey, cardChanged.deps),
      (error) => error.code === 'KEEP_PORTABLE_TRANSFER_STALE');
  } finally { fs.rmSync(cardChanged.root, { recursive: true, force: true }); }

  const delivered = fixture();
  try {
    const prepared = await portable.run({ sourceSessionId: 'source-session-1234', accountId: delivered.target.id,
      contextText: 'Record opening delivery.', prepareOnly: true }, delivered.deps);
    delivered.deps.open = async () => {
      portable.recordDelivery(prepared.requestKey, { pane: 'pane-delivered' }, { root: delivered.root });
      throw new Error('response lost after opening delivery');
    };
    await assert.rejects(portable.launchPrepared(prepared.requestKey, delivered.deps),
      (error) => error.code === 'KEEP_PORTABLE_TRANSFER_AMBIGUOUS');
    assert.deepEqual(portable.deliveryReceipt(prepared.requestKey, { root: delivered.root }),
      { version: 1, transferId: prepared.requestKey, pane: 'pane-delivered',
        deliveredAt: portable.deliveryReceipt(prepared.requestKey, { root: delivered.root }).deliveredAt });
  } finally { fs.rmSync(delivered.root, { recursive: true, force: true }); }
});

test('source-scoped desktop lock prevents different reviewed drafts from launching two successors', async () => {
  const f = fixture();
  try {
    const first = await portable.run({ sourceSessionId: 'source-session-1234', accountId: f.target.id,
      model: 'gpt-5.6-sol', contextText: 'First reviewed draft.', prepareOnly: true }, f.deps);
    const second = await portable.run({ sourceSessionId: 'source-session-1234', accountId: f.target.id,
      model: 'gpt-5.6-terra', contextText: 'Second reviewed draft.', prepareOnly: true }, f.deps);
    assert.notEqual(first.requestKey, second.requestKey);
    let release;
    f.deps.open = async (payload) => {
      f.opened.push(payload);
      await new Promise(resolve => { release = resolve; });
      return { sessionId: 'destination-session-5678', pane: 'pane-destination', accountId: f.target.id };
    };
    const launching = portable.launchPrepared(first.requestKey, f.deps);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(portable.launchPrepared(second.requestKey, f.deps),
      (error) => ['KEEP_PORTABLE_TRANSFER_BUSY', 'KEEP_PORTABLE_TRANSFER_SOURCE_USED'].includes(error.code));
    release();
    assert.equal((await launching).status, 'done');
    await assert.rejects(portable.launchPrepared(second.requestKey, f.deps),
      (error) => error.code === 'KEEP_PORTABLE_TRANSFER_SOURCE_USED');
    assert.equal(f.opened.length, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('source-scoped desktop lock remains held while asynchronous readiness inspection is pending', async () => {
  const f = fixture();
  try {
    const first = await portable.run({ sourceSessionId: 'source-session-1234', accountId: f.target.id,
      model: 'gpt-5.6-sol', contextText: 'First reviewed draft.', prepareOnly: true }, f.deps);
    const second = await portable.run({ sourceSessionId: 'source-session-1234', accountId: f.target.id,
      model: 'gpt-5.6-terra', contextText: 'Second reviewed draft.', prepareOnly: true }, f.deps);
    let enterInspection;
    const inspectionEntered = new Promise((resolve) => { enterInspection = resolve; });
    let releaseInspection;
    const inspectionReleased = new Promise((resolve) => { releaseInspection = resolve; });
    let inspections = 0;
    f.deps.inspectSource = async () => {
      inspections++;
      if (inspections === 1) {
        enterInspection();
        await inspectionReleased;
      }
      return { session: { endedTurn: true, state: 'needs-input', project: f.cwd } };
    };

    const launching = portable.launchPrepared(first.requestKey, f.deps);
    await inspectionEntered;
    await assert.rejects(portable.launchPrepared(second.requestKey, f.deps),
      (error) => error.code === 'KEEP_PORTABLE_TRANSFER_BUSY');
    releaseInspection();
    assert.equal((await launching).status, 'done');
    assert.equal(inspections, 1, 'the competing draft never passes the source lock to inspect or launch');
    assert.equal(f.opened.length, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('direct run keeps its transaction lock through asynchronous destination opening', async () => {
  const f = fixture();
  try {
    const request = { sourceSessionId: 'source-session-1234', accountId: f.target.id,
      contextFile: f.context, cwd: f.cwd };
    await portable.run({ ...request, prepareOnly: true }, f.deps);
    let release;
    f.deps.open = async () => {
      await new Promise((resolve) => { release = resolve; });
      return { sessionId: 'destination-session-5678', pane: 'pane-destination', accountId: f.target.id };
    };
    const launching = portable.run(request, f.deps);
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(portable.run(request, f.deps),
      (error) => error.code === 'KEEP_PORTABLE_TRANSFER_BUSY');
    release();
    assert.equal((await launching).status, 'done');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('desktop source safety rejects foreground, background, native, and portable conflicts', () => {
  assert.match(portable.sourceBusyReason({ session: { endedTurn: true, observation: { foreground: { state: 'active' } } } }), /foreground/);
  assert.match(portable.sourceBusyReason({ session: { endedTurn: true, pendingBackground: true } }), /background/);
  assert.match(portable.sourceBusyReason({ session: { endedTurn: true }, nativeHandoff: {} }), /account handoff/);
  assert.match(portable.sourceBusyReason({ session: { endedTurn: true }, portableHandoff: {} }), /portable transfer/);
  assert.equal(portable.sourceBusyReason({ session: { endedTurn: true, state: 'needs-input' } }), '');
});

test('git freshness digest changes when the contents of an already-dirty file change', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-portable-git-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    git('init'); git('config', 'user.email', 'portable@example.invalid'); git('config', 'user.name', 'Portable Test');
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n'); git('add', 'tracked.txt'); git('commit', '-m', 'base');
    const nested = path.join(root, 'nested'); fs.mkdirSync(nested);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'first dirty value\n');
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'first untracked value\n');
    const first = portable.defaultGitSnapshot(nested);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'second dirty value\n');
    const second = portable.defaultGitSnapshot(nested);
    assert.equal(first.available, true);
    assert.equal(second.available, true);
    assert.equal(first.status, second.status, 'porcelain status alone cannot observe this edit');
    assert.notEqual(first.contentDigest, second.contentDigest);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'first staged value\n'); git('add', 'tracked.txt');
    const firstIndex = portable.defaultGitSnapshot(nested);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'second staged value\n'); git('add', 'tracked.txt');
    const secondIndex = portable.defaultGitSnapshot(nested);
    assert.equal(firstIndex.status, secondIndex.status);
    assert.notEqual(firstIndex.contentDigest, secondIndex.contentDigest);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
