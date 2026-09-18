// One accessibility tree for a tab, every iframe included.
//
// Accessibility.getFullAXTree answers for a single document, so a page with frames needs
// one call per frame:
//   - an out-of-process iframe has its own auto-attached session (see lib/cdp.js) and is
//     asked through it;
//   - a same-process iframe is part of its parent's session but is still a separate
//     document, so it is asked for by frame id on that session. Without this a
//     same-origin iframe reads as an empty `Iframe` node (measured on Edge 153).
//
// This module collects the trees, works out which iframe element hosts which frame, and
// hands lib/frames.js the pieces to splice into one tree.

import { ensureFrameDomains, frameOwners, frameSessions, send } from "../lib/cdp.js";
import { iframeNodes, spliceFrameTrees } from "../lib/frames.js";

async function treeFor(tabId, sessionId, frameId = null) {
  const response = await send(
    tabId,
    "Accessibility.getFullAXTree",
    frameId ? { frameId } : {},
    sessionId,
  );
  return response?.nodes ?? [];
}

/** Every frame under a Page.getFrameTree result except the root of that tree. */
function descendantFrameIds(frameTree) {
  const out = [];
  const walk = (node) => {
    for (const child of node?.childFrames ?? []) {
      if (child.frame?.id) out.push(child.frame.id);
      walk(child);
    }
  };
  walk(frameTree);
  return out;
}

/**
 * Learn which iframe element hosts each frame, by asking DOM.describeNode for the frame
 * id behind every iframe node. Cached per tab until the main frame navigates: backend
 * node ids are stable within a document and this is one round trip per iframe.
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
 * The same-process child documents of one session: every frame in its frame tree that is
 * not an out-of-process target of its own and has not already been collected.
 */
async function localFramesOf(tabId, sessionId, skip) {
  let frameTree;
  try {
    const response = await send(tabId, "Page.getFrameTree", {}, sessionId);
    frameTree = response?.frameTree;
  } catch {
    return []; // no Page domain on this target: nothing to enumerate
  }
  if (!frameTree) return [];

  const collected = [];
  for (const frameId of descendantFrameIds(frameTree)) {
    if (skip.has(frameId)) continue;
    skip.add(frameId);
    try {
      const nodes = await treeFor(tabId, sessionId, frameId);
      if (nodes.length > 0) collected.push({ sessionId, frameId, nodes, kind: "local" });
    } catch {
      // The main session's frame tree also names frames that live in another process;
      // those come back through their own session, so a refusal here is expected and
      // not worth a note.
    }
  }
  return collected;
}

/**
 * `{ nodes, frames, localFrames, unplaced, errors }`: the spliced tree, how many
 * cross-origin and same-origin frames went into it, the frame ids whose host element
 * could not be found, and anything that went wrong reading a frame.
 */
export async function fullAxTree(tabId) {
  const mainNodes = await treeFor(tabId, null);
  const sessions = frameSessions(tabId);

  const children = [];
  const errors = [];

  // Out-of-process frames first: each answers for itself, and knowing their ids keeps
  // the same-process sweep from asking the wrong session for them.
  const oopifIds = new Set(sessions.map((entry) => entry.frameId));
  for (const { sessionId, frameId } of sessions) {
    try {
      await ensureFrameDomains(tabId, sessionId);
      children.push({ sessionId, frameId, nodes: await treeFor(tabId, sessionId), kind: "oopif" });
    } catch (error) {
      errors.push(`iframe ${frameId}: ${error.message ?? error}`);
    }
  }

  // Then the same-process ones, in the page's session and inside each OOPIF.
  const seen = new Set(oopifIds);
  for (const sessionId of [null, ...sessions.map((entry) => entry.sessionId)]) {
    children.push(...(await localFramesOf(tabId, sessionId, seen)));
  }

  if (children.length === 0) {
    return { nodes: mainNodes, frames: 0, localFrames: 0, unplaced: [], errors };
  }

  const trees = [{ sessionId: null, nodes: mainNodes }, ...children];
  const owners = await resolveOwners(
    tabId,
    trees,
    children.map((child) => child.frameId),
  );
  const { nodes, placed, unplaced } = spliceFrameTrees(mainNodes, children, owners);

  const kindOf = new Map(children.map((child) => [child.frameId, child.kind]));
  const frames = placed.filter((frameId) => kindOf.get(frameId) === "oopif").length;
  return { nodes, frames, localFrames: placed.length - frames, unplaced, errors };
}
