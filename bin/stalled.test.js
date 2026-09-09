'use strict';

for (const name of Object.keys(process.env)) {
  if (name.startsWith('KEEP_REVIEWER')) delete process.env[name];
}

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const stalled = require('./stalled.js');

test('running session stalls only after its unchanged transcript crosses the threshold', () => {
  const now = Date.parse('2026-09-04T00:30:00Z');
  const observations = { abc: { size: 200, mtime: now - 20 * 60e3, at: now - 20 * 60e3 } };
  const session = { id: 'abc', kind: 'claude', title: 'Feature', state: 'running', size: 200, mtime: now - 20 * 60e3 };
  assert.deepEqual(stalled.detectStalledSessions([session], now, { stallMs: 15 * 60e3, observations }), [{
    kind: 'session', id: 'abc', agent: 'claude', title: 'Feature', idleMs: 20 * 60e3, since: now - 20 * 60e3,
  }]);
  assert.deepEqual(stalled.detectStalledSessions([{ ...session, state: 'idle' }], now, { stallMs: 1, observations }), []);
  assert.deepEqual(stalled.detectStalledSessions([session], now, { stallMs: 25 * 60e3, observations }), []);
});

test('live-session filtering skips gone sessions without changing the legacy fallback', () => {
  const now = Date.parse('2026-09-04T00:30:00Z');
  const observations = {
    alive: { size: 100, at: now - 20 * 60e3 },
    gone: { size: 200, at: now - 20 * 60e3 },
  };
  const sessions = [
    { id: 'alive', kind: 'claude', state: 'running', size: 100 },
    { id: 'gone', kind: 'claude', state: 'running', size: 200 },
  ];
  assert.deepEqual(
    stalled.detectStalledSessions(sessions, now, {
      stallMs: 15 * 60e3, observations, aliveIds: new Set(['alive']),
    }).map((item) => item.id),
    ['alive'],
  );
  assert.deepEqual(
    stalled.detectStalledSessions(sessions, now, { stallMs: 15 * 60e3, observations }).map((item) => item.id),
    ['alive', 'gone'],
  );
});

test('Codex sessions and Claude sessions with a tool running use the 30-minute threshold', () => {
  const now = Date.parse('2026-09-04T00:40:00Z');
  const observations = {
    codex: { size: 100, at: now - 20 * 60e3 },
    tool: { size: 200, at: now - 31 * 60e3 },
  };
  const codex = { id: 'codex', kind: 'codex', state: 'running', size: 100 };
  const tool = { id: 'tool', kind: 'claude', title: 'Build', state: 'running', size: 200, toolRunning: true };
  assert.deepEqual(stalled.detectStalledSessions([codex], now, { observations }), []);
  assert.equal(stalled.detectStalledSessions([codex], now, {
    observations: { codex: { size: 100, at: now - 31 * 60e3 } },
  })[0].idleMs, 31 * 60e3);
  assert.deepEqual(stalled.detectStalledSessions([tool], now, { observations }), [{
    kind: 'session', id: 'tool', agent: 'claude', title: 'Build', idleMs: 31 * 60e3,
    since: now - 31 * 60e3, label: 'quiet (tool running)',
  }]);
  assert.match(stalled.attentionItems(stalled.detectStalledSessions([tool], now, { observations }))[0].title, /^quiet \(tool running\):/);
});

test('session transcript growth resets its observation clock', () => {
  const now = Date.parse('2026-09-04T00:30:00Z');
  const previous = { abc: { size: 200, mtime: now - 30 * 60e3, at: now - 30 * 60e3 } };
  const sessions = [{ id: 'abc', kind: 'claude', title: 'Growing', state: 'running', size: 201, mtime: now - 1000 }];
  const next = stalled.observeSessions(sessions, previous, now);
  assert.equal(next.abc.at, now - 1000);
  assert.deepEqual(stalled.detectStalledSessions(sessions, now, { stallMs: 15 * 60e3, observations: next }), []);
});

