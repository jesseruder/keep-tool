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
      assert.deepEqual(fs.readdirSync(path.join(fleet.aws1ConfigDir, '.keep-move')), ['provenance'],
        'the finished transaction is gone from aws1; its provenance stays');
      assert.ok(fs.existsSync(path.join(fleet.aws1ConfigDir, '.keep-move', 'provenance', `${SID}.json`)));
      await assert.rejects(require('./artifact-transport.js').localArtifacts(fleet.account, { accounts: () => [fleet.account] }).abort('provenance'),
        (error) => error.code === 'artifacts-invalid', 'the provenance directory is never a transaction');

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
      assert.deepEqual(fs.readdirSync(path.join(fleet.configDir, '.keep-move')), ['provenance'],
        'the transaction that replaced main\'s old copy is gone, backups with it');
      assert.ok(events.find((event) => event[0] === 'stopped')[2] <= events.find((event) => event[0] === 'started')[2]);
      assert.equal(fs.existsSync(path.join(mirror, `${SID}.jsonl`)), false, 'the daemon\'s mirror of aws1 is gone');
      assert.equal(fs.existsSync(path.join(mirror, `${SID}.json`)), false);
      assert.equal(fs.existsSync(cursor), false, 'aws1 dropped its hook cursor');
      assert.equal(require('./session-move.js').inFlight(fleet.registry, SID), null);

      // A source that gains bytes after the copy is not given up: nothing flips, and
      // the way on is an abandon and a fresh move.
      const realTransfer = serve.sessionMoveDeps(deps).transfer;
      moveDeps.transfer = async (record) => {
        const carried = await realTransfer(record);
        fs.appendFileSync(path.join(fleet.configDir, 'projects', '-work-project', `${SID}.jsonl`), line({ type: 'user', message: { content: 'late' } }));
        return carried;
      };
      let changedId;
      await assert.rejects(serve.moveSession({ sessionId: SID, node: 'aws1' }, deps), (error) => {
        changedId = error.extra.id;
        return /source changed since the copy; nothing was flipped or launched \(main: projects\/-work-project\/sess-node-move.jsonl differs\)/.test(error.message);
      });
      assert.equal(accounts.sessionNode(SID, { root: fleet.registry }), 'main');
      assert.equal((await serve.moveSession({ abandon: changedId }, deps)).status, 'abandoned');
      delete moveDeps.transfer;
      source = { node: 'main', pane: await spawn('main') };
      const fresh = await serve.moveSession({ sessionId: SID, node: 'aws1' }, deps);
      assert.equal(fresh.status, 'done', fresh.message);
      assert.deepEqual(digestsOf(fleet.aws1ConfigDir), digestsOf(fleet.configDir), 'the fresh move carried the late bytes');
      assert.match(fs.readFileSync(path.join(fleet.aws1ConfigDir, 'projects', '-work-project', `${SID}.jsonl`), 'utf8'), /late/);

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

