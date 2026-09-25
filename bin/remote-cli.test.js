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
    command: 'checkin', args: ['some-card', '-m', 'line one\nline two'], cwd: root, nodeCwd: root,
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

test('a request is bounded by the wall clock, however slowly the daemon keeps reading it', async (t) => {
  const { nodeApiRequest } = require('./remote-cli.js');
  // The daemon reads the upload a little at a time: the socket is never idle.
  const slow = http.createServer((req, res) => {
    req.on('data', () => { req.pause(); setTimeout(() => req.resume(), 100); });
    req.on('end', () => res.end('{}'));
  });
  const sockets = new Set();
  slow.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); slow.close(); });
  const url = `http://127.0.0.1:${slow.address().port}`;
  const began = Date.now();
  const error = await nodeApiRequest(url, '/api/hook', { payload: { pad: 'x'.repeat(8 * 1024 * 1024) }, token: 't', timeoutMs: 1000 })
    .then(() => null, (reason) => reason);
  const elapsed = Date.now() - began;
  assert.ok(error, 'the request failed');
  assert.equal(error.timedOut, true);
  assert.match(error.message, /^timed out after 1s$/);
  assert.ok(elapsed >= 900 && elapsed < 2500, `failed after ${elapsed} ms`);
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

// A post that times out while the daemon answers its ping is a command still running
// there: it is resent with its key as often as it takes, and spends none of the fixed
// budget that a daemon which stopped answering gets.
test('a command still running on the daemon is resent with its key until it answers, past the fixed retries', async (t) => {
  const { postWithRetry, RETRY_WAITS_MS } = require('./remote-cli.js');
  const payload = { command: 'open', args: ['card'], cwd: '/', idempotencyKey: 'k'.repeat(32) };
  const where = { local: 'aws1', daemon: 'main', url: 'http://127.0.0.1:1' };
  const timedOut = () => Object.assign(new Error('timed out after 900s'), { timedOut: true });
  const posts = [];
  const notes = [];
  const held = RETRY_WAITS_MS.length + 3;
  const response = await postWithRetry(where, '/api/registry', payload, {
    token: 't', timeoutMs: 900e3,
    request: async (url, pathname, options) => {
      if (pathname === '/api/registry/ping') return { status: 200, data: '{}' };
      posts.push(options.payload);
      if (posts.length <= held) throw timedOut();
      return { status: 200, data: JSON.stringify({ ok: true, status: 0, stdout: 'opened\n', stderr: '', replayed: true }) };
    },
    sleep: async () => { throw new Error('no backoff wait expected'); },
    note: (line) => notes.push(line),
  });
  assert.equal(response.status, 200);
  assert.equal(posts.length, held + 1, 'more resends than the fixed budget has waits');
  assert.ok(posts.every((body) => body === payload), 'every resend is the identical payload and key');
  assert.equal(notes.length, held);

  // A timed-out post whose ping then goes unanswered is a daemon gone: the fixed
  // backoff, then unreachable.
  const waits = [];
  const gone = [];
  await assert.rejects(postWithRetry(where, '/api/registry', payload, {
    token: 't', timeoutMs: 900e3,
    request: async (url, pathname) => {
      if (pathname === '/api/registry/ping') throw new Error('connect ECONNREFUSED');
      gone.push(pathname);
      throw timedOut();
    },
    sleep: async (ms) => { waits.push(ms); }, note: () => {},
  }), /^Error: daemon on main unreachable \(connect ECONNREFUSED\)/);
  assert.deepEqual(waits, [...RETRY_WAITS_MS]);
  assert.equal(gone.length, 1, 'nothing is resent to a daemon that does not answer');

  // A network error still gets the fixed retries and no more.
  const tries = [];
  const spent = [];
  await assert.rejects(postWithRetry(where, '/api/registry', payload, {
    token: 't',
    request: async (url, pathname) => {
      if (pathname === '/api/registry/ping') return { status: 200, data: '{}' };
      tries.push(pathname);
      throw new Error('socket hang up');
    },
    sleep: async (ms) => { spent.push(ms); }, note: () => { throw new Error('no still-running note for a lost connection'); },
  }), /^Error: daemon on main unreachable \(socket hang up\)/);
  assert.deepEqual(spent, [...RETRY_WAITS_MS]);
  assert.equal(tries.length, RETRY_WAITS_MS.length + 1);
});

