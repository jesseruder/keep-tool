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
  cardFingerprint, finalizePayload, pendingCheckin, NO_RESULT,
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

test('the blocked same-status result lands through real check-in validation', () => {
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
      keep.checkinTask('blocked-check', {
        message: 'Still waiting on npm MFA; schedule cleared.', status: 'blocked',
        clearCheckAfter: true, commit: false,
      });
      const now = keep.loadTask('blocked-check');
      const run = {
        taskId: 'blocked-check', kind: 'check', startStatus: start.fm.status,
        startCardFingerprint: runs.cardFingerprint(start), status: 'done',
        startedAt: 0, endedAt: 60000,
        resultText: 'Still waiting on npm MFA.', diffStat: '', exitCode: 0,
      };
      const payload = runs.finalizePayload(run, now);
      const prepared = runs.pendingCheckin(payload, now);
      keep.checkinTask(prepared.taskId, { ...prepared.checkin, commit: false });
      const landed = keep.loadTask('blocked-check');
      process.stdout.write(JSON.stringify({
        status: landed.fm.status, checkAfter: landed.fm.check_after || '',
        needs: landed.fm.needs, payloadStatus: payload.status,
        payloadClear: payload.clearCheckAfter,
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
