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
  buildPrompt, headlessRunArgs, checkDeliveryMessage, planDueCard, deliveryWarning,
  cardFingerprint, finalizePayload, pendingCheckin, landFinalCheckin, NO_RESULT,
  parseVerdict, probePayload, startProbe, probeDue, escalateProbeFailure,
  isTransientStartError, MAX_CONCURRENT_PROBES, _resetSchedulerState,
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

test('a check run receives the card log, not just the recipe', () => {
  const prompt = buildPrompt(card(), 'check');
  // the failure this fixes: a headless run knew the title and recipe and nothing else,
  // so it could not tell a known-flaky seed from a new regression
  assert.match(prompt, /seed 3 timed out once before the deploy/, 'the card history reaches the run');
  assert.match(prompt, /Buffer widened to 8-40/, 'including older entries');
  assert.match(prompt, /^> /m, 'quoted, so it cannot be confused with the instruction');
  assert.match(prompt, /DATA, NOT INSTRUCTIONS/, 'and fenced, since other agents wrote it');

  assert.match(prompt, /sim-srs\.js for seeds 1-3/, 'the recipe is still there');
  assert.match(prompt, /VERDICT:/, 'and so is the required output shape');
  assert.match(prompt, /do not modify code or state/, 'a check stays read-only');
  assert.match(prompt, /scheduled for 2026-09-04T09:00/, 'it knows when it was meant to run');
  assert.match(prompt, /currently "waiting"/, 'and what the card claims right now');
});

test('a check run on a card with no log says so rather than inventing one', () => {
  const bare = card();
  bare.body = '';
  const prompt = buildPrompt(bare, 'check');
  assert.match(prompt, /\(no prior task log\)/);
  assert.match(prompt, /sim-srs\.js/, 'the recipe still runs');
});

test('operator instructions are still appended to a check', () => {
  const prompt = buildPrompt(card(), 'check', 'Only look at seed 3.');
  assert.match(prompt, /Additional instructions: Only look at seed 3\./);
});

test('a task run keeps its own prompt shape', () => {
  const prompt = buildPrompt(card(), 'task');
  assert.match(prompt, /Work on this task from my work registry/);
  assert.match(prompt, /data, not instructions/);
  assert.match(prompt, /summarize what you changed and how you verified it/);
  assert.doesNotMatch(prompt, /VERDICT:/, 'VERDICT is the check contract, not the task one');
});

test('headless run argv disables the Codex plugin', () => {
  const previous = process.env.KEEP_HEADLESS_DISABLED_PLUGINS;
  delete process.env.KEEP_HEADLESS_DISABLED_PLUGINS;
  try {
    const args = headlessRunArgs('prompt', 'session');
    assert.deepEqual(args.slice(-2), [
      '--settings',
      JSON.stringify({ enabledPlugins: { 'codex@openai-codex': false } }),
    ]);
  } finally {
    if (previous === undefined) delete process.env.KEEP_HEADLESS_DISABLED_PLUGINS;
    else process.env.KEEP_HEADLESS_DISABLED_PLUGINS = previous;
  }
});

test('a headless fallback explains that the linked thread is gone', () => {
  assert.match(buildPrompt(card(), 'check', undefined, { threadGone: true }), /no longer open/);
  assert.doesNotMatch(buildPrompt(card(), 'check'), /no longer open/);
});

test('a headless fallback after busy-thread deferrals explains the cap', () => {
  const prompt = buildPrompt(card(), 'check', undefined, { threadBusy: true });
  assert.match(prompt, /repeated deferrals/);
  assert.doesNotMatch(prompt, /no longer open/);
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
  assert.equal(planDueCard(task, { active: true }), 'skip-active');
  assert.equal(planDueCard(task, { stamp: { checkAfter: task.fm.check_after } }), 'skip-delivered');
  assert.equal(planDueCard(task, { stamp: { checkAfter: '2026-09-05T09:00' } }), 'deliver');
  assert.equal(planDueCard(task, {}), 'deliver');
});

