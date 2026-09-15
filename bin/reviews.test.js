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
    git(tree, ['add', '.']);
    git(tree, ['commit', '-qm', text]);
    return git(tree, ['rev-parse', 'HEAD']);
  };
  const card = () => require('./keep.js').parseTask(fs.readFileSync(path.join(root, 'tasks', 'work.md'), 'utf8'), 'work');
  return { base, root, origin, main, tree, env, run, ok, commit, card,
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
      '--job', 'job_abc', '--evidence', 'codex review job_abc: no findings', '-m', 'Read the whole delta.']);
    assert.match(out, /recorded clean review rev-/);

    const records = JSON.parse(f.ok(['reviews', 'work', '--json'])).records;
    assert.equal(records.length, 1);
    assert.equal(records[0].verdict, 'clean');
    assert.equal(records[0].by, 'codex sol');
    assert.equal(records[0].job, 'job_abc');
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
    f.ok(['reviewed', 'work', '--commit', `${sha}..HEAD`, '--verdict', 'findings', '--job', 'job_def']);
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

    // An agent self-attestation with neither --job nor --evidence is not evidence.
    f.ok(['reviewed', 'work', '--commit', sha, '--verdict', 'clean', '--by', 'claude']);
    const selfAttested = f.run(['allow', 'work', 'land']);
    assert.equal(selfAttested.status, 3);
    assert.match(selfAttested.stdout, /self-attestation with no --job or --evidence/);

    f.ok(['reviewed', 'work', '--commit', sha, '--verdict', 'clean', '--by', 'codex sol', '--job', 'job_abc']);
    const allowed = f.run(['allow', 'work', 'land']);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /allowed: reviewed clean: 1 commit\(s\) by codex sol/);
    const json = JSON.parse(f.run(['allow', 'work', 'land', '--json']).stdout);
    assert.equal(json.ok, true);
    assert.equal(json.implicit, true);
    assert.equal(json.record.job, 'job_abc');

    // A new commit nobody reviewed takes the grant away again.
    const second = f.commit('two');
    const stale = f.run(['allow', 'work', 'land']);
    assert.equal(stale.status, 3);
    assert.match(stale.stdout, /has no review record/);
    f.ok(['reviewed', 'work', '--commit', second, '--verdict', 'clean', '--by', 'codex sol', '--job', 'job_def']);
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
  } finally { f.cleanup(); }
});
