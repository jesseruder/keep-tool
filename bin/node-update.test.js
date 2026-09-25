'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { updateSelf, describeUpdate } = require('./node-update.js');
const { commands } = require('./commands/nodes.js');

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

// An origin, a clone of it standing in for a node's ~/keep-tool, and a second
// clone that lands on origin the way another machine would.
function repos(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-node-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, 'origin.git');
  const lander = path.join(dir, 'lander');
  const node = path.join(dir, 'node');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  execFileSync('git', ['clone', '-q', origin, lander]);
  fs.writeFileSync(path.join(lander, 'a.txt'), 'one\n');
  git(lander, 'add', '.'); git(lander, 'commit', '-qm', 'one'); git(lander, 'push', '-q', 'origin', 'HEAD:master');
  execFileSync('git', ['clone', '-q', origin, node]);
  const land = (text) => {
    fs.writeFileSync(path.join(lander, 'a.txt'), text);
    git(lander, 'commit', '-qam', text.trim()); git(lander, 'push', '-q', 'origin', 'HEAD:master');
    return git(lander, 'rev-parse', 'HEAD');
  };
  return { origin, lander, node, land };
}

test('a clean checkout on the default branch fast-forwards to origin, and is current after', async (t) => {
  const { node, land } = repos(t);
  const before = git(node, 'rev-parse', 'HEAD');
  const target = land('two\n');
  land('three\n');
  const result = await updateSelf({ checkout: node });
  assert.equal(result.status, 'updated');
  assert.equal(result.before, before);
  assert.equal(result.after, git(node, 'rev-parse', 'HEAD'));
  assert.equal(result.commits, 2);
  assert.notEqual(result.after, target);
  assert.equal(fs.readFileSync(path.join(node, 'a.txt'), 'utf8'), 'three\n');
  assert.equal((await updateSelf({ checkout: node })).status, 'current');
  assert.match(describeUpdate('aws1', result), /^aws1: fast-forwarded \w{12} → \w{12} \(2 commits\)$/);
  assert.equal(result.hostChanged, false, 'nothing the host runs moved, so it need not reload');
});

test('only a change to the host or a helper only it loads calls for a host reload', () => {
  const { hostCodeChanged } = require('./node-update.js');
  assert.equal(hostCodeChanged(['bin/host.js']), true);
  assert.equal(hostCodeChanged(['docs/x.md', 'bin/node-stats.js']), true);
  assert.equal(hostCodeChanged(['bin/node-update.js']), true);
  assert.equal(hostCodeChanged(['bin/keep.js', 'web/app/app.js', 'bin/turn-index.js']), false);
  assert.equal(hostCodeChanged([]), false);
});

test('two asks at once share one run', async (t) => {
  const { node, land } = repos(t);
  land('two\n');
  const [first, second] = await Promise.all([updateSelf({ checkout: node }), updateSelf({ checkout: node })]);
  assert.equal(first, second);
  assert.equal(first.status, 'updated');
});

test('a checkout someone is working in is left exactly as it is', async (t) => {
  const { node, land } = repos(t);
  land('two\n');
  fs.writeFileSync(path.join(node, 'a.txt'), 'local edit\n');
  const dirty = await updateSelf({ checkout: node });
  assert.deepEqual([dirty.status, dirty.reason], ['refused', 'has uncommitted changes']);
  assert.equal(fs.readFileSync(path.join(node, 'a.txt'), 'utf8'), 'local edit\n');
  git(node, 'checkout', '-q', '--', 'a.txt');

  fs.writeFileSync(path.join(node, 'scratch.txt'), 'untracked\n');
  assert.equal((await updateSelf({ checkout: node })).status, 'updated', 'an untracked file is not somebody\'s change to the code');

  git(node, 'checkout', '-q', '-b', 'experiment');
  land('three\n');
  const branch = await updateSelf({ checkout: node });
  assert.deepEqual([branch.status, branch.reason], ['refused', 'on experiment, not master']);
  git(node, 'checkout', '-q', 'master');

  fs.writeFileSync(path.join(node, 'b.txt'), 'mine\n');
  git(node, 'add', 'b.txt'); git(node, 'commit', '-qm', 'local');
  const diverged = await updateSelf({ checkout: node });
  assert.deepEqual([diverged.status, diverged.reason], ['refused', 'has commits origin/master does not']);
  assert.match(describeUpdate('aws1', diverged), /^aws1: left alone, its checkout has commits origin\/master does not$/);
});

test('keep nodes update asks every other node, and says which were left behind', async (t) => {
  const registry = require('./node-registry.js');
  const original = registry.listNodes;
  registry.listNodes = () => [{ name: 'main', daemon: true }, { name: 'aws1' }, { name: 'old' }, { name: 'down' }];
  t.after(() => { registry.listNodes = original; });
  const asked = [];
  const connect = async ({ node }) => {
    if (node === 'down') throw new Error('ECONNREFUSED');
    return {
      descriptor: { updateSelf: node === 'aws1' ? 1 : undefined },
      async request(type, params) {
        asked.push([node, type, params]);
        return { status: 'updated', before: 'a'.repeat(40), after: 'b'.repeat(40), commits: 3, reloading: params.reload };
      },
      close() {},
    };
  };
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(String(line));
  const exitCode = process.exitCode;
  try { await commands.nodes(['update'], { connect }); }
  finally { console.log = log; }
  assert.equal(process.exitCode, 1, 'a node left behind is a non-zero exit');
  process.exitCode = exitCode;
  assert.deepEqual(asked, [['aws1', 'update-self', { reload: true }]], 'never the daemon node, and never an old host');
  assert.deepEqual(lines, [
    'aws1: fast-forwarded aaaaaaaaaaaa → bbbbbbbbbbbb (3 commits); host reloading, sessions kept',
    'old: its host predates update-self: run `git -C ~/keep-tool pull --ff-only && keep host reload` there once',
    'down: unreachable: ECONNREFUSED',
  ]);
});
