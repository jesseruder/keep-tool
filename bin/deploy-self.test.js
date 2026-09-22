'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const { createDeploySelf } = require('./deploy-self.js');
const { routes, matchRoute } = require('./serve/routes.js');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Keep Test', GIT_AUTHOR_EMAIL: 'keep@example.test',
  GIT_COMMITTER_NAME: 'Keep Test', GIT_COMMITTER_EMAIL: 'keep@example.test',
  GIT_CONFIG_NOSYSTEM: '1',
};
delete GIT_ENV.CLAUDE_CODE_SESSION_ID;

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-deploy-self-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A bare origin, the daemon's live checkout of it (named keep-tool), and a second
// clone that lands new commits the way a node would.
function repos(t, name = 'keep-tool') {
  const dir = tempDir(t);
  const origin = path.join(dir, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin], { env: GIT_ENV });
  const seed = path.join(dir, 'seed');
  execFileSync('git', ['clone', '-q', origin, seed], { env: GIT_ENV, stdio: 'ignore' });
  git(seed, 'checkout', '-q', '-b', 'master');
  fs.writeFileSync(path.join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', 'a.txt');
  git(seed, 'commit', '-q', '-m', 'one');
  git(seed, 'push', '-q', 'origin', 'master');
  const live = path.join(dir, name);
  execFileSync('git', ['clone', '-q', origin, live], { env: GIT_ENV, stdio: 'ignore' });
  const land = (text) => {
    fs.writeFileSync(path.join(seed, 'a.txt'), text);
    git(seed, 'commit', '-q', '-am', text.trim());
    git(seed, 'push', '-q', 'origin', 'master');
    return git(seed, 'rev-parse', 'HEAD');
  };
  return { dir, origin, seed, live, land };
}

function deployer(checkout, restart = async () => ({ ok: true })) {
  let restarts = 0;
  const service = createDeploySelf({ checkout, restart: async () => { restarts += 1; return restart(); } });
  return { service, restarts: () => restarts };
}

test('a node\'s landed sha fast-forwards the daemon\'s checkout and restarts it', async (t) => {
  const r = repos(t);
  const before = git(r.live, 'rev-parse', 'HEAD');
  const sha = r.land('two\n');
  const d = deployer(r.live);
  const answer = await d.service.handle({ sha, project: 'keep-tool' });
  assert.deepEqual(answer, { status: 200, body: { ok: true, checkout: r.live, from: before, to: sha, restarted: true } });
  assert.equal(git(r.live, 'rev-parse', 'HEAD'), sha);
  assert.equal(d.restarts(), 1);

  // Already at it: restarted again, as wt land does when the checkout is already there.
  const again = await d.service.handle({ sha, project: 'keep-tool' });
  assert.equal(again.body.restarted, true);
  assert.equal(again.body.from, sha);

  // Past it: that land's restart is the one that counts.
  const later = r.land('three\n');
  await d.service.handle({ sha: later, project: 'keep-tool' });
  const past = await d.service.handle({ sha, project: 'keep-tool' });
  assert.deepEqual(past.body, { ok: true, checkout: r.live, from: later, to: later, restarted: false, why: 'ahead' });
  assert.equal(d.restarts(), 3);
});

