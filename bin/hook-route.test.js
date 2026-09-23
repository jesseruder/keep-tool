'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { routes, matchRoute, routeDenial } = require('./serve/routes.js');
const { createRegistryService } = require('./registry-route.js');
const { createHookService } = require('./hook-route.js');
const mirror = require('./transcript-mirror.js');

const AWS1 = { class: 'node', node: 'aws1' };
const KEY = 'hook-key-0123456789';
const CLI = path.join(__dirname, 'keep.js');

function tempDir(t, prefix = 'keep-hook-route-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A child stand-in that records its argv, env and stdin.
function fakeSpawn(answer = () => ({ code: 0, stdout: '', stderr: '' })) {
  const calls = [];
  const fn = (file, args, options) => {
    const call = { file, args, options, stdin: '' };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (data) => { call.stdin = String(data || ''); };
    child.kill = () => { setImmediate(() => child.emit('close', null, 'SIGKILL')); };
    const result = answer(call);
    setImmediate(() => {
      if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
      child.emit('close', result.code, null);
    });
    return child;
  };
  return { spawn: fn, calls };
}

const LOCATIONS = {
  'sess-aws1': { node: 'aws1', agent: 'claude', accountId: 'claude-node' },
  'sess-main': { node: 'main', agent: 'claude' },
  'codex-aws1': { node: 'aws1', agent: 'codex' },
};

function services(t, overrides = {}) {
  const root = overrides.root || tempDir(t);
  const fake = overrides.fake || fakeSpawn(overrides.answer);
  const registry = createRegistryService({
    root,
    spawn: overrides.realSpawn ? spawn : fake.spawn,
    daemonNode: () => 'main',
    location: (id) => (overrides.locations || LOCATIONS)[id] || null,
    env: { PATH: process.env.PATH, HOME: root, LANG: 'C', ...(overrides.env || {}) },
    configFile: path.join(root, 'config.json'),
  });
  const hooks = createHookService({ root, registry, stopping: overrides.stopping, cardForSession: overrides.cardForSession });
  return { root, registry, hooks, calls: fake.calls };
}

const encode = (text) => Buffer.from(text).toString('base64');

function body(extra = {}) {
  return {
    event: 'stop',
    input: { session_id: 'sess-aws1', transcript_path: '/home/node/.claude/projects/p/sess-aws1.jsonl', cwd: '/home/node/project',
      hook_event_name: 'Stop', stop_hook_active: false, something_else: { nested: true } },
    identity: { agent: 'claude', sessionId: 'sess-aws1', pane: 'p1@aws1', accountId: 'claude-node' },
    transcript: null,
    idempotencyKey: KEY,
    ...extra,
  };
}

function transcript(text, extra = {}) {
  return { path: '/home/node/.claude/projects/p/sess-aws1.jsonl', generation: '10:20:30', fromOffset: 0,
    bytes: encode(text), size: Buffer.byteLength(text), mtimeMs: 1_700_000_000_000, ...extra };
}

test('the hook route is on the node API only, beside the registry route', async () => {
  const fake = { handle: async () => ({ status: 200, body: { ok: true } }) };
  const json = (res, status, value) => ({ status, value });
  const req = { method: 'POST' };
  const url = new URL('http://x/api/hook');
  assert.equal(matchRoute(routes({ json }), { req, url, body: {} }), null);
  assert.equal(matchRoute(routes({ json, nodeApiEnabled: () => false, hookService: fake }), { req, url, body: {} }), null);
  const on = routes({ json, nodeApiEnabled: () => true, hookService: fake });
  const route = matchRoute(on, { req, url, body: {} });
  assert.equal(route.path, '/api/hook');
  assert.deepEqual(route.allow, ['node', 'admin', 'local']);
  assert.equal(routeDenial(route, AWS1), null);
  assert.deepEqual(routeDenial(route, { class: 'proxy' }), { status: 403, error: 'forbidden for proxy' });
  assert.deepEqual(await route.handle({ req, res: {}, url, body: {}, principal: AWS1 }), { status: 200, value: { ok: true } });
});

test('a hook post is refused unless it is a Claude event for a session and pane on the calling node', async (t) => {
  const { hooks, calls, root } = services(t);
  const cases = [
    [AWS1, body({ event: 'pre-bash', input: { session_id: 'sess-aws1', cwd: '/x' } }), 400, /pre-bash is for Bash only/],
    [AWS1, body({ event: 'post-bash', input: { session_id: 'sess-aws1', cwd: '/x' } }), 400, /post-bash is for Bash only/],
    [AWS1, body({ identity: { agent: 'codex', sessionId: 'codex-aws1' } }), 400, /only Claude hooks/],
    [AWS1, body({ identity: { agent: 'claude', sessionId: 'sess-main' }, input: { session_id: 'sess-main', cwd: '/x' } }), 403, /session sess-main is not on node aws1/],
    [AWS1, body({ identity: { agent: 'claude', sessionId: 'nobody' }, input: { session_id: 'nobody', cwd: '/x' } }), 403, /is not on node aws1/],
    [AWS1, body({ identity: { agent: 'claude', sessionId: 'codex-aws1' }, input: { session_id: 'codex-aws1', cwd: '/x' } }), 403, /is a codex session/],
    [AWS1, body({ identity: { agent: 'claude', sessionId: 'sess-aws1', pane: 'p1' } }), 403, /pane p1 is not on node aws1/],
    [AWS1, body({ identity: { agent: 'claude', sessionId: 'sess-aws1', pane: 'p1@other' } }), 403, /is not on node aws1/],
    [AWS1, body({ identity: { agent: 'claude', sessionId: 'sess-aws1', accountId: 'claude-other' } }), 403, /runs on account claude-node/],
    [AWS1, body({ identity: { agent: 'claude', sessionId: '../x' } }), 400, /invalid session id/],
    [AWS1, body({ input: { session_id: 'sess-other', cwd: '/x' } }), 400, /must be the identity's session/],
    [AWS1, body({ input: { session_id: 'sess-aws1', cwd: 'relative' } }), 400, /input.cwd must be an absolute path/],
    [AWS1, body({ input: { session_id: 'sess-aws1', cwd: '/a/../b' } }), 400, /may not contain \.\./],
    [AWS1, body({ input: { session_id: 'sess-aws1', cwd: '/x', stop_hook_active: 'yes' } }), 400, /stop_hook_active must be a boolean/],
    [AWS1, body({ input: { session_id: 'sess-aws1', cwd: '/x', hook_event_name: 'SessionStart' } }), 400, /is not a stop event/],
    [AWS1, body({ event: 'pre-question', input: { session_id: 'sess-aws1', cwd: '/x', tool_name: 'Bash', tool_input: { command: 'ls' } } }), 400, /AskUserQuestion only/],
    [AWS1, body({ event: 'lifecycle', input: { session_id: 'sess-aws1', cwd: '/x' } }), 400, /hook_event_name is required/],
    [AWS1, body({ input: { session_id: 'sess-aws1', cwd: '/x', pad: 'x'.repeat(300 * 1024) } }), 400, /larger than/],
    [AWS1, body({ idempotencyKey: 'short' }), 400, /idempotencyKey/],
    [AWS1, body({ transcript: transcript('x', { bytes: 'not base64!' }) }), 400, /base64/],
    [AWS1, body({ transcript: transcript('x', { path: 'relative.jsonl' }) }), 400, /transcript.path/],
    [{ class: 'admin' }, body(), 403, /for sessions on other nodes/],
    [{ class: 'node', node: 'main' }, body(), 403, /unauthorized/],
    [{ class: 'proxy' }, body(), 403, /unauthorized/],
  ];
  for (const [who, request, status, message] of cases) {
    const answer = await hooks.handle(who, request);
    assert.equal(answer.status, status, `${JSON.stringify(request).slice(0, 160)}: ${JSON.stringify(answer.body)}`);
    assert.match(answer.body.error, message);
  }
  assert.equal(calls.length, 0, 'nothing ran');
  assert.equal(fs.existsSync(path.join(root, '.keep', 'registry-ops')), false, 'nothing journalled');
  assert.equal(fs.existsSync(path.join(root, '.keep', 'transcript-mirrors')), false, 'nothing mirrored');
});

test('the hook runs the daemon\'s own keep hook on a rewritten input that points at the mirror', async (t) => {
  const { hooks, calls, root } = services(t, { answer: () => ({ code: 0, stdout: '{"decision":"block","reason":"x"}\n', stderr: 'note\n' }) });
  const text = '{"type":"mode","mode":"default"}\n';
  const answer = await hooks.handle(AWS1, body({ transcript: transcript(text) }));
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { ok: true, status: 0, stdout: '{"decision":"block","reason":"x"}\n', stderr: 'note\n', replayed: false });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.file, process.execPath);
  assert.deepEqual(call.args, [CLI, 'hook', 'stop']);
  assert.equal(call.options.cwd, root);
  assert.equal(call.options.shell, false);
  const mirrorFile = path.join(root, '.keep', 'transcript-mirrors', 'aws1', 'sess-aws1.jsonl');
  assert.deepEqual(JSON.parse(call.stdin), {
    session_id: 'sess-aws1', cwd: '/home/node/project', hook_event_name: 'Stop', stop_hook_active: false,
    transcript_path: mirrorFile,
  }, 'unknown keys dropped, the node path replaced');
  assert.equal(fs.readFileSync(mirrorFile, 'utf8'), text);
  const env = call.options.env;
  assert.equal(env.KEEP_HOOK_NODE, 'aws1');
  assert.equal(env.KEEP_REMOTE_CALLER, 'aws1');
  assert.equal(env.KEEP_PANE, 'p1@aws1');
  assert.equal(env.CLAUDE_CODE_SESSION_ID, 'sess-aws1');
  assert.equal(env.KEEP_AGENT_ACCOUNT_ID, 'claude-node');
  assert.equal(env.KEEP_DIR, root);
  assert.equal(env.KEEP_NODE_NAME, 'main');

  // No transcript in the post: still the mirror, never the node's path.
  const bare = await hooks.handle(AWS1, body({ event: 'notification', idempotencyKey: `${KEY}-n`,
    input: { session_id: 'sess-aws1', cwd: '/x', transcript_path: '/etc/passwd', notification_type: 'idle_prompt', message: 'waiting' } }));
  assert.equal(bare.status, 200);
  assert.equal(JSON.parse(calls[1].stdin).transcript_path, mirrorFile);
  assert.deepEqual(calls[1].args.slice(1), ['hook', 'notification']);
});

