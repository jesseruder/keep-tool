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
  const hooks = createHookService({ root, registry, stopping: overrides.stopping });
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
    [AWS1, body({ event: 'pre-bash' }), 400, /is not a hook event/],
    [AWS1, body({ event: 'post-bash' }), 400, /is not a hook event/],
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
