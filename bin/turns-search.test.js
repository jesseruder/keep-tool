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
const { turnsSearch } = require('./commands/turns.js');

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
