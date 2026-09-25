'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const jobs = require('./background-jobs');
const { activity } = require('./session-status');

test('bounded scheduler prioritizes live histories without starving cold ones', () => {
  const live = { sid: 'live', instance: { live: true } }, cold = { sid: 'cold' };
  assert.deepEqual(Array.from({ length: 8 }, (_, i) => jobs.nextTarget([live, cold], i).sid),
    ['live', 'live', 'live', 'live', 'live', 'live', 'live', 'cold']);
  assert.equal(jobs.nextTarget([], 0), undefined);
});

test('settled exited ledgers park, ignore unchanged registration, and wake on source or inbox change', () => {
  const scheduler = jobs.createScheduler({ fallbackMs: 10000, fallbackSlotTicks: 20 });
  const target = { agent: 'claude', sid: 'old', file: '/tmp/old.jsonl', sourceFingerprint: [1, 2, 3, 4, 5],
    instance: { id: 'pane:1:2', processScoped: true, live: false } };
  scheduler.register(target);
  const selected = scheduler.select(1000);
  assert.equal(selected.key, 'claude:old');
  const settled = { caughtUp: true, recovering: false, gap: false, pending: false, uncertain: [],
    unresolvedCalls: 0, unconsumedHooks: 0, jobs: [] };
  assert.equal(scheduler.observe(selected.key, target, settled, 1000), 'parked');
  assert.equal(scheduler.register({ ...target }), false, 'dashboard rebuild does not wake an unchanged target');
  assert.deepEqual(scheduler.stats(), { registered: 1, selected: 1, parked: 1, woken: 0, fallback: 0, active: 0 });
  assert.equal(scheduler.wakeInbox('claude/old/state.json'), false, 'the scheduler ignores its own snapshot writes');
  assert.equal(scheduler.wakeInbox('claude/old/inbox/event.json'), true);
  assert.equal(scheduler.stats().active, 1);
  scheduler.observe('claude:old', target, settled, 2000);
  assert.equal(scheduler.register({ ...target, sourceFingerprint: [1, 2, 4, 5, 6] }), true, 'source rewrite wakes the target');
  scheduler.observe('claude:old', { ...target, sourceFingerprint: [1, 2, 4, 5, 6] }, settled, 3000);
  assert.equal(scheduler.wakeFile('/tmp/old.jsonl'), 1);
});

test('parent exit never parks unresolved children, uncertain history, calls, hooks, or live instances', () => {
  const target = { agent: 'claude', sid: 'parent', file: '/tmp/parent.jsonl',
    instance: { id: 'pane:1:2', processScoped: true, live: false } };
  const base = { caughtUp: true, recovering: false, gap: false, pending: false, uncertain: [],
    unresolvedCalls: 0, unconsumedHooks: 0, jobs: [] };
  for (const result of [
    { ...base, jobs: [{ id: 'child', kind: 'agent', status: 'pending' }] },
    { ...base, uncertain: ['child'] },
    { ...base, gap: true },
    { ...base, recovering: true },
    { ...base, caughtUp: false },
    { ...base, unresolvedCalls: 1 },
    { ...base, unconsumedHooks: 1 },
  ]) assert.equal(jobs.settledResult(target, result), false);
  assert.equal(jobs.settledResult({ ...target, instance: { ...target.instance, live: true } }, base), false);
  assert.equal(jobs.settledResult(target, base), true);
});

test('parked ledgers receive a sparse fallback check without displacing active work every tick', () => {
  const scheduler = jobs.createScheduler({ fallbackMs: 1000, fallbackSlotTicks: 4 });
  const settled = { caughtUp: true, recovering: false, gap: false, pending: false, uncertain: [],
    unresolvedCalls: 0, unconsumedHooks: 0, jobs: [] };
  const old = { agent: 'claude', sid: 'old', file: '/tmp/old.jsonl', instance: { live: false } };
  const live = { agent: 'claude', sid: 'live', file: '/tmp/live.jsonl', instance: { live: true } };
  scheduler.register(old);
  let item = scheduler.select(1000); scheduler.observe(item.key, item.target, settled, 1000);
  scheduler.register(live);
  assert.equal(scheduler.select(5000).target.sid, 'live');
  assert.equal(scheduler.select(5000).target.sid, 'live');
  assert.equal(scheduler.select(5000).target.sid, 'old', 'reserved slot probes one due parked ledger');
});

function fixture(run, agent = 'claude') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-jobs-'));
  const file = path.join(root, 'session.jsonl'); fs.writeFileSync(file, '');
  let now = 100000;
  const append = (row) => { now += 1000; fs.appendFileSync(file, JSON.stringify({ timestamp: new Date(now).toISOString(), ...row }) + '\n'); };
  const sync = (options = {}) => jobs.sync({ root, file, sid: 'parent', agent, now, classify: () => 'finite', instance: 'pane:10', ...options });
  try { run({ root, file, append, sync, now: () => now }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const launch = (append, id = 'j', call = 'call') => {
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: call, name: 'Bash', input: { command: 'SECRET COMMAND', run_in_background: true } }] } });
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: call, content: `Command running in background with ID: ${id}. SECRET OUTPUT` }] } });
};
const done = (append, id = 'j', status = 'completed') => append({ type: 'user', message: { content: `<task-notification><task-id>${id}</task-id><status>${status}</status></task-notification>` } });

test('Claude task completion stays bound to its launch across asynchronous timestamp order', () => fixture(({ append, sync }) => {
  const toolUse = { type: 'assistant', timestamp: '2026-09-11T01:54:55.613Z', message: { content: [
    { type: 'tool_use', id: 'run-one', name: 'Bash', input: { command: 'SECRET', run_in_background: true } },
  ] } };
  const launched = { type: 'user', timestamp: '2026-09-11T01:54:55.789Z', message: { content: [
    { type: 'tool_result', tool_use_id: 'run-one', content: 'Command running in background with ID: task-one.' },
  ] } };
  const completed = '<task-notification><task-id>task-one</task-id><tool-use-id>run-one</tool-use-id><status>completed</status></task-notification>';

  append(toolUse);
  append({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-11T01:54:55.738Z', content: completed });
  append(launched);
  append({ type: 'attachment', timestamp: '2026-09-11T01:54:55.738Z', attachment: { type: 'queued_command', prompt: completed } });
  let result = sync();
  assert.equal(result.jobs.find(job => job.id === 'task-one').status, 'completed', 'early notification prevents its delayed launch result from reviving work');

  append({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'run-two', name: 'Bash', input: { command: 'SECRET', run_in_background: true } },
  ] } });
  append({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'run-two', content: 'Command running in background with ID: task-two.' },
  ] } });
  append({ type: 'attachment', timestamp: '2026-09-11T01:54:55.738Z', attachment: { type: 'queued_command', prompt:
    '<task-notification><task-id>task-two</task-id><tool-use-id>run-two</tool-use-id><status>completed</status></task-notification>' } });
  result = sync();
  assert.equal(result.jobs.find(job => job.id === 'task-two').status, 'completed', 'a physically later matching notification wins despite its older producer timestamp');
}));

test('a completion for a reused task ID preserves an unresolved different launch', () => fixture(({ append, sync }) => {
  launch(append, 'reused', 'old-run'); sync();
  append({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'new-run', name: 'Bash', input: { command: 'SECRET', run_in_background: true } },
  ] } });
  append({ type: 'user', message: { content:
    '<task-notification><task-id>reused</task-id><tool-use-id>new-run</tool-use-id><status>completed</status></task-notification>' } });
  const result = sync();
  assert.equal(result.jobs.find(job => job.id === 'reused').status, 'completed');
  assert.ok(result.jobs.some(job => job.id.startsWith('superseded_') && job.run === 'old-run' && job.status === 'pending'));
  append({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'new-run', content: 'Command running in background with ID: reused.' },
  ] } });
  append({ type: 'user', message: { content:
    '<task-notification><task-id>reused</task-id><tool-use-id>old-run</tool-use-id><status>completed</status></task-notification>' } });
  const settled = sync();
  assert.equal(settled.pending, false);
  assert.equal(settled.jobs.some(job => job.id.startsWith('superseded_')), false, 'the old run resolves only its retained obligation');
}));

test('a late old-run completion clears its superseded obligation without completing the current run', () => fixture(({ append, sync }) => {
  const first = { id: 'pane:10:11', processScoped: true, live: true };
  const second = { id: 'pane:10:12', processScoped: true, live: true };
  sync({ instance: first });
  launch(append, 'reused', 'old-run'); sync({ instance: first });
  sync({ instance: second });
  launch(append, 'reused', 'new-run'); sync({ instance: second });
  append({ type: 'user', message: { content:
    '<task-notification><task-id>reused</task-id><tool-use-id>old-run</tool-use-id><status>completed</status></task-notification>' } });
  let result = sync({ instance: second });
  assert.equal(result.jobs.find(job => job.id === 'reused').run, 'new-run');
  assert.equal(result.jobs.find(job => job.id === 'reused').status, 'pending');
  assert.equal(result.jobs.some(job => job.id.startsWith('superseded_')), false);
  append({ type: 'user', message: { content:
    '<task-notification><task-id>reused</task-id><tool-use-id>new-run</tool-use-id><status>completed</status></task-notification>' } });
  result = sync({ instance: second });
  assert.equal(result.pending, false);
}));

test('hook-first Agent completion retains child ownership without inventing a superseded run', () => fixture(({ root, append, sync }) => {
  jobs.recordHook(root, 'claude', 'parent', { event: 'SubagentStart', entity: 'child-one', at: 200000, offset: 0 });
  sync();
  append({ type: 'assistant', timestamp: new Date(199000).toISOString(), message: { content: [
    { type: 'tool_use', id: 'agent-run', name: 'Agent', input: { prompt: 'SECRET', run_in_background: true } },
  ] } });
  append({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(199500).toISOString(), content:
    '<task-notification><task-id>child-one</task-id><tool-use-id>agent-run</tool-use-id><status>completed</status></task-notification>' });
  append({ type: 'user', timestamp: new Date(201000).toISOString(), message: { content: [
    { type: 'tool_result', tool_use_id: 'agent-run', content: 'Async agent launched successfully. agentId: child-one' },
  ] } });
  const result = sync();
  const state = JSON.parse(fs.readFileSync(path.join(root, '.keep/background-jobs/claude/parent/state.json')));
  assert.equal(result.pending, false);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].kind, 'agent');
  assert.equal(result.jobs[0].status, 'completed');
  assert.equal(result.jobs.some(job => job.id.startsWith('superseded_')), false);
  assert.equal(state.restart.children['child-one'], 'owned');
}));

