'use strict';

for (const key of Object.keys(process.env)) {
  if (key.startsWith('KEEP_REVIEWER')) delete process.env[key];
}

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-health-test-'));
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  process.env.KEEP_DIR = root;
  delete require.cache[require.resolve('./health.js')];
  return { root, health: require('./health.js') };
}

test('record persists failures and a successful run resets the sequence', () => {
  const { root, health } = fixture();
  health.record('daemon', { at: 1000, pid: process.pid });
  health.record('review', { ok: false, error: 'x'.repeat(400), at: 2000 });
  let raw = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'health.json'), 'utf8'));
  assert.equal(raw.review.lastError.length, 300);
  health.record('review', { ok: false, error: new Error('again'), at: 3000 });
  raw = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'health.json'), 'utf8'));
  assert.equal(raw.review.consecutiveFailures, 2);
  assert.equal(raw.review.lastError.length, 5);
  assert.equal(raw.review.cadenceMs, 10 * 60e3);
  assert.equal(raw.review.runs, 2);

  health.record('review', { ok: true, detail: 'sent', at: 4000 });
  raw = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'health.json'), 'utf8'));
  assert.equal(raw.review.consecutiveFailures, 0);
  assert.equal(raw.review.lastOkAt, 4000);
  assert.equal(raw.review.lastErrorAt, 3000);
});

test('skipped polls preserve the failure sequence until a real success', () => {
  const { root, health } = fixture();
  health.record('review', { ok: false, error: 'same failure', at: 1000 });
  health.record('review', { ok: true, detail: 'nothing due', at: 2000 });
  health.record('review', { ok: true, skipped: true, detail: 'nothing due', at: 3000 });
  let raw = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'health.json'), 'utf8')).review;
  assert.equal(raw.lastRunAt, 3000);
  assert.equal(raw.lastErrorAt, 1000);
  assert.equal(raw.runs, 1, 'skips update only lastRunAt');
  health.record('review', { ok: false, error: 'same failure', at: 4000 });
  health.record('review', { ok: false, error: 'same failure', at: 5000 });
  raw = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'health.json'), 'utf8')).review;
  assert.equal(raw.lastRunAt, 5000);
  assert.equal(raw.lastOkAt, undefined);
  assert.equal(raw.consecutiveFailures, 3);
  assert.equal(health.snapshot(5000).schedulers.find((entry) => entry.name === 'review').state, 'failing');
});

