'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const routing = require('./review-routing.js');

const HOUR = 3600e3;
const iso = (ms) => new Date(ms).toISOString();

function fixture(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-routing-'));
  if (config !== undefined) {
    fs.mkdirSync(path.join(root, 'watch'), { recursive: true });
    fs.writeFileSync(routing.configFile(root), JSON.stringify(config));
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const accounts = (...ids) => ({ list: () => ids.map((id) => ({ id, agent: 'codex' })) });

test('with no config every registered Codex account counts and there is no fallback', () => {
  const box = fixture();
  try {
    const settings = routing.config(box.root);
    assert.equal(settings.codex, null);
    assert.equal(settings.fallback, '');
    assert.deepEqual(routing.codexAccounts(box.root, { accounts: accounts('codex-main', 'codex-secondary') }),
      ['codex-main', 'codex-secondary']);
  } finally { box.cleanup(); }
});

test('a configured list is filtered to accounts that actually exist', () => {
  const box = fixture({ codex: ['codex-main', 'codex-typo'] });
  try {
    assert.deepEqual(routing.codexAccounts(box.root, { accounts: accounts('codex-main', 'codex-secondary') }), ['codex-main']);
  } finally { box.cleanup(); }
});

test('only a known reviewer may be configured as the fallback', () => {
  for (const [value, expected] of [['opus', 'opus'], ['claude', 'claude'], ['codex', ''], ['human', ''], ['gpt-9', ''], [42, '']]) {
    const box = fixture({ fallback: value });
    try { assert.equal(routing.config(box.root).fallback, expected, `fallback: ${value}`); }
    finally { box.cleanup(); }
  }
});

test('the exhaustion ledger expires by itself', () => {
  const box = fixture();
  const now = Date.now();
  try {
    routing.markExhausted('codex-main', iso(now + 2 * HOUR), { root: box.root, now, note: 'weekly limit', withLock: (fn) => fn() });
    routing.markExhausted('codex-secondary', iso(now - HOUR), { root: box.root, now: now - 3 * HOUR, withLock: (fn) => fn() });
    const live = routing.ledger(box.root, now);
    assert.deepEqual([...live.keys()], ['codex-main'], 'a window that has reset is not exhaustion');
    assert.equal(live.get('codex-main').note, 'weekly limit');
    assert.equal(routing.clearExhausted('codex-main', { root: box.root, now, withLock: (fn) => fn() }), true);
    assert.equal(routing.ledger(box.root, now).size, 0);
  } finally { box.cleanup(); }
});

test('routing prefers an available Codex account and names the exhausted ones', () => {
  const box = fixture({ fallback: 'opus' });
  const now = Date.now();
  try {
    routing.markExhausted('codex-main', iso(now + HOUR), { root: box.root, now, withLock: (fn) => fn() });
    const decision = routing.route({ root: box.root, now, accounts: accounts('codex-main', 'codex-secondary') });
    assert.equal(decision.reviewer, 'codex');
    assert.equal(decision.accountId, 'codex-secondary');
    assert.match(decision.why, /codex-secondary is available; codex-main exhausted/);
    assert.deepEqual(decision.exhausted.map((entry) => entry.accountId), ['codex-main']);
  } finally { box.cleanup(); }
});

test('a fallback is only taken when every Codex account is exhausted and one is configured', () => {
  const now = Date.now();
  const both = (root) => {
    routing.markExhausted('codex-main', iso(now + HOUR), { root, now, withLock: (fn) => fn() });
    routing.markExhausted('codex-secondary', iso(now + 2 * HOUR), { root, now, withLock: (fn) => fn() });
  };
  const configured = fixture({ fallback: 'opus' });
  try {
    both(configured.root);
    const decision = routing.route({ root: configured.root, now, accounts: accounts('codex-main', 'codex-secondary') });
    assert.equal(decision.reviewer, 'opus');
    assert.equal(decision.until, iso(now + HOUR), 'the earliest reset is what the card is waiting for');
    assert.match(decision.why, /the configured fallback is opus/);
  } finally { configured.cleanup(); }

  // Without a configured fallback the answer is "nothing to route to", which is the
  // sentence the session needs — not an improvised reviewer of its own choosing.
  const unconfigured = fixture();
  try {
    both(unconfigured.root);
    const decision = routing.route({ root: unconfigured.root, now, accounts: accounts('codex-main', 'codex-secondary') });
    assert.equal(decision.reviewer, '');
    assert.match(decision.why, /no fallback reviewer is configured/);
    assert.match(routing.describe(decision), /add \{"fallback": "opus"\} to watch\/review-routing\.json/);
  } finally { unconfigured.cleanup(); }
});

test('a Codex reply on the account after its limit was recorded lifts the mark', () => {
  const box = fixture({ fallback: 'opus' });
  const now = Date.now();
  try {
    const at = now - 2 * HOUR;
    routing.markExhausted('codex-main', iso(now + 48 * HOUR), { root: box.root, now: at, withLock: (fn) => fn() });
    routing.markExhausted('codex-secondary', iso(now + 48 * HOUR), { root: box.root, now: at, withLock: (fn) => fn() });
    const asked = [];
    // Only codex-secondary has answered since the limits were recorded.
    const answeredSince = (id, since) => { asked.push([id, since]); return id === 'codex-secondary' ? { at: now - HOUR } : null; };
    const decision = routing.route({ root: box.root, now, accounts: accounts('codex-main', 'codex-secondary'), answeredSince });
    assert.deepEqual(asked.map(([id, since]) => [id, since]), [['codex-main', at], ['codex-secondary', at]]);
    assert.equal(decision.reviewer, 'codex');
    assert.equal(decision.accountId, 'codex-secondary');
    assert.deepEqual(decision.exhausted.map((entry) => entry.accountId), ['codex-main']);
    assert.deepEqual(decision.lifted.map((entry) => [entry.accountId, entry.repliedAt]), [['codex-secondary', iso(now - HOUR)]]);
    assert.match(routing.describe(decision), /lifted: codex-secondary answered at /);
    // The fallback stamp describes only the limit still in force.
    assert.equal(routing.fallbackReason({ root: box.root, now, codexAccounts: ['codex-main', 'codex-secondary'], answeredSince }),
      `codex-main exhausted until ${iso(now + 48 * HOUR)} as recorded`);
    // A lookup that throws keeps the mark rather than guessing.
    const kept = routing.route({ root: box.root, now, accounts: accounts('codex-main', 'codex-secondary'), answeredSince: () => { throw new Error('io'); } });
    assert.equal(kept.reviewer, 'opus');
  } finally { box.cleanup(); }
});

test('an install with no Codex account says so rather than claiming a fallback', () => {
  const box = fixture({ fallback: 'opus' });
  try {
    const decision = routing.route({ root: box.root, now: Date.now(), accounts: accounts() });
    assert.equal(decision.reviewer, '');
    assert.match(decision.why, /no Codex account is registered/);
  } finally { box.cleanup(); }
});

test('the fallback reason describes the ledger, and only the accounts reviews are routed to', () => {
  const now = Date.now();
  const box = fixture({ fallback: 'opus' });
  const routed = { root: box.root, now, codexAccounts: ['codex-main', 'codex-secondary'] };
  const lock = { withLock: (fn) => fn() };
  try {
    assert.equal(routing.fallbackReason(routed), '', 'nothing exhausted, nothing to describe');
    routing.markExhausted('codex-main', iso(now + 2 * HOUR), { ...routed, ...lock });
    routing.markExhausted('codex-secondary', iso(now + HOUR), { ...routed, ...lock });
    assert.equal(routing.fallbackReason(routed), `codex-main, codex-secondary exhausted until ${iso(now + HOUR)} as recorded`,
      'the accounts are named, and the earliest reset is the one the card is waiting on');

    // One of two resetting before the review is recorded must not leave the record
    // claiming Codex as a whole is exhausted until the other one's window ends.
    routing.clearExhausted('codex-main', { ...routed, ...lock });
    assert.equal(routing.fallbackReason(routed), `codex-secondary exhausted until ${iso(now + HOUR)} as recorded`);
    routing.markExhausted('codex-main', iso(now + 2 * HOUR), { ...routed, ...lock });

    // An account this install does not route reviews to says nothing about a fallback.
    routing.clearExhausted('codex-main', { ...routed, ...lock });
    routing.clearExhausted('codex-secondary', { ...routed, ...lock });
    routing.markExhausted('codex-retired', iso(now + HOUR), { ...routed, ...lock });
    assert.equal(routing.fallbackReason(routed), '');
  } finally { box.cleanup(); }
});

// ---------- the CLI ----------

test('keep review-route records and clears an account, and refuses an unknown one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-routing-cli-'));
  // HOME too: the built-in Codex account reads ~/.codex, and a real reply there would lift the mark.
  const env = { ...process.env, KEEP_DIR: root, HOME: root, KEEP_NO_PUSH: '1', KEEP_NO_COMMIT: '1' };
  // An isolated registry: the real config's accounts would name the real home.
  delete env.KEEP_CONFIG;
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'review-route', ...args],
    { encoding: 'utf8', env, cwd: root });
  try {
    fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    const unknown = run('--exhausted', 'codex-nope', '--until', '+2h');
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /not a registered Codex account/);

    const plain = run('--json');
    assert.equal(plain.status, 0, plain.stderr);
    const decision = JSON.parse(plain.stdout);
    assert.equal(decision.reviewer, 'codex');
    assert.ok(decision.accountId, 'the built-in Codex account is what an unconfigured install routes to');

    const marked = run('--exhausted', decision.accountId, '--until', '+2h', '-m', 'usage limit until 02:00');
    assert.equal(marked.status, 0, marked.stderr);
    assert.match(marked.stdout, /exhausted until /);
    // Every account it knows is now exhausted, and nothing is configured to take over.
    assert.match(marked.stdout, /no fallback reviewer is configured/);

    const after = JSON.parse(run('--json').stdout);
    assert.equal(after.reviewer, '');
    assert.deepEqual(after.exhausted.map((entry) => entry.accountId), [decision.accountId]);
    assert.match(after.exhausted[0].note, /usage limit until 02:00/);

    const cleared = run('--clear', decision.accountId);
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.match(cleared.stdout, /no longer recorded as exhausted/);
    assert.equal(JSON.parse(run('--json').stdout).reviewer, 'codex');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- the record a fallback review leaves ----------

