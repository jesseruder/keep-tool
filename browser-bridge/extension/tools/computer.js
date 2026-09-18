// computer: trusted mouse and keyboard input through CDP, plus screenshots.
//
// Every coordinate in and out of this tool is CSS pixels relative to the viewport,
// which is what Input.dispatchMouseEvent speaks natively.

import { send } from "../lib/cdp.js";
import { requireTab } from "../lib/sessions.js";
import {
  ALT,
  CTRL,
  META,
  SHIFT,
  ZOOM_CHORD_ERROR,
  charDescriptor,
  isZoomChord,
  keyDescriptor,
  macCommands,
  parseChord,
  parseModifiers,
} from "../lib/keys.js";
import { activateTab, pointForRef, viewport } from "./shared.js";

const SCREENSHOT_TTL_MS = 5 * 60 * 1000;
const MAX_WAIT_SECONDS = 10;
const SCROLL_PIXELS_PER_TICK = 100;
const DRAG_STEPS = 10;
const SCROLL_SETTLE_MS = 250;

const screenshots = new Map();
let screenshotSeq = 0;

function pruneScreenshots() {
  const cutoff = Date.now() - SCREENSHOT_TTL_MS;
  for (const [id, entry] of screenshots) {
    if (entry.at < cutoff) screenshots.delete(id);
  }
}

/**
 * Used by upload_image. Ids expire, which the tool description warns about, and they
 * belong to the session that took them: sessions share this worker, and one session's
 * screenshot is not another's to upload into a page.
 */
export function getScreenshot(id, sessionKey) {
  pruneScreenshots();
  const entry = screenshots.get(String(id));
  if (!entry) return { entry: null, reason: "missing" };
  if (entry.sessionKey !== sessionKey) return { entry: null, reason: "foreign" };
  return { entry, reason: null };
}

function rememberScreenshot(sessionKey, data) {
  pruneScreenshots();
  const id = `ss_${++screenshotSeq}`;
  screenshots.set(id, { data, mimeType: "image/png", at: Date.now(), sessionKey });
  return id;
}

function clampScale(value) {
  const scale = Number(value);
  if (!Number.isFinite(scale)) return 1;
  return Math.min(1, Math.max(0.1, scale));
}

/**
 * Page.captureScreenshot multiplies clip.scale by the device pixel ratio, so a DPR 2
 * display needs scale/dpr to come back at CSS size. The model's coordinates are CSS
 * pixels, and an image that matches them is worth more than extra sharpness.
 */
function clipScaleFor(cssRatio, dpr) {
  return cssRatio / (dpr || 1);
}

async function captureClip(tabId, clip) {
  // Let a pending layout or scroll animation paint before the frame is grabbed.
  await send(tabId, "Runtime.evaluate", {
    expression: "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
    awaitPromise: true,
    timeout: 1000,
  }).catch(() => {});
  const response = await send(tabId, "Page.captureScreenshot", {
    format: "png",
    clip,
    optimizeForSpeed: false,
  });
  if (!response?.data) throw new Error("The browser returned an empty screenshot");
  return response.data;
}

async function screenshotAction(ctx, tabId, params, view) {
  const scale = clampScale(params.scale ?? 1);
  const clip = {
    x: view.scrollX,
    y: view.scrollY,
    width: view.width,
    height: view.height,
    scale: clipScaleFor(scale, view.dpr),
  };
  const data = await captureClip(tabId, clip);
  const imageWidth = Math.round(view.width * scale);
  const imageHeight = Math.round(view.height * scale);
  const imageId = rememberScreenshot(ctx.sessionKey, data);
  const scaleNote = scale === 1 ? "" : ` (scaled by ${scale}; coordinates stay in the full-resolution frame)`;
  return {
    text:
      `Screenshot of tab ${tabId} (${view.url}): image ${imageWidth}x${imageHeight} px, ` +
      `viewport ${view.width}x${view.height} CSS px; coordinates are CSS pixels${scaleNote}. Image id ${imageId}.`,
    image: { data, mimeType: "image/png", width: imageWidth, height: imageHeight },
    imageId,
  };
}

