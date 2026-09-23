'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const setup = require('./setup.js');
// Loaded before a test pretends to be Linux: node-pty picks its native build by platform.
require('./host.js');
const keepConsole = require('./console.js');
const { routes, matchRoute, routeDenial } = require('./serve/routes.js');
const nodeApi = require('./serve/node-api.js');
const { createRegistryService } = require('./registry-route.js');

function tempDir(t, prefix = 'keep-node-provision-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function capture(body) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  return Promise.resolve().then(body).finally(() => { console.log = original; }).then(() => lines.join('\n'));
}

function asLinux(t) {
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', { value: platform, configurable: true }));
}

test('keep node init writes KEEP_DAEMON_URL into the host service only when given one', async (t) => {
  asLinux(t);
  const home = tempDir(t);
  const tokenFile = path.join(home, 'node.token');
  fs.writeFileSync(tokenFile, `${'b'.repeat(64)}\n`, { mode: 0o600 });
  const unitFile = path.join(home, '.config', 'systemd', 'user', 'keep-host.service');
  const base = ['init', 'aws1', '--daemon-node', 'main', '--listen', '100.64.0.2:7777', '--token-file', tokenFile, '--sock', path.join(home, 'host.sock')];

  assert.throws(() => setup.node([...base, '--daemon-url', 'https://100.64.0.1:7781'], '/tmp/r', home), /KEEP_DAEMON_URL must be http/);
  assert.throws(() => setup.node([...base, '--daemon-url', 'http://100.64.0.1:7781/api'], '/tmp/r', home), /KEEP_DAEMON_URL must be http/);
  assert.equal(fs.existsSync(unitFile), false, 'nothing is written for a URL the CLI would refuse');

  const output = await capture(() => setup.node([...base, '--daemon-url', 'http://100.64.0.1:7781'], '/tmp/r', home));
  const unit = fs.readFileSync(unitFile, 'utf8');
  assert.ok(unit.includes('Environment=KEEP_DAEMON_URL="http://100.64.0.1:7781"'), unit);
  assert.match(output, /registry commands go to the daemon's node API at http:\/\/100\.64\.0\.1:7781/);

  fs.rmSync(unitFile);
  const plain = await capture(() => setup.node(base, '/tmp/r', home));
  assert.doesNotMatch(fs.readFileSync(unitFile, 'utf8'), /KEEP_DAEMON_URL/);
  assert.doesNotMatch(plain, /node API/);
});

// keep nodes writes config.json and the token directory, so both are temporary.
function withRegistry(t, initial) {
  const root = tempDir(t, 'keep-nodes-provision-');
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify(initial, null, 2)}\n`);
  const previous = { KEEP_CONFIG: process.env.KEEP_CONFIG, KEEP_DIR: process.env.KEEP_DIR };
  process.env.KEEP_CONFIG = configFile;
  process.env.KEEP_DIR = root;
  const core = require('./keep-core.js');
  const previousRoot = core.ROOT;
  Object.defineProperty(core, 'ROOT', { value: root, configurable: true, writable: true });
  t.after(() => {
    Object.defineProperty(core, 'ROOT', { value: previousRoot, configurable: true, writable: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return { root, configFile };
}

test('keep nodes add prints the daemon URL in the init line once the daemon listens for nodes', async (t) => {
  const { commands } = require('./commands/nodes.js');
  withRegistry(t, { version: 1, nodeApi: { listen: '100.64.0.1:7781' } });
  const output = await capture(() => commands.nodes(['add', 'aws1', '--address', '100.64.0.2:7777']));
  assert.match(output, /keep node init aws1 --daemon-node main --listen 100\.64\.0\.2:7777 --token-file ~\/\.keep-node-token --daemon-url http:\/\/100\.64\.0\.1:7781$/m);
});

test('keep nodes add prints the init line it always did without a node API', async (t) => {
  const { commands } = require('./commands/nodes.js');
  withRegistry(t, { version: 1 });
  const output = await capture(() => commands.nodes(['add', 'aws1', '--address', '100.64.0.2:7777']));
  assert.match(output, /keep node init aws1 --daemon-node main --listen 100\.64\.0\.2:7777 --token-file ~\/\.keep-node-token$/m);
  assert.doesNotMatch(output, /daemon-url/);
});

test('keep nodes shows the node API address on the daemon row, and only there', async (t) => {
  const { commands } = require('./commands/nodes.js');
  const nodes = { main: {}, aws1: { transport: 'tcp', address: '100.64.0.2:7777' } };
  const connect = async () => ({ descriptor: { protocol: 3, bootId: 'b', platform: 'linux', home: os.homedir(), panes: 0 }, close() {} });
  withRegistry(t, { version: 1, daemonNode: 'main', nodes, nodeApi: { listen: '100.64.0.1:7781' } });
  const rows = JSON.parse(await capture(() => commands.nodes(['--json'], { connect })));
  assert.equal(rows.find((row) => row.name === 'main').nodeApi, '100.64.0.1:7781');
  assert.equal('nodeApi' in rows.find((row) => row.name === 'aws1'), false);
  const table = await capture(() => commands.nodes(['ls'], { connect }));
  assert.match(table.split('\n').find((line) => line.startsWith('main')), /\(node api 100\.64\.0\.1:7781\)/);

  const plain = await capture(() => commands.nodes(['--json'], { connect, nodeApiListen: () => ({ enabled: false }) }));
  assert.equal(JSON.parse(plain).some((row) => 'nodeApi' in row), false);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// The node listener in front of the real route list, as serve.js assembles it.
async function nodeListener(t) {
  const root = tempDir(t);
  const registryService = createRegistryService({ root, daemonNode: () => 'main', location: () => null, env: { PATH: '/usr/bin', HOME: root } });
  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const list = routes({ json, nodeApiEnabled: () => true, registryService });
  const handler = nodeApi.createNodeApiHandler({
    routes: list, matchRoute, routeDenial, principal: keepConsole.principal, json, log: () => {},
    tokenStore: nodeApi.createNodeTokenStore({ initial: { aws1: 'aws1-secret' }, read: () => ({ aws1: 'aws1-secret' }) }),
    readBody: () => Promise.resolve({}),
  });
  const server = http.createServer(handler);
  const port = await listen(server);
  t.after(() => server.close());
  return `http://127.0.0.1:${port}`;
}

