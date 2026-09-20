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
    routing.markExhausted('codex-main', iso(now + 2 * HOUR), { root: box.root, now, note: 'weekly limit' });
    routing.markExhausted('codex-secondary', iso(now - HOUR), { root: box.root, now: now - 3 * HOUR });
    const live = routing.ledger(box.root, now);
    assert.deepEqual([...live.keys()], ['codex-main'], 'a window that has reset is not exhaustion');
    assert.equal(live.get('codex-main').note, 'weekly limit');
    assert.equal(routing.clearExhausted('codex-main', { root: box.root, now }), true);
    assert.equal(routing.ledger(box.root, now).size, 0);
  } finally { box.cleanup(); }
});

test('routing prefers an available Codex account and names the exhausted ones', () => {
  const box = fixture({ fallback: 'opus' });
  const now = Date.now();
  try {
    routing.markExhausted('codex-main', iso(now + HOUR), { root: box.root, now });
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
    routing.markExhausted('codex-main', iso(now + HOUR), { root, now });
    routing.markExhausted('codex-secondary', iso(now + 2 * HOUR), { root, now });
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

test('an install with no Codex account says so rather than claiming a fallback', () => {
  const box = fixture({ fallback: 'opus' });
  try {
    const decision = routing.route({ root: box.root, now: Date.now(), accounts: accounts() });
    assert.equal(decision.reviewer, '');
    assert.match(decision.why, /no Codex account is registered/);
  } finally { box.cleanup(); }
});

test('provenance stamps a fallback review and nothing else', () => {
  const now = Date.now();
  const box = fixture({ fallback: 'opus' });
  try {
    const available = { root: box.root, now, accounts: accounts('codex-main') };
    assert.equal(routing.provenance('opus subagent', available), '', 'Codex was available; this reviewer was a choice');

    routing.markExhausted('codex-main', iso(now + HOUR), { root: box.root, now });
    assert.equal(routing.provenance('opus subagent', available), `fallback (codex exhausted until ${iso(now + HOUR)})`);
    assert.equal(routing.provenance('codex sol', available), '', 'a Codex review is never the fallback');
    assert.equal(routing.provenance('claude', available), '', 'only the configured fallback is stamped as one');
  } finally { box.cleanup(); }
});

// ---------- the CLI ----------

test('keep review-route records and clears an account, and refuses an unknown one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-routing-cli-'));
  const env = { ...process.env, KEEP_DIR: root, KEEP_NO_PUSH: '1', KEEP_NO_COMMIT: '1' };
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'keep.js'), 'review-route', ...args],
    { encoding: 'utf8', env, cwd: root });
  try {
    fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
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

test('the route stamp is looked up from the ledger when the caller does not pass one', () => {
  const box = fixture({ fallback: 'opus' });
  const now = Date.now();
  try {
    const accountId = routing.codexAccounts(box.root)[0];
    assert.ok(accountId, 'the test registry has a built-in Codex account');
    routing.markExhausted(accountId, iso(now + HOUR), { root: box.root, now });
    const reviews = require('./reviews.js');
    const gitDeps = {
      topLevel: () => '/repo', resolve: () => ['a'.repeat(40)], subject: () => 's',
      parents: () => ['b'.repeat(40)], patchId: () => 'p1',
    };
    const record = reviews.buildRecord(
      { commits: ['HEAD'], verdict: 'clean', by: 'opus subagent', evidence: 'x'.repeat(120) },
      gitDeps, { root: box.root },
    );
    assert.match(record.route, /^fallback \(codex exhausted until /);
  } finally { box.cleanup(); }
});