async function zoomAction(ctx, tabId, params, view) {
  const region = params.region;
  if (!Array.isArray(region) || region.length !== 4) {
    throw new Error("region [x0, y0, x1, y1] is required for the zoom action");
  }
  const [x0, y0, x1, y1] = region.map(Number);
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);
  if (!(width > 0 && height > 0)) throw new Error("region must have a non-zero width and height");

  const scale = clampScale(params.scale ?? 1);
  // Magnify up to the viewport's longer side, so a 40px icon fills the image.
  const longestRegion = Math.max(width, height);
  const longestViewport = Math.max(view.width, view.height);
  const magnification = Math.max(1, Math.min(longestViewport / longestRegion, 8));
  const cssRatio = magnification * scale;

  const clip = {
    x: view.scrollX + Math.min(x0, x1),
    y: view.scrollY + Math.min(y0, y1),
    width,
    height,
    scale: clipScaleFor(cssRatio, view.dpr),
  };
  const data = await captureClip(tabId, clip);
  const imageId = rememberScreenshot(ctx.sessionKey, data);
  return {
    text:
      `Zoom of tab ${tabId} region (${Math.min(x0, x1)}, ${Math.min(y0, y1)}) ` +
      `${width}x${height} CSS px, magnified ${cssRatio.toFixed(2)}x to ` +
      `${Math.round(width * cssRatio)}x${Math.round(height * cssRatio)} px. ` +
      `Coordinates are CSS pixels in the page's own frame. Image id ${imageId}.`,
    image: {
      data,
      mimeType: "image/png",
      width: Math.round(width * cssRatio),
      height: Math.round(height * cssRatio),
    },
    imageId,
  };
}

async function mouseEvent(tabId, type, point, extra = {}) {
  await send(tabId, "Input.dispatchMouseEvent", {
    type,
    x: Math.round(point.x),
    y: Math.round(point.y),
    ...extra,
  });
}

async function clickAt(tabId, point, { button, clicks, modifiers }) {
  const buttons = button === "right" ? 2 : 1;
  await mouseEvent(tabId, "mouseMoved", point, { button: "none", buttons: 0, modifiers });
  for (let clickCount = 1; clickCount <= clicks; clickCount++) {
    await mouseEvent(tabId, "mousePressed", point, { button, buttons, clickCount, modifiers });
    await mouseEvent(tabId, "mouseReleased", point, { button, buttons: 0, clickCount, modifiers });
  }
}

async function pointFor(tabId, params) {
  if (params.ref) return pointForRef(tabId, params.ref);
  const coordinate = params.coordinate;
  if (!Array.isArray(coordinate) || coordinate.length !== 2) {
    throw new Error(`coordinate [x, y] (or ref) is required for the ${params.action} action`);
  }
  const [x, y] = coordinate.map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("coordinate must be two numbers");
  return { x, y };
}

const MODIFIER_KEYS = [
  { bit: CTRL, name: "Control", code: "ControlLeft", keyCode: 17 },
  { bit: ALT, name: "Alt", code: "AltLeft", keyCode: 18 },
  { bit: SHIFT, name: "Shift", code: "ShiftLeft", keyCode: 16 },
  { bit: META, name: "Meta", code: "MetaLeft", keyCode: 91 },
];

