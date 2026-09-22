'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const leftovers = require('./leftover-processes');

const STARTED = 'Mon Sep 21 20:00:00 2026';
const LATER = 'Tue Sep 22 11:59:00 2026';
const NOW = Date.parse('2026-09-22T12:00:00Z');
const server = { pid: 200, ppid: 1, uid: 500, rssKb: 2048, started: STARTED, command: 'npm run dev' };
const child = { pid: 201, ppid: 200, uid: 500, rssKb: 409600, started: STARTED, command: 'node /repo/node_modules/.bin/next dev' };

function fixture() {
  const state = {
    rows: [{ ...server }, { ...child }, { pid: 9, ppid: 1, uid: 500, rssKb: 1, started: STARTED, command: '/bin/zsh' }],
    panes: [{ id: 'aaaa1111', alive: false, exitedAt: new Date(NOW - 60 * 60e3).toISOString(), meta: { card: 'a-card', sessionId: 's-1' } },
      { id: 'bbbb2222', alive: true, meta: { sessionId: 's-2', card: 'b-card' } }],
    env: new Map([[200, { KEEP_PANE: 'aaaa1111', CLAUDE_CODE_SESSION_ID: 's-1' }], [201, { KEEP_PANE: 'aaaa1111' }]]),
    transfers: new Set(),
    ports: new Set(),
  };
  const signals = [];
  const deps = {
    uid: 500, now: () => NOW, graceMs: 15 * 60e3, termWaitMs: 0, sleep: async () => {}, keepRoot: '/home/me/keep',
    processes: async () => state.rows.map((row) => ({ ...row })),
    panes: async () => state.panes,
    environments: async (rows) => new Map(rows.filter((row) => state.env.has(row.pid)).map((row) => [row.pid, state.env.get(row.pid)])),
    listening: async (pids) => new Set(pids.filter((pid) => state.ports.has(pid))),
    transferInFlight: (id) => (state.transfers.has(id) ? { status: 'working' } : null),
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 'SIGTERM' && !state.stubborn) state.rows = state.rows.filter((row) => row.pid !== pid);
    },
  };
  return { state, deps, signals };
}

test('a detached dev tree whose pane exited past the grace period is stopped, root first', async () => {
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
  assert.deepEqual(f.signals, [[200, 'SIGTERM'], [201, 'SIGTERM']]);
});

test('a dry run names the tree and sends nothing', async () => {
  const f = fixture();
  assert.equal((await leftovers.reap({ dry: true, deps: f.deps })).stopped.length, 1);
  assert.deepEqual(f.signals, []);
});

test('survivors of SIGTERM get SIGKILL after one shared wait, only while their identity still matches', async () => {
  const f = fixture();
  f.state.stubborn = true;
  f.state.rows.push({ pid: 300, ppid: 1, uid: 500, rssKb: 1, started: STARTED, command: 'python3 -m http.server' });
  f.state.env.set(300, { KEEP_PANE: 'aaaa1111' });
  let waits = 0;
  await leftovers.reap({ deps: { ...f.deps, sleep: async () => { waits += 1; f.state.rows[1].started = LATER; } } });
  assert.equal(waits, 1);
  assert.deepEqual(f.signals, [[200, 'SIGTERM'], [201, 'SIGTERM'], [300, 'SIGTERM'], [200, 'SIGKILL'], [300, 'SIGKILL']]);
});

