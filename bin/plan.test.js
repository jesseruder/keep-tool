'use strict';

// The reviewer launcher exports KEEP_REVIEWER* into its shell; tests spawn the CLI
// from process.env, so reviewer-only refusals fired inside them when run from that
// session (17 spurious failures on 2026-09-02). Tests that need reviewer identity set
// it explicitly in their own env object.
for (const k of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[k];

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { parsePlan, renderPlan, lastLogLine, commandUsage } = require('./keep.js');

const CLI = path.join(__dirname, 'keep.js');

function registryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-plan-test-'));
  for (const dir of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  assert.equal(spawnSync('git', ['init', '-q', root], { env }).status, 0);
  assert.equal(spawnSync('git', ['-C', root, 'config', 'user.name', 'Keep Test'], { env }).status, 0);
  assert.equal(spawnSync('git', ['-C', root, 'config', 'user.email', 'keep@example.test'], { env }).status, 0);
  return {
    root,
    env,
    run(args, extraEnv = {}) {
      return spawnSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8', cwd: root, env: { ...env, ...extraEnv },
      });
    },
    read(id) { return fs.readFileSync(path.join(root, 'tasks', `${id}.md`), 'utf8'); },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('command help prints scoped usage and preserves unknown-command errors', () => {
  const f = registryFixture();
  try {
    const planHelp = f.run(['plan', '--help']);
    assert.equal(planHelp.status, 0, planHelp.stderr);
    assert.match(planHelp.stdout, /keep plan <id>/);
    assert.match(planHelp.stdout, /--undo <n>/);
    assert.equal(planHelp.stderr, '');

    const addHelp = f.run(['add', '--help']);
    assert.equal(addHelp.status, 0, addHelp.stderr);
    assert.match(addHelp.stdout, /--file\|--claim/);
    assert.match(addHelp.stdout, /ideas file by default/);
    assert.match(addHelp.stdout, /mutually exclusive/);

    const bundleHelp = f.run(['review-bundle', '-h']);
    assert.equal(bundleHelp.status, 0, bundleHelp.stderr);
    assert.match(bundleHelp.stdout, /keep review-bundle <id> \[--budget n\]/);
    assert.match(bundleHelp.stdout, /keep review-bundle <id> \[<id>\.\.\.\]/);
    assert.match(bundleHelp.stdout, /keep review-bundle --queue/);

    const helpPlan = f.run(['help', 'plan']);
    assert.equal(helpPlan.status, 0, helpPlan.stderr);
    assert.equal(helpPlan.stdout, planHelp.stdout);

    assert.equal(f.run(['add', 'Help message']).status, 0);
    const message = f.run(['checkin', 'help-message', '-m', '--help']);
    assert.equal(message.status, 0, message.stderr);
    assert.doesNotMatch(message.stdout, /keep checkin <id>/);
    assert.match(f.read('help-message'), /^--help$/m);

    const beforeHelp = f.read('help-message');
    const checkinHelp = f.run(['checkin', 'help-message', '-m', 'note', '--help']);
    assert.equal(checkinHelp.status, 0, checkinHelp.stderr);
    assert.match(checkinHelp.stdout, /keep checkin <id>/);
    assert.equal(f.read('help-message'), beforeHelp);

    const planHelpAgain = f.run(['plan', 'help-message', '--help']);
    assert.equal(planHelpAgain.status, 0, planHelpAgain.stderr);
    assert.match(planHelpAgain.stdout, /keep plan <id>/);

    const unknown = f.run(['nosuchcommand', '--help']);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /unknown command/);
  } finally { f.cleanup(); }
});

test('commandUsage returns every landed form and null for an unknown command', () => {
  assert.equal(commandUsage('landed').split('\n').length, 5);
  assert.equal(commandUsage('zzz'), null);
});

function writeLinkedCard(fixture, options = {}) {
  const project = path.join(fixture.root, 'project');
  const sid = options.sid || 'claude-plan-session';
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'tasks', 'planned-card.md'), [
    '---',
    'title: Planned card',
    `status: ${options.status || 'active'}`,
    'kind: task',
    ...(options.autocontinue ? [`autocontinue: ${options.autocontinue}`] : []),
    ...(options.allow ? [`allow: [${options.allow.join(', ')}]`] : []),
    ...(options.allowUntil ? [`allow_until: ${options.allowUntil}`] : []),
    `project: ${project}`,
    'sessions:',
    `  - id: ${sid}`,
    '    agent: claude',
    '    at: 2026-09-02T12:00',
    'created: 2026-09-02',
    'updated: 2026-09-02T12:00',
    '---',
    '## Plan',
    ...(options.steps || ['First step', 'Second step']).map((step) => `- [ ] ${step}`),
    '',
    '## 2026-09-02 12:00 — created',
    'Ready.',
    '',
  ].join('\n'));
  return { project, sid };
}

