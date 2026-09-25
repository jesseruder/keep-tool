'use strict';

// The reviewer launcher exports KEEP_REVIEWER* into its shell; tests spawn the CLI
// from process.env, so reviewer-only refusals fired inside them when run from that
// session (17 spurious failures on 2026-09-02). Tests that need reviewer identity set
// it explicitly in their own env object.
for (const k of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[k];

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('scheduled-task timer polls each minute and matches health cadence', () => {
  const intervals = [], timeouts = [];
  const context = { require, module: { exports: {} }, process, Buffer, console,
    setInterval: (_fn, ms) => ({ unref: () => intervals.push(ms) }),
    setTimeout: (_fn, ms) => ({ unref: () => timeouts.push(ms) }) };
  require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('./runs'), 'utf8'), context);
  context.module.exports.startScheduler();
  assert.deepEqual(intervals, [60000]);
  assert.deepEqual(timeouts, [30000]);
  assert.equal(require('./health').CADENCES.runs.cadenceMs, intervals[0]);
});

const {
  checkDeliveryMessage, planDueCard, deliveryWarning, cardFingerprint, pendingCheckin,
  probePayload, startProbe, probeDue, escalateProbeFailure,
  isTransientStartError, MAX_CONCURRENT_PROBES, _resetSchedulerState, _resetSchedulerStateInMemory, recordOpen, grantReopen,
  budgetDeferralReason, noteBudgetDeferral, reapEphemeralPane, sweepEphemeralPanes,
  MAX_FRESH_OPENS_PER_TICK, MAX_DEFERRAL_NOTICES_PER_TICK, EPHEMERAL_IDLE_MS,
  FRESH_OPEN_STAMP_TTL_MS, readDeliveryStamp, writeDeliveryStamp, stampExpired,
  checkinFromSessionAt, openFreshCheckSession, freshOpenRefusal, resetTickAllowance,
  loadSchedulerState, releaseUnfinishedCheck, readRawDeliveryStamp,
} = require('./runs.js');

const card = (over = {}) => ({
  id: 'some-card',
  fm: {
    title: 'SRS off-peak buffer',
    status: 'waiting',
    check_after: '2026-09-04T09:00',
    check: 'Run sim-srs.js for seeds 1-3; if any seed times out, the buffer is not safe to ramp.',
    ...over,
  },
  body: [
    '## 2026-09-01 08:00 — check-in',
    'Deployed v211 to staging. Seeds 1 and 2 green, seed 3 timed out once before the deploy.',
    '',
    '## 2026-08-30 14:00 — check-in',
    'Buffer widened to 8-40. Waiting on a real off-peak window.',
  ].join('\n'),
  ...over.task,
});

test('scheduled check delivery is a bounded one-line instruction', () => {
  const short = checkDeliveryMessage(card());
  assert.doesNotMatch(short, /\n/);
  assert.ok(short.length <= 2000);
  assert.match(short, /some-card/);
  assert.match(short, /keep checkin/);
  assert.match(short, /--clear-check-after/);
  assert.match(short, /read-only check/);
  assert.match(short, /--handoff needs-input/);
  assert.doesNotMatch(short, /recipe truncated/);

  const long = checkDeliveryMessage(card({ check: 'inspect the rollout '.repeat(300) }));
  assert.doesNotMatch(long, /\n/);
  assert.ok(long.length <= 2000);
  assert.match(long, /recipe truncated; full text on the card/);
  assert.match(long, /--handoff needs-input/);
  assert.match(long, /Full card: keep show some-card\./);
  const wide = checkDeliveryMessage(card({ title: 't'.repeat(240), check: 'inspect '.repeat(400), task: { id: 'x'.repeat(48) } }));
  assert.ok(wide.length <= 2000);
  assert.ok(wide.endsWith(`Full card: keep show ${'x'.repeat(48)}.`));
});

test('a delivery stamp only suppresses the exact schedule it records', () => {
  const task = card();
  assert.equal(planDueCard(task, { stamp: { checkAfter: task.fm.check_after } }), 'skip-delivered');
  assert.equal(planDueCard(task, { stamp: { checkAfter: '2026-09-05T09:00' } }), 'deliver');
  assert.equal(planDueCard(task, {}), 'deliver');
});

test('a due card opens its own session only after exceeding the deferral cap', () => {
  const task = card();
  assert.equal(planDueCard(task, { deferrals: { count: 12 }, maxDeferrals: 12 }), 'deliver');
  assert.equal(
    planDueCard(task, { deferrals: { count: 13 }, maxDeferrals: 12 }),
    'open-after-deferrals',
  );
});

test('a truncated thread delivery still stamps and produces a card warning', () => {
  assert.equal(deliveryWarning(card(), { sessionId: 'full', kind: 'claude' }), null);
  assert.deepEqual(deliveryWarning(card(), {
    sessionId: '1234567890abcdef',
    kind: 'claude',
    truncated: true,
    received: 1400,
    expected: 1998,
  }), {
    heading: 'delivery warning',
    message: 'The scheduled check was typed into claude session 12345678 but arrived truncated (1400/1998 chars); the full recipe is on this card (keep show some-card).',
    linkSession: false,
    commitLabel: 'check',
  });
});

// A probe result that could not be committed is written to .keep/runs and retried on a
// later tick; by then the card may have moved.
test('a pending retry cannot apply state or schedule from before a newer card action', () => {
  const queuedAgainst = card({ status: 'waiting', updated: '2026-09-11T12:00' });
  const payload = {
    taskId: queuedAgainst.id,
    heading: 'probe result',
    message: 'probe passed (42ms): segments: 0 missing',
    status: 'review',
    clearCheckAfter: true,
    _retryCardFingerprint: cardFingerprint(queuedAgainst),
  };
  const newer = structuredClone(queuedAgainst);
  newer.body = `${queuedAgainst.body}\n\n## 2026-09-11 12:00 — check-in → waiting\nA newer action.`;
  const stale = pendingCheckin(payload, newer);
  assert.equal(stale.stale, true);
  assert.equal('status' in stale.checkin, false);
  assert.equal('clearCheckAfter' in stale.checkin, false);
  assert.match(stale.checkin.message, /card changed after this result was queued/);

  const fresh = pendingCheckin(payload, queuedAgainst);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.checkin.status, 'review');
  assert.equal(fresh.checkin.clearCheckAfter, true);
  assert.equal('_retryCardFingerprint' in fresh.checkin, false, 'retry metadata never reaches checkinTask');
});

test('an on-pass done card tells a live thread it may close the card itself', () => {
  const message = checkDeliveryMessage(card({ check_on_pass: 'done' }));
  assert.match(message, /declares on-pass: done/);
  assert.match(message, /--status done --clear-check-after/);
  assert.ok(message.length <= 2000);
  assert.ok(message.endsWith('Full card: keep show some-card.'));
  const wide = checkDeliveryMessage(card({ check_on_pass: 'done', check: 'inspect the rollout '.repeat(300) }));
  assert.ok(wide.length <= 2000);
  assert.ok(wide.endsWith('Full card: keep show some-card.'), 'the on-pass sentence never crowds out the card id');
  assert.doesNotMatch(checkDeliveryMessage(card()), /on-pass/);
});

// ---------- deterministic probes ----------

const probeCard = (over = {}) => card({ probe: 'exit 0', project: os.tmpdir(), ...over });

test('a passing probe lands a check-in and applies the card on-pass action', () => {
  const result = { ok: true, code: 0, ms: 42, output: 'segments: 0 missing\n', timedOut: false };

  const legacy = probePayload(probeCard(), result);
  assert.equal(legacy.heading, 'probe result');
  assert.equal(legacy.linkSession, false);
  assert.equal(legacy.commitLabel, 'check');
  assert.equal(legacy.status, 'review');
  assert.equal(legacy.clearCheckAfter, true);
  assert.equal(legacy.message, 'probe passed (42ms): segments: 0 missing');

  const closed = probePayload(probeCard({ check_on_pass: 'done' }), result);
  assert.equal(closed.status, 'done');
  assert.equal(closed.clearCheckAfter, true);
  assert.match(closed.message, /closed as declared by on-pass: done/);

  const rearmed = probePayload(probeCard({ check_on_pass: 'rearm', check_every: '+1d' }), result);
  assert.equal(rearmed.status, 'waiting');
  assert.equal(rearmed.checkAfter, '+1d');
  assert.equal(rearmed.clearCheckAfter, false);
  assert.match(rearmed.message, /re-armed every \+1d/);

  const quiet = probePayload(probeCard(), { ...result, output: '' });
  assert.match(quiet.message, /probe passed \(42ms\): \(no output\)/);
});

test('a failing probe always goes to Owner review, whatever the card declared', () => {
  for (const declared of [{}, { check_on_pass: 'done' }, { check_on_pass: 'rearm', check_every: '+1d' }]) {
    const payload = probePayload(probeCard(declared), {
      ok: false, code: 3, ms: 900, output: 'recorder: 2 segments missing', timedOut: false,
    });
    assert.equal(payload.status, 'review');
    assert.equal(payload.clearCheckAfter, true);
    assert.equal('checkAfter' in payload, false);
    assert.equal(payload.message, 'probe FAILED (exit 3, 900ms): recorder: 2 segments missing');
  }
  const timedOut = probePayload(probeCard(), { ok: false, code: 124, ms: 200, output: '', timedOut: true });
  assert.equal(timedOut.message, 'probe FAILED (exit 124, timed out, 200ms): (no output)');
});

const probeOnce = (task, timeoutMs) => new Promise((resolve) => { startProbe(task, resolve, timeoutMs); });

test('the async probe runner reports exit code, output tail and duration', async () => {
  const passed = await probeOnce(probeCard({ probe: 'echo healthy; echo "to stderr" >&2' }));
  assert.equal(passed.ok, true);
  assert.equal(passed.code, 0);
  assert.equal(passed.timedOut, false);
  assert.match(passed.output, /healthy/);
  assert.match(passed.output, /to stderr/, 'stderr is part of the tail too');
  assert.ok(Number.isFinite(passed.ms));

  const failed = await probeOnce(probeCard({ probe: 'echo "2 segments missing"; exit 3' }));
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 3);
  assert.equal(failed.timedOut, false);
  assert.match(failed.output, /2 segments missing/);
});

test('a probe that hangs is killed with its process group and reported as timed out', async () => {
  const started = Date.now();
  const result = await probeOnce(probeCard({ probe: 'sleep 5' }), 200);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 4000, 'the runner does not wait out the command');
});

test('the probe output tail is bounded', async () => {
  const result = await probeOnce(probeCard({ probe: 'for i in $(seq 1 400); do echo "line $i"; done' }));
  assert.equal(result.ok, true);
  assert.ok(result.output.length <= 500, `tail was ${result.output.length} chars`);
  assert.match(result.output, /line 400$/);
});

test('due probes are capped, and a card held back by the cap is retried unstamped', () => {
  const task = probeCard();
  assert.equal(MAX_CONCURRENT_PROBES, 3);
  assert.equal(probeDue(task, Date.now(), MAX_CONCURRENT_PROBES - 1), true);
  // After downtime every card is due in the same tick; the cap holds the rest back.
  assert.equal(probeDue(task, Date.now(), MAX_CONCURRENT_PROBES), false);
  assert.equal(probeDue(task, Date.now(), MAX_CONCURRENT_PROBES + 4), false);
  // Nothing is recorded for a card the cap skipped, so the next tick may run it —
  // unlike a card that really did probe, which waits out the repeat window.
  assert.equal(probeDue(task, Date.now(), 0), true);
});

test('a transient open refusal is one that may have room on a later tick', () => {
  assert.equal(isTransientStartError(new Error('a run is already active for some-card')), true);
  assert.equal(isTransientStartError(new Error('open request is already launching a different selection')), true);
  assert.equal(isTransientStartError(new Error('terminal host is unavailable; open request identity cannot be verified')), true);
  assert.equal(isTransientStartError(new Error('terminal host did not return a pane')), true);
  assert.equal(isTransientStartError(new Error('project directory does not exist')), false);
  assert.equal(isTransientStartError(new Error('account checks is not a claude account')), false);
});

