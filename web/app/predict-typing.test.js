import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';

import {
  PREDICTED_BLANK_CLASS, PREDICTED_CELL_CLASS, PREDICTED_CURSOR_CLASS, PREDICT_TYPING_KEY, createTypingPredictor,
  getPredictTypingPreference, predictKeystroke, predictableKey, setPredictTypingPreference,
} from './predict-typing.js';

const { Terminal } = headless;
// The agent is Claude unless a test says otherwise.
const predict = (terminal, data, options = {}) => predictKeystroke(terminal, data, { agent: 'claude', ...options });

// The headless xterm has markers but no decorations; the console's xterm draws
// them. This stands in for it and keeps the live ones, so a test can see which
// cells carry an overlay and what it shows.
function stubDecorations(terminal) {
  const live = new Set();
  terminal.registerDecoration = ({ marker, x, width, layer }) => {
    const classes = new Set();
    const element = { classList: { add: (name) => classes.add(name) }, style: { height: '17px' }, textContent: '' };
    const decoration = {
      marker, x, width, layer, classes, element,
      onRender(listener) { listener(element); return { dispose() {} }; },
      dispose() { live.delete(decoration); },
    };
    live.add(decoration);
    return decoration;
  };
  terminal.liveDecorations = live;
  return terminal;
}
// Every write the predictor makes to the terminal is recorded; the pane's output in
// these tests goes through `paneWrite`, which is not. `cursorShown` follows xterm's
// cursor visibility (DECTCEM) from whichever side set it.
async function terminalWith(screen, { cols = 40, rows = 6, decorations = true, scrollback = 1000 } = {}) {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback });
  if (decorations) stubDecorations(terminal);
  terminal.cursorShown = true;
  for (const [final, shown] of [['h', true], ['l', false]]) {
    terminal.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
      if (params.includes(25)) terminal.cursorShown = shown;
      return false;
    });
  }
  const paneWrite = terminal.write.bind(terminal);
  terminal.paneWrite = paneWrite;
  terminal.localWrites = [];
  terminal.write = (data, callback) => { terminal.localWrites.push(data); return paneWrite(data, callback); };
  await new Promise(resolve => paneWrite(screen, resolve));
  return terminal;
}
const write = (terminal, data) => new Promise(resolve => terminal.paneWrite(data, resolve));
const memoryStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
};
const predictorFor = (terminal, options = {}) => createTypingPredictor({
  terminal, agent: () => 'claude', remote: () => true, mode: () => 'on', now: () => 0, ...options,
});

// Frames shaped like Claude Code's own echoes: a cell diff placed with relative
// cursor moves from where it believes the cursor is, the status line four rows
// below the prompt, and the cursor hidden for the frame and shown at its end.
// A letter: back to column 0, down to the status row, CR, then across and up
// to the letter's column, which is absolute because of the CR.
const letterEcho = (text, col) => `\x1b[?25l\x1b[${col}D\x1b[4B\r\x1b[${col}C\x1b[4A${text}\r\r\n\r\n\r\n\r\n\x1b[${col + text.length}C\x1b[4A\x1b[?25h`;
// A trailing space: its cell was already blank, so only the cursor moves, relatively.
const SPACE_ECHO = '\x1b[?25l\x1b[1C\x1b[?25h';
// Backspace over a trailing space: the same, the other way.
const BARE_BACKSPACE_ECHO = '\x1b[?25l\x1b[1D\x1b[?25h';
// Backspace over a character: to the new cursor column, erase to the end of the line.
const backspaceEcho = (col) => `\x1b[?25l\x1b[${col + 1}D\x1b[4B\r\x1b[${col}C\x1b[4A\x1b[K\r\r\n\r\n\r\n\r\n\x1b[${col}C\x1b[4A\x1b[?25h`;

// The predictor never writes anything but cursor hide and show.
const onlyCursorWrites = (terminal) => terminal.localWrites.every((data) => ['', '\x1b[?25l', '\x1b[?25h'].includes(data));

test('only single printable characters and backspace are predictable keys', () => {
  assert.equal(predictableKey('a'), 'char');
  assert.equal(predictableKey(' '), 'char');
  assert.equal(predictableKey('é'), 'char');
  assert.equal(predictableKey('\x7f'), 'backspace');
  assert.equal(predictableKey('\b'), 'backspace');
  assert.equal(predictableKey('ß'), 'char');
  assert.equal(predictableKey('ł'), 'char');
  for (const key of ['\r', '\n', '\t', '\x1b', '\x03', '\x1b[A', '\x1bOA', 'ab', '', '\x9b', '\u00ad', '\u0301',
    '\u05b0', '\u064e', '\u0710', 'Ω', '中', '😀']) {
    assert.equal(predictableKey(key), null, JSON.stringify(key));
  }
});

test('a character on the Claude prompt line is predicted, and nothing else\'s', async () => {
  const claude = await terminalWith('\x1b[2;1H❯ hi');
  assert.deepEqual(predict(claude, 'x'), { kind: 'char', inputStart: 2 });
  const codex = await terminalWith('› hi');
  assert.equal(predict(codex, 'x'), null, 'Claude is matched only by its own marker');
  assert.equal(predict(codex, 'x', { agent: 'codex' }), null, 'a Codex pane is not predicted');
  assert.equal(predict(claude, 'x', { agent: 'codex' }), null);
  const padded = await terminalWith('❯\u00a0');
  assert.equal(predict(padded, 'x').kind, 'char');
});

