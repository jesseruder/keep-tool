'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const inflight = require('./inflight.js');
const stalled = require('./stalled.js');

const MINUTE = 60e3;
const HOUR = 60 * MINUTE;
const NOW = Date.parse('2026-09-24T12:00:00Z');
const sid = () => crypto.randomUUID();
const pane = () => crypto.randomBytes(4).toString('hex');
const hex = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function registry(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-inflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function put(root, rel, value, mtimeMs) {
  const file = path.join(root, '.keep', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  if (mtimeMs) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

// Every file under .keep, with its bytes and mtime: the scan must leave all of it as it was.
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else out[path.relative(root, file)] = `${hex(fs.readFileSync(file))}:${fs.statSync(file).mtimeMs}`;
    }
  };
  walk(path.join(root, '.keep'));
  return out;
}

function deliveryJournal(sessionId, paneId, createdAt, extra = {}) {
  return {
    createdAt, sessionId, kind: 'claude', file: '/fixture/transcript.jsonl', offset: 100, pane: paneId,
    hash: hex('text'), key: 'k', receiptId: hex('receipt'), retainReceipt: false,
    typing: { version: 1, pid: 1, initialInputCount: 1, chunkChars: 200, chunkCount: 1, operationSeed: 'delivery_x',
      acknowledgedChunks: 1, inFlightChunk: null, prefixHash: hex('p'), plannedAt: createdAt, completedAt: createdAt },
    ...extra,
  };
}

