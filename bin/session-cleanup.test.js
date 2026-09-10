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

test('automatic cleanup requires old output and transcript, no viewers, and no pin', () => {
  const now = Date.now();
  const session = { id: 's', kind: 'claude', state: 'needs-input', endedTurn: true, mtime: now - 2 * 86400e3, activity: { needsInput: true, reason: 'next instruction' } };
  const pane = { id: 'p', alive: true, attached: 0, lastOutputAt: new Date(session.mtime).toISOString(), meta: { sessionId: 's', agent: 'claude' } };
  const check = (patch = {}, pins = []) => refusal(session, { ...pane, ...patch }, new Set(pins), now, { automatic: true });
  assert.equal(check(), null);
  assert.ok(check({}, ['p']));
  for (const patch of [{ attached: 1 }, { attached: undefined }, { lastOutputAt: null }, { lastOutputAt: new Date(now).toISOString() }]) assert.ok(check(patch));
});

test('automatic scheduler audits refusals and submissions, throttles attempts, and does not overlap', async () => {
  const { startScheduler } = require('./session-cleanup');
  let now = Date.now(), release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sessions = ['ok', 'refused', 'viewed'].map((id) => ({ id, pane: id, kind: 'claude', state: 'done', endedTurn: true, mtime: now - 2 * 86400e3 }));
  const panes = sessions.map((s) => ({ id: s.id, alive: true, attached: s.id === 'viewed' ? 1 : 0, lastOutputAt: new Date(s.mtime).toISOString(), meta: { sessionId: s.id, agent: 'claude' } }));
  const closed = [], records = [];
  const scheduler = startScheduler({ now: () => now,
    snapshot: async () => { await gate; return { sessions, panes, pinned: new Set() }; },
    close: async ({ sessionId }) => { closed.push(sessionId); if (sessionId === 'refused') throw new Error('draft'); },
    record: (entry) => records.push(entry),
  });
  try {
    assert.equal(closed.length, 0, 'no startup burst');
    const first = scheduler.tick();
    await scheduler.tick();
    release(); await first;
    assert.deepEqual(closed, ['ok', 'refused']);
    assert.deepEqual(records.map((r) => r.outcome), ['exit requested', 'not closed: draft']);
    await scheduler.tick(); assert.equal(closed.length, 2);
    now += 3600e3; await scheduler.tick(); assert.equal(closed.length, 4);
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

test('Close UI sends exact target immediately and reports refusal without dismissing the session', async () => {
  const vm = require('node:vm');
  const writes = [], toasts = [];
  const { createClosingSessions } = await import('../web/app/closing-sessions.js');
  const closingSessions = createClosingSessions();
  let fail = false, refreshes = 0, pinned = true, unpins = 0;
  const context = vm.createContext({ write: async (...args) => { writes.push(args); if (fail) throw new Error('unsent draft'); return { closed: true }; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/app/close-session.js'), 'utf8').replace(/^import .*;\n/gm, '').replace('export async function', 'async function'), context);
  const ctx = { closingSessions, beginClose: (id, pane) => closingSessions.begin(id, pane),
    reload: async () => { closingSessions.reconcile({ sessions: [], panes: [] }); refreshes++; },
    toast: (text) => toasts.push(text), refresh: () => refreshes++, isPanePinned: () => pinned,
    pinPane: async (pane) => { assert.equal(pane, 'p'); unpins++; pinned = false; return true; } };
  const button = { disabled: false };
  await context.closeSession(ctx, 's', 'p', button);
  assert.equal(JSON.stringify(writes[0]), JSON.stringify(['/api/close-session', { sessionId: 's', pane: 'p' }]));
  assert.equal(refreshes, 1);
  assert.match(toasts.at(-1), /Session closed/);
  assert.equal(unpins, 1);
  assert.equal(pinned, false);
  pinned = true;
  fail = true;
  await context.closeSession(ctx, 's', 'p', button);
  assert.match(toasts.at(-1), /Not closed: unsent draft/);
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
