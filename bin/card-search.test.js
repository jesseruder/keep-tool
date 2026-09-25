'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { searchCards, snippet } = require('./card-search.js');

const tasks = [
  { id: 'secret-handoff', fm: { title: 'Secret handoff: console Secret Drop', status: 'review', project: '~/keep-tool', updated: '2026-09-20' }, body: 'Built the drop.' },
  { id: 'aws-costs', fm: { title: 'AWS cost breakdown', status: 'done', project: '~/castle/ghost-server', updated: '2026-09-24', tags: ['castle'] },
    body: '## check-in\nMoved the LiveKit secret so the drop in spend shows.' },
  { id: 'old-drop', fm: { title: 'Drop the secret cache', status: 'done', project: '~/keep-tool', updated: '2026-08-01' }, body: '' },
  { id: 'unrelated', fm: { title: 'Voice chat', status: 'active', updated: '2026-09-25' }, body: 'nothing here' },
];

test('every word must match; whole-title matches lead, then the most recently updated', () => {
  assert.deepEqual(searchCards(tasks, 'secret drop').map((card) => card.id), ['secret-handoff', 'old-drop', 'aws-costs']);
  assert.deepEqual(searchCards(tasks, 'castle livekit').map((card) => card.id), ['aws-costs'], 'tags count');
  assert.deepEqual(searchCards(tasks, 'secret drop', { project: '~/keep-tool' }).map((card) => card.id), ['secret-handoff', 'old-drop']);
  assert.deepEqual(searchCards(tasks, 'secret drop', { limit: 1 }).map((card) => card.id), ['secret-handoff']);
  assert.deepEqual(searchCards(tasks, 'x'), []);
});

test('a card matched in its text carries the passage, with each word bracketed', () => {
  const [card] = searchCards(tasks, 'livekit spend');
  assert.equal(card.id, 'aws-costs');
  assert.equal(card.snippet, '## check-in Moved the [LiveKit] secret so the drop in [spend] shows.');
  assert.equal(searchCards(tasks, 'secret drop')[0].snippet, '', 'a title that says it all needs no passage');
  assert.equal(snippet('a'.repeat(100) + ' needle (x)', ['needle', '(x)']), `…${'a'.repeat(59)} [needle] [(x)]`);
});
