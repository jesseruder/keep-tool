'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const accounts = require('./accounts');
const { findSessionFile } = require('./transcripts');

function withDiscoveryStubs(t, { pinned = null, authorityError = null, matches = [] } = {}) {
  const originalForSession = accounts.forSession;
  const originalLocate = accounts.locateClaudeFiles;
  let authorityCalls = 0;
  let discoveryCalls = 0;
  accounts.forSession = (_id, agent, options) => {
    authorityCalls++;
    assert.equal(agent, 'claude');
    assert.equal(options.allowDiscovery, false, 'file lookup must not trigger a second discovery walk');
    assert.equal(options.allowStagedSource, true);
    if (authorityError) throw authorityError;
    return pinned;
  };
  accounts.locateClaudeFiles = () => { discoveryCalls++; return matches; };
  t.after(() => {
    accounts.forSession = originalForSession;
    accounts.locateClaudeFiles = originalLocate;
  });
  return { calls: () => ({ authorityCalls, discoveryCalls }) };
}

test('fresh transcript lookup walks account project trees only once', t => {
  const stubs = withDiscoveryStubs(t, {
    matches: [{ accountId: 'a', file: '/a/project/session.jsonl' }],
  });
  assert.equal(findSessionFile('session'), '/a/project/session.jsonl');
  assert.deepEqual(stubs.calls(), { authorityCalls: 1, discoveryCalls: 1 });
});

test('single-pass transcript lookup preserves authority and ambiguity semantics', async t => {
  await t.test('durable authority selects its account', t => {
    withDiscoveryStubs(t, {
      pinned: { id: 'b' },
      matches: [
        { accountId: 'a', file: '/a/project/session.jsonl' },
        { accountId: 'b', file: '/b/project/session.jsonl' },
      ],
    });
    assert.equal(findSessionFile('session'), '/b/project/session.jsonl');
  });
  await t.test('multiple accounts without authority remain ambiguous', t => {
    withDiscoveryStubs(t, {
      matches: [
        { accountId: 'a', file: '/a/project/session.jsonl' },
        { accountId: 'b', file: '/b/project/session.jsonl' },
      ],
    });
    assert.throws(() => findSessionFile('session'), /multiple accounts without authority/);
  });
  await t.test('duplicate project files in one discovered account retain their prior first-match behavior', t => {
    withDiscoveryStubs(t, {
      matches: [
        { accountId: 'a', file: '/a/one/session.jsonl' },
        { accountId: 'a', file: '/a/two/session.jsonl' },
      ],
    });
    assert.equal(findSessionFile('session'), '/a/one/session.jsonl');
  });
  await t.test('invalid authority still refuses multiple fallback files', t => {
    withDiscoveryStubs(t, {
      authorityError: new Error('pinned account unavailable'),
      matches: [
        { accountId: 'a', file: '/a/one/session.jsonl' },
        { accountId: 'a', file: '/a/two/session.jsonl' },
      ],
    });
    assert.throws(() => findSessionFile('session'), /multiple accounts without authority/);
  });
});

test('a session recorded on another node is refused even when its account is gone', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-transcript-node-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '.keep', 'session-accounts', 'remote-session.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, sessionId: 'remote-session', agent: 'claude',
    accountId: 'removed-account', node: 'laptop', updatedAt: 1 }, null, 2) + '\n');
  // The account the record names no longer exists, so resolution throws — the very
  // path that used to fall back to whatever local file shared the id.
  const stubs = withDiscoveryStubs(t, {
    authorityError: new Error('session remote-session is pinned to unavailable account removed-account'),
    matches: [{ accountId: 'a', file: '/a/one/remote-session.jsonl' }],
  });
  assert.throws(() => findSessionFile('remote-session', { root }),
    /session remote-session runs on node laptop; its transcript is not mirrored here/);
  assert.deepEqual(stubs.calls(), { authorityCalls: 0, discoveryCalls: 0 },
    'the node is read from the record, before any account resolution or discovery');

  // A record on this node still resolves exactly as before.
  fs.writeFileSync(file, JSON.stringify({ version: 1, sessionId: 'remote-session', agent: 'claude',
    accountId: 'a', node: 'main', updatedAt: 1 }, null, 2) + '\n');
  assert.equal(findSessionFile('remote-session', { root }), '/a/one/remote-session.jsonl');
});

test('a pinned session is answered from the transcript an earlier walk found, without walking again', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-transcript-direct-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ version: 1, accounts: [
    { id: 'a', label: 'Claude A', agent: 'claude', configDir: path.join(root, 'a') },
    { id: 'b', label: 'Claude B', agent: 'claude', configDir: path.join(root, 'b') },
  ], defaultAccounts: { claude: 'a' } }));
  const env = { KEEP_CONFIG: config, KEEP_DIR: path.join(root, 'registry') };
  const registry = env.KEEP_DIR;
  const id = `direct-${process.pid}-${Date.now()}`;
  const write = (account, project) => {
    const file = path.join(root, account, 'projects', project, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
    return file;
  };
  for (let n = 0; n < 5; n++) fs.mkdirSync(path.join(root, 'b', 'projects', `other-${n}`), { recursive: true });
  const onA = write('a', 'one');
  const onB = write('b', 'two');
  accounts.pinSession(id, 'claude', 'b', { root: registry, env });

  const originalLocate = accounts.locateClaudeFiles;
  let walks = 0;
  accounts.locateClaudeFiles = (...args) => { walks++; return originalLocate(...args); };
  t.after(() => { accounts.locateClaudeFiles = originalLocate; });

  assert.equal(findSessionFile(id, { root: registry, env }), onB);
  assert.equal(walks, 1, 'the first lookup has nothing to go on but a walk');
  assert.equal(findSessionFile(id, { root: registry, env }), onB);
  assert.equal(findSessionFile(id, { root: registry, env }), onB);
  assert.equal(walks, 1, 'later lookups of a pinned session stat the known file instead');
  assert.equal(accounts.claudeAccountForFile(onB, env), 'b');
  assert.equal(accounts.claudeAccountForFile(onA, env), 'a');

  // The known file going away is not an answer: the walk runs again and the
  // fallback rules are the ones they always were.
  fs.rmSync(onB);
  assert.equal(findSessionFile(id, { root: registry, env }), onA);
  assert.equal(walks, 2);
});