test('an expected state clears the streak, marks the row, and any later record unmarks it', () => {
  const { root, health } = fixture();
  const stored = () => JSON.parse(fs.readFileSync(path.join(root, '.keep', 'health.json'), 'utf8')).discord;
  const row = (now) => health.snapshot(now).schedulers.find((entry) => entry.name === 'discord');
  // Three real failures on a row that self-repair and lint both watch.
  for (const at of [1000, 2000, 3000]) health.record('discord', { ok: false, error: 'reader gone', at });
  assert.equal(row(3000).state, 'failing');
  assert.equal(row(3000).expected, false);

  // A tick that decides the state is one its scheduler tolerates: the streak goes, the
  // history stays, the row is marked, and nothing reads as red.
  health.record('discord', { skipped: true, expected: true, detail: 'reader unavailable: tab closed', at: 4000 });
  assert.equal(stored().consecutiveFailures, 0);
  assert.equal(stored().expected, true);
  assert.equal(stored().lastErrorAt, 3000, 'the failure history is kept');
  assert.equal(stored().lastError, 'reader gone');
  assert.equal(row(4000).state, 'skipped');
  assert.equal(row(4000).displayState, 'skipped');
  assert.equal(row(4000).displayDetail, 'reader unavailable: tab closed');
  assert.equal(row(4000).expected, true);

  // Every other record drops the mark, so a real fault is visible again at once.
  for (const options of [
    { ok: false, error: 'classifier refused', at: 5000 },
    { ok: true, detail: '2 messages', at: 6000 },
    { skipped: true, detail: 'waiting for first poll', at: 7000 },
    { disabled: true, detail: 'not enabled', at: 8000 },
  ]) {
    health.record('discord', { skipped: true, expected: true, detail: 'reader unavailable: tab closed', at: options.at - 1 });
    assert.equal(stored().expected, true);
    health.record('discord', options);
    assert.equal(stored().expected, undefined, JSON.stringify(options));
    assert.equal(row(options.at).expected, false, JSON.stringify(options));
  }

  // And an ordinary skip still inherits the streak, which is what keeps a genuinely
  // failing account visible between real retries. A skip that holds the result keeps
  // the row reading as its failure; a plain one reads as recovered, streak and all.
  health.record('usage', { ok: false, error: 'Primary: credentials unavailable', at: 9000 });
  health.record('usage', { ok: true, skipped: true, holdResult: true, detail: 'waiting for failed account retry', at: 10000 });
  const inherited = health.snapshot(10000).schedulers.find((entry) => entry.name === 'usage');
  assert.equal(inherited.consecutiveFailures, 1);
  assert.equal(inherited.lastResult, 'failed');
  assert.equal(inherited.displayState, 'warning');
  assert.equal(inherited.expected, false);
  // A plain skip is clean, but inside the recent-failure window the fault still stands.
  health.record('usage', { ok: true, skipped: true, detail: 'nothing due', at: 11000 });
  let clean = health.snapshot(11000).schedulers.find((entry) => entry.name === 'usage');
  assert.equal(clean.consecutiveFailures, 1);
  assert.equal(clean.lastResult, 'skipped');
  assert.equal(clean.displayState, 'warning');
  assert.equal(clean.state, 'skipped');
  // Past it, the same row reads as recovered.
  clean = health.snapshot(9000 + 2 * 3600e3).schedulers.find((entry) => entry.name === 'usage');
  assert.equal(clean.state, 'recovered');

  // A holding skip after a success never names a success for itself.
  health.record('slack', { ok: true, at: 12000 });
  health.record('slack', { skipped: true, holdResult: true, at: 13000 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.keep', 'health.json'), 'utf8')).slack.lastResult, 'skipped');
});

test('a streak reads as failing while its fault stands: latest attempt failed or failure recent', () => {
  const { root, health } = fixture();
  const now = 30 * 3600e3;
  health.record('daemon', { at: now - 29 * 3600e3, pid: process.pid });
  const row = (at) => health.snapshot(at).schedulers.find((entry) => entry.name === 'unblock');
  for (const at of [now - 22 * 3600e3, now - 21.5 * 3600e3, now - 21 * 3600e3]) {
    health.record('unblock', { ok: false, error: 'unblock scan timed out', at });
  }
  assert.equal(row(now - 21 * 3600e3).state, 'failing');
  assert.equal(row(now - 21 * 3600e3).lastResult, 'failed');

  // Clean since: nothing due on every tick. The streak stays for a real ok to clear,
  // but the row is amber, says when it last failed and why, and leaves attention.
  health.record('unblock', { ok: true, detail: 'nothing due', at: now - 60e3 });
  let value = row(now);
  assert.equal(value.consecutiveFailures, 3);
  assert.equal(value.state, 'recovered');
  assert.equal(value.displayState, 'warning', 'older console JS colors warning amber');
  assert.equal(health.labelOf(value, now), 'recovered');
  assert.equal(value.displayDetail, 'last failed 21h ago (unblock scan timed out) · 3 failed attempts · latest check skipped 60s ago · awaiting a real run');
  assert.equal(health.attentionItems(health.snapshot(now), now).some((item) => item.id === 'health:unblock'), false);
  assert.doesNotMatch(health.reviewSection(health.snapshot(now), now), /unblock/);
  assert.match(health.render(health.snapshot(now), now), /unblock\s+recovered\s+60s ago\s+never\s+3\s+last failed 21h ago/);

  // Another failure is red again at once, and a real ok clears it outright.
  health.record('unblock', { ok: false, error: 'unblock scan timed out', at: now - 30e3 });
  value = row(now);
  assert.equal(value.consecutiveFailures, 4);
  assert.equal(value.state, 'failing');
  health.record('unblock', { ok: true, detail: 'unblocked 1', at: now });
  assert.deepEqual([row(now).state, row(now).consecutiveFailures, row(now).lastResult], ['ok', 0, 'ok']);

  // A skip that holds the result carries the failure forward: still failing.
  for (const at of [now + 1, now + 2, now + 3]) health.record('unblock', { ok: false, error: 'again', at });
  health.record('unblock', { skipped: true, holdResult: true, at: now + 4 });
  assert.equal(row(now + 4).state, 'failing');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.keep', 'health.json'), 'utf8')).unblock.lastRunAt, now + 4);
});

test('a scheduler that fails every real attempt with clean skips between stays failing', () => {
  const { health } = fixture();
  const now = 30 * 3600e3;
  health.record('daemon', { at: now - 29 * 3600e3, pid: process.pid });
  const row = (at) => health.snapshot(at).schedulers.find((entry) => entry.name === 'unblock');
  // Real work every 20 minutes, failing each time, "nothing due" every minute between.
  let at = now - 3 * 3600e3;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    health.record('unblock', { ok: false, error: 'scan timed out', at });
    for (let minute = 1; minute < 20; minute += 1) {
      health.record('unblock', { ok: true, detail: 'nothing due', at: at + minute * 60e3 });
      const value = row(at + minute * 60e3);
      // Under three it is the amber warning it always was; from three on, red.
      assert.deepEqual([value.state, value.displayState], attempt >= 2 ? ['failing', 'failing'] : ['skipped', 'warning'], `attempt ${attempt} minute ${minute}`);
    }
    at += 20 * 60e3;
  }
  // An hour (the floor, two cadences of a one-minute scheduler being less) after the
  // last failure with nothing but clean skips, it reads as recovered.
  const lastFailure = at - 20 * 60e3;
  health.record('unblock', { ok: true, detail: 'nothing due', at: lastFailure + 61 * 60e3 });
  assert.equal(row(lastFailure + 61 * 60e3).state, 'recovered');

  // The window is the longer of an hour and two cadences, capped at a day.
  assert.equal(health.recentFailureMs({ name: 'unblock' }), 3600e3);
  assert.equal(health.recentFailureMs({ name: 'landed' }), 3600e3);
  assert.equal(health.recentFailureMs({ name: 'review', cadenceMs: 120 * 60e3 }), 4 * 3600e3);
  assert.equal(health.recentFailureMs({ name: 'brief' }), 86400e3);
  // So a brief that gave up at noon is still failing the next morning before its run.
  const brief = { name: 'brief', consecutiveFailures: 9, lastErrorAt: now - 20 * 3600e3, lastRunAt: now - 60e3, lastResult: 'skipped', cadenceMs: 86400e3, daemonStartedAt: now - 3600e3 };
  assert.equal(health.stateOf(brief, now), 'failing');
  assert.equal(health.stateOf({ ...brief, lastErrorAt: now - 25 * 3600e3 }, now), 'recovered');
});

test('a recovered row still goes silent or never when its scheduler stops', () => {
  const { health } = fixture();
  const now = 100 * 3600e3;
  // A five-minute scheduler, streak 3, clean skip since, then 72 hours of nothing.
  const leftovers = { name: 'leftovers', cadenceMs: 5 * 60e3, consecutiveFailures: 3, lastError: 'x',
    lastErrorAt: now - 73 * 3600e3, lastRunAt: now - 72 * 3600e3, lastResult: 'skipped', daemonStartedAt: now - 80 * 3600e3 };
  assert.equal(health.stateOf(leftovers, now), 'silent');
  // Not run since this boot, past the grace.
  assert.equal(health.stateOf({ ...leftovers, daemonStartedAt: now - 3600e3 }, now), 'never');
  // Still ticking: recovered.
  assert.equal(health.stateOf({ ...leftovers, lastRunAt: now - 60e3 }, now), 'recovered');
});

test('rows written before lastResult existed are read from their timestamps', () => {
  const { health } = fixture();
  const now = 10 * 60e3;
  const base = { name: 'runs', cadenceMs: 60e3, daemonStartedAt: 1, consecutiveFailures: 3 };
  // The latest record was the failure: lastErrorAt = lastRunAt.
  const failed = { ...base, lastRunAt: now, lastErrorAt: now, lastOkAt: now - 5e3 };
  assert.equal(health.resultOf(failed), 'failed');
  assert.equal(health.stateOf(failed, now), 'failing');
  // A skip moved lastRunAt past it: failing while the failure is recent, then recovered.
  const skipped = { ...base, lastRunAt: now, lastErrorAt: now - 30e3, lastOkAt: now - 60e3 };
  assert.equal(health.resultOf(skipped), 'skipped');
  assert.equal(health.stateOf(skipped, now), 'failing');
  const later = now + 2 * 3600e3;
  assert.equal(health.stateOf({ ...skipped, lastRunAt: later }, later), 'recovered');
  assert.equal(health.presentationOf({ ...skipped, state: 'recovered' }, later).displayState, 'warning');
  // A success is the latest record.
  assert.equal(health.resultOf({ lastRunAt: now, lastOkAt: now, lastErrorAt: now - 1 }), 'ok');
  // Nothing recorded at all.
  assert.equal(health.resultOf({}), null);
  // A stored lastResult wins over the timestamps.
  assert.equal(health.resultOf({ ...skipped, lastResult: 'failed' }), 'failed');
});

test('snapshot and CLI presentation separate recovered errors from unresolved failures', () => {
  const { health } = fixture();
  const now = 20 * 3600e3;
  health.record('daemon', { at: now - 19 * 3600e3, pid: process.pid });

  health.record('digest', { ok: false, error: 'recovered <old> error', at: now - 15 * 3600e3 });
  health.record('digest', { ok: true, detail: 'generated digest', at: now - 14 * 3600e3 });
  let row = health.snapshot(now).schedulers.find((entry) => entry.name === 'digest');
  assert.equal(row.state, 'ok');
  assert.equal(row.displayState, 'ok');
  assert.equal(row.lastError, 'recovered <old> error', 'JSON retains error history');
  assert.equal(row.displayDetail, 'generated digest');
  assert.doesNotMatch(health.render({ daemon: { running: true, pid: 1, startedAt: now - 19 * 3600e3 }, schedulers: [row] }, now), /recovered <old> error/);

  health.record('review', { ok: false, error: 'timeout <unsafe>', at: now - 13 * 3600e3 });
  health.record('review', { skipped: true, at: now - 6 * 60e3 });
  row = health.snapshot(now).schedulers.find((entry) => entry.name === 'review');
  assert.equal(row.state, 'recovered', 'a clean skip long after the failure reads as recovered');
  assert.equal(row.displayState, 'warning');
  assert.match(row.displayDetail, /^last failed 13h ago \(timeout <unsafe>\) · 1 failed attempt · latest check skipped 6m ago · awaiting a real run$/);
  assert.equal(health.attentionItems(health.snapshot(now), now).some((item) => item.id === 'health:review'), false);
  assert.match(health.render({ daemon: { running: true, pid: 1, startedAt: now - 19 * 3600e3 }, schedulers: [row] }, now), /review\s+recovered\s+6m ago\s+never\s+1\s+last failed 13h ago/);

  health.record('review', { ok: false, error: 'timeout again', at: now - 5 * 60e3 });
  row = health.snapshot(now).schedulers.find((entry) => entry.name === 'review');
  assert.equal(row.displayState, 'warning');
  assert.match(row.displayDetail, /^2 failed attempts · last failed attempt 5m ago · timeout again$/);

  health.record('review', { ok: false, error: 'timeout final', at: now - 4 * 60e3 });
  row = health.snapshot(now).schedulers.find((entry) => entry.name === 'review');
  assert.equal(row.state, 'failing');
  assert.equal(row.displayState, 'failing');
  assert.match(row.displayDetail, /^3 failed attempts · last failed attempt 4m ago · timeout final$/);
  assert.equal(health.attentionItems(health.snapshot(now), now).some((item) => item.id === 'health:review'), true);

  const silent = health.presentationOf({ state: 'silent', consecutiveFailures: 1, lastErrorAt: now - 13 * 3600e3, lastError: 'old timeout' }, now);
  assert.equal(silent.displayState, 'silent', 'missing ticks retain their more severe state');
  assert.match(silent.displayDetail, /^1 failed attempt · last failed attempt 13h ago · old timeout$/);
});

test('normal skipped and disabled rows keep their current detail without historical errors', () => {
  const { health } = fixture();
  const now = 10 * 60e3;
  health.record('daemon', { at: 1, pid: process.pid });
  health.record('runs', { skipped: true, at: now });
  health.record('slack', { ok: false, error: 'old token error', at: now - 2 });
  health.record('slack', { disabled: true, detail: 'not configured' });
  const snapshot = health.snapshot(now);
  const skipped = snapshot.schedulers.find((entry) => entry.name === 'runs');
  const disabled = snapshot.schedulers.find((entry) => entry.name === 'slack');
  assert.deepEqual([skipped.state, skipped.displayState, skipped.displayDetail], ['skipped', 'skipped', '']);
  assert.deepEqual([disabled.state, disabled.displayState, disabled.displayDetail], ['disabled', 'disabled', 'not configured']);
  assert.equal(disabled.lastError, 'old token error');
});

test('a no-op wt gc success clears an earlier scheduler failure', () => {
  const { root, health } = fixture();
  try {
    health.record('wt-gc', { ok: false, error: 'inventory failed', at: 1000 });
    health.record('wt-gc', { ok: true, detail: '0 worktree(s) cleaned', at: 2000 });
    const row = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'health.json'), 'utf8'))['wt-gc'];
    assert.equal(row.consecutiveFailures, 0);
    assert.equal(row.lastOkAt, 2000);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stateOf distinguishes ok, failing, silent, never, skipped, and restart grace', () => {
  const { health } = fixture();
  const now = 10 * 60e3;
  assert.equal(health.stateOf({ name: 'runs', cadenceMs: 60e3, daemonStartedAt: 0, lastRunAt: now, lastOkAt: now }), 'ok');
  assert.equal(health.stateOf({ name: 'runs', cadenceMs: 60e3, daemonStartedAt: 1, lastRunAt: now, consecutiveFailures: 3 }, now), 'failing');
  assert.equal(health.stateOf({ name: 'runs', cadenceMs: 60e3, daemonStartedAt: 1, lastRunAt: now - 121e3, lastOkAt: now - 121e3 }, now), 'silent');
  assert.equal(health.stateOf({ name: 'runs', cadenceMs: 60e3, daemonStartedAt: now - 61e3 }, now), 'never');
  assert.equal(health.stateOf({ name: 'runs', cadenceMs: 60e3, daemonStartedAt: now - 30e3 }, now), 'ok');
  assert.equal(health.stateOf({ name: 'runs', cadenceMs: 60e3, daemonStartedAt: 1, lastRunAt: now, detail: 'nothing due' }, now), 'skipped');
});

