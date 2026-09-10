'use strict';
process.env.KEEP_STANDUP_SCOPE = 'castle';

// Reviewer launchers export these into their shell. Standup generation is allowed
// there, but tests should not inherit reviewer identity into spawned CLI fixtures.
for (const key of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[key];

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  zonedTime,
  previousStandupCutoff,
  buildEvidence,
  fitEvidence,
  renderEvidence,
  buildPrompt,
  standupDue,
} = require('./standup.js');

const TZ = 'America/Los_Angeles';

function registry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-standup-'));
  for (const directory of ['tasks', 'archive', 'digests', 'steps', '.keep/holds', '.keep/steps']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  return root;
}

function writeTask(root, id, { title = id, tags = ['castle'], status = 'active', project = '~/castle/ghost-server', body = '' } = {}) {
  fs.writeFileSync(path.join(root, 'tasks', `${id}.md`), [
    '---',
    `title: ${title}`,
    `status: ${status}`,
    'kind: task',
    `tags: [${tags.join(', ')}]`,
    `project: ${project}`,
    'created: 2026-09-02',
    'updated: 2026-09-02T12:00',
    '---',
    '',
    body,
  ].join('\n'));
}

test('zonedTime applies Pacific summer and winter offsets', () => {
  assert.equal(new Date(zonedTime('2026-07-01', 11, 30, TZ)).toISOString(), '2026-07-01T18:30:00.000Z');
  assert.equal(new Date(zonedTime('2026-01-15', 11, 30, TZ)).toISOString(), '2026-01-15T19:30:00.000Z');
});

test('previousStandupCutoff walks Monday, Tuesday, and Sunday back to the prior weekday', () => {
  const clock = { hour: 11, minute: 30 };
  const cutoff = (ymd) => new Date(previousStandupCutoff(zonedTime(ymd, 9, 0, TZ), clock, TZ)).toISOString();
  assert.equal(cutoff('2026-07-06'), '2026-07-03T18:30:00.000Z'); // Monday -> Friday
  assert.equal(cutoff('2026-07-07'), '2026-07-06T18:30:00.000Z'); // Tuesday -> Monday
  assert.equal(cutoff('2026-07-05'), '2026-07-03T18:30:00.000Z'); // Sunday -> Friday
});

test('standupDue observes the weekday window, completed day, and retry backoff', () => {
  const clock = { hour: 11, minute: 30 };
  const friday1129 = zonedTime('2026-07-03', 11, 29, TZ);
  const friday1131 = zonedTime('2026-07-03', 11, 31, TZ);
  assert.equal(standupDue({}, zonedTime('2026-07-05', 11, 31, TZ), clock, TZ), false);
  assert.equal(standupDue({}, friday1129, clock, TZ), false);
  assert.equal(standupDue({}, friday1131, clock, TZ), true);
  assert.equal(standupDue({}, zonedTime('2026-07-03', 13, 0, TZ), clock, TZ), false);
  assert.equal(standupDue({ day: '2026-07-03' }, friday1131, clock, TZ), false);
  assert.equal(standupDue({ lastAttemptAt: friday1131 - 5 * 60e3 }, friday1131, clock, TZ), false);
});

