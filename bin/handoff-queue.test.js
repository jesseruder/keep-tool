'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const queue = require('./handoff-queue');

const T = 1_700_000_000_000;

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-handoff-queue-'));
  const root = path.join(base, 'registry');
  fs.mkdirSync(root);
  const profiles = Object.fromEntries(['one', 'two', 'codex'].map((id) => [id, path.join(base, id)]));
  for (const value of Object.values(profiles)) fs.mkdirSync(value, { recursive: true });
  const config = path.join(base, 'config.json');
  const write = (extra = {}) => fs.writeFileSync(config, JSON.stringify({
    version: 1,
    accounts: [
      { id: 'one', label: 'One', agent: 'claude', configDir: profiles.one },
      { id: 'two', label: 'Two', agent: 'claude', configDir: profiles.two },
      { id: 'codex-work', label: 'Codex', agent: 'codex', configDir: profiles.codex },
    ],
    defaultAccounts: { claude: 'one', codex: 'codex-work' },
    ...extra,
  }));
  write();
  return { base, root, env: { KEEP_CONFIG: config, KEEP_DIR: root }, config, write };
}

function entryFor(root, sessionId) {
  return queue.list(root).find((entry) => entry.sessionId === sessionId) || null;
}

function session(overrides = {}) {
  return { id: 'session-a', kind: 'claude', pane: 'pane-1', accountId: 'one',
    rateLimit: { type: 'fable_weekly', at: T }, title: 'a card', ...overrides };
}

// A tick with nothing else attached: no policy, a fixed clock, and a recorded
// handoffSession so a test can say exactly what the transfer answered.
function tickDeps(f, handoffSession, overrides = {}) {
  return { root: f.root, env: f.env, now: () => T, policyEnabled: false, log: () => {},
    sessions: async () => [session()], handoffSession, ...overrides };
}

test('enqueue is idempotent per session, and a parked or cancelled entry starts over', () => {
  const f = fixture();
  const first = queue.enqueue(f.root, { sessionId: 'session-a', pane: 'pane-1', sourceAccountId: 'one', targetAccountId: 'two' },
    { now: T, log: () => {} });
  assert.equal(first.created, true);
  assert.equal(first.entry.status, 'queued');
  assert.equal(first.entry.attempts, 0);
  assert.equal(first.entry.nextAt, T);

  // Patience is state: a repeated request must not reset the backoff of an entry
  // that is already waiting out a refusal.
  fs.writeFileSync(path.join(queue.dir(f.root), 'session-a.json'),
    JSON.stringify({ ...first.entry, attempts: 3, nextAt: T + 80e3, lastReason: 'Waiting for the turn', lastClass: 'transient' }));
  const again = queue.enqueue(f.root, { sessionId: 'session-a', pane: 'pane-1', sourceAccountId: 'one', targetAccountId: 'two' },
    { now: T + 5e3, log: () => {} });
  assert.equal(again.created, false);
  assert.equal(again.entry.attempts, 3);
  assert.equal(again.entry.nextAt, T + 80e3);
  assert.equal(queue.list(f.root).length, 1, 'one entry per session');

  // A parked entry is what the console's Retry acts on: it starts over clean.
  queue.cancel(f.root, 'session-a', { now: T + 6e3, log: () => {} });
  assert.equal(entryFor(f.root, 'session-a').status, 'cancelled');
  const restarted = queue.enqueue(f.root, { sessionId: 'session-a', pane: 'pane-2', sourceAccountId: 'one', targetAccountId: 'two' },
    { now: T + 7e3, log: () => {} });
  assert.equal(restarted.created, true);
  assert.deepEqual([restarted.entry.status, restarted.entry.attempts, restarted.entry.pane], ['queued', 0, 'pane-2']);

  assert.throws(() => queue.enqueue(f.root, { sessionId: 'session-a', pane: 'pane-1', targetAccountId: 'two', force: 'yes' }), /force must be a boolean/);
  assert.throws(() => queue.enqueue(f.root, { sessionId: '../etc', pane: 'pane-1', targetAccountId: 'two' }), /exact session and pane/);
  assert.throws(() => queue.enqueue(f.root, { sessionId: 'session-b', pane: 'pane-1', sourceAccountId: 'two', targetAccountId: 'two' }), /same/);
});

