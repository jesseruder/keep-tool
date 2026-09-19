'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createEmulator } = require('./emulator.js');
const { createScrollbackMirror } = require('./scrollback.js');

const write = (emulator, data) => new Promise((resolve) => emulator.write(data, resolve));
const textOf = (entries) => entries.map((entry) => entry.row.text.slice(0, entry.row.trimmed));

// What the buffer itself says is above the screen, which is what the mirror has to
// agree with after every kind of upheaval.
function truth(emulator, window = 10000) {
  const { length } = emulator.normalScrollback();
  const take = Math.min(length, window);
  return emulator.scrollbackRows(take, take).map((row) => row.text.slice(0, row.trimmed));
}

test('lines are collected once as they go past', async (t) => {
  const emulator = createEmulator({ cols: 20, rows: 4, scrollback: 100 });
  t.after(() => emulator.dispose());
  const mirror = createScrollbackMirror({ page: 5, max: 100 });

  assert.equal(mirror.sync(emulator, 5), null, 'an empty screen has nothing above it');
  await write(emulator, 'a\r\nb\r\nc\r\nd\r\ne\r\nf\r\n');
  const first = mirror.sync(emulator, 5);
  assert.deepEqual(textOf(first), ['a', 'b', 'c'], 'three lines above a four row screen');
  assert.equal(mirror.sync(emulator, 5), null, 'nothing new is no change');

  const keys = first.map((entry) => entry.key);
  await write(emulator, 'g\r\nh\r\n');
  const second = mirror.sync(emulator, 5);
  assert.deepEqual(textOf(second), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(second.slice(0, 3).map((entry) => entry.key), keys,
    'the rows already mounted keep their identity, so nothing re-renders for them');
  assert.deepEqual(textOf(second), truth(emulator));
});

test('a resize throws the collection away and reads the reflowed buffer', async (t) => {
  const emulator = createEmulator({ cols: 80, rows: 6, scrollback: 500 });
  t.after(() => emulator.dispose());
  const mirror = createScrollbackMirror({ page: 400, max: 500 });

  // Fifty lines, each long enough to wrap when the screen narrows.
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push(`line ${i} ${'.'.repeat(60)}`);
  await write(emulator, `${lines.join('\r\n')}\r\n`);
  assert.deepEqual(textOf(mirror.sync(emulator, 400)), truth(emulator, 400));

  emulator.resize(40, 6);
  await emulator.flush();
  const narrow = mirror.sync(emulator, 400, { rebuild: true });
  assert.deepEqual(textOf(narrow), truth(emulator, 400),
    'no rows laid out at eighty columns survive into a forty column buffer');
  assert.equal(mirror.length(), emulator.normalScrollback().length,
    'and the mirror agrees with the buffer about how much is above the screen');
  assert.equal(narrow.length, emulator.normalScrollback().length,
    'every row above the screen is mounted once, none of them twice');
  assert.equal(textOf(narrow).every((line) => line.length <= 40), true,
    'and all of them are laid out at the width the buffer has now');

  emulator.resize(80, 6);
  await emulator.flush();
  const wide = mirror.sync(emulator, 400, { rebuild: true });
  assert.deepEqual(textOf(wide), truth(emulator, 400), 'and the same going back');
  assert.equal(mirror.length(), emulator.normalScrollback().length);
});

test('a resize has to be declared, and a buffer that shrinks is caught anyway', async (t) => {
  const emulator = createEmulator({ cols: 40, rows: 6, scrollback: 500 });
  t.after(() => emulator.dispose());
  const mirror = createScrollbackMirror({ page: 400, max: 500 });
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(`row ${i} ${'x'.repeat(30)}`);
  await write(emulator, `${lines.join('\r\n')}\r\n`);
  mirror.sync(emulator, 400);
  assert.deepEqual(textOf(mirror.rows()), truth(emulator, 400));

  // Narrowing re-wraps: the buffer ends up with *more* lines above the screen than
  // the mirror recorded, and they are different lines. That looks exactly like
  // ordinary output from the outside, which is why the caller declares the resize —
  // the mirror cannot tell the two apart and must not guess.
  emulator.resize(20, 6);
  await emulator.flush();
  assert.ok(emulator.normalScrollback().length > mirror.length(), 'the reflow added wrapped rows');
  const declared = mirror.sync(emulator, 400, { rebuild: true });
  assert.deepEqual(textOf(declared), truth(emulator, 400));
  assert.equal(textOf(declared).every((line) => line.length <= 20), true,
    'nothing laid out at forty columns is left behind');

  // A buffer that is shorter than what is held cannot be anything but a reset or a
  // reflow the caller failed to declare, and that one the mirror does catch itself.
  await write(emulator, '\x1bc');
  assert.deepEqual(mirror.sync(emulator, 400), []);
  await write(emulator, 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven\r\n');
  assert.deepEqual(textOf(mirror.sync(emulator, 400)), truth(emulator, 400));
  assert.equal(mirror.length(), emulator.normalScrollback().length);
});

test('a full buffer is a window onto something sliding, not a record', async (t) => {
  const emulator = createEmulator({ cols: 20, rows: 3, scrollback: 10 });
  t.after(() => emulator.dispose());
  const mirror = createScrollbackMirror({ page: 4, max: 100 });

  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(`line${i}`);
  await write(emulator, `${lines.join('\r\n')}\r\n`);
  const window = mirror.sync(emulator, 4);
  assert.equal(mirror.sliding(), true);
  assert.deepEqual(textOf(window), truth(emulator, 4), 'the newest four lines of the buffer');
  assert.deepEqual(window.map((entry) => entry.key), ['sbw:0', 'sbw:1', 'sbw:2', 'sbw:3'],
    'keys are positions in the window, because no line stays where it was');

  await write(emulator, 'later\r\n');
  assert.deepEqual(textOf(mirror.sync(emulator, 4)), truth(emulator, 4), 're-read, not appended to');

  // A reset (which is how a replay begins) puts it back under the limit.
  await write(emulator, '\x1bc');
  assert.deepEqual(mirror.sync(emulator, 4), [], 'the reset empties it');
  assert.equal(mirror.sliding(), false);
  assert.deepEqual(mirror.rows(), []);
  await write(emulator, 'one\r\ntwo\r\nthree\r\nfour\r\n');
  assert.deepEqual(textOf(mirror.sync(emulator, 4)), truth(emulator, 4));
});

test('the alternate screen is left alone, and reset clears the mirror', async (t) => {
  const emulator = createEmulator({ cols: 20, rows: 3, scrollback: 100 });
  t.after(() => emulator.dispose());
  const mirror = createScrollbackMirror({ page: 4, max: 100 });
  await write(emulator, 'a\r\nb\r\nc\r\nd\r\n');
  const collected = textOf(mirror.sync(emulator, 4));
  assert.deepEqual(collected, ['a', 'b']);

  await write(emulator, '\x1b[?1049h');
  assert.equal(mirror.sync(emulator, 4), null, 'a full screen program has no scrollback of its own');
  await write(emulator, 'x\r\ny\r\nz\r\n');
  assert.equal(mirror.sync(emulator, 4), null);
  assert.deepEqual(textOf(mirror.rows()), collected, 'and it does not disturb what the pane scrolled past');

  await write(emulator, '\x1b[?1049l');
  assert.equal(mirror.sync(emulator, 4), null, 'leaving it changes nothing either');
  assert.deepEqual(mirror.reset(), []);
});

test('a resize declared under a full screen program is honoured when it ends', async (t) => {
  const emulator = createEmulator({ cols: 80, rows: 6, scrollback: 500 });
  t.after(() => emulator.dispose());
  const mirror = createScrollbackMirror({ page: 400, max: 500 });
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push(`line ${i} ${'.'.repeat(60)}`);
  await write(emulator, `${lines.join('\r\n')}\r\n`);
  mirror.sync(emulator, 400);
  assert.deepEqual(textOf(mirror.rows()), truth(emulator, 400));
  assert.equal(textOf(mirror.rows()).some((line) => line.length > 40), true, 'these are eighty column rows');

  // The pane is resized while vim (or anything else on the alternate screen) is
  // running. There is no scrollback to read while it is, but xterm reflows the normal
  // buffer underneath, so what is held here is already wrong.
  await write(emulator, '\x1b[?1049h');
  emulator.resize(40, 6);
  await emulator.flush();
  assert.equal(mirror.sync(emulator, 400, { rebuild: true }), null, 'nothing to read while it is running');

  await write(emulator, '\x1b[?1049l');
  const after = mirror.sync(emulator, 400);
  assert.deepEqual(textOf(after), truth(emulator, 400),
    'the declared resize is honoured on the first sync that can act on it');
  assert.equal(textOf(after).every((line) => line.length <= 40), true, 'no eighty column rows are left');
  assert.equal(mirror.length(), emulator.normalScrollback().length);

  // Widening is the case that cannot be noticed after the fact: the buffer's length
  // does not fall, so nothing but the remembered request says the rows are stale.
  const narrowRows = textOf(mirror.rows());
  await write(emulator, '\x1b[?1049h');
  emulator.resize(100, 6);
  await emulator.flush();
  assert.equal(mirror.sync(emulator, 400, { rebuild: true }), null);
  await write(emulator, '\x1b[?1049l');
  const wide = mirror.sync(emulator, 400);
  assert.notDeepEqual(textOf(wide), narrowRows, 'the forty column rows did not survive the widening');
  assert.deepEqual(textOf(wide), truth(emulator, 400));
});
