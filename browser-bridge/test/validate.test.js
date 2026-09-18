// Input validation against the schemas the server advertises.

import assert from "node:assert/strict";
import test from "node:test";

import { TOOLS, toolByName } from "../mcp/tools.js";
import { validateToolInput, validateValue } from "../mcp/validate.js";

function check(name, input) {
  return validateToolInput(toolByName(name), input);
}

test("a good call passes", () => {
  assert.equal(check("read_page", { tabId: 3, filter: "interactive", max_chars: 1000 }), null);
  assert.equal(check("tabs_context_mcp", { createIfEmpty: true }), null);
  assert.equal(check("tabs_context_mcp", {}), null);
  assert.equal(check("computer", { action: "screenshot", tabId: 3 }), null);
});

test("a string standing in for a boolean is refused", () => {
  // "false" is truthy, so forwarding it would clear a buffer nobody asked to clear.
  const message = check("read_console_messages", { tabId: 3, clear: "false" });
  assert.match(message, /^Invalid input for read_console_messages: /);
  assert.match(message, /input\.clear must be boolean \(got string\)/);
});

test("a string standing in for a number is refused", () => {
  assert.match(check("read_page", { tabId: "3" }), /input\.tabId must be number \(got string\)/);
});

test("a missing required field is named", () => {
  assert.match(check("computer", { action: "left_click" }), /input\.tabId is required/);
  assert.match(check("find", { tabId: 1 }), /input\.query is required/);
});

test("enums, ranges and array lengths are enforced", () => {
  assert.match(check("computer", { action: "fly", tabId: 1 }), /input\.action must be one of/);
  assert.match(check("read_page", { tabId: 1, filter: "some" }), /input\.filter must be one of/);
  assert.match(check("computer", { action: "wait", tabId: 1, duration: 99 }), /at most 10/);
  assert.match(check("computer", { action: "screenshot", tabId: 1, scale: 0 }), /at least 0\.1/);
  assert.match(
    check("computer", { action: "left_click", tabId: 1, coordinate: [1] }),
    /input\.coordinate needs at least 2 item\(s\)/,
  );
  assert.match(
    check("computer", { action: "left_click", tabId: 1, coordinate: [1, 2, 3] }),
    /input\.coordinate takes at most 2 item\(s\)/,
  );
  assert.match(
    check("computer", { action: "left_click", tabId: 1, coordinate: ["a", "b"] }),
    /input\.coordinate\[0\] must be number/,
  );
});

test("a union type accepts every member", () => {
  for (const value of ["yes", true, 7]) {
    assert.equal(check("form_input", { ref: "ref_1", value, tabId: 1 }), null, String(value));
  }
  assert.match(
    check("form_input", { ref: "ref_1", value: { a: 1 }, tabId: 1 }),
    /input\.value must be string or boolean or number/,
  );
});

test("nested objects and arrays of objects are checked", () => {
  assert.equal(
    check("browser_batch", { actions: [{ name: "navigate", input: { url: "example.com" } }] }),
    null,
  );
  assert.match(
    check("browser_batch", { actions: [{ name: "navigate" }] }),
    /input\.actions\[0\]\.input is required/,
  );
  assert.match(check("browser_batch", { actions: [] }), /input\.actions needs at least 1 item/);
  assert.match(
    check("gif_creator", { action: "export", tabId: 1, options: { quality: "high" } }),
    /input\.options\.quality must be number/,
  );
});

test("integer is stricter than number", () => {
  assert.equal(check("tabs_close_mcp", { tabId: 3 }), null);
  assert.match(check("tabs_close_mcp", { tabId: 3.5 }), /must be integer/);
});

test("unknown properties are allowed through", () => {
  // The contract sets no additionalProperties, and a future client field is not an error.
  assert.equal(check("read_page", { tabId: 1, somethingNew: true }), null);
});

test("a non-object input is refused", () => {
  assert.match(validateToolInput(toolByName("read_page"), "tabId=1"), /must be an object/);
});

test("every advertised schema accepts an empty object or names what it needs", () => {
  for (const tool of TOOLS) {
    const message = validateToolInput(tool, {});
    if (tool.inputSchema.required.length === 0) assert.equal(message, null, tool.name);
    else assert.match(message, /is required/, tool.name);
  }
});

test("validateValue reports several problems at once", () => {
  const errors = validateValue(
    { a: "x", b: 5 },
    { type: "object", properties: { a: { type: "number" }, b: { type: "string" } } },
  );
  assert.equal(errors.length, 2);
});
