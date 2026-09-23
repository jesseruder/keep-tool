'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CLI = path.join(__dirname, 'keep.js');

// Every file under a directory with its bytes.
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) out[path.relative(root, file)] = fs.readFileSync(file, 'utf8');
    }
  };
  walk(root);
  return out;
}

// A stand-in for the daemon's /api/hook: records each post and answers with what
// the test's `answer` returns ({ status, body } or 'hang').
async function stubDaemon(t, answer) {
  const posts = [];
  const hung = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      const body = data ? JSON.parse(data) : {};
      posts.push({ url: req.url, token: req.headers['x-keep-node-token'], body });
      const result = answer(body, posts.length);
      if (result === 'hang') { hung.push(res); return; }
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { for (const res of hung) res.destroy(); server.close(resolve); }));
  return { posts, url: `http://127.0.0.1:${server.address().port}` };
}

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-hook-client-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const registry = path.join(base, 'registry');
  fs.mkdirSync(path.join(registry, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(registry, '.keep'), { recursive: true });
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const tokenFile = path.join(base, 'node-token');
  fs.writeFileSync(tokenFile, 'aws1-secret\n', { mode: 0o600 });
  const transcript = path.join(base, 'sess-aws1.jsonl');
  const env = (url, extra = {}) => {
    const value = { ...process.env, HOME: home, KEEP_DIR: registry, KEEP_NO_PUSH: '1', KEEP_NODE_NAME: 'aws1', KEEP_DAEMON_NODE: 'main',
      KEEP_DAEMON_URL: url, KEEP_NODE_TOKEN_FILE: tokenFile, KEEP_AGENT_ACCOUNT_ID: 'claude-node', ...extra };
    for (const key of ['CLAUDE_CODE_SESSION_ID', 'KEEP_PANE', 'KEEP_RUN', 'KEEP_CONFIG', 'CODEX_THREAD_ID', 'KEEP_REVIEWER', 'KEEP_HOST_SOCK']) {
      if (!(key in extra)) delete value[key];
    }
    value.KEEP_HOST_SOCK = path.join(base, 'no-host.sock');
    return value;
  };
  const hook = (event, url, input = {}, extra = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'hook', event], { env: env(url, extra), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify({ session_id: 'sess-aws1', transcript_path: transcript, cwd: '/home/node/project', ...input }));
  });
  const queue = () => {
    try { return fs.readdirSync(path.join(home, '.keep-node', 'hook-queue')).sort().map((name) => JSON.parse(fs.readFileSync(path.join(home, '.keep-node', 'hook-queue', name), 'utf8'))); } catch { return []; }
  };
  return { base, registry, home, transcript, hook, queue, env };
}

const ran = (stdout, status = 0) => ({ status: 200, body: { ok: status === 0, status, stdout, stderr: '', replayed: false } });

// A port nothing listens on.
async function closedUrl() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

