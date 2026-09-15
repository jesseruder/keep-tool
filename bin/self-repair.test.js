'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const selfRepair = require('./self-repair.js');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-self-repair-'));
  fs.mkdirSync(path.join(root, '.keep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'watch'), { recursive: true });
  return root;
}

function snapshotOf(rows, daemon = {}) {
  return {
    daemon: { startedAt: 0, pid: 1, running: true, startedAts: [], ...daemon },
    schedulers: rows.map((row) => ({
      name: row.name,
      disabled: false,
      lastRunAt: null,
      lastOkAt: null,
      lastErrorAt: null,
      lastError: '',
      incidentAt: null,
      incidentId: null,
      consecutiveFailures: 0,
      cadenceMs: 60e3,
      detail: '',
      state: 'ok',
      ...row,
    })),
  };
}

const NOW = Date.parse('2026-09-15T12:00:00.000Z');

// ---------- the normalizer ----------

test('the error normalizer collapses what varies and keeps what identifies', () => {
  const { normalizeError } = selfRepair;

  // The whole point: two spellings of one fault share a signature.
  assert.equal(normalizeError('tick failed for pid 123'), normalizeError('tick failed for pid 456'));
  assert.equal(
    normalizeError('ENOENT: no such file /Users/jesse/keep/.keep/runs/a.jsonl'),
    normalizeError('ENOENT: no such file /Users/jesse/keep/.keep/runs/b.jsonl'),
  );
  assert.equal(
    normalizeError('session 39f6a38a-1111-2222-3333-444455556666 stalled'),
    normalizeError('session 0e1d2c3b-9999-8888-7777-666655554444 stalled'),
  );
  assert.equal(normalizeError('failed at 2026-09-15T12:00:00.000Z'), normalizeError('failed at 2026-09-14T03:22:11.500Z'));
  assert.equal(normalizeError('bad sha deadbeef1234'), normalizeError('bad sha cafebabe9876'));
  assert.equal(normalizeError('  two   spaces\nand a newline '), 'two spaces and a newline');

  // …and two different faults do not.
  assert.notEqual(normalizeError('delivery is unconfirmed'), normalizeError('transcript unreadable'));
  assert.equal(normalizeError('Tick Failed'), 'tick failed');
  assert.match(normalizeError('tick failed for pid 123'), /<n>/);
  assert.match(normalizeError('cannot read /a/b/c.json'), /<path>/);

  // The hash is over name + normalized error, so the same text under two
  // schedulers is two signatures.
  assert.notEqual(
    selfRepair.signatureHash('review', normalizeError('x')),
    selfRepair.signatureHash('runs', normalizeError('x')),
  );
  assert.match(selfRepair.signatureHash('review', 'x'), /^[0-9a-f]{8}$/);
});

// ---------- signature detection ----------

test('a scheduler signature needs enough failures and enough age', () => {
  const snapshot = snapshotOf([
    { name: 'review', consecutiveFailures: 6, lastError: 'tick failed for pid 123', lastErrorAt: NOW, lastOkAt: NOW - 4 * 3600e3 },
  ]);
  const config = { ...selfRepair.DEFAULT_CONFIG };

  // First sighting: the signature exists but is too young to act on.
  const first = selfRepair.signatures(snapshot, null, NOW, config, null);
  assert.equal(first.length, 1);
  assert.match(first[0].sig, /^sched:review:[0-9a-f]{8}$/);
  assert.equal(first[0].ready, false);
  assert.match(first[0].why, /needs 30m/);

  // Seen half an hour before the latest failure: now it is ready.
  const state = { signatures: { [first[0].sig]: { firstSeenAt: NOW - 31 * 60e3 } } };
  const ready = selfRepair.signatures(snapshot, null, NOW, config, state);
  assert.equal(ready[0].ready, true);
  assert.match(ready[0].why, /6 consecutive failures/);

  // Four failures is under the floor.
  const few = selfRepair.signatures(snapshotOf([
    { name: 'review', consecutiveFailures: 4, lastError: 'tick failed', lastErrorAt: NOW },
  ]), null, NOW, config, state);
  assert.deepEqual(few, []);
});

test('retired, disabled, on-demand and self-repair rows never produce a signature', () => {
  const config = { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 };
  const snapshot = snapshotOf([
    { name: 'review-questions', consecutiveFailures: 40, lastError: 'retired', lastErrorAt: NOW },
    { name: 'discord', disabled: true, consecutiveFailures: 40, lastError: 'not configured', lastErrorAt: NOW },
    { name: 'usage', consecutiveFailures: 40, lastError: 'on demand', lastErrorAt: NOW },
    { name: 'self-repair', consecutiveFailures: 40, lastError: 'itself', lastErrorAt: NOW },
    { name: 'runs', consecutiveFailures: 5, lastError: 'real', lastErrorAt: NOW },
  ]);
  assert.deepEqual(selfRepair.signatures(snapshot, null, NOW, config, null).map((row) => row.name), ['runs']);
});

test('the restart loop needs two consecutive ticks, and a delivery incident needs age', () => {
  const config = { ...selfRepair.DEFAULT_CONFIG };
  const starts = [NOW - 50 * 60e3, NOW - 40 * 60e3, NOW - 20 * 60e3, NOW - 10 * 60e3, NOW - 2 * 60e3];
  const snapshot = snapshotOf([], { startedAts: [...starts, NOW - 3 * 3600e3] });

  const first = selfRepair.signatures(snapshot, null, NOW, config, null);
  assert.equal(first.length, 1);
  assert.equal(first[0].sig, 'daemon:restart-loop');
  assert.equal(first[0].ready, false, 'one tick can catch a burst that is already over');
  assert.equal(first[0].starts, 5);

  const second = selfRepair.signatures(snapshot, null, NOW, config, {
    signatures: { 'daemon:restart-loop': { firstSeenAt: NOW - 5 * 60e3, ticks: 1 } },
  });
  assert.equal(second[0].ready, true);
  assert.match(second[0].why, /2 consecutive ticks/);

  // Three starts is the documented normal.
  assert.deepEqual(selfRepair.signatures(snapshotOf([], { startedAts: starts.slice(0, 3) }), null, NOW, config, null), []);

  // Delivery: the row's incident id is the signature, and it must be old enough.
  const delivery = snapshotOf([{
    name: 'delivery', consecutiveFailures: 9, incidentId: 'a'.repeat(64),
    incidentAt: NOW - 10 * 60e3, lastError: '1 unconfirmed delivery issue(s)', lastErrorAt: NOW,
  }]);
  const young = selfRepair.signatures(delivery, null, NOW, config, null);
  assert.equal(young.length, 1, 'the delivery row does not also produce a sched: signature');
  assert.equal(young[0].sig, `delivery:${'a'.repeat(8)}`);
  assert.equal(young[0].ready, false);

  delivery.schedulers[0].incidentAt = NOW - 90 * 60e3;
  assert.equal(selfRepair.signatures(delivery, null, NOW, config, null)[0].ready, true);

  // A delivery row failing without an incident is an ordinary scheduler signature.
  const broken = snapshotOf([{ name: 'delivery', consecutiveFailures: 9, lastError: 'watchdog could not inspect', lastErrorAt: NOW }]);
  assert.match(selfRepair.signatures(broken, null, NOW, config, { signatures: {} })[0].sig, /^sched:delivery:/);
});

// ---------- state and config ----------

test('state is pruned, written atomically, and an unwritable root only logs', () => {
  const root = makeRoot();
  try {
    assert.deepEqual(selfRepair.loadState(root), { signatures: {}, day: '', openedToday: 0 });

    selfRepair.mutateState((state) => {
      state.signatures['sched:a:11111111'] = { firstSeenAt: NOW, cardId: 'card-a' };
      state.signatures['sched:b:22222222'] = { firstSeenAt: NOW - 30 * 86400e3, resolvedAt: NOW - 20 * 86400e3 };
      state.openedToday = 1;
      state.day = '2026-09-15';
    }, { root, now: NOW });

    const written = JSON.parse(fs.readFileSync(selfRepair.stateFile(root), 'utf8'));
    assert.equal(written.openedToday, 1);
    assert.ok(written.signatures['sched:a:11111111']);

    // The 14-day prune happens on the next mutation, not on read.
    selfRepair.mutateState(() => {}, { root, now: NOW });
    const pruned = selfRepair.loadState(root);
    assert.deepEqual(Object.keys(pruned.signatures), ['sched:a:11111111']);

    // A garbage file reads as empty state rather than throwing.
    fs.writeFileSync(selfRepair.stateFile(root), 'not json');
    assert.deepEqual(selfRepair.loadState(root).signatures, {});

    const logged = [];
    const bad = path.join(root, '.keep', 'serve.log'); // a file where a directory must be
    fs.writeFileSync(bad, 'not a directory');
    assert.equal(selfRepair.mutateState(() => {}, {
      root: bad, now: NOW, write: (line) => logged.push(line),
    }), null);
    assert.match(logged.join(''), /could not update/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('config defaults hold, unknown keys warn instead of failing closed, and the budget is capped', () => {
  const root = makeRoot();
  selfRepair._resetWarnings();
  try {
    assert.deepEqual(selfRepair.loadConfig(root, () => {}), { ...selfRepair.DEFAULT_CONFIG });

    fs.writeFileSync(path.join(root, 'watch', 'self-repair.json'), JSON.stringify({
      enabled: false, minFailures: 9, budgetMin: 600, model: 'sonnet',
      somethingNew: true, minAgeMin: 'soon',
    }));
    const logged = [];
    const config = selfRepair.loadConfig(root, (line) => logged.push(line));
    assert.equal(config.enabled, false);
    assert.equal(config.minFailures, 9);
    assert.equal(config.model, 'sonnet');
    assert.equal(config.budgetMin, selfRepair.MAX_BUDGET_MIN, 'an unattended agent gets at most 90 minutes');
    assert.equal(config.minAgeMin, selfRepair.DEFAULT_CONFIG.minAgeMin, 'an unusable value falls back');
    assert.match(logged.join(''), /unknown config key "somethingNew"/);
    assert.match(logged.join(''), /ignoring "minAgeMin"/);

    // --disable / --enable write through the same file and keep unknown keys.
    assert.equal(selfRepair.saveConfig({ enabled: true }, root).enabled, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'watch', 'self-repair.json'), 'utf8')).somethingNew, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- evidence ----------

test('the log excerpt prefers matching lines and falls back to the tail', () => {
  const root = makeRoot();
  const file = path.join(root, '.keep', 'serve.log');
  try {
    assert.equal(selfRepair.readLogExcerpt(path.join(root, '.keep', 'missing.log'), ['review']), null);

    const lines = [];
    for (let i = 0; i < 300; i += 1) lines.push(`line ${i} noise`);
    for (let i = 0; i < 120; i += 1) lines.push(`keep review: tick failed ${i}`);
    fs.writeFileSync(file, lines.join('\n'));

    const matched = selfRepair.readLogExcerpt(file, ['keep review']).split('\n');
    assert.equal(matched.length, 80, 'at most the last 80 matching lines');
    assert.match(matched.at(-1), /tick failed 119/);

    const fallback = selfRepair.readLogExcerpt(file, ['nothing-matches-this']).split('\n');
    assert.equal(fallback.length, 40, 'no match means the last 40 lines');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('evidence carries the row, the daemon, the snapshot and a scrubbed log excerpt', () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, '.keep', 'serve.log'), 'keep review: tick failed\nkeep review: again\n');
    const snapshot = snapshotOf([{ name: 'review', consecutiveFailures: 6, lastError: 'tick failed', lastErrorAt: NOW }],
      { startedAt: NOW - 3600e3, pid: 42 });
    const candidate = selfRepair.signatures(snapshot, null, NOW, { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 }, null)[0];
    const evidence = selfRepair.collectEvidence(candidate, snapshot, { root, now: NOW });
    const names = evidence.files.map((file) => file.name);
    assert.deepEqual(names, ['health-row.json', 'health-snapshot.json', 'serve-log.txt']);
    const row = JSON.parse(evidence.files[0].text);
    assert.equal(row.signature, candidate.sig);
    assert.equal(row.row.name, 'review');
    assert.equal(row.daemon.pid, 42);
    assert.match(evidence.files[2].text, /tick failed/);

    const staged = selfRepair.stageEvidence('a-card', evidence.files, root);
    assert.equal(staged.files.length, 3);
    assert.ok(staged.directory.startsWith(path.join(root, '.keep', 'self-repair')), 'staged inside Keep, never /tmp');
    assert.ok(fs.existsSync(staged.files[0]));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- the tick ----------

function harness(options = {}) {
  const root = options.root;
  const calls = { cards: [], checkins: [], artifacts: [], worktrees: [], runs: [], health: [], log: [] };
  let counter = 0;
  const deps = {
    root,
    now: options.now ?? NOW,
    config: options.config,
    snapshot: () => options.snapshot,
    write: (line) => calls.log.push(line),
    record: (name, payload) => calls.health.push({ name, payload }),
    addTask: (task) => {
      const draft = { id: `repair-card-${++counter}`, fm: {}, body: '' };
      if (task.beforeSave) task.beforeSave(draft);
      calls.cards.push({ ...task, draft });
      return draft;
    },
    setPlan: (draft, steps) => { draft.plan = steps; return draft; },
    checkin: (id, payload) => calls.checkins.push({ id, ...payload }),
    artifact: (argv) => {
      calls.artifacts.push(argv);
      return argv.slice(1).filter((value) => value !== '-m' && !value.startsWith('self-repair evidence'))
        .map((file) => ({ destination: path.join(root, '.keep', 'artifacts', argv[0], path.basename(file)) }));
    },
    spawnWorktree: (name) => {
      calls.worktrees.push(name);
      return Promise.resolve(options.worktree || { ok: true, path: `/tmp/wt/keep-tool/${name}` });
    },
    startRun: (cardId, kind, extra, runOptions) => {
      calls.runs.push({ cardId, kind, extra, runOptions });
      if (options.runThrows) throw new Error(options.runThrows);
      return { id: `run-${cardId}` };
    },
  };
  return { deps, calls };
}

test('a ready signature opens one card, attaches evidence, makes a worktree and launches one run', async () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, '.keep', 'serve.log'), 'keep review: tick failed for pid 123\n');
    const snapshot = snapshotOf([
      { name: 'review', consecutiveFailures: 6, lastError: 'tick failed for pid 123', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const { deps, calls } = harness({ root, snapshot });

    // First tick only records the sighting: the signature is not old enough.
    const first = await selfRepair.tick(deps);
    assert.deepEqual(first.opened, []);
    assert.equal(first.skipped.length, 1);
    const sig = first.candidates[0].sig;
    assert.equal(selfRepair.loadState(root).signatures[sig].firstSeenAt, NOW);

    // An hour later the same signature is actionable.
    const later = NOW + 61 * 60e3;
    snapshot.schedulers[0].lastErrorAt = later;
    const second = await selfRepair.tick({ ...deps, now: later });
    assert.equal(second.opened.length, 1);
    assert.equal(second.opened[0].launched, true);

    const card = calls.cards[0];
    assert.match(card.title, /^Daemon self-repair: review: tick failed for pid 123$/);
    assert.equal(card.project, '~/keep-tool');
    assert.deepEqual(card.tags, ['personal', 'self-repair']);
    assert.equal(card.status, 'active');
    assert.equal(card.kind, 'task');
    assert.equal(card.linkSession, false, 'a daemon caller must never link a session');
    assert.equal(card.commit, true);
    assert.match(card.note, /Signature sched:review:/);
    assert.match(card.note, /Last error: tick failed for pid 123/);

    // The plan is set before the card is saved: four steps, and the restart is
    // the last one, Owner's, and explicitly not granted.
    assert.equal(card.draft.plan.length, 4);
    assert.deepEqual(card.draft.plan.map((step) => step.state), ['todo', 'todo', 'todo', 'todo']);
    assert.match(card.draft.plan[0].text, /Reproduce and root-cause/);
    assert.match(card.draft.plan[1].text, /fails before and passes after/);
    assert.match(card.draft.plan[2].text, /keep reviewed/);
    assert.match(card.draft.plan[3].text, /never restart it yourself/);

    // Evidence went on as artifacts, staged inside Keep and cleaned up after.
    assert.equal(calls.artifacts.length, 1);
    assert.equal(calls.artifacts[0][0], 'repair-card-1');
    assert.ok(calls.artifacts[0].some((value) => String(value).endsWith('health-row.json')));
    assert.equal(fs.existsSync(path.join(root, '.keep', 'self-repair', 'evidence', 'repair-card-1')), false);

    // One worktree, named for the signature, and one run inside it.
    assert.equal(calls.worktrees.length, 1);
    assert.match(calls.worktrees[0], /^self-repair-[0-9a-f]{8}$/);
    assert.equal(calls.runs.length, 1);
    assert.equal(calls.runs[0].kind, 'task');
    assert.equal(calls.runs[0].runOptions.purpose, 'repair');
    assert.equal(calls.runs[0].runOptions.model, 'opus');
    assert.equal(calls.runs[0].runOptions.budgetMin, 60);
    assert.equal(calls.runs[0].runOptions.cwd, `/tmp/wt/keep-tool/${calls.worktrees[0]}`);
    assert.match(calls.runs[0].extra, /never restart the daemon/i);
    assert.match(calls.runs[0].extra, /VERDICT: PASS\|FAIL\|UNSURE/);

    // The launch is recorded on the card: run, worktree, purpose, model.
    const launch = calls.checkins.at(-1);
    assert.equal(launch.id, 'repair-card-1');
    assert.match(launch.message, /Run: run-repair-card-1; account purpose: repair; model: opus; budget: 60m/);
    assert.match(launch.message, /Worktree: \/tmp\/wt\/keep-tool\/self-repair-/);
    assert.equal(launch.linkSession, false);

    // …and in the state, where the next tick can see it.
    const entry = selfRepair.loadState(root).signatures[sig];
    assert.equal(entry.cardId, 'repair-card-1');
    assert.equal(entry.runId, 'run-repair-card-1');
    assert.equal(entry.attempts, 1);
    assert.equal(selfRepair.loadState(root).openedToday, 1);

    // A third tick opens nothing: one open card per signature.
    const third = await selfRepair.tick({ ...deps, now: later + 60e3 });
    assert.deepEqual(third.opened, []);
    assert.match(third.skipped[0].why, /already open/);
    assert.equal(calls.cards.length, 1);

    const row = calls.health.at(-1);
    assert.equal(row.name, 'self-repair');
    assert.equal(row.payload.cadenceMs, selfRepair.CADENCE_MS, 'a row with no cadence can never read as silent');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the daily cap, the disable switch and a failed worktree all hold', async () => {
  const root = makeRoot();
  try {
    const rows = ['review', 'runs', 'notes'].map((name) => ({
      name, consecutiveFailures: 6, lastError: `${name} is broken`, lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3,
    }));
    const snapshot = snapshotOf(rows, { startedAt: NOW - 6 * 3600e3 });
    const { deps, calls } = harness({ root, snapshot, config: { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 } });

    const opened = await selfRepair.tick(deps);
    assert.equal(opened.opened.length, 2, 'at most maxPerDay cards per local day, fleet-wide');
    assert.match(opened.skipped.at(-1).why, /daily cap reached/);

    // Disabled: nothing is even looked at, and the row says so.
    const off = await selfRepair.tick({ ...deps, config: { ...selfRepair.DEFAULT_CONFIG, enabled: false } });
    assert.equal(off.disabled, true);
    assert.equal(calls.health.at(-1).payload.detail, 'disabled');
    assert.equal(calls.cards.length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a worktree that cannot be created leaves the card and skips the launch', async () => {
  const root = makeRoot();
  try {
    const snapshot = snapshotOf([
      { name: 'runs', consecutiveFailures: 6, lastError: 'runs is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const { deps, calls } = harness({
      root, snapshot,
      config: { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 },
      worktree: { ok: false, error: 'worktree exists: /Users/x/wt/keep-tool/self-repair-1' },
    });
    const result = await selfRepair.tick(deps);
    assert.equal(result.opened.length, 1);
    assert.equal(result.opened[0].launched, false);
    assert.equal(calls.runs.length, 0, 'no agent is launched without a worktree');
    assert.match(calls.checkins.at(-1).message, /Could not create the worktree/);
    assert.match(calls.checkins.at(-1).message, /keep resume/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a cleared signature gets one check-in, a cooldown, and a linked card if it comes back', async () => {
  const root = makeRoot();
  try {
    const snapshot = snapshotOf([
      { name: 'runs', consecutiveFailures: 6, lastError: 'runs is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const { deps, calls } = harness({ root, snapshot, config: { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 } });
    const opened = await selfRepair.tick(deps);
    const sig = opened.opened[0].sig;

    // The scheduler recovers. The clear clock starts, but nothing is said yet.
    const healed = snapshotOf([{ name: 'runs', consecutiveFailures: 0, lastOkAt: NOW + 60e3, lastError: 'runs is broken' }],
      { startedAt: NOW - 6 * 3600e3 });
    const quiet = await selfRepair.tick({ ...deps, snapshot: () => healed, now: NOW + 2 * 60e3 });
    assert.deepEqual(quiet.resolved, []);
    assert.equal(selfRepair.loadState(root).signatures[sig].okSinceAt, NOW + 2 * 60e3);

    // An hour of quiet is the clear.
    const cleared = await selfRepair.tick({ ...deps, snapshot: () => healed, now: NOW + 70 * 60e3 });
    assert.deepEqual(cleared.resolved, [sig]);
    const note = calls.checkins.at(-1);
    assert.match(note.message, /cleared at .* verify the fix landed, then close/);
    assert.equal('status' in note, false, 'resolution never changes the card status');
    const entry = selfRepair.loadState(root).signatures[sig];
    assert.ok(entry.resolvedAt);
    assert.equal(entry.cooldownUntil, NOW + 70 * 60e3 + 24 * 3600e3);

    // It comes back inside the cooldown: nothing new opens.
    const again = await selfRepair.tick({ ...deps, snapshot: () => snapshot, now: NOW + 80 * 60e3 });
    assert.deepEqual(again.opened, []);
    assert.match(again.skipped[0].why, /in cooldown until/);

    // After the cooldown it opens a fresh card that links the previous one.
    const after = NOW + 70 * 60e3 + 25 * 3600e3;
    const reopened = await selfRepair.tick({ ...deps, snapshot: () => snapshot, now: after });
    assert.equal(reopened.opened.length, 1);
    assert.match(calls.cards.at(-1).note, /previous repair card was repair-card-1/);
    assert.equal(selfRepair.loadState(root).signatures[sig].previousCardId, 'repair-card-1');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('--dry explains what the next tick would do, and --reset clears a cooldown', async () => {
  const root = makeRoot();
  try {
    const snapshot = snapshotOf([
      { name: 'runs', consecutiveFailures: 6, lastError: 'runs is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
      { name: 'notes', consecutiveFailures: 6, lastError: 'notes is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const config = { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0, maxPerDay: 1 };
    const dry = await selfRepair.dryRun({ root, now: NOW, config, snapshot: () => snapshot });
    assert.deepEqual(dry.candidates.map((row) => row.action), ['open', 'skip']);
    assert.match(dry.candidates[1].why, /daily cap reached/);
    assert.match(selfRepair.renderDry(dry), /would open: Daemon self-repair: runs/);
    assert.equal(selfRepair.loadState(root).signatures.runs, undefined, '--dry writes nothing');

    selfRepair.mutateState((state) => {
      state.signatures['sched:runs:abcd1234'] = { firstSeenAt: NOW, cardId: 'old-card', resolvedAt: NOW, cooldownUntil: NOW + 86400e3 };
    }, { root, now: NOW });
    assert.equal(selfRepair.reset('sched:runs:abcd1234', { root, now: NOW }).found, true);
    assert.equal(selfRepair.loadState(root).signatures['sched:runs:abcd1234'].cooldownUntil, undefined);
    assert.equal(selfRepair.reset('sched:nope:00000000', { root, now: NOW }).found, false);

    const value = selfRepair.status({ root, now: NOW, config });
    assert.equal(value.openedToday, 0);
    assert.match(selfRepair.renderStatus(value), /self-repair: enabled/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