function assistant(text) {
  return `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`;
}

function interactive() {
  return `${JSON.stringify({ type: 'mode', mode: 'default' })}\n`;
}

function assistantTool(name, id = `tool-${name}`) {
  return `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, id, input: {} }] } })}\n`;
}

function toolResult(id) {
  return `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })}\n`;
}

function edit() {
  return `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit' }] } })}\n`;
}

// A message Owner typed, at a chosen age. The Stop hook uses the most recent one
// to decide whether he is at this keyboard.
function human(text, agoMs = 0) {
  return `${JSON.stringify({
    type: 'user',
    timestamp: new Date(Date.now() - agoMs).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`;
}

function stop(fixture, linked, transcript, extraEnv = {}, inputOverrides = {}) {
  return spawnSync(process.execPath, [CLI, 'hook', 'stop'], {
    encoding: 'utf8',
    cwd: linked.project,
    env: { ...fixture.env, CLAUDE_CODE_SESSION_ID: linked.sid, ...extraEnv },
    input: JSON.stringify({ session_id: linked.sid, transcript_path: transcript, cwd: linked.project, ...inputOverrides }),
  });
}

test('parsePlan and renderPlan round trip a top checklist with stray blank lines', () => {
  const body = '\n## Plan\n\n- [ ] Write migration\n- [~] Run staging\n\n- [x] Design schema\n\n## 2026-09-02 12:10 — check-in\nProgress.\n';
  const parsed = parsePlan(body);
  assert.deepEqual(parsed.steps, [
    { n: 1, text: 'Write migration', state: 'todo' },
    { n: 2, text: 'Run staging', state: 'doing' },
    { n: 3, text: 'Design schema', state: 'done' },
  ]);
  assert.equal(renderPlan(parsed.steps), '## Plan\n- [ ] Write migration\n- [~] Run staging\n- [x] Design schema');
  assert.match(parsed.rest, /^## 2026-09-02/);
});

test('parsePlan accepts trailing heading whitespace, indented checkboxes, and CRLF', () => {
  const parsed = parsePlan('## Plan \r\n  - [ ] Indented\r\n\r\n## 2026-09-02 12:10 — check-in\r\nProgress.\r\n');
  assert.deepEqual(parsed.steps, [{ n: 1, text: 'Indented', state: 'todo' }]);
  assert.equal(parsed.present, true);
  assert.match(parsed.rest, /^## 2026-09-02/);
});

test('appendLog keeps the plan on top', () => {
  const f = registryFixture();
  try {
    assert.equal(f.run(['add', 'Append log', '--plan', 'Ship it', '-m', 'Started.']).status, 0);
    assert.equal(f.run(['checkin', 'append-log', '-m', 'Made progress.']).status, 0);
    const body = f.read('append-log').split('---\n').slice(2).join('---\n');
    assert.match(body, /^## Plan\n- \[ \] Ship it\n\n## \d{4}-/);
    assert.ok(body.indexOf('Made progress.') < body.indexOf('Started.'));
  } finally { f.cleanup(); }
});

test('an invalid Plan block stays on top and plan mutations fail clearly', () => {
  const f = registryFixture();
  try {
    assert.equal(f.run(['add', 'Invalid plan', '-m', 'Started.']).status, 0);
    const file = path.join(f.root, 'tasks', 'invalid-plan.md');
    const card = f.read('invalid-plan');
    fs.writeFileSync(file, card.replace(/## .* — created\nStarted\./, '## Plan \nThis is not a checkbox.\n\n## 2026-09-02 12:00 — created\nStarted.'));
    const mutation = f.run(['plan', 'invalid-plan', '--add', 'Second block']);
    assert.notEqual(mutation.status, 0);
    assert.match(mutation.stderr, /Plan heading but no valid checklist steps/);
    assert.equal((f.read('invalid-plan').match(/^## Plan/mg) || []).length, 1);

    const checkin = f.run(['checkin', 'invalid-plan', '-m', 'Still investigating.']);
    assert.equal(checkin.status, 0, checkin.stderr);
    const updated = f.read('invalid-plan').split('---\n').slice(2).join('---\n');
    assert.match(updated, /^## Plan \nThis is not a checkbox\.\n\n## \d{4}-/);
  } finally { f.cleanup(); }
});

test('lastLogLine skips the plan block', () => {
  const task = { body: '## Plan\n- [ ] Not a log line\n\n## 2026-09-02 12:10 — check-in\nActual latest log.\n' };
  assert.equal(lastLogLine(task), 'Actual latest log.');
});

test('plan --set preserves states by matching step text in occurrence order', () => {
  const f = registryFixture();
  try {
    assert.equal(f.run(['add', 'Plan states', '--status', 'active', '--plan', 'Alpha', 'Alpha', 'Beta']).status, 0);
    assert.equal(f.run(['plan', 'plan-states', '--start', '2']).status, 0);
    const changed = f.run(['plan', 'plan-states', '--set', 'Alpha', 'Alpha', 'Gamma']);
    assert.equal(changed.status, 0, changed.stderr);
    const card = f.read('plan-states');
    assert.match(card, /^- \[ \] Alpha\n- \[~\] Alpha$/m);
    assert.match(f.read('plan-states'), /^- \[ \] Gamma$/m);
  } finally { f.cleanup(); }
});

test('empty plan values fail without changing an existing plan', () => {
  const f = registryFixture();
  try {
    assert.equal(f.run(['add', 'Nonempty plan', '--plan', 'Alpha']).status, 0);
    const before = f.read('nonempty-plan');
    const cleared = f.run(['plan', 'nonempty-plan', '--set', '']);
    assert.notEqual(cleared.status, 0);
    assert.match(cleared.stderr, /plan steps cannot be empty/);
    assert.equal(f.read('nonempty-plan'), before);

    const appended = f.run(['plan', 'nonempty-plan', '--add', '']);
    assert.notEqual(appended.status, 0);
    assert.match(appended.stderr, /plan steps cannot be empty/);
    assert.equal(f.read('nonempty-plan'), before);

    const added = f.run(['add', 'Empty plan', '--tag', 'personal', '--plan', '']);
    assert.notEqual(added.status, 0);
    assert.match(added.stderr, /plan steps cannot be empty/);
  } finally { f.cleanup(); }
});

test('plan --done, --start, and --undo update checklist state', () => {
  const f = registryFixture();
  try {
    assert.equal(f.run(['add', 'Plan mutations', '--plan', 'Alpha', 'Beta']).status, 0);
    assert.equal(f.run(['plan', 'plan-mutations', '--start', '1']).status, 0);
    assert.match(f.read('plan-mutations'), /^- \[~\] Alpha$/m);
    assert.equal(f.run(['plan', 'plan-mutations', '--done', '1']).status, 0);
    assert.match(f.read('plan-mutations'), /^- \[x\] Alpha$/m);
    assert.match(f.read('plan-mutations'), /plan → step 1 done: Alpha/);
    assert.equal(f.run(['plan', 'plan-mutations', '--undo', '1']).status, 0);
    assert.match(f.read('plan-mutations'), /^- \[ \] Alpha$/m);
  } finally { f.cleanup(); }
});

test('checkin --step next completes doing before todo and prefixes the log', () => {
  const f = registryFixture();
  try {
    assert.equal(f.run(['add', 'Step checkin', '--plan', 'Alpha', 'Beta']).status, 0);
    assert.equal(f.run(['plan', 'step-checkin', '--start', '2']).status, 0);
    const shown = f.run(['show', 'step-checkin']);
    assert.match(shown.stdout, /next: step 2\/2 — Beta/);
    const result = f.run(['checkin', 'step-checkin', '--step', 'next', '-m', 'Finished it; Alpha is next.']);
    assert.equal(result.status, 0, result.stderr);
    const card = f.read('step-checkin');
    assert.match(card, /^- \[x\] Beta$/m);
    assert.match(card, /step 2 done — Finished it; Alpha is next\./);
  } finally { f.cleanup(); }
});

test('keep add --plan writes the plan above the creation log', () => {
  const f = registryFixture();
  try {
    const result = f.run(['add', 'Planned add', '--plan', 'Alpha', 'Beta', '-m', 'Created with a plan.']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(f.read('planned-add'), /---\n## Plan\n- \[ \] Alpha\n- \[ \] Beta\n\n## .* — created/);
  } finally { f.cleanup(); }
});

test('plan values split literal and real newlines into separate unnumbered steps', () => {
  const f = registryFixture();
  try {
    assert.equal(f.run(['add', 'Literal plan', '--plan', '1. a\\n2. b\\n3. c']).status, 0);
    assert.deepEqual(parsePlan(f.read('literal-plan').split('---\n').slice(2).join('---\n')).steps.map((step) => step.text), ['a', 'b', 'c']);

    assert.equal(f.run(['add', 'Real plan', '--plan', '1. a\n2. b\n3. c']).status, 0);
    assert.deepEqual(parsePlan(f.read('real-plan').split('---\n').slice(2).join('---\n')).steps.map((step) => step.text), ['a', 'b', 'c']);

    assert.equal(f.run(['plan', 'literal-plan', '--set', 'a\\nb']).status, 0);
    assert.deepEqual(parsePlan(f.read('literal-plan').split('---\n').slice(2).join('---\n')).steps.map((step) => step.text), ['a', 'b']);

    assert.equal(f.run(['add', 'Single numbered', '--plan', '1. only']).status, 0);
    assert.deepEqual(parsePlan(f.read('single-numbered').split('---\n').slice(2).join('---\n')).steps.map((step) => step.text), ['1. only']);
  } finally { f.cleanup(); }
});

test('keep show prints the numbered plan and next line', () => {
  const f = registryFixture();
  try {
    assert.equal(f.run(['add', 'Shown plan', '--plan', 'Alpha', 'Beta']).status, 0);
    const shown = f.run(['show', 'shown-plan']);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /1\. \[ \] Alpha/);
    assert.match(shown.stdout, /next: step 1\/2 — Alpha/);
  } finally { f.cleanup(); }
});

test('Stop auto-continues a linked card once per step and advances after plan --done', () => {
  const f = registryFixture();
  try {
    const linked = writeLinkedCard(f);
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, interactive() + assistant('Finished a chunk.'));
    const first = stop(f, linked, transcript);
    assert.equal(first.status, 0, first.stderr);
    assert.match(JSON.parse(first.stdout).reason, /Continue with step 1 of 2/);
    assert.equal(stop(f, linked, transcript).stdout, '');

    const done = f.run(['plan', 'planned-card', '--done', '1'], { CLAUDE_CODE_SESSION_ID: linked.sid });
    assert.equal(done.status, 0, done.stderr);
    const second = stop(f, linked, transcript);
    assert.match(JSON.parse(second.stdout).reason, /Continue with step 2 of 2/);
  } finally { f.cleanup(); }
});

test('Codex Stop shares the plan policy and emits exactly one JSON result', () => {
  const f = registryFixture();
  try {
    const linked = writeLinkedCard(f);
    const transcript = path.join(f.root, 'codex.jsonl');
    const row = (type, payload) => JSON.stringify({ type, payload, timestamp: new Date().toISOString() }) + '\n';
    const base = row('session_meta', { id: linked.sid, source: 'cli', originator: 'codex-tui' }) +
      row('event_msg', { type: 'user_message', message: 'Continue the work.' }) +
      row('event_msg', { type: 'agent_message', message: 'Finished a chunk.' });
    fs.writeFileSync(transcript, base);
    const run = (extra = {}) => spawnSync(process.execPath, [CLI, 'hook', 'codex', 'stop'], {
      cwd: f.root, env: f.env, encoding: 'utf8',
      input: JSON.stringify({ session_id: linked.sid, cwd: linked.project, transcript_path: transcript, ...extra }),
    });
    assert.deepEqual(JSON.parse(run({ stop_hook_active: true }).stdout), {});
    assert.match(JSON.parse(run().stdout).reason, /Continue with step 1 of 2/);
    assert.deepEqual(JSON.parse(run().stdout), {});
    assert.equal(f.run(['plan', 'planned-card', '--done', '1']).status, 0);
    assert.deepEqual(JSON.parse(run({ last_assistant_message: 'Should I deploy?' }).stdout), {});
    fs.appendFileSync(transcript, row('response_item', { type: 'function_call', name: 'request_user_input_async', call_id: 'q', arguments: JSON.stringify({ questions: [{ title: 'Which option?' }] }) }) +
      row('response_item', { type: 'function_call_output', call_id: 'q', output: '{}' }));
    assert.deepEqual(JSON.parse(run().stdout), {});
    fs.writeFileSync(transcript, base.replace('"source":"cli"', '"source":"exec"').replace('codex-tui', 'codex-exec'));
    assert.deepEqual(JSON.parse(run().stdout), {});
    fs.writeFileSync(transcript, base.replace('"source":"cli"', '"source":"cli","parent_thread_id":"parent"'));
    assert.deepEqual(JSON.parse(run().stdout), {});
    fs.writeFileSync(transcript, base);
    assert.match(JSON.parse(run().stdout).reason, /Continue with step 2 of 2/);
  } finally { f.cleanup(); }
});

test('Stop allows a question anywhere in the last 400 characters of the last non-empty assistant text', () => {
  const f = registryFixture();
  try {
    const linked = writeLinkedCard(f);
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, interactive() + assistant("Can you approve the deploy? I'll wait for your answer."));
    assert.equal(stop(f, linked, transcript).stdout, '');
  } finally { f.cleanup(); }
});

test('Stop skips a tool-only final assistant record when finding the last question', () => {
  const f = registryFixture();
  try {
    const linked = writeLinkedCard(f);
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, interactive() + assistant('Should I deploy this?') + assistantTool('Read', 'read-1'));
    assert.equal(stop(f, linked, transcript).stdout, '');
  } finally { f.cleanup(); }
});

test('Stop does not continue while a question or plan tool is unresolved', () => {
  for (const name of ['AskUserQuestion', 'ExitPlanMode']) {
    const f = registryFixture();
    try {
      const linked = writeLinkedCard(f);
      const transcript = path.join(f.root, 'transcript.jsonl');
      fs.writeFileSync(transcript, interactive() + assistantTool(name, 'decision-1'));
      assert.equal(stop(f, linked, transcript).stdout, '', name);
      fs.appendFileSync(transcript, toolResult('decision-1') + assistant('Decision received.'));
      assert.match(JSON.parse(stop(f, linked, transcript).stdout).reason, /Continue with step 1 of 2/);
    } finally { f.cleanup(); }
  }
});

test('Stop does not continue in plan permission mode', () => {
  const f = registryFixture();
  try {
    const linked = writeLinkedCard(f);
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, interactive() + assistant('Plan drafted.'));
    assert.equal(stop(f, linked, transcript, {}, { permission_mode: 'plan' }).stdout, '');
  } finally { f.cleanup(); }
});

test('Stop does not continue a linked headless transcript without an interactive marker', () => {
  const f = registryFixture();
  try {
    const linked = writeLinkedCard(f);
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, assistant('Finished a chunk.'));
    assert.equal(stop(f, linked, transcript).stdout, '');
  } finally { f.cleanup(); }
});

test('Stop never adopts an unlinked planned card from the project', () => {
  const f = registryFixture();
  try {
    const owner = writeLinkedCard(f, { sid: 'owner-session' });
    const unlinked = { ...owner, sid: 'unlinked-session' };
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, interactive() + assistant('Finished a chunk.'));
    assert.equal(stop(f, unlinked, transcript).stdout, '');
  } finally { f.cleanup(); }
});

test('KEEP_AUTO_CONTINUE=0 disables Stop auto-continuation', () => {
  const f = registryFixture();
  try {
    const linked = writeLinkedCard(f);
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, interactive() + assistant('Finished a chunk.'));
    assert.equal(stop(f, linked, transcript, { KEEP_AUTO_CONTINUE: '0' }).stdout, '');
  } finally { f.cleanup(); }
});

test('autocontinue: off disables Stop auto-continuation for one card', () => {
  const f = registryFixture();
  try {
    const linked = writeLinkedCard(f, { autocontinue: 'off' });
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, interactive() + assistant('Finished a chunk.'));
    assert.equal(stop(f, linked, transcript).stdout, '');
  } finally { f.cleanup(); }
});

test('Stop combines substantive check-in evidence with auto-continuation in one block', () => {
  const f = registryFixture();
  try {
    const linked = writeLinkedCard(f);
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, interactive() + assistant('Finished a chunk.') + edit().repeat(5));
    const result = stop(f, linked, transcript);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /^\[keep\] Your card planned-card has a next step\./);
    assert.equal((result.stdout.match(/"decision":"block"/g) || []).length, 1);
  } finally { f.cleanup(); }
});

