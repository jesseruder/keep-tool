'use strict';

// The reviewer launcher exports KEEP_REVIEWER* into its shell; tests spawn the CLI
// from process.env, so reviewer-only refusals fired inside them when run from that
// session (17 spurious failures on 2026-09-02). Tests that need reviewer identity set
// it explicitly in their own env object.
for (const k of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[k];

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const health = require('./health.js');
const {
  scanCodexUsage,
  requestRefresh,
  createUsageManager,
  claudeCredentialService,
  claudeToken,
} = require('./usage.js');

function settleRefresh() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function accountFixture() {
  const records = [
    { id: 'claude/default', label: 'Primary', agent: 'claude', configDir: '/profiles/default', builtIn: true },
    { id: 'claude-work', label: 'Work', agent: 'claude', configDir: '/profiles/work' },
    { id: 'claude-spare', label: 'Spare', agent: 'claude', configDir: '/profiles/spare' },
  ];
  return {
    list: () => records,
    defaultFor: (agent) => {
      if (agent !== 'claude') throw new Error('no fixture Codex account');
      return records[0];
    },
  };
}

function rateLimitLine(timestamp, limitId, usedPercent, windowMinutes = 10080) {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: limitId,
        primary: {
          used_percent: usedPercent,
          window_minutes: windowMinutes,
          resets_at: 1788459012,
        },
        secondary: null,
        plan_type: 'pro',
      },
    },
  });
}

test('demand-driven refresh records requests and fresh-cache skips without a timer', async () => {
  const records = [];
  const originalRecord = health.record;
  health.record = (name, options) => records.push({ name, options });
  try {
    const now = Number.MAX_SAFE_INTEGER - 1000;
    assert.equal(requestRefresh(now, async () => {}), true);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(records.at(-1), { name: 'usage', options: { ok: true } });
    assert.equal(requestRefresh(now, async () => { throw new Error('must not refresh'); }), false);
    assert.deepEqual(records.at(-1), {
      name: 'usage',
      options: { ok: true, skipped: true, detail: 'nothing due' },
    });
    assert.equal(require('./usage.js').startScheduler, undefined);
  } finally {
    health.record = originalRecord;
  }
});

