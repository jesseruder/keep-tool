'use strict';
// keep reviewed / keep reviews / keep allow <card> land, end to end against a real
// git worktree. Everything runs inside temp directories: a bare "origin", a main
// checkout, and a linked `wt/` worktree, so the land conditions are the real ones.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, 'keep.js');

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-reviews-')));
  const root = path.join(base, 'keep');
  const origin = path.join(base, 'origin.git');
  const main = path.join(base, 'main');
  const tree = path.join(base, 'wt');
  for (const dir of ['tasks', 'archive', 'digests', 'reviews', 'watch']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', ['init', '-q', '--bare', '--initial-branch=master', origin]);
  spawnSync('git', ['init', '-q', '--initial-branch=master', main]);
  for (const cwd of [root, main]) {
    git(cwd, ['config', 'user.name', 'Test']);
    git(cwd, ['config', 'user.email', 'test@example.test']);
  }
  fs.writeFileSync(path.join(main, 'README.md'), 'base\n');
  git(main, ['add', '.']);
  git(main, ['commit', '-qm', 'base']);
  git(main, ['remote', 'add', 'origin', origin]);
  git(main, ['push', '-q', 'origin', 'master']);
  git(main, ['worktree', 'add', '-q', '-b', 'wt/test', tree, 'master']);
  // wt land refuses a tree without .wt.json, so keep allow land requires one too.
  fs.writeFileSync(path.join(tree, '.wt.json'), JSON.stringify({ repo: 'fixture', name: 'test' }));

  // A registered Codex account namespace with one completed and one running job, so
  // --job resolves the way it does against a real jobs directory.
  const companion = require('./codex-companion-account.js');
  const configDir = path.join(base, 'codex-config');
  fs.mkdirSync(configDir, { recursive: true });
  const namespace = companion.namespaceFor({ id: 'codex-fixture', agent: 'codex', configDir, builtIn: false, managed: true }, { root });
  companion.ensureNamespace(namespace, {});
  const jobsDir = path.join(companion.workspaceStateDir(tree, namespace.stateRoot), 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  const writeJob = (id, status) => fs.writeFileSync(path.join(jobsDir, `${id}.json`),
    JSON.stringify({ id, status, workspaceRoot: tree, result: { status: 0 } }));
  writeJob('task-done-1', 'completed');
  writeJob('task-running-1', 'running');

  const env = {
    ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1', KEEP_ALLOW_PUSH: '0',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test',
  };
  delete env.KEEP_REVIEWER; delete env.KEEP_REVIEWER_NAME; delete env.KEEP_CONFIG;
  delete env.CLAUDE_CODE_SESSION_ID; delete env.CODEX_SESSION_ID; delete env.CODEX_THREAD_ID;
  delete env.KEEP_OWNER;

  const run = (args, extra = {}, cwd = tree) => spawnSync(process.execPath, [CLI, ...args], {
    cwd, env: { ...env, ...extra }, encoding: 'utf8',
  });
  const ok = (args, extra, cwd) => { const r = run(args, extra, cwd); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const commit = (text) => {
    fs.appendFileSync(path.join(tree, 'work.txt'), `${text}\n`);
    git(tree, ['add', 'work.txt']);
    git(tree, ['commit', '-qm', text]);
    return git(tree, ['rev-parse', 'HEAD']);
  };
  const card = () => require('./keep.js').parseTask(fs.readFileSync(path.join(root, 'tasks', 'work.md'), 'utf8'), 'work');
  return { base, root, origin, main, tree, jobsDir, env, run, ok, commit, card,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('keep reviewed records the patches, logs a code-review entry, and keep reviews lists it', () => {
  const f = fixture();
  try {
    f.ok(['add', 'Work', '--status', 'active', '--project', f.tree, '-m', 'Started.'], {}, f.root);
    const sha = f.commit('one');

    const bad = f.run(['reviewed', 'work', '--commit', 'deadbee', '--verdict', 'clean']);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /does not know the commit/);

    const badBy = f.run(['reviewed', 'work', '--commit', sha, '--verdict', 'clean', '--by', 'nobody']);
    assert.notEqual(badBy.status, 0);
    assert.match(badBy.stderr, /must start with one of codex, opus, claude, human/);

    const badVerdict = f.run(['reviewed', 'work', '--commit', sha, '--verdict', 'maybe']);
    assert.notEqual(badVerdict.status, 0);
    assert.match(badVerdict.stderr, /--verdict must be one of clean, findings/);

    const out = f.ok(['reviewed', 'work', '--commit', sha, '--verdict', 'clean', '--by', 'codex sol',
      '--job', 'task-done-1', '--evidence', 'codex review task-done-1: no findings', '-m', 'Read the whole delta.']);
    assert.match(out, /recorded clean review rev-/);

    const records = JSON.parse(f.ok(['reviews', 'work', '--json'])).records;
    assert.equal(records.length, 1);
    assert.equal(records[0].verdict, 'clean');
    assert.equal(records[0].by, 'codex sol');
    assert.equal(records[0].job, 'task-done-1');
    assert.equal(records[0].jobAccountId, 'codex-fixture', 'the account whose jobs directory answered');
    assert.match(records[0].jobAt, /^\d{4}-\d\d-\d\dT/, 'the job result file mtime');
    assert.equal(records[0].commits[0].sha, sha);
    assert.equal(records[0].commits[0].subject, 'one');
    assert.equal(typeof records[0].commits[0].patchId, 'string');
    assert.notEqual(records[0].commits[0].patchId, '', 'an ordinary commit has a patch-id');

    // The heading may not start with the bare word `review`: bin/review.js swallows those.
    const body = f.card().body;
    assert.match(body, /— code-review\b/);
    assert.equal(/^## .* — review\b/m.test(body), false);
    assert.match(body, /record: rev-/);

    // A range spells the same thing.
    const second = f.commit('two');
    f.ok(['reviewed', 'work', '--commit', `${sha}..HEAD`, '--verdict', 'findings', '--job', 'task-done-1']);
    const after = JSON.parse(f.ok(['reviews', 'work', '--json'])).records;
    assert.equal(after.length, 2);
    assert.deepEqual(after[1].commits.map((c) => c.sha), [second]);
  } finally { f.cleanup(); }
});

test('keep allow <card> land answers from the review records, and names the condition that failed', () => {
  const f = fixture();
  try {
    f.ok(['add', 'Work', '--status', 'active', '--project', f.tree, '-m', 'Started.'], {}, f.root);
    const sha = f.commit('one');

    const unreviewed = f.run(['allow', 'work', 'land']);
    assert.equal(unreviewed.status, 3);
    assert.match(unreviewed.stdout, /has no review record/);

    f.ok(['reviewed', 'work', '--commit', sha, '--verdict', 'clean', '--by', 'codex sol', '--job', 'task-done-1']);
    const allowed = f.run(['allow', 'work', 'land']);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /allowed: reviewed clean: 1 commit\(s\) by codex sol/);
    const json = JSON.parse(f.run(['allow', 'work', 'land', '--json']).stdout);
    assert.equal(json.ok, true);
    assert.equal(json.implicit, true);
    assert.equal(json.record.job, 'task-done-1');

    // A new commit nobody reviewed takes the grant away again.
    const second = f.commit('two');
    const stale = f.run(['allow', 'work', 'land']);
    assert.equal(stale.status, 3);
    assert.match(stale.stdout, /has no review record/);
    f.ok(['reviewed', 'work', '--commit', second, '--verdict', 'clean', '--by', 'codex sol', '--job', 'task-done-1']);
    assert.equal(f.run(['allow', 'work', 'land']).status, 0);

    // A dirty tree is refused by name.
    fs.writeFileSync(path.join(f.tree, 'scratch.txt'), 'uncommitted\n');
    const dirty = f.run(['allow', 'work', 'land']);
    assert.equal(dirty.status, 3);
    assert.match(dirty.stdout, /uncommitted change\(s\)/);
    fs.unlinkSync(path.join(f.tree, 'scratch.txt'));

    // The registry-wide opt-out, and then the card's own.
    fs.writeFileSync(path.join(f.root, 'watch', 'autoland.json'), JSON.stringify({ enabled: true, optOut: ['work'] }));
    const optedOut = f.run(['allow', 'work', 'land']);
    assert.equal(optedOut.status, 3);
    assert.match(optedOut.stdout, /watch\/autoland\.json lists work in optOut/);
    fs.writeFileSync(path.join(f.root, 'watch', 'autoland.json'), JSON.stringify({ enabled: false }));
    assert.match(f.run(['allow', 'work', 'land']).stdout, /enabled: false/);
    fs.rmSync(path.join(f.root, 'watch', 'autoland.json'));

    const file = path.join(f.root, 'tasks', 'work.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^status: .*$/m, '$&\nauto_land: off'));
    const cardOff = f.run(['allow', 'work', 'land']);
    assert.equal(cardOff.status, 3);
    assert.match(cardOff.stdout, /sets auto_land: off/);
    // `auto_land` has to survive a rewrite of the card, which only strings do.
    f.ok(['checkin', 'work', '-m', 'Still off.'], {}, f.root);
    assert.equal(f.card().fm.auto_land, 'off');

    // Outside a wt/ worktree there is no implicit grant at all.
    const fromMain = f.run(['allow', 'work', 'land'], {}, f.main);
    assert.equal(fromMain.status, 3);
    assert.match(fromMain.stdout, /not a linked worktree|auto_land/);
  } finally { f.cleanup(); }
});

test('keep land refuses without the grant and never touches the repository', () => {
  const f = fixture();
  try {
    f.ok(['add', 'Work', '--status', 'active', '--project', f.tree, '-m', 'Started.'], {}, f.root);
    const sha = f.commit('one');
    const before = git(f.origin, ['rev-parse', 'master']);
    const refused = f.run(['land', 'work']);
    assert.equal(refused.status, 3);
    assert.match(refused.stderr, /not allowed:.*has no review record/);
    assert.equal(git(f.origin, ['rev-parse', 'master']), before, 'a refusal pushes nothing');

    f.ok(['reviewed', 'work', '--commit', sha, '--verdict', 'clean', '--by', 'human jesse']);
    const dry = f.ok(['land', 'work', '--dry-run']);
    assert.match(dry, /allowed: reviewed clean: 1 commit\(s\) by human jesse/);
    assert.match(dry, /would run wt land in/);
    assert.equal(git(f.origin, ['rev-parse', 'master']), before, '--dry-run pushes nothing');
  } finally { f.cleanup(); }
});

test('only Owner grants: --grant and --until are refused inside an agent session', () => {
  const f = fixture();
  try {
    f.ok(['add', 'Work', '--status', 'active', '-m', 'Started.'], {}, f.root);
    const asAgent = { CLAUDE_CODE_SESSION_ID: 'self-granting-session' };

    const refused = f.run(['allow', 'work', '--grant', 'push'], asAgent, f.root);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /only Owner grants/);
    assert.deepEqual(f.card().fm.allow, undefined);

    const untilRefused = f.run(['allow', 'work', '--until', '+7d'], asAgent, f.root);
    assert.notEqual(untilRefused.status, 0);
    assert.match(untilRefused.stderr, /only Owner grants/);

    // --as-owner alone is not enough; it needs KEEP_OWNER=1 in the environment.
    const halfWay = f.run(['allow', 'work', '--grant', 'push', '--as-owner'], asAgent, f.root);
    assert.notEqual(halfWay.status, 0);
    assert.match(halfWay.stderr, /only Owner grants/);

    f.ok(['allow', 'work', '--grant', 'push', '--as-owner'], { ...asAgent, KEEP_OWNER: '1' }, f.root);
    assert.deepEqual(f.card().fm.allow, ['push']);

    // Owner's own terminal has no session marker and needs no flag.
    f.ok(['allow', 'work', '--grant', 'deploy:prod'], {}, f.root);
    assert.deepEqual(f.card().fm.allow, ['deploy:prod', 'push']);

    // Taking authority away is always allowed: a session may narrow its own leash.
    f.ok(['allow', 'work', '--revoke', 'push'], asAgent, f.root);
    assert.deepEqual(f.card().fm.allow, ['deploy:prod']);
    f.ok(['allow', 'work', '--clear'], asAgent, f.root);
    assert.equal(f.card().fm.allow, undefined, 'an empty grant list leaves no allow line on the card');

    // Creating a card with grants is granting: the same gate, or the refusal above
    // is one `keep add --allow` away.
    const created = f.run(['add', 'Self granted', '--allow', 'push,land', '-m', 'x'], asAgent, f.root);
    assert.notEqual(created.status, 0);
    assert.match(created.stderr, /only Owner grants/);
    assert.equal(fs.existsSync(path.join(f.root, 'tasks', 'self-granted.md')), false, 'no card is created either');
    const untilOnly = f.run(['add', 'Self dated', '--until', '+7d', '-m', 'x'], asAgent, f.root);
    assert.notEqual(untilOnly.status, 0);
    assert.match(untilOnly.stderr, /only Owner grants/);
    f.ok(['add', 'Owner granted', '--allow', 'push', '--as-owner', '-m', 'x'], { ...asAgent, KEEP_OWNER: '1' }, f.root);
    assert.match(fs.readFileSync(path.join(f.root, 'tasks', 'owner-granted.md'), 'utf8'), /^allow: \[push\]$/m);
    // A card with no grants is still an ordinary thing for an agent to file.
    f.ok(['add', 'Plain card', '-m', 'x'], asAgent, f.root);
  } finally { f.cleanup(); }
});

test('the attestation bar is enforced where the record is written, not only where it is read', () => {
  const f = fixture();
  const asAgent = { CLAUDE_CODE_SESSION_ID: 'reviewing-session' };
  const asCodex = { CODEX_THREAD_ID: 'reviewing-codex' };
  const long = 'read every hunk of the retry path and re-ran bin/delivery.test.js; the double-send is gone';
  try {
    f.ok(['add', 'Work', '--status', 'active', '--project', f.tree, '-m', 'Started.'], {}, f.root);
    const sha = f.commit('one');

    // --by human is Owner's own word and cannot be typed by an agent.
    const impersonated = f.run(['reviewed', 'work', '--commit', sha, '--verdict', 'clean', '--by', 'human jesse'], asAgent);
    assert.notEqual(impersonated.status, 0);
    assert.match(impersonated.stderr, /--by human is Owner's own attestation and cannot be written from an agent session/);

    // A --job has to name a job Keep can find, and one that finished.
    const unknownJob = f.run(['reviewed', 'work', '--commit', sha, '--verdict', 'clean', '--by', 'codex sol', '--job', 'task-nope'], asCodex);
    assert.notEqual(unknownJob.status, 0);
    assert.match(unknownJob.stderr, /is not a Codex job Keep can find/);
    const running = f.run(['reviewed', 'work', '--commit', sha, '--verdict', 'clean', '--by', 'codex sol', '--job', 'task-running-1'], asCodex);
    assert.notEqual(running.status, 0);
    assert.match(running.stderr, /is running, not completed/);

    // A Codex review is its job; prose does not substitute.
    const codexProse = f.run(['reviewed', 'work', '--commit', sha, '--verdict', 'clean', '--by', 'codex sol', '--evidence', long], asCodex);
    assert.notEqual(codexProse.status, 0);
    assert.match(codexProse.stderr, /a Codex review needs --job/);

    // A subagent review has no job file, so evidence carries it — but not "clean".
    const thin = f.run(['reviewed', 'work', '--commit', sha, '--verdict', 'clean', '--by', 'opus', '--evidence', 'clean'], asAgent);
    assert.notEqual(thin.status, 0);
    assert.match(thin.stderr, /--evidence is 5 characters; without a --job at least 80 are required/);
    const bare = f.run(['reviewed', 'work', '--commit', sha, '--verdict', 'clean', '--by', 'opus'], asAgent);
    assert.notEqual(bare.status, 0);
    assert.match(bare.stderr, /self-attestation needs --job or at least 80 characters/);
    assert.equal(require('./reviews.js').readRecords('work', f.root).length, 0, 'nothing refused was written');

    // Findings are never authority, so they are recorded whatever they cite.
    f.ok(['reviewed', 'work', '--commit', sha, '--verdict', 'findings', '-m', 'Two real problems.'], asAgent);
    f.ok(['reviewed', 'work', '--commit', sha, '--verdict', 'clean', '--by', 'opus', '--evidence', long], asAgent);
    const allowed = f.run(['allow', 'work', 'land'], asAgent);
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
  } finally { f.cleanup(); }
});

test('a merge commit in the range blocks the implicit grant, and a missing .wt.json does too', () => {
  const f = fixture();
  try {
    f.ok(['add', 'Work', '--status', 'active', '--project', f.tree, '-m', 'Started.'], {}, f.root);
    const sha = f.commit('one');
    f.ok(['reviewed', 'work', '--commit', sha, '--verdict', 'clean', '--by', 'codex sol', '--job', 'task-done-1']);
    assert.equal(f.run(['allow', 'work', 'land']).status, 0);

    // wt land refuses a tree with no .wt.json; the grant must agree.
    fs.renameSync(path.join(f.tree, '.wt.json'), path.join(f.tree, '.wt.json.off'));
    const unmanaged = f.run(['allow', 'work', 'land']);
    assert.equal(unmanaged.status, 3);
    assert.match(unmanaged.stdout, /not a wt-managed tree \(no \.wt\.json\), which wt land refuses too/);
    fs.renameSync(path.join(f.tree, '.wt.json.off'), path.join(f.tree, '.wt.json'));

    // A merge's conflict resolution is content no review of either side saw.
    git(f.tree, ['checkout', '-q', '-b', 'side', 'master']);
    fs.writeFileSync(path.join(f.tree, 'side.txt'), 'side\n');
    git(f.tree, ['add', 'side.txt']);
    git(f.tree, ['commit', '-qm', 'side']);
    git(f.tree, ['checkout', '-q', 'wt/test']);
    git(f.tree, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);
    // The range now includes the merge and the side commit, both reviewed...
    f.ok(['reviewed', 'work', '--commit', 'origin/master..HEAD', '--verdict', 'clean', '--by', 'codex sol', '--job', 'task-done-1']);
    const merged = f.run(['allow', 'work', 'land']);
    assert.equal(merged.status, 3, merged.stdout);
    assert.match(merged.stdout, /is a merge commit, whose conflict resolution is content no review of the branch saw/);
    assert.match(merged.stdout, /rebase onto origin\/master/);
    // ...and the merge itself is in the record, not silently skipped by --no-merges.
    const records = require('./reviews.js').readRecords('work', f.root);
    assert.equal(records.at(-1).commits.some((commit) => commit.merge === true), true);
  } finally { f.cleanup(); }
});

test('keep land refuses a granted card whose worktree cannot land, instead of landing undefined', () => {
  const f = fixture();
  try {
    f.ok(['add', 'Work', '--status', 'active', '--project', f.tree, '-m', 'Started.'], {}, f.root);
    f.ok(['allow', 'work', '--grant', 'land'], {}, f.root);
    f.commit('one');
    // An explicit grant says Owner allowed it; it does not say there is a landable tree.
    const before = git(f.origin, ['rev-parse', 'master']);
    const fromMain = f.run(['land', 'work'], {}, f.main);
    assert.equal(fromMain.status, 3);
    assert.match(fromMain.stderr, /cannot land: .*not a linked worktree/);
    assert.equal(git(f.origin, ['rev-parse', 'master']), before);

    // The combination that used to reach wt.landWorktree(undefined): granted, opted out.
    const file = path.join(f.root, 'tasks', 'work.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^status: .*$/m, '$&\nauto_land: off'));
    assert.equal(f.run(['allow', 'work', 'land']).status, 0, 'the explicit grant still stands');
    const dirty = path.join(f.tree, 'scratch.txt');
    fs.writeFileSync(dirty, 'uncommitted\n');
    const refused = f.run(['land', 'work']);
    assert.equal(refused.status, 3);
    assert.match(refused.stderr, /cannot land: .*uncommitted change\(s\)/);
    const dry = f.run(['land', 'work', '--dry-run']);
    assert.equal(dry.status, 3);
    assert.equal(/undefined/.test(dry.stdout + dry.stderr), false, '--dry-run never prints undefined');
    fs.unlinkSync(dirty);
    assert.equal(git(f.origin, ['rev-parse', 'master']), before);
  } finally { f.cleanup(); }
});

test('keep reviewed on a card another session owns warns and still files', () => {
  const f = fixture();
  try {
    // From inside the project, so the creating session actually claims the card.
    f.ok(['add', 'Work', '--status', 'active', '--project', f.tree, '-m', 'Started.'], { CLAUDE_CODE_SESSION_ID: 'owning-session' });
    assert.deepEqual(f.card().fm.sessions.map((entry) => entry.id), ['owning-session']);
    const sha = f.commit('one');
    const out = f.run(['reviewed', 'work', '--commit', sha, '--verdict', 'clean', '--by', 'codex sol', '--job', 'task-done-1'],
      { CODEX_THREAD_ID: 'visiting-session' });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stderr, /work is claimed by owning-s, not this codex session visiting/);
    assert.equal(require('./reviews.js').readRecords('work', f.root).length, 1, 'filed anyway');
  } finally { f.cleanup(); }
});
