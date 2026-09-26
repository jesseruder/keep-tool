'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const refs = require('./refs');
const { rowSegments } = require('./row');

// One set of lines, run through the app's copies of the rules and the console's own.
const CORPUS = [
  'ask #453 about it, not PR #12, PR: #13, issue (#14), castle#15, ##16, #17-top, color: #123456',
  '(#12) and "#13" after #14: &#39; a/#3 x=#5',
  'keep claim keep-compact-is-refused-on-a-node now; content-rating, task-2; web/app/card-log.js a.b-c-d https://a-b-c.dev/x-y-z --no-verify',
  '⛔ ~/keep-tool [device:android-box] held until 15:23 (hold-mfq2x1ac) not [x] hold-nope-x',
  'landed 3229e2e and f92d3c2eb8401, (caca843). deadbeef 1234567 b1ecee59-908c-413e a/3229e2e #abc1234 0x3229e2e',
];

test('the app finds what the console finds, on every line', async () => {
  const web = await import(pathToFileURL(path.join(__dirname, '../../../web/app/terminal-refs.js')).href);
  for (const line of CORPUS) {
    for (const name of ['findSessionRefs', 'findCardRefs', 'findHoldRefs', 'findShaRefs']) {
      assert.deepEqual(refs[name](line), web[name](line), `${name} on: ${line}`);
    }
  }
});

const known = {
  sessions: new Map([[453, { id: 's453', num: 453, title: 'Hover links', project: '/r/keep-tool', state: 'running', taskId: 'hover', kind: 'claude', mtime: 1 }],
    [7, { id: 's7', num: 7, title: 'Seven', taskId: 'hover', mtime: 5 }]]),
  cards: new Map([['hover', { id: 'hover', title: 'Hover links', status: 'active', project: '/r/keep-tool' }],
    ['keep-compact-is-refused-on-a-node', { id: 'keep-compact-is-refused-on-a-node', title: 'keep compact is refused', status: 'active' }]]),
  holds: [{ id: 'hold-a', scopes: ['device:android-box'], until: '2026-09-25T15:23', untilMs: 1000 + 23 * 60e3, reason: 'grow', num: 429 }],
  unknownShas: new Set(['abcdef1']),
};

test('only known references are kept, overlaps go to the first and longest', () => {
  const line = 'see #453 and #999, keep-compact-is-refused-on-a-node [device:android-box] 3229e2e abcdef1 unknown-card-id';
  assert.deepEqual(refs.findRefs(line, known).map((ref) => [ref.kind, ref.key]), [
    ['session', 453], ['card', 'keep-compact-is-refused-on-a-node'], ['hold', 'scope:device:android-box'], ['sha', '3229e2e'],
  ]);
});

test('row pieces split at reference edges, keeping their styling, the cursor piece intact', () => {
  const row = { text: 'hi #453 ok', trimmed: 10, runs: [{ start: 0, end: 5, fg: 1 }, { start: 5, end: 10, fg: 2 }] };
  const segments = rowSegments(row, { offset: 9, length: 1 });
  const split = refs.splitSegments(segments, refs.findRefs(row.text, known));
  assert.equal(split.map((piece) => piece.text).join(''), row.text);
  assert.deepEqual(split.map((piece) => [piece.text, piece.run.fg, piece.ref?.key || null, Boolean(piece.cursor)]), [
    ['hi ', 1, null, false], ['#4', 1, 453, false], ['53', 2, 453, false], [' o', 2, null, false], ['k', 2, null, true],
  ]);
  assert.equal(refs.splitSegments(segments, []), segments);
});

test('the latest check-in skips the reviewer and bookkeeping, and reads next:', () => {
  const body = [
    '## Plan', '1. [x] a',
    '## 2026-09-25 10:00 — check-in (by claude abc) → active', 'Built it.', 'next: land', 'commits: abc1234',
    '## 2026-09-25 11:00 — review (fable) (reviewer fable)', 'looks fine',
    '## 2026-09-25 12:00 — landed (daemon)', 'abc1234',
  ].join('\n');
  assert.deepEqual(refs.latestLogEntry(body), { at: '2026-09-25 10:00', kind: 'check-in → active', text: 'Built it.', next: 'land' });
  assert.equal(refs.latestLogEntry('no log'), null);
});

test('each kind opens a sheet: sessions list mentions, cards their latest check-in, holds time left, SHAs the commit', () => {
  const now = 1000;
  const session = refs.describeRef({ kind: 'session', key: 453 }, known,
    { mentions: { status: 'ready', value: { sessions: [{ sessionId: 's12', num: 12, title: 'Other' }], cards: [{ title: 'Card', status: 'done' }] } } }, now);
  assert.equal(session.badge, '#453');
  assert.equal(session.meta, 'keep-tool · running');
  assert.deepEqual(session.sections[0].items, ['#12 Other', 'card Card (done)']);
  assert.equal(session.open, 's453');

  const loading = refs.describeRef({ kind: 'card', key: 'hover' }, known, {}, now);
  assert.equal(loading.pending, 'loading the latest check-in…');
  assert.equal(loading.open, 's7', 'the card\'s newest session');
  const card = refs.describeRef({ kind: 'card', key: 'hover' }, known,
    { detail: { status: 'ready', value: { body: '## 2026-09-25 10:00 — check-in\nShipped.\nnext: nothing' } } }, now);
  assert.equal(card.quote, 'Shipped.');
  assert.deepEqual(card.rows.find(([label]) => label === 'next'), ['next', 'nothing']);

  const hold = refs.describeRef({ kind: 'hold', key: 'scope:device:android-box' }, known, {}, now);
  assert.deepEqual(hold.rows, [['#429', 'until 2026-09-25 15:23 (23m left) · grow']]);

  assert.equal(refs.describeRef({ kind: 'sha', key: '3229e2e' }, known, {}, now).pending, 'loading the commit…');
  const sha = refs.describeRef({ kind: 'sha', key: '3229e2e' }, known, { commit: { status: 'ready', value: {
    commit: { sha: '3229e2eb8401', subject: 'console: hover', repo: '/r/keep-tool', branch: 'origin/master', landed: true, author: 'J', at: now },
    cards: [{ title: 'Hover links', status: 'done' }], review: { verdict: 'clean', by: 'codex sol' },
  } } }, now);
  assert.equal(sha.title, 'console: hover');
  assert.deepEqual(sha.rows, [['landed', 'on master'], ['review', 'clean · codex sol'], ['card', 'Hover links (done)']]);
  assert.equal(refs.describeRef({ kind: 'session', key: 1 }, known), null);
});
