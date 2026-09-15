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

// A second ended turn of the same session, for the per-session budget.
function secondTurn(dir, id = SESSION) {
  const at = (s) => new Date(Date.UTC(2026, 8, 13, 0, 2, s)).toISOString();
  const file = path.join(dir, `${id}.jsonl`);
  fs.appendFileSync(file, jsonl([
    { type: 'user', sessionId: id, cwd: '/tmp/live-project', timestamp: at(0), message: { role: 'user', content: 'next thing' } },
    { type: 'assistant', sessionId: id, cwd: '/tmp/live-project', timestamp: at(5),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: "Done. Next, I'll check." }] } },
  ]));
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude' }).ok, true);
  return watcher.turnFor(id, 2);
}

const ACTIVE_CARD = { id: 'k1', fm: { status: 'active' } };
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
  assert.deepEqual(off.live, { continue: false, 'needs-input': false, drift: false, resource: false }, 'off by default');
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

// ---------- the delivered text ----------

test('a message carrying control characters is refused, never repaired', (t) => {
  sandbox(t);
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  const ESC = String.fromCharCode(27);
  const CTRL_U = String.fromCharCode(21);

  // A carriage return erases the prefix and submits whatever follows it.
  assert.equal(live.safeDeliveryText(`[keep watcher] approve release${CR}`), null);
  assert.equal(live.safeDeliveryText(`[keep watcher] ${CTRL_U}rm -rf /`), null, 'Ctrl-U kills the line');
  assert.equal(live.safeDeliveryText(`[keep watcher] a${LF}b`), null);
  assert.equal(live.safeDeliveryText(`[keep watcher] ${ESC}[2K deploy`), null, 'an escape sequence');
  assert.equal(live.safeDeliveryText(`[keep watcher] a${String.fromCharCode(0)}b`), null);
  assert.equal(live.safeDeliveryText(`[keep watcher] a${String.fromCharCode(0x200b)}b`), null, 'zero width');
  assert.equal(live.safeDeliveryText(`[keep watcher] a${String.fromCharCode(0x202e)}b`), null, 'bidi override');
  assert.equal(live.safeDeliveryText(`[keep watcher] a${String.fromCharCode(0x2028)}b`), null, 'line separator');
  assert.equal(live.safeDeliveryText(`[keep watcher] ${'x'.repeat(1200)}`), null, 'over the cap');
  assert.equal(live.safeDeliveryText(''), null);
  assert.equal(live.safeDeliveryText('   '), null);

  // Clean text passes, and runs of spaces are the one thing worth repairing.
  assert.equal(live.safeDeliveryText('[keep watcher] continue'), '[keep watcher] continue');
  assert.equal(live.safeDeliveryText('[keep watcher]   yes, do that  '), '[keep watcher] yes, do that');
  assert.equal(live.safeDeliveryText('[keep watcher] café — naïve'), '[keep watcher] café — naïve', 'ordinary Unicode is fine');
});

test('an unsafe message is not delivered at all', async (t) => {
  const dir = sandbox(t);
  const send = fakeSend();
  const result = await live.maybeDeliver(indexTurn(dir), verdict({ verdict: 'drift', message: `revert that${String.fromCharCode(13)}rm -rf /` }), {
    config: allLive(), session: READY_SESSION, card: ACTIVE_CARD, send,
  });
  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'unsafe-text');
  assert.equal(send.calls.length, 0);
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

  // Live delivery requires an active card. A session with none — or with only a
  // card that has since closed — is exactly when a stray "continue" is worst.
  assert.match(live.cardCarveOut(null), /needs an active card/);
  assert.match(live.cardCarveOut({ id: 'k1', fm: { status: 'done' } }), /is done, not active/);
  assert.match(live.cardCarveOut({ id: 'k1', fm: { status: 'deferred' } }), /is deferred, not active/);
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

  // A carve-out reads the whole turn, not the last 600 characters: a pause or a
  // risky question announced before a wall of closing prose still counts.
  const buried = (lead) => ({ assistant_text: `${lead}\n\n${'Then I tidied the imports. '.repeat(40)}`, opener_kind: 'human' });
  assert.match(live.pausedCarveOut(buried('I will hold here until you tell me to proceed.'), watcher), /paused/);
  assert.match(live.riskyQuestionCarveOut(buried('Should I deploy this to production?'), watcher), /irreversible|production/);
  // A risky question in an earlier assistant record of the same turn.
  assert.match(live.riskyQuestionCarveOut({
    last_assistant: 'Tidied the imports.', assistantMessages: ['Should I rotate the token first?', 'Tidied the imports.'],
  }, watcher), /irreversible|production/);
  // And one that ends looking like a plan.
  assert.match(live.riskyQuestionCarveOut({
    assistant_text: 'Should I deploy to production? Next, I can run the checks.', opener_kind: 'human',
  }, watcher), /irreversible|production/);
  // A risky word in a sentence that is not asking anything is still not a gate.
  assert.equal(live.riskyQuestionCarveOut({ assistant_text: 'I read the deploy script. Should I add a test?' }, watcher), null);

  // Release detection parses commands the way keep.js's deploy provenance does.
  for (const command of [
    'git push origin HEAD:master', 'env git push', 'sudo git push', 'git "push"',
    'npm test && git push origin HEAD:master', 'git commit -am wip; npm test',
    'git -C /tmp/x commit -m x',
  ]) assert.notEqual(live.releaseCarveOut([command], keepApi), null, command);
  assert.equal(live.releaseCarveOut(['git status', 'rg push bin/'], keepApi), null);
  // A commit recorded on the turn row is a release signal on its own.
  assert.match(live.releaseCarveOut([], keepApi, { commits: '["1a2b3c4"]' }), /produced a commit/);
  assert.equal(live.releaseCarveOut([], keepApi, { commits: '[]' }), null);

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

  // The same turn is never delivered twice, however long ago it was: the
  // reservation row is the primary key on turn_id.
  assert.equal(live.reserve(turn, config, 'continue', { now: now - 5 * 3600e3 }).ok, true);
  live.markDelivered(turn, now - 5 * 3600e3);
  const delivered = watcher.turnFor(SESSION, 1);
  assert.match(live.rateLimit(delivered, config, { now }), /already been delivered/);
  assert.equal(live.reserve(delivered, config, 'continue', { now }).ok, false, 'and it cannot be reserved again');

  // One per session per 10 minutes: a second turn of the same session is held.
  const db = turnIndex.open();
  db.prepare('UPDATE deliveries SET reserved_at = ? WHERE session_id = ?').run(now - 60e3, SESSION);
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
    config: allLive(), session: READY_SESSION, card: ACTIVE_CARD,
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
    config: allLive(), session: READY_SESSION, card: ACTIVE_CARD, send,
  });
  assert.equal(again.delivered, false);
  assert.match(again.reason, /already been delivered/);
  assert.equal(send.calls.length, 1);
});

