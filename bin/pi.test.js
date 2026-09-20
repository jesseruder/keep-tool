'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pi = require('./pi');

test('Pi scanner follows the selected branch and lifecycle through running, settled, and shutdown', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-pi-'));
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const sessionsDir = path.join(root, 'sessions');
  const projectDir = path.join(sessionsDir, '--project--');
  const eventsDir = path.join(root, '.keep', 'pi-events');
  const file = path.join(projectDir, `2026-09-20T00-00-00Z_${id}.jsonl`);
  const eventFile = path.join(eventsDir, `${id}.json`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(eventsDir, { recursive: true });
  const at = (seconds) => `2026-09-20T00:00:${String(seconds).padStart(2, '0')}.000Z`;
  const row = (type, entryId, parentId, timestamp, extra) => ({ type, id: entryId, parentId, timestamp, ...extra });
  const message = (entryId, parentId, timestamp, role, text) => row('message', entryId, parentId, timestamp,
    { message: { role, content: [{ type: 'text', text }], timestamp: Date.parse(timestamp), ...(role === 'assistant' ? { model: 'minimax-m3' } : {}) } });
  fs.writeFileSync(file, [
    { type: 'session', id, cwd: '/project', timestamp: at(0), version: 3 },
    row('model_change', 'm', null, at(1), { provider: 'openrouter', modelId: 'minimax/minimax-m3' }),
    message('u1', 'm', at(2), 'user', 'First request'),
    message('a1', 'u1', at(3), 'assistant', 'First reply'),
    message('u2', 'a1', at(4), 'user', 'Abandoned branch'),
    message('a2', 'u2', at(5), 'assistant', 'Abandoned reply'),
    message('u3', 'a1', at(6), 'user', 'Current request'),
    message('a3', 'u3', at(7), 'assistant', 'Current reply'),
    row('session_info', 'n', 'a3', at(8), { name: 'Named Pi task' }),
  ].map((value) => JSON.stringify(value)).join('\n') + '\n');
  const setEvent = (phase, leafId, seconds) => {
    fs.writeFileSync(eventFile, JSON.stringify({ id, phase, leafId, at: at(seconds) }));
    fs.utimesSync(eventFile, new Date(Date.now() + seconds * 1000), new Date(Date.now() + seconds * 1000));
  };
  try {
    setEvent('running', 'a3', 10);
    let found = pi.scan({ sessionsDir, eventsDir });
    assert.equal(found.length, 1);
    assert.equal(found[0].state, 'running');
    assert.equal(found[0].endedTurn, false);
    assert.equal(found[0].lastUser, 'Current request');
    assert.equal(found[0].lastAssistant, 'Current reply');
    assert.equal(found[0].title, 'Named Pi task');
    assert.equal(found[0].sessionFile, file);
    assert.doesNotMatch(pi.recentText(file, { eventsDir }), /Abandoned branch/);
    setEvent('settled', 'a1', 11);
    found = pi.sessionFor(id, { sessionsDir, eventsDir });
    assert.equal(found.endedTurn, true);
    assert.equal(found.lastUser, 'First request', 'a tree switch reads its selected leaf');
    setEvent('shutdown', 'a1', 12);
    assert.equal(pi.sessionFor(id, { sessionsDir, eventsDir }).exited, true);
    setEvent('running', 'a1', 13);
    fs.appendFileSync(file, JSON.stringify(message('u4', 'a1', at(14), 'user', 'New branch request')) + '\n');
    let appended = pi.sessionFor(id, { sessionsDir, eventsDir });
    assert.equal(appended.lastUser, 'New branch request', 'agent_start may precede Pi writing the user message');
    assert.equal(appended.state, 'running');
    setEvent('shutdown', 'a1', 15);
    fs.appendFileSync(file, JSON.stringify(message('a4', 'u4', at(16), 'assistant', 'External reply')) + '\n');
    appended = pi.sessionFor(id, { sessionsDir, eventsDir });
    assert.equal(appended.lastAssistant, 'External reply');
    assert.equal(appended.exited, false, 'a stale managed shutdown cannot hide later external activity');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Pi scanner ignores corrupt and incomplete JSONL rows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-pi-corrupt-'));
  const dir = path.join(root, 'sessions', '--project--');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bad.jsonl'), '{not-json}\n');
  fs.writeFileSync(path.join(dir, 'good_abcdef12.jsonl'),
    '{"type":"session","version":3,"id":"abcdef12","cwd":"/project"}\n{"type":"message"\n');
  try {
    const found = pi.scan({ sessionsDir: path.join(root, 'sessions'), eventsDir: path.join(root, 'events') });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, 'abcdef12');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
