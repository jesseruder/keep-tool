'use strict';

// Every daemon tick and transcript lookup, run against a fleet where some sessions
// live on another node (bin/fixtures/remote-node-fleet.js). The rule each one is held
// to (docs/node-provisioning.md, "Schedulers and sessions on another node"): it
// finishes, the local sessions are still served, and a session on another node is
// either read from its mirror or skipped with a reason that names the node — never a
// read of the stale local copy, and never a failure that takes the whole tick down.
//
// A new scheduler joins this file before sessions of the kind it touches may run on
// a node. Build a fleet, drive the tick with `fleet.sessions()` / `fleet.panes()` (or
// `fleet.fakeHosts()` for serve.js paths that talk to a host), and assert the rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRemoteNodeFleet, claudeTranscript } = require('./fixtures/remote-node-fleet.js');

const STRICT_REFUSAL = /its transcript is not mirrored here/;

test('the fleet places sessions the way the daemon reads them', (t) => {
  const fleet = createRemoteNodeFleet(t);
  const accounts = require('./accounts.js');
  const transcripts = require('./transcripts.js');
  assert.equal(accounts.sessionNode(fleet.local.id), 'main');
  for (const session of fleet.remote) assert.equal(accounts.sessionNode(session.id), 'aws1');
  assert.equal(transcripts.findSessionFile(fleet.local.id), fleet.local.file);
  // The strict lookup refuses every session on the node, mirrored or not: its
  // callers deliver, move or verify against the file.
  assert.throws(() => transcripts.findSessionFile(fleet.mirrored.id), /runs on node aws1/);
  assert.throws(() => transcripts.findSessionFile(fleet.unmirrored.id), /runs on node aws1/);
  assert.deepEqual(require('./nodes.js').configuredNodeNames(), ['main', 'aws1']);
  assert.equal(fleet.panes().filter((pane) => require('./nodes.js').isRemotePane(pane)).length, 3);
  // The stale copies are really there, so a reader that found them would show it.
  assert.match(fs.readFileSync(fleet.mirrored.staleLocal, 'utf8'), /stale local copy/);
  assert.equal(require('./codex.js').findRolloutFile(fleet.remoteCodex.id), fleet.remoteCodex.staleLocal);
});

test('readers get the mirror or nothing, never the copy a move left behind', (t) => {
  const fleet = createRemoteNodeFleet(t);
  const transcripts = require('./transcripts.js');
  assert.equal(transcripts.readableSessionFile(fleet.local.id), fleet.local.file);
  assert.equal(transcripts.readableSessionFile(fleet.mirrored.id), fleet.mirrored.mirror);
  assert.equal(transcripts.readableSessionFile(fleet.unmirrored.id), null);
  // Codex rollouts are not mirrored, so a Codex session on the node has nothing here.
  assert.equal(transcripts.readableRolloutFile(fleet.remoteCodex.id), null);
  assert.equal(transcripts.remoteSessionNode(fleet.remoteCodex.id), 'aws1');
  assert.equal(transcripts.remoteSessionNode(fleet.local.id), null);
});

// ---------- review.js: the review tick, its compaction, lint and stats ----------

test('review: every card session is located through its mirror, a node Codex session not at all', (t) => {
  const fleet = createRemoteNodeFleet(t);
  const { locateSession } = require('./review.js');
  const located = Object.fromEntries(fleet.all.map((session) => [session.name, locateSession({ id: session.id, agent: session.agent })]));
  assert.deepEqual(located, {
    local: fleet.local.file, mirrored: fleet.mirrored.mirror, unmirrored: null, remoteCodex: null,
  });
});

test('review: the compact tick skips a reviewer on the node by its location record, reading nothing', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const { reviewerCompactTick } = require('./review.js');
  let compacted = 0;
  for (const session of [fleet.mirrored, fleet.unmirrored]) {
    // A bare row: the location record decides, not the row.
    const reviewer = fleet.row(session, { reviewer: true }, { bare: true });
    const result = await reviewerCompactTick({
      loadMeta: () => ({}), saveMeta: () => {},
      reviewer: () => reviewer, sessions: () => [reviewer],
      transcriptMtime: () => { throw new Error('read a reviewer on another node'); },
      sessionContextTokens: () => { throw new Error('read a reviewer on another node'); },
      compact: async () => { compacted += 1; return { compacted: true }; },
    });
    assert.equal(result.skipped, true);
    assert.equal(result.expected, true);
    assert.match(result.why, /runs on node aws1/);
  }
  assert.equal(compacted, 0);
});