test('bytes that do not start at the mirror\'s end answer needFrom and journal nothing', async (t) => {
  const { hooks, calls, root } = services(t);
  const first = '{"n":1}\n';
  assert.equal((await hooks.handle(AWS1, body({ event: 'transcript', transcript: transcript(first) }))).status, 200);
  assert.equal(calls.length, 0, 'a transcript-only post runs nothing');
  const gap = await hooks.handle(AWS1, body({ transcript: transcript('{"n":3}\n', { fromOffset: 50, size: 58 }) }));
  assert.equal(gap.status, 409);
  assert.equal(gap.body.needFrom, Buffer.byteLength(first));
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(root, '.keep', 'registry-ops')), false);
  // The resend from where it was told runs the hook.
  const second = '{"n":2}\n';
  const resend = await hooks.handle(AWS1, body({ transcript: transcript(second, { fromOffset: first.length, size: first.length + second.length }) }));
  assert.equal(resend.status, 200, JSON.stringify(resend.body));
  assert.equal(calls.length, 1);
  assert.equal(mirror.read(root, 'aws1', 'sess-aws1').toString(), first + second);
});

test('a resent event replays its answer, and a key reused for another event is refused', async (t) => {
  let n = 0;
  const { hooks, calls } = services(t, { answer: () => ({ code: 0, stdout: `run ${++n}\n` }) });
  const text = '{"a":1}\n';
  const first = await hooks.handle(AWS1, body({ transcript: transcript(text) }));
  assert.equal(first.body.stdout, 'run 1\n');
  // The node lost the answer and resends: the bytes are already there (it is told
  // where the mirror is), then resent from there with the same key.
  const again = await hooks.handle(AWS1, body({ transcript: transcript(text) }));
  assert.equal(again.status, 409);
  assert.equal(again.body.needFrom, text.length);
  const replay = await hooks.handle(AWS1, body({ transcript: transcript('', { fromOffset: text.length, size: text.length }) }));
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, { ok: true, status: 0, stdout: 'run 1\n', stderr: '', replayed: true });
  assert.equal(calls.length, 1, 'the hook ran once');
  const other = await hooks.handle(AWS1, body({ event: 'notification', input: { session_id: 'sess-aws1', cwd: '/x' } }));
  assert.equal(other.status, 409);
  assert.match(other.body.error, /used for a different request/);
  assert.equal(calls.length, 1);
});

test('a restarting daemon admits no hook and writes no mirror', async (t) => {
  const { hooks, calls, root } = services(t, { stopping: () => true });
  const answer = await hooks.handle(AWS1, body({ transcript: transcript('x\n') }));
  assert.deepEqual(answer, { status: 503, body: { error: 'daemon restarting' } });
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(root, '.keep', 'transcript-mirrors')), false);
});

// ---------- the real hook, against a real registry ----------

function toolUse(name) {
  return `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name }] } })}\n`;
}

function registry(t) {
  const root = tempDir(t, 'keep-hook-real-');
  for (const dir of ['tasks', 'archive', 'digests', '.keep']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  return root;
}

function runLocal(argv, { env, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...argv], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('keep hook stop through the route blocks exactly as it does for a local session', async (t) => {
  // Five edits and no check-in: the Stop evaluator's nag.
  const text = `${JSON.stringify({ type: 'mode', mode: 'default' })}\n${toolUse('Edit').repeat(5)}`
    + `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done with the edits.' }] } })}\n`;

  // The local run: a session on the daemon node with its transcript on disk.
  const localRoot = registry(t);
  const localTranscript = path.join(localRoot, 'sess-aws1.jsonl');
  fs.writeFileSync(localTranscript, text);
  const localEnv = { PATH: process.env.PATH, HOME: localRoot, LANG: 'C', KEEP_DIR: localRoot, KEEP_NO_PUSH: '1', KEEP_SYNC: '0',
    KEEP_CONFIG: path.join(localRoot, 'config.json'), CLAUDE_CODE_SESSION_ID: 'sess-aws1' };
  const local = await runLocal(['hook', 'stop'], { env: localEnv,
    input: JSON.stringify({ session_id: 'sess-aws1', transcript_path: localTranscript, cwd: '/home/node/project', hook_event_name: 'Stop' }) });
  assert.equal(local.status, 0, local.stderr);
  const decision = JSON.parse(local.stdout);
  assert.equal(decision.decision, 'block');

  // The node's run: the same transcript arrives as bytes, the daemon's own hook runs.
  const { hooks, root } = services(t, { root: registry(t), realSpawn: true });
  const answer = await hooks.handle(AWS1, body({
    identity: { agent: 'claude', sessionId: 'sess-aws1' },
    input: { session_id: 'sess-aws1', transcript_path: '/home/node/.claude/projects/p/sess-aws1.jsonl', cwd: '/home/node/project', hook_event_name: 'Stop' },
    transcript: transcript(text),
  }));
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.status, 0, answer.body.stderr);
  assert.equal(answer.body.stdout, local.stdout, 'the same block decision');
  const state = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'stopcheck', 'sess-aws1.json'), 'utf8'));
  assert.equal(state.offset, Buffer.byteLength(text), 'the evaluator scanned the mirror');
  assert.ok(fs.existsSync(path.join(root, '.keep', 'nagged', 'sess-aws1')));

  // A second stop in the same turn is not blocked again, on either side.
  const again = await hooks.handle(AWS1, body({
    identity: { agent: 'claude', sessionId: 'sess-aws1' }, idempotencyKey: `${KEY}-2`,
    input: { session_id: 'sess-aws1', cwd: '/home/node/project', hook_event_name: 'Stop', stop_hook_active: true },
    transcript: transcript('', { fromOffset: Buffer.byteLength(text), size: Buffer.byteLength(text) }),
  }));
  assert.equal(again.status, 200);
  assert.equal(again.body.stdout, '');
});