test('child evidence migration rebuilds temporal state while preserving graph obligations', () => fixture(({ root, append, sync }) => {
  const timestamp = '2026-09-09T12:00:00.000Z';
  append({ type: 'user', timestamp, message: { content: 'Review' } });
  append({ type: 'user', timestamp, message: { content: 'Review' } });
  append({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }], stop_reason: null }, timestamp: '2026-09-09T12:00:01.000Z' });
  sync();
  const file = path.join(root, '.keep/background-jobs/claude/parent/state.json');
  const old = JSON.parse(fs.readFileSync(file));
  old.childStopVersion = 2; // Previous boolean finalTextSeen schema.
  old.restart.finalTextSeen = true;
  old.restart.children.unresolved = 'owned';
  fs.writeFileSync(file, JSON.stringify(old));
  sync();
  const current = JSON.parse(fs.readFileSync(file));
  assert.ok(current.restart.finalTextAt);
  assert.equal(current.restart.finalTextBlocked, false);
  assert.equal(current.restart.finalTextSeen, Date.parse('2026-09-09T12:00:01.000Z'));
  assert.equal(current.restart.children.unresolved, 'owned');
  assert.equal(sync().bytesRead, 0);
}));

test('automated turn boundary persists beyond the Claude tail and a ledger restart', () => fixture(({ root, append, sync, now }) => {
  append({ type: 'user', message: { content: '[keep] scheduled check due' } });
  const start = now();
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'large', content: 'x'.repeat(300000) }] } });
  sync();
  assert.equal(jobs.read(root, 'claude', 'parent').turnStartedAt, start);
  sync();
  assert.equal(jobs.read(root, 'claude', 'parent').turnStartedAt, start);
}));

test('Claude wrapper records do not advance the durable turn boundary', () => fixture(({ root, append, sync, now }) => {
  append({ type: 'user', message: { content: '[keep] scheduled check due' } });
  const start = now();
  for (const content of ['<local-command-stdout>Set model to opus</local-command-stdout>', '<system-reminder>notice</system-reminder>', '<command-name>/model</command-name>', '<task-notification>done</task-notification>', '<bash-stdout>output</bash-stdout>', '']) {
    append({ type: 'user', message: { content } });
    sync();
    assert.equal(jobs.read(root, 'claude', 'parent').turnStartedAt, start);
  }
}));

test('existing Claude ledgers replay once to recover a turn outside the tail', () => fixture(({ root, append, sync, now }) => {
  append({ type: 'user', message: { content: '[keep] scheduled check due' } });
  const start = now();
  append({ type: 'assistant', message: { content: 'x'.repeat(300000) } });
  sync();
  const file = path.join(root, '.keep/background-jobs/claude/parent/state.json');
  const old = JSON.parse(fs.readFileSync(file));
  delete old.turnVersion; delete old.turnStartedAt;
  fs.writeFileSync(file, JSON.stringify(old));
  assert.ok(sync().bytesRead > 0);
  assert.equal(jobs.read(root, 'claude', 'parent').turnStartedAt, start);
  assert.equal(sync().bytesRead, 0);
}));

test('a system local_command wrapper is proof only of the command turn it closes', () => {
  const restartEvidence = require('./restart-evidence');
  const at = '2026-09-15T22:14:03.921Z';
  const row = (content) => ({ type: 'system', subtype: 'local_command', content, timestamp: at });
  const typed = { type: 'user', message: { content: '/compact' }, timestamp: at };
  const fresh = () => ({ restart: { completed: false, children: {}, launches: {}, mapped: {} } });
  for (const content of [
    '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>',
    "<local-command-stderr>Error during compaction: You've reached your Fable limit.</local-command-stderr>",
  ]) {
    const state = fresh();
    restartEvidence.consume(state, typed, 'claude');
    assert.equal(state.restart.completed, false, 'the typed command opens a turn');
    restartEvidence.consume(state, { type: 'user', message: { content: '<local-command-caveat>Caveat</local-command-caveat>' }, timestamp: at }, 'claude');
    restartEvidence.consume(state, row(content), 'claude');
    assert.equal(state.restart.completed, true, content);
    assert.equal(state.restart.observedAt, Date.parse(at));
  }
  const echoed = fresh();
  restartEvidence.consume(echoed, typed, 'claude');
  restartEvidence.consume(echoed, row('<command-name>/compact</command-name>\n<command-args></command-args>'), 'claude');
  assert.equal(echoed.restart.completed, false, 'the echo of the typed command proves nothing');
  assert.equal(echoed.restart.observedAt, Date.parse(at));

  // Owner pressing /model mid-turn writes the same rows while the model is still
  // working. Nothing there closes the turn the tool call opened.
  const interleaved = fresh();
  restartEvidence.consume(interleaved, { type: 'user', message: { content: 'Why did the review miss this?' }, timestamp: at }, 'claude');
  restartEvidence.consume(interleaved, { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash' }] }, timestamp: at }, 'claude');
  restartEvidence.consume(interleaved, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }, timestamp: at }, 'claude');
  restartEvidence.consume(interleaved, row('<command-name>/model</command-name>'), 'claude');
  restartEvidence.consume(interleaved, row('<local-command-stdout>Kept model as Opus 4.8</local-command-stdout>'), 'claude');
  assert.equal(interleaved.restart.completed, false, 'the wrapper closes no command turn');
  restartEvidence.consume(interleaved, { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }, timestamp: at }, 'claude');
  assert.equal(interleaved.restart.completed, true, 'the interrupted turn is what ends it');

  // A finished command turn is spent: a second wrapper cannot resurrect it.
  const reused = fresh();
  restartEvidence.consume(reused, typed, 'claude');
  restartEvidence.consume(reused, row('<local-command-stdout>Compacted</local-command-stdout>'), 'claude');
  restartEvidence.consume(reused, { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash' }] }, timestamp: at }, 'claude');
  restartEvidence.consume(reused, row('<local-command-stdout>Kept model as Opus 4.8</local-command-stdout>'), 'claude');
  assert.equal(reused.restart.completed, false);
});

test('a failed /compact settles the ledger on its stderr wrapper', () => fixture(({ root, append, sync }) => {
  const snapshot = path.join(root, '.keep/background-jobs/claude/parent/state.json');
  append({ sessionId: 'parent', type: 'user', message: { content: '/compact' } });
  append({ sessionId: 'parent', type: 'user', message: { content: '<local-command-caveat>Caveat: generated by local commands</local-command-caveat>' } });
  sync();
  assert.equal(JSON.parse(fs.readFileSync(snapshot)).restart.completed, false, 'the typed command opens a turn');
  // No summary and no assistant record follow a compaction that hit the limit.
  append({ type: 'system', subtype: 'local_command', content: "<local-command-stderr>Error during compaction: You've reached your Fable limit.</local-command-stderr>" });
  sync();
  assert.equal(JSON.parse(fs.readFileSync(snapshot)).restart.completed, true);
}));

test('restart evidence upgrade replays history without clearing an inherited gap', () => fixture(({ root, append, sync }) => {
  append({ sessionId: 'parent', type: 'assistant', message: { content: [], stop_reason: 'end_turn' } });
  sync();
  const snapshot = path.join(root, '.keep/background-jobs/claude/parent/state.json');
  const old = JSON.parse(fs.readFileSync(snapshot));
  old.restartVersion = 1;
  old.gap = true;
  old.hookBarrier = 0;
  old.hookGeneration = 7;
  old.processEpoch = { id: 'pane:old', from: 0, identity: 'old' };
  old.restart.children['hook-only-child'] = 'owned';
  old.restart.launches['unmapped-launch'] = true;
  old.restart.mapped['mapped-launch'] = 'hook-only-child';
  fs.writeFileSync(snapshot, JSON.stringify(old));
  const result = sync();
  const current = JSON.parse(fs.readFileSync(snapshot));
  assert.equal(current.restartVersion, jobs.restartVersion('claude'));
  assert.equal(result.recovering, false);
  assert.equal(result.gap, true);
  assert.equal(current.restart.completed, true, 'the replay still refreshes reducer evidence');
  assert.equal(current.hookBarrier, 0);
  assert.equal(current.hookGeneration, 7);
  assert.deepEqual(current.processEpoch, old.processEpoch);
  assert.equal(current.restart.children['hook-only-child'], 'owned');
  assert.equal(current.restart.launches['unmapped-launch'], true);
  assert.equal(current.restart.mapped['mapped-launch'], 'hook-only-child');
  assert.throws(() => require('./restart-ledger').verify({ root, agent: 'claude', sid: 'parent', file: path.join(root, 'session.jsonl'),
    instance: { id: 'pane:1:2', since: 1, live: true } }), /incomplete/);
}));

test('turn migration replays completion notices for pruned historical jobs', () => fixture(({ root, append, sync }) => {
  for (let i = 0; i < 501; i++) { launch(append, `job${i}`, `call${i}`); done(append, `job${i}`); }
  assert.equal(sync().pending, false);
  const file = path.join(root, '.keep/background-jobs/claude/parent/state.json');
  const old = JSON.parse(fs.readFileSync(file));
  assert.equal(Object.keys(old.jobs).length, 500);
  delete old.turnVersion;
  fs.writeFileSync(file, JSON.stringify(old));
  assert.equal(sync().pending, false);
  assert.equal(jobs.read(root, 'claude', 'parent').jobs.every(j => j.status === 'completed'), true);
}));

test('a self-paced /loop wakeup is a one-shot scheduled job; a later one or stop:true ends it', () => fixture(({ root, append, sync }) => {
  const wake = (call, input) => {
    append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: call, name: 'ScheduleWakeup', input }] } });
    append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: call, content: 'Scheduled.' }] } });
  };
  const instance = { id: 'pane:10', since: 1, live: true };
  wake('w1', { delaySeconds: 1200, prompt: 'SECRET PROMPT', reason: 'watching CI' });
  let job = sync({ instance }).jobs.find((j) => j.id === 'wakeup_w1');
  assert.equal(job.kind, 'scheduled');
  assert.equal(job.status, 'pending');
  assert.equal(job.recurring, false);
  assert.equal(job.expiresAt - job.startedAt, 1200e3);
  wake('w2', { delaySeconds: 60, prompt: 'SECRET PROMPT' });
  const jobsNow = sync({ instance }).jobs;
  assert.equal(jobsNow.find((j) => j.id === 'wakeup_w1').status, 'cancelled', 'a new wakeup replaces the old one');
  assert.equal(jobsNow.find((j) => j.id === 'wakeup_w2').status, 'pending');
  wake('w3', { stop: true });
  const stopped = sync({ instance }).jobs;
  assert.equal(stopped.find((j) => j.id === 'wakeup_w2').status, 'cancelled', 'stop ends the loop');
  assert.equal(stopped.some((j) => j.id === 'wakeup_w3'), false);
  assert.doesNotMatch(fs.readFileSync(path.join(root, '.keep/background-jobs/claude/parent/state.json'), 'utf8'), /SECRET/);
}));

