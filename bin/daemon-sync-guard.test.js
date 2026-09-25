'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { createAnalyzer, comparePolicy, manifestFrom } = require('../scripts/daemon-sync-policy.cjs');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(__dirname, 'daemon-sync-debt.json');

function fixture(files, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-daemon-sync-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
    }
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function analyzeFixture(files, surfaces = ['bin/serve/routes.js']) {
  return fixture(files, (root) => createAnalyzer(root).run(surfaces));
}

test('daemon main-thread sync debt matches the exact checked manifest', () => {
  const analysis = createAnalyzer(ROOT).run();
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const problems = comparePolicy(analysis, manifest);
  assert.deepEqual(problems, [], [
    'Synchronous filesystem, subprocess, and Atomics.wait work blocks every daemon route and scheduler when selected on the main thread.',
    'Move new work to an asynchronous API or a worker. The manifest contains exact legacy debt, not safe APIs:',
    ...problems,
  ].join('\n'));
});

test('standalone policy checker enforces the checked manifest', () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'daemon-sync-policy.cjs'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /daemon sync policy: ok/);
});

test('scanner resolves aliases, destructuring, reexports, and helper calls', () => {
  const analysis = analyzeFixture({
    'bin/serve/routes.js': `
      const fs = require('node:fs');
      const read = fs.readFileSync;
      const { spawnSync: run } = require('child_process');
      const wait = Atomics.wait;
      let reassigned;
      reassigned = fs.realpathSync;
      let overwritten = fs.accessSync;
      const io = {};
      io.copy = fs.copyFileSync;
      io.copy = () => true;
      let logical;
      logical ||= fs.openSync;
      const logicalChoice = (() => true) && fs.mkdtempSync;
      const conditionalChoice = Math.random() > 2 ? (() => true) : fs.chmodSync;
      const sequenceChoice = (0, fs.fdatasyncSync);
      const helper = require('../helper');
      function routes() {
        read('x'); reassigned('x'); run('x'); wait(new Int32Array(1), 0); helper.go();
        overwritten('x'); overwritten = () => true;
        io.copy('from', 'to'); logical('x');
        logicalChoice('x'); conditionalChoice('x'); sequenceChoice(1);
      }
      module.exports = { routes };
    `,
    'bin/helper.js': `module.exports = require('./leaf')`,
    'bin/leaf.js': `
      const { statSync: stat } = require('fs');
      function go() { return stat('.'); }
      module.exports = { go };
    `,
  });
  assert.deepEqual(analysis.sinks.map((item) => item.operation).sort(), [
    'Atomics.wait', 'child_process.spawnSync', 'fs.accessSync', 'fs.chmodSync', 'fs.copyFileSync', 'fs.fdatasyncSync', 'fs.mkdtempSync', 'fs.openSync', 'fs.readFileSync', 'fs.realpathSync', 'fs.statSync',
  ]);
  assert.ok(analysis.edges.some((edge) => edge.caller.endsWith('::routes') && edge.callee.endsWith('::go')));
});

test('an unresolved property assignment of a blocking capability fails closed', () => {
  const analysis = analyzeFixture({
    'bin/serve/routes.js': `
      const fs = require('node:fs');
      const io = {};
      const operation = 'read';
      io[operation] = fs.readFileSync;
      function routes() { return 1; }
      module.exports = { routes };
    `,
  });
  assert.ok(analysis.unresolved.some((item) => item.reason === 'unresolved property assignment of fs.readFileSync'), analysis.unresolved);
  assert.ok(comparePolicy(analysis, manifestFrom({ ...analysis, unresolved: [] }))
    .some((item) => item.includes('new unresolved call') && item.includes('fs.readFileSync')));
});

