'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const obligations = require('./review-obligations.js');
const allow = require('./allow.js');

const HOUR = 3600e3;
const commit = (sha, patchId, subject = 'a change') => ({ sha, patchId, subject });

function pending(over = {}) {
  return {
    id: 'obl-1', at: new Date(Date.now() - HOUR).toISOString(), card: 'a-card',
    job: 'job-42', accountId: 'codex-secondary', by: 'codex sol',
    commits: [commit('a'.repeat(40), 'p1')],
    state: 'open', stateAt: new Date(Date.now() - HOUR).toISOString(), note: '', session: null,
    ...over,
  };
}

// ---------- opening one ----------

test('an obligation must name a job and the commits it covers', () => {
  assert.throws(() => obligations.open({ card: 'a-card', commits: [commit('a', 'p')] }), /needs --job/);
  assert.throws(() => obligations.open({ card: 'a-card', job: 'job-1' }), /needs --commit/);
  assert.throws(() => obligations.open({ card: 'a-card', job: 'not a job id', commits: [commit('a', 'p')] }), /not a Codex job id/);
  const record = obligations.open({ card: 'a-card', job: 'job-1', commits: [commit('a', 'p')], accountId: 'codex-secondary' });
  assert.equal(record.state, 'open');
  assert.equal(record.job, 'job-1');
  assert.match(record.id, /^obl-/);
});

// ---------- the decision ----------

test('a job Keep cannot find is given a grace period, then fails', () => {
  const now = Date.now();
  const young = pending({ at: new Date(now - 60e3).toISOString() });
  assert.equal(obligations.decide(young, { job: null, now }), null, 'the companion may not have written it yet');
  const old = pending({ at: new Date(now - 30 * 60e3).toISOString() });
  const verdict = obligations.decide(old, { job: null, now });
  assert.equal(verdict.state, 'failed');
  assert.match(verdict.note, /cannot find Codex job job-42 in account codex-secondary/);
});

test('a finished job becomes a verdict Keep is waiting for, and says so once', () => {
  const now = Date.now();
  const first = obligations.decide(pending(), { job: { status: 'completed' }, now });
  assert.equal(first.state, 'awaiting-verdict');
  const again = obligations.decide(pending({ state: 'awaiting-verdict' }), { job: { status: 'completed' }, now });
  assert.equal(again, null, 'an announced obligation is not announced every five minutes');
});

test('a review that came back settles the obligation whatever it found', () => {
  const now = Date.now();
  for (const verdict of ['clean', 'findings']) {
    const decision = obligations.decide(pending({ state: 'awaiting-verdict' }), {
      job: { status: 'completed' }, reviewRecords: [{ id: 'rev-1', job: 'job-42', verdict }], now,
    });
    assert.equal(decision.state, 'satisfied', `a ${verdict} verdict is still a verdict`);
  }
  // A record citing some other job is not this obligation's answer.
  assert.equal(obligations.decide(pending(), {
    job: { status: 'completed' }, reviewRecords: [{ id: 'rev-2', job: 'job-99', verdict: 'clean' }], now,
  }).state, 'awaiting-verdict');
});

test('a dead, stalled, failed or endless job fails the obligation rather than passing it', () => {
  const now = Date.now();
  const cases = [
    [{ job: { status: 'failed' } }, 'failed', /ended failed without a verdict/],
    [{ job: { status: 'cancelled' } }, 'failed', /ended cancelled/],
    [{ job: { status: 'running' }, live: { state: 'dead', reason: 'process is gone' } }, 'failed', /is dead \(process is gone\)/],
    [{ job: { status: 'running' }, live: { state: 'stalled', idleMs: 45 * 60e3 } }, 'failed', /idle for 45 minutes/],
  ];
  for (const [input, state, note] of cases) {
    const decision = obligations.decide(pending(), { ...input, now });
    assert.equal(decision.state, state);
    assert.match(decision.note, note);
    // The point of the whole mechanism: a job that died is never a clean review.
    assert.notEqual(decision.state, 'satisfied');
  }
  // A job still running, with nothing saying it is dead, is simply not settled yet…
  assert.equal(obligations.decide(pending(), { job: { status: 'running' }, live: { state: 'running' }, now }), null);
  assert.equal(obligations.decide(pending(), { job: { status: 'running' }, live: { state: 'stalled', idleMs: 5 * 60e3 }, now }), null);
  // …until it has been running for longer than any review takes.
  const endless = obligations.decide(pending({ at: new Date(now - 8 * HOUR).toISOString() }), { job: { status: 'running' }, now });
  assert.equal(endless.state, 'abandoned');
  assert.match(endless.note, /running for 8h/);
});

