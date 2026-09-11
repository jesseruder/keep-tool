'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { run } = require('./force-restart');
function fixture() {
  const entry = { sessionId: 's', pane: 'p', pid: 10, token: 'unique' };
  let pane = { id: 'p', pid: 10, alive: true, cwd: '/tmp', cols: 80, rows: 24, meta: { sessionId: 's', agent: 'codex' } };
  let rows = [{ pid: 10, ppid: 1, pidStart: 'shell' }, { pid: 11, ppid: 10, pidStart: 'agent', agent: 'codex', interactive: true, args: 'codex resume s' },
    { pid: 12, ppid: 11, pidStart: 'helper', args: 'helper' }];
  const phases = [], signals = []; let closes = 0, replaces = 0;
  const deps = {
    getPane: async () => pane, rows: async () => rows, save: async () => phases.push(entry.phase), sleep: async () => {},
    identifyOriginal: async () => ({ pid: 11, pidStart: 'agent', primary: true }),
    close: async () => { assert.equal(entry.phase, 'closing'); assert.ok(entry.processes); closes++; pane.alive = false; rows = rows.filter(p => p.pid === 12).map(p => ({ ...p, ppid: 1, args: 'changed during exit' })); },
    signal: async (pid, signal) => { signals.push({ pid, signal }); rows = rows.filter(p => p.pid !== pid); },
    sessionLive: async () => false,
    replace: async () => { replaces++; pane = { ...pane, pid: 20, alive: true, meta: { ...pane.meta, forceRestartToken: entry.token } }; return { ok: true, pane: 'p', pid: 20, sessionId: 's' }; },
  };
  return { entry, deps, phases, signals, pane: () => pane, rows: r => { rows = r; }, closes: () => closes, replaces: () => replaces };
}
test('force restart resumes despite mutable exit argv; recovery is persisted before close', async () => {
  const f = fixture(); const result = await run(f.entry, f.deps);
  assert.equal(result.pid, 20); assert.deepEqual(f.signals, [{ pid: 12, signal: 'SIGTERM' }]);
  assert.deepEqual(f.phases, ['prepared', 'closing', 'closed', 'resuming', 'resumed']);
});
test('cleanup failure remains recoverable without repeating close or killing reused PIDs', async () => {
  const f = fixture(), signal = f.deps.signal;
  f.deps.signal = async () => { throw Error('temporary failure'); };
  await assert.rejects(run(f.entry, f.deps), /temporary failure/);
  assert.equal(f.entry.phase, 'closed'); assert.equal(f.closes(), 1);
  f.rows([{ pid: 12, pidStart: 'new instance', args: 'unrelated' }]); f.deps.signal = signal;
  await run(f.entry, f.deps); assert.equal(f.closes(), 1); assert.equal(f.signals.length, 0);
});
test('lost replace acknowledgement recognizes exact token and does not launch twice', async () => {
  const f = fixture(), replace = f.deps.replace;
  f.deps.replace = async () => { await replace(); throw Error('lost reply'); };
  await assert.rejects(run(f.entry, f.deps), /lost reply/);
  await run(f.entry, f.deps); assert.equal(f.replaces(), 1);
});
test('dead replacement can be explicitly recovered with its own PID as CAS target', async () => {
  for (const demote of [false, true]) {
  const f = fixture(), replace = f.deps.replace;
  f.deps.replace = async () => { await replace(); f.pane().alive = false;
    if (demote) f.pane().meta = { agent: 'shell', forceRestartToken: 'unique' }; throw Error('launch exited'); };
  await assert.rejects(run(f.entry, f.deps), /launch exited/);
  f.deps.replace = async (original, job, expectedPid) => { assert.equal(expectedPid, 20); return replace(); };
  await run(f.entry, f.deps); assert.equal(f.replaces(), 2); assert.equal(f.closes(), 1);
  }
});
test('zombies do not block resume; live leftovers and another session instance do', async () => {
  const f = fixture(); f.deps.signal = async () => {};
  await assert.rejects(run(f.entry, f.deps), /Old processes remain/);
  f.rows([{ pid: 12, pidStart: 'helper', zombie: true }]);
  f.deps.sessionLive = async () => true;
  await assert.rejects(run(f.entry, f.deps), /already live/);
  f.deps.sessionLive = async () => false; await run(f.entry, f.deps);
});
test('recovery refuses pane identity replacement', async () => {
  const f = fixture(); f.deps.close = async () => { f.pane().meta.sessionId = 'other'; };
  await assert.rejects(run(f.entry, f.deps), /did not close/);
  await assert.rejects(run(f.entry, f.deps), /Pane changed/);
  assert.equal(f.replaces(), 0);
});
test('permission class comes only from the verified original agent, never a nested agent', async () => {
  const f = fixture(), rows = await f.deps.rows();
  f.rows([...rows, { pid: 13, ppid: 11, pidStart: 'child-agent', agent: 'codex', interactive: true,
    args: 'codex --dangerously-bypass-approvals-and-sandbox resume child' }]);
  await run(f.entry, f.deps); assert.equal(f.entry.original.bypass, false);
  const other = fixture(); other.deps.identifyOriginal = async () => ({ pid: 90, pidStart: 'other', primary: true });
  await assert.rejects(run(other.entry, other.deps), /No verified owned/); assert.equal(other.closes(), 0);
});
test('new descendants of a still-owned helper are captured before cleanup', async () => {
  const f = fixture(), close = f.deps.close;
  f.deps.close = async () => { await close(); f.rows([
    { pid: 12, ppid: 1, pidStart: 'helper' }, { pid: 13, ppid: 12, pidStart: 'late-child' },
  ]); };
  await run(f.entry, f.deps);
  assert.ok(f.entry.processes.some(p => p.pid === 13));
  assert.ok(f.signals.some(p => p.pid === 13));
});
test('same-instance shell demotion remains recoverable and startup failure stays explicit', async () => {
  const f = fixture(), close = f.deps.close;
  f.pane().createdAt = 123;
  f.deps.close = async () => { await close(); f.pane().meta = { agent: 'shell' }; };
  f.deps.replace = async () => { f.pane().pid = 20; f.pane().alive = true;
    f.pane().meta = { agent: 'codex', sessionId: 's', forceRestartToken: 'unique' }; return { pid: 20 }; };
  f.deps.verifyStarted = async () => { throw Error('startup timeout'); };
  await assert.rejects(run(f.entry, f.deps), /startup timeout/);
  await assert.rejects(run(f.entry, f.deps), /startup timeout/);
  f.deps.verifyStarted = async () => {};
  assert.equal((await run(f.entry, f.deps)).pid, 20);
});
test('daemon adapter preserves pane, conversation and permission class for both agents', async () => {
  const { forceRestartSession } = require('./serve');
  for (const agent of ['codex', 'claude']) for (const bypass of [true, false]) for (const demote of [true, false]) {
    const f = fixture(); f.pane().meta.agent = agent;
    const flag = agent === 'codex' ? '--dangerously-bypass-approvals-and-sandbox' : '--dangerously-skip-permissions';
    f.rows([{ pid: 10, ppid: 1, pidStart: 'shell' }, { pid: 11, ppid: 10, pidStart: 'agent',
      agent, interactive: true, args: `${agent} ${bypass ? flag : ''} ${agent === 'codex' ? 'resume' : '--resume'} s` }]);
    let launch, verified = false;
    await forceRestartSession(f.entry, f.deps.save, {
      withInjectionLock: fn => fn(), forceRows: f.deps.rows, sleep: async () => {}, lsof: async () => '',
      closeIdleSession: async () => { f.pane().alive = demote; if (demote) f.pane().meta = { agent: 'shell' }; f.rows([]); },
      waitForHostAgent: async () => { assert.ok(launch); verified = true; },
      host: { request: async (type, params) => {
        if (type === 'hello') return { replaceExited: true };
        if (type === 'get') return { pane: f.pane() };
        if (type === 'kill') { assert.equal(params.pane, 'p'); f.pane().alive = false; return {}; }
        assert.equal(type, 'replace-exited'); launch = params;
        assert.equal(f.pane().alive, false);
        return { pane: { id: 'p', pid: 20 } };
      } },
    });
    assert.equal(launch.paneId, 'p'); assert.equal(launch.expectedPid, 10);
    assert.equal(launch.sessionId, demote ? undefined : 's'); assert.equal(launch.meta.sessionId, 's');
    assert.equal(launch.meta.forceRestartToken, 'unique');
    assert.equal(launch.args[1].includes(flag), bypass); assert.equal(verified, true);
  }
});

