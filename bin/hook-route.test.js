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
  'codex-aws1': { node: 'aws1', agent: 'codex', accountId: 'codex-node' },
  'pi-aws1': { node: 'aws1', agent: 'pi' },
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
    [AWS1, body({ identity: { agent: 'codex', sessionId: 'codex-aws1' } }), 400, /stop is a Claude hook/],
    [AWS1, body({ identity: { agent: 'pi', sessionId: 'pi-aws1' } }), 400, /stop is a claude hook, not a pi one/],
    [AWS1, body({ identity: { agent: 'gemini', sessionId: 'sess-aws1' } }), 400, /only Claude, Codex and Pi hooks/],
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
    // Only the refusal of the session as not on the node is named; a pane's is not.
    assert.equal(answer.body.code, /^session \S+ is not on node /.test(answer.body.error) ? 'SESSION_NOT_ON_NODE' : undefined, answer.body.error);
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
  // The service answers after a tick: the route awaits it (it may adopt first).
  const asked = [];
  const fake = { context: async (...args) => {
    asked.push(args);
    await new Promise((resolve) => setImmediate(resolve));
    return { status: 200, body: { steps: [], repairSession: false } };
  } };
  const json = (res, status, value) => ({ status, value });
  const req = { method: 'GET' };
  const withIdentity = new URL('http://x/api/hook/context?session=codex-aws1&agent=codex&pane=p2%40aws1');
  const identified = matchRoute(routes({ json, nodeApiEnabled: () => true, hookService: fake }), { req, url: withIdentity });
  assert.deepEqual(await identified.handle({ req, res: {}, url: withIdentity, principal: AWS1 }), { status: 200, value: { steps: [], repairSession: false } });
  assert.deepEqual(asked.pop(), [AWS1, 'codex-aws1', { pane: 'p2@aws1', agent: 'codex' }]);
  const url = new URL('http://x/api/hook/context?session=sess-aws1');
  assert.equal(matchRoute(routes({ json, hookService: fake }), { req, url }), null);
  const route = matchRoute(routes({ json, nodeApiEnabled: () => true, hookService: fake }), { req, url });
  assert.equal(route.path, '/api/hook/context');
  assert.equal(routeDenial(route, AWS1), null);
  assert.deepEqual(routeDenial(route, { class: 'admin' }), { status: 403, error: 'forbidden for admin' });
  assert.deepEqual(await route.handle({ req, res: {}, url, principal: AWS1 }), { status: 200, value: { steps: [], repairSession: false } });
});

test('the hook mirror query is on the node API only, for nodes', async () => {
  const asked = [];
  const fake = { mirror: async (...args) => { asked.push(args); return { status: 200, body: { generation: null, size: 0 } }; } };
  const json = (res, status, value) => ({ status, value });
  const req = { method: 'GET' };
  const url = new URL('http://x/api/hook/mirror?session=sess-aws1');
  assert.equal(matchRoute(routes({ json, hookService: fake }), { req, url }), null);
  const route = matchRoute(routes({ json, nodeApiEnabled: () => true, hookService: fake }), { req, url });
  assert.equal(route.path, '/api/hook/mirror');
  assert.equal(routeDenial(route, AWS1), null);
  assert.deepEqual(routeDenial(route, { class: 'admin' }), { status: 403, error: 'forbidden for admin' });
  assert.deepEqual(await route.handle({ req, res: {}, url, principal: AWS1 }), { status: 200, value: { generation: null, size: 0 } });
  assert.deepEqual(asked, [[AWS1, 'sess-aws1']]);
});

test('the hook mirror query answers how much of the session\'s transcript the daemon holds, only to the session\'s node', async (t) => {
  const { hooks, calls, root } = services(t);
  assert.deepEqual(await hooks.mirror(AWS1, 'sess-aws1'), { status: 200, body: { generation: null, size: 0 } }, 'no mirror yet');
  const text = '{"n":1}\n{"n":2}\n';
  const appended = mirror.append({ root, node: 'aws1', sessionId: 'sess-aws1', generation: '10:20:30', fromOffset: 0, bytes: Buffer.from(text),
    size: Buffer.byteLength(text) + 100, mtimeMs: 1_700_000_000_000, sourcePath: '/home/node/.claude/projects/p/sess-aws1.jsonl' });
  assert.equal(appended.ok, true, JSON.stringify(appended));
  assert.deepEqual(await hooks.mirror(AWS1, 'sess-aws1'),
    { status: 200, body: { generation: '10:20:30', size: Buffer.byteLength(text), mtimeMs: 1_700_000_000_000 } });
  for (const [who, session, status, message, code] of [
    [AWS1, 'sess-main', 403, /session sess-main is not on node aws1/, 'SESSION_NOT_ON_NODE'],
    [AWS1, 'nobody', 403, /is not on node aws1/, 'SESSION_NOT_ON_NODE'],
    [AWS1, '../x', 400, /invalid session id/],
    [AWS1, null, 400, /invalid session id/],
    [{ class: 'admin' }, 'sess-aws1', 403, /for sessions on other nodes/],
    [{ class: 'node', node: 'main' }, 'sess-aws1', 403, /unauthorized/],
    [{ class: 'node', node: 'other' }, 'sess-aws1', 403, /session sess-aws1 is not on node other/, 'SESSION_NOT_ON_NODE'],
  ]) {
    const answer = await hooks.mirror(who, session);
    assert.equal(answer.status, status, JSON.stringify(answer));
    assert.match(answer.body.error, message);
    assert.equal(answer.body.code, code);
    assert.equal(answer.body.size, undefined, 'nothing of the mirror is said');
  }
  assert.equal(calls.length, 0, 'nothing ran');
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
  assert.deepEqual(await hooks.context(AWS1, 'sess-aws1'), { status: 200, body: { steps: ['build_packer_image.sh', 'terraform apply'], repairSession: false } });
  card = 'repair-card';
  assert.equal((await hooks.context(AWS1, 'sess-aws1')).body.repairSession, true);
  card = 'throw';
  assert.equal((await hooks.context(AWS1, 'sess-aws1')).body.repairSession, true, 'a record that cannot be read refuses more, never less');
  card = '';
  for (const [who, session, status, message] of [
    [AWS1, 'sess-main', 403, /not on node aws1/],
    [AWS1, '../x', 400, /invalid session id/],
    [AWS1, null, 400, /invalid session id/],
    [{ class: 'admin' }, 'sess-aws1', 403, /for sessions on other nodes/],
    [{ class: 'node', node: 'main' }, 'sess-aws1', 403, /unauthorized/],
  ]) {
    const answer = await hooks.context(who, session);
    assert.equal(answer.status, status, JSON.stringify(answer));
    assert.match(answer.body.error, message);
  }
  assert.equal((await hooks.context(AWS1, 'codex-aws1')).status, 200, 'a Codex pre-tool refuses by the same fingerprints');
  assert.equal(calls.length, 0, 'nothing ran');
  // Bounded: at most 256 fingerprints.
  fs.writeFileSync(path.join(root, 'steps', 'many.json'), JSON.stringify({ project: path.join(root, 'many'),
    steps: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`s${i}`, { guard: [`tool${String(i).padStart(3, '0')} run`] }])) }));
  assert.equal((await hooks.context(AWS1, 'sess-aws1')).body.steps.length, 256);
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
  // A base the node posted nothing for is taken as the step's: refused, never skipped.
  const unreported = await run('terraform apply', { facts: { paths: {} } });
  assert.equal(unreported.status, 2);
  assert.match(unreported.stderr, /looks like step apply on ~\/infra, and node aws1 did not report the repository at .*wt\/infra\/feature, so the guard cannot tell/);
  const ninth = await run(`cd ${path.join(root, 'elsewhere')} && terraform apply`);
  assert.equal(ninth.status, 2, 'a cd target without facts');
  assert.match(ninth.stderr, /did not report the repository at .*elsewhere/);
  // A base the node reported as no repository is no step, and one outside the home cannot be reported.
  const cwd = path.join(root, 'wt', 'infra', 'feature');
  assert.equal((await run('terraform apply', { facts: { paths: { [cwd]: { top: null, main: null } } } })).status, 0);
  assert.equal((await run('cd /opt/elsewhere && terraform apply', { facts: { paths: { [cwd]: { top: null, main: null } } } })).status, 0);
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
  assert.match(f.card(), /— deployed\ndeployed aaaaaaa to heroku \(remote heroku\) — \+dirty: 1 file \(scratch\.txt\) — not on origin\/main at deploy time \(local tracking ref\) — repo ~\/wt\/infra\/feature \(as node aws1 read it\)\nCommand: `git push heroku main`/);
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
  // Facts that ran out before HEAD: not recorded at all, never at this disk's origin.
  claim();
  const headless = await hooks.handle(AWS1, postBody(f.root, 'terraform apply', { head: {} }, { stdout: 'Apply complete! ami-0badf00dcafe', stderr: '' }));
  assert.equal(headless.body.status, 0, headless.body.stderr);
  assert.match(headless.body.stderr, /step apply ran by hand but could not be recorded \(the node did not report HEAD\); record it: keep step done ~\/infra apply --sha <the commit it ran from>/);
  assert.equal(ledger().runs.length, 2, 'nothing recorded');
  // And finalizeStep itself refuses a node run without a sha.
  const { finalizeStep } = require('./commands/step.js');
  await assert.rejects(finalizeStep({ project: '~/infra', steps: {} }, 'apply', {}, { nodeSha: true, sha: '' }),
    /ran on another node, which did not report the commit it ran from/);
});

