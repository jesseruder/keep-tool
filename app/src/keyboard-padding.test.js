const assert = require('node:assert/strict');
const test = require('node:test');

const { keyboardPadding } = require('./keyboard-padding.js');

test('with the keyboard closed a screen keeps the safe-area inset', () => {
  assert.equal(keyboardPadding({ insetBottom: 24 }), 24);
  assert.equal(keyboardPadding({ insetBottom: 24, frameBottom: 900, keyboardTop: null }), 24);
  assert.equal(keyboardPadding({}), 0);
  assert.equal(keyboardPadding(), 0);
});

test('edge to edge: the frame reaches the screen bottom, so the whole overlap is padded', () => {
  // A 900-high screen, keyboard (and the bar under it) from 576 down.
  assert.equal(keyboardPadding({ insetBottom: 24, frameBottom: 900, keyboardTop: 576 }), 324);
});

test('a window the system already shrank, or split screen, needs only the inset', () => {
  assert.equal(keyboardPadding({ insetBottom: 24, frameBottom: 576, keyboardTop: 576 }), 24);
  assert.equal(keyboardPadding({ insetBottom: 0, frameBottom: 450, keyboardTop: 576 }), 0);
  // A partial shrink pads only what is still covered.
  assert.equal(keyboardPadding({ insetBottom: 24, frameBottom: 650, keyboardTop: 576 }), 74);
});

test('nonsense values fall back to the inset', () => {
  assert.equal(keyboardPadding({ insetBottom: -5, frameBottom: 'x', keyboardTop: 3 }), 0);
  assert.equal(keyboardPadding({ insetBottom: 10, frameBottom: 900, keyboardTop: NaN }), 10);
});
