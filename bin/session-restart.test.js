'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { refusal, createManager, RestartDeferred } = require('./session-restart');

test('Owner Restart is forced: no idle refusal, and each forced stop hands its capture to the next', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-owner-restart-')), file = path.join(root, 'queue.json');
  try {
    // Mid-turn with a tool running: an ordinary restart-now refuses it outright.
    const inspect = async () => ({ session: { id: 's', endedTurn: false, toolRunning: true },
      pane: { id: 'p', pid: 10, alive: true, meta: { sessionId: 's', agent: 'claude' } } });
    const calls = [];
    const manager = createManager({ file, inspect, restart: async (entry, options) => {
      calls.push(options);
      if (calls.length === 1) { options.onForcedStop([{ pid: 11, pidStart: 'a' }]); throw Error('ps timed out'); }
      return { ok: true };
    } });
    assert.equal((await manager.request({ sessionId: 's', pane: 'p', mode: 'now' })).status, 'failed');
    assert.equal(calls.length, 0, 'the unforced request never reached a restart');
    await assert.rejects(manager.request({ sessionId: 's', pane: 'p', mode: 'idle', ownerForce: true }), /immediate restart/);
    await assert.rejects(manager.request({ sessionId: 's', pane: 'p', mode: 'now', ownerForce: 'yes' }), /boolean/);

    const first = await manager.request({ sessionId: 's', pane: 'p', mode: 'now', ownerForce: true });
    assert.equal(first.status, 'failed');
    assert.equal(calls[0].ownerForce, true);
    assert.deepEqual(calls[0].priorForcedProcesses, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).find((e) => e.ownerForce).forcedProcesses, [{ pid: 11, pidStart: 'a' }],
      'the capture is journalled durably');
    const second = await manager.request({ sessionId: 's', pane: 'p', mode: 'now', ownerForce: true });
    assert.equal(second.status, 'done');
    assert.deepEqual(calls[1].priorForcedProcesses, [{ pid: 11, pidStart: 'a' }], 'the retry also stops what the last one captured');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a forced restart whose capture was incomplete says so, and forced and unforced requests never merge', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-owner-restart-incomplete-')), file = path.join(root, 'queue.json');
  try {
    const inspect = async () => ({ session: { id: 's', endedTurn: false },
      pane: { id: 'p', pid: 10, alive: true, meta: { sessionId: 's', agent: 'codex' } } });
    const manager = createManager({ file, inspect, restart: async (entry, options) => {
      options.onForcedStop([{ pid: 11, pidStart: 'a' }], { incomplete: true });
      throw Error('Process tree exceeds force-stop limit or lacks identity');
    } });
    const failed = await manager.request({ sessionId: 's', pane: 'p', mode: 'now', ownerForce: true });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.forcedCaptureIncomplete, true);
    assert.match(failed.reason, /may still be running/);

    // A queued unforced restart is not the forced one Owner just asked for, or the reverse.
    fs.writeFileSync(file, JSON.stringify([{ sessionId: 's', pane: 'p', pid: 10, mode: 'now', status: 'queued', at: Date.now() }]));
    const queued = createManager({ file, inspect, restart: async () => ({ ok: true }) });
    await assert.rejects(queued.request({ sessionId: 's', pane: 'p', mode: 'now', ownerForce: true }), /different restart is already pending/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cancelled force entry in a stale tick snapshot is never executed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-force-cancel-')), file = path.join(root, 'queue.json');
  try {
    fs.writeFileSync(file, JSON.stringify([{ sessionId: 'idle', pane: 'p1', pid: 10, mode: 'idle', status: 'queued' },
      { sessionId: 'force', pane: 'p2', pid: 20, mode: 'force', status: 'queued', at: Date.now() }]));
    let release, entered; const pending = new Promise(r => { release = r; }), ready = new Promise(r => { entered = r; });
    const manager = createManager({ file, inspect: async () => { entered(); await pending; return {
      session: { endedTurn: false }, pane: { pid: 10, alive: true, meta: { sessionId: 'idle' } },
    }; }, forceRestart: () => assert.fail('cancelled force must never execute') });
    const tick = manager.tick(); await ready;
    await manager.request({ sessionId: 'force', pane: 'p2', mode: 'cancel' }); release(); await tick;
    assert.equal(manager.snapshot().find(e => e.sessionId === 'force').status, 'cancelled');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('explicit force requests are durable and interrupted transactions require explicit recovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-force-manager-')), file = path.join(root, 'queue.json');
  try {
    let closed = false, saves = 0;
    const inspect = async () => ({ session: { id: 's', endedTurn: false }, pane: { id: 'p', pid: 10, alive: true, meta: { sessionId: 's' } } });
    let manager = createManager({ file, inspect, restart: () => { throw Error('must not use idle path'); }, forceRestart: async (entry, save) => {
      entry.original = { pid: 10 }; entry.phase = 'closed'; save(); closed = true; throw Error('cleanup interrupted');
    } });
    await assert.rejects(manager.request({ sessionId: 's', pane: 'p', mode: 'force' }), /confirmation/);
    await manager.request({ sessionId: 's', pane: 'p', mode: 'force', confirmInterruption: true });
    assert.equal(closed, false, 'request returns before closing its caller');
    await manager.tick(); assert.equal(manager.snapshot()[0].status, 'recovery-needed');
    assert.equal(JSON.parse(fs.readFileSync(file))[0].phase, 'closed');
    manager = createManager({ file, inspect: () => { throw Error('closed pane need not be live'); }, restart: () => {}, forceRestart: async entry => { saves++; return { pid: 20 }; } });
    await assert.rejects(manager.request({ sessionId: 's', pane: 'p', mode: 'force', confirmInterruption: true }), /recovery/);
    await manager.request({ sessionId: 's', pane: 'p', mode: 'recover', confirmInterruption: true });
    await manager.tick(); assert.equal(manager.snapshot()[0].status, 'done'); assert.equal(saves, 1);
    fs.writeFileSync(file, JSON.stringify([{ sessionId: 's', mode: 'force', status: 'restarting', original: { pid: 10 }, at: Date.now() }]));
    manager = createManager({ file, inspect, restart: () => {} });
    assert.equal(manager.snapshot()[0].status, 'recovery-needed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('a concurrent inspect cannot queue around a newly interrupted journal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-force-raced-')), file = path.join(root, 'queue.json');
  try {
    let release, entered, calls = 0; const pending = new Promise(r => { release = r; }), ready = new Promise(r => { entered = r; });
    const manager = createManager({ file, inspect: async () => {
      if (++calls === 1) { entered(); await pending; }
      return { session: { id: 's' }, pane: { id: 'p', pid: 10, alive: true, meta: { sessionId: 's' } } };
    }, forceRestart: async (entry, save) => { entry.original = { pid: 10 }; save(); throw Error('interrupted'); } });
    const body = { sessionId: 's', pane: 'p', mode: 'force', confirmInterruption: true };
    const first = manager.request(body); await ready;
    await manager.request(body); await manager.tick(); release();
    await assert.rejects(first, /explicit recovery/);
    assert.deepEqual(manager.snapshot().map(e => e.status), ['recovery-needed']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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

test('restart readiness protects active work, decisions, and viewed queued panes', () => {
  const session = { id: 's', state: 'idle', endedTurn: true };
  const pane = { alive: true, attached: 0, meta: { sessionId: 's', agent: 'codex' } };
  assert.equal(refusal(session, pane), null);
  for (const patch of [{ endedTurn: false }, { pendingQuestion: {} }, { pendingBackground: true }, { toolRunning: true }, { waitingFor: 'lock' }, { unknownBackgroundJobs: ['job'] }, { lifecycleAgents: ['agent'] }, { notify: { type: 'permission' } }, { lastAssistantFull: 'Which environment?' }]) assert.ok(refusal({ ...session, ...patch }, pane));
  for (const state of ['waiting', 'idle', 'done', 'running']) {
    const stopped = { ...session, kind: 'codex', state, mtime: Date.now(), activity: { needsInput: false, background: { checkAfter: 'tomorrow' } } };
    assert.equal(refusal(stopped, pane), null, 'displayed status cannot veto a stopped safe session');
    assert.equal(require('./session-cleanup').refusal(stopped, pane, new Set(), Date.now(), { manual: true, restart: true }), null);
  }
  // The fleet reviewer may restart while its read-only pane is watched; every other
  // guard and the ordinary-session viewer guard still apply.
  assert.equal(refusal({ ...session, reviewer: true }, { ...pane, visibleAttached: 1 }, true), null);
  assert.equal(refusal(session, { ...pane, meta: { ...pane.meta, reviewer: true }, visibleAttached: 1 }, true), null);
  assert.ok(refusal({ ...session, reviewer: true, endedTurn: false }, pane));
  assert.ok(refusal(session, { ...pane, attached: 1 }, true));
  assert.equal(refusal(session, { ...pane, attached: 2, visibleAttached: 0 }, true), null);
  assert.ok(refusal(session, { ...pane, attached: 2, visibleAttached: 1 }, true));
  assert.equal(refusal(session, { ...pane, attached: 1 }), null);
  // An auto-compacted session's job ledger keeps a permanent `history-gap`. Once
  // the ledger reports that gap as settled it no longer blocks a restart or an
  // account transfer; anything else uncertain alongside it still does.
  const settledLedger = { gapSettled: true, uncertain: ['history-gap'], pending: false, jobs: [] };
  assert.equal(refusal({ ...session, unknownBackgroundJobs: ['history-gap'], backgroundJobs: settledLedger }, pane), null);
  assert.ok(refusal({ ...session, unknownBackgroundJobs: ['history-gap'] }, pane), 'an unsettled gap still refuses');
  assert.ok(refusal({ ...session, unknownBackgroundJobs: ['history-gap'],
    backgroundJobs: { ...settledLedger, gapSettled: false } }, pane));
  assert.ok(refusal({ ...session, unknownBackgroundJobs: ['history-gap', 'job'], backgroundJobs: settledLedger }, pane),
    'a settled gap excuses only itself');
  assert.ok(refusal({ ...session, unknownBackgroundJobs: ['history-gap'], pendingBackground: true,
    backgroundJobs: settledLedger }, pane));
  // The same filter is what serve.js's terminal-rate-limit path uses, so it is
  // exported rather than written out twice.
  const { blockingUnknownJobs } = require('./session-restart');
  assert.deepEqual(blockingUnknownJobs({ unknownBackgroundJobs: ['history-gap'], backgroundJobs: settledLedger }), []);
  assert.deepEqual(blockingUnknownJobs({ unknownBackgroundJobs: ['history-gap'] }), ['history-gap']);
  assert.deepEqual(blockingUnknownJobs({ unknownBackgroundJobs: ['history-gap'],
    backgroundJobs: { ...settledLedger, gapSettled: false } }), ['history-gap']);
  assert.deepEqual(blockingUnknownJobs({ unknownBackgroundJobs: ['history-gap', 'bash-7'],
    backgroundJobs: settledLedger }), ['bash-7']);
  assert.deepEqual(blockingUnknownJobs({ unknownBackgroundJobs: ['history-recovery'],
    backgroundJobs: settledLedger }), ['history-recovery']);
  assert.deepEqual(blockingUnknownJobs({}), []);
  assert.deepEqual(blockingUnknownJobs(null), []);
  assert.ok(refusal({ ...session, state: 'needs-input', activity: { reason: 'next instruction' },
    backgroundJobs: { jobs: [{ kind: 'scheduled', status: 'pending' }] } }, pane), 'a cron must be protected even when final prose looks ready');
  assert.equal(refusal({ ...session, backgroundJobs: { jobs: [{ kind: 'scheduled', status: 'cancelled' }] } }, pane), null);
});

test('an explicit force discards uncertain background evidence but never an unfinished turn', () => {
  const session = { id: 's', state: 'idle', endedTurn: true };
  const pane = { alive: true, attached: 0, meta: { sessionId: 's', agent: 'codex' } };
  const forced = { force: true };
  for (const patch of [{ unknownBackgroundJobs: ['job'] }, { lifecycleAgents: ['agent'] }, { pendingBackground: true },
    { waitingFor: 'lock' }, { backgroundJobs: { jobs: [{ kind: 'agent', status: 'pending' }] } }]) {
    assert.ok(refusal({ ...session, ...patch }, pane), 'uncertain evidence refuses without force');
    assert.equal(refusal({ ...session, ...patch }, pane, false, forced), null);
    assert.equal(require('./session-cleanup').refusal({ ...session, ...patch, kind: 'codex', mtime: Date.now() }, pane,
      new Set(), Date.now(), { manual: true, restart: true, force: true }), null);
  }
  for (const patch of [{ endedTurn: false }, { toolRunning: true }, { rateLimit: { until: 1 } },
    { lifecycleForeground: { state: 'running' } }, { lifecycleForeground: { state: 'waiting' } },
    { backgroundJobs: { jobs: [{ kind: 'scheduled', status: 'pending' }] } }, { pendingQuestion: {} },
    { notify: { type: 'permission' } }]) {
    assert.ok(refusal({ ...session, ...patch }, pane, false, forced), 'force never clears a live turn or a pending decision');
    assert.ok(require('./session-cleanup').refusal({ ...session, ...patch, kind: 'codex', mtime: Date.now() }, pane,
      new Set(), Date.now(), { manual: true, restart: true, force: true }));
  }
  assert.ok(refusal(session, { ...pane, alive: false }, false, forced), 'force never relaxes the pane check');
  assert.ok(refusal(session, { ...pane, attached: 1 }, true, forced), 'force never relaxes the viewer check');
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
    for (const kind of ['codex', 'claude']) for (const mode of ['ok', 'mcp', 'mcp-orphan', 'mcp-changed', 'bypass', 'busy', 'old-host', 'still-live', 'shell', 'shell-viewer', 'demoted', 'draft', 'child', 'other-session', 'replacement', 'pid-reused', 'viewer', 'late-viewer', 'after-input-viewer']) {
      const shellMode = ['shell', 'shell-viewer', 'demoted', 'draft', 'child', 'other-session', 'replacement'].includes(mode);
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
          if (mode === 'shell-viewer') pane.visibleAttached = 1;
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
      } else if (['mcp-orphan', 'mcp-changed', 'busy', 'old-host', 'still-live', 'shell-viewer', 'draft', 'child', 'other-session', 'replacement', 'pid-reused'].includes(mode)) {
        await assert.rejects(restartSession({ sessionId: 's', pane: 'p', pid: 10,
          mode: mode === 'shell-viewer' ? 'idle' : 'now' }, deps), undefined, `${kind}:${mode}`);
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

test('a restart names the swapped-out model when the model key is busy', async () => {
  const { restartSession, InjectionError } = require('./serve');
  const accounts = require('./accounts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-restart-busy-model-'));
  const rollout = path.join(root, 'rollout.jsonl');
  const claudeFile = path.join(root, 'claude.jsonl');
  fs.writeFileSync(claudeFile, `${JSON.stringify({ type: 'assistant', sessionId: 's', message: { content: [], stop_reason: 'end_turn' } })}\n`);
  fs.writeFileSync(rollout, `${JSON.stringify({ type: 'session_meta', payload: { id: 's', source: 'cli' } })}\n`
    + `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`);
  const configDir = path.join(root, 'secondary'); fs.mkdirSync(configDir);
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
    { id: 'secondary', label: 'Secondary', agent: 'claude', configDir },
  ], defaultAccounts: { claude: 'secondary' } }));
  try {
    // Only a Claude agent on the built-in profile reads the settings.json the swap record
    // describes. A Codex resume takes its model and reasoning effort from config.toml, and
    // a managed Claude profile reads a settings.json of its own.
    for (const profile of ['built-in', 'codex', 'managed']) {
      const kind = profile === 'codex' ? 'codex' : 'claude';
      const session = { id: 's', kind, state: 'idle', endedTurn: true, project: root };
      let pane = { id: 'p', pid: 10, cmd: '/bin/zsh', args: ['-l'], alive: true, attached: 0, visibleAttached: 0,
        cols: 80, rows: 24, meta: { sessionId: 's', agent: kind, title: 'Original' } };
      const resume = kind === 'claude' ? '--resume' : 'resume';
      const row = { pid: 11, ppid: 10, pidStart: 'Tue Sep  8 10:00:00 2026', agent: kind, interactive: true,
        args: `/test/${kind} ${resume} s` };
      const scopes = []; let exited = false, replaced = null, closed = false;
      const deps = {
        root,
        // A compaction holds the model key for its whole run; every other key is free.
        withInjectionLock: (fn, scope) => {
          scopes.push(scope);
          if (scope.model) throw new InjectionError(429, 'another session injection is busy');
          return fn();
        },
        compactionSwappedModel: () => 'claude-fable-5-1[1m]',
        buildState: async () => ({ sessions: [session], tasks: [] }),
        codexRolloutFile: () => rollout, claudeRolloutFile: () => claudeFile,
        agentProcessRows: async () => (exited ? [] : [row]),
        psTable: `11 10 ttys001 Tue Sep  8 10:00:00 2026 /test/${kind} ${resume} s`,
        lsof: async () => '',
        closeIdleSession: async (_body, guards) => {
          closed = true; await guards.beforeClose(); exited = true; pane.alive = false;
        },
        sleep: async () => {},
        readScreenResult: async () => ({ text: `${kind} ${resume} s\n~/keep > `, cursor: { x: 9, y: 1 } }),
        waitForHostAgent: async () => { assert.ok(replaced); },
        host: { request: async (type, params) => {
          if (type === 'hello') return { replaceExited: true };
          if (type === 'get') return { pane: { ...pane } };
          if (type === 'list') return { panes: [{ ...pane }] };
          if (type === 'input') return {};
          assert.equal(type, 'replace-exited');
          replaced = params; pane = { ...pane, alive: true, pid: 20 }; return { pane };
        } },
      };
      if (profile === 'managed') {
        deps.env = { KEEP_DIR: root, KEEP_CONFIG: config };
        accounts.pinSession('s', 'claude', 'secondary', { root, env: deps.env });
      }
      if (profile === 'built-in') {
        const result = await restartSession({ sessionId: 's', pane: 'p', pid: 10, mode: 'now' }, deps);
        assert.equal(result.pane, 'p');
        assert.ok(replaced.args[1].includes("'--model' 'claude-fable-5-1[1m]'"), 'resumes on the pre-swap model');
        assert.deepEqual(scopes.map(scope => Boolean(scope.model)), [true, false],
          'the second attempt holds the pane and session keys but not the model key');
      } else {
        await assert.rejects(restartSession({ sessionId: 's', pane: 'p', pid: 10, mode: 'now' }, deps),
          /another session injection is busy/, profile);
        assert.equal(replaced, null, profile);
        assert.equal(closed, false, `${profile}: the 429 comes back before the session is closed`);
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a restart may name a pane on another node, and refuses anything else', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-restart-node-')), 'restarts.json');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const manager = createManager({
    file,
    inspect: async (body) => ({
      session: { id: body.sessionId, endedTurn: true },
      pane: { id: body.pane, alive: true, pid: 42, meta: { sessionId: body.sessionId, agent: 'claude' } },
    }),
    restart: async () => ({}),
    forceRestart: async () => ({}),
  });
  const queued = await manager.request({ sessionId: 'sess-1', pane: '1a2b@aws1', mode: 'idle' });
  assert.equal(queued.pane, '1a2b@aws1', 'the node travels with the request to the router');
  await assert.rejects(manager.request({ sessionId: 'sess-2', pane: 'a@b@c', mode: 'idle' }), /Expected exact session/);
  await assert.rejects(manager.request({ sessionId: 'sess-2', pane: 'bad pane@aws1', mode: 'idle' }), /Expected exact session/);
  await assert.rejects(manager.request({ sessionId: 'sess-2', pane: '1a2b@AWS1', mode: 'idle' }), /Expected exact session/);
});

test('the two automatic paths keep refusing a pane on another node', () => {
  // Both prove what they did by reading this machine's process table, so until a
  // node can answer for its own processes (landing 1b) they refuse rather than guess.
  assert.throws(() => require('./session-retirement.js').begin('/tmp/nowhere', {
    sessionId: 'sess-1', pane: '1a2b@aws1',
  }), /bad retirement target/);
  return assert.rejects(require('./account-handoff.js').run({
    sessionId: 'sess-1', pane: '1a2b@aws1', accountId: 'claude/default',
  }), /Expected exact session, pane and target account/);
});
