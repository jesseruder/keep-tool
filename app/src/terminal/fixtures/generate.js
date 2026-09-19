'use strict';

// Builds the terminal spike's fixture. Run it from anywhere with:
//
//   node app/src/terminal/fixtures/generate.js
//
// The frames are written out by hand rather than captured from a live pane: a real
// capture carries whoever was working at the time — their paths, session ids and the
// transcript on screen — into a committed file, and none of that is what the emulator
// is being tested on. What follows is a deterministic sequence chosen to hit the parts
// of the parser the phone renderer depends on, so the fixture is both safe to commit
// and a better description of the contract than a screenshot of somebody's afternoon.
//
// The expected final screen is baked in here, by the same @xterm/addon-serialize that
// bin/host.js uses for its replay, so the device half of the spike needs only the
// parser and not the serializer.

const fs = require('node:fs');
const path = require('node:path');

const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const PANE = 'pane-synthetic';
const COLS = 120;
const ROWS = 40;
const SCROLLBACK = 1000;
const OUT = path.join(__dirname, `${PANE}.json`);

const ESC = '\x1b';
const CSI = `${ESC}[`;
const SGR = (...codes) => `${CSI}${codes.join(';')}m`;
const RESET = SGR(0);
const at = (row, col) => `${CSI}${row};${col}H`;

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// The frames as the relay would deliver them: JSON control frames, terminal output as
// binary (the daemon's usual shape), and one text frame, because the client has to
// treat a text frame as output rather than as a protocol message.
const frames = [];
const json = (value) => frames.push({ kind: 'json', data: JSON.stringify(value) });
const text = (value) => frames.push({ kind: 'text', data: value });
const out = (value) => frames.push({ kind: 'binary', data: Buffer.from(value, 'utf8').toString('base64') });

const paneState = (extra = {}) => ({
  id: PANE, cols: COLS, rows: ROWS, alive: true, alt: false, title: 'synthetic pane',
  attached: 1, visibleAttached: 1, primary: null, ...extra,
});

json({ t: 'attached', pane: paneState(), history: { lines: 0, sent: 0, truncated: false } });

// --- the replay: one serialized screen, exactly as the host sends it on attach ---
let replay = `${CSI}2J${at(1, 1)}${RESET}`;
replay += `${SGR(1, 38, 5, 213)}Keep terminal spike${RESET}${SGR(2)} — synthetic fixture${RESET}\r\n`;
replay += `${SGR(38, 2, 90, 200, 120)}truecolor foreground${RESET} `;
replay += `${SGR(48, 2, 20, 40, 80)}${SGR(38, 2, 240, 240, 240)} truecolor background ${RESET}\r\n`;
// Every attribute the row runs carry, one per cell group, so a renderer that drops one
// fails the row comparison rather than quietly looking a little wrong.
replay += `${SGR(1)}bold${RESET} ${SGR(2)}dim${RESET} ${SGR(3)}italic${RESET} `;
replay += `${SGR(4)}underline${RESET} ${SGR(7)}inverse${RESET} ${SGR(1, 4, 31)}all three${RESET}\r\n`;
// The 16 ANSI colors as foreground, then as background: palette indices, not RGB.
replay += 'palette fg: ';
for (let i = 0; i < 8; i++) replay += `${SGR(30 + i)}${i}${RESET}`;
for (let i = 0; i < 8; i++) replay += `${SGR(90 + i)}${i + 8}${RESET}`;
replay += '  bg: ';
for (let i = 0; i < 8; i++) replay += `${SGR(40 + i)} ${RESET}`;
replay += '\r\n';
// The 256-color cube and the greyscale ramp at its two ends.
replay += '256: ';
for (const index of [16, 34, 82, 129, 196, 226, 232, 244, 255]) {
  replay += `${SGR(38, 5, index)}${String(index).padStart(3, ' ')}${RESET} `;
}
replay += '\r\n';
replay += `${SGR(38, 5, 244)}${'─'.repeat(60)}${RESET}\r\n`;
// Wide characters and an emoji: two cells, one character, which is the case that
// separates a cell walk from a string slice.
replay += `wide: 日本語テキスト  emoji: ✳ 🚀 ⏺  combining: é\r\n`;
replay += `${SGR(36)}box${RESET} ┌────────────┐\r\n`;
replay += `    ${SGR(36)}│${RESET} nested cell ${SGR(36)}│${RESET}\r\n`;
replay += `    ${SGR(36)}└────────────┘${RESET}\r\n`;
// A line longer than the screen, so the parser has to wrap it.
replay += `wrap: ${'0123456789'.repeat(14)}\r\n`;
replay += `${SGR(48, 5, 236)}${' '.repeat(40)}painted background with explicit spaces${' '.repeat(10)}${RESET}\r\n`;
out(replay);
json({ t: 'replay-end' });

// --- live output: what arrives after the replay, frame by frame ---

// A scroll region, filled past its bottom so the region scrolls but the rest holds.
out(`${CSI}18;24r${at(18, 1)}`);
for (let i = 1; i <= 10; i++) {
  out(`${at(24, 1)}${CSI}2K${SGR(33)}region line ${i}${RESET}\r\n`);
}
out(`${CSI}r`); // release the scroll region