test('Claude cron creation, cancellation, expiry, process replacement and old-ledger recovery', () => fixture(({ root, append, sync }) => {
  const create = (call, id) => {
    append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: call, name: 'CronCreate', input: { cron: '* * * * *', prompt: 'SECRET' } }] } });
    append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: call, content: `Scheduled recurring job ${id} (* * * * *). Session-only. Auto-expires after 7 days.` }] } });
  };
  const instance = { id: 'pane:10', since: 1, live: true };
  create('a', 'one');
  let r = sync({ instance }); assert.equal(r.jobs[0].kind, 'scheduled'); assert.equal(r.pending, false);
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'delete', name: 'CronDelete', input: { id: 'one' } }] } });
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'delete', content: 'Cancelled job one.' }] } });
  assert.equal(sync({ instance }).jobs[0].status, 'cancelled');
  create('b', 'two'); assert.equal(sync({ instance }).jobs.find(j=>j.id==='cron_two').status, 'pending');
  assert.equal(sync({ instance: { ...instance, id: 'pane:11' } }).jobs.find(j=>j.id==='cron_two').status, 'cancelled');
  create('c', 'three'); sync({ instance });
  assert.equal(sync({ instance, now: 8 * 86400e3 }).jobs.find(j=>j.id==='cron_three').status, 'cancelled');
  const file = path.join(root, '.keep/background-jobs/claude/parent/state.json');
  const old = JSON.parse(fs.readFileSync(file)); delete old.cronVersion; fs.writeFileSync(file, JSON.stringify(old));
  r = sync({ instance }); assert.equal(r.gap, false); assert.ok(r.bytesRead > 0);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /SECRET/);
}));

test('job survives tail rollover and cold ledger restart, then a missed-hook completion clears it', () => fixture(({ root, file, append, sync, now }) => {
  launch(append);
  assert.equal(sync().pending, true);
  append({ type: 'assistant', message: { content: 'x'.repeat(400000) } });
  const recovered = sync();
  assert.equal(recovered.pending, true);
  assert.ok(recovered.bytesRead < fs.statSync(file).size, 'only appended bytes are read');
  delete require.cache[require.resolve('./background-jobs')];
  const cold = require('./background-jobs');
  assert.equal(cold.read(root, 'claude', 'parent', now()).pending, true);
  assert.equal(cold.sync({ root, agent: 'claude', sid: 'parent', file, now: now() }).bytesRead, 0);
  done(append);
  assert.equal(sync().pending, false);
  assert.equal(jobs.read(root, 'claude', 'parent', now()).jobs[0].status, 'completed');
  const ledger = fs.readFileSync(path.join(root, '.keep/background-jobs/claude/parent/state.json'), 'utf8');
  assert.equal(ledger.includes('SECRET'), false);
}));

test('duplicates do not revive completed jobs and an explicit new launch may reuse an ID', () => fixture(({ append, sync }) => {
  launch(append); done(append); done(append); sync();
  launch(append); assert.equal(sync().pending, false, 'same tool call is the same run');
  launch(append, 'j', 'new-call'); assert.equal(sync().pending, true);
  // Redelivery of the old completion notification must not finish the new run.
  done(append); assert.equal(sync().pending, true);
  done(append, 'j', 'failed'); assert.equal(sync().jobs[0].status, 'failed');
}));

test('stale jobs become uncertain; closing parent never marks jobs complete', () => fixture(({ root, append, sync, now }) => {
  launch(append); sync();
  const state = jobs.read(root, 'claude', 'parent', now() + 31 * 60e3);
  assert.equal(state.pending, false); assert.deepEqual(state.uncertain, ['j']);
  assert.equal(state.jobs[0].status, 'pending');
  assert.equal(activity({ endedTurn: true, pane: 'p', unknownBackgroundJobs: state.uncertain }).decision.rule, 'conversation-ready');
  assert.equal(activity({ exited: true, unknownBackgroundJobs: state.uncertain }).state, 'exited');
  assert.equal(jobs.targets(root).length, 1, 'daemon restart keeps tracking the closed parent job');
}));

test('partial lines retry without advancing and truncated transcripts retain unresolved jobs', () => fixture(({ root, file, append, sync, now }) => {
  launch(append); sync();
  fs.appendFileSync(file, '{"type":"user"');
  assert.equal(sync().recovering, true);
  fs.appendFileSync(file, ',"message":{"content":"ordinary"}}\n');
  assert.equal(sync().recovering, false);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'new file' } }) + '\n');
  const replaced = sync();
  assert.equal(replaced.jobs[0].status, 'pending');
  assert.ok(replaced.uncertain.includes('j'));
  assert.ok(replaced.gap);
  assert.equal(replaced.gapReason, 'transcript-replaced');
  const snapshot = path.join(root, '.keep/background-jobs/claude/parent/state.json');
  assert.equal(JSON.parse(fs.readFileSync(snapshot)).gapAt, now());
  const stale = JSON.parse(fs.readFileSync(snapshot));
  stale.childStopVersion = 2; delete stale.gapAt; delete stale.gapReason;
  fs.writeFileSync(snapshot, JSON.stringify(stale));
  fs.writeFileSync(file, 'x');
  const anchored = sync();
  assert.equal(anchored.gap, true);
  assert.equal(anchored.gapReason, 'checkpoint-anchor');
  assert.equal(JSON.parse(fs.readFileSync(snapshot)).gapAt, now());
}));

test('a cold replay clears a gap it can fully re-derive and never one it re-marks', () => fixture(({ root, file, append, sync, now }) => {
  jobs.recordHook(root, 'claude', 'parent', { event: 'SubagentStart', entity: 'kid', at: 90000, offset: 0 });
  launch(append); done(append); sync();
  const snapshot = path.join(root, '.keep/background-jobs/claude/parent/state.json');
  const reopen = () => JSON.parse(fs.readFileSync(snapshot));
  const gapped = () => { const s = reopen(); s.gap = true; s.gapAt = 1; s.gapReason = 'budget-skip'; fs.writeFileSync(snapshot, JSON.stringify(s)); };

  gapped();
  const ignored = sync();
  assert.equal(ignored.gap, true, 'an ordinary pass never replays a gapped ledger');
  assert.equal(ignored.bytesRead, 0);
  assert.equal(reopen().coldReplay, undefined);

  const cleared = sync({ coldReplay: true });
  assert.equal(cleared.gap, false);
  assert.equal(cleared.gapReason, undefined);
  assert.equal(cleared.gapClearedAt, now());
  assert.ok(cleared.bytesRead > 0, 'the whole transcript is replayed');
  const replayed = reopen();
  assert.equal(replayed.gapClearedBy, 'cold-replay');
  assert.equal(replayed.coldReplay, undefined);
  assert.equal(replayed.lastColdReplayAt, now());
  assert.equal(replayed.jobs['job:kid'].kind, 'agent', 'a hook-only agent job survives the replay');
  assert.equal(replayed.jobs['job:j'].status, 'completed');

  gapped();
  append({ type: 'assistant', message: { content: 'x'.repeat(5000) } });
  assert.equal(sync({ coldReplay: true, budget: 2000 }).recovering, true);
  assert.equal(reopen().coldReplay.startedAt, now());
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'new file' } }) + '\n');
  const remarked = sync({ budget: 2000 });
  assert.equal(remarked.gap, true);
  assert.equal(remarked.gapReason, 'transcript-replaced');
  assert.equal(reopen().coldReplay, undefined, 'a replay that lost history is abandoned, not credited');
}));

test('sticky, legacy and growing-transcript gaps each get the replay they deserve', () => fixture(({ root, append, sync, now }) => {
  launch(append); done(append); sync();
  const snapshot = path.join(root, '.keep/background-jobs/claude/parent/state.json');
  const reopen = () => JSON.parse(fs.readFileSync(snapshot));
  const patch = (fields) => fs.writeFileSync(snapshot, JSON.stringify({ ...reopen(), ...fields }));

  for (const reason of ['transcript-replaced', 'checkpoint-anchor', 'hook-transcript-mismatch']) {
    patch({ gap: true, gapAt: 1, gapReason: reason });
    const sticky = sync({ coldReplay: true });
    assert.equal(sticky.gap, true, `history lost to ${reason} is never re-derivable`);
    assert.equal(sticky.gapReason, reason);
    assert.equal(reopen().coldReplay, undefined, 'the refreshing replay still finishes and is dropped');
  }

  const legacy = reopen();
  legacy.gap = true; delete legacy.gapAt; delete legacy.gapReason;
  fs.writeFileSync(snapshot, JSON.stringify(legacy));
  const stamped = sync({ coldReplay: true });
  assert.equal(stamped.gap, true);
  assert.equal(stamped.gapReason, 'legacy');
  assert.equal(reopen().coldReplay, undefined, 'the stamping pass defers the replay to the next one');
  assert.equal(sync({ coldReplay: true, now: now() + 1000 }).gap, false, 'a legacy gap is clearable by a full replay');

  patch({ gap: true, gapAt: 1, gapReason: 'budget-skip' });
  append({ type: 'assistant', message: { content: 'x'.repeat(5000) } });
  assert.equal(sync({ coldReplay: true, budget: 1000 }).recovering, true);
  append({ type: 'user', message: { content: 'more work' } });
  const finished = sync({ budget: 1000 });
  assert.equal(finished.recovering, false);
  assert.equal(finished.caughtUp, true);
  assert.equal(finished.gap, false, 'growth during a replay only means another pass');
  assert.equal(reopen().gapClearedBy, 'cold-replay');
}));

