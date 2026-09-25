'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { spawnSync } = require('node:child_process');

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
  assert.deepEqual(left.sort(), ['session-numbers-backups', 'session-numbers.json', 'session-numbers.last.json'],
    'no tmp file and no stale lock');
  assert.equal(fs.readdirSync(path.join(dir, '.keep', 'session-numbers-backups')).filter((name) => name.includes('.tmp-')).length, 0);
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

test('a number is not handed out when the registry write fails', () => {
  const dir = root();
  // A directory where the registry file belongs makes the atomic rename fail.
  fs.mkdirSync(path.join(dir, '.keep', 'session-numbers.json'), { recursive: true });
  const rows = [{ id: 'unsaved', mtime: 1 }];
  numbers.assign(rows, { root: dir });
  assert.equal(rows[0].num, undefined);
});

test('ref and named print a session by its number, falling back to the id prefix', () => {
  const dir = root();
  const numbered = '4f1c2a9e-0000-4000-8000-000000000001';
  const unnumbered = 'a9b8c7d6-0000-4000-8000-000000000002';
  assert.equal(numbers.ref(numbered, { root: dir }), '4f1c2a9e', 'no registry yet: the prefix');
  numbers.assign([{ id: numbered, mtime: 1 }], { root: dir });
  assert.equal(numbers.ref(numbered, { root: dir }), '#1');
  assert.equal(numbers.named(numbered, { root: dir }), `#1 (${numbered})`);
  assert.equal(numbers.ref(unnumbered, { root: dir }), 'a9b8c7d6');
  assert.equal(numbers.named(unnumbered, { root: dir }), unnumbered);
  assert.equal(numbers.ref(undefined, { root: dir }), '');
  assert.equal(numbers.ref('', { root: dir }), '');

  // The cache follows the registry file: a number allocated later shows up.
  numbers.assign([{ id: unnumbered, mtime: 2 }], { root: dir });
  assert.equal(numbers.ref(unnumbered, { root: dir }), '#2');
});

