'use strict';

// Tests spawned from a reviewer session must not inherit reviewer identity.
for (const key of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[key];

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const decisions = require('./decisions.js');

const CLI = path.join(__dirname, 'keep.js');

function registry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-decisions-'));
  const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' };
  for (const key of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID']) delete env[key];
  for (const directory of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q', root], { env }).status, 0);
  spawnSync('git', ['-C', root, 'config', 'user.name', 'Keep Test'], { env });
  spawnSync('git', ['-C', root, 'config', 'user.email', 'keep@example.test'], { env });
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: root, env });
  assert.equal(run(['add', 'Some work', '--status', 'active', '--tag', 'personal', '-m', 'x']).status, 0);
  return { root, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function decide(f, args) {
  const out = f.run(['decide', ...args]);
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim().split('\n')[0];
}

test('a decision records the exact message, not a summary', () => {
  const f = registry();
  try {
    const missing = f.run(['decide', 'continue', '--card', 'some-work', '-m', 'it finished a chunk']);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /--send .* is required/);

    const id = decide(f, ['continue', '--card', 'some-work', '--send', 'Continue with step 2.', '-m', 'step 1 is done']);
    const stored = JSON.parse(fs.readFileSync(path.join(f.root, '.keep', 'decisions.json'), 'utf8'));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, id);
    assert.equal(stored[0].message, 'Continue with step 2.');
    assert.equal(stored[0].verdict, null);
  } finally { f.cleanup(); }
});

test('escalate is the one type that needs no message', () => {
  const f = registry();
  try {
    const id = decide(f, ['escalate', '--card', 'some-work', '-m', 'this migration is destructive']);
    assert.match(id, /^d-/);
  } finally { f.cleanup(); }
});

test('an unknown type and an unknown card are both refused', () => {
  const f = registry();
  try {
    const type = f.run(['decide', 'vibes', '--send', 'x', '-m', 'y']);
    assert.notEqual(type.status, 0);
    assert.match(type.stderr, /--type must be one of/);

    const card = f.run(['decide', 'continue', '--card', 'no-such-card', '--send', 'x', '-m', 'y']);
    assert.notEqual(card.status, 0);
    assert.match(card.stderr, /no task "no-such-card"/);
  } finally { f.cleanup(); }
});

test('recording a decision sends nothing and changes no card', () => {
  const f = registry();
  try {
    const before = fs.readFileSync(path.join(f.root, 'tasks', 'some-work.md'), 'utf8');
    decide(f, ['status', '--card', 'some-work', '--send', 'Moving this to review.', '-m', 'the work looks done']);
    assert.equal(fs.readFileSync(path.join(f.root, 'tasks', 'some-work.md'), 'utf8'), before);
  } finally { f.cleanup(); }
});

test('disagree and edit need a reason; agree does not', () => {
  const f = registry();
  try {
    const id = decide(f, ['continue', '--card', 'some-work', '--send', 'Go on.', '-m', 'step 1 done']);
    const bare = f.run(['decisions', 'disagree', id]);
    assert.notEqual(bare.status, 0);
    assert.match(bare.stderr, /needs -m "why"/);

    const other = decide(f, ['close', '--card', 'some-work', '--send', 'Closing this.', '-m', 'nothing left']);
    assert.equal(f.run(['decisions', 'agree', other]).status, 0);
  } finally { f.cleanup(); }
});

test('a decision takes exactly one verdict', () => {
  const f = registry();
  try {
    const id = decide(f, ['continue', '--card', 'some-work', '--send', 'Go on.', '-m', 'step 1 done']);
    assert.equal(f.run(['decisions', 'agree', id]).status, 0);
    const again = f.run(['decisions', 'disagree', id, '-m', 'changed my mind']);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /already marked agree/);
  } finally { f.cleanup(); }
});

test('the default listing shows only what still needs a verdict', () => {
  const f = registry();
  try {
    const judged = decide(f, ['continue', '--card', 'some-work', '--send', 'Go on.', '-m', 'step 1 done']);
    const pending = decide(f, ['close', '--card', 'some-work', '--send', 'Closing.', '-m', 'nothing left']);
    assert.equal(f.run(['decisions', 'agree', judged]).status, 0);

    const open = f.run(['decisions']);
    assert.match(open.stdout, new RegExp(pending));
    assert.doesNotMatch(open.stdout, new RegExp(judged));

    const all = f.run(['decisions', '--all']);
    assert.match(all.stdout, new RegExp(judged));

    const filtered = f.run(['decisions', '--all', '--type', 'close']);
    assert.match(filtered.stdout, new RegExp(pending));
    assert.doesNotMatch(filtered.stdout, new RegExp(judged));
  } finally { f.cleanup(); }
});