test('review: a bootstrap message to a reviewer on the node is decided by the node, and typed only into its pane there', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const serve = require('./serve.js');
  await serve.closeHostClient();
  t.after(() => serve.closeHostClient());
  // Anything past the node's own answers stops the send right there: what these cases
  // are about is where it got to, and no keystroke is ever typed.
  const stopAt = (extra = () => undefined) => (node, type, params) => {
    const answered = extra(node, type, params);
    if (answered !== undefined) return answered;
    if (node === 'aws1' && !['hello', 'list'].includes(type) && !(type === 'transcript' && params.op === 'stat')) {
      throw new Error(`reached aws1 with ${type}${params.op ? ` ${params.op}` : ''}`);
    }
    return undefined;
  };
  const send = async (session, answer) => {
    await serve.closeHostClient();
    const hosts = fleet.fakeHosts(answer);
    const result = serve.sendToSession({ sessionId: session.id, text: 'bootstrap' }, { bootstrap: true }, {},
      { connectHost: hosts.connectHost, forceHostReconnect: true });
    return { hosts, result };
  };

  // The node has no transcript for it: the bootstrap path, through its pane on aws1.
  const bare = await send(fleet.unmirrored, stopAt());
  await assert.rejects(bare.result, (error) => !STRICT_REFUSAL.test(error.message) && /reached aws1 with screen/.test(error.message));
  assert.ok(bare.hosts.requests.some((entry) => entry.node === 'aws1' && entry.type === 'screen'
    && entry.params.pane === fleet.unmirrored.hostPaneId));
  assert.deepEqual(bare.hosts.typedOn('aws1'), []);

  // Nothing mirrored, but the node has a transcript (its hook posts are failing): the
  // node's stat decides, so it takes the ordinary path and reads the session there.
  const behind = await send(fleet.unmirrored, stopAt((node, type, params) => (node === 'aws1' && type === 'transcript'
    && params.op === 'stat' ? { path: '/node/path.jsonl', size: 10, mtimeMs: Date.now(), generation: 'g' } : undefined)));
  await assert.rejects(behind.result, /reached aws1 with transcript tail/);
  assert.equal(behind.hosts.requests.some((entry) => entry.type === 'screen'), false);

  // A mirrored reviewer has had a turn: the ordinary path.
  const spoken = await send(fleet.mirrored, stopAt());
  await assert.rejects(spoken.result, /reached aws1 with transcript tail/);

  // The only pane naming it is on this machine: a pane on the wrong node is refused.
  const elsewhere = await send(fleet.unmirrored, stopAt((node, type) => {
    if (node === 'main' && type === 'list') {
      return { panes: [{ ...fleet.local.paneRow, id: 'fxstray', node: undefined,
        meta: { agent: 'claude', sessionId: fleet.unmirrored.id } }] };
    }
    if (node === 'aws1' && type === 'list') return { panes: [] };
    return undefined;
  }));
  await assert.rejects(elsewhere.result, (error) => error.status === 409
    && /pane fxstray is on main but reviewer .* is on aws1; nothing was sent/.test(error.message));

  // aws1 does not answer the list: its pane cannot be verified, whatever it last said.
  const silent = await send(fleet.unmirrored, stopAt((node, type) => {
    if (node === 'aws1' && type === 'list') throw new Error('aws1 is unreachable');
    return undefined;
  }));
  await assert.rejects(silent.result, (error) => error.status === 409 && /node aws1 did not answer/.test(error.message));
  assert.equal(silent.hosts.requests.some((entry) => entry.type === 'screen'), false);
});