test('a transient open refusal does not burn the day escalation budget', async () => {
  _resetSchedulerState();
  try {
    const task = probeCard({ check: 'diagnose the recorder' });
    const result = { ok: false, code: 3, ms: 120, output: '2 segments missing', timedOut: false };
    const opened = [];
    const collide = async () => { throw new Error(`a run is already active for ${task.id}`); };
    const record = async (body) => { opened.push(body); return { ok: true, sessionId: 'sess-1', pane: 'p1' }; };

    // Something else is already opening on this card: transient, so tomorrow is not the
    // next chance — this is what the 'runs active' substring test got wrong.
    assert.match(String(await escalateProbeFailure(task, result, { today: '2026-09-11', open: collide })), /already active/);
    assert.equal(opened.length, 0);

    assert.equal(await escalateProbeFailure(task, result, { today: '2026-09-11', open: record, accountId: 'checks-acct' }), null);
    assert.equal(opened.length, 1, 'a later failed probe on the same day still escalates');
    assert.equal(opened[0].taskId, task.id);
    assert.equal(opened[0].fresh, true, 'a check never resumes whatever that card last used');
    assert.equal(opened[0].agent, 'claude');
    assert.equal(opened[0].accountId, 'checks-acct');
    assert.match(opened[0].message, /deterministic probe just failed \(exit 3, tail: 2 segments missing\)/);
    assert.match(opened[0].message, /diagnose the recorder/, 'and the recipe still follows it');
    assert.ok(opened[0].message.length <= 2000);

    // One scheduler-opened session per card per day, once one actually opened.
    assert.equal(await escalateProbeFailure(task, result, { today: '2026-09-11', open: record }), null);
    assert.equal(opened.length, 1);
    assert.equal(await escalateProbeFailure(task, result, { today: '2026-09-12', open: record }), null);
    assert.equal(opened.length, 2, 'tomorrow is a fresh attempt');

    // A real failure is not transient: it costs the day.
    _resetSchedulerState();
    const broken = async () => { throw new Error('project directory does not exist'); };
    assert.match(String(await escalateProbeFailure(task, result, { today: '2026-09-11', open: broken })), /does not exist/);
    assert.equal(await escalateProbeFailure(task, result, { today: '2026-09-11', open: record }), null);
    assert.equal(opened.length, 2, 'no retry after a permanent failure until tomorrow');
  } finally { _resetSchedulerState(); }
});

test('a probe escalation spends from the same allowance as the scheduler', async () => {
  _resetSchedulerState();
  try {
    const task = probeCard({ check: 'diagnose the recorder' });
    const result = { ok: false, code: 3, ms: 120, output: '2 segments missing', timedOut: false };
    const opened = [];
    const open = async (body) => { opened.push(body.taskId); return { ok: true, sessionId: 'sid', pane: 'p' }; };
    const budget = { code: 0 };
    const refusal = (t, today, accountId) => freshOpenRefusal(t, today, accountId, { checkBudget: () => budget });

    // The tick's three opens are already spent: a failing probe does not make a fourth.
    resetTickAllowance();
    for (let n = 0; n < MAX_FRESH_OPENS_PER_TICK; n += 1) {
      const filler = card({ task: { id: `filler-${n}` } });
      filler.id = `filler-${n}`;
      await openFreshCheckSession(filler, { today: '2026-09-11', open, refusal });
    }
    assert.equal(await escalateProbeFailure(task, result, { today: '2026-09-11', open, refusal }), null);
    assert.equal(opened.length, MAX_FRESH_OPENS_PER_TICK, 'the escalation is held back by the per-tick cap');

    // And an exhausted window defers it the same way, with the same card note.
    resetTickAllowance();
    budget.code = 7;
    budget.reason = '5h window at 99%';
    const landed = [];
    assert.equal(await escalateProbeFailure(task, result, {
      today: '2026-09-11', open, refusal, checkinTask: (id, payload) => landed.push([id, payload]),
    }), null);
    assert.equal(opened.length, MAX_FRESH_OPENS_PER_TICK, 'no session is opened without budget');

    budget.code = 0;
    assert.equal(await escalateProbeFailure(task, result, { today: '2026-09-11', open, refusal }), null);
    assert.deepEqual(opened.at(-1), task.id, 'and it opens once the allowance is back');
  } finally { _resetSchedulerState(); }
});

test('a probe escalation clips a shouting probe tail instead of losing the recipe', () => {
  const message = checkDeliveryMessage(probeCard(), {
    probe: { code: 124, timedOut: true, output: 'x'.repeat(4000) },
  });
  assert.ok(message.length <= 2000);
  assert.match(message, /^The deterministic probe just failed \(exit 124, timed out, tail: x{300}…\)\./);
  assert.match(message, /keep checkin some-card/);
  assert.ok(message.endsWith('Full card: keep show some-card.'));
  assert.equal(/deterministic probe/.test(checkDeliveryMessage(probeCard())), false);
});

test('a recurring card is told to re-arm itself, and still fits', () => {
  const message = checkDeliveryMessage(card({ check_on_pass: 'rearm', check_every: '+7d' }));
  assert.match(message, /This card re-arms: if every gate holds, check in with --check-after \+7d and the status unchanged/);
  assert.match(message, /if not, record the failure and the status it deserves/);
  assert.ok(message.length <= 2000);
  assert.ok(message.endsWith('Full card: keep show some-card.'));

  const wide = checkDeliveryMessage(card({
    check_on_pass: 'rearm', check_every: '+7d', check: 'inspect the rollout '.repeat(300),
  }));
  assert.ok(wide.length <= 2000);
  assert.match(wide, /recipe truncated; full text on the card/);
  assert.match(wide, /This card re-arms/, 'the re-arm sentence is never what gets crowded out');
  assert.ok(wide.endsWith('Full card: keep show some-card.'));

  assert.doesNotMatch(checkDeliveryMessage(card()), /re-arms/);
});

test('an unreadable check_every asks for a valid interval instead of quoting garbage', () => {
  for (const fm of [{ check_on_pass: 'rearm' }, { check_on_pass: 'rearm', check_every: 'next tuesday' }]) {
    const message = checkDeliveryMessage(card(fm));
    assert.match(message, /its check_every is unreadable/);
    assert.match(message, /--check-after <a valid interval like \+7d>/);
    assert.doesNotMatch(message, /next tuesday/, 'the unusable value is never handed to the flag');
    assert.ok(message.length <= 2000);
    assert.ok(message.endsWith('Full card: keep show some-card.'));
  }
});

test('card text can never crowd the card id out of the message', () => {
  const message = checkDeliveryMessage(card({
    title: 'T'.repeat(4000),
    check_after: 'A'.repeat(4000),
    check_on_pass: 'rearm',
    check_every: '+7d' + 'B'.repeat(4000),
    check: 'inspect '.repeat(2000),
  }), { probe: { code: 1, output: 'C'.repeat(9000) } });
  assert.ok(message.length <= 2000);
  assert.ok(message.endsWith('Full card: keep show some-card.'));
  assert.match(message, /This card re-arms, but its check_every is unreadable/);
});

// ---------- delivery stamps ----------

test('a stamp for a session Keep opened expires; a thread delivery stamp does not', () => {
  const task = card();
  const at = Date.parse('2026-09-11T12:00');
  assert.equal(FRESH_OPEN_STAMP_TTL_MS, 2 * 3600e3);
  assert.equal(stampExpired({ at: '2026-09-11T12:00' }), false, 'no ttl, no expiry');
  assert.equal(stampExpired({ at: '2026-09-11T12:00', ttlMs: FRESH_OPEN_STAMP_TTL_MS }, at + FRESH_OPEN_STAMP_TTL_MS - 1), false);
  assert.equal(stampExpired({ at: '2026-09-11T12:00', ttlMs: FRESH_OPEN_STAMP_TTL_MS }, at + FRESH_OPEN_STAMP_TTL_MS), true);
  // A stamp with no readable time of its own has no measurable life left.
  assert.equal(stampExpired({ at: 'whenever', ttlMs: FRESH_OPEN_STAMP_TTL_MS }), true);

  writeDeliveryStamp(task, { sessionId: 'thread-sid', kind: 'claude' });
  assert.equal(readDeliveryStamp(task, at + 10 * 3600e3).sessionId, 'thread-sid');

  writeDeliveryStamp(task, { sessionId: 'opened-sid', kind: 'claude', ttlMs: FRESH_OPEN_STAMP_TTL_MS });
  const live = readDeliveryStamp(task, Date.now());
  assert.equal(live.sessionId, 'opened-sid');
  assert.equal(live.ttlMs, FRESH_OPEN_STAMP_TTL_MS);
  // A session that died without checking in must not suppress the card forever.
  assert.equal(readDeliveryStamp(task, Date.now() + FRESH_OPEN_STAMP_TTL_MS), null);
  assert.equal(readDeliveryStamp(task, Date.now()), null, 'and the expired stamp is gone from disk');
});

// ---------- budget deferral ----------

test('only an exhausted window defers a check; an unreadable snapshot does not', () => {
  assert.equal(budgetDeferralReason({ code: 0 }), null);
  assert.equal(budgetDeferralReason({ code: 6, reason: 'weekly usage at 97%' }), 'weekly usage at 97%');
  assert.equal(budgetDeferralReason({ code: 7, reason: '5h window at 99%' }), '5h window at 99%');
  // Code 8 is "I could not read the snapshot". Treating that as no budget would stop
  // every check on the board the first time the usage file went stale.
  assert.equal(budgetDeferralReason({ code: 8, reason: 'usage snapshot is stale' }), null);
  assert.equal(budgetDeferralReason(null), null);
});

test('a deferred check records itself once a day and leaves the card overdue', () => {
  _resetSchedulerState();
  try {
    const task = card();
    const landed = [];
    const deps = { checkinTask: (id, payload) => landed.push([id, payload]) };
    assert.equal(noteBudgetDeferral(task, 'weekly usage at 97%', '2026-09-11', deps), true);
    assert.equal(noteBudgetDeferral(task, 'weekly usage at 97%', '2026-09-11', deps), false, 'once a day');
    assert.equal(landed.length, 1);
    assert.equal(landed[0][0], 'some-card');
    assert.equal(landed[0][1].message, 'check deferred: weekly usage at 97%; will retry after the limit resets');
    assert.equal('status' in landed[0][1], false, 'the card keeps its status');
    assert.equal('clearCheckAfter' in landed[0][1], false, 'and stays overdue for the next tick');
    assert.equal(noteBudgetDeferral(task, 'weekly usage at 97%', '2026-09-12', deps), true, 'tomorrow is a fresh notice');
    assert.equal(landed.length, 2);
  } finally { _resetSchedulerState(); }
});

test('a tick that defers many cards logs them all and writes only a few', () => {
  _resetSchedulerState();
  try {
    assert.equal(MAX_DEFERRAL_NOTICES_PER_TICK, 3);
    const landed = [];
    const deps = { checkinTask: (id) => landed.push(id) };
    // What the tick does once it has written its quota: log, do not commit.
    for (let n = 0; n < 8; n += 1) {
      const task = card({ task: { id: `card-${n}` } });
      task.id = `card-${n}`;
      noteBudgetDeferral(task, 'weekly usage at 97%', '2026-09-11', { ...deps, quiet: n >= MAX_DEFERRAL_NOTICES_PER_TICK });
    }
    assert.deepEqual(landed, ['card-0', 'card-1', 'card-2']);
    // A quieted card was never marked, so a later tick may still record it.
    const later = card({ task: { id: 'card-7' } });
    later.id = 'card-7';
    assert.equal(noteBudgetDeferral(later, 'weekly usage at 97%', '2026-09-11', deps), true);
  } finally { _resetSchedulerState(); }
});

// The quota is three check-ins a tick, not three cards considered: a card that was
// already noticed today writes nothing, so it must not spend another card's turn.
test('cards already noticed today do not consume the tick quota', () => {
  _resetSchedulerState();
  try {
    const landed = [];
    const deps = { checkinTask: (id) => landed.push(id) };
    const cardFor = (id) => { const t = card(); t.id = id; return t; };
    // Yesterday's tick already noticed these two.
    assert.equal(noteBudgetDeferral(cardFor('old-a'), 'weekly usage at 97%', '2026-09-11', deps), true);
    assert.equal(noteBudgetDeferral(cardFor('old-b'), 'weekly usage at 97%', '2026-09-11', deps), true);
    landed.length = 0;

    // Now a tick walks old-a, old-b and four fresh cards, spending the quota the way
    // schedulerTick does — only a written notice advances it.
    let notices = 0;
    for (const id of ['old-a', 'old-b', 'new-a', 'new-b', 'new-c', 'new-d']) {
      if (noteBudgetDeferral(cardFor(id), 'weekly usage at 97%', '2026-09-11',
        { ...deps, quiet: notices >= MAX_DEFERRAL_NOTICES_PER_TICK })) notices += 1;
    }
    assert.deepEqual(landed, ['new-a', 'new-b', 'new-c'], 'the two silent cards cost nobody a turn');
  } finally { _resetSchedulerState(); }
});