test('backspace is predicted only past the first input column', async () => {
  const typed = await terminalWith('❯ hi');
  assert.deepEqual(predict(typed, '\x7f'), { kind: 'backspace', inputStart: 2 });
  const empty = await terminalWith('❯ ');
  assert.equal(predict(empty, '\x7f'), null);
  assert.equal(predict(empty, 'a').kind, 'char');
  assert.equal(predict(empty, '\x7f', { extraColumns: 1 }).kind, 'backspace', 'a pending character can be taken back');
});

test('a dim placeholder after the cursor is predicted over and veiled, never erased', async () => {
  const terminal = await terminalWith('❯ \x1b[7mT\x1b[0m\x1b[2mry "fix the tests"\x1b[0m\x1b[1;3H');
  assert.deepEqual(predict(terminal, 'f'), { kind: 'char', inputStart: 2 });
  const predictor = predictorFor(terminal);
  assert.equal(predictor.keystroke('f'), true);
  await write(terminal, '');
  assert.equal(terminal.buffer.active.getLine(0).translateToString(true), '❯ Try "fix the tests"', 'the buffer is the pane\'s');
  assert.deepEqual(predictor.positions(), { cells: [2], blanks: [], cursor: 3 });
  const veil = [...terminal.liveDecorations].find((decoration) => decoration.classes.has(PREDICTED_BLANK_CLASS));
  assert.deepEqual([veil.x, veil.width], [4, 17], 'the rest of the placeholder is covered');
});

test('nothing is predicted off the prompt, in menus, mid-line, near the margin, on the alternate screen or while composing', async () => {
  const shell = await terminalWith('$ ls');
  assert.equal(predict(shell, 'a'), null, 'a shell prompt has no agent marker');
  const menu = await terminalWith('❯ 1. Yes, proceed');
  assert.equal(predict(menu, '2'), null, 'a highlighted menu choice is not the input line');
  const early = await terminalWith('❯ hi\x1b[1;2H');
  assert.equal(predict(early, 'a'), null, 'the cursor must be past the marker and its space');
  const middle = await terminalWith('❯ hello\x1b[1;5H');
  assert.equal(predict(middle, 'a'), null, 'editing inside the text is left to the agent');
  const margin = await terminalWith(`❯ ${'x'.repeat(35)}`, { cols: 40 });
  assert.equal(margin.buffer.active.cursorX, 37);
  assert.equal(predict(margin, 'a'), null, 'a prediction never wraps');
  const room = await terminalWith(`❯ ${'x'.repeat(34)}`, { cols: 40 });
  assert.equal(predict(room, 'a').kind, 'char');
  assert.equal(predict(room, 'a', { extraColumns: 1 }), null, 'pending keystrokes count toward the margin');
  const alternate = await terminalWith('\x1b[?1049h❯ hi');
  assert.equal(alternate.buffer.active.type, 'alternate');
  assert.equal(predict(alternate, 'a'), null);
  const prompt = await terminalWith('❯ hi');
  assert.equal(predict(prompt, 'a', { composing: true }), null);
  assert.equal(predict(prompt, '\r'), null);
  assert.equal(predict(prompt, 'ab'), null, 'a paste goes through unpredicted');
  prompt.hasSelection = () => true;
  assert.equal(predict(prompt, 'a'), null, 'a selection is not disturbed');
});

test('the prompt row is found below scrollback', async () => {
  const terminal = await terminalWith(`${'line\r\n'.repeat(20)}❯ hi`, { rows: 4 });
  assert.ok(terminal.buffer.active.baseY > 0);
  assert.equal(predict(terminal, 'a').kind, 'char');
});

test('the setting defaults to auto and stores only its three values', () => {
  const storage = memoryStorage();
  assert.equal(getPredictTypingPreference(storage), 'auto');
  assert.equal(setPredictTypingPreference('on', storage), true);
  assert.equal(storage.getItem(PREDICT_TYPING_KEY), 'on');
  assert.equal(getPredictTypingPreference(storage), 'on');
  assert.equal(setPredictTypingPreference('sometimes', storage), false);
  assert.equal(getPredictTypingPreference(storage), 'on');
  assert.equal(getPredictTypingPreference(memoryStorage({ [PREDICT_TYPING_KEY]: 'bogus' })), 'auto');
  assert.equal(getPredictTypingPreference({ getItem() { throw new Error('blocked'); } }), 'auto');
});

