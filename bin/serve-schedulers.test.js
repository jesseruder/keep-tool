'use strict';

// The two daemon timers that can be exercised on their own: the registry pull and
// the event-loop lag probe. Both are built by factories precisely so a test can
// drive them with its own git children, lock and clock instead of standing up
// startSchedulers and the whole daemon around it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createRegistryPull, createCleanupSnapshot, startLoopLagProbe, startReceiptsPoller } = require('./serve/schedulers.js');

const ROOT = '/registry/root';

test('cleanup snapshot uses the dashboard worker result, its tasks, and cached companion discovery', async () => {
  const calls = [];
  const panes = [{ id: 'pane-one' }];
  const tasks = [{ id: 'card-one' }];
  const archived = [{ id: 'card-one' }, { id: 'card-archived' }];
  const companion = { known: true, jobs: [] };
  const snapshot = createCleanupSnapshot({
    keep: { ROOT, loadAll: (includeArchive) => (includeArchive ? archived : tasks) },
    keepConsole: { readLayouts: async (file) => {
      assert.equal(file, path.join(ROOT, '.keep', 'layouts.json'));
      return { layouts: [{ ids: ['pinned-one'] }] };
    } },
    listHostPanes: async (deps, fresh) => { calls.push(['panes', deps, fresh]); return panes; },
    companionSnapshot: async () => { calls.push(['companion']); return companion; },
    dashboardBuild: async (input) => {
      calls.push(['build', input]);
      return { sessions: [{ id: 'session-one' }], tasks };
    },
    reconcile: (root, sessions, seenPanes) => calls.push(['reconcile', root, sessions, seenPanes]),
  });
  const result = await snapshot();
  assert.deepEqual(calls[0], ['panes', {}, true], 'the pane verification bypasses its cache');
  assert.deepEqual(calls[2], ['build', { hostPanes: panes, companion, dashboard: true }]);
  assert.equal(result.allTasks, archived, 'cleanup still sees archived cards');
  assert.equal(result.companion, companion);
  assert.deepEqual([...result.pinned], ['pinned-one']);
  assert.deepEqual(calls[3], ['reconcile', ROOT, result.sessions, panes]);
});

// Which git this is, for both the answers table and the order log. The abort is
// told apart from the rebase it follows because only the order of the two says
// the registry was left clean.
const gitName = (args) => (args[2] === 'rebase' && args[3] === '--abort' ? 'abort' : args[2]);

// A pull whose git children are the `answers` table: per subcommand, what it
// prints, how long it takes on the fake clock, whether it fails and whether it
// was killed for running too long. `hold` defers one child's answer until the
// test releases it, which is how an overlapping tick is observed.
function harness(answers = {}) {
  const order = [];
  const rows = [];
  const calls = { async: [], sync: [] };
  const held = [];
  let clock = 1000;

  const answerFor = (args) => {
    const answer = answers[gitName(args)] || {};
    clock += answer.elapsed || 0;
    return answer;
  };

  const keep = {
    ROOT,
    withLock(fn) {
      order.push('lock');
      try { return fn(); } finally { order.push('unlock'); }
    },
  };

  const pull = createRegistryPull({
    keep,
    health: { record: (name, entry) => rows.push([name, entry]) },
    now: () => clock,
    execFile: (file, args, options, cb) => {
      calls.async.push({ file, args, options });
      order.push(gitName(args));
      const answer = answerFor(args);
      const answered = () => (answer.error
        ? cb(Object.assign(new Error(answer.error), { killed: Boolean(answer.killed) }), '', answer.stderr || '')
        : cb(null, answer.stdout ?? '', ''));
      // One-shot, so a released pull's next tick runs straight through.
      if (answer.hold) { answer.hold = false; held.push(answered); return; }
      setImmediate(answered);
    },
    execFileSync: (file, args, options) => {
      calls.sync.push({ file, args, options });
      order.push(gitName(args));
      const answer = answerFor(args);
      if (answer.error) {
        // Node's synchronous timeout shape: code ETIMEDOUT, no `killed` at all.
        throw Object.assign(new Error(answer.error), { stderr: answer.stderr || '', ...(answer.code ? { code: answer.code } : {}) });
      }
      return answer.stdout ?? '';
    },
  });

  return { pull, order, rows, calls, release: () => held.shift()() };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a registry already up to date fetches, counts, and never takes the lock', async () => {
  const h = harness({ fetch: { elapsed: 120 }, 'rev-list': { stdout: '0\n', elapsed: 5 } });
  await h.pull();
  assert.deepEqual(h.calls.async.map((call) => call.args), [
    ['-C', ROOT, 'fetch', '-q'],
    ['-C', ROOT, 'rev-list', '--count', 'HEAD..@{u}'],
  ]);
  assert.equal(h.calls.async[0].file, 'git');
  assert.equal(h.calls.async[0].options.timeout, 30e3);
  assert.equal(h.calls.async[0].options.maxBuffer, 64 * 1024);
  assert.deepEqual(h.calls.sync, [], 'nothing local ran');
  assert.deepEqual(h.order, ['fetch', 'rev-list'], 'the lock was never taken');
  assert.deepEqual(h.rows, [['git-pull', { ok: true, detail: 'up to date, 125ms' }]]);
});

