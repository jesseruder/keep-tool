// One accessibility tree for a tab, cross-origin iframes included.
//
// The tab's own session answers for everything in its process; each out-of-process iframe
// has its own auto-attached session (see lib/cdp.js) and answers for itself. This module
// collects them, works out which iframe element hosts which frame, and hands lib/frames.js
// the pieces to splice into one tree.

import { ensureFrameDomains, frameOwners, frameSessions, send } from "../lib/cdp.js";
import { iframeNodes, spliceFrameTrees } from "../lib/frames.js";

async function treeFor(tabId, sessionId) {
  const response = await send(tabId, "Accessibility.getFullAXTree", {}, sessionId);
  return response?.nodes ?? [];
}

/**
 * Learn which iframe element hosts each frame we have a session for, by asking
 * DOM.describeNode for the frame id behind every iframe node. Cached per tab until the
 * main frame navigates: backend node ids are stable within a document and this is one
 * round trip per iframe.
 */
async function resolveOwners(tabId, trees, wanted) {
  const cache = frameOwners(tabId);
  const missing = wanted.filter((frameId) => !cache.has(frameId));
  if (missing.length === 0) return cache;

  for (const { sessionId, nodes } of trees) {
    for (const node of iframeNodes(nodes)) {
      let described;
      try {
        described = await send(
          tabId,
          "DOM.describeNode",
          { backendNodeId: node.backendDOMNodeId },
          sessionId,
        );
      } catch {
        continue; // the element has gone; the frame will simply be unplaced
      }
      const frameId = described?.node?.frameId;
      if (!frameId) continue;
      cache.set(frameId, { sessionId: sessionId ?? null, backendNodeId: node.backendDOMNodeId });
    }
    if (wanted.every((frameId) => cache.has(frameId))) break;
  }
  return cache;
}

/**
 * `{ nodes, frames, unplaced, errors }`: the spliced tree, how many iframe sessions went
 * into it, the frame ids whose host element could not be found, and anything that went
 * wrong reading a frame. A page with no out-of-process iframes takes exactly the path it
 * always took: one getFullAXTree and nothing else.
 */
export async function fullAxTree(tabId) {
  const mainNodes = await treeFor(tabId, null);
  const sessions = frameSessions(tabId);
  if (sessions.length === 0) {
    return { nodes: mainNodes, frames: 0, unplaced: [], errors: [] };
  }

  const children = [];
  const errors = [];
  for (const { sessionId, frameId } of sessions) {
    try {
      await ensureFrameDomains(tabId, sessionId);
      children.push({ sessionId, frameId, nodes: await treeFor(tabId, sessionId) });
    } catch (error) {
      errors.push(`iframe ${frameId}: ${error.message ?? error}`);
    }
  }

  const trees = [{ sessionId: null, nodes: mainNodes }, ...children];
  const owners = await resolveOwners(
    tabId,
    trees,
    children.map((child) => child.frameId),
  );
  const { nodes, placed, unplaced } = spliceFrameTrees(mainNodes, children, owners);
  return { nodes, frames: placed.length, unplaced, errors };
}
