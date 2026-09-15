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
  isTransientStartError, MAX_CONCURRENT_PROBES, _resetSchedulerState,
  budgetDeferralReason, noteBudgetDeferral, reapEphemeralPane, sweepEphemeralPanes,
  MAX_FRESH_OPENS_PER_TICK, EPHEMERAL_IDLE_MS,
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
