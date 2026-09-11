'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const orphans = require('./orphan-agents');
const row = { pid: 123, ppid: 1, uid: 500, tty: '??', started: 'Thu Sep 10 20:00:00 2026', command: '/Users/me/.local/bin/codex --dangerously-bypass-approvals-and-sandbox' };
function fixture() {
  const state = { rows: [{ ...row }], panes: [], ledger: { sessions: {} }, jobs: [], files: { cwd: '/repo', names: ['/repo', '/dev/null'] } };
  const killed = [];
  const deps = { uid: 500, processes: async () => state.rows, panes: async () => state.panes,
    ledger: async () => state.ledger, companion: async () => ({ known: true, complete: true, jobs: state.jobs }),
    files: async () => state.files, kill: (pid, signal) => killed.push([pid, signal]) };
  return { state, deps, killed };
}
test('recognition only accepts an interactive agent executable, without age heuristics', () => {
  assert.equal(orphans.agentKind(row.command), 'codex');
  assert.equal(orphans.agentKind('/bin/claude --dangerously-skip-permissions'), 'claude');
  for (const command of ['sh -c codex', 'node /x/agent-launcher.js codex /bin/codex', '/bin/codex exec work',
    '/bin/codex review', '/bin/codex app-server', '/bin/claude -p hi', '/bin/claude --print',
    '/bin/codex resume known', '/bin/claude --resume known', '/bin/claude -c --dangerously-skip-permissions',
    '/bin/claude --continue', '/bin/codex -c --resume known', '/bin/codex unknown-command']) {
    assert.equal(orphans.agentKind(command), null, command);
  }
  const parsed = orphans.parseRows(' 123 1 500 ?? Thu Sep 10 20:00:00 2026 /bin/codex');
  assert.equal(parsed[0].started, row.started);
});
test('reaps a confirmed orphan independently of process age, and dry run sends nothing', async () => {
  const f = fixture();
  assert.equal((await orphans.list(f.deps)).agents[0].pid, 123);
  assert.deepEqual((await orphans.reap({ dry: true, deps: f.deps })).killed, [123]);
  assert.deepEqual(f.killed, []);
  assert.deepEqual((await orphans.reap({ deps: f.deps })).killed, [123]);
  assert.deepEqual(f.killed, [[123, 'SIGTERM']]);
});
test('live work, session ownership, and uncertain evidence all protect an old TUI', async () => {
  const cases = [
    f => f.state.rows[0].ppid = 55,
    f => f.state.rows[0].uid = 501,
    f => f.state.rows.push({ pid: 222, ppid: 123 }),
    f => f.state.panes.push({ pid: 123, alive: true }),
    f => { f.state.rows[0].tty = 'ttys005'; f.state.rows.push({ pid: 9, tty: 'ttys005' }); f.state.panes.push({ pid: 9, alive: true }); },
    f => f.state.ledger.sessions.scheduled = { pid: 123 },
    f => f.state.files.names.push('/Users/me/.codex/sessions/rollout-live.jsonl'),
    f => f.state.files.names.push('/Users/me/.claude/projects/repo/conversation.jsonl'),
    f => f.state.jobs.push({ pid: 99, status: 'running' }),
    f => f.deps.panes = async () => { throw Error('host unavailable'); },
    f => f.deps.companion = async () => ({ known: false }),
    f => f.deps.files = async () => { throw Error('cannot inspect'); },
  ];
  for (const change of cases) {
    const f = fixture(); change(f);
    await orphans.reap({ deps: f.deps });
    assert.deepEqual(f.killed, [], String(change));
  }
});
test('revalidation protects reused PIDs, late panes, and new child work', async () => {
  for (const field of ['started', 'ppid', 'child', 'pane']) {
    const f = fixture(); let calls = 0;
    f.deps.processes = async () => {
      if (++calls === 2) {
        if (field === 'started') f.state.rows[0].started = 'different';
        if (field === 'ppid') f.state.rows[0].ppid = 2;
        if (field === 'child') f.state.rows.push({ pid: 456, ppid: 123 });
        if (field === 'pane') f.state.panes.push({ pid: 123, alive: true });
      }
      return structuredClone(f.state.rows);
    };
    await orphans.reap({ deps: f.deps });
    assert.deepEqual(f.killed, [], field);
  }
});
test('codex-jobs integration still inspects orphans when companion discovery is absent', async () => {
  const f = fixture();
  const jobs = require('./codexjobs');
  const deps = { includeAgents: true, agentDeps: f.deps, jobs: [], discoveryKnown: false, psOutput: '' };
  assert.equal((await jobs.list(deps)).orphanAgents.agents.length, 1);
  assert.deepEqual((await jobs.reap({ deps })).killed, [123]);
});
test('stalled sweep includes and scopes orphan agents without treating old linked sessions as orphaned', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-orphan-sweep-'));
  const f = fixture(); let only;
  try {
    const result = await require('./stalled').sweep({ root, includeAgents: true, jobs: [], brokers: [], psOutput: '',
      deps: { listOrphanAgents: async () => orphans.list(f.deps), reapOrphanAgents: async request => {
        only = request.only; return { killed: [], skipped: [] };
      } } });
    assert.deepEqual([...only], [123]);
    assert.equal(result.items[0].kind, 'orphan-agent');
    assert.match(require('./stalled').render(result.items), /Orphan codex pid 123/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
