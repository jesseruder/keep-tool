'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
test('console subscription polls as fallback and disposes both resources', async () => {
  const original = global.EventSource;
  let closed = false;
  global.EventSource = class { addEventListener() {} close() { closed = true; } };
  try {
    const { subscribe } = await import('../web/app/api.js');
    let tick; let count = 0; let cleared;
    const dispose = subscribe(() => count++, null, null, {
      setInterval(fn, ms) { assert.equal(ms, 30000); tick = fn; return 42; },
      clearInterval(id) { cleared = id; },
    });
    tick();
    assert.equal(count, 1);
    dispose();
    assert.equal(cleared, 42);
    assert.equal(closed, true);
  } finally { global.EventSource = original; }
});