test('every in-flight kind is named past its max age and not before; terminal records never are', async (t) => {
  const root = registry(t);
  const ids = {};
  const both = (name, young, old) => { ids[name] = { young, old }; };

  // Delivery: a typed journal on a live pane, which reconcile never retires.
  const [dYoung, dOld] = [sid(), sid()];
  both('delivery', dYoung, dOld);
  put(root, `delivery/${hex(dYoung)}.json`, deliveryJournal(dYoung, pane(), NOW - 30 * MINUTE));
  put(root, `delivery/${hex(dOld)}.json`, deliveryJournal(dOld, pane(), NOW - 49 * HOUR, { typedAt: NOW - 49 * HOUR }));
  put(root, `delivery/settled/${hex(sid())}.json`, deliveryJournal(sid(), pane(), NOW - 99 * HOUR));

  // Account handoffs: half-moved (30 minutes), never-stopped refusal (a day), done.
  const halfMoved = sid();
  const refusedYoung = sid();
  const refusedOld = sid();
  put(root, `account-handoffs/${halfMoved}.json`, {
    sessionId: halfMoved, pane: pane(), status: 'recovery-needed', phase: 'delivering-continuation',
    sourceAccountId: 'claude/one', targetAccountId: 'claude/two', sourceStopVerifiedAt: NOW - 14 * HOUR,
    targetLaunchStartedAt: NOW - 14 * HOUR, deliveryStartedAt: NOW - 14 * HOUR, updatedAt: NOW - 14 * HOUR,
  });
  const refusal = (id, updatedAt) => ({
    sessionId: id, pane: pane(), status: 'recovery-needed', phase: 'stopping-source', reason: 'Waiting for the turn',
    sourceAccountId: 'claude/one', targetAccountId: 'claude/two', updatedAt,
  });
  put(root, `account-handoffs/${refusedYoung}.json`, refusal(refusedYoung, NOW - 3 * HOUR));
  put(root, `account-handoffs/${refusedOld}.json`, refusal(refusedOld, NOW - 30 * HOUR));
  const doneHandoff = sid();
  put(root, `account-handoffs/${doneHandoff}.json`, { sessionId: doneHandoff, status: 'done', phase: 'done', updatedAt: NOW - 99 * HOUR });
  put(root, `account-handoffs/${refusedOld}.json.bak-1`, refusal(refusedOld, NOW - 99 * HOUR));

  // Handoff queue: queued is in flight, parked is the queue's own decision.
  const queued = sid();
  put(root, `handoff-queue/${queued}.json`, { sessionId: queued, pane: pane(), status: 'queued', enqueuedAt: NOW - 2 * HOUR, attempts: 3, targetAccountId: 'claude/two' });
  const parked = sid();
  put(root, `handoff-queue/${parked}.json`, { sessionId: parked, status: 'parked', enqueuedAt: NOW - 50 * HOUR });

  // Session move between nodes, stuck in recovery.
  const move = `mv-${crypto.randomBytes(12).toString('hex')}`;
  put(root, `session-moves/${move}.json`, { id: move, sessionId: sid(), status: 'recovery-needed', phase: 'starting', from: 'main', to: 'nodeb', createdAt: NOW - 3 * HOUR, updatedAt: NOW - 2 * HOUR });

  // Portable transfer: ambiguous for two hours; awaiting-setup for two (under its six).
  const [ambiguous, setup] = [hex('a'), hex('b')];
  put(root, `portable-transfers/${ambiguous}.json`, { requestKey: ambiguous, status: 'ambiguous', sourceSessionId: sid(), targetAccountId: 'codex/two', preparedAt: NOW - 3 * HOUR, updatedAt: NOW - 2 * HOUR });
  put(root, `portable-transfers/${setup}.json`, { requestKey: setup, status: 'awaiting-setup', sourceSessionId: sid(), preparedAt: NOW - 2 * HOUR });
  put(root, `portable-transfers/${ambiguous}.delivery.json`, { version: 2, deliveredAt: NOW - 99 * HOUR });

  // Compaction swaps: a Claude restore pending three hours; a Codex one deferred until recently.
  const [claudeSwap, codexSwap] = [sid(), sid()];
  put(root, `compact/${claudeSwap}.swap.json`, { sessionId: claudeSwap, restoreCommand: '/model fixture-model', at: NOW - 3 * HOUR, lastAttemptAt: NOW - MINUTE });
  put(root, `compact/${codexSwap}.swap.json`, { kind: 'codex', version: 1, sessionId: codexSwap, phase: 'restore-pending', at: NOW - 5 * HOUR, restorePreparedAt: NOW - 30 * MINUTE });
  put(root, `compact/${sid()}.json`, { result: 'compacted', at: NOW - 99 * HOUR });

  // Registry lock held for twenty minutes.
  put(root, 'lock/owner.json', { pid: 4242, token: 't', startedAt: 'fixture' }, NOW - 20 * MINUTE);

  // Worktree recreation and a Pi opening that nothing picked up.
  put(root, `worktree-recreations/${hex('p').slice(0, 32)}.json`, { project: '/fixture/wt/repo/slug', startedAt: NOW - HOUR });
  const piSession = sid();
  put(root, `pi-opening/${piSession}-${crypto.randomUUID()}.txt`, 'opening', NOW - HOUR);

  // Node Codex launch awaiting adoption.
  put(root, `node-codex-launches/${hex('launch')}.json`, { version: 1, node: 'nodeb', openRequestId: 'r', pane: `${pane()}@nodeb`, launchedAt: NOW - 3 * HOUR, at: NOW - 3 * HOUR });

  // Review obligations: a node-opened one nine hours old, a satisfied one, a young open one.
  const oblOld = 'obl-old-0001';
  put(root, 'review-obligations/fixture-card.json', [
    { id: oblOld, at: new Date(NOW - 9 * HOUR).toISOString(), card: 'fixture-card', job: 'task-x', state: 'open', node: 'nodeb', by: 'codex sol' },
    { id: 'obl-done-0002', at: new Date(NOW - 99 * HOUR).toISOString(), state: 'satisfied' },
    { id: 'obl-young-0003', at: new Date(NOW - HOUR).toISOString(), state: 'open' },
  ]);

  // Unblock: resolved two days ago, never delivered; one still waiting on its upstream.
  put(root, 'unblocked/dependent-card--upstream-card--2026-09-20T10-00.json', {
    dependent: 'dependent-card', upstream: 'upstream-card', createdAt: new Date(NOW - 50 * HOUR).toISOString(),
    resolvedAt: new Date(NOW - 48 * HOUR).toISOString(), deliveredAt: null, gaveUp: null, attempts: 2,
  });
  put(root, 'unblocked/waiting-card--other-upstream--2026-09-01T10-00.json', {
    dependent: 'waiting-card', upstream: 'other-upstream', createdAt: new Date(NOW - 500 * HOUR).toISOString(), resolvedAt: null,
  });

  // Restart queue, one array.
  const restarting = sid();
  put(root, 'session-restarts.json', [
    { sessionId: restarting, pane: pane(), status: 'recovery-needed', mode: 'force', at: NOW - 3 * HOUR },
    { sessionId: sid(), status: 'done', at: NOW - 99 * HOUR },
  ]);

  // Pi job running thirteen hours; a finished one.
  const piJob = crypto.randomBytes(12).toString('hex');
  put(root, `pi-jobs/${piJob}/job.json`, { id: piJob, status: 'running', createdAt: NOW - 13 * HOUR, updatedAt: NOW - 13 * HOUR });
  put(root, `pi-jobs/${crypto.randomBytes(12).toString('hex')}/job.json`, { status: 'succeeded', updatedAt: NOW - 99 * HOUR });

  // A probe check-in that has failed to land for two hours.
  put(root, 'runs/fixture-card-probe-1.pending.json', { taskId: 'fixture-card' }, NOW - 2 * HOUR);

  const before = snapshot(root);
  const { items, errors } = await inflight.scan({ root, now: NOW });
  assert.deepEqual(errors, []);
  // Read-only: nothing under .keep changed, moved or disappeared.
  assert.deepEqual(snapshot(root), before);

  const byKind = (kind) => items.filter((item) => item.recordKind === kind).map((item) => item.recordId).sort();
  assert.deepEqual(byKind('delivery'), [dOld]);
  assert.deepEqual(byKind('account-handoff'), [halfMoved, refusedOld].sort());
  assert.deepEqual(byKind('handoff-queue'), [queued]);
  assert.deepEqual(byKind('session-move'), [move]);
  assert.deepEqual(byKind('portable-transfer'), [ambiguous]);
  assert.deepEqual(byKind('compact-swap'), [claudeSwap]);
  assert.deepEqual(byKind('registry-lock'), ['pid-4242']);
  assert.deepEqual(byKind('worktree-recreation'), ['slug']);
  assert.equal(byKind('pi-opening').length, 1);
  assert.equal(byKind('node-codex-launch').length, 1);
  assert.deepEqual(byKind('review-obligation'), [oblOld]);
  assert.deepEqual(byKind('unblock'), ['dependent-card--upstream-card--2026-09-20T10-00']);
  assert.deepEqual(byKind('session-restart'), [restarting]);
  assert.deepEqual(byKind('pi-job'), [piJob]);
  assert.deepEqual(byKind('pending-checkin'), ['fixture-card-probe-1']);

  const half = items.find((item) => item.recordId === halfMoved);
  assert.equal(half.maxAgeMs, 30 * MINUTE);
  assert.equal(half.state, 'recovery-needed/delivering-continuation');
  assert.match(half.resolve, new RegExp(`^keep handoff ${halfMoved} --pane ${half.pane} --account claude/two`));
  const refused = items.find((item) => item.recordId === refusedOld);
  assert.equal(refused.maxAgeMs, 24 * HOUR);
  assert.match(refused.resolve, /Abandon it in the console/);
  const journal = items.find((item) => item.recordKind === 'delivery');
  assert.equal(journal.state, 'Enter pressed, no transcript receipt');
  assert.match(journal.resolve, /keep pane screen/);
  const obligation = items.find((item) => item.recordKind === 'review-obligation');
  assert.equal(obligation.node, 'nodeb');
  assert.match(obligation.resolve, /keep reviewing fixture-card --drop obl-old-0001/);
  // The Claude swap is aged from the swap, not from the retry stamp a minute ago.
  assert.equal(items.find((item) => item.recordKind === 'compact-swap').ageMs, 3 * HOUR);
  // Paths are relative to the registry, never a home directory.
  for (const item of items) assert.ok(!path.isAbsolute(item.file), item.file);
});

