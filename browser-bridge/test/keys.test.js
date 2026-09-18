import assert from "node:assert/strict";
import test from "node:test";

import {
  ALT,
  CTRL,
  META,
  SHIFT,
  ZOOM_CHORD_ERROR,
  charDescriptor,
  isZoomChord,
  keyDescriptor,
  parseChord,
  parseModifiers,
} from "../extension/lib/keys.js";

test("lowercase letters type themselves with no modifiers", () => {
  const a = charDescriptor("a");
  assert.equal(a.key, "a");
  assert.equal(a.code, "KeyA");
  assert.equal(a.keyCode, 65);
  assert.equal(a.text, "a");
  assert.equal(a.shift, false);
});

test("uppercase letters and shifted punctuation carry the shift flag", () => {
  assert.equal(charDescriptor("A").shift, true);
  assert.equal(charDescriptor("A").code, "KeyA");
  const bang = charDescriptor("!");
  assert.equal(bang.shift, true);
  assert.equal(bang.code, "Digit1");
  assert.equal(bang.text, "!");
  const colon = charDescriptor(":");
  assert.equal(colon.code, "Semicolon");
  assert.equal(colon.shift, true);
});

test("digits and unshifted punctuation are plain keys", () => {
  assert.equal(charDescriptor("7").code, "Digit7");
  assert.equal(charDescriptor("7").shift, false);
  assert.equal(charDescriptor("-").code, "Minus");
  assert.equal(charDescriptor("/").keyCode, 191);
});

test("newline is Enter and tab is Tab", () => {
  assert.equal(charDescriptor("\n").key, "Enter");
  assert.equal(charDescriptor("\n").text, "\r");
  assert.equal(charDescriptor("\t").code, "Tab");
  assert.equal(charDescriptor(" ").code, "Space");
});

test("characters with no US-layout key fall through to insertText", () => {
  assert.equal(charDescriptor("é"), null);
  assert.equal(charDescriptor("\u{1F600}"), null);
  assert.equal(charDescriptor("中"), null);
});

test("named keys resolve however the model spells them", () => {
  for (const name of ["Return", "enter", "ENTER"]) {
    assert.equal(keyDescriptor(name).key, "Enter", name);
  }
  assert.equal(keyDescriptor("Up").key, "ArrowUp");
  assert.equal(keyDescriptor("ArrowUp").windowsVirtualKeyCode, 38);
  assert.equal(keyDescriptor("Page Down").key, "PageDown");
  assert.equal(keyDescriptor("F5").windowsVirtualKeyCode, 116);
  assert.equal(keyDescriptor("Escape").key, "Escape");
  assert.equal(keyDescriptor("nonsense"), null);
});

test("a ctrl or meta chord carries no text, so cmd+a does not type an a", () => {
  const plain = keyDescriptor("a", 0);
  assert.equal(plain.text, "a");
  const chord = keyDescriptor("a", META);
  assert.equal(chord.text, undefined);
  assert.equal(chord.modifiers, META);
  assert.equal(keyDescriptor("a", CTRL).text, undefined);
  // Shift alone still types.
  assert.equal(keyDescriptor("A", 0).text, "A");
  assert.equal(keyDescriptor("A", 0).modifiers, SHIFT);
});

test("chords parse into a modifier mask and a key", () => {
  assert.deepEqual(parseChord("cmd+shift+a"), { modifiers: META | SHIFT, key: "a" });
  assert.deepEqual(parseChord("ctrl+alt+Delete"), { modifiers: CTRL | ALT, key: "Delete" });
  assert.deepEqual(parseChord("Escape"), { modifiers: 0, key: "Escape" });
  assert.deepEqual(parseChord("option+Tab"), { modifiers: ALT, key: "Tab" });
  // A trailing plus means the key itself is "+".
  assert.deepEqual(parseChord("cmd++"), { modifiers: META, key: "+" });
  assert.match(parseChord("hyper+a").error, /Unknown modifier: hyper/);
});

test("click modifiers parse the same way", () => {
  assert.deepEqual(parseModifiers("ctrl+shift"), { modifiers: CTRL | SHIFT });
  assert.deepEqual(parseModifiers(""), { modifiers: 0 });
  assert.deepEqual(parseModifiers(undefined), { modifiers: 0 });
  assert.deepEqual(parseModifiers("meta"), { modifiers: META });
  assert.deepEqual(parseModifiers("windows"), { modifiers: META });
  assert.match(parseModifiers("super").error, /Unknown modifier/);
});

test("page zoom chords are refused with the promised message", () => {
  for (const chord of ["cmd+=", "cmd+-", "cmd+0", "ctrl+=", "ctrl+-", "ctrl+0", "cmd++", "ctrl+_"]) {
    const { modifiers, key } = parseChord(chord);
    assert.equal(isZoomChord(modifiers, key), true, chord);
  }
  assert.equal(isZoomChord(META, "a"), false);
  assert.equal(isZoomChord(0, "0"), false);
  assert.match(ZOOM_CHORD_ERROR, /`zoom` action/);
});