test('a self-repair state file that is there but unreadable makes every node session a repair session', async (t) => {
  const { hooks, calls, root } = services(t);
  const stateFile = require('./self-repair.js').stateFile(root);
  assert.equal((await hooks.context(AWS1, 'sess-aws1')).body.repairSession, false, 'no state file: no repairs');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ signatures: { sig: { sessionId: 'sess-other', cardId: 'repair-card' } } }));
  assert.equal((await hooks.context(AWS1, 'sess-aws1')).body.repairSession, false, 'another session\'s repair');
  fs.writeFileSync(stateFile, JSON.stringify({ signatures: { sig: { sessionId: 'sess-aws1', cardId: 'repair-card' } } }));
  assert.equal((await hooks.context(AWS1, 'sess-aws1')).body.repairSession, true, 'this session\'s repair');
  for (const corrupt of ['{ not json', '[]', 'null']) {
    fs.writeFileSync(stateFile, corrupt);
    assert.equal((await hooks.context(AWS1, 'sess-aws1')).body.repairSession, true, corrupt);
  }
  // The pre-bash run gets the marker too.
  const answer = await hooks.handle(AWS1, bashBody(root, 'ls'));
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(calls.at(-1).options.env.KEEP_REPAIR, '1');
});

// ---------- Codex sessions ----------

const CODEX_ROLLOUT = '/home/node/.codex/sessions/2026/09/22/rollout-2026-09-22T10-00-00-codex-aws1.jsonl';

function codexBody(event, input = {}, extra = {}) {
  return {
    event,
    input: { session_id: 'codex-aws1', transcript_path: CODEX_ROLLOUT, cwd: '/home/node/project', ...input },
    identity: { agent: 'codex', sessionId: 'codex-aws1', pane: 'p2@aws1', accountId: 'codex-node' },
    transcript: null,
    idempotencyKey: `${KEY}-${event}`,
    ...extra,
  };
}

const NO_FACTS = { paths: {}, deploy: null, head: {} };

test('a Codex post is refused unless it is a codex-* event for a Codex session on the calling node, in its input shape', async (t) => {
  const { hooks, calls, root } = services(t);
  const cases = [
    [codexBody('codex-stop', {}, { identity: { agent: 'claude', sessionId: 'sess-aws1' } }), 400, /codex-stop is a Codex hook/],
    [codexBody('codex-stop', { session_id: 'sess-aws1' }, { identity: { agent: 'codex', sessionId: 'sess-aws1' } }), 403, /is a claude session, not codex/],
    [codexBody('codex-stop', { session_id: 'sess-main' }, { identity: { agent: 'codex', sessionId: 'sess-main' } }), 403, /not on node aws1/],
    [codexBody('codex-stop', {}, { identity: { agent: 'codex', sessionId: 'codex-aws1', pane: 'p2@main' } }), 403, /is not on node aws1/],
    [codexBody('codex-stop', {}, { identity: { agent: 'codex', sessionId: 'codex-aws1', accountId: 'codex-other' } }), 403, /runs on account codex-node/],
    [codexBody('codex-stop', { hook_event_name: 'SessionStart' }), 400, /is not a codex-stop event/],
    [codexBody('codex-stop', { stop_hook_active: 'no' }), 400, /stop_hook_active must be a boolean/],
    [codexBody('codex-lifecycle'), 400, /hook_event_name is required/],
    [codexBody('codex-stop', { cwd: 'relative' }), 400, /input.cwd must be an absolute path/],
    [codexBody('codex-pre-tool', { tool_name: 'shell', tool_input: { command: 'ls' } }), 400, /repo_facts is required/],
    [codexBody('codex-pre-tool', { tool_input: { command: 'ls' }, repo_facts: NO_FACTS }), 400, /needs input.tool_name/],
    [codexBody('codex-pre-tool', { tool_name: 'shell', tool_input: { command: 'x'.repeat(70 * 1024) }, repo_facts: NO_FACTS }), 400, /longer than/],
    [codexBody('codex-pre-tool', { tool_name: 'shell', tool_input: { command: [1, 2] }, repo_facts: NO_FACTS }), 400, /must be a string/],
    [codexBody('codex-pre-tool', { tool_name: 'shell', tool_input: { command: 'ls', workdir: '/a/../b' }, repo_facts: NO_FACTS }), 400, /may not contain \.\./],
    [codexBody('codex-post-tool', { tool_name: 'shell', tool_input: { command: 'ls' }, repo_facts: NO_FACTS, tool_response: { exit_code: 'one' } }), 400, /exit_code must be an integer/],
    [codexBody('codex-client-end', { client_token: 'bad token' }), 400, /invalid input.client_token/],
    [codexBody('codex-client-end', { client_token: 'x'.repeat(257) }), 400, /invalid input.client_token/],
    [codexBody('codex-client-end', { client_token: 'tok' }, { identity: { agent: 'codex' }, transcript: transcript('x') }), 400, /carries no transcript/],
    [codexBody('codex-stop', {}, { identity: { agent: 'codex', sessionId: 'codex-aws1', env: { KEEP_CODEX_CLIENT_TOKEN: 'a b' } } }), 400, /identity.env.KEEP_CODEX_CLIENT_TOKEN/],
    [codexBody('codex-nonsense'), 400, /is not a hook event/],
  ];
  for (const [request, status, message] of cases) {
    const answer = await hooks.handle(AWS1, request);
    assert.equal(answer.status, status, `${JSON.stringify(request).slice(0, 200)}: ${JSON.stringify(answer.body)}`);
    assert.match(answer.body.error, message);
  }
  assert.equal(calls.length, 0, 'nothing ran');
  assert.equal(fs.existsSync(path.join(root, '.keep', 'transcript-mirrors')), false, 'nothing mirrored');
});

