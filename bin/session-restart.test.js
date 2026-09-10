'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { refusal, createManager, RestartDeferred } = require('./session-restart');

test('pre-input safety races stay queued, persist and retry, while hard failures do not', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-restart-race-'));
  const file = path.join(root, 'queue.json');
  const session = { id: 's', endedTurn: true };
  const pane = { pid: 1, alive: true, attached: 0, meta: { agent: 'codex', sessionId: 's' } };
  let error = new RestartDeferred('Waiting until the pane is no longer being viewed'), attempts = 0;
  const deps = { file, inspect: async () => ({ session, pane }), restart: async () => { attempts++; if (error) throw error; return {}; } };
  try {
    let m = createManager(deps);
    await m.request({ sessionId: 's', pane: 'p', mode: 'idle' });
    await m.tick(); assert.equal(m.snapshot()[0].status, 'queued');
    m = createManager(deps);
    error = null;
    await m.tick(); assert.equal(m.snapshot()[0].status, 'done'); assert.equal(attempts, 2);
    error = new Error('Background history is unverified');
    await m.request({ sessionId: 's', pane: 'p', mode: 'idle' });
    await m.tick(); assert.equal(m.snapshot().at(-1).status, 'failed');
    await m.tick(); assert.equal(attempts, 3);
    error = new RestartDeferred('Waiting for input');
    assert.equal((await m.request({ sessionId: 's', pane: 'p', mode: 'now' })).status, 'failed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('missing pane observations defer idle restarts across recovery without accepting replacement', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-restart-observation-'));
  const original = { pid: 1, alive: true, attached: 0, meta: { agent: 'codex', sessionId: 's' } };
  let pane = original, attempts = 0;
  const deps = { file: path.join(root, 'queue.json'),
    inspect: async () => ({ session: { id: 's', endedTurn: true }, pane }),
    restart: async () => { attempts++; return {}; } };
  try {
    let manager = createManager(deps);
    await manager.request({ sessionId: 's', pane: 'p', mode: 'idle' });
    pane = undefined;
    await manager.tick();
    assert.equal(manager.snapshot()[0].status, 'queued');
    assert.match(manager.snapshot()[0].reason, /observable/);
    assert.equal(attempts, 0);
    manager = createManager(deps);
    await manager.tick();
    assert.equal(manager.snapshot()[0].status, 'queued');
    pane = original;
    await manager.tick();
    assert.equal(manager.snapshot()[0].status, 'done');
    assert.equal(attempts, 1);
    await manager.request({ sessionId: 's', pane: 'p', mode: 'idle' });
    pane = null;
    await manager.tick();
    pane = { ...original, pid: 2 };
    await manager.tick();
    assert.equal(manager.snapshot().at(-1).status, 'failed');
    assert.match(manager.snapshot().at(-1).reason, /process changed/);
    assert.equal(attempts, 1);
    // Immediate requests report unavailability rather than silently queueing.
    let inspections = 0;
    manager = createManager({ ...deps, inspect: async () => ({
      session: { id: 's', endedTurn: true }, pane: ++inspections === 1 ? original : null,
    }) });
    const result = await manager.request({ sessionId: 's', pane: 'p', mode: 'now' });
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /observable/);
    assert.equal(attempts, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('restart readiness protects active work, decisions, reviewers and viewed queued panes', () => {
  const session = { id: 's', state: 'idle', endedTurn: true };
  const pane = { alive: true, attached: 0, meta: { sessionId: 's', agent: 'codex' } };
  assert.equal(refusal(session, pane), null);
  for (const patch of [{ endedTurn: false }, { reviewer: true }, { pendingQuestion: {} }, { pendingBackground: true }, { toolRunning: true }, { waitingFor: 'lock' }, { unknownBackgroundJobs: ['job'] }, { lifecycleAgents: ['agent'] }, { notify: { type: 'permission' } }, { lastAssistantFull: 'Which environment?' }]) assert.ok(refusal({ ...session, ...patch }, pane));
  for (const state of ['waiting', 'idle', 'done', 'running']) {
    const stopped = { ...session, kind: 'codex', state, mtime: Date.now(), activity: { needsInput: false, background: { checkAfter: 'tomorrow' } } };
    assert.equal(refusal(stopped, pane), null, 'displayed status cannot veto a stopped safe session');
    assert.equal(require('./session-cleanup').refusal(stopped, pane, new Set(), Date.now(), { manual: true, restart: true }), null);
  }
  assert.ok(refusal(session, { ...pane, attached: 1 }, true));
  assert.equal(refusal(session, { ...pane, attached: 2, visibleAttached: 0 }, true), null);
  assert.ok(refusal(session, { ...pane, attached: 2, visibleAttached: 1 }, true));
  assert.equal(refusal(session, { ...pane, attached: 1 }), null);
  assert.ok(refusal({ ...session, state: 'needs-input', activity: { reason: 'next instruction' },
    backgroundJobs: { jobs: [{ kind: 'scheduled', status: 'pending' }] } }, pane), 'a cron must be protected even when final prose looks ready');
  assert.equal(refusal({ ...session, backgroundJobs: { jobs: [{ kind: 'scheduled', status: 'cancelled' }] } }, pane), null);
});

test('fresh Claude --session-id processes retain verifiable identity while idle', async () => {
  const { liveSessionPids } = require('./serve');
  const live = await liveSessionPids({ agentProcessRows: async () => [{ pid: 21, ppid: 1, agent: 'claude', interactive: true,
    args: '/test/claude --dangerously-skip-permissions --session-id fresh-session' }], lsof: async () => '' });
  assert.equal(live.get('fresh-session')?.pid, 21);
  assert.equal(live.get('fresh-session')?.primary, true);
});

test('queued restarts persist, wait, cancel, deduplicate and reject process replacement', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-restart-'));
  const file = path.join(root, 'queue.json');
  let session = { id: 's', state: 'running', endedTurn: false };
  let pane = { pid: 1, alive: true, attached: 0, meta: { agent: 'claude', sessionId: 's' } };
  let restarted = 0;
  const deps = { file, inspect: async () => ({ session, pane }), restart: async () => { restarted++; return { pane: 'p' }; } };
  try {
    let manager = createManager(deps);
    await Promise.all([manager.request({ sessionId: 's', pane: 'p', mode: 'idle' }), manager.request({ sessionId: 's', pane: 'p', mode: 'idle' })]);
    assert.equal(manager.snapshot().length, 1);
    await manager.tick(); assert.equal(restarted, 0);
    manager = createManager(deps);
    session = { ...session, state: 'idle', endedTurn: true };
    pane.attached = 1;
    await manager.tick(); assert.equal(restarted, 0);
    pane.attached = 0;
    await manager.tick(); assert.equal(restarted, 1);
    await manager.request({ sessionId: 's', pane: 'p', mode: 'idle' });
    await manager.request({ sessionId: 's', pane: 'p', mode: 'cancel' });
    await manager.tick(); assert.equal(restarted, 1);
    await manager.request({ sessionId: 's', pane: 'p', mode: 'idle' });
    pane.pid = 2;
    await manager.tick(); assert.equal(restarted, 1);
    assert.equal(manager.snapshot().at(-1).status, 'failed');
    const result = await manager.request({ sessionId: 's', pane: 'p', mode: 'now' });
    assert.equal(result.status, 'done'); assert.equal(restarted, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('restart failure never retries an ambiguous in-progress transaction after daemon recovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-restart-'));
  const file = path.join(root, 'queue.json');
  try {
    fs.writeFileSync(file, JSON.stringify([{ sessionId: 's', pane: 'p', status: 'restarting', at: Date.now() }]));
    const manager = createManager({ file, inspect: () => assert.fail('must not retry'), restart: () => assert.fail('must not retry') });
    await manager.tick();
    assert.equal(manager.snapshot()[0].status, 'failed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('bounded history never evicts an older queued restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-restart-history-'));
  const file = path.join(root, 'queue.json');
  try {
    fs.writeFileSync(file, JSON.stringify([{ sessionId: 'queued', pane: 'p', status: 'queued', at: 1 },
      ...Array.from({ length: 150 }, (_, i) => ({ sessionId: `done-${i}`, status: 'done', at: Date.now() }))]));
    const manager = createManager({ file, inspect: () => {}, restart: () => {} });
    assert.equal(manager.snapshot().length, 101);
    assert.equal(manager.snapshot()[0].sessionId, 'queued');
    assert.equal(manager.snapshot()[0].status, 'queued');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('restart transaction resumes the same ID only after verified exit and preserves permission class', async () => {
  const { restartSession } = require('./serve');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-restart-transaction-'));
  const file = path.join(root, 'rollout.jsonl');
  const claudeFile = path.join(root, 'claude.jsonl');
  fs.writeFileSync(claudeFile, JSON.stringify({ type: 'assistant', sessionId: 's', message: { content: [], stop_reason: 'end_turn' } }) + '\n');
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 's', source: 'cli' } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n');
  try {
    for (const kind of ['codex', 'claude']) for (const mode of ['ok', 'mcp', 'mcp-orphan', 'mcp-changed', 'bypass', 'busy', 'old-host', 'still-live', 'shell', 'demoted', 'draft', 'child', 'other-session', 'replacement', 'pid-reused', 'viewer', 'late-viewer', 'after-input-viewer']) {
      const shellMode = ['shell', 'demoted', 'draft', 'child', 'other-session', 'replacement'].includes(mode);
      const session = { id: 's', kind, state: 'idle', endedTurn: mode !== 'busy', project: root };
      let pane = { id: 'p', pid: 10, cmd: '/bin/zsh', args: ['-l'], alive: true, attached: 0, visibleAttached: mode === 'viewer' ? 1 : 0, cols: 80, rows: 24, meta: { sessionId: 's', agent: kind, title: 'Original' } };
      const bypass = kind === 'claude' ? '--dangerously-skip-permissions' : '--dangerously-bypass-approvals-and-sandbox';
      const resume = kind === 'claude' ? '--resume' : 'resume';
      const row = { pid: 11, ppid: 10, pidStart: 'Tue Sep  8 10:00:00 2026', agent: kind, interactive: true, args: `/test/${kind} ${mode === 'bypass' ? bypass + ' ' : ''}${resume} s` };
      let exited = false, replaced = null;
      const helper = { pid: 12, ppid: 11, pidStart: 'helper-start', args: path.join(root, 'helper') };
      if (mode.startsWith('mcp')) {
        const { hash } = require('./mcp-restart');
        fs.mkdirSync(path.join(root, '.keep'), { recursive: true });
        fs.writeFileSync(helper.args, 'audited helper');
        const configFile = path.join(root, 'mcp.json'), server = { command: helper.args, args: [] };
        fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { helper: server } }));
        fs.writeFileSync(path.join(root, '.keep/mcp-restart.json'), JSON.stringify({ version: 1, servers: [{ agent: kind, restartSafe: true, audit: 'fixture', configFile, server: 'helper', definitionSha256: hash(JSON.stringify(server)), files: { [helper.args]: hash(fs.readFileSync(helper.args)) } }] }));
      }
      const deps = { root, withInjectionLock: (fn) => fn(), buildState: async () => ({ sessions: [session], tasks: [] }),
        codexRolloutFile: () => file, claudeRolloutFile: () => claudeFile, agentProcessRows: async () => !exited || mode === 'still-live' ? [row] : shellMode ? [{ pid: 10, ppid: 1, args: '/bin/zsh -l' }, ...(mode === 'child' ? [{ pid: 12, ppid: 10, args: 'some-work' }] : [])] : [],
        psTable: `11 10 ttys001 Tue Sep  8 10:00:00 2026 /test/${kind} ${resume} s`, lsof: async () => '',
        closeIdleSession: async (_body, guards) => {
          if (mode === 'pid-reused') { deps.psTable = deps.psTable.replace('10:00:00', '11:00:00'); row.pidStart = 'replacement-start'; }
          if (mode === 'after-input-viewer') guards.beforeExitInput();
          if (['late-viewer', 'after-input-viewer'].includes(mode)) pane.visibleAttached = 1;
          if (mode === 'mcp-changed') helper.pidStart = 'replaced';
          await guards.beforeClose(); exited = true; pane.alive = shellMode;
          if (['demoted', 'draft', 'child'].includes(mode)) pane.meta = { agent: 'shell' };
          if (mode === 'other-session') pane.meta = { agent: kind, sessionId: 'other' };
          if (mode === 'replacement') pane.pid = 30;
        },
        sleep: async () => {},
        readScreenResult: async () => ({ text: `${kind} ${resume} s\n~/keep > ${mode === 'draft' ? 'unsent' : ''}`, cursor: { x: 9, y: 1 } }),
        waitForHostAgent: async () => { assert.ok(exited); assert.ok(replaced); },
        host: { request: async (type, params) => {
          if (type === 'hello') return { replaceExited: mode !== 'old-host' };
          if (type === 'get') return { pane: { ...pane } };
          if (type === 'list') return { panes: [{ ...pane }] };
          if (type === 'input') { assert.equal(Buffer.from(params.data, 'base64').toString(), '\x04'); pane.alive = false; return {}; }
          assert.equal(type, 'replace-exited');
          assert.ok(exited); assert.equal(pane.alive, false);
          assert.equal(params.sessionId, pane.meta.sessionId, 'CAS uses the observed exited metadata, not an erased session link');
          replaced = params; pane = { ...pane, alive: true, pid: 20 }; return { pane };
        } },
      };
      if (mode.startsWith('mcp')) deps.agentProcessRows = async () => !exited ? [row, helper] : mode === 'mcp-orphan' ? [{ ...helper, ppid: 1 }] : [];
      if (['viewer', 'late-viewer', 'after-input-viewer'].includes(mode)) {
        await assert.rejects(restartSession({ sessionId: 's', pane: 'p', pid: 10, mode: 'idle' }, deps), error =>
          /no longer being viewed/.test(error.message) && (error instanceof RestartDeferred) === (mode !== 'after-input-viewer'));
        assert.equal(replaced, null);
      } else if (['mcp-orphan', 'mcp-changed', 'busy', 'old-host', 'still-live', 'draft', 'child', 'other-session', 'replacement', 'pid-reused'].includes(mode)) {
        await assert.rejects(restartSession({ sessionId: 's', pane: 'p', pid: 10, mode: 'now' }, deps), undefined, `${kind}:${mode}`);
        assert.equal(replaced, null);
      } else {
        const result = await restartSession({ sessionId: 's', pane: 'p', pid: 10, mode: 'now' }, deps);
        assert.equal(result.pane, 'p'); assert.equal(result.sessionId, 's');
        assert.ok(replaced.args[1].includes(`'${resume}' 's'`));
        assert.equal(replaced.args[1].includes('--dangerously'), mode === 'bypass');
        assert.equal(replaced.meta.title, 'Original');
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
