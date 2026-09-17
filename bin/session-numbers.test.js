'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const numbers = require('./session-numbers.js');

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'keep-session-numbers-'));
}

function registry(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.keep', 'session-numbers.json'), 'utf8'));
}

test('the first backfill numbers the oldest sessions lowest and never renumbers', () => {
  const dir = root();
  const sessions = [
    { id: 'newest', mtime: 3000 },
    { id: 'oldest', mtime: 1000 },
    { id: 'middle', mtime: 2000 },
  ];
  numbers.assign(sessions, { root: dir });
  assert.deepEqual(sessions.map((session) => [session.id, session.num]),
    [['newest', 3], ['oldest', 1], ['middle', 2]]);

  // A later scan labels the same sessions the same way and allocates only for new ones.
  const later = [{ id: 'middle', mtime: 2000 }, { id: 'fresh', mtime: 500 }];
  numbers.assign(later, { root: dir });
  assert.equal(later[0].num, 2, 'a known session keeps its number');
  assert.equal(later[1].num, 4, 'a newcomer takes the next number, never a freed one');

  // A session that scrolls out of the window and comes back is not renumbered.
  const returning = [{ id: 'oldest', mtime: 9000 }];
  numbers.assign(returning, { root: dir });
  assert.equal(returning[0].num, 1);
  assert.equal(registry(dir).next, 5);
});

test('startedAt wins over mtime when a session carries one', () => {
  const dir = root();
  const sessions = [
    { id: 'a', startedAt: 5000, mtime: 10 },
    { id: 'b', createdAt: new Date(1000).toISOString(), mtime: 20 },
  ];
  numbers.assign(sessions, { root: dir });
  assert.equal(sessions.find((session) => session.id === 'b').num, 1);
  assert.equal(sessions.find((session) => session.id === 'a').num, 2);
});

test('the registry file is written atomically and leaves no temporary behind', () => {
  const dir = root();
  numbers.assign([{ id: 'only', mtime: 1 }], { root: dir });
  const value = registry(dir);
  assert.deepEqual(value, { next: 2, ids: { only: 1 } });
  const left = fs.readdirSync(path.join(dir, '.keep'));
  assert.deepEqual(left, ['session-numbers.json'], 'no tmp file and no stale lock');
});

test('a held lock skips allocation but still labels the sessions the file knows', () => {
  const dir = root();
  numbers.assign([{ id: 'known', mtime: 1 }], { root: dir });
  const lock = numbers.lockFile(dir);
  fs.writeFileSync(lock, String(process.pid));
  try {
    const sessions = [{ id: 'known', mtime: 1 }, { id: 'unknown', mtime: 2 }];
    numbers.assign(sessions, { root: dir, lockRetries: 1, lockWaitMs: 1, lockStaleMs: 60000 });
    assert.equal(sessions[0].num, 1, 'a known id is still labelled');
    assert.equal(sessions[1].num, undefined, 'allocation waits for the next scan');
    assert.deepEqual(registry(dir).ids, { known: 1 }, 'the file is untouched');
  } finally { fs.unlinkSync(lock); }
});

test('a stale lock is overridden so one crash does not stop numbering forever', () => {
  const dir = root();
  fs.mkdirSync(path.join(dir, '.keep'), { recursive: true });
  const lock = numbers.lockFile(dir);
  fs.writeFileSync(lock, 'crashed');
  fs.utimesSync(lock, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  const sessions = [{ id: 'after-crash', mtime: 1 }];
  numbers.assign(sessions, { root: dir, lockRetries: 1, lockWaitMs: 1 });
  assert.equal(sessions[0].num, 1);
  assert.equal(fs.existsSync(lock), false);
});

test('a stale lock is not reclaimed while another contender holds the reclaim guard, unless that guard is stale too', () => {
  const dir = root();
  fs.mkdirSync(path.join(dir, '.keep'), { recursive: true });
  const lock = numbers.lockFile(dir);
  const guard = `${lock}.reclaim`;
  const old = new Date(Date.now() - 60000);
  fs.writeFileSync(lock, 'crashed');
  fs.utimesSync(lock, old, old);

  // Someone else is mid-reclaim: this scan neither touches the lock nor allocates.
  fs.writeFileSync(guard, '');
  const first = [{ id: 'later', mtime: 1 }];
  numbers.assign(first, { root: dir, lockRetries: 1, lockWaitMs: 1 });
  assert.equal(first[0].num, undefined, 'allocation waits for the next scan');
  assert.equal(fs.existsSync(lock), true, 'the stale lock is left for the reclaimer');
  assert.equal(fs.existsSync(guard), true);

  // A reclaim guard older than the stale window was left by a crash and is cleared.
  fs.utimesSync(guard, old, old);
  const second = [{ id: 'later', mtime: 1 }];
  numbers.assign(second, { root: dir, lockRetries: 2, lockWaitMs: 1 });
  assert.equal(second[0].num, 1);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(guard), false);
});

