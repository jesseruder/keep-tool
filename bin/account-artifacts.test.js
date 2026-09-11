'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const accounts = require('./accounts');
const artifacts = require('./account-artifacts');

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
