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

test('with no --model each candidate is judged against its own default model', () => {
  const candidates = [account('claude/default'), account('claude-secondary')];
  // The live shape on 2026-09-17: the default account's generic buckets read as fine
  // while the model a session launched there would actually run on was at the wall.
  const view = snapshot({
    'claude/default': [short(0), week(80), { label: 'Fable wk', percent: 100, resetsAt: RESET }],
    'claude-secondary': [short(58), week(51), { label: 'Fable wk', percent: 61, resetsAt: RESET }],
  });
  const settings = { 'claude/default': 'claude-fable-5-1', 'claude-secondary': 'claude-fable-5-1' };
  const resolver = (entry) => settings[entry.id] || '';
  const choice = openAccount.chooseOpenAccount('claude', candidates, view, resolver, NOW);
  assert.equal(choice.account.id, 'claude-secondary');
  assert.deepEqual(choice.skipped.map((entry) => entry.reason), ['Fable wk 100%']);
  // The generic buckets alone still say the default is fine, which is the bug.
  assert.equal(openAccount.chooseOpenAccount('claude', candidates, view, '', NOW).account.id, 'claude/default');

  // Every spelling a settings.json may hold reaches the same `Fable wk` bucket.
  for (const model of ['claude-fable-5-1', 'fable', 'claude-fable-5-1[1m]']) {
    assert.equal(openAccount.accountBudget(view, candidates[0], model, NOW).reason, 'Fable wk 100%', model);
  }
  // A family with no scoped bucket in the reading falls back to the generic windows.
  assert.equal(openAccount.accountBudget(view, candidates[0], 'opus', NOW).code, 0);

  // Each candidate is asked separately, so two accounts on different defaults are
  // judged on different buckets.
  const mixed = (entry) => (entry.id === 'claude/default' ? 'opus' : 'claude-fable-5-1');
  assert.equal(openAccount.chooseOpenAccount('claude', candidates, view, mixed, NOW).account.id, 'claude/default');

  // An explicit account warns on the bucket its own default model would spend.
  assert.match(openAccount.exhaustedWarning(candidates[0], view, resolver, NOW),
    /^claude\/default is out of usage \(Fable wk 100%, resets /);
  // A resolver that throws, or answers with anything but a string, costs the scoped
  // bucket and never the launch.
  for (const hostile of [() => { throw new Error('no settings'); }, () => null, () => 7]) {
    assert.equal(openAccount.accountBudget(view, candidates[0], openAccount.modelForAccount(hostile, candidates[0]), NOW).code, 0);
    assert.equal(openAccount.chooseOpenAccount('claude', candidates, view, hostile, NOW).account.id, 'claude/default');
  }
});

test('a stale reading still proves exhaustion until the spent bucket resets', () => {
  const claude = account('claude/default');
  const stale = NOW - openAccount.USAGE_STALE_MS - 1;
  // Usage only rises until a reset, so an hours-old 100% with a live reset is the wall
  // now — the poller being rate-limited cannot have handed the account room back.
  const spent = openAccount.accountBudget(snapshot({ 'claude/default': [week(100), short(4)] }, stale), claude, '', NOW);
  assert.deepEqual({ code: spent.code, reason: spent.reason, low: spent.low, resetsAt: spent.resetsAt },
    { code: 6, reason: 'week 100%', low: false, resetsAt: RESET });
  // And the scoped bucket is reached the same way, so the account is skipped rather
  // than launched onto a model that cannot take a turn.
  const scoped = snapshot({ 'claude/default': [short(0), week(80), { label: 'Fable wk', percent: 100, resetsAt: RESET }] }, stale);
  assert.equal(openAccount.accountBudget(scoped, claude, 'claude-fable-5-1', NOW).reason, 'Fable wk 100%');
  assert.equal(openAccount.accountBudget(scoped, claude, '', NOW).code, 8, 'the generic buckets are merely stale');

  // A stale reading never proves room, however comfortable it looks.
  assert.equal(openAccount.accountBudget(snapshot({ 'claude/default': [week(20), short(10)] }, stale), claude, '', NOW).code, 8);
  // Nor does a bucket that is under the wall but past the headroom floor.
  assert.equal(openAccount.accountBudget(snapshot({ 'claude/default': [week(94), short(10)] }, stale), claude, '', NOW).code, 8);
  // A spent bucket whose reset has already passed describes a window that no longer
  // exists, and a reading this old cannot say what replaced it: unknown.
  const reopened = { accounts: { 'claude/default': { agent: 'claude',
    limits: [{ label: 'week', percent: 100, resetsAt: '2026-09-17T06:00:00.000Z' }, short(4)], fetchedAt: stale } } };
  assert.equal(openAccount.accountBudget(reopened, claude, '', NOW).code, 8);
  // A reset nobody can parse is no proof either.
  const unparseable = { accounts: { 'claude/default': { agent: 'claude',
    limits: [{ label: 'week', percent: 100 }, short(4)], fetchedAt: stale } } };
  assert.equal(openAccount.accountBudget(unparseable, claude, '', NOW).code, 8);

  // Codex readings get the same inference on their own horizon and epoch resets.
  const codex = account('codex/default', 'codex');
  const codexStale = { accounts: { 'codex/default': { agent: 'codex', asOf: NOW - openAccount.CODEX_STALE_MS - 1,
    windows: [{ label: 'week', percent: 100, resetsAt: Date.parse(RESET) }] } } };
  assert.equal(openAccount.accountBudget(codexStale, codex, '', NOW).code, 6);
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
  // would read a reading of unknown age as fresh. A reading of unknown age proves no
  // room — only a bucket already at the wall survives it, which the stale test covers.
  for (const fetchedAt of ['yesterday', {}, NaN, Infinity, 0]) {
    const stamped = { accounts: { 'claude/default': { agent: 'claude', limits: [week(94), short(10)], fetchedAt } } };
    assert.equal(openAccount.accountBudget(stamped, claude, '', NOW).code, 8, String(fetchedAt));
    const walled = { accounts: { 'claude/default': { agent: 'claude', limits: [week(100), short(10)], fetchedAt } } };
    assert.equal(openAccount.accountBudget(walled, claude, '', NOW).code, 6, String(fetchedAt));
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
  // A Claude account with the same age is stale, because its snapshot is polled. These
  // Codex windows carry no reset, so neither age proves exhaustion on its own; a stale
  // reading that does carry one is the stale-exhaustion test below.
  assert.equal(openAccount.accountBudget(snapshot({ 'claude/default': [week(20)] }, NOW - 40 * 60e3), account('claude/default'), '', NOW).code, 8);
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

test('a bucket whose reset has already passed is unknown, not exhausted', () => {
  const candidates = [account('codex/default', 'codex'), account('codex-secondary', 'codex')];
  const past = NOW - 3600e3;
  // Codex readings only advance when a Codex session takes a turn, so a spent window
  // can outlive its own reset in the snapshot. It must not refuse the account.
  const view = { accounts: {
    'codex/default': { agent: 'codex', asOf: NOW - 2 * 3600e3, windows: [{ label: 'week', percent: 20, resetsAt: RESET }, { label: '5h', percent: 100, resetsAt: past }] },
  } };
  const verdict = openAccount.accountBudget(view, candidates[0], '', NOW);
  assert.equal(verdict.code, 8);
  assert.match(verdict.reason, /predates a reset/);
  assert.equal(openAccount.chooseOpenAccount('codex', candidates, view, '', NOW).account.id, 'codex/default');
  // A window that is still open is still believed.
  const open = { accounts: {
    'codex/default': { agent: 'codex', asOf: NOW - 2 * 3600e3, windows: [{ label: 'week', percent: 20, resetsAt: RESET }, { label: '5h', percent: 100, resetsAt: NOW + 3600e3 }] },
  } };
  assert.equal(openAccount.accountBudget(open, candidates[0], '', NOW).code, 7);
});

test('reset metadata nobody can format costs the reset time, never the launch', () => {
  const hostile = { toString: null };
  assert.equal(openAccount.describeReset(hostile), '');
  const candidates = [account('claude/default'), account('claude-secondary')];
  const view = snapshot({
    'claude/default': [{ label: 'week', percent: 100, resetsAt: hostile }, short(10)],
    'claude-secondary': [week(20), short(10)],
  });
  const choice = openAccount.chooseOpenAccount('claude', candidates, view, '', NOW);
  assert.equal(choice.account.id, 'claude-secondary');
  assert.equal(openAccount.accountNote(choice), 'claude/default skipped: week 100%; opened on claude-secondary');
});
