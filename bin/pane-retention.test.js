'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const retention = require('./pane-retention.js');

const DAY = 24 * 3600e3;
const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const env = { KEEP_DAEMON_NODE: 'main' };
const id = () => `p${crypto.randomBytes(4).toString('hex')}`;
const sid = () => crypto.randomUUID();

function exited(daysAgo, meta = { agent: 'claude', sessionId: sid() }, extra = {}) {
  return { id: id(), alive: false, exitedAt: new Date(NOW - daysAgo * DAY).toISOString(), meta, ...extra };
}

function guards(overrides = {}) {
  return {
    keepRunning: new Set(), handoffSessions: new Set(), handoffPanes: new Set(), queued: new Set(),
    compaction: new Set(), deliveryPanes: new Set(), deliveryJournals: new Set(), failures: [], ...overrides,
  };
}

const removedIds = (result) => result.remove.map((entry) => entry.pane);

test('removes exited panes older than the retention window and keeps younger ones', () => {
  const old = exited(8);
  const young = exited(2);
  const alive = { id: id(), alive: true, meta: { agent: 'claude' } };
  const result = retention.plan([young, old, alive], { env, now: NOW, guards: guards() });
  assert.deepEqual(removedIds(result), [old.id]);
  assert.equal(result.remove[0].reason, 'aged');
  assert.equal(result.exited, 2);
  assert.equal(result.decisions.find((entry) => entry.pane === young.id).reason, 'retained');
});

test('KEEP_PANE_RETENTION_DAYS moves the window', () => {
  const pane = exited(3);
  assert.deepEqual(removedIds(retention.plan([pane], { env: { ...env, KEEP_PANE_RETENTION_DAYS: '2' }, now: NOW, guards: guards() })), [pane.id]);
  assert.deepEqual(removedIds(retention.plan([pane], { env, now: NOW, guards: guards() })), []);
});

test('over the cap removes oldest-exited first down to the cap', () => {
  const panes = [exited(1), exited(3), exited(2), exited(4), exited(0.5)];
  const result = retention.plan(panes, { env: { ...env, KEEP_PANE_RETENTION_MAX: '3' }, now: NOW, guards: guards() });
  assert.deepEqual(removedIds(result), [panes[3].id, panes[1].id]);
  assert.ok(result.remove.every((entry) => entry.reason === 'over-cap'));
});

test('the cap never takes a pane that exited within the last hour', () => {
  const recent = [0.01, 0.02, 0.03].map((days) => exited(days));
  const result = retention.plan(recent, { env, max: 1, now: NOW, guards: guards() });
  assert.deepEqual(removedIds(result), []);
  assert.deepEqual(result.kept.map((entry) => entry.reason), ['recent', 'recent', 'recent']);
});

test('aged panes count toward the cap before any younger pane is taken', () => {
  const panes = [exited(9), exited(8), exited(2), exited(1)];
  const result = retention.plan(panes, { env, max: 2, now: NOW, guards: guards() });
  assert.deepEqual(result.remove.map((entry) => entry.reason), ['aged', 'aged']);
});

test('a pane with no agent is a shell; an unknown agent is not a candidate', () => {
  const shell = exited(9, {});
  const bare = exited(9, undefined, { meta: undefined });
  const other = exited(9, { agent: 'mystery' });
  const result = retention.plan([shell, bare, other], { env, now: NOW, guards: guards() });
  assert.deepEqual(removedIds(result).sort(), [shell.id, bare.id].sort());
  assert.ok(result.remove.every((entry) => entry.agent === 'shell'));
});

test('panes on another node are never candidates', () => {
  const local = exited(9, { agent: 'claude' }, { node: 'main' });
  const remote = exited(9, { agent: 'claude' }, { node: 'aws1' });
  const result = retention.plan([local, remote], { env, max: 0, now: NOW, guards: guards() });
  assert.deepEqual(removedIds(result), [local.id]);
  assert.equal(result.exited, 1);
});