test('daily schedulers use their expected window and retain fresh-restart grace', () => {
  const { health } = fixture();
  const day = (date, hour, minute = 0) => new Date(2026, 8, date, hour, minute).getTime();
  const lastRunAt = day(1, 7, 0);
  const startedAt = day(1, 6, 0);
  assert.equal(health.stateOf({ name: 'brief', cadenceMs: 86400e3, daemonStartedAt: startedAt, lastRunAt, lastOkAt: lastRunAt }, day(1, 9, 59)), 'ok');
  assert.equal(health.stateOf({ name: 'brief', cadenceMs: 86400e3, daemonStartedAt: startedAt, lastRunAt, lastOkAt: lastRunAt }, day(2, 10, 1)), 'silent');
  assert.equal(health.stateOf({ name: 'brief', cadenceMs: 86400e3, daemonStartedAt: day(2, 9, 30) }, day(2, 10, 1)), 'ok');
  const fridayNoon = day(4, 12);
  assert.equal(health.stateOf({ name: 'standup', cadenceMs: 86400e3, daemonStartedAt: fridayNoon }, day(5, 14)), 'ok');
  assert.equal(health.stateOf({ name: 'standup', cadenceMs: 86400e3, daemonStartedAt: fridayNoon }, day(7, 13, 31)), 'never');
});