test('deploy-self refuses what wt land would leave alone', async (t) => {
  const r = repos(t);
  const sha = r.land('two\n');
  const d = deployer(r.live);
  const refused = async (body, pattern, status = 409) => {
    const answer = await d.service.handle(body);
    assert.equal(answer.status, status, JSON.stringify(answer.body));
    assert.equal(answer.body.ok, false);
    assert.match(answer.body.error, pattern);
  };
  await refused({ sha, project: 'castle-www' }, /not a project the daemon deploys/, 400);
  await refused({ sha: 'HEAD', project: 'keep-tool' }, /40-character/, 400);
  await refused({ sha: `${sha.slice(0, 39)}; rm -rf /`, project: 'keep-tool' }, /40-character/, 400);
  await refused({ sha: 'a'.repeat(40), project: 'keep-tool' }, /is not a commit origin has/);

  // A commit that exists but is not on origin/master.
  git(r.seed, 'checkout', '-q', '-b', 'side');
  fs.writeFileSync(path.join(r.seed, 'b.txt'), 'side\n');
  git(r.seed, 'add', 'b.txt');
  git(r.seed, 'commit', '-q', '-m', 'side');
  git(r.seed, 'push', '-q', 'origin', 'side');
  await refused({ sha: git(r.seed, 'rev-parse', 'HEAD'), project: 'keep-tool' }, /is not on origin\/master/);

  fs.writeFileSync(path.join(r.live, 'a.txt'), 'edited by hand\n');
  await refused({ sha, project: 'keep-tool' }, /has uncommitted changes/);
  git(r.live, 'checkout', '-q', '--', 'a.txt');

  git(r.live, 'checkout', '-q', '-b', 'experiment');
  await refused({ sha, project: 'keep-tool' }, /on experiment, not master/);
  git(r.live, 'checkout', '-q', 'master');

  assert.equal(d.restarts(), 0);
  assert.notEqual(git(r.live, 'rev-parse', 'HEAD'), sha, 'nothing moved');

  const elsewhere = repos(t, 'not-keep-tool');
  const other = deployer(elsewhere.live);
  const answer = await other.service.handle({ sha: elsewhere.land('x\n'), project: 'keep-tool' });
  assert.equal(answer.status, 409);
  assert.match(answer.body.error, /does not run from a keep-tool checkout/);
});

test('a restart the gate refuses leaves the code on disk and says so', async (t) => {
  const r = repos(t);
  const sha = r.land('two\n');
  const d = deployer(r.live, async () => { throw new Error('work in flight'); });
  const answer = await d.service.handle({ sha, project: 'keep-tool' });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.ok, false);
  assert.equal(answer.body.restarted, false);
  assert.match(answer.body.why, /work in flight/);
  assert.equal(git(r.live, 'rev-parse', 'HEAD'), sha);
});

test('the deploy-self route exists only where the daemon listens for nodes', () => {
  const req = { method: 'POST' };
  const url = new URL('http://x/api/deploy-self');
  assert.equal(matchRoute(routes({ json: () => {} }), { req, url, body: {} }), null);
  const route = matchRoute(routes({ json: () => {}, nodeApiEnabled: () => true }), { req, url, body: {} });
  assert.equal(route.path, '/api/deploy-self');
  assert.deepEqual(route.allow, ['node', 'admin', 'local']);
});

// ---------- keep land on a node ----------

async function stubDaemon(t, answer) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      const entry = { url: req.url, headers: req.headers, body: data ? JSON.parse(data) : null };
      requests.push(entry);
      const reply = answer(entry);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