test('a registry behind the remote rebases under the ordinary synchronous lock', async () => {
  const h = harness({ fetch: { elapsed: 200 }, 'rev-list': { stdout: '3\n' }, rebase: { elapsed: 40 } });
  await h.pull();
  assert.deepEqual(h.order, ['fetch', 'rev-list', 'lock', 'rebase', 'unlock'],
    'the lock is taken after the network is done with, and only around the local rebase');
  assert.deepEqual(h.calls.sync.map((call) => call.args), [['-C', ROOT, 'rebase', '-q', '--autostash', '@{u}']]);
  assert.deepEqual(h.calls.sync[0].options.stdio, ['ignore', 'ignore', 'pipe']);
  assert.equal(h.calls.sync[0].options.timeout, 30e3);
  assert.deepEqual(h.rows, [['git-pull', { ok: true, detail: '3 behind, rebased in 240ms' }]]);
});

test('a rebase that conflicts is aborted inside the same lock and reported with git’s own reason', async () => {
  const h = harness({
    fetch: {},
    'rev-list': { stdout: '2\n' },
    rebase: { error: 'Command failed: git rebase', stderr: 'error: could not apply 1234567\n' },
  });
  await h.pull();
  assert.deepEqual(h.order, ['fetch', 'rev-list', 'lock', 'rebase', 'abort', 'unlock'],
    'the registry is never left mid-rebase, and never outside the lock while it is');
  assert.deepEqual(h.calls.sync[1].args, ['-C', ROOT, 'rebase', '--abort']);
  assert.equal(h.rows[0][1].ok, false);
  assert.equal(h.rows[0][1].error.message, 'error: could not apply 1234567');
});

test('an abort that fails too is still the rebase’s failure, not the abort’s', async () => {
  const h = harness({
    fetch: {},
    'rev-list': { stdout: '1\n' },
    rebase: { error: 'Command failed: git rebase', stderr: 'error: could not apply 1234567\n' },
    abort: { error: 'Command failed: git rebase --abort', stderr: 'fatal: No rebase in progress?\n' },
  });
  await h.pull();
  assert.deepEqual(h.order, ['fetch', 'rev-list', 'lock', 'rebase', 'abort', 'unlock']);
  assert.equal(h.rows[0][1].error.message, 'error: could not apply 1234567');
});

