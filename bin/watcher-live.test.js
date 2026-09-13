'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A scratch registry before anything can load keep.js, which reads KEEP_DIR once.
// Nothing here reaches the operator's real registry, and no test sends anything:
// delivery always goes through an injected fake.
const REGISTRY = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-watcher-live-'));
process.env.KEEP_DIR = REGISTRY;
process.env.KEEP_NO_PUSH = '1';
delete process.env.KEEP_CONFIG;
process.once('exit', () => fs.rmSync(REGISTRY, { recursive: true, force: true }));

const turnIndex = require('./turn-index.js');
const watcher = require('./turn-watcher.js');
const live = require('./watcher-live.js');
const keepApi = require('./keep.js');

const SESSION = 'live1111-2222-3333-4444-555555555555';

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-live-'));
  const priorDb = process.env.KEEP_TURN_INDEX_DB;
  process.env.KEEP_TURN_INDEX_DB = path.join(dir, 'turns.sqlite');
  fs.mkdirSync(path.join(REGISTRY, 'tasks'), { recursive: true });
  t.after(() => {
    turnIndex.close();
    if (priorDb === undefined) delete process.env.KEEP_TURN_INDEX_DB;
    else process.env.KEEP_TURN_INDEX_DB = priorDb;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(REGISTRY, 'watch'), { recursive: true, force: true });
    fs.rmSync(path.join(REGISTRY, 'tasks'), { recursive: true, force: true });
    fs.rmSync(path.join(REGISTRY, '.keep', 'decisions.json'), { force: true });
  });
  return dir;
}

function jsonl(records) {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

// One ended Claude turn, indexed, with whatever assistant text and tools the
// test needs. Returns the turn row.
function indexTurn(dir, {
  assistant = "Fixed the parser. Next, I'll run the suite.", opener = 'fix the parser',
  tools = [], id = SESSION,
} = {}) {
  const at = (s) => new Date(Date.UTC(2026, 8, 13, 0, 0, s)).toISOString();
  const content = [{ type: 'text', text: assistant }];
  tools.forEach((tool, index) => content.push({
    type: 'tool_use', id: `t${index}`, name: tool.name || 'Bash', input: tool.input || {},
  }));
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, jsonl([
    { type: 'user', sessionId: id, cwd: '/tmp/live-project', timestamp: at(0), message: { role: 'user', content: opener } },
    { type: 'assistant', sessionId: id, cwd: '/tmp/live-project', timestamp: at(5),
      message: { role: 'assistant', stop_reason: 'end_turn', content } },
  ]));
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude' }).ok, true);
  // The freshness check compares the transcript mtime against the turn's end, so
  // pin the file back to the turn's own clock.
  const endedAt = Date.parse(at(5));
  fs.utimesSync(file, new Date(endedAt), new Date(endedAt));
  return watcher.turnFor(id, 1);
}

const READY_SESSION = { id: SESSION, kind: 'claude', endedTurn: true, state: 'idle', pane: 'p1' };

function verdict(over = {}) {
  return { verdict: 'continue', message: 'continue', confidence: 0.9, model: 'fake-model', decisionId: null, ...over };
}

function allLive(over = {}) {
  return live.normalizeConfig({ live: { continue: true, 'needs-input': true, drift: true }, ...over });
}

function fakeSend() {
  const calls = [];
  const send = async (payload) => { calls.push(payload); };
  send.calls = calls;
  return send;
}

// ---------- the switch ----------

test('the live switch round-trips, defaults to off, and survives a damaged file', (t) => {
  sandbox(t);
  const off = live.loadConfig();
  assert.deepEqual(off.live, { continue: false, 'needs-input': false, drift: false }, 'off by default');
  assert.equal(off.minConfidence, 0.7);
  assert.equal(off.maxPerSessionPer10m, 1);
  assert.equal(off.maxPerHour, 12);
  assert.match(live.describeConfig(off), /shadow only/);

  live.saveConfig({ live: { continue: true, drift: true }, maxPerHour: 3 });
  const on = live.loadConfig();
  assert.deepEqual(live.liveTypes(on), ['continue', 'drift']);
  assert.equal(on.live['needs-input'], false);
  assert.equal(on.maxPerHour, 3);
  assert.match(live.describeConfig(on), /live for continue, drift/);
  assert.equal(fs.existsSync(live.configFile()), true);

  // A hand-edited file must never widen delivery.
  fs.writeFileSync(live.configFile(), '{ not json');
  assert.deepEqual(live.liveTypes(live.loadConfig()), []);
  live.saveConfig({ live: { continue: 'yes' }, minConfidence: 'high' });
  const coerced = live.loadConfig();
  assert.equal(coerced.live.continue, false, 'only true turns a type on');
  assert.equal(coerced.minConfidence, 0.7, 'a bad threshold falls back, never to zero');
});

