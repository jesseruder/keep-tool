'use strict';

// A headless xterm wrapped in the smallest surface the phone terminal needs: write
// bytes in, read back the visible rows as text plus styling runs. The desktop console
// hands the same bytes to @xterm/xterm and lets the DOM renderer draw them; React
// Native has no canvas to hand them to, so the parser runs here and the rows are
// rendered as native <Text>. Keeping the package identical to bin/host.js's means a
// pane looks the same on the phone as it does in the console.
// xterm's write queue calls a bare `performance.now()` to decide when to yield. Node
// and modern React Native both have one; an older Hermes runtime does not, and the
// failure would be a throw from deep inside the parser rather than anything readable.
// Filling it in before the parser loads costs nothing and removes that whole class of
// device-only surprise.
const scope = typeof globalThis === 'object' ? globalThis : global;
if (!scope.performance || typeof scope.performance.now !== 'function') {
  const origin = Date.now();
  scope.performance = { ...(scope.performance || {}), now: () => Date.now() - origin };
}

const { Terminal } = require('@xterm/headless');

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_SCROLLBACK = 1000;

// Color modes as xterm reports them through getFgColorMode()/getBgColorMode().
const COLOR_MODE_DEFAULT = 0;

function colorOf(mode, value, palette, rgb) {
  if (mode === COLOR_MODE_DEFAULT) return null;
  if (rgb) return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
  if (palette) return value;
  return null;
}

function cellStyle(cell) {
  return {
    fg: colorOf(cell.getFgColorMode(), cell.getFgColor(), cell.isFgPalette(), cell.isFgRGB()),
    bg: colorOf(cell.getBgColorMode(), cell.getBgColor(), cell.isBgPalette(), cell.isBgRGB()),
    bold: Boolean(cell.isBold()),
    dim: Boolean(cell.isDim()),
    italic: Boolean(cell.isItalic()),
    underline: Boolean(cell.isUnderline()),
    inverse: Boolean(cell.isInverse()),
  };
}

function sameStyle(a, b) {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim
    && a.italic === b.italic && a.underline === b.underline && a.inverse === b.inverse;
}

// One buffer line becomes one { text, runs, trimmed } row. Runs are half-open
// character offsets into `text`, not cell indices: a wide CJK glyph occupies two cells
// but one character, and the row renderer slices the string, not the buffer. `trimmed`
// is where xterm would stop drawing — past the last cell the program actually wrote —
// which is not the same as the last non-space character, because a program can paint a
// background onto explicit spaces.
function readLine(line, cols, cell) {
  if (!line) return { text: '', runs: [], trimmed: 0 };
  let text = '';
  const runs = [];
  let open = null;
  let trimmed = 0;
  for (let x = 0; x < cols; x++) {
    line.getCell(x, cell);
    // Width 0 is the trailing half of a wide glyph; its character already landed.
    if (cell.getWidth() === 0) continue;
    const chars = cell.getChars() || ' ';
    const style = cellStyle(cell);
    if (open && sameStyle(open, style)) open.end = text.length + chars.length;
    else {
      open = { start: text.length, end: text.length + chars.length, ...style };
      runs.push(open);
    }
    text += chars;
    if (cell.getCode() !== 0) trimmed = text.length;
  }
  return { text, runs, trimmed };
}