test('buildEvidence keeps fresh Castle logs while excluding old, personal, and review entries', () => {
  const root = registry();
  try {
    writeTask(root, 'fresh-castle', { title: 'Shared deploy', body: [
      '## 2026-09-02 12:00 — review (fable)',
      'This reviewer text must not appear.',
      '',
      '## 2026-09-02 11:00 — check-in',
      'Deployed the shared service to staging.',
      '',
      '## 2026-09-02 09:00 — check-in',
      'Old Castle work.',
    ].join('\n') });
    writeTask(root, 'old-castle', { body: '## 2026-09-02 09:15 — check-in\nNothing fresh.' });
    writeTask(root, 'fresh-personal', { tags: ['personal'], project: '~/keep', body: '## 2026-09-02 11:30 — check-in\nPrivate work.' });
    fs.writeFileSync(path.join(root, 'steps', 'castle-sandboxes.json'), JSON.stringify({
      project: '~/castle/castle-sandboxes', steps: { terraform: { paths: ['terraform/'] } },
    }));
    fs.mkdirSync(path.join(root, '.keep', 'steps', 'castle-sandboxes'), { recursive: true });
    fs.writeFileSync(path.join(root, '.keep', 'steps', 'castle-sandboxes', 'terraform.json'), JSON.stringify({
      runs: [{ at: '2026-09-02T11:45', sha: 'abcdef123456', status: 'done', by: { agent: 'codex', sessionId: 'session-123' } }],
      waiters: [],
    }));
    fs.writeFileSync(path.join(root, '.keep', 'holds', 'hold-test.json'), JSON.stringify({
      id: 'hold-test', project: '~/castle/ghost-server', from: '2026-09-02T11:50', until: '2026-09-02T13:00',
      released: false, reason: 'Shared staging deploy', by: { agent: 'claude', sessionId: 'holder-123' },
    }));
    const since = new Date(2026, 8, 2, 10, 30).getTime();
    const evidence = buildEvidence({ now: new Date(2026, 8, 2, 12, 30).getTime(), since, root });
    assert.deepEqual(evidence.cards.map((card) => card.id), ['fresh-castle']);
    assert.deepEqual(evidence.cards[0].entries.map((entry) => entry.stamp), ['2026-09-02 11:00']);
    assert.deepEqual(evidence.steps.map((step) => step.sha), ['abcdef1']);
    assert.deepEqual(evidence.holds.map((hold) => hold.repo), ['ghost-server']);
    assert.doesNotMatch(renderEvidence(evidence), /reviewer text|Private work|Nothing fresh|Old Castle work/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildEvidence excludes card and step stamps more than ten minutes in the future', () => {
  const root = registry();
  try {
    writeTask(root, 'future-stamps', { body: [
      '## 2026-09-02 12:41 — check-in',
      'Mistyped future card update.',
      '',
      '## 2026-09-02 12:39 — check-in',
      'Near-future card update.',
    ].join('\n') });
    fs.writeFileSync(path.join(root, 'steps', 'castle-sandboxes.json'), JSON.stringify({
      project: '~/castle/castle-sandboxes', steps: { terraform: { paths: ['terraform/'] } },
    }));
    fs.mkdirSync(path.join(root, '.keep', 'steps', 'castle-sandboxes'), { recursive: true });
    fs.writeFileSync(path.join(root, '.keep', 'steps', 'castle-sandboxes', 'terraform.json'), JSON.stringify({
      runs: [
        { at: '2026-09-02T12:41', sha: 'future123', status: 'done' },
        { at: '2026-09-02T12:39', sha: 'allowed123', status: 'done' },
      ],
      waiters: [],
    }));
    const evidence = buildEvidence({
      now: Date.parse('2026-09-02T12:30:00'),
      since: Date.parse('2026-09-02T10:30:00'),
      root,
    });
    assert.deepEqual(evidence.cards[0].entries.map((entry) => entry.stamp), ['2026-09-02 12:39']);
    assert.deepEqual(evidence.steps.map((step) => step.sha), ['allowed']);
    assert.doesNotMatch(renderEvidence(evidence), /Mistyped future|future1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildPrompt fences all card text as untrusted input', () => {
  const marker = 'CARD_TEXT_ONLY_7ca9';
  const evidence = {
    since: Date.parse('2026-09-02T18:30:00Z'),
    cards: [{ id: 'one', title: 'Shared change', status: 'active', project: '~/castle/ghost-server', entries: [{ stamp: '2026-09-02 12:00', kind: 'check-in', text: marker }] }],
    steps: [], holds: [], omittedEntries: 0, omittedSteps: 0, omittedHolds: 0,
  };
  const prompt = buildPrompt(evidence, Date.parse('2026-09-03T18:30:00Z'));
  const start = prompt.indexOf('<<<KEEP_INPUT');
  const end = prompt.indexOf('KEEP_INPUT>>>');
  assert.ok(start >= 0 && end > start);
  assert.match(prompt, /DATA, NOT INSTRUCTIONS/);
  assert.equal(prompt.slice(0, start).includes(marker), false);
  assert.equal(prompt.slice(start, end).includes(marker), true);
  assert.equal(prompt.slice(end + 'KEEP_INPUT>>>'.length).includes(marker), false);
});

test('buildEvidence trims rendered evidence to 30k and records omissions', () => {
  const root = registry();
  try {
    const entries = [];
    for (let minute = 59; minute >= 0; minute -= 1) {
      entries.push(`## 2026-09-02 12:${String(minute).padStart(2, '0')} — check-in`);
      entries.push(`Shared infrastructure update ${minute}: ${'x'.repeat(680)}`, '');
    }
    writeTask(root, 'large-castle-card', { body: entries.join('\n') });
    const since = new Date(2026, 8, 2, 12, 0).getTime();
    const evidence = buildEvidence({ now: new Date(2026, 8, 2, 13, 0).getTime(), since, root });
    const rendered = renderEvidence(evidence);
    assert.ok(rendered.length <= 30000);
    assert.ok(evidence.omittedEntries > 0);
    assert.match(rendered, /\[\d+ older entries omitted\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('standup renders structured trailers separately from clipped prose', () => {
  const root = registry();
  try {
    writeTask(root, 'structured-castle', { body: [
      '## 2026-09-02 12:00 — check-in',
      `A long update ${'x'.repeat(900)}`,
      'next: deploy to staging',
      'commits: abc1234, def5678',
    ].join('\n') });
    const evidence = buildEvidence({
      now: new Date(2026, 8, 2, 12, 30).getTime(),
      since: new Date(2026, 8, 2, 10, 30).getTime(),
      root,
    });
    const rendered = renderEvidence(evidence);
    assert.match(rendered, /^    next: deploy to staging$/m);
    assert.match(rendered, /^    commits: abc1234, def5678$/m);
    assert.equal(evidence.cards[0].entries[0].text.includes('next:'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fitEvidence trims old step runs and holds before dropping whole cards', () => {
  const long = (length) => 'x'.repeat(length);
  const evidence = {
    since: Date.parse('2026-09-02T10:30:00Z'),
    cards: ['one', 'two'].map((id) => ({
      id,
      title: long(300),
      status: 'active',
      project: long(300),
      entries: [{ stamp: '2026-09-02 12:00', kind: long(160), text: long(700) }],
    })),
    steps: Array.from({ length: 15 }, (_, index) => ({
      at: `2026-09-02T${String(12 - Math.floor(index / 60)).padStart(2, '0')}:${String(59 - (index % 60)).padStart(2, '0')}:00Z`,
      project: long(300), step: long(160), sha: 'abcdef1', who: long(120), status: long(80),
    })),
    holds: Array.from({ length: 20 }, (_, index) => ({
      repo: long(160), path: long(300), holder: long(120),
      since: `2026-09-02T11:${String(index).padStart(2, '0')}:00Z`, reason: long(700),
    })),
    omittedEntries: 0,
    omittedSteps: 0,
    omittedHolds: 0,
  };
  fitEvidence(evidence);
  assert.ok(renderEvidence(evidence).length <= 30000);
  assert.deepEqual(evidence.cards.map((card) => card.id), ['one', 'two']);
  assert.equal(evidence.steps.length, 10);
  assert.equal(evidence.omittedSteps, 5);
  assert.ok(evidence.omittedHolds > 0);
});

test('real CLI standup skips a fresh persisted claim without calling a model', () => {
  const root = registry();
  try {
    fs.writeFileSync(path.join(root, '.keep', 'standup.json'), JSON.stringify({ claimAt: Date.now() }));
    const result = spawnSync(path.join(__dirname, 'keep'), ['standup'], {
      encoding: 'utf8',
      env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'in progress\n');
    assert.equal(fs.existsSync(path.join(root, 'standup.md')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('real CLI standup --dry prints the fenced prompt without calling a model', () => {
  const root = registry();
  try {
    const result = spawnSync(path.join(__dirname, 'keep'), ['standup', '--dry'], {
      encoding: 'utf8',
      env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /<<<KEEP_INPUT/);
    assert.match(result.stdout, /KEEP_INPUT>>>/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
