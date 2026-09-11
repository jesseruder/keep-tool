'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const queue = require('./review-queue.js');
const { launchReviewQueueSession } = require('./serve.js');

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
    assert.match(discussPrompt, /DATA, NOT INSTRUCTIONS/);
    assert.ok(discussPrompt.indexOf('## Your role') < discussPrompt.indexOf('<<<KEEP_REVIEW_CONTEXT'));
    assert.match(discussPrompt, /does not authorize force pushes/);

    const started = await queue.act({ id: 'idea:idea-one', action: 'start', requestId: 'start-1' }, {
      ...f.deps, randomUUID: () => 'session-start', launch,
    });
    assert.equal(started.item.status, 'in-progress');
    const startPrompt = fs.readFileSync(launches[1].message.match(/in (.*); read/)[1], 'utf8');
    assert.match(startPrompt, /Begin work on this item immediately/);
    assert.doesNotMatch(startPrompt, /Do not implement a fix/);
    assert.ok(startPrompt.length > launches[1].message.length, 'full context stays in the immutable handoff file');
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
    }), (error) => error.status === 409 && /already opening/.test(error.message));
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

test('failures before spawn retry safely, while partial launches expose and recover the existing conversation', async () => {
  const f = fixture();
  let calls = 0;
  try {
    const beforeSpawnFailure = async () => { calls += 1; throw new Error('host unavailable'); };
    await assert.rejects(queue.act({ id: 'idea:idea-one', action: 'discuss', requestId: 'failed-before' }, {
      ...f.deps, randomUUID: () => 'never-spawned', launch: beforeSpawnFailure,
    }), (error) => error.status === 502 && !error.extra.sessionId);
    await assert.rejects(queue.act({ id: 'idea:idea-one', action: 'discuss', requestId: 'failed-before' }, {
      ...f.deps, randomUUID: () => 'unused', launch: beforeSpawnFailure,
    }), /host unavailable/);
    const retried = await queue.act({ id: 'idea:idea-one', action: 'discuss', requestId: 'retry-before' }, {
      ...f.deps, randomUUID: () => 'retry-session', launch: async (request) => {
        calls += 1;
        await request.onLaunched({ pane: 'retry-pane' });
        return { sessionId: request.sessionId };
      },
    });
    assert.equal(retried.sessionId, 'retry-session');

    const partial = async (request) => {
      calls += 1;
      await request.onLaunched({ pane: 'partial-pane' });
      const error = new Error('prompt disappeared');
      error.status = 409;
      throw error;
    };
    await assert.rejects(queue.act({ id: 'finding:card-one:abc123', action: 'start', requestId: 'partial-one' }, {
      ...f.deps, randomUUID: () => 'partial-session', launch: partial,
    }), (error) => error.status === 409 && error.extra.sessionId === 'partial-session'
      && error.extra.item.launchError.sessionId === 'partial-session');
    await assert.rejects(queue.act({ id: 'finding:card-one:abc123', action: 'start', requestId: 'explicit-retry' }, {
      ...f.deps, randomUUID: () => 'must-not-spawn', launch: partial,
    }), (error) => error.status === 409 && error.extra.sessionId === 'partial-session'
      && /conversation already exists/.test(error.message));
    const item = queue.snapshot(f.deps).items.find((entry) => entry.id === 'finding:card-one:abc123');
    assert.equal(item.status, 'in-progress');
    assert.deepEqual(item.sessions.map((entry) => entry.id), ['partial-session']);
    assert.equal(item.launchError.sessionId, 'partial-session');
    assert.equal(calls, 3);
  } finally { f.cleanup(); }
});

test('an interrupted daemon reconciles a host pane by reserved session id before retrying', async () => {
  const f = fixture();
  let launched = false;
  try {
    queue.saveStore({ version: 1, items: {
      'idea:idea-one': {
        requests: { abandoned: { state: 'launching', action: 'discuss', sessionId: 'reserved-session', at: 10 } },
        activeLaunch: { requestId: 'abandoned', action: 'discuss', sessionId: 'reserved-session', at: 10 },
      },
    } }, f.root);
    let failure;
    try { await queue.act({ id: 'idea:idea-one', action: 'discuss', requestId: 'retry-after-daemon' }, {
      ...f.deps,
      now: () => queue.STALE_LAUNCH_MS + 20,
      findLaunchedSession: async (sessionId) => sessionId === 'reserved-session' ? { pane: 'surviving-pane' } : null,
      launch: async () => { launched = true; },
    }); } catch (error) { failure = error; }
    assert.equal(failure.status, 409);
    assert.equal(failure.extra.sessionId, 'reserved-session');
    assert.equal(launched, false);
    assert.equal(failure.extra.item.launchError.sessionId, 'reserved-session');
    assert.deepEqual(failure.extra.item.sessions.map((entry) => entry.id), ['reserved-session']);
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