test('every guard spares its pane with its own reason', () => {
  const cases = {
    'handoff by pane': (pane) => guards({ handoffPanes: new Set([pane.id]) }),
    'handoff by session': (pane) => guards({ handoffSessions: new Set([pane.meta.sessionId]) }),
    'queued-transfer': (pane) => guards({ queued: new Set([pane.meta.sessionId]) }),
    'queued-transfer by pane': (pane) => guards({ queuedPanes: new Set([pane.id]) }),
    'restart by pane': (pane) => guards({ restartPanes: new Set([pane.id]) }),
    'restart by session': (pane) => guards({ restartSessions: new Set([pane.meta.sessionId]) }),
    compaction: (pane) => guards({ compaction: new Set([pane.meta.sessionId]) }),
    'delivery by pane': (pane) => guards({ deliveryPanes: new Set([pane.id]) }),
    'delivery by unreadable journal': (pane) => guards({
      deliveryJournals: new Set([require('./delivery.js').textHash(pane.meta.sessionId)]) }),
    'keep-running': (pane) => guards({ keepRunning: new Set([pane.meta.sessionId]) }),
    unreadable: () => guards({ failures: [{ reader: 'queue', error: 'boom' }] }),
  };
  for (const [name, make] of Object.entries(cases)) {
    const pane = exited(9);
    const bystander = exited(9);
    const result = retention.plan([pane, bystander], { env, now: NOW, guards: make(pane) });
    const kept = result.decisions.find((entry) => entry.pane === pane.id);
    assert.equal(kept.action, 'keep', name);
    assert.equal(kept.reason, name.split(' ')[0], name);
    if (name === 'unreadable') assert.deepEqual(removedIds(result), [], 'a failed reader removes nothing');
    else assert.deepEqual(removedIds(result), [bystander.id], name);
  }
});

test('readGuards reads the real records and protects an unparseable one by its file name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-retention-'));
  const keepDir = path.join(root, '.keep');
  const [inFlight, done, queued, unparsed, swapping, running] = [sid(), sid(), sid(), sid(), sid(), sid()];
  const handoffPane = id();
  const write = (rel, value) => {
    fs.mkdirSync(path.dirname(path.join(keepDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(keepDir, rel), typeof value === 'string' ? value : JSON.stringify(value));
  };
  write(`account-handoffs/${inFlight}.json`, { sessionId: inFlight, pane: handoffPane, status: 'verifying', updatedAt: NOW });
  write(`account-handoffs/${done}.json`, { sessionId: done, status: 'done', updatedAt: NOW });
  write(`account-handoffs/${unparsed}.json`, '{not json');
  write(`handoff-queue/${queued}.json`, { sessionId: queued, status: 'queued' });
  write(`compact/${swapping}.swap.json`, { sessionId: swapping, restoreCommand: '/model opus' });
  write('session-preferences.json', { version: 1, sessions: { [running]: { keepRunning: true } } });
  const g = retention.readGuards(root, { compactSwaps: (r) => require('./serve.js').pendingCompactSwaps(path.join(r, '.keep', 'compact')) });
  assert.deepEqual(g.failures, []);
  assert.ok(g.handoffSessions.has(inFlight) && g.handoffPanes.has(handoffPane));
  assert.ok(!g.handoffSessions.has(done), 'a done handoff holds nothing');
  assert.ok(g.handoffSessions.has(unparsed), 'an unreadable handoff record still holds its session');
  assert.ok(g.queued.has(queued));
  assert.ok(g.compaction.has(swapping));
  assert.ok(g.keepRunning.has(running));
});

test('readGuards reports an unreadable preference registry as a failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-retention-'));
  fs.mkdirSync(path.join(root, '.keep'), { recursive: true });
  fs.writeFileSync(path.join(root, '.keep', 'session-preferences.json'), '{broken');
  const g = retention.readGuards(root, { compactSwaps: () => [], deliveries: () => { throw new Error('journal dir unreadable'); } });
  assert.deepEqual(g.failures.map((failure) => failure.reader), ['keepRunning', 'deliveries']);
});

test('describe writes the health sentence', () => {
  const panes = [exited(10), exited(9), exited(8), exited(3), exited(2)];
  const g = guards({ handoffPanes: new Set([panes[1].id]), keepRunning: new Set([panes[2].meta.sessionId]) });
  const result = retention.plan(panes, { env, max: 2, now: NOW, guards: g });
  const removed = result.remove;
  assert.equal(retention.describe(result, { removed }),
    'removed 3 of 5 exited (aged 1, over cap 2), kept 2 (handoff 1, keep-running 1)');
  assert.equal(retention.describe(retention.plan([], { env, now: NOW, guards: guards() }), { removed: [] }),
    'removed 0 of 0 exited');
});

function harness(options = {}) {
  const rows = [];
  const lines = [];
  const requests = [];
  const timers = [];
  let changes = 0;
  const scheduler = retention.startScheduler({
    env: { ...env, ...options.env },
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'pane-retention-')),
    now: () => NOW,
    listPanes: async () => options.panes,
    hostRequest: async (type, params) => {
      requests.push([type, params.pane]);
      if (options.refuse?.has(params.pane)) throw new Error('pane is still alive');
      return { pane: { id: params.pane } };
    },
    record: (name, row) => rows.push([name, row]),
    write: (line) => lines.push(line),
    onChange: () => { changes += 1; },
    readers: { compactSwaps: () => [], deliveries: () => [], ...options.readers },
    setTimeout: (fn, ms) => { timers.push(['first', ms]); return {}; },
    setInterval: (fn, ms) => { timers.push(['every', ms]); return {}; },
  });
  return { scheduler, rows, lines, requests, timers, changes: () => changes };
}

