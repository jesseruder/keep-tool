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
const { EventEmitter } = require('node:events');
const { execFileSync, spawn } = require('node:child_process');
const test = require('node:test');
const health = require('./health.js');
const {
  scanCodexUsage,
  scanCodexAccount,
  requestRefresh,
  createUsageManager,
  claudeCredentialService,
  claudeToken,
  fetchClaudeUsage,
} = require('./usage.js');
const usage = require('./usage.js');

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
    assert.equal(requestRefresh(Date.now(), async () => { throw new Error('must not refresh'); }), false);
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
      windows: [{ label: 'week', percent: 44, resetsAt: 1788459012000, windowMs: 604800000 }],
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
      windows: [{ label: '5h', percent: 3, resetsAt: 1788459012000, windowMs: 18000000 }],
      planType: 'pro',
      asOf: Date.parse('2026-08-28T23:16:39.452Z'),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Codex account with no rollout in the window reads as idle, not as a failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-usage-test-'));
  try {
    assert.deepEqual(scanCodexUsage([path.join(dir, '2026', '09', '18'), path.join(dir, 'missing')]),
      { windows: [], planType: null, asOf: null, idle: true }, 'absent date dirs are an idle account');
    fs.writeFileSync(path.join(dir, 'rollout-quiet.jsonl'), `${JSON.stringify({ timestamp: '2026-09-18T10:00:00Z', type: 'event_msg', payload: { type: 'agent_message' } })}\n`);
    assert.throws(() => scanCodexUsage([dir]), (error) => error.code === 'not-found',
      'a rollout that carries no rate_limits line is still a missing snapshot');
    const denied = { ...fs, readdirSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
    assert.throws(() => scanCodexUsage([dir], { fs: denied }), (error) => error.code === 'EACCES',
      'a sessions dir nobody can read is a fault, not an idle account');
    const unstattable = { ...fs, statSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
    assert.throws(() => scanCodexUsage([dir], { fs: unstattable }), (error) => error.code === 'EACCES',
      'a rollout nobody can stat is the same fault, not an idle account');
    const vanished = { ...fs, statSync: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } };
    assert.deepEqual(scanCodexUsage([dir], { fs: vanished }), { windows: [], planType: null, asOf: null, idle: true },
      'a rollout that vanished between readdir and stat is gone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an idle Codex account keeps the usage row green with a note until it is used again', async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-usage-codex-'));
  const configured = [
    { id: 'claude/default', label: 'Primary', agent: 'claude', configDir: '/profiles/default', builtIn: true },
    { id: 'codex/default', label: 'Codex (default)', agent: 'codex', configDir: codexHome, builtIn: true },
  ];
  const accountApi = {
    list: () => configured,
    defaultFor: (agent) => configured.find((account) => account.agent === agent),
  };
  const records = [];
  const healthApi = { record: (name, options) => records.push({ name, options }) };
  let currentTime = new Date('2026-09-18T12:00:00').getTime();
  const manager = createUsageManager({ accounts: accountApi, health: healthApi, now: () => currentTime });
  const dateDir = (date) => path.join(codexHome, 'sessions', String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
  const refresh = async (account) => account.agent === 'codex'
    ? scanCodexAccount(account, { date: new Date(currentTime) })
    : { limits: [{ label: 'week', percent: 20 }], fetchedAt: currentTime };
  try {
    // The newest rollout on this host predates the window: seven months ago.
    const old = dateDir(new Date('2026-02-18T12:00:00'));
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'rollout-old.jsonl'), `${rateLimitLine('2026-02-18T10:00:00Z', 'codex', 5)}\n`);

    manager.requestRefresh(currentTime, refresh);
    await settleRefresh();
    assert.deepEqual(records.at(-1), { name: 'usage', options: { ok: true, detail: 'Codex (default): no sessions in 7 days' } });
    let view = manager._view();
    assert.deepEqual(view.codex, { windows: [], planType: null, asOf: null, idle: true });
    assert.equal(view.accounts['codex/default'].error, undefined);

    // A dashboard poll between refreshes keeps the note on the row.
    manager.requestRefresh(currentTime + 1000, refresh);
    assert.deepEqual(records.at(-1), { name: 'usage', options: { ok: true, skipped: true, detail: 'nothing due; Codex (default): no sessions in 7 days' } });

    // A batch that refreshes only the Claude account still carries the idle note.
    currentTime += 5 * 60e3 + 1;
    manager._states.get('codex/default').nextAttemptAt = currentTime + 60e3;
    manager.requestRefresh(currentTime, refresh);
    await settleRefresh();
    assert.deepEqual(records.at(-1), { name: 'usage', options: { ok: true, detail: 'Codex (default): no sessions in 7 days' } });

    // An unreadable sessions dir is a failure that drops the idle flag from the view.
    manager._states.get('codex/default').nextAttemptAt = currentTime;
    manager.requestRefresh(currentTime, async (account) => account.agent === 'codex'
      ? scanCodexAccount(account, { date: new Date(currentTime), fs: { ...fs, readdirSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } } })
      : refresh(account));
    await settleRefresh();
    assert.deepEqual(records.at(-1), { name: 'usage', options: { ok: false, error: 'Codex (default): sessions unreadable (EACCES)' } });
    assert.equal(manager._view().codex.idle, undefined);
    manager.requestRefresh(currentTime + 1000, refresh);
    assert.deepEqual(records.at(-1), { name: 'usage', options: { ok: true, skipped: true, holdResult: true, detail: 'nothing due' } });

    // A Claude socket error carries the same shape of code and keeps its own label.
    manager._states.get('claude/default').nextAttemptAt = currentTime;
    manager._states.get('codex/default').nextAttemptAt = currentTime + 60e3;
    manager.requestRefresh(currentTime, async (account) => {
      if (account.agent === 'claude') throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      return refresh(account);
    });
    await settleRefresh();
    assert.deepEqual(records.at(-1), { name: 'usage', options: { ok: false, error: 'Primary: Claude usage unavailable' } });
    manager._states.get('claude/default').nextAttemptAt = currentTime;
    manager._states.get('codex/default').nextAttemptAt = currentTime;

    // Codex runs again today: the note goes and the reading comes back.
    const today = dateDir(new Date(currentTime));
    fs.mkdirSync(today, { recursive: true });
    fs.writeFileSync(path.join(today, 'rollout-today.jsonl'), `${rateLimitLine('2026-09-18T12:05:00Z', 'codex', 44)}\n`);
    currentTime += 5 * 60e3 + 1;
    manager.requestRefresh(currentTime, refresh);
    await settleRefresh();
    assert.deepEqual(records.at(-1), { name: 'usage', options: { ok: true } });
    view = manager._view();
    assert.equal(view.codex.idle, undefined);
    assert.equal(view.codex.windows[0].percent, 44);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
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

test('Claude HTTP 429 carries Retry-After into cooldown handling', async () => {
  const account = accountFixture().list()[0];
  const fakeHttps = { get: (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = (error) => request.emit('error', error);
    const response = new EventEmitter();
    response.statusCode = 429;
    response.headers = { 'retry-after': '1200' };
    response.setEncoding = () => {};
    setImmediate(() => { callback(response); setImmediate(() => response.emit('end')); });
    return request;
  } };
  await assert.rejects(fetchClaudeUsage(account, {
    platform: 'linux',
    fs: { readFileSync: () => JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token' } }) },
    https: fakeHttps,
  }), (error) => error.code === 429 && error.retryAfter === '1200');
});

test('account refresh failures have separate cooldowns, snapshots, and default compatibility view', async () => {
  const fixture = accountFixture();
  const calls = [];
  const firstAt = 10 ** 12;
  let currentTime = firstAt;
  const manager = createUsageManager({ accounts: fixture, now: () => currentTime });
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
  currentTime = firstAt + 5 * 60e3 + 1;
  manager.requestRefresh(currentTime, async (account) => {
    calls.push(account.id);
    return { limits: [{ label: 'week', percent: 50 }], fetchedAt: firstAt + 5 * 60e3 + 1 };
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
  const firstAt = 10 ** 12;
  let currentTime = firstAt;
  const manager = createUsageManager({ accounts: accountApi, health: healthApi, now: () => currentTime });
  let secondaryFails = true;
  const refresh = async (account) => {
    if (account.id === 'claude-secondary' && secondaryFails) throw Object.assign(new Error('limited'), { code: 429, retryAfter: '1800' });
    return { limits: [{ label: 'week', percent: account.id === 'claude/default' ? 20 : 40 }], fetchedAt: firstAt };
  };

  manager.requestRefresh(firstAt, refresh);
  await settleRefresh();
  assert.deepEqual(records.at(-1), {
    name: 'usage', options: { ok: false, error: 'Secondary: HTTP 429' }, streak: 1,
  });
  assert.equal(manager._view().accounts['claude-secondary'].error, 'HTTP 429', 'rate limit remains visible in the cached account view');
  assert.equal(manager._states.get('claude-secondary').backoffMs, 10 * 60e3);

  currentTime = firstAt + 5 * 60e3 + 1;
  manager.requestRefresh(currentTime, refresh);
  await settleRefresh();
  currentTime = firstAt + 10 * 60e3 + 2;
  manager.requestRefresh(currentTime, refresh);
  await settleRefresh();
  assert.equal(records.filter((entry) => entry.options.ok === false).length, 1, 'healthy account refreshes do not recount a cached failure');
  assert.deepEqual(records.slice(-2).map((entry) => ({ options: entry.options, streak: entry.streak })), [
    { options: { ok: true, skipped: true, holdResult: true, detail: 'waiting for failed account retry' }, streak: 1 },
    { options: { ok: true, skipped: true, holdResult: true, detail: 'waiting for failed account retry' }, streak: 1 },
  ]);

  currentTime = firstAt + 30 * 60e3 + 1;
  manager.requestRefresh(currentTime, refresh);
  await settleRefresh();
  assert.deepEqual(records.at(-1), {
    name: 'usage', options: { ok: false, error: 'Secondary: HTTP 429' }, streak: 2,
  });
  assert.equal(manager._states.get('claude-secondary').backoffMs, 20 * 60e3, 'real retry failures retain exponential backoff');

  secondaryFails = false;
  currentTime = firstAt + 60 * 60e3 + 2;
  manager.requestRefresh(currentTime, refresh);
  await settleRefresh();
  assert.deepEqual(records.at(-1), { name: 'usage', options: { ok: true }, streak: 0 });
  assert.equal(manager._view().accounts['claude-secondary'].error, undefined);
  assert.equal(manager._states.get('claude-secondary').backoffMs, 0);
});

test('a 429 over a recent reading is weather, logged once and bounded by the staleness window', async () => {
  const configured = [
    { id: 'claude/default', label: 'Primary', agent: 'claude', configDir: '/profiles/default', builtIn: true },
    { id: 'claude-secondary', label: 'Secondary', agent: 'claude', configDir: '/profiles/secondary' },
  ];
  const accountApi = { list: () => configured, defaultFor: () => configured[0] };
  const records = [];
  const logs = [];
  const firstAt = Date.parse('2026-09-17T12:00:00Z');
  let currentTime = firstAt;
  const manager = createUsageManager({
    accounts: accountApi, health: { record: (name, options) => records.push({ name, options }) }, now: () => currentTime,
  });
  const rateLimit = async () => { throw Object.assign(new Error('limited'), { code: 429 }); };
  const succeed = async () => ({ limits: [{ label: 'week', percent: 20 }], fetchedAt: currentTime });
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => { logs.push(String(chunk)); return true; };
  try {
    manager.requestRefresh(firstAt, succeed);
    await settleRefresh();
    assert.deepEqual(records.at(-1), { name: 'usage', options: { ok: true } });

    // The endpoint's limit is shared with every running Claude Code session, so a 429
    // over a reading the consumers are still using is weather: the row stays out of
    // the red, and the streak is cleared so three polls cannot turn it red either.
    currentTime = firstAt + 14 * 60e3;
    manager.requestRefresh(currentTime, rateLimit);
    await settleRefresh();
    const weather = records.at(-1);
    assert.equal(weather.name, 'usage');
    assert.equal(weather.options.ok, true);
    assert.equal(weather.options.skipped, true);
    assert.equal(weather.options.expected, true);
    assert.match(weather.options.detail,
      /^rate limited \(Primary\); retrying \d\d:\d\d, reading 14m old; rate limited \(Secondary\); retrying \d\d:\d\d, reading 14m old$/);
    assert.deepEqual(logs, [`keep usage: ${weather.options.detail}\n`]);

    // The same cooldown on a later poll is the same state, not a new event.
    currentTime = firstAt + 24 * 60e3 + 1;
    manager.requestRefresh(currentTime, rateLimit);
    await settleRefresh();
    assert.match(records.at(-1).options.detail, /reading 24m old/);
    assert.equal(logs.length, 1, 'the log line belongs to the transition, not to every poll');

    // The cooldown is capped so a recovered endpoint is read again inside the
    // 30-minute window bin/open-account.js and bin/review.js judge staleness by.
    currentTime = firstAt + 44 * 60e3 + 2;
    manager.requestRefresh(currentTime, rateLimit);
    await settleRefresh();
    for (const id of ['claude/default', 'claude-secondary']) {
      assert.equal(manager._states.get(id).backoffMs, 20 * 60e3, id);
      assert.equal(manager._states.get(id).nextAttemptAt, currentTime + 20 * 60e3, id);
    }

    // Past two hours nobody can say what the account has left any more, so the row
    // fails exactly as it always did.
    currentTime = firstAt + 121 * 60e3;
    manager.requestRefresh(currentTime, rateLimit);
    await settleRefresh();
    assert.deepEqual(records.at(-1), { name: 'usage', options: { ok: false, error: 'Primary: HTTP 429; Secondary: HTTP 429' } });

    // A recovered endpoint, then a 429 again: a new transition, so a new log line.
    currentTime = firstAt + 142 * 60e3;
    manager.requestRefresh(currentTime, succeed);
    await settleRefresh();
    assert.deepEqual(records.at(-1), { name: 'usage', options: { ok: true } });
    currentTime = firstAt + 148 * 60e3;
    manager.requestRefresh(currentTime, rateLimit);
    await settleRefresh();
    assert.equal(records.at(-1).options.skipped, true);
    assert.equal(logs.length, 2);

    // Anything that is not a rate limit fails the row, whatever else the batch holds.
    currentTime = firstAt + 160 * 60e3;
    manager.requestRefresh(currentTime, async (account) => {
      if (account.id === 'claude/default') throw Object.assign(new Error('missing'), { code: 'credentials' });
      throw Object.assign(new Error('limited'), { code: 429 });
    });
    await settleRefresh();
    assert.deepEqual(records.at(-1),
      { name: 'usage', options: { ok: false, error: 'Primary: credentials unavailable; Secondary: HTTP 429' } });
  } finally { process.stderr.write = originalWrite; }
});

test('weather on one account never clears another account\'s unresolved real failure', async () => {
  const configured = [
    { id: 'claude/default', label: 'Primary', agent: 'claude', configDir: '/profiles/default', builtIn: true },
    { id: 'claude-secondary', label: 'Secondary', agent: 'claude', configDir: '/profiles/secondary' },
  ];
  const accountApi = { list: () => configured, defaultFor: () => configured[0] };
  const records = [];
  const firstAt = Date.parse('2026-09-17T12:00:00Z');
  let currentTime = firstAt;
  const manager = createUsageManager({
    accounts: accountApi, health: { record: (name, options) => records.push({ name, options }) }, now: () => currentTime,
  });
  // The streak the scheduler-wide row actually carries, folded exactly as
  // bin/health.js does: a failure adds one, a success or an expected state zeroes it,
  // an ordinary skip leaves it alone.
  let streak = 0;
  const apply = () => {
    const options = records.at(-1).options;
    if (options.ok === false) streak += 1;
    else if (options.expected === true || !options.skipped) streak = 0;
    return options;
  };
  // The two accounts' cooldowns interleave, which is the whole shape of the bug: a
  // broken-credentials account retries at +5m+4m and a rate-limited one at +10m, so
  // there are batches that hold only the rate-limited account while the real fault is
  // still unresolved. `t1` is the first tick on which both are due.
  const t1 = firstAt + 5 * 60e3 + 1;
  const mixed = async (account) => {
    if (account.id === 'claude/default') throw Object.assign(new Error('missing'), { code: 'credentials' });
    throw Object.assign(new Error('limited'), { code: 429 });
  };
  const poll = async (at, refresh = mixed) => {
    currentTime = at;
    manager.requestRefresh(at, refresh);
    await settleRefresh();
    return apply();
  };
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    // Both readable to begin with, so the 429s below are over recent readings.
    await poll(firstAt, async () => ({ limits: [{ label: 'week', percent: 20 }], fetchedAt: currentTime }));
    assert.equal(streak, 0);

    // Primary's credentials are broken, Secondary is rate limited: a batch with a real
    // fault in it fails the row, as it always did.
    assert.equal((await poll(t1)).ok, false);
    assert.equal(streak, 1);
    assert.equal((await poll(t1 + 9 * 60e3)).error, 'Primary: credentials unavailable', 'only Primary is due');
    assert.equal(streak, 2);

    // Now only Secondary is due and its failure is weather. Before the fix this
    // recorded an expected state, which zeroed the streak Primary's unresolved fault
    // had just earned — the reviewer's twelve-hour simulation cleared it 46 times, so
    // the row never reached two consecutive failures and never went red.
    const weather = (options) => {
      assert.equal(options.ok, true);
      assert.equal(options.skipped, true);
      assert.equal(options.expected, undefined, 'the other account\'s fault is not cleared');
      assert.match(options.detail,
        /^rate limited \(Secondary\); retrying \d\d:\d\d, reading \d+m old; unresolved: Primary: credentials unavailable$/);
    };
    weather(await poll(t1 + 10 * 60e3));
    assert.equal(streak, 2, 'weather neither clears the streak');
    assert.equal((await poll(t1 + 22 * 60e3)).error, 'Primary: credentials unavailable');
    assert.equal(streak, 3, 'so the row still goes red on Primary\'s third retry');
    weather(await poll(t1 + 30 * 60e3));
    assert.equal(streak, 3, 'nor inflates it');

    // Once the real fault clears, the very next weather skip is expected again.
    await poll(t1 + 43 * 60e3, async (account) => {
      if (account.id === 'claude/default') return { limits: [{ label: 'week', percent: 20 }], fetchedAt: currentTime };
      throw Object.assign(new Error('limited'), { code: 429 });
    });
    const cleared = await poll(t1 + 50 * 60e3, async (account) => {
      if (account.id === 'claude/default') return { limits: [{ label: 'week', percent: 20 }], fetchedAt: currentTime };
      throw Object.assign(new Error('limited'), { code: 429 });
    });
    assert.equal(cleared.expected, true);
    assert.match(cleared.detail, /^rate limited \(Secondary\); retrying \d\d:\d\d, reading 55m old$/);
    assert.equal(streak, 0);
  } finally { process.stderr.write = originalWrite; }
});

test('a rate limit nobody can judge stays a real failure that another account\'s weather cannot clear', async () => {
  const configured = [
    { id: 'claude-a', label: 'Alpha', agent: 'claude', configDir: '/profiles/a' },
    { id: 'claude-b', label: 'Bravo', agent: 'claude', configDir: '/profiles/b' },
  ];
  const t0 = Date.parse('2026-09-17T12:00:00Z');
  const GRACE_MS = 2 * 3600e3;
  const HOUR_MS = 60 * 60e3;

  // Alpha is rate limited continuously with nothing anyone can judge it by, so its 429
  // is recorded as a real failure — and has to stay one while it waits. Two ways to get
  // there: it never had a reading at all, or the reading it has ages past the grace.
  // Bravo meanwhile alternates success and 429 over a reading minutes old, which is
  // tolerable weather. Exempting *every* rate-limited account from the unresolved check
  // let Bravo's weather clear the streak Alpha had earned, so the row never passed one
  // failure in twelve hours.
  for (const variant of [
    { name: 'Alpha never had a reading', setupAt: null, start: t0 },
    { name: 'Alpha\'s reading ages past the grace', setupAt: t0, start: t0 + GRACE_MS + 5 * 60e3 },
  ]) {
    const accountApi = { list: () => configured, defaultFor: () => configured[0] };
    const records = [];
    let currentTime = t0;
    const manager = createUsageManager({
      accounts: accountApi, health: { record: (name, options) => records.push({ name, options }) }, now: () => currentTime,
    });
    // The streak the scheduler-wide row carries, folded the way bin/health.js does: a
    // failure adds one, a success or an expected state zeroes it, an ordinary skip
    // leaves it alone.
    let streak = 0;
    const apply = () => {
      const options = records.at(-1).options;
      if (options.ok === false) streak += 1;
      else if (options.expected === true || !options.skipped) streak = 0;
      return options;
    };
    const reading = () => ({ limits: [{ label: 'week', percent: 20 }], fetchedAt: currentTime });
    const limited = () => { throw Object.assign(new Error('limited'), { code: 429 }); };
    // Alpha's 429s carry the endpoint's own Retry-After, which Keep honours past its
    // exponential cap. An hour is what holds Alpha out of the polls between rounds, so
    // each batch below contains exactly the accounts its assertion is about. Bravo's are
    // plain, so it keeps the ordinary ten-minute cooldown and cycles inside that hour.
    const limitedForAnHour = () => { throw Object.assign(new Error('limited'), { code: 429, retryAfter: '3600' }); };
    const poll = async (at, plan) => {
      const asked = [];
      currentTime = at;
      manager.requestRefresh(at, async (account) => {
        asked.push(account.id);
        const outcome = plan[account.id];
        if (!outcome) throw Object.assign(new Error('unplanned'), { code: 'response' });
        return outcome();
      });
      await settleRefresh();
      return { asked, options: apply() };
    };
    const originalWrite = process.stderr.write;
    process.stderr.write = () => true;
    try {
      if (variant.setupAt !== null) {
        // Alpha starts with the reading that later ages out.
        const first = await poll(variant.setupAt, { 'claude-a': reading, 'claude-b': reading });
        assert.deepEqual(first.options, { ok: true }, variant.name);
        assert.equal(streak, 0, variant.name);
      }

      for (let round = 0; round < 4; round += 1) {
        const at = variant.start + round * HOUR_MS;
        const before = streak;
        const where = `${variant.name}, round ${round}`;

        // Alpha's 429 over no usable reading fails the row, exactly as it does today.
        // Bravo answers, so Alpha's is the batch's only failure.
        const real = await poll(at, { 'claude-a': limitedForAnHour, 'claude-b': reading });
        assert.deepEqual(real.asked, ['claude-a', 'claude-b'], where);
        assert.deepEqual(real.options, { ok: false, error: 'Alpha: HTTP 429' }, where);
        assert.equal(streak, before + 1, where);

        // Alpha is now an hour into the server's own cooldown, so these batches hold
        // only Bravo. Its 429 over a five-minute-old reading is weather: it must neither
        // inflate the streak nor clear what Alpha is still sitting on.
        const weather = async (offset) => {
          const step = await poll(at + offset, { 'claude-b': limited });
          assert.deepEqual(step.asked, ['claude-b'], where);
          assert.equal(step.options.ok, true, where);
          assert.equal(step.options.skipped, true, where);
          assert.equal(step.options.holdResult, true, `${where}: Alpha's failure stays the latest result`);
          assert.equal(step.options.expected, undefined, `${where}: Alpha's failure is not cleared`);
          assert.match(step.options.detail,
            /^rate limited \(Bravo\); retrying \d\d:\d\d, reading 5m old; unresolved: Alpha: HTTP 429$/, where);
          assert.equal(streak, before + 1, where);
        };
        await weather(5 * 60e3);

        // Bravo recovering refreshes its reading. Alpha is still the only thing
        // outstanding, so this is the ordinary between-retries skip, which has always
        // left the streak alone.
        const between = await poll(at + 15 * 60e3, { 'claude-b': reading });
        assert.deepEqual(between.asked, ['claude-b'], where);
        assert.deepEqual(between.options, { ok: true, skipped: true, holdResult: true, detail: 'waiting for failed account retry' }, where);
        assert.equal(streak, before + 1, where);

        await weather(20 * 60e3);
      }
      // Four of Alpha's own hourly retries, eight tolerable Bravo 429s in between, and
      // the count is exactly Alpha's: the row goes red at three and stays red.
      assert.equal(streak, 4, variant.name);

      // Once Alpha answers, the only failure left is Bravo's own 429 inside the grace.
      // Nothing is outstanding, so the row may finally clear.
      const cleared = await poll(variant.start + 4 * HOUR_MS, { 'claude-a': reading, 'claude-b': limited });
      assert.deepEqual(cleared.asked, ['claude-a', 'claude-b'], variant.name);
      assert.equal(cleared.options.expected, true, variant.name);
      assert.match(cleared.options.detail, /^rate limited \(Bravo\); retrying \d\d:\d\d, reading 45m old$/, variant.name);
      assert.equal(streak, 0, variant.name);
    } finally { process.stderr.write = originalWrite; }
  }
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
  const firstAt = 10 ** 12;
  let currentTime = firstAt;
  const manager = createUsageManager({ accounts: accountApi, health: { record: (name, options) => records.push({ name, options }) }, now: () => currentTime });
  let resolveSlow;
  manager.requestRefresh(firstAt, async (account) => {
    if (account.id === 'claude-fast') throw Object.assign(new Error('limited'), { code: 429 });
    return new Promise((resolve) => { resolveSlow = resolve; });
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager._view().accounts['claude-fast'].error, 'HTTP 429');
  assert.equal(records.length, 0, 'the original batch remains pending on the slow account');

  currentTime = firstAt + 10 * 60e3 + 1;
  manager.requestRefresh(currentTime, async (account) => ({
    limits: [{ label: 'week', percent: account.id === 'claude-fast' ? 25 : 50 }], fetchedAt: firstAt + 10 * 60e3 + 1,
  }));
  await settleRefresh();
  assert.equal(manager._view().accounts['claude-fast'].error, undefined);
  assert.deepEqual(records, [{ name: 'usage', options: { ok: true } }]);

  resolveSlow({ limits: [{ label: 'week', percent: 50 }], fetchedAt: firstAt });
  await settleRefresh();
  assert.equal(records.some((entry) => entry.options.ok === false), false);
  assert.deepEqual(records.at(-1), { name: 'usage', options: { ok: true } });
});

test('successful Claude cache preserves the five-minute cadence across restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-usage-success-cache-'));
  const file = path.join(dir, 'usage-cache.json');
  const fixture = accountFixture();
  let now = 10 ** 12;
  try {
    const writer = createUsageManager({ accounts: fixture, now: () => now });
    writer.setCacheFile(file);
    writer.requestRefresh(now, async (account) => ({
      limits: [{ label: 'week', percent: account.id.length }], fetchedAt: now,
    }));
    await settleRefresh();
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.version, 2);
    assert.equal(stored.claude.limits[0].percent, 'claude/default'.length, 'flat default snapshot remains available to budget consumers');
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /accessToken|Authorization|Bearer/);

    now += 4 * 60e3;
    const reader = createUsageManager({ accounts: fixture, now: () => now });
    reader.setCacheFile(file);
    let calls = 0;
    assert.equal(reader.requestRefresh(now, async () => { calls += 1; }), false);
    assert.equal(calls, 0, 'a fresh successful snapshot is not fetched immediately after restart');
    assert.equal(reader._view().accounts['claude/default'].limits[0].percent, 'claude/default'.length);

    now += 60e3 + 1;
    assert.equal(reader.requestRefresh(now, async () => { calls += 1; return { limits: [], fetchedAt: now }; }), true);
    await settleRefresh();
    assert.equal(calls, fixture.list().length);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rate-limit cooldown and empty error snapshot survive restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-usage-failure-cache-'));
  const file = path.join(dir, 'usage-cache.json');
  const records = [{ id: 'claude-secondary', label: 'Secondary', agent: 'claude', configDir: '/profiles/secondary' }];
  const fixture = { list: () => records, defaultFor: () => records[0] };
  let now = 10 ** 12;
  try {
    const writer = createUsageManager({ accounts: fixture, now: () => now });
    writer.setCacheFile(file);
    writer.requestRefresh(now, async () => { throw Object.assign(new Error('limited'), { code: 429, retryAfter: '1200' }); });
    await settleRefresh();
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')).accounts['claude-secondary'];
    assert.equal(stored.snapshot.error, 'HTTP 429');
    assert.deepEqual(stored.snapshot.limits, []);
    assert.equal(stored.backoffMs, 10 * 60e3, 'Retry-After does not shorten exponential fallback');
    assert.equal(stored.nextAttemptAt, now + 20 * 60e3, 'delta-seconds Retry-After extends the cooldown');
    assert.deepEqual(Object.keys(stored.identity).sort(), ['agent', 'configDir', 'credentialService']);

    now += 15 * 60e3;
    const reader = createUsageManager({ accounts: fixture, now: () => now });
    reader.setCacheFile(file);
    let calls = 0;
    assert.equal(reader._view().accounts['claude-secondary'].error, 'HTTP 429');
    assert.equal(reader.requestRefresh(now, async () => { calls += 1; }), false);
    assert.equal(calls, 0);

    now += 5 * 60e3 + 1;
    assert.equal(reader.requestRefresh(now, async () => {
      calls += 1;
      return { limits: [{ label: 'week', percent: 31 }], fetchedAt: now };
    }), true);
    await settleRefresh();
    assert.equal(calls, 1);
    assert.equal(reader._view().accounts['claude-secondary'].error, undefined);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).accounts['claude-secondary'].backoffMs, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP-date Retry-After is honored per account and bounded', async () => {
  const records = [
    { id: 'claude-date', label: 'Date', agent: 'claude', configDir: '/profiles/date' },
    { id: 'claude-short', label: 'Short', agent: 'claude', configDir: '/profiles/short' },
  ];
  const fixture = { list: () => records, defaultFor: () => records[0] };
  const now = Date.parse('2030-01-01T00:00:00Z');
  const manager = createUsageManager({ accounts: fixture, now: () => now });
  manager.requestRefresh(now, async (account) => {
    const retryAfter = account.id === 'claude-date'
      ? new Date(now + 2 * 60 * 60e3).toUTCString()
      : '60';
    throw Object.assign(new Error('limited'), { code: 429, retryAfter });
  });
  await settleRefresh();
  assert.equal(manager._states.get('claude-date').nextAttemptAt, now + 2 * 60 * 60e3, 'valid server cooldowns may exceed the exponential cap');
  assert.equal(manager._states.get('claude-short').nextAttemptAt, now + 10 * 60e3, 'short server advice cannot reduce exponential cooldown');
});

test('429 cooldown starts when the response arrives', async () => {
  const records = [{ id: 'claude-slow', label: 'Slow', agent: 'claude', configDir: '/profiles/slow' }];
  const fixture = { list: () => records, defaultFor: () => records[0] };
  let now = 10 ** 12;
  const manager = createUsageManager({ accounts: fixture, now: () => now });
  let rejectRefresh;
  manager.requestRefresh(now, async () => new Promise((_resolve, reject) => { rejectRefresh = reject; }));
  await new Promise((resolve) => setImmediate(resolve));
  now += 2 * 60e3;
  rejectRefresh(Object.assign(new Error('limited'), { code: 429, retryAfter: '60' }));
  await settleRefresh();
  assert.equal(manager._states.get('claude-slow').nextAttemptAt, now + 10 * 60e3);
});

test('completion from a replaced account cannot overwrite its new state or cache', async () => {
  for (const outcome of ['success', 'failure']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `keep-usage-stale-${outcome}-`));
    const file = path.join(dir, 'usage-cache.json');
    const configured = [{ id: 'claude-shared', label: 'Old', agent: 'claude', configDir: '/profiles/old' }];
    const fixture = { list: () => configured, defaultFor: () => configured[0] };
    const manager = createUsageManager({ accounts: fixture, now: () => 10 ** 12 });
    let settle;
    try {
      manager.setCacheFile(file);
      manager.requestRefresh(10 ** 12, async () => new Promise((resolve, reject) => {
        settle = outcome === 'success' ? () => resolve({ limits: [{ label: 'week', percent: 99 }], fetchedAt: 10 ** 12 })
          : () => reject(Object.assign(new Error('limited'), { code: 429 }));
      }));
      await new Promise((resolve) => setImmediate(resolve));
      configured[0] = { ...configured[0], label: 'New', configDir: '/profiles/new' };
      manager._view();
      settle();
      await settleRefresh();
      const state = manager._states.get('claude-shared');
      assert.equal(state.account.configDir, '/profiles/new');
      assert.deepEqual(state.snapshot, { limits: [], fetchedAt: null });
      assert.equal(state.nextAttemptAt, 0);
      assert.equal(fs.existsSync(file), false, `${outcome} from old identity must not write cache`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('usage cache merge is serialized across processes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-usage-cache-lock-'));
  const file = path.join(dir, 'usage-cache.json');
  const marker = path.join(dir, 'child-ready');
  const lock = `${file}.lock`;
  const ownerFile = path.join(lock, 'owner.json');
  fs.mkdirSync(lock);
  fs.writeFileSync(ownerFile, JSON.stringify({
    pid: process.pid,
    startedAt: execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim(),
    token: 'parent-test-lock',
  }));
  const script = `
    const fs = require('fs');
    const usage = require(${JSON.stringify(path.join(__dirname, 'usage.js'))});
    const account = { id: 'claude-child', label: 'Child', agent: 'claude', configDir: '/profiles/child' };
    const manager = usage.createUsageManager({ accounts: { list: () => [account], defaultFor: () => account }, health: { record() {} } });
    manager.setCacheFile(${JSON.stringify(file)});
    fs.writeFileSync(${JSON.stringify(marker)}, 'ready');
    manager.setOnChange(() => setTimeout(() => process.exit(0), 10));
    manager.requestRefresh(Date.now(), async () => ({ limits: [{ label: 'week', percent: 22 }], fetchedAt: Date.now() }));
    setTimeout(() => process.exit(2), 6000);
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  try {
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(marker) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    assert.equal(fs.existsSync(marker), true, 'child reached the locked cache update');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
    fs.writeFileSync(file, JSON.stringify({ version: 2, accounts: { 'claude-parent': { snapshot: { limits: [], fetchedAt: null } } } }));
    fs.unlinkSync(ownerFile);
    fs.rmdirSync(lock);
    const exitCode = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(exitCode, 0);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(stored.accounts).sort(), ['claude-child', 'claude-parent']);
  } finally {
    try { fs.unlinkSync(ownerFile); } catch {}
    try { fs.rmdirSync(lock); } catch {}
    if (child.exitCode === null) child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh dead and reused-PID cache locks recover without blocking the event loop', async () => {
  for (const owner of [
    { pid: 2147483647, startedAt: 'dead process', token: 'dead-owner' },
    { pid: process.pid, startedAt: 'Mon Jan  1 00:00:00 1990', token: 'reused-pid' },
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-usage-dead-lock-'));
    const file = path.join(dir, 'usage-cache.json');
    const lock = `${file}.lock`;
    const ownerFile = path.join(lock, 'owner.json');
    const account = { id: 'claude/default', label: 'Primary', agent: 'claude', configDir: '/profiles/default', builtIn: true };
    const fixture = { list: () => [account], defaultFor: () => account };
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(ownerFile, JSON.stringify(owner));
      const manager = createUsageManager({ accounts: fixture, health: { record() {} } });
      manager.setCacheFile(file);
      let eventLoopTicked = false;
      setTimeout(() => { eventLoopTicked = true; }, 25);
      const changed = new Promise((resolve) => manager.setOnChange(resolve));
      const startedAt = Date.now();
      manager.requestRefresh(Date.now(), async () => ({ limits: [{ label: 'week', percent: 12 }], fetchedAt: Date.now() }));
      await changed;
      assert.equal(eventLoopTicked, true, `${owner.token} wait should yield the event loop`);
      assert.ok(Date.now() - startedAt >= 200 && Date.now() - startedAt < 2000, `${owner.token} should recover after the creation grace`);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).claude.limits[0].percent, 12);
      assert.equal(fs.existsSync(lock), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('legacy and corrupt caches migrate safely while identity prevents account crossover', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-usage-legacy-cache-'));
  const file = path.join(dir, 'usage-cache.json');
  const now = 10 ** 12;
  const original = [{ id: 'claude-shared', label: 'Original', agent: 'claude', configDir: '/profiles/original' }];
  const originalApi = { list: () => original, defaultFor: () => original[0] };
  try {
    fs.writeFileSync(file, JSON.stringify({ accounts: { 'claude-shared': {
      limits: [{ label: 'week', percent: 41 }], fetchedAt: now,
    } } }));
    let manager = createUsageManager({ accounts: originalApi, now: () => now + 4 * 60e3 });
    manager.setCacheFile(file);
    assert.equal(manager._view().accounts['claude-shared'].limits[0].percent, 41, 'legacy snapshot remains readable');
    assert.equal(manager.requestRefresh(now + 4 * 60e3, async () => { throw new Error('fresh cache'); }), false);

    manager.requestRefresh(now + 5 * 60e3 + 1, async () => ({ limits: [{ label: 'week', percent: 42 }], fetchedAt: now + 5 * 60e3 + 1 }));
    await settleRefresh();
    const replacement = [{ id: 'claude-shared', label: 'Replacement', agent: 'claude', configDir: '/profiles/replacement' }];
    const replacementApi = { list: () => replacement, defaultFor: () => replacement[0] };
    manager = createUsageManager({ accounts: replacementApi, now: () => now + 6 * 60e3 });
    manager.setCacheFile(file);
    assert.deepEqual(manager._view().accounts['claude-shared'].limits, [], 'v2 cache is bound to credential identity');
    assert.equal(manager.requestRefresh(now + 6 * 60e3, async () => ({ limits: [], fetchedAt: now })), true);
    await settleRefresh();

    fs.writeFileSync(file, '{not json');
    manager = createUsageManager({ accounts: originalApi, now: () => now });
    manager.setCacheFile(file);
    assert.equal(manager.requestRefresh(now, async () => ({ limits: [], fetchedAt: now })), true, 'corrupt cache cannot create a permanent cooldown');
    await settleRefresh();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
    for (const account of fixture.list()) assert.equal(reader._view().accounts[account.id].limits[0].percent, account.id.length);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('readAccountUsage reads a Claude account credentials on this machine, and codes its failures', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-usage-node-'));
  try {
    const account = { id: 'claude-node', agent: 'claude', configDir: dir, builtIn: false, managed: false };
    fs.writeFileSync(path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'token-from-this-machine' } }));
    const seen = [];
    const https = (body, statusCode = 200, headers = {}) => ({
      get: (url, options, handler) => {
        seen.push({ url, authorization: options.headers.Authorization });
        const request = { setTimeout() {}, on() {}, destroy() {} };
        queueMicrotask(() => handler({
          statusCode, headers,
          setEncoding() {},
          on: (event, listener) => {
            if (event === 'data') listener(body);
            if (event === 'end') listener();
          },
        }));
        return request;
      },
    });
    const ok = await usage.readAccountUsage(account, {
      platform: 'linux', https: https(JSON.stringify({ limits: [{ kind: 'session', percent: 42 }] })),
      now: () => 1000,
    });
    assert.deepEqual(seen, [{ url: 'https://api.anthropic.com/api/oauth/usage', authorization: 'Bearer token-from-this-machine' }]);
    assert.deepEqual(ok.usage.limits, [{ label: '5h', percent: 42, windowMs: 5 * 3600e3, severity: null, resetsAt: null }]);
    assert.equal(ok.failure, undefined);

    // A rate limit is the one failure a caller has to be able to act on, so its code
    // and its retry-after survive being answered rather than thrown.
    const limited = await usage.readAccountUsage(account, {
      platform: 'linux', https: https('', 429, { 'retry-after': '120' }),
    });
    assert.equal(limited.usage, undefined);
    assert.equal(limited.failure.code, 429);
    assert.equal(limited.failure.retryAfter, '120');

    fs.rmSync(path.join(dir, '.credentials.json'));
    const missing = await usage.readAccountUsage(account, { platform: 'linux', https: https('') });
    assert.equal(missing.failure.code, 'credentials');

    // A Codex account is scanned from its own rollout directory on this machine;
    // nothing there is an idle reading, not a failure.
    const codex = await usage.readAccountUsage(
      { id: 'codex-node', agent: 'codex', configDir: dir, builtIn: false, managed: false }, {});
    assert.equal(codex.failure, undefined);
    assert.deepEqual(codex.usage, { windows: [], planType: null, asOf: null, idle: true });

    await assert.rejects(usage.readAccountUsage({ id: 'x', agent: 'pi', configDir: dir }),
      /claude or codex account profile/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
