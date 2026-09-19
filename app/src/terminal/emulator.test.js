'use strict';

// The go/no-go for running xterm's parser on the phone. The fixture is a synthetic
// relay stream (see fixtures/generate.js) chosen to hit what the renderer depends on;
// the expectation is what @xterm/addon-serialize reconstructs from the same bytes,
// which is the same serializer bin/host.js uses for its replay. If these rows match,
// the phone can draw a pane from the raw stream without a WebView.
const assert = require('node:assert/strict');
const test = require('node:test');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const { createEmulator, readLine } = require('./emulator.js');
const {
  fixture, dataFrames, jsonFrames, decodeBase64, expandRun, expectedRuns, sameRun,
} = require('./fixture.js');

const SCROLLBACK = fixture.expected.scrollback || 1000;

// Decoded through the same module the device uses, so a Hermes-only base64 bug would
// show up here rather than on the phone.
const frames = dataFrames();
const control = jsonFrames();

function visibleRows(term) {
  const buffer = term.buffer.active;
  const rows = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    rows.push(line ? line.translateToString(true) : '');
  }
  return rows;
}

// xterm stops a row at the last cell a program wrote, which is not the last non-space
// character: a painted background leaves explicit spaces behind. `trimmed` is the
// emulator's answer to the same question, so the comparison is like for like.
function rowText(row) {
  return row.text.slice(0, row.trimmed);
}

