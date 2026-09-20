'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const deferrals = require('./check-deferrals.js');

const DAY = 24 * 3600e3;
// keep.nowStamp() is local time, and check-deferrals parses it as local time; a UTC
// stamp here would shift every age by the machine's offset.
const stampAt = (ms) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

test('a deferral streak counts days, not ticks', () => {
  const map = new Map();
  const base = Date.parse('2026-09-16T18:17:00Z');
  for (let n = 0; n < 40; n += 1) {
    deferrals.note(map, 'a-card', { checkAfter: '2026-09-16T09:00', stamp: stampAt(base), today: '2026-09-16' });
  }
  assert.equal(map.get('a-card').notices, 1, 'a tick every minute is still one deferred day');
  deferrals.note(map, 'a-card', { checkAfter: '2026-09-16T09:00', stamp: stampAt(base + DAY), today: '2026-09-17' });
  assert.equal(map.get('a-card').notices, 2);
  assert.equal(map.get('a-card').since, stampAt(base), 'the streak keeps its first deferral');
});

test('rescheduling the card starts a new streak', () => {
  const map = new Map();
  const base = Date.parse('2026-09-16T18:17:00Z');
  deferrals.note(map, 'a-card', { checkAfter: '2026-09-16T09:00', stamp: stampAt(base), today: '2026-09-16' });
  deferrals.note(map, 'a-card', { checkAfter: '2026-09-16T09:00', stamp: stampAt(base), today: '2026-09-17' });
  assert.equal(deferrals.escalationDue(map.get('a-card'), base + DAY), true);
  const { entry: moved } = deferrals.note(map, 'a-card', { checkAfter: '2026-09-20T09:00', stamp: stampAt(base + 2 * DAY), today: '2026-09-18' });
  assert.equal(moved.notices, 1);
  assert.equal(deferrals.escalationDue(moved, base + 2 * DAY), false, 'a fresh schedule is not already stalled');
});

test('escalation is due on the second day or after a full day, and only once', () => {
  const base = Date.parse('2026-09-16T18:17:00Z');
  const map = new Map();
  const { entry: first, changed } = deferrals.note(map, 'a-card', { checkAfter: 'x', stamp: stampAt(base), today: '2026-09-16' });
  assert.equal(changed, true, 'a new streak is worth persisting');
  assert.equal(deferrals.note(map, 'a-card', { checkAfter: 'x', stamp: stampAt(base), today: '2026-09-16' }).changed, false,
    'the same day again is not: a tick a minute must not be a disk write a minute');
  assert.equal(deferrals.escalationDue(first, base + 3600e3), false, 'one evening of deferral is just a deferral');
  assert.equal(deferrals.escalationDue(first, base + DAY), true, 'a full day of deferral is not');

  const second = new Map();
  deferrals.note(second, 'b-card', { checkAfter: 'x', stamp: stampAt(base), today: '2026-09-16' });
  const { entry: twice } = deferrals.note(second, 'b-card', { checkAfter: 'x', stamp: stampAt(base), today: '2026-09-17' });
  assert.equal(deferrals.escalationDue(twice, base + 6 * 3600e3), true, 'a second deferred day counts on its own');

  deferrals.markEscalated(second, 'b-card');
  assert.equal(deferrals.escalationDue(second.get('b-card'), base + 5 * DAY), false, 'escalation does not repeat daily');
});

test('serializing prunes stale streaks and survives a round trip', () => {
  const base = Date.parse('2026-09-16T18:17:00Z');
  const map = new Map();
  deferrals.note(map, 'fresh', { checkAfter: 'x', stamp: stampAt(base), today: '2026-09-16' });
  deferrals.note(map, 'ancient', { checkAfter: 'x', stamp: stampAt(base - 30 * DAY), today: '2026-08-17' });
  const payload = deferrals.serialize(map, base);
  assert.deepEqual(Object.keys(payload), ['fresh']);
  assert.equal(map.has('ancient'), false, 'the pruned entry leaves the live map too');
  const back = deferrals.parse(JSON.parse(JSON.stringify(payload)));
  assert.equal(back.get('fresh').notices, 1);
});

