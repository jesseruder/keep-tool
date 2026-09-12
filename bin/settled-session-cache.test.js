'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSettledSessionCache } = require('./settled-session-cache');

const stat = (overrides = {}) => ({ dev: 1, ino: 2, size: 100, mtimeMs: 10, ctimeMs: 10, ...overrides });
const pane = (overrides = {}) => ({ id: 'pane-old', pid: 10, agentPid: 11, alive: false, agentAlive: false,
  createdAt: '2026-01-01T00:00:00Z', exitedAt: '2026-01-01T01:00:00Z',
  meta: { sessionId: 'old', agent: 'claude', accountId: 'work' }, ...overrides });
const input = (overrides = {}) => ({ agent: 'claude', id: 'old', file: '/accounts/work/projects/p/old.jsonl',
  stat: stat(), accountId: 'work', pane: pane(), independentLive: false, now: 1000, ...overrides });

test('unchanged exited sessions retain display state and avoid repeated derivation', () => {
  const cache = createSettledSessionCache({ recheckMs: 10000 });
  const saved = { session: { id: 'old', title: 'Title', lastAssistantFull: 'final answer' },
    backgroundJobs: { caughtUp: true, pending: false, uncertain: [], jobs: [] } };
  assert.equal(cache.set(input(), saved), true);
  const first = cache.get(input({ now: 2000 }));
  assert.equal(first.session.title, 'Title');
  assert.equal(first.session.lastAssistantFull, 'final answer');
  first.session.title = 'mutated';
  assert.equal(cache.get(input({ now: 3000 })).session.title, 'Title', 'callers cannot mutate the frozen value');
  assert.deepEqual(cache.stats(), { hits: 2, misses: 0, stores: 1, evictions: 0, invalidations: 0, size: 1 });
});

test('unrelated active transcript and lifecycle events do not thaw settled fleet rows', () => {
  const cache = createSettledSessionCache({ recheckMs: 10000 });
  cache.set(input(), { session: { id: 'old' }, backgroundJobs: { jobs: [] } });
  cache.invalidate({ kind: 'claude', root: '/accounts/work/projects', name: 'p/active.jsonl' });
  cache.invalidate({ kind: 'lifecycle', name: 'active/event.json' });
  assert.ok(cache.get(input({ now: 2000 })));
  cache.invalidate({ kind: 'claude', root: '/accounts/work/projects', name: 'p/old/subagents/agent-child.jsonl' });
  assert.equal(cache.get(input({ now: 2001 })), null, 'child transcript activity invalidates its parent');
});

test('rewrite resume new pane account handoff disappearance and fallback all invalidate', () => {
  const scenarios = [
    input({ stat: stat({ size: 101, mtimeMs: 11 }) }),
    input({ pane: pane({ alive: true, agentAlive: true }) }),
    input({ pane: pane({ id: 'pane-new', pid: 20, agentPid: 21 }) }),
    input({ accountId: 'other', file: '/accounts/other/projects/p/old.jsonl' }),
    input({ file: null, stat: null }),
    input({ independentLive: true }),
    input({ now: 20000 }),
  ];
  for (const changed of scenarios) {
    const cache = createSettledSessionCache({ recheckMs: 10000 });
    cache.set(input(), { session: { id: 'old' }, backgroundJobs: { jobs: [] } });
    assert.equal(cache.get(changed), null);
  }
});

test('source bookkeeping remains exact beyond the old 300-entry lookup bound', () => {
  const cache = createSettledSessionCache({ maxEntries: 512, recheckMs: 10000 });
  for (let i = 0; i < 400; i++) {
    const id = `session-${i}`;
    const args = input({ id, file: `/accounts/work/projects/p/${id}.jsonl`, stat: stat({ ino: i + 10 }),
      pane: pane({ id: `pane-${i}`, meta: { sessionId: id, agent: 'claude', accountId: 'work' } }) });
    cache.set(args, { session: { id, lastAssistantFull: `answer-${i}` }, backgroundJobs: { jobs: [] } });
  }
  assert.equal(cache.stats().size, 400);
  const last = input({ id: 'session-399', file: '/accounts/work/projects/p/session-399.jsonl', stat: stat({ ino: 409 }),
    pane: pane({ id: 'pane-399', meta: { sessionId: 'session-399', agent: 'claude', accountId: 'work' } }), now: 2000 });
  assert.equal(cache.get(last).session.lastAssistantFull, 'answer-399');
});
