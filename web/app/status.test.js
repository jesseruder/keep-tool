import test from 'node:test';
import assert from 'node:assert/strict';

import { sessionExplanation, sessionLabel } from './status.js';

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
