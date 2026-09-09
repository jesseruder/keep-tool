const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { activity, attention } = require('./session-status');
const { scanTranscript, sessionBackgroundPending } = require('./serve');
const { scanRollout } = require('./codex');

const session = { id: 's', kind: 'claude', endedTurn: true, mtime: 1 };

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
    for (const live of [{ ...stopped, pane: 'pane' }, { ...stopped, alive: true }]) {
      assert.equal(activity(live).reason, 'next instruction');
      assert.equal(attention(live).kind, 'input');
      assert.equal(attention({ ...live, endedTurn: false }), null);
      assert.equal(attention({ ...live, toolRunning: true }), null);
      assert.equal(attention({ ...live, reviewer: true }), null);
      assert.equal(attention({ ...live, exited: true }), null);
      assert.equal(attention({ ...live, taskStatus: 'done' }), null);
      assert.equal(attention({ ...live, pendingBackground: true }), null);
      assert.equal(attention({ ...live, waitingFor: 'lock' }), null);
      assert.equal(attention(live, { task: { check_after: '2099-01-01' } }), null);
      assert.equal(attention(live, { dependencies: ['rollout#6'] }), null);
    }
    assert.equal(activity(stopped, { live: true }).reason, 'next instruction', 'host liveness works before panes are attached to response rows');
    assert.equal(attention({ ...stopped, pane: 'old', alive: false }), null);
  }
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
    module, Buffer,
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