test('every gate refuses delivery on its own, and none of them sends', async (t) => {
  const dir = sandbox(t);
  const base = {
    config: allLive(), session: READY_SESSION, card: ACTIVE_CARD,
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

test('the world is re-checked after the model call and again inside the lock', async (t) => {
  const dir = sandbox(t);
  const base = { config: allLive(), session: READY_SESSION, card: ACTIVE_CARD };

  // Owner typed while the model was thinking: a newer turn exists by the time
  // delivery is attempted.
  const moved = indexTurn(dir, { id: 'moved111-2222-3333-4444-555555555555' });
  const movedFile = path.join(dir, 'moved111-2222-3333-4444-555555555555.jsonl');
  const at = (s) => new Date(Date.UTC(2026, 8, 13, 0, 5, s)).toISOString();
  fs.appendFileSync(movedFile, jsonl([
    { type: 'user', sessionId: 'moved111-2222-3333-4444-555555555555', cwd: '/tmp/live-project', timestamp: at(0),
      message: { role: 'user', content: 'actually do the other thing' } },
    { type: 'assistant', sessionId: 'moved111-2222-3333-4444-555555555555', cwd: '/tmp/live-project', timestamp: at(5),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
  ]));
  turnIndex.ingestFile(movedFile, { agent: 'claude' });
  const humanArrived = fakeSend();
  const blocked = await live.maybeDeliver(moved, verdict(), { ...base, send: humanArrived });
  assert.equal(blocked.delivered, false);
  assert.match(blocked.reason, /already started another turn/);
  assert.equal(humanArrived.calls.length, 0);
  // And the slot it reserved was handed back.
  assert.equal(turnIndex.open().prepare('SELECT COUNT(*) AS n FROM deliveries').get().n, 0);

  // The switch was turned off between the verdict and the send.
  const turn = indexTurn(dir, { id: 'offff111-2222-3333-4444-555555555555' });
  live.saveConfig({ live: { continue: false, 'needs-input': false, drift: false } });
  const switchedOff = fakeSend();
  // The initial gates ran against the on-config; revalidate re-reads the file,
  // which is what `keep watcher live off` changes.
  const off = await live.maybeDeliver(turn, verdict(), {
    ...base, send: switchedOff, reloadConfig: true,
  });
  assert.equal(off.delivered, false);
  assert.match(off.reason, /moved-on: continue was switched off/);
  assert.equal(switchedOff.calls.length, 0);
  assert.equal(turnIndex.open().prepare('SELECT COUNT(*) AS n FROM deliveries').get().n, 0, 'and no slot was spent');

  // A session that changed after the snapshot is caught by the fresh read.
  live.saveConfig({ live: { continue: true, 'needs-input': false, drift: false } });
  const stale = indexTurn(dir, { id: 'stale111-2222-3333-4444-555555555555' });
  const staleSend = fakeSend();
  const refused = await live.maybeDeliver(stale, verdict(), {
    ...base, send: staleSend,
    freshSession: async () => ({ ...READY_SESSION, pendingQuestion: { question: 'which one?' } }),
  });
  assert.equal(refused.delivered, false);
  assert.match(refused.reason, /moved-on:.*question/);
  assert.equal(staleSend.calls.length, 0);

  // The precondition is handed to the transport and runs inside its lock.
  const ok = indexTurn(dir, { id: 'lockk111-2222-3333-4444-555555555555' });
  let preconditionRan = 0;
  const locking = async ({ precondition }) => { preconditionRan += 1; assert.equal(await precondition(), null); };
  locking.calls = [];
  const delivered = await live.maybeDeliver(ok, verdict(), {
    ...base, send: locking, freshSession: async () => READY_SESSION,
  });
  assert.equal(delivered.delivered, true);
  assert.equal(preconditionRan, 1, 'the transport re-checks once more before typing');

  // And a precondition that fails inside the lock aborts the send.
  const late = indexTurn(dir, { id: 'latee111-2222-3333-4444-555555555555' });
  const aborting = async ({ precondition }) => {
    const movedOn = await precondition();
    if (movedOn) throw new Error(movedOn);
  };
  let sessionState = READY_SESSION;
  const abortResult = await live.maybeDeliver(late, verdict(), {
    ...base, send: aborting,
    freshSession: async () => { const value = sessionState; sessionState = { ...READY_SESSION, endedTurn: false }; return value; },
  });
  assert.equal(abortResult.delivered, false);
  assert.match(abortResult.reason, /delivery failed: moved-on:.*mid-turn/);
  assert.equal(turnIndex.open().prepare('SELECT delivered_at FROM turns WHERE id = ?').get(late.id).delivered_at, null);
});

test('two deliveries racing the last slot produce exactly one send', async (t) => {
  const dir = sandbox(t);
  const first = indexTurn(dir, { id: 'race1111-2222-3333-4444-555555555555' });
  const second = indexTurn(dir, { id: 'race2222-2222-3333-4444-555555555555' });
  // One slot left in the fleet's hour.
  const config = allLive({ maxPerHour: 1 });
  const send = fakeSend();
  const base = {
    config, card: ACTIVE_CARD, send,
    session: { ...READY_SESSION }, freshSession: async () => READY_SESSION,
  };
  const [a, b] = await Promise.all([
    live.maybeDeliver(first, verdict(), { ...base, session: { ...READY_SESSION, id: first.session_id } }),
    live.maybeDeliver(second, verdict(), { ...base, session: { ...READY_SESSION, id: second.session_id } }),
  ]);
  const winners = [a, b].filter((result) => result.delivered);
  const losers = [a, b].filter((result) => !result.delivered);
  assert.equal(winners.length, 1, 'the reservation is what decides, not the count');
  assert.equal(send.calls.length, 1);
  assert.match(losers[0].reason, /last hour/);
  assert.equal(turnIndex.open().prepare('SELECT COUNT(*) AS n FROM deliveries WHERE sent_at IS NOT NULL').get().n, 1);
});

test('a malformed switch file turns everything off rather than part of it', (t) => {
  sandbox(t);
  // The shape the review called out: a live flag beside an unparseable threshold.
  assert.deepEqual(live.liveTypes(live.normalizeConfig({ live: { continue: true }, minConfidence: [0.1] })), []);
  for (const bad of [
    { live: { continue: true }, minConfidence: 0 },
    { live: { continue: true }, minConfidence: 1.5 },
    { live: { continue: true }, minConfidence: '0.8' },
    { live: { continue: true }, maxPerHour: -1 },
    { live: { continue: true }, maxPerHour: 2.5 },
    { live: { continue: true }, maxPerSessionPer10m: null },
    { live: { continue: 'true' } },
    { live: { continue: true, bogus: true } },
    { live: [true] },
    { live: 'on' },
    [1, 2, 3],
    'on',
  ]) assert.deepEqual(live.liveTypes(live.normalizeConfig(bad)), [], JSON.stringify(bad));
  assert.equal(live.normalizeConfig({ live: { continue: true }, minConfidence: [0.1] }).invalid, true);

  // A well-formed one still works, including at the edges of the ranges.
  assert.deepEqual(live.liveTypes(live.normalizeConfig({ live: { continue: true }, minConfidence: 1, maxPerHour: 0 })), ['continue']);
});

test('a card that has closed is found, so the inactive-card gate can refuse it', (t) => {
  sandbox(t);
  const write = (id, status, dir = 'tasks') => {
    fs.mkdirSync(path.join(REGISTRY, dir), { recursive: true });
    fs.writeFileSync(path.join(REGISTRY, dir, `${id}.md`), [
      '---', `id: ${id}`, 'title: Live delivery', `status: ${status}`, 'kind: task',
      'created: 2026-09-13T00:00', 'updated: 2026-09-13T00:00', 'sessions:',
      `  - id: ${SESSION}`, '    agent: claude', '    at: 2026-09-13T00:00', '---', '', '## Log', '',
    ].join('\n'));
  };
  const turn = { session_id: SESSION };

  write('live-done', 'done');
  const done = live.cardFor(turn, keepApi);
  assert.equal(done?.id, 'live-done', 'a done card is still the session\'s card');
  assert.match(live.cardCarveOut(done), /is done, not active/);
  fs.rmSync(path.join(REGISTRY, 'tasks', 'live-done.md'));

  write('live-defer', 'deferred');
  assert.match(live.cardCarveOut(live.cardFor(turn, keepApi)), /is deferred, not active/);
  fs.rmSync(path.join(REGISTRY, 'tasks', 'live-defer.md'));

  // An archived card counts too.
  write('live-arch', 'done', 'archive');
  assert.equal(live.cardFor(turn, keepApi)?.id, 'live-arch');
  fs.rmSync(path.join(REGISTRY, 'archive', 'live-arch.md'));

  assert.equal(live.cardFor(turn, keepApi), null, 'no card at all');
  assert.match(live.cardCarveOut(null), /needs an active card/);

  write('live-active', 'active');
  const active = live.cardFor(turn, keepApi);
  assert.equal(active?.id, 'live-active');
  assert.equal(live.cardCarveOut(active), null);
  fs.rmSync(path.join(REGISTRY, 'tasks', 'live-active.md'));
});

test('a delivery failure is reported, not thrown, and marks nothing', async (t) => {
  const dir = sandbox(t);
  const turn = indexTurn(dir);
  const result = await live.maybeDeliver(turn, verdict(), {
    config: allLive(), session: READY_SESSION, card: ACTIVE_CARD,
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

test('a watcher-delivered message is a keep opener, so it can never chain', (t) => {
  const dir = sandbox(t);
  const id = 'chain111-2222-3333-4444-555555555555';
  const file = path.join(dir, `${id}.jsonl`);
  const at = (m, s) => new Date(Date.UTC(2026, 8, 13, 1, m, s)).toISOString();
  fs.writeFileSync(file, jsonl([
    { type: 'user', sessionId: id, cwd: '/tmp/live-project', timestamp: at(0, 0), message: { role: 'user', content: 'fix the parser' } },
    { type: 'assistant', sessionId: id, cwd: '/tmp/live-project', timestamp: at(0, 5),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: "Fixed. Next, I'll run the suite." }] } },
    // Exactly what live delivery types into the session.
    { type: 'user', sessionId: id, cwd: '/tmp/live-project', timestamp: at(1, 0), message: { role: 'user', content: '[keep watcher] continue' } },
    { type: 'assistant', sessionId: id, cwd: '/tmp/live-project', timestamp: at(1, 5),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: "Suite is green. Next, I'll write docs." }] } },
  ]));
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude' }).ok, true);

  const turns = turnIndex.turnsForSession(id);
  assert.deepEqual(turns.map((row) => row.opener_kind), ['human', 'keep'],
    'the watcher\'s own prefix must not read as Owner typing');
  // And that is what stops the watcher answering itself forever.
  assert.match(live.chainCarveOut(turns[1].opener_kind), /automated message/);

  // Every voice Keep speaks in counts, and a lookalike does not.
  const kinds = ['[keep] check in first', '[keep watcher] continue', '[keep coordination] hold',
    '[keeper] not us', '[keep watcher extra] no'];
  const seen = kinds.map((text) => {
    const each = `k${kinds.indexOf(text)}1111-2222-3333-4444-555555555555`;
    const path2 = path.join(dir, `${each}.jsonl`);
    fs.writeFileSync(path2, jsonl([
      { type: 'user', sessionId: each, cwd: '/tmp/live-project', timestamp: at(2, 0), message: { role: 'user', content: text } },
      { type: 'assistant', sessionId: each, cwd: '/tmp/live-project', timestamp: at(2, 5),
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
    ]));
    turnIndex.ingestFile(path2, { agent: 'claude' });
    return turnIndex.turnsForSession(each)[0].opener_kind;
  });
  assert.deepEqual(seen, ['keep', 'keep', 'keep', 'human', 'human']);
});

test('a Codex exec_command is indexed as a command the release gate can see', (t) => {
  const dir = sandbox(t);
  const id = '0199cccc-1111-2222-3333-444444444444';
  const file = path.join(dir, `rollout-2026-09-13T01-00-00-${id}.jsonl`);
  fs.writeFileSync(file, jsonl([
    { type: 'session_meta', timestamp: '2026-09-13T01:00:00.000Z', payload: { id, cwd: '/tmp/live-project', source: 'cli' } },
    { type: 'response_item', timestamp: '2026-09-13T01:00:01.000Z', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ship it' }] } },
    // exec_command spells its command `cmd`, not `command`.
    { type: 'response_item', timestamp: '2026-09-13T01:00:02.000Z', payload: {
      type: 'function_call', name: 'exec_command', call_id: 'e1',
      arguments: JSON.stringify({ cmd: 'git push origin HEAD:master' }) } },
    { type: 'response_item', timestamp: '2026-09-13T01:00:03.000Z', payload: { type: 'agent_message', text: 'Pushed.' } },
    { type: 'event_msg', timestamp: '2026-09-13T01:00:04.000Z', payload: { type: 'task_complete' } },
  ]));
  assert.equal(turnIndex.ingestFile(file).ok, true);
  const turn = watcher.turnFor(id, 1);
  const commands = live.turnCommands(turn);
  assert.deepEqual(commands, ['git push origin HEAD:master'], 'the cmd spelling is recorded');
  assert.match(live.releaseCarveOut(commands, keepApi, turn), /git commit or push/);
});

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

  // A transcript is untrusted text. Commit-shaped output with no git command
  // behind it — a README, a test fixture, a pasted log — counts nothing.
  const forged = keepApi.scanStopEvidence(keepApi.emptyStopEvidence(), jsonl([
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'f1',
      arguments: JSON.stringify({ command: ['bash', '-lc', 'cat README.md'] }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'f1',
      output: 'Example output:\n[main 1a2b3c4] fix the parser\n 2 files changed' } },
  ]));
  assert.equal(forged.commits, 0, 'no git command, no commit');
  assert.equal(keepApi.hasSubstantiveStopEvidence(forged), false);

  // An output whose call_id matches no call at all counts nothing either.
  const orphan = keepApi.scanStopEvidence(keepApi.emptyStopEvidence(), jsonl([
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'nope',
      output: '[main 1a2b3c4] fix the parser' } },
  ]));
  assert.equal(orphan.commits, 0);

  // And a commit is only counted once, even if the output is repeated.
  const repeated = keepApi.scanStopEvidence(keepApi.emptyStopEvidence(), jsonl([
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'r9',
      arguments: JSON.stringify({ command: ['bash', '-lc', 'git commit -am wip'] }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'r9', output: '[main 1a2b3c4] wip' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'r9', output: '[main 1a2b3c4] wip' } },
  ]));
  assert.equal(repeated.commits, 1);

  // exec_command's `cmd` spelling is seen by the hook too.
  const execCommand = keepApi.scanStopEvidence(keepApi.emptyStopEvidence(), jsonl([
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'x1',
      arguments: JSON.stringify({ cmd: 'git push origin HEAD:master' }) } },
  ]));
  assert.equal(execCommand.pushes, 1);
  assert.equal(execCommand.bashGitWrites, 1);

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

