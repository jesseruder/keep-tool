'use strict';

for (const key of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[key];

const assert = require('node:assert/strict');
const test = require('node:test');
const { createScreenHistoryCache, retainNewestLines } = require('./screen-history');

test('screen history snapshot pages backward without gaps and keeps its live tail stable', () => {
  let clock = 1000;
  const cache = createScreenHistoryCache({ now: () => clock, makeId: () => 'snapshot-one' });
  const history = Array.from({ length: 450 }, (_, index) => `line-${index}`);
  const first = cache.create({
    key: 'pane:created', history,
    lines: history,
    tail: ['live-a', 'live-b'],
    meta: { pane: 'pane', cols: 80, rows: 24 },
  }, 200);
  assert.deepEqual(first.lines, history.slice(250));
  assert.deepEqual(first.tail, ['live-a', 'live-b']);
  assert.equal(first.snapshot, 'snapshot-one');
  assert.equal(first.start, 250);
  assert.equal(first.tailStart, 450);
  assert.equal(first.cursor, 'snapshot-one.250');
  assert.equal(first.exhausted, false);

  const second = cache.read(first.cursor, 'pane:created', 200);
  assert.deepEqual(second.lines, history.slice(50, 250));
  assert.equal(second.start, 50);
  assert.equal(Object.hasOwn(second, 'tail'), false);
  const third = cache.read(second.cursor, 'pane:created', 200);
  assert.deepEqual(third.lines, history.slice(0, 50));
  assert.equal(third.cursor, null);
  assert.equal(third.exhausted, true);
  assert.deepEqual([...third.lines, ...second.lines, ...first.lines, ...first.tail], [...history, 'live-a', 'live-b']);
  clock += 1;
});

test('screen history rejects expired and wrong-pane cursors', () => {
  let clock = 0;
  const cache = createScreenHistoryCache({ ttlMs: 10, now: () => clock, makeId: () => 'one' });
  const first = cache.create({ key: 'pane:a', lines: ['old'], tail: [], meta: {} }, 1);
  assert.equal(first.cursor, null);
  const paged = cache.create({ key: 'pane:a', lines: ['one', 'two'], tail: [], meta: {} }, 1);
  assert.deepEqual(cache.read(paged.cursor, 'pane:b', 1), { error: 'target' });
  clock = 11;
  assert.deepEqual(cache.read(paged.cursor, 'pane:a', 1), { error: 'expired' });
  assert.equal(cache.stats().snapshots, 0);
});

test('screen history bounds retained bytes and evicts old snapshots by count', () => {
  let id = 0;
  const cache = createScreenHistoryCache({
    maxSnapshotBytes: 12,
    maxTotalBytes: 24,
    maxSnapshots: 2,
    makeId: () => `s${++id}`,
  });
  const bounded = cache.create({ key: 'a', lines: ['111', '222', '333', '444'], tail: [], meta: {} }, 10);
  assert.deepEqual(bounded.lines, ['222', '333', '444']);
  assert.equal(bounded.truncated, true);
  cache.create({ key: 'b', lines: ['b'], tail: [], meta: {} }, 1);
  cache.create({ key: 'c', lines: ['c'], tail: [], meta: {} }, 1);
  assert.equal(cache.stats().snapshots, 2);
  assert.deepEqual(cache.read('s1.1', 'a', 1), { error: 'expired' });
  assert.deepEqual(retainNewestLines(['aa', 'bbb', 'c'], 6), { lines: ['bbb', 'c'], bytes: 6, truncated: true });
  assert.throws(() => cache.create({ key: 'huge', lines: [], tail: ['1234567890123'], meta: {} }, 1),
    /tail exceeds history snapshot limit/);
});
