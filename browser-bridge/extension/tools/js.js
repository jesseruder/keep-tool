// javascript_tool: REPL-style evaluation in the page.

import { send } from "../lib/cdp.js";
import { requireTab } from "../lib/sessions.js";

const TIMEOUT_MS = 30_000;
const TIMEOUT_TEXT = "JavaScript execution error: Execution timeout: Code exceeded 30-second limit";

// Runs in the page against the result object; returns JSON text, or null when the value
// has no useful JSON form (DOM nodes, functions, cycles) so we fall back to CDP's
// description, which reads much better for those.
const SERIALIZER = `function () {
  try {
    if (typeof Node !== "undefined" && this instanceof Node) return null;
    if (typeof this === "function") return null;
    const text = JSON.stringify(this);
    return text === undefined ? null : text;
  } catch (error) {
    return null;
  }
}`;

function errorText(details) {
  const exception = details?.exception;
  return (
    exception?.description ??
    (exception && "value" in exception ? JSON.stringify(exception.value) : null) ??
    details?.text ??
    "unknown error"
  );
}

function looksLikeTimeout(text) {
  return /timed? out|Execution was terminated|Code exceeded/i.test(String(text));
}

export async function javascript_tool(ctx, params = {}) {
  const tab = await requireTab(ctx.sessionKey, params.tabId);
  const expression = String(params.text ?? "");
  if (!expression.trim()) throw new Error("text is required");

  let response;
  try {
    // returnByValue is deliberately off: the expression must run exactly once, and a
    // value CDP cannot serialise would otherwise turn into a protocol error.
    response = await send(tab.id, "Runtime.evaluate", {
      expression,
      replMode: true,
      awaitPromise: true,
      returnByValue: false,
      timeout: TIMEOUT_MS,
      userGesture: true,
    });
  } catch (error) {
    const message = String(error.message ?? error);
    if (looksLikeTimeout(message)) throw new Error(TIMEOUT_TEXT);
    throw new Error(`JavaScript execution error: ${message}`);
  }

  if (response.exceptionDetails) {
    const text = errorText(response.exceptionDetails);
    if (looksLikeTimeout(text)) throw new Error(TIMEOUT_TEXT);
    throw new Error(`JavaScript execution error: ${text}`);
  }

  const result = response.result ?? {};
  if (result.type === "undefined") return { text: "undefined" };
  if (!result.objectId) {
    if (result.type === "string") return { text: JSON.stringify(result.value) };
    if ("value" in result) return { text: String(result.value) };
    return { text: result.description ?? result.type };
  }

  let serialized = null;
  try {
    const call = await send(tab.id, "Runtime.callFunctionOn", {
      objectId: result.objectId,
      functionDeclaration: SERIALIZER,
      returnByValue: true,
      awaitPromise: false,
    });
    serialized = call?.result?.value ?? null;
  } catch {
    serialized = null;
  } finally {
    await send(tab.id, "Runtime.releaseObject", { objectId: result.objectId }).catch(() => {});
  }

  return { text: serialized ?? result.description ?? result.className ?? result.type };
}
