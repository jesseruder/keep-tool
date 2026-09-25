const test = require('node:test');
const assert = require('node:assert/strict');
const health = require('./footer-health');

const idle = { recognized: true, shells: 0, agents: 0, turnRunning: false, running: false };
const t0 = 1_000_000_000;
const P = health.PERSIST_MS;

// A tracker that has already watched the fleet agree for a full PERSIST_MS.
function warmed() {
  const tracker = health.createTracker();
  health.observe(tracker, [], t0 - P);
  return tracker;
}

test('a new tracker trusts nothing until it has watched for PERSIST_MS', () => {
  const tracker = health.createTracker();
  assert.equal(health.observe(tracker, [{ pane: 'p1', footer: idle, agentShells: 0 }], t0).trusted, false);
  assert.equal(health.observe(tracker, [{ pane: 'p1', footer: idle, agentShells: 0 }], t0 + P - 1).trusted, false);
  assert.equal(health.observe(tracker, [{ pane: 'p1', footer: idle, agentShells: 0 }], t0 + P).trusted, true);
});

test('a footer that agrees with the process table and ledger stays trusted', () => {
  const tracker = warmed();
  const shell = { ...idle, shells: 1, running: true };
  const status = health.observe(tracker, [{ pane: 'p1', footer: shell, agentShells: 1 }, { pane: 'p2', footer: idle, agentShells: 0 }], t0);
  assert.equal(status.trusted, true);
  assert.deepEqual(status.problems, []);
});

test('a background shell the footer does not show breaks trust once it persists, and recovers after RECOVER_MS', () => {
  const tracker = warmed();
  const obs = [{ pane: 'p1', footer: idle, agentShells: 1 }];
  assert.equal(health.observe(tracker, obs, t0).trusted, true, 'a transient mismatch is not a break');
  assert.equal(health.observe(tracker, obs, t0 + P - 1).trusted, true);
  const broken = health.observe(tracker, obs, t0 + P);
  assert.equal(broken.trusted, false);
  assert.match(broken.problems[0], /pane p1: 1 background shell process\(es\), the footer shows none/);
  const agree = [{ pane: 'p1', footer: idle, agentShells: 0 }];
  const t1 = t0 + P + 1000;
  assert.equal(health.observe(tracker, agree, t1).trusted, false);
  assert.equal(health.observe(tracker, agree, t1 + health.RECOVER_MS - 1).trusted, false);
  assert.equal(health.observe(tracker, agree, t1 + health.RECOVER_MS).trusted, true);
});

test('a mismatch that clears before it persists never counts', () => {
  const tracker = warmed();
  health.observe(tracker, [{ pane: 'p1', footer: idle, agentShells: 1 }], t0);
  health.observe(tracker, [{ pane: 'p1', footer: idle, agentShells: 0 }], t0 + 30e3);
  assert.equal(health.observe(tracker, [{ pane: 'p1', footer: idle, agentShells: 1 }], t0 + P + 1).trusted, true);
});

test('a running agent the ledger is sure of must show in the footer: one pane distrusts that pane, two break the fleet', () => {
  const now = t0 + 10 * 60e3;
  const ledger = (startedAt, status = 'pending', caughtUp = true) => ({ caughtUp, jobs: [{ id: 'a1', kind: 'agent', status, startedAt }] });
  assert.equal(health.ledgerAgents(ledger(now - 5 * 60e3), now), 1);
  assert.equal(health.ledgerAgents(ledger(now - 30e3), now), 0, 'just launched: the footer may not show it yet');
  assert.equal(health.ledgerAgents(ledger(now - 2 * 3600e3), now), 0, 'a long-stale entry proves nothing');
  assert.equal(health.ledgerAgents(ledger(now - 5 * 60e3, 'completed'), now), 0);
  assert.equal(health.ledgerAgents(ledger(now - 5 * 60e3, 'pending', false), now), 0, 'a ledger still catching up proves nothing');
  const tracker = health.createTracker();
  health.observe(tracker, [], now - P);
  const one = [{ pane: 'p1', footer: idle, agentShells: 0, ledger: ledger(now - 5 * 60e3) }, { pane: 'p2', footer: idle, agentShells: 0 }];
  health.observe(tracker, one, now);
  const status = health.observe(tracker, one, now + P);
  assert.equal(status.trusted, true, 'one stale ledger entry is not a format change');
  assert.deepEqual(status.untrustedPanes, ['p1']);
  const two = [{ pane: 'p1', footer: idle, agentShells: 0, ledger: ledger(now - 5 * 60e3) }, { pane: 'p2', footer: idle, agentShells: 0, ledger: ledger(now - 5 * 60e3) }];
  health.observe(tracker, two, now + P + 1);
  const broken = health.observe(tracker, two, now + 2 * P + 1);
  assert.equal(broken.trusted, false);
  assert.equal(broken.problems.length, 2);
});

test('one unrecognized pane is a dialog; most of the fleet unrecognized is a format change', () => {
  const lost = { recognized: false, shells: null, agents: null, running: null };
  const tracker = warmed();
  const one = [{ pane: 'p1', footer: lost }, { pane: 'p2', footer: idle }, { pane: 'p3', footer: idle }];
  health.observe(tracker, one, t0);
  assert.equal(health.observe(tracker, one, t0 + P).trusted, true);
  const most = [{ pane: 'p1', footer: lost }, { pane: 'p2', footer: lost }, { pane: 'p3', footer: idle }];
  health.observe(tracker, most, t0 + P + 1);
  const status = health.observe(tracker, most, t0 + 2 * P + 1);
  assert.equal(status.trusted, false);
  assert.match(status.problems[0], /2 of 3 Claude panes show no recognizable footer/);
});

test('a pane mid-turn by screen or transcript, or with its agent gone, is not checked', () => {
  const tracker = warmed();
  const obs = [{ pane: 'p1', footer: { ...idle, turnRunning: true }, agentShells: 2 },
    { pane: 'p2', footer: idle, agentShells: 1, endedTurn: false },
    { pane: 'p3', footer: idle, agentShells: 1, agentAlive: false }];
  health.observe(tracker, obs, t0);
  assert.equal(health.observe(tracker, obs, t0 + P).trusted, true);
});

test('peek reads the last verdict without advancing the check', () => {
  const tracker = warmed();
  const obs = [{ pane: 'p1', footer: idle, agentShells: 1 }];
  health.observe(tracker, obs, t0);
  health.observe(tracker, obs, t0 + P);
  assert.equal(health.peek(tracker, t0 + P + 5).trusted, false);
  assert.equal(tracker.since.size, 1, 'peek neither clears nor starts a timer');
  assert.equal(health.peek(health.createTracker(), t0).trusted, false, 'a tracker that never observed trusts nothing');
});

test('the health row is written on the first result and on each change, never while warming', () => {
  const rows = [];
  const store = { record: (name, row) => { rows.push({ name, ...row }); return row; } };
  const memo = {};
  health.record({ trusted: false, problems: [], since: null }, store, memo);
  assert.equal(rows.length, 0, 'warming writes nothing');
  health.record({ trusted: true, problems: [] }, store, memo);
  assert.deepEqual(rows.at(-1), { name: 'claude-footer', ok: true }, 'the first result clears a row left failing by a restart');
  health.record({ trusted: true, problems: [] }, store, memo);
  assert.equal(rows.length, 1);
  health.record({ trusted: false, since: 5, problems: ['pane p1: 1 background shell process(es), the footer shows none'] }, store, memo);
  health.record({ trusted: false, since: 5, problems: [] }, store, memo);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].ok, false);
  assert.match(rows[1].error, /stopped using it for status\. pane p1/);
});
