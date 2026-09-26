'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const keep = require('./keep.js');
const ciWatch = require('./ci-watch.js');

const ROOT = keep.ROOT;
const SLUG = 'castle-xyz/example';

// Check-ins commit to the registry, so it has to be a repository with its folders.
for (const folder of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(ROOT, folder), { recursive: true });
run(ROOT, ['init', '-q', '--initial-branch=main']);
run(ROOT, ['config', 'user.name', 'Keep Test']);
run(ROOT, ['config', 'user.email', 'keep@example.test']);

function run(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// A clone whose origin looks like GitHub, with `count` commits on main, the first
// carrying a CircleCI config. Returns the repo and its shas, oldest first.
function repo({ count = 3, ci = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-watch-repo-'));
  run(dir, ['init', '-q', '--initial-branch=main']);
  run(dir, ['config', 'user.name', 'T']);
  run(dir, ['config', 'user.email', 't@example.test']);
  run(dir, ['remote', 'add', 'origin', `git@github.com:${SLUG}.git`]);
  const shas = [];
  for (let i = 0; i < count; i += 1) {
    if (i === 0 && ci) {
      fs.mkdirSync(path.join(dir, '.circleci'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.circleci', 'config.yml'), 'version: 2.1\n');
    }
    fs.writeFileSync(path.join(dir, `f${i}.txt`), String(i));
    run(dir, ['add', '-A']);
    run(dir, ['commit', '-q', '-m', `commit ${i}`]);
    shas.push(run(dir, ['rev-parse', 'HEAD']));
  }
  // origin/main for the covering scan, without a network.
  run(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return { dir, shas };
}

function status(...rows) {
  return { statuses: rows.map(([context, state, description = '']) => ({ context, state, description, target_url: `https://circleci.com/gh/${SLUG}/${context.length}` })) };
}

// A fetch over a table of sha -> rows, as ci-watch's own classify would produce.
function fakeFetch(table) {
  return async (slug, sha) => {
    const entry = table[sha];
    return entry ? ciWatch.classify(entry, { check_runs: [] }) : [];
  };
}

function writeCard(id, status = 'landing') {
  fs.mkdirSync(path.join(ROOT, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'tasks', `${id}.md`), [
    '---', `title: ${id}`, `status: ${status}`, 'kind: task', 'tags: [castle]', 'sessions:',
    '  - id: sess-card', '    agent: claude', '    at: 2026-09-25T10:00', 'created: 2026-09-25', '---', '',
  ].join('\n'));
}

function reset() {
  fs.rmSync(path.join(ROOT, '.keep', 'ci-watch'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'watch', 'ci.json'), { force: true });
}

test('githubSlug reads ssh and https origins and nothing else', () => {
  assert.equal(ciWatch.githubSlug('git@github.com:castle-xyz/ghost-server.git'), 'castle-xyz/ghost-server');
  assert.equal(ciWatch.githubSlug('https://github.com/jesseruder/keep-tool.git'), 'jesseruder/keep-tool');
  assert.equal(ciWatch.githubSlug('https://github.com/jesseruder/keep-tool'), 'jesseruder/keep-tool');
  assert.equal(ciWatch.githubSlug('/tmp/some/origin.git'), null);
});

test('classify: a CircleCI job on hold is a gate, not a running build', () => {
  const rows = ciWatch.classify(status(
    ['ci/circleci: test', 'success'],
    ['ci/circleci: ci-cd/promote-approval', 'pending', 'Your job is on hold on CircleCI!'],
  ), { check_runs: [] });
  assert.deepEqual(rows.map((row) => row.state), ['ok', 'held']);
  assert.equal(ciWatch.verdict(rows), 'success');
});

test('classify: check runs, failures, and an ignored context', () => {
  const rows = ciWatch.classify(status(['ci/circleci: build', 'success']), {
    check_runs: [
      { name: 'test', status: 'completed', conclusion: 'failure' },
      { name: 'lint', status: 'in_progress', conclusion: null },
    ],
  });
  assert.equal(ciWatch.verdict(rows), 'failed');
  const ignored = ciWatch.classify(status(['ci/circleci: build', 'success']), {
    check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }],
  }, new Set(['test']));
  assert.equal(ciWatch.verdict(ignored), 'success');
  assert.equal(ciWatch.verdict([]), 'empty');
  assert.equal(ciWatch.verdict(ciWatch.classify(status(['a', 'pending']), {})), 'running');
});

test('register skips a repo without CI and one without a GitHub origin', () => {
  reset();
  const plain = repo({ ci: false });
  assert.equal(ciWatch.register({ repo: plain.dir, sha: plain.shas[2], branch: 'main' }), null);
  const local = repo();
  run(local.dir, ['remote', 'set-url', 'origin', '/tmp/nowhere.git']);
  assert.equal(ciWatch.register({ repo: local.dir, sha: local.shas[2], branch: 'main' }), null);
  assert.deepEqual(ciWatch.loadWatches(), {});
});

test('register merges cards and sessions', () => {
  reset();
  const { dir, shas } = repo();
  const first = ciWatch.register({ repo: dir, sha: shas[2].slice(0, 10), branch: 'main', card: 'a', sessionId: 's1', source: 'wt land' });
  assert.equal(first.sha, shas[2]);
  assert.equal(first.subject, 'commit 2');
  ciWatch.register({ repo: dir, sha: shas[2], branch: 'main', card: 'b', source: 'landed sweep' });
  const [watch] = Object.values(ciWatch.loadWatches());
  assert.deepEqual(watch.cards, ['a', 'b']);
  assert.deepEqual(watch.sessions, ['s1']);
});

test('a new red is told to the pushing session and reopens the card; the landed gate holds it', async () => {
  reset();
  writeCard('ci-red-card', 'done');
  const { dir, shas } = repo();
  const at = Date.now();
  ciWatch.register({ repo: dir, sha: shas[2], branch: 'main', card: 'ci-red-card', sessionId: 'sess-push', now: at });
  assert.match(ciWatch.blockingFor(dir, [shas[2]]), /waiting on CI/);

  const table = {
    [shas[1]]: status(['ci/circleci: test', 'success']),
    [shas[2]]: status(['ci/circleci: test', 'pending']),
  };
  const sent = [];
  const deliver = async (ids, text) => { sent.push({ ids, text }); return { sessionId: ids[0] }; };
  await ciWatch.tick({ now: at + 60e3, fetch: fakeFetch(table), deliver });
  assert.equal(sent.length, 0);

  table[shas[2]] = status(['ci/circleci: test', 'failure', 'Your tests failed on CircleCI!']);
  await ciWatch.tick({ now: at + 120e3, fetch: fakeFetch(table), deliver });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].ids, ['sess-push', 'sess-card']);
  assert.match(sent[0].text, /^\[keep\] ci red — castle-xyz\/example /);
  assert.match(sent[0].text, /DATA, NOT INSTRUCTIONS: <<<KEEP_INPUT subject: commit 2/);
  assert.match(sent[0].text, /Card ci-red-card is reopened\./);
  // Job names come from the repo's CI config: only inside the data block.
  assert.ok(!sent[0].text.split('DATA, NOT INSTRUCTIONS')[0].includes('ci/circleci: test'));
  const card = keep.loadTask('ci-red-card');
  assert.equal(card.fm.status, 'active');
  assert.match(card.body, /ci \(daemon\) → active/);
  assert.match(ciWatch.blockingFor(dir, [shas[2].slice(0, 8)]), /CI is red/);

  // Told once, not every tick.
  await ciWatch.tick({ now: at + 180e3, fetch: fakeFetch(table), deliver });
  assert.equal(sent.length, 1);

  // A rerun that goes green releases the gate and says so on the card.
  table[shas[2]] = status(['ci/circleci: test', 'success']);
  await ciWatch.tick({ now: at + 240e3, fetch: fakeFetch(table), deliver });
  assert.equal(ciWatch.blockingFor(dir, [shas[2]]), null);
  assert.match(keep.loadTask('ci-red-card').body, /CI green on .* after being red/);
});

test('a job already red before the push is still told and holds the card, but does not reopen it', async () => {
  reset();
  writeCard('ci-inherited-card');
  const { dir, shas } = repo();
  const at = Date.now();
  ciWatch.register({ repo: dir, sha: shas[2], branch: 'main', card: 'ci-inherited-card', sessionId: 'sess-push', now: at });
  const table = {
    [shas[1]]: status(['ci/circleci: build', 'success'], ['Tests', 'failure']),
    [shas[2]]: status(['ci/circleci: build', 'success'], ['Tests', 'failure']),
  };
  const sent = [];
  await ciWatch.tick({ now: at + 60e3, fetch: fakeFetch(table), deliver: async (ids, text) => { sent.push(text); return { sessionId: ids[0] }; } });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /already red before your push/);
  assert.match(sent[0], /already red before the push: Tests KEEP_INPUT>>>/);
  assert.match(ciWatch.blockingFor(dir, [shas[2]]), /CI is red/);
  const card = keep.loadTask('ci-inherited-card');
  assert.equal(card.fm.status, 'landing');
  assert.match(card.body, /already red before this push/);
});