test('Stop treats identical text at different positions as distinct steps', () => {
  const f = registryFixture();
  try {
    const linked = writeLinkedCard(f, { steps: ['Repeat', 'Repeat'] });
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, interactive() + assistant('Finished a chunk.'));
    assert.match(JSON.parse(stop(f, linked, transcript).stdout).reason, /step 1 of 2/);
    assert.equal(f.run(['plan', 'planned-card', '--done', '1'], { CLAUDE_CODE_SESSION_ID: linked.sid }).status, 0);
    assert.match(JSON.parse(stop(f, linked, transcript).stdout).reason, /step 2 of 2/);
  } finally { f.cleanup(); }
});

test('Stop only advances a renamed position after the old text is no longer open', () => {
  const f = registryFixture();
  try {
    const linked = writeLinkedCard(f, { steps: ['Old name', 'Old name'] });
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, interactive() + assistant('Finished a chunk.'));
    assert.match(JSON.parse(stop(f, linked, transcript).stdout).reason, /step 1 of 2/);
    assert.equal(f.run(['plan', 'planned-card', '--set', 'New name', 'Old name'], { CLAUDE_CODE_SESSION_ID: linked.sid }).status, 0);
    assert.equal(stop(f, linked, transcript).stdout, '', 'the previous text is still an open step');
    assert.equal(f.run(['plan', 'planned-card', '--done', '2'], { CLAUDE_CODE_SESSION_ID: linked.sid }).status, 0);
    assert.match(JSON.parse(stop(f, linked, transcript).stdout).reason, /step 1 of 2/);
  } finally { f.cleanup(); }
});