test('a transient refusal backs off, keeps its request identical, and parks when the entry runs out of patience', async () => {
  const f = fixture();
  queue.enqueue(f.root, { sessionId: 'session-a', pane: 'pane-1', sourceAccountId: 'one', targetAccountId: 'two' },
    { now: T, log: () => {} });
  const asked = [];
  const refuse = (reason) => async (body) => { asked.push(body); throw Object.assign(new Error(reason), { status: 409 }); };

  let at = T;
  const run = (reason) => queue.tick(tickDeps(f, refuse(reason), { now: () => at, maxMinutes: 45 }));

  await run('another session injection is busy');
  let entry = entryFor(f.root, 'session-a');
  assert.deepEqual([entry.status, entry.attempts, entry.lastClass], ['queued', 1, 'transient']);
  assert.equal(entry.nextAt, T + 20e3);

  // Not due yet: the tick leaves it completely alone rather than burning an attempt.
  at = T + 10e3;
  await run('another session injection is busy');
  assert.equal(entryFor(f.root, 'session-a').attempts, 1);
  assert.equal(asked.length, 1);

  at = T + 20e3;
  await run('Waiting for the turn and background work to finish');
  entry = entryFor(f.root, 'session-a');
  assert.equal(entry.attempts, 2);
  assert.equal(entry.nextAt, at + 40e3);

  at = entry.nextAt;
  await run('Local background processes are still present');
  assert.equal(entryFor(f.root, 'session-a').nextAt, at + 80e3);

  assert.equal(queue.backoffMs(4), 160e3);
  assert.equal(queue.backoffMs(9), queue.BACKOFF_MAX_MS, 'the backoff is capped at three minutes');

  // Every attempt asked for exactly the same transfer, naming what it assumed.
  for (const body of asked) {
    assert.deepEqual(body, { sessionId: 'session-a', pane: 'pane-1', accountId: 'two', intent: 'continue',
      expectedSourceAccountId: 'one' });
  }

  // Past the deadline the same transient refusal parks the entry instead.
  at = T + 46 * 60e3;
  await run('host request timed out (get)');
  entry = entryFor(f.root, 'session-a');
  assert.deepEqual([entry.status, entry.lastClass], ['parked', 'transient']);
  assert.match(entry.lastReason, /host request timed out/);
  assert.equal(entry.parkedAt, at);

  // A parked entry is not due for anything.
  const before = asked.length;
  at += 10 * 60e3;
  await run('another session injection is busy');
  assert.equal(asked.length, before);
});

test('a blocked refusal parks at once rather than repeating a refusal only a person can clear', async () => {
  const f = fixture();
  queue.enqueue(f.root, { sessionId: 'session-a', pane: 'pane-1', sourceAccountId: 'one', targetAccountId: 'two' },
    { now: T, log: () => {} });
  let calls = 0;
  const result = await queue.tick(tickDeps(f, async () => {
    calls += 1;
    throw Object.assign(new Error('Current Claude model cannot be reproduced safely'), { status: 409 });
  }));
  assert.equal(calls, 1);
  assert.match(result.detail, /parked 1/);
  const entry = entryFor(f.root, 'session-a');
  assert.deepEqual([entry.status, entry.lastClass, entry.attempts], ['parked', 'blocked', 0]);
  assert.equal(entry.lastReason, 'Current Claude model cannot be reproduced safely');
});

test('a successful transfer marks the entry moved, and force travels only when the entry carries it', async () => {
  const f = fixture();
  queue.enqueue(f.root, { sessionId: 'session-a', pane: 'pane-1', sourceAccountId: 'one', targetAccountId: 'two', force: true },
    { now: T, log: () => {} });
  const asked = [];
  const result = await queue.tick(tickDeps(f, async (body) => { asked.push(body); return { ok: true, status: 'done' }; }));
  assert.match(result.detail, /moved 1/);
  assert.deepEqual(asked, [{ sessionId: 'session-a', pane: 'pane-1', accountId: 'two', intent: 'continue', force: true,
    expectedSourceAccountId: 'one' }]);
  const entry = entryFor(f.root, 'session-a');
  assert.deepEqual([entry.status, entry.movedAt], ['moved', T]);
  assert.deepEqual(queue.visible(f.root, T + 60e3).map((row) => row.sessionId), ['session-a']);
  assert.deepEqual(queue.visible(f.root, T + 2 * 60 * 60e3), [], 'and it stops being shown after an hour');
});

