// The mirrored tool list has to stay faithful to docs/claude-in-chrome-tools.txt.
//
// That file is minified JavaScript carved out of the Claude Code binary: one `var`
// statement whose declarations happen to be split across "=====" separators. Joining
// the non-separator lines gives valid JS, so the contract is read by running it in a
// bare vm context rather than by guessing at it with regexes.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { TOOLS, TOOL_NAMES } from "../mcp/tools.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT = path.join(ROOT, "docs", "claude-in-chrome-tools.txt");

/** Tools with no local meaning: they are Anthropic cloud features. */
const DROPPED = new Set([
  "shortcuts_list",
  "shortcuts_execute",
  "switch_browser",
  "list_connected_browsers",
  "select_browser",
]);

/** Tools this bridge adds on top of the contract. */
const ADDED = new Set(["browser_status"]);

/**
 * Properties this bridge adds to a mirrored tool. gif_creator's own description tells
 * the model to "provide 'coordinate'", but the contract's schema never declared one, so
 * the bridge declares it and the property check below allows for it.
 */
const ADDED_PROPERTIES = { gif_creator: ["coordinate"] };

function loadContract() {
  const code = fs
    .readFileSync(CONTRACT, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && line.trim() !== "=====")
    .join("\n");
  const context = vm.createContext({});
  vm.runInContext(`${code}\nglobalThis.__contract = { tools: XGe, fileUpload: f };`, context);
  const { tools, fileUpload } = context.__contract;

  // The vm has its own realm, so Array.prototype differs; the JSON round trip brings
  // the definitions back into this one where deepEqual can compare them.
  const byName = new Map();
  for (const tool of JSON.parse(JSON.stringify([...tools, fileUpload]))) {
    if (!byName.has(tool.name)) byName.set(tool.name, []);
    byName.get(tool.name).push(tool);
  }
  return byName;
}

const contract = loadContract();

function propertyNames(schema, added = []) {
  return Object.keys(schema.properties ?? {})
    .filter((name) => !added.includes(name))
    .sort();
}

test("the contract file parses into the tools it documents", () => {
  assert.ok(contract.size >= 20, `only ${contract.size} tools parsed`);
  assert.ok(contract.has("computer"));
  // file_upload appears twice in the contract, with and without the `files` field.
  assert.equal(contract.get("file_upload").length, 2);
});

test("the tool list is the contract minus the dropped tools plus browser_status", () => {
  const expected = [...contract.keys()].filter((name) => !DROPPED.has(name));
  assert.deepEqual([...TOOL_NAMES].sort(), [...expected, ...ADDED].sort());
});

test("no dropped tool sneaks back in", () => {
  for (const name of DROPPED) assert.ok(!TOOL_NAMES.includes(name), `${name} should be dropped`);
});

test("every mirrored tool matches the contract's required list and properties", () => {
  for (const tool of TOOLS) {
    if (ADDED.has(tool.name)) continue;
    const candidates = contract.get(tool.name);
    assert.ok(candidates, `${tool.name} is not in the contract`);

    const added = ADDED_PROPERTIES[tool.name] ?? [];

    // A name with several contract variants only has to match one of them.
    const matches = candidates.filter((candidate) => {
      const sameRequired =
        JSON.stringify([...(candidate.inputSchema.required ?? [])].sort()) ===
        JSON.stringify([...(tool.inputSchema.required ?? [])].sort());
      const sameProperties =
        JSON.stringify(propertyNames(candidate.inputSchema)) ===
        JSON.stringify(propertyNames(tool.inputSchema, added));
      return sameRequired && sameProperties;
    });
    assert.equal(
      matches.length > 0,
      true,
      `${tool.name}: required ${JSON.stringify(tool.inputSchema.required)} / properties ` +
        `${JSON.stringify(propertyNames(tool.inputSchema, added))} matches no contract variant ` +
        `(${candidates
          .map((c) => `${JSON.stringify(c.inputSchema.required)} ${JSON.stringify(propertyNames(c.inputSchema))}`)
          .join(" | ")})`,
    );
  }
});

test("mirrored property types and enums match the contract", () => {
  for (const tool of TOOLS) {
    if (ADDED.has(tool.name)) continue;
    const candidate = contract.get(tool.name)[0];
    for (const [key, property] of Object.entries(tool.inputSchema.properties ?? {})) {
      const original = candidate.inputSchema.properties?.[key];
      if (!original) continue; // a variant without this property; the list check covers it
      assert.deepEqual(property.type, original.type, `${tool.name}.${key} type`);
      if (original.enum) assert.deepEqual(property.enum, original.enum, `${tool.name}.${key} enum`);
      if (original.minItems !== undefined) assert.equal(property.minItems, original.minItems);
      if (original.maxItems !== undefined) assert.equal(property.maxItems, original.maxItems);
      if (original.minimum !== undefined) assert.equal(property.minimum, original.minimum);
      if (original.maximum !== undefined) assert.equal(property.maximum, original.maximum);
      if (original.items?.type) assert.equal(property.items?.type, original.items.type);
    }
  }
});

test("every input schema is a usable JSON schema", () => {
  for (const tool of TOOLS) {
    assert.equal(typeof tool.name, "string");
    assert.ok(tool.description.length > 40, `${tool.name} needs a real description`);
    const schema = tool.inputSchema;
    assert.equal(schema.type, "object", `${tool.name} schema type`);
    assert.equal(typeof schema.properties, "object", `${tool.name} properties`);
    assert.ok(Array.isArray(schema.required), `${tool.name} required`);
    for (const key of schema.required) {
      assert.ok(schema.properties[key], `${tool.name} requires ${key} but does not define it`);
    }
    for (const [key, property] of Object.entries(schema.properties)) {
      assert.ok(property.type, `${tool.name}.${key} has no type`);
      assert.equal(typeof property.description === "string" || key === "actions", true);
    }
    // It must survive the JSON round trip the MCP transport puts it through.
    assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema);
  }
});

test("the properties this bridge adds are declared and described", () => {
  for (const [name, added] of Object.entries(ADDED_PROPERTIES)) {
    const tool = TOOLS.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} is not in the tool list`);
    for (const property of added) {
      assert.ok(tool.inputSchema.properties[property], `${name}.${property} is missing`);
      assert.ok(
        !contract.get(name)?.some((variant) => variant.inputSchema.properties?.[property]),
        `${name}.${property} is in the contract after all; drop it from ADDED_PROPERTIES`,
      );
    }
  }
});

test("no tool description still claims it is unimplemented", () => {
  for (const tool of TOOLS) {
    assert.doesNotMatch(tool.description, /not implemented/i, tool.name);
  }
});

test("tool names are unique", () => {
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length);
});