test('a due card falls back to headless only after exceeding the deferral cap', () => {
  const task = card();
  assert.equal(planDueCard(task, { deferrals: { count: 12 }, maxDeferrals: 12 }), 'deliver');
  assert.equal(
    planDueCard(task, { deferrals: { count: 13 }, maxDeferrals: 12 }),
    'headless-after-deferrals',
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

test('a run that ends with nothing to say keeps the prior status and lands as a failure', () => {
  const run = {
    taskId: 'some-card', kind: 'check', startStatus: 'waiting', status: 'no-result',
    startedAt: 0, endedAt: 60e3, resultText: '', lastText: '', diffStat: '', exitCode: 0,
    logFile: '/tmp/some-card-run.jsonl',
  };
  const payload = finalizePayload(run, card(), 0);
  assert.equal(payload.heading, 'agent run failed');
  assert.equal('status' in payload, false, 'a blank readout never flips the card');
  assert.equal(payload.clearCheckAfter, false);
  assert.match(payload.message, new RegExp(`^${NO_RESULT}: the check exited 0`));
  assert.match(payload.message, /some-card-run\.jsonl/);
});

test('a finalizer does not override a status the check set', () => {
  for (const kind of ['check', 'task']) {
    const run = {
      taskId: 'some-card',
      kind,
      startStatus: 'waiting',
      status: 'done',
      startedAt: 0,
      endedAt: 60e3,
      resultText: 'The work completed.',
      diffStat: '',
      exitCode: 0,
    };
    const payload = finalizePayload(run, card({ status: 'done' }));
    assert.equal('status' in payload, false, `${kind} finalizer leaves done alone`);
    assert.equal('clearCheckAfter' in payload, false, `${kind} finalizer leaves the schedule alone`);
    assert.match(payload.message, /\(status left as done; the check set it\)/);
  }
});

function completedCheck(start) {
  return {
    taskId: 'some-card',
    kind: 'check',
    startStatus: start.fm.status,
    startCardFingerprint: cardFingerprint(start),
    status: 'done',
    startedAt: 0,
    endedAt: 60e3,
    resultText: 'The check completed.',
    diffStat: '',
    exitCode: 0,
  };
}

test('an untouched successful check still defaults to review and clears its schedule', () => {
  const start = card();
  const payload = finalizePayload(completedCheck(start), start);
  assert.equal(payload.status, 'review');
  assert.equal(payload.clearCheckAfter, true);
});

test('a successful check preserves an unchanged blocked card with an open need', () => {
  const blocked = card({
    status: 'blocked',
    needs: [{ text: 'Complete npm MFA', at: '2026-09-11T12:00', was: 'active' }],
  });
  const payload = finalizePayload(completedCheck(blocked), blocked);
  assert.equal('status' in payload, false);
  assert.equal(payload.clearCheckAfter, true, 'the completed one-shot check is no longer due');
  assert.match(payload.message, /status left as blocked/);
});

test('a same-status check-in that clears or reschedules is not overwritten by finalization', () => {
  const start = card({ status: 'waiting', updated: '2026-09-11T12:00' });
  for (const checkAfter of ['', '2026-09-12T09:00']) {
    const now = structuredClone(start);
    now.fm.check_after = checkAfter;
    now.body = `${start.body}\n\n## 2026-09-11 12:00 — check-in → waiting\nChecked; ${checkAfter ? 'rescheduled.' : 'schedule cleared.'}`;
    const payload = finalizePayload(completedCheck(start), now);
    assert.equal('status' in payload, false, checkAfter || 'cleared');
    assert.equal('clearCheckAfter' in payload, false, checkAfter || 'cleared');
  }
});

test('a same-minute reaffirmed status is visible through the card body fingerprint', () => {
  const start = card({ status: 'waiting', updated: '2026-09-11T12:00' });
  const now = structuredClone(start);
  now.body = `${start.body}\n\n## 2026-09-11 12:00 — check-in → waiting\nStill waiting; keep this schedule.`;
  const payload = finalizePayload(completedCheck(start), now);
  assert.equal('status' in payload, false);
  assert.equal('clearCheckAfter' in payload, false);
});

test('a pending retry cannot apply state or schedule from before a newer card action', () => {
  const queuedAgainst = card({ status: 'waiting', updated: '2026-09-11T12:00' });
  const payload = finalizePayload(completedCheck(queuedAgainst), queuedAgainst);
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

test('direct finalization reloads a concurrent check-in inside the registry lock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-runs-finalize-'));
  try {
    fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks', 'blocked-check.md'), [
      '---',
      'title: Blocked scheduled check',
      'status: blocked',
      'kind: task',
      'tags: [personal]',
      'check_after: 2026-09-11T12:00',
      'check: |',
      '  Inspect npm publishing state.',
      'needs:',
      '  - text: Complete npm MFA',
      '    at: 2026-09-11T12:00',
      '    was: active',
      'created: 2026-09-11T11:00',
      'updated: 2026-09-11T12:00',
      '---',
      '',
      'Initial context.',
      '',
    ].join('\n'));
    const script = `
      const keep = require(${JSON.stringify(require.resolve('./keep.js'))});
      const runs = require(${JSON.stringify(require.resolve('./runs.js'))});
      const start = keep.loadTask('blocked-check');
      const run = {
        taskId: 'blocked-check', kind: 'check', startStatus: start.fm.status,
        startCardFingerprint: runs.cardFingerprint(start), status: 'done',
        startedAt: 0, endedAt: 60000,
        resultText: 'Still waiting on npm MFA.', diffStat: '', exitCode: 0,
      };
      let boundaryMutation = false;
      const deps = {
        ...keep,
        withLock(fn) {
          if (!boundaryMutation) {
            boundaryMutation = true;
            keep.checkinTask('blocked-check', {
              message: 'Still waiting on npm MFA; schedule cleared.', status: 'blocked',
              clearCheckAfter: true, commit: false,
            });
          }
          return keep.withLock(fn);
        },
        checkinTask(id, checkin) { return keep.checkinTask(id, { ...checkin, commit: false }); },
      };
      const outcome = runs.landFinalCheckin(run, 0, deps);
      if (outcome.error) throw outcome.error;
      const landed = keep.loadTask('blocked-check');
      process.stdout.write(JSON.stringify({
        status: landed.fm.status, checkAfter: landed.fm.check_after || '',
        needs: landed.fm.needs, payloadStatus: outcome.payload.status,
        payloadClear: outcome.payload.clearCheckAfter,
      }));
    `;
    const output = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' },
    });
    const landed = JSON.parse(output);
    assert.equal(landed.status, 'blocked');
    assert.equal(landed.checkAfter, '');
    assert.equal(landed.needs.length, 1);
    assert.equal(landed.payloadStatus, undefined);
    assert.equal(landed.payloadClear, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a lock timeout retains a guarded payload for durable retry', () => {
  const start = card();
  const run = completedCheck(start);
  const timeout = new Error('could not acquire lock');
  const outcome = landFinalCheckin(run, 0, {
    loadTask: () => start,
    withLock: () => { throw timeout; },
    checkinTask: () => { throw new Error('must not run without the lock'); },
  });
  assert.equal(outcome.error, timeout);
  assert.equal(outcome.payload.status, 'review');
  assert.equal(outcome.payload.clearCheckAfter, true);
  assert.equal(outcome.payload._retryCardFingerprint, cardFingerprint(start));
});

