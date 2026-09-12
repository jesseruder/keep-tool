'use strict';

process.env.KEEP_ALERT_CHANNELS = 'none';
for (const key of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[key];

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const {
  contributorSessionsForEntries,
  readTimestampWindowLines,
  stampedLogEntries,
} = require('./review.js');

test('contributor attribution is strict, batched, excluded, and separate from current owners', () => {
  const body = [
    '## 2026-09-12 12:09 — check-in (by claude newest-session)', 'newest', '',
    ...Array.from({ length: 8 }, (_, index) => {
      const minute = String(index + 1).padStart(2, '0');
      return `## 2026-09-12 12:${minute} — check-in (by claude contributor-${minute}) → active\nentry ${minute}\n`;
    }),
  ].join('\n');
  const selectedBatch = stampedLogEntries(body).slice(-8);
  const rows = contributorSessionsForEntries(selectedBatch, [{ id: 'contributor-01', agent: 'claude' }], new Set(['contributor-02']));
  assert.ok(!rows.some((row) => row.id === 'newest-session'), 'an entry outside this log batch contributes no transcript window');
  assert.ok(!rows.some((row) => row.id === 'contributor-01'), 'a current owner is already represented by its normal delta');
  assert.ok(!rows.some((row) => row.id === 'contributor-02'), 'reviewer and spawned session ids remain excluded');
  assert.deepEqual(rows.map((row) => row.id), ['contributor-03', 'contributor-04', 'contributor-05', 'contributor-06', 'contributor-07', 'contributor-08']);
  assert.equal(rows[0].windows[0].endMs - rows[0].windows[0].startMs + 1, 31 * 60e3);

  const malformed = contributorSessionsForEntries([
    { stamp: '2026-09-12 12:00', kind: 'check-in (by reviewer nope)' },
    { stamp: '2026-09-12 12:00', kind: 'check-in (by claude ../bad)' },
    { stamp: '2026-09-12 12:00', kind: 'check-in (by claude valid-id) trailing prose' },
  ], [], new Set());
  assert.deepEqual(malformed, []);
});

test('timestamp window scan finds old context before a long unrelated tail and caps matching evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-review-contributor-window-'));
  const file = path.join(dir, 'session.jsonl');
  const row = (timestamp, text) => `${JSON.stringify({ type: 'assistant', timestamp, message: { content: [{ type: 'text', text }] } })}\n`;
  try {
    fs.writeFileSync(file,
      row('2026-09-12T11:29:59.999Z', 'too early') +
      row('2026-09-12T11:30:00.000Z', 'window starts') +
      row('2026-09-12T11:59:59.999Z', 'window ends') +
      row('2026-09-12T12:00:00.000Z', 'future unrelated') +
      row('2026-09-12T18:00:00.000Z', 'x'.repeat(2 * 1024 * 1024)));
    const window = [{ startMs: Date.parse('2026-09-12T11:30:00.000Z'), endMs: Date.parse('2026-09-12T11:59:59.999Z') }];
    const found = readTimestampWindowLines(file, window, { maxScanBytes: 4 * 1024 * 1024, maxBytes: 1024 * 1024 });
    assert.equal(found.scanSkipped, 0, 'the scan reaches historical context despite a much larger later row');
    assert.equal(found.lines.length, 2);
    assert.match(found.lines.join('\n'), /window starts/);
    assert.match(found.lines.join('\n'), /window ends/);
    assert.doesNotMatch(found.lines.join('\n'), /too early|future unrelated|x{100}/);

    const capped = readTimestampWindowLines(file, [{ startMs: 0, endMs: Date.parse('2026-09-12T23:59:59Z') }], {
      maxScanBytes: 4 * 1024 * 1024,
      maxBytes: 250,
    });
    assert.ok(capped.skipped > 0);
    assert.equal(capped.oversized, 1, 'one huge JSONL record is omitted rather than defeating the evidence cap');
    assert.ok(capped.read <= 250);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bundle shows bounded contributor evidence and later unrelated activity does not requeue after ack', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-review-contributor-bundle-'));
  const root = path.join(base, 'keep');
  const home = path.join(base, 'home');
  const sid = 'contributor-full-session-id';
  const project = path.join(home, '.claude', 'projects', '-synthetic');
  const transcript = path.join(project, `${sid}.jsonl`);
  const cli = path.join(__dirname, 'keep.js');
  const env = { ...process.env, HOME: home, KEEP_DIR: root, KEEP_NO_PUSH: '1', KEEP_ALERT_CHANNELS: 'none' };
  delete env.KEEP_CONFIG;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    for (const dir of ['tasks', 'archive', 'digests', project]) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    spawnSync('git', ['init', '-q', root], { env });
    spawnSync('git', ['-C', root, 'config', 'user.name', 'Keep Test'], { env });
    spawnSync('git', ['-C', root, 'config', 'user.email', 'keep@example.test'], { env });

    const now = new Date();
    now.setSeconds(0, 0);
    const stamp = require('./keep.js').stampOf(now).replace('T', ' ');
    const inWindow = new Date(now.getTime() - 5 * 60e3).toISOString();
    const afterWindow = new Date(now.getTime() + 10 * 60e3).toISOString();
    fs.writeFileSync(path.join(root, 'tasks', 'shared-card.md'), [
      '---', 'title: Shared card', 'status: active', `created: ${stamp.slice(0, 10)}`, `updated: ${stamp.replace(' ', 'T')}`, '---',
      `## ${stamp} — check-in (by claude ${sid})`, 'Contributor completed the parser.', '',
    ].join('\n'));
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'assistant', timestamp: inWindow, message: { content: [{ type: 'tool_use', name: 'Bash', id: 'one', input: { command: 'node --test parser.test.js' } }] } }),
      JSON.stringify({ type: 'assistant', timestamp: afterWindow, message: { content: [{ type: 'text', text: 'UNRELATED_FUTURE_ACTIVITY' }] } }),
    ].join('\n') + '\n');

    const bundle = run(['review-bundle', 'shared-card', '--budget', '1500']);
    assert.equal(bundle.status, 0, bundle.stderr);
    assert.match(bundle.stdout, /## contributor context/);
    assert.match(bundle.stdout, new RegExp(`contributor ${sid} \\(claude\\)`));
    assert.match(bundle.stdout, /node --test parser\.test\.js/);
    assert.doesNotMatch(bundle.stdout, /UNRELATED_FUTURE_ACTIVITY/);
    assert.doesNotMatch(bundle.stdout, /sessions:\n\s+- id:/, 'contributor evidence does not mutate card ownership');
    const bundleId = bundle.stdout.match(/bundle: ([0-9a-f]{8})/)[1];
    assert.equal(run(['review-ack', 'shared-card', '--bundle', bundleId]).status, 0);

    fs.appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', timestamp: new Date(now.getTime() + 60 * 60e3).toISOString(), message: { content: [{ type: 'text', text: 'more unrelated work' }] } })}\n`);
    const queue = run(['review-queue', '--json']);
    assert.equal(queue.status, 0, queue.stderr);
    assert.ok(!JSON.parse(queue.stdout).ranked.some((row) => row.task === 'shared-card'));
    const noNew = run(['review-bundle', 'shared-card']);
    assert.equal(noNew.status, 3, noNew.stderr);
    assert.match(noNew.stderr, /no new evidence/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('scoped contributor bundles cannot advance a log batch past omitted evidence', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-review-contributor-scope-'));
  const root = path.join(base, 'keep');
  const home = path.join(base, 'home');
  const project = path.join(home, '.claude', 'projects', '-synthetic');
  const ids = ['contributor-session-a', 'contributor-session-b'];
  const cli = path.join(__dirname, 'keep.js');
  const env = { ...process.env, HOME: home, KEEP_DIR: root, KEEP_NO_PUSH: '1', KEEP_ALERT_CHANNELS: 'none' };
  for (const key of ['KEEP_CONFIG', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID']) delete env[key];
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    for (const dir of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    spawnSync('git', ['init', '-q', root], { env });
    spawnSync('git', ['-C', root, 'config', 'user.name', 'Keep Test'], { env });
    spawnSync('git', ['-C', root, 'config', 'user.email', 'keep@example.test'], { env });
    const now = new Date();
    now.setSeconds(0, 0);
    const stamp = require('./keep.js').stampOf(now).replace('T', ' ');
    const rowAt = new Date(now.getTime() - 2 * 60e3).toISOString();
    fs.writeFileSync(path.join(root, 'tasks', 'scoped-card.md'), [
      '---', 'title: Scoped card', 'status: active', `created: ${stamp.slice(0, 10)}`, `updated: ${stamp.replace(' ', 'T')}`, '---',
      `## ${stamp} — check-in (by claude ${ids[1]})`, 'B contribution.', '',
      `## ${stamp} — check-in (by claude ${ids[0]})`, 'A contribution.', '',
    ].join('\n'));
    ids.forEach((id, index) => fs.writeFileSync(path.join(project, `${id}.jsonl`), `${JSON.stringify({
      type: 'assistant', timestamp: rowAt,
      message: { content: [{ type: 'text', text: `CONTRIBUTOR_${index === 0 ? 'A' : 'B'}_ONLY` }] },
    })}\n`));

    const stateFile = path.join(root, '.keep', 'review', 'scoped-card.json');
    const scoped = run(['review-bundle', 'scoped-card', '--session', ids[0]]);
    assert.equal(scoped.status, 1, scoped.stderr);
    assert.match(scoped.stderr, /would omit contributor context/);
    assert.match(scoped.stderr, /remove --session.*--raw/);
    assert.equal(fs.existsSync(stateFile), false, 'refusal stages no bundle or log watermark');

    const unknown = run(['review-bundle', 'scoped-card', '--session', 'not-in-this-batch', '--raw']);
    assert.equal(unknown.status, 1, unknown.stderr);
    assert.match(unknown.stderr, /neither a linked owner nor an attributed contributor/);
    assert.equal(fs.existsSync(stateFile), false);

    const raw = run(['review-bundle', 'scoped-card', '--session', ids[0], '--raw']);
    assert.equal(raw.status, 0, raw.stderr);
    assert.match(raw.stdout, /CONTRIBUTOR_A_ONLY/);
    assert.doesNotMatch(raw.stdout, /CONTRIBUTOR_B_ONLY/);
    assert.equal(fs.existsSync(stateFile), false, 'raw contributor inspection does not stage the card log frontier');

    const complete = run(['review-bundle', 'scoped-card']);
    assert.equal(complete.status, 0, complete.stderr);
    assert.match(complete.stdout, /CONTRIBUTOR_A_ONLY/);
    assert.match(complete.stdout, /CONTRIBUTOR_B_ONLY/);
    const staged = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.deepEqual(staged.pendingLog, { stamp, count: 2 });
    assert.deepEqual(staged.sessions, {}, 'contributor evidence never creates transcript offsets');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