test('a sticky gap reason outranks the ordinary gaps that follow it', () => {
  const state = { gap: false };
  jobs.markGap(state, 1000, 'transcript-replaced');
  jobs.markGap(state, 2000, 'read-error');
  assert.equal(state.gapReason, 'transcript-replaced');
  assert.equal(state.gapAt, 2000, 'the stamp still advances so a replay cannot outrun its own gap');
  jobs.markGap(state, 3000, 'checkpoint-anchor');
  assert.equal(state.gapReason, 'checkpoint-anchor', 'one lost-history reason may replace another');
  fixture(({ root, file, append, sync, now }) => {
    launch(append); done(append); sync();
    const snapshot = path.join(root, '.keep/background-jobs/claude/parent/state.json');
    fs.writeFileSync(snapshot, JSON.stringify({ ...JSON.parse(fs.readFileSync(snapshot)), gap: true, gapAt: 1, gapReason: 'transcript-replaced' }));
    fs.appendFileSync(file, '{"type":"user"\n');
    assert.equal(sync().gapReason, 'transcript-replaced', 'an ordinary re-mark cannot demote lost history');
    const replayed = sync({ coldReplay: true, now: now() + 1000 });
    assert.equal(replayed.gap, true, 'and the replay it triggers still refuses to clear the gap');
    assert.equal(replayed.gapReason, 'transcript-replaced');
  });
});

const ABANDON_AFTER = 3 * 3600e3;
const abandonment = (childEvidence, recentCheck) => fixture(({ root, append, sync, now }) => {
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'spawn', name: 'Agent', input: {} }] } });
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'spawn', content: 'Async agent launched successfully. agentId: kid' }] } });
  const childAt = now(), inspectAgent = () => childEvidence(childAt);
  const kid = (result) => result.jobs.find(j => j.id === 'kid');
  assert.equal(kid(sync({ inspectAgent, now: childAt + ABANDON_AFTER + 1000 })).status, 'pending', 'an unfinished parent turn is not evidence the child died');
  append({ sessionId: 'parent', type: 'assistant', message: { content: [], stop_reason: 'end_turn' } });
  const ended = now();
  assert.equal(kid(sync({ inspectAgent, now: ended + 1000 })).status, 'pending', 'a young job is ordinary outstanding work');
  // A missing child transcript falls back to the launch time; a present one
  // must itself be stale before the job can be called abandoned.
  const childFile = path.join(root, 'child.jsonl');
  let childTranscriptFor = () => path.join(root, 'missing.jsonl');
  if (recentCheck) {
    assert.equal(kid(sync({ inspectAgent: () => ({ at: ended + ABANDON_AFTER + 500, done: false }), now: ended + ABANDON_AFTER + 1000 })).status,
      'pending', 'a child that is still writing is alive');
    assert.equal(kid(sync({ inspectAgent: () => ({ at: ended + 1, done: false }), now: ended + ABANDON_AFTER + 2000 })).status,
      'pending', 'a child that wrote after the parent stopped observing is not abandoned');
    fs.writeFileSync(childFile, '');
    childTranscriptFor = () => childFile;
    assert.equal(kid(sync({ inspectAgent, childTranscriptFor, now: ended + ABANDON_AFTER + 1000 })).status,
      'pending', 'a child transcript written moments ago is not a dead child');
    fs.utimesSync(childFile, childAt / 1000, childAt / 1000);
  }
  const abandoned = kid(sync({ inspectAgent, childTranscriptFor, now: ended + ABANDON_AFTER + 1000 }));
  assert.equal(abandoned.status, 'cancelled');
  assert.equal(abandoned.evidence, 'abandoned-child');
  assert.equal(abandoned.abandonedAt, ended + ABANDON_AFTER + 1000);
  const state = jobs.read(root, 'claude', 'parent', ended + ABANDON_AFTER + 1000);
  assert.equal(state.pending, false);
  assert.deepEqual(state.uncertain, []);
});

test('a pending subagent is abandoned only once its completed parent turn outlives the child', () => {
  abandonment((at) => ({ at, done: false }), true);
  abandonment(() => { const error = Error('missing child transcript'); error.code = 'ENOENT'; throw error; }, false);
});

test('a multi-pass cold replay never abandons a child whose completion is still unread', () => fixture(({ root, append, sync, now }) => {
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'spawn', name: 'Agent', input: {} }] } });
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'spawn', content: 'Async agent launched successfully. agentId: kid' }] } });
  const childAt = now();
  sync();
  append({ sessionId: 'parent', type: 'assistant', message: { content: [], stop_reason: 'end_turn' } });
  append({ type: 'assistant', message: { content: 'x'.repeat(5000) } });
  done(append, 'kid');
  const snapshot = path.join(root, '.keep/background-jobs/claude/parent/state.json');
  const gapped = JSON.parse(fs.readFileSync(snapshot));
  gapped.gap = true; gapped.gapAt = 1; gapped.gapReason = 'budget-skip';
  fs.writeFileSync(snapshot, JSON.stringify(gapped));
  const late = now() + 4 * 3600e3;
  const options = { coldReplay: true, budget: 1000, inspectAgent: () => ({ at: childAt, done: false }), now: late };
  let result = sync(options);
  assert.equal(result.recovering, true, 'the parent turn is complete in the replayed prefix');
  assert.equal(result.jobs.find(j => j.id === 'kid').status, 'pending', 'an unread tail may still hold the completion');
  for (let i = 0; i < 40 && result.recovering; i++) result = sync({ ...options, coldReplay: false });
  assert.equal(result.recovering, false);
  assert.equal(result.jobs.find(j => j.id === 'kid').status, 'completed');
  assert.equal(result.gap, false, 'the replay reached the end of a transcript it could re-derive');
}));

test('hook evidence that has not reached the transcript blocks abandonment', () => fixture(({ root, file, append, sync, now }) => {
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'spawn', name: 'Agent', input: {} }] } });
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'spawn', content: 'Async agent launched successfully. agentId: kid' }] } });
  append({ sessionId: 'parent', type: 'assistant', message: { content: [], stop_reason: 'end_turn' } });
  const ended = now();
  jobs.recordHook(root, 'claude', 'parent', { event: 'PreToolUse', entity: 'call', at: ended, offset: fs.statSync(file).size + 5000 });
  const options = { inspectAgent: () => ({ at: ended - 1000, done: false }), now: ended + 4 * 3600e3 };
  assert.equal(sync(options).jobs.find(j => j.id === 'kid').status, 'pending', 'the barrier may still hide the child work');
  append({ sessionId: 'parent', type: 'assistant', message: { content: 'x'.repeat(5000), stop_reason: 'end_turn' } });
  assert.equal(sync(options).jobs.find(j => j.id === 'kid').status, 'cancelled');
}));

test('an abandoned child tombstone outlives tombstone pruning while the parent still names it', () => fixture(({ root, append, sync, now }) => {
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'spawn', name: 'Agent', input: {} }] } });
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'spawn', content: 'Async agent launched successfully. agentId: kid' }] } });
  append({ sessionId: 'parent', type: 'assistant', message: { content: [], stop_reason: 'end_turn' } });
  const ended = now();
  const abandoned = sync({ abandonAfter: 1000, inspectAgent: () => ({ at: ended - 1000, done: false }), now: ended + 2000 });
  assert.equal(abandoned.jobs.find(j => j.id === 'kid').evidence, 'abandoned-child');
  for (let i = 0; i < 501; i++) { launch(append, `job${i}`, `call${i}`); done(append, `job${i}`); }
  sync();
  const state = JSON.parse(fs.readFileSync(path.join(root, '.keep/background-jobs/claude/parent/state.json')));
  assert.equal(state.jobs['job:job0'], undefined, 'older tombstones are still pruned');
  assert.equal(state.jobs['job:kid'].status, 'cancelled');
  assert.equal(state.jobs['job:kid'].evidence, 'abandoned-child');
  assert.equal(state.restart.children.kid, 'owned');
  assert.equal(jobs.read(root, 'claude', 'parent', now()).jobs.filter(j => j.evidence === 'abandoned-child').length, 1);
}));

