'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { updateSelf, updateRegistry, updateNode, describeUpdate } = require('./node-update.js');
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
  assert.match(describeUpdate('aws1', result), /^aws1: fast-forwarded \w{12} → \w{12} \(2 commits\); registry: not offered by its host$/);
  assert.equal(result.hostChanged, false, 'nothing the host runs moved, so it need not reload');
});

test('only a change to the host or a helper only it loads calls for a host reload', () => {
  const { hostCodeChanged } = require('./node-update.js');
  assert.equal(hostCodeChanged(['bin/host.js']), true);
  assert.equal(hostCodeChanged(['docs/x.md', 'bin/node-stats.js']), true);
  assert.equal(hostCodeChanged(['bin/node-update.js']), true);
  assert.equal(hostCodeChanged(['bin/keep.js', 'web/app/app.js', 'bin/turn-index.js']), false);
  assert.equal(hostCodeChanged([]), false);
  assert.match(describeUpdate('aws1', { status: 'updated', before: 'a', after: 'b', commits: 1, bootChanged: true }),
    /\(1 commit\); host-boot\.js changed, so the host service there needs a restart to run it; registry: not offered by its host$/);
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
  assert.match(describeUpdate('aws1', diverged), /^aws1: left alone, its checkout has commits origin\/master does not; registry: not offered by its host$/);
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
    'aws1: fast-forwarded aaaaaaaaaaaa → bbbbbbbbbbbb (3 commits); host reloading, sessions kept; registry: not offered by its host',
    'old: its host predates update-self: run `git -C ~/keep-tool pull --ff-only && keep host reload` there once',
    'down: unreachable: ECONNREFUSED',
  ]);
});

// A node's registry clone the way one is attached: `git init -b main`, then
// `git remote add` and an upstream, so there is no origin/HEAD to go by.
const NODE_ENV = { KEEP_NODE_NAME: 'box', KEEP_DAEMON_NODE: 'laptop' };
function registryRepos(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-node-registry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, 'origin.git');
  const lander = path.join(dir, 'lander');
  const node = path.join(dir, 'keep');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, lander]);
  git(lander, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(lander, 'card.md'), 'one\n');
  git(lander, 'add', '.'); git(lander, 'commit', '-qm', 'one'); git(lander, 'push', '-q', 'origin', 'HEAD:main');
  execFileSync('git', ['init', '-q', '-b', 'main', node]);
  git(node, 'remote', 'add', 'origin', origin);
  git(node, 'fetch', '-q', 'origin');
  // A recent git's fetch records origin/HEAD by itself; a clone attached this way
  // on an older one has none, and that is the case to cover.
  try { git(node, 'remote', 'set-head', 'origin', '-d'); } catch {}
  git(node, 'reset', '-q', '--hard', 'origin/main');
  git(node, 'branch', '-q', '--set-upstream-to=origin/main');
  const land = (text) => {
    fs.writeFileSync(path.join(lander, 'card.md'), text);
    git(lander, 'commit', '-qam', text.trim()); git(lander, 'push', '-q', 'origin', 'HEAD:main');
    return git(lander, 'rev-parse', 'HEAD');
  };
  return { node, land };
}

test('a node registry clone fast-forwards on the branch it tracks, with no origin/HEAD', async (t) => {
  const { node, land } = registryRepos(t);
  assert.throws(() => git(node, 'symbolic-ref', 'refs/remotes/origin/HEAD'), 'the fixture has no origin/HEAD');
  const before = git(node, 'rev-parse', 'HEAD');
  land('two\n');
  const target = land('three\n');
  const result = await updateRegistry({ registry: node, env: NODE_ENV });
  assert.deepEqual(result, { status: 'updated', checkout: node, before, after: target, branch: 'main', commits: 2 });
  assert.equal(fs.readFileSync(path.join(node, 'card.md'), 'utf8'), 'three\n');
  assert.deepEqual(await updateRegistry({ registry: node, env: NODE_ENV }),
    { status: 'current', checkout: node, before: target, after: target, branch: 'main' });
  // KEEP_DIR is where it looks when not told.
  assert.equal((await updateRegistry({ env: { ...NODE_ENV, KEEP_DIR: node } })).status, 'current');
});