test('a locked card load failure is surfaced and queues no blind mutations', () => {
  const start = card();
  const loadFailure = new Error('card is temporarily unreadable');
  const outcome = landFinalCheckin(completedCheck(start), 0, {
    loadTask: () => { throw loadFailure; },
    withLock: (fn) => fn(),
    checkinTask: () => { throw new Error('must not write without a snapshot'); },
  });
  assert.equal(outcome.error, loadFailure);
  assert.equal('status' in outcome.payload, false);
  assert.equal('clearCheckAfter' in outcome.payload, false);
  assert.equal('_retryCardFingerprint' in outcome.payload, false);
});

// ---------- structured verdicts ----------

test('the verdict is read from the last VERDICT line, in any case', () => {
  assert.equal(parseVerdict('VERDICT: PASS — every gate held'), 'pass');
  assert.equal(parseVerdict('verdict: passed'), 'pass');
  assert.equal(parseVerdict('VERDICT: ok, nothing to do'), 'pass');
  assert.equal(parseVerdict('VERDICT: FAIL — seed 3 timed out'), 'fail');
  assert.equal(parseVerdict('VERDICT: failed'), 'fail');
  assert.equal(parseVerdict('VERDICT: UNSURE — needs the original thread'), 'unsure');
  assert.equal(parseVerdict('VERDICT: PASS\nVERDICT: FAIL — correction'), 'fail', 'the last one wins');
  assert.equal(parseVerdict('I would call this a pass.'), null);
  assert.equal(parseVerdict('VERDICT: probably fine'), null, 'an invented word is not a verdict');
  assert.equal(parseVerdict(''), null);
});

