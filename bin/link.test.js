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
const { activity } = require('./session-status');
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
  fs.writeFileSync(path.join(f.root, 'tasks', `${id}.md`), keep.serializeTask(task));
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
    writeTask(f, 'credits', { status: 'done', sessions: [{ id: sid, agent: 'codex', at: '2026-09-10T07:00' }] });
    writeTask(f, 'detach', {
      status: 'waiting', project: '/different/project', dependsOn: ['npm-setup'],
      checkAfter: '2026-09-12T09:00', check: 'Verify npm setup.', scheduledBy: 'scheduler-session',
      scheduledAt: '2026-09-10T08:00:00.000Z', scheduledFor: '2026-09-12T09:00', scheduledIntent: 'waiting',
    });
    writeTask(f, 'npm-setup');
    f.commit();
    const wait = f.run(['wait-on', 'detach', 'npm-setup'], { CODEX_THREAD_ID: sid });
    assert.equal(wait.status, 0, wait.stderr);
    assert.match(wait.stderr, /dependency recorded, but session .* was not linked because the current directory is outside the card project/);
    assert.match(wait.stderr, new RegExp(`keep link detach --session ${sid} --agent codex`));
    assert.equal(f.load('credits').fm.sessions[0].id, sid, 'cross-project wait-on must not steal ownership');
    const before = f.load('detach');

    const result = f.run(['link', 'detach', '--session', sid, '--agent', 'codex'], {
      CODEX_THREAD_ID: 'different-caller',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`detach linked to codex session ${sid}`));
    assert.deepEqual(f.load('credits').fm.sessions || [], []);
    const linked = f.load('detach');
    assert.deepEqual(linked.fm.sessions.map((session) => [session.id, session.agent]), [[sid, 'codex']]);
    for (const field of ['status', 'check_after', 'check', 'scheduled_by', 'scheduled_at', 'scheduled_for', 'scheduled_intent', 'updated']) {
      assert.equal(linked.fm[field], before.fm[field], field);
    }
    assert.equal(linked.body, before.body);
    assert.equal(fs.existsSync(path.join(f.root, '.keep', 'panes')), false, 'link must not launch a pane');

    const session = { id: sid, kind: 'codex', taskId: 'detach', mtime: 1000,
      activity: { background: { dependencies: ['npm-setup'] } } };
    const candidates = (changes = {}) => setAsideCandidates([], [{ ...session, ...changes }]);
    const aside = updateSetAside({ key: sid, kind: 'dependency' }, candidates(), { root: f.root, now: 2000 });
    const store = readSetAside(f.root);
    assert.deepEqual(applySetAside(candidates(), { store, now: 3000, write: false }).value.items[sid], aside);
    assert.equal(applySetAside(candidates({ activity: { background: { dependencies: ['replacement'] } } }), {
      store, now: 3000, write: false,
    }).value.items[sid], undefined, 'changed dependency restores the session to the queue');

    // Once the separate scheduled check is cleared, dependency resolution routes
    // through the ownership link repaired above.
    linked.fm.check_after = '';
    linked.fm.check = '';
    const upstream = f.load('npm-setup');
    upstream.fm.status = 'done';
    upstream.fm.updated = '2026-09-10T09:00';
    fs.writeFileSync(path.join(f.root, 'tasks', 'npm-setup.md'), keep.serializeTask(upstream));
    unblock.writePending(linked, upstream, { root: f.root, dependency: 'npm-setup' });
    let deliveredTo;
    fs.writeFileSync(path.join(f.root, 'tasks', 'detach.md'), keep.serializeTask(linked));
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
    const session = { id: sid, kind: 'codex', pane: 'pane', alive: true, endedTurn: true, lastUserAt: 1000,
      turnStartedAt: 2000, ownerQuestion: { question: 'Stale?', at: 2400 },
      lastAssistantFull: 'Recorded the scheduled check.' };
    assert.equal(activity(session, { task: f.load('scheduled').fm, now: 3000 }).decision.rule, 'owner-question');
    const result = f.run(['answer', 'q-owner', '--no-deliver', '-m', 'No longer needed.'], { CODEX_THREAD_ID: 'owner-session' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(questionsFile))[0].status, 'answered');
    const restored = activity({ ...session, ownerQuestion: null }, { task: f.load('scheduled').fm, now: 3000 });
    assert.equal(restored.state, 'waiting');
    assert.equal(restored.label, 'Waiting: scheduled check');
    assert.equal(restored.decision.rule, 'conversation-wait');
  } finally { f.cleanup(); }
});