test('verified fresh startup bridges the first hooks until a complete transcript exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-jobs-fresh-start-'));
  const file = path.join(root, 'parent.jsonl');
  const lifecycle = require('./session-lifecycle');
  try {
    const base = { session_id: 'parent', agentKind: 'claude', transcript_path: file };
    lifecycle.record(root, { ...base, hook_event_name: 'SessionStart', source: 'startup' }, 1000);
    lifecycle.record(root, { ...base, hook_event_name: 'UserPromptSubmit' }, 1000);

    const waiting = jobs.sync({ root, agent: 'claude', sid: 'parent', file, now: 1100 });
    assert.equal(waiting.recovering, true);
    assert.equal(waiting.gap, false);
    assert.ok(waiting.uncertain.includes('history-recovery'));

    const transcriptId = require('node:crypto').createHash('sha256').update(path.resolve(file)).digest('hex');
    jobs.recordHook(root, 'claude', 'parent', { event: 'SessionStart', entity: 'turn', at: 1000, offset: null,
      transcriptId, missing: true, freshStart: true });
    jobs.recordHook(root, 'claude', 'parent', { event: 'UserPromptSubmit', entity: 'turn', at: 1000, offset: null,
      transcriptId, missing: true });
    const replayed = jobs.sync({ root, agent: 'claude', sid: 'parent', file, now: 1150 });
    assert.equal(replayed.gap, false, 'durable hook replay after snapshot commit is idempotent');

    const rows = [
      { type: 'user', sessionId: 'parent', timestamp: new Date(1200).toISOString(), message: { content: 'hello' } },
      { type: 'assistant', sessionId: 'parent', timestamp: new Date(1300).toISOString(), message: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } },
    ];
    fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
    const complete = jobs.sync({ root, agent: 'claude', sid: 'parent', file, now: 1400 });
    assert.equal(complete.recovering, false);
    assert.equal(complete.gap, false);
    assert.deepEqual(complete.uncertain, []);

    const snapshot = JSON.parse(fs.readFileSync(path.join(root, '.keep/background-jobs/claude/parent/state.json')));
    assert.equal(snapshot.hookBarrier, 0);
    assert.equal(snapshot.checkpoint.offset, fs.statSync(file).size);
    assert.equal(snapshot.freshStartup.promptAt, 1000);
    require('./restart-ledger').verify({ root, agent: 'claude', sid: 'parent', file,
      instance: { id: 'pane:1:2', since: 1, live: true } })();

    jobs.recordHook(root, 'claude', 'parent', { event: 'SessionStart', entity: 'turn', at: 1000, offset: null,
      transcriptId, missing: true, freshStart: true });
    jobs.recordHook(root, 'claude', 'parent', { event: 'UserPromptSubmit', entity: 'turn', at: 1000, offset: null,
      transcriptId, missing: true });
    const committedReplay = jobs.sync({ root, agent: 'claude', sid: 'parent', file, now: 1500 });
    assert.equal(committedReplay.gap, false, 'post-snapshot hook replay remains accepted after the transcript is complete');
    require('./restart-ledger').verify({ root, agent: 'claude', sid: 'parent', file,
      instance: { id: 'pane:1:2', since: 1, live: true } })();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('transaction rebind preserves evidence, ignores its frozen former source, and rejects mutations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-jobs-rebind-'));
  const source = path.join(root, 'source', 'parent.jsonl'), target = path.join(root, 'target', 'parent.jsonl');
  try {
    fs.mkdirSync(path.dirname(source)); fs.mkdirSync(path.dirname(target));
    const transcript = [
      { type: 'user', sessionId: 'parent', timestamp: new Date(1000).toISOString(), message: { content: 'work' } },
      { type: 'assistant', sessionId: 'parent', timestamp: new Date(1100).toISOString(), message: { content: [], stop_reason: 'end_turn' } },
    ].map(JSON.stringify).join('\n') + '\n';
    fs.writeFileSync(source, transcript); fs.copyFileSync(source, target);
    jobs.sync({ root, agent: 'claude', sid: 'parent', file: source, now: 1200 });
    const snapshot = path.join(root, '.keep/background-jobs/claude/parent/state.json');
    const seeded = JSON.parse(fs.readFileSync(snapshot));
    seeded.restart.children = { kid: 'owned', ghost: 'owned' };
    seeded.jobs['job:kid'] = { id: 'kid', kind: 'agent', status: 'pending', startedAt: 1100, eventAt: 1100, evidence: 'transcript', run: 'a' };
    seeded.jobs['job:ghost'] = { id: 'ghost', kind: 'agent', status: 'cancelled', startedAt: 1100, eventAt: 1100, evidence: 'abandoned-child', run: 'b' };
    fs.writeFileSync(snapshot, JSON.stringify(seeded));
    const before = JSON.parse(fs.readFileSync(snapshot));

    const rebound = jobs.rebindSource({ root, agent: 'claude', sid: 'parent', sourceFile: source, targetFile: target,
      transactionId: 'tx-a-b', sourceStopVerifiedAt: 1 });
    assert.equal(rebound.reused, false);
    assert.deepEqual(rebound.children, ['kid'], 'an abandoned child has no ledger left to rebind');
    const after = JSON.parse(fs.readFileSync(path.join(root, '.keep/background-jobs/claude/parent/state.json')));
    assert.deepEqual(after.jobs, before.jobs);
    assert.deepEqual(after.restart, before.restart);
    assert.equal(after.source.file, path.resolve(target));
    assert.notEqual(after.checkpoint.identity, before.checkpoint.identity);
    assert.equal(jobs.rebindSource({ root, agent: 'claude', sid: 'parent', sourceFile: source, targetFile: target,
      transactionId: 'tx-a-b', sourceStopVerifiedAt: 1 }).reused, true);

    jobs.recordHook(root, 'claude', 'parent', { event: 'PreToolUse', entity: 'call', at: 1300,
      offset: fs.statSync(target).size });
    const inbox = path.join(root, '.keep/background-jobs/claude/parent/inbox');
    const queued = fs.readdirSync(inbox);
    const stale = jobs.sync({ root, agent: 'claude', sid: 'parent', file: source, now: 1400 });
    assert.equal(stale.gap, false);
    assert.deepEqual(fs.readdirSync(inbox), queued, 'target hook evidence is retained during a stale-source tick');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.keep/background-jobs/claude/parent/state.json'))).source.file,
      path.resolve(target));
    assert.equal(jobs.sync({ root, agent: 'claude', sid: 'parent', file: target, now: 1500 }).gap, false);
    assert.deepEqual(fs.readdirSync(inbox), []);

    fs.appendFileSync(source, 'changed after source exit\n');
    const changed = jobs.sync({ root, agent: 'claude', sid: 'parent', file: source, now: 1600 });
    assert.equal(changed.gap, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.keep/background-jobs/claude/parent/state.json'))).source.file,
      path.resolve(target), 'a changed former source never regains authority');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Codex transaction rebind preserves restart evidence and remains idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-jobs-codex-rebind-'));
  const sid = '11111111-1111-4111-8111-111111111111';
  const source = path.join(root, 'source', `${sid}.jsonl`), target = path.join(root, 'target', `${sid}.jsonl`);
  try {
    fs.mkdirSync(path.dirname(source)); fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(source, [
      { timestamp: new Date(1000).toISOString(), type: 'session_meta', payload: { id: sid, cwd: root } },
      { timestamp: new Date(1100).toISOString(), type: 'event_msg', payload: { type: 'task_complete' } },
    ].map(JSON.stringify).join('\n') + '\n');
    fs.copyFileSync(source, target);
    jobs.sync({ root, agent: 'codex', sid, file: source, now: 1200 });
    const snapshot = path.join(root, '.keep', 'background-jobs', 'codex', sid, 'state.json');
    const before = JSON.parse(fs.readFileSync(snapshot));
    const first = jobs.rebindSource({ root, agent: 'codex', sid, sourceFile: source, targetFile: target,
      transactionId: 'codex-transfer', sourceStopVerifiedAt: 1 });
    assert.equal(first.reused, false);
    const after = JSON.parse(fs.readFileSync(snapshot));
    assert.deepEqual(after.jobs, before.jobs); assert.deepEqual(after.restart, before.restart);
    assert.equal(after.source.file, path.resolve(target));
    assert.equal(jobs.rebindSource({ root, agent: 'codex', sid, sourceFile: source, targetFile: target,
      transactionId: 'codex-transfer', sourceStopVerifiedAt: 1 }).reused, true);
    fs.appendFileSync(target, '{}\n');
    assert.throws(() => jobs.rebindSource({ root, agent: 'codex', sid, sourceFile: source, targetFile: target,
      transactionId: 'codex-transfer', sourceStopVerifiedAt: 1 }), /does not match|no longer matches/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ledger rebind refuses divergent copies, hard links, and pre-existing incomplete evidence', () => {
  for (const mode of ['copy', 'hard-link', 'gap']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `keep-jobs-rebind-${mode}-`));
    const source = path.join(root, 'source.jsonl'), target = path.join(root, 'target.jsonl');
    try {
      fs.writeFileSync(source, JSON.stringify({ type: 'assistant', sessionId: 'parent', timestamp: new Date(1000).toISOString(),
        message: { content: [], stop_reason: 'end_turn' } }) + '\n');
      if (mode === 'hard-link') fs.linkSync(source, target);
      else fs.copyFileSync(source, target);
      jobs.sync({ root, agent: 'claude', sid: 'parent', file: source, now: 1100 });
      if (mode === 'copy') fs.appendFileSync(target, 'divergent\n');
      else {
        const snapshot = path.join(root, '.keep/background-jobs/claude/parent/state.json');
        const state = JSON.parse(fs.readFileSync(snapshot)); state.gap = true; fs.writeFileSync(snapshot, JSON.stringify(state));
      }
      assert.throws(() => jobs.rebindSource({ root, agent: 'claude', sid: 'parent', sourceFile: source,
        targetFile: target, transactionId: 'tx-a-b', sourceStopVerifiedAt: 1 }), /does not match|same physical|incomplete/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('a forced rebind accepts a gapped, restart-record-less ledger and reports no children', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-jobs-rebind-force-'));
  const source = path.join(root, 'source.jsonl'), target = path.join(root, 'target.jsonl');
  try {
    fs.writeFileSync(source, JSON.stringify({ type: 'assistant', sessionId: 'parent', timestamp: new Date(1000).toISOString(),
      message: { content: [], stop_reason: 'end_turn' } }) + '\n');
    fs.copyFileSync(source, target);
    jobs.sync({ root, agent: 'claude', sid: 'parent', file: source, now: 1100 });
    const snapshot = path.join(root, '.keep/background-jobs/claude/parent/state.json');
    const state = JSON.parse(fs.readFileSync(snapshot));
    state.gap = true; delete state.restart; fs.writeFileSync(snapshot, JSON.stringify(state));
    const request = { root, agent: 'claude', sid: 'parent', sourceFile: source, targetFile: target,
      transactionId: 'tx-force', sourceStopVerifiedAt: 1 };
    assert.throws(() => jobs.rebindSource(request), /incomplete/);
    const rebound = jobs.rebindSource({ ...request, force: true });
    assert.equal(rebound.reused, false);
    assert.deepEqual(rebound.children, [], 'a forced rebind claims no verified child graph');
    const after = JSON.parse(fs.readFileSync(snapshot));
    assert.equal(after.source.file, path.resolve(target));
    assert.equal(after.gap, true, 'the gap survives the rebind');
    assert.equal(jobs.rebindSource({ ...request, force: true }).reused, true);
    // A present restart record with children is still not reported under force.
    const withChildren = JSON.parse(fs.readFileSync(snapshot));
    withChildren.restart = { id: 'parent', children: { child: 'owned' }, launches: {}, mapped: {} };
    fs.writeFileSync(snapshot, JSON.stringify(withChildren));
    assert.deepEqual(jobs.rebindSource({ ...request, force: true }).children, [], 'force never reports the child graph');
    fs.appendFileSync(target, 'divergent\n');
    assert.throws(() => jobs.rebindSource({ ...request, force: true }), /does not match|no longer matches/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a settled transcript-replaced gap reports as settled and rebinds without force', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-jobs-settled-gap-'));
  const source = path.join(root, 'source', 'parent.jsonl'), target = path.join(root, 'target', 'parent.jsonl');
  const snapshot = path.join(root, '.keep/background-jobs/claude/parent/state.json');
  const load = () => JSON.parse(fs.readFileSync(snapshot, 'utf8'));
  const line = (value) => JSON.stringify(value) + '\n';
  const user = (at, content) => line({ type: 'user', sessionId: 'parent', timestamp: new Date(at).toISOString(), message: { content } });
  const assistant = (at) => line({ type: 'assistant', sessionId: 'parent', timestamp: new Date(at).toISOString(), message: { content: [], stop_reason: 'end_turn' } });
  try {
    fs.mkdirSync(path.dirname(source)); fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(source, user(1000, 'history that auto-compaction is about to replace') + assistant(1100)
      + user(1200, 'more history that auto-compaction is about to replace') + assistant(1300));
    assert.equal(jobs.sync({ root, agent: 'claude', sid: 'parent', file: source, now: 1400 }).gapSettled, false);
    // Auto-compaction rewrites the transcript as a shorter summary of itself.
    fs.writeFileSync(source, user(2000, 'summary') + assistant(2100));
    const replaced = jobs.sync({ root, agent: 'claude', sid: 'parent', file: source, now: 2200 });
    assert.equal(replaced.gap, true);
    assert.equal(replaced.gapReason, 'transcript-replaced');
    assert.equal(replaced.gapSettled, true);
    assert.deepEqual(replaced.uncertain, ['history-gap'], 'a settled gap stays visible as uncertain evidence');
    assert.equal(jobs.read(root, 'claude', 'parent', 2300).gapSettled, true);
    // An inbox that cannot be read (here: a file where the directory belongs)
    // yields no hook count, so the dashboard view must not report the gap settled.
    const inbox = path.join(root, '.keep', 'background-jobs', 'claude', 'parent', 'inbox');
    fs.rmSync(inbox, { recursive: true, force: true }); fs.writeFileSync(inbox, '');
    assert.equal(jobs.read(root, 'claude', 'parent', 2300).gapSettled, false, 'an unreadable inbox fails closed');
    fs.rmSync(inbox); fs.mkdirSync(inbox);
    assert.equal(jobs.read(root, 'claude', 'parent', 2300).gapSettled, true);

    const settled = load();
    assert.equal(jobs.settledGap(settled, { unconsumedHooks: 0 }), true);
    assert.equal(jobs.settledGap(settled), false, 'an uncounted inbox never yields a settled verdict');
    assert.equal(jobs.settledGap(settled, { unconsumedHooks: 1 }), false);
    for (const patch of [
      { jobs: { 'job:open': { id: 'open', kind: 'command', status: 'pending', eventAt: 2000 } } },
      { calls: { 'call:open': { at: 2000 } } },
      { gapReason: 'checkpoint-anchor' },
      { gapReason: undefined },
      { gap: false },
      { recovering: true },
      { coldReplay: { startedAt: 2000, fromIdentity: 'x' } },
      { restart: { ...settled.restart, completed: false } },
      { restart: { ...settled.restart, completed: false, rateLimitTerminal: true } },
      { restart: { ...settled.restart, completed: false, rateLimitTerminal: false } },
      { restart: undefined },
    ]) assert.equal(jobs.settledGap({ ...settled, ...patch }, { unconsumedHooks: 0 }), false,
      `a settled gap is refused by ${Object.keys(patch)[0]}`);
    // A turn the API ended with a terminal per-model rate limit never records a
    // completion, so callers that already accept that end state ask for it here.
    const limited = { ...settled, restart: { ...settled.restart, completed: false, rateLimitTerminal: true } };
    assert.equal(jobs.settledGap(limited, { unconsumedHooks: 0, allowTerminalRateLimit: true }), true);
    assert.equal(jobs.settledGap(limited, { unconsumedHooks: 1, allowTerminalRateLimit: true }), false);
    assert.equal(jobs.settledGap({ ...limited, restart: { ...limited.restart, rateLimitTerminal: false } },
      { unconsumedHooks: 0, allowTerminalRateLimit: true }), false, 'only a terminal rate limit stands in for a completion');
    assert.equal(jobs.settledGap({ ...limited, recovering: true }, { unconsumedHooks: 0, allowTerminalRateLimit: true }), false);
    assert.equal(jobs.settledGap({ ...limited, gapReason: 'checkpoint-anchor' }, { unconsumedHooks: 0, allowTerminalRateLimit: true }), false);
    // A process killed mid-turn never records a completion either; a caller that
    // verified the process exited may drop only that requirement.
    const killed = { ...settled, restart: { ...settled.restart, completed: false, rateLimitTerminal: false } };
    assert.equal(jobs.settledGap(killed, { unconsumedHooks: 0 }), false);
    assert.equal(jobs.settledGap(killed, { unconsumedHooks: 0, allowUnfinishedTurn: true }), true);
    assert.equal(jobs.settledGap({ ...killed, restart: undefined }, { unconsumedHooks: 0, allowUnfinishedTurn: true }), true);
    for (const patch of [
      { jobs: { 'job:open': { id: 'open', kind: 'command', status: 'pending', eventAt: 2000 } } },
      { calls: { 'call:open': { at: 2000 } } },
      { gapReason: 'checkpoint-anchor' },
      { recovering: true },
    ]) assert.equal(jobs.settledGap({ ...killed, ...patch }, { unconsumedHooks: 0, allowUnfinishedTurn: true }), false,
      `an unfinished turn is still refused by ${Object.keys(patch)[0]}`);
    assert.equal(jobs.settledGap(killed, { unconsumedHooks: 1, allowUnfinishedTurn: true }), false);
    assert.equal(jobs.read(root, 'claude', 'parent', 2300).gapSettledIfExited, true);
    assert.equal(jobs.settledGap({ ...settled, jobs: {
      'job:done': { id: 'done', kind: 'command', status: 'completed', eventAt: 2000 },
      'job:svc': { id: 'svc', kind: 'service', status: 'pending', eventAt: 2000 },
      'job:cron': { id: 'cron', kind: 'scheduled', status: 'pending', eventAt: 2000 },
    } }, { unconsumedHooks: 0 }), true, 'terminal, service and scheduled jobs are not open work');

    fs.copyFileSync(source, target);
    const request = { root, agent: 'claude', sid: 'parent', sourceFile: source, targetFile: target,
      transactionId: 'tx-settled', sourceStopVerifiedAt: 1 };
    assert.equal(jobs.rebindSource(request).reused, false);
    const after = load();
    assert.equal(after.gap, true, 'the gap is carried into the rebound state unchanged');
    assert.equal(after.gapReason, 'transcript-replaced');
    assert.equal(after.source.file, path.resolve(target));
    assert.deepEqual(after.jobs, settled.jobs);

    const unsettled = load(); unsettled.gapReason = 'checkpoint-anchor';
    fs.writeFileSync(snapshot, JSON.stringify(unsettled));
    assert.throws(() => jobs.rebindSource({ ...request, transactionId: 'tx-unsettled' }),
      /job ledger evidence is incomplete/);

    // The same ledger whose turn the API cut off rebinds only for a caller that
    // accepts that end state, and never for one that does not.
    // `settled` is the pre-rebind snapshot, so its checkpoint still names the source.
    const limitedState = { ...settled, restart: { ...settled.restart, completed: false, rateLimitTerminal: true } };
    const restore = () => fs.writeFileSync(snapshot, JSON.stringify(limitedState));
    restore();
    assert.throws(() => jobs.rebindSource({ ...request, transactionId: 'tx-limited' }),
      /job ledger evidence is incomplete/);
    restore();
    assert.equal(jobs.rebindSource({ ...request, transactionId: 'tx-limited', allowTerminalRateLimit: true }).reused, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('missing resume, ungrounded prompt, prior gaps, and transcript read errors stay fail closed', () => {
  const lifecycle = require('./session-lifecycle');
  const scenarios = [
    { name: 'resume', events: [{ hook_event_name: 'SessionStart', source: 'resume' }] },
    { name: 'prompt', events: [{ hook_event_name: 'UserPromptSubmit' }] },
  ];
  for (const scenario of scenarios) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `keep-jobs-${scenario.name}-`));
    const file = path.join(root, 'parent.jsonl');
    try {
      for (const event of scenario.events) lifecycle.record(root,
        { session_id: 'parent', agentKind: 'claude', transcript_path: file, ...event }, 1000);
      const missing = jobs.sync({ root, agent: 'claude', sid: 'parent', file, now: 1100 });
      assert.equal(missing.recovering, true);
      assert.equal(missing.gap, true);

      fs.writeFileSync(file, JSON.stringify({ type: 'assistant', sessionId: 'parent', timestamp: new Date(1200).toISOString(),
        message: { content: [], stop_reason: 'end_turn' } }) + '\n');
      lifecycle.record(root, { session_id: 'parent', agentKind: 'claude', transcript_path: file,
        hook_event_name: 'SessionStart', source: 'startup' }, 1200);
      const later = jobs.sync({ root, agent: 'claude', sid: 'parent', file, now: 1300 });
      assert.equal(later.recovering, false);
      assert.equal(later.gap, true, `${scenario.name} evidence cannot be migrated into a clean startup`);
      assert.throws(() => require('./restart-ledger').verify({ root, agent: 'claude', sid: 'parent', file,
        instance: { id: 'pane:1:2', since: 1, live: true } }), /incomplete/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-jobs-read-error-'));
  const file = path.join(root, 'parent.jsonl');
  try {
    fs.mkdirSync(file);
    const result = jobs.sync({ root, agent: 'claude', sid: 'parent', file, now: 1000 });
    assert.equal(result.recovering, true);
    assert.ok(result.uncertain.includes('history-recovery'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('bounded bootstrap and oversized records never claim complete recovery', () => fixture(({ file, append, sync }) => {
  launch(append);
  append({ type: 'assistant', message: { content: 'x'.repeat(5000) } });
  let s;
  for (let i = 0; i < 30; i++) { s = sync({ budget: 1024, maxRecord: 1024 }); if (!s.recovering) break; }
  assert.equal(s.recovering, false);
  assert.equal(s.gap, true);
  assert.ok(s.uncertain.includes('history-gap'));
  assert.ok(fs.statSync(file).size > 5000);
}));

test('oversized-record skipping continues at the normal budget and recovers later completions', () => fixture(({ append, sync }) => {
  launch(append);
  append({ type: 'assistant', message: { content: 'x'.repeat(25000) } });
  done(append);
  let result;
  for (let i = 0; i < 40; i++) { result = sync({ budget: 1024, maxRecord: 8192 }); if (!result.recovering) break; }
  assert.equal(result.recovering, false);
  assert.equal(result.gap, true);
  assert.equal(result.jobs.find(j => j.id === 'j').status, 'completed');
}));

test('durable hooks survive downtime; stop requires corroborated child completion', () => fixture(({ root, sync }) => {
  jobs.recordHook(root, 'claude', 'parent', { event: 'SubagentStart', entity: 'child', at: 90000, offset: 0 });
  jobs.recordHook(root, 'claude', 'parent', { event: 'SubagentStop', entity: 'child', at: 91000, offset: 0 });
  assert.equal(sync().pending, true);
  assert.equal(sync({ inspectAgent: () => null, now: 2000000 }).pending, false);
  const s = sync({ inspectAgent: () => ({ at: 95000, done: true }) });
  assert.equal(s.jobs[0].status, 'completed');
  assert.equal(s.jobs[0].evidence, 'child-transcript');
}));

test('known services are recorded but do not block next instructions', () => fixture(({ append, sync }) => {
  launch(append);
  const s = sync({ classify: () => 'service' });
  assert.equal(s.pending, false); assert.deepEqual(s.uncertain, []);
  assert.equal(s.jobs[0].kind, 'service');
}));

test('process-scoped recovery leaves legacy ownership unknown and preserves old obligations on ID reuse', () => fixture(({ append, sync }) => {
  launch(append, 'legacy', 'old');
  const first = { id: 'pane:10:11', processScoped: true, live: true };
  assert.equal(sync({ instance: first }).jobs[0].instance, null);
  launch(append, 'live', 'one');
  assert.equal(sync({ instance: first }).jobs.find(j => j.id === 'live').instance, first.id);
  const second = { ...first, id: 'pane:10:12' };
  sync({ instance: second });
  launch(append, 'live', 'two');
  const s = sync({ instance: second });
  assert.equal(s.jobs.find(j => j.id === 'live').instance, second.id);
  assert.ok(s.jobs.some(j => j.id.startsWith('superseded_') && j.status === 'pending' && j.instance === first.id));
  done(append, 'live');
  assert.ok(sync({ instance: second }).uncertain.some(id => id.startsWith('superseded_')));
}));

test('ID reuse before process observation preserves the unknown prior run', () => fixture(({ append, sync }) => {
  const first = { id: 'pane:10:11', processScoped: true, live: true };
  sync({ instance: first });
  launch(append, 'reused', 'old'); sync({ instance: first });
  launch(append, 'reused', 'new');
  const second = { ...first, id: 'pane:10:12' };
  sync({ instance: second });
  done(append, 'reused');
  assert.ok(sync({ instance: second }).jobs.some(j => j.id.startsWith('superseded_') && j.status === 'pending'));
}));

test('unknown-owner recovery cannot overwrite an unresolved reused ID', () => fixture(({ append, sync }) => {
  launch(append, 'reused', 'old'); sync({ instance: null });
  launch(append, 'reused', 'new'); done(append, 'reused');
  assert.ok(sync({ instance: null }).uncertain.some(id => id.startsWith('superseded_')));
}));

test('upgrading process identity cannot silently cancel an existing live cron', () => fixture(({ root, append, sync }) => {
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'cron', name: 'CronCreate', input: {} }] } });
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'cron', content: 'Scheduled recurring job tick (* * * * *).' }] } });
  const first = { id: 'pane:10:11', processScoped: true, live: true };
  sync({ instance: { id: 'pane:10:old-shell-time', since: 1, live: true } });
  const snapshot = path.join(root, '.keep/background-jobs/claude/parent/state.json');
  const old = JSON.parse(fs.readFileSync(snapshot)); delete old.restartVersion; fs.writeFileSync(snapshot, JSON.stringify(old));
  assert.equal(sync({ instance: first }).jobs[0].status, 'pending');
  assert.equal(sync({ instance: { ...first, id: null } }).jobs[0].status, 'pending');
  assert.equal(sync({ instance: { ...first, id: 'pane:10:12' } }).jobs[0].status, 'pending', 'legacy ownership is unknown, not proof of process death');
}));

test('Codex yielded terminal job completes only on its matching poll result', () => fixture(({ append, sync }) => {
  const call = (id, name, input) => append({ type: 'response_item', payload: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(input) } });
  const result = (id, output) => append({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: JSON.stringify(output) } });
  call('start', 'functions.exec_command', { cmd: 'SECRET' }); result('start', { session_id: 123 });
  assert.equal(sync().pending, true);
  call('other', 'functions.write_stdin', { session_id: 456 }); result('other', { exit_code: 0 });
  assert.equal(sync().pending, true);
  call('poll', 'functions.write_stdin', { session_id: 123 }); result('poll', { exit_code: 0 });
  assert.equal(sync().pending, false);
}, 'codex'));

