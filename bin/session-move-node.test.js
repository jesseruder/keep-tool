'use strict';
// keep move end to end on two real hosts, each with a home of its own: the session's
// files land on the other machine byte for byte, the location record flips, the source
// is stopped before the target starts, and the origin is cleaned up; then back again.
// The agent is a plain process in a real pane (no Claude here), so the stop and the
// start are driven through the hosts directly and the target's session-start is the
// pane record the hook route writes; everything else is serve.js's own wiring.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const serve = require('./serve.js');
const accounts = require('./accounts.js');
const { connect } = require('./hostclient.js');
const { withTwoNodeFleet } = require('./fixtures/two-node-hosts.js');

const SID = 'sess-node-move';
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function digestsOf(configDir) {
  const out = {};
  const walk = (dir, rel) => {
    let names = [];
    try { names = fs.readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      const full = path.join(dir, name);
      const next = `${rel}/${name}`;
      if (fs.statSync(full).isDirectory()) walk(full, next);
      else if (next.includes(SID)) out[next] = sha256(fs.readFileSync(full));
    }
  };
  walk(path.join(configDir, 'projects'), 'projects');
  walk(path.join(configDir, 'file-history'), 'file-history');
  return out;
}

async function onNode(node, work) {
  const client = await connect(node === 'main' ? {} : { node });
  try { return await work(client); } finally { client.close(); }
}

async function waitDead(node, paneId) {
  for (let i = 0; i < 100; i += 1) {
    const pane = await onNode(node, async (client) => (await client.request('get', { pane: paneId })).pane);
    if (!pane.alive) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`pane ${paneId} on ${node} did not exit`);
}

