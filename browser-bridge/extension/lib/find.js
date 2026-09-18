// Lexical element search over the accessibility tree.
//
// This is deliberately a scoring heuristic, not a model: the tool description says so.
// It knows three tricks beyond plain token matching, in decreasing confidence —
// stemming ("buttons" finds "button"), a synonym table ("basket" finds "cart") and
// fuzzy matching (a prefix, or a typo within Damerau-Levenshtein distance) — and every
// match carries which trick found it, so an exact hit always outranks a guess.
//
// Pure, so the tests can score a captured tree without a browser.

import { RefTable, isInteractive, nameOf, roleOf, valueOf } from "./ax.js";

const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "to", "in", "on", "at", "with", "that", "this", "my", "please",
]);

/**
 * Two-word forms collapsed into the single token their one-word spelling uses, on both
 * the query and the element text, so "sign in" and "signin" are the same thing and the
 * "in" is not thrown away as a stopword.
 */
const PHRASES = [
  [/\bsign\s+in\b/g, "signin"],
  [/\blog\s+in\b/g, "login"],
  [/\bsign\s+out\b/g, "signout"],
  [/\blog\s+out\b/g, "logout"],
  [/\be[-\s]mail\b/g, "email"],
];

/** Words that mean the same thing to a model asking for an element. */
export const SYNONYM_GROUPS = [
  ["search", "find", "lookup"],
  ["login", "signin"],
  ["logout", "signout"],
  ["submit", "send", "go", "ok"],
  ["close", "dismiss", "x"],
  ["menu", "hamburger", "navigation", "nav"],
  ["checkbox", "toggle", "switch"],
  ["dropdown", "select", "combobox", "picker"],
  ["image", "picture", "photo", "img"],
  ["delete", "remove", "trash"],
  ["edit", "modify", "change"],
  ["next", "continue", "proceed"],
  ["back", "previous", "prev"],
  ["email", "mail"],
  ["password", "pass", "passcode"],
  ["username", "user", "account"],
  ["cart", "basket", "bag"],
  ["buy", "purchase", "checkout"],
  ["save", "apply"],
  ["cancel", "abort"],
  ["settings", "preferences", "options", "config"],
  ["help", "support"],
  ["home", "main"],
  ["more", "expand"],
  ["less", "collapse"],
];

const SYNONYMS = new Map();
for (const group of SYNONYM_GROUPS) {
  for (const word of group) {
    const alternates = SYNONYMS.get(word) ?? new Set();
    for (const other of group) {
      if (other !== word) alternates.add(other);
    }
    SYNONYMS.set(word, alternates);
  }
}

/** Lower case, with the two-word forms folded together. */
export function normalizeText(text) {
  let out = String(text ?? "").toLowerCase();
  for (const [pattern, replacement] of PHRASES) out = out.replace(pattern, replacement);
  return out;
}

const SUFFIXES = ["ing", "ed", "es", "s"];

/**
 * Crude suffix stripping, not a real stemmer: "products" -> "product",
 * "loading" -> "load", "saved" -> "sav". Applied to both sides, so it only has to be
 * consistent, not linguistically right.
 */
