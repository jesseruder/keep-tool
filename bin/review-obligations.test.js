'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const obligations = require('./review-obligations.js');
const allow = require('./allow.js');

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const commit = (sha, patchId, subject = 'a change') => ({ sha, patchId, subject });
const nolock = (fn) => fn();

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

test('a job Keep cannot find is confirmed absent before it fails, not assumed', () => {
  const now = Date.now();
  const young = pending({ at: new Date(now - 60e3).toISOString() });
  assert.deepEqual(obligations.decide(young, { job: null, now }), { state: 'open', misses: 1, note: '' },
    'inside the grace the miss is counted, not acted on');

  // Past the grace, one look is still one look: resolveJob answers null for an
  // unreadable directory or a half-written job file too.
  let record = pending({ at: new Date(now - 30 * 60e3).toISOString() });
  for (let n = 1; n < obligations.MISSING_JOB_CONFIRMATIONS; n += 1) {
    const touch = obligations.decide(record, { job: null, now });
    assert.equal(touch.state, 'open', `miss ${n} does not fail the review`);
    assert.equal(touch.misses, n);
    record = obligations.applied(record, touch, now);
  }
  const verdict = obligations.decide(record, { job: null, now });
  assert.equal(verdict.state, 'failed');
  assert.match(verdict.note, /cannot find Codex job job-42 in account codex-secondary/);
});

test('a job that answers again clears the misses a transient read failure counted', () => {
  const now = Date.now();
  const record = pending({ misses: 2, at: new Date(now - 30 * 60e3).toISOString() });
  const decision = obligations.decide(record, { job: { status: 'running' }, now });
  assert.deepEqual(decision, { state: 'open', misses: 0, note: '' });
  assert.equal('misses' in obligations.applied(record, decision, now), false, 'and the field goes away');
});

test('a companion Keep could not read never fails a live obligation', () => {
  const now = Date.now();
  const old = pending({ at: new Date(now - 30 * 60e3).toISOString(), misses: 9 });
  for (const context of [{ job: null, discovery: 'partial' }, { job: null, discovery: 'unknown' }, { jobUnknown: true }]) {
    assert.equal(obligations.decide(old, { ...context, now }), null, JSON.stringify(context));
  }
  // It does still stop waiting eventually, so an unreadable companion cannot block a
  // card forever either.
  const ancient = pending({ at: new Date(now - 8 * HOUR).toISOString() });
  const stopped = obligations.decide(ancient, { job: null, discovery: 'unknown', now });
  assert.equal(stopped.state, 'abandoned');
  assert.match(stopped.note, /has not been able to see Codex job job-42 for 8h/);
});

test('a finished job becomes a verdict Keep is waiting for, and says so once', () => {
  const now = Date.now();
  const first = obligations.decide(pending(), { job: { status: 'completed' }, now });
  assert.equal(first.state, 'awaiting-verdict');
  const again = obligations.decide(pending({ state: 'awaiting-verdict' }), { job: { status: 'completed' }, now });
  assert.equal(again, null, 'an announced obligation is not announced every five minutes');
});

test('a verdict nobody ever records is abandoned rather than blocking forever', () => {
  const now = Date.now();
  const stuck = pending({ state: 'awaiting-verdict', stateAt: new Date(now - 8 * HOUR).toISOString() });
  const decision = obligations.decide(stuck, { job: { status: 'completed' }, now });
  assert.equal(decision.state, 'abandoned');
  assert.match(decision.note, /finished 8h ago and no verdict was ever recorded/);
});