test('a session that is gone or already on the target is settled without asking for another transfer', async () => {
  const f = fixture();
  queue.enqueue(f.root, { sessionId: 'session-a', pane: 'pane-1', sourceAccountId: 'one', targetAccountId: 'two' }, { now: T, log: () => {} });
  queue.enqueue(f.root, { sessionId: 'session-b', pane: 'pane-2', sourceAccountId: 'one', targetAccountId: 'two' }, { now: T, log: () => {} });
  let calls = 0;
  await queue.tick(tickDeps(f, async () => { calls += 1; return { ok: true, status: 'done' }; }, {
    sessions: async () => [session({ id: 'session-a', accountId: 'two' })],
  }));
  assert.equal(calls, 0, 'neither entry had anything left to transfer');
  assert.equal(entryFor(f.root, 'session-a').status, 'moved');
  assert.match(entryFor(f.root, 'session-a').note, /already on the target/);
  assert.equal(entryFor(f.root, 'session-b').status, 'moved');
  assert.match(entryFor(f.root, 'session-b').note, /no longer in state/);
});

test('a live pane that moved since the session was queued is the one the transfer names', async () => {
  const f = fixture();
  queue.enqueue(f.root, { sessionId: 'session-a', pane: 'pane-old', sourceAccountId: 'one', targetAccountId: 'two' }, { now: T, log: () => {} });
  const asked = [];
  await queue.tick(tickDeps(f, async (body) => { asked.push(body); return { ok: true, status: 'done' }; },
    { sessions: async () => [session({ pane: 'pane-new' })] }));
  assert.equal(asked[0].pane, 'pane-new');
});

test('the policy enqueues only configured sources, holds an exhausted target, and never overrules a parked entry', async () => {
  const f = fixture();
  f.write({ rateLimitHandoff: { one: 'two' } });
  const sessions = [
    session({ id: 'session-a' }),
    session({ id: 'session-b', accountId: 'two' }),
    session({ id: 'session-c', rateLimit: null }),
    session({ id: 'session-d', kind: 'codex' }),
    session({ id: 'session-e', pane: null }),
  ];
  const deps = (usage) => ({ root: f.root, env: f.env, now: () => T, log: () => {},
    sessions: async () => sessions, readUsageCache: () => usage,
    handoffSession: async () => { throw Object.assign(new Error('Waiting for the turn and background work to finish'), { status: 409 }); } });

  // A target whose weekly window is spent is not somewhere to move work to.
  await queue.tick(deps({ accounts: { two: { agent: 'claude', limits: [{ label: 'Fable wk', percent: 100 }] } } }));
  assert.deepEqual(queue.list(f.root), []);

  await queue.tick(deps({ accounts: { two: { agent: 'claude', limits: [{ label: 'Fable wk', percent: 31 }] } } }));
  assert.deepEqual(queue.list(f.root).map((entry) => entry.sessionId), ['session-a']);
  const queued = entryFor(f.root, 'session-a');
  assert.deepEqual([queued.targetAccountId, queued.force], ['two', false], 'the policy never forces');
  assert.equal(queued.attempts, 1, 'and the same tick tried the transfer once');

  // Parked is a person's business. The policy leaves it alone rather than
  // re-queueing the same refusal every thirty seconds.
  fs.writeFileSync(path.join(queue.dir(f.root), 'session-a.json'),
    JSON.stringify({ ...queued, status: 'parked', parkedAt: T, lastClass: 'blocked', lastReason: 'Session process changed' }));
  await queue.tick(deps({ accounts: { two: { agent: 'claude', limits: [{ label: 'Fable wk', percent: 31 }] } } }));
  assert.equal(entryFor(f.root, 'session-a').status, 'parked');

  // No key in config.json means nothing automatic at all.
  f.write();
  fs.rmSync(path.join(queue.dir(f.root), 'session-a.json'));
  await queue.tick(deps(null));
  assert.deepEqual(queue.list(f.root), []);
});

