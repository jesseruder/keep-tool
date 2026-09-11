const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { activity, attention } = require('./session-status');
const { scanTranscript, sessionBackgroundPending } = require('./serve');
const { scanRollout } = require('./codex');

test('permission notifications remain visible despite newer non-input hook hints', () => {
  for (const state of ['running', 'waiting']) {
    const session = { id: 'session', notify: { type: 'permission', message: 'Allow network?' }, lifecycleForeground: { state, reason: 'tool activity' } };
    assert.equal(activity(session).reason, 'permission');
    assert.equal(attention(session).kind, 'permission');
  }
});

test('an approval question in the final turn beats landing and dependency status', () => {
  const session = { id: 'session', pane: 'pane', endedTurn: true, taskStatus: 'landing', lastAssistantFull: 'Reviewed. May I land this commit?' };
  assert.equal(activity(session).state, 'needs-input');
  assert.equal(activity(session).label, 'Needs an answer');
  assert.equal(attention(session).detail, 'Reviewed. May I land this commit?');
  assert.equal(activity({ ...session, pendingBackground: true }).needsInput, true);
  assert.equal(activity({ ...session, taskStatus: 'waiting' }, { dependencies: ['other'] }).needsInput, true);
  assert.equal(activity({ ...session, endedTurn: false }).state, 'running');
});

const session = { id: 's', kind: 'claude', endedTurn: true, mtime: 1 };

test('a structured scheduling handoff yields only its own turn and schedule, for both agents', () => {
  for (const kind of ['claude', 'codex']) {
    const current = { id: 's', kind, pane: 'p', endedTurn: true, lastUserAt: 1000, turnStartedAt: 2000,
      lastAssistantFull: 'Still healthy: two ready production hosts. Recorded in Keep; next check in ten minutes.' };
    const task = { id: 'probe', status: 'waiting', check_after: '2099-01-01', check: 'probe', scheduled_by: 's',
      scheduled_at: new Date(2500).toISOString(), scheduled_for: '2099-01-01', scheduled_intent: 'waiting' };
    const context = { task, now: 3000 };
    assert.equal(activity(current, context).label, 'Waiting: scheduled check');
    assert.equal(activity(current, context).decision.confidence, 'observed');
    assert.equal(activity({ ...current, endedTurn: false }, context).state, 'running');
    assert.equal(activity({ ...current, turnStartedAt: 2700 }, context).needsInput, true, 'automated turns also invalidate an earlier handoff');
    assert.equal(activity({ ...current, lastUserAt: 2700 }, context).needsInput, true);
    assert.equal(activity({ ...current, lifecycleTurnAt: 2700 }, context).needsInput, true);
    assert.equal(activity({ ...current, lastAssistantFull: 'Should I change the rollout?' }, context).needsInput, true);
    assert.equal(activity({ ...current, lifecycleStop: { at: 2800, intent: 'needs-input' } }, context).needsInput, true);
    assert.equal(activity({ ...current, turnStartedAt: undefined }, context).needsInput, true, 'an unknown turn cannot revive an older schedule');
    assert.equal(activity({ ...current, turnStartedAt: undefined, backgroundJobs: { jobs: [], caughtUp: true, turnStartedAt: 2700 } }, context).needsInput, true);
    for (const patch of [{ scheduled_by: 'other' }, { scheduled_for: 'different' }, { check_after: '' }, { status: 'done' }, { scheduled_intent: 'needs-input' }]) {
      assert.equal(activity(current, { ...context, task: { ...task, ...patch } }).needsInput, true, JSON.stringify(patch));
    }
  }
});

test('both adapters track automated turn starts separately from human input', () => {
  const t = '2026-09-09T20:00:00Z';
  transcript([{ type: 'user', timestamp: t, message: { content: '[keep] scheduled check due' } }], file => {
    const info = scanTranscript(file); assert.equal(info.turnStartedAt, Date.parse(t)); assert.equal(info.lastUserAt, null);
  });
  transcript([{ type: 'session_meta', payload: { id: 's', source: 'cli' } },
    { type: 'event_msg', timestamp: t, payload: { type: 'task_started' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'large', output: 'x'.repeat(300000) } },
    { type: 'event_msg', payload: { type: 'task_complete' } }], file => assert.equal(scanRollout(file).turnStartedAt, Date.parse(t)));
});

