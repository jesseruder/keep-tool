'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { launch } = require('./reviewer-launch');

test('reviewer launches in a host-owned Claude pane with a pinned session and registration environment', async () => {
  const calls = [];
  let closed = false;
  const account = { id: 'reviewer-account', label: 'Reviewer account', agent: 'claude', configDir: '/profiles/reviewer' };
  const result = await launch(['sonnet'], '/tmp/private registry', {
    account,
    ensureSharedMemory: (selected, cwd) => {
      assert.equal(selected, account); assert.equal(cwd, '/tmp/private registry');
      return { mcpConfig: '/profiles/reviewer/project.keep-mcp.json' };
    },
    profileCommand: (argv, selected) => {
      assert.equal(selected, account);
      assert.equal(argv[0], 'claude');
      assert.deepEqual(argv.slice(1), ['--model', 'sonnet', '--settings', '{"promptSuggestionEnabled":false,"preferredNotifChannel":"notifications_disabled"}',
        '--mcp-config', '/profiles/reviewer/project.keep-mcp.json', '--session-id', '11111111-1111-4111-8111-111111111111']);
      return 'profiled-reviewer-command';
    },
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
    connect: async () => ({
      request: async (method, params) => { calls.push({ method, params }); return method === 'list' ? { panes: [] } : { pane: { id: 'review-pane' } }; },
      close: () => { closed = true; },
    }),
  });
  assert.equal(result.pane, 'review-pane');
  const spawn = calls.find((call) => call.method === 'spawn').params;
  assert.equal(spawn.meta.sessionId, result.sessionId);
  assert.equal(spawn.meta.agent, 'claude');
  assert.equal(spawn.meta.reviewer, true);
  assert.equal(spawn.meta.accountId, 'reviewer-account');
  assert.equal(spawn.meta.accountLabel, 'Reviewer account');
  // A reviewer reads the registry it reviews, so it runs beside it and says so.
  assert.equal(spawn.meta.node, require('./nodes.js').daemonNode());
  assert.equal(result.accountId, 'reviewer-account');
  assert.equal(spawn.env.KEEP_REVIEWER, '1');
  assert.equal(spawn.env.KEEP_DIR, '/tmp/private registry');
  // A five-card bundle is built to 40k tokens; Claude Code's default 30k-char Bash
  // truncation forced the reviewer to re-read the bundle file in chunks.
  assert.equal(spawn.env.BASH_MAX_OUTPUT_LENGTH, '200000');
  assert.equal(spawn.args[1], 'exec profiled-reviewer-command');
  assert.equal(closed, true);
});

test('an existing hosted reviewer prevents an accidental duplicate launch', async () => {
  let closed = false;
  await assert.rejects(launch([], '/tmp/registry', {
    account: { id: 'reviewer-account', label: 'Reviewer', agent: 'claude', configDir: '/profiles/reviewer' },
    ensureSharedMemory: () => ({ mcpConfig: null }),
    connect: async () => ({
      request: async (method) => { assert.equal(method, 'list'); return { panes: [{ alive: true, meta: { reviewer: true } }] }; },
      close: () => { closed = true; },
    }),
  }), /already running/);
  assert.equal(closed, true);
});

function hostStub(calls) {
  return async () => ({
    request: async (method, params) => { calls.push({ method, params }); return method === 'list' ? { panes: [] } : { pane: { id: 'review-pane' } }; },
    close: () => {},
  });
}

test('with no account passed, the reviewer runs on the account the automation policy picks, and says so in its pane meta', async () => {
  const calls = [];
  const secondary = { id: 'claude-secondary', label: 'Secondary', agent: 'claude', configDir: '/profiles/secondary' };
  const asked = [];
  const result = await launch(['opus'], '/tmp/registry', {
    selectAccount: (options) => { asked.push(options); return { account: 'claude-secondary', record: secondary, reason: 'most headroom' }; },
    ensureSharedMemory: () => ({ mcpConfig: null }),
    profileCommand: (argv, selected) => { assert.equal(selected, secondary); return 'cmd'; },
    randomUUID: () => '22222222-2222-4222-8222-222222222222',
    connect: hostStub(calls),
  });
  assert.deepEqual(asked.map((options) => [options.purpose, options.model]), [['reviewer', 'opus']]);
  const spawn = calls.find((call) => call.method === 'spawn').params;
  assert.equal(spawn.meta.accountId, 'claude-secondary');
  assert.equal(spawn.meta.accountLabel, 'Secondary');
  assert.equal(result.accountId, 'claude-secondary');
});

test('a spent automation pool refuses to start the reviewer and names when it can', async () => {
  const calls = [];
  await assert.rejects(launch(['fable'], '/tmp/registry', {
    selectAccount: () => ({ account: null, deferred: true, retryAt: 1_900_000_000_000,
      reason: 'automation pool exhausted for fable; retrying at 2030-03-17 10:46: claude-secondary week 100%, resets 2030-03-17 10:46; claude-tertiary week 40%, Fable wk 100%, resets 2030-03-18 09:00' }),
    ensureSharedMemory: () => { throw new Error('should not prepare a profile'); },
    connect: hostStub(calls),
  }), (error) => {
    assert.equal(error.code, 'ACCOUNT_DEFERRED');
    assert.equal(error.retryAt, 1_900_000_000_000);
    assert.match(error.message, /^not starting the fleet reviewer: automation pool exhausted for fable; retrying at 2030-03-17 10:46/);
    assert.match(error.message, /claude-secondary week 100%/);
    assert.match(error.message, /claude-tertiary week 40%, Fable wk 100%/);
    return true;
  });
  assert.deepEqual(calls, [], 'nothing was spawned');
});

test('the real policy picks the pool account with room when the configured reviewer account is spent', async () => {
  const calls = [];
  const now = Date.now();
  const reading = (week) => ({ identity: { agent: 'claude' }, snapshot: { fetchedAt: now, limits: [{ label: 'week', percent: week }] } });
  const records = ['claude/default', 'claude-secondary', 'claude-tertiary'].map((id) => ({ id, label: id, agent: 'claude', configDir: `/profiles/${id}` }));
  const accounts = {
    rawConfig: () => ({ version: 1, automationAccounts: { reviewer: 'claude-tertiary' } }),
    list: () => records, get: (id) => records.find((entry) => entry.id === id) || null,
    defaultFor: () => records[0], automationFor: () => records[2],
  };
  const budget = require('./account-budget');
  await launch(['opus'], '/tmp/registry', {
    accounts,
    selectAccount: (options) => budget.select({ ...options, recordHealth: false,
      usage: { accounts: { 'claude-secondary': reading(30), 'claude-tertiary': reading(100) } } }),
    ensureSharedMemory: () => ({ mcpConfig: null }),
    profileCommand: () => 'cmd',
    connect: hostStub(calls),
  });
  assert.equal(calls.find((call) => call.method === 'spawn').params.meta.accountId, 'claude-secondary');
});
