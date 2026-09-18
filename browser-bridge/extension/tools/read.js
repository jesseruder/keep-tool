// read_page, find and get_page_text: everything that turns a page into text.

import { countIframes, renderAxTree } from "../lib/ax.js";
import { refTable, send } from "../lib/cdp.js";
import { extractPageText, source } from "../lib/page.js";
import { findElements, renderMatches } from "../lib/find.js";
import { requireTab } from "../lib/sessions.js";
import { evaluate } from "./shared.js";

const DEFAULT_MAX_CHARS = 50_000;
const PAGE_TEXT_MAX_CHARS = 60_000;

async function fullAxTree(tabId) {
  const response = await send(tabId, "Accessibility.getFullAXTree", {});
  return response?.nodes ?? [];
}

export async function read_page(ctx, params = {}) {
  const tab = await requireTab(ctx.sessionKey, params.tabId);
  const nodes = await fullAxTree(tab.id);
  const rendered = renderAxTree(nodes, {
    filter: params.filter === "interactive" ? "interactive" : "all",
    maxDepth: Number.isFinite(params.depth) ? Number(params.depth) : 15,
    rootRef: params.ref_id ?? null,
    maxChars: Number.isFinite(params.max_chars) ? Number(params.max_chars) : DEFAULT_MAX_CHARS,
    refTable: refTable(tab.id),
  });
  if (rendered.error) throw new Error(rendered.error);

  const notes = [];
  if (rendered.truncated) {
    notes.push(
      `Truncated: showed ${rendered.keptLines} of ${rendered.lineCount} lines (${rendered.text.length} of ${rendered.fullLength} characters). Pass a larger max_chars, or narrow with depth or ref_id.`,
    );
  }
  const iframes = countIframes(nodes);
  if (iframes > 0) {
    notes.push(
      `This page has ${iframes} iframe(s). Content inside cross-origin iframes is not included (phase 1 limitation).`,
    );
  }
  const header = `${tab.url}\n${tab.title ?? ""}`.trim();
  return { text: [header, rendered.text, ...notes].filter(Boolean).join("\n\n") };
}

export async function find(ctx, params = {}) {
  const tab = await requireTab(ctx.sessionKey, params.tabId);
  const query = String(params.query ?? "").trim();
  if (!query) throw new Error("query is required");
  const nodes = await fullAxTree(tab.id);
  const result = findElements(nodes, query, { refTable: refTable(tab.id) });
  return { text: `Matches for ${JSON.stringify(query)} on ${tab.url}:\n${renderMatches(result)}` };
}

export async function get_page_text(ctx, params = {}) {
  const tab = await requireTab(ctx.sessionKey, params.tabId);
  const result = await evaluate(tab.id, `(${source(extractPageText)})(${PAGE_TEXT_MAX_CHARS})`);
  if (!result) throw new Error("Could not read text from this page");
  const notes = result.truncated
    ? `\n\n[Truncated at ${PAGE_TEXT_MAX_CHARS} characters; the page holds ${result.total}.]`
    : "";
  return { text: `${result.url}\n${result.title}\n\n${result.text}${notes}` };
}
