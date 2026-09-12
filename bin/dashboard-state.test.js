'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compactState,
  wantsCompactState,
  lightweightState,
  wantsLightweightState,
  dashboardDetail,
  reviewQueueSearch,
  createJobChangeTracker,
} = require('./dashboard-state');

test('already-open consoles use compact state while legacy and CLI clients retain full responses', () => {
  const url = new URL('http://localhost/api/state');
  assert.equal(wantsCompactState({ headers: {} }, url), false);
  assert.equal(wantsCompactState({ headers: { referer: 'http://localhost/' } }, url), false);
  assert.equal(wantsCompactState({ headers: { referer: 'http://localhost/apple' } }, url), false);
  assert.equal(wantsCompactState({ headers: { referer: 'http://localhost/app' } }, url), true);
  assert.equal(wantsCompactState({ headers: { referer: 'http://localhost/app/' } }, url), true);
  assert.equal(wantsCompactState({ headers: {} }, new URL(url + '?compact=1')), true);
  assert.equal(wantsCompactState({ headers: { referer: 'http://localhost/app' } }, new URL(url + '?compact=0')), false);
});

test('console state removes unused histories while preserving inbox notes and safety flags', () => {
  const state = {
    tasks: [{ id: 'inbox', body: 'notes', fm: { title: 'Card' } }, { id: 'other', body: 'long history', lastLog: 'latest' }],
    notifications: [{ card: 'inbox' }],
    sessions: [{ id: 's', backgroundJobs: [{ id: 'job', status: 'completed' }], pendingBackground: true, unknownBackgroundJobs: ['unknown'], lastAssistantFull: 'answer' }],
    attention: [{ sessionId: 's' }],
  };
  const before = JSON.stringify(state);
  const compact = compactState(state);
  assert.equal(compact.tasks[0].body, 'notes');
  assert.equal(Object.hasOwn(compact.tasks[1], 'body'), false);
  assert.equal(compact.tasks[1].lastLog, 'latest');
  assert.equal(Object.hasOwn(compact.sessions[0], 'backgroundJobs'), false);
  assert.equal(compact.sessions[0].pendingBackground, true);
  assert.deepEqual(compact.sessions[0].unknownBackgroundJobs, ['unknown']);
  assert.equal(compact.sessions[0].lastAssistantFull, 'answer');
  assert.deepEqual(compact.attention, state.attention);
  assert.equal(JSON.stringify(state), before, 'internal and legacy state is unmodified');
});

test('lightweight dashboard state preserves list context and moves opened content to details', () => {
  const longLog = 'x'.repeat(800);
  const state = {
    generatedAt: 123,
    tasks: [{
      id: 'card', body: '## 2026-09-07 12:34 — created\n\nFull task history', modelUsage: { total: 42 }, lastLog: longLog,
      fm: { title: 'Card', status: 'review', kind: 'task', project: '/repo', tags: ['work'], depends_on: ['upstream'], sessions: [{ id: 'linked' }], check: 'expensive recipe', probe: 'true' },
      overdue: true,
    }],
    sessions: [{
      id: 'session', title: 'Live work', state: 'waiting', stateLabel: 'Waiting', taskId: 'card',
      lastAssistant: 'Short update', lastAssistantFull: 'Full transcript tail', observation: { evidence: ['large'] },
      runtime: { process: 'details' }, backgroundJobs: [{ id: 'ledger-entry', status: 'completed' }],
      pendingBackground: true, activity: { background: { pending: true } },
    }],
    reviewQueue: { counts: { 'needs-decision': 1 }, items: [{
      id: 'finding:card:key', type: 'finding', status: 'needs-decision', title: 'Finding', card: 'card',
      project: '/repo', at: 123, body: 'searchable note', evidence: 'full evidence', outcome: { status: 'unresolved' },
      sessions: [{ id: 'discussion', action: 'discuss', at: 124 }],
    }] },
    notifications: [{ id: 'notification', card: 'card', read: false }],
    attention: [{ sessionId: 'session', kind: 'input' }],
  };
  const before = JSON.stringify(state);
  const summary = lightweightState(state);

  assert.equal(summary.generatedAt, 123);
  assert.deepEqual(summary.reviewQueue.counts, state.reviewQueue.counts);
  assert.deepEqual(summary.notifications, state.notifications);
  assert.deepEqual(summary.attention, state.attention);
  assert.equal(summary.tasks[0].body, undefined);
  assert.equal(summary.tasks[0].modelUsage, undefined);
  assert.equal(summary.tasks[0].fm.check, undefined);
  assert.equal(summary.tasks[0].fm.probe, undefined);
  assert.equal(summary.tasks[0].fm.title, 'Card');
  assert.deepEqual(summary.tasks[0].fm.sessions, [{ id: 'linked' }]);
  assert.equal(summary.tasks[0].createdAt, '2026-09-07T12:34');
  assert.equal(summary.tasks[0].hasCheck, true);
  assert.equal(summary.tasks[0].lastLog.length, 500);
  assert.equal(summary.sessions[0].lastAssistantFull, 'Full transcript tail');
  assert.equal(summary.sessions[0].observation, undefined);
  assert.equal(summary.sessions[0].runtime, undefined);
  assert.equal(summary.sessions[0].backgroundJobs, undefined);
  assert.equal(summary.sessions[0].pendingBackground, true);
  assert.equal(summary.sessions[0].lastAssistant, 'Short update');
  assert.deepEqual(summary.sessions[0].activity, state.sessions[0].activity);
  assert.equal(summary.reviewQueue.items[0].body, undefined);
  assert.equal(summary.reviewQueue.items[0].evidence, undefined);
  assert.equal(summary.reviewQueue.items[0].outcome, undefined);
  assert.equal(summary.reviewQueue.items[0].sessions, undefined);
  assert.equal(typeof summary.tasks[0]._detailVersion, 'string');
  assert.equal(JSON.stringify(state), before, 'source state is not mutated');

  assert.deepEqual(dashboardDetail(state, 'task', 'card').value, state.tasks[0]);
  assert.deepEqual(dashboardDetail(state, 'session', 'session').value, state.sessions[0]);
  assert.deepEqual(dashboardDetail(state, 'review', 'finding:card:key').value, state.reviewQueue.items[0]);
  assert.equal(dashboardDetail(state, 'task', 'card').version, summary.tasks[0]._detailVersion);
});

