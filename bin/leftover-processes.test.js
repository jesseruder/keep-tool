'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const leftovers = require('./leftover-processes');

const STARTED = 'Mon Sep 21 20:00:00 2026';
const NOW = Date.parse('2026-09-22T12:00:00Z');
const server = { pid: 200, ppid: 1, uid: 500, rssKb: 2048, started: STARTED, command: 'npm run dev' };
const child = { pid: 201, ppid: 200, uid: 500, rssKb: 409600, started: STARTED, command: 'node /repo/node_modules/.bin/next dev' };

function fixture() {
  const state = {
    rows: [{ ...server }, { ...child }, { pid: 9, ppid: 1, uid: 500, rssKb: 1, started: STARTED, command: '/bin/zsh' }],
    panes: [{ id: 'aaaa1111', alive: false, exitedAt: new Date(NOW - 60 * 60e3).toISOString(), meta: { card: 'a-card', sessionId: 's-1' } },
      { id: 'bbbb2222', alive: true, meta: { sessionId: 's-2' } }],
    env: new Map([[200, { KEEP_PANE: 'aaaa1111', CLAUDE_CODE_SESSION_ID: 's-1' }]]),
  };
  const signals = [];
  const deps = {
    uid: 500, now: () => NOW, graceMs: 15 * 60e3, termWaitMs: 0, sleep: async () => {},
    processes: async () => state.rows.map((row) => ({ ...row })),
    panes: async () => state.panes,
    environments: async (pids) => new Map(pids.filter((pid) => state.env.has(pid)).map((pid) => [pid, state.env.get(pid)])),
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 'SIGTERM' && !state.stubborn) state.rows = state.rows.filter((row) => row.pid !== pid);
    },
  };
  return { state, deps, signals };
}

test('a detached tree whose pane exited past the grace period is stopped, children first', async () => {
  const f = fixture();
  const listed = await leftovers.list(f.deps);
  assert.equal(listed.known, true);
  assert.equal(listed.leftovers.length, 1);
  assert.deepEqual(listed.leftovers[0].tree, [201]);
  assert.equal(listed.leftovers[0].card, 'a-card');
  assert.equal(listed.leftovers[0].due, true);
  assert.deepEqual(f.signals, []);
  const result = await leftovers.reap({ deps: f.deps });
  assert.equal(result.stopped.length, 1);
  assert.deepEqual(f.signals, [[201, 'SIGTERM'], [200, 'SIGTERM']]);
});

test('a dry run names the tree and sends nothing', async () => {
  const f = fixture();
  assert.equal((await leftovers.reap({ dry: true, deps: f.deps })).stopped.length, 1);
  assert.deepEqual(f.signals, []);
});

test('survivors of SIGTERM get SIGKILL, but only while their identity still matches', async () => {
  const f = fixture();
  f.state.stubborn = true;
  await leftovers.reap({ deps: { ...f.deps, sleep: async () => { f.state.rows[1].started = 'Tue Sep 22 11:59:00 2026'; } } });
  assert.deepEqual(f.signals, [[201, 'SIGTERM'], [200, 'SIGTERM'], [200, 'SIGKILL']]);
});

test('ownership evidence protects a process', async () => {
  const cases = {
    'live pane': (f) => { f.state.panes[0].alive = true; },
    'same session alive in another pane': (f) => { f.state.panes[1].meta.sessionId = 's-1'; },
    'KEEP_PERSIST=1': (f) => { f.state.env.get(200).KEEP_PERSIST = '1'; },
    'no KEEP_PANE': (f) => { f.state.env.set(200, {}); },
    'still has a parent': (f) => { f.state.rows[0].ppid = 9; },
    'another user': (f) => { f.state.rows[0].uid = 501; },
    'application': (f) => { f.state.rows[0].command = '/Applications/Keep.app/Contents/MacOS/keep-desktop'; },
    'agent': (f) => { f.state.rows[0].command = '/Users/me/.local/bin/claude --resume x'; },
    'Keep worker': (f) => { f.state.rows[0].command = 'node /Users/me/wt/keep-tool/some-slug/bin/pi-job-runner.js --job 1'; },
    'KEEP_LEFTOVER_EXCLUDE': (f) => { f.deps.exclude = /npm run dev/; },
  };
  for (const [name, change] of Object.entries(cases)) {
    const f = fixture();
    change(f);
    assert.equal((await leftovers.list(f.deps)).leftovers.length, 0, name);
    await leftovers.reap({ deps: f.deps });
    assert.deepEqual(f.signals, [], name);
  }
});

test('the grace period holds a recently exited pane, and a closed pane until the sweep has watched it that long', async () => {
  const f = fixture();
  f.state.panes[0].exitedAt = new Date(NOW - 5 * 60e3).toISOString();
  let result = await leftovers.reap({ deps: f.deps });
  assert.equal(result.waiting.length, 1);
  assert.deepEqual(f.signals, []);

  const g = fixture();
  g.state.panes.shift();
  const seen = new Map();
  let clock = NOW;
  const deps = { ...g.deps, seen, now: () => clock };
  result = await leftovers.reap({ deps });
  assert.equal(result.waiting.length, 1, 'first sighting of a closed pane waits');
  clock += 16 * 60e3;
  result = await leftovers.reap({ deps });
  assert.equal(result.stopped.length, 1);
  // Without a sighting record (a one-off CLI run) a closed pane counts as gone.
  const h = fixture();
  h.state.panes.shift();
  assert.equal((await leftovers.list(h.deps)).leftovers[0].due, true);
});

test('missing host or process evidence stops the sweep', async () => {
  for (const change of [(f) => { f.state.panes = []; }, (f) => { f.deps.panes = async () => { throw Error('host down'); }; },
    (f) => { f.state.rows = []; }]) {
    const f = fixture();
    change(f);
    const result = await leftovers.reap({ deps: f.deps });
    assert.equal(result.stopped.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.deepEqual(f.signals, []);
  }
});

test('a pid reused between inspection and signal is left alone', async () => {
  const f = fixture();
  let calls = 0;
  const processes = f.deps.processes;
  f.deps.processes = async () => { calls += 1; const rows = await processes(); if (calls > 1) rows[0].started = 'Tue Sep 22 11:59:00 2026'; return rows; };
  const result = await leftovers.reap({ deps: f.deps });
  assert.equal(result.skipped[0].why, 'process changed before signal');
  assert.deepEqual(f.signals, []);
});

test('ps rows parse with rss and start time', () => {
  const rows = leftovers.parseRows('  200     1   500  2048 Mon Sep 21 20:00:00 2026 npm run dev');
  assert.deepEqual(rows[0], { pid: 200, ppid: 1, uid: 500, rssKb: 2048, started: STARTED, command: 'npm run dev' });
});