test('an unusable rateLimitHandoff key is reported and ignored, never guessed at', async () => {
  const f = fixture();
  const lines = [];
  for (const value of [{ one: 'nope' }, { one: 'codex-work' }, { one: 'one' }, ['one', 'two'], { one: 5 }]) {
    f.write({ rateLimitHandoff: value });
    assert.throws(() => queue.policyTargets(f.env));
    await queue.tick({ root: f.root, env: f.env, now: () => T, log: (line) => lines.push(line),
      sessions: async () => [session()], handoffSession: async () => { throw new Error('should not be called'); } });
    assert.deepEqual(queue.list(f.root), []);
  }
  assert.equal(lines.length, 5);
  for (const line of lines) assert.match(line, /^policy ignored: /);
  f.write({ rateLimitHandoff: { one: 'two' } });
  assert.deepEqual(queue.policyTargets(f.env), { one: 'two' });
});

test('the weekly-window check reads only a weekly bucket, and unknown usage is never exhausted', () => {
  assert.equal(queue.weeklyExhausted(null, 'two'), false);
  assert.equal(queue.weeklyExhausted({ accounts: {} }, 'two'), false);
  assert.equal(queue.weeklyExhausted({ accounts: { two: { limits: [] } } }, 'two'), false);
  assert.equal(queue.weeklyExhausted({ accounts: { two: { limits: [{ label: '5h', percent: 100 }] } } }, 'two'), false);
  assert.equal(queue.weeklyExhausted({ accounts: { two: { limits: [{ label: 'Fable wk', percent: 99.4 }] } } }, 'two'), false);
  assert.equal(queue.weeklyExhausted({ accounts: { two: { limits: [{ label: 'Fable wk', percent: 100 }] } } }, 'two'), true);
  assert.equal(queue.weeklyExhausted({ accounts: { two: { snapshot: { limits: [{ label: 'Opus wk', percent: 100 }] } } } }, 'two'), true);
});

test('the batch selects rate-limited sessions on the named source and reports every skip', () => {
  const f = fixture();
  const sessions = [
    session({ id: 'session-a' }),
    session({ id: 'session-b' }),
    session({ id: 'session-c', accountId: 'two' }),
    session({ id: 'session-d', rateLimit: null }),
    session({ id: 'session-e', kind: 'codex' }),
    session({ id: 'session-f', pane: null }),
  ];
  const run = (extra = {}) => queue.batch({ root: f.root, env: f.env, now: T, log: () => {}, sessions,
    sourceAccountId: 'one', targetAccountId: 'two', ...extra });

  const first = run();
  assert.deepEqual(first.queued.map((row) => row.sessionId), ['session-a', 'session-b']);
  assert.deepEqual(first.queued[0], { sessionId: 'session-a', pane: 'pane-1', title: 'a card' });
  assert.deepEqual(first.skipped, [{ sessionId: 'session-f', reason: 'no live pane' }]);

  // A second press does not re-queue what is already moving.
  const second = run();
  assert.deepEqual(second.queued, []);
  assert.deepEqual(second.skipped.map((row) => row.reason), ['already queued', 'already queued', 'no live pane']);

  // Scoped to one session — the console's Retry — and it says why a named one was not taken.
  fs.rmSync(path.join(queue.dir(f.root), 'session-a.json'));
  const scoped = run({ sessionIds: ['session-a', 'session-c', 'session-d'] });
  assert.deepEqual(scoped.queued.map((row) => row.sessionId), ['session-a']);
  assert.deepEqual(scoped.skipped, [
    { sessionId: 'session-c', reason: 'already on the target account' },
    { sessionId: 'session-d', reason: 'not rate limited' },
  ]);
  assert.equal(entryFor(f.root, 'session-a').force, false);
  fs.rmSync(path.join(queue.dir(f.root), 'session-a.json'));
  assert.equal(run({ sessionIds: ['session-a'], force: true }).queued.length, 1);
  assert.equal(entryFor(f.root, 'session-a').force, true, 'force travels only when the request carried it');
});