test('on-demand schedulers never become silent or never from elapsed time', () => {
  const { health } = fixture();
  const now = 10 * 86400e3;
  assert.equal(health.CADENCES.usage.onDemand, true);
  assert.equal(health.CADENCES.digest.onDemand, true);
  assert.equal(health.stateOf({ name: 'usage', daemonStartedAt: 1 }, now), 'ok');
  assert.equal(health.stateOf({ name: 'digest', daemonStartedAt: 1, lastRunAt: 2, lastOkAt: 2 }, now), 'ok');
  assert.equal(health.stateOf({ name: 'usage', daemonStartedAt: 1, lastRunAt: 2, consecutiveFailures: 3 }, now), 'failing');
});

test('attentionItems has the stable health item shape and reports restart loops', () => {
  const { health } = fixture();
  const now = 10 * 3600e3;
  const value = {
    daemon: { startedAt: now - 3600e3, startedAts: [now - 50e3, now - 40e3, now - 30e3, now - 20e3] },
    schedulers: [{ name: 'review', state: 'failing', lastErrorAt: now - 10e3, lastError: 'delivery broke' }],
  };
  assert.deepEqual(health.attentionItems(value, now), [
    { id: 'health:review', text: 'review failing: delivery broke', kind: 'health', at: now - 10e3, lastError: 'delivery broke' },
    { id: 'health:daemon', text: 'daemon restarting: 4 starts in 1h', kind: 'health', at: now - 20e3, lastError: 'daemon restarting: 4 starts in 1h' },
  ]);
});