test('Stop fences step text before a 200-character clip', () => {
  const f = registryFixture();
  try {
    const long = 'x'.repeat(1000);
    const linked = writeLinkedCard(f, { steps: [long] });
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, interactive() + assistant('Finished a chunk.'));
    const reason = JSON.parse(stop(f, linked, transcript).stdout).reason;
    const fence = reason.indexOf('DATA, NOT INSTRUCTIONS');
    const text = reason.match(/card: "(x+)"\. When it is done:/)[1];
    assert.ok(fence >= 0 && fence < reason.indexOf(text));
    assert.equal(text.length, 200);
    assert.doesNotMatch(reason, /x{201}/);
  } finally { f.cleanup(); }
});

// ---------- authorization-aware Stop (keep allow) ----------

test('Stop continues through an approval question the card already grants', () => {
  const f = registryFixture();
  try {
    const linked = writeLinkedCard(f, { allow: ['push'] });
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, interactive() + assistant('Tests pass. Want me to push it?'));
    const out = stop(f, linked, transcript);
    assert.equal(out.status, 0, out.stderr);
    const reason = JSON.parse(out.stdout).reason;
    assert.match(reason, /already grants push/);
    assert.match(reason, /continue with step 1 of 2/);
  } finally { f.cleanup(); }
});