test('ownership evidence protects a tree', async () => {
  const cases = {
    'live pane': (f) => { f.state.panes[0].alive = true; },
    'same Claude session alive in another pane': (f) => { f.state.panes[1].meta.sessionId = 's-1'; },
    'same Codex thread alive in another pane': (f) => { f.state.env.get(200).CODEX_THREAD_ID = 't-9'; f.state.panes[1].meta.sessionId = 't-9'; },
    'pane session alive elsewhere though the env names none': (f) => { delete f.state.env.get(200).CLAUDE_CODE_SESSION_ID; f.state.panes[1].meta.sessionId = 's-1'; },
    'another live pane on the same card': (f) => { f.state.panes[1].meta.card = 'a-card'; },
    'transfer in flight': (f) => { f.state.transfers.add('s-1'); },
    'KEEP_PERSIST=1 on the root': (f) => { f.state.env.get(200).KEEP_PERSIST = '1'; },
    'KEEP_PERSIST=1 on a child': (f) => { f.state.env.get(201).KEEP_PERSIST = '1'; },
    'another Keep install': (f) => { f.state.env.get(200).KEEP_DIR = '/home/me/keep-dev'; },
    'no KEEP_PANE': (f) => { f.state.env.set(200, {}); },
    'still has a parent': (f) => { f.state.rows[0].ppid = 9; },
    'another user': (f) => { f.state.rows[0].uid = 501; },
    'root is not a dev tool': (f) => { f.state.rows[0].command = '/Users/me/Library/Android/sdk/platform-tools/adb -L tcp:5037 fork-server server'; },
    'watchman root': (f) => { f.state.rows[0].command = '/opt/homebrew/bin/watchman --foreground'; },
    'ssh master under a shell': (f) => { f.state.rows[1].command = 'ssh -M -S /tmp/ctl host'; },
    'adb server under a shell': (f) => { f.state.rows[1].command = '/opt/android/platform-tools/adb start-server'; },
    'application in the tree': (f) => { f.state.rows[1].command = '/Applications/Keep.app/Contents/MacOS/keep-desktop'; },
    'agent in the tree': (f) => { f.state.rows[1].command = '/Users/me/.local/bin/claude --resume x'; },
    'npm-installed agent root': (f) => { f.state.rows[0].command = 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'; },
    'Keep worker': (f) => { f.state.rows[0].command = 'node /Users/me/wt/keep-tool/some-slug/bin/pi-job-runner.js --job 1'; },
    'keep on PATH': (f) => { f.state.rows[0].command = 'node /Users/me/bin/keep serve'; },
    'KEEP_LEFTOVER_EXCLUDE on a child': (f) => { f.deps.exclude = /next dev/; },
  };
  for (const [name, change] of Object.entries(cases)) {
    const f = fixture();
    change(f);
    assert.equal((await leftovers.list(f.deps)).leftovers.length, 0, name);
    await leftovers.reap({ deps: f.deps });
    assert.deepEqual(f.signals, [], name);
  }
});

test('the grace period holds a recent exit, and a closed pane until the sweep itself has watched it that long', async () => {
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

  // A one-off run has watched nothing: after a host crash, keep restore may be about
  // to resume into a closed pane's session.
  const h = fixture();
  h.state.panes.shift();
  assert.equal((await leftovers.list(h.deps)).leftovers[0].due, false);
});

test('missing host or process evidence stops the sweep and says so', async () => {
  for (const change of [(f) => { f.state.panes = []; }, (f) => { f.deps.panes = async () => { throw Object.assign(Error('host down'), { evidence: true }); }; },
    (f) => { f.state.rows = []; }]) {
    const f = fixture();
    change(f);
    const result = await leftovers.reap({ deps: f.deps });
    assert.equal(result.stopped.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].evidence, true);
    assert.deepEqual(f.signals, []);
  }
});

test('remote panes never stand in for this machine', async () => {
  const f = fixture();
  f.state.panes = [{ id: 'aaaa1111@aws1', alive: true, meta: {} }, f.state.panes[1]];
  // The local pane is missing (closed); a remote pane with the same short id is not it.
  assert.equal((await leftovers.list(f.deps)).leftovers[0].paneState, 'closed');
});