function runKeep(argv, { env, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'keep.js'), ...argv], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// The node's own checkout of keep-tool and a wt worktree off it with one commit.
function nodeWorktree(t) {
  const r = repos(t);
  const tree = path.join(r.dir, 'wt-land');
  git(r.live, 'worktree', 'add', '-q', '-b', 'wt/land', tree, 'origin/master');
  fs.writeFileSync(path.join(tree, '.wt.json'), '{}\n');
  fs.appendFileSync(path.join(execFileSync('git', ['-C', r.live, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim(), 'info', 'exclude'), '.wt.json\n');
  fs.writeFileSync(path.join(tree, 'c.txt'), 'node work\n');
  git(tree, 'add', 'c.txt');
  git(tree, 'commit', '-q', '-m', 'node work');
  const tokenFile = path.join(r.dir, 'node-token');
  fs.writeFileSync(tokenFile, 'aws1-secret\n', { mode: 0o600 });
  const env = { ...GIT_ENV, KEEP_DIR: path.join(r.dir, 'no-registry'), KEEP_NODE_NAME: 'aws1', KEEP_DAEMON_NODE: 'main',
    KEEP_NODE_TOKEN_FILE: tokenFile, CLAUDE_CODE_SESSION_ID: 'sess-aws1', WT_NO_INSTALL: '1' };
  for (const name of ['KEEP_CONFIG', 'KEEP_PANE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'WT_NO_DEPLOY']) delete env[name];
  return { ...r, tree, env };
}

test('keep land on a node gates with the daemon\'s facts, pushes, checks in and asks the daemon to deploy', async (t) => {
  const n = nodeWorktree(t);
  const sha = git(n.tree, 'rev-parse', 'HEAD');
  const daemon = await stubDaemon(t, ({ url, body }) => {
    if (url === '/api/deploy-self') return { status: 200, body: { ok: true, checkout: '/srv/keep-tool', from: 'f'.repeat(40), to: body.sha, restarted: true } };
    if (body.command === 'land-facts') {
      return { status: 200, body: { status: 0, stdout: `${JSON.stringify({ id: 'card', grants: ['land'], records: [], obligations: [], optOut: '' })}\n`, stderr: '' } };
    }
    return { status: 200, body: { status: 0, stdout: 'checked in\n', stderr: '' } };
  });
  const result = await runKeep(['land', 'card'], { env: { ...n.env, KEEP_DAEMON_URL: daemon.url }, cwd: n.tree });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^card: landed ${sha.slice(0, 12)} onto origin/master\\n`));
  assert.equal(git(n.origin, 'rev-parse', 'master'), sha, 'the node pushed');
  // The check-in before the deploy: deploy-self restarts the daemon that records it.
  assert.deepEqual(daemon.requests.map((entry) => entry.url), ['/api/registry', '/api/registry', '/api/deploy-self']);
  assert.deepEqual(daemon.requests[0].body.args, ['card']);
  assert.deepEqual(daemon.requests[2].body, { sha, project: 'keep-tool' });
  assert.equal(daemon.requests[2].headers['x-keep-node-token'], 'aws1-secret');
  const checkin = daemon.requests[1].body;
  assert.equal(checkin.command, 'checkin');
  assert.deepEqual(checkin.args, ['card', '--commit', sha, '-m', 'Landed wt/land onto master.']);
  assert.equal(checkin.session, 'sess-aws1');
  assert.match(result.stderr, /wt: fast-forwarded main:\/srv\/keep-tool to /);
  assert.match(result.stderr, /wt: restarting the daemon on main/);
  assert.equal(git(n.live, 'rev-parse', 'HEAD'), git(n.live, 'rev-parse', 'origin/master~1'),
    'the node\'s own checkout is not the daemon\'s and is left alone');
});

test('keep land on a node refuses on the daemon\'s facts and reports a refused deploy as a skip', async (t) => {
  const n = nodeWorktree(t);
  const facts = { id: 'card', grants: [], records: [], obligations: [], optOut: 'watch/autoland.json has enabled: false' };
  const daemon = await stubDaemon(t, ({ url, body }) => {
    if (url === '/api/deploy-self') return { status: 409, body: { ok: false, error: 'has uncommitted changes', checkout: '/srv/keep-tool' } };
    if (body.command === 'land-facts') return { status: 200, body: { status: 0, stdout: JSON.stringify(facts), stderr: '' } };
    return { status: 200, body: { status: 1, stdout: '', stderr: 'keep: no such card\n' } };
  });
  const env = { ...n.env, KEEP_DAEMON_URL: daemon.url };
  const refused = await runKeep(['land', 'card'], { env, cwd: n.tree });
  assert.equal(refused.status, 3);
  assert.equal(refused.stderr, 'keep: not allowed: no land grant, and auto-land is off: watch/autoland.json has enabled: false\n');
  assert.equal(daemon.requests.length, 1);

  facts.grants = ['land'];
  const landed = await runKeep(['land', 'card'], { env, cwd: n.tree });
  assert.equal(landed.status, 0, landed.stderr);
  assert.match(landed.stderr, /wt: main:\/srv\/keep-tool: has uncommitted changes; left it alone — it is still running the old code/);
  assert.match(landed.stderr, /keep: landed [0-9a-f]{40} but the check-in failed: keep: no such card/);

  // A land-facts refusal from the daemon is the command's own output.
  const missing = await stubDaemon(t, () => ({ status: 200, body: { status: 1, stdout: '', stderr: 'keep: no card "card"\n' } }));
  const gone = await runKeep(['land', 'card'], { env: { ...env, KEEP_DAEMON_URL: missing.url }, cwd: n.tree });
  assert.equal(gone.status, 1);
  assert.equal(gone.stderr, 'keep: no card "card"\n');
});
