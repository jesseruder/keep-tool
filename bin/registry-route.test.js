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
const { REGISTRY_COMMANDS, BOOLEAN_FLAGS, argumentRefusal } = require('./registry-commands.js');

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
  // Every other route still refuses a node: the node API is these, the hook routes and deploy-self.
  const forNodes = on.filter((entry) => (entry.allow || []).includes('node')).map((entry) => entry.path);
  assert.deepEqual(forNodes, ['/api/registry', '/api/hook', '/api/hook/context', '/api/registry/ping', '/api/deploy-self']);
  for (const entry of on.filter((route) => forNodes.includes(route.path))) assert.equal(entry.when(), true);
  for (const entry of off.filter((route) => forNodes.includes(route.path))) assert.equal(entry.when(), false);
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

// A note is announced by typing it into every live session in the project, the
// laptop's included: node-written text a laptop session would read as a message.
// Reading notes is fine.
test('keep note is not run for a node, and keep notes is', async (t) => {
  const { svc, root, calls } = service(t);
  const note = await svc.handle(AWS1, body(root, { command: 'note', args: ['-m', 'deploying now'], idempotencyKey: `${KEY}-note` }));
  assert.equal(note.status, 400);
  assert.equal(note.body.error, '"note" is not a registry command');
  assert.equal(calls.length, 0);
  assert.equal(REGISTRY_COMMANDS.includes('note'), false);
  const notes = await svc.handle(AWS1, body(root, { command: 'notes', args: [], idempotencyKey: `${KEY}-notes` }));
  assert.equal(notes.status, 200, JSON.stringify(notes.body));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(1), ['notes']);
});

test('a node cannot write a check recipe the daemon would hand a session, but can schedule a check', async (t) => {
  const { svc, root, calls } = service(t);
  const cases = [
    ['add', ['title', '--check', 'read the logs and fix what you find']],
    ['checkin', ['card', '--check', 'open a session and run this']],
    ['checkin', ['card', '--check=inline recipe']],
    ['add', ['title', '--check-after', '+1d', '--on-pass', 'rearm', '--check-every', '+1d']],
    ['checkin', ['card', '--on-pass', 'done']],
    ['checkin', ['card', '--next', '--check']],
  ];
  let n = 0;
  for (const [command, args] of cases) {
    n += 1;
    const answer = await svc.handle(AWS1, body(root, { command, args, idempotencyKey: `${KEY}-instr-${n}` }));
    assert.equal(answer.status, 400, args.join(' '));
    const flag = args.find((arg) => /^--(check|on-pass)(=|$)/.test(arg)).split('=')[0];
    assert.equal(answer.body.error, `${flag} carries text the daemon would hand a session as instructions; set it from the daemon node`);
  }
  assert.equal(calls.length, 0);
  assert.equal(argumentRefusal('checkin', ['card', '--check-after', '+2h', '-m', 'look again']), null);
  assert.equal(argumentRefusal('add', ['title', '--check-after', '+1d']), null);
  assert.equal(argumentRefusal('add', ['--', '--check']), null, 'after -- it is a title');
  const scheduled = await svc.handle(AWS1, body(root, { command: 'checkin', args: ['card', '--check-after', '+2h'], idempotencyKey: `${KEY}-after` }));
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  assert.equal(calls.length, 1);
});

