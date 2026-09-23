'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const facts = require('./repo-facts.js');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A home with a main checkout that has an origin, and a linked worktree of it.
function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-repo-facts-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const origin = path.join(home, 'origin.git');
  const main = path.join(home, 'app');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin]);
  execFileSync('git', ['clone', '-q', origin, main], { stdio: 'ignore' });
  git(main, 'config', 'user.name', 'Keep Test');
  git(main, 'config', 'user.email', 'keep@example.test');
  git(main, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, 'app.txt'), 'v1\n');
  git(main, 'add', 'app.txt');
  git(main, 'commit', '-q', '-m', 'v1');
  git(main, 'push', '-q', '-u', 'origin', 'main');
  git(main, 'remote', 'set-head', 'origin', 'main');
  const worktree = path.join(home, 'wt', 'app', 'feature');
  git(main, 'worktree', 'add', '-q', '-b', 'wt/feature', worktree);
  const plain = path.join(home, 'notes');
  fs.mkdirSync(plain);
  return { home, main, worktree, plain };
}

test('an ordinary command gets its cwd\'s toplevel and main checkout, and nothing else', (t) => {
  const f = fixture(t);
  const sub = path.join(f.worktree, 'src');
  fs.mkdirSync(sub);
  const got = facts.computeRepoFacts({ cwd: sub, command: 'ls -la && cd /elsewhere', event: 'pre-bash', fingerprints: ['terraform apply'], home: f.home });
  assert.deepEqual(got, { paths: { [sub]: { top: f.worktree, main: f.main } }, deploy: null, head: {} });
  assert.equal(got.incomplete, undefined);
  const outside = facts.computeRepoFacts({ cwd: f.plain, command: 'ls', event: 'pre-bash', home: f.home });
  assert.deepEqual(outside.paths, { [f.plain]: { top: null, main: null } }, 'not a repository reads as null');
});

test('a command that could be a step gets every cd target, capped, and only under the home', (t) => {
  const f = fixture(t);
  const command = `cd ${f.worktree} && cd ~/app && cd /opt/elsewhere && terraform apply -auto-approve`;
  const got = facts.computeRepoFacts({ cwd: f.plain, command, event: 'pre-bash', fingerprints: ['terraform apply'], home: f.home });
  assert.deepEqual(got.paths, {
    [f.plain]: { top: null, main: null },
    [f.worktree]: { top: f.worktree, main: f.main },
    [f.main]: { top: f.main, main: f.main },
  });
  // The same command without a published fingerprint is only its cwd.
  assert.deepEqual(Object.keys(facts.computeRepoFacts({ cwd: f.plain, command, event: 'pre-bash', fingerprints: [], home: f.home }).paths), [f.plain]);
  // At most eight bases.
  const many = Array.from({ length: 12 }, (_, i) => `cd ${path.join(f.home, `d${i}`)}`).join(' && ');
  const capped = facts.computeRepoFacts({ cwd: f.plain, command: `${many} && terraform apply`, event: 'pre-bash', fingerprints: ['terraform apply'], home: f.home });
  assert.equal(Object.keys(capped.paths).length, facts.MAX_BASES);
  assert.equal(Object.keys(capped.paths)[0], f.plain);
});

test('a post-bash deploy carries its provenance and the cwd\'s HEAD', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.worktree, 'app.txt'), 'v2\n');
  git(f.worktree, 'commit', '-qam', 'v2');
  fs.writeFileSync(path.join(f.worktree, 'scratch.txt'), 'x\n');
  const head = git(f.worktree, 'rev-parse', 'HEAD');
  const got = facts.computeRepoFacts({ cwd: f.worktree, command: 'git push heroku HEAD:main', event: 'post-bash', home: f.home });
  assert.deepEqual(got.deploy, { dir: f.worktree, repo: f.worktree, sha: head, dirty: ['scratch.txt'], branch: 'main', onOrigin: false });
  assert.deepEqual(got.head, { [f.worktree]: head });
  // The same as the daemon node's own deploy recorder computes.
  const local = facts.deployProvenance(f.worktree, 'HEAD');
  assert.deepEqual({ dir: f.worktree, ...local }, got.deploy);
  // A deploy from -C elsewhere is judged there; pre-bash never computes one.
  const elsewhere = facts.computeRepoFacts({ cwd: f.plain, command: `git -C ${f.main} push heroku main`, event: 'post-bash', home: f.home });
  assert.equal(elsewhere.deploy.repo, f.main);
  assert.equal(elsewhere.deploy.onOrigin, true);
  assert.deepEqual(elsewhere.head, {});
  assert.equal(facts.computeRepoFacts({ cwd: f.worktree, command: 'git push heroku main', event: 'pre-bash', home: f.home }).deploy, null);
  // Not a checkout: no provenance.
  assert.equal(facts.computeRepoFacts({ cwd: f.plain, command: 'adb install app.apk', event: 'post-bash', home: f.home }).deploy, null);
});

test('a repository that does not answer in time reads as null and marks the facts incomplete', (t) => {
  const f = fixture(t);
  let clock = 0;
  const got = facts.computeRepoFacts({ cwd: f.worktree, command: 'terraform apply', event: 'pre-bash', fingerprints: ['terraform apply'],
    home: f.home, now: () => (clock += 5000), budgetMs: 3000 });
  assert.deepEqual(got.paths, { [f.worktree]: { top: null, main: null } });
  assert.equal(got.incomplete, true);
  assert.equal(JSON.parse(JSON.stringify(got)).incomplete, undefined, 'never posted');
});

test('the published fingerprints match a command the way the step guard does', () => {
  assert.equal(facts.fingerprintMatch('terraform apply', []), null);
  assert.equal(facts.fingerprintMatch('grep terraform apply.log', ['terraform apply']), null);
  assert.equal(facts.fingerprintMatch('echo "terraform apply"', ['terraform apply']), null);
  assert.equal(facts.fingerprintMatch('cd infra && /usr/local/bin/terraform apply', ['terraform apply']).fingerprint, 'terraform apply');
  assert.equal(facts.fingerprintMatch('./build_packer_image.sh prod', ['build_packer_image.sh']).fingerprint, 'build_packer_image.sh');
});
