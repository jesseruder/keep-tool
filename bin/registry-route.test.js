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
const { REGISTRY_COMMANDS, BOOLEAN_FLAGS, MAX_FORWARDED_WAIT_MS, OPEN_EXTRA_MS, MAX_OPEN_EXTRA_MS, openExtraMs, openRequiredMs, argumentRefusal, forwardedWaitMs, nodeSideRefusal } = require('./registry-commands.js');
const ME = { session: 'sess-aws1', node: 'aws1' };

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
  // Every other route still refuses a node: the node API is these, artifact, the hook routes and deploy-self.
  const forNodes = on.filter((entry) => (entry.allow || []).includes('node')).map((entry) => entry.path);
  assert.deepEqual(forNodes, ['/api/registry', '/api/artifact', '/api/secrets/request', '/api/secrets', '/api/hook', '/api/hook/context', '/api/hook/mirror', '/api/registry/ping', '/api/deploy-self']);
  // The node API proper is gated on the daemon listening for nodes. The secrets routes
  // are not: a single-node daemon serves them to its own local callers, and a node
  // reaches them by its principal alone.
  const gated = forNodes.filter((path) => !path.startsWith('/api/secrets'));
  for (const entry of on.filter((route) => gated.includes(route.path))) assert.equal(entry.when(), true);
  for (const entry of off.filter((route) => gated.includes(route.path))) assert.equal(entry.when(), false);
  for (const entry of on.filter((route) => forNodes.includes(route.path) && !gated.includes(route.path))) assert.equal(entry.when, undefined);
});