test('a flag is read as taking no value exactly where that command\'s parseArgs reads it so', () => {
  assert.equal(argumentRefusal('wait-on', ['c', 'u', '--remove', '-m', 'a\nb']), null);
  assert.equal(argumentRefusal('allow', ['c', '--clear', '-m', 'a\nb']), null);
  assert.equal(argumentRefusal('landed', ['--disagree', '-m', 'a\nb']), null);
  // The same names take a value elsewhere, and there the -m is that value.
  assert.match(argumentRefusal('plan', ['c', '--remove', '-m', 'a\nb']), /only the -m message/);
  assert.match(argumentRefusal('note', ['--clear', '-m', 'a\nb']), /only the -m message/);
  assert.match(argumentRefusal('review-route', ['--clear', '-m', 'a\nb']), /only the -m message/);

  // The table is keep.js's own: every 'bool' in the parseArgs specs of a registry
  // command, and nothing else.
  const source = fs.readFileSync(path.join(__dirname, 'keep.js'), 'utf8').split('\n');
  const starts = [];
  source.forEach((line, i) => {
    const match = line.match(/^commands(?:\.([a-z]+)|\['([a-z-]+)'\]) = /);
    if (match) starts.push({ name: match[1] || match[2], i });
  });
  for (const command of REGISTRY_COMMANDS) {
    const at = starts.findIndex((entry) => entry.name === command);
    assert.ok(at >= 0, `keep.js defines ${command}`);
    // To the next top-level definition of any kind: a helper after a command (the
    // node's allowRemote and landRemote after land-facts) is not that command's spec.
    let end = starts[at].i + 1;
    while (end < source.length && !/^(?:commands(?:\.|\[)|(?:async )?function |const |let |module\.exports)/.test(source[end])) end += 1;
    const text = source.slice(starts[at].i, end).join('\n');
    const bools = new Set();
    const specs = [...text.matchAll(/parseArgs\([^,]+,\s*(\{[^}]*\})/g)].map((match) => match[1]);
    // A spec held in a named constant (commands.allow's ALLOW_SPEC, shared with the
    // node's own `keep allow <card> land`) is read from its definition.
    for (const named of text.matchAll(/parseArgs\([^,]+,\s*([A-Z][A-Z_]*)\s*\)/g)) {
      const definition = source.join('\n').match(new RegExp(`^const ${named[1]} = (\\{[^}]*\\});`, 'm'));
      assert.ok(definition, `keep.js defines ${named[1]}`);
      specs.push(definition[1]);
    }
    for (const spec of specs) {
      for (const flag of spec.matchAll(/'?([a-z-]+)'?\s*:\s*'bool'/g)) bools.add(flag[1]);
    }
    assert.deepEqual([...(BOOLEAN_FLAGS[command] || [])].sort(), [...bools].sort(), command);
  }
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

test('a project named relative to the node\'s directory is refused; absolute, ~ and bare names are not', () => {
  const relative = /is relative to a directory the daemon does not share/;
  for (const [command, args] of [
    ['add', ['Title', '--project', './x']], ['add', ['Title', '--project', 'x/y']], ['add', ['Title', '--project=../x']],
    ['list', ['--project', '.']], ['list', ['--project', '..']], ['project', ['card', './x']], ['project', ['card', 'code/x']],
    ['project', ['-card', '../x']], ['who', ['./x']], ['who', ['--json', 'x/y']], ['hold', ['--for', '+15m', '../x', '-m', 'why']],
    ['resources', ['./x', '--json']], ['notes', ['--all', '.']], ['notes', ['--', '../x']], ['add', ['Title', '--project', '~other/x']],
  ]) assert.match(String(argumentRefusal(command, args)), relative, `${command} ${args.join(' ')}`);
  for (const [command, args] of [
    ['add', ['Title', '--project', '/srv/x']], ['add', ['a/b title', '--project', 'keep-tool']], ['list', ['--project', '~/code/x']],
    ['list', ['--project', '~']], ['project', ['card']], ['project', ['card', 'keep-tool']], ['who', ['keep-tool']],
    ['hold', ['/srv/x', '--for', '+15m', '-m', 'a/b']], ['notes', []], ['checkin', ['card', '--next', 'x/y', '-m', 'a/b']],
  ]) assert.equal(argumentRefusal(command, args), null, `${command} ${args.join(' ')}`);
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

// A daemon restarted (or killed) while a node's command runs: the child is gone,
// the node never got its answer, and its retry loop resends the same key to the
// next daemon. That daemon must not run it again.
test('a resend of a run the previous daemon never finished is refused, not run again', async (t) => {
  const root = tempDir(t);
  // The kill timer only lets the test end; the second daemon has answered long before it fires.
  const first = service(t, { root, answer: () => 'hang', timeoutMs: 300 });
  const lost = first.svc.handle(AWS1, body(root, { command: 'checkin', args: ['some-card', '-m', 'hi'] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.calls.length, 1, 'the first daemon started the command');
  assert.equal(first.svc.busy(), true);
  const [file] = fs.readdirSync(path.join(root, '.keep', 'registry-ops'));
  const record = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'registry-ops', file), 'utf8'));
  assert.equal(record.started, true, 'the started record is on disk before the child runs');
  assert.equal(record.pid, process.pid);
  assert.equal(record.response, undefined);
  // The first service is dropped mid-run; a second one on the same root is the next daemon.
  const second = service(t, { root });
  const resend = await second.svc.handle(AWS1, body(root, { command: 'checkin', args: ['some-card', '-m', 'hi'] }));
  assert.equal(resend.status, 409);
  assert.equal(resend.body.error, 'an earlier run of this request was interrupted; inspect before retrying');
  assert.equal(second.calls.length, 0, 'nothing ran a second time');
  // A different request under that key is still the reused-key refusal.
  const other = await second.svc.handle(AWS1, body(root, { command: 'checkin', args: ['other-card'] }));
  assert.equal(other.status, 409);
  assert.match(other.body.error, /different request/);
  assert.equal(second.calls.length, 0);
  await lost;
});

test('a started record from another daemon process still inside the kill timeout says it is still running', async (t) => {
  const root = tempDir(t);
  const dir = path.join(root, '.keep', 'registry-ops');
  const first = service(t, { root, answer: () => 'hang', timeoutMs: 300 });
  const lost = first.svc.handle(AWS1, body(root));
  await new Promise((resolve) => setImmediate(resolve));
  const [file] = fs.readdirSync(dir);
  const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  fs.writeFileSync(path.join(dir, file), JSON.stringify({ ...record, pid: 999999, instance: 'elsewhere' }));
  const live = createRegistryService({
    root, spawn: fakeSpawn().spawn, daemonNode: () => 'main', location: () => ({ node: 'aws1', agent: 'claude' }),
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C' }, configFile: path.join(root, 'config.json'), pidAlive: () => true,
  });
  const answer = await live.handle(AWS1, body(root));
  assert.equal(answer.status, 409);
  assert.match(answer.body.error, /still running in daemon pid 999999; inspect before retrying/);
  const dead = createRegistryService({
    root, spawn: fakeSpawn().spawn, daemonNode: () => 'main', location: () => ({ node: 'aws1', agent: 'claude' }),
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C' }, configFile: path.join(root, 'config.json'), pidAlive: () => false,
  });
  assert.equal((await dead.handle(AWS1, body(root))).body.error, 'an earlier run of this request was interrupted; inspect before retrying');
  await lost;
});

test('a command that could not be spawned leaves no started record, so a retry runs it', async (t) => {
  let fail = true;
  const fake = fakeSpawn();
  const original = fake.spawn;
  fake.spawn = (...args) => { if (fail) { fail = false; throw new Error('EAGAIN'); } return original(...args); };
  const { svc, root, calls } = service(t, { fake });
  assert.equal((await svc.handle(AWS1, body(root))).status, 500);
  assert.deepEqual(fs.readdirSync(path.join(root, '.keep', 'registry-ops')), []);
  const retry = await svc.handle(AWS1, body(root));
  assert.equal(retry.status, 200);
  assert.equal(calls.length, 1);
});

test('a restart waits for a run in flight, and once it is stopping new requests get 503 and no journal', async (t) => {
  const { createGate } = require('./daemon-restart.js');
  let release;
  let stopping = false;
  const fake = fakeSpawn(() => 'hang');
  const original = fake.spawn;
  fake.spawn = (...args) => { const child = original(...args); release = () => child.emit('close', 0, null); return child; };
  const root = tempDir(t);
  const svc = createRegistryService({
    root, spawn: fake.spawn, daemonNode: () => 'main', location: () => ({ node: 'aws1', agent: 'claude' }),
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C' }, configFile: path.join(root, 'config.json'),
    stopping: () => stopping,
  });
  const gate = createGate({ busy: () => svc.busy() });
  assert.equal(svc.busy(), false);
  const running = svc.handle(AWS1, body(root));
  assert.equal(svc.busy(), true, 'counted from admission, before the child is even spawned');
  assert.throws(() => gate.prepare(), (error) => error.inFlight === true);
  let sleeps = 0;
  const prepared = gate.prepareWhenIdle({
    sleep: async () => { sleeps += 1; await new Promise((resolve) => setImmediate(resolve)); if (release) { release(); release = null; } },
  });
  const [done, result] = await Promise.all([running, prepared]);
  assert.equal(done.status, 200);
  assert.equal(result.ok, true);
  assert.ok(sleeps >= 1, 'the restart waited for the run');
  assert.equal(gate.stopping, true);
  stopping = gate.stopping;
  const before = fs.readdirSync(path.join(root, '.keep', 'registry-ops'));
  const refused = await svc.handle(AWS1, body(root, { idempotencyKey: `${KEY}-late` }));
  assert.deepEqual(refused, { status: 503, body: { error: 'daemon restarting' } });
  assert.deepEqual(fs.readdirSync(path.join(root, '.keep', 'registry-ops')), before, 'nothing journalled for it');
  assert.equal(fake.calls.length, 1);
  assert.equal(svc.busy(), false);
  // A replay of a finished run still answers from the journal while stopping.
  assert.equal((await svc.handle(AWS1, body(root))).body.replayed, true);
});

// The command has run by the time its answer is journalled: a failed write must not
// turn a done mutation into a refusal the node would retry.
test('a journal write that fails after the run still answers the result, marked unrecorded', async (t) => {
  const logged = [];
  const root = tempDir(t);
  const fake = fakeSpawn(() => ({ code: 0, stdout: 'checked in\n', stderr: '' }));
  let writes = 0;
  const io = {
    ...fs,
    renameSync: (from, to) => {
      writes += 1;
      // The started record goes through; the result does not.
      if (writes === 2) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return fs.renameSync(from, to);
    },
  };
  const svc = createRegistryService({
    root, io, spawn: fake.spawn, daemonNode: () => 'main', location: () => ({ node: 'aws1', agent: 'claude' }),
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C' }, configFile: path.join(root, 'config.json'),
    log: (text) => logged.push(text),
  });
  const answer = await svc.handle(AWS1, body(root, { command: 'checkin', args: ['card', '-m', 'x'] }));
  assert.equal(answer.status, 200);
  assert.equal(answer.body.ok, true);
  assert.equal(answer.body.stdout, 'checked in\n');
  assert.equal(answer.body.journaled, false);
  assert.equal(answer.body.replayed, false);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /aws1 ran keep checkin but its journal entry could not be written: ENOSPC/);
  // What is on disk is the started record, so a resend is refused, never run again.
  const retry = await svc.handle(AWS1, body(root, { command: 'checkin', args: ['card', '-m', 'x'] }));
  assert.equal(retry.status, 409);
  assert.match(retry.body.error, /result was not recorded; inspect before retrying/);
  assert.equal(fake.calls.length, 1);
  // A normal run carries no journaled field at all.
  const normal = await svc.handle(AWS1, body(root, { idempotencyKey: `${KEY}-ok` }));
  assert.equal(normal.status, 200);
  assert.equal('journaled' in normal.body, false);
});

test('add --claim and claim from a node worktree file the card under the main checkout', async (t) => {
  const root = tempDir(t);
  const home = path.join(root, 'home');
  const registry = path.join(home, 'keep');
  for (const dir of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(registry, dir), { recursive: true });
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test' };
  delete gitEnv.CLAUDE_CODE_SESSION_ID;
  const git = (...args) => { const r = spawnSync('git', args, { env: gitEnv, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q', registry);
  git('-C', registry, 'config', 'user.name', 'Keep Test');
  git('-C', registry, 'config', 'user.email', 'keep@example.test');
  const main = path.join(home, 'project');
  const tree = path.join(home, 'wt', 'project', 'x');
  git('init', '-q', '--initial-branch=master', main);
  git('-C', main, 'commit', '-q', '--allow-empty', '-m', 'base');
  git('-C', main, 'worktree', 'add', '-q', '-b', 'wt/x', tree);
  const svc = createRegistryService({
    root: registry,
    daemonNode: () => 'main',
    location: (id) => (id === 'sess-aws1' ? { node: 'aws1', agent: 'claude' } : null),
    env: { PATH: process.env.PATH, HOME: home, LANG: 'C' },
    configFile: path.join(root, 'config.json'),
  });
  const { registryBody } = require('./remote-cli.js');
  const where = { local: 'aws1', daemon: 'main' };
  const nodeEnv = { CLAUDE_CODE_SESSION_ID: 'sess-aws1', KEEP_NODE_NAME: 'aws1', KEEP_DAEMON_NODE: 'main' };
  const send = async (command, args, key) => {
    const request = registryBody(command, args, { env: nodeEnv, cwd: tree, where, key });
    assert.equal(request.cwd, main);
    assert.equal(request.nodeCwd, tree);
    const answer = await svc.handle(AWS1, request);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.status, 0, answer.body.stderr);
    return answer.body;
  };
  await send('add', ['Node work', '--claim', '-m', 'Started.'], 'claim-add-0123456789');
  const card = fs.readFileSync(path.join(registry, 'tasks', 'node-work.md'), 'utf8');
  assert.match(card, /^project: ~\/project$/m);
  assert.match(card, /sess-aws1/);
  await send('add', ['Filed work', '--file', '-m', 'Filed.'], 'file-add-0123456789');
  await send('claim', ['filed-work'], 'claim-card-0123456789');
  const filed = fs.readFileSync(path.join(registry, 'tasks', 'filed-work.md'), 'utf8');
  assert.match(filed, /^project: ~\/project$/m);
  assert.match(filed, /sess-aws1/);
  // A project relative to the node's directory never reaches the CLI.
  const relative = await svc.handle(AWS1, registryBody('add', ['Elsewhere', '--project', './sub', '-m', 'x'], { env: nodeEnv, cwd: tree, where, key: 'relative-0123456789' }));
  assert.equal(relative.status, 400);
  assert.match(relative.body.error, /is relative to a directory the daemon does not share/);
});

// ---------- late adoption (bin/late-adoption.js) ----------

// A node host stand-in that lists the panes it is given and counts how often it is asked.
function fakeNodeHost(panes) {
  const host = { asked: 0, panes };
  host.connect = async (node) => {
    host.asked += 1;
    host.node = node;
    return { request: async (type) => { assert.equal(type, 'list'); return { panes: host.panes }; }, close: () => {} };
  };
  return host;
}

const lateCodexPane = (meta = {}, extra = {}) => ({
  id: 'p7', alive: true, cwd: '/home/node/project', ...extra,
  meta: { agent: 'codex', accountId: 'codex-node', sessionId: 'codex-late', node: 'aws1', project: '/home/node/project',
    openRequestId: 'req-1', launchedAt: 1_700_000_000_000, opener: { kind: 'owner' }, ...meta },
});

// The daemon's record of the fresh open that spawned lateCodexPane, as openSession writes it.
function recordLateLaunch(root, now, extra = {}) {
  require('./late-adoption.js').recordNodeCodexLaunch(root, { node: 'aws1', requestId: 'req-1', accountId: 'codex-node',
    launchedAt: 1_700_000_000_000, pane: 'p7', project: '/home/node/project', ...extra }, { now });
}

function adoptingService(t, panes, options = {}) {
  const { noLaunch, ...extra } = options;
  const root = tempDir(t);
  const configFile = path.join(root, 'config.json');
  fs.mkdirSync(path.join(root, 'codex-home'));
  fs.mkdirSync(path.join(root, 'claude-home'));
  fs.writeFileSync(configFile, `${JSON.stringify({ version: 1, daemonNode: 'main', nodes: { main: {}, aws1: {} },
    accounts: [{ id: 'codex-node', label: 'Node codex', agent: 'codex', configDir: path.join(root, 'codex-home') },
      { id: 'claude-node', label: 'Node claude', agent: 'claude', configDir: path.join(root, 'claude-home') }],
    defaultAccounts: { codex: 'codex-node', claude: 'claude-node' } })}\n`);
  const env = { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C', KEEP_CONFIG: configFile };
  const accounts = require('./accounts.js');
  const host = fakeNodeHost(panes);
  const logged = [];
  let clock = 1_800_000_000_000;
  const fake = fakeSpawn();
  const svc = createRegistryService({
    root, spawn: fake.spawn, daemonNode: () => 'main', env, configFile, now: () => clock,
    location: (id) => accounts.sessionLocation(id, { root, env }),
    hostConnect: host.connect, log: (line) => logged.push(line), ...extra,
  });
  if (!noLaunch) recordLateLaunch(root, () => clock);
  return { svc, root, host, logged, calls: fake.calls, tick: (ms) => { clock += ms; }, env, now: () => clock };
}

const lateBody = (root, extra = {}) => body(root, { session: 'codex-late', agent: 'codex', pane: 'p7@aws1', ...extra });

test('a Codex session the daemon never heard register is adopted from its one pane on the node, and its command runs', async (t) => {
  const { svc, root, host, logged, calls, env } = adoptingService(t, [lateCodexPane(), { id: 'p8', alive: true, meta: { agent: 'shell' } }]);
  const answer = await svc.handle(AWS1, lateBody(root));
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(host.node, 'aws1', 'the caller\'s own host was asked');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.CODEX_THREAD_ID, 'codex-late');
  assert.deepEqual(require('./accounts.js').sessionLocation('codex-late', { root, env }),
    { node: 'aws1', agent: 'codex', accountId: 'codex-node' });
  const record = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'panes', 'codex-late.json'), 'utf8'));
  assert.equal(record.pane, 'p7@aws1');
  assert.equal(record.node, 'aws1');
  assert.equal(record.agent, 'codex');
  assert.equal(record.accountId, 'codex-node');
  assert.equal(record.claimed, true);
  assert.equal(record.bound, true);
  assert.equal(record.cwd, '/home/node/project');
  assert.equal(logged.filter((line) => /late adoption: codex session codex-late adopted on aws1/.test(line)).length, 1);
  // Adopted once: the next request reads the record and never asks the host again.
  const again = await svc.handle(AWS1, lateBody(root, { idempotencyKey: 'k-again-0123456789' }));
  assert.equal(again.status, 200);
  assert.equal(host.asked, 1);
});

test('late adoption refuses a pane of another agent, two panes naming the session, an unknown account and a pane the request does not name', async (t) => {
  const cases = [
    ['wrong agent', [lateCodexPane({ agent: 'claude' })], {}],
    ['two panes', [lateCodexPane(), lateCodexPane({}, { id: 'p9' })], {}],
    ['unknown account', [lateCodexPane({ accountId: 'codex-elsewhere' })], {}],
    ['no account', [lateCodexPane({ accountId: undefined })], {}],
    ['dead pane', [lateCodexPane({}, { alive: false })], {}],
    ['no pane', [], {}],
    ['another pane named', [lateCodexPane()], { pane: 'p8@aws1' }],
    ['a pane that says another node', [lateCodexPane({ node: 'aws2' })], {}],
  ];
  for (const [name, panes, extra] of cases) {
    const { svc, root, calls, logged } = adoptingService(t, panes);
    const answer = await svc.handle(AWS1, lateBody(root, extra));
    assert.equal(answer.status, 403, `${name}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.error, 'session codex-late is not on node aws1', name);
    assert.equal(calls.length, 0, `${name}: nothing ran`);
    assert.equal(fs.existsSync(path.join(root, '.keep', 'session-accounts')), false, `${name}: nothing pinned`);
    assert.equal(fs.existsSync(path.join(root, '.keep', 'panes', 'codex-late.json')), false, `${name}: no pane record`);
    assert.deepEqual(logged, [], name);
  }
  // A Claude request for the Codex pane's session is not adopted as either.
  const { svc, root } = adoptingService(t, [lateCodexPane()]);
  const claude = await svc.handle(AWS1, lateBody(root, { agent: 'claude' }));
  assert.equal(claude.status, 403);
  // Nor one whose daemon pane record places the session on the daemon.
  const local = adoptingService(t, [lateCodexPane()]);
  fs.mkdirSync(path.join(local.root, '.keep', 'panes'), { recursive: true });
  fs.writeFileSync(path.join(local.root, '.keep', 'panes', 'codex-late.json'), JSON.stringify({ pane: '4', agent: 'codex' }));
  assert.equal((await local.svc.handle(AWS1, lateBody(local.root))).status, 403);
  assert.equal(fs.existsSync(path.join(local.root, '.keep', 'session-accounts')), false);
});

test('a refused late adoption is remembered for five seconds per node and session, so a flood asks the host once', async (t) => {
  const { svc, root, host, tick } = adoptingService(t, [lateCodexPane({ agent: 'claude' })]);
  for (let i = 0; i < 5; i += 1) {
    const answer = await svc.handle(AWS1, lateBody(root, { idempotencyKey: `k-flood-${i}-0123456789` }));
    assert.equal(answer.status, 403);
  }
  assert.equal(host.asked, 1);
  // Another session on the same node is asked for on its own.
  await svc.handle(AWS1, lateBody(root, { session: 'codex-other', pane: null }));
  assert.equal(host.asked, 2);
  // Once the refusal has lapsed and the pane is the session's, it is adopted.
  host.panes = [lateCodexPane()];
  tick(4_000);
  assert.equal((await svc.handle(AWS1, lateBody(root))).status, 403);
  assert.equal(host.asked, 2);
  tick(1_001);
  const adopted = await svc.handle(AWS1, lateBody(root));
  assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
  assert.equal(host.asked, 3);
});

test('late adoption never asks a host for a session that has a location record, nor for the daemon\'s own caller', async (t) => {
  const { svc, root, host, env } = adoptingService(t, [lateCodexPane()]);
  require('./accounts.js').pinSession('codex-late', 'codex', 'codex-node', { root, env, node: 'main' });
  assert.equal((await svc.handle(AWS1, lateBody(root))).status, 403);
  assert.equal((await svc.handle({ class: 'admin' }, lateBody(root, { pane: null }))).status, 200);
  assert.equal(host.asked, 0);
  // A host that cannot be reached refuses as before.
  const down = adoptingService(t, [], { hostConnect: async () => { throw new Error('connect ECONNREFUSED'); } });
  assert.equal((await down.svc.handle(AWS1, lateBody(down.root))).status, 403);
});

test('no pane naming the session yet is never remembered: the node\'s own bind lands a moment after its start posts', async (t) => {
  const { svc, root, host } = adoptingService(t, []);
  assert.equal((await svc.handle(AWS1, lateBody(root, { idempotencyKey: 'k-before-bind-0123456789' }))).status, 403);
  assert.equal((await svc.handle(AWS1, lateBody(root, { idempotencyKey: 'k-before-bind-1123456789' }))).status, 403);
  assert.equal(host.asked, 2, 'asked each time');
  host.panes = [lateCodexPane()];
  const adopted = await svc.handle(AWS1, lateBody(root));
  assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
  assert.equal(host.asked, 3);
});

test('late adoption refuses a session this machine knows, one with any daemon pane record, and a pane whose open the daemon never recorded', async (t) => {
  const refusedAs = async (name, service, extra = {}) => {
    const answer = await service.svc.handle(AWS1, lateBody(service.root, extra));
    assert.equal(answer.status, 403, `${name}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.error, 'session codex-late is not on node aws1', name);
    assert.equal(fs.existsSync(path.join(service.root, '.keep', 'session-accounts')), false, `${name}: nothing pinned`);
  };
  // A Claude transcript of that id in one of this machine's accounts, found by discovery.
  const claude = adoptingService(t, [lateCodexPane()]);
  fs.mkdirSync(path.join(claude.root, 'claude-home', 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(claude.root, 'claude-home', 'projects', 'p', 'codex-late.jsonl'), '{}\n');
  await refusedAs('a local Claude transcript', claude);
  // A rollout of that id under one of this machine's Codex accounts.
  const codex = adoptingService(t, [lateCodexPane()]);
  const day = new Date();
  const dir = path.join(codex.root, 'codex-home', 'sessions', String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rollout-2026-01-01T00-00-00-codex-late.jsonl'), '{}\n');
  await refusedAs('a local rollout', codex);
  // A daemon pane record, even one naming this node.
  const recorded = adoptingService(t, [lateCodexPane()]);
  fs.mkdirSync(path.join(recorded.root, '.keep', 'panes'), { recursive: true });
  fs.writeFileSync(path.join(recorded.root, '.keep', 'panes', 'codex-late.json'), JSON.stringify({ pane: 'p7@aws1', node: 'aws1', agent: 'codex' }));
  await refusedAs('a daemon pane record', recorded);
  // No launch record at all, or one that does not match the pane's launch facts.
  await refusedAs('no launch record', adoptingService(t, [lateCodexPane()], { noLaunch: true }));
  for (const [name, facts] of [['another launch time', { launchedAt: 1_700_000_000_001 }], ['another pane', { pane: 'p8' }],
    ['another account', { accountId: 'codex-other' }]]) {
    const service = adoptingService(t, [lateCodexPane()], { noLaunch: true });
    recordLateLaunch(service.root, service.now, facts);
    await refusedAs(name, service);
  }
  const otherNode = adoptingService(t, [lateCodexPane()], { noLaunch: true });
  recordLateLaunch(otherNode.root, otherNode.now, { node: 'aws2' });
  await refusedAs('a launch on another node', otherNode);
  // A pane with no open request id: not a fresh open.
  await refusedAs('no open request', adoptingService(t, [lateCodexPane({ openRequestId: undefined })]));
  // A launch older than a day.
  const stale = adoptingService(t, [lateCodexPane()]);
  stale.tick(require('./late-adoption.js').LAUNCH_TTL_MS + 1);
  await refusedAs('a launch record past its day', stale);
  // A Claude session is never adopted: it is registered at its launch.
  const claudeSession = adoptingService(t, [lateCodexPane({ agent: 'claude', accountId: 'claude-node' })]);
  assert.equal((await claudeSession.svc.handle(AWS1, lateBody(claudeSession.root, { agent: 'claude' }))).status, 403);
  assert.equal(claudeSession.host.asked, 0);
});

// The adoption helper itself on adoptingService's layout, so a refusal's reason can be read.
function directAdoption(t, panes, options = {}) {
  const service = adoptingService(t, panes);
  const adoption = require('./late-adoption.js').createLateAdoption({
    root: service.root, env: service.env, daemonNode: () => 'main', now: service.now,
    hostConnect: service.host.connect, ...options,
  });
  return { ...service, adoption, adopt: () => adoption.adopt('aws1', 'codex-late', 'codex', { pane: 'p7@aws1' }) };
}

test('late adoption walks every local transcript and rollout folder, and a folder it cannot read refuses', { skip: process.getuid && process.getuid() === 0 ? 'root reads every folder' : false }, async (t) => {
  const pinned = (service) => fs.existsSync(path.join(service.root, '.keep', 'session-accounts'));
  const locked = (dir) => { fs.mkdirSync(dir, { recursive: true }); fs.chmodSync(dir, 0o000); t.after(() => { try { fs.chmodSync(dir, 0o700); } catch {} }); };
  // An unreadable Claude projects root: the session cannot be ruled out.
  const projects = directAdoption(t, [lateCodexPane()]);
  locked(path.join(projects.root, 'claude-home', 'projects'));
  let result = await projects.adopt();
  assert.equal(result.adopted, false);
  assert.match(result.why, /could not be ruled out locally/);
  assert.equal(pinned(projects), false);
  // An unreadable dated Codex folder, however old.
  const dated = directAdoption(t, [lateCodexPane()]);
  locked(path.join(dated.root, 'codex-home', 'sessions', '2021', '03', '04'));
  result = await dated.adopt();
  assert.equal(result.adopted, false);
  assert.match(result.why, /could not be ruled out locally/);
  assert.equal(pinned(dated), false);
  // A rollout in a dated folder far past the shared lookup's 92 days, or archived.
  for (const where of [['sessions', '2020', '01', '01'], ['archived_sessions']]) {
    const old = directAdoption(t, [lateCodexPane()]);
    const dir = path.join(old.root, 'codex-home', ...where);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout-2020-01-01T00-00-00-codex-late.jsonl'), '{}\n');
    result = await old.adopt();
    assert.equal(result.adopted, false, where.join('/'));
    assert.equal(result.why, 'the session is known on the daemon itself', where.join('/'));
    assert.equal(pinned(old), false);
  }
  // A layout with folders but nothing of the session still adopts.
  const clean = directAdoption(t, [lateCodexPane()]);
  fs.mkdirSync(path.join(clean.root, 'claude-home', 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(clean.root, 'claude-home', 'projects', 'p', 'codex-other.jsonl'), '{}\n');
  const day = path.join(clean.root, 'codex-home', 'sessions', '2020', '01', '01');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'rollout-2020-01-01T00-00-00-codex-other.jsonl'), '{}\n');
  fs.writeFileSync(path.join(clean.root, 'codex-home', 'sessions', 'stray-file'), '');
  result = await clean.adopt();
  assert.equal(result.adopted, true, result.why);
  assert.equal(pinned(clean), true);
});

test('a launch record adopts one session, once', async (t) => {
  const { svc, root } = adoptingService(t, [lateCodexPane()]);
  assert.equal((await svc.handle(AWS1, lateBody(root))).status, 200);
  assert.equal(require('./late-adoption.js').readNodeCodexLaunch(root, 'aws1', 'req-1', { now: () => 1_800_000_000_000 }), null, 'consumed');
});

test('late adoption gives up on a node host that never answers its hello within about two seconds, well inside a start\'s deadline', async (t) => {
  const net = require('node:net');
  const sockets = [];
  const silent = net.createServer((socket) => { sockets.push(socket); });
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise((resolve) => silent.close(resolve)); });
  const root = tempDir(t);
  const tokenFile = path.join(root, 'aws1.token');
  fs.writeFileSync(tokenFile, 'a'.repeat(64) + '\n', { mode: 0o600 });
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify({ version: 1, daemonNode: 'main',
    nodes: { main: {}, aws1: { transport: 'tcp', address: `127.0.0.1:${silent.address().port}`, tokenFile } } })}\n`);
  const adoption = require('./late-adoption.js').createLateAdoption({
    root, env: { PATH: '/usr/bin:/bin', HOME: root, KEEP_CONFIG: configFile }, daemonNode: () => 'main',
  });
  const began = Date.now();
  const result = await adoption.adopt('aws1', 'codex-late', 'codex', {});
  const elapsed = Date.now() - began;
  assert.equal(sockets.length, 1, 'it did connect');
  assert.equal(result.adopted, false);
  assert.match(result.why, /could not be asked/);
  assert.ok(elapsed < 2000, `bounded by the hello timeout (${elapsed} ms)`);
});

test('late adoption gives up within its two-second lookup deadline on a host that answers hello but never its list', async (t) => {
  const net = require('node:net');
  const { FrameDecoder, encodeFrame, PROTOCOL_VERSION } = require('./host.js');
  const sockets = [];
  const asked = [];
  // Hello answers only after 900 ms, so a list with its own full cap would run to 2.4 s.
  const mute = net.createServer((socket) => {
    sockets.push(socket);
    const decoder = new FrameDecoder((frame) => {
      asked.push(frame.type);
      if (frame.type === 'hello') {
        setTimeout(() => { if (!socket.destroyed) socket.write(encodeFrame({ ok: true, id: frame.id, protocol: PROTOCOL_VERSION, node: 'aws1' })); }, 900);
      }
    }, () => socket.destroy());
    socket.on('data', (data) => decoder.push(data));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => mute.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise((resolve) => mute.close(resolve)); });
  const root = tempDir(t);
  const tokenFile = path.join(root, 'aws1.token');
  fs.writeFileSync(tokenFile, 'a'.repeat(64) + '\n', { mode: 0o600 });
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify({ version: 1, daemonNode: 'main',
    nodes: { main: {}, aws1: { transport: 'tcp', address: `127.0.0.1:${mute.address().port}`, tokenFile } } })}\n`);
  const adoption = require('./late-adoption.js').createLateAdoption({
    root, env: { PATH: '/usr/bin:/bin', HOME: root, KEEP_CONFIG: configFile }, daemonNode: () => 'main',
  });
  const began = Date.now();
  const result = await adoption.adopt('aws1', 'codex-late', 'codex', {});
  const elapsed = Date.now() - began;
  assert.deepEqual(asked, ['hello', 'list'], 'it did ask for the list');
  assert.equal(result.adopted, false);
  assert.match(result.why, /could not be asked/);
  assert.ok(elapsed >= 1800 && elapsed < 2100, `bounded by the lookup deadline (${elapsed} ms)`);
});

