'use strict';
// An account transfer of a session whose pane is on another node, end to end through
// serve.js handoffSession: every question about the session's machine is asked of
// that node (here, the node's own modules answering in-process over two synthetic
// account directories standing in for its copies), and the daemon's own copies of the
// two accounts are never read or written.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const accounts = require('./accounts');
const handoff = require('./account-handoff');
const nodeOps = require('./account-handoff-node');
const sessionArtifacts = require('./session-artifacts');
const nodeTranscript = require('./node-transcript');

const line = (value) => `${JSON.stringify(value)}\n`;

function fleet(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-node-handoff-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'registry');
  // The node's copies of four accounts. The daemon's own copies are elsewhere, and
  // stay empty: a transfer of a node session must never touch them.
  const node = Object.fromEntries(['one', 'two', 'cxOne', 'cxTwo'].map((name) => [name, path.join(base, 'node-home', name)]));
  const project = path.join(base, 'repo');
  for (const dir of [root, project, ...Object.values(node)]) fs.mkdirSync(dir, { recursive: true });
  const list = [
    { id: 'one', label: 'One', agent: 'claude', configDir: node.one },
    { id: 'two', label: 'Two', agent: 'claude', configDir: node.two },
    { id: 'cx-one', label: 'Codex One', agent: 'codex', configDir: node.cxOne },
    { id: 'cx-two', label: 'Codex Two', agent: 'codex', configDir: node.cxTwo },
  ];
  const config = path.join(base, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: list, defaultAccounts: { claude: 'one', codex: 'cx-one' } }));
  const env = { ...process.env, KEEP_DIR: root, KEEP_CONFIG: config };
  delete env.CLAUDE_CODE_SESSION_ID;
  return { base, root, node, project, list, env };
}

// The node's host: its own modules, answering for its own account directories.
function nodeHost(f, answers = {}) {
  const asked = [];
  // Two accounts set up on their own each have their own project memory, which the
  // real comparison refuses; the node's comparison is its own, and is stubbed here.
  const accountSetup = { ...require('./account-setup'), compatible: (source, target, cwd) => {
    asked.push(`compare:${source.id}>${target.id}:${cwd === f.project}`);
    return { ok: true, reasons: [] };
  } };
  const options = {
    env: f.env, accounts: () => f.list, accountSetup,
    claudeAuth: answers.claudeAuth || (async (account) => ({ loggedIn: true, configDirectory: account.configDir })),
    codexAuth: answers.codexAuth || (async () => true),
  };
  const request = async (type, params, opts = {}) => {
    asked.push(`${type}${params && params.op ? `:${params.op}` : ''}@${opts.node || 'main'}`);
    if (answers.down && answers.down(type, params)) throw new Error('terminal host is unavailable');
    if (type === 'hello') return { artifacts: answers.artifactsVersion || 3, transcript: 4, guardedInput: true, guardedInputReceipts: true };
    assert.equal(opts.node, 'aws1', `${type} is asked of the session's node`);
    if (type === 'artifacts') return sessionArtifacts.handle(params, options);
    if (type === 'transcript') return nodeTranscript.handle(params, options);
    throw new Error(`the node was asked ${type}`);
  };
  return { request, asked };
}

function paneFor(f, sid, agent, accountId, extraMeta = {}) {
  return { id: 'p7@aws1', node: 'aws1', hostPaneId: 'p7', pid: 10, createdAt: 'source-pane', alive: true, agentAlive: true,
    cwd: f.project, cols: 80, rows: 24, meta: { sessionId: sid, agent, accountId, ...extraMeta } };
}

// The node's process table as the pane stands: its shell, and the agent under it.
function tableFor(pane, sid, agent, stopped) {
  const args = agent === 'codex' ? `codex resume ${sid}` : `claude --dangerously-skip-permissions --resume ${sid}`;
  return () => (stopped() ? [{ pid: 1, ppid: 0, pidStart: 'boot', args: 'init' }] : [
    { pid: 1, ppid: 0, pidStart: 'boot', args: 'init' },
    { pid: pane.pid, ppid: 1, pidStart: `shell-${pane.pid}`, args: '-zsh' },
    { pid: pane.pid + 1, ppid: pane.pid, pidStart: `agent-${pane.pid + 1}`, args, agent, interactive: true },
  ]);
}