test('review: a reviewer on the node with a mirror is live, and is not mistaken for a bootstrap', (t) => {
  const fleet = createRemoteNodeFleet(t);
  const review = require('./review.js');
  const dir = path.join(fleet.root, '.keep', 'reviewer');
  fs.mkdirSync(dir, { recursive: true });
  // Registered hours ago, so the bootstrap window is long over for both.
  for (const session of [fleet.mirrored, fleet.unmirrored]) {
    fs.writeFileSync(path.join(dir, session.id), JSON.stringify({ at: Date.now() - 6 * 3600e3 }));
    t.after(() => fs.rmSync(path.join(dir, session.id), { force: true }));
  }
  const panes = fleet.panes();
  // The local scan has neither; the mirrored one is live from its mirror, and idle.
  const reviewer = review.findReviewerSession([fleet.row(fleet.local)], {}, { panes });
  assert.equal(reviewer.id, fleet.mirrored.id);
  assert.equal(reviewer.node, 'aws1');
  assert.equal(reviewer.bootstrap, undefined);
  assert.equal(reviewer.endedTurn, true);
  assert.ok(Math.abs(reviewer.mtime - fs.statSync(fleet.mirrored.mirror).mtimeMs) < 1);
  // No live pane for it (an old reviewer whose mirror is still the newest), or no
  // pane list at all: not a candidate.
  const dead = panes.map((pane) => (pane.meta.sessionId === fleet.mirrored.id ? { ...pane, alive: false } : pane));
  assert.equal(review.findReviewerSession([], {}, { panes: dead }), null);
  assert.equal(review.findReviewerSession([], {}, {}), null);
  // A mirror whose last turn has not ended is a reviewer mid-turn: the tick waits.
  const at = new Date().toISOString();
  fs.appendFileSync(fleet.mirrored.mirror, `${JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: 'next' } })}\n`);
  assert.equal(review.findReviewerSession([], {}, { panes }).endedTurn, false);
  // Quiet for longer than the session window (the node's own read would answer 404
  // "no session"): not a candidate, exactly as the local scan leaves a stale reviewer out.
  const stale = (Date.now() - 49 * 3600e3) / 1000;
  const fresh = fs.statSync(fleet.mirrored.mirror).mtime;
  fs.utimesSync(fleet.mirrored.mirror, stale, stale);
  assert.equal(review.findReviewerSession([], {}, { panes }), null);
  fs.utimesSync(fleet.mirrored.mirror, fresh, fresh);
  // Interrupted, as the daemon's scanner reads it everywhere else: the turn is over.
  fs.appendFileSync(fleet.mirrored.mirror, `${JSON.stringify({ type: 'user', timestamp: at, interruptedMessageId: 'msg_fixture',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })}\n`);
  assert.equal(review.findReviewerSession([], {}, { panes }).endedTurn, true);
});

test('review: bootstrap attempts count only sends that went the bootstrap way, and a half-typed send is a tick', async (t) => {
  createRemoteNodeFleet(t);
  const review = require('./review.js');
  const health = require('./health.js');
  const original = health.record;
  health.record = () => {};
  t.after(() => { health.record = original; });
  const reset = () => review.mutateMeta((meta) => {
    meta.drift = {}; meta.fallback = {}; meta.sweepTick = {}; delete meta.lastTickAt; delete meta.bootstrapAttempts;
  });
  const reviewer = { id: 'reviewer-fixture', state: 'idle', endedTurn: true, mtime: Date.now(), bootstrap: true };
  const tick = (send) => review.reviewTick({
    sessions: () => [], findReviewer: () => reviewer,
    reviewBudget: () => ({ code: 0, reason: 'within budget' }), lastVerdictAt: () => 0,
    lintSnapshotAgeMs: () => 0, refreshLint: async () => ({ ok: true }), send,
  }, { trigger: 'sweep', sweepDue: true });
  const attempts = () => (review.loadMeta().bootstrapAttempts || {})[reviewer.id] || 0;

  // The daemon took the ordinary path (the reviewer had a transcript on its node).
  reset();
  await tick(async () => ({ ok: true, delivery: 'confirmed' }));
  assert.equal(attempts(), 0);
  // It really went the bootstrap way.
  reset();
  await tick(async () => ({ bootstrap: true }));
  assert.equal(attempts(), 1);
  // Keys were typed and then the send failed: recorded as a tick, so the next one
  // waits its gap instead of sending the same message again.
  reset();
  await assert.rejects(tick(async () => { throw Object.assign(new Error('screen read timed out'), { typingStarted: true }); }));
  assert.ok(review.loadMeta().lastTickAt);
  assert.equal(attempts(), 1);
  // Nothing typed: no tick recorded.
  reset();
  await assert.rejects(tick(async () => { throw new Error('refused before typing'); }));
  assert.equal(review.loadMeta().lastTickAt, undefined);
  // The same half-typed send as the daily sweep: the sweep is recorded as sent.
  reset();
  await assert.rejects(tick(async () => { throw Object.assign(new Error('screen read timed out'), { typingStarted: true }); }));
  assert.ok(review.loadMeta().sweepTick.lastSentAt);
});