test('a registry clone someone touched is refused and left exactly as it is', async (t) => {
  const { node, land } = registryRepos(t);
  land('two\n');
  fs.writeFileSync(path.join(node, 'card.md'), 'local edit\n');
  const dirty = await updateRegistry({ registry: node, env: NODE_ENV });
  assert.deepEqual([dirty.status, dirty.reason, dirty.branch], ['refused', 'has uncommitted changes', 'main']);
  assert.equal(fs.readFileSync(path.join(node, 'card.md'), 'utf8'), 'local edit\n');
  git(node, 'checkout', '-q', '--', 'card.md');

  fs.mkdirSync(path.join(node, '.keep'));
  fs.writeFileSync(path.join(node, '.keep', 'state.json'), '{}\n');
  assert.equal((await updateRegistry({ registry: node, env: NODE_ENV })).status, 'updated', 'untracked runtime state is not a change');

  land('three\n');
  git(node, 'checkout', '-q', '--detach');
  const detached = await updateRegistry({ registry: node, env: NODE_ENV });
  assert.deepEqual([detached.status, detached.reason], ['refused', 'on a detached HEAD']);
  git(node, 'checkout', '-q', 'main');

  fs.writeFileSync(path.join(node, 'other.md'), 'mine\n');
  git(node, 'add', 'other.md'); git(node, 'commit', '-qm', 'local');
  const local = await updateRegistry({ registry: node, env: NODE_ENV });
  assert.deepEqual([local.status, local.reason], ['refused', 'has commits origin/main does not']);
  assert.equal(git(node, 'log', '-1', '--format=%s'), 'local', 'nothing was reset');

  git(node, 'branch', '-q', '--unset-upstream');
  try { git(node, 'remote', 'set-head', 'origin', '-d'); } catch {}
  const loose = await updateRegistry({ registry: node, env: NODE_ENV });
  assert.deepEqual([loose.status, loose.reason], ['refused', 'has no upstream for main']);
});

test('the daemon node never pulls its own registry', async (t) => {
  const { node, land } = registryRepos(t);
  const before = git(node, 'rev-parse', 'HEAD');
  land('two\n');
  for (const env of [{ KEEP_DAEMON_NODE: 'laptop' }, { KEEP_NODE_NAME: 'laptop', KEEP_DAEMON_NODE: 'laptop' }, {}]) {
    const result = await updateRegistry({ registry: node, env });
    assert.deepEqual([result.status, result.reason], ['refused', 'the daemon node\'s registry is the daemon\'s own']);
  }
  // The host passes the name it answers as, and that decides.
  assert.equal((await updateRegistry({ registry: node, env: NODE_ENV, node: 'laptop' })).status, 'refused');
  const unparsed = await updateRegistry({ registry: node, env: { KEEP_NODE_NAME: 'Not A Name', KEEP_DAEMON_NODE: 'laptop' } });
  assert.match(unparsed.reason, /^cannot tell which node this is: /);
  assert.equal(git(node, 'rev-parse', 'HEAD'), before);
});

test('update-self reports the registry beside the code, and a registry failure changes nothing about the code', async (t) => {
  const code = repos(t);
  const reg = registryRepos(t);
  code.land('two\n');
  reg.land('two\n');
  const both = await updateNode({ code: { checkout: code.node }, registry: { registry: reg.node, env: NODE_ENV } });
  assert.equal(both.result.status, 'updated');
  assert.equal(both.result.hostChanged, false);
  assert.equal(both.registry.status, 'updated');
  assert.equal(both.registry.commits, 1);
  assert.equal('hostChanged' in both.registry, false, 'a registry change never calls for a reload');

  code.land('three\n');
  const broken = await updateNode({ code: { checkout: code.node }, registry: { get env() { throw new Error('boom'); } } });
  assert.equal(broken.result.status, 'updated');
  assert.equal(broken.result.commits, 1);
  assert.deepEqual(broken.registry, { status: 'refused', reason: 'could not be updated: boom' });
});

test('describeUpdate says what became of the registry', () => {
  const code = { status: 'current', after: 'c'.repeat(40) };
  assert.equal(describeUpdate('box', { ...code, registry: { status: 'updated', commits: 370 } }), 'box: already at cccccccccccc; registry: updated 370 commits');
  assert.equal(describeUpdate('box', { ...code, registry: { status: 'updated', commits: 1 } }), 'box: already at cccccccccccc; registry: updated 1 commit');
  assert.equal(describeUpdate('box', { ...code, registry: { status: 'current' } }), 'box: already at cccccccccccc; registry: current');
  assert.equal(describeUpdate('box', { ...code, registry: { status: 'refused', reason: 'has uncommitted changes' } }),
    'box: already at cccccccccccc; registry: refused (has uncommitted changes)');
  assert.equal(describeUpdate('box', code), 'box: already at cccccccccccc; registry: not offered by its host');
  assert.equal(describeUpdate('box', { error: 'unreachable: ECONNREFUSED' }), 'box: unreachable: ECONNREFUSED');
});

