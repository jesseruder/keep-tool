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
    pane.meta = { ...pane.meta, ...params.meta, accountId: params.meta.accountId || 'two' };
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
      pane.meta = { ...pane.meta, accountId: _target.id, handoffTransactionId: _entry.id };
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

test('handoff refuses an unresolved synthetic-only Claude model before stopping the source', async () => {
  const f = fixture();
  try {
    const d = deps(f);
    const inspected = await d.inspect();
    d.inspect = async () => ({ ...inspected, currentModel: '<unknown>' });
    await assert.rejects(
      handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d),
      /Current Claude model cannot be reproduced safely/,
    );
    assert.equal(d.pane.alive, true, 'model uncertainty is resolved before stopping the source');
    assert.equal(d.continuations(), 0);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
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

test('open-only Codex handoff verifies the target and commits authority without typing a continuation', async () => {
  const f = fixture();
  try {
    const d = codexDeps(f, { continueSession: async () => assert.fail('open-only must not type into the target') });
    const result = await handoff.run({ sessionId: d.sid, pane: d.pane.id, accountId: 'codex-two', intent: 'open-only' }, d);
    assert.equal(result.status, 'done'); assert.equal(result.intent, 'open-only');
    assert.deepEqual(d.events, ['copy', 'rebind', 'launch', 'verify-target']);
    const journal = JSON.parse(fs.readFileSync(path.join(f.root, '.keep', 'account-handoffs', `${d.sid}.json`)));
    assert.equal(journal.intent, 'open-only'); assert.ok(journal.openedAt);
    assert.equal(journal.deliveryStartedAt, undefined); assert.equal(journal.deliveryId, undefined);
    for (const id of [d.sid, d.child]) assert.equal(accounts.authority(f.root)[id].accountId, 'codex-two');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('open-only recovery finalizes a durably verified opening without launch or input', async () => {
  const f = fixture();
  try {
    const d = codexDeps(f, { verifyTargetSpec: async () => { throw new Error('pause before opened marker'); } });
    await assert.rejects(handoff.run({ sessionId: d.sid, pane: d.pane.id, accountId: 'codex-two', intent: 'open-only' }, d),
      /pause before opened marker/);
    const file = path.join(f.root, '.keep', 'account-handoffs', `${d.sid}.json`);
    const interrupted = JSON.parse(fs.readFileSync(file, 'utf8'));
    interrupted.openedAt = Date.now(); interrupted.phase = 'opening-target'; interrupted.status = 'recovery-needed';
    fs.writeFileSync(file, JSON.stringify(interrupted));
    d.resumeExited = async () => assert.fail('verified opening must not relaunch');
    d.continueSession = async () => assert.fail('verified opening must not type');
    const recovered = await handoff.run({ sessionId: d.sid, pane: d.pane.id, accountId: 'codex-two', intent: 'open-only' }, d);
    assert.equal(recovered.status, 'done'); assert.equal(recovered.intent, 'open-only');
    assert.equal(accounts.authority(f.root)[d.sid].accountId, 'codex-two');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('handoff intent is immutable across retries', async () => {
  const f = fixture();
  try {
    const d = codexDeps(f, { verifyTargetSpec: async () => { throw new Error('pause after launch'); } });
    await assert.rejects(handoff.run({ sessionId: d.sid, pane: d.pane.id, accountId: 'codex-two', intent: 'open-only' }, d));
    await assert.rejects(handoff.run({ sessionId: d.sid, pane: d.pane.id, accountId: 'codex-two', intent: 'continue' }, d),
      (error) => error.status === 409 && /different account handoff intent/.test(error.message));
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a completed transfer does not impose its intent on a later transfer to another account', async () => {
  const f = fixture();
  try {
    const d = deps(f);
    await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d);
    const continued = d.continuations();
    const reopened = await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'three', intent: 'open-only' }, d);
    assert.equal(reopened.status, 'done'); assert.equal(reopened.intent, 'open-only');
    assert.equal(d.continuations(), continued, 'the later open-only transfer sends no continuation');
    assert.equal(accounts.forSession(f.sid, 'claude', { root: f.root, env: f.env }).id, 'three');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('failed open-only preflight keeps its intent when retry omits the field', async () => {
  const f = fixture();
  try {
    let loggedIn = false;
    const d = deps(f, { authPreflight: async () => loggedIn,
      continueSession: async () => assert.fail('open-only retry must not type a continuation') });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two', intent: 'open-only' }, d), /not logged in/);
    assert.equal(handoff.list(f.root)[0].intent, 'open-only');
    loggedIn = true;
    const retried = await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d);
    assert.equal(retried.status, 'done'); assert.equal(retried.intent, 'open-only');
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

test('an Owner-forced Codex transfer forces the stop, the artifact plan, the copy and the rebind', async () => {
  const f = fixture();
  try {
    const d = codexDeps(f);
    const seen = {};
    const provider = d.artifactProvider;
    d.artifactProvider = { ...provider,
      preflight: (...args) => { seen.preflight = args[3]?.force; return provider.preflight(...args); },
      copyCodexArtifacts: (...args) => { seen.copy = args[4]?.force; return provider.copyCodexArtifacts(...args); },
      rebindLedger: (...args) => { seen.rebind = args[4]?.force; return provider.rebindLedger(...args); } };
    const restart = d.restartSession;
    d.restartSession = (body, options) => { seen.stop = { force: body.force, ownerForce: options.ownerForce }; return restart(body, options); };
    const result = await handoff.run({ sessionId: d.sid, pane: d.pane.id, accountId: 'codex-two', ownerForce: true }, d);
    assert.equal(result.status, 'done');
    assert.deepEqual(seen, { preflight: true, copy: true, rebind: true, stop: { force: true, ownerForce: true } });
    await assert.rejects(handoff.run({ sessionId: d.sid, pane: d.pane.id, accountId: 'codex-two', ownerForce: 'yes' }, d),
      /ownerForce must be a boolean/);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a child thread that appears before a forced Codex stop is adopted, not a stuck transfer', async () => {
  const f = fixture();
  try {
    const d = codexDeps(f);
    const late = { sessionId: 'late-child', parentSessionId: d.sid, children: [], interacted: [],
      source: path.join(f.profiles.codex, 'sessions', 'rollout-late-child.jsonl'),
      target: path.join(f.profiles.codexTwo, 'sessions', 'rollout-late-child.jsonl') };
    const grown = { ...d.plan, artifacts: [...d.plan.artifacts, late] };
    const provider = d.artifactProvider;
    d.artifactProvider = { ...provider, copyCodexArtifacts: (...args) => { provider.copyCodexArtifacts(...args); return grown; },
      rebindLedger: (...args) => { provider.rebindLedger(...args); return { rebound: grown.artifacts.map((entry) => ({ sessionId: entry.sessionId })) }; } };
    const result = await handoff.run({ sessionId: d.sid, pane: d.pane.id, accountId: 'codex-two', ownerForce: true }, d);
    assert.equal(result.status, 'done');
    assert.deepEqual(handoff.readOne(f.root, d.sid).ownedSessionIds.sort(), [d.child, 'late-child', d.sid].sort());
    assert.equal(accounts.forSession('late-child', 'codex', { root: f.root, env: f.env }).id, 'codex-two',
      'the adopted child moves with the conversation');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('an ordinary Codex transfer still refuses a graph that changed across its stop', async () => {
  const f = fixture();
  try {
    const d = codexDeps(f);
    const provider = d.artifactProvider;
    d.artifactProvider = { ...provider, copyCodexArtifacts: (...args) => {
      provider.copyCodexArtifacts(...args); return { ...d.plan, artifacts: d.plan.artifacts.slice(0, 1) }; } };
    await assert.rejects(handoff.run({ sessionId: d.sid, pane: d.pane.id, accountId: 'codex-two' }, d), /graph changed/);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('an ordinary transfer asks the artifact plan and the stop for their proofs', async () => {
  const f = fixture();
  try {
    const d = codexDeps(f);
    const seen = {};
    const provider = d.artifactProvider;
    d.artifactProvider = { ...provider, preflight: (...args) => { seen.preflight = args[3]?.force; return provider.preflight(...args); } };
    const restart = d.restartSession;
    d.restartSession = (body, options) => { seen.ownerForce = options.ownerForce; return restart(body, options); };
    // A queue entry's legacy force skips uncertain background evidence at the stop, never the artifact proof.
    assert.equal((await handoff.run({ sessionId: d.sid, pane: d.pane.id, accountId: 'codex-two', force: true }, d)).status, 'done');
    assert.deepEqual(seen, { preflight: false, ownerForce: false });
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

test('a typed /exit whose confirmation was lost is proven after the fact from a fresh ps', async () => {
  const f = fixture();
  try {
    // The 2026-09-21 shape: the restart typed /exit, the source left, and a later host
    // call timed out, so the transaction never reached replace-exited.
    const d = deps(f, { restartSession: async (_body, options) => {
      options.onExitEnter();
      d.pane.alive = false;
      const error = new Error('host request timed out: input'); error.status = 409; throw error;
    } });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /host request timed out/);
    const journal = () => handoff.readOne(f.root, f.sid);
    assert.equal(journal().status, 'recovery-needed');
    assert.equal(journal().sourceStopVerifiedAt, undefined);
    assert.ok(Number.isFinite(journal().sourceExitEnterAt));

    // No snapshot, a failed one, or an empty one proves nothing: blocked, but transient.
    for (const rows of [undefined, async () => { throw new Error('Command failed: ps'); }, async () => []]) {
      d.agentProcessRows = rows;
      await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), (error) =>
        /^Source exit could not be verified/.test(error.message) && handoff.classifyRefusal(error.message) === 'transient');
      assert.equal(journal().sourceStopVerifiedAt, undefined);
    }
    // The recorded process is still there: not a stop at all.
    d.agentProcessRows = async () => [{ pid: 11, pidStart: 'source-start' }];
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /still running/);
    // A pane that is not the record's (another session's meta, or relaunched by a handoff).
    d.agentProcessRows = async () => [{ pid: 11, pidStart: 'another-start' }, { pid: 12, pidStart: 'x' }];
    d.pane.meta.handoffTransactionId = 'someone-else';
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /Source exit was not verified/);
    delete d.pane.meta.handoffTransactionId;

    // The pid reused by a process that started at another time: proven, and recovery runs.
    const recovered = await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d);
    assert.equal(recovered.status, 'done');
    assert.equal(recovered.sourceStopVerifiedBy, 'post-hoc-ps');
    assert.ok(recovered.sourceStopVerifiedAt);
    assert.equal(d.continuations(), 1);
    assert.equal(accounts.forSession(f.sid, 'claude', { root: f.root, env: f.env }).id, 'two');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a forced stop lost mid-way is recovered only once every process it signalled is gone', async () => {
  const f = fixture();
  try {
    const tree = [{ pid: 10, pidStart: 'shell-start' }, { pid: 11, pidStart: 'source-start' }, { pid: 12, pidStart: 'child-start' }];
    const d = deps(f, { restartSession: async (_body, options) => {
      assert.equal(options.ownerForce, true);
      options.onForcedStop(tree); d.pane.alive = false; throw new Error('host request timed out: get');
    } });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two', ownerForce: true }, d), /host request timed out/);
    const journal = handoff.readOne(f.root, f.sid);
    assert.ok(Number.isFinite(journal.sourceExitEnterAt));
    assert.deepEqual(journal.forcedProcesses, tree);
    // The agent is gone but a child it started is still running and could still write.
    d.agentProcessRows = async () => [{ pid: 12, pidStart: 'child-start' }, { pid: 99, pidStart: 'other' }];
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /forced stop is still running/);
    assert.equal(handoff.readOne(f.root, f.sid).sourceStopVerifiedAt, undefined);
    // A reused pid that started at another time is not that child.
    d.agentProcessRows = async () => [{ pid: 12, pidStart: 'later' }, { pid: 99, pidStart: 'other' }];
    const recovered = await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d);
    assert.equal(recovered.status, 'done');
    assert.equal(recovered.sourceStopVerifiedBy, 'post-hoc-ps');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a forced stop whose capture overflowed never proves itself after the fact', async () => {
  const f = fixture();
  try {
    const tree = [{ pid: 11, pidStart: 'source-start' }];
    const d = deps(f, { restartSession: async (_body, options) => {
      options.onForcedStop(tree); options.onForcedStop(tree, { incomplete: true }); d.pane.alive = false;
      throw new Error('Process tree exceeds force-stop limit or lacks identity');
    } });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two', ownerForce: true }, d), /force-stop limit/);
    assert.equal(handoff.readOne(f.root, f.sid).forcedCaptureIncomplete, true);
    d.agentProcessRows = async () => [{ pid: 99, pidStart: 'other' }];
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /could not capture every process/);
    assert.equal(handoff.readOne(f.root, f.sid).sourceStopVerifiedAt, undefined);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('an earlier transfer\'s pane marker does not block proving a later lost stop', async () => {
  const f = fixture();
  try {
    const d = deps(f, { restartSession: async (_body, options) => {
      options.onExitEnter(); d.pane.alive = false; throw new Error('host request timed out: input');
    } });
    // This source was itself launched by an earlier A->B-style transfer.
    d.pane.meta.handoffTransactionId = 'earlier-transfer';
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /host request timed out/);
    assert.equal(handoff.readOne(f.root, f.sid).sourcePaneHandoffTransactionId, 'earlier-transfer');
    d.agentProcessRows = async () => [{ pid: 99, pidStart: 'other' }];
    // A marker that moved since the stop — this transaction's own, or a newer one — still refuses.
    d.pane.meta.handoffTransactionId = handoff.readOne(f.root, f.sid).id;
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /Source exit was not verified/);
    d.pane.meta.handoffTransactionId = 'newer-transfer';
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /Source exit was not verified/);
    d.pane.meta.handoffTransactionId = 'earlier-transfer';
    const recovered = await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d);
    assert.equal(recovered.status, 'done');
    assert.equal(recovered.sourceStopVerifiedBy, 'post-hoc-ps');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('only a committed /exit Enter from this attempt proves a lost stop', async () => {
  const f = fixture();
  try {
    let mode = 'dropped';
    const d = deps(f, { restartSession: async (_body, options) => {
      if (mode === 'dropped') {
        // The host refused the Enter: nothing was submitted, the mark is taken back.
        options.onExitEnter(); options.onExitEnterDropped();
        const error = new Error('input arrived on the pane before this keystroke; nothing was typed'); error.status = 409; throw error;
      }
      if (mode === 'committed') { options.onExitEnter(); throw new Error('host request timed out: input'); }
      // A later attempt that refuses before its /exit is ever submitted.
      throw new Error('Waiting for the turn and background work to finish');
    } });
    d.agentProcessRows = async () => [{ pid: 99, pidStart: 'other' }];
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /nothing was typed/);
    assert.equal(handoff.readOne(f.root, f.sid).sourceExitEnterAt, undefined);
    d.pane.alive = false; // then the source crashes on its own
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /Source exit was not verified/);

    // A committed Enter whose source nevertheless stayed up, then a retry that refuses
    // before its own Enter: the retry starts with no mark, so a later crash proves nothing.
    d.pane.alive = true; mode = 'committed';
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /host request timed out/);
    assert.ok(Number.isFinite(handoff.readOne(f.root, f.sid).sourceExitEnterAt));
    mode = 'refused';
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /Waiting for the turn/);
    assert.equal(handoff.readOne(f.root, f.sid).sourceExitEnterAt, undefined);
    d.pane.alive = false;
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /Source exit was not verified/);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a host that did not list its panes is a transient timeout, not a missing pane', async () => {
  const f = fixture();
  try {
    const d = deps(f, { restartSession: async (_body, options) => {
      options.onExitEnter(); d.pane.alive = false; throw new Error('host request timed out: input');
    } });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d));
    d.inspect = async () => ({ hostUnavailable: true });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), (error) =>
      /^host request timed out/.test(error.message) && handoff.classifyRefusal(error.message) === 'transient'
      && !/original pane/.test(error.message));
    assert.equal(handoff.readOne(f.root, f.sid).status, 'recovery-needed', 'the record is left exactly as it was');
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

test('Owner can abandon a transfer that never stopped its source, and it cancels a queued retry', async () => {
  const f = fixture();
  try {
    const d = deps(f, { restartSession: async () => { throw new Error('Waiting for job ledger recovery'); } });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /job ledger recovery/);
    const pending = handoff.list(f.root)[0];
    assert.equal(pending.abandonAvailable, true);
    const queue = require('./handoff-queue');
    queue.enqueue(f.root, { sessionId: f.sid, pane: 'pane-1', sourceAccountId: 'one', targetAccountId: 'two' }, { log: () => {} });
    assert.throws(() => handoff.abandon({ sessionId: f.sid, transactionId: 'other' }, { root: f.root }), /retry it instead/);
    const abandoned = handoff.abandon({ sessionId: f.sid, transactionId: pending.id }, { root: f.root, log: () => {} });
    assert.equal(abandoned.status, 'failed');
    assert.equal(abandoned.phase, 'abandoned');
    assert.match(abandoned.reason, /stays on one/);
    assert.equal(abandoned.abandonAvailable, undefined);
    assert.equal(abandoned.portableFallbackAvailable, undefined);
    assert.equal(queue.readOne(f.root, f.sid).status, 'cancelled');
    assert.equal(d.pane.alive, true);
    assert.equal(accounts.forSession(f.sid, 'claude', { root: f.root, env: f.env }).id, 'one');
    assert.throws(() => handoff.abandon({ sessionId: f.sid, transactionId: pending.id }, { root: f.root }), /retry it instead/);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('abandon refuses a transfer that typed its /exit, proved the stop or launched the target', async () => {
  const f = fixture();
  try {
    const d = deps(f, { restartSession: async () => { throw new Error('Waiting for job ledger recovery'); } });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d));
    const pending = handoff.list(f.root)[0];
    const journal = path.join(f.root, '.keep', 'account-handoffs', `${f.sid}.json`);
    const original = fs.readFileSync(journal, 'utf8');
    for (const extra of [{ sourceExitEnterAt: Date.now() }, { sourceStopVerifiedAt: Date.now() },
      { targetLaunchStartedAt: Date.now() }, { phase: 'copying-artifacts' }, { status: 'starting' }]) {
      fs.writeFileSync(journal, JSON.stringify({ ...JSON.parse(original), ...extra }));
      assert.equal(handoff.list(f.root)[0].abandonAvailable, undefined, JSON.stringify(extra));
      assert.throws(() => handoff.abandon({ sessionId: f.sid, transactionId: pending.id }, { root: f.root }),
        (error) => error.status === 409 && /retry it instead/.test(error.message), JSON.stringify(extra));
    }
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a source agent the preflight could not name refuses the transfer before anything is journalled', async () => {
  const f = fixture();
  try {
    const d = deps(f, { restartSession: async () => assert.fail('must not stop an unnamed source') });
    const inspect = d.inspect;
    // Every shape that leaves the source unnamed. Each one is something the stop path,
    // the portable fallback and the queue's own recovery guard are all written against.
    for (const identity of [
      null,
      { pid: 11, pidStart: 'source-start', primary: true, ownsPane: false },
      { pid: 11, pidStart: 'source-start', primary: false, ownsPane: true },
      { pid: 0, pidStart: 'source-start', primary: true, ownsPane: true },
      { pid: 11, pidStart: '', primary: true, ownsPane: true },
    ]) {
      d.inspect = async (body) => ({ ...(await inspect(body)), agentIdentity: identity });
      await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d),
        (error) => error.status === 409
          && error.message === 'Source agent process identity could not be verified',
        JSON.stringify(identity));
      // Nothing was written, so there is no transaction to recover and none to abandon.
      assert.deepEqual(handoff.list(f.root), []);
    }
    // The next attempt inspects from scratch, so the queue may simply ask again.
    assert.equal(handoff.classifyRefusal('Source agent process identity could not be verified'), 'transient');
    d.inspect = inspect;
    await assert.rejects(handoff.abandonForPortable({ sessionId: f.sid, pane: 'pane-1', transactionId: 'no-such-transaction' }, d),
      /cannot be safely replaced/, 'a later pane-owned process does not conjure a transaction to abandon');
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
    const candidates = [path.join(f.base, 'project mcp.json'), path.join(f.base, 'launch mcp.json')];
    for (const candidate of candidates) {
      assert.equal(handoff.permissionClass(`claude --mcp-config '${candidate}' --resume ${f.sid}`, { mcpConfig: candidates }),
        'restricted', 'either managed MCP candidate is reproducible');
    }
    assert.equal(handoff.permissionClass(`claude --mcp-config '${path.join(f.base, 'other mcp.json')}' --resume ${f.sid}`,
      { mcpConfig: candidates }), null, 'an unrelated MCP path is still refused');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a session that moved out of its launch directory keeps its managed MCP configuration', async () => {
  const f = fixture();
  try {
    const setup = require('./account-setup');
    const worktree = path.join(f.base, 'worktree'); fs.mkdirSync(worktree);
    const launchMcpConfig = setup.mcpConfigPath(f.profiles.one, f.project);
    const verified = [];
    const d = deps(f, {
      readSetup: () => ({ version: 1 }),
      ensureSharedMemory: (_source, cwd) => {
        verified.push(cwd);
        return { mcpConfig: setup.mcpConfigPath(f.profiles.one, cwd) };
      },
    });
    d.inspect = async () => ({ session: { id: f.sid, kind: 'claude', project: worktree, endedTurn: true }, pane: d.pane,
      processArgs: `claude --mcp-config ${launchMcpConfig} --resume ${f.sid}`, currentModel: 'claude-opus-4-1',
      agentIdentity: d.pane.meta.accountId === 'two'
        ? { pid: 21, pidStart: 'target-start', primary: true, ownsPane: true }
        : { pid: 11, pidStart: 'source-start', primary: true, ownsPane: true } });
    const result = await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d);
    assert.equal(result.status, 'done', 'the managed MCP path keyed by the launch cwd is reproducible');
    assert.deepEqual(verified, [worktree, f.project], 'both candidates are verified as managed configurations');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a conflicting managed MCP configuration at the launch cwd is refused before source exit', async () => {
  const f = fixture();
  try {
    const setup = require('./account-setup');
    const worktree = path.join(f.base, 'worktree'); fs.mkdirSync(worktree);
    const launchMcpConfig = setup.mcpConfigPath(f.profiles.one, f.project);
    const d = deps(f, {
      readSetup: () => ({ version: 1 }),
      ensureSharedMemory: (_source, cwd) => {
        if (cwd === f.project) throw new Error(`managed MCP configuration conflicts for ${cwd}`);
        return { mcpConfig: setup.mcpConfigPath(f.profiles.one, cwd) };
      },
    });
    d.inspect = async () => ({ session: { id: f.sid, kind: 'claude', project: worktree, endedTurn: true }, pane: d.pane,
      processArgs: `claude --mcp-config ${launchMcpConfig} --resume ${f.sid}`, currentModel: 'claude-opus-4-1' });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d),
      /Source account setup is unavailable: managed MCP configuration conflicts/);
    assert.equal(d.pane.alive, true, 'the source session is left running');
    assert.equal(accounts.forSession(f.sid, 'claude', { root: f.root, env: f.env }).id, 'one');
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

test('an explicit force reaches the stop path, the ledger rebind and the recorded transaction', async () => {
  const f = fixture();
  try {
    const d = deps(f);
    let restartBody = null, rebindForce = null;
    const baseRestart = d.restartSession;
    d.restartSession = async (body, options) => { restartBody = body; return baseRestart(body, options); };
    d.rebindLedger = (_sessionId, _source, _target, _transactionId, options) => { rebindForce = options.force; };
    const result = await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two', force: true }, d);
    assert.equal(restartBody.force, true);
    assert.equal(rebindForce, true);
    assert.equal(result.force, true);
    assert.equal(handoff.list(f.root)[0].force, true);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('the restart is told which agent process the preflight verified', async () => {
  const f = fixture();
  try {
    const d = deps(f);
    let options = null;
    const baseRestart = d.restartSession;
    d.restartSession = async (body, given) => { options = given; return baseRestart(body, given); };
    await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d);
    // Naming it is what keeps the restart's own patient `ps` re-reads from adopting a
    // session relaunched between the preflight and the stop.
    assert.deepEqual(options.expectedAgentIdentity, { pid: 11, pidStart: 'source-start' });
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a transfer that names when it was requested refuses a session used since, and hands the boundary on', async () => {
  const T = 1_700_000_000_000;
  const run = async (lastUserAt, options = {}) => {
    const f = fixture();
    try {
      let given = null;
      const d = deps(f, { ...options });
      const inspect = d.inspect;
      d.inspect = async (body) => {
        const inspected = await inspect(body);
        return { ...inspected, session: { ...inspected.session, ...(lastUserAt === undefined ? {} : { lastUserAt }) } };
      };
      const baseRestart = d.restartSession;
      d.restartSession = async (body, opts) => { given = opts; return baseRestart(body, opts); };
      const result = await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two',
        expectedNoUserActivityAfter: T }, d).then((value) => ({ value }), (error) => ({ error }));
      return { ...result, given, records: handoff.list(f.root) };
    } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
  };

  // A turn finished after the transfer was asked for: the person has the session back.
  for (const lastUserAt of [T + 1, T + 60e3]) {
    const used = await run(lastUserAt);
    assert.equal(used.error?.status, 409);
    assert.equal(used.error?.message, 'Session was used after the transfer was requested');
    assert.deepEqual(used.records, [], 'nothing was journalled and nothing was stopped');
  }
  // Nothing clears this on its own, so the queue parks with it rather than retrying.
  assert.equal(handoff.classifyRefusal('Session was used after the transfer was requested'), 'blocked');

  // Equal is not after, and neither is earlier, or a session with no stamp at all.
  for (const lastUserAt of [T, T - 1, undefined]) {
    const fine = await run(lastUserAt);
    assert.equal(fine.error, undefined, `lastUserAt ${lastUserAt} must not refuse`);
    // The restart answers the same expectation once more, inside the injection lock.
    assert.equal(fine.given.expectedNoUserActivityAfter, T);
  }

  // A transfer that names no boundary is untouched by any of it.
  const f = fixture();
  try {
    const d = deps(f);
    const inspect = d.inspect;
    d.inspect = async (body) => {
      const inspected = await inspect(body);
      return { ...inspected, session: { ...inspected.session, lastUserAt: Date.now() } };
    };
    let given = null;
    const baseRestart = d.restartSession;
    d.restartSession = async (body, opts) => { given = opts; return baseRestart(body, opts); };
    await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d);
    assert.equal('expectedNoUserActivityAfter' in given, false);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }

  // And a boundary that is not a finite number is refused before anything is inspected.
  const bad = fixture();
  try {
    const d = deps(bad, { inspect: async () => assert.fail('must not inspect'),
      restartSession: async () => assert.fail('must not stop source') });
    for (const value of ['1700000000000', Infinity, NaN, null]) {
      await assert.rejects(handoff.run({ sessionId: bad.sid, pane: 'pane-1', accountId: 'two',
        expectedNoUserActivityAfter: value }, d),
      (error) => error.status === 400 && /expectedNoUserActivityAfter must be a finite number/.test(error.message),
      String(value));
    }
  } finally { fs.rmSync(bad.base, { recursive: true, force: true }); }
});

test('a non-boolean force is rejected before anything is inspected', async () => {
  const f = fixture();
  try {
    const d = deps(f, { inspect: async () => assert.fail('must not inspect'),
      restartSession: async () => assert.fail('must not stop source') });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two', force: 'yes' }, d),
      (error) => error.status === 400 && /force must be a boolean/.test(error.message));
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

// ---------- refusal classes ----------

test('refusals that clear on their own are told apart from the ones that need a person', () => {
  // Every one of these refused at least one of the nine transfers moved by hand on
  // 2026-09-15, and every one of them cleared on its own.
  for (const reason of [
    'another session injection is busy',
    'Waiting for the turn and background work to finish',
    'Waiting until the pane is no longer being viewed',
    'Waiting for pending input to be resolved',
    'Waiting for job ledger recovery',
    'Pause session-local scheduled jobs before restarting',
    'Session changed during cleanup; nothing closed',
    'Session changed during restart',
    'host request timed out (get)',
    'Session activity could not be verified',
    'Live pane state could not be verified',
    'Command failed: ps -axo pid=,ppid=,tty=,lstart=,args=',
    'Local background processes are still present',
    'Job ledger source changed during restart',
    'Job ledger evidence changed during restart',
    'New hook activity arrived during restart',
    // A bad `ps` snapshot under load, not a changed process: the next attempt reads
    // the identity again from scratch and re-runs the same comparison.
    'Agent process identity changed during restart',
    'Agent process identity could not be verified from ps',
    'Original agent process identity is unverified',
    'Session helper processes changed during restart',
    // The restart's /exit was taken back off the screen, so the pane is as it was.
    'message was typed but could not be confirmed; the typed /exit was cleared',
  ]) assert.equal(handoff.classifyRefusal(reason), 'transient', reason);

  // And these say a person has to look before the same request is worth repeating.
  for (const reason of [
    'Current Claude model cannot be reproduced safely',
    'Session uses a custom permission configuration that cannot be reproduced safely',
    "ENOENT: no such file or directory, open '/x/subagents/agent-1.jsonl'",
    'Target claude account is not logged in; source session was left running',
    'Target account setup is incompatible: Codex provider configuration could not be verified',
    'Source account setup is unavailable: managed memory is missing',
    'Session process changed',
    'Session process changed during restart',
    // The other spelling of the same refusal: the text is still in the box, and a
    // person has to clear it before anything can type there again.
    'message was typed but could not be confirmed; Enter was not pressed',
    'Claude is showing a dialog',
    'source and target account are the same',
    '',
    null,
    undefined,
  ]) assert.equal(handoff.classifyRefusal(reason), 'blocked', String(reason));
});

test('a stopped transfer records its refusal class and publishes it with the record', async () => {
  const f = fixture();
  try {
    const d = deps(f, { restartSession: async () => { throw new Error('another session injection is busy'); } });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d));
    const [transient] = handoff.list(f.root);
    assert.equal(transient.status, 'recovery-needed');
    assert.equal(transient.refusalClass, 'transient');

    const blocked = deps(f, { restartSession: async () => { throw new Error('Session process changed'); } });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, blocked));
    assert.equal(handoff.list(f.root)[0].refusalClass, 'blocked');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

// ---------- what the caller assumed, rechecked before anything moves ----------

test('a transfer refuses when the session is not where the caller believed, before any record or stop', async () => {
  const f = fixture();
  try {
    let restarts = 0;
    const d = deps(f, { restartSession: async () => { restarts += 1; throw new Error('must not stop source'); } });
    await assert.rejects(
      handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two', expectedSourceAccountId: 'three' }, d),
      (error) => error.status === 409 && /Session is on one, not the three this transfer was requested from/.test(error.message));
    assert.equal(restarts, 0, 'nothing was stopped');
    assert.deepEqual(handoff.list(f.root), [], 'and no journal record was written');
    // The refusal is one a queue must not keep retrying.
    assert.equal(handoff.classifyRefusal('Session is on one, not the three this transfer was requested from'), 'blocked');

    // The limit the transfer was requested for is checked the same way. The whole
    // deps object is kept, pane and all, and only the observed limit is dressed on.
    const withLimit = (at) => {
      const value = deps(f);
      const baseRestart = value.restartSession;
      value.restartSession = async (...args) => { restarts += 1; return baseRestart(...args); };
      const baseInspect = value.inspect;
      value.inspect = async (body) => {
        const inspected = await baseInspect(body);
        return { ...inspected, session: { ...inspected.session, rateLimit: { type: 'fable_weekly', at } } };
      };
      return value;
    };
    await assert.rejects(
      handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two', expectedRateLimitAt: 1000 }, withLimit(2000)),
      (error) => error.status === 409 && /no longer carries the account limit/.test(error.message));
    assert.equal(restarts, 0);
    assert.deepEqual(handoff.list(f.root), []);
    assert.equal(handoff.classifyRefusal('Session no longer carries the account limit this transfer was requested for'), 'blocked');

    // Matching expectations are simply not in the way.
    const result = await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two',
      expectedSourceAccountId: 'one', expectedRateLimitAt: 1000 }, withLimit(1000));
    assert.equal(result.status, 'done');
    assert.equal(restarts, 1, 'the matching transfer is the only one that reached the source');

    for (const body of [{ expectedSourceAccountId: 'Not An Id' }, { expectedRateLimitAt: { at: 1 } }, { expectedRateLimitAt: true }]) {
      await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two', ...body },
        deps(f, { inspect: async () => assert.fail('must not inspect') })), (error) => error.status === 400);
    }
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a refusal that landed before the stop does not exempt a queued transfer from the limit check', async () => {
  const f = fixture();
  try {
    const queue = require('./handoff-queue');
    let restarts = 0;
    const rows = [{ id: f.sid, kind: 'claude', pane: 'pane-1', accountId: 'one',
      rateLimit: { type: 'fable_weekly', at: 1000 } }];
    const d = deps(f, {
      restartSession: async () => { restarts += 1; throw new Error('another session injection is busy'); },
      inspect: async () => ({ session: { ...rows[0], project: f.project, endedTurn: true },
        pane: d.pane, processArgs: 'claude --dangerously-skip-permissions --resume session-123',
        currentModel: 'claude-opus-4-1',
        agentIdentity: { pid: 11, pidStart: 'source-start', primary: true, ownsPane: true } }),
    });
    const tickWith = (now) => queue.tick({ root: f.root, env: f.env, policyEnabled: false, log: () => {},
      now: () => now, sessions: async () => rows, handoffSession: (body) => handoff.run(body, d) });

    queue.enqueue(f.root, { sessionId: f.sid, pane: 'pane-1', sourceAccountId: 'one', targetAccountId: 'two',
      rateLimitAt: 1000 }, { now: 1000, log: () => {} });
    await tickWith(1000);
    assert.equal(restarts, 1);
    assert.equal(queue.list(f.root)[0].status, 'queued');

    // The journal now holds a recovery-needed record — written for a refusal that
    // landed before the source was touched, and it says so.
    const record = handoff.list(f.root)[0];
    assert.equal(record.status, 'recovery-needed');
    assert.equal(record.phase, 'stopping-source');
    assert.equal(record.sourceStopVerifiedAt, undefined);
    assert.equal(record.refusalClass, 'transient');

    // The person resumed work and the limit cleared. That record must not be read
    // as an in-flight transaction and re-drive the transfer.
    rows[0].rateLimit = null;
    await tickWith(1000 + 30 * 60e3);
    assert.equal(restarts, 1, 'restartSession was never reached again');
    const entry = queue.list(f.root)[0];
    assert.equal(entry.status, 'cancelled');
    assert.equal(entry.note, 'rate limit cleared');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a limit that clears while the target login is checked stops the transfer before the source is touched', async () => {
  const f = fixture();
  try {
    let restarts = 0;
    let at = 1000;
    const d = deps(f);
    const baseRestart = d.restartSession;
    d.restartSession = async (...args) => { restarts += 1; return baseRestart(...args); };
    const baseInspect = d.inspect;
    d.inspect = async (body) => {
      const inspected = await baseInspect(body);
      return { ...inspected, session: { ...inspected.session,
        ...(at == null ? {} : { rateLimit: { type: 'fable_weekly', at } }) } };
    };
    // The login check starts an interactive shell and can take 45 seconds. The
    // person finishes their turn while it runs, and the limit is gone.
    let preflights = 0;
    d.authPreflight = async () => { preflights += 1; at = null; return true; };

    await assert.rejects(
      handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two', expectedRateLimitAt: 1000 }, d),
      (error) => error.status === 409 && /no longer carries the account limit/.test(error.message));
    assert.equal(preflights, 1, 'the expectation held past the preflight, not only before it');
    assert.equal(restarts, 0, 'an idle session was never stopped');
    assert.deepEqual(handoff.list(f.root), [], 'and no journal record was written');

    // The same transfer goes through when the limit is still there afterwards.
    at = 1000;
    d.authPreflight = async () => true;
    const result = await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two', expectedRateLimitAt: 1000 }, d);
    assert.equal(result.status, 'done');
    assert.equal(restarts, 1);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a transfer in flight is visible to anything that would close the session under it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-inflight-'));
  try {
    const sid = 'session-inflight';
    const now = Date.UTC(2026, 8, 17, 12, 0, 0);
    const recordFile = path.join(root, '.keep', 'account-handoffs', `${sid}.json`);
    fs.mkdirSync(path.dirname(recordFile), { recursive: true });
    const record = (over) => fs.writeFileSync(recordFile, JSON.stringify({ sessionId: sid, updatedAt: now, ...over }));
    const queueFile = path.join(root, '.keep', 'handoff-queue', `${sid}.json`);
    fs.mkdirSync(path.dirname(queueFile), { recursive: true });

    assert.equal(handoff.transferInFlight(root, sid, now), null, 'no record and no queue entry, nothing in flight');
    for (const status of ['stopping', 'copying', 'starting', 'verifying', 'delivering']) {
      record({ status, phase: `${status}-phase`, updatedAt: now - 14 * 60e3 });
      assert.deepEqual(handoff.transferInFlight(root, sid, now), { status, phase: `${status}-phase` }, status);
      // A working status that stopped being written to is a transaction that lost its
      // daemon, not one still moving; it does not reserve the pane forever.
      record({ status, phase: `${status}-phase`, updatedAt: now - 16 * 60e3 });
      assert.equal(handoff.transferInFlight(root, sid, now), null, `stale ${status}`);
      record({ status, phase: `${status}-phase` });
      assert.deepEqual(handoff.transferInFlight(root, sid, now), { status, phase: `${status}-phase` }, status);
    }
    // The source agent is gone by design here and the queue retries from exactly this
    // shape, so whatever it will resume into has to still be there.
    record({ status: 'recovery-needed', phase: 'stopping-source', updatedAt: now - 60e3 });
    assert.deepEqual(handoff.transferInFlight(root, sid, now), { status: 'recovery-needed', phase: 'stopping-source' });
    record({ status: 'recovery-needed', phase: 'stopping-source', updatedAt: now - 11 * 60e3 });
    assert.equal(handoff.transferInFlight(root, sid, now), null, 'nobody is coming back for a stopped source this old');
    // A refusal at another phase never stopped the source at all.
    record({ status: 'recovery-needed', phase: 'delivering-continuation', updatedAt: now });
    assert.equal(handoff.transferInFlight(root, sid, now), null);
    // A stamp that is not a finite moment in the past is not freshness. Each of these
    // read as brand new while the age was computed as `now - Number(x || 0)`.
    for (const updatedAt of ['Infinity', Infinity, -Infinity, 'soon', null, undefined, 0, now + 60e3]) {
      record({ status: 'starting', phase: 'starting-target', updatedAt });
      assert.equal(handoff.transferInFlight(root, sid, now), null, `working ${String(updatedAt)}`);
      record({ status: 'recovery-needed', phase: 'stopping-source', updatedAt });
      assert.equal(handoff.transferInFlight(root, sid, now), null, `stopped source ${String(updatedAt)}`);
    }
    // The boundary itself: this instant is fresh, and so is the last millisecond.
    record({ status: 'starting', phase: 'starting-target', updatedAt: now });
    assert.deepEqual(handoff.transferInFlight(root, sid, now), { status: 'starting', phase: 'starting-target' });
    record({ status: 'starting', phase: 'starting-target', updatedAt: now - (15 * 60e3 - 1) });
    assert.deepEqual(handoff.transferInFlight(root, sid, now), { status: 'starting', phase: 'starting-target' });
    for (const status of ['done', 'failed']) {
      record({ status, phase: status === 'done' ? 'done' : 'preflight', updatedAt: now });
      assert.equal(handoff.transferInFlight(root, sid, now), null, status);
    }
    // A queued entry counts on its own: the transfer has not started, but it is about
    // to, and the phase it last stopped at is worth saying in the refusal.
    fs.writeFileSync(queueFile, JSON.stringify({ sessionId: sid, status: 'queued' }));
    assert.deepEqual(handoff.transferInFlight(root, sid, now), { status: 'queued', phase: 'preflight' });
    fs.rmSync(recordFile);
    assert.deepEqual(handoff.transferInFlight(root, sid, now), { status: 'queued', phase: 'not started' });
    for (const status of ['parked', 'moved', 'cancelled']) {
      fs.writeFileSync(queueFile, JSON.stringify({ sessionId: sid, status }));
      assert.equal(handoff.transferInFlight(root, sid, now), null, status);
    }
    // A session id is a path component here, so nothing but a session id is read.
    fs.writeFileSync(queueFile, JSON.stringify({ sessionId: sid, status: 'queued' }));
    assert.equal(handoff.transferInFlight(root, `../handoff-queue/${sid}`, now), null);
    assert.equal(handoff.transferInFlight(root, '', now), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Claude Code asks its folder-trust question in the directory the session resumes in,
// and that dialog stands where the prompt should be, so the continuation is never typed.
function trustDeps(f, events, trusted) {
  return deps(f, {
    trustedProjectFor: (account, cwd) => {
      assert.equal(cwd, f.project);
      return trusted[account.id] === undefined ? null : trusted[account.id];
    },
    trustProject: (account, directory) => { events.push(`trust:${account.id}:${directory}`); return true; },
  });
}

test('a Claude transfer pre-trusts the resume directory on the target before it stops the source', async () => {
  const f = fixture();
  try {
    const events = [], ancestor = path.dirname(f.project);
    const d = trustDeps(f, events, { one: ancestor });
    const restartSession = d.restartSession;
    d.restartSession = (body, options) => { events.push('stop-source'); return restartSession(body, options); };
    const result = await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d);
    assert.equal(result.status, 'done');
    // The directory key the source trusts, which is the ancestor here, not the cwd.
    assert.deepEqual(events, [`trust:two:${ancestor}`, 'stop-source']);
    const record = JSON.parse(fs.readFileSync(path.join(f.root, '.keep', 'account-handoffs', `${f.sid}.json`), 'utf8'));
    assert.equal(record.trustCarried, ancestor);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('recovery of a stopped source pre-trusts the target before it relaunches there', async () => {
  const f = fixture();
  try {
    const events = [];
    const d = trustDeps(f, events, { one: f.project });
    const restartSession = d.restartSession;
    d.restartSession = async (body, options) => {
      await restartSession(body, options);
      d.pane.alive = false;
      throw new Error('target launch failed');
    };
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d), /target launch failed/);
    assert.deepEqual(events, [`trust:two:${f.project}`]);
    const resumeExited = d.resumeExited;
    d.resumeExited = (...args) => { events.push('resume-exited'); return resumeExited(...args); };
    const recovered = await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d);
    assert.equal(recovered.status, 'done');
    assert.deepEqual(events.slice(1), [`trust:two:${f.project}`, 'resume-exited']);
    const record = JSON.parse(fs.readFileSync(path.join(f.root, '.keep', 'account-handoffs', `${f.sid}.json`), 'utf8'));
    assert.equal(record.trustCarried, f.project);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('nothing is written when the source has no trust to carry or the target already has it', async () => {
  const f = fixture();
  try {
    const events = [];
    const result = await handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, trustDeps(f, events, {}));
    assert.equal(result.status, 'done');
    assert.deepEqual(events, [], 'no evidence the operator ever trusted it: the target dialog stands');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, '.keep', 'account-handoffs', `${f.sid}.json`), 'utf8')).trustCarried,
      undefined);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
  const g = fixture();
  try {
    const events = [];
    const result = await handoff.run({ sessionId: g.sid, pane: 'pane-1', accountId: 'two' },
      trustDeps(g, events, { one: g.project, two: g.project }));
    assert.equal(result.status, 'done');
    assert.deepEqual(events, [], 'the target already trusts it');
  } finally { fs.rmSync(g.base, { recursive: true, force: true }); }
});

test('a target that cannot be pre-trusted refuses the transfer with the source still running', async () => {
  const f = fixture();
  try {
    const d = deps(f, {
      trustedProjectFor: (account) => account.id === 'one' ? f.project : null,
      trustProject: () => { throw new Error('claude state file is locked'); },
      restartSession: async () => assert.fail('the source must not be stopped'),
    });
    await assert.rejects(handoff.run({ sessionId: f.sid, pane: 'pane-1', accountId: 'two' }, d),
      (error) => error.status === 409
        && error.message === `Target account could not pre-trust ${f.project}: claude state file is locked`);
    assert.equal(d.pane.alive, true);
    assert.equal(d.continuations(), 0);
    assert.equal(fs.existsSync(path.join(f.profiles.two, 'projects', f.projectName, `${f.sid}.jsonl`)), false);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a target parked on the folder-trust dialog is a blocked refusal, not a transient one', () => {
  assert.equal(handoff.classifyRefusal(
    'claude is awaiting workspace trust in pane pane-1; accept it there, then retry delivery'), 'blocked');
});
