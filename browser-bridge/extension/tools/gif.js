// gif_creator: record the actions a session takes in its tab group and export them as
// an annotated animated GIF.
//
// The recording belongs to the group, not the tab, because a group is a session: a flow
// that opens a second tab keeps recording into the same GIF. Frames live in IndexedDB
// (lib/gifstore.js) so a worker restart between two actions does not lose the take.

import { requireTab } from "../lib/sessions.js";
import { actionLabel, capNote, capReached, totalDurationMs } from "../lib/gifframes.js";
import { bytesToBase64, encodeGif, gifDataUrl, makeFrameBlob } from "../lib/gifencode.js";
import {
  addFrame,
  clearFrames,
  listFrames,
  noteCap,
  recordingFor,
  startRecording,
  stopRecording,
} from "../lib/gifstore.js";
import { captureClip, clipScaleFor, dropFileAtCoordinate, viewport } from "./shared.js";

/**
 * Called by `computer` after every action and by `navigate` after every navigation.
 * Never throws: a recording is a nice-to-have and must not turn a successful click into
 * a failed tool call.
 */
export async function recordAction(ctx, tab, recorded) {
  if (!recorded || !tab || tab.groupId == null) return;
  try {
    const meta = await recordingFor(tab.groupId);
    if (!meta?.recording) return;
    const cap = meta.capped ?? capReached(meta);
    if (cap) {
      // Remember it so `export` can say why the GIF stops where it does, and skip the
      // screenshot: capturing a frame we are not going to store costs a real 300 ms.
      await noteCap(tab.groupId, cap);
      return;
    }
    await addFrame(tab.groupId, await buildFrame(tab.id, recorded));
  } catch (error) {
    console.warn("browser-bridge: could not record a GIF frame", error);
  }
}

/** One frame: the screenshot (shrunk) plus what the action was. */
async function buildFrame(tabId, recorded) {
  const action = { ...recorded };
  // `screenshot` and `wait` hand over the shot they just took rather than paying for a
  // second capture of the same pixels.
  const reused = action.png ?? null;
  const reusedWidth = action.cssWidth ?? null;
  delete action.png;
  delete action.cssWidth;

  let png = reused;
  let cssWidth = reusedWidth;
  if (!png) {
    const view = await viewport(tabId);
    cssWidth = view.width;
    png = await captureClip(tabId, {
      x: view.scrollX,
      y: view.scrollY,
      width: view.width,
      height: view.height,
      scale: clipScaleFor(1, view.dpr),
    });
  }

  const { blob, width, height, scale } = await makeFrameBlob(png, cssWidth);
  return { at: Date.now(), tabId, action, label: actionLabel(action), blob, width, height, scale };
}

// --- the tool -------------------------------------------------------------

function fileStamp(at = Date.now()) {
  return new Date(at).toISOString().replace(/[:.]/g, "-");
}

/**
 * chrome.downloads refuses an absolute path or a `..` segment, and a name without .gif
 * would be saved as something the OS will not open.
 */
function safeFilename(raw, at) {
  const name = String(raw ?? "")
    .trim()
    .replace(/[/\\]+/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/^[.\s]+/, "");
  if (!name) return `recording-${fileStamp(at)}.gif`;
  return /\.gif$/i.test(name) ? name : `${name}.gif`;
}

