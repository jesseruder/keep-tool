'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const budget = require('./account-budget');

const NOW = 1_800_000_000_000;
const HOUR = 3600e3;

function accountsApi(config = {}, ids = ['claude/default', 'claude-secondary', 'claude-tertiary']) {
  const records = ids.map((id) => ({ id, label: id, agent: id.startsWith('codex') ? 'codex' : 'claude',
    configDir: `/profiles/${id}`, builtIn: id === 'claude/default' }));
  return {
    ID_RE: /^[a-z0-9][a-z0-9_/-]*$/,
    rawConfig: () => ({ version: 1, ...config }),
    list: () => records.slice(),
    get: (id) => records.find((entry) => entry.id === id) || null,
    defaultFor: () => records.find((entry) => entry.id === 'claude/default'),
    automationFor: (agent, purpose) => records.find((entry) => entry.id === (config.automationAccounts || {})[purpose])
      || records.find((entry) => entry.id === 'claude/default'),
  };
}

function reading(limits, fetchedAt = NOW - 60e3) {
  return { identity: { agent: 'claude' }, snapshot: { limits, fetchedAt } };
}
function limits({ week = 10, fable, short = 5, weekReset = NOW + 48 * HOUR, fableReset = NOW + 24 * HOUR } = {}) {
  return [
    { label: '5h', percent: short, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
    { label: 'week', percent: week, resetsAt: new Date(weekReset).toISOString() },
    ...(fable == null ? [] : [{ label: 'Fable wk', percent: fable, resetsAt: new Date(fableReset).toISOString() }]),
  ];
}
function usage(map) {
  return { version: 2, accounts: Object.fromEntries(Object.entries(map).map(([id, value]) => [id, value])) };
}
const quiet = { recordHealth: false, now: NOW };

test('the pool is every Claude account but the interactive default, unless automationPool names it', () => {
  assert.deepEqual(budget.pool({}, accountsApi()).map((entry) => entry.id), ['claude-secondary', 'claude-tertiary']);
  assert.deepEqual(budget.pool({}, accountsApi({ automationPool: ['claude-tertiary', 'claude/default'] })).map((entry) => entry.id),
    ['claude-tertiary', 'claude/default']);
  assert.deepEqual(budget.pool({}, accountsApi({ automationPool: [] })), []);
  assert.throws(() => budget.pool({}, accountsApi({ automationPool: 'claude-secondary' })), /array/);
  assert.throws(() => budget.pool({}, accountsApi({ automationPool: ['nope'] })), /unknown account/);
  assert.throws(() => budget.pool({}, accountsApi({ automationPool: ['codex-work'] }, ['claude/default', 'codex-work'])), /not a Claude account/);
  assert.throws(() => budget.pool({}, accountsApi({ automationPool: ['claude-secondary', 'claude-secondary'] })), /twice/);
});

test('ranking: most weekly headroom first, ties by the model bucket then 5h, unknown after known, spent last', () => {
  const rows = budget.rank(['a', 'b', 'c', 'd', 'e'], usage({
    a: reading(limits({ week: 60 })),
    b: reading(limits({ week: 20, short: 50 })),
    c: reading(limits({ week: 20, short: 10 })),
    d: reading(limits({ week: 100 })),
    // e has no reading at all
  }), { model: 'opus', now: NOW });
  assert.deepEqual(rows.map((row) => row.id), ['c', 'b', 'a', 'e', 'd']);
  assert.equal(rows.find((row) => row.id === 'e').unknown, true);
  assert.equal(rows.find((row) => row.id === 'e').exhausted, false, 'unknown is never exhausted');
  assert.equal(rows.find((row) => row.id === 'd').exhausted, true);
});

test('a model-scoped weekly bucket exhausts only the model it belongs to', () => {
  const value = usage({ a: reading(limits({ week: 40, fable: 100 })), b: reading(limits({ week: 70, fable: 20 })) });
  const fable = budget.rank(['a', 'b'], value, { model: 'fable', now: NOW });
  assert.deepEqual(fable.map((row) => [row.id, row.exhausted]), [['b', false], ['a', true]]);
  // Opus has no bucket of its own: only the shared week caps it.
  const opus = budget.rank(['a', 'b'], value, { model: 'claude-opus-5', now: NOW });
  assert.deepEqual(opus.map((row) => [row.id, row.exhausted]), [['a', false], ['b', false]]);
  // With no model named, no model bucket applies: only the week and the 5h window.
  assert.equal(budget.rank(['a'], value, { now: NOW })[0].exhausted, false);
});

test('a spent 5h window exhausts an account until the 5h reset', () => {
  const shortReset = NOW + 2 * HOUR;
  const value = usage({
    a: reading(limits({ week: 10, short: 100 })),
    b: reading(limits({ week: 20, short: 100 })),
  });
  const rows = budget.rank(['a', 'b'], value, { model: 'opus', now: NOW });
  assert.deepEqual(rows.map((row) => [row.id, row.exhausted]), [['a', true], ['b', true]]);
  assert.equal(rows[0].resetsAt, shortReset);
  const choice = budget.select({ ...quiet, accountApi: accountsApi(), model: 'opus', usage: usage({
    'claude-secondary': reading(limits({ week: 10, short: 100 })),
    'claude-tertiary': reading(limits({ week: 20, short: 100 })),
  }) });
  assert.equal(choice.deferred, true);
  assert.equal(choice.retryAt, shortReset, 'a 5h deferral retries at the 5h reset, which is soon');
});

test('a stale reading is unknown when it shows room, but still spent when it shows a window at 100%', () => {
  const rows = budget.rank(['old', 'fresh', 'oldroom'], usage({
    old: reading(limits({ week: 100 }), NOW - 31 * 60e3),
    fresh: reading(limits({ week: 90 })),
    oldroom: reading(limits({ week: 10 }), NOW - 31 * 60e3),
  }), { model: 'opus', now: NOW });
  assert.deepEqual(rows.map((row) => [row.id, row.unknown, row.exhausted]),
    [['fresh', false, false], ['oldroom', true, false], ['old', false, true]]);
  // A 100% window whose reset has passed is not evidence any more.
  const past = budget.rank(['x'], usage({ x: reading(limits({ week: 100, weekReset: NOW - HOUR }), NOW - 5 * HOUR) }), { now: NOW });
  assert.deepEqual([past[0].exhausted, past[0].unknown], [false, true]);
  // No reset time at all: spent.
  assert.equal(budget.rank(['x'], usage({ x: reading([{ label: 'week', percent: 100 }], NOW - 9 * HOUR) }), { now: NOW })[0].exhausted, true);
  // An entry with no agent field and no `week` still reads as spent when a limit shows 100.
  const bare = { accounts: { x: { limits: [{ label: '5h', percent: 100 }] } } };
  assert.equal(budget.rank(['x'], bare, { now: NOW })[0].exhausted, true);
});

test('the preferred account needs the governor\'s headroom to win, and a reading to beat a known-good account', () => {
  const api = accountsApi({ automationAccounts: { reviewer: 'claude-tertiary' } });
  const pick = (value) => budget.select({ ...quiet, purpose: 'reviewer', model: 'fable', accountApi: api, usage: value }).account;
  // 95% week: short of the 10% bar, so the emptier account wins.
  assert.equal(pick(usage({ 'claude-secondary': reading(limits({ week: 50, fable: 10 })),
    'claude-tertiary': reading(limits({ week: 95, fable: 10 })) })), 'claude-secondary');
  // The same on the model's own bucket, and on the 5h window: it is then ranked like
  // everyone else, here behind an account with a lower week.
  assert.equal(pick(usage({ 'claude-secondary': reading(limits({ week: 10, fable: 10 })),
    'claude-tertiary': reading(limits({ week: 20, fable: 91 })) })), 'claude-secondary');
  assert.equal(pick(usage({ 'claude-secondary': reading(limits({ week: 10, fable: 10 })),
    'claude-tertiary': reading(limits({ week: 20, fable: 10, short: 95 })) })), 'claude-secondary');
  // At the bar exactly it wins, over an emptier account.
  assert.equal(pick(usage({ 'claude-secondary': reading(limits({ week: 5, fable: 5 })),
    'claude-tertiary': reading(limits({ week: 90, fable: 10 })) })), 'claude-tertiary');
  // No reading for the preferred account: the known-good account wins.
  assert.equal(pick(usage({ 'claude-secondary': reading(limits({ week: 50, fable: 10 })) })), 'claude-secondary');
});

test('the preferred account wins while it has room and is skipped once spent', () => {
  const api = accountsApi({ automationAccounts: { reviewer: 'claude-tertiary' } });
  const roomy = usage({ 'claude-secondary': reading(limits({ week: 5 })), 'claude-tertiary': reading(limits({ week: 80 })) });
  assert.equal(budget.select({ ...quiet, purpose: 'reviewer', model: 'opus', accountApi: api, usage: roomy }).account, 'claude-tertiary');
  const spent = usage({ 'claude-secondary': reading(limits({ week: 5 })), 'claude-tertiary': reading(limits({ week: 100 })) });
  const choice = budget.select({ ...quiet, purpose: 'reviewer', model: 'opus', accountApi: api, usage: spent });
  assert.equal(choice.account, 'claude-secondary');
  assert.equal(choice.record.id, 'claude-secondary');
  // An explicit preference beats the configured one.
  assert.equal(budget.select({ ...quiet, purpose: 'reviewer', preferredId: 'claude-secondary', model: 'opus', accountApi: api, usage: roomy }).account,
    'claude-secondary');
});

test('the interactive default is never chosen, even with the most room', () => {
  const api = accountsApi({ automationAccounts: { slack: 'claude/default' } });
  const value = usage({ 'claude/default': reading(limits({ week: 0 })), 'claude-secondary': reading(limits({ week: 70 })),
    'claude-tertiary': reading(limits({ week: 100 })) });
  assert.equal(budget.select({ ...quiet, purpose: 'slack', accountApi: api, usage: value, model: 'haiku' }).account, 'claude-secondary');
});

test('exclude drops the handoff source from the candidates', () => {
  const value = usage({ 'claude-secondary': reading(limits({ week: 5 })), 'claude-tertiary': reading(limits({ week: 50 })) });
  assert.equal(budget.select({ ...quiet, purpose: 'handoff', accountApi: accountsApi(), usage: value, exclude: ['claude-secondary'] }).account,
    'claude-tertiary');
  const none = budget.select({ ...quiet, purpose: 'handoff', accountApi: accountsApi({ automationPool: ['claude-secondary'] }),
    usage: value, exclude: ['claude-secondary'] });
  assert.equal(none.deferred, true);
});

test('a spent pool defers until the earliest reset, and names every account\'s window', () => {
  const value = usage({
    'claude-secondary': reading(limits({ week: 100, weekReset: NOW + 30 * HOUR })),
    'claude-tertiary': reading(limits({ week: 50, fable: 100, fableReset: NOW + 5 * HOUR })),
  });
  const choice = budget.select({ ...quiet, purpose: 'reviewer', model: 'fable', accountApi: accountsApi(), usage: value });
  assert.equal(choice.account, null);
  assert.equal(choice.deferred, true);
  assert.equal(choice.retryAt, NOW + 5 * HOUR);
  assert.match(choice.reason, /claude-secondary week 100%/);
  assert.match(choice.reason, /claude-tertiary week 50%, Fable wk 100%/);
  assert.throws(() => budget.selectOrThrow({ ...quiet, purpose: 'reviewer', model: 'fable', accountApi: accountsApi(), usage: value }),
    (error) => error.code === 'ACCOUNT_DEFERRED' && error.retryAt === NOW + 5 * HOUR);
  // No reset known anywhere: try again in half an hour.
  const unknownReset = usage({ 'claude-secondary': reading([{ label: 'week', percent: 100 }]),
    'claude-tertiary': reading([{ label: 'week', percent: 100 }]) });
  assert.equal(budget.select({ ...quiet, accountApi: accountsApi(), usage: unknownReset }).retryAt, NOW + budget.DEFER_FALLBACK_MS);
});

test('with no pool the fixed assignment stands, exactly as before', () => {
  const single = accountsApi({}, ['claude/default']);
  assert.equal(budget.select({ ...quiet, purpose: 'summarize', accountApi: single, usage: null }).account, 'claude/default');
  assert.equal(budget.select({ ...quiet, purpose: 'x', preferredId: 'claude-secondary', accountApi: single, usage: null }).account,
    'claude-secondary');
  const off = accountsApi({ automationPool: [], automationAccounts: { slack: 'claude-tertiary' } });
  assert.equal(budget.select({ ...quiet, purpose: 'slack', accountApi: off, usage: null }).account, 'claude-tertiary');
  assert.equal(budget.select({ ...quiet, purpose: 'handoff', accountApi: off, usage: null, fallback: false }).account, null);
  // An injected accounts API with only automationFor has no pool either.
  const bare = { automationFor: () => ({ id: 'background', agent: 'claude' }) };
  assert.equal(budget.select({ ...quiet, purpose: 'slack', accountApi: bare }).account, 'background');
});

test('a deferral writes one account-budget health row, and a later selection clears it', () => {
  budget.resetHealthMemory();
  const records = [];
  const health = { record: (name, options) => records.push({ name, options }) };
  const spent = usage({ 'claude-secondary': reading(limits({ week: 100 })), 'claude-tertiary': reading(limits({ week: 100 })) });
  const fine = usage({ 'claude-secondary': reading(limits({ week: 10 })) });
  const base = { now: NOW, accountApi: accountsApi(), health };
  budget.select({ ...base, purpose: 'summarize', usage: spent });
  budget.select({ ...base, purpose: 'summarize', usage: spent });
  assert.equal(records.length, 1, 'an unchanged deferral is not rewritten');
  assert.equal(records[0].name, 'account-budget');
  assert.equal(records[0].options.ok, false);
  assert.match(records[0].options.error, /^automation pool exhausted until .*summarize/);
  budget.select({ ...base, purpose: 'summarize', usage: fine });
  assert.equal(records.length, 2);
  assert.equal(records[1].options.ok, true);
  budget.select({ ...base, purpose: 'summarize', usage: fine });
  assert.equal(records.length, 2, 'a healthy row is not rewritten either');
  budget.resetHealthMemory();
});

test('health: the first success in a process writes ok, one success clears every purpose, and expired deferrals drop out', () => {
  budget.resetHealthMemory();
  const records = [];
  const health = { record: (name, options) => records.push({ name, options }) };
  const spent = usage({
    'claude-secondary': reading(limits({ week: 100, weekReset: NOW + 3 * HOUR })),
    'claude-tertiary': reading(limits({ week: 100, weekReset: NOW + 4 * HOUR })),
  });
  const fine = usage({ 'claude-secondary': reading(limits({ week: 10 })) });
  const base = { accountApi: accountsApi(), health };

  // (a) A fresh process's first success writes ok, clearing whatever red row the CLI
  // or a previous daemon left behind.
  budget.select({ ...base, now: NOW, purpose: 'summarize', usage: fine });
  assert.deepEqual(records.map((row) => row.options.ok), [true]);

  // (b) Two purposes deferred; a success for a third clears both.
  budget.select({ ...base, now: NOW, purpose: 'summarize', usage: spent });
  budget.select({ ...base, now: NOW, purpose: 'reviewer', usage: spent });
  assert.match(records.at(-1).options.error, /summarize .*reviewer|reviewer .*summarize/);
  budget.select({ ...base, now: NOW, purpose: 'slack', usage: fine });
  assert.equal(records.at(-1).options.ok, true);
  budget.select({ ...base, now: NOW, purpose: 'ideas', usage: spent });
  assert.doesNotMatch(records.at(-1).options.error, /summarize|reviewer/, 'nothing remembered past the success');

  // (c) A deferral whose retryAt has passed is not reported any more.
  const later = usage({
    'claude-secondary': reading(limits({ week: 100, weekReset: NOW + 10 * HOUR }), NOW + 5 * HOUR),
    'claude-tertiary': reading(limits({ week: 100, weekReset: NOW + 11 * HOUR }), NOW + 5 * HOUR),
  });
  budget.select({ ...base, now: NOW + 5 * HOUR, purpose: 'landed', usage: later });
  assert.doesNotMatch(records.at(-1).options.error, /ideas/);
  assert.match(records.at(-1).options.error, /landed/);

  // (d) Excluding the only pool member is nowhere to move, not an exhausted pool.
  const count = records.length;
  const none = budget.select({ ...base, now: NOW, purpose: 'handoff', accountApi: accountsApi({ automationPool: ['claude-secondary'] }),
    usage: fine, exclude: ['claude-secondary'] });
  assert.equal(none.deferred, true);
  assert.equal(records.length, count, 'no health row for it');
  budget.resetHealthMemory();
});

test('a malformed automationPool is reported once and falls back to the fixed assignment', () => {
  budget.resetHealthMemory();
  const lines = [];
  const stderr = { write: (line) => lines.push(line) };
  const api = accountsApi({ automationPool: ['claude-secondary', 'nope'], automationAccounts: { slack: 'claude-tertiary' } });
  const first = budget.select({ ...quiet, purpose: 'slack', accountApi: api, usage: null, stderr });
  const second = budget.select({ ...quiet, purpose: 'summarize', accountApi: api, usage: null, stderr });
  assert.equal(first.account, 'claude-tertiary');
  assert.equal(second.account, 'claude/default', 'no preference: automationFor, as before the pool existed');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^keep accounts: automationPool ignored: automationPool names an unknown account nope/);
  budget.resetHealthMemory();
});
