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

test('a final source flush catches up after copy before a retry rebinds the ledger', () => {
  const f = fixture();
  try {
    const initial = { type: 'assistant', sessionId: f.sid, timestamp: new Date(1000).toISOString(),
      message: { content: [], stop_reason: 'end_turn' } };
    fs.writeFileSync(transcript(f, 'a'), JSON.stringify(initial) + '\n');
    jobs.sync({ root: f.root, agent: 'claude', sid: f.sid, file: transcript(f, 'a'), now: 1100 });
    const final = { type: 'assistant', sessionId: f.sid, timestamp: new Date(1200).toISOString(),
      message: { content: [{ type: 'text', text: 'final flush' }], stop_reason: 'end_turn' } };
    fs.appendFileSync(transcript(f, 'a'), JSON.stringify(final) + '\n');
    jobs.recordHook(f.root, 'claude', f.sid, { event: 'Stop', entity: 'turn', at: 1250,
      offset: fs.statSync(transcript(f, 'a')).size });
    artifacts.copyClaudeArtifacts(f.sid, f.records.a, f.records.b, 'tx-final-flush', options(f));

    assert.throws(() => artifacts.rebindLedger(f.sid, f.records.a, f.records.b, 'tx-final-flush', rebindOptions(f)),
      /unconsumed hook|not caught up/);
    const caughtUp = jobs.sync({ root: f.root, agent: 'claude', sid: f.sid, file: transcript(f, 'a'), now: 1300 });
    assert.equal(caughtUp.recovering, false); assert.equal(caughtUp.gap, false);
    assert.equal(artifacts.rebindLedger(f.sid, f.records.a, f.records.b, 'tx-final-flush', rebindOptions(f)).rebound[0].reused, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, '.keep/background-jobs/claude', f.sid, 'state.json'))).source.file,
      path.resolve(transcript(f, 'b')));
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