test('a card that names its agent opens its check as that agent and records the session', async () => {
  _resetSchedulerState();
  try {
    const bodies = [];
    const calls = [];
    const agents = {
      ensure: (name, fields) => { calls.push(['ensure', name, fields]); return { name, ...fields }; },
      writeRecord: (name, patch) => { calls.push(['write', name, patch]); return { name, ...patch }; },
      flushCommits: () => { calls.push(['flush']); return true; },
    };
    const open = async (body) => { bodies.push(body); return { ok: true, sessionId: 'sid-agent', pane: 'p-agent' }; };
    const refusal = () => null;
    const task = card({ agent: 'redash-daily', project: '~/castle/ghost-server' });
    const outcome = await openFreshCheckSession(task, { today: '2026-09-25', open, refusal, agents });
    assert.equal(outcome.skipped, undefined);
    assert.equal(bodies[0].agentName, 'redash-daily', 'the opener is told whose session this is');
    assert.deepEqual(calls[0], ['ensure', 'redash-daily', { role: 'scheduled check', project: '~/castle/ghost-server', card: 'some-card' }],
      'the record exists before the session, so its first emit is not dropped');
    assert.equal(calls[1][0], 'write');
    assert.equal(calls[1][2].session.id, 'sid-agent');
    assert.equal(calls[1][2].session.pane, 'p-agent');
    assert.equal(calls[1][2].lifecycle, 'working');
    assert.equal(calls[1][2].card, 'some-card');
    assert.deepEqual(calls[2], ['flush']);

    // An ordinary card, or an unusable name, opens as before with no record touched.
    calls.length = 0; bodies.length = 0;
    _resetSchedulerState();
    await openFreshCheckSession(card({ agent: 'Not A Name' }), { today: '2026-09-25', open, refusal, agents });
    assert.equal(bodies[0].agentName, undefined);
    assert.deepEqual(calls, []);
    // A responder's or the reviewer's name is never taken over: the registry's
    // incident areas name their agents, and the reviewer is fleet-reviewer.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-runs-agent-'));
    fs.mkdirSync(path.join(root, 'watch'), { recursive: true });
    fs.writeFileSync(path.join(root, 'watch', 'incidents.json'), JSON.stringify({
      areas: { sandboxes: { project: 'castle-sandboxes', match: ['^Sandbox '] }, 'app-server': { project: 'ghost-server', default: true, agent: 'ghost' } },
    }));
    try {
      for (const reserved of ['sandboxes', 'ghost', 'fleet-reviewer']) {
        calls.length = 0; bodies.length = 0;
        _resetSchedulerState();
        await openFreshCheckSession(card({ agent: reserved }), { today: '2026-09-25', open, refusal, agents, root });
        assert.equal(bodies[0].agentName, undefined, reserved);
        assert.deepEqual(calls, [], reserved);
      }
      // The area's own name is free when its agent is named differently.
      calls.length = 0; bodies.length = 0;
      _resetSchedulerState();
      await openFreshCheckSession(card({ agent: 'app-server' }), { today: '2026-09-25', open, refusal, agents, root });
      assert.equal(bodies[0].agentName, 'app-server');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
    // Nor is a record that exists with another role, whatever the card says.
    calls.length = 0; bodies.length = 0;
    _resetSchedulerState();
    const taken = { ...agents, ensure: (name) => { calls.push(['ensure', name]); return { name, role: 'incident-responder' }; } };
    await openFreshCheckSession(card({ agent: 'somebody' }), { today: '2026-09-25', open, refusal, agents: taken });
    assert.equal(bodies[0].agentName, undefined);
    assert.deepEqual(calls, [['ensure', 'somebody']], 'looked at, never written');
  } finally { _resetSchedulerState(); }
});

test('a card agent goes back into its own session, and opens fresh only when that cannot be resumed', async () => {
  _resetSchedulerState();
  try {
    let record = { name: 'redash-daily', role: 'scheduled check', card: '', homes: { 'some-card': 'sid-home' } };
    const writes = [];
    const agents = {
      ensure: () => record,
      readRecord: () => record,
      writeRecord: (name, patch) => { writes.push(patch); record = { ...record, ...patch }; return record; },
      flushCommits: () => true,
    };
    const bodies = [];
    const openDeps = [];
    let refuse = null;
    const open = async (body, deps) => {
      bodies.push(body); openDeps.push(deps);
      if (body.sessionId && refuse) throw refuse;
      return { ok: true, sessionId: body.sessionId || 'sid-new', pane: 'p' };
    };
    const budgetAccounts = [];
    const refusal = (_task, _today, accountId) => { budgetAccounts.push(accountId); return null; };
    const sessionAccountId = (id) => (id === 'sid-home' ? 'claude-home' : '');
    const task = card({ agent: 'redash-daily', sessions: [{ id: 'sid-home', agent: 'claude' }] });
    const base = { open, refusal, agents, sessionAccountId, accountId: 'claude-pool' };
    const home = () => ({ ...record, homes: { 'some-card': 'sid-home' } });

    // Its home is resumed on this card with the check as the message, on its own
    // account (the budget is that account's), never typed into a live pane.
    await openFreshCheckSession(task, { ...base, today: '2026-09-25' });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].taskId, 'some-card');
    assert.equal(bodies[0].sessionId, 'sid-home');
    assert.equal(bodies[0].fresh, undefined);
    assert.equal(bodies[0].accountId, undefined);
    assert.equal(bodies[0].agentName, 'redash-daily');
    assert.match(bodies[0].message, /sim-srs/);
    assert.equal(openDeps[0].resumeClosedOnly, true);
    assert.deepEqual(budgetAccounts, ['claude-home']);
    assert.deepEqual(writes.at(-1).homes, { 'some-card': 'sid-home' });

    // A pane found up is a deferral: nothing opened, nothing spent, the home kept.
    bodies.length = 0; _resetSchedulerState();
    refuse = Object.assign(new Error('session sid-home is already running'), { status: 409, extra: { code: 'HOME_LIVE' } });
    const busy = await openFreshCheckSession(task, { ...base, today: '2026-09-26' });
    assert.equal(busy.skipped, 'home-busy');
    assert.equal(bodies.length, 1);
    assert.deepEqual(record.homes, { 'some-card': 'sid-home' });

    // A session on another node than the agent's placement falls through to a fresh
    // session, which becomes the home.
    bodies.length = 0; _resetSchedulerState();
    refuse = Object.assign(new Error('session #396 runs on node mac'), { status: 409, extra: { code: 'SESSION_ELSEWHERE' } });
    await openFreshCheckSession(task, { ...base, today: '2026-09-26' });
    assert.deepEqual(bodies.map((b) => [b.sessionId, b.fresh]), [['sid-home', undefined], [undefined, true]]);
    assert.deepEqual(record.homes, { 'some-card': 'sid-new' });

    // Any other refusal is this open failing: nothing fresh beside it, and the home
    // is forgotten so the next run opens fresh.
    record = home(); bodies.length = 0; _resetSchedulerState();
    refuse = Object.assign(new Error('opening-message reservation changed'), { status: 409, extra: {} });
    await assert.rejects(openFreshCheckSession(task, { ...base, today: '2026-09-27' }), /reservation changed/);
    assert.equal(bodies.length, 1);
    assert.deepEqual(record.homes, { 'some-card': '' });

    // One that may have launched a pane, or a host failure, keeps the home.
    for (const error of [
      Object.assign(new Error('launched, readiness lost'), { status: 409, extra: { launch: { pane: 'p' } } }),
      new Error('host did not answer'),
    ]) {
      record = home(); bodies.length = 0; _resetSchedulerState();
      refuse = error;
      await assert.rejects(openFreshCheckSession(task, { ...base, today: '2026-09-28' }));
      assert.equal(bodies.length, 1);
      assert.deepEqual(record.homes, { 'some-card': 'sid-home' });
    }

    // A home whose account is spent while the given account has room: one fresh
    // session there, which becomes the home. Both spent: the budget refusal stands.
    record = home(); bodies.length = 0; _resetSchedulerState(); refuse = null;
    const spent = new Set(['claude-home']);
    const budget = (_task, _today, accountId) => (spent.has(accountId) ? { skipped: 'budget', reason: `${accountId} is spent` } : null);
    await openFreshCheckSession(task, { ...base, refusal: budget, today: '2026-09-30' });
    assert.deepEqual(bodies.map((b) => [b.sessionId, b.fresh, b.accountId]), [[undefined, true, 'claude-pool']]);
    assert.deepEqual(record.homes, { 'some-card': 'sid-new' });
    record = home(); bodies.length = 0; _resetSchedulerState();
    spent.add('claude-pool');
    const held = await openFreshCheckSession(task, { ...base, refusal: budget, today: '2026-10-01' });
    assert.equal(held.skipped, 'budget');
    assert.equal(bodies.length, 0);

    // A home the card no longer links is not reached through it.
    record = home(); bodies.length = 0; _resetSchedulerState(); refuse = null;
    await openFreshCheckSession(card({ agent: 'redash-daily', sessions: [{ id: 'sid-other', agent: 'claude' }] }), { ...base, today: '2026-09-29' });
    assert.deepEqual(bodies.map((b) => [b.sessionId, b.fresh]), [[undefined, true]]);
  } finally { _resetSchedulerState(); }
});

test('an agent that ran before homes were recorded goes back into the card\'s last session only on evidence it was the agent', async () => {
  const { agentHomeSession } = require('./runs.js');
  // The check session checked in on the card at 21:22 and emitted its report then.
  const reportedAt = Date.parse('2026-09-24T21:22:00');
  const log = '\n## 2026-09-24 21:22 — check-in (by claude sid-last)\nMoved: two things.\n';
  const task = card({ agent: 'redash-daily', sessions: [{ id: 'sid-old', agent: 'claude', at: '2026-09-23T07:30' },
    { id: 'sid-last', agent: 'claude', at: '2026-09-24T21:18' }] });
  task.body = log;
  const api = (record) => ({ readRecord: () => record });
  const base = { name: 'redash-daily', role: 'scheduled check', card: '', lastEvent: { card: 'some-card', at: reportedAt } };
  assert.equal(agentHomeSession('redash-daily', task, api(base)), 'sid-last');
  assert.equal(agentHomeSession('redash-daily', task, api({ ...base, lastEvent: { card: 'other-card', at: reportedAt } })), '');
  assert.equal(agentHomeSession('redash-daily', task, api({ ...base, lastEvent: { card: 'some-card', at: reportedAt + 5 * 3600e3 } })), '',
    'a check-in hours away from the report is not the agent\'s');
  const later = { ...task, fm: { ...task.fm, sessions: [...task.fm.sessions, { id: 'sid-owner', agent: 'claude', at: '2026-09-24T22:00' }] } };
  assert.equal(agentHomeSession('redash-daily', later, api(base)), '', 'Owner\'s session linked later never checked in as the agent');
  // Nor when he checked in by name soon after the report: he was linked after it.
  const ownerCheckin = { ...later, body: log + '\n## 2026-09-24 22:05 — check-in (by claude sid-owner)\nRead it.\n' };
  assert.equal(agentHomeSession('redash-daily', ownerCheckin, api(base)), '');
  assert.equal(agentHomeSession('redash-daily', task, api({ ...base, homes: { 'some-card': 'sid-old' } })), 'sid-old');
  assert.equal(agentHomeSession('redash-daily', task, api({ ...base, homes: { 'some-card': 'sid-gone' } })), '', 'no longer linked');
  assert.equal(agentHomeSession('redash-daily', task, api({ ...base, homes: { 'some-card': '' } })), '', 'forgotten');
  assert.equal(agentHomeSession('redash-daily', task, api({ ...base, role: 'incident-responder' })), '');
  assert.equal(agentHomeSession('', task, api(base)), '');
  // An unattributed entry could be anybody's on the card: it is no evidence.
  const unattributed = { ...task, body: '\n## 2026-09-24 21:22 — check-in\nMoved: two things.\n' };
  assert.equal(agentHomeSession('redash-daily', unattributed, api(base)), '');
});

test('when a check was typed into a home survives a daemon restart', () => {
  const runs = require('./runs.js');
  runs._resetSchedulerState();
  try {
    runs.noteHomeDelivery('sid-home');
    const at = runs.homeDeliveredAt('sid-home');
    assert.ok(at > 0);
    runs._resetSchedulerStateInMemory();
    assert.equal(runs.homeDeliveredAt('sid-home'), at, 'read back from the scheduler state file');
    assert.equal(runs.homeDeliveredAt('sid-other'), 0);
  } finally { runs._resetSchedulerState(); }
});

test('the sweep forgets a home whose agent exited without a check-in, and keeps one that finished', async () => {
  for (const exited of [true, false]) {
    const written = [];
    const records = { 'redash-daily': { name: 'redash-daily', role: 'scheduled check', session: { id: 'sid-home' }, homes: { 'some-card': 'sid-home', other: 'sid-x' } } };
    const now = 1_000_000 + 5 * 3600e3;
    await sweepEphemeralPanes({
      listPanes: async () => [ephemeralPane({ id: 'home-pane', alive: !exited, meta: { card: 'some-card', sessionId: 'sid-home', agentName: 'redash-daily' } })],
      sessions: async () => [{ id: 'sid-home', endedTurn: true, mtime: 1_000_000 }],
      closePane: async () => {},
      checkinTask: () => {},
      loadTask: () => card(),
      agents: {
        records: () => Object.values(records),
        readRecord: (name) => records[name] || null,
        writeRecord: (name, patch) => { written.push([name, patch]); },
        flushCommits: () => true,
      },
    }, now);
    const patch = written.find(([name]) => name === 'redash-daily')[1];
    if (exited) assert.deepEqual(patch.homes, { 'some-card': '', other: 'sid-x' }, 'exited with nothing recorded: forgotten');
    else assert.equal(patch.homes, undefined, 'idle past the limit is not a failed resume: the home stays');
  }
});