function serveDeps(f, host, pane, rows, extra = {}) {
  return {
    root: f.root, env: f.env, daemonNode: 'main', hostNodes: ['main', 'aws1'], hostRequest: host.request,
    listHostPaneResult: async () => ({ panes: [pane], nodes: { main: { ok: true }, aws1: { ok: true } } }),
    buildState: async () => ({ sessions: [] }),
    addHostSessionState: async (state) => state,
    agentProcessRows: async (_deps, options = {}) => { assert.equal(options.node, 'aws1'); return rows(); },
    ...extra,
  };
}

test('a node answers the transfer ops for its own accounts only, and never with what the CLI printed', async (t) => {
  const f = fleet(t);
  const options = { env: f.env, accounts: () => f.list,
    claudeAuth: async () => ({ loggedIn: true, configDirectory: f.node.two, token: 'never returned' }) };
  const two = { id: 'two', configDir: f.node.two };
  assert.deepEqual(await nodeOps.handle({ op: 'auth', account: two }, options),
    { account: 'two', loggedIn: true, configDirectory: f.node.two });
  await assert.rejects(nodeOps.handle({ op: 'auth', account: { id: 'two', configDir: f.node.one } }, options),
    (error) => error.code === 'artifacts-refused' && /is not a claude account on this node/.test(error.message));
  await assert.rejects(nodeOps.handle({ op: 'auth', account: { id: 'cx-one', configDir: f.node.cxOne } }, options),
    /is not a claude account on this node/);
  assert.deepEqual(await nodeOps.handle({ op: 'auth', kind: 'codex', account: { id: 'cx-one', configDir: f.node.cxOne } },
    { ...options, codexAuth: async () => false }), { account: 'cx-one', loggedIn: false, configDirectory: null });
  // Project trust: read, then written for exactly the path named, on this node's copy.
  const stateOne = path.join(f.node.one, '.claude.json');
  fs.writeFileSync(stateOne, JSON.stringify({ projects: { [f.project]: { hasTrustDialogAccepted: true } } }));
  const nested = path.join(f.project, 'nested'); fs.mkdirSync(nested);
  assert.deepEqual(await nodeOps.handle({ op: 'project-trust', account: { id: 'one', configDir: f.node.one }, path: nested }, options),
    { trusted: f.project });
  assert.deepEqual(await nodeOps.handle({ op: 'project-trust', account: two, path: nested }, options), { trusted: null });
  assert.deepEqual(await nodeOps.handle({ op: 'project-trust', account: two, path: f.project, trust: true }, options),
    { trusted: f.project, changed: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.node.two, '.claude.json'), 'utf8')).projects[f.project].hasTrustDialogAccepted, true);
  await assert.rejects(nodeOps.handle({ op: 'project-trust', account: two, path: 'relative/path' }, options), /must be an absolute path/);
  // Shared setup: an account with no manifest has none to prepare.
  assert.deepEqual(await nodeOps.handle({ op: 'shared-setup', account: two, cwd: f.project }, options),
    { account: 'two', managed: false, mcpConfig: null });
  // Through the verb, as the host dispatches it.
  assert.equal((await sessionArtifacts.handle({ op: 'project-trust', account: two, path: f.project }, options)).trusted, f.project);
});


