'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const artifacts = require('./codex-account-artifacts');

class Recovering extends Error {}
const restartLedger = {
  Recovering,
  verify({ file }) {
    const before = fs.statSync(file);
    return () => {
      const after = fs.statSync(file);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
          || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error('rollout changed during restart proof');
      }
    };
  },
};

function rollout(profile, relative, id, parent = null, suffix = '') {
  const file = path.join(profile, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = [
    { type: 'session_meta', payload: { id, cwd: '/worktree',
      ...(parent ? { source: { subagent: { thread_spawn: { parent_thread_id: parent } } } } : { source: 'exec' }) } },
    { type: 'event_msg', payload: { type: 'user_message', message: `user context ${id}` } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'tool-call', output: `tool output ${id}` } },
    { type: 'compacted', payload: { replacement_history: [{ role: 'assistant',
      content: [{ type: 'output_text', text: `compaction context ${id}` }] }] } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ];
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + `\n${suffix}`);
  return file;
}

function writeLedger(root, id, file, parent = null, children = {}) {
  const directory = path.join(root, '.keep', 'background-jobs', 'codex', id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
    version: 1, restartVersion: 1, gap: false, recovering: false,
    source: { agent: 'codex', sid: id, file, instance: null },
    restart: { id, parent, children },
  }));
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-codex-artifacts-'));
  const root = path.join(base, 'registry'); fs.mkdirSync(root);
  const profiles = {};
  const records = {};
  for (const id of ['a', 'b', 'c']) {
    profiles[id] = path.join(base, `profile-${id}`);
    fs.mkdirSync(profiles[id]);
    fs.writeFileSync(path.join(profiles[id], 'config.toml'), `profile="${id}"\n`);
    fs.writeFileSync(path.join(profiles[id], 'auth.json'), `credential-${id}\n`);
    records[id] = { id, label: id.toUpperCase(), agent: 'codex', configDir: profiles[id] };
  }
  fs.writeFileSync(path.join(profiles.a, 'state_5.sqlite'), 'source database');
  const sid = 'root-session', child = 'owned-child', grandchild = 'owned-grandchild', interacted = 'external-child';
  const rootFile = rollout(profiles.a, path.join('sessions', '2026', '09', '11',
    `rollout-2026-09-11T00-00-00-${sid}.jsonl`), sid);
  const childFile = rollout(profiles.a, path.join('archived_sessions',
    `rollout-2026-09-11T00-00-01-${child}.jsonl`), child, sid);
  const grandchildFile = rollout(profiles.a, path.join('sessions', '2026', '09', '11',
    `rollout-2026-09-11T00-00-02-${grandchild}.jsonl`), grandchild, child);
  const interactedFile = rollout(profiles.a, path.join('sessions', '2026', '09', '10',
    `rollout-2026-09-10T00-00-00-${interacted}.jsonl`), interacted, 'other-root');
  writeLedger(root, sid, rootFile, null, { [child]: 'owned', [interacted]: 'interacted' });
  writeLedger(root, child, childFile, sid, { [grandchild]: 'owned' });
  writeLedger(root, grandchild, grandchildFile, child, {});
  return { base, root, profiles, records, sid, child, grandchild, interacted,
    rootFile, childFile, grandchildFile, interactedFile };
}

function options(f, extra = {}) {
  return { root: f.root, sourceStopVerifiedAt: 123, restartLedger, ...extra };
}
function targetFor(f, account, sourceFile) {
  return path.join(f.profiles[account], path.relative(f.profiles.a, sourceFile));
}
function repointLedger(f, account) {
  const rootFile = targetFor(f, account, f.rootFile);
  const childFile = targetFor(f, account, f.childFile);
  const grandchildFile = targetFor(f, account, f.grandchildFile);
  writeLedger(f.root, f.sid, rootFile, null, { [f.child]: 'owned', [f.interacted]: 'interacted' });
  writeLedger(f.root, f.child, childFile, f.sid, { [f.grandchild]: 'owned' });
  writeLedger(f.root, f.grandchild, grandchildFile, f.child, {});
}

