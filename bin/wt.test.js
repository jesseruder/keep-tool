'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const wt = require('./wt.js');

const CLI = path.join(__dirname, 'wt.js');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function fixture(name = 'sample-repo') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-')));
  const origin = path.join(root, 'origin.git');
  const repos = path.join(root, 'repos');
  const main = path.join(repos, name);
  const worktreeRoot = path.join(root, 'worktrees');
  const configFile = path.join(root, 'config.json');
  fs.mkdirSync(repos);
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['clone', '-q', origin, main]);
  git(main, 'config', 'user.name', 'Wt Test');
  git(main, 'config', 'user.email', 'wt@example.test');
  git(main, 'checkout', '-q', '-b', 'main');
  write(path.join(main, 'tracked.txt'), 'initial\n');
  git(main, 'add', 'tracked.txt');
  git(main, 'commit', '-q', '-m', 'initial');
  git(main, 'push', '-q', '-u', 'origin', 'main');
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(main, 'remote', 'set-head', 'origin', 'main');
  const cfg = {
    worktreeRoot,
    roots: [repos],
    defaultRepos: [name],
    guard: false,
    include: ['.env'],
  };
  write(configFile, JSON.stringify(cfg));
  return { root, origin, repos, main, worktreeRoot, configFile, cfg, name };
}

function runCli(f, args, input, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, WT_CONFIG: f.configFile, WT_NO_INSTALL: '1', ...extraEnv },
  });
}

function commitIn(repo, message) {
  git(repo, 'config', 'user.name', 'Wt Test');
  git(repo, 'config', 'user.email', 'wt@example.test');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
}

function ageHead(repo, iso) {
  execFileSync('git', ['-C', repo, 'commit', '--amend', '-q', '--no-edit', `--date=${iso}`], {
    env: { ...process.env, GIT_COMMITTER_DATE: iso },
  });
}

