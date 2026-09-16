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

test('the restart route marks the request right before shutdown, not when it accepts it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { routes } = require('./serve/routes');
  const calls = [];
  const list = routes({
    daemonRestartGate: createGate(),
    health: { recordRestartRequest: () => calls.push('mark') },
    shutdown: () => calls.push('shutdown'),
    json: (res, status, value) => ({ status, value }),
  });
  const route = list.find((entry) => entry.path === '/api/restart-daemon');
  const response = await route.handle({ req: { method: 'POST' }, res: {}, url: new URL('http://x/api/restart-daemon'), body: {} });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [], 'a daemon that dies before its shutdown must still read as a crash');
  t.mock.timers.tick(50);
  assert.deepEqual(calls, ['mark', 'shutdown']);
});
