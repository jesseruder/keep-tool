'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createGate } = require('./daemon-restart');

test('daemon restart refuses pending swaps, active compaction and restoration, then closes admission', () => {
  let records = [], busy = false;
  const gate = createGate({ pending: () => records, busy: () => busy });
  const leave = gate.enter();
  assert.throws(() => gate.prepare(), /in flight/);
  leave(); leave();
  records = [{ error: 'unreadable' }];
  assert.throws(() => gate.prepare(), /Pending model restoration/);
  records = []; busy = true;
  assert.throws(() => gate.prepare(), /in flight/);
  busy = false;
  assert.equal(gate.prepare().ok, true);
  assert.equal(gate.stopping, true);
  assert.throws(() => gate.enter(), /paused/);
});

test('unreadable pending-swap directory cannot authorize restart', () => {
  const gate = createGate({ pending: () => { throw Error('EACCES'); } });
  assert.throws(() => gate.prepare(), /EACCES/);
  assert.equal(gate.stopping, false);
});
