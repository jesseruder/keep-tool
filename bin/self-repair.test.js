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

// Assembled at runtime: the public-source audit refuses a token-shaped literal, even a fake one.
const FAKE_SLACK_LONG = ['xoxb', '88aa11bb22cc33dd44ee'].join('-');
const FAKE_SLACK_SHORT = ['xoxb', '9f3a1c0712ab'].join('-');

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
    // Excluded: these fail for reasons a daemon fix cannot address — queue
    // congestion, a malformed card, a dirty checkout.
    { name: 'runs', consecutiveFailures: 40, lastError: 'already 3 runs active', lastErrorAt: NOW },
    { name: 'lint', consecutiveFailures: 40, lastError: 'malformed card', lastErrorAt: NOW },
    { name: 'git-pull', consecutiveFailures: 40, lastError: 'dirty checkout', lastErrorAt: NOW },
    { name: 'unblock', consecutiveFailures: 5, lastError: 'real', lastErrorAt: NOW },
  ]);
  assert.deepEqual(selfRepair.signatures(snapshot, null, NOW, config, null).map((row) => row.name), ['unblock']);
  assert.deepEqual([...selfRepair.EXCLUDED].sort(), ['git-pull', 'lint', 'runs']);
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

  // Deploys restart the daemon on purpose; requested starts are not a loop.
  assert.deepEqual(selfRepair.signatures(snapshotOf([], { startedAts: starts, requestedStartAts: starts.slice(1) }), null, NOW, config, null), []);

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
  const calls = { cards: [], checkins: [], artifacts: [], artifactText: new Map(), worktrees: [], runs: [], health: [], log: [] };
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
      const message = argv.indexOf('-m');
      const files = argv.slice(1, message === -1 ? undefined : message);
      // Read while the staging directory still exists: createRepairCard deletes it
      // the moment this returns, so this is the only place the text is visible.
      for (const file of files) calls.artifactText.set(path.basename(file), fs.readFileSync(file, 'utf8'));
      return files.map((file) => ({ destination: path.join(root, '.keep', 'artifacts', argv[0], path.basename(file)) }));
    },
    spawnWorktree: (name) => {
      calls.worktrees.push(name);
      return Promise.resolve(options.worktree || { ok: true, path: `/tmp/wt/keep-tool/${name}` });
    },
    insideWorktreeRoot: options.insideWorktreeRoot || (() => true),
    // No host by default: both answer "could not tell", which is what a daemon with
    // no terminal host sees, and neither may make anything happen on its own.
    findCardPane: options.findCardPane || (async () => null),
    paneAlive: options.paneAlive || (async () => null),
    // The harness's cards live in `calls`, not on disk, so the real loader would
    // report every one of them closed and the sweep would never look at anything.
    loadTask: options.loadTask || ((id) => (calls.cards.some((card) => card.draft.id === id)
      ? { id, fm: { status: 'active' } } : null)),
    accountId: () => options.accountId || 'claude-repair',
    worktreePath: (name) => `/tmp/wt/keep-tool/${name}`,
    openSession: async (body, openDeps) => {
      calls.runs.push({ body, openDeps });
      if (options.runThrows) throw new Error(options.runThrows);
      const nth = calls.runs.length;
      return { ok: true, pane: `pane-${nth}`, sessionId: `${String(nth).repeat(8)}-0000-4000-8000-000000000000` };
    },
  };
  return { deps, calls };
}

