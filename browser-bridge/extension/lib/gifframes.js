// The pure half of gif_creator: what an action is called in the GIF, how long each
// frame is shown, and where the caps are.
//
// No chrome APIs, no canvas: the tests read this directly. The recorder in
// tools/gif.js builds the metadata, this file turns it into labels and delays.

/** A recording stops adding frames here rather than eating the worker's memory. */
export const MAX_FRAMES = 300;
export const MAX_BYTES = 60 * 1024 * 1024;

/** Frames are stored no wider than this; overlays are drawn in the scaled space. */
export const MAX_FRAME_WIDTH = 800;

// Real elapsed time between actions, clamped: a 50 ms double click should still be
// visible, and a five-minute pause while the model thinks should not stall the GIF.
export const MIN_DELAY_MS = 300;
export const MAX_DELAY_MS = 3000;
export const LAST_DELAY_MS = 1500;

const LABEL_TEXT_LIMIT = 24;

function point(action) {
  const p = action?.point;
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

function quoteShort(text) {
  const value = String(text ?? "");
  const trimmed = value.length > LABEL_TEXT_LIMIT ? `${value.slice(0, LABEL_TEXT_LIMIT)}...` : value;
  return JSON.stringify(trimmed);
}

/** A host without the www., which is all a label has room for. */
function shortHost(url) {
  const raw = String(url ?? "");
  try {
    return new URL(raw).host.replace(/^www\./, "") || raw;
  } catch {
    return raw;
  }
}

/**
 * The short line drawn at the top left of the frame: `Click (312, 400)`,
 * `Type "hello"`, `Press cmd+a`, `Scroll down`, `Navigate example.com`, `Screenshot`.
 */
export function actionLabel(action = {}) {
  const kind = String(action.kind ?? "");
  const at = point(action);
  const where = at ? ` (${at.x}, ${at.y})` : "";

  switch (kind) {
    case "left_click":
      return `Click${where}`;
    case "right_click":
      return `Right click${where}`;
    case "double_click":
      return `Double click${where}`;
    case "triple_click":
      return `Triple click${where}`;
    case "hover":
      return `Hover${where}`;
    case "left_click_drag": {
      const from = action.from ? `(${Math.round(action.from.x)}, ${Math.round(action.from.y)})` : "?";
      const to = action.to ? `(${Math.round(action.to.x)}, ${Math.round(action.to.y)})` : "?";
      return `Drag ${from} to ${to}`;
    }
    case "scroll":
      return `Scroll ${action.direction ?? "down"}`;
    case "scroll_to":
      return `Scroll to ${action.ref ?? "element"}`;
    case "type":
      return `Type ${quoteShort(action.text)}`;
    case "key":
      return `Press ${action.text ?? ""}`.trimEnd();
    case "screenshot":
      return "Screenshot";
    case "zoom":
      return "Zoom";
    case "wait":
      return `Wait ${action.duration ?? 0}s`;
    case "navigate":
      if (action.url === "back" || action.url === "forward") return `Navigate ${action.url}`;
      return `Navigate ${shortHost(action.url)}`;
    default:
      return kind || "Action";
  }
}

/** The drag arrow and the click dot come from here so the renderer stays dumb. */
export function overlayGeometry(action = {}) {
  const kind = String(action.kind ?? "");
  const click = ["left_click", "right_click", "double_click", "triple_click"].includes(kind)
    ? point(action)
    : null;
  const scroll = kind === "scroll" ? point(action) : null;
  const drag =
    kind === "left_click_drag" && action.from && action.to
      ? { from: { ...action.from }, to: { ...action.to } }
      : null;
  return { click, drag, scroll };
}

/**
 * Frame delays in milliseconds: the real gap to the next frame, clamped, with a longer
 * hold on the last one so the GIF does not snap back before it has been read.
 */
export function frameDelays(frames = []) {
  return frames.map((frame, index) => {
    if (index === frames.length - 1) return LAST_DELAY_MS;
    const gap = Number(frames[index + 1].at) - Number(frame.at);
    if (!Number.isFinite(gap)) return MIN_DELAY_MS;
    return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(gap)));
  });
}

/** Total playback time of the GIF in seconds, as the export result reports it. */
export function totalDurationMs(frames = []) {
  return frameDelays(frames).reduce((sum, delay) => sum + delay, 0);
}

/** Would one more frame of `bytes` bytes cross a cap? */
export function capReached({ frames = 0, bytes = 0 } = {}) {
  if (frames >= MAX_FRAMES) return "frames";
  if (bytes >= MAX_BYTES) return "bytes";
  return null;
}

/** The sentence the export result adds when recording hit a cap. */
export function capNote(cap) {
  if (cap === "frames") {
    return `Recording hit the ${MAX_FRAMES}-frame cap: later actions were not captured. Export or clear and start a new recording.`;
  }
  if (cap === "bytes") {
    return `Recording hit the ${Math.round(MAX_BYTES / (1024 * 1024))} MB cap: later actions were not captured. Export or clear and start a new recording.`;
  }
  return null;
}

/**
 * quality 1-30 (lower is better, as the schema says) -> what the quantizer gets.
 *
 * gifenc has no single "sample interval" knob, so the tradeoff is spread over the three
 * levers it does have:
 *   - palette size: 256 colours at quality 1 down to 32 at quality 30 (linear). A
 *     smaller palette is both smaller on the wire and faster to apply.
 *   - histogram format: rgb565 (65536 bins) up to quality 20, rgb444 (4096 bins) above
 *     it, which is gifenc's own coarse/fast mode.
 *   - prequantize: above quality 5 the RGB channels are rounded to a multiple of
 *     `roundRGB` before binning, which is exactly the "sample fewer distinct colours"
 *     tradeoff a sample interval buys elsewhere. quality 10 (the default) lands on
 *     gifenc's own default of 5.
 */
export function quantizerSettings(quality) {
  const raw = Number(quality);
  // A missing quality means the schema's default of 10; a silly one is clamped, because
  // refusing an export over a stray number would be the worse answer.
  const q = Number.isFinite(raw) ? Math.min(30, Math.max(1, Math.round(raw))) : 10;
  const maxColors = Math.min(256, Math.max(32, Math.round(256 - ((q - 1) / 29) * 224)));
  const format = q <= 20 ? "rgb565" : "rgb444";
  const roundRGB = q <= 5 ? 0 : Math.min(16, Math.max(2, Math.round(q / 2)));
  return { quality: q, maxColors, format, roundRGB };
}

/** Overlay switches from the tool's `options`: all on except quality, which is 10. */
export function overlayOptions(options = {}) {
  const flag = (value) => value !== false;
  return {
    showClickIndicators: flag(options.showClickIndicators),
    showDragPaths: flag(options.showDragPaths),
    showActionLabels: flag(options.showActionLabels),
    showProgressBar: flag(options.showProgressBar),
    showWatermark: flag(options.showWatermark),
    ...quantizerSettings(options.quality),
  };
}
