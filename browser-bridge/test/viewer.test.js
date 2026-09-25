import assert from "node:assert/strict";
import test from "node:test";

import { CTRL, META, SHIFT } from "../extension/lib/keys.js";
import { cdpInput, nameMatches, tabsForSession } from "../extension/lib/viewer.js";

test("a session number matches its own groups and no longer number", () => {
  assert.equal(nameMatches("#12", "#12"), true);
  assert.equal(nameMatches("#12 fix-login", "#12"), true);
  assert.equal(nameMatches("#12 fix-login (ended)", "#12"), true);
  assert.equal(nameMatches("#123 other", "#12"), false);
  assert.equal(nameMatches("codex #4411", "#44"), false);
  assert.equal(nameMatches(undefined, "#12"), false);
});

test("a session's tabs include pop-ups its tabs opened, transitively", () => {
  const store = {
    keyA: { name: "#12 card", groupId: 5 },
    keyB: { name: "#13 other", groupId: 6 },
  };
  const tabs = [
    { id: 1, groupId: 5, url: "https://app.example", title: "App" },
    { id: 2, groupId: -1, openerTabId: 1, url: "https://accounts.example/oauth", title: "Sign in" },
    { id: 3, groupId: -1, openerTabId: 2, url: "https://accounts.example/2fa", title: "2FA" },
    { id: 4, groupId: 6, url: "https://other.example", title: "Other" },
    { id: 5, groupId: -1, openerTabId: 4, url: "https://other.example/popup", title: "Other pop-up" },
    { id: 6, groupId: -1, url: "https://unrelated.example", title: "Unrelated" },
  ];
  const seen = tabsForSession(store, tabs, "#12");
  assert.deepEqual(seen.map((tab) => tab.id), [1, 2, 3]);
  assert.equal(seen[0].popup, false);
  assert.equal(seen[1].popup, true);
  assert.equal(seen[2].openerTabId, 2);
});

test("mouse input becomes one CDP mouse event with clamped fields", () => {
  const [method, params] = cdpInput({
    kind: "mouse",
    type: "mousePressed",
    x: 10.6,
    y: "20",
    button: "left",
    buttons: 1,
    clickCount: 9,
    modifiers: 99,
  });
  assert.equal(method, "Input.dispatchMouseEvent");
  assert.deepEqual(params, {
    type: "mousePressed",
    x: 11,
    y: 20,
    button: "left",
    buttons: 1,
    clickCount: 3,
    modifiers: 15,
  });
  const [, wheel] = cdpInput({ kind: "mouse", type: "mouseWheel", x: 1, y: 2, deltaY: 120 });
  assert.equal(wheel.deltaY, 120);
  assert.equal(wheel.button, "none");
});

test("unknown input kinds and event types are refused", () => {
  assert.throws(() => cdpInput({ kind: "eval", expression: "1" }), /unknown input kind/);
  assert.throws(() => cdpInput({ kind: "mouse", type: "dragIntercepted" }), /unknown mouse event/);
  assert.throws(() => cdpInput({ kind: "key", type: "press" }), /unknown key event/);
});

test("Cmd becomes Ctrl on a browser that is not on a Mac, and names a command on one", () => {
  const input = { kind: "key", type: "rawKeyDown", key: "a", code: "KeyA", keyCode: 65, modifiers: META };
  const [, linux] = cdpInput(input, { mac: false });
  assert.equal(linux.modifiers, CTRL);
  assert.equal(linux.commands, undefined);

  const [, mac] = cdpInput(input, { mac: true });
  assert.equal(mac.modifiers, META);
  assert.deepEqual(mac.commands, ["selectAll"]);

  const [, shifted] = cdpInput({ ...input, modifiers: META | SHIFT }, { mac: false });
  assert.equal(shifted.modifiers, CTRL | SHIFT);
});

test("typed text carries its text, and pasted text is inserted whole", () => {
  const [, key] = cdpInput({ kind: "key", type: "keyDown", key: "x", code: "KeyX", keyCode: 88, text: "x" }, { mac: false });
  assert.equal(key.text, "x");
  assert.equal(key.unmodifiedText, "x");
  const [method, text] = cdpInput({ kind: "text", text: "hunter2 🙂" });
  assert.equal(method, "Input.insertText");
  assert.equal(text.text, "hunter2 🙂");
});
