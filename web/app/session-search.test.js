import test from 'node:test';
import assert from 'node:assert/strict';
import { rankSessions, sessionRows, snippetHTML, textRows } from './session-search.js';

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