function claudeSession(f, sid) {
  const projectName = '-repo';
  const dir = path.join(f.node.one, 'projects', projectName);
  fs.mkdirSync(path.join(dir, sid, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`),
    line({ type: 'user', sessionId: sid, cwd: f.project, message: { role: 'user', content: 'start' } })
    + line({ type: 'assistant', sessionId: sid, cwd: f.project, message: { role: 'assistant', model: 'claude-opus-4-1',
      usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn', content: [{ type: 'text', text: 'ready' }] } }));
  fs.writeFileSync(path.join(dir, sid, 'subagents', 'agent-a.jsonl'), line({ type: 'assistant' }));
  fs.mkdirSync(path.join(f.node.one, 'file-history', sid), { recursive: true });
  fs.writeFileSync(path.join(f.node.one, 'file-history', sid, 'edit@v1'), 'body');
  // Owner answered the folder-trust question for this project on the source.
  fs.writeFileSync(path.join(f.node.one, '.claude.json'), JSON.stringify({ projects: { [f.project]: { hasTrustDialogAccepted: true } } }));
  return { projectName, transcript: path.join(dir, `${sid}.jsonl`) };
}

// restartSession as the transfer sees it: the forced stop on the node, then the
// relaunch handed back through replaceExited to the node's host.
function nodeRestart(pane, state, sid, agent) {
  const calls = [];
  const restartSession = async (body, options) => {
    calls.push({ body, ownerForce: options.ownerForce, hasHost: Object.prototype.hasOwnProperty.call(options, 'host') });
    state.stopped = true; pane.alive = false;
    const launched = await options.replaceExited({ paneId: pane.id, expectedPid: pane.pid,
      meta: { sessionId: sid, agent, accountId: options.resumeAccount.id } }, async (params) => {
      calls.push({ replace: params.paneId, handoffTransactionId: params.meta.handoffTransactionId });
      pane.alive = true; pane.pid = 20; pane.createdAt = 'target-pane'; pane.meta = { ...pane.meta, ...params.meta };
      state.stopped = false;
      return { pane: { ...pane } };
    });
    return { ok: true, pane: launched.pane.id, pid: launched.pane.pid };
  };
  return { restartSession, calls };
}

test('a Claude session on a node is transferred there: login, trust and artifacts on the node, stop proven from its table', async (t) => {
  const f = fleet(t);
  const sid = 'node-claude-1';
  const { projectName } = claudeSession(f, sid);
  accounts.pinSession(sid, 'claude', 'one', { root: f.root, env: f.env, node: 'aws1' });
  const pane = paneFor(f, sid, 'claude', 'one', { model: 'claude-opus-4-1' });
  const state = { stopped: false };
  const host = nodeHost(f);
  const restart = nodeRestart(pane, state, sid, 'claude');
  const continued = [];
  const deps = serveDeps(f, host, pane, tableFor(pane, sid, 'claude', () => state.stopped), {
    restartSession: restart.restartSession,
    waitForAccountRecord: async (_sid, paneId, accountId, after) => ({ pane: paneId, accountId, agent: 'claude', startedAt: after + 1 }),
    continueSession: async (id, text, options) => { continued.push({ id, text, targetIdentity: options.targetIdentity }); },
  });
  const result = await require('./serve').handoffSession({ sessionId: sid, pane: 'p7@aws1', accountId: 'two', ownerForce: true }, deps);
  assert.equal(result.status, 'done');
  // Stopped forcibly, on the node, and relaunched through its host with this transaction's mark.
  assert.equal(restart.calls[0].ownerForce, true);
  assert.equal(restart.calls[0].hasHost, false);
  assert.equal(restart.calls[1].replace, 'p7@aws1');
  assert.equal(restart.calls[1].handoffTransactionId, result.id);
  // The node was asked the login of the target and the trust of both accounts; the
  // artifacts were walked between its two account directories.
  for (const op of ['artifacts:auth@aws1', 'artifacts:shared-setup@aws1', 'artifacts:compatible@aws1', 'artifacts:project-trust@aws1',
    'artifacts:list@aws1', 'artifacts:read@aws1', 'artifacts:stage@aws1', 'artifacts:publish@aws1', 'artifacts:release@aws1',
    'transcript:tail@aws1']) assert.ok(host.asked.includes(op), op);
  const target = path.join(f.node.two, 'projects', projectName);
  assert.equal(fs.readFileSync(path.join(target, `${sid}.jsonl`), 'utf8'),
    fs.readFileSync(path.join(f.node.one, 'projects', projectName, `${sid}.jsonl`), 'utf8'));
  assert.equal(fs.readFileSync(path.join(target, sid, 'subagents', 'agent-a.jsonl'), 'utf8'), line({ type: 'assistant' }));
  assert.equal(fs.readFileSync(path.join(f.node.two, 'file-history', sid, 'edit@v1'), 'utf8'), 'body');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.node.two, '.claude.json'), 'utf8')).projects[f.project].hasTrustDialogAccepted, true);
  // Delivered once, to the verified target in the node's pane.
  assert.equal(continued.length, 1);
  assert.equal(continued[0].text, handoff.CONTINUATION_TEXT);
  assert.equal(continued[0].targetIdentity.pane, 'p7@aws1');
  assert.equal(continued[0].targetIdentity.agentPid, 21);
  // The account moved; the machine did not.
  const authority = accounts.authority(f.root)[sid];
  assert.equal(authority.accountId, 'two'); assert.equal(authority.node, 'aws1'); assert.equal(authority.stagedAccountId, undefined);
  assert.equal(handoff.readOne(f.root, sid).node, 'aws1');
  // Nothing was staged in the registry by the walk.
  assert.equal(fs.existsSync(path.join(f.root, '.keep', 'account-artifacts')), false);
  // The copy left on the source is released: a later transfer back may replace it, and
  // the target's copy is the one a transfer put there.
  const listOptions = { env: f.env, accounts: () => f.list };
  for (const [id, dir] of [['one', f.node.one], ['two', f.node.two]]) {
    const listed = await sessionArtifacts.handle({ op: 'list', sessionId: sid, account: { id, configDir: dir } }, listOptions);
    assert.ok(listed.files.length >= 3 && listed.files.every((file) => file.owned === true), id);
  }
});

test('a target logged in on the daemon but not on the node is refused with the source left running', async (t) => {
  const f = fleet(t);
  const sid = 'node-claude-2';
  claudeSession(f, sid);
  accounts.pinSession(sid, 'claude', 'one', { root: f.root, env: f.env, node: 'aws1' });
  const pane = paneFor(f, sid, 'claude', 'one', { model: 'claude-opus-4-1' });
  const state = { stopped: false };
  const host = nodeHost(f, { claudeAuth: async (account) => ({ loggedIn: account.id !== 'two', configDirectory: account.configDir }) });
  const deps = serveDeps(f, host, pane, tableFor(pane, sid, 'claude', () => state.stopped), {
    // The daemon's own copy of the target is logged in; that is not what counts here.
    authPreflight: undefined,
    restartSession: async () => assert.fail('the source must not be stopped'),
  });
  await assert.rejects(require('./serve').handoffSession({ sessionId: sid, pane: 'p7@aws1', accountId: 'two', ownerForce: true }, deps),
    (error) => error.status === 409 && error.message === 'Target claude account is not logged in on aws1; source session was left running');
  assert.ok(host.asked.includes('artifacts:auth@aws1'));
  assert.equal(pane.alive, true);
  assert.equal(accounts.authority(f.root)[sid].accountId, 'one');
  assert.equal(fs.existsSync(path.join(f.node.two, 'projects')), false);
});

test('a node that does not answer, or whose host predates the transfer ops, is refused before anything is written', async (t) => {
  const f = fleet(t);
  const sid = 'node-claude-3';
  claudeSession(f, sid);
  accounts.pinSession(sid, 'claude', 'one', { root: f.root, env: f.env, node: 'aws1' });
  const pane = paneFor(f, sid, 'claude', 'one');
  const serve = require('./serve');
  const quiet = nodeHost(f, { down: () => true });
  await assert.rejects(serve.handoffSession({ sessionId: sid, pane: 'p7@aws1', accountId: 'two', ownerForce: true },
    serveDeps(f, quiet, pane, () => [])), (error) => error.status === 409
    // Asked for its capabilities, or (when a recent answer is remembered) for the session.
    && /^host request timed out/.test(error.message) && handoff.classifyRefusal(error.message) === 'transient');
  // Its listing says it did not answer: the same slow host, from the preflight.
  const listingQuiet = serveDeps(f, nodeHost(f), pane, () => [], {
    listHostPaneResult: async () => ({ panes: [pane], nodes: { main: { ok: true }, aws1: { ok: false, stale: true } }, missingNodes: ['aws1'] }),
  });
  await assert.rejects(serve.handoffSession({ sessionId: sid, pane: 'p7@aws1', accountId: 'two', ownerForce: true }, listingQuiet),
    (error) => error.status === 409 && handoff.classifyRefusal(error.message) === 'transient' && /host request timed out/.test(error.message));
  assert.equal(handoff.readOne(f.root, sid), null);
  // A host that predates the transfer ops is refused by name and version (another node,
  // since this process remembers aws1 answering version 3 a moment ago).
  const later = 'node-claude-5';
  accounts.pinSession(later, 'claude', 'one', { root: f.root, env: f.env, node: 'aws3' });
  const old = nodeHost(f, { artifactsVersion: 2 });
  await assert.rejects(serve.handoffSession({ sessionId: later, pane: 'p7@aws3', accountId: 'two', ownerForce: true },
    serveDeps(f, old, { ...pane, id: 'p7@aws3', node: 'aws3' }, () => [], { hostNodes: ['main', 'aws1', 'aws3'] })),
  (error) => error.status === 409 && /predates account transfers \(its artifacts verb is version 2; a transfer needs 3\)/.test(error.message));
  assert.equal(handoff.readOne(f.root, later), null);
  // A pane on one node for a session recorded on another is not a transfer at all.
  await assert.rejects(serve.handoffSession({ sessionId: sid, pane: 'p7', accountId: 'two', ownerForce: true },
    serveDeps(f, nodeHost(f), pane, () => [])), /is recorded on aws1, but pane p7 is on main/);
});

test('a target account holding other bytes for the session on the node refuses before the stop', async (t) => {
  const f = fleet(t);
  const sid = 'node-claude-4';
  const { projectName } = claudeSession(f, sid);
  const stray = path.join(f.node.two, 'projects', projectName, `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(stray), { recursive: true });
  fs.writeFileSync(stray, line({ type: 'user', message: { content: 'someone else wrote this' } }));
  accounts.pinSession(sid, 'claude', 'one', { root: f.root, env: f.env, node: 'aws1' });
  const pane = paneFor(f, sid, 'claude', 'one', { model: 'claude-opus-4-1' });
  const deps = serveDeps(f, nodeHost(f), pane, tableFor(pane, sid, 'claude', () => false), {
    restartSession: async () => assert.fail('the source must not be stopped'),
  });
  await assert.rejects(require('./serve').handoffSession({ sessionId: sid, pane: 'p7@aws1', accountId: 'two', ownerForce: true }, deps),
    new RegExp(`target session artifacts for ${sid} in two on aws1 have unrecognized changes`));
  assert.equal(fs.readFileSync(stray, 'utf8'), line({ type: 'user', message: { content: 'someone else wrote this' } }));
});