async function pressChord(tabId, modifiers, descriptor, commands = []) {
  // Hold the real modifier keys too: pages that listen for keydown of "Shift" or read
  // event.metaKey on the modifier itself behave differently otherwise.
  let held = 0;
  for (const modifier of MODIFIER_KEYS) {
    if (!(modifiers & modifier.bit)) continue;
    held |= modifier.bit;
    await send(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: modifier.name,
      code: modifier.code,
      windowsVirtualKeyCode: modifier.keyCode,
      nativeVirtualKeyCode: modifier.keyCode,
      modifiers: held,
    });
  }

  await send(tabId, "Input.dispatchKeyEvent", {
    type: descriptor.text ? "keyDown" : "rawKeyDown",
    ...descriptor,
    ...(commands.length ? { commands } : {}),
  });
  await send(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: descriptor.key,
    code: descriptor.code,
    windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
    nativeVirtualKeyCode: descriptor.nativeVirtualKeyCode,
    modifiers: descriptor.modifiers,
  });

  for (const modifier of [...MODIFIER_KEYS].reverse()) {
    if (!(modifiers & modifier.bit)) continue;
    held &= ~modifier.bit;
    await send(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: modifier.name,
      code: modifier.code,
      windowsVirtualKeyCode: modifier.keyCode,
      nativeVirtualKeyCode: modifier.keyCode,
      modifiers: held,
    });
  }
}