test('a dead earlier pane of a home is only removed while a live pane runs the same session', async () => {
  const written = [];
  const released = [];
  const records = { 'redash-daily': { name: 'redash-daily', role: 'scheduled check', session: { id: 'sid-home' }, homes: { 'some-card': 'sid-home' } } };
  const now = 1_000_000 + 5 * 3600e3;
  const closed = await sweepEphemeralPanes({
    listPanes: async () => [
      ephemeralPane({ id: 'old-pane', alive: false, meta: { card: 'some-card', sessionId: 'sid-home', agentName: 'redash-daily' } }),
      ephemeralPane({ id: 'new-pane', alive: true, meta: { card: 'some-card', sessionId: 'sid-home', agentName: 'redash-daily', launchedAt: now - 60e3 } }),
    ],
    sessions: async () => [{ id: 'sid-home', endedTurn: false, mtime: now }],
    closePane: async () => {},
    checkinTask: (...args) => released.push(args),
    agents: {
      records: () => Object.values(records),
      readRecord: (name) => records[name] || null,
      writeRecord: (name, patch) => { written.push([name, patch]); },
      flushCommits: () => true,
    },
  }, now);
  assert.deepEqual(closed, ['old-pane']);
  assert.deepEqual(released, [], 'the live pane\'s stamp is not released');
  assert.deepEqual(written, [], 'nor its home forgotten or its record idled');
});

test('the sweep idles an agent whose check pane it closed, or whose pane lost the mark', async () => {
  const written = [];
  const records = {
    'redash-daily': { name: 'redash-daily', role: 'scheduled check', session: { id: 'sid-agent' } },
    // Moved to another node or resumed by hand: its pane no longer carries the mark.
    'moved-check': { name: 'moved-check', role: 'scheduled check', lifecycle: 'working', session: { id: 'sid-moved', pane: 'p-moved', startedAt: 1_000_000 } },
    // Opened seconds ago beside this tick (keep verify): the pane list may predate its
    // pane, so it is left for the next tick.
    'fresh-check': { name: 'fresh-check', role: 'scheduled check', lifecycle: 'working', session: { id: 'sid-fresh', pane: 'p-fresh', startedAt: 1_000_000 + 5 * 3600e3 - 10e3 } },
    // A responder is never this sweep's to idle, however its panes look.
    sandboxes: { name: 'sandboxes', role: 'incident-responder', lifecycle: 'working', session: { id: 'sid-resp', pane: 'p-resp' } },
    // Already idle with no session: nothing to write.
    'quiet-check': { name: 'quiet-check', role: 'scheduled check', lifecycle: 'idle', session: { id: '', pane: '' } },
  };
  const now = 1_000_000 + 5 * 3600e3;
  const result = await sweepEphemeralPanes({
    listPanes: async () => [
      ephemeralPane({ id: 'agent-pane', meta: { card: null, sessionId: 'sid-agent', agentName: 'redash-daily' } }),
      ephemeralPane({ id: 'other-pane', meta: { card: null, sessionId: 'sid-other', agentName: 'somebody-else' } }),
      { id: 'p-moved', alive: true, meta: { sessionId: 'sid-moved', agentName: 'moved-check' } },
    ],
    sessions: async () => [
      { id: 'sid-agent', endedTurn: true, mtime: 1_000_000 },
      { id: 'sid-other', endedTurn: true, mtime: 1_000_000 },
    ],
    closePane: async () => {},
    agents: {
      records: () => Object.values(records),
      readRecord: (name) => records[name] || null,
      writeRecord: (name, patch) => { written.push([name, patch]); },
      flushCommits: () => true,
    },
  }, now);
  assert.deepEqual(result.sort(), ['agent-pane', 'other-pane']);
  assert.deepEqual(written, [
    // The moved check first: its pane carries the name but not the mark.
    ['moved-check', { lifecycle: 'idle', card: '', session: { id: '', pane: '', startedAt: 0 } }],
    // Then the record whose check pane this sweep closed, which lets its session go in
    // the same write; a record already carrying a newer session (or none) is left alone.
    ['redash-daily', { lifecycle: 'idle', card: '', session: { id: '', pane: '', startedAt: 0 } }],
  ]);

  // A host that could not list its panes answers null (never an empty list): nothing
  // is orphaned by a listing that did not happen.
  written.length = 0;
  await sweepEphemeralPanes({
    listPanes: async () => null,
    sessions: async () => [],
    closePane: async () => {},
    agents: { records: () => Object.values(records), readRecord: (name) => records[name] || null,
      writeRecord: (name, patch) => { written.push([name, patch]); }, flushCommits: () => true },
  }, now);
  assert.deepEqual(written, [], 'an unanswered host idles nobody');
  // A host built without an agents module never reaches a registry: a dead check pane
  // that carries an agent's name is still reaped, and nothing is idled or thrown.
  const reaped = await sweepEphemeralPanes({
    listPanes: async () => [ephemeralPane({ id: 'orphan-pane', meta: { card: null, sessionId: 'sid-agent', agentName: 'redash-daily' } })],
    sessions: async () => [{ id: 'sid-agent', endedTurn: true, mtime: 1_000_000 }],
    closePane: async () => {},
  }, now);
  assert.deepEqual(reaped, ['orphan-pane']);
  assert.deepEqual(written, []);
});

test('a card that re-arms more often than daily gets one fresh session per interval', async () => {
  _resetSchedulerState();
  try {
    const open = async () => ({ ok: true, sessionId: 'sid-4h', pane: 'p4' });
    const budget = { code: 0 };
    const at = (now) => (t, today, accountId) => freshOpenRefusal(t, today, accountId, { checkBudget: () => budget, now });
    const task = card({ check_on_pass: 'rearm', check_every: '+4h' });
    // Anchored to the real clock: the saved state keeps a day of opens, judged by it.
    const t0 = Date.now() - 12 * 3600e3;
    assert.equal((await openFreshCheckSession(task, { today: '2026-09-25', open, refusal: at(t0), now: t0 })).skipped, undefined);
    // The same day, but not the same interval: refused until four hours have passed.
    assert.equal((await openFreshCheckSession(task, { today: '2026-09-25', open, refusal: at(t0 + 3600e3), now: t0 + 3600e3 })).skipped, 'opened-within-interval');
    // The interval is judged in wall time from the recorded open, which survives a restart.
    _resetSchedulerStateInMemory();
    assert.equal(loadSchedulerState().openedAt.get('some-card'), t0, 'read back from disk');
    assert.equal((await openFreshCheckSession(task, { today: '2026-09-25', open, refusal: at(t0 + 3600e3), now: t0 + 3600e3 })).skipped, 'opened-within-interval');
    const t1 = t0 + 4 * 3600e3 + 1000;
    resetTickAllowance(); // each of these opens is on its own tick
    assert.equal((await openFreshCheckSession(task, { today: '2026-09-25', open, refusal: at(t1), now: t1 })).skipped, undefined);
    assert.equal(loadSchedulerState().openedAt.get('some-card'), t1);
    // A session that died without recording anything is granted one reopen on the next
    // tick; after that the interval is the ceiling again, so a card whose sessions keep
    // dying opens once per interval plus that one reopen a day.
    grantReopen('some-card', '2026-09-25');
    resetTickAllowance();
    assert.equal((await openFreshCheckSession(task, { today: '2026-09-25', open, refusal: at(t1 + 60e3), now: t1 + 60e3 })).skipped, undefined, 'the reopen');
    assert.equal(grantReopen('some-card', '2026-09-25'), false, 'one reopen a day');
    resetTickAllowance();
    assert.equal((await openFreshCheckSession(task, { today: '2026-09-25', open, refusal: at(t1 + 120e3), now: t1 + 120e3 })).skipped, 'opened-within-interval');
    assert.equal((await openFreshCheckSession(task, { today: '2026-09-25', open, refusal: at(t1 + 5 * 3600e3), now: t1 + 5 * 3600e3 })).skipped, undefined, 'the next interval');
    // An open that failed for good is recorded too, so it is not retried every tick.
    _resetSchedulerState();
    recordOpen('some-card', '2026-09-25', t0);
    assert.equal((await openFreshCheckSession(task, { today: '2026-09-25', open, refusal: at(t0 + 60e3), now: t0 + 60e3 })).skipped, 'opened-within-interval');
    // A daily or one-shot card keeps the one-per-day rule.
    _resetSchedulerState();
    const daily = card({ check_on_pass: 'rearm', check_every: '+1d' });
    assert.equal((await openFreshCheckSession(daily, { today: '2026-09-25', open, refusal: at(t0), now: t0 })).skipped, undefined);
    assert.equal((await openFreshCheckSession(daily, { today: '2026-09-25', open, refusal: at(t0 + 5 * 3600e3), now: t0 + 5 * 3600e3 })).skipped, 'opened-today');
  } finally { _resetSchedulerState(); }
});

test('the per-day and per-tick allowances survive a restart, and verify ignores them', async () => {
  _resetSchedulerState();
  try {
    const task = card();
    const open = async () => ({ ok: true, sessionId: 'sid-1', pane: 'p1' });
    const budget = { code: 0 };
    const refusal = (t, today, accountId) => freshOpenRefusal(t, today, accountId, { checkBudget: () => budget });

    assert.equal((await openFreshCheckSession(task, { today: '2026-09-11', open, refusal })).skipped, undefined);
    assert.equal((await openFreshCheckSession(task, { today: '2026-09-11', open, refusal })).skipped, 'opened-today');
    // The allowance lives on disk, so a restarted daemon does not re-open the card.
    assert.equal(loadSchedulerState().opened.get('some-card'), '2026-09-11');

    // `keep verify` is Owner asking now: never refused, never counted.
    const manual = await openFreshCheckSession(task, { today: '2026-09-11', open, refusal, enforce: false });
    assert.equal(manual.skipped, undefined);
    assert.equal(manual.delivery.ttlMs, FRESH_OPEN_STAMP_TTL_MS, 'and it still writes the TTL stamp');

    // The budget refuses before anything is opened, and names its reason.
    _resetSchedulerState();
    budget.code = 6;
    budget.reason = 'weekly usage at 97%';
    const denied = await openFreshCheckSession(task, { today: '2026-09-11', open, refusal });
    assert.equal(denied.skipped, 'budget');
    assert.equal(denied.reason, 'weekly usage at 97%');

    // The per-tick cap is module state so a probe escalation spends from it too.
    budget.code = 0;
    resetTickAllowance();
    for (let n = 0; n < MAX_FRESH_OPENS_PER_TICK; n += 1) {
      const other = card({ task: { id: `tick-${n}` } });
      other.id = `tick-${n}`;
      assert.equal((await openFreshCheckSession(other, { today: '2026-09-11', open, refusal })).skipped, undefined);
    }
    const overflow = card({ task: { id: 'tick-overflow' } });
    overflow.id = 'tick-overflow';
    assert.equal((await openFreshCheckSession(overflow, { today: '2026-09-11', open, refusal })).skipped, 'tick-cap');
    resetTickAllowance();
    assert.equal((await openFreshCheckSession(overflow, { today: '2026-09-11', open, refusal })).skipped, undefined);
  } finally { _resetSchedulerState(); }
});

test('two opens racing on one card put one agent on it, not two', async () => {
  _resetSchedulerState();
  try {
    const task = card();
    let opens = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const open = async () => { opens += 1; await gate; return { ok: true, sessionId: 'sid-race', pane: 'p1' }; };
    const refusal = (t, today, accountId) => freshOpenRefusal(t, today, accountId, { checkBudget: () => ({ code: 0 }) });
    const first = openFreshCheckSession(task, { today: '2026-09-11', open, refusal });
    const second = openFreshCheckSession(task, { today: '2026-09-11', open, refusal, enforce: false });
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(opens, 1, 'the second caller waits for the first instead of opening a pane');
    assert.equal(a, b, 'and gets the same result back');
    assert.equal(a.opened.sessionId, 'sid-race');
  } finally { _resetSchedulerState(); }
});

// ---------- reaping scheduler-opened panes ----------

const ephemeralPane = ({ meta, ...over } = {}) => ({
  id: 'pane-1', alive: true, ...over,
  meta: { ephemeral: 'check', card: 'some-card', sessionId: 'sess-1', launchedAt: 1_000_000, ...meta },
});

test('a scheduler-opened pane is never closed mid-turn', () => {
  const now = 1_000_000 + 5 * 60e3;
  const mid = reapEphemeralPane({
    pane: ephemeralPane(), session: { id: 'sess-1', endedTurn: false, mtime: now }, checkedInAt: now, now,
  });
  assert.equal(mid.reap, false);
  assert.equal(mid.reason, 'mid-turn');
  // Even hours later: an interactive session exists precisely so a long turn survives.
  assert.equal(reapEphemeralPane({
    pane: ephemeralPane(), session: { id: 'sess-1', endedTurn: false, mtime: 1_000_000 },
    checkedInAt: 0, now: 1_000_000 + 5 * 3600e3,
  }).reap, false);
});