test('a fetch that fails is the whole tick: nothing is counted, nothing is locked', async () => {
  const h = harness({ fetch: { error: 'Command failed: git fetch', stderr: 'fatal: could not read from remote repository\n' } });
  await h.pull();
  assert.deepEqual(h.order, ['fetch']);
  assert.deepEqual(h.calls.sync, []);
  assert.equal(h.rows[0][1].ok, false);
  assert.equal(h.rows[0][1].error.message, 'fatal: could not read from remote repository');
});

test('a fetch killed for taking too long says so, so a hung network is not read as a refusal', async () => {
  const h = harness({ fetch: { error: 'Command failed: git fetch', killed: true } });
  await h.pull();
  assert.equal(h.rows[0][1].ok, false);
  assert.equal(h.rows[0][1].error.message, 'Command failed: git fetch (killed after 30s)');
});

test('a rebase that times out says so in the synchronous error shape, which has no killed flag', async () => {
  const h = harness({
    fetch: {},
    'rev-list': { stdout: '1\n' },
    rebase: { error: 'spawnSync git ETIMEDOUT', code: 'ETIMEDOUT' },
  });
  await h.pull();
  assert.deepEqual(h.order, ['fetch', 'rev-list', 'lock', 'rebase', 'abort', 'unlock']);
  assert.equal(h.rows[0][1].error.message, 'spawnSync git ETIMEDOUT (killed after 30s)');
});

test('a pull still running is never joined by a second one', async () => {
  const h = harness({ fetch: { hold: true }, 'rev-list': { stdout: '0\n' } });
  const first = h.pull();
  await settle();
  await h.pull();
  assert.deepEqual(h.order, ['fetch'], 'the overlapping call fetched nothing');
  assert.deepEqual(h.rows, [], 'and recorded nothing: the first pull owns the row');

  h.release();
  await first;
  assert.deepEqual(h.order, ['fetch', 'rev-list']);
  assert.equal(h.rows.length, 1);

  // Once it has finished, the next tick pulls again as usual.
  await h.pull();
  assert.equal(h.rows.length, 2);
});

test('the lag probe names a tick that arrived late and stays quiet for one on time', () => {
  const lines = [];
  let clock = 0;
  let tick = null;
  let asked = null;
  let unrefs = 0;
  startLoopLagProbe({
    write: (line) => lines.push(line),
    setInterval: (fn, ms) => { tick = fn; asked = ms; return { unref() { unrefs += 1; } }; },
    now: () => clock,
  });
  assert.equal(asked, 1000);
  assert.equal(unrefs, 1, 'the probe never keeps the daemon alive by itself');

  clock = 1000;
  tick();
  assert.deepEqual(lines, [], 'a tick on time says nothing');

  clock = 2400;
  tick();
  assert.deepEqual(lines, [], '400ms of lateness is under the threshold');

  clock = 4600;
  tick();
  assert.deepEqual(lines, ['keep serve: event loop stalled 1200ms\n']);

  clock = 5600;
  tick();
  assert.equal(lines.length, 1, 'the next tick is on time again: one stall is reported once');
});


// The receipts poller: one timer, rescheduled after each run, and a run that
// outlasts its cadence is never joined by a second one.
function receiptsHarness(answers) {
  const rows = [];
  const timers = [];
  let unrefs = 0;
  const polls = [];
  const poller = startReceiptsPoller({
    keep: { ROOT: '/registry/root' },
    health: { record: (name, entry) => rows.push([name, entry]) },
    poll: (request) => { polls.push(request); return answers(polls.length); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { unref() { unrefs += 1; } }; },
    write: () => {},
  });
  return { poller, rows, timers, polls, unrefs: () => unrefs };
}