test('Codex native completion resolves code-mode commands before a delayed launch response', () => fixture(({ append, sync }) => {
  append({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'wrapper', name: 'functions.exec', input: 'text(await tools.exec_command({cmd:"true"}))' } });
  append({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-id', process_id: '123', status: 'completed', exit_code: 0 } } });
  append({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'wrapper', output: [{ type: 'input_text', text: '{"session_id":123}' }] } });
  const state = sync();
  assert.equal(state.pending, false);
  assert.equal(state.jobs[0].id, 'process_123');
  assert.equal(state.jobs[0].status, 'completed');
}, 'codex'));

test('Codex fresh launches can reuse terminal process and cell IDs, but polls cannot revive them', () => fixture(({ append, sync }) => {
  const call = (id, name, input) => append({ type: 'response_item', payload: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(input) } });
  const result = (id, output) => append({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output } });
  for (const [id, launchName, pollName, field, output, completed] of [
    ['123', 'exec_command', 'write_stdin', 'session_id', '{"session_id":123}', '{"exit_code":0}'],
    ['abc', 'exec', 'wait', 'cell_id', 'Script running with cell ID abc', 'Script completed'],
  ]) {
    call('first-' + id, launchName, {}); result('first-' + id, output);
    call('finish-' + id, pollName, { [field]: id }); result('finish-' + id, completed);
    assert.equal(sync().pending, false);
    call('late-poll-' + id, pollName, { [field]: id }); result('late-poll-' + id, output);
    assert.equal(sync().pending, false);
    call('new-' + id, launchName, {}); result('new-' + id, output);
    assert.equal(sync().pending, true);
    call('new-finish-' + id, pollName, { [field]: id }); result('new-finish-' + id, completed);
    assert.equal(sync().pending, false);
  }
}, 'codex'));

