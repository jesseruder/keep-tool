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

// ---------- sends to a session on the node ----------

// A fresh Claude pane on aws1 for the send tests: it echoes what is typed into its box
// and takes it on Enter. `screen(draft)` draws what the pane shows, `list(panes)` may
// rewrite aws1's pane list, and `answer` answers anything first. Every send gets the
// same deps: the fleet's hosts, no settle wait, and the ordinary receipted delivery
// stubbed so a test can see whether it was taken.
const RULE = '─'.repeat(60);
const emptyPrompt = (draft = '') => `Claude Code\n${RULE}\n❯ ${draft}\n${RULE}\n`;

// A screen answer the way the real host renders one: plain lines, and the cursor with
// the index of its line (cursorLine). The cursor sits in the bottom-most prompt line,
// right after the marker when the box holds only the placeholder (nothing typed yet),
// else at the end of the text.
function screenAnswer(text, state) {
  const lines = String(text).split('\n');
  const plain = lines.map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s+$/, ''));
  let cursorLine = null;
  for (let index = plain.length - 1; index >= 0 && cursorLine === null; index -= 1) {
    if (/^\s*❯/.test(plain[index])) cursorLine = index;
  }
  if (cursorLine === null) return { text, lines, cursor: { x: 0, y: 0 }, cursorLine: null };
  const line = plain[cursorLine];
  const placeholder = !state.draft && /^\s*❯ Try "/.test(line);
  const x = placeholder ? line.indexOf('❯') + 2 : Math.max(line.indexOf('❯') + 2, line.length);
  return { text, lines, cursor: { x, y: cursorLine }, cursorLine };
}

function freshPaneHosts(fleet, { screen = emptyPrompt, list = null, answer = () => undefined, input = null } = {}) {
  const state = { draft: '', submitted: [], ordinary: [], inputs: 0 };
  const awsPanes = () => fleet.all.filter((session) => session.node === 'aws1').map((session) => {
    const { node: _node, hostPaneId: _hostPaneId, ...pane } = session.paneRow;
    return { ...pane, id: session.hostPaneId, meta: { ...pane.meta } };
  });
  const hosts = fleet.fakeHosts((node, type, params) => {
    const answered = answer(node, type, params, state);
    if (answered !== undefined) return answered;
    if (node !== 'aws1') return undefined;
    if (type === 'list' && list) return { panes: list(awsPanes(), state) };
    if (type === 'screen') return screenAnswer(screen(state.draft, state), state);
    if (type === 'input') {
      state.inputs += 1;
      const custom = input ? input(params, state) : undefined;
      if (custom !== undefined) return custom;
      const data = Buffer.from(params.data, 'base64').toString('utf8');
      if (data === '\r') { state.submitted.push(state.draft); state.draft = ''; } else state.draft += data;
      return {};
    }
    return undefined;
  });
  const deps = {
    connectHost: hosts.connectHost, forceHostReconnect: true, sleep: () => Promise.resolve(),
    sendToResolvedTarget: async (session, target) => { state.ordinary.push({ session, target }); return { ok: true }; },
  };
  return { hosts, deps, state };
}

const transcriptMissing = (id) => Object.assign(new Error(`no claude transcript for ${id} on this node`), { code: 'transcript-missing' });

