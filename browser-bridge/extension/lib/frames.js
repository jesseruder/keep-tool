// Stitching the accessibility trees of out-of-process iframes into the page's own tree.
//
// Each child target answers Accessibility.getFullAXTree with a tree of its own, numbered
// from 1 like every other tree, so the ids have to be namespaced before they can live in
// one list. The child tree's roots are then hung off the iframe element that hosts them,
// which is found by asking DOM.describeNode for the frame id of each iframe node (the
// caller does that part; this file is pure).
//
// Pure: no chrome APIs, so the tests can splice captured trees.

/** `sessionId::nodeId`, so two trees can share one flat list. */
function namespacedId(sessionId, nodeId) {
  return `${sessionId}::${nodeId}`;
}

/**
 * Copy a child tree with its ids namespaced and every node stamped with the session it
 * came from, which is what lets a ref remember where to send the next command.
 */
export function namespaceNodes(nodes, sessionId) {
  return nodes.map((node) => ({
    ...node,
    nodeId: namespacedId(sessionId, node.nodeId),
    parentId: node.parentId != null ? namespacedId(sessionId, node.parentId) : node.parentId,
    childIds: (node.childIds ?? []).map((childId) => namespacedId(sessionId, childId)),
    frameSessionId: sessionId,
  }));
}

/** The nodes of a tree that nothing else in that tree points at. */
function rootsOf(nodes) {
  const claimed = new Set();
  for (const node of nodes) {
    for (const childId of node.childIds ?? []) claimed.add(childId);
  }
  return nodes.filter((node) => !claimed.has(node.nodeId));
}

/**
 * Splice each attached iframe tree under the iframe node that hosts it.
 *
 * `children` is `[{ sessionId, frameId, nodes }]` and `owners` maps a frame id to
 * `{ sessionId, backendNodeId }` of the iframe element hosting it (sessionId null for the
 * main tree). A child whose host cannot be found is left out and named in `unplaced`:
 * that is a real state (the iframe element may be in a frame we could not read), and
 * read_page says so rather than dropping it silently.
 *
 * Children are placed in passes, so an iframe inside an iframe lands under its own
 * parent rather than at the top.
 */
export function spliceFrameTrees(mainNodes, children = [], owners = new Map()) {
  // Clone the main nodes: the caller's array comes straight from CDP and the splice
  // rewrites childIds.
  const nodes = mainNodes.map((node) => ({ ...node, childIds: [...(node.childIds ?? [])] }));
  const unplaced = [];
  const placed = [];

  let pending = children.filter((child) => Array.isArray(child.nodes) && child.nodes.length > 0);
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    const stillPending = [];
    for (const child of pending) {
      const owner = owners.get(child.frameId);
      const hostIndex = owner
        ? nodes.findIndex(
            (node) =>
              node.backendDOMNodeId === owner.backendNodeId &&
              (node.frameSessionId ?? null) === (owner.sessionId ?? null),
          )
        : -1;
      if (hostIndex === -1) {
        stillPending.push(child);
        continue;
      }
      const spliced = namespaceNodes(child.nodes, child.sessionId);
      const roots = rootsOf(spliced);
      // The frame's own root web area becomes a child of the iframe element, which is
      // exactly how a same-process iframe already reads.
      nodes[hostIndex] = {
        ...nodes[hostIndex],
        childIds: [...nodes[hostIndex].childIds, ...roots.map((root) => root.nodeId)],
      };
      // Insert right after the host so refs keep document order.
      nodes.splice(hostIndex + 1, 0, ...spliced);
      placed.push(child.frameId);
      progress = true;
    }
    pending = stillPending;
  }
  for (const child of pending) unplaced.push(child.frameId);

  return { nodes, placed, unplaced };
}

/**
 * The iframe nodes of a tree worth asking DOM.describeNode about. Chromium calls the role
 * `Iframe` (and `IframePresentational` for a presentational one).
 */
export function iframeNodes(nodes) {
  return nodes.filter(
    (node) => node.backendDOMNodeId != null && /^iframe/i.test(node.role?.value ?? ""),
  );
}
