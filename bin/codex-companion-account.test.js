'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const companion = require('./codex-companion-account.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-companion-account-'));
  const workspace = path.join(root, 'workspace');
  const script = path.join(root, 'codex-companion.mjs');
  const defaultDir = path.join(root, 'codex-default');
  const secondaryDir = path.join(root, 'codex-secondary');
  const claudeDir = path.join(root, 'claude-secondary');
  for (const dir of [workspace, defaultDir, secondaryDir, claudeDir]) fs.mkdirSync(dir);
  fs.writeFileSync(script, '');
  const records = [
    { id: 'codex-primary', label: 'Codex Primary', agent: 'codex', configDir: defaultDir, managed: true },
    { id: 'codex-secondary', label: 'Codex Secondary', agent: 'codex', configDir: secondaryDir, managed: true },
    { id: 'claude-secondary', label: 'Claude Secondary', agent: 'claude', configDir: claudeDir, managed: true },
  ];
  const accountStore = {
    get: (id) => records.find((entry) => entry.id === id) || null,
    defaultFor: (agent) => records.find((entry) => entry.agent === agent),
    list: () => records,
  };
  return { root, workspace, script, records, accountStore,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function exited(code = 0) {
  const child = new EventEmitter();
  process.nextTick(() => child.emit('exit', code, null));
  return child;
}

test('account wrapper forwards task controls and isolates profile, state, and broker environment', async () => {
  const f = fixture();
  try {
    let prepared = null; let launched = null; let stderr = '';
    const result = await companion.run(['--account', 'codex-secondary', 'task', '--background', '--write',
      '--model', 'gpt-5.6-sol', '--effort', 'high', 'implement this'], {
      root: f.root, cwd: f.workspace, accounts: f.accountStore, companionScript: f.script,
      env: { KEEP_DIR: f.root, KEEP_AGENT_ACCOUNT_ID: 'claude-secondary', KEEP_PANE: 'claude-pane',
        KEEP_CODEX_CLIENT_TOKEN: 'old-client', CLAUDE_CONFIG_DIR: f.records[2].configDir,
        CODEX_COMPANION_SESSION_ID: 'parent-claude-session', CODEX_COMPANION_TRANSCRIPT_PATH: '/parent/transcript.jsonl',
        CODEX_COMPANION_APP_SERVER_ENDPOINT: 'unix:/other-account.sock',
        CODEX_COMPANION_APP_SERVER_PID_FILE: '/other/pid', CODEX_COMPANION_APP_SERVER_LOG_FILE: '/other/log' },
      prepareProfile: (agent, account) => { prepared = { agent, account }; },
      spawn: (file, args, options) => { launched = { file, args, options }; return exited(); },
      stderr: { write: (value) => { stderr += value; } },
      execFileSync: () => `${f.workspace}\n`,
    });
    assert.equal(result.code, 0);
    assert.deepEqual(prepared, { agent: 'codex', account: f.records[1] });
    assert.deepEqual(launched.args, [f.script, 'task', '--background', '--write', '--model',
      'gpt-5.6-sol', '--effort', 'high', 'implement this']);
    assert.equal(launched.options.env.CODEX_HOME, f.records[1].configDir);
    assert.equal(launched.options.env.KEEP_AGENT_ACCOUNT_ID, 'codex-secondary');
    assert.equal(launched.options.env.CODEX_COMPANION_SESSION_ID, 'parent-claude-session');
    assert.equal(launched.options.env.CODEX_COMPANION_TRANSCRIPT_PATH, '/parent/transcript.jsonl');
    assert.equal(launched.options.env.CLAUDE_CONFIG_DIR, f.records[2].configDir);
    for (const key of [...companion.BROKER_ENV, 'KEEP_PANE', 'KEEP_CODEX_CLIENT_TOKEN']) {
      assert.equal(launched.options.env[key], undefined, key);
    }
    assert.match(launched.options.env.CLAUDE_PLUGIN_DATA, /codex-companion\/accounts\/codex-secondary-/);
    assert.match(stderr, /Codex Secondary \(codex-secondary\)/);
    const manifest = JSON.parse(fs.readFileSync(path.join(launched.options.env.CLAUDE_PLUGIN_DATA, 'account.json')));
    assert.deepEqual({ accountId: manifest.accountId, agent: manifest.agent, configDir: manifest.configDir },
      { accountId: 'codex-secondary', agent: 'codex', configDir: fs.realpathSync.native(f.records[1].configDir) });
    const saved = companion.readNamespaces({ root: f.root });
    assert.equal(saved.readable, true);
    assert.deepEqual(saved.namespaces.map((item) => [item.accountId, item.pluginData]),
      [['codex-secondary', launched.options.env.CLAUDE_PLUGIN_DATA]]);
  } finally { f.cleanup(); }
});

test('invalid and non-Codex accounts fail before setup or process creation', async () => {
  const f = fixture();
  try {
    let prepared = 0; let spawned = 0;
    const options = { root: f.root, cwd: f.workspace, accounts: f.accountStore, companionScript: f.script,
      prepareProfile: () => { prepared++; }, spawn: () => { spawned++; return exited(); } };
    await assert.rejects(companion.run(['--account', 'missing', 'task', 'work'], options), /unknown account missing/);
    await assert.rejects(companion.run(['--account', 'claude-secondary', 'task', 'work'], options), /not a Codex account/);
    await assert.rejects(companion.run(['--account', 'codex-primary', 'review', '--background'], options), /usage: keep codex/);
    assert.deepEqual({ prepared, spawned }, { prepared: 0, spawned: 0 });
  } finally { f.cleanup(); }
});

test('context is read-only and account namespaces separate resume candidates by config identity', async () => {
  const f = fixture();
  try {
    const outputs = [];
    const options = { root: f.root, cwd: f.workspace, accounts: f.accountStore, companionScript: f.script,
      stdout: { write: (value) => outputs.push(value) }, execFileSync: () => `${f.workspace}\n` };
    const first = await companion.run(['--account', 'codex-primary', 'context', '--json'], options);
    const second = await companion.run(['--account', 'codex-secondary', 'context', '--json'], options);
    const implicit = await companion.run(['context', '--json'], options);
    assert.notEqual(first.context.stateDir, second.context.stateDir);
    assert.equal(first.context.accountId, 'codex-primary');
    assert.equal(second.context.accountId, 'codex-secondary');
    assert.equal(implicit.context.accountId, 'codex-primary');
    assert.equal(first.context.workspace, f.workspace);
    assert.equal(first.context.jobsDir, path.join(first.context.stateDir, 'jobs'));
    assert.equal(first.context.script, f.script);
    assert.equal(fs.existsSync(path.dirname(path.dirname(first.context.stateDir))), false,
      'context must not create the account namespace');
    assert.equal(JSON.parse(outputs[0]).accountId, 'codex-primary');

    const moved = { ...f.records[0], configDir: path.join(f.root, 'repointed-codex') };
    fs.mkdirSync(moved.configDir);
    assert.notEqual(companion.namespaceFor(f.records[0], options).pluginData,
      companion.namespaceFor(moved, options).pluginData, 'repointing one id must not reuse its prior broker namespace');
  } finally { f.cleanup(); }
});

test('namespace manifest refuses an identity mismatch', () => {
  const f = fixture();
  try {
    const namespace = companion.ensureNamespace(companion.namespaceFor(f.records[0], { root: f.root }));
    const file = path.join(namespace.pluginData, 'account.json');
    const saved = JSON.parse(fs.readFileSync(file));
    fs.writeFileSync(file, `${JSON.stringify({ ...saved, configDir: f.records[1].configDir })}\n`);
    assert.throws(() => companion.ensureNamespace(namespace), /namespace identity changed/);
  } finally { f.cleanup(); }
});

test('namespace manifest refreshes mutable policy without changing account identity', () => {
  const f = fixture();
  try {
    const original = { ...f.records[0], builtIn: true, managed: false };
    const changed = { ...original, builtIn: false, managed: true };
    const first = companion.ensureNamespace(companion.namespaceFor(original, { root: f.root }));
    const second = companion.ensureNamespace(companion.namespaceFor(changed, { root: f.root }));
    assert.equal(first.pluginData, second.pluginData);
    const saved = JSON.parse(fs.readFileSync(path.join(second.pluginData, 'account.json')));
    assert.deepEqual({ builtIn: saved.builtIn, managed: saved.managed }, { builtIn: false, managed: true });
  } finally { f.cleanup(); }
});

test('legacy environment binds saved state and clears inherited account and broker routing', () => {
  const env = companion.environmentForNamespace({ legacy: true, pluginData: '/saved/legacy-plugin' }, { env: {
    CLAUDE_PLUGIN_DATA: '/delegated/account-plugin', CODEX_HOME: '/delegated/codex-home',
    KEEP_AGENT_ACCOUNT_ID: 'codex-secondary', KEEP_PANE: 'pane', KEEP_CODEX_CLIENT_TOKEN: 'token',
    CODEX_COMPANION_APP_SERVER_ENDPOINT: 'unix:/delegated.sock',
    CODEX_COMPANION_APP_SERVER_PID_FILE: '/delegated.pid', CODEX_COMPANION_APP_SERVER_LOG_FILE: '/delegated.log',
    CODEX_COMPANION_SESSION_ID: 'parent-session',
  } });
  assert.equal(env.CLAUDE_PLUGIN_DATA, '/saved/legacy-plugin');
  assert.equal(env.CODEX_HOME, '/delegated/codex-home', 'legacy cleanup does not guess a credential profile');
  assert.equal(env.CODEX_COMPANION_SESSION_ID, 'parent-session');
  for (const key of [...companion.BROKER_ENV, 'KEEP_PANE', 'KEEP_CODEX_CLIENT_TOKEN', 'KEEP_AGENT_ACCOUNT_ID']) {
    assert.equal(env[key], undefined, key);
  }
});
