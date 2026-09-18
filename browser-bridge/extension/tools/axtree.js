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

// How hard to chase a page whose frames keep changing while it is being read.
const MAX_FRAME_ROUNDS = 8;
export const FRAME_WALK_BUDGET_MS = 5000;

/** Thrown when the walk runs out of time; never reaches a caller. */
class BudgetExpired extends Error {}

/**
 * A clock the whole walk shares. Every read is raced against what is left of it, so
 * neither a hundred slow frames nor one stalled CDP call can hold the tree hostage: the
 * budget is checked *before* each await and enforced *during* it.
 */
function walkBudget(totalMs) {
  const deadline = Date.now() + totalMs;
  return {
    get expired() {
      return Date.now() >= deadline;
    },
    /** `promise`, or BudgetExpired. A losing promise is swallowed, never left unhandled. */
    async guard(promise) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new BudgetExpired();
      const settled = promise.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remaining);
      });
      try {
        const outcome = await Promise.race([settled, timeout]);
        if (outcome === "timeout") throw new BudgetExpired();
        if (outcome.error) throw outcome.error;
        return outcome.value;
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    },
  };
}

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
async function resolveOwners(tabId, trees, wanted, budget) {
  const cache = frameOwners(tabId);
  const missing = wanted.filter((frameId) => !cache.has(frameId));
  if (missing.length === 0) return { cache, stopped: false };

  for (const { sessionId, nodes } of trees) {
    for (const node of iframeNodes(nodes)) {
      let described;
      try {
        described = await budget.guard(
          send(tabId, "DOM.describeNode", { backendNodeId: node.backendDOMNodeId }, sessionId),
        );
      } catch (error) {
        // Out of time: whatever is still unresolved becomes an unplaced frame, and the
        // result says the page was not read whole.
        if (error instanceof BudgetExpired) return { cache, stopped: true };
        continue; // the element has gone; the frame will simply be unplaced
      }
      const frameId = described?.node?.frameId;
      if (!frameId) continue;
      cache.set(frameId, { sessionId: sessionId ?? null, backendNodeId: node.backendDOMNodeId });
    }
    if (wanted.every((frameId) => cache.has(frameId))) break;
  }
  return { cache, stopped: false };
}

/**
 * The same-process child documents of one session: every frame in its frame tree that is
 * not an out-of-process target of its own and has not already been collected.
 */
async function localFramesOf(tabId, sessionId, skip, budget) {
  let frameTree;
  try {
    const response = await budget.guard(send(tabId, "Page.getFrameTree", {}, sessionId));
    frameTree = response?.frameTree;
  } catch (error) {
    // No Page domain on this target: nothing to enumerate. Out of time: nothing more.
    return { collected: [], stopped: error instanceof BudgetExpired };
  }
  if (!frameTree) return { collected: [], stopped: false };

  const collected = [];
  for (const frameId of descendantFrameIds(frameTree)) {
    if (skip.has(frameId)) continue;
    if (budget.expired) return { collected, stopped: true };
    try {
      const nodes = await budget.guard(treeFor(tabId, sessionId, frameId));
      if (nodes.length === 0) continue;
      // Only a frame that actually answered is done with. The main session's frame tree
      // also names frames that live in another process: asking there fails (or returns
      // nothing), and the session that owns the frame must still get its turn.
      skip.add(frameId);
      collected.push({ sessionId, frameId, nodes, kind: "local" });
    } catch (error) {
      if (error instanceof BudgetExpired) return { collected, stopped: true };
      // Expected for a frame in another process; not worth a note.
    }
  }
  return { collected, stopped: false };
}

/**
 * `{ nodes, frames, localFrames, unplaced, errors, unsettled }`: the spliced tree, how many
 * cross-origin and same-origin frames went into it, the frame ids whose host element
 * could not be found, anything that went wrong reading a frame, and whether the page was
 * still adding frames when the walk gave up.
 */