test('the ping route answers a node through the node listener, and nothing else there', async (t) => {
  const url = await nodeListener(t);
  const remote = require('./remote-cli.js');
  const ping = await remote.nodeApiRequest(url, '/api/registry/ping', { method: 'GET', token: 'aws1-secret' });
  assert.equal(ping.status, 200);
  const value = JSON.parse(ping.data);
  assert.equal(value.ok, true);
  assert.equal(value.node, 'aws1');
  assert.equal(value.daemon, 'main');
  assert.ok(Number.isFinite(Date.parse(value.now)));
  assert.equal((await remote.nodeApiRequest(url, '/api/registry/ping', { method: 'GET', token: 'wrong' })).status, 403);
  assert.equal((await remote.nodeApiRequest(url, '/api/state', { method: 'GET', token: 'aws1-secret' })).status, 403,
    'a route that does not allow a node is refused on the node listener');
});

test('doctor reports the node API from the daemon side', async () => {
  let state = null;
  const report = (listen, others = []) => setup.nodeApiReport({
    env: {}, nodeApiListen: () => listen, listNodes: () => [{ name: 'main', daemon: true }, ...others],
    readState: () => state, pidAlive: (pid) => pid === 4242,
  });
  assert.deepEqual(await report({ enabled: false, reason: 'not configured' }), [], 'a single-node install hears nothing about it');
  const on = { enabled: true, listen: '100.64.0.1:7781' };
  // Configured, but the daemon has said nothing: not proof of a bound listener.
  const silent = await report(on);
  assert.equal(silent[0].status, 'optional');
  assert.match(silent[0].text, /configured at 100\.64\.0\.1:7781; the running daemon has not reported binding it/);
  state = { pid: 4242, listen: '100.64.0.1:7781', state: 'listening' };
  assert.deepEqual(await report(on), [{ status: 'ok', text: 'node API listening at 100.64.0.1:7781' }]);
  state = { pid: 4242, listen: '100.64.0.1:7781', state: 'retrying', error: 'listen EADDRNOTAVAIL' };
  const retrying = await report(on);
  assert.equal(retrying[0].status, 'FAIL');
  assert.match(retrying[0].text, /not bound: listen EADDRNOTAVAIL; the daemon keeps retrying/);
  state = { pid: 9999, listen: '100.64.0.1:7781', state: 'listening' };
  assert.equal((await report(on))[0].status, 'optional', 'a record from a daemon that is gone');
  state = { pid: 4242, listen: '100.64.0.1:7790', state: 'listening' };
  assert.equal((await report(on))[0].status, 'optional', 'a record for another address');
  const absent = await report({ enabled: false, reason: 'not configured' }, [{ name: 'aws1', daemon: false }]);
  assert.equal(absent[0].status, 'optional');
  assert.match(absent[0].text, /node API listener absent/);
  const bad = await report({ enabled: false, error: 'refusing to bind 0.0.0.0' });
  assert.equal(bad[0].status, 'FAIL');
  assert.match(bad[0].text, /refusing to bind 0\.0\.0\.0/);
});