test('a terminal obligation is never reopened by the sweep', () => {
  const now = Date.now();
  for (const state of obligations.TERMINAL_STATES) {
    assert.equal(obligations.decide(pending({ state }), { job: { status: 'completed' }, now }), null);
  }
});

// ---------- what it blocks ----------

test('an obligation is outstanding only for the commits it covers', () => {
  const records = [pending(), pending({ id: 'obl-2', job: 'job-7', commits: [commit('b'.repeat(40), 'p2')] })];
  const landing = [commit('a'.repeat(40), 'p1')];
  assert.deepEqual(obligations.outstandingFor(records, [], landing).map((entry) => entry.id), ['obl-1']);
  // A rebase changes the sha and keeps the patch id, which is the identity used here.
  assert.deepEqual(obligations.outstandingFor(records, [], [commit('c'.repeat(40), 'p1')]).map((entry) => entry.id), ['obl-1']);
  assert.deepEqual(obligations.outstandingFor(records, [{ job: 'job-42' }], landing), [], 'a recorded verdict is not outstanding');
  assert.deepEqual(obligations.outstandingFor(records.map((entry) => ({ ...entry, state: 'failed' })), [], landing), [],
    'a failed review no longer blocks — the missing review record does that on its own');
});

test('the land gate refuses while a launched review has not answered', () => {
  const commits = [commit('a'.repeat(40), 'p1')];
  const clean = {
    id: 'rev-1', at: new Date().toISOString(), by: 'opus', job: '', jobAccountId: '', verdict: 'clean',
    evidence: 'x'.repeat(120), commits,
  };
  const blocked = allow.decideLand({ records: [clean], commits, obligations: [pending()] });
  assert.equal(blocked.ok, false);
  assert.match(blocked.why, /a review launched for these commits has no verdict yet: job job-42 on codex-secondary \(open\)/);
  assert.match(blocked.why, /keep reviewing --drop obl-1/);
  // Without the obligation the same self-attested record lands, which is exactly the
  // hole this closes: an independent review was out and nobody waited for it.
  assert.equal(allow.decideLand({ records: [clean], commits, obligations: [] }).ok, true);
  // Owner's own explicit grant still wins; this is a default, not a lock.
  assert.equal(allow.decideLand({ grants: ['land'], records: [], commits, obligations: [pending()] }).ok, true);
});