test('a type cannot go live until its own record earns it', (t) => {
  sandbox(t);
  const graduation = { min: 30, rate: 0.9 };
  const stats = (rows) => ({ rows, graduation });

  const none = live.graduationCheck('continue', stats([]));
  assert.equal(none.ok, false);
  assert.match(none.reason, /no graded decisions yet.*30 at 90%/);

  const few = live.graduationCheck('continue', stats([{ type: 'continue', judged: 4, agree: 4, rate: 1, ready: false }]));
  assert.equal(few.ok, false);
  assert.match(few.reason, /26 more graded \(4\/30\)/);

  const poor = live.graduationCheck('continue', stats([{ type: 'continue', judged: 40, agree: 20, rate: 0.5, ready: false }]));
  assert.equal(poor.ok, false);
  assert.match(poor.reason, /agreement 50% below 90%/);
  assert.equal(/more graded/.test(poor.reason), false, 'volume is fine, so it is not listed');

  const ready = live.graduationCheck('continue', stats([{ type: 'continue', judged: 30, agree: 29, rate: 29 / 30, ready: true }]));
  assert.equal(ready.ok, true);

  // needs-input graduates on the ledger type its deliveries are recorded under.
  assert.equal(live.decisionTypeFor('needs-input'), 'answer');
  assert.equal(live.decisionTypeFor('continue'), 'continue');
  assert.equal(live.decisionTypeFor('drift'), 'drift');
});

// ---------- carve-outs ----------

test('every carve-out keeps a message from being sent', (t) => {
  sandbox(t);
  const turn = (over) => ({ last_assistant: "Fixed it. Next, I'll run the suite.", opener_kind: 'human', ...over });

  assert.equal(live.pausedCarveOut('I will hold here until you tell me to proceed.', watcher) !== null, true);
  assert.equal(live.pausedCarveOut("Fixed it. Next, I'll run the suite.", watcher), null);

  // A question about anything irreversible is Owner's, whatever the model said.
  for (const text of [
    'Should I deploy this to production now?',
    'Do you want me to delete the old column?',
    'Should I rotate the API token first?',
    'Want me to push the canary rollout?',
    'Should I issue the refund?',
  ]) assert.equal(live.riskyQuestionCarveOut(text, watcher) !== null, true, text);
  // A safe question is not carved out here (other gates still apply).
  assert.equal(live.riskyQuestionCarveOut('Should I also add a test for the empty case?', watcher), null);
  // A statement mentioning production is not a question about it.
  assert.equal(live.riskyQuestionCarveOut('I read the production config and it matches.', watcher), null);
  // A quoted mention does not trigger it either.
  assert.equal(live.riskyQuestionCarveOut('The README says "run deploy.sh". Should I add a test?', watcher), null);

  assert.equal(live.cardCarveOut(null), null, 'no card is not a reason to stay quiet');
  assert.match(live.cardCarveOut({ id: 'k1', fm: { status: 'review' } }), /not active/);
  assert.match(live.cardCarveOut({ id: 'k1', fm: { status: 'active', autocontinue: 'off' } }), /autocontinue: off/);
  assert.equal(live.cardCarveOut({ id: 'k1', fm: { status: 'active' } }), null);

  assert.match(live.releaseCarveOut(['git commit -am "wip"'], keepApi), /git commit or push/);
  assert.match(live.releaseCarveOut(['npm test', 'git push origin HEAD:master'], keepApi), /git commit or push/);
  assert.match(live.releaseCarveOut(['git push heroku main'], keepApi), /deploy|git commit or push/);
  assert.equal(live.releaseCarveOut(['npm test', 'ls -la'], keepApi), null);
  assert.equal(live.releaseCarveOut([], keepApi), null);

  assert.match(live.chainCarveOut('keep'), /automated message/);
  assert.equal(live.chainCarveOut('human'), null);

  // And the combined gate picks whichever fired.
  assert.match(live.carveOut({
    turn: turn({ last_assistant: 'Should I deploy to production?' }), card: null, commands: [], watcher, keepApi,
  }), /irreversible|production/);
  assert.equal(live.carveOut({ turn: turn(), card: { id: 'k', fm: { status: 'active' } }, commands: ['npm test'], watcher, keepApi }), null);
});

