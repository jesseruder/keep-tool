// Predictive local echo for an agent's input box.
//
// A pane on another node echoes a keystroke only after a network round trip and the
// agent's own render, which makes typing feel sticky. This module lets the console
// draw a typed character into its own xterm at once, dim and underlined, and leaves
// the agent's redraw to replace it. Both Claude Code and Codex rewrite the whole
// input line on every keystroke, so nothing has to be reconciled: an echo that
// never lands simply leaves the dim cell until the next redraw, which is the signal
// that the prediction was not confirmed. Nothing here changes what is sent.
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

// Claude Code's input line starts with `❯`, Codex's with `›`, each followed by a
// space (Claude pads the empty box with U+00A0). Each agent is matched only by its
// own marker: a shell prompt can use either glyph, and a shell echoes at the
// cursor a prediction has already advanced, which would double the character.
const PROMPTS = {
  claude: { line: /^(\s*)❯[ \u00a0]/, menu: /^\s*❯[ \u00a0]+\d+\.\s/ },
  codex: { line: /^(\s*)›[ \u00a0]/, menu: /^\s*›[ \u00a0]+\d+\.\s/ },
};
// A highlighted choice in the agent's selection menu also starts with the marker
// (`❯ 1. Yes`). Typing there picks an option rather than editing text.

// A guess is written in the agent's own stream without saving the cursor: xterm
// has one saved-cursor slot, and an agent that saved its cursor before our write
// would restore to the guess's position instead of its own. Saving would also have
// been the only way to put the agent's text attributes back, since xterm cannot
// report the active SGR state; instead the guess cancels the dim and underline it
// set. SGR 22 is normal intensity, so it also ends a bold the agent left active at
// the cursor; both agents' renderers reset styles at the end of every styled
// segment, so in practice nothing of theirs is active there to lose. Clearing to the end of the line
// removes a dim placeholder before the first character.
export const PREDICT_CHAR = (ch, clearPlaceholder = false) =>
  `${clearPlaceholder ? '\x1b[K' : ''}\x1b[2;4m${ch}\x1b[22;24m`;
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
  const prompts = Object.hasOwn(PROMPTS, agent) ? PROMPTS[agent] : null;
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

// A cell this module drew is dim and underlined at once, which neither agent uses
// for the text of its input box.
const predictedCell = (cell) => Boolean(cell && cell.isDim() && cell.isUnderline());