test('on the daemon a node hook binds and reads the pane on that node\'s host, and nowhere else', async (t) => {
  const { withTwoNodes } = require('./fixtures/two-node-hosts.js');
  const hook = require('./commands/hook.js');
  const { connect } = require('./hostclient.js');
  await withTwoNodes(t, async ({ root, configFile }) => {
    const remote = await connect({ node: 'aws1' });
    const local = await connect({ node: 'main' });
    try {
      const { pane } = await remote.request('spawn', { cmd: '/bin/sh', args: ['-c', 'sleep 5'] });
      await remote.request('meta', { pane: pane.id, patch: { unattended: true, opener: { kind: 'check', id: 'card' } } });
      const { pane: mainPane } = await local.request('spawn', { cmd: '/bin/sh', args: ['-c', 'sleep 5'] });
      const env = { KEEP_CONFIG: configFile, KEEP_DAEMON_NODE: 'main', KEEP_NODE_NAME: 'main', KEEP_HOOK_NODE: 'aws1',
        KEEP_REMOTE_CALLER: 'aws1', KEEP_PANE: `${pane.id}@aws1` };
      const record = await hook.recordSessionPane({ session_id: 'sess-aws1', cwd: '/home/node/project' }, 'claude',
        { root, env, retryMs: 1 });
      assert.equal(record.bound, true);
      assert.equal(record.node, 'aws1');
      assert.equal(record.pane, `${pane.id}@aws1`);
      assert.equal(record.unattended, true, 'read from the aws1 pane');
      const onDisk = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'panes', 'sess-aws1.json'), 'utf8'));
      assert.equal(onDisk.node, 'aws1');
      const meta = (await remote.request('get', { pane: pane.id })).pane.meta;
      assert.equal(meta.sessionId, 'sess-aws1');
      assert.deepEqual(await hook.unattendedState('sess-aws1', { env }), { unattended: true, opener: { kind: 'check', id: 'card' } });

      // A bare ref (a daemon pane) or another node's is refused before it is sent,
      // and a KEEP_HOOK_NODE the request did not set connects nowhere: attended, unbound.
      assert.deepEqual(await hook.unattendedState('sess-aws1', { env: { ...env, KEEP_PANE: mainPane.id } }), { unattended: false, opener: null });
      const client = await hook.hookHostConnect(env)({ timeoutMs: 1000 });
      try { await assert.rejects(client.request('get', { pane: mainPane.id }), /is not on node aws1/); } finally { client.close(); }
      await assert.rejects(hook.hookHostConnect({ ...env, KEEP_REMOTE_CALLER: 'other' })({}), /not the node this hook runs for/);
      await assert.rejects(hook.hookHostConnect({ ...env, KEEP_HOOK_NODE: 'main', KEEP_REMOTE_CALLER: 'main' })({}), /not the node this hook runs for/);
      assert.equal((await local.request('get', { pane: mainPane.id })).pane.meta.sessionId, undefined, 'the daemon\'s pane was never touched');
      // Without KEEP_HOOK_NODE the connect is the local one it always was.
      assert.equal(hook.hookHostConnect({}), connect);
    } finally { remote.close(); local.close(); }
  });
});

// ---------- a node's queue, replayed through the route ----------

// The node's hook client, in process, posting straight into the route; `down()`
// says whether the daemon is unreachable for this post.
function nodeClient(t, hooks, root, down) {
  const client = require('./hook-client.js');
  const home = tempDir(t, 'keep-hook-node-home-');
  const transcriptFile = path.join(home, 'sess-aws1.jsonl');
  const env = { HOME: home, KEEP_AGENT_ACCOUNT_ID: 'claude-node' };
  const seen = [];
  const request = async (url, pathname, { payload }) => {
    if (down()) throw new Error('connect ECONNREFUSED');
    const answer = await hooks.handle(AWS1, payload);
    seen.push({ payload, answer, stopcheck: readStopcheck(root) });
    return { status: answer.status, data: JSON.stringify(answer.body) };
  };
  const where = { url: 'http://127.0.0.1:1', local: 'aws1', daemon: 'main' };
  const run = (event, extra = {}) => client.runHook(event,
    { session_id: 'sess-aws1', transcript_path: transcriptFile, cwd: '/home/node/project', ...extra },
    where, { env, token: 'aws1-secret', request });
  const queueDir = client.queueDir(env);
  const queued = () => { try { return fs.readdirSync(queueDir).sort().map((name) => path.join(queueDir, name)); } catch { return []; } };
  return { run, seen, transcriptFile, queued, env };
}

function readStopcheck(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, '.keep', 'stopcheck', 'sess-aws1.json'), 'utf8')); } catch { return null; }
}

