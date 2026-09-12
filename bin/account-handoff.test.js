'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const accounts = require('./accounts');
const artifacts = require('./account-artifacts');
const jobs = require('./background-jobs');
const handoff = require('./account-handoff');

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-handoff-'));
  const root = path.join(base, 'registry'); fs.mkdirSync(root);
  const profiles = Object.fromEntries(['one', 'two', 'three', 'codex'].map((id) => [id, path.join(base, id)]));
  for (const value of Object.values(profiles)) fs.mkdirSync(value, { recursive: true });
  const config = path.join(base, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
    { id: 'one', label: 'One', agent: 'claude', configDir: profiles.one },
    { id: 'two', label: 'Two', agent: 'claude', configDir: profiles.two },
    { id: 'three', label: 'Three', agent: 'claude', configDir: profiles.three },
    { id: 'codex-work', label: 'Codex', agent: 'codex', configDir: profiles.codex },
  ], defaultAccounts: { claude: 'one', codex: 'codex-work' } }));
  const env = { KEEP_CONFIG: config, KEEP_DIR: root };
  const sid = 'session-123', projectName = '-repo', project = path.join(base, 'repo'); fs.mkdirSync(project);
  const sourceProject = path.join(profiles.one, 'projects', projectName); fs.mkdirSync(path.join(sourceProject, sid, 'tool-results'), { recursive: true });
  fs.writeFileSync(path.join(sourceProject, `${sid}.jsonl`), '{"type":"summary","summary":"compacted"}\n');
  fs.writeFileSync(path.join(sourceProject, sid, 'tool-results', 'call.txt'), 'tool result');
  fs.mkdirSync(path.join(profiles.one, 'file-history', sid), { recursive: true });
  fs.writeFileSync(path.join(profiles.one, 'file-history', sid, 'edit.txt'), 'edit');
  accounts.pinSession(sid, 'claude', 'one', { root, env });
  return { base, root, env, profiles, sid, project, projectName };
}

function deps(f, overrides = {}) {
  const pane = { id: 'pane-1', pid: 10, alive: true, cwd: f.project, cols: 80, rows: 24,
    meta: { sessionId: f.sid, accountId: 'one', agent: 'claude', model: 'claude-opus-4-1' } };
  let continuations = 0;
  const baseHost = { request: async (type, params) => {
    assert.equal(type, 'replace-exited');
    pane.alive = true; pane.pid = 20; pane.meta = { ...pane.meta, ...params.meta, accountId: 'two' };
    return { pane };
  } };
  return { root: f.root, env: f.env, pane,
    inspect: async () => ({ session: { id: f.sid, kind: 'claude', project: f.project, endedTurn: true }, pane,
      processArgs: 'claude --dangerously-skip-permissions --resume session-123', currentModel: 'claude-opus-4-1' }),
    authPreflight: async () => true,
    compatible: () => ({ ok: true, reasons: [], mcpConfig: path.join(f.base, 'mcp.json') }),
    rebindLedger: () => ({ rebound: [{ sessionId: f.sid, reused: false }] }),
    host: baseHost,
    restartSession: async (_body, options) => {
      pane.alive = false;
      return options.host.request('replace-exited', { meta: { sessionId: f.sid, accountId: options.resumeAccount.id } });
    },
    waitForAccountRecord: async (_sid, _pane, accountId, after) => ({ pane: 'pane-1', accountId, startedAt: after + 1 }),
    resumeExited: async () => ({ ok: true, pane: 'pane-1', pid: 20 }),
    continueSession: async () => { continuations++; },
    continuations: () => continuations,
    ...overrides,
  };
}

