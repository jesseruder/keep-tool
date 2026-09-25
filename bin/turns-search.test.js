'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-turns-search-'));
process.env.KEEP_TURN_INDEX_DB = path.join(dir, 'turns.sqlite');
process.env.KEEP_DIR = dir;
const turnIndex = require('./turn-index.js');
const { turnsSearch, search } = require('./commands/turns.js');

test.after(() => { try { turnIndex.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });

function seed() {
  const handle = turnIndex.open(turnIndex.databaseFile());
  handle.prepare("INSERT INTO sessions (id, agent, kind, project, card_id) VALUES (?, 'claude', 'interactive', '~/keep-tool', ?)").run('s-one', 'finder-card');
  handle.prepare("INSERT INTO sessions (id, agent, kind, project) VALUES (?, 'claude', 'interactive', '~/keep-tool')").run('s-two');
  const message = handle.prepare('INSERT INTO messages (session_id, seq, ts, role, kind, text) VALUES (?, ?, ?, ?, ?, ?)');
  message.run('s-one', 1, 100, 'user', 'human', 'fix the websocket retry');
  message.run('s-two', 1, 200, 'assistant', 'text', 'The websocket reconnects now.');
}

async function output(run) {
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(String(line));
  try { await run(); } finally { console.log = log; }
  return lines;
}

test('search rows carry the console\'s title and number, and fall back to the index without a daemon', async () => {
  seed();
  const state = { sessions: [{ id: 's-one', num: 12, title: 'Websocket retry fix', state: 'waiting' }] };
  const getKeepApi = async (pathname) => {
    assert.equal(pathname, '/api/state?console=1');
    return { status: 200, data: JSON.stringify(state) };
  };
  const [rows] = await output(() => turnsSearch(['websocket', '--json'], { getKeepApi }));
  const hits = JSON.parse(rows);
  assert.deepEqual(hits.map((hit) => [hit.sessionId, hit.num, hit.title, hit.state || null]),
    [['s-two', null, '', null], ['s-one', 12, 'Websocket retry fix', 'waiting']]);
  assert.match(hits[0].snippet, /\[websocket\]/i);

  const text = await output(() => turnsSearch(['websocket'], { getKeepApi }));
  assert.equal(text[2], '#12 (s-one)  ·  Websocket retry fix  ·  waiting  ·  finder-card  ·  keep-tool  ·  ' + text[2].split('  ·  ')[5]);
  assert.match(text[3], /^ {4}you: fix the \[websocket\] retry/);

  const offline = JSON.parse((await output(() => turnsSearch(['websocket', '--json'], { getKeepApi: async () => { throw new Error('ECONNREFUSED'); } })))[0]);
  assert.deepEqual(offline.map((hit) => hit.title), ['', '']);
});

test('keep search answers with cards and conversations, and either alone on request', async () => {
  const loadAll = () => [{ id: 'websocket-retry', fm: { title: 'Websocket retry', status: 'active', updated: '2026-09-25' }, body: '' }];
  const getKeepApi = async () => ({ status: 200, data: JSON.stringify({ sessions: [] }) });
  const both = JSON.parse((await output(() => search(['websocket', '--json'], { loadAll, getKeepApi })))[0]);
  assert.deepEqual(both.cards.map((card) => card.id), ['websocket-retry']);
  assert.deepEqual(both.conversations.map((hit) => hit.sessionId), ['s-two', 's-one']);
  const cards = JSON.parse((await output(() => search(['websocket', '--cards', '--json'], { loadAll, getKeepApi })))[0]);
  assert.deepEqual([cards.cards.length, cards.conversations.length], [1, 0]);
  const talk = JSON.parse((await output(() => search(['websocket', '--conversations', '--json'], { loadAll, getKeepApi })))[0]);
  assert.deepEqual([talk.cards.length, talk.conversations.length], [0, 2]);
  const text = await output(() => search(['websocket'], { loadAll, getKeepApi }));
  assert.deepEqual([text[0], text[2], text[3]], ['Cards', '', 'Conversations']);
});

test('a pruned interactive session keeps its words in the archive, and search still finds it until the archive horizon', () => {
  const { searchDatabase } = require('./session-text-search.js');
  const handle = turnIndex.open(turnIndex.databaseFile());
  handle.prepare("INSERT INTO sessions (id, agent, kind, project, card_id, last_at) VALUES ('old', 'claude', 'interactive', '~/keep-tool', 'old-card', 1000)").run();
  handle.prepare("INSERT INTO sessions (id, agent, kind, project, last_at) VALUES ('old-bg', 'claude', 'headless', '~/keep-tool', 1000)").run();
  const message = handle.prepare('INSERT INTO messages (session_id, seq, ts, role, kind, text) VALUES (?, ?, ?, ?, ?, ?)');
  message.run('old', 1, 900, 'user', 'human', 'decide the zeppelin schema');
  message.run('old', 2, 950, 'tool', 'tool_result', 'zeppelin build log');
  message.run('old', 3, 990, 'assistant', 'text', 'The zeppelin schema is settled.');
  message.run('old-bg', 1, 900, 'user', 'human', 'zeppelin in a headless run');

  const dry = turnIndex.prune({ cutoff: 5000, dry: true });
  assert.deepEqual([dry.sessions, dry.archived], [2, 2]);
  const pruned = turnIndex.prune({ cutoff: 5000, archiveCutoff: 0 });
  assert.deepEqual([pruned.sessions, pruned.messages, pruned.archived, pruned.archiveDropped], [2, 4, 2, 0]);
  assert.equal(handle.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id IN ('old', 'old-bg')").get().n, 0);

  const [hit, ...rest] = searchDatabase(handle, 'zeppelin schema');
  assert.equal(rest.length, 0, 'the headless run and the tool output were not archived');
  assert.deepEqual([hit.sessionId, hit.archived, hit.card, hit.hits, hit.role], ['old', true, 'old-card', 2, 'assistant']);
  assert.deepEqual(searchDatabase(handle, 'zeppelin', { sessions: ['other'] }), []);
  assert.deepEqual(searchDatabase(handle, 'zeppelin', { since: 950 }).map((row) => row.hits), [1]);

  assert.equal(turnIndex.prune({ cutoff: 5000, archiveCutoff: 1001 }).archiveDropped, 1);
  assert.deepEqual(searchDatabase(handle, 'zeppelin'), []);
});