test('requested daemon restarts are not a restart loop; unrequested ones still are', () => {
  const { health } = fixture();
  const now = 10 * 3600e3;
  // Four deploys in an hour: each daemon asks for its restart before exiting.
  for (const at of [now - 50 * 60e3, now - 40 * 60e3, now - 30 * 60e3, now - 20 * 60e3]) {
    health.recordRestartRequest({ at: at - 5e3 });
    health.record('daemon', { at, pid: process.pid });
  }
  let value = health.snapshot(now);
  assert.equal(value.daemon.startedAts.length, 4);
  assert.deepEqual(health.attentionItems(value, now).filter((item) => item.id === 'health:daemon'), []);

  // A stale request does not cover a later crash, and crashes still count.
  health.recordRestartRequest({ at: now - 8 * 60e3 });
  for (const at of [now - 5 * 60e3, now - 4 * 60e3, now - 3 * 60e3, now - 2 * 60e3]) health.record('daemon', { at, pid: process.pid });
  value = health.snapshot(now);
  assert.deepEqual(health.unrequestedStarts(value.daemon, now - 3600e3), [now - 5 * 60e3, now - 4 * 60e3, now - 3 * 60e3, now - 2 * 60e3]);
  assert.match(health.attentionItems(value, now).find((item) => item.id === 'health:daemon').text, /4 starts in 1h/);

  // Many deploys after the crashes do not evict them from the history.
  for (let i = 0; i < 12; i++) {
    const at = now - 60e3 + i * 1e3;
    health.recordRestartRequest({ at: at - 500 });
    health.record('daemon', { at, pid: process.pid });
  }
  value = health.snapshot(now + 60e3);
  assert.equal(value.daemon.requestedStartAts.length, 10);
  assert.deepEqual(health.unrequestedStarts(value.daemon, now - 3600e3), [now - 5 * 60e3, now - 4 * 60e3, now - 3 * 60e3, now - 2 * 60e3]);
});

test('reviewSection is compact for all-ok and diagnostic for failures', () => {
  const { health } = fixture();
  const now = 4 * 3600e3;
  assert.equal(health.reviewSection({
    daemon: { startedAt: now - 3 * 3600e3 },
    schedulers: [{ name: 'runs', state: 'ok' }, { name: 'review', state: 'skipped' }],
  }, now), 'daemon health: all 2 schedulers ok (uptime 3h)');
  assert.match(health.reviewSection({
    daemon: { startedAt: now - 3 * 3600e3 },
    schedulers: [{ name: 'review', state: 'failing', lastError: 'host pane mismatch', lastOkAt: now - 2 * 3600e3 }],
  }, now), /^daemon health: review failing — host pane mismatch; last ok 2h ago$/);
  const section = health.reviewSection({
    daemon: { startedAt: now - 3 * 3600e3 },
    schedulers: Array.from({ length: 8 }, (_, index) => ({
      name: `scheduler-${index}`,
      state: 'failing',
      lastError: `line one\n${'x'.repeat(300)}`,
    })),
  }, now);
  assert.ok(section.length <= 600);
  assert.doesNotMatch(section, /line one\n/);
  assert.ok(section.split('\n')[0].length < 230, 'each error is clipped before the section cap');
});

