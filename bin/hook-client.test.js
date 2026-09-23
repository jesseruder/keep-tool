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

  // The daemon takes the replayed stop and never answers it: the replay's time runs
  // out with the stop still queued, so the new event waits behind it.
  const slow = await stubDaemon(t, () => 'hang');
  const result = await f.hook('lifecycle', slow.url, { hook_event_name: 'PostToolUse' });
  assert.deepEqual(result, { status: 0, stdout: '', stderr: '' }, 'the safe default');
  assert.deepEqual(slow.posts.map((post) => post.body.event), ['stop'], 'nothing posted ahead of it');
  assert.deepEqual(f.queue().map((entry) => `${entry.event}:${entry.body.identity.sessionId}`),
    ['stop:sess-aws1', 'notification:sess-other', 'lifecycle:sess-aws1'], 'queued behind it, in order');

  // A daemon that answers: the queue drains in order, then the new event goes.
  const daemon = await stubDaemon(t, () => ran(''));
  const next = await f.hook('lifecycle', daemon.url, { hook_event_name: 'PostToolUse' });
  assert.equal(next.status, 0, next.stderr);
  assert.deepEqual(daemon.posts.map((post) => `${post.body.event}:${post.body.identity.sessionId}`),
    ['stop:sess-aws1', 'notification:sess-other', 'lifecycle:sess-aws1', 'lifecycle:sess-aws1'], 'drained in order, then the new one');
  assert.deepEqual(f.queue(), []);
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
  assert.deepEqual(daemon.posts.map((post) => post.url), ['/api/hook/context?session=sess-aws1', '/api/hook']);
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
  const refused = await shell(daemon.url, 'terraform apply');
  assert.equal(refused.status, 2);
  assert.deepEqual(onlyJson(refused), JSON.parse(block('step apply')));
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
