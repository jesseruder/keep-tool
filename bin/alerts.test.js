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
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { route, alertDecision, buildBrief, deliver, sendAlert, loadMeta, readAlerts } = require('./alerts.js');

test('route table covers attention presence and quiet, urgent, and brief', () => {
  const now = Date.parse('2026-09-02T08:00:00');
  assert.deepEqual(route('attention', { state: 'present' }, now), { channels: ['sound'], deferred: false });
  assert.deepEqual(route('attention', { state: 'away' }, now), { channels: ['push'], deferred: false });
  assert.deepEqual(route('attention', { state: 'present', quietUntil: now + 60e3 }, now), { channels: [], deferred: true });
  assert.deepEqual(route('urgent', { state: 'present', quietUntil: now + 60e3 }, now), { channels: ['push', 'speak'], deferred: false });
  assert.deepEqual(route('urgent', { state: 'away' }, now), { channels: ['push', 'speak'], deferred: false });
  assert.deepEqual(route('brief', { state: 'present' }, now), { channels: ['push'], deferred: false });
  assert.deepEqual(route('brief', { state: 'away' }, now), { channels: ['push'], deferred: false });
});

test('alertDecision dedupes for six hours but allows an escalation', () => {
  const now = Date.parse('2026-09-02T10:00:00');
  const meta = { keys: { deploy: { at: now - 60e3, level: 'attention' } } };
  assert.equal(alertDecision(meta, { level: 'attention', key: 'deploy', caller: 'manual', now }).ok, false);
  assert.deepEqual(alertDecision(meta, { level: 'urgent', key: 'deploy', caller: 'manual', now }), { ok: true, why: 'allowed' });
  assert.equal(alertDecision({ keys: { deploy: { at: now - 7 * 3600e3, level: 'urgent' } } }, {
    level: 'urgent', key: 'deploy', caller: 'manual', now,
  }).ok, true);
});

test('alertDecision enforces daily caps and the urgent gap', () => {
  const now = Date.parse('2026-09-02T10:00:00');
  const day = '2026-09-02';
  assert.match(alertDecision({ days: { [day]: { attention: 12 } } }, {
    level: 'attention', key: 'a', caller: 'manual', now,
  }).why, /daily cap/);
  assert.match(alertDecision({ days: { [day]: { urgent: 4 } } }, {
    level: 'urgent', key: 'u', caller: 'manual', now,
  }).why, /daily cap/);
  assert.match(alertDecision({ lastUrgentAt: now - 10 * 60e3 }, {
    level: 'urgent', key: 'u2', caller: 'manual', now,
  }).why, /30-minute gap/);
});

test('alertDecision enforces the reviewer attention and urgent budgets', () => {
  const now = Date.parse('2026-09-02T10:00:00');
  const day = '2026-09-02';
  const meta = { days: { [day]: { callers: { reviewer: { attention: 5, urgent: 2 } } } } };
  assert.match(alertDecision(meta, { level: 'attention', key: 'a', caller: 'reviewer', now }).why, /reviewer attention/);
  assert.match(alertDecision(meta, { level: 'urgent', key: 'u', caller: 'reviewer', now }).why, /reviewer urgent/);
  assert.equal(alertDecision(meta, { level: 'attention', key: 'm', caller: 'manual', now }).ok, true);
});

test('buildBrief reports counts, caps review cards, and includes deferred alerts', () => {
  const now = Date.parse('2026-09-02T10:00:00');
  const tasks = Array.from({ length: 10 }, (_, index) => ({
    id: `review-${index}`,
    fm: { title: `Review card ${index}`, status: 'review', updated: `2026-09-0${index % 2 + 1}T08:00` },
    body: `## 2026-09-02 09:00 — review (fable)\nReviewer note\n\n## 2026-09-01 09:00 — check-in\nWorking state ${index}\n`,
  }));
  tasks.push({
    id: 'overdue',
    fm: { title: 'Run overdue check', status: 'waiting', check_after: '2026-09-01T09:00' },
    body: '',
  });
  const brief = buildBrief({
    tasks,
    questions: [{ id: 'q1', status: 'open', question: 'Which rollout?', answer: '' }],
    alerts: [{ at: now - 60e3, level: 'attention', text: 'Quiet alert', deferred: true, why: 'quiet' }],
    findings: [{ at: now - 60e3, severity: 'high', card: 'review-1', kind: 'data-loss' }],
    now,
  });
  assert.match(brief.text, /Keep brief — 10 need review, 1 question, 1 overdue check, 1 deferred alert, 1 finding/);
  assert.equal((brief.text.match(/^- Review card/gm) || []).length, 8);
  assert.match(brief.text, /Quiet alert/);
  assert.ok(brief.spoken.length <= 280);
  assert.ok(brief.text.length <= 1500);
});

function makeRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const directory of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  return root;
}

function cli(root, args, extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      KEEP_DIR: root,
      KEEP_NO_PUSH: '1',
      KEEP_ALERT_CHANNELS: 'none',
      KEEP_PUSH_WEBHOOK: 'http://127.0.0.1:1/unreachable',
      ...extraEnv,
    },
  });
}

test('announce argv separates a message starting with a dash from options', async () => {
  let argv;
  const fakeSpawn = (_command, args) => {
    argv = args;
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  };
  const outcomes = await deliver({ level: 'urgent', text: '--not-an-option', channels: ['speak'] }, { spawn: fakeSpawn });
  assert.deepEqual(argv, ['--from', 'Keep', '--', '--not-an-option']);
  assert.deepEqual(outcomes, { speak: 'ok' });
});

test('KEEP_REVIEWER with --from manual still counts against the reviewer budget', () => {
  const root = makeRoot('keep-alert-reviewer-budget-test-');
  try {
    const env = { KEEP_REVIEWER: '1' };
    for (let index = 0; index < 5; index += 1) {
      const accepted = cli(root, ['alert', '-m', `Finding ${index}`, '--level', 'attention', '--key', `finding-${index}`, '--from', 'manual'], env);
      assert.equal(accepted.status, 0, accepted.stderr);
    }
    const rejected = cli(root, ['alert', '-m', 'Finding 6', '--level', 'attention', '--key', 'finding-6', '--from', 'manual'], env);
    assert.equal(rejected.status, 5);
    assert.match(rejected.stderr, /reviewer attention daily budget/);
    const entries = readAlerts({ root, all: true });
    assert.equal(entries[0].from, 'manual');
    assert.equal(entries[0].caller, 'reviewer');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a non-reviewer claiming the reviewer display label is relabeled', () => {
  const root = makeRoot('keep-alert-claimed-reviewer-test-');
  try {
    const result = cli(root, ['alert', '-m', 'Claimed identity', '--level', 'attention', '--from', 'reviewer']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readAlerts({ root, all: true })[0].from, 'manual (claimed reviewer)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('two sequential brief sends claim the day once', async () => {
  const root = makeRoot('keep-brief-claim-test-');
  let deliveries = 0;
  const options = {
    root,
    level: 'brief',
    text: 'Morning brief',
    from: 'daemon',
    caller: 'manual',
    now: Date.parse('2026-09-02T08:00:00'),
    presence: { state: 'away' },
    availableChannels: (channels) => channels,
    deliver: async () => { deliveries += 1; return { push: 'ok' }; },
    withLock: (fn) => fn(),
  };
  try {
    const first = await sendAlert(options);
    const second = await sendAlert(options);
    assert.equal(first.deliveryOk, true);
    assert.equal(second.duplicate, true);
    assert.equal(deliveries, 1);
    assert.equal(loadMeta(root).lastBriefDay, '2026-09-02');
    assert.equal(readAlerts({ root, all: true }).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a totally failed brief releases the day for a later retry', async () => {
  const root = makeRoot('keep-brief-failure-test-');
  const now = Date.parse('2026-09-02T08:00:00');
  try {
    const result = await sendAlert({
      root,
      level: 'brief',
      text: 'Morning brief',
      from: 'daemon',
      caller: 'manual',
      now,
      presence: { state: 'away' },
      availableChannels: (channels) => channels,
      deliver: async () => ({ push: 'failed' }),
      withLock: (fn) => fn(),
    });
    assert.equal(result.deliveryOk, false);
    assert.equal(loadMeta(root).lastBriefDay, undefined);
    assert.equal(loadMeta(root).lastBriefAttemptAt, now);
    assert.deepEqual(readAlerts({ root, all: true })[0].delivered, { push: 'failed' });
    assert.equal(readAlerts({ root, all: true })[0].failed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI quiet writes quiet.json and alert --dry reports deferred', () => {
  const root = makeRoot('keep-alert-quiet-test-');
  try {
    const quiet = cli(root, ['quiet', '+2h']);
    assert.equal(quiet.status, 0, quiet.stderr);
    const saved = JSON.parse(fs.readFileSync(path.join(root, '.keep', 'quiet.json'), 'utf8'));
    assert.match(saved.until, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    const dry = cli(root, ['alert', '-m', 'Needs attention', '--level', 'attention', '--dry']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /deferred: quiet/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI alert --card appends a one-line alert log without claiming a session', () => {
  const root = makeRoot('keep-alert-card-test-');
  try {
    assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
    assert.equal(spawnSync('git', ['-C', root, 'config', 'user.name', 'Keep Test']).status, 0);
    assert.equal(spawnSync('git', ['-C', root, 'config', 'user.email', 'keep@example.test']).status, 0);
    fs.writeFileSync(path.join(root, 'tasks', 'card.md'), [
      '---',
      'title: Card',
      'status: active',
      'kind: task',
      'tags: [personal]',
      'created: 2026-09-02',
      'updated: 2026-09-02T08:00',
      '---',
      '',
      '## 2026-09-02 08:00 — created',
      'Initial state.',
      '',
    ].join('\n'));
    assert.equal(spawnSync('git', ['-C', root, 'add', '.']).status, 0);
    assert.equal(spawnSync('git', ['-C', root, 'commit', '-q', '-m', 'fixture']).status, 0);
    const result = cli(root, ['alert', '-m', 'Please inspect this', '--level', 'attention', '--card', 'card']);
    assert.equal(result.status, 0, result.stderr);
    const card = fs.readFileSync(path.join(root, 'tasks', 'card.md'), 'utf8');
    assert.match(card, /^alert \(attention\): Please inspect this$/m);
    assert.doesNotMatch(card, /^sessions:/m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the brief lists agents waiting on Owner above reviewer questions, and shadow decisions last', () => {
  const brief = buildBrief({
    tasks: [],
    questions: [
      { id: 'q-1', status: 'open', to: 'jesse', at: 1, task: 'deck-storage', question: 'Postgres or S3 for cauldron decks?' },
      { id: 'q-2', status: 'open', to: 'reviewer', at: 2, question: 'Is anything touching ghost-server right now?' },
    ],
    decisions: [
      { id: 'd-1', at: 3, type: 'continue', card: 'some-work', why: 'step 1 is done and nothing needs Owner', verdict: null },
      { id: 'd-2', at: 4, type: 'close', card: 'other-work', why: 'already judged', verdict: 'agree' },
    ],
    now: Date.parse('2026-09-07T12:00:00'),
  });
  assert.match(brief.text, /1 agent waiting on you/);
  assert.match(brief.text, /Agents waiting on your answer \(1\)/);
  assert.match(brief.text, /Postgres or S3/);
  assert.match(brief.text, /1 shadow decision/);
  assert.match(brief.text, /Shadow decisions \(nothing was sent\) \(1\)/);
  assert.match(brief.text, /d-1 continue/);
  assert.doesNotMatch(brief.text, /d-2/);
  // A parked agent outranks a reviewer question in the spoken line.
  assert.match(brief.spoken, /Agent waiting on you: Postgres or S3/);
  // The reviewer question is still listed, just not as Owner's own queue.
  assert.match(brief.text, /Questions \(1\)/);
});

test('a shadow decision never wins the spoken line', () => {
  const brief = buildBrief({
    tasks: [],
    decisions: [{ id: 'd-1', at: 1, type: 'continue', card: 'c', why: 'keep going', verdict: null }],
    now: Date.parse('2026-09-07T12:00:00'),
  });
  assert.match(brief.text, /1 shadow decision/);
  assert.match(brief.spoken, /Nothing needs attention\./);
});