test('a request naming the wrong pane neither blocks nor delays the right one', async (t) => {
  const { svc, root, host } = adoptingService(t, [lateCodexPane()]);
  const wrong = await svc.handle(AWS1, lateBody(root, { pane: 'p8@aws1', idempotencyKey: 'k-wrong-pane-0123456789' }));
  assert.equal(wrong.status, 403);
  const right = await svc.handle(AWS1, lateBody(root));
  assert.equal(right.status, 200, JSON.stringify(right.body));
  assert.equal(host.asked, 2);
  // A refusal that is remembered is remembered for that request's pane only.
  const other = adoptingService(t, [lateCodexPane({ agent: 'claude' })]);
  assert.equal((await other.svc.handle(AWS1, lateBody(other.root))).status, 403);
  assert.equal((await other.svc.handle(AWS1, lateBody(other.root, { pane: null, idempotencyKey: 'k-no-pane-0123456789' }))).status, 403);
  assert.equal(other.host.asked, 2, 'a request naming no pane is asked for on its own');
  assert.equal((await other.svc.handle(AWS1, lateBody(other.root, { pane: null, idempotencyKey: 'k-no-pane-1123456789' }))).status, 403);
  assert.equal(other.host.asked, 2);
});

test('a request the route would refuse on its own adopts nothing', async (t) => {
  const cases = [
    ['not a registry command', { command: 'serve' }, 400],
    ['a short key', { idempotencyKey: 'short' }, 400],
    ['a command-bearing flag', { command: 'checkin', args: ['card', '--probe', 'rm -rf ~'] }, 400],
    ['a cwd the daemon lacks', { cwd: '/no/such/dir' }, 400],
    ['a pane on another node', { pane: 'p7@aws2' }, 403],
  ];
  for (const [name, extra, status] of cases) {
    const { svc, root, host } = adoptingService(t, [lateCodexPane()]);
    const answer = await svc.handle(AWS1, lateBody(root, extra));
    assert.equal(answer.status, status, `${name}: ${JSON.stringify(answer.body)}`);
    assert.equal(host.asked, 0, `${name}: the host was not asked`);
    assert.equal(fs.existsSync(path.join(root, '.keep', 'session-accounts')), false, `${name}: nothing pinned`);
    assert.equal(fs.existsSync(path.join(root, '.keep', 'panes')), false, `${name}: no pane record`);
  }
});