// ---------- session readiness ----------

test('a session that is busy, gone, or asking is never delivered to', (t) => {
  sandbox(t);
  assert.equal(live.sessionReady(READY_SESSION), null);
  assert.match(live.sessionReady(null), /does not see/);
  assert.match(live.sessionReady({ ...READY_SESSION, exited: true }), /exited/);
  assert.match(live.sessionReady({ ...READY_SESSION, endedTurn: false }), /mid-turn/);
  assert.match(live.sessionReady({ ...READY_SESSION, pendingQuestion: { question: 'which?' } }), /question/);
  assert.match(live.sessionReady({ ...READY_SESSION, pendingPlan: {} }), /plan/);
  assert.match(live.sessionReady({ ...READY_SESSION, notify: { type: 'permission' } }), /permission/);
  assert.match(live.sessionReady({ ...READY_SESSION, toolRunning: true }), /tool/);
  assert.match(live.sessionReady({ ...READY_SESSION, reviewer: true }), /reviewer/);
});

// ---------- freshness ----------

test('a turn the session has already moved past is stale', (t) => {
  const dir = sandbox(t);
  const turn = indexTurn(dir);
  assert.equal(live.freshness(turn), null, 'nothing has happened since');

  // Owner typed while the watcher was thinking: a newer turn exists.
  const file = path.join(dir, `${SESSION}.jsonl`);
  const at = (s) => new Date(Date.UTC(2026, 8, 13, 0, 1, s)).toISOString();
  fs.appendFileSync(file, jsonl([
    { type: 'user', sessionId: SESSION, cwd: '/tmp/live-project', timestamp: at(0), message: { role: 'user', content: 'actually do the other thing' } },
    { type: 'assistant', sessionId: SESSION, cwd: '/tmp/live-project', timestamp: at(5),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  ]));
  turnIndex.ingestFile(file, { agent: 'claude' });
  assert.match(live.freshness(turn), /already started another turn/);

  // Even with no new turn indexed, bytes written past the grace mean it moved on.
  const fresh = indexTurn(dir, { id: 'move1111-2222-3333-4444-555555555555' });
  assert.equal(live.freshness(fresh), null);
  const movedFile = path.join(dir, 'move1111-2222-3333-4444-555555555555.jsonl');
  const later = new Date(Date.parse('2026-09-13T00:00:05.000Z') + 10000);
  fs.utimesSync(movedFile, later, later);
  assert.match(live.freshness(fresh), /written since the turn ended/);
});

// ---------- rate limits ----------

test('rate limits hold per session, per hour, and forever per turn', (t) => {
  const dir = sandbox(t);
  const turn = indexTurn(dir);
  const config = allLive();
  const now = Date.now();
  assert.equal(live.rateLimit(turn, config, { now }), null);

  // The same turn is never delivered twice, however long ago it was.
  live.markDelivered(turn, now - 5 * 3600e3);
  const delivered = watcher.turnFor(SESSION, 1);
  assert.match(live.rateLimit(delivered, config, { now }), /already been delivered/);

  // One per session per 10 minutes: a second turn of the same session is held.
  const db = turnIndex.open();
  db.prepare('UPDATE turns SET delivered_at = ? WHERE session_id = ?').run(now - 60e3, SESSION);
  const file = path.join(dir, `${SESSION}.jsonl`);
  const at = (s) => new Date(Date.UTC(2026, 8, 13, 0, 2, s)).toISOString();
  fs.appendFileSync(file, jsonl([
    { type: 'user', sessionId: SESSION, cwd: '/tmp/live-project', timestamp: at(0), message: { role: 'user', content: 'next thing' } },
    { type: 'assistant', sessionId: SESSION, cwd: '/tmp/live-project', timestamp: at(5),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: "Done. Next, I'll check." }] } },
  ]));
  turnIndex.ingestFile(file, { agent: 'claude' });
  const second = watcher.turnFor(SESSION, 2);
  assert.equal(second.delivered_at, null, 'the new turn itself has not been delivered');
  assert.match(live.rateLimit(second, config, { now }), /last 10 minutes/);
  // And it lapses.
  assert.equal(live.rateLimit(second, config, { now: now + 11 * 60e3 }), null);

  // A different session is unaffected by another session's budget.
  const other = indexTurn(dir, { id: 'rate1111-2222-3333-4444-555555555555' });
  assert.equal(live.rateLimit(other, config, { now }), null);

  // Fleet-wide per hour applies to everyone.
  assert.match(live.rateLimit(other, allLive({ maxPerHour: 1 }), { now }), /last hour/);
});

