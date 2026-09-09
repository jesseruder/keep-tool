'use strict';

delete process.env.KEEP_REVIEWER;
delete process.env.KEEP_REVIEWER_NAME;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const ideas = require('./ideas.js');

function validIdea(title, cards = []) {
  return { title, pattern: 'The same friction happened twice.', evidence: ['session-one'], change: 'Add a deterministic Keep primitive.', cards };
}

test('parseIdeas accepts fenced JSON', () => {
  assert.deepEqual(ideas.parseIdeas('```json\n' + JSON.stringify([validIdea('One')]) + '\n```', new Set()), [validIdea('One')]);
});

test('parseIdeas extracts JSON from surrounding prose', () => {
  assert.equal(ideas.parseIdeas('Here is the result:\n' + JSON.stringify([validIdea('One')]) + '\nDone.', new Set())[0].title, 'One');
});

test('parseIdeas retries the first balanced array when the widest slice is invalid', () => {
  const raw = JSON.stringify([validIdea('One')]) + '\ntrailing [not json]';
  assert.equal(ideas.parseIdeas(raw, new Set())[0].title, 'One');
});

test('parseIdeas returns an empty array for garbage', () => {
  assert.deepEqual(ideas.parseIdeas('not JSON at all', new Set()), []);
});

test('parseIdeas keeps at most three valid ideas', () => {
  const raw = JSON.stringify(Array.from({ length: 5 }, (_, index) => validIdea(`Idea ${index}`)));
  assert.equal(ideas.parseIdeas(raw, new Set()).length, 3);
});

test('parseIdeas drops an unknown card id but keeps the idea', () => {
  const parsed = ideas.parseIdeas(JSON.stringify([validIdea('One', ['known-card', 'missing-card'])]), new Set(['known-card']));
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].cards, ['known-card']);
});