test('preflight and copy expose and preserve only the verified root and owned child rollouts', () => {
  const f = fixture();
  try {
    const preview = artifacts.preflight(f.sid, f.records.a, f.records.b, options(f));
    assert.equal(preview.disposition, 'empty');
    assert.deepEqual(preview.artifacts.map((entry) => entry.sessionId), [f.sid, f.child, f.grandchild]);
    assert.deepEqual(preview.artifacts[0].children, [f.child]);
    assert.deepEqual(preview.artifacts[0].interacted, [f.interacted]);
    assert.match(preview.artifacts[0].relative, /^sessions[/\\]/);
    assert.match(preview.artifacts[1].relative, /^archived_sessions[/\\]/);

    const copied = artifacts.copyCodexArtifacts(f.sid, f.records.a, f.records.b, 'tx-a-b', options(f));
    assert.equal(copied.reused, false);
    assert.equal(copied.copied.length, 3);
    for (const entry of copied.artifacts) {
      assert.deepEqual(fs.readFileSync(entry.target), fs.readFileSync(entry.source));
    }
    assert.equal(fs.readFileSync(path.join(f.profiles.b, 'config.toml'), 'utf8'), 'profile="b"\n');
    assert.equal(fs.readFileSync(path.join(f.profiles.b, 'auth.json'), 'utf8'), 'credential-b\n');
    assert.equal(fs.existsSync(path.join(f.profiles.b, 'state_5.sqlite')), false);
    assert.equal(fs.existsSync(targetFor(f, 'b', f.interactedFile)), false,
      'interacted non-owned rollout is not copied');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('completed copy is idempotent and ledger rebind visits owned children but preserves interacted edges', () => {
  const f = fixture();
  try {
    artifacts.copyCodexArtifacts(f.sid, f.records.a, f.records.b, 'tx-rebind', options(f));
    assert.equal(artifacts.copyCodexArtifacts(f.sid, f.records.a, f.records.b, 'tx-rebind', options(f)).reused, true);
    const calls = [];
    const result = artifacts.rebindLedger(f.sid, f.records.a, f.records.b, 'tx-rebind', options(f, {
      rebindSource(request) {
        calls.push(request);
        return { reused: false, children: request.sid === f.sid ? [f.child, f.interacted]
          : request.sid === f.child ? [f.grandchild] : [] };
      },
    }));
    assert.deepEqual(result.rebound.map((entry) => entry.sessionId), [f.sid, f.child, f.grandchild]);
    assert.deepEqual(calls.map((entry) => entry.sid), [f.sid, f.child, f.grandchild]);
    assert.equal(calls.every((entry) => entry.agent === 'codex' && entry.sourceStopVerifiedAt === 123), true);
    assert.throws(() => artifacts.rebindLedger(f.sid, f.records.a, f.records.b, 'tx-rebind',
      { ...options(f), sourceStopVerifiedAt: 124, rebindSource: () => ({ children: [] }) }), /incomplete/);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('unproven, divergent, aliased, and symlinked target rollouts are refused without overwrite', () => {
  const f = fixture();
  try {
    const expected = targetFor(f, 'b', f.rootFile);
    fs.mkdirSync(path.dirname(expected), { recursive: true });
    fs.copyFileSync(f.rootFile, expected);
    assert.throws(() => artifacts.preflight(f.sid, f.records.a, f.records.b, options(f)), /unrecognized changes/);
    assert.deepEqual(fs.readFileSync(expected), fs.readFileSync(f.rootFile));
    fs.rmSync(expected);

    const alias = path.join(f.profiles.b, 'sessions', '2025', '01', '01', path.basename(f.rootFile));
    fs.mkdirSync(path.dirname(alias), { recursive: true }); fs.copyFileSync(f.rootFile, alias);
    assert.throws(() => artifacts.preflight(f.sid, f.records.a, f.records.b, options(f)),
      (error) => error.code === 'KEEP_CODEX_ARTIFACT_ALIAS');
    fs.rmSync(path.join(f.profiles.b, 'sessions'), { recursive: true });

    fs.symlinkSync(path.join(f.profiles.a, 'sessions'), path.join(f.profiles.b, 'sessions'));
    assert.throws(() => artifacts.preflight(f.sid, f.records.a, f.records.b, options(f)),
      (error) => error.code === 'KEEP_CODEX_ARTIFACT_SYMLINK');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('an interrupted publish resumes from its frozen stage and refuses later source mutation', (t) => {
  const f = fixture();
  try {
    const expected = targetFor(f, 'b', f.rootFile);
    const rename = fs.renameSync;
    let crashed = false;
    t.mock.method(fs, 'renameSync', function (from, to) {
      if (!crashed && String(from).includes('.keep-stage-') && to === expected) {
        crashed = true;
        const error = new Error('simulated publish crash'); error.code = 'EIO'; throw error;
      }
      return rename.call(fs, from, to);
    });
    assert.throws(() => artifacts.copyCodexArtifacts(f.sid, f.records.a, f.records.b, 'tx-crash', options(f)),
      /simulated publish crash/);
    t.mock.restoreAll();
    const resumed = artifacts.copyCodexArtifacts(f.sid, f.records.a, f.records.b, 'tx-crash', options(f));
    assert.equal(resumed.copied.length, 3);

    const originalCopy = fs.copyFileSync;
    let changed = false;
    t.mock.method(fs, 'copyFileSync', function (from, to, flags) {
      const value = originalCopy.call(fs, from, to, flags);
      if (!changed && from === f.rootFile) { changed = true; fs.appendFileSync(f.rootFile, 'late source mutation\n'); }
      return value;
    });
    assert.throws(() => artifacts.copyCodexArtifacts(f.sid, f.records.a, f.records.c, 'tx-source-race', options(f)),
      (error) => error.code === 'KEEP_CODEX_ARTIFACT_SOURCE_CHANGED');
    t.mock.restoreAll();
    assert.throws(() => artifacts.copyCodexArtifacts(f.sid, f.records.a, f.records.c, 'tx-source-race', options(f)),
      /conflicts with its recovery journal/);
  } finally { t.mock.restoreAll(); fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('managed provenance permits a frozen double hop while later target edits are rejected', () => {
  const f = fixture();
  try {
    artifacts.copyCodexArtifacts(f.sid, f.records.a, f.records.b, 'tx-hop-one', options(f));
    assert.equal(artifacts.preflight(f.sid, f.records.a, f.records.b, options(f)).disposition, 'managed');
    const bRoot = targetFor(f, 'b', f.rootFile);
    fs.appendFileSync(bRoot, 'continued on account b\n');
    repointLedger(f, 'b');
    const hopped = artifacts.copyCodexArtifacts(f.sid, f.records.b, f.records.c, 'tx-hop-two', options(f));
    assert.match(fs.readFileSync(hopped.artifacts[0].target, 'utf8'), /continued on account b/);
    assert.equal(fs.readFileSync(f.rootFile, 'utf8').includes('continued on account b'), false);
    fs.appendFileSync(hopped.artifacts[0].target, 'unrecorded target edit\n');
    assert.throws(() => artifacts.preflight(f.sid, f.records.b, f.records.c, options(f)), /unrecognized changes/);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('managed round trip accepts newly owned source children only when their target paths are empty', () => {
  const f = fixture();
  try {
    artifacts.copyCodexArtifacts(f.sid, f.records.a, f.records.b, 'tx-before-child', options(f));
    repointLedger(f, 'b');
    const late = 'late-owned-child';
    const lateFile = rollout(f.profiles.b, path.join('sessions', '2026', '09', '12',
      `rollout-2026-09-12T00-00-00-${late}.jsonl`), late, f.sid);
    writeLedger(f.root, f.sid, targetFor(f, 'b', f.rootFile), null,
      { [f.child]: 'owned', [f.interacted]: 'interacted', [late]: 'owned' });
    writeLedger(f.root, late, lateFile, f.sid, {});
    const returning = { root: f.root, sourceStopVerifiedAt: 456, restartLedger };
    const lateTarget = path.join(f.profiles.a, path.relative(f.profiles.b, lateFile));

    fs.mkdirSync(path.dirname(lateTarget), { recursive: true });
    fs.writeFileSync(lateTarget, fs.readFileSync(lateFile, 'utf8').replace('tool output', 'foreign output'));
    assert.throws(() => artifacts.preflight(f.sid, f.records.b, f.records.a, returning), /unrecognized changes/);
    fs.rmSync(lateTarget);

    assert.equal(artifacts.preflight(f.sid, f.records.b, f.records.a, returning).disposition, 'managed');
    const copied = artifacts.copyCodexArtifacts(f.sid, f.records.b, f.records.a, 'tx-after-child', returning);
    assert.deepEqual(copied.copied, [lateTarget]);
    assert.deepEqual(fs.readFileSync(lateTarget), fs.readFileSync(lateFile));
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('missing, ambiguous, and ledger-omitted owned children fail closed', () => {
  const missing = fixture();
  try {
    fs.rmSync(missing.childFile);
    assert.throws(() => artifacts.preflight(missing.sid, missing.records.a, missing.records.b, options(missing)),
      /owned Codex child rollout .* missing|exactly one owned child/);
  } finally { fs.rmSync(missing.base, { recursive: true, force: true }); }

  const omitted = fixture();
  try {
    writeLedger(omitted.root, omitted.sid, omitted.rootFile, null, { [omitted.interacted]: 'interacted' });
    assert.throws(() => artifacts.preflight(omitted.sid, omitted.records.a, omitted.records.b, options(omitted)),
      /absent from the verified restart graph/);
  } finally { fs.rmSync(omitted.base, { recursive: true, force: true }); }

  const ambiguous = fixture();
  try {
    rollout(ambiguous.profiles.a, path.join('sessions', '2026', '09', '09',
      `rollout-duplicate-${ambiguous.child}.jsonl`), ambiguous.child, ambiguous.sid);
    assert.throws(() => artifacts.preflight(ambiguous.sid, ambiguous.records.a, ambiguous.records.b, options(ambiguous)),
      /ambiguous|found 2/);
  } finally { fs.rmSync(ambiguous.base, { recursive: true, force: true }); }
});

test('archived roots and missing stop evidence are rejected explicitly', () => {
  const f = fixture();
  try {
    const archived = path.join(f.profiles.a, 'archived_sessions', path.basename(f.rootFile));
    fs.renameSync(f.rootFile, archived);
    writeLedger(f.root, f.sid, archived, null, { [f.child]: 'owned', [f.interacted]: 'interacted' });
    assert.throws(() => artifacts.preflight(f.sid, f.records.a, f.records.b, options(f)),
      (error) => error.code === 'KEEP_CODEX_ARTIFACT_ARCHIVED' && /unarchive/.test(error.message));
    assert.throws(() => artifacts.copyCodexArtifacts(f.sid, f.records.a, f.records.b, 'tx-no-stop',
      { ...options(f), sourceStopVerifiedAt: undefined }), /verified Codex source stop/);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('profile overlap and incomplete bounded scans fail closed', () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.profiles.a, 'nested'));
    assert.throws(() => artifacts.preflight(f.sid, f.records.a,
      { id: 'nested', agent: 'codex', configDir: path.join(f.profiles.a, 'nested') }, options(f)), /unavailable|overlap/);
    assert.throws(() => artifacts.preflight(f.sid, f.records.a, f.records.b,
      { ...options(f), maxScanEntries: 1 }), (error) => error.code === 'KEEP_CODEX_ARTIFACT_SCAN');
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});
