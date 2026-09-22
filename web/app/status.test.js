import test from 'node:test';
import assert from 'node:assert/strict';

import { hostOutageText, nodeOutages, sessionExplanation, sessionLabel } from './status.js';

test('automatic retirement is described as a memory pause without hiding pending context', () => {
  const session = {
    state: 'exited',
    stateLabel: 'Exited',
    retirement: { automatic: true, reason: 'settled-attention', at: '2026-09-20T20:00:00Z' },
    activity: { decision: { source: 'conversation', rule: 'pending input', confidence: 'high' } },
  };
  assert.equal(sessionLabel(session), 'Paused to save memory');
  assert.match(sessionExplanation(session), /^Paused to save memory · conversation: pending input \(high\)/);
  assert.equal(sessionLabel({ state: 'exited', stateLabel: 'Exited' }), 'Exited');
});

test('node outages read only failing remote nodes and tolerate a publication without them', () => {
  assert.deepEqual(nodeOutages(undefined), []);
  assert.deepEqual(nodeOutages({ ok: true }), []);
  assert.deepEqual(nodeOutages({ ok: true, nodes: [] }), []);
  assert.deepEqual(nodeOutages({ ok: true, nodes: { b: { ok: false, since: 1 }, a: { ok: true }, c: null, d: { ok: false } } }),
    [{ ok: false, since: 1, name: 'b' }, { ok: false, name: 'd' }]);
  assert.equal(hostOutageText({ ok: false, reason: 'timeout', since: 1_000 }, 61_000), 'terminal host not answering 1m');
});