test('review: a parked drift whose retry fails after its first key is not typed again', async (t) => {
  createRemoteNodeFleet(t);
  const review = require('./review.js');
  const health = require('./health.js');
  const original = health.record;
  health.record = () => {};
  t.after(() => { health.record = original; });
  review.mutateMeta((meta) => { meta.drift = {}; meta.fallback = {}; meta.sweepTick = {}; delete meta.lastTickAt; });
  let reviewer = { id: 'reviewer-fixture', state: 'idle', endedTurn: false };
  const sends = [];
  let fail = null;
  const deps = {
    sessions: () => [], findReviewer: () => reviewer,
    reviewBudget: () => ({ code: 0, reason: 'within budget' }),
    lintSnapshotAgeMs: () => 0, refreshLint: async () => ({ ok: true }),
    send: async (_id, text) => { sends.push(text); if (fail) throw fail; },
  };
  // Parked while the reviewer is busy.
  await review.driftWake(deps, { sessionId: 'drifting-fixture', turn: 3, cardId: 'card-fixture', stateLine: 's', reason: 'r' });
  assert.equal(review.duePendingDrifts(review.loadMeta()).length, 1);
  // Retried once it is free; the keys go in and the screen read after Enter fails.
  reviewer = { id: 'reviewer-fixture', state: 'idle', endedTurn: true };
  fail = Object.assign(new Error('screen read timed out'), { typingStarted: true });
  await assert.rejects(review.retryPendingDrifts(deps), /screen read timed out/);
  assert.equal(sends.length, 1);
  assert.deepEqual(review.duePendingDrifts(review.loadMeta()), [], 'the drift is off the retry list');
  // The next minute's retry, and a second wake for the same turn, type nothing.
  fail = null;
  await review.retryPendingDrifts(deps);
  const again = await review.driftWake(deps, { sessionId: 'drifting-fixture', turn: 3, cardId: 'card-fixture', stateLine: 's', reason: 'r' });
  assert.equal(again.sent, false);
  assert.equal(sends.length, 1);
});

test('review: a message to a reviewer on the node is gated on the node\'s own read of it', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const serve = require('./serve.js');
  await serve.closeHostClient();
  t.after(() => serve.closeHostClient());
  const midTurn = Buffer.from(`${fs.readFileSync(fleet.mirrored.mirror, 'utf8')}${JSON.stringify({ type: 'user',
    timestamp: new Date().toISOString(), message: { role: 'user', content: 'a prompt the mirror has not seen' } })}\n`);
  const send = async (session, { tail, stat, bootstrap = false } = {}) => {
    await serve.closeHostClient();
    const hosts = fleet.fakeHosts((node, type, params) => {
      if (node !== 'aws1') return undefined;
      if (type === 'transcript' && params.op === 'tail' && tail) return tail;
      if (type === 'transcript' && params.op === 'stat' && stat) return stat;
      if (['screen', 'input'].includes(type)) throw new Error(`reached aws1 with ${type}`);
      return undefined;
    });
    const result = serve.sendReviewerMessage(session.id, 'review tick', { bootstrap },
      { connectHost: hosts.connectHost, forceHostReconnect: true });
    return { hosts, result };
  };
  const tailOf = (bytes) => ({ path: '/node/reviewer.jsonl', size: bytes.length, mtimeMs: Date.now(), generation: 'g', from: 0,
    bytes: bytes.toString('base64') });

  // The mirror says idle, the node says a turn is running: refused, nothing read or typed.
  const busy = await send(fleet.mirrored, { tail: tailOf(midTurn) });
  let refusal = null;
  await assert.rejects(busy.result, (error) => { refusal = error; return error.status === 409 && /is not idle on aws1; nothing was typed/.test(error.message); });
  // And the review row holds for it, as it does for a local reviewer mid-turn.
  const held = [];
  require('./review.js').recordTickError(refusal, (name, value) => held.push(value));
  assert.equal(held[0].holdResult, true);
  assert.equal(busy.hosts.requests.some((entry) => ['screen', 'input'].includes(entry.type)), false);

  // Picked as a bootstrap row, but the node has a transcript and a turn running: refused.
  const spoken = await send(fleet.unmirrored, { bootstrap: true, tail: tailOf(midTurn),
    stat: { path: '/node/reviewer.jsonl', size: midTurn.length, mtimeMs: Date.now(), generation: 'g' } });
  await assert.rejects(spoken.result, /is not idle on aws1/);

  // Idle on the node: past the gate, to the pane.
  const idle = await send(fleet.mirrored);
  await assert.rejects(idle.result, /reached aws1 with screen/);

  // Never spoken (no transcript on the node): the bootstrap path decides, ungated.
  const fresh = await send(fleet.unmirrored, { bootstrap: true });
  await assert.rejects(fresh.result, /reached aws1 with screen/);
  assert.deepEqual(idle.hosts.typedOn('aws1'), []);
});

// ---------- session summaries ----------