test('the batch refuses an unknown, identical, or cross-provider pair before queueing anything', () => {
  const f = fixture();
  const run = (extra) => queue.batch({ root: f.root, env: f.env, now: T, log: () => {}, sessions: [session()],
    sourceAccountId: 'one', targetAccountId: 'two', ...extra });
  const refusal = (extra) => { try { run(extra); return null; } catch (error) { return error; } };
  assert.match(refusal({ targetAccountId: 'nope' }).message, /unknown account nope/);
  assert.equal(refusal({ targetAccountId: 'nope' }).status, 400);
  assert.match(refusal({ sourceAccountId: 'nope' }).message, /unknown account nope/);
  assert.equal(refusal({ targetAccountId: 'one' }).status, 409);
  assert.match(refusal({ targetAccountId: 'codex-work' }).message, /same provider/);
  assert.equal(refusal({ targetAccountId: '../../etc' }).status, 400);
  assert.equal(refusal({ force: 'yes' }).status, 400);
  assert.deepEqual(queue.list(f.root), [], 'nothing was queued by a refused request');
});

test('cancel stops a queued or parked transfer and says so when there is nothing to stop', () => {
  const f = fixture();
  queue.enqueue(f.root, { sessionId: 'session-a', pane: 'pane-1', sourceAccountId: 'one', targetAccountId: 'two' }, { now: T, log: () => {} });
  const cancelled = queue.cancel(f.root, 'session-a', { now: T + 1e3, log: () => {} });
  assert.deepEqual([cancelled.changed, cancelled.entry.status, cancelled.entry.cancelledAt], [true, 'cancelled', T + 1e3]);
  assert.deepEqual(queue.visible(f.root, T + 2e3), [], 'a cancelled transfer leaves the console');
  assert.equal(queue.cancel(f.root, 'session-a', { now: T + 2e3, log: () => {} }).changed, false);
  const missing = (() => { try { queue.cancel(f.root, 'session-zzz'); return null; } catch (error) { return error; } })();
  assert.equal(missing.status, 404);
});

// ---------- what changes under a running transfer ----------

test('a cancel that lands while another transfer is running stops the entry before it is dispatched', async () => {
  const f = fixture();
  // B is written first so A sorts ahead of it and runs first.
  queue.enqueue(f.root, { sessionId: 'session-b', pane: 'pane-2', sourceAccountId: 'one', targetAccountId: 'two' }, { now: T, log: () => {} });
  queue.enqueue(f.root, { sessionId: 'session-a', pane: 'pane-1', sourceAccountId: 'one', targetAccountId: 'two' }, { now: T + 1e3, log: () => {} });
  const asked = [];
  const result = await queue.tick(tickDeps(f, async (body) => {
    asked.push(body.sessionId);
    // What the console's Cancel does while the first transfer is in flight.
    queue.cancel(f.root, 'session-b', { now: T + 2e3, log: () => {} });
    return { ok: true, status: 'done' };
  }, {
    now: () => T + 2e3,
    sessions: async () => [session({ id: 'session-a' }), session({ id: 'session-b', pane: 'pane-2' })],
  }));
  assert.deepEqual(asked, ['session-a'], 'the cancelled entry was never dispatched');
  assert.equal(entryFor(f.root, 'session-b').status, 'cancelled');
  assert.equal(entryFor(f.root, 'session-a').status, 'moved');
  assert.match(result.detail, /skipped 1/);
});

