'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const accounts = require('./accounts');
const launcher = require('./agent-launcher');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-accounts-'));
  const config = path.join(root, 'config.json');
  const dirs = Object.fromEntries(['a', 'b', 'c', 'codex'].map((id) => [id, path.join(root, id)]));
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
    { id: 'a', label: 'Claude A', agent: 'claude', configDir: dirs.a },
    { id: 'b', label: 'Claude B', agent: 'claude', configDir: dirs.b },
    { id: 'c', label: 'Claude C', agent: 'claude', configDir: dirs.c },
    { id: 'codex-work', label: 'Codex work', agent: 'codex', configDir: dirs.codex },
  ], defaultAccounts: { claude: 'a', codex: 'codex-work' }, automationAccounts: { reviewer: 'b' } }));
  return { root, dirs, env: { KEEP_CONFIG: config, KEEP_DIR: path.join(root, 'registry') } };
}

test('three Claude accounts validate with explicit defaults and safe public metadata', () => {
  const f = fixture();
  try {
    assert.equal(accounts.list(f.env).filter((entry) => entry.agent === 'claude').length, 3);
    assert.equal(accounts.defaultFor('claude', f.env).id, 'a');
    assert.equal(accounts.automationFor('claude', 'reviewer', f.env).id, 'b');
    const state = accounts.publicState(f.env);
    assert.equal(state.accounts.find((entry) => entry.id === 'a').handoffSupported, true);
    assert.equal(state.accounts.find((entry) => entry.agent === 'codex').handoffSupported, false);
    assert.equal(JSON.stringify(state).includes(f.root), false, 'config paths stay private');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('profile environment isolates managed credentials while native no-config behavior stays compatible', () => {
  const f = fixture();
  try {
    const isolated = accounts.envFor('b', { ANTHROPIC_API_KEY: 'secret', ANTHROPIC_BASE_URL: 'https://wrong', CLAUDE_CODE_OAUTH_FILE_SUFFIX: '-wrong' }, f.env);
    assert.equal(isolated.ANTHROPIC_API_KEY, undefined);
    assert.equal(isolated.ANTHROPIC_BASE_URL, undefined);
    assert.equal(isolated.CLAUDE_CODE_OAUTH_FILE_SUFFIX, undefined);
    assert.equal(isolated.CLAUDE_CONFIG_DIR, f.dirs.b);
    assert.equal(isolated.KEEP_AGENT_ACCOUNT_ID, 'b');
    const native = accounts.defaultFor('claude', { KEEP_DIR: path.join(f.root, 'isolated') });
    const legacy = launcher.profileEnvironment('claude', native, { ANTHROPIC_API_KEY: 'legacy', CLAUDE_CONFIG_DIR: '/wrong' });
    assert.equal(legacy.ANTHROPIC_API_KEY, 'legacy');
    assert.equal(legacy.CLAUDE_CONFIG_DIR, undefined);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('resume hints route configured profiles through authoritative keep open', () => {
  const f = fixture();
  try {
    const session = { id: 'resume-me', agent: 'claude' };
    assert.equal(require('./keep.js').resumeCommand(session, f.env), 'keep open resume-me');
    assert.equal(require('./keep.js').resumeCommand(session, { KEEP_DIR: path.join(f.root, 'legacy') }), 'claude --resume resume-me');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('authority is sticky, staged handoffs block ordinary resume, and duplicate roots need authority', () => {
  const f = fixture(), sid = 'session-1';
  try {
    for (const id of ['a', 'b']) {
      const project = path.join(f.dirs[id], 'projects', '-repo');
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(path.join(project, `${sid}.jsonl`), '{}\n');
    }
    assert.throws(() => accounts.forSession(sid, 'claude', { root: f.env.KEEP_DIR, env: f.env }), /multiple accounts/);
    accounts.pinSession(sid, 'claude', 'a', { root: f.env.KEEP_DIR, env: f.env });
    assert.equal(accounts.forSession(sid, 'claude', { root: f.env.KEEP_DIR, env: f.env }).id, 'a');
    accounts.stageSession(sid, 'b', 'tx', { root: f.env.KEEP_DIR, env: f.env });
    assert.throws(() => accounts.forSession(sid, 'claude', { root: f.env.KEEP_DIR, env: f.env }), /unfinished account handoff/);
    assert.equal(accounts.forSession(sid, 'claude', { root: f.env.KEEP_DIR, env: f.env, preferStaged: true }).id, 'b');
    accounts.commitStaged(sid, 'tx', { root: f.env.KEEP_DIR });
    assert.equal(accounts.forSession(sid, 'claude', { root: f.env.KEEP_DIR, env: f.env }).id, 'b');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('config rejects traversal ids and physical config directory aliases', () => {
  const f = fixture();
  try {
    assert.throws(() => accounts.add({ id: '../bad', label: 'Bad', agent: 'claude', configDir: path.join(f.root, 'bad') }, f.env), /custom account ids/);
    const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.dirs.a, alias);
    const before = fs.readFileSync(f.env.KEEP_CONFIG, 'utf8');
    assert.throws(() => accounts.add({ id: 'alias', label: 'Alias', agent: 'claude', configDir: alias }, f.env), /duplicate claude configDir/);
    assert.equal(fs.readFileSync(f.env.KEEP_CONFIG, 'utf8'), before, 'an invalid candidate is never published');
    assert.equal(accounts.list(f.env).length, 4);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
