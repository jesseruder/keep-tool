'use strict';
// A fixture suite for bin/test-runner.test.js: it proves the wrapper still loads
// scripts/test-env.cjs, which is what keeps a test child away from the real registry.
const test = require('node:test');
const assert = require('node:assert/strict');

test('the wrapper hands the child an isolated registry', () => {
  assert.match(String(process.env.KEEP_DIR || ''), /keep-node-test-/);
  console.log('keep dir is isolated');
});
