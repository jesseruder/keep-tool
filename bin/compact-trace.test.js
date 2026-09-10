'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compactTrace } = require('./compact-trace');

test('timeout diagnostics distinguish transcript replacement, truncation, and stalled reads', () => {
  let now = 100;
  const rows = [];
  const trace = compactTrace({ id: 'session-1', kind: 'claude', text: 'private conversation' },
    line => rows.push(JSON.parse(line.slice('keep serve: compact diagnostic '.length))), () => now);
  trace.start({ size: 1000, ino: 1, dev: 1 }, 1000);
  now = 300;
  trace.submitted();
  now = 2300;
  trace.poll({ size: 1200, ino: 1, dev: 1 }, 1200, 200);
  trace.screenError();
  now = 6300;
  trace.poll({ size: 500, ino: 2, dev: 1 }, 1200, 0);
  trace.finish('timeout');
  const end = rows.at(-1);
  assert.equal(end.submitMs, 200);
  assert.equal(end.maxPollGapMs, 4000);
  assert.equal(end.replacements, 1);
  assert.equal(end.truncations, 1);
  assert.equal(end.offsetPastEnd, true);
  assert.equal(end.bytesRead, 200);
  assert.equal(end.screenReadErrors, 1);
  assert.equal(end.polls, 2);
  assert.equal(new Set(rows.map(r => r.attempt)).size, 1);
  assert.equal(JSON.stringify(rows).includes('private conversation'), false);
});

test('diagnostic output failures do not fail compaction', () => {
  const trace = compactTrace({ id: 'session-1', kind: 'claude' }, () => { throw Error('disk full'); });
  assert.doesNotThrow(() => {
    trace.start({ size: 0, ino: 1, dev: 1 }, 0);
    trace.submitted();
    trace.finish('marker-confirmed');
  });
});