test('each Codex event runs the daemon\'s keep hook codex <action> on its rebuilt input, the rollout mirrored', async (t) => {
  const { hooks, calls, root } = services(t, { answer: () => ({ code: 0, stdout: '{}\n' }) });
  const mirrorFile = path.join(root, '.keep', 'transcript-mirrors', 'aws1', 'codex-aws1.jsonl');
  const rollout = `${JSON.stringify({ type: 'session_meta', payload: { id: 'codex-aws1', originator: 'codex-tui' } })}\n`;
  const project = path.join(root, 'project');
  const facts = { paths: { [project]: { top: project, main: project } }, deploy: null, head: {} };
  const expected = {
    'codex-start': [{ hook_event_name: 'SessionStart', source: 'startup', model: 'gpt-x', agent_type: 'x' },
      { hook_event_name: 'SessionStart', source: 'startup' }],
    'codex-stop': [{ hook_event_name: 'Stop', stop_hook_active: false, turn_id: 'turn-1', last_assistant_message: 'done', permission_mode: 'plan', extra: 1 },
      { hook_event_name: 'Stop', stop_hook_active: false, turn_id: 'turn-1', last_assistant_message: 'done', permission_mode: 'plan' }],
    'codex-question': [{ hook_event_name: 'PreToolUse', tool_name: 'request_user_input', tool_input: { questions: [{ title: 'Pick?', options: [{ label: 'A', description: 'x' }], secret: 1 }] } },
      { hook_event_name: 'PreToolUse', tool_name: 'request_user_input', tool_input: { questions: [{ options: [{ label: 'A' }], title: 'Pick?' }] } }],
    // A malformed mode is dropped, and the event kept.
    'codex-approval': [{ hook_event_name: 'PermissionRequest', tool_name: 'shell', permission_mode: 'bad mode!', tool_input: { description: 'run ls', command: 'ls', tool_name: 'shell' } },
      { hook_event_name: 'PermissionRequest', tool_name: 'shell', tool_input: { description: 'run ls', tool_name: 'shell' } }],
    'codex-complete': [{ last_assistant_message: 'ok', permission_mode: 'on-request' }, { last_assistant_message: 'ok', permission_mode: 'on-request' }],
    'codex-lifecycle': [{ hook_event_name: 'SubagentStart', agent_id: 'child-1', turn_id: 't', tool_input: { command: 'ls', env: 'x' } },
      { hook_event_name: 'SubagentStart', agent_id: 'child-1', turn_id: 't', tool_input: { command: 'ls' } }],
    'codex-pre-tool': [{ hook_event_name: 'PreToolUse', tool_name: 'shell', call_id: 'call-1', tool_input: { command: ['bash', '-lc', 'ls'], workdir: '/home/node/project', timeout: 5 }, repo_facts: facts },
      { hook_event_name: 'PreToolUse', tool_name: 'shell', call_id: 'call-1', tool_input: { command: ['bash', '-lc', 'ls'], workdir: '/home/node/project' }, repo_facts: facts }],
    'codex-post-tool': [{ hook_event_name: 'PostToolUse', tool_name: 'shell', tool_use_id: 'call-2', tool_input: { command: 'ls' }, repo_facts: facts, tool_response: { stdout: 'a\n', exit_code: 0, big: 'x' } },
      { hook_event_name: 'PostToolUse', tool_name: 'shell', tool_use_id: 'call-2', tool_input: { command: 'ls' }, repo_facts: facts, tool_response: { stdout: 'a\n', exit_code: 0 } }],
    'codex-end': [{ hook_event_name: 'SessionEnd' }, { hook_event_name: 'SessionEnd' }],
  };
  let first = true;
  for (const [event, [input, cleaned]] of Object.entries(expected)) {
    const answer = await hooks.handle(AWS1, codexBody(event, input, {
      identity: { agent: 'codex', sessionId: 'codex-aws1', pane: 'p2@aws1', env: { KEEP_CODEX_CLIENT_TOKEN: 'launch-tok', KEEP_CODEX_PARENT_SESSION: 'sess-aws1', KEEP_REPAIR: '1' } },
      transcript: first ? { ...transcript(rollout), path: CODEX_ROLLOUT } : null,
    }));
    first = false;
    assert.equal(answer.status, 200, `${event}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.stdout, '{}\n');
    const call = calls.at(-1);
    assert.deepEqual(call.args, [CLI, 'hook', 'codex', event.slice('codex-'.length)], event);
    assert.deepEqual(JSON.parse(call.stdin), { session_id: 'codex-aws1', cwd: '/home/node/project', ...cleaned, transcript_path: mirrorFile }, event);
    const env = call.options.env;
    assert.equal(env.CODEX_THREAD_ID, 'codex-aws1');
    assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
    assert.equal(env.KEEP_HOOK_NODE, 'aws1');
    assert.equal(env.KEEP_PANE, 'p2@aws1');
    assert.equal(env.KEEP_AGENT_ACCOUNT_ID, 'codex-node', 'the location record\'s account');
    assert.equal(env.KEEP_CODEX_CLIENT_TOKEN, 'launch-tok');
    assert.equal(env.KEEP_CODEX_PARENT_SESSION, 'sess-aws1');
    assert.equal(env.KEEP_REPAIR, undefined, 'never forwarded');
  }
  assert.equal(fs.readFileSync(mirrorFile, 'utf8'), rollout, 'the rollout is mirrored under the node\'s own directory');
});

test('a Codex client-end names no session: only its token reaches the hook, and nothing is mirrored', async (t) => {
  const { hooks, calls, root } = services(t, { answer: () => ({ code: 0, stdout: '{}\n' }) });
  const answer = await hooks.handle(AWS1, {
    event: 'codex-client-end', input: { client_token: 'launch-tok', other: 1 },
    identity: { agent: 'codex', pane: 'p2@aws1', env: { KEEP_CODEX_CLIENT_TOKEN: 'launch-tok' } }, transcript: null, idempotencyKey: `${KEY}-ce`,
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const [call] = calls;
  assert.deepEqual(call.args, [CLI, 'hook', 'codex', 'client-end']);
  assert.deepEqual(JSON.parse(call.stdin), { client_token: 'launch-tok' });
  assert.equal(call.options.env.CODEX_THREAD_ID, undefined);
  assert.equal(call.options.env.KEEP_HOOK_NODE, 'aws1');
  assert.equal(fs.existsSync(path.join(root, '.keep', 'transcript-mirrors')), false);
  // With a session it is that session's, and must be on the caller.
  const other = await hooks.handle(AWS1, { ...codexBody('codex-client-end', { client_token: 'tok' }), identity: { agent: 'codex', sessionId: 'sess-main' } });
  assert.equal(other.status, 403);
});

// ---------- a Codex session's hooks, run on the daemon against its rollout mirror ----------

function authority(root, sessionId, agent, node) {
  const dir = path.join(root, '.keep', 'session-accounts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ version: 1, sessionId, agent, accountId: `${agent}-node`, node }));
}

function codexRolloutText(sid, message = 'Done with the edits.') {
  const row = (type, payload) => `${JSON.stringify({ type, payload, timestamp: '2026-09-22T10:00:00.000Z' })}\n`;
  return row('session_meta', { id: sid, source: 'cli', originator: 'codex-tui', cwd: '/home/node/project' })
    + row('event_msg', { type: 'user_message', message: 'Continue the work.' })
    + row('event_msg', { type: 'agent_message', message });
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const withoutTimes = ({ at, startedAt, ...rest }) => rest;

test('a Codex start, stop, question and client-end through the route write what a local run writes, the pane record naming the node', async (t) => {
  const sid = 'codex-aws1';
  const text = codexRolloutText(sid);

  // The local run: a Codex session on the daemon node, its rollout on disk.
  const localRoot = registry(t);
  const rollout = path.join(localRoot, `rollout-2026-09-22T10-00-00-${sid}.jsonl`);
  fs.writeFileSync(rollout, text);
  const localEnv = { PATH: process.env.PATH, HOME: localRoot, LANG: 'C', KEEP_DIR: localRoot, KEEP_NO_PUSH: '1', KEEP_SYNC: '0',
    KEEP_CONFIG: path.join(localRoot, 'config.json'), KEEP_PANE: 'p2', KEEP_HOST_SOCK: path.join(localRoot, 'no-host.sock'),
    KEEP_CODEX_CLIENT_TOKEN: 'launch-tok' };
  const local = (action, extra = {}) => runLocal(['hook', 'codex', action], { env: localEnv,
    input: JSON.stringify({ session_id: sid, transcript_path: rollout, cwd: '/home/node/project', ...extra }) });

  // The node's run: the same rollout arrives as bytes; the daemon's own hook runs on the mirror.
  const root = registry(t);
  authority(root, sid, 'codex', 'aws1');
  authority(root, 'claude-parent', 'claude', 'aws1');
  authority(root, 'claude-elsewhere', 'claude', 'main');
  authority(root, 'codex-main', 'codex', 'main');
  const { hooks } = services(t, { root, realSpawn: true });
  const mtimeMs = 1_700_000_000_000;
  let sent = 0;
  const node = async (event, input = {}, identityEnv = {}, firedAt) => {
    const bytes = sent === 0 ? text : '';
    const answer = await hooks.handle(AWS1, codexBody(event, input, {
      identity: { agent: 'codex', sessionId: sid, pane: 'p2@aws1', env: { KEEP_CODEX_CLIENT_TOKEN: 'launch-tok', ...identityEnv }, ...(firedAt ? { firedAt } : {}) },
      transcript: { ...transcript(bytes, { fromOffset: sent, size: Buffer.byteLength(text), mtimeMs }), path: CODEX_ROLLOUT },
      idempotencyKey: `${KEY}-${event}-${Math.random().toString(36).slice(2)}`,
    }));
    sent = Buffer.byteLength(text);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.status, 0, answer.body.stderr);
    return answer.body;
  };

  // start
  const localStart = await local('start', { hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(localStart.status, 0, localStart.stderr);
  const nodeStart = await node('codex-start', { hook_event_name: 'SessionStart', source: 'startup' }, { KEEP_CODEX_PARENT_SESSION: 'claude-parent' });
  assert.equal(nodeStart.stdout, localStart.stdout, 'the same answer to Codex');
  const localPane = readJson(path.join(localRoot, '.keep', 'panes', `${sid}.json`));
  const nodePane = readJson(path.join(root, '.keep', 'panes', `${sid}.json`));
  assert.deepEqual(withoutTimes(nodePane), { ...withoutTimes(localPane), pane: 'p2@aws1', node: 'aws1', accountId: 'codex-node' });
  assert.deepEqual(withoutTimes(readJson(path.join(root, '.keep', 'stopcheck', `${sid}.json`))),
    withoutTimes(readJson(path.join(localRoot, '.keep', 'stopcheck', `${sid}.json`))), 'the stop evidence anchored at the mirror\'s end');
  assert.equal(readJson(path.join(root, '.keep', 'codex-parents', `${sid}.json`)).parent, 'claude-parent', 'a parent on the same node');
  assert.equal(fs.existsSync(path.join(localRoot, '.keep', 'codex-parents', `${sid}.json`)), false);

  // stop: nothing to push back, so the turn's completion marker, with the mirror's mtime and when it fired.
  const localStop = await local('stop', { hook_event_name: 'Stop', stop_hook_active: false });
  const firedAt = Date.now() - 60e3;
  const nodeStop = await node('codex-stop', { hook_event_name: 'Stop', stop_hook_active: false }, {}, firedAt);
  assert.equal(nodeStop.stdout, localStop.stdout);
  assert.deepEqual(JSON.parse(nodeStop.stdout), {});
  const localMarker = readJson(path.join(localRoot, '.keep', 'attention', `${sid}.json`));
  const nodeMarker = readJson(path.join(root, '.keep', 'attention', `${sid}.json`));
  assert.equal(localMarker.type, 'complete');
  // Locally mt comes from the rollouts under ~/.codex/sessions (none in this fixture); on
  // the daemon for a node's session, from the mirror.
  assert.deepEqual({ ...nodeMarker, mt: undefined, at: undefined }, { ...localMarker, mt: undefined, at: undefined });
  assert.equal(nodeMarker.mt, mtimeMs, 'the mirror\'s mtime, the node\'s rollout time');
  assert.equal(nodeMarker.at, firedAt, 'when it fired on the node');
  assert.equal(nodeMarker.clientToken, 'launch-tok');

  // client-end: the session's own completion goes; another node's session with the same token stays.
  const otherMarker = path.join(root, '.keep', 'attention', 'codex-main.json');
  fs.writeFileSync(otherMarker, JSON.stringify({ ...nodeMarker, at: Date.now() }));
  const ended = await hooks.handle(AWS1, { event: 'codex-client-end', input: { client_token: 'launch-tok' },
    identity: { agent: 'codex', pane: 'p2@aws1' }, transcript: null, idempotencyKey: `${KEY}-client-end` });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.equal(ended.body.stdout, '{}\n');
  assert.equal(fs.existsSync(path.join(root, '.keep', 'attention', `${sid}.json`)), false, 'this node\'s session\'s completion cleared');
  assert.equal(fs.existsSync(otherMarker), true, 'a session on another node is not this node\'s to clear');

  // question: nobody marks the pane unattended (its host is not reachable), so the question is asked and marked.
  const question = { hook_event_name: 'PreToolUse', tool_name: 'request_user_input', tool_input: { questions: [{ question: 'Which branch?', options: [{ label: 'main' }] }] } };
  const localQuestion = await local('question', question);
  const nodeQuestion = await node('codex-question', question);
  assert.equal(nodeQuestion.stdout, localQuestion.stdout);
  const localAsked = readJson(path.join(localRoot, '.keep', 'attention', `${sid}.json`));
  const nodeAsked = readJson(path.join(root, '.keep', 'attention', `${sid}.json`));
  assert.deepEqual({ ...nodeAsked, mt: undefined, at: undefined }, { ...localAsked, mt: undefined, at: undefined });
  assert.equal(nodeAsked.type, 'question');
  assert.equal(nodeAsked.mt, mtimeMs);
});

test('a Codex parent on another node, or not a Claude session, is not recorded', async (t) => {
  const sid = 'codex-aws1';
  const root = registry(t);
  authority(root, sid, 'codex', 'aws1');
  authority(root, 'claude-elsewhere', 'claude', 'main');
  authority(root, 'codex-sibling', 'codex', 'aws1');
  const { hooks } = services(t, { root, realSpawn: true });
  const text = codexRolloutText(sid);
  let n = 0;
  for (const parent of ['claude-elsewhere', 'codex-sibling', 'nobody']) {
    const answer = await hooks.handle(AWS1, codexBody('codex-start', { hook_event_name: 'SessionStart' }, {
      identity: { agent: 'codex', sessionId: sid, env: { KEEP_CODEX_PARENT_SESSION: parent } },
      transcript: n === 0 ? { ...transcript(text), path: CODEX_ROLLOUT } : null, idempotencyKey: `${KEY}-parent-${n++}`,
    }));
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(fs.existsSync(path.join(root, '.keep', 'codex-parents', `${sid}.json`)), false, parent);
  }
});

test('on the daemon node the Codex hooks read no node state: KEEP_CODEX_PARENT_SESSION alone changes nothing', async (t) => {
  const sid = 'codex-local';
  const root = registry(t);
  authority(root, 'claude-parent', 'claude', 'main');
  const rollout = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(rollout, codexRolloutText(sid));
  const env = { PATH: process.env.PATH, HOME: root, LANG: 'C', KEEP_DIR: root, KEEP_NO_PUSH: '1', KEEP_SYNC: '0',
    KEEP_CONFIG: path.join(root, 'config.json'), KEEP_CODEX_PARENT_SESSION: 'claude-parent', CLAUDE_CODE_SESSION_ID: 'claude-real' };
  const result = await runLocal(['hook', 'codex', 'start'], { env, input: JSON.stringify({ session_id: sid, transcript_path: rollout, cwd: root }) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson(path.join(root, '.keep', 'codex-parents', `${sid}.json`)).parent, 'claude-real', 'the local parent, as always');
});

test('a Codex pre-tool on the daemon judges a node\'s shell command by the node\'s facts, as a Claude pre-bash is judged', async (t) => {
  const root = registry(t);
  stepsRegistry(root);
  const { hooks } = services(t, { root, realSpawn: true });
  const cwd = path.join(root, 'wt', 'infra', 'feature');
  const run = async (command, paths = { [cwd]: { top: cwd, main: path.join(root, 'infra') } }) => {
    const answer = await hooks.handle(AWS1, codexBody('codex-pre-tool', { cwd, hook_event_name: 'PreToolUse', tool_name: 'shell', call_id: 'call-1',
      tool_input: { command, workdir: cwd }, repo_facts: { paths, deploy: null, head: {} } }, { idempotencyKey: `${KEY}-${Math.random().toString(36).slice(2)}` }));
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return answer.body;
  };
  const refused = await run('terraform apply -auto-approve');
  assert.equal(refused.status, 2, refused.stderr);
  const block = JSON.parse(refused.stdout);
  assert.equal(block.decision, 'block');
  assert.equal(block.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(block.reason, /^keep guard: `terraform apply` is step apply on ~\/infra/);
  // A directory the node did not report is refused, never let through.
  const unreported = await run('terraform apply', {});
  assert.equal(unreported.status, 2);
  assert.match(JSON.parse(unreported.stdout).reason, /node aws1 did not report the repository/);
  const plain = await run('ls -la');
  assert.deepEqual([plain.status, JSON.parse(plain.stdout)], [0, {}]);
});

// ---------- late adoption (bin/late-adoption.js) ----------

// The services over a real location record and a fake host for aws1 that lists `panes`.
function adoptingServices(t, panes, overrides = {}) {
  const root = tempDir(t);
  const configFile = path.join(root, 'config.json');
  fs.mkdirSync(path.join(root, 'codex-home'));
  fs.mkdirSync(path.join(root, 'claude-home'));
  fs.writeFileSync(configFile, `${JSON.stringify({ version: 1, daemonNode: 'main', nodes: { main: {}, aws1: {} },
    accounts: [
      { id: 'codex-node', label: 'Node codex', agent: 'codex', configDir: path.join(root, 'codex-home') },
      { id: 'claude-node', label: 'Node claude', agent: 'claude', configDir: path.join(root, 'claude-home') },
    ],
    defaultAccounts: { codex: 'codex-node', claude: 'claude-node' } })}\n`);
  const env = { PATH: process.env.PATH, HOME: root, LANG: 'C', KEEP_CONFIG: configFile };
  const accounts = require('./accounts.js');
  const host = { asked: 0, panes };
  const fake = fakeSpawn(overrides.answer || (() => ({ code: 0, stdout: '{}\n' })));
  let clock = 1_800_000_000_000;
  const logged = [];
  const registry = createRegistryService({
    root, spawn: fake.spawn, daemonNode: () => 'main', env, configFile, now: () => clock, log: (line) => logged.push(line),
    location: (id) => accounts.sessionLocation(id, { root, env }),
    hostConnect: async (node) => {
      host.asked += 1;
      assert.equal(node, 'aws1');
      return { request: async (type) => { assert.equal(type, 'list'); return { panes: host.panes }; }, close: () => {} };
    },
  });
  const hooks = createHookService({ root, registry });
  // The daemon's record of the fresh open that spawned latePane, as openSession writes it.
  require('./late-adoption.js').recordNodeCodexLaunch(root, { node: 'aws1', requestId: 'req-1', accountId: 'codex-node',
    launchedAt: 1_700_000_000_000, pane: 'p2', project: '/home/node/project' }, { now: () => clock });
  return { root, hooks, host, calls: fake.calls, logged, env, tick: (ms) => { clock += ms; } };
}

const latePane = (meta = {}, extra = {}) => ({
  id: 'p2', alive: true, cwd: '/home/node/project', ...extra,
  meta: { agent: 'codex', accountId: 'codex-node', sessionId: 'codex-aws1', node: 'aws1', project: '/home/node/project',
    openRequestId: 'req-1', launchedAt: 1_700_000_000_000, ...meta },
});

test('a Codex hook for a session the daemon never heard register is adopted from its one pane on the node, then runs', async (t) => {
  const { root, hooks, host, calls, logged, env } = adoptingServices(t, [latePane(), { id: 'p3', alive: true, meta: { agent: 'shell' } }]);
  const answer = await hooks.handle(AWS1, codexBody('codex-start', { hook_event_name: 'SessionStart', source: 'startup' }, {
    identity: { agent: 'codex', sessionId: 'codex-aws1', pane: 'p2@aws1' },
  }));
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(host.asked, 1);
  assert.deepEqual(require('./accounts.js').sessionLocation('codex-aws1', { root, env }),
    { node: 'aws1', agent: 'codex', accountId: 'codex-node' });
  const record = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'panes', 'codex-aws1.json'), 'utf8'));
  assert.equal(record.pane, 'p2@aws1');
  assert.equal(record.node, 'aws1');
  assert.equal(record.agent, 'codex');
  assert.equal(record.accountId, 'codex-node');
  assert.equal(record.bound, true);
  assert.deepEqual(calls.at(-1).args, [CLI, 'hook', 'codex', 'start']);
  assert.equal(calls.at(-1).options.env.KEEP_AGENT_ACCOUNT_ID, 'codex-node', 'the adopted record\'s account');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /late adoption: codex session codex-aws1 adopted on aws1 in pane p2@aws1 \(account codex-node\)/);
  // The next hook reads the record: no second question to the host.
  const stop = await hooks.handle(AWS1, codexBody('codex-stop', { hook_event_name: 'Stop', stop_hook_active: false }));
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  assert.equal(host.asked, 1);
});

test('a Claude hook is never adopted, even from a Claude pane: a Claude session on a node is registered at its launch', async (t) => {
  const { root, hooks, host } = adoptingServices(t, [latePane({ agent: 'claude', accountId: 'claude-node', sessionId: 'sess-late' })]);
  const answer = await hooks.handle(AWS1, body({
    input: { session_id: 'sess-late', transcript_path: '/home/node/.claude/projects/p/sess-late.jsonl', cwd: '/home/node/project', hook_event_name: 'Stop', stop_hook_active: false },
    identity: { agent: 'claude', sessionId: 'sess-late', pane: 'p2@aws1' },
  }));
  assert.equal(answer.status, 403);
  assert.equal(host.asked, 0);
  assert.equal(fs.existsSync(path.join(root, '.keep', 'session-accounts')), false);
});

test('a late hook is refused as before for a pane of another agent, two panes, an unknown account, and within five seconds of a refusal', async (t) => {
  const start = (extra = {}) => codexBody('codex-start', { hook_event_name: 'SessionStart', source: 'startup' }, {
    identity: { agent: 'codex', sessionId: 'codex-aws1', pane: 'p2@aws1' }, ...extra });
  const cases = [
    ['wrong agent', [latePane({ agent: 'claude', accountId: 'claude-node' })]],
    ['two panes', [latePane(), latePane({}, { id: 'p4' })]],
    ['unknown account', [latePane({ accountId: 'codex-elsewhere' })]],
    ['a Claude account on a Codex pane', [latePane({ accountId: 'claude-node' })]],
    ['no pane', []],
  ];
  for (const [name, panes] of cases) {
    const { root, hooks, calls, logged } = adoptingServices(t, panes);
    const answer = await hooks.handle(AWS1, start());
    assert.equal(answer.status, 403, `${name}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.error, 'session codex-aws1 is not on node aws1', name);
    assert.equal(calls.length, 0, name);
    assert.equal(fs.existsSync(path.join(root, '.keep', 'session-accounts')), false, name);
    assert.equal(fs.existsSync(path.join(root, '.keep', 'panes')), false, name);
    assert.deepEqual(logged, [], name);
  }
  // The negative cache: a flood asks the host once, and after five seconds asks again.
  const { hooks, host, tick } = adoptingServices(t, [latePane({ accountId: 'codex-elsewhere' })]);
  for (let i = 0; i < 4; i += 1) assert.equal((await hooks.handle(AWS1, start({ idempotencyKey: `${KEY}-flood-${i}` }))).status, 403);
  assert.equal(host.asked, 1);
  host.panes = [latePane()];
  tick(4_999);
  assert.equal((await hooks.handle(AWS1, start())).status, 403);
  assert.equal(host.asked, 1);
  tick(2);
  assert.equal((await hooks.handle(AWS1, start())).status, 200);
  assert.equal(host.asked, 2);
  // A session already placed elsewhere is never adopted, and the host never asked.
  const placed = adoptingServices(t, [latePane()]);
  require('./accounts.js').pinSession('codex-aws1', 'codex', 'codex-node', { root: placed.root, env: placed.env, node: 'main' });
  assert.equal((await placed.hooks.handle(AWS1, start())).status, 403);
  assert.equal(placed.host.asked, 0);
});

