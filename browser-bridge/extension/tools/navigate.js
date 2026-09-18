// navigate: url, "back" or "forward", with the standalone tabId-less shortcut.

import { attach } from "../lib/cdp.js";
import { requireTab } from "../lib/sessions.js";
import { normalizeUrl } from "../lib/url.js";
import { tabs_context_mcp } from "./tabs.js";

const LOAD_TIMEOUT_MS = 30_000;

/** Listen before navigating, so a fast load cannot finish before we are watching. */
function watchForLoad(tabId, timeoutMs = LOAD_TIMEOUT_MS) {
  let settle;
  const done = new Promise((resolve) => {
    settle = resolve;
  });
  let finished = false;
  const listener = (id, info) => {
    if (id === tabId && info.status === "complete") finish("complete");
  };
  const timer = setTimeout(() => finish("timeout"), timeoutMs);
  const finish = (reason) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    chrome.tabs.onUpdated.removeListener(listener);
    settle(reason);
  };
  chrome.tabs.onUpdated.addListener(listener);
  return { done, cancel: () => finish("cancelled") };
}

export async function navigate(ctx, params = {}) {
  const target = String(params.url ?? "").trim();
  let tabId = params.tabId;
  let contextText = null;

  if (tabId == null) {
    if (target === "back" || target === "forward") {
      throw new Error('tabId is required for url:"back"/"forward"');
    }
    const context = await tabs_context_mcp(ctx, { createIfEmpty: true });
    const first = context.context.tabs[0];
    if (!first) throw new Error("Could not open a tab for this session");
    tabId = first.id;
    contextText = context.text;
  } else {
    await requireTab(ctx.sessionKey, tabId);
    tabId = Number(tabId);
  }

  const watcher = watchForLoad(tabId);
  try {
    if (target === "back") {
      await chrome.tabs.goBack(tabId);
    } else if (target === "forward") {
      await chrome.tabs.goForward(tabId);
    } else {
      const url = normalizeUrl(target);
      await chrome.tabs.update(tabId, { url });
    }
  } catch (error) {
    watcher.cancel();
    throw new Error(`Navigation failed: ${error.message}`);
  }

  const outcome = await watcher.done;
  try {
    await attach(tabId);
  } catch (error) {
    console.warn("browser-bridge: attach after navigation failed", error.message);
  }

  const tab = await chrome.tabs.get(tabId);
  const lines = [
    `Tab ${tabId}: ${tab.url}`,
    tab.title ? `Title: ${tab.title}` : null,
    outcome === "timeout"
      ? `The page was still loading after ${LOAD_TIMEOUT_MS / 1000}s; the result may be incomplete.`
      : null,
    contextText ? `\nTab group context:\n${contextText}` : null,
  ].filter(Boolean);
  return { text: lines.join("\n"), url: tab.url, title: tab.title, tabId };
}