test('a new route path to a pre-existing blocking helper fails the ratchet', () => {
  fixture({
    'bin/serve/routes.js': `
      const helper = require('../helper');
      function routes() { return helper.safe(); }
      module.exports = { routes };
    `,
    'bin/helper.js': `
      const fs = require('node:fs');
      function safe() { return 1; }
      function blocking() { return fs.readFileSync('large'); }
      module.exports = { safe, blocking };
    `,
  }, (root) => {
    const first = createAnalyzer(root).run(['bin/serve/routes.js']);
    const manifest = manifestFrom(first);
    assert.deepEqual(comparePolicy(first, manifest), []);
    fs.writeFileSync(path.join(root, 'bin/serve/routes.js'), `
      const helper = require('../helper');
      function routes() { return helper.blocking(); }
      module.exports = { routes };
    `);
    const regressed = createAnalyzer(root).run(['bin/serve/routes.js']);
    const problems = comparePolicy(regressed, manifest);
    assert.ok(problems.some((item) => item.includes('new direct sink') && item.includes('fs.readFileSync')), problems.join('\n'));
    assert.ok(problems.some((item) => item.includes('new blocking call edge') && item.includes('routes') && item.includes('blocking')), problems.join('\n'));
  });
});

test('a second call to an already-reached blocking helper fails the edge count', () => {
  fixture({
    'bin/serve/schedulers.js': `
      const helper = require('../helper');
      function startSchedulers() { helper.blocking(); }
      module.exports = { startSchedulers };
    `,
    'bin/helper.js': `
      const { readFileSync } = require('node:fs');
      function blocking() { return readFileSync('large'); }
      module.exports = { blocking };
    `,
  }, (root) => {
    const first = createAnalyzer(root).run(['bin/serve/schedulers.js']);
    const manifest = manifestFrom(first);
    fs.writeFileSync(path.join(root, 'bin/serve/schedulers.js'), `
      const helper = require('../helper');
      function startSchedulers() { helper.blocking(); helper.blocking(); }
      module.exports = { startSchedulers };
    `);
    const problems = comparePolicy(createAnalyzer(root).run(['bin/serve/schedulers.js']), manifest);
    assert.ok(problems.some((item) => item.includes('new blocking call edge') && item.endsWith('|2')), problems.join('\n'));
    assert.ok(problems.some((item) => item.includes('stale blocking-edge debt') && item.endsWith('|1')), problems.join('\n'));
  });
});

test('higher-order calls and bound aliases cannot hide blocking capabilities', () => {
  const analysis = analyzeFixture({
    'bin/serve/routes.js': `
      const fs = require('node:fs');
      const helper = require('../helper');
      const read = fs.readFileSync.bind(fs);
      function invoke(fn) { return fn('file'); }
      function routes() { read('one'); invoke(fs.readFileSync); [1].map(helper.blocking); }
      module.exports = { routes };
    `,
    'bin/helper.js': `
      const fs = require('node:fs');
      function blocking() { return fs.statSync('file'); }
      module.exports = { blocking };
    `,
  });
  const read = analysis.sinks.find((sink) => sink.operation === 'fs.readFileSync');
  assert.equal(read.count, 2, JSON.stringify(analysis.sinks));
  assert.ok(analysis.edges.some((edge) => edge.caller.endsWith('::routes') && edge.callee.endsWith('::blocking')),
    JSON.stringify(analysis.edges));
});

test('call and apply invoke direct sinks and every selected helper capability', () => {
  const analysis = analyzeFixture({
    'bin/serve/routes.js': `
      const fs = require('node:fs');
      const helper = require('../helper');
      function routes() {
        fs.readFileSync.call(fs, 'one');
        fs.statSync.apply(fs, ['two']);
        (helper.safe || helper.blocking).call(helper, 'three');
      }
      module.exports = { routes };
    `,
    'bin/helper.js': `
      const fs = require('node:fs');
      function safe() { return true; }
      function blocking() { return fs.realpathSync('file'); }
      module.exports = { safe, blocking };
    `,
  });
  assert.deepEqual(analysis.sinks.map((sink) => sink.operation).sort(), [
    'fs.readFileSync', 'fs.realpathSync', 'fs.statSync',
  ]);
  assert.ok(analysis.edges.some((edge) => edge.caller.endsWith('::routes') && edge.callee.endsWith('::blocking')),
    JSON.stringify(analysis.edges));
});

