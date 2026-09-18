// Turning stored frames into an animated GIF inside the service worker.
//
// OffscreenCanvas + createImageBitmap do the drawing (a worker has no DOM and no
// document.createElement), and the vendored gifenc quantizes and writes the frames.
// The overlays are drawn here rather than baked into the stored frame, so the same
// recording can be exported twice with different options.

import { GIFEncoder, applyPalette, prequantize, quantize } from "./vendor/gifenc.js";
import { MAX_FRAME_WIDTH, actionLabel, frameDelays, overlayGeometry, overlayOptions } from "./gifframes.js";

const ORANGE = "#ff6a00";
const ORANGE_FILL = "rgba(255, 106, 0, 0.45)";
const RED = "#e01b24";
const LABEL_FONT = "bold 14px system-ui, -apple-system, Helvetica, Arial, sans-serif";
const WATERMARK_FONT = "11px system-ui, -apple-system, Helvetica, Arial, sans-serif";
const WATERMARK_TEXT = "Browser Bridge";
const PROGRESS_HEIGHT = 6;

// --- base64 (no Buffer, no FileReader, in a worker) -----------------------

const B64_CHUNK = 0x2000;

export function bytesToBase64(bytes) {
  let out = "";
  for (let index = 0; index < bytes.length; index += B64_CHUNK) {
    out += String.fromCharCode(...bytes.subarray(index, index + B64_CHUNK));
  }
  return btoa(out);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * URL.createObjectURL does not exist in a service worker, so a download's url has to be
 * the whole GIF as data.
 */
export function gifDataUrl(base64) {
  return `data:image/gif;base64,${base64}`;
}

// --- one frame ------------------------------------------------------------

/**
 * A screenshot on the way into the store: decoded, shrunk to at most 800 px wide and
 * re-encoded as PNG. 300 full-resolution retina frames would be hundreds of megabytes;
 * at 800 px a frame is tens of kilobytes and still readable.
 *
 * `scale` is frame pixels per CSS pixel, which is what the overlays need to place a
 * click recorded in CSS coordinates.
 */
export async function makeFrameBlob(pngBase64, cssWidth) {
  const source = await createImageBitmap(new Blob([base64ToBytes(pngBase64)], { type: "image/png" }));
  const ratio = Math.min(1, MAX_FRAME_WIDTH / source.width);
  const width = Math.max(1, Math.round(source.width * ratio));
  const height = Math.max(1, Math.round(source.height * ratio));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(source, 0, 0, width, height);
  source.close?.();
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return { blob, width, height, scale: width / (Number(cssWidth) || source.width) };
}

// --- overlays -------------------------------------------------------------

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function drawArrow(context, from, to) {
  context.strokeStyle = RED;
  context.fillStyle = RED;
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();

  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const head = 12;
  context.beginPath();
  context.moveTo(to.x, to.y);
  context.lineTo(to.x - head * Math.cos(angle - Math.PI / 7), to.y - head * Math.sin(angle - Math.PI / 7));
  context.lineTo(to.x - head * Math.cos(angle + Math.PI / 7), to.y - head * Math.sin(angle + Math.PI / 7));
  context.closePath();
  context.fill();
}

/**
 * Draw the overlays for one frame onto a context that already holds the screenshot.
 * Coordinates in the frame metadata are CSS pixels, so everything is multiplied by the
 * frame's scale.
 */
export function drawOverlays(context, { frame, index, total, options, width, height }) {
  const scale = Number(frame.scale) || 1;
  const at = (point) => ({ x: point.x * scale, y: point.y * scale });
  const { click, drag, scroll } = overlayGeometry(frame.action ?? {});

  if (options.showClickIndicators && click) {
    const centre = at(click);
    const radius = Math.max(9, 16 * scale);
    context.fillStyle = ORANGE_FILL;
    context.strokeStyle = ORANGE;
    context.lineWidth = 3;
    context.beginPath();
    context.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }

  // A scroll has a point but no click: a hollow marker says "this is where the wheel
  // turned" without pretending something was pressed.
  if (options.showClickIndicators && scroll) {
    const centre = at(scroll);
    context.strokeStyle = ORANGE;
    context.lineWidth = 2;
    context.beginPath();
    context.arc(centre.x, centre.y, Math.max(7, 11 * scale), 0, Math.PI * 2);
    context.stroke();
  }

  if (options.showDragPaths && drag) {
    drawArrow(context, at(drag.from), at(drag.to));
  }

  if (options.showActionLabels) {
    const label = frame.label || actionLabel(frame.action ?? {});
    if (label) {
      context.font = LABEL_FONT;
      context.textBaseline = "middle";
      const textWidth = context.measureText(label).width ?? label.length * 7;
      const boxHeight = 24;
      const boxWidth = textWidth + 20;
      context.fillStyle = "rgba(0, 0, 0, 0.78)";
      roundedRect(context, 10, 10, boxWidth, boxHeight, 6);
      context.fill();
      context.fillStyle = "#ffffff";
      context.fillText(label, 20, 10 + boxHeight / 2);
    }
  }

  if (options.showProgressBar && total > 0) {
    const done = ((index + 1) / total) * width;
    context.fillStyle = "rgba(0, 0, 0, 0.25)";
    context.fillRect(0, height - PROGRESS_HEIGHT, width, PROGRESS_HEIGHT);
    context.fillStyle = ORANGE;
    context.fillRect(0, height - PROGRESS_HEIGHT, done, PROGRESS_HEIGHT);
  }

  if (options.showWatermark) {
    // Claude in Chrome stamps the Claude logo here; this is not that extension, so it
    // signs its own name instead of borrowing a mark it has no right to.
    context.font = WATERMARK_FONT;
    context.textBaseline = "alphabetic";
    const textWidth = context.measureText(WATERMARK_TEXT).width ?? WATERMARK_TEXT.length * 6;
    const x = width - textWidth - 10;
    const y = height - PROGRESS_HEIGHT - 8;
    context.fillStyle = "rgba(0, 0, 0, 0.35)";
    context.fillText(WATERMARK_TEXT, x + 1, y + 1);
    context.fillStyle = "rgba(255, 255, 255, 0.6)";
    context.fillText(WATERMARK_TEXT, x, y);
  }
}

// --- the GIF --------------------------------------------------------------

/**
 * Encode the frames, overlays and all. Every frame is drawn into one canvas of the first
 * frame's size: a GIF has a single logical screen, and a window resized mid-recording
 * would otherwise write frames the decoder cannot place.
 */
export async function encodeGif(frames, rawOptions = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error("No frames to encode");
  }
  const options = overlayOptions(rawOptions);
  const delays = frameDelays(frames);
  const width = frames[0].width;
  const height = frames[0].height;

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const encoder = GIFEncoder();

  for (const [index, frame] of frames.entries()) {
    const bitmap = await createImageBitmap(frame.blob);
    context.clearRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    drawOverlays(context, { frame, index, total: frames.length, options, width, height });

    const { data } = context.getImageData(0, 0, width, height);
    // Rounding the channels first is gifenc's own way of trading colour precision for
    // speed and size; quality drives how hard it rounds.
    if (options.roundRGB) prequantize(data, { roundRGB: options.roundRGB });
    const palette = quantize(data, options.maxColors, { format: options.format });
    const indexed = applyPalette(data, palette, options.format);
    encoder.writeFrame(indexed, width, height, { palette, delay: delays[index] });
  }
  encoder.finish();

  return { bytes: encoder.bytes(), width, height, delays, options };
}
