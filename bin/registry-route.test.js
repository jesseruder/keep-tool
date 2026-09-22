'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { routes, matchRoute, routeDenial } = require('./serve/routes.js');
const { createRegistryService } = require('./registry-route.js');
const { REGISTRY_COMMANDS, argumentRefusal } = require('./registry-commands.js');

const AWS1 = { class: 'node', node: 'aws1' };
const KEY = 'k-0123456789abcdef';

function tempDir(t, prefix = 'keep-registry-route-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A child process stand-in: records what it was asked to run and answers with
// whatever the test says.
function fakeSpawn(answer = () => ({ code: 0, stdout: 'ok\n', stderr: '' })) {
  const calls = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { setImmediate(() => child.emit('close', null, 'SIGKILL')); };
    const result = answer({ file, args, options });
    if (result !== 'hang') {
      setImmediate(() => {
        if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
        if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
        child.emit('close', result.code, null);
      });
    }
    return child;
  };
  return { spawn, calls };
}

function service(t, overrides = {}) {
  const root = overrides.root || tempDir(t);
  const fake = overrides.fake || fakeSpawn(overrides.answer);
  const locations = overrides.locations || { 'sess-aws1': { node: 'aws1', agent: 'claude' }, 'sess-main': { node: 'main', agent: 'claude' } };
  const svc = createRegistryService({
    root,
    spawn: fake.spawn,
    daemonNode: () => 'main',
    location: (id) => locations[id] || null,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C', ...(overrides.env || {}) },
    configFile: path.join(root, 'config.json'),
    ...(overrides.timeoutMs ? { timeoutMs: overrides.timeoutMs } : {}),
  });
  return { svc, root, calls: fake.calls };
}

function body(root, extra = {}) {
  return { command: 'show', args: ['some-card'], cwd: root, session: 'sess-aws1', agent: 'claude', idempotencyKey: KEY, ...extra };
}

test('the registry route exists only where the daemon listens for nodes', async (t) => {
  const fake = { handle: async () => ({ status: 200, body: { ok: true } }), ping: () => ({ status: 200, body: { ok: true } }) };
  const json = (res, status, value) => ({ status, value });
  const req = { method: 'POST' };
  const url = new URL('http://x/api/registry');
  const off = routes({ json });
  const offMatch = matchRoute(off, { req, url, body: {} });
  assert.equal(offMatch, null, 'a single-node daemon answers the ladder\'s own 404');
  assert.equal(matchRoute(off, { req: { method: 'GET' }, url: new URL('http://x/api/registry/ping') })?.path === '/api/registry/ping', false);
  const disabled = routes({ json, nodeApiEnabled: () => false, registryService: fake });
  assert.equal(matchRoute(disabled, { req, url, body: {} }), null);

  const on = routes({ json, nodeApiEnabled: () => true, registryService: fake });
  const route = matchRoute(on, { req, url, body: {} });
  assert.equal(route.path, '/api/registry');
  assert.deepEqual(route.allow, ['node', 'admin', 'local']);
  assert.equal(routeDenial(route, AWS1), null);
  assert.deepEqual(routeDenial(route, { class: 'proxy' }), { status: 403, error: 'forbidden for proxy' });
  assert.deepEqual(await route.handle({ req, res: {}, url, body: {}, principal: AWS1 }), { status: 200, value: { ok: true } });
  const ping = matchRoute(on, { req: { method: 'GET' }, url: new URL('http://x/api/registry/ping') });
  assert.equal(ping.path, '/api/registry/ping');
  assert.deepEqual(ping.allow, ['node', 'admin', 'local']);
  // Every other route still refuses a node.
  const others = on.filter((entry) => !String(entry.path).startsWith('/api/registry'));
  assert.equal(others.some((entry) => (entry.allow || []).includes('node')), false);
});

