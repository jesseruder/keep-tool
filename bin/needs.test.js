'use strict';

for (const key of Object.keys(process.env)) {
  if (key.startsWith('KEEP_REVIEWER')) delete process.env[key];
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const keep = require('./keep.js');
const { buildBrief } = require('./alerts.js');

const CLI = path.join(__dirname, 'keep.js');

function registry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-needs-'));
  const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' };
  for (const key of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'E2E_CASTLE_TOKEN', 'POLLEN_KEY']) delete env[key];
  for (const directory of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  const git = (args) => spawnSync('git', args, { encoding: 'utf8', env });
  assert.equal(git(['init', '-q', '--initial-branch=main', root]).status, 0);
  git(['-C', root, 'config', 'user.name', 'Keep Test']);
  git(['-C', root, 'config', 'user.email', 'keep@example.test']);
  fs.writeFileSync(path.join(root, 'tasks', 'gate.md'), [
    '---', 'title: cAdvisor staging gate', 'status: active', 'kind: task', 'tags: [castle]',
    'project: ~/castle/castle-sandboxes', 'created: 2026-09-03', 'updated: 2026-09-03T09:00', '---', '',
    '## 2026-09-03 09:00 — check-in', 'Staging gate needs the E2E token.', '',
  ].join('\n'));
  const run = (args, extraEnv = {}, input) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', env: { ...env, ...extraEnv }, cwd: root, input,
  });
  const card = () => keep.parseTask(fs.readFileSync(path.join(root, 'tasks', 'gate.md'), 'utf8'), 'gate');
  return { root, run, card, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('needs round-trips through the card frontmatter', () => {
  const task = { id: 'x', fm: { title: 'x', status: 'blocked', needs: [{ text: 'Google Play sign-in: approve the release', at: '2026-09-04T10:00', was: 'active' }, { text: 'token', env: 'E2E_CASTLE_TOKEN', at: '2026-09-04T10:01' }] }, body: '' };
  const again = keep.parseTask(keep.serializeTask(task), 'x');
  assert.deepEqual(again.fm.needs, task.fm.needs);
});

test('keep needs is read-only and only the linked owning session can auto-clear an env need', () => {
  const { run, card, cleanup, root } = registry();
  try {
    assert.equal(run(['link', 'gate', '--session', 'owner-session', '--agent', 'claude']).status, 0);
    const add = run(['needs', 'gate', 'E2E_CASTLE_TOKEN for the staging gate', '--env', 'E2E_CASTLE_TOKEN']);
    assert.equal(add.status, 0, add.stderr);
    assert.match(add.stdout, /gate → blocked, waiting on Owner: E2E_CASTLE_TOKEN for the staging gate \(clears when E2E_CASTLE_TOKEN is set in a linked owning session/);
    let now = card();
    assert.equal(now.fm.status, 'blocked');
    assert.deepEqual(now.fm.needs.map((need) => ({ text: need.text, env: need.env, was: need.was })),
      [{ text: 'E2E_CASTLE_TOKEN for the staging gate', env: 'E2E_CASTLE_TOKEN', was: 'active' }]);
    assert.match(now.body, /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} — needs Owner → blocked\nNeeds from Owner: E2E_CASTLE_TOKEN for the staging gate \(clears when E2E_CASTLE_TOKEN is set in a linked owning session\)/m);

    const dupe = run(['needs', 'gate', 'the same token again', '--env', 'E2E_CASTLE_TOKEN']);
    assert.equal(dupe.status, 1);
    assert.match(dupe.stderr, /already records that need \(env E2E_CASTLE_TOKEN\)/);

    const beforeBytes = fs.readFileSync(path.join(root, 'tasks', 'gate.md'), 'utf8');
    const beforeHead = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const beforeStatus = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;
    const list = run(['needs'], { E2E_CASTLE_TOKEN: 'present-in-anonymous-shell' });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /^Waiting on Owner \(1\):\n  gate  \d{4}-\d{2}-\d{2} \d{2}:\d{2}  E2E_CASTLE_TOKEN for the staging gate  \[env E2E_CASTLE_TOKEN\]$/m);
    assert.equal(fs.readFileSync(path.join(root, 'tasks', 'gate.md'), 'utf8'), beforeBytes);
    assert.equal(spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), beforeHead);
    assert.equal(spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, beforeStatus);

    const unrelated = run(['hook', 'session-start'], { E2E_CASTLE_TOKEN: 'secret' },
      JSON.stringify({ session_id: 'unrelated-session', cwd: os.homedir() + '/castle/castle-sandboxes' }));
    assert.equal(unrelated.status, 0, unrelated.stderr);
    assert.doesNotMatch(unrelated.stdout, /Need cleared:/);
    assert.equal(card().fm.status, 'blocked');

    const anonymousHook = run(['hook', 'session-start'], { E2E_CASTLE_TOKEN: 'secret' },
      JSON.stringify({ cwd: os.homedir() + '/castle/castle-sandboxes' }));
    assert.equal(anonymousHook.status, 0, anonymousHook.stderr);
    assert.doesNotMatch(anonymousHook.stdout, /Need cleared:/);
    assert.equal(card().fm.status, 'blocked');

    // The env var appears in the card's owning session, so the need clears.
    const hook = run(['hook', 'session-start'], { E2E_CASTLE_TOKEN: 'secret' }, JSON.stringify({ session_id: 'owner-session', cwd: os.homedir() + '/castle/castle-sandboxes' }));
    assert.equal(hook.status, 0, hook.stderr);
    assert.match(hook.stdout, /Need cleared: E2E_CASTLE_TOKEN is set in this session, so gate is active again/);
    now = card();
    assert.equal(now.fm.status, 'active');
    assert.equal(now.fm.needs, undefined);
    assert.match(now.body, /— needs met → active\nMet: E2E_CASTLE_TOKEN for the staging gate \(env E2E_CASTLE_TOKEN\)\nE2E_CASTLE_TOKEN is set in claude session owner-se\./);
    assert.doesNotMatch(now.body, /secret/);
    assert.match(run(['needs']).stdout, /^nothing waiting on Owner$/m);
  } finally { cleanup(); }
});