test('canonical Codex usage wins over a newer named-model quota', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-usage-test-'));
  const canonical = path.join(dir, 'rollout-canonical.jsonl');
  const named = path.join(dir, 'rollout-named.jsonl');
  try {
    fs.writeFileSync(canonical, `${rateLimitLine('2026-08-28T23:16:30.465Z', 'codex', 44)}\n`);
    fs.writeFileSync(named, `${rateLimitLine('2026-08-28T23:16:39.452Z', 'codex_bengalfox', 0, 300)}\n`);
    fs.utimesSync(canonical, new Date(1000), new Date(1000));
    fs.utimesSync(named, new Date(2000), new Date(2000));

    assert.deepEqual(scanCodexUsage([dir]), {
      windows: [{ label: 'week', percent: 44, resetsAt: 1788459012000 }],
      planType: 'pro',
      asOf: Date.parse('2026-08-28T23:16:30.465Z'),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('named-model quota remains a fallback when no canonical bucket exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-usage-test-'));
  const named = path.join(dir, 'rollout-named.jsonl');
  try {
    fs.writeFileSync(named, `${rateLimitLine('2026-08-28T23:16:39.452Z', 'codex_bengalfox', 3, 300)}\n`);

    assert.deepEqual(scanCodexUsage([dir]), {
      windows: [{ label: '5h', percent: 3, resetsAt: 1788459012000 }],
      planType: 'pro',
      asOf: Date.parse('2026-08-28T23:16:39.452Z'),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('three Claude profiles use independent macOS Keychain services', async () => {
  const fixture = accountFixture();
  const seen = [];
  const fake = (cmd, args, options, callback) => {
    seen.push({ cmd, args, options });
    callback(null, JSON.stringify({ claudeAiOauth: { accessToken: `fixture-${seen.length}` } }));
  };
  const tokens = await Promise.all(fixture.list().map((account) => claudeToken(account, {
    platform: 'darwin', env: { USER: 'fixture-user' }, execFile: fake,
  })));
  assert.deepEqual(tokens, ['fixture-1', 'fixture-2', 'fixture-3']);
  const services = seen.map((call) => call.args.at(-1));
  assert.equal(services[0], 'Claude Code-credentials');
  assert.equal(services[1], claudeCredentialService(fixture.list()[1], {}));
  assert.equal(services[2], claudeCredentialService(fixture.list()[2], {}));
  assert.equal(new Set(services).size, 3);
  for (const call of seen) {
    assert.equal(call.cmd, 'security');
    assert.deepEqual(call.args.slice(0, 4), ['find-generic-password', '-a', 'fixture-user', '-w']);
  }
});

test('failed custom credential lookup never falls back to the default service', async () => {
  const account = accountFixture().list()[1];
  const services = [];
  await assert.rejects(claudeToken(account, {
    platform: 'darwin', env: { USER: 'fixture-user' },
    execFile: (_cmd, args, _options, callback) => {
      services.push(args.at(-1));
      callback(new Error('not found'), '');
    },
  }), (error) => error.code === 'credentials');
  assert.deepEqual(services, [claudeCredentialService(account, { USER: 'fixture-user' })]);
  assert.doesNotMatch(services[0], /^Claude Code-credentials$/);
});

test('Linux credentials are read only from the selected config directory', async () => {
  const account = accountFixture().list()[2];
  const reads = [];
  const token = await claudeToken(account, {
    platform: 'linux',
    fs: {
      readFileSync(file, encoding) {
        reads.push([file, encoding]);
        return JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-linux' } });
      },
    },
  });
  assert.equal(token, 'fixture-linux');
  assert.deepEqual(reads, [[path.join(account.configDir, '.credentials.json'), 'utf8']]);
});

test('account refresh failures have separate cooldowns, snapshots, and default compatibility view', async () => {
  const fixture = accountFixture();
  const manager = createUsageManager({ accounts: fixture });
  const calls = [];
  const firstAt = 10 ** 12;
  assert.equal(manager.requestRefresh(firstAt, async (account) => {
    calls.push(account.id);
    if (account.id === 'claude-work') throw Object.assign(new Error('missing'), { code: 'credentials' });
    return { limits: [{ label: 'week', percent: account.id === 'claude/default' ? 11 : 33 }], fetchedAt: firstAt };
  }), true);
  await settleRefresh();
  let view = manager._view();
  assert.deepEqual(Object.keys(view.accounts), fixture.list().map((account) => account.id));
  assert.equal(view.accounts['claude/default'].limits[0].percent, 11);
  assert.equal(view.accounts['claude-work'].error, 'credentials unavailable');
  assert.equal(view.accounts['claude-spare'].limits[0].percent, 33);
  assert.deepEqual(view.claude, { limits: [{ label: 'week', percent: 11 }], fetchedAt: firstAt });

  calls.length = 0;
  manager.requestRefresh(firstAt + 61e3, async (account) => {
    calls.push(account.id);
    return { limits: [{ label: 'week', percent: 50 }], fetchedAt: firstAt + 61e3 };
  });
  await settleRefresh();
  assert.deepEqual(calls.sort(), ['claude-default'.replace('-', '/'), 'claude-spare'].sort(),
    'the failed account alone remains in backoff');
  view = manager._view();
  assert.equal(view.accounts['claude-work'].error, 'credentials unavailable');
  assert.equal(view.accounts['claude/default'].limits[0].percent, 50);
});

test('cached account errors do not inflate usage health between real retries', async () => {
  const configured = [
    { id: 'claude/default', label: 'Primary', agent: 'claude', configDir: '/profiles/default', builtIn: true },
    { id: 'claude-secondary', label: 'Secondary', agent: 'claude', configDir: '/profiles/secondary' },
  ];
  const accountApi = {
    list: () => configured,
    defaultFor: () => configured[0],
  };
  let streak = 0;
  const records = [];
  const healthApi = { record: (name, options) => {
    if (options.ok === false) streak += 1;
    else if (!options.skipped) streak = 0;
    records.push({ name, options, streak });
  } };
  const manager = createUsageManager({ accounts: accountApi, health: healthApi });
  const firstAt = 10 ** 12;
  let secondaryFails = true;
  const refresh = async (account) => {
    if (account.id === 'claude-secondary' && secondaryFails) throw Object.assign(new Error('limited'), { code: 429 });
    return { limits: [{ label: 'week', percent: account.id === 'claude/default' ? 20 : 40 }], fetchedAt: firstAt };
  };

  manager.requestRefresh(firstAt, refresh);
  await settleRefresh();
  assert.deepEqual(records.at(-1), {
    name: 'usage', options: { ok: false, error: 'Secondary: HTTP 429' }, streak: 1,
  });
  assert.equal(manager._view().accounts['claude-secondary'].error, 'HTTP 429', 'rate limit remains visible in the cached account view');
  assert.equal(manager._states.get('claude-secondary').backoffMs, 4 * 60e3);

  manager.requestRefresh(firstAt + 61e3, refresh);
  await settleRefresh();
  manager.requestRefresh(firstAt + 122e3, refresh);
  await settleRefresh();
  assert.equal(records.filter((entry) => entry.options.ok === false).length, 1, 'healthy account refreshes do not recount a cached failure');
  assert.deepEqual(records.slice(-2).map((entry) => ({ options: entry.options, streak: entry.streak })), [
    { options: { ok: true, skipped: true, detail: 'waiting for failed account retry' }, streak: 1 },
    { options: { ok: true, skipped: true, detail: 'waiting for failed account retry' }, streak: 1 },
  ]);

  manager.requestRefresh(firstAt + 5 * 60e3 + 1, refresh);
  await settleRefresh();
  assert.deepEqual(records.at(-1), {
    name: 'usage', options: { ok: false, error: 'Secondary: HTTP 429' }, streak: 2,
  });
  assert.equal(manager._states.get('claude-secondary').backoffMs, 8 * 60e3, 'real retry failures retain exponential backoff');

  secondaryFails = false;
  manager.requestRefresh(firstAt + 14 * 60e3 + 2, refresh);
  await settleRefresh();
  assert.deepEqual(records.at(-1), { name: 'usage', options: { ok: true }, streak: 0 });
  assert.equal(manager._view().accounts['claude-secondary'].error, undefined);
  assert.equal(manager._states.get('claude-secondary').backoffMs, 0);
});

test('failures from accounts removed during refresh do not create stale health alerts', async () => {
  const configured = [
    { id: 'claude/default', label: 'Primary', agent: 'claude', configDir: '/profiles/default', builtIn: true },
    { id: 'claude-retired', label: 'Retired', agent: 'claude', configDir: '/profiles/retired' },
  ];
  const accountApi = { list: () => configured, defaultFor: () => configured[0] };
  const records = [];
  const manager = createUsageManager({ accounts: accountApi, health: { record: (name, options) => records.push({ name, options }) } });
  let rejectRetired;
  manager.requestRefresh(10 ** 12, async (account) => {
    if (account.id === 'claude-retired') return new Promise((_resolve, reject) => { rejectRetired = reject; });
    return { limits: [{ label: 'week', percent: 10 }], fetchedAt: 10 ** 12 };
  });
  await new Promise((resolve) => setImmediate(resolve));
  configured.pop();
  manager._view();
  rejectRetired(Object.assign(new Error('limited'), { code: 429 }));
  await settleRefresh();
  assert.deepEqual(records, [{ name: 'usage', options: { ok: true } }]);
  assert.equal(manager._states.has('claude-retired'), false);
});

test('removing a cached failing account clears health without waiting for another refresh', async () => {
  const configured = [
    { id: 'claude/default', label: 'Primary', agent: 'claude', configDir: '/profiles/default', builtIn: true },
    { id: 'claude-retired', label: 'Retired', agent: 'claude', configDir: '/profiles/retired' },
  ];
  const accountApi = { list: () => configured, defaultFor: () => configured[0] };
  const records = [];
  const manager = createUsageManager({ accounts: accountApi, health: { record: (name, options) => records.push({ name, options }) } });
  const firstAt = 10 ** 12;
  manager.requestRefresh(firstAt, async (account) => {
    if (account.id === 'claude-retired') throw Object.assign(new Error('limited'), { code: 429 });
    return { limits: [{ label: 'week', percent: 10 }], fetchedAt: firstAt };
  });
  await settleRefresh();
  assert.deepEqual(records.at(-1), { name: 'usage', options: { ok: false, error: 'Retired: HTTP 429' } });

  configured.pop();
  assert.equal(manager.requestRefresh(firstAt + 1000, async () => { throw new Error('not due'); }), false);
  assert.deepEqual(records.at(-1), { name: 'usage', options: { ok: true } });
  assert.equal(manager._states.has('claude-retired'), false);
});

test('a delayed batch cannot reapply a failure after that account recovers', async () => {
  const configured = [
    { id: 'claude-fast', label: 'Fast', agent: 'claude', configDir: '/profiles/fast' },
    { id: 'claude-slow', label: 'Slow', agent: 'claude', configDir: '/profiles/slow' },
  ];
  const accountApi = { list: () => configured, defaultFor: () => configured[0] };
  const records = [];
  const manager = createUsageManager({ accounts: accountApi, health: { record: (name, options) => records.push({ name, options }) } });
  const firstAt = 10 ** 12;
  let resolveSlow;
  manager.requestRefresh(firstAt, async (account) => {
    if (account.id === 'claude-fast') throw Object.assign(new Error('limited'), { code: 429 });
    return new Promise((resolve) => { resolveSlow = resolve; });
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager._view().accounts['claude-fast'].error, 'HTTP 429');
  assert.equal(records.length, 0, 'the original batch remains pending on the slow account');

  manager.requestRefresh(firstAt + 5 * 60e3 + 1, async (account) => ({
    limits: [{ label: 'week', percent: account.id === 'claude-fast' ? 25 : 50 }], fetchedAt: firstAt + 5 * 60e3 + 1,
  }));
  await settleRefresh();
  assert.equal(manager._view().accounts['claude-fast'].error, undefined);
  assert.deepEqual(records, [{ name: 'usage', options: { ok: true } }]);

  resolveSlow({ limits: [{ label: 'week', percent: 50 }], fetchedAt: firstAt });
  await settleRefresh();
  assert.equal(records.some((entry) => entry.options.ok === false), false);
  assert.deepEqual(records.at(-1), { name: 'usage', options: { ok: true } });
});

test('disk cache keeps Claude snapshots keyed by account', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-usage-cache-'));
  const file = path.join(dir, 'usage.json');
  const fixture = accountFixture();
  try {
    const writer = createUsageManager({ accounts: fixture });
    writer.setCacheFile(file);
    writer.requestRefresh(10 ** 12, async (account) => ({
      limits: [{ label: 'week', percent: account.id.length }], fetchedAt: 123,
    }));
    await settleRefresh();
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(stored.accounts).sort(), fixture.list().map((account) => account.id).sort());

    const reader = createUsageManager({ accounts: fixture });
    reader.setCacheFile(file);
    for (const account of fixture.list()) {
      assert.equal(reader._view().accounts[account.id].limits[0].percent, account.id.length);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