test('brief text includes one daemon line when a scheduler is unhealthy', () => {
  const { health } = fixture();
  const value = require('./alerts.js').buildBrief({
    now: Date.now(),
    tasks: [],
    questions: [],
    alerts: [],
    findings: [],
    holds: [],
    steps: [],
    unblocked: [],
    health: {
      daemon: { startedAt: Date.now() - 3600e3 },
      schedulers: [{ name: 'auto-compact', state: 'failing', lastErrorAt: Date.now() - 60e3, lastError: 'host pane mismatch' }],
    },
  });
  assert.match(value.text, /Daemon: auto-compact failing since .+ \(host pane mismatch\)/);
  assert.equal(health.CADENCES['auto-compact'].cadenceMs, 30e3);
});

test('wrapTick records thrown ticks and remains callable', async () => {
  const { health } = fixture();
  health.record('daemon', { at: Date.now() - 10 * 60e3, pid: process.pid });
  let attempts = 0;
  const tick = health.wrapTick('runs', async () => {
    attempts += 1;
    throw new Error('boom');
  });
  await tick();
  await tick();
  await tick();
  const row = health.snapshot().schedulers.find((entry) => entry.name === 'runs');
  assert.equal(attempts, 3);
  assert.equal(row.state, 'failing');
  assert.equal(row.consecutiveFailures, 3);
});

test('keep health --json reads a temporary registry without the daemon', () => {
  const { root, health } = fixture();
  health.record('daemon', { at: Date.now() - 60e3, pid: 99999999 });
  health.record('runs', { ok: true, detail: 'nothing due' });
  const result = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'health', '--json'], {
    cwd: root,
    env: { ...process.env, KEEP_DIR: root },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.daemon.running, false);
  assert.equal(value.schedulers.find((entry) => entry.name === 'runs').state, 'skipped');
  const table = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'health'], {
    cwd: root,
    env: { ...process.env, KEEP_DIR: root },
    encoding: 'utf8',
  });
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /^daemon: down/m);
});


test('disabled integrations stay out of health attention and resume health tracking when enabled', () => {
  const { health } = fixture();
  health.record('daemon', { at: 1000, pid: process.pid });
  for (const name of ['slack', 'git-pull']) {
    health.record(name, { ok: false, error: 'old failure', at: 2000 });
    health.record(name, { disabled: true, detail: 'not configured' });
  }
  const later = 1000 + 2 * 86400e3;
  const snapshot = health.snapshot(later);
  for (const name of ['slack', 'git-pull']) {
    assert.equal(snapshot.schedulers.find((row) => row.name === name).state, 'disabled');
    assert.equal(health.attentionItems(snapshot, later).some((row) => row.id === `health:${name}`), false);
    health.record(name, { skipped: true, at: later });
    assert.equal(health.snapshot(later).schedulers.find((row) => row.name === name).disabled, false);
  }
});

test('a daemon start records the commit it loaded, and the status line shows it', () => {
  const { root, health } = fixture();
  const code = health.codeCommit();
  assert.match(code.commit, /^[0-9a-f]{40}$/);
  assert.equal(fs.realpathSync(code.checkout), fs.realpathSync(path.join(__dirname, '..')));
  health.record('daemon', { at: Date.now() - 60e3, pid: process.pid, ...code });
  const raw = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'health.json'), 'utf8'));
  assert.equal(raw.daemon.commit, code.commit);
  assert.match(health.render(health.snapshot()), new RegExp(`running \\(pid ${process.pid}, uptime \\S+, code ${code.commit.slice(0, 7)}\\)`));
  // A later start with no commit to report does not keep the stale one.
  health.record('daemon', { at: Date.now(), pid: process.pid });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.keep', 'health.json'), 'utf8')).daemon.commit, undefined);
  assert.deepEqual(health.codeCommit(root), { commit: '', checkout: '' });
});