// ---------- the recheck: unknown settings, abandoned reservations, whole inputs ----------

test('a git command named inside an argument is not evidence of a release', () => {
  // The Stop hook decides whether a session owes Keep a check-in. Searching for
  // the words is not doing the thing, however commit-shaped the output looks.
  const searched = keepApi.scanStopEvidence(keepApi.emptyStopEvidence(), jsonl([
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'a1',
      arguments: JSON.stringify({ command: ['bash', '-lc', 'rg "git commit" README.md'] }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'a1',
      output: 'README.md:12: run git commit -am wip\n[main 1a2b3c4] fix the parser' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'a2',
      arguments: JSON.stringify({ command: ['bash', '-lc', 'echo "git push" >> NOTES.md'] }) } },
  ]));
  assert.equal(searched.commits, 0, 'a search is not a commit');
  assert.equal(searched.pushes, 0);
  assert.equal(searched.bashGitWrites, 0);

  // An object-valued `arguments` is the same call, spelled the other way.
  const objectArgs = keepApi.scanStopEvidence(keepApi.emptyStopEvidence(), jsonl([
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'o1',
      arguments: { command: ['bash', '-lc', 'git commit -am "real work"'] } } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'o1',
      output: '[main abc1234] real work\n 1 file changed' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'o2',
      arguments: { cmd: 'git push origin HEAD:master' } } },
  ]));
  assert.equal(objectArgs.commits, 1);
  assert.equal(objectArgs.pushes, 1);
  assert.equal(objectArgs.bashGitWrites, 2);

  // And the wrappers a push can hide behind are all seen through.
  for (const command of [
    ['bash', '-lc', 'env -i git push'],
    ['bash', '-lc', 'sudo -u root git push'],
    ['bash', '-lc', 'npm test && git push'],
    ['/usr/bin/git', 'push'],
    ['bash', '-lc', 'git "push"'],
  ]) {
    const state = keepApi.scanStopEvidence(keepApi.emptyStopEvidence(), jsonl([
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'w1',
        arguments: JSON.stringify({ command }) } },
    ]));
    assert.equal(state.pushes, 1, command.join(' '));
  }
});

