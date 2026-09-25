// Predictive local echo for an agent's input box.
//
// A pane on another node echoes a keystroke only after a network round trip and the
// agent's own render, which makes typing feel sticky. This module lets the console
// draw a typed character into its own xterm at once, under a dim, underlined
// overlay, and leaves the agent's redraw to replace it. Each echo is matched to the
// keystroke it answers, which confirms the guess and times the echo; a guess whose
// echo never lands keeps its overlay until it expires, which is the signal that it
// was not confirmed. Nothing here changes what is sent.
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

// The agents whose input box is predicted. Claude Code's renderer redraws the
// input line and ends it with an erase (EL) on every keystroke, so every echo is
// observable, through that erase or through the line and cursor it leaves: a guess
// never lingers unconfirmed, and "the cursor is where the guess left it, with no
// erase since" reliably means the pane has not echoed, which is what makes the
// cursor-position reply exact. Codex redraws only the cells that changed, so its
// echo of exactly what a guess already shows changes nothing on screen; it is not
// predicted until a print-level signal can tell that echo apart.
export const PREDICTED_AGENTS = ['claude'];

// Claude Code's input line starts with `❯` and a space (U+00A0 in the empty box).
// Only a pane whose agent is on record is matched: a shell prompt can use the same
// glyph, and a shell echoes at the cursor a prediction has already advanced, which
// would double the character.
const PROMPTS = {
  claude: { line: /^(\s*)❯[ \u00a0]/, menu: /^\s*❯[ \u00a0]+\d+\.\s/ },
};
// A highlighted choice in the agent's selection menu also starts with the marker
// (`❯ 1. Yes`). Typing there picks an option rather than editing text.

// A guess is written in the agent's own stream as plain text: no saved cursor
// (xterm has one slot, and an agent that saved its cursor would restore to the
// guess's position) and no attribute changes (xterm cannot report the active SGR,
// so any change could not be undone exactly, and the agent's attributes persist
// across its writes). The character takes whatever attributes are active, which
// the agent's redraw replaces anyway; an overlay marks it as unconfirmed. Clearing
// to the end of the line removes a dim placeholder before the first character.
export const PREDICT_CHAR = (ch, clearPlaceholder = false) => `${clearPlaceholder ? '\x1b[K' : ''}${ch}`;
// Move left, blank that cell with the current attributes, and move left again.
export const PREDICT_BACKSPACE = '\x1b[1D \x1b[1D';

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

// Decides whether one keystroke can be drawn ahead of the echo, and returns the
// bytes to draw, or null. `extraColumns` counts predictions written but not yet
// parsed, so the margin check sees where the cursor is about to be.
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
  // dim placeholder or suggestion, which the first prediction clears.
  let clear = false;
  for (let x = buffer.cursorX; x < terminal.cols; x++) {
    const cell = line.getCell(x);
    if (blankCell(cell)) continue;
    if (cell.isDim() || (x === buffer.cursorX && cell.isInverse())) { clear = true; continue; }
    return null;
  }
  if (kind === 'backspace') return { kind, inputStart, bytes: PREDICT_BACKSPACE };
  return { kind, inputStart, bytes: PREDICT_CHAR(data, clear) };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// The class the console's stylesheet gives the overlay on a guessed cell.
export const PREDICTED_CELL_CLASS = 'keep-predicted-cell';

