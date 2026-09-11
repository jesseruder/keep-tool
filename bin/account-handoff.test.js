'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const accounts = require('./accounts');
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

test('explicit handoff moves one conversation across three-account infrastructure and continues once', async () => {
  const f = fixture();
  try {
    const d = deps(f);
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
    for (const flag of ['--settings custom.json', '--tools Read', '--allowed-tools Read', '--disallowed-tools', '--restricted']) {
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