test('on predicts everywhere, off nowhere, and auto only on a remote pane with a slow echo', async () => {
  let clock = 0;
  const run = async ({ mode, remote, echo }) => {
    const terminal = await terminalWith('❯ ');
    const predictor = createTypingPredictor({ terminal, agent: () => 'claude', remote: () => remote, mode: () => mode, now: () => clock });
    const drawn = [];
    let typed = '';
    for (const ch of 'abcdefgh') {
      drawn.push(predictor.keystroke(ch));
      await write(terminal, '');
      clock += echo;
      typed += ch;
      await write(terminal, letterEcho(ch, 1 + typed.length));
      predictor.outputParsed();
      assert.equal(terminal.buffer.active.getLine(0).translateToString(true), `❯ ${typed}`);
    }
    return { drawn, predictor };
  };
  const on = await run({ mode: 'on', remote: false, echo: 5 });
  assert.ok(on.drawn.every(Boolean));
  const off = await run({ mode: 'off', remote: true, echo: 150 });
  assert.ok(off.drawn.every(value => !value));
  const local = await run({ mode: 'auto', remote: false, echo: 150 });
  assert.ok(local.drawn.every(value => !value), 'auto never predicts on the daemon node');
  const fast = await run({ mode: 'auto', remote: true, echo: 20 });
  assert.ok(fast.drawn.every(value => !value), 'a fast remote echo needs no prediction');
  assert.equal(fast.predictor.echoMs(), 20);
  const slow = await run({ mode: 'auto', remote: true, echo: 150 });
  assert.deepEqual(slow.drawn, [false, false, false, true, true, true, true, true],
    'auto measures three echoes before it starts predicting');
  assert.equal(slow.predictor.echoMs(), 150);
});

test('a guess is an overlay showing the character over an opaque cell, with a stand-in cursor after it', async () => {
  const terminal = await terminalWith('❯ ');
  terminal.options.theme = { background: '#101010', foreground: '#e0e0e0', cursor: '#ffffff', cursorAccent: '#202020' };
  terminal.options.fontFamily = 'Mono Test';
  terminal.options.fontSize = 13;
  const predictor = predictorFor(terminal);
  assert.equal(predictor.keystroke('x'), true);
  await write(terminal, '');
  assert.equal(terminal.buffer.active.getLine(0).translateToString(true), '❯ ', 'nothing is written into the buffer');
  assert.equal(terminal.buffer.active.cursorX, 2, 'and the real cursor has not moved');
  assert.equal(terminal.cursorShown, false, 'the real cursor is hidden while the guess stands');
  const decorations = [...terminal.liveDecorations];
  const cell = decorations.find((decoration) => decoration.classes.has(PREDICTED_CELL_CLASS));
  assert.deepEqual([cell.x, cell.width, cell.layer, cell.marker.line], [2, 1, 'top', 0]);
  assert.equal(cell.element.textContent, 'x');
  assert.deepEqual([cell.element.style.backgroundColor, cell.element.style.color], ['#101010', '#e0e0e0']);
  assert.deepEqual([cell.element.style.fontFamily, cell.element.style.fontSize, cell.element.style.lineHeight], ['Mono Test', '13px', '17px']);
  const cursor = decorations.find((decoration) => decoration.classes.has(PREDICTED_CURSOR_CLASS));
  assert.equal(cursor.x, 3);
  assert.deepEqual([cursor.element.style.backgroundColor, cursor.element.style.color], ['#ffffff', '#202020']);
  assert.equal(predictor.marked, 1);
  assert.equal(predictor.pending, 1);
  await write(terminal, letterEcho('x', 2));
  predictor.outputParsed();
  await write(terminal, '');
  assert.equal(terminal.liveDecorations.size, 0, 'the echo confirms it and every overlay goes');
  assert.equal(predictor.pending, 0);
  assert.equal(terminal.cursorShown, true);
  assert.ok(onlyCursorWrites(terminal));
});

test('typing "ab c" against Claude\'s relative-move echoes never doubles a character', async () => {
  const terminal = await terminalWith('❯ ');
  let clock = 0;
  const predictor = predictorFor(terminal, { now: () => clock });
  const step = async (key, echo, pane, cursorAfter) => {
    const before = terminal.buffer.active.getLine(0).translateToString(true);
    const cursorBefore = terminal.buffer.active.cursorX;
    assert.equal(predictor.keystroke(key), true, JSON.stringify(key));
    await write(terminal, '');
    // The guess is pending: the buffer and real cursor are exactly as the pane left
    // them, and the overlay sits at the pane's cursor.
    assert.equal(terminal.buffer.active.getLine(0).translateToString(true), before);
    assert.equal(terminal.buffer.active.cursorX, cursorBefore);
    assert.deepEqual(predictor.positions(), { cells: [cursorBefore], blanks: [], cursor: cursorBefore + 1 });
    assert.equal(predictor.marked, 1);
    assert.equal(terminal.cursorShown, false);
    clock += 100;
    await write(terminal, echo);
    predictor.outputParsed();
    await write(terminal, '');
    assert.equal(terminal.buffer.active.getLine(0).translateToString(true), pane, 'the line is exactly what the pane sent');
    assert.equal(terminal.buffer.active.cursorX, cursorAfter, 'the cursor is where the pane put it');
    assert.equal(predictor.pending, 0, 'the echo confirmed the guess');
    assert.deepEqual(predictor.positions(), { cells: [], blanks: [], cursor: null });
    assert.equal(terminal.liveDecorations.size, 0);
    assert.equal(terminal.cursorShown, true);
  };
  await step('a', letterEcho('a', 2), '❯ a', 3);
  await step('b', letterEcho('b', 3), '❯ ab', 4);
  // The trailing space's echo is a bare relative move from where the pane has its
  // cursor, which is where xterm's cursor still is.
  await step(' ', SPACE_ECHO, '❯ ab', 5);
  await step('c', letterEcho('c', 5), '❯ ab c', 6);
  assert.equal(terminal.buffer.active.getLine(0).translateToString(true), '❯ ab c');
  assert.ok(onlyCursorWrites(terminal));
  assert.equal(predictor.echoMs(), 100);
});