// ---------- scoring ----------

test('stats count an edit against the type, not for it', () => {
  const rows = [
    { type: 'continue', verdict: 'agree' },
    { type: 'continue', verdict: 'agree' },
    { type: 'continue', verdict: 'edit' },
    { type: 'continue', verdict: 'disagree' },
    { type: 'close', verdict: null },
  ];
  const result = decisions.stats(rows);
  const cont = result.rows.find((row) => row.type === 'continue');
  assert.equal(cont.judged, 4);
  assert.equal(cont.agree, 2);
  assert.equal(cont.rate, 0.5);
  assert.equal(cont.ready, false);

  const close = result.rows.find((row) => row.type === 'close');
  assert.equal(close.pending, 1);
  assert.equal(close.rate, null);
  assert.equal(close.ready, false);

  assert.equal(result.totals.judged, 4);
  assert.equal(result.totals.pending, 1);
});

test('a type is ready only at both the rate and the volume', () => {
  const agreeing = (n, verdict = 'agree') => Array.from({ length: n }, () => ({ type: 'continue', verdict }));

  // Perfect but too few.
  assert.equal(decisions.stats(agreeing(29)).rows.find((row) => row.type === 'continue').ready, false);
  // Enough, and above the rate.
  assert.equal(decisions.stats(agreeing(30)).rows.find((row) => row.type === 'continue').ready, true);
  // Enough, but under the rate: 27 of 30 is exactly 90%, 26 is not.
  const mixed = [...agreeing(26), ...agreeing(4, 'disagree')];
  assert.equal(decisions.stats(mixed).rows.find((row) => row.type === 'continue').ready, false);
  const exact = [...agreeing(27), ...agreeing(3, 'disagree')];
  assert.equal(decisions.stats(exact).rows.find((row) => row.type === 'continue').ready, true);
});

test('stats render every type even with no data', () => {
  const text = decisions.renderStats(decisions.stats([]));
  for (const type of Object.keys(decisions.TYPES)) assert.match(text, new RegExp(type));
  assert.match(text, /0 awaiting your verdict/);
});

test('keep decisions stats --json is machine readable', () => {
  const f = registry();
  try {
    const id = decide(f, ['continue', '--card', 'some-work', '--send', 'Go on.', '-m', 'step 1 done']);
    assert.equal(f.run(['decisions', 'agree', id]).status, 0);
    const out = f.run(['decisions', 'stats', '--json']);
    assert.equal(out.status, 0, out.stderr);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.totals.judged, 1);
    assert.equal(parsed.rows.find((row) => row.type === 'continue').agree, 1);
  } finally { f.cleanup(); }
});

test('a damaged ledger is never silently overwritten', () => {
  const f = registry();
  try {
    const id = decide(f, ['continue', '--card', 'some-work', '--send', 'Go on.', '-m', 'step 1 done']);
    const file = path.join(f.root, '.keep', 'decisions.json');
    fs.writeFileSync(file, '{ this is not json');

    const record = f.run(['decide', 'close', '--card', 'some-work', '--send', 'Closing.', '-m', 'nothing left']);
    assert.notEqual(record.status, 0);
    assert.match(record.stderr, /not valid JSON/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json');

    const list = f.run(['decisions']);
    assert.notEqual(list.status, 0);
    assert.match(list.stderr, /refusing to overwrite/);

    // Repairing it brings the history back untouched.
    fs.writeFileSync(file, JSON.stringify([{ id, at: Date.now(), type: 'continue', why: 'x', message: 'y', verdict: null }]));
    assert.equal(f.run(['decisions']).status, 0);
  } finally { f.cleanup(); }
});

test('a ledger that is valid JSON but not an array is refused too', () => {
  const f = registry();
  try {
    fs.mkdirSync(path.join(f.root, '.keep'), { recursive: true });
    fs.writeFileSync(path.join(f.root, '.keep', 'decisions.json'), '{"decisions":[]}');
    const out = f.run(['decide', 'close', '--card', 'some-work', '--send', 'x', '-m', 'y']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /not a JSON array/);
  } finally { f.cleanup(); }
});