test('keep needs --met clears a hand-supplied need and the hook lists open needs for the project', () => {
  const { run, card, cleanup } = registry();
  try {
    assert.equal(run(['needs', 'gate', 'Google Play Console sign-in to approve the release']).status, 0);
    assert.equal(run(['needs', 'gate', 'Pollen API key', '--env', 'POLLEN_KEY']).status, 0);
    assert.equal(card().fm.needs.length, 2);
    const hook = run(['hook', 'session-start'], {}, JSON.stringify({ session_id: 'sess-2', cwd: os.homedir() + '/castle/castle-sandboxes' }));
    assert.match(hook.stdout, /Waiting on Owner \(do not work around these; he supplies them\):\n- gate: Google Play Console sign-in to approve the release\n- gate: Pollen API key \[env POLLEN_KEY\]/);

    const one = run(['needs', 'gate', '--met', '--env', 'POLLEN_KEY']);
    assert.equal(one.status, 0, one.stderr);
    assert.match(one.stdout, /^gate: 1 need met$/m);
    assert.equal(card().fm.status, 'blocked', 'one need still open keeps the card blocked');
    const missing = run(['needs', 'gate', '--met', '--env', 'POLLEN_KEY']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /has no open need for env POLLEN_KEY/);
    const rest = run(['needs', 'gate', '--met']);
    assert.equal(rest.status, 0, rest.stderr);
    assert.match(rest.stdout, /^gate: 1 need met — status back to active$/m);
    assert.equal(card().fm.status, 'active');
    assert.match(card().body, /Marked met by hand\./);
  } finally { cleanup(); }
});

test('clearing needs in any order restores the original status, including dependency-waiting', () => {
  const { run, card, cleanup, root } = registry();
  try {
    // a review card: the first need carries was=review; clearing it first must not lose that
    fs.writeFileSync(path.join(root, 'tasks', 'gate.md'), fs.readFileSync(path.join(root, 'tasks', 'gate.md'), 'utf8').replace('status: active', 'status: review'));
    assert.equal(run(['needs', 'gate', 'Stripe live webhook secret', '--env', 'STRIPE_WEBHOOK']).status, 0);
    assert.equal(run(['needs', 'gate', 'Play Console approval']).status, 0);
    assert.equal(run(['needs', 'gate', '--met', '--env', 'STRIPE_WEBHOOK']).status, 0);
    assert.equal(card().fm.needs[0].was, 'review', 'was travels to the remaining need');
    const last = run(['needs', 'gate', '--met']);
    assert.match(last.stdout, /status back to review/);
    assert.equal(card().fm.status, 'review');

    // waiting on an unresolved dependency, no check_after: restored to waiting, not active
    fs.writeFileSync(path.join(root, 'tasks', 'upstream.md'), '---\ntitle: upstream\nstatus: active\ntags: [personal]\ncreated: 2026-09-03\nupdated: 2026-09-03T09:00\n---\n');
    fs.writeFileSync(path.join(root, 'tasks', 'gate.md'), fs.readFileSync(path.join(root, 'tasks', 'gate.md'), 'utf8').replace('status: review', 'status: waiting\ndepends_on: [upstream]'));
    assert.equal(run(['needs', 'gate', 'Pollen key', '--env', 'POLLEN_KEY']).status, 0);
    assert.equal(card().fm.status, 'blocked');
    assert.equal(run(['needs', 'gate', '--met']).status, 0);
    assert.equal(card().fm.status, 'waiting');
  } finally { cleanup(); }
});