export async function fullAxTree(tabId, { budgetMs = FRAME_WALK_BUDGET_MS } = {}) {
  const budget = walkBudget(budgetMs);

  // The page's own tree is under the same clock as the frames: a busy or blocked main
  // renderer (or an attach that never completes) would otherwise hang the tool with no
  // bound at all. There is nothing to fall back on if this one does not answer, so it is
  // an error rather than a partial result.
  let mainNodes;
  try {
    mainNodes = await budget.guard(treeFor(tabId, null));
  } catch (error) {
    if (error instanceof BudgetExpired) {
      throw new Error(
        `This page did not return its accessibility tree within ${budgetMs} ms; its renderer may be busy or blocked. Try again, or use get_page_text or a screenshot instead.`,
      );
    }
    throw error;
  }

  const children = [];
  const errors = [];

  // Out-of-process frames first: each answers for itself, and knowing their ids keeps
  // the same-process sweep from asking the wrong session for them.
  //
  // In rounds, because auto-attach is not recursive: arming it inside a frame (which
  // ensureFrameDomains does) is what makes that frame's own out-of-process children
  // attach, so the list grows while it is being walked. Each session is handled once, so
  // this ends when a round turns up nothing new.
  const oopifIds = new Set();
  const doneSessions = new Set();
  // A page that keeps tearing down and re-creating cross-origin iframes hands out fresh
  // sessions for as long as anyone keeps asking, so the walk is bounded three ways - the
  // rounds, the shared clock, and a race on every single read - and the result says when
  // it stopped early.
  let unsettled = false;
  let stopped = false;
  for (let round = 0; !stopped; round++) {
    if (round >= MAX_FRAME_ROUNDS || budget.expired) {
      unsettled = frameSessions(tabId).some((entry) => !doneSessions.has(entry.sessionId));
      break;
    }
    let pending = frameSessions(tabId).filter((entry) => !doneSessions.has(entry.sessionId));
    if (pending.length === 0 && doneSessions.size > 0) {
      // An attach event that the browser has already sent may still be on its way to the
      // worker. One turn of the event loop costs nothing and saves a grandchild frame
      // from missing this read and only showing up on the next one.
      await new Promise((resolve) => setTimeout(resolve, 0));
      pending = frameSessions(tabId).filter((entry) => !doneSessions.has(entry.sessionId));
    }
    if (pending.length === 0) break;
    for (const { sessionId, frameId } of pending) {
      // Inside the round too: a hundred frames at half a second each would otherwise run
      // for a minute between two round checks.
      if (budget.expired) {
        stopped = true;
        break;
      }
      doneSessions.add(sessionId);
      oopifIds.add(frameId);
      try {
        await budget.guard(ensureFrameDomains(tabId, sessionId));
        children.push({
          sessionId,
          frameId,
          nodes: await budget.guard(treeFor(tabId, sessionId)),
          kind: "oopif",
        });
      } catch (error) {
        if (error instanceof BudgetExpired) {
          stopped = true;
          break;
        }
        errors.push(`iframe ${frameId}: ${error.message ?? error}`);
      }
    }
  }
  if (stopped) unsettled = true;

  // Then the same-process ones, in the page's session and inside each frame session.
  const seen = new Set(oopifIds);
  for (const sessionId of [null, ...doneSessions]) {
    if (stopped) break;
    const local = await localFramesOf(tabId, sessionId, seen, budget);
    children.push(...local.collected);
    if (local.stopped) {
      stopped = true;
      unsettled = true;
    }
  }

  if (children.length === 0) {
    return { nodes: mainNodes, frames: 0, localFrames: 0, unplaced: [], errors, unsettled };
  }

  const trees = [{ sessionId: null, nodes: mainNodes }, ...children];
  const resolved = await resolveOwners(
    tabId,
    trees,
    children.map((child) => child.frameId),
    budget,
  );
  const owners = resolved.cache;
  if (resolved.stopped) unsettled = true;
  const { nodes, placed, unplaced } = spliceFrameTrees(mainNodes, children, owners);

  const kindOf = new Map(children.map((child) => [child.frameId, child.kind]));
  const frames = placed.filter((frameId) => kindOf.get(frameId) === "oopif").length;
  return { nodes, frames, localFrames: placed.length - frames, unplaced, errors, unsettled };
}