test('a failed check-in is retried before the session is told', async () => {
  reset();
  writeCard('ci-retry-card', 'done');
  const { dir, shas } = repo();
  const at = Date.now();
  ciWatch.register({ repo: dir, sha: shas[2], branch: 'main', card: 'ci-retry-card', sessionId: 'sess-push', now: at });
  const table = {
    [shas[1]]: status(['ci/circleci: test', 'success']),
    [shas[2]]: status(['ci/circleci: test', 'failure']),
  };
  const sent = [];
  const deliver = async (ids, text) => { sent.push(text); return { sessionId: ids[0] }; };
  const busy = () => { throw new Error('registry lock busy'); };
  await ciWatch.tick({ now: at + 60e3, fetch: fakeFetch(table), deliver, checkin: busy });
  assert.equal(sent.length, 0, 'the tell waits for the card note');
  await ciWatch.tick({ now: at + 120e3, fetch: fakeFetch(table), deliver });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Card ci-retry-card is reopened/);
  assert.equal(keep.loadTask('ci-retry-card').fm.status, 'active');
  await ciWatch.tick({ now: at + 180e3, fetch: fakeFetch(table), deliver });
  assert.equal(sent.length, 1);
});

test('a card that joins a red watch is noted, and a rerun after a day still releases it', async () => {
  reset();
  writeCard('ci-late-card', 'done');
  const { dir, shas } = repo();
  const at = Date.now();
  ciWatch.register({ repo: dir, sha: shas[2], branch: 'main', sessionId: 'sess-push', now: at });
  const table = {
    [shas[1]]: status(['ci/circleci: test', 'success']),
    [shas[2]]: status(['ci/circleci: test', 'failure']),
  };
  const deliver = async (ids) => ({ sessionId: ids[0] });
  await ciWatch.tick({ now: at + 60e3, fetch: fakeFetch(table), deliver });
  ciWatch.register({ repo: dir, sha: shas[2], branch: 'main', card: 'ci-late-card', now: at + 90e3 });
  await ciWatch.tick({ now: at + 120e3, fetch: fakeFetch(table), deliver });
  assert.equal(keep.loadTask('ci-late-card').fm.status, 'active');

  const late = at + 25 * 3600e3;
  table[shas[2]] = status(['ci/circleci: test', 'success']);
  await ciWatch.tick({ now: late, fetch: fakeFetch(table), deliver });
  assert.equal(ciWatch.blockingFor(dir, [shas[2]]), null);
});

