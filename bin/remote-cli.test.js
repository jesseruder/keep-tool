'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CLI = path.join(__dirname, 'keep.js');

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-remote-cli-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A stand-in for the daemon's node API: records each request and answers with
// whatever the test returns for it.
async function stubDaemon(t, answer) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: data ? JSON.parse(data) : null };
      requests.push(entry);
      const reply = answer(entry, requests.length);
      if (reply === 'drop') { req.socket.destroy(); return; }
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

function nodeEnv(t, extra = {}) {
  const root = tempDir(t);
  const tokenFile = path.join(root, 'node-token');
  fs.writeFileSync(tokenFile, 'aws1-secret\n', { mode: 0o600 });
  const env = { ...process.env, KEEP_DIR: path.join(root, 'no-registry'), KEEP_NODE_NAME: 'aws1', KEEP_DAEMON_NODE: 'main',
    KEEP_NODE_TOKEN_FILE: tokenFile, ...extra };
  for (const name of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'KEEP_PI_SESSION_ID', 'KEEP_PANE', 'KEEP_CONFIG']) {
    if (!(name in extra)) delete env[name];
  }
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return { root, env };
}

function run(argv, { env, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('a registry command on a node with a daemon URL is posted to the daemon and its answer printed', async (t) => {
  const daemon = await stubDaemon(t, () => ({ status: 200, body: { ok: false, status: 3, stdout: 'card shown\n', stderr: 'a warning\n', durationMs: 5, replayed: false } }));
  const { root, env } = nodeEnv(t, { CLAUDE_CODE_SESSION_ID: 'sess-aws1', KEEP_PANE: 'p7' });
  env.KEEP_DAEMON_URL = daemon.url;
  const result = await run(['checkin', 'some-card', '-m', 'line one\nline two'], { env, cwd: root });
  assert.equal(result.status, 3);
  assert.equal(result.stdout, 'card shown\n');
  assert.equal(result.stderr, 'a warning\n');
  assert.equal(daemon.requests.length, 1);
  const [request] = daemon.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/registry');
  assert.equal(request.headers['x-keep'], '1');
  assert.equal(request.headers['x-keep-node-token'], 'aws1-secret');
  assert.equal(request.headers['x-keep-token'], undefined);
  const { idempotencyKey, ...rest } = request.body;
  assert.match(idempotencyKey, /^[a-f0-9]{32}$/);
  assert.deepEqual(rest, {
    command: 'checkin', args: ['some-card', '-m', 'line one\nline two'], cwd: root,
    session: 'sess-aws1', agent: 'claude', pane: 'p7@aws1',
  });
  // No session in the environment: none is claimed.
  const bare = await run(['list'], { env: { ...env, CLAUDE_CODE_SESSION_ID: '' }, cwd: root });
  assert.equal(bare.status, 3);
  assert.equal(daemon.requests[1].body.command, 'list');
  assert.equal(daemon.requests[1].body.session, undefined);
  const codex = await run([], { env: { ...env, CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: 'thread-1', KEEP_PANE: '' }, cwd: root });
  assert.equal(codex.status, 3);
  assert.equal(daemon.requests[2].body.command, 'list', 'a bare keep is keep list');
  assert.equal(daemon.requests[2].body.agent, 'codex');
  assert.equal(daemon.requests[2].body.pane, undefined);
});

test('a lost answer is resent with the same key once the daemon answers its ping', async (t) => {
  const daemon = await stubDaemon(t, (entry, n) => (n === 1 ? 'drop' : { status: 200, body: { ok: true, status: 0, stdout: 'done\n', stderr: '', replayed: true } }));
  const { root, env } = nodeEnv(t);
  env.KEEP_DAEMON_URL = daemon.url;
  const result = await run(['show', 'card'], { env, cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'done\n');
  assert.deepEqual(daemon.requests.map((entry) => `${entry.method} ${entry.url}`),
    ['POST /api/registry', 'GET /api/registry/ping', 'POST /api/registry']);
  assert.equal(daemon.requests[0].body.idempotencyKey, daemon.requests[2].body.idempotencyKey);
});

test('each request to the daemon opens its own connection', async (t) => {
  const { nodeApiRequest } = require('./remote-cli.js');
  let connections = 0;
  const probe = http.createServer((req, res) => { res.end('{}'); });
  probe.on('connection', () => { connections += 1; });
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  t.after(() => probe.close());
  const url = `http://127.0.0.1:${probe.address().port}`;
  for (let i = 0; i < 3; i += 1) assert.equal((await nodeApiRequest(url, '/api/registry/ping', { method: 'GET', token: 't' })).status, 200);
  assert.equal(connections, 3, 'no kept-alive socket the daemon may since have closed is reused');
});

// A daemon restarting under a check-in: the post finds nothing listening, and the
// ping answers only after a while. The check-in is resent once, with its key, once
// the daemon is back — never once per wait.
test('a check-in that races a restart waits for the daemon and is resent once', async (t) => {
  const { postWithRetry, RETRY_WAITS_MS } = require('./remote-cli.js');
  assert.ok(RETRY_WAITS_MS.reduce((a, b) => a + b, 0) >= 15000 && RETRY_WAITS_MS.reduce((a, b) => a + b, 0) <= 25000);
  const up = Date.now() + 250;
  const daemon = await stubDaemon(t, (entry, n) => {
    if (n === 1 || Date.now() < up) return 'drop';
    if (entry.url === '/api/registry/ping') return { status: 200, body: { ok: true } };
    return { status: 200, body: { ok: true, status: 0, stdout: 'checked in\n', stderr: '', replayed: false } };
  });
  const slept = [];
  const where = { local: 'aws1', daemon: 'main', url: daemon.url };
  const payload = { command: 'checkin', args: ['card'], cwd: '/', idempotencyKey: 'k'.repeat(32) };
  const response = await postWithRetry(where, '/api/registry', payload, {
    token: 'aws1-secret', retryWaitsMs: [100, 100, 100, 100, 100, 100, 100],
    sleep: (ms) => { slept.push(ms); return new Promise((resolve) => setTimeout(resolve, ms)); },
  });
  assert.equal(response.status, 200);
  const posts = daemon.requests.filter((entry) => entry.method === 'POST');
  const pings = daemon.requests.filter((entry) => entry.url === '/api/registry/ping');
  assert.equal(posts.length, 2, 'the first post, lost, and one resend');
  assert.ok(pings.length >= 2, 'it waited for the daemon rather than resending into a restart');
  assert.deepEqual(posts.map((entry) => entry.body), [payload, payload]);
  assert.equal(pings[pings.length - 1].headers['x-keep-node-token'], 'aws1-secret');

  // Never answering: every wait is spent, nothing is resent, and it says so.
  const down = await stubDaemon(t, () => 'drop');
  const waits = [];
  await assert.rejects(postWithRetry({ ...where, url: down.url }, '/api/registry', payload, {
    token: 'aws1-secret', sleep: async (ms) => { waits.push(ms); },
  }), /^Error: daemon on main unreachable/);
  assert.deepEqual(waits, [...RETRY_WAITS_MS]);
  assert.equal(down.requests.filter((entry) => entry.method === 'POST').length, 1);
});

// A daemon on its way down refuses new commands before running or recording them;
// the node waits for the next daemon and sends the same request again.
test('a daemon restarting answers 503 and the command is resent with its key after the restart', async (t) => {
  const { postWithRetry } = require('./remote-cli.js');
  const daemon = await stubDaemon(t, (entry) => {
    if (entry.url === '/api/registry/ping') return { status: 200, body: { ok: true } };
    const posts = daemon.requests.filter((request) => request.method === 'POST').length;
    if (posts <= 2) return { status: 503, body: { error: 'daemon restarting' } };
    return { status: 200, body: { ok: true, status: 0, stdout: 'checked in\n', stderr: '', replayed: false } };
  });
  const payload = { command: 'checkin', args: ['card'], cwd: '/', idempotencyKey: 'k'.repeat(32) };
  const response = await postWithRetry({ local: 'aws1', daemon: 'main', url: daemon.url }, '/api/registry', payload, {
    token: 'aws1-secret', sleep: async () => {},
  });
  assert.equal(response.status, 200);
  const posts = daemon.requests.filter((entry) => entry.method === 'POST');
  assert.equal(posts.length, 3);
  assert.deepEqual(posts.map((entry) => entry.body), [payload, payload, payload]);
  // Any other 503 is the daemon's answer, not a restart to wait out.
  const other = await stubDaemon(t, () => ({ status: 503, body: { error: 'something else' } }));
  const answered = await postWithRetry({ local: 'aws1', daemon: 'main', url: other.url }, '/api/registry', payload, {
    token: 'aws1-secret', sleep: async () => { throw new Error('no wait expected'); },
  });
  assert.equal(answered.status, 503);
});

test('a resend of an interrupted run is refused by name, and nothing is printed as output', async (t) => {
  const daemon = await stubDaemon(t, () => ({ status: 409, body: { error: 'an earlier run of this request was interrupted; inspect before retrying', interrupted: true } }));
  const { root, env } = nodeEnv(t);
  env.KEEP_DAEMON_URL = daemon.url;
  const result = await run(['checkin', 'card', '-m', 'x'], { env, cwd: root });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'keep checkin: the daemon on main refused: an earlier run of this request was interrupted; inspect before retrying\n');
});

test('a refusal from the daemon is said as one, not as the command\'s output', async (t) => {
  const daemon = await stubDaemon(t, () => ({ status: 403, body: { error: 'session s is not on node aws1' } }));
  const { root, env } = nodeEnv(t);
  env.KEEP_DAEMON_URL = daemon.url;
  const result = await run(['show', 'card'], { env, cwd: root });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, 'keep show: the daemon on main refused: session s is not on node aws1\n');
});

test('a command that is not registry-class still refuses, and without a daemon URL nothing is posted', async (t) => {
  const daemon = await stubDaemon(t, () => ({ status: 500, body: {} }));
  const { root, env } = nodeEnv(t);
  for (const argv of [['open', 'card'], ['tell', 'card', 'hi'], ['sync'], ['artifact', 'card']]) {
    const result = await run(argv, { env: { ...env, KEEP_DAEMON_URL: daemon.url }, cwd: root });
    assert.equal(result.status, 2, argv.join(' '));
    assert.equal(result.stderr, `keep ${argv[0]}: the registry lives on node main; this is node aws1\n`);
  }
  const plain = await run(['show', 'card'], { env, cwd: root });
  assert.equal(plain.status, 2);
  assert.equal(plain.stderr, 'keep show: the registry lives on node main; this is node aws1\n');
  assert.equal(daemon.requests.length, 0);
  // On the daemon node a URL in the environment changes nothing.
  const { remoteMode } = require('./remote-cli.js');
  assert.equal(remoteMode({ KEEP_DAEMON_URL: daemon.url }), null);
  assert.equal(remoteMode({ KEEP_NODE_NAME: 'main', KEEP_DAEMON_NODE: 'main', KEEP_DAEMON_URL: daemon.url }), null);
});

test('a missing or unsafe token file is a clear error and nothing is sent', async (t) => {
  const daemon = await stubDaemon(t, () => ({ status: 200, body: { status: 0 } }));
  const { root, env } = nodeEnv(t);
  env.KEEP_DAEMON_URL = daemon.url;
  const missing = await run(['show', 'card'], { env: { ...env, KEEP_NODE_TOKEN_FILE: path.join(root, 'nope') }, cwd: root });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^keep show: cannot read this node's token: .*nope/);
  const unset = { ...env };
  delete unset.KEEP_NODE_TOKEN_FILE;
  const none = await run(['show', 'card'], { env: unset, cwd: root });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /KEEP_NODE_TOKEN_FILE is not set/);
  fs.chmodSync(env.KEEP_NODE_TOKEN_FILE, 0o644);
  const loose = await run(['show', 'card'], { env, cwd: root });
  assert.equal(loose.status, 2);
  assert.match(loose.stderr, /must be mode 0600/);
  const badUrl = await run(['show', 'card'], { env: { ...env, KEEP_DAEMON_URL: 'https://example.test/x' }, cwd: root });
  assert.equal(badUrl.status, 2);
  assert.match(badUrl.stderr, /KEEP_DAEMON_URL must be http/);
  assert.equal(daemon.requests.length, 0);
});
