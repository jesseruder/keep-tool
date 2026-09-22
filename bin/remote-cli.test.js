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

test('a lost answer is retried once with the same key, then the daemon is called unreachable', async (t) => {
  const daemon = await stubDaemon(t, (entry, n) => (n === 1 ? 'drop' : { status: 200, body: { ok: true, status: 0, stdout: 'done\n', stderr: '', replayed: true } }));
  const { root, env } = nodeEnv(t);
  env.KEEP_DAEMON_URL = daemon.url;
  const result = await run(['show', 'card'], { env, cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'done\n');
  assert.equal(daemon.requests.length, 2);
  assert.equal(daemon.requests[0].body.idempotencyKey, daemon.requests[1].body.idempotencyKey);

  const down = await stubDaemon(t, () => 'drop');
  const gone = await run(['show', 'card'], { env: { ...env, KEEP_DAEMON_URL: down.url }, cwd: root });
  assert.equal(gone.status, 2);
  assert.match(gone.stderr, /^keep show: daemon on main unreachable/);
  assert.equal(down.requests.length, 2);
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