// ---------- the sweep ----------

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-obl-'));
  return {
    root,
    write: (id, records) => obligations.writeRecords(id, records, root),
    read: (id) => obligations.readRecords(id, root),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('the sweep settles each obligation once and records what happened on the card', () => {
  const box = fixture();
  try {
    box.write('a-card', [pending()]);
    box.write('b-card', [pending({ id: 'obl-9', card: 'b-card', job: 'job-dead' })]);
    const landed = [];
    const deps = {
      root: box.root,
      resolveJob: (job) => (job === 'job-42' ? { status: 'completed', accountId: 'codex-secondary' } : { status: 'running' }),
      readReviews: () => [],
      liveJobs: new Map([['job-dead', { id: 'job-dead', state: 'dead', reason: 'no process' }]]),
      checkinTask: (id, payload) => landed.push([id, payload]),
    };
    const first = obligations.settle(deps);
    assert.equal(first.considered, 2);
    assert.deepEqual(first.settled.map((entry) => entry.state).sort(), ['awaiting-verdict', 'failed']);
    assert.deepEqual(landed.map(([, payload]) => payload.heading).sort(), ['review failed', 'review pending']);
    assert.match(landed.find(([id]) => id === 'a-card')[1].message, /keep codex --account codex-secondary result job-42/);
    assert.match(landed.find(([id]) => id === 'b-card')[1].message, /re-run it/);
    assert.equal(box.read('a-card')[0].state, 'awaiting-verdict');
    assert.equal(box.read('b-card')[0].state, 'failed');

    // A second sweep says nothing new: the pending one is already announced and the
    // failed one is terminal.
    landed.length = 0;
    const second = obligations.settle(deps);
    assert.deepEqual(second.settled, []);
    assert.deepEqual(landed, []);
  } finally { box.cleanup(); }
});

test('a sweep whose check-in fails keeps the transition and reports the error', () => {
  const box = fixture();
  try {
    box.write('a-card', [pending()]);
    const result = obligations.settle({
      root: box.root,
      resolveJob: () => ({ status: 'completed' }),
      readReviews: () => [],
      checkinTask: () => { throw new Error('registry is locked'); },
    });
    assert.equal(result.settled.length, 1);
    assert.match(result.errors[0], /could not record the awaiting-verdict review: registry is locked/);
    assert.equal(box.read('a-card')[0].state, 'awaiting-verdict', 'the state still moved, so the card is not re-announced forever');
  } finally { box.cleanup(); }
});

test('recording the verdict settles the obligation it answered', () => {
  const box = fixture();
  try {
    box.write('a-card', [pending(), pending({ id: 'obl-2', job: 'job-77' })]);
    const closed = obligations.settleFromRecord('a-card', { id: 'rev-3', job: 'job-42', verdict: 'findings' }, box.root);
    assert.deepEqual(closed.map((entry) => entry.id), ['obl-1']);
    const after = box.read('a-card');
    assert.equal(after[0].state, 'satisfied');
    assert.match(after[0].note, /verdict findings recorded as rev-3/);
    assert.equal(after[1].state, 'open', 'the other review is still out');
  } finally { box.cleanup(); }
});

test('a partial companion view never fails an obligation', () => {
  assert.equal(obligations.liveJobMap({ discovery: 'partial', jobs: [{ id: 'job-42', state: 'dead' }] }).size, 0);
  assert.equal(obligations.liveJobMap({ discovery: 'unknown', jobs: [] }).size, 0);
  assert.equal(obligations.liveJobMap({ discovery: 'ok', jobs: [{ id: 'job-42', state: 'dead' }] }).get('job-42').state, 'dead');
});

test('an unreadable obligations file reads as none rather than throwing', () => {
  const box = fixture();
  try {
    fs.mkdirSync(obligations.obligationsDir(box.root), { recursive: true });
    fs.writeFileSync(obligations.cardFile('a-card', box.root), '{ not json');
    assert.deepEqual(box.read('a-card'), []);
    fs.writeFileSync(obligations.cardFile('a-card', box.root), JSON.stringify([pending(), { state: 'invented' }, null]));
    assert.deepEqual(box.read('a-card').map((entry) => entry.id), ['obl-1']);
  } finally { box.cleanup(); }
});

// ---------- the CLI ----------

const { spawnSync } = require('node:child_process');
const CLI = path.join(__dirname, 'keep.js');

function registry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-obl-cli-'));
  const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1', KEEP_NO_COMMIT: '1' };
  for (const key of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID']) delete env[key];
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks', 'gate.md'), [
    '---', 'title: A gate', 'status: active', 'kind: task', 'tags: [personal]',
    'created: 2026-09-01', 'updated: 2026-09-01T09:00', '---', '', 'Context.', '',
  ].join('\n'));
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, cwd: root });
  return { root, run, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('keep reviewing lists, refuses a job it cannot find, and drops only with a reason', () => {
  const box = registry();
  try {
    const empty = box.run(['reviewing', 'gate']);
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /no pending reviews/);

    // A job id nobody can resolve would become a review nobody is running.
    const unknown = box.run(['reviewing', 'gate', '--job', 'job-nobody-has', '--commit', 'HEAD']);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr + unknown.stdout, /not a Codex job Keep can find|does not know the commit|not a git repository/);

    obligations.writeRecords('gate', [pending({ card: 'gate' })], box.root);
    const listed = box.run(['reviewing', 'gate']);
    assert.match(listed.stdout, /open — job job-42 \(codex-secondary\)/);
    assert.match(listed.stdout, /record: obl-1/);

    const reviews = box.run(['reviews', 'gate']);
    assert.match(reviews.stdout, /pending: open — job job-42/);

    const bare = box.run(['reviewing', 'gate', '--drop', 'obl-1']);
    assert.notEqual(bare.status, 0);
    assert.match(bare.stderr, /needs -m/);

    const dropped = box.run(['reviewing', 'gate', '--drop', 'obl-1', '-m', 'the account was rotated; re-running by hand']);
    assert.equal(dropped.status, 0, dropped.stderr);
    assert.match(dropped.stdout, /dropped pending review obl-1/);
    const after = obligations.readRecords('gate', box.root);
    assert.equal(after[0].state, 'abandoned');
    assert.match(after[0].note, /the account was rotated/);

    const again = box.run(['reviewing', 'gate', '--drop', 'obl-1', '-m', 'again']);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /already abandoned/);
  } finally { box.cleanup(); }
});
