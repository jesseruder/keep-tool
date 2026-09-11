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

test('device scopes cross projects; other labels and malformed metadata do not', () => {
  assert.deepEqual(scopes.parse(['device:ABC123,terraform']), ['device:abc123', 'terraform']);
  assert.deepEqual(scopes.devices({ scopes: ['device:abc123', 'user1-sandbox'] }), ['device:abc123']);
  assert.deepEqual(scopes.devices({ scopes: ['device:'] }), []);
  assert.deepEqual(scopes.devices({ scopes: [null] }), []);
  assert.deepEqual(scopes.devices({}), []);
  const hold = { scopes: ['device:abc123', 'user1-sandbox'] };
  assert.equal(scopes.sharesDevice(hold, []), true);
  assert.equal(scopes.sharesDevice(hold, ['device:ABC123']), true);
  assert.equal(scopes.sharesDevice(hold, ['user1-sandbox']), false, "another project's plain label is not ours");
  assert.equal(scopes.sharesDevice(hold, ['device:other']), false);
  assert.equal(scopes.sharesDevice({ scopes: ['user1-sandbox'] }, []), false);
  assert.equal(scopes.sharesDevice({}, []), false);
});

test('activeHolds and waits see other projects only through a device scope', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-device-'));
  const dir = path.join(root, '.keep', 'holds'); fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const write = (id, extra) => fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, until: new Date(now + 60000).toISOString(), ...extra }));
  const ids = (project, options) => keep.activeHolds(project, now, { ...options, root, prune: false }).map((h) => h.id).sort();
  const deps = { now: () => now, resolveProject: (p) => p, activeHolds: (p, n, o) => keep.activeHolds(p, n, { ...o, root }) };
  const free = (...args) => wait.evaluate(wait.parseWaitArgs(['--no-hold', '/client', ...args]).conditions, deps).satisfied;
  try {
    write('hold-pixel', { project: '/sandboxes', scopes: ['device:abc123', 'user1-sandbox'] });
    write('hold-sandbox', { project: '/sandboxes', scopes: ['user1-sandbox'] });
    write('hold-legacy', { project: '/sandboxes' });
    write('hold-step', { project: '/sandboxes', step: 'deploy', scopes: ['device:abc123'] });
    assert.deepEqual(ids('/client'), [], 'default callers stay project-local');
    assert.deepEqual(ids('/client', { devices: true }), ['hold-pixel', 'hold-step']);
    assert.deepEqual(ids('/client', { devices: true, scopes: ['device:abc123'] }), ['hold-pixel', 'hold-step']);
    assert.deepEqual(ids('/client', { devices: true, scopes: ['user1-sandbox'] }), []);
    assert.deepEqual(ids('/client', { devices: true, step: 'deploy' }), [], 'step claims never cross projects');
    assert.deepEqual(ids(null, {}), ['hold-legacy', 'hold-pixel', 'hold-sandbox', 'hold-step']);
    assert.equal(free(), true, 'an unscoped wait ignores devices held elsewhere');
    assert.equal(free('--scope', 'device:ABC123'), false);
    assert.equal(free('--scope', 'device:other'), true);
    assert.equal(free('--scope', 'user1-sandbox'), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('who and session start surface a device held from another project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-device-cli-'));
  fs.mkdirSync(path.join(root, 'tasks'));
  const sandboxes = path.join(root, 'sandboxes'); fs.mkdirSync(sandboxes);
  const client = path.join(root, 'client'); fs.mkdirSync(client);
  const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1', KEEP_PORT: '1' };
  for (const k of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) delete env[k];
  const cli = (args, extra = {}) => spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), ...args], { env, encoding: 'utf8', ...extra });
  const who = (...args) => JSON.parse(cli(['who', client, '--json', ...args]).stdout).holds.map((h) => h.id);
  try {
    const held = cli(['hold', sandboxes, '--for', '+15m', '--scope', 'device:ABC123', '--scope', 'user1-sandbox', '-m', 'pixel timing']);
    assert.equal(held.status, 0, held.stderr);
    const [hold] = keep.activeHolds(sandboxes, Date.now(), { root });
    assert.deepEqual(hold.scopes, ['device:abc123', 'user1-sandbox']);
    assert.deepEqual(who(), [hold.id]);
    assert.deepEqual(who('--scope', 'device:abc123'), [hold.id]);
    assert.deepEqual(who('--scope', 'user1-sandbox'), [], "the other project's sandbox label does not match here");
    assert.match(cli(['who', client]).stdout, new RegExp(`${hold.id} · scope: device:abc123, user1-sandbox · from ${sandboxes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const start = cli(['hook', 'session-start'], { cwd: client, input: JSON.stringify({ session_id: 'session-one', cwd: client }) });
    assert.equal(start.status, 0, start.stderr);
    assert.match(start.stdout, /Shared devices held from other projects:\n⛔ .*\[device:abc123, user1-sandbox\].*pixel timing/);
    assert.doesNotMatch(start.stdout, /Holds on this project/);
    cli(['hold', sandboxes, '--for', '+15m', '--scope', 'user1-sandbox', '-m', 'sandbox only']);
    const again = cli(['hook', 'session-start'], { cwd: client, input: JSON.stringify({ session_id: 'session-two', cwd: client }) });
    assert.doesNotMatch(again.stdout, /sandbox only/);
    const home = cli(['hook', 'session-start'], { cwd: sandboxes, input: JSON.stringify({ session_id: 'session-three', cwd: sandboxes }) });
    assert.match(home.stdout, /Holds on this project:/);
    assert.doesNotMatch(home.stdout, /Shared devices held from other projects/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