test('a scheduler-opened pane is closed once its check is on the card', () => {
  const now = 1_000_000 + 5 * 60e3;
  const done = reapEphemeralPane({
    pane: ephemeralPane(), session: { id: 'sess-1', endedTurn: true, mtime: now },
    checkedInAt: 1_000_000 + 60e3, now,
  });
  assert.equal(done.reap, true);
  assert.match(done.reason, /recorded on the card/);

  // Ended its turn but said nothing on the card yet: give it the idle window first.
  assert.equal(reapEphemeralPane({
    pane: ephemeralPane(), session: { id: 'sess-1', endedTurn: true, mtime: now }, checkedInAt: 0, now,
  }).reap, false);
});

test('a scheduler-opened pane that goes quiet or exits is swept at the idle window', () => {
  const launchedAt = 1_000_000;
  const stale = reapEphemeralPane({
    pane: ephemeralPane(), session: { id: 'sess-1', endedTurn: true, mtime: launchedAt },
    checkedInAt: 0, now: launchedAt + EPHEMERAL_IDLE_MS,
  });
  assert.equal(stale.reap, true);
  assert.match(stale.reason, /idle 60 min with no check-in/);
  assert.equal(reapEphemeralPane({
    pane: ephemeralPane(), session: { id: 'sess-1', endedTurn: true, mtime: launchedAt },
    checkedInAt: 0, now: launchedAt + EPHEMERAL_IDLE_MS - 1,
  }).reap, false);

  assert.equal(reapEphemeralPane({ pane: ephemeralPane({ alive: false }), now: launchedAt }).reap, true);
  assert.equal(reapEphemeralPane({
    pane: ephemeralPane(), session: { id: 'sess-1', exited: true }, now: launchedAt,
  }).reap, true);
});

test('a check-in counts only when that session wrote it', () => {
  const launchedAt = Date.parse('2026-09-11T12:00');
  const task = card({
    sessions: [{ id: 'mine', agent: 'claude', at: '2026-09-11T12:00' }],
    task: { body: '' },
  });
  const withLog = (...entries) => ({ ...task, body: entries.join('\n\n') });

  // The owning session's own entries carry no attribution: an unattributed entry on a
  // card this pane owns is this pane's.
  assert.equal(
    checkinFromSessionAt(withLog('## 2026-09-11 12:05 — check-in → review\nGates held.'), 'mine', launchedAt),
    Date.parse('2026-09-11T12:05'));
  // Anyone else's entry is not this session's check-in, however recent.
  assert.equal(checkinFromSessionAt(withLog('## 2026-09-11 12:05 — check-in (by claude other) → review\nNot mine.'), 'mine', launchedAt), 0);
  assert.equal(checkinFromSessionAt(withLog('## 2026-09-11 12:05 — review (reviewer fable)\nA finding.'), 'mine', launchedAt), 0);
  // A named entry that names this session counts even when the card link has moved.
  assert.equal(
    checkinFromSessionAt({ ...withLog('## 2026-09-11 12:05 — check-in (by claude mine) → review\nMine.'), fm: { ...task.fm, sessions: [] } }, 'mine', launchedAt),
    Date.parse('2026-09-11T12:05'));
  // Log stamps are minute-resolution, so an entry from the launch minute does not count:
  // it may well have been written a moment before the pane came up.
  assert.equal(checkinFromSessionAt(withLog('## 2026-09-11 12:00 — check-in → review\nEarlier.'), 'mine', launchedAt), 0);
  assert.equal(checkinFromSessionAt(withLog('## 2026-09-11 11:00 — check-in → review\nOlder.'), 'mine', launchedAt), 0);
  assert.equal(checkinFromSessionAt(null, 'mine', launchedAt), 0);
  assert.equal(checkinFromSessionAt(withLog('## Plan\n- [ ] step'), 'mine', launchedAt), 0);
});

// A check that finishes inside the minute it was asked for is the normal case for a
// fast recipe, and it used to be reaped as "no result" and re-opened. An entry that
// names this session is proof of its author, so it counts from the launch minute.
test('a session that signs its check-in is credited from the launch minute', () => {
  const sessionId = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
  const launchedAt = Date.parse('2026-09-11T12:00') + 20e3; // opened 20 seconds in
  const task = card({ sessions: [], task: { body: '' } });
  const signed = {
    ...task,
    body: `## 2026-09-11 12:00 — check-in (by claude ${sessionId}) → review
Gates held; nothing to ramp.`,
  };
  assert.equal(checkinFromSessionAt(signed, sessionId, launchedAt), Date.parse('2026-09-11T12:00'));

  // The pane is therefore closed as finished, not released as a dead session.
  const pane = ephemeralPane({ meta: { card: 'some-card', sessionId, launchedAt } });
  const decision = reapEphemeralPane({
    pane, session: { id: sessionId, endedTurn: true, mtime: launchedAt + 30e3 },
    checkedInAt: checkinFromSessionAt(signed, sessionId, launchedAt), now: launchedAt + 60e3,
  });
  assert.equal(decision.reap, true);
  assert.equal(decision.checkedIn, true);
  assert.match(decision.reason, /recorded on the card/);

  // Another session's signature in the same minute still does not count, and neither
  // does an unattributed entry: only the signed one earns the launch minute.
  const other = { ...task, body: '## 2026-09-11 12:00 — check-in (by claude 00000000-0000-4000-8000-000000000000) → review\nTheirs.' };
  assert.equal(checkinFromSessionAt(other, sessionId, launchedAt), 0);
  const unsigned = { ...task, fm: { ...task.fm, sessions: [{ id: sessionId, agent: 'claude' }] },
    body: '## 2026-09-11 12:00 — check-in → review\nUnsigned, same minute.' };
  assert.equal(checkinFromSessionAt(unsigned, sessionId, launchedAt), 0);
  assert.equal(
    checkinFromSessionAt({ ...unsigned, body: '## 2026-09-11 12:01 — check-in → review\nUnsigned, next minute.' }, sessionId, launchedAt),
    Date.parse('2026-09-11T12:01'));
});

test('the sweep only ever touches panes this scheduler opened', async () => {
  const closed = [];
  const panes = [
    { id: 'owner-pane', alive: true, meta: { card: 'some-card', sessionId: 'owner' } },
    ephemeralPane({ id: 'ready', meta: { card: null, sessionId: 'ready-sid' } }),
    ephemeralPane({ id: 'busy', meta: { card: null, sessionId: 'busy-sid' } }),
    ephemeralPane({ id: 'unregistered', meta: { card: null, sessionId: null } }),
  ];
  const now = 1_000_000 + 5 * 3600e3;
  const result = await sweepEphemeralPanes({
    listPanes: async () => panes,
    sessions: async () => [
      { id: 'owner', endedTurn: true, mtime: 1 },
      { id: 'ready-sid', endedTurn: true, mtime: 1_000_000 },
      { id: 'busy-sid', endedTurn: false, mtime: 1_000_000 },
    ],
    closePane: async (pane, sessionId) => { closed.push([pane.id, sessionId]); },
  }, now);
  assert.deepEqual(result, ['ready']);
  assert.deepEqual(closed, [['ready', 'ready-sid']]);

  // A host that cannot answer is not a host with nothing running.
  assert.deepEqual(await sweepEphemeralPanes({
    listPanes: async () => { throw new Error('host is restarting'); },
    closePane: async () => { throw new Error('must not close'); },
  }, now), []);
  assert.deepEqual(await sweepEphemeralPanes({
    listPanes: async () => null, closePane: async () => { throw new Error('must not close'); },
  }, now), []);
  assert.deepEqual(await sweepEphemeralPanes(null, now), []);
});

test('a pane that refuses to close gracefully is left alone, not forgotten and not killed', async () => {
  _resetSchedulerState();
  try {
    const removed = [];
    const landed = [];
    const now = 1_000_000 + 5 * 3600e3;
    const result = await sweepEphemeralPanes({
      listPanes: async () => [ephemeralPane({ meta: { card: null, sessionId: 'sid' } })],
      sessions: async () => [{ id: 'sid', endedTurn: true, mtime: 1_000_000 }],
      // This is what closeIdleSession does when the session still has an unsent draft,
      // a modal prompt, or unverified background work. The sweep must respect it.
      closePane: async () => { throw new Error('Unsent draft in the input box'); },
      removePane: async (pane) => { removed.push(pane.id); },
      checkinTask: (id) => landed.push(id),
    }, now);
    assert.deepEqual(result, [], 'nothing was closed');
    assert.deepEqual(removed, [], 'and the pane is still there for the next tick to reconsider');
    assert.deepEqual(landed, []);
  } finally { _resetSchedulerState(); }
});

test('a closed pane is removed from the host, and a dead one is removed without a close', async () => {
  _resetSchedulerState();
  try {
    const closed = [];
    const removed = [];
    const released = [];
    const now = 1_000_000 + 5 * 3600e3;
    const host = {
      listPanes: async () => [
        ephemeralPane({ id: 'finished', meta: { card: null, sessionId: 'finished-sid' } }),
        ephemeralPane({ id: 'dead', alive: false, meta: { card: null, sessionId: 'dead-sid' } }),
      ],
      sessions: async () => [{ id: 'finished-sid', endedTurn: true, mtime: 1_000_000 }],
      closePane: async (pane, sessionId) => { closed.push([pane.id, sessionId]); },
      removePane: async (pane) => { removed.push(pane.id); },
      checkinTask: (id, payload) => released.push([id, payload.heading]),
    };
    assert.deepEqual(await sweepEphemeralPanes(host, now), ['finished', 'dead']);
    assert.deepEqual(closed, [['finished', 'finished-sid']], 'a dead pane is never asked to /exit');
    assert.deepEqual(removed, ['finished', 'dead'], 'both are forgotten so the next tick has nothing to decide');
    // Neither pane is linked to a card here, so there is nothing to release.
    assert.deepEqual(released, []);
  } finally { _resetSchedulerState(); }
});

test('the ephemeral sweep leaves a session an account transfer is moving alone', async () => {
  _resetSchedulerState();
  const keepModule = require('./keep.js');
  const previousRoot = keepModule.ROOT;
  const previousWrite = process.stderr.write;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-runs-transfer-'));
  try {
    keepModule.ROOT = root;
    const sid = 'transferring-sid';
    const recordFile = path.join(root, '.keep', 'account-handoffs', `${sid}.json`);
    fs.mkdirSync(path.dirname(recordFile), { recursive: true });
    const now = 1_000_000 + 5 * 3600e3;
    // A transfer stops the source agent on purpose, so mid-transfer the pane reads
    // here as an agent that has exited — and closing it takes away the pane the
    // retry resumes into.
    fs.writeFileSync(recordFile, JSON.stringify({
      sessionId: sid, status: 'recovery-needed', phase: 'stopping-source', updatedAt: now - 30e3 }));
    const closed = [], removed = [], lines = [];
    const host = {
      listPanes: async () => [ephemeralPane({ id: 'moving', alive: false, meta: { card: null, sessionId: sid } })],
      sessions: async () => [{ id: sid, exited: true, mtime: 1_000_000 }],
      closePane: async (pane, id) => { closed.push([pane.id, id]); },
      removePane: async (pane) => { removed.push(pane.id); },
    };
    process.stderr.write = (line) => { lines.push(String(line)); return true; };
    const result = await sweepEphemeralPanes(host, now);
    process.stderr.write = previousWrite;
    assert.deepEqual(result, [], 'the pane is not closed');
    assert.deepEqual(closed, []);
    assert.deepEqual(removed, [], 'and it is not forgotten either, so the next tick reconsiders it');
    assert.ok(lines.some((line) => line.includes('an account transfer is in flight (recovery-needed/stopping-source)')),
      lines.join(''));

    // Once the transfer is done the same pane is reaped exactly as before.
    fs.writeFileSync(recordFile, JSON.stringify({ sessionId: sid, status: 'done', phase: 'done', updatedAt: now }));
    process.stderr.write = () => true;
    assert.deepEqual(await sweepEphemeralPanes(host, now), ['moving']);
    process.stderr.write = previousWrite;
    assert.deepEqual(removed, ['moving']);
  } finally {
    process.stderr.write = previousWrite;
    keepModule.ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
    _resetSchedulerState();
  }
});

test('a pane that will not be forgotten leaves its card exactly as it was', async () => {
  _resetSchedulerState();
  try {
    const released = [];
    const now = 1_000_000 + 5 * 3600e3;
    const result = await sweepEphemeralPanes({
      listPanes: async () => [ephemeralPane({ meta: { card: 'some-card', sessionId: 'sid' } })],
      sessions: async () => [{ id: 'sid', endedTurn: true, mtime: 1_000_000 }],
      closePane: async () => {},
      // The usual reason a host refuses to forget a pane is that it is alive again.
      removePane: async () => { throw new Error('pane is running'); },
      checkinTask: (id) => released.push(id),
    }, now);
    assert.deepEqual(result, [], 'the pane is not reported closed');
    assert.deepEqual(released, [], 'and its card keeps its stamp and its allowance');
  } finally { _resetSchedulerState(); }
});