test('an unknown setting turns everything off rather than being ignored', (t) => {
  sandbox(t);
  // The reviewer's case: a typo in a limit read as "no opinion" would raise the
  // cap the author was trying to lower, while leaving `live` standing.
  const typo = live.normalizeConfig({ live: { continue: true }, maxPerHoru: 1 });
  assert.deepEqual(live.liveTypes(typo), []);
  assert.equal(typo.invalid, true);
  assert.equal(typo.maxPerHour, 12, 'and nothing of the typo is honoured');

  for (const bad of [
    { live: { continue: true }, maxPerSessionsPer10m: 1 },
    { live: { continue: true }, minConfidenc: 0.99 },
    { live: { continue: true }, comment: 'why this is on' },
    { continue: true },
    { live: { continue: true }, invalid: false },
  ]) assert.deepEqual(live.liveTypes(live.normalizeConfig(bad)), [], JSON.stringify(bad));

  // But a config this module itself produced round-trips: `invalid` is its own
  // report on a file it read, not a setting, so saving one back is not a typo.
  live.saveConfig({ live: { continue: true, 'needs-input': false, drift: false }, maxPerHour: 4 });
  const loaded = live.loadConfig();
  assert.equal(loaded.invalid, false);
  live.saveConfig({ ...loaded, live: { ...loaded.live, drift: true } });
  const again = live.loadConfig();
  assert.deepEqual(live.liveTypes(again), ['continue', 'drift']);
  assert.equal(again.maxPerHour, 4, 'the rest of the file survives the round trip');
});

test('a reservation belongs to the attempt that took it', (t) => {
  const dir = sandbox(t);
  const turn = indexTurn(dir);
  const config = allLive();
  const now = Date.now();
  const rows = () => turnIndex.open().prepare('SELECT turn_id, token, sent_at FROM deliveries').all();

  // Nobody but the holder may give a reservation back. An attempt that aborted
  // minutes ago must not delete the row a later attempt is sending under, or two
  // messages go out under one slot.
  const first = live.reserve(turn, config, 'continue', { now: now - 6 * 60e3 });
  assert.equal(first.ok, true);
  assert.match(String(first.token), /^[0-9a-f]{32}$/);
  assert.equal(live.releaseReservation(turn, { token: 'not-the-token' }), 0, 'a stranger deletes nothing');
  assert.equal(live.releaseReservation(turn, {}), 0, 'and neither does nobody');
  assert.equal(rows().length, 1);

  // The holder can, and then the turn is free to be tried again.
  assert.equal(live.releaseReservation(turn, { token: first.token }), 1);
  assert.equal(rows().length, 0);
  const second = live.reserve(turn, config, 'continue', { now });
  assert.equal(second.ok, true);
  assert.notEqual(second.token, first.token);
  // The first attempt, finally getting round to its abort, must not take the
  // second attempt's row with it.
  assert.equal(live.releaseReservation(turn, { token: first.token }), 0);
  assert.deepEqual(rows().map((row) => row.token), [second.token]);

  // An unconfirmed row that expired still counts: nobody can tell whether its
  // Enter landed, and freeing the slot early is the mistake that types twice.
  turnIndex.open().prepare('UPDATE deliveries SET reserved_at = ? WHERE turn_id = ?')
    .run(now - 6 * 60e3, turn.id);
  assert.equal(rows()[0].sent_at, null, 'still unconfirmed');
  const sameSession = secondTurn(dir);
  assert.match(live.rateLimit(sameSession, config, { now }), /last 10 minutes/,
    'an expired unsent row still spends the session budget');
  const other = indexTurn(dir, { id: 'stale111-2222-3333-4444-555555555555' });
  assert.match(live.rateLimit(other, allLive({ maxPerHour: 1 }), { now }), /last hour/,
    'and the fleet budget');
  // Its own turn stays blocked whatever its age: the verdict for it already exists.
  assert.match(live.rateLimit(turn, allLive({ maxPerSessionPer10m: 9, maxPerHour: 9 }), { now }),
    /already been delivered/);
  assert.equal(live.reserve(turn, allLive({ maxPerSessionPer10m: 9, maxPerHour: 9 }), 'continue', { now }).ok, false);

  // And the ten-minute window still lapses on its own.
  assert.equal(live.rateLimit(sameSession, config, { now: now + 11 * 60e3 }), null);
});

test('the release carve-out judges the tool input, or refuses to judge at all', (t) => {
  const dir = sandbox(t);
  // Short enough to keep as JSON: judged exactly as it was written.
  const turn = indexTurn(dir, { tools: [{ name: 'Bash', input: { command: 'npm test && git push', description: 'run the suite' } }] });
  assert.deepEqual(live.turnCommands(turn), ['npm test && git push']);
  assert.match(live.releaseCarveOut(live.turnCommands(turn), keepApi, turn), /git commit or push/);

  // Too long, so the JSON wrapper is gone. The command column survives, but for
  // an argv it is a *joined* copy — and judging a joined argv is what turns an
  // argument into a command. So a truncated input is not judged: it is refused.
  const long = `npm test -- --filter ${'x'.repeat(2400)} && echo done`;
  assert.ok(long.length > turnIndex.TOOL_CAP);
  const big = indexTurn(dir, {
    id: 'trunc111-2222-3333-4444-555555555555',
    tools: [{ name: 'Bash', input: { command: long, description: 'run the suite' } }],
  });
  const db = turnIndex.open();
  const stored = db.prepare("SELECT text, command FROM messages WHERE turn_id = ? AND kind = 'tool_use'").get(big.id);
  assert.equal(stored.text.length, turnIndex.TOOL_CAP, 'the JSON wrapper was truncated');
  assert.equal(stored.command, long, 'while the column keeps the command itself');
  assert.deepEqual(live.turnCommands(big), [live.UNREADABLE_COMMAND]);
  assert.equal(live.releaseCarveOut(live.turnCommands(big), keepApi, big), live.UNREADABLE_REASON);

  // A long `description` truncates the wrapper just the same, and is refused for
  // the same reason: what ran cannot be read back.
  const described = indexTurn(dir, {
    id: 'descr111-2222-3333-4444-555555555555',
    tools: [{ name: 'Bash', input: { command: 'npm test', description: 'w'.repeat(3000) } }],
  });
  assert.deepEqual(live.turnCommands(described), [live.UNREADABLE_COMMAND]);
  assert.equal(live.releaseCarveOut(live.turnCommands(described), keepApi, described), live.UNREADABLE_REASON);

  // A tool that runs no command at all is not a command that could not be read.
  const read = indexTurn(dir, {
    id: 'reads111-2222-3333-4444-555555555555',
    tools: [{ name: 'Read', input: { file_path: '/tmp/live-project/notes.md' } }],
  });
  assert.deepEqual(live.turnCommands(read), []);
  assert.equal(live.releaseCarveOut(live.turnCommands(read), keepApi, read), null);
});

test('a command named in an argument is not a command the turn ran', (t) => {
  const dir = sandbox(t);
  const turn = indexTurn(dir, { tools: [
    { name: 'Bash', input: { command: 'rg "git commit" README.md docs/' } },
    { name: 'Bash', input: { command: 'echo "remember to git push" >> NOTES.md' } },
    { name: 'Read', input: { file_path: '/tmp/live-project/git-push-notes.md' } },
  ] });
  const commands = live.turnCommands(turn);
  assert.deepEqual(commands, ['rg "git commit" README.md docs/', 'echo "remember to git push" >> NOTES.md'],
    'handed on as written, and judged in that shape');
  assert.equal(live.releaseCarveOut(commands, keepApi, turn), null, 'searching for it is not doing it');

  // Every spelling of the real thing, on the other hand, is seen — as a shell
  // string and as the argv array Codex writes.
  for (const command of [
    '/usr/bin/git push',
    'git pu\\sh',
    'env -i git push',
    'env -u FOO git push',
    'nice -n 5 git push',
    'sudo -u root git push',
    'sudo -E -n git push',
    'bash -lc "git push"',
    'zsh -lc "git push"',
    'npm test && git push',
    'git "push"',
    'git commit -am wip',
    'timeout 60 git push',
    'FOO=bar git push',
    ['bash', '-c', 'git push', 'label'],
    ['env', 'bash', '-c', 'git push'],
    ['git', '-C', '/tmp/a b', 'push'],
    ['nice', '-n', '5', 'git', 'push'],
  ]) {
    assert.match(live.releaseCarveOut([command], keepApi, null), /git commit or push/, JSON.stringify(command));
  }

  // And every one of these runs nothing of the sort.
  for (const command of [
    ['bash', '-c', 'echo hello', 'git commit'],
    ['printf', '%s', 'example; git push'],
    ['git', 'commit --help'],
    'git commit --dry-run',
    'rg "git commit" README.md',
  ]) {
    assert.equal(live.releaseCarveOut([command], keepApi, null), null, JSON.stringify(command));
  }

  // A line continuation inside the word is still the word.
  assert.match(live.releaseCarveOut(['git pu\\\nsh origin main'], keepApi, null), /git commit or push/);
});