test('summaries: a node session is summarized from its mirror, a node Codex session not at all', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const { prepareSessionSummary } = require('./serve.js');
  const inputs = {};
  for (const session of fleet.all) {
    const result = prepareSessionSummary(fleet.row(session, {}, { bare: true }), {}, {
      getSummary: (_key, input) => { inputs[session.name] = input; return { text: 'summary', fresh: true }; },
    });
    if (!(session.name in inputs)) assert.deepEqual(result, { text: null, fresh: false });
  }
  assert.match(inputs.local, /local transcript on the daemon node/);
  assert.match(inputs.mirrored, /mirrored transcript from the node/);
  assert.doesNotMatch(inputs.mirrored, /stale local copy/);
  assert.equal('unmirrored' in inputs, false);
  assert.equal('remoteCodex' in inputs, false, 'the rollout a moved Codex session left here is not summarized');
});

// ---------- serve.js lookups every synchronous caller shares ----------

test('transcriptFileForSession answers null for every node session, with or without a node on the row', (t) => {
  const fleet = createRemoteNodeFleet(t);
  const { transcriptFileForSession } = require('./serve.js');
  for (const bare of [false, true]) {
    const files = Object.fromEntries(fleet.all.map((session) => [session.name,
      transcriptFileForSession(fleet.row(session, {}, { bare }))]));
    assert.deepEqual(files, { local: fleet.local.file, mirrored: null, unmirrored: null, remoteCodex: null }, `bare ${bare}`);
  }
});

test('the live-session ledger learns a node session\'s project from its mirror', (t) => {
  const fleet = createRemoteNodeFleet(t);
  const { sessionProjectFromTranscript } = require('./serve.js');
  assert.equal(sessionProjectFromTranscript(fleet.local.id, {}, 'claude').project, fleet.project);
  assert.equal(sessionProjectFromTranscript(fleet.mirrored.id, {}, 'claude').project, fleet.project);
  // Nothing mirrored: no project, and no throw.
  assert.equal(sessionProjectFromTranscript(fleet.unmirrored.id, {}, 'claude').project, '');
});

test('liveSessionTick records every session of a fleet with node sessions in it', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const serve = require('./serve.js');
  await serve.closeHostClient();
  t.after(() => serve.closeHostClient());
  const hosts = fleet.fakeHosts();
  let written = null;
  const result = await serve.liveSessionTick({
    connectHost: hosts.connectHost, forceHostReconnect: true,
    liveSessionPids: async () => new Map(),
    scanSessions: async () => [fleet.row(fleet.local)],
    ledger: { updatedAt: 0, sessions: {} },
    writeLedger: (ledger) => { written = ledger; },
    agentProcessRows: async () => [],
  });
  assert.equal(result.ok, true, result.error);
  for (const session of fleet.all) assert.ok(written.sessions[session.id], `${session.name} is in the ledger`);
  assert.deepEqual(hosts.typedOn('aws1'), []);
});

test('restore: a plan over a fleet with node sessions answers for every session, never failing for one', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const serve = require('./serve.js');
  await serve.closeHostClient();
  t.after(() => serve.closeHostClient());
  // Every agent gone, so each row is decided by what can be resumed.
  const hosts = fleet.fakeHosts((_node, type) => (type === 'list' ? { panes: [] } : undefined));
  const now = Date.now();
  const ledger = { updatedAt: now, sessions: Object.fromEntries(fleet.all.map((session, index) => [session.id,
    { pid: 50000 + index, agent: session.agent, project: fleet.project, source: 'host', primary: true, lastSeenAlive: now - 60e3 }])) };
  const plan = await serve.restorePlan({}, {
    connectHost: hosts.connectHost, forceHostReconnect: true, ledger, now: () => now,
    liveSessionPids: async () => new Map(), scanSessions: async () => [fleet.row(fleet.local)],
    agentProcessRows: async () => [],
  });
  assert.equal(plan.ok, true);
  const byId = Object.fromEntries(plan.sessions.map((row) => [row.id, row]));
  assert.equal(byId[fleet.local.id].action, 'restore');
  assert.equal(byId[fleet.mirrored.id].action, 'restore', 'its mirror is history to resume');
  assert.equal(byId[fleet.unmirrored.id].action, 'skip');
  assert.match(byId[fleet.unmirrored.id].reason, /no transcript/);
  assert.ok(byId[fleet.remoteCodex.id]);
});

