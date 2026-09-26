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
      const result = answer(body, posts.length, req.url);
      if (result === 'hang') { hung.push(res); return; }
      if (result === 'reset') { req.socket.destroy(); return; }
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
    for (const key of ['CLAUDE_CODE_SESSION_ID', 'KEEP_PANE', 'KEEP_RUN', 'KEEP_CONFIG', 'CODEX_THREAD_ID', 'KEEP_REVIEWER', 'KEEP_HOST_SOCK',
      'KEEP_AUTO_CONTINUE', 'CLAUDE_CODE_ENTRYPOINT', 'KEEP_DELEGATION_ID']) {
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
    + `Its hooks, the command guards and the deploy and step records among them, and its registry commands reach the daemon at ${url}; `
    + 'the daemon did not answer this start, so it is queued and resent with the next hook. '
    + 'Not available on this node: keep tell, keep open, keep codex task, and admin commands such as keep serve, keep restart-daemon and keep nodes add.\n');
  for (const event of ['stop', 'notification', 'lifecycle', 'pre-question']) {
    const result = await f.hook(event, url, { hook_event_name: event === 'lifecycle' ? 'PreToolUse' : undefined });
    assert.deepEqual(result, { status: 0, stdout: '', stderr: '' }, event);
  }
  const queued = f.queue();
  assert.deepEqual(queued.map((entry) => entry.event), ['session-start', 'stop', 'notification', 'lifecycle']);
  assert.deepEqual(queued.map((entry) => entry.seq), [1, 2, 3, 4]);
  assert.equal(queued[1].body.input.stop_hook_active, true, 'a late stop cannot hold a turn');
  assert.equal(JSON.stringify(queued).includes('"bytes"'), false);
  const stat = fs.statSync(f.transcript);
  assert.deepEqual(queued[0].body.transcript, { generation: `${stat.dev}:${stat.ino}:${Math.round(stat.birthtimeMs)}`, size: 8, mtimeMs: stat.mtimeMs },
    'where the transcript ended when the event fired');
  assert.ok(queued.every((entry) => Number.isSafeInteger(entry.body.identity.firedAt)), 'and when it fired');
  // The session's end drops what it had queued: nothing of it may be replayed after.
  const end = await f.hook('session-end', url, { hook_event_name: 'SessionEnd' });
  assert.deepEqual(end, { status: 0, stdout: '', stderr: '' });
  assert.deepEqual(f.queue(), []);
  assert.match(fs.readFileSync(path.join(f.home, '.keep-node', 'hook.log'), 'utf8'), /dropped queued session-start for session sess-aws1 \(seq 1\): the session ended/);

  // A daemon that answers too late: the stop gives up at its own bound and lets the session stop.
  const slow = await stubDaemon(t, () => 'hang');
  const began = Date.now();
  const late = await f.hook('pre-question', slow.url, { tool_name: 'AskUserQuestion' });
  assert.deepEqual(late, { status: 0, stdout: '', stderr: '' });
  assert.ok(Date.now() - began < 6000, 'bounded');
});

test('a queued Codex stop is replayed as a stop that cannot hold a turn, as a Claude one is', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, '{"n":1}\n');
  const url = await closedUrl();
  const result = await codexRun(f, 'stop', url, codexInput(f, { hook_event_name: 'Stop', stop_hook_active: false }));
  assert.deepEqual(onlyJson(result), {});
  const [queued] = f.queue();
  assert.equal(queued.event, 'codex-stop');
  assert.equal(queued.body.input.stop_hook_active, true, 'a late stop cannot hold a turn');
  // The replay delivers it that way.
  const daemon = await stubDaemon(t, () => ran('{}\n'));
  await codexRun(f, 'lifecycle', daemon.url, codexInput(f, { hook_event_name: 'UserPromptSubmit' }));
  assert.deepEqual(daemon.posts.map((post) => post.body.event), ['codex-stop', 'codex-lifecycle']);
  assert.equal(daemon.posts[0].body.input.stop_hook_active, true);
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
  // The first replay carries the transcript as it stood when the stop fired, and no
  // more; the notification saw nothing new; the live event sends the rest.
  assert.equal(daemon.posts[0].body.transcript.fromOffset, 0);
  assert.equal(Buffer.from(daemon.posts[0].body.transcript.bytes, 'base64').toString(), '{"n":1}\n');
  assert.equal(daemon.posts[1].body.transcript.fromOffset, 8);
  assert.equal(daemon.posts[1].body.transcript.bytes, '');
  assert.equal(daemon.posts[2].body.transcript.fromOffset, 8);
  assert.equal(Buffer.from(daemon.posts[2].body.transcript.bytes, 'base64').toString(), '{"n":2}\n');
  assert.equal(typeof daemon.posts[0].body.identity.firedAt, 'number', 'a replay says when it fired');
  assert.equal(daemon.posts[2].body.identity.firedAt, undefined, 'a live event does not');
  assert.deepEqual(f.queue(), []);

  await f.hook('lifecycle', daemon.url, { hook_event_name: 'PostToolUse' });
  assert.deepEqual(daemon.posts.map((post) => post.body.event), ['stop', 'notification', 'lifecycle', 'lifecycle'], 'replayed once');
});

