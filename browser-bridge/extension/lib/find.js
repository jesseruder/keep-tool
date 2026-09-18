// Lexical element search over the accessibility tree.
//
// This is deliberately a scoring heuristic, not a model: the tool description says so.
// Pure, so the tests can score a captured tree without a browser.

import { RefTable, isInteractive, nameOf, roleOf, valueOf } from "./ax.js";

const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "to", "in", "on", "at", "with", "that", "this", "my", "please",
]);

/** Words a model uses for a role -> the AX roles they mean. */
export const ROLE_WORDS = {
  button: ["button"],
  btn: ["button"],
  link: ["link"],
  anchor: ["link"],
  input: ["textbox", "searchbox", "combobox", "spinbutton"],
  field: ["textbox", "searchbox", "combobox", "spinbutton"],
  textbox: ["textbox"],
  textarea: ["textbox"],
  box: ["textbox", "searchbox", "combobox", "checkbox"],
  bar: ["searchbox", "textbox"],
  search: ["searchbox", "textbox", "search"],
  checkbox: ["checkbox"],
  check: ["checkbox"],
  radio: ["radio", "radiogroup"],
  dropdown: ["combobox", "listbox", "menu"],
  select: ["combobox", "listbox"],
  combobox: ["combobox"],
  menu: ["menu", "menuitem", "menubar"],
  menuitem: ["menuitem"],
  tab: ["tab", "tablist"],
  image: ["image", "img"],
  img: ["image"],
  icon: ["image", "button"],
  heading: ["heading"],
  title: ["heading"],
  header: ["heading", "banner"],
  list: ["list", "listbox"],
  item: ["listitem", "menuitem", "option"],
  option: ["option"],
  slider: ["slider"],
  switch: ["switch"],
  toggle: ["switch", "checkbox"],
  table: ["table", "grid"],
  row: ["row"],
  cell: ["cell", "gridcell"],
  form: ["form"],
  dialog: ["dialog", "alertdialog"],
  text: ["StaticText", "textbox"],
};

export function tokenize(query) {
  return String(query)
    .toLowerCase()
    .split(/[^a-z0-9@.'-]+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

function haystack(node) {
  return [nameOf(node), roleOf(node), valueOf(node), node.description?.value ?? ""]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Higher is better; 0 means "not a match at all". */
export function scoreNode(node, query, tokens = tokenize(query)) {
  if (node.ignored) return 0;
  if (node.backendDOMNodeId == null) return 0;

  const role = roleOf(node).toLowerCase();
  const name = nameOf(node).toLowerCase();
  const value = valueOf(node).toLowerCase();
  const description = String(node.description?.value ?? "").toLowerCase();
  const all = haystack(node);
  const phrase = String(query).toLowerCase().trim();
  if (!phrase) return 0;

  let score = 0;
  let roleWordUsed = false;
  let matchedTokens = 0;

  if (name && name === phrase) score += 100;
  else if (name && name.includes(phrase)) score += 60;
  else if (all.includes(phrase)) score += 35;

  for (const token of tokens) {
    let hit = false;
    const roles = ROLE_WORDS[token];
    if (roles && roles.some((candidate) => candidate.toLowerCase() === role)) {
      score += 20;
      roleWordUsed = true;
      hit = true;
    }
    if (name.includes(token)) {
      score += name.split(/\s+/).includes(token) ? 14 : 9;
      hit = true;
    }
    if (value.includes(token)) {
      score += 6;
      hit = true;
    }
    if (description.includes(token)) {
      score += 4;
      hit = true;
    }
    if (hit) matchedTokens += 1;
  }

  if (score === 0) return 0;
  if (tokens.length > 1 && matchedTokens === tokens.length) score += 25;
  // A query naming a role should not surface a paragraph that merely contains the word.
  if (roleWordUsed || isInteractive(node)) score += 5;
  // Long names match by accident more often than short ones.
  score -= Math.min(6, Math.floor(name.length / 120));
  return Math.max(score, 1);
}

export const MAX_RESULTS = 20;

/**
 * Returns the best matches in score order, document order breaking ties.
 * `total` is the number of scoring nodes, so the caller can say "narrow the query".
 */
export function findElements(axNodes, query, options = {}) {
  const { limit = MAX_RESULTS, refTable = new RefTable() } = options;
  const tokens = tokenize(query);

  for (const node of axNodes) {
    if (node.backendDOMNodeId != null) refTable.refFor(node.backendDOMNodeId);
  }

  const scored = [];
  axNodes.forEach((node, index) => {
    const score = scoreNode(node, query, tokens);
    if (score <= 0) return;
    scored.push({
      score,
      index,
      ref: refTable.refFor(node.backendDOMNodeId),
      role: roleOf(node) || "node",
      name: nameOf(node),
      value: valueOf(node),
      node,
    });
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return { matches: scored.slice(0, limit), total: scored.length, refTable };
}

export function renderMatches(result) {
  if (result.matches.length === 0) return "No matching elements found.";
  const lines = result.matches.map((match) => {
    const parts = [`[${match.ref}]`, match.role];
    if (match.name) parts.push(JSON.stringify(match.name));
    if (match.value) parts.push(`value=${JSON.stringify(match.value.slice(0, 120))}`);
    return parts.join(" ");
  });
  if (result.total > result.matches.length) {
    lines.push(
      `\n${result.total} elements matched; showing the top ${result.matches.length}. Use a more specific query.`,
    );
  }
  return lines.join("\n");
}
