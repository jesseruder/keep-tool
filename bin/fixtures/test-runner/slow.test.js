'use strict';
// A fixture suite for bin/test-runner.test.js: it announces itself and then stays
// running, so the test can interrupt the wrapper while a suite is in flight.
const test = require('node:test');

test('this suite waits to be interrupted', async () => {
  process.stdout.write('# fixture running\n');
  await new Promise((resolve) => setTimeout(resolve, 30_000));
});
