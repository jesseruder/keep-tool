const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class WheelEvent {
  static DOM_DELTA_PIXEL = 0;
  static DOM_DELTA_LINE = 1;
  static DOM_DELTA_PAGE = 2;

  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
}

function fixture(mode = 'any') {
  const frames = new Map();
  let nextFrame = 0;
  let now = 0;
  let active = true;
  const delivered = [];
  const screen = { getBoundingClientRect: () => ({ height: 200 }) };
  const terminal = {
    rows: 20,
    modes: { mouseTrackingMode: mode },
    element: {
      querySelector: () => screen,
      dispatchEvent(event) {
        if (wheel.handle(event)) delivered.push({ deltaY: event.deltaY, clientX: event.clientX });
      },
    },
  };
  const context = vm.createContext({ WheelEvent, WeakSet, Set, Math, Number });
  const source = fs.readFileSync(path.join(__dirname, '../web/app/terminal-scroll.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`${source}\nthis.createHandler = createTrackedPixelWheelHandler`, context);
  const wheel = context.createHandler(terminal, {
    active: () => active,
    requestFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelFrame(id) { frames.delete(id); },
    now: () => now,
  });
  const event = (deltaY, options = {}) => new WheelEvent('wheel', {
    deltaY, deltaMode: WheelEvent.DOM_DELTA_PIXEL, clientX: 31,
    altKey: false, ctrlKey: false, shiftKey: false, metaKey: false,
    ...options,
  });
  const runFrame = () => {
    const [id, callback] = frames.entries().next().value || [];
    if (!callback) return false;
    frames.delete(id);
    callback();
    return true;
  };
  return {
    wheel, terminal, delivered, frames, event, runFrame,
    advance: milliseconds => { now += milliseconds; },
    setActive: value => { active = value; },
  };
}

test('trackpad pixels retain fractions and preserve report direction order', () => {
  const f = fixture();
  assert.equal(f.wheel.handle(f.event(25)), false);
  assert.equal(f.wheel.handle(f.event(-6)), false);
  assert.equal(f.wheel.handle(f.event(-12)), false);
  assert.equal(f.frames.size, 1, 'one frame drains a burst');
  f.runFrame();
  assert.deepEqual(f.delivered, [
    { deltaY: 1, clientX: 31 },
    { deltaY: 1, clientX: 31 },
    { deltaY: -1, clientX: 31 },
  ]);
});

test('trackpad reports are bounded to four per frame and 24 queued reports', () => {
  const f = fixture();
  for (let index = 0; index < 10; index++) f.wheel.handle(f.event(49));
  for (let frame = 1; frame <= 6; frame++) {
    assert.equal(f.runFrame(), true);
    assert.equal(f.delivered.length, frame * 4);
  }
  assert.equal(f.runFrame(), false);
  assert.equal(f.delivered.length, 24, 'distance beyond the six-frame latency cap is dropped');
});

test('line, page, modifiers, wheel-like pixels, and unsupported modes stay with xterm', () => {
  const f = fixture();
  const delegated = [
    f.event(3, { deltaMode: WheelEvent.DOM_DELTA_LINE }),
    f.event(1, { deltaMode: WheelEvent.DOM_DELTA_PAGE }),
    f.event(20, { altKey: true }),
    f.event(20, { ctrlKey: true }),
    f.event(20, { shiftKey: true }),
    f.event(20, { metaKey: true }),
    f.event(50),
  ];
  for (const event of delegated) assert.equal(f.wheel.handle(event), true);
  for (const mode of ['none', 'x10']) {
    f.terminal.modes.mouseTrackingMode = mode;
    assert.equal(f.wheel.handle(f.event(20)), true);
  }
  assert.equal(f.frames.size, 0);
});

test('a delegated wheel cancels queued pixels so native input cannot be overtaken', () => {
  const f = fixture();
  f.wheel.handle(f.event(25));
  assert.equal(f.frames.size, 1);
  assert.equal(f.wheel.handle(f.event(1, { deltaMode: WheelEvent.DOM_DELTA_LINE })), true);
  assert.equal(f.frames.size, 0);
  assert.equal(f.runFrame(), false);
  assert.deepEqual(f.delivered, []);
});

test('cancel, inactivity, and tracking mode changes discard delayed reports', () => {
  const f = fixture();
  f.wheel.handle(f.event(25));
  f.wheel.cancel();
  assert.equal(f.frames.size, 0);
  assert.deepEqual(f.delivered, []);

  f.wheel.handle(f.event(25));
  f.terminal.modes.mouseTrackingMode = 'vt200';
  f.runFrame();
  assert.deepEqual(f.delivered, [], 'reports from one mode cannot leak into another');
  assert.equal(f.frames.size, 0);

  f.terminal.modes.mouseTrackingMode = 'any';
  f.setActive(false);
  assert.equal(f.wheel.handle(f.event(25)), false, 'tracked pixels are consumed while inactive');
  assert.equal(f.frames.size, 0);
});

test('reports older than 120ms are dropped after a stalled frame', () => {
  const f = fixture();
  f.wheel.handle(f.event(25));
  f.advance(121);
  f.runFrame();
  assert.deepEqual(f.delivered, []);
  assert.equal(f.frames.size, 0);
});