test('only the listed registry commands run, and never a command-bearing flag', async (t) => {
  const { svc, root, calls } = service(t);
  for (const command of ['open', 'tell', 'land', 'artifact', 'serve', 'restart-daemon', 'probe', 'sync', '', null, 'show; rm -rf /']) {
    const answer = await svc.handle(AWS1, body(root, { command }));
    assert.equal(answer.status, 400, String(command));
  }
  for (const args of [
    ['card', '--probe', 'rm -rf ~'], ['card', '--probe=true'], ['--done-when', 'make test'],
    ['card', '--verify', '1'], ['card', '--next', '--probe'], ['card', '--add', 'x', '--done-when', 'true'],
  ]) {
    const answer = await svc.handle(AWS1, body(root, { command: 'checkin', args, idempotencyKey: `${KEY}-${args.length}` }));
    assert.equal(answer.status, 400, args.join(' '));
    assert.match(answer.body.error, /carries a command the daemon would run/);
  }
  assert.equal(calls.length, 0);
  assert.ok(REGISTRY_COMMANDS.includes('checkin'));
  assert.equal(REGISTRY_COMMANDS.includes('artifact'), false);
});

test('arguments are checked the way the CLI will read them', (t) => {
  assert.equal(argumentRefusal('checkin', ['card', '-m', 'line one\nline two']), null, 'the message may span lines');
  assert.equal(argumentRefusal('checkin', ['card', '--force', '-m', 'a\nb']), null, 'after a flag that takes no value');
  assert.match(argumentRefusal('checkin', ['card', '--next', '-m', 'a\nb']), /only the -m message/,
    '-m read as --next\'s value leaves the newline in a positional');
  assert.match(argumentRefusal('add', ['title\ninjected']), /only the -m message/);
  assert.match(argumentRefusal('add', ['x', '\0']), /NUL/);
  assert.match(argumentRefusal('add', ['x'.repeat(4097)]), /longer than 4096/);
  assert.match(argumentRefusal('add', Array.from({ length: 17 }, () => 'x'.repeat(4000))), /together/);
  assert.match(argumentRefusal('add', ['x', 3]), /array of strings/);
  assert.equal(argumentRefusal('add', ['--', '--probe']), null, 'after -- it is a title');
  assert.equal(argumentRefusal('link', ['card', '--session', 'me'], { session: 'me', node: 'aws1' }), null);
  assert.match(argumentRefusal('link', ['card', '--session', 'other'], { session: 'me', node: 'aws1' }), /caller's own session/);
  assert.match(argumentRefusal('link', ['card', '--node', 'main'], { session: 'me', node: 'aws1' }), /caller's own node/);
  assert.match(argumentRefusal('decide', ['t', '--session=other'], { session: 'me', node: 'aws1' }), /caller's own session/);
});

test('the request fields are validated before anything runs', async (t) => {
  const { svc, root, calls } = service(t);
  const cases = [
    [{ args: 'show x' }, 400], [{ args: ['a\nb'] }, 400], [{ cwd: 'relative/dir' }, 400],
    [{ cwd: `${root}/../${path.basename(root)}` }, 400], [{ cwd: path.join(root, 'missing') }, 400],
    [{ idempotencyKey: 'short' }, 400], [{ idempotencyKey: undefined }, 400], [{ idempotencyKey: `${KEY}/..` }, 400],
    [{ session: 'bad id' }, 400], [{ agent: 'gpt' }, 400], [{ session: undefined, agent: 'claude' }, 400],
    [{ pane: 7 }, 400], [{ pane: 'p$1@aws1' }, 400],
  ];
  for (const [extra, status] of cases) {
    const answer = await svc.handle(AWS1, body(root, extra));
    assert.equal(answer.status, status, JSON.stringify(extra));
  }
  assert.equal((await svc.handle(null, body(root))).status, 403);
  assert.equal((await svc.handle({ class: 'proxy' }, body(root))).status, 403);
  assert.equal(calls.length, 0);
});

test('a node acts only for sessions and panes the location record places on it', async (t) => {
  const { svc, root, calls } = service(t);
  const elsewhere = await svc.handle(AWS1, body(root, { session: 'sess-main' }));
  assert.deepEqual(elsewhere, { status: 403, body: { error: 'session sess-main is not on node aws1' } });
  const unknown = await svc.handle(AWS1, body(root, { session: 'sess-nowhere' }));
  assert.deepEqual(unknown, { status: 403, body: { error: 'session sess-nowhere is not on node aws1' } });
  const wrongAgent = await svc.handle(AWS1, body(root, { agent: 'codex' }));
  assert.equal(wrongAgent.status, 403);
  // Another node's token cannot speak for aws1's session.
  const mini = await svc.handle({ class: 'node', node: 'mini' }, body(root));
  assert.equal(mini.status, 403);
  // A bare pane id is the daemon's own pane.
  assert.equal((await svc.handle(AWS1, body(root, { pane: 'p1' }))).status, 403);
  assert.equal((await svc.handle(AWS1, body(root, { pane: 'p1@mini' }))).status, 403);
  assert.equal(calls.length, 0);

  const ok = await svc.handle(AWS1, body(root, { pane: 'p1@aws1', agent: undefined }));
  assert.equal(ok.status, 200);
  assert.equal(calls.length, 1);
  const [{ file, args, options }] = calls;
  assert.equal(file, process.execPath);
  assert.deepEqual(args, [path.join(__dirname, 'keep.js'), 'show', 'some-card']);
  assert.equal(options.shell, false);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(options.cwd, root);
  assert.deepEqual(options.env, {
    PATH: '/usr/bin:/bin', HOME: root, LANG: 'C', KEEP_DIR: root, KEEP_CONFIG: path.join(root, 'config.json'),
    KEEP_NO_PUSH: '1', KEEP_SYNC: '0', KEEP_NODE_NAME: 'main', KEEP_DAEMON_NODE: 'main', KEEP_REMOTE_CALLER: 'aws1',
    CLAUDE_CODE_SESSION_ID: 'sess-aws1', KEEP_PANE: 'p1@aws1',
  });

  // The daemon's own callers act as the daemon node.
  const local = await svc.handle({ class: 'local' }, body(root, { session: 'sess-main', idempotencyKey: `${KEY}-local` }));
  assert.equal(local.status, 200);
  assert.equal(calls[1].options.env.KEEP_REMOTE_CALLER, 'main');
});

test('a replayed request answers from the journal and a reused key with another request is refused', async (t) => {
  let n = 0;
  const { svc, root, calls } = service(t, { answer: () => { n += 1; return { code: 3, stdout: `run ${n}\n`, stderr: 'warn\n' }; } });
  const first = await svc.handle(AWS1, body(root));
  assert.equal(first.status, 200, 'a failing CLI exit is data, not an HTTP error');
  assert.equal(first.body.ok, false);
  assert.equal(first.body.status, 3);
  assert.equal(first.body.stdout, 'run 1\n');
  assert.equal(first.body.stderr, 'warn\n');
  assert.equal(first.body.replayed, false);
  const again = await svc.handle(AWS1, body(root));
  assert.deepEqual(again, { status: 200, body: { ...first.body, replayed: true } });
  assert.equal(calls.length, 1);
  const conflict = await svc.handle(AWS1, body(root, { args: ['other-card'] }));
  assert.equal(conflict.status, 409);
  assert.equal(calls.length, 1);
  // The key is the node's own: another node's same key is another request.
  const files = fs.readdirSync(path.join(root, '.keep', 'registry-ops'));
  assert.equal(files.length, 1);
  assert.equal((fs.statSync(path.join(root, '.keep', 'registry-ops', files[0])).mode & 0o777), 0o600);
});

test('concurrent requests with one key run once, and one node runs one command at a time', async (t) => {
  let running = 0;
  let peak = 0;
  const fake = fakeSpawn(() => {
    running += 1;
    peak = Math.max(peak, running);
    return { code: 0, stdout: 'x' };
  });
  const original = fake.spawn;
  fake.spawn = (...args) => {
    const child = original(...args);
    child.once('close', () => { running -= 1; });
    return child;
  };
  const { svc, root, calls } = service(t, { fake });
  const same = await Promise.all([svc.handle(AWS1, body(root)), svc.handle(AWS1, body(root))]);
  assert.equal(calls.length, 1);
  assert.deepEqual(same.map((answer) => answer.body.replayed).sort(), [false, true]);
  await Promise.all(['a', 'b', 'c'].map((suffix) => svc.handle(AWS1, body(root, { idempotencyKey: `${KEY}-${suffix}` }))));
  assert.equal(calls.length, 4);
  assert.equal(peak, 1);
});

test('a command past its time is killed, answered 504, and not run again on retry', async (t) => {
  const { svc, root, calls } = service(t, { answer: () => 'hang', timeoutMs: 20 });
  const answer = await svc.handle(AWS1, body(root));
  assert.equal(answer.status, 504);
  assert.equal(answer.body.timedOut, true);
  assert.match(answer.body.stderr, /stopped this command/);
  const retry = await svc.handle(AWS1, body(root));
  assert.equal(retry.status, 504);
  assert.equal(retry.body.replayed, true);
  assert.equal(calls.length, 1);
});

test('the ping names the caller and the daemon', (t) => {
  const { svc } = service(t);
  const answer = svc.ping(AWS1);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.ok, true);
  assert.equal(answer.body.node, 'aws1');
  assert.equal(answer.body.daemon, 'main');
  assert.ok(Number.isFinite(Date.parse(answer.body.now)));
  assert.equal(svc.ping(null).status, 403);
});

test('a real keep add and keep show round-trip through the daemon\'s own CLI', async (t) => {
  const root = tempDir(t);
  for (const dir of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const env = { ...process.env, KEEP_DIR: root };
  delete env.CLAUDE_CODE_SESSION_ID;
  assert.equal(spawnSync('git', ['init', '-q', root], { env }).status, 0);
  spawnSync('git', ['-C', root, 'config', 'user.name', 'Keep Test'], { env });
  spawnSync('git', ['-C', root, 'config', 'user.email', 'keep@example.test'], { env });
  const svc = createRegistryService({
    root,
    daemonNode: () => 'main',
    location: (id) => (id === 'sess-aws1' ? { node: 'aws1', agent: 'claude' } : null),
    env: { PATH: process.env.PATH, HOME: root, LANG: 'C' },
    configFile: path.join(root, 'config.json'),
  });
  const added = await svc.handle(AWS1, {
    command: 'add', args: ['Remote card', '-m', 'first line\nsecond line'], cwd: root,
    session: 'sess-aws1', agent: 'claude', idempotencyKey: 'add-0123456789abcdef',
  });
  assert.equal(added.status, 200);
  assert.equal(added.body.status, 0, added.body.stderr);
  assert.ok(fs.existsSync(path.join(root, 'tasks', 'remote-card.md')));
  const shown = await svc.handle(AWS1, {
    command: 'show', args: ['remote-card'], cwd: root, session: 'sess-aws1', idempotencyKey: 'show-0123456789abcdef',
  });
  assert.equal(shown.body.status, 0, shown.body.stderr);
  assert.match(shown.body.stdout, /Remote card/);
  assert.match(shown.body.stdout, /second line/);
  // The retry of the add is the journal's answer, not a second card.
  const retried = await svc.handle(AWS1, {
    command: 'add', args: ['Remote card', '-m', 'first line\nsecond line'], cwd: root,
    session: 'sess-aws1', agent: 'claude', idempotencyKey: 'add-0123456789abcdef',
  });
  assert.equal(retried.body.replayed, true);
  assert.equal(fs.existsSync(path.join(root, 'tasks', 'remote-card-2.md')), false);
});
