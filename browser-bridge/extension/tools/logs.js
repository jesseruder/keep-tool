// read_console_messages and read_network_requests, served from the per-tab CDP buffers.

import { attach, isAttached, stateFor } from "../lib/cdp.js";
import { requireTab } from "../lib/sessions.js";

const DEFAULT_LIMIT = 100;

const ERROR_LEVELS = new Set(["error", "assert", "exception", "severe"]);

function limitOf(params) {
  const limit = Number(params.limit);
  return Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 5000) : DEFAULT_LIMIT;
}

export async function read_console_messages(ctx, params = {}) {
  const tab = await requireTab(ctx.sessionKey, params.tabId);
  const fresh = !isAttached(tab.id);
  await attach(tab.id);
  const state = stateFor(tab.id);

  let entries = state.console;
  if (params.onlyErrors) entries = entries.filter((entry) => ERROR_LEVELS.has(entry.level));
  if (params.pattern) {
    let pattern;
    try {
      pattern = new RegExp(params.pattern, "i");
    } catch (error) {
      throw new Error(`Invalid pattern: ${error.message}`);
    }
    entries = entries.filter((entry) => pattern.test(entry.text) || pattern.test(entry.level));
  }
  const limit = limitOf(params);
  const shown = entries.slice(-limit);
  const lines = shown.map((entry) => {
    const where = entry.url ? ` (${entry.url}${entry.line != null ? `:${entry.line}` : ""})` : "";
    return `[${entry.level}] ${entry.text}${where}`;
  });

  if (params.clear) {
    state.console.length = 0;
  }

  const header =
    lines.length === 0
      ? fresh
        ? "No console messages captured. The debugger was just attached to this tab, so only messages from now on are recorded — reload the page and read again."
        : "No console messages matched."
      : `${shown.length} of ${entries.length} matching console messages (buffer holds ${state.console.length}):`;
  return { text: [header, ...lines].join("\n") };
}

export async function read_network_requests(ctx, params = {}) {
  const tab = await requireTab(ctx.sessionKey, params.tabId);
  const fresh = !isAttached(tab.id);
  await attach(tab.id);
  const state = stateFor(tab.id);

  let records = state.network;
  if (params.urlPattern) {
    const needle = String(params.urlPattern);
    records = records.filter((record) => record.url.includes(needle));
  }
  const limit = limitOf(params);
  const shown = records.slice(-limit);
  const lines = shown.map((record) => {
    const status = record.error ? `FAILED ${record.error}` : (record.status ?? "pending");
    const size = record.encodedDataLength != null ? `${record.encodedDataLength}B` : "-";
    const time = record.durationMs != null ? `${record.durationMs}ms` : "-";
    return `${record.method} ${status} ${record.url} [${record.resourceType}${record.mimeType ? ` ${record.mimeType}` : ""}] ${size} ${time}`;
  });

  if (params.clear) {
    state.network.length = 0;
    state.networkById.clear();
  }

  const header =
    lines.length === 0
      ? fresh
        ? "No network requests captured. The debugger was just attached to this tab, so only requests from now on are recorded — reload the page and read again."
        : "No network requests matched."
      : `${shown.length} of ${records.length} matching requests (buffer holds ${state.network.length}):`;
  return { text: [header, ...lines].join("\n") };
}
