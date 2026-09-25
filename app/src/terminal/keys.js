'use strict';

// What the phone's key bar puts on the wire. A terminal has no key events, only
// bytes, and the bytes for a cursor key depend on a mode the program running in the
// pane chose (DECCKM, which xterm reports as `applicationCursorKeysMode`): a shell
// at its prompt expects CSI A, a full-screen program that turned application cursor
// keys on expects SS3 A. Sending the wrong one moves the cursor in some programs and
// prints a stray letter in others, so the caller passes the emulator's current mode.
//
// The daemon has its own name-to-bytes table for `/api/keys` (SESSION_KEY_BYTES in
// bin/serve.js) and this deliberately matches it where they overlap; the difference
// is that this table also carries the modes and the modifiers, which an HTTP key
// press has no way to express.

const CSI = '\x1b[';
const SS3 = '\x1bO';

// Keys whose bytes change with the cursor-keys mode: normal form first.
const CURSOR_KEYS = {
  Up: ['A'], Down: ['B'], Right: ['C'], Left: ['D'], Home: ['H'], End: ['F'],
};

const PLAIN_KEYS = {
  Escape: '\x1b',
  Tab: '\t',
  BackTab: '\x1b[Z',
  Enter: '\r',
  // Shift+Enter is a newline inside Claude Code and Codex rather than a submit. The
  // desktop console sends ESC CR for it (web/app/terminal.js), and the phone must
  // send the same bytes or the two clients disagree about what the button does.
  ShiftEnter: '\x1b\r',
  Backspace: '\x7f',
  Delete: '\x1b[3~',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  Insert: '\x1b[2~',
  CtrlC: '\x03',
  CtrlD: '\x04',
  CtrlL: '\x0c',
  CtrlU: '\x15',
  CtrlZ: '\x1a',
  Space: ' ',
};

// Ctrl on a character is the ASCII control code: letters map to 1-31 by clearing the
// upper bits, and the handful of punctuation keys that also carry a control code are
// spelled out because the arithmetic alone would produce codes for characters that
// have none.
const CTRL_PUNCTUATION = {
  ' ': '\x00', '@': '\x00', '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e',
  '_': '\x1f', '?': '\x7f',
};

function ctrlChar(char) {
  if (typeof char !== 'string' || char.length === 0) return null;
  const lower = char.toLowerCase();
  if (lower >= 'a' && lower <= 'z') return String.fromCharCode(lower.charCodeAt(0) - 96);
  if (Object.prototype.hasOwnProperty.call(CTRL_PUNCTUATION, char)) return CTRL_PUNCTUATION[char];
  return null;
}

// A modifier that no key consumed is not an error: Ctrl with a key that has no
// control code sends the key alone, which is what a hardware keyboard does.
function withModifiers(bytes, { alt = false } = {}) {
  if (!bytes) return '';
  // Meta/Alt is the ESC prefix; for a sequence that is already an escape sequence
  // the prefix still applies (ESC ESC [ A is how xterm sends Alt+Up).
  return alt ? `\x1b${bytes}` : bytes;
}

// `name` is one of the labels the key bar uses. `options.applicationCursor` is the
// emulator's DECCKM state; `ctrl` and `alt` are the sticky modifiers.
function encodeKey(name, options = {}) {
  const { applicationCursor = false, ctrl = false, alt = false } = options;
  const cursor = CURSOR_KEYS[name];
  if (cursor) {
    const [final] = cursor;
    // Ctrl+arrow is the xterm modifier form: CSI 1 ; 5 A, and it has no SS3 spelling,
    // so a ctrl-modified cursor key stays in CSI form whatever the mode is.
    if (ctrl) return withModifiers(`${CSI}1;5${final}`, { alt });
    return withModifiers(`${applicationCursor ? SS3 : CSI}${final}`, { alt });
  }
  if (Object.prototype.hasOwnProperty.call(PLAIN_KEYS, name)) {
    return withModifiers(PLAIN_KEYS[name], { alt });
  }
  // A single printable character from the key bar or the hidden input.
  if (typeof name === 'string' && Array.from(name).length === 1) {
    return encodeText(name, { ctrl, alt });
  }
  return '';
}