test('a malformed state file reads as no deferrals rather than throwing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-deferrals-'));
  try {
    assert.equal(deferrals.read(root).size, 0, 'missing file');
    fs.mkdirSync(path.join(root, '.keep', 'runs'), { recursive: true });
    fs.writeFileSync(deferrals.stateFile(root), '{ "deferred": { "a": {"since": 4}, "b": null }, ');
    assert.equal(deferrals.read(root).size, 0, 'half-written file');
    fs.writeFileSync(deferrals.stateFile(root), JSON.stringify({
      deferred: { good: { since: '2026-09-16 18:17', checkAfter: 'x', notices: 2 }, bad: { since: 'not a date' } },
    }));
    const read = deferrals.read(root);
    assert.deepEqual([...read.keys()], ['good']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the overdue annotation names the streak and only for the current schedule', () => {
  const base = Date.parse('2026-09-16T18:17:00Z');
  const map = new Map();
  deferrals.note(map, 'a-card', { checkAfter: '2026-09-16T09:00', stamp: stampAt(base), today: '2026-09-16' });
  const entry = map.get('a-card');
  assert.equal(deferrals.describe(entry, '2026-09-16T09:00', base + 3 * 3600e3),
    ' — check deferred on the account budget for 3h');
  assert.equal(deferrals.describe(entry, '2026-09-16T09:00', base + 2 * DAY),
    ' — check deferred on the account budget for 2d');
  assert.equal(deferrals.describe(entry, '2026-09-20T09:00', base + 3 * 3600e3), '',
    'a rescheduled card is not described by an old streak');
  assert.equal(deferrals.describe(null, 'x', base), '');
  deferrals.markEscalated(map, 'a-card');
  assert.match(deferrals.describe(map.get('a-card'), '2026-09-16T09:00', base + 2 * DAY), /stalled on the account budget for 2d \(escalated\)/);
});

// ---------- what keep overdue shows ----------

const { spawnSync } = require('node:child_process');
const CLI = path.join(__dirname, 'keep.js');

function registry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-overdue-'));
  const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1', KEEP_NO_COMMIT: '1' };
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  const write = (id, checkAfter) => fs.writeFileSync(path.join(root, 'tasks', `${id}.md`), [
    '---', `title: ${id}`, 'status: waiting', 'kind: task', 'tags: [personal]',
    `check_after: ${checkAfter}`, 'check: |', '  Read the ramp dashboard.',
    'created: 2026-09-01', 'updated: 2026-09-01T09:00', '---', '', 'Context.', '',
  ].join('\n'));
  write('stalled-card', '2026-09-16T09:00');
  write('quiet-card', '2026-09-16T09:00');
  return { root, env, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('keep overdue says which checks are stalled on an account budget', () => {
  const { root, env, cleanup } = registry();
  try {
    fs.mkdirSync(path.join(root, '.keep', 'runs'), { recursive: true });
    fs.writeFileSync(deferrals.stateFile(root), JSON.stringify({
      opened: {}, budgetNotice: {}, reopened: {},
      deferred: {
        'stalled-card': { checkAfter: '2026-09-16T09:00', since: stampAt(Date.now() - 2 * DAY), notices: 2, escalated: true },
        // A streak recorded against a schedule the card has since moved past.
        'quiet-card': { checkAfter: '2026-08-01T09:00', since: stampAt(Date.now() - 2 * DAY), notices: 2, escalated: true },
      },
    }));
    const run = spawnSync(process.execPath, [CLI, 'overdue', '--brief'], { encoding: 'utf8', env, cwd: root });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines.find((line) => line.includes('stalled-card')), /check stalled on the account budget for 2d \(escalated\)/);
    assert.doesNotMatch(lines.find((line) => line.includes('quiet-card')), /account budget/);
  } finally { cleanup(); }
});

test('keep overdue is unchanged when the daemon has recorded no deferrals', () => {
  const { root, env, cleanup } = registry();
  try {
    const run = spawnSync(process.execPath, [CLI, 'overdue', '--brief'], { encoding: 'utf8', env, cwd: root });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /account budget/);
    assert.match(run.stdout, /stalled-card.*\(has check recipe\)$/m);
  } finally { cleanup(); }
});

test('an actively deferring streak is never pruned out from under its own escalation', () => {
  const base = Date.parse('2026-09-16T18:17:00Z');
  const map = new Map();
  // Deferred every day for three weeks: the case this module exists for.
  for (let day = 0; day < 21; day += 1) {
    const at = base + day * DAY;
    deferrals.note(map, 'a-card', { checkAfter: 'x', stamp: stampAt(at), today: stampAt(at).slice(0, 10) });
    deferrals.serialize(map, at);
  }
  deferrals.markEscalated(map, 'a-card');
  const entry = map.get('a-card');
  assert.ok(entry, 'expiring it would restart the streak and walk the card through the same notices again');
  assert.equal(entry.escalated, true);
  assert.equal(entry.notices, 21);

  // A streak that actually stopped is history and does age out.
  deferrals.serialize(map, base + 60 * DAY);
  assert.equal(map.has('a-card'), false);
});

