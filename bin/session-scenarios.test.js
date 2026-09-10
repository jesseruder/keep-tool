'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { replay, minimize, ScenarioFailure } = require('./scenarios/harness');
const { cases, generated } = require('./scenarios/cases');
for (const agent of ['claude', 'codex']) {
  for (const c of cases.filter(c => !c.agent || c.agent === agent)) test(`scenario ${agent}: ${c.name}`, () => replay(agent, c.events));
  test(`scenario ${agent}: seeded transitions`, () => { for (let seed = 1; seed <= 10; seed++) replay(agent, generated(seed)); });
}
test('failure reducer retains a reproducible assertion and removes unrelated events', () => {
  const events = [{ type: 'advance', ms: 60000 }, { type: 'user' }, { type: 'stop' }, { type: 'restart' }, { type: 'expect', state: 'needs-input' }];
  // Mutation canary: deliberately break readiness to prove the oracle detects it.
  const options = { observe: status => status.state === 'needs-input' ? { ...status, state: 'idle', needsInput: false } : status };
  let failure;
  try { replay('claude', events, options); } catch (e) { failure = e; }
  assert.ok(failure instanceof ScenarioFailure);
  const small = minimize('claude', events, failure, options);
  assert.ok(small.length < events.length);
  assert.throws(() => replay('claude', small, options), e => e.rule === failure.rule && e.expected === failure.expected);
  for (let i = 0; i < small.length; i++) {
    if (!['advance', 'output', 'restart', 'wrapper', 'hook'].includes(small[i].type)) continue;
    try { replay('claude', small.filter((_, j) => i !== j), options); }
    catch (e) { assert.ok(!(e instanceof ScenarioFailure) || e.rule !== failure.rule || e.expected !== failure.expected); }
  }
  assert.deepEqual(generated(123), generated(123));
  assert.notDeepEqual(generated(123), generated(124));
});
