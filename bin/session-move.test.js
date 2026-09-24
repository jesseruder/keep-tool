'use strict';
// The move's state machine (bin/session-move.js) with every machine it touches
// injected: each step's failure leaves the record where the verified bytes are, a
// recovery continues from the step that failed, and the flip happens once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const move = require('./session-move.js');

const SID = 'sess-moving';

// A world of fakes: the location record, the steps each dependency took (in order),
// and a failure to inject at any one of them.
function world(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-session-move-'));
  const steps = [];
  const state = { node: options.from || 'main', pins: 0, fail: { ...(options.fail || {}) } };
  const failing = (name) => {
    if (state.fail[name]) {
      const error = state.fail[name] === true ? new Error(`${name} failed`) : state.fail[name];
      delete state.fail[name];
      throw error;
    }
  };
  const session = { id: SID, kind: 'claude', endedTurn: true, project: '/work/project', ...(options.session || {}) };
  const deps = {
    root,
    daemonNode: 'main',
    now: () => Date.now(),
    nodeNames: async () => options.nodes || ['main', 'aws1'],
    inspect: async (sessionId) => ({
      agent: options.agent || 'claude', from: state.node, session,
      account: { id: 'claude-a', agent: options.agent || 'claude', configDir: '/home/claude-a' },
      pane: options.noPane ? null : { id: state.node === 'main' ? 'p1' : 'p1@aws1', pid: 42, createdAt: 't0', node: state.node },
      cwd: session.project, model: options.model || 'claude-opus-4-1', bypass: true,
      ...(options.inspect || {}), sessionId,
    }),
    requireNode: async (node) => { steps.push(['requireNode', node]); failing('requireNode'); },
    cwdExists: async (node, cwd) => { steps.push(['cwdExists', node, cwd]); return options.cwdMissing !== true; },
    targetReady: async (node, plan) => { steps.push(['targetReady', node, plan.accountId, plan.cwd]); failing('targetReady'); },
    pendingDelivery: async () => options.pendingDelivery === true,
    busy: async () => options.busy || null,
    stop: async (record) => { steps.push(['stop', record.from]); failing('stop'); state.stopped = true; },
    // The source's table read again; `state.revived` is someone starting it by hand.
    requireStopped: async (record) => {
      steps.push(['reprove', record.from]);
      if (state.revived) throw Object.assign(new Error(`an agent process still owns ${SID} on ${record.from}`), { status: 409 });
    },
    transfer: async (record) => {
      steps.push(['transfer', record.from, record.to]);
      assert.equal(state.stopped, true, 'nothing is carried before the source is stopped');
      if (options.reviveAfter === 'transfer') state.revived = true;
      failing('transfer');
      return { files: [{ relPath: `projects/-work-project/${SID}.jsonl`, sha256: 'a'.repeat(64), size: 10 }], bytes: 10,
        landed: [{ relPath: `projects/-work-project/${SID}.jsonl`, sha256: 'a'.repeat(64) }] };
    },
    // Each side's artifacts by digest: what was carried, unless `state.changed[node]`
    // says that side gained or rewrote bytes since.
    digestsOn: async (record, node) => {
      state.listed = [...(state.listed || []), node];
      return { [`projects/-work-project/${SID}.jsonl`]: 'a'.repeat(64), ...((state.changed || {})[node] || {}) };
    },
    location: async () => ({ node: state.node, agent: 'claude', accountId: 'claude-a' }),
    pin: async (record) => { steps.push(['pin', record.to]); failing('pin'); state.node = record.to; state.pins += 1; },
    open: async (record) => {
      steps.push(['open', record.to]);
      assert.equal(state.node, record.to, 'the target starts only once the record names it');
      failing('open');
      state.launches = (state.launches || 0) + 1;
      state.targetPane = `p${8 + state.launches}${record.to === 'main' ? '' : `@${record.to}`}`;
      return { pane: state.targetPane, pid: 99, createdAt: 't1' };
    },
    // What runs the session on the target now; `state.targetPane` is its live pane.
    targetState: async () => {
      steps.push(['target']);
      failing('target');
      if (state.lingering) return { running: true, pane: state.lingering, agent: false, unproven: true };
      return { running: Boolean(state.targetPane), pane: state.targetPane || null };
    },
    pinBack: async (record) => { steps.push(['pinBack', record.from]); failing('pinBack'); state.node = record.from; state.backs = (state.backs || 0) + 1; },
    releaseTarget: async (record) => { steps.push(['release', record.to]); },
    dropTarget: async (record) => { steps.push(['drop', record.to]); return []; },
    waitForPaneRecord: async (record) => {
      steps.push(['wait', record.launch.pane]);
      failing('wait');
      if (state.noStart) return null; // the wait timed out
      return { pane: record.launch.pane, startedAt: Date.now() };
    },
    relink: async () => { steps.push(['relink']); return 'card-1'; },
    cleanup: async (record) => { steps.push(['cleanup', record.from]); return []; },
    abortStage: async (record) => { steps.push(['abort', record.to]); },
  };
  return { root, deps, steps, state, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const names = (steps) => steps.map((step) => step[0]);
const moves = (steps) => names(steps).filter((name) => name !== 'reprove');

test('a move stops the source, carries, flips once, starts the target and verifies it, in that order', async () => {
  const w = world();
  try {
    const result = await move.moveSession({ sessionId: SID, node: 'aws1' }, w.deps);
    assert.equal(result.status, 'done');
    assert.deepEqual(names(w.steps), ['requireNode', 'cwdExists', 'targetReady', 'stop', 'transfer', 'reprove', 'pin', 'reprove', 'open', 'wait', 'relink', 'cleanup'],
      'the source is proven stopped again before the flip and before the launch');
    assert.deepEqual(w.steps.find((step) => step[0] === 'requireNode'), ['requireNode', 'aws1'], 'the node end is asked for the verb');
    assert.equal(w.state.pins, 1);
    const record = move.readMove(w.root, result.id);
    assert.equal(record.status, 'done');
    assert.equal(record.from, 'main');
    assert.equal(record.to, 'aws1');
    assert.equal(record.bypass, true);
    assert.equal(record.model, 'claude-opus-4-1');
    assert.ok(record.stopVerifiedAt <= record.pinnedAt && record.pinnedAt <= record.launchStartedAt);
    assert.equal(record.manifest.files, 1);
    assert.equal(move.inFlight(w.root, SID), null, 'a finished move owns nothing');
  } finally { w.cleanup(); }
});

test('a second move of a session this process is already moving is refused by name (in-flight)', async () => {
  const w = world();
  try {
    // Two requests pass the checks before the preflight together; the second to reach
    // the lock is the one refused.
    const [first, second] = await Promise.allSettled([
      move.moveSession({ sessionId: SID, node: 'aws1' }, w.deps),
      move.moveSession({ sessionId: SID, node: 'aws1' }, w.deps),
    ]);
    assert.equal(first.status, 'fulfilled', first.reason && first.reason.stack);
    assert.equal(first.value.status, 'done');
    assert.equal(second.status, 'rejected');
    assert.equal(second.reason.status, 409);
    assert.equal(second.reason.message, `a move of ${SID} is already running`);
    assert.deepEqual(second.reason.extra, { reason: 'in-flight' });
    assert.equal(w.state.pins, 1, 'one move ran');
  } finally { w.cleanup(); }
});

test('the preflight refuses before anything is stopped', async () => {
  const cases = [
    [{ nodes: ['main'] }, /no other node is configured/],
    [{ from: 'aws1' }, /already on aws1/],
    [{ agent: 'pi' }, /carries Claude and Codex sessions; sess-moving is a pi session/],
    [{ agent: 'codex', inspect: { account: { id: 'claude-a', agent: 'claude', configDir: '/home/claude-a' } } }, /has no Codex account record/],
    [{ cwdMissing: true, session: { project: '/home/u/wt/keep-tool/x' } }, /does not exist on aws1.*worktree: run wt there/],
    [{ pendingDelivery: true }, /still unconfirmed/],
    [{ busy: 'an account handoff is copying (copying-artifacts)' }, /busy: an account handoff/],
    [{ session: { endedTurn: false } }, /is working/],
    [{ model: '<unknown>' }, /model .* cannot be established/],
    [{ fail: { requireNode: Object.assign(new Error('the terminal host on aws1 predates the artifacts verb'), { status: 409 }) } }, /predates/],
    [{ fail: { targetReady: Object.assign(new Error('aws1 cannot take claude-a: claude-a is not a claude account on this node'), { status: 409 }) } },
      /aws1 cannot take claude-a/],
    [{ fail: { targetReady: Object.assign(new Error('aws1 could not launch claude-a: account shared setup is unavailable: invalid JSON'), { status: 409 }) } },
      /could not launch claude-a: account shared setup/],
  ];
  for (const [options, pattern] of cases) {
    const w = world(options);
    try {
      await assert.rejects(move.moveSession({ sessionId: SID, node: options.from === 'aws1' ? 'aws1' : 'aws1' }, w.deps),
        (error) => pattern.test(error.message) && error.status >= 400, String(pattern));
      assert.equal(w.steps.some((step) => ['stop', 'transfer', 'pin', 'open'].includes(step[0])), false, `${pattern}: nothing moved`);
      assert.deepEqual(move.listMoves(w.root), [], `${pattern}: nothing journalled`);
    } finally { w.cleanup(); }
  }
  // A live session on a node leaves only with Owner's forced stop, for now.
  const w = world({ from: 'aws1' });
  try {
    await assert.rejects(move.moveSession({ sessionId: SID, node: 'main' }, w.deps), /only be moved off its node with --force/);
    const forced = await move.moveSession({ sessionId: SID, node: 'main', ownerForce: true }, w.deps);
    assert.equal(forced.status, 'done');
    assert.equal(w.state.node, 'main', 'the reverse direction flips the record back');
  } finally { w.cleanup(); }
  // A working session moves when Owner forces it.
  const busy = world({ session: { endedTurn: false } });
  try { assert.equal((await move.moveSession({ sessionId: SID, node: 'aws1', ownerForce: true }, busy.deps)).status, 'done'); }
  finally { busy.cleanup(); }
});

test('a Codex session passes the same preflight, and its record carries its Codex flags', async () => {
  const seen = {};
  const flags = '--dangerously-bypass-approvals-and-sandbox';
  const w = world({ agent: 'codex', model: 'gpt-test', inspect: { flags, account: { id: 'codex-a', agent: 'codex', configDir: '/home/codex-a' } } });
  try {
    const requireNode = w.deps.requireNode;
    w.deps.requireNode = async (node, agent) => { seen.requireNode = agent; return requireNode(node, agent); };
    const targetReady = w.deps.targetReady;
    w.deps.targetReady = async (node, plan) => { seen.plan = plan; return targetReady(node, plan); };
    w.deps.busy = async (sessionId, plan) => { seen.busy = plan; return null; };
    const plan = await move.moveSession({ sessionId: SID, node: 'aws1', dry: true }, w.deps);
    assert.equal(plan.agent, 'codex');
    assert.equal(plan.flags, flags);
    assert.equal(plan.model, 'gpt-test');
    assert.equal(seen.requireNode, 'codex', 'the node end is asked for the verb version a Codex move needs');
    assert.deepEqual(seen.plan, { agent: 'codex', accountId: 'codex-a', cwd: '/work/project' });
    assert.deepEqual(seen.busy, { agent: 'codex', from: 'main' });
    const done = await move.moveSession({ sessionId: SID, node: 'aws1' }, w.deps);
    assert.equal(done.status, 'done');
    const record = move.readMove(w.root, done.id);
    assert.equal(record.agent, 'codex');
    assert.equal(record.flags, flags);
  } finally { w.cleanup(); }
  // No process to read the flags from: null, and the target gets Keep's default.
  const stopped = world({ agent: 'codex', noPane: true, inspect: { flags: null, account: { id: 'codex-a', agent: 'codex', configDir: '/home/codex-a' } } });
  try { assert.equal((await move.moveSession({ sessionId: SID, node: 'aws1', dry: true }, stopped.deps)).flags, null); }
  finally { stopped.cleanup(); }
  // A Claude plan carries no flags field at all.
  const claude = world();
  try { assert.equal('flags' in (await move.moveSession({ sessionId: SID, node: 'aws1', dry: true }, claude.deps)), false); }
  finally { claude.cleanup(); }
  // A Codex session with no row here that its node's table says is live leaves only
  // with Owner's force, pane or not.
  const hostOnly = world({ agent: 'codex', from: 'aws1', noPane: true, session: null,
    inspect: { session: null, running: true, account: { id: 'codex-a', agent: 'codex', configDir: '/home/codex-a' } } });
  try {
    await assert.rejects(move.moveSession({ sessionId: SID, node: 'main' }, hostOnly.deps),
      (error) => error.extra && error.extra.reason === 'remote-graceful');
    assert.equal((await move.moveSession({ sessionId: SID, node: 'main', ownerForce: true, dry: true }, hostOnly.deps)).agent, 'codex');
  } finally { hostOnly.cleanup(); }
});

test('a dry run answers the plan and changes nothing', async () => {
  const w = world();
  try {
    const plan = await move.moveSession({ sessionId: SID, node: 'aws1', dry: true }, w.deps);
    assert.equal(plan.dry, true);
    assert.equal(plan.from, 'main');
    assert.equal(plan.to, 'aws1');
    assert.deepEqual(names(w.steps), ['requireNode', 'cwdExists', 'targetReady']);
    assert.deepEqual(w.steps.at(-1), ['targetReady', 'aws1', 'claude-a', '/work/project'], 'the target is asked for the account and the launch');
    assert.deepEqual(move.listMoves(w.root), []);
  } finally { w.cleanup(); }
});

// Each failure point: where the record is left, who holds the bytes, and that a
// recovery finishes the move without flipping twice or starting the target early.
const FAILURES = [
  ['stop', 'stopping', 'main', ['stop']],
  ['transfer', 'copying', 'main', ['stop', 'transfer']],
  ['pin', 'staged', 'main', ['stop', 'transfer', 'pin']],
  ['open', 'starting', 'aws1', ['stop', 'transfer', 'pin', 'open']],
  ['wait', 'verifying', 'aws1', ['stop', 'transfer', 'pin', 'open', 'wait']],
];

for (const [point, phase, holder, reached] of FAILURES) {
  test(`a move that fails at ${point} is left ${phase} with ${holder} holding the session, and recovers`, async () => {
    const w = world({ fail: { [point]: point === 'transfer' ? Object.assign(new Error('artifacts-conflict: projects/x on aws1 differs'), { code: 'artifacts-conflict' }) : true } });
    try {
      let id;
      await assert.rejects(move.moveSession({ sessionId: SID, node: 'aws1' }, w.deps), (error) => {
        id = error.extra.id;
        return error.status === 409 && error.extra.status === 'recovery-needed' && error.extra.phase === phase
          && error.extra.holder === holder && new RegExp(`names ${holder}, which holds its verified bytes`).test(error.message);
      });
      assert.deepEqual(moves(w.steps).filter((name) => !['requireNode', 'cwdExists', 'targetReady'].includes(name)), reached);
      assert.equal(w.state.node, holder, 'the location record names the holder');
      assert.equal(w.state.pins, ['main'].includes(holder) ? 0 : 1);
      // Nothing else may resume or move it meanwhile.
      assert.equal(move.inFlight(w.root, SID).id, id);
      await assert.rejects(move.moveSession({ sessionId: SID, node: 'aws1' }, w.deps), /--recover/);
      w.steps.length = 0;
      const recovered = await move.moveSession({ recover: id }, w.deps);
      assert.equal(recovered.status, 'done');
      assert.equal(w.state.pins, 1, 'the record flipped exactly once across both runs');
      assert.equal(w.state.node, 'aws1');
      assert.ok(!names(w.steps).includes('pin') || holder === 'main', 'a recovery after the flip does not pin again');
      if (holder === 'aws1') {
        assert.ok(!names(w.steps).includes('stop') && !names(w.steps).includes('transfer'));
        assert.deepEqual(names(w.steps).slice(0, 2), ['reprove', 'target'], 'a recovery after the flip proves the source stopped, then asks the target');
      }
    } finally { w.cleanup(); }
  });
}

test('a source whose agent exited late says so, and that a recovery usually succeeds', async () => {
  const late = world({ fail: { stop: new Error('An agent process still owns this conversation') } });
  try {
    let id;
    await assert.rejects(move.moveSession({ sessionId: SID, node: 'aws1' }, late.deps), (error) => {
      id = error.extra.id;
      return error.extra.phase === 'stopping' && /The source's agent exited late/.test(error.message)
        && new RegExp(`keep move --recover ${id} usually succeeds`).test(error.message);
    });
    assert.equal((await move.moveSession({ recover: id }, late.deps)).status, 'done');
  } finally { late.cleanup(); }
  // Any other stop failure keeps the plain message.
  const other = world({ fail: { stop: true } });
  try {
    await assert.rejects(move.moveSession({ sessionId: SID, node: 'aws1' }, other.deps),
      (error) => /stop failed/.test(error.message) && !/exited late/.test(error.message));
  } finally { other.cleanup(); }
});

test('a source started again after the copy is caught before the flip, and nothing launches', async () => {
  const w = world({ reviveAfter: 'transfer' });
  try {
    let id;
    await assert.rejects(move.moveSession({ sessionId: SID, node: 'aws1' }, w.deps), (error) => {
      id = error.extra.id;
      return error.extra.phase === 'staged' && error.extra.holder === 'main'
        && /main is not proven stopped before the location record is flipped: an agent process still owns/.test(error.message);
    });
    assert.deepEqual(moves(w.steps).slice(-2), ['stop', 'transfer']);
    assert.equal(w.state.pins, 0, 'the record still names the source');
    // A recovery reads the table again, and refuses while it still runs there.
    w.steps.length = 0;
    await assert.rejects(move.moveSession({ recover: id }, w.deps), /not proven stopped/);
    assert.deepEqual(names(w.steps), ['reprove']);
    // Stopped again: the recovery goes on from the verified stage.
    w.state.revived = false;
    w.steps.length = 0;
    assert.equal((await move.moveSession({ recover: id }, w.deps)).status, 'done');
    assert.deepEqual(names(w.steps), ['reprove', 'pin', 'reprove', 'open', 'wait', 'relink', 'cleanup']);
  } finally { w.cleanup(); }
});

test('a source started again after the flip blocks the launch, and a recovery proves it stopped again first', async () => {
  const w = world();
  // Revived between the flip and the launch.
  const pin = w.deps.pin;
  w.deps.pin = async (record) => { await pin(record); w.state.revived = true; };
  try {
    let id;
    await assert.rejects(move.moveSession({ sessionId: SID, node: 'aws1' }, w.deps), (error) => {
      id = error.extra.id;
      return error.extra.phase === 'pinned' && /main is not proven stopped before the target is launched/.test(error.message);
    });
    assert.equal(names(w.steps).includes('open'), false, 'the target was never launched');
    assert.equal(w.state.node, 'aws1', 'the record stays flipped');
    const record = move.readMove(w.root, id);
    assert.equal(record.launchStartedAt, undefined);
    w.steps.length = 0;
    await assert.rejects(move.moveSession({ recover: id }, w.deps), /before the target is launched/);
    assert.equal(names(w.steps).includes('open'), false);
    w.state.revived = false;
    w.steps.length = 0;
    assert.equal((await move.moveSession({ recover: id }, w.deps)).status, 'done');
    assert.deepEqual(names(w.steps).slice(0, 2), ['reprove', 'open']);
    assert.equal(w.state.pins, 1);
  } finally { w.cleanup(); }
});

test('a source that gained bytes after the copy blocks the flip, and on a recovery the launch', async () => {
  const transcript = `projects/-work-project/${SID}.jsonl`;
  // Before the flip: nothing is flipped.
  const w = world();
  const transfer = w.deps.transfer;
  w.deps.transfer = async (record) => {
    const carried = await transfer(record);
    w.state.changed = { main: { [`file-history/${SID}/new@v1`]: 'b'.repeat(64) } };
    return carried;
  };
  try {
    let id;
    await assert.rejects(move.moveSession({ sessionId: SID, node: 'aws1' }, w.deps), (error) => {
      id = error.extra.id;
      return error.extra.phase === 'staged' && error.extra.reasonCode === 'source-changed'
        && /source changed since the copy; nothing was flipped or launched \(main: file-history\/sess-moving\/new@v1 is new\)/.test(error.message)
        && /move the session again with a fresh move/.test(error.message);
    });
    assert.equal(w.state.pins, 0);
    w.steps.length = 0;
    await assert.rejects(move.moveSession({ recover: id }, w.deps), /source changed since the copy; nothing was flipped or launched/);
    assert.equal(names(w.steps).includes('pin'), false);
    // The way out is the abandon and a fresh move.
    assert.equal((await move.moveSession({ abandon: id }, w.deps)).status, 'abandoned');
  } finally { w.cleanup(); }

  // After the flip, before the launch (a recovery hours later): nothing is launched.
  const after = world({ fail: { open: true } });
  try {
    let id;
    await assert.rejects(move.moveSession({ sessionId: SID, node: 'aws1' }, after.deps), (error) => { id = error.extra.id; return true; });
    after.state.changed = { main: { [transcript]: 'c'.repeat(64) } };
    after.steps.length = 0;
    await assert.rejects(move.moveSession({ recover: id }, after.deps),
      (error) => /source changed since the copy; nothing was launched \(main: projects\/-work-project\/sess-moving.jsonl differs\)/.test(error.message));
    assert.deepEqual(names(after.steps), ['reprove'], 'nothing launched');
    // Unchanged again (a mistaken alarm): the recovery goes on.
    after.state.changed = {};
    assert.equal((await move.moveSession({ recover: id }, after.deps)).status, 'done');
    assert.ok(after.state.listed.includes('main'));
  } finally { after.cleanup(); }
});

test('a target that gained bytes after the copy refuses the abandon back; an unchanged one passes', async () => {
  const w = world({ fail: { open: true } });
  try {
    let id;
    await assert.rejects(move.moveSession({ sessionId: SID, node: 'aws1' }, w.deps), (error) => { id = error.extra.id; return true; });
    w.state.changed = { aws1: { [`projects/-work-project/${SID}/subagents/agent-z.jsonl`]: 'd'.repeat(64) } };
    w.steps.length = 0;
    await assert.rejects(move.moveSession({ abandon: id }, w.deps),
      (error) => error.extra.reason === 'target-changed'
        && /target changed since the copy; abandon refused \(aws1: projects\/-work-project\/sess-moving\/subagents\/agent-z.jsonl is new\)/.test(error.message));
    assert.equal(names(w.steps).includes('pinBack'), false);
    assert.equal(w.state.node, 'aws1');
    w.state.changed = {};
    assert.equal((await move.moveSession({ abandon: id }, w.deps)).status, 'abandoned-back');
  } finally { w.cleanup(); }
});

test('a target pane with no agent proven in it is named to close by hand, and neither recovery nor abandon acts past it', async () => {
  const w = world({ fail: { wait: true } });
  try {
    const id = await failedAfterFlip(w);
    w.state.targetPane = null;
    w.state.lingering = 'p9@aws1';
    await assert.rejects(move.moveSession({ recover: id }, w.deps),
      /pane p9@aws1 on aws1 is open for sess-moving, and whether an agent runs in it is unproven; close pane p9@aws1 on aws1 first/);
    assert.deepEqual(names(w.steps), ['reprove', 'target'], 'nothing waited on or launched');
    w.steps.length = 0;
    await assert.rejects(move.moveSession({ abandon: id }, w.deps),
      (error) => error.extra.reason === 'target-pane' && /cannot be abandoned: pane p9@aws1 on aws1 is open .* close pane p9@aws1 on aws1 first/.test(error.message));
    assert.equal(names(w.steps).includes('pinBack'), false);
    // Closed by hand: the recovery launches it again.
    w.state.lingering = null;
    w.steps.length = 0;
    assert.equal((await move.moveSession({ recover: id }, w.deps)).status, 'done');
    assert.deepEqual(names(w.steps).slice(0, 3), ['reprove', 'target', 'open']);
  } finally { w.cleanup(); }
});

test('a recovery from the copy proves the source stopped before carrying anything', async () => {
  const w = world({ fail: { transfer: true } });
  try {
    let id;
    await assert.rejects(move.moveSession({ sessionId: SID, node: 'aws1' }, w.deps), (error) => { id = error.extra.id; return true; });
    w.state.revived = true;
    w.steps.length = 0;
    await assert.rejects(move.moveSession({ recover: id }, w.deps), /not proven stopped before its files are carried/);
    assert.deepEqual(names(w.steps), ['reprove']);
  } finally { w.cleanup(); }
});

test('an abandon before the flip clears the target stage and leaves the session on its source', async () => {
  const w = world({ fail: { transfer: true } });
  try {
    let id;
    await assert.rejects(move.moveSession({ sessionId: SID, node: 'aws1' }, w.deps), (error) => { id = error.extra.id; return true; });
    const abandoned = await move.moveSession({ abandon: id }, w.deps);
    assert.equal(abandoned.status, 'abandoned');
    assert.match(abandoned.message, /stays on main, stopped: keep open sess-moving resumes it there/);
    assert.deepEqual(w.steps.at(-1), ['abort', 'aws1']);
    assert.equal(w.state.node, 'main');
    assert.equal(move.inFlight(w.root, SID), null);
  } finally { w.cleanup(); }
});

// A move that failed after the flip, with its id.
async function failedAfterFlip(w) {
  let id;
  await assert.rejects(move.moveSession({ sessionId: SID, node: 'aws1' }, w.deps), (error) => { id = error.extra.id; return true; });
  assert.equal(w.state.node, 'aws1');
  w.steps.length = 0;
  return id;
}

test('a recovery after the launch launches again when the target does not run the session', async () => {
  const w = world({ fail: { wait: true } });
  try {
    const id = await failedAfterFlip(w);
    assert.match(move.readMove(w.root, id).message, /--abandon mv-[a-f0-9]+ puts it back on main once neither node runs it/);
    const first = move.readMove(w.root, id).launchStartedAt;
    w.state.targetPane = null; // the launched pane died before it started
    const recovered = await move.moveSession({ recover: id }, w.deps);
    assert.equal(recovered.status, 'done');
    assert.deepEqual(names(w.steps), ['reprove', 'target', 'open', 'wait', 'relink', 'cleanup']);
    const record = move.readMove(w.root, id);
    assert.equal(record.relaunches, 1);
    assert.equal(record.launch.pane, 'p10@aws1', 'the new launch is the one waited for');
    assert.ok(record.launchStartedAt >= first);
    assert.equal(w.state.pins, 1);
  } finally { w.cleanup(); }
});

test('a recovery after the launch waits once more when the target runs it, and says plainly when it never starts', async () => {
  const w = world({ fail: { wait: true } });
  try {
    const id = await failedAfterFlip(w);
    w.state.noStart = true;
    await assert.rejects(move.moveSession({ recover: id }, w.deps),
      /sess-moving is running on aws1 in pane p9@aws1, but its session-start never reported, again/);
    assert.deepEqual(names(w.steps), ['reprove', 'target', 'wait'], 'nothing was launched a second time');
    w.state.noStart = false;
    w.steps.length = 0;
    const recovered = await move.moveSession({ recover: id }, w.deps);
    assert.equal(recovered.status, 'done');
    assert.deepEqual(names(w.steps), ['reprove', 'target', 'wait', 'relink', 'cleanup']);
    assert.match(recovered.warnings.join('\n'), /never reported; waited for it once more/);
    assert.equal(w.state.launches, 1);
  } finally { w.cleanup(); }
});

test('a recovery from a launch that failed part way adopts the pane it left running', async () => {
  const w = world();
  const open = w.deps.open;
  w.deps.open = async (record) => { await open(record); throw new Error('the host answered late'); };
  try {
    const id = await failedAfterFlip(w);
    w.deps.open = open;
    const recovered = await move.moveSession({ recover: id }, w.deps);
    assert.equal(recovered.status, 'done');
    assert.deepEqual(names(w.steps), ['reprove', 'target', 'wait', 'relink', 'cleanup']);
    assert.equal(move.readMove(w.root, id).launch.pane, 'p9@aws1');
  } finally { w.cleanup(); }
});

test('an abandon after the flip puts the record back on the source once neither node runs the session', async () => {
  const w = world({ fail: { open: true } });
  try {
    const id = await failedAfterFlip(w);
    // Refused while the source runs again, while the target runs it, or while either is unproven.
    w.state.revived = true;
    await assert.rejects(move.moveSession({ abandon: id }, w.deps), /cannot be abandoned: main is not proven stopped/);
    w.state.revived = false;
    w.state.targetPane = 'p7@aws1';
    await assert.rejects(move.moveSession({ abandon: id }, w.deps), /cannot be abandoned: sess-moving is running on aws1 in pane p7@aws1/);
    w.state.targetPane = null;
    w.state.fail.target = Object.assign(new Error('the process table on aws1 could not be read'), { status: 409 });
    await assert.rejects(move.moveSession({ abandon: id }, w.deps), /whether aws1 runs sess-moving is unproven/);
    assert.equal(names(w.steps).includes('pinBack'), false);
    assert.equal(w.state.node, 'aws1');
    // Proven: the second flip, the target's copy released, the move ended.
    w.steps.length = 0;
    const abandoned = await move.moveSession({ abandon: id }, w.deps);
    assert.equal(abandoned.status, 'abandoned-back');
    assert.match(abandoned.message, /names main again, stopped: keep open sess-moving resumes it there/);
    assert.deepEqual(names(w.steps), ['reprove', 'target', 'pinBack', 'release', 'abort', 'drop']);
    assert.equal(w.state.node, 'main');
    assert.equal(w.state.backs, 1);
    const record = move.readMove(w.root, id);
    assert.deepEqual([record.abandonedBack.from, record.abandonedBack.to], ['aws1', 'main']);
    assert.equal(move.inFlight(w.root, SID), null, 'the move no longer owns the session');
    // Asked again, it is already done; and a new move may start.
    assert.equal((await move.moveSession({ abandon: id }, w.deps)).status, 'abandoned-back');
    assert.equal(w.state.backs, 1);
    assert.equal((await move.moveSession({ sessionId: SID, node: 'aws1' }, w.deps)).status, 'done');
  } finally { w.cleanup(); }
});

test('an abandon whose flip back landed before its journal did finishes without flipping again', async () => {
  const w = world({ fail: { open: true } });
  try {
    const id = await failedAfterFlip(w);
    const releaseTarget = w.deps.releaseTarget;
    const abortStage = w.deps.abortStage;
    w.deps.releaseTarget = async () => { throw new Error('aws1 did not answer'); };
    w.deps.abortStage = async () => { throw new Error('aws1 did not answer'); };
    const abandoned = await move.moveSession({ abandon: id }, w.deps);
    assert.equal(abandoned.status, 'abandoned-back');
    assert.equal(abandoned.warnings.length, 2, 'a release that failed is reported, not fatal');
    // Rewind the journal to just after the flip back, as a daemon that went away
    // there would have left it.
    const record = move.readMove(w.root, id);
    const rewound = { ...record, status: 'recovery-needed', phase: 'starting' };
    delete rewound.warnings;
    fs.writeFileSync(path.join(w.root, '.keep', 'session-moves', `${id}.json`), JSON.stringify(rewound));
    w.deps.releaseTarget = releaseTarget;
    w.deps.abortStage = abortStage;
    w.steps.length = 0;
    assert.equal((await move.moveSession({ abandon: id }, w.deps)).status, 'abandoned-back');
    assert.deepEqual(names(w.steps), ['reprove', 'target', 'release', 'abort', 'drop']);
    assert.equal(w.state.backs, 1, 'the record was flipped back once');
  } finally { w.cleanup(); }
});

test('a move request is validated before anything is asked', async () => {
  const w = world();
  try {
    for (const body of [{}, { sessionId: '../x', node: 'aws1' }, { sessionId: SID, node: 'AWS 1' }, { sessionId: SID, node: 'aws1', ownerForce: 'yes' },
      { recover: 'nope' }, { recover: `mv-${'a'.repeat(24)}`, abandon: `mv-${'a'.repeat(24)}` }]) {
      await assert.rejects(move.moveSession(body, w.deps), (error) => error.status === 400, JSON.stringify(body));
    }
    await assert.rejects(move.moveSession({ recover: `mv-${'b'.repeat(24)}` }, w.deps), (error) => error.status === 404);
    assert.deepEqual(w.steps, []);
  } finally { w.cleanup(); }
});

test('the console listing prunes week-old finished journals once an hour and re-reads only changed ones', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-session-move-list-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.keep', 'session-moves');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.parse('2026-09-20T12:00:00Z');
  const week = move.PRUNE_AFTER_MS;
  const tx = (n) => `mv-${String(n).padStart(24, '0')}`;
  const write = (n, status, updatedAt) => {
    const file = path.join(dir, `${tx(n)}.json`);
    fs.writeFileSync(file, JSON.stringify({ id: tx(n), sessionId: `s${n}`, status, updatedAt }));
    fs.utimesSync(file, new Date(updatedAt), new Date(updatedAt));
  };
  write(1, 'done', now - week); // exactly a week: pruned
  write(2, 'done', now - week + 1); // a millisecond short: kept
  write(3, 'abandoned', now - 2 * week);
  write(4, 'abandoned-back', now - 2 * week);
  write(5, 'recovery-needed', now - 30 * week); // wants a person: kept forever
  write(6, 'copying', now - 30 * week);
  const ids = (records) => records.map((record) => record.id).sort();

  const reads = [];
  const readFile = fs.promises.readFile;
  fs.promises.readFile = async (file, ...rest) => { reads.push(path.basename(String(file))); return readFile(file, ...rest); };
  t.after(() => { fs.promises.readFile = readFile; });

  assert.deepEqual(ids(await move.listMovesAsync(root, { now })), [tx(2), tx(5), tx(6)]);
  assert.deepEqual(fs.readdirSync(dir).sort(), [tx(2), tx(5), tx(6)].map((id) => `${id}.json`));
  assert.equal(reads.length, 6, 'the first listing parses every journal');

  // Nothing changed: every journal comes from the cache.
  reads.length = 0;
  assert.deepEqual(ids(await move.listMovesAsync(root, { now: now + 1000 })), [tx(2), tx(5), tx(6)]);
  assert.deepEqual(reads, []);

  // A rewritten journal is read again, alone; the next sweep is an hour off, so a
  // journal that became prunable in between stays until then.
  write(2, 'done', now - 2 * week);
  write(7, 'done', now - 2 * week);
  assert.deepEqual(ids(await move.listMovesAsync(root, { now: now + 2000 })), [tx(2), tx(5), tx(6), tx(7)]);
  assert.deepEqual(reads.sort(), [`${tx(2)}.json`, `${tx(7)}.json`]);
  reads.length = 0;
  assert.deepEqual(ids(await move.listMovesAsync(root, { now: now + move.PRUNE_EVERY_MS })), [tx(5), tx(6)]);
  assert.deepEqual(reads, [], 'the sweep prunes from the cache without a read');
});

test('a dry run of a stopped session passes the preflight and plans its move with no pane', async () => {
  const w = world({ noPane: true, from: 'aws1', session: { endedTurn: false } });
  try {
    const plan = await move.moveSession({ sessionId: SID, node: 'main', ownerForce: true, dry: true }, w.deps);
    assert.equal(plan.dry, true);
    assert.equal(plan.from, 'aws1');
    assert.equal(plan.to, 'main');
    assert.equal(plan.pane, null, 'nothing to stop: its pane is gone');
    assert.deepEqual(move.listMoves(w.root), [], 'a dry run journals nothing');
  } finally { w.cleanup(); }
});

// The daemon's mirror of the target's transcript is seeded once the copy is verified,
// before the record is staged, and never fails the move.
function seeding(w, answer) {
  const calls = [];
  w.deps.seedMirror = async (record) => {
    w.steps.push(['seed', record.to]);
    calls.push({ status: record.status, manifest: record.manifest, id: record.id });
    return answer();
  };
  return calls;
}

test('a move seeds the target mirror once, right after the copy, and journals it', async () => {
  const w = world();
  try {
    const calls = seeding(w, () => ({ ok: true, size: 10 }));
    const result = await move.moveSession({ sessionId: SID, node: 'aws1' }, w.deps);
    assert.equal(result.status, 'done');
    assert.deepEqual(names(w.steps), ['requireNode', 'cwdExists', 'targetReady', 'stop', 'transfer', 'seed', 'reprove', 'pin', 'reprove', 'open', 'wait', 'relink', 'cleanup']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].status, 'copying', 'seeded before the record says staged');
    assert.equal(calls[0].manifest.files, 1, 'with the verified manifest already recorded');
    assert.equal(calls[0].id, result.id);
    const record = move.readMove(w.root, result.id);
    assert.equal(record.mirrorSeeded.size, 10);
    assert.ok(Number.isFinite(record.mirrorSeeded.at));
    assert.equal(record.warnings, undefined);
    assert.deepEqual(result.mirrorSeeded, record.mirrorSeeded, 'the answer carries it');
  } finally { w.cleanup(); }
});

