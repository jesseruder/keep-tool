'use strict';

// Tests spawned from a reviewer session must not inherit reviewer identity.
for (const key of ['KEEP_REVIEWER', 'KEEP_REVIEWER_NAME', 'KEEP_REVIEWER_MODEL']) delete process.env[key];

const assert = require('node:assert/strict');
const test = require('node:test');
const allow = require('./allow.js');

function card(fm = {}) {
  return { id: 'c1', fm: { title: 'c1', status: 'active', ...fm }, body: '' };
}

const NOW = Date.parse('2026-09-07T12:00:00');

test('parseToken splits action and scope', () => {
  assert.deepEqual(allow.parseToken('push'), { action: 'push', scope: '', token: 'push' });
  assert.deepEqual(allow.parseToken('deploy:staging'), { action: 'deploy', scope: 'staging', token: 'deploy:staging' });
  assert.equal(allow.parseToken('DEPLOY:Prod').action, 'deploy');
  assert.equal(allow.parseToken('deploy:a/b-c.d_e').scope, 'a/b-c.d_e');
});

test('parseToken rejects malformed actions', () => {
  assert.throws(() => allow.parseToken(''), /cannot be empty/);
  assert.throws(() => allow.parseToken('9push'), /not a valid action/);
  assert.throws(() => allow.parseToken('push me'), /not a valid action/);
  assert.throws(() => allow.parseToken('deploy:'), /colon but no scope/);
  assert.throws(() => allow.parseToken('deploy:a b'), /scope/);
});

test('a spend grant needs a numeric ceiling; a spend request does not', () => {
  assert.throws(() => allow.parseToken('spend', 'grant'), /needs a ceiling/);
  assert.throws(() => allow.parseToken('spend:lots', 'grant'), /number of dollars/);
  assert.equal(allow.parseToken('spend', 'action').action, 'spend');
  assert.equal(allow.parseToken('spend:25', 'grant').scope, '25');
});

test('parseGrants dedupes, splits commas, and lets a bare grant subsume scoped ones', () => {
  const grants = allow.parseGrants(['push,deploy:staging', 'deploy:prod', 'deploy', 'push']);
  assert.deepEqual(grants.map(allow.formatToken), ['deploy', 'push']);
});

test('a second spend ceiling replaces the first', () => {
  assert.deepEqual(allow.parseGrants(['spend:10', 'spend:40']).map(allow.formatToken), ['spend:40']);
});

test('readGrants skips a hand-edited entry instead of throwing', () => {
  const grants = allow.readGrants(card({ allow: ['push', 'not a token', 'review'] }));
  assert.deepEqual(grants.map(allow.formatToken), ['push', 'review']);
});

test('decide refuses when the card grants nothing', () => {
  const verdict = allow.decide(card(), 'push', { now: NOW });
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /no grants on c1/);
});

test('a bare grant covers every scope; a scoped grant covers only its own', () => {
  const bare = card({ allow: ['deploy'] });
  assert.equal(allow.decide(bare, 'deploy:prod', { now: NOW }).ok, true);
  assert.equal(allow.decide(bare, 'deploy', { now: NOW }).ok, true);

  const scoped = card({ allow: ['deploy:staging'] });
  assert.equal(allow.decide(scoped, 'deploy:staging', { now: NOW }).ok, true);
  assert.equal(allow.decide(scoped, 'deploy:prod', { now: NOW }).ok, false);
});

test('an unscoped request against a scoped-only grant is refused and says so', () => {
  const verdict = allow.decide(card({ allow: ['deploy:staging'] }), 'deploy', { now: NOW });
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /ask for the scope you mean/);
});

test('scope comparison is case-insensitive', () => {
  assert.equal(allow.decide(card({ allow: ['deploy:Prod'] }), 'deploy:prod', { now: NOW }).ok, true);
});

test('allow_until expires every grant on the card', () => {
  const stale = card({ allow: ['push'], allow_until: '2026-09-06T09:00' });
  const verdict = allow.decide(stale, 'push', { now: NOW });
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /expired at 2026-09-06T09:00/);

  const live = card({ allow: ['push'], allow_until: '2026-09-08T09:00' });
  assert.equal(allow.decide(live, 'push', { now: NOW }).ok, true);
});