test('a Codex start posted before its pane is bound is refused uncached: the prompt right after the bind is adopted, and the re-posted start registers', async (t) => {
  const { root, hooks, host, calls, env } = adoptingServices(t, []);
  const start = codexBody('codex-start', { hook_event_name: 'SessionStart', source: 'startup' }, {
    identity: { agent: 'codex', sessionId: 'codex-aws1', pane: 'p2@aws1' }, idempotencyKey: `${KEY}-late-start` });
  const refused = await hooks.handle(AWS1, start);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'session codex-aws1 is not on node aws1');
  assert.equal(refused.body.code, 'SESSION_NOT_ON_NODE', 'named, so the node can tell it from a refusal of its pane');
  assert.equal(calls.length, 0);
  // The node's bind lands a few milliseconds later; its first prompt follows at once.
  host.panes = [latePane()];
  const prompt = await hooks.handle(AWS1, codexBody('codex-lifecycle', { hook_event_name: 'UserPromptSubmit', turn_id: 't1' }, {
    identity: { agent: 'codex', sessionId: 'codex-aws1', pane: 'p2@aws1' }, idempotencyKey: `${KEY}-late-prompt` }));
  assert.equal(prompt.status, 200, JSON.stringify(prompt.body));
  assert.deepEqual(calls.at(-1).args, [CLI, 'hook', 'codex', 'lifecycle']);
  assert.equal(host.asked, 2);
  // The node posts its start again under the same key: it runs, once.
  const again = await hooks.handle(AWS1, start);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.replayed, false);
  assert.deepEqual(calls.at(-1).args, [CLI, 'hook', 'codex', 'start']);
  assert.equal(calls.length, 2);
  assert.equal(require('./accounts.js').sessionLocation('codex-aws1', { root, env }).node, 'aws1');
});

