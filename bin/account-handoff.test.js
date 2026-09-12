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
  const profiles = Object.fromEntries(['one', 'two', 'three', 'codex', 'codexTwo'].map((id) => [id, path.join(base, id)]));
  for (const value of Object.values(profiles)) fs.mkdirSync(value, { recursive: true });
  const config = path.join(base, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
    { id: 'one', label: 'One', agent: 'claude', configDir: profiles.one },
    { id: 'two', label: 'Two', agent: 'claude', configDir: profiles.two },
    { id: 'three', label: 'Three', agent: 'claude', configDir: profiles.three },
    { id: 'codex-work', label: 'Codex', agent: 'codex', configDir: profiles.codex },
    { id: 'codex-two', label: 'Codex Two', agent: 'codex', configDir: profiles.codexTwo },
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
  const pane = { id: 'pane-1', pid: 10, createdAt: 'source-pane', alive: true, cwd: f.project, cols: 80, rows: 24,
    agentAlive: true,
    meta: { sessionId: f.sid, accountId: 'one', agent: 'claude', model: 'claude-opus-4-1' } };
  let continuations = 0;
  const baseHost = { request: async (type, params) => {
    assert.equal(type, 'replace-exited');
    pane.alive = true; pane.pid = 20; pane.createdAt = 'target-pane';
    pane.meta = { ...pane.meta, ...params.meta, accountId: 'two' };
    return { pane };
  } };
  return { root: f.root, env: f.env, pane,
    inspect: async () => ({ session: { id: f.sid, kind: 'claude', project: f.project, endedTurn: true }, pane,
      processArgs: 'claude --dangerously-skip-permissions --resume session-123', currentModel: 'claude-opus-4-1',
      agentIdentity: pane.meta.accountId === 'two'
        ? { pid: 21, pidStart: 'target-start', primary: true, ownsPane: true }
        : { pid: 11, pidStart: 'source-start', primary: true, ownsPane: true } }),
    authPreflight: async () => true,
    compatible: () => ({ ok: true, reasons: [], mcpConfig: path.join(f.base, 'mcp.json') }),
    rebindLedger: () => ({ rebound: [{ sessionId: f.sid, reused: false }] }),
    host: baseHost,
    restartSession: async (_body, options) => {
      pane.alive = false;
      return options.host.request('replace-exited', { meta: { sessionId: f.sid, accountId: options.resumeAccount.id } });
    },
    waitForAccountRecord: async (_sid, _pane, accountId, after) => ({ pane: 'pane-1', accountId, agent: 'claude', startedAt: after + 1 }),
    resumeExited: async (_entry, _target, _mcpConfig, hooks = {}) => {
      pane.alive = true; pane.pid = 20; pane.createdAt = 'target-pane';
      pane.meta = { ...pane.meta, accountId: 'two', handoffTransactionId: _entry.id };
      const launch = { ok: true, pane: 'pane-1', pid: 20, createdAt: pane.createdAt };
      await hooks.onLaunched?.(launch); return launch;
    },
    continueSession: async () => { continuations++; },
    continuations: () => continuations,
    ...overrides,
  };
}

