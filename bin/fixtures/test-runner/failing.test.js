'use strict';
// A fixture suite for bin/test-runner.test.js: the wrapper must not swallow a failure.
const test = require('node:test');
const assert = require('node:assert/strict');

test('this failure is deliberate', () => { assert.equal(1, 2); });
