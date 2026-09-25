import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';

import {
  PREDICT_BACKSPACE, PREDICT_CHAR, PREDICT_TYPING_KEY, createTypingPredictor, getPredictTypingPreference,
  predictKeystroke, predictableKey, setPredictTypingPreference,
} from './predict-typing.js';

const { Terminal } = headless;

function terminalWith(screen, { cols = 40, rows = 6 } = {}) {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true });
  return new Promise(resolve => terminal.write(screen, () => resolve(terminal)));
}
const write = (terminal, data) => new Promise(resolve => terminal.write(data, resolve));
const memoryStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
};
function dimCells(terminal) {
  const buffer = terminal.buffer.active;
  const line = buffer.getLine(buffer.baseY + buffer.cursorY);
  const dim = [];
  for (let x = 0; x < terminal.cols; x++) if (line.getCell(x).isDim()) dim.push(x);
  return dim;
}

test('only single printable characters and backspace are predictable keys', () => {
  assert.equal(predictableKey('a'), 'char');
  assert.equal(predictableKey(' '), 'char');
  assert.equal(predictableKey('é'), 'char');
  assert.equal(predictableKey('\x7f'), 'backspace');
  assert.equal(predictableKey('\b'), 'backspace');
  for (const key of ['\r', '\n', '\t', '\x1b', '\x03', '\x1b[A', '\x1bOA', 'ab', '', '\x9b', '\u0301', '中', '😀']) {
    assert.equal(predictableKey(key), null, JSON.stringify(key));
  }
});

test('a character on the Claude and Codex prompt lines is predicted with the exact bytes', async () => {
  const claude = await terminalWith('\x1b[2;1H❯ hi');
  assert.deepEqual(predictKeystroke(claude, 'x'), { kind: 'char', inputStart: 2, bytes: '\x1b7\x1b[2;4mx\x1b8\x1b[1C' });
  const codex = await terminalWith('› hi');
  assert.equal(predictKeystroke(codex, 'x').bytes, PREDICT_CHAR('x'));
  const padded = await terminalWith('❯\u00a0');
  assert.equal(predictKeystroke(padded, 'x').bytes, PREDICT_CHAR('x'));
});

test('backspace is predicted only past the first input column', async () => {
  const typed = await terminalWith('❯ hi');
  assert.deepEqual(predictKeystroke(typed, '\x7f'), { kind: 'backspace', inputStart: 2, bytes: '\x1b7\x1b[1D \x1b8\x1b[1D' });
  assert.equal(PREDICT_BACKSPACE, '\x1b7\x1b[1D \x1b8\x1b[1D');
  const empty = await terminalWith('❯ ');
  assert.equal(predictKeystroke(empty, '\x7f'), null);
  assert.equal(predictKeystroke(empty, 'a').kind, 'char');
});

test('a dim placeholder after the cursor is cleared before the first predicted character', async () => {
  const terminal = await terminalWith('❯ \x1b[7mT\x1b[0m\x1b[2mry "fix the tests"\x1b[0m\x1b[1;3H');
  const decision = predictKeystroke(terminal, 'f');
  assert.equal(decision.bytes, '\x1b7\x1b[K\x1b[2;4mf\x1b8\x1b[1C');
  await write(terminal, decision.bytes);
  const line = terminal.buffer.active.getLine(0).translateToString(true);
  assert.equal(line, '❯ f');
  assert.equal(terminal.buffer.active.cursorX, 3);
});

test('nothing is predicted off the prompt, in menus, mid-line, near the margin, on the alternate screen or while composing', async () => {
  const shell = await terminalWith('$ ls');
  assert.equal(predictKeystroke(shell, 'a'), null, 'a shell prompt has no agent marker');
  const menu = await terminalWith('❯ 1. Yes, proceed');
  assert.equal(predictKeystroke(menu, '2'), null, 'a highlighted menu choice is not the input line');
  const early = await terminalWith('❯ hi\x1b[1;2H');
  assert.equal(predictKeystroke(early, 'a'), null, 'the cursor must be past the marker and its space');
  const middle = await terminalWith('❯ hello\x1b[1;5H');
  assert.equal(predictKeystroke(middle, 'a'), null, 'editing inside the text is left to the agent');
  const margin = await terminalWith(`❯ ${'x'.repeat(35)}`, { cols: 40 });
  assert.equal(margin.buffer.active.cursorX, 37);
  assert.equal(predictKeystroke(margin, 'a'), null, 'a prediction never wraps');
  const room = await terminalWith(`❯ ${'x'.repeat(34)}`, { cols: 40 });
  assert.equal(predictKeystroke(room, 'a').kind, 'char');
  assert.equal(predictKeystroke(room, 'a', { extraColumns: 1 }), null, 'unparsed predictions count toward the margin');
  const alternate = await terminalWith('\x1b[?1049h❯ hi');
  assert.equal(alternate.buffer.active.type, 'alternate');
  assert.equal(predictKeystroke(alternate, 'a'), null);
  const prompt = await terminalWith('❯ hi');
  assert.equal(predictKeystroke(prompt, 'a', { composing: true }), null);
  assert.equal(predictKeystroke(prompt, '\r'), null);
  assert.equal(predictKeystroke(prompt, 'ab'), null, 'a paste goes through unpredicted');
  prompt.hasSelection = () => true;
  assert.equal(predictKeystroke(prompt, 'a'), null, 'a selection is not disturbed');
});

