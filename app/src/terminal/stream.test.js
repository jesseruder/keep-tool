'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createEmulator } = require('./emulator.js');
const { createTerminalStream } = require('./stream.js');

// Let every microtask the chain queued run, without counting them by hand.
const settle = () => new Promise((resolve) => setImmediate(resolve));

// An emulator whose parsing has to be released by hand, which is what xterm's write
// queue does on its own schedule.
function fakeEmulator() {
  const log = [];
  const pending = [];
  const drains = [];
  return {
    log,
    releaseWrite() { const next = pending.shift(); if (next) next(); return Boolean(next); },
    releaseDrain() { const next = drains.shift(); if (next) next(); return Boolean(next); },
    emulator: {
      write(data, done) { log.push(`write:${data}`); pending.push(done); },
      drain() { log.push('drain'); return new Promise((resolve) => drains.push(resolve)); },
      resize(cols, rows) { log.push(`resize:${cols}x${rows}`); },
    },
  };
}

test('a resize waits for the bytes written before it and holds back the ones after', async () => {
  const fake = fakeEmulator();
  const events = [];
  const stream = createTerminalStream({
    emulator: fake.emulator,
    onParsed: () => events.push('parsed'),
    onResized: (cols, rows) => events.push(`resized:${cols}x${rows}`),
  });

  stream.write('first');
  stream.resize(100, 40);
  stream.write('second');
  await settle();
  assert.deepEqual(fake.log, ['write:first'], 'nothing gets ahead of the write in flight');

  fake.releaseWrite();
  await settle();
  assert.deepEqual(fake.log, ['write:first', 'drain'], 'the resize drains what was queued before it');
  assert.deepEqual(events, ['parsed']);

  fake.releaseDrain();
  await settle();
  assert.deepEqual(fake.log, ['write:first', 'drain', 'resize:100x40', 'write:second'],
    'the second frame is written only once the new geometry is in place');
  assert.deepEqual(events, ['parsed', 'resized:100x40']);

  fake.releaseWrite();
  await settle();
  assert.deepEqual(events, ['parsed', 'resized:100x40', 'parsed']);
});

test('disposal settles the step in flight instead of waiting for a parser that is gone', async () => {
  const fake = fakeEmulator();
  const events = [];
  const stream = createTerminalStream({
    emulator: fake.emulator,
    onParsed: () => events.push('parsed'),
    onResized: () => events.push('resized'),
  });

  stream.write('first');
  stream.resize(100, 40);
  stream.write('second');
  await settle();
  assert.deepEqual(fake.log, ['write:first'], 'the first write is in flight and the rest are behind it');

  // The screen unmounts: the emulator is disposed, so the callback for the write in
  // flight is never coming. Waiting for it would keep the whole line — and every
  // closure in it — alive behind a screen nobody is looking at.
  stream.dispose();
  let settled = false;
  stream.idle().then(() => { settled = true; });
  await settle();
  assert.equal(settled, true, 'idle() resolves rather than waiting for a callback that will not come');
  assert.deepEqual(fake.log, ['write:first'], 'nothing queued behind it reached the emulator');
  assert.deepEqual(events, []);

  // The parser answering late must not resurrect any of it.
  fake.releaseWrite();
  await settle();
  assert.deepEqual(events, [], 'a callback after disposal is ignored');
  assert.deepEqual(fake.log, ['write:first']);

  stream.write('third');
  stream.resize(80, 24);
  await settle();
  assert.deepEqual(fake.log, ['write:first'], 'and nothing new reaches a disposed emulator');
  assert.deepEqual(events, []);
});

test('a drain that never resolves is released by disposal too', async () => {
  const fake = fakeEmulator();
  const events = [];
  const stream = createTerminalStream({ emulator: fake.emulator, onResized: () => events.push('resized') });
  stream.resize(60, 20);
  await settle();
  assert.deepEqual(fake.log, ['drain']);

  stream.dispose();
  await stream.idle();
  fake.releaseDrain();
  await settle();
  assert.deepEqual(fake.log, ['drain'], 'the resize is not applied to an emulator that is gone');
  assert.deepEqual(events, []);
});

test('over a real emulator the bytes land at the geometry they were written for', async (t) => {
  const emulator = createEmulator({ cols: 80, rows: 5 });
  t.after(() => emulator.dispose());
  const stream = createTerminalStream({ emulator });
  t.after(() => stream.dispose());

  stream.write('\x1b[2J\x1b[H'.concat('y'.repeat(60)));
  stream.resize(40, 5);
  stream.write('\r\nafter');
  await settle();
  await stream.idle();

  const rows = emulator.rows().map((row) => row.text.slice(0, row.trimmed));
  assert.equal(emulator.cols, 40);
  assert.ok(rows.join('\n').includes('after'), 'the frame after the resize was parsed at the new width');
  assert.equal(rows[0].length <= 40, true, 'and the screen is 40 columns wide throughout');
});