test('a refusal is not queued, and a queue past its cap drops the oldest', async (t) => {
  const f = fixture(t);
  const daemon = await stubDaemon(t, () => ({ status: 403, body: { error: 'session sess-aws1 is not on node aws1', code: 'SESSION_NOT_ON_NODE' } }));
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
  const big = `${'x'.repeat(client.CHUNK_FIRST * 2 + 100)}\n`;
  fs.writeFileSync(f.transcript, big);
  let told = false;
  let mirrored = 0;
  const daemon = await stubDaemon(t, (body, n, url) => {
    // The mirror query finds nothing to start from.
    if (url.startsWith('/api/hook/mirror')) return { status: 200, body: { generation: null, size: 0 } };
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
  assert.equal(daemon.posts[0].url, '/api/hook/mirror?session=sess-aws1', 'a node with no cursor asks before a large upload');
  const posts = daemon.posts.filter((post) => post.url === '/api/hook').map((post) => post.body);
  const events = posts.map((post) => `${post.event}@${post.transcript.fromOffset}`);
  assert.deepEqual(events.slice(0, 2), ['transcript@0', 'transcript@10']);
  assert.equal(posts.at(-1).event, 'stop');
  // Before a rate is measured a chunk is CHUNK_FIRST; after, what the link carries,
  // never past CHUNK_MAX, each starting where the one before ended.
  const sizes = posts.map((post) => Buffer.from(post.transcript.bytes, 'base64').length);
  assert.deepEqual(sizes.slice(0, 2), [client.CHUNK_FIRST, client.CHUNK_FIRST]);
  for (let i = 1; i < posts.length; i += 1) {
    assert.ok(sizes[i] <= client.CHUNK_MAX);
    if (i > 1) assert.equal(posts[i].transcript.fromOffset, posts[i - 1].transcript.fromOffset + sizes[i - 1]);
  }
  const link = JSON.parse(fs.readFileSync(path.join(f.home, '.keep-node', 'link.json'), 'utf8'));
  assert.ok(link.bytesPerSec > 0 && Number.isFinite(link.at), 'the chunks measured the link');
  const cursor = JSON.parse(fs.readFileSync(path.join(f.home, '.keep-node', 'mirror', 'sess-aws1.json'), 'utf8'));
  assert.equal(cursor.sent, Buffer.byteLength(big));
  // A replaced file (another inode) starts again from 0.
  fs.rmSync(f.transcript);
  fs.writeFileSync(f.transcript, 'new\n');
  mirrored = 0;
  await f.hook('notification', daemon.url);
  assert.equal(daemon.posts.at(-1).body.transcript.fromOffset, 0);
});

test('with a measured link rate, each chunk is what the link carries in the time left, and the cursor moves with each one', async (t) => {
  const f = fixture(t);
  const client = require('./hook-client.js');
  const env = { HOME: f.home };
  // What the second call leaves for the event's own post is over 64 KiB, so it would
  // be a sample if the event's post measured the link.
  const total = 987136 + 83968 + 70000;
  fs.writeFileSync(f.transcript, 'x'.repeat(total));
  fs.mkdirSync(path.join(f.home, '.keep-node'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.keep-node', 'link.json'), JSON.stringify({ bytesPerSec: 100 * 1024, at: 1 }));
  const cursor = () => {
    try { return JSON.parse(fs.readFileSync(client.cursorFile(env, 'sess-aws1'), 'utf8')).sent; } catch { return null; }
  };
  // Every chunk takes one second on this link; the event's own post five, the
  // daemon's hook running behind it.
  let clock = 0;
  const posts = [];
  const request = async (url, pathname, { method, payload }) => {
    if (method === 'GET') { posts.push({ ask: pathname }); return { status: 404, data: '{"error":"not found"}' }; }
    const raw = payload.transcript ? Buffer.from(payload.transcript.bytes, 'base64').length : 0;
    posts.push({ event: payload.event, from: payload.transcript.fromOffset, raw, cursor: cursor() });
    clock += payload.event === 'transcript' ? 1000 : 5000;
    return payload.event === 'transcript' ? { status: 200, data: '{"ok":true}' } : { status: 200, data: JSON.stringify({ ok: true, status: 0, stdout: '', stderr: '' }) };
  };
  const common = { event: 'stop', input: { session_id: 'sess-aws1' }, identity: { agent: 'claude', sessionId: 'sess-aws1' }, key: 'k'.repeat(32),
    transcriptPath: f.transcript, snapshot: client.snapshotOf(f.transcript), where: { url: 'http://127.0.0.1:1' }, token: 't', env,
    deps: { request, now: () => clock } };
  const first = await client.deliver({ ...common, deadline: 10_200 });
  assert.deepEqual(first, { ok: false, retry: true, why: 'out of time' }, 'no chunk started with 200 ms left');
  assert.deepEqual(posts[0], { ask: '/api/hook/mirror?session=sess-aws1' }, 'no cursor: the daemon is asked first');
  const chunks = posts.slice(1);
  // 100 KiB/s over the 2 s window, halved; with 1.2 s left, 61440 bytes, raised to CHUNK_MIN.
  assert.deepEqual(chunks.map((post) => post.raw), [...Array(9).fill(100 * 1024), client.CHUNK_MIN]);
  let at = 0;
  for (const [i, post] of chunks.entries()) {
    assert.equal(post.event, 'transcript');
    assert.equal(post.from, at);
    if (i > 0) assert.equal(post.cursor, at, 'the cursor stood at the chunk before');
    at += post.raw;
  }
  assert.equal(cursor(), at, 'the cursor is at the last chunk that landed');
  // The last chunk measured 64 KiB/s: the average moves halfway to it.
  assert.equal(JSON.parse(fs.readFileSync(client.linkFile(env), 'utf8')).bytesPerSec, (100 * 1024 + client.CHUNK_MIN) / 2);

  // The next event goes on from the cursor at the new rate, and the event itself
  // carries the rest once it fits one chunk.
  posts.length = 0;
  clock = 20_000;
  const next = await client.deliver({ ...common, deadline: 30_000 });
  assert.equal(next.ok, true);
  const rate = (100 * 1024 + client.CHUNK_MIN) / 2;
  assert.deepEqual(posts.map((post) => [post.event, post.from, post.raw]), [['transcript', at, rate], ['stop', at + rate, 70000]]);
  assert.equal(JSON.parse(fs.readFileSync(client.linkFile(env), 'utf8')).bytesPerSec, rate,
    'the slow event post, 70000 bytes in 5 s, is not a sample');
  assert.equal(cursor(), total);
  assert.equal(client.chunkSize({ HOME: f.home }, 50, clock), client.CHUNK_MIN);
  const nowhere = { HOME: path.join(f.home, 'nowhere') };
  assert.equal(client.chunkSize(nowhere, 5000, clock), client.CHUNK_FIRST, 'no rate known yet');
  assert.equal(client.chunkSize(nowhere, 1000, clock), client.CHUNK_FIRST / 2, 'CHUNK_FIRST is a cap, and the first chunk fits the time left');
  assert.equal(client.chunkSize({ HOME: f.home }, 5000, clock + client.LINK_TTL_MS), client.CHUNK_FIRST, 'a rate an hour old is not believed');

  // The event's own post keeps the floor when it carries bytes.
  fs.appendFileSync(f.transcript, 'y'.repeat(1000));
  posts.length = 0;
  const late = await client.deliver({ ...common, snapshot: client.snapshotOf(f.transcript), deadline: clock + 200 });
  assert.deepEqual(late, { ok: false, retry: true, why: 'out of time' });
  assert.deepEqual(posts, [], 'nothing sent with 200 ms left');
});

// deliver() in this process, with a clock and a daemon the test drives.
function driven(f, answer) {
  const client = require('./hook-client.js');
  const env = { HOME: f.home };
  const state = { clock: 0, posts: [] };
  const request = async (url, pathname, options) => {
    if (options.method === 'GET') return { status: 404, data: '{"error":"not found"}' };
    const { payload, timeoutMs } = options;
    const transcript = payload.transcript;
    state.posts.push({ event: payload.event, from: transcript ? transcript.fromOffset : null,
      raw: transcript ? Buffer.from(transcript.bytes, 'base64').length : null, timeoutMs });
    return answer(payload, timeoutMs, state);
  };
  const run = (extra) => client.deliver({ event: 'stop', input: { session_id: 'sess-aws1' }, identity: { agent: 'claude', sessionId: 'sess-aws1' },
    key: 'k'.repeat(32), transcriptPath: f.transcript, where: { url: 'http://127.0.0.1:1' }, token: 't', env,
    deps: { request, now: () => state.clock }, ...extra });
  return { env, state, run };
}
const landed = (payload) => (payload.event === 'transcript' ? { status: 200, data: '{"ok":true}' }
  : { status: 200, data: JSON.stringify({ ok: true, status: 0, stdout: '', stderr: '' }) });

test('a link that slows after a fast measurement brings the chunks down with it', async (t) => {
  const f = fixture(t);
  const client = require('./hook-client.js');
  const MiB = 1024 * 1024;
  fs.writeFileSync(f.transcript, 'x'.repeat(5 * MiB));
  fs.mkdirSync(path.join(f.home, '.keep-node'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.keep-node', 'link.json'), JSON.stringify({ bytesPerSec: 4 * MiB, at: 0 }));
  let slow = true;
  const d = driven(f, (payload, timeoutMs, state) => {
    if (payload.event === 'transcript' && slow) {
      state.clock += timeoutMs;
      throw Object.assign(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`), { timedOut: true });
    }
    state.clock += 100;
    return landed(payload);
  });
  const snapshot = client.snapshotOf(f.transcript);
  const first = await d.run({ snapshot, deadline: 10_000 });
  // A 4 MiB chunk at 4 MiB/s waits four times its second, not the whole ten.
  assert.deepEqual(d.state.posts.map((post) => [post.raw, post.timeoutMs]), [[4 * MiB, 4000]]);
  assert.deepEqual(first, { ok: false, retry: true, why: `a chunk of ${4 * MiB} bytes did not land in 4000 ms` },
    'not a link failure: a replay goes on to the other sessions');
  // 4 MiB did not land in 4 s: at most 1 MiB/s, lower than half the stored rate.
  assert.equal(JSON.parse(fs.readFileSync(client.linkFile(d.env), 'utf8')).bytesPerSec, MiB);

  slow = false;
  d.state.posts.length = 0;
  d.state.clock = 20_000;
  const next = await d.run({ snapshot, deadline: 30_000 });
  assert.equal(next.ok, true);
  assert.equal(d.state.posts[0].raw, MiB, 'the next chunk is the size the slower link carries');
  assert.equal(d.state.posts.at(-1).event, 'stop');
});

test('a chunk answered with a mirror past what the event saw sends the event without bytes', async (t) => {
  const f = fixture(t);
  const client = require('./hook-client.js');
  fs.writeFileSync(f.transcript, 'x'.repeat(600 * 1024));
  const snapshot = client.snapshotOf(f.transcript);
  // Another hook sent a later turn's bytes: the mirror is past this event's end.
  fs.appendFileSync(f.transcript, 'y'.repeat(100 * 1024));
  const d = driven(f, (payload) => (payload.event === 'transcript'
    ? { status: 409, data: JSON.stringify({ error: 'resend', needFrom: 650 * 1024 }) } : landed(payload)));
  const result = await d.run({ snapshot, deadline: 10_000 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(d.state.posts.map((post) => [post.event, post.from]), [['transcript', 0], ['stop', null]]);
  // The cursor is where the mirror said it is, so the next event sends only what follows.
  assert.equal(JSON.parse(fs.readFileSync(client.cursorFile(d.env, 'sess-aws1'), 'utf8')).sent, 650 * 1024);
  d.state.posts.length = 0;
  const next = await d.run({ snapshot: client.snapshotOf(f.transcript), deadline: 20_000 });
  assert.equal(next.ok, true);
  assert.deepEqual(d.state.posts.map((post) => [post.event, post.from, post.raw]), [['stop', 650 * 1024, 50 * 1024]]);
});

test('only a chunk its own timeout cut off, after most of that timeout, lowers the link rate', async (t) => {
  const client = require('./hook-client.js');
  const MiB = 1024 * 1024;
  const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
  const timedOut = () => Object.assign(new Error('timed out after 4s'), { timedOut: true });
  const cases = [
    // [what is stored, what the chunk meets, what the stored rate is after, whether the replay reads it as the link]
    ['no rate, refused', null, () => { throw refused(); }, null, true],
    // 256 KiB in 4 s: 64 KiB/s, under half of what CHUNK_FIRST assumes.
    ['no rate, cut off by its timeout', null, (timeoutMs, state) => { state.clock += timeoutMs; throw timedOut(); }, 64 * 1024, false],
    ['no rate, cut off at once', null, (timeoutMs, state) => { state.clock += 10; throw timedOut(); }, null, false],
    ['a rate, refused', 4 * MiB, () => { throw refused(); }, 4 * MiB, true],
    ['a rate, reset', 4 * MiB, () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); }, 4 * MiB, true],
    ['a rate, a timeout error at once', 4 * MiB, (timeoutMs, state) => { state.clock += 10; throw timedOut(); }, 4 * MiB, false],
    ['a rate, cut off by its timeout', 4 * MiB, (timeoutMs, state) => { state.clock += timeoutMs; throw timedOut(); }, MiB, false],
    // What says a chunk was cut off is the tag, not the words.
    ['a rate, an untagged error that says it timed out', 4 * MiB, (timeoutMs, state) => { state.clock += timeoutMs; throw new Error('timed out after 4s'); }, 4 * MiB, true],
  ];
  for (const [name, stored, meet, after, link] of cases) {
    const f = fixture(t);
    fs.writeFileSync(f.transcript, 'x'.repeat(5 * MiB));
    fs.mkdirSync(path.join(f.home, '.keep-node'), { recursive: true });
    const linkFile = path.join(f.home, '.keep-node', 'link.json');
    if (stored) fs.writeFileSync(linkFile, JSON.stringify({ bytesPerSec: stored, at: 0 }));
    const d = driven(f, (payload, timeoutMs, state) => (payload.event === 'transcript' ? meet(timeoutMs, state) : landed(payload)));
    const result = await d.run({ snapshot: client.snapshotOf(f.transcript), deadline: 10_000 });
    assert.equal(result.ok, false, name);
    assert.equal(result.retry, true, name);
    assert.equal(Boolean(result.link), link, `${name}: ${result.why}`);
    assert.equal(d.state.posts.length, 1, name);
    if (after === null) assert.equal(fs.existsSync(linkFile), false, `${name}: nothing measured`);
    else assert.equal(JSON.parse(fs.readFileSync(linkFile, 'utf8')).bytesPerSec, after, name);
  }

  // A chunk that cannot be read never reaches the link, and measures nothing.
  if (process.getuid && process.getuid() !== 0) {
    const f = fixture(t);
    fs.writeFileSync(f.transcript, 'x'.repeat(5 * MiB));
    fs.mkdirSync(path.join(f.home, '.keep-node'), { recursive: true });
    const linkFile = path.join(f.home, '.keep-node', 'link.json');
    fs.writeFileSync(linkFile, JSON.stringify({ bytesPerSec: 4 * MiB, at: 0 }));
    const snapshot = client.snapshotOf(f.transcript);
    fs.chmodSync(f.transcript, 0o000);
    t.after(() => { try { fs.chmodSync(f.transcript, 0o600); } catch {} });
    const d = driven(f, landed);
    const result = await d.run({ snapshot, deadline: 10_000 });
    assert.equal(result.ok, false);
    assert.deepEqual(d.state.posts, [], 'nothing sent');
    assert.equal(JSON.parse(fs.readFileSync(linkFile, 'utf8')).bytesPerSec, 4 * MiB);
  }
});

test('a hook that runs out of time leaves the cursor at the last chunk that landed, and queues its event', async (t) => {
  const f = fixture(t);
  const client = require('./hook-client.js');
  fs.writeFileSync(f.transcript, 'x'.repeat(512 * 1024));
  fs.mkdirSync(path.join(f.home, '.keep-node'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.keep-node', 'link.json'), JSON.stringify({ bytesPerSec: 128 * 1024, at: Date.now() }));
  // The first chunk lands; nothing after it is answered.
  let landed = 0;
  const daemon = await stubDaemon(t, (body, n, url) => {
    if (url.startsWith('/api/hook/mirror')) return { status: 404, body: { error: 'not found' } };
    if (body.event === 'transcript' && !landed) { landed += 1; return { status: 200, body: { ok: true } }; }
    return 'hang';
  });
  const result = await f.hook('notification', daemon.url, { notification_type: 'idle_prompt' });
  assert.deepEqual(result, { status: 0, stdout: '', stderr: '' });
  const posts = daemon.posts.filter((post) => post.url === '/api/hook').map((post) => post.body);
  assert.equal(posts[0].event, 'transcript');
  assert.equal(Buffer.from(posts[0].transcript.bytes, 'base64').length, 128 * 1024, 'the chunk the stored rate gives');
  assert.equal(posts[1].transcript.fromOffset, 128 * 1024, 'the next post goes on from there');
  const cursor = JSON.parse(fs.readFileSync(client.cursorFile({ HOME: f.home }, 'sess-aws1'), 'utf8'));
  assert.equal(cursor.sent, 128 * 1024);
  assert.deepEqual(f.queue().map((entry) => entry.event), ['notification']);
});

test('a node with no cursor starts from what the daemon\'s mirror already holds of the same transcript', async (t) => {
  const f = fixture(t);
  const client = require('./hook-client.js');
  const total = 400 * 1024;
  const held = 300 * 1024;
  fs.writeFileSync(f.transcript, 'y'.repeat(total));
  const stat = fs.statSync(f.transcript);
  let generation = `${stat.dev}:${stat.ino}:${Math.round(stat.birthtimeMs)}`;
  const daemon = await stubDaemon(t, (body, n, url) => {
    if (url.startsWith('/api/hook/mirror')) return { status: 200, body: { generation, size: held, mtimeMs: 1 } };
    return body.event === 'transcript' ? { status: 200, body: { ok: true } } : ran('');
  });
  const result = await f.hook('notification', daemon.url, { notification_type: 'idle_prompt' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(daemon.posts.map((post) => post.url), ['/api/hook/mirror?session=sess-aws1', '/api/hook']);
  const post = daemon.posts[1].body;
  assert.equal(post.event, 'notification');
  assert.equal(post.transcript.fromOffset, held, 'the prefix the daemon holds is never sent again');
  assert.equal(Buffer.from(post.transcript.bytes, 'base64').length, total - held);
  const cursorFile = client.cursorFile({ HOME: f.home }, 'sess-aws1');
  assert.equal(JSON.parse(fs.readFileSync(cursorFile, 'utf8')).sent, total);

  // A mirror of another generation (a transcript since replaced) is not a prefix of this one.
  fs.rmSync(cursorFile);
  generation = '1:2:3';
  const before = daemon.posts.length;
  await f.hook('notification', daemon.url, { notification_type: 'idle_prompt' });
  const later = daemon.posts.slice(before);
  assert.equal(later[0].url, '/api/hook/mirror?session=sess-aws1');
  assert.equal(later.find((item) => item.url === '/api/hook').body.transcript.fromOffset, 0);
  assert.equal(JSON.parse(fs.readFileSync(cursorFile, 'utf8')).sent, total);

  // A cursor for this transcript: nothing is asked.
  const asked = daemon.posts.filter((item) => item.url.startsWith('/api/hook/mirror')).length;
  fs.appendFileSync(f.transcript, 'z'.repeat(300 * 1024));
  await f.hook('notification', daemon.url, { notification_type: 'idle_prompt' });
  assert.equal(daemon.posts.filter((item) => item.url.startsWith('/api/hook/mirror')).length, asked);
});

test('without KEEP_DAEMON_URL the hooks are the pane-only hooks they were', async (t) => {
  const f = fixture(t);
  const before = snapshot(f.registry);
  const start = await f.hook('session-start', '', {}, { KEEP_DAEMON_URL: '' });
  assert.equal(start.status, 0);
  assert.match(start.stdout, /^Keep: this session is unmanaged on node aws1; the daemon is on main\. keep checkin and other registry commands are not available here: this node has no KEEP_DAEMON_URL/);
  // A Codex start without a daemon URL: the pane-only JSON it always printed.
  const codex = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'hook', 'codex', 'start'], { env: f.env(''), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.once('close', () => resolve(stdout));
    child.stdin.end(JSON.stringify({ session_id: 'codex-aws1', cwd: '/home/node/project' }));
  });
  assert.match(JSON.parse(codex).hookSpecificOutput.additionalContext, /this node has no KEEP_DAEMON_URL/);
  const stop = await f.hook('stop', '', {}, { KEEP_DAEMON_URL: '' });
  assert.deepEqual(stop, { status: 0, stdout: '', stderr: '' });
  assert.equal(fs.existsSync(path.join(f.home, '.keep-node')), false, 'no delivery state either');
  assert.deepEqual(snapshot(f.registry), before);
});

test('a session whose end comes before its queued start never has the start replayed', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, '{"n":1}\n');
  const url = await closedUrl();
  await f.hook('session-start', url, { hook_event_name: 'SessionStart', source: 'startup' });
  await f.hook('stop', url, { hook_event_name: 'Stop' });
  assert.deepEqual(f.queue().map((entry) => entry.event), ['session-start', 'stop']);
  // Another session's queued event is not this end's to drop.
  await f.hook('notification', url, { session_id: 'sess-other', notification_type: 'idle_prompt' });

  const daemon = await stubDaemon(t, () => ran(''));
  const end = await f.hook('session-end', daemon.url, { hook_event_name: 'SessionEnd', reason: 'exit' });
  assert.equal(end.status, 0, end.stderr);
  assert.deepEqual(daemon.posts.map((post) => `${post.body.event}:${post.body.identity.sessionId}`),
    ['notification:sess-other', 'session-end:sess-aws1'], 'the start and stop were dropped, never sent');
  assert.deepEqual(f.queue(), []);
  await f.hook('lifecycle', daemon.url, { hook_event_name: 'PostToolUse' });
  assert.equal(daemon.posts.some((post) => post.body.event === 'session-start'), false);
});

test('hooks that enqueue at the same moment each keep their entry', async (t) => {
  const f = fixture(t);
  const client = require('./hook-client.js');
  // Several processes, released together, each enqueuing as fast as it can: every
  // one computes the next number from the same directory at nearly the same time.
  const workers = 4;
  const each = 25;
  const go = Date.now() + 400;
  const script = `
    const client = require(${JSON.stringify(path.join(__dirname, 'hook-client.js'))});
    const env = { HOME: ${JSON.stringify(f.home)} };
    while (Date.now() < ${go}) {}
    for (let i = 0; i < ${each}; i += 1) {
      client.enqueue(env, { event: 'notification', body: { input: { session_id: 'sess-aws1', cwd: '/x', w: process.argv[1], i },
        identity: { agent: 'claude', sessionId: 'sess-aws1' }, idempotencyKey: 'k' + process.argv[1] + '-' + String(i).padStart(16, '0') } });
    }`;
  await Promise.all(Array.from({ length: workers }, (_, w) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, String(w)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => (status === 0 ? resolve() : reject(new Error(stderr))));
  })));
  const queued = f.queue();
  assert.equal(queued.length, workers * each, 'no entry lost to another with the same number');
  assert.equal(new Set(queued.map((entry) => entry.seq)).size, workers * each);
  assert.equal(new Set(queued.map((entry) => entry.body.idempotencyKey)).size, workers * each);
  for (let w = 0; w < workers; w += 1) {
    const mine = queued.filter((entry) => entry.body.input.w === String(w)).map((entry) => entry.body.input.i);
    assert.deepEqual(mine, [...mine].sort((a, b) => a - b), 'each process\'s entries in its order');
  }
  assert.equal(fs.readdirSync(client.stateDir({ HOME: f.home })).some((name) => name.endsWith('.tmp')), false, 'nothing left aside');
});

test('an event never overtakes its session\'s events the replay could not finish', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, '{"n":1}\n');
  const url = await closedUrl();
  await f.hook('stop', url, { hook_event_name: 'Stop' });
  await f.hook('notification', url, { session_id: 'sess-other', notification_type: 'idle_prompt' });
  assert.deepEqual(f.queue().map((entry) => entry.event), ['stop', 'notification']);
  // The notification's own replay met the closed daemon on the stop.
  const stateFile = path.join(f.home, '.keep-node', 'hook-queue.state.json');
  const stalled = () => Object.keys(JSON.parse(fs.readFileSync(stateFile, 'utf8')).stalled).sort();
  assert.deepEqual(stalled(), ['sess-aws1']);

  // The daemon takes the replayed notification (sess-aws1 goes last) and never
  // answers it: the replay's time runs out with the stop still queued, so the new
  // event waits behind it.
  const slow = await stubDaemon(t, () => 'hang');
  const result = await f.hook('lifecycle', slow.url, { hook_event_name: 'PostToolUse' });
  assert.deepEqual(result, { status: 0, stdout: '', stderr: '' }, 'the safe default');
  assert.deepEqual(slow.posts.map((post) => post.body.event), ['notification'], 'nothing of sess-aws1 posted');
  assert.deepEqual(f.queue().map((entry) => `${entry.event}:${entry.body.identity.sessionId}`),
    ['stop:sess-aws1', 'notification:sess-other', 'lifecycle:sess-aws1'], 'queued behind it, in order');
  assert.deepEqual(stalled(), ['sess-aws1', 'sess-other']);

  // A daemon that answers: the queue drains, both sessions stalled and so in queue
  // order, then the new event goes.
  const daemon = await stubDaemon(t, () => ran(''));
  const next = await f.hook('lifecycle', daemon.url, { hook_event_name: 'PostToolUse' });
  assert.equal(next.status, 0, next.stderr);
  assert.deepEqual(daemon.posts.map((post) => `${post.body.event}:${post.body.identity.sessionId}`),
    ['stop:sess-aws1', 'notification:sess-other', 'lifecycle:sess-aws1', 'lifecycle:sess-aws1'], 'drained, then the new one');
  assert.deepEqual(f.queue(), []);
  assert.equal(fs.existsSync(stateFile), false, 'nothing is stalled any more');
});

test('another session\'s queued events do not hold this session\'s event back', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, '{"n":1}\n');
  const url = await closedUrl();
  await f.hook('notification', url, { session_id: 'sess-other', notification_type: 'idle_prompt' });
  // The daemon never answers sess-other's replay, and answers this session.
  const daemon = await stubDaemon(t, (body) => (body.identity.sessionId === 'sess-other' ? 'hang' : ran('context\n')));
  const result = await f.hook('session-start', daemon.url, { hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(result.stdout, 'context\n');
  assert.deepEqual(daemon.posts.map((post) => post.body.event), ['notification', 'session-start']);
  assert.deepEqual(f.queue().map((entry) => entry.body.identity.sessionId), ['sess-other']);
});

test('a session the daemon keeps refusing goes last, and the other sessions\' entries deliver in the same replay', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, '{"n":1}\n');
  const url = await closedUrl();
  await f.hook('notification', url, { session_id: 'sess-stuck', notification_type: 'idle_prompt' });
  await f.hook('notification', url, { session_id: 'sess-other', notification_type: 'idle_prompt' });
  await f.hook('stop', url, { session_id: 'sess-stuck', hook_event_name: 'Stop' });
  const label = (post) => `${post.body.event}:${post.body.identity.sessionId}`;
  // The closed daemon's replays recorded a stalled session; start with none.
  const stateFile = path.join(f.home, '.keep-node', 'hook-queue.state.json');
  fs.rmSync(stateFile, { force: true });

  // The daemon answers, and refuses sess-stuck for now: the rest of sess-stuck waits,
  // and the replay goes on to sess-other and the new event.
  const busy = await stubDaemon(t, (body) => (body.identity.sessionId === 'sess-stuck' ? { status: 503, body: { error: 'busy' } } : ran('')));
  const first = await f.hook('lifecycle', busy.url, { hook_event_name: 'PostToolUse' });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(busy.posts.map(label), ['notification:sess-stuck', 'notification:sess-other', 'lifecycle:sess-aws1']);
  assert.deepEqual(f.queue().map((entry) => `${entry.event}:${entry.body.identity.sessionId}`), ['notification:sess-stuck', 'stop:sess-stuck']);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(stateFile, 'utf8')).stalled), ['sess-stuck']);

  // In the next replay sess-stuck goes last, behind an entry queued after it.
  await f.hook('notification', url, { session_id: 'sess-other', notification_type: 'idle_prompt' });
  const daemon = await stubDaemon(t, () => ran(''));
  const second = await f.hook('lifecycle', daemon.url, { hook_event_name: 'PostToolUse' });
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(daemon.posts.map(label),
    ['notification:sess-other', 'notification:sess-stuck', 'stop:sess-stuck', 'lifecycle:sess-aws1']);
  assert.deepEqual(f.queue(), []);
  assert.equal(fs.existsSync(stateFile), false);
});

test('a daemon that drops the connection stops the replay: the next entry would meet the same link', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, '{"n":1}\n');
  const url = await closedUrl();
  await f.hook('notification', url, { session_id: 'sess-stuck', notification_type: 'idle_prompt' });
  await f.hook('notification', url, { session_id: 'sess-other', notification_type: 'idle_prompt' });
  // A record past its hour orders nothing: were this one honoured, sess-stuck would
  // go last; ignored, it goes first.
  const stateFile = path.join(f.home, '.keep-node', 'hook-queue.state.json');
  const client = require('./hook-client.js');
  fs.writeFileSync(stateFile, JSON.stringify({ stalled: { 'sess-stuck': Date.now() - client.STALL_TTL_MS - 1000 } }));
  const daemon = await stubDaemon(t, (body) => (body.identity.sessionId === 'sess-stuck' ? 'reset' : ran('')));
  const result = await f.hook('lifecycle', daemon.url, { hook_event_name: 'PostToolUse' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(daemon.posts.map((post) => `${post.body.event}:${post.body.identity.sessionId}`),
    ['notification:sess-stuck', 'lifecycle:sess-aws1'], 'sess-other was not tried');
  assert.deepEqual(f.queue().map((entry) => entry.body.identity.sessionId), ['sess-stuck', 'sess-other']);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(Object.keys(state.stalled), ['sess-stuck'], 'the expired record overwritten');
  assert.ok(Date.now() - state.stalled['sess-stuck'] < 60_000);
});

test('a replay changes only its own sessions in the stall record, whatever another replay wrote meanwhile', async (t) => {
  const f = fixture(t);
  const client = require('./hook-client.js');
  const env = { HOME: f.home };
  for (const [i, session] of ['sess-stuck', 'sess-b'].entries()) {
    client.enqueue(env, { event: 'notification', body: { input: { session_id: session, cwd: '/x', notification_type: 'idle_prompt' },
      identity: { agent: 'claude', sessionId: session }, idempotencyKey: `k-${String(i).padStart(16, '0')}` } });
  }
  const stateFile = path.join(f.home, '.keep-node', 'hook-queue.state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ stalled: { 'sess-stuck': Date.now() } }));
  const daemon = await stubDaemon(t, (body) => {
    const session = body.identity.sessionId;
    if (session === 'sess-b') return { status: 503, body: { error: 'busy' } };
    if (session === 'sess-stuck') {
      // Another hook's replay, at the same moment, records sess-x as stalled.
      const current = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      fs.writeFileSync(stateFile, JSON.stringify({ stalled: { ...current.stalled, 'sess-x': Date.now() } }));
    }
    return ran('');
  });
  const result = await f.hook('lifecycle', daemon.url, { hook_event_name: 'PostToolUse' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(daemon.posts.map((post) => post.body.identity.sessionId), ['sess-b', 'sess-stuck', 'sess-aws1']);
  // sess-stuck drained and is gone; sess-b stalled here; sess-x is the other replay's.
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(stateFile, 'utf8')).stalled).sort(), ['sess-b', 'sess-x']);
});

test('every stalled session goes last, so two stuck sessions cannot starve a healthy one queued after them', async (t) => {
  const f = fixture(t);
  const client = require('./hook-client.js');
  const env = { HOME: f.home };
  for (const [i, session] of ['sess-a', 'sess-b', 'sess-healthy'].entries()) {
    client.enqueue(env, { event: 'notification', body: { input: { session_id: session, cwd: '/x', notification_type: 'idle_prompt' },
      identity: { agent: 'claude', sessionId: session }, idempotencyKey: `k-${String(i).padStart(16, '0')}` } });
  }
  const stateFile = path.join(f.home, '.keep-node', 'hook-queue.state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ stalled: { 'sess-a': Date.now() - 1000, 'sess-b': Date.now() - 2000 } }));
  // Both stuck sessions drop the connection, which stops a replay.
  const daemon = await stubDaemon(t, (body) => (['sess-a', 'sess-b'].includes(body.identity.sessionId) ? 'reset' : ran('')));
  const result = await f.hook('lifecycle', daemon.url, { hook_event_name: 'PostToolUse' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(daemon.posts.map((post) => `${post.body.event}:${post.body.identity.sessionId}`),
    ['notification:sess-healthy', 'notification:sess-a', 'lifecycle:sess-aws1'], 'the healthy one first, then the stalled in queue order');
  assert.deepEqual(f.queue().map((entry) => entry.body.identity.sessionId), ['sess-a', 'sess-b']);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(stateFile, 'utf8')).stalled).sort(), ['sess-a', 'sess-b']);
});

// A replay driven in-process: `answer(payload, url)` answers each post, and the
// queue is the fixture's.
function queued(client, env, session, extra = {}) {
  client.enqueue(env, { event: 'notification', body: { input: { session_id: session, cwd: '/x', notification_type: 'idle_prompt' },
    identity: { agent: 'claude', sessionId: session }, idempotencyKey: `k-${session.padEnd(16, '0')}`, ...extra } });
}
const replayWith = (client, env, answer) => {
  const posts = [];
  const request = async (url, pathname, options) => {
    if (options.method === 'GET') return { status: 404, data: '{"error":"not found"}' };
    posts.push(options.payload);
    return answer(options.payload);
  };
  const run = () => client.replayQueue({ env, where: { url: 'http://127.0.0.1:1' }, token: 't', deadline: Date.now() + 10_000, deps: { request } });
  return { posts, run };
};
const answered = { status: 200, data: JSON.stringify({ ok: true, status: 0, stdout: '', stderr: '' }) };

test('a queued entry the daemon refuses for good is dropped with a line in hook.log saying why', async (t) => {
  const f = fixture(t);
  const client = require('./hook-client.js');
  const env = { HOME: f.home };
  queued(client, env, 'sess-refused');
  queued(client, env, 'sess-ok');
  const r = replayWith(client, env, (payload) => (payload.identity.sessionId === 'sess-refused'
    ? { status: 400, data: JSON.stringify({ error: 'the session is not one this node runs', code: 'foreign-session' }) } : answered));
  assert.equal(await r.run(), 2);
  assert.deepEqual(f.queue(), []);
  const log = fs.readFileSync(client.logFile(env), 'utf8');
  assert.match(log, /dropped queued notification for session sess-refused \(seq 1\): the session is not one this node runs\n/);
  assert.doesNotMatch(log, /sess-ok/, 'a delivery is not logged');
});

test('a 409 storm past the resend limit leaves the entry queued, the cursor at the last needFrom, and the session stalled', async (t) => {
  const f = fixture(t);
  const client = require('./hook-client.js');
  const env = { HOME: f.home };
  fs.writeFileSync(f.transcript, 'x'.repeat(4000));
  const snapshot = client.snapshotOf(f.transcript);
  client.enqueue(env, { event: 'session-start', body: { input: { session_id: 'sess-aws1', hook_event_name: 'SessionStart' },
    identity: { agent: 'claude', sessionId: 'sess-aws1' }, idempotencyKey: 'k'.repeat(32), transcriptPath: f.transcript, transcript: snapshot } });
  // Another hook keeps moving the mirror: each post is told a different place.
  let at = 0;
  const r = replayWith(client, env, () => { at += 100; return { status: 409, data: JSON.stringify({ error: 'resend', needFrom: at }) }; });
  assert.equal(await r.run(), 0);
  assert.equal(r.posts.length, client.NEED_FROM_RETRIES + 1);
  assert.deepEqual(f.queue().map((entry) => entry.event), ['session-start'], 'still queued');
  assert.deepEqual(JSON.parse(fs.readFileSync(client.cursorFile(env, 'sess-aws1'), 'utf8')), { generation: snapshot.generation, sent: at });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(client.replayStateFile(env), 'utf8')).stalled), ['sess-aws1']);
  assert.equal(fs.existsSync(client.logFile(env)), false, 'nothing was dropped');

  // The next replay starts where the daemon last said, and delivers.
  const next = replayWith(client, env, () => answered);
  assert.equal(await next.run(), 1);
  assert.deepEqual(next.posts.map((post) => post.transcript.fromOffset), [at]);
  assert.deepEqual(f.queue(), []);

  // A chunk answered with 409s past the limit is the same: resent later, from there.
  fs.writeFileSync(f.transcript, 'y'.repeat(client.CHUNK_FIRST * 3));
  const d = driven(f, (payload) => ({ status: 409, data: JSON.stringify({ error: 'resend', needFrom: 10 }) }));
  const result = await d.run({ snapshot: client.snapshotOf(f.transcript), deadline: 10_000 });
  assert.deepEqual(result, { ok: false, retry: true, why: `the mirror moved ${client.NEED_FROM_RETRIES + 1} times during this post; will resend from 10` });
  assert.equal(JSON.parse(fs.readFileSync(client.cursorFile(env, 'sess-aws1'), 'utf8')).sent, 10);
});

test('one hook replays a session at a time: a second replay leaves that session to the first and still replays the others', async (t) => {
  const f = fixture(t);
  const client = require('./hook-client.js');
  const env = { HOME: f.home };
  queued(client, env, 'sess-a');
  queued(client, env, 'sess-b');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = replayWith(client, env, async (payload) => {
    if (payload.identity.sessionId === 'sess-a') await gate;
    return answered;
  });
  const running = first.run();
  // The first replay is inside sess-a's post, holding its lock.
  while (!first.posts.length) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fs.existsSync(client.replayLockFile(env, 'sess-a')), true);
  const second = replayWith(client, env, () => answered);
  assert.equal(await second.run(), 1);
  assert.deepEqual(second.posts.map((post) => post.identity.sessionId), ['sess-b'], 'sess-a left to the replay holding it');
  release();
  assert.equal(await running, 1);
  assert.deepEqual(first.posts.map((post) => post.identity.sessionId), ['sess-a'], 'sess-b was already delivered');
  assert.deepEqual(f.queue(), []);
  assert.equal(fs.existsSync(client.replayLockFile(env, 'sess-a')), false, 'released');
  assert.equal(fs.existsSync(client.replayLockFile(env, 'sess-b')), false, 'released');

  // Another live process's lock is honoured; a dead one's, or one past its bound, is taken over.
  const lock = (session, value) => {
    fs.mkdirSync(path.dirname(client.replayLockFile(env, session)), { recursive: true });
    fs.writeFileSync(client.replayLockFile(env, session), JSON.stringify(value));
  };
  queued(client, env, 'sess-live');
  queued(client, env, 'sess-dead');
  queued(client, env, 'sess-old');
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => dead.once('exit', resolve));
  lock('sess-live', { pid: process.ppid, at: Date.now() });
  lock('sess-dead', { pid: dead.pid, at: Date.now() });
  lock('sess-old', { pid: process.ppid, at: Date.now() - client.REPLAY_LOCK_STALE_MS - 1000 });
  const third = replayWith(client, env, () => answered);
  assert.equal(await third.run(), 2);
  assert.deepEqual(third.posts.map((post) => post.identity.sessionId), ['sess-dead', 'sess-old']);
  assert.deepEqual(f.queue().map((entry) => entry.body.identity.sessionId), ['sess-live']);
  assert.equal(fs.existsSync(client.replayLockFile(env, 'sess-live')), true, 'not this replay\'s to remove');
});

// ---------- pre-bash ----------

const CONTEXT = { status: 200, body: { steps: ['terraform apply'], repairSession: false } };

test('a pre-bash asks for the context, posts the command with this node\'s repository facts and no transcript, and prints the daemon\'s decision', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, '{"n":1}\n');
  const refusal = 'keep guard: `terraform apply` is step apply on ~/infra\n';
  const daemon = await stubDaemon(t, (body, n, url) => (url.startsWith('/api/hook/context') ? CONTEXT
    : { status: 200, body: { ok: false, status: /terraform/.test(body.input.tool_input.command) ? 2 : 0, stdout: '', stderr: /terraform/.test(body.input.tool_input.command) ? refusal : '', replayed: false } }));
  const bash = (command, extra = {}) => f.hook('pre-bash', daemon.url, { cwd: f.home, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command, description: 'x', timeout: 1000 } }, extra);
  const refused = await bash('cd ~ && terraform apply', { KEEP_STEP_OK: '0', KEEP_REPAIR: '1' });
  assert.deepEqual(refused, { status: 2, stdout: '', stderr: refusal });
  assert.deepEqual(daemon.posts.map((post) => post.url), ['/api/hook/context?session=sess-aws1&agent=claude', '/api/hook'], 'no KEEP_PANE here: the ask names no pane');
  const post = daemon.posts[1].body;
  assert.equal(post.event, 'pre-bash');
  assert.equal(post.transcript, null, 'no transcript bytes');
  assert.deepEqual(post.input, { session_id: 'sess-aws1', cwd: f.home, tool_name: 'Bash', tool_input: { command: 'cd ~ && terraform apply' },
    repo_facts: { paths: { [f.home]: { top: null, main: null } }, deploy: null, head: {} }, transcript_path: f.transcript, hook_event_name: 'PreToolUse' });
  assert.deepEqual(post.identity.env, { KEEP_STEP_OK: '0' }, 'the session\'s bypass, never KEEP_REPAIR');
  const plain = await bash('ls');
  assert.deepEqual(plain, { status: 0, stdout: '', stderr: '' });
  assert.equal(daemon.posts.filter((entry) => entry.url.startsWith('/api/hook/context')).length, 1, 'the context from the cache');
  // The raw-resume guard answers here, before anything is asked.
  const before = daemon.posts.length;
  const resumed = await bash('claude --resume abc');
  assert.equal(resumed.status, 2);
  assert.match(resumed.stderr, /raw claude --resume bypasses Keep's launcher/);
  assert.equal(daemon.posts.length, before);
  assert.deepEqual(f.queue(), [], 'a pre-bash is never queued');
});

test('a daemon that does not answer a pre-bash refuses what it could have refused and lets the rest through', async (t) => {
  const f = fixture(t);
  const cache = path.join(f.home, '.keep-node', 'hook-context.json');
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify({ at: 1, steps: ['terraform apply'], sessions: { 'sess-aws1': { repairSession: true, at: 1 } } }));
  const url = await closedUrl();
  const bash = (target, command, extra) => f.hook('pre-bash', target, { cwd: f.home, tool_name: 'Bash', tool_input: { command } }, extra);
  const step = await bash(url, 'terraform apply');
  assert.equal(step.status, 2);
  assert.match(step.stderr, /^keep: the daemon on main did not answer this command's guard \(.*\), so `terraform apply`, a gated step's command, is refused here; run it again once the daemon answers\. KEEP_STEP_OK=1 bypasses the guard\.\n$/);
  const deploy = await bash(url, 'git push heroku main');
  assert.equal(deploy.status, 2);
  assert.match(deploy.stderr, /did not answer this command's guard .*, so a deploy to heroku \(remote heroku\) is refused here/);
  // The last word on this session was that it is a repair session.
  const restart = await bash(url, 'keep restart-daemon');
  assert.equal(restart.status, 2);
  assert.match(restart.stderr, /and this is a self-repair session; keep guard: `keep restart-daemon` restarts the daemon/);
  assert.equal((await bash(url, 'terraform apply', { KEEP_STEP_OK: '1' })).status, 0, 'the bypass holds as it does locally');
  const plain = await bash(url, 'ls -la');
  assert.deepEqual(plain, { status: 0, stdout: '', stderr: '' });
  assert.deepEqual(f.queue(), []);

  // A daemon that hangs: refused inside the budget.
  const slow = await stubDaemon(t, () => 'hang');
  const began = Date.now();
  const late = await bash(slow.url, 'terraform apply');
  assert.equal(late.status, 2, late.stderr);
  assert.ok(Date.now() - began < 8000, 'bounded');
  const allowed = await bash(slow.url, 'ls');
  assert.equal(allowed.status, 0);
  // A refusal of the post (here: the daemon has no such route yet) reads the same as no answer.
  const old = await stubDaemon(t, (body, n, target) => (target.startsWith('/api/hook/context') ? { status: 404, body: { error: 'not found' } } : { status: 400, body: { error: '"pre-bash" is not a hook event' } }));
  const refusedOld = await bash(old.url, 'terraform apply');
  assert.equal(refusedOld.status, 2);
  assert.match(refusedOld.stderr, /is not a hook event/);
  assert.equal((await bash(old.url, 'ls')).status, 0);
});

// ---------- post-bash ----------

test('a post-bash posts the command, its response cut to fit and this node\'s repo facts, and queues when the daemon is not there', async (t) => {
  const f = fixture(t);
  const git = (cwd, ...args) => require('node:child_process').execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const repo = path.join(f.home, 'app');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '--initial-branch=main');
  git(repo, 'config', 'user.email', 'keep@example.test');
  git(repo, 'config', 'user.name', 'Keep Test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'a');
  const head = git(repo, 'rev-parse', 'HEAD');
  const daemon = await stubDaemon(t, (body, n, url) => (url.startsWith('/api/hook/context') ? CONTEXT
    : { status: 200, body: { ok: true, status: 0, stdout: '', stderr: 'keep: recorded\n', replayed: false } }));
  const result = await f.hook('post-bash', daemon.url, { cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: 'git push heroku main' }, tool_response: { stdout: 'pushed', stderr: '', interrupted: false, isImage: false } });
  assert.deepEqual(result, { status: 0, stdout: '', stderr: 'keep: recorded\n' });
  const post = daemon.posts.find((entry) => entry.url === '/api/hook').body;
  assert.equal(post.event, 'post-bash');
  assert.equal(post.transcript, null);
  assert.deepEqual(post.input.tool_response, { stdout: 'pushed', stderr: '', interrupted: false });
  assert.deepEqual(post.input.repo_facts, {
    paths: { [repo]: { top: repo, main: repo } },
    deploy: { dir: repo, repo, sha: head, dirty: [], branch: null, onOrigin: null },
    head: { [repo]: head },
  });

  // No daemon: nothing said, and the record waits in the queue with its facts.
  const url = await closedUrl();
  const queued = await f.hook('post-bash', url, { cwd: repo, tool_name: 'Bash', tool_input: { command: 'terraform apply' }, tool_response: { stdout: 'ok' } });
  assert.deepEqual(queued, { status: 0, stdout: '', stderr: '' });
  const [entry] = f.queue();
  assert.equal(entry.event, 'post-bash');
  assert.deepEqual(entry.body.input.repo_facts.head, { [repo]: head });
  assert.equal(entry.body.transcript, null);
  // Replayed before the next event, once.
  await f.hook('notification', daemon.url);
  const replayed = daemon.posts.filter((item) => item.url === '/api/hook').map((item) => item.body.event);
  assert.deepEqual(replayed, ['post-bash', 'post-bash', 'notification']);
  assert.deepEqual(f.queue(), []);
});

test('a post-bash response is cut to 64 KiB a field, its end kept, and further when the whole would not fit', async (t) => {
  const client = require('./hook-client.js');
  const where = { url: 'http://127.0.0.1:1', local: 'aws1', daemon: 'main' };
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-hook-client-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sent = [];
  const deps = { env: { HOME: home }, token: 't', request: async (url, pathname, { payload }) => {
    if (pathname.startsWith('/api/hook/context')) return { status: 200, data: JSON.stringify({ steps: [], repairSession: false }) };
    sent.push(payload);
    return { status: 200, data: JSON.stringify({ ok: true, status: 0, stdout: '', stderr: '' }) };
  } };
  const long = `${'x'.repeat(100 * 1024)}THE END`;
  const post = (response, command = 'ls') => client.runBashHook('post-bash', { session_id: 'sess-aws1', cwd: home, tool_name: 'Bash',
    tool_input: { command }, tool_response: response }, where, deps).then(() => sent.at(-1).input);
  const one = await post({ stdout: long, stderr: 'short', exit_code: 1, interrupted: false, isImage: false });
  assert.equal(Buffer.byteLength(one.tool_response.stdout), 64 * 1024);
  assert.ok(one.tool_response.stdout.endsWith('THE END'), 'the end kept');
  assert.deepEqual({ ...one.tool_response, stdout: '' }, { stdout: '', stderr: 'short', exit_code: 1, interrupted: false });
  // Three long fields and a long command: cut until the whole fits what the daemon takes.
  const all = await post({ stdout: long, stderr: long, output: long }, `echo ${'y'.repeat(60 * 1024)}`);
  assert.ok(Buffer.byteLength(JSON.stringify(all)) <= client.INPUT_MAX_BYTES);
  assert.ok(all.tool_response.stdout.endsWith('THE END'));
  assert.equal(all.tool_input.command.length, 5 + 60 * 1024, 'the command is never cut');
  assert.equal(typeof (await post('plain output')).tool_response, 'string');
});

// ---------- Codex ----------

// `keep hook codex <action>` on the node, as Codex runs it.
function codexRun(f, action, url, input, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'hook', 'codex', action], {
      env: f.env(url, { KEEP_AGENT_ACCOUNT_ID: 'codex-node', ...extra }), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

function codexInput(f, extra = {}) {
  return { session_id: 'codex-aws1', transcript_path: f.transcript, cwd: f.home, ...extra };
}

// Exactly one JSON value on stdout, as Codex needs.
function onlyJson(result) {
  const text = result.stdout.trim();
  assert.doesNotThrow(() => JSON.parse(text), `stdout is JSON: ${JSON.stringify(result.stdout)}`);
  assert.equal(result.stdout.split('\n').filter(Boolean).length, 1, 'one line');
  return JSON.parse(text);
}

test('each Codex action is posted as codex-<action> for the Codex session, and the node prints the daemon\'s JSON', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, `${JSON.stringify({ type: 'session_meta', payload: { id: 'codex-aws1' } })}\n`);
  const context = '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"from the daemon"}}\n';
  const daemon = await stubDaemon(t, (body) => (body.event === 'codex-start' ? ran(context) : ran('{}\n')));
  const actions = { start: { hook_event_name: 'SessionStart', source: 'startup' }, stop: { hook_event_name: 'Stop', stop_hook_active: false },
    approval: { hook_event_name: 'PermissionRequest', tool_name: 'shell' }, complete: {}, lifecycle: { hook_event_name: 'UserPromptSubmit', turn_id: 't1' },
    question: { hook_event_name: 'PreToolUse', tool_name: 'request_user_input' }, end: { hook_event_name: 'SessionEnd' } };
  for (const [action, input] of Object.entries(actions)) {
    const result = await codexRun(f, action, daemon.url, codexInput(f, input), { KEEP_CODEX_CLIENT_TOKEN: 'launch-tok', CLAUDE_CODE_SESSION_ID: 'claude-parent' });
    assert.equal(result.status, 0, `${action}: ${result.stderr}`);
    assert.deepEqual(onlyJson(result), JSON.parse(action === 'start' ? context : '{}'), action);
    const post = daemon.posts.at(-1).body;
    assert.equal(post.event, `codex-${action}`);
    assert.deepEqual(post.identity, { agent: 'codex', sessionId: 'codex-aws1', accountId: 'codex-node',
      env: { KEEP_CODEX_CLIENT_TOKEN: 'launch-tok', KEEP_CODEX_PARENT_SESSION: 'claude-parent' } }, action);
    assert.deepEqual(post.input, codexInput(f, input), action);
  }
  // The first post carried the rollout, and the rest had nothing new to send.
  assert.equal(Buffer.from(daemon.posts[0].body.transcript.bytes, 'base64').toString(), fs.readFileSync(f.transcript, 'utf8'));
  assert.equal(daemon.posts[0].body.transcript.path, f.transcript);
  // A Claude event never forwards the Codex-only variables.
  await f.hook('notification', daemon.url, { notification_type: 'idle_prompt' }, { KEEP_CODEX_CLIENT_TOKEN: 'launch-tok' });
  assert.equal(daemon.posts.at(-1).body.identity.env, undefined);
});

test('a Codex child agent\'s rollout goes up as its own mirror, named, and leaves the parent\'s cursor alone', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, `${JSON.stringify({ type: 'session_meta', payload: { id: 'codex-aws1' } })}\n`);
  const child = path.join(f.base, 'rollout-child.jsonl');
  fs.writeFileSync(child, `${JSON.stringify({ type: 'session_meta', payload: { id: 'codex-child', parent_thread_id: 'codex-aws1' } })}\n{"n":2}\n`);
  const daemon = await stubDaemon(t, () => ran('{}\n'));
  await codexRun(f, 'lifecycle', daemon.url, codexInput(f, { hook_event_name: 'UserPromptSubmit', turn_id: 't1' }));
  assert.equal(daemon.posts[0].body.transcript.path, f.transcript);
  assert.equal(daemon.posts[0].body.child, undefined, 'the parent\'s own event names no child');
  const cursorFile = path.join(f.home, '.keep-node', 'mirror', 'codex-aws1.json');
  const cursor = fs.readFileSync(cursorFile, 'utf8');
  const result = await codexRun(f, 'lifecycle', daemon.url, codexInput(f, { transcript_path: child, hook_event_name: 'PostToolUse', turn_id: 't2' }));
  assert.equal(result.status, 0, result.stderr);
  const post = daemon.posts.at(-1).body;
  assert.equal(post.event, 'codex-lifecycle');
  assert.equal(post.identity.sessionId, 'codex-aws1');
  assert.equal(post.child, 'codex-child', 'the child\'s bytes are named as the child\'s, never the parent\'s');
  assert.equal(post.input.agent_id, 'codex-child', 'and so is the event');
  assert.equal(post.transcript.path, child);
  assert.equal(Buffer.from(post.transcript.bytes, 'base64').toString(), fs.readFileSync(child, 'utf8'));
  assert.equal(fs.readFileSync(cursorFile, 'utf8'), cursor);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, '.keep-node', 'mirror', 'codex-child.json'), 'utf8')).sent, fs.statSync(child).size);
  // The parent's next event has nothing new to send, rather than its whole rollout again.
  await codexRun(f, 'lifecycle', daemon.url, codexInput(f, { hook_event_name: 'Stop', turn_id: 't1' }));
  const next = daemon.posts.at(-1).body.transcript;
  assert.equal(next.path, f.transcript);
  assert.equal(next.fromOffset, fs.statSync(f.transcript).size);
  assert.equal(next.bytes, '');
  // A hook that already names another agent is not the child's rollout's: no bytes, no child.
  await codexRun(f, 'lifecycle', daemon.url, codexInput(f, { transcript_path: child, hook_event_name: 'PostToolUse', agent_id: 'someone-else', turn_id: 't3' }));
  assert.equal(daemon.posts.at(-1).body.child, undefined);
  assert.equal(daemon.posts.at(-1).body.transcript ?? null, null);
});

test('a Codex answer on the node is always JSON: {} for anything else and when the daemon is not there', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, '{"n":1}\n');
  const weird = await stubDaemon(t, () => ran('not json\n', 1));
  for (const action of ['stop', 'approval', 'lifecycle', 'end', 'question']) {
    const result = await codexRun(f, action, weird.url, codexInput(f, action === 'lifecycle' ? { hook_event_name: 'Stop' } : {}));
    assert.equal(result.status, 0, action);
    assert.deepEqual(onlyJson(result), {}, action);
  }
  const url = await closedUrl();
  for (const action of ['stop', 'approval', 'complete', 'lifecycle', 'end', 'question', 'client-end']) {
    const result = await codexRun(f, action, url, action === 'client-end' ? { client_token: 'launch-tok' } : codexInput(f, action === 'lifecycle' ? { hook_event_name: 'Stop' } : {}));
    assert.equal(result.status, 0, action);
    assert.deepEqual(onlyJson(result), {}, action);
  }
  const start = await codexRun(f, 'start', url, codexInput(f));
  assert.equal(start.status, 0);
  assert.match(onlyJson(start).hookSpecificOutput.additionalContext, new RegExp('^Keep: this session is unmanaged on node aws1; the daemon is on main\\. '
    + 'Its hooks, the command guards and the deploy and step records among them, and its registry commands reach the daemon at '
    + `${url.replace(/[.]/g, '\\.')}; the daemon did not answer this start, so it is queued and resent with the next hook\\. Not available on this node: keep tell`));
  // Malformed stdin: still JSON, nothing posted.
  const garbage = await codexRun(f, 'stop', weird.url, 'not json');
  assert.deepEqual(onlyJson(garbage), {});
  // The stop, approval, complete and lifecycle queued, and the end dropped them with
  // the rest of its session's queue; the start after it waits. Never an end, a
  // question or a client-end.
  assert.deepEqual(f.queue().map((entry) => entry.event), ['codex-start']);
});

test('a Codex question the daemon refuses is the deny JSON and exit 2; a stop block is printed as the daemon wrote it', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, '{"n":1}\n');
  const deny = '{"decision":"block","reason":"nobody reads this"}\n';
  const block = '{"decision":"block","reason":"[keep] check in"}\n';
  const daemon = await stubDaemon(t, (body) => (body.event === 'codex-question' ? { status: 200, body: { ok: false, status: 2, stdout: deny, stderr: 'nobody reads this\n', replayed: false } } : ran(block)));
  const question = await codexRun(f, 'question', daemon.url, codexInput(f, { tool_name: 'request_user_input' }));
  assert.equal(question.status, 2);
  assert.deepEqual(onlyJson(question), JSON.parse(deny));
  const stop = await codexRun(f, 'stop', daemon.url, codexInput(f));
  assert.equal(stop.status, 0);
  assert.deepEqual(onlyJson(stop), JSON.parse(block));
});

test('a Codex client-end posts its launch token with no session', async (t) => {
  const f = fixture(t);
  const daemon = await stubDaemon(t, () => ran('{}\n'));
  const result = await codexRun(f, 'client-end', daemon.url, { client_token: 'launch-tok' }, { KEEP_CODEX_CLIENT_TOKEN: 'launch-tok', KEEP_PANE: 'p2' });
  assert.deepEqual(onlyJson(result), {});
  const [post] = daemon.posts;
  assert.equal(post.body.event, 'codex-client-end');
  assert.deepEqual(post.body.identity, { agent: 'codex', pane: 'p2@aws1', accountId: 'codex-node', env: { KEEP_CODEX_CLIENT_TOKEN: 'launch-tok' } });
  assert.deepEqual(post.body.input, { client_token: 'launch-tok' });
  assert.equal(post.body.transcript, null);
});

test('a Codex pre-tool posts the shell command with this node\'s repository facts, and fails closed as a Claude pre-bash does', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, '{"n":1}\n');
  const block = (reason) => JSON.stringify({ decision: 'block', reason, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  const daemon = await stubDaemon(t, (body, n, url) => {
    if (url.startsWith('/api/hook/context')) return CONTEXT;
    const refused = /terraform/.test(body.input.tool_input.command);
    return { status: 200, body: { ok: !refused, status: refused ? 2 : 0, stdout: refused ? `${block('step apply')}\n` : '{}\n', stderr: refused ? 'step apply\n' : '', replayed: false } };
  });
  const shell = (url, command, extra = {}, tool = 'shell') => codexRun(f, 'pre-tool', url, codexInput(f, { hook_event_name: 'PreToolUse', tool_name: tool,
    call_id: 'call-1', tool_input: { command: ['bash', '-lc', command], workdir: f.home, timeout_ms: 1000 } }), extra);
  const refused = await shell(daemon.url, 'terraform apply', { KEEP_PANE: 'p2' });
  assert.equal(refused.status, 2);
  assert.deepEqual(onlyJson(refused), JSON.parse(block('step apply')));
  // The context is asked as the session and pane its posts name, so the daemon can adopt it first.
  assert.equal(daemon.posts[0].url, '/api/hook/context?session=codex-aws1&agent=codex&pane=p2%40aws1');
  const post = daemon.posts.find((entry) => entry.url === '/api/hook').body;
  assert.equal(post.event, 'codex-pre-tool');
  assert.equal(post.transcript, null, 'no rollout bytes in front of a command');
  assert.deepEqual(post.input, { session_id: 'codex-aws1', cwd: f.home, tool_name: 'shell', tool_input: { command: 'terraform apply', workdir: f.home },
    repo_facts: { paths: { [f.home]: { top: null, main: null } }, deploy: null, head: {} }, transcript_path: f.transcript, hook_event_name: 'PreToolUse', tool_use_id: 'call-1' });
  assert.deepEqual(onlyJson(await shell(daemon.url, 'ls')), {});
  // Not a shell call: nothing asked, nothing refused.
  const before = daemon.posts.length;
  assert.deepEqual(onlyJson(await shell(daemon.url, 'terraform apply', {}, 'apply_patch')), {});
  assert.equal(daemon.posts.length, before);

  // The daemon not there: a step fingerprint (from the cached context) and a deploy are refused, the rest allowed.
  const url = await closedUrl();
  const step = await shell(url, 'terraform apply');
  assert.equal(step.status, 2);
  assert.match(onlyJson(step).reason, /did not answer this command's guard .*`terraform apply`, a gated step's command, is refused here/);
  const deploy = await shell(url, 'git push heroku main');
  assert.equal(deploy.status, 2);
  assert.match(onlyJson(deploy).reason, /a deploy to heroku \(remote heroku\) is refused here/);
  assert.deepEqual(onlyJson(await shell(url, 'ls')), {});
  // A daemon whose hook failed without a decision is no answer either.
  const broken = await stubDaemon(t, (body, n, target) => (target.startsWith('/api/hook/context') ? CONTEXT : ran('Error: boom\n', 1)));
  const failed = await shell(broken.url, 'terraform apply');
  assert.equal(failed.status, 2);
  assert.match(onlyJson(failed).reason, /status 1 without a decision/);
  assert.deepEqual(onlyJson(await shell(broken.url, 'ls')), {});
  assert.deepEqual(f.queue(), [], 'a pre-tool is never queued');
});

test('a Codex post-tool posts the command and its response with the rollout in front of it, and queues when the daemon is not there', async (t) => {
  const f = fixture(t);
  const item = { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'call-9', command: ['bash', '-lc', 'make'], exit_code: 3 } } };
  fs.writeFileSync(f.transcript, `${JSON.stringify(item)}\n`);
  const daemon = await stubDaemon(t, (body, n, url) => (url.startsWith('/api/hook/context') ? CONTEXT : ran('{}\n')));
  const input = codexInput(f, { hook_event_name: 'PostToolUse', tool_name: 'exec_command', tool_use_id: 'call-9',
    tool_input: { cmd: 'make' }, tool_response: 'made\n' });
  assert.deepEqual(onlyJson(await codexRun(f, 'post-tool', daemon.url, input)), {});
  const post = daemon.posts.find((entry) => entry.url === '/api/hook').body;
  assert.equal(post.event, 'codex-post-tool');
  assert.equal(Buffer.from(post.transcript.bytes, 'base64').toString(), fs.readFileSync(f.transcript, 'utf8'), 'the rollout, for the exit code');
  assert.equal(post.input.tool_response.exit_code, 3, 'read from this node\'s rollout');
  assert.equal(post.input.tool_response.stdout, 'made\n');
  assert.deepEqual(post.input.tool_input, { command: 'make', workdir: f.home });
  const url = await closedUrl();
  assert.deepEqual(onlyJson(await codexRun(f, 'post-tool', url, input)), {});
  assert.deepEqual(f.queue().map((entry) => entry.event), ['codex-post-tool']);
});

test('a Codex start on a node answers inside its 3 s timeout however slow the daemon and the host are', async (t) => {
  const hook = require('./commands/hook.js');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-start-deadline-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, KEEP_PANE: 'p2', KEEP_NODE_NAME: 'aws1', KEEP_DAEMON_NODE: 'main', KEEP_DAEMON_URL: 'http://127.0.0.1:1' };
  const where = { url: env.KEEP_DAEMON_URL, local: 'aws1', daemon: 'main' };
  const input = { session_id: 'codex-aws1', cwd: home, transcript_path: path.join(home, 'r.jsonl') };
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A daemon that takes the whole post budget and answers nothing.
  const slowDaemon = (ms) => ({ runHook: async () => { await delay(ms); return { delivered: false, why: 'timed out' }; } });
  const host = (answerMs, calls) => async () => ({
    request: async (type) => {
      calls.push(type);
      if (answerMs === Infinity) return new Promise(() => {});
      await delay(answerMs);
      return type === 'get' ? { pane: { alive: true, pid: 1, meta: {} } } : {};
    },
    close() {},
  });
  const run = async (deps) => {
    const written = [];
    const write = process.stdout.write;
    let exited = null;
    // The hook writes strings; the test runner's own reports (buffers) pass through.
    process.stdout.write = (chunk, ...rest) => {
      if (typeof chunk !== 'string') return write.call(process.stdout, chunk, ...rest);
      written.push(chunk);
      const callback = rest.find((arg) => typeof arg === 'function');
      if (callback) callback();
      return true;
    };
    const began = Date.now();
    try {
      await hook.carriedCodexHook('start', input, where, { env, hookStartedAt: began, exit: (code) => { exited = code; }, ...deps });
    } finally { process.stdout.write = write; }
    return { written: written.join(''), exited, elapsed: Date.now() - began };
  };

  // A stalled host: the bind is cut at the deadline, the answer it had (here the
  // notice for a daemon that did not answer) is printed, and the hook exits.
  const stalled = [];
  const cut = await run({ hookClient: slowDaemon(2000), connectHost: host(Infinity, stalled) });
  assert.match(JSON.parse(cut.written).hookSpecificOutput.additionalContext, /the daemon did not answer this start/);
  assert.equal(cut.written.split('\n').filter(Boolean).length, 1, 'one JSON value');
  assert.equal(cut.exited, 0);
  assert.ok(cut.elapsed >= 2500 && cut.elapsed < 2900, `answered at the deadline (${cut.elapsed} ms)`);
  assert.match(fs.readFileSync(path.join(home, '.keep-node', 'hook.log'), 'utf8'), /codex start for session codex-aws1: the pane bind was still running at the 2600 ms deadline; answered without it/);

  // The daemon delivered its SessionStart context, then the bind stalled: that context
  // is what Codex hears, not `{}`.
  const context = '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[keep] You are session #7."}}';
  const delivered = { runHook: async () => { await delay(200); return { delivered: true, value: { status: 0, stdout: `${context}\n`, stderr: '' } }; } };
  const kept = await run({ hookClient: delivered, connectHost: host(Infinity, []) });
  assert.equal(kept.written, `${context}\n`);
  assert.equal(kept.exited, 0);
  assert.ok(kept.elapsed >= 2500 && kept.elapsed < 2900, `answered at the deadline (${kept.elapsed} ms)`);

  // A daemon that used more than its share: the bind still gets 600 ms, one attempt, and binds.
  const late = [];
  const bound = await run({ hookClient: slowDaemon(2400), connectHost: host(100, late) });
  assert.equal(bound.exited, null, 'no forced exit');
  assert.deepEqual(late, ['get', 'meta'], 'one attempt, bound');
  assert.match(JSON.parse(bound.written).hookSpecificOutput.additionalContext, /the daemon is on main/);
  assert.ok(bound.elapsed < 3000, `inside Codex's timeout (${bound.elapsed} ms)`);
});

test('a Codex start the daemon refused before its pane was bound is posted once more after the bind, under the same key', async (t) => {
  const hook = require('./commands/hook.js');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-start-repost-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, KEEP_PANE: 'p2', KEEP_NODE_NAME: 'aws1', KEEP_DAEMON_NODE: 'main', KEEP_DAEMON_URL: 'http://127.0.0.1:1' };
  const where = { url: env.KEEP_DAEMON_URL, local: 'aws1', daemon: 'main' };
  const input = { session_id: 'codex-aws1', cwd: home, transcript_path: path.join(home, 'r.jsonl') };
  const context = '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[keep] You are session #9."}}';
  const run = async (answers, hostCalls) => {
    const posts = [];
    const hookClient = { BUDGET_MS: require('./hook-client.js').BUDGET_MS, runHook: async (event, given, at, deps) => {
      posts.push({ event, key: deps.idempotencyKey, budget: deps.budgets && deps.budgets[event] });
      return answers[posts.length - 1];
    } };
    const connectHost = async () => ({
      request: async (type) => { hostCalls.push(type); return type === 'get' ? { pane: { alive: true, pid: 1, meta: {} } } : {}; },
      close() {},
    });
    const written = [];
    const write = process.stdout.write;
    process.stdout.write = (chunk, ...rest) => {
      if (typeof chunk !== 'string') return write.call(process.stdout, chunk, ...rest);
      written.push(chunk);
      return true;
    };
    try {
      await hook.carriedCodexHook('start', input, where, { env, hookStartedAt: Date.now(), hookClient, connectHost, exit: () => {} });
    } finally { process.stdout.write = write; }
    return { posts, written: written.join('') };
  };
  const refusedFirst = [{ delivered: false, why: 'session codex-aws1 is not on node aws1', code: 'SESSION_NOT_ON_NODE', queued: false },
    { delivered: true, value: { status: 0, stdout: `${context}\n`, stderr: '' } }];
  const hostCalls = [];
  const reposted = await run(refusedFirst, hostCalls);
  assert.deepEqual(hostCalls, ['get', 'meta'], 'bound first');
  assert.equal(reposted.posts.length, 2);
  assert.match(reposted.posts[0].key, /^[0-9a-f]{32}$/);
  assert.equal(reposted.posts[1].key, reposted.posts[0].key, 'the same idempotency key');
  assert.ok(reposted.posts[1].budget > 0 && reposted.posts[1].budget <= 2600, `inside the start's deadline (${reposted.posts[1].budget} ms)`);
  assert.equal(reposted.written, `${context}\n`, 'the daemon\'s answer to the second post');
  // A daemon that answers no code is read by the refusal's exact text.
  const legacy = await run([{ delivered: false, why: 'session codex-aws1 is not on node aws1', queued: false }, refusedFirst[1]], []);
  assert.equal(legacy.posts.length, 2);
  // Any other failure is not posted again: a refusal of the pane rather than the
  // session, of another session, one with another code, no refusal at all, or a first
  // post that 5xx-queued (its replay delivers it), whatever it says.
  for (const first of [
    { delivered: false, why: 'timed out', queued: true },
    { delivered: false, why: 'HTTP 503', queued: true },
    { delivered: false, why: 'session codex-aws1 is not on node aws1', code: 'SESSION_NOT_ON_NODE', queued: true },
    { delivered: false, why: 'pane p2@main is not on node aws1', queued: false },
    { delivered: false, why: 'pane p2@main is not on node aws1', code: 'SOMETHING_ELSE', queued: false },
    { delivered: false, why: 'session codex-other is not on node aws1', queued: false },
    { delivered: false, why: 'session codex-aws1 is not on node aws1 (and more)', queued: false },
    { delivered: false, why: 'session codex-aws1 is not on node aws1', code: 'SOMETHING_ELSE', queued: false },
  ]) {
    const other = await run([first, refusedFirst[1]], []);
    assert.equal(other.posts.length, 1, JSON.stringify(first));
  }
  // Nor is a refusal when the bind did not happen.
  const unbound = [];
  const noBind = await (async () => {
    const posts = [];
    const hookClient = { BUDGET_MS: {}, runHook: async (event, given, at, deps) => { posts.push(deps.idempotencyKey); return refusedFirst[0]; } };
    const connectHost = async () => ({ request: async (type) => { unbound.push(type); return type === 'get' ? { pane: { alive: true, pid: 1, meta: { sessionId: 'someone-else' } } } : {}; }, close() {} });
    const write = process.stdout.write;
    process.stdout.write = (chunk, ...rest) => (typeof chunk !== 'string' ? write.call(process.stdout, chunk, ...rest) : true);
    try { await hook.carriedCodexHook('start', input, where, { env, hookStartedAt: Date.now(), hookClient, connectHost, exit: () => {} }); }
    finally { process.stdout.write = write; }
    return posts;
  })();
  assert.deepEqual(unbound, ['get']);
  assert.equal(noBind.length, 1);
});

// ---------- Pi hooks ----------

const PI_INSTANCE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('the Pi events: their budgets fit the extension\'s 5 s, none carries a transcript, and only start and end are queued', () => {
  const client = require('./hook-client.js');
  assert.deepEqual(client.PI_EVENTS, ['pi-start', 'pi-end', 'pi-pre-tool']);
  for (const event of client.PI_EVENTS) {
    assert.ok(client.EVENTS.includes(event), event);
    assert.ok(client.BUDGET_MS[event] < 5000, `${event} ends inside the extension's timeout`);
    assert.ok(client.TRANSCRIPTLESS.has(event), `${event} carries no transcript`);
  }
  assert.deepEqual([client.BUDGET_MS['pi-start'], client.BUDGET_MS['pi-pre-tool'], client.BUDGET_MS['pi-end']], [3000, 3000, 2000]);
  assert.equal(client.QUEUED.has('pi-start'), true);
  assert.equal(client.QUEUED.has('pi-end'), true);
  assert.equal(client.QUEUED.has('pi-pre-tool'), false, 'a guard delivered late guards nothing');
  assert.equal(client.ENDS.has('pi-end'), true);
});

test('a Pi hook posts as the Pi session, with only what the daemon\'s keep hook pi reads', async (t) => {
  const client = require('./hook-client.js');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-pi-client-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const posts = [];
  const request = async (url, pathname, { payload }) => {
    posts.push({ pathname, payload });
    if (pathname.startsWith('/api/hook/context')) return { status: 200, data: JSON.stringify({ steps: [], repairSession: false }) };
    return { status: 200, data: JSON.stringify({ ok: true, status: 0, stdout: '', stderr: '', replayed: false }) };
  };
  const env = { HOME: home, KEEP_PANE: 'p3', KEEP_NODE_NAME: 'aws1', KEEP_DAEMON_NODE: 'main', KEEP_AGENT_ACCOUNT_ID: 'pi/default',
    KEEP_STEP_OK: '1', KEEP_REVIEWER: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', KEEP_CODEX_CLIENT_TOKEN: 'tok', KEEP_DELEGATION_ID: 'del-1' };
  const where = { url: 'http://127.0.0.1:1', local: 'aws1', daemon: 'main' };
  const input = { session_id: 'pi-aws1', cwd: home, instance: PI_INSTANCE, pid: 4242, job_id: 'job', worker_token: 'secret' };
  const deps = { env, token: 'aws1-secret', request };
  const started = await client.runPiHook('start', input, where, deps);
  assert.equal(started.delivered, true);
  const start = posts[0].payload;
  assert.equal(start.event, 'pi-start');
  assert.equal(start.transcript, null);
  assert.deepEqual(start.input, { session_id: 'pi-aws1', cwd: home, instance: PI_INSTANCE, pid: 4242 }, 'no worker job id or token');
  assert.deepEqual(start.identity, { agent: 'pi', sessionId: 'pi-aws1', pane: 'p3@aws1', accountId: 'pi/default',
    env: { KEEP_DELEGATION_ID: 'del-1', KEEP_STEP_OK: '1' } });
  await client.runPiHook('end', input, where, deps);
  assert.equal(posts[1].payload.event, 'pi-end');
  const pre = await client.runPiHook('pre-tool', { ...input, tool_name: 'Bash', tool_input: { command: 'ls' } }, where, deps);
  assert.equal(pre.delivered, true);
  assert.deepEqual(posts.slice(2).map((post) => post.pathname), ['/api/hook/context?session=pi-aws1&agent=pi&pane=p3%40aws1', '/api/hook']);
  const tool = posts[3].payload;
  assert.equal(tool.event, 'pi-pre-tool');
  assert.deepEqual(tool.input, { session_id: 'pi-aws1', cwd: home, tool_name: 'Bash', tool_input: { command: 'ls' },
    repo_facts: { paths: { [home]: { top: null, main: null } }, deploy: null, head: {} } });
  assert.equal(await client.runPiHook('post-tool', input, where, deps), null, 'not a carried Pi hook');
});

test('a node Pi start\'s post runs its budget from when the hook process started, not from the post', async (t) => {
  const client = require('./hook-client.js');
  const hook = require('./commands/hook.js');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-pi-start-budget-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, KEEP_PANE: 'p3', KEEP_NODE_NAME: 'aws1', KEEP_DAEMON_NODE: 'main', KEEP_DAEMON_URL: 'http://127.0.0.1:1' };
  const where = { url: env.KEEP_DAEMON_URL, local: 'aws1', daemon: 'main' };
  const input = { session_id: 'pi-aws1', cwd: home, instance: PI_INSTANCE, pid: 4242 };
  // The post itself: its request gets what is left of 3 s since the process started.
  const timeouts = [];
  const request = async (url, pathname, { timeoutMs }) => {
    timeouts.push(timeoutMs);
    return { status: 200, data: JSON.stringify({ ok: true, status: 0, stdout: '', stderr: '', replayed: false }) };
  };
  const began = Date.now() - 1800;
  await client.runPiHook('start', input, where, { env, token: 'aws1-secret', request, startedAt: began });
  assert.equal(timeouts.length, 1);
  assert.ok(timeouts[0] <= 1200 && timeouts[0] > 0, `the post has what is left (${timeouts[0]} ms)`);
  // carriedPiHook hands its process start to the start's post, and to nothing else.
  const seen = [];
  const hookClient = { logLine: () => {}, runPiHook: async (action, given, at, deps) => {
    seen.push([action, deps.startedAt]);
    return { delivered: true, value: { status: 0, stdout: '', stderr: '' } };
  } };
  const connectHost = async () => ({ request: async (type) => (type === 'get' ? { pane: { alive: true, pid: 1, meta: { sessionId: 'pi-aws1' } } } : {}), close() {} });
  const exitCode = process.exitCode;
  try {
    await hook.carriedPiHook('start', input, where, { env, hookStartedAt: began, hookClient, connectHost });
    await hook.carriedPiHook('end', input, where, { env, hookStartedAt: began, hookClient, connectHost });
  } finally { process.exitCode = exitCode; }
  assert.deepEqual(seen, [['start', began], ['end', undefined]]);
});

// `keep hook pi <action>` on aws1, as the Keep Pi extension runs it.
function piHook(f, action, url, input = {}, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'hook', 'pi', action], {
      env: f.env(url, { KEEP_PANE: 'p3', KEEP_AGENT_ACCOUNT_ID: 'pi/default', KEEP_PI_SESSION_ID: 'pi-aws1', ...extra }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify({ session_id: 'pi-aws1', cwd: f.home, instance: PI_INSTANCE, pid: 4242, ...input }));
  });
}

test('a Pi pre-tool on a node blocks on the daemon\'s deny, and fails closed for a deploy when the daemon does not answer', async (t) => {
  const f = fixture(t);
  const refusal = 'keep guard: `terraform apply` is step apply on ~/infra\n';
  const daemon = await stubDaemon(t, (body, n, url) => (url.startsWith('/api/hook/context') ? CONTEXT
    : { status: 200, body: { ok: false, status: /terraform/.test(body.input.tool_input.command) ? 2 : 0, stdout: '',
      stderr: /terraform/.test(body.input.tool_input.command) ? refusal : '', replayed: false } }));
  const bash = (url, command, extra) => piHook(f, 'pre-tool', url, { tool_name: 'Bash', tool_input: { command } }, extra);
  assert.deepEqual(await bash(daemon.url, 'terraform apply'), { status: 2, stdout: '', stderr: refusal });
  const post = daemon.posts.find((entry) => entry.url === '/api/hook').body;
  assert.equal(post.event, 'pi-pre-tool');
  assert.equal(post.identity.agent, 'pi');
  assert.deepEqual(await bash(daemon.url, 'ls'), { status: 0, stdout: '', stderr: '' });
  // The raw-resume guard answers here first, as for a Claude pre-bash.
  const before = daemon.posts.length;
  assert.equal((await bash(daemon.url, 'claude --resume abc')).status, 2);
  assert.equal(daemon.posts.length, before);

  const closed = await closedUrl();
  const deploy = await bash(closed, 'git push heroku main');
  assert.equal(deploy.status, 2);
  assert.match(deploy.stderr, /did not answer this command's guard .*, so a deploy to heroku \(remote heroku\) is refused here/);
  // The step fingerprints the daemon last published (cached from the context above).
  const step = await bash(closed, 'terraform apply');
  assert.equal(step.status, 2);
  assert.match(step.stderr, /`terraform apply`, a gated step's command, is refused here/);
  assert.deepEqual(await bash(closed, 'ls -la'), { status: 0, stdout: '', stderr: '' });
  // A pane-less Pi (a background worker) is not one a node runs.
  const worker = await bash(daemon.url, 'ls', { KEEP_PANE: '' });
  assert.equal(worker.status, 2);
  assert.match(worker.stderr, /unverified background worker/);
  assert.deepEqual(f.queue(), [], 'a pre-tool is never queued');
});

test('a Pi start and end on a node post to the daemon, and are queued, logged and answered when it does not answer', async (t) => {
  const f = fixture(t);
  const daemon = await stubDaemon(t, () => ({ status: 200, body: { ok: true, status: 0, stdout: '', stderr: '', replayed: false } }));
  // No host here (KEEP_HOST_SOCK points nowhere): the daemon's bind is what counts.
  const started = await piHook(f, 'start', daemon.url);
  assert.deepEqual(started, { status: 0, stdout: '', stderr: '' });
  assert.deepEqual(daemon.posts.map((post) => post.body.event), ['pi-start']);
  assert.deepEqual(daemon.posts[0].body.input, { session_id: 'pi-aws1', cwd: f.home, instance: PI_INSTANCE, pid: 4242 });
  const ended = await piHook(f, 'end', daemon.url);
  assert.deepEqual(ended, { status: 0, stdout: '', stderr: '' });
  assert.deepEqual(daemon.posts.map((post) => post.body.event), ['pi-start', 'pi-end']);

  // The daemon could not bind it and the node cannot either: the start fails, with the daemon's reason.
  const refusing = await stubDaemon(t, () => ({ status: 200, body: { ok: false, status: 2, stdout: '', stderr: 'keep hook pi start: could not bind the host pane\n', replayed: false } }));
  const unbound = await piHook(f, 'start', refusing.url);
  assert.equal(unbound.status, 2);
  assert.equal(unbound.stderr, 'keep hook pi start: could not bind the host pane\n');

  // Nobody answers: the start fails (no pane was bound anywhere) but is queued for the
  // daemon's record, and the end is queued after it; both are logged.
  const closed = await closedUrl();
  const lonely = await piHook(f, 'start', closed, { session_id: 'pi-later' }, { KEEP_PI_SESSION_ID: 'pi-later' });
  assert.equal(lonely.status, 2);
  assert.match(lonely.stderr, /could not bind the host pane/);
  assert.deepEqual(f.queue().map((entry) => entry.event), ['pi-start']);
  const gone = await piHook(f, 'end', closed, { session_id: 'pi-later' }, { KEEP_PI_SESSION_ID: 'pi-later' });
  assert.equal(gone.status, 0);
  assert.deepEqual(f.queue().map((entry) => entry.event), ['pi-end'], 'an end drops what its session still had queued');
  const log = fs.readFileSync(path.join(f.home, '.keep-node', 'hook.log'), 'utf8');
  assert.match(log, /pi start for session pi-later: the daemon did not take it .*; queued/);
  assert.match(log, /pi end for session pi-later: the daemon did not take it .*; queued/);
});