function codexDeps(f, overrides = {}) {
  const sid = '11111111-1111-4111-8111-111111111111';
  const child = '22222222-2222-4222-8222-222222222222';
  const sourceFile = path.join(f.profiles.codex, 'sessions', `rollout-${sid}.jsonl`);
  const targetFile = path.join(f.profiles.codexTwo, 'sessions', `rollout-${sid}.jsonl`);
  for (const file of [sourceFile, targetFile]) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}\n');
  }
  const plan = { sessionId: sid, artifacts: [
    { sessionId: sid, parentSessionId: null, children: [child], interacted: [], source: sourceFile, target: targetFile },
    { sessionId: child, parentSessionId: sid, children: [], interacted: [],
      source: path.join(f.profiles.codex, 'sessions', `rollout-${child}.jsonl`),
      target: path.join(f.profiles.codexTwo, 'sessions', `rollout-${child}.jsonl`) },
  ] };
  const argv = ['codex', '--sandbox', 'workspace-write', '--ask-for-approval', 'never', '-m', 'gpt-6-astra',
    '-c', 'model_reasoning_effort="high"', 'resume', sid];
  const resumeSpec = { sessionId: sid, cwd: f.project, model: 'gpt-6-astra', effort: 'high', provider: 'openai', argv,
    digest: 'frozen-policy' };
  const pane = { id: 'pane-codex', pid: 30, createdAt: 'codex-source-pane', alive: true, agentAlive: true, cwd: f.project, cols: 100, rows: 30,
    meta: { sessionId: sid, accountId: 'codex-work', agent: 'codex' } };
  accounts.pinSession(sid, 'codex', 'codex-work', { root: f.root, env: f.env });
  const events = []; let preflights = 0;
  const artifactProvider = {
    preflight: () => { preflights++; return plan; },
    copyCodexArtifacts: (_sid, source, target, transactionId, options) => {
      assert.equal(pane.alive, false, 'Codex artifacts copy only after source exit');
      assert.equal(source.id, 'codex-work'); assert.equal(target.id, 'codex-two');
      assert.ok(transactionId); assert.ok(options.sourceStopVerifiedAt);
      events.push('copy'); return plan;
    },
    rebindLedger: (_sid, _source, _target, _transactionId, options) => {
      assert.ok(options.sourceStopVerifiedAt); events.push('rebind');
      return { rebound: plan.artifacts.map((entry) => ({ sessionId: entry.sessionId })) };
    },
  };
  const base = {
    root: f.root, env: f.env, pane, plan, sid, child, argv, events, artifactProvider,
    preflights: () => preflights,
    inspect: async () => ({ session: { id: sid, kind: 'codex', project: f.project, endedTurn: true }, pane,
      processArgs: `codex resume ${sid}`, agentIdentity: pane.meta.accountId === 'codex-two'
        ? { pid: 41, pidStart: 'codex-target-start', primary: true, ownsPane: true, rolloutFile: targetFile }
        : { pid: 31, pidStart: 'codex-source-start', primary: true, ownsPane: true, rolloutFile: sourceFile } }),
    authPreflight: async () => true,
    resumeSpec: () => ({ ...resumeSpec, argv: [...argv] }),
    compatible: (_source, _target, _cwd, spec) => {
      assert.deepEqual(spec.argv, argv); return { ok: true, reasons: [], mcpConfig: null };
    },
    host: { request: async (type, params) => {
      assert.equal(type, 'replace-exited');
      for (const id of [sid, child]) {
        const authority = accounts.authority(f.root)[id];
        assert.equal(authority.accountId, 'codex-work'); assert.equal(authority.stagedAccountId, 'codex-two');
      }
      events.push('launch'); pane.alive = true; pane.pid = 40; pane.createdAt = 'codex-target-pane';
      pane.meta = { ...pane.meta, ...params.meta, accountId: 'codex-two' };
      return { pane };
    } },
    restartSession: async (_body, options) => {
      assert.deepEqual(options.resumeArgv, argv); pane.alive = false;
      await options.host.request('replace-exited', { meta: { sessionId: sid, accountId: 'codex-two' } });
      return { ok: true, pane: pane.id, pid: pane.pid };
    },
    waitForAccountRecord: async (_sid, _pane, accountId, after) => ({ pane: pane.id, accountId, agent: 'codex', startedAt: after + 1 }),
    resumeExited: async (_entry, _target, _mcpConfig, hooks = {}) => {
      events.push('resume-exited'); pane.alive = true; pane.pid = 40; pane.createdAt = 'codex-target-pane';
      pane.meta = { ...pane.meta, accountId: 'codex-two', handoffTransactionId: _entry.id };
      const launch = { ok: true, pane: pane.id, pid: pane.pid, createdAt: pane.createdAt };
      await hooks.onLaunched?.(launch); return launch;
    },
    verifyTargetSpec: async (entry) => { assert.equal(entry.targetTranscript, targetFile); events.push('verify-target'); },
    continueSession: async (_sid, _text, options) => {
      assert.equal(options.agent, 'codex'); assert.equal(options.targetTranscript, targetFile);
      assert.equal(options.targetIdentity.panePid, 40); assert.equal(options.targetIdentity.agentPid, 41);
      assert.equal(events.at(-1), 'verify-target', 'effective target policy is verified before continuation delivery');
      events.push('continue');
    },
    ...overrides,
  };
  return base;
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