test('a start replayed after the transcript grew anchors the stop evidence where it fired, and the stop still nags', async (t) => {
  const { hooks, root } = services(t, { root: registry(t), realSpawn: true });
  let down = true;
  const node = nodeClient(t, hooks, root, () => down);
  const opening = `${JSON.stringify({ type: 'mode', mode: 'default' })}\n`;
  fs.writeFileSync(node.transcriptFile, opening);
  const start = await node.run('session-start', { hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(start.delivered, false);
  assert.equal(start.queued, true);

  // A whole turn of work happens before the daemon is back.
  fs.appendFileSync(node.transcriptFile, `${toolUse('Edit').repeat(5)}${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } })}\n`);
  down = false;
  const stop = await node.run('stop', { hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(stop.delivered, true, stop.why);
  assert.deepEqual(node.seen.map((post) => post.payload.event), ['session-start', 'stop']);
  const replayed = node.seen[0];
  assert.equal(replayed.answer.status, 200, JSON.stringify(replayed.answer.body));
  assert.equal(Buffer.from(replayed.payload.transcript.bytes, 'base64').toString(), opening, 'the start carried only what it saw');
  assert.equal(replayed.stopcheck.offset, Buffer.byteLength(opening), 'anchored where the start fired, not at the mirror\'s end now');
  assert.equal(JSON.parse(stop.value.stdout).decision, 'block', 'the turn\'s edits are still judged');
  assert.equal(readStopcheck(root).edits, 5);
  assert.deepEqual(node.queued(), []);
});

test('a queued event whose transcript was replaced is dropped, and a replayed stop\'s marker carries the time it fired', async (t) => {
  const { hooks, root } = services(t, { root: registry(t), realSpawn: true });
  let down = true;
  const node = nodeClient(t, hooks, root, () => down);
  const opening = `${JSON.stringify({ type: 'mode', mode: 'default' })}\n`;
  fs.writeFileSync(node.transcriptFile, opening);
  const markerFile = path.join(root, '.keep', 'attention', 'sess-aws1.json');
  // They fired an hour ago, as far as the entries say.
  const firedAt = Date.now() - 3600e3;
  const backdate = () => {
    for (const file of node.queued()) {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      entry.body.identity.firedAt = firedAt;
      fs.writeFileSync(file, JSON.stringify(entry));
    }
  };

  // A stop, replayed: its completion marker says when it fired.
  await node.run('stop', { hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(node.queued().length, 1);
  backdate();
  down = false;
  const first = await node.run('lifecycle', { hook_event_name: 'PostToolUse' });
  assert.equal(first.delivered, true, first.why);
  assert.deepEqual(node.seen.map((post) => post.payload.event), ['stop', 'lifecycle']);
  assert.equal(node.seen[0].answer.status, 200, JSON.stringify(node.seen[0].answer.body));
  const complete = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  assert.equal(complete.type, 'complete');
  assert.equal(complete.at, firedAt, 'the completion is stamped when the stop fired');

  // A notification, replayed: the same.
  down = true;
  await node.run('notification', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'waiting' });
  backdate();
  down = false;
  await node.run('lifecycle', { hook_event_name: 'PostToolUse' });
  const waiting = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  assert.equal(waiting.type, 'waiting');
  assert.equal(waiting.at, firedAt);

  // The transcript is replaced (a new file at the same path) before a queued event
  // can go: that entry is dropped, with a line in the node's log.
  down = true;
  await node.run('notification', { hook_event_name: 'Notification', notification_type: 'idle_prompt' });
  assert.equal(node.queued().length, 1);
  fs.rmSync(node.transcriptFile);
  fs.writeFileSync(node.transcriptFile, opening);
  down = false;
  const posts = node.seen.length;
  const next = await node.run('lifecycle', { hook_event_name: 'PostToolUse' });
  assert.equal(next.delivered, true, next.why);
  assert.deepEqual(node.seen.slice(posts).map((post) => post.payload.event), ['lifecycle'], 'the stale entry never reached the daemon');
  assert.deepEqual(node.queued(), []);
  assert.match(fs.readFileSync(require('./hook-client.js').logFile(node.env), 'utf8'),
    /dropped queued notification for session sess-aws1 \(seq \d+\): the transcript was replaced after the event fired/);
});

test('on the daemon node KEEP_HOOK_FIRED_AT alone changes nothing', async (t) => {
  const root = registry(t);
  const transcriptFile = path.join(root, 'sess-local.jsonl');
  fs.writeFileSync(transcriptFile, `${JSON.stringify({ type: 'mode', mode: 'default' })}\n`);
  const env = { PATH: process.env.PATH, HOME: root, LANG: 'C', KEEP_DIR: root, KEEP_NO_PUSH: '1', KEEP_SYNC: '0',
    KEEP_CONFIG: path.join(root, 'config.json'), CLAUDE_CODE_SESSION_ID: 'sess-local', KEEP_HOOK_FIRED_AT: '1000' };
  const before = Date.now();
  const result = await runLocal(['hook', 'stop'], { env,
    input: JSON.stringify({ session_id: 'sess-local', transcript_path: transcriptFile, cwd: root, hook_event_name: 'Stop' }) });
  assert.equal(result.status, 0, result.stderr);
  const marker = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'attention', 'sess-local.json'), 'utf8'));
  assert.ok(marker.at >= before, 'stamped now, as always');
});

test('the daemon refuses a final message past its cap, and the node cuts one to fit before it posts', async (t) => {
  const route = require('./hook-route.js');
  const client = require('./hook-client.js');
  assert.equal(client.INPUT_MAX_BYTES, route.INPUT_MAX_BYTES, 'the node fits the daemon\'s caps');
  assert.equal(client.TEXT_CAPS.last_assistant_message, route.TEXT_MAX);

  const { hooks, calls, root } = services(t);
  const stop = (message, key) => body({ idempotencyKey: key,
    input: { session_id: 'sess-aws1', cwd: '/home/node/project', hook_event_name: 'Stop', last_assistant_message: message } });
  assert.equal((await hooks.handle(AWS1, stop('x'.repeat(route.TEXT_MAX), `${KEY}-at`))).status, 200, 'at the cap');
  const over = await hooks.handle(AWS1, stop('x'.repeat(route.TEXT_MAX + 1), `${KEY}-over`));
  assert.equal(over.status, 400);
  assert.match(over.body.error, /last_assistant_message is longer than 65536 bytes/);
  assert.equal(calls.length, 1);

  // The node: a long final report (two-byte characters, so the cut must land between
  // them) is still a stop the daemon runs, with the report's head.
  const node = nodeClient(t, hooks, root, () => false);
  fs.writeFileSync(node.transcriptFile, '{"n":1}\n');
  const report = 'é'.repeat(50 * 1024);
  const stopped = await node.run('stop', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: report });
  assert.equal(stopped.delivered, true, stopped.why);
  const sent = JSON.parse(calls.at(-1).stdin).last_assistant_message;
  assert.ok(Buffer.byteLength(sent) <= route.TEXT_MAX && Buffer.byteLength(sent) >= route.TEXT_MAX - 1);
  assert.ok(report.startsWith(sent), 'a prefix, cut on a character boundary');

  // A tool's result far past the whole input's cap: the largest field goes, the rest stays.
  const lifecycle = await node.run('lifecycle', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'toolu_1',
    tool_input: { command: 'cat big.log' }, tool_response: { content: 'y'.repeat(300 * 1024) } });
  assert.equal(lifecycle.delivered, true, lifecycle.why);
  const posted = node.seen.at(-1).payload.input;
  assert.equal(posted.tool_response, undefined);
  assert.deepEqual(posted.tool_input, { command: 'cat big.log' });
  assert.equal(posted.tool_use_id, 'toolu_1');
  assert.deepEqual(JSON.parse(calls.at(-1).stdin).tool_input, { command: 'cat big.log' });
  assert.deepEqual(calls.at(-1).args.slice(1), ['hook', 'lifecycle']);
});

