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
const codexJobs = require('./codexjobs.js');

const NOW = Date.parse('2026-09-04T02:00:00Z');

function fakeDeps(jobs, psOutput = '') {
  return { jobs, psOutput, psKnown: true, now: NOW };
}

test('reap cancels a dead job and leaves a fresh running job untouched', async () => {
  const cancelled = [];
  const jobs = [
    { id: 'dead', pid: 101, status: 'running', createdAt: NOW, updatedAt: NOW, logMtime: NOW, logBytes: 4096 },
    { id: 'fresh', pid: 202, status: 'running', createdAt: NOW - 2 * 60e3, updatedAt: NOW - 1000, logMtime: NOW - 1000, logBytes: 4096 },
  ];
  const result = await codexJobs.reap({ deps: {
    ...fakeDeps(jobs),
    processAlive: (pid) => pid === 202,
    cancel: async (id) => cancelled.push(id),
  } });
  assert.deepEqual(cancelled, ['dead']);
  assert.deepEqual(result.cancelled, ['dead']);
  assert.match(result.skipped.find((item) => item.id === 'fresh').why, /fresh activity/);
});

test('list preserves the dead-worker reason and the table renders it', async () => {
  const report = await codexJobs.list({
    ...fakeDeps([{ id: 'gone', sessionId: 'owner-session', pid: 303, status: 'running', updatedAt: NOW, logMtime: NOW, logBytes: 4096 }]),
    processAlive: () => false,
  });
  assert.equal(report.jobs[0].state, 'dead');
  assert.equal(report.jobs[0].reason, 'worker gone');
  assert.equal(report.jobs[0].sessionId, 'owner-session');
  const { renderCodexJobs } = require('./keep.js');
  assert.match(renderCodexJobs(report), /dead \(worker gone\)/);
});

test('reap skips a stalled job idle for less than 20 minutes with a reason', async () => {
  const cancelled = [];
  const jobs = [{ id: 'warming', status: 'running', updatedAt: NOW - 19 * 60e3, logMtime: NOW - 19 * 60e3, logBytes: 4096 }];
  const result = await codexJobs.reap({
    deps: { ...fakeDeps(jobs), longStallMs: 1, cancel: async (id) => cancelled.push(id) },
  });
  assert.deepEqual(cancelled, []);
  assert.deepEqual(result.cancelled, []);
  assert.match(result.skipped[0].why, /20 minutes or less/);
});

test('forwarder shells are orphans only when no companion job is running and they are old', async () => {
  const killed = [];
  const live = [{ id: 'live', status: 'running', updatedAt: NOW - 1000, logMtime: NOW - 1000, logBytes: 4096 }];
  const psOutput = [
    "101 00:05 /bin/zsh -c export CODEX_COMPANION_SESSION_ID='sess-a'; sleep 30",
    "202 21:05 /bin/zsh -c export CODEX_COMPANION_SESSION_ID='sess-b'; sleep 30",
  ].join('\n');
  // a live job means every poller may be its poller: nothing is an orphan
  const busy = await codexJobs.list(fakeDeps(live, psOutput));
  assert.deepEqual(busy.orphans, []);
  // no jobs at all: only the shell past the foreground window is an orphan
  const report = await codexJobs.list(fakeDeps([], psOutput));
  assert.deepEqual(report.orphans.map((item) => item.pid), [202]);
  const result = await codexJobs.reap({ deps: {
    ...fakeDeps([], psOutput),
    psForPid: async () => "202 21:06 /bin/zsh -c export CODEX_COMPANION_SESSION_ID='sess-b'; sleep 30",
    kill: (pid, signal) => killed.push([pid, signal]),
  } });
  assert.deepEqual(killed, [[202, 'SIGTERM']]);
  assert.deepEqual(result.killed, [202]);
});

test('reap skips a stalled job when its recorded pid belongs to another command', async () => {
  const cancelled = [];
  const jobs = [{
    id: 'stale-pid', pid: 515, status: 'running', updatedAt: NOW - 31 * 60e3,
    logMtime: NOW - 31 * 60e3, logBytes: 4096,
  }];
  const result = await codexJobs.reap({ deps: {
    ...fakeDeps(jobs, '515 31:00 sleep 30'),
    processAlive: () => true,
    psForPid: async () => '  PID COMMAND\n  515 sleep 30',
    cancel: async (id) => cancelled.push(id),
  } });
  assert.deepEqual(cancelled, []);
  assert.deepEqual(result.cancelled, []);
  assert.equal(result.skipped[0].why, 'pid 515 is not this job anymore');
});

test('reap skips an orphan whose session id changes during pid revalidation', async () => {
  const killed = [];
  const discovered = "616 21:05 /bin/zsh -c export CODEX_COMPANION_SESSION_ID='before'; sleep 30";
  const result = await codexJobs.reap({ deps: {
    ...fakeDeps([], discovered),
    psForPid: async () => "616 21:06 /bin/zsh -c export CODEX_COMPANION_SESSION_ID='after'; sleep 30",
    kill: (pid) => killed.push(pid),
  } });
  assert.deepEqual(killed, []);
  assert.deepEqual(result.killed, []);
  assert.equal(result.skipped[0].why, 'pid 616 is no longer the same orphan process');
});