test('new creates a branch at origin/main, metadata, and excludes, then refuses duplicates', () => {
  const f = fixture();
  try {
    const created = runCli(f, ['new', f.name, 'probe', '--no-install']);
    assert.equal(created.status, 0, created.stderr);
    const worktree = created.stdout.trim();
    assert.equal(worktree, path.join(f.worktreeRoot, f.name, 'probe'));
    assert.equal(created.stdout, `${worktree}\n`);
    assert.equal(git(worktree, 'branch', '--show-current'), 'wt/probe');
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), git(f.main, 'rev-parse', 'origin/main'));
    const metadata = JSON.parse(fs.readFileSync(path.join(worktree, '.wt.json'), 'utf8'));
    assert.equal(metadata.repo, f.main);
    assert.equal(metadata.name, 'probe');
    assert.equal(metadata.branch, 'wt/probe');
    assert.equal(metadata.base, 'origin/main');
    const excludes = fs.readFileSync(path.join(f.main, '.git', 'info', 'exclude'), 'utf8');
    for (const marker of ['.wt.json', '.wt-free', '.wt-install-failed']) assert.match(excludes, new RegExp(`^${marker.replace('.', '\\.')}$`, 'm'));

    const duplicate = runCli(f, ['new', `${f.name}/probe`, '--no-install']);
    assert.equal(duplicate.status, 1);
    assert.equal(duplicate.stdout, '');
    assert.match(duplicate.stderr, /worktree exists:/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('new copies only matching ignored includes and preserves tracked worktree content', () => {
  const f = fixture();
  try {
    write(path.join(f.main, '.gitignore'), '.env\nsecrets/\nignored/\n');
    write(path.join(f.main, '.worktreeinclude'), '.env\nsecrets/*.pem\ntracked.txt\n');
    git(f.main, 'add', '.gitignore', '.worktreeinclude');
    git(f.main, 'commit', '-q', '-m', 'include rules');
    git(f.main, 'push', '-q', 'origin', 'main');
    write(path.join(f.main, '.env'), 'TOKEN=secret\n');
    write(path.join(f.main, 'secrets', 'key.pem'), 'private\n');
    write(path.join(f.main, 'secrets', 'readme.txt'), 'ignored\n');
    write(path.join(f.main, 'ignored', 'other.txt'), 'ignored\n');
    write(path.join(f.main, 'tracked.txt'), 'local main change\n');

    const result = runCli(f, ['new', f.name, 'includes', '--no-install']);
    assert.equal(result.status, 0, result.stderr);
    const worktree = result.stdout.trim();
    assert.equal(fs.readFileSync(path.join(worktree, '.env'), 'utf8'), 'TOKEN=secret\n');
    assert.equal(fs.readFileSync(path.join(worktree, 'secrets', 'key.pem'), 'utf8'), 'private\n');
    assert.equal(fs.existsSync(path.join(worktree, 'secrets', 'readme.txt')), false);
    assert.equal(fs.existsSync(path.join(worktree, 'ignored', 'other.txt')), false);
    assert.equal(fs.readFileSync(path.join(worktree, 'tracked.txt'), 'utf8'), 'initial\n');
    assert.match(result.stderr, /copied 2 include file\(s\)/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('rm refuses dirty and ahead worktrees, force recycles safely, and new reuses the directory', () => {
  const f = fixture();
  try {
    write(path.join(f.main, '.gitignore'), 'node_modules/\n');
    commitIn(f.main, 'ignore dependency cache');
    git(f.main, 'push', '-q', 'origin', 'main');
    const original = runCli(f, ['new', f.name, 'old', '--no-install']).stdout.trim();
    write(path.join(original, 'dirty.txt'), 'dirty\n');
    let removed = runCli(f, ['rm', original]);
    assert.equal(removed.status, 1);
    assert.match(removed.stderr, /dirty/);
    fs.unlinkSync(path.join(original, 'dirty.txt'));

    write(path.join(original, 'ahead.txt'), 'ahead\n');
    commitIn(original, 'ahead');
    removed = runCli(f, ['rm', original]);
    assert.equal(removed.status, 1);
    assert.match(removed.stderr, /not in origin\/main/);

    write(path.join(original, 'node_modules', 'reuse-proof'), 'kept\n');
    removed = runCli(f, ['rm', original, '--force']);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(fs.existsSync(path.join(original, '.wt-free')), true);
    assert.equal(spawnSync('git', ['-C', f.main, 'show-ref', '--verify', '--quiet', 'refs/heads/wt/old']).status, 0);
    assert.match(removed.stderr, /branch wt\/old has unlanded commits.*keeping the branch/);

    const reused = runCli(f, ['new', f.name, 'fresh', '--no-install']);
    assert.equal(reused.status, 0, reused.stderr);
    const next = reused.stdout.trim();
    assert.equal(next, path.join(f.worktreeRoot, f.name, 'fresh'));
    assert.equal(fs.existsSync(original), false);
    assert.equal(fs.readFileSync(path.join(next, 'node_modules', 'reuse-proof'), 'utf8'), 'kept\n');
    assert.equal(fs.existsSync(path.join(next, '.wt-free')), false);
    assert.equal(git(next, 'branch', '--show-current'), 'wt/fresh');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('new refuses to delete a stale branch with unlanded commits', () => {
  const f = fixture();
  try {
    git(f.main, 'checkout', '-q', '-b', 'wt/stale');
    write(path.join(f.main, 'stale.txt'), 'unlanded\n');
    commitIn(f.main, 'unlanded stale branch');
    git(f.main, 'checkout', '-q', 'main');

    const result = runCli(f, ['new', f.name, 'stale', '--no-install']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /branch wt\/stale has unlanded commits; land or delete it, or pick another name/);
    assert.equal(git(f.main, 'show', 'wt/stale:stale.txt'), 'unlanded');
    assert.equal(fs.existsSync(path.join(f.worktreeRoot, f.name, 'stale')), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('new skips a free worktree that became ahead after recycling', () => {
  const f = fixture();
  try {
    const old = runCli(f, ['new', f.name, 'old-free', '--no-install']).stdout.trim();
    let result = runCli(f, ['rm', old]);
    assert.equal(result.status, 0, result.stderr);
    write(path.join(old, 'tracked.txt'), 'commit after freeing\n');
    commitIn(old, 'commit after freeing');

    result = runCli(f, ['new', f.name, 'fresh-tree', '--no-install']);
    assert.equal(result.status, 0, result.stderr);
    const fresh = result.stdout.trim();
    assert.equal(fresh, path.join(f.worktreeRoot, f.name, 'fresh-tree'));
    assert.notEqual(fresh, old);
    assert.match(result.stderr, /free worktree .* is dirty or ahead; creating a fresh worktree/);
    assert.equal(fs.existsSync(old), true);
    assert.equal(fs.existsSync(path.join(old, '.wt-free')), true);
    assert.equal(git(old, 'show', 'HEAD:tracked.txt'), 'commit after freeing');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('rm uses detached worktree metadata and preserves an unlanded branch', () => {
  const f = fixture();
  try {
    const worktree = runCli(f, ['new', f.name, 'detached-rm', '--no-install']).stdout.trim();
    write(path.join(worktree, 'branch-only.txt'), 'keep me\n');
    commitIn(worktree, 'branch-only commit');
    const branchSha = git(worktree, 'rev-parse', 'HEAD');
    git(worktree, 'checkout', '-q', '--detach');

    const removed = runCli(f, ['rm', worktree, '--force']);
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stderr, /branch wt\/detached-rm has unlanded commits.*keeping the branch/);
    assert.equal(git(f.main, 'rev-parse', 'wt/detached-rm'), branchSha);
    assert.equal(fs.existsSync(path.join(worktree, '.wt-free')), true);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('land advances origin, refuses dirt, and aborts a conflicting rebase', () => {
  const f = fixture();
  try {
    const worktree = runCli(f, ['new', f.name, 'landing', '--no-install']).stdout.trim();
    write(path.join(worktree, 'landed.txt'), 'landed\n');
    commitIn(worktree, 'land this');
    let landed = runCli(f, ['land', worktree]);
    assert.equal(landed.status, 0, landed.stderr);
    assert.equal(landed.stdout.trim(), git(f.origin, 'rev-parse', 'main'));
    assert.equal(git(f.origin, 'rev-parse', 'main'), git(worktree, 'rev-parse', 'HEAD'));

    write(path.join(worktree, 'dirty.txt'), 'dirty\n');
    landed = runCli(f, ['land', worktree]);
    assert.equal(landed.status, 1);
    assert.match(landed.stderr, /worktree is dirty/);
    fs.unlinkSync(path.join(worktree, 'dirty.txt'));

    git(f.main, 'pull', '-q', '--ff-only');
    write(path.join(worktree, 'tracked.txt'), 'worktree side\n');
    commitIn(worktree, 'worktree conflict');
    write(path.join(f.main, 'tracked.txt'), 'origin side\n');
    git(f.main, 'add', 'tracked.txt');
    git(f.main, 'commit', '-q', '-m', 'origin conflict');
    git(f.main, 'push', '-q', 'origin', 'main');

    landed = runCli(f, ['land', worktree]);
    assert.equal(landed.status, 1);
    assert.match(landed.stderr, /rebase conflict.*manually/);
    assert.equal(fs.existsSync(path.join(worktree, '.git', 'rebase-merge')), false);
    assert.equal(git(worktree, 'status', '--porcelain'), '');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('land refuses while the main checkout holds commits origin does not have', () => {
  const f = fixture();
  try {
    const worktree = runCli(f, ['new', f.name, 'behind-main', '--no-install']).stdout.trim();
    write(path.join(worktree, 'mine.txt'), 'mine\n');
    commitIn(worktree, 'worktree work');
    write(path.join(f.main, 'theirs.txt'), 'theirs\n');
    commitIn(f.main, 'unpushed main-checkout work');
    const originBefore = git(f.origin, 'rev-parse', 'main');
    let result = runCli(f, ['land', worktree]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /main checkout .* has 1 commit\(s\) on main that origin\/main does not: landing now would leave them behind\./);
    assert.match(result.stderr, /unpushed main-checkout work/);
    assert.match(result.stderr, /--ignore-main lands anyway/);
    assert.equal(git(f.origin, 'rev-parse', 'main'), originBefore, 'nothing pushed');
    result = runCli(f, ['land', worktree, '--dry-run']);
    assert.equal(result.status, 1, 'dry-run reports the refusal too');
    // pushing the main checkout clears the refusal
    git(f.main, 'push', '-q', 'origin', 'main');
    result = runCli(f, ['land', worktree]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(f.origin, 'log', '--oneline', '-3').split('\n').length, 3);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('land treats a main checkout with no local default branch as having nothing unpushed', () => {
  const f = fixture();
  try {
    const worktree = runCli(f, ['new', f.name, 'no-local-main', '--no-install']).stdout.trim();
    write(path.join(worktree, 'mine.txt'), 'mine\n');
    commitIn(worktree, 'worktree work');
    git(f.main, 'checkout', '-q', '--detach');
    git(f.main, 'branch', '-D', 'main');
    assert.deepEqual(wt.unpushedMainCommits(f.main, 'main'), []);
    const result = runCli(f, ['land', worktree]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(wt.unpushedMainCommits(f.main, 'nope'), [], 'no such local branch: nothing is ahead');
    // a local branch with no origin counterpart is a git error, and that must not fail open
    git(f.main, 'branch', 'nope');
    assert.throws(() => wt.unpushedMainCommits(f.main, 'nope'));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('land --ignore-main lands over unpushed main-checkout commits on request', () => {
  const f = fixture();
  try {
    const worktree = runCli(f, ['new', f.name, 'ignore-main', '--no-install']).stdout.trim();
    write(path.join(worktree, 'mine.txt'), 'mine\n');
    commitIn(worktree, 'worktree work');
    write(path.join(f.main, 'theirs.txt'), 'theirs\n');
    commitIn(f.main, 'left behind on purpose');
    const result = runCli(f, ['land', worktree, '--ignore-main']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(git(f.origin, 'log', '--oneline', '-1'), /worktree work/);
    assert.doesNotMatch(git(f.origin, 'log', '--oneline'), /left behind/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('the guard refuses a bare-ref push of main or master from a worktree', () => {
  const f = fixture();
  try {
    const worktree = runCli(f, ['new', f.name, 'bare-push', '--no-install']).stdout.trim();
    const guarded = { ...f.cfg, guard: true };
    const decide = (command, cwd) => wt.guardDecision({ tool_name: 'Bash', tool_input: { command }, cwd }, guarded);
    assert.equal(decide('git push heroku master', worktree).deny, true);
    assert.match(decide('git push heroku master', worktree).reason, /use `git push heroku HEAD:master`/);
    assert.equal(decide('cd sub && git push origin main && echo ok', worktree).deny, true);
    assert.equal(decide('git push -f heroku master', worktree).deny, true);
    assert.equal(decide('git push heroku HEAD:master', worktree).deny, false);
    assert.equal(decide('git push origin wt/x:main', worktree).deny, false);
    assert.equal(decide('git push origin --delete master', worktree).deny, false);
    assert.equal(decide('git push heroku master', f.main).deny, false, 'the main checkout pushes its own ref');
    assert.equal(decide('git push heroku master', worktree).deny, true);
    assert.equal(wt.guardDecision({ tool_name: 'Bash', tool_input: { command: 'git push heroku master' }, cwd: worktree }, f.cfg).deny, false, 'guard off');
    assert.deepEqual(wt.barePushOfSharedRef('git -C ~/wt/x push heroku master; echo'), { remote: 'heroku', ref: 'master', dir: '~/wt/x' });
    assert.equal(wt.barePushOfSharedRef('git push heroku master-fixes'), null);
    assert.deepEqual(wt.barePushOfSharedRef('git push heroku +main'), { remote: 'heroku', ref: 'main', dir: '' });
    assert.deepEqual(wt.barePushOfSharedRef('git push https://git.heroku.com/app.git master'), { remote: 'https://git.heroku.com/app.git', ref: 'master', dir: '' });
    assert.deepEqual(wt.barePushOfSharedRef('git push heroku -f --no-verify main'), { remote: 'heroku', ref: 'main', dir: '' });
    assert.equal(wt.barePushOfSharedRef('git push heroku -d master'), null);
    assert.equal(wt.barePushOfSharedRef('# git push heroku master'), null);
    assert.equal(wt.barePushOfSharedRef('git push heroku master:master'), null, 'an explicit refspec names its source');
    // -C into a worktree from a non-worktree cwd is the same trap
    assert.equal(decide(`git -C ${worktree} push heroku master`, f.main).deny, true);
    assert.equal(decide(`git -C ${f.main} push heroku master`, worktree).deny, false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('land --dry-run reports without changing HEAD, its reflog, or origin', () => {
  const f = fixture();
  try {
    const worktree = runCli(f, ['new', f.name, 'dry-land', '--no-install']).stdout.trim();
    write(path.join(worktree, 'worktree.txt'), 'local\n');
    commitIn(worktree, 'local worktree commit');
    write(path.join(f.main, 'origin.txt'), 'remote\n');
    commitIn(f.main, 'origin commit');
    git(f.main, 'push', '-q', 'origin', 'main');
    const beforeHead = git(worktree, 'rev-parse', 'HEAD');
    const beforeReflog = git(worktree, 'reflog', 'show', '--format=%H %gs', 'HEAD');
    const beforeOrigin = git(f.origin, 'rev-parse', 'main');

    const result = runCli(f, ['land', worktree, '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /local worktree commit/);
    assert.match(result.stderr, /would rebase onto origin\/main/);
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), beforeHead);
    assert.equal(git(worktree, 'reflog', 'show', '--format=%H %gs', 'HEAD'), beforeReflog);
    assert.equal(git(f.origin, 'rev-parse', 'main'), beforeOrigin);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('land --no-push rebases locally and leaves origin unchanged', () => {
  const f = fixture();
  try {
    const worktree = runCli(f, ['new', f.name, 'local-land', '--no-install']).stdout.trim();
    write(path.join(worktree, 'worktree.txt'), 'local\n');
    commitIn(worktree, 'local-only commit');
    const beforeRebase = git(worktree, 'rev-parse', 'HEAD');
    write(path.join(f.main, 'origin.txt'), 'remote\n');
    commitIn(f.main, 'origin commit');
    git(f.main, 'push', '-q', 'origin', 'main');
    const beforeOrigin = git(f.origin, 'rev-parse', 'main');

    const result = runCli(f, ['land', worktree, '--no-push']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), git(worktree, 'rev-parse', 'HEAD'));
    assert.match(result.stderr, /rebased locally onto origin\/main; 1 commit\(s\) not pushed/);
    assert.doesNotMatch(result.stderr, /landed 1 commit/);
    assert.notEqual(git(worktree, 'rev-parse', 'HEAD'), beforeRebase);
    assert.equal(git(f.origin, 'rev-parse', 'main'), beforeOrigin);
    assert.equal(spawnSync('git', ['-C', worktree, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD']).status, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('land refuses detached HEAD, non-wt branches, and trees without metadata', () => {
  const f = fixture();
  try {
    const worktree = runCli(f, ['new', f.name, 'land-safety', '--no-install']).stdout.trim();
    git(worktree, 'checkout', '-q', '--detach');
    let result = runCli(f, ['land', worktree]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot land detached HEAD/);

    git(worktree, 'checkout', '-q', '-b', 'feature');
    result = runCli(f, ['land', worktree]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot land non-wt branch feature/);

    git(worktree, 'checkout', '-q', 'wt/land-safety');
    fs.unlinkSync(path.join(worktree, '.wt.json'));
    result = runCli(f, ['land', worktree]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a wt-managed tree/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('mainCheckout resolves main and linked subdirectories and rejects non-git paths', () => {
  const f = fixture();
  try {
    const worktree = wt.createWorktree({ repo: f.main, name: 'paths', noInstall: true, cfg: f.cfg });
    const subdir = path.join(worktree, 'nested');
    fs.mkdirSync(subdir);
    assert.equal(wt.mainCheckout(subdir), f.main);
    assert.equal(wt.mainCheckout(f.main), f.main);
    assert.equal(wt.mainCheckout(f.root), null);
    assert.equal(wt.isLinkedWorktree(subdir), true);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('nudge appears only in default repositories main checkouts', () => {
  const f = fixture();
  try {
    const worktree = wt.createWorktree({ repo: f.main, name: 'nudge', noInstall: true, cfg: f.cfg });
    assert.match(wt.nudgeFor(f.main, f.cfg), /^\[wt — worktrees\]/);
    assert.equal(wt.nudgeFor(worktree, f.cfg), '');
    assert.equal(wt.nudgeFor(f.main, { ...f.cfg, defaultRepos: [] }), '');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('guardDecision protects writes and git mutations in default main checkouts', () => {
  const f = fixture();
  const prior = process.env.WT_MAIN_OK;
  try {
    const guarded = { ...f.cfg, guard: true };
    const worktree = wt.createWorktree({ repo: f.main, name: 'guard', noInstall: true, cfg: f.cfg });
    assert.equal(wt.guardDecision({ tool_name: 'Edit', tool_input: { file_path: path.join(f.main, 'tracked.txt') } }, guarded).deny, true);
    assert.equal(wt.guardDecision({ tool_name: 'Edit', tool_input: { file_path: path.join(f.main, 'tracked.txt') } }, f.cfg).deny, false);
    assert.equal(wt.guardDecision({ tool_name: 'Bash', tool_input: { command: 'git commit -am test' }, cwd: f.main }, guarded).deny, true);
    assert.equal(wt.guardDecision({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: f.main }, guarded).deny, false);
    assert.equal(wt.guardDecision({ tool_name: 'Edit', tool_input: { file_path: path.join(worktree, 'tracked.txt') } }, guarded).deny, false);
    process.env.WT_MAIN_OK = '1';
    assert.equal(wt.guardDecision({ tool_name: 'Edit', tool_input: { file_path: path.join(f.main, 'tracked.txt') } }, guarded).deny, false);
  } finally {
    if (prior === undefined) delete process.env.WT_MAIN_OK;
    else process.env.WT_MAIN_OK = prior;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('hook create accepts repo/name and a bare name in a repo, and rejects a bare name outside git', () => {
  const f = fixture();
  try {
    let result = runCli(f, ['hook', 'create'], JSON.stringify({ name: `${f.name}/hook-x`, cwd: f.root }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), path.join(f.worktreeRoot, f.name, 'hook-x'));

    result = runCli(f, ['hook', 'create'], JSON.stringify({ name: 'hook-y', cwd: f.main }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), path.join(f.worktreeRoot, f.name, 'hook-y'));

    result = runCli(f, ['hook', 'create'], JSON.stringify({ name: 'hook-z', cwd: f.root }));
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /bare worktree name requires cwd inside a git repo/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('hook remove refuses a dirty managed worktree without forcing it', () => {
  const f = fixture();
  try {
    const worktree = runCli(f, ['new', f.name, 'hook-dirty', '--no-install']).stdout.trim();
    write(path.join(worktree, 'dirty.txt'), 'dirty\n');
    const result = runCli(f, ['hook', 'remove'], JSON.stringify({ path: worktree }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /refusing to remove .*dirty/);
    assert.equal(fs.existsSync(path.join(worktree, 'dirty.txt')), true);
    assert.equal(fs.existsSync(path.join(worktree, '.wt.json')), true);
    assert.equal(fs.existsSync(path.join(worktree, '.wt-free')), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('hook remove ignores paths under worktreeRoot without .wt.json', () => {
  const f = fixture();
  try {
    const unmanaged = path.join(f.worktreeRoot, f.name, 'unmanaged');
    fs.mkdirSync(path.dirname(unmanaged), { recursive: true });
    git(f.main, 'worktree', 'add', '-q', '-b', 'wt/unmanaged', unmanaged, 'origin/main');
    const beforeHead = git(unmanaged, 'rev-parse', 'HEAD');
    const result = runCli(f, ['hook', 'remove'], JSON.stringify({ cwd: unmanaged }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(fs.existsSync(unmanaged), true);
    assert.equal(git(unmanaged, 'rev-parse', 'HEAD'), beforeHead);
    assert.equal(git(unmanaged, 'branch', '--show-current'), 'wt/unmanaged');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('matchIncludes follows root anchoring, basename, directory, slash, and ** semantics', () => {
  const files = [
    'foo', 'a/foo', 'x.pem', 'secrets/x.pem', 'secrets/deep/x.pem',
    'one/two.txt', 'a/one/two.txt', 'cache', 'cache/a.txt', 'a/cache/b.txt',
    'dir/a/end', 'dir/x/y/end',
  ];
  assert.deepEqual(wt.matchIncludes(['/foo'], files), ['foo']);
  assert.deepEqual(wt.matchIncludes(['*.pem'], files), ['x.pem', 'secrets/x.pem', 'secrets/deep/x.pem']);
  assert.deepEqual(wt.matchIncludes(['one/*.txt'], files), ['one/two.txt']);
  assert.deepEqual(wt.matchIncludes(['cache/'], files), ['cache/a.txt', 'a/cache/b.txt']);
  assert.deepEqual(wt.matchIncludes(['dir/**/end'], files), ['dir/a/end', 'dir/x/y/end']);
  assert.deepEqual(wt.matchIncludes(['# ignored', '/foo', '*.pem'], files), [
    'foo', 'x.pem', 'secrets/x.pem', 'secrets/deep/x.pem',
  ]);
});

test('new restores a reused free worktree after a post-add failure so the name can be retried', () => {
  const f = fixture();
  try {
    const original = runCli(f, ['new', f.name, 'old', '--no-install']).stdout.trim();
    assert.equal(runCli(f, ['rm', original]).status, 0);
    assert.equal(fs.existsSync(path.join(original, '.wt-free')), true);

    const destination = path.join(f.worktreeRoot, f.name, 'retry');
    const failed = runCli(f, ['new', f.name, 'retry', '--no-install'], undefined, {
      WT_TEST_FAIL_AFTER_ADD: '1',
    });
    assert.equal(failed.status, 1);
    assert.equal(fs.existsSync(path.join(destination, '.wt-free')), true);
    assert.equal(spawnSync('git', ['-C', f.main, 'show-ref', '--verify', '--quiet', 'refs/heads/wt/retry']).status, 1);

    // An invalid --base fails inside the checkout itself; rollback must not retry that ref.
    const badBase = runCli(f, ['new', f.name, 'retry', '--no-install', '--base', 'no-such-ref']);
    assert.equal(badBase.status, 1);
    assert.equal(fs.existsSync(path.join(destination, '.wt-free')), true);
    assert.equal(git(destination, 'status', '--porcelain', '--untracked-files=all').replace(/^.. \.wt-free$/m, '').trim(), '');

    const retried = runCli(f, ['new', f.name, 'retry', '--no-install']);
    assert.equal(retried.status, 0, retried.stderr);
    assert.equal(retried.stdout.trim(), destination);
    assert.equal(fs.existsSync(path.join(destination, '.wt-free')), false);
    assert.equal(git(destination, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'wt/retry');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('new rolls back its registered worktree and branch after a post-add failure', () => {
  const f = fixture();
  try {
    const destination = path.join(f.worktreeRoot, f.name, 'rollback');
    const result = runCli(f, ['new', f.name, 'rollback', '--no-install'], undefined, {
      WT_TEST_FAIL_AFTER_ADD: '1',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(`creation failed for ${destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(fs.existsSync(destination), false);
    assert.equal(spawnSync('git', ['-C', f.main, 'show-ref', '--verify', '--quiet', 'refs/heads/wt/rollback']).status, 1);
    assert.equal(git(f.main, 'worktree', 'list', '--porcelain').includes(destination), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('gc recycles only old landed worktrees and explains every safety skip', () => {
  const f = fixture();
  try {
    const old = '2026-08-01T00:00:00Z';
    ageHead(f.main, old);
    git(f.main, 'push', '-q', '--force', 'origin', 'main');
    const landed = runCli(f, ['new', f.name, 'landed', '--no-install']).stdout.trim();
    const dirty = runCli(f, ['new', f.name, 'dirty', '--no-install']).stdout.trim();
    const ahead = runCli(f, ['new', f.name, 'ahead', '--no-install']).stdout.trim();
    const live = runCli(f, ['new', f.name, 'live', '--no-install']).stdout.trim();
    write(path.join(dirty, 'dirty.txt'), 'dirty\n');
    write(path.join(ahead, 'ahead.txt'), 'ahead\n');
    commitIn(ahead, 'ahead');
    write(path.join(f.main, 'fresh.txt'), 'fresh\n');
    commitIn(f.main, 'fresh origin');
    git(f.main, 'push', '-q', 'origin', 'main');
    const fresh = runCli(f, ['new', f.name, 'fresh', '--no-install']).stdout.trim();
    fs.mkdirSync(path.join(live, 'subdir'));
    const fixtureDir = path.join(f.worktreeRoot, 'optimizer-fixture.probe');
    fs.mkdirSync(fixtureDir, { recursive: true });

    const result = wt.gcWorktrees({ cfg: f.cfg, days: 3, keepFree: 2,
      now: Date.parse('2026-09-10T00:00:00Z'), deps: { liveCwds: [path.join(live, 'subdir')] } });
    const byName = new Map(result.rows.map((row) => [row.name, row]));
    assert.equal(byName.get('landed').action, 'recycle');
    assert.match(byName.get('dirty').reason, /dirty/);
    assert.match(byName.get('ahead').reason, /ahead of origin\/main/);
    assert.match(byName.get('fresh').reason, /newer than 3 day/);
    assert.match(byName.get('live').reason, /live session cwd/);
    assert.ok(result.rows.some((row) => row.repoName === 'optimizer-fixture.probe'
      && /not a linked worktree/.test(row.reason)));
    assert.equal(fs.existsSync(path.join(landed, '.wt-free')), true);
    assert.equal(fs.existsSync(path.join(dirty, 'dirty.txt')), true);
    assert.equal(fs.existsSync(ahead), true);
    assert.equal(fs.existsSync(fresh), true);
    assert.equal(fs.existsSync(live), true);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('gc dry-run preserves trees, then deletes the oldest safe free trees beyond the cap', () => {
  const f = fixture();
  try {
    const frees = [];
    for (const name of ['one', 'two', 'three', 'four']) {
      frees.push(runCli(f, ['new', f.name, name, '--no-install']).stdout.trim());
    }
    for (const worktree of frees) assert.equal(runCli(f, ['rm', worktree]).status, 0);
    frees.forEach((worktree, index) => fs.writeFileSync(path.join(worktree, '.wt-free'), JSON.stringify({
      freedAt: new Date(Date.UTC(2026, 8, index + 1)).toISOString(), previousName: path.basename(worktree),
    }) + '\n'));

    const dry = wt.gcWorktrees({ cfg: f.cfg, dryRun: true, keepFree: 2, deps: { liveCwds: [] } });
    assert.deepEqual(dry.rows.filter((row) => row.action === 'would-delete').map((row) => row.name), ['one', 'two']);
    assert.ok(frees.every((worktree) => fs.existsSync(worktree)));

    const result = wt.gcWorktrees({ cfg: f.cfg, keepFree: 2, deps: { liveCwds: [] } });
    assert.deepEqual(result.rows.filter((row) => row.action === 'delete').map((row) => row.name), ['one', 'two']);
    assert.equal(fs.existsSync(frees[0]), false);
    assert.equal(fs.existsSync(frees[1]), false);
    assert.equal(fs.existsSync(frees[2]), true);
    assert.equal(fs.existsSync(frees[3]), true);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('gc never deletes dirty, ahead, or live free worktrees while shrinking the safe pool', () => {
  const f = fixture();
  try {
    const names = ['dirty-free', 'ahead-free', 'live-free', 'safe-one', 'safe-two', 'safe-three'];
    const trees = names.map((name) => runCli(f, ['new', f.name, name, '--no-install']).stdout.trim());
    for (const tree of trees) assert.equal(runCli(f, ['rm', tree]).status, 0);
    trees.forEach((tree, index) => fs.writeFileSync(path.join(tree, '.wt-free'), JSON.stringify({
      freedAt: new Date(Date.UTC(2026, 7, index + 1)).toISOString(), previousName: names[index],
    }) + '\n'));
    write(path.join(trees[0], 'dirty.txt'), 'dirty\n');
    write(path.join(trees[1], 'ahead.txt'), 'ahead\n');
    commitIn(trees[1], 'ahead after free');
    fs.mkdirSync(path.join(trees[2], 'running'));

    const result = wt.gcWorktrees({ cfg: f.cfg, keepFree: 2,
      deps: { liveCwds: [path.join(trees[2], 'running')] } });
    const byName = new Map(result.rows.map((row) => [row.name, row]));
    assert.match(byName.get('dirty-free').reason, /dirty/);
    assert.match(byName.get('ahead-free').reason, /ahead/);
    assert.match(byName.get('live-free').reason, /live session cwd/);
    for (const tree of trees.slice(0, 3)) assert.equal(fs.existsSync(tree), true);
    for (const tree of trees.slice(3)) assert.equal(fs.existsSync(tree), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('gc dry-run plans an old active tree through recycle and deletion when keep-free is zero', () => {
  const f = fixture();
  try {
    const old = '2026-08-01T00:00:00Z';
    ageHead(f.main, old);
    git(f.main, 'push', '-q', '--force', 'origin', 'main');
    const worktree = runCli(f, ['new', f.name, 'disposable', '--no-install']).stdout.trim();
    const options = { cfg: f.cfg, days: 3, keepFree: 0,
      now: Date.parse('2026-09-10T00:00:00Z'), deps: { liveCwds: [] } };
    const dry = wt.gcWorktrees({ ...options, dryRun: true });
    assert.equal(dry.rows.find((row) => row.name === 'disposable').action, 'would-delete');
    assert.equal(fs.existsSync(path.join(worktree, '.wt.json')), true);
    const real = wt.gcWorktrees(options);
    assert.equal(real.rows.find((row) => row.name === 'disposable').action, 'delete');
    assert.equal(fs.existsSync(worktree), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('live cwd inventory protects Codex app-server and fails closed when a live cwd is omitted', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-live-cwd-test-')));
  try {
    const outputs = (lsof) => ({ execFileSync: (command) => {
      if (command === 'ps') return '123  /usr/local/bin/codex app-server\n';
      if (command === 'lsof') return lsof;
      assert.fail(`unexpected command ${command}`);
    } });
    assert.deepEqual(wt.liveAgentCwds(outputs(`p123\nfcwd\nn${root}\n`)), [root]);
    assert.throws(() => wt.liveAgentCwds({ ...outputs(''), isPidAlive: () => true }),
      /live session cwd inventory omitted process 123/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('gc refuses all cleanup when live process cwd discovery fails', () => {
  const f = fixture();
  try {
    const worktree = runCli(f, ['new', f.name, 'safe', '--no-install']).stdout.trim();
    assert.throws(() => wt.gcWorktrees({ cfg: f.cfg, deps: {
      execFileSync: () => { throw new Error('ps unavailable'); },
    } }), /live session inventory unavailable/);
    assert.equal(fs.existsSync(path.join(worktree, '.wt.json')), true);
    assert.equal(fs.existsSync(path.join(worktree, '.wt-free')), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
