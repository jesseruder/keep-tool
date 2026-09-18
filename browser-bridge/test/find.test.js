import assert from "node:assert/strict";
import test from "node:test";

import { RefTable } from "../extension/lib/ax.js";
import { MAX_RESULTS, findElements, renderMatches, scoreNode, tokenize } from "../extension/lib/find.js";
import { AX_TREE, manyButtons } from "./fixtures/ax-tree.js";

function best(query) {
  const result = findElements(AX_TREE, query, { refTable: new RefTable() });
  return result.matches[0] ?? null;
}

test("tokenize drops stopwords and punctuation", () => {
  assert.deepEqual(tokenize("the Sign In button!"), ["sign", "button"]);
  assert.deepEqual(tokenize("  "), []);
});

test("a role word plus the name finds the button", () => {
  const match = best("sign in button");
  assert.equal(match.role, "button");
  assert.equal(match.name, "Sign in");
});

test("a purpose query finds the search box", () => {
  const match = best("search bar");
  assert.equal(match.role, "searchbox");
});

test("text content matches a heading", () => {
  const match = best("organic mango");
  assert.equal(match.name, "Organic mango");
});

test("a description contributes to the score", () => {
  const match = best("adds the mango to your basket");
  assert.equal(match.name, "Add to cart");
});

test("an exact name beats a partial one", () => {
  const result = findElements(AX_TREE, "Gift wrap", { refTable: new RefTable() });
  assert.equal(result.matches[0].name, "Gift wrap");
  assert.equal(result.matches[0].role, "checkbox");
});

test("nothing matches a query about a different page", () => {
  const result = findElements(AX_TREE, "quarterly revenue chart", { refTable: new RefTable() });
  assert.equal(result.matches.length, 0);
  assert.equal(renderMatches(result), "No matching elements found.");
});

test("matches carry a ref that maps back to a backend node", () => {
  const refs = new RefTable();
  const result = findElements(AX_TREE, "sign in button", { refTable: refs });
  assert.equal(refs.backendFor(result.matches[0].ref), 4);
});

test("ignored nodes and nodes without a DOM node never match", () => {
  const ignored = AX_TREE.find((node) => node.ignored);
  assert.equal(scoreNode(ignored, "generic"), 0);
  assert.equal(scoreNode({ role: { value: "button" }, name: { value: "Ghost" } }, "ghost"), 0);
});

test("more than 20 matches are capped and the caller is told to narrow the query", () => {
  const nodes = manyButtons(30);
  const result = findElements(nodes, "delete item", { refTable: new RefTable() });
  assert.equal(result.matches.length, MAX_RESULTS);
  assert.equal(result.total, 30);
  const rendered = renderMatches(result);
  assert.equal(rendered.split("\n").filter((line) => line.startsWith("[ref_")).length, MAX_RESULTS);
  assert.match(rendered, /30 elements matched; showing the top 20\. Use a more specific query\./);
});

test("ties keep document order", () => {
  const nodes = manyButtons(5);
  const result = findElements(nodes, "delete", { refTable: new RefTable() });
  assert.deepEqual(
    result.matches.map((match) => match.name),
    ["Delete item 0", "Delete item 1", "Delete item 2", "Delete item 3", "Delete item 4"],
  );
});

test("rendered lines show the ref, the role, the name and any value", () => {
  const result = findElements(AX_TREE, "search products", { refTable: new RefTable() });
  assert.match(renderMatches(result).split("\n")[0], /^\[ref_\d+\] searchbox "Search products" value="mango"$/);
});