test('scoped reap skips outside jobs and shells and never cancels stalled jobs', async () => {
  const cancelled = [];
  const killed = [];
  const result = await codexJobs.reap({
    only: { jobs: new Set(['dead', 'stalled-inside']), shells: new Set() },
    deps: {
      list: async () => ({
        discovery: 'ok',
        jobs: [
          { id: 'dead', pid: 101, state: 'dead' },
          { id: 'dead-outside', pid: 102, state: 'dead' },
          { id: 'stalled-outside', pid: 103, state: 'stalled', idleMs: 31 * 60e3 },
          { id: 'stalled-inside', pid: 104, state: 'stalled', idleMs: 31 * 60e3 },
        ],
        orphans: [{ pid: 202, jobId: 'dead' }],
      }),
      processAlive: () => false,
      cancel: async (id) => cancelled.push(id),
      kill: (pid) => killed.push(pid),
    },
  });
  assert.deepEqual(cancelled, ['dead']);
  assert.deepEqual(result.cancelled, ['dead']);
  assert.deepEqual(killed, []);
  assert.deepEqual(result.skipped, [
    { id: 'dead-outside', why: 'not in this sweep' },
    { id: 'stalled-outside', why: 'not in this sweep' },
    { id: 'stalled-inside', why: 'only dead jobs are reaped in a sweep' },
    { pid: 202, why: 'not in this sweep' },
  ]);
});

test('dead jobs with occupied pids require an exact worker job id before cancellation', async () => {
  for (const command of ['sleep 30', 'node /x/codex-companion.mjs task-worker --job-id dead-other', '']) {
    const cancelled = [];
    const result = await codexJobs.reap({ deps: {
      list: async () => ({ discovery: 'ok', jobs: [{ id: 'dead', pid: 515, state: 'dead' }], orphans: [] }),
      companionScript: '/x/codex-companion.mjs',
      processAlive: () => true,
      psForPid: async () => command ? `515 ${command}` : '',
      cancel: async (id) => cancelled.push(id),
    } });
    assert.deepEqual(cancelled, []);
    assert.deepEqual(result.cancelled, []);
    assert.deepEqual(result.skipped, [{ id: 'dead', why: 'pid 515 is not this job anymore' }]);
  }
});

test('dead jobs with absent pids are cancelled without needing a command match', async () => {
  for (const processAlive of [() => false, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }]) {
    const cancelled = [];
    const result = await codexJobs.reap({ deps: {
      list: async () => ({ discovery: 'ok', jobs: [{ id: 'dead', pid: 515, state: 'dead' }], orphans: [] }),
      processAlive,
      psForPid: async () => { assert.fail('absent pid needs no ps'); },
      cancel: async (id) => cancelled.push(id),
    } });
    assert.deepEqual(cancelled, ['dead']);
    assert.deepEqual(result.cancelled, ['dead']);
  }
});

test('an uncertain pid probe and failed command lookup cannot cancel a dead job', async () => {
  const result = await codexJobs.reap({ deps: {
    list: async () => ({ discovery: 'ok', jobs: [{ id: 'dead', pid: 515, state: 'dead' }], orphans: [] }),
    processAlive: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); },
    psForPid: async () => { throw new Error('ps failed'); },
    cancel: async () => assert.fail('uncertain pid must not be cancelled'),
  } });
  assert.deepEqual(result.cancelled, []);
  assert.deepEqual(result.skipped, [{ id: 'dead', why: 'pid 515 is not this job anymore' }]);
});

test('a matching worker command allows dead-job cancellation', async () => {
  const cancelled = [];
  const result = await codexJobs.reap({ deps: {
    list: async () => ({ discovery: 'ok', jobs: [{ id: 'dead', pid: 515, state: 'dead' }], orphans: [] }),
    processAlive: () => true,
    psForPid: async () => '515 node /x/codex-companion.mjs task-worker --job-id dead',
    cancel: async (id) => cancelled.push(id),
  } });
  assert.deepEqual(cancelled, ['dead']);
  assert.deepEqual(result.cancelled, ['dead']);
});

