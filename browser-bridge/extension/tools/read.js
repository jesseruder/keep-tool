// read_page, find and get_page_text: everything that turns a page into text.

import { renderAxTree } from "../lib/ax.js";
import { refTable } from "../lib/cdp.js";
import { extractPageText, source } from "../lib/page.js";
import { findElements, renderMatches } from "../lib/find.js";
import { requireTab } from "../lib/sessions.js";
import { fullAxTree } from "./axtree.js";
import { evaluate } from "./shared.js";

const DEFAULT_MAX_CHARS = 50_000;
const PAGE_TEXT_MAX_CHARS = 60_000;

/** What to tell the model about the iframes on this page. */
function frameNotes(tree) {
  const notes = [];
  const included = [];
  if (tree.frames > 0) included.push(`${tree.frames} cross-origin`);
  if (tree.localFrames > 0) included.push(`${tree.localFrames} same-origin`);
  if (included.length > 0) {
    notes.push(
      `Includes the content of ${included.join(" and ")} iframe(s); their elements have refs like any other.`,
    );
  }
  if (tree.unplaced.length > 0) {
    notes.push(
      `${tree.unplaced.length} cross-origin iframe(s) are attached but their iframe element could not be located, so their content is not shown.`,
    );
  }
  if (tree.errors.length > 0) {
    notes.push(`Could not read ${tree.errors.length} iframe(s): ${tree.errors.join("; ")}`);
  }
  return notes;
}

export async function read_page(ctx, params = {}) {
  const tab = await requireTab(ctx.sessionKey, params.tabId);
  const tree = await fullAxTree(tab.id);
  const nodes = tree.nodes;
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
  notes.push(...frameNotes(tree));
  const header = `${tab.url}\n${tab.title ?? ""}`.trim();
  return { text: [header, rendered.text, ...notes].filter(Boolean).join("\n\n") };
}

export async function find(ctx, params = {}) {
  const tab = await requireTab(ctx.sessionKey, params.tabId);
  const query = String(params.query ?? "").trim();
  if (!query) throw new Error("query is required");
  const tree = await fullAxTree(tab.id);
  const result = findElements(tree.nodes, query, { refTable: refTable(tab.id) });
  const notes = frameNotes(tree);
  return {
    text: [
      `Matches for ${JSON.stringify(query)} on ${tab.url}:`,
      renderMatches(result),
      ...notes,
    ].join("\n"),
  };
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