async function typeText(tabId, text) {
  let buffered = "";
  const flush = async () => {
    if (!buffered) return;
    // Input.insertText covers emoji, CJK and accents that have no US-layout key.
    await send(tabId, "Input.insertText", { text: buffered });
    buffered = "";
  };
  for (const char of String(text)) {
    const descriptor = charDescriptor(char);
    if (!descriptor) {
      buffered += char;
      continue;
    }
    await flush();
    const modifiers = descriptor.shift ? SHIFT : 0;
    const event = {
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.keyCode,
      nativeVirtualKeyCode: descriptor.keyCode,
      modifiers,
      text: descriptor.text,
      unmodifiedText: descriptor.text,
    };
    await send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...event });
    await send(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: event.windowsVirtualKeyCode,
      nativeVirtualKeyCode: event.nativeVirtualKeyCode,
      modifiers,
    });
  }
  await flush();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function computer(ctx, params = {}) {
  const tab = await requireTab(ctx.sessionKey, params.tabId);
  const action = String(params.action ?? "");
  await activateTab(tab.id);

  const needsViewport = action === "screenshot" || action === "zoom" || action === "wait";
  const view = needsViewport ? await viewport(tab.id) : null;

  switch (action) {
    case "screenshot":
      return screenshotAction(ctx, tab.id, params, view);

    case "zoom":
      return zoomAction(ctx, tab.id, params, view);

    case "wait": {
      const duration = Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(params.duration ?? 0)));
      if (!Number.isFinite(duration)) throw new Error("duration must be a number of seconds");
      await sleep(duration * 1000);
      const shot = await screenshotAction(ctx, tab.id, params, await viewport(tab.id));
      return { ...shot, text: `Waited ${duration}s. ${shot.text}` };
    }

    case "left_click":
    case "right_click":
    case "double_click":
    case "triple_click": {
      const parsed = parseModifiers(params.modifiers);
      if (parsed.error) throw new Error(parsed.error);
      const point = await pointFor(tab.id, params);
      const clicks = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
      await clickAt(tab.id, point, {
        button: action === "right_click" ? "right" : "left",
        clicks,
        modifiers: parsed.modifiers,
      });
      const where = params.ref ? `${params.ref} at ` : "";
      return {
        text: `${action} on tab ${tab.id} at ${where}(${Math.round(point.x)}, ${Math.round(point.y)}).`,
      };
    }

    case "hover": {
      const parsed = parseModifiers(params.modifiers);
      if (parsed.error) throw new Error(parsed.error);
      const point = await pointFor(tab.id, params);
      await mouseEvent(tab.id, "mouseMoved", point, {
        button: "none",
        buttons: 0,
        modifiers: parsed.modifiers,
      });
      return { text: `Moved the pointer to (${Math.round(point.x)}, ${Math.round(point.y)}).` };
    }

    case "left_click_drag": {
      const start = params.start_coordinate;
      if (!Array.isArray(start) || start.length !== 2) {
        throw new Error("start_coordinate [x, y] is required for left_click_drag");
      }
      const from = { x: Number(start[0]), y: Number(start[1]) };
      const to = await pointFor(tab.id, params);
      await mouseEvent(tab.id, "mouseMoved", from, { button: "none", buttons: 0 });
      await mouseEvent(tab.id, "mousePressed", from, { button: "left", buttons: 1, clickCount: 1 });
      for (let step = 1; step <= DRAG_STEPS; step++) {
        const point = {
          x: from.x + ((to.x - from.x) * step) / DRAG_STEPS,
          y: from.y + ((to.y - from.y) * step) / DRAG_STEPS,
        };
        await mouseEvent(tab.id, "mouseMoved", point, { button: "left", buttons: 1 });
      }
      await mouseEvent(tab.id, "mouseReleased", to, { button: "left", buttons: 0, clickCount: 1 });
      return {
        text: `Dragged from (${Math.round(from.x)}, ${Math.round(from.y)}) to (${Math.round(to.x)}, ${Math.round(to.y)}).`,
      };
    }

    case "scroll": {
      const direction = String(params.scroll_direction ?? "down");
      if (!["up", "down", "left", "right"].includes(direction)) {
        throw new Error("scroll_direction must be up, down, left or right");
      }
      const ticks = Math.min(10, Math.max(1, Math.round(Number(params.scroll_amount ?? 3))));
      const parsed = parseModifiers(params.modifiers);
      if (parsed.error) throw new Error(parsed.error);
      const point = params.ref || params.coordinate
        ? await pointFor(tab.id, params)
        : await (async () => {
            const centre = await viewport(tab.id);
            return { x: Math.round(centre.width / 2), y: Math.round(centre.height / 2) };
          })();
      const distance = ticks * SCROLL_PIXELS_PER_TICK;
      const deltaX = direction === "right" ? distance : direction === "left" ? -distance : 0;
      const deltaY = direction === "down" ? distance : direction === "up" ? -distance : 0;
      await mouseEvent(tab.id, "mouseWheel", point, {
        deltaX,
        deltaY,
        modifiers: parsed.modifiers,
        pointerType: "mouse",
      });
      // Wheel scrolling animates; a screenshot taken straight away sees the old position.
      await sleep(SCROLL_SETTLE_MS);
      return { text: `Scrolled ${direction} ${ticks} tick(s) (${distance}px) at (${Math.round(point.x)}, ${Math.round(point.y)}).` };
    }

    case "scroll_to": {
      if (!params.ref) throw new Error("ref is required for the scroll_to action");
      const point = await pointForRef(tab.id, params.ref);
      return {
        text: `Scrolled ${params.ref} into view; its centre is at (${Math.round(point.x)}, ${Math.round(point.y)}).`,
      };
    }

    case "type": {
      const text = params.text;
      if (typeof text !== "string" || text.length === 0) {
        throw new Error("text is required for the type action");
      }
      await typeText(tab.id, text);
      return { text: `Typed ${text.length} character(s) into tab ${tab.id}.` };
    }

    case "key": {
      const spec = String(params.text ?? "").trim();
      if (!spec) throw new Error("text is required for the key action");
      const repeat = Math.min(100, Math.max(1, Math.round(Number(params.repeat ?? 1))));
      const chords = spec.split(/\s+/);
      for (const chord of chords) {
        const parsed = parseChord(chord);
        if (parsed.error) throw new Error(parsed.error);
        if (isZoomChord(parsed.modifiers, parsed.key)) throw new Error(ZOOM_CHORD_ERROR);
        const descriptor = keyDescriptor(parsed.key, parsed.modifiers);
        if (!descriptor) throw new Error(`Unknown key: ${chord}`);
      }
      for (let round = 0; round < repeat; round++) {
        for (const chord of chords) {
          const parsed = parseChord(chord);
          const descriptor = keyDescriptor(parsed.key, parsed.modifiers);
          await pressChord(tab.id, parsed.modifiers, descriptor, macCommands(parsed.modifiers, parsed.key));
        }
      }
      return { text: `Pressed ${spec}${repeat > 1 ? ` x${repeat}` : ""} in tab ${tab.id}.` };
    }

    default:
      throw new Error(`Unsupported computer action: ${action}`);
  }
}
