'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const accounts = require('./accounts');
const artifacts = require('./account-artifacts');
const jobs = require('./background-jobs');
const restartLedger = require('./restart-ledger');

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-account-artifacts-'));
  const root = path.join(base, 'registry'); fs.mkdirSync(root);
  const profiles = Object.fromEntries(['a', 'b', 'c'].map((id) => [id, path.join(base, `profile-${id}`)]));
  for (const profile of Object.values(profiles)) fs.mkdirSync(profile);
  const config = path.join(base, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
    { id: 'a', label: 'A', agent: 'claude', configDir: profiles.a },
    { id: 'b', label: 'B', agent: 'claude', configDir: profiles.b },
    { id: 'c', label: 'C', agent: 'claude', configDir: profiles.c },
  ], defaultAccounts: { claude: 'a' } }));
  const env = { KEEP_CONFIG: config, KEEP_DIR: root };
  const sid = 'session-123', projectName = '-work-repo';
  const project = path.join(profiles.a, 'projects', projectName);
  fs.mkdirSync(path.join(project, sid, 'tool-results'), { recursive: true });
  fs.mkdirSync(path.join(project, sid, 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(profiles.a, 'file-history', sid), { recursive: true });
  const absoluteResult = path.join(project, sid, 'tool-results', 'a.txt');
  fs.writeFileSync(absoluteResult, 'from a');
  fs.writeFileSync(path.join(project, sid, 'subagents', 'agent-a.jsonl'), '{"agent":"a"}\n');
  fs.writeFileSync(path.join(profiles.a, 'file-history', sid, 'a.txt'), 'history a');
  fs.writeFileSync(path.join(project, `${sid}.jsonl`), `${JSON.stringify({ account: 'a', tool_result: absoluteResult })}\n`);
  const records = Object.fromEntries(accounts.list(env).filter((entry) => entry.agent === 'claude').map((entry) => [entry.id, entry]));
  return { base, root, profiles, env, sid, projectName, records, absoluteResult };
}

function project(f, accountId) { return path.join(f.profiles[accountId], 'projects', f.projectName); }
function transcript(f, accountId) { return path.join(project(f, accountId), `${f.sid}.jsonl`); }
function options(f) { return { root: f.root, env: f.env }; }
function rebindOptions(f, extra = {}) { return { ...options(f), sourceStopVerifiedAt: 1, ...extra }; }
function appendTurn(f, accountId) {
  const directory = path.join(project(f, accountId), f.sid);
  fs.mkdirSync(path.join(directory, 'tool-results'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(f.profiles[accountId], 'file-history', f.sid), { recursive: true });
  const result = path.join(directory, 'tool-results', `${accountId}.txt`);
  fs.writeFileSync(result, `from ${accountId}`);
  fs.writeFileSync(path.join(directory, 'subagents', `agent-${accountId}.jsonl`), `${JSON.stringify({ agent: accountId })}\n`);
  fs.writeFileSync(path.join(f.profiles[accountId], 'file-history', f.sid, `${accountId}.txt`), `history ${accountId}`);
  fs.appendFileSync(transcript(f, accountId), `${JSON.stringify({ account: accountId, tool_result: result })}\n`);
  return result;
}

function prepareLedger(f) {
  const child = 'child', grandchild = 'grandchild';
  const childFile = path.join(project(f, 'a'), f.sid, 'subagents', `agent-${child}.jsonl`);
  const grandchildFile = path.join(project(f, 'a'), f.sid, 'subagents', `agent-${child}`, 'subagents', `agent-${grandchild}.jsonl`);
  const at = (value) => new Date(value).toISOString();
  const parentRows = [
    { type: 'user', sessionId: f.sid, timestamp: at(1000), message: { content: 'work' } },
    { type: 'assistant', sessionId: f.sid, timestamp: at(1100), message: { stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'spawn', name: 'Agent', input: {} }] } },
    { type: 'user', sessionId: f.sid, timestamp: at(1200), message: { content: [
      { type: 'tool_result', tool_use_id: 'spawn', content: `Async agent launched successfully. agentId: ${child}` },
    ] } },
    { type: 'assistant', sessionId: f.sid, timestamp: at(1500), message: { stop_reason: 'end_turn', content: [] } },
  ];
  const childRows = [
    { type: 'assistant', sessionId: f.sid, timestamp: at(1250), message: { stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'spawn-grandchild', name: 'Agent', input: {} }] } },
    { type: 'user', sessionId: f.sid, timestamp: at(1300), message: { content: [
      { type: 'tool_result', tool_use_id: 'spawn-grandchild', content: `Async agent launched successfully. agentId: ${grandchild}` },
    ] } },
    { type: 'assistant', sessionId: f.sid, timestamp: at(1400), message: { stop_reason: 'end_turn', content: [] } },
  ];
  const grandchildRows = [{ type: 'assistant', sessionId: f.sid, timestamp: at(1350),
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'grandchild complete' }] } }];
  fs.writeFileSync(transcript(f, 'a'), parentRows.map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(childFile, childRows.map(JSON.stringify).join('\n') + '\n');
  fs.mkdirSync(path.dirname(grandchildFile), { recursive: true });
  fs.writeFileSync(grandchildFile, grandchildRows.map(JSON.stringify).join('\n') + '\n');
  const resolveChild = (id, parentFile) => path.join(path.dirname(parentFile), path.basename(parentFile, '.jsonl'),
    'subagents', `agent-${id}.jsonl`);
  const verify = (accountId) => restartLedger.verify({ root: f.root, agent: 'claude', sid: f.sid,
    file: transcript(f, accountId), instance: { id: `pane:${accountId}`, since: 1, live: true }, resolveChild })();
  verify('a');
  return { child, grandchild, resolveChild, verify };
}

