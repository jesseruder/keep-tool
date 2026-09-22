'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { refusal } = require('./session-cleanup');
const fs = require('fs'), os = require('os'), path = require('path');

test('explicit Close retires only a verified empty leftover Codex shell', async () => {
  const { closeExitedCodexShell } = require('./serve');
  const session = { id: 's', kind: 'codex' };
  const pane = { id: 'p', pid: 123, cmd: '/bin/zsh', args: ['-l'], alive: true, meta: { agent: 'codex', sessionId: 's' } };
  const line = '(base) ~/keep (main) >';
  for (const mode of ['ok', 'automatic', 'child', 'draft', 'wrong-receipt', 'cursor', 'identity', 'race', 'other-process']) {
    let writes = '', reads = 0;
    const deps = { closePolicy: { manual: mode !== 'automatic' },
      host: { request: async (type, params) => {
        if (type === 'list') return { panes: [mode === 'identity' ? { ...pane, meta: { sessionId: 'other' } } : pane] };
        if (type === 'input') { writes += Buffer.from(params.data, 'base64').toString(); return {}; }
        assert.fail(type);
      } },
      agentProcessRows: async () => [{ pid: 123, ppid: 1, args: mode === 'other-process' ? 'vim' : '/bin/zsh -l' }, ...(mode === 'child' ? [{ pid: 124, ppid: 123, args: 'codex' }] : [])],
      readScreenResult: async () => {
        reads++;
        const prompt = mode === 'draft' || (mode === 'race' && reads === 2) ? line + ' git push' : line;
        return { text: `codex resume ${mode === 'wrong-receipt' ? 'other' : 's'}\n${prompt}`, cursor: { x: prompt.length + 1, y: mode === 'cursor' ? 0 : 1 } };
      },
    };
    if (mode === 'race') await assert.rejects(closeExitedCodexShell(session, pane, deps), /changed during Close/);
    else assert.equal(await closeExitedCodexShell(session, pane, deps), mode === 'ok', mode);
    assert.equal(writes, mode === 'ok' ? '\x04' : '', mode);
  }
});

test('manual Close allows recent pinned next-instruction sessions, but not active work or prompts', () => {
  const now = Date.now();
  const session = { id: 's', kind: 'claude', state: 'needs-input', endedTurn: true, mtime: now, activity: { needsInput: true, reason: 'next instruction' } };
  const pane = { id: 'p', alive: true, meta: { sessionId: 's', agent: 'claude' } };
  const check = (patch) => refusal({ ...session, ...patch }, pane, new Set(['p']), now, { manual: true });
  assert.equal(check({}), null);
  for (const patch of [{ state: 'running' }, { reviewer: true }, { pendingQuestion: {} }, { pendingPlan: {} }, { pendingBackground: true }, { toolRunning: true }, { waitingFor: 'lock' }, { activity: { needsInput: true, reason: 'question' } }]) assert.ok(check(patch));
});

test('restart cleanup admits an idle reviewer but ordinary close still protects it', () => {
  const now = Date.now();
  const session = { id: 'rev', kind: 'claude', reviewer: true, state: 'idle', endedTurn: true, mtime: now };
  const pane = { id: 'p', alive: true, attached: 1, meta: { sessionId: 'rev', agent: 'claude', reviewer: true } };
  assert.equal(refusal(session, pane, new Set(['p']), now, { manual: true, restart: true }), null);
  assert.match(refusal(session, pane, new Set(), now, { manual: true }), /agent session is protected/);
  assert.match(refusal(session, pane, new Set(), now, { automatic: true }), /agent session is protected/);
  for (const patch of [{ endedTurn: false }, { pendingBackground: true }, { pendingQuestion: {} }, { toolRunning: true }]) {
    assert.ok(refusal({ ...session, ...patch }, pane, new Set(), now, { manual: true, restart: true }));
  }
});