test('headless runs use a 30-minute threshold and ignore finished runs', () => {
  const now = 2_000_000;
  assert.deepEqual(stalled.detectStalledRuns([
    { id: 'run-1', taskId: 'card-a', status: 'running', logMtime: now - 31 * 60e3 },
    { id: 'run-2', taskId: 'card-b', status: 'running', logMtime: now - 20 * 60e3 },
    { id: 'run-3', taskId: 'card-c', status: 'done', logMtime: now - 60 * 60e3 },
  ], now), [
    { kind: 'run', taskId: 'card-a', runId: 'run-1', idleMs: 31 * 60e3 },
  ]);
});

test('Codex jobs are dead only when small, old, and absent from ps', () => {
  const now = Date.parse('2026-09-04T01:00:00Z');
  const jobs = [
    { id: 'dead', status: 'running', updatedAt: now - 11 * 60e3, logMtime: now - 12 * 60e3, logBytes: 263, summary: 'Turn started' },
    { id: 'slow', status: 'running', updatedAt: now - 31 * 60e3, logMtime: now - 32 * 60e3, logBytes: 4096, summary: 'Review' },
    { id: 'alive', pid: 4242, status: 'running', updatedAt: now - 31 * 60e3, logMtime: now - 32 * 60e3, logBytes: 100 },
    { id: 'moving', status: 'running', updatedAt: now - 30 * 60e3, logMtime: now - 2 * 60e3, logBytes: 4096 },
  ];
  assert.deepEqual(stalled.detectStalledCodexJobs(jobs, now, {
    psKnown: true,
    psOutput: '4242 01:00 companion',
    processAlive: () => true,
  }), [
    { kind: 'codex-job', id: 'dead', summary: 'Turn started', idleMs: 11 * 60e3, logBytes: 263, status: 'dead' },
    { kind: 'codex-job', id: 'slow', summary: 'Review', idleMs: 31 * 60e3, logBytes: 4096, status: 'stalled' },
    { kind: 'codex-job', id: 'alive', summary: '', idleMs: 31 * 60e3, logBytes: 100, status: 'stalled' },
  ]);
  assert.equal(stalled.jobProcessAlive({ id: 'by-id' }, "99 01:00 env CODEX_COMPANION_SESSION_ID='by-id' poll"), true);
  assert.equal(stalled.jobProcessAlive({ id: 'worker-id' }, '100 01:00 node companion task-worker --job-id worker-id'), true);
  assert.equal(stalled.detectStalledCodexJobs([jobs[0]], now, { psKnown: false })[0], undefined);
});

test('Codex worker pids report dead immediately and pid-less jobs retain idle detection', () => {
  const now = Date.parse('2026-09-04T01:00:00Z');
  const jobs = [
    { id: 'gone', pid: 101, status: 'running', updatedAt: now, logMtime: now, logBytes: 4096, summary: 'Normal log' },
    { id: 'live', pid: 202, status: 'running', updatedAt: now, logMtime: now, logBytes: 4096 },
    { id: 'no-pid', status: 'running', updatedAt: now - 31 * 60e3, logMtime: now - 31 * 60e3, logBytes: 4096 },
  ];
  assert.deepEqual(stalled.detectStalledCodexJobs(jobs, now, {
    processAlive: (pid) => pid === 202,
  }), [
    {
      kind: 'codex-job', id: 'gone', summary: 'Normal log', idleMs: 0, logBytes: 4096,
      status: 'dead', reason: 'worker gone',
    },
    { kind: 'codex-job', id: 'no-pid', summary: '', idleMs: 31 * 60e3, logBytes: 4096, status: 'stalled' },
  ]);
});

test('a reused worker pid does not keep a dead Codex job alive when ps is known', () => {
  const now = Date.parse('2026-09-04T01:00:00Z');
  const jobs = [
    { id: 'reused', pid: 101, status: 'running', updatedAt: now, logMtime: now, logBytes: 4096 },
    { id: 'live', pid: 202, status: 'running', updatedAt: now, logMtime: now, logBytes: 4096 },
  ];
  const psOutput = [
    '  PID ELAPSED COMMAND',
    '  101   00:10 /usr/bin/python3 unrelated.py',
    '  202   00:10 node codex-companion.mjs task-worker --cwd /x --job-id live',
  ].join('\n');
  const found = stalled.detectStalledCodexJobs(jobs, now, { psKnown: true, psOutput });
  assert.deepEqual(found.map((item) => [item.id, item.status, item.reason]), [['reused', 'dead', 'worker gone']]);
  assert.equal(stalled.workerAlive(202, { psKnown: true, psOutput }, { id: 'live' }), true);
  assert.equal(stalled.workerAlive(101, { psKnown: true, psOutput }, { id: 'reused' }), false);
});

