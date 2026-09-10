'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compactState, wantsCompactState, createJobChangeTracker } = require('./dashboard-state');

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
