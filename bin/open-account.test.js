'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const openAccount = require('./open-account.js');

const NOW = Date.parse('2026-09-17T12:00:00Z');
const RESET = '2026-09-21T12:00:00.000Z';

const account = (id, agent = 'claude') => ({ id, agent, label: id });
const week = (percent) => ({ label: 'week', percent, resetsAt: RESET });
const short = (percent) => ({ label: '5h', percent, resetsAt: RESET });

function snapshot(rows, fetchedAt = NOW) {
  const accounts = {};
  for (const [id, limits] of Object.entries(rows)) accounts[id] = { agent: 'claude', limits, fetchedAt };
  return { accounts };
}

test('candidate order is caller, default, the rest — and never another provider', () => {
  const accounts = [account('claude/default'), account('claude-secondary'), account('claude-third'), account('codex-alt', 'codex')];
  assert.deepEqual(
    openAccount.orderOpenCandidates('claude', { accounts, defaultAccountId: 'claude/default', callerAccountId: 'claude-secondary' })
      .map((entry) => entry.id),
    ['claude-secondary', 'claude/default', 'claude-third'],
  );
  // An id from the other provider means nothing here; the default still leads.
  assert.deepEqual(
    openAccount.orderOpenCandidates('claude', { accounts, defaultAccountId: 'claude/default', callerAccountId: 'codex-alt' })
      .map((entry) => entry.id),
    ['claude/default', 'claude-secondary', 'claude-third'],
  );
  assert.deepEqual(
    openAccount.orderOpenCandidates('codex', { accounts, defaultAccountId: 'codex-alt', callerAccountId: 'claude-secondary' })
      .map((entry) => entry.id),
    ['codex-alt'],
  );
  // The caller's account being the default must not list it twice.
  assert.deepEqual(
    openAccount.orderOpenCandidates('claude', { accounts, defaultAccountId: 'claude/default', callerAccountId: 'claude/default' })
      .map((entry) => entry.id),
    ['claude/default', 'claude-secondary', 'claude-third'],
  );
});

test('an exhausted candidate is skipped, and the note says which and why', () => {
  const candidates = [account('claude/default'), account('claude-secondary')];
  const view = snapshot({ 'claude/default': [week(100), short(4)], 'claude-secondary': [week(30), short(10)] });
  const choice = openAccount.chooseOpenAccount('claude', candidates, view, '', NOW);
  assert.equal(choice.account.id, 'claude-secondary');
  assert.deepEqual(choice.skipped.map((entry) => entry.id), ['claude/default']);
  assert.equal(choice.skipped[0].reason, 'week 100%');
  assert.match(openAccount.accountNote(choice), /^claude\/default skipped: week 100%, resets Sep 2[01] \d\d:\d\d; opened on claude-secondary$/);
  // A five-hour window that is nearly spent is code 7, and just as skippable.
  const shortWindow = snapshot({ 'claude/default': [week(20), short(95)], 'claude-secondary': [week(30), short(10)] });
  assert.equal(openAccount.chooseOpenAccount('claude', candidates, shortWindow, '', NOW).account.id, 'claude-secondary');
  // Nothing was passed over, so nothing is said.
  const clean = snapshot({ 'claude/default': [week(20), short(10)], 'claude-secondary': [week(30), short(10)] });
  const first = openAccount.chooseOpenAccount('claude', candidates, clean, '', NOW);
  assert.equal(first.account.id, 'claude/default');
  assert.equal(openAccount.accountNote(first), '');
});

test('a known-good account beats an unreadable one wherever it sits in the order', () => {
  const candidates = [account('claude-secondary'), account('claude/default')];
  // The caller's own account has no reading at all; the default has room.
  const view = snapshot({ 'claude/default': [week(20), short(10)] });
  const choice = openAccount.chooseOpenAccount('claude', candidates, view, '', NOW);
  assert.equal(choice.account.id, 'claude/default');
  assert.deepEqual(choice.skipped, []);
  // With no readable account anywhere, the order decides and the launch still happens:
  // an unknown snapshot must never stop a session from opening.
  const blind = openAccount.chooseOpenAccount('claude', candidates, { accounts: {} }, '', NOW);
  assert.equal(blind.account.id, 'claude-secondary');
  // A stale reading is unknown, not exhausted, even when the numbers look fine.
  const stale = snapshot({ 'claude-secondary': [week(20), short(10)] }, NOW - 31 * 60e3);
  assert.equal(openAccount.chooseOpenAccount('claude', candidates, stale, '', NOW).account.id, 'claude-secondary');
});

