'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const keep = require('./keep-core.js');

function card(id) {
  return keep.serializeTask({ id, fm: {
    title: id, status: 'active', kind: 'task', tags: ['personal'], project: '',
    created: '2026-09-21', updated: '2026-09-21T08:00',
  }, body: `## 2026-09-21 08:00 — check-in\n${id} state.\n` });
}

function registry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-core-scope-'));
  for (const dir of ['tasks', 'archive']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q', '--initial-branch=main', root]).status, 0);
  for (const [key, value] of [['user.name', 'Keep Test'], ['user.email', 'keep@example.test']]) {
    assert.equal(spawnSync('git', ['-C', root, 'config', key, value]).status, 0);
  }
  return root;
}

test('an explicit scope answers from another registry while the default scope stays on this one', () => {
  const other = registry();
  try {
    fs.mkdirSync(path.join(keep.ROOT, 'tasks'), { recursive: true });
    const homeCard = path.join(keep.ROOT, 'tasks', 'home-card.md');
    fs.writeFileSync(homeCard, card('home-card'));
    fs.writeFileSync(path.join(other, 'tasks', 'other-card.md'), card('other-card'));

    assert.deepEqual(keep.loadAll(false).map((task) => task.id), ['home-card']);
    assert.deepEqual(keep.loadAll(true, { root: other }).map((task) => task.id), ['other-card']);
    assert.equal(keep.taskPath('other-card', other), path.join(other, 'tasks', 'other-card.md'));
    assert.deepEqual(keep.paths(other), {
      root: other,
      tasks: path.join(other, 'tasks'),
      archive: path.join(other, 'archive'),
      meta: path.join(other, '.keep'),
      lock: path.join(other, '.keep', 'lock'),
      holds: path.join(other, '.keep', 'holds'),
    });

    const homeBytes = fs.readFileSync(homeCard, 'utf8');
    const linked = keep.linkSession('other-card', { id: 'sid-scoped', agent: 'codex' }, { scope: { root: other } });
    assert.deepEqual(linked, { linked: 'sid-scoped', agent: 'codex' });

    const [task] = keep.loadAll(false, { root: other });
    assert.equal(task.fm.sessions[0].id, 'sid-scoped');
    assert.equal(task.fm.sessions[0].agent, 'codex');
    assert.equal(fs.readFileSync(homeCard, 'utf8'), homeBytes, 'the default registry is untouched');
    assert.equal(fs.existsSync(path.join(keep.ROOT, '.keep', 'lock')), false, 'the lock was taken where the work happened');
    assert.equal(spawnSync('git', ['-C', other, 'log', '--oneline'], { encoding: 'utf8' }).stdout.trim().endsWith('keep: link other-card'), true);

    // No argument still means this process, here, now.
    const scope = keep.scopeFor();
    assert.equal(scope.root, keep.ROOT);
    assert.equal(scope.cwd, process.cwd());
    assert.equal(scope.env, process.env);
    assert.equal(scope.identity, null);
    assert.equal(keep.scopeFor({ root: other, identity: { id: 'sid-scoped', agent: 'codex' } }).root, other);
    assert.deepEqual(keep.currentSession({ identity: { id: 'sid-scoped', agent: 'codex' } }),
      { id: 'sid-scoped', agent: 'codex' });
    assert.deepEqual(keep.currentSession({ env: { CLAUDE_CODE_SESSION_ID: 'sid-env' } }), { id: 'sid-env', agent: 'claude' });
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
    fs.rmSync(path.join(keep.ROOT, 'tasks'), { recursive: true, force: true });
  }
});

test('a scoped recordSession records the identity the scope names, in the registry it names', () => {
  const other = registry();
  try {
    fs.writeFileSync(path.join(other, 'tasks', 'scoped-card.md'), card('scoped-card'));
    const scope = { root: other, env: { CLAUDE_CODE_SESSION_ID: 'sid-process' },
      identity: { id: 'sid-identity', agent: 'codex' } };

    const task = keep.loadTask('scoped-card', other);
    const result = keep.recordSession(task, scope);
    assert.deepEqual(result, { linked: true, skipped: null, session: { id: 'sid-identity', agent: 'codex' } });
    assert.equal(task.fm.sessions[0].id, 'sid-identity', 'the identity, not the process session, owns the card');
    assert.equal(task.fm.sessions[0].agent, 'codex');
    // Its ownership and its check-in marker went to the scoped registry, not this one.
    assert.equal(fs.existsSync(path.join(other, '.keep', 'checkins', 'sid-identity')), true);
    assert.equal(fs.existsSync(path.join(keep.ROOT, '.keep', 'checkins', 'sid-identity')), false);

    // Without an identity, a scope with no session of its own has nobody to record.
    const bare = keep.loadTask('scoped-card', other);
    assert.deepEqual(keep.recordSession(bare, { root: other, env: {} }),
      { linked: false, skipped: 'no-session', session: null });
    assert.equal((bare.fm.sessions || []).length, 0);
  } finally { fs.rmSync(other, { recursive: true, force: true }); }
});