test('the prompt row is found below scrollback', async () => {
  const terminal = await terminalWith(`${'line\r\n'.repeat(20)}❯ hi`, { rows: 4 });
  assert.ok(terminal.buffer.active.baseY > 0);
  assert.equal(predictKeystroke(terminal, 'a').kind, 'char');
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
    const predictor = createTypingPredictor({ terminal, remote: () => remote, mode: () => mode, now: () => clock });
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

test('the agent redraw replaces the prediction and leaves no dim cells', async () => {
  const terminal = await terminalWith('❯ ');
  let clock = 0;
  const predictor = createTypingPredictor({ terminal, remote: () => true, mode: () => 'on', now: () => clock });
  assert.equal(predictor.keystroke('x'), true);
  await write(terminal, '');
  assert.deepEqual(dimCells(terminal), [2], 'the guess is dim until the echo lands');
  assert.ok(terminal.buffer.active.getLine(0).getCell(2).isUnderline());
  assert.equal(predictor.pending, 1);
  clock = 140;
  await write(terminal, '\r❯ x\x1b[K');
  predictor.outputParsed();
  assert.deepEqual(dimCells(terminal), []);
  assert.ok(!terminal.buffer.active.getLine(0).getCell(2).isUnderline());
  assert.equal(terminal.buffer.active.cursorX, 3);
  assert.equal(predictor.pending, 0, 'output that changes the prompt line confirms the keystroke');
});

test('output elsewhere on the screen does not count as the echo', async () => {
  const terminal = await terminalWith('status\r\n❯ ');
  let clock = 0;
  const predictor = createTypingPredictor({ terminal, remote: () => true, mode: () => 'auto', now: () => clock });
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
  const marks = [];
  for (let x = 0; x < terminal.cols; x++) {
    const cell = line.getCell(x);
    if (cell.isDim() && cell.isUnderline()) marks.push(x);
  }
  return { text: line.translateToString(true), cursor: terminal.buffer.active.cursorX, marks };
}

test('a whole-line redraw for an earlier keystroke keeps the later guesses on screen', async () => {
  const terminal = await terminalWith('❯ ');
  let clock = 0;
  const predictor = createTypingPredictor({ terminal, remote: () => true, mode: () => 'on', now: () => clock });
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
  await write(terminal, '\r❯ ab\x1b[K');
  predictor.outputParsed();
  await write(terminal, '');
  assert.deepEqual(lineState(terminal), { text: '❯ ab', cursor: 4, marks: [] });
  assert.equal(predictor.pending, 0);
});

test('an agent that redraws only changed cells confirms each guess without a redraw', async () => {
  const terminal = await terminalWith('› ');
  let clock = 0;
  const predictor = createTypingPredictor({ terminal, remote: () => true, mode: () => 'on', now: () => clock });
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
  const predictor = createTypingPredictor({ terminal, remote: () => true, mode: () => 'auto', now: () => clock });
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
  const predictor = createTypingPredictor({ terminal, remote: () => true, mode: () => 'on', now: () => 0 });
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
  const predictor = createTypingPredictor({ terminal, remote: () => true, mode: () => 'on', now: () => 0 });
  predictor.keystroke('a');
  await write(terminal, '');
  await write(terminal, '\r\x1b[K');
  predictor.outputParsed(false);
  assert.equal(predictor.pending, 1);
  await write(terminal, '❯ a');
  predictor.outputParsed(true);
  assert.equal(predictor.pending, 0);
});