// Frames are handed over one at a time, the way they arrive off the socket, and the
// clock stops once the parser has drained. Awaiting each chunk separately also measures
// xterm's write-queue yielding, so the go/no-go number is the batched one.
async function feed(emulator, { perFrame = false } = {}) {
  const started = process.hrtime.bigint();
  for (const data of frames) {
    if (perFrame) await new Promise((resolve) => emulator.write(data, resolve));
    else emulator.write(data);
  }
  await emulator.flush();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

// A terminal with no private refresh hook, which is what a future xterm could hand us.
class Hookless {
  constructor(options) {
    this.cols = options.cols;
    this.rows = options.rows;
    this.written = [];
    const line = { translateToString: () => '', getCell: (x, cell) => cell };
    this.buffer = {
      active: {
        type: 'normal', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0,
        getLine: () => line,
        getNullCell: () => ({
          getChars: () => ' ', getWidth: () => 1, getCode: () => 0,
          getFgColorMode: () => 0, getBgColorMode: () => 0, getFgColor: () => -1, getBgColor: () => -1,
          isFgPalette: () => false, isBgPalette: () => false, isFgRGB: () => false, isBgRGB: () => false,
          isBold: () => 0, isDim: () => 0, isItalic: () => 0, isUnderline: () => 0, isInverse: () => 0,
        }),
      },
    };
  }

  write(data, done) { this.written.push(data); if (done) done(); }

  dispose() { this.disposed = true; }
}

test('without the private refresh hook every write invalidates the screen', async (t) => {
  const emulator = createEmulator({ cols: 8, rows: 4, Terminal: Hookless });
  t.after(() => emulator.dispose());
  assert.deepEqual(emulator.takeDirty(), [0, 1, 2, 3], 'a fresh screen is entirely dirty');
  assert.deepEqual(emulator.takeDirty(), []);

  await new Promise((resolve) => emulator.write('anything', resolve));
  assert.deepEqual(emulator.takeDirty(), [0, 1, 2, 3],
    'losing the hook costs precision, not the whole dirty signal');

  await new Promise((resolve) => emulator.write('more', resolve));
  assert.deepEqual(emulator.takeDirty(), [0, 1, 2, 3]);
});

test('drain resolves only once the queued writes have been parsed', async (t) => {
  const emulator = createEmulator({ cols: 20, rows: 3 });
  t.after(() => emulator.dispose());
  const order = [];
  emulator.write('\x1b[2J\x1b[Hfirst', () => order.push('parsed'));
  await emulator.drain(() => order.push('drained'));
  assert.deepEqual(order, ['parsed', 'drained']);
  assert.equal(rowText(emulator.rows({ start: 0, end: 0 })[0]), 'first');
});

test('the fixture decodes byte for byte without Buffer', () => {
  // Hermes has no Buffer, so the device decodes the capture with the hand-written
  // routine in fixture.js. Node's own decoder is the check on it.
  for (const frame of fixture.frames) {
    if (frame.kind !== 'binary') continue;
    assert.deepEqual([...decodeBase64(frame.data)], [...Buffer.from(frame.data, 'base64')]);
  }
  assert.deepEqual([...decodeBase64('')], []);
  assert.deepEqual([...decodeBase64('YQ==')], [0x61]);
  assert.deepEqual([...decodeBase64('YWI=')], [0x61, 0x62]);
  assert.deepEqual([...decodeBase64('YWJj')], [0x61, 0x62, 0x63]);
});

test('the fixture is a well formed relay stream', () => {
  assert.equal(control[0].t, 'attached');
  assert.equal(control[0].pane.cols, fixture.cols);
  assert.equal(control[0].pane.rows, fixture.rows);
  assert.ok(control.some((frame) => frame.t === 'replay-end'), 'the stream runs past the replay');
  assert.ok(frames.length > 1, 'the fixture holds live output, not just the replay');
  assert.equal(fixture.expected.rows.length, fixture.rows);
});

test('the emulator reproduces what the serializer sees, row for row', async (t) => {
  const emulator = createEmulator({ cols: fixture.cols, rows: fixture.rows, scrollback: SCROLLBACK });
  t.after(() => emulator.dispose());
  const elapsed = await feed(emulator);

  const reference = new Terminal({
    cols: fixture.cols, rows: fixture.rows, scrollback: SCROLLBACK, allowProposedApi: true,
  });
  const serializer = new SerializeAddon();
  reference.loadAddon(serializer);
  for (const data of frames) await new Promise((resolve) => reference.write(data, resolve));

  const mine = emulator.rows().map(rowText);
  const theirs = visibleRows(reference);
  const diffs = [];
  for (let y = 0; y < theirs.length; y++) if (mine[y] !== theirs[y]) diffs.push(y);
  assert.deepEqual(diffs, [], `rows differ at ${diffs.join(', ')}`);

  // What a fresh terminal replaying host.js's serialization would show: the same
  // screen, which is what makes the baked device expectation trustworthy.
  const replay = new Terminal({
    cols: fixture.cols, rows: fixture.rows, scrollback: SCROLLBACK, allowProposedApi: true,
  });
  await new Promise((resolve) => replay.write(
    serializer.serialize({ scrollback: SCROLLBACK, excludeAltBuffer: false }), resolve,
  ));
  assert.deepEqual(mine, visibleRows(replay));

  // The Spike screen compares against this without a serializer on the device. Text
  // alone would let a broken colour or attribute mapping through, and the fixture goes
  // out of its way to carry palette, 256-colour, truecolour and every attribute, so the
  // runs are part of the expectation too.
  assert.deepEqual(mine, fixture.expected.rows);
  assert.deepEqual(emulator.rows().map((row) => row.runs), expectedRuns());
  assert.equal(emulator.isAlternate(), fixture.expected.alternate);
  assert.deepEqual(emulator.cursor(), fixture.expected.cursor);

  const bytes = frames.reduce((total, data) => total + (data.length || 0), 0);
  const drained = process.hrtime.bigint();
  emulator.rows();
  const rowsMs = Number(process.hrtime.bigint() - drained) / 1e6;
  console.log(`[spike] ${frames.length} frames / ${bytes} bytes parsed in ${elapsed.toFixed(1)} ms `
    + `(${(bytes / 1024 / (elapsed / 1000)).toFixed(0)} KiB/s) into a ${fixture.cols}x${fixture.rows} screen; `
    + `rows() ${rowsMs.toFixed(2)} ms`);
});

test('the fixture parses fast enough to be worth putting on a phone', async (t) => {
  const emulator = createEmulator({ cols: fixture.cols, rows: fixture.rows, scrollback: SCROLLBACK });
  t.after(() => emulator.dispose());
  const perFrame = await feed(emulator, { perFrame: true });
  console.log(`[spike] frame-at-a-time (xterm's write queue yielding included): ${perFrame.toFixed(1)} ms`);
  // A busy pane's output must not take longer to parse than it took to produce. Node is roughly an order
  // of magnitude ahead of Hermes, so the ceiling is loose on purpose: the device run is
  // what decides, this only catches a collapse.
  assert.ok(perFrame < 10000, `parsing 60 s of output took ${perFrame.toFixed(0)} ms`);
});

test('the baked runs describe the styling the fixture sets out to exercise', async (t) => {
  const emulator = createEmulator({ cols: fixture.cols, rows: fixture.rows, scrollback: SCROLLBACK });
  t.after(() => emulator.dispose());
  await feed(emulator);

  const baked = expectedRuns();
  assert.equal(baked.length, fixture.rows);
  const all = baked.flat();
  // If any of these ever stops being true the fixture has drifted and the device
  // verdict has quietly stopped proving what it claims to.
  assert.ok(all.some((run) => typeof run.fg === 'number'), 'a palette foreground');
  assert.ok(all.some((run) => typeof run.fg === 'number' && run.fg > 15), 'a 256-colour foreground');
  assert.ok(all.some((run) => typeof run.fg === 'string' && run.fg.startsWith('#')), 'a truecolour foreground');
  assert.ok(all.some((run) => typeof run.bg === 'string' && run.bg.startsWith('#')), 'a truecolour background');
  assert.ok(all.some((run) => typeof run.bg === 'number'), 'a palette background');
  for (const flag of ['bold', 'dim', 'italic', 'underline', 'inverse']) {
    assert.ok(all.some((run) => run[flag]), `an ${flag} run`);
  }

  // sameRun is what the device compares with; it has to notice each field.
  const [reference] = emulator.rows()[0].runs;
  assert.ok(sameRun(reference, expandRun({ ...reference })));
  for (const [field, value] of [['start', 99], ['end', 99], ['fg', 7], ['bg', '#123456'], ['bold', !reference.bold]]) {
    assert.equal(sameRun(reference, { ...reference, [field]: value }), false, `${field} is compared`);
  }
});

test('every visible row comes back with runs that cover it', async (t) => {
  const emulator = createEmulator({ cols: fixture.cols, rows: fixture.rows, scrollback: SCROLLBACK });
  t.after(() => emulator.dispose());
  await feed(emulator);

  // Cell count and character count are not the same number — a wide glyph is two
  // cells and one character, a combining mark is one cell and two — so the width
  // check is against what xterm itself makes of the row, not against `cols`.
  const reference = new Terminal({
    cols: fixture.cols, rows: fixture.rows, scrollback: SCROLLBACK, allowProposedApi: true,
  });
  for (const data of frames) await new Promise((resolve) => reference.write(data, resolve));
  const buffer = reference.buffer.active;

  const rows = emulator.rows();
  assert.equal(rows.length, fixture.rows);
  let styled = 0;
  let wide = 0;
  for (const [y, row] of rows.entries()) {
    const line = buffer.getLine(buffer.viewportY + y);
    assert.equal(row.text, line.translateToString(false), `row ${y} does not cover the whole line`);
    assert.equal(rowText(row), line.translateToString(true), `row ${y} stops in the wrong place`);
    if (row.text.length !== fixture.cols) wide++;
    assert.ok(row.runs.length > 0, `row ${y} has no runs`);
    assert.equal(row.runs[0].start, 0, `row ${y} does not start at 0`);
    for (let i = 1; i < row.runs.length; i++) {
      assert.equal(row.runs[i].start, row.runs[i - 1].end, `row ${y} run ${i} leaves a gap`);
    }
    assert.equal(row.runs[row.runs.length - 1].end, row.text.length, `row ${y} runs stop short`);
    for (const run of row.runs) {
      assert.ok(run.end > run.start, `row ${y} has an empty run`);
      for (const flag of ['bold', 'dim', 'italic', 'underline', 'inverse']) {
        assert.equal(typeof run[flag], 'boolean');
      }
    }
    if (row.runs.length > 1) styled++;
  }
  assert.ok(styled > 0, 'the fixture carries styling, so some rows must split into runs');
  assert.ok(wide > 0, 'the fixture exercises rows whose cell count and length differ');
});

test('a window of rows can be read without walking the whole screen', async (t) => {
  const emulator = createEmulator({ cols: fixture.cols, rows: fixture.rows, scrollback: SCROLLBACK });
  t.after(() => emulator.dispose());
  await feed(emulator);
  const all = emulator.rows();
  assert.deepEqual(emulator.rows({ start: 3, end: 5 }), all.slice(3, 6));
});

test('dirty rows narrow to what the parser touched', async (t) => {
  const emulator = createEmulator({ cols: 20, rows: 5, scrollback: 100 });
  t.after(() => emulator.dispose());
  await new Promise((resolve) => emulator.write('\x1b[2J\x1b[H', resolve));
  emulator.takeDirty();

  await new Promise((resolve) => emulator.write('\x1b[3;1Hhello', resolve));
  // The parser reports a range, not a set, so it can name rows the cursor only passed
  // over. What matters is that it stays a range around the write and never claims the
  // untouched tail of the screen.
  const touched = emulator.takeDirty();
  assert.ok(touched.includes(2), `row 2 is missing from ${touched.join(', ')}`);
  assert.ok(!touched.includes(4), `row 4 was never touched but appears in ${touched.join(', ')}`);
  assert.deepEqual(emulator.takeDirty(), [], 'taking the dirty set clears it');

  // A scroll moves every row, so the whole viewport is invalidated.
  await new Promise((resolve) => emulator.write('\x1b[5;1H\r\n', resolve));
  assert.deepEqual(emulator.takeDirty(), [0, 1, 2, 3, 4]);
});

test('styling runs carry the colors and attributes a row needs', async (t) => {
  const emulator = createEmulator({ cols: 12, rows: 2 });
  t.after(() => emulator.dispose());
  await new Promise((resolve) => emulator.write('ab\x1b[1;31mcd\x1b[0m\x1b[48;2;0;128;255mef\x1b[0m', resolve));
  const [row] = emulator.rows({ start: 0, end: 0 });
  assert.equal(row.text.slice(0, 6), 'abcdef');
  const [plain, red, blue] = row.runs;
  assert.deepEqual([plain.start, plain.end], [0, 2]);
  assert.equal(plain.fg, null);
  assert.deepEqual([red.start, red.end], [2, 4]);
  assert.equal(red.fg, 1);
  assert.equal(red.bold, true);
  assert.deepEqual([blue.start, blue.end], [4, 6]);
  assert.equal(blue.bg, '#0080ff');
  assert.equal(blue.bold, false);
});

test('a blank line reads as spaces with a single run', () => {
  assert.deepEqual(readLine(null, 4, null), { text: '', runs: [], trimmed: 0 });
});

test('the alternate buffer and cursor are reported for the status line', async (t) => {
  const emulator = createEmulator({ cols: 10, rows: 3 });
  t.after(() => emulator.dispose());
  assert.equal(emulator.isAlternate(), false);
  await new Promise((resolve) => emulator.write('\x1b[?1049h\x1b[2;4H\x1b[?25l', resolve));
  assert.equal(emulator.isAlternate(), true);
  assert.deepEqual(emulator.cursor(), { x: 3, y: 1, visible: false });
  await new Promise((resolve) => emulator.write('\x1b[?25h\x1b[?1049l', resolve));
  assert.equal(emulator.isAlternate(), false);
  assert.equal(emulator.cursor().visible, true);
});

test('scrollback is readable above the viewport, oldest of the window first', async (t) => {
  const emulator = createEmulator({ cols: 8, rows: 3, scrollback: 20 });
  t.after(() => emulator.dispose());
  assert.equal(emulator.scrollbackLength(), 0, 'a fresh screen has nothing above it');
  assert.deepEqual(emulator.scrollbackRows(5, 5), []);

  const lines = ['one', 'two', 'three', 'four', 'five', 'six'];
  await new Promise((resolve) => emulator.write(`${lines.join('\r\n')}`, resolve));
  assert.deepEqual(emulator.rows().map((row) => row.text.slice(0, row.trimmed)), ['four', 'five', 'six']);
  assert.equal(emulator.scrollbackLength(), 3);

  const texts = (rows) => rows.map((row) => row.text.slice(0, row.trimmed));
  assert.deepEqual(texts(emulator.scrollbackRows(2, 2)), ['two', 'three'], 'the window ends at the viewport top');
  assert.deepEqual(texts(emulator.scrollbackRows(3, 3)), ['one', 'two', 'three']);
  assert.deepEqual(texts(emulator.scrollbackRows(3, 2)), ['one', 'two'], 'count clips the far end');
  assert.deepEqual(texts(emulator.scrollbackRows(99, 99)), ['one', 'two', 'three'],
    'asking past the oldest line returns what there is');
  assert.deepEqual(emulator.scrollbackRows(0, 5), [], 'no offset is no window');
  assert.equal(emulator.scrollbackRows(2, 2)[0].runs.length > 0, true, 'scrollback rows carry styling like any row');

  // The alternate screen has a scrollback of its own, which is always empty; the
  // normal buffer's lines are still there when the program exits.
  await new Promise((resolve) => emulator.write('\x1b[?1049h', resolve));
  assert.equal(emulator.scrollbackLength(), 0);
  await new Promise((resolve) => emulator.write('\x1b[?1049l', resolve));
  assert.equal(emulator.scrollbackLength(), 3);
});

test('the key bar can read the modes that decide what a cursor key sends', async (t) => {
  const emulator = createEmulator({ cols: 8, rows: 2 });
  t.after(() => emulator.dispose());
  assert.deepEqual(emulator.modes(), { applicationCursor: false, bracketedPaste: false });
  await new Promise((resolve) => emulator.write('\x1b[?1h\x1b[?2004h', resolve));
  assert.deepEqual(emulator.modes(), { applicationCursor: true, bracketedPaste: true });
  await new Promise((resolve) => emulator.write('\x1b[?1l\x1b[?2004l', resolve));
  assert.deepEqual(emulator.modes(), { applicationCursor: false, bracketedPaste: false });
});

test('scrolled lines keep counting after the buffer starts dropping its oldest', async (t) => {
  const emulator = createEmulator({ cols: 8, rows: 2, scrollback: 3 });
  t.after(() => emulator.dispose());
  assert.equal(emulator.scrolledLines(), 0);

  await new Promise((resolve) => emulator.write('a\r\nb\r\nc\r\n', resolve));
  assert.equal(emulator.scrollbackLength(), 2);
  assert.equal(emulator.scrolledLines(), 2, 'while there is room, the count is the scrollback length');

  await new Promise((resolve) => emulator.write('d\r\ne\r\nf\r\n', resolve));
  assert.equal(emulator.scrollbackLength(), 3, 'the buffer is full and drops its oldest line');
  assert.equal(emulator.scrolledLines(), 5, 'the count still follows what went past');
  assert.deepEqual(
    emulator.scrollbackRows(3, 3).map((row) => row.text.slice(0, row.trimmed)),
    ['c', 'd', 'e'],
    'what is left is the newest lines, in order',
  );
});
