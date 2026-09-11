'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const queue = require('./review-queue.js');
const { launchReviewQueueSession, inspectReviewQueueLaunch, recoverReviewQueueLaunch } = require('./serve.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-review-queue-'));
  fs.mkdirSync(path.join(root, '.keep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'archive'), { recursive: true });
  const tasks = [
    { id: 'idea-one', fm: { title: 'Reviewer idea: Shared lock', status: 'active', kind: 'idea', tags: ['reviewer-idea'], project: '/tmp/project', created: '2026-09-10' }, body: '## 2026-09-10 11:00 — created\nUse one lock.\n\nSeen on: card-one' },
    { id: 'idea-done', fm: { title: 'Reviewer idea: Old', status: 'done', kind: 'idea', tags: ['reviewer-idea'], project: '/tmp/project', created: '2026-09-10' }, body: '## 2026-09-10 08:00 — created\nAlready handled.' },
    { id: 'idea-archived', fm: { title: 'Reviewer idea: Archived', status: 'active', kind: 'idea', tags: ['reviewer-idea'], project: '/tmp/project', created: '2026-09-07' }, body: 'Archived.' },
    { id: 'ordinary-idea', fm: { title: 'Ordinary idea', status: 'active', kind: 'idea', tags: [], project: '/tmp/project' }, body: 'not from reviewer' },
    { id: 'card-one', fm: { title: 'Build locking', status: 'done', kind: 'task', tags: [], project: '/tmp/project' }, body: [
      '## 2026-09-10 10:00 — review outcome',
      'Finding abc123 was discussed in this later outcome block.',
      '',
      '## 2026-09-10 09:00 — review (fable)',
      '**bug** - `lost update` - severity med',
      '',
      'Assessment: observed · evidence: bin/store.js:10 · checked: two writers',
      '',
      'The second writer overwrites the first.',
      '',
      '## Reproduction',
      'Run two writers concurrently.',
      '',
      '## Recommendation',
      'Serialize the mutation.',
      '',
      '-- reviewer fable, finding abc123',
      '',
      '## 2026-09-10 08:00 — work',
      'Earlier unrelated history.',
    ].join('\n') },
  ];
  fs.writeFileSync(path.join(root, 'archive', 'idea-archived.md'), 'archived marker\n');
  const findings = [
    { card: 'card-one', key: 'abc123', kind: 'bug', subject: 'lost update', severity: 'med', basis: 'observed', evidence: 'bin/store.js:10', checked: 'two writers', question: '', unknown: '', dismissed: false, outcome: { status: 'unresolved' }, lastAt: 300 },
    { card: 'card-one', key: 'fixed1', kind: 'bug', subject: 'fixed issue', severity: 'low', basis: 'observed', evidence: 'commit abc', checked: 'test', dismissed: false, outcome: { status: 'fixed', message: 'patched', evidence: 'abc', at: 400 }, lastAt: 350 },
    { card: 'card-one', key: 'defer1', kind: 'risk', subject: 'accepted for later', severity: 'low', basis: 'needs-verification', evidence: '', checked: '', question: 'Still relevant?', unknown: 'No product decision', dismissed: false, outcome: { status: 'confirmed-deferred' }, lastAt: 200 },
  ];
  const deps = {
    root,
    loadTasks: () => tasks,
    findingOutcomes: () => findings,
    archivedIds: new Set(['idea-archived']),
    withLock: (fn) => fn(),
  };
  return { root, tasks, findings, deps, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('snapshot is sourced from durable findings and reviewer ideas, preserves history, and ignores unrelated notification data', () => {
  const f = fixture();
  try {
    const state = queue.snapshot({ ...f.deps, now: Date.parse('2026-09-10T12:00:00Z'), notifications: [{ card: 'unrelated' }] });
    assert.deepEqual(state.items.map((item) => item.id).sort(), [
      'finding:card-one:abc123', 'finding:card-one:defer1', 'finding:card-one:fixed1',
      'idea:idea-archived', 'idea:idea-done', 'idea:idea-one',
    ]);
    assert.equal(state.items.some((item) => item.id.includes('ordinary-idea')), false);
    assert.equal(state.items.find((item) => item.id === 'finding:card-one:abc123').status, 'needs-decision', 'parent card done does not resolve its finding');
    assert.match(state.items.find((item) => item.id === 'finding:card-one:abc123').body, /second writer overwrites/);
    assert.match(state.items.find((item) => item.id === 'finding:card-one:abc123').body, /## Reproduction[\s\S]*## Recommendation/);
    assert.doesNotMatch(state.items.find((item) => item.id === 'finding:card-one:abc123').body, /later outcome block/);
    assert.doesNotMatch(state.items.find((item) => item.id === 'finding:card-one:abc123').body, /Earlier unrelated/);
    assert.match(state.items.find((item) => item.id === 'finding:card-one:abc123').evidence, /Assessment basis: observed/);
    assert.equal(state.items.find((item) => item.id === 'finding:card-one:fixed1').status, 'resolved');
    assert.equal(state.items.find((item) => item.id === 'finding:card-one:defer1').status, 'needs-decision', 'confirmed-deferred is still a decision in the queue');
    assert.equal(state.items.find((item) => item.id === 'idea:idea-done').status, 'resolved');
    assert.equal(state.items.find((item) => item.id === 'idea:idea-archived').status, 'resolved');
    assert.ok(state.items.find((item) => item.id === 'idea:idea-one').at > state.items.find((item) => item.id === 'idea:idea-done').at,
      'created log time orders ideas filed on the same day');
    assert.deepEqual(state.counts, { 'needs-decision': 3, 'in-progress': 0, resolved: 3 });
  } finally { f.cleanup(); }
});

test('defer is durable and hidden from needs-decision count only until it is due', async () => {
  const f = fixture();
  let now = Date.parse('2026-09-10T12:00:00Z');
  try {
    const result = await queue.act({ id: 'idea:idea-one', action: 'defer', until: '2026-09-10T13:00:00Z' }, { ...f.deps, now: () => now });
    assert.equal(result.item.deferredUntil, '2026-09-10T13:00:00.000Z');
    assert.equal(queue.snapshot({ ...f.deps, now }).counts['needs-decision'], 2);
    assert.equal(queue.loadStore(f.root).items['idea:idea-one'].deferredUntil, '2026-09-10T13:00:00.000Z');
    now = Date.parse('2026-09-10T13:00:01Z');
    const due = queue.snapshot({ ...f.deps, now });
    assert.equal(due.items.find((item) => item.id === 'idea:idea-one').deferredUntil, undefined);
    assert.equal(due.counts['needs-decision'], 3);
  } finally { f.cleanup(); }
});

test('discuss and start launch fresh conversations with distinct complete prompts', async () => {
  const f = fixture();
  const launches = [];
  try {
    const launch = async (request) => {
      launches.push(request);
      await request.onLaunched({ pane: `pane-${launches.length}` });
      return { sessionId: request.sessionId, pane: `pane-${launches.length}` };
    };
    const discussed = await queue.act({ id: 'finding:card-one:abc123', action: 'discuss', requestId: 'discuss-1' }, {
      ...f.deps, randomUUID: () => 'session-discuss', launch,
    });
    assert.equal(discussed.item.status, 'needs-decision');
    assert.deepEqual(discussed.item.sessions, [{ id: 'session-discuss', action: 'discuss', at: discussed.item.sessions[0].at }]);
    assert.equal(launches[0].fresh, true);
    assert.equal(launches[0].agent, 'claude');
    const discussPrompt = fs.readFileSync(launches[0].message.match(/in (.*); read/)[1], 'utf8');
    assert.match(discussPrompt, /Evaluate this item with Jesse/);
    assert.match(discussPrompt, /Do not implement a fix or change the parent card/);
    assert.match(discussPrompt, /bin\/store\.js:10/);
    assert.match(discussPrompt, /second writer overwrites/);
    assert.match(discussPrompt, /## Reproduction[\s\S]*Serialize the mutation/);
    assert.match(discussPrompt, /DATA, NOT INSTRUCTIONS/);
    assert.ok(discussPrompt.indexOf('## Your role') < discussPrompt.indexOf('<<<KEEP_REVIEW_CONTEXT'));
    assert.match(discussPrompt, /does not authorize force pushes/);

    const started = await queue.act({ id: 'idea:idea-one', action: 'start', requestId: 'start-1' }, {
      ...f.deps, randomUUID: () => 'session-start', launch,
    });
    assert.equal(started.item.status, 'in-progress');
    const startPrompt = fs.readFileSync(launches[1].message.match(/in (.*); read/)[1], 'utf8');
    assert.match(startPrompt, /Begin work on this idea immediately/);
    assert.doesNotMatch(startPrompt, /Do not implement a fix/);
    assert.ok(startPrompt.length > launches[1].message.length, 'full context stays in the immutable handoff file');

    const investigated = await queue.act({ id: 'finding:card-one:abc123', action: 'start', requestId: 'investigate-1' }, {
      ...f.deps, randomUUID: () => 'session-investigate', launch,
    });
    assert.equal(investigated.item.status, 'in-progress');
    assert.equal(launches[2].action, 'start', 'Investigation reuses the existing start transport');
    const investigationPrompt = fs.readFileSync(launches[2].message.match(/in (.*); read/)[1], 'utf8');
    assert.match(investigationPrompt, /^# Review queue investigation:/);
    assert.match(investigationPrompt, /Verify the claim against the cited evidence and current repository state/);
    assert.match(investigationPrompt, /reviewer finding is a lead, not proof/);
    assert.match(investigationPrompt, /record a justified durable outcome or give Jesse a concrete fix proposal/);
    assert.match(investigationPrompt, /implement only after the finding is supported/);
    assert.doesNotMatch(investigationPrompt, /Starting work authorizes immediate implementation/);
  } finally { f.cleanup(); }
});

test('completed request retries and concurrent double clicks never launch twice', async () => {
  const f = fixture();
  let releases;
  let calls = 0;
  try {
    const launch = async (request) => {
      calls += 1;
      await new Promise((resolve) => { releases = async () => { await request.onLaunched({ pane: 'pane-one' }); resolve(); }; });
      return { sessionId: request.sessionId, pane: 'pane-one' };
    };
    const first = queue.act({ id: 'idea:idea-one', action: 'discuss', requestId: 'same-request' }, {
      ...f.deps, randomUUID: () => 'session-one', launch,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(queue.act({ id: 'idea:idea-one', action: 'discuss', requestId: 'other-click' }, {
      ...f.deps, randomUUID: () => 'session-two', launch,
    }), (error) => error.status === 409 && /still opening/.test(error.message));
    await releases();
    const completed = await first;
    const replay = await queue.act({ id: 'idea:idea-one', action: 'discuss', requestId: 'same-request' }, {
      ...f.deps, randomUUID: () => 'must-not-be-used', launch,
    });
    assert.equal(completed.sessionId, 'session-one');
    assert.equal(replay.sessionId, 'session-one');
    assert.equal(calls, 1);
  } finally { f.cleanup(); }
});

test('request ids are action-bound and Discuss can advise an in-progress item without changing status', async () => {
  const f = fixture();
  let sequence = 0;
  try {
    const launch = async (request) => {
      sequence += 1;
      await request.onLaunched({ pane: `pane-${sequence}` });
      return { sessionId: request.sessionId };
    };
    await queue.act({ id: 'idea:idea-one', action: 'start', requestId: 'start-item' }, {
      ...f.deps, randomUUID: () => 'work-session', launch,
    });
    const discussed = await queue.act({ id: 'idea:idea-one', action: 'discuss', requestId: 'discuss-progress' }, {
      ...f.deps, randomUUID: () => 'advice-session', launch,
    });
    assert.equal(discussed.item.status, 'in-progress');
    assert.deepEqual(discussed.item.sessions.map((entry) => entry.id), ['work-session', 'advice-session']);
    await assert.rejects(queue.act({ id: 'idea:idea-one', action: 'start', requestId: 'discuss-progress' }, {
      ...f.deps, randomUUID: () => 'wrong-action', launch,
    }), (error) => error.status === 409 && /different review queue action/.test(error.message));
    assert.equal(sequence, 2);
  } finally { f.cleanup(); }
});

test('pending launches reject concurrent state mutations and source resolution wins launch completion', async () => {
  const f = fixture();
  let finish;
  try {
    const launch = async (request) => {
      await request.onLaunched({ pane: 'finding-pane' });
      await new Promise((resolve) => { finish = resolve; });
      return { sessionId: request.sessionId };
    };
    const started = queue.act({ id: 'finding:card-one:abc123', action: 'start', requestId: 'finding-start' }, {
      ...f.deps, randomUUID: () => 'finding-session', launch,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(queue.act({ id: 'finding:card-one:abc123', action: 'defer', requestId: 'racing-defer', until: '2099-01-01T00:00:00Z' }, f.deps),
      (error) => error.status === 409);
    await assert.rejects(queue.act({ id: 'finding:card-one:abc123', action: 'dismiss', requestId: 'racing-dismiss', reason: 'race' }, { ...f.deps, reviewDismiss: () => assert.fail('must not dismiss during launch') }),
      (error) => error.status === 409 && /already opening/.test(error.message));
    f.findings[0].outcome = { status: 'fixed', message: 'fixed during launch', evidence: 'commit 123' };
    finish();
    const result = await started;
    assert.equal(result.item.status, 'resolved');
    assert.equal(queue.loadStore(f.root).items['finding:card-one:abc123'].status, 'resolved');
  } finally { f.cleanup(); }
});

test('mutations fail closed on a corrupt queue ledger', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(queue.storeFile(f.root), '{broken');
    await assert.rejects(queue.act({ id: 'idea:idea-one', action: 'defer', requestId: 'corrupt', until: '2099-01-01T00:00:00Z' }, f.deps),
      (error) => error.status === 500 && /unreadable; refusing mutation/.test(error.message));
    assert.equal(fs.readFileSync(queue.storeFile(f.root), 'utf8'), '{broken');
  } finally { f.cleanup(); }
});

test('an ambiguous spawn response retains its reservation until host absence is confirmed', async () => {
  const f = fixture();
  let calls = 0;
  try {
    const beforeSpawnFailure = async () => { calls += 1; throw new Error('host unavailable'); };
    await assert.rejects(queue.act({ id: 'idea:idea-one', action: 'discuss', requestId: 'failed-before' }, {
      ...f.deps, randomUUID: () => 'never-spawned', launch: beforeSpawnFailure,
    }), (error) => error.status === 502 && error.extra.item.launchState.sessionId === 'never-spawned');
    const pending = queue.snapshot(f.deps).items.find((item) => item.id === 'idea:idea-one');
    assert.equal(pending.launchState.state, 'needs-attention');
    assert.equal(pending.launchState.recoverable, true);
    await assert.rejects(queue.act({ id: 'idea:idea-one', action: 'discuss', requestId: 'failed-before' }, {
      ...f.deps, randomUUID: () => 'unused', launch: beforeSpawnFailure,
      inspectLaunch: async () => ({ state: 'unknown', message: 'host lookup unavailable' }),
    }), (error) => error.status === 503 && /lookup unavailable/.test(error.message));
    const retried = await queue.act({ id: 'idea:idea-one', action: 'discuss', requestId: 'retry-before' }, {
      ...f.deps, randomUUID: () => 'retry-session', inspectLaunch: async () => ({ state: 'absent' }), launch: async (request) => {
        calls += 1;
        await request.onLaunched({ pane: 'retry-pane' });
        return { sessionId: request.sessionId };
      },
    });
    assert.equal(retried.sessionId, 'retry-session');
    assert.equal(calls, 2);
  } finally { f.cleanup(); }
});

test('response-loss recovery delivers to the same reserved session and is single-flight', async () => {
  const f = fixture();
  let recoverCalls = 0;
  let releaseRecovery;
  try {
    await assert.rejects(queue.act({ id: 'idea:idea-one', action: 'discuss', requestId: 'lost-response' }, {
      ...f.deps, randomUUID: () => 'reserved-session', launch: async () => { throw new Error('spawn response lost'); },
    }), /spawn response lost/);
    const recoveryDeps = {
      ...f.deps,
      inspectLaunch: async (active) => {
        assert.equal(active.sessionId, 'reserved-session');
        return { state: 'present', pane: 'surviving-pane' };
      },
      recoverLaunch: async (active, hooks) => {
        recoverCalls += 1;
        assert.equal(active.sessionId, 'reserved-session');
        assert.match(active.pointer, /review queue instructions/);
        await hooks.onReady();
        await new Promise((resolve) => { releaseRecovery = async () => { await hooks.onDelivered(); resolve(); }; });
      },
    };
    const first = queue.act({ id: 'idea:idea-one', action: 'discuss', requestId: 'lost-response' }, recoveryDeps);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(queue.act({ id: 'idea:idea-one', action: 'discuss', requestId: 'lost-response' }, recoveryDeps),
      (error) => error.status === 409 && /still opening|already running/.test(error.message));
    await releaseRecovery();
    const result = await first;
    assert.equal(result.sessionId, 'reserved-session');
    assert.equal(recoverCalls, 1);
    assert.equal(result.item.launchState, undefined);
  } finally { f.cleanup(); }
});

test('recovery claim blocks dismissal while the prompt is pending', async () => {
  const f = fixture();
  let signalRecoveryStarted;
  const recoveryStarted = new Promise((resolve) => { signalRecoveryStarted = resolve; });
  let releasePrompt;
  let dismissed = false;
  try {
    await assert.rejects(queue.act({ id: 'finding:card-one:abc123', action: 'start', requestId: 'recover-start' }, {
      ...f.deps, randomUUID: () => 'recover-session', launch: async () => { throw new Error('spawn response lost'); },
    }), /spawn response lost/);
    const recovering = queue.act({ id: 'finding:card-one:abc123', action: 'start', requestId: 'recover-start' }, {
      ...f.deps,
      inspectLaunch: async () => ({ state: 'present', pane: 'recover-pane' }),
      recoverLaunch: async (_active, hooks) => {
        signalRecoveryStarted();
        await new Promise((resolve) => {
          releasePrompt = async () => {
            assert.equal(await hooks.onReady(), true);
            assert.equal(await hooks.onDelivered(), true);
            resolve();
          };
        });
      },
    });
    await recoveryStarted;
    await assert.rejects(queue.act({
      id: 'finding:card-one:abc123', action: 'dismiss', requestId: 'dismiss-during-recovery', reason: 'race',
    }, { ...f.deps, reviewDismiss: () => { dismissed = true; } }),
    (error) => error.status === 409 && /already opening/.test(error.message));
    assert.equal(dismissed, false);
    await releasePrompt();
    const result = await recovering;
    assert.equal(result.item.status, 'in-progress');
  } finally { f.cleanup(); }
});

test('a new daemon reclaims a recovery interrupted before readiness', async () => {
  const f = fixture();
  let recovered = 0;
  try {
    await assert.rejects(queue.act({ id: 'idea:idea-one', action: 'discuss', requestId: 'interrupted-recovery' }, {
      ...f.deps, ownerId: 'old-daemon', randomUUID: () => 'interrupted-session',
      launch: async () => { throw new Error('spawn response lost'); },
    }), /spawn response lost/);
    const store = queue.loadStore(f.root, { strict: true });
    store.items['idea:idea-one'].activeLaunch = {
      ...store.items['idea:idea-one'].activeLaunch,
      pane: 'surviving-pane', error: null, recoveryOwner: 'old-daemon',
    };
    queue.saveStore(store, f.root);

    const result = await queue.act({ id: 'idea:idea-one', action: 'discuss', requestId: 'interrupted-recovery' }, {
      ...f.deps, ownerId: 'new-daemon',
      inspectLaunch: async () => ({ state: 'present', pane: 'surviving-pane' }),
      recoverLaunch: async (_active, hooks) => {
        recovered += 1;
        assert.equal(await hooks.onReady(), true);
        assert.equal(await hooks.onDelivered(), true);
      },
    });
    assert.equal(result.sessionId, 'interrupted-session');
    assert.equal(result.item.launchState, undefined);
    assert.equal(recovered, 1);
  } finally { f.cleanup(); }
});

test('a confirmed exited pane clears the reservation and permits a fresh action', async () => {
  const f = fixture();
  let calls = 0;
  try {
    await assert.rejects(queue.act({ id: 'finding:card-one:abc123', action: 'start', requestId: 'exited-first' }, {
      ...f.deps, randomUUID: () => 'exited-session', launch: async (request) => {
        calls += 1;
        await request.onLaunched({ pane: 'exited-pane' });
        throw new Error('daemon stopped after pane creation');
      },
    }), /daemon stopped/);
    const result = await queue.act({ id: 'finding:card-one:abc123', action: 'start', requestId: 'fresh-after-exit' }, {
      ...f.deps,
      inspectLaunch: async () => ({ state: 'absent' }),
      randomUUID: () => 'replacement-session',
      launch: async (request) => {
        calls += 1;
        await request.onLaunched({ pane: 'replacement-pane' });
        return { sessionId: request.sessionId };
      },
    });
    assert.equal(result.sessionId, 'replacement-session');
    assert.equal(result.item.status, 'in-progress');
    assert.equal(result.item.launchState, undefined);
    assert.equal(calls, 2);
  } finally { f.cleanup(); }
});

test('ambiguous delivery is never retyped and automatic reconciliation clears it after exit', async () => {
  const f = fixture();
  let recoveryCalls = 0;
  try {
    await assert.rejects(queue.act({ id: 'idea:idea-one', action: 'discuss', requestId: 'ambiguous-delivery' }, {
      ...f.deps, randomUUID: () => 'ambiguous-session', launch: async (request) => {
        await request.onLaunched({ pane: 'ambiguous-pane' });
        await request.onReady();
        throw new Error('connection dropped during submit');
      },
    }), /connection dropped/);
    let item = queue.snapshot(f.deps).items.find((entry) => entry.id === 'idea:idea-one');
    assert.equal(item.launchState.state, 'needs-attention');
    assert.equal(item.launchState.recoverable, false);
    const present = await queue.reconcile({
      ...f.deps, ownerId: 'replacement-daemon',
      inspectLaunch: async () => ({ state: 'present', pane: 'ambiguous-pane' }),
      recoverLaunch: async () => { recoveryCalls += 1; },
    });
    assert.equal(present[0].status, 409);
    assert.equal(recoveryCalls, 0, 'typing may have begun, so reconciliation only exposes the conversation');
    await queue.reconcile({
      ...f.deps, ownerId: 'replacement-daemon',
      inspectLaunch: async () => ({ state: 'absent' }),
    });
    item = queue.snapshot(f.deps).items.find((entry) => entry.id === 'idea:idea-one');
    assert.equal(item.launchState, undefined);
    assert.match(item.launchError.message, /exited before launch completed/);
  } finally { f.cleanup(); }
});

test('dismiss records the reason under one lock and resolves finding history', async () => {
  const f = fixture();
  const dismissals = [];
  try {
    const result = await queue.act({ id: 'finding:card-one:abc123', action: 'dismiss', reason: 'False positive after checking both writers.' }, {
      ...f.deps,
      reviewDismiss: (...args) => dismissals.push(args),
    });
    assert.equal(result.item.status, 'resolved');
    assert.equal(result.item.outcome.reason, 'False positive after checking both writers.');
    assert.deepEqual(dismissals, [['card-one', 'abc123', 'False positive after checking both writers.', { withinLock: true }]]);
    assert.equal(queue.loadStore(f.root).items['finding:card-one:abc123'].outcome.status, 'dismissed');
  } finally { f.cleanup(); }
});

test('serve launcher suppresses card linking for Discuss and preserves it for Start', async () => {
  const link = () => ({ linked: true });
  const captures = [];
  const openSession = async (body, deps) => { captures.push({ body, deps }); return { sessionId: 's' }; };
  const base = { taskId: 'card-one', message: 'pointer', sessionId: 'reserved', onLaunched: () => {} };
  await launchReviewQueueSession({ ...base, action: 'discuss' }, { openSession, linkLaunchedSession: link, loadTask: () => ({}) });
  await launchReviewQueueSession({ ...base, action: 'start' }, { openSession, linkLaunchedSession: link, loadTask: () => ({}) });
  assert.deepEqual(captures.map((capture) => capture.body), [
    { taskId: 'card-one', fresh: true, agent: 'claude', message: 'pointer' },
    { taskId: 'card-one', fresh: true, agent: 'claude', message: 'pointer' },
  ]);
  assert.equal(captures[0].deps.randomUUID(), 'reserved');
  assert.equal(captures[0].deps.linkLaunchedSession(), null);
  assert.equal(captures[1].deps.linkLaunchedSession, link);
});

test('server recovery distinguishes unavailable, absent, exited, and live host panes and types once', async () => {
  const active = { sessionId: 'reserved', pane: 'pane-live', pointer: 'read pointer', action: 'discuss' };
  assert.deepEqual(await inspectReviewQueueLaunch(active, { panes: null }), {
    state: 'unknown', message: 'terminal host is unavailable; launch state cannot be reconciled safely',
  });
  assert.deepEqual(await inspectReviewQueueLaunch(active, { panes: [] }), { state: 'absent' });
  assert.deepEqual(await inspectReviewQueueLaunch(active, { panes: [{ id: 'old', alive: false, meta: { sessionId: 'reserved' } }] }), { state: 'absent' });
  assert.deepEqual(await inspectReviewQueueLaunch(active, { panes: [{ id: 'shell', alive: true, agentAlive: false, meta: { sessionId: 'reserved' } }] }), {
    state: 'unknown', pane: 'shell', message: 'reserved pane exists, but agent liveness needs another host observation',
  });
  assert.deepEqual(await inspectReviewQueueLaunch({ ...active, pane: 'shell' }, { panes: [{ id: 'shell', alive: true, agentAlive: false, meta: { sessionId: 'reserved' } }] }), { state: 'absent' });
  assert.deepEqual(await inspectReviewQueueLaunch(active, { panes: [{ id: 'live', alive: true, meta: { sessionId: 'reserved' } }] }), { state: 'present', pane: 'live' });
  const events = [];
  await recoverReviewQueueLaunch(active, {
    onReady: () => { events.push('ready'); return true; },
    onDelivered: () => { events.push('delivered'); return true; },
  }, {
    waitForHostAgent: async () => events.push('wait'),
    typeOpeningMessage: async (target, agent, message) => events.push({ target, agent, message }),
  });
  assert.deepEqual(events, [
    'wait', 'ready', { target: { pane: 'pane-live' }, agent: 'claude', message: 'read pointer' }, 'delivered',
  ]);
  let typed = false;
  await assert.rejects(recoverReviewQueueLaunch(active, { onReady: () => false }, {
    waitForHostAgent: async () => {},
    typeOpeningMessage: async () => { typed = true; },
  }), (error) => error.status === 409 && /reservation changed before/.test(error.message));
  assert.equal(typed, false, 'a lost reservation must prevent opening instructions from being typed');
});