test('a session-start sweep clears the owning card needs under one commit and leaves unrelated cards blocked', () => {
  const { run, card, cleanup, root } = registry();
  try {
    fs.writeFileSync(path.join(root, 'tasks', 'other.md'), '---\ntitle: other\nstatus: active\ntags: [personal]\nproject: ~/castle/castle-sandboxes\ncreated: 2026-09-03\nupdated: 2026-09-03T09:00\n---\n');
    assert.equal(run(['link', 'gate', '--session', 'sess-3', '--agent', 'claude']).status, 0);
    assert.equal(run(['needs', 'gate', 'E2E token', '--env', 'E2E_CASTLE_TOKEN']).status, 0);
    assert.equal(run(['needs', 'gate', 'Pollen key for gate', '--env', 'POLLEN_KEY']).status, 0);
    assert.equal(run(['needs', 'other', 'Pollen key', '--env', 'POLLEN_KEY']).status, 0);
    const before = spawnSync('git', ['-C', root, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const hook = run(['hook', 'session-start'], { E2E_CASTLE_TOKEN: 'a', POLLEN_KEY: 'b' }, JSON.stringify({ session_id: 'sess-3', cwd: os.homedir() + '/castle/castle-sandboxes' }));
    assert.equal(hook.status, 0, hook.stderr);
    const after = spawnSync('git', ['-C', root, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(Number(after) - Number(before), 1, 'one commit for the whole sweep');
    assert.match(hook.stdout, /Need cleared: E2E_CASTLE_TOKEN is set in this session, so gate is still blocked/);
    assert.match(hook.stdout, /Need cleared: POLLEN_KEY is set in this session, so gate is active again/);
    assert.doesNotMatch(hook.stdout, /Need cleared: POLLEN_KEY is set in this session, so other/);
    assert.match(hook.stdout, /- gate \(active\):/, 'the project list reflects the restored status');
    assert.match(hook.stdout, /Waiting on Owner[\s\S]*- other: Pollen key/);
    assert.equal(card().fm.status, 'active');
    const other = keep.parseTask(fs.readFileSync(path.join(root, 'tasks', 'other.md'), 'utf8'), 'other');
    assert.equal(other.fm.status, 'blocked');
    assert.equal(other.fm.needs.length, 1);
  } finally { cleanup(); }
});

test('the brief carries open needs as one waiting-on-you block', () => {
  const tasks = [
    { id: 'gate', fm: { title: 'gate', status: 'blocked', needs: [{ text: 'E2E_CASTLE_TOKEN for the staging gate', env: 'E2E_CASTLE_TOKEN', at: '2026-09-04T10:00' }] } },
    { id: 'pollen', fm: { title: 'pollen', status: 'blocked', needs: [{ text: 'Google Pollen API key', at: '2026-09-04T09:00' }] } },
    { id: 'old', fm: { title: 'old', status: 'done', needs: [{ text: 'gone', at: '2026-09-01T09:00' }] } },
  ];
  const brief = buildBrief({ tasks, now: Date.parse('2026-09-04T12:00:00') });
  assert.match(brief.text, /2 needs from you/);
  assert.match(brief.text, /Waiting on you \(2\)\n- pollen — Google Pollen API key\n- gate — E2E_CASTLE_TOKEN for the staging gate \[env E2E_CASTLE_TOKEN\]/);
  assert.match(brief.spoken, /Waiting on you: Google Pollen API key/);
});

// ---------- status discipline: review, blocked and waiting must name their trigger ----------

function statusFixture() {
  const f = registry();
  assert.equal(f.run(['add', 'Status card', '--status', 'active', '--tag', 'personal', '-m', 'Started.']).status, 0);
  f.read = () => fs.readFileSync(path.join(f.root, 'tasks', 'status-card.md'), 'utf8');
  return f;
}

test('a review check-in that reads as waiting on other work is refused', () => {
  const f = statusFixture();
  try {
    const refused = f.run(['checkin', 'status-card', '--status', 'review',
      '-m', 'Fix is ready. Await the in-progress cAdvisor production host rollout.']);
    assert.equal(refused.status, 2, refused.stdout);
    assert.match(refused.stderr, /`review` means waiting on Owner/);
    assert.match(refused.stderr, /keep wait-on/);
    assert.match(f.read(), /^status: active$/m);

    const allowed = f.run(['checkin', 'status-card', '--status', 'review', '-m', 'Ready, awaiting your review.']);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(f.read(), /^status: review$/m);
  } finally { f.cleanup(); }
});

test('--force lands a review check-in the prose guard would refuse', () => {
  const f = statusFixture();
  try {
    const forced = f.run(['checkin', 'status-card', '--status', 'review', '--force',
      '-m', 'Awaiting the rollout, and I know what I am doing.']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(f.read(), /^status: review$/m);
  } finally { f.cleanup(); }
});

test('blocked needs a named blocker', () => {
  const f = statusFixture();
  try {
    const refused = f.run(['checkin', 'status-card', '--status', 'blocked', '-m', 'stuck']);
    assert.equal(refused.status, 2, refused.stdout);
    assert.match(refused.stderr, /blocked needs a named blocker/);

    assert.equal(f.run(['needs', 'status-card', 'an API key']).status, 0);
    assert.match(f.read(), /^status: blocked$/m);
    const again = f.run(['checkin', 'status-card', '--status', 'blocked', '-m', 'still stuck']);
    assert.equal(again.status, 0, again.stderr);
  } finally { f.cleanup(); }
});

test('waiting accepts an open need as its trigger', () => {
  const f = statusFixture();
  try {
    assert.equal(f.run(['needs', 'status-card', 'a sign-in']).status, 0);
    const waiting = f.run(['checkin', 'status-card', '--status', 'waiting', '-m', 'parked on the sign-in']);
    assert.equal(waiting.status, 0, waiting.stderr);
    assert.match(f.read(), /^status: waiting$/m);
  } finally { f.cleanup(); }
});

test('waiting with no trigger at all is still refused', () => {
  const f = statusFixture();
  try {
    const refused = f.run(['checkin', 'status-card', '--status', 'waiting', '-m', 'later']);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /waiting needs --check-after/);
  } finally { f.cleanup(); }
});

// ---------- landing: the status that keeps a merge out of Owner's queue ----------

test('landing requires a cited commit', () => {
  const f = statusFixture();
  try {
    const refused = f.run(['checkin', 'status-card', '--status', 'landing', '-m', 'done, just needs to land']);
    assert.equal(refused.status, 2, refused.stdout);
    assert.match(refused.stderr, /cites no commit/);
    assert.match(f.read(), /^status: active$/m);

    const ok = f.run(['checkin', 'status-card', '--status', 'landing', '--commit', 'abc1234', '-m', 'only the land is left']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(f.read(), /^status: landing$/m);
  } finally { f.cleanup(); }
});

test('a card already citing a commit can move to landing without repeating it', () => {
  const f = statusFixture();
  try {
    assert.equal(f.run(['checkin', 'status-card', '--commit', 'abc1234', '-m', 'work done']).status, 0);
    const ok = f.run(['checkin', 'status-card', '--status', 'landing', '-m', 'only the land is left']);
    assert.equal(ok.status, 0, ok.stderr);
  } finally { f.cleanup(); }
});

// ---------- Codex review 2026-09-07 ----------

test('the review-prose guard reads "pending" as a wait only when it has an object', () => {
  const f = statusFixture();
  try {
    // A false positive that blocked ordinary prose.
    const ok = f.run(['checkin', 'status-card', '--status', 'review',
      '-m', 'Implemented support for pending invoices; screenshots attached.']);
    assert.equal(ok.status, 0, ok.stderr);
  } finally { f.cleanup(); }
});

test('a wait on machinery phrased with "your" is still refused', () => {
  const f = statusFixture();
  try {
    // A bare `your` in the allowed objects let this pass as a wait on Owner.
    const refused = f.run(['checkin', 'status-card', '--status', 'review',
      '-m', 'All done, waiting for your deployment to finish.']);
    assert.equal(refused.status, 2, refused.stdout);
    assert.match(refused.stderr, /`review` means waiting on Owner/);
  } finally { f.cleanup(); }
});

test('the ordinary ways of saying "Owner should look" all still pass', () => {
  for (const message of [
    'Ready, awaiting your review.',
    "Done; awaiting Owner's approval.",
    'Finished — waiting on Owner.',
    'Pending your decision on the ratio.',
    'All green, awaiting your sign-off.',
  ]) {
    const f = statusFixture();
    try {
      const out = f.run(['checkin', 'status-card', '--status', 'review', '-m', message]);
      assert.equal(out.status, 0, `${message}: ${out.stderr}`);
    } finally { f.cleanup(); }
  }
});

test('wait-on moves a landing card to waiting like any other', () => {
  const f = statusFixture();
  try {
    assert.equal(f.run(['add', 'Upstream card', '--status', 'active', '--tag', 'personal', '-m', 'x']).status, 0);
    assert.equal(f.run(['checkin', 'status-card', '--status', 'landing', '--commit', 'abc1234', '-m', 'only the land']).status, 0);
    const out = f.run(['wait-on', 'status-card', 'upstream-card', '-m', 'need upstream']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(f.read(), /^status: waiting$/m);
  } finally { f.cleanup(); }
});
