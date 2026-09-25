import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';

import {
  PREDICTED_CELL_CLASS, PREDICT_BACKSPACE, PREDICT_CHAR, PREDICT_TYPING_KEY, createTypingPredictor, getPredictTypingPreference,
  predictKeystroke, predictableKey, setPredictTypingPreference,
} from './predict-typing.js';

const { Terminal } = headless;
// The agent is Claude unless a test says otherwise.
const predict = (terminal, data, options = {}) => predictKeystroke(terminal, data, { agent: 'claude', ...options });

// The headless xterm has markers but no decorations; the console's xterm draws
// them. This stands in for it and keeps the live ones, so a test can see which
// cells carry the unconfirmed overlay.
function stubDecorations(terminal) {
  const live = new Set();
  terminal.registerDecoration = ({ marker, x, width, layer }) => {
    const classes = new Set();
    const decoration = {
      marker, x, width, layer, classes,
      onRender(listener) { listener({ classList: { add: (name) => classes.add(name) } }); return { dispose() {} }; },
      dispose() { live.delete(decoration); },
    };
    live.add(decoration);
    return decoration;
  };
  terminal.liveDecorations = live;
  return terminal;
}
function terminalWith(screen, { cols = 40, rows = 6, decorations = true } = {}) {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true });
  if (decorations) stubDecorations(terminal);
  return new Promise(resolve => terminal.write(screen, () => resolve(terminal)));
}
const write = (terminal, data) => new Promise(resolve => terminal.write(data, resolve));
const memoryStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
};
// The columns on a row that carry the unconfirmed overlay.
function markedColumns(terminal, row = 0) {
  return [...terminal.liveDecorations].filter((decoration) => decoration.marker.line === row)
    .map((decoration) => decoration.x).sort((a, b) => a - b);
}

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

test('a character on the Claude and Codex prompt lines is predicted with the exact bytes', async () => {
  const claude = await terminalWith('\x1b[2;1H❯ hi');
  assert.deepEqual(predict(claude, 'x'), { kind: 'char', inputStart: 2, bytes: 'x' });
  const codex = await terminalWith('› hi');
  assert.equal(predict(codex, 'x', { agent: 'codex' }).bytes, PREDICT_CHAR('x'));
  assert.equal(predict(codex, 'x'), null, 'Claude is matched only by its own marker');
  assert.equal(predict(claude, 'x', { agent: 'codex' }), null, 'Codex is matched only by its own marker');
  const padded = await terminalWith('❯\u00a0');
  assert.equal(predict(padded, 'x').bytes, PREDICT_CHAR('x'));
});

test('backspace is predicted only past the first input column', async () => {
  const typed = await terminalWith('❯ hi');
  assert.deepEqual(predict(typed, '\x7f'), { kind: 'backspace', inputStart: 2, bytes: '\x1b[1D \x1b[1D' });
  assert.equal(PREDICT_BACKSPACE, '\x1b[1D \x1b[1D');
  const empty = await terminalWith('❯ ');
  assert.equal(predict(empty, '\x7f'), null);
  assert.equal(predict(empty, 'a').kind, 'char');
});

