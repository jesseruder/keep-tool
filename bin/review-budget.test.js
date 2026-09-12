'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const review = require('./review.js');
const { reviewBudgetCommandCli, resolveReviewBudgetTarget } = require('./keep.js');

const ACCOUNTS = {
  primary: { id: 'primary', agent: 'claude', label: 'Primary' },
  secondary: { id: 'secondary', agent: 'claude', label: 'Secondary' },
  caller: { id: 'caller', agent: 'codex', label: 'Codex caller' },
};

function limitSnapshot(week, short = 10) {
  const now = Date.now();
  return {
    limits: [
      { label: 'week', percent: week, resetsAt: new Date(now + 86400e3).toISOString() },
      { label: '5h', percent: short, resetsAt: new Date(now + 3600e3).toISOString() },
    ],
    fetchedAt: now,
  };
}

function usageView({ primary = limitSnapshot(97), secondary = limitSnapshot(13) } = {}) {
  return {
    claude: primary,
    accounts: {
      primary: { ...ACCOUNTS.primary, ...primary },
      secondary: { ...ACCOUNTS.secondary, ...secondary },
      caller: { ...ACCOUNTS.caller, limits: [], fetchedAt: null },
    },
  };
}

function fixture(options = {}) {
  const sessions = options.sessions || [{
    id: 'reviewer-session', reviewer: true, accountId: 'secondary', state: 'idle', endedTurn: true, mtime: Date.now(),
  }];
  const snapshot = options.snapshot || usageView();
  const exits = [];
  const logs = [];
  const authorityCalls = [];
  const accounts = {
    get(id) { return options.accounts?.[id] === null ? null : (options.accounts?.[id] || ACCOUNTS[id] || null); },
    forSession(id, agent, opts) {
      authorityCalls.push({ id, agent, opts });
      if (opts.allowDiscovery === false) {
        if (options.authorityError) throw options.authorityError;
        return options.authority === undefined ? ACCOUNTS.secondary : options.authority;
      }
      if (options.discoveryError) throw options.discoveryError;
      return options.discoveredAuthority === undefined ? ACCOUNTS.secondary : options.discoveredAuthority;
    },
  };
  const usage = {
    cacheFiles: [],
    setCacheFile(file) { this.cacheFiles.push(file); },
    getUsage() { return snapshot; },
  };
  const deps = {
    review,
    accounts,
    usage,
    root: '/tmp/review-budget-fixture',
    env: { KEEP_AGENT_ACCOUNT_ID: 'caller' },
    getKeepApi: async () => options.stateError
      ? Promise.reject(options.stateError)
      : ({ status: options.stateStatus || 200, data: JSON.stringify({ sessions }) }),
    loadReviewMeta: () => ({ bootstrapAttempts: { 'older-reviewer': 3 } }),
    findReviewerSession: options.findReviewerSession || ((rows) => rows.find((row) => row.reviewer) || null),
    readReviewerMarker: () => options.marker || { model: 'haiku' },
    sleep: async () => {},
    exit: (code) => exits.push(code),
    log: (line) => logs.push(line),
  };
  return { deps, exits, logs, authorityCalls, usage };
}

test('implicit review-budget uses the active reviewer account and marker model, not caller or primary', async () => {
  const f = fixture();
  const prior = process.env.KEEP_AGENT_ACCOUNT_ID;
  process.env.KEEP_AGENT_ACCOUNT_ID = 'caller';
  try {
    const result = await reviewBudgetCommandCli(['--json'], f.deps);
    assert.equal(result.code, 0, 'secondary is at 13%; using primary at 97% would stop');
    assert.equal(result.accountId, 'secondary');
    assert.equal(result.model, 'haiku');
    assert.deepEqual(f.exits, []);
    assert.deepEqual(f.authorityCalls.map(({ id, agent, opts }) => ({
      id, agent, allowDiscovery: opts.allowDiscovery,
    })), [{ id: 'reviewer-session', agent: 'claude', allowDiscovery: false }]);
    assert.equal(JSON.parse(f.logs[0]).accountId, 'secondary');
  } finally {
    if (prior === undefined) delete process.env.KEEP_AGENT_ACCOUNT_ID;
    else process.env.KEEP_AGENT_ACCOUNT_ID = prior;
  }
});

test('explicit account is deterministic, honors model override, and preserves governor windows', async () => {
  const f = fixture({ snapshot: usageView({ primary: limitSnapshot(13, 95) }) });
  const result = await reviewBudgetCommandCli(['--account', 'primary', '--model', 'sonnet', '--json'], f.deps);
  assert.equal(result.accountId, 'primary');
  assert.equal(result.model, 'sonnet');
  assert.equal(result.code, 7);
  assert.match(result.reason, /5h window/);
  assert.deepEqual(f.exits, [7]);
  assert.deepEqual(f.authorityCalls, [], 'an explicit account does not inherit a reviewer session authority');

  const weekly = fixture();
  const weeklyResult = await reviewBudgetCommandCli(['--account', 'primary'], weekly.deps);
  assert.equal(weeklyResult.code, 6);
  assert.match(weeklyResult.reason, /weekly usage/);
  assert.deepEqual(weekly.exits, [6]);
});