// ---------- delivery ----------

test('delivery sends the prefixed message once, and records it on both sides', async (t) => {
  const dir = sandbox(t);
  const turn = indexTurn(dir);
  const send = fakeSend();
  const marked = [];
  const result = await live.maybeDeliver(turn, verdict({ decisionId: 'd-1' }), {
    config: allLive(), session: READY_SESSION, card: { id: 'k1', fm: { status: 'active' } },
    send, decisions: { markDelivered: (id, at) => marked.push({ id, at }) },
  });

  assert.equal(result.delivered, true);
  assert.equal(send.calls.length, 1, 'exactly one send');
  assert.equal(send.calls[0].sessionId, SESSION);
  assert.equal(send.calls[0].pane, 'p1');
  // The prefix is what makes the indexer file this as a keep opener rather than
  // one of Owner's nudges, which is the metric the whole project is moving.
  assert.equal(send.calls[0].text, '[keep watcher] continue');
  assert.equal(send.calls[0].text.startsWith(live.DELIVERY_PREFIX), true);

  const row = turnIndex.open().prepare('SELECT delivered_at FROM turns WHERE id = ?').get(turn.id);
  assert.ok(Number.isFinite(row.delivered_at));
  assert.deepEqual(marked.map((entry) => entry.id), ['d-1']);

  // Never twice for the same turn.
  const again = await live.maybeDeliver(watcher.turnFor(SESSION, 1), verdict(), {
    config: allLive(), session: READY_SESSION, card: null, send,
  });
  assert.equal(again.delivered, false);
  assert.match(again.reason, /already been delivered/);
  assert.equal(send.calls.length, 1);
});

test('every gate refuses delivery on its own, and none of them sends', async (t) => {
  const dir = sandbox(t);
  const base = {
    config: allLive(), session: READY_SESSION, card: { id: 'k1', fm: { status: 'active' } },
  };
  const attempt = async (over, turnOver) => {
    const send = fakeSend();
    const turn = indexTurn(dir, { id: `g${Math.random().toString(36).slice(2, 10)}-2222-3333-4444-555555555555`, ...turnOver });
    // `over` comes last so a case can remove the transport entirely.
    const result = await live.maybeDeliver(turn, over.verdict || verdict(), { ...base, send, ...over });
    assert.equal(send.calls.length, 0, `nothing sent: ${result.reason}`);
    return result.reason;
  };

  assert.match(await attempt({ config: live.normalizeConfig({}) }), /not live/);
  assert.match(await attempt({ verdict: verdict({ verdict: 'quiet' }) }), /not deliverable/);
  assert.match(await attempt({ verdict: verdict({ confidence: 0.5 }) }), /below 0\.7/);
  assert.match(await attempt({ verdict: verdict({ confidence: null }) }), /below 0\.7/);
  // needs-input with nothing proposed is an escalation, not a message.
  assert.match(await attempt({ verdict: verdict({ verdict: 'needs-input', message: '' }) }), /proposed no message/);
  assert.match(await attempt({ verdict: verdict({ model: 'fake:replay' }) }), /replays/);
  assert.match(await attempt({ session: { ...READY_SESSION, endedTurn: false } }), /mid-turn/);
  assert.match(await attempt({ card: { id: 'k1', fm: { status: 'done' } } }), /not active/);
  assert.match(await attempt({}, { assistant: 'I will hold here until you tell me to proceed.' }), /paused/);
  assert.match(await attempt({}, { assistant: 'Should I deploy this to production?' }), /irreversible|production/);
  assert.match(await attempt({}, { tools: [{ name: 'Bash', input: { command: 'git push origin HEAD:master' } }] }), /commit or push/);
  assert.match(await attempt({}, { opener: '[keep] Your card has a next step.' }), /automated message/);
  assert.match(await attempt({ send: undefined }), /no delivery transport/);

  // needs-input with a proposed answer does deliver, when its type is live.
  const send = fakeSend();
  const ok = await live.maybeDeliver(indexTurn(dir, { id: 'ni111111-2222-3333-4444-555555555555' }),
    verdict({ verdict: 'needs-input', message: 'yes, do that' }), { ...base, send });
  assert.equal(ok.delivered, true);
  assert.equal(send.calls[0].text, '[keep watcher] yes, do that');
});

