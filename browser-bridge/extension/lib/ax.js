// Accessibility tree rendering: CDP Accessibility.getFullAXTree nodes -> the indented
// `[ref_12] button "Sign in" focusable` text the model reads, plus the ref table that
// maps those refs back to backend DOM node ids.
//
// Pure: no chrome APIs, so the tests can feed it a captured tree.

export const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
  "menu",
  "menubar",
  "radiogroup",
]);

/** Properties worth printing; anything else is noise for the model. */
const SHOWN_PROPERTIES = [
  "focusable",
  "focused",
  "disabled",
  "checked",
  "expanded",
  "selected",
  "pressed",
  "required",
  "invalid",
  "readonly",
  "multiselectable",
  "level",
];

/**
 * ref_N <-> backendDOMNodeId for one tab. Stable between calls on the same page so a
 * find() ref still works for the click that follows; reset when the main frame
 * navigates, because backend node ids do not survive a document swap.
 */
export class RefTable {
  #byBackend = new Map();
  #byRef = new Map();
  #next = 1;

  refFor(backendId) {
    if (backendId == null) return null;
    const existing = this.#byBackend.get(backendId);
    if (existing) return existing;
    const ref = `ref_${this.#next++}`;
    this.#byBackend.set(backendId, ref);
    this.#byRef.set(ref, backendId);
    return ref;
  }

  backendFor(ref) {
    return this.#byRef.get(String(ref)) ?? null;
  }

  reset() {
    this.#byBackend.clear();
    this.#byRef.clear();
    this.#next = 1;
  }

  get size() {
    return this.#byRef.size;
  }
}

function propertyMap(node) {
  const out = new Map();
  for (const property of node.properties ?? []) {
    out.set(property.name, property.value?.value);
  }
  return out;
}

export function roleOf(node) {
  return node?.role?.value ?? "";
}

export function nameOf(node) {
  const value = node?.name?.value;
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function valueOf(node) {
  const value = node?.value?.value;
  if (value === undefined || value === null || value === "") return "";
  return String(value).replace(/\s+/g, " ").trim();
}

export function isInteractive(node) {
  const role = roleOf(node);
  if (INTERACTIVE_ROLES.has(role)) return true;
  // Anything the page made focusable is something the model can act on.
  return propertyMap(node).get("focusable") === true;
}

/** One rendered line, without indentation. */
export function describeNode(node, ref) {
  const parts = [];
  if (ref) parts.push(`[${ref}]`);
  parts.push(roleOf(node) || "node");
  const name = nameOf(node);
  if (name) parts.push(JSON.stringify(name));
  const value = valueOf(node);
  if (value) parts.push(`value=${JSON.stringify(value.slice(0, 200))}`);

  const properties = propertyMap(node);
  for (const key of SHOWN_PROPERTIES) {
    if (!properties.has(key)) continue;
    const raw = properties.get(key);
    if (raw === false || raw === undefined || raw === "false" || raw === "none") continue;
    parts.push(raw === true || raw === "true" ? key : `${key}=${raw}`);
  }
  if (node.ignored) parts.push("(ignored)");
  return parts.join(" ");
}

function indexTree(axNodes) {
  const byId = new Map();
  for (const node of axNodes) byId.set(node.nodeId, node);
  const childOf = new Set();
  for (const node of axNodes) {
    for (const childId of node.childIds ?? []) childOf.add(childId);
  }
  const roots = axNodes.filter((node) => !childOf.has(node.nodeId));
  return { byId, roots };
}

export function countIframes(axNodes) {
  return axNodes.filter((node) => /^iframe/i.test(roleOf(node))).length;
}

/**
 * Walk the tree, skipping ignored nodes but keeping their children, and emit
 * `{depth, ref, node}` for everything that passes the filter.
 */
export function collectNodes(axNodes, options = {}) {
  const { filter = "all", maxDepth = 15, rootRef = null, refTable = new RefTable() } = options;
  const { byId, roots } = indexTree(axNodes);

  // Assign refs in document order first, so ref numbers are stable regardless of
  // which subtree this call renders.
  for (const node of axNodes) {
    if (node.backendDOMNodeId != null) refTable.refFor(node.backendDOMNodeId);
  }

  let startNodes = roots;
  if (rootRef) {
    const backendId = refTable.backendFor(rootRef);
    if (backendId == null) return { error: `Unknown ref: ${rootRef}` };
    const found = axNodes.find((node) => node.backendDOMNodeId === backendId);
    if (!found) return { error: `Unknown ref: ${rootRef}` };
    startNodes = [found];
  }

  const out = [];
  const seen = new Set();
  const visit = (node, depth) => {
    if (!node || seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    const ref = node.backendDOMNodeId != null ? refTable.refFor(node.backendDOMNodeId) : null;
    const keep = !node.ignored && (filter !== "interactive" || isInteractive(node));
    if (keep) out.push({ depth, ref, node });
    const childDepth = keep ? depth + 1 : depth;
    if (childDepth > maxDepth) return;
    for (const childId of node.childIds ?? []) visit(byId.get(childId), childDepth);
  };
  for (const node of startNodes) visit(node, 0);
  return { nodes: out, refTable };
}

/**
 * Render for read_page. Truncates at a line boundary and says how much was cut, so the
 * model can ask again with a bigger max_chars or a narrower ref_id.
 */
export function renderAxTree(axNodes, options = {}) {
  const { maxChars = 50000 } = options;
  const collected = collectNodes(axNodes, options);
  if (collected.error) return collected;

  const lines = collected.nodes.map(
    ({ depth, ref, node }) => `${"  ".repeat(depth)}${describeNode(node, ref)}`,
  );
  const full = lines.join("\n");
  if (full.length <= maxChars) {
    return { text: full, truncated: false, fullLength: full.length, lineCount: lines.length };
  }

  let used = 0;
  const kept = [];
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  return {
    text: kept.join("\n"),
    truncated: true,
    fullLength: full.length,
    lineCount: lines.length,
    keptLines: kept.length,
  };
}