test('restore: a node that did not answer has its sessions skipped by name, never resumed a second time', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const serve = require('./serve.js');
  await serve.closeHostClient();
  t.after(() => serve.closeHostClient());
  // A daemon just restarted: aws1 does not answer, and there is no last-known list for
  // it. Its agents may well be running; this machine cannot tell.
  const hosts = fleet.fakeHosts((node, type) => {
    if (node === 'aws1' && type === 'list') throw new Error('aws1 is unreachable');
    if (type === 'list') return { panes: [] };
    return undefined;
  });
  const now = Date.now();
  const ledger = { updatedAt: now, sessions: Object.fromEntries(fleet.all.map((session, index) => [session.id,
    { pid: 50000 + index, agent: session.agent, project: fleet.project, source: 'host', primary: true, lastSeenAlive: now - 60e3 }])) };
  const plan = await serve.restorePlan({}, {
    connectHost: hosts.connectHost, forceHostReconnect: true, ledger, now: () => now,
    liveSessionPids: async () => new Map(), scanSessions: async () => [fleet.row(fleet.local)],
    agentProcessRows: async () => [],
  });
  assert.equal(plan.ok, true);
  const byId = Object.fromEntries(plan.sessions.map((row) => [row.id, row]));
  assert.equal(byId[fleet.local.id].action, 'restore', 'the daemon node answered for its own session');
  for (const session of fleet.remote) {
    assert.equal(byId[session.id].action, 'skip', session.name);
    assert.equal(byId[session.id].reason, 'node aws1 did not answer', session.name);
  }
});

test('restore: a session on a node this daemon cannot list is skipped, when the node is gone from the config or the config is unreadable', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const serve = require('./serve.js');
  await serve.closeHostClient();
  t.after(() => serve.closeHostClient());
  const now = Date.now();
  const ledger = { updatedAt: now, sessions: Object.fromEntries(fleet.all.map((session, index) => [session.id,
    { pid: 50000 + index, agent: session.agent, project: fleet.project, source: 'host', primary: true, lastSeenAlive: now - 60e3 }])) };
  const plan = async () => {
    await serve.closeHostClient();
    const hosts = fleet.fakeHosts((_node, type) => (type === 'list' ? { panes: [] } : undefined));
    const result = await serve.restorePlan({}, {
      connectHost: hosts.connectHost, forceHostReconnect: true, ledger, now: () => now,
      liveSessionPids: async () => new Map(), scanSessions: async () => [fleet.row(fleet.local)],
      agentProcessRows: async () => [],
    });
    return Object.fromEntries(result.sessions.map((row) => [row.id, row]));
  };
  // aws1 taken out of the node list: its sessions' records still name it. (A new
  // file each time: the node list is memoized per configuration path.)
  const removed = path.join(fleet.base, 'config-without-aws1.json');
  fs.writeFileSync(removed, JSON.stringify({ ...fleet.config, nodes: { main: {} } }));
  process.env.KEEP_CONFIG = removed;
  let byId = await plan();
  for (const session of fleet.remote) {
    assert.deepEqual([byId[session.id].action, byId[session.id].reason], ['skip', 'node aws1 is not in this daemon\'s node list'], session.name);
  }
  // A configuration nobody can read: every node session is skipped by name.
  const broken = path.join(fleet.base, 'config-unreadable.json');
  fs.writeFileSync(broken, '{ not json');
  process.env.KEEP_CONFIG = broken;
  byId = await plan();
  for (const session of fleet.remote) {
    assert.deepEqual([byId[session.id].action, byId[session.id].reason], ['skip', 'the node list could not be read'], session.name);
  }
});

// ---------- acting paths: skipped with a reason that names the node ----------

test('restart: an in-place restart of a node session is refused by name before anything is stopped', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const serve = require('./serve.js');
  await serve.closeHostClient();
  t.after(() => serve.closeHostClient());
  const pane = fleet.mirrored.paneRow;
  const stamp = 'Tue Sep  8 10:00:00 2026';
  const command = `/test/claude --resume ${fleet.mirrored.id}`;
  const agent = { pid: pane.pid + 1, ppid: pane.pid, pidStart: stamp, agent: 'claude', interactive: true, args: command };
  const hosts = fleet.fakeHosts((node, type) => {
    if (node === 'aws1' && type === 'screen') return { text: `${command}\n~ > `, cursor: { x: 4, y: 1 } };
    return undefined;
  });
  let closed = false;
  await assert.rejects(serve.restartSession({ sessionId: fleet.mirrored.id, pane: fleet.mirrored.pane, pid: pane.pid, mode: 'idle' }, {
    connectHost: hosts.connectHost, forceHostReconnect: true, withInjectionLock: (fn) => fn(),
    buildState: async () => ({ sessions: [fleet.row(fleet.mirrored, { project: fleet.project })], tasks: [] }),
    agentProcessRows: async () => [agent], psTable: `${agent.pid} ${pane.pid} ttys001 ${stamp} ${command}`,
    lsof: async () => '', sleep: async () => {},
    closeIdleSession: async () => { closed = true; },
  }), (error) => error.status === 409 && /in-place restart of a session on aws1 is not available yet/.test(error.message));
  assert.equal(closed, false);
  assert.deepEqual(hosts.typedOn('aws1'), []);
});