test('a row healthy before a deploy that fails after it turns the deploy row failing, naming both commits', () => {
  const { root, health } = fixture();
  const old = '738b569' + '0'.repeat(33);
  const next = '7f8affa' + '1'.repeat(33);
  const read = () => JSON.parse(fs.readFileSync(path.join(root, '.keep', 'health.json'), 'utf8'));
  const start = 10 * 3600e3;
  health.record('daemon', { at: start - 3600e3, pid: process.pid, commit: old });
  health.record('review-compact', { ok: true, at: start - 60e3 });
  health.record('delivery', { ok: false, error: 'already broken', at: start - 60e3 });
  health.record('delivery', { ok: false, error: 'already broken', at: start - 30e3 });
  health.record('landed', { ok: true, at: start - 60e3 });
  health.record('daemon', { at: start, pid: process.pid, commit: next });
  const watch = read().daemon.deployWatch;
  assert.equal(watch.commit, next);
  assert.equal(watch.previousCommit, old);
  assert.ok(watch.healthy.includes('review-compact'));
  assert.equal(watch.healthy.includes('delivery'), false, 'a row failing before the deploy is not the deploy\'s fault');

  health.record('delivery', { ok: false, error: 'still broken', at: start + 60e3 });
  assert.equal(read().deploy, undefined, 'an already-failing row charges nothing to the deploy');

  for (let i = 1; i <= 3; i++) health.record('review-compact', { ok: false, error: 'boom', at: start + i * 60e3 });
  const row = health.snapshot(start + 4 * 60e3).schedulers.find((entry) => entry.name === 'deploy');
  assert.equal(row.state, 'failing');
  assert.equal(row.consecutiveFailures, 3);
  assert.match(row.lastError, /^review-compact started failing after deploy 7f8affa \(was 738b569\): boom/);
  assert.match(row.detail, /review-compact started failing after deploy 7f8affa \(was 738b569\)/);
  assert.ok(health.attentionItems(health.snapshot(start + 4 * 60e3), start + 4 * 60e3).some((item) => item.id === 'health:deploy'));

  // A crash-restart on the same commit keeps the watch the deploy armed.
  health.record('daemon', { at: start + 5 * 60e3, pid: process.pid, commit: next });
  assert.equal(read().daemon.deployWatch.startedAt, start);

  // A slow row still gets its first run counted past the half hour.
  health.record('landed', { ok: false, error: 'late', at: start + 40 * 60e3 });
  assert.match(read().deploy.lastError, /landed started failing/);

  // Recovery of every regression clears the row, and says what it was.
  health.record('review-compact', { ok: true, at: start + 41 * 60e3 });
  assert.equal(read().deploy.consecutiveFailures, 1, 'landed is still open');
  health.record('landed', { ok: true, at: start + 42 * 60e3 });
  const cleared = read().deploy;
  assert.equal(cleared.consecutiveFailures, 0);
  assert.equal(cleared.regressions, undefined);
  assert.match(cleared.detail, /landed started failing after deploy 7f8affa \(was 738b569\); recovered/);
  assert.equal(health.snapshot(start + 43 * 60e3).schedulers.find((entry) => entry.name === 'deploy').state, 'ok');
});

test('a failure outside the deploy watch, or after a start on the same commit, is not a deploy regression', () => {
  const { root, health } = fixture();
  const read = () => JSON.parse(fs.readFileSync(path.join(root, '.keep', 'health.json'), 'utf8'));
  const start = 10 * 3600e3;
  health.record('daemon', { at: start - 3600e3, pid: process.pid, commit: 'a'.repeat(40) });
  health.record('review-compact', { ok: true, at: start - 60e3 });
  health.record('daemon', { at: start, pid: process.pid, commit: 'a'.repeat(40) });
  assert.equal(read().daemon.deployWatch, undefined, 'a restart with nothing new is not a deploy');
  health.record('review-compact', { ok: false, error: 'boom', at: start + 60e3 });
  assert.equal(read().deploy, undefined);

  health.record('review-compact', { ok: true, at: start + 2 * 60e3 });
  health.record('loop-stalls', { ok: true, at: start + 2 * 60e3 });
  health.record('daemon', { at: start + 3600e3, pid: process.pid, commit: 'b'.repeat(40) });
  health.record('loop-stalls', { ok: false, error: 'event loop stalled 6s', at: start + 3600e3 + 10e3 });
  assert.equal(read().deploy, undefined, 'a startup stall is the restart, not the code');
  health.record('review-compact', { ok: false, error: 'boom', at: start + 3600e3 + 31 * 60e3 });
  assert.equal(read().deploy, undefined, 'a minute row failing after its 30m window is ordinary health');
});

test('a charged row that is disabled or removed does not hold the deploy row failing', () => {
  const { root, health } = fixture();
  const file = path.join(root, '.keep', 'health.json');
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const start = 10 * 3600e3;
  health.record('daemon', { at: start - 3600e3, pid: process.pid, commit: 'a'.repeat(40) });
  health.record('slack', { ok: true, at: start - 60e3 });
  health.record('notes', { ok: true, at: start - 60e3 });
  health.record('daemon', { at: start, pid: process.pid, commit: 'b'.repeat(40) });
  for (let i = 1; i <= 3; i++) health.record('slack', { ok: false, error: 'boom', at: start + i * 60e3 });
  assert.equal(read().deploy.consecutiveFailures, 3);
  health.record('slack', { disabled: true, detail: 'not configured', at: start + 5 * 60e3 });
  assert.equal(read().deploy.consecutiveFailures, 0, 'disabling the row clears its charge');

  for (let i = 6; i <= 8; i++) health.record('notes', { ok: false, error: 'boom', at: start + i * 60e3 });
  assert.equal(read().deploy.consecutiveFailures, 3);
  const raw = read();
  delete raw.notes;
  fs.writeFileSync(file, JSON.stringify(raw));
  health.record('review', { ok: true, at: start + 9 * 60e3 });
  const cleared = read().deploy;
  assert.equal(cleared.consecutiveFailures, 0, 'a row gone from the store is dropped on any record');
  assert.equal(cleared.regressions, undefined);
});

