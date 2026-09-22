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

test('the daemon host outage reads as it always did when no remote node is out', () => {
  const host = { ok: false, reason: 'unreachable', since: 40_000, stale: true, panesAt: 70_000 };
  const before = { text: 'terminal host unreachable 1m · showing panes as of 30 s ago', status: 'degraded', ticking: true };
  assert.deepEqual(statusChipState({ hostStatus: host }, NOW), before);
  assert.deepEqual(statusChipState({ hostStatus: { ...host, nodes: {} } }, NOW), before);
  assert.deepEqual(statusChipState({ hostStatus: { ...host, nodes: { aws1: { ok: true } } } }, NOW), before);
  assert.deepEqual(statusChipState({ hostStatus: { ok: true, nodes: { aws1: { ok: true } } } }, NOW),
    { text: '', status: 'live', ticking: false });
});

test('a silent remote node is named with how long, alone or beside the daemon host', () => {
  const nodes = {
    aws2: { ok: true },
    aws1: { ok: false, reason: 'unreachable', since: NOW - 180_000 },
    gpu: { ok: false, reason: 'timeout', since: 90_000, stale: true, panesAt: 40_000 },
  };
  const remote = 'aws1 unreachable 3m · gpu not answering 10s · showing its panes as of 1 m ago';
  assert.deepEqual(statusChipState({ hostStatus: { ok: true, nodes } }, NOW), { text: remote, status: 'degraded', ticking: true });
  assert.equal(statusChipState({ hostStatus: { ok: false, reason: 'timeout', since: 95_000, nodes } }, NOW).text,
    `terminal host not answering 5s · ${remote}`);
  assert.equal(statusChipState({ hostStatus: { ok: true, nodes: { lab: { ok: false, reason: 'invalid', since: NOW } } } }, NOW).text,
    'lab misconfigured 0s');
  // Pending writes and a stale state still speak first.
  assert.equal(statusChipState({ generatedAt: 75_000, hostStatus: { ok: true, nodes } }, NOW).text, 'state 25 s old');
});