test('a pane restarted in place between the first look and the signal protects its tree', async () => {
  const f = fixture();
  let lists = 0;
  f.deps.panes = async () => { lists += 1; return lists > 1 ? [{ ...f.state.panes[0], alive: true }, f.state.panes[1]] : f.state.panes; };
  const result = await leftovers.reap({ deps: f.deps });
  assert.equal(result.skipped[0].why, 'ownership or process changed before signal');
  assert.deepEqual(f.signals, []);
});

test('a pid reused after inspection is left alone', async () => {
  const f = fixture();
  let calls = 0;
  const processes = f.deps.processes;
  f.deps.processes = async () => { calls += 1; const rows = await processes(); if (calls > 2) rows[0].started = LATER; return rows; };
  const result = await leftovers.reap({ deps: f.deps });
  assert.equal(result.skipped[0].why, 'process changed before signal');
  assert.deepEqual(f.signals, []);
});

test('the macOS environment is read after the arguments, never from them', () => {
  const rows = [{ pid: 5, command: "sh -c echo x KEEP_PANE=fromargv KEEP_PERSIST=0" }, { pid: 6, command: 'node server.js' }, { pid: 7, command: 'npm run dev' }];
  const stdout = [
    ' 5 sh -c echo x KEEP_PANE=fromargv KEEP_PERSIST=0 HOME=/h KEEP_PANE=realpane KEEP_PERSIST=1',
    ' 6 node server.js PATH=/bin KEEP_PANE=abcd1234 CODEX_THREAD_ID=t-1',
    ' 7 npm run build KEEP_PANE=changed',
  ].join('\n');
  const env = leftovers.parseEnvironments(stdout, rows);
  assert.deepEqual(env.get(5), { KEEP_PANE: 'realpane', KEEP_PERSIST: '1' });
  assert.deepEqual(env.get(6), { KEEP_PANE: 'abcd1234', CODEX_THREAD_ID: 't-1' });
  assert.equal(env.has(7), false, 'a process whose arguments changed is unknown, so protected');
});

test('a one-off job still working is never stopped; the same tree serving a port is', async () => {
  const f = fixture();
  f.state.rows[0].command = 'bash migrate.sh';
  f.state.rows[1].command = 'node scripts/replay.js --all';
  assert.equal((await leftovers.list(f.deps)).leftovers.length, 0);
  await leftovers.reap({ deps: f.deps });
  assert.deepEqual(f.signals, []);
  f.state.ports.add(201);
  assert.equal((await leftovers.list(f.deps)).leftovers.length, 1);
});

test('dev servers, watchers and test runners are recognised by their tools', () => {
  for (const command of ['npm run dev', 'node /r/node_modules/.bin/next dev', 'npm exec react-native start --port 8082',
    'node /r/node_modules/vitest/dist/workers/forks.js', 'python3 -m http.server', 'uv run flask run', 'node /x/cli/dist/index.js serve /y',
    'node /r/node_modules/.bin/jest --watch', 'node /r/node_modules/@storybook/cli/bin/index.js dev']) {
    assert.equal(leftovers.DEV_TOOLS.test(command), true, command);
  }
  for (const command of ['node scripts/replay.js --all', 'bash migrate.sh', 'python eval.py', 'make build', 'node /r/node_modules/typescript/bin/tsc -p .']) {
    assert.equal(leftovers.DEV_TOOLS.test(command), false, command);
  }
});

test('remote panes do not make an empty local list trustworthy', async () => {
  const f = fixture();
  f.state.panes = [{ id: 'cccc3333@aws1', alive: true, meta: {} }];
  const result = await leftovers.reap({ deps: f.deps });
  assert.equal(result.skipped[0].evidence, true);
  assert.deepEqual(f.signals, []);
});

test('ps rows parse with rss and start time', () => {
  const rows = leftovers.parseRows('  200     1   500  2048 Mon Sep 21 20:00:00 2026 npm run dev');
  assert.deepEqual(rows[0], { pid: 200, ppid: 1, uid: 500, rssKb: 2048, started: STARTED, command: 'npm run dev' });
});