test('a record for another node is judged by its own timestamps, never by whether the node answers', async (t) => {
  const root = registry(t);
  const young = sid();
  const old = sid();
  put(root, `delivery/${hex(young)}.json`, deliveryJournal(young, `${pane()}@nodeb`, NOW - HOUR, { node: 'nodeb' }));
  put(root, `delivery/${hex(old)}.json`, deliveryJournal(old, `${pane()}@nodeb`, NOW - 3 * HOUR, { node: 'nodeb' }));
  // A young journal whose file is old (copied, restored) is still young: the record says so.
  fs.utimesSync(path.join(root, '.keep', 'delivery', `${hex(young)}.json`), (NOW - 99 * HOUR) / 1000, (NOW - 99 * HOUR) / 1000);
  const { items } = await inflight.scan({ root, now: NOW });
  assert.deepEqual(items.map((item) => item.recordId), [old]);
  assert.equal(items[0].node, 'nodeb');
  assert.match(items[0].waitingFor, /from node nodeb/);
});

test('max ages follow their environment overrides', async (t) => {
  const root = registry(t);
  const id = sid();
  put(root, `delivery/${hex(id)}.json`, deliveryJournal(id, pane(), NOW - 20 * MINUTE));
  assert.equal((await inflight.scan({ root, now: NOW })).items.length, 0);
  process.env.KEEP_INFLIGHT_DELIVERY_MIN = '10';
  t.after(() => { delete process.env.KEEP_INFLIGHT_DELIVERY_MIN; });
  assert.equal((await inflight.scan({ root, now: NOW })).items.length, 1);
});