test('native Codex handoff preserves exact launch policy and transfers root plus owned child authority', async () => {
  const f = fixture();
  try {
    const d = codexDeps(f);
    const latestCwd = path.join(f.project, 'latest-turn-worktree'); fs.mkdirSync(latestCwd);
    const readResumeSpec = d.resumeSpec;
    d.resumeSpec = (...args) => ({ ...readResumeSpec(...args), cwd: latestCwd });
    const restartSession = d.restartSession;
    d.restartSession = (body, options) => {
      assert.equal(options.resumeCwd, latestCwd, 'the latest turn cwd is passed through the normal guarded restart');
      return restartSession(body, options);
    };
    const result = await handoff.run({ sessionId: d.sid, pane: d.pane.id, accountId: 'codex-two' }, d);
    assert.equal(result.status, 'done'); assert.equal(result.agent, 'codex');
    assert.deepEqual(d.events, ['copy', 'rebind', 'launch', 'verify-target', 'continue']);
    for (const id of [d.sid, d.child]) {
      const authority = accounts.authority(f.root)[id];
      assert.equal(authority.agent, 'codex'); assert.equal(authority.accountId, 'codex-two');
      assert.equal(authority.stagedAccountId, undefined);
    }
    const journal = JSON.parse(fs.readFileSync(path.join(f.root, '.keep', 'account-handoffs', `${d.sid}.json`)));
    assert.deepEqual(journal.resumeSpec.argv, d.argv);
    assert.equal(journal.cwd, latestCwd);
    assert.equal(journal.resumeSpec.cwd, latestCwd);
    assert.deepEqual(journal.targetIdentity, { pane: d.pane.id, panePid: 40, paneCreatedAt: 'codex-target-pane',
      sessionId: d.sid, accountId: 'codex-two', transactionId: journal.id,
      agentPid: 41, agentPidStart: 'codex-target-start', ownsPane: true,
      sessionStartedAt: journal.targetLaunchStartedAt + 1 });
    assert.deepEqual(journal.ownedSessionIds, [d.sid, d.child]);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('Codex handoff rejects an unavailable latest turn cwd before stopping the source', async () => {
  const f = fixture();
  try {
    const d = codexDeps(f);
    const readResumeSpec = d.resumeSpec;
    d.resumeSpec = (...args) => ({ ...readResumeSpec(...args), cwd: path.join(f.base, 'missing-worktree') });
    d.restartSession = async () => assert.fail('invalid latest cwd must be rejected before source exit');
    await assert.rejects(handoff.run({ sessionId: d.sid, pane: d.pane.id, accountId: 'codex-two' }, d),
      (error) => error.status === 409 && /latest working directory is unavailable/.test(error.message));
    assert.equal(d.pane.alive, true); assert.deepEqual(d.events, []);
    assert.equal(accounts.authority(f.root)[d.sid].accountId, 'codex-work');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('Codex delivery receipt finishes partial authority without resending despite a later target policy change', async () => {
  const f = fixture();
  try {
    let sends = 0;
    const d = codexDeps(f, { continueSession: async () => { sends++; throw new Error('daemon stopped after delivery'); } });
    await assert.rejects(handoff.run({ sessionId: d.sid, pane: d.pane.id, accountId: 'codex-two' }, d), /daemon stopped/);
    const file = path.join(f.root, '.keep', 'account-handoffs', `${d.sid}.json`);
    const interrupted = JSON.parse(fs.readFileSync(file, 'utf8'));
    accounts.commitStaged(d.child, interrupted.id, { root: f.root });
    d.deliveryStatus = async () => ({ sessionId: d.sid, kind: 'codex', received: true, pending: false });
    d.verifyTargetSpec = async () => { throw new Error('user changed model after the confirmed continuation'); };
    const recovered = await handoff.run({ sessionId: d.sid, pane: d.pane.id, accountId: 'codex-two' }, d);
    assert.equal(recovered.status, 'done'); assert.equal(sends, 1);
    for (const id of [d.child, d.sid]) assert.equal(accounts.authority(f.root)[id].accountId, 'codex-two');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('Codex handoff refuses a target agent outside the destination pane before recording its identity', async () => {
  const f = fixture();
  try {
    const d = codexDeps(f);
    const inspect = d.inspect;
    d.inspect = async (...args) => {
      const inspected = await inspect(...args);
      if (inspected.pane.meta.accountId === 'codex-two') inspected.agentIdentity.ownsPane = false;
      return inspected;
    };
    let sends = 0; d.continueSession = async () => { sends++; };
    await assert.rejects(handoff.run({ sessionId: d.sid, pane: d.pane.id, accountId: 'codex-two' }, d),
      (error) => error.status === 409 && /process identity was not verified/.test(error.message));
    const file = path.join(f.root, '.keep', 'account-handoffs', `${d.sid}.json`);
    const interrupted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(interrupted.targetIdentity, undefined);
    assert.equal(sends, 0);
    assert.equal(accounts.authority(f.root)[d.sid].accountId, 'codex-work');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('recovery recomputes target agent ownership before continuation delivery', async () => {
  const f = fixture();
  try {
    const d = codexDeps(f, { verifyTargetSpec: async () => { throw new Error('pause after target identity verification'); } });
    await assert.rejects(handoff.run({ sessionId: d.sid, pane: d.pane.id, accountId: 'codex-two' }, d),
      /pause after target identity verification/);
    const file = path.join(f.root, '.keep', 'account-handoffs', `${d.sid}.json`);
    const interrupted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(interrupted.targetIdentity.panePid, 40);
    interrupted.status = 'recovery-needed'; interrupted.phase = 'delivering-continuation';
    delete interrupted.deliveryStartedAt; fs.writeFileSync(file, JSON.stringify(interrupted));
    const inspect = d.inspect;
    d.inspect = async (...args) => {
      const inspected = await inspect(...args);
      inspected.agentIdentity.ownsPane = false;
      return inspected;
    };
    let sends = 0; d.continueSession = async () => { sends++; };
    await assert.rejects(handoff.run({ sessionId: d.sid, pane: d.pane.id, accountId: 'codex-two' }, d),
      (error) => error.status === 409 && /process identity changed/.test(error.message));
    assert.equal(sends, 0); assert.equal(accounts.authority(f.root)[d.sid].accountId, 'codex-work');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('Codex source policy changes after exit block target launch', async () => {
  const f = fixture();
  try {
    let reads = 0;
    const d = codexDeps(f, {
      resumeSpec: (_sid, plan) => ({ sessionId: _sid, cwd: f.project, model: 'gpt-6-astra', effort: 'high', provider: 'openai',
        argv: ['codex', '--sandbox', 'workspace-write', '--ask-for-approval', 'never', '-m', 'gpt-6-astra',
          '-c', 'model_reasoning_effort="high"', 'resume', _sid],
        digest: ++reads === 1 ? 'frozen-policy' : 'changed-policy', plan }),
      compatible: () => ({ ok: true, reasons: [], mcpConfig: null }),
    });
    await assert.rejects(handoff.run({ sessionId: d.sid, pane: d.pane.id, accountId: 'codex-two' }, d), /launch settings changed/);
    assert.equal(d.events.includes('launch'), false);
    assert.equal(accounts.authority(f.root)[d.sid].accountId, 'codex-work');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('Codex recovery resumes an idempotent copy after the ledger already rebound', async () => {
  const f = fixture();
  try {
    let first = true;
    const d = codexDeps(f);
    d.artifactProvider.rebindLedger = (...args) => {
      d.events.push('rebind');
      if (first) { first = false; throw new Error('daemon stopped after durable ledger rebind'); }
      return { rebound: d.plan.artifacts.map((entry) => ({ sessionId: entry.sessionId, reused: true })) };
    };
    await assert.rejects(handoff.run({ sessionId: d.sid, pane: d.pane.id, accountId: 'codex-two' }, d), /durable ledger rebind/);
    assert.equal(d.preflights(), 1); assert.equal(d.pane.alive, false);
    const recovered = await handoff.run({ sessionId: d.sid, pane: d.pane.id, accountId: 'codex-two' }, d);
    assert.equal(recovered.status, 'done');
    assert.equal(d.preflights(), 1, 'recovery uses the transaction journal after the ledger source moved');
    assert.deepEqual(d.events, ['copy', 'rebind', 'copy', 'rebind', 'resume-exited', 'verify-target', 'continue']);
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

test('explicit portable fallback abandons only a verified pre-stop transaction with the source intact', async () => {
  const f = fixture();
  try {
    const d = deps(f, { restartSession: async () => { throw new Error('Waiting for job ledger recovery'); } });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /job ledger recovery/);
    const pending = handoff.list(f.root)[0];
    assert.equal(pending.portableFallbackAvailable, true);
    const abandoned = await handoff.abandonForPortable({ sessionId: f.sid, pane: 'pane-1', transactionId: pending.id }, d);
    assert.equal(abandoned.status, 'failed');
    assert.equal(abandoned.phase, 'portable-fallback');
    assert.ok(abandoned.portableFallbackAt);
    assert.equal(d.pane.alive, true);
    assert.equal(accounts.forSession(f.sid, 'claude', { root: f.root, env: f.env }).id, 'one');
    await assert.rejects(handoff.abandonForPortable({ sessionId: f.sid, pane: 'pane-1', transactionId: pending.id }, d),
      /cannot be safely replaced/);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('portable fallback is unavailable when the source agent was not proven to belong to its pane', async () => {
  const f = fixture();
  try {
    const d = deps(f, { restartSession: async () => { throw new Error('Waiting for job ledger recovery'); } });
    const inspect = d.inspect;
    d.inspect = async (...args) => {
      const inspected = await inspect(...args);
      inspected.agentIdentity.ownsPane = false;
      return inspected;
    };
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /job ledger recovery/);
    const pending = handoff.list(f.root)[0];
    assert.equal(pending.portableFallbackAvailable, undefined);
    d.inspect = inspect;
    await assert.rejects(handoff.abandonForPortable({ sessionId: f.sid, pane: 'pane-1', transactionId: pending.id }, d),
      /cannot be safely replaced/, 'a later pane-owned process does not upgrade the unproven source snapshot');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('portable fallback refuses changed source identity and any transaction that reached stop or launch', async () => {
  const f = fixture();
  try {
    const d = deps(f, { restartSession: async () => { throw new Error('Waiting for job ledger recovery'); } });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d));
    const pending = handoff.list(f.root)[0];
    d.pane.meta.accountId = 'two';
    await assert.rejects(handoff.abandonForPortable({ sessionId: f.sid, pane: 'pane-1', transactionId: pending.id }, d),
      /identity is no longer intact/);
    d.pane.meta.accountId = 'one';
    const inspect = d.inspect;
    d.inspect = async (body) => ({ ...(await inspect(body)),
      agentIdentity: { pid: 99, pidStart: 'replacement-start', primary: true } });
    await assert.rejects(handoff.abandonForPortable({ sessionId: f.sid, pane: 'pane-1', transactionId: pending.id }, d),
      /identity is no longer intact/);
    d.inspect = async (body) => ({ ...(await inspect(body)),
      agentIdentity: { pid: 11, pidStart: 'source-start', primary: true, ownsPane: false } });
    await assert.rejects(handoff.abandonForPortable({ sessionId: f.sid, pane: 'pane-1', transactionId: pending.id }, d),
      /identity is no longer intact/, 'matching process identity outside the source pane is refused');
    d.inspect = inspect;
    const journal = path.join(f.root, '.keep', 'account-handoffs', `${f.sid}.json`);
    const state = JSON.parse(fs.readFileSync(journal, 'utf8'));
    state.sourceStopVerifiedAt = Date.now(); fs.writeFileSync(journal, JSON.stringify(state));
    await assert.rejects(handoff.abandonForPortable({ sessionId: f.sid, pane: 'pane-1', transactionId: pending.id }, d),
      /cannot be safely replaced/);
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
    d.resumeExited = async (entry, _target, _mcpConfig, hooks = {}) => {
      assert.equal(entry.pid, 20, 'the transaction-marked replacement pid is adopted after a crash before journal persistence');
      d.pane.alive = true; d.pane.pid = 30; d.pane.createdAt = 'recovered-target-pane';
      d.pane.meta = { ...d.pane.meta, accountId: 'two', handoffTransactionId: entry.id };
      const launch = { ok: true, pane: 'pane-1', pid: 30, createdAt: d.pane.createdAt };
      await hooks.onLaunched?.(launch); return launch;
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
    let recordMode = 'missing', launches = 0;
    const d = deps(f, {
      restartSession: async (_body, options) => {
        launches++;
        d.pane.alive = false;
        const result = await options.host.request('replace-exited', { meta: { sessionId: f.sid, accountId: 'two' } });
        fs.appendFileSync(path.join(f.profiles.two, 'projects', f.projectName, `${f.sid}.jsonl`), '{"type":"assistant","message":{"content":"target update"}}\n');
        return result;
      },
      waitForAccountRecord: async (_sid, _pane, accountId, after) => {
        if (recordMode === 'missing') return null;
        if (recordMode === 'wrong-pane') return { pane: 'replacement-pane', accountId, agent: 'claude', startedAt: after + 1 };
        return { pane: 'pane-1', accountId, agent: 'claude', startedAt: after + 1 };
      },
    });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /identity was not verified/);
    const journalFile = path.join(f.root, '.keep', 'account-handoffs', `${f.sid}.json`);
    const interrupted = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    interrupted.status = 'verifying';
    fs.writeFileSync(journalFile, JSON.stringify(interrupted));
    recordMode = 'wrong-pane';
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /identity was not verified/);
    assert.equal(launches, 1); assert.equal(d.continuations(), 0);
    recordMode = 'correct';
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
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'codex-work' }, d), /same supported provider/);
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
      processArgs: `claude --settings '${JSON.stringify(require('./reviewer-launch').REVIEWER_SETTINGS)}' --resume ${f.sid}`,
      agentIdentity: reviewer.pane.meta.accountId === 'two'
        ? { pid: 21, pidStart: 'target-start', primary: true, ownsPane: true }
        : { pid: 11, pidStart: 'source-start', primary: true, ownsPane: true } });
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
