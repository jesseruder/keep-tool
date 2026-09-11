'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { applyHostedExitState } = require('./serve');
const status = require('./session-status');

test('physical pane exit overrides stale questions for already-discovered sessions', () => {
  const session = { id: 's', kind: 'codex', endedTurn: true, state: 'needs-input', pendingQuestion: { question: 'Old approval?' } };
  applyHostedExitState([session], [{ alive: false, meta: { sessionId: 's' } }]);
  session.activity = status.activity(session);
  assert.equal(session.activity.state, 'exited');
  assert.equal(status.attention(session), null);
});

test('a live replacement or independently live process wins over an older exited pane', () => {
  for (const independent of [false, true]) {
    const session = { id: 's', kind: 'codex', endedTurn: true };
    const panes = [{ alive: false, meta: { sessionId: 's' } }];
    if (!independent) panes.push({ alive: true, meta: { sessionId: 's' } });
    applyHostedExitState([session], panes, independent ? new Set(['s']) : null);
    assert.notEqual(session.exited, true);
  }
});