function codexSession(f, sid, child) {
  const now = new Date();
  const day = [String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')];
  const dir = path.join(f.node.cxOne, 'sessions', ...day);
  fs.mkdirSync(dir, { recursive: true });
  const context = { cwd: f.project, workspace_roots: [f.project], model: 'gpt-6-astra', effort: 'high', approval_policy: 'never',
    approvals_reviewer: 'user', sandbox_policy: { type: 'danger-full-access' }, permission_profile: { type: 'disabled' } };
  const stamp = `${day.join('-')}T10-00-00`;
  const rootFile = path.join(dir, `rollout-${stamp}-${sid}.jsonl`);
  fs.writeFileSync(rootFile, line({ type: 'session_meta', payload: { id: sid, cwd: f.project, model_provider: 'openai',
    timestamp: now.toISOString(), originator: 'codex_cli_rs' } })
    + line({ type: 'turn_context', payload: context })
    + line({ type: 'event_msg', payload: { type: 'task_complete' } }));
  const childFile = path.join(dir, `rollout-${stamp}-${child}.jsonl`);
  fs.writeFileSync(childFile, line({ type: 'session_meta', payload: { id: child, parent_thread_id: sid, cwd: f.project,
    timestamp: now.toISOString() } }));
  return { rootFile, childFile, relRoot: path.relative(f.node.cxOne, rootFile) };
}

test('a Codex session on a node is transferred there with its resume policy and owned threads', async (t) => {
  const f = fleet(t);
  const sid = crypto.randomUUID();
  const child = crypto.randomUUID();
  const { rootFile, relRoot } = codexSession(f, sid, child);
  accounts.pinSession(sid, 'codex', 'cx-one', { root: f.root, env: f.env, node: 'aws1' });
  const pane = paneFor(f, sid, 'codex', 'cx-one');
  const state = { stopped: false };
  const host = nodeHost(f);
  const restart = nodeRestart(pane, state, sid, 'codex');
  const table = tableFor(pane, sid, 'codex', () => state.stopped);
  const targetFile = path.join(f.node.cxTwo, relRoot);
  const continued = [];
  const deps = serveDeps(f, host, pane, table, {
    // A Codex agent is named by the rollout it holds open, which the node reports.
    lsof: async (pids) => pids.map((pid) => `p${pid}\nn${pane.meta.accountId === 'cx-two' ? targetFile : rootFile}`).join('\n'),
    statMtime: async () => 1,
    restartSession: async (body, options) => {
      assert.equal(options.resumeCwd, f.project);
      assert.equal(options.resumeArgv.at(-1), sid);
      return restart.restartSession(body, options);
    },
    waitForAccountRecord: async (_sid, paneId, accountId, after) => ({ pane: paneId, accountId, agent: 'codex', startedAt: after + 1 }),
    continueSession: async (id, text, options) => { continued.push({ id, options }); },
  });
  const result = await require('./serve').handoffSession({ sessionId: sid, pane: 'p7@aws1', accountId: 'cx-two', ownerForce: true }, deps);
  assert.equal(result.status, 'done');
  for (const op of ['artifacts:auth@aws1', 'artifacts:resume-spec@aws1', 'artifacts:cwd@aws1', 'artifacts:compatible@aws1',
    'artifacts:publish@aws1', 'transcript:meta@aws1']) assert.ok(host.asked.includes(op), op);
  assert.equal(fs.readFileSync(targetFile, 'utf8'), fs.readFileSync(rootFile, 'utf8'));
  const journal = handoff.readOne(f.root, sid);
  assert.equal(journal.targetTranscript, targetFile);
  assert.equal(journal.resumeSpec.model, 'gpt-6-astra');
  assert.deepEqual([...journal.ownedSessionIds].sort(), [sid, child].sort());
  assert.equal(continued.length, 1);
  assert.equal(continued[0].options.targetTranscript, targetFile);
  for (const id of [sid, child]) {
    const authority = accounts.authority(f.root)[id];
    assert.equal(authority.accountId, 'cx-two'); assert.equal(authority.node, 'aws1', `${id} stays on the node`);
  }
});

test('the continuation reaches the target on the node, receipted from the target account\'s transcript there', async (t) => {
  const f = fleet(t);
  const serve = require('./serve');
  await serve.closeHostClient();
  t.after(() => serve.closeHostClient());
  const sid = 'node-claude-deliver';
  const { projectName } = claudeSession(f, sid);
  // The transfer has published its copy and staged the target; the delivery is next.
  const targetFile = path.join(f.node.two, 'projects', projectName, `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.copyFileSync(path.join(f.node.one, 'projects', projectName, `${sid}.jsonl`), targetFile);
  accounts.pinSession(sid, 'claude', 'one', { root: f.root, env: f.env, node: 'aws1' });
  accounts.stageSession(sid, 'two', 'tx-node', { root: f.root, env: f.env });
  let draft = '';
  let inputCount = 0;
  const receipts = new Map();
  const pane = () => ({ id: 'p7', pid: 40, createdAt: 100, alive: true, agentAlive: true, inputCount, cwd: f.project,
    meta: { sessionId: sid, agent: 'claude', accountId: 'two', handoffTransactionId: 'tx-node' } });
  const typed = [];
  const nodeClient = { request: async (type, params) => {
    if (type === 'hello') return { guardedInput: true, guardedInputReceipts: true, replaceExited: true };
    if (type === 'list') return { panes: [pane()] };
    if (type === 'get') return { pane: pane() };
    if (type === 'screen') return { text: `────────────────────\n❯ ${draft}\n────────────────────`, cursor: { x: draft.length + 2, y: 1 } };
    if (type === 'input') {
      const value = Buffer.from(params.data, 'base64').toString();
      if (params.operationId && receipts.has(params.operationId)) return receipts.get(params.operationId);
      assert.equal(params.pane, 'p7', 'keys go to the node\'s own pane id');
      if (params.expectedInputCount !== undefined && params.expectedInputCount !== inputCount) return { dropped: true, reason: 'input arrived', inputCount };
      inputCount += 1;
      typed.push(value);
      if (value === '\r') {
        fs.appendFileSync(targetFile, line({ type: 'user', sessionId: sid, message: { content: draft } }));
        draft = '';
      } else if (value === '\x7f') draft = draft.slice(0, -1);
      else draft += value;
      const result = { accepted: true, inputCount };
      if (params.operationId) receipts.set(params.operationId, result);
      return result;
    }
    return {};
  } };
  const mainClient = { request: async (type) => (type === 'list' ? { panes: [] } : {}) };
  const host = nodeHost(f);
  const rows = [
    { pid: 40, ppid: 1, pidStart: 'shell-40', args: '-zsh' },
    { pid: 41, ppid: 40, pidStart: 'agent-41', args: `claude --resume ${sid}`, agent: 'claude', interactive: true },
  ];
  const targetIdentity = { pane: 'p7@aws1', panePid: 40, paneCreatedAt: 100, sessionId: sid, accountId: 'two',
    transactionId: 'tx-node', agentPid: 41, agentPidStart: 'agent-41', ownsPane: true, sessionStartedAt: 200 };
  const deliveryDirectory = path.join(f.root, '.keep', 'delivery');
  const result = await serve.continueAccountHandoff(sid, 'p7@aws1', 'two', handoff.CONTINUATION_TEXT, 'tx-deliver', {
    agent: 'claude', transactionId: 'tx-node', sourceStopVerifiedAt: 1, targetIdentity,
  }, {
    root: f.root, env: f.env, daemonNode: 'main', hostNodes: ['main', 'aws1'], hostRequest: host.request,
    connectHost: async (target) => (target.node === 'aws1' ? nodeClient : mainClient),
    sleep: async () => {}, deliveryDirectory,
    readPaneRecord: () => ({ pane: 'p7@aws1', accountId: 'two', startedAt: 200 }),
    agentProcessRows: async (_deps, options = {}) => { assert.equal(options.node, 'aws1'); return rows; },
  });
  assert.equal(result.delivery, 'received');
  assert.equal(typed.join(''), `${handoff.CONTINUATION_TEXT}\r`);
  assert.match(fs.readFileSync(targetFile, 'utf8'), /Continue the work from the request/);
  assert.doesNotMatch(fs.readFileSync(path.join(f.node.one, 'projects', projectName, `${sid}.jsonl`), 'utf8'), /Continue the work/);
  assert.ok(host.asked.includes('transcript:match@aws1'), 'the receipt came from the node');
  // An agent that is not the verified one in that pane gets nothing.
  rows[1] = { ...rows[1], pidStart: 'someone-else' };
  typed.length = 0;
  await assert.rejects(serve.continueAccountHandoff(sid, 'p7@aws1', 'two', 'Do not send this.', 'tx-deliver-2', {
    agent: 'claude', transactionId: 'tx-node', sourceStopVerifiedAt: 1, targetIdentity,
  }, {
    root: f.root, env: f.env, daemonNode: 'main', hostNodes: ['main', 'aws1'], hostRequest: host.request,
    connectHost: async (target) => (target.node === 'aws1' ? nodeClient : mainClient),
    sleep: async () => {}, deliveryDirectory,
    readPaneRecord: () => ({ pane: 'p7@aws1', accountId: 'two', startedAt: 200 }),
    agentProcessRows: async () => rows,
  }), /destination agent identity changed; nothing was sent/);
  assert.deepEqual(typed, []);
});

test('an interrupted transfer on a node is relaunched there, only once its table shows nothing running', async (t) => {
  const f = fleet(t);
  const serve = require('./serve');
  await serve.closeHostClient();
  t.after(() => serve.closeHostClient());
  const sid = 'node-claude-relaunch';
  accounts.pinSession(sid, 'claude', 'one', { root: f.root, env: f.env, node: 'aws1' });
  const two = accounts.get('two', f.env);
  let replacement = null;
  const nodeClient = { request: async (type, params) => {
    assert.equal(params.pane || params.paneId, 'p7', 'the node is asked about its own pane id');
    if (type === 'get') return { pane: { id: 'p7', pid: 10, createdAt: 'source-pane', alive: false, cols: 80, rows: 24,
      meta: { sessionId: sid, agent: 'claude', accountId: 'one' } } };
    assert.equal(type, 'replace-exited'); replacement = params;
    return { pane: { id: 'p7', pid: 20, createdAt: 'target-pane', alive: true } };
  } };
  let running = true;
  const prepared = [];
  const deps = {
    root: f.root, env: f.env, daemonNode: 'main', hostNodes: ['main', 'aws1'],
    connectHost: async (target) => { assert.equal(target.node, 'aws1'); return nodeClient; },
    agentProcessRows: async (_deps, options = {}) => {
      assert.equal(options.node, 'aws1');
      return running
        ? [{ pid: 30, ppid: 1, pidStart: 'x', args: `claude --resume ${sid}`, agent: 'claude', interactive: true }]
        : [{ pid: 1, ppid: 0, pidStart: 'boot', args: 'init' }];
    },
    prepareLaunchOn: async (node, options) => { prepared.push({ node, options }); return { command: 'node-launcher claude --resume' }; },
    waitForHostAgent: async () => {},
  };
  const entry = { id: 'tx-relaunch', sessionId: sid, pane: 'p7@aws1', pid: 10, agent: 'claude', cwd: f.project,
    cols: 80, rows: 24, permissionClass: 'bypass', model: 'claude-opus-4-1' };
  await assert.rejects(serve.resumeExitedAccountHandoff(entry, two, '/local/only/mcp.json', deps),
    /An agent process still owns this conversation/);
  assert.equal(replacement, null);
  running = false;
  const launched = await serve.resumeExitedAccountHandoff(entry, two, '/local/only/mcp.json', deps);
  assert.equal(launched.pane, 'p7@aws1');
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].node, 'aws1');
  assert.equal(prepared[0].options.account.id, 'two');
  // The daemon's MCP path is never sent: the node splices in its own.
  assert.deepEqual(prepared[0].options.argv, ['claude', '--dangerously-skip-permissions', { insert: 'mcpConfig' },
    '--model', 'claude-opus-4-1', '--resume', sid]);
  assert.deepEqual(replacement.args, ['-lic', 'exec node-launcher claude --resume']);
  assert.equal(replacement.meta.accountId, 'two');
  assert.equal(replacement.meta.handoffTransactionId, 'tx-relaunch');
});

test('a Codex transfer on a node needs the transcript meta op, and is refused by name before any work', async (t) => {
  const f = fleet(t);
  const sid = crypto.randomUUID();
  accounts.pinSession(sid, 'codex', 'cx-one', { root: f.root, env: f.env, node: 'aws4' });
  const asked = [];
  const deps = {
    root: f.root, env: f.env, daemonNode: 'main', hostNodes: ['main', 'aws4'],
    hostRequest: async (type) => { asked.push(type); return type === 'hello' ? { artifacts: 3, transcript: 3 } : assert.fail(`asked ${type}`); },
    inspect: async () => assert.fail('nothing about the session is inspected'),
  };
  await assert.rejects(require('./serve').handoffSession({ sessionId: sid, pane: 'p7@aws4', accountId: 'cx-two', ownerForce: true }, deps),
    (error) => error.status === 409
      && /predates Codex account transfers \(its transcript verb is version 3; a Codex transfer needs 4\)/.test(error.message));
  assert.deepEqual(asked, ['hello']);
  assert.equal(handoff.readOne(f.root, sid), null);
});

test('whether a node still holds a conversation reads every process there, not only the recorded ones', async () => {
  const serve = require('./serve');
  const sid = 'node-held-session';
  // The agent and the pane are gone; a descendant reparented to init kept the
  // session in its environment, and nothing recorded its pid.
  const rows = [
    { pid: 1, ppid: 0, pidStart: 'boot', args: 'init' },
    { pid: 70, ppid: 1, pidStart: 'shell', args: '-zsh' },
    { pid: 77, ppid: 1, pidStart: 'survivor', args: 'node mcp-server.js' },
  ];
  const nodeAnswers = (env, extra = {}) => async (type, params, opts) => {
    assert.equal(type, 'process'); assert.equal(opts.node, 'aws1');
    if (!params.pids) return { rows };
    assert.deepEqual(params.pids, [70, 77], 'every process on the node is asked about');
    return { rows, env, ...extra };
  };
  const deps = (env, extra) => ({ daemonNode: 'main', hostNodes: ['main', 'aws1'], hostRequest: nodeAnswers(env, extra),
    agentProcessRows: async () => rows });
  assert.equal(await serve.sessionHeldOn('aws1', sid, 'claude', deps([{ pid: 77, sessionId: sid }])), true);
  assert.equal(await serve.sessionHeldOn('aws1', sid, 'claude', deps([{ pid: 77, sessionId: 'another-session' }])), false);
  // A Codex rollout held open counts as holding it.
  assert.equal(await serve.sessionHeldOn('aws1', sid, 'codex',
    deps([], { files: [{ pid: 77, path: `/n/sessions/2026/01/01/rollout-x-${sid}.jsonl`, id: sid }] })), true);
  // Environments that could not be read prove nothing.
  await assert.rejects(serve.sessionHeldOn('aws1', sid, 'claude', deps(undefined)), /environments on aws1 could not be read/);
  await assert.rejects(serve.sessionHeldOn('aws1', sid, 'codex', deps([])), /open rollouts on aws1 could not be read/);
});

test('a machine with more processes than the ownership check reads is never taken as proof', async () => {
  const serve = require('./serve');
  const handoff = require('./account-handoff');
  const sid = 'node-held-crowded';
  // The writer is the last of 16,390 processes, past any slice, and its arguments do
  // not name the session.
  const rows = [{ pid: 1, ppid: 0, pidStart: 'boot', args: 'init' },
    ...Array.from({ length: 16390 }, (_, i) => ({ pid: i + 2, ppid: 1, pidStart: `p${i}`, args: 'sleep 1' }))];
  const envAsked = [];
  const deps = { daemonNode: 'main', hostNodes: ['main', 'aws1'], agentProcessRows: async () => rows,
    hostRequest: async (_type, params) => {
      if (params.pids) envAsked.push(params.pids.length);
      return { rows, env: [{ pid: 16391, sessionId: sid }] };
    } };
  await assert.rejects(serve.sessionHeldOn('aws1', sid, 'claude', deps),
    /aws1 runs 16390 processes, more than the 16384 an ownership check reads/);
  assert.deepEqual(envAsked, [], 'no partial read is taken');
  // Through a transfer's proof, that is a stop not yet verified, which a retry may clear.
  const message = `Source exit could not be verified: the session's processes could not be read (aws1 runs 16390 processes, more than the 16384 an ownership check reads)`;
  assert.equal(handoff.classifyRefusal(message), 'transient');
});
