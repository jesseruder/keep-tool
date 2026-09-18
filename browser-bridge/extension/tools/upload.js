// file_upload (paths from this machine) and upload_image (a screenshot we still hold).

import { send } from "../lib/cdp.js";
import { requireTab } from "../lib/sessions.js";
import { attachImageToInput } from "../lib/page.js";
import { callOnRef, dropFileAtCoordinate, refTarget } from "./shared.js";
import { getScreenshot } from "./computer.js";

export async function file_upload(ctx, params = {}) {
  const tab = await requireTab(ctx.sessionKey, params.tabId);
  const ref = String(params.ref ?? "");
  if (!ref) throw new Error("ref is required");
  const paths = Array.isArray(params.paths) ? params.paths.map(String) : [];
  if (paths.length === 0) throw new Error("paths is required: give absolute paths on this machine");

  // A file input inside a cross-origin iframe is set through that frame's own session.
  const { backendNodeId, sessionId } = refTarget(tab.id, ref);
  try {
    await send(tab.id, "DOM.setFileInputFiles", { files: paths, backendNodeId }, sessionId);
  } catch (error) {
    throw new Error(`Could not set files on ${ref}: ${error.message}. Is it an <input type="file">?`);
  }
  return {
    text: `Attached ${paths.length} file(s) to ${ref} in tab ${tab.id}:\n${paths.join("\n")}`,
  };
}

export async function upload_image(ctx, params = {}) {
  const tab = await requireTab(ctx.sessionKey, params.tabId);
  const imageId = String(params.imageId ?? "");
  const { entry: stored, reason } = getScreenshot(imageId, ctx.sessionKey);
  if (reason === "foreign") {
    throw new Error(
      `Screenshot ${imageId} belongs to another session. Take your own screenshot with the computer tool and upload that.`,
    );
  }
  if (!stored) {
    throw new Error(
      `No screenshot with id ${imageId || "(none)"}. Ids expire five minutes after capture and are lost if the extension's worker restarted: take a fresh screenshot and upload that.`,
    );
  }
  const filename = String(params.filename ?? "image.png");
  const hasRef = Boolean(params.ref);
  const hasCoordinate = Array.isArray(params.coordinate) && params.coordinate.length === 2;
  if (hasRef === hasCoordinate) throw new Error("Provide either ref or coordinate, not both");

  if (hasRef) {
    const { value } = await callOnRef(tab.id, params.ref, attachImageToInput, [
      stored.data,
      filename,
      stored.mimeType,
    ]);
    if (!value?.ok) throw new Error(value?.error ?? `Could not attach the image to ${params.ref}`);
    return { text: `Uploaded ${filename} (${value.size} bytes) to ${params.ref} in tab ${tab.id}.` };
  }

  const [x, y] = params.coordinate.map(Number);
  const value = await dropFileAtCoordinate(tab.id, {
    data: stored.data,
    mimeType: stored.mimeType,
    filename,
    x,
    y,
  });
  return {
    text: `Dropped ${filename} (${value.size} bytes) on <${value.target}> at (${x}, ${y}) in tab ${tab.id}.`,
  };
}