test('explicit unknown and non-Claude accounts fail closed without reading a usage snapshot', async () => {
  for (const id of ['missing', 'caller']) {
    const f = fixture();
    let usageReads = 0;
    f.deps.usage.getUsage = () => { usageReads += 1; return usageView(); };
    const result = await reviewBudgetCommandCli(['--account', id], f.deps);
    assert.equal(result.code, 8, id);
    assert.deepEqual(f.exits, [8], id);
    assert.equal(usageReads, 0, id);
    assert.match(result.reason, /not a configured Claude account/, id);
  }
});

test('implicit account identity fails closed when state is missing or ambiguous', async () => {
  const cases = [
    {
      name: 'state unavailable',
      options: { stateError: new Error('offline') },
      pattern: /Keep state is unavailable/,
    },
    {
      name: 'reviewer account missing',
      options: { sessions: [{ id: 'reviewer-session', reviewer: true, state: 'idle', mtime: Date.now() }] },
      pattern: /no verified account identity/,
    },
    {
      name: 'reviewer account conflicts across inventory rows',
      options: { sessions: [
        { id: 'reviewer-session', reviewer: true, accountId: 'secondary', state: 'idle', mtime: Date.now() },
        { id: 'reviewer-session', accountId: 'primary', state: 'idle', mtime: Date.now() - 1 },
      ] },
      pattern: /conflicting account identities/,
    },
    {
      name: 'reviewer account is no longer configured',
      options: { sessions: [{ id: 'reviewer-session', reviewer: true, accountId: 'removed', mtime: Date.now() }] },
      pattern: /not an available Claude account/,
    },
  ];
  for (const entry of cases) {
    const f = fixture(entry.options);
    const result = await reviewBudgetCommandCli([], f.deps);
    assert.equal(result.code, 8, entry.name);
    assert.match(result.reason, entry.pattern, entry.name);
    assert.deepEqual(f.exits, [8], entry.name);
  }
});

test('implicit reviewer rejects staged and conflicting durable authority', async () => {
  const staged = fixture({ authorityError: new Error('session reviewer-session has an unfinished account handoff') });
  const stagedResult = await reviewBudgetCommandCli([], staged.deps);
  assert.equal(stagedResult.code, 8);
  assert.match(stagedResult.reason, /unfinished account handoff/);

  const conflicting = fixture({ authority: ACCOUNTS.primary });
  const conflictingResult = await reviewBudgetCommandCli([], conflicting.deps);
  assert.equal(conflictingResult.code, 8);
  assert.match(conflictingResult.reason, /conflicts with durable authority primary/);
});

test('legacy reviewer account discovery must be unique, present, and match the state row', async () => {
  const unique = fixture({ authority: null, discoveredAuthority: ACCOUNTS.secondary });
  const uniqueResult = await reviewBudgetCommandCli([], unique.deps);
  assert.equal(uniqueResult.code, 0);
  assert.deepEqual(unique.authorityCalls.map(({ opts }) => opts.allowDiscovery), [false, true]);

  const ambiguous = fixture({ authority: null, discoveryError: new Error('session exists in multiple accounts without authority') });
  const ambiguousResult = await reviewBudgetCommandCli([], ambiguous.deps);
  assert.equal(ambiguousResult.code, 8);
  assert.match(ambiguousResult.reason, /exists in multiple accounts/);

  const missing = fixture({ authority: null, discoveredAuthority: null });
  const missingResult = await reviewBudgetCommandCli([], missing.deps);
  assert.equal(missingResult.code, 8);
  assert.match(missingResult.reason, /no durable or uniquely discovered account authority/);

  const mismatch = fixture({ authority: null, discoveredAuthority: ACCOUNTS.primary });
  const mismatchResult = await reviewBudgetCommandCli([], mismatch.deps);
  assert.equal(mismatchResult.code, 8);
  assert.match(mismatchResult.reason, /conflicts with discovered authority primary/);
});

test('selected reviewer without an account usage snapshot is unknown, never the primary compatibility view', async () => {
  const snapshot = usageView();
  delete snapshot.accounts.secondary;
  const f = fixture({ snapshot, authority: null });
  const result = await reviewBudgetCommandCli([], f.deps);
  assert.equal(result.accountId, 'secondary');
  assert.equal(result.code, 8);
  assert.match(result.reason, /no usage snapshot available/);
  assert.deepEqual(f.exits, [8]);
});

test('resolver follows scheduler selection when more than one reviewer marker is live', async () => {
  const sessions = [
    { id: 'older-reviewer', reviewer: true, accountId: 'primary', mtime: 1 },
    { id: 'reviewer-session', reviewer: true, accountId: 'secondary', mtime: 2 },
  ];
  let attempts;
  const f = fixture({ sessions, findReviewerSession: (rows, value) => { attempts = value; return rows[1]; }, authority: null });
  const target = await resolveReviewBudgetTarget({}, f.deps);
  assert.deepEqual(target, { model: 'haiku', accountId: 'secondary' });
  assert.deepEqual(attempts, { 'older-reviewer': 3 });
});
