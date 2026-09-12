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

test('partial lines retry without advancing and truncated transcripts retain unresolved jobs', () => fixture(({ file, append, sync }) => {
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
    const before = JSON.parse(fs.readFileSync(path.join(root, '.keep/background-jobs/claude/parent/state.json')));

    const rebound = jobs.rebindSource({ root, agent: 'claude', sid: 'parent', sourceFile: source, targetFile: target,
      transactionId: 'tx-a-b', sourceStopVerifiedAt: 1 });
    assert.equal(rebound.reused, false);
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
