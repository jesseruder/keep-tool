'use strict';

// The reviewer launcher exports KEEP_REVIEWER* into its shell; tests spawn the CLI
// from process.env, so reviewer-only refusals fired inside them when run from that
// session (17 spurious failures on 2026-09-02). Tests that need reviewer identity set
// it explicitly in their own env object.
for (const k of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[k];

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { fleetSnapshot, renderWho } = require('./who.js');
const { parseWhen } = require('./keep.js');

const CLI = path.join(__dirname, 'keep.js');

function taskText(title, project, status = 'active') {
  return `---\ntitle: ${title}\nstatus: ${status}\nkind: task\nproject: ${project}\ncreated: 2026-09-01\n---\n\n## 2026-09-01 10:00 — check-in\nWorking.\n`;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-who-'));
  for (const dir of ['tasks', 'archive', 'digests']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  return root;
}

function resolveIn(root, arg) {
  const script = `try { process.stdout.write(require(${JSON.stringify(CLI)}).resolveProjectArg(process.argv[1])); } catch (e) { process.stderr.write(e.message); process.exit(1); }`;
  return spawnSync(process.execPath, ['-e', script, arg], {
    encoding: 'utf8', env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' }, cwd: root,
  });
}

test('resolveProjectArg accepts a bare name and rejects ambiguous basenames', () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'tasks', 'one.md'), taskText('One', '/tmp/team-a/ghost-server'));
    assert.equal(resolveIn(root, 'ghost-server').stdout, '/tmp/team-a/ghost-server');
    fs.writeFileSync(path.join(root, 'tasks', 'two.md'), taskText('Two', '/tmp/team-b/ghost-server'));
    const ambiguous = resolveIn(root, 'ghost-server');
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /ambiguous/);
    assert.match(ambiguous.stderr, /team-a\/ghost-server/);
    assert.match(ambiguous.stderr, /team-b\/ghost-server/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resolveProjectArg accepts absolute and tilde paths that exist', () => {
  const root = fixture();
  try {
    const absolute = path.join(root, 'project');
    fs.mkdirSync(absolute);
    assert.equal(resolveIn(root, absolute).stdout, absolute);
    assert.equal(resolveIn(root, '~').stdout, '~');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('parseWhen supports +15m without changing the relative-hour forms', () => {
  const before = Date.now();
  const minute = Date.parse(parseWhen('+15m'));
  const hour = Date.parse(parseWhen('+12h'));
  assert.ok(minute >= before + 14 * 60e3 && minute <= before + 16 * 60e3);
  assert.ok(hour >= before + 11.9 * 3600e3 && hour <= before + 12.1 * 3600e3);
});

test('activeHolds filters released, expired, and other-project records', () => {
  const root = fixture();
  try {
    const dir = path.join(root, '.keep', 'holds');
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const records = [
      { id: 'hold-live', project: '/tmp/a', until: new Date(now + 60e3).toISOString(), released: false },
      { id: 'hold-expired', project: '/tmp/a', until: new Date(now - 60e3).toISOString(), released: false },
      { id: 'hold-released', project: '/tmp/a', until: new Date(now + 60e3).toISOString(), released: 'now' },
      { id: 'hold-other', project: '/tmp/b', until: new Date(now + 60e3).toISOString(), released: false },
    ];
    for (const record of records) fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record));
    const script = `process.stdout.write(JSON.stringify(require(${JSON.stringify(CLI)}).activeHolds('/tmp/a', ${now})))`;
    const out = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' } });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout).map((hold) => hold.id), ['hold-live']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('session-start shows a matching hold and stays silent in another project', () => {
  const root = fixture();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-who-other-'));
  try {
    fs.writeFileSync(path.join(root, 'tasks', 'work.md'), taskText('Work', root));
    const dir = path.join(root, '.keep', 'holds');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'hold-live.json'), JSON.stringify({
      id: 'hold-live', project: root, by: { sessionId: 'abcdefgh1234', agent: 'codex' },
      reason: 'rotate production secret', from: '2026-09-01T10:00', until: new Date(Date.now() + 60e3).toISOString(), released: false,
    }));
    const run = (cwd) => spawnSync(process.execPath, [CLI, 'hook', 'session-start'], {
      encoding: 'utf8', env: { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1' }, cwd,
      input: JSON.stringify({ session_id: 'session-one', cwd }),
    });
    const here = run(root);
    assert.equal(here.status, 0, here.stderr);
    assert.match(here.stdout, /⛔ .* held until .* by codex session abcdefgh: rotate production secret/);
    assert.doesNotMatch(run(other).stdout, /⛔/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('fleetSnapshot and renderWho include every section and the short session id', () => {
  const now = Date.now();
  const project = '/tmp/fleet-project';
  const tasks = [
    { id: 'card-a', fm: { project, status: 'active', title: 'Alpha', sessions: [], check_after: new Date(now - 60e3).toISOString(), check: 'inspect the deploy' }, body: '## Plan\n- [x] First\n- [ ] Second\n\n## 2026-09-02 10:00 — check-in\nLatest alpha.\n' },
    { id: 'card-b', fm: { project, status: 'waiting', title: 'Beta', sessions: [] }, body: '' },
  ];
  const snapshot = fleetSnapshot(project, {
    tasks,
    sessions: [{ id: 'abcdefgh123456', taskId: 'card-a', project: '/tmp/other', kind: 'codex', state: 'idle', mtime: now - 120e3, endedTurn: true, lastUser: 'working' }],
    runs: [{ id: 'run-one', taskId: 'card-a', status: 'running' }],
    holds: [{ id: 'hold-one', project, until: new Date(now + 60e3).toISOString(), released: false, reason: 'quiet', by: { agent: 'claude', sessionId: 'holdsid123' } }],
    git: { available: false }, now,
  });
  const text = renderWho(snapshot);
  for (const heading of ['cards:', 'sessions:', 'scheduled:', 'runs:', 'holds:', 'git: unavailable']) assert.match(text, new RegExp(heading));
  assert.match(text, /abcdefgh/);
  assert.match(text, /card-a/);
  assert.match(text, /card-b/);
  assert.equal(snapshot.cards[0].next, '2/2 Second');
  assert.match(text, /next: 2\/2 Second/);
});
