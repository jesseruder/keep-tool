'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDashboardPublisher } = require('./dashboard-publisher.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test('dashboard publisher coalesces invalidations and retains the last good snapshot after a failed rebuild', async () => {
  let builds = 0;
  let fail = false;
  const publications = [];
  const errors = [];
  const publisher = createDashboardPublisher({
    warmup: false,
    debounceMs: 5,
    cadenceMs: 60e3,
    prepare: () => ({ marker: ++builds }),
    build: async (input) => {
      if (fail) throw new Error('fixture rebuild failed');
      return { state: { generatedAt: Date.now(), marker: input.marker }, portableTransfers: [] };
    },
    publish: (value) => publications.push(value),
    onError: (error) => errors.push(error.message),
  });
  try {
    publisher.invalidate();
    publisher.invalidate();
    publisher.invalidate();
    await tick();
    assert.equal(builds, 1);
    assert.equal(publications.length, 1);
    assert.equal(publications[0].state.marker, 1);

    fail = true;
    publisher.invalidate();
    await tick();
    assert.equal(builds, 2);
    assert.equal(publications.length, 1, 'a failed build never replaces the valid publication');
    assert.deepEqual(errors, ['fixture rebuild failed']);
    assert.equal(publisher.latest().state.marker, 1);
  } finally { publisher.close(); }
});

test('an invalidation during a running build queues only one follow-up refresh', async () => {
  let release;
  let builds = 0;
  const publications = [];
  const publisher = createDashboardPublisher({
    warmup: false, debounceMs: 0, cadenceMs: 60e3,
    build: async () => {
      builds += 1;
      if (builds === 1) await new Promise((resolve) => { release = resolve; });
      return { state: { generatedAt: Date.now(), builds }, portableTransfers: [] };
    },
    publish: (value) => publications.push(value),
  });
  try {
    publisher.invalidate();
    while (!release) await tick();
    publisher.invalidate();
    publisher.invalidate();
    release();
    while (publications.length < 2) await tick();
    assert.equal(builds, 2);
    assert.ok(publications[1].version > publications[0].version);
  } finally { publisher.close(); }
});
