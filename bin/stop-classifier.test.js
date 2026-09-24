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
  assert.deepEqual(classifier.parse('**WAITING_ON_YOU** — asks which model to use.'), { verdict: 'needs-input', reason: 'asks which model to use' });
  assert.equal(classifier.parse('I think it is running'), null);
  assert.equal(classifier.parse(''), null);
});

test('only a finished turn in a live agent conversation with nothing pending is classified', () => {
  assert.equal(classifier.eligible(base), true);
  for (const change of [{ endedTurn: false }, { endedTurn: undefined }, { toolRunning: true }, { pendingQuestion: { question: 'x' } },
    { pendingPlan: true }, { reviewer: true }, { agentName: 'sandboxes' }, { exited: true }, { kind: 'pi' },
    { lastAssistantFull: '  ' }, { runtime: { state: 'exited' } }, { runtime: { state: 'external' } }]) {
    assert.equal(classifier.eligible({ ...base, ...change }), false, JSON.stringify(change));
  }
  assert.equal(classifier.eligible({ ...base, runtime: { state: 'live' } }), true);
});

test('the input is the last message plus whether tracked background work is still running', () => {
  assert.match(classifier.input(base), /^Background work Keep tracks for this session: none running\nLast assistant message:\nThe Codex review/);
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

test('a WAITING_ON_YOU verdict beats a tracked job wait and carries its reason to the row', () => {
  const session = { ...base, pendingBackground: true, lastAssistantFull: 'The review is running. Separately: should Transfer follow the new default' };
  assert.equal(activity(session).state, 'waiting', 'the rules alone read the running job');
  const asks = { ...session, stopVerdict: { verdict: 'needs-input', reason: 'asks whether Transfer follows default' } };
  assert.equal(activity(asks).state, 'needs-input');
  assert.equal(attention(asks).detail, 'asks whether Transfer follows default');
  assert.equal(attention(asks).attentionLabel, 'Ready for next instruction');
});

test('a question keeps the agent\'s own words as the detail a push shows', () => {
  const text = 'Tests pass. Should I deploy to prod now, or wait for the migration?';
  const session = { ...base, lastAssistantFull: text, stopVerdict: { verdict: 'needs-input', reason: 'asks whether to deploy now' } };
  assert.equal(attention(session).detail, text);
  assert.equal(attention(session).attentionLabel, 'Needs an answer');
});

test('a WAITING_ON_YOU verdict does not pull a session out of a scheduled check or dependency wait', () => {
  const needs = { verdict: 'needs-input', reason: 'finished, nothing running' };
  const session = { ...base, lastAssistantFull: 'Waiting for the scheduled check at 3pm.', stopVerdict: needs };
  const checked = activity(session, { task: { check_after: '2026-09-25T15:00' } });
  assert.equal(checked.state, 'waiting');
  assert.equal(activity(session, { dependencies: ['upstream'] }).state, 'waiting');
});

test('a far-off card check does not stop the verdict overriding a stale job wait', () => {
  const session = { ...base, pendingBackground: true, lastAssistantFull: 'Deployed and verified; everything is green.',
    stopVerdict: { verdict: 'needs-input', reason: 'deploy finished and verified' } };
  assert.equal(activity(session, { task: { check_after: '2026-10-01T00:00' } }).state, 'needs-input');
});

test('a card\'s open needs keep their own text over a WAITING_ON_YOU verdict', () => {
  const session = { ...base, lastAssistantFull: 'Migration done.', stopVerdict: { verdict: 'needs-input', reason: 'migration finished' } };
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
  summarize.cache.set(`stop-s1|claude-sonnet-5|${classifier.input(base)}`, { text: 'WAITING_ON_YOU: done, reports results', generatedAt: 7 });
  const sessions = [{ ...base }, { ...base, id: 'other', endedTurn: false, stopVerdict: { verdict: 'running' } }];
  classifier.attach(sessions, { summarize, env: {}, now: () => 10e6 });
  assert.deepEqual(sessions[0].stopVerdict, { verdict: 'needs-input', reason: 'done, reports results', model: 'claude-sonnet-5', at: 7 });
  assert.equal(Object.hasOwn(sessions[1], 'stopVerdict'), false);
  assert.equal(summarize.queued.length, 0);
});