test('the sweep removes at most one batch, oldest first, and says what it deferred', async () => {
  const panes = Array.from({ length: 5 }, (_, i) => exited(20 - i));
  const h = harness({ panes, env: { KEEP_PANE_RETENTION_BATCH: '2' } });
  assert.deepEqual(h.timers, [['first', 10 * 60e3], ['every', 3600e3]]);
  const outcome = await h.scheduler.tick();
  assert.deepEqual(h.requests, [['remove', panes[0].id], ['remove', panes[1].id]]);
  assert.equal(outcome.detail, 'removed 2 of 5 exited (aged 2), 3 deferred to the next sweep');
  assert.deepEqual(h.rows, [['pane-retention', { ok: true, detail: outcome.detail, cadenceMs: 3600e3 }]]);
  assert.deepEqual(h.lines, ['keep serve: pane retention removed 2 pane(s)\n']);
  assert.equal(h.changes(), 1);
});

test('a refused remove is logged and does not fail the sweep', async () => {
  const panes = [exited(9), exited(8)];
  const h = harness({ panes, refuse: new Set([panes[0].id]) });
  const outcome = await h.scheduler.tick();
  assert.equal(outcome.ok, true);
  assert.deepEqual(h.requests.map(([, pane]) => pane), [panes[0].id, panes[1].id], 'each pane asked once');
  assert.equal(h.rows[0][1].ok, true);
  assert.equal(h.rows[0][1].detail, 'removed 1 of 2 exited (aged 1), 1 refused');
  assert.match(h.lines[0], new RegExp(`could not remove ${panes[0].id}: pane is still alive`));
});

test('a quiet sweep logs nothing and broadcasts nothing', async () => {
  const h = harness({ panes: [exited(1)] });
  await h.scheduler.tick();
  assert.deepEqual(h.lines, []);
  assert.equal(h.changes(), 0);
  assert.equal(h.rows[0][1].detail, 'removed 0 of 1 exited');
});

test('an unlistable host records a failure and removes nothing', async () => {
  const h = harness({ panes: null });
  const outcome = await h.scheduler.tick();
  assert.equal(outcome.ok, false);
  assert.equal(h.rows[0][1].ok, false);
  assert.deepEqual(h.requests, []);
});

test('KEEP_PANE_RETENTION=0 disables the sweep and records why', () => {
  const h = harness({ panes: [exited(30)], env: { KEEP_PANE_RETENTION: '0' } });
  assert.equal(h.scheduler, null);
  assert.deepEqual(h.timers, []);
  assert.deepEqual(h.rows, [['pane-retention', { disabled: true, detail: 'KEEP_PANE_RETENTION=0' }]]);
});

test('keep pane gc runs the same plan, and --dry-run removes nothing', async () => {
  const { commands } = require('./commands/host.js');
  const panes = [exited(9), exited(1)];
  const requests = [];
  const client = {
    request: async (type, params) => {
      requests.push(type);
      if (type === 'list') return { panes };
      return { pane: { id: params.pane } };
    },
    close() {},
  };
  const deps = {
    connectHost: async () => client, root: fs.mkdtempSync(path.join(os.tmpdir(), 'pane-retention-')),
    now: NOW, readers: { compactSwaps: () => [], deliveries: () => [] },
  };
  const printed = [];
  const log = console.log;
  console.log = (line) => printed.push(line);
  try {
    await commands.pane(['gc', '--dry-run'], deps);
    assert.deepEqual(requests, ['list']);
    assert.deepEqual(printed, [
      `remove ${panes[0].id} claude exited ${panes[0].exitedAt.slice(0, 10)} aged`,
      `keep ${panes[1].id} retained`,
    ]);
    printed.length = 0;
    requests.length = 0;
    await commands.pane(['gc', '--days', '0'], deps);
    assert.deepEqual(requests, ['list', 'remove', 'remove']);
    assert.equal(printed.at(-1), 'removed 2 of 2 exited (aged 2)');
  } finally {
    console.log = log;
  }
});

test('a pane someone is viewing is kept', () => {
  const pane = exited(9, { agent: 'claude', sessionId: sid() }, { visibleAttached: 1 });
  const hidden = exited(9, { agent: 'claude', sessionId: sid() }, { visibleAttached: 0 });
  const result = retention.plan([pane, hidden], { env, now: NOW, guards: guards() });
  assert.deepEqual(removedIds(result), [hidden.id]);
  assert.equal(result.kept[0].reason, 'viewed');
});