test('send: a tell or pane send to a fresh session on the node, which has no transcript yet, is typed into its pane once the screen shows the empty prompt', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const serve = require('./serve.js');
  t.after(() => serve.closeHostClient());
  const run = async (call, options) => {
    await serve.closeHostClient();
    const fake = freshPaneHosts(fleet, options);
    return { ...fake, result: call(fake.deps) };
  };
  const paneSend = (session, text) => (deps) => serve.sendToSession({ sessionId: session.id, pane: session.pane, text }, undefined, undefined, deps);
  const tellTo = (session, text) => (deps) => serve.tellSession({ sessionId: session.id, text },
    { ...deps, excluded: new Set(), taskForSession: () => null, sendDeps: deps });

  // keep pane send (and the console's send): the node answers transcript-missing, so
  // the pane's screen decides, and the message is typed on aws1 and submitted.
  const pane = await run(paneSend(fleet.unmirrored, 'first message'));
  const sent = await pane.result;
  assert.equal(sent.ok, true);
  assert.equal(sent.transcriptPending, true);
  assert.deepEqual(pane.state.submitted, ['first message']);
  assert.deepEqual(pane.state.ordinary, [], 'no transcript-receipted delivery was attempted');
  assert.ok(pane.hosts.typedOn('aws1').every((entry) => entry.params.pane === fleet.unmirrored.hostPaneId));
  assert.deepEqual(pane.hosts.typedOn('main'), []);

  // keep tell: its guards pass a session with no turn, and the envelope is typed there.
  const told = await run(tellTo(fleet.unmirrored, 'hello from a tell'));
  const receipt = await told.result;
  assert.equal(receipt.sessionId, fleet.unmirrored.id);
  assert.equal(told.state.submitted.length, 1);
  assert.equal(told.state.submitted[0], receipt.text);
  assert.match(told.state.submitted[0], /hello from a tell/);
  assert.deepEqual(told.state.ordinary, []);

  // A node session that has a transcript takes the ordinary, receipted path.
  const spoken = await run(paneSend(fleet.mirrored, 'a second message'));
  await spoken.result;
  assert.equal(spoken.state.ordinary.length, 1);
  assert.equal(spoken.state.ordinary[0].session.transcriptPending, undefined);
  assert.equal(spoken.state.ordinary[0].target.pane, fleet.mirrored.pane);
  assert.deepEqual(spoken.state.submitted, []);
  const spokenTell = await run(tellTo(fleet.mirrored, 'a told message'));
  await spokenTell.result;
  assert.equal(spokenTell.state.ordinary.length, 1);
  assert.deepEqual(spokenTell.state.submitted, []);
});