test('keep nodes update exits non-zero when only a registry was left behind, and --json carries it', async (t) => {
  const registry = require('./node-registry.js');
  const original = registry.listNodes;
  registry.listNodes = () => [{ name: 'laptop', daemon: true }, { name: 'box' }];
  t.after(() => { registry.listNodes = original; });
  const reply = { status: 'current', before: 'a'.repeat(40), after: 'a'.repeat(40), reloading: false,
    registry: { status: 'refused', reason: 'has uncommitted changes', branch: 'main' } };
  const connect = async () => ({ descriptor: { updateSelf: 1, updateRegistry: 1 }, async request() { return reply; }, close() {} });
  const run = async (argv) => {
    const lines = [];
    const log = console.log;
    const exitCode = process.exitCode;
    console.log = (line) => lines.push(String(line));
    let code;
    try { await commands.nodes(argv, { connect }); }
    finally { console.log = log; code = process.exitCode; process.exitCode = exitCode; }
    return { lines, code };
  };
  const text = await run(['update']);
  assert.equal(text.code, 1);
  assert.deepEqual(text.lines, ['box: already at aaaaaaaaaaaa; registry: refused (has uncommitted changes)']);
  const json = await run(['update', '--json']);
  assert.equal(json.code, 1);
  assert.deepEqual(JSON.parse(json.lines[0]), [{ node: 'box', ...reply }]);
});

// A registry clone that git answers for, on a clock the fetch and merge-base move.
function stubbedRegistry({ fetchMs = 0, mergeBaseMs = 0, mergeMs = 0 } = {}) {
  let clock = 1_000_000;
  const calls = [];
  const before = 'a'.repeat(40);
  const target = 'b'.repeat(40);
  const answers = {
    'rev-parse --abbrev-ref HEAD': 'main', 'rev-parse HEAD': before,
    'config --get branch.main.remote': 'origin', 'config --get branch.main.merge': 'refs/heads/main',
    'rev-parse --absolute-git-dir': '/nonexistent/.git', 'rev-parse FETCH_HEAD': target, 'rev-list --count': '2',
  };
  const git = async (args, timeoutMs) => {
    calls.push({ step: args[0], timeoutMs, at: clock });
    if (args[0] === 'fetch') clock += fetchMs;
    if (args[0] === 'merge-base') clock += mergeBaseMs;
    if (args[0] === 'merge') clock += mergeMs;
    const key = Object.keys(answers).find((prefix) => args.join(' ').startsWith(prefix));
    return key ? answers[key] : '';
  };
  const update = () => updateRegistry({ registry: path.join(os.tmpdir(), `keep-stub-registry-${calls.length}-${Math.random()}`),
    env: NODE_ENV, git, now: () => clock, exists: () => false });
  return { calls, update, before, target };
}

test('a registry update stops before a step it has no time left for, and never starts a merge late', async () => {
  // A fetch that takes the whole 40 s: the next step is not started, nothing merges.
  const slow = stubbedRegistry({ fetchMs: 41e3 });
  const late = await slow.update();
  assert.deepEqual([late.status, late.reason, late.before, late.branch],
    ['refused', 'ran out of time before git rev-parse; will be tried again next update', slow.before, 'main']);
  assert.equal(slow.calls.find((call) => call.step === 'fetch').timeoutMs, 40e3, 'the fetch is capped by the deadline');
  assert.equal(slow.calls.some((call) => call.step === 'merge'), false);

  // Under a second left once the ancestry check is done: the merge is not started.
  const tight = stubbedRegistry({ fetchMs: 38.5e3, mergeBaseMs: 600 });
  const close = await tight.update();
  assert.deepEqual([close.status, close.reason, close.target],
    ['refused', 'ran out of time before git merge; will be tried again next update', tight.target]);
  assert.equal(tight.calls.find((call) => call.step === 'rev-parse' && call.at > 1_000_000).timeoutMs, 1.5e3,
    'each call gets what is left, not its own timeout');
  assert.equal(tight.calls.some((call) => call.step === 'merge'), false);

  // A merge started in time gets its full timeout, and the update reports what it did.
  const merged = stubbedRegistry({ fetchMs: 35e3, mergeMs: 5e3 });
  const done = await merged.update();
  assert.deepEqual([done.status, done.commits], ['updated', 2]);
  assert.equal(merged.calls.find((call) => call.step === 'merge').timeoutMs, 15e3);
  assert.equal(merged.calls.find((call) => call.step === 'rev-list').timeoutMs, 1e3, 'a read after the merge still gets a second');
});

test('the code update keeps its own timeouts, with no deadline', async (t) => {
  const { node, land } = repos(t);
  land('two\n');
  const seen = [];
  const { execFileSync: run } = require('node:child_process');
  const result = await updateSelf({ checkout: node, now: () => { throw new Error('the code update reads no clock'); },
    git: async (args, timeoutMs) => { seen.push([args[0], timeoutMs]); return run('git', ['-C', node, ...args], { encoding: 'utf8' }).trim(); } });
  assert.equal(result.status, 'updated');
  assert.deepEqual(seen.find(([step]) => step === 'fetch'), ['fetch', 30e3]);
  assert.ok(seen.filter(([step]) => step !== 'fetch').every(([, ms]) => ms === 15e3));
});