test('rate-limit handoff: the policy never offers a pane on the node', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const { handoffPolicySessions } = require('./serve.js');
  const asked = [];
  const sessions = await handoffPolicySessions({
    listHostPanes: async () => fleet.panes(),
    claudeSessionFor: (id) => { asked.push(id); return { id, rateLimit: { at: new Date().toISOString(), type: 'five_hour' } }; },
  });
  assert.deepEqual(sessions.map((session) => session.id), [fleet.local.id]);
  assert.deepEqual(asked, [fleet.local.id]);
});

test('limit resume and auto-close: the node\'s sessions and panes are filtered out by the shared predicates', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const { remoteSession } = require('./serve.js');
  // The limit-resume scheduler's own filter, over bare rows (a local scan's stale copy).
  assert.deepEqual(fleet.sessions({}, { bare: true }).filter((row) => !remoteSession(row)).map((row) => row.id), [fleet.local.id]);
  // The auto-close snapshot hands automatic policies this machine's panes only.
  const { createCleanupSnapshot } = require('./serve/schedulers.js');
  const snapshot = createCleanupSnapshot({
    keep: { ROOT: fleet.root, loadAll: () => [] },
    keepConsole: { readLayouts: async () => ({ layouts: [] }) },
    listHostPanes: async () => fleet.panes(),
    companionSnapshot: async () => ({ known: true, jobs: [] }),
    dashboardBuild: async (input) => ({ sessions: fleet.sessions(), panes: input.hostPanes }),
    reconcile: () => {},
  });
  assert.deepEqual((await snapshot()).panes.map((pane) => pane.id), [fleet.local.pane]);
});

// ---------- notes: an author on the node is asked of its node ----------

test('notes: an author on the node is asked of its node first, and an outage there has its own budget', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const notes = require('./notes.js');
  const start = Date.now();
  const add = (session) => notes.addNote({ project: fleet.project, scopes: ['deploy'], by: { sessionId: session.id, agent: session.agent },
    message: `held by ${session.name}`, until: new Date(start - 60e3).toISOString(), root: fleet.root, now: start - 3600e3 });
  const local = add(fleet.local);
  const mirrored = add(fleet.mirrored);
  const unreachable = add(fleet.unmirrored);
  const codexNote = add(fleet.remoteCodex);
  const sent = [];
  const sweep = (now) => notes.sweep({
    root: fleet.root, now,
    // The local scan still has the stale copy a move left behind, and it says exited:
    // the node's answer wins.
    sessions: () => [fleet.row(fleet.local), fleet.row(fleet.mirrored, { exited: true, state: 'exited' }, { bare: true })],
    remoteSession: async (id) => {
      if (id === fleet.unmirrored.id) throw new Error('aws1 did not answer');
      if (id === fleet.remoteCodex.id) return { absent: 'its author is a codex session on aws1' };
      return id === fleet.mirrored.id ? fleet.row(fleet.mirrored) : null;
    },
    send: async (sessionId) => { sent.push(sessionId); },
  });
  const result = await sweep(start);
  assert.deepEqual(sent.sort(), [fleet.local.id, fleet.mirrored.id].sort());
  assert.deepEqual({ nagged: result.nagged, owner: result.owner, deferred: result.deferred }, { nagged: 2, owner: 1, deferred: 1 });
  const byId = () => Object.fromEntries(notes.allNotes(fleet.root).map((note) => [note.id, note]));
  assert.equal(byId()[local.id].nagged.sessionId, fleet.local.id);
  assert.equal(byId()[mirrored.id].nagged.sessionId, fleet.mirrored.id);
  assert.deepEqual({ owner: byId()[codexNote.id].nagged.owner, reason: byId()[codexNote.id].nagged.reason },
    { owner: true, reason: 'its author is a codex session on aws1' });
  // A node that could not be read is a reason to come back, not proof the author
  // left, and it never spends the busy-session attempts: ten more sweeps later the
  // note is still waiting for the node.
  for (let i = 1; i <= notes.NAG_ATTEMPT_LIMIT + 4; i += 1) await sweep(start + i * 60e3);
  assert.equal(byId()[unreachable.id].nagged, null);
  assert.equal(byId()[unreachable.id].nagAttempts || 0, 0);
  assert.match(byId()[unreachable.id].lastNagAttempt.reason, /its node could not be read: aws1 did not answer/);
  // Past the node budget, it goes to Owner, saying why.
  await sweep(start + notes.NODE_UNREADABLE_LIMIT_MS + 60e3);
  assert.equal(byId()[unreachable.id].nagged.owner, true);
  assert.match(byId()[unreachable.id].nagged.reason, /its node could not be read: aws1 did not answer, for \d+ minutes/);
});