test('doctor on a pane-only node says whether KEEP_DAEMON_URL reaches the daemon', async (t) => {
  const url = await nodeListener(t);
  const env = { KEEP_NODE_NAME: 'aws1', KEEP_DAEMON_NODE: 'main', KEEP_NODE_TOKEN_FILE: '/unused' };
  const unset = await setup.nodeApiReport({ env });
  assert.equal(unset[0].status, 'optional');
  assert.match(unset[0].text, /KEEP_DAEMON_URL is not set/);
  const reached = await setup.nodeApiReport({ env: { ...env, KEEP_DAEMON_URL: url }, readToken: () => 'aws1-secret' });
  assert.equal(reached[0].status, 'ok', reached[0].text);
  assert.match(reached[0].text, /^daemon main answers at http:\/\/127\.0\.0\.1:\d+/);
  const refused = await setup.nodeApiReport({ env: { ...env, KEEP_DAEMON_URL: url }, readToken: () => 'wrong' });
  assert.equal(refused[0].status, 'FAIL');
  assert.match(refused[0].text, /refused this node: unauthorized/);
  const misnamed = await setup.nodeApiReport({ env: { ...env, KEEP_NODE_NAME: 'mini', KEEP_DAEMON_URL: url }, readToken: () => 'aws1-secret' });
  assert.equal(misnamed[0].status, 'FAIL');
  assert.match(misnamed[0].text, /answered as main for node aws1, not main for mini/);
  const down = await setup.nodeApiReport({ env: { ...env, KEEP_DAEMON_URL: 'http://127.0.0.1:1' }, readToken: () => 'aws1-secret' });
  assert.equal(down[0].status, 'FAIL');
  assert.match(down[0].text, /does not reach the daemon/);
});