test('conversation readiness and registry obligations coexist across user turns', () => {
  for (const kind of ['claude', 'codex']) {
    const base = { id: 's', kind, pane: 'p', endedTurn: true, lastUserAt: 1000, lastAssistant: 'Here is the proposed fix.', taskStatus: 'waiting' };
    const context = { task: { status: 'waiting', check_after: '2099-01-01' }, dependencies: ['deploy'] };
    assert.equal(activity(base, context).reason, 'next instruction');
    assert.equal(activity(base, context).background.checkAfter, '2099-01-01');
    assert.equal(activity({ ...base, lastAssistant: 'Waiting for the deploy.' }, context).state, 'waiting');
    assert.equal(activity({ ...base, endedTurn: false, lastUserAt: 2000 }, context).state, 'running');
    assert.equal(activity({ ...base, lastUserAt: 2000 }, context).state, 'needs-input');
    assert.equal(activity({ ...base, taskStatus: 'review' }).reason, 'next instruction');
    assert.equal(activity({ ...base, attentionAt: 3000, lifecycleStop: { at: 2000, intent: 'waiting' }, lastAssistant: 'Should I change it?' }, context).needsInput, true);
    assert.equal(activity({ ...base, pendingBackground: true, backgroundJobs: { jobs: [], caughtUp: false }, lastAssistant: 'Build is running in the background.' }).state, 'waiting');
  }
});

test('process-scoped recurring poll waits only when the current turn yields to it', () => {
  const base = { id: 's', kind: 'claude', endedTurn: true, runtime: { state: 'live', instance: 'p:1' }, lastUserAt: 1000,
    lastAssistant: "I'll keep watching for the review.", backgroundJobs: { jobs: [{ id: 'cron_job', kind: 'scheduled', recurring: true, status: 'pending', instance: 'p:1', expiresAt: 10000 }] } };
  assert.equal(activity(base, { now: 2000 }).label, 'Waiting: scheduled check');
  assert.equal(activity({ ...base, lastAssistant: 'Should I change the rollout?' }, { now: 2000 }).needsInput, true);
  assert.equal(activity({ ...base, lastAssistant: 'Here is my proposal.' }, { now: 2000 }).needsInput, true);
  assert.equal(activity({ ...base, endedTurn: false }, { now: 2000 }).state, 'running');
  assert.equal(activity(base, { now: 11000 }).needsInput, true);
  assert.equal(activity({ ...base, runtime: { state: 'live', instance: 'p:2' } }, { now: 2000 }).needsInput, true);
});

test('a finished unattached session is not resurrected as a duplicate input request', () => {
  const completed = {
    ...session, title: 'Codex sessions disappearance in sandbox repo', pane: null,
    alive: true, taskStatus: 'done', taskId: 'example-regression-30',
    lastAssistantFull: 'Both features are built, reviewed, verified in the browser, and pushed.',
    notify: { type: 'waiting' },
  };
  assert.equal(attention(completed), null);
  assert.equal(activity(completed).state, 'done');
  assert.equal(attention({ ...completed, pendingQuestion: { question: 'Approve the next change?' } }).kind, 'question',
    'an unattached terminal must not hide a real unanswered question');
});

test('historical idle, completed, rate-limited and background work never imply human input', () => {
  for (const kind of ['claude', 'codex']) {
    for (const extra of [
      {}, { notify: { type: 'complete' } }, { notify: { type: 'waiting' } },
      { taskId: 't', taskStatus: 'done' }, { taskId: 't', taskStatus: 'active' },
      { rateLimit: {} }, { pendingBackground: true, lastAssistant: 'Waiting for the review.' },
    ]) assert.equal(attention({ ...session, kind, ...extra }), null, JSON.stringify(extra));
  }
});

