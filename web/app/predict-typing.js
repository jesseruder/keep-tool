// Predictive local echo for an agent's input box.
//
// A pane on another node echoes a keystroke only after a network round trip and the
// agent's own render, which makes typing feel sticky. This module lets the console
// show a typed character at once as an overlay drawn over its own xterm, with a
// stand-in cursor after it, and leaves xterm's buffer and cursor to the pane alone.
// Each echo is matched to the keystroke it answers, which confirms the guess and
// times the echo; a guess whose echo never lands keeps its overlay until it expires,
// which is the signal that it was not confirmed. Nothing here changes what is sent,
// and nothing here writes a cell or moves the cursor: the pane's renderer sends
// relative cursor moves from where it believes the cursor is, so a cursor a guess
// had moved would put every one of them in the wrong place.
//
// The module has no imports so the terminal tests can load it as plain source.

export const PREDICT_TYPING_KEY = 'keep.console.predictTyping';
export const PREDICT_TYPING_MODES = ['auto', 'on', 'off'];
// Auto turns prediction on once a pane's measured echo is slower than this. A local
// pane echoes in 10-20 ms and a remote one well over 100 ms, so the line sits far
// from both.
export const PREDICT_AUTO_THRESHOLD_MS = 50;
const SAMPLE_WINDOW = 8;
const MIN_SAMPLES = 3;
// A keystroke the agent never echoed (it was busy, or the key did nothing) must not
// later be matched to an unrelated redraw and read as a huge echo time.
const STALE_KEYSTROKE_MS = 5000;

// The agents whose input box is predicted. Claude Code's renderer sends a diff of
// the cells that changed, placed with relative cursor moves (a trailing space whose
// cell was already blank echoes as a bare cursor-forward). What makes it predictable
// is that every echo changes the input text before the pane's cursor, which is what
// the comparison in outputParsed reads, so a guess never lingers unconfirmed. Codex
// redraws only the cells that changed as well, but it is not predicted until its
// echo has been checked the same way.
export const PREDICTED_AGENTS = ['claude'];

// Claude Code's input line starts with `❯` and a space (U+00A0 in the empty box).
// Only a pane whose agent is on record is matched: a shell prompt can use the same
// glyph, and a shell's line is not the agent's input box.
const PROMPTS = {
  claude: { line: /^(\s*)❯[ \u00a0]/, menu: /^\s*❯[ \u00a0]+\d+\.\s/ },
};
// A highlighted choice in the agent's selection menu also starts with the marker
// (`❯ 1. Yes`). Typing there picks an option rather than editing text.

export function getPredictTypingPreference(storage) {
  try {
    const value = (storage ?? globalThis.localStorage)?.getItem(PREDICT_TYPING_KEY);
    return PREDICT_TYPING_MODES.includes(value) ? value : 'auto';
  } catch { return 'auto'; }
}

export function setPredictTypingPreference(mode, storage) {
  if (!PREDICT_TYPING_MODES.includes(mode)) return false;
  try { (storage ?? globalThis.localStorage)?.setItem(PREDICT_TYPING_KEY, mode); }
  catch { return false; }
  return true;
}

// 'char' for one printable, single-cell character; 'backspace' for DEL or BS; null
// for everything else, including control keys, escape sequences and pastes of more
// than one character. A prediction must advance the cursor by exactly one cell, as
// xterm will when the echo lands. xterm's public API exposes no character-width
// lookup, so rather than copy its tables this accepts only ranges it always draws
// one cell wide: printable ASCII, the Latin-1 supplement without the soft hyphen
// (which it draws at width 0), and Latin Extended-A and -B. Wide characters, emoji
// and combining marks from any script are left to the real echo.
export function predictableKey(data) {
  if (data === '\x7f' || data === '\b') return 'backspace';
  if (typeof data !== 'string' || !data) return null;
  const code = data.codePointAt(0);
  if (String.fromCodePoint(code) !== data) return null;
  if (code >= 0x20 && code < 0x7f) return 'char';
  if (code >= 0xa0 && code <= 0x24f && code !== 0xad) return 'char';
  return null;
}

const blankCell = (cell) => !cell || cell.getChars() === '' || cell.getChars() === ' ';

