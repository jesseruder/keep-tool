import test from 'node:test';
import assert from 'node:assert/strict';
import { cardRows, rankCards, rankSessions, rowAction, sessionRows, snippetHTML, textRows } from './session-search.js';

const rows = sessionRows([
  { id: 'a', num: 12, title: 'Fix the login bug', project: '/r/castle-www', state: 'exited', mtime: 300, taskId: 'login-bug' },
  { id: 'b', num: 384, title: 'Session search', project: '/r/keep-tool', state: 'running', mtime: 100 },
  { id: 'c', num: 7, title: 'Deploy 384 hosts', project: '/r/keep-tool', state: 'exited', mtime: 500 },
  { id: 'r', num: 1, title: 'Reviewer', reviewer: true, state: 'running' },
  { id: 'g', num: 2, title: 'Gone', state: 'exited', closing: true },
], {
  tasks: [{ id: 'login-bug', fm: { title: 'Users cannot sign in' } }],
  projectName: (path) => path.split('/').pop(),
  hidden: (session) => session.closing,
});

const ids = (list) => list.map((row) => row.id);

test('standing agents and closing sessions are not offered', () => {
  assert.deepEqual(ids(rows).sort(), ['a', 'b', 'c']);
});

test('every word must match title, number, project or card', () => {
  assert.deepEqual(ids(rankSessions(rows, 'keep search')), ['b']);
  assert.deepEqual(ids(rankSessions(rows, 'sign in')), ['a']);
  assert.deepEqual(ids(rankSessions(rows, 'login-bug')), ['a']);
  assert.deepEqual(ids(rankSessions(rows, 'nothing here')), []);
});

test('a session number beats a title that mentions it', () => {
  assert.deepEqual(ids(rankSessions(rows, '384')), ['b', 'c']);
  assert.deepEqual(ids(rankSessions(rows, '#384')), ['b']);
  assert.deepEqual(ids(rankSessions(rows, '#12')), ['a']);
});

test('an empty query leads with recently focused sessions, then live ones, then the newest', () => {
  assert.deepEqual(ids(rankSessions(rows, '', ['a'])), ['a', 'b', 'c']);
  assert.deepEqual(ids(rankSessions(rows, '')), ['b', 'c', 'a']);
});

const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

test('a snippet is escaped and its markers only ever open and close one mark', () => {
  assert.equal(snippetHTML('fix <b>\u0002websocket\u0003</b> & retry', esc), 'fix &lt;b&gt;<mark>websocket</mark>&lt;/b&gt; &amp; retry');
  assert.equal(snippetHTML('\u0003a\u0002\u0002b', esc), 'a<mark>b</mark>');
});

test('conversation hits list only sessions the console knows and title search did not already show', () => {
  const hits = [{ sessionId: 'b', role: 'assistant', snippet: 'x' }, { sessionId: 'a', role: 'user', snippet: 'y' },
    { sessionId: 'forgotten', role: 'user', snippet: 'z' }];
  const said = textRows(hits, rows, [rows.find((row) => row.id === 'b')]);
  assert.deepEqual(said.map((row) => [row.id, row.said, row.snippet, row.num]), [['a', 'You', 'y', 12]]);
});

test('cards match by id, title or tags, open ones first, and each goes to its best conversation', () => {
  const sessions = [
    { id: 'old', taskId: 'finder', mtime: 100, pane: 'p-old' },
    { id: 'live', taskId: 'finder', mtime: 50, pane: 'p-live', num: 9 },
    { id: 'agent', taskId: 'finder', mtime: 900, agentName: 'ops' },
    { id: 'gone', taskId: 'voice', mtime: 10, pane: 'p-gone' },
  ];
  const cards = cardRows([
    { id: 'finder', fm: { title: 'Console session finder', status: 'active', tags: ['personal'], updated: '2026-09-20' } },
    { id: 'voice', fm: { title: 'Voice chat finder notes', status: 'done', updated: '2026-09-25' } },
    { id: 'fresh', fm: { title: 'Finder on the phone', status: 'inbox', updated: '2026-09-10' } },
  ], sessions, { liveOf: (session) => session.pane === 'p-live' });
  assert.deepEqual(rankCards(cards, 'finder').map((card) => card.id), ['finder', 'fresh', 'voice']);
  assert.deepEqual(rankCards(cards, 'personal').map((card) => card.id), ['finder']);
  assert.deepEqual(rankCards(cards, ''), []);
  const byId = Object.fromEntries(cards.map((card) => [card.id, card]));
  assert.deepEqual([byId.finder.sessionId, byId.finder.sessionNum, byId.finder.sessionLive], ['live', 9, true],
    'a live conversation beats a newer exited one; a standing agent never counts');
  assert.deepEqual([byId.voice.sessionId, byId.voice.sessionLive], ['gone', false]);
  assert.equal(byId.fresh.sessionId, '');
});

test('Enter goes to a conversation; ⌘Enter reopens an exited one; a card without one starts it', () => {
  const live = { type: 'session', id: 'a', live: true };
  const exited = { type: 'session', id: 'b', live: false };
  assert.deepEqual(rowAction(live), { kind: 'open', sessionId: 'a' });
  assert.deepEqual(rowAction(live, true), { kind: 'open', sessionId: 'a' });
  assert.deepEqual(rowAction(exited), { kind: 'open', sessionId: 'b' });
  assert.deepEqual(rowAction(exited, true), { kind: 'reopen', sessionId: 'b' });
  const fresh = { type: 'card', id: 'c', sessionId: '' };
  assert.deepEqual(rowAction(fresh), { kind: 'start', card: fresh });
  assert.deepEqual(rowAction(fresh, true), { kind: 'start', card: fresh });
  assert.deepEqual(rowAction({ type: 'card', id: 'd', sessionId: 's', sessionLive: false }, true), { kind: 'reopen', sessionId: 's' });
  assert.deepEqual(rowAction({ type: 'card', id: 'd', sessionId: 's', sessionLive: true }, true), { kind: 'open', sessionId: 's' });
  assert.equal(rowAction(undefined), null);
});