test('a seed that throws or declines is a warning, and the move completes', async () => {
  for (const [label, answer, reason] of [
    ['throws', () => { throw new Error('mirror disk full'); }, 'mirror disk full'],
    ['declines', () => ({ ok: false, reason: 'the target listed no file generation' }), 'the target listed no file generation'],
  ]) {
    const w = world();
    try {
      seeding(w, answer);
      w.deps.cleanup = async () => ['a cleanup warning'];
      const result = await move.moveSession({ sessionId: SID, node: 'aws1' }, w.deps);
      assert.equal(result.status, 'done', label);
      const record = move.readMove(w.root, result.id);
      assert.equal(record.mirrorSeeded, undefined, label);
      assert.deepEqual(record.warnings, [`the daemon's mirror of aws1 was not seeded: ${reason}`, 'a cleanup warning'], label);
    } finally { w.cleanup(); }
  }
});

test('a seed with nothing to seed (a move onto the daemon node) is neither journalled nor a warning', async () => {
  const w = world();
  try {
    const calls = seeding(w, () => ({ ok: false, skipped: true, reason: 'the daemon keeps no mirror of its own sessions' }));
    const result = await move.moveSession({ sessionId: SID, node: 'aws1' }, w.deps);
    assert.equal(result.status, 'done');
    assert.equal(calls.length, 1);
    const record = move.readMove(w.root, result.id);
    assert.equal(record.mirrorSeeded, undefined);
    assert.equal(record.warnings, undefined);
  } finally { w.cleanup(); }
});

test('a recovery from the staged copy does not seed again', async () => {
  const w = world({ reviveAfter: 'transfer' });
  try {
    const calls = seeding(w, () => ({ ok: false, reason: 'short' }));
    let id;
    await assert.rejects(move.moveSession({ sessionId: SID, node: 'aws1' }, w.deps), (error) => { id = error.extra.id; return error.extra.phase === 'staged'; });
    assert.equal(calls.length, 1);
    w.state.revived = false;
    w.steps.length = 0;
    assert.equal((await move.moveSession({ recover: id }, w.deps)).status, 'done');
    assert.equal(calls.length, 1, 'the seed belongs to the copy, which a recovery from staged does not repeat');
    assert.deepEqual(move.readMove(w.root, id).warnings, ["the daemon's mirror of aws1 was not seeded: short"],
      'the warning journalled by the first run survives the recovery');
  } finally { w.cleanup(); }
});