test('send: every refusal on the fresh-session path types nothing, and a refused tell gives its hourly slot back', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const serve = require('./serve.js');
  const tell = require('./tell.js');
  t.after(() => serve.closeHostClient());
  const id = fleet.unmirrored.id;
  const refused = async (label, options, expected, { body = {}, deps: extra = {} } = {}) => {
    await serve.closeHostClient();
    const fake = freshPaneHosts(fleet, options);
    await assert.rejects(serve.sendToSession({ sessionId: id, pane: fleet.unmirrored.pane, text: 'hello', ...body },
      undefined, undefined, { ...fake.deps, ...extra }), (error) => {
      assert.match(error.message, expected, label);
      assert.equal(Boolean(error.typingStarted), false, `${label}: nothing typed`);
      return true;
    });
    assert.deepEqual(fake.state.submitted, [], `${label}: nothing submitted`);
    assert.deepEqual(fake.state.ordinary, [], `${label}: no receipted delivery`);
    return fake;
  };

  // What the screen shows.
  const onScreen = (text) => ({ screen: () => text });
  const turn = await refused('a running turn', onScreen(`✻ Working… (esc to interrupt)\n${emptyPrompt()}`),
    /is showing a dialog or a running turn; nothing was sent/);
  assert.equal(turn.state.inputs, 0);
  await refused('a trust screen', onScreen(`Do you trust the files in this folder?\n\n ❯ 1. Yes, I trust this folder\n   2. No, exit\n\n${emptyPrompt()}`),
    /is showing a dialog or a running turn; nothing was sent/);
  await refused('a dialog', onScreen(`Allow this edit?\n Enter to confirm · Esc to cancel\n${emptyPrompt()}`),
    /is showing a dialog or a running turn; nothing was sent/);
  await refused('a draft in the box', onScreen(emptyPrompt('something Owner is writing')),
    /does not show Claude's empty prompt; nothing was sent/);
  await refused('still starting', onScreen('Starting Claude Code...\n'), /does not show Claude's empty prompt; nothing was sent/);

  // The pane's input: its counter moving between the two reads, a key in the last two
  // seconds, and the host dropping the first chunk under the counter guard.
  let lists = 0;
  await refused('the counter moved', { list: (panes) => panes.map((pane) => ({ ...pane, inputCount: lists++ })) },
    /input arrived while the prompt was checked; nothing was sent/);
  await refused('a recent key', { list: (panes) => panes.map((pane) => ({ ...pane, lastInputAt: new Date(Date.now() - 500).toISOString() })) },
    /someone typed into .* in the last 2 s; nothing was sent/);
  const dropped = await refused('a dropped first chunk', { input: () => ({ dropped: true, reason: 'input', inputCount: 1 }) },
    /input arrived on the pane before this keystroke; nothing was typed/);
  assert.equal(dropped.state.inputs, 1, 'the one guarded chunk, refused by the host');

  // A transcript written between the row's read and the send: the next send takes the
  // ordinary path; this one types nothing.
  await refused('a transcript appeared', { answer: (node, type, params) => (node === 'aws1' && type === 'transcript' && params.op === 'stat'
    ? { path: '/node/fresh.jsonl', size: 10, mtimeMs: Date.now(), generation: 'g' } : undefined) },
  /has written its first transcript line since it was read; nothing was sent/);

  // A pane named by the caller on the wrong node: the session's leftover on main.
  const stray = await refused('a pane on another node', { answer: (node, type) => (node === 'main' && type === 'list'
    ? { panes: [{ ...fleet.local.paneRow, id: 'fxstray', node: undefined, meta: { ...fleet.local.paneRow.meta, sessionId: id } }] }
    : undefined) }, /pane fxstray is not the live pane of .* on aws1 .*; nothing was sent/, { body: { pane: 'fxstray' } });
  assert.deepEqual(stray.hosts.typedOn('main'), []);

  // aws1 does not answer its pane list: its pane cannot be verified.
  await refused('the node did not answer', { answer: (node, type) => {
    if (node === 'aws1' && type === 'list') throw new Error('aws1 is unreachable');
    return undefined;
  } }, /node aws1 did not answer, so the pane of .* cannot be verified; nothing was sent/);

  // A pane opened for Owner to type into is his.
  await refused('awaiting Owner', { list: (panes) => panes.map((pane) => ({ ...pane, meta: { ...pane.meta, awaitingOwnerInput: true } })) },
    /was opened for Owner to type into; nothing was sent/);

  // Witnesses that the session has had turns: the node's transcript-missing stands.
  const missing = /no claude transcript for .* on this node/;
  await refused('another account in the pane', { list: (panes) => panes.map((pane) => ({ ...pane, meta: { ...pane.meta, accountId: 'another-account' } })) }, missing);
  await refused('outside the 48 h window', { list: (panes) => panes.map((pane) => ({ ...pane, createdAt: new Date(Date.now() - 3 * 86400e3).toISOString() })) }, missing);
  const authority = path.join(fleet.root, '.keep', 'session-accounts', `${id}.json`);
  const record = fs.readFileSync(authority, 'utf8');
  fs.writeFileSync(authority, JSON.stringify({ ...JSON.parse(record), stagedAccountId: fleet.accounts.claude.id, transactionId: 'fixture' }));
  // The account read refuses a staged record before the node is even asked.
  try { await refused('a staged transfer', {}, /unfinished account handoff|no claude transcript/); } finally { fs.writeFileSync(authority, record); }
  const indexDb = path.join(fleet.base, 'turns.sqlite');
  const { DatabaseSync } = require('node:sqlite');
  const index = new DatabaseSync(indexDb);
  index.exec('CREATE TABLE turns (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, n INTEGER NOT NULL)');
  index.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL)');
  index.prepare('INSERT INTO turns (session_id, n) VALUES (?, 1)').run(id);
  index.close();
  await refused('the turn index has its turns', {}, missing, { deps: { turnIndexDb: indexDb } });
  const deliveryDirectory = path.join(fleet.base, 'delivery');
  fs.mkdirSync(path.join(deliveryDirectory, 'settled'), { recursive: true });
  fs.writeFileSync(path.join(deliveryDirectory, 'settled', `${require('./delivery.js').textHash(id)}.json`), '{}');
  await refused('a delivery journal', {}, missing, { deps: { deliveryDirectory } });
  // A turn index that exists and cannot be read is no witness: refused by its name,
  // never passed off as the node's missing transcript.
  const brokenIndex = path.join(fleet.base, 'broken-turns.sqlite');
  fs.writeFileSync(brokenIndex, 'not a database, only bytes where one should be\n'.repeat(200));
  const unreadable = /the turn index could not be read \(.*\), so whether this session has had a turn cannot be told; nothing was sent/;
  await refused('an unreadable turn index', {}, unreadable, { deps: { turnIndexDb: brokenIndex } });

  // The quiet rule reads the pane's lastInputAt on its node's clock. aws1 runs a
  // minute ahead: a key it stamps a minute and half a second "from now" was typed
  // half a second ago here, and is refused.
  const aheadMemo = new Map([['aws1', { sample: { clockOffsetMs: 60e3 }, sampledAt: Date.now() }]]);
  await refused('a recent key on a clock that runs ahead', {
    list: (panes) => panes.map((pane) => ({ ...pane, lastInputAt: new Date(Date.now() + 60e3 - 500).toISOString() })),
  }, /someone typed into .* in the last 2 s; nothing was sent/, { deps: { nodeStatsMemo: aheadMemo } });

  // A tell refused on this path gives its slot back.
  await serve.closeHostClient();
  const fake = freshPaneHosts(fleet, onScreen('Starting Claude Code...\n'));
  await assert.rejects(serve.tellSession({ sessionId: id, text: 'too early' },
    { ...fake.deps, excluded: new Set(), taskForSession: () => null, sendDeps: fake.deps }),
  /does not show Claude's empty prompt; nothing was sent/);
  assert.equal((tell.loadLedger(fleet.root).targets?.[id] || []).length, 0);
  assert.deepEqual(fake.state.submitted, []);
  // So does one refused for an unreadable turn index, by that name.
  await serve.closeHostClient();
  const indexed = freshPaneHosts(fleet);
  const indexDeps = { ...indexed.deps, turnIndexDb: brokenIndex };
  await assert.rejects(serve.tellSession({ sessionId: id, text: 'no index' },
    { ...indexDeps, excluded: new Set(), taskForSession: () => null, sendDeps: indexDeps }),
  (error) => error.status === 409 && unreadable.test(error.message));
  assert.equal((tell.loadLedger(fleet.root).targets?.[id] || []).length, 0);
  assert.deepEqual(indexed.state.submitted, []);
});

test('send: a pane\'s lastInputAt still in the future on this clock is no evidence of a key, and the send goes ahead', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const serve = require('./serve.js');
  t.after(() => serve.closeHostClient());
  await serve.closeHostClient();
  // aws1's clock runs half a minute ahead and no stats sample says so: its stamp of a
  // key typed long ago reads as the future here, which the settle and the counter cover.
  const fake = freshPaneHosts(fleet, {
    list: (panes) => panes.map((pane) => ({ ...pane, lastInputAt: new Date(Date.now() + 30e3).toISOString() })),
  });
  const sent = await serve.sendToSession({ sessionId: fleet.unmirrored.id, pane: fleet.unmirrored.pane, text: 'clock skew' },
    undefined, undefined, { ...fake.deps, nodeStatsMemo: new Map() });
  assert.equal(sent.transcriptPending, true);
  assert.deepEqual(fake.state.submitted, ['clock skew']);
});