test('dashboard detail validation and full review-note search stay explicit', () => {
  const state = { reviewQueue: { items: [
    { id: 'one', title: 'Visible title', body: 'ordinary notes' },
    { id: 'two', title: 'Other title', body: 'Needle only appears in the full notes' },
  ] } };
  assert.deepEqual(reviewQueueSearch(state, 'needle'), { ids: ['two'] });
  assert.deepEqual(reviewQueueSearch(state, 'visible'), { ids: ['one'] });
  assert.throws(() => dashboardDetail(state, 'unknown', 'one'), (error) => error.status === 400);
  assert.throws(() => dashboardDetail(state, 'review', 'missing'), (error) => error.status === 404);
});

test('lightweight mode is opt-in and does not change compact or mobile query behavior', () => {
  assert.equal(wantsLightweightState(new URL('http://localhost/api/state')), false);
  assert.equal(wantsLightweightState(new URL('http://localhost/api/state?compact=1')), false);
  assert.equal(wantsLightweightState(new URL('http://localhost/api/state?view=home')), false);
  assert.equal(wantsLightweightState(new URL('http://localhost/api/state?summary=1')), true);
});

test('job reconciliation notifies for meaningful changes, including child-only completion and stale confidence', () => {
  const changed = createJobChangeTracker();
  const result = { pending: true, uncertain: [], recovering: false, gap: false, bytesRead: 0,
    jobs: [{ id: 'child', kind: 'agent', status: 'pending', eventAt: 1, lastCorroboratedAt: 2, confidence: 'observed' }] };
  assert.equal(changed('s', result), true);
  result.lastReconciledAt = 3;
  result.bytesRead = 100;
  result.jobs[0].lastCorroboratedAt = 3;
  assert.equal(changed('s', result), false, 'no repeated refresh for unchanged retained jobs');
  assert.equal(changed('s', { pending: false, uncertain: ['ledger-busy'], jobs: [] }), false);
  assert.equal(changed('s', result), false, 'contention did not replace the last known signature');
  assert.equal(changed('other', result), true, 'sessions are independent');
  result.uncertain = ['child']; result.jobs[0].confidence = 'uncertain';
  assert.equal(changed('s', result), true);
  result.bytesRead = 0; result.pending = false; result.uncertain = [];
  result.jobs[0].status = 'completed'; result.jobs[0].confidence = 'observed';
  assert.equal(changed('s', result), true, 'completion outside the parent transcript is visible');
  assert.equal(changed('s', result), false, 'completed tombstone no longer refreshes forever');
  result.gap = true;
  assert.equal(changed('s', result), true);
});