test('live stopped sessions need a next instruction without a prose question', () => {
  for (const kind of ['claude', 'codex']) {
    const stopped = { ...session, kind, taskStatus: 'active', lastAssistant: 'Reload Keep once with Cmd-R.' };
    for (const live of [{ ...stopped, pane: 'pane' }, { ...stopped, pane: 'pane', alive: true }]) {
      assert.equal(activity(live).reason, 'next instruction');
      assert.equal(attention(live).kind, 'input');
      assert.equal(attention({ ...live, endedTurn: false }), null);
      assert.equal(attention({ ...live, toolRunning: true }), null);
      assert.equal(attention({ ...live, reviewer: true }), null);
      assert.equal(attention({ ...live, exited: true }), null);
      assert.equal(attention({ ...live, taskStatus: 'done' }).attentionLabel, 'Ready for next instruction');
      assert.equal(attention({ ...live, pendingBackground: true }), null);
      assert.equal(attention({ ...live, waitingFor: 'lock' }), null);
      assert.equal(attention(live, { task: { check_after: '2099-01-01' } }).kind, 'input');
      assert.equal(attention(live, { dependencies: ['rollout#6'] }).kind, 'input');
    }
    assert.equal(activity(stopped, { live: true }).reason, 'next instruction', 'host liveness works before panes are attached to response rows');
    assert.equal(attention({ ...stopped, pane: 'old', alive: false }), null);
    assert.equal(attention({ ...stopped, alive: true }), null, 'headless process liveness is not interactive readiness');
    assert.equal(attention({ ...stopped, pane: 'exited-pane', alive: null }, { live: false }), null,
      'authoritative host liveness overrides an old pane association');
  }
});

test('current work and waits override old prose requests', () => {
  for (const kind of ['claude', 'codex']) {
    const base = { ...session, kind, pane: 'p', taskStatus: 'done', askedProse: true, lastAssistantFull: 'Send me the URL.' };
    assert.equal(attention(base).attentionLabel, 'Needs an answer');
    for (const patch of [{ toolRunning: true }, { endedTurn: false }, { waitingFor: 'review' }]) {
      assert.equal(attention({ ...base, ...patch }), null);
    }
    assert.equal(attention({ ...base, pendingBackground: true }).kind, 'input', 'an ended turn asking for input can coexist with a job');
    assert.equal(activity({ ...base, pendingQuestion: { question: 'Which account?' }, pendingBackground: true }).needsInput, true,
      'an explicit pending question can coexist with background work');
  }
});

test('dismissal remains tied to conversation activity, not metadata or focus', () => {
  const { applySetAside, setAsideCandidates } = require('./serve');
  const base = { ...session, pane: 'p', taskStatus: 'done', attentionAt: 1000, mtime: 1000 };
  const store = { version: 1, items: { s: { kind: 'dismiss', at: 1100, since: 1000, until: null } } };
  for (const patch of [{ mtime: 2000, title: 'New title' }, { endedTurn: false, mtime: 2000 }, { pane: 'new-pane', mtime: 2000 }]) {
    const current = { ...base, ...patch };
    const item = attention(current);
    assert.ok(applySetAside(setAsideCandidates(item ? [item] : [], [current]), { store, now: 3000, write: false }).value.items.s);
  }
  const current = { ...base, attentionAt: 2000, mtime: 2000 };
  assert.equal(applySetAside(setAsideCandidates([attention(current)], [current]), { store, now: 3000, write: false }).value.items.s, undefined);
});

test('conversation timestamps ignore agent metadata records', () => {
  const at = '2026-09-09T20:00:00Z', later = '2026-09-09T21:00:00Z';
  transcript([
    { type: 'assistant', timestamp: at, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } },
    { type: 'ai-title', timestamp: later, title: 'New title' },
    { type: 'attachment', timestamp: later, attachment: { type: 'prompt_snapshot' } },
  ], (file) => assert.equal(scanTranscript(file).attentionAt, Date.parse(at)));
  transcript([
    { type: 'session_meta', payload: { session_id: 's', cwd: '/tmp' } },
    { type: 'event_msg', timestamp: at, payload: { type: 'task_complete' } },
    { type: 'event_msg', timestamp: later, payload: { type: 'token_count' } },
  ], (file) => assert.equal(scanRollout(file).attentionAt, Date.parse(at)));
});