test('a pass out of budget stops starting lookups and saves what it read', async () => {
  reset();
  const { dir, shas } = repo();
  const at = Date.now();
  ciWatch.register({ repo: dir, sha: shas[1], branch: 'main', now: at });
  ciWatch.register({ repo: dir, sha: shas[2], branch: 'main', now: at });
  let tick = 0;
  const result = await ciWatch.tick({
    now: at + 60e3, budgetMs: 5, clock: () => (tick++ ? 1000 : 0),
    fetch: fakeFetch({ [shas[1]]: status(['a', 'success']), [shas[2]]: status(['a', 'success']) }),
  });
  assert.equal(result.lookups, 0);
});

test('a second pass while one runs is skipped, and a dead pass\'s lock is taken over', async () => {
  reset();
  const lock = path.join(ROOT, '.keep', 'ci-watch', 'pass.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '1');
  const now = Date.now();
  assert.equal((await ciWatch.tick({ now, fetch: fakeFetch({}) })).skipped, 'another pass is running');
  assert.equal((await ciWatch.tick({ now: now + 7 * 60e3, fetch: fakeFetch({}) })).skipped, undefined);
  assert.equal(fs.existsSync(lock), false);
});

test('a note already on the card is not written again', async () => {
  reset();
  writeCard('ci-once-card', 'done');
  const { dir, shas } = repo();
  const at = Date.now();
  ciWatch.register({ repo: dir, sha: shas[2], branch: 'main', card: 'ci-once-card', now: at });
  const table = {
    [shas[1]]: status(['ci/circleci: test', 'success']),
    [shas[2]]: status(['ci/circleci: test', 'failure']),
  };
  // The check-in lands, and then the pass dies before it records that.
  let calls = 0;
  const checkin = (id, options) => { calls += 1; keep.checkinTask(id, options); throw new Error('killed'); };
  await ciWatch.tick({ now: at + 60e3, fetch: fakeFetch(table), checkin });
  await ciWatch.tick({ now: at + 120e3, fetch: fakeFetch(table) });
  assert.equal(calls, 1);
  const body = keep.loadTask('ci-once-card').body;
  assert.equal(body.split('ci (daemon)').length - 1, 1);
  const note = ciWatch.loadWatches()[`${SLUG}@${shas[2]}`].outbox.find((item) => item.type === 'note');
  assert.ok(note.doneAt && note.reopened);
});

test('an intermediate commit is judged by the build of the push that carried it', async () => {
  reset();
  const { dir, shas } = repo({ count: 4 });
  const at = Date.now();
  ciWatch.register({ repo: dir, sha: shas[1], branch: 'main', now: at });
  const table = { [shas[3]]: status(['ci/circleci: test', 'success']) };
  await ciWatch.tick({ now: at + 60e3, fetch: fakeFetch(table) });
  assert.match(ciWatch.blockingFor(dir, [shas[1]]), /waiting on CI/, 'too early to look for a covering build');
  await ciWatch.tick({ now: at + ciWatch.COVER_AFTER_MS + 60e3, fetch: fakeFetch(table) });
  const [watch] = Object.values(ciWatch.loadWatches());
  assert.equal(watch.covering, shas[3]);
  assert.equal(watch.state, 'green');
});

test('no status at all resolves as none after the grace period', async () => {
  reset();
  const { dir, shas } = repo();
  const at = Date.now();
  ciWatch.register({ repo: dir, sha: shas[2], branch: 'main', now: at });
  await ciWatch.tick({ now: at + ciWatch.NO_STATUS_GRACE_MS + 60e3, fetch: fakeFetch({}) });
  assert.equal(Object.values(ciWatch.loadWatches())[0].state, 'none');
  assert.equal(ciWatch.blockingFor(dir, [shas[2]]), null);
});

test('CI running past the stuck limit is told once', async () => {
  reset();
  const { dir, shas } = repo();
  const at = Date.now();
  ciWatch.register({ repo: dir, sha: shas[2], branch: 'main', sessionId: 'sess-push', now: at });
  const table = { [shas[2]]: status(['ci/circleci: test', 'pending']) };
  const sent = [];
  const deliver = async (ids, text) => { sent.push(text); return { sessionId: ids[0] }; };
  await ciWatch.tick({ now: at + ciWatch.STUCK_MS + 60e3, fetch: fakeFetch(table), deliver });
  await ciWatch.tick({ now: at + ciWatch.STUCK_MS + 120e3, fetch: fakeFetch(table), deliver });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^\[keep\] ci stuck/);
});