test('doctor reports hook delivery: the queue and cursor on a node, the mirrors on the daemon', (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-hook-doctor-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, KEEP_NODE_NAME: 'aws1', KEEP_DAEMON_NODE: 'main', KEEP_DAEMON_URL: 'http://100.64.0.1:7781' };
  assert.deepEqual(setup.hookDeliveryReport({ env: { ...env, KEEP_DAEMON_URL: '' } }), [], 'nothing to deliver to');
  assert.deepEqual(setup.hookDeliveryReport({ env }), [{ status: 'ok', text: 'hook queue empty; no transcript cursors yet' }]);
  const client = require('./hook-client.js');
  fs.mkdirSync(path.join(home, '.keep-node', 'mirror'), { recursive: true });
  fs.writeFileSync(path.join(home, '.keep-node', 'mirror', 'older.json'), JSON.stringify({ generation: 'g', sent: 5 }));
  fs.utimesSync(path.join(home, '.keep-node', 'mirror', 'older.json'), new Date(1_600_000_000_000), new Date(1_600_000_000_000));
  fs.writeFileSync(path.join(home, '.keep-node', 'mirror', 'sess-new.json'), JSON.stringify({ generation: 'g', sent: 1234 }));
  fs.utimesSync(path.join(home, '.keep-node', 'mirror', 'sess-new.json'), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  client.enqueue(env, { event: 'stop', body: { input: { session_id: 's', cwd: '/x' }, identity: { agent: 'claude', sessionId: 's' }, idempotencyKey: 'k-00000000000000001' } });
  client.enqueue(env, { event: 'notification', body: { input: { session_id: 's', cwd: '/x' }, identity: { agent: 'claude', sessionId: 's' }, idempotencyKey: 'k-00000000000000002' } });
  const [queued] = setup.hookDeliveryReport({ env });
  assert.equal(queued.status, 'optional');
  assert.equal(queued.text, 'hook queue: 2 event(s) waiting for main; newest transcript cursor: session sess-new at 1234 bytes, 2023-11-14T22:13:20.000Z');

  // The daemon side: nothing without a node API, then bytes per node.
  const root = path.join(home, 'registry');
  const daemonEnv = { KEEP_NODE_NAME: 'main', KEEP_DAEMON_NODE: 'main' };
  assert.deepEqual(setup.hookDeliveryReport({ env: daemonEnv, root, nodeApiListen: () => ({ enabled: false }) }), []);
  const on = () => ({ enabled: true, listen: '100.64.0.1:7781' });
  assert.deepEqual(setup.hookDeliveryReport({ env: daemonEnv, root, nodeApiListen: on }), [{ status: 'ok', text: 'transcript mirrors: none yet' }]);
  require('./transcript-mirror.js').append({ root, node: 'aws1', sessionId: 'sess-1', generation: 'g', fromOffset: 0,
    bytes: Buffer.alloc(3 * 1024 * 1024, 0x61), size: 3 * 1024 * 1024, mtimeMs: 1_700_000_000_000, sourcePath: '/home/node/t.jsonl' });
  const [mirrors] = setup.hookDeliveryReport({ env: daemonEnv, root, nodeApiListen: on });
  assert.equal(mirrors.status, 'ok');
  assert.equal(mirrors.text, 'transcript mirrors: aws1 3.0 MiB in 1 mirror(s)');
});