test('a date-only allow_until lasts to the end of that day', () => {
  const task = card({ allow: ['push'], allow_until: '2026-09-07' });
  assert.equal(allow.decide(task, 'push', { now: NOW }).ok, true);
  assert.equal(allow.decide(task, 'push', { now: Date.parse('2026-09-08T00:30:00') }).ok, false);
});

test('spend compares against the ceiling', () => {
  const task = card({ allow: ['spend:25'] });
  assert.equal(allow.decide(task, 'spend', { amount: '25', now: NOW }).ok, true);
  assert.equal(allow.decide(task, 'spend', { amount: '25.01', now: NOW }).ok, false);
  assert.equal(allow.decide(task, 'spend:12', { now: NOW }).ok, true);
  assert.equal(allow.decide(task, 'spend', { now: NOW }).ok, false);
  assert.throws(() => allow.decide(task, 'spend', { amount: 'a lot', now: NOW }), /number of dollars/);
});

test('spend without a ceiling on the card is refused', () => {
  const verdict = allow.decide(card({ allow: ['push'] }), 'spend', { amount: '1', now: NOW });
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /grants no spending/);
});

// ---------- prose intents ----------

test('intents recognise the asks that showed up in a week of transcripts', () => {
  assert.deepEqual(allow.intents('Say the word and I will push it.'), ['push']);
  assert.deepEqual(allow.intents('Ready to deploy to production — want me to?'), ['deploy:prod']);
  assert.deepEqual(allow.intents('Shall I run a codex review first?'), ['review']);
  assert.deepEqual(allow.intents('Want me to land it?'), ['land']);
  assert.deepEqual(allow.intents('Should I npm publish the CLI?'), ['publish']);
});

test('a specific deploy scope suppresses the bare deploy intent', () => {
  assert.deepEqual(allow.intents('want me to deploy it to staging now?'), ['deploy:staging']);
});

test('intents only read the tail, so an old mention does not count', () => {
  const text = 'I deployed it to production this morning. ' + 'x'.repeat(900) + ' What colour should the button be?';
  assert.deepEqual(allow.intents(text), []);
});

test('prose with no actionable ask yields no intents', () => {
  assert.deepEqual(allow.intents('Which of these two schemas do you prefer?'), []);
  assert.deepEqual(allow.intents('The tests pass and the tree is clean.'), []);
});

test('coversStop is true only when every intent in the ask is granted', () => {
  const task = card({ allow: ['push', 'review'] });
  assert.equal(allow.coversStop(task, 'Tests pass. Want me to push it?').covered, true);

  const compound = allow.coversStop(task, 'Want me to push it and then deploy it to production?');
  assert.equal(compound.covered, false);
  assert.deepEqual(compound.missing, ['deploy:prod']);
  assert.deepEqual(compound.granted, ['push']);
});

test('coversStop is false when nothing actionable was asked', () => {
  const verdict = allow.coversStop(card({ allow: ['push'] }), 'Which option do you want?');
  assert.equal(verdict.covered, false);
  assert.deepEqual(verdict.wanted, []);
});

// ---------- narration and value questions are not permission requests ----------
//
// Every string below is taken from a real handback in the 2026-08-31..09-06
// transcripts. Replaying the raw INTENT table over that week fired on 106 of
// 1,260 handbacks; scoping it to the ask itself brought that to 27, and these
// are the cases that moved.

test('an action the agent is narrating is not an ask', () => {
  const task = card({ allow: ['restart', 'install', 'push', 'land'] });
  const narrations = [
    "Once Codex B lands I'll restart the server, verify the scope toggle and both summaries render, commit, and refresh the design doc. Does the dashboard auto reload?",
    "When it lands I'll re-sign and install it on the Pixel 9a via extract_circle_build.sh and report the installed versionCode. What else should I check?",
  ];
  for (const text of narrations) {
    const verdict = allow.coversStop(task, text);
    assert.deepEqual(verdict.wanted, [], text.slice(0, 40));
    assert.equal(verdict.covered, false);
  }
});