test('a session reaped without a result releases the card instead of burying the check', () => {
  _resetSchedulerState();
  try {
    const landed = [];
    // Pretend the card was opened and stamped earlier today.
    const task = card();
    writeDeliveryStamp(task, { sessionId: 'deadsession1234', kind: 'claude', ttlMs: FRESH_OPEN_STAMP_TTL_MS });
    loadSchedulerState().opened.set('some-card', '2026-09-11');

    assert.equal(releaseUnfinishedCheck('some-card', 'deadsession1234', '2026-09-11',
      { checkinTask: (id, payload) => landed.push([id, payload]) }), true);
    assert.equal(readDeliveryStamp(task, Date.now()), null, 'the stamp no longer suppresses the card');
    assert.equal(loadSchedulerState().opened.has('some-card'), false, 'and the card may be opened again today');
    assert.equal(landed.length, 1);
    assert.equal(landed[0][1].message,
      'check session deadsess ended without recording a result; the check will be re-opened on the next tick');
    assert.equal('status' in landed[0][1], false, 'the card keeps whatever status it had');

    // Only one extra open a day: a card whose sessions keep dying does not loop.
    loadSchedulerState().opened.set('some-card', '2026-09-11');
    writeDeliveryStamp(task, { sessionId: 'deadsession1234', kind: 'claude', ttlMs: FRESH_OPEN_STAMP_TTL_MS });
    assert.equal(releaseUnfinishedCheck('some-card', 'deadsession1234', '2026-09-11', { checkinTask: () => {} }), false);
    assert.equal(loadSchedulerState().opened.get('some-card'), '2026-09-11');
  } finally { _resetSchedulerState(); }
});

// Between the open and the reap the card may have been rescheduled and re-delivered —
// to a thread, or to a later session. Clearing that stamp would put a second agent on a
// check somebody else is already running.
test('a reaped session releases only the stamp it wrote', () => {
  _resetSchedulerState();
  try {
    const task = card();
    const landed = [];
    const deps = { checkinTask: (id, payload) => landed.push([id, payload]) };
    writeDeliveryStamp(task, { sessionId: 'someone-else', kind: 'claude' });
    loadSchedulerState().opened.set('some-card', '2026-09-11');

    assert.equal(releaseUnfinishedCheck('some-card', 'the-dead-session', '2026-09-11', deps), false);
    assert.equal(readRawDeliveryStamp('some-card').sessionId, 'someone-else', 'the newer delivery stands');
    assert.equal(loadSchedulerState().opened.get('some-card'), '2026-09-11', 'and no extra open is granted');
    assert.deepEqual(landed, [], 'nor is a card note written about somebody else\'s check');

    // Its own stamp it may clear.
    writeDeliveryStamp(task, { sessionId: 'the-dead-session', kind: 'claude', ttlMs: FRESH_OPEN_STAMP_TTL_MS });
    assert.equal(releaseUnfinishedCheck('some-card', 'the-dead-session', '2026-09-11', deps), true);
    assert.equal(readRawDeliveryStamp('some-card'), null);
    assert.equal(landed.length, 1);
  } finally { _resetSchedulerState(); }
});

// ---------- the scheduler opens sessions instead of running headless ----------

