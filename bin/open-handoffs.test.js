'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const handoffs = require('./open-handoffs.js');

const CLI = path.join(__dirname, 'keep.js');

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-open-handoffs-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a handoff record is kept per requester and card, read back fresh, and gone once cleared or expired', (t) => {
  const root = tempRoot(t);
  let clock = 1_800_000_000_000;
  const now = () => clock;
  handoffs.record(root, { requester: 'req-1', card: 'card-a', pane: 'p1' }, { now });
  handoffs.record(root, { requester: 'req-1', card: 'card-b', pane: 'p2@aws1' }, { now });
  handoffs.record(root, { requester: 'req-2', card: 'card-a', pane: 'p3' }, { now });
  assert.deepEqual(handoffs.pendingFor(root, 'req-1', { now }).map((entry) => [entry.card, entry.pane]).sort(),
    [['card-a', 'p1'], ['card-b', 'p2@aws1']]);
  assert.equal(handoffs.clear(root, 'req-1', 'card-a'), true);
  assert.equal(handoffs.clear(root, 'req-1', 'card-a'), false);
  assert.deepEqual(handoffs.pendingFor(root, 'req-1', { now }).map((entry) => entry.card), ['card-b']);
  clock += handoffs.RECORD_TTL_MS + 1;
  assert.deepEqual(handoffs.pendingFor(root, 'req-1', { now }), [], 'expired');
  assert.equal(fs.readdirSync(path.join(root, '.keep', 'open-handoffs')).some((name) => name.startsWith('req-1--')), false, 'and removed');
  assert.deepEqual(handoffs.pendingFor(tempRoot(t), 'req-1'), [], 'nothing recorded at all');
  assert.throws(() => handoffs.record(root, { requester: '../x', card: 'card-a', pane: 'p1' }));
  assert.throws(() => handoffs.record(root, { requester: 'req-1', card: '../card', pane: 'p1' }));
});

test('only a live pane that still names the requester and the card keeps a handoff in flight', async (t) => {
  const root = tempRoot(t);
  const panes = {
    p1: { alive: true, meta: { requester: 'req-1', card: 'card-a', sessionId: 'launched-1' } },
    p2: { alive: false, meta: { requester: 'req-1', card: 'card-b' } },
    p3: { alive: true, meta: { requester: 'someone-else', card: 'card-c' } },
    p5: { alive: true, meta: { requester: 'req-1', card: 'card-e' } },
  };
  handoffs.record(root, { requester: 'req-1', card: 'card-f', pane: 'p6' });
  for (const [pane, card] of [['p1', 'card-a'], ['p2', 'card-b'], ['p3', 'card-c'], ['p4@aws1', 'card-d'], ['p5', 'card-e']]) {
    handoffs.record(root, { requester: 'req-1', card, pane });
  }
  const asked = [];
  const env = { KEEP_DAEMON_NODE: 'main', KEEP_NODE_NAME: 'main' };
  const connectHost = async (node) => {
    if (node === 'aws1') throw new Error('aws1 is not answering');
    return { request: async (type, params) => {
      asked.push([node, type, params.pane]);
      if (!panes[params.pane]) throw new Error('no such pane');
      return { pane: panes[params.pane] };
    }, close() {} };
  };
  const live = await handoffs.liveHandoffs(root, 'req-1', { env, connectHost });
  assert.deepEqual(live.sort((a, b) => a.card.localeCompare(b.card)),
    [{ card: 'card-a', sessionId: 'launched-1' }, { card: 'card-d', sessionId: null }, { card: 'card-e', sessionId: null }]);
  assert.deepEqual(handoffs.pendingFor(root, 'req-1').map((entry) => entry.card).sort(), ['card-a', 'card-d', 'card-e'],
    'a gone pane, or one that names someone else, is removed; an unreachable host keeps its record');
  assert.deepEqual(await handoffs.liveHandoffs(root, 'nobody', { env, connectHost }), []);

  // A card is handed over while its launched session is not on it yet.
  const card = (id, sessions = []) => ({ id, fm: { sessions: sessions.map((session) => ({ id: session })) } });
  assert.equal(handoffs.handingOver(card('card-a', ['req-1']), live), true);
  assert.equal(handoffs.handingOver(card('card-a', ['req-1', 'launched-1']), live), false, 'linked: over');
  assert.equal(handoffs.handingOver(card('card-e', ['req-1']), live), true, 'no session named yet');
  assert.equal(handoffs.handingOver(card('card-z', ['req-1']), live), false);
  assert.equal(handoffs.handingOver(null, live), false);
  assert.equal(handoffs.handingOver(card('card-a'), []), false);
});

