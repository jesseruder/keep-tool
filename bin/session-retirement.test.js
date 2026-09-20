'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const retirement = require('./session-retirement');

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-retirement-'));
  try { return await run(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('keep-running is explicit, durable, removable, and corrupt preference state fails closed', () => fixture((root) => {
  assert.deepEqual(retirement.preferences(root), { known: true, value: { version: 1, sessions: {} } });
  retirement.setKeepRunning(root, 'session-one', true);
  assert.equal(retirement.preferences(root).value.sessions['session-one'].keepRunning, true);
  retirement.setKeepRunning(root, 'session-one', false);
  assert.equal(retirement.preferences(root).value.sessions['session-one'], undefined);
  fs.writeFileSync(retirement.files(root).preferences, '{bad');
  assert.equal(retirement.preferences(root).known, false);
  assert.throws(() => retirement.setKeepRunning(root, 'session-one', true), /unreadable/);
}));

test('automatic retirement restores unread completion only while exited, acknowledges it, and clears on resume', () => fixture((root) => {
  retirement.begin(root, {
    sessionId: 'session-one', pane: 'pane-one', reason: 'settled-attention', idleMinutes: 31,
    activityAt: 100, notify: { type: 'complete', message: 'Finished the migration.' },
  }, 200);
  retirement.finish(root, 'session-one', 250);
  const exited = { id: 'session-one', kind: 'claude', endedTurn: true, exited: true,
    runtime: { state: 'exited' }, mtime: 100 };
  retirement.apply([exited], { root, panes: [] });
  assert.deepEqual(exited.retirement, { automatic: true, at: 250, reason: 'settled-attention', idleMinutes: 31 });
  assert.deepEqual(exited.notify, { type: 'complete', message: 'Finished the migration.' });

  assert.equal(retirement.acknowledge(root, 'session-one'), true);
  const acknowledged = { ...exited, notify: undefined, retirement: undefined };
  retirement.apply([acknowledged], { root, panes: [], write: false });
  assert.equal(acknowledged.notify, undefined, 'acknowledgement survives rebuild and restart reads');

  const resumed = { ...acknowledged, exited: false, alive: true, runtime: { state: 'live' }, retirement: undefined };
  retirement.apply([resumed], { root, panes: [{ alive: true, meta: { sessionId: 'session-one' } }] });
  assert.equal(resumed.retirement, undefined);
  assert.ok(retirement.lookup(root, 'session-one'), 'read-only state projection does not race a close transaction');
  retirement.clear(root, 'session-one');
  assert.equal(retirement.lookup(root, 'session-one'), null, 'successful resume deactivates old retirement metadata');
}));

test('a dashboard poll cannot erase a closing retirement snapshot', () => fixture((root) => {
  retirement.begin(root, { sessionId: 'closing', pane: 'pane', reason: 'all-work-done', idleMinutes: 15,
    activityAt: 1, notify: { type: 'complete', message: 'done' } });
  retirement.apply([{ id: 'closing', kind: 'claude', alive: true, exited: false, runtime: { state: 'live' } }], {
    root, panes: [{ alive: true, meta: { sessionId: 'closing' } }],
  });
  assert.equal(retirement.lookup(root, 'closing').status, 'closing');
  assert.doesNotThrow(() => retirement.finish(root, 'closing'));
}));

test('a stale close transaction cannot cancel or finish a newer retirement', () => fixture((root) => {
  const first = retirement.begin(root, { sessionId: 'racing', pane: 'pane', reason: 'settled-unattended',
    idleMinutes: 60, activityAt: 1 });
  const second = retirement.begin(root, { sessionId: 'racing', pane: 'pane', reason: 'settled-attention',
    idleMinutes: 30, activityAt: 2 });
  assert.equal(retirement.cancel(root, 'racing', first.transactionId), false);
  assert.throws(() => retirement.finish(root, 'racing', Date.now(), first.transactionId), /transaction changed/);
  assert.equal(retirement.lookup(root, 'racing').transactionId, second.transactionId);
  assert.equal(retirement.cancel(root, 'racing', second.transactionId), true);
  assert.equal(retirement.lookup(root, 'racing'), null);
}));

test('the real Claude SessionEnd hook preserves an unread completion during automatic retirement', () => fixture((root) => {
  const cli = path.join(__dirname, 'keep.js');
  const transcript = path.join(root, 'session.jsonl');
  const sid = 'retiring-claude';
  fs.writeFileSync(transcript, '');
  const input = { session_id: sid, transcript_path: transcript, cwd: root,
    last_assistant_message: 'The scheduled result is ready.' };
  const run = (hook) => spawnSync(process.execPath, [cli, 'hook', hook], {
    input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, KEEP_DIR: root },
  });
  assert.equal(run('stop').status, 0);
  const markerFile = path.join(root, '.keep', 'attention', `${sid}.json`);
  const notify = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  retirement.begin(root, { sessionId: sid, pane: 'pane', reason: 'all-work-done', idleMinutes: 15,
    activityAt: 1, notify });
  assert.equal(run('session-end').status, 0);
  assert.equal(fs.existsSync(markerFile), true, 'automatic /exit does not acknowledge an unread completion');
  retirement.finish(root, sid);
  const row = { id: sid, kind: 'claude', endedTurn: true, exited: true, runtime: { state: 'exited' }, mtime: 1 };
  retirement.apply([row], { root, panes: [] });
  assert.equal(row.notify.message, 'The scheduled result is ready.');
}));

test('pure retirement policy uses meaningful clocks and the approved 15/30/60 minute tiers', () => {
  const { retirementPlan } = require('./session-cleanup');
  const now = Date.parse('2026-09-20T12:00:00Z');
  const old = now - 2 * 3600e3;
  const pane = { id: 'pane', alive: true, attached: 0, visibleAttached: 0,
    lastInputAt: new Date(old).toISOString(), lastOutputAt: new Date(now).toISOString(),
    meta: { sessionId: 'session', agent: 'claude' } };
  const base = { id: 'session', kind: 'claude', endedTurn: true, mtime: old,
    state: 'idle', keepRunningKnown: true, activity: { needsInput: false } };
  const linked = (status, extra = {}) => ({ id: status, fm: { status, updated: new Date(old).toISOString(),
    sessions: [{ id: 'session' }], ...extra } });

  let plan = retirementPlan({ ...base, state: 'done' }, pane, {
    allTasks: [linked('done', { done_at: new Date(now - 16 * 60e3).toISOString() })], pinned: new Set(['pane']),
  }, now);
  assert.equal(plan.kind, 'all-work-done');
  assert.equal(plan.reason, null, 'saved layout membership is not a process keepalive');

  plan = retirementPlan({ ...base, state: 'needs-input', activity: { needsInput: true, reason: 'next instruction' } }, pane,
    { allTasks: [linked('active')], pinned: new Set() }, now);
  assert.equal(plan.kind, 'settled-unattended');
  assert.equal(plan.idleMs, 60 * 60e3);
  assert.equal(plan.reason, null);

  plan = retirementPlan({ ...base, state: 'needs-input', activity: {
    needsInput: true, reason: 'your review', request: { kind: 'review' },
  } }, pane, { allTasks: [linked('active')], pinned: new Set() }, now);
  assert.equal(plan.kind, 'settled-attention');
  assert.equal(plan.idleMs, 30 * 60e3);
  assert.equal(plan.reason, null);

  plan = retirementPlan(base, pane, { allTasks: [linked('active')], pinned: new Set() }, now);
  assert.equal(plan.kind, 'settled-unattended');
  assert.equal(plan.idleMs, 60 * 60e3);
  assert.equal(plan.reason, null, 'recent terminal redraw does not reset meaningful idle time');

  assert.match(retirementPlan({ ...base, keepRunning: true }, pane,
    { allTasks: [], pinned: new Set() }, now).reason, /explicitly kept running/);
  assert.match(retirementPlan({ ...base, keepRunningKnown: false }, pane,
    { allTasks: [], pinned: new Set() }, now).reason, /preference state is unknown/);
  assert.match(retirementPlan(base, { ...pane, visibleAttached: 1 },
    { allTasks: [], pinned: new Set() }, now).reason, /Visible/);
  assert.match(retirementPlan(base, { ...pane, visibleAttached: undefined, attached: undefined },
    { allTasks: [], pinned: new Set() }, now).reason, /unknown viewer/);
});

test('settled history gap is consistent while real work, prompts, timers and standing agents stay protected', () => {
  const { retirementPlan } = require('./session-cleanup');
  const now = Date.now();
  const pane = { id: 'p', alive: true, visibleAttached: 0, attached: 0,
    meta: { sessionId: 's', agent: 'claude' } };
  const base = { id: 's', kind: 'claude', state: 'idle', endedTurn: true, mtime: now - 2 * 3600e3,
    keepRunningKnown: true, unknownBackgroundJobs: ['history-gap'], backgroundJobs: { gapSettled: true, jobs: [] } };
  const state = { allTasks: [], pinned: new Set() };
  assert.equal(retirementPlan(base, pane, state, now).reason, null);
  for (const patch of [
    { unknownBackgroundJobs: ['history-gap', 'command-1'] },
    { pendingQuestion: {} },
    { pendingPlan: {} },
    { notify: { type: 'permission' } },
    { activity: { background: { scheduled: ['timer'] } } },
    { lifecycleAgents: ['worker'] },
    { reviewer: true },
    { agentName: 'responder' },
  ]) assert.ok(retirementPlan({ ...base, ...patch }, pane, state, now).reason, JSON.stringify(patch));
});

test('/api/send resumes one automatically retired thread and returns ordinary delivery shape', async () => fixture(async (root) => {
  const { sendToSessionLocked } = require('./serve');
  retirement.begin(root, { sessionId: 'send-session', pane: 'old-pane', reason: 'settled-attention', idleMinutes: 30, activityAt: 1 });
  retirement.finish(root, 'send-session');
  const calls = [];
  const result = await sendToSessionLocked({ sessionId: 'send-session', pane: 'old-pane', text: 'continue' }, {
    root,
    listHostPanes: async () => [],
    openSession: async (body) => { calls.push(['open', body]); return { ok: true, pane: 'new-pane', sessionId: body.sessionId }; },
    loadCurrentSession: () => ({ id: 'send-session', kind: 'claude', endedTurn: true }),
    resolveSessionTarget: async (_session, hint) => { calls.push(['resolve', hint]); return { pane: 'new-pane' }; },
    sendToResolvedTarget: async (_session, target, text) => { calls.push(['send', target, text]); return { ok: true, delivered: true }; },
  });
  assert.deepEqual(result, { ok: true, delivered: true });
  assert.deepEqual(calls, [
    ['open', { sessionId: 'send-session' }],
    ['resolve', undefined],
    ['send', { pane: 'new-pane' }, 'continue'],
  ]);
  assert.equal(retirement.lookup(root, 'send-session'), null);
}));

test('keep-running and acknowledgement routes persist the process preference and retire unread overlay', async () => fixture(async (root) => {
  const { routes } = require('./serve/routes');
  retirement.begin(root, { sessionId: 'route-session', pane: 'pane', reason: 'settled-attention', idleMinutes: 30,
    activityAt: 1, notify: { type: 'complete', message: 'ready' } });
  retirement.finish(root, 'route-session');
  let broadcasts = 0;
  const ctx = {
    ATTENTION_KINDS: new Set(['input']),
    attentionAckKey: (item) => `${item.sessionId}:${item.since}`,
    attentionAckName: (key) => key.replace(':', '-'),
    broadcast: () => { broadcasts++; },
    fs,
    health: { attentionItems: () => [], snapshot: () => ({}) },
    json: (_res, status, value) => ({ status, value }),
    keep: { ROOT: root },
    path,
  };
  const list = routes(ctx);
  const post = (routePath, body) => list.find((entry) => entry.path === routePath).handle({
    req: { method: 'POST' }, res: {}, url: new URL(`http://x${routePath}`), body,
  });
  assert.deepEqual(await post('/api/session-keep-running', { sessionId: 'route-session', keepRunning: true }),
    { status: 200, value: { ok: true, sessionId: 'route-session', keepRunning: true } });
  assert.equal(retirement.preferences(root).value.sessions['route-session'].keepRunning, true);
  assert.deepEqual(await post('/api/ack', { kind: 'input', sessionId: 'route-session', since: 10 }),
    { status: 200, value: { ok: true } });
  assert.equal(retirement.lookup(root, 'route-session').notify, undefined);
  assert.equal(broadcasts, 2);
}));

test('keep keep-running CLI uses the daemon contract and resolves the current session', async () => fixture(async (root) => {
  const { keepRunningCommandCli } = require('./keep.js');
  const calls = [], lines = [];
  await keepRunningCommandCli(['on'], {
    root,
    currentSession: () => ({ id: 'cli-session', agent: 'codex' }),
    postKeepApi: async (url, body) => { calls.push({ url, body }); return { status: 200, data: JSON.stringify({ ok: true }) }; },
    stdout: (line) => lines.push(line),
  });
  assert.deepEqual(calls, [{ url: '/api/session-keep-running', body: { sessionId: 'cli-session', keepRunning: true } }]);
  assert.deepEqual(lines, ['keeping cli-session']);
}));
