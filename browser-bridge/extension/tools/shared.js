// Helpers every page tool needs: ref -> live element, viewport metrics, tab activation,
// and the one screenshot primitive (computer's `screenshot`, `zoom` and `wait` and
// gif_creator's frame capture all go through it).

import { frameOwnerFor, refTable, send, sendRaw } from "../lib/cdp.js";
import { VIEWPORT_EXPRESSION, dropImageAtPoint, elementRect, source } from "../lib/page.js";

export function unknownRef(ref) {
  return new Error(
    `Unknown element ref: ${ref}. Call read_page or find on this tab first; refs reset when the page navigates.`,
  );
}

export function detachedRef(ref) {
  return new Error(
    `${ref} was inside a cross-origin iframe that has since gone away. Call read_page or find again to get fresh refs.`,
  );
}

/**
 * Where a ref lives: `{ sessionId, backendNodeId }`. `sessionId` is null for the page's
 * own frames and the child CDP session of an out-of-process iframe otherwise, which is
 * the session every DOM command about that node has to be addressed to.
 */
export function refTarget(tabId, ref) {
  const target = refTable(tabId).targetFor(ref);
  if (!target) throw unknownRef(ref);
  if (target.detached) throw detachedRef(ref);
  return target;
}

export async function resolveRef(tabId, ref) {
  const { backendNodeId, sessionId } = refTarget(tabId, ref);
  let resolved;
  try {
    resolved = await send(tabId, "DOM.resolveNode", { backendNodeId }, sessionId);
  } catch (error) {
    throw new Error(`${ref} is no longer on the page (${error.message})`);
  }
  if (!resolved?.object?.objectId) throw unknownRef(ref);
  return { objectId: resolved.object.objectId, backendNodeId, sessionId };
}

/** Run one of lib/page.js's functions with the ref'd element as `this`. */
export async function callOnRef(tabId, ref, fn, args = []) {
  const { objectId, backendNodeId, sessionId } = await resolveRef(tabId, ref);
  // The object id belongs to the frame's own session, so the call goes there too.
  const response = await send(
    tabId,
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: source(fn),
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId,
  );
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "page function threw",
    );
  }
  return { value: response.result?.value, backendNodeId };
}

export async function evaluate(tabId, expression, { awaitPromise = false } = {}) {
  const response = await send(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "evaluation failed",
    );
  }
  return response.result?.value;
}

/**
 * Run a page function that needs big arguments: callFunctionOn wants an object to bind
 * to, and `document` is the one every page has.
 *
 * `beforeCall` runs after the debugger attach and the document lookup and before the call
 * itself, which is the last moment anything can be checked: those two steps are awaits,
 * and a tab can change hands during them.
 */
export async function callInPage(tabId, fn, args, { beforeCall = null } = {}) {
  const documentHandle = await send(tabId, "Runtime.evaluate", { expression: "document" });
  const objectId = documentHandle?.result?.objectId;
  if (!objectId) throw new Error("Could not reach the page's document");
  try {
    if (beforeCall) await beforeCall();
    const response = await send(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: source(fn),
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text,
      );
    }
    return response.result?.value;
  } finally {
    // Release through the attachment we already have, never through `send`: `send`
    // re-attaches a tab that was detached in the meantime, which would enable domains and
    // focus emulation on a tab that may by now belong to another session - and this runs
    // on the path where `beforeCall` refused for exactly that reason. A failed release is
    // nothing: the handle dies with the page.
    await sendRaw(tabId, "Runtime.releaseObject", { objectId }).catch(() => {});
  }
}

/**
 * Drop a base64 file on whatever is at a point, the way a user drags a file onto a drop
 * zone. upload_image's coordinate mode and gif_creator's coordinate export are the same
 * gesture with different bytes, so they share this - and share the guard.
 *
 * `assertOwned` is the caller's "is this tab still mine?" check (requireTab, which throws
 * the contract's own foreign-tab error). It is called here rather than by the caller
 * because the attach and the document lookup inside callInPage are awaits of their own: a
 * tab dragged into another session's group during them would otherwise still be handed the
 * file. It runs immediately before the call that hands it over.
 */
export async function dropFileAtCoordinate(tabId, { data, mimeType, filename, x, y }, assertOwned = null) {
  if (assertOwned) await assertOwned();
  const value = await callInPage(tabId, dropImageAtPoint, [data, filename, mimeType, x, y], {
    beforeCall: assertOwned,
  });
  if (!value?.ok) throw new Error(value?.error ?? `Could not drop the file at (${x}, ${y})`);
  return value;
}