test('an offer conditional on a value Owner has not given is not an ask', () => {
  const task = card({ allow: ['land', 'push'] });
  // The open question is the ratio. An agent told to proceed would invent one.
  const verdict = allow.coversStop(task,
    "If you say 1.25x, the change is one ratio in ghost and a doc note. Say the number and I'll land it.");
  assert.deepEqual(verdict.wanted, []);
  assert.equal(verdict.covered, false);
});

test('a genuine approval ask still authorizes', () => {
  const task = card({ allow: ['review'] });
  const asks = [
    'This added ~380 lines of new code. Want a Codex review of the Phase 2 commit before we call it done?',
    'Want me to run a Codex review of the keep repo before we call Phase 1 done?',
  ];
  for (const text of asks) {
    assert.equal(allow.coversStop(task, text).covered, true, text.slice(0, 40));
  }
});

test('a wh-question mentioning an action does not authorize it', () => {
  const task = card({ allow: ['deploy', 'push'] });
  const verdict = allow.coversStop(task, 'Which environment should I deploy it to first?');
  assert.deepEqual(verdict.wanted, []);
});

test('an extra detected action makes authorization harder, never easier', () => {
  // Detection erring wide is safe by construction: every detected action must be
  // granted, so a spurious one sends the turn to Owner rather than past him.
  const verdict = allow.coversStop(card({ allow: ['review'] }),
    'Worth running a codex review over these two commits before we restart the daemon?');
  assert.equal(verdict.covered, false);
  assert.ok(verdict.missing.includes('restart'));
});

test('askSpan takes the question, not the paragraph around it', () => {
  assert.deepEqual(
    allow.askSpan('I pushed nothing yet. The tests pass. Want a Codex review?'),
    ['Want a Codex review?'],
  );
  assert.deepEqual(allow.askSpan('Everything is committed and the tree is clean.'), []);
});

// ---------- Codex review 2026-09-07 ----------

test('a scoped deploy grant does not authorize a separate unscoped deploy', () => {
  // The bare `deploy` mention was dropped whenever any scoped one matched, so a
  // card granting deploy:prod alone authorized the QA deploy too.
  assert.deepEqual(
    allow.intents('Should I deploy to prod and then deploy this build to QA?'),
    ['deploy:prod', 'deploy'],
  );
  const verdict = allow.coversStop(card({ allow: ['deploy:prod'] }),
    'Should I deploy to prod and then deploy this build to QA?');
  assert.equal(verdict.covered, false);
  assert.deepEqual(verdict.missing, ['deploy']);
});

test('a scoped deploy still suppresses the bare match it overlaps', () => {
  assert.deepEqual(allow.intents('want me to deploy it to staging now?'), ['deploy:staging']);
  assert.equal(allow.coversStop(card({ allow: ['deploy:staging'] }), 'Want me to deploy it to staging now?').covered, true);
});

test('an unreadable allow_until denies rather than granting forever', () => {
  const task = card({ allow: ['push'], allow_until: 'whenever' });
  assert.deepEqual(allow.expiryState(task, NOW), { state: 'invalid', until: 'whenever' });
  const verdict = allow.decide(task, 'push', { now: NOW });
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /not a date Keep can read/);
  assert.equal(allow.expired(task, NOW), 'whenever');
});

test('expiryState separates absent, live and expired', () => {
  assert.equal(allow.expiryState(card({ allow: ['push'] }), NOW).state, 'none');
  assert.equal(allow.expiryState(card({ allow_until: '2026-09-08T09:00' }), NOW).state, 'live');
  assert.equal(allow.expiryState(card({ allow_until: '2026-09-06T09:00' }), NOW).state, 'expired');
});

test('scope identity ignores case for storage as well as for decisions', () => {
  assert.equal(allow.tokenKey(allow.parseToken('deploy:Prod')), 'deploy:prod');
  // Two spellings of one grant must not both survive (last spelling wins).
  const grants = allow.parseGrants(['deploy:Prod', 'deploy:prod']);
  assert.equal(grants.length, 1);
  assert.equal(allow.tokenKey(grants[0]), 'deploy:prod');
});