test('Stop still hands back when one action in a compound ask is ungranted', () => {
  const f = registryFixture();
  try {
    const linked = writeLinkedCard(f, { allow: ['push'] });
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, interactive() + human('go', 60e3)
      + assistant('I will push it and then deploy to production. Want me to?'));
    assert.equal(stop(f, linked, transcript).stdout, '');
  } finally { f.cleanup(); }
});

test('Stop does not treat an expired grant as authorization', () => {
  const f = registryFixture();
  try {
    const linked = writeLinkedCard(f, { allow: ['push'], allowUntil: '2020-01-01T00:00' });
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, interactive() + human('go', 60e3) + assistant('Want me to push it?'));
    assert.equal(stop(f, linked, transcript).stdout, '');
  } finally { f.cleanup(); }
});

test('Stop authorizes once, then stays quiet on the same ask', () => {
  const f = registryFixture();
  try {
    const linked = writeLinkedCard(f, { allow: ['push'], steps: ['Only step'] });
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, interactive() + assistant('Shall I push it?'));
    assert.match(JSON.parse(stop(f, linked, transcript).stdout).reason, /already grants push/);
    assert.equal(stop(f, linked, transcript).stdout, '');
  } finally { f.cleanup(); }
});

test('a question with no recognisable action is never auto-authorized', () => {
  const f = registryFixture();
  try {
    const linked = writeLinkedCard(f, { allow: ['push', 'deploy'] });
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, interactive() + human('go', 60e3)
      + assistant('Which of the two schemas do you prefer?'));
    assert.equal(stop(f, linked, transcript).stdout, '');
  } finally { f.cleanup(); }
});

