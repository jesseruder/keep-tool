'use strict';

for (const key of Object.keys(process.env)) {
  if (key.startsWith('KEEP_REVIEWER')) delete process.env[key];
}

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const keep = require('./keep.js');
const { updateSetAside, setAsideCandidates, applySetAside, readSetAside } = require('./serve');
const unblock = require('./unblock');

const CLI = path.join(__dirname, 'keep.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-link-'));
  for (const directory of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1', KEEP_PORT: '1' };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  assert.equal(spawnSync('git', ['init', '-q', '--initial-branch=main', root], { env }).status, 0);
  assert.equal(spawnSync('git', ['-C', root, 'config', 'user.name', 'Keep Test'], { env }).status, 0);
  assert.equal(spawnSync('git', ['-C', root, 'config', 'user.email', 'keep@example.test'], { env }).status, 0);
  return {
    root,
    env,
    run(args, extra = {}) {
      return spawnSync(process.execPath, [CLI, ...args], {
        cwd: root, encoding: 'utf8', env: { ...env, ...extra },
      });
    },
    load(id) { return keep.parseTask(fs.readFileSync(path.join(root, 'tasks', `${id}.md`), 'utf8'), id); },
    loadArchived(id) { return keep.parseTask(fs.readFileSync(path.join(root, 'archive', `${id}.md`), 'utf8'), id); },
    commit() {
      assert.equal(spawnSync('git', ['-C', root, 'add', '-A'], { env }).status, 0);
      assert.equal(spawnSync('git', ['-C', root, 'commit', '-q', '-m', 'fixtures'], { env }).status, 0);
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function writeTask(f, id, options = {}) {
  const task = { id, fm: {
    title: options.title || id,
    status: options.status || 'active',
    kind: 'task',
    tags: ['personal'],
    project: options.project || '',
    check_after: options.checkAfter || '',
    check: options.check || '',
    scheduled_by: options.scheduledBy || '',
    scheduled_at: options.scheduledAt || '',
    scheduled_for: options.scheduledFor || '',
    scheduled_intent: options.scheduledIntent || '',
    sessions: options.sessions || [],
    depends_on: options.dependsOn || [],
    created: '2026-09-10',
    updated: options.updated || '2026-09-10T08:00',
  }, body: options.body || `## 2026-09-10 08:00 — check-in\n${id} state.\n` };
  fs.writeFileSync(path.join(f.root, options.archive ? 'archive' : 'tasks', `${id}.md`), keep.serializeTask(task));
}

function builtSession(f, sid, session = {}) {
  const script = `
    const { buildState } = require('./bin/serve.js');
    const sid = ${JSON.stringify(sid)};
    const state = buildState({
      now: 3000,
      ledger: { updatedAt: 3000, sessions: {} },
      hostPanes: [{ id: 'pane', pid: 123, alive: true, agentAlive: true,
        meta: { sessionId: sid, agent: 'codex', project: '/different/project' } }],
      codexSessionFor: () => (${JSON.stringify({
        kind: 'codex', project: '/different/project', mtime: 1000, size: 10,
        endedTurn: true, lastUserAt: 1000, turnStartedAt: 2000,
        lastAssistantFull: 'Recorded current state.',
        ...session,
      })}),
    });
    process.stdout.write(JSON.stringify(state.sessions.find((entry) => entry.id === sid)));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
    env: { ...f.env, HOME: f.root, KEEP_ALERT_CHANNELS: 'none' },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('link validates explicit identity and reviewer authority before mutating cards', () => {
  const f = fixture();
  try {
    writeTask(f, 'target');
    f.commit();
    const before = fs.readFileSync(path.join(f.root, 'tasks', 'target.md'), 'utf8');
    for (const [args, pattern, env] of [
      [['link', 'target'], /usage: keep link/, {}],
      [['link', 'target', '--session', 'bad/session', '--agent', 'codex'], /session id/, {}],
      [['link', 'target', '--session', 'sid', '--agent', 'other'], /agent must be/, {}],
      [['link', 'missing', '--session', 'sid', '--agent', 'codex'], /no task/, {}],
      [['link', 'target', '--session', 'sid', '--agent', 'codex'], /fleet reviewer cannot link/, { KEEP_REVIEWER: '1' }],
    ]) {
      const result = f.run(args, env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, pattern);
      assert.equal(fs.readFileSync(path.join(f.root, 'tasks', 'target.md'), 'utf8'), before);
    }
  } finally { f.cleanup(); }
});

test('link transfers the explicit session without using caller identity or changing card state', async () => {
  const f = fixture();
  try {
    const sid = 'sid01a08e61-e58a-7552-b8f3-1112c4a87aa2';
    writeTask(f, 'credits', { archive: true, status: 'done', sessions: [{ id: sid, agent: 'codex', at: '2026-09-10T07:00' }] });
    writeTask(f, 'stale-active', { sessions: [{ id: sid, agent: 'codex', at: '2026-09-10T07:30' }] });
    writeTask(f, 'detach', {
      status: 'waiting', project: '/different/project',
      checkAfter: '2026-09-12T09:00', check: 'Verify npm setup.', scheduledBy: 'scheduler-session',
      scheduledAt: '2026-09-10T08:00:00.000Z', scheduledFor: '2026-09-12T09:00', scheduledIntent: 'waiting',
    });
    writeTask(f, 'npm-setup', { status: 'blocked', body: [
      '## Plan',
      '- [ ] Install remaining fonts',
      '- [x] Trust project scripts',
      '- [x] Run package install',
      '- [ ] Workflow verified',
      '',
      '## 2026-09-10 08:00 — check-in',
      'npm setup remains blocked only on fonts.',
      '',
    ].join('\n') });
    f.commit();
    const wait = f.run(['wait-on', 'detach', 'npm-setup#4'], { CODEX_THREAD_ID: sid });
    assert.equal(wait.status, 0, wait.stderr);
    assert.match(wait.stderr, /dependency recorded, but session .* was not linked because the current directory is outside the card project/);
    assert.match(wait.stderr, new RegExp(`keep link detach --session ${sid} --agent codex`));
    assert.equal(f.loadArchived('credits').fm.sessions[0].id, sid, 'cross-project wait-on must not steal ownership');
    assert.equal(f.load('stale-active').fm.sessions[0].id, sid);
    const before = f.load('detach');

    const result = f.run(['link', 'detach', '--session', sid, '--agent', 'codex'], {
      CODEX_THREAD_ID: 'different-caller',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`detach linked to codex session ${sid}`));
    assert.deepEqual(f.loadArchived('credits').fm.sessions || [], []);
    assert.deepEqual(f.load('stale-active').fm.sessions || [], []);
    assert.equal(fs.existsSync(path.join(f.root, 'tasks', 'credits.md')), false, 'archived owner must stay archived');
    const linked = f.load('detach');
    assert.deepEqual(linked.fm.sessions.map((session) => [session.id, session.agent]), [[sid, 'codex']]);
    for (const field of ['status', 'check_after', 'check', 'scheduled_by', 'scheduled_at', 'scheduled_for', 'scheduled_intent', 'updated']) {
      assert.equal(linked.fm[field], before.fm[field], field);
    }
    assert.equal(linked.body, before.body);
    assert.equal(fs.existsSync(path.join(f.root, '.keep', 'panes')), false, 'link must not launch a pane');

    const waitingSession = builtSession(f, sid);
    assert.equal(waitingSession.taskId, 'detach');
    assert.deepEqual(waitingSession.activity.background.dependencies, ['npm-setup#4']);
    const candidates = (session) => setAsideCandidates([], [session]);
    const aside = updateSetAside({ key: sid, kind: 'dependency' }, candidates(waitingSession), { root: f.root, now: 2000 });
    const store = readSetAside(f.root);
    assert.deepEqual(applySetAside(candidates(waitingSession), { store, now: 3000, write: false }).value.items[sid], aside);

    // Once the separate scheduled check is cleared, dependency resolution routes
    // through the ownership link repaired above.
    linked.fm.check_after = '';
    linked.fm.check = '';
    const upstream = f.load('npm-setup');
    upstream.body = upstream.body.replace('- [ ] Workflow verified', '- [x] Workflow verified');
    upstream.fm.updated = '2026-09-10T09:00';
    fs.writeFileSync(path.join(f.root, 'tasks', 'npm-setup.md'), keep.serializeTask(upstream));
    fs.writeFileSync(path.join(f.root, 'tasks', 'detach.md'), keep.serializeTask(linked));
    const resolvedSession = builtSession(f, sid);
    assert.equal(resolvedSession.taskId, 'detach');
    assert.deepEqual(resolvedSession.activity.background.dependencies, []);
    assert.equal(applySetAside(candidates(resolvedSession), {
      store, now: 3000, write: false,
    }).value.items[sid], undefined, 'completed milestone restores the session to the queue');
    unblock.writePending(linked, upstream, { root: f.root, dependency: 'npm-setup#4', step: 4 });
    let deliveredTo;
    await unblock.sweep({ root: f.root, keep, deps: {
      withLock: (fn) => fn(),
      loadTask: (id) => f.load(id),
      loadUpstream: (id) => f.load(id),
      checkinTask: () => {},
      deliver: async (dependent) => {
        deliveredTo = dependent.fm.sessions.map((entry) => entry.id);
        return { sessionId: dependent.fm.sessions[0].id };
      },
    } });
    assert.deepEqual(deliveredTo, [sid]);
  } finally { f.cleanup(); }
});

test('link commits locally without pushing from a manual shell', () => {
  const f = fixture();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-link-remote-'));
  try {
    writeTask(f, 'target');
    f.commit();
    assert.equal(spawnSync('git', ['init', '-q', '--bare', remote]).status, 0);
    assert.equal(spawnSync('git', ['-C', f.root, 'remote', 'add', 'origin', remote]).status, 0);
    assert.equal(spawnSync('git', ['-C', f.root, 'push', '-q', '-u', 'origin', 'main']).status, 0);
    const before = spawnSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).stdout.trim();
    const result = f.run(['link', 'target', '--session', 'manual-session', '--agent', 'claude'], {
      KEEP_NO_PUSH: '', KEEP_ALLOW_PUSH: '1',
    });
    assert.equal(result.status, 0, result.stderr);
    const local = spawnSync('git', ['-C', f.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    assert.notEqual(local, before, 'link creates its local metadata commit');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    const after = spawnSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(after, before, 'manual link must not push');
  } finally {
    f.cleanup();
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('quietly resolving an owner question restores the existing scheduled handoff', () => {
  const f = fixture();
  try {
    const sid = 'scheduled-session';
    writeTask(f, 'scheduled', {
      status: 'waiting', sessions: [{ id: sid, agent: 'codex', at: '2026-09-10T07:00' }],
      checkAfter: '2099-01-01', check: 'Verify the rollout.', scheduledBy: sid,
      scheduledAt: new Date(2500).toISOString(), scheduledFor: '2099-01-01', scheduledIntent: 'waiting',
    });
    f.commit();
    const reviewDir = path.join(f.root, '.keep', 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    const questionsFile = path.join(reviewDir, '_questions.json');
    fs.writeFileSync(questionsFile, JSON.stringify([{ id: 'q-owner', status: 'open', to: 'owner', question: 'Stale?',
      from: { sessionId: sid, agent: 'codex' } }]));
    const before = builtSession(f, sid);
    assert.equal(before.ownerQuestion.id, 'q-owner');
    assert.equal(before.activity.decision.rule, 'owner-question');
    const result = f.run(['answer', 'q-owner', '--no-deliver', '-m', 'No longer needed.'], { CODEX_THREAD_ID: 'owner-session' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(questionsFile))[0].status, 'answered');
    const restored = builtSession(f, sid);
    assert.equal(restored.ownerQuestion, null);
    assert.equal(restored.activity.state, 'waiting');
    assert.equal(restored.activity.label, 'Waiting: scheduled check');
    assert.equal(restored.activity.decision.rule, 'conversation-wait');
  } finally { f.cleanup(); }
});