test('a Codex argv command is read from the full input, whichever way it is spelled', (t) => {
  const dir = sandbox(t);
  const id = '0199dddd-1111-2222-3333-444444444444';
  const file = path.join(dir, `rollout-2026-09-13T02-00-00-${id}.jsonl`);
  const long = `pytest -k ${'y'.repeat(2400)} && git push origin HEAD:master`;
  const rollout = (calls) => jsonl([
    { type: 'session_meta', timestamp: '2026-09-13T02:00:00.000Z', payload: { id, cwd: '/tmp/live-project', source: 'cli' } },
    { type: 'response_item', timestamp: '2026-09-13T02:00:01.000Z', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ship it' }] } },
    ...calls,
    { type: 'response_item', timestamp: '2026-09-13T02:00:03.000Z', payload: { type: 'agent_message', text: 'Pushed.' } },
    { type: 'event_msg', timestamp: '2026-09-13T02:00:04.000Z', payload: { type: 'task_complete' } },
  ]);
  // An object-valued `arguments`, and an argv array rather than a string.
  fs.writeFileSync(file, rollout([
    { type: 'response_item', timestamp: '2026-09-13T02:00:02.000Z', payload: {
      type: 'function_call', name: 'shell', call_id: 's1',
      arguments: { command: ['bash', '-lc', 'git push origin HEAD:master'] } } },
  ]));
  assert.equal(turnIndex.ingestFile(file).ok, true);
  const turn = watcher.turnFor(id, 1);
  assert.deepEqual(live.turnCommands(turn), [['bash', '-lc', 'git push origin HEAD:master']],
    'the argv is judged as an argv');
  assert.match(live.releaseCarveOut(live.turnCommands(turn), keepApi, turn), /git commit or push/);

  // Too long to keep as JSON. The column holds the argv *joined* into one string,
  // which is not what ran and is never judged as if it were.
  const big = '0199eeee-1111-2222-3333-444444444444';
  const bigFile = path.join(dir, `rollout-2026-09-13T02-30-00-${big}.jsonl`);
  fs.writeFileSync(bigFile, rollout([
    { type: 'response_item', timestamp: '2026-09-13T02:00:02.000Z', payload: {
      type: 'function_call', name: 'shell', call_id: 's2', arguments: { command: ['bash', '-lc', long] } } },
  ]).replaceAll(id, big));
  assert.equal(turnIndex.ingestFile(bigFile).ok, true);
  const bigTurn = watcher.turnFor(big, 1);
  assert.deepEqual(live.turnCommands(bigTurn), [live.UNREADABLE_COMMAND]);
  assert.equal(live.releaseCarveOut(live.turnCommands(bigTurn), keepApi, bigTurn), live.UNREADABLE_REASON);
});

test('a tool input too long for the index to record is never cleared', (t) => {
  const dir = sandbox(t);
  // Past the command cap as well, so not even the column holds the tail where a
  // trailing push would sit.
  const huge = `node scripts/build.js --flags ${'z'.repeat(turnIndex.COMMAND_CAP)}`;
  const turn = indexTurn(dir, { tools: [{ name: 'Bash', input: { command: huge } }] });
  assert.deepEqual(live.turnCommands(turn), [live.UNREADABLE_COMMAND]);
  assert.equal(live.releaseCarveOut(live.turnCommands(turn), keepApi, turn), live.UNREADABLE_REASON);
  assert.match(live.UNREADABLE_REASON, /could not record in full/);
});

test('the indexer records a commit only from the call that ran one', (t) => {
  const dir = sandbox(t);
  // Commit-shaped text in the output of a command that is not a commit is a
  // README being printed, not a release.
  const at = (s) => new Date(Date.UTC(2026, 8, 13, 3, 0, s)).toISOString();
  const id = 'prov1111-2222-3333-4444-555555555555';
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, jsonl([
    { type: 'user', sessionId: id, cwd: '/tmp/live-project', timestamp: at(0), message: { role: 'user', content: 'read the docs' } },
    { type: 'assistant', sessionId: id, cwd: '/tmp/live-project', timestamp: at(1), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'cat1', name: 'Bash', input: { command: 'cat README.md' } }] } },
    { type: 'user', sessionId: id, cwd: '/tmp/live-project', timestamp: at(2), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'cat1', content: 'Example:\n[main 1a2b3c4] fix the parser\n 2 files changed' }] } },
    { type: 'assistant', sessionId: id, cwd: '/tmp/live-project', timestamp: at(3),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: "Read it. Next, I'll patch." }] } },
  ]));
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude' }).ok, true);
  assert.deepEqual(JSON.parse(watcher.turnFor(id, 1).commits || '[]'), [], 'no git command, no commit');

  // The same output behind a real commit is a commit.
  fs.appendFileSync(file, jsonl([
    { type: 'user', sessionId: id, cwd: '/tmp/live-project', timestamp: at(10), message: { role: 'user', content: 'now commit it' } },
    { type: 'assistant', sessionId: id, cwd: '/tmp/live-project', timestamp: at(11), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'git commit -am "fix the parser"' } }] } },
    { type: 'user', sessionId: id, cwd: '/tmp/live-project', timestamp: at(12), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'c1', content: '[main 9f8e7d6] fix the parser\n 2 files changed' }] } },
    { type: 'assistant', sessionId: id, cwd: '/tmp/live-project', timestamp: at(13),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Committed.' }] } },
  ]));
  assert.equal(turnIndex.ingestFile(file, { agent: 'claude' }).ok, true);
  const committed = watcher.turnFor(id, 2);
  assert.deepEqual(JSON.parse(committed.commits || '[]'), ['9f8e7d6']);
  assert.match(live.releaseCarveOut([], keepApi, committed), /produced a commit/);
});

test('a carve-out phrase survives being buried in a long turn, or written in lookalikes', (t) => {
  sandbox(t);
  const filler = 'Then I re-read the migration notes and the index plan one more time. '.repeat(12);

  // The pause is the first sentence of a 900-character turn: a tail-only read
  // would never see it.
  const buried = `I will wait for you to confirm before I touch anything else. ${filler}`;
  assert.ok(buried.length > 700);
  assert.equal(watcher.explicitPause(buried), false, 'the tail alone does not show it');
  assert.equal(watcher.explicitPauseAnywhere(buried), true);
  assert.match(live.pausedCarveOut(buried, watcher), /paused itself/);
  assert.equal(live.pausedCarveOut(`${filler}I will keep going.`, watcher), null);

  // A single sentence longer than the tail window, with the pause at its start.
  const oneSentence = `I will wait for your confirmation before ${'doing any more of this '.repeat(40)}work`;
  assert.ok(oneSentence.length > 700);
  assert.match(live.pausedCarveOut(oneSentence, watcher), /paused itself/);

  // Fullwidth letters fold to the same word the risky-question list is written in.
  const fullwidth = 'Should I \uff44\uff45\uff50\uff4c\uff4f\uff59 this now?';
  assert.match(live.riskyQuestionCarveOut(fullwidth, watcher), /irreversible, production-facing/);
  assert.match(live.riskyQuestionCarveOut(`Should I \uff44\uff45\uff4c\uff45\uff54\uff45 the old column? ${filler}`, watcher),
    /irreversible, production-facing/);
  assert.equal(live.riskyQuestionCarveOut('Should I run the tests now?', watcher), null);
});

