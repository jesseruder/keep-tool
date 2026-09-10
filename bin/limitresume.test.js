'use strict';

// The reviewer launcher exports KEEP_REVIEWER* into its shell and these tests
// spawn nothing, but keep the same hygiene as the other suites.
for (const k of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[k];

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_ATTEMPTS,
  MAX_MOVED_ON,
  MAX_SENDS_PER_DAY,
  RESET_GRACE_MS,
  SENDING_STALE_MS,
  STALE_GRACE_MS,
  resetTimeFor,
  resumeDecision,
  tick,
  dashboardState,
  ledgerFile,
  readLedger,
} = require('./limitresume.js');

const NOW = Date.parse('2026-09-06T20:00:00.000Z');
const HIT_AT = '2026-09-06T18:00:00.000Z';
const RESET_AT = NOW - 10 * 60e3; // reset already passed, well outside the grace window

function session(overrides = {}) {
  return {
    id: 'session-one',
    kind: 'claude',
    reviewer: false,
    exited: false,
    endedTurn: true,
    rateLimit: { at: HIT_AT, text: 'session limit', type: 'five_hour', resetsAt: RESET_AT },
    ...overrides,
  };
}

function usageSnapshot(limits, fetchedAt = NOW - 60e3) {
  return { claude: { limits, fetchedAt }, codex: {} };
}

function ledgerWith(entry, id = 'session-one') {
  return { sessions: entry ? { [id]: entry } : {}, history: [] };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'keep-limitresume-'));
}

function writeLedgerFile(root, ledger) {
  const file = ledgerFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
}

// A 409 raised by serve.js when the session is no longer parked on the limit the
// scheduler decided about.
function movedOn(why = 'mid-turn') {
  return Object.assign(new Error(`session moved on before resume (${why})`), { status: 409 });
}

test('resetTimeFor prefers the transcript window and falls back to the usage snapshot', () => {
  assert.equal(resetTimeFor({ type: 'five_hour', resetsAt: 1788570000000 }, null, NOW), 1788570000000);
  const iso = '2026-09-07T00:00:00.000Z';
  assert.equal(
    resetTimeFor({ type: 'fable_weekly', resetsAt: null }, usageSnapshot([
      { label: '5h', percent: 12, resetsAt: '2026-09-06T21:00:00.000Z' },
      { label: 'Fable wk', percent: 100, resetsAt: iso },
    ]), NOW),
    Date.parse(iso),
  );
  assert.equal(
    resetTimeFor({ type: 'seven_day', resetsAt: null }, usageSnapshot([
      { label: 'week', percent: 99, resetsAt: iso },
    ]), NOW),
    Date.parse(iso),
  );
  // No window anywhere: the caller must wait rather than guess a reset.
  assert.equal(resetTimeFor({ type: 'fable_weekly', resetsAt: null }, usageSnapshot([]), NOW), null);
  assert.equal(resetTimeFor({ type: 'unknown', resetsAt: null }, usageSnapshot([{ label: '5h', percent: 1, resetsAt: iso }]), NOW), null);
  assert.equal(resetTimeFor(null, null, NOW), null);
});

test('resumeDecision skips sessions that must not be typed into', () => {
  const cases = [
    [{ rateLimit: null }, 'no rate limit'],
    [{ kind: 'codex' }, 'not a Claude session'],
    [{ reviewer: true }, 'reviewer session'],
    [{ exited: true }, 'session exited'],
    [{ pendingQuestion: { question: 'which one?' } }, 'waiting on a person'],
    [{ pendingPlan: { ts: HIT_AT } }, 'waiting on a person'],
  ];
  for (const [overrides, reason] of cases) {
    const decision = resumeDecision({ session: session(overrides), usage: usageSnapshot([]), ledger: ledgerWith(null), now: NOW });
    assert.deepEqual(decision, { action: 'skip', reason, resetAt: null });
  }
});