export function stem(token) {
  const word = String(token);
  for (const suffix of SUFFIXES) {
    if (word.length - suffix.length >= 3 && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
}

/**
 * Every form of a word worth comparing: itself, the stripped stem, and the stem with an
 * "e" put back, because stripping alone leaves "saved" as "sav" and would never meet
 * "Save". Two words match when their variant sets overlap, so the comparison works in
 * both directions ("saved" finds "Save", "save" finds "Saved").
 */
export function stemVariants(token) {
  const word = String(token);
  const variants = new Set([word]);
  for (const suffix of SUFFIXES) {
    if (word.length - suffix.length >= 3 && word.endsWith(suffix)) {
      const base = word.slice(0, -suffix.length);
      variants.add(base);
      if (suffix === "ing" || suffix === "ed") variants.add(`${base}e`);
      break;
    }
  }
  return variants;
}

function overlaps(a, b) {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

/** How far a typo may be from the real word, by the length of what was typed. */
export function fuzzyBudget(token) {
  if (token.length >= 8) return 2;
  if (token.length >= 5) return 1;
  return 0;
}

const PREFIX_MIN = 4;

/**
 * Damerau-Levenshtein (optimal string alignment) distance, bounded: anything over `max`
 * comes back as max + 1, which is all the caller needs and lets the rows bail out early.
 */
export function editDistance(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previousPrevious = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      // The transposition rule: "recieve" is one edit from "receive", not two.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, previousPrevious[j - 2] + 1);
      }
      current[j] = value;
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    previousPrevious = previous;
    previous = current;
  }
  return previous[b.length];
}

/** True when `token` is a prefix of `word` or the other way round. */
function prefixMatch(token, word) {
  if (token.length < PREFIX_MIN || word.length < PREFIX_MIN) return false;
  return word.startsWith(token) || token.startsWith(word);
}

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
  return normalizeText(query)
    .split(/[^a-z0-9@.'-]+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

function haystack(node) {
  return normalizeText(
    [nameOf(node), roleOf(node), valueOf(node), node.description?.value ?? ""].filter(Boolean).join(" "),
  );
}

/** A field prepared once per node: its text, its words and their stems. */
function field(text) {
  const normalized = normalizeText(text);
  const words = normalized.split(/[^a-z0-9@.'-]+/).filter(Boolean);
  return { text: normalized, words, variants: words.map(stemVariants) };
}

/** Does any word of the field share a stem variant with `token`? */
function stemHit(token, prepared) {
  const wanted = stemVariants(token);
  return prepared.variants.some((variants) => overlaps(variants, wanted));
}

// How a token matched, best first. Weights per field below are in the same order, so an
// exact hit always beats a stem, a stem beats a synonym and a synonym beats a typo.
const KINDS = ["exact", "stemmed", "synonym", "fuzzy"];

const NAME_WORD_SCORES = { exact: 14, stemmed: 11, synonym: 8, fuzzy: 5 };
const NAME_PART_SCORES = { exact: 9, stemmed: 7, synonym: 5, fuzzy: 3 };
const VALUE_SCORES = { exact: 6, stemmed: 5, synonym: 4, fuzzy: 2 };
const DESCRIPTION_SCORES = { exact: 4, stemmed: 3, synonym: 2, fuzzy: 1 };

function synonymsFor(token) {
  const direct = SYNONYMS.get(token);
  const stemmed = SYNONYMS.get(stem(token));
  if (!direct && !stemmed) return [];
  return [...new Set([...(direct ?? []), ...(stemmed ?? [])])];
}

/**
 * The best way `token` matches one field: `{kind, whole}` where `whole` means it lined up
 * with a word rather than landing inside one. null when it does not match at all.
 */
function fieldMatch(token, prepared) {
  if (!prepared.text) return null;
  if (prepared.words.includes(token)) return { kind: "exact", whole: true };
  if (prepared.text.includes(token)) return { kind: "exact", whole: false };

  const stemmedToken = stem(token);
  if (stemHit(token, prepared)) return { kind: "stemmed", whole: true };
  if (stemmedToken !== token && prepared.text.includes(stemmedToken)) {
    return { kind: "stemmed", whole: false };
  }

  for (const alternate of synonymsFor(token)) {
    if (prepared.words.includes(alternate) || stemHit(alternate, prepared)) {
      return { kind: "synonym", whole: true };
    }
    if (prepared.text.includes(alternate)) return { kind: "synonym", whole: false };
  }

  const budget = fuzzyBudget(token);
  for (const word of prepared.words) {
    if (prefixMatch(token, word)) return { kind: "fuzzy", whole: true };
    if (budget > 0 && editDistance(token, word, budget) <= budget) {
      return { kind: "fuzzy", whole: true };
    }
  }
  return null;
}

/**
 * A role word in the query ("button", "dropdown") means the role, not the text. The
 * table is reached through the same three tricks as the text: "dropdowns" (stem),
 * "picker" (synonym) and "buton" (typo) all mean a combobox or a button.
 */
function roleMatch(token, role) {
  if (!role) return null;
  const matches = (word) => ROLE_WORDS[word]?.some((wanted) => wanted.toLowerCase() === role);
  if (matches(token)) return "exact";
  for (const variant of stemVariants(token)) {
    if (variant !== token && matches(variant)) return "stemmed";
  }
  for (const alternate of synonymsFor(token)) {
    if (matches(alternate)) return "synonym";
  }
  const budget = fuzzyBudget(token);
  for (const word of Object.keys(ROLE_WORDS)) {
    if (!matches(word)) continue;
    if (prefixMatch(token, word)) return "fuzzy";
    if (budget > 0 && editDistance(token, word, budget) <= budget) return "fuzzy";
  }
  return null;
}

const ROLE_SCORES = { exact: 20, stemmed: 16, synonym: 14, fuzzy: 10 };

function better(a, b) {
  if (!a) return b;
  if (!b) return a;
  return KINDS.indexOf(a.kind) <= KINDS.indexOf(b.kind) ? a : b;
}

/** Higher is better; 0 means "not a match at all". */
export function scoreNode(node, query, tokens = tokenize(query)) {
  if (node.ignored) return 0;
  if (node.backendDOMNodeId == null) return 0;

  const role = roleOf(node).toLowerCase();
  const name = field(nameOf(node));
  const value = field(valueOf(node));
  const description = field(node.description?.value ?? "");
  const all = haystack(node);
  const phrase = normalizeText(query).trim();
  if (!phrase) return 0;

  let score = 0;
  let roleWordUsed = false;
  let matchedTokens = 0;
  let fuzzyOnlyTokens = 0;

  if (name.text && name.text === phrase) score += 100;
  else if (name.text && name.text.includes(phrase)) score += 60;
  else if (all.includes(phrase)) score += 35;

  for (const token of tokens) {
    let best = null;

    const byRole = roleMatch(token, role);
    if (byRole) {
      score += ROLE_SCORES[byRole];
      roleWordUsed = true;
      best = better(best, { kind: byRole, whole: true });
    }

    const inName = fieldMatch(token, name);
    if (inName) {
      score += (inName.whole ? NAME_WORD_SCORES : NAME_PART_SCORES)[inName.kind];
      best = better(best, inName);
    }
    const inValue = fieldMatch(token, value);
    if (inValue) {
      score += VALUE_SCORES[inValue.kind];
      best = better(best, inValue);
    }
    const inDescription = fieldMatch(token, description);
    if (inDescription) {
      score += DESCRIPTION_SCORES[inDescription.kind];
      best = better(best, inDescription);
    }

    if (best) {
      matchedTokens += 1;
      if (best.kind === "fuzzy") fuzzyOnlyTokens += 1;
    }
  }

  if (score === 0) return 0;
  // One near-miss word out of several is a coincidence, not a match: "chart" should not
  // drag in "cart" when the rest of the query ("quarterly revenue") matches nothing.
  if (fuzzyOnlyTokens === matchedTokens && matchedTokens * 2 < tokens.length) return 0;
  if (tokens.length > 1 && matchedTokens === tokens.length) score += 25;
  // A query naming a role should not surface a paragraph that merely contains the word.
  if (roleWordUsed || isInteractive(node)) score += 5;
  // Long names match by accident more often than short ones.
  score -= Math.min(6, Math.floor(name.text.length / 120));
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