// Cursor addressing plus erase-in-line: the redraw pattern every agent CLI uses.
out(`${at(26, 1)}${CSI}2Kstatus: ${SGR(32)}connected${RESET}`);
out(`${at(26, 1)}${CSI}2Kstatus: ${SGR(31)}reconnecting${RESET}`);
out(`${at(26, 1)}${CSI}2Kstatus: ${SGR(32)}live${RESET}  ${SGR(2)}(rewritten three times)${RESET}`);

// A spinner redrawing one row many times: the single most common thing on these panes,
// and the reason dirty-row tracking has to narrow to one row rather than the screen.
for (let tick = 0; tick < 40; tick++) {
  out(`${at(28, 1)}${CSI}2K${SGR(35)}${SPINNER[tick % SPINNER.length]}${RESET} working… ${tick + 1}/40`);
}
out(`${at(28, 1)}${CSI}2K${SGR(32)}✔${RESET} done`);

// The alternate screen, entered and left. What it draws must not survive the exit.
out(`${CSI}?1049h${CSI}2J${at(1, 1)}${SGR(7)} ALTERNATE SCREEN ${RESET}`);
out(`${at(3, 3)}this text belongs to the alt buffer and must not appear at the end`);
out(`${at(5, 3)}${SGR(4)}menu item${RESET}`);
// A hidden cursor inside the alt buffer, shown again before leaving, so DECTCEM is
// exercised without leaving the final screen in a state the renderer cannot describe.
out(`${CSI}?25l`);
out(`${CSI}?25h${CSI}?1049l`);

// Erase-in-display below the cursor, then the closing frame.
out(`${at(30, 1)}${CSI}0J${SGR(38, 5, 244)}${'─'.repeat(60)}${RESET}`);
text(`${at(31, 1)}a text frame, not a protocol message: {"t":"not-a-frame"}`);
out(`${at(32, 1)}${SGR(1, 38, 2, 255, 180, 0)}final row${RESET} ${SGR(2)}cursor parks here →${RESET} `);

json({ t: 'pane', pane: paneState({ title: 'synthetic pane · done' }) });

// --- bake the expected screen -------------------------------------------------

function visibleRows(term) {
  const buffer = term.buffer.active;
  const rows = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    rows.push(line ? line.translateToString(true) : '');
  }
  return rows;
}

function payload(frame) {
  if (frame.kind === 'json') return null;
  return frame.kind === 'binary' ? new Uint8Array(Buffer.from(frame.data, 'base64')) : frame.data;
}

(async () => {
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  for (const frame of frames) {
    const data = payload(frame);
    if (data !== null) await new Promise((resolve) => term.write(data, resolve));
  }

  const expected = visibleRows(term);

  // A fresh terminal replaying host.js's serialization has to land on the same screen.
  // If it does not, the fixture is describing something the desktop could not replay
  // either, and baking it would hide that rather than catch it.
  const replayTerm = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK, allowProposedApi: true });
  await new Promise((resolve) => replayTerm.write(
    serializer.serialize({ scrollback: SCROLLBACK, excludeAltBuffer: false }), resolve,
  ));
  const roundTrip = visibleRows(replayTerm);
  const mismatched = expected.map((row, y) => (row === roundTrip[y] ? null : y)).filter((y) => y !== null);
  if (mismatched.length) {
    for (const y of mismatched.slice(0, 5)) {
      process.stderr.write(`row ${y}\n  direct    ${JSON.stringify(expected[y])}\n  roundtrip ${JSON.stringify(roundTrip[y])}\n`);
    }
    throw new Error(`the serializer round-trip disagrees on ${mismatched.length} rows`);
  }

  const buffer = term.buffer.active;
  const fixture = {
    pane: PANE,
    generatedBy: 'app/src/terminal/fixtures/generate.js',
    note: 'Synthetic by design: no capture of a real session belongs in the repository.',
    cols: COLS,
    rows: ROWS,
    frames,
    expected: {
      rows: expected,
      alternate: buffer.type === 'alternate',
      cursor: {
        x: buffer.cursorX,
        y: buffer.baseY + buffer.cursorY - buffer.viewportY,
        visible: !term._core.coreService.isCursorHidden,
      },
      scrollback: SCROLLBACK,
      source: '@xterm/addon-serialize round-trip verified',
    },
  };

  const json = `${JSON.stringify(fixture)}\n`;
  fs.writeFileSync(OUT, json);
  const counts = frames.reduce((totals, frame) => ({ ...totals, [frame.kind]: (totals[frame.kind] || 0) + 1 }), {});
  const bytes = frames.reduce((total, frame) => total + (payload(frame)?.length || 0), 0);
  process.stdout.write(
    `${OUT}\n  ${frames.length} frames ${JSON.stringify(counts)}, ${bytes} bytes of output, `
    + `${json.length} bytes on disk, ${COLS}x${ROWS}, round-trip clean\n`,
  );
})();
