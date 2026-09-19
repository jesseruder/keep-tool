'use strict';

// A parsed row, cut into the pieces the renderer draws: one piece per styling run,
// with the cursor cell split out of whichever run it lands in so it can be drawn
// inverted (a block) or underlined (a pane whose process has exited).
//
// Drawing stops at `trimmed` — the last cell the program actually wrote — because the
// rest of the row is the terminal's own blank fill, and a phone that drew 169 cells of
// it per row would spend its frame on nothing. The cursor is the one thing that can
// sit past that edge, which is exactly where a prompt leaves it, so the row is padded
// out to it when it does.

const BLANK_RUN = Object.freeze({
  start: 0, end: 0, fg: null, bg: null,
  bold: false, dim: false, italic: false, underline: false, inverse: false,
});

function rowSegments(row, cursorX = -1) {
  if (!row || typeof row.text !== 'string') return [];
  const at = Number.isInteger(cursorX) ? cursorX : -1;
  const limit = at >= 0 ? Math.max(row.trimmed, at + 1) : row.trimmed;
  if (limit <= 0) return [];
  const out = [];
  const push = (text, run, start) => {
    if (!text) return;
    if (at < start || at >= start + text.length) { out.push({ text, run }); return; }
    const index = at - start;
    if (index > 0) out.push({ text: text.slice(0, index), run });
    out.push({ text: text[index], run, cursor: true });
    if (index + 1 < text.length) out.push({ text: text.slice(index + 1), run });
  };
  let filled = 0;
  for (const run of row.runs || []) {
    if (run.start >= limit) break;
    const end = Math.min(run.end, limit);
    if (end <= run.start) continue;
    push(row.text.slice(run.start, end), run, run.start);
    filled = end;
  }
  if (filled < limit) push(' '.repeat(limit - filled), BLANK_RUN, filled);
  return out;
}

module.exports = { BLANK_RUN, rowSegments };
