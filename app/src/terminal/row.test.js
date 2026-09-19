'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createEmulator } = require('./emulator.js');
const { rowSegments } = require('./row.js');

const shape = (segments) => segments.map((segment) => `${segment.cursor ? '|' : ''}${segment.text}`).join('');

test('a row is cut at the last cell the program wrote', async (t) => {
  const emulator = createEmulator({ cols: 12, rows: 2 });
  t.after(() => emulator.dispose());
  await new Promise((resolve) => emulator.write('ab\x1b[31mcd\x1b[0m', resolve));
  const [row] = emulator.rows({ start: 0, end: 0 });

  const segments = rowSegments(row, -1);
  assert.equal(shape(segments), 'abcd', 'the blank fill past the text is not drawn');
  assert.equal(segments.length, 2, 'one piece per styling run');
  assert.equal(segments[1].run.fg, 1);
  assert.deepEqual(rowSegments(emulator.rows({ start: 1, end: 1 })[0], -1), [], 'an untouched row draws nothing');
});

test('the cursor cell is split out of the run it lands in', async (t) => {
  const emulator = createEmulator({ cols: 12, rows: 1 });
  t.after(() => emulator.dispose());
  await new Promise((resolve) => emulator.write('ab\x1b[31mcdef\x1b[0m', resolve));
  const [row] = emulator.rows({ start: 0, end: 0 });

  assert.equal(shape(rowSegments(row, 3)), 'abc|de' + 'f', 'the run splits into before, cursor and after');
  assert.equal(shape(rowSegments(row, 0)), '|ab' + 'cdef', 'a cursor at the start has no piece before it');
  assert.equal(shape(rowSegments(row, 5)), 'abcde|f', 'a cursor at the end has no piece after it');

  const split = rowSegments(row, 3);
  const cursor = split.find((segment) => segment.cursor);
  assert.equal(cursor.text, 'd');
  assert.equal(cursor.run.fg, 1, 'the cursor piece keeps the styling underneath it');
});

test('a cursor past the written text pads the row out to it', async (t) => {
  const emulator = createEmulator({ cols: 12, rows: 1 });
  t.after(() => emulator.dispose());
  await new Promise((resolve) => emulator.write('ok', resolve));
  const [row] = emulator.rows({ start: 0, end: 0 });

  const segments = rowSegments(row, 4);
  assert.equal(shape(segments), 'ok  | ', 'the gap is real blank cells and the cursor sits on the next one');
  assert.equal(segments[segments.length - 1].cursor, true);

  const blank = emulator.rows({ start: 0, end: 0 })[0];
  assert.equal(shape(rowSegments({ ...blank, text: '', trimmed: 0, runs: [] }, 2)), '  | ',
    'an empty row still shows where the cursor is');
  assert.deepEqual(rowSegments(null, 3), []);
});
