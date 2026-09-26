const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const classifier = require('./stop-classifier');
const { activity, attention } = require('./session-status');

const base = { id: 's1', kind: 'claude', pane: 'p1', endedTurn: true, attentionAt: 1000,
  lastAssistantFull: 'The Codex review is running; I will land once it comes back.' };

// A summarize stand-in: a verdict cache keyed by (key, model, input), and a queue.
function fakeSummarize() {
  const cache = new Map();
  const queued = [];
  return {
    cache, queued,
    cachedSummary: (key, input, instruction, options) => cache.get(`${key}|${options.model}|${input}`) || null,
    peekSummary: (key) => [...cache.entries()].find(([k]) => k.startsWith(`${key}|`))?.[1] || null,
    getSummary: (key, input, instruction, onDone, options) => { queued.push({ key, input, onDone, options }); return { text: null, fresh: false }; },
    answer(job, text) { cache.set(`${job.key}|${job.options.model}|${job.input}`, { text, generatedAt: 5 }); job.onDone(); },
  };
}

test('parse reads the verdict line and a short reason, and rejects anything else', () => {
  assert.deepEqual(classifier.parse('RUNNING: waiting on Codex review'), { verdict: 'running', reason: 'waiting on Codex review' });
  assert.deepEqual(classifier.parse('**ASKS** — which model to use.'), { verdict: 'asks', reason: 'which model to use' });
  assert.deepEqual(classifier.parse('DONE: reported the results'), { verdict: 'done', reason: 'reported the results' });
  assert.equal(classifier.parse('WAITING_ON_YOU: an old answer'), null, 'the old two-way answer is not read');
  assert.equal(classifier.parse('I think it is running'), null);
  assert.equal(classifier.parse(''), null);
});

test('only a finished turn with nothing pending is classified, in a live pane or one Keep no longer sees', () => {
  assert.equal(classifier.eligible(base), true);
  for (const change of [{ endedTurn: false }, { endedTurn: undefined }, { toolRunning: true }, { pendingQuestion: { question: 'x' } },
    { pendingPlan: true }, { reviewer: true }, { agentName: 'sandboxes' }, { exited: true }, { kind: 'pi' },
    { lastAssistantFull: '  ' }, { runtime: { state: 'exited' } }, { runtime: { state: 'missing' } }]) {
    assert.equal(classifier.eligible({ ...base, ...change }), false, JSON.stringify(change));
  }
  assert.equal(classifier.eligible({ ...base, runtime: { state: 'live' } }), true);
  // A conversation Keep sees no pane for counts only as its open card's current session.
  for (const state of ['unknown', 'external']) {
    assert.equal(classifier.eligible({ ...base, runtime: { state } }), false, state);
    assert.equal(classifier.eligible({ ...base, runtime: { state }, taskStatus: 'waiting' }), false, `${state}: not the card's current session`);
    assert.equal(classifier.eligible({ ...base, runtime: { state }, taskStatus: 'active', cardLatest: true }), true, state);
    assert.equal(classifier.eligible({ ...base, runtime: { state }, taskStatus: 'done', cardLatest: true }), false, `${state}: done card`);
  }
});

test('the input is the last message plus whether tracked background work is still running', () => {
  assert.match(classifier.input(base), /^Background work Keep tracks for this session: none running\nScheduled check on its card: none\nLast assistant message:\nThe Codex review/);
  assert.match(classifier.input({ ...base, cardCheck: { at: '2026-09-25T20:00', overdue: false } }), /Scheduled check on its card: at 2026-09-25T20:00\n/);
  assert.match(classifier.input({ ...base, cardCheck: { at: '2026-09-24T17:28', overdue: true } }), /Scheduled check on its card: overdue since 2026-09-24T17:28, not delivered\n/);
  // A check appearing or going overdue changes the input, so the verdict is redone.
  assert.notEqual(classifier.input(base), classifier.input({ ...base, cardCheck: { at: '2026-09-25T20:00', overdue: false } }));
  assert.match(classifier.input({ ...base, pendingBackground: true }), /still running/);
  assert.match(classifier.input({ ...base, lifecycleAgents: [{ id: 'a' }] }), /still running/);
  assert.match(classifier.input({ ...base, backgroundJobs: { jobs: [{ status: 'pending', kind: 'scheduled' }] } }), /still running/);
  assert.match(classifier.input({ ...base, backgroundJobs: { jobs: [{ status: 'completed', kind: 'scheduled' }] } }), /none running/);
});