test('a session moves to aws1 and back, its bytes proven on each side, never running on both', async (t) => {
  await withTwoNodeFleet(t, async (fleet) => {
    await serve.closeHostClient();
    const events = [];
    try {
      const put = (configDir, rel, bytes) => {
        const file = path.join(configDir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
      };
      const line = (value) => `${JSON.stringify(value)}\n`;
      put(fleet.configDir, `projects/-work-project/${SID}.jsonl`, line({ type: 'user', message: { content: 'start' } })
        + crypto.randomBytes(6000).toString('hex') + '\n');
      put(fleet.configDir, `projects/-work-project/${SID}/subagents/agent-a.jsonl`, line({ type: 'assistant' }));
      put(fleet.configDir, `file-history/${SID}/abc@v1`, 'body');
      accounts.pinSession(SID, 'claude', fleet.accountId, { root: fleet.registry, node: 'main' });

      const spawn = (node) => onNode(node, async (client) => (await client.request('spawn', {
        cmd: '/bin/sh', args: ['-c', 'sleep 300'], cwd: fleet.project,
        meta: { agent: 'claude', sessionId: SID, accountId: fleet.accountId },
      })).pane);
      const qualified = (node, id) => (node === 'main' ? id : `${id}@${node}`);
      let source = { node: 'main', pane: await spawn('main') };

      const moveDeps = {
        // The session as the preflight sees it: idle, in its pane, on the node the
        // record names (the location is read for real).
        inspect: async () => {
          const location = accounts.sessionLocation(SID, { root: fleet.registry });
          return { agent: 'claude', from: location.node, account: accounts.get(fleet.accountId),
            session: { id: SID, kind: 'claude', endedTurn: true, project: fleet.project },
            pane: { id: qualified(source.node, source.pane.id), pid: source.pane.pid, createdAt: source.pane.createdAt, node: source.node },
            cwd: fleet.project, model: '', bypass: true };
        },
        stop: async (record) => {
          const id = source.pane.id;
          await onNode(record.from, (client) => client.request('kill', { pane: id, expectedPid: source.pane.pid, signal: 'SIGKILL' }));
          await waitDead(record.from, id);
          events.push(['stopped', record.from, Date.now()]);
        },
        open: async (record) => {
          const sourcePane = await onNode(record.from, async (client) => (await client.request('get', { pane: source.pane.id })).pane);
          assert.equal(sourcePane.alive, false, 'the source is not running when the target starts');
          assert.equal(accounts.sessionNode(SID, { root: fleet.registry }), record.to, 'the record names the target before it starts');
          const pane = await spawn(record.to);
          events.push(['started', record.to, Date.now()]);
          // What the target's session-start writes on the daemon (the hook route).
          fs.mkdirSync(path.join(fleet.registry, '.keep', 'panes'), { recursive: true });
          fs.writeFileSync(path.join(fleet.registry, '.keep', 'panes', `${SID}.json`), JSON.stringify({
            pane: qualified(record.to, pane.id), ...(record.to === 'main' ? {} : { node: record.to }),
            startedAt: Date.now(), accountId: fleet.accountId, cwd: fleet.project,
          }));
          source = { node: record.to, pane };
          return { pane: qualified(record.to, pane.id), pid: pane.pid, createdAt: pane.createdAt };
        },
        relink: async (record) => { events.push(['relinked', record.to]); return null; },
      };
      const deps = {
        root: fleet.registry, connectHost: connect,
        moveNodeAccount: (node, account) => (node === 'aws1' ? fleet.aws1Account : account),
        moveDeps,
      };

      // A dry run: the plan, and nothing touched.
      const plan = await serve.moveSession({ sessionId: SID, node: 'aws1', dry: true }, deps);
      assert.deepEqual([plan.from, plan.to, plan.cwd], ['main', 'aws1', fleet.project]);
      assert.deepEqual(digestsOf(fleet.aws1ConfigDir), {});

      const before = digestsOf(fleet.configDir);
      assert.equal(Object.keys(before).length, 3);
      const firstPane = source.pane.id;
      const there = await serve.moveSession({ sessionId: SID, node: 'aws1' }, deps);
      assert.equal(there.status, 'done', there.message);
      assert.deepEqual(digestsOf(fleet.aws1ConfigDir), before, 'aws1 holds exactly the bytes main had');
      assert.equal(accounts.sessionNode(SID, { root: fleet.registry }), 'aws1');
      const stopped = events.find((event) => event[0] === 'stopped');
      const started = events.find((event) => event[0] === 'started');
      assert.ok(stopped[2] <= started[2], 'stopped before started');
      await assert.rejects(onNode('main', (client) => client.request('get', { pane: firstPane })), /no such pane/,
        'the stopped pane on main is removed');
      assert.ok(fs.existsSync(path.join(fleet.configDir, '.keep-move', 'provenance', `${SID}.json`)),
        'main\'s copy is released for a later move back');

      // The session works on aws1, and aws1 has hook state and a daemon mirror for it.
      fs.appendFileSync(path.join(fleet.aws1ConfigDir, 'projects', '-work-project', `${SID}.jsonl`), line({ type: 'user', message: { content: 'on aws1' } }));
      const mirror = path.join(fleet.registry, '.keep', 'transcript-mirrors', 'aws1');
      fs.mkdirSync(mirror, { recursive: true });
      fs.writeFileSync(path.join(mirror, `${SID}.jsonl`), 'mirror');
      fs.writeFileSync(path.join(mirror, `${SID}.json`), '{}');
      const cursor = path.join(fleet.aws1Home, '.keep-node', 'mirror', `${SID}.json`);
      fs.mkdirSync(path.dirname(cursor), { recursive: true });
      fs.writeFileSync(cursor, '{}');

      // Back: a live session leaves a node only with Owner's force for now.
      await assert.rejects(serve.moveSession({ sessionId: SID, node: 'main' }, deps), /--force/);
      events.length = 0;
      const back = await serve.moveSession({ sessionId: SID, node: 'main', ownerForce: true }, deps);
      assert.equal(back.status, 'done', back.message);
      assert.deepEqual(digestsOf(fleet.configDir), digestsOf(fleet.aws1ConfigDir), 'main holds what aws1 wrote');
      assert.match(fs.readFileSync(path.join(fleet.configDir, 'projects', '-work-project', `${SID}.jsonl`), 'utf8'), /on aws1/);
      assert.equal(accounts.sessionNode(SID, { root: fleet.registry }), 'main');
      assert.ok(events.find((event) => event[0] === 'stopped')[2] <= events.find((event) => event[0] === 'started')[2]);
      assert.equal(fs.existsSync(path.join(mirror, `${SID}.jsonl`)), false, 'the daemon\'s mirror of aws1 is gone');
      assert.equal(fs.existsSync(path.join(mirror, `${SID}.json`)), false);
      assert.equal(fs.existsSync(cursor), false, 'aws1 dropped its hook cursor');
      assert.equal(require('./session-move.js').inFlight(fleet.registry, SID), null);

      // Nothing else may resume a session while a move owns it.
      const stuck = { version: 1, id: `mv-${'c'.repeat(24)}`, sessionId: SID, from: 'main', to: 'aws1', status: 'copying', createdAt: Date.now() };
      fs.writeFileSync(path.join(fleet.registry, '.keep', 'session-moves', `${stuck.id}.json`), JSON.stringify(stuck));
      await assert.rejects(serve.openSession({ sessionId: SID }, { root: fleet.registry, connectHost: connect }),
        (error) => error.status === 409 && /is being moved from main to aws1/.test(error.message));
    } finally {
      await serve.closeHostClient();
    }
  }, { nodeHome: true });
});

test('keep move on an install with one node refuses and changes nothing', async () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'keep-move-single-'));
  try {
    await assert.rejects(serve.moveSession({ sessionId: SID, node: 'aws1' }, { root, placementNodes: ['main'] }),
      (error) => error.status === 409 && /no other node is configured/.test(error.message));
    assert.equal(fs.existsSync(path.join(root, '.keep', 'session-moves')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// serve.js's own wiring of the move with the machines faked: every preflight answer
// is injected, and the steps after it are serve.js's real ones unless a test says
// otherwise.
function wiredMove(options = {}) {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'keep-move-wired-'));
  const steps = [];
  const moveDeps = {
    nodeNames: () => ['main', 'aws1'],
    inspect: async () => ({ agent: 'claude', from: 'main', account: { id: 'claude-a', agent: 'claude', configDir: '/nowhere' },
      session: { id: SID, kind: 'claude', endedTurn: true, project: '/work/project' }, pane: null, cwd: '/work/project', model: '', bypass: false }),
    requireNode: async () => {},
    cwdExists: async () => true,
    targetReady: async () => {},
    pendingDelivery: async () => false,
    transfer: async () => { steps.push('transfer'); throw new Error('nothing is carried in this test'); },
    ...(options.moveDeps || {}),
  };
  return {
    root, steps,
    deps: { root, daemonNode: 'main', listHostPanes: async () => [], ...(options.deps || {}), moveDeps },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('a process table the daemon node cannot read refuses the move before anything is carried', async () => {
  const w = wiredMove({ deps: { agentProcessRows: async () => { throw new Error('ps timed out'); } } });
  try {
    await assert.rejects(serve.moveSession({ sessionId: SID, node: 'aws1' }, w.deps),
      (error) => error.extra.status === 'recovery-needed' && error.extra.phase === 'stopping' && error.extra.holder === 'main'
        && /process table on main could not be read/.test(error.message));
    assert.deepEqual(w.steps, [], 'nothing was carried');
    // An empty answer is no answer either.
    const empty = wiredMove({ deps: { psTable: '' } });
    try {
      await assert.rejects(serve.moveSession({ sessionId: SID, node: 'aws1' }, empty.deps), /process table on main could not be read/);
      assert.deepEqual(empty.steps, []);
    } finally { empty.cleanup(); }
  } finally { w.cleanup(); }
});