test('send: a fresh session\'s box holding only Claude\'s dim placeholder is empty, and one with a draft under it is not', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const serve = require('./serve.js');
  t.after(() => serve.closeHostClient());
  const placeholder = '\x1b[39m❯ \x1b[2mTry "fix typecheck errors"\x1b[22m\x1b[K';
  const send = async (screen, text) => {
    await serve.closeHostClient();
    const fake = freshPaneHosts(fleet, { screen });
    const result = serve.sendToSession({ sessionId: fleet.unmirrored.id, pane: fleet.unmirrored.pane, text }, undefined, undefined, fake.deps);
    return { fake, result };
  };
  // Claude drops the suggestion as soon as a key is typed.
  const fresh = await send((draft) => (draft ? emptyPrompt(draft) : `Claude Code\n${RULE}\n${placeholder}\n${RULE}\n`), 'past the placeholder');
  assert.equal((await fresh.result).transcriptPending, true);
  assert.deepEqual(fresh.fake.state.submitted, ['past the placeholder']);
  // What a real host answers: no styles at all, the cursor right after the marker.
  const plainPlaceholder = '❯ Try "fix typecheck errors"';
  const unstyled = await send((draft) => (draft ? emptyPrompt(draft) : `Claude Code\n${RULE}\n${plainPlaceholder}\n${RULE}\n`), 'on a real host');
  assert.equal((await unstyled.result).transcriptPending, true);
  assert.deepEqual(unstyled.fake.state.submitted, ['on a real host']);
  // The same text with the cursor at its end is a draft someone typed.
  const typedLike = await send((draft, state) => { state.draft = draft || 'typed'; return `Claude Code\n${RULE}\n${plainPlaceholder}\n${RULE}\n`; }, 'not over it');
  await assert.rejects(typedLike.result, /does not show Claude's empty prompt|already contains text/);
  assert.equal(typedLike.fake.state.inputs, 0);
  // An empty-looking box drawn above the real one, which holds a draft.
  const drafted = await send(() => `${RULE}\n${placeholder}\n${RULE}\n❯ half a sentence\n${RULE}\n`, 'over a draft');
  await assert.rejects(drafted.result, /the session input box already contains text/);
  assert.equal(drafted.fake.state.inputs, 0);
});