// One per mounted terminal. `agent` names the pane's agent (`claude`, `codex`, or
// anything else for a pane that is not predicted), `remote` says whether the pane
// is on another node, `mode` reads the viewer's setting, and `now` is a monotonic
// clock.
export function createTypingPredictor({ terminal, agent, remote, mode = getPredictTypingPreference, now = () => Date.now() }) {
  const samples = [];
  // Keystrokes whose echo has not landed, oldest first, each with the input text it
  // should leave before the cursor. That text is what matches an echo to the
  // keystroke it answers, even when the agent renders several keystrokes at once.
  // Auto records these while prediction is still off: that is how it measures.
  let entries = [];
  let row = -1;
  let inputStart = 0;
  // Columns drawn by predictions still in xterm's write queue.
  let unparsed = 0;
  let generation = 0;
  // The cursor's line and column when the agent's output last settled. Output that
  // leaves both as they were (a spinner elsewhere) is not an echo of anything.
  let lastSettled = '';

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
  const draw = (bytes, columns, done = () => {}) => {
    const current = generation;
    unparsed += columns;
    terminal.write(bytes, () => {
      if (current !== generation) return;
      unparsed -= columns;
      done();
    });
  };

  // Called with each keystroke before it is sent; returns whether a prediction was
  // drawn. The prediction joins the same write queue as the agent's output, so any
  // output that arrives after this keystroke parses after its prediction.
  const keystroke = (data, options = {}) => {
    const at = now();
    if (entries.length && at - entries[0].at > STALE_KEYSTROKE_MS) entries = [];
    const decision = predictKeystroke(terminal, data, { ...options, agent: agent(), extraColumns: unparsed });
    if (!decision) {
      // Enter, arrows, pastes and the like change the line in ways the expected
      // text cannot follow, so the keystrokes before them are no longer matched.
      entries = [];
      return false;
    }
    const buffer = terminal.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY;
    if (entries.length && (cursorRow !== row || decision.inputStart !== inputStart)) entries = [];
    row = cursorRow;
    inputStart = decision.inputStart;
    const before = entries.length ? entries.at(-1).expected : inputBeforeCursor();
    const expected = decision.kind === 'backspace' ? before.slice(0, -1) : before + data;
    const drawn = enabled();
    const entry = { at, ch: data, kind: decision.kind, before, expected, drawn, parsed: !drawn };
    entries.push(entry);
    if (drawn) draw(decision.bytes, decision.kind === 'backspace' ? -1 : 1, () => { entry.parsed = true; });
    return drawn;
  };

  // An agent that rewrites its whole input line erases the guesses for keystrokes
  // it has not processed yet. Draw them again, or a fast typist sees characters
  // vanish and come back. An agent that writes only the cells that changed leaves
  // them in place but puts its cursor back before them; step over them, or the
  // next guess would land on top of one. Only character guesses are redrawn: a
  // Backspace guess leaves no mark, so there is no telling whether it is still on
  // screen. A guess still in the write queue would land ahead of the redrawn ones,
  // so wait for it.
  const redrawWaiting = (line, cursorX) => {
    const waiting = entries.filter((entry) => entry.drawn);
    if (!waiting.length || waiting.some((entry) => entry.kind !== 'char' || !entry.parsed)) return;
    let marked = 0;
    while (cursorX + marked < terminal.cols && predictedCell(line.getCell(cursorX + marked))) marked++;
    if (marked) {
      if (marked === waiting.length) draw(`\x1b[${marked}C`, marked);
      return;
    }
    for (let x = cursorX; x < terminal.cols; x++) if (predictedCell(line.getCell(x))) return;
    if (cursorX + waiting.length > terminal.cols - 3) return;
    const first = predictKeystroke(terminal, waiting[0].ch, { agent: agent() });
    if (!first) return;
    const bytes = first.bytes + waiting.slice(1).map((entry) => PREDICT_CHAR(entry.ch)).join('');
    draw(bytes, waiting.length);
  };

  // Called after a chunk of the agent's output has parsed; `settled` is false while
  // more of its output is still queued behind it, since a render split across
  // chunks leaves the cursor wherever the chunk ended.
  const outputParsed = (settled = true) => {
    if (!settled) return;
    const buffer = terminal.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY;
    const cursorLine = buffer.getLine(cursorRow);
    const state = `${buffer.type}\n${cursorRow}\n${buffer.cursorX}\n${cursorLine?.translateToString(false) ?? ''}`;
    const changed = state !== lastSettled;
    lastSettled = state;
    // A keystroke the agent has not answered in this long is not waiting on the
    // network; it did nothing the line shows. Timing its eventual redraw would read
    // as a very slow echo, so it expires here as well as on the next keypress.
    const at = now();
    while (entries.length && at - entries[0].at > STALE_KEYSTROKE_MS) entries.shift();
    if (!entries.length) return;
    if (buffer.type !== 'normal' || cursorRow !== row) return;
    const line = cursorLine;
    if (!line) return;
    const cursorX = buffer.cursorX;
    // A guess still marked before the cursor means the agent has not redrawn this
    // far: the cursor is where the predictions left it.
    for (let x = inputStart; x < cursorX; x++) if (predictedCell(line.getCell(x))) return;
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
    const confirmed = !changed || unanswered ? -1 : entries.findIndex((entry) => entry.expected === current);
    if (confirmed < 0) {
      // Anything but an unchanged line or the state before the oldest keystroke (a
      // completion, a submitted prompt) is not an echo and ends the chain.
      if (changed && !unanswered) { entries = []; return; }
    } else {
      for (const entry of entries.slice(0, confirmed + 1)) samples.push(at - entry.at);
      while (samples.length > SAMPLE_WINDOW) samples.shift();
      entries = entries.slice(confirmed + 1);
    }
    redrawWaiting(line, cursorX);
  };

  const reset = () => {
    entries = [];
    unparsed = 0;
    lastSettled = '';
    generation++;
  };

  return { keystroke, outputParsed, reset, enabled, echoMs, get pending() { return entries.length; } };
}