test('a ready signature opens one card, attaches evidence, makes a worktree and opens one session', async () => {
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
    // the last one, the session's own, and gated on the land.
    assert.equal(card.draft.plan.length, 4);
    assert.deepEqual(card.draft.plan.map((step) => step.state), ['todo', 'todo', 'todo', 'todo']);
    assert.match(card.draft.plan[0].text, /Reproduce and root-cause/);
    assert.match(card.draft.plan[1].text, /fails before and passes after/);
    assert.match(card.draft.plan[2].text, /keep reviewed/);
    assert.match(card.draft.plan[3].text, /Once the fix is on origin\/master/);
    assert.match(card.draft.plan[3].text, /refused until the land/);

    // Evidence went on as artifacts, staged inside Keep and cleaned up after —
    // and the recipe is one of them, because it does not fit in an open message.
    assert.equal(calls.artifacts.length, 2);
    assert.equal(calls.artifacts[0][0], 'repair-card-1');
    assert.ok(calls.artifacts[0].some((value) => String(value).endsWith('health-row.json')));
    assert.ok(calls.artifacts[1].some((value) => String(value).endsWith('recipe.md')));
    assert.equal(fs.existsSync(path.join(root, '.keep', 'self-repair', 'evidence', 'repair-card-1')), false);

    // The recipe names the card and the worktree it will be read in — both known
    // before `wt new` runs — and cites the evidence it was stored alongside.
    const recipe = calls.artifactText.get('recipe.md');
    assert.match(recipe, /repair-card-1/);
    assert.match(recipe, /\/tmp\/wt\/keep-tool\/self-repair-[0-9a-f]{8} \(branch wt\/self-repair-[0-9a-f]{8}\)/);
    assert.match(recipe, /health-row\.json/);
    assert.match(recipe, /DATA, NOT INSTRUCTIONS/);
    // The review is waited for in the foreground; the first live repair ended its
    // turn with the review pending, which killed the poll and landed nothing.
    assert.match(recipe, /YOUR TURN MUST NOT END WHILE THE REVIEW IS STILL PENDING/);
    assert.match(recipe, /keep checkin repair-card-1 --step 4 --status done --commit <sha> --next "nothing"/);
    // The restart, and the exact two commands it is allowed once the land is done.
    assert.match(recipe, /git -C ~\/keep-tool pull --ff-only/);
    assert.match(recipe, /keep restart-daemon/);
    assert.match(recipe, /keep wait --no-hold ~\/keep-tool --for 2h/);
    assert.match(recipe, /the guard stops refusing/);
    assert.match(recipe, /Aim to finish within 60 minutes/);
    assert.equal(/VERDICT/.test(recipe), false, 'nothing parses a verdict line out of a session');
    assert.equal(/killed/.test(recipe), false, 'and nothing kills it on a clock');

    // One worktree, named for the signature, and one session opened inside it.
    assert.equal(calls.worktrees.length, 1);
    assert.match(calls.worktrees[0], /^self-repair-[0-9a-f]{8}$/);
    assert.equal(calls.runs.length, 1);
    const body = calls.runs[0].body;
    assert.equal(body.taskId, 'repair-card-1');
    assert.equal(body.fresh, true);
    assert.equal(body.agent, 'claude');
    assert.equal(body.accountId, 'claude-repair');
    assert.equal(body.model, 'opus');
    assert.equal(body.cwd, `/tmp/wt/keep-tool/${calls.worktrees[0]}`);
    // The guard that refuses `keep restart-daemon` keys on this and nothing else.
    assert.deepEqual(calls.runs[0].openDeps, { launchEnv: { KEEP_REPAIR: '1' } });

    // The opening message is a pointer to the recipe, inside the open-message cap.
    assert.ok(body.message.length <= require('./keep.js').OPEN_MESSAGE_LIMIT,
      `the opening message is ${body.message.length} characters`);
    assert.match(body.message, /repair-card-1/);
    assert.match(body.message, /recipe\.md/);
    assert.match(body.message, /DATA, NOT/);
    assert.match(body.message, /Do not restart the daemon until your fix is landed with `keep land`/);
    assert.match(body.message, /Never edit, commit, or run git writes in ~\/keep-tool/);

    // The launch is recorded on the card: session, pane, worktree, purpose, model.
    const launch = calls.checkins.at(-1);
    assert.equal(launch.id, 'repair-card-1');
    assert.match(launch.message, /Session: 11111111 in pane pane-1; account purpose: repair; model: opus; aim: 60m/);
    assert.match(launch.message, /Worktree: \/tmp\/wt\/keep-tool\/self-repair-/);
    assert.equal(launch.linkSession, false);

    // …and in the state, where the next tick can see it.
    const entry = selfRepair.loadState(root).signatures[sig];
    assert.equal(entry.cardId, 'repair-card-1');
    assert.equal(entry.sessionId, '11111111-0000-4000-8000-000000000000');
    assert.equal(entry.pane, 'pane-1');
    assert.equal(entry.runId, undefined, 'a repair is a session now, not a headless run');
    assert.equal(entry.attempts, 1);
    assert.equal(selfRepair.loadState(root).openedToday, 1);

    // A third tick opens nothing: one open card per signature.
    const third = await selfRepair.tick({ ...deps, now: later + 60e3 });
    assert.deepEqual(third.opened, []);
    assert.match(third.skipped[0].why, /already open for this signature \(session 11111111\)/);
    assert.equal(calls.cards.length, 1);

    const row = calls.health.at(-1);
    assert.equal(row.name, 'self-repair');
    assert.equal(row.payload.cadenceMs, selfRepair.CADENCE_MS, 'a row with no cadence can never read as silent');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the daily cap, the disable switch and a failed worktree all hold', async () => {
  const root = makeRoot();
  try {
    const rows = ['review', 'unblock', 'notes'].map((name) => ({
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
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
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
    assert.match(calls.checkins.at(-1).message, /a manual `keep open` on it/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a cleared signature gets one check-in, a cooldown, and a linked card if it comes back', async () => {
  const root = makeRoot();
  try {
    const snapshot = snapshotOf([
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const { deps, calls } = harness({ root, snapshot, config: { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 } });
    const opened = await selfRepair.tick(deps);
    const sig = opened.opened[0].sig;

    // The scheduler recovers. The clear clock starts, but nothing is said yet.
    const healed = snapshotOf([{ name: 'unblock', consecutiveFailures: 0, lastOkAt: NOW + 60e3, lastError: 'unblock is broken' }],
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
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
      { name: 'notes', consecutiveFailures: 6, lastError: 'notes is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const config = { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0, maxPerDay: 1 };
    const dry = await selfRepair.dryRun({ root, now: NOW, config, snapshot: () => snapshot });
    assert.deepEqual(dry.candidates.map((row) => row.action), ['open', 'skip']);
    assert.match(dry.candidates[1].why, /daily cap reached/);
    assert.match(selfRepair.renderDry(dry), /would open: Daemon self-repair: unblock/);
    assert.equal(selfRepair.loadState(root).signatures.unblock, undefined, '--dry writes nothing');

    selfRepair.mutateState((state) => {
      state.signatures['sched:unblock:abcd1234'] = { firstSeenAt: NOW, cardId: 'old-card', resolvedAt: NOW, cooldownUntil: NOW + 86400e3 };
    }, { root, now: NOW });
    assert.equal(selfRepair.reset('sched:unblock:abcd1234', { root, now: NOW }).found, true);
    assert.equal(selfRepair.loadState(root).signatures['sched:unblock:abcd1234'].cooldownUntil, undefined);
    assert.equal(selfRepair.reset('sched:nope:00000000', { root, now: NOW }).found, false);

    const value = selfRepair.status({ root, now: NOW, config });
    assert.equal(value.openedToday, 0);
    assert.match(selfRepair.renderStatus(value), /self-repair: enabled/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- the scheduler and the CLI ----------

test('the scheduler ticks on its own cadence and records a row that can read as silent', async () => {
  const ticks = [];
  const scheduler = selfRepair.startScheduler({
    config: { ...selfRepair.DEFAULT_CONFIG, enabled: false },
    record: (name, payload) => ticks.push({ name, payload }),
    write: () => {},
  });
  try {
    await scheduler.tick();
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0].name, 'self-repair');
    // self-repair is not in health.CADENCES, so the row must carry its own.
    assert.equal(ticks[0].payload.cadenceMs, selfRepair.CADENCE_MS);
    assert.equal(require('./health.js').CADENCES['self-repair'], undefined);
    assert.equal(selfRepair.CADENCE_MS, 5 * 60e3);
  } finally {
    clearInterval(scheduler.timer);
    clearTimeout(scheduler.first);
  }
});

test('keep self-repair prints state, dry-runs, and toggles the config', () => {
  const { spawnSync } = require('node:child_process');
  const root = makeRoot();
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'self-repair', ...args], {
    encoding: 'utf8', env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' },
  });
  try {
    const bare = cli();
    assert.equal(bare.status, 0, bare.stderr);
    assert.match(bare.stdout, /self-repair: enabled/);
    assert.match(bare.stdout, /no signatures tracked/);

    selfRepair.mutateState((state) => {
      state.signatures['sched:review:abcd1234'] = {
        firstSeenAt: NOW, cardId: 'a-repair-card', sessionId: 'aaaaaaaa-0000-4000-8000-000000000000', pane: 'pane-7',
        worktree: '/Users/x/wt/keep-tool/self-repair-abcd1234', openedAt: NOW, attempts: 1,
      };
      state.day = '2026-09-15';
      state.openedToday = 1;
    }, { root, now: NOW });
    const open = cli();
    assert.match(open.stdout, /open \(1\)/);
    assert.match(open.stdout, /sched:review:abcd1234 — card a-repair-card, session aaaaaaaa in pane pane-7/);

    const json = cli('--json');
    assert.equal(JSON.parse(json.stdout).open[0].cardId, 'a-repair-card');

    const off = cli('--disable');
    assert.equal(off.status, 0, off.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'watch', 'self-repair.json'), 'utf8')).enabled, false);
    assert.match(cli('--dry').stdout, /self-repair is disabled/);
    assert.equal(cli('--enable').status, 0);

    // --reset refuses while the card is live: one repair card per signature is
    // the invariant the whole scheduler rests on.
    fs.writeFileSync(path.join(root, 'tasks', 'a-repair-card.md'), [
      '---', 'title: Daemon self-repair: review', 'status: active', 'kind: task',
      'tags: [personal, self-repair]', 'created: 2026-09-15', 'updated: 2026-09-15T12:00', '---', '',
    ].join('\n'));
    const refused = cli('--reset', 'sched:review:abcd1234');
    assert.match(refused.stdout, /has a live repair card \(a-repair-card, active\) with a confirmed session/);
    assert.equal(selfRepair.loadState(root).signatures['sched:review:abcd1234'].cardId, 'a-repair-card');

    // A card that has been closed is not a live card, so the signature can clear
    // rather than needing state.json edited by hand.
    fs.writeFileSync(path.join(root, 'tasks', 'a-repair-card.md'), [
      '---', 'title: Daemon self-repair: review', 'status: done', 'kind: task',
      'tags: [personal, self-repair]', 'created: 2026-09-15', 'updated: 2026-09-15T12:00', '---', '',
    ].join('\n'));
    assert.match(cli('--reset', 'sched:review:abcd1234').stdout, /cleared sched:review:abcd1234/);
    selfRepair.mutateState((state) => {
      state.signatures['sched:review:abcd1234'] = {
        firstSeenAt: NOW, cardId: 'a-repair-card', sessionId: 'aaaaaaaa-0000-4000-8000-000000000000',
        pane: 'pane-7', openedAt: NOW, attempts: 1,
      };
    }, { root, now: NOW });
    fs.writeFileSync(path.join(root, 'tasks', 'a-repair-card.md'), [
      '---', 'title: Daemon self-repair: review', 'status: active', 'kind: task',
      'tags: [personal, self-repair]', 'created: 2026-09-15', 'updated: 2026-09-15T12:00', '---', '',
    ].join('\n'));

    // Once it has resolved, --reset clears the cooldown and keeps the card as the
    // link the next one cites.
    selfRepair.mutateState((state) => {
      const entry = state.signatures['sched:review:abcd1234'];
      entry.resolvedAt = NOW;
      entry.cooldownUntil = NOW + 86400e3;
    }, { root, now: NOW });
    const reset = cli('--reset', 'sched:review:abcd1234');
    assert.match(reset.stdout, /cleared sched:review:abcd1234/);
    const after = selfRepair.loadState(root).signatures['sched:review:abcd1234'];
    assert.equal(after.cardId, undefined);
    assert.equal(after.cooldownUntil, undefined);
    assert.equal(after.previousCardId, 'a-repair-card', 'the card it opened stays on the record');
    assert.match(cli('--reset', 'sched:nope:00000000').stdout, /no such signature/);

    const both = cli('--disable', '--enable');
    assert.equal(both.status, 1);
    assert.match(both.stderr, /either --disable or --enable/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- review fixes ----------

test('the card slot is reserved before the worktree, and a lost launch resumes instead of opening again', async () => {
  const root = makeRoot();
  try {
    const snapshot = snapshotOf([
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const config = { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 };

    // The daemon dies during the ~5-minute worktree build. Before the reserve
    // split, nothing had been written yet and the next start opened another card.
    const crashing = harness({ root, snapshot, config });
    crashing.deps.spawnWorktree = () => Promise.reject(new Error('daemon died mid-build'));
    const crashed = await selfRepair.tick(crashing.deps);
    assert.equal(crashed.opened.length, 1);
    assert.equal(crashed.opened[0].launched, false);
    const sig = crashed.opened[0].sig;
    const reserved = selfRepair.loadState(root).signatures[sig];
    assert.equal(reserved.cardId, 'repair-card-1', 'the card was recorded before the slow part');
    assert.equal(reserved.sessionId, null, 'and the launch is visibly unfinished');
    assert.equal(reserved.pane, null);
    assert.equal(selfRepair.loadState(root).openedToday, 1, 'the daily cap already counts it');

    // The next tick inside the backoff leaves it alone rather than opening a second card.
    const next = harness({ root, snapshot, config });
    const soon = await selfRepair.tick({ ...next.deps, now: NOW + 60e3 });
    assert.deepEqual(soon.opened, []);
    assert.deepEqual(soon.resumed, []);
    assert.match(soon.skipped[0].why, /launch is retried in/);
    assert.equal(next.calls.cards.length, 0, 'no second card for the same signature');

    // After the backoff it resumes the launch on the card it already has.
    const later = NOW + 20 * 60e3;
    const resumed = await selfRepair.tick({ ...next.deps, now: later });
    assert.deepEqual(resumed.opened, []);
    assert.equal(resumed.resumed.length, 1);
    assert.equal(resumed.resumed[0].cardId, 'repair-card-1');
    assert.equal(next.calls.cards.length, 0);
    assert.equal(next.calls.runs.length, 1, 'the session finally opens');
    assert.equal(next.calls.artifacts.length, 0, 'the recipe stored with the card is reused, not written again');
    assert.match(next.calls.runs[0].body.message, /recipe\.md/);
    assert.equal(selfRepair.loadState(root).signatures[sig].sessionId, '11111111-0000-4000-8000-000000000000');
    assert.equal(selfRepair.loadState(root).openedToday, 1, 'a resume never spends a second slot');

    // Once it has a run, later ticks leave it alone again.
    const settled = await selfRepair.tick({ ...next.deps, now: later + 60 * 60e3 });
    assert.deepEqual([settled.opened, settled.resumed], [[], []]);
    assert.match(settled.skipped[0].why, /already open .*session 11111111/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a session that cannot be opened is said on the card, and the next tick tries again', async () => {
  const root = makeRoot();
  try {
    const snapshot = snapshotOf([
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const { deps, calls } = harness({
      root, snapshot,
      config: { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 },
      runThrows: 'terminal host is unavailable',
    });
    const opened = await selfRepair.tick(deps);
    assert.equal(opened.opened[0].launched, false);
    assert.equal(opened.opened[0].sessionId, null);
    assert.match(calls.checkins.at(-1).message, /the repair session could not be opened: terminal host is unavailable/);
    assert.match(calls.checkins.at(-1).message, /Open it by hand with `keep open repair-card-1`/);

    // Nothing is running, so the card must not read as launched.
    const entry = selfRepair.loadState(root).signatures[opened.opened[0].sig];
    assert.equal(entry.sessionId, null);
    assert.equal(entry.pane, null);
    assert.equal(selfRepair.resumeBlocker(entry, selfRepair.DEFAULT_CONFIG, NOW + 20 * 60e3), '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an open that fails with a pane attached counts as launched and is never retried', async () => {
  const root = makeRoot();
  try {
    const snapshot = snapshotOf([
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const config = { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 };
    const { deps, calls } = harness({ root, snapshot, config });
    // openSession spawned the pane and then failed to confirm the opening message.
    // The agent is alive in pane-orphan; treating this as "not launched" would put
    // a second agent on the same fault fifteen minutes later.
    deps.openSession = async (body, openDeps) => {
      calls.runs.push({ body, openDeps });
      const error = new Error('the pane stopped echoing');
      error.extra = { launch: { pane: 'pane-orphan', sessionId: 'abcd1234-0000-4000-8000-000000000000', agent: 'claude' } };
      throw error;
    };

    const opened = await selfRepair.tick(deps);
    assert.equal(opened.opened[0].launched, true, 'a pane means an agent is running');
    assert.equal(opened.opened[0].sessionId, 'abcd1234-0000-4000-8000-000000000000');
    const note = calls.checkins.at(-1);
    assert.match(note.message, /opened in pane pane-orphan \(session abcd1234\)/);
    assert.match(note.message, /could not be confirmed: the pane stopped echoing/);
    assert.match(note.message, /Look at that pane before doing anything/);
    assert.match(note.message, /keep self-repair --reset sched:unblock:/);

    const sig = opened.opened[0].sig;
    const entry = selfRepair.loadState(root).signatures[sig];
    assert.equal(entry.pane, 'pane-orphan');
    assert.notEqual(selfRepair.resumeBlocker(entry, config, NOW + 60 * 60e3), '');

    // Later ticks leave it alone: one agent per fault, whatever the launch returned.
    const later = await selfRepair.tick({ ...deps, now: NOW + 60 * 60e3 });
    assert.deepEqual([later.opened, later.resumed], [[], []]);
    assert.equal(calls.runs.length, 1, 'no second pane');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a legacy runId blocks while the old run could still be alive, then stops', () => {
  const config = { ...selfRepair.DEFAULT_CONFIG };
  // Before repairs were sessions the launch was recorded as runId. An upgraded
  // daemon that read a fresh one as "never launched" would put a second agent on
  // it — but those runs were killed at budgetMin, capped at 90 minutes, so an old
  // entry is certainly dead and must not hold its signature open forever.
  const old = (age) => ({ cardId: 'a-repair-card', runId: 'run-1', lastAttemptAt: NOW - age });
  assert.match(selfRepair.resumeBlocker(old(60 * 60e3), config, NOW), /already open for this signature \(run run-1\)/);
  assert.equal(selfRepair.resumeBlocker(old(91 * 60e3), config, NOW), '',
    'past the old wall-clock cap the run is dead and the signature resumes');
  assert.equal(selfRepair.LEGACY_RUN_TTL_MS, selfRepair.MAX_BUDGET_MIN * 60e3);
  // A session or a pane still blocks whatever its age: those are not killed.
  assert.match(selfRepair.resumeBlocker({ cardId: 'c', pane: 'pane-9', lastAttemptAt: 0 }, config, NOW),
    /already open for this signature \(session pane-9\)/);
  assert.equal(selfRepair.resumeBlocker({ cardId: 'c', lastAttemptAt: 0 }, config, NOW), '');
});

test('a card that already has a live pane is never given a second session', async () => {
  const root = makeRoot();
  try {
    const snapshot = snapshotOf([
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const config = { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 };
    const { deps, calls } = harness({ root, snapshot, config });
    // The spawn response was lost after the pane came up. The host still knows.
    deps.findCardPane = async (cardId) => ({ pane: `pane-of-${cardId}`, sessionId: 'eeee1111-0000-4000-8000-000000000000' });

    const opened = await selfRepair.tick(deps);
    assert.equal(opened.opened[0].launched, true);
    assert.equal(calls.runs.length, 0, 'the host said there is already an agent, so none was opened');
    assert.match(calls.checkins.at(-1).message, /Found the repair session already running in pane pane-of-repair-card-1 \(session eeee1111\)/);
    const entry = selfRepair.loadState(root).signatures[opened.opened[0].sig];
    assert.equal(entry.pane, 'pane-of-repair-card-1');
    assert.equal(entry.sessionId, 'eeee1111-0000-4000-8000-000000000000');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('only a pane this scheduler spawned is adopted, never a session Owner opened', async () => {
  const root = makeRoot();
  try {
    const snapshot = snapshotOf([
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const config = { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 };
    // serve.js's findCardPane requires meta.repair as well as meta.card. Run the
    // same matcher here over both kinds of pane on the card.
    const matcher = (panes) => async (cardId) => {
      const match = panes.find((pane) => pane.alive && pane.meta.card === cardId && pane.meta.repair === true);
      return match ? { pane: match.id, sessionId: match.meta.sessionId || null } : null;
    };
    // Owner opened his own session on the repair card to look at the fix. Adopting
    // it would record it as the repair agent, and from then on it would carry
    // KEEP_REPAIR and be refused the `keep restart-daemon` it is there to run.
    const owners = [{ id: 'pane-owner', alive: true, meta: { card: 'repair-card-1', sessionId: 'owners-session' } }];
    const plain = harness({ root, snapshot, config, findCardPane: matcher(owners) });
    const first = await selfRepair.tick(plain.deps);
    assert.equal(plain.calls.runs.length, 1, 'a session that is not the repair agent is not adopted');
    assert.equal(first.opened[0].launched, true);
    assert.match(plain.calls.checkins.at(-1).message, /Session: 11111111 in pane pane-1/);

    // The same card, but the pane carries the flag: that one is this scheduler's,
    // spawned by a launch whose spawn response was lost.
    const mine = [...owners, { id: 'pane-repair', alive: true, meta: { card: 'repair-card-1', repair: true, sessionId: 'ffff2222-0000-4000-8000-000000000000' } }];
    const second = makeRoot();
    try {
      const reused = harness({ root: second, snapshot, config, findCardPane: matcher(mine) });
      const result = await selfRepair.tick(reused.deps);
      assert.equal(reused.calls.runs.length, 0);
      assert.equal(result.opened[0].launched, true);
      assert.equal(result.opened[0].sessionId, 'ffff2222-0000-4000-8000-000000000000');
      assert.match(reused.calls.checkins.at(-1).message, /Found the repair session already running in pane pane-repair/);
    } finally { fs.rmSync(second, { recursive: true, force: true }); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a session that is only briefly gone is not relaunched over', async () => {
  const root = makeRoot();
  try {
    const snapshot = snapshotOf([
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const config = { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 };
    const { deps, calls } = harness({ root, snapshot, config });
    const opened = await selfRepair.tick(deps);
    const sig = opened.opened[0].sig;
    assert.equal(selfRepair.loadState(root).signatures[sig].pane, 'pane-1');

    // A host that cannot be reached says null, and null is not "gone".
    const unknown = await selfRepair.tick({ ...deps, paneAlive: async () => null, now: NOW + 60e3 });
    assert.equal(unknown.relaunching, undefined);
    assert.equal(selfRepair.loadState(root).signatures[sig].deadSince, undefined);

    // An in-place restart or a handoff leaves the pane dead between the agent
    // stopping and replace-exited. One dead observation only starts the clock.
    const dead = { ...deps, paneAlive: async () => false };
    const first = await selfRepair.tick({ ...dead, now: NOW + 2 * 60e3 });
    assert.equal(first.relaunching, undefined, 'one dead reading is a restart window, not an exit');
    assert.equal(selfRepair.loadState(root).signatures[sig].deadSince, NOW + 2 * 60e3);
    assert.equal(calls.runs.length, 1);

    // Still inside the grace window: still nothing.
    const soon = await selfRepair.tick({ ...dead, now: NOW + 8 * 60e3 });
    assert.equal(soon.relaunching, undefined);
    assert.equal(calls.runs.length, 1);

    // The restart finished and the session is back. The clock is cleared, and the
    // session keeps its recorded id, so KEEP_REPAIR stays armed for it throughout.
    await selfRepair.tick({ ...deps, paneAlive: async () => true, now: NOW + 9 * 60e3 });
    assert.equal(selfRepair.loadState(root).signatures[sig].deadSince, undefined);
    assert.equal(selfRepair.loadState(root).signatures[sig].sessionId, '11111111-0000-4000-8000-000000000000');
    assert.equal(calls.runs.length, 1, 'no second agent for a session that was only restarting');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a session that stays gone past the grace window is relaunched, keeping its marker until then', async () => {
  const root = makeRoot();
  try {
    const snapshot = snapshotOf([
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const config = { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 };
    const { deps, calls } = harness({ root, snapshot, config });
    const opened = await selfRepair.tick(deps);
    const sig = opened.opened[0].sig;

    const dead = { ...deps, paneAlive: async () => false };
    await selfRepair.tick({ ...dead, now: NOW + 60e3 });
    const swept = await selfRepair.tick({ ...dead, now: NOW + 60e3 + selfRepair.PANE_DEAD_GRACE_MS });
    assert.equal(swept.relaunching.length, 1);
    assert.equal(swept.relaunching[0].pane, 'pane-1');
    assert.match(calls.checkins.find((entry) => /has been gone for/.test(entry.message)).message,
      /The repair session in pane pane-1 has been gone for 10m without landing; relaunching \(session 2 of 3\)/);
    // The sweep clears the backoff without pretending the entry was never launched:
    // zeroing lastAttemptAt made --reset read an unconfirmed launch as ancient and
    // clear it, which is the guard it was added for.
    assert.equal(swept.relaunching[0].sig, sig);

    // The same tick relaunches onto the card it already has, and only then does the
    // recorded session change — so the old one never lost its KEEP_REPAIR marker.
    assert.equal(swept.resumed.length, 1);
    assert.equal(calls.runs.length, 2);
    assert.equal(calls.cards.length, 1, 'still one card for the signature');
    const entry = selfRepair.loadState(root).signatures[sig];
    assert.equal(entry.pane, 'pane-2');
    assert.equal(entry.relaunchDue, undefined);
    assert.equal(entry.deadSince, undefined);
    assert.equal(entry.attempts, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a session that comes back after the sweep gave up on it is not launched over', async () => {
  const root = makeRoot();
  try {
    const snapshot = snapshotOf([
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const config = { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 };
    const { deps, calls } = harness({ root, snapshot, config });
    const opened = await selfRepair.tick(deps);
    const sig = opened.opened[0].sig;

    // A long restart: the pane reads dead past the grace window, so the sweep sets
    // relaunchDue — and the relaunch it triggers fails to start, so the flag stays.
    const dead = { ...deps, paneAlive: async () => false };
    await selfRepair.tick({ ...dead, now: NOW + 60e3 });
    const at = NOW + 60e3 + selfRepair.PANE_DEAD_GRACE_MS;
    const stuck = { ...dead, now: at, spawnWorktree: () => Promise.reject(new Error('daemon died mid-build')) };
    await selfRepair.tick(stuck);
    assert.equal(selfRepair.loadState(root).signatures[sig].relaunchDue, true);
    assert.equal(selfRepair.loadState(root).signatures[sig].attempts, 2);
    assert.equal(calls.runs.length, 1);

    // Then the restart finishes and the session is back. The flag has to go, or the
    // next tick spends the last attempt launching over an agent that is working.
    await selfRepair.tick({ ...deps, paneAlive: async () => true, now: at + 20 * 60e3 });
    const entry = selfRepair.loadState(root).signatures[sig];
    assert.equal(entry.relaunchDue, undefined);
    assert.equal(entry.deadSince, undefined);
    assert.equal(entry.attempts, 2, 'no attempt spent on a session that was alive all along');
    assert.match(selfRepair.resumeBlocker(entry, config, at + 20 * 60e3), /already open for this signature/);
    assert.equal(calls.runs.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the relaunch flags never outlive the launch they belong to', async () => {
  const root = makeRoot();
  try {
    const failing = snapshotOf([
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const healed = snapshotOf([
      { name: 'unblock', consecutiveFailures: 0, lastOkAt: NOW + 60e3, lastError: 'unblock is broken' },
    ], { startedAt: NOW - 6 * 3600e3 });
    const config = { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 };
    const { deps } = harness({ root, snapshot: failing, config });
    const opened = await selfRepair.tick(deps);
    const sig = opened.opened[0].sig;
    // A fresh launch clears them even when nothing set them, so the open path and
    // the resume path leave the entry in the same shape.
    assert.equal(selfRepair.loadState(root).signatures[sig].relaunchDue, undefined);
    assert.equal(selfRepair.loadState(root).signatures[sig].deadSince, undefined);

    // Leave both set, resolve the signature, and let it come back with a new card.
    selfRepair.mutateState((state) => {
      state.signatures[sig].relaunchDue = true;
      state.signatures[sig].deadSince = NOW;
    }, { root, now: NOW });
    await selfRepair.tick({ ...deps, snapshot: () => healed, now: NOW + 2 * 60e3 });
    await selfRepair.tick({ ...deps, snapshot: () => healed, now: NOW + 70 * 60e3 });
    const after = NOW + 70 * 60e3 + 25 * 3600e3;
    failing.schedulers[0].lastErrorAt = after;
    // The recurrence's launch fails, so only the reservation itself can have
    // cleared them — the post-launch write never runs. Reserving the new card is
    // where the previous launch's flags have to go, or the fresh card starts with
    // its debounce already expired and relaunches the moment it is created.
    const reopened = await selfRepair.tick({
      ...deps, snapshot: () => failing, now: after,
      spawnWorktree: () => Promise.reject(new Error('daemon died mid-build')),
    });
    assert.equal(reopened.opened.length, 1, 'a fresh card for the recurrence');
    assert.equal(reopened.opened[0].launched, false);
    const fresh = selfRepair.loadState(root).signatures[sig];
    assert.equal(fresh.relaunchDue, undefined, 'the new card starts with a clean debounce');
    assert.equal(fresh.deadSince, undefined);

    // …and --reset clears them too, rather than leaking them into the next card.
    selfRepair.mutateState((state) => {
      state.signatures[sig].relaunchDue = true;
      state.signatures[sig].deadSince = NOW;
      state.signatures[sig].launchGaveUp = true;
    }, { root, now: NOW });
    selfRepair.reset(sig, { root, now: after, loadTask: () => ({ fm: { status: 'active' } }), sessionAlive: false });
    const cleared = selfRepair.loadState(root).signatures[sig];
    assert.equal(cleared.relaunchDue, undefined);
    assert.equal(cleared.deadSince, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the sweep clears the backoff without erasing that the card was ever launched', async () => {
  const root = makeRoot();
  try {
    const snapshot = snapshotOf([
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const config = { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 };
    // openSession fails with a pane attached, so the entry carries launchError —
    // the state --reset reads to decide whether an unconfirmed launch might be up.
    const { deps } = harness({ root, snapshot, config, paneAlive: async () => false });
    deps.openSession = async () => {
      const error = new Error('the pane stopped echoing');
      error.extra = { launch: { pane: 'pane-orphan', sessionId: 'abcd1234-0000-4000-8000-000000000000' } };
      throw error;
    };
    const opened = await selfRepair.tick(deps);
    const sig = opened.opened[0].sig;
    assert.notEqual(selfRepair.loadState(root).signatures[sig].launchError, undefined);

    await selfRepair.tick({ ...deps, now: NOW + 60e3 });
    const at = NOW + 60e3 + selfRepair.PANE_DEAD_GRACE_MS;
    // Launching off, so the sweep's write is what stands: this is also the state a
    // daemon that died between the sweep and the relaunch would leave behind.
    const frozen = { ...deps, config: { ...config, launch: false }, now: at };
    const swept = await selfRepair.tick(frozen);
    assert.equal(swept.relaunching.length, 1);
    const entry = selfRepair.loadState(root).signatures[sig];
    assert.equal(entry.relaunchDue, true);
    // Old enough to clear the resume backoff…
    assert.equal(at - entry.lastAttemptAt >= selfRepair.RESUME_BACKOFF_MS, true);
    // …and no older, so the unverified-reset guard still sees a recent launch.
    // Zeroing it made the entry look as though it had never been launched at all.
    assert.equal(at - entry.lastAttemptAt < selfRepair.LEGACY_RUN_TTL_MS, true);
    assert.equal(selfRepair.reset(sig, { root, now: at, loadTask: () => ({ fm: { status: 'active' } }), sessionAlive: null }).reason,
      'unverified');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the status listing says why a row is not doing anything', () => {
  const rows = (entry) => selfRepair.renderStatus({
    config: selfRepair.DEFAULT_CONFIG, day: '2026-09-15', openedToday: 1,
    open: [{ sig: 'sched:unblock:abcd1234', cardId: 'a-repair-card', openedAt: NOW, attempts: 3, ...entry }],
    cooling: [], resolved: [],
  });
  assert.match(rows({ launchGaveUp: true }), /— gave up after 3 sessions \(--reset to start over\)/);
  assert.match(rows({ relaunchDue: true }), /— relaunch due/);
  assert.match(rows({ deadSince: NOW }), /— pane unseen since 2026-09-15 12:00/);
  // A row that is simply working says none of it.
  assert.doesNotMatch(rows({ sessionId: 'abcd1234-0000', pane: 'pane-1' }), /gave up|relaunch due|pane unseen/);
});

test('--reset works after a give-up, which is exactly what the card told Owner to do', () => {
  const root = makeRoot();
  try {
    const seed = (extra) => selfRepair.mutateState((state) => {
      state.signatures['sched:unblock:abcd1234'] = {
        cardId: 'a-repair-card', sessionId: 'agent-session', pane: 'pane-1',
        openedAt: NOW, attempts: 3, lastAttemptAt: NOW, launchGaveUp: true, ...extra,
      };
    }, { root, now: NOW });
    const open = () => ({ fm: { status: 'active' } });

    // The give-up check-in says to run this. Refusing it for `card-open` left Owner
    // with no way out but editing state.json.
    seed({});
    const done = selfRepair.reset('sched:unblock:abcd1234', { root, now: NOW, loadTask: open, sessionAlive: false });
    assert.equal(done.cleared, true);

    // …but a session that is still running still outranks it.
    seed({});
    const alive = selfRepair.reset('sched:unblock:abcd1234', { root, now: NOW, loadTask: open, sessionAlive: true });
    assert.equal(alive.cleared, false);
    assert.equal(alive.reason, 'session-alive');

    // A legacy runId-only entry has no session, and the refusal must not claim one.
    selfRepair.mutateState((state) => {
      state.signatures['sched:unblock:abcd1234'] = {
        cardId: 'a-repair-card', runId: 'run-1', openedAt: NOW, attempts: 1, lastAttemptAt: NOW,
      };
    }, { root, now: NOW });
    const legacy = selfRepair.reset('sched:unblock:abcd1234', { root, now: NOW, loadTask: open, sessionAlive: false });
    assert.equal(legacy.cleared, false);
    assert.equal(legacy.reason, 'card-open');
    assert.equal(legacy.launched, false, 'so the CLI can say "a legacy run record", not "a confirmed session"');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a pane that dies every time gets exactly MAX_LAUNCH_ATTEMPTS sessions, not one per tick', async () => {
  const root = makeRoot();
  try {
    const snapshot = snapshotOf([
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const config = { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 };
    // Every launch works and every pane is then found dead: before the cap counted
    // successful relaunches this handed out a new session every tick forever,
    // checking in "attempt 7 of 3".
    const { deps, calls } = harness({ root, snapshot, config, paneAlive: async () => false });
    let at = NOW;
    await selfRepair.tick({ ...deps, now: at });
    for (let tick = 0; tick < 12; tick += 1) {
      at += selfRepair.PANE_DEAD_GRACE_MS + 60e3;
      await selfRepair.tick({ ...deps, now: at });
    }
    assert.equal(calls.runs.length, selfRepair.MAX_LAUNCH_ATTEMPTS, 'three sessions, then it stops');
    assert.equal(calls.cards.length, 1, 'and one card throughout');
    const sig = Object.keys(selfRepair.loadState(root).signatures)[0];
    const entry = selfRepair.loadState(root).signatures[sig];
    assert.equal(entry.attempts, selfRepair.MAX_LAUNCH_ATTEMPTS);
    assert.equal(entry.launchGaveUp, true);
    assert.match(calls.checkins.find((row) => /will not open another/.test(row.message)).message,
      /That was attempt 3 of 3 for this signature\. Self-repair will not open another/);
    assert.match(calls.checkins.at(-1).message, /keep self-repair --reset sched:unblock:/);
    const last = await selfRepair.tick({ ...deps, now: at + 60 * 60e3 });
    assert.match(last.skipped[0].why, /has used its 3 attempts and nothing landed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the sweep leaves alone a signature that stopped firing or whose card is closed', async () => {
  const root = makeRoot();
  try {
    const failing = snapshotOf([
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const healed = snapshotOf([
      { name: 'unblock', consecutiveFailures: 0, lastOkAt: NOW + 60e3, lastError: 'unblock is broken' },
    ], { startedAt: NOW - 6 * 3600e3 });
    const config = { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 };
    const { deps, calls } = harness({ root, snapshot: failing, config, paneAlive: async () => false });
    const opened = await selfRepair.tick(deps);
    const sig = opened.opened[0].sig;
    const checkins = calls.checkins.length;

    // The symptom cleared. Whatever happened to the pane, this belongs to the
    // resolve path now — relaunching an agent at a fault that is gone is noise.
    let at = NOW + 60e3;
    for (let tick = 0; tick < 3; tick += 1) {
      at += selfRepair.PANE_DEAD_GRACE_MS;
      const quiet = await selfRepair.tick({ ...deps, snapshot: () => healed, now: at });
      assert.equal(quiet.relaunching, undefined);
    }
    assert.equal(calls.runs.length, 1);

    // Still failing, but somebody closed the card: not this scheduler's to relaunch.
    const closed = { ...deps, loadTask: () => ({ fm: { status: 'done' } }) };
    await selfRepair.tick({ ...closed, now: at + selfRepair.PANE_DEAD_GRACE_MS });
    const still = await selfRepair.tick({ ...closed, now: at + 2 * selfRepair.PANE_DEAD_GRACE_MS + 60e3 });
    assert.equal(still.relaunching, undefined);
    assert.equal(calls.runs.length, 1);
    assert.equal(calls.checkins.length, checkins, 'and it says nothing about a card it is not going to touch');
    assert.equal(selfRepair.loadState(root).signatures[sig].relaunchDue, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a relaunch that throws spends its attempt instead of retrying every tick', async () => {
  const root = makeRoot();
  try {
    const snapshot = snapshotOf([
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const config = { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 };
    const { deps, calls } = harness({ root, snapshot, config });
    // The daemon dies during the worktree build, so nothing is ever recorded.
    deps.spawnWorktree = () => Promise.reject(new Error('daemon died mid-build'));
    const opened = await selfRepair.tick(deps);
    const sig = opened.opened[0].sig;
    assert.equal(selfRepair.loadState(root).signatures[sig].attempts, 1);

    // Every resume throws too. The attempt has to be spent before the call, or
    // lastAttemptAt stays 0 and this runs again on every tick, forever.
    let at = NOW;
    for (let tick = 0; tick < 6; tick += 1) {
      at += 20 * 60e3;
      await selfRepair.tick({ ...deps, now: at });
    }
    const entry = selfRepair.loadState(root).signatures[sig];
    assert.equal(entry.attempts, selfRepair.MAX_LAUNCH_ATTEMPTS);
    assert.equal(entry.launchGaveUp, true);
    assert.equal(entry.lastAttemptAt > 0, true, 'the backoff clock is set even when the launch throws');
    assert.equal(calls.cards.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('--reset refuses over a live session, and never drops its record when it refuses', () => {
  const root = makeRoot();
  try {
    const entry = () => selfRepair.loadState(root).signatures['sched:unblock:abcd1234'];
    const seed = (extra) => selfRepair.mutateState((state) => {
      state.signatures['sched:unblock:abcd1234'] = {
        cardId: 'a-repair-card', sessionId: 'agent-session', pane: 'pane-1',
        openedAt: NOW, attempts: 1, lastAttemptAt: NOW, ...extra,
      };
    }, { root, now: NOW });
    const open = () => ({ fm: { status: 'active' } });

    // The host says the session is running. Clearing would take KEEP_REPAIR away
    // from a live agent and let the next tick open a second card on the fault.
    seed({ launchError: 'could not confirm' });
    const alive = selfRepair.reset('sched:unblock:abcd1234', { root, now: NOW, loadTask: open, sessionAlive: true });
    assert.equal(alive.cleared, false);
    assert.equal(alive.reason, 'session-alive');
    assert.equal(entry().sessionId, 'agent-session', 'a refused reset never drops the record');
    assert.equal(entry().pane, 'pane-1');

    // The host could not be asked and the launch was never confirmed: inside the
    // window where the pane is plausibly up, refuse rather than guess.
    const unsure = selfRepair.reset('sched:unblock:abcd1234', { root, now: NOW + 60e3, loadTask: open, sessionAlive: null });
    assert.equal(unsure.cleared, false);
    assert.equal(unsure.reason, 'unverified');
    assert.equal(entry().sessionId, 'agent-session');

    // Past that window, an unconfirmed launch clears.
    const stale = selfRepair.reset('sched:unblock:abcd1234',
      { root, now: NOW + selfRepair.LEGACY_RUN_TTL_MS + 60e3, loadTask: open, sessionAlive: null });
    assert.equal(stale.cleared, true);

    // A confirmed session on an open card is refused for the card, not the pane…
    seed({});
    const card = selfRepair.reset('sched:unblock:abcd1234', { root, now: NOW, loadTask: open, sessionAlive: false });
    assert.equal(card.cleared, false);
    assert.equal(card.reason, 'card-open');
    assert.equal(entry().sessionId, 'agent-session');
    // …and clears once that card is closed and the pane is confirmed gone.
    const done = selfRepair.reset('sched:unblock:abcd1234',
      { root, now: NOW, loadTask: () => ({ fm: { status: 'done' } }), sessionAlive: false });
    assert.equal(done.cleared, true);
    assert.equal(entry().cardId, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a corrupt state file says so instead of silently losing every open card', () => {
  const root = makeRoot();
  selfRepair._resetWarnings();
  try {
    fs.mkdirSync(selfRepair.stateDir(root), { recursive: true });
    fs.writeFileSync(selfRepair.stateFile(root), '{ "signatures": { truncated');
    const logged = [];
    const state = selfRepair.loadState(root, (line) => logged.push(line));
    assert.deepEqual(state, { signatures: {}, day: '', openedToday: 0 });
    assert.match(logged.join(''), /state\.json is unreadable/);
    assert.match(logged.join(''), /KEEP_REPAIR marker for any live repair session are lost/);
    // Once per path, not once per tick.
    selfRepair.loadState(root, (line) => logged.push(line));
    assert.equal(logged.length, 1);
    // A missing file is not corruption and says nothing.
    fs.rmSync(selfRepair.stateFile(root));
    selfRepair.loadState(root, (line) => logged.push(line));
    assert.equal(logged.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('only the session Keep launched is marked as the repair agent', () => {
  const root = makeRoot();
  try {
    selfRepair.mutateState((state) => {
      state.signatures['sched:unblock:abcd1234'] = { cardId: 'a-repair-card', sessionId: 'agent-session', pane: 'pane-1' };
    }, { root, now: NOW });
    assert.equal(selfRepair.isRepairSession('agent-session', root), true);
    // Owner's own session on the repair card is not the repair agent: marking it
    // would refuse him the `keep restart-daemon` the card exists to ask him for.
    assert.equal(selfRepair.isRepairSession('owners-session', root), false);
    assert.equal(selfRepair.isRepairSession('', root), false);
    assert.equal(selfRepair.isRepairSession(undefined, root), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a launch that keeps failing gives up instead of retrying forever', async () => {
  const root = makeRoot();
  try {
    const snapshot = snapshotOf([
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const { deps, calls } = harness({
      root, snapshot,
      config: { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 },
      worktree: { ok: false, error: 'worktree exists' },
    });
    await selfRepair.tick(deps);
    let at = NOW;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      at += 20 * 60e3;
      await selfRepair.tick({ ...deps, now: at });
    }
    assert.equal(calls.cards.length, 1, 'one card throughout');
    assert.equal(calls.runs.length, 0);
    const entry = selfRepair.loadState(root).signatures[Object.keys(selfRepair.loadState(root).signatures)[0]];
    assert.equal(entry.attempts, selfRepair.MAX_LAUNCH_ATTEMPTS);
    assert.equal(entry.launchGaveUp, true);
    const last = await selfRepair.tick({ ...deps, now: at + 60 * 60e3 });
    assert.match(last.skipped[0].why, /has used its 3 attempts and nothing landed; it will not get another/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a worktree outside the worktree root is refused on the card, not launched into', async () => {
  const root = makeRoot();
  try {
    const snapshot = snapshotOf([
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const { deps, calls } = harness({
      root, snapshot,
      config: { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 },
      // `wt new` printed something that is not a worktree — the live checkout, say.
      worktree: { ok: true, path: `${os.homedir()}/keep-tool` },
      insideWorktreeRoot: () => false,
    });
    const result = await selfRepair.tick(deps);
    assert.equal(result.opened[0].launched, false);
    assert.equal(calls.runs.length, 0, 'no agent is launched outside a worktree');
    assert.match(calls.checkins.at(-1).message, /Refusing to launch: .* is not inside the configured worktree root/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a half-built worktree is rebuilt rather than reused', async () => {
  const root = makeRoot();
  const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-self-repair-wt-'));
  try {
    const target = path.join(wtRoot, 'keep-tool', 'self-repair-abcd1234');
    const worktreePath = () => target;
    const calls = [];
    const execFile = (bin, args, options, done) => {
      calls.push(args.slice(1));
      if (args[1] === 'rm') { fs.rmSync(target, { recursive: true, force: true }); return done(null, '', ''); }
      fs.mkdirSync(path.join(target, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(target, '.git'), 'gitdir: elsewhere');
      return done(null, `${target}\n`, '');
    };

    // Nothing there: built once.
    const fresh = await selfRepair.spawnWorktree('self-repair-abcd1234', { worktreePath, execFile });
    assert.deepEqual(fresh, { ok: true, path: target });
    assert.deepEqual(calls, [['new', 'keep-tool/self-repair-abcd1234']]);
    assert.equal(selfRepair.worktreeReady(target), true);

    // A finished tree is reused without shelling out at all.
    calls.length = 0;
    const reused = await selfRepair.spawnWorktree('self-repair-abcd1234', { worktreePath, execFile });
    assert.equal(reused.reused, true);
    assert.deepEqual(calls, []);

    // A stump — a checkout with no install — is removed and built again.
    calls.length = 0;
    fs.rmSync(path.join(target, 'node_modules'), { recursive: true, force: true });
    assert.equal(selfRepair.worktreeReady(target), false, 'a checkout alone is not a usable worktree');
    const rebuilt = await selfRepair.spawnWorktree('self-repair-abcd1234', { worktreePath, execFile });
    assert.equal(rebuilt.ok, true);
    assert.deepEqual(calls, [['rm', target, '--force', '--delete'], ['new', 'keep-tool/self-repair-abcd1234']]);

    // A failed install is not a usable worktree either.
    fs.writeFileSync(path.join(target, '.wt-install-failed'), '');
    assert.equal(selfRepair.worktreeReady(target), false);

    // If the stump cannot be removed, say so rather than hand it over.
    const stubborn = await selfRepair.spawnWorktree('self-repair-abcd1234', {
      worktreePath, execFile: (bin, args, options, done) => done(new Error('worktree is dirty'), '', 'wt: worktree is dirty'),
    });
    assert.equal(stubborn.ok, false);
    assert.match(stubborn.error, /half-built worktree at .* could not be removed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wtRoot, { recursive: true, force: true });
  }
});

test('evidence is redacted before it is committed with the registry', () => {
  const { redactSecrets } = selfRepair;
  const line = 'keep slack: POST https://bot:' + FAKE_SLACK_SHORT + '@hooks.slack.test/services failed; '
    + 'SLACK_TOKEN=' + FAKE_SLACK_LONG + ' GITHUB_SECRET="s3cret-value" --api-key AKIA1234567890ABCD '
    + 'header Bearer eyJhbGciOi.JIUzI1NiIsInR5c.CI6IkpXVCJ9 sid=39f6a38a-1111-2222-3333-444455556666 sha 824a8c1f9b0d';
  const redacted = redactSecrets(line);
  for (const secret of [FAKE_SLACK_SHORT, FAKE_SLACK_LONG, 's3cret-value', 'AKIA1234567890ABCD', 'eyJhbGciOi.JIUzI1NiIsInR5c.CI6IkpXVCJ9']) {
    assert.equal(redacted.includes(secret), false, secret);
  }
  assert.match(redacted, /https:\/\/bot:…@hooks\.slack\.test/);
  assert.match(redacted, /SLACK_TOKEN=…/);
  assert.match(redacted, /Bearer …/);
  // What makes the excerpt worth reading survives: session ids and shas are not secrets.
  assert.match(redacted, /sid=39f6a38a-1111-2222-3333-444455556666/);
  assert.match(redacted, /sha 824a8c1f9b0d/);

  // …and it is applied on the way into every evidence file and onto the card.
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, '.keep', 'serve.log'), `keep unblock: ${line}\n`);
    const snapshot = snapshotOf([
      { name: 'unblock', consecutiveFailures: 6, lastError: `tick failed: SLACK_TOKEN=${FAKE_SLACK_LONG}`, lastErrorAt: NOW },
    ], { startedAt: NOW - 3600e3 });
    const candidate = selfRepair.signatures(snapshot, null, NOW, { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 }, null)[0];
    const evidence = selfRepair.collectEvidence(candidate, snapshot, { root, now: NOW });
    for (const file of evidence.files) {
      assert.equal(file.text.includes(FAKE_SLACK_LONG), false, file.name);
    }
    assert.deepEqual(JSON.parse(evidence.files[1].text).schedulers.length, 1, 'the JSON stays parseable');
    assert.equal(selfRepair.cardTitle(candidate).includes(FAKE_SLACK_LONG), false);
    assert.equal(selfRepair.symptomNote(candidate).includes(FAKE_SLACK_LONG), false);
    assert.equal(selfRepair.buildRecipe({ candidate, cardId: 'c', worktree: '/w', branch: 'b' })
      .includes(FAKE_SLACK_LONG), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the recipe cites evidence by absolute path, and a lost recipe path is found again', async () => {
  const root = makeRoot();
  try {
    const snapshot = snapshotOf([
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const config = { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 };
    const { deps, calls } = harness({ root, snapshot, config });
    await selfRepair.tick(deps);

    // The agent reads this with the worktree as its cwd, where `.keep/artifacts/...`
    // resolves to nothing. Absolute, or it is not a citation.
    const recipe = calls.artifactText.get('recipe.md');
    assert.match(recipe, new RegExp(`- ${root.replace(/[.*+?^$()|[\\]\\\\]/g, '\\\\$&')}/\\.keep/artifacts/repair-card-1/health-row\\.json`));
    assert.equal(/^- \.keep\//m.test(recipe), false, 'no keep-relative path survives into the recipe');
    // …while the card and the state keep the short spelling.
    assert.match(calls.checkins.at(-1).message, /Evidence: \.keep\/artifacts\/repair-card-1\/health-row\.json/);

    // A daemon that died between reserving the card and recording the path left
    // the file behind; the resume finds it rather than saying it was never stored.
    const stored = path.join(root, '.keep', 'artifacts', 'repair-card-1', 'recipe.md');
    fs.mkdirSync(path.dirname(stored), { recursive: true });
    fs.writeFileSync(stored, recipe);
    assert.equal(selfRepair.findRecipeArtifact('repair-card-1', root), stored);
    assert.equal(selfRepair.findRecipeArtifact('no-such-card', root), '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a junk KEEP_REPAIR_MODEL is ignored loudly instead of failing the launch', () => {
  const config = { ...selfRepair.DEFAULT_CONFIG, model: 'opus' };
  const logged = [];
  const write = (line) => logged.push(line);
  assert.equal(selfRepair.launchModel(config, {}, write), 'opus');
  assert.equal(selfRepair.launchModel(config, { KEEP_REPAIR_MODEL: 'claude-fable-5-1' }, write), 'claude-fable-5-1');
  assert.deepEqual(logged, [], 'a model id passes through silently');
  // A value the claude CLI would reject must not reach it: the worktree is already
  // built by then, so the launch would fail for a typo in an env var.
  assert.equal(selfRepair.launchModel(config, { KEEP_REPAIR_MODEL: 'opus --dangerously' }, write), 'opus');
  assert.match(logged.join(''), /ignoring KEEP_REPAIR_MODEL="opus --dangerously": not a model id; using opus/);
});

test('the attempt counter belongs to one card, not to the signature forever', async () => {
  const root = makeRoot();
  try {
    const failing = snapshotOf([
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const healed = snapshotOf([
      { name: 'unblock', consecutiveFailures: 0, lastOkAt: NOW + 60e3, lastError: 'unblock is broken' },
    ], { startedAt: NOW - 6 * 3600e3 });
    const config = { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 0 };
    const { deps } = harness({ root, snapshot: failing, config, worktree: { ok: false, error: 'worktree exists' } });

    // Two failed launches, then the symptom clears on its own.
    await selfRepair.tick(deps);
    await selfRepair.tick({ ...deps, now: NOW + 20 * 60e3 });
    const sig = Object.keys(selfRepair.loadState(root).signatures)[0];
    assert.equal(selfRepair.loadState(root).signatures[sig].attempts, 2);

    await selfRepair.tick({ ...deps, snapshot: () => healed, now: NOW + 25 * 60e3 });
    await selfRepair.tick({ ...deps, snapshot: () => healed, now: NOW + 95 * 60e3 });
    const resolved = selfRepair.loadState(root).signatures[sig];
    assert.ok(resolved.resolvedAt);
    assert.equal(resolved.attempts, undefined, 'a recurrence must not start one try from giving up');
    assert.equal(resolved.launchGaveUp, undefined);

    // …and --reset clears it too.
    selfRepair.mutateState((state) => { state.signatures[sig].attempts = 3; state.signatures[sig].launchGaveUp = true; },
      { root, now: NOW });
    selfRepair.reset(sig, { root, now: NOW });
    const after = selfRepair.loadState(root).signatures[sig];
    assert.equal(after.attempts, undefined);
    assert.equal(after.launchGaveUp, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('zero is a meaningful cap but not a meaningful threshold', () => {
  const root = makeRoot();
  selfRepair._resetWarnings();
  try {
    fs.writeFileSync(path.join(root, 'watch', 'self-repair.json'), JSON.stringify({
      maxPerDay: 0, restartsPerHour: 0, minFailures: 0, cooldownHours: 0, budgetMin: 0,
    }));
    const logged = [];
    const config = selfRepair.loadConfig(root, (line) => logged.push(line));
    assert.equal(config.maxPerDay, 0, 'zero cards a day is how you pause it without disabling it');
    assert.equal(config.restartsPerHour, 0, 'zero means any restart in the last hour is a loop');
    assert.equal(config.minFailures, selfRepair.DEFAULT_CONFIG.minFailures);
    assert.equal(config.cooldownHours, selfRepair.DEFAULT_CONFIG.cooldownHours);
    assert.equal(config.budgetMin, selfRepair.DEFAULT_CONFIG.budgetMin);
    assert.match(logged.join(''), /ignoring "minFailures": expected a number >= 1/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a resolved signature has to earn its age again before it reopens', async () => {
  const root = makeRoot();
  try {
    const failing = snapshotOf([
      { name: 'unblock', consecutiveFailures: 6, lastError: 'unblock is broken', lastErrorAt: NOW, lastOkAt: NOW - 5 * 3600e3 },
    ], { startedAt: NOW - 6 * 3600e3 });
    const healed = snapshotOf([
      { name: 'unblock', consecutiveFailures: 0, lastOkAt: NOW + 60e3, lastError: 'unblock is broken' },
    ], { startedAt: NOW - 6 * 3600e3 });
    const { deps } = harness({ root, snapshot: failing, config: { ...selfRepair.DEFAULT_CONFIG, minAgeMin: 30 } });
    selfRepair.mutateState((state) => {
      state.signatures[`sched:unblock:${selfRepair.signatureHash('unblock', selfRepair.normalizeError('unblock is broken'))}`] = { firstSeenAt: NOW - 60 * 60e3 };
    }, { root, now: NOW });

    const opened = await selfRepair.tick(deps);
    assert.equal(opened.opened.length, 1);
    const sig = opened.opened[0].sig;

    await selfRepair.tick({ ...deps, snapshot: () => healed, now: NOW + 2 * 60e3 });
    await selfRepair.tick({ ...deps, snapshot: () => healed, now: NOW + 70 * 60e3 });
    assert.equal(selfRepair.loadState(root).signatures[sig].firstSeenAt, undefined,
      'the age clock is cleared on resolution, so a recurrence is a new fault');

    // It comes back after the cooldown: seen again, but not old enough yet.
    const after = NOW + 70 * 60e3 + 25 * 3600e3;
    failing.schedulers[0].lastErrorAt = after;
    const again = await selfRepair.tick({ ...deps, snapshot: () => failing, now: after });
    assert.deepEqual(again.opened, []);
    assert.match(again.skipped[0].why, /needs 30m/);
    assert.equal(selfRepair.loadState(root).signatures[sig].firstSeenAt, after);

    // Half an hour of the same failure later, it opens again.
    failing.schedulers[0].lastErrorAt = after + 31 * 60e3;
    const reopened = await selfRepair.tick({ ...deps, snapshot: () => failing, now: after + 31 * 60e3 });
    assert.equal(reopened.opened.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- the landed-fix predicate the restart guard asks ----------

test('cardForSession finds the card this session is the repair agent for', () => {
  const root = makeRoot();
  try {
    selfRepair.mutateState((value) => {
      value.signatures['sched:unblock:abcd1234'] = { cardId: 'repair-unblock', sessionId: 'repair-session' };
      value.signatures['daemon:restart-loop'] = { cardId: 'repair-loop', sessionId: null };
      value.signatures['sched:digest:00000000'] = { cardId: '', sessionId: 'no-card-session' };
    }, { root, now: NOW });

    assert.equal(selfRepair.cardForSession('repair-session', root), 'repair-unblock');
    assert.equal(selfRepair.cardForSession('owners-session', root), '');
    assert.equal(selfRepair.cardForSession('', root), '');
    assert.equal(selfRepair.cardForSession(null, root), '');
    // A signature with no card id is not a match: there is nothing to check.
    assert.equal(selfRepair.cardForSession('no-card-session', root), '');
    // The same entry isRepairSession matches, so the two can never disagree.
    assert.equal(selfRepair.isRepairSession('repair-session', root), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function writeCard(root, id, body) {
  fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks', `${id}.md`), [
    '---',
    `title: ${id}`,
    'status: review',
    'kind: task',
    'tags: [personal]',
    'project: ~/keep-tool',
    'created: 2026-09-15',
    'updated: 2026-09-15T12:00:00',
    '---',
    '',
    body,
    '',
  ].join('\n'));
}

function makeRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-self-repair-repo-')));
  const git = (...args) => {
    const result = require('node:child_process').spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
    return result.stdout.trim();
  };
  git('init', '--quiet', '--initial-branch=master');
  git('config', 'user.name', 'Keep Test');
  git('config', 'user.email', 'keep@example.test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'base');
  // The landed commit has a parent: a root commit has no patch, and no patch-id.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  git('commit', '--quiet', '-am', 'the fix');
  const landedSha = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n');
  git('commit', '--quiet', '-am', 'still local');
  const localSha = git('rev-parse', 'HEAD');
  // origin/master is where the land pushed to; the second commit is still local.
  git('update-ref', 'refs/remotes/origin/master', landedSha);
  const patchIdOf = (sha) => {
    const patch = require('node:child_process').spawnSync('git', ['-C', repo, 'diff-tree', '-p', '--no-color', sha], { encoding: 'utf8' }).stdout;
    const out = require('node:child_process').spawnSync('git', ['-C', repo, 'patch-id', '--stable'], { input: patch, encoding: 'utf8' }).stdout;
    return out.trim().split(/\s+/)[0] || '';
  };
  return { repo, landedSha, localSha, landedPatch: patchIdOf(landedSha), localPatch: patchIdOf(localSha) };
}

function writeReview(root, id, commits, verdict = 'clean') {
  const dir = path.join(root, '.keep', 'reviews');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify([
    {
      id: 'rev-abc', at: '2026-09-15T11:00:00.000Z', by: 'codex sol', verdict,
      commits: (Array.isArray(commits) ? commits : [commits]).filter(Boolean)
        .map((patchId) => ({ sha: 'f'.repeat(40), patchId, subject: 'the fix' })),
    },
  ]) + '\n');
}

test('landedFor answers from the keep land check-in and the live checkout refs', () => {
  const root = makeRoot();
  const { repo, landedSha, localSha, landedPatch, localPatch } = makeRepo();
  try {
    const checkouts = [repo];
    const landedEntry = (sha) => [
      '## 2026-09-15 12:00 — check-in',
      'Landed wt/self-repair-abcd1234 onto master (review record rev-abc).',
      `commits: ${sha}`,
    ].join('\n');

    writeCard(root, 'repair-landed', landedEntry(landedSha));
    writeReview(root, 'repair-landed', landedPatch);
    const yes = selfRepair.landedFor('repair-landed', root, { checkouts });
    assert.equal(yes.landed, true);
    assert.equal(yes.sha, landedSha);

    // Pushed nowhere: the sha is real, but it is not on origin/master.
    writeCard(root, 'repair-local', landedEntry(localSha));
    writeReview(root, 'repair-local', localPatch);
    const notYet = selfRepair.landedFor('repair-local', root, { checkouts });
    assert.equal(notYet.landed, false);
    assert.match(notYet.why, /is not on origin's default branch/);

    // A sha this checkout has never heard of is not a land either.
    writeCard(root, 'repair-unknown', landedEntry('deadbee1deadbee2deadbee3deadbee4deadbee5'));
    writeReview(root, 'repair-unknown', landedPatch);
    assert.equal(selfRepair.landedFor('repair-unknown', root, { checkouts }).landed, false);

    // Every other check-in on the card, however much it talks about landing. The
    // session can write these, so prose next to a real sha must not read as a land.
    writeCard(root, 'repair-talk', [
      '## 2026-09-15 12:00 — check-in',
      `Fix is ready to land on master as ${landedSha}; keep allow refused it.`,
      '',
      '## 2026-09-15 11:00 — check-in',
      'Landed the test harness onto the branch, so the suite runs there now.',
      `commits: ${landedSha}`,
    ].join('\n'));
    const talk = selfRepair.landedFor('repair-talk', root, { checkouts });
    assert.equal(talk.landed, false);
    assert.match(talk.why, /no `keep land` check-in citing a commit/);

    // A card with the right line and the right sha, but no review record: a repair
    // card carries no grants, so nothing could have landed through `keep land`.
    writeCard(root, 'repair-unreviewed', landedEntry(landedSha));
    const unreviewed = selfRepair.landedFor('repair-unreviewed', root, { checkouts });
    assert.equal(unreviewed.landed, false);
    assert.match(unreviewed.why, /no clean `keep reviewed` record/);
    writeReview(root, 'repair-unreviewed', landedPatch, 'findings');
    assert.equal(selfRepair.landedFor('repair-unreviewed', root, { checkouts }).landed, false,
      'a findings record is not authority for a land either');
    // A clean record over some other patch is not this land: the record exists
    // before the land, so a check-in naming an unrelated old commit must not pass.
    writeReview(root, 'repair-unreviewed', localPatch, 'clean');
    const mismatched = selfRepair.landedFor('repair-unreviewed', root, { checkouts });
    assert.equal(mismatched.landed, false);
    assert.match(mismatched.why, /not a patch .* review record covers/);
    writeReview(root, 'repair-unreviewed', landedPatch, 'clean');
    assert.equal(selfRepair.landedFor('repair-unreviewed', root, { checkouts }).landed, true);

    // The land is found wherever it sits in the log, not only at the top.
    writeCard(root, 'repair-older', [
      '## 2026-09-15 13:00 — check-in',
      'Waiting on the daemon to come back.',
      '',
      landedEntry(landedSha),
    ].join('\n'));
    writeReview(root, 'repair-older', landedPatch);
    assert.equal(selfRepair.landedFor('repair-older', root, { checkouts }).landed, true);

    // No card, a card that is not there, and a card id nobody can parse.
    assert.equal(selfRepair.landedFor('', root, { checkouts }).landed, false);
    const missing = selfRepair.landedFor('repair-gone', root, { checkouts });
    assert.equal(missing.landed, false);
    assert.match(missing.why, /could not be read/);
    assert.equal(selfRepair.landedFor('Not A Card Id', root, { checkouts }).landed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('landedShas reads only the shas keep land cited', () => {
  const shas = selfRepair.landedShas({
    body: [
      '## 2026-09-15 12:00 — check-in',
      'Landed wt/self-repair-abcd1234 onto master (review record rev-abc).',
      'commits: aaaaaaa1111, bbbbbbb2222',
      '',
      '## 2026-09-15 11:00 — check-in',
      'Fixed the tick.',
      'commits: ccccccc3333',
    ].join('\n'),
  });
  assert.deepEqual(shas, ['aaaaaaa1111', 'bbbbbbb2222']);
  // Only the whole line `keep land` writes, not prose that mentions landing.
  assert.deepEqual(selfRepair.landedShas({
    body: [
      '## 2026-09-15 12:00 — check-in',
      'Landed the fix onto master by hand after a lot of trouble.',
      'commits: aaaaaaa1111',
    ].join('\n'),
  }), []);
  assert.deepEqual(selfRepair.landedShas({
    body: [
      '## 2026-09-15 12:00 — check-in',
      'Landed wt/self-repair-abcd1234 onto master.',
      'commits: aaaaaaa1111',
    ].join('\n'),
  }), ['aaaaaaa1111']);
  assert.deepEqual(selfRepair.landedShas({ body: '' }), []);
  assert.deepEqual(selfRepair.landedShas(null), []);
});