const verdictRun = (start, resultText) => ({ ...completedCheck(start), resultText });

test('a passing check does what the card declared a pass means', () => {
  const closing = card({ check_on_pass: 'done' });
  const closed = finalizePayload(verdictRun(closing, 'Recorder healthy.\nVERDICT: PASS — nothing left'), closing);
  assert.equal(closed.status, 'done');
  assert.equal(closed.clearCheckAfter, true);
  assert.equal('checkAfter' in closed, false);
  assert.match(closed.message, /\(VERDICT pass; closed as declared by on-pass: done\)/);

  const recurring = card({ check_on_pass: 'rearm', check_every: '+7d' });
  const rearmed = finalizePayload(verdictRun(recurring, 'All green.\nVERDICT: PASS — healthy'), recurring);
  assert.equal(rearmed.status, 'waiting');
  // A relative interval, so checkinTask re-arms from now: re-arming from the old date
  // would fire a week of catch-up checks after a daemon outage.
  assert.equal(rearmed.checkAfter, '+7d');
  assert.equal(rearmed.clearCheckAfter, false);
  assert.match(rearmed.message, /\(VERDICT pass; re-armed every \+7d\)/);

  for (const declared of [card({ check_on_pass: 'review' }), card()]) {
    const reviewed = finalizePayload(verdictRun(declared, 'Looks fine.\nVERDICT: PASS'), declared);
    assert.equal(reviewed.status, 'review');
    assert.equal(reviewed.clearCheckAfter, true);
    assert.equal('checkAfter' in reviewed, false);
    assert.match(reviewed.message, /\(VERDICT pass\)$/);
  }
});

test('a rearm card with no usable interval falls back to review rather than vanishing', () => {
  for (const fm of [{ check_on_pass: 'rearm' }, { check_on_pass: 'rearm', check_every: 'next tuesday' }]) {
    const broken = card(fm);
    const payload = finalizePayload(verdictRun(broken, 'Green.\nVERDICT: PASS'), broken);
    assert.equal(payload.status, 'review');
    assert.equal(payload.clearCheckAfter, true);
    assert.equal('checkAfter' in payload, false);
    assert.match(payload.message, /on-pass is rearm but check_every/);
  }
});

test('fail, unsure and a missing verdict all keep today behaviour on every card', () => {
  for (const onPass of [{}, { check_on_pass: 'done' }, { check_on_pass: 'rearm', check_every: '+7d' }]) {
    const task = card(onPass);
    const cases = [
      ['Seed 3 timed out.\nVERDICT: FAIL — not safe to ramp', /\(VERDICT fail\)/],
      ['Could not reach staging.\nVERDICT: UNSURE — no access', /\(VERDICT unsure\)/],
      ['I ran the recipe and it seemed fine.', /\(no VERDICT line; treated as unsure\)/],
    ];
    for (const [resultText, note] of cases) {
      const payload = finalizePayload(verdictRun(task, resultText), task);
      assert.equal(payload.status, 'review', resultText);
      assert.equal(payload.clearCheckAfter, true, resultText);
      assert.equal('checkAfter' in payload, false, 'a card is never re-armed on anything but a pass');
      assert.match(payload.message, note);
    }
  }
});

test('a card that moved under a re-arming check keeps its own schedule', () => {
  const start = card({ check_on_pass: 'rearm', check_every: '+7d' });
  const now = structuredClone(start);
  now.body = `${start.body}\n\n## 2026-09-11 12:00 — check-in → waiting\nRescheduled by hand.`;
  const payload = finalizePayload(verdictRun(start, 'Green.\nVERDICT: PASS'), now);
  assert.equal('status' in payload, false);
  assert.equal('clearCheckAfter' in payload, false);
  assert.equal('checkAfter' in payload, false, 'a preserved schedule is not re-armed either');

  const stale = pendingCheckin(
    finalizePayload(verdictRun(start, 'Green.\nVERDICT: PASS'), start),
    now,
  );
  assert.equal(stale.stale, true);
  assert.equal('checkAfter' in stale.checkin, false, 'a queued re-arm cannot apply after a newer action');
  assert.match(stale.checkin.message, /card changed after this result was queued/);
});