test('only the listed registry commands run, and never a command-bearing flag', async (t) => {
  const { svc, root, calls } = service(t);
  for (const command of ['handoff', 'land', 'artifact', 'serve', 'restart-daemon', 'probe', 'sync', '', null, 'show; rm -rf /']) {
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

// A check recipe is text a session reads, like a forwarded tell or an open's -m, so a
// node may write one. A command the daemon would run is refused in every command
// that takes one.
test('a node may write a check recipe, but never a command the daemon would run', async (t) => {
  const { svc, root, calls } = service(t);
  const accepted = [
    ['add', ['title', '--check', 'read the logs and fix what you find']],
    ['checkin', ['card', '--check', 'open a session and run this']],
    // Only the two-argument form: the CLI's parseArgs reads `--check=...` as an unknown
    // flag, so the route walking it through would only hand it a usage error.
    ['add', ['title', '--check-after', '+1d', '--check', 'look again', '--on-pass', 'rearm', '--check-every', '+1d']],
    ['checkin', ['card', '--on-pass', 'done']],
    ['checkin', ['card', '--check-after', '+2h']],
  ];
  let n = 0;
  for (const [command, args] of accepted) {
    n += 1;
    assert.equal(argumentRefusal(command, args), null, args.join(' '));
    const answer = await svc.handle(AWS1, body(root, { command, args, idempotencyKey: `${KEY}-recipe-${n}` }));
    assert.equal(answer.status, 200, `${args.join(' ')}: ${JSON.stringify(answer.body)}`);
    assert.deepEqual(calls[calls.length - 1].args.slice(1), [command, ...args]);
  }
  assert.equal(calls.length, accepted.length);

  const refused = [
    ['add', ['title', '--check', 'recipe', '--probe', 'curl -f https://example.com']],
    ['add', ['title', '--plan', 'step', '--done-when', 'make test']],
    ['checkin', ['card', '--check', 'recipe', '--probe=true']],
    ['checkin', ['card', '--on-pass', 'done', '--done-when', 'true']],
    ['plan', ['card', '--add', 'x', '--done-when', 'true']],
    ['plan', ['card', '--verify', '1']],
    ['add', ['title', '--verify', '1']],
    ['checkin', ['card', '--verify=1']],
  ];
  for (const [command, args] of refused) {
    n += 1;
    const flag = args.find((arg) => /^--(probe|done-when|verify)(=|$)/.test(arg)).split('=')[0];
    const answer = await svc.handle(AWS1, body(root, { command, args, idempotencyKey: `${KEY}-cmd-${n}` }));
    assert.equal(answer.status, 400, args.join(' '));
    assert.equal(answer.body.error, `${flag} carries a command the daemon would run; set it from the daemon node`);
  }
  assert.equal(calls.length, accepted.length, 'no refused command reached the CLI');
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

test('a node\'s keep tell runs under its own session, and a message file it names on the node is refused', async (t) => {
  assert.ok(REGISTRY_COMMANDS.includes('tell'));
  assert.equal(argumentRefusal('tell', ['#12', '-m', 'hi', '--wait', '5m', '--dry'], ME), null);
  assert.equal(argumentRefusal('tell', ['card', '--json', '-m', 'line one\nline two'], ME), null);
  assert.equal(argumentRefusal('tell', ['card', '-m', '--message-file'], ME), null, 'a message that reads like the flag is still the message');
  const refusal = '--message-file names a file on this node; use -m, or run it from the daemon node';
  assert.equal(argumentRefusal('tell', ['card', '--message-file', 'x'], ME), refusal);
  assert.equal(argumentRefusal('tell', ['card', '--message-file=x'], ME), refusal);
  assert.equal(argumentRefusal('tell', ['card', '--wait', '--message-file', 'x'], ME), refusal, 'even where it would be read as a value');

  const { svc, root, calls } = service(t);
  const told = await svc.handle(AWS1, body(root, { command: 'tell', args: ['#12', '-m', 'hi', '--wait', '5m', '--dry'], idempotencyKey: `${KEY}-tell` }));
  assert.equal(told.status, 200, JSON.stringify(told.body));
  assert.deepEqual(calls[0].args.slice(1), ['tell', '#12', '-m', 'hi', '--wait', '5m', '--dry']);
  assert.equal(calls[0].options.env.CLAUDE_CODE_SESSION_ID, 'sess-aws1', 'the daemon\'s tell names the node\'s session as the sender');
  const file = await svc.handle(AWS1, body(root, { command: 'tell', args: ['card', '--message-file', 'x'], idempotencyKey: `${KEY}-file` }));
  assert.deepEqual(file, { status: 400, body: { error: refusal } });
  assert.equal(calls.length, 1);
});

test('a node\'s tell must come from a session, and its wait is at most a day', async (t) => {
  const anonymous = "a node's tell names the session it is from; run it inside an agent session";
  assert.equal(argumentRefusal('tell', ['card', '-m', 'hi']), anonymous);
  assert.equal(argumentRefusal('tell', ['card', '-m', 'hi'], { node: 'aws1' }), anonymous);
  const { svc, root, calls } = service(t);
  const bare = await svc.handle(AWS1, body(root, { command: 'tell', args: ['card', '-m', 'hi'], session: null, agent: null, idempotencyKey: `${KEY}-bare` }));
  assert.deepEqual(bare, { status: 400, body: { error: anonymous } });

  const capped = '--wait on a forwarded tell is at most 24h';
  assert.equal(MAX_FORWARDED_WAIT_MS, 24 * 3600e3);
  for (const wait of ['24h', '1d', '1440m']) assert.equal(argumentRefusal('tell', ['card', '-m', 'hi', '--wait', wait], ME), null, wait);
  for (const wait of ['24.01h', '25h', '2d', '1w', '100w']) {
    assert.equal(argumentRefusal('tell', ['card', '-m', 'hi', '--wait', wait], ME), capped, wait);
    assert.equal(nodeSideRefusal('tell', ['card', '-m', 'hi', '--wait', wait]), capped, wait);
  }
  assert.equal(forwardedWaitMs('tell', ['card', '--wait', '1w']), MAX_FORWARDED_WAIT_MS, 'never more than the cap');
  assert.equal(forwardedWaitMs('tell', ['card', '--wait', '2h']), 2 * 3600e3);
  const long = await svc.handle(AWS1, body(root, { command: 'tell', args: ['card', '-m', 'hi', '--wait', '1w'], idempotencyKey: `${KEY}-long` }));
  assert.deepEqual(long, { status: 400, body: { error: capped } });
  assert.equal(calls.length, 0);

  // The node's own check applies only these two rules, not the identity ones.
  assert.equal(nodeSideRefusal('tell', ['card', '-m', 'hi', '--wait', '24h']), null);
  assert.equal(nodeSideRefusal('tell', ['card', '--message-file=x']), '--message-file names a file on this node; use -m, or run it from the daemon node');
  assert.equal(nodeSideRefusal('tell', ['card', '-m', '--message-file']), null);
  assert.equal(nodeSideRefusal('checkin', ['card', '--message-file', 'x']), null);
});

test('a tell --wait runs for its wait, beside the node\'s other commands, and does not hold a restart', async (t) => {
  // Each run closes 100 ms after it starts, well past the 20 ms ordinary bound.
  const fake = fakeSpawn(() => 'hang');
  const original = fake.spawn;
  const children = [];
  fake.spawn = (...args) => {
    const child = original(...args);
    const timer = setTimeout(() => child.emit('close', 0, null), 100);
    child.once('close', () => clearTimeout(timer));
    children.push(child);
    return child;
  };
  const { svc, root } = service(t, { fake, timeoutMs: 20 });
  const plain = await svc.handle(AWS1, body(root, { command: 'tell', args: ['card', '-m', 'hi'], idempotencyKey: `${KEY}-plain` }));
  assert.equal(plain.status, 504, 'without --wait a tell has the ordinary bound');
  const waiting = svc.handle(AWS1, body(root, { command: 'tell', args: ['card', '-m', 'hi', '--wait', '1s'], idempotencyKey: `${KEY}-wait` }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(svc.busy(), false, 'a restart does not wait on it');
  const show = await svc.handle(AWS1, body(root, { idempotencyKey: `${KEY}-show` }));
  assert.equal(show.status, 504, 'the show ran, on its own bound, while the tell was still waiting');
  const answer = await waiting;
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.status, 0);
  assert.equal(children.length, 3);
});

test('two waiting tells from one node run at once, a check-in is not held behind either, and a resend still waits for its own', async (t) => {
  const fake = fakeSpawn((call) => (call.args[1] === 'tell' ? 'hang' : { code: 0, stdout: 'checked in\n' }));
  const original = fake.spawn;
  const hanging = [];
  fake.spawn = (...args) => {
    const child = original(...args);
    if (args[1][1] === 'tell') hanging.push(child);
    return child;
  };
  const { svc, root, calls } = service(t, { fake });
  const tell = (suffix) => body(root, { command: 'tell', args: ['card', '-m', suffix, '--wait', '20m'], idempotencyKey: `${KEY}-${suffix}` });
  const first = svc.handle(AWS1, tell('one'));
  const second = svc.handle(AWS1, tell('two'));
  const resend = svc.handle(AWS1, tell('one'));
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hanging.length, 2, 'both waiting tells started without waiting on each other');
  const checkin = await svc.handle(AWS1, body(root, { command: 'checkin', args: ['card', '-m', 'state'], idempotencyKey: `${KEY}-checkin` }));
  assert.equal(checkin.status, 200);
  assert.equal(checkin.body.stdout, 'checked in\n');
  for (const child of hanging) child.emit('close', 0, null);
  const answers = await Promise.all([first, second, resend]);
  assert.deepEqual(answers.map((answer) => [answer.status, answer.body.replayed]), [[200, false], [200, false], [200, true]]);
  assert.equal(calls.length, 3, 'the resend ran nothing');
});

// A session on a node that plans work opens sessions for it: the daemon's open runs
// under the node's session, which the card is handed over from.
test('a node\'s keep open runs under its own session, may name any node, and a message file it names on the node is refused', async (t) => {
  assert.ok(REGISTRY_COMMANDS.includes('open'));
  assert.equal(argumentRefusal('open', ['card', '--fresh', '-m', 'hi', '--node', 'main'], ME), null, 'the daemon node');
  assert.equal(argumentRefusal('open', ['card', '--fresh', '--node=other', '-m', 'line one\nline two'], ME), null, 'a third node');
  assert.equal(argumentRefusal('open', ['card', '--node', 'aws1', '--fresh', '--agent', 'codex'], ME), null, 'its own node');
  assert.match(argumentRefusal('open', ['card', '--node', 'main\nx'], ME), /only the -m message/, 'the node is still judged as a value');
  assert.match(argumentRefusal('open', ['card', '--session', 'other'], ME), /caller's own session/, 'open takes no --session, so the rule stands');
  const refusal = '--message-file names a file on this node; use -m, or run it from the daemon node';
  assert.equal(argumentRefusal('open', ['card', '--fresh', '--message-file', 'x'], ME), refusal);
  assert.equal(argumentRefusal('open', ['card', '--message-file=x'], ME), refusal);
  assert.equal(argumentRefusal('open', ['card', '-m', '--message-file'], ME), null, 'a message that reads like the flag is still the message');
  assert.equal(nodeSideRefusal('open', ['card', '--fresh', '--message-file', 'x']), refusal);
  assert.equal(nodeSideRefusal('open', ['card', '--fresh', '-m', 'hi', '--node', 'main']), null);

  const { svc, root, calls } = service(t);
  const opened = await svc.handle(AWS1, body(root, { command: 'open', args: ['card', '--fresh', '-m', 'hi', '--node', 'main'], idempotencyKey: `${KEY}-open` }));
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.deepEqual(calls[0].args.slice(1), ['open', 'card', '--fresh', '-m', 'hi', '--node', 'main']);
  assert.equal(calls[0].options.env.CLAUDE_CODE_SESSION_ID, 'sess-aws1', 'the daemon\'s open names the node\'s session as the requester');
  const file = await svc.handle(AWS1, body(root, { command: 'open', args: ['card', '--message-file', 'x'], idempotencyKey: `${KEY}-file` }));
  assert.deepEqual(file, { status: 400, body: { error: refusal } });
  assert.equal(calls.length, 1);
});

test('a node\'s open must come from a session; --node is still the caller\'s own everywhere but open', async (t) => {
  const anonymous = "a node's open names the session it is from; run it inside an agent session";
  assert.equal(argumentRefusal('open', ['card', '--fresh']), anonymous);
  assert.equal(argumentRefusal('open', ['card', '--fresh'], { node: 'aws1' }), anonymous);
  const { svc, root, calls } = service(t);
  const bare = await svc.handle(AWS1, body(root, { command: 'open', args: ['card', '--fresh'], session: null, agent: null, idempotencyKey: `${KEY}-bare` }));
  assert.deepEqual(bare, { status: 400, body: { error: anonymous } });
  for (const command of ['link', 'decide', 'checkin', 'tell']) {
    assert.match(String(argumentRefusal(command, ['card', '--node', 'main', '-m', 'hi'], ME)), /caller's own node/, command);
  }
  const linked = await svc.handle(AWS1, body(root, { command: 'link', args: ['card', '--node', 'main'], idempotencyKey: `${KEY}-link` }));
  assert.equal(linked.status, 400);
  assert.match(linked.body.error, /caller's own node/);
  assert.equal(calls.length, 0);
});

test('a forwarded open runs past the ordinary bound, beside the node\'s other commands, and holds a restart', async (t) => {
  // The longest open, a reopen that compacts, is 585 s of waits (registry-commands.js).
  assert.equal(OPEN_EXTRA_MS, 12 * 60e3);
  assert.ok(OPEN_EXTRA_MS >= (45 + 15 + 270 + 240 + 15) * 1e3);
  assert.equal(openExtraMs({}), OPEN_EXTRA_MS, 'the default compaction timeout gives the floor');
  assert.equal(openExtraMs({ KEEP_COMPACT_TIMEOUT_MS: '60000' }), OPEN_EXTRA_MS, 'a shorter one never lowers it');
  assert.equal(openExtraMs({ KEEP_COMPACT_TIMEOUT_MS: 'soon' }), OPEN_EXTRA_MS, 'an unreadable one is the default, as serve.js reads it');
  // Raised to 360 s the longest open is 45 + 15 + (360 + 30) + 360 + 15 = 825 s.
  assert.ok(openExtraMs({ KEEP_COMPACT_TIMEOUT_MS: '360000' }) >= 825e3 + 60e3);
  assert.equal(forwardedWaitMs('open', ['card'], { KEEP_COMPACT_TIMEOUT_MS: '360000' }), openExtraMs({ KEEP_COMPACT_TIMEOUT_MS: '360000' }));
  assert.equal(forwardedWaitMs('open', ['card']), OPEN_EXTRA_MS, 'a node, which has no daemon env, gets the floor');
  assert.equal(forwardedWaitMs('open', ['card', '--fresh', '-m', 'hi']), OPEN_EXTRA_MS);
  assert.equal(forwardedWaitMs('open', ['card', '--wait', '5m']), OPEN_EXTRA_MS, 'open takes no --wait of its own');
  assert.equal(forwardedWaitMs('show', ['card']), 0);
  const fake = fakeSpawn((call) => (call.args[1] === 'open' ? 'hang' : { code: 0, stdout: 'checked in\n' }));
  const original = fake.spawn;
  const opens = [];
  fake.spawn = (...args) => {
    const child = original(...args);
    if (args[1][1] === 'open') opens.push({ child, options: args[2] });
    return child;
  };
  const { svc, root, calls } = service(t, { fake });
  const open = (suffix) => body(root, { command: 'open', args: ['card', '--fresh', '-m', suffix], idempotencyKey: `${KEY}-${suffix}` });
  const first = svc.handle(AWS1, open('one'));
  const second = svc.handle(AWS1, open('two'));
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opens.length, 2, 'two opens from one node start without waiting on each other');
  assert.equal(svc.busy(), true, 'a restart waits for an open');
  const checkin = await svc.handle(AWS1, body(root, { command: 'checkin', args: ['card', '-m', 'state'], idempotencyKey: `${KEY}-checkin` }));
  assert.equal(checkin.body.stdout, 'checked in\n', 'a check-in is not held behind an open');
  for (const { child } of opens) child.emit('close', 0, null);
  const answers = await Promise.all([first, second]);
  assert.deepEqual(answers.map((answer) => answer.status), [200, 200]);
  assert.equal(svc.busy(), false);
  assert.equal(calls.length, 3);
});

test('a forwarded open is killed only after its longer bound', async (t) => {
  const fake = fakeSpawn(() => 'hang');
  const original = fake.spawn;
  fake.spawn = (...args) => {
    const child = original(...args);
    const timer = setTimeout(() => child.emit('close', 0, null), 100);
    child.once('close', () => clearTimeout(timer));
    return child;
  };
  // 20 ms is the ordinary bound; an open has OPEN_EXTRA_MS on top of it.
  const { svc, root } = service(t, { fake, timeoutMs: 20 });
  const show = await svc.handle(AWS1, body(root, { idempotencyKey: `${KEY}-show` }));
  assert.equal(show.status, 504);
  const opened = await svc.handle(AWS1, body(root, { command: 'open', args: ['card', '--fresh'], idempotencyKey: `${KEY}-open` }));
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
});

// The subprocess bound is the route's own timer; the kill it makes names the bound.
for (const [label, env, seconds] of [['the default', {}, 60 + 720], ['a raised', { KEEP_COMPACT_TIMEOUT_MS: '360000' }, 60 + 960]]) {
  test(`the daemon bounds a forwarded open by its own compaction timeout: ${label} one`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { svc, root } = service(t, { fake: fakeSpawn(() => 'hang'), env });
    const answer = svc.handle(AWS1, body(root, { command: 'open', args: ['card', '--fresh'], idempotencyKey: `${KEY}-open` }));
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(seconds * 1e3 - 1);
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(svc.busy(), true, 'still running a millisecond short of the bound');
    t.mock.timers.tick(1);
    const done = await answer;
    assert.equal(done.status, 504);
    assert.match(done.body.stderr, new RegExp(`stopped this command after ${seconds}s`));
  });
}

// A node whose request runs out before the daemon's longer open does resends the same
// key; the resend is held on the run in flight and answered with its result.
test('a resend of an open still in flight waits for it and is answered with its result', async (t) => {
  const fake = fakeSpawn(() => 'hang');
  const original = fake.spawn;
  const children = [];
  fake.spawn = (...args) => { const child = original(...args); children.push(child); return child; };
  const { svc, root, calls } = service(t, { fake });
  const request = body(root, { command: 'open', args: ['card', '--fresh', '-m', 'hi'], idempotencyKey: `${KEY}-open` });
  const first = svc.handle(AWS1, request);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const resend = svc.handle(AWS1, request);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 1, 'the resend started nothing');
  children[0].stdout.emit('data', Buffer.from('opened\n'));
  children[0].emit('close', 0, null);
  const [a, b] = await Promise.all([first, resend]);
  assert.deepEqual([a.status, a.body.stdout, a.body.replayed], [200, 'opened\n', false]);
  assert.deepEqual([b.status, b.body.stdout, b.body.replayed], [200, 'opened\n', true]);
  assert.equal(calls.length, 1);
});

test('a forwarded open this daemon cannot bound is refused before anything is spawned or journaled', async (t) => {
  const refusal = "this daemon's compaction timeout is set so high that a forwarded open cannot be bounded; run keep open on the daemon node, or lower KEEP_COMPACT_TIMEOUT_MS";
  const twoDays = { KEEP_COMPACT_TIMEOUT_MS: '172800000' };
  assert.ok(openRequiredMs(twoDays) > MAX_OPEN_EXTRA_MS);
  assert.equal(openExtraMs(twoDays), MAX_OPEN_EXTRA_MS);
  const { svc, root, calls } = service(t, { env: twoDays });
  const open = await svc.handle(AWS1, body(root, { command: 'open', args: ['card', '--fresh'], idempotencyKey: `${KEY}-open` }));
  assert.deepEqual(open, { status: 409, body: { error: refusal } });
  assert.equal(calls.length, 0, 'nothing spawned');
  assert.deepEqual(fs.existsSync(svc.journalDir) ? fs.readdirSync(svc.journalDir) : [], [], 'nothing journaled');
  // A tell is unaffected: its wait is capped on both sides already.
  const told = await svc.handle(AWS1, body(root, { command: 'tell', args: ['card', '-m', 'hi'], idempotencyKey: `${KEY}-tell` }));
  assert.equal(told.status, 200);
  // At the default and at two hours an open still runs.
  for (const env of [{}, { KEEP_COMPACT_TIMEOUT_MS: '7200000' }]) {
    assert.ok(openRequiredMs(env) <= MAX_OPEN_EXTRA_MS);
    const ok = service(t, { env });
    const ran = await ok.svc.handle(AWS1, body(ok.root, { command: 'open', args: ['card', '--fresh'], idempotencyKey: `${KEY}-ok` }));
    assert.equal(ran.status, 200, JSON.stringify(ran.body));
    assert.equal(ok.calls.length, 1);
  }
});

test('an open\'s bound is capped well inside the journal\'s lifetime', (t) => {
  const { JOURNAL_TTL_MS, TIMEOUT_MS } = require('./registry-route.js');
  assert.ok(MAX_OPEN_EXTRA_MS < JOURNAL_TTL_MS);
  assert.equal(MAX_OPEN_EXTRA_MS, JOURNAL_TTL_MS / 2);
  const env = { KEEP_COMPACT_TIMEOUT_MS: String(4 * 24 * 3600e3) };
  assert.equal(openExtraMs(env), MAX_OPEN_EXTRA_MS, 'a four-day compaction timeout gets the cap, not eight days');
  assert.ok(openRequiredMs(env) > 8 * 24 * 3600e3, 'the requirement itself is not capped');
  assert.equal(openExtraMs({ KEEP_COMPACT_TIMEOUT_MS: '1e15' }), MAX_OPEN_EXTRA_MS);
  assert.equal(service(t, { env }).svc.maxRunMs(), TIMEOUT_MS + MAX_OPEN_EXTRA_MS, 'the ping advertises the cap');
  assert.ok(TIMEOUT_MS + MAX_OPEN_EXTRA_MS < JOURNAL_TTL_MS);
});

// A run longer than the journal's lifetime keeps its started record: a resend after
// a crash must find it. A finished entry past the lifetime is still pruned.
test('the journal never prunes a run still in flight, and still prunes an old finished one', async (t) => {
  const { JOURNAL_TTL_MS } = require('./registry-route.js');
  const root = tempDir(t);
  let offset = 0;
  const fake = fakeSpawn((call) => (call.args[1] === 'open' ? 'hang' : { code: 0, stdout: 'shown\n' }));
  const original = fake.spawn;
  const opens = [];
  fake.spawn = (...args) => { const child = original(...args); if (args[1][1] === 'open') opens.push(child); return child; };
  const svc = createRegistryService({
    root, spawn: fake.spawn, daemonNode: () => 'main', now: () => Date.now() + offset,
    location: (id) => (id === 'sess-aws1' ? { node: 'aws1', agent: 'claude' } : null),
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C' }, configFile: path.join(root, 'config.json'),
  });
  const entries = () => fs.readdirSync(svc.journalDir).length;
  const shown = await svc.handle(AWS1, body(root, { idempotencyKey: `${KEY}-show` }));
  assert.equal(shown.status, 200);
  const request = body(root, { command: 'open', args: ['card', '--fresh'], idempotencyKey: `${KEY}-open` });
  const first = svc.handle(AWS1, request);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opens.length, 1);
  assert.equal(entries(), 2, 'the finished show and the open\'s started record');
  offset = JOURNAL_TTL_MS + 3600e3;
  const resend = svc.handle(AWS1, request);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entries(), 1, 'the old finished entry was pruned, the running one kept');
  assert.equal(opens.length, 1, 'the resend started nothing');
  opens[0].stdout.emit('data', Buffer.from('opened\n'));
  opens[0].emit('close', 0, null);
  const [a, b] = await Promise.all([first, resend]);
  assert.deepEqual([a.status, a.body.stdout, a.body.replayed], [200, 'opened\n', false]);
  assert.deepEqual([b.status, b.body.stdout, b.body.replayed], [200, 'opened\n', true]);
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

test('the ping advertises the longest run the daemon allows a forwarded command', (t) => {
  const { TIMEOUT_MS } = require('./registry-route.js');
  // At the default a day-long waiting tell is the longest.
  const plain = service(t).svc.ping(AWS1).body.maxRunMs;
  assert.equal(plain, TIMEOUT_MS + MAX_FORWARDED_WAIT_MS);
  assert.ok(plain >= TIMEOUT_MS + openExtraMs({}));
  // A compaction timeout of two hours makes an open 245 minutes long, still inside it.
  const twoHours = service(t, { env: { KEEP_COMPACT_TIMEOUT_MS: '7200000' } }).svc;
  assert.equal(TIMEOUT_MS + openExtraMs({ KEEP_COMPACT_TIMEOUT_MS: '7200000' }), 245 * 60e3);
  assert.ok(twoHours.ping(AWS1).body.maxRunMs >= 245 * 60e3);
  assert.equal(twoHours.maxRunMs(), twoHours.ping(AWS1).body.maxRunMs);
  // Past about twelve hours the open is the longest, and the ping follows it.
  const env = { KEEP_COMPACT_TIMEOUT_MS: String(24 * 3600e3) };
  const long = service(t, { env }).svc;
  assert.equal(long.ping(AWS1).body.maxRunMs, TIMEOUT_MS + openExtraMs(env));
  assert.ok(long.ping(AWS1).body.maxRunMs > TIMEOUT_MS + MAX_FORWARDED_WAIT_MS);
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
  await svc.handle(AWS1, lateBody(root, { session: 'codex-other' }));
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

test('a Codex on a node that Keep did not open (no pane in its request) never costs a host lookup, and the helper remembers its empty answer for 500 ms', async (t) => {
  // Through the route: a request naming no pane is not from one of Keep's panes.
  const { svc, root, host } = adoptingService(t, []);
  for (let i = 0; i < 4; i += 1) {
    const answer = await svc.handle(AWS1, lateBody(root, { pane: null, idempotencyKey: `k-unmanaged-${i}-0123456789` }));
    assert.equal(answer.status, 403);
    assert.equal(answer.body.error, 'session codex-late is not on node aws1');
  }
  assert.equal(host.asked, 0);
  // The helper asked directly for such a session: no pane names it, remembered briefly.
  const direct = directAdoption(t, []);
  const ask = () => direct.adoption.adopt('aws1', 'codex-late', 'codex', {});
  assert.match((await ask()).why, /0 live panes on aws1 name session codex-late/);
  for (let i = 0; i < 3; i += 1) assert.equal((await ask()).cached, true);
  assert.equal(direct.host.asked, 1, 'once per 500 ms window');
  direct.tick(499);
  assert.equal((await ask()).cached, true);
  direct.tick(2);
  assert.equal((await ask()).cached, undefined);
  assert.equal(direct.host.asked, 2);
  // A request naming its pane is still asked each time: its own bind is about to land.
  assert.equal((await direct.adopt()).adopted, false);
  assert.equal((await direct.adopt()).adopted, false);
  assert.equal(direct.host.asked, 4);
  direct.host.panes = [lateCodexPane()];
  assert.equal((await direct.adopt()).adopted, true);
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
function directAdoption(t, panes, options = {}, launch = null) {
  const service = adoptingService(t, panes, launch ? { noLaunch: true } : {});
  if (launch) recordLateLaunch(service.root, service.now, launch);
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

test('late adoption walks the default ~/.claude and ~/.codex even when configured accounts leave them out', { skip: process.getuid && process.getuid() === 0 ? 'root reads every folder' : false }, async (t) => {
  // adoptingService configures codex-home and claude-home only; HOME is its root.
  const roots = require('./late-adoption.js').accountRoots(require('./accounts.js'), directAdoption(t, []).env);
  assert.deepEqual(roots.filter((account) => account.agent !== 'pi').map((account) => path.basename(account.configDir)).sort(),
    ['.claude', '.codex', 'claude-home', 'codex-home']);
  const pinned = (service) => fs.existsSync(path.join(service.root, '.keep', 'session-accounts'));
  for (const where of [['.codex', 'sessions', '2020', '01', '01'], ['.codex', 'archived_sessions']]) {
    const service = directAdoption(t, [lateCodexPane()]);
    const dir = path.join(service.root, ...where);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout-2020-01-01T00-00-00-codex-late.jsonl'), '{}\n');
    const result = await service.adopt();
    assert.equal(result.adopted, false, where.join('/'));
    assert.equal(result.why, 'the session is known on the daemon itself', where.join('/'));
    assert.equal(pinned(service), false);
  }
  const claude = directAdoption(t, [lateCodexPane()]);
  fs.mkdirSync(path.join(claude.root, '.claude', 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(claude.root, '.claude', 'projects', 'p', 'codex-late.jsonl'), '{}\n');
  let result = await claude.adopt();
  assert.equal(result.adopted, false);
  assert.equal(result.why, 'the session is known on the daemon itself');
  // An unreadable default home fails closed like any account root.
  const locked = directAdoption(t, [lateCodexPane()]);
  const sessions = path.join(locked.root, '.codex', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.chmodSync(sessions, 0o000);
  t.after(() => { try { fs.chmodSync(sessions, 0o700); } catch {} });
  result = await locked.adopt();
  assert.equal(result.adopted, false);
  assert.match(result.why, /could not be ruled out locally/);
  assert.equal(pinned(locked), false);
  // Missing default homes are an answer: the session is adopted.
  const clean = directAdoption(t, [lateCodexPane()]);
  assert.equal((await clean.adopt()).adopted, true);
});

test('two concurrent adoptions of one session under different cache keys pin it once', async (t) => {
  const accounts = require('./accounts.js');
  const pins = [];
  const counting = { ...accounts, pinSession: (...args) => { pins.push(args[0]); return accounts.pinSession(...args); } };
  const service = directAdoption(t, [lateCodexPane()], { accounts: counting });
  // One names its pane, the other names none: two keys, both correct.
  const [named, bare] = await Promise.all([
    service.adoption.adopt('aws1', 'codex-late', 'codex', { pane: 'p7@aws1' }),
    service.adoption.adopt('aws1', 'codex-late', 'codex', {}),
  ]);
  assert.equal([named, bare].filter((result) => result.adopted).length, 1, JSON.stringify([named, bare]));
  assert.deepEqual(pins, ['codex-late']);
  assert.deepEqual(accounts.sessionLocation('codex-late', { root: service.root, env: service.env }),
    { node: 'aws1', agent: 'codex', accountId: 'codex-node' });
});

test('a request the adoption would pin to another account than its own is refused before anything is pinned', async (t) => {
  const service = directAdoption(t, [lateCodexPane()]);
  const seen = [];
  const result = await service.adoption.adopt('aws1', 'codex-late', 'codex', { pane: 'p7@aws1', verify: (where) => {
    seen.push(where);
    throw new Error('session codex-late runs on account codex-node, not codex-other');
  } });
  assert.deepEqual(seen, [{ node: 'aws1', agent: 'codex', accountId: 'codex-node' }]);
  assert.equal(result.adopted, false);
  assert.match(result.why, /does not fit the session it would adopt: .*not codex-other/);
  assert.equal(fs.existsSync(path.join(service.root, '.keep', 'session-accounts')), false, 'nothing pinned');
  assert.ok(require('./late-adoption.js').readNodeCodexLaunch(service.root, 'aws1', 'req-1', { now: service.now }), 'the launch record is kept');
  // Not remembered: the right request right after it adopts.
  assert.equal((await service.adopt()).adopted, true);
});

test('a launch record adopts one session, once', async (t) => {
  const { svc, root } = adoptingService(t, [lateCodexPane()]);
  assert.equal((await svc.handle(AWS1, lateBody(root))).status, 200);
  assert.equal(require('./late-adoption.js').readNodeCodexLaunch(root, 'aws1', 'req-1', { now: () => 1_800_000_000_000 }), null, 'consumed');
});

test('a launch record consumed between the host lookup and the pin, or one that cannot be deleted, pins nothing', async (t) => {
  const lateAdoption = require('./late-adoption.js');
  const pinned = (service) => fs.existsSync(path.join(service.root, '.keep', 'session-accounts'));
  // The open (or another adoption) consumes the record while this one is asking: the
  // last-moment location check is the step just before the pin.
  let service;
  let looks = 0;
  service = directAdoption(t, [lateCodexPane()], {
    location: () => {
      looks += 1;
      if (looks === 2) assert.equal(lateAdoption.consumeNodeCodexLaunch(service.root, 'aws1', 'req-1'), true);
      return null;
    },
  });
  let result = await service.adopt();
  assert.equal(looks, 2);
  assert.equal(result.adopted, false);
  assert.match(result.why, /consumed meanwhile/);
  assert.equal(pinned(service), false);
  assert.equal(fs.existsSync(path.join(service.root, '.keep', 'panes', 'codex-late.json')), false);
  assert.equal(lateAdoption.consumeNodeCodexLaunch(service.root, 'aws1', 'req-1'), false, 'already gone');
  // A record that cannot be deleted could adopt again, so it adopts nothing now.
  if (!(process.getuid && process.getuid() === 0)) {
    const stuck = directAdoption(t, [lateCodexPane()]);
    const dir = path.join(stuck.root, '.keep', 'node-codex-launches');
    fs.chmodSync(dir, 0o500);
    t.after(() => { try { fs.chmodSync(dir, 0o700); } catch {} });
    result = await stuck.adopt();
    assert.equal(result.adopted, false);
    assert.match(result.why, /the launch record could not be consumed/);
    assert.equal(pinned(stuck), false);
    fs.chmodSync(dir, 0o700);
  }
});

test('a card open\'s launch puts the adopted session on that card, releases the handing session, and still adopts when the link fails', async (t) => {
  const linked = [];
  const released = [];
  const logged = [];
  const card = directAdoption(t, [lateCodexPane({ card: 'some-other-card' })], {
    linkLaunchedSession: (cardId, session) => { linked.push({ cardId, session }); return { linked: session.id }; },
    releaseCardSession: (cardId, sessionId) => { released.push({ cardId, sessionId }); return true; },
    log: (line) => logged.push(line),
  }, { card: 'the-card', requester: 'handing-session' });
  // The open left pending kept its handoff record (bin/open-handoffs.js); adoption ends it.
  require('./open-handoffs.js').record(card.root, { requester: 'handing-session', card: 'the-card', pane: 'p2@aws1' });
  let result = await card.adopt();
  assert.equal(result.adopted, true, result.why);
  assert.deepEqual(require('./open-handoffs.js').pendingFor(card.root, 'handing-session'), [], 'the handoff is over');
  // The card is the daemon's record of the open, never the pane's meta.
  assert.deepEqual(linked, [{ cardId: 'the-card', session: { id: 'codex-late', agent: 'codex', node: 'aws1' } }]);
  assert.deepEqual(released, [{ cardId: 'the-card', sessionId: 'handing-session' }]);
  assert.equal(result.linked, true);
  // A link that throws is reported; the session is pinned and adopted all the same,
  // and the handing session keeps the card.
  released.length = 0;
  const failing = directAdoption(t, [lateCodexPane()], {
    linkLaunchedSession: () => { throw new Error('registry locked'); },
    releaseCardSession: (cardId, sessionId) => { released.push({ cardId, sessionId }); return true; },
    log: (line) => logged.push(line),
  }, { card: 'the-card', requester: 'handing-session' });
  result = await failing.adopt();
  assert.equal(result.adopted, true, result.why);
  assert.equal(result.linked, false);
  assert.deepEqual(released, []);
  assert.deepEqual(require('./accounts.js').sessionLocation('codex-late', { root: failing.root, env: failing.env }),
    { node: 'aws1', agent: 'codex', accountId: 'codex-node' });
  assert.ok(logged.some((line) => /could not be linked to card the-card: registry locked/.test(line)), logged.join('\n'));
  // A launch with no card links nothing.
  const plain = directAdoption(t, [lateCodexPane()], {
    linkLaunchedSession: () => { throw new Error('never called'); },
  });
  result = await plain.adopt();
  assert.equal(result.adopted, true);
  assert.equal(result.linked, undefined);
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
  assert.equal((await other.svc.shared.adopt('aws1', 'codex-late', 'codex', {})).why, 'the pane runs claude, not codex',
    'a request naming no pane is asked for on its own');
  assert.equal(other.host.asked, 2);
  assert.equal((await other.svc.shared.adopt('aws1', 'codex-late', 'codex', {})).cached, true);
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