// ---------- questions for Owner stay in the pane ----------

test('Stop leaves an unanswered question in the pane however long Owner has been away', () => {
  const f = registryFixture();
  try {
    const linked = writeLinkedCard(f);
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, interactive() + human('start on this', 3 * 3600e3)
      + assistant('Which region should the replica live in?'));
    const out = stop(f, linked, transcript);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, '');
    assert.equal(fs.existsSync(path.join(f.root, '.keep', 'review', '_questions.json')), false);
  } finally { f.cleanup(); }
});

// ---------- acceptance criteria ----------

test('parsePlan and renderPlan round trip a done-when line', () => {
  const body = '## Plan\n- [ ] Ship it\n  done-when: node --test bin/x.test.js\n- [x] Design\n\n## 2026-09-02 12:10 — check-in\nProgress.\n';
  const parsed = parsePlan(body);
  assert.deepEqual(parsed.steps, [
    { n: 1, text: 'Ship it', state: 'todo', doneWhen: 'node --test bin/x.test.js' },
    { n: 2, text: 'Design', state: 'done' },
  ]);
  assert.equal(renderPlan(parsed.steps), '## Plan\n- [ ] Ship it\n  done-when: node --test bin/x.test.js\n- [x] Design');
  assert.match(parsed.rest, /^## 2026-09-02/);
});

test('checkin --step refuses a step whose done-when fails, and passes once it succeeds', () => {
  const f = registryFixture();
  try {
    const marker = path.join(f.root, 'marker');
    assert.equal(f.run(['add', 'Criterion card', '--status', 'active', '--plan', 'Make it',
      '--done-when', `test -f ${marker}`, '-m', 'Started.']).status, 0);

    const refused = f.run(['checkin', 'criterion-card', '--step', '1', '-m', 'claimed']);
    assert.equal(refused.status, 3, refused.stdout);
    assert.match(refused.stderr, /step 1 is not done/);
    assert.match(f.read('criterion-card'), /- \[ \] Make it/);

    fs.writeFileSync(marker, 'x');
    const ok = f.run(['checkin', 'criterion-card', '--step', '1', '-m', 'really done']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(f.read('criterion-card'), /- \[x\] Make it/);
    assert.match(f.read('criterion-card'), /done-when passed/);
  } finally { f.cleanup(); }
});

test('--force lands a step whose done-when fails', () => {
  const f = registryFixture();
  try {
    assert.equal(f.run(['add', 'Forced card', '--status', 'active', '--plan', 'Make it',
      '--done-when', 'false', '-m', 'Started.']).status, 0);
    const forced = f.run(['checkin', 'forced-card', '--step', '1', '--force', '-m', 'criterion is wrong']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(f.read('forced-card'), /- \[x\] Make it/);
  } finally { f.cleanup(); }
});

test('keep plan --verify runs one criterion without changing the plan', () => {
  const f = registryFixture();
  try {
    assert.equal(f.run(['add', 'Verify card', '--status', 'active', '--plan', 'A', '--plan', 'B',
      '--done-when', 'true', '--done-when', 'false', '-m', 'Started.']).status, 0);
    const pass = f.run(['plan', 'verify-card', '--verify', '1']);
    assert.equal(pass.status, 0, pass.stderr);
    assert.match(pass.stdout, /done-when passed/);
    const fail = f.run(['plan', 'verify-card', '--verify', '2']);
    assert.equal(fail.status, 3);
    assert.match(fail.stdout, /done-when FAILED/);
    assert.match(f.read('verify-card'), /- \[ \] A/);
  } finally { f.cleanup(); }
});

test('keep plan --done-when <n> sets and clears one criterion', () => {
  const f = registryFixture();
  try {
    assert.equal(f.run(['add', 'Set criterion', '--status', 'active', '--plan', 'A', '--plan', 'B', '-m', 'x']).status, 0);
    assert.equal(f.run(['plan', 'set-criterion', '--done-when', 'true', '2']).status, 0);
    assert.match(f.read('set-criterion'), /- \[ \] B\n  done-when: true/);
    assert.equal(f.run(['plan', 'set-criterion', '--done-when', '', '2']).status, 0);
    assert.doesNotMatch(f.read('set-criterion'), /done-when/);
  } finally { f.cleanup(); }
});

test('a criterion survives plan --set, --done and --start', () => {
  const f = registryFixture();
  try {
    assert.equal(f.run(['add', 'Survives', '--status', 'active', '--plan', 'A', '--plan', 'B',
      '--done-when', 'true', '-m', 'x']).status, 0);
    assert.equal(f.run(['plan', 'survives', '--start', '1']).status, 0);
    assert.match(f.read('survives'), /- \[~\] A\n  done-when: true/);
    assert.equal(f.run(['plan', 'survives', '--set', 'A', 'B', 'C']).status, 0);
    assert.match(f.read('survives'), /- \[~\] A\n  done-when: true/);
  } finally { f.cleanup(); }
});

test('--done-when cannot outnumber the steps it is attached to', () => {
  const f = registryFixture();
  try {
    const out = f.run(['add', 'Too many', '--plan', 'A', '--done-when', 'true', '--done-when', 'false', '-m', 'x']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /--done-when given 2/);
  } finally { f.cleanup(); }
});

test('the Stop hook names the criterion the check-in will run', () => {
  const f = registryFixture();
  try {
    const project = path.join(f.root, 'project');
    fs.mkdirSync(project, { recursive: true });
    const sid = 'claude-plan-session';
    fs.writeFileSync(path.join(f.root, 'tasks', 'planned-card.md'), [
      '---', 'title: Planned card', 'status: active', 'kind: task', `project: ${project}`,
      'sessions:', `  - id: ${sid}`, '    agent: claude', '    at: 2026-09-02T12:00',
      'created: 2026-09-02', 'updated: 2026-09-02T12:00', '---',
      '## Plan', '- [ ] First step', '  done-when: node --test bin/x.test.js', '',
      '## 2026-09-02 12:00 — created', 'Ready.', '',
    ].join('\n'));
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, interactive() + assistant('Finished a chunk.'));
    const reason = JSON.parse(stop(f, { project, sid }, transcript).stdout).reason;
    assert.match(reason, /only done when this command succeeds/);
    assert.match(reason, /node --test bin\/x\.test\.js/);
  } finally { f.cleanup(); }
});

// ---------- autonomous cards ----------

test('--autonomous requires both a plan and grants', () => {
  const f = registryFixture();
  try {
    const noPlan = f.run(['add', 'Auto one', '--autonomous', '--allow', 'push', '-m', 'x']);
    assert.notEqual(noPlan.status, 0);
    assert.match(noPlan.stderr, /--autonomous needs --plan/);

    const noGrants = f.run(['add', 'Auto two', '--autonomous', '--plan', 'A', '-m', 'x']);
    assert.notEqual(noGrants.status, 0);
    assert.match(noGrants.stderr, /--autonomous needs --allow/);

    const ok = f.run(['add', 'Auto three', '--autonomous', '--plan', 'A', '--allow', 'push,review',
      '--until', '+7d', '--status', 'active', '-m', 'x']);
    assert.equal(ok.status, 0, ok.stderr);
    const card = f.read('auto-three');
    assert.match(card, /^autonomous: yes$/m);
    assert.match(card, /^allow: \[push, review\]$/m);
    assert.match(card, /^allow_until: \d{4}-/m);
  } finally { f.cleanup(); }
});

test('--until without --allow is refused', () => {
  const f = registryFixture();
  try {
    const out = f.run(['add', 'Bare until', '--until', '+1d', '-m', 'x']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /--until needs --allow/);
  } finally { f.cleanup(); }
});

// ---------- Codex review 2026-09-07 ----------

test('a done-when runs in the card project, whose path is stored tilde-form', () => {
  const f = registryFixture();
  try {
    // The criterion asserts its own working directory; ROOT would fail it.
    const project = path.join(f.root, 'project');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'here'), 'x');
    assert.equal(f.run(['add', 'Cwd card', '--status', 'active', '--project', project,
      '--plan', 'A', '--done-when', 'test -f here', '-m', 'x']).status, 0);
    const out = f.run(['checkin', 'cwd-card', '--step', '1', '-m', 'done']);
    assert.equal(out.status, 0, out.stderr);
  } finally { f.cleanup(); }
});