test('a review that came back settles the obligation whatever it found', () => {
  const now = Date.now();
  for (const verdict of ['clean', 'findings']) {
    const decision = obligations.decide(pending({ state: 'awaiting-verdict' }), {
      job: { status: 'completed' }, reviewRecords: [{ id: 'rev-1', job: 'job-42', verdict }], now,
    });
    assert.equal(decision.state, 'satisfied', `a ${verdict} verdict is still a verdict`);
  }
  // A record citing some other job is not this obligation's answer…
  assert.equal(obligations.decide(pending(), {
    job: { status: 'completed' }, reviewRecords: [{ id: 'rev-2', job: 'job-99', verdict: 'clean', at: new Date().toISOString() }], now,
  }).state, 'awaiting-verdict');
  // …unless it is a verified independent review of exactly the same patches, recorded
  // after this obligation opened. A re-run under a new job id must not leave the first
  // obligation blocking a card that has in fact been reviewed.
  const covering = {
    id: 'rev-3', job: 'job-99', jobAccountId: 'codex-main', verdict: 'clean',
    at: new Date(now).toISOString(), commits: [commit('z'.repeat(40), 'p1')],
  };
  assert.equal(obligations.decide(pending(), { job: { status: 'completed' }, reviewRecords: [covering], now }).state, 'satisfied');
  // A self-attestation with no verified job is not an independent review.
  assert.equal(obligations.decide(pending(), {
    job: { status: 'completed' }, reviewRecords: [{ ...covering, jobAccountId: '' }], now,
  }).state, 'awaiting-verdict');
  // Nor is one written before this review was even launched.
  assert.equal(obligations.decide(pending(), {
    job: { status: 'completed' }, reviewRecords: [{ ...covering, at: new Date(now - 4 * HOUR).toISOString() }], now,
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

test('a touch keeps the clock it is measured against', () => {
  const now = Date.now();
  const record = pending({ state: 'awaiting-verdict', stateAt: new Date(now - 3 * HOUR).toISOString() });
  const touched = obligations.applied(record, { state: 'awaiting-verdict', misses: 1, note: '' }, now);
  assert.equal(touched.stateAt, record.stateAt, 'a miss does not restart the abandonment clock');
  const moved = obligations.applied(record, { state: 'failed', note: 'gone' }, now);
  assert.equal(moved.stateAt, new Date(now).toISOString());
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
      withLock: nolock,
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

test('the sweep writes the transition before it announces it', () => {
  const box = fixture();
  try {
    box.write('a-card', [pending()]);
    const order = [];
    const result = obligations.settle({
      root: box.root,
      withLock: (fn) => { order.push('write'); return fn(); },
      resolveJob: () => ({ status: 'completed' }),
      readReviews: () => [],
      checkinTask: () => { order.push('checkin'); throw new Error('registry is locked'); },
    });
    assert.deepEqual(order, ['write', 'write', 'checkin'],
      'the transition is written first — one announced but not written would be announced forever — and the'
      + ' delivery then takes the lock once for the whole read-validate-announce-clear');
    assert.equal(result.settled.length, 1);
    assert.match(result.errors[0], /could not record the awaiting-verdict review: registry is locked/);
    assert.equal(box.read('a-card')[0].state, 'awaiting-verdict');
  } finally { box.cleanup(); }
});

test('a write that fails announces nothing, so the next sweep tries the whole thing again', () => {
  const box = fixture();
  try {
    box.write('a-card', [pending()]);
    const landed = [];
    const result = obligations.settle({
      root: box.root,
      withLock: () => { throw new Error('the registry lock is held'); },
      resolveJob: () => ({ status: 'completed' }),
      readReviews: () => [],
      checkinTask: (id, payload) => landed.push(payload),
    });
    assert.deepEqual(landed, []);
    assert.deepEqual(result.settled, []);
    assert.match(result.errors[0], /could not write obligations/);
    assert.equal(box.read('a-card')[0].state, 'open');
  } finally { box.cleanup(); }
});

test('a record that changed under the sweep keeps its own state and is not announced', () => {
  const box = fixture();
  try {
    box.write('a-card', [pending()]);
    const landed = [];
    // The drop lands between the decision and the write, exactly where a five-minute
    // sweep and a person typing at a terminal collide.
    const result = obligations.settle({
      root: box.root,
      resolveJob: () => ({ status: 'completed' }),
      readReviews: () => [],
      checkinTask: (id, payload) => landed.push(payload),
      withLock: (fn) => {
        box.write('a-card', [obligations.applied(pending(), { state: 'abandoned', note: 'dropped: by hand' })]);
        return fn();
      },
    });
    assert.deepEqual(landed, [], 'nothing is announced for a transition that was not applied');
    assert.deepEqual(result.settled, []);
    const after = box.read('a-card');
    assert.equal(after[0].state, 'abandoned', 'the drop stands');
    assert.match(after[0].note, /dropped: by hand/);
  } finally { box.cleanup(); }
});

test('recording the verdict settles the obligation it answered', () => {
  const box = fixture();
  try {
    box.write('a-card', [pending(), pending({ id: 'obl-2', job: 'job-77' })]);
    const closed = obligations.settleFromRecord('a-card', { id: 'rev-3', job: 'job-42', verdict: 'findings' },
      box.root, Date.now(), { withLock: nolock });
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

// ---------- storage ----------

test('an unreadable obligations file refuses rather than reading as none', () => {
  const box = fixture();
  try {
    assert.deepEqual(box.read('never-written'), [], 'a card with no file has no obligations');
    fs.mkdirSync(obligations.obligationsDir(box.root), { recursive: true });
    fs.writeFileSync(obligations.cardFile('a-card', box.root), '{ not json');
    // Failing open here would let a land through as if no review were outstanding.
    assert.throws(() => box.read('a-card'), /not readable JSON/);
    assert.throws(() => obligations.append('a-card', pending(), box.root), /not readable JSON/,
      'and an append must not overwrite history it could not read');
    fs.writeFileSync(obligations.cardFile('a-card', box.root), JSON.stringify({ nope: true }));
    assert.throws(() => box.read('a-card'), /not a list/);
    // Individual records that are not records are still skipped: the file is readable.
    fs.writeFileSync(obligations.cardFile('a-card', box.root), JSON.stringify([pending(), { state: 'invented' }, null]));
    assert.deepEqual(box.read('a-card').map((entry) => entry.id), ['obl-1']);
  } finally { box.cleanup(); }
});

test('terminal records age out and a card with none left loses its file', () => {
  const box = fixture();
  const now = Date.now();
  try {
    const old = pending({ id: 'obl-old', state: 'satisfied', stateAt: new Date(now - 60 * DAY).toISOString() });
    const recent = pending({ id: 'obl-new', state: 'failed', stateAt: new Date(now - DAY).toISOString() });
    obligations.writeRecords('a-card', [old, recent, pending()], box.root, now);
    assert.deepEqual(box.read('a-card').map((entry) => entry.id), ['obl-new', 'obl-1'], 'open records always stay');

    obligations.writeRecords('a-card', [old], box.root, now);
    assert.equal(fs.existsSync(obligations.cardFile('a-card', box.root)), false,
      'a card whose history has aged out is not rescanned by the daemon every five minutes');
    assert.deepEqual(box.read('a-card'), []);
  } finally { box.cleanup(); }
});

// ---------- the CLI ----------

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

test('an unreadable store is reported by the CLI instead of read as empty', () => {
  const box = registry();
  try {
    fs.mkdirSync(obligations.obligationsDir(box.root), { recursive: true });
    fs.writeFileSync(obligations.cardFile('gate', box.root), 'not json at all');
    for (const args of [['reviewing', 'gate'], ['reviews', 'gate']]) {
      const run = box.run(args);
      assert.notEqual(run.status, 0, args.join(' '));
      assert.match(run.stderr, /not readable JSON/);
    }
  } finally { box.cleanup(); }
});

// ---------- what round two found ----------

test('a live row for the job outweighs a job file that would not read', () => {
  const now = Date.now();
  const old = pending({ at: new Date(now - 30 * 60e3).toISOString(), misses: 2 });
  // Companion discovery is fine and says the job is running; only its own file failed
  // to parse. Failing the review here would drop the gate on a demonstrably live job —
  // and a row that still shows the process is affirmative evidence of life, so it clears
  // the absences counted so far rather than merely not adding to them.
  assert.deepEqual(obligations.decide(old, { job: null, live: { state: 'running' }, discovery: 'ok', now }),
    { state: 'open', misses: 0, note: '' }, 'seeing it alive resets the count');
  // With nothing saying it is alive, the third confirmed absence still fails it.
  assert.equal(obligations.decide(old, { job: null, discovery: 'ok', now }).state, 'failed');
});

test('misses have to be consecutive, not merely three', () => {
  const now = Date.now();
  let record = pending({ state: 'awaiting-verdict', at: new Date(now - 30 * 60e3).toISOString() });
  for (let n = 0; n < 5; n += 1) {
    // Alternating: a read that failed, then one that succeeded.
    record = obligations.applied(record, obligations.decide(record, { job: null, discovery: 'ok', now }), now);
    assert.equal(record.state, 'awaiting-verdict', 'a single miss never fails it');
    const cleared = obligations.decide(record, { job: { status: 'completed' }, now });
    assert.deepEqual(cleared, { state: 'awaiting-verdict', misses: 0, note: '' }, 'a job that answered clears the count');
    record = obligations.applied(record, cleared, now);
    assert.equal('misses' in record, false);
  }
});

test('an undated record ages out instead of counting misses forever', () => {
  const now = Date.now();
  let undated = pending({ at: 'not a date', stateAt: 'not a date either' });
  // Reading an unreadable `at` as "opened just now" kept the record inside its own
  // grace forever: a miss counted and the file rewritten every five minutes, with no
  // sweep ever reaching the confirmation that ends it.
  for (let n = 1; n < obligations.MISSING_JOB_CONFIRMATIONS; n += 1) {
    const touch = obligations.decide(undated, { job: null, discovery: 'ok', now });
    assert.equal(touch.misses, n);
    undated = obligations.applied(undated, touch, now);
  }
  assert.equal(obligations.decide(undated, { job: null, discovery: 'ok', now }).state, 'failed');
});

test('a review record written before the obligation existed is not its verdict', () => {
  const now = Date.now();
  const record = pending();
  const early = { id: 'rev-0', job: 'job-42', verdict: 'clean', at: new Date(now - 4 * HOUR).toISOString() };
  assert.equal(obligations.decide(record, { job: { status: 'completed' }, reviewRecords: [early], now }).state,
    'awaiting-verdict', 'the same job id registered twice must not arrive pre-satisfied');
  const answer = { id: 'rev-1', job: 'job-42', verdict: 'clean', at: new Date(now).toISOString() };
  assert.equal(obligations.decide(record, { job: { status: 'completed' }, reviewRecords: [answer], now }).state, 'satisfied');
});

test('an announcement that could not be delivered is retried until it lands', () => {
  const box = fixture();
  try {
    box.write('a-card', [pending()]);
    let failing = true;
    const landed = [];
    const deps = {
      root: box.root,
      withLock: nolock,
      resolveJob: () => ({ status: 'completed' }),
      readReviews: () => [],
      checkinTask: (id, payload) => {
        if (failing) throw new Error('the registry lock is held');
        landed.push(payload);
      },
    };
    const first = obligations.settle(deps);
    assert.equal(first.settled.length, 1);
    assert.equal(first.announced, 0);
    assert.match(first.errors[0], /could not record the awaiting-verdict review/);
    assert.equal(box.read('a-card')[0].state, 'awaiting-verdict');
    assert.equal(box.read('a-card')[0].announce, true, 'the card still owes a check-in');

    // The next sweep decides nothing new — and still delivers the notice.
    failing = false;
    const second = obligations.settle(deps);
    assert.deepEqual(second.settled, []);
    assert.equal(second.announced, 1);
    assert.equal(landed[0].heading, 'review pending');
    assert.equal('announce' in box.read('a-card')[0], false, 'and the debt is cleared once it lands');

    const third = obligations.settle(deps);
    assert.equal(third.announced, 0, 'not announced twice');
  } finally { box.cleanup(); }
});

test('a debt cleared by a state that earns no check-in is not chased forever', () => {
  const box = fixture();
  try {
    box.write('a-card', [{ ...pending(), announce: true }]);
    const deps = {
      root: box.root, withLock: nolock,
      resolveJob: () => ({ status: 'completed' }),
      readReviews: () => [{ id: 'rev-1', job: 'job-42', verdict: 'clean', at: new Date().toISOString() }],
      checkinTask: () => { throw new Error('nothing should be announced'); },
    };
    const result = obligations.settle(deps);
    assert.equal(result.settled[0].state, 'satisfied');
    assert.equal(result.announced, 0);
    assert.deepEqual(result.errors, []);
    assert.equal('announce' in box.read('a-card')[0], false, 'satisfied earns no check-in, so it owes none');
  } finally { box.cleanup(); }
});

test('a card whose obligations are all terminal is eventually retired by the sweep', () => {
  const box = fixture();
  const now = Date.now();
  try {
    // Written the way a sweep months ago left it: writeRecords itself would prune this
    // on the way in, which is exactly why nothing ever retired the file — no writer
    // came back to this card again.
    fs.mkdirSync(obligations.obligationsDir(box.root), { recursive: true });
    fs.writeFileSync(obligations.cardFile('a-card', box.root),
      JSON.stringify([pending({ state: 'satisfied', stateAt: new Date(now - 60 * DAY).toISOString() })]));
    assert.equal(fs.existsSync(obligations.cardFile('a-card', box.root)), true);
    const result = obligations.settle({
      root: box.root, now, withLock: nolock,
      resolveJob: () => { throw new Error('no open obligation should need a job'); },
      readReviews: () => [],
      checkinTask: () => { throw new Error('nothing to announce'); },
    });
    assert.equal(result.considered, 0);
    assert.deepEqual(result.errors, []);
    assert.equal(fs.existsSync(obligations.cardFile('a-card', box.root)), false);
  } finally { box.cleanup(); }
});

test('the land gate names a corrupt store instead of an imaginary obligation', () => {
  const commits = [commit('a'.repeat(40), 'p1')];
  const verdict = allow.decideLand({
    records: [], commits,
    obligations: [{ unreadable: true, card: 'a-card', why: 'the pending reviews for a-card are not readable JSON' }],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /the pending reviews for a-card could not be read/);
  assert.match(verdict.why, /repair or remove \.keep\/review-obligations\/<card>\.json/);
  assert.doesNotMatch(verdict.why, /keep reviewed --job/, 'no recovery command that cannot work');
});

// ---------- what round three found ----------

test('a dead or long-stalled row decides on its own, without a job file', () => {
  const now = Date.now();
  // Asked before "I could not read the job file", so a dead process is not swallowed by
  // the cannot-tell branch and left to time out six hours later.
  const dead = obligations.decide(pending(), { job: null, live: { state: 'dead', reason: 'no process' }, now });
  assert.equal(dead.state, 'failed');
  assert.match(dead.note, /is dead \(no process\)/);
  const stalled = obligations.decide(pending(), { job: null, live: { state: 'stalled', idleMs: 45 * 60e3 }, now });
  assert.equal(stalled.state, 'failed');
  // A stalled row inside the threshold is still alive, and clears the absence count.
  assert.deepEqual(obligations.decide(pending({ misses: 2 }), { job: null, live: { state: 'stalled', idleMs: 60e3 }, now }),
    { state: 'open', misses: 0, note: '' });
});

test('an undated awaiting-verdict record with a finished job still stops waiting', () => {
  const now = Date.now();
  const undated = pending({ state: 'awaiting-verdict', at: 'nonsense', stateAt: 'nonsense' });
  const decision = obligations.decide(undated, { job: { status: 'completed' }, now });
  assert.equal(decision.state, 'abandoned', 'an undated record is not perpetually just-settled');
  assert.match(decision.note, /finished an unknown length of time ago/);
  assert.doesNotMatch(decision.note, /Infinity|NaN/);
  // And an undated record that does reach a time ceiling says so readably.
  const missing = obligations.decide(pending({ at: 'nonsense', stateAt: 'nonsense' }), { job: null, discovery: 'unknown', now });
  assert.equal(missing.state, 'abandoned');
  assert.match(missing.note, /an unknown length of time/);
  assert.doesNotMatch(missing.note, /Infinity/);
});

test('an announcement is built from the record as it stands, not from a stale snapshot', () => {
  const box = fixture();
  try {
    box.write('a-card', [pending()]);
    const landed = [];
    let interfere = null;
    const deps = {
      root: box.root, withLock: nolock,
      resolveJob: () => ({ status: 'completed' }),
      readReviews: () => [],
      checkinTask: (id, payload) => { landed.push(payload); if (interfere) interfere(); },
    };
    // First sweep moves it to awaiting-verdict but cannot deliver.
    let failing = true;
    const first = obligations.settle({ ...deps, checkinTask: () => { throw new Error('busy'); } });
    assert.equal(first.announced, 0);
    assert.equal(box.read('a-card')[0].announce, true);

    // Between the sweeps somebody records the verdict, so the record is satisfied.
    box.write('a-card', [{ ...box.read('a-card')[0], state: 'satisfied', note: 'verdict recorded', announce: true }]);
    failing = false;
    const second = obligations.settle(deps);
    assert.equal(second.announced, 0, 'satisfied earns no check-in…');
    assert.deepEqual(landed, [], '…and the stale "no verdict is recorded" notice is never written');
    assert.equal('announce' in box.read('a-card')[0], false, 'the debt is cleared either way');
  } finally { box.cleanup(); }
});

test('a card that will not take a check-in is given up on rather than retried forever', () => {
  const box = fixture();
  try {
    box.write('a-card', [pending()]);
    const deps = {
      root: box.root, withLock: nolock,
      resolveJob: () => ({ status: 'completed' }),
      readReviews: () => [],
      checkinTask: () => { throw new Error('no such task: a-card'); },
    };
    let sweeps = 0;
    for (; sweeps < 40; sweeps += 1) {
      obligations.settle(deps);
      if (!('announce' in (box.read('a-card')[0] || {}))) break;
    }
    assert.ok(sweeps < 39, 'an archived card must not be retried every five minutes forever');
    const record = box.read('a-card')[0];
    assert.equal('announce' in record, false);
    assert.equal(record.state, 'awaiting-verdict', 'and the state it reached still stands');
  } finally { box.cleanup(); }
});

test('a record that still owes a check-in outlives retention', () => {
  const now = Date.now();
  const owing = pending({ state: 'failed', stateAt: new Date(now - 60 * DAY).toISOString(), announce: true });
  const quiet = pending({ id: 'obl-2', state: 'failed', stateAt: new Date(now - 60 * DAY).toISOString() });
  assert.deepEqual(obligations.keptRecords([owing, quiet], now).map((entry) => entry.id), ['obl-1'],
    'pruning the owing one would throw away the only thing that knows it never landed');
});

// ---------- what round four found ----------

test('a completed job file beats a stale row that says the process is gone', () => {
  const now = Date.now();
  // The snapshot and the job file are read separately: a review that finished in
  // between leaves a stalled row beside a completed result. Failing it there would
  // write "nothing was reviewed" about a review that had just finished.
  for (const live of [{ state: 'dead', reason: 'no process' }, { state: 'stalled', idleMs: 45 * 60e3 }]) {
    const decision = obligations.decide(pending(), { job: { status: 'completed' }, live, now });
    assert.equal(decision.state, 'awaiting-verdict', JSON.stringify(live));
  }
  // With no job file to read, the same row still decides on its own.
  assert.equal(obligations.decide(pending(), { job: null, live: { state: 'dead' }, now }).state, 'failed');
  // And a file that still says running is overruled by the process being gone.
  assert.equal(obligations.decide(pending(), { job: { status: 'running' }, live: { state: 'dead' }, now }).state, 'failed');
});

test('a verdict recorded before the retry cancels the announcement rather than contradicting it', () => {
  const box = fixture();
  try {
    box.write('a-card', [pending()]);
    const landed = [];
    let reviews = [];
    const deps = {
      root: box.root, withLock: nolock,
      resolveJob: () => ({ status: 'completed' }),
      readReviews: () => reviews,
      checkinTask: (id, payload) => landed.push(payload),
    };
    // The first sweep settles it and cannot deliver, so the card owes a notice.
    obligations.settle({ ...deps, checkinTask: () => { throw new Error('busy'); } });
    assert.equal(box.read('a-card')[0].announce, true);

    // Before the retry, somebody records the verdict.
    reviews = [{ id: 'rev-9', job: 'job-42', verdict: 'clean', at: new Date().toISOString() }];
    const second = obligations.settle(deps);
    assert.deepEqual(landed, [], 'the pending notice would have contradicted a verdict that exists');
    assert.equal(second.announced, 0);
    assert.equal(box.read('a-card')[0].state, 'satisfied');
    assert.equal('announce' in box.read('a-card')[0], false);
  } finally { box.cleanup(); }
});

// The case that needs no concurrency at all: an abandoned obligation whose notice
// failed, and a review recorded before the retry. settleFromRecord ignores terminal
// records and the sweep only reads reviews for open ones, so nothing else would notice.
test('a terminal record does not announce "no review record" once one exists', () => {
  const box = fixture();
  const now = Date.now();
  try {
    box.write('a-card', [pending({
      state: 'abandoned', stateAt: new Date(now).toISOString(), note: 'stopped waiting', announce: true,
    })]);
    const landed = [];
    const result = obligations.settle({
      root: box.root, now, withLock: nolock,
      resolveJob: () => { throw new Error('no open obligation needs a job'); },
      readReviews: () => [{ id: 'rev-9', job: 'job-42', verdict: 'findings', at: new Date(now).toISOString() }],
      checkinTask: (id, payload) => landed.push(payload),
    });
    assert.deepEqual(landed, []);
    assert.equal(result.announced, 0);
    assert.equal('announce' in box.read('a-card')[0], false, 'and the debt does not sit there forever');
    assert.equal(box.read('a-card')[0].state, 'abandoned', 'the record still says Keep stopped waiting');
  } finally { box.cleanup(); }
});

test('the whole delivery takes the registry lock once, with the check-in inside it', () => {
  const box = fixture();
  try {
    box.write('a-card', [pending()]);
    let depth = 0;
    let maxDepth = 0;
    let insideLock = null;
    obligations.settle({
      root: box.root,
      withLock: (fn) => { depth += 1; maxDepth = Math.max(maxDepth, depth); try { return fn(); } finally { depth -= 1; } },
      resolveJob: () => ({ status: 'completed' }),
      readReviews: () => [],
      checkinTask: (id, payload) => { insideLock = depth > 0 ? payload : null; },
    });
    assert.equal(maxDepth, 1, 'never nested — keep.withLock is not re-entrant');
    assert.ok(insideLock, 'the check-in happens under the same lock the record was read in');
    assert.equal(insideLock.withinLock, true, 'and says so, so checkinTask does not take it again');
  } finally { box.cleanup(); }
});

test('a terminal record Keep cannot date is not kept forever', () => {
  const now = Date.now();
  const undated = pending({ id: 'obl-x', state: 'satisfied', at: 'nonsense', stateAt: 'nonsense' });
  assert.deepEqual(obligations.keptRecords([undated], now), [],
    'keeping it would leave a file on the sweep scan path with nothing to retire it');
  assert.deepEqual(obligations.keptRecords([{ ...undated, announce: true }], now).map((r) => r.id), ['obl-x'],
    'unless it still owes a check-in');
});