test('the target is asked for the account and for the launch before anything stops', async (t) => {
  await withTwoNodeFleet(t, async (fleet) => {
    await serve.closeHostClient();
    try {
      const transcript = path.join(fleet.configDir, 'projects', '-work-project', `${SID}.jsonl`);
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      fs.writeFileSync(transcript, '{"type":"user"}\n');
      accounts.pinSession(SID, 'claude', fleet.accountId, { root: fleet.registry, node: 'main' });
      const stopped = [];
      const deps = (moveNodeAccount) => ({
        root: fleet.registry, connectHost: connect, moveNodeAccount,
        moveDeps: {
          inspect: async () => ({ agent: 'claude', from: 'main', account: accounts.get(fleet.accountId),
            session: { id: SID, kind: 'claude', endedTurn: true, project: fleet.project }, pane: null, cwd: fleet.project, model: '', bypass: true }),
          stop: async () => { stopped.push('stop'); },
        },
      });
      const onAws1 = (account) => (node, local) => (node === 'aws1' ? account : local);

      // An account aws1's own configuration does not name.
      await assert.rejects(serve.moveSession({ sessionId: SID, node: 'aws1' }, deps(onAws1({ ...fleet.aws1Account, id: 'claude-ghost' }))),
        (error) => error.status === 409 && /^aws1 cannot take claude-node: claude-ghost is not a claude account on this node/.test(error.message));
      // An account whose shared setup aws1 cannot derive a launch from.
      fs.writeFileSync(path.join(fleet.aws1Home, 'state.json'), '{ not json');
      fs.writeFileSync(path.join(fleet.aws1ConfigDir, '.keep-shared-setup.json'), JSON.stringify({
        version: 1, sourceConfigDir: fleet.aws1ConfigDir, originStateFile: path.join(fleet.aws1Home, 'state.json') }));
      await assert.rejects(serve.moveSession({ sessionId: SID, node: 'aws1' }, deps(onAws1(fleet.aws1Account))),
        (error) => error.status === 409 && /^aws1 could not launch claude-node: account shared setup is unavailable: invalid JSON/.test(error.message));

      assert.deepEqual(stopped, [], 'nothing was stopped');
      assert.equal(fs.existsSync(path.join(fleet.registry, '.keep', 'session-moves')), false, 'nothing was journalled');
      assert.equal(fs.existsSync(path.join(fleet.aws1ConfigDir, 'projects')), false, 'nothing was written on aws1');
      assert.equal(accounts.sessionNode(SID, { root: fleet.registry }), 'main');
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

test('the target is found running by its live pane or by its own process table, and unproven when that table is unreadable', async () => {
  const record = { id: `mv-${'d'.repeat(24)}`, sessionId: SID, from: 'aws1', to: 'main', accountId: 'claude-a' };
  const idle = '11 10 ttys001 Tue Sep  8 10:00:00 2026 /bin/zsh';
  const state = (deps) => serve.sessionMoveDeps({ daemonNode: 'main', listHostPanes: async () => [], psTable: idle, ...deps }).targetState(record);
  assert.deepEqual(await state({}), { running: false, pane: null, agent: false });
  const pane = { id: 'p4', alive: true, meta: { sessionId: SID }, node: 'main' };
  assert.deepEqual(await state({ listHostPanes: async () => [pane] }), { running: true, pane: 'p4', agent: false });
  assert.equal((await state({ listHostPanes: async () => [{ ...pane, alive: false }] })).running, false, 'a dead pane runs nothing');
  assert.equal((await state({ listHostPanes: async () => [{ ...pane, id: 'p4@aws1', node: 'aws1' }] })).running, false, 'a pane on the other node is not the target');
  assert.deepEqual(await state({ psTable: `${idle}\n12 10 ttys002 Tue Sep  8 10:00:00 2026 /test/claude --resume ${SID}` }),
    { running: true, pane: null, agent: true });
  await assert.rejects(state({ psTable: '' }), /process table on main could not be read/);
  await assert.rejects(state({ listHostPanes: async () => null }), /did not list their panes/);
});

test('the abandon\'s flip back names the source in the location record again', () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'keep-move-back-'));
  try {
    const config = path.join(root, 'config.json');
    fs.mkdirSync(path.join(root, 'claude'));
    fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [{ id: 'claude-a', label: 'Claude A', agent: 'claude', configDir: path.join(root, 'claude') }], defaultAccounts: { claude: 'claude-a' } }));
    const env = { ...process.env, KEEP_CONFIG: config };
    delete env.CLAUDE_CODE_SESSION_ID;
    accounts.pinSession(SID, 'claude', 'claude-a', { root, env, node: 'main' });
    accounts.pinSession(SID, 'claude', 'claude-a', { root, env, node: 'aws1', transferNode: true });
    serve.sessionMoveDeps({ root, env, daemonNode: 'main' }).pinBack({ sessionId: SID, accountId: 'claude-a', from: 'main', to: 'aws1' });
    assert.equal(accounts.sessionNode(SID, { root, env }), 'main');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the move relinks the card\'s entry for the session in place, through relinkSessionNode', () => {
  const keep = require('./keep-core.js');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'keep-move-relink-'));
  try {
    fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
    const task = keep.parseTask(keep.serializeTask({ id: 'moving-card', fm: { title: 'x', status: 'active', kind: 'task', tags: ['personal'],
      project: '', created: '2026-09-21', updated: '2026-09-21T08:00' }, body: 'x\n' }), 'moving-card');
    task.fm.sessions = [{ id: SID, agent: 'claude', at: '2026-09-21T08:00' }, { id: 'sid-other', agent: 'claude', at: '2026-09-21T09:00' }];
    fs.writeFileSync(path.join(root, 'tasks', 'moving-card.md'), keep.serializeTask(task));
    const calls = [];
    const linked = serve.sessionMoveDeps({ root, daemonNode: 'main', relinkSessionNode: (...args) => calls.push(args),
      linkLaunchedSession: () => assert.fail('a move never re-claims the card') })
      .relink({ sessionId: SID, to: 'aws1' });
    assert.equal(linked, 'moving-card');
    assert.deepEqual(calls, [['moving-card', SID, 'aws1', { root }]]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a restart queued for the session refuses the move before anything stops', async () => {
  const stopped = [];
  const w = wiredMove({ moveDeps: { stop: async () => { stopped.push('stop'); } } });
  try {
    const file = path.join(w.root, '.keep', 'session-restarts.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entry = (sessionId, status) => ({ sessionId, pane: 'p1', pid: 42, mode: 'idle', status, at: Date.now() });
    // Another session's restart, and this one's finished restart, are no obstacle to a dry run.
    fs.writeFileSync(file, JSON.stringify([entry('sess-other', 'queued'), entry(SID, 'done')]));
    assert.equal((await serve.moveSession({ sessionId: SID, node: 'aws1', dry: true }, w.deps)).dry, true);
    for (const status of ['queued', 'restarting', 'recovery-needed']) {
      fs.writeFileSync(file, JSON.stringify([entry(SID, status)]));
      await assert.rejects(serve.moveSession({ sessionId: SID, node: 'aws1' }, w.deps),
        (error) => error.status === 409 && error.extra.reason === 'busy' && new RegExp(`busy: a restart is ${status} \\(idle\\)`).test(error.message), status);
    }
    assert.deepEqual(stopped, []);
    assert.equal(fs.existsSync(path.join(w.root, '.keep', 'session-moves')), false);
  } finally { w.cleanup(); }
});

test('the cleanup removes the source pane only while it is exited and no agent runs the session there', async () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'keep-move-cleanup-'));
  try {
    const config = path.join(root, 'config.json');
    fs.mkdirSync(path.join(root, 'claude'));
    fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [{ id: 'claude-a', label: 'Claude A', agent: 'claude', configDir: path.join(root, 'claude') }],
      defaultAccounts: { claude: 'claude-a' } }));
    const env = { ...process.env, KEEP_CONFIG: config };
    delete env.CLAUDE_CODE_SESSION_ID;
    const idle = '11 10 ttys001 Tue Sep  8 10:00:00 2026 /bin/zsh';
    const record = { id: `mv-${'e'.repeat(24)}`, sessionId: SID, from: 'main', to: 'aws1', accountId: 'claude-a', pane: { id: 'p1', pid: 42 } };
    const cleanup = async (pane, psTable) => {
      const removed = [];
      const warnings = await serve.sessionMoveDeps({
        root, env, daemonNode: 'main', psTable, listHostPanes: async () => (pane ? [pane] : []),
        hostRequest: async (type, params) => { if (type === 'remove') removed.push(params.pane); return {}; },
      }).cleanup(record);
      return { removed, warnings: warnings.join('\n') };
    };
    const exited = { id: 'p1', alive: false, meta: { sessionId: SID } };
    assert.deepEqual((await cleanup(exited, idle)).removed, ['p1']);
    const revived = await cleanup({ ...exited, alive: true }, idle);
    assert.deepEqual(revived.removed, [], 'a pane running again is never removed');
    assert.match(revived.warnings, /the pane p1 on main is running again; it was left as it is/);
    const agent = await cleanup(exited, `${idle}\n12 10 ttys002 Tue Sep  8 10:00:00 2026 /test/claude --resume ${SID}`);
    assert.deepEqual(agent.removed, [], 'nor while an agent runs the session there');
    assert.match(agent.warnings, /was not removed: an agent process still owns/);
    const unread = await cleanup(exited, '');
    assert.deepEqual(unread.removed, []);
    assert.match(unread.warnings, /was not removed: the process table on main could not be read/);

    // The source's copy is released only while it is exactly what was carried.
    const rel = `projects/-work-project/${SID}.jsonl`;
    fs.mkdirSync(path.join(root, 'claude', 'projects', '-work-project'), { recursive: true });
    fs.writeFileSync(path.join(root, 'claude', ...rel.split('/')), '{"type":"user"}\n');
    const provenance = path.join(root, 'claude', '.keep-move', 'provenance', `${SID}.json`);
    const withManifest = (digest) => serve.sessionMoveDeps({ root, env, daemonNode: 'main', psTable: idle, listHostPanes: async () => [],
      hostRequest: async () => ({}) }).cleanup({ ...record, pane: null, manifest: { digests: { [rel]: digest } } });
    const changed = (await withManifest('0'.repeat(64))).join('\n');
    assert.match(changed, /source changed since the copy \(main: projects\/-work-project\/sess-node-move.jsonl differs\); its copy was not released/);
    assert.equal(fs.existsSync(provenance), false);
    await withManifest(sha256(Buffer.from('{"type":"user"}\n')));
    assert.equal(fs.existsSync(provenance), true, 'an unchanged source is released');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an abandon back drops what the target kept for the session: its hook state and the daemon\'s mirror of it', async () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'keep-move-drop-'));
  try {
    const config = path.join(root, 'config.json');
    fs.mkdirSync(path.join(root, 'claude'));
    fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [{ id: 'claude-a', label: 'Claude A', agent: 'claude', configDir: path.join(root, 'claude') }],
      defaultAccounts: { claude: 'claude-a' } }));
    const env = { ...process.env, KEEP_CONFIG: config };
    delete env.CLAUDE_CODE_SESSION_ID;
    const mirror = require('./transcript-mirror.js').paths(root, 'aws1', SID);
    fs.mkdirSync(path.dirname(mirror.file), { recursive: true });
    fs.writeFileSync(mirror.file, 'mirror');
    fs.writeFileSync(mirror.sidecar, '{}');
    const asked = [];
    const hostRequest = async (type, params, options) => {
      if (type === 'hello') return { artifacts: 1, transcript: 1 };
      asked.push([type, params.op, params.sessionId, options.node]);
      return { dropped: true };
    };
    const record = { id: `mv-${'f'.repeat(24)}`, sessionId: SID, from: 'main', to: 'aws1', accountId: 'claude-a' };
    const warnings = await serve.sessionMoveDeps({ root, env, daemonNode: 'main', hostRequest }).dropTarget(record);
    assert.deepEqual(warnings, []);
    assert.deepEqual(asked, [['artifacts', 'drop-session', SID, 'aws1']]);
    assert.equal(fs.existsSync(mirror.file), false);
    assert.equal(fs.existsSync(mirror.sidecar), false);
    // A node that does not answer is a warning, not a failure; the daemon node keeps nothing to drop.
    const failing = await serve.sessionMoveDeps({ root, env, daemonNode: 'main', hostRequest: async (type) => {
      if (type === 'hello') return { artifacts: 1, transcript: 1 };
      throw new Error('aws1 did not answer');
    } }).dropTarget(record);
    assert.match(failing.join('\n'), /aws1 did not drop its hook state: aws1 did not answer/);
    assert.deepEqual(await serve.sessionMoveDeps({ root, env, daemonNode: 'main', hostRequest: async () => assert.fail('nothing to ask') })
      .dropTarget({ ...record, from: 'aws1', to: 'main' }), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