test('a cancel that lands during an entry\'s own transfer is not overwritten by the attempt', async () => {
  const f = fixture();
  queue.enqueue(f.root, { sessionId: 'session-a', pane: 'pane-1', sourceAccountId: 'one', targetAccountId: 'two' }, { now: T, log: () => {} });
  const lines = [];
  const result = await queue.tick(tickDeps(f, async () => {
    queue.cancel(f.root, 'session-a', { now: T, log: () => {} });
    throw Object.assign(new Error('another session injection is busy'), { status: 409 });
  }, { log: (line) => lines.push(line) }));
  // Without the generation check the transient refusal would write the entry back
  // to 'queued' and it would run again on the next tick.
  const entry = entryFor(f.root, 'session-a');
  assert.equal(entry.status, 'cancelled');
  assert.equal(entry.attempts, 0);
  assert.match(result.detail, /skipped 1/);
  assert.ok(lines.some((line) => /^left session-a alone: /.test(line)), lines.join(' | '));

  // The same protection covers a success: a cancelled entry is not marked moved.
  queue.enqueue(f.root, { sessionId: 'session-b', pane: 'pane-2', sourceAccountId: 'one', targetAccountId: 'two' }, { now: T, log: () => {} });
  await queue.tick(tickDeps(f, async () => {
    queue.cancel(f.root, 'session-b', { now: T, log: () => {} });
    return { ok: true, status: 'done' };
  }, { sessions: async () => [session({ id: 'session-b', pane: 'pane-2' })] }));
  assert.equal(entryFor(f.root, 'session-b').status, 'cancelled');
});

test('an entry whose session has moved to a third account is retired, not transferred from wherever it is now', async () => {
  const f = fixture();
  queue.enqueue(f.root, { sessionId: 'session-a', pane: 'pane-1', sourceAccountId: 'one', targetAccountId: 'two', force: true }, { now: T, log: () => {} });
  let calls = 0;
  await queue.tick(tickDeps(f, async () => { calls += 1; return { ok: true, status: 'done' }; },
    { sessions: async () => [session({ accountId: 'three' })] }));
  assert.equal(calls, 0, 'a C to B transfer carrying the A to B force is never asked for');
  const entry = entryFor(f.root, 'session-a');
  assert.equal(entry.status, 'moved');
  assert.match(entry.note, /no longer on one; it is on three/);

  // Durable authority is asked first, and it wins: the state row is a snapshot
  // and can still name the old account seconds after a move has committed, while
  // authority is what the transfer itself would resolve.
  queue.enqueue(f.root, { sessionId: 'session-b', pane: 'pane-2', sourceAccountId: 'one', targetAccountId: 'two' }, { now: T, log: () => {} });
  await queue.tick(tickDeps(f, async () => { calls += 1; return { ok: true, status: 'done' }; }, {
    sessions: async () => [session({ id: 'session-b', pane: 'pane-2', accountId: 'one' })],
    accountFor: () => 'three',
  }));
  assert.equal(calls, 0);
  assert.equal(entryFor(f.root, 'session-b').status, 'moved');
  assert.match(entryFor(f.root, 'session-b').note, /it is on three/);

  // And a row is still the answer when authority has none to give.
  queue.enqueue(f.root, { sessionId: 'session-c', pane: 'pane-3', sourceAccountId: 'one', targetAccountId: 'two' }, { now: T, log: () => {} });
  await queue.tick(tickDeps(f, async () => { calls += 1; return { ok: true, status: 'done' }; }, {
    sessions: async () => [session({ id: 'session-c', pane: 'pane-3', accountId: 'three' })],
    accountFor: () => null,
  }));
  assert.equal(calls, 0);
  assert.equal(entryFor(f.root, 'session-c').status, 'moved');
});

test('each attempt is judged against state taken after the transfer before it finished', async () => {
  for (const drift of ['moved', 'cleared']) {
    const f = fixture();
    // B is written first so A sorts ahead of it and runs first.
    queue.enqueue(f.root, { sessionId: 'session-b', pane: 'pane-2', sourceAccountId: 'one', targetAccountId: 'two', rateLimitAt: T },
      { now: T, log: () => {} });
    queue.enqueue(f.root, { sessionId: 'session-a', pane: 'pane-1', sourceAccountId: 'one', targetAccountId: 'two', rateLimitAt: T },
      { now: T + 1e3, log: () => {} });
    // What A's transfer takes minutes to do, while B is still waiting its turn.
    let during = false;
    const rows = () => [
      session({ id: 'session-a' }),
      session({ id: 'session-b', pane: 'pane-2',
        ...(during && drift === 'moved' ? { accountId: 'three' } : {}),
        ...(during && drift === 'cleared' ? { rateLimit: null } : {}) }),
    ];
    const asked = [];
    await queue.tick(tickDeps(f, async (body) => { asked.push(body.sessionId); during = true; return { ok: true, status: 'done' }; }, {
      now: () => T + 2e3, sessions: async () => rows(),
    }));
    assert.deepEqual(asked, ['session-a'], `${drift}: the second entry was dispatched on a stale snapshot`);
    const entry = entryFor(f.root, 'session-b');
    if (drift === 'moved') {
      assert.equal(entry.status, 'moved');
      assert.match(entry.note, /it is on three/);
    } else {
      assert.equal(entry.status, 'cancelled');
      assert.equal(entry.note, 'rate limit cleared');
    }
  }
});