test('real cleanup path closes an idle watched reviewer for restart and preserves draft and background guards', async () => {
  const { closeIdleSession } = require('./serve');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-reviewer-close-'));
  const base = { id: 'rev', kind: 'claude', reviewer: true, state: 'idle', endedTurn: true, mtime: Date.now() };
  const pane = { id: 'p', alive: true, attached: 1, visibleAttached: 1,
    meta: { sessionId: 'rev', agent: 'claude', reviewer: true } };
  try {
    fs.mkdirSync(path.join(root, '.keep'), { recursive: true });
    fs.writeFileSync(path.join(root, '.keep', 'session-restarts.json'), JSON.stringify([{
      sessionId: 'rev', status: 'restarting', mode: 'now',
    }]));
    const run = async (patch = {}, draft = '') => {
      const session = { ...base, ...patch };
      let box = draft;
      const deps = {
        root, closePolicy: { manual: true, restart: true }, restartProof: () => {},
        withInjectionLock: (fn) => fn(), buildState: () => ({ sessions: [session], tasks: [] }),
        claudeSessionFor: () => session, sleep: async () => {},
        stderr: () => {},
        readScreen: async () => `────────────────────\n❯ ${box}`,
        host: { request: async (type, params) => {
          if (type === 'list') return { panes: [pane] };
          if (type === 'input') {
            const input = Buffer.from(params.data, 'base64').toString();
            box = input === '\x7f' ? box.slice(0, -1) : box + input;
            return {};
          }
          assert.fail(type);
        } },
      };
      return { operation: closeIdleSession({ sessionId: 'rev', pane: 'p' }, deps), box: () => box };
    };
    const idle = await run();
    assert.equal((await idle.operation).closing, true);
    assert.equal(idle.box(), '/exit\r');
    for (const [patch, draft, message] of [
      [{ pendingBackground: true }, '', /background work/],
      [{}, 'unfinished command', /contains a draft/],
    ]) {
      const blocked = await run(patch, draft);
      await assert.rejects(blocked.operation, message);
      assert.equal(blocked.box(), draft);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('manual Close permits card review but preserves real prompt and activity guards', () => {
  const now = Date.now();
  for (const kind of ['claude', 'codex']) {
    const session = { id: 's', kind, state: 'needs-input', endedTurn: true, mtime: now - 2 * 86400e3, activity: { needsInput: true, reason: 'your review' } };
    const pane = { id: 'p', alive: true, attached: 0, lastOutputAt: new Date(session.mtime).toISOString(), meta: { sessionId: 's', agent: kind } };
    assert.equal(refusal(session, pane, new Set(), now, { manual: true }), null);
    assert.ok(refusal(session, pane, new Set(), now, { automatic: true }));
    assert.ok(refusal(session, pane, new Set(), now));
    for (const patch of [{ endedTurn: false }, { pendingQuestion: {} }, { pendingPlan: {} }, { toolRunning: true }, { pendingBackground: true }, { waitingFor: 'review' }]) {
      assert.ok(refusal({ ...session, ...patch }, pane, new Set(), now, { manual: true }));
    }
  }
});

test('manual Close distinguishes conversational questions from terminal dialogs', () => {
  const { activity } = require('./session-status');
  const now = Date.now();
  for (const kind of ['claude', 'codex']) {
    const base = { id: 's', kind, endedTurn: true, mtime: now - 2 * 86400e3, askedProse: true, lastAssistant: 'Want me to write the config?' };
    const pane = { id: 'p', alive: true, attached: 0, lastOutputAt: new Date(base.mtime).toISOString(), meta: { sessionId: 's', agent: kind } };
    const check = (patch, options = { manual: true }) => {
      const session = { ...base, ...patch };
      session.activity = activity(session, { live: true });
      session.state = session.activity.state;
      return refusal(session, pane, new Set(), now, options);
    };
    assert.equal(check({}), null);
    assert.ok(check({}, { automatic: true }));
    for (const patch of [{ pendingQuestion: {} }, { pendingPlan: {} }, { notify: { type: 'question' } }, { notify: { type: 'permission' } }, { toolRunning: true }, { endedTurn: false }, { pendingBackground: true }]) assert.ok(check(patch));
  }
});

test('explicit Close permits a stopped scheduled-check owner, automatic cleanup does not', () => {
  const now = Date.now();
  for (const kind of ['claude', 'codex']) {
    const session = { id: 's', kind, state: 'waiting', endedTurn: true, mtime: now - 2 * 86400e3,
      activity: { label: 'Waiting: scheduled check', needsInput: false } };
    const pane = { id: 'p', alive: true, meta: { sessionId: 's', agent: kind } };
    assert.equal(refusal(session, pane, new Set(), now, { manual: true }), null);
    assert.ok(refusal(session, pane, new Set(), now, { automatic: true }));
    for (const patch of [{ toolRunning: true }, { pendingBackground: true }, { endedTurn: false }, { pendingQuestion: {} }, { waitingFor: 'review' }]) {
      assert.ok(refusal({ ...session, ...patch }, pane, new Set(), now, { manual: true }));
    }
  }
});

test('automatic cleanup uses transcript and input clocks, actual viewers, and not saved layout membership', () => {
  const now = Date.now();
  const session = { id: 's', kind: 'claude', state: 'needs-input', endedTurn: true, mtime: now - 2 * 86400e3, activity: { needsInput: true, reason: 'next instruction' } };
  const pane = { id: 'p', alive: true, attached: 0, lastOutputAt: new Date(session.mtime).toISOString(), meta: { sessionId: 's', agent: 'claude' } };
  const check = (patch = {}, pins = []) => refusal(session, { ...pane, ...patch }, new Set(pins), now, { automatic: true });
  assert.equal(check(), null);
  assert.equal(check({}, ['p']), null);
  assert.equal(check({ lastOutputAt: null }), null);
  assert.equal(check({ lastOutputAt: new Date(now).toISOString() }), null);
  for (const patch of [{ attached: 1 }, { attached: undefined }]) assert.ok(check(patch));
});

test('automatic scheduler audits refusals and submissions, throttles attempts, and does not overlap', async () => {
  const { startScheduler } = require('./session-cleanup');
  let now = Date.now(), release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sessions = ['ok', 'refused', 'viewed'].map((id) => ({ id, pane: id, kind: 'claude', state: 'done', endedTurn: true,
    keepRunningKnown: true, mtime: now - 2 * 86400e3 }));
  const panes = sessions.map((s) => ({ id: s.id, alive: true, attached: s.id === 'viewed' ? 1 : 0,
    inputCount: 0, lastOutputAt: new Date(s.mtime).toISOString(), lastReadAt: new Date(s.mtime + 1).toISOString(),
    meta: { sessionId: s.id, agent: 'claude' } }));
  const allTasks = sessions.map((s) => ({ id: `card-${s.id}`, fm: { status: 'done', done_at: new Date(s.mtime).toISOString(), sessions: [{ id: s.id }] } }));
  const closed = [], records = [];
  const scheduler = startScheduler({ now: () => now,
    snapshot: async () => { await gate; return { sessions, panes, allTasks, pinned: new Set() }; },
    close: async ({ sessionId }) => { closed.push(sessionId); if (sessionId === 'refused') throw new Error('draft'); },
    record: (entry) => records.push(entry),
  });
  try {
    assert.equal(closed.length, 0, 'no startup burst');
    const first = scheduler.tick();
    await scheduler.tick();
    release(); await first;
    assert.deepEqual(closed, ['ok', 'refused']);
    assert.deepEqual(records.map((r) => r.outcome), ['retired: all-work-done', 'not closed: draft']);
    await scheduler.tick(); assert.equal(closed.length, 2);
    now += 3600e3; await scheduler.tick(); assert.equal(closed.length, 4);
  } finally { scheduler.stop(); }
});

test('done-close policy waits from the latest done or activity time and enforces every durable guard', () => {
  const { doneClosePlan } = require('./session-cleanup');
  const now = Date.parse('2026-09-10T12:30:00.000Z');
  const old = new Date(now - 20 * 60e3).toISOString();
  const session = { id: 's', kind: 'claude', state: 'done', endedTurn: true, mtime: now - 20 * 60e3 };
  const pane = { id: 'p', alive: true, attached: 0, inputCount: 0, lastInputAt: old,
    lastOutputAt: old, lastReadAt: new Date(now - 19 * 60e3).toISOString(), meta: { sessionId: 's', agent: 'claude' } };
  const done = { id: 'done', fm: { status: 'done', done_at: old, sessions: [{ id: 's' }] } };
  const state = { allTasks: [done], pinned: new Set() };
  assert.equal(doneClosePlan(session, pane, state, now).reason, null);
  assert.match(doneClosePlan(session, pane, { ...state, allTasks: [done, { id: 'live', fm: { status: 'review', sessions: [{ id: 's' }] } }] }, now).reason, /not done/);
  assert.match(doneClosePlan({ ...session, unknownBackgroundJobs: ['history-gap'] }, pane, state, now).reason, /activity is unknown/);
  // A settled compaction gap is the one unknown entry that is not live work.
  assert.equal(doneClosePlan({ ...session, unknownBackgroundJobs: ['history-gap'], backgroundJobs: { gapSettled: true } }, pane, state, now).reason, null);
  assert.match(doneClosePlan({ ...session, unknownBackgroundJobs: ['history-gap', 'bash-1'], backgroundJobs: { gapSettled: true } }, pane, state, now).reason, /activity is unknown/);
  assert.match(doneClosePlan(session, { ...pane, lastInputAt: new Date(now - 5 * 60e3).toISOString() }, state, now).reason, /activity within/);
  assert.match(doneClosePlan(session, { ...pane, lastOutputAt: new Date(now - 5 * 60e3).toISOString(), lastReadAt: null }, state, now).reason, /activity within/);
  assert.match(doneClosePlan(session, { ...pane, lastReadAt: new Date(now - 21 * 60e3).toISOString() }, state, now).reason, /unread/);
  assert.equal(doneClosePlan(session, pane, { ...state, pinned: new Set(['p']) }, now).reason, null);
  assert.match(doneClosePlan(session, { ...pane, attached: 1 }, state, now).reason, /Visible/);
  assert.match(doneClosePlan(session, pane, { ...state, allTasks: [] }, now).reason, /not linked/);
  const codex = { ...session, kind: 'codex' };
  const codexPane = { ...pane, meta: { sessionId: 's', agent: 'codex' } };
  assert.match(doneClosePlan(codex, codexPane, { ...state, companion: { known: true, complete: true,
    jobs: [{ id: 'detached', sessionId: 's', status: 'running' }] } }, now).reason, /running Codex companion/);
  assert.equal(doneClosePlan(codex, codexPane, { ...state, companion: { known: true, complete: true, jobs: [] } }, now).reason, null);
  assert.match(doneClosePlan(session, pane, { ...state, companion: { known: true, complete: false,
    jobs: [{ id: 'claude-launched', ownerSessionId: 's', status: 'running' }] } }, now).reason, /running Codex companion/);
  assert.equal(doneClosePlan(session, pane, { ...state, companion: { known: false, jobs: [] } }, now).reason, null);
});

test('legacy done cards begin a conservative observation window before closing', async () => {
  const { startScheduler } = require('./session-cleanup');
  let now = Date.parse('2026-09-10T12:00:00.000Z');
  const old = new Date(now - 24 * 3600e3).toISOString();
  const session = { id: 'legacy', pane: 'p', kind: 'claude', state: 'done', endedTurn: true,
    keepRunningKnown: true, mtime: now - 24 * 3600e3 };
  const pane = { id: 'p', alive: true, attached: 0, inputCount: 0, lastOutputAt: old, lastReadAt: old,
    meta: { sessionId: 'legacy', agent: 'claude' } };
  const state = { sessions: [session], panes: [pane], allTasks: [{ id: 'old-card', fm: { status: 'done', updated: old, sessions: [{ id: 'legacy' }] } }], pinned: new Set() };
  const closed = [];
  const scheduler = startScheduler({ now: () => now, doneIdleMs: 15 * 60e3, snapshot: async () => state,
    close: async (body) => closed.push(body), record: async () => {} });
  try {
    await scheduler.tick();
    assert.equal(closed.length, 0);
    now += 15 * 60e3;
    await scheduler.tick();
    assert.equal(closed.length, 1);
    assert.equal(closed[0].legacyDoneAt['old-card'], now - 15 * 60e3);
  } finally { scheduler.stop(); }
});

test('cleanup assembles host state and protects a transferred scheduled check before typing', async () => {
  const { closeIdleSession } = require('./serve');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-close-'));
  const session = { id: 's', kind: 'claude', state: 'done', endedTurn: true, mtime: Date.now() - 2 * 86400e3 };
  const pane = { id: 'p', alive: true, meta: { sessionId: 's', agent: 'claude' } };
  const host = { request: async (type) => { assert.equal(type, 'list'); return { panes: [pane] }; } };
  try {
    await assert.rejects(closeIdleSession({ sessionId: 's', pane: 'p' }, {
      root, host, withInjectionLock: (fn) => fn(),
      buildState: () => ({ sessions: [session], tasks: [{ id: 'other-card', fm: { check_after: 'future', scheduled_by: 's' } }] }),
    }), /scheduled check on another card/);
    await assert.rejects(closeIdleSession({ sessionId: 's', pane: 'p' }, {
      root, host, withInjectionLock: (fn) => fn(),
      buildState: () => ({ sessions: [{ ...session, state: 'running' }], tasks: [] }),
    }), /active, waiting/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cleanup reuses a recent pane list only for a host list timeout', async () => {
  const { closeIdleSession } = require('./serve');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-close-stale-host-'));
  const pane = { id: 'p', alive: true, meta: { sessionId: 's', agent: 'claude' } };
  const session = { id: 's', kind: 'claude', state: 'running', endedTurn: false, mtime: Date.now() };
  const base = { root, withInjectionLock: (fn) => fn(), buildState: () => ({ sessions: [session], tasks: [] }) };
  try {
    await assert.rejects(closeIdleSession({ sessionId: 's', pane: 'p' }, {
      ...base,
      listHostPaneResult: async () => ({ panes: null, failure: 'timeout', error: new Error('host request timed out (list)') }),
      lastKnownHostPanes: () => ({ panes: [pane], ageMs: 250, at: Date.now() - 250 }),
    }), /active, waiting/, 'the stale list reaches the normal close safety policy');

    await assert.rejects(closeIdleSession({ sessionId: 's', pane: 'p' }, {
      ...base,
      listHostPaneResult: async () => ({ panes: null, failure: 'unreachable', error: new Error('connect ECONNREFUSED') }),
      lastKnownHostPanes: () => assert.fail('an unreachable host must never use stale panes'),
      buildState: () => assert.fail('unreachable host must fail before close policy evaluation'),
    }), (error) => error.status === 409 && /terminal host is unreachable: connect ECONNREFUSED/.test(error.message));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('explicit cleanup protects recent, pinned, unknown, active and waiting sessions', () => {
  const now = Date.now();
  const session = { id: 's', kind: 'claude', state: 'done', endedTurn: true, mtime: now - 2 * 86400e3 };
  const pane = { id: 'p', alive: true, meta: { sessionId: 's', agent: 'claude' } };
  assert.equal(refusal(session, pane, new Set(), now), null);
  assert.match(refusal(session, pane, new Set(['p']), now), /Pinned/);
  for (const patch of [{ reviewer: true }, { state: 'running' }, { state: 'waiting' }, { state: 'needs-input' }, { endedTurn: undefined }, { pendingBackground: true }, { toolRunning: true }, { mtime: now }, { mtime: NaN }, { pendingQuestion: {} }, { rateLimit: {} }]) assert.ok(refusal({ ...session, ...patch }, pane, new Set(), now));
  assert.ok(refusal(session, { ...pane, meta: { sessionId: 'other', agent: 'claude' } }, new Set(), now));
});

test('Codex cleanup ignores instruction mentions, but stops when activity starts during process verification', async () => {
  const { closeIdleSession } = require('./serve');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-close-'));
  const file = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'AGENTS: spawn_agent for review' }] } }) + '\n');
  const base = { id: 's', kind: 'codex', state: 'done', endedTurn: true, mtime: Date.now() - 2 * 86400e3 };
  const pane = { id: 'p', alive: true, meta: { sessionId: 's', agent: 'codex' } };
  try {
    for (const race of [false, true]) {
      let current = { ...base }, typed = '';
      const host = { request: async (type, params) => {
        if (type === 'list') return { panes: [pane] };
        if (type === 'screen') return { text: typed ? `› ${typed}\n\nstatus` : '› Ask Codex to do anything' };
        if (type === 'input') { typed += Buffer.from(params.data, 'base64').toString(); return {}; }
        assert.fail(type);
      } };
      const args = { root, host, withInjectionLock: (fn) => fn(), buildState: () => ({ sessions: [{ ...base }], tasks: [] }),
        codexSessionFor: () => current, codexRolloutFile: () => file, sleep: async () => {},
        psTable: '123 1 ttys001 Tue Sep  8 10:00:00 2026 codex resume s',
        lsof: async () => { if (race) current = { ...base, endedTurn: false, toolRunning: true, mtime: Date.now() }; return ''; },
      };
      if (race) { await assert.rejects(closeIdleSession({ sessionId: 's', pane: 'p' }, args), /changed during cleanup/); assert.equal(typed, ''); }
      else { assert.equal((await closeIdleSession({ sessionId: 's', pane: 'p' }, args)).closing, true); assert.equal(typed, '/exit\r'); }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a close that carries a transfer boundary refuses on activity its own baseline cannot see', async () => {
  const { closeIdleSession } = require('./serve');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-close-boundary-'));
  const file = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n');
  const T = 1_700_000_000_000;
  // The baseline this close was handed carries no stamp of its own: it was built after
  // the caller's own check, so a turn finished in between is simply part of it by now.
  // Only the boundary the transfer named can tell that apart, and it is compared
  // against the fresh transcript read, not the baseline.
  const base = { id: 's', kind: 'codex', state: 'done', endedTurn: true, mtime: Date.now() - 2 * 86400e3 };
  const pane = { id: 'p', alive: true, meta: { sessionId: 's', agent: 'codex' } };
  const close = (over = {}) => {
    let typed = '';
    const args = { root, withInjectionLock: (fn) => fn(),
      host: { request: async (type, params) => {
        if (type === 'list') return { panes: [pane] };
        if (type === 'screen') return { text: typed ? `› ${typed}\n\nstatus` : '› Ask Codex to do anything' };
        if (type === 'input') { typed += Buffer.from(params.data, 'base64').toString(); return {}; }
        assert.fail(type);
      } },
      buildState: () => ({ sessions: [{ ...base }], tasks: [] }),
      codexSessionFor: () => ({ ...base, ...(over.lastUserAt === undefined ? {} : { lastUserAt: over.lastUserAt }) }),
      codexRolloutFile: () => file, sleep: async () => {},
      psTable: '123 1 ttys001 Tue Sep  8 10:00:00 2026 codex resume s',
      lsof: async () => '',
      ...(over.expectedNoUserActivityAfter === undefined ? {}
        : { expectedNoUserActivityAfter: over.expectedNoUserActivityAfter }),
    };
    return { typed: () => typed, run: () => closeIdleSession({ sessionId: 's', pane: 'p' }, args) };
  };
  try {
    const used = close({ expectedNoUserActivityAfter: T, lastUserAt: T + 1 });
    await assert.rejects(used.run(),
      (error) => error.status === 409 && error.message === 'Session was used after the transfer was requested');
    assert.equal(used.typed(), '', 'nothing was typed into a session the person had gone back to');

    // Equal is not after; neither is earlier, nor a transcript with no stamp at all.
    for (const lastUserAt of [T, T - 1, undefined]) {
      const fine = close({ expectedNoUserActivityAfter: T, lastUserAt });
      assert.equal((await fine.run()).closing, true, `lastUserAt ${lastUserAt} must not refuse`);
      assert.equal(fine.typed(), '/exit\r');
    }

    // A close that carries no boundary is untouched by any of it.
    const plain = close({ lastUserAt: Date.now() });
    assert.equal((await plain.run()).closing, true);
    assert.equal(plain.typed(), '/exit\r');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('automatic cleanup verifies remote children again before submitting exit', async () => {
  const { closeIdleSession } = require('./serve');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-close-children-'));
  const file = path.join(root, 'parent.jsonl'), child = path.join(root, 'child.jsonl');
  const row = (type, payload) => JSON.stringify({ type, payload }) + '\n';
  const done = row('event_msg', { type: 'task_complete' });
  const session = { id: 's', kind: 'codex', state: 'done', endedTurn: true, mtime: Date.now() - 2 * 86400e3 };
  const pane = { id: 'p', alive: true, attached: 0, lastOutputAt: new Date(session.mtime).toISOString(), meta: { sessionId: 's', agent: 'codex' } };
  try {
    for (const race of [false, true]) {
      fs.writeFileSync(file, row('session_meta', { id: 's' }) + row('event_msg', { item: { type: 'SubAgentActivity', id: 'spawn', kind: 'completed', agent_thread_id: 'child' } }) + done);
      fs.writeFileSync(child, row('session_meta', { id: 'child', parent_thread_id: 's' }) + done);
      let typed = '';
      const host = { request: async (type, params) => {
        if (type === 'list') return { panes: [pane] };
        if (type === 'screen') return { text: typed ? `› ${typed}\n\nstatus` : '› Ask Codex to do anything' };
        if (type === 'input') {
          typed += Buffer.from(params.data, 'base64').toString();
          if (race) fs.appendFileSync(child, row('event_msg', { type: 'task_started' }));
          return {};
        }
        assert.fail(type);
      } };
      const deps = { root, host, closePolicy: { automatic: true }, withInjectionLock: (fn) => fn(),
        buildState: () => ({ sessions: [session], tasks: [] }), codexSessionFor: () => session,
        codexRolloutFile: () => file, codexChildRolloutFile: () => child, sleep: async () => {},
        psTable: '123 1 ttys001 Tue Sep  8 10:00:00 2026 codex resume s', lsof: async () => '',
      };
      if (race) {
        await assert.rejects(closeIdleSession({ sessionId: 's', pane: 'p' }, deps), /changed during cleanup/);
        assert.equal(typed, '/exit'); // Never press Enter after a child resumes.
      } else {
        assert.equal((await closeIdleSession({ sessionId: 's', pane: 'p' }, deps)).closing, true);
        assert.equal(typed, '/exit\r');
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('automatic cleanup refuses a newly attached viewer before typing exit', async () => {
  const { closeIdleSession } = require('./serve');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-close-viewer-'));
  const file = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(file, '{}\n');
  const session = { id: 's', kind: 'codex', state: 'done', endedTurn: true, mtime: Date.now() - 2 * 86400e3 };
  const pane = { id: 'p', alive: true, attached: 0, lastOutputAt: new Date(session.mtime).toISOString(), meta: { sessionId: 's', agent: 'codex' } };
  let typed = '', lists = 0;
  const host = { request: async (type, params) => {
    if (type === 'list') return { panes: [{ ...pane, attached: lists++ === 0 ? 0 : 1 }] };
    if (type === 'screen') return { text: '› Ask Codex to do anything' };
    if (type === 'input') { typed += Buffer.from(params.data, 'base64').toString(); return {}; }
    assert.fail(type);
  } };
  try {
    await assert.rejects(closeIdleSession({ sessionId: 's', pane: 'p' }, {
      root, host, closePolicy: { automatic: true }, withInjectionLock: (fn) => fn(),
      buildState: () => ({ sessions: [session], tasks: [] }), codexSessionFor: () => session,
      codexRolloutFile: () => file, psTable: '123 1 ttys001 Tue Sep  8 10:00:00 2026 codex resume s',
      lsof: async () => '',
    }), /viewer/);
    assert.equal(typed, '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('done-card close authorizes its own exit input while retaining a force-time race guard', async () => {
  const { closeIdleSession } = require('./serve');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-done-close-'));
  const rollout = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(rollout, '{}\n');
  const now = Date.parse('2026-09-10T12:30:00.000Z');
  const old = new Date(now - 20 * 60e3).toISOString();
  const task = { id: 'done-card', fm: { status: 'done', done_at: old, sessions: [{ id: 's' }] } };
  const session = { id: 's', pane: 'p', kind: 'codex', state: 'done', endedTurn: true, mtime: now - 20 * 60e3 };
  const pane = { id: 'p', pid: 123, alive: true, attached: 0, inputCount: 0,
    outputCount: 0, lastInputAt: old, lastOutputAt: old, lastReadAt: old, meta: { sessionId: 's', agent: 'codex' } };
  let typed = '';
  const host = { request: async (type, params) => {
    if (type === 'list') return { panes: [{ ...pane }] };
    if (type === 'screen') return { text: typed ? `› ${typed}\n\nstatus` : '› Ask Codex to do anything' };
    if (type === 'input') {
      typed += Buffer.from(params.data, 'base64').toString();
      pane.inputCount += 1;
      pane.lastInputAt = new Date(now).toISOString();
      return {};
    }
    assert.fail(type);
  } };
  try {
    const result = await closeIdleSession({ sessionId: 's', pane: 'p' }, {
      root, host, now: () => now, closePolicy: { automatic: true, done: true, idleMs: 15 * 60e3 },
      withInjectionLock: (fn) => fn(), buildState: () => ({ sessions: [{ ...session }], tasks: [task] }),
      loadAll: () => [task], discoverCodexJobs: async () => ({ known: true, complete: true, jobs: [] }),
      codexSessionFor: () => ({ ...session }), codexRolloutFile: () => rollout, sleep: async () => {},
      psTable: '123 1 ttys001 Tue Sep  8 10:00:00 2026 codex resume s', lsof: async () => '',
    });
    assert.equal(typed, '/exit\r');
    assert.equal(result.expectedInputCount, 2);
    assert.equal(result.expectedOutputCount, 0);
    await result.beforeSignal();
    pane.inputCount += 1;
    await assert.rejects(result.beforeSignal(), /unexpected input/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('explicit Close overrides Codex child checks but automatic cleanup and identity guards remain strict', async () => {
  const { closeIdleSession } = require('./serve');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-manual-close-'));
  const session = { id: 's', kind: 'codex', state: 'done', endedTurn: true, mtime: Date.now() - 2 * 86400e3 };
  const pane = { id: 'p', alive: true, attached: 0, lastOutputAt: new Date(session.mtime).toISOString(), meta: { sessionId: 's', agent: 'codex' } };
  try {
    for (const mode of ['automatic', 'manual', 'unknown', 'scheduled', 'scheduled-auto', 'scheduled-restart']) {
      session.state = mode === 'scheduled-restart' ? 'waiting' : 'done';
      session.activity = mode === 'scheduled-restart' ? { reason: 'scheduled check', needsInput: false } : undefined;
      let typed = '';
      const tasks = mode.startsWith('scheduled') ? [{ id: 'owner', fm: { check_after: '2026-10-02T09:00', sessions: [{ id: 's' }], check: 'Read-only backup check' } }] : [];
      const tasksBefore = JSON.stringify(tasks);
      const host = { request: async (type, params) => {
        if (type === 'list') return { panes: [pane] };
        if (type === 'screen') return { text: typed ? `› ${typed}\n\nstatus` : '› Ask Codex to do anything' };
        if (type === 'input') { typed += Buffer.from(params.data, 'base64').toString(); return {}; }
        assert.fail(type);
      } };
      const deps = { root, host, closePolicy: ['automatic', 'scheduled-auto'].includes(mode) ? { automatic: true } : { manual: true, restart: mode === 'scheduled-restart' },
        withInjectionLock: (fn) => fn(), buildState: () => ({ sessions: [session], tasks }), codexSessionFor: () => session,
        codexRolloutFile: () => assert.fail('explicit Close must not require historical child-agent records'), sleep: async () => {},
        psTable: mode === 'unknown' ? '' : '123 1 ttys001 Tue Sep  8 10:00:00 2026 codex resume s\n124 123 ?? Tue Sep  8 10:00:00 2026 codex-code-mode-host', lsof: async () => '',
      };
      const operation = closeIdleSession({ sessionId: 's', pane: 'p' }, deps);
      if (['manual', 'scheduled', 'scheduled-restart'].includes(mode)) { assert.equal((await operation).closing, true); assert.equal(typed, '/exit\r'); }
      else { await assert.rejects(operation, mode === 'automatic' ? /child processes/ : mode === 'scheduled-auto' ? /scheduled check/ : /identity/); assert.equal(typed, ''); }
      assert.equal(JSON.stringify(tasks), tasksBefore, 'Close leaves scheduled recipes intact');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('automatic retirement admits only audited runtime helpers and still refuses real command children', async () => {
  const { closeIdleSession } = require('./serve');
  const { hash } = require('./mcp-restart');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-retirement-helper-'));
  const rollout = path.join(root, 'rollout.jsonl');
  const helperFile = path.join(root, 'helper');
  const configFile = path.join(root, 'mcp.json');
  const server = { command: helperFile, args: [] };
  fs.mkdirSync(path.join(root, '.keep'), { recursive: true });
  fs.writeFileSync(rollout, '{}\n');
  fs.writeFileSync(helperFile, 'audited helper');
  fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { helper: server } }));
  fs.writeFileSync(path.join(root, '.keep', 'mcp-restart.json'), JSON.stringify({ version: 1, servers: [{
    agent: 'codex', restartSafe: true, audit: 'test', configFile, server: 'helper',
    definitionSha256: hash(JSON.stringify(server)), files: { [helperFile]: hash(fs.readFileSync(helperFile)) },
  }] }));
  const now = Date.now();
  const session = { id: 's', kind: 'codex', state: 'idle', endedTurn: true, keepRunningKnown: true,
    mtime: now - 2 * 3600e3, project: root };
  const pane = { id: 'p', pid: 100, alive: true, attached: 0, visibleAttached: 0, inputCount: 0, outputCount: 0,
    lastInputAt: new Date(session.mtime).toISOString(), meta: { sessionId: 's', agent: 'codex' } };
  const parent = { pid: 123, ppid: 100, pidStart: 'parent-start', agent: 'codex', interactive: true,
    args: '/test/codex resume s' };
  try {
    for (const scenario of [
      { child: { pid: 124, ppid: 123, pidStart: 'helper-start', args: helperFile } },
      { child: { pid: 124, ppid: 123, pidStart: 'command-start', args: '/bin/bash long-running.sh' } },
      { child: { pid: 124, ppid: 123, pidStart: 'helper-pin-start', args: helperFile }, latePin: true },
      { child: { pid: 124, ppid: 123, pidStart: 'helper-needs-start', args: helperFile }, durableNeeds: true },
    ]) {
      const { child } = scenario;
      let typed = '';
      pane.inputCount = 0;
      require('./session-retirement').setKeepRunning(root, 's', false);
      const rows = [parent, child];
      const card = { id: 'card', fm: { status: 'active', updated: new Date(session.mtime).toISOString(),
        needs: ['owner'], sessions: [{ id: 's' }] } };
      const operation = closeIdleSession({ sessionId: 's', pane: 'p' }, {
        root, now: () => now, closePolicy: { automatic: true, retirement: true,
          expectedReason: scenario.durableNeeds ? 'settled-attention' : 'settled-unattended',
          attentionIdleMs: 0, unattendedIdleMs: 0 },
        withInjectionLock: (fn) => fn(),
        buildState: () => ({ sessions: [{ ...session, ...(scenario.durableNeeds ? { taskId: 'card' } : {}) }],
          tasks: scenario.durableNeeds ? [card] : [] }),
        discoverCodexJobs: async () => ({ jobs: [] }),
        beforeClose: async () => {
          if (scenario.latePin) require('./session-retirement').setKeepRunning(root, 's', true);
        },
        loadAll: () => scenario.durableNeeds ? [card] : [],
        codexSessionFor: () => ({ ...session }), codexRolloutFile: () => rollout,
        agentProcessRows: async () => rows, lsof: async () => '', sleep: async () => {},
        liveSessionPids: async () => new Map([['s', {
          pid: parent.pid, pidStart: parent.pidStart, agent: 'codex', primary: true,
        }]]),
        host: { request: async (type, params) => {
          if (type === 'list') return { panes: [{ ...pane }] };
          if (type === 'screen') return { text: typed ? `› ${typed}\n\nstatus` : '› Ask Codex to do anything' };
          if (type === 'input') { typed += Buffer.from(params.data, 'base64').toString(); pane.inputCount++; return {}; }
          assert.fail(type);
        } },
      });
      if (scenario.latePin) {
        await assert.rejects(operation, /explicitly kept running/);
        assert.equal(typed, '', 'a preference change wins the final pre-input policy check');
      } else if (child.args === helperFile) {
        assert.equal((await operation).closing, true);
        assert.equal(typed, '/exit\r');
      } else {
        await assert.rejects(operation, /Local background processes/);
        assert.equal(typed, '');
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Close UI sends exact target immediately and reports refusal without dismissing the session', async () => {
  const vm = require('node:vm');
  const writes = [], toasts = [], failures = [];
  const { createClosingSessions } = await import('../web/app/closing-sessions.js');
  const closingSessions = createClosingSessions();
  let fail = false, refreshes = 0, pinned = true, unpins = 0;
  const context = vm.createContext({
    write: async (...args) => { writes.push(args); if (fail) throw new Error('unsent draft'); return { closed: true }; },
    // The console's shared busy/failure helpers, reduced to what this test observes:
    // the button is released on settle and a failure is reported, not toasted.
    runAction: async (button, fn) => {
      if (button) button.disabled = true;
      try { return await fn(); } finally { if (button) button.disabled = false; }
    },
    reportWriteFailure: (error, { message } = {}) => failures.push(message || error.message),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/app/close-session.js'), 'utf8').replace(/^import .*;\n/gm, '').replace('export async function', 'async function'), context);
  const ctx = { closingSessions, beginClose: (id, pane) => closingSessions.begin(id, pane),
    reload: async () => { closingSessions.reconcile({ sessions: [], panes: [] }); refreshes++; },
    toast: (text) => toasts.push(text), refresh: () => refreshes++, isPanePinned: () => pinned,
    pinPane: async (pane) => { assert.equal(pane, 'p'); unpins++; pinned = false; return true; } };
  const button = { disabled: false };
  await context.closeSession(ctx, 's', 'p', button);
  assert.equal(JSON.stringify(writes[0].slice(0, 2)), JSON.stringify(['/api/close-session', { sessionId: 's', pane: 'p' }]));
  assert.equal(writes[0][3]?.label, 'Closing session', 'the write names itself for the status chip');
  assert.equal(refreshes, 1);
  assert.match(toasts.at(-1), /Session closed/);
  assert.equal(unpins, 1);
  assert.equal(pinned, false);
  pinned = true;
  fail = true;
  await context.closeSession(ctx, 's', 'p', button);
  assert.match(failures.at(-1), /Session was not closed; it is back in the list\. unsent draft/);
  assert.equal(refreshes, 2);
  assert.equal(closingSessions.has('s'), false);
  assert.equal(button.disabled, false);
  assert.equal(pinned, true);
  assert.equal(unpins, 1);
  fail = false;
  ctx.pinPane = async () => false;
  await context.closeSession(ctx, 's', 'p', button);
  assert.match(toasts.at(-1), /Session closed, but unpinning failed/);
});