test('resumeDecision sends once the window has reset', () => {
  const decision = resumeDecision({
    session: session(),
    usage: usageSnapshot([{ label: '5h', percent: 4, resetsAt: '2026-09-07T01:00:00.000Z' }]),
    ledger: ledgerWith(null),
    now: NOW,
  });
  assert.deepEqual(decision, { action: 'send', reason: 'limit window has reset', resetAt: RESET_AT });
});

test('resumeDecision waits for the reset, the grace window, and a still-exhausted account', () => {
  const early = resumeDecision({
    session: session({ rateLimit: { at: HIT_AT, type: 'five_hour', resetsAt: NOW + 60 * 60e3 } }),
    usage: usageSnapshot([]),
    ledger: ledgerWith(null),
    now: NOW,
  });
  assert.equal(early.action, 'wait');
  assert.match(early.reason, /^limit resets at 2026-09-06T21:00:00.000Z$/);
  assert.equal(early.resetAt, NOW + 60 * 60e3);

  // A reset one second old is inside the grace window: the displayed reset time is
  // minute-granular, so the first request could still be rejected.
  const grace = resumeDecision({
    session: session({ rateLimit: { at: HIT_AT, type: 'five_hour', resetsAt: NOW - 1000 } }),
    usage: usageSnapshot([]),
    ledger: ledgerWith(null),
    now: NOW,
  });
  assert.equal(grace.action, 'wait');
  assert.equal(resumeDecision({
    session: session({ rateLimit: { at: HIT_AT, type: 'five_hour', resetsAt: NOW - RESET_GRACE_MS - 1 } }),
    usage: usageSnapshot([]),
    ledger: ledgerWith(null),
    now: NOW,
  }).action, 'send');

  const unknown = resumeDecision({
    session: session({ rateLimit: { at: HIT_AT, type: 'fable_weekly', resetsAt: null } }),
    usage: usageSnapshot([]),
    ledger: ledgerWith(null),
    now: NOW,
  });
  assert.deepEqual(unknown, { action: 'wait', reason: 'no reset time known', resetAt: null });

  const exhausted = resumeDecision({
    session: session({ rateLimit: { at: HIT_AT, type: 'fable_weekly', resetsAt: null } }),
    usage: usageSnapshot([{ label: 'Fable wk', percent: 100, resetsAt: '2026-09-06T19:00:00.000Z' }]),
    ledger: ledgerWith(null),
    now: NOW,
  });
  assert.deepEqual(exhausted, { action: 'wait', reason: 'limit still exhausted', resetAt: Date.parse('2026-09-06T19:00:00.000Z') });

  // A stale snapshot must not hold the session back: the clock decides.
  const stale = resumeDecision({
    session: session({ rateLimit: { at: HIT_AT, type: 'fable_weekly', resetsAt: null } }),
    usage: usageSnapshot([{ label: 'Fable wk', percent: 100, resetsAt: '2026-09-06T19:00:00.000Z' }], NOW - 30 * 60e3),
    ledger: ledgerWith(null),
    now: NOW,
  });
  assert.equal(stale.action, 'send');
});

test('resumeDecision refuses to resume the same limit event twice', () => {
  const sent = resumeDecision({
    session: session(),
    usage: usageSnapshot([]),
    ledger: ledgerWith({ hitAt: HIT_AT, sentAt: NOW - 60e3, sentHistory: [NOW - 60e3] }),
    now: NOW,
  });
  assert.deepEqual(sent, { action: 'skip', reason: 'already resumed for this limit', resetAt: null });

  // A later, distinct limit event is a new hit and may be resumed again.
  const nextEvent = resumeDecision({
    session: session({ rateLimit: { at: '2026-09-06T19:30:00.000Z', type: 'five_hour', resetsAt: RESET_AT } }),
    usage: usageSnapshot([]),
    ledger: ledgerWith({ hitAt: HIT_AT, sentAt: NOW - 60e3, sentHistory: [NOW - 60e3] }),
    now: NOW,
  });
  assert.equal(nextEvent.action, 'send');
});