test('a start that could not read its commit does not hide the next deploy', () => {
  const { root, health } = fixture();
  const read = () => JSON.parse(fs.readFileSync(path.join(root, '.keep', 'health.json'), 'utf8'));
  const start = 10 * 3600e3;
  health.record('daemon', { at: start - 3 * 3600e3, pid: process.pid, commit: 'a'.repeat(40) });
  health.record('daemon', { at: start - 2 * 3600e3, pid: process.pid, commit: 'b'.repeat(40) });
  assert.equal(read().daemon.deployWatch.commit, 'b'.repeat(40));
  // git timed out under restart load: no commit on this start.
  health.record('daemon', { at: start - 60e3, pid: process.pid });
  assert.equal(read().daemon.lastKnownCommit, 'b'.repeat(40));
  health.record('review-compact', { ok: true, at: start - 30e3 });
  health.record('daemon', { at: start, pid: process.pid, commit: 'c'.repeat(40) });
  const watch = read().daemon.deployWatch;
  assert.equal(watch.commit, 'c'.repeat(40));
  assert.equal(watch.previousCommit, 'b'.repeat(40));
});

test('a deploy inside an earlier deploy\'s window keeps its base, and a row the deploy added is charged', () => {
  const { root, health } = fixture();
  const read = () => JSON.parse(fs.readFileSync(path.join(root, '.keep', 'health.json'), 'utf8'));
  const start = 10 * 3600e3;
  health.record('daemon', { at: start - 3600e3, pid: process.pid, commit: 'a'.repeat(40) });
  health.record('review-compact', { ok: true, at: start - 60e3 });
  health.record('daemon', { at: start, pid: process.pid, commit: 'b'.repeat(40) });
  health.record('daemon', { at: start + 10 * 60e3, pid: process.pid, commit: 'c'.repeat(40) });
  assert.equal(read().daemon.deployWatch.previousCommit, 'a'.repeat(40), 'the label covers a..c');
  assert.ok(read().daemon.deployWatch.rows.includes('review-compact'));

  // A scheduler that did not exist when the deploy started.
  health.record('brand-new', { ok: false, error: 'new tick threw', at: start + 11 * 60e3 });
  assert.match(read().deploy.lastError, /^brand-new \(new\) started failing after deploy ccccccc \(was aaaaaaa\): new tick threw/);
});

test('an added row keeps its charge across a crash restart and loses it once a revert stops it recording', () => {
  const { root, health } = fixture();
  const read = () => JSON.parse(fs.readFileSync(path.join(root, '.keep', 'health.json'), 'utf8'));
  const start = 10 * 3600e3;
  health.record('daemon', { at: start - 3600e3, pid: process.pid, commit: 'a'.repeat(40) });
  health.record('review-compact', { ok: true, at: start - 60e3 });
  health.record('daemon', { at: start, pid: process.pid, commit: 'b'.repeat(40) });
  // A scheduler the deploy added that writes its own row (no CADENCES entry), and a known one.
  for (let i = 1; i <= 3; i++) health.record('brand-new', { ok: false, error: 'boom', cadenceMs: 60e3, at: start + i * 60e3 });
  health.record('review-compact', { ok: false, error: 'boom', at: start + 4 * 60e3 });
  assert.equal(read().deploy.consecutiveFailures, 3);

  // A crash restart on the same commit: the row is still in the code and still failing.
  health.record('daemon', { at: start + 10 * 60e3, pid: process.pid, commit: 'b'.repeat(40) });
  health.record('brand-new', { ok: false, error: 'boom', cadenceMs: 60e3, at: start + 11 * 60e3 });
  health.record('review-compact', { ok: false, error: 'boom', at: start + 50 * 60e3 });
  assert.deepEqual(Object.keys(read().deploy.regressions).sort(), ['brand-new', 'review-compact'], 'a live added row keeps its charge');
  assert.equal(read().deploy.consecutiveFailures, 4);

  // The printed revert went out: the row never records again.
  health.record('daemon', { at: start + 60 * 60e3, pid: process.pid, commit: 'c'.repeat(40) });
  health.record('review-compact', { ok: false, error: 'boom', at: start + 70 * 60e3 });
  assert.ok(read().deploy.regressions['brand-new'], 'not inside the window after the start');
  health.record('review-compact', { ok: false, error: 'boom', at: start + 91 * 60e3 });
  const row = read().deploy;
  assert.deepEqual(Object.keys(row.regressions), ['review-compact'], 'the reverted scheduler\'s charge is dropped');
  health.record('review-compact', { ok: true, at: start + 92 * 60e3 });
  assert.equal(read().deploy.consecutiveFailures, 0);
});

test('a malformed deploy row never costs the scheduler its own record', () => {
  const { root, health } = fixture();
  const file = path.join(root, '.keep', 'health.json');
  const start = 10 * 3600e3;
  health.record('daemon', { at: start, pid: process.pid, commit: 'a'.repeat(40) });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.daemon.deployWatch = { startedAt: start, healthy: ['review'], rows: null, commit: 'a', previousCommit: 'b' };
  raw.deploy = { regressions: { review: null } };
  fs.writeFileSync(file, JSON.stringify(raw));
  health.record('review', { ok: false, error: 'boom', at: start + 60e3 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).review.consecutiveFailures, 1);
});