test('the delivered text is the message as written, byte for byte', (t) => {
  sandbox(t);
  // A decomposed filename pasted out of a transcript has to arrive as itself: a
  // message rewritten into an equivalent form is not the message that was
  // graded, and on a case-sensitive filesystem it may not even name the file.
  const nfd = 'continue on cafe\u0301-menu.tsx';
  const nfc = nfd.normalize('NFC');
  assert.notEqual(nfd, nfc);
  assert.equal(live.safeDeliveryText(`[keep watcher] ${nfd}`), `[keep watcher] ${nfd}`);
  assert.equal(live.safeDeliveryText(`[keep watcher] ${nfc}`), `[keep watcher] ${nfc}`);

  // A character that is only a control or a separator once folded is refused too.
  for (const point of ['\u00a0', '\u2007', '\u202f', '\u3000', '\u180e', '\u2061']) {
    assert.equal(live.safeDeliveryText(`[keep watcher] a${point}b`), null, JSON.stringify(point));
  }
  // Ordinary text, including fullwidth letters, still goes through.
  assert.equal(live.safeDeliveryText('[keep watcher] \uff41\uff42 ok'), '[keep watcher] \uff41\uff42 ok');
});

test('a turn buried under a pause is never delivered, whatever the verdict said', async (t) => {
  const dir = sandbox(t);
  const filler = 'Then I re-read the migration notes and the index plan one more time. '.repeat(12);
  const turn = indexTurn(dir, { assistant: `I will wait for you to confirm before I touch anything else. ${filler}` });
  const send = fakeSend();
  const result = await live.maybeDeliver(turn, verdict(), {
    config: allLive(), session: READY_SESSION, card: ACTIVE_CARD, send,
  });
  assert.equal(result.delivered, false);
  assert.match(result.reason, /paused itself/);
  assert.equal(send.calls.length, 0);
});

test('a request buried at the start of a long sentence still carves the turn out', (t) => {
  sandbox(t);
  // askedForAction reads a tail, because what a turn *ended* with is what the
  // rule verdict is about. A carve-out is the other question, and "Please run the
  // production deploy" does not stop being that after 700 more characters.
  const long = `Please run the production deploy after ${'you finish reviewing the migration notes and the index plan, '.repeat(14)}`;
  assert.ok(long.length > 700);
  assert.equal(watcher.askedForAction(long), false, 'the tail alone does not show it');
  assert.equal(watcher.askedForActionAnywhere(long), true);
  assert.equal(watcher.askedAnywhere(long), true);
  assert.match(live.riskyQuestionCarveOut(long, watcher), /irreversible, production-facing/);

  // Still quoted text is still not a request.
  assert.equal(watcher.askedForActionAnywhere(`The runbook says "please run the deploy" ${'and then some. '.repeat(60)}`), false);
});

test('an argv commit is counted, and a commit named in an argument is not', (t) => {
  const dir = sandbox(t);
  const rollout = (id, calls) => {
    const file = path.join(dir, `rollout-2026-09-13T04-00-00-${id}.jsonl`);
    fs.writeFileSync(file, jsonl([
      { type: 'session_meta', timestamp: '2026-09-13T04:00:00.000Z', payload: { id, cwd: '/tmp/live-project', source: 'cli' } },
      { type: 'response_item', timestamp: '2026-09-13T04:00:01.000Z', payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do the thing' }] } },
      ...calls,
      { type: 'response_item', timestamp: '2026-09-13T04:00:05.000Z', payload: { type: 'agent_message', text: 'Done.' } },
      { type: 'event_msg', timestamp: '2026-09-13T04:00:06.000Z', payload: { type: 'task_complete' } },
    ]));
    assert.equal(turnIndex.ingestFile(file).ok, true);
    return watcher.turnFor(id, 1);
  };

  // A real commit, spelled as an argv array, with the sha in its own output.
  const real = rollout('0199f111-1111-2222-3333-444444444444', [
    { type: 'response_item', timestamp: '2026-09-13T04:00:02.000Z', payload: {
      type: 'function_call', name: 'shell', call_id: 'r1',
      arguments: { command: ['bash', '-lc', 'git commit -am "fix the parser"'] } } },
    { type: 'response_item', timestamp: '2026-09-13T04:00:03.000Z', payload: {
      type: 'function_call_output', call_id: 'r1', output: '[main 5c6d7e8] fix the parser\n 2 files changed' } },
  ]);
  assert.deepEqual(JSON.parse(real.commits || '[]'), ['5c6d7e8']);
  assert.match(live.releaseCarveOut([], keepApi, real), /produced a commit/);

  // The same commit-shaped output behind an argv that names a commit without
  // running one. Joining that argv into a string is what would count it.
  const named = rollout('0199f222-1111-2222-3333-444444444444', [
    { type: 'response_item', timestamp: '2026-09-13T04:00:02.000Z', payload: {
      type: 'function_call', name: 'shell', call_id: 'n1',
      arguments: { command: ['rg', 'git commit', 'README.md'] } } },
    { type: 'response_item', timestamp: '2026-09-13T04:00:03.000Z', payload: {
      type: 'function_call_output', call_id: 'n1', output: 'README.md:12: [main 5c6d7e8] fix the parser' } },
  ]);
  assert.deepEqual(JSON.parse(named.commits || '[]'), [], 'naming a commit is not making one');
  assert.equal(live.releaseCarveOut(live.turnCommands(named), keepApi, named), null);

  // And `git commit --dry-run` writes nothing, so its output is nothing either.
  const dry = rollout('0199f333-1111-2222-3333-444444444444', [
    { type: 'response_item', timestamp: '2026-09-13T04:00:02.000Z', payload: {
      type: 'function_call', name: 'shell', call_id: 'd1',
      arguments: { command: ['git', 'commit', '--dry-run'] } } },
    { type: 'response_item', timestamp: '2026-09-13T04:00:03.000Z', payload: {
      type: 'function_call_output', call_id: 'd1', output: '[main 5c6d7e8] would commit' } },
  ]);
  assert.deepEqual(JSON.parse(dry.commits || '[]'), []);
});

test('the message reaches the session as the exact bytes that were approved', async (t) => {
  const dir = sandbox(t);
  // A decomposed filename, the way it arrives pasted out of a transcript.
  const nfd = 'continue on cafe\u0301-menu.tsx';
  assert.notEqual(nfd, nfd.normalize('NFC'));
  const send = fakeSend();
  const result = await live.maybeDeliver(indexTurn(dir), verdict({ message: nfd }), {
    config: allLive(), session: READY_SESSION, card: ACTIVE_CARD, send,
  });
  assert.equal(result.delivered, true);
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].text, `[keep watcher] ${nfd}`, 'byte for byte, including the composition');
  assert.equal(result.text, `[keep watcher] ${nfd}`);
  assert.equal(Buffer.from(send.calls[0].text, 'utf8').length, Buffer.from(`[keep watcher] ${nfd}`, 'utf8').length);
});

test('a send that may have arrived keeps its slot; one that cannot have gives it back', async (t) => {
  const dir = sandbox(t);
  const config = allLive();
  const rows = () => turnIndex.open().prepare('SELECT turn_id, sent_at, error, token FROM deliveries').all();
  const base = { config, session: READY_SESSION, card: ACTIVE_CARD };

  // The transport refused before writing a character — the pane was busy, the
  // switch had flipped. Nothing can have arrived, so the slot goes back and the
  // turn can be tried again.
  const early = indexTurn(dir);
  const refused = await live.maybeDeliver(early, verdict(), {
    ...base, send: async () => { throw new Error('another sender holds the injection lock'); },
  });
  assert.equal(refused.delivered, false);
  assert.match(refused.reason, /delivery failed: another sender/);
  assert.equal(refused.reservationKept, false);
  assert.deepEqual(rows(), [], 'the reservation is gone');
  assert.equal(live.rateLimit(early, config, {}), null, 'and the turn is free to try again');

  // The transport typed, then lost the receipt. Nobody can prove the message did
  // not arrive, so the row stays — spent, unsent, and saying why.
  const typed = indexTurn(dir, { id: 'kept1111-2222-3333-4444-555555555555' });
  const unconfirmed = await live.maybeDeliver(typed, verdict(), {
    ...base,
    send: async () => {
      const error = new Error('Delivery unconfirmed');
      error.typingStarted = true;
      throw error;
    },
  });
  assert.equal(unconfirmed.delivered, false);
  assert.equal(unconfirmed.typingStarted, true);
  assert.equal(unconfirmed.reservationKept, true);
  const kept = rows();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].turn_id, typed.id);
  assert.equal(kept[0].sent_at, null, 'never confirmed');
  assert.equal(kept[0].error, 'Delivery unconfirmed');
  assert.match(live.rateLimit(typed, config, {}), /already been delivered/, 'and never tried again');

  // The slot it spent is a real one: the session has had its message for the
  // next ten minutes, whether or not anyone can prove it.
  const next = secondTurn(dir, 'kept1111-2222-3333-4444-555555555555');
  assert.match(live.rateLimit(next, config, {}), /last 10 minutes/);

  // An error recorded under another attempt's token changes nothing.
  assert.equal(live.recordReservationError(typed, 'someone else', { token: 'not-the-token' }), 0);
  assert.equal(rows()[0].error, 'Delivery unconfirmed');
});