test('a late Codex hook naming another account than its pane\'s is refused with nothing pinned, and the right one is still adopted', async (t) => {
  const { root, hooks, host, calls, env } = adoptingServices(t, [latePane()]);
  const post = (accountId, key) => codexBody('codex-stop', { hook_event_name: 'Stop', stop_hook_active: false }, {
    identity: { agent: 'codex', sessionId: 'codex-aws1', pane: 'p2@aws1', accountId }, idempotencyKey: `${KEY}-${key}` });
  const wrong = await hooks.handle(AWS1, post('claude-node', 'wrong-account'));
  assert.equal(wrong.status, 403, JSON.stringify(wrong.body));
  assert.equal(wrong.body.error, 'session codex-aws1 is not on node aws1');
  assert.equal(host.asked, 1);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(root, '.keep', 'session-accounts')), false, 'nothing pinned');
  assert.ok(require('./late-adoption.js').readNodeCodexLaunch(root, 'aws1', 'req-1', { now: () => 1_800_000_000_000 }), 'the launch record is kept');
  const right = await hooks.handle(AWS1, post('codex-node', 'right-account'));
  assert.equal(right.status, 200, JSON.stringify(right.body));
  assert.equal(require('./accounts.js').sessionLocation('codex-aws1', { root, env }).accountId, 'codex-node');
});

test('a Codex hook on a node that names no pane (a Codex Keep did not open) never asks the node\'s host', async (t) => {
  const { root, hooks, host, calls } = adoptingServices(t, [latePane()]);
  for (let i = 0; i < 4; i += 1) {
    const answer = await hooks.handle(AWS1, codexBody('codex-stop', { hook_event_name: 'Stop', stop_hook_active: false }, {
      identity: { agent: 'codex', sessionId: 'codex-aws1', accountId: 'codex-node' }, idempotencyKey: `${KEY}-unmanaged-${i}` }));
    assert.equal(answer.status, 403);
    assert.equal(answer.body.code, 'SESSION_NOT_ON_NODE');
  }
  assert.equal(host.asked, 0);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(root, '.keep', 'session-accounts')), false);
  // The same session posting from its pane is adopted as before.
  const named = await hooks.handle(AWS1, codexBody('codex-stop', { hook_event_name: 'Stop', stop_hook_active: false }));
  assert.equal(named.status, 200, JSON.stringify(named.body));
  assert.equal(host.asked, 1);
});

test('a Codex post the route would refuse on its own adopts nothing', async (t) => {
  const cases = [
    ['a malformed input', codexBody('codex-stop', { stop_hook_active: 'no' }), 400],
    ['a short key', codexBody('codex-stop', { hook_event_name: 'Stop', stop_hook_active: false }, { idempotencyKey: 'short' }), 400],
    ['a pane on another node', codexBody('codex-stop', { hook_event_name: 'Stop', stop_hook_active: false },
      { identity: { agent: 'codex', sessionId: 'codex-aws1', pane: 'p2@main' } }), 403],
  ];
  for (const [name, post, status] of cases) {
    const { root, hooks, host } = adoptingServices(t, [latePane()]);
    const answer = await hooks.handle(AWS1, post);
    assert.equal(answer.status, status, `${name}: ${JSON.stringify(answer.body)}`);
    assert.equal(host.asked, 0, name);
    assert.equal(fs.existsSync(path.join(root, '.keep', 'session-accounts')), false, name);
  }
});