test('guesses typed ahead of their echoes are laid out again from the pane\'s cursor after each echo', async () => {
  const terminal = await terminalWith('❯ ab');
  const predictor = predictorFor(terminal);
  for (const key of [' ', 'c', 'd']) predictor.keystroke(key);
  await write(terminal, '');
  assert.equal(terminal.buffer.active.getLine(0).translateToString(true), '❯ ab');
  assert.equal(terminal.buffer.active.cursorX, 4);
  assert.deepEqual(predictor.positions(), { cells: [4, 5, 6], blanks: [], cursor: 7 });
  const at = () => [...terminal.liveDecorations].filter((decoration) => decoration.classes.has(PREDICTED_CELL_CLASS))
    .map((decoration) => [decoration.x, decoration.element.textContent]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(at(), [[4, ' '], [5, 'c'], [6, 'd']]);
  await write(terminal, SPACE_ECHO);
  predictor.outputParsed();
  await write(terminal, '');
  assert.equal(terminal.buffer.active.cursorX, 5);
  assert.equal(predictor.pending, 2);
  assert.deepEqual(predictor.positions(), { cells: [5, 6], blanks: [], cursor: 7 });
  assert.deepEqual(at(), [[5, 'c'], [6, 'd']]);
  assert.equal(terminal.cursorShown, false, 'the pane showed its cursor at the end of the frame; it is hidden again');
  await write(terminal, letterEcho('c', 5));
  predictor.outputParsed();
  await write(terminal, '');
  assert.deepEqual(predictor.positions(), { cells: [6], blanks: [], cursor: 7 });
  assert.equal(terminal.cursorShown, false);
  await write(terminal, letterEcho('d', 6));
  predictor.outputParsed();
  await write(terminal, '');
  assert.equal(terminal.buffer.active.getLine(0).translateToString(true), '❯ ab cd');
  assert.equal(terminal.buffer.active.cursorX, 7);
  assert.equal(predictor.pending, 0);
  assert.equal(terminal.liveDecorations.size, 0);
  assert.equal(terminal.cursorShown, true);
  assert.ok(onlyCursorWrites(terminal));
});

test('a fast burst answered by one coalesced echo confirms every keystroke', async () => {
  const terminal = await terminalWith('❯ ');
  let clock = 0;
  const predictor = predictorFor(terminal, { mode: () => 'auto', now: () => clock });
  for (const ch of 'abc') predictor.keystroke(ch);
  clock = 120;
  await write(terminal, letterEcho('abc', 2));
  predictor.outputParsed();
  assert.equal(predictor.pending, 0);
  assert.equal(predictor.echoMs(), 120);
  assert.equal(predictor.enabled(), true);

  const shown = await terminalWith('❯ ');
  const drawn = predictorFor(shown);
  for (const ch of 'xyz') drawn.keystroke(ch);
  await write(shown, '');
  assert.deepEqual(drawn.positions(), { cells: [2, 3, 4], blanks: [], cursor: 5 });
  await write(shown, letterEcho('xyz', 2));
  drawn.outputParsed();
  await write(shown, '');
  assert.equal(drawn.pending, 0);
  assert.equal(shown.liveDecorations.size, 0);
  assert.equal(shown.buffer.active.getLine(0).translateToString(true), '❯ xyz');
});

test('a bare relative move with no guess pending changes nothing', async () => {
  const terminal = await terminalWith('❯ ab');
  const predictor = predictorFor(terminal);
  await write(terminal, SPACE_ECHO);
  predictor.outputParsed();
  await write(terminal, BARE_BACKSPACE_ECHO);
  predictor.outputParsed();
  await write(terminal, '');
  assert.equal(terminal.buffer.active.getLine(0).translateToString(true), '❯ ab');
  assert.equal(terminal.buffer.active.cursorX, 4);
  assert.deepEqual(predictor.positions(), { cells: [], blanks: [], cursor: null });
  assert.equal(predictor.pending, 0);
  assert.equal(terminal.liveDecorations.size, 0);
  assert.deepEqual(terminal.localWrites, [], 'the predictor wrote nothing');
  assert.equal(terminal.cursorShown, true);
});

test('Backspace guesses blank the pane\'s characters and take back guessed ones', async () => {
  const terminal = await terminalWith('❯ ab ');
  const predictor = predictorFor(terminal);
  assert.equal(terminal.buffer.active.cursorX, 5);
  predictor.keystroke('x');
  predictor.keystroke('\x7f');
  await write(terminal, '');
  assert.deepEqual(predictor.positions(), { cells: [], blanks: [], cursor: 5 }, 'the guessed x is taken back');
  assert.equal(predictor.marked, 0);
  predictor.keystroke('\x7f');
  predictor.keystroke('\x7f');
  await write(terminal, '');
  assert.deepEqual(predictor.positions(), { cells: [], blanks: [4], cursor: 3 }, 'the stand-in cursor covers b, a blank covers the space');
  assert.equal(predictor.marked, 1);
  predictor.keystroke('q');
  await write(terminal, '');
  assert.deepEqual(predictor.positions(), { cells: [3], blanks: [], cursor: 4 }, 'q lands where b was');
  const blank = [...terminal.liveDecorations].find((decoration) => decoration.classes.has(PREDICTED_BLANK_CLASS));
  assert.equal(blank, undefined, 'the blank under the stand-in cursor is not drawn');
  assert.equal(terminal.buffer.active.getLine(0).translateToString(true), '❯ ab ', 'the buffer is the pane\'s');

  // The echoes: x, then Backspace over it, over the trailing space (a bare move),
  // over b (an erase), then q.
  await write(terminal, letterEcho('x', 5));
  predictor.outputParsed();
  assert.deepEqual(predictor.positions(), { cells: [3], blanks: [5], cursor: 4 }, 'laid out from the new cursor, a blank covers the echoed x');
  await write(terminal, backspaceEcho(5));
  predictor.outputParsed();
  await write(terminal, BARE_BACKSPACE_ECHO);
  predictor.outputParsed();
  assert.equal(terminal.buffer.active.cursorX, 4);
  assert.deepEqual(predictor.positions(), { cells: [3], blanks: [], cursor: 4 });
  await write(terminal, backspaceEcho(3));
  predictor.outputParsed();
  assert.equal(predictor.pending, 1);
  await write(terminal, letterEcho('q', 3));
  predictor.outputParsed();
  await write(terminal, '');
  assert.equal(predictor.pending, 0);
  assert.equal(terminal.buffer.active.getLine(0).translateToString(true), '❯ aq');
  assert.equal(terminal.liveDecorations.size, 0);
  assert.equal(terminal.cursorShown, true);
  assert.ok(onlyCursorWrites(terminal));
});

test('reset takes every overlay away and puts back the cursor the pane showed', async () => {
  const terminal = await terminalWith('❯ ');
  const predictor = predictorFor(terminal);
  predictor.keystroke('a');
  predictor.keystroke('b');
  await write(terminal, '');
  assert.equal(terminal.cursorShown, false);
  assert.equal(terminal.liveDecorations.size, 3);
  predictor.reset();
  await write(terminal, '');
  assert.equal(terminal.cursorShown, true);
  assert.equal(terminal.liveDecorations.size, 0);
  assert.equal(predictor.pending, 0);

  // A pane that hid its own cursor keeps it hidden.
  await write(terminal, '\x1b[?25l');
  predictor.keystroke('c');
  await write(terminal, '');
  assert.deepEqual(terminal.localWrites, ['', '\x1b[?25l', '', '\x1b[?25h'], 'nothing to hide the second time');
  predictor.reset();
  await write(terminal, '');
  assert.equal(terminal.cursorShown, false);
  assert.deepEqual(terminal.localWrites, ['', '\x1b[?25l', '', '\x1b[?25h']);
});

test('a whole-line redraw for an earlier keystroke keeps the later guess where the pane\'s cursor now is', async () => {
  const terminal = await terminalWith('❯ ');
  let clock = 0;
  const predictor = predictorFor(terminal, { now: () => clock });
  predictor.keystroke('a');
  clock = 60;
  predictor.keystroke('b');
  assert.deepEqual(predictor.positions(), { cells: [2, 3], blanks: [], cursor: 4 });
  clock = 140;
  await write(terminal, '\r❯ a\x1b[K');
  predictor.outputParsed();
  assert.equal(predictor.pending, 1);
  assert.deepEqual(predictor.positions(), { cells: [3], blanks: [], cursor: 4 });
  await write(terminal, '\r❯ ab\x1b[K');
  predictor.outputParsed();
  assert.equal(predictor.pending, 0);
  assert.equal(terminal.liveDecorations.size, 0);
});

test('output elsewhere on the screen does not count as the echo', async () => {
  const terminal = await terminalWith('status\r\n❯ ');
  let clock = 0;
  const predictor = predictorFor(terminal, { mode: () => 'auto', now: () => clock });
  predictor.keystroke('x');
  clock = 30;
  await write(terminal, '\x1b7\x1b[1;1Hspinner\x1b8');
  predictor.outputParsed();
  assert.equal(predictor.pending, 1);
  clock = 90;
  await write(terminal, '\r❯ x\x1b[K');
  predictor.outputParsed();
  assert.equal(predictor.pending, 0);
});

test('a render that is not an echo ends the chain and takes its overlays', async () => {
  const terminal = await terminalWith('❯ ');
  const predictor = predictorFor(terminal);
  predictor.keystroke('/');
  predictor.keystroke('m');
  await write(terminal, '\r❯ /model \x1b[K');
  predictor.outputParsed();
  await write(terminal, '');
  assert.equal(predictor.pending, 0);
  assert.deepEqual(predictor.positions(), { cells: [], blanks: [], cursor: null });
  assert.equal(terminal.liveDecorations.size, 0);
  assert.equal(terminal.cursorShown, true);
});

test('a split render is not read until its last chunk has parsed', async () => {
  const terminal = await terminalWith('❯ ');
  const predictor = predictorFor(terminal);
  predictor.keystroke('a');
  await write(terminal, '\r\x1b[K');
  predictor.outputParsed(false);
  assert.equal(predictor.pending, 1);
  await write(terminal, '❯ a');
  predictor.outputParsed(true);
  assert.equal(predictor.pending, 0);
});

test('a shell pane, or a pane with no agent on record, is never predicted or measured', async () => {
  for (const agent of ['shell', undefined, 'pi', '__proto__']) {
    const terminal = await terminalWith('❯ ');
    assert.equal(predictKeystroke(terminal, 'a', { agent }), null, String(agent));
    let clock = 0;
    const predictor = predictorFor(terminal, { agent: () => agent, now: () => clock });
    for (const ch of 'abcd') {
      assert.equal(predictor.keystroke(ch), false);
      assert.equal(predictor.pending, 0, 'nothing is recorded to measure');
      await write(terminal, ch);
      clock += 150;
      predictor.outputParsed();
    }
    assert.equal(predictor.echoMs(), null);
    assert.equal(terminal.buffer.active.getLine(0).translateToString(true), '❯ abcd', 'the shell echo is never doubled');
    assert.deepEqual(terminal.localWrites, []);
  }
});

test('a Codex pane is not predicted or measured under any setting', async () => {
  for (const mode of ['on', 'auto']) {
    const terminal = await terminalWith('› ');
    let clock = 0;
    const predictor = predictorFor(terminal, { agent: () => 'codex', mode: () => mode, now: () => clock });
    let typed = '';
    for (const ch of 'abcd') {
      assert.equal(predictor.keystroke(ch), false, mode);
      assert.equal(predictor.pending, 0);
      typed += ch;
      clock += 150;
      await write(terminal, `\x1b[1;${2 + typed.length}H${ch}`);
      predictor.outputParsed();
    }
    assert.equal(predictor.echoMs(), null);
    assert.equal(terminal.liveDecorations.size, 0);
  }
});

test('a burst that repeats a state is acknowledged in order and a deleted character never returns', async () => {
  const terminal = await terminalWith('❯ ');
  let clock = 0;
  const predictor = predictorFor(terminal, { now: () => clock });
  for (const key of ['a', 'b', '\x7f']) predictor.keystroke(key);
  assert.deepEqual(predictor.positions(), { cells: [2], blanks: [], cursor: 3 });
  const redraw = async (text) => {
    clock += 50;
    await write(terminal, `\r❯ ${text}\x1b[K`);
    predictor.outputParsed();
  };
  await redraw('a');
  assert.equal(predictor.pending, 2, 'only the first keystroke is acknowledged');
  assert.deepEqual(predictor.positions(), { cells: [], blanks: [], cursor: 3 }, 'b is not shown again');
  await redraw('ab');
  assert.equal(predictor.pending, 1);
  assert.deepEqual(predictor.positions(), { cells: [], blanks: [], cursor: 3 }, 'the stand-in cursor covers the b being deleted');
  await redraw('a');
  assert.equal(predictor.pending, 0);
  assert.deepEqual(predictor.positions(), { cells: [], blanks: [], cursor: null });
  predictor.keystroke('c');
  assert.deepEqual(predictor.positions(), { cells: [3], blanks: [], cursor: 4 });
});

test('a line still at the state before the oldest pending keystroke confirms none of the later ones', async () => {
  const terminal = await terminalWith('status\r\n❯ ');
  let clock = 0;
  const predictor = predictorFor(terminal, { now: () => clock });
  for (const key of ['a', 'b', '\x7f']) predictor.keystroke(key);
  const settle = async (bytes) => {
    clock += 40;
    await write(terminal, bytes);
    predictor.outputParsed();
  };
  await settle('\x1b[1;1Hspin\x1b[2;3H');
  assert.equal(predictor.pending, 3, 'a spinner that leaves the line as it was answers nothing');
  await settle('\r❯ a\x1b[K');
  assert.equal(predictor.pending, 2, 'a is answered; ab and a wait');
  await settle('\x1b[1;1Hspin\x1b[2;4H');
  assert.equal(predictor.pending, 2, 'a spinner redraw is not an echo');
  await settle('\r❯ a\x1b[K\x1b[1;1Hspun\x1b[2;4H');
  assert.equal(predictor.pending, 2, 'a changed screen that still shows a answers neither ab nor the later a');
  await settle('\r❯ ab\x1b[K');
  assert.equal(predictor.pending, 1, 'ab answers only its own keystroke');
  await settle('\r❯ a\x1b[K');
  assert.equal(predictor.pending, 0);
});

test('a spinner that parks the cursor off the prompt row keeps the overlays where they were', async () => {
  const terminal = await terminalWith('status\r\n❯ ');
  const predictor = predictorFor(terminal);
  predictor.keystroke('a');
  predictor.keystroke('b');
  await write(terminal, '\x1b[1;1Hspin');
  predictor.outputParsed();
  assert.equal(predictor.pending, 2);
  assert.deepEqual(predictor.positions(), { cells: [2, 3], blanks: [], cursor: 4 });
  await write(terminal, '\x1b[2;3H');
  predictor.outputParsed();
  assert.deepEqual(predictor.positions(), { cells: [2, 3], blanks: [], cursor: 4 });
  const marked = [...terminal.liveDecorations].map((decoration) => decoration.marker.line);
  assert.ok(marked.every((line) => line === 1), 'the overlays sit on the prompt row');
});

test('keystrokes left unanswered past the stale limit expire without a sample', async () => {
  const terminal = await terminalWith('❯ ');
  let clock = 0;
  const predictor = predictorFor(terminal, { mode: () => 'auto', now: () => clock });
  for (const ch of 'abc') predictor.keystroke(ch);
  clock = 6001;
  await write(terminal, '\r❯ abc\x1b[K');
  predictor.outputParsed();
  assert.equal(predictor.pending, 0);
  assert.equal(predictor.echoMs(), null, 'no sample was recorded');
  assert.equal(predictor.enabled(), false, 'auto stays off');
});

test('without decorations the guesses are tracked, not drawn, and the cursor is still hidden and restored', async () => {
  const terminal = await terminalWith('❯ ', { decorations: false });
  assert.equal(typeof terminal.registerDecoration, 'undefined');
  const predictor = predictorFor(terminal);
  assert.equal(predictor.keystroke('x'), true);
  await write(terminal, '');
  assert.equal(terminal.buffer.active.getLine(0).translateToString(true), '❯ ');
  assert.deepEqual(predictor.positions(), { cells: [2], blanks: [], cursor: 3 });
  assert.equal(predictor.marked, 0);
  assert.equal(terminal.cursorShown, false);
  predictor.dispose();
  await write(terminal, '');
  assert.equal(predictor.pending, 0);
  assert.equal(terminal.cursorShown, true);
});

test('every overlay is disposed on expiry, on a render that is not an echo, and on dispose', async () => {
  const terminal = await terminalWith('❯ ');
  let clock = 0;
  const predictor = predictorFor(terminal, { now: () => clock });
  predictor.keystroke('a');
  predictor.keystroke('b');
  assert.equal(predictor.marked, 2);
  assert.equal(terminal.liveDecorations.size, 3, 'two guesses and the stand-in cursor');
  clock = 6001;
  await write(terminal, '\x1b[1;1H\x1b[2K❯ ab');
  predictor.outputParsed();
  assert.equal(terminal.liveDecorations.size, 0, 'expired guesses lose their overlay');

  predictor.keystroke('c');
  assert.equal(predictor.marked, 1);
  await write(terminal, '\r❯ something else\x1b[K');
  predictor.outputParsed();
  assert.equal(terminal.liveDecorations.size, 0, 'a render that is not an echo takes the overlays with the chain');

  predictor.keystroke('d');
  assert.equal(predictor.marked, 1);
  predictor.dispose();
  assert.equal(terminal.liveDecorations.size, 0, 'detaching the terminal disposes every overlay');
});

test('a chain ended by Enter leaves no overlay and gives the cursor back', async () => {
  const terminal = await terminalWith('❯ ');
  const predictor = predictorFor(terminal);
  assert.equal(predictor.keystroke('a'), true);
  assert.equal(predictor.keystroke('\r'), false);
  await write(terminal, '');
  assert.equal(predictor.pending, 0);
  assert.equal(terminal.liveDecorations.size, 0);
  assert.equal(predictor.marked, 0);
  assert.equal(terminal.cursorShown, true);
});

test('no guess is made or measured while pane output is still queued', async () => {
  const terminal = await terminalWith('❯ ');
  let queued = true;
  const predictor = predictorFor(terminal, { outputQueued: () => queued });
  assert.equal(predictor.keystroke('a'), false);
  assert.equal(predictor.pending, 0, 'nothing is recorded to measure');
  assert.equal(terminal.liveDecorations.size, 0);
  queued = false;
  assert.equal(predictor.keystroke('b'), true);
  assert.equal(predictor.pending, 1);
  assert.deepEqual(predictor.positions(), { cells: [2], blanks: [], cursor: 3 });
});

test('a cursor-position query is answered by xterm with the pane\'s own cursor', async () => {
  const terminal = await terminalWith('❯ ');
  const replies = [];
  terminal.onData((data) => replies.push(data));
  const predictor = predictorFor(terminal);
  predictor.keystroke('a');
  predictor.keystroke('b');
  await write(terminal, '\x1b[6n');
  assert.deepEqual(replies, ['\x1b[1;3R'], 'the guesses never moved it');
});

test('a resize that reflows the prompt row ends the chain, leaves no overlay and gives the cursor back', async () => {
  const terminal = await terminalWith(`${'x'.repeat(30)}\r\n❯ `, { cols: 40 });
  const predictor = predictorFor(terminal);
  predictor.keystroke('a');
  predictor.keystroke('b');
  await write(terminal, '');
  assert.equal(terminal.liveDecorations.size, 3);
  assert.ok([...terminal.liveDecorations].every((decoration) => decoration.marker.line === 1));
  terminal.resize(20, 6);
  await write(terminal, '');
  assert.equal(terminal.buffer.active.baseY + terminal.buffer.active.cursorY, 2, 'the wrapped line above pushed the prompt down');
  assert.equal(predictor.pending, 0);
  assert.equal(terminal.liveDecorations.size, 0, 'no overlay is left on the old row');
  assert.deepEqual(predictor.positions(), { cells: [], blanks: [], cursor: null });
  assert.equal(terminal.cursorShown, true);
  // The next keystroke starts a chain on the row the prompt is on now.
  predictor.keystroke('c');
  assert.ok([...terminal.liveDecorations].every((decoration) => decoration.marker.line === 2));
});

test('a prompt row trimmed out of the scrollback ends the chain even when another prompt takes its index', async () => {
  const terminal = await terminalWith('status\r\n❯ ', { rows: 4, scrollback: 1 });
  const predictor = predictorFor(terminal);
  predictor.keystroke('a');
  await write(terminal, '');
  assert.equal(terminal.liveDecorations.size, 2);
  // The pane scrolls far enough that the scrollback drops lines, then draws a prompt
  // on the line that now has the chain's old index.
  await write(terminal, '\r\n'.repeat(10));
  await write(terminal, '\x1b[1;1H❯ ');
  assert.equal(terminal.buffer.active.baseY + terminal.buffer.active.cursorY, 1);
  predictor.outputParsed();
  await write(terminal, '');
  assert.equal(predictor.pending, 0);
  assert.equal(terminal.liveDecorations.size, 0);
  assert.equal(terminal.cursorShown, true);
});

test('the pane\'s show in the first chunk of a split frame never shows the real cursor beside the stand-in', async () => {
  const terminal = await terminalWith('❯ ');
  const predictor = predictorFor(terminal);
  predictor.keystroke('a');
  predictor.keystroke('b');
  await write(terminal, '');
  assert.equal(terminal.cursorShown, false);
  // The first chunk ends with the pane's show; more of the frame is still queued.
  await write(terminal, letterEcho('a', 2));
  predictor.outputParsed(false);
  assert.equal(terminal.cursorShown, false, 'the show is recorded, not performed, while a guess stands');
  assert.equal(predictor.pending, 2, 'nothing is read before the frame settles');
  await write(terminal, '\x1b[1;4H');
  predictor.outputParsed(true);
  await write(terminal, '');
  assert.equal(predictor.pending, 1);
  assert.equal(terminal.cursorShown, false);
  // A show that carries another mode with it is performed, and hidden again as soon
  // as its chunk has parsed, before the rest of the frame.
  const writes = terminal.localWrites.length;
  await write(terminal, '\x1b[?7;25h');
  assert.equal(terminal.cursorShown, true);
  predictor.outputParsed(false);
  assert.deepEqual(terminal.localWrites.slice(writes), ['', '\x1b[?25l']);
  await write(terminal, '');
  assert.equal(terminal.cursorShown, false);
  // Once the last guess is confirmed the pane's own show is put back.
  await write(terminal, letterEcho('b', 3));
  predictor.outputParsed(true);
  await write(terminal, '');
  assert.equal(predictor.pending, 0);
  assert.equal(terminal.cursorShown, true);
});

test('a chain dropped while pane output is queued restores the cursor only as that output leaves it', async () => {
  const terminal = await terminalWith('❯ ');
  let queued = false;
  const predictor = predictorFor(terminal, { outputQueued: () => queued });
  predictor.keystroke('a');
  await write(terminal, '');
  assert.equal(terminal.cursorShown, false);
  // A pane frame that hides its cursor is queued when the next key arrives.
  queued = true;
  const parsed = write(terminal, '\x1b[?25l\x1b[1;1H\x1b[2K❯ /');
  assert.equal(predictor.keystroke('/'), false);
  assert.equal(predictor.pending, 0);
  assert.equal(terminal.liveDecorations.size, 0);
  const writes = terminal.localWrites.length;
  await parsed;
  queued = false;
  predictor.outputParsed(true);
  await write(terminal, '');
  assert.deepEqual(terminal.localWrites.slice(writes), [], 'no show is written after the pane\'s hide');
  assert.equal(terminal.cursorShown, false, 'the cursor is as the pane last asked');

  // The same with a pane that shows its cursor: it is shown once the output settles.
  predictor.keystroke('x');
  await write(terminal, '\x1b[?25h');
  predictor.outputParsed(true);
  await write(terminal, '');
  assert.equal(terminal.cursorShown, false, 'the guess stands, so the pane\'s show is held');
  queued = true;
  const more = write(terminal, '\x1b[1;1H\x1b[2K❯ /x');
  predictor.keystroke('\r');
  await more;
  assert.equal(terminal.cursorShown, false, 'nothing is shown before the output settles');
  queued = false;
  predictor.outputParsed(true);
  await write(terminal, '');
  assert.equal(terminal.cursorShown, true);
});

test('an alternate screen over the input box ends the chain and gives the cursor back', async () => {
  const terminal = await terminalWith('❯ ');
  const predictor = predictorFor(terminal);
  predictor.keystroke('a');
  await write(terminal, '\x1b[?1049h');
  predictor.outputParsed();
  await write(terminal, '');
  assert.equal(predictor.pending, 0);
  assert.equal(terminal.liveDecorations.size, 0);
  assert.equal(terminal.cursorShown, true);
});