test('Codex parent-side child completion does not become a new launch', () => fixture(({ append, sync }) => {
  append({ type: 'event_msg', payload: { item: { type: 'SubAgentActivity', kind: 'started', id: 'launch', agent_thread_id: 'child' } } });
  append({ type: 'event_msg', payload: { item: { type: 'SubAgentActivity', kind: 'completed', id: 'notice', agent_thread_id: 'child' } } });
  const r = sync({ inspectAgent: () => ({ at: 100000, done: true }) });
  assert.equal(r.pending, false); assert.equal(r.jobs[0].status, 'completed');
}, 'codex'));

test('collecting a completed cell cannot revive a process from its buffered launch result', () => fixture(({ append, sync }) => {
  append({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'launch', name: 'functions.exec', input: 'text(await tools.exec_command({cmd:"sleep 2"}))' } });
  append({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'launch', output: 'Script running with cell ID abc' } });
  append({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'native', process_id: '123', status: 'completed', exit_code: 0 } } });
  append({ type: 'response_item', payload: { type: 'function_call', call_id: 'collect', name: 'functions.wait', arguments: '{"cell_id":"abc"}' } });
  append({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'collect', output: [{ type: 'input_text', text: 'Script completed' }, { type: 'input_text', text: '{"session_id":123}' }] } });
  const r = sync();
  assert.equal(r.pending, false);
  assert.equal(r.jobs.length, 2);
  assert.ok(r.jobs.every(j => j.status === 'completed'));
}, 'codex'));

test('single nested Codex polls correlate while multi-call output is not guessed', () => fixture(({ append, sync }) => {
  const call = (id, input) => append({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: id, name: 'functions.exec', input } });
  const result = (id, value) => append({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id, output: value.split('\n').map(text => ({ type: 'input_text', text })) } });
  call('start', 'text(await tools.exec_command({cmd:"sleep 1"}))'); result('start', 'Script completed\n{"session_id":123}');
  call('ambiguous', 'text(await tools.write_stdin({session_id:123}));text(await tools.exec_command({cmd:"true"}));');
  result('ambiguous', 'Script completed\n{"exit_code":0}'); assert.equal(sync().jobs.find(j=>j.id==='process_123').status, 'pending');
  call('poll', 'text(await tools.write_stdin({session_id:123}))'); result('poll', 'Script completed\n{"exit_code":0}');
  assert.equal(sync().jobs.find(j=>j.id==='process_123').status, 'completed');
}, 'codex'));

test('legacy code-mode result variables preserve poll ownership and reject transformations', () => {
  const { polls } = require('./code-mode-polls');
  for (const print of ['text(r)', 'text(JSON.stringify(r))']) {
    assert.deepEqual(polls(`const r = await tools.write_stdin({session_id:123}); ${print};`),
      [{ index: 1, name: 'write_stdin', target: '123', count: 1 }]);
  }
  assert.deepEqual(polls('text(await tools.write_stdin({session_id:123})); const r = await tools.ci({}); text(r.structuredContent ?? r);'),
    [{ index: 1, name: 'write_stdin', target: '123', count: 2 }]);
  assert.deepEqual(polls('const results = await Promise.all([tools.write_stdin({session_id:123}), tools.exec_command({cmd:"true"})]); for (const x of results) text(x);'),
    [{ index: 1, name: 'write_stdin', target: '123', count: 2 }]);
  for (const code of [
    'const r = await tools.write_stdin({session_id:123}); text(r.output);',
    'const r = await tools.write_stdin({session_id:123}); text(r.structuredContent ?? r);',
    'const r = await tools.write_stdin({session_id:123}); r.exit_code = 0; text(r);',
    'const r = await tools.write_stdin({session_id:123}); text(r); text(r);',
    'const JSON = await tools.ci({}); const r = await tools.write_stdin({session_id:123}); text(JSON.stringify(r));',
    'text(await tools.write_stdin({session_id:123})); for (;;) {}',
  ]) assert.deepEqual(polls(code), [], code);
});