test('a delivery failure is reported, not thrown, and marks nothing', async (t) => {
  const dir = sandbox(t);
  const turn = indexTurn(dir);
  const result = await live.maybeDeliver(turn, verdict(), {
    config: allLive(), session: READY_SESSION, card: null,
    send: async () => { throw new Error('session is gone'); },
  });
  assert.equal(result.delivered, false);
  assert.match(result.reason, /delivery failed: session is gone/);
  assert.equal(turnIndex.open().prepare('SELECT delivered_at FROM turns WHERE id = ?').get(turn.id).delivered_at, null);
});

test('the daemon tick delivers through the injected transport and counts it', async (t) => {
  const dir = sandbox(t);
  indexTurn(dir);
  const delivered = [];
  const result = await watcher.tick({
    env: { KEEP_WATCHER: '1' },
    selectTurns: ({ limit }) => watcher.selectTurns({ sinceMs: 0, limit }),
    judge: async () => ({ verdict: 'continue', message: 'continue', confidence: 0.9, model: 'fake' }),
    deliver: async (turn, value) => { delivered.push({ turn: turn.id, verdict: value.verdict }); return { delivered: true }; },
  });
  assert.equal(result.judged, 1);
  assert.equal(result.delivered, 1);
  assert.equal(delivered.length, 1);

  // A skipped judgment is never delivered.
  const skippedDeliveries = [];
  const skipped = await watcher.tick({
    env: { KEEP_WATCHER: '1' },
    selectTurns: ({ limit }) => watcher.selectTurns({ sinceMs: 0, limit }),
    judge: async () => ({ skipped: 'claimed' }),
    deliver: async () => { skippedDeliveries.push(1); return { delivered: true }; },
  });
  assert.equal(skippedDeliveries.length, 0);
  assert.equal(skipped.delivered, 0);
});

// ---------- Codex evidence in the Stop hook ----------

test('the Stop hook counts Codex edits, commits and pushes', () => {
  const rollout = [
    { type: 'session_meta', payload: { id: 'c1', cwd: '/tmp/x' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c1',
      input: '*** Begin Patch\n*** Update File: bin/a.js\n@@\n-x\n+y\n*** Update File: bin/b.js\n@@\n-p\n+q\n*** End Patch' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c2',
      arguments: JSON.stringify({ command: ['bash', '-lc', 'git commit -am "fix the parser"'] }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2',
      output: '[wt/turn-index 1a2b3c4] fix the parser\n 2 files changed' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c3',
      arguments: JSON.stringify({ command: ['bash', '-lc', 'git push origin HEAD:master'] }) } },
  ];
  const state = keepApi.scanStopEvidence(keepApi.emptyStopEvidence(), jsonl(rollout));
  assert.equal(state.edits, 2, 'one edit per file the patch touches');
  assert.equal(state.commits, 1);
  assert.equal(state.pushes, 1);
  assert.equal(state.bashGitWrites, 2, 'commit and push are both git writes');
  assert.equal(keepApi.hasSubstantiveStopEvidence(state), true);

  // A read-only Codex turn is still not substantive.
  const readOnly = keepApi.scanStopEvidence(keepApi.emptyStopEvidence(), jsonl([
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'r1',
      arguments: JSON.stringify({ command: ['bash', '-lc', 'rg TODO bin/'] }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'r1', output: 'bin/a.js: TODO' } },
  ]));
  assert.equal(readOnly.edits, 0);
  assert.equal(readOnly.commits, 0);
  assert.equal(keepApi.hasSubstantiveStopEvidence(readOnly), false);

  // The Claude path is unchanged.
  const claude = keepApi.scanStopEvidence(keepApi.emptyStopEvidence(), jsonl([
    { type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/a.js' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'git commit -am wip' } },
    ] } },
    { toolUseResult: { gitOperation: { commit: { sha: 'abc1234', kind: 'committed' } } } },
  ]));
  assert.equal(claude.edits, 1);
  assert.equal(claude.commits, 1);
  assert.equal(claude.bashGitWrites, 1);
});
