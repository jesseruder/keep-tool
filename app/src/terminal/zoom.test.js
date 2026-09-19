'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { clampFontSize, createPinch, pinchFontSize, touchDistance } = require('./zoom.js');

const at = (x, y) => ({ pageX: x, pageY: y });

test('the pinch distance is the gap between the first two touches', () => {
  assert.equal(touchDistance([at(0, 0), at(3, 4)]), 5);
  assert.equal(touchDistance([at(10, 10)]), null, 'one finger is a scroll, not a pinch');
  assert.equal(touchDistance([]), null);
  assert.equal(touchDistance(undefined), null);
});

test('the font scales with the ratio to the distance the gesture started at', () => {
  const start = { distance: 100, fontSize: 10 };
  assert.equal(pinchFontSize(start, 200), 20, 'spreading to twice the gap doubles the font');
  assert.equal(pinchFontSize(start, 50), 6, 'closing to half would be 5, which the minimum holds at 6');
  assert.equal(pinchFontSize(start, 100), 10, 'no movement is no change');
  assert.equal(pinchFontSize(start, 121), 12, 'sizes quantize to the half point');
});

test('the bounds hold at both ends and a degenerate gesture changes nothing', () => {
  const start = { distance: 100, fontSize: 12 };
  assert.equal(pinchFontSize(start, 10000), 20);
  assert.equal(pinchFontSize(start, 1), 6);
  assert.equal(pinchFontSize(start, 400, { min: 8, max: 14 }), 14);
  assert.equal(pinchFontSize({ distance: 0, fontSize: 9 }, 300), 9, 'two touches at one point are not a ratio');
  assert.equal(pinchFontSize({ distance: 100, fontSize: 9 }, NaN), 9);
  assert.equal(pinchFontSize({ distance: 100, fontSize: 200 }, 100), 20, 'a stored size outside the bounds is pulled in');
  assert.equal(clampFontSize(NaN), 6);
});

test('a pinch measures from where it began, so lifting a finger restarts it cleanly', () => {
  const pinch = createPinch();
  assert.equal(pinch.move([at(0, 0), at(100, 0)]), null, 'no gesture, no size');
  assert.equal(pinch.begin([at(0, 0), at(100, 0)], 10), true);
  assert.equal(pinch.active(), true);
  assert.equal(pinch.move([at(0, 0), at(150, 0)]), 15);
  assert.equal(pinch.move([at(0, 0), at(120, 0)]), 12, 'the size follows the gap, it does not accumulate');
  assert.equal(pinch.move([at(0, 0)]), null, 'a lifted finger reports nothing rather than a jump');

  pinch.end();
  assert.equal(pinch.active(), false);
  assert.equal(pinch.begin([at(0, 0), at(120, 0)], 12), true);
  assert.equal(pinch.move([at(0, 0), at(120, 0)]), 12, 'the new gesture starts from the size on screen');
  assert.equal(pinch.begin([at(5, 5), at(5, 5)], 12), false, 'a zero-width start is refused');
});
