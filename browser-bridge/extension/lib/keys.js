// Key names -> CDP Input.dispatchKeyEvent parameters.
//
// Pure data and functions: no chrome APIs, so the tests can import this directly.
// The virtual key codes are the US layout ones Chromium expects; pages read
// event.key and event.code, but legacy handlers still read keyCode.

export const MODIFIER_BITS = {
  alt: 1,
  option: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  win: 4,
  windows: 4,
  shift: 8,
};

export const ALT = 1;
export const CTRL = 2;
export const META = 4;
export const SHIFT = 8;

const NAMED = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9, text: "\t" },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  del: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
  capslock: { key: "CapsLock", code: "CapsLock", keyCode: 20 },
  shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  control: { key: "Control", code: "ControlLeft", keyCode: 17 },
  ctrl: { key: "Control", code: "ControlLeft", keyCode: 17 },
  alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
  meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
  cmd: { key: "Meta", code: "MetaLeft", keyCode: 91 },
};

for (let n = 1; n <= 12; n++) {
  NAMED[`f${n}`] = { key: `F${n}`, code: `F${n}`, keyCode: 111 + n };
}

// Unshifted punctuation on a US keyboard, and what shift turns it into.
const PUNCTUATION = {
  "`": { code: "Backquote", keyCode: 192, shifted: "~" },
  "-": { code: "Minus", keyCode: 189, shifted: "_" },
  "=": { code: "Equal", keyCode: 187, shifted: "+" },
  "[": { code: "BracketLeft", keyCode: 219, shifted: "{" },
  "]": { code: "BracketRight", keyCode: 221, shifted: "}" },
  "\\": { code: "Backslash", keyCode: 220, shifted: "|" },
  ";": { code: "Semicolon", keyCode: 186, shifted: ":" },
  "'": { code: "Quote", keyCode: 222, shifted: '"' },
  ",": { code: "Comma", keyCode: 188, shifted: "<" },
  ".": { code: "Period", keyCode: 190, shifted: ">" },
  "/": { code: "Slash", keyCode: 191, shifted: "?" },
};

const DIGIT_SHIFTED = [")", "!", "@", "#", "$", "%", "^", "&", "*", "("];

/** Descriptor for one printable character, or null if it needs Input.insertText. */
export function charDescriptor(ch) {
  if (ch === "\n" || ch === "\r") return { ...NAMED.enter, shift: false };
  if (ch === "\t") return { ...NAMED.tab, shift: false };
  if (ch === " ") return { ...NAMED.space, shift: false };

  if (ch >= "a" && ch <= "z") {
    return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch, shift: false };
  }
  if (ch >= "A" && ch <= "Z") {
    return { key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0), text: ch, shift: true };
  }
  if (ch >= "0" && ch <= "9") {
    return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch, shift: false };
  }
  const plain = PUNCTUATION[ch];
  if (plain) return { key: ch, code: plain.code, keyCode: plain.keyCode, text: ch, shift: false };

  for (const info of Object.values(PUNCTUATION)) {
    if (info.shifted === ch) {
      return { key: ch, code: info.code, keyCode: info.keyCode, text: ch, shift: true };
    }
  }
  const digit = DIGIT_SHIFTED.indexOf(ch);
  if (digit !== -1) {
    return { key: ch, code: `Digit${digit}`, keyCode: `${digit}`.charCodeAt(0), text: ch, shift: true };
  }
  return null; // emoji, accents, CJK: Input.insertText handles these
}

/**
 * Descriptor for a named key or single character used in a chord.
 * `modifiers` is the bitmask already collected from the chord.
 */
export function keyDescriptor(name, modifiers = 0) {
  if (typeof name !== "string" || name.length === 0) return null;
  const named = NAMED[name.toLowerCase()];
  let base = named ? { ...named, shift: false } : null;
  if (!base && name.length === 1) base = charDescriptor(name);
  if (!base && name.length > 1) {
    // "ArrowUp", "PageDown" and friends arrive in mixed case from the model.
    const squashed = NAMED[name.replace(/[\s_-]/g, "").toLowerCase()];
    if (squashed) base = { ...squashed, shift: false };
  }
  if (!base) return null;

  const withShift = modifiers | (base.shift ? SHIFT : 0);
  const event = {
    key: base.key,
    code: base.code,
    windowsVirtualKeyCode: base.keyCode,
    nativeVirtualKeyCode: base.keyCode,
    modifiers: withShift,
  };
  // Chromium inserts `text` verbatim, so a ctrl/meta chord must not carry any:
  // cmd+a should select all, not type "a".
  if (base.text && !(withShift & (CTRL | META | ALT))) {
    event.text = base.text;
    event.unmodifiedText = base.text;
  }
  return event;
}