// Decides whether one keystroke can be shown ahead of the echo, and returns its kind
// and where the input starts, or null. `extraColumns` is how far the keystrokes still
// pending will move the pane's cursor once echoed, so the checks see where the cursor
// is about to be.
export function predictKeystroke(terminal, data, { agent, composing = false, extraColumns = 0 } = {}) {
  // Only an agent's own input box is predicted; a shell pane, or a pane with no
  // agent on record, never is.
  const prompts = PREDICTED_AGENTS.includes(agent) && Object.hasOwn(PROMPTS, agent) ? PROMPTS[agent] : null;
  const kind = predictableKey(data);
  if (!prompts || !kind || composing) return null;
  if (terminal.hasSelection?.()) return null;
  const buffer = terminal.buffer?.active;
  if (!buffer || buffer.type !== 'normal') return null;
  // getLine takes an absolute row, so the cursor's row sits below the scrollback.
  const line = buffer.getLine(buffer.baseY + buffer.cursorY);
  if (!line) return null;
  const text = line.translateToString(true);
  const prompt = prompts.line.exec(text);
  if (!prompt || prompts.menu.test(text)) return null;
  const inputStart = prompt[1].length + 2;
  const cursorX = buffer.cursorX + extraColumns;
  if (cursorX < inputStart) return null;
  if (kind === 'backspace' && cursorX <= inputStart) return null;
  if (cursorX >= terminal.cols - 3) return null;
  // Only the end of the input is predicted. Mid-line the agent inserts rather than
  // overwrites, and a guess there would shuffle visible text for a round trip. The
  // rest of the line may be blank, the agent's drawn cursor (an inverse cell), or a
  // dim placeholder or suggestion, which the overlays cover.
  for (let x = buffer.cursorX; x < terminal.cols; x++) {
    const cell = line.getCell(x);
    if (blankCell(cell)) continue;
    if (cell.isDim() || (x === buffer.cursorX && cell.isInverse())) continue;
    return null;
  }
  return { kind, inputStart };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// The classes the console's stylesheet gives the overlays: a guessed character, a
// cell a guessed Backspace blanks (or a placeholder the guesses cover), and the
// stand-in cursor after the guesses.
export const PREDICTED_CELL_CLASS = 'keep-predicted-cell';
export const PREDICTED_BLANK_CLASS = 'keep-predicted-blank';
export const PREDICTED_CURSOR_CLASS = 'keep-predicted-cursor';
// The only bytes the predictor ever writes to xterm: hide and show the cursor
// (DECTCEM). They change no cell and move nothing.
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

// One per mounted terminal. `agent` names the pane's agent (only those in
// PREDICTED_AGENTS are predicted or measured), `remote` says whether the pane
// is on another node, `mode` reads the viewer's setting, `now` is a monotonic
// clock, and `outputQueued` says whether any of the pane's output is still
// waiting in xterm's write queue.
export function createTypingPredictor({
  terminal, agent, remote, mode = getPredictTypingPreference, now = () => Date.now(),
  outputQueued = () => false,
}) {
  const samples = [];
  // Keystrokes whose echo has not landed, oldest first, each with the input text it
  // should leave before the cursor. That text is what matches an echo to the
  // keystroke it answers, even when the agent renders several keystrokes at once.
  // Auto records these while prediction is still off: that is how it measures. A
  // guess that is shown is `drawn`.
  let entries = [];
  let row = -1;
  let inputStart = 0;
  // The pane's own cursor column on the prompt row as last seen; the overlays are
  // laid out from it. Only the pane moves xterm's cursor.
  let base = 0;
  // The overlays on screen, keyed by what they show and where, and the marker that
  // anchors them to the prompt row while a guess is shown. The marker follows its
  // line through reflow and scrollback trimming, which `row` does not, so a marker
  // that has left `row` means the chain's row and columns are no longer known.
  let marker = null;
  const overlays = new Map();

  // The real cursor is hidden while a guess stands, since the stand-in cursor sits
  // after the guesses; with no guess standing its visibility is exactly what the
  // pane last asked for. `paneShows` is that request (DECTCEM), which is what is
  // put back; the predictor's own writes are left out of it. While `hidden`, the
  // pane's own show (Claude Code ends every frame with one) is recorded and not
  // performed, so the real cursor never appears beside the stand-in one, even in a
  // frame split across chunks. A show that carries other modes with it cannot be
  // withheld alone: xterm performs it and `reconceal` hides the cursor again as soon
  // as its chunk has parsed. `restoreOwed` is a restore waiting for queued output
  // to settle: until then the pane's latest request is not known.
  let hidden = false;
  let paneShows = true;
  let reconceal = false;
  let restoreOwed = false;
  let localWrite = false;
  const hooks = [];
  const cursorMode = (visible) => (params) => {
    if (localWrite || !params.includes(25)) return false;
    paneShows = visible;
    if (visible && hidden) {
      if (params.length === 1) return true;
      reconceal = true;
    }
    return false;
  };
  if (typeof terminal.parser?.registerCsiHandler === 'function') {
    hooks.push(terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, cursorMode(true)));
    hooks.push(terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, cursorMode(false)));
  }
  // Written in the same queue as the pane's output, so the flag brackets exactly
  // these bytes.
  const writeLocal = (bytes) => {
    terminal.write('', () => { localWrite = true; });
    terminal.write(bytes, () => { localWrite = false; });
  };

  const echoMs = () => samples.length >= MIN_SAMPLES ? median(samples) : null;
  const enabled = () => {
    const setting = mode();
    if (setting === 'on') return true;
    if (setting === 'off') return false;
    const measured = echoMs();
    return Boolean(remote()) && measured != null && measured > PREDICT_AUTO_THRESHOLD_MS;
  };
  const inputBeforeCursor = () => {
    const buffer = terminal.buffer.active;
    const line = buffer.getLine(row);
    return line ? line.translateToString(false, inputStart, Math.max(inputStart, buffer.cursorX)) : '';
  };
  // How far the pending keystrokes will move the pane's cursor once echoed.
  const advance = () => entries.reduce((sum, entry) => sum + (entry.kind === 'backspace' ? -1 : 1), 0);

  // Where every overlay goes, from the pane's cursor and the pending keystrokes. A
  // character guess sits at the cursor plus the net advance of the keystrokes before
  // it; a Backspace guess takes back the cell before it, removing the overlay of a
  // guessed character there or blanking a character the pane has drawn. Keystrokes
  // recorded only to measure count toward the position but show nothing. The
  // stand-in cursor follows the last of them, and a dim placeholder or drawn cursor
  // the pane has not yet erased past it is veiled.
  const layout = () => {
    if (!entries.some((entry) => entry.drawn)) return { cells: new Map(), cursor: null, veil: null };
    const cells = new Map();
    let n = 0;
    for (const entry of entries) {
      if (entry.kind === 'char') {
        if (entry.drawn) cells.set(base + n, entry.ch);
        else cells.delete(base + n);
        n++;
      } else {
        n--;
        if (n >= 0) cells.delete(base + n);
        else if (entry.drawn) cells.set(base + n, null);
      }
    }
    const cursor = base + n;
    // The stand-in cursor is opaque and covers a blank there.
    cells.delete(cursor);
    for (const x of cells.keys()) if (x < 0 || x >= terminal.cols) cells.delete(x);
    let veil = null;
    const line = terminal.buffer.active.getLine(row);
    for (let x = cursor + 1; line && x < terminal.cols; x++) {
      const cell = line.getCell(x);
      if (!blankCell(cell) && (cell.isDim() || cell.isInverse())) veil = { x: cursor + 1, width: x - cursor };
    }
    return { cells, cursor: cursor >= 0 && cursor < terminal.cols ? cursor : null, veil };
  };

  const colors = () => {
    const theme = terminal.options?.theme || {};
    let style = null;
    try { style = terminal.element ? globalThis.getComputedStyle?.(terminal.element) : null; } catch {}
    const background = theme.background || style?.backgroundColor || '#000';
    const foreground = theme.foreground || style?.color || '#fff';
    return { background, foreground, cursor: theme.cursor || foreground, cursorAccent: theme.cursorAccent || background };
  };
  const CLASSES = { char: PREDICTED_CELL_CLASS, blank: PREDICTED_BLANK_CLASS, veil: PREDICTED_BLANK_CLASS, cursor: PREDICTED_CURSOR_CLASS };
  // Each overlay draws its own character over an opaque background, in the
  // terminal's font, so it covers whatever the cell holds: a blank, the agent's
  // inverse cursor cell, a dim placeholder, a character a Backspace guess deletes.
  const paint = (kind, ch) => (element) => {
    if (!element) return;
    element.classList?.add(CLASSES[kind]);
    element.textContent = ch;
    const style = element.style;
    if (!style) return;
    const options = terminal.options || {};
    const { background, foreground, cursor, cursorAccent } = colors();
    if (options.fontFamily) style.fontFamily = options.fontFamily;
    if (options.fontSize) style.fontSize = `${options.fontSize}px`;
    if (options.fontWeight) style.fontWeight = String(options.fontWeight);
    // xterm gives the element the cell's height as its line height; keep one if not.
    if (!style.lineHeight && style.height) style.lineHeight = style.height;
    style.backgroundColor = kind === 'cursor' ? cursor : background;
    style.color = kind === 'cursor' ? cursorAccent : foreground;
  };
  const canDraw = () => typeof terminal.registerDecoration === 'function' && typeof terminal.registerMarker === 'function';
  const clearOverlays = () => {
    for (const overlay of overlays.values()) overlay.decoration?.dispose();
    overlays.clear();
    marker?.dispose();
    marker = null;
  };
  const place = (key, kind, x, width, ch) => {
    const decoration = terminal.registerDecoration({ marker, x, width, layer: 'top' }) || null;
    overlays.set(key, { kind, decoration });
    decoration?.onRender(paint(kind, ch));
  };
  const conceal = () => {
    hidden = true;
    reconceal = false;
    if (paneShows) writeLocal(HIDE_CURSOR);
  };
  // Puts back the pane's own cursor visibility. With pane output still queued, the
  // request that output makes is not known yet, and a show written now would parse
  // after it, so the restore waits for the output to settle (outputParsed).
  const restore = () => {
    if (!hidden) return;
    if (outputQueued()) { restoreOwed = true; return; }
    hidden = false;
    reconceal = false;
    restoreOwed = false;
    if (paneShows) writeLocal(SHOW_CURSOR);
  };
  const anchored = () => !marker || (!marker.isDisposed && marker.line === row);

  // Brings the overlays and the real cursor's visibility in line with the pending
  // keystrokes. An overlay already in place is left alone; one that moved is
  // disposed and registered again at its new column.
  const render = () => {
    // A prompt row that moved under the chain (reflow, scrollback trimming) ends
    // it: its columns were laid out on a line that is no longer where they point.
    if (!anchored()) entries = [];
    const { cells, cursor, veil } = layout();
    if (cursor == null) {
      clearOverlays();
      restore();
      return;
    }
    restoreOwed = false;
    if (!hidden) conceal();
    if (!marker && typeof terminal.registerMarker === 'function') {
      const buffer = terminal.buffer.active;
      marker = terminal.registerMarker(row - (buffer.baseY + buffer.cursorY)) || null;
    }
    // A build without decorations (the headless one in tests) keeps the guesses,
    // the marker and the cursor handling, and draws nothing.
    if (!marker || !canDraw()) return;
    const wanted = new Map();
    for (const [x, ch] of cells) {
      const kind = ch == null ? 'blank' : 'char';
      wanted.set(`${kind}:${x}:${ch ?? ''}`, [kind, x, 1, ch ?? '']);
    }
    if (veil) wanted.set(`veil:${veil.x}:${veil.width}`, ['veil', veil.x, veil.width, '']);
    // The stand-in cursor goes last, so it is drawn above any overlay beside it.
    wanted.set(`cursor:${cursor}`, ['cursor', cursor, 1, '']);
    for (const [key, overlay] of overlays) {
      if (wanted.has(key)) continue;
      overlay.decoration?.dispose();
      overlays.delete(key);
    }
    for (const [key, [kind, x, width, ch]] of wanted) if (!overlays.has(key)) place(key, kind, x, width, ch);
  };

  // Called with each keystroke before it is sent; returns whether a guess is shown.
  // With none of the pane's output queued, xterm's cursor is the pane's as it stands.
  const keystroke = (data, options = {}) => {
    const at = now();
    if (!anchored() || (entries.length && at - entries[0].at > STALE_KEYSTROKE_MS)) {
      entries = [];
      render();
    }
    // xterm parses writes later, in order. With pane output still queued, the
    // screen read here is older than the one the echo will land on: that output may
    // move the cursor or replace the prompt. Such a keystroke is sent unpredicted
    // and unmeasured, and the chain it would have extended can no longer be followed.
    const decision = outputQueued() ? null
      : predictKeystroke(terminal, data, { ...options, agent: agent(), extraColumns: advance() });
    if (!decision) {
      // Enter, arrows, pastes and the like change the line in ways the expected
      // text cannot follow, so the keystrokes before them are no longer matched.
      entries = [];
      render();
      return false;
    }
    const buffer = terminal.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY;
    if (entries.length && (cursorRow !== row || decision.inputStart !== inputStart)) {
      entries = [];
      render();
    }
    row = cursorRow;
    inputStart = decision.inputStart;
    base = buffer.cursorX;
    const before = entries.length ? entries.at(-1).expected : inputBeforeCursor();
    const expected = decision.kind === 'backspace' ? before.slice(0, -1) : before + data;
    const drawn = enabled();
    entries.push({ at, ch: data, kind: decision.kind, before, expected, drawn });
    render();
    return drawn;
  };

  // Called after a chunk of the agent's output has parsed; `settled` is false while
  // more of its output is still queued behind it, since a render split across
  // chunks leaves the cursor wherever the chunk ended.
  const outputParsed = (settled = true) => {
    if (!settled) {
      if (!anchored()) render();
      else if (hidden && reconceal && !restoreOwed) conceal();
      return;
    }
    // A keystroke the agent has not answered in this long is not waiting on the
    // network; it did nothing the line shows. Timing its eventual redraw would read
    // as a very slow echo, so it expires here as well as on the next keypress.
    const at = now();
    while (entries.length && at - entries[0].at > STALE_KEYSTROKE_MS) entries.shift();
    const buffer = terminal.buffer.active;
    // A full-screen view over the input box (the alternate screen) ends the chain;
    // its overlays belong to a row that is no longer shown.
    if (buffer.type !== 'normal') entries = [];
    const onRow = entries.length && buffer.type === 'normal' && buffer.baseY + buffer.cursorY === row
      && buffer.getLine(row);
    if (onRow) {
      base = buffer.cursorX;
      const current = inputBeforeCursor();
      // Acknowledge in order. Nothing of the predictor's is in the buffer, so the
      // line is the pane's alone, and its text says which state the agent has
      // reached; the question is only which keystroke produced it, since a burst can
      // repeat a state (`a`, `b`, Backspace expects `a`, `ab`, `a`). If the line still
      // shows the state from before the oldest pending keystroke, the agent may not
      // have answered anything, so nothing is confirmed, however many later
      // keystrokes also expect that text. Otherwise the oldest keystroke that expects
      // it is the one answered, with every keystroke before it: had the agent stopped
      // at an earlier one, the line would show that one's different text. That is
      // also how one render answering several keystrokes confirms them all.
      const unanswered = current === entries[0].before;
      const confirmed = unanswered ? -1 : entries.findIndex((entry) => entry.expected === current);
      if (confirmed >= 0) {
        for (const entry of entries.slice(0, confirmed + 1)) samples.push(at - entry.at);
        while (samples.length > SAMPLE_WINDOW) samples.shift();
        entries = entries.slice(confirmed + 1);
      } else if (!unanswered) {
        // Anything but the state before the oldest keystroke (a completion, a
        // submitted prompt) is not an echo and ends the chain.
        entries = [];
      }
    }
    // Every overlay left is laid out again from where the pane's cursor now is, and
    // a cursor the pane showed again is hidden while a guess still stands.
    render();
    if (hidden && reconceal) conceal();
  };

  const reset = () => {
    entries = [];
    clearOverlays();
    restore();
    restoreOwed = false;
    hidden = false;
    // Follows xterm's own reset, which shows the cursor; the pane's replay sets it
    // again as it needs.
    paneShows = true;
    reconceal = false;
    localWrite = false;
  };
  // A resize can reflow the prompt row and move the pane's cursor; the chain's
  // columns no longer hold, so it ends, and the pane's redraw is waited for.
  if (typeof terminal.onResize === 'function') {
    hooks.push(terminal.onResize(() => {
      entries = [];
      render();
    }));
  }
  const dispose = () => {
    reset();
    for (const hook of hooks.splice(0)) hook.dispose();
  };

  // Where the overlays go, whether or not this xterm can draw them (tests read it
  // without a DOM): the columns of the guessed characters, of the cells Backspace
  // guesses blank, and of the stand-in cursor (null when no guess is shown).
  const positions = () => {
    const { cells, cursor } = layout();
    const columns = (blank) => [...cells].filter(([, ch]) => (ch == null) === blank).map(([x]) => x).sort((a, b) => a - b);
    return { cells: columns(false), blanks: columns(true), cursor };
  };

  return {
    keystroke, outputParsed, reset, dispose, enabled, echoMs, positions,
    get pending() { return entries.length; },
    // Drawn overlays on guessed cells: characters and blanked cells.
    get marked() {
      let count = 0;
      for (const overlay of overlays.values()) if (overlay.decoration && (overlay.kind === 'char' || overlay.kind === 'blank')) count++;
      return count;
    },
  };
}