function createEmulator(options = {}) {
  const cols = Number.isInteger(options.cols) && options.cols > 0 ? options.cols : DEFAULT_COLS;
  const rows = Number.isInteger(options.rows) && options.rows > 0 ? options.rows : DEFAULT_ROWS;
  const scrollback = Number.isInteger(options.scrollback) ? options.scrollback : DEFAULT_SCROLLBACK;
  // Injectable so a test can build one without the private hook below and check the
  // fallback; nothing in the app passes it.
  const TerminalClass = options.Terminal || Terminal;
  const term = new TerminalClass({
    cols,
    rows,
    scrollback,
    // getFgColorMode() and friends are proposed API; without this they throw.
    allowProposedApi: true,
    convertEol: false,
  });

  // The headless build has no renderer, so there is no onRender to subscribe to. The
  // input handler's refresh request is the same signal a renderer would consume, and
  // a scroll invalidates the whole viewport.
  const dirty = new Set();
  const markAll = () => { for (let y = 0; y < term.rows; y++) dirty.add(y); };
  const markRange = (start, end) => {
    const first = Math.max(0, start | 0);
    const last = Math.min(term.rows - 1, end | 0);
    for (let y = first; y <= last; y++) dirty.add(y);
  };
  markAll();
  const disposables = [];
  const refresh = term._core && term._core._inputHandler && term._core._inputHandler.onRequestRefreshRows;
  // That hook is private, so a future xterm may simply not have it. Losing it must cost
  // precision, not correctness: without it every write invalidates the whole viewport,
  // which is what a renderer with no dirty information has to assume anyway.
  const hasRefresh = typeof refresh === 'function';
  if (hasRefresh) {
    // xterm 6 fires a single { start, end }; older builds fired (start, end).
    disposables.push(refresh.call(term._core._inputHandler, (event, maybeEnd) => {
      if (event && typeof event === 'object') markRange(event.start, event.end);
      else markRange(event, maybeEnd === undefined ? event : maybeEnd);
    }));
  }
  if (typeof term.onScroll === 'function') disposables.push(term.onScroll(() => markAll()));
  if (typeof term.onResize === 'function') disposables.push(term.onResize(() => markAll()));

  const cell = term.buffer.active.getNullCell();
  let disposed = false;

  return {
    term,
    get cols() { return term.cols; },
    get rows() { return term.rows; },

    // `data` is a string or a Uint8Array, exactly as it arrives off the socket.
    // xterm parses asynchronously; `done` fires once this chunk has been applied.
    write(data, done) {
      if (disposed) return;
      if (!hasRefresh) markAll();
      term.write(data, done);
    },

    // Resolves once every write queued so far has been parsed. Receiving a frame is
    // not the same as having parsed it: xterm's write queue yields, so anything that
    // depends on the screen being current — the end of a replay, a resize, a read —
    // has to drain first. `drain` is the name the socket client asks for.
    flush() {
      return new Promise((resolve) => {
        if (disposed) { resolve(); return; }
        term.write('', resolve);
      });
    },
    drain(done) {
      const settled = new Promise((resolve) => {
        if (disposed) { resolve(); return; }
        term.write('', resolve);
      });
      if (done) settled.then(done, done);
      return settled;
    },

    resize(nextCols, nextRows) {
      if (disposed) return;
      if (nextCols === term.cols && nextRows === term.rows) return;
      try { term.resize(nextCols, nextRows); } catch {}
      markAll();
    },

    // The visible viewport, top row first: always exactly `rows` entries, so the
    // renderer can key rows by index without holes.
    rows(range) {
      const buffer = term.buffer.active;
      const top = buffer.viewportY;
      const first = range && Number.isInteger(range.start) ? Math.max(0, range.start) : 0;
      const last = range && Number.isInteger(range.end) ? Math.min(term.rows - 1, range.end) : term.rows - 1;
      const out = [];
      for (let y = first; y <= last; y++) out.push(readLine(buffer.getLine(top + y), term.cols, cell));
      return out;
    },

    cursor() {
      const buffer = term.buffer.active;
      // DECTCEM is not on the public API; the core service is where the parser puts it.
      const hidden = term._core && term._core.coreService && term._core.coreService.isCursorHidden;
      return {
        x: buffer.cursorX,
        // cursorY is measured from baseY; the renderer wants it from the viewport top.
        y: buffer.baseY + buffer.cursorY - buffer.viewportY,
        visible: !hidden,
      };
    },

    isAlternate() { return term.buffer.active.type === 'alternate'; },

    // Rows the parser touched since the last takeDirty(), as ascending viewport
    // indices. Empty means nothing on screen changed.
    takeDirty() {
      const out = [...dirty].sort((a, b) => a - b);
      dirty.clear();
      return out;
    },
    peekDirty() { return [...dirty].sort((a, b) => a - b); },
    markAllDirty() { markAll(); },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of disposables) { try { entry.dispose(); } catch {} }
      disposables.length = 0;
      try { term.dispose(); } catch {}
    },
  };
}

module.exports = { createEmulator, readLine };