test('a dim placeholder after the cursor is cleared before the first predicted character', async () => {
  const terminal = await terminalWith('❯ \x1b[7mT\x1b[0m\x1b[2mry "fix the tests"\x1b[0m\x1b[1;3H');
  const decision = predict(terminal, 'f');
  assert.equal(decision.bytes, '\x1b[Kf');
  await write(terminal, decision.bytes);
  const line = terminal.buffer.active.getLine(0).translateToString(true);
  assert.equal(line, '❯ f');
  assert.equal(terminal.buffer.active.cursorX, 3);
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
  assert.equal(predict(room, 'a', { extraColumns: 1 }), null, 'unparsed predictions count toward the margin');
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
    for (const ch of 'abcdefgh') {
      drawn.push(predictor.keystroke(ch));
      await write(terminal, '');
      clock += echo;
      // The agent's echo: the whole input line redrawn with the text so far.
      const typed = terminal.buffer.active.getLine(0).translateToString(true).slice(2).replace(/\s+$/, '');
      const text = drawn.at(-1) ? typed : typed + ch;
      await write(terminal, `\r❯ ${text}\x1b[K`);
      predictor.outputParsed();
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

test('the agent redraw replaces the prediction and leaves no overlay', async () => {
  const terminal = await terminalWith('❯ ');
  let clock = 0;
  const predictor = createTypingPredictor({ terminal, agent: () => 'claude', remote: () => true, mode: () => 'on', now: () => clock });
  assert.equal(predictor.keystroke('x'), true);
  await write(terminal, '');
  assert.deepEqual(markedColumns(terminal), [2], 'the guess carries the overlay until the echo lands');
  const [decoration] = terminal.liveDecorations;
  assert.deepEqual([decoration.width, decoration.layer, [...decoration.classes]], [1, 'top', [PREDICTED_CELL_CLASS]]);
  const cell = terminal.buffer.active.getLine(0).getCell(2);
  assert.ok(!cell.isDim() && !cell.isUnderline(), 'the guess itself is written plain');
  assert.equal(predictor.pending, 1);
  clock = 140;
  await write(terminal, '\r❯ x\x1b[K');
  predictor.outputParsed();
  assert.deepEqual(markedColumns(terminal), []);
  assert.equal(terminal.buffer.active.cursorX, 3);
  assert.equal(predictor.pending, 0, 'output that changes the prompt line confirms the keystroke');
});

test('output elsewhere on the screen does not count as the echo', async () => {
  const terminal = await terminalWith('status\r\n❯ ');
  let clock = 0;
  const predictor = createTypingPredictor({ terminal, agent: () => 'claude', remote: () => true, mode: () => 'auto', now: () => clock });
  predictor.keystroke('x');
  await write(terminal, '');
  clock = 30;
  await write(terminal, '\x1b7\x1b[1;1Hspinner\x1b8');
  predictor.outputParsed();
  assert.equal(predictor.pending, 1);
  clock = 90;
  await write(terminal, '\r❯ x\x1b[K');
  predictor.outputParsed();
  assert.equal(predictor.pending, 0);
});

function lineState(terminal) {
  const line = terminal.buffer.active.getLine(0);
  return { text: line.translateToString(true), cursor: terminal.buffer.active.cursorX, marks: markedColumns(terminal) };
}

test('a whole-line redraw for an earlier keystroke keeps the later guesses on screen', async () => {
  const terminal = await terminalWith('❯ ');
  let clock = 0;
  const predictor = createTypingPredictor({ terminal, agent: () => 'claude', remote: () => true, mode: () => 'on', now: () => clock });
  predictor.keystroke('a');
  clock = 60;
  predictor.keystroke('b');
  await write(terminal, '');
  assert.deepEqual(lineState(terminal), { text: '❯ ab', cursor: 4, marks: [2, 3] });
  clock = 140;
  // The agent has only seen `a`: its redraw erases the guess for `b`.
  await write(terminal, '\r❯ a\x1b[K');
  predictor.outputParsed();
  await write(terminal, '');
  assert.deepEqual(lineState(terminal), { text: '❯ ab', cursor: 4, marks: [3] }, 'b is drawn again');
  assert.equal(predictor.pending, 1);
  clock = 200;
  // The echo redraws exactly what the guesses show; its redraw of the row is what
  // confirms it.
  await write(terminal, '\r❯ ab\x1b[K');
  predictor.outputParsed();
  await write(terminal, '');
  assert.deepEqual(lineState(terminal), { text: '❯ ab', cursor: 4, marks: [] });
  assert.equal(predictor.pending, 0);
});

test('an agent that redraws only changed cells confirms each guess without a redraw', async () => {
  const terminal = await terminalWith('› ');
  let clock = 0;
  const predictor = createTypingPredictor({ terminal, agent: () => 'codex', remote: () => true, mode: () => 'on', now: () => clock });
  predictor.keystroke('a');
  predictor.keystroke('b');
  await write(terminal, '');
  clock = 100;
  await write(terminal, '\x1b[1;3H\x1b[0ma\x1b[1;4H');
  predictor.outputParsed();
  await write(terminal, '');
  assert.deepEqual(lineState(terminal), { text: '› ab', cursor: 4, marks: [3] },
    'the cursor steps over the guess the agent left in place');
  assert.equal(predictor.pending, 1);
  predictor.keystroke('c');
  await write(terminal, '');
  assert.deepEqual(lineState(terminal), { text: '› abc', cursor: 5, marks: [3, 4] });
  await write(terminal, '\x1b[1;4H\x1b[0mb\x1b[1;5H');
  predictor.outputParsed();
  await write(terminal, '');
  assert.deepEqual(lineState(terminal), { text: '› abc', cursor: 5, marks: [4] });
  assert.equal(predictor.pending, 1);
});

test('one render that answers several keystrokes confirms them all', async () => {
  const terminal = await terminalWith('❯ ');
  let clock = 0;
  const predictor = createTypingPredictor({ terminal, agent: () => 'claude', remote: () => true, mode: () => 'auto', now: () => clock });
  for (const ch of 'abc') predictor.keystroke(ch);
  clock = 120;
  await write(terminal, '\r❯ abc\x1b[K');
  predictor.outputParsed();
  assert.equal(predictor.pending, 0);
  assert.equal(predictor.echoMs(), 120);
  assert.equal(predictor.enabled(), true);
});

test('a render that is not an echo ends the chain without drawing anything', async () => {
  const terminal = await terminalWith('❯ ');
  const predictor = createTypingPredictor({ terminal, agent: () => 'claude', remote: () => true, mode: () => 'on', now: () => 0 });
  predictor.keystroke('/');
  predictor.keystroke('m');
  await write(terminal, '');
  await write(terminal, '\r❯ /model \x1b[K');
  predictor.outputParsed();
  await write(terminal, '');
  assert.equal(predictor.pending, 0);
  assert.deepEqual(lineState(terminal), { text: '❯ /model ', cursor: 9, marks: [] });
});

test('a split render is not read until its last chunk has parsed', async () => {
  const terminal = await terminalWith('❯ ');
  const predictor = createTypingPredictor({ terminal, agent: () => 'claude', remote: () => true, mode: () => 'on', now: () => 0 });
  predictor.keystroke('a');
  await write(terminal, '');
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
    const predictor = createTypingPredictor({ terminal, agent: () => agent, remote: () => true, mode: () => 'on', now: () => clock });
    for (const ch of 'abcd') {
      assert.equal(predictor.keystroke(ch), false);
      assert.equal(predictor.pending, 0, 'nothing is recorded to measure');
      await write(terminal, ch);
      clock += 150;
      predictor.outputParsed();
    }
    assert.equal(predictor.echoMs(), null);
    assert.equal(terminal.buffer.active.getLine(0).translateToString(true), '❯ abcd', 'the shell echo is never doubled');
  }
});

test('a burst that repeats a state is acknowledged in order and a deleted character never returns', async () => {
  const terminal = await terminalWith('❯ ');
  let clock = 0;
  const predictor = createTypingPredictor({ terminal, agent: () => 'claude', remote: () => true, mode: () => 'on', now: () => clock });
  for (const key of ['a', 'b', '\x7f']) predictor.keystroke(key);
  await write(terminal, '');
  // The Backspace guess blanks the b cell with a space.
  assert.deepEqual(lineState(terminal), { text: '❯ a ', cursor: 3, marks: [2] });
  const redraw = async (text) => {
    clock += 50;
    await write(terminal, `\r❯ ${text}\x1b[K`);
    predictor.outputParsed();
    await write(terminal, '');
  };
  await redraw('a');
  assert.equal(predictor.pending, 2, 'only the first keystroke is acknowledged');
  assert.deepEqual(lineState(terminal), { text: '❯ a', cursor: 3, marks: [] }, 'b is not drawn again');
  await redraw('ab');
  assert.equal(predictor.pending, 1);
  await redraw('a');
  assert.equal(predictor.pending, 0);
  assert.deepEqual(lineState(terminal), { text: '❯ a', cursor: 3, marks: [] }, 'the deleted b stays deleted');
  predictor.keystroke('c');
  await write(terminal, '');
  assert.deepEqual(lineState(terminal), { text: '❯ ac', cursor: 4, marks: [3] });
});

test('a prediction leaves the saved cursor alone', async () => {
  const terminal = await terminalWith('status\r\n❯ ');
  // The agent saves its cursor on the first row, then parks it in the input box.
  await write(terminal, '\x1b[1;3H\x1b7\x1b[2;3H');
  const predictor = createTypingPredictor({ terminal, agent: () => 'claude', remote: () => true, mode: () => 'on', now: () => 0 });
  assert.equal(predictor.keystroke('x'), true);
  predictor.keystroke('\x7f');
  predictor.keystroke('y');
  await write(terminal, '');
  assert.equal(terminal.buffer.active.getLine(1).getCell(2).getChars(), 'y');
  assert.deepEqual(markedColumns(terminal, 1), [2], 'the Backspace guess took the overlay off the blanked x');
  await write(terminal, '\x1b8');
  assert.deepEqual([terminal.buffer.active.cursorY, terminal.buffer.active.cursorX], [0, 2],
    'the agent\'s restore lands where it saved, not at the guess');
});

test('a prediction leaves the active attributes as the agent set them', async () => {
  const terminal = await terminalWith('❯ ');
  // The agent turns on bold and underline and relies on them persisting.
  await write(terminal, '\x1b[1;4m');
  const predictor = createTypingPredictor({ terminal, agent: () => 'claude', remote: () => true, mode: () => 'on', now: () => 0 });
  assert.equal(predictor.keystroke('x'), true);
  assert.equal(predictor.keystroke('\x7f'), true);
  assert.equal(predictor.keystroke('y'), true);
  await write(terminal, '');
  await write(terminal, 'z');
  const cell = terminal.buffer.active.getLine(0).getCell(3);
  assert.equal(cell.getChars(), 'z');
  assert.ok(cell.isBold() && cell.isUnderline() && !cell.isDim(), 'the agent\'s next character is still bold and underlined');
});

test('without decorations a guess is drawn unmarked and nothing is left to dispose', async () => {
  const terminal = await terminalWith('❯ ', { decorations: false });
  assert.equal(typeof terminal.registerDecoration, 'undefined');
  const predictor = createTypingPredictor({ terminal, agent: () => 'claude', remote: () => true, mode: () => 'on', now: () => 0 });
  assert.equal(predictor.keystroke('x'), true);
  await write(terminal, '');
  assert.equal(terminal.buffer.active.getLine(0).translateToString(true), '❯ x');
  assert.equal(predictor.marked, 0);
  predictor.dispose();
  assert.equal(predictor.pending, 0);
});

test('every overlay is disposed on expiry, on a render that is not an echo, and on dispose', async () => {
  const terminal = await terminalWith('❯ ');
  let clock = 0;
  const predictor = createTypingPredictor({ terminal, agent: () => 'claude', remote: () => true, mode: () => 'on', now: () => clock });
  predictor.keystroke('a');
  predictor.keystroke('b');
  await write(terminal, '');
  assert.equal(terminal.liveDecorations.size, 2);
  clock = 6001;
  await write(terminal, '\x1b[1;1H\x1b[2K❯ ab\x1b[1;5H');
  predictor.outputParsed();
  assert.equal(terminal.liveDecorations.size, 0, 'expired guesses lose their overlay');

  predictor.keystroke('c');
  await write(terminal, '');
  assert.equal(terminal.liveDecorations.size, 1);
  await write(terminal, '\r❯ something else\x1b[K');
  predictor.outputParsed();
  assert.equal(terminal.liveDecorations.size, 0, 'a render that is not an echo takes the overlays with the chain');

  predictor.keystroke('d');
  await write(terminal, '');
  assert.equal(terminal.liveDecorations.size, 1);
  predictor.dispose();
  assert.equal(terminal.liveDecorations.size, 0, 'detaching the terminal disposes every overlay');
});

test('a local Backspace guess is never read as the agent\'s echo', async () => {
  const terminal = await terminalWith('status\r\n❯ ');
  let clock = 0;
  const predictor = createTypingPredictor({ terminal, agent: () => 'claude', remote: () => true, mode: () => 'on', now: () => clock });
  predictor.outputParsed();
  for (const key of ['a', 'b', '\x7f']) predictor.keystroke(key);
  await write(terminal, '');
  clock += 40;
  await write(terminal, '\x1b7\x1b[1;1Hspin\x1b8');
  predictor.outputParsed();
  assert.equal(predictor.pending, 3, 'the line the guesses left is not an echo of any of them');
  clock += 40;
  await write(terminal, '\r❯ a\x1b[K');
  predictor.outputParsed();
  assert.equal(predictor.pending, 2, 'the real redraw of a confirms only a');
  await write(terminal, '\r❯ ab\x1b[K');
  predictor.outputParsed();
  assert.equal(predictor.pending, 1);
  await write(terminal, '\r❯ a\x1b[K');
  predictor.outputParsed();
  assert.equal(predictor.pending, 0);
});

test('output that leaves the prompt line and cursor as they were confirms nothing', async () => {
  const terminal = await terminalWith('status\r\n❯ ');
  const predictor = createTypingPredictor({ terminal, agent: () => 'claude', remote: () => true, mode: () => 'auto', now: () => 0 });
  predictor.outputParsed();
  predictor.keystroke('a');
  await write(terminal, '');
  // Not drawn, so the line is unchanged; a spinner elsewhere is not the echo.
  await write(terminal, '\x1b[1;1Hspin\x1b[2;3H');
  predictor.outputParsed();
  assert.equal(predictor.pending, 1);
  await write(terminal, '\r❯ a\x1b[K');
  predictor.outputParsed();
  assert.equal(predictor.pending, 0);
});

test('a line still at the state before the oldest pending keystroke confirms none of the later ones', async () => {
  const terminal = await terminalWith('status\r\n❯ ');
  let clock = 0;
  const predictor = createTypingPredictor({ terminal, agent: () => 'claude', remote: () => true, mode: () => 'on', now: () => clock });
  for (const key of ['a', 'b', '\x7f']) predictor.keystroke(key);
  await write(terminal, '');
  const settle = async (bytes) => {
    clock += 40;
    await write(terminal, bytes);
    predictor.outputParsed();
  };
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

test('keystrokes left unanswered past the stale limit expire without a sample', async () => {
  const terminal = await terminalWith('❯ ');
  let clock = 0;
  const predictor = createTypingPredictor({ terminal, agent: () => 'claude', remote: () => true, mode: () => 'auto', now: () => clock });
  for (const ch of 'abc') predictor.keystroke(ch);
  clock = 6001;
  await write(terminal, '\r❯ abc\x1b[K');
  predictor.outputParsed();
  assert.equal(predictor.pending, 0);
  assert.equal(predictor.echoMs(), null, 'no sample was recorded');
  assert.equal(predictor.enabled(), false, 'auto stays off');
});