test('a new human message cancels snooze, automated activity and focus do not', () => {
  const { applySetAside, setAsideCandidates } = require('./serve');
  const store = { version: 1, items: { s: { kind: 'snooze', at: 2000, since: 1000, until: 9000 } } };
  for (const endedTurn of [false, true]) {
    for (const lastUserAt of [1000, 3000]) {
      const current = { ...session, pane: 'p', endedTurn, lastUserAt, attentionAt: 4000, mtime: 5000 };
      const item = attention(current);
      const result = applySetAside(setAsideCandidates(item ? [item] : [], [current]), { store, now: 6000, write: false });
      assert.equal(Boolean(result.value.items.s), lastUserAt === 1000);
    }
  }
  const stalled = [{ kind: 'stalled', sessionId: 's', since: 1000 }];
  assert.equal(applySetAside(setAsideCandidates(stalled, [{ ...session, lastUserAt: 3000 }]), {
    store, now: 6000, write: false,
  }).value.items.s, undefined, 'a lagging stalled finding must not hide the resumed session');
});

test('Codex human input timestamp survives a large turn and excludes Keep deliveries', () => {
  const at = '2026-09-09T20:00:00Z', later = '2026-09-09T21:00:00Z';
  for (const format of ['event_msg', 'response_item']) {
  const user = (timestamp, message) => ({ type: format, timestamp, payload: format === 'event_msg'
    ? { type: 'user_message', message } : { type: 'message', role: 'user', content: [{ type: 'input_text', text: message }] } });
  transcript([
    { type: 'session_meta', payload: { session_id: 's', cwd: '/tmp' } },
    user(at, 'What changes in the plan?'),
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'large-tool', output: 'x'.repeat(1024 * 1024) } },
    user(later, '[keep] scheduled check update'),
    user(later, '# AGENTS.md instructions for this repo'),
  ], (file) => assert.equal(scanRollout(file).lastUserAt, Date.parse(at)));
  }
});

test('Claude automatic rate-limit continuation does not count as human input', () => {
  const at = '2026-09-09T20:00:00Z', later = '2026-09-09T21:00:00Z';
  transcript([
    { type: 'user', timestamp: at, message: { content: 'Build it' } },
    { type: 'user', timestamp: later, message: { content: '[keep] continue after the rate limit reset' } },
  ], (file) => assert.equal(scanTranscript(file).lastUserAt, Date.parse(at)));
});

test('both agents keep real questions visible regardless of age or card dependencies', () => {
  for (const kind of ['claude', 'codex']) {
    const current = { ...session, kind, taskStatus: 'waiting', lastAssistant: 'Which environment should I deploy to?' };
    assert.equal(attention(current).kind, 'input');
    assert.equal(activity(current, { dependencies: ['deploy'] }).state, 'needs-input');
    assert.equal(attention({ ...current, exited: true }), null);
    assert.equal(attention({ ...current, reviewer: true }), null);
    assert.equal(attention({ ...current, endedTurn: false }), null, 'old question during a new turn is not current');
  }
});

test('historical deployment prose cannot create a live wait', () => {
  const old = { ...session, taskStatus: 'active', lastAssistant: 'Legacy retirement is waiting for Ghost instance refresh to finish; Keep will recheck in 30 minutes.' };
  assert.equal(activity(old).state, 'idle');
  assert.equal(activity({ ...old, pendingBackground: true }).label, 'Waiting: deploy');
  assert.equal(activity(old, { task: { check_after: 'future' } }).label, 'Waiting: scheduled check');
});

test('direct requests remain visible even when the linked assessment card is done', () => {
  const request = 'Yes—create an **empty private repo** in the GitHub account or organization you want teammates to access. Don’t initialize it with a README, license, or `.gitignore`.\n\nSend me the URL. We’ll extract the code into it with fresh history, keep your personal registry private, and switch your installation to that checkout.';
  for (const kind of ['claude', 'codex']) {
    for (const text of [request, 'Share the link once it is ready.', 'Let me know which account to use.', 'Reply with your choice.']) {
      const current = { ...session, kind, taskStatus: 'done', lastAssistantFull: text };
      assert.equal(activity(current).needsInput, true);
      assert.equal(attention(current).kind, 'input');
      assert.equal(attention({ ...current, endedTurn: false }), null);
      assert.equal(attention({ ...current, toolRunning: true }), null);
    }
    for (const text of ['Done. Let me know if you need anything else.', 'Let me know if you want any further changes.', 'I will send you the URL after the build.', '> Send me the URL.\n\nThat request has been answered.', '```\nSend me the URL.\n```\nExample only.']) {
      assert.equal(attention({ ...session, kind, taskStatus: 'done', lastAssistantFull: text }), null);
    }
  }
});