test('doctor on a node checks every Codex profile\'s hooks against this checkout, and says whether lsof is here', (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-doctor-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, KEEP_NODE_NAME: 'aws1', KEEP_DAEMON_NODE: 'main', KEEP_DAEMON_URL: 'http://100.64.0.1:7781' };
  const keepBin = path.join(home, 'keep-tool', 'bin', 'keep');
  fs.mkdirSync(path.dirname(keepBin), { recursive: true });
  fs.writeFileSync(keepBin, '#!/bin/sh\n', { mode: 0o755 });
  const hooks = (bin, actions) => ({ hooks: Object.fromEntries(actions.map((action, n) => [`Event${n}`,
    [{ hooks: [{ type: 'command', command: `${bin} hook codex ${action}`, timeout: 3 }, { type: 'command', command: 'echo unrelated' }] }]])) });
  const all = ['start', 'stop', 'end', 'pre-tool', 'post-tool', 'question', 'approval', 'lifecycle'];
  const profile = (name, value, toml) => {
    const dir = path.join(home, name);
    fs.mkdirSync(dir);
    if (value !== undefined) fs.writeFileSync(path.join(dir, 'hooks.json'), typeof value === 'string' ? value : JSON.stringify(value));
    if (toml !== undefined) fs.writeFileSync(path.join(dir, 'config.toml'), toml);
  };
  const report = (extra = {}) => setup.codexHooksReport({ env, keepBin, hasLsof: () => false, platform: 'linux', ...extra });

  assert.deepEqual(setup.codexHooksReport({ env: { HOME: home, KEEP_NODE_NAME: 'main', KEEP_DAEMON_NODE: 'main' }, keepBin }), [], 'the daemon node\'s profiles are its own');
  assert.deepEqual(report(), [{ status: 'ok', text: 'lsof absent: Codex sessions\' open rollouts are read from /proc' }], 'no Codex here: only the lsof row');

  const trusted = all.flatMap((action, n) => [0, 1].map((index) => `[hooks.state."${home}/.codex/hooks.json:event${n}:0:${index}"]\ntrusted_hash = "h"\n`)).join('\n');
  profile('.codex', hooks(keepBin, all), `model = "x"\n\n[features]\n# on\nhooks = true\n\n[other]\nhooks = false\n\n${trusted}`);
  profile('.codex-secondary', hooks('/opt/elsewhere/keep-tool/bin/keep', all), '[features]\nhooks = true\n');
  profile('.codex-third', hooks(keepBin, ['start', 'stop']), '[features]\nhooks = false\n');
  profile('.codex-fourth', undefined, '[features]\nhooks = true\n');
  profile('.codex-fifth', '{ not json', '');
  profile('.codexy', hooks(keepBin, all), '');
  const rows = report();
  assert.deepEqual(rows.map((row) => [row.status, row.text]), [
    ['ok', `Codex hooks (~/.codex) reach ${keepBin}`],
    ['ok', 'Codex hook trust (~/.codex): all 16 hooks in hooks.json have a trust entry in config.toml (checked by presence, not hash)'],
    ['FAIL', `Codex hooks (~/.codex-fifth): hooks.json unreadable: ${(() => { try { JSON.parse('{ not json'); } catch (error) { return error.message; } })()}; its sessions on aws1 run unguarded and unregistered`],
    ['FAIL', 'Codex hooks (~/.codex-fourth): no hooks.json; its sessions on aws1 run unguarded and unregistered'],
    ['FAIL', `Codex hooks (~/.codex-secondary): commands point at /opt/elsewhere/keep-tool/bin/keep, not this node's ${keepBin}; not wired: ${all.join(', ')}`],
    ['FAIL', 'Codex hook trust (~/.codex-secondary): 16 of 16 hooks in ~/.codex-secondary/hooks.json have no trust entry in config.toml (checked by presence, not hash); a fresh Codex there stops at \'review required\' for each'],
    ['FAIL', `Codex hooks (~/.codex-third): not wired: end, pre-tool, post-tool, question, approval, lifecycle; [features] hooks = true is not set in config.toml`],
    ['FAIL', 'Codex hook trust (~/.codex-third): 4 of 4 hooks in ~/.codex-third/hooks.json have no trust entry in config.toml (checked by presence, not hash); a fresh Codex there stops at \'review required\' for each'],
    ['ok', 'lsof absent: Codex sessions\' open rollouts are read from /proc'],
  ]);
  assert.match(rows[3].fix, /wire keep hook codex <action> to .*keep-tool\/bin\/keep in ~\/\.codex\/hooks\.json/);
  // A link to this checkout is this checkout.
  const linked = path.join(home, 'keep-link');
  fs.symlinkSync(path.join(home, 'keep-tool'), linked);
  assert.equal(report({ keepBin: path.join(linked, 'bin', 'keep') })[0].status, 'ok');
  assert.deepEqual(report({ hasLsof: () => true }).at(-1), { status: 'ok', text: 'lsof present: Codex sessions\' open rollouts are read with it' });
  assert.deepEqual(report({ platform: 'darwin' }).at(-1).status, 'optional');
});

