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

test('a plan covers one node: another node\'s panes are not its candidates', () => {
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

test('an infinite batch, as keep pane gc asks for, removes the whole plan', async () => {
  const retention = require('./pane-retention.js');
  const panes = Array.from({ length: 30 }, (_, i) => exited(40 - i));
  const result = retention.plan(panes, { now: Date.now(), env: { KEEP_PANE_RETENTION_BATCH: '2' } });
  const requests = [];
  const outcome = await retention.apply(result, async (type, params) => { requests.push([type, params.pane]); }, { batch: Infinity });
  assert.equal(requests.length, 30, 'every planned pane is asked');
  assert.equal(outcome.deferred, 0);
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
      if (type === 'hello') return { node: require('./nodes.js').daemonNode() };
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
    assert.deepEqual(requests, ['hello', 'list']);
    assert.deepEqual(printed, [
      `remove ${panes[0].id} claude exited ${panes[0].exitedAt.slice(0, 10)} aged`,
      `keep ${panes[1].id} retained`,
    ]);
    printed.length = 0;
    requests.length = 0;
    await commands.pane(['gc', '--days', '0'], deps);
    assert.deepEqual(requests, ['hello', 'list', 'remove', 'remove']);
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

// A graceful Claude exit patches the pane to agent 'shell' and sessionId null
// (bin/commands/hook.js releaseSessionPane); the host's meta handler deletes a key
// patched to null, so the pane keeps its other meta and has no sessionId at all.
// Only a guard naming the pane can hold it.
test('a demoted pane is held by pane-keyed guards and not by session-keyed ones', () => {
  const session = sid();
  const byPane = {
    handoff: { handoffPanes: (p) => new Set([p.id]) },
    'queued-transfer': { queuedPanes: (p) => new Set([p.id]) },
    restart: { restartPanes: (p) => new Set([p.id]) },
    delivery: { deliveryPanes: (p) => new Set([p.id]) },
  };
  for (const [reason, [[key, make]]] of Object.entries(byPane).map(([r, o]) => [r, Object.entries(o)])) {
    const pane = exited(9, { agent: 'shell', project: 'demo', title: 'demo' });
    const result = retention.plan([pane], { env, now: NOW, guards: guards({ [key]: make(pane) }) });
    assert.deepEqual(result.kept.map((entry) => entry.reason), [reason], reason);
  }
  const bySession = ['keepRunning', 'compaction', 'handoffSessions', 'queued', 'restartSessions'];
  for (const key of bySession) {
    const pane = exited(9, { agent: 'shell', project: 'demo', title: 'demo' });
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
  const demoted = { ...exited(9, { agent: 'shell', project: 'demo', title: 'demo' }), id: interruptedPane };
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-retention-'));
  const requests = [];
  const client = (node) => ({
    request: async (type) => { requests.push(type); return type === 'hello' ? { node } : { panes: [] }; },
    close() {},
  });
  // The environment says so: refused before any host is asked.
  await assert.rejects(commands.pane(['gc', '--dry-run'], {
    connectHost: async () => client(require('./nodes.js').daemonNode()), root, isDaemonNode: () => false,
  }), /runs on the daemon node/);
  assert.deepEqual(requests, []);
  // A bare ssh shell on another node passes the env check; the host it reaches does not.
  await assert.rejects(commands.pane(['gc', '--dry-run'], {
    connectHost: async () => client('aws1'), root, isDaemonNode: () => true,
  }), /runs on the daemon node .*this host is aws1/);
  assert.deepEqual(requests, ['hello'], 'nothing is listed once the host names another node');
  // A host booted before it named its node: the env gate is all there is, so it runs.
  requests.length = 0;
  await commands.pane(['gc', '--dry-run'], {
    connectHost: async () => client(undefined), root, isDaemonNode: () => true,
  });
  assert.deepEqual(requests, ['hello', 'list'], 'an unnamed host is taken at the env gate\'s word');
});

// A fleet listing as serve.js listHostPaneResult returns it: the daemon node's panes
// bare, every other node's qualified with its host id kept beside it.
function remote(node, daysAgo, meta, extra = {}) {
  const pane = exited(daysAgo, meta, extra);
  return { ...pane, node, id: `${pane.id}@${node}`, hostPaneId: pane.id };
}

test('planFleet plans each node apart, with its own cap', () => {
  const local = [exited(9, undefined, { node: 'main' }), exited(1, undefined, { node: 'main' })];
  const box = [remote('box', 9), remote('box', 2), remote('box', 1)];
  const fleet = retention.planFleet({ panes: [...local, ...box], failure: null, nodes: { box: { ok: true } } },
    { env, max: 2, now: NOW, guards: guards() });
  assert.deepEqual(fleet.plans.map((result) => [result.node, result.exited]), [['main', 2], ['box', 3]]);
  assert.deepEqual(removedIds(fleet.plans[0]), [local[0].id]);
  assert.deepEqual(removedIds(fleet.plans[1]), [box[0].id], 'box is over its own cap of 2 by one, the aged one');
  assert.deepEqual(fleet.skipped, []);
});

test('a pane with no node is the daemon node\'s, and a bare list plans as before', () => {
  const panes = [exited(9), exited(8)];
  const fleet = retention.planFleet(panes, { env, now: NOW, guards: guards() });
  assert.deepEqual(fleet.plans.map((result) => result.node), ['main']);
  assert.deepEqual(fleet.plans[0].decisions, retention.plan(panes, { env, now: NOW, guards: guards() }).decisions);
  // Beside another node's panes, a node-less pane is still only the daemon node's.
  const far = remote('box', 9);
  const mixed = retention.planFleet([...panes, far], { env, now: NOW, guards: guards() });
  assert.deepEqual(mixed.plans.map((result) => [result.node, removedIds(result)]),
    [['main', panes.map((pane) => pane.id)], ['box', [far.id]]]);
});

test('the remove for a remote pane carries its qualified ref and a daemon-node one stays bare', async () => {
  const local = exited(9, undefined, { node: 'main' });
  const far = remote('box', 9);
  const fleet = retention.planFleet({ panes: [local, far], nodes: { box: { ok: true } } }, { env, now: NOW, guards: guards() });
  const sent = [];
  await retention.applyFleet(fleet, async (type, params) => { sent.push([type, params]); });
  assert.deepEqual(sent, [['remove', { pane: local.id }], ['remove', { pane: `${far.hostPaneId}@box` }]]);
  // A ref is rebuilt from the host id, so a daemon-node pane listed under its own
  // qualified name still goes out bare, and a remote one listed bare gains its node.
  const odd = [{ ...exited(9), node: 'main' }, { ...exited(9), node: 'box' }];
  odd[0].id = `${odd[0].id}@main`;
  const again = [];
  await retention.applyFleet(retention.planFleet(odd, { env, now: NOW, guards: guards() }),
    async (type, params) => { again.push(params.pane); });
  assert.deepEqual(again, [odd[0].id.replace(/@main$/, ''), `${odd[1].id}@box`]);
});

test('a node that did not answer is skipped, never planned from its memo, and named', async () => {
  const local = exited(9, undefined, { node: 'main' });
  // listHostPaneResult merges a silent node's last known panes into the list,
  // marked stale in its status and named in missingNodes.
  const memo = [remote('box', 20), remote('box', 19)];
  const listing = { panes: [local, ...memo], failure: null, missingNodes: ['box'],
    nodes: { box: { ok: false, reason: 'timeout', stale: true, panesAt: NOW - 60e3 } } };
  const fleet = retention.planFleet(listing, { env, now: NOW, guards: guards() });
  assert.deepEqual(fleet.plans.map((result) => result.node), ['main']);
  assert.deepEqual(fleet.skipped, ['box']);
  const sent = [];
  const outcomes = await retention.applyFleet(fleet, async (type, params) => { sent.push(params.pane); });
  assert.deepEqual(sent, [local.id]);
  assert.equal(retention.describeFleet(fleet, outcomes), 'removed 1 of 1 exited (aged 1); box not listed this sweep');
  // The status alone is enough: a node marked not ok is skipped even if missingNodes is absent.
  const byStatus = retention.planFleet({ panes: memo, nodes: { box: { ok: false, reason: 'unreachable' } } },
    { env, now: NOW, guards: guards() });
  assert.deepEqual(byStatus.skipped, ['box']);
  assert.deepEqual(byStatus.plans.map((result) => result.node), ['main']);
});

test('the guards apply to every node\'s plan', () => {
  const heldBySession = remote('box', 9);
  const heldByPane = remote('box', 9, { agent: 'shell' });
  const free = remote('box', 9);
  const g = guards({ handoffSessions: new Set([heldBySession.meta.sessionId]),
    // Records name a remote pane by its qualified ref; readGuards keys it bare.
    restartPanes: new Set([heldByPane.hostPaneId]) });
  const fleet = retention.planFleet({ panes: [heldBySession, heldByPane, free], nodes: { box: { ok: true } } },
    { env, now: NOW, guards: g });
  const box = fleet.plans.find((result) => result.node === 'box');
  assert.deepEqual(removedIds(box), [free.id]);
  assert.deepEqual(box.kept.map((entry) => [entry.pane, entry.reason]).sort(),
    [[heldBySession.id, 'handoff'], [heldByPane.id, 'restart']].sort());
  const failed = retention.planFleet({ panes: [free], nodes: { box: { ok: true } } },
    { env, now: NOW, guards: guards({ failures: [{ reader: 'queue', error: 'boom' }] }) });
  assert.deepEqual(failed.plans.flatMap(removedIds), [], 'an unreadable guard stops every node');
  assert.equal(retention.describeFleet(failed, []),
    'box: removed 0 of 1 exited, kept 1 (unreadable 1); could not read queue (boom)');
});

test('readGuards keys a qualified pane ref by its host id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-retention-'));
  const session = sid();
  fs.mkdirSync(path.join(root, '.keep', 'handoff-queue'), { recursive: true });
  fs.writeFileSync(path.join(root, '.keep', 'handoff-queue', `${session}.json`),
    JSON.stringify({ sessionId: session, pane: 'abc123@box', status: 'queued' }));
  const g = retention.readGuards(root, { compactSwaps: () => [], deliveries: () => [] });
  assert.ok(g.queuedPanes.has('abc123'));
});

test('describeFleet reads as describe for one node and names each node otherwise', () => {
  const panes = [exited(10), exited(9), exited(8), exited(3), exited(2)];
  const g = guards({ handoffPanes: new Set([panes[1].id]), keepRunning: new Set([panes[2].meta.sessionId]) });
  const single = retention.planFleet(panes, { env, max: 2, now: NOW, guards: g });
  const result = retention.plan(panes, { env, max: 2, now: NOW, guards: g });
  assert.equal(retention.describeFleet(single, [{ removed: single.plans[0].remove }]),
    retention.describe(result, { removed: result.remove }));
  assert.equal(retention.describeFleet(retention.planFleet([], { env, now: NOW, guards: guards() }), []),
    'removed 0 of 0 exited');

  // main: one exited pane, kept by policy; box: 38 exited, 30 aged, 8 over a cap of 8.
  const local = [exited(2, undefined, { node: 'main' })];
  const box = [];
  for (let i = 0; i < 30; i += 1) box.push(remote('box', 40 - i));
  for (let i = 0; i < 8; i += 1) box.push(remote('box', 6 - i * 0.5, { agent: 'shell' }));
  const held = box.slice(0, 5);
  const gg = guards({ handoffSessions: new Set([held[0].meta.sessionId]),
    keepRunning: new Set(held.slice(1).map((pane) => pane.meta.sessionId)) });
  const fleet = retention.planFleet({ panes: [...local, ...box], nodes: { box: { ok: true } } },
    { env, max: 0, now: NOW, guards: gg });
  assert.equal(fleet.plans[0].remove.length, 1, 'main has one pane over a zero cap');
  const outcomes = [
    { removed: [], refused: [], deferred: 1 },
    { removed: fleet.plans[1].remove.slice(0, 25), refused: [], deferred: fleet.plans[1].remove.length - 25 },
  ];
  assert.equal(retention.describeFleet(fleet, outcomes),
    'main: removed 0 of 1 exited, 1 deferred to the next sweep; '
    + 'box: removed 25 of 38 exited (aged 25), kept 5 (handoff 1, keep-running 4), 8 deferred to the next sweep');
});

test('the sweep takes a batch per node and reads the listing\'s node flags', async () => {
  const local = Array.from({ length: 3 }, (_, i) => exited(20 - i, undefined, { node: 'main' }));
  const box = Array.from({ length: 3 }, (_, i) => remote('box', 20 - i));
  const gone = [remote('far', 30)];
  const listing = { panes: [...local, ...box, ...gone], failure: null, missingNodes: ['far'],
    nodes: { box: { ok: true }, far: { ok: false, reason: 'timeout', stale: true, panesAt: NOW - 60e3 } } };
  const h = harness({ panes: listing, env: { KEEP_PANE_RETENTION_BATCH: '2' } });
  const outcome = await h.scheduler.tick();
  assert.deepEqual(h.requests, [
    ['remove', local[0].id], ['remove', local[1].id],
    ['remove', `${box[0].hostPaneId}@box`], ['remove', `${box[1].hostPaneId}@box`],
  ]);
  assert.equal(outcome.detail, 'main: removed 2 of 3 exited (aged 2), 1 deferred to the next sweep; '
    + 'box: removed 2 of 3 exited (aged 2), 1 deferred to the next sweep; far not listed this sweep');
  assert.equal(h.rows[0][1].ok, true);
  assert.deepEqual(h.lines, ['keep serve: pane retention removed 4 pane(s)\n']);
});

test('keep pane gc covers every configured node and sends each remove to its own host', async () => {
  const { commands } = require('./commands/host.js');
  const daemon = require('./nodes.js').daemonNode();
  const local = exited(9);
  const far = exited(9);
  const requests = [];
  const host = (node, panes) => ({
    request: async (type, params) => {
      requests.push([node, type, params && params.pane]);
      if (type === 'hello') return { node };
      if (type === 'list') return { panes };
      return { pane: { id: params.pane } };
    },
    close() {},
  });
  const hosts = { [daemon]: host(daemon, [local]), box: host('box', [far]) };
  const deps = {
    connectHost: async (target) => {
      if (target.node === 'gone') throw new Error('no route');
      return hosts[target.node || daemon];
    },
    configuredNodes: () => [daemon, 'box', 'gone'],
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'pane-retention-')),
    now: NOW, readers: { compactSwaps: () => [], deliveries: () => [] },
  };
  const printed = [];
  const log = console.log;
  const errWrite = process.stderr.write;
  const errors = [];
  console.log = (line) => printed.push(line);
  process.stderr.write = (line) => { errors.push(String(line)); return true; };
  try {
    await commands.pane(['gc'], deps);
  } finally {
    console.log = log;
    process.stderr.write = errWrite;
  }
  assert.deepEqual(requests.filter(([, type]) => type === 'remove'),
    [[daemon, 'remove', local.id], ['box', 'remove', far.id]], 'each host is asked by its own bare id');
  assert.deepEqual(printed.slice(0, 2), [
    `remove ${local.id} claude exited ${local.exitedAt.slice(0, 10)} aged`,
    `remove ${far.id}@box claude exited ${far.exitedAt.slice(0, 10)} aged`,
  ]);
  assert.equal(printed.at(-1), `${daemon}: removed 1 of 1 exited (aged 1); box: removed 1 of 1 exited (aged 1); gone not listed this sweep`);
  assert.ok(errors.some((line) => /node gone is unreachable/.test(line)));
});