test('notes: the daemon\'s author lookup reads a node author from its node and answers 404s and Codex authors as final', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const serve = require('./serve.js');
  const { createNoteAuthorLookup } = require('./serve/schedulers.js');
  await serve.closeHostClient();
  t.after(() => serve.closeHostClient());
  let tail = null;
  let unreachable = false;
  const hosts = fleet.fakeHosts((node, type, params) => {
    if (node !== 'aws1') return undefined;
    if (unreachable && type === 'transcript') throw new Error('aws1 is unreachable');
    if (tail && type === 'transcript' && params.op === 'tail') return tail;
    return undefined;
  });
  const deps = { connectHost: hosts.connectHost, forceHostReconnect: true };
  // The same wiring startSchedulers hands the notes sweep.
  const lookup = createNoteAuthorLookup({ remoteSession: serve.remoteSession, loadSessionForAction: serve.loadSessionForAction,
    deps, root: fleet.root });

  // Not on another node: the sweep reads its own scan.
  assert.equal(await lookup(fleet.local.id), null);
  // On aws1: the node's own read of it.
  const author = await lookup(fleet.mirrored.id);
  assert.equal(author.id, fleet.mirrored.id);
  assert.equal(author.node, 'aws1');
  assert.equal(author.endedTurn, true);
  // A Codex author there: final, and said accurately (delivery refuses it by kind).
  assert.match((await lookup(fleet.remoteCodex.id)).absent, /codex session on aws1, and a note cannot be delivered there yet/);
  // The node says the session is outside the window (the daemon's 404): final.
  const old = Buffer.from(claudeTranscript({ sessionId: fleet.mirrored.id, cwd: fleet.project, text: 'long ago',
    at: Date.now() - 30 * 86400e3 }));
  tail = { path: '/node/old.jsonl', size: old.length, mtimeMs: Date.now() - 30 * 86400e3, generation: 'old', from: 0,
    bytes: old.toString('base64') };
  assert.deepEqual(await lookup(fleet.mirrored.id), { absent: 'no live session on aws1' });
  // The node cannot be read: thrown on, so the sweep waits for it.
  tail = null;
  unreachable = true;
  await assert.rejects(lookup(fleet.mirrored.id), /aws1 is unreachable/);
  assert.deepEqual(hosts.typedOn('aws1'), []);
});

// ---------- steps: a claim held by a session on the node ----------

test('steps: a claim held by a busy session on the node is not called stale', (t) => {
  const fleet = createRemoteNodeFleet(t);
  const { claimStaleness } = require('./steps.js');
  const now = Date.now();
  const claim = (session) => ({ from: new Date(now - 3 * 3600e3).toISOString(), by: { sessionId: session.id, agent: session.agent } });
  // The mirror moved five minutes ago (the node's own mtime), so the holder is busy.
  assert.equal(claimStaleness(claim(fleet.mirrored), now), null);
  assert.equal(claimStaleness(claim(fleet.local), now), null);
  // Nothing readable here for a session on the node (nothing mirrored yet, or a Codex
  // session, which is never mirrored): unknown, so no STALE flag.
  assert.equal(claimStaleness(claim(fleet.unmirrored), now), null);
  assert.equal(claimStaleness(claim(fleet.remoteCodex), now), null);
});

// ---------- health: a node-side "busy" or "unreachable" holds the review row ----------

test('health: a reviewer refused as busy or unreachable on its node holds the review row, like the local skips', () => {
  const { recordTickError } = require('./review.js');
  const rows = [];
  const record = (name, value) => rows.push({ name, ...value });
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    // Reworded messages, the same reasons: the reason decides.
    recordTickError(Object.assign(new Error('reviewer busy elsewhere'), { extra: { reason: 'busy' } }), record);
    recordTickError(Object.assign(new Error('its node was silent'), { extra: { reason: 'node-unanswered' } }), record);
    recordTickError(new Error('pane fxstray is on main but reviewer 0a1b is on aws1; nothing was sent'), record);
  } finally { process.stderr.write = write; }
  assert.deepEqual(rows.map((row) => [row.ok, row.holdResult === true, row.detail || null]), [
    [true, true, 'reviewer is mid-turn on its node'],
    [true, true, 'reviewer node did not answer'],
    [false, false, null],
  ]);
});
