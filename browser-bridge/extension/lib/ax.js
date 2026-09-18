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
 * ref_N <-> `{sessionId, backendDOMNodeId}` for one tab. Stable between calls on the same
 * page so a find() ref still works for the click that follows; reset when the main frame
 * navigates, because backend node ids do not survive a document swap.
 *
 * `sessionId` is null for the tab's own frame tree and the CDP session id of the child
 * target for a node inside an out-of-process iframe: backend node ids are only unique
 * within one session, so the session is part of the identity. When such a frame goes
 * away its refs are marked detached rather than forgotten, so the error can say why.
 */
export class RefTable {
  #byNode = new Map(); // "sessionId|backendId" -> ref
  #byRef = new Map(); // ref -> { sessionId, backendNodeId, detached }
  #next = 1;

  static #key(sessionId, backendId) {
    return `${sessionId ?? ""}|${backendId}`;
  }

  refFor(backendId, sessionId = null) {
    if (backendId == null) return null;
    const key = RefTable.#key(sessionId, backendId);
    const existing = this.#byNode.get(key);
    if (existing) return existing;
    const ref = `ref_${this.#next++}`;
    this.#byNode.set(key, ref);
    this.#byRef.set(ref, { sessionId: sessionId ?? null, backendNodeId: backendId, detached: false });
    return ref;
  }

  /** `{sessionId, backendNodeId, detached}`, or null for a ref this table never gave out. */
  targetFor(ref) {
    return this.#byRef.get(String(ref)) ?? null;
  }

  /** The backend node id alone, for callers that only ever deal with the main frame. */
  backendFor(ref) {
    return this.#byRef.get(String(ref))?.backendNodeId ?? null;
  }

  /** An iframe target detached: its refs can never resolve again. */
  invalidateSession(sessionId) {
    if (!sessionId) return 0;
    let count = 0;
    for (const target of this.#byRef.values()) {
      if (target.sessionId !== sessionId || target.detached) continue;
      target.detached = true;
      // The node key goes, so a frame that re-attaches gets fresh refs rather than
      // silently inheriting the dead ones.
      this.#byNode.delete(RefTable.#key(sessionId, target.backendNodeId));
      count += 1;
    }
    return count;
  }

  reset() {
    this.#byNode.clear();
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

/**
 * Which CDP session a node came from. lib/frames.js stamps this on the nodes it splices
 * in from an out-of-process iframe; a node from the tab's own tree has none.
 */
export function sessionOf(node) {
  return node?.frameSessionId ?? null;
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
    if (node.backendDOMNodeId != null) refTable.refFor(node.backendDOMNodeId, sessionOf(node));
  }

  let startNodes = roots;
  if (rootRef) {
    const target = refTable.targetFor(rootRef);
    if (!target) return { error: `Unknown ref: ${rootRef}` };
    const found = axNodes.find(
      (node) => node.backendDOMNodeId === target.backendNodeId && sessionOf(node) === target.sessionId,
    );
    if (!found) return { error: `Unknown ref: ${rootRef}` };
    startNodes = [found];
  }

  const out = [];
  const seen = new Set();
  const visit = (node, depth) => {
    if (!node || seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    const ref =
      node.backendDOMNodeId != null ? refTable.refFor(node.backendDOMNodeId, sessionOf(node)) : null;
    // InlineTextBox nodes repeat their StaticText parent line by line: pure noise.
    const noise = node.ignored || roleOf(node) === "InlineTextBox";
    const keep = !noise && (filter !== "interactive" || isInteractive(node));
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
