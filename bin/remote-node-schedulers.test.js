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
const { createRemoteNodeFleet } = require('./fixtures/remote-node-fleet.js');

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

test('review: a bootstrap message to a reviewer on the node goes to its pane there, not to a refusal', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const serve = require('./serve.js');
  await serve.closeHostClient();
  t.after(() => serve.closeHostClient());
  // Anything read from a pane on aws1 stops the send right there: what this test is
  // about is where it got to, and no keystroke is ever typed.
  const hosts = fleet.fakeHosts((node, type) => {
    if (node === 'aws1' && !['hello', 'list'].includes(type)) throw new Error(`reached aws1 with ${type}`);
  });
  const deps = { connectHost: hosts.connectHost, forceHostReconnect: true };
  // No transcript yet, mirrored or local: the bootstrap path, through the node's pane.
  await assert.rejects(
    serve.sendToSession({ sessionId: fleet.unmirrored.id, text: 'bootstrap' }, { bootstrap: true }, {}, deps),
    (error) => !STRICT_REFUSAL.test(error.message) && /reached aws1 with screen/.test(error.message));
  assert.ok(hosts.requests.some((entry) => entry.node === 'aws1' && entry.type === 'screen'
    && entry.params.pane === fleet.unmirrored.hostPaneId));
  // A mirrored reviewer has had a turn: the ordinary path, which reads it from its node.
  await assert.rejects(
    serve.sendToSession({ sessionId: fleet.mirrored.id, text: 'bootstrap' }, { bootstrap: true }, {}, deps),
    (error) => !STRICT_REFUSAL.test(error.message));
  assert.deepEqual(hosts.typedOn('aws1'), []);
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

test('notes: an expired note by a session on the node is sent to it, not handed to Owner', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const notes = require('./notes.js');
  const now = Date.now();
  const add = (session) => notes.addNote({ project: fleet.project, scopes: ['deploy'], by: { sessionId: session.id, agent: 'claude' },
    message: `held by ${session.name}`, until: new Date(now - 60e3).toISOString(), root: fleet.root, now: now - 3600e3 });
  const local = add(fleet.local);
  const mirrored = add(fleet.mirrored);
  const unreachable = add(fleet.unmirrored);
  const sent = [];
  const result = await notes.sweep({
    root: fleet.root, now,
    sessions: () => [fleet.row(fleet.local)],
    remoteSession: async (id) => {
      if (id === fleet.unmirrored.id) throw new Error('aws1 did not answer');
      return id === fleet.mirrored.id ? fleet.row(fleet.mirrored) : null;
    },
    send: async (sessionId) => { sent.push(sessionId); },
  });
  assert.deepEqual(sent.sort(), [fleet.local.id, fleet.mirrored.id].sort());
  assert.deepEqual({ nagged: result.nagged, owner: result.owner, deferred: result.deferred }, { nagged: 2, owner: 0, deferred: 1 });
  const byId = Object.fromEntries(notes.allNotes(fleet.root).map((note) => [note.id, note]));
  assert.equal(byId[local.id].nagged.sessionId, fleet.local.id);
  assert.equal(byId[mirrored.id].nagged.sessionId, fleet.mirrored.id);
  // A node that could not be read is a reason to come back, not proof the author left.
  assert.equal(byId[unreachable.id].nagged, null);
  assert.match(byId[unreachable.id].lastNagAttempt.reason, /its node could not be read: aws1 did not answer/);
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
  // Nothing readable here: idle, as a session with no transcript always was.
  assert.equal(claimStaleness(claim(fleet.unmirrored), now).idle, true);
});
