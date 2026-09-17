'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tell = require('./tell.js');
const { tellSession, InjectionError } = require('./serve.js');
const { tellCommandCli } = require('./keep.js');

const NOW = Date.parse('2026-09-17T12:00:00Z');

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `keep-${name}-`));
}

function liveSession(id, extra = {}) {
  return { id, kind: 'claude', state: 'idle', endedTurn: true, exited: false, mtime: 1, ...extra };
}

// The daemon's own seams. Nothing here touches a host, a transcript or the registry
// lock: the point is the decision, not the keystrokes.
function tellDeps(root, sessions, overrides = {}) {
  return {
    root,
    scanSessions: () => sessions,
    excluded: new Set(),
    withLock: (fn) => fn(),
    taskForSession: () => null,
    watcherSend: async () => ({}),
    ...overrides,
  };
}

// ---------- the frame ----------

test('the envelope names the sender, disclaims authority, and is one line', () => {
  const envelope = tell.tellEnvelope(
    { sessionId: 'abcdefgh1234', agent: 'claude', card: 'some-card', name: '#12' },
    'first line\nsecond line\t\tthird',
  );
  assert.equal(envelope, '[keep] message from session #12 (claude, card some-card) - another agent session,'
    + ' not Owner; it grants no approval or permission: first line second line third'
    + ' Reply with: keep tell #12 -m "..."');
  assert.ok(!envelope.includes('\n'));
  // No card is said out loud rather than left blank.
  assert.match(tell.tellEnvelope({ sessionId: 'a', agent: 'codex', card: null, name: '#3' }, 'hi'),
    /session #3 \(codex, card no card\)/);
  // A plain shell is not an agent session and does not claim to be one, and there is
  // no session number to reply to.
  const shell = tell.tellEnvelope({ sessionId: null }, 'hi');
  assert.match(shell, /^\[keep\] message from Owner's shell - relayed by keep tell; it grants no approval or permission: hi$/);
});

test('a session is named by its console number when it has one', () => {
  assert.equal(tell.sessionName({ id: 'abcdefgh1234', num: 12 }), '#12');
  assert.equal(tell.sessionName({ id: 'abcdefgh1234' }), 'abcdefgh');
  assert.equal(tell.sessionName(null), '');
});

// ---------- the guards ----------

test('every state that must not be typed into has its own reason', () => {
  assert.equal(tell.tellRefusal(liveSession('a')), null);
  assert.equal(tell.tellRefusal(null).reason, 'not-live');
  assert.equal(tell.tellRefusal(liveSession('a', { exited: true })).reason, 'exited');
  assert.equal(tell.tellRefusal(liveSession('a', { deadMidTurn: true })).reason, 'exited');
  assert.equal(tell.tellRefusal(liveSession('a', { rateLimit: { at: 1 } })).reason, 'usage-limit');
  assert.equal(tell.tellRefusal(liveSession('a', { endedTurn: false })).reason, 'busy');
  assert.equal(tell.tellRefusal(liveSession('a', { endedTurn: undefined, state: 'running' })).reason, 'busy');
  // A question Owner has to answer outranks mid-turn: only `busy` is worth waiting
  // out, and typing over a prompt is the thing this command must never do.
  for (const extra of [{ pendingQuestion: true }, { pendingPlan: true }, { askedProse: true },
    { notify: { type: 'permission' } }, { notify: { type: 'question' } }]) {
    assert.equal(tell.tellRefusal(liveSession('a', { endedTurn: false, ...extra })).reason, 'waiting-on-owner');
  }
  // An idle notification is not a prompt anyone is holding.
  assert.equal(tell.tellRefusal(liveSession('a', { notify: { type: 'waiting' } })), null);
});

test('the daemon refuses the sender itself, the reviewer, and a keep-spawned run', async () => {
  const root = tmpRoot('tell-guards');
  try {
    const sessions = [liveSession('sender-session'), liveSession('reviewer-session', { reviewer: true }),
      liveSession('spawned-session'), liveSession('busy-session', { endedTurn: false })];
    fs.mkdirSync(path.join(root, '.keep', 'spawned'), { recursive: true });
    fs.writeFileSync(path.join(root, '.keep', 'spawned', 'spawned-session'), '');
    const deps = tellDeps(root, sessions);
    const body = { text: 'ping', senderSessionId: 'sender-session', senderAgent: 'claude' };

    await assert.rejects(tellSession({ ...body, sessionId: 'sender-session' }, deps),
      (error) => error.status === 409 && error.extra.reason === 'self');
    await assert.rejects(tellSession({ ...body, sessionId: 'reviewer-session' }, deps),
      (error) => error.status === 409 && error.extra.reason === 'reviewer');
    await assert.rejects(tellSession({ ...body, sessionId: 'spawned-session' }, deps),
      (error) => error.status === 409 && error.extra.reason === 'keep-spawned');
    await assert.rejects(tellSession({ ...body, sessionId: 'busy-session' }, deps),
      (error) => error.status === 409 && error.extra.reason === 'busy');
    await assert.rejects(tellSession({ ...body, sessionId: 'busy-session', text: '  ' }, deps),
      (error) => error.status === 400 && /message is empty/.test(error.message));
    // Nothing was reserved by any of those refusals.
    assert.equal(fs.existsSync(tell.ledgerFile(root)), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a card resolves to its live linked session, and says so when it has none', async () => {
  const root = tmpRoot('tell-card');
  try {
    const sessions = [liveSession('linked-session'), liveSession('other-session')];
    const sent = [];
    const deps = tellDeps(root, sessions, {
      loadTask: (id) => (id === 'some-card' ? { id, fm: { sessions: [{ id: 'linked-session' }] } } : null),
      watcherSend: async (request) => { sent.push(request); return {}; },
    });
    const result = await tellSession({ taskId: 'some-card', text: 'ping', senderSessionId: 'other-session' }, deps);
    assert.equal(result.sessionId, 'linked-session');
    assert.equal(result.card, 'some-card');
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /^\[keep\] message from session other-se \(claude, card no card\)/);

    // The only linked session is mid-turn: that is `busy`, which `--wait` can sit out.
    const busy = tellDeps(root, [liveSession('linked-session', { endedTurn: false })], {
      loadTask: () => ({ id: 'some-card', fm: { sessions: [{ id: 'linked-session' }] } }),
    });
    await assert.rejects(tellSession({ taskId: 'some-card', text: 'ping' }, busy),
      (error) => error.status === 409 && error.extra.reason === 'busy');

    // Nothing linked and live at all is a different answer, and not one to wait on.
    const empty = tellDeps(root, [], { loadTask: () => ({ id: 'some-card', fm: { sessions: [] } }) });
    await assert.rejects(tellSession({ taskId: 'some-card', text: 'ping' }, empty),
      (error) => error.status === 409 && error.extra.reason === 'not-live'
        && /start one with keep open some-card --fresh/.test(error.message));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an envelope that cannot fit the send cap is refused rather than truncated', async () => {
  const root = tmpRoot('tell-cap');
  try {
    const deps = tellDeps(root, [liveSession('target-session')]);
    await assert.rejects(tellSession({ sessionId: 'target-session', text: 'x'.repeat(1990) }, deps),
      (error) => error.status === 400 && error.message === tell.TELL_TEXT_ERROR);
    // Right up to the CLI's spill threshold still goes through in one piece.
    const result = await tellSession({ sessionId: 'target-session', text: 'x'.repeat(tell.TELL_TEXT_LIMIT) }, deps);
    assert.ok(result.text.length <= tell.SEND_LIMIT);
    assert.ok(result.text.includes('x'.repeat(tell.TELL_TEXT_LIMIT)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- the brake ----------

test('the ledger caps a pair at six an hour and a recipient at twenty, and exempts the shell from the pair cap', () => {
  const store = {};
  const slot = { sender: 'sender-session', target: 'target-session', now: NOW };
  for (let i = 0; i < tell.PAIR_HOURLY_MAX; i += 1) {
    assert.equal(tell.tellDecision(store, { ...slot, now: NOW + i }).ok, true);
    tell.recordTell(store, { ...slot, now: NOW + i });
  }
  const refused = tell.tellDecision(store, { ...slot, now: NOW + 10 });
  assert.equal(refused.ok, false);
  assert.match(refused.why, /^6 tells to this session in the last hour; the next one frees up at \d\d:\d\d$/);
  // An hour later the window has rolled off entirely.
  assert.equal(tell.tellDecision(store, { ...slot, now: NOW + tell.WINDOW_MS + 1 }).ok, true);
  // Owner's shell has no pair, so the pair cap cannot bind it.
  assert.equal(tell.tellDecision(store, { sender: null, target: 'target-session', now: NOW + 10 }).ok, true);

  const busy = {};
  for (let i = 0; i < tell.TARGET_HOURLY_MAX; i += 1) {
    tell.recordTell(busy, { sender: `sender-${i}`, target: 'target-session', now: NOW + i });
  }
  const perTarget = tell.tellDecision(busy, { sender: null, target: 'target-session', now: NOW + 100 });
  assert.equal(perTarget.ok, false);
  assert.match(perTarget.why, /^that session received 20 tells in the last hour/);
  // The per-target cap binds the shell too; only the pair cap exempts it.
  assert.equal(tell.tellDecision(busy, { sender: 'fresh-sender', target: 'target-session', now: NOW + 100 }).ok, false);
});

test('recording prunes rolled-off keys instead of growing a row per pair forever', () => {
  const store = {};
  tell.recordTell(store, { sender: 'old-sender', target: 'old-target', now: NOW });
  tell.recordTell(store, { sender: 'new-sender', target: 'new-target', now: NOW + tell.WINDOW_MS + 1 });
  assert.deepEqual(Object.keys(store.pairs), ['new-sender|new-target']);
  assert.deepEqual(Object.keys(store.targets), ['new-target']);
});

test('a failed send gives the slot back, and only its own', async () => {
  const root = tmpRoot('tell-rollback');
  try {
    const deps = tellDeps(root, [liveSession('target-session')], {
      watcherSend: async () => { throw new Error('pane went away'); },
    });
    // A concurrent tell's reservation is already on file; the rollback must not touch it.
    tell.saveLedger(root, tell.recordTell(tell.loadLedger(root),
      { sender: 'sender-session', target: 'target-session', now: Date.now() - 1000 }));
    await assert.rejects(
      tellSession({ sessionId: 'target-session', text: 'ping', senderSessionId: 'sender-session' }, deps),
      /pane went away/,
    );
    const store = tell.loadLedger(root);
    assert.equal(store.pairs['sender-session|target-session'].length, 1);
    assert.equal(store.targets['target-session'].length, 1);
    assert.equal(fs.existsSync(tell.logFile(root)), false);

    // A session the scan still lists but whose pane has gone reads as a refusal, in
    // the same shape as the guards, so the CLI exits 3 instead of "unexpected response".
    const gone = tellDeps(root, [liveSession('target-session')], {
      watcherSend: async () => { throw new InjectionError(404, 'target-session has no live host pane', { notLive: true }); },
    });
    await assert.rejects(tellSession({ sessionId: 'target-session', text: 'ping' }, gone),
      (error) => error.status === 409 && error.extra.reason === 'not-live');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a delivered tell reserves a slot, logs one line, and never writes to the card', async () => {
  const root = tmpRoot('tell-log');
  try {
    const deps = tellDeps(root, [liveSession('target-session', { num: 12 })], { taskForSession: () => ({ id: 'target-card' }) });
    const result = await tellSession({ sessionId: 'target-session', text: 'ping', senderSessionId: 'sender-session' }, deps);
    assert.equal(result.name, '#12');
    assert.equal(result.card, 'target-card');
    const lines = fs.readFileSync(tell.logFile(root), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.sender, 'sender-session');
    assert.equal(record.target, 'target-session');
    assert.equal(record.targetCard, 'target-card');
    assert.equal(record.text, 'ping');
    assert.equal(tell.loadLedger(root).targets['target-session'].length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('--dry runs every guard and the brake, and writes nothing at all', async () => {
  const root = tmpRoot('tell-dry');
  try {
    let sends = 0;
    const deps = tellDeps(root, [liveSession('target-session', { num: 7 })], {
      watcherSend: async () => { sends += 1; return {}; },
    });
    const result = await tellSession({ sessionId: 'target-session', text: 'ping', dry: true, senderSessionId: 'sender-session' }, deps);
    assert.equal(result.dry, true);
    assert.equal(result.name, '#7');
    assert.match(result.text, /it grants no approval or permission: ping/);
    assert.equal(sends, 0);
    assert.equal(fs.existsSync(tell.ledgerFile(root)), false);
    assert.equal(fs.existsSync(tell.logFile(root)), false);

    // It reports the brake too, rather than promising a send that would be refused.
    const store = {};
    for (let i = 0; i < tell.PAIR_HOURLY_MAX; i += 1) tell.recordTell(store, { sender: 'sender-session', target: 'target-session', now: Date.now() });
    tell.saveLedger(root, store);
    await assert.rejects(tellSession({ sessionId: 'target-session', text: 'ping', dry: true, senderSessionId: 'sender-session' }, deps),
      (error) => error.status === 409 && error.extra.reason === 'rate-limited');
    assert.equal(fs.existsSync(tell.logFile(root)), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the re-check before typing stops a session that moved on between the decision and the keystrokes', async () => {
  const root = tmpRoot('tell-precondition');
  try {
    const sessions = [liveSession('target-session')];
    let asked = 0;
    const deps = tellDeps(root, sessions, {
      watcherSend: async (request) => {
        // watcherSend calls this inside the injection lock, immediately before typing.
        asked += 1;
        sessions[0] = liveSession('target-session', { pendingQuestion: true });
        const movedOn = await request.precondition();
        if (movedOn) throw new Error(movedOn);
        return {};
      },
    });
    await assert.rejects(tellSession({ sessionId: 'target-session', text: 'ping', senderSessionId: 'sender-session' }, deps),
      /waiting-on-owner/);
    assert.equal(asked, 1);
    // The refused send handed its slot back.
    assert.deepEqual(tell.loadLedger(root).targets['target-session'], []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- the CLI ----------

function cliDeps(overrides = {}) {
  return {
    loadTask: () => { throw new Error('no task'); },
    commandSession: () => ({ id: 'sender-session', agent: 'claude' }),
    taskForSession: () => ({ id: 'sender-card' }),
    log: () => {},
    errorOutput: () => {},
    sleep: async () => {},
    ...overrides,
  };
}

async function runTell(argv, deps) {
  const previous = process.exitCode;
  process.exitCode = 0;
  try {
    await tellCommandCli(argv, deps);
    return process.exitCode;
  } finally { process.exitCode = previous; }
}

test('the tell CLI posts the sender identity and prints where the message went', async () => {
  const calls = [];
  const lines = [];
  const code = await runTell(['abcdefgh1234', '-m', 'ping'], cliDeps({
    log: (line) => lines.push(line),
    postKeepApi: async (url, body) => {
      calls.push({ url, body });
      return { status: 200, data: JSON.stringify({ ok: true, sessionId: 'abcdefgh1234', name: '#12', card: 'their-card' }) };
    },
  }));
  assert.equal(code, 0);
  assert.deepEqual(calls, [{ url: '/api/tell', body: { sessionId: 'abcdefgh1234', text: 'ping',
    senderSessionId: 'sender-session', senderAgent: 'claude', senderCard: 'sender-card' } }]);
  assert.equal(lines[0], 'told #12 (abcdefgh1234) on their-card');

  // A card target goes as a card; the daemon picks the session on it.
  const cardCalls = [];
  await runTell(['some-card', '-m', 'ping'], cliDeps({
    loadTask: (id) => ({ id }),
    commandSession: () => null,
    postKeepApi: async (url, body) => {
      cardCalls.push(body);
      return { status: 200, data: JSON.stringify({ ok: true, sessionId: 'x', name: '#1', card: 'some-card' }) };
    },
  }));
  // With no agent session there is no sender to name, and the daemon frames it as
  // Owner's shell.
  assert.deepEqual(cardCalls, [{ taskId: 'some-card', text: 'ping' }]);
});

test('long or multi-line text is spilled to a committed handoff file and sent as a pointer', async () => {
  const spilled = [];
  const calls = [];
  const deps = cliDeps({
    writeOpenHandoff: (id, message, task, options) => {
      spilled.push({ id, message, options });
      return options.pointer('/registry/.keep/handoffs/abcdefgh1234-1.md');
    },
    postKeepApi: async (url, body) => {
      calls.push(body);
      return { status: 200, data: JSON.stringify({ ok: true, sessionId: 'abcdefgh1234', name: '#12', card: null }) };
    },
  });
  await runTell(['abcdefgh1234', '-m', 'first\nsecond'], deps);
  assert.equal(spilled[0].message, 'first\nsecond');
  assert.equal(calls[0].text, 'The full message is in /registry/.keep/handoffs/abcdefgh1234-1.md; read that file.');
  assert.equal(spilled[0].options.commitLabel('abcdefgh1234'), 'keep: tell abcdefgh1234 (message text)');
  assert.equal(spilled[0].options.cardLog, false, 'a relayed message is not a card log entry');

  await runTell(['abcdefgh1234', '-m', 'y'.repeat(tell.TELL_TEXT_LIMIT + 1)], deps);
  assert.equal(spilled[1].message.length, tell.TELL_TEXT_LIMIT + 1);
  // Short single-line text is sent as typed, with no commit at all.
  await runTell(['abcdefgh1234', '-m', 'short'], deps);
  assert.equal(spilled.length, 2);
  assert.equal(calls.at(-1).text, 'short');
});

test('--wait retries only a busy target, and times out with 124', async () => {
  const slept = [];
  let clock = 0;
  const posts = [];
  const busy = { status: 409, data: JSON.stringify({ error: 'busy: session is mid-turn', reason: 'busy' }) };
  const deps = (responses) => cliDeps({
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    postKeepApi: async (url, body) => { posts.push(body); return responses[Math.min(posts.length - 1, responses.length - 1)]; },
  });

  const delivered = { status: 200, data: JSON.stringify({ ok: true, sessionId: 'abcdefgh1234', name: '#12', card: null }) };
  assert.equal(await runTell(['abcdefgh1234', '-m', 'ping', '--wait', '10m'], deps([busy, busy, delivered])), 0);
  assert.deepEqual(slept, [15000, 15000]);

  posts.length = 0; slept.length = 0; clock = 0;
  assert.equal(await runTell(['abcdefgh1234', '-m', 'ping', '--wait', '1m'], deps([busy])), 124);
  // 60s of waiting is four 15s naps, and the last one is trimmed to the deadline.
  assert.deepEqual(slept, [15000, 15000, 15000, 15000]);
  assert.equal(posts.length, 5);

  // Every other refusal fails immediately, however long the wait was.
  posts.length = 0; slept.length = 0; clock = 0;
  const waiting = { status: 409, data: JSON.stringify({ error: 'waiting-on-owner: session is waiting on Owner', reason: 'waiting-on-owner' }) };
  assert.equal(await runTell(['abcdefgh1234', '-m', 'ping', '--wait', '10m'], deps([waiting])), 3);
  assert.deepEqual(slept, []);
  assert.equal(posts.length, 1);

  // With no --wait at all, a busy target is simply a refusal.
  posts.length = 0;
  assert.equal(await runTell(['abcdefgh1234', '-m', 'ping'], deps([busy])), 3);
  assert.equal(posts.length, 1);
});

test('the tell CLI refuses its own bad arguments before contacting the daemon', async () => {
  const never = cliDeps({ postKeepApi: async () => assert.fail('no request') });
  await assert.rejects(runTell([], never), /usage: keep tell/);
  await assert.rejects(runTell(['abcdefgh1234'], never), /keep tell needs -m/);
  await assert.rejects(runTell(['abcdefgh1234', '-m', '  '], never), /keep tell needs -m/);
  await assert.rejects(runTell(['abcdefgh1234', '-m', 'ping', '--message-file', '/tmp/x'], never), /use either -m or --message-file/);
  await assert.rejects(runTell(['abcdefgh1234', '-m', 'ping', '--wait', 'soon'], never), /--wait must be a duration/);
});
