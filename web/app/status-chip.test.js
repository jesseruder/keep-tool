import test from 'node:test';
import assert from 'node:assert/strict';
import { statusChipState } from './status-chip.js';

const NOW = 100_000;

test('status chip prioritizes pending writes and counts concurrent actions', () => {
  assert.deepEqual(statusChipState({ pending: [
    { label: 'Closing session', startedAt: 88_000 },
    { label: 'Sending', startedAt: 90_000 },
  ] }, NOW), { text: 'Closing session · 12 s · 2 actions', status: 'pending', ticking: true });
});

test('status chip describes reconnecting, stale state, and stale host panes', () => {
  assert.equal(statusChipState({ reconnectingSince: 81_000 }, NOW).text, 'reconnecting · 19 s');
  assert.equal(statusChipState({ generatedAt: 75_000 }, NOW).text, 'state 25 s old');
  assert.equal(statusChipState({ hostStatus: { ok: false, reason: 'timeout', since: 90_000, stale: true, panesAt: 40_000 } }, NOW).text,
    'terminal host not answering 10s · showing panes as of 1 m ago');
  assert.deepEqual(statusChipState({ generatedAt: 90_000, hostStatus: { ok: true } }, NOW),
    { text: '', status: 'live', ticking: false });
});
