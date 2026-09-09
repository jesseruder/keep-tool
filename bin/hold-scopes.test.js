'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const scopes = require('./hold-scopes');
const keep = require('./keep.js');
const wait = require('./wait');

test('resource overlap is exact; legacy and malformed scopes fail closed', () => {
  assert.equal(scopes.overlaps({ scopes: ['sandbox-hosts'] }, ['browser-hosts']), false);
  assert.equal(scopes.overlaps({ scopes: ['sandbox-hosts', 'terraform'] }, ['browser-hosts', 'terraform']), true);
  assert.equal(scopes.overlaps({}, ['browser-hosts']), true);
  assert.equal(scopes.overlaps({ scopes: [''] }, ['browser-hosts']), true);
  for (const value of [false, 123, [null], {}]) assert.equal(scopes.overlaps({ scopes: value }, ['browser-hosts']), true);
  assert.equal(scopes.overlaps({ scopes: ['browser-hosts'] }, []), true);
  assert.deepEqual(scopes.parse(['browser-hosts,terraform', 'terraform']), ['browser-hosts', 'terraform']);
  assert.throws(() => scopes.parse(['Browser Hosts']));
  assert.throws(() => scopes.parse(['']));
});

test('scoped waits filter real holds without ignoring project-wide holds', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-scopes-'));
  const dir = path.join(root, '.keep', 'holds'); fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const write = (id, extra) => fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, project: '/project', until: new Date(now + 60000).toISOString(), ...extra }));
  const deps = { now: () => now, resolveProject: (p) => p, activeHolds: (p, n, o) => keep.activeHolds(p, n, { ...o, root }) };
  try {
    write('hold-sandbox', { scopes: ['sandbox-hosts', 'terraform'] });
    const c = wait.parseWaitArgs(['--no-hold', '/project', '--scope', 'browser-hosts']).conditions;
    assert.equal(wait.evaluate(c, deps).satisfied, true);
    assert.equal(wait.evaluate(wait.parseWaitArgs(['--no-hold', '/project', '--scope', 'browser-hosts,terraform']).conditions, deps).satisfied, false);
    write('hold-legacy', {});
    assert.equal(wait.evaluate(c, deps).satisfied, false);
    assert.throws(() => wait.parseWaitArgs(['--scope', 'browser-hosts', '--no-hold', '/project']));
    assert.throws(() => wait.parseWaitArgs(['--card', 'task', '--scope', 'browser-hosts']));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('hold CLI persists resource scopes and wait CLI isolates unrelated resources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-scope-cli-'));
  fs.mkdirSync(path.join(root, 'tasks'));
  const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' };
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), ...args], { env, encoding: 'utf8' });
  try {
    const held = cli('hold', root, '--for', '+15m', '--scope', 'sandbox-hosts', '--scope', 'terraform', '-m', 'isolated test');
    assert.equal(held.status, 0, held.stderr);
    const holds = keep.activeHolds(root, Date.now(), { root });
    assert.deepEqual(holds[0].scopes, ['sandbox-hosts', 'terraform']);
    assert.equal(cli('wait', '--no-hold', root, '--scope', 'browser-hosts', '--for', '0s').status, 0);
    assert.equal(cli('wait', '--no-hold', root, '--scope', 'terraform', '--for', '0s').status, 124);
    assert.equal(cli('wait', '--no-hold', root, '--for', '0s').status, 124);
    assert.match(cli('holds').stdout, /sandbox-hosts, terraform/);
    assert.notEqual(cli('hold', root, '--for', '+15m', '--scope', '', '-m', 'invalid').status, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
