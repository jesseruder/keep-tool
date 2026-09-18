// Helpers every page tool needs: ref -> live element, viewport metrics, tab activation.

import { refTable, send } from "../lib/cdp.js";
import { VIEWPORT_EXPRESSION, source } from "../lib/page.js";

export function textResult(text) {
  return { text };
}

export function unknownRef(ref) {
  return new Error(
    `Unknown element ref: ${ref}. Call read_page or find on this tab first; refs reset when the page navigates.`,
  );
}

export function backendIdFor(tabId, ref) {
  const backendNodeId = refTable(tabId).backendFor(ref);
  if (backendNodeId == null) throw unknownRef(ref);
  return backendNodeId;
}

export async function resolveRef(tabId, ref) {
  const backendNodeId = backendIdFor(tabId, ref);
  let resolved;
  try {
    resolved = await send(tabId, "DOM.resolveNode", { backendNodeId });
  } catch (error) {
    throw new Error(`${ref} is no longer on the page (${error.message})`);
  }
  if (!resolved?.object?.objectId) throw unknownRef(ref);
  return { objectId: resolved.object.objectId, backendNodeId };
}

/** Run one of lib/page.js's functions with the ref'd element as `this`. */
export async function callOnRef(tabId, ref, fn, args = []) {
  const { objectId, backendNodeId } = await resolveRef(tabId, ref);
  const response = await send(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: source(fn),
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
  });
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

/** Element centre in viewport CSS pixels, scrolled into view first. */
export async function pointForRef(tabId, ref) {
  const backendNodeId = backendIdFor(tabId, ref);
  try {
    await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch {
    // Not scrollable (detached, display:none): getContentQuads reports the real problem.
  }

  let quads = null;
  try {
    const response = await send(tabId, "DOM.getContentQuads", { backendNodeId });
    quads = response?.quads ?? null;
  } catch {
    quads = null;
  }

  if (quads && quads.length > 0) {
    const quad = quads[0];
    const centre = {
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
    };
    const metrics = await send(tabId, "Page.getLayoutMetrics").catch(() => null);
    const visual = metrics?.cssVisualViewport ?? metrics?.visualViewport ?? null;
    if (visual) {
      const width = visual.clientWidth ?? 0;
      const height = visual.clientHeight ?? 0;
      const shifted = { x: centre.x - (visual.pageX ?? 0), y: centre.y - (visual.pageY ?? 0) };
      const inside = (point) =>
        point.x >= 0 && point.y >= 0 && point.x <= width && point.y <= height;
      // Chromium has reported these quads both viewport-relative and document-relative;
      // after scrollIntoViewIfNeeded the element is on screen, so trust whichever
      // candidate lands inside the viewport.
      if (inside(centre)) return centre;
      if (inside(shifted)) return shifted;
    }
    return centre;
  }

  // Fall back to the layout box; a zero-size element genuinely cannot be clicked.
  const { value } = await callOnRef(tabId, ref, function elementRect() {
    const rect = this.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  if (!value || value.width === 0 || value.height === 0) {
    throw new Error(`${ref} has no visible box on the page, so it cannot be clicked`);
  }
  return { x: value.x + value.width / 2, y: value.y + value.height / 2 };
}