function humanBytes(count) {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

function framesSummary(meta) {
  return `${meta.frames} frame(s), ${humanBytes(meta.bytes)} stored`;
}

export async function gif_creator(ctx, params = {}) {
  // Same group check as every other tab-scoped tool: the group this resolves to is the
  // session's own, so a recording can never be started on or exported from someone
  // else's tabs.
  const tab = await requireTab(ctx.sessionKey, params.tabId);
  const groupId = tab.groupId;
  const action = String(params.action ?? "");

  switch (action) {
    case "start_recording":
      return startAction(ctx, groupId);
    case "stop_recording":
      return stopAction(groupId);
    case "clear":
      return clearAction(groupId);
    case "export":
      return exportAction(tab, groupId, params);
    default:
      throw new Error(
        `Unsupported gif_creator action: ${action || "(none)"}. Use start_recording, stop_recording, export or clear.`,
      );
  }
}

async function startAction(ctx, groupId) {
  const { meta, alreadyRecording } = await startRecording(groupId, {
    sessionKey: ctx.sessionKey,
    name: ctx.sessionName,
  });
  if (alreadyRecording) {
    return {
      text:
        `Already recording tab group ${groupId} (${framesSummary(meta)}); start_recording did nothing. ` +
        "Call stop_recording or clear first if you wanted to start over.",
    };
  }
  return {
    text:
      `Recording tab group ${groupId}. Every computer action and navigate in this group becomes a frame. ` +
      "Take a screenshot now so the current view is the first frame.",
  };
}

async function stopAction(groupId) {
  const meta = await stopRecording(groupId);
  if (!meta) return { text: `Nothing was recording in tab group ${groupId}.` };
  const lines = [
    `Stopped recording tab group ${groupId}: ${framesSummary(meta)} kept. ` +
      "Call export with download: true (or a coordinate) to write the GIF, or clear to discard the frames.",
  ];
  const note = capNote(meta.capped);
  if (note) lines.push(note);
  return { text: lines.join("\n") };
}

async function clearAction(groupId) {
  const before = await recordingFor(groupId);
  if (!before) return { text: `No GIF frames to clear for tab group ${groupId}.` };
  await clearFrames(groupId);
  return {
    text:
      `Cleared ${before.frames} frame(s) for tab group ${groupId}. ` +
      (before.recording ? "Recording is still on, so new actions will be captured." : "Recording is off."),
  };
}

async function exportAction(tab, groupId, params) {
  const { meta, frames } = await listFrames(groupId);
  if (!meta || frames.length === 0) {
    throw new Error(
      `No GIF frames for tab group ${groupId}. Call gif_creator {action:"start_recording"} and take a screenshot before exporting.`,
    );
  }

  const wantsDownload = params.download === true;
  const coordinate =
    Array.isArray(params.coordinate) && params.coordinate.length === 2
      ? params.coordinate.map(Number)
      : null;
  if (!wantsDownload && !coordinate) {
    throw new Error(
      'Nothing to do: pass download: true to save the GIF, or coordinate [x, y] to drop it on a page element.',
    );
  }
  if (coordinate && coordinate.some((value) => !Number.isFinite(value))) {
    throw new Error("coordinate must be two numbers [x, y] in CSS pixels");
  }

  const at = Date.now();
  const filename = safeFilename(params.filename, at);
  const { bytes, width, height } = await encodeGif(frames, params.options ?? {});
  const base64 = bytesToBase64(bytes);
  const seconds = (totalDurationMs(frames) / 1000).toFixed(1);

  // The GIF itself never goes to the model: it is a download or a drop, and the bytes
  // would be tens of thousands of tokens of nothing.
  const lines = [
    `Exported ${filename}: ${frames.length} frame(s), ${seconds}s, ${humanBytes(bytes.length)}, ${width}x${height} px.`,
  ];

  if (wantsDownload) {
    try {
      const downloadId = await chrome.downloads.download({
        url: gifDataUrl(base64),
        filename,
        saveAs: false,
      });
      lines.push(`Downloaded to the browser's download folder as ${filename} (download id ${downloadId}).`);
    } catch (error) {
      throw new Error(`Could not download ${filename}: ${error.message ?? error}`);
    }
  }

  if (coordinate) {
    const [x, y] = coordinate;
    const dropped = await dropFileAtCoordinate(tab.id, {
      data: base64,
      mimeType: "image/gif",
      filename,
      x,
      y,
    });
    lines.push(`Dropped ${filename} on <${dropped.target}> at (${x}, ${y}) in tab ${tab.id}.`);
  }

  const note = capNote(meta.capped);
  if (note) lines.push(note);
  lines.push("The frames are kept; call clear when you are done with them.");
  return { text: lines.join("\n") };
}