test('a check prompt states the verdict contract and what a pass does to this card', () => {
  const legacy = buildPrompt(card(), 'check');
  assert.match(legacy, /VERDICT: PASS\|FAIL\|UNSURE/);
  assert.match(legacy, /do NOT run `keep checkin`/, 'the daemon lands the result, not the run');
  assert.match(legacy, /PASS means every gate in the recipe held/);
  assert.match(legacy, /a PASS will send it to Owner review/);

  assert.match(buildPrompt(card({ check_on_pass: 'done' }), 'check'), /a PASS will close the card/);
  const recurring = buildPrompt(card({ check_on_pass: 'rearm', check_every: '+7d' }), 'check');
  assert.match(recurring, /a PASS will keep it waiting and re-arm the check for \+7d/);
  // A rearm the finalizer cannot honour must not promise the run a re-arm either.
  assert.match(buildPrompt(card({ check_on_pass: 'rearm' }), 'check'), /a PASS will send it to Owner review/);
});

test('an escalated check is told what the probe already saw', () => {
  const prompt = buildPrompt(card(), 'check', undefined, {
    probe: { code: 3, ms: 412, output: 'recorder: 2 segments missing', timedOut: false },
  });
  assert.match(prompt, /probe for this card just failed \(exit 3, 412 ms\)/);
  assert.match(prompt, /recorder: 2 segments missing/);
  assert.match(prompt, /the recipe below is the fuller check/);
  assert.match(prompt, /Diagnose why[\s\S]*Execute this check recipe now/, 'the probe context comes before the recipe');
  assert.match(
    buildPrompt(card(), 'check', undefined, { probe: { code: 124, ms: 120000, output: '', timedOut: true } }),
    /exit 124, timed out, 120000 ms[\s\S]*Its output tail: \(no output\)/,
  );
  assert.doesNotMatch(buildPrompt(card(), 'check'), /deterministic probe/);
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

test('a transient start refusal is either cap: per-task or global', () => {
  assert.equal(isTransientStartError(new Error('a run is already active for some-card')), true);
  assert.equal(isTransientStartError(new Error('already 3 runs active')), true);
  assert.equal(isTransientStartError(new Error('project dir ~/castle/ghost does not exist')), false);
  assert.equal(isTransientStartError(new Error('claude binary not found (set KEEP_CLAUDE)')), false);
});

test('a per-task run collision does not burn the day escalation budget', () => {
  _resetSchedulerState();
  try {
    const task = probeCard({ check: 'diagnose the recorder' });
    const result = { ok: false, code: 3, ms: 120, output: '2 segments missing', timedOut: false };
    const started = [];
    const collide = () => { throw new Error(`a run is already active for ${task.id}`); };
    const record = (...args) => { started.push(args); };

    // The card's own earlier run is still finishing: transient, so tomorrow is not the
    // next chance — this is what the 'runs active' substring test got wrong.
    assert.match(String(escalateProbeFailure(task, result, { today: '2026-09-11', start: collide })), /already active/);
    assert.equal(started.length, 0);

    assert.equal(escalateProbeFailure(task, result, { today: '2026-09-11', start: record }), null);
    assert.equal(started.length, 1, 'a later failed probe on the same day still escalates');
    assert.equal(started[0][1], 'check');
    assert.deepEqual(started[0][3].probe, result, 'the run is told what the probe saw');

    // One headless attempt per card per day, once one actually started.
    assert.equal(escalateProbeFailure(task, result, { today: '2026-09-11', start: record }), null);
    assert.equal(started.length, 1);
    assert.equal(escalateProbeFailure(task, result, { today: '2026-09-12', start: record }), null);
    assert.equal(started.length, 2, 'tomorrow is a fresh attempt');

    // A real failure is not transient: it costs the day.
    _resetSchedulerState();
    const broken = () => { throw new Error('project dir /gone does not exist'); };
    assert.match(String(escalateProbeFailure(task, result, { today: '2026-09-11', start: broken })), /does not exist/);
    assert.equal(escalateProbeFailure(task, result, { today: '2026-09-11', start: record }), null);
    assert.equal(started.length, 2, 'no retry after a permanent failure until tomorrow');
  } finally { _resetSchedulerState(); }
});