test('waiting reasons, task needs and active work have distinct precedence', () => {
  assert.equal(activity({ ...session, pendingBackground: true, notify: { type: 'complete' }, lastAssistant: 'Waiting on the deploy.' }).label, 'Waiting: deploy');
  assert.equal(activity({ ...session, waitingFor: 'lock', endedTurn: false }).label, 'Waiting: lock');
  assert.equal(activity({ ...session, pendingBackground: true, endedTurn: false }).state, 'running');
  assert.equal(activity(session, { dependencies: ['deploy#2'] }).state, 'waiting');
  assert.equal(activity(session, { task: { status: 'review' } }).needsInput, true);
  assert.equal(activity(session, { task: { status: 'blocked', needs: [{ text: 'Provide the key' }] } }).needsInput, true);
  assert.equal(activity(session, { task: { status: 'done', check_after: 'old' }, dependencies: ['stale'] }).state, 'done');
  assert.equal(activity(session, { task: { status: 'review', check_after: 'future' }, dependencies: ['deploy'] }).needsInput, true);
  assert.equal(activity({ ...session, endedTurn: false, alive: false, deadMidTurn: true }).state, 'inactive');
});

function transcript(records, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-status-'));
  const file = path.join(dir, 'session.jsonl');
  try { fs.writeFileSync(file, records.map((row) => JSON.stringify(row)).join('\n') + '\n'); return run(file); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('Claude stays running between a tool result and the next assistant message', () => {
  const rows = [
    { type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'passed' }] } },
  ];
  transcript(rows, (file) => assert.equal(scanTranscript(file).endedTurn, false));
  rows.push({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'next step' }] } });
  transcript(rows, (file) => assert.equal(scanTranscript(file).endedTurn, false));
  rows.push({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } });
  transcript(rows, (file) => assert.equal(scanTranscript(file).endedTurn, true));
});

test('Codex begins running on tool calls after a prior completion and exposes pending waits', () => {
  const rows = [
    { type: 'session_meta', payload: { session_id: 's', cwd: '/tmp' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'a', name: 'functions.exec_command', arguments: JSON.stringify({ cmd: 'flock lockfile deploy' }) } },
  ];
  transcript(rows, (file) => {
    const parsed = scanRollout(file);
    assert.equal(parsed.endedTurn, false);
    assert.equal(parsed.waitingFor, 'lock');
  });
  rows.push({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'a', output: 'done' } });
  transcript(rows, (file) => { assert.equal(scanRollout(file).waitingFor, null); assert.equal(scanRollout(file).endedTurn, false); });
});

test('Codex async questions survive the accepted result until the user responds', () => {
  const rows = [
    { type: 'session_meta', payload: { session_id: 's' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'q', name: 'functions.request_user_input_async', arguments: JSON.stringify({ questions: [{ title: 'Choose an environment', options: ['staging', 'prod'] }] }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'q', output: '{"accepted":true}' } },
  ];
  transcript(rows, (file) => assert.equal(activity(scanRollout(file)).state, 'needs-input'));
  rows.push({ type: 'event_msg', payload: { type: 'user_message', message: 'staging' } });
  transcript(rows, (file) => assert.equal(activity(scanRollout(file)).state, 'running'));
});

test('the UI human queue excludes completions, health, stalls and automatic rate limits', async () => {
  const { humanAttention } = await import('../web/app/status.js');
  const attention = ['question', 'permission', 'plan', 'input', 'complete', 'health', 'stalled', 'rateLimit'].map((kind) => ({ kind, sessionId: 's' }));
  assert.deepEqual(humanAttention({ attention }).map((row) => row.kind), ['question', 'permission', 'plan', 'input']);
});

function freshCodex(root = os.homedir()) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'codex.js'), 'utf8'), {
    module, Buffer, process: { env: { KEEP_DIR: root } },
    require: (name) => name === 'os' ? { homedir: () => root }
      : require(name.startsWith('.') ? path.join(__dirname, name) : name),
  });
  return module.exports;
}