// ---------- the resource observation ----------

function declare(resourcesMap = { staging: { title: 'staging sandbox', commands: ['terraform apply'], noteFor: '+2h' } }) {
  fs.mkdirSync(path.join(REGISTRY, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(REGISTRY, 'resources', 'live-project.json'),
    JSON.stringify({ project: '/tmp/live-project', resources: resourcesMap }, null, 2));
}

function forgetDeclarations() {
  fs.rmSync(path.join(REGISTRY, 'resources'), { recursive: true, force: true });
  fs.rmSync(path.join(REGISTRY, '.keep', 'notes'), { recursive: true, force: true });
}

function terraformTurn(dir) {
  return indexTurn(dir, { tools: [{ name: 'Bash', input: { command: 'terraform apply -auto-approve' } }] });
}

test('a turn that touched a declared resource and said nothing produces an observation', (t) => {
  const dir = sandbox(t);
  t.after(forgetDeclarations);
  declare();
  const turn = terraformTurn(dir);
  const observation = watcher.observationFor(turn);
  assert.deepEqual(observation.map((row) => row.name), ['staging']);
  assert.match(observation[0].evidence, /^command terraform apply -auto-approve$/);

  // A turn that wrote a note about it says nothing more.
  const quiet = watcher.observationFor(turn, {
    commands: ['terraform apply -auto-approve', 'keep note live-project --scope staging -m "x" --for +2h'],
  });
  assert.deepEqual(quiet, []);

  // No declarations at all: the whole feature is silent.
  forgetDeclarations();
  assert.deepEqual(watcher.observationFor(turn), []);
});

test('an observation records a shadow decision and sends nothing while the type is off', async (t) => {
  const dir = sandbox(t);
  t.after(forgetDeclarations);
  declare();
  const turn = terraformTurn(dir);
  const send = fakeSend();
  const result = await live.maybeDeliverObservation(turn, watcher.observationFor(turn), {
    config: live.normalizeConfig({}), session: READY_SESSION, card: ACTIVE_CARD, send,
  });
  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'resource is not live');
  assert.deepEqual(send.calls, []);
  assert.match(result.text, /^\[keep watcher\] this turn touched staging \(command terraform apply -auto-approve\) and left no state note\. If it changed how staging behaves for other sessions, run: keep note live-project --scope staging -m "<what is true now>" --for \+2h$/);
  const decisions = require('./decisions.js').loadSafe();
  const entry = decisions.find((row) => row.id === result.decisionId);
  assert.equal(entry.type, 'resource');
  assert.equal(entry.message, result.text, 'Owner grades the exact text that would have been sent');
  assert.equal(entry.turn, `${SESSION}#1#resource`);
  assert.equal(entry.delivered, undefined);

  // The verdict's own decision for the same turn is a different row.
  const again = await live.maybeDeliverObservation(turn, watcher.observationFor(turn), {
    config: live.normalizeConfig({}), session: READY_SESSION, card: ACTIVE_CARD, send,
  });
  assert.equal(again.decisionId, result.decisionId, 'one observation decision per turn');
});

test('an observation delivers once the type is live, and marks its decision sent', async (t) => {
  const dir = sandbox(t);
  t.after(forgetDeclarations);
  declare();
  const turn = terraformTurn(dir);
  const send = fakeSend();
  const config = live.normalizeConfig({ live: { resource: true } });
  const result = await live.maybeDeliverObservation(turn, watcher.observationFor(turn), {
    config, session: READY_SESSION, card: ACTIVE_CARD, send,
  });
  assert.equal(result.delivered, true, result.reason);
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].sessionId, SESSION);
  assert.match(send.calls[0].text, /^\[keep watcher\] this turn touched staging/);
  const entry = require('./decisions.js').loadSafe().find((row) => row.id === result.decisionId);
  assert.equal(entry.delivered, true);

  // The reservation is per turn across every type, so nothing else may follow it.
  const second = await live.maybeDeliverObservation(turn, watcher.observationFor(turn), {
    config, session: READY_SESSION, card: ACTIVE_CARD, send: fakeSend(),
  });
  assert.equal(second.delivered, false);
  assert.match(second.reason, /already been delivered/);
});

test('an observation is skipped when a verdict already reserved the turn', async (t) => {
  const dir = sandbox(t);
  t.after(forgetDeclarations);
  declare();
  const turn = terraformTurn(dir);
  const config = live.normalizeConfig({ live: { continue: true, resource: true } });
  const first = await live.maybeDeliver(turn, verdict(), {
    config, session: READY_SESSION, card: ACTIVE_CARD, send: fakeSend(),
  });
  assert.equal(first.delivered, true, first.reason);
  const send = fakeSend();
  const result = await live.maybeDeliverObservation(turn, watcher.observationFor(turn), {
    config, session: READY_SESSION, card: ACTIVE_CARD, send,
  });
  assert.equal(result.delivered, false);
  assert.match(result.reason, /already been delivered/);
  assert.deepEqual(send.calls, [], 'the turn already spent its one reservation');
  assert.ok(result.decisionId, 'the shadow decision is still recorded for grading');
});

test('nothing is recorded for a turn that was never going to be nudged', async (t) => {
  const dir = sandbox(t);
  t.after(forgetDeclarations);
  declare();
  const turn = terraformTurn(dir);
  const config = live.normalizeConfig({ live: { resource: true } });
  const before = require('./decisions.js').loadSafe().length;

  // A reviewer session, and a turn the release carve-out rules out. Neither is
  // ever nudged, so neither becomes something for Owner to grade.
  const reviewer = await live.maybeDeliverObservation(turn, watcher.observationFor(turn), {
    config, session: { ...READY_SESSION, reviewer: true }, card: ACTIVE_CARD, send: fakeSend(),
  });
  assert.equal(reviewer.decisionId, undefined);
  assert.match(reviewer.reason, /reviewer/);
  const carved = await live.maybeDeliverObservation(turn, watcher.observationFor(turn), {
    config, session: READY_SESSION, card: ACTIVE_CARD, send: fakeSend(),
    commands: ['terraform apply', 'git push origin HEAD'],
  });
  assert.equal(carved.delivered, false);
  assert.match(carved.reason, /commit or push/);
  assert.equal(carved.decisionId, undefined);
  assert.equal(require('./decisions.js').loadSafe().length, before, 'the ledger did not grow');
});

test('a session that was merely busy still produces grading data, tagged with why', async (t) => {
  const dir = sandbox(t);
  t.after(forgetDeclarations);
  declare();
  const turn = terraformTurn(dir);
  const config = live.normalizeConfig({ live: { resource: true } });
  const ledger = () => require('./decisions.js').loadSafe();

  // Exited, mid-turn, no card: all reasons about the moment, not about whether
  // the observation was right. Grading only idle authors would graduate this
  // type on a sample that is not the fleet.
  let first = null;
  for (const [session, card, expected] of [
    [{ ...READY_SESSION, exited: true, state: 'exited' }, ACTIVE_CARD, /exited/],
    [{ ...READY_SESSION, endedTurn: false }, ACTIVE_CARD, /mid-turn/],
    [undefined, ACTIVE_CARD, /does not see this session/],
    [READY_SESSION, null, /needs an active card/],
  ]) {
    const send = fakeSend();
    const result = await live.maybeDeliverObservation(turn, watcher.observationFor(turn), {
      config, session, card, send,
    });
    assert.equal(result.delivered, false);
    assert.match(result.reason, expected);
    assert.ok(result.decisionId, `recorded despite ${result.reason}`);
    assert.match(result.deferredReason, expected);
    assert.deepEqual(send.calls, [], 'recorded, not sent');
    const entry = ledger().find((row) => row.id === result.decisionId);
    assert.equal(entry.type, 'resource');
    if (!first) {
      first = entry;
      assert.match(entry.deferredReason, expected);
    }
    // Still one row for this turn: a re-judge reuses the row Owner may already
    // be looking at, and keeps the reason it was first recorded with.
    assert.equal(entry.id, first.id);
    assert.equal(entry.deferredReason, first.deferredReason);
    assert.equal(ledger().filter((row) => row.type === 'resource').length, 1);
  }
});