test('fresh daemon force restart preflights a pinned managed Claude profile before close', async t => {
  const { forceRestartSession } = require('./serve');
  const accounts = require('./accounts');
  const root = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'keep-force-account-'));
  t.after(() => require('fs').rmSync(root, { recursive: true, force: true }));
  const configDir = require('path').join(root, 'secondary'); require('fs').mkdirSync(configDir);
  const config = require('path').join(root, 'config.json');
  require('fs').writeFileSync(config, JSON.stringify({ version: 1, accounts: [
    { id: 'secondary', label: 'Secondary', agent: 'claude', configDir },
  ], defaultAccounts: { claude: 'secondary' } }));
  const env = { KEEP_DIR: root, KEEP_CONFIG: config };
  accounts.pinSession('s', 'claude', 'secondary', { root, env });
  const f = fixture();
  f.pane().meta = { sessionId: 's', agent: 'claude', accountId: 'secondary' };
  f.rows([{ pid: 10, ppid: 1, pidStart: 'shell' }, { pid: 11, ppid: 10, pidStart: 'agent', agent: 'claude', interactive: true, args: 'claude --resume s' }]);
  let closed = false, launch;
  await forceRestartSession(f.entry, f.deps.save, {
    root, env, withInjectionLock: fn => fn(), forceRows: f.deps.rows, sleep: async () => {}, lsof: async () => '',
    ensureSharedMemory: account => {
      assert.equal(account.id, 'secondary'); assert.equal(closed, false);
      return { mcpConfig: require('path').join(configDir, 'managed.keep-mcp.json') };
    },
    closeIdleSession: async () => { closed = true; f.pane().alive = false; f.rows([]); },
    waitForHostAgent: async () => {},
    host: { request: async (type, params) => {
      if (type === 'hello') return { replaceExited: true };
      if (type === 'get') return { pane: f.pane() };
      if (type === 'kill') { f.pane().alive = false; return {}; }
      assert.equal(type, 'replace-exited'); launch = params; return { pane: { id: 'p', pid: 20 } };
    } },
  });
  assert.equal(closed, true);
  assert.match(launch.args[1], /managed\.keep-mcp\.json/);
  const encodedProfile = /'--profile' '([^']+)'/.exec(launch.args[1])?.[1];
  assert.equal(JSON.parse(Buffer.from(encodedProfile, 'base64url')).id, 'secondary');
});