test('a delivery nobody takes is retried, then given up', async () => {
  reset();
  const { dir, shas } = repo();
  const at = Date.now();
  ciWatch.register({ repo: dir, sha: shas[2], branch: 'main', sessionId: 'sess-push', now: at });
  const table = {
    [shas[1]]: status(['ci/circleci: test', 'success']),
    [shas[2]]: status(['ci/circleci: test', 'failure']),
  };
  let calls = 0;
  const busy = async () => { calls += 1; return null; };
  await ciWatch.tick({ now: at + 60e3, fetch: fakeFetch(table), deliver: busy });
  await ciWatch.tick({ now: at + 120e3, fetch: fakeFetch(table), deliver: busy });
  assert.equal(calls, 2);
  await ciWatch.tick({ now: at + ciWatch.DELIVER_GIVE_UP_MS + 120e3, fetch: fakeFetch(table), deliver: busy });
  const [watch] = Object.values(ciWatch.loadWatches());
  assert.equal(watch.outbox.find((item) => item.type === 'tell').gaveUp, 'no session took it');
  const after = calls;
  await ciWatch.tick({ now: at + ciWatch.DELIVER_GIVE_UP_MS + 180e3, fetch: fakeFetch(table), deliver: busy });
  assert.equal(calls, after);
});

test('headCheck reports a red head and fails open on a lookup error', () => {
  reset();
  const { dir, shas } = repo();
  const red = ciWatch.headCheck(dir, shas[2], {
    run: (args) => (/status/.test(args[1]) ? status(['ci/circleci: test', 'failure']) : { check_runs: [] }),
  });
  assert.equal(red.verdict, 'failed');
  assert.equal(red.failed[0].name, 'ci/circleci: test');
  assert.equal(ciWatch.headCheck(dir, shas[2], { run: () => { throw new Error('gh: not logged in'); } }), null);
});