test('a lastDay Keep cannot use is repaired, never trusted and never ignored', () => {
  const base = Date.parse('2026-09-16T18:17:00Z');
  const RETENTION = 14 * DAY;
  // Ignoring a bad value handed retention back to `since`, which pruned streaks that
  // were still deferring daily. Trusting one let a dead streak claim to be from 9999 and
  // live forever. Repairing it to today does neither: the entry survives this save and
  // ages out a retention window later, and an active streak overwrites it on its next
  // deferral anyway.
  for (const lastDay of ['9999-12-31', 'yesterday']) {
    const map = deferrals.parse({ entry: { since: stampAt(base - 30 * DAY), lastDay, checkAfter: 'x' } });
    deferrals.serialize(map, base, deferrals.dayOf(base));
    assert.equal(map.has('entry'), true, `${lastDay}: kept for now`);
    assert.equal(map.get('entry').lastDay, deferrals.dayOf(base), `${lastDay}: repaired to today`);
    deferrals.serialize(map, base + RETENTION + DAY);
    assert.equal(map.has('entry'), false, `${lastDay}: and retired a retention window later`);
  }

  // A streak claiming to have started in the future is not a streak, and nothing could
  // ever age it out.
  const ahead = deferrals.parse({ ahead: { since: stampAt(base + 400 * DAY), lastDay: '', checkAfter: 'x' } });
  deferrals.serialize(ahead, base);
  assert.equal(ahead.has('ahead'), false);

  // And a streak still deferring daily keeps its repaired value current.
  const live = deferrals.parse({ live: { since: stampAt(base - 30 * DAY), lastDay: 'nonsense', checkAfter: 'x' } });
  deferrals.serialize(live, base, deferrals.dayOf(base));
  deferrals.note(live, 'live', { checkAfter: 'x', stamp: stampAt(base + DAY), today: deferrals.dayOf(base + DAY) });
  deferrals.serialize(live, base + DAY);
  assert.equal(live.get('live').lastDay, deferrals.dayOf(base + DAY));
  assert.equal(live.get('live').notices, 1, 'and the repair did not cost it a deferred day');
});

test('fallback attempts are counted on the streak so a restart does not reset them', () => {
  const base = Date.parse('2026-09-16T18:17:00Z');
  const map = new Map();
  assert.equal(deferrals.countAttempt(map, 'missing'), 0, 'no streak, nothing to count');
  deferrals.note(map, 'a-card', { checkAfter: 'x', stamp: stampAt(base), today: '2026-09-16' });
  assert.equal(deferrals.countAttempt(map, 'a-card'), 1);
  assert.equal(deferrals.countAttempt(map, 'a-card'), 2);
  const back = deferrals.parse(JSON.parse(JSON.stringify(deferrals.serialize(map, base))));
  assert.equal(back.get('a-card').tries, 2);
});

test('an empty lastDay is repaired like a damaged one, not read as never active', () => {
  const base = Date.parse('2026-09-16T18:17:00Z');
  // null, a number or a missing field all parse to '', and falling back to `since` for
  // those is the same way an actively deferring streak got pruned.
  for (const lastDay of [null, 7, undefined]) {
    const map = deferrals.parse({ live: { since: stampAt(base - 30 * DAY), lastDay, checkAfter: 'x' } });
    deferrals.serialize(map, base, deferrals.dayOf(base));
    assert.equal(map.has('live'), true, String(lastDay));
    assert.equal(map.get('live').lastDay, deferrals.dayOf(base));
  }
});

test('a counter that refuses to be a number does not wedge the scheduler', () => {
  const hostile = { toString: 0, valueOf: 0 };
  // This parser runs inside the daemon's scheduler-state load, and every caller of that
  // is inside a tick: a throw here took the tick, and the next one, and the one after.
  const map = deferrals.parse({ live: { since: '2026-09-16 18:17', checkAfter: 'x', notices: hostile, tries: hostile } });
  assert.equal(map.get('live').notices, 0);
  assert.equal(map.get('live').tries, undefined);
});
