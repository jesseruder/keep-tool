'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createEmulator } = require('./emulator.js');
const { rowSegments } = require('./row.js');

const shape = (segments) => segments.map((segment) => `${segment.cursor ? '|' : ''}${segment.text}`).join('');
const at = (offset, length = 1) => ({ offset, length });

test('a row is cut at the last cell the program wrote', async (t) => {
  const emulator = createEmulator({ cols: 12, rows: 2 });
  t.after(() => emulator.dispose());
  await new Promise((resolve) => emulator.write('ab\x1b[31mcd\x1b[0m', resolve));
  const [row] = emulator.rows({ start: 0, end: 0 });

  const segments = rowSegments(row, null);
  assert.equal(shape(segments), 'abcd', 'the blank fill past the text is not drawn');
  assert.equal(segments.length, 2, 'one piece per styling run');
  assert.equal(segments[1].run.fg, 1);
  assert.deepEqual(rowSegments(emulator.rows({ start: 1, end: 1 })[0], null), [], 'an untouched row draws nothing');
});

test('the cursor cell is split out of the run it lands in', async (t) => {
  const emulator = createEmulator({ cols: 12, rows: 1 });
  t.after(() => emulator.dispose());
  await new Promise((resolve) => emulator.write('ab\x1b[31mcdef\x1b[0m', resolve));
  const [row] = emulator.rows({ start: 0, end: 0 });

  assert.equal(shape(rowSegments(row, at(3))), 'abc|def', 'the run splits into before, cursor and after');
  assert.equal(shape(rowSegments(row, at(0))), '|abcdef', 'a cursor at the start has no piece before it');
  assert.equal(shape(rowSegments(row, at(5))), 'abcde|f', 'a cursor at the end has no piece after it');

  const split = rowSegments(row, at(3));
  const cursor = split.find((segment) => segment.cursor);
  assert.equal(cursor.text, 'd');
  assert.equal(cursor.run.fg, 1, 'the cursor piece keeps the styling underneath it');
});

test('a cursor past the written text pads the row out to it', async (t) => {
  const emulator = createEmulator({ cols: 12, rows: 1 });
  t.after(() => emulator.dispose());
  await new Promise((resolve) => emulator.write('ok', resolve));
  const [row] = emulator.rows({ start: 0, end: 0 });

  const segments = rowSegments(row, at(4));
  assert.equal(shape(segments), 'ok  | ', 'the gap is real blank cells and the cursor sits on the next one');
  assert.equal(segments[segments.length - 1].cursor, true);

  assert.equal(shape(rowSegments({ text: '', trimmed: 0, runs: [] }, at(2))), '  | ',
    'an empty row still shows where the cursor is');
  assert.deepEqual(rowSegments(null, at(3)), []);
});

test('the cursor covers a whole character, never half a surrogate pair', async (t) => {
  const emulator = createEmulator({ cols: 20, rows: 1 });
  t.after(() => emulator.dispose());
  await new Promise((resolve) => emulator.write('日本\u{1f600}éx', resolve));
  const [row] = emulator.rows({ start: 0, end: 0 });

  const cursorAt = async (cell) => {
    await new Promise((resolve) => emulator.write(`\x1b[1;${cell + 1}H`, resolve));
    const cursor = emulator.cursor();
    return rowSegments(row, cursor).find((segment) => segment.cursor);
  };

  assert.equal((await cursorAt(0)).text, '日', 'a wide glyph');
  assert.equal((await cursorAt(2)).text, '本');
  assert.equal((await cursorAt(4)).text, '\u{1f600}', 'the emoji is one piece, not one code unit');
  assert.equal((await cursorAt(5)).text, 'é', 'the combining mark goes with its character');
  assert.equal((await cursorAt(6)).text, 'x');
  const pastTheEnd = await cursorAt(9);
  assert.equal(pastTheEnd.text, ' ');
  assert.equal(shape(rowSegments(row, emulator.cursor())).replace('|', ''), '日本\u{1f600}éx   ',
    'the row is padded out to a cursor past its text');
});

test('a painted background is drawn to the edge the program painted it to', async (t) => {
  const emulator = createEmulator({ cols: 10, rows: 1 });
  t.after(() => emulator.dispose());
  // ESC[44m ESC[K writes no characters at all: every cell is erased under a blue
  // background. Clipping the row at its last character would throw the bar away.
  await new Promise((resolve) => emulator.write('\x1b[44m\x1b[K', resolve));
  const [row] = emulator.rows({ start: 0, end: 0 });
  const segments = rowSegments(row, null);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, '          ');
  assert.equal(segments[0].run.bg, 4);
});