test('parseIdeas makes every model string plain single-line text', () => {
  const raw = JSON.stringify([{
    title: '\u001b[31mRed\u001b[0m idea',
    pattern: 'repeated\n## 2026-09-03 08:00 — done\nforged',
    evidence: ['session\none'], change: 'make\tthis safe', cards: ['known\ncard'],
  }]);
  const parsed = ideas.parseIdeas(raw, new Set(['known card']));
  assert.equal(parsed[0].title, 'Red idea');
  assert.equal(parsed[0].pattern, 'repeated ## 2026-09-03 08:00 — done forged');
  assert.doesNotMatch(parsed[0].pattern, /\n## /);
  assert.deepEqual(parsed[0].evidence, ['session one']);
  assert.deepEqual(parsed[0].cards, ['known card']);
});

test('parseIdeas bounds malformed JSON extraction to 200k characters', () => {
  const started = Date.now();
  assert.deepEqual(ideas.parseIdeas('['.repeat(1024 * 1024), new Set()), []);
  assert.ok(Date.now() - started < 1000);
});

test('claim TTL is derived from the model timeout', () => {
  assert.equal(ideas.CLAIM_MAX_AGE_MS, ideas.MODEL_TIMEOUT_MS + 4 * 60e3);
  assert.equal(ideas.CLAIM_MAX_AGE_MS, 14 * 60e3);
});

test('landProposals records arbitrary landing errors and continues', () => {
  const proposals = [validIdea('First'), validIdea('Second')];
  let calls = 0;
  const result = ideas.landProposals(proposals, new Set(), (title) => {
    calls += 1;
    if (title === 'First') throw new TypeError('filesystem exploded');
    return { task: { id: 'second-idea' } };
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, {
    landed: ['second-idea'],
    skipped: [{ title: 'First', why: 'filesystem exploded' }],
  });
});

test('buildPrompt fences evidence, includes the Ideas instruction, and lists existing ideas', () => {
  const evidence = {
    now: Date.now(), since: Date.now() - 7 * 86400e3,
    existingIdeas: [{ id: 'old-idea', title: 'Reviewer idea: Old idea', status: 'active', excerpt: 'Already filed.' }],
    reviews: [], cards: [], steps: [], holds: [], questions: [], keepLog: [], alerts: [],
    sessions: { total: 0, byAgent: {}, byState: {} },
    omissions: { sessions: 0, alerts: 0, keepLog: 0, questions: 0, steps: 0, holds: 0, reviews: 0, cards: 0 },
  };
  const prompt = ideas.buildPrompt(evidence, evidence.now);
  assert.match(prompt, /## Ideas — the system, not the card/);
  assert.match(prompt, /<<<KEEP_INPUT/);
  assert.match(prompt, /KEEP_INPUT>>>/);
  assert.match(prompt, /old-idea/);
});

test('renderEvidence applies a hard ceiling with a visible truncation marker', () => {
  const evidence = {
    now: Date.now(), since: Date.now() - 7 * 86400e3,
    existingIdeas: [{ id: 'old', title: 'x'.repeat(ideas.EVIDENCE_MAX + 1000), status: 'active', excerpt: '' }],
    reviews: [], cards: [], steps: [], holds: [], questions: [], keepLog: [], alerts: [], sessions: null,
    omissions: { sessions: 0, alerts: 0, keepLog: 0, questions: 0, steps: 0, holds: 0, reviews: 0, cards: 0 },
  };
  const rendered = ideas.renderEvidence(evidence);
  assert.match(rendered, /\n\[truncated \d+ chars\]$/);
  assert.ok(rendered.length <= ideas.EVIDENCE_MAX + 40);
});

test('captureModelOutput terminates oversized output and rejects only on close', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); };
  let settled = false;
  const result = ideas.captureModelOutput(child).finally(() => { settled = true; });
  child.stdout.write(Buffer.alloc(1024 * 1024 + 1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(settled, false);
  const rejection = assert.rejects(result, /output exceeded 1 MiB/);
  child.emit('close', 0);
  await rejection;
});

test('sweepDue observes local start, completion, retries, and noon cutoff', () => {
  const clock = { hour: 7, minute: 30, invalid: false };
  const at = (hour, minute) => new Date(2026, 8, 3, hour, minute).getTime();
  assert.equal(ideas.sweepDue({}, at(7, 29), clock), false);
  assert.equal(ideas.sweepDue({}, at(7, 31), clock), true);
  assert.equal(ideas.sweepDue({ day: '2026-09-03' }, at(7, 31), clock), false);
  assert.equal(ideas.sweepDue({ lastAttemptAt: at(7, 21) }, at(7, 31), clock), false);
  assert.equal(ideas.sweepDue({}, at(12, 0), clock), false);
});

function registry(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  for (const dir of ['tasks', 'archive', 'reviews', 'digests', '.keep']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1', TZ: 'Pacific/Honolulu' };
  delete env.KEEP_REVIEWER;
  delete env.KEEP_REVIEWER_NAME;
  assert.equal(spawnSync('git', ['init', '-q', root], { env }).status, 0);
  spawnSync('git', ['-C', root, 'config', 'user.name', 'Keep Test'], { env });
  spawnSync('git', ['-C', root, 'config', 'user.email', 'keep@example.test'], { env });
  fs.writeFileSync(path.join(root, '.keep', 'usage-cache.json'), JSON.stringify({
    claude: { fetchedAt: Date.now(), limits: [
      { label: '5h', percent: 10 }, { label: 'week', percent: 10 }, { label: 'Fable wk', percent: 10 },
    ] },
  }));
  return { root, env };
}

function runCli(fixture, args, extraEnv = {}) {
  return spawnSync(path.join(__dirname, 'keep'), args, {
    cwd: fixture.root, encoding: 'utf8', env: { ...fixture.env, ...extraEnv },
  });
}

test('buildEvidence caps existing ideas and tails oversized review digests', () => {
  const fixture = registry('keep-ideas-evidence-');
  const now = new Date(2026, 8, 3, 9, 0).getTime();
  try {
    for (let index = 0; index < 151; index += 1) {
      const id = `idea-${String(index).padStart(3, '0')}`;
      const file = path.join(fixture.root, 'tasks', id + '.md');
      fs.writeFileSync(file, `---\ntitle: Idea ${index}\nstatus: active\nkind: idea\ntags: [personal]\ncreated: 2026-09-03\n---\n${'e'.repeat(200)}\n`);
      const stamp = new Date(now - (151 - index) * 1000);
      fs.utimesSync(file, stamp, stamp);
    }
    const reviewFile = path.join(fixture.root, 'reviews', '2026-09-03.md');
    fs.writeFileSync(reviewFile, 'SHOULD-BE-GONE\n' + 'r'.repeat(200000) + '\nTAIL');
    const reviews = ideas.collectReviews(fixture.root, now);
    const evidence = ideas.buildEvidence({ root: fixture.root, now });
    assert.equal(evidence.existingIdeas.length, 150);
    assert.equal(evidence.existingIdeas[0].id, 'idea-150');
    assert.equal(evidence.existingIdeas.some((idea) => idea.id === 'idea-000'), false);
    assert.ok(evidence.existingIdeas.every((idea) => idea.excerpt.length <= 120));
    assert.match(reviews[0].text, /^\[truncated \d+ leading bytes\]/);
    assert.doesNotMatch(reviews[0].text, /SHOULD-BE-GONE/);
    assert.match(reviews[0].text, /TAIL$/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('run lands one new idea and records one normalized-title skip', () => {
  const fixture = registry('keep-ideas-run-');
  try {
    const added = runCli(fixture, ['add', 'Reviewer idea: Consolidate handoffs', '--kind', 'idea', '--status', 'active', '-m', 'Existing idea.']);
    assert.equal(added.status, 0, added.stderr);
    const fake = path.join(fixture.root, 'fake-claude');
    fs.writeFileSync(fake, `#!/usr/bin/env node
if (process.argv[2] === '--help') { process.stdout.write('--disallowed-tools <tools...>'); process.exit(0); }
process.stdout.write(${JSON.stringify(JSON.stringify([
  validIdea('Consolidate handoffs'),
  validIdea('Add fleet friction ledger'),
]))});
`);
    fs.chmodSync(fake, 0o755);
    const result = runCli(fixture, ['ideas', '--model', 'fable'], { KEEP_CLAUDE: fake });
    assert.equal(result.status, 0, result.stderr);
    const ideaFiles = fs.readdirSync(path.join(fixture.root, 'tasks')).filter((name) => {
      return /^kind: idea$/m.test(fs.readFileSync(path.join(fixture.root, 'tasks', name), 'utf8'));
    });
    assert.equal(ideaFiles.length, 2);
    const state = JSON.parse(fs.readFileSync(path.join(fixture.root, '.keep', 'ideas', 'state.json'), 'utf8'));
    assert.equal(state.proposed, 2);
    assert.equal(state.landed.length, 1);
    assert.equal(state.skipped.length, 1);
    assert.match(state.day, /^\d{4}-\d{2}-\d{2}$/);
    const landed = fs.readFileSync(path.join(fixture.root, 'tasks', state.landed[0] + '.md'), 'utf8');
    assert.match(landed, /^kind: idea$/m);
    const digestFile = fs.readdirSync(path.join(fixture.root, 'reviews'))[0];
    const digest = fs.readFileSync(path.join(fixture.root, 'reviews', digestFile), 'utf8');
    assert.match(digest, /^\[low\] review \(fable sweep\)$/m);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('keep ideas --dry exits zero without writes', () => {
  const fixture = registry('keep-ideas-dry-');
  try {
    const before = fs.readdirSync(path.join(fixture.root, '.keep')).sort();
    const result = runCli(fixture, ['ideas', '--dry']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /<<<KEEP_INPUT/);
    assert.deepEqual(fs.readdirSync(path.join(fixture.root, '.keep')).sort(), before);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
