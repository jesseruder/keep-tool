import assert from "node:assert/strict";
import test from "node:test";

import {
  RefTable,
  collectNodes,
  describeNode,
  isInteractive,
  renderAxTree,
} from "../extension/lib/ax.js";
import { AX_TREE } from "./fixtures/ax-tree.js";

function lineFor(text, needle) {
  return text.split("\n").find((line) => line.includes(needle)) ?? null;
}

test("refs are assigned in document order and are stable", () => {
  const refs = new RefTable();
  const first = renderAxTree(AX_TREE, { refTable: refs });
  const second = renderAxTree(AX_TREE, { refTable: refs });
  assert.equal(first.text, second.text);
  assert.equal(refs.backendFor("ref_1"), 1);
  assert.equal(refs.backendFor("ref_4"), 4);
  assert.equal(refs.refFor(4), "ref_4");
});

test("reset forgets every ref, as a navigation must", () => {
  const refs = new RefTable();
  refs.refFor(99);
  assert.equal(refs.backendFor("ref_1"), 99);
  refs.reset();
  assert.equal(refs.backendFor("ref_1"), null);
  assert.equal(refs.refFor(7), "ref_1");
});

test("a node line carries its ref, role, name and live properties", () => {
  const refs = new RefTable();
  const { text } = renderAxTree(AX_TREE, { refTable: refs });
  assert.equal(lineFor(text, '"Sign in"').trim(), '[ref_4] button "Sign in" focusable focused');
  assert.match(lineFor(text, "Search products"), /\[ref_3\] searchbox "Search products" value="mango" focusable/);
  // checked=false is noise, not information.
  assert.equal(lineFor(text, '"Gift wrap"').includes("checked"), false);
});

test("ignored nodes are skipped but their children are kept", () => {
  const { text } = renderAxTree(AX_TREE, { refTable: new RefTable() });
  assert.equal(lineFor(text, "generic \"\""), null);
  assert.equal(text.includes("[ref_2]"), false, "the ignored wrapper has no line");
  assert.ok(text.includes("[ref_3]"), "but its children still appear");
  const searchLine = lineFor(text, "Search products");
  assert.equal(searchLine.startsWith("  ["), true, "children of an ignored node keep its depth");
});

test("the interactive filter keeps controls and drops static text", () => {
  const refs = new RefTable();
  const { text } = renderAxTree(AX_TREE, { filter: "interactive", refTable: refs });
  assert.ok(text.includes("[ref_4] button"));
  assert.ok(text.includes("[ref_3] searchbox"));
  assert.ok(text.includes(`[${refs.refFor(12)}] link`));
  assert.equal(text.includes("RootWebArea"), false);
  assert.equal(text.includes("StaticText"), false);
  assert.equal(text.includes("heading"), false);
});

test("isInteractive follows the role or the focusable property", () => {
  assert.equal(isInteractive(AX_TREE.find((n) => n.nodeId === "4")), true);
  assert.equal(isInteractive(AX_TREE.find((n) => n.nodeId === "11")), false);
});

test("depth limits how far down the tree the render goes", () => {
  const shallow = renderAxTree(AX_TREE, { maxDepth: 1, refTable: new RefTable() });
  assert.ok(shallow.text.includes("[ref_4] button"));
  assert.equal(shallow.text.includes("Deeply nested"), false);

  const deep = renderAxTree(AX_TREE, { maxDepth: 15, refTable: new RefTable() });
  assert.ok(deep.text.includes("Deeply nested"));
});

test("ref_id narrows the render to one subtree", () => {
  const refs = new RefTable();
  renderAxTree(AX_TREE, { refTable: refs });
  const { text } = renderAxTree(AX_TREE, { rootRef: refs.refFor(10), refTable: refs });
  assert.ok(text.startsWith(`[${refs.refFor(10)}] main "Products"`));
  assert.ok(text.includes("Organic mango"));
  assert.equal(text.includes("Sign in"), false);
});

test("an unknown ref_id is an error the caller can show", () => {
  const result = renderAxTree(AX_TREE, { rootRef: "ref_9999", refTable: new RefTable() });
  assert.match(result.error, /Unknown ref: ref_9999/);
});

test("max_chars truncates at a line boundary and reports the full size", () => {
  const full = renderAxTree(AX_TREE, { refTable: new RefTable() });
  const cut = renderAxTree(AX_TREE, { maxChars: 120, refTable: new RefTable() });
  assert.equal(cut.truncated, true);
  assert.ok(cut.text.length <= 120);
  assert.equal(cut.fullLength, full.text.length);
  assert.ok(cut.keptLines < cut.lineCount);
  assert.equal(cut.text.endsWith("\n"), false, "no dangling partial line");
  assert.ok(full.text.startsWith(cut.text));
});

test("collectNodes returns the nodes it rendered with their depths", () => {
  const { nodes } = collectNodes(AX_TREE, { refTable: new RefTable() });
  const root = nodes[0];
  assert.equal(root.depth, 0);
  assert.equal(root.ref, "ref_1");
  assert.equal(describeNode(root.node, root.ref), '[ref_1] RootWebArea "Example Shop"');
});