// On macOS the browser, not the page, turns cmd chords into editing commands, and
// CDP's Input.dispatchKeyEvent only performs them when told to via `commands`. Without
// this, cmd+a reaches the page's keydown handler and then does nothing.
const MAC_COMMANDS = {
  "meta+a": ["selectAll"],
  "meta+c": ["copy"],
  "meta+v": ["paste"],
  "meta+x": ["cut"],
  "meta+z": ["undo"],
  "meta+shift+z": ["redo"],
  "meta+arrowleft": ["moveToBeginningOfLine"],
  "meta+arrowright": ["moveToEndOfLine"],
  "meta+arrowup": ["moveToBeginningOfDocument"],
  "meta+arrowdown": ["moveToEndOfDocument"],
  "meta+shift+arrowleft": ["moveToBeginningOfLineAndModifySelection"],
  "meta+shift+arrowright": ["moveToEndOfLineAndModifySelection"],
  "meta+shift+arrowup": ["moveToBeginningOfDocumentAndModifySelection"],
  "meta+shift+arrowdown": ["moveToEndOfDocumentAndModifySelection"],
  "meta+backspace": ["deleteToBeginningOfLine"],
  "meta+delete": ["deleteToEndOfLine"],
  "alt+arrowleft": ["moveWordLeft"],
  "alt+arrowright": ["moveWordRight"],
  "alt+shift+arrowleft": ["moveWordLeftAndModifySelection"],
  "alt+shift+arrowright": ["moveWordRightAndModifySelection"],
  "alt+backspace": ["deleteWordBackward"],
  "alt+delete": ["deleteWordForward"],
  "shift+arrowleft": ["moveLeftAndModifySelection"],
  "shift+arrowright": ["moveRightAndModifySelection"],
  "shift+arrowup": ["moveUpAndModifySelection"],
  "shift+arrowdown": ["moveDownAndModifySelection"],
  "shift+home": ["moveToBeginningOfLineAndModifySelection"],
  "shift+end": ["moveToEndOfLineAndModifySelection"],
};

/** Editing commands Chromium should run for this chord (macOS semantics), or []. */
export function macCommands(modifiers, keyName) {
  const parts = [];
  if (modifiers & META) parts.push("meta");
  if (modifiers & ALT) parts.push("alt");
  if (modifiers & SHIFT) parts.push("shift");
  const named = NAMED[String(keyName).replace(/[\s_-]/g, "").toLowerCase()];
  const key = (named ? named.key : String(keyName)).toLowerCase();
  parts.push(key);
  return MAC_COMMANDS[parts.join("+")] ?? [];
}

/** "cmd+shift+a" -> {modifiers, key:"a"}; the last segment is the key. */
export function parseChord(chord) {
  const text = String(chord);
  let key;
  let modifierText;
  if (text === "+") {
    key = "+";
    modifierText = "";
  } else if (text.endsWith("+")) {
    // A chord whose key is "+" itself, as in "cmd++".
    key = "+";
    modifierText = text.slice(0, -1).replace(/\+$/, "");
  } else {
    const split = text.lastIndexOf("+");
    key = split === -1 ? text : text.slice(split + 1);
    modifierText = split === -1 ? "" : text.slice(0, split);
  }
  const parsed = parseModifiers(modifierText);
  if (parsed.error) return { error: parsed.error };
  return { modifiers: parsed.modifiers, key };
}

/** "ctrl+shift" -> {modifiers} for the click actions' `modifiers` field. */
export function parseModifiers(text) {
  if (!text) return { modifiers: 0 };
  let modifiers = 0;
  for (const part of String(text).split("+")) {
    const bit = MODIFIER_BITS[part.trim().toLowerCase()];
    if (bit === undefined) return { error: `Unknown modifier: ${part}` };
    modifiers |= bit;
  }
  return { modifiers };
}

const ZOOM_KEYS = new Set(["=", "+", "-", "_", "0"]);

/** Page zoom chords are a browser-level action CDP input cannot reach. */
export function isZoomChord(modifiers, key) {
  return Boolean(modifiers & (CTRL | META)) && ZOOM_KEYS.has(String(key));
}

export const ZOOM_CHORD_ERROR =
  'Page zoom shortcuts are not supported. Use the `zoom` action to magnify a region of the page instead.';