test('a limit that cleared retires the entry, and a transaction already under way still finishes', async () => {
  const f = fixture();
  const queueOne = (id, pane) => queue.enqueue(f.root,
    { sessionId: id, pane, sourceAccountId: 'one', targetAccountId: 'two', rateLimitAt: T }, { now: T, log: () => {} });
  const asked = [];
  const run = (rows, extra = {}) => queue.tick(tickDeps(f, async (body) => { asked.push(body.sessionId); return { ok: true, status: 'done' }; },
    { sessions: async () => rows, ...extra }));

  // The person went back to work: the limit is gone, so stopping the session and
  // typing a continuation is not something anybody asked for.
  queueOne('session-a', 'pane-1');
  await run([session({ rateLimit: null })]);
  assert.deepEqual(asked, []);
  assert.equal(entryFor(f.root, 'session-a').status, 'cancelled');
  assert.equal(entryFor(f.root, 'session-a').note, 'rate limit cleared');

  // A newer limit event is a different event, and this entry is not about it.
  fs.rmSync(path.join(queue.dir(f.root), 'session-a.json'));
  queueOne('session-a', 'pane-1');
  await run([session({ rateLimit: { type: 'fable_weekly', at: T + 60 * 60e3 } })]);
  assert.deepEqual(asked, []);
  assert.equal(entryFor(f.root, 'session-a').status, 'cancelled');

  // But a transaction that already stopped the source has to be allowed to finish,
  // and it names no limit on the request: there is no live turn left to carry one.
  fs.rmSync(path.join(queue.dir(f.root), 'session-a.json'));
  asked.length = 0;
  const bodies = [];
  queueOne('session-a', 'pane-1');
  await queue.tick(tickDeps(f, async (body) => { bodies.push(body); return { ok: true, status: 'done' }; }, {
    sessions: async () => [session({ rateLimit: null })],
    handoffRecords: () => [{ sessionId: 'session-a', status: 'recovery-needed', phase: 'starting-target',
      sourceStopVerifiedAt: T }],
  }));
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].expectedRateLimitAt, undefined);
  assert.equal(entryFor(f.root, 'session-a').status, 'moved');

  // A refusal that landed before anything was stopped is not an in-flight
  // transaction. account-handoff writes recovery-needed/stopping-source for an
  // injection 429, and that must not exempt every later attempt from the check.
  for (const record of [
    { sessionId: 'session-a', status: 'recovery-needed', phase: 'stopping-source', reason: 'another session injection is busy' },
    { sessionId: 'session-a', status: 'failed', phase: 'preflight' },
    { sessionId: 'session-a', status: 'done' },
  ]) {
    fs.rmSync(path.join(queue.dir(f.root), 'session-a.json'));
    asked.length = 0;
    queueOne('session-a', 'pane-1');
    await run([session({ rateLimit: null })], { handoffRecords: () => [record] });
    assert.deepEqual(asked, [], JSON.stringify(record));
    assert.equal(entryFor(f.root, 'session-a').status, 'cancelled');
  }

  // And an entry with no recorded limit event keeps the old behaviour.
  queue.enqueue(f.root, { sessionId: 'session-c', pane: 'pane-3', sourceAccountId: 'one', targetAccountId: 'two' }, { now: T, log: () => {} });
  await run([session({ id: 'session-c', pane: 'pane-3', rateLimit: null })]);
  assert.deepEqual(asked, ['session-c']);
});

