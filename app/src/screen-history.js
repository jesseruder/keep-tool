'use strict';

function emptyScreenHistory() {
  return {
    active: false,
    snapshot: null,
    start: null,
    rows: [],
    tail: [],
    cursor: null,
    exhausted: false,
    truncated: false,
    frame: null,
  };
}

function keyedRows(snapshot, start, lines) {
  return (Array.isArray(lines) ? lines : []).map((line, index) => ({
    key: `${snapshot}:line:${start + index}`,
    text: String(line),
  }));
}

function applyScreenHistoryPage(current, response) {
  const snapshot = String(response && response.snapshot || '');
  const start = Number(response && response.start);
  if (!snapshot || !Number.isSafeInteger(start) || start < 0) throw new Error('Invalid terminal history response');
  const pageRows = keyedRows(snapshot, start, response.lines);
  if (current && current.active) {
    if (current.snapshot !== snapshot) throw new Error('Terminal history snapshot changed');
    if (start + pageRows.length !== current.start) throw new Error('Terminal history page is out of order');
    return {
      ...current,
      start,
      rows: [...pageRows, ...current.rows],
      cursor: response.cursor || null,
      exhausted: Boolean(response.exhausted),
      truncated: Boolean(response.truncated),
    };
  }
  const tailStart = Number(response.tailStart);
  if (!Number.isSafeInteger(tailStart) || tailStart < 0 || !Array.isArray(response.tail)) {
    throw new Error('Invalid terminal history tail');
  }
  return {
    active: true,
    snapshot,
    start,
    rows: pageRows,
    tail: keyedRows(snapshot, tailStart, response.tail),
    cursor: response.cursor || null,
    exhausted: Boolean(response.exhausted),
    truncated: Boolean(response.truncated),
    frame: {
      pane: response.pane,
      sessionId: response.sessionId,
      cols: response.cols,
      rows: response.rows,
      title: response.title,
      alt: response.alt,
    },
  };
}

function visibleScreenRows(history, liveLines) {
  if (history && history.active) return [...history.rows, ...history.tail];
  return (Array.isArray(liveLines) ? liveLines : []).map((line, index) => ({ key: `live:${index}`, text: String(line) }));
}

function screenHistoryPath(target, options = {}) {
  const params = target && target.pane && !target.sessionId
    ? [`pane=${encodeURIComponent(target.pane)}`]
    : [`session=${encodeURIComponent(target && target.sessionId)}`];
  params.push(`lines=${encodeURIComponent(options.lines ?? 200)}`);
  if (options.cursor) params.push(`cursor=${encodeURIComponent(options.cursor)}`);
  else params.push(`tailLines=${encodeURIComponent(options.tailLines ?? 120)}`);
  return `/api/screen/history?${params.join('&')}`;
}

module.exports = { applyScreenHistoryPage, emptyScreenHistory, screenHistoryPath, visibleScreenRows };