test('send: a card tell ranks a fresh node session after the card\'s thread with turns, and picks it only when it is the only one', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const serve = require('./serve.js');
  t.after(() => serve.closeHostClient());
  const card = (ids) => ({ id: 'fixture-card', fm: { sessions: ids.map((sessionId) => ({ id: sessionId })) } });
  const tellCard = async (ids) => {
    await serve.closeHostClient();
    // Launched just now: newer than the local thread's last turn ten minutes ago.
    const fake = freshPaneHosts(fleet, { list: (panes) => panes.map((pane) => ({ ...pane, meta: { ...pane.meta, launchedAt: Date.now() } })) });
    const receipt = await serve.tellSession({ taskId: 'fixture-card', text: 'for the card' },
      { ...fake.deps, excluded: new Set(), taskForSession: () => null, loadTask: () => card(ids), sendDeps: fake.deps,
        // The local thread as the scan lists it (idle, its last turn five minutes ago);
        // the node session through the daemon's own reader.
        loadTellSession: (sessionId, loaderDeps, pin) => (sessionId === fleet.local.id ? fleet.row(fleet.local)
          : serve.loadTellSession(sessionId, loaderDeps, pin)) });
    return { ...fake, receipt };
  };
  const both = await tellCard([fleet.unmirrored.id, fleet.local.id]);
  assert.equal(both.receipt.sessionId, fleet.local.id);
  assert.equal(both.state.ordinary.length, 1);
  assert.deepEqual(both.state.submitted, []);
  const alone = await tellCard([fleet.unmirrored.id]);
  assert.equal(alone.receipt.sessionId, fleet.unmirrored.id);
  assert.equal(alone.state.submitted.length, 1);
  assert.deepEqual(alone.state.ordinary, []);
});