test('scoped orphan reap checks the dead job command again and ignores unrelated live jobs', async () => {
  for (const currentJob of ['dead', 'different']) {
    const killed = [];
    const shell = (pid, job) => `${pid} 21:05 /bin/zsh -c export CODEX_COMPANION_SESSION_ID='claude'; node /x/codex-companion.mjs status ${job}; sleep 30`;
    const result = await codexJobs.reap({
      only: { jobs: new Set(['dead']), shells: new Set([616]) },
      deps: {
        ...fakeDeps([{ id: 'live', status: 'running', updatedAt: NOW, logMtime: NOW, logBytes: 4096 }],
          [shell(616, 'dead'), shell(617, 'dead')].join('\n')),
        psForPid: async () => shell(616, currentJob),
        kill: (pid) => killed.push(pid),
      },
    });
    assert.deepEqual(killed, currentJob === 'dead' ? [616] : []);
    assert.deepEqual(result.killed, killed);
    assert.ok(result.skipped.some((item) => item.pid === 617 && item.why === 'not in this sweep'));
    if (currentJob !== 'dead') assert.ok(result.skipped.some((item) => item.pid === 616 && /no longer the same/.test(item.why)));
  }
});

test('unknown discovery makes reap do nothing', async () => {
  let actions = 0;
  const result = await codexJobs.reap({ deps: {
    list: async () => ({ discovery: 'unknown', jobs: [], orphans: [] }),
    cancel: async () => { actions += 1; },
    kill: () => { actions += 1; },
  } });
  assert.equal(actions, 0);
  assert.deepEqual(result.cancelled, []);
  assert.deepEqual(result.killed, []);
  assert.match(result.skipped[0].why, /discovery is unknown/);
});

test('--dry returns the action plan but performs no actions', async () => {
  let actions = 0;
  const result = await codexJobs.reap({ dry: true, deps: {
    list: async () => ({
      discovery: 'ok',
      jobs: [{ id: 'dead', state: 'dead', idleMs: 11 * 60e3 }],
      orphans: [{ pid: 303, etime: '22:00', jobId: 'gone' }],
    }),
    cancel: async () => { actions += 1; },
    kill: () => { actions += 1; },
  } });
  assert.equal(actions, 0);
  assert.deepEqual(result.cancelled, ['dead']);
  assert.deepEqual(result.killed, [303]);
});

test('fallback status output and ps lines use injected async dependencies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-jobs-status-'));
  const stateRoot = path.join(root, 'state');
  fs.mkdirSync(path.join(stateRoot, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'broken', 'state.json'), '{broken');
  const execFile = (file, args, options, callback) => {
    if (file === process.execPath) {
      callback(null, JSON.stringify({ running: [{ id: 'fallback', updatedAt: NOW - 1000, summary: 'Active' }] }));
    } else callback(null, "404 00:30 /bin/zsh -c export CODEX_COMPANION_SESSION_ID='gone'; sleep 30");
  };
  try {
    const report = await codexJobs.list({
      now: NOW,
      codexStateRoot: stateRoot,
      companionScript: '/fake/codex-companion.mjs',
      fallbackCacheMs: 0,
      execFile,
    });
    assert.equal(report.discovery, 'partial');
    assert.equal(report.jobs[0].id, 'fallback');
    // a running job (from the fallback status) means the poller is not an orphan
    assert.deepEqual(report.orphans, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('partial direct discovery prevents orphan kills even when fallback status succeeds', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-jobs-partial-'));
  const stateRoot = path.join(root, 'state');
  fs.mkdirSync(path.join(stateRoot, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'broken', 'state.json'), '{broken');
  const sleeps = [];
  const killed = [];
  const execFile = (file, args, options, callback) => {
    if (file === process.execPath) callback(null, JSON.stringify({ running: [] }));
    else callback(null, "717 21:05 /bin/zsh -c export CODEX_COMPANION_SESSION_ID='orphan'; sleep 30");
  };
  try {
    const result = await codexJobs.reap({ deps: {
      now: NOW,
      codexStateRoot: stateRoot,
      companionScript: '/fake/codex-companion.mjs',
      fallbackCacheMs: 0,
      sleep: async (ms) => sleeps.push(ms),
      execFile,
      kill: (pid) => killed.push(pid),
    } });
    assert.deepEqual(sleeps, [500]);
    assert.deepEqual(killed, []);
    assert.deepEqual(result.killed, []);
    assert.match(result.skipped.find((item) => item.id === 'orphans').why, /discovery is partial/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex jobs table strips ANSI escapes and control characters from companion text', () => {
  const { renderCodexJobs } = require('./keep.js');
  const output = renderCodexJobs({
    discovery: 'ok',
    jobs: [{ id: 'job', state: 'running', idleMs: 0, logBytes: 0, summary: '\x1b[2JHello\u0000 clean' }],
    orphans: [],
  });
  assert.match(output, /Hello clean/);
  assert.doesNotMatch(output, /\x1b|\u0000|\[2J/);
});

test('keep codex-jobs --json exits zero against a temporary registry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-jobs-cli-'));
  try {
    fs.mkdirSync(path.join(root, 'tasks'));
    const result = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'codex-jobs', '--json'], {
      env: { ...process.env, KEEP_DIR: root },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.ok(['ok', 'partial', 'unknown'].includes(report.discovery));
    assert.ok(Array.isArray(report.jobs));
    assert.ok(Array.isArray(report.orphans));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
