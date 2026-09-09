'use strict';

for (const key of Object.keys(process.env)) {
  if (key.startsWith('KEEP_REVIEWER')) delete process.env[key];
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const test = require('node:test');
const keep = require('./keep.js');
const { lint } = require('./lint.js');

const CLI = path.join(__dirname, 'keep.js');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-deploy-')));
  const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' };
  for (const key of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID']) delete env[key];
  for (const directory of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  execFileSync('git', ['init', '-q', '--initial-branch=main', root]);
  git(root, 'config', 'user.name', 'Keep Test');
  git(root, 'config', 'user.email', 'keep@example.test');
  // the app repo, with an origin so "on origin" has meaning
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'app');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin]);
  execFileSync('git', ['clone', '-q', origin, repo]);
  git(repo, 'config', 'user.name', 'Keep Test');
  git(repo, 'config', 'user.email', 'keep@example.test');
  git(repo, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'v1\n');
  git(repo, 'add', 'app.txt');
  git(repo, 'commit', '-q', '-m', 'v1');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  fs.writeFileSync(path.join(root, 'tasks', 'ship.md'), [
    '---', 'title: Ship the thing', 'status: active', 'kind: task', 'tags: [personal]',
    `project: ${repo}`, 'sessions:', '  - id: sess-deploy', '    agent: claude', '    at: 2026-09-04T09:00',
    'created: 2026-09-04', 'updated: 2026-09-04T09:00', '---', '',
    '## 2026-09-04 09:00 — check-in', 'Working.', '',
  ].join('\n'));
  const hook = (command, over = {}) => spawnSync(process.execPath, [CLI, 'hook', 'post-bash'], {
    encoding: 'utf8', env, cwd: repo,
    input: JSON.stringify({ session_id: 'sess-deploy', cwd: repo, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: '', stderr: '' }, ...over }),
  });
  const card = () => keep.parseTask(fs.readFileSync(path.join(root, 'tasks', 'ship.md'), 'utf8'), 'ship');
  return { root, env, repo, origin, hook, card, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('deployCommand recognises heroku, android, and garmin deploys and nothing else', () => {
  assert.deepEqual(keep.deployCommand('git push heroku HEAD:master'), { kind: 'heroku', target: 'heroku (remote heroku)', ref: 'HEAD', dir: '' });
  assert.deepEqual(keep.deployCommand('git push -f heroku-staging wt/x:master'), { kind: 'heroku', target: 'heroku (remote heroku-staging)', ref: 'wt/x', dir: '' });
  assert.deepEqual(keep.deployCommand('git push heroku master'), { kind: 'heroku', target: 'heroku (remote heroku)', ref: 'master', dir: '' });
  assert.equal(keep.deployCommand('git push heroku --delete old-branch'), null);
  assert.deepEqual(keep.deployCommand('heroku container:release web -a example-site'), { kind: 'heroku', target: 'heroku (app example-site)', ref: 'HEAD', dir: '' });
  assert.deepEqual(keep.deployCommand('adb -s R9PW30DMYXT install -r app.apk'), { kind: 'android', target: 'android device R9PW30DMYXT', ref: 'HEAD', dir: '' });
  assert.deepEqual(keep.deployCommand('cd mobile && bash run_android.sh'), { kind: 'android', target: 'android device (run_android.sh)', ref: 'HEAD', dir: '' });
  assert.deepEqual(keep.deployCommand('adb push phone/garmin_sync.py /sdcard/garmin_sync.py'), { kind: 'garmin', target: 'garmin tablet (Termux)', ref: 'HEAD', dir: '' });
  assert.equal(keep.deployCommand('git push origin HEAD:main'), null);
  assert.equal(keep.deployCommand('adb logcat | head'), null);
  assert.equal(keep.deployCommand('git push notheroku HEAD:master'), null, 'a remote merely containing heroku is not heroku');
  assert.equal(keep.deployCommand('git push myherokux HEAD:master'), null);
  assert.equal(keep.deployCommand('git push heroku-staging HEAD:master').target, 'heroku (remote heroku-staging)', 'heroku-<env> remotes are heroku');
  assert.equal(keep.deployCommand('git push heroku :master'), null, 'an empty-source refspec deletes');
  assert.deepEqual(keep.deployCommand('git push https://git.heroku.com/example-site.git +main:master'), { kind: 'heroku', target: 'heroku (remote https://git.heroku.com/example-site.git)', ref: 'main', dir: '' });
  assert.deepEqual(keep.deployCommand('cd x && git -C ~/wt/example-site/a push heroku HEAD:master'), { kind: 'heroku', target: 'heroku (remote heroku)', ref: 'HEAD', dir: '~/wt/example-site/a' });
  assert.equal(keep.deployCommand("grep 'adb install' log.txt"), null);
  assert.equal(keep.deployCommand('echo adb install later'), null);
  assert.equal(keep.deployCommand('# git push heroku HEAD:master'), null);
  assert.equal(keep.deployCommand('cat <<EOF\ngit push heroku HEAD:master\nEOF'), null);
});

test('command text on a card is redacted', () => {
  assert.equal(keep.redactCommand('HEROKU_API_KEY=abc123def git push heroku HEAD:master'), 'HEROKU_API_KEY=… git push heroku HEAD:master');
  assert.equal(keep.redactCommand('git push https://user:s3cret@git.heroku.com/app.git HEAD:master'), 'git push https://user:…@git.heroku.com/app.git HEAD:master');
  assert.equal(keep.redactCommand('curl -H "Authorization: Bearer x" --token abcdef123 api'), 'curl -H "Authorization: Bearer x" --token … api');
  assert.equal(keep.redactCommand('deploy --with ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd'), 'deploy --with …');
  assert.equal(keep.redactCommand('git push heroku HEAD:master'), 'git push heroku HEAD:master', 'ordinary commands are untouched');
  assert.equal(keep.redactCommand('adb -s R9PW30DMYXT install -r build/outputs/apk/debug/app-debug.apk'), 'adb -s R9PW30DMYXT install -r build/outputs/apk/debug/app-debug.apk');
});

test('the post-bash hook records a clean deploy with its sha and origin state on the session card', () => {
  const f = fixture();
  try {
    const out = f.hook('git push heroku HEAD:master');
    assert.equal(out.status, 0, out.stderr);
    const sha = git(f.repo, 'rev-parse', 'HEAD').slice(0, 7);
    const body = f.card().body;
    assert.match(body, new RegExp(`^## \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} — deployed\\ndeployed ${sha} to heroku \\(remote heroku\\) — on origin/main \\(local tracking ref\\) — repo \\S+\\nCommand: \`git push heroku HEAD:master\``, 'm'));
    assert.doesNotMatch(body, /dirty/);
    assert.deepEqual(lint({ root: f.root, rule: 'deploy-provenance' }).findings, []);
    // a non-deploy command writes nothing
    assert.equal(f.hook('git status').status, 0);
    assert.equal((f.card().body.match(/— deployed/g) || []).length, 1);
  } finally { f.cleanup(); }
});

test('a dirty or unpushed deploy is recorded as such and lint flags it', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.repo, 'app.txt'), 'v2 uncommitted\n');
    fs.writeFileSync(path.join(f.repo, 'new.kt'), 'fun main() {}\n');
    assert.equal(f.hook('adb -s R9PW30DMYXT install -r app.apk').status, 0);
    let body = f.card().body;
    assert.match(body, /deployed [0-9a-f]{7} to android device R9PW30DMYXT — \+dirty: 2 files \(app\.txt, new\.kt\) — on origin\/main \(local tracking ref\) — repo/);
    let findings = lint({ root: f.root, rule: 'deploy-provenance' }).findings;
    assert.equal(findings.length, 1);
    assert.match(findings[0].text, /from a dirty tree \(2 uncommitted files\)/);
    assert.equal(findings[0].severity, 'med');

    // commit locally without pushing: clean tree, but origin does not have it
    git(f.repo, 'add', '-A');
    git(f.repo, 'commit', '-q', '-m', 'v2');
    assert.equal(f.hook('git push heroku HEAD:master').status, 0);
    body = f.card().body;
    assert.match(body, /deployed [0-9a-f]{7} to heroku \(remote heroku\) — not on origin\/main at deploy time \(local tracking ref\) — repo/);
    findings = lint({ root: f.root, rule: 'deploy-provenance' }).findings;
    assert.equal(findings.length, 2, findings.map((item) => item.text).join('\n'));
    assert.ok(findings.some((item) => /is not on origin's default branch/.test(item.text)), findings.map((item) => item.text).join('\n'));
    // pushing origin clears the not-on-origin finding, not the dirty one
    git(f.repo, 'push', '-q', 'origin', 'main');
    findings = lint({ root: f.root, rule: 'deploy-provenance' }).findings;
    assert.equal(findings.length, 1);
    assert.match(findings[0].text, /dirty tree/);
  } finally { f.cleanup(); }
});

test('a failed push lands as a deploy attempt, and a session without a card records nothing', () => {
  const f = fixture();
  try {
    assert.equal(f.hook('git push heroku HEAD:master', { tool_response: { stdout: '', stderr: ' ! [rejected] HEAD -> master (fetch first)\nerror: failed to push some refs' } }).status, 0);
    const body = f.card().body;
    assert.match(body, /— deploy failed\ndeployed [0-9a-f]{7} to heroku/);
    assert.match(body, /treat this as an attempt, not a release/);
    const orphan = spawnSync(process.execPath, [CLI, 'hook', 'post-bash'], {
      encoding: 'utf8', env: f.env, cwd: f.repo,
      input: JSON.stringify({ session_id: 'nobody', cwd: f.repo, tool_name: 'Bash', tool_input: { command: 'git push heroku HEAD:master' }, tool_response: {} }),
    });
    assert.equal(orphan.status, 0);
    assert.match(orphan.stderr, /has no card, so nothing recorded it/);
    assert.equal((f.card().body.match(/^## .* — deploy/gm) || []).length, 1, 'the orphan wrote nothing to the only card');
  } finally { f.cleanup(); }
});