test('due checks open one fresh session per card per day, three per tick', () => {
  assert.equal(MAX_FRESH_OPENS_PER_TICK, 3);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-runs-open-'));
  try {
    fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
    for (const n of [1, 2, 3, 4]) {
      fs.writeFileSync(path.join(root, 'tasks', `due-${n}.md`), [
        '---',
        `title: Due card ${n}`,
        'status: waiting',
        'kind: task',
        'tags: [personal]',
        'check_after: 2020-01-01T00:00',
        'check: |',
        '  Confirm the recorder is still green.',
        'created: 2020-01-01T00:00',
        'updated: 2020-01-01T00:00',
        '---',
        '',
        'Context.',
        '',
      ].join('\n'));
    }
    const script = `
      const runs = require(${JSON.stringify(require.resolve('./runs.js'))});
      const opened = [];
      runs.setOpener(async (body) => { opened.push(body.taskId); return { ok: true, sessionId: 'sid-' + opened.length, pane: 'p' }; });
      (async () => {
        await runs.schedulerTick();
        const first = opened.slice();
        await runs.schedulerTick();
        process.stdout.write(JSON.stringify({ first, all: opened }));
      })();
    `;
    const output = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1', KEEP_NO_COMMIT: '1' },
    });
    const { first, all } = JSON.parse(output);
    assert.equal(first.length, 3, 'the per-tick cap holds the fourth card back');
    assert.equal(all.length, 4, 'the next tick picks up the card the cap skipped');
    assert.equal(new Set(all).size, 4, 'and no card is opened twice the same day');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a check open that failed for the day holds the runs row failing through the idle ticks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-runs-giveup-'));
  try {
    fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks', 'due-1.md'), [
      '---', 'title: Due card', 'status: waiting', 'kind: task', 'tags: [personal]',
      'check_after: 2020-01-01T00:00', 'check: |', '  Confirm the recorder is still green.',
      'created: 2020-01-01T00:00', 'updated: 2020-01-01T00:00', '---', '', 'Context.', '',
    ].join('\n'));
    const script = `
      const runs = require(${JSON.stringify(require.resolve('./runs.js'))});
      runs.setOpener(async () => { throw new Error('the card project does not exist'); });
      (async () => {
        const fs = require('fs');
        const read = () => JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root, '.keep', 'health.json'))}, 'utf8')).runs;
        await runs.schedulerTick();
        const first = read();
        await runs.schedulerTick();
        process.stdout.write(JSON.stringify({ first, second: read() }));
      })();
    `;
    const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1', KEEP_NO_COMMIT: '1' };
    delete env.CLAUDE_CODE_SESSION_ID;
    const { first, second } = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }));
    assert.deepEqual([first.lastResult, first.consecutiveFailures], ['failed', 1]);
    // The card is marked opened for the day, so the next tick has nothing due; the fault
    // has not gone anywhere, so that skip holds the failure rather than a clean result.
    assert.equal(second.detail, 'nothing due', JSON.stringify({ first, second }));
    assert.deepEqual([second.lastResult, second.consecutiveFailures], ['failed', 1]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The bookkeeping that stops a card being opened or noticed twice is only worth
// anything if it survives the restart that used to reset it.
test('the per-day allowances are read back from disk by a fresh process', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-runs-state-'));
  try {
    const stateFile = path.join(root, '.keep', 'runs', 'scheduler-state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const read = (contents) => {
      fs.writeFileSync(stateFile, contents);
      const script = `
        const runs = require(${JSON.stringify(require.resolve('./runs.js'))});
        const state = runs.loadSchedulerState();
        process.stdout.write(JSON.stringify({
          opened: Object.fromEntries(state.opened),
          budgetNotice: Object.fromEntries(state.budgetNotice),
          reopened: Object.fromEntries(state.reopened),
        }));
      `;
      return JSON.parse(execFileSync(process.execPath, ['-e', script], {
        encoding: 'utf8', env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' },
      }));
    };

    assert.deepEqual(read(JSON.stringify({
      opened: { 'card-a': '2026-09-11' },
      budgetNotice: { 'card-b': '2026-09-11' },
      reopened: { 'card-a': '2026-09-11' },
    })), {
      opened: { 'card-a': '2026-09-11' },
      budgetNotice: { 'card-b': '2026-09-11' },
      reopened: { 'card-a': '2026-09-11' },
    });

    // Bookkeeping, not a record: a file that cannot be parsed, or one written by a
    // future shape, degrades to empty rather than taking the scheduler down with it.
    const empty = { opened: {}, budgetNotice: {}, reopened: {} };
    assert.deepEqual(read('{"opened":{"card-a":'), empty, 'truncated JSON');
    assert.deepEqual(read('not json at all'), empty);
    assert.deepEqual(read('[]'), empty, 'an array is not a state file');
    assert.deepEqual(read(JSON.stringify({ opened: { 'card-a': 7, 'card-b': null }, budgetNotice: 'nope' })),
      empty, 'entries that are not id -> day strings are dropped');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A recurring check skips the card's linked threads — except a card agent's own
// session, which is the one place its check is meant to go.
test('a recurring card agent check is typed into its own session, waits for it when busy, and resumes it when it is not up', () => {
  for (const mode of ['live', 'closed', 'busy']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-runs-home-'));
    try {
      fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
      fs.writeFileSync(path.join(root, 'tasks', 'daily-card.md'), [
        '---', 'title: Daily card', 'status: waiting', 'kind: task', 'tags: [personal]',
        'agent: redash-daily', 'check_on_pass: rearm', 'check_every: +1d', 'scheduled_by: sid-builder',
        'sessions:', '  - id: sid-home', '    agent: claude', '    at: 2020-01-01T00:00',
        'check_after: 2020-01-01T00:00', 'check: |', '  Review yesterday.',
        'created: 2020-01-01T00:00', 'updated: 2020-01-01T00:00', '---', '', 'Context.', '',
      ].join('\n'));
      const script = `
        process.env.KEEP_DELIVER_MAX_DEFERRALS = '1';
        const runs = require(${JSON.stringify(require.resolve('./runs.js'))});
        const agents = require(${JSON.stringify(require.resolve('./agents.js'))});
        agents.writeRecord('redash-daily', { role: 'scheduled check', homes: { 'daily-card': 'sid-home' } });
        const delivered = [];
        const opened = [];
        runs.setDeliverer(async (task, deps) => {
          delivered.push(deps && deps.candidateIds);
          return ${JSON.stringify(mode)} === 'live' ? { sessionId: 'sid-home', kind: 'claude' }
            : ${JSON.stringify(mode)} === 'busy' ? { deferred: true, reason: 'linked thread is mid-turn' } : null;
        });
        runs.setOpener(async (body) => { opened.push({ taskId: body.taskId, sessionId: body.sessionId, fresh: body.fresh });
          return { ok: true, sessionId: body.sessionId || 'sid-new', pane: 'p' }; });
        runs.setEphemeralHost({ listPanes: async () => [], sessions: async () => [], closePane: async () => {} });
        (async () => {
          for (let i = 0; i < 3; i++) await runs.schedulerTick();
          let stamp = null;
          try { stamp = JSON.parse(require('fs').readFileSync(require('path').join(process.env.KEEP_DIR, '.keep', 'runs', 'daily-card.delivered.json'), 'utf8')); } catch {}
          process.stdout.write(JSON.stringify({ delivered, opened, stamp, homes: agents.readRecord('redash-daily').homes }));
        })();
      `;
      const state = JSON.parse(execFileSync(process.execPath, ['-e', script], {
        encoding: 'utf8', env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1', KEEP_NO_COMMIT: '1' },
      }));
      assert.deepEqual(state.delivered[0], ['sid-home'], 'only the agent\'s session is a candidate, not the card\'s builder');
      if (mode === 'live') {
        assert.deepEqual(state.opened, [], 'typed into the live session: nothing opened');
        assert.equal(state.stamp && state.stamp.sessionId, 'sid-home');
        assert.equal(state.stamp.ttlMs, 2 * 3600e3, 'the stamp expires like a fresh open\'s: nobody watches a home');
      }
      else if (mode === 'busy') {
        assert.ok(state.delivered.length >= 2, 'a busy home is offered the check again on later ticks');
        assert.deepEqual(state.opened, [{ taskId: 'daily-card', fresh: true }],
          'and, stuck past the deferral limit, abandoned for one fresh session');
        assert.deepEqual(state.homes, { 'daily-card': 'sid-new' }, 'which is the home from then on');
      } else assert.deepEqual(state.opened, [{ taskId: 'daily-card', sessionId: 'sid-home' }], 'resumed, not fresh');
      if (mode !== 'busy') assert.deepEqual(state.homes, { 'daily-card': 'sid-home' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('a home pane typed into again is judged on the new check, not the earlier check-in', () => {
  const { reapEphemeralPane } = require('./runs.js');
  const launchedAt = 1_000_000;
  const pane = { id: 'p', alive: true, meta: { ephemeral: 'check', launchedAt } };
  const session = { endedTurn: true, mtime: launchedAt + 60e3 };
  const earlier = launchedAt + 120e3;
  assert.equal(reapEphemeralPane({ pane, session, checkedInAt: earlier, now: launchedAt + 3 * 3600e3 }).reap, true);
  const deliveredAt = launchedAt + 3 * 3600e3;
  const judged = reapEphemeralPane({ pane, session, checkedInAt: 0, now: deliveredAt + 1000, deliveredAt });
  assert.equal(judged.reap, false, 'just typed into: not finished, and its idle clock starts at the delivery');
});

// The failure this whole TTL-and-release design exists for: a session Keep opened dies
// without writing anything, and the delivery stamp it left behind suppresses the card's
// check until its `check_after` changes — which nothing is left to change.
test('a check session that dies without a result is reopened on a later tick', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-runs-reopen-'));
  try {
    fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks', 'due-card.md'), [
      '---', 'title: Due card', 'status: waiting', 'kind: task', 'tags: [personal]',
      'check_after: 2020-01-01T00:00', 'check: |', '  Confirm the recorder is still green.',
      'created: 2020-01-01T00:00', 'updated: 2020-01-01T00:00', '---', '', 'Context.', '',
    ].join('\n'));
    const script = `
      const fs = require('fs');
      const runs = require(${JSON.stringify(require.resolve('./runs.js'))});
      const keep = require(${JSON.stringify(require.resolve('./keep.js'))});
      const opened = [];
      let pane = null;
      runs.setOpener(async (body) => {
        const sessionId = 'sid-' + (opened.length + 1);
        opened.push(sessionId);
        pane = { id: 'pane-' + sessionId, alive: true,
          meta: { ephemeral: 'check', card: body.taskId, sessionId, launchedAt: Date.now() } };
        return { ok: true, sessionId, pane: pane.id };
      });
      const removed = [];
      runs.setEphemeralHost({
        listPanes: async () => (pane ? [pane] : []),
        sessions: async () => [],
        closePane: async () => {},
        removePane: async (p) => { removed.push(p.id); pane = null; },
      });
      (async () => {
        await runs.schedulerTick();                       // opens a session
        const afterOpen = opened.slice();
        await runs.schedulerTick();                       // stamped: nothing to do
        const afterStamp = opened.slice();
        pane.alive = false;                               // the agent dies, saying nothing
        await runs.schedulerTick();                       // the sweep reaps and releases
        const afterReap = opened.slice();
        await runs.schedulerTick();                       // the card is due again
        process.stdout.write(JSON.stringify({ afterOpen, afterStamp, afterReap, opened, removed,
          body: keep.loadTask('due-card').body }));
      })();
    `;
    const output = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' },
    });
    const state = JSON.parse(output);
    assert.deepEqual(state.afterOpen, ['sid-1']);
    assert.deepEqual(state.afterStamp, ['sid-1'], 'the stamp stops the next tick opening a second pane');
    assert.deepEqual(state.afterReap, ['sid-1'], 'reaping itself opens nothing');
    assert.deepEqual(state.removed, ['pane-sid-1'], 'the dead pane is forgotten');
    assert.deepEqual(state.opened, ['sid-1', 'sid-2'], 'and the very next tick opens a second session');
    assert.match(state.body, /check session sid-1 ended without recording a result/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


// ---------- bounding a deferral streak ----------

const {
  handleBudgetDeferral, checksFallbackAccountId, checksAccountId, setOpener, MAX_FALLBACK_ATTEMPTS,
} = require('./runs.js');

test('the checks account is the automation pool pick, or its best member when the pool is spent', () => {
  const asked = [];
  const select = (answer) => (options) => { asked.push(options); return answer; };
  const room = () => ({ code: 0 });
  // The pool has room: its pick, whatever the fixed map says.
  assert.equal(checksAccountId({}, {
    selectAccount: select({ account: 'claude-secondary', ranked: [{ id: 'claude-secondary' }] }),
    checkBudget: room, proxyModel: () => 'opus',
  }), 'claude-secondary');
  assert.equal(asked[0].purpose, 'checks');
  assert.equal(asked[0].model, 'opus', 'asked about the model the budget is classified against');
  assert.equal(asked[0].recordHealth, false, 'a per-tick read never rewrites the health row');
  // The pool's first pick has a spent 5h window the weekly ranking did not see: the
  // next member with room runs the check instead of the card deferring.
  const budget = (id) => (id === 'claude-tertiary' ? { code: 7, reason: '5h at 100%' } : { code: 0 });
  assert.equal(checksAccountId({}, {
    selectAccount: select({ account: 'claude-tertiary', ranked: [{ id: 'claude-tertiary' }, { id: 'claude-secondary' }] }),
    checkBudget: budget, proxyModel: () => 'opus',
  }), 'claude-secondary');
  // Spent: the best pool member, so the scheduler's own deferral runs against it and
  // the owner's default account is never the one that "refused".
  assert.equal(checksAccountId({}, {
    selectAccount: select({ account: null, deferred: true, retryAt: 1, ranked: [{ id: 'claude-tertiary', exhausted: true }, { id: 'claude-secondary', exhausted: true }] }),
    checkBudget: () => ({ code: 6, reason: 'week at 100%' }), proxyModel: () => 'opus',
  }), 'claude-tertiary');
  // No pool at all: the fixed assignment select already answered with.
  assert.equal(checksAccountId({}, {
    selectAccount: select({ account: 'claude/default', ranked: [] }), checkBudget: room, proxyModel: () => 'opus',
  }), 'claude/default');
  // A selector that cannot answer at all leaves the fixed assignment in charge: in an
  // isolated registry with nothing configured, that is the one default account.
  const throwing = { selectAccount: () => { throw new Error('config unreadable'); } };
  assert.equal(checksAccountId({ KEEP_DIR: '/nonexistent/keep' }, throwing), 'claude/default');
});

test('a check deferred a second day escalates once instead of deferring forever', async () => {
  _resetSchedulerState();
  try {
    const task = card();
    const landed = [];
    const deps = { checkinTask: (id, payload) => landed.push(payload), fallbackAccountId: null };
    const first = await handleBudgetDeferral(task, 'weekly usage at 97%', '2026-09-16', deps);
    assert.equal(first.noticed, true);
    assert.deepEqual(landed.map((entry) => entry.heading), ['check deferred']);

    const second = await handleBudgetDeferral(task, 'weekly usage at 97%', '2026-09-17', deps);
    assert.equal(second.escalated, true, 'the second deferred day is the ceiling');
    assert.equal(landed.length, 2);
    assert.equal(landed[1].heading, 'check stalled');
    assert.match(landed[1].message, /deferred since .* on 2 separate days/);
    assert.match(landed[1].message, /keep verify some-card/);
    assert.equal('status' in landed[1], false, 'a stalled check still does not touch the card');
    assert.equal('clearCheckAfter' in landed[1], false);

    // And from here the card is quiet: the stalled record and keep overdue carry it.
    for (const day of ['2026-09-18', '2026-09-19']) {
      const later = await handleBudgetDeferral(task, 'weekly usage at 97%', day, deps);
      assert.equal(later.escalated, undefined, 'escalation does not repeat');
      assert.equal(later.noticed, false, 'and neither does the daily notice');
    }
    assert.equal(landed.length, 2);
  } finally { _resetSchedulerState(); }
});

test('an escalation retries on the configured fallback account and clears the streak', async () => {
  _resetSchedulerState();
  const opened = [];
  setOpener(async (body) => { opened.push(body); return { ok: true, sessionId: 'sid-fb', pane: 'p9' }; });
  try {
    const task = card();
    const landed = [];
    const deps = { checkinTask: (id, payload) => landed.push(payload), fallbackAccountId: 'claude-secondary' };
    await handleBudgetDeferral(task, 'weekly usage at 97%', '2026-09-16', deps);
    const escalated = await handleBudgetDeferral(task, 'weekly usage at 97%', '2026-09-17', deps);
    assert.equal(escalated.escalated, true);
    assert.equal(opened.length, 1, 'the fallback account gets exactly one attempt');
    assert.equal(opened[0].accountId, 'claude-secondary');
    assert.equal(opened[0].taskId, 'some-card');
    assert.equal(landed.at(-1).heading, 'check deferred');
    assert.match(landed.at(-1).message, /opened on the configured fallback account claude-secondary/);
    assert.equal(loadSchedulerState().deferred.has('some-card'), false, 'a check that ran is not deferred');
  } finally { setOpener(null); _resetSchedulerState(); }
});

test('a fallback account that is exhausted too lands a stalled check that names it', async () => {
  _resetSchedulerState();
  setOpener(async () => { throw new Error('the opener must not be reached without budget'); });
  try {
    const task = card();
    const landed = [];
    const deps = {
      checkinTask: (id, payload) => landed.push(payload),
      fallbackAccountId: 'claude-secondary',
      refusal: () => ({ skipped: 'budget', reason: 'weekly usage at 99%' }),
    };
    await handleBudgetDeferral(task, 'weekly usage at 97%', '2026-09-16', deps);
    const escalated = await handleBudgetDeferral(task, 'weekly usage at 97%', '2026-09-17', deps);
    assert.equal(escalated.escalated, true);
    assert.equal(landed.at(-1).heading, 'check stalled');
    assert.match(landed.at(-1).message, /the fallback account claude-secondary is out of budget too/);
    assert.equal(loadSchedulerState().deferred.get('some-card').escalated, true);
  } finally { setOpener(null); _resetSchedulerState(); }
});

// The tick's own bookkeeping is not a verdict on the fallback: a card held back by
// the per-day open or the per-tick cap must escalate on a later tick, not be latched
// as stalled by a refusal that had nothing to do with the account.
test('a tick-local refusal leaves the escalation for the next tick', async () => {
  _resetSchedulerState();
  setOpener(async () => ({ ok: true, sessionId: 'sid-fb', pane: 'p9' }));
  try {
    const task = card();
    const landed = [];
    const deps = {
      checkinTask: (id, payload) => landed.push(payload),
      fallbackAccountId: 'claude-secondary',
      refusal: () => ({ skipped: 'tick-cap' }),
    };
    await handleBudgetDeferral(task, 'weekly usage at 97%', '2026-09-16', deps);
    const held = await handleBudgetDeferral(task, 'weekly usage at 97%', '2026-09-17', deps);
    assert.equal(held.escalated, false);
    assert.equal(held.retry, true);
    assert.equal(landed.length, 1, 'nothing is written for a refusal the fallback never saw');
    assert.equal(loadSchedulerState().deferred.get('some-card').escalated, false, 'and the streak stays unlatched');
  } finally { setOpener(null); _resetSchedulerState(); }
});

test('only an explicitly configured fallback purpose counts as a fallback', () => {
  const accounts = (automationAccounts, records) => ({
    publicState: () => ({ automationAccounts }),
    get: (id) => records.find((entry) => entry.id === id) || null,
  });
  const claude = [{ id: 'claude-primary', agent: 'claude' }, { id: 'claude-secondary', agent: 'claude' }];
  // Unset: automationFor would answer with the agent default, which is the very
  // account that just refused.
  assert.equal(checksFallbackAccountId({}, {
    accounts: accounts({ claude: 'claude-primary' }, claude), checksAccountId: () => 'claude-primary',
  }), undefined);
  assert.equal(checksFallbackAccountId({}, {
    accounts: accounts({ claude: 'claude-primary', 'checks-fallback': 'claude-primary' }, claude),
    checksAccountId: () => 'claude-primary',
  }), undefined, 'the checks account is not its own fallback');
  assert.equal(checksFallbackAccountId({}, {
    accounts: accounts({ 'checks-fallback': 'claude-secondary' }, claude), checksAccountId: () => 'claude-primary',
  }), 'claude-secondary');
  assert.equal(checksFallbackAccountId({}, {
    accounts: accounts({ 'checks-fallback': 'codex-main' }, [...claude, { id: 'codex-main', agent: 'codex' }]),
    checksAccountId: () => 'claude-primary',
  }), undefined, 'a Codex account cannot run a Claude check');
});

test('a transient fallback launch failure leaves the escalation for later', async () => {
  _resetSchedulerState();
  setOpener(async () => { throw new Error('terminal host is unavailable'); });
  try {
    const task = card();
    const landed = [];
    const deps = { checkinTask: (id, payload) => landed.push(payload), fallbackAccountId: 'claude-secondary' };
    await handleBudgetDeferral(task, 'weekly usage at 97%', '2026-09-16', deps);
    const held = await handleBudgetDeferral(task, 'weekly usage at 97%', '2026-09-17', deps);
    assert.equal(held.escalated, false, 'a host that was restarting is not a verdict on the account');
    assert.equal(landed.length, 1);
    assert.equal(loadSchedulerState().deferred.get('some-card').escalated, false);

    // A failure that is not transient does land the stalled notice.
    setOpener(async () => { throw new Error('no such account'); });
    const stalled = await handleBudgetDeferral(task, 'weekly usage at 97%', '2026-09-18', deps);
    assert.equal(stalled.escalated, true);
    assert.equal(landed.at(-1).heading, 'check stalled');
    assert.match(landed.at(-1).message, /could not be opened \(no such account\)/);
  } finally { setOpener(null); _resetSchedulerState(); }
});

test('a failure in the deferral bookkeeping does not burn the card daily open', async () => {
  _resetSchedulerState();
  try {
    const task = card();
    const handled = await handleBudgetDeferral(task, 'weekly usage at 97%', '2026-09-16', {
      recordBudgetDeferral: () => { throw new Error('the scheduler state is unwritable'); },
    });
    // The caller's own catch marks the card opened for the day on a non-transient
    // error, and nothing was opened here at all.
    assert.deepEqual(handled, { noticed: false });
    assert.equal(loadSchedulerState().opened.has('some-card'), false);
  } finally { _resetSchedulerState(); }
});

// Opening a session is async: two cards whose opens overlap both used to read the
// allowance before either had spent it, and the tick launched more panes than the cap.
test('the per-tick allowance is reserved before the open, not counted after it', async () => {
  _resetSchedulerState();
  try {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const opened = [];
    const open = async (body) => { opened.push(body.taskId); await gate; return { ok: true, sessionId: 'sid', pane: 'p' }; };
    const cardFor = (id) => { const t = card(); t.id = id; return t; };
    const budget = { code: 0 };
    const refusal = (t, today, accountId) => freshOpenRefusal(t, today, accountId, { checkBudget: () => budget });

    const inFlight = [];
    for (const id of ['a', 'b', 'c']) {
      inFlight.push(openFreshCheckSession(cardFor(id), { today: '2026-09-16', open, refusal }));
    }
    // A fourth card asks while the first three are still awaiting their opener.
    const fourth = await openFreshCheckSession(cardFor('d'), { today: '2026-09-16', open, refusal });
    assert.equal(fourth.skipped, 'tick-cap', 'the cap sees the three opens already in flight');
    release();
    await Promise.all(inFlight);
    assert.deepEqual(opened, ['a', 'b', 'c']);
  } finally { _resetSchedulerState(); }
});

test('an open that fails gives its slot back', async () => {
  _resetSchedulerState();
  try {
    const cardFor = (id) => { const t = card(); t.id = id; return t; };
    const budget = { code: 0 };
    const refusal = (t, today, accountId) => freshOpenRefusal(t, today, accountId, { checkBudget: () => budget });
    const failing = async () => { throw new Error('terminal host is unavailable'); };
    for (const id of ['a', 'b', 'c', 'd']) {
      await assert.rejects(openFreshCheckSession(cardFor(id), { today: '2026-09-16', open: failing, refusal }));
    }
    const after = await openFreshCheckSession(cardFor('e'), {
      today: '2026-09-16', refusal, open: async () => ({ ok: true, sessionId: 'sid', pane: 'p' }),
    });
    assert.equal(after.skipped, undefined, 'four failed opens did not spend the tick');
  } finally { _resetSchedulerState(); }
});

test('a refund from a previous tick does not hand this tick a free slot', async () => {
  _resetSchedulerState();
  try {
    const cardFor = (id) => { const t = card(); t.id = id; return t; };
    const budget = { code: 0 };
    const refusal = (t, today, accountId) => freshOpenRefusal(t, today, accountId, { checkBudget: () => budget });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    // A probe callback reserves an open near the end of a tick and its opener rejects
    // during the next one.
    const late = openFreshCheckSession(cardFor('late'), {
      today: '2026-09-16', refusal, open: async () => { await gate; throw new Error('boom'); },
    });
    resetTickAllowance();
    const opened = [];
    const open = async (body) => { opened.push(body.taskId); return { ok: true, sessionId: 'sid', pane: 'p' }; };
    for (const id of ['a', 'b', 'c']) {
      await openFreshCheckSession(cardFor(id), { today: '2026-09-16', refusal, open });
    }
    release();
    await assert.rejects(late);
    const extra = await openFreshCheckSession(cardFor('d'), { today: '2026-09-16', refusal, open });
    assert.equal(extra.skipped, 'tick-cap', 'the old tick\'s refund belongs to the old tick');
    assert.deepEqual(opened, ['a', 'b', 'c']);
  } finally { _resetSchedulerState(); }
});

test('a fallback host that is never available still reaches a stalled record', async () => {
  _resetSchedulerState();
  setOpener(async () => { throw new Error('terminal host is unavailable'); });
  try {
    const task = card();
    const landed = [];
    const deps = { checkinTask: (id, payload) => landed.push(payload), fallbackAccountId: 'claude-secondary' };
    await handleBudgetDeferral(task, 'weekly usage at 97%', '2026-09-16', deps);
    for (let n = 0; n < MAX_FALLBACK_ATTEMPTS - 1; n += 1) {
      const held = await handleBudgetDeferral(task, 'weekly usage at 97%', '2026-09-17', deps);
      assert.equal(held.escalated, false, `retry ${n + 1} is still worth trying`);
    }
    const done = await handleBudgetDeferral(task, 'weekly usage at 97%', '2026-09-17', deps);
    assert.equal(done.escalated, true, 'a host unavailable for three escalations is not transient');
    assert.equal(landed.at(-1).heading, 'check stalled');
    assert.match(landed.at(-1).message, /attempts failed/);
    assert.equal(loadSchedulerState().deferred.get('some-card').escalated, true);
  } finally { setOpener(null); _resetSchedulerState(); }
});

test('any successful open ends the deferral streak, not only the scheduler own path', async () => {
  _resetSchedulerState();
  try {
    const task = card();
    const landed = [];
    const deps = { checkinTask: (id, payload) => landed.push(payload), fallbackAccountId: null };
    await handleBudgetDeferral(task, 'weekly usage at 97%', '2026-09-16', deps);
    assert.equal(loadSchedulerState().deferred.has('some-card'), true);

    // `keep verify` — Owner asking for the check now. It does not spend the scheduler's
    // allowance, but the check did run, so the card is not deferred any more.
    await openFreshCheckSession(task, {
      today: '2026-09-16', enforce: false, open: async () => ({ ok: true, sessionId: 'sid', pane: 'p' }),
    });
    assert.equal(loadSchedulerState().deferred.has('some-card'), false,
      'a stale streak would carry its fallback attempts into the next exhausted window');
  } finally { _resetSchedulerState(); }
});

test('the fallback notice dates the streak, not the card due date', async () => {
  _resetSchedulerState();
  const opened = [];
  setOpener(async (body) => { opened.push(body); return { ok: true, sessionId: 'sid-fb', pane: 'p9' }; });
  try {
    // The card came due long before anything deferred it — a daemon that was down when
    // it fell due did not defer it for those days.
    const task = card({ check_after: '2020-01-01T00:00' });
    const landed = [];
    const deps = { checkinTask: (id, payload) => landed.push(payload), fallbackAccountId: 'claude-secondary' };
    await handleBudgetDeferral(task, 'weekly usage at 97%', '2026-09-16', deps);
    const since = loadSchedulerState().deferred.get('some-card').since;
    await handleBudgetDeferral(task, 'weekly usage at 97%', '2026-09-17', deps);
    assert.equal(opened.length, 1);
    assert.match(landed.at(-1).message, new RegExp(`check deferred since ${since.replace('T', ' ')} on the checks account`));
    assert.doesNotMatch(landed.at(-1).message, /2020-01-01/);
  } finally { setOpener(null); _resetSchedulerState(); }
});

test('the ephemeral sweep leaves the panes of another node alone, exited or not', async () => {
  const closed = [];
  const removed = [];
  const now = 1_000_000 + 5 * 3600e3;
  const result = await sweepEphemeralPanes({
    listPanes: async () => [
      ephemeralPane({ id: 'local', meta: { card: null, sessionId: 'local-sid' } }),
      // Ripe for reaping by every rule this sweep knows — and on another machine,
      // where closing it and releasing its card's stamp rest on evidence this
      // process cannot produce.
      ephemeralPane({ id: 'r@aws1', node: 'aws1', hostPaneId: 'r', alive: false, meta: { card: 'some-card', sessionId: 'remote-sid' } }),
    ],
    sessions: async () => [
      { id: 'local-sid', endedTurn: true, mtime: 1_000_000 },
      { id: 'remote-sid', endedTurn: true, mtime: 1_000_000 },
    ],
    closePane: async (pane, sessionId) => { closed.push([pane.id, sessionId]); },
    removePane: async (pane) => { removed.push(pane.id); },
    checkinTask: () => assert.fail('a remote check must not be released from here'),
  }, now);
  assert.deepEqual(result, ['local']);
  assert.deepEqual(closed, [['local', 'local-sid']]);
  assert.deepEqual(removed, ['local']);
});

test('the orphan pass counts a check pane on a node as carried, and leaves a node that did not answer alone', async () => {
  const written = [];
  const records = {
    // Its check pane runs on aws1, and aws1 answered with it.
    'on-node': { name: 'on-node', role: 'scheduled check', lifecycle: 'working', session: { id: 'sid-node', pane: 'n@aws1', startedAt: 1_000_000 } },
    // Its check pane runs on aws2, which did not answer this listing at all.
    unheard: { name: 'unheard', role: 'scheduled check', lifecycle: 'working', session: { id: 'sid-unheard', pane: 'u@aws2', startedAt: 1_000_000 } },
    // Its node answered and no pane carries it: orphaned, as on the daemon node.
    gone: { name: 'gone', role: 'scheduled check', lifecycle: 'working', session: { id: 'sid-gone', pane: 'g@aws1', startedAt: 1_000_000 } },
  };
  const now = 1_000_000 + 5 * 3600e3;
  const closed = [];
  const result = await sweepEphemeralPanes({
    listPanes: async () => ({
      panes: [
        ephemeralPane({ id: 'n@aws1', node: 'aws1', hostPaneId: 'n', meta: { card: null, sessionId: 'sid-node', agentName: 'on-node' } }),
      ],
      missingNodes: ['aws2'],
    }),
    sessions: async () => [{ id: 'sid-node', endedTurn: true, mtime: 1_000_000 }],
    closePane: async (pane) => { closed.push(pane.id); },
    agents: {
      records: () => Object.values(records),
      readRecord: (name) => records[name] || null,
      writeRecord: (name, patch) => { written.push([name, patch]); },
      flushCommits: () => true,
    },
  }, now);
  assert.deepEqual(written, [['gone', { lifecycle: 'idle', card: '', session: { id: '', pane: '', startedAt: 0 } }]]);
  // Reaping a node's pane is a separate decision; this listing shape changes nothing there.
  assert.deepEqual(result, []);
  assert.deepEqual(closed, []);
});

test('a host that can close on a node reaps a finished check pane there, on that node\'s read of the session', async () => {
  const now = 1_000_000 + 5 * 3600e3;
  const closed = [];
  const removed = [];
  const asked = [];
  const result = await sweepEphemeralPanes({
    listPanes: async () => ({
      panes: [
        // Checked in and ended, on a node that answered: reaped.
        ephemeralPane({ id: 'done@aws1', node: 'aws1', hostPaneId: 'done', meta: { card: null, sessionId: 'sid-done' } }),
        // Mid-turn on its node: left.
        ephemeralPane({ id: 'busy@aws1', node: 'aws1', hostPaneId: 'busy', meta: { card: null, sessionId: 'sid-busy' } }),
        // Its node could not read it: left, however ripe it looks here.
        ephemeralPane({ id: 'unread@aws1', node: 'aws1', hostPaneId: 'unread', meta: { card: null, sessionId: 'sid-unread' } }),
        // The last panes of a node that did not answer: never considered.
        ephemeralPane({ id: 'stale@aws2', node: 'aws2', hostPaneId: 'stale', alive: false, meta: { card: 'some-card', sessionId: 'sid-stale' } }),
      ],
      missingNodes: ['aws2'],
    }),
    // This machine's scan has none of them.
    sessions: async () => [],
    remoteClose: true,
    remoteSession: async (id) => {
      asked.push(id);
      if (id === 'sid-unread') throw new Error('node aws1 did not answer');
      return { id, endedTurn: id !== 'sid-busy', mtime: 1_000_000 };
    },
    closePane: async (pane, sessionId) => { closed.push([pane.id, sessionId]); },
    removePane: async (pane) => { removed.push(pane.id); },
    checkinTask: () => {},
  }, now);
  assert.deepEqual(result, ['done@aws1']);
  assert.deepEqual(closed, [['done@aws1', 'sid-done']]);
  assert.deepEqual(removed, ['done@aws1']);
  assert.deepEqual(asked.sort(), ['sid-busy', 'sid-done', 'sid-unread']);
});

test('a placed agent whose node is silent waits: nothing is spent, the feed hears it once, an open clears it', async () => {
  _resetSchedulerState();
  try {
    const record = { name: 'redash-daily', role: 'scheduled check', node: 'aws1', session: { id: '' } };
    const emitted = [];
    const agentApi = {
      ensure: () => record,
      readRecord: () => record,
      writeRecord: (name, patch) => Object.assign(record, patch),
      emit: (name, event) => emitted.push(event),
      flushCommits: () => true,
    };
    const silent = async () => {
      throw Object.assign(new Error('node aws1 did not answer (host connect timed out); the check waits for it'), { code: 'NODE_WAIT', node: 'aws1' });
    };
    const opts = { today: '2026-09-25', agents: agentApi, cardAgent: () => 'redash-daily', refusal: () => null };
    for (let i = 0; i < 3; i += 1) {
      const outcome = await openFreshCheckSession(card(), { ...opts, open: silent });
      assert.equal(outcome.skipped, 'node-wait');
      assert.match(outcome.reason, /node aws1 did not answer/);
    }
    assert.equal(loadSchedulerState().opened.has('some-card'), false, 'a wait is not the day\'s open');
    assert.equal(emitted.length, 1, 'said once, not every tick');
    assert.match(emitted[0].text, /node aws1 is not answering; this agent waits for it/);
    assert.equal(record.nodeWait.node, 'aws1');
    const outcome = await openFreshCheckSession(card(), { ...opts, open: async () => ({ ok: true, sessionId: 'sid', pane: 'p@aws1' }) });
    assert.equal(outcome.skipped, undefined);
    assert.equal(record.nodeWait, null);
    assert.equal(record.session.pane, 'p@aws1');
  } finally { _resetSchedulerState(); }
});