// One per mounted terminal. `agent` names the pane's agent (only those in
// PREDICTED_AGENTS are predicted or measured), `remote` says whether the pane
// is on another node, `mode` reads the viewer's setting, `now` is a monotonic
// clock, and `reply` sends a terminal reply to the pane the way xterm's own
// replies are sent.
export function createTypingPredictor({
  terminal, agent, remote, mode = getPredictTypingPreference, now = () => Date.now(), reply = null,
}) {
  const samples = [];
  // Keystrokes whose echo has not landed, oldest first, each with the input text it
  // should leave before the cursor. That text is what matches an echo to the
  // keystroke it answers, even when the agent renders several keystrokes at once.
  // Auto records these while prediction is still off: that is how it measures. A
  // drawn character guess also keeps its column and the overlay that marks it.
  let entries = [];
  let row = -1;
  let inputStart = 0;
  // Columns drawn by predictions still in xterm's write queue.
  let unparsed = 0;
  let generation = 0;
  // The cursor's line (every cell, an erased one told apart from a written space)
  // and column as of the last settled output or the last guess. Output that leaves
  // them as they were (a spinner elsewhere) is not an echo of anything, and a
  // guess's own change to the line is never mistaken for one.
  let lastSettled = '';
  // Whether the agent's own output erased or shifted cells on the prompt row since
  // the last settle. A whole-line redraw that ends exactly where the guesses did
  // leaves the line as they left it, so the line alone cannot show it; the erase
  // the renderer uses (Claude Code ends each redrawn line with EL) can. Cursor
  // movement never counts: a spinner that draws elsewhere and moves the cursor
  // back onto the prompt row has answered nothing. Our own writes are excluded.
  let touched = false;
  let localWrite = false;
  const touch = (reach) => () => {
    if (localWrite || !entries.length) return false;
    const buffer = terminal.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY;
    // Erasing in line and inserting or deleting characters act on the cursor's row;
    // inserting or deleting lines shifts it and every row below; erasing in display
    // may reach any row.
    if (reach === 'screen' || cursorRow === row || (reach === 'below' && cursorRow < row)) {
      touched = true;
      // The pane is redrawing the row, so wherever the cursor goes next is its own.
      localCursor = null;
    }
    // Never handled here: xterm still performs the sequence.
    return false;
  };
  const hooks = [];
  // How far the guesses have moved the cursor since the pane's own output last put
  // it somewhere, and where they left it. A guess moves xterm's real cursor before
  // the pane has echoed anything, so a cursor-position report built from it would
  // name a column the pane never produced.
  let advance = 0;
  let localCursor = null;
  const cursorKey = () => {
    const buffer = terminal.buffer.active;
    return `${buffer.type}:${buffer.baseY + buffer.cursorY}:${buffer.cursorX}`;
  };
  // While guesses stand and nothing of the pane's has moved the cursor since, the
  // pane has not echoed them: a predicted agent's echo always erases on the prompt
  // row (see PREDICTED_AGENTS), which clears `localCursor`. So the report names the
  // column the pane's own output left, formatted exactly as
  // xterm formats it (1-based row and column, no page for the private form), and
  // is sent through the same path as xterm's replies. Any other query, or no
  // standing guess, is left to xterm. A guess never changes the row.
  const reportPosition = (prefix) => (params) => {
    if (params.length !== 1 || params[0] !== 6 || typeof reply !== 'function') return false;
    if (localWrite || !advance || !entries.some((entry) => entry.drawn) || cursorKey() !== localCursor) return false;
    const buffer = terminal.buffer.active;
    reply(`\x1b[${prefix}${buffer.cursorY + 1};${Math.max(0, buffer.cursorX - advance) + 1}R`);
    return true;
  };
  if (typeof terminal.parser?.registerCsiHandler === 'function') {
    hooks.push(terminal.parser.registerCsiHandler({ final: 'n' }, reportPosition('')));
    hooks.push(terminal.parser.registerCsiHandler({ prefix: '?', final: 'n' }, reportPosition('?')));
  }
  if (typeof terminal.parser?.registerCsiHandler === 'function') {
    const finals = { K: 'row', X: 'row', '@': 'row', P: 'row', L: 'below', M: 'below', J: 'screen' };
    for (const [final, reach] of Object.entries(finals)) {
      hooks.push(terminal.parser.registerCsiHandler({ final }, touch(reach)));
    }
  }

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
  const snapshot = () => {
    const buffer = terminal.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY;
    const line = buffer.getLine(cursorRow);
    let cells = '';
    for (let x = 0; line && x < terminal.cols; x++) cells += line.getCell(x)?.getChars() || '\0';
    return `${buffer.type}\n${cursorRow}\n${buffer.cursorX}\n${cells}`;
  };

  // The unconfirmed look is an overlay, never an attribute: the guess is written
  // plain so the agent's text attributes, which persist across its writes, are
  // exactly as it left them. The bundled xterm draws decorations; a build without
  // them (the headless one in tests) simply shows the guess unmarked.
  const mark = (entry, x) => {
    entry.x = x;
    if (typeof terminal.registerDecoration !== 'function' || typeof terminal.registerMarker !== 'function') return;
    const marker = terminal.registerMarker(0);
    if (!marker) return;
    const decoration = terminal.registerDecoration({ marker, x, width: 1, layer: 'top' });
    if (!decoration) { marker.dispose(); return; }
    decoration.onRender((element) => element.classList.add(PREDICTED_CELL_CLASS));
    entry.marker = marker;
    entry.decoration = decoration;
  };
  const unmark = (entry) => {
    entry.decoration?.dispose();
    entry.marker?.dispose();
    entry.decoration = null;
    entry.marker = null;
  };
  const drop = (dropped) => {
    for (const entry of dropped) unmark(entry);
  };
  const clearEntries = () => {
    drop(entries);
    entries = [];
  };

  const draw = (bytes, columns, done = () => {}) => {
    const current = generation;
    // Re-baseline only if nothing of the agent's changed the line since the last
    // settle; an unsettled change of its own must still count when output settles.
    let before = null;
    terminal.write('', () => {
      before = snapshot();
      // With no settle seen yet (a fresh or reset terminal), the screen as it stands
      // before the first guess is the baseline.
      if (!lastSettled) lastSettled = before;
      // The pane's output moved the cursor since the last guess: it is the pane's
      // position now, and the advance counts from here.
      if (cursorKey() !== localCursor) advance = 0;
      localWrite = true;
    });
    unparsed += columns;
    terminal.write(bytes, () => {
      localWrite = false;
      if (current !== generation) return;
      unparsed -= columns;
      advance += columns;
      localCursor = cursorKey();
      done();
      if (before === lastSettled) lastSettled = snapshot();
    });
  };

  // Called with each keystroke before it is sent; returns whether a prediction was
  // drawn. The prediction joins the same write queue as the agent's output, so any
  // output that arrives after this keystroke parses after its prediction.
  const keystroke = (data, options = {}) => {
    const at = now();
    if (entries.length && at - entries[0].at > STALE_KEYSTROKE_MS) clearEntries();
    const decision = predictKeystroke(terminal, data, { ...options, agent: agent(), extraColumns: unparsed });
    if (!decision) {
      // Enter, arrows, pastes and the like change the line in ways the expected
      // text cannot follow, so the keystrokes before them are no longer matched.
      clearEntries();
      return false;
    }
    const buffer = terminal.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY;
    if (entries.length && (cursorRow !== row || decision.inputStart !== inputStart)) clearEntries();
    row = cursorRow;
    inputStart = decision.inputStart;
    const before = entries.length ? entries.at(-1).expected : inputBeforeCursor();
    const expected = decision.kind === 'backspace' ? before.slice(0, -1) : before + data;
    const drawn = enabled();
    const entry = { at, ch: data, kind: decision.kind, before, expected, drawn, parsed: !drawn, x: -1, marker: null, decoration: null };
    entries.push(entry);
    if (!drawn) return false;
    draw(decision.bytes, decision.kind === 'backspace' ? -1 : 1, () => {
      entry.parsed = true;
      const x = terminal.buffer.active.cursorX;
      // A Backspace guess blanks the cell it moved onto; a guessed character there
      // loses its overlay with it.
      if (decision.kind === 'backspace') drop(entries.filter((other) => other.decoration && other.x === x));
      else mark(entry, x - 1);
    });
    return true;
  };

  // An agent that rewrites its whole input line erases the guesses for keystrokes
  // it has not processed yet. Draw them again, or a fast typist sees characters
  // vanish and come back. Output that leaves them in place but puts the cursor
  // back before them (a redraw of only the cells that changed) is stepped over,
  // or the next guess would land on top of one. Only character guesses are redrawn: a
  // Backspace guess leaves nothing to find, so there is no telling whether it is
  // still on screen. A guess still in the write queue would land ahead of the
  // redrawn ones, so wait for it.
  const redrawWaiting = (line, cursorX) => {
    const waiting = entries.filter((entry) => entry.drawn);
    if (!waiting.length || waiting.some((entry) => entry.kind !== 'char' || !entry.parsed)) return;
    if (cursorX + waiting.length > terminal.cols - 3) return;
    if (waiting.every((entry, i) => entry.x === cursorX + i && line.getCell(cursorX + i)?.getChars() === entry.ch)) {
      draw(`\x1b[${waiting.length}C`, waiting.length);
      return;
    }
    drop(waiting);
    const first = predictKeystroke(terminal, waiting[0].ch, { agent: agent() });
    if (!first) return;
    const bytes = first.bytes + waiting.slice(1).map((entry) => PREDICT_CHAR(entry.ch)).join('');
    draw(bytes, waiting.length, () => {
      const end = terminal.buffer.active.cursorX;
      waiting.forEach((entry, i) => mark(entry, end - waiting.length + i));
    });
  };

  // Called after a chunk of the agent's output has parsed; `settled` is false while
  // more of its output is still queued behind it, since a render split across
  // chunks leaves the cursor wherever the chunk ended.
  const outputParsed = (settled = true) => {
    if (!settled) return;
    const state = snapshot();
    const changed = touched || state !== lastSettled;
    lastSettled = state;
    touched = false;
    // A keystroke the agent has not answered in this long is not waiting on the
    // network; it did nothing the line shows. Timing its eventual redraw would read
    // as a very slow echo, so it expires here as well as on the next keypress.
    const at = now();
    while (entries.length && at - entries[0].at > STALE_KEYSTROKE_MS) unmark(entries.shift());
    if (!entries.length || !changed) return;
    const buffer = terminal.buffer.active;
    if (buffer.type !== 'normal' || buffer.baseY + buffer.cursorY !== row) return;
    const line = buffer.getLine(row);
    if (!line) return;
    const current = inputBeforeCursor();
    // Acknowledge in order. The text on the line says which state the agent has
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
    if (confirmed < 0) {
      // Anything but the state before the oldest keystroke (a completion, a
      // submitted prompt) is not an echo and ends the chain.
      if (!unanswered) { clearEntries(); return; }
    } else {
      const answered = entries.slice(0, confirmed + 1);
      for (const entry of answered) samples.push(at - entry.at);
      while (samples.length > SAMPLE_WINDOW) samples.shift();
      drop(answered);
      entries = entries.slice(confirmed + 1);
    }
    redrawWaiting(line, buffer.cursorX);
  };

  const reset = () => {
    clearEntries();
    unparsed = 0;
    lastSettled = '';
    touched = false;
    localWrite = false;
    advance = 0;
    localCursor = null;
    generation++;
  };
  const dispose = () => {
    reset();
    for (const hook of hooks.splice(0)) hook.dispose();
  };

  return {
    keystroke, outputParsed, reset, dispose, enabled, echoMs,
    get pending() { return entries.length; },
    get marked() { return entries.filter((entry) => entry.decoration).length; },
  };
}