test('a moved session keeps its place on its card: only the entry\'s node changes', () => {
  const other = registry();
  try {
    const sessions = [
      { id: 'sid-first', agent: 'claude', at: '2026-09-20T08:00' },
      { id: 'sid-moving', agent: 'claude', at: '2026-09-21T09:00' },
      { id: 'sid-last', agent: 'codex', at: '2026-09-21T10:00' },
    ];
    const task = keep.parseTask(card('moving-card'), 'moving-card');
    task.fm.sessions = sessions.map((entry) => ({ ...entry }));
    fs.writeFileSync(path.join(other, 'tasks', 'moving-card.md'), keep.serializeTask(task));
    const scope = { root: other };
    const read = () => keep.loadTask('moving-card', other).fm.sessions;

    assert.deepEqual(keep.relinkSessionNode('moving-card', 'sid-moving', 'aws1', scope), { relinked: 'sid-moving', node: 'aws1', changed: true });
    assert.deepEqual(read(), [sessions[0], { ...sessions[1], node: 'aws1' }, sessions[2]], 'order and at unchanged, node set');
    const log = () => spawnSync('git', ['-C', other, 'log', '--format=%s'], { encoding: 'utf8' }).stdout.trim().split('\n');
    assert.deepEqual(log(), ['keep: move moving-card']);
    assert.equal(fs.existsSync(path.join(other, '.keep', 'card-usage')), false, 'no ownership was recorded');

    // Asked again, nothing changes; back on the daemon node the entry carries no node.
    assert.equal(keep.relinkSessionNode('moving-card', 'sid-moving', 'aws1', scope).changed, false);
    assert.deepEqual(keep.relinkSessionNode('moving-card', 'sid-moving', 'main', scope), { relinked: 'sid-moving', node: null, changed: true });
    assert.deepEqual(read(), sessions);
    assert.equal(log().length, 2);
    assert.equal(keep.relinkSessionNode('moving-card', 'sid-unknown', 'aws1', scope), null);
    assert.equal(keep.relinkSessionNode('missing-card', 'sid-moving', 'aws1', scope), null);
    assert.throws(() => keep.relinkSessionNode('moving-card', 'sid-moving', 'AWS 1', scope), /invalid node name/);
  } finally { fs.rmSync(other, { recursive: true, force: true }); }
});

test('a card names the agent its checks run as, and only a usable name is accepted', () => {
  const task = { id: 'daily-review', fm: { title: 'Daily review', status: 'waiting' } };
  keep.applyCardAgent(task, undefined);
  assert.equal(task.fm.agent, undefined, 'an unset flag leaves the card alone');
  keep.applyCardAgent(task, ' redash-daily ');
  assert.equal(task.fm.agent, 'redash-daily');
  assert.throws(() => keep.applyCardAgent(task, 'Not A Name'), /usable agent name/);
  assert.throws(() => keep.applyCardAgent(task, 'fleet-reviewer'), /the fleet reviewer/);
  // With no incidents config the one area is `default`, whose responder is `default`.
  assert.throws(() => keep.applyCardAgent(task, 'default'), /default area's incident responder/);
  assert.equal(task.fm.agent, 'redash-daily', 'a refused name changes nothing');
  keep.applyCardAgent(task, '');
  assert.equal(task.fm.agent, undefined, 'an empty value clears it');
});

test('a test process with no registry of its own refuses to load against the operator\'s ~/keep', () => {
  const core = path.join(__dirname, 'keep-core.js');
  const load = (env) => spawnSync(process.execPath, ['-e', `require(${JSON.stringify(core)}); process.stdout.write('loaded')`],
    { encoding: 'utf8', env: { ...process.env, ...env } });
  const clean = { ...process.env };
  delete clean.KEEP_DIR;
  const home = os.userInfo().homedir;
  const refused = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(core)}); process.stdout.write('loaded')`],
    { encoding: 'utf8', env: { ...clean, NODE_TEST_CONTEXT: 'child', HOME: home } });
  assert.notEqual(refused.status, 0, 'under node --test with no KEEP_DIR the operator\'s registry is refused');
  assert.match(refused.stderr, /a test process would use the operator's registry/);
  assert.equal(refused.stdout, '');
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-core-guard-'));
  try {
    const withDir = load({ NODE_TEST_CONTEXT: 'child', KEEP_DIR: own, HOME: home });
    assert.equal(withDir.status, 0, withDir.stderr);
    assert.equal(withDir.stdout, 'loaded', 'its own KEEP_DIR is fine');
    const tempHome = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(core)}); process.stdout.write('loaded')`],
      { encoding: 'utf8', env: { ...clean, NODE_TEST_CONTEXT: 'child', HOME: own } });
    assert.equal(tempHome.status, 0, tempHome.stderr);
    assert.equal(tempHome.stdout, 'loaded', 'a registry under a temporary HOME is not the operator\'s');
    // The setup tests run `keep init --dir` with a fresh KEEP_CONFIG that does not exist
    // yet and the real HOME: isolated from the operator's configuration, so allowed.
    const ownConfig = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(core)}); process.stdout.write('loaded')`],
      { encoding: 'utf8', env: { ...clean, NODE_TEST_CONTEXT: 'child', HOME: home, KEEP_CONFIG: path.join(own, 'config.json') } });
    assert.equal(ownConfig.status, 0, ownConfig.stderr);
    assert.equal(ownConfig.stdout, 'loaded', 'a process on its own configuration file is not on the operator\'s');
    // A symlink to the operator's registry is the operator's registry.
    const alias = path.join(own, 'alias');
    fs.symlinkSync(path.join(home, 'keep'), alias);
    const viaAlias = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(core)}); process.stdout.write('loaded')`],
      { encoding: 'utf8', env: { ...clean, NODE_TEST_CONTEXT: 'child', HOME: home, KEEP_DIR: alias } });
    if (fs.existsSync(path.join(home, 'keep'))) {
      assert.notEqual(viaAlias.status, 0, 'a symlink alias of the operator\'s registry is refused');
      assert.match(viaAlias.stderr, /operator's registry/);
    }
  } finally { fs.rmSync(own, { recursive: true, force: true }); }
});
