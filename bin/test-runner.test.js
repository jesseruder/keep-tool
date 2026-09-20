'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveConcurrency, buildArgs, DEFAULT_MAX } = require('../scripts/test-runner.cjs');

const runner = path.join(__dirname, '..', 'scripts', 'test-runner.cjs');

// A nested `node --test` inherits this test's own runner context and reports back to
// it in the child protocol instead of printing. These runs are their own suites.
function env(extra = {}) {
  const copy = { ...process.env, ...extra };
  delete copy.NODE_TEST_CONTEXT;
  return copy;
}

test('the default caps concurrency at half the machine', () => {
  const at = (parallelism) => resolveConcurrency({ env: {}, argv: [], parallelism });
  assert.deepEqual(at(8), { mode: 'fixed', concurrency: 4, source: 'default cap' });
  assert.equal(at(4).concurrency, 2);
  assert.equal(at(2).concurrency, 1);
  assert.equal(at(1).concurrency, 1, 'a single core still runs the suite');
  assert.equal(at(64).concurrency, DEFAULT_MAX, 'a big machine does not lift the cap');
  assert.equal(at(0).concurrency, 1, 'an unreadable core count is not a reason to fan out');
});

test('KEEP_TEST_CONCURRENCY overrides the cap in both directions', () => {
  assert.equal(resolveConcurrency({ env: { KEEP_TEST_CONCURRENCY: '16' }, argv: [], parallelism: 8 }).concurrency, 16);
  assert.equal(resolveConcurrency({ env: { KEEP_TEST_CONCURRENCY: ' 1 ' }, argv: [], parallelism: 8 }).concurrency, 1);
  assert.equal(resolveConcurrency({ env: { KEEP_TEST_CONCURRENCY: 'auto' }, argv: [], parallelism: 8 }).mode, 'node');
  assert.equal(resolveConcurrency({ env: { KEEP_TEST_CONCURRENCY: '' }, argv: [], parallelism: 8 }).source, 'default cap');
});

test('a nonsense override is refused rather than silently ignored', () => {
  for (const raw of ['0', '-2', '2.5', 'many']) {
    assert.equal(resolveConcurrency({ env: { KEEP_TEST_CONCURRENCY: raw }, argv: [], parallelism: 8 }).mode, 'invalid', raw);
  }
  const result = spawnSync(process.execPath, [runner, 'bin/pressure.test.js'],
    { env: env({ KEEP_TEST_CONCURRENCY: 'many' }), encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /KEEP_TEST_CONCURRENCY must be a positive integer/);
});

test('an explicit --test-concurrency in the arguments wins', () => {
  for (const argv of [['--test-concurrency=3', 'bin/a.test.js'], ['--test-concurrency', '3', 'bin/a.test.js']]) {
    const decision = resolveConcurrency({ env: { KEEP_TEST_CONCURRENCY: '9' }, argv, parallelism: 8 });
    assert.deepEqual(decision, { mode: 'argv' });
    assert.deepEqual(buildArgs(decision, argv, '/env.cjs'), ['--require', '/env.cjs', '--test', ...argv]);
  }
});

test('the test environment and the caller arguments both reach Node', () => {
  const argv = ['--test-reporter=tap', 'bin/a.test.js', 'web/app/b.test.js'];
  assert.deepEqual(buildArgs({ mode: 'fixed', concurrency: 4 }, argv, '/env.cjs'),
    ['--require', '/env.cjs', '--test', '--test-concurrency=4', ...argv]);
  assert.deepEqual(buildArgs({ mode: 'node' }, argv, '/env.cjs'),
    ['--require', '/env.cjs', '--test', ...argv]);
});

// The runner is a wrapper around the real suite, so what matters end to end is that
// it still loads the registry-isolating environment and still fails when tests fail.
test('running through the wrapper isolates the registry and preserves the exit code', () => {
  const fixture = path.join(__dirname, 'fixtures', 'test-runner');
  const pass = spawnSync(process.execPath, [runner, path.join(fixture, 'passing.test.js')],
    { env: env({ KEEP_TEST_CONCURRENCY: '1' }), encoding: 'utf8' });
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stderr, /test concurrency 1 \(KEEP_TEST_CONCURRENCY/);
  assert.match(pass.stdout, /keep dir is isolated/);

  const fail = spawnSync(process.execPath, [runner, path.join(fixture, 'failing.test.js')],
    { env: env({ KEEP_TEST_CONCURRENCY: '1' }), encoding: 'utf8' });
  assert.equal(fail.status, 1, 'a failing suite must still fail through the wrapper');
});

// Ctrl-C on a running suite has to reach the tests and come back as a failure, not
// as a wrapper that exits cleanly while test processes keep going. Node's own runner
// turns SIGINT into a cancelled run and exit code 1; the wrapper relays that verbatim
// (and re-raises the signal for a child that dies by one, which nothing here can send
// without racing for the grandchild's pid).
test('an interrupt stops the suite and is reported as a failure', async () => {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, [runner, path.join(__dirname, 'fixtures', 'test-runner', 'slow.test.js')],
    { env: env({ KEEP_TEST_CONCURRENCY: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
  const ended = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the fixture suite never started')), 20_000);
    child.stdout.on('data', (chunk) => {
      if (!String(chunk).includes('fixture running')) return;
      clearTimeout(timer);
      resolve();
    });
  });
  child.kill('SIGINT');
  let guard;
  const stopped = await Promise.race([ended,
    new Promise((resolve) => { guard = setTimeout(() => resolve({ timedOut: true }), 15_000); })]);
  clearTimeout(guard);
  assert.equal(stopped.timedOut, undefined, 'the interrupt never reached the suite');
  assert.ok(stopped.signal || stopped.code !== 0, `interrupt reported success: ${JSON.stringify(stopped)}`);
});

test('the runner is the command the suite actually runs', () => {
  const pkg = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  for (const name of ['test', 'test:reliability', 'test:reliability:browser']) {
    assert.match(pkg.scripts[name], /node scripts\/test-runner\.cjs /, name);
  }
  // The wrapper owns --require now; a second copy in a script would double-load it.
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /scripts\/test-env\.cjs/);
});