test('resumeDecision caps resumes per day and gives up after repeated failures', () => {
  const recent = [];
  for (let i = 0; i < MAX_SENDS_PER_DAY; i += 1) recent.push(NOW - (i + 1) * 60 * 60e3);
  const capped = resumeDecision({
    session: session(),
    usage: usageSnapshot([]),
    ledger: ledgerWith({ hitAt: '2026-09-06T10:00:00.000Z', sentHistory: recent }),
    now: NOW,
  });
  assert.deepEqual(capped, { action: 'skip', reason: 'resume cap reached for today', resetAt: null });

  // Sends that fell out of the 24h window do not count against the cap.
  const aged = resumeDecision({
    session: session(),
    usage: usageSnapshot([]),
    ledger: ledgerWith({ hitAt: '2026-09-06T10:00:00.000Z', sentHistory: recent.map((at) => at - 25 * 3600e3) }),
    now: NOW,
  });
  assert.equal(aged.action, 'send');

  const burned = resumeDecision({
    session: session(),
    usage: usageSnapshot([]),
    ledger: ledgerWith({ hitAt: HIT_AT, attempts: MAX_ATTEMPTS, sentHistory: [] }),
    now: NOW,
  });
  assert.deepEqual(burned, { action: 'skip', reason: 'too many failed attempts', resetAt: null });
  assert.equal(resumeDecision({
    session: session(),
    usage: usageSnapshot([]),
    ledger: ledgerWith({ hitAt: HIT_AT, attempts: MAX_ATTEMPTS - 1, sentHistory: [] }),
    now: NOW,
  }).action, 'send');
});

