import test from 'node:test';
import assert from 'node:assert/strict';
import { focusQueueItem, handleLeaveTerminalKey, isLeaveTerminalChord } from './leave-terminal.js';

// Just enough document for the handler: a terminal that owns the keyboard and
// the selected queue item it should hand it to. closest() is what app.js uses
// to decide a key belongs to the terminal, so the fake answers it honestly.
class FakeNode {
  constructor(doc, selector, classes = []) {
    this.doc = doc;
    this.selector = selector;
    this.classList = {
      list: new Set(classes),
      contains: (name) => this.classList.list.has(name),
      remove: (name) => this.classList.list.delete(name),
    };
  }

  closest(selector) { return selector === '.term' && this.selector.startsWith('.term') ? this : null; }
  focus() { this.doc.activeElement = this; }
  blur() { if (this.doc.activeElement === this) this.doc.activeElement = this.doc.body; }
}

function fakeDocument() {
  const doc = { activeElement: null };
  doc.term = new FakeNode(doc, '.term', ['term', 'focused']);
  doc.body = new FakeNode(doc, 'body');
  doc.queueItem = new FakeNode(doc, '#qlist .qitem.sel', ['qitem', 'sel']);
  doc.querySelector = (selector) => (selector === '#qlist .qitem.sel' ? doc.queueItem : null);
  doc.querySelectorAll = (selector) => (selector === '.term.focused' && doc.term.classList.contains('focused') ? [doc.term] : []);
  doc.activeElement = doc.term;
  return doc;
}

function keydown(key, modifiers = {}) {
  const event = { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, prevented: 0, stopped: 0, ...modifiers };
  event.preventDefault = () => { event.prevented += 1; };
  event.stopPropagation = () => { event.stopped += 1; };
  return event;
}

// The gate app.js applies before any Triage hotkey: a focused terminal keeps
// every plain key. Once this is false, j/k reach moveQueue.
const terminalOwnsKeys = (doc, state) => Boolean(state.pendingFocus || (doc.activeElement && doc.activeElement.closest('.term')));

test('⌘⎋ inside a focused terminal moves the keyboard to the selected queue item, so j/k work again', () => {
  const doc = fakeDocument();
  const state = { focused: true, pendingFocus: true };
  assert.equal(terminalOwnsKeys(doc, state), true);

  const chord = keydown('Escape', { metaKey: true });
  assert.equal(handleLeaveTerminalKey(chord, state, doc), true);
  assert.equal(doc.activeElement, doc.queueItem);
  assert.equal(state.focused, false);
  assert.equal(state.pendingFocus, false, 'a session open in flight no longer counts as terminal focus');
  assert.equal(doc.term.classList.contains('focused'), false, 'the terminal loses its focused ring');
  // Cancelled and stopped: xterm's listener on the textarea must not turn the
  // chord into a bare ESC for the pty.
  assert.equal(chord.prevented, 1);
  assert.equal(chord.stopped, 1);

  assert.equal(terminalOwnsKeys(doc, state), false, 'a following j or k is no longer swallowed by the terminal');
});

test('Escape, Shift+Escape and Ctrl+Escape stay with the terminal; only the ⌘ chord leaves', () => {
  for (const modifiers of [{}, { shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true, shiftKey: true }]) {
    const doc = fakeDocument();
    const state = { focused: true, pendingFocus: false };
    const event = keydown('Escape', modifiers);
    assert.equal(isLeaveTerminalChord(event), false, JSON.stringify(modifiers));
    assert.equal(handleLeaveTerminalKey(event, state, doc), false);
    assert.equal(doc.activeElement, doc.term);
    assert.equal(event.prevented + event.stopped, 0);
  }
  assert.equal(isLeaveTerminalChord(keydown('Enter', { metaKey: true })), false, '⌘↵ is still the terminal\'s newline');
});

test('leaving with no selected queue item (Watch, an empty queue) still takes the keyboard off the terminal', () => {
  const doc = fakeDocument();
  doc.queueItem = null;
  const state = { focused: true, pendingFocus: false };
  focusQueueItem(state, doc);
  assert.equal(state.focused, false);
  assert.equal(doc.term.classList.contains('focused'), false);
  // Otherwise activeElement stays on the xterm textarea and app.js keeps
  // treating every plain key as the terminal's.
  assert.equal(doc.activeElement, doc.body);
  assert.equal(terminalOwnsKeys(doc, state), false);
});
