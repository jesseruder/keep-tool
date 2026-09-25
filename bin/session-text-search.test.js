'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ftsMatch, searchDatabase, createSessionTextSearch } = require('./session-text-search.js');

function database() {
  const { DatabaseSync } = require('node:sqlite');
  const handle = new DatabaseSync(':memory:');
  handle.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, agent TEXT, project TEXT, title TEXT, card_id TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER, role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT);
    CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='unicode61');
    CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text); END;`);
  const session = handle.prepare('INSERT INTO sessions (id, kind) VALUES (?, ?)');
  session.run('live', 'interactive');
  session.run('other', 'interactive');
  session.run('bg', 'headless');
  const message = handle.prepare('INSERT INTO messages (session_id, ts, role, kind, text) VALUES (?, ?, ?, ?, ?)');
  message.run('live', 1, 'user', 'human', 'please fix the websocket retry');
  message.run('live', 2, 'tool', 'tool_result', 'websocket websocket websocket build log');
  message.run('other', 3, 'assistant', 'text', 'The websocket reconnect now backs off.');
  message.run('bg', 4, 'user', 'human', 'websocket in a headless run');
  message.run('live', 5, 'assistant', 'text', 'Retry fixed for the websocket.');
  return handle;
}

test('every word is quoted, and only a last word still being typed is a prefix', () => {
  assert.equal(ftsMatch('ws'), null);
  assert.equal(ftsMatch('   '), null);
  assert.equal(ftsMatch('home-only NOT'), '"home-only" "NOT"*');
  assert.equal(ftsMatch('web so'), '"web" "so"');
  assert.equal(ftsMatch('websocket '), '"websocket"');
  assert.equal(ftsMatch('say "hi"'), '"say" """hi"""*');
});

const all = ['live', 'other', 'bg'];

test('one hit per interactive session, newest first, from prose and typed messages only', () => {
  const results = searchDatabase(database(), 'websocket', { sessions: all });
  assert.deepEqual(results.map((hit) => [hit.sessionId, hit.role, hit.hits]), [['live', 'assistant', 2], ['other', 'assistant', 1]]);
  assert.match(results[0].snippet, /\u0002websocket\u0003/);
  assert.deepEqual(searchDatabase(database(), 'build log', { sessions: all }), []);
  assert.deepEqual(searchDatabase(database(), 'reconn', { sessions: all }).map((hit) => hit.sessionId), ['other']);
  assert.deepEqual(searchDatabase(database(), 'websocket', { sessions: ['other', 'bg'] }).map((hit) => hit.sessionId), ['other']);
  assert.deepEqual(searchDatabase(database(), 'websocket', { sessions: [] }), [], 'no listed sessions, nothing to search');
  assert.deepEqual(searchDatabase(database(), 'websocket').map((hit) => hit.sessionId), ['live', 'other'], 'no list, every session');
  assert.deepEqual(searchDatabase(database(), 'websocket', { all: true }).map((hit) => [hit.sessionId, hit.hits]), [['live', 3], ['bg', 1], ['other', 1]]);
  assert.deepEqual(searchDatabase(database(), 'websocket', { since: 3 }).map((hit) => hit.sessionId), ['live', 'other']);
  assert.deepEqual(searchDatabase(database(), 'websocket', { since: 4 }).map((hit) => hit.sessionId), ['live']);
  assert.deepEqual(searchDatabase(database(), 'websocket', { sessionLimit: 1 }).map((hit) => hit.sessionId), ['live']);
  assert.equal(ftsMatch('web\u0000socket'), '"web" "socket"*');
});

class FakeWorker extends EventEmitter {
  constructor() { super(); FakeWorker.made.push(this); this.posted = []; this.terminated = false; }
  postMessage(message) { this.posted.push(message); }
  terminate() { this.terminated = true; return Promise.resolve(); }
  answer(results) { const { id } = this.posted.at(-1); this.emit('message', { id, results }); }
}

test('a newer search supersedes one that has not started, and a stuck one is abandoned', async () => {
  FakeWorker.made = [];
  const search = createSessionTextSearch({ Worker: FakeWorker, timeoutMs: 20 });
  const first = search.search('alpha', ['agent']);
  const second = search.search('bravo');
  const third = search.search('charlie');
  assert.equal(await second, null);
  const [worker] = FakeWorker.made;
  assert.deepEqual(worker.posted.map((message) => [message.query, message.sessions]), [['alpha', ['agent']]]);
  worker.answer([{ sessionId: 'a' }]);
  assert.deepEqual(await first, [{ sessionId: 'a' }]);
  assert.deepEqual(worker.posted.map((message) => message.query), ['alpha', 'charlie']);
  await assert.rejects(third, /timed out/);
  assert.equal(worker.terminated, true);
  const fourth = search.search('delta');
  assert.equal(FakeWorker.made.length, 2);
  FakeWorker.made[1].answer([]);
  assert.deepEqual(await fourth, []);
  assert.deepEqual(await search.search('no'), []);
  search.close();
});