test('unanswered Codex async questions survive tail rollover, cold scans and appended answers', () => {
  transcript([
    { type: 'session_meta', payload: { session_id: 's' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'q', name: 'functions.request_user_input_async', arguments: JSON.stringify({ questions: [{ title: 'Approve?' }] }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'q', output: '{"accepted":true}' } },
  ], (file) => {
    assert.equal(scanRollout(file).pendingQuestion.question, 'Approve?');
    fs.appendFileSync(file, JSON.stringify({ type: 'tool_output', payload: { text: 'x'.repeat(300000) } }) + '\n');
    assert.equal(scanRollout(file).pendingQuestion.question, 'Approve?');
    assert.equal(freshCodex().scanRollout(file).pendingQuestion.question, 'Approve?');
    fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Yes' } }) + '\n');
    assert.equal(scanRollout(file).pendingQuestion, null);
  });
});

test('multiple Codex rollouts produce one session and consistently select the newest transcript', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-dedup-'));
  try {
    const date = new Date();
    const dir = path.join(root, '.codex', 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    const newest = path.join(dir, 'rollout-a-shared.jsonl');
    const older = path.join(dir, 'rollout-z-shared.jsonl');
    for (const [file, event] of [[newest, 'task_started'], [older, 'task_complete']]) {
      fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { session_id: 'shared' } }) + '\n'
        + JSON.stringify({ type: 'event_msg', payload: { type: event } }) + '\n');
    }
    fs.utimesSync(older, date, new Date(date.getTime() - 60000));
    const codex = freshCodex(root);
    const rows = codex.scan();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'running');
    assert.equal(codex.rolloutFileFor('shared'), newest);
    assert.equal(codex.findRolloutFile('shared'), newest);
    assert.equal(codex.sessionFor('shared').state, 'running');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('root dashboard excludes historical and exited sessions with the new activity states', () => {
  const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(html.slice(html.indexOf('function sessionInNow('), html.indexOf('function render()')), context);
  for (const state of ['idle', 'done', 'exited', 'inactive', 'recent']) {
    assert.equal(context.sessionInNow({ state, mtime: 0 }, 7200e3), false);
  }
  for (const state of ['running', 'waiting', 'needs-input']) {
    assert.equal(context.sessionInNow({ state, mtime: 0 }, 7200e3), true);
  }
  assert.equal(context.sessionInNow({ state: 'idle', mtime: 7199e3 }, 7200e3), true);
  context.state = { sessions: [{ state: 'idle', mtime: Date.now() - 7200e3 }] };
  const liveLine = html.match(/const live = .*;/)[0];
  assert.equal(vm.runInContext(`${liveLine}\nlive.length`, context), 0);
});

test('a finished child cannot leave its parent waiting for review when notification is missing', () => {
  transcript([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'agent-call', name: 'Agent', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'agent-call', content: 'Async agent launched successfully.\nagentId: review-child' }] } },
    { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done. The review passed.' }] } },
  ], (file) => {
    const info = scanTranscript(file);
    assert.equal(sessionBackgroundPending(info), true, 'missing child evidence remains pending');
    const dir = path.join(path.dirname(file), 'session', 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    const child = path.join(dir, 'agent-review-child.jsonl');
    fs.writeFileSync(child, JSON.stringify({ type: 'assistant', isSidechain: true, message: { stop_reason: null, content: [{ type: 'text', text: 'Checking the review…' }] } }) + '\n');
    assert.equal(sessionBackgroundPending(info), true, 'streaming text without end_turn is not completion');
    fs.writeFileSync(child, JSON.stringify({ type: 'assistant', isSidechain: true, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Review done.' }] } }) + '\n');
    assert.equal(sessionBackgroundPending(info), false, 'child completion clears cached parent launch evidence');
    assert.equal(activity({ ...info, taskStatus: 'done', pendingBackground: sessionBackgroundPending(info) }).state, 'done');
    fs.appendFileSync(child, JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'Review the follow-up.' } }) + '\n');
    assert.equal(sessionBackgroundPending(info), true, 'a resumed child is pending again');
  });
});

test('Watch grid height is independent of terminal content and observer font metrics', () => {
  const css = fs.readFileSync(path.join(__dirname, '../web/app/styles.css'), 'utf8');
  assert.match(css, /\.wgrid\s*\{[^}]*grid-auto-rows:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.xterm-host\s*\{[^}]*padding:\s*0;[^}]*margin:\s*8px 8px 0/,
    'FitAddon reads parent border-box height, so spacing must be outside that box');
});