test('the session env the daemon\'s hook reads is forwarded from an allow-list, and nothing else', async (t) => {
  const { hooks, calls, root } = services(t);
  const answer = await hooks.handle(AWS1, body({ identity: { agent: 'claude', sessionId: 'sess-aws1', env: {
    KEEP_REVIEWER: '1', KEEP_AUTO_CONTINUE: '0', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', KEEP_DELEGATION_ID: 'a1b2c3',
    PATH: '/elsewhere', NODE_OPTIONS: '--require /tmp/x.js', KEEP_DIR: '/elsewhere', KEEP_HOOK_NODE: 'main', KEEP_REVIEWER_NAME: 'x',
  } } }));
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const { env } = calls[0].options;
  assert.equal(env.KEEP_REVIEWER, '1');
  assert.equal(env.KEEP_AUTO_CONTINUE, '0');
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, 'sdk-ts');
  assert.equal(env.KEEP_DELEGATION_ID, 'a1b2c3');
  assert.equal(env.PATH, process.env.PATH, 'unknown keys dropped');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.KEEP_REVIEWER_NAME, undefined);
  assert.equal(env.KEEP_DIR, root);
  assert.equal(env.KEEP_HOOK_NODE, 'aws1');

  // Without identity.env the child has none of them.
  await hooks.handle(AWS1, body({ idempotencyKey: `${KEY}-plain` }));
  for (const key of ['KEEP_REVIEWER', 'KEEP_AUTO_CONTINUE', 'CLAUDE_CODE_ENTRYPOINT', 'KEEP_DELEGATION_ID']) {
    assert.equal(calls[1].options.env[key], undefined, key);
  }

  for (const [value, message] of [
    ['yes', /identity.env must be an object/],
    [{ KEEP_REVIEWER: 'yes please' }, /invalid identity.env.KEEP_REVIEWER/],
    [{ KEEP_AUTO_CONTINUE: 0 }, /invalid identity.env.KEEP_AUTO_CONTINUE/],
    [{ CLAUDE_CODE_ENTRYPOINT: 'sdk ts; rm' }, /invalid identity.env.CLAUDE_CODE_ENTRYPOINT/],
    [{ KEEP_DELEGATION_ID: 'x'.repeat(129) }, /invalid identity.env.KEEP_DELEGATION_ID/],
    [{ KEEP_DELEGATION_ID: '../d' }, /invalid identity.env.KEEP_DELEGATION_ID/],
  ]) {
    const refused = await hooks.handle(AWS1, body({ idempotencyKey: `${KEY}-bad`, identity: { agent: 'claude', sessionId: 'sess-aws1', env: value } }));
    assert.equal(refused.status, 400, JSON.stringify(value));
    assert.match(refused.body.error, message);
  }
  assert.equal(calls.length, 2);
});

test('the node forwards its session env, and the daemon\'s hook honours it', async (t) => {
  const client = require('./hook-client.js');
  const where = { url: 'http://127.0.0.1:1', local: 'aws1', daemon: 'main' };
  const identity = (env) => {
    let sent;
    return client.runHook('notification', { session_id: 'sess-aws1', cwd: '/x' }, where, { env: { HOME: tempDir(t), ...env }, token: 't',
      request: async (url, pathname, { payload }) => { sent = payload.identity; return { status: 200, data: JSON.stringify({ ok: true, status: 0, stdout: '' }) }; },
    }).then(() => sent);
  };
  assert.deepEqual((await identity({ KEEP_REVIEWER: '1', KEEP_AUTO_CONTINUE: '0', CLAUDE_CODE_ENTRYPOINT: 'cli', KEEP_DELEGATION_ID: 'd1', PATH: '/bin', KEEP_REVIEWER_NAME: 'x' })).env,
    { KEEP_REVIEWER: '1', KEEP_AUTO_CONTINUE: '0', CLAUDE_CODE_ENTRYPOINT: 'cli', KEEP_DELEGATION_ID: 'd1' });
  assert.deepEqual((await identity({ KEEP_REVIEWER: 'maybe', CLAUDE_CODE_ENTRYPOINT: 'cli' })).env, { CLAUDE_CODE_ENTRYPOINT: 'cli' }, 'a value the daemon would refuse is not sent');
  assert.equal((await identity({})).env, undefined);

  const { hooks, root } = services(t, { root: registry(t), realSpawn: true });
  const stop = (text, env, key) => hooks.handle(AWS1, body({
    identity: { agent: 'claude', sessionId: 'sess-aws1', ...(env ? { env } : {}) }, idempotencyKey: key,
    input: { session_id: 'sess-aws1', cwd: '/home/node/project', hook_event_name: 'Stop', stop_hook_active: false },
    transcript: transcript(text, { fromOffset: 0, generation: key.replace(/[^A-Za-z0-9]/g, '') }),
  }));
  // A reviewer on the node: five edits and no check-in, and no nag.
  const edits = `${JSON.stringify({ type: 'mode', mode: 'default' })}\n${toolUse('Edit').repeat(5)}`
    + `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } })}\n`;
  const reviewer = await stop(edits, { KEEP_REVIEWER: '1' }, `${KEY}-reviewer`);
  assert.equal(reviewer.status, 200, JSON.stringify(reviewer.body));
  assert.equal(reviewer.body.stdout, '', reviewer.body.stderr);
  assert.equal(fs.existsSync(path.join(root, '.keep', 'nagged', 'sess-aws1')), false);

  // A card linked to the session with a next step: auto-continued, unless the
  // session said KEEP_AUTO_CONTINUE=0.
  fs.writeFileSync(path.join(root, 'tasks', 'planned-card.md'), ['---', 'title: Planned card', 'status: active', 'kind: task',
    'project: /home/node/project', 'sessions:', '  - id: sess-aws1', '    agent: claude', '    at: 2026-09-02T12:00',
    'created: 2026-09-02', 'updated: 2026-09-02T12:00', '---', '## Plan', '- [ ] First step', '- [ ] Second step', ''].join('\n'));
  fs.rmSync(path.join(root, '.keep', 'stopcheck'), { recursive: true, force: true });
  const quiet = `${JSON.stringify({ type: 'mode', mode: 'default' })}\n${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Finished a chunk.' }] } })}\n`;
  const off = await stop(quiet, { KEEP_AUTO_CONTINUE: '0' }, `${KEY}-off`);
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.stdout, '', off.body.stderr);
  fs.rmSync(path.join(root, '.keep', 'stopcheck'), { recursive: true, force: true });
  const on = await stop(quiet, null, `${KEY}-on`);
  assert.match(JSON.parse(on.body.stdout).reason, /^\[keep\] Your card planned-card has a next step\./);
});

test('the location record\'s account is the one the hook runs with; the node\'s only fills a gap', async (t) => {
  const locations = {
    'sess-aws1': { node: 'aws1', agent: 'claude', accountId: 'claude-node' },
    'sess-bare': { node: 'aws1', agent: 'claude' },
  };
  const { hooks, calls } = services(t, { locations });
  const post = (sessionId, accountId, key) => hooks.handle(AWS1, body({ idempotencyKey: key,
    identity: { agent: 'claude', sessionId, ...(accountId ? { accountId } : {}) },
    input: { session_id: sessionId, cwd: '/home/node/project', hook_event_name: 'Stop' } }));
  assert.equal((await post('sess-aws1', null, `${KEY}-1`)).status, 200);
  assert.equal(calls.at(-1).options.env.KEEP_AGENT_ACCOUNT_ID, 'claude-node', 'the record, though the node named none');
  assert.equal((await post('sess-bare', 'claude-said', `${KEY}-2`)).status, 200);
  assert.equal(calls.at(-1).options.env.KEEP_AGENT_ACCOUNT_ID, 'claude-said', 'the node\'s, where the record has none');
  assert.equal((await post('sess-bare', null, `${KEY}-3`)).status, 200);
  assert.equal(calls.at(-1).options.env.KEEP_AGENT_ACCOUNT_ID, undefined);
  assert.equal((await post('sess-aws1', 'claude-other', `${KEY}-4`)).status, 403, 'a contradiction is still refused');
});