test('stalled sweep renders dead worker attention with the reap command', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-stalled-dead-worker-'));
  const now = Date.parse('2026-09-04T01:00:00Z');
  try {
    const result = await stalled.sweep({
      root, codexStateRoot: path.join(root, 'companion-state'),
      now,
      autoReap: false,
      sessions: [],
      runs: [],
      jobs: [{ id: 'gone', pid: 303, status: 'running', updatedAt: now, logMtime: now, logBytes: 4096 }],
      psOutput: '',
      deps: { processAlive: () => false },
    });
    assert.equal(result.items[0].reason, 'worker gone');
    assert.equal(
      stalled.attentionItems(result.items)[0].title,
      'Dead Codex job gone: worker process gone (record still running); keep codex-jobs --reap',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('orphan forwarder parser accepts captured ps output with a ppid column', () => {
  const ps = "80143 20751 36:43 /bin/zsh -c source /tmp/x; export CODEX_COMPANION_SESSION_ID='abc'; poll";
  // the env value is the launching Claude session, not a job id: any running job
  // keeps every poller alive, and only an old shell with no job at all is an orphan
  assert.deepEqual(stalled.detectOrphanShells(ps, [{ id: 'still-running', status: 'running' }]), []);
  assert.deepEqual(stalled.detectOrphanShells(ps, []), [
    { kind: 'orphan-shell', id: '80143', pid: 80143, etime: '36:43', idleMs: 36 * 60e3 + 43e3, sessionId: 'abc' },
  ]);
  const young = "555 04:10 /bin/zsh -c export CODEX_COMPANION_SESSION_ID='abc'; poll";
  assert.deepEqual(stalled.detectOrphanShells(young, []), []);
});

test('stalled observation state persists round-trip', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-stalled-state-'));
  try {
    const value = { version: 1, sessions: { abc: { size: 42, mtime: 100, at: 90 } } };
    stalled.saveState(value, { root });
    assert.deepEqual(stalled.loadState({ root }), value);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('first seen survives three missed sweeps and the item drops after the third', () => {
  const item = { kind: 'session', id: 'abc', firstSeenAt: 100, idleMs: 1000 };
  const firstMiss = stalled.reconcileFirstSeen([], [item], 200);
  assert.deepEqual(firstMiss, [{ ...item, missingSince: 200, missingSweeps: 1 }]);
  const secondMiss = stalled.reconcileFirstSeen([], firstMiss, 300);
  assert.deepEqual(secondMiss, [{ ...item, missingSince: 200, missingSweeps: 2 }]);
  const thirdMiss = stalled.reconcileFirstSeen([], secondMiss, 400);
  assert.deepEqual(thirdMiss, [{ ...item, missingSince: 200, missingSweeps: 3 }]);
  assert.deepEqual(stalled.reconcileFirstSeen([], thirdMiss, 500), []);
  assert.equal(stalled.reconcileFirstSeen([{ kind: 'session', id: 'abc', idleMs: 2000 }], firstMiss, 300)[0].firstSeenAt, 100);
});

test('process-backed findings drop on the first missed sweep while sessions retain grace', () => {
  const session = { kind: 'session', id: 'session', firstSeenAt: 100 };
  const orphan = { kind: 'orphan-shell', id: '42', pid: 42, firstSeenAt: 100 };
  const current = stalled.reconcileFirstSeen([], [session, orphan], 200);
  assert.deepEqual(current, [{ ...session, missingSince: 200, missingSweeps: 1 }]);
});

test('sweep scopes reap to detected dead jobs and their shells, retaining skipped findings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-stalled-auto-reap-'));
  const now = Date.parse('2026-09-04T01:00:00Z');
  const calls = [];
  try {
    const result = await stalled.sweep({
      root, codexStateRoot: path.join(root, 'companion-state'),
      now,
      sessions: [],
      runs: [],
      jobs: [
        { id: 'gone', pid: 303, status: 'running', updatedAt: now, logMtime: now, logBytes: 4096 },
        { id: 'reused', pid: 304, status: 'running', updatedAt: now, logMtime: now, logBytes: 4096 },
        { id: 'quiet', pid: 305, status: 'running', updatedAt: now - 31 * 60e3, logMtime: now - 31 * 60e3, logBytes: 4096 },
      ],
      psOutput: [
        "401 21:05 /bin/zsh -c export CODEX_COMPANION_SESSION_ID='claude'; node /x/codex-companion.mjs status gone; sleep 30",
        "402 21:05 /bin/zsh -c export CODEX_COMPANION_SESSION_ID='claude'; node /x/codex-companion.mjs result reused; sleep 30",
        "403 21:05 /bin/zsh -c export CODEX_COMPANION_SESSION_ID='claude'; node /x/codex-companion.mjs status quiet; sleep 30",
        "404 21:05 /bin/zsh -c export CODEX_COMPANION_SESSION_ID='gone'; sleep 30",
      ].join('\n'),
      deps: {
        processAlive: (pid) => pid === 305,
        reap: async (options) => {
          calls.push(options);
          assert.deepEqual(options.only, { jobs: new Set(['gone', 'reused']), shells: new Set([401, 402]) });
          return { cancelled: ['gone'], killed: [401], skipped: [{ id: 'reused', why: 'pid reused' }] };
        },
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dry, false);
    assert.deepEqual(result.items.map((item) => item.id), ['reused', 'quiet', '402']);
    assert.equal(result.detail, '3 current; reaped 1 job, 1 shell, skipped 1');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sweep does not reap when only a stalled session is detected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-stalled-no-auto-reap-'));
  const now = Date.parse('2026-09-04T01:00:00Z');
  let calls = 0;
  try {
    const result = await stalled.sweep({
      root, codexStateRoot: path.join(root, 'companion-state'),
      now,
      stallMs: 1,
      sessions: [{ id: 'session', kind: 'claude', state: 'running', size: 10, mtime: now - 1000 }],
      runs: [],
      jobs: [],
      psOutput: '',
      deps: { reap: async () => { calls += 1; return { cancelled: [], killed: [], skipped: [] }; } },
    });
    assert.equal(calls, 0);
    assert.deepEqual(result.items.map((item) => item.kind), ['session']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('missing companion state is unknown rather than an empty successful discovery', async () => {
  const stateRoot = path.join(os.tmpdir(), `keep-no-companion-${process.pid}-${Date.now()}`);
  assert.deepEqual(await stalled.discoverCodexJobs({ codexStateRoot: stateRoot }), { jobs: [], known: false });
});

test('fallback companion status and ps use injected asynchronous execFile calls', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-stalled-async-'));
  const stateRoot = path.join(root, 'companion-state');
  fs.mkdirSync(path.join(stateRoot, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'broken', 'state.json'), '{not json');
  const now = Date.parse('2026-09-04T01:00:00Z');
  const calls = [];
  const execFile = (file, args, options, callback) => {
    calls.push({ file, args, timeout: options.timeout });
    setImmediate(() => {
      if (file === process.execPath) {
        callback(null, JSON.stringify({ running: [{ id: 'dead', pid: 123, updatedAt: now - 11 * 60e3 }] }));
      } else callback(null, '999 00:20 unrelated');
    });
  };
  try {
    const result = await stalled.sweep({
      root, now, autoReap: false, sessions: [], runs: [], codexStateRoot: stateRoot,
      companionScript: '/fake/codex-companion.mjs', fallbackCacheMs: 0,
      deps: { execFile, processAlive: () => false },
    });
    assert.equal(result.detail, '1 current');
    assert.equal(result.items[0].status, 'dead');
    assert.deepEqual(calls, [
      { file: process.execPath, args: ['/fake/codex-companion.mjs', 'status', '--json'], timeout: 10e3 },
      { file: 'ps', args: ['-axo', 'pid,ppid,etime,command'], timeout: 10e3 },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed companion fallback records unknown; failed ps prevents broker and orphan classification', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-stalled-unknown-'));
  const stateRoot = path.join(root, 'companion-state');
  fs.mkdirSync(path.join(stateRoot, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'broken', 'state.json'), '{not json');
  let calls = 0;
  const execFile = (file, args, options, callback) => {
    calls += 1;
    const error = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    setImmediate(() => callback(error));
  };
  try {
    const result = await stalled.sweep({
      root, sessions: [], runs: [], codexStateRoot: stateRoot,
      companionScript: '/fake/timed-out.mjs', fallbackCacheMs: 0, deps: { execFile },
    });
    assert.equal(result.detail, 'companion state unknown');
    assert.deepEqual(result.items, []);
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keep stalled --json returns an empty list for a new registry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-stalled-cli-'));
  try {
    fs.mkdirSync(path.join(root, 'tasks'));
    const result = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'stalled', '--json'], {
      env: { ...process.env, KEEP_DIR: root }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sweep detects a cwd-gone broker and auto-reaps through the injected reaper', async () => {
  const root = fs.mkdtempSync(path.join('/tmp', 'keep-stalled-broker-'));
  const stateRoot = path.join(root, 'state');
  const dir = path.join(stateRoot, 'workspace');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ jobs: [] }));
  fs.writeFileSync(path.join(dir, 'broker.json'), JSON.stringify({ pid: 100, endpoint: 'unix:/tmp/cxc-fixture/broker.sock' }));
  const aliveIds = new Set(['owner']);
  const options = {
    root, codexStateRoot: stateRoot, sessions: [], runs: [], jobs: [], aliveIds,
    psOutput: `100 1 00:01 node /plugin/app-server-broker.mjs serve --endpoint unix:/tmp/cxc-fixture/broker.sock --cwd ${root}/gone`,
  };
  try {
    const detected = await stalled.sweep({ ...options, autoReap: false });
    assert.equal(detected.items[0].kind, 'codex-broker');
    assert.equal(detected.items[0].status, 'cwd-gone');
    assert.match(stalled.render(detected.items), /Codex broker 100 for .*workspace directory gone/);
    let calls = 0;
    const reaped = await stalled.sweep({ ...options, deps: {
      reapBrokers: async ({ dry, deps }) => {
        calls += 1;
        assert.equal(dry, false);
        assert.equal(deps.aliveIds, aliveIds);
        return { shutdown: [{ pid: 100 }], skipped: [] };
      },
    } });
    assert.equal(calls, 1);
    assert.deepEqual(reaped.items, []);
    assert.match(reaped.detail, /1 brokers/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sweep excludes young orphans and foreground-protected brokers from auto-reaping', async (t) => {
  const root = fs.mkdtempSync('/tmp/keep-stalled-broker-guards-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'state');
  const dir = path.join(stateRoot, 'workspace');
  fs.mkdirSync(dir, { recursive: true });
  const endpoint = `unix:${root}/broker.sock`;
  fs.writeFileSync(path.join(dir, 'broker.json'), JSON.stringify({ pid: 100, endpoint }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ jobs: [{ id: 'fg', pid: 202, status: 'running', updatedAt: 1 }] }));
  const options = {
    root, codexStateRoot: stateRoot, sessions: [], runs: [], jobs: [],
    psOutput: [
      `100 1 1-00:00:00 node /plugin/app-server-broker.mjs serve --endpoint ${endpoint} --cwd ${root}/gone`,
      '101 1 09:59 node /plugin/app-server-broker.mjs serve --endpoint unix:/tmp/orphan.sock',
      '202 1 1-00:00:00 node /plugin/codex-companion.mjs task prompt',
    ].join('\n'),
    deps: { reapBrokers: () => assert.fail('no reapable brokers') },
  };
  assert.deepEqual((await stalled.sweep(options)).items, []);
  const eligible = await stalled.sweep({ ...options, autoReap: false, psOutput: options.psOutput.replace('101 1 09:59', '101 1 10:00') });
  assert.deepEqual(eligible.items.map((item) => [item.kind, item.pid, item.status]), [['codex-broker', 101, 'orphan']]);
});