test('a lock reclaimed and replaced while its holder was still running is not deleted by that holder', () => {
  const dir = root();
  fs.mkdirSync(path.join(dir, '.keep'), { recursive: true });
  const lock = numbers.lockFile(dir);
  const result = numbers.withLock({ root: dir }, () => {
    // Simulate a reclaim by a faster contender: the holder's lock goes away and a
    // fresh one, belonging to someone else, takes its name.
    fs.unlinkSync(lock);
    fs.writeFileSync(lock, 'someone else');
    return 'ran';
  });
  assert.deepEqual(result, { value: 'ran' });
  assert.equal(fs.readFileSync(lock, 'utf8'), 'someone else', 'the replacement lock survives the release');
  fs.unlinkSync(lock);
  assert.deepEqual(numbers.withLock({ root: dir }, () => 'again'), { value: 'again' });
  assert.equal(fs.existsSync(lock), false, 'an undisturbed lock is released');
});

test('a corrupt registry is treated as empty rather than throwing out of a scan', () => {
  const dir = root();
  fs.mkdirSync(path.join(dir, '.keep'), { recursive: true });
  fs.writeFileSync(numbers.registryFile(dir), '{ not json');
  const sessions = [{ id: 'a', mtime: 1 }];
  assert.equal(numbers.assign(sessions, { root: dir }), sessions);
  assert.equal(sessions[0].num, 1);
});

test('parseNumber accepts the forms Owner types and refuses ids', () => {
  assert.equal(numbers.parseNumber('#12'), 12);
  assert.equal(numbers.parseNumber('12'), 12);
  assert.equal(numbers.parseNumber('s12'), 12);
  assert.equal(numbers.parseNumber('S12'), 12);
  assert.equal(numbers.parseNumber(' 7 '), 7);
  assert.equal(numbers.parseNumber(3), 3);
  assert.equal(numbers.parseNumber('999999'), 999999);
  assert.equal(numbers.parseNumber('0'), null);
  assert.equal(numbers.parseNumber(''), null);
  assert.equal(numbers.parseNumber(null), null);
  assert.equal(numbers.parseNumber('1234567'), null, 'seven digits is too long to be a number');
  assert.equal(numbers.parseNumber('12345678'), null, 'an eight-character token is an id prefix');
  assert.equal(numbers.parseNumber('abcdef12-0000-4000-8000-000000000001'), null);
  assert.equal(numbers.parseNumber('#abc'), null);
  assert.equal(numbers.parseNumber('12a'), null);
  assert.equal(numbers.label(12), '#12');
  assert.equal(numbers.label(0), '');
});

test('lookup reads both directions and never allocates', () => {
  const dir = root();
  numbers.assign([{ id: 'alpha', mtime: 1 }, { id: 'beta', mtime: 2 }], { root: dir });
  assert.deepEqual(numbers.lookup('#2', { root: dir }), { id: 'beta', num: 2 });
  assert.deepEqual(numbers.lookup(1, { root: dir }), { id: 'alpha', num: 1 });
  assert.deepEqual(numbers.lookup('alpha', { root: dir }), { id: 'alpha', num: 1 });
  assert.equal(numbers.lookup('#9', { root: dir }), null);
  assert.equal(numbers.lookup('gamma', { root: dir }), null);
  assert.deepEqual(registry(dir).ids, { alpha: 1, beta: 2 }, 'a lookup writes nothing');
});

test('the CLI reads numbers without allocating: pane ls labels the session column', async () => {
  const { ROOT } = require('./keep-core.js');
  const { renderPanePanes, resolveHostPane } = require('./commands/host.js');
  const id = 'abcdef12-0000-4000-8000-000000000001';
  numbers.assign([{ id, mtime: 1 }], { root: ROOT });

  const panes = [
    { id: 'p1', alive: true, cols: 80, rows: 24, title: 'one', cwd: '/tmp', meta: { agent: 'claude', sessionId: id } },
    { id: 'p2', alive: true, cols: 80, rows: 24, title: 'shell', cwd: '/tmp', meta: { agent: 'shell' } },
  ];
  const table = renderPanePanes(panes);
  assert.match(table, new RegExp(`#1 claude/${id}`));
  assert.ok(!/#\d+ +shell/.test(table), 'a shell pane has no session and no number');

  const client = { request: async () => ({ panes }) };
  assert.equal((await resolveHostPane(client, '#1')).id, 'p1', 'a number names the pane hosting that session');
  assert.equal((await resolveHostPane(client, 'p2')).id, 'p2', 'pane ids still resolve');

  // Pane ids may be all digits: the pane literally named 1 wins over session #1.
  const digitPanes = [...panes, { id: '1', alive: true, cols: 80, rows: 24, title: 'digits', cwd: '/tmp', meta: { agent: 'shell' } }];
  const digitClient = { request: async () => ({ panes: digitPanes }) };
  assert.equal((await resolveHostPane(digitClient, '1')).id, '1', 'an exact pane id beats a session number');
  assert.equal((await resolveHostPane(digitClient, '#1')).id, 'p1', '#1 still names the numbered session');
});