test('the receipts poller keeps one unrefd timer, a cadence apart', async () => {
  const harness = receiptsHarness(() => Promise.resolve({ ok: true, detail: '0 resolved, 0 pending' }));
  assert.equal(harness.timers.length, 1, 'one mechanism, not an interval beside a timeout');
  assert.equal(harness.timers[0].ms, 15 * 60e3, 'the first poll is a cadence after start, not at start');
  assert.equal(harness.unrefs(), 1, 'the poller never keeps the daemon alive by itself');
  assert.deepEqual(harness.polls, []);

  await harness.timers[0].fn();
  assert.deepEqual(harness.polls, [{ root: '/registry/root' }]);
  assert.deepEqual(harness.rows, [['push-receipts', {
    ok: true, cadenceMs: 15 * 60e3, detail: '0 resolved, 0 pending',
  }]]);
  assert.equal(harness.timers.length, 2, 'the run that finished scheduled the next one');
  assert.equal(harness.timers[1].ms, 15 * 60e3);
});

test('a slow receipts run is never joined by a second one', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const harness = receiptsHarness((count) => count === 1
    ? held.then(() => ({ ok: true, detail: 'slow' }))
    : Promise.resolve({ ok: true, detail: 'fast' }));

  const first = harness.timers[0].fn();
  assert.equal(harness.poller.running, true);
  await harness.poller.tick();
  assert.equal(harness.polls.length, 1, 'the second call found one in flight and left it alone');
  assert.equal(harness.timers.length, 1, 'and started no timer of its own');

  release();
  await first;
  assert.equal(harness.poller.running, false);
  assert.equal(harness.timers.length, 2);
  await harness.timers[1].fn();
  assert.equal(harness.polls.length, 2);
  assert.deepEqual(harness.rows.map(([, entry]) => entry.detail), ['slow', 'fast']);
});

test('a failed receipts request leaves the health row failing, not green', async () => {
  const harness = receiptsHarness((count) => count === 1
    ? Promise.resolve({ ok: false, error: 'receipts request failed: HTTP 502', detail: '0 resolved, 3 pending — HTTP 502' })
    : Promise.reject(new Error('poll threw')));

  await harness.timers[0].fn();
  assert.deepEqual(harness.rows[0], ['push-receipts', {
    ok: false,
    cadenceMs: 15 * 60e3,
    detail: '0 resolved, 3 pending — HTTP 502',
    error: 'receipts request failed: HTTP 502',
  }]);

  // pollReceipts does not throw, but a bug that made it throw must not lose the timer.
  await harness.timers[1].fn();
  assert.equal(harness.rows[1][1].ok, false);
  assert.equal(harness.rows[1][1].error.message, 'poll threw');
  assert.equal(harness.timers.length, 3);
});

// startSchedulers reads the daemon's internals out of one destructured ctx. A name the
// body uses but the head never declares is a ReferenceError at daemon start — nothing
// here runs until the daemon runs, so the file itself is what has to be checked. This
// caught exactly that: a scheduler was handed `companionSnapshot` that ctx never bound.
test('every ctx value a scheduler is handed is destructured from ctx', () => {
  const source = fs.readFileSync(require.resolve('./serve/schedulers.js'), 'utf8');
  const fn = source.slice(source.indexOf('function startSchedulers(ctx)'));
  const split = fn.indexOf('} = ctx;');
  assert.ok(split > 0, 'startSchedulers still destructures ctx in one place');
  const declared = new Set(fn.slice(0, split).match(/[A-Za-z_$][\w$]*/g) || []);
  const body = fn.slice(split);
  // Names the body introduces itself: callback parameters and its own declarations.
  // A shorthand `{ pane }` inside a callback is that callback's variable, not ctx's.
  const local = new Set();
  for (const m of body.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const name of m[1].split(',')) {
      const bare = name.trim().match(/^([A-Za-z_$][\w$]*)$/);
      if (bare) local.add(bare[1]);
    }
  }
  for (const m of body.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) local.add(m[1]);
  for (const m of body.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
  for (const m of body.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const name of m[1].split(/[,:]/)) {
      const bare = name.trim().match(/^([A-Za-z_$][\w$]*)$/);
      if (bare) local.add(bare[1]);
    }
  }
  const passed = [];
  for (const call of body.matchAll(/startScheduler\(\{([^}]*)\}/g)) {
    for (const part of call[1].split(',')) {
      const shorthand = part.trim().match(/^([A-Za-z_$][\w$]*)$/);
      if (shorthand && !local.has(shorthand[1])) passed.push(shorthand[1]);
    }
  }
  assert.ok(passed.length, 'the scan found the shorthand bindings it is meant to check');
  for (const name of passed) {
    assert.ok(declared.has(name), `${name} is handed to a scheduler but never destructured from ctx`);
  }
});

