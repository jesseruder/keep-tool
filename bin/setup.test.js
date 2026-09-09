'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('./config');
const setup = require('./setup');
const { inspect } = require('../scripts/check-public.cjs');

test('configuration respects explicit environment and isolates explicit registries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-config-test-'));
  try {
    const file = path.join(root, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, dataDir: root, env: { KEEP_PORT: 8888 } }));
    const env = { KEEP_CONFIG: file, KEEP_PORT: '9999' };
    config.apply(env);
    assert.equal(env.KEEP_PORT, '9999');
    assert.equal(env.KEEP_DIR, root);
    const isolated = { KEEP_DIR: root };
    assert.deepEqual(config.apply(isolated), {});
    fs.writeFileSync(file, JSON.stringify({ version: 1, env: { KEEP_ALLOW_PUSH: '1' } }));
    assert.throws(() => config.apply({ KEEP_CONFIG: file }), /unsupported/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fresh initialization supports the full task lifecycle without a source checkout or remote in its registry', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-setup-test-'));
  const root = path.join(tmp, 'private registry');
  const env = { ...process.env, KEEP_CONFIG: path.join(tmp, 'config.json'), KEEP_NO_PUSH: '1',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Keep Test',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'keep@example.test' };
  delete env.KEEP_DIR;
  for (const key of Object.keys(env)) if (/^(?:KEEP_REVIEWER|CODEX_(?:THREAD_ID|SESSION_ID)|CLAUDE_CODE_SESSION_ID)/.test(key)) delete env[key];
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), ...args], { env, encoding: 'utf8', timeout: 15000 });
  const ok = (...args) => { const result = cli(...args); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  try {
    ok('init', '--dir', root);
    assert.equal(fs.statSync(env.KEEP_CONFIG).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(root, 'bin')), false);
    ok('add', 'Synthetic task', '--project', root, '--tag', 'personal');
    ok('checkin', 'synthetic-task', '-m', 'Ready for verification.');
    assert.match(ok('list'), /Synthetic task/);
    ok('done', 'synthetic-task', '--next', 'nothing', '-m', 'Complete.');
    const git = (...args) => spawnSync('git', ['-C', root, ...args], { env, encoding: 'utf8' }).stdout.trim();
    assert.equal(git('remote'), '');
    assert.equal(git('rev-list', '--count', 'HEAD'), '4');
    assert.notEqual(cli('init', '--dir', root).status, 0, 'init must not overwrite existing data');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('initialization refuses to put private registry data in the public source checkout', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-init-refuse-'));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'init', '--dir', path.join(__dirname, '..', 'private-data')], {
      env: { ...process.env, KEEP_CONFIG: path.join(tmp, 'config.json') }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside the application checkout/);
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'private-data')), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('hook merging preserves unrelated hooks and is idempotent', () => {
  const input = { enabledPlugins: { example: true }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-stop' }] }] } };
  const next = setup.mergeHooks(input, "'/path with spaces/keep'");
  assert.deepEqual(next.enabledPlugins, input.enabledPlugins);
  assert.equal(next.hooks.Stop[0].hooks[0].command, 'existing-stop');
  assert.equal(input.hooks.Stop.length, 1);
  assert.deepEqual(setup.mergeHooks(next, "'/path with spaces/keep'"), next);
});

test('service definitions escape user paths and pin Node and registry independently', () => {
  const text = setup.servicePlist('serve', '/tmp/registry & notes', '/tmp/node & tools');
  assert.match(text, /registry &amp; notes/);
  assert.match(text, /KEEP_NODE/);
  assert.match(text, /KEEP_DIR/);
  assert.match(text, /KEEP_CONFIG/);
});

test('public guard rejects forced-in cards and credential-shaped content without printing secrets', () => {
  assert.deepEqual(inspect('tasks/private.md', Buffer.from('private')), ['excluded path']);
  assert.deepEqual(inspect('docs/copied-card.md', Buffer.from('---\ntitle: Private task\nstatus: active\n---\n')), ['task card frontmatter']);
  assert.deepEqual(inspect('watch/slack.json', Buffer.from('{}')), ['excluded path']);
  assert.deepEqual(inspect('bin/credential.js', Buffer.from('ghp_' + 'a'.repeat(36))), ['credential-shaped content']);
  assert.deepEqual(inspect('bin/example.test.js', Buffer.from('const token = "synthetic";')), []);
});


test('source containment resolves symlink ancestors before creating a registry', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-init-symlink-'));
  const alias = path.join(tmp, 'source-alias');
  try {
    fs.symlinkSync(path.resolve(__dirname, '..'), alias);
    assert.equal(setup.insideSource(path.join(alias, 'web', 'private-registry')), true);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'init', '--dir', path.join(alias, 'web', 'private-registry')], {
      env: { ...process.env, KEEP_CONFIG: path.join(tmp, 'config.json') }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside the application checkout/);
    assert.equal(fs.existsSync(path.join(alias, 'web', 'private-registry')), false);
    for (const name of ['web/private/.keep/token', 'docs/backup/tasks/a.md', 'web/nested/reviews/day.md', 'bin/nested/watch/slack.json']) {
      assert.deepEqual(inspect(name, Buffer.from('synthetic')), ['excluded path']);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('configuration paths embedded in hooks and services are absolute', () => {
  assert.equal(config.configFile({ KEEP_CONFIG: './settings.json' }), path.resolve('settings.json'));
  const prior = process.env.KEEP_CONFIG;
  try {
    process.env.KEEP_CONFIG = './settings.json';
    assert.ok(setup.servicePlist('serve', '/tmp/registry').includes(path.resolve('settings.json')));
  } finally {
    if (prior === undefined) delete process.env.KEEP_CONFIG;
    else process.env.KEEP_CONFIG = prior;
  }
});


test('local-only Git identity cannot leave a partially initialized registry', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-init-identity-'));
  const caller = path.join(tmp, 'caller');
  const registry = path.join(tmp, 'registry');
  const file = path.join(tmp, 'config.json');
  const env = { ...process.env, KEEP_CONFIG: file, GIT_CONFIG_GLOBAL: path.join(tmp, 'no-global'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' };
  delete env.KEEP_DIR;
  const run = (args) => spawnSync('git', ['-C', caller, ...args], { env, encoding: 'utf8' });
  try {
    fs.mkdirSync(caller);
    assert.equal(run(['init', '-q']).status, 0);
    assert.equal(run(['config', 'user.name', 'Caller Only']).status, 0);
    assert.equal(run(['config', 'user.email', 'caller@example.test']).status, 0);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'init', '--dir', registry], { cwd: caller, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /configure git user.name/);
    assert.equal(fs.existsSync(registry), false);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readdirSync(tmp).some((name) => name.startsWith('.keep-init-')), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