// Text typed into the hidden input, with whatever sticky modifiers are armed. Ctrl
// and Alt apply to the first character only — the modifier is a keypress, not a
// mode, and holding it down for a pasted sentence is not what the user asked for.
function encodeText(text, options = {}) {
  const { ctrl = false, alt = false } = options;
  const value = String(text == null ? '' : text);
  if (!value) return '';
  if (!ctrl && !alt) return value;
  const characters = Array.from(value);
  const first = characters[0];
  const rest = characters.slice(1).join('');
  const head = ctrl ? (ctrlChar(first) ?? first) : first;
  return `${withModifiers(head, { alt })}${rest}`;
}

// Bracketed paste, when the program asked for it: the wrapper is what tells an
// editor or a REPL that the bytes between the markers are pasted text rather than
// typed keys, which is what stops a multi-line paste from being run line by line.
function encodePaste(text, options = {}) {
  const value = String(text == null ? '' : text);
  if (!value) return '';
  // A paste carrying the end marker could close the bracket early and run the rest as
  // keystrokes; dropping the marker is the same defence xterm applies.
  const safe = value.replace(/\x1b\[201~/g, '');
  if (!options.bracketedPaste) return safe;
  return `\x1b[200~${safe}\x1b[201~`;
}

// The hidden TextInput is how the soft keyboard reaches the pane, and a soft
// keyboard does not report keys — it reports what the field now contains. The field
// is therefore held at a fixed sentinel and every change is read as a difference
// against it: text appended is text typed, and text missing from the front of the
// sentinel is that many backspaces. Without the sentinel an empty field could not
// report a backspace at all, which is exactly the key a terminal needs most.
//
// A change can be both at once (an autocorrect replacement, a swipe-typed word), so
// the result carries the deletions and the insertion together, in that order.
function inputDelta(sentinel, next) {
  const base = String(sentinel == null ? '' : sentinel);
  const value = String(next == null ? '' : next);
  let shared = 0;
  const limit = Math.min(base.length, value.length);
  while (shared < limit && base[shared] === value[shared]) shared++;
  return { backspaces: base.length - shared, text: value.slice(shared) };
}

// The hidden field's text over a run of typing. Every change is measured against
// the text the field held just before it, which is always known, so nothing has to
// guess whether a reset has landed. The field is only put back to the sentinel once
// typing goes idle (the screen calls reset() as it does so); until then it simply
// grows, and the sentinel is long enough that a held Backspace does not run out.
//
// One race is left: a keystroke landing while the idle reset is being applied. React
// Native drops the reset then, and the change arrives on top of the old text rather
// than the sentinel, and nothing tells the app which. So the first change after a
// reset is measured against both and the smaller edit is taken: a real keystroke is a
// one-character change against the right one and a large edit against the wrong one.
// A tie goes to the sentinel, where the reset almost always lands.
function createFieldTracker(sentinel) {
  const base = String(sentinel == null ? '' : sentinel);
  let last = base;
  let resetFrom = null;
  return {
    change(next) {
      const value = String(next == null ? '' : next);
      let delta = inputDelta(last, value);
      if (resetFrom !== null) {
        const fromOld = inputDelta(resetFrom, value);
        const cost = (d) => d.backspaces + d.text.length;
        // A change that costs nothing against the sentinel cannot be real: had the reset
        // landed, any change would move the field off it. (One case stays ambiguous: after
        // a two-character run, a Backspace on a dropped reset and a landed reset plus that
        // same first character give the same text; it goes to the sentinel.)
        if (cost(delta) === 0 || cost(fromOld) < cost(delta)) delta = fromOld;
      }
      resetFrom = null;
      last = value;
      return delta;
    },
    reset() {
      if (last !== base) resetFrom = last;
      last = base;
    },
    text() { return last; },
  };
}

module.exports = { CURSOR_KEYS, PLAIN_KEYS, ctrlChar, encodeKey, encodePaste, encodeText, createFieldTracker, inputDelta };
