'use strict';

// A parsed row, cut into the pieces the renderer draws: one piece per styling run,
// with the cursor cell split out of whichever run it lands in so it can be drawn
// inverted (a block) or underlined (a pane whose process has exited).
//
// The cursor arrives as a place in the row's *string*, not as a cell index, because
// the two disagree wherever a wide glyph (two cells, one character), an emoji (one
// cell, two string units) or a combining mark (no cell of its own) appears. The
// emulator does that conversion while it still has the cells; see cursorOffset there.
//
// Drawing stops at `trimmed` — the last cell the program wrote or painted — because
// the rest of the row is the terminal's own blank fill, and a phone that drew 169
// cells of it per row would spend its frame on nothing. The cursor is the one thing
// that can sit past that edge, which is exactly where a prompt leaves it, so the row
// is padded out to it when it does.

const BLANK_RUN = Object.freeze({
  start: 0, end: 0, fg: null, bg: null,
  bold: false, dim: false, italic: false, underline: false, inverse: false,
});

// `cursor` is { offset, length } from the emulator, or null when this row has none.
function rowSegments(row, cursor) {
  if (!row || typeof row.text !== 'string') return [];
  const offset = cursor && Number.isInteger(cursor.offset) && cursor.offset >= 0 ? cursor.offset : -1;
  const width = offset < 0 ? 0 : Math.max(1, Number(cursor.length) || 1);
  const limit = offset >= 0 ? Math.max(row.trimmed, offset + width) : row.trimmed;
  if (limit <= 0) return [];
  const out = [];
  const push = (text, run, start) => {
    if (!text) return;
    const end = start + text.length;
    if (offset < 0 || offset >= end || offset + width <= start) { out.push({ text, run }); return; }
    // The cursor can only be clipped by a piece boundary if a run ended inside the
    // character it sits on, which the emulator's runs never do: a run boundary is a
    // change of attributes, and one cell carries one set.
    const head = offset - start;
    if (head > 0) out.push({ text: text.slice(0, head), run });
    out.push({ text: text.slice(Math.max(0, head), head + width), run, cursor: true });
    if (head + width < text.length) out.push({ text: text.slice(head + width), run });
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
