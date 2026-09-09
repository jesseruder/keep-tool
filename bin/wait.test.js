'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const keep = require('./keep.js');
const { evaluate, parseWaitArgs, run } = require('./wait.js');

function baseDeps(overrides = {}) {
  return {
    now: () => 1000,
    resolveProject: (project) => `/${project}`,
    activeHolds: () => [],
    loadTaskAnywhere: (id) => ({ id, fm: { status: 'active' }, body: '' }),
    dependencyResolved: keep.dependencyResolved,
    loadSteps: (project) => ({ project, steps: { deploy: {} } }),
    loadLedger: () => ({ runs: [], waiters: [] }),
    ...overrides,
  };
}

test('evaluate requires every condition and reuses injected state readers', () => {
  const conditions = parseWaitArgs([
    '--no-hold', 'app', '--card', 'upstream', '--lane', 'app', 'deploy', '--check-due', 'scheduled',
  ]).conditions;
  const state = evaluate(conditions, baseDeps({
    loadTaskAnywhere: (id) => id === 'scheduled'
      ? { id, fm: { check_after: '1970-01-01T00:00:00Z' }, body: '' }
      : { id, fm: { status: 'done' }, body: '' },
  }));
  assert.equal(state.satisfied, true);
  assert.equal(state.open.length, 0);

  const held = evaluate(conditions, baseDeps({
    activeHolds: (project) => project === '/app' ? [{}] : [],
    loadTaskAnywhere: (id) => id === 'scheduled'
      ? { id, fm: { check_after: '1970-01-01T00:00:00Z' }, body: '' }
      : { id, fm: { status: 'done' }, body: '' },
  }));
  assert.equal(held.satisfied, false);
  assert.match(held.open[0], /1 active hold/);
});

test('--for expiry exits 124 without real waiting', async () => {
  let now = 0;
  const output = [];
  const code = await run(['--card', 'open', '--for', '2s', '--interval', '1'], baseDeps({
    now: () => now,
    sleep: async (ms) => { now += ms; },
    stdout: (line) => output.push(line),
    stderr: (line) => assert.fail(line),
    signals: false,
  }));
  assert.equal(code, 124);
  assert.deepEqual(output, ['still waiting: --card open']);
});

test('a hold released during polling satisfies the wait', async () => {
  let now = 0;
  let held = true;
  const output = [];
  const code = await run(['--no-hold', 'app', '--for', '1m', '--interval', '10'], baseDeps({
    now: () => now,
    activeHolds: () => held ? [{ id: 'hold-one' }] : [],
    sleep: async (ms) => { now += ms; held = false; },
    stdout: (line) => output.push(line),
    stderr: (line) => assert.fail(line),
    signals: false,
    stamp: (ms) => `stamp-${ms}`,
  }));
  assert.equal(code, 0);
  assert.deepEqual(output, ['satisfied: --no-hold app at stamp-10000']);
});

test('card#n is satisfied when that plan step is done', () => {
  const condition = parseWaitArgs(['--card', 'rollout#2']).conditions;
  const state = evaluate(condition, baseDeps({
    loadTaskAnywhere: () => ({
      fm: { status: 'active' },
      body: '## Plan\n- [x] prepare\n- [x] deploy\n- [ ] observe\n',
    }),
  }));
  assert.equal(state.satisfied, true);
});

test('a bad card exits 2', async () => {
  const errors = [];
  const code = await run(['--card', 'missing'], baseDeps({
    loadTaskAnywhere: () => { throw new Error('no task "missing"'); },
    stdout: (line) => assert.fail(line),
    stderr: (line) => errors.push(line),
    signals: false,
  }));
  assert.equal(code, 2);
  assert.deepEqual(errors, ['no task "missing"']);
});
