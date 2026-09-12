'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