test('a Worker launch is a boundary but directly requiring its child is not', () => {
  const analysis = analyzeFixture({
    'bin/serve/routes.js': `
      const path = require('node:path');
      const { Worker } = require('node:worker_threads');
      function routes() { return new Worker(path.join(__dirname, '../dashboard-build-worker.js')); }
      module.exports = { routes };
    `,
    'bin/dashboard-build-worker.js': `
      const fs = require('node:fs');
      function run() { return fs.readFileSync('large'); }
      module.exports = { run };
    `,
  });
  assert.deepEqual(analysis.sinks, []);
  assert.equal(analysis.reachable.some((name) => name.includes('dashboard-build-worker')), false);

  const direct = analyzeFixture({
    'bin/serve/routes.js': `
      const worker = require('../dashboard-build-worker');
      function routes() { return worker.run(); }
      module.exports = { routes };
    `,
    'bin/dashboard-build-worker.js': `
      const fs = require('node:fs');
      function run() { return fs.readFileSync('large'); }
      module.exports = { run };
    `,
  });
  assert.ok(direct.sinks.some((sink) => sink.operation === 'fs.readFileSync'), JSON.stringify(direct.sinks));
  assert.ok(direct.edges.some((edge) => edge.caller.endsWith('::routes') && edge.callee.endsWith('::run')),
    JSON.stringify(direct.edges));
});

test('new computed dispatch fails closed and stale debt cannot linger', () => {
  const analysis = analyzeFixture({
    'bin/serve/routes.js': `
      const handlers = { a() {} };
      function routes(name) { return handlers[name](); }
      module.exports = { routes };
    `,
  });
  const problems = comparePolicy(analysis, { version: 1, sinks: [], edges: [], unresolved: [] });
  assert.ok(problems.some((item) => item.includes('new unresolved call')), problems.join('\n'));
  const manifest = manifestFrom(analysis);
  assert.deepEqual(comparePolicy(analysis, manifest), []);
  const clean = analyzeFixture({
    'bin/serve/routes.js': `function routes() { return 1; } module.exports = { routes };`,
  });
  assert.ok(comparePolicy(clean, manifest).some((item) => item.includes('stale unresolved-call debt')));
});

test('review queue HEAD lookup is asynchronous, shares in-flight work, and caches failures', async () => {
  const { headShaCached } = require('./review.js');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-review-head-'));
  try {
    let calls = 0;
    const run = (_command, _args, options, callback) => {
      calls += 1;
      assert.equal(options.timeout, 10e3);
      setImmediate(() => callback(null, 'abc123\n'));
    };
    const cache = new Map();
    assert.deepEqual(await Promise.all([
      headShaCached(project, cache, run),
      headShaCached(project, cache, run),
    ]), ['abc123', 'abc123']);
    assert.equal(calls, 1);

    const failed = new Map();
    const fail = (_command, _args, _options, callback) => {
      calls += 1;
      setImmediate(() => callback(new Error('not a repository'), ''));
    };
    assert.equal(await headShaCached(project, failed, fail), '');
    assert.equal(await headShaCached(project, failed, fail), '');
    assert.equal(calls, 2, 'the rejected lookup is cached as an empty result');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('review Git state is available through the daemon read worker boundary', async (t) => {
  const { createDaemonReadWorker } = require('./daemon-read-worker.js');
  const worker = createDaemonReadWorker({ timeoutMs: 30e3 });
  t.after(() => worker.close());
  const state = await worker.run('review-git-state', { project: ROOT, priorSha: '' }, {
    key: `review-git-state:test:${Date.now()}`,
  });
  assert.equal(state.available, true);
  assert.equal(typeof state.head, 'string');
  assert.equal(typeof state.status, 'string');
});