test('each Claude event is posted with its transcript delta, and the node prints what the daemon answered', async (t) => {
  const f = fixture(t);
  const answers = {
    'session-start': ran('[keep — work registry]\ncontext from the daemon\n'),
    stop: ran('{"decision":"block","reason":"[keep] check in"}\n'),
    notification: ran(''),
    'pre-question': ran('{"hookSpecificOutput":{"permissionDecision":"deny"}}\n'),
    lifecycle: ran(''),
    'session-end': ran(''),
  };
  const daemon = await stubDaemon(t, (body) => answers[body.event]);
  const before = snapshot(f.registry);
  fs.writeFileSync(f.transcript, '{"n":1}\n');

  const started = await f.hook('session-start', daemon.url, { hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.stdout, '[keep — work registry]\ncontext from the daemon\n', 'the daemon\'s context, not the pane-only notice');
  const [first] = daemon.posts;
  assert.equal(first.url, '/api/hook');
  assert.equal(first.token, 'aws1-secret');
  assert.equal(first.body.event, 'session-start');
  assert.deepEqual(first.body.identity, { agent: 'claude', sessionId: 'sess-aws1', accountId: 'claude-node' });
  assert.deepEqual(first.body.input, { session_id: 'sess-aws1', transcript_path: f.transcript, cwd: '/home/node/project',
    hook_event_name: 'SessionStart', source: 'startup' });
  assert.match(first.body.idempotencyKey, /^[0-9a-f]{32}$/);
  const stat = fs.statSync(f.transcript);
  assert.deepEqual({ ...first.body.transcript, bytes: Buffer.from(first.body.transcript.bytes, 'base64').toString() }, {
    path: f.transcript, generation: `${stat.dev}:${stat.ino}:${Math.round(stat.birthtimeMs)}`, fromOffset: 0,
    size: 8, mtimeMs: stat.mtimeMs, bytes: '{"n":1}\n',
  });

  fs.appendFileSync(f.transcript, '{"n":2}\n');
  const stopped = await f.hook('stop', daemon.url, { hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(stopped.status, 0);
  assert.equal(stopped.stdout, '{"decision":"block","reason":"[keep] check in"}\n');
  const stopPost = daemon.posts[1].body;
  assert.equal(stopPost.transcript.fromOffset, 8, 'only what the daemon does not have');
  assert.equal(Buffer.from(stopPost.transcript.bytes, 'base64').toString(), '{"n":2}\n');
  assert.notEqual(stopPost.idempotencyKey, first.body.idempotencyKey);

  const question = await f.hook('pre-question', daemon.url, { tool_name: 'AskUserQuestion', tool_input: { questions: [] } });
  assert.equal(question.stdout, '{"hookSpecificOutput":{"permissionDecision":"deny"}}\n');
  for (const event of ['notification', 'lifecycle', 'session-end']) {
    const result = await f.hook(event, daemon.url, { hook_event_name: event === 'lifecycle' ? 'PreToolUse' : undefined });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(daemon.posts.map((post) => post.body.event),
    ['session-start', 'stop', 'pre-question', 'notification', 'lifecycle', 'session-end']);
  assert.equal(daemon.posts.at(-1).body.transcript.fromOffset, 16);
  assert.equal(daemon.posts.at(-1).body.transcript.bytes, '');
  assert.deepEqual(snapshot(f.registry), before, 'nothing written under the node\'s registry');
  assert.deepEqual(f.queue(), []);
});

test('the daemon\'s exit status and stderr come through as they are', async (t) => {
  const f = fixture(t);
  const daemon = await stubDaemon(t, () => ({ status: 200, body: { ok: false, status: 1, stdout: 'out\n', stderr: 'boom\n', replayed: false } }));
  const result = await f.hook('notification', daemon.url);
  assert.deepEqual(result, { status: 1, stdout: 'out\n', stderr: 'boom\n' });
});

test('a daemon that is not there gets each event\'s safe default, and the deliverable ones queue', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, '{"n":1}\n');
  const url = await closedUrl();
  const start = await f.hook('session-start', url);
  assert.equal(start.status, 0);
  assert.equal(start.stdout, 'Keep: this session is unmanaged on node aws1; the daemon is on main. '
    + `Its hooks and registry commands reach the daemon at ${url}; the daemon did not answer this start, so it is queued and resent with the next hook. `
    + 'Not available on this node: keep tell, keep open, keep codex task, and admin commands such as keep serve, keep restart-daemon and keep nodes add.\n');
  for (const event of ['stop', 'notification', 'lifecycle', 'pre-question', 'session-end']) {
    const result = await f.hook(event, url, { hook_event_name: event === 'lifecycle' ? 'PreToolUse' : undefined });
    assert.deepEqual(result, { status: 0, stdout: '', stderr: '' }, event);
  }
  const queued = f.queue();
  assert.deepEqual(queued.map((entry) => entry.event), ['session-start', 'stop', 'notification', 'lifecycle']);
  assert.deepEqual(queued.map((entry) => entry.seq), [1, 2, 3, 4]);
  assert.equal(queued[1].body.input.stop_hook_active, true, 'a late stop cannot hold a turn');
  assert.equal(queued[0].body.transcript, undefined, 'no bytes kept in the queue');
  assert.equal(JSON.stringify(queued).includes('"bytes"'), false);

  // A daemon that answers too late: the stop gives up at its own bound and lets the session stop.
  const slow = await stubDaemon(t, () => 'hang');
  const began = Date.now();
  const late = await f.hook('pre-question', slow.url, { tool_name: 'AskUserQuestion' });
  assert.deepEqual(late, { status: 0, stdout: '', stderr: '' });
  assert.ok(Date.now() - began < 6000, 'bounded');
});

test('the queue replays in order, with its own keys, once, before the next event', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, '{"n":1}\n');
  const url = await closedUrl();
  await f.hook('stop', url, { hook_event_name: 'Stop' });
  await f.hook('notification', url, { notification_type: 'idle_prompt' });
  const keys = f.queue().map((entry) => entry.body.idempotencyKey);
  assert.equal(keys.length, 2);

  const daemon = await stubDaemon(t, () => ran(''));
  fs.appendFileSync(f.transcript, '{"n":2}\n');
  const result = await f.hook('lifecycle', daemon.url, { hook_event_name: 'PostToolUse' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(daemon.posts.map((post) => post.body.event), ['stop', 'notification', 'lifecycle']);
  assert.deepEqual(daemon.posts.slice(0, 2).map((post) => post.body.idempotencyKey), keys);
  // The first replay carries the whole transcript the daemon never got; the rest nothing new.
  assert.equal(daemon.posts[0].body.transcript.fromOffset, 0);
  assert.equal(Buffer.from(daemon.posts[0].body.transcript.bytes, 'base64').toString(), '{"n":1}\n{"n":2}\n');
  assert.equal(daemon.posts[1].body.transcript.fromOffset, 16);
  assert.deepEqual(f.queue(), []);

  await f.hook('lifecycle', daemon.url, { hook_event_name: 'PostToolUse' });
  assert.deepEqual(daemon.posts.map((post) => post.body.event), ['stop', 'notification', 'lifecycle', 'lifecycle'], 'replayed once');
});

test('a refusal is not queued, and a queue past its cap drops the oldest', async (t) => {
  const f = fixture(t);
  const daemon = await stubDaemon(t, () => ({ status: 403, body: { error: 'session sess-aws1 is not on node aws1' } }));
  const refused = await f.hook('stop', daemon.url);
  assert.equal(refused.status, 0);
  assert.deepEqual(f.queue(), []);

  const client = require('./hook-client.js');
  const env = f.env(daemon.url);
  for (let i = 0; i < client.QUEUE_MAX + 3; i += 1) {
    client.enqueue(env, { event: 'notification', body: { input: { session_id: 'sess-aws1', cwd: '/x', n: i }, identity: { agent: 'claude', sessionId: 'sess-aws1' }, idempotencyKey: `k-${String(i).padStart(16, '0')}` } });
  }
  const queued = f.queue();
  assert.equal(queued.length, client.QUEUE_MAX);
  assert.equal(queued[0].body.input.n, 3);
  assert.equal(queued.at(-1).seq, client.QUEUE_MAX + 3);
});

test('a mirror that is elsewhere is resent from where the daemon says, and a long delta goes in chunks', async (t) => {
  const f = fixture(t);
  const client = require('./hook-client.js');
  const big = `${'x'.repeat(client.CHUNK_BYTES + 100)}\n`;
  fs.writeFileSync(f.transcript, big);
  let told = false;
  let mirrored = 0;
  const daemon = await stubDaemon(t, (body) => {
    const tr = body.transcript;
    // The daemon's mirror is at 10 bytes the first time it is asked.
    if (!told && tr) { told = true; mirrored = 10; return { status: 409, body: { error: 'resend', needFrom: 10 } }; }
    if (tr) {
      if (tr.fromOffset !== mirrored) return { status: 409, body: { error: 'resend', needFrom: mirrored } };
      mirrored += Buffer.from(tr.bytes, 'base64').length;
    }
    return body.event === 'transcript' ? { status: 200, body: { ok: true, size: mirrored } } : ran('');
  });
  const result = await f.hook('stop', daemon.url, { hook_event_name: 'Stop' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(mirrored, Buffer.byteLength(big));
  const events = daemon.posts.map((post) => `${post.body.event}@${post.body.transcript.fromOffset}`);
  assert.deepEqual(events, ['transcript@0', `transcript@10`, `stop@${10 + client.CHUNK_BYTES}`]);
  const cursor = JSON.parse(fs.readFileSync(path.join(f.home, '.keep-node', 'mirror', 'sess-aws1.json'), 'utf8'));
  assert.equal(cursor.sent, Buffer.byteLength(big));
  // A replaced file (another inode) starts again from 0.
  fs.rmSync(f.transcript);
  fs.writeFileSync(f.transcript, 'new\n');
  mirrored = 0;
  await f.hook('notification', daemon.url);
  assert.equal(daemon.posts.at(-1).body.transcript.fromOffset, 0);
});

test('without KEEP_DAEMON_URL the hooks are the pane-only hooks they were', async (t) => {
  const f = fixture(t);
  const before = snapshot(f.registry);
  const start = await f.hook('session-start', '', {}, { KEEP_DAEMON_URL: '' });
  assert.equal(start.status, 0);
  assert.match(start.stdout, /^Keep: this session is unmanaged on node aws1; the daemon is on main\. keep checkin and other registry commands are not available here: this node has no KEEP_DAEMON_URL/);
  // A Codex start with a daemon URL: registry commands reach it, its hooks do not yet.
  const codex = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'hook', 'codex', 'start'], { env: f.env('http://127.0.0.1:9'), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.once('close', () => resolve(stdout));
    child.stdin.end(JSON.stringify({ session_id: 'codex-aws1', cwd: '/home/node/project' }));
  });
  assert.match(JSON.parse(codex).hookSpecificOutput.additionalContext,
    /Registry commands \(keep checkin, keep add, keep reviewed, keep land and the rest\) reach the daemon at http:\/\/127\.0\.0\.1:9; this session's hooks do not yet\. Not available on this node: keep tell/);
  const stop = await f.hook('stop', '', {}, { KEEP_DAEMON_URL: '' });
  assert.deepEqual(stop, { status: 0, stdout: '', stderr: '' });
  assert.equal(fs.existsSync(path.join(f.home, '.keep-node')), false, 'no delivery state either');
  assert.deepEqual(snapshot(f.registry), before);
});
