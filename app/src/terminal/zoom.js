'use strict';

// Pinch-to-zoom without a gesture library. `react-native-gesture-handler` is not a
// dependency of this app and adding it is a native rebuild for one gesture, so the
// terminal reads the two touches out of a PanResponder event itself. The arithmetic
// is here, where it can be tested, and the screen only feeds it touch positions.
//
// A pinch is measured against the state the gesture started in — the distance
// between the two fingers and the font size at that moment — rather than frame to
// frame, so rounding cannot accumulate and lifting one finger and putting it back
// starts a fresh, undistorted gesture.

const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 20;
// A phone's font sizes are device-independent pixels; half a point is as fine as the
// difference is readable, and quantizing keeps a slow pinch from repainting the whole
// screen for a change nobody can see.
const FONT_STEP = 0.5;

function clampFontSize(size, min = MIN_FONT_SIZE, max = MAX_FONT_SIZE) {
  if (!Number.isFinite(size)) return min;
  return Math.min(max, Math.max(min, size));
}

function quantizeFontSize(size, step = FONT_STEP) {
  return Math.round(size / step) * step;
}

// `touches` is the `nativeEvent.touches` array a React Native responder hands over:
// at least two entries with pageX/pageY. Fewer than two is not a pinch.
function touchDistance(touches) {
  if (!Array.isArray(touches) || touches.length < 2) return null;
  const [a, b] = touches;
  const dx = Number(a.pageX) - Number(b.pageX);
  const dy = Number(a.pageY) - Number(b.pageY);
  const distance = Math.hypot(dx, dy);
  return Number.isFinite(distance) ? distance : null;
}

// The font size this pinch has reached. A degenerate start distance (two touches
// reported at the same point, which Android does on the first frame of a gesture)
// would divide by zero, so it holds the size the gesture started at instead.
function pinchFontSize(start, distance, bounds = {}) {
  const min = bounds.min === undefined ? MIN_FONT_SIZE : bounds.min;
  const max = bounds.max === undefined ? MAX_FONT_SIZE : bounds.max;
  const step = bounds.step === undefined ? FONT_STEP : bounds.step;
  const startSize = clampFontSize(Number(start && start.fontSize), min, max);
  const startDistance = Number(start && start.distance);
  if (!Number.isFinite(startDistance) || startDistance < 1) return startSize;
  if (!Number.isFinite(distance) || distance <= 0) return startSize;
  return clampFontSize(quantizeFontSize(startSize * (distance / startDistance), step), min, max);
}

// The screen keeps one of these across the gesture's callbacks.
function createPinch(bounds = {}) {
  let start = null;
  return {
    // Returns true when a pinch has begun, so the caller knows to stop treating the
    // event as a scroll.
    begin(touches, fontSize) {
      const distance = touchDistance(touches);
      if (distance === null || distance < 1) { start = null; return false; }
      start = { distance, fontSize };
      return true;
    },
    // Returns the font size for this frame, or null when this is not a live pinch.
    move(touches) {
      if (!start) return null;
      const distance = touchDistance(touches);
      if (distance === null) return null;
      return pinchFontSize(start, distance, bounds);
    },
    end() { start = null; },
    active() { return start !== null; },
  };
}

module.exports = {
  FONT_STEP, MAX_FONT_SIZE, MIN_FONT_SIZE,
  clampFontSize, createPinch, pinchFontSize, quantizeFontSize, touchDistance,
};