test('the cleanup snapshot never hands an automatic policy a pane on another node', async () => {
  const calls = [];
  const panes = [
    { id: 'local-one' },
    { id: 'local-two', node: 'main' },
    { id: 'far-one@aws1', node: 'aws1', hostPaneId: 'far-one' },
  ];
  const snapshot = createCleanupSnapshot({
    keep: { ROOT, loadAll: () => [] },
    keepConsole: { readLayouts: async () => ({ layouts: [] }) },
    listHostPanes: async () => panes,
    companionSnapshot: async () => ({ known: true, jobs: [] }),
    dashboardBuild: async (input) => {
      calls.push(['build', input.hostPanes.map((pane) => pane.id)]);
      return { sessions: [], panes: input.hostPanes };
    },
    reconcile: (root, sessions, seenPanes) => calls.push(['reconcile', seenPanes.map((pane) => pane.id)]),
  });
  const result = await snapshot();
  // Everything an automatic policy reads — the shell sweep's candidates and
  // retirement's liveness — stops at this machine, because the pid it would check
  // and the process table it would check it against are both this machine's.
  assert.deepEqual(result.panes.map((pane) => pane.id), ['local-one', 'local-two']);
  assert.deepEqual(calls.find((call) => call[0] === 'reconcile'), ['reconcile', ['local-one', 'local-two']]);
  // The dashboard build still sees the whole fleet: this is a policy boundary,
  // not a decision to stop showing the panes.
  assert.deepEqual(calls.find((call) => call[0] === 'build'),
    ['build', ['local-one', 'local-two', 'far-one@aws1']]);
});

test('periodic schedulers read sessions from the bounded transcript index', () => {
  const { periodicSessionScan } = require('./serve/schedulers.js');
  const calls = [];
  const scan = periodicSessionScan((options) => { calls.push(options); return ['row']; });
  assert.deepEqual(scan(), ['row']);
  assert.deepEqual(scan({ readOnly: true, fresh: true }), ['row']);
  assert.deepEqual(calls, [{ fresh: false }, { readOnly: true, fresh: false }], 'a tick cannot ask for a fresh pass');

  // startSchedulers needs the whole daemon, so the wiring is read from its source:
  // every timer that scans goes through periodicScan, and the one deliberate fresh
  // scan is the area-session tick, which launches and delivers from what it reads.
  const source = fs.readFileSync(path.join(__dirname, 'serve', 'schedulers.js'), 'utf8');
  const body = source.slice(source.indexOf('function startSchedulers('));
  const wired = (pattern) => assert.match(body, pattern);
  wired(/runs\.setEphemeralHost\(\{[\s\S]*?sessions: \(\) => periodicScan\(\),[\s\S]*?\}\);/);
  wired(/require\('\.\.\/notes\.js'\)\.startScheduler\(\{[\s\S]*?sessions: \(\) => periodicScan\(\),/);
  wired(/limitresume\.startScheduler\(\{[\s\S]*?scanSessions: \(\) => periodicScan\(\),/);
  wired(/ctx\.sessionSnapshot : periodicScan\(\);/);
  const fresh = body.match(/\bscanSessions\(\)/g) || [];
  assert.equal(fresh.length, 1, 'only the area-session tick scans fresh');
  assert.match(body, /const areaSessionDeps = \(\) => \(\{[\s\S]*?scanSessions: \(\) => scanSessions\(\),/);
});