test('a zero-day window still never takes a pane that exited within the hour', () => {
  const justNow = exited(10 / (24 * 60)); // ten minutes ago
  const earlier = exited(2 / 24); // two hours ago
  const result = retention.plan([justNow, earlier], { env: { ...env, KEEP_PANE_RETENTION_DAYS: '0' }, now: NOW, guards: guards() });
  assert.deepEqual(removedIds(result), [earlier.id]);
  assert.deepEqual(result.kept.map((entry) => [entry.pane, entry.reason]), [[justNow.id, 'recent']]);
});

// A graceful Claude exit leaves {agent: 'shell', sessionId: null} on the pane
// (bin/commands/hook.js releaseSessionPane), so only a guard naming the pane holds it.
test('a demoted pane is held by pane-keyed guards and not by session-keyed ones', () => {
  const session = sid();
  const byPane = {
    handoff: { handoffPanes: (p) => new Set([p.id]) },
    'queued-transfer': { queuedPanes: (p) => new Set([p.id]) },
    restart: { restartPanes: (p) => new Set([p.id]) },
    delivery: { deliveryPanes: (p) => new Set([p.id]) },
  };
  for (const [reason, [[key, make]]] of Object.entries(byPane).map(([r, o]) => [r, Object.entries(o)])) {
    const pane = exited(9, { agent: 'shell', sessionId: null });
    const result = retention.plan([pane], { env, now: NOW, guards: guards({ [key]: make(pane) }) });
    assert.deepEqual(result.kept.map((entry) => entry.reason), [reason], reason);
  }
  const bySession = ['keepRunning', 'compaction', 'handoffSessions', 'queued', 'restartSessions'];
  for (const key of bySession) {
    const pane = exited(9, { agent: 'shell', sessionId: null });
    const result = retention.plan([pane], { env, now: NOW, guards: guards({ [key]: new Set([session]) }) });
    assert.deepEqual(removedIds(result), [pane.id], `${key} cannot see a demoted pane`);
  }
});

test('an unfinished restart in session-restarts.json holds its pane and session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-retention-'));
  const file = path.join(root, '.keep', 'session-restarts.json');
  const [interrupted, finished] = [sid(), sid()];
  const [interruptedPane, finishedPane] = [id(), id()];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // What a daemon that died mid force-restart leaves behind; session-restart.js turns
  // it into recovery-needed when the next manager loads it, and saves the file itself.
  fs.writeFileSync(file, JSON.stringify([
    { sessionId: interrupted, pane: interruptedPane, pid: 101, mode: 'force', status: 'restarting', at: NOW,
      token: crypto.randomUUID(), original: { agent: 'claude', cwd: path.join(root, 'project') } },
    { sessionId: finished, pane: finishedPane, pid: 102, mode: 'now', status: 'done', at: Date.now() },
  ]) + '\n');
  const manager = require('./session-restart.js').createManager({ file, inspect: async () => ({}), restart: async () => ({}) });
  assert.equal(manager.snapshot().find((entry) => entry.sessionId === interrupted).status, 'recovery-needed');
  const g = retention.readGuards(root, { compactSwaps: () => [], deliveries: () => [] });
  assert.deepEqual(g.failures, []);
  assert.ok(g.restartPanes.has(interruptedPane) && g.restartSessions.has(interrupted));
  assert.ok(!g.restartPanes.has(finishedPane) && !g.restartSessions.has(finished), 'a done restart holds nothing');
  const demoted = { ...exited(9, { agent: 'shell', sessionId: null }), id: interruptedPane };
  const other = exited(9);
  assert.deepEqual(removedIds(retention.plan([demoted, other], { env, now: NOW, guards: g })), [other.id]);
  fs.writeFileSync(file, '{"not": "a list"}');
  assert.deepEqual(retention.readGuards(root, { compactSwaps: () => [], deliveries: () => [] }).failures.map((f) => f.reader), ['restarts']);
});

test('a guard that cannot be read turns the health row red and removes nothing', async () => {
  const h = harness({ panes: [exited(9)], readers: { restarts: () => { throw new Error('bad json'); } } });
  const outcome = await h.scheduler.tick();
  assert.equal(outcome.ok, false);
  assert.deepEqual(h.requests, []);
  assert.equal(h.rows[0][1].ok, false);
  assert.equal(h.rows[0][1].error, 'could not read restarts');
  assert.equal(h.rows[0][1].detail, 'removed 0 of 1 exited, kept 1 (unreadable 1); could not read restarts (bad json)');
});

test('keep pane gc refuses to run off the daemon node', async () => {
  const { commands } = require('./commands/host.js');
  let listed = false;
  const client = { request: async () => { listed = true; return { panes: [] }; }, close() {} };
  await assert.rejects(commands.pane(['gc', '--dry-run'], {
    connectHost: async () => client, root: fs.mkdtempSync(path.join(os.tmpdir(), 'pane-retention-')), isDaemonNode: () => false,
  }), /runs on the daemon node/);
  assert.equal(listed, false);
});