// The daemon's ping says how long a command may run there; the node follows it past
// its own four-hour floor, and keeps the floor only for a daemon that says nothing.
test('a command still running is waited on for as long as the daemon\'s ping says it may run', async (t) => {
  const { postWithRetry, RESEND_HORIZON_MS, REQUEST_TIMEOUT_MS } = require('./remote-cli.js');
  const payload = { command: 'open', args: ['card'], cwd: '/', idempotencyKey: 'k'.repeat(32) };
  const run = async (pingBody) => {
    let clock = 0;
    const posts = [];
    const notes = [];
    const error = await postWithRetry({ local: 'aws1', daemon: 'main', url: 'http://127.0.0.1:1' }, '/api/registry', payload, {
      token: 't', timeoutMs: 900e3, now: () => clock,
      request: async (url, pathname, options) => {
        if (pathname === '/api/registry/ping') return { status: 200, data: JSON.stringify(pingBody) };
        posts.push(options.payload);
        clock += options.timeoutMs;
        throw Object.assign(new Error('timed out after 900s'), { timedOut: true });
      },
      sleep: async () => { throw new Error('no backoff wait expected'); }, note: (line) => notes.push(line),
    }).then(() => null, (failure) => failure);
    return { error, posts, notes, clock };
  };
  const advertised = 245 * 60e3;
  const followed = await run({ ok: true, maxRunMs: advertised });
  assert.ok(followed.clock > RESEND_HORIZON_MS, 'it kept resending past four hours');
  assert.ok(followed.clock >= advertised + REQUEST_TIMEOUT_MS, 'and stopped only past the bound plus a post');
  assert.ok(followed.clock < advertised + REQUEST_TIMEOUT_MS + 900e3, 'at the first ping past it');
  assert.equal(followed.error.horizon, true);
  assert.match(followed.error.message, new RegExp(`under key ${'k'.repeat(32)}`));
  assert.equal(followed.notes[0], 'keep open: still running on the daemon on main (allowed up to 245 min), waiting…\n');

  const older = await run({ ok: true });
  assert.equal(older.clock, RESEND_HORIZON_MS, 'a daemon that advertises nothing gets the four-hour floor');
  assert.equal(older.error.horizon, true);
  assert.match(older.error.message, new RegExp(`under key ${'k'.repeat(32)}`));
  assert.equal(older.notes[0], 'keep open: still running on the daemon on main, waiting…\n');
});