test('a sessionIds filter that is not a list of exact session ids is refused, and queues nothing', () => {
  const f = fixture();
  const run = (sessionIds) => queue.batch({ root: f.root, env: f.env, now: T, log: () => {},
    sessions: [session()], sourceAccountId: 'one', targetAccountId: 'two', sessionIds });
  for (const value of ['session-a', null, {}, { 0: 'session-a' }, [], ['short'], ['session-a', 7], ['../../etc/passwd'], [`a${'b'.repeat(200)}`]]) {
    const error = (() => { try { run(value); return null; } catch (caught) { return caught; } })();
    assert.ok(error, `${JSON.stringify(value)} was accepted`);
    assert.equal(error.status, 400);
    assert.match(error.message, /sessionIds must be a list of exact session ids/);
  }
  assert.deepEqual(queue.list(f.root), [], 'a refused filter enqueued nothing');
  assert.equal(run(['session-a']).queued.length, 1, 'and a real list still works');
});

// ---------- the routes ----------

test('the batch and cancel routes match through the real ladder and pass their refusals through', async () => {
  const f = fixture();
  const { routes, matchRoute } = require('./serve/routes.js');
  const broadcasts = [];
  const sessions = [session({ id: 'session-a' }), session({ id: 'session-b', rateLimit: null })];
  const list = routes({
    keep: { ROOT: f.root },
    broadcast: () => broadcasts.push('state'),
    json: (res, status, value) => ({ status, value }),
    handoffRateLimited: async (body) => queue.batch({ root: f.root, env: f.env, now: T, log: () => {}, sessions,
      sourceAccountId: body.sourceAccountId, targetAccountId: body.targetAccountId,
      ...(body.force === undefined ? {} : { force: body.force }),
      ...(body.sessionIds === undefined ? {} : { sessionIds: body.sessionIds }) }),
    cancelQueuedHandoff: (body) => queue.cancel(f.root, body.sessionId, { now: T, log: () => {} }),
  });
  const call = async (pathname, body = {}, headers = { 'x-keep': '1' }) => {
    const url = new URL(`http://x${pathname}`);
    const route = matchRoute(list, { req: { method: 'POST', headers }, url, body });
    assert.ok(route, `POST ${pathname} matched no route`);
    return route.handle({ req: { method: 'POST', headers }, res: {}, url, body });
  };

  const queued = await call('/api/handoff-rate-limited', { sourceAccountId: 'one', targetAccountId: 'two' });
  assert.equal(queued.status, 200);
  assert.deepEqual(queued.value.queued.map((row) => row.sessionId), ['session-a']);
  assert.deepEqual(broadcasts, ['state'], 'a queued batch rebuilds the state the console reads');

  const refused = await call('/api/handoff-rate-limited', { sourceAccountId: 'one', targetAccountId: 'one' });
  assert.equal(refused.status, 409);
  assert.match(refused.value.error, /same/);

  const badFilter = await call('/api/handoff-rate-limited', { sourceAccountId: 'one', targetAccountId: 'two', sessionIds: 'session-b' });
  assert.equal(badFilter.status, 400);
  assert.match(badFilter.value.error, /sessionIds/);

  const cancelled = await call('/api/handoff-queue-cancel', { sessionId: 'session-a' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.value.entry.status, 'cancelled');
  assert.equal((await call('/api/handoff-queue-cancel', { sessionId: 'session-zzz' })).status, 404);

  // Both carry the same header guard as every other route that exposes session detail.
  for (const pathname of ['/api/handoff-rate-limited', '/api/handoff-queue-cancel']) {
    const guarded = await call(pathname, { sessionId: 'session-a', sourceAccountId: 'one', targetAccountId: 'two' }, {});
    assert.equal(guarded.status, 403);
  }
  // And neither steals a GET.
  for (const pathname of ['/api/handoff-rate-limited', '/api/handoff-queue-cancel']) {
    assert.equal(matchRoute(list, { req: { method: 'GET', headers: { 'x-keep': '1' } }, url: new URL(`http://x${pathname}`), body: {} }), null);
  }
});