function appendCompletedTurn(f, accountId, sequence) {
  fs.appendFileSync(transcript(f, accountId), [
    { type: 'user', sessionId: f.sid, timestamp: new Date(2000 + sequence * 100).toISOString(), message: { content: `turn ${sequence}` } },
    { type: 'assistant', sessionId: f.sid, timestamp: new Date(2050 + sequence * 100).toISOString(), message: { content: [], stop_reason: 'end_turn' } },
  ].map(JSON.stringify).join('\n') + '\n');
}

test('managed provenance supports A to B to C to A while retaining every source tree', () => {
  const f = fixture();
  try {
    assert.equal(artifacts.preflight(f.sid, f.records.a, f.records.b, options(f)).disposition, 'empty');
    artifacts.copyClaudeArtifacts(f.sid, f.records.a, f.records.b, 'tx-a-b', options(f));
    const bResult = appendTurn(f, 'b');
    artifacts.copyClaudeArtifacts(f.sid, f.records.b, f.records.c, 'tx-b-c', options(f));
    const cResult = appendTurn(f, 'c');
    assert.equal(artifacts.preflight(f.sid, f.records.c, f.records.a, options(f)).disposition, 'managed');
    const returned = artifacts.copyClaudeArtifacts(f.sid, f.records.c, f.records.a, 'tx-c-a', options(f));
    assert.equal(returned.reused, false);
    const text = fs.readFileSync(transcript(f, 'a'), 'utf8');
    for (const value of [f.absoluteResult, bResult, cResult]) assert.match(text, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    for (const id of ['a', 'b', 'c']) {
      assert.equal(fs.readFileSync(path.join(project(f, 'a'), f.sid, 'tool-results', `${id}.txt`), 'utf8'), `from ${id}`);
      assert.equal(fs.readFileSync(path.join(project(f, 'a'), f.sid, 'subagents', `agent-${id}.jsonl`), 'utf8'), `${JSON.stringify({ agent: id })}\n`);
      assert.equal(fs.readFileSync(path.join(f.profiles.a, 'file-history', f.sid, `${id}.txt`), 'utf8'), `history ${id}`);
    }
    assert.equal(fs.existsSync(transcript(f, 'b')), true, 'B source remains');
    assert.equal(fs.existsSync(transcript(f, 'c')), true, 'C source remains');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('transaction-bound ledgers follow A to B to C to A with child evidence and partial retry', () => {
  const f = fixture();
  try {
    const ledger = prepareLedger(f);
    const cached = Object.fromEntries(jobs.targets(f.root).map((entry) => [entry.sid, { ...entry }]));
    assert.equal(cached[f.sid].file, transcript(f, 'a'));
    assert.match(cached[ledger.child].file, new RegExp(`agent-${ledger.child}\\.jsonl$`));
    artifacts.copyClaudeArtifacts(f.sid, f.records.a, f.records.b, 'tx-ledger-a-b', options(f));
    let interrupted = false;
    assert.throws(() => artifacts.rebindLedger(f.sid, f.records.a, f.records.b, 'tx-ledger-a-b', rebindOptions(f, {
      rebindSource(args) {
        if (args.sid === ledger.child && !interrupted) { interrupted = true; throw new Error('simulated child rebind crash'); }
        return jobs.rebindSource(args);
      },
    })), /simulated child rebind crash/);
    const recovered = artifacts.rebindLedger(f.sid, f.records.a, f.records.b, 'tx-ledger-a-b', rebindOptions(f));
    assert.equal(recovered.rebound.find((entry) => entry.sessionId === f.sid).reused, true);
    assert.equal(recovered.rebound.find((entry) => entry.sessionId === ledger.child).reused, false);
    ledger.verify('b');

    appendCompletedTurn(f, 'b', 1); ledger.verify('b');
    artifacts.copyClaudeArtifacts(f.sid, f.records.b, f.records.c, 'tx-ledger-b-c', options(f));
    artifacts.rebindLedger(f.sid, f.records.b, f.records.c, 'tx-ledger-b-c', rebindOptions(f));
    ledger.verify('c');
    for (const id of [f.sid, ledger.child]) {
      const stale = jobs.sync({ root: f.root, ...cached[id], now: 1700 });
      assert.equal(stale.gap, false, `${id} cached A poll stays safe after B to C`);
      assert.match(stale.redirect.file, new RegExp(id === f.sid ? `${f.sid}\\.jsonl$` : `agent-${id}\\.jsonl$`));
      assert.equal(stale.redirect.file.startsWith(project(f, 'c') + path.sep), true);
    }

    appendCompletedTurn(f, 'c', 2); ledger.verify('c');
    artifacts.copyClaudeArtifacts(f.sid, f.records.c, f.records.a, 'tx-ledger-c-a', options(f));
    artifacts.rebindLedger(f.sid, f.records.c, f.records.a, 'tx-ledger-c-a', rebindOptions(f));
    ledger.verify('a');
    for (const id of [f.sid, ledger.child]) {
      const returned = jobs.sync({ root: f.root, ...cached[id], now: 2400 });
      assert.equal(returned.gap, false, `${id} cached A path is authoritative again after the return hop`);
      assert.equal(returned.redirect, undefined);
    }

    const parent = JSON.parse(fs.readFileSync(path.join(f.root, '.keep/background-jobs/claude', f.sid, 'state.json')));
    const child = JSON.parse(fs.readFileSync(path.join(f.root, '.keep/background-jobs/claude', ledger.child, 'state.json')));
    assert.equal(parent.gap, false); assert.equal(child.gap, false);
    assert.equal(parent.handoffRebind.transactionId, 'tx-ledger-c-a');
    assert.equal(child.handoffRebind.transactionId, 'tx-ledger-c-a');
    assert.equal(parent.jobs['job:child'].status, 'pending');
    assert.equal(child.jobs['job:grandchild'].status, 'pending');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a forced rebind moves the root past a gapped ledger and leaves a transcript-less child alone', () => {
  const f = fixture();
  try {
    const child = 'child';
    fs.writeFileSync(transcript(f, 'a'), [
      { type: 'user', sessionId: f.sid, timestamp: new Date(1000).toISOString(), message: { content: 'work' } },
      { type: 'assistant', sessionId: f.sid, timestamp: new Date(1100).toISOString(), message: { stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'spawn', name: 'Agent', input: {} }] } },
      { type: 'user', sessionId: f.sid, timestamp: new Date(1200).toISOString(), message: { content: [
        { type: 'tool_result', tool_use_id: 'spawn', content: `Async agent launched successfully. agentId: ${child}` },
      ] } },
      { type: 'assistant', sessionId: f.sid, timestamp: new Date(1500).toISOString(), message: { stop_reason: 'end_turn', content: [] } },
    ].map(JSON.stringify).join('\n') + '\n');
    jobs.sync({ root: f.root, agent: 'claude', sid: f.sid, file: transcript(f, 'a'), now: 1600 });
    const snapshot = path.join(f.root, '.keep/background-jobs/claude', f.sid, 'state.json');
    const state = JSON.parse(fs.readFileSync(snapshot));
    assert.equal(state.jobs[`job:${child}`].status, 'pending');
    assert.equal(state.restart.children[child], 'owned');
    assert.equal(fs.existsSync(path.join(project(f, 'a'), f.sid, 'subagents', `agent-${child}.jsonl`)), false,
      'the stale child has no transcript on either side');
    state.gap = true; fs.writeFileSync(snapshot, JSON.stringify(state));
    artifacts.copyClaudeArtifacts(f.sid, f.records.a, f.records.b, 'tx-force', options(f));
    assert.throws(() => artifacts.rebindLedger(f.sid, f.records.a, f.records.b, 'tx-force', rebindOptions(f)),
      /unavailable|incomplete/);
    const rebound = artifacts.rebindLedger(f.sid, f.records.a, f.records.b, 'tx-force', rebindOptions(f, { force: true }));
    assert.deepEqual(rebound.rebound.map((entry) => entry.sessionId), [f.sid], 'only the root ledger is rebound');
    const after = JSON.parse(fs.readFileSync(snapshot));
    assert.equal(after.source.file, path.resolve(transcript(f, 'b')));
    assert.equal(after.gap, true);
    assert.equal(after.jobs[`job:${child}`].status, 'pending', 'the stale child job is left exactly as it was');
    assert.equal(fs.existsSync(path.join(f.root, '.keep/background-jobs/claude', child)), false,
      'no ledger is invented for the dead child');
    // A retry of the same forced transaction is idempotent, not a second stranding.
    assert.deepEqual(artifacts.rebindLedger(f.sid, f.records.a, f.records.b, 'tx-force',
      rebindOptions(f, { force: true })).rebound, [{ sessionId: f.sid, reused: true }]);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('ledger rebind requires the exact completed artifact transaction and quiescent copy', () => {
  const f = fixture();
  try {
    prepareLedger(f);
    assert.throws(() => artifacts.rebindLedger(f.sid, f.records.a, f.records.b, 'missing-transaction', options(f)),
      /verified source stop/);
    assert.throws(() => artifacts.rebindLedger(f.sid, f.records.a, f.records.b, 'missing-transaction', rebindOptions(f)),
      /conflicts|incomplete/);
    artifacts.copyClaudeArtifacts(f.sid, f.records.a, f.records.b, 'tx-ledger-a-b', options(f));
    fs.appendFileSync(transcript(f, 'b'), 'unexpected target mutation\n');
    assert.throws(() => artifacts.rebindLedger(f.sid, f.records.a, f.records.b, 'tx-ledger-a-b', rebindOptions(f)),
      /no longer matches/);
    const sourceState = JSON.parse(fs.readFileSync(path.join(f.root, '.keep/background-jobs/claude', f.sid, 'state.json')));
    assert.equal(sourceState.source.file, path.resolve(transcript(f, 'a')));
    assert.equal(sourceState.handoffRebind, undefined);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('rebind catches up a stopped source after Claude appends its exit bookkeeping', () => {
  const f = fixture();
  try {
    const initial = { type: 'assistant', sessionId: f.sid, timestamp: new Date(1000).toISOString(),
      message: { content: [], stop_reason: 'end_turn' } };
    fs.writeFileSync(transcript(f, 'a'), JSON.stringify(initial) + '\n');
    jobs.sync({ root: f.root, agent: 'claude', sid: f.sid, file: transcript(f, 'a'), now: 1100 });
    const exitRows = [
      { type: 'file-history-snapshot', sessionId: f.sid, timestamp: new Date(1200).toISOString(), snapshot: {} },
      { type: 'last-prompt', sessionId: f.sid, timestamp: new Date(1210).toISOString(), prompt: '/exit' },
      { type: 'cost-state', sessionId: f.sid, timestamp: new Date(1220).toISOString(), costUSD: 0 },
      { type: 'user', isMeta: true, sessionId: f.sid, timestamp: new Date(1230).toISOString(),
        message: { content: '<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>' } },
      { type: 'user', isMeta: true, sessionId: f.sid, timestamp: new Date(1240).toISOString(),
        message: { content: '<local-command-stdout>Goodbye!</local-command-stdout>' } },
    ];
    fs.appendFileSync(transcript(f, 'a'), exitRows.map(JSON.stringify).join('\n') + '\n');
    jobs.recordHook(f.root, 'claude', f.sid, { event: 'Stop', entity: 'turn', at: 1250,
      offset: fs.statSync(transcript(f, 'a')).size });
    artifacts.copyClaudeArtifacts(f.sid, f.records.a, f.records.b, 'tx-final-flush', options(f));

    assert.equal(artifacts.rebindLedger(f.sid, f.records.a, f.records.b, 'tx-final-flush', rebindOptions(f)).rebound[0].reused, false);
    const state = JSON.parse(fs.readFileSync(path.join(f.root, '.keep/background-jobs/claude', f.sid, 'state.json')));
    assert.equal(state.source.file, path.resolve(transcript(f, 'b')));
    assert.equal(state.restart.completed, true, 'exit bookkeeping does not invent a new user turn');
    assert.equal(state.gap, false); assert.equal(state.recovering, false);
    assert.equal(state.checkpoint.offset, fs.statSync(transcript(f, 'b')).size);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('stopped-source catch-up refuses new unresolved work without moving ledger authority', () => {
  const f = fixture();
  try {
    const initial = { type: 'assistant', sessionId: f.sid, timestamp: new Date(1000).toISOString(),
      message: { content: [], stop_reason: 'end_turn' } };
    fs.writeFileSync(transcript(f, 'a'), JSON.stringify(initial) + '\n');
    jobs.sync({ root: f.root, agent: 'claude', sid: f.sid, file: transcript(f, 'a'), now: 1100 });
    const tool = { type: 'assistant', sessionId: f.sid, timestamp: new Date(1200).toISOString(),
      message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'late-call', name: 'Bash', input: { command: 'sleep 1' } }] } };
    fs.appendFileSync(transcript(f, 'a'), JSON.stringify(tool) + '\n');
    artifacts.copyClaudeArtifacts(f.sid, f.records.a, f.records.b, 'tx-late-work', options(f));
    assert.throws(() => artifacts.rebindLedger(f.sid, f.records.a, f.records.b, 'tx-late-work', rebindOptions(f)),
      /stopped source job ledger is unsafe/);
    const state = JSON.parse(fs.readFileSync(path.join(f.root, '.keep/background-jobs/claude', f.sid, 'state.json')));
    assert.equal(state.source.file, path.resolve(transcript(f, 'a')));
    assert.equal(state.calls['call:late-call'].name, 'Bash');
    assert.equal(state.handoffRebind, undefined);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('bounded stopped-source recovery remains retryable after exhausting one request', () => {
  const f = fixture();
  try {
    const row = { type: 'assistant', sessionId: f.sid, timestamp: new Date(1000).toISOString(),
      message: { content: [], stop_reason: 'end_turn' } };
    fs.writeFileSync(transcript(f, 'a'), JSON.stringify(row) + '\n');
    jobs.sync({ root: f.root, agent: 'claude', sid: f.sid, file: transcript(f, 'a'), now: 1100 });
    artifacts.copyClaudeArtifacts(f.sid, f.records.a, f.records.b, 'tx-bounded-catchup', options(f));
    const real = require('./restart-ledger');
    let attempts = 0;
    const delayed = { Recovering: real.Recovering, verify(args) {
      attempts++;
      if (attempts <= 8) throw new real.Recovering('synthetic bounded recovery');
      return real.verify(args);
    } };
    assert.throws(() => artifacts.rebindLedger(f.sid, f.records.a, f.records.b, 'tx-bounded-catchup',
      rebindOptions(f, { restartLedger: delayed })), /did not catch up/);
    let state = JSON.parse(fs.readFileSync(path.join(f.root, '.keep/background-jobs/claude', f.sid, 'state.json')));
    assert.equal(state.source.file, path.resolve(transcript(f, 'a')));
    assert.equal(state.handoffRebind, undefined);
    assert.equal(artifacts.rebindLedger(f.sid, f.records.a, f.records.b, 'tx-bounded-catchup',
      rebindOptions(f, { restartLedger: delayed })).rebound[0].reused, false);
    state = JSON.parse(fs.readFileSync(path.join(f.root, '.keep/background-jobs/claude', f.sid, 'state.json')));
    assert.equal(state.source.file, path.resolve(transcript(f, 'b')));
    assert.equal(attempts, 9);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('unknown divergent targets and modified managed copies are refused without overwrite', () => {
  const f = fixture();
  try {
    fs.mkdirSync(project(f, 'c'), { recursive: true });
    fs.writeFileSync(transcript(f, 'c'), 'unknown target\n');
    assert.throws(() => artifacts.preflight(f.sid, f.records.a, f.records.c, options(f)), (error) => {
      assert.equal(error.code, 'KEEP_ARTIFACT_UNSAFE'); return true;
    });
    assert.equal(fs.readFileSync(transcript(f, 'c'), 'utf8'), 'unknown target\n');

    artifacts.copyClaudeArtifacts(f.sid, f.records.a, f.records.b, 'tx-a-b', options(f));
    appendTurn(f, 'b');
    fs.rmSync(transcript(f, 'c'));
    artifacts.copyClaudeArtifacts(f.sid, f.records.b, f.records.c, 'tx-b-c', options(f));
    fs.appendFileSync(transcript(f, 'b'), 'unexpected offline edit\n');
    const before = fs.readFileSync(transcript(f, 'b'), 'utf8');
    assert.throws(() => artifacts.copyClaudeArtifacts(f.sid, f.records.c, f.records.b, 'tx-c-b', options(f)), /unrecognized changes/);
    assert.equal(fs.readFileSync(transcript(f, 'b'), 'utf8'), before);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('partial publish retry uses its verified stage and never reverts newer target history', (t) => {
  const f = fixture();
  try {
    artifacts.copyClaudeArtifacts(f.sid, f.records.a, f.records.b, 'tx-a-b', options(f));
    appendTurn(f, 'b');
    const target = transcript(f, 'a');
    const originalRename = fs.renameSync;
    let crashed = false;
    t.mock.method(fs, 'renameSync', function (from, to) {
      if (!crashed && String(from).includes('.keep-stage-') && to === target) {
        crashed = true;
        const error = new Error('simulated crash before publish'); error.code = 'EIO'; throw error;
      }
      return originalRename.call(fs, from, to);
    });
    assert.throws(() => artifacts.copyClaudeArtifacts(f.sid, f.records.b, f.records.a, 'tx-b-a', options(f)), /simulated crash/);
    t.mock.restoreAll();
    assert.equal(fs.existsSync(target), false, 'old target was durably backed up');
    assert.equal(fs.existsSync(transcript(f, 'b')), true, 'source is retained after the crash');
    const retried = artifacts.copyClaudeArtifacts(f.sid, f.records.b, f.records.a, 'tx-b-a', options(f));
    assert.equal(retried.reused, false);
    assert.match(fs.readFileSync(target, 'utf8'), /"account":"b"/);
    fs.appendFileSync(target, 'newer target history\n');
    const newer = fs.readFileSync(target, 'utf8');
    assert.throws(() => artifacts.copyClaudeArtifacts(f.sid, f.records.b, f.records.a, 'tx-b-a', options(f)), /unrecognized changes|no longer matches/);
    assert.equal(fs.readFileSync(target, 'utf8'), newer);
  } finally { t.mock.restoreAll(); fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a changed recovery backup is refused instead of being trusted or replaced', (t) => {
  const f = fixture();
  try {
    artifacts.copyClaudeArtifacts(f.sid, f.records.a, f.records.b, 'tx-a-b', options(f));
    appendTurn(f, 'b');
    const target = transcript(f, 'a');
    const originalRename = fs.renameSync;
    let crashed = false;
    t.mock.method(fs, 'renameSync', function (from, to) {
      if (!crashed && String(from).includes('.keep-stage-') && to === target) {
        crashed = true;
        const error = new Error('simulated crash'); error.code = 'EIO'; throw error;
      }
      return originalRename.call(fs, from, to);
    });
    assert.throws(() => artifacts.copyClaudeArtifacts(f.sid, f.records.b, f.records.a, 'tx-b-a', options(f)), /simulated crash/);
    t.mock.restoreAll();
    const backup = fs.readdirSync(path.dirname(target)).find((name) => name.includes('.keep-backup-') && name.includes(f.sid));
    assert.ok(backup);
    fs.appendFileSync(path.join(path.dirname(target), backup), 'changed backup\n');
    assert.throws(() => artifacts.copyClaudeArtifacts(f.sid, f.records.b, f.records.a, 'tx-b-a', options(f)), /backup is missing or changed|unrecognized changes/);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(transcript(f, 'b')), true);
  } finally { t.mock.restoreAll(); fs.rmSync(f.base, { recursive: true, force: true }); }
});

// A session that changed cwd writes its later subagent transcripts under the worktree's
// own project dir, with no `<sid>.jsonl` beside them, and a replaced transcript leaves a
// `<sid>.superseded-*` tree behind. Both hold child transcripts the ledger walk needs.
function extraTrees(f) {
  const worktree = path.join(f.profiles.a, 'projects', '-wt-work-repo-slug', f.sid);
  const superseded = path.join(project(f, 'a'), `${f.sid}.superseded-1758000000000`);
  for (const [dir, agent] of [[worktree, 'worktree'], [superseded, 'old']]) {
    fs.mkdirSync(path.join(dir, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'subagents', `agent-${agent}.jsonl`), `${JSON.stringify({ agent })}\n`);
  }
  return { worktree, superseded };
}

test('every session tree of a session moves with it, in its own project name', () => {
  const f = fixture();
  try {
    const trees = extraTrees(f);
    const plan = artifacts.preflight(f.sid, f.records.a, f.records.b, options(f));
    const extra = plan.artifacts.filter((entry) => entry.extra === true);
    assert.deepEqual(extra.map((entry) => entry.source).sort(), [trees.superseded, trees.worktree].sort());
    assert.deepEqual(extra.map((entry) => entry.kind), ['session', 'session']);
    assert.equal(plan.artifacts.filter((entry) => entry.kind === 'session' && !entry.extra).length, 1);
    artifacts.copyClaudeArtifacts(f.sid, f.records.a, f.records.b, 'tx-extra-trees', options(f));
    assert.equal(fs.readFileSync(path.join(f.profiles.b, 'projects', '-wt-work-repo-slug', f.sid,
      'subagents', 'agent-worktree.jsonl'), 'utf8'), `${JSON.stringify({ agent: 'worktree' })}\n`);
    assert.equal(fs.readFileSync(path.join(project(f, 'b'), `${f.sid}.superseded-1758000000000`,
      'subagents', 'agent-old.jsonl'), 'utf8'), `${JSON.stringify({ agent: 'old' })}\n`);
    assert.equal(artifacts.preflight(f.sid, f.records.a, f.records.b, options(f)).disposition, 'reused');
    // A tree that appears afterwards is part of the plan, and the target no longer matches.
    fs.mkdirSync(path.join(f.profiles.a, 'projects', '-later', f.sid), { recursive: true });
    fs.writeFileSync(path.join(f.profiles.a, 'projects', '-later', f.sid, 'late.txt'), 'late');
    assert.equal(artifacts.preflight(f.sid, f.records.a, f.records.b, options(f)).disposition, 'managed');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

// Exactly what a journal written before session trees could be plural looks like: three
// records, each identified by its kind alone.
function asLegacyJournal(f) {
  const directory = path.join(f.root, '.keep', 'account-artifacts', 'transactions');
  const file = path.join(directory, fs.readdirSync(directory)[0]);
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(journal.artifacts.length, 3);
  journal.artifacts = journal.artifacts.map(({ id, ...record }) => record);
  fs.writeFileSync(file, JSON.stringify(journal));
  return file;
}

function interruptLegacyCopy(f, t, transactionId) {
  const originalRename = fs.renameSync;
  const historyTarget = path.join(f.profiles.b, 'file-history', f.sid);
  let crashed = false;
  t.mock.method(fs, 'renameSync', function (from, to) {
    if (!crashed && String(from).includes('.keep-stage-') && to === historyTarget) {
      crashed = true;
      const error = new Error('simulated crash before publish'); error.code = 'EIO'; throw error;
    }
    return originalRename.call(fs, from, to);
  });
  assert.throws(() => artifacts.copyClaudeArtifacts(f.sid, f.records.a, f.records.b, transactionId, options(f)), /simulated crash/);
  t.mock.restoreAll();
  return asLegacyJournal(f);
}

test('a transaction interrupted before its extra session trees existed still recovers', (t) => {
  const f = fixture();
  try {
    const journalFile = interruptLegacyCopy(f, t, 'tx-legacy');
    const historyTarget = path.join(f.profiles.b, 'file-history', f.sid);
    // The session moves into a worktree only now, so the interrupted transaction knows
    // nothing about the trees its plan has grown.
    extraTrees(f);
    assert.equal(artifacts.preflight(f.sid, f.records.a, f.records.b, options(f)).disposition, 'recovery');
    const recovered = artifacts.copyClaudeArtifacts(f.sid, f.records.a, f.records.b, 'tx-legacy', options(f));
    assert.equal(recovered.reused, false);
    assert.equal(fs.readFileSync(path.join(historyTarget, 'a.txt'), 'utf8'), 'history a');
    assert.equal(fs.readFileSync(path.join(f.profiles.b, 'projects', '-wt-work-repo-slug', f.sid,
      'subagents', 'agent-worktree.jsonl'), 'utf8'), `${JSON.stringify({ agent: 'worktree' })}\n`);
    assert.equal(JSON.parse(fs.readFileSync(journalFile, 'utf8')).artifacts.length, 5, 'the extra trees joined the journal');
    assert.equal(artifacts.preflight(f.sid, f.records.a, f.records.b, options(f)).disposition, 'reused');
  } finally { t.mock.restoreAll(); fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('recovery does not adopt unaccounted target content under an extra session tree', (t) => {
  const f = fixture();
  try {
    interruptLegacyCopy(f, t, 'tx-legacy-guard');
    extraTrees(f);
    // Something the transfer never put there is already at one extra tree's target. The
    // legacy journal is no evidence about it, and recovery must not back it up and
    // replace it the way it may a tree it recorded.
    const occupied = path.join(f.profiles.b, 'projects', '-wt-work-repo-slug', f.sid);
    fs.mkdirSync(occupied, { recursive: true });
    fs.writeFileSync(path.join(occupied, 'someone-elses.txt'), 'not ours');
    assert.throws(() => artifacts.copyClaudeArtifacts(f.sid, f.records.a, f.records.b, 'tx-legacy-guard', options(f)),
      (error) => {
        assert.equal(error.code, 'KEEP_ARTIFACT_UNSAFE');
        assert.match(error.message, /unrecognized changes: .*-wt-work-repo-slug/);
        return true;
      });
    assert.equal(fs.readFileSync(path.join(occupied, 'someone-elses.txt'), 'utf8'), 'not ours');
    assert.deepEqual(fs.readdirSync(occupied), ['someone-elses.txt'], 'nothing was staged, backed up or published there');
    assert.equal(fs.existsSync(path.join(f.profiles.b, 'file-history', f.sid)), false, 'the interrupted artifact stays unpublished');
  } finally { t.mock.restoreAll(); fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a legacy transaction that completed before the extra trees existed finishes them', () => {
  const f = fixture();
  try {
    artifacts.copyClaudeArtifacts(f.sid, f.records.a, f.records.b, 'tx-legacy-complete', options(f));
    const journalFile = asLegacyJournal(f);
    assert.equal(JSON.parse(fs.readFileSync(journalFile, 'utf8')).status, 'complete');
    // The crash was after the copy marked itself complete and before the rebind, and
    // the plan has grown trees the completed journal never mentioned.
    extraTrees(f);
    const target = path.join(f.profiles.b, 'projects', '-wt-work-repo-slug', f.sid, 'subagents', 'agent-worktree.jsonl');
    assert.equal(fs.existsSync(target), false);
    const recovered = artifacts.copyClaudeArtifacts(f.sid, f.records.a, f.records.b, 'tx-legacy-complete', options(f));
    assert.equal(recovered.reused, false);
    assert.equal(fs.readFileSync(target, 'utf8'), `${JSON.stringify({ agent: 'worktree' })}\n`);
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    assert.equal(journal.status, 'complete');
    assert.equal(journal.artifacts.length, 5);
    assert.equal(artifacts.preflight(f.sid, f.records.a, f.records.b, options(f)).disposition, 'reused');
    assert.equal(artifacts.copyClaudeArtifacts(f.sid, f.records.a, f.records.b, 'tx-legacy-complete', options(f)).reused, true);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

// A child whose transcript sits under some other session's tree -- a codex-rescue child
// does this -- is not part of what the transaction moves.
function prepareForeignChild(f, child = 'child') {
  const at = (value) => new Date(value).toISOString();
  fs.writeFileSync(transcript(f, 'a'), [
    { type: 'user', sessionId: f.sid, timestamp: at(1000), message: { content: 'work' } },
    { type: 'assistant', sessionId: f.sid, timestamp: at(1100), message: { stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'spawn', name: 'Agent', input: {} }] } },
    { type: 'user', sessionId: f.sid, timestamp: at(1200), message: { content: [
      { type: 'tool_result', tool_use_id: 'spawn', content: `Async agent launched successfully. agentId: ${child}` }] } },
    { type: 'user', sessionId: f.sid, timestamp: at(1300), message: { content:
      `<task-notification><task-id>${child}</task-id><status>completed</status><result>done</result></task-notification>` } },
    { type: 'assistant', sessionId: f.sid, timestamp: at(1500), message: { stop_reason: 'end_turn', content: [] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const foreign = path.join(f.profiles.a, 'projects', '-other', 'session-999', 'subagents');
  fs.mkdirSync(foreign, { recursive: true });
  const file = path.join(foreign, `agent-${child}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', sessionId: f.sid, timestamp: at(1400),
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }) + '\n');
  restartLedger.verify({ root: f.root, agent: 'claude', sid: f.sid, file: transcript(f, 'a'),
    instance: { id: 'pane:a', since: 1, live: true }, resolveChild: () => null })();
  return { child, file };
}

test('a child transcript outside the session trees is skipped when finished and refused when not', () => {
  const f = fixture();
  try {
    const foreign = prepareForeignChild(f);
    artifacts.copyClaudeArtifacts(f.sid, f.records.a, f.records.b, 'tx-foreign', options(f));
    const result = artifacts.rebindLedger(f.sid, f.records.a, f.records.b, 'tx-foreign', rebindOptions(f));
    assert.deepEqual(result.rebound.map((entry) => entry.sessionId), [f.sid]);
    assert.deepEqual(result.skippedChildren, [{ sessionId: foreign.child, reason: 'transcript outside the session trees' }]);
    assert.equal(fs.existsSync(path.join(f.profiles.b, 'projects', '-other', 'session-999')), false, 'a foreign tree is not moved');

    // The same child while the parent's ledger still counts it as live: nothing here
    // can move its history, so the transfer refuses instead of leaving it behind.
    fs.mkdirSync(path.join(f.profiles.a, 'projects', '-other', 'session-999', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(f.profiles.a, 'projects', '-other', 'session-999', 'subagents', 'agent-live.jsonl'), '{}\n');
    assert.throws(() => artifacts.rebindLedger(f.sid, f.records.a, f.records.b, 'tx-foreign', rebindOptions(f, {
      rebindSource: (args) => {
        const rebound = jobs.rebindSource(args);
        return { ...rebound, children: [...(rebound.children || []), 'live'] };
      },
    })), (error) => {
      assert.equal(error.code, 'KEEP_ARTIFACT_ESCAPE');
      assert.match(error.message, /outside the session trees/);
      return true;
    });
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('a child with no transcript anywhere is refused while the parent still counts it as live', () => {
  const f = fixture();
  try {
    prepareForeignChild(f, 'ghost');
    fs.rmSync(path.join(f.profiles.a, 'projects', '-other'), { recursive: true, force: true });
    artifacts.copyClaudeArtifacts(f.sid, f.records.a, f.records.b, 'tx-missing', options(f));
    assert.throws(() => artifacts.rebindLedger(f.sid, f.records.a, f.records.b, 'tx-missing', rebindOptions(f, {
      rebindSource: (args) => {
        const rebound = jobs.rebindSource(args);
        return { ...rebound, children: [...(rebound.children || []), 'live'] };
      },
    })), (error) => {
      assert.equal(error.code, 'KEEP_ARTIFACT_ESCAPE');
      assert.match(error.message, /Claude child transcript is missing/);
      return true;
    });
    // The finished one is recorded rather than refused.
    const result = artifacts.rebindLedger(f.sid, f.records.a, f.records.b, 'tx-missing', rebindOptions(f));
    assert.deepEqual(result.skippedChildren, [{ sessionId: 'ghost', reason: 'transcript is missing' }]);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('symlinked artifact paths and profile aliases are rejected', () => {
  const f = fixture();
  try {
    const outside = path.join(f.base, 'outside'); fs.mkdirSync(outside);
    fs.mkdirSync(path.join(f.profiles.b, 'projects'), { recursive: true });
    fs.symlinkSync(outside, project(f, 'b'));
    assert.throws(() => artifacts.preflight(f.sid, f.records.a, f.records.b, options(f)), (error) => {
      assert.equal(error.code, 'KEEP_ARTIFACT_SYMLINK'); return true;
    });
    const alias = { ...f.records.b, configDir: f.profiles.a };
    assert.throws(() => artifacts.preflight(f.sid, f.records.a, alias, options(f)), (error) => {
      assert.equal(error.code, 'KEEP_ARTIFACT_ALIAS'); return true;
    });
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});