test('doctor on a node counts each Codex hook\'s trust entry in config.toml, by presence', (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-trust-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, KEEP_NODE_NAME: 'aws1', KEEP_DAEMON_NODE: 'main', KEEP_DAEMON_URL: 'http://100.64.0.1:7781' };
  const keepBin = path.join(home, 'keep-tool', 'bin', 'keep');
  fs.mkdirSync(path.dirname(keepBin), { recursive: true });
  fs.writeFileSync(keepBin, '#!/bin/sh\n', { mode: 0o755 });
  const dir = path.join(home, '.codex');
  fs.mkdirSync(dir);
  // Codex's own shape: PascalCase events, two groups on PreToolUse, and a group of two.
  const command = (action) => ({ type: 'command', command: `${keepBin} hook codex ${action}` });
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [command('start')] }],
    Stop: [{ hooks: [command('stop'), { type: 'command', command: 'echo also' }] }],
    SessionEnd: [{ hooks: [command('end')] }],
    PreToolUse: [{ matcher: 'x', hooks: [command('pre-tool')] }, { hooks: [command('approval')] }],
    PostToolUse: [{ hooks: [command('post-tool')] }],
    PermissionRequest: [{ hooks: [command('question')] }],
    UserPromptSubmit: [{ hooks: [command('lifecycle')] }],
  } }));
  const keys = ['session_start:0:0', 'stop:0:0', 'stop:0:1', 'session_end:0:0', 'pre_tool_use:0:0', 'pre_tool_use:1:0',
    'post_tool_use:0:0', 'permission_request:0:0', 'user_prompt_submit:0:0'];
  const table = (prefix, key) => `[hooks.state."${prefix}/hooks.json:${key}"]\ntrusted_hash = "sha256:0"\n`;
  const config = (entries) => fs.writeFileSync(path.join(dir, 'config.toml'), `[features]\nhooks = true\n\n${entries.join('\n')}`);
  const trust = () => setup.codexHooksReport({ env, keepBin, hasLsof: () => true }).find((row) => row.text.startsWith('Codex hook trust'));

  assert.deepEqual(setup.codexHooksReport({ env: { HOME: home, KEEP_NODE_NAME: 'main', KEEP_DAEMON_NODE: 'main' }, keepBin }), [],
    'the daemon node reports nothing, as before');
  config(keys.map((key) => table(dir, key)));
  assert.deepEqual(trust(), { status: 'ok', text: 'Codex hook trust (~/.codex): all 9 hooks in hooks.json have a trust entry in config.toml (checked by presence, not hash)' });
  assert.equal(setup.codexHooksReport({ env, keepBin, hasLsof: () => true })[0].status, 'ok', 'the wiring row is unchanged');

  // Two left out, and one for another profile's hooks.json, which is not this one's.
  config([...keys.slice(2).map((key) => table(dir, key)), table(path.join(home, '.codex-secondary'), keys[0])]);
  const partial = trust();
  assert.equal(partial.status, 'FAIL');
  assert.equal(partial.text, 'Codex hook trust (~/.codex): 2 of 9 hooks in ~/.codex/hooks.json have no trust entry in config.toml (checked by presence, not hash); a fresh Codex there stops at \'review required\' for each');
  assert.match(partial.fix, /copy the \[hooks\.state\] tables from a profile that has accepted these same hooks/);
  assert.match(partial.fix, /rebasing each copied key from that profile's path to ~\/\.codex's/);
  assert.match(partial.fix, /press t once per hook/);

  // Hooks defined inline in config.toml are Codex's too, keyed by config.toml's path.
  const inline = `[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo inline"\n\n`;
  const inlineTable = (key) => `[hooks.state."${dir}/config.toml:${key}"]\ntrusted_hash = "sha256:0"\n`;
  config([inline, ...keys.map((key) => table(dir, key))]);
  assert.deepEqual(trust(), { status: 'FAIL', text: 'Codex hook trust (~/.codex): 1 of 10 hooks in ~/.codex\'s hooks.json and config.toml have no trust entry in config.toml (checked by presence, not hash); a fresh Codex there stops at \'review required\' for each',
    fix: trust().fix });
  config([inline, ...keys.map((key) => table(dir, key)), inlineTable('stop:0:0')]);
  assert.deepEqual(trust(), { status: 'ok', text: 'Codex hook trust (~/.codex): all 10 hooks in hooks.json and config.toml have a trust entry in config.toml (checked by presence, not hash)' });

  // A profile reached through a link: a key under its real path counts, as Codex may
  // have been given either. And a hooks.json that is itself a link is read through it.
  const realProfile = path.join(home, 'profiles', 'codex-real');
  fs.mkdirSync(path.dirname(realProfile), { recursive: true });
  fs.renameSync(dir, realProfile);
  fs.symlinkSync(realProfile, dir);
  const shared = path.join(home, 'shared-hooks.json');
  fs.renameSync(path.join(realProfile, 'hooks.json'), shared);
  fs.symlinkSync(shared, path.join(realProfile, 'hooks.json'));
  fs.writeFileSync(path.join(realProfile, 'config.toml'), `[features]\nhooks = true\n\n${keys.map((key) => table(realProfile, key)).join('\n')}`);
  assert.deepEqual(trust(), { status: 'ok', text: 'Codex hook trust (~/.codex): all 9 hooks in hooks.json have a trust entry in config.toml (checked by presence, not hash)' },
    'realpath-only keys, through a linked hooks.json');
  fs.unlinkSync(dir);
  fs.renameSync(realProfile, dir);
  fs.unlinkSync(path.join(dir, 'hooks.json'));
  fs.renameSync(shared, path.join(dir, 'hooks.json'));

  fs.rmSync(path.join(dir, 'config.toml'));
  assert.deepEqual([trust().status, trust().text], ['FAIL',
    'Codex hook trust (~/.codex): no config.toml, so none of the 9 hooks in ~/.codex/hooks.json has a trust entry; a fresh Codex there stops at \'review required\' for each']);

  fs.writeFileSync(path.join(dir, 'config.toml'), '[features]\nhooks = true\n[hooks.state."unterminated\n');
  const broken = trust();
  assert.equal(broken.status, 'FAIL');
  assert.match(broken.text, /^Codex hook trust \(~\/\.codex\): config\.toml unreadable \(.+\); its hook trust entries cannot be counted$/);
  assert.doesNotMatch(broken.text, /\n/);
});