test('a machine with no registry shows no numbers and refuses one by name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-no-registry-'));
  try {
    // A directory, but not a registry: no .keep, so there are no numbers to read.
    const script = `
      const { renderPanePanes, resolveHostPane } = require(${JSON.stringify(path.join(__dirname, 'commands', 'host.js'))});
      const panes = [{ id: 'p1', alive: true, cols: 80, rows: 24, title: 'one', cwd: '/tmp',
        meta: { agent: 'claude', sessionId: 'abcdef12-0000-4000-8000-000000000001' } }];
      const out = { table: renderPanePanes(panes) };
      resolveHostPane({ request: async () => ({ panes }) }, '#1')
        .then((pane) => { out.resolved = pane.id; })
        .catch((error) => { out.error = error.message; })
        .then(() => process.stdout.write(JSON.stringify(out)));
    `;
    const env = { ...process.env, KEEP_DIR: dir, KEEP_NO_PUSH: '1' };
    for (const key of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID']) delete env[key];
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(fs.existsSync(path.join(dir, '.keep')), false, 'reading numbers must not create a registry');
    assert.ok(!out.table.includes('#'), `a registry-less machine labels no numbers: ${out.table}`);
    assert.match(out.error, /this machine has none/);
    assert.equal(out.resolved, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function overwrite(dir, value) {
  fs.writeFileSync(path.join(dir, '.keep', 'session-numbers.json'), JSON.stringify(value));
}

test('a registry replaced from outside is repaired from its backup before anything is labelled', () => {
  const dir = root();
  const fleet = ['a', 'b', 'c', 'd', 'e'].map((id, index) => ({ id, mtime: index + 1 }));
  numbers.assign(fleet, { root: dir });
  assert.deepEqual(fleet.map((session) => session.num), [1, 2, 3, 4, 5]);

  // What the tell test's fixture did to the live registry: a gap, and none of the fleet.
  overwrite(dir, { next: 9, ids: { 'known-session': 8 } });
  const scan = [...['a', 'b', 'c', 'd', 'e'].map((id, index) => ({ id, mtime: index + 1 })), { id: 'f', mtime: 99 }];
  numbers.assign(scan, { root: dir });
  assert.deepEqual(scan.map((session) => [session.id, session.num]),
    [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5], ['f', 9]], 'the fleet keeps its numbers; a newcomer goes past both');
  assert.equal(registry(dir).ids['known-session'], 8, 'a number the backup never held is kept');
  assert.equal(registry(dir).next, 10);
});

test('a session the damaged registry numbered over a restored one is numbered again', () => {
  const dir = root();
  numbers.assign([{ id: 'a', mtime: 1 }, { id: 'b', mtime: 2 }], { root: dir });
  overwrite(dir, { next: 2, ids: { stranger: 1 } });
  const scan = [{ id: 'a', mtime: 1 }, { id: 'b', mtime: 2 }, { id: 'stranger', mtime: 3 }];
  numbers.assign(scan, { root: dir });
  assert.deepEqual(scan.map((session) => session.num), [1, 2, 3]);
});

test('a read-only scan neither repairs nor records', () => {
  const dir = root();
  numbers.assign([{ id: 'a', mtime: 1 }, { id: 'b', mtime: 2 }], { root: dir });
  overwrite(dir, { next: 2, ids: { stranger: 1 } });
  const before = fs.readFileSync(path.join(dir, '.keep', 'session-numbers.json'), 'utf8');
  const scan = [{ id: 'a', mtime: 1 }, { id: 'stranger', mtime: 3 }];
  numbers.assign(scan, { root: dir, readOnly: true });
  assert.equal(fs.readFileSync(path.join(dir, '.keep', 'session-numbers.json'), 'utf8'), before);
  assert.deepEqual(scan.map((session) => session.num), [undefined, undefined], 'nothing is labelled from a damaged registry');
});

test('a damaged registry whose repair cannot take the lock labels nothing and allocates nothing', () => {
  const dir = root();
  numbers.assign([{ id: 'a', mtime: 1 }, { id: 'b', mtime: 2 }], { root: dir });
  overwrite(dir, { next: 2, ids: { stranger: 1 } });
  fs.writeFileSync(numbers.lockFile(dir), String(process.pid));
  try {
    const scan = [{ id: 'stranger', mtime: 3 }, { id: 'new', mtime: 4 }];
    numbers.assign(scan, { root: dir, lockRetries: 0 });
    assert.deepEqual(scan.map((session) => session.num), [undefined, undefined]);
    assert.deepEqual(registry(dir), { next: 2, ids: { stranger: 1 } });
  } finally { fs.unlinkSync(numbers.lockFile(dir)); }
});

test('a replacement that keeps the size but moves the numbers is caught, and lookups trust nothing until it is repaired', () => {
  const dir = root();
  numbers.assign([{ id: 'a', mtime: 1 }, { id: 'b', mtime: 2 }], { root: dir });
  overwrite(dir, { next: 3, ids: { a: 2, b: 1 } });
  assert.equal(numbers.lookup('#1', { root: dir }), null, 'a damaged registry resolves no number');
  assert.equal(numbers.lookup('a', { root: dir }), null);
  const scan = [{ id: 'a', mtime: 1 }, { id: 'b', mtime: 2 }];
  numbers.assign(scan, { root: dir });
  assert.deepEqual(scan.map((session) => session.num), [1, 2]);
  assert.deepEqual(numbers.lookup('#1', { root: dir }), { id: 'a', num: 1 });
});

test('a backup that contradicts the mirror is never used, however full', () => {
  const dir = root();
  numbers.assign([{ id: 'a', mtime: 1 }, { id: 'b', mtime: 2 }], { root: dir });
  const backups = path.join(dir, '.keep', 'session-numbers-backups');
  fs.writeFileSync(path.join(backups, '2030-01-01T00.json'), JSON.stringify({ next: 9, ids: { a: 2, b: 1, x: 3, y: 4 } }));
  overwrite(dir, { next: 1, ids: {} });
  const scan = [{ id: 'a', mtime: 1 }, { id: 'b', mtime: 2 }];
  numbers.assign(scan, { root: dir });
  assert.deepEqual(scan.map((session) => session.num), [1, 2]);
});

test('two sessions sharing a number is damage even when every mirrored number is kept', () => {
  const dir = root();
  numbers.assign([{ id: 'a', mtime: 1 }], { root: dir });
  overwrite(dir, { next: 2, ids: { a: 1, stranger: 1 } });
  assert.equal(numbers.lookup('#1', { root: dir }), null);
  const scan = [{ id: 'a', mtime: 1 }, { id: 'stranger', mtime: 2 }];
  numbers.assign(scan, { root: dir });
  assert.deepEqual(scan.map((session) => session.num), [1, 2]);
});

test('a mirror left behind by a crash after the registry write catches up on the next scan', () => {
  const dir = root();
  numbers.assign([{ id: 'a', mtime: 1 }], { root: dir });
  // The registry gained b, but the mirror write after it never happened.
  overwrite(dir, { next: 3, ids: { a: 1, b: 2 } });
  numbers.assign([{ id: 'a', mtime: 1 }, { id: 'b', mtime: 2 }], { root: dir });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.keep', 'session-numbers.last.json'), 'utf8')), { next: 3, ids: { a: 1, b: 2 } });
  // So losing b afterwards is caught.
  overwrite(dir, { next: 3, ids: { a: 1 } });
  const scan = [{ id: 'b', mtime: 2 }];
  numbers.assign(scan, { root: dir });
  assert.equal(scan[0].num, 2);
});

test('an outside write that only adds is not taken for a crash: next raised alone, or a number past next', () => {
  const dir = root();
  numbers.assign([{ id: 'a', mtime: 1 }], { root: dir });
  overwrite(dir, { next: 1000000, ids: { a: 1 } });
  const scan = [{ id: 'a', mtime: 1 }, { id: 'b', mtime: 2 }];
  numbers.assign(scan, { root: dir });
  assert.deepEqual(scan.map((session) => session.num), [1, 2], 'next is not taken from the damaged file');
  overwrite(dir, { next: 3, ids: { a: 1, b: 2, stray: 50 } });
  assert.equal(numbers.lookup('#50', { root: dir }), null, 'a number Keep never allocated resolves to nothing');
});

test('a mirror that is itself damaged is ignored and rewritten, not repaired from forever', () => {
  const dir = root();
  numbers.assign([{ id: 'a', mtime: 1 }, { id: 'b', mtime: 2 }], { root: dir });
  const mirror = path.join(dir, '.keep', 'session-numbers.last.json');
  fs.writeFileSync(mirror, JSON.stringify({ next: 3, ids: { a: 1, x: 1 } }));
  const scan = [{ id: 'a', mtime: 1 }, { id: 'b', mtime: 2 }];
  numbers.assign(scan, { root: dir });
  assert.deepEqual(scan.map((session) => session.num), [1, 2]);
  assert.deepEqual(JSON.parse(fs.readFileSync(mirror, 'utf8')), { next: 3, ids: { a: 1, b: 2 } });
});

test('numberFor stops trusting a cached registry when only the mirror changes', () => {
  const dir = root();
  numbers.assign([{ id: 'a', mtime: 1 }, { id: 'b', mtime: 2 }], { root: dir });
  assert.equal(numbers.numberFor('a', { root: dir }), 1);
  // The mirror now says a is 2: the unchanged registry contradicts it.
  const mirror = path.join(dir, '.keep', 'session-numbers.last.json');
  fs.writeFileSync(mirror, JSON.stringify({ next: 3, ids: { a: 2, b: 1 } }));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(mirror, later, later);
  assert.equal(numbers.numberFor('a', { root: dir }), null);
});

test('repair prefers the backup that holds the most sessions over one whose next ran ahead', () => {
  const dir = root();
  const fleet = ['a', 'b', 'c'].map((id, index) => ({ id, mtime: index + 1 }));
  numbers.assign(fleet, { root: dir, now: Date.parse('2026-01-01T00:00:00Z') });
  // A damaged copy with a higher next, snapshotted in a later hour.
  const backups = path.join(dir, '.keep', 'session-numbers-backups');
  fs.writeFileSync(path.join(backups, '2026-01-01T05.json'), JSON.stringify({ next: 50, ids: { stray: 49 } }));
  overwrite(dir, { next: 1, ids: {} });
  const scan = fleet.map(({ id, mtime }) => ({ id, mtime }));
  numbers.assign(scan, { root: dir });
  assert.deepEqual(scan.map((session) => session.num), [1, 2, 3]);
});

test('a registry older than its records starts them on the first scan', () => {
  const dir = root();
  fs.mkdirSync(path.join(dir, '.keep'), { recursive: true });
  overwrite(dir, { next: 42, ids: { old: 41 } });
  numbers.assign([{ id: 'old', mtime: 1 }], { root: dir });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.keep', 'session-numbers.last.json'), 'utf8')), { next: 42, ids: { old: 41 } });
  assert.equal(fs.readdirSync(path.join(dir, '.keep', 'session-numbers-backups')).length, 1);
  // And a later loss of that registry is caught against them.
  overwrite(dir, { next: 1, ids: {} });
  const scan = [{ id: 'old', mtime: 1 }];
  numbers.assign(scan, { root: dir });
  assert.equal(scan[0].num, 41);
});

test('backups are hourly and only the newest 48 are kept', () => {
  const dir = root();
  const start = Date.parse('2026-01-01T00:00:00Z');
  for (let hour = 0; hour < 50; hour += 1) {
    numbers.assign([{ id: `s${hour}`, mtime: hour + 1 }], { root: dir, now: start + hour * 3600e3 });
  }
  const kept = fs.readdirSync(path.join(dir, '.keep', 'session-numbers-backups')).sort();
  assert.equal(kept.length, 48);
  assert.equal(kept[0], '2026-01-01T02.json');
  assert.equal(kept.at(-1), '2026-01-03T01.json');
});
