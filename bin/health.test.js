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
  assert.equal(health.CADENCES['auto-compact'].cadenceMs, 2 * 60e3);
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