test('tick sends continue once, records the ledger, and does not repeat itself', async () => {
  const root = tempRoot();
  const sends = [];
  const deps = {
    scanSessions: () => [session()],
    getUsage: () => usageSnapshot([{ label: '5h', percent: 3, resetsAt: '2026-09-07T01:00:00.000Z' }]),
    send: async (id, text) => { sends.push([id, text]); },
    now: NOW,
    root,
    stderr: { write: () => {} },
  };
  try {
    const first = await tick(deps);
    assert.deepEqual(first, { ok: true, sent: 1, waiting: 0, detail: 'sent 1' });
    assert.deepEqual(sends, [['session-one', '[keep] continue after the rate limit reset']]);

    const ledger = readLedger(root);
    assert.equal(ledger.sessions['session-one'].sentAt, NOW);
    assert.equal(ledger.sessions['session-one'].hitAt, HIT_AT);
    assert.equal(ledger.sessions['session-one'].type, 'five_hour');
    assert.deepEqual(ledger.history, [{
      id: 'session-one', hitAt: HIT_AT, resetAt: RESET_AT, sentAt: NOW, type: 'five_hour',
    }]);

    // The transcript still shows the limit until the session actually replies; the
    // ledger is what keeps this from typing "continue" every minute.
    const second = await tick({ ...deps, now: NOW + 60e3 });
    assert.deepEqual(second, { ok: true, sent: 0, waiting: 0, detail: 'nothing due' });
    assert.equal(sends.length, 1);

    const state = dashboardState(root);
    assert.deepEqual(state.waiting, []);
    assert.equal(state.sent.length, 1);
    assert.equal(state.sent[0].id, 'session-one');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('tick records a waiting session for the dashboard without sending', async () => {
  const root = tempRoot();
  let sent = 0;
  const deps = {
    scanSessions: () => [session({ rateLimit: { at: HIT_AT, type: 'five_hour', resetsAt: NOW + 30 * 60e3 } })],
    getUsage: () => usageSnapshot([]),
    send: async () => { sent += 1; },
    now: NOW,
    root,
    stderr: { write: () => {} },
  };
  try {
    const result = await tick(deps);
    assert.deepEqual(result, { ok: true, sent: 0, waiting: 1, detail: 'waiting 1' });
    assert.equal(sent, 0);
    assert.deepEqual(dashboardState(root), {
      waiting: [{
        id: 'session-one',
        type: 'five_hour',
        hitAt: HIT_AT,
        resetAt: NOW + 30 * 60e3,
        reason: 'limit resets at 2026-09-06T20:30:00.000Z',
      }],
      sent: [],
      stalled: [],
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a failed send is retried on the next tick and counted against the attempt budget', async () => {
  const root = tempRoot();
  let fail = true;
  const lines = [];
  const deps = {
    scanSessions: () => [session()],
    getUsage: () => usageSnapshot([]),
    send: async () => { if (fail) throw new Error('another session injection is busy'); },
    now: NOW,
    root,
    stderr: { write: (line) => lines.push(line) },
  };
  try {
    const first = await tick(deps);
    assert.deepEqual(first, { ok: true, sent: 0, waiting: 1, detail: 'waiting 1, failed 1' });
    const afterFailure = readLedger(root).sessions['session-one'];
    assert.equal(afterFailure.attempts, 1);
    assert.equal(afterFailure.sentAt, undefined);
    assert.equal(afterFailure.lastError, 'another session injection is busy');
    assert.match(lines[0], /^keep resume: could not send \[keep\] continue after the rate limit reset to session-/);

    fail = false;
    const second = await tick({ ...deps, now: NOW + 60e3 });
    assert.equal(second.sent, 1);
    const afterSend = readLedger(root).sessions['session-one'];
    assert.equal(afterSend.sentAt, NOW + 60e3);
    assert.equal(afterSend.attempts, 0);
    assert.equal(afterSend.lastError, undefined);
    assert.match(lines[1], /^keep resume: sent \[keep\] continue after the rate limit reset to session- after five_hour limit reset \(hit 2026-09-06T18:00:00.000Z, reset 2026-09-06T19:50:00.000Z\)\n$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('tick leaves alone a session that moved on and drops its stale wait', async () => {
  const root = tempRoot();
  let sent = 0;
  const waiting = session({ rateLimit: { at: HIT_AT, type: 'five_hour', resetsAt: NOW + 30 * 60e3 } });
  const deps = {
    scanSessions: () => [waiting],
    getUsage: () => usageSnapshot([]),
    send: async () => { sent += 1; },
    now: NOW,
    root,
    stderr: { write: () => {} },
  };
  try {
    await tick(deps);
    assert.equal(readLedger(root).sessions['session-one'].reason, 'limit resets at 2026-09-06T20:30:00.000Z');

    const moved = await tick({
      ...deps,
      scanSessions: () => [session({ rateLimit: null })],
      now: NOW + 60e3,
    });
    assert.deepEqual(moved, { ok: true, sent: 0, waiting: 0, detail: 'nothing due' });
    assert.equal(sent, 0);
    assert.deepEqual(dashboardState(root).waiting, [], 'the resumed session no longer waits');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('tick ignores spawned batch sessions and Codex sessions', async () => {
  const root = tempRoot();
  let sent = 0;
  try {
    const result = await tick({
      scanSessions: () => [session(), session({ id: 'codex-one', kind: 'codex' })],
      getUsage: () => usageSnapshot([]),
      send: async () => { sent += 1; },
      now: NOW,
      root,
      spawnedIds: new Set(['session-one']),
      stderr: { write: () => {} },
    });
    assert.deepEqual(result, { ok: true, sent: 0, waiting: 0, detail: 'nothing due' });
    assert.equal(sent, 0);
    assert.deepEqual(readLedger(root), { sessions: {}, history: [] });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('dashboardState reads an absent or unreadable ledger as empty', () => {
  const root = tempRoot();
  try {
    assert.deepEqual(dashboardState(root), { waiting: [], sent: [], stalled: [] });
    fs.mkdirSync(path.join(root, '.keep'), { recursive: true });
    fs.writeFileSync(path.join(root, '.keep', 'limit-resume.json'), 'not json');
    assert.deepEqual(dashboardState(root), { waiting: [], sent: [], stalled: [] });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an unrecognised limit type is never resumed', async () => {
  const root = tempRoot();
  const transient = session({ rateLimit: { at: HIT_AT, text: 'Overloaded', type: 'unknown', resetsAt: RESET_AT } });
  assert.deepEqual(
    resumeDecision({ session: transient, usage: usageSnapshot([]), ledger: ledgerWith(null), now: NOW }),
    { action: 'skip', reason: 'unrecognized limit', resetAt: null },
  );
  let sent = 0;
  try {
    const result = await tick({
      scanSessions: () => [transient],
      getUsage: () => usageSnapshot([]),
      send: async () => { sent += 1; },
      now: NOW,
      root,
      stderr: { write: () => {} },
    });
    assert.deepEqual(result, { ok: true, sent: 0, waiting: 0, detail: 'nothing due' });
    assert.equal(sent, 0);
    // Nothing is written for a limit this will never act on.
    assert.deepEqual(readLedger(root), { sessions: {}, history: [] });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a stale usage snapshot holds the resume back, but only for STALE_GRACE_MS', () => {
  const resetAt = NOW - 10 * 60e3;
  const parked = session({ rateLimit: { at: HIT_AT, type: 'five_hour', resetsAt: resetAt } });
  const staleAt = (at) => usageSnapshot([{ label: '5h', percent: 100, resetsAt: '2026-09-06T19:50:00.000Z' }], at);

  const held = resumeDecision({ session: parked, usage: staleAt(NOW - 60 * 60e3), ledger: ledgerWith(null), now: NOW });
  assert.deepEqual(held, { action: 'wait', reason: 'usage snapshot stale', resetAt });

  // Past the grace the clock decides: a usage fetch that has been failing for half
  // an hour must not park the fleet indefinitely.
  const late = NOW + STALE_GRACE_MS;
  const freed = resumeDecision({ session: parked, usage: staleAt(late - 60 * 60e3), ledger: ledgerWith(null), now: late });
  assert.equal(freed.action, 'send');
  assert.match(freed.reason, /sending on the clock$/);

  // A snapshot that does not know this limit at all is no evidence either way.
  const unknownLimit = resumeDecision({
    session: parked,
    usage: usageSnapshot([{ label: 'week', percent: 12, resetsAt: '2026-09-08T00:00:00.000Z' }], NOW - 60 * 60e3),
    ledger: ledgerWith(null),
    now: NOW,
  });
  assert.deepEqual(unknownLimit, { action: 'send', reason: 'limit window has reset', resetAt });

  // Fresh and still at 100%: the window really has not reopened.
  const exhausted = resumeDecision({ session: parked, usage: staleAt(NOW - 60e3), ledger: ledgerWith(null), now: NOW });
  assert.deepEqual(exhausted, { action: 'wait', reason: 'limit still exhausted', resetAt });
});

test('a second limit record for the same window is not resumed twice', async () => {
  const root = tempRoot();
  const sends = [];
  const deps = {
    getUsage: () => usageSnapshot([]),
    send: async (id, text, opts) => { sends.push(opts && opts.hitAt); },
    root,
    stderr: { write: () => {} },
  };
  try {
    await tick({ ...deps, now: NOW, scanSessions: () => [session()] });
    assert.deepEqual(sends, [HIT_AT]);

    // The resumed turn ran straight back into the same closed window, which writes
    // a new error record: new timestamp, same reset. One "continue" per window.
    const again = session({ rateLimit: { at: '2026-09-06T20:00:30.000Z', type: 'five_hour', resetsAt: RESET_AT + 30e3 } });
    const second = await tick({ ...deps, now: NOW + 60e3, scanSessions: () => [again] });
    assert.deepEqual(second, { ok: true, sent: 0, waiting: 0, detail: 'nothing due' });
    assert.deepEqual(sends, [HIT_AT], 'the same window is not resumed again');
    assert.deepEqual(
      resumeDecision({ session: again, usage: usageSnapshot([]), ledger: readLedger(root), now: NOW + 60e3 }),
      { action: 'skip', reason: 'already resumed for this window', resetAt: null },
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the daily cap counts sends across limit events and shows the session as stalled', async () => {
  const root = tempRoot();
  const sends = [];
  const deps = {
    getUsage: () => usageSnapshot([]),
    send: async (id, text, opts) => { sends.push(opts.hitAt); },
    root,
    stderr: { write: () => {} },
  };
  // Distinct events, each with its own window well clear of the last one, so only
  // the per-session daily cap can stop them.
  const events = [0, 1, 2, 3].map((i) => ({
    at: `2026-09-06T1${i}:30:00.000Z`,
    type: 'five_hour',
    resetsAt: RESET_AT - i * 10 * 60e3,
  }));
  try {
    for (const [i, rateLimit] of events.entries()) {
      await tick({ ...deps, now: NOW + i * 60e3, scanSessions: () => [session({ rateLimit })] });
    }
    assert.deepEqual(sends, events.slice(0, MAX_SENDS_PER_DAY).map((e) => e.at));
    const state = dashboardState(root);
    assert.deepEqual(state.waiting, []);
    assert.equal(state.sent.length, MAX_SENDS_PER_DAY);
    assert.deepEqual(state.stalled, [{
      id: 'session-one',
      type: 'five_hour',
      hitAt: events[MAX_SENDS_PER_DAY - 1].at,
      resetAt: events[MAX_SENDS_PER_DAY - 1].resetsAt,
      reason: 'resume cap reached for today',
      state: 'capped',
    }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a session that moved on before the lock costs no attempt', async () => {
  const root = tempRoot();
  const lines = [];
  let error = movedOn('a tool is running');
  const deps = {
    scanSessions: () => [session()],
    getUsage: () => usageSnapshot([]),
    send: async () => { throw error; },
    root,
    stderr: { write: (line) => lines.push(line) },
  };
  try {
    const result = await tick({ ...deps, now: NOW });
    assert.deepEqual(result, { ok: true, sent: 0, waiting: 0, detail: 'moved on 1' });
    const entry = readLedger(root).sessions['session-one'];
    assert.equal(entry.attempts, 0, 'nothing was wrong with the send');
    assert.equal(entry.state, 'moved-on');
    assert.equal(entry.sending, undefined);
    assert.deepEqual(lines, ['keep resume: session- moved on before resume\n']);
    // It is not a stall either: nothing is waiting on Owner.
    assert.deepEqual(dashboardState(root), { waiting: [], sent: [], stalled: [] });

    // Any other refusal is an ordinary failure and does spend an attempt.
    error = Object.assign(new Error('no Claude prompt visible'), { status: 409 });
    await tick({ ...deps, now: NOW + 60e3 });
    assert.equal(readLedger(root).sessions['session-one'].attempts, 1);
    assert.match(lines[1], /^keep resume: could not send \[keep\] continue after the rate limit reset to session-: no Claude prompt visible\n$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a session that keeps moving on is left alone', () => {
  assert.deepEqual(
    resumeDecision({
      session: session(),
      usage: usageSnapshot([]),
      ledger: ledgerWith({ hitAt: HIT_AT, movedOn: MAX_MOVED_ON, attempts: 0, sentHistory: [] }),
      now: NOW,
    }),
    { action: 'skip', reason: 'session keeps moving on', resetAt: null },
  );
});

test('the send is claimed in the ledger before anything is typed', async () => {
  const root = tempRoot();
  let midSend = null;
  try {
    await tick({
      scanSessions: () => [session()],
      getUsage: () => usageSnapshot([]),
      // Read the file the way a restarted daemon would: the claim has to be on
      // disk before the keystrokes, or a crash mid-send double-sends.
      send: async () => { midSend = readLedger(root).sessions['session-one']; },
      now: NOW,
      root,
      stderr: { write: () => {} },
    });
    assert.equal(midSend.sending, NOW);
    assert.equal(midSend.sentAt, undefined);
    assert.equal(midSend.state, 'waiting');
    const after = readLedger(root).sessions['session-one'];
    assert.equal(after.sending, undefined, 'the claim is released once the send lands');
    assert.equal(after.sentAt, NOW);
    assert.equal(after.state, 'sent');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a claim left behind by a dead daemon blocks one retry, then counts as a send', async () => {
  const root = tempRoot();
  const sends = [];
  const deps = {
    scanSessions: () => [session()],
    getUsage: () => usageSnapshot([]),
    send: async (id, text, opts) => { sends.push(opts.hitAt); },
    root,
    stderr: { write: () => {} },
  };
  const claim = (sending) => writeLedgerFile(root, {
    sessions: {
      'session-one': { hitAt: HIT_AT, type: 'five_hour', attempts: 0, sentHistory: [], resetAt: RESET_AT, state: 'waiting', sending },
    },
    history: [],
  });
  try {
    // A claim young enough that the send could still be running: typing now would
    // deliver "continue" twice.
    claim(NOW - 60e3);
    const held = await tick({ ...deps, now: NOW });
    assert.deepEqual(held, { ok: true, sent: 0, waiting: 1, detail: 'waiting 1' });
    assert.deepEqual(sends, []);
    const during = readLedger(root).sessions['session-one'];
    assert.equal(during.sending, NOW - 60e3, 'the claim survives the tick');
    assert.equal(during.attempts, 0);

    // Once no send could still be in flight, the claim is ambiguous: the text may
    // have reached Claude before the daemon died. It counts as sent, so nothing is
    // typed twice and the daily cap still sees it.
    const claimedAt = NOW - SENDING_STALE_MS - 1;
    claim(claimedAt);
    const recovered = await tick({ ...deps, now: NOW + 60e3 });
    assert.equal(recovered.sent, 0);
    assert.deepEqual(sends, []);
    const ledgerAfter = readLedger(root);
    const entry = ledgerAfter.sessions['session-one'];
    assert.equal(entry.sentAt, claimedAt);
    assert.equal(entry.state, 'sent');
    assert.equal(entry.sending, undefined);
    assert.deepEqual(entry.sentHistory, [claimedAt]);
    assert.equal(ledgerAfter.history.length, 1);
    assert.equal(ledgerAfter.history[0].id, 'session-one');
    assert.equal(ledgerAfter.history[0].recovered, true);

    // The same event never sends again after that.
    await tick({ ...deps, now: NOW + 120e3 });
    assert.deepEqual(sends, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a session that burns every attempt is shown as stalled', async () => {
  const root = tempRoot();
  const deps = {
    scanSessions: () => [session()],
    getUsage: () => usageSnapshot([]),
    send: async () => { throw new Error('another session injection is busy'); },
    root,
    stderr: { write: () => {} },
  };
  try {
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) await tick({ ...deps, now: NOW + i * 60e3 });
    const entry = readLedger(root).sessions['session-one'];
    assert.equal(entry.attempts, MAX_ATTEMPTS);
    assert.equal(entry.state, 'gave-up');
    const state = dashboardState(root);
    assert.deepEqual(state.waiting, []);
    assert.equal(state.stalled.length, 1);
    assert.equal(state.stalled[0].state, 'gave-up');

    // The next tick skips it and records why, without another attempt.
    await tick({ ...deps, now: NOW + MAX_ATTEMPTS * 60e3 });
    const skipped = readLedger(root).sessions['session-one'];
    assert.equal(skipped.attempts, MAX_ATTEMPTS);
    assert.equal(skipped.reason, 'too many failed attempts');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
