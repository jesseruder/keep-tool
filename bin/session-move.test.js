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
    pendingDelivery: async () => options.pendingDelivery === true,
    busy: async () => options.busy || null,
    stop: async (record) => { steps.push(['stop', record.from]); failing('stop'); state.stopped = true; },
    transfer: async (record) => {
      steps.push(['transfer', record.from, record.to]);
      assert.equal(state.stopped, true, 'nothing is carried before the source is stopped');
      failing('transfer');
      return { files: [{ relPath: `projects/-work-project/${SID}.jsonl`, sha256: 'a'.repeat(64), size: 10 }], bytes: 10 };
    },
    location: async () => ({ node: state.node, agent: 'claude', accountId: 'claude-a' }),
    pin: async (record) => { steps.push(['pin', record.to]); failing('pin'); state.node = record.to; state.pins += 1; },
    open: async (record) => {
      steps.push(['open', record.to]);
      assert.equal(state.node, record.to, 'the target starts only once the record names it');
      failing('open');
      return { pane: record.to === 'main' ? 'p9' : 'p9@aws1', pid: 99, createdAt: 't1' };
    },
    waitForPaneRecord: async (record) => {
      steps.push(['wait', record.launch.pane]);
      failing('wait');
      return { pane: record.launch.pane, startedAt: Date.now() };
    },
    relink: async () => { steps.push(['relink']); return 'card-1'; },
    cleanup: async (record) => { steps.push(['cleanup', record.from]); return []; },
    abortStage: async (record) => { steps.push(['abort', record.to]); },
  };
  return { root, deps, steps, state, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const names = (steps) => steps.map((step) => step[0]);

test('a move stops the source, carries, flips once, starts the target and verifies it, in that order', async () => {
  const w = world();
  try {
    const result = await move.moveSession({ sessionId: SID, node: 'aws1' }, w.deps);
    assert.equal(result.status, 'done');
    assert.deepEqual(names(w.steps), ['requireNode', 'cwdExists', 'stop', 'transfer', 'pin', 'open', 'wait', 'relink', 'cleanup']);
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

test('the preflight refuses before anything is stopped', async () => {
  const cases = [
    [{ nodes: ['main'] }, /no other node is configured/],
    [{ from: 'aws1' }, /already on aws1/],
    [{ agent: 'codex' }, /Claude sessions only/],
    [{ cwdMissing: true, session: { project: '/home/u/wt/keep-tool/x' } }, /does not exist on aws1.*worktree: run wt there/],
    [{ pendingDelivery: true }, /still unconfirmed/],
    [{ busy: 'an account handoff is copying (copying-artifacts)' }, /busy: an account handoff/],
    [{ session: { endedTurn: false } }, /is working/],
    [{ model: '<unknown>' }, /model .* cannot be established/],
    [{ fail: { requireNode: Object.assign(new Error('the terminal host on aws1 predates the artifacts verb'), { status: 409 }) } }, /predates/],
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

test('a dry run answers the plan and changes nothing', async () => {
  const w = world();
  try {
    const plan = await move.moveSession({ sessionId: SID, node: 'aws1', dry: true }, w.deps);
    assert.equal(plan.dry, true);
    assert.equal(plan.from, 'main');
    assert.equal(plan.to, 'aws1');
    assert.deepEqual(names(w.steps), ['requireNode', 'cwdExists']);
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
      assert.deepEqual(names(w.steps).filter((name) => !['requireNode', 'cwdExists'].includes(name)), reached);
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
      if (holder === 'aws1') assert.ok(!names(w.steps).includes('stop') && !names(w.steps).includes('transfer'));
    } finally { w.cleanup(); }
  });
}

test('an abandon before the flip clears the target stage and leaves the session on its source; after the flip it is refused', async () => {
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
  const after = world({ fail: { open: true } });
  try {
    let id;
    await assert.rejects(move.moveSession({ sessionId: SID, node: 'aws1' }, after.deps), (error) => { id = error.extra.id; return true; });
    await assert.rejects(move.moveSession({ abandon: id }, after.deps), /past the flip .* --recover/);
    assert.equal(after.steps.some((step) => step[0] === 'abort'), false);
  } finally { after.cleanup(); }
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