test('poll migration clears only replay-proven legacy obligations and keeps unknown work', () => fixture(({ root, append, sync }) => {
  const call = (id, input) => append({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: id, name: 'exec', input } });
  const result = (id, obj) => append({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id,
    output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' }, { type: 'input_text', text: JSON.stringify(obj) }] } });
  call('launch', 'text(await tools.exec_command({cmd:"sleep 1"}))'); result('launch', { session_id: 123 });
  call('poll', 'const r = await tools.write_stdin({session_id:123}); text(JSON.stringify(r));'); result('poll', { session_id: 123 });
  call('finish', 'const r = await tools.write_stdin({session_id:123}); text(JSON.stringify(r));'); result('finish', { exit_code: 0 });
  sync();
  const file = path.join(root, '.keep/background-jobs/codex/parent/state.json');
  const state = JSON.parse(fs.readFileSync(file));
  const hash = require('crypto').createHash('sha256').update('process_123:launch').digest('hex').slice(0, 24);
  const id = `superseded_${hash}`;
  state.jobs[`job:${id}`] = { id, kind: 'unknown', status: 'pending', run: 'launch', eventAt: 1 };
  state.jobs['job:unknown'] = { id: 'unknown', kind: 'unknown', status: 'pending', run: 'unseen', eventAt: 1 };
  state.pollVersion = 1; // Previous deployed parser must replay with the new mapper.
  fs.writeFileSync(file, JSON.stringify(state));
  const replay = sync();
  assert.ok(!replay.jobs.some(j => j.id === id));
  assert.ok(replay.jobs.some(j => j.id === 'unknown' && j.status === 'pending'));
  assert.equal(replay.jobs.find(j => j.id === 'process_123').status, 'completed');
  assert.equal(sync().bytesRead, 0);
}, 'codex'));

test('labelled poll replay clears superseded launches and poll copies, not unrelated obligations', () => fixture(({ root, append, sync }) => {
  const call = (id, input) => append({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: id, name: 'exec', input } });
  const output = (id, pieces) => append({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id,
    output: ['Script completed\nOutput:\n', ...pieces].map(text => ({ type: 'input_text', text })) } });
  call('start', 'text(await tools.exec_command({cmd:"sleep 1"}));'); output('start', ['{"session_id":123}']);
  const code = 'const r=await Promise.all([tools.write_stdin({session_id:123}),tools.exec_command({cmd:"true"})]);for(let i=0;i<r.length;i++){text(`---${i+1}---`);text(r[i]);}';
  call('poll', code); output('poll', ['---1---', '{"session_id":123}', '---2---', '{"exit_code":0}']);
  call('end', code); output('end', ['---1---', '{"exit_code":0}', '---2---', '{"exit_code":0}']);
  sync();
  const file = path.join(root, '.keep/background-jobs/codex/parent/state.json');
  const state = JSON.parse(fs.readFileSync(file));
  for (const run of ['start', 'poll']) {
    const id = 'superseded_' + require('crypto').createHash('sha256').update(`process_123:${run}`).digest('hex').slice(0, 24);
    state.jobs[`job:${id}`] = { id, run, status: 'pending', kind: 'unknown', eventAt: 1 };
  }
  state.pollVersion = 1;
  fs.writeFileSync(file, JSON.stringify(state));
  let replay;
  for (let i = 0; i < 100; i++) { replay = sync({ budget: 100 }); if (!replay.recovering) break; }
  assert.equal(replay.recovering, false);
  assert.equal(replay.gap, false);
  assert.deepEqual(replay.jobs.filter(j => j.status === 'pending'), []);
}, 'codex'));

test('a Promise.all(ids.map) poll printed through forEach clears the launches it polls', () => fixture(({ root, append, sync }) => {
  const call = (id, input) => append({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: id, name: 'exec', input } });
  const output = (id, objects) => append({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id,
    output: ['Script completed\nOutput:\n', ...objects.map(o => JSON.stringify(o))].map(text => ({ type: 'input_text', text })) } });
  call('launch', 'const r=await Promise.allSettled([tools.exec_command({cmd:"a"}),tools.exec_command({cmd:"b"})]);r.forEach((x,i)=>text(JSON.stringify({i,...x.value})));');
  output('launch', [{ i: 0, session_id: 11 }, { i: 1, session_id: 22 }]);
  const poll = ids => `const ids=${JSON.stringify(ids)}; const rs=await Promise.all(ids.map(session_id=>tools.write_stdin({session_id,chars:"",yield_time_ms:1000}))); rs.forEach((r,i)=>text(JSON.stringify({i,...r})));`;
  call('poll', poll([11, 22])); output('poll', [{ i: 0, session_id: 11 }, { i: 1, exit_code: 0 }]);
  call('end', poll([11])); output('end', [{ i: 0, exit_code: 0 }]);
  const settled = sync();
  assert.deepEqual(settled.jobs.filter(j => j.status === 'pending'), []);
  assert.deepEqual(settled.jobs.map(j => `${j.id}:${j.status}`).sort(), ['process_11:completed', 'process_22:completed']);
  // A ledger written by the previous parser replays once and drops its superseded copies.
  const file = path.join(root, '.keep/background-jobs/codex/parent/state.json');
  const state = JSON.parse(fs.readFileSync(file));
  const id = 'superseded_' + require('crypto').createHash('sha256').update('process_11:launch').digest('hex').slice(0, 24);
  state.jobs[`job:${id}`] = { id, run: 'launch', status: 'pending', kind: 'unknown', eventAt: 1 };
  state.pollVersion = 2;
  fs.writeFileSync(file, JSON.stringify(state));
  let replay;
  for (let i = 0; i < 100; i++) { replay = sync({ budget: 200 }); if (!replay.recovering) break; }
  assert.deepEqual(replay.jobs.filter(j => j.status === 'pending'), []);
}, 'codex'));

test('printed job examples inside stdout never create background jobs', () => fixture(({ append, sync }) => {
  append({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'read', output: [
    { type: 'input_text', text: 'Script completed\nOutput:\n' },
    { type: 'input_text', text: JSON.stringify({ exit_code: 0, output: 'Script running with cell ID 4\n{"session_id":123}' }) },
  ] } });
  assert.deepEqual(sync().jobs, []);
}, 'codex'));

test('referrer verification handoff recognizes a live cron through the production runtime identity', () => fixture(({ root, append, sync, now }) => {
  const { attachRuntime } = require('./session-model');
  const { attention } = require('./session-status');
  const pane = { id: 'fa942244', pid: 62523, agentPid: 62523, alive: true,
    createdAt: new Date(now()).toISOString(), meta: { sessionId: 'parent' } };
  const instance = { id: jobs.processInstance(pane), processScoped: true, live: true };
  sync({ instance }); // Observe the process before its cron is created.
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'cron', name: 'CronCreate', input: {} }] } });
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'cron', content: 'Scheduled recurring job poll (7,27,47 * * * *).' }] } });
  append({ type: 'user', message: { content: 'that looks fine, just notify me when it changes' } });
  const lastUserAt = now();
  const lastAssistantFull = 'Already set up that way — the cron pushes a notification to your phone the moment the state deviates from baseline (review finishes, or anything rejection/policy shaped), captures the page state for the skill work, and stops polling. Baseline ticks stay silent apart from the one-line note here.\n\nNothing else needed from you until that fires.';
  append({ type: 'assistant', message: { content: [{ type: 'text', text: lastAssistantFull }], stop_reason: 'end_turn' } });
  sync({ instance });
  const session = { id: 'parent', kind: 'claude', endedTurn: true, lastUserAt, lastAssistantFull,
    taskStatus: 'review', backgroundJobs: jobs.read(root, 'claude', 'parent', now()) };
  const observe = (patch = {}, currentPane = pane, at = now()) => {
    const current = { ...session, ...patch };
    attachRuntime([current], [currentPane]);
    return activity(current, { now: at });
  };
  const waiting = observe();
  assert.equal(waiting.label, 'Waiting: scheduled check');
  assert.equal(waiting.background.scheduled[0].id, 'cron_poll');
  assert.equal(attention({ ...session, activity: waiting }), null);
  assert.equal(observe({ lastAssistantFull: 'Should I change the poll?' }).needsInput, true);
  assert.equal(observe({ lastAssistantFull: 'Here is my proposal.' }).needsInput, true);
  assert.equal(observe({ endedTurn: false }).state, 'running');
  assert.equal(observe({}, { ...pane, agentPid: 62524 }).needsInput, true, 'replacement agent cannot inherit a cron');
  assert.equal(observe({}, { ...pane, agentPid: null }).needsInput, true, 'unverified agent cannot inherit a cron');
  assert.equal(observe({}, { ...pane, alive: false }).state, 'exited');
  assert.equal(observe({}, pane, now() + 8 * 86400e3).needsInput, true, 'expired cron cannot keep a session waiting');
  append({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'cancel', name: 'CronDelete', input: { id: 'poll' } }] } });
  append({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'cancel', content: 'Cancelled job poll.' }] } });
  sync({ instance });
  assert.equal(observe({ backgroundJobs: jobs.read(root, 'claude', 'parent', now()) }).needsInput, true);
}));

test('a node mirror reset to the same size, mtime and last bytes still reads as a replaced transcript', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-jobs-mirror-reset-'));
  try {
    const mirror = require('./transcript-mirror');
    const sid = 'mirrored';
    const file = mirror.paths(root, 'workera', sid).file;
    const tail = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'the same ending, longer than the 64-byte anchor' }] } }) + '\n';
    const body = (text) => Buffer.from(JSON.stringify({ type: 'user', message: { content: text } }) + '\n' + tail);
    const post = (generation, bytes) => mirror.append({ root, node: 'workera', sessionId: sid, generation, fromOffset: 0,
      size: bytes.length, mtimeMs: 1_700_000_000_000, sourcePath: '/node/transcript.jsonl', bytes });
    const first = body('first earlier record'), second = body('other earlier record');
    assert.equal(first.length, second.length);
    assert.equal(post('1:1:1', first).ok, true);
    const sync = () => jobs.sync({ root, agent: 'claude', sid, file, node: 'workera', now: 1000 });
    assert.equal(sync().gap, false);
    assert.equal(post('2:2:2', second).reset, true);
    const stat = fs.statSync(file);
    assert.equal(stat.size, first.length);
    assert.equal(Math.round(stat.mtimeMs), 1_700_000_000_000);
    const replaced = sync();
    assert.equal(replaced.gap, true);
    assert.equal(replaced.gapReason, 'transcript-replaced');
    const saved = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'background-jobs', 'claude', sid, 'state.json'), 'utf8'));
    assert.equal(saved.source.file, file);
    assert.equal(saved.source.node, 'workera', 'the persisted source names the node');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