test('a named model is judged against its own weekly bucket, and no model against the generic ones', () => {
  const candidates = [account('claude/default'), account('claude-secondary')];
  const view = snapshot({
    'claude/default': [week(20), short(10), { label: 'fable wk', percent: 100, resetsAt: RESET }],
    'claude-secondary': [week(30), short(10), { label: 'fable wk', percent: 5, resetsAt: RESET }],
  });
  assert.equal(openAccount.chooseOpenAccount('claude', candidates, view, 'claude-fable-5-1', NOW).account.id, 'claude-secondary');
  // Without a model the per-model bucket is not this launch's ceiling, so the default
  // is still fine: nothing yet says which window it will spend against.
  assert.equal(openAccount.chooseOpenAccount('claude', candidates, view, '', NOW).account.id, 'claude/default');
});

test('every account exhausted refuses, names each one, and points at the override', () => {
  const candidates = [account('claude/default'), account('claude-secondary')];
  const view = snapshot({ 'claude/default': [week(100), short(4)], 'claude-secondary': [week(20), short(100)] });
  const choice = openAccount.chooseOpenAccount('claude', candidates, view, '', NOW);
  assert.equal(choice.account, null);
  assert.deepEqual(choice.skipped.map((entry) => entry.reason), ['week 100%', '5h 100%']);
  const message = openAccount.noAccountMessage('claude', choice.skipped);
  assert.match(message, /^no claude account has usage left: claude\/default \(week 100%, resets /);
  assert.match(message, /claude-secondary \(5h 100%, resets /);
  assert.match(message, /; pass --account <id> to launch anyway$/);
});

test('an explicit account is left alone, and only warns when it is actually spent', () => {
  const spentView = snapshot({ 'claude/default': [week(100), short(4)] });
  assert.match(openAccount.exhaustedWarning(account('claude/default'), spentView, '', NOW),
    /^claude\/default is out of usage \(week 100%, resets Sep 2[01] \d\d:\d\d\)$/);
  const roomyView = snapshot({ 'claude/default': [week(20), short(10)] });
  assert.equal(openAccount.exhaustedWarning(account('claude/default'), roomyView, '', NOW), '');
  // An account nobody has a reading for is unknown, not spent: no warning either.
  assert.equal(openAccount.exhaustedWarning(account('claude/default'), { accounts: {} }, '', NOW), '');
});

test('an unreadable bucket set is unknown rather than room', () => {
  const missingWeek = snapshot({ 'claude/default': [short(10)] });
  assert.equal(openAccount.accountBudget(missingWeek, account('claude/default'), '', NOW).code, 8);
  const badPercent = snapshot({ 'claude/default': [{ label: 'week', percent: 'n/a' }, short(10)] });
  assert.equal(openAccount.accountBudget(badPercent, account('claude/default'), '', NOW).code, 8);
});

test('malformed usage is unknown, never an exception and never room', () => {
  const claude = account('claude/default');
  // `Number(null)` is 0, which passes a bare percent check and then reaches for
  // `.label` on null. A bucket that is not an object is simply unreadable.
  for (const limits of [[null], [week(20), null], ['week 20%'], [[]], [{ percent: 20 }, undefined]]) {
    const verdict = openAccount.accountBudget(snapshot({ 'claude/default': limits }), claude, '', NOW);
    assert.equal(verdict.code, 8, JSON.stringify(limits));
  }
  // A truthy but unparseable fetchedAt makes `now - fetchedAt > stale` false, which
  // would read a reading of unknown age as fresh.
  for (const fetchedAt of ['yesterday', {}, NaN, Infinity, 0]) {
    const stamped = { accounts: { 'claude/default': { agent: 'claude', limits: [week(100), short(10)], fetchedAt } } };
    assert.equal(openAccount.accountBudget(stamped, claude, '', NOW).code, 8, String(fetchedAt));
  }
  // And nothing in the shape of a snapshot throws.
  for (const value of [null, {}, { accounts: null }, { accounts: { 'claude/default': 7 } }]) {
    assert.equal(openAccount.accountBudget(value, claude, '', NOW).code, 8);
  }
  assert.equal(openAccount.exhaustedWarning(claude, { accounts: { 'claude/default': { agent: 'claude', limits: [null], fetchedAt: NOW } } }, '', NOW), '');
});

test('the worst bucket decides, so a comfortable week cannot hide a spent five-hour window', () => {
  const claude = account('claude/default');
  // week 94% is merely low; 5h at the wall is not, and the account is out, not low.
  const hidden = openAccount.accountBudget(snapshot({ 'claude/default': [week(94), short(100)] }), claude, '', NOW);
  assert.deepEqual({ code: hidden.code, reason: hidden.reason, low: hidden.low }, { code: 7, reason: '5h 100%', low: false });
  // The reverse order reads the same: whichever bucket has least headroom is reported.
  const weekly = openAccount.accountBudget(snapshot({ 'claude/default': [week(100), short(94)] }), claude, '', NOW);
  assert.deepEqual({ code: weekly.code, reason: weekly.reason, low: weekly.low }, { code: 6, reason: 'week 100%', low: false });
  // Both merely low: still low, and still the worse of the two.
  const low = openAccount.accountBudget(snapshot({ 'claude/default': [week(92), short(97)] }), claude, '', NOW);
  assert.deepEqual({ code: low.code, reason: low.reason, low: low.low }, { code: 7, reason: '5h 97%', low: true });
  // A per-model bucket at the wall outranks a comfortable shared week too.
  const scoped = openAccount.accountBudget(snapshot({ 'claude/default': [week(20), short(10), { label: 'fable wk', percent: 100, resetsAt: RESET }] }),
    claude, 'claude-fable-5-1', NOW);
  assert.deepEqual({ code: scoped.code, reason: scoped.reason, low: scoped.low }, { code: 6, reason: 'fable wk 100%', low: false });

  // And the chooser must refuse rather than fall back when the only offence is a wall.
  const choice = openAccount.chooseOpenAccount('claude', [claude],
    snapshot({ 'claude/default': [week(94), short(100)] }), '', NOW);
  assert.equal(choice.account, null);
  assert.match(openAccount.noAccountMessage('claude', choice.skipped), /claude\/default \(5h 100%/);
});

test('a Codex account is judged on its own windows, not treated as unreadable', () => {
  const codex = account('codex/default', 'codex');
  const codexView = (windows, asOf = NOW) => ({ accounts: { 'codex/default': { agent: 'codex', windows, asOf, planType: 'pro' } } });
  // bin/usage.js codexWindow emits the same {label, percent, resetsAt} shape, with
  // `week`/`5h` labels and an epoch-millisecond reset.
  const spent = openAccount.accountBudget(codexView([
    { label: 'week', percent: 100, resetsAt: Date.parse(RESET) },
    { label: '5h', percent: 12, resetsAt: Date.parse(RESET) },
  ]), codex, '', NOW);
  assert.deepEqual({ code: spent.code, reason: spent.reason, low: spent.low }, { code: 6, reason: 'week 100%', low: false });
  assert.match(openAccount.exhaustedWarning(codex, codexView([
    { label: 'week', percent: 100, resetsAt: Date.parse(RESET) },
  ]), '', NOW), /^codex\/default is out of usage \(week 100%, resets /);

  const roomy = codexView([{ label: 'week', percent: 10, resetsAt: Date.parse(RESET) }, { label: '5h', percent: 5 }]);
  assert.equal(openAccount.accountBudget(roomy, codex, '', NOW).code, 0);
  assert.equal(openAccount.exhaustedWarning(codex, roomy, '', NOW), '');

  // An exhausted Codex default is skipped for a Codex account with room.
  const alt = account('codex-alt', 'codex');
  const both = { accounts: {
    'codex/default': { agent: 'codex', windows: [{ label: 'week', percent: 100, resetsAt: Date.parse(RESET) }], asOf: NOW },
    'codex-alt': { agent: 'codex', windows: [{ label: 'week', percent: 15 }], asOf: NOW },
  } };
  assert.equal(openAccount.chooseOpenAccount('codex', [codex, alt], both, '', NOW).account.id, 'codex-alt');

  // Codex's reading only advances when a Codex session takes a turn, so it gets a
  // longer horizon than the polled Claude one before it counts as unknown.
  assert.equal(openAccount.accountBudget(codexView([{ label: 'week', percent: 100 }], NOW - 40 * 60e3), codex, '', NOW).code, 6);
  assert.equal(openAccount.accountBudget(codexView([{ label: 'week', percent: 100 }], NOW - openAccount.CODEX_STALE_MS - 1), codex, '', NOW).code, 8);
  // A Claude account with the same age is stale, because its snapshot is polled.
  assert.equal(openAccount.accountBudget(snapshot({ 'claude/default': [week(100)] }, NOW - 40 * 60e3), account('claude/default'), '', NOW).code, 8);
  // Codex windows are never read as a Claude reading, or the other way round.
  assert.equal(openAccount.accountLimits(codexView([{ label: 'week', percent: 10 }]), account('claude/default')), null);
});

test('an account under the headroom floor is passed over but still beats refusing', () => {
  const candidates = [account('claude/default'), account('claude-secondary')];
  // One at the wall, one merely low: the low one launches, and only the wall is "skipped".
  const choice = openAccount.chooseOpenAccount('claude', candidates,
    snapshot({ 'claude/default': [week(100), short(10)], 'claude-secondary': [week(94), short(10)] }), null, NOW);
  assert.equal(choice.account.id, 'claude-secondary');
  assert.deepEqual(choice.skipped.map((entry) => entry.id), ['claude/default']);
  // A healthy account anywhere in the order still wins over a low one ahead of it.
  const better = openAccount.chooseOpenAccount('claude', candidates,
    snapshot({ 'claude/default': [week(94), short(10)], 'claude-secondary': [week(20), short(10)] }), null, NOW);
  assert.equal(better.account.id, 'claude-secondary');
  assert.match(openAccount.accountNote(better), /claude\/default skipped: week 94%/);
});