test('doctor on a node says whether the Keep Pi extension is where Pi looks for it', (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-pi-doctor-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, KEEP_NODE_NAME: 'aws1', KEEP_DAEMON_NODE: 'main', KEEP_DAEMON_URL: 'http://100.64.0.1:7781' };
  const source = path.join(home, 'keep-tool', 'integrations', 'pi', 'keep.ts');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, '// extension\n');
  const report = (extra = {}) => setup.piExtensionReport({ env, piExtensionSource: source, ...extra });

  assert.deepEqual(setup.piExtensionReport({ env: { HOME: home, KEEP_NODE_NAME: 'main', KEEP_DAEMON_NODE: 'main' }, piExtensionSource: source }), [],
    'the daemon node checks its own at open');
  const missing = report();
  assert.equal(missing.length, 1);
  assert.equal(missing[0].status, 'optional');
  assert.equal(missing[0].text, 'Pi Keep extension not installed at ~/.pi/agent/extensions/keep.ts: Pi sessions cannot be opened on aws1');
  assert.equal(missing[0].fix, `mkdir -p ~/.pi/agent/extensions && ln -s ${source} ~/.pi/agent/extensions/keep.ts`);

  const link = path.join(home, '.pi', 'agent', 'extensions', 'keep.ts');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(source, link);
  assert.deepEqual(report(), [{ status: 'ok', text: `Pi Keep extension linked to ${source}` }]);

  // A copy of its own, or a link somewhere else, is still an extension Pi loads.
  fs.rmSync(link);
  fs.writeFileSync(link, '// a copy\n');
  assert.deepEqual(report(), [{ status: 'ok', text: `Pi Keep extension installed at ~/.pi/agent/extensions/keep.ts (${link})` }]);

  // A link whose target is gone is none.
  fs.rmSync(link);
  fs.symlinkSync(path.join(home, 'gone.ts'), link);
  const dangling = report();
  assert.equal(dangling[0].status, 'optional');
  assert.match(dangling[0].text, /a link to nothing/);
});