test('a session gets at most three resource observations an hour on the ledger', async (t) => {
  const dir = sandbox(t);
  t.after(forgetDeclarations);
  declare();
  indexTurn(dir);
  const now = Date.now();
  const fake = (n) => ({
    id: `turn-${n}`, session_id: SESSION, n, project: '/tmp/live-project',
    opener_kind: 'human', last_assistant: 'Applied it.', files: '[]', commits: '[]',
  });
  const observation = [{ name: 'staging', evidence: 'command terraform apply', noteFor: '+2h' }];
  const run = (n) => live.maybeDeliverObservation(fake(n), observation, {
    // Shadow: the record is the only thing under test here.
    config: live.normalizeConfig({}), session: READY_SESSION, card: ACTIVE_CARD,
    commands: [], now, send: fakeSend(),
  });

  const recorded = [];
  for (let n = 1; n <= live.OBSERVATION_PER_SESSION_PER_HOUR; n += 1) {
    const result = await run(n);
    assert.ok(result.decisionId, `observation ${n} recorded`);
    recorded.push(result.decisionId);
  }
  assert.equal(new Set(recorded).size, live.OBSERVATION_PER_SESSION_PER_HOUR);

  const over = await run(live.OBSERVATION_PER_SESSION_PER_HOUR + 1);
  assert.equal(over.decisionId, undefined);
  assert.match(over.reason, /already had 3 resource observations in the last hour/);

  // Re-judging a turn that is already on the ledger is not a fourth observation.
  const again = await run(1);
  assert.equal(again.decisionId, recorded[0], 'the same turn keeps its own row');

  // An hour later there is room again.
  const later = await live.maybeDeliverObservation(fake(9), observation, {
    config: live.normalizeConfig({}), session: READY_SESSION, card: ACTIVE_CARD,
    commands: [], now: now + live.HOUR_MS + 1, send: fakeSend(),
  });
  assert.ok(later.decisionId);
});

test('an observation is never delivered to the reviewer or to a session that is not ready', async (t) => {
  const dir = sandbox(t);
  t.after(forgetDeclarations);
  declare();
  const turn = terraformTurn(dir);
  const config = live.normalizeConfig({ live: { resource: true } });
  for (const [session, expected] of [
    [{ ...READY_SESSION, reviewer: true }, /reviewer/],
    [{ ...READY_SESSION, endedTurn: false }, /mid-turn/],
    [undefined, /does not see this session/],
  ]) {
    const send = fakeSend();
    const result = await live.maybeDeliverObservation(turn, watcher.observationFor(turn), {
      config, session, card: ACTIVE_CARD, send,
    });
    assert.equal(result.delivered, false);
    assert.match(result.reason, expected);
    assert.deepEqual(send.calls, []);
  }
});

test('resource is a live type with its own graduation record', () => {
  assert.ok(live.TYPES.includes('resource'));
  assert.equal(live.decisionTypeFor('resource'), 'resource');
  assert.equal(require('./decisions.js').TYPES.resource,
    'a turn touched a declared shared resource and left no state note');
  // The config file accepts the key; an unknown one still fails closed.
  assert.equal(live.normalizeConfig({ live: { resource: true } }).live.resource, true);
  assert.equal(live.normalizeConfig({ live: { resources: true } }).invalid, true);
});

// ---------- the switch, from the CLI ----------

function cliLive(args) {
  const { spawnSync } = require('node:child_process');
  return spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'watcher', 'live', ...args], {
    encoding: 'utf8',
    env: { ...process.env, KEEP_DIR: REGISTRY, KEEP_NO_PUSH: '1', KEEP_PORT: '1' },
  });
}

function seedLedger(rows) {
  fs.mkdirSync(path.join(REGISTRY, '.keep'), { recursive: true });
  fs.writeFileSync(path.join(REGISTRY, '.keep', 'decisions.json'), JSON.stringify(rows, null, 2));
}

test('`on` turns on what has earned it and says why the rest stayed off', (t) => {
  sandbox(t);
  const graded = (type, n) => Array.from({ length: n }, (_, i) => ({
    id: `d-${type}-${i}`, type, verdict: 'agree', reviewer: 'watcher', at: Date.now(),
    promptHash: watcher.PROMPT_HASH, why: 'w', message: 'm',
  }));

  // Nothing graded: `on` is not a refusal, it is a no-op that explains itself.
  seedLedger([]);
  const cold = cliLive(['on']);
  assert.equal(cold.status, 0, cold.stderr);
  assert.match(cold.stdout, /nothing new has earned live delivery under prompt [0-9a-f]{8}; currently live: none/);
  assert.match(cold.stdout, /not turned on: continue has no graded decisions yet/);
  assert.match(cold.stdout, /not turned on: resource has no graded decisions yet/);
  assert.deepEqual(live.liveTypes(live.loadConfig()), []);

  // One type has earned it; `on` turns that one on and names the others.
  seedLedger(graded('continue', 30));
  const warm = cliLive(['on']);
  assert.equal(warm.status, 0, warm.stderr);
  assert.deepEqual(live.liveTypes(live.loadConfig()), ['continue']);
  assert.match(warm.stdout, /not turned on: drift has no graded decisions yet/);
  assert.match(warm.stdout, /not turned on: resource has no graded decisions yet/);
  assert.doesNotMatch(warm.stdout, /not turned on: continue/);

  // --force stays explicit: it never rides in on `on`.
  const forced = cliLive(['on', '--force']);
  assert.notEqual(forced.status, 0);
  assert.match(forced.stderr, /to overrule graduation, name them/);
  assert.deepEqual(live.liveTypes(live.loadConfig()), ['continue'], 'the refusal changed nothing');

  // Naming a type that has not earned it is still a refusal without --force.
  const refused = cliLive(['resource']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /resource has no graded decisions yet/);

  const overruled = cliLive(['resource', '--force']);
  assert.equal(overruled.status, 0, overruled.stderr);
  assert.deepEqual(live.liveTypes(live.loadConfig()), ['resource']);

  assert.equal(cliLive(['off']).status, 0);
  assert.deepEqual(live.liveTypes(live.loadConfig()), []);
});

test('`on` is additive and never switches off something that is already live', (t) => {
  sandbox(t);
  // A prompt edit resets what counts toward graduation, so `on` afterwards finds
  // nothing ready. That must not take down what is already delivering.
  live.saveConfig({ live: { continue: true } });
  assert.deepEqual(live.liveTypes(live.loadConfig()), ['continue']);
  seedLedger([{ id: 'd-old', type: 'continue', verdict: 'agree', reviewer: 'watcher', at: Date.now(),
    promptHash: 'oldprompt', why: 'w', message: 'm' }]);

  const result = cliLive(['on']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(live.liveTypes(live.loadConfig()), ['continue'], 'continue stays live');
  assert.match(result.stdout, /1 type was already live and stays on: continue/);
  assert.match(result.stdout, /nothing new has earned live delivery under prompt [0-9a-f]{8}; currently live: continue/);
  assert.doesNotMatch(result.stdout, /not turned on: continue/, 'a live type is not reported as skipped');

  // Turning something off still takes the explicit spelling.
  assert.equal(cliLive(['off']).status, 0);
  assert.deepEqual(live.liveTypes(live.loadConfig()), []);
});