test('send: keep open\'s opening message to a fresh session on the node waits for the prompt on its screen and never asks for the transcript it does not have yet', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const serve = require('./serve.js');
  t.after(() => serve.closeHostClient());
  await serve.closeHostClient();
  // A node slow to start Claude: the first screens show no input box at all. Enter
  // submits the first prompt, which is when Claude writes the transcript, and the
  // turn it starts is still running.
  let reads = 0;
  const midTurn = Buffer.from(`${JSON.stringify({ type: 'user', uuid: 'fixture-user', sessionId: fleet.unmirrored.id, cwd: fleet.project,
    timestamp: new Date().toISOString(), message: { role: 'user', content: 'begin the card' } })}\n`);
  const fake = freshPaneHosts(fleet, {
    screen: (draft, state) => {
      reads += 1;
      if (reads <= 3) return 'Starting Claude Code...\n';
      return state.submitted.length ? `✻ Working… (esc to interrupt)\n${emptyPrompt()}` : emptyPrompt(draft);
    },
    answer: (node, type, params, state) => {
      if (node !== 'aws1' || type !== 'transcript' || params.sessionId !== fleet.unmirrored.id || !state.submitted.length) return undefined;
      const described = { path: '/node/fresh.jsonl', size: midTurn.length, mtimeMs: Date.now(), generation: 'g' };
      return params.op === 'tail' ? { ...described, from: 0, bytes: midTurn.toString('base64') } : described;
    },
  });
  const target = { pane: fleet.unmirrored.pane };
  // openSession's own two steps for a launch with a message: the wait for the prompt,
  // then the typing under the injection lock.
  assert.equal(await serve.waitForHostAgent(target, 'claude', fake.deps), true);
  assert.ok(reads > 3, 'the wait sat out the screens without a prompt');
  await serve.typeOpeningMessage(target, 'claude', 'begin the card', fake.deps);
  assert.deepEqual(fake.state.submitted, ['begin the card']);
  assert.ok(fake.hosts.typedOn('aws1').every((entry) => entry.params.pane === fleet.unmirrored.hostPaneId));
  assert.equal(fake.hosts.requests.some((entry) => entry.type === 'transcript'), false,
    'the opening message is judged from the screen alone');
  // The first prompt wrote the transcript and its turn is running: a tell now reads
  // that transcript like any other, and is refused as busy, typing nothing.
  await serve.closeHostClient();
  await assert.rejects(serve.tellSession({ sessionId: fleet.unmirrored.id, text: 'and a follow-up' },
    { ...fake.deps, excluded: new Set(), taskForSession: () => null, sendDeps: fake.deps }),
  (error) => error.status === 409 && error.extra.reason === 'busy');
  assert.equal(fake.state.submitted.length, 1);
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

// The Codex session's rollout as aws1 answers for it: its meta and its tail, one file.
function remoteCodexAnswer(fleet) {
  const codexId = fleet.remoteCodex.id;
  const rollout = Buffer.from([
    { timestamp: new Date(Date.now() - 9000).toISOString(), type: 'session_meta', payload: { id: codexId, cwd: fleet.project } },
    { timestamp: new Date(Date.now() - 8000).toISOString(), type: 'event_msg', payload: { type: 'user_message', message: 'deploy it' } },
    { timestamp: new Date(Date.now() - 7000).toISOString(), type: 'event_msg', payload: { type: 'agent_message', message: 'deployed' } },
    { timestamp: new Date(Date.now() - 6000).toISOString(), type: 'event_msg', payload: { type: 'task_complete' } },
  ].map((row) => `${JSON.stringify(row)}\n`).join(''));
  const described = { path: `/node/codex/rollout-${codexId}.jsonl`, size: rollout.length, mtimeMs: Date.now() - 6000, generation: 'codex' };
  return (type, params) => {
    if (type !== 'transcript' || params.sessionId !== codexId) return undefined;
    assert.equal(params.kind, 'codex');
    if (params.op === 'meta') {
      return { ...described, meta: { id: codexId, cwd: fleet.project, model: null, originator: null, parentThreadId: null,
        child: false, headless: false }, model: null };
    }
    if (params.op === 'tail') return { ...described, from: 0, bytes: rollout.toString('base64') };
    return undefined;
  };
}

test('notes: a Codex author on the node that is the reviewer or keep-spawned gets no nag; an ordinary one does', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const notes = require('./notes.js');
  const serve = require('./serve.js');
  const { createNoteAuthorLookup } = require('./serve/schedulers.js');
  await serve.closeHostClient();
  t.after(() => serve.closeHostClient());
  const codexAnswer = remoteCodexAnswer(fleet);
  const hosts = fleet.fakeHosts((node, type, params) => (node === 'aws1' ? codexAnswer(type, params) : undefined));
  const deps = { connectHost: hosts.connectHost, forceHostReconnect: true };
  const lookup = createNoteAuthorLookup({ remoteSession: serve.remoteSession, loadSessionForAction: serve.loadSessionForAction,
    deps, root: fleet.root });
  const codexId = fleet.remoteCodex.id;
  const marker = (dir) => path.join(fleet.root, '.keep', dir, codexId);
  // Each case keeps its one note in a registry of its own (the registry the fleet
  // shares holds other tests' notes); the markers are read from the fleet's root.
  const sweepOnce = async () => {
    const notesRoot = fs.mkdtempSync(path.join(fleet.base, 'notes-'));
    const start = Date.now();
    const note = notes.addNote({ project: fleet.project, scopes: ['deploy'], by: { sessionId: codexId, agent: 'codex' },
      message: 'held by codex', until: new Date(start - 60e3).toISOString(), root: notesRoot, now: start - 3600e3 });
    const sent = [];
    await notes.sweep({ root: notesRoot, now: start, sessions: () => [], remoteSession: lookup,
      send: async (sessionId) => { sent.push(sessionId); } });
    const after = notes.allNotes(notesRoot).find((candidate) => candidate.id === note.id);
    return { sent, after };
  };

  // The reviewer: its row says so, and the sweep defers as it does for a local reviewer.
  fs.mkdirSync(path.dirname(marker('reviewer')), { recursive: true });
  fs.writeFileSync(marker('reviewer'), '');
  const reviewer = await sweepOnce();
  assert.deepEqual(reviewer.sent, []);
  assert.equal(reviewer.after.nagged, null);
  assert.match(reviewer.after.lastNagAttempt.reason, /the reviewer is not auto-continued/);
  fs.rmSync(marker('reviewer'));

  // A keep-spawned run: no session, so the note goes to Owner, never to the run.
  fs.mkdirSync(path.dirname(marker('spawned')), { recursive: true });
  fs.writeFileSync(marker('spawned'), '');
  const spawned = await sweepOnce();
  assert.deepEqual(spawned.sent, []);
  assert.deepEqual({ owner: spawned.after.nagged.owner, reason: spawned.after.nagged.reason }, { owner: true, reason: 'no live session on aws1' });
  fs.rmSync(marker('spawned'));

  // An ordinary one is nagged.
  const ordinary = await sweepOnce();
  assert.deepEqual(ordinary.sent, [codexId]);
  assert.equal(ordinary.after.nagged.sessionId, codexId);
  assert.deepEqual(hosts.typedOn('aws1'), []);
});

