'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const features = require('./features.js');
const { startFeatureSchedulers } = require('./serve/schedulers.js');

function withEnv(values, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return fn(); } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('an absent switch is on, so a configuration written before this key keeps every feature', () => {
  for (const name of Object.keys(features.FEATURES)) {
    assert.equal(features.enabled(name, {}), true, name);
    assert.equal(features.enabled(name, { version: 1 }), true, name);
    assert.equal(features.enabled(name, { version: 1, features: {} }), true, name);
  }
});

test('only an explicit false switches a feature off', () => {
  const config = { version: 1, features: { standup: false, ideas: true, slack: 0, discord: null } };
  assert.equal(features.enabled('standup', config), false);
  assert.equal(features.enabled('ideas', config), true);
  // Anything that is not `false` is on: a switch is a boolean, and a typo must
  // not quietly disable a feature the operator meant to keep.
  assert.equal(features.enabled('slack', config), true);
  assert.equal(features.enabled('discord', config), true);
});

test('an unknown feature is a programming error, not a silent "off"', () => {
  assert.throws(() => features.enabled('telepathy', {}), /unknown feature: telepathy/);
  assert.throws(() => features.load('telepathy'), /unknown feature: telepathy/);
  assert.throws(() => features.offMessage('telepathy'), /unknown feature: telepathy/);
});

test('list reports every feature with its description and switch', () => {
  const rows = features.list({ version: 1, features: { standup: false, slack: false } });
  assert.deepEqual(rows.map((row) => [row.name, row.enabled]), [
    ['standup', false], ['ideas', true], ['slack', false], ['discord', true],
  ]);
  for (const row of rows) assert.equal(typeof row.description, 'string');
  assert.ok(rows.every((row) => row.description.length));
});

test('KEEP_FEATURES overrides the configuration file, and unparseable values read as all on', () => {
  withEnv({ KEEP_FEATURES: '{"ideas":false,"slack":false}' }, () => {
    assert.equal(features.enabled('ideas'), false);
    assert.equal(features.enabled('slack'), false);
    assert.equal(features.enabled('standup'), true);
    assert.deepEqual(features.list().filter((row) => !row.enabled).map((row) => row.name), ['ideas', 'slack']);
    // An explicit configuration argument still wins: the caller has already read
    // the file it means.
    assert.equal(features.enabled('ideas', { version: 1, features: {} }), true);
  });
  for (const bad of ['not json', '[]', 'null', '"off"']) {
    withEnv({ KEEP_FEATURES: bad }, () => {
      assert.equal(features.enabled('slack'), true, bad);
    });
  }
});

test('an isolated registry reads no switches from another registry configuration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-features-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, features: { ideas: false } }));
    assert.deepEqual(features.switches(undefined, { KEEP_CONFIG: file }), { ideas: false });
    // KEEP_DIR without KEEP_CONFIG is an explicit, isolated registry.
    assert.deepEqual(features.switches(undefined, { KEEP_DIR: dir }), {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('config.apply projects the features key into the environment like scopes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-features-apply-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, features: { standup: false } }));
    const env = { KEEP_CONFIG: file };
    const value = require('./config.js').apply(env);
    assert.deepEqual(value.features, { standup: false });
    assert.equal(env.KEEP_FEATURES, '{"standup":false}');
    assert.equal(features.enabled('standup', value), false);
    // A child started with this environment reaches the same answer with no file.
    assert.deepEqual(features.switches(undefined, env), { standup: false });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an off feature reports the state its module reports when it has nothing', () => {
  const off = { version: 1, features: { standup: false, slack: false, discord: false } };
  const boom = () => { throw new Error('an off feature must not read its own state'); };
  assert.equal(features.dashboardState('standup', boom, off), null);
  assert.deepEqual(features.dashboardState('slack', boom, off), { mode: 'log', lastPollAt: null, recent: [] });
  assert.deepEqual(features.dashboardState('discord', boom, off), { enabled: false, counts: {}, recent: [] });
  // Each call gets its own object: the console mutates nothing, but a shared one
  // would make a later change to one response visible in every other.
  assert.notEqual(features.dashboardState('slack', boom, off), features.dashboardState('slack', boom, off));
  assert.equal(features.dashboardState('standup', () => 'live', { version: 1 }), 'live');
});

test('startFeatureSchedulers starts only the features that are on', () => {
  const started = [];
  const fake = (name) => ({ startScheduler: (options) => { started.push([name, options]); return { name }; } });
  const options = { onChange: () => {} };
  const result = startFeatureSchedulers(
    { enabled: (name) => name !== 'slack' },
    { slack: fake('slack'), discord: fake('discord') },
    options,
  );
  assert.deepEqual(result, ['discord']);
  assert.deepEqual(started, [['discord', options]]);
});

test('startFeatureSchedulers reads the real registry through the features module', () => {
  withEnv({ KEEP_FEATURES: '{"standup":false}' }, () => {
    const started = [];
    const fake = (name) => ({ startScheduler: () => started.push(name) });
    const result = startFeatureSchedulers(features, { standup: fake('standup'), ideas: fake('ideas') }, {});
    assert.deepEqual(result, ['ideas']);
    assert.deepEqual(started, ['ideas']);
  });
});

test('a command whose feature is off exits 1 and names the file that would turn it on', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-features-cli-'));
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  const env = { ...process.env, KEEP_DIR: root, KEEP_FEATURES: '{"standup":false,"slack":false}' };
  delete env.KEEP_CONFIG;
  for (const key of ['CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID',
    'KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete env[key];
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), ...args],
    { encoding: 'utf8', env, timeout: 20000 });
  try {
    const off = cli('standup');
    assert.equal(off.status, 1, off.stderr);
    assert.match(off.stderr, /^keep: feature standup is off; enable it with "features": \{"standup": true\} in \S/m);
    assert.equal(off.stdout, '');

    // A subcommand is refused before it is parsed, so the message is the same.
    const slack = cli('slack', 'status');
    assert.equal(slack.status, 1, slack.stderr);
    assert.match(slack.stderr, /feature slack is off/);

    // A feature that is on runs its command, which fails on its own terms.
    const on = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'standup', '--show'],
      { encoding: 'utf8', env: { ...env, KEEP_FEATURES: '{"standup":true}' }, timeout: 20000 });
    assert.equal(on.status, 1, on.stderr);
    assert.doesNotMatch(on.stderr, /feature standup is off/);
    assert.match(on.stderr, /no standup\.md yet/);

    // The command is still listed, so an off feature never looks like a typo.
    const help = cli('help');
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /keep standup /);
    assert.match(help.stdout, /optional features; keep doctor lists which are on/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