function fakeCards() {
  const calls = { added: [], checkins: [] };
  const cards = new Map();
  const deps = {
    addTask: (options) => {
      const id = `inflight-card-${calls.added.length + 1}`;
      calls.added.push(options);
      cards.set(id, { id, fm: { status: options.status } });
      return cards.get(id);
    },
    checkin: (id, payload) => { calls.checkins.push({ id, ...payload }); },
    loadTask: (id) => cards.get(id) || null,
  };
  return { calls, cards, deps };
}

function item(kind, id, ageMs = 2 * HOUR) {
  return {
    kind: 'inflight', recordKind: kind, id: `${kind}:${id}`, recordId: id, state: 'recovery-needed',
    since: NOW - ageMs, ageMs, maxAgeMs: 30 * MINUTE, waitingFor: 'a retry', resolve: `keep handoff ${id}`, file: `.keep/x/${id}.json`,
  };
}

test('escalation opens one card, stays quiet while the set holds, and checks in only when it changes', async (t) => {
  const root = registry(t);
  const { calls, cards, deps } = fakeCards();
  const [a, b] = [sid(), sid()];

  let result = await inflight.escalate([item('account-handoff', a)], { root, now: NOW, deps });
  assert.equal(result.action, 'opened');
  assert.equal(calls.added.length, 1);
  assert.equal(calls.added[0].linkSession, false);
  assert.ok(calls.added[0].tags.includes('personal'));
  assert.match(calls.added[0].note, new RegExp(`account-handoff ${a} \\(recovery-needed\\) — 2h old, max 30m; waiting for a retry; resolve: keep handoff ${a}`));

  // Same set, older ages, many ticks: nothing written.
  for (let i = 1; i <= 5; i += 1) {
    result = await inflight.escalate([item('account-handoff', a, 2 * HOUR + i * MINUTE)], { root, now: NOW + i * MINUTE, deps });
    assert.equal(result.action, 'unchanged');
  }
  assert.equal(calls.added.length, 1);
  assert.equal(calls.checkins.length, 0);

  // A second record joins: one check-in on the same card naming it.
  result = await inflight.escalate([item('account-handoff', a), item('delivery', b)], { root, now: NOW, deps });
  assert.equal(result.action, 'updated');
  assert.equal(result.cardId, 'inflight-card-1');
  assert.equal(calls.checkins.length, 1);
  assert.match(calls.checkins[0].message, new RegExp(`New: delivery:${b}\\.`));

  // Everything finished: one closing check-in, and the card is left open for Owner.
  result = await inflight.escalate([], { root, now: NOW, deps });
  assert.equal(result.action, 'cleared');
  assert.equal(calls.checkins.length, 2);
  assert.match(calls.checkins[1].heading, /cleared/);
  assert.equal((await inflight.escalate([], { root, now: NOW, deps })).action, 'none');
  assert.equal(calls.checkins.length, 2);

  // A new record while that card is still open re-uses it.
  result = await inflight.escalate([item('delivery', b)], { root, now: NOW, deps });
  assert.equal(result.action, 'updated');
  assert.equal(calls.added.length, 1);

  // Owner closes the card: the same records do not reopen it, a new one opens a fresh card.
  cards.get('inflight-card-1').fm.status = 'done';
  result = await inflight.escalate([item('delivery', b)], { root, now: NOW, deps });
  assert.equal(result.action, 'dismissed');
  assert.equal(calls.added.length, 1);
  const c = sid();
  result = await inflight.escalate([item('delivery', b), item('compact-swap', c)], { root, now: NOW, deps });
  assert.equal(result.action, 'opened');
  assert.equal(result.cardId, 'inflight-card-2');
});

