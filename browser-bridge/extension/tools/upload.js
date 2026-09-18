// file_upload (paths from this machine) and upload_image (a screenshot we still hold).

import { send } from "../lib/cdp.js";
import { requireTab } from "../lib/sessions.js";
import { attachImageToInput, dropImageAtPoint, source } from "../lib/page.js";
import { backendIdFor, callOnRef } from "./shared.js";
import { getScreenshot } from "./computer.js";

export async function file_upload(ctx, params = {}) {
  const tab = await requireTab(ctx.sessionKey, params.tabId);
  const ref = String(params.ref ?? "");
  if (!ref) throw new Error("ref is required");
  const paths = Array.isArray(params.paths) ? params.paths.map(String) : [];
  if (paths.length === 0) throw new Error("paths is required: give absolute paths on this machine");

  const backendNodeId = backendIdFor(tab.id, ref);
  try {
    await send(tab.id, "DOM.setFileInputFiles", { files: paths, backendNodeId });
  } catch (error) {
    throw new Error(`Could not set files on ${ref}: ${error.message}. Is it an <input type="file">?`);
  }
  return {
    text: `Attached ${paths.length} file(s) to ${ref} in tab ${tab.id}:\n${paths.join("\n")}`,
  };
}

/** Run a page function with big arguments: callFunctionOn needs an object to bind to. */
async function callInPage(tabId, fn, args) {
  const documentHandle = await send(tabId, "Runtime.evaluate", { expression: "document" });
  const objectId = documentHandle?.result?.objectId;
  if (!objectId) throw new Error("Could not reach the page's document");
  try {
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
    await send(tabId, "Runtime.releaseObject", { objectId }).catch(() => {});
  }
}

export async function upload_image(ctx, params = {}) {
  const tab = await requireTab(ctx.sessionKey, params.tabId);
  const imageId = String(params.imageId ?? "");
  const stored = getScreenshot(imageId);
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
  const value = await callInPage(tab.id, dropImageAtPoint, [
    stored.data,
    filename,
    stored.mimeType,
    x,
    y,
  ]);
  if (!value?.ok) throw new Error(value?.error ?? `Could not drop the image at (${x}, ${y})`);
  return {
    text: `Dropped ${filename} (${value.size} bytes) on <${value.target}> at (${x}, ${y}) in tab ${tab.id}.`,
  };
}
