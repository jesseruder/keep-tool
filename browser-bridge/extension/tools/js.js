// javascript_tool: REPL-style evaluation in the page.

import { send } from "../lib/cdp.js";
import { requireTab } from "../lib/sessions.js";

const TIMEOUT_MS = 30_000;
/** The result is already in hand by then; only the page's own getters can be slow. */
const SERIALIZER_TIMEOUT_MS = 5_000;
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
  const startedAt = Date.now();
  // Edge 153 reports a timed-out evaluation as a bare {"code":-32603,"message":"Internal
  // error"} after the full budget, so the clock is the only reliable tell.
  const ranOutOfTime = () => Date.now() - startedAt >= TIMEOUT_MS - 1000;
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
    if (looksLikeTimeout(message) || ranOutOfTime()) throw new Error(TIMEOUT_TEXT);
    throw new Error(`JavaScript execution error: ${message}`);
  }

  if (response.exceptionDetails) {
    const text = errorText(response.exceptionDetails);
    if (looksLikeTimeout(text) || ranOutOfTime()) throw new Error(TIMEOUT_TEXT);
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
    // JSON.stringify runs the page's own toJSON and getters, which can loop forever.
    // Runtime.evaluate's timeout does not cover callFunctionOn, so time it ourselves and
    // cut the page off rather than hanging the whole bridge request.
    const call = await Promise.race([
      send(tab.id, "Runtime.callFunctionOn", {
        objectId: result.objectId,
        functionDeclaration: SERIALIZER,
        returnByValue: true,
        awaitPromise: false,
      }),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("serializer timed out")), SERIALIZER_TIMEOUT_MS),
      ),
    ]);
    serialized = call?.result?.value ?? null;
  } catch (error) {
    if (/serializer timed out/.test(String(error?.message))) {
      await send(tab.id, "Runtime.terminateExecution").catch(() => {});
    }
    serialized = null;
  } finally {
    await send(tab.id, "Runtime.releaseObject", { objectId: result.objectId }).catch(() => {});
  }

  return { text: serialized ?? result.description ?? result.className ?? result.type };
}