// The page's own timers and animation frames decide when this resolves, so a page that
// replaces setTimeout and requestAnimationFrame with no-ops would never answer - and CDP's
// own `timeout` does not bound an awaited promise (measured on Edge 153). The worker keeps
// its own clock and moves on.
const PAINT_EXPRESSION =
  "new Promise(r => { setTimeout(r, 300); requestAnimationFrame(() => requestAnimationFrame(r)); })";
const PAINT_DEADLINE_MS = 1000;

/**
 * Wait for the frame to paint: two animation frames, or 300 ms inside the page, or
 * `PAINT_DEADLINE_MS` measured out here - whichever comes first.
 */
export async function waitForPaint(tabId, sessionId = null) {
  // Attached to a catch immediately: this promise may be abandoned by the race below and
  // must not become an unhandled rejection.
  const evaluated = send(
    tabId,
    "Runtime.evaluate",
    { expression: PAINT_EXPRESSION, awaitPromise: true, timeout: PAINT_DEADLINE_MS },
    sessionId,
  ).then(
    () => undefined,
    () => undefined,
  );
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, PAINT_DEADLINE_MS);
  });
  try {
    await Promise.race([evaluated, deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Page.captureScreenshot with a clip in document CSS pixels. `clip.scale` is multiplied
 * by the device pixel ratio, so callers pass `wanted / dpr` (see clipScaleFor).
 */
export async function captureClip(tabId, clip) {
  // Let a pending layout or scroll animation paint before the frame is grabbed. A hidden
  // or occluded tab never runs animation frames, and a hostile page can stub out both
  // timers, so the wait is bounded in the worker too. captureScreenshot still returns a
  // frame for such a tab.
  await waitForPaint(tabId);
  const response = await send(tabId, "Page.captureScreenshot", {
    format: "png",
    clip,
    optimizeForSpeed: false,
  });
  if (!response?.data) throw new Error("The browser returned an empty screenshot");
  return response.data;
}

/**
 * Page.captureScreenshot multiplies clip.scale by the device pixel ratio, so a DPR 2
 * display needs scale/dpr to come back at CSS size. The model's coordinates are CSS
 * pixels, and an image that matches them is worth more than extra sharpness.
 */
export function clipScaleFor(cssRatio, dpr) {
  return cssRatio / (dpr || 1);
}

export async function viewport(tabId) {
  const info = await evaluate(tabId, VIEWPORT_EXPRESSION);
  return {
    width: Math.round(info?.width ?? 0),
    height: Math.round(info?.height ?? 0),
    dpr: info?.dpr || 1,
    scrollX: info?.scrollX ?? 0,
    scrollY: info?.scrollY ?? 0,
    url: info?.url ?? "",
    title: info?.title ?? "",
  };
}

/**
 * Bring the tab to the front of its own window without focusing the window: the user's
 * terminal keeps keyboard focus, which is the whole point.
 */
export async function activateTab(tabId) {
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch (error) {
    throw new Error(`Could not activate tab ${tabId}: ${error.message}`);
  }
}

/**
 * The content box of an iframe element, in the coordinates of the session that holds it.
 * getBoxModel rather than getContentQuads: the content box excludes the iframe's own
 * border and padding, which is exactly where the child document's origin sits (the test
 * page's 2 px border would otherwise offset every click inside it).
 */
async function contentBoxOrigin(tabId, sessionId, backendNodeId) {
  const response = await send(tabId, "DOM.getBoxModel", { backendNodeId }, sessionId);
  const content = response?.model?.content;
  if (!Array.isArray(content) || content.length < 2) {
    throw new Error("the browser gave no box model for the iframe element");
  }
  return { x: content[0], y: content[1] };
}

/**
 * The iframe elements between a frame session and the page, inner first: each entry is
 * the host element and the session that holds it (the last one's session is null, the
 * page's own).
 */
function ancestorHosts(tabId, frameSessionId) {
  const hosts = [];
  let sessionId = frameSessionId;
  const seen = new Set();
  while (sessionId) {
    if (seen.has(sessionId)) break; // a cycle is impossible, but never loop forever
    seen.add(sessionId);
    const owner = frameOwnerFor(tabId, sessionId);
    if (!owner) {
      throw new Error(
        "This element is inside a cross-origin iframe whose position on the page is not known. Call read_page or find on this tab first.",
      );
    }
    hosts.push({ sessionId: owner.sessionId ?? null, backendNodeId: owner.backendNodeId });
    // The host element's own coordinates are in its session, so keep walking outwards.
    sessionId = owner.sessionId;
  }
  return hosts;
}

async function settleAll(tabId, hosts) {
  for (const host of hosts) await waitForPaint(tabId, host.sessionId);
}

async function readOrigins(tabId, hosts) {
  const origins = [];
  for (const host of hosts) {
    origins.push(await contentBoxOrigin(tabId, host.sessionId, host.backendNodeId));
  }
  return origins;
}

function sameOrigins(a, b) {
  return a.length === b.length && a.every((origin, index) => origin.x === b[index].x && origin.y === b[index].y);
}

const MAX_SETTLE_ROUNDS = 3;

/**
 * The one place that knows how an out-of-process iframe's geometry relates to the page's.
 *
 * Measured on Edge 153: DOM.getContentQuads from a child session reports the node's
 * position in *that frame's own viewport*, not the page's (a button really at (452, 372)
 * came back as (431, 90) from a frame whose content box starts at (22, 282)). Mouse input
 * is dispatched through the main session, so every host iframe's content-box origin has
 * to be added back, outwards to the page.
 *
 * The measurement has to wait. `DOM.scrollIntoViewIfNeeded` inside a frame applies to that
 * frame synchronously, but it scrolls the frame's *ancestors* through the browser process
 * asynchronously, so a box model read straight afterwards reports where the iframe was
 * before the page scrolled - which is how a click on an element 900 px down landed
 * nowhere. So: let every ancestor session paint, measure, then measure again and only
 * trust the reading when it stops moving.
 *
 * A same-process child frame is part of its parent's session, so its quads are already in
 * that session's coordinates and none of this runs for it.
 */
async function frameViewportOffset(tabId, frameSessionId) {
  const hosts = ancestorHosts(tabId, frameSessionId);
  if (hosts.length === 0) return { x: 0, y: 0 };

  await settleAll(tabId, hosts);
  let origins = await readOrigins(tabId, hosts);
  for (let round = 0; round < MAX_SETTLE_ROUNDS; round++) {
    await settleAll(tabId, hosts);
    const again = await readOrigins(tabId, hosts);
    const stable = sameOrigins(origins, again);
    // Always keep the later reading: if it is still moving, the newest one is the closest
    // to where it will end up.
    origins = again;
    if (stable) break;
  }
  return origins.reduce(
    (total, origin) => ({ x: total.x + origin.x, y: total.y + origin.y }),
    { x: 0, y: 0 },
  );
}

async function quadCentre(tabId, backendNodeId, sessionId) {
  let quads = null;
  try {
    const response = await send(tabId, "DOM.getContentQuads", { backendNodeId }, sessionId);
    quads = response?.quads ?? null;
  } catch {
    quads = null;
  }
  if (!quads || quads.length === 0) return null;
  const quad = quads[0];
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
  };
}

/** Element centre in viewport CSS pixels, scrolled into view first. */
export async function pointForRef(tabId, ref) {
  const { backendNodeId, sessionId } = refTarget(tabId, ref);
  try {
    await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }, sessionId);
  } catch {
    // Not scrollable (detached, display:none): getContentQuads reports the real problem.
  }

  // The page's own frames: quads are already the coordinates input speaks, and nothing
  // outside this frame had to move, so this costs exactly what it always did.
  if (!sessionId) {
    const centre = await quadCentre(tabId, backendNodeId, null);
    if (centre) return centre;

    // Fall back to the layout box; a zero-size element genuinely cannot be clicked.
    const { value } = await callOnRef(tabId, ref, elementRect);
    if (!value || value.width === 0 || value.height === 0) {
      throw new Error(`${ref} has no visible box on the page, so it cannot be clicked`);
    }
    return { x: value.x + value.width / 2, y: value.y + value.height / 2 };
  }

  // Inside a cross-origin iframe: settle and measure the chain first, then read the
  // element's own position, which is now being reported against a frame that has stopped
  // moving.
  const offset = await frameViewportOffset(tabId, sessionId);
  const centre = await quadCentre(tabId, backendNodeId, sessionId);
  if (!centre) {
    // getBoundingClientRect would be relative to the frame's own viewport with no way to
    // correct it, so refuse instead of clicking a guess.
    throw new Error(
      `${ref} is inside a cross-origin iframe and the browser gave no geometry for it, so it cannot be clicked by ref. Take a screenshot and click by coordinate.`,
    );
  }
  // Last: let the page itself paint before the caller dispatches the click. The
  // compositor's hit-test surfaces are updated a frame behind the scroll, and a click
  // sent before that lands on whatever used to be under the point.
  await waitForPaint(tabId, null);
  return { x: centre.x + offset.x, y: centre.y + offset.y };
}