test('a question\'s input reaches the hook in a bounded shape', async (t) => {
  const { hooks, calls } = services(t);
  const answer = await hooks.handle(AWS1, body({ event: 'pre-question', input: {
    session_id: 'sess-aws1', cwd: '/home/node/project', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_9',
    tool_input: {
      questions: [
        { question: 'q'.repeat(10 * 1024), header: 'Pick', multiSelect: false, extra: 'x'.repeat(1000),
          options: [{ label: 'One', description: 'd'.repeat(2000) }, 'Two', 7, ...Array.from({ length: 30 }, (_, i) => ({ label: `o${i}` }))] },
        'not a question', { question: 'Second?' }, { question: 'Third?' }, { question: 'Fourth?' }, { question: 'Fifth?' },
      ],
      answers: { nested: { deep: 'x'.repeat(4000) } },
    },
  } }));
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const { tool_input: tool } = JSON.parse(calls[0].stdin);
  assert.deepEqual(Object.keys(tool), ['questions']);
  assert.equal(tool.questions.length, 3, 'four at most read, the malformed one skipped');
  const [first] = tool.questions;
  assert.equal(Buffer.byteLength(first.question), 4096);
  assert.equal(first.header, 'Pick');
  assert.equal(first.multiSelect, false);
  assert.equal(first.extra, undefined);
  assert.equal(first.options.length, 19, 'twenty at most, the non-option dropped');
  assert.deepEqual(first.options.slice(0, 3), [{ label: 'One' }, 'Two', { label: 'o0' }]);
  assert.deepEqual(tool.questions.slice(1), [{ question: 'Second?' }, { question: 'Third?' }]);
});

// ---------- the hook context a node's pre-bash reads ----------

function stepsRegistry(root) {
  fs.mkdirSync(path.join(root, 'steps'), { recursive: true });
  fs.writeFileSync(path.join(root, 'steps', 'infra.json'), JSON.stringify({ project: path.join(root, 'infra'), steps: {
    apply: { command: 'cd infra && terraform apply -auto-approve' },
    bake: { guard: ['build_packer_image.sh', 'terraform apply'] },
    deploy: { guard: false, command: 'keep restart-daemon' },
    odd: { guard: ['two\nlines', 'x'.repeat(300)] },
  } }));
  fs.writeFileSync(path.join(root, 'steps', 'broken.json'), '{ not json');
}

test('the hook context is on the node API only, for nodes', async () => {
  const fake = { context: () => ({ status: 200, body: { steps: [], repairSession: false } }) };
  const json = (res, status, value) => ({ status, value });
  const req = { method: 'GET' };
  const url = new URL('http://x/api/hook/context?session=sess-aws1');
  assert.equal(matchRoute(routes({ json, hookService: fake }), { req, url }), null);
  const route = matchRoute(routes({ json, nodeApiEnabled: () => true, hookService: fake }), { req, url });
  assert.equal(route.path, '/api/hook/context');
  assert.equal(routeDenial(route, AWS1), null);
  assert.deepEqual(routeDenial(route, { class: 'admin' }), { status: 403, error: 'forbidden for admin' });
  assert.deepEqual(await route.handle({ req, res: {}, url, principal: AWS1 }), { status: 200, value: { steps: [], repairSession: false } });
});

test('the hook context publishes the step fingerprints and whether the daemon launched the session to repair it', async (t) => {
  const root = tempDir(t);
  stepsRegistry(root);
  let card = '';
  const { hooks, calls } = services(t, { root, cardForSession: (sessionId, at) => {
    assert.equal(sessionId, 'sess-aws1');
    assert.equal(at, root);
    if (card === 'throw') throw new Error('unreadable');
    return card;
  } });
  assert.deepEqual(hooks.context(AWS1, 'sess-aws1'), { status: 200, body: { steps: ['build_packer_image.sh', 'terraform apply'], repairSession: false } });
  card = 'repair-card';
  assert.equal(hooks.context(AWS1, 'sess-aws1').body.repairSession, true);
  card = 'throw';
  assert.equal(hooks.context(AWS1, 'sess-aws1').body.repairSession, true, 'a record that cannot be read refuses more, never less');
  for (const [who, session, status, message] of [
    [AWS1, 'sess-main', 403, /not on node aws1/],
    [AWS1, 'codex-aws1', 403, /is a codex session/],
    [AWS1, '../x', 400, /invalid session id/],
    [AWS1, null, 400, /invalid session id/],
    [{ class: 'admin' }, 'sess-aws1', 403, /for sessions on other nodes/],
    [{ class: 'node', node: 'main' }, 'sess-aws1', 403, /unauthorized/],
  ]) {
    const answer = hooks.context(who, session);
    assert.equal(answer.status, status, JSON.stringify(answer));
    assert.match(answer.body.error, message);
  }
  assert.equal(calls.length, 0, 'nothing ran');
  // Bounded: at most 256 fingerprints.
  fs.writeFileSync(path.join(root, 'steps', 'many.json'), JSON.stringify({ project: path.join(root, 'many'),
    steps: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`s${i}`, { guard: [`tool${String(i).padStart(3, '0')} run`] }])) }));
  assert.equal(hooks.context(AWS1, 'sess-aws1').body.steps.length, 256);
});

test('a node asks for the hook context at most once a minute, and keeps the last answer when the daemon is gone', async (t) => {
  const client = require('./hook-client.js');
  const env = { HOME: tempDir(t) };
  const where = { url: 'http://127.0.0.1:1', local: 'aws1', daemon: 'main' };
  let clock = 1_000_000;
  let answer = { status: 200, data: JSON.stringify({ steps: ['terraform apply'], repairSession: false }) };
  const asked = [];
  const deps = { now: () => clock, request: async (url, pathname, options) => {
    asked.push({ pathname, method: options.method, token: options.token });
    if (answer === 'down') throw new Error('connect ECONNREFUSED');
    return answer;
  } };
  const context = (sessionId = 'sess-aws1') => client.hookContext({ env, where, token: 't', sessionId, deps });
  assert.deepEqual(await context(), { steps: ['terraform apply'], repairSession: false, fresh: true });
  assert.deepEqual(asked, [{ pathname: '/api/hook/context?session=sess-aws1', method: 'GET', token: 't' }]);
  clock += 30e3;
  assert.deepEqual(await context(), { steps: ['terraform apply'], repairSession: false, fresh: true });
  assert.equal(asked.length, 1, 'from the cache within the minute');
  // Another session is asked for: whether it is a repair session is its own.
  answer = { status: 200, data: JSON.stringify({ steps: ['terraform apply'], repairSession: true }) };
  assert.equal((await context('sess-other')).repairSession, true);
  assert.equal(asked.length, 2);
  clock += 31e3;
  answer = 'down';
  assert.deepEqual(await context(), { steps: ['terraform apply'], repairSession: false, fresh: false }, 'the last answer, marked stale');
  assert.equal(asked.length, 3);
  // An answer that is not a fingerprint list is not taken.
  for (const bad of [{ steps: 'terraform apply', repairSession: false }, { steps: ['a\nb'], repairSession: false },
    { steps: ['ok'], repairSession: 'no' }, { steps: Array.from({ length: 257 }, (_, i) => `s${i}`), repairSession: false }]) {
    answer = { status: 200, data: JSON.stringify(bad) };
    assert.deepEqual(await context(), { steps: ['terraform apply'], repairSession: false, fresh: false }, JSON.stringify(bad).slice(0, 60));
  }
  answer = { status: 403, data: JSON.stringify({ error: 'nope' }) };
  assert.equal((await context()).fresh, false);
  const cache = JSON.parse(fs.readFileSync(client.contextFile(env), 'utf8'));
  assert.deepEqual(cache.steps, ['terraform apply']);
  assert.deepEqual(Object.keys(cache.sessions).sort(), ['sess-aws1', 'sess-other']);
  // Nothing ever said: no fingerprints, and nothing known of the session.
  assert.deepEqual(await client.hookContext({ env: { HOME: tempDir(t) }, where, token: 't', sessionId: 'sess-aws1', deps }),
    { steps: [], repairSession: null, fresh: false });
});

