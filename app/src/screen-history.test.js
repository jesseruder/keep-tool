'use strict';

for (const key of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[key];

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  applyScreenHistoryPage, emptyScreenHistory, screenHistoryPath, visibleScreenRows,
} = require('./screen-history.js');

test('history pages prepend in order with stable row keys and a frozen tail', () => {
  const first = applyScreenHistoryPage(emptyScreenHistory(), {
    snapshot: 'snap', start: 2, lines: ['two', 'three'], tailStart: 4, tail: ['live'],
    cursor: 'snap.2', exhausted: false, pane: 'pane', cols: 80, rows: 24,
  });
  const anchoredKey = first.rows[0].key;
  assert.deepEqual(visibleScreenRows(first, ['new live output']).map((row) => row.text), ['two', 'three', 'live']);
  const second = applyScreenHistoryPage(first, {
    snapshot: 'snap', start: 0, lines: ['zero', 'one'], cursor: null, exhausted: true,
  });
  assert.deepEqual(visibleScreenRows(second, ['ignored']).map((row) => row.text), ['zero', 'one', 'two', 'three', 'live']);
  assert.equal(second.rows[2].key, anchoredKey, 'existing row identity survives a prepend for scroll anchoring');
  assert.equal(second.exhausted, true);
  assert.throws(() => applyScreenHistoryPage(second, {
    snapshot: 'snap', start: 0, lines: ['duplicate'], cursor: null, exhausted: true,
  }), /out of order/);
  assert.deepEqual(visibleScreenRows(emptyScreenHistory(), ['fresh live']).map((row) => row.text), ['fresh live'],
    'returning to Live drops the frozen snapshot');
});

test('history path addresses session and shell targets and encodes opaque cursors', () => {
  assert.equal(screenHistoryPath({ sessionId: 'a/b' }), '/api/screen/history?session=a%2Fb&lines=200&tailLines=120');
  assert.equal(screenHistoryPath({ pane: 'shell pane' }, { lines: 50, cursor: 'snap.200' }),
    '/api/screen/history?pane=shell%20pane&lines=50&cursor=snap.200');
});

test('history model rejects a changed snapshot', () => {
  const first = applyScreenHistoryPage(emptyScreenHistory(), {
    snapshot: 'one', start: 0, lines: [], tailStart: 0, tail: [], exhausted: true,
  });
  assert.throws(() => applyScreenHistoryPage(first, { snapshot: 'two', start: 0, lines: [] }),
    /snapshot changed/);
});