test('a missing verdict queues one on the configured model, logs it, and a changed input queues again', () => {
  const summarize = fakeSummarize();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-classifier-'));
  let changes = 0;
  const env = {};
  classifier.request([base], { summarize, root, env, onChange: () => { changes += 1; } });
  assert.equal(summarize.queued.length, 1);
  assert.equal(summarize.queued[0].options.model, 'claude-sonnet-5');
  assert.equal(summarize.queued[0].options.priority, 0);
  summarize.answer(summarize.queued[0], 'RUNNING: waiting on Codex review');
  assert.equal(changes, 1);
  const log = fs.readFileSync(path.join(root, '.keep', 'stop-verdicts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.length, 1);
  assert.equal(log[0].verdict, 'running');
  assert.equal(log[0].model, 'claude-sonnet-5');
  assert.equal(log[0].input, classifier.input(base));

  classifier.request([base], { summarize, root, env });
  assert.equal(summarize.queued.length, 1, 'a cached verdict for the same message is not requested again');
  // Tracked background work changing state changes the input, so the verdict is redone.
  classifier.request([{ ...base, lifecycleAgents: [{ id: 'a' }] }], { summarize, root, env });
  assert.equal(summarize.queued.length, 2);

  classifier.request([base], { summarize, root, env: { KEEP_STOP_MODEL: 'claude-haiku-4-5-20251001' } });
  assert.equal(summarize.queued.at(-1).options.model, 'claude-haiku-4-5-20251001');
  classifier.request([{ ...base, id: 'paneless', runtime: { state: 'unknown' }, taskStatus: 'waiting', cardLatest: true }], { summarize, root, env });
  assert.equal(summarize.queued.at(-1).options.priority, 1, 'a paneless conversation queues behind live ones');
  classifier.request([{ ...base, id: 's2' }], { summarize, root, env: { KEEP_STOP_CLASSIFIER: '0' } });
  assert.equal(summarize.queued.filter((job) => job.key === 'stop-s2').length, 0, 'KEEP_STOP_CLASSIFIER=0 turns it off');
});

test('a fresh turn end holds in Running & waiting while its verdict is pending, then falls back to the rules', () => {
  const summarize = fakeSummarize();
  const held = classifier.verdictFor(base, { summarize, env: {}, now: () => 1000 + 30e3 });
  assert.equal(held.verdict, 'pending');
  const session = { ...base, stopVerdict: held };
  assert.equal(activity(session).state, 'waiting');
  assert.equal(activity(session).label, 'Waiting: classifying');
  assert.equal(attention(session), null);
  assert.equal(classifier.verdictFor(base, { summarize, env: {}, now: () => 1000 + classifier.HOLD_MS + 1 }), null,
    'no verdict after the hold: the rules decide');
});

test('a RUNNING verdict moves a finished turn out of Waiting on you', () => {
  const session = { ...base, lastAssistantFull: 'Review is running. Anything else you want in this change?' };
  assert.equal(activity(session).state, 'needs-input', 'the rules alone read the trailing question');
  const running = { ...session, stopVerdict: { verdict: 'running', reason: 'waiting on Codex review', model: 'claude-sonnet-5' } };
  assert.equal(activity(running).state, 'waiting');
  assert.equal(activity(running).label, 'Waiting: waiting on Codex review');
  assert.equal(activity(running).decision.rule, 'model-running');
  assert.equal(attention(running), null);
});

test('an ASKS verdict beats a tracked job wait or poll, with the agent\'s words as the detail', () => {
  const text = 'None of the four records resolve yet. Here they are again for the castle.xyz zone. I\'m watching the certificate in the background';
  const session = { ...base, pendingBackground: true, lastAssistantFull: text };
  assert.equal(activity(session).state, 'waiting', 'the rules alone read the running poll');
  const asks = { ...session, stopVerdict: { verdict: 'asks', reason: 'add the DNS validation records' } };
  assert.equal(activity(asks).state, 'needs-input');
  assert.equal(activity(asks).decision.rule, 'model-asks');
  assert.equal(attention(asks).detail, text);
  assert.equal(attention(asks).attentionLabel, 'Needs an answer');
  // A DONE verdict also beats a stale job wait, labelled as ready.
  const done = { ...session, stopVerdict: { verdict: 'done', reason: 'reported the deploy' } };
  assert.equal(attention(done).detail, 'reported the deploy');
  assert.equal(attention(done).attentionLabel, 'Ready for next instruction');
});

test('an ASKS verdict counts for the card\'s current session whose pane is gone; RUNNING and DONE do not', () => {
  const gone = { ...base, pane: undefined, runtime: { state: 'unknown' }, taskStatus: 'waiting', lastAssistantFull: 'Decision for you: do you want to start building the usage UI? Reply on the card to start it.' };
  const card = { task: { status: 'waiting', check_after: '2030-01-01T00:00', sessions: [{ id: 'older' }, { id: 's1' }] } };
  const older = { task: { ...card.task, sessions: [{ id: 's1' }, { id: 'newer' }] } };
  assert.equal(activity({ ...gone, stopVerdict: { verdict: 'asks', reason: 'x' } }, older).decision.rule, 'scheduled-check',
    'an older conversation on the card does not resurface its ask');
  assert.equal(activity(gone, card).decision.rule, 'scheduled-check', 'without a verdict the card schedule holds it');
  assert.equal(activity({ ...gone, stopVerdict: { verdict: 'asks', reason: 'start the usage UI?' } }, card).decision.rule, 'model-asks');
  assert.equal(activity({ ...gone, stopVerdict: { verdict: 'done', reason: 'reported' } }, card).decision.rule, 'scheduled-check');
  assert.equal(activity({ ...gone, stopVerdict: { verdict: 'running', reason: 'x' } }, card).decision.rule, 'scheduled-check');
  // On an ordinary active card the ask still counts rather than reading as idle.
  assert.equal(activity({ ...gone, taskStatus: 'active', stopVerdict: { verdict: 'asks', reason: 'pick a schema path' } },
    { task: { status: 'active', sessions: [{ id: 's1' }] } }).decision.rule, 'model-asks');
});

test('a card check overdue past its grace stops holding the session as waiting', () => {
  const at = Date.parse('2026-09-24T17:28');
  const card = { task: { status: 'waiting', check_after: '2026-09-24T17:28', sessions: [{ id: 's1' }] } };
  const gone = { ...base, pane: undefined, runtime: { state: 'unknown' }, lastAssistantFull: 'Recorded the check results on the card.' };
  assert.equal(activity(gone, { ...card, now: at + 20 * 60e3, checkInFlight: true }).decision.rule, 'scheduled-check',
    'a delivered check still being answered is not overdue');
  const other = { task: { ...card.task, sessions: [{ id: 's1' }, { id: 'newer' }] }, now: at + 20 * 60e3 };
  assert.notEqual(activity(gone, other).decision.rule, 'check-overdue', 'only the card\'s current session reports it');
  // The session that scheduled the check owns the alert, not also the latest one.
  const scheduled = { task: { ...card.task, scheduled_by: 'older', sessions: [{ id: 'older' }, { id: 's1' }] }, now: at + 20 * 60e3 };
  assert.notEqual(activity(gone, scheduled).decision.rule, 'check-overdue');
  assert.equal(activity({ ...gone, id: 'older' }, scheduled).decision.rule, 'check-overdue');
  // A scheduler Keep no longer lists hands the alert to the latest session.
  const pruned = { task: { ...card.task, scheduled_by: 'gone-session', sessions: [{ id: 's1' }] }, now: at + 20 * 60e3 };
  assert.equal(activity(gone, pruned).decision.rule, 'check-overdue');
  assert.equal(activity(gone, { ...scheduled, checkOwnerId: 's1' }).decision.rule, 'check-overdue', 'serve.js names the listed owner');
  assert.equal(activity(gone, { ...card, now: at + 10 * 60e3 }).decision.rule, 'scheduled-check', 'inside the grace it still waits');
  const overdue = activity(gone, { ...card, now: at + 20 * 60e3 });
  assert.equal(overdue.decision.rule, 'check-overdue');
  assert.equal(overdue.state, 'needs-input');
  assert.match(overdue.request.detail, /due 2026-09-24 17:28\) was not delivered/);
  // A live session that scheduled it is ready once the check is overdue.
  const live = { ...base, taskId: 't', lastAssistantFull: 'Scheduled a recovery check in 15 minutes.' };
  assert.equal(activity(live, { ...card, now: at + 20 * 60e3 }).state, 'needs-input');
  assert.equal(activity(live, { task: { ...card.task, status: 'done' }, now: at + 20 * 60e3 }).decision.rule !== 'check-overdue', true);
  // A decision handoff the session scheduled stands after the check goes overdue.
  const handoff = { ...live, turnStartedAt: at - 60e3, lastUserAt: at - 60e3 };
  const decided = { task: { ...card.task, check: 'read it', scheduled_by: 's1', scheduled_at: new Date(at - 30e3).toISOString(),
    scheduled_for: '2026-09-24T17:28', scheduled_intent: 'needs-input' }, now: at + 20 * 60e3 };
  assert.equal(activity(handoff, decided).decision.rule, 'handoff-input');
});

test('a done card\'s leftover check never holds the session', () => {
  const session = { ...base, lastAssistantFull: 'Waiting for the scheduled check.', stopVerdict: { verdict: 'done', reason: 'finished' } };
  assert.equal(activity(session, { task: { status: 'done', check_after: '2030-01-01T00:00' } }).state, 'needs-input');
});

test('a question keeps the agent\'s own words as the detail a push shows', () => {
  const text = 'Tests pass. Should I deploy to prod now, or wait for the migration?';
  const session = { ...base, lastAssistantFull: text, stopVerdict: { verdict: 'asks', reason: 'asks whether to deploy now' } };
  assert.equal(attention(session).detail, text);
  assert.equal(attention(session).attentionLabel, 'Needs an answer');
});

test('a DONE verdict does not pull a session out of a scheduled check or dependency wait', () => {
  const needs = { verdict: 'done', reason: 'finished, nothing running' };
  const session = { ...base, lastAssistantFull: 'Waiting for the scheduled check at 3pm.', stopVerdict: needs };
  const checked = activity(session, { task: { check_after: '2030-09-25T15:00' } });
  assert.equal(checked.state, 'waiting');
  assert.equal(activity(session, { dependencies: ['upstream'] }).state, 'waiting');
});

test('a far-off card check does not stop the verdict overriding a stale job wait', () => {
  const session = { ...base, pendingBackground: true, lastAssistantFull: 'Deployed and verified; everything is green.',
    stopVerdict: { verdict: 'done', reason: 'deploy finished and verified' } };
  assert.equal(activity(session, { task: { check_after: '2030-10-01T00:00' } }).state, 'needs-input');
});

test('a card\'s open needs keep their own text over a DONE verdict', () => {
  const session = { ...base, lastAssistantFull: 'Migration done.', stopVerdict: { verdict: 'done', reason: 'migration finished' } };
  const status = activity(session, { task: { status: 'active', needs: [{ text: 'Approve prod cutover window' }] } });
  assert.equal(status.decision.rule, 'task-needs');
  assert.equal(status.request.detail, 'Approve prod cutover window');
});

test('a RUNNING verdict does not hide the card\'s own review or needs', () => {
  const running = { verdict: 'running', reason: 'handed to reviewer' };
  assert.equal(activity({ ...base, stopVerdict: running }, { task: { status: 'review' } }).state, 'needs-input');
  assert.equal(activity({ ...base, stopVerdict: running }, { task: { status: 'active', needs: [{ text: 'API key' }] } }).state, 'needs-input');
});

test('explicit signals still outrank the verdict', () => {
  const running = { verdict: 'running', reason: 'waiting on review' };
  assert.equal(activity({ ...base, pendingQuestion: { question: 'Pick one' }, stopVerdict: running }).state, 'needs-input');
  assert.equal(activity({ ...base, notify: { type: 'permission' }, stopVerdict: running }).reason, 'permission');
  assert.equal(activity({ ...base, endedTurn: false, stopVerdict: running }).state, 'running');
  // A hook-declared needs-input stop is the agent's own statement.
  const hooked = { ...base, lifecycleStop: { intent: 'needs-input', at: 2000 }, stopVerdict: running };
  assert.equal(activity(hooked).state, 'needs-input');
});

test('attach sets and clears the verdict from the cache only', () => {
  const summarize = fakeSummarize();
  summarize.cache.set(`stop-s1|claude-sonnet-5|${classifier.input(base)}`, { text: 'DONE: reports results', generatedAt: 7 });
  const sessions = [{ ...base }, { ...base, id: 'other', endedTurn: false, stopVerdict: { verdict: 'running' } }];
  classifier.attach(sessions, { summarize, env: {}, now: () => 10e6 });
  assert.deepEqual(sessions[0].stopVerdict, { verdict: 'done', reason: 'reports results', model: 'claude-sonnet-5', at: 7 });
  assert.equal(Object.hasOwn(sessions[1], 'stopVerdict'), false);
  assert.equal(summarize.queued.length, 0);
});

test('the prompt reads an unstarted plan as ASKS and a promise with nothing scheduled as not RUNNING', () => {
  assert.match(classifier.INSTRUCTION, /proposing its own next work that it has not started/);
  assert.match(classifier.INSTRUCTION, /Conditional or retrospective advice in a finished report/);
  assert.match(classifier.INSTRUCTION, /RUNNING only when something will wake the agent/);
  assert.match(classifier.INSTRUCTION, /while the scheduled check line says none is not RUNNING/);
});

test('cardCheck is null for no check or a done card, and overdue past its grace unless in flight', () => {
  const { cardCheck } = require('./session-model');
  const at = Date.parse('2026-09-24T17:28');
  assert.equal(cardCheck(null), null);
  assert.equal(cardCheck({ status: 'active' }), null);
  assert.equal(cardCheck({ status: 'done', check_after: '2026-09-24T17:28' }, { now: at + 3600e3 }), null);
  assert.deepEqual(cardCheck({ status: 'waiting', check_after: '2026-09-24T17:28' }, { now: at + 10 * 60e3 }), { at: '2026-09-24T17:28', overdue: false });
  assert.equal(cardCheck({ status: 'waiting', check_after: '2026-09-24T17:28' }, { now: at + 20 * 60e3 }).overdue, true);
  assert.equal(cardCheck({ status: 'waiting', check_after: '2026-09-24T17:28' }, { now: at + 20 * 60e3, inFlight: true }).overdue, false);
});

test('a RUNNING verdict falls to the rules only when a trusted footer, the processes and the ledger all show nothing', () => {
  const text = 'The gateway is rolling. I\'ll confirm the roll completed on the next check.';
  const footer = { recognized: true, shells: 0, agents: 0, turnRunning: false, running: false };
  const idle = { ...base, lastAssistantFull: text, stopVerdict: { verdict: 'running', reason: 'waiting on gateway roll' },
    footer, footerTrusted: true, agentShells: 0, backgroundJobs: { caughtUp: true, pending: false, jobs: [] } };
  assert.equal(activity(idle).decision.rule, 'conversation-ready');
  for (const [what, change, context] of [
    ['the footer shows an agent', { footer: { ...footer, agents: 1, running: true } }],
    ['the footer shows a shell', { footer: { ...footer, shells: 1, running: true } }],
    ['a background shell process', { agentShells: 1 }],
    ['a pending ledger job', { backgroundJobs: { caughtUp: true, jobs: [{ id: 'c1', kind: 'scheduled', status: 'pending' }] } }],
    ['an uncertain job', { unknownBackgroundJobs: ['b9slnffu0'] }],
    ['unread history', { unknownBackgroundJobs: ['history-gap'] }],
    ['a subagent hook', { lifecycleAgents: [{ id: 'a1' }] }],
    ['an untrusted footer', { footerTrusted: false }],
    ['no footer', { footer: undefined }],
    ['an unrecognized footer', { footer: { recognized: false } }],
    ['a ledger not caught up', { backgroundJobs: { caughtUp: undefined, jobs: [] } }],
    ['no ledger', { backgroundJobs: undefined }],
    ['a scheduled card check', {}, { task: { status: 'waiting', check_after: '2030-01-01T00:00' } }],
  ]) {
    const status = activity({ ...idle, ...change }, context);
    assert.ok(status.decision.rule === 'model-running' || status.state === 'waiting', `${what}: ${status.decision.rule}`);
  }
  // An incomplete companion job list on this machine is not proof of nothing running.
  assert.equal(activity({ ...idle, companionComplete: false }).decision.rule, 'model-running');
  // A one-shot wakeup well past its time has fired; one still ahead keeps it running.
  const at = Date.parse('2026-09-25T20:00:00Z');
  const wakeup = (expiresAt) => ({ backgroundJobs: { caughtUp: true, jobs: [{ id: 'wakeup_t1', kind: 'scheduled', status: 'pending', recurring: false, expiresAt }] } });
  assert.equal(activity({ ...idle, ...wakeup(at + 60e3) }, { now: at }).decision.rule, 'model-running');
  assert.equal(activity({ ...idle, ...wakeup(at - 20 * 60e3) }, { now: at }).decision.rule, 'conversation-ready');
  // A long-running service is not something that wakes the session.
  assert.equal(activity({ ...idle, backgroundJobs: { caughtUp: true, jobs: [{ id: 's1', kind: 'service', status: 'pending' }] } }).decision.rule, 'conversation-ready');
});