// ---------- pre-bash through the route ----------

function bashBody(root, command, extra = {}) {
  const cwd = path.join(root, 'wt', 'infra', 'feature');
  return body({
    event: 'pre-bash', idempotencyKey: `${KEY}-${Math.random().toString(36).slice(2)}`,
    identity: { agent: 'claude', sessionId: 'sess-aws1', ...(extra.identity || {}) },
    input: { session_id: 'sess-aws1', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1',
      tool_input: { command, description: 'dropped', timeout: 5 },
      // The node's worktree of ~/infra, which is not on this disk at all: only its facts say where it is.
      repo_facts: extra.facts || { paths: { [cwd]: { top: cwd, main: path.join(root, 'infra') } }, deploy: null, head: {} } },
  });
}

test('a pre-bash post is refused unless it is a Bash command with repository facts of the right shape', async (t) => {
  const { hooks, calls, root } = services(t);
  const cwd = path.join(root, 'wt', 'infra', 'feature');
  const facts = (value) => bashBody(root, 'ls', { facts: value });
  const withInput = (patch) => { const request = bashBody(root, 'ls'); Object.assign(request.input, patch); return request; };
  const cases = [
    [withInput({ tool_name: 'Read' }), /pre-bash is for Bash only/],
    [withInput({ tool_input: 'ls' }), /tool_input must be an object/],
    [withInput({ tool_input: { command: 'x'.repeat(65 * 1024) } }), /tool_input.command is longer than/],
    [withInput({ repo_facts: undefined }), /repo_facts is required/],
    [withInput({ hook_event_name: 'PostToolUse' }), /is not a pre-bash event/],
    [facts({ paths: { '/etc': { top: null, main: null } } }), /must be under the home/],
    [facts({ paths: { [cwd]: { top: '/opt/x', main: null } } }), /repo_facts top must be under the home/],
    [facts({ paths: { [cwd]: { top: `${root}/../x`, main: null } } }), /may not contain \.\./],
    [facts({ paths: { [cwd]: 'top' } }), /entry must be an object/],
    [facts({ paths: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [path.join(root, `d${i}`), { top: null, main: null }])) }), /more than 8 paths/],
    [facts({ head: { [cwd]: 'HEAD' } }), /invalid repo_facts.head sha/],
    [facts({ deploy: { dir: cwd, repo: cwd, sha: 'a'.repeat(40), dirty: [], branch: 'main; rm -rf', onOrigin: true } }), /invalid repo_facts.deploy.branch/],
    [facts({ deploy: { dir: cwd, repo: cwd, sha: 'a'.repeat(40), dirty: ['x'.repeat(3000), 'y'.repeat(3000)], branch: 'main', onOrigin: true } }), /dirty is longer than 4096/],
    [facts({ deploy: { dir: cwd, repo: cwd, sha: 'a'.repeat(40), dirty: [], branch: 'main', onOrigin: 'yes' } }), /onOrigin must be a boolean/],
  ];
  for (const [request, message] of cases) {
    const answer = await hooks.handle(AWS1, request);
    assert.equal(answer.status, 400, `${JSON.stringify(request.input).slice(0, 200)}: ${JSON.stringify(answer.body)}`);
    assert.match(answer.body.error, message);
  }
  assert.equal(calls.length, 0, 'nothing ran');

  // A good one reaches the hook with the command, the facts and nothing else of the call.
  const good = bashBody(root, 'ls');
  assert.equal((await hooks.handle(AWS1, good)).status, 200);
  const input = JSON.parse(calls[0].stdin);
  assert.deepEqual(input.tool_input, { command: 'ls' });
  assert.deepEqual(input.repo_facts, { paths: { [cwd]: { top: cwd, main: path.join(root, 'infra') } }, deploy: null, head: {} });
  assert.equal(input.tool_use_id, 'toolu_1');
  assert.deepEqual(calls[0].args.slice(1), ['hook', 'pre-bash']);
});

test('KEEP_REPAIR reaches a node\'s pre-bash only from the daemon\'s own repair record', async (t) => {
  let card = '';
  const { hooks, calls, root } = services(t, { cardForSession: () => card });
  const post = async (env) => {
    const answer = await hooks.handle(AWS1, bashBody(root, 'keep restart-daemon', { identity: { env } }));
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return calls.at(-1).options.env;
  };
  const forwarded = await post({ KEEP_REPAIR: '1', KEEP_STEP_OK: '1', KEEP_RAW_CLAUDE: '1' });
  assert.equal(forwarded.KEEP_REPAIR, undefined, 'the node\'s word is dropped');
  assert.equal(forwarded.KEEP_STEP_OK, '1', 'the session\'s own bypasses are forwarded');
  assert.equal(forwarded.KEEP_RAW_CLAUDE, '1');
  card = 'repair-card';
  assert.equal((await post({})).KEEP_REPAIR, '1', 'the daemon launched it to repair itself');
  // Only a pre-bash carries it.
  await hooks.handle(AWS1, body({ idempotencyKey: `${KEY}-stop` }));
  assert.equal(calls.at(-1).options.env.KEEP_REPAIR, undefined);
});

test('a registered step on the daemon refuses its command on the node, by the node\'s facts, and lets the rest through', async (t) => {
  const root = registry(t);
  stepsRegistry(root);
  let card = '';
  const { hooks } = services(t, { root, realSpawn: true, cardForSession: () => card });
  const run = async (command, extra) => {
    const answer = await hooks.handle(AWS1, bashBody(root, command, extra));
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return answer.body;
  };
  const refused = await run('terraform apply -auto-approve');
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /^keep guard: `terraform apply` is step apply on ~\/infra, which runs through Keep/);
  // Walking into it from elsewhere on the node is the same command.
  const home = root;
  const walked = await run(`cd ${path.join(home, 'wt', 'infra', 'feature')} && terraform apply`, { facts: { paths: {
    [path.join(root, 'wt', 'infra', 'feature')]: { top: path.join(root, 'wt', 'infra', 'feature'), main: path.join(root, 'infra') },
  } } });
  assert.equal(walked.status, 2, walked.stderr);
  // Without the facts the daemon knows nothing of the node's worktree: the facts are what decided.
  assert.equal((await run('terraform apply', { facts: { paths: {} } })).status, 0);
  assert.equal((await run('terraform apply', { identity: { env: { KEEP_STEP_OK: '1' } } })).status, 0, 'the session\'s own bypass');
  const plain = await run('ls -la && git status');
  assert.deepEqual([plain.status, plain.stdout, plain.stderr], [0, '', '']);
  // The resume guard holds on the daemon too.
  assert.equal((await run('claude --resume abc')).status, 2);
  // A repair session's restart: refused only when the daemon says it is one.
  assert.equal((await run('keep restart-daemon', { identity: { env: { KEEP_REPAIR: '1' } } })).status, 0);
  card = 'repair-card';
  const repair = await run('keep restart-daemon');
  assert.equal(repair.status, 2);
  assert.match(repair.stderr, /keep guard: `keep restart-daemon` restarts the daemon you were launched to repair/);
});

// ---------- post-bash through the route ----------