test('a command still running on the daemon is waited on up to the horizon, which names its key', async (t) => {
  const { postWithRetry, RESEND_HORIZON_MS } = require('./remote-cli.js');
  assert.equal(RESEND_HORIZON_MS, 4 * 3600e3);
  const payload = { command: 'open', args: ['card'], cwd: '/', idempotencyKey: 'k'.repeat(32) };
  let clock = 0;
  const posts = [];
  const error = await postWithRetry({ local: 'aws1', daemon: 'main', url: 'http://127.0.0.1:1' }, '/api/registry', payload, {
    token: 't', timeoutMs: 900e3, now: () => clock,
    request: async (url, pathname, options) => {
      if (pathname === '/api/registry/ping') return { status: 200, data: '{}' };
      posts.push(options.payload);
      clock += options.timeoutMs;
      throw Object.assign(new Error('timed out after 900s'), { timedOut: true });
    },
    sleep: async () => { throw new Error('no backoff wait expected'); }, note: () => {},
  }).then(() => null, (failure) => failure);
  assert.ok(error, 'it gave up');
  assert.equal(posts.length, RESEND_HORIZON_MS / 900e3, 'posts until the horizon, then none');
  assert.match(error.message, new RegExp(`under key ${'k'.repeat(32)}`));
  assert.match(error.message, /may still be running on the daemon on main/);
  assert.equal(error.horizon, true);
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

test('a command the daemon ran but could not record prints its output and then a warning', async (t) => {
  const daemon = await stubDaemon(t, () => ({ status: 200, body: { ok: true, status: 0, stdout: 'checked in\n', stderr: 'note\n', replayed: false, journaled: false } }));
  const { root, env } = nodeEnv(t);
  env.KEEP_DAEMON_URL = daemon.url;
  const result = await run(['checkin', 'card', '-m', 'x'], { env, cwd: root });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'checked in\n');
  assert.equal(result.stderr, 'note\nkeep checkin: warning: the daemon on main ran this but could not record it; check by hand before retrying this command\n');
  const recorded = await stubDaemon(t, () => ({ status: 200, body: { ok: true, status: 0, stdout: 'checked in\n', stderr: '', replayed: false } }));
  const clean = await run(['checkin', 'card', '-m', 'x'], { env: { ...env, KEEP_DAEMON_URL: recorded.url }, cwd: root });
  assert.equal(clean.stderr, '');
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
  // keep artifact is not registry-class either, but a node with a URL posts its files
  // to /api/artifact (see the tests at the end); without a URL it refuses as these do.
  for (const argv of [['handoff', 'card'], ['sync'], ['serve']]) {
    const result = await run(argv, { env: { ...env, KEEP_DAEMON_URL: daemon.url }, cwd: root });
    assert.equal(result.status, 2, argv.join(' '));
    assert.equal(result.stderr, `keep ${argv[0]}: the registry lives on node main; this is node aws1\n`);
  }
  const plain = await run(['show', 'card'], { env, cwd: root });
  assert.equal(plain.status, 2);
  assert.equal(plain.stderr, 'keep show: the registry lives on node main; this is node aws1\n');
  const artifact = await run(['artifact', 'card'], { env, cwd: root });
  assert.equal(artifact.status, 2);
  assert.equal(artifact.stderr, 'keep artifact: the registry lives on node main; this is node aws1\n');
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

test('from a linked worktree the node sends its main checkout as the cwd, and the worktree only as nodeCwd', async (t) => {
  const daemon = await stubDaemon(t, () => ({ status: 200, body: { ok: true, status: 0, stdout: '', stderr: '', durationMs: 1, replayed: false } }));
  const { root, env } = nodeEnv(t, { CLAUDE_CODE_SESSION_ID: 'sess-aws1' });
  env.KEEP_DAEMON_URL = daemon.url;
  const main = path.join(root, 'project');
  const tree = path.join(root, 'project-wt');
  const git = (...args) => require('node:child_process').execFileSync('git', args, { encoding: 'utf8', env: { ...env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test' } });
  git('init', '-q', '--initial-branch=master', main);
  git('-C', main, 'commit', '-q', '--allow-empty', '-m', 'base');
  git('-C', main, 'worktree', 'add', '-q', '-b', 'wt/x', tree);
  fs.mkdirSync(path.join(tree, 'sub'));
  await run(['claim', 'some-card'], { env, cwd: tree });
  await run(['show', 'some-card'], { env, cwd: path.join(tree, 'sub') });
  await run(['show', 'some-card'], { env, cwd: main });
  assert.deepEqual(daemon.requests.map((request) => [request.body.cwd, request.body.nodeCwd]), [
    [main, tree], [main, path.join(tree, 'sub')], [main, main],
  ]);
});

// A session on a node messages another through the daemon, whose tell runs under the
// sender's own identity; only a file the daemon cannot see is refused.
test('keep tell from a node is posted to the daemon, and its refused and still-busy statuses come back as they are', async (t) => {
  let status = 124;
  const daemon = await stubDaemon(t, () => ({ status: 200, body: { ok: false, status, stdout: '', stderr: 'keep tell: still busy after 5m: mid-turn\n', replayed: false } }));
  const { root, env } = nodeEnv(t, { CLAUDE_CODE_SESSION_ID: 'sess-aws1' });
  env.KEEP_DAEMON_URL = daemon.url;
  const busy = await run(['tell', '#12', '-m', 'hi', '--wait', '5m'], { env, cwd: root });
  assert.equal(busy.status, 124, busy.stderr);
  assert.equal(busy.stderr, 'keep tell: still busy after 5m: mid-turn\n');
  assert.equal(daemon.requests[0].url, '/api/registry');
  assert.equal(daemon.requests[0].body.command, 'tell');
  assert.deepEqual(daemon.requests[0].body.args, ['#12', '-m', 'hi', '--wait', '5m']);
  assert.equal(daemon.requests[0].body.session, 'sess-aws1');
  status = 3;
  const refused = await run(['tell', 'some-card', '-m', 'hi'], { env, cwd: root });
  assert.equal(refused.status, 3, refused.stderr);
});

// A state note from a node is written by the daemon's CLI under the note's author, the
// node's session; every form goes as the node typed it, and nothing is read on the node.
test('keep note from a node is posted to the daemon with its flags as they are', async (t) => {
  const daemon = await stubDaemon(t, () => ({ status: 200, body: { ok: true, status: 0, stdout: 'n-0001: noted\n', stderr: '', replayed: false } }));
  const { root, env } = nodeEnv(t, { CLAUDE_CODE_SESSION_ID: 'sess-aws1' });
  env.KEEP_DAEMON_URL = daemon.url;
  const forms = [
    ['app', '--scope', 'staging', '--for', '+2h', '-m', 'deploying now'],
    ['app', '--scope', 'db', '--for', '+30m', '--task', 'some-card', '-m', 'migrating'],
    ['--extend', 'n-0001', '--for', '+1h'],
    ['--clear', 'n-0001', '-m', 'done early'],
  ];
  for (const [i, args] of forms.entries()) {
    const result = await run(['note', ...args], { env, cwd: root });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'n-0001: noted\n');
    assert.equal(daemon.requests[i].url, '/api/registry');
    assert.equal(daemon.requests[i].body.command, 'note');
    assert.deepEqual(daemon.requests[i].body.args, args);
    assert.equal(daemon.requests[i].body.session, 'sess-aws1');
  }
});

test('a forwarded tell\'s request outlasts its --wait; every other command keeps the ordinary bound', async (t) => {
  const { requestTimeoutMs, runRemote, REQUEST_TIMEOUT_MS } = require('./remote-cli.js');
  assert.equal(requestTimeoutMs('tell', ['#12', '-m', 'hi', '--wait', '5m', '--dry']), REQUEST_TIMEOUT_MS + 5 * 60e3);
  assert.equal(requestTimeoutMs('tell', ['card', '--wait', '+10m', '--json', '--wait', '1h']), REQUEST_TIMEOUT_MS + 3600e3, 'the last --wait wins');
  assert.equal(requestTimeoutMs('tell', ['card', '-m', '--wait', '--dry']), REQUEST_TIMEOUT_MS, 'a message is not a flag');
  assert.equal(requestTimeoutMs('tell', ['--', 'card', '--wait', '5m']), REQUEST_TIMEOUT_MS, 'after -- nothing is a flag');
  assert.equal(requestTimeoutMs('tell', ['card', '-m', 'hi', '--wait', 'soon']), REQUEST_TIMEOUT_MS, 'the daemon\'s CLI refuses a bad duration itself');
  assert.equal(requestTimeoutMs('tell', ['card', '-m', 'hi']), REQUEST_TIMEOUT_MS);
  assert.equal(requestTimeoutMs('checkin', ['card', '--wait', '5m']), REQUEST_TIMEOUT_MS);

  const root = tempDir(t);
  const seen = [];
  const request = async (url, pathname, options) => {
    seen.push(options.timeoutMs);
    return { status: 200, data: JSON.stringify({ ok: true, status: 0, stdout: 'told\n', stderr: '' }) };
  };
  const where = { local: 'aws1', daemon: 'main', url: 'http://127.0.0.1:1' };
  const deps = { where, request, token: 't', env: {}, cwd: root };
  assert.equal((await runRemote('tell', ['card', '-m', 'hi', '--wait', '2m'], deps)).code, 0);
  assert.equal((await runRemote('show', ['card'], deps)).code, 0);
  assert.equal((await runRemote('tell', ['card', '-m', 'hi', '--wait', '2m'], { ...deps, timeoutMs: 5 })).code, 0);
  assert.deepEqual(seen, [REQUEST_TIMEOUT_MS + 2 * 60e3, REQUEST_TIMEOUT_MS, 5]);
});

// A session on a node that plans work opens sessions for it through the daemon, on
// any node the daemon knows.
test('keep open from a node is posted to the daemon under its session, and its request outlasts the open', async (t) => {
  const daemon = await stubDaemon(t, () => ({ status: 200, body: { ok: true, status: 0, stdout: 'opened pane p1: claude as new\n', stderr: '', replayed: false } }));
  const { root, env } = nodeEnv(t, { CLAUDE_CODE_SESSION_ID: 'sess-aws1' });
  env.KEEP_DAEMON_URL = daemon.url;
  const opened = await run(['open', 'card', '--fresh', '-m', 'hi', '--node', 'main'], { env, cwd: root });
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(opened.stdout, 'opened pane p1: claude as new\n');
  assert.equal(daemon.requests[0].url, '/api/registry');
  assert.equal(daemon.requests[0].body.command, 'open');
  assert.deepEqual(daemon.requests[0].body.args, ['card', '--fresh', '-m', 'hi', '--node', 'main']);
  assert.equal(daemon.requests[0].body.session, 'sess-aws1');

  const { requestTimeoutMs, runRemote, REQUEST_TIMEOUT_MS } = require('./remote-cli.js');
  const { OPEN_EXTRA_MS } = require('./registry-commands.js');
  assert.equal(requestTimeoutMs('open', ['card', '--fresh', '-m', 'hi']), REQUEST_TIMEOUT_MS + OPEN_EXTRA_MS);
  const seen = [];
  const sent = [];
  const request = async (url, pathname, options) => {
    sent.push(pathname);
    seen.push(options.timeoutMs);
    return { status: 200, data: JSON.stringify({ ok: true, status: 0, stdout: 'opened\n', stderr: '' }) };
  };
  const deps = { where: { local: 'aws1', daemon: 'main', url: 'http://127.0.0.1:1' }, request, token: 't', env: {}, cwd: root };
  assert.equal((await runRemote('open', ['card', '--fresh'], deps)).code, 0);
  assert.deepEqual(seen, [REQUEST_TIMEOUT_MS + OPEN_EXTRA_MS]);
  // A message file is a path on this node: refused here, before anything is posted.
  assert.deepEqual(await runRemote('open', ['card', '--fresh', '--message-file', 'note.md'], deps), {
    code: 2, stdout: '', stderr: 'keep open: --message-file names a file on this node; use -m, or run it from the daemon node\n',
  });
  assert.equal(sent.length, 1);
});

// A daemon with a raised compaction timeout may run an open longer than the node's
// request waits: the node resends the same key and is answered with that run's result.
test('an open whose request times out at the node is resent with its key and answered by the one run', async (t) => {
  const { runRemote, REQUEST_TIMEOUT_MS } = require('./remote-cli.js');
  const { OPEN_EXTRA_MS } = require('./registry-commands.js');
  const root = tempDir(t);
  const posts = [];
  const request = async (url, pathname, options) => {
    if (pathname === '/api/registry/ping') return { status: 200, data: '{}' };
    posts.push(options);
    if (posts.length === 1) throw Object.assign(new Error(`timed out after ${options.timeoutMs / 1000}s`), { timedOut: true });
    return { status: 200, data: JSON.stringify({ ok: true, status: 0, stdout: 'opened\n', stderr: '', replayed: true }) };
  };
  const notes = [];
  const deps = { where: { local: 'aws1', daemon: 'main', url: 'http://127.0.0.1:1' }, request, token: 't', env: {}, cwd: root,
    sleep: async () => { throw new Error('a timed-out post spends no backoff wait'); }, note: (line) => notes.push(line) };
  assert.deepEqual(await runRemote('open', ['card', '--fresh', '-m', 'hi'], deps), { code: 0, stdout: 'opened\n', stderr: '' });
  assert.deepEqual(notes, ['keep open: still running on the daemon on main, waiting…\n']);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].payload.idempotencyKey, posts[1].payload.idempotencyKey);
  assert.deepEqual(posts.map((post) => post.timeoutMs), [REQUEST_TIMEOUT_MS + OPEN_EXTRA_MS, REQUEST_TIMEOUT_MS + OPEN_EXTRA_MS]);
});

test('an open the daemon cannot bound comes back as the daemon\'s refusal, word for word', async (t) => {
  const { OPEN_UNBOUNDED_REFUSAL } = require('./registry-commands.js');
  const daemon = await stubDaemon(t, () => ({ status: 409, body: { error: OPEN_UNBOUNDED_REFUSAL } }));
  const { root, env } = nodeEnv(t, { CLAUDE_CODE_SESSION_ID: 'sess-aws1' });
  env.KEEP_DAEMON_URL = daemon.url;
  const result = await run(['open', 'card', '--fresh'], { env, cwd: root });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, `keep open: the daemon on main refused: ${OPEN_UNBOUNDED_REFUSAL}\n`);
  assert.equal(daemon.requests.filter((entry) => entry.method === 'POST').length, 1, 'a refusal is not resent');
});

test('a tell naming a file on the node, or waiting past a day, is refused on the node and never posted', async (t) => {
  const { runRemote } = require('./remote-cli.js');
  const root = tempDir(t);
  const sent = [];
  const request = async (...args) => { sent.push(args); return { status: 500, data: '{}' }; };
  const deps = { where: { local: 'aws1', daemon: 'main', url: 'http://127.0.0.1:1' }, request, token: 't', env: {}, cwd: root };
  assert.deepEqual(await runRemote('tell', ['card', '--message-file', 'note.md'], deps), {
    code: 2, stdout: '', stderr: 'keep tell: --message-file names a file on this node; use -m, or run it from the daemon node\n',
  });
  assert.deepEqual(await runRemote('tell', ['card', '-m', 'hi', '--wait', '2d'], deps), {
    code: 2, stdout: '', stderr: 'keep tell: --wait on a forwarded tell is at most 24h\n',
  });
  assert.equal(sent.length, 0);
});

// ---- keep artifact from a node (bin/artifact-route.js is the daemon's side) ----

test('keep artifact from a node reads its files and posts their bytes, and prints the daemon\'s answer', async (t) => {
  const crypto = require('node:crypto');
  const daemon = await stubDaemon(t, () => ({ status: 200, body: { ok: true, status: 0, stdout: '/registry/.keep/artifacts/card/shot.png\n', stderr: '', replayed: false } }));
  const { root, env } = nodeEnv(t, { CLAUDE_CODE_SESSION_ID: 'sess-aws1', KEEP_PANE: 'p7' });
  env.HOME = root;
  env.KEEP_DAEMON_URL = daemon.url;
  fs.mkdirSync(path.join(root, 'shots'));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  fs.writeFileSync(path.join(root, 'shots', 'shot.png'), png);
  const result = await run(['artifact', 'card', 'shots/shot.png', '-m', 'the login screen'], { env, cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '/registry/.keep/artifacts/card/shot.png\n');
  assert.equal(daemon.requests.length, 1);
  const [request] = daemon.requests;
  assert.equal(request.url, '/api/artifact');
  assert.equal(request.headers['x-keep-node-token'], 'aws1-secret');
  const { idempotencyKey, ...rest } = request.body;
  assert.match(idempotencyKey, /^[a-f0-9]{32}$/);
  assert.deepEqual(rest, {
    command: 'artifact', cwd: root, nodeCwd: root, session: 'sess-aws1', agent: 'claude', pane: 'p7@aws1',
    card: 'card', note: 'the login screen',
    files: [{
      name: 'shot.png', size: png.length, sha256: crypto.createHash('sha256').update(png).digest('hex'),
      source: path.join(root, 'shots', 'shot.png'), content: png.toString('base64'),
    }],
  });
  // A listing posts no files and prints the daemon's list.
  const listed = await run(['artifact', 'card'], { env, cwd: root });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(daemon.requests[1].body.files, []);
  assert.equal(daemon.requests[1].body.note, null);
});

test('keep artifact from a node refuses a file outside home, not a regular file, or too large before posting', async (t) => {
  const { runArtifact } = require('./remote-cli.js');
  const { ARTIFACT_FILE_MAX_BYTES, ARTIFACT_COMMAND_MAX_BYTES } = require('./registry-commands.js');
  const home = tempDir(t);
  const elsewhere = tempDir(t);
  const sent = [];
  const request = async (url, pathname, options) => {
    sent.push({ pathname, options });
    return { status: 200, data: JSON.stringify({ ok: true, status: 0, stdout: 'stored\n', stderr: '' }) };
  };
  const deps = { where: { local: 'aws1', daemon: 'main', url: 'http://127.0.0.1:1' }, request, token: 't', env: {}, cwd: home, home };
  fs.writeFileSync(path.join(elsewhere, 'secret.txt'), 'x');
  const outside = await runArtifact(['card', path.join(elsewhere, 'secret.txt')], deps);
  assert.equal(outside.code, 2);
  assert.match(outside.stderr, /^keep artifact: .*secret\.txt is outside this node's home directory/);
  // A link inside home is judged by where it leads.
  fs.symlinkSync(path.join(elsewhere, 'secret.txt'), path.join(home, 'link.txt'));
  assert.match((await runArtifact(['card', 'link.txt'], deps)).stderr, /outside this node's home directory/);
  fs.mkdirSync(path.join(home, 'dir'));
  assert.match((await runArtifact(['card', 'dir'], deps)).stderr, /artifact is not a regular file: .*dir/);
  assert.match((await runArtifact(['card', 'missing.png'], deps)).stderr, /artifact file does not exist: .*missing\.png/);
  fs.writeFileSync(path.join(home, 'big.bin'), Buffer.alloc(ARTIFACT_FILE_MAX_BYTES + 1));
  assert.match((await runArtifact(['card', 'big.bin'], deps)).stderr, /artifact too large: .*big\.bin \(5\.0 MB\)/);
  // Each under the per-file bound, together over the per-command one.
  const count = Math.floor(ARTIFACT_COMMAND_MAX_BYTES / ARTIFACT_FILE_MAX_BYTES) + 1;
  const names = [];
  for (let i = 0; i < count; i += 1) {
    names.push(`part-${i}.bin`);
    fs.writeFileSync(path.join(home, names[i]), Buffer.alloc(ARTIFACT_FILE_MAX_BYTES));
  }
  assert.match((await runArtifact(['card', ...names], deps)).stderr, /larger than 20 MB together/);
  assert.equal(sent.length, 0, 'nothing was posted');

  // A file that passes is posted once, with a bound that grows with its size.
  fs.writeFileSync(path.join(home, 'ok.txt'), 'hello');
  const ok = await runArtifact(['card', 'ok.txt'], deps);
  assert.deepEqual(ok, { code: 0, stdout: 'stored\n', stderr: '' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].pathname, '/api/artifact');
  const { artifactTimeoutMs, REQUEST_TIMEOUT_MS } = require('./remote-cli.js');
  assert.equal(sent[0].options.timeoutMs, artifactTimeoutMs(5));
  assert.ok(artifactTimeoutMs(ARTIFACT_COMMAND_MAX_BYTES) > REQUEST_TIMEOUT_MS + 60e3);
  assert.ok(artifactTimeoutMs(ARTIFACT_COMMAND_MAX_BYTES) < REQUEST_TIMEOUT_MS + 180e3);
});

test('keep artifact from a node prints the daemon\'s refusal as the daemon\'s, and its failing CLI as it is', async (t) => {
  const { runArtifact } = require('./remote-cli.js');
  const home = tempDir(t);
  fs.writeFileSync(path.join(home, 'a.txt'), 'a');
  const answers = [
    { status: 404, data: JSON.stringify({ error: 'no task "card" on the daemon — try `keep list`' }) },
    { status: 200, data: JSON.stringify({ ok: false, status: 1, stdout: '', stderr: 'keep: something failed\n' }) },
  ];
  const request = async () => answers.shift();
  const deps = { where: { local: 'aws1', daemon: 'main', url: 'http://127.0.0.1:1' }, request, token: 't', env: {}, cwd: home, home };
  assert.deepEqual(await runArtifact(['card', 'a.txt'], deps), {
    code: 2, stdout: '', stderr: 'keep artifact: the daemon on main refused: no task "card" on the daemon — try `keep list`\n',
  });
  assert.deepEqual(await runArtifact(['card', 'a.txt'], deps), { code: 1, stdout: '', stderr: 'keep: something failed\n' });
});

test('keep artifact from a node refuses a file swapped between its check and its read', async (t) => {
  const { runArtifact } = require('./remote-cli.js');
  const home = tempDir(t);
  const elsewhere = tempDir(t);
  fs.writeFileSync(path.join(home, 'shot.png'), 'png');
  fs.writeFileSync(path.join(elsewhere, 'secret.txt'), 'secret');
  let sent = 0;
  const request = async () => { sent += 1; return { status: 200, data: '{}' }; };
  // The open lands on a file outside home, as a rename would have made it.
  const io = { ...fs, openSync: (file, flags) => fs.openSync(file.endsWith('shot.png') ? path.join(elsewhere, 'secret.txt') : file, flags) };
  const deps = { where: { local: 'aws1', daemon: 'main', url: 'http://127.0.0.1:1' }, request, token: 't', env: {}, cwd: home, home, io };
  const answer = await runArtifact(['card', 'shot.png'], deps);
  assert.equal(answer.code, 2);
  assert.match(answer.stderr, /shot\.png changed while it was being read; try again/);
  assert.equal(sent, 0);
});

test('an upload the daemon turns away as busy is resent with its key after the wait it names', async (t) => {
  const { postWithRetry } = require('./remote-cli.js');
  const posts = [];
  const answers = [
    { status: 429, data: JSON.stringify({ error: 'the daemon is taking another artifact upload; try again', busy: true, retryAfterMs: 2000 }) },
    { status: 429, data: JSON.stringify({ error: 'the daemon is taking another artifact upload; try again', busy: true, retryAfterMs: 2000 }) },
    { status: 200, data: JSON.stringify({ ok: true, status: 0, stdout: 'stored\n', stderr: '' }) },
  ];
  const slept = [];
  const notes = [];
  const request = async (url, pathname, options) => { posts.push({ pathname, key: options.payload.idempotencyKey }); return answers.shift(); };
  const response = await postWithRetry({ local: 'aws1', daemon: 'main', url: 'http://127.0.0.1:1' }, '/api/artifact',
    { command: 'artifact', idempotencyKey: 'k-0123456789abcdef' },
    { request, token: 't', sleep: async (ms) => { slept.push(ms); }, note: (line) => notes.push(line), label: 'keep artifact' });
  assert.equal(response.status, 200);
  assert.deepEqual(posts.map((entry) => entry.key), ['k-0123456789abcdef', 'k-0123456789abcdef', 'k-0123456789abcdef']);
  assert.deepEqual(posts.map((entry) => entry.pathname), ['/api/artifact', '/api/artifact', '/api/artifact'], 'no ping: the daemon answered');
  assert.deepEqual(slept, [2000, 2000]);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /keep artifact: the daemon is taking another artifact upload; try again \(daemon on main\), waiting…/);
  // Past the horizon it stops, and says why.
  let clock = 0;
  const busy = async () => ({ status: 429, data: JSON.stringify({ error: 'busy upload', busy: true, retryAfterMs: 1000 }) });
  await assert.rejects(postWithRetry({ local: 'aws1', daemon: 'main', url: 'http://127.0.0.1:1' }, '/api/artifact', { idempotencyKey: 'k' },
    { request: busy, token: 't', now: () => clock, sleep: async () => { clock += 60e3; }, note: () => {}, resendHorizonMs: 5 * 60e3 }),
  /gave up waiting after 5m: busy upload/);
});

test('an upload refused for a quota is printed as the daemon\'s refusal and never resent', async (t) => {
  const { runArtifact } = require('./remote-cli.js');
  const home = tempDir(t);
  fs.writeFileSync(path.join(home, 'a.txt'), 'a');
  let posts = 0;
  const message = 'node aws1 has stored 256.0 MB in 12 artifact files in the last 24 hours; this upload of 0.0 MB in 1 would pass its daily limit of 256.0 MB and 200 files; room frees at 2026-09-21T10:00:00.000Z';
  const request = async () => { posts += 1; return { status: 413, data: JSON.stringify({ error: message }) }; };
  const deps = { where: { local: 'aws1', daemon: 'main', url: 'http://127.0.0.1:1' }, request, token: 't', env: {}, cwd: home, home, sleep: async () => { throw new Error('no wait'); } };
  assert.deepEqual(await runArtifact(['card', 'a.txt'], deps), { code: 2, stdout: '', stderr: `keep artifact: the daemon on main refused: ${message}\n` });
  assert.equal(posts, 1);
});

test('fetchArtifact reads one artifact\'s bytes from the daemon with the node token, and names a refusal', async (t) => {
  const { fetchArtifact } = require('./remote-cli.js');
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, token: req.headers['x-keep-node-token'], keep: req.headers['x-keep'] });
    if (req.url.includes('name=shot.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from([0x89, 0x00, 0xff]));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no such artifact' }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const where = { url: `http://127.0.0.1:${server.address().port}`, daemon: 'main' };
  const got = await fetchArtifact(where, 'card', 'shot.png', { token: 'node-secret' });
  assert.equal(got.code, 0);
  assert.deepEqual([...got.bytes], [0x89, 0x00, 0xff], 'binary bytes arrive intact');
  assert.deepEqual(seen[0], { url: '/api/node-artifact?card=card&name=shot.png', token: 'node-secret', keep: '1' });
  const missing = await fetchArtifact(where, 'card', 'gone.png', { token: 'node-secret' });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no artifact "gone\.png" on card/);
});