test('auth preflight resolves Claude in a login shell and reapplies managed credential isolation afterward', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-handoff-auth-'));
  try {
    const home = path.join(base, 'home'), fakeBin = path.join(base, 'login-bin');
    const configDir = path.join(base, 'claude-secondary'), capture = path.join(base, 'capture.json');
    for (const dir of [home, fakeBin, configDir]) fs.mkdirSync(dir, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    fs.writeFileSync(fakeClaude, `#!${process.execPath}\n` +
      `const fs=require('node:fs');\n` +
      `fs.writeFileSync(process.env.AUTH_CAPTURE, JSON.stringify({path:process.env.PATH,configDir:process.env.CLAUDE_CONFIG_DIR,` +
      `secureDir:process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,apiKey:process.env.ANTHROPIC_API_KEY,` +
      `oauth:process.env.CLAUDE_CODE_OAUTH_TOKEN,baseUrl:process.env.ANTHROPIC_BASE_URL}));\n` +
      `process.stdout.write(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',` +
      `configDirectory:process.env.CLAUDE_CONFIG_DIR,projectsDirectory:process.env.CLAUDE_CONFIG_DIR+'/projects',` +
      `organizationId:'synthetic',subscriptionType:'synthetic',email:'synthetic@example.invalid'},null,2));\n`, { mode: 0o755 });
    const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
    fs.writeFileSync(path.join(home, '.zshrc'), [
      `export PATH=${shellQuote(`${fakeBin}:/usr/bin:/bin`)}`,
      'export ANTHROPIC_API_KEY=rc-api-key',
      'export CLAUDE_CODE_OAUTH_TOKEN=rc-oauth',
      'export ANTHROPIC_BASE_URL=https://rc.invalid',
      'export CLAUDE_CONFIG_DIR=/wrong/from/rc',
      'echo startup-banner',
    ].join('\n') + '\n');
    const account = { id: 'secondary', label: 'Secondary', agent: 'claude', configDir, managed: true, builtIn: false };
    const env = { ...process.env, HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin', AUTH_CAPTURE: capture,
      ANTHROPIC_API_KEY: 'inherited-api-key', CLAUDE_CODE_OAUTH_TOKEN: 'inherited-oauth', ANTHROPIC_BASE_URL: 'https://inherited.invalid' };
    assert.equal(await handoff.authPreflight(account, { env }), true);
    const seen = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.equal(seen.path.startsWith(`${fakeBin}:`), true, 'the login shell supplied Claude on a sparse daemon PATH');
    assert.equal(seen.configDir, configDir);
    assert.equal(seen.secureDir, configDir);
    assert.equal(seen.apiKey, undefined);
    assert.equal(seen.oauth, undefined);
    assert.equal(seen.baseUrl, undefined);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('auth preflight kills a login-shell process group when startup exceeds its deadline', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-handoff-auth-timeout-'));
  let childPid = null;
  try {
    const home = path.join(base, 'home'), pidFile = path.join(base, 'startup-child.pid');
    const configDir = path.join(base, 'claude-secondary');
    fs.mkdirSync(home); fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(home, '.zshrc'), `/bin/sleep 30 &\nprint $! > '${pidFile}'\nwait\n`);
    const account = { id: 'secondary', label: 'Secondary', agent: 'claude', configDir, managed: true, builtIn: false };
    const env = { ...process.env, HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin' };
    const started = Date.now();
    assert.equal(await handoff.authPreflight(account, { env, authTimeoutMs: 250 }), false);
    assert.ok(Date.now() - started < 2000, 'interactive shell startup remains bounded');
    childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    const alive = () => { try { process.kill(childPid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(alive(), false, 'the startup descendant is killed with its owned process group');
  } finally {
    if (childPid) try { process.kill(childPid, 'SIGKILL'); } catch {}
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('explicit handoff moves one conversation across three-account infrastructure and continues once', async () => {
  const f = fixture();
  try {
    const d = deps(f);
    let rebound = false;
    d.rebindLedger = (sessionId, source, target, transactionId, options) => {
      assert.equal(sessionId, f.sid); assert.equal(source.id, 'one'); assert.equal(target.id, 'two');
      assert.ok(transactionId); assert.ok(options.sourceStopVerifiedAt);
      assert.equal(d.pane.alive, false, 'source is stopped before the ledger moves');
      assert.equal(accounts.forSession(f.sid, 'claude', { root: f.root, env: f.env }).id, 'one',
        'source authority remains active until rebind completes');
      assert.equal(fs.existsSync(path.join(f.profiles.two, 'projects', f.projectName, `${f.sid}.jsonl`)), true,
        'verified artifacts are installed before ledger rebind');
      rebound = true;
    };
    const baseRequest = d.host.request;
    d.host.request = async (...args) => { assert.equal(rebound, true, 'target starts only after ledger rebind'); return baseRequest(...args); };
    const result = await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d);
    assert.equal(result.status, 'done');
    assert.equal(accounts.forSession(f.sid, 'claude', { root: f.root, env: f.env }).id, 'two');
    assert.equal(d.continuations(), 1);
    const target = path.join(f.profiles.two, 'projects', f.projectName);
    assert.equal(fs.readFileSync(path.join(target, `${f.sid}.jsonl`), 'utf8').includes('compacted'), true);
    assert.equal(fs.readFileSync(path.join(target, f.sid, 'tool-results', 'call.txt'), 'utf8'), 'tool result');
    assert.equal(fs.readFileSync(path.join(f.profiles.two, 'file-history', f.sid, 'edit.txt'), 'utf8'), 'edit');
    assert.equal(fs.existsSync(path.join(f.profiles.one, 'projects', f.projectName, `${f.sid}.jsonl`)), true, 'source backup remains');
    assert.equal(handoff.list(f.root)[0].configDir, undefined);
    const repeated = await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d);
    assert.equal(repeated.status, 'done');
    assert.equal(d.continuations(), 1, 'retries after success are idempotent');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('busy refusal and failed target preflight leave source running and authoritative', async () => {
  const f = fixture();
  try {
    const d = deps(f, { authPreflight: async () => false, restartSession: async () => assert.fail('must not stop source') });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /not logged in/);
    assert.equal(d.pane.alive, true);
    assert.equal(accounts.forSession(f.sid, 'claude', { root: f.root, env: f.env }).id, 'one');
    assert.equal(fs.existsSync(path.join(f.profiles.two, 'projects', f.projectName, `${f.sid}.jsonl`)), false);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('actual restart busy refusal leaves source live and does not copy artifacts', async () => {
  const f = fixture();
  try {
    const d = deps(f, { restartSession: async () => { const error = new Error('Waiting for the turn and background work to finish'); error.status = 409; throw error; } });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /Waiting for the turn/);
    assert.equal(d.pane.alive, true);
    assert.equal(accounts.forSession(f.sid, 'claude', { root: f.root, env: f.env }).id, 'one');
    assert.equal(fs.existsSync(path.join(f.profiles.two, 'projects', f.projectName, `${f.sid}.jsonl`)), false);
    d.pane.alive = false;
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /Source exit was not verified/,
      'an unrelated source crash cannot bypass the restart ledger refusal');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('copy-before-launch failure is recoverable without a duplicate owner or duplicate continuation', async () => {
  const f = fixture();
  try {
    let first = true;
    const d = deps(f, { restartSession: async (_body, options) => {
      d.pane.alive = false;
      await options.host.request('replace-exited', { meta: { sessionId: f.sid } });
      if (first) { first = false; d.pane.alive = false; d.pane.pid = 10; throw new Error('target launch failed'); }
      return { ok: true };
    } });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /target launch failed/);
    assert.throws(() => accounts.forSession(f.sid, 'claude', { root: f.root, env: f.env }), /unfinished account handoff/);
    const journalFile = path.join(f.root, '.keep', 'account-handoffs', `${f.sid}.json`);
    const interrupted = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    interrupted.status = 'starting';
    interrupted.pid = 10;
    fs.writeFileSync(journalFile, JSON.stringify(interrupted));
    d.pane.pid = 20;
    d.inspect = async () => ({ session: { id: f.sid, kind: 'claude', project: f.project }, pane: d.pane, processArgs: '' });
    d.resumeExited = async (entry) => {
      assert.equal(entry.pid, 20, 'the transaction-marked replacement pid is adopted after a crash before journal persistence');
      return { ok: true, pane: 'pane-1', pid: 30 };
    };
    const recovered = await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d);
    assert.equal(recovered.status, 'done');
    assert.equal(d.continuations(), 1);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('recovery catches up final Claude exit rows without a daemon poll before retry', async () => {
  const f = fixture();
  try {
    const source = path.join(f.profiles.one, 'projects', f.projectName, `${f.sid}.jsonl`);
    const initial = { type: 'assistant', sessionId: f.sid, timestamp: new Date(1000).toISOString(),
      message: { content: [], stop_reason: 'end_turn' } };
    fs.writeFileSync(source, JSON.stringify(initial) + '\n');
    jobs.sync({ root: f.root, agent: 'claude', sid: f.sid, file: source, now: 1100,
      instance: { id: 'pane-1:10:11', processScoped: true, live: true } });
    const d = deps(f);
    d.restartSession = async (_body, options) => {
      d.pane.alive = false;
      const exitRows = [
        { type: 'file-history-snapshot', sessionId: f.sid, timestamp: new Date(1200).toISOString(), snapshot: {} },
        { type: 'last-prompt', sessionId: f.sid, timestamp: new Date(1210).toISOString(), prompt: '/exit' },
        { type: 'cost-state', sessionId: f.sid, timestamp: new Date(1220).toISOString(), costUSD: 0 },
        { type: 'user', isMeta: true, sessionId: f.sid, timestamp: new Date(1230).toISOString(),
          message: { content: '<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>' } },
        { type: 'user', isMeta: true, sessionId: f.sid, timestamp: new Date(1240).toISOString(),
          message: { content: '<local-command-stdout>Goodbye!</local-command-stdout>' } },
      ];
      fs.appendFileSync(source, exitRows.map(JSON.stringify).join('\n') + '\n');
      jobs.recordHook(f.root, 'claude', f.sid, { event: 'Stop', entity: 'turn', at: 1250,
        offset: fs.statSync(source).size });
      return options.host.request('replace-exited', { meta: { sessionId: f.sid, accountId: options.resumeAccount.id } });
    };
    d.rebindLedger = () => { throw new Error('simulated daemon exit before ledger rebind'); };
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /simulated daemon exit/);
    const stale = JSON.parse(fs.readFileSync(path.join(f.root, '.keep/background-jobs/claude', f.sid, 'state.json')));
    assert.ok(stale.checkpoint.offset < fs.statSync(source).size, 'the exited source is not daemon-polled before recovery');
    assert.equal(stale.source.file, path.resolve(source));

    delete d.rebindLedger;
    const result = await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d);
    assert.equal(result.status, 'done');
    assert.equal(d.continuations(), 1);
    const target = path.join(f.profiles.two, 'projects', f.projectName, `${f.sid}.jsonl`);
    const rebound = JSON.parse(fs.readFileSync(path.join(f.root, '.keep/background-jobs/claude', f.sid, 'state.json')));
    assert.equal(rebound.source.file, path.resolve(target));
    assert.equal(rebound.checkpoint.offset, fs.statSync(target).size);
    assert.equal(rebound.restart.completed, true);
    assert.equal(rebound.gap, false); assert.equal(rebound.recovering, false);
    assert.equal(accounts.forSession(f.sid, 'claude', { root: f.root, env: f.env }).id, 'two');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('verification failure keeps target transcript updates and recovery does not recopy or relaunch', async () => {
  const f = fixture();
  try {
    let verify = false, launches = 0;
    const d = deps(f, {
      restartSession: async (_body, options) => {
        launches++;
        d.pane.alive = false;
        const result = await options.host.request('replace-exited', { meta: { sessionId: f.sid, accountId: 'two' } });
        fs.appendFileSync(path.join(f.profiles.two, 'projects', f.projectName, `${f.sid}.jsonl`), '{"type":"assistant","message":{"content":"target update"}}\n');
        return result;
      },
      waitForAccountRecord: async (_sid, _pane, accountId, after) => verify ? ({ pane: 'pane-1', accountId, startedAt: after + 1 }) : null,
    });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /identity was not verified/);
    const journalFile = path.join(f.root, '.keep', 'account-handoffs', `${f.sid}.json`);
    const interrupted = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    interrupted.status = 'verifying';
    fs.writeFileSync(journalFile, JSON.stringify(interrupted));
    verify = true;
    const recovered = await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d);
    assert.equal(recovered.status, 'done');
    assert.equal(launches, 1);
    assert.match(fs.readFileSync(path.join(f.profiles.two, 'projects', f.projectName, `${f.sid}.jsonl`), 'utf8'), /target update/);
    assert.equal(d.continuations(), 1);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('durable delivery recovery never repeats an ambiguous continuation on a dead target pane', async () => {
  const f = fixture();
  try {
    let sends = 0;
    const d = deps(f, { continueSession: async () => { sends++; throw new Error('daemon stopped after submission'); } });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /daemon stopped/);
    assert.equal(sends, 1);
    assert.throws(() => accounts.forSession(f.sid, 'claude', { root: f.root, env: f.env }), /unfinished account handoff/);
    const journalFile = path.join(f.root, '.keep', 'account-handoffs', `${f.sid}.json`);
    const interrupted = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    interrupted.status = 'delivering';
    fs.writeFileSync(journalFile, JSON.stringify(interrupted));
    d.pane.alive = false;
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /will not be sent twice/);
    assert.equal(sends, 1);
    assert.throws(() => accounts.forSession(f.sid, 'claude', { root: f.root, env: f.env }), /unfinished account handoff/);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('durable matching delivery receipt completes authority without resending after a daemon crash', async () => {
  const f = fixture();
  try {
    let sends = 0;
    const d = deps(f, { continueSession: async () => { sends++; throw new Error('daemon stopped after accepted submission'); } });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /daemon stopped/);
    const journalFile = path.join(f.root, '.keep', 'account-handoffs', `${f.sid}.json`);
    const interrupted = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    interrupted.status = 'delivering';
    fs.writeFileSync(journalFile, JSON.stringify(interrupted));
    accounts.commitStaged(f.sid, interrupted.id, { root: f.root });
    d.pane.alive = false;
    d.deliveryStatus = async (sessionId, text, deliveryId) => {
      assert.equal(sessionId, f.sid); assert.match(text, /Continue the work/); assert.equal(deliveryId, interrupted.deliveryId);
      return { sessionId: f.sid, kind: 'claude', received: true, pending: false };
    };
    const recovered = await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d);
    assert.equal(recovered.status, 'done');
    assert.equal(sends, 1, 'a receipt finalizes the transaction without another continuation');
    assert.equal(accounts.forSession(f.sid, 'claude', { root: f.root, env: f.env }).id, 'two');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('same-account and cross-provider targets are refused before stopping', async () => {
  const f = fixture();
  try {
    const d = deps(f);
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'one' }, d), /same/);
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'codex-work' }, d), /verified only for Claude/);
    assert.equal(d.pane.alive, true);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('custom settings, tool aliases, and restricted mode are refused before source exit', async () => {
  const f = fixture();
  try {
    for (const flag of ['--settings custom.json', '--tools Read', '--allowed-tools Read', '--disallowed-tools', '--restricted',
      '--mcp-config custom.json', '--safe-mode', '--bare', '--unknown-option']) {
      const d = deps(f);
      d.inspect = async () => ({ session: { id: f.sid, kind: 'claude', project: f.project }, pane: d.pane,
        processArgs: `claude ${flag} --resume ${f.sid}` });
      await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /custom permission configuration/);
      assert.equal(d.pane.alive, true);
    }
    const reviewer = deps(f);
    reviewer.inspect = async () => ({ session: { id: f.sid, kind: 'claude', project: f.project }, pane: reviewer.pane,
      processArgs: `claude --settings '${JSON.stringify(require('./reviewer-launch').REVIEWER_SETTINGS)}' --resume ${f.sid}` });
    const result = await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, reviewer);
    assert.equal(result.status, 'done', 'the exact generated reviewer settings are reproducible');
    assert.equal(handoff.permissionClass(`claude --mcp-config '${path.join(f.base, 'managed mcp.json')}' --resume ${f.sid}`,
      { mcpConfig: path.join(f.base, 'managed mcp.json') }), 'restricted', 'the exact generated managed MCP path is reproducible');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a concurrent request for another target is rejected instead of joining the transaction', async () => {
  const f = fixture();
  try {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const d = deps(f, { authPreflight: async () => gate });
    const first = handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'three' }, d), /different account handoff/);
    release(true);
    await first;
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});