test('the tick fails the health row with text that does not change as records age, and passes when clear', async (t) => {
  const root = registry(t);
  const { deps } = fakeCards();
  const rows = [];
  const record = (name, entry) => rows.push({ name, ...entry });
  const a = sid();
  await inflight.tick({ root, now: NOW, deps, record, scanned: { items: [item('account-handoff', a)], errors: [] } });
  await inflight.tick({ root, now: NOW + HOUR, deps, record, scanned: { items: [item('account-handoff', a, 3 * HOUR)], errors: [] } });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.name === 'inflight' && row.ok === false));
  assert.equal(rows[0].error, rows[1].error);
  assert.match(rows[0].error, /^1 in-flight record past max age: account-handoff [0-9a-f]{8}; card inflight-card-1; keep stalled$/);

  await inflight.tick({ root, now: NOW, deps, record, scanned: { items: [], errors: [] } });
  assert.equal(rows.at(-1).ok, true);

  // A scan that failed is a failing row and no escalation: it must not read as "cleared".
  const { calls: quiet, deps: quietDeps } = fakeCards();
  await inflight.tick({ root: registry(t), now: NOW, deps: quietDeps, record, scanned: { items: [], errors: [], error: new Error('EIO') } });
  assert.equal(rows.at(-1).ok, false);
  assert.match(rows.at(-1).error, /scan failed: EIO/);
  assert.equal(quiet.checkins.length + quiet.added.length, 0);
});

test('stalled sweep lists in-flight records, drops them the sweep they clear, and renders a routable attention id', async (t) => {
  const root = registry(t);
  const id = sid();
  const file = put(root, `account-handoffs/${id}.json`, {
    sessionId: id, pane: pane(), status: 'delivering', phase: 'delivering-continuation', targetAccountId: 'claude/two',
    sourceStopVerifiedAt: NOW - 2 * HOUR, updatedAt: NOW - 2 * HOUR,
  });
  const options = { root, now: NOW, sessions: [], jobs: [], brokers: [], psOutput: '', includeInflight: true, autoReap: false };
  const first = await stalled.sweep(options);
  assert.deepEqual(first.items.map((entry) => entry.id), [`account-handoff:${id}`]);
  assert.equal(first.inflight.items.length, 1);
  assert.match(first.detail, /1 in flight past max age/);
  const [attention] = stalled.attentionItems(first.items);
  assert.match(attention.id, /^stalled:[A-Za-z0-9._:-]+$/);
  assert.match(attention.title, /^In flight past max age: account-handoff /);
  assert.match(stalled.render(stalled.readCurrent({ root })), /keep handoff/);

  // The transfer finished: gone on the very next sweep, no missing-sweep grace.
  fs.writeFileSync(file, JSON.stringify({ sessionId: id, status: 'done', phase: 'done', updatedAt: NOW }));
  const second = await stalled.sweep({ ...options, now: NOW + MINUTE });
  assert.deepEqual(second.items, []);

  // Without the flag the sweep is exactly what it was.
  const plain = await stalled.sweep({ ...options, includeInflight: false });
  assert.equal(plain.inflight, undefined);
});

test('the escalation card is a real Keep card that addTask and checkinTask accept', async (t) => {
  // KEEP_DIR is the harness's empty registry; keep.js reads it at load.
  const root = process.env.KEEP_DIR;
  const git = (...args) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  for (const dir of ['tasks', 'archive', 'digests']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, '.keep'), '');
  }
  git('init', '--quiet', '--initial-branch=master');
  git('config', 'user.name', 'Keep Test');
  git('config', 'user.email', 'keep@example.test');
  delete process.env.CLAUDE_CODE_SESSION_ID;
  const [a, b] = [sid(), sid()];
  const opened = await inflight.escalate([item('account-handoff', a)], { root, now: NOW });
  assert.equal(opened.action, 'opened');
  const keep = require('./keep.js');
  const card = keep.loadTask(opened.cardId);
  assert.equal(card.fm.title, inflight.CARD_TITLE);
  assert.equal(card.fm.status, 'active');
  assert.match(card.body, new RegExp(`keep handoff ${a}`));
  const updated = await inflight.escalate([item('account-handoff', a), item('delivery', b)], { root, now: NOW });
  assert.equal(updated.action, 'updated');
  assert.match(keep.loadTask(opened.cardId).body, new RegExp(`New: delivery:${b}`));
});
