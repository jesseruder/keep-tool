'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { polyfillNavigator } = require('./platform');

test('a Hermes-style navigator gets string userAgent and platform', () => {
  const nav = { product: 'ReactNative' };
  assert.deepEqual(polyfillNavigator(nav), ['userAgent', 'platform']);
  assert.equal(typeof nav.userAgent, 'string');
  assert.equal(typeof nav.platform, 'string');
  assert.equal(nav.product, 'ReactNative');
});

test('a browser navigator is left alone', () => {
  const nav = { userAgent: 'Mozilla/5.0', platform: 'MacIntel' };
  assert.deepEqual(polyfillNavigator(nav), []);
  assert.equal(nav.userAgent, 'Mozilla/5.0');
  assert.equal(nav.platform, 'MacIntel');
});

test('no navigator at all is not an error', () => {
  assert.deepEqual(polyfillNavigator(undefined), []);
  assert.deepEqual(polyfillNavigator(null), []);
});
