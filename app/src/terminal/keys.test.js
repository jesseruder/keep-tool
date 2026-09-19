'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { encodeKey, encodePaste, encodeText, inputDelta } = require('./keys.js');

test('cursor keys follow the mode the program in the pane chose', () => {
  assert.equal(encodeKey('Up'), '\x1b[A');
  assert.equal(encodeKey('Down'), '\x1b[B');
  assert.equal(encodeKey('Right'), '\x1b[C');
  assert.equal(encodeKey('Left'), '\x1b[D');
  assert.equal(encodeKey('Home'), '\x1b[H');
  assert.equal(encodeKey('End'), '\x1b[F');

  assert.equal(encodeKey('Up', { applicationCursor: true }), '\x1bOA');
  assert.equal(encodeKey('Left', { applicationCursor: true }), '\x1bOD');
  assert.equal(encodeKey('Home', { applicationCursor: true }), '\x1bOH');
  assert.equal(encodeKey('End', { applicationCursor: true }), '\x1bOF');
});

test('the key bar sends the same bytes the daemon key table and the console do', () => {
  assert.equal(encodeKey('Escape'), '\x1b');
  assert.equal(encodeKey('Tab'), '\t');
  assert.equal(encodeKey('Enter'), '\r');
  assert.equal(encodeKey('Backspace'), '\x7f');
  assert.equal(encodeKey('PageUp'), '\x1b[5~');
  assert.equal(encodeKey('PageDown'), '\x1b[6~');
  assert.equal(encodeKey('CtrlC'), '\x03');
  assert.equal(encodeKey('CtrlL'), '\x0c');
  // web/app/terminal.js sends ESC CR for Shift+Enter so Claude Code and Codex insert
  // a newline instead of submitting; the phone must not disagree.
  assert.equal(encodeKey('ShiftEnter'), '\x1b\r');
  assert.equal(encodeKey('nope'), '', 'an unknown label sends nothing rather than a guess');
  assert.equal(encodeKey(''), '');
});

test('the sticky modifiers apply the way a hardware keyboard would', () => {
  assert.equal(encodeText('c', { ctrl: true }), '\x03');
  assert.equal(encodeText('C', { ctrl: true }), '\x03', 'shift does not change the control code');
  assert.equal(encodeText('a', { ctrl: true }), '\x01');
  assert.equal(encodeText(' ', { ctrl: true }), '\x00');
  assert.equal(encodeText('[', { ctrl: true }), '\x1b');
  assert.equal(encodeText('1', { ctrl: true }), '1', 'a key with no control code sends itself');
  assert.equal(encodeText('b', { alt: true }), '\x1bb');
  assert.equal(encodeText('x', { alt: true, ctrl: true }), '\x1b\x18');
  assert.equal(encodeText('hello', { ctrl: true }), '\x08ello', 'a modifier is one keypress, not a mode');
  assert.equal(encodeText('hello'), 'hello');
  assert.equal(encodeText(''), '');
  assert.equal(encodeKey('k', { ctrl: true }), '\x0b', 'a bare character through the key path takes the modifiers too');
});

test('modified keys keep their escape shape', () => {
  assert.equal(encodeKey('Up', { alt: true }), '\x1b\x1b[A');
  assert.equal(encodeKey('Right', { ctrl: true }), '\x1b[1;5C', 'ctrl+arrow is the xterm modifier form');
  assert.equal(encodeKey('Right', { ctrl: true, applicationCursor: true }), '\x1b[1;5C',
    'the modifier form has no SS3 spelling');
  assert.equal(encodeKey('Tab', { alt: true }), '\x1b\t');
});

test('a paste is bracketed only when the program asked for it, and cannot close its own bracket', () => {
  assert.equal(encodePaste('ls -la'), 'ls -la');
  assert.equal(encodePaste('ls -la', { bracketedPaste: true }), '\x1b[200~ls -la\x1b[201~');
  assert.equal(encodePaste('a\x1b[201~rm -rf /', { bracketedPaste: true }), '\x1b[200~arm -rf /\x1b[201~');
  assert.equal(encodePaste('', { bracketedPaste: true }), '');
  assert.equal(encodePaste(null), '');
});

test('the hidden field reports typing, backspaces and replacements as a delta', () => {
  const sentinel = '····';
  assert.deepEqual(inputDelta(sentinel, '····ls'), { backspaces: 0, text: 'ls' });
  assert.deepEqual(inputDelta(sentinel, '····'), { backspaces: 0, text: '' }, 'no change is no input');
  assert.deepEqual(inputDelta(sentinel, '···'), { backspaces: 1, text: '' }, 'a shortened field is a backspace');
  assert.deepEqual(inputDelta(sentinel, ''), { backspaces: 4, text: '' },
    'a field the keyboard cleared is one backspace per sentinel character');
  assert.deepEqual(inputDelta(sentinel, '··hello'), { backspaces: 2, text: 'hello' },
    'an autocorrect replacement deletes and types in one event');
  assert.deepEqual(inputDelta(sentinel, '····café'), { backspaces: 0, text: 'café' });
  assert.deepEqual(inputDelta('', 'x'), { backspaces: 0, text: 'x' });
});
