import assert from "node:assert/strict";
import test from "node:test";

import { RefTable } from "../extension/lib/ax.js";
import {
  MAX_RESULTS,
  editDistance,
  findElements,
  fuzzyBudget,
  normalizeText,
  renderMatches,
  scoreNode,
  stem,
  stemVariants,
  tokenize,
} from "../extension/lib/find.js";
import { AX_TREE, manyButtons } from "./fixtures/ax-tree.js";

function best(query) {
  const result = findElements(AX_TREE, query, { refTable: new RefTable() });
  return result.matches[0] ?? null;
}

/** A tiny page of siblings, for the cases the shop fixture has no element for. */
function pageOf(children) {
  const nodes = [
    {
      nodeId: "root",
      role: { value: "RootWebArea" },
      name: { value: "Page" },
      childIds: children.map((_, index) => `n${index}`),
      backendDOMNodeId: 1,
      ignored: false,
    },
  ];
  children.forEach(([role, name], index) => {
    nodes.push({
      nodeId: `n${index}`,
      role: { value: role },
      name: { value: name },
      childIds: [],
      backendDOMNodeId: 100 + index,
      ignored: false,
      properties: [{ name: "focusable", value: { type: "boolean", value: true } }],
    });
  });
  return nodes;
}

function ranked(nodes, query) {
  return findElements(nodes, query, { refTable: new RefTable() }).matches.map((match) => match.name);
}

test("tokenize drops stopwords and punctuation", () => {
  // "sign in" is folded into one token: the "in" would otherwise be dropped as a
  // stopword and the query would just be "sign".
  assert.deepEqual(tokenize("the Sign In button!"), ["signin", "button"]);
  assert.deepEqual(tokenize("log in please"), ["login"]);
  assert.deepEqual(tokenize("my e-mail address"), ["email", "address"]);
  assert.deepEqual(tokenize("  "), []);
  assert.equal(normalizeText("Sign Out of your Account"), "signout of your account");
});

test("stemming strips the suffixes it claims to", () => {
  assert.equal(stem("products"), "product");
  assert.equal(stem("searching"), "search");
  assert.equal(stem("boxes"), "box");
  // Too short to strip: "yes" must not become "y".
  assert.equal(stem("yes"), "yes");
  assert.equal(stem("is"), "is");
  // Stripping alone leaves "saved" as "sav", so the variants put the "e" back and the
  // two sides meet on "save".
  assert.deepEqual([...stemVariants("saved")].sort(), ["sav", "save", "saved"]);
  assert.ok(stemVariants("saving").has("save"));
  assert.deepEqual([...stemVariants("cart")], ["cart"]);
});

test("edit distance counts a transposition as one edit and bails out over the budget", () => {
  assert.equal(editDistance("organci", "organic"), 1);
  assert.equal(editDistance("buton", "button"), 1);
  assert.equal(editDistance("recieve", "receive"), 1);
  assert.equal(editDistance("cart", "cart"), 0);
  assert.equal(editDistance("cart", "elephant", 2), 3, "over the budget, reported as budget + 1");
  assert.deepEqual([fuzzyBudget("cart"), fuzzyBudget("carts"), fuzzyBudget("password")], [0, 1, 2]);
});

test("exact beats stemmed beats synonym beats fuzzy", () => {
  const nodes = pageOf([
    ["textbox", "Passcode"],
    ["textbox", "Pasword"],
    ["textbox", "Passwords"],
    ["textbox", "Password"],
  ]);
  // Deliberately in the wrong order in the document, so only the scoring can sort them.
  assert.deepEqual(ranked(nodes, "password"), ["Password", "Passwords", "Passcode", "Pasword"]);
});

test("a synonym in the query finds the element that uses the other word", () => {
  const match = best("basket");
  assert.equal(match.name, "Add to cart");
  assert.deepEqual(ranked(pageOf([["button", "Log out"]]), "sign out"), ["Log out"]);
  assert.deepEqual(ranked(pageOf([["button", "Remove"]]), "delete"), ["Remove"]);
  assert.deepEqual(ranked(pageOf([["link", "Preferences"]]), "settings"), ["Preferences"]);
});

test("a role word reaches the role table through a synonym, a stem and a typo", () => {
  const nodes = pageOf([
    ["combobox", "Country"],
    ["StaticText", "Country of residence"],
  ]);
  assert.equal(ranked(nodes, "country picker")[0], "Country", "picker means combobox");
  assert.equal(ranked(nodes, "country dropdowns")[0], "Country", "a plural role word still means it");
  assert.equal(best("buton").role, "button", "and a typo'd role word still names the role");
});

test("a stemmed query still finds the element", () => {
  assert.equal(best("searching product").role, "searchbox");
  assert.deepEqual(ranked(pageOf([["button", "Save"]]), "saving"), ["Save"]);
});

test("a typo inside the query still finds the element", () => {
  assert.equal(best("organci mangoo").name, "Organic mango");
  assert.equal(best("sign in buton").role, "button");
});

test("one near-miss word in a longer query is not a match", () => {
  // "chart" is one edit from "cart", but the rest of the query matches nothing, so the
  // "Add to cart" link is a coincidence rather than an answer.
  const result = findElements(AX_TREE, "quarterly revenue chart", { refTable: new RefTable() });
  assert.equal(result.matches.length, 0);
  // On its own, the same typo is exactly what fuzzy matching is for.
  assert.equal(best("chart").name, "Add to cart");
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