function gitIn(cwd, ...args) {
  return require('node:child_process').execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A registry root that is a git checkout (check-ins commit), a card linked to the
// node's session, and ~/infra as a project with a registered step.
function recordingRegistry(t) {
  const root = registry(t);
  fs.writeFileSync(path.join(root, '.gitignore'), '.keep/\n');
  gitIn(root, 'init', '-q');
  gitIn(root, 'config', 'user.email', 'keep@example.test');
  gitIn(root, 'config', 'user.name', 'Keep Test');
  stepsRegistry(root);
  const infra = path.join(root, 'infra');
  fs.mkdirSync(infra);
  gitIn(infra, 'init', '-q', '--initial-branch=main');
  gitIn(infra, 'config', 'user.email', 'keep@example.test');
  gitIn(infra, 'config', 'user.name', 'Keep Test');
  fs.writeFileSync(path.join(infra, 'main.tf'), '# infra\n');
  gitIn(infra, 'add', '.');
  gitIn(infra, 'commit', '-qm', 'infra');
  fs.writeFileSync(path.join(root, 'tasks', 'ship-card.md'), ['---', 'title: Ship it', 'status: active', 'kind: task', 'tags: [personal]',
    `project: ${infra}`, 'sessions:', '  - id: sess-aws1', '    agent: claude', '    at: 2026-09-02T12:00',
    'created: 2026-09-02', 'updated: 2026-09-02T12:00', '---', '', '## 2026-09-02 12:00 — check-in', 'Working.', ''].join('\n'));
  gitIn(root, 'add', '.');
  gitIn(root, 'commit', '-qm', 'fixture');
  return { root, infra, card: () => fs.readFileSync(path.join(root, 'tasks', 'ship-card.md'), 'utf8') };
}

function postBody(root, command, facts, response = { stdout: '', stderr: '', interrupted: false }) {
  const cwd = path.join(root, 'wt', 'infra', 'feature');
  return body({
    event: 'post-bash', idempotencyKey: `${KEY}-${Math.random().toString(36).slice(2)}`,
    identity: { agent: 'claude', sessionId: 'sess-aws1' },
    input: { session_id: 'sess-aws1', cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command },
      tool_response: response, repo_facts: { paths: { [cwd]: { top: cwd, main: path.join(root, 'infra') } }, deploy: null, head: {}, ...facts } },
  });
}

test('a post-bash post carries the call\'s response in a bounded shape', async (t) => {
  const { hooks, calls, root } = services(t);
  const withResponse = (response) => postBody(root, 'ls', {}, response);
  for (const [response, message] of [
    [{ stdout: 'x'.repeat(65 * 1024) }, /stdout is longer than/],
    [{ exit_code: '1' }, /exit_code must be an integer/],
    [{ interrupted: 'no' }, /interrupted must be a boolean/],
    [7, /must be an object or a string/],
  ]) {
    const answer = await hooks.handle(AWS1, withResponse(response));
    assert.equal(answer.status, 400, JSON.stringify(response));
    assert.match(answer.body.error, message);
  }
  assert.equal((await hooks.handle(AWS1, withResponse({ stdout: 'out', stderr: 'err', exitCode: 0, interrupted: false, isImage: false, extra: 'x' }))).status, 200);
  assert.deepEqual(JSON.parse(calls[0].stdin).tool_response, { stdout: 'out', stderr: 'err', exitCode: 0, interrupted: false });
  assert.deepEqual(calls[0].args.slice(1), ['hook', 'post-bash']);
  assert.equal(calls[0].options.env.KEEP_REPAIR, undefined);
});

test('a deploy on the node is recorded on its card with the provenance the node read', async (t) => {
  const f = recordingRegistry(t);
  const { hooks } = services(t, { root: f.root, realSpawn: true, env: { KEEP_PORT: '65432' } });
  const cwd = path.join(f.root, 'wt', 'infra', 'feature');
  const sha = 'a'.repeat(40);
  const answer = await hooks.handle(AWS1, postBody(f.root, 'git push heroku main', {
    deploy: { dir: cwd, repo: cwd, sha, dirty: ['scratch.txt'], branch: 'main', onOrigin: false },
  }));
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.status, 0, answer.body.stderr);
  assert.match(f.card(), /— deployed\ndeployed aaaaaaa to heroku \(remote heroku\) — \+dirty: 1 file \(scratch\.txt\) — not on origin\/main at deploy time \(local tracking ref\) — repo ~\/wt\/infra\/feature\nCommand: `git push heroku main`/);
  // Provenance from another directory than the one the command ran in is none at all.
  const elsewhere = await hooks.handle(AWS1, postBody(f.root, 'git push heroku main', {
    deploy: { dir: path.join(f.root, 'other'), repo: cwd, sha, dirty: [], branch: 'main', onOrigin: true },
  }));
  assert.equal(elsewhere.status, 200);
  assert.match(f.card(), /Deployed to heroku \(remote heroku\) from ~\/wt\/infra\/feature, which is not a git checkout/);
});

test('a step run by hand on the node is recorded at the node\'s HEAD, and a sha this disk has never seen does not break the hook', async (t) => {
  const f = recordingRegistry(t);
  const { hooks } = services(t, { root: f.root, realSpawn: true, env: { KEEP_PORT: '65432' } });
  const cwd = path.join(f.root, 'wt', 'infra', 'feature');
  const claim = () => {
    const env = { ...process.env, HOME: f.root, KEEP_DIR: f.root, KEEP_NO_PUSH: '1', KEEP_PORT: '65432', CLAUDE_CODE_SESSION_ID: 'sess-aws1' };
    for (const key of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'KEEP_PANE', 'KEEP_CONFIG']) delete env[key];
    const out = require('node:child_process').spawnSync(process.execPath, [CLI, 'step', 'claim', '~/infra', 'apply', '--task', 'ship-card', '--for', '+30m', '-m', 'apply'],
      { cwd: f.infra, env, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
  };
  const ledger = () => JSON.parse(fs.readFileSync(path.join(f.root, '.keep', 'steps', 'infra', 'apply.json'), 'utf8'));
  // Unpushed on the node: this disk has never seen it.
  claim();
  const nodeOnly = 'b'.repeat(40);
  const first = await hooks.handle(AWS1, postBody(f.root, 'terraform apply -auto-approve', { head: { [cwd]: nodeOnly } }, { stdout: 'Apply complete!', stderr: '' }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.status, 0, first.body.stderr);
  assert.match(first.body.stderr, /recorded step apply done from bbbbbbb and released hold-/);
  const run = ledger().runs.at(-1);
  assert.deepEqual([run.status, run.sha, run.unverified, run.by.sessionId], ['done', nodeOnly, true, 'sess-aws1']);
  // A sha this disk has is recorded as it always was.
  claim();
  const known = gitIn(f.infra, 'rev-parse', 'HEAD');
  const second = await hooks.handle(AWS1, postBody(f.root, 'terraform apply', { head: { [cwd]: known } }, { stdout: 'Apply complete!', stderr: '' }));
  assert.equal(second.body.status, 0, second.body.stderr);
  const verified = ledger().runs.at(-1);
  assert.deepEqual([verified.sha, verified.unverified], [known, undefined]);
  // Without a claim of its own the node's run records nothing, as for a local session.
  const unclaimed = await hooks.handle(AWS1, postBody(f.root, 'terraform apply', { head: { [cwd]: known } }));
  assert.match(unclaimed.body.stderr, /ran by hand with no claim; the ledger is unchanged/);
  assert.equal(ledger().runs.length, 2);
});
