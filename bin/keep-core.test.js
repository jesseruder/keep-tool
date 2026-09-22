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