test('a fallback review record says it was one, and an ordinary one says nothing', () => {
  const reviews = require('./reviews.js');
  const gitDeps = {
    topLevel: () => '/repo',
    resolve: () => ['a'.repeat(40)],
    subject: () => 'a change',
    parents: () => ['b'.repeat(40)],
    patchId: () => 'p1',
  };
  const input = { commits: ['HEAD'], verdict: 'clean', by: 'opus subagent', evidence: 'x'.repeat(120) };

  const stamped = reviews.buildRecord(input, gitDeps, { route: 'fallback (codex exhausted until 2026-09-19T02:00:00.000Z)' });
  assert.equal(stamped.route, 'fallback (codex exhausted until 2026-09-19T02:00:00.000Z)');
  assert.match(reviews.logLine(stamped), /reviewer: fallback \(codex exhausted until /);

  const ordinary = reviews.buildRecord(input, gitDeps, { route: '' });
  assert.equal('route' in ordinary, false, 'an ordinary review carries no routing prose');
  assert.doesNotMatch(reviews.logLine(ordinary), /reviewer:/);
});

test('a fallback stamp is the session asserting it, not the ledger guessing at record time', () => {
  const box = fixture({ fallback: 'opus' });
  const now = Date.now();
  const reviews = require('./reviews.js');
  const gitDeps = {
    topLevel: () => '/repo', resolve: () => ['a'.repeat(40)], subject: () => 's',
    parents: () => ['b'.repeat(40)], patchId: () => 'p1',
  };
  const input = { commits: ['HEAD'], verdict: 'clean', by: 'opus subagent', evidence: 'x'.repeat(120) };
  try {
    // Inference read the wrong clock in both directions: a review that ran while Codex
    // was exhausted lost its stamp if recorded after the reset, and an ordinary review
    // picked one up if an account happened to be exhausted by the time it was written.
    const ordinary = reviews.buildRecord(input, gitDeps, { root: box.root });
    assert.equal('route' in ordinary, false, 'no claim, no stamp');

    const claimed = reviews.buildRecord({ ...input, fallback: true }, gitDeps, { root: box.root });
    assert.equal(claimed.route, 'fallback', 'the claim stands on its own with an empty ledger');

    const registered = routing.codexAccounts(box.root)[0];
    assert.ok(registered, 'the test registry has a built-in Codex account');
    routing.markExhausted(registered, iso(now + HOUR), { root: box.root, now, withLock: (fn) => fn() });
    const described = reviews.buildRecord({ ...input, fallback: true }, gitDeps, { root: box.root });
    assert.match(described.route, /^fallback \(.+ exhausted until .* as recorded\)$/);
    assert.ok(described.route.includes(registered), 'and the stamp names the account that was exhausted');
    assert.match(reviews.logLine(described), /reviewer: fallback \(.+ exhausted until /);
  } finally { box.cleanup(); }
});

test('an install that routes reviews nowhere describes no exhaustion', () => {
  const now = Date.now();
  const box = fixture({ fallback: 'opus' });
  try {
    routing.markExhausted('codex-retired', iso(now + HOUR), { root: box.root, now, withLock: (fn) => fn() });
    assert.equal(routing.fallbackReason({ root: box.root, now, codexAccounts: [] }), '',
      'a stale ledger must not have a fallback record cite accounts this install does not use');
  } finally { box.cleanup(); }
});
