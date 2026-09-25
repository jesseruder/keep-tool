const test = require('node:test');
const assert = require('node:assert/strict');
const health = require('./footer-health');

const idle = { recognized: true, shells: 0, agents: 0, turnRunning: false, running: false };
const t0 = 1_000_000_000;

test('a footer that agrees with the process table and ledger stays trusted', () => {
  const tracker = health.createTracker();
  const shell = { ...idle, shells: 1, running: true };
  const status = health.observe(tracker, [{ pane: 'p1', footer: shell, agentShells: 1 }, { pane: 'p2', footer: idle, agentShells: 0 }], t0);
  assert.equal(status.trusted, true);
  assert.deepEqual(status.problems, []);
});

test('a background shell the footer does not show breaks trust only once it persists', () => {
  const tracker = health.createTracker();
  const obs = [{ pane: 'p1', footer: idle, agentShells: 1 }];
  assert.equal(health.observe(tracker, obs, t0).trusted, true, 'a transient mismatch is not a break');
  assert.equal(health.observe(tracker, obs, t0 + health.PERSIST_MS - 1).trusted, true);
  const broken = health.observe(tracker, obs, t0 + health.PERSIST_MS);
  assert.equal(broken.trusted, false);
  assert.match(broken.problems[0], /pane p1: 1 background shell process\(es\), the footer shows none/);
  // It stays untrusted until the fleet agrees for RECOVER_MS.
  const agree = [{ pane: 'p1', footer: idle, agentShells: 0 }];
  const t1 = t0 + health.PERSIST_MS + 1000;
  assert.equal(health.observe(tracker, agree, t1).trusted, false);
  assert.equal(health.observe(tracker, agree, t1 + health.RECOVER_MS - 1).trusted, false);
  assert.equal(health.observe(tracker, agree, t1 + health.RECOVER_MS).trusted, true);
});

test('a mismatch that clears before it persists never counts', () => {
  const tracker = health.createTracker();
  health.observe(tracker, [{ pane: 'p1', footer: idle, agentShells: 1 }], t0);
  health.observe(tracker, [{ pane: 'p1', footer: idle, agentShells: 0 }], t0 + 30e3);
  assert.equal(health.observe(tracker, [{ pane: 'p1', footer: idle, agentShells: 1 }], t0 + health.PERSIST_MS + 1).trusted, true);
});

test('a running agent the ledger is sure of must show in the footer', () => {
  const now = t0 + 10 * 60e3;
  const ledger = (startedAt, status = 'pending', caughtUp = true) => ({ caughtUp, jobs: [{ id: 'a1', kind: 'agent', status, startedAt }] });
  assert.equal(health.ledgerAgents(ledger(now - 5 * 60e3), now), 1);
  assert.equal(health.ledgerAgents(ledger(now - 30e3), now), 0, 'just launched: the footer may not show it yet');
  assert.equal(health.ledgerAgents(ledger(now - 2 * 3600e3), now), 0, 'a long-stale entry proves nothing');
  assert.equal(health.ledgerAgents(ledger(now - 5 * 60e3, 'completed'), now), 0);
  assert.equal(health.ledgerAgents(ledger(now - 5 * 60e3, 'pending', false), now), 0, 'a ledger still catching up proves nothing');
  const tracker = health.createTracker();
  const obs = [{ pane: 'p1', footer: idle, agentShells: 0, ledger: ledger(now - 5 * 60e3) }];
  health.observe(tracker, obs, now);
  const status = health.observe(tracker, obs, now + health.PERSIST_MS);
  assert.equal(status.trusted, false);
  assert.match(status.problems[0], /the ledger has 1 running agent\(s\), the footer shows none/);
});

test('one unrecognized pane is a dialog; most of the fleet unrecognized is a format change', () => {
  const lost = { recognized: false, shells: null, agents: null, running: null };
  const tracker = health.createTracker();
  const one = [{ pane: 'p1', footer: lost }, { pane: 'p2', footer: idle }, { pane: 'p3', footer: idle }];
  health.observe(tracker, one, t0);
  assert.equal(health.observe(tracker, one, t0 + health.PERSIST_MS).trusted, true);
  const most = [{ pane: 'p1', footer: lost }, { pane: 'p2', footer: lost }, { pane: 'p3', footer: idle }];
  health.observe(tracker, most, t0 + health.PERSIST_MS + 1);
  const status = health.observe(tracker, most, t0 + 2 * health.PERSIST_MS + 1);
  assert.equal(status.trusted, false);
  assert.match(status.problems[0], /2 of 3 Claude panes show no recognizable footer/);
});

test('a pane mid-turn or with its agent gone is not checked', () => {
  const tracker = health.createTracker();
  const obs = [{ pane: 'p1', footer: { ...idle, turnRunning: true }, agentShells: 2 }, { pane: 'p2', footer: idle, agentShells: 1, agentAlive: false }];
  health.observe(tracker, obs, t0);
  assert.equal(health.observe(tracker, obs, t0 + health.PERSIST_MS).trusted, true);
});

test('the health row is written only when trust changes, with the problems that broke it', () => {
  const rows = [];
  const store = { record: (name, row) => { rows.push({ name, ...row }); return row; } };
  const memo = {};
  health.record({ trusted: true, problems: [] }, store, memo);
  assert.equal(rows.length, 0, 'the first healthy build writes nothing');
  health.record({ trusted: false, problems: ['pane p1: 1 background shell process(es), the footer shows none'] }, store, memo);
  health.record({ trusted: false, problems: [] }, store, memo);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'claude-footer');
  assert.equal(rows[0].ok, false);
  assert.match(rows[0].error, /stopped using it for status\. pane p1/);
  health.record({ trusted: true, problems: [] }, store, memo);
  assert.deepEqual(rows.at(-1), { name: 'claude-footer', ok: true });
});