test('the hook context adopts a Codex session the daemon never heard register, as a post does, before it answers', async (t) => {
  const { root, hooks, host, env, logged } = adoptingServices(t, [latePane()]);
  const answer = await hooks.context(AWS1, 'codex-aws1', { agent: 'codex', pane: 'p2@aws1' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(Object.keys(answer.body).sort(), ['repairSession', 'steps'], 'the answer keeps its shape');
  assert.equal(answer.body.repairSession, false);
  assert.equal(host.asked, 1);
  assert.deepEqual(require('./accounts.js').sessionLocation('codex-aws1', { root, env }),
    { node: 'aws1', agent: 'codex', accountId: 'codex-node' });
  assert.match(logged[0], /late adoption: codex session codex-aws1 adopted on aws1 in pane p2@aws1/);
  // Placed now: the next ask reads the record and never asks the host.
  assert.equal((await hooks.context(AWS1, 'codex-aws1', { agent: 'codex', pane: 'p2@aws1' })).status, 200);
  assert.equal(host.asked, 1);
});

test('the hook context adopts nothing for a request naming no pane, another agent, or a pane off the caller', async (t) => {
  const cases = [
    ['no pane', { agent: 'codex' }, 403, 'SESSION_NOT_ON_NODE'],
    ['an empty pane', { agent: 'codex', pane: '' }, 403, 'SESSION_NOT_ON_NODE'],
    ['no agent', { pane: 'p2@aws1' }, 403, 'SESSION_NOT_ON_NODE'],
    ['a Claude agent', { agent: 'claude', pane: 'p2@aws1' }, 403, 'SESSION_NOT_ON_NODE'],
    ['a pane on another node', { agent: 'codex', pane: 'p2@main' }, 403, undefined],
    ['a malformed pane', { agent: 'codex', pane: 'p2/../x@aws1' }, 400, undefined],
    ['an unknown agent', { agent: 'shell', pane: 'p2@aws1' }, 400, undefined],
  ];
  for (const [name, options, status, code] of cases) {
    const { root, hooks, host } = adoptingServices(t, [latePane()]);
    const answer = await hooks.context(AWS1, 'codex-aws1', options);
    assert.equal(answer.status, status, `${name}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.code, code, name);
    assert.equal(host.asked, 0, name);
    assert.equal(fs.existsSync(path.join(root, '.keep', 'session-accounts')), false, name);
  }
  // A pane on the node that is not the session's: asked, and nothing adopted.
  const other = adoptingServices(t, [latePane()]);
  const refused = await other.hooks.context(AWS1, 'codex-aws1', { agent: 'codex', pane: 'p9@aws1' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'SESSION_NOT_ON_NODE');
  assert.equal(fs.existsSync(path.join(other.root, '.keep', 'session-accounts')), false);
});

test('the hook context for a located Claude session on a node is what it was, whatever it names', async (t) => {
  const root = tempDir(t);
  stepsRegistry(root);
  const { hooks } = services(t, { root });
  const before = await hooks.context(AWS1, 'sess-aws1');
  assert.equal(before.status, 200);
  assert.deepEqual(await hooks.context(AWS1, 'sess-aws1', { agent: 'claude', pane: 'p1@aws1' }), before);
  assert.deepEqual(await hooks.context(AWS1, 'sess-aws1', { agent: 'codex', pane: 'p1@aws1' }), before, 'a located session is never adopted');
  assert.equal((await hooks.context(AWS1, 'sess-main', { agent: 'claude', pane: 'p1@aws1' })).status, 403, 'the daemon node\'s session stays refused');
  // Only a Codex ask has its pane checked: a Claude or Pi ask naming a malformed or
  // foreign pane is answered by its location record, as before.
  for (const pane of ['p2/../x@aws1', 'p1@main', 'p1@elsewhere']) {
    assert.deepEqual(await hooks.context(AWS1, 'sess-aws1', { agent: 'claude', pane }), before, `claude ${pane}`);
    assert.equal((await hooks.context(AWS1, 'pi-aws1', { agent: 'pi', pane })).status, 200, `pi ${pane}`);
    assert.notEqual((await hooks.context(AWS1, 'codex-aws1', { agent: 'codex', pane })).status, 200, `codex ${pane}`);
  }
});

// ---------- Pi hooks through the route ----------

const PI_INSTANCE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function piBody(event, input = {}, extra = {}) {
  return {
    event,
    input: { session_id: 'pi-aws1', cwd: '/home/node/project', instance: PI_INSTANCE, pid: 4242,
      job_id: 'job-dropped', worker_token: 'token-dropped', ...input },
    identity: { agent: 'pi', sessionId: 'pi-aws1', pane: 'p3@aws1' },
    transcript: null,
    idempotencyKey: `${KEY}-${event}-${Math.random().toString(36).slice(2)}`,
    ...extra,
  };
}

test('a Pi post is refused unless it is a pi-* event for a Pi session on the calling node, in its input shape', async (t) => {
  const { hooks, calls, root } = services(t);
  const cwd = path.join(root, 'wt', 'infra', 'feature');
  const cases = [
    [piBody('pi-start', {}, { identity: { agent: 'pi', sessionId: 'sess-aws1' } }), 403, /is a claude session, not pi/],
    [body({ identity: { agent: 'claude', sessionId: 'pi-aws1' }, input: { session_id: 'pi-aws1', cwd: '/x' } }), 403, /is a pi session, not claude/],
    [piBody('stop'), 400, /stop is a claude hook, not a pi one/],
    [piBody('pi-start', {}, { identity: { agent: 'claude', sessionId: 'sess-aws1' } }), 400, /pi-start is a pi hook, not a claude one/],
    [piBody('codex-start'), 400, /codex-start is a codex hook, not a pi one/],
    [piBody('pi-post-tool'), 400, /is not a hook event/],
    [piBody('transcript', {}, { transcript: transcript('x') }), 400, /a Pi session posts no transcript/],
    [piBody('pi-start', {}, { transcript: transcript('x') }), 400, /a Pi hook carries no transcript/],
    [piBody('pi-start', { session_id: 'other' }), 400, /must be the identity's session/],
    [piBody('pi-start', { cwd: 'relative' }), 400, /input.cwd must be an absolute path/],
    [piBody('pi-start', { instance: 'not-a-uuid' }), 400, /invalid input.instance/],
    [piBody('pi-start', { pid: -1 }), 400, /input.pid must be a process id/],
    [piBody('pi-pre-tool', { tool_name: 'Bash', tool_input: { command: 'ls' } }), 400, /repo_facts is required/],
    [piBody('pi-pre-tool', { tool_name: 'Read', tool_input: { command: 'ls' }, repo_facts: NO_FACTS }), 400, /pi-pre-tool is for Bash only/],
    [piBody('pi-pre-tool', { cwd, tool_name: 'Bash', tool_input: { command: 'x'.repeat(65 * 1024) }, repo_facts: NO_FACTS }), 400, /longer than/],
    [piBody('pi-start', {}, { identity: { agent: 'pi', sessionId: 'pi-aws1', pane: 'p3@other' } }), 403, /is not on node aws1/],
  ];
  for (const [request, status, message] of cases) {
    const answer = await hooks.handle(AWS1, request);
    assert.equal(answer.status, status, `${request.event}: ${JSON.stringify(answer.body)}`);
    assert.match(answer.body.error, message);
  }
  assert.equal(calls.length, 0, 'nothing ran');
  // Not adopted: nothing on aws1's host shows a Pi session this pane took over (see the /new tests below).
  const unknown = await hooks.handle(AWS1, piBody('pi-start', { session_id: 'pi-unknown' }, { identity: { agent: 'pi', sessionId: 'pi-unknown', pane: 'p3@aws1' } }));
  assert.equal(unknown.status, 403);
  assert.equal(unknown.body.code, 'SESSION_NOT_ON_NODE');
});

test('each Pi event runs the daemon\'s keep hook pi <action> on its rebuilt input, with no transcript and the Pi identity', async (t) => {
  let card = '';
  const { hooks, calls, root } = services(t, { cardForSession: () => card,
    answer: (call) => (call.args[3] === 'pre-tool' ? { code: 2, stdout: '', stderr: 'keep guard: refused\n' } : { code: 0, stdout: '', stderr: '' }) });
  const start = await hooks.handle(AWS1, piBody('pi-start', {}, { identity: { agent: 'pi', sessionId: 'pi-aws1', pane: 'p3@aws1',
    env: { KEEP_STEP_OK: '1', KEEP_REPAIR: '1', KEEP_CODEX_CLIENT_TOKEN: 'x' } } }));
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.deepEqual(start.body, { ok: true, status: 0, stdout: '', stderr: '', replayed: false });
  assert.deepEqual(calls[0].args.slice(1), ['hook', 'pi', 'start']);
  assert.deepEqual(JSON.parse(calls[0].stdin), { session_id: 'pi-aws1', cwd: '/home/node/project', instance: PI_INSTANCE, pid: 4242 },
    'no transcript path, no worker job id or token');
  const env = calls[0].options.env;
  assert.equal(env.KEEP_PI_SESSION_ID, 'pi-aws1');
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(env.KEEP_HOOK_NODE, 'aws1');
  assert.equal(env.KEEP_REMOTE_CALLER, 'aws1');
  assert.equal(env.KEEP_PANE, 'p3@aws1');
  assert.equal(env.KEEP_STEP_OK, '1');
  assert.equal(env.KEEP_REPAIR, undefined, 'the node\'s word is dropped');
  assert.equal(fs.existsSync(path.join(root, '.keep', 'transcript-mirrors')), false, 'nothing mirrored');

  const end = await hooks.handle(AWS1, piBody('pi-end'));
  assert.equal(end.status, 200);
  assert.deepEqual(calls[1].args.slice(1), ['hook', 'pi', 'end']);

  const cwd = path.join(root, 'wt', 'infra', 'feature');
  const facts = { paths: { [cwd]: { top: cwd, main: path.join(root, 'infra') } }, deploy: null, head: {} };
  const pre = await hooks.handle(AWS1, piBody('pi-pre-tool', { cwd, tool_name: 'Bash', tool_input: { command: 'terraform apply', timeout: 5 }, repo_facts: facts }));
  assert.equal(pre.status, 200);
  assert.deepEqual([pre.body.status, pre.body.stderr], [2, 'keep guard: refused\n']);
  assert.deepEqual(calls[2].args.slice(1), ['hook', 'pi', 'pre-tool']);
  const preInput = JSON.parse(calls[2].stdin);
  assert.deepEqual(preInput.tool_input, { command: 'terraform apply' });
  assert.deepEqual(preInput.repo_facts, facts);
  assert.equal(calls[2].options.env.KEEP_REPAIR, undefined);
  card = 'repair-card';
  await hooks.handle(AWS1, piBody('pi-pre-tool', { cwd, tool_name: 'Bash', tool_input: { command: 'ls' }, repo_facts: facts }));
  assert.equal(calls.at(-1).options.env.KEEP_REPAIR, '1', 'the daemon launched it to repair itself');
  await hooks.handle(AWS1, piBody('pi-start'));
  assert.equal(calls.at(-1).options.env.KEEP_REPAIR, undefined, 'only a pre-tool carries it');
  // The hook context answers a Pi session too: its pre-tool computes its facts by the fingerprints.
  assert.equal((await hooks.context(AWS1, 'pi-aws1')).status, 200);
});

test('a Pi pre-tool on the daemon judges a node\'s shell command by the node\'s facts, as a Claude pre-bash is judged', async (t) => {
  const root = registry(t);
  stepsRegistry(root);
  let card = '';
  const { hooks } = services(t, { root, realSpawn: true, cardForSession: () => card });
  const cwd = path.join(root, 'wt', 'infra', 'feature');
  const run = async (command, paths = { [cwd]: { top: cwd, main: path.join(root, 'infra') } }) => {
    const answer = await hooks.handle(AWS1, piBody('pi-pre-tool', { cwd, tool_name: 'Bash', tool_input: { command },
      repo_facts: { paths, deploy: null, head: {} } }));
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return answer.body;
  };
  const refused = await run('terraform apply -auto-approve');
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /^keep guard: `terraform apply` is step apply on ~\/infra/);
  const unreported = await run('terraform apply', {});
  assert.equal(unreported.status, 2);
  assert.match(unreported.stderr, /node aws1 did not report the repository/);
  assert.equal((await run('ls -la')).status, 0);
  card = 'repair-card';
  const repair = await run('keep restart-daemon');
  assert.equal(repair.status, 2);
  assert.match(repair.stderr, /restarts the daemon you were launched to repair/);
});

test('on the daemon a node Pi start binds the pane on that node\'s host with its instance, and its end stamps the release', async (t) => {
  const { withTwoNodes } = require('./fixtures/two-node-hosts.js');
  const hook = require('./commands/hook.js');
  const { connect } = require('./hostclient.js');
  await withTwoNodes(t, async ({ root, configFile }) => {
    const remote = await connect({ node: 'aws1' });
    const local = await connect({ node: 'main' });
    try {
      const { pane } = await remote.request('spawn', { cmd: '/bin/sh', args: ['-c', 'sleep 5'] });
      await remote.request('meta', { pane: pane.id, patch: { sessionId: 'pi-aws1', agent: 'pi' } });
      const { pane: mainPane } = await local.request('spawn', { cmd: '/bin/sh', args: ['-c', 'sleep 5'] });
      const env = { KEEP_CONFIG: configFile, KEEP_DAEMON_NODE: 'main', KEEP_NODE_NAME: 'main', KEEP_HOOK_NODE: 'aws1',
        KEEP_REMOTE_CALLER: 'aws1', KEEP_PANE: `${pane.id}@aws1` };
      const input = { session_id: 'pi-aws1', cwd: '/home/node/project', instance: PI_INSTANCE };
      const record = await hook.recordSessionPane(input, 'pi', { root, env, retryMs: 1 });
      assert.equal(record.bound, true);
      assert.equal(record.claimed, true, 'the launched pane already named this session');
      assert.equal(record.node, 'aws1');
      assert.equal(record.pane, `${pane.id}@aws1`);
      assert.equal(record.piInstance, PI_INSTANCE);
      const meta = (await remote.request('get', { pane: pane.id })).pane.meta;
      assert.equal(meta.sessionId, 'pi-aws1');
      assert.equal(meta.agent, 'pi');
      assert.equal(meta.project, '/home/node/project');
      assert.equal((await local.request('get', { pane: mainPane.id })).pane.meta.sessionId, undefined, 'the daemon\'s pane was never touched');

      // Another instance's end releases nothing; this one's stamps the record and
      // leaves the pane's meta for Watch and Reopen.
      assert.equal(await hook.releaseSessionPane({ ...input, instance: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, 'pi', { root, env }), undefined);
      const released = await hook.releaseSessionPane(input, 'pi', { root, env });
      assert.ok(released && Number.isFinite(released.released));
      assert.equal((await remote.request('get', { pane: pane.id })).pane.meta.sessionId, 'pi-aws1');
    } finally { remote.close(); local.close(); }
  });
});

// ---------- /new or /resume inside a Pi session on a node (bin/late-adoption.js, Pi rule) ----------

// The daemon opened Pi session pi-a on aws1 in pane p3 (pinned, its pane record naming
// the pane and the extension instance); `host` is aws1's host: its panes, and the
// phase files its transcript verb reads.
function piAdoptingServices(t, overrides = {}) {
  const root = tempDir(t);
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify({ version: 1, daemonNode: 'main', nodes: { main: {}, aws1: {} } })}\n`);
  const env = { PATH: process.env.PATH, HOME: root, LANG: 'C', KEEP_CONFIG: configFile };
  const accounts = require('./accounts.js');
  accounts.pinSession('pi-a', 'pi', 'pi/default', { root, env, node: 'aws1' });
  fs.mkdirSync(path.join(root, '.keep', 'panes'), { recursive: true });
  fs.writeFileSync(path.join(root, '.keep', 'panes', 'pi-a.json'), JSON.stringify({ at: 1, startedAt: 1, cwd: '/home/node/project',
    agent: 'pi', pane: 'p3@aws1', claimed: true, node: 'aws1', accountId: 'pi/default', bound: true, piInstance: PI_INSTANCE,
    ...(overrides.priorRecord || {}) }));
  const host = {
    asked: [],
    panes: [{ id: 'p3', alive: true, cwd: '/home/node/project',
      meta: { agent: 'pi', accountId: 'pi/default', sessionId: 'pi-a', node: 'aws1', project: '/home/node/project', ...(overrides.meta || {}) } }],
    events: { 'pi-a': { id: 'pi-a', phase: 'shutdown', at: '2026-09-23T10:00:00.000Z', pid: 4242, instance: PI_INSTANCE, ...(overrides.event || {}) } },
  };
  const fake = fakeSpawn(() => ({ code: 0, stdout: '' }));
  const logged = [];
  const linked = [];
  const registry = createRegistryService({
    root, spawn: fake.spawn, daemonNode: () => 'main', env, configFile, log: (line) => logged.push(line),
    location: (id) => accounts.sessionLocation(id, { root, env }),
    cardOfSession: (id) => (id === 'pi-a' ? 'pi-card' : null),
    linkLaunchedSession: (card, session) => { linked.push([card, session]); return { linked: session.id }; },
    hostConnect: async (node) => {
      assert.equal(node, 'aws1');
      return {
        request: async (type, params) => {
          host.asked.push(type === 'transcript' ? `${type}:${params.op}:${params.sessionId}` : type);
          if (type === 'list') return { panes: host.panes };
          assert.equal(type, 'transcript');
          assert.deepEqual(params, { op: 'pi-event', kind: 'pi', sessionId: params.sessionId });
          return { event: host.events[params.sessionId] || null };
        },
        close: () => {},
      };
    },
  });
  const hooks = createHookService({ root, registry });
  return { root, env, hooks, host, calls: fake.calls, logged, linked };
}

const piStartOf = (sessionId, input = {}, extra = {}) => piBody('pi-start', { session_id: sessionId, ...input },
  { identity: { agent: 'pi', sessionId, pane: 'p3@aws1' }, ...extra });

test('a /new inside a Pi session on a node is adopted from its start: pinned, its pane taken over, and put on the card', async (t) => {
  const { root, env, hooks, host, calls, logged, linked } = piAdoptingServices(t);
  const answer = await hooks.handle(AWS1, piStartOf('pi-b'));
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(host.asked, ['list', 'transcript:pi-event:pi-a'], 'one listing, then the earlier session\'s phase file');
  assert.deepEqual(require('./accounts.js').sessionLocation('pi-b', { root, env }), { node: 'aws1', agent: 'pi', accountId: 'pi/default' });
  const record = readJson(path.join(root, '.keep', 'panes', 'pi-b.json'));
  assert.deepEqual(withoutTimes(record), { cwd: '/home/node/project', agent: 'pi', pane: 'p3@aws1', claimed: true, node: 'aws1',
    accountId: 'pi/default', bound: false, piInstance: PI_INSTANCE, unattended: false, opener: null });
  const prior = readJson(path.join(root, '.keep', 'panes', 'pi-a.json'));
  assert.ok(Number.isFinite(prior.released), 'the earlier session is released, so the start can bind its pane');
  assert.equal(prior.successor, 'pi-b');
  assert.deepEqual(linked, [['pi-card', { id: 'pi-b', agent: 'pi', node: 'aws1' }]]);
  assert.deepEqual(calls.at(-1).args, [CLI, 'hook', 'pi', 'start']);
  assert.equal(calls.at(-1).options.env.KEEP_AGENT_ACCOUNT_ID, 'pi/default');
  assert.match(logged.join('\n'), /late adoption: pi session pi-b adopted on aws1 in pane p3@aws1 after pi-a \(account pi\/default\)/);
  // Placed now: its next post never asks the host.
  const end = await hooks.handle(AWS1, piBody('pi-end', { session_id: 'pi-b' }, { identity: { agent: 'pi', sessionId: 'pi-b', pane: 'p3@aws1' } }));
  assert.equal(end.status, 200);
  assert.equal(host.asked.length, 2);
  // A handed over once: another session naming A's pane and instance is refused.
  const again = await hooks.handle(AWS1, piStartOf('pi-c'));
  assert.equal(again.status, 403);
  assert.equal(require('./accounts.js').sessionLocation('pi-c', { root, env }), null);
});

test('a Pi start is adopted only on A\'s shutdown in the same process and instance, from the daemon\'s own A, and only from a start', async (t) => {
  const cases = [
    ['A still running', { event: { phase: 'settled' } }],
    ['no phase file', { event: { id: 'someone-else' } }],
    ['another instance shut A down', { event: { instance: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee' } }],
    ['another process shut A down', { event: { pid: 777 } }],
    ['A\'s pane record names another instance', { priorRecord: { piInstance: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee' } }],
    ['A\'s pane record names another pane', { priorRecord: { pane: 'p9@aws1' } }],
    ['A already handed over', { priorRecord: { successor: 'pi-z' } }],
    ['the pane runs Codex', { meta: { agent: 'codex' } }],
    ['the pane says it is elsewhere', { meta: { node: 'main' } }],
    ['the pane names no session', { meta: { sessionId: null } }],
  ];
  for (const [name, overrides] of cases) {
    const { root, env, hooks, calls, linked } = piAdoptingServices(t, overrides);
    const answer = await hooks.handle(AWS1, piStartOf('pi-b'));
    assert.equal(answer.status, 403, `${name}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.code, 'SESSION_NOT_ON_NODE', name);
    assert.equal(calls.length, 0, name);
    assert.equal(require('./accounts.js').sessionLocation('pi-b', { root, env }), null, name);
    assert.equal(fs.existsSync(path.join(root, '.keep', 'panes', 'pi-b.json')), false, name);
    assert.deepEqual(linked, [], name);
  }
  // A that the daemon never placed on the caller.
  const unplaced = piAdoptingServices(t);
  fs.rmSync(path.join(unplaced.root, '.keep', 'session-accounts'), { recursive: true, force: true });
  assert.equal((await unplaced.hooks.handle(AWS1, piStartOf('pi-b'))).status, 403);
  assert.equal(require('./accounts.js').sessionLocation('pi-b', { root: unplaced.root, env: unplaced.env }), null);
  // Only a start asks: a pre-tool or an end of the unknown session never reaches the host.
  const { hooks, host } = piAdoptingServices(t);
  const pre = await hooks.handle(AWS1, piBody('pi-pre-tool', { session_id: 'pi-b', tool_name: 'Bash', tool_input: { command: 'ls' }, repo_facts: NO_FACTS },
    { identity: { agent: 'pi', sessionId: 'pi-b', pane: 'p3@aws1' } }));
  assert.equal(pre.status, 403);
  assert.equal(pre.body.code, 'SESSION_NOT_ON_NODE');
  const end = await hooks.handle(AWS1, piBody('pi-end', { session_id: 'pi-b' }, { identity: { agent: 'pi', sessionId: 'pi-b', pane: 'p3@aws1' } }));
  assert.equal(end.status, 403);
  // Nor a start with no pane, instance or pid.
  assert.equal((await hooks.handle(AWS1, piStartOf('pi-b', {}, { identity: { agent: 'pi', sessionId: 'pi-b' } }))).status, 403);
  assert.equal((await hooks.handle(AWS1, piStartOf('pi-b', { instance: null, pid: null }))).status, 403);
  assert.deepEqual(host.asked, []);
  // The hook context never adopts a Pi session: it carries no instance or pid.
  assert.equal((await hooks.context(AWS1, 'pi-b', { agent: 'pi', pane: 'p3@aws1' })).status, 403);
  assert.deepEqual(host.asked, []);
});

test('a node\'s context ask whose adoption outlasts the client timeout answers from the node\'s cache, on time', async (t) => {
  const http = require('node:http');
  const client = require('./hook-client.js');
  const root = tempDir(t);
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify({ version: 1, daemonNode: 'main', nodes: { main: {}, aws1: {} } })}\n`);
  const env = { PATH: process.env.PATH, HOME: root, LANG: 'C', KEEP_CONFIG: configFile };
  let asked = 0;
  // aws1's host never answers: the adoption runs to its own deadline (about 2 s).
  const registry = createRegistryService({ root, spawn: fakeSpawn().spawn, daemonNode: () => 'main', env, configFile,
    location: (id) => require('./accounts.js').sessionLocation(id, { root, env }),
    hostConnect: () => { asked += 1; return new Promise(() => {}); } });
  const hooks = createHookService({ root, registry });
  const answered = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const began = Date.now();
    const answer = await hooks.context(AWS1, url.searchParams.get('session'),
      { agent: url.searchParams.get('agent'), pane: url.searchParams.get('pane') });
    answered.push({ status: answer.status, ms: Date.now() - began });
    if (!res.destroyed) { res.writeHead(answer.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer.body)); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const home = tempDir(t);
  const nodeEnv = { HOME: home };
  fs.mkdirSync(path.dirname(client.contextFile(nodeEnv)), { recursive: true });
  fs.writeFileSync(client.contextFile(nodeEnv), JSON.stringify({ at: 1, steps: ['terraform apply'], sessions: {} }));
  const began = Date.now();
  const context = await client.hookContext({ env: nodeEnv, where: { url: `http://127.0.0.1:${server.address().port}` }, token: 'aws1-secret',
    sessionId: 'codex-late', agent: 'codex', pane: 'p2@aws1', timeoutMs: 400 });
  const took = Date.now() - began;
  assert.deepEqual(context, { steps: ['terraform apply'], repairSession: null, fresh: false }, 'the last published steps, not fresh');
  assert.ok(took < 1500, `the ask gave up at its own timeout (${took} ms), not the adoption's`);
  // The daemon's adoption finishes on its own deadline and refuses; nothing waits on it.
  await new Promise((resolve) => { const poll = () => (answered.length ? resolve() : setTimeout(poll, 50)); poll(); });
  assert.equal(asked, 1);
  assert.equal(answered[0].status, 403);
  assert.ok(answered[0].ms >= 1900 && answered[0].ms < 3000, `the adoption ran to its deadline (${answered[0].ms} ms)`);
  assert.equal(JSON.parse(fs.readFileSync(client.contextFile(nodeEnv), 'utf8')).at, 1, 'the late answer never reached the cache');
});