test('a criterion cannot complete or verify the step it is judging', () => {
  const f = registryFixture();
  try {
    assert.equal(f.run(['add', 'Recur card', '--status', 'active', '--plan', 'A', '-m', 'x']).status, 0);
    const checkin = f.run(['checkin', 'recur-card', '--step', '1', '-m', 'x'], { KEEP_DONE_WHEN: '1' });
    assert.equal(checkin.status, 2, checkin.stdout);
    assert.match(checkin.stderr, /cannot complete a plan step/);

    const verify = f.run(['plan', 'recur-card', '--verify', '1'], { KEEP_DONE_WHEN: '1' });
    assert.notEqual(verify.status, 0);
    assert.match(verify.stderr, /cannot run keep plan --verify/);
  } finally { f.cleanup(); }
});

test('a stray line inside the Plan section invalidates the plan instead of losing steps', () => {
  // A duplicated done-when used to end parsing and silently move every later
  // step into the log, where nothing scheduled or completed it again.
  const parsed = parsePlan('## Plan\n- [ ] A\n  done-when: true\n  done-when: false\n- [ ] B\n\n## 2026-09-02 12:00 — x\ny\n');
  assert.equal(parsed.present, true);
  assert.equal(parsed.valid, false);
  assert.match(parsed.rest, /^## 2026-09-02/);
});

test('a malformed plan yields no next step, so the Stop hook cannot drive it', () => {
  const f = registryFixture();
  try {
    const project = path.join(f.root, 'project');
    fs.mkdirSync(project, { recursive: true });
    const sid = 'claude-plan-session';
    fs.writeFileSync(path.join(f.root, 'tasks', 'planned-card.md'), [
      '---', 'title: Planned card', 'status: active', 'kind: task', `project: ${project}`,
      'sessions:', `  - id: ${sid}`, '    agent: claude', '    at: 2026-09-02T12:00',
      'created: 2026-09-02', 'updated: 2026-09-02T12:00', '---',
      '## Plan', '- [ ] A', '  done-when: true', '  done-when: false', '- [ ] B', '',
      '## 2026-09-02 12:00 — created', 'Ready.', '',
    ].join('\n'));
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, interactive() + assistant('Finished a chunk.'));
    assert.equal(stop(f, { project, sid }, transcript).stdout, '');
  } finally { f.cleanup(); }
});

test('the authorization guard survives a state reload', () => {
  const f = registryFixture();
  try {
    const linked = writeLinkedCard(f, { allow: ['push'], steps: ['Only step'] });
    const transcript = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, interactive() + assistant('Shall I push it?'));
    assert.match(JSON.parse(stop(f, linked, transcript).stdout).reason, /already grants push/);
    // The second Stop reads the state back from disk; `authorized` has to
    // survive normalization or the hook blocks on the same ask forever.
    const state = JSON.parse(fs.readFileSync(path.join(f.root, '.keep', 'stopcheck', `${linked.sid}.json`), 'utf8'));
    assert.equal(state.authorized.task, 'planned-card');
    assert.equal(stop(f, linked, transcript).stdout, '');
  } finally { f.cleanup(); }
});
