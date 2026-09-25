// The keyboard path out of a focused terminal. Plain keys and Escape belong to
// the terminal (Claude Code reads Escape as interrupt), and ⌘↵ inserts a
// newline there, so the way back to the queue is ⌘⎋: a chord neither xterm
// nor the browser claims. Duck-typed on the document so it can be exercised
// outside a browser.
export function isLeaveTerminalChord(event) {
  return event.key === 'Escape' && Boolean(event.metaKey)
    && !event.ctrlKey && !event.altKey && !event.shiftKey;
}

// Moves the keyboard from the terminal to the selected queue item so the Triage
// hotkeys (j/k, 1-9, p, x) work again without a click outside the prompt.
export function focusQueueItem(state, doc = document) {
  state.focused = false;
  // A session open in flight also counts as terminal focus; the keyboard is
  // wanted now, and the open's own cleanup clears the flag again regardless.
  state.pendingFocus = false;
  const item = doc.querySelector('#qlist .qitem.sel');
  // With no selected item (Watch, an empty queue) the terminal's textarea would
  // keep activeElement, and app.js would go on handing it every plain key.
  if (item) item.focus();
  else if (doc.activeElement?.closest?.('.term')) doc.activeElement.blur();
  doc.querySelectorAll('.term.focused').forEach((element) => element.classList.remove('focused'));
}

// Called from the capture-phase key listener while a terminal has the keyboard.
// Returns true when the chord was consumed. The event is stopped as well as
// cancelled: xterm's own listener runs later on the terminal's textarea and
// would otherwise send a bare ESC to the pty.
export function handleLeaveTerminalKey(event, state, doc = document) {
  if (!isLeaveTerminalChord(event)) return false;
  event.preventDefault();
  event.stopPropagation();
  focusQueueItem(state, doc);
  return true;
}