test('notes: the daemon\'s author lookup reads a node author from its node, Codex included, and answers 404s and Pi authors as final', async (t) => {
  const fleet = createRemoteNodeFleet(t);
  const serve = require('./serve.js');
  const { createNoteAuthorLookup } = require('./serve/schedulers.js');
  await serve.closeHostClient();
  t.after(() => serve.closeHostClient());
  let tail = null;
  let unreachable = false;
  const codexId = fleet.remoteCodex.id;
  const codexAnswer = remoteCodexAnswer(fleet);
  const hosts = fleet.fakeHosts((node, type, params) => {
    if (node !== 'aws1') return undefined;
    if (unreachable && type === 'transcript') throw new Error('aws1 is unreachable');
    const codexAnswered = codexAnswer(type, params);
    if (codexAnswered) return codexAnswered;
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
  // A Codex author there: read from its node's rollout meta and tail, like a Claude one.
  const codexAuthor = await lookup(codexId);
  assert.equal(codexAuthor.id, codexId);
  assert.equal(codexAuthor.kind, 'codex');
  assert.equal(codexAuthor.node, 'aws1');
  assert.equal(codexAuthor.endedTurn, true);
  // An author whose agent is Pi is still final, and said accurately.
  const piLookup = createNoteAuthorLookup({ remoteSession: serve.remoteSession, loadSessionForAction: serve.loadSessionForAction,
    deps, root: fleet.root, sessionLocation: () => ({ agent: 'pi', node: 'aws1' }) });
  assert.match((await piLookup(fleet.mirrored.id)).absent, /pi session on aws1, and a note cannot be delivered there yet/);
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