test('a TCP node that accepts and never answers its hello counts as in flight, well inside 2 s', async (t) => {
  const net = require('node:net');
  const root = tempRoot(t);
  const sockets = [];
  const silent = net.createServer((socket) => { sockets.push(socket); });
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise((resolve) => silent.close(resolve)); });
  const tokenFile = path.join(root, 'aws1.token');
  fs.writeFileSync(tokenFile, `${'a'.repeat(64)}\n`, { mode: 0o600 });
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, daemonNode: 'main',
    nodes: { main: {}, aws1: { transport: 'tcp', address: `127.0.0.1:${silent.address().port}`, tokenFile } } }));
  const env = { HOME: root, KEEP_CONFIG: configFile, KEEP_DAEMON_NODE: 'main', KEEP_NODE_NAME: 'main' };
  handoffs.record(root, { requester: 'req-1', card: 'card-a', pane: 'p4@aws1' });
  const began = Date.now();
  const live = await handoffs.liveHandoffs(root, 'req-1', { env });
  const took = Date.now() - began;
  assert.deepEqual(live, [{ card: 'card-a', sessionId: null }], 'a host that cannot be asked keeps the handoff in flight');
  assert.ok(sockets.length >= 1, 'the node accepted the connection');
  assert.ok(took < 2000, `the ask gave up at its own deadlines (${took} ms), not the 8 s hello default`);
  assert.deepEqual(handoffs.pendingFor(root, 'req-1').map((entry) => entry.card), ['card-a'], 'and the record is kept');
});

// ---------- the requester's Stop hook, through the real CLI and a real host ----------

function registry(t) {
  const root = tempRoot(t);
  for (const dir of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' };
  for (const key of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'KEEP_PANE', 'KEEP_CONFIG']) delete env[key];
  assert.equal(spawnSync('git', ['init', '-q', root], { env }).status, 0);
  spawnSync('git', ['-C', root, 'config', 'user.name', 'Keep Test'], { env });
  spawnSync('git', ['-C', root, 'config', 'user.email', 'keep@example.test'], { env });
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(root, 'tasks', 'handed-card.md'), [
    '---', 'title: Handed card', 'status: active', 'kind: task', `project: ${project}`,
    'sessions:', '  - id: requester-session', '    agent: claude', '    at: 2026-09-02T12:00',
    'created: 2026-09-02', 'updated: 2026-09-02T12:00', '---',
    '## Plan', '- [ ] First step', '- [ ] Second step', '', '## 2026-09-02 12:00 — created', 'Ready.', '',
  ].join('\n'));
  const transcript = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'mode', mode: 'default' })}\n`
    + `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Opened a session for it.' }] } })}\n`);
  return { root, env, project, transcript };
}

function stop(f, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'hook', 'stop'], {
      cwd: f.project, env: { ...f.env, CLAUDE_CODE_SESSION_ID: 'requester-session', ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify({ session_id: 'requester-session', transcript_path: f.transcript, cwd: f.project }));
  });
}

test('the requester of a card open still in flight is not auto-continued onto that card until the launched session is on it', async (t) => {
  const { createHost } = require('./host.js');
  const { connect } = require('./hostclient.js');
  const f = registry(t);
  const sock = path.join(f.root, 'host.sock');
  const host = createHost({ sock, log: null, node: 'main' });
  await host.listen();
  t.after(() => host.close().catch(() => {}));
  const env = { KEEP_HOST_SOCK: sock, KEEP_DAEMON_NODE: 'main', KEEP_NODE_NAME: 'main' };
  const client = await connect({ sock });
  let paneId;
  try {
    paneId = (await client.request('spawn', { cmd: '/bin/sh', args: ['-c', 'sleep 30'], cwd: f.project,
      meta: { agent: 'codex', card: 'handed-card', requester: 'requester-session' } })).pane.id;
  } finally { client.close(); }
  handoffs.record(f.root, { requester: 'requester-session', card: 'handed-card', pane: paneId });

  const held = await stop(f, env);
  assert.equal(held.status, 0, held.stderr);
  assert.equal(held.stdout, '', 'not continued onto the card being handed over');

  // The launched session registers and is linked: the handoff is over for this card.
  fs.writeFileSync(path.join(f.root, 'tasks', 'handed-card.md'), fs.readFileSync(path.join(f.root, 'tasks', 'handed-card.md'), 'utf8')
    .replace('    at: 2026-09-02T12:00\n', '    at: 2026-09-02T12:00\n  - id: launched-session\n    agent: codex\n    at: 2026-09-02T12:05\n'));
  const binder = await connect({ sock });
  try { await binder.request('meta', { pane: paneId, patch: { sessionId: 'launched-session' } }); } finally { binder.close(); }
  const continued = await stop(f, env);
  assert.equal(continued.status, 0, continued.stderr);
  assert.match(JSON.parse(continued.stdout).reason, /Continue with step 1 of 2/);
});

test('a record whose pane is gone neither holds the requester nor lasts', async (t) => {
  const { createHost } = require('./host.js');
  const f = registry(t);
  const sock = path.join(f.root, 'host.sock');
  const host = createHost({ sock, log: null, node: 'main' });
  await host.listen();
  t.after(() => host.close().catch(() => {}));
  handoffs.record(f.root, { requester: 'requester-session', card: 'handed-card', pane: 'p404' });
  const run = await stop(f, { KEEP_HOST_SOCK: sock, KEEP_DAEMON_NODE: 'main', KEEP_NODE_NAME: 'main' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(JSON.parse(run.stdout).reason, /Continue with step 1 of 2/);
  assert.deepEqual(handoffs.pendingFor(f.root, 'requester-session'), []);
});
