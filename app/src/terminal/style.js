'use strict';

// One style run of a parsed row turned into a React Native text style. The emulator
// hands back colours the way xterm stores them — a palette index, a truecolour
// string, or null for "whatever the terminal's default is" — and this is the only
// place that decides what those mean on screen.
//
// The palette is the same sixteen colours the spike screen drew with, which is the
// standard xterm palette the console's theme also starts from. Keeping it here means
// the spike, the native terminal and any later screen cannot drift apart.

const ANSI_16 = [
  '#000000', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec',
];

// xterm's 256-colour cube: 0-15 are the palette above, 16-231 a 6x6x6 RGB cube, and
// 232-255 a 24-step grey ramp.
function paletteColor(value) {
  const index = Number(value);
  if (!Number.isFinite(index) || index < 0) return null;
  if (index < 16) return ANSI_16[index];
  if (index < 232) {
    const offset = index - 16;
    const step = (n) => (n === 0 ? 0 : 55 + n * 40);
    const channel = (n) => step(n).toString(16).padStart(2, '0');
    return `#${channel(Math.floor(offset / 36) % 6)}${channel(Math.floor(offset / 6) % 6)}${channel(offset % 6)}`;
  }
  if (index < 256) {
    const grey = (8 + (index - 232) * 10).toString(16).padStart(2, '0');
    return `#${grey}${grey}${grey}`;
  }
  return null;
}

function colorFor(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  return paletteColor(value) ?? fallback;
}

// `theme` carries the two colours a run without an explicit one inherits: the pane's
// foreground and background. Inverse swaps them, which is also how the block cursor
// is drawn — the renderer inverts one cell's run rather than painting a separate box.
function runStyle(run, theme = {}) {
  const fg = theme.fg;
  const bg = theme.bg;
  const style = {
    color: run.inverse ? colorFor(run.bg, bg) : colorFor(run.fg, fg),
    fontStyle: run.italic ? 'italic' : 'normal',
    fontWeight: run.bold ? '700' : '400',
    textDecorationLine: run.underline ? 'underline' : 'none',
  };
  const background = run.inverse ? colorFor(run.fg, fg) : colorFor(run.bg, null);
  // A transparent background is left unset: RN paints every backgroundColor it is
  // given, and a row of explicit `bg` cells over the pane's own background is a
  // rectangle the renderer would otherwise redraw for every cell.
  if (background) style.backgroundColor = background;
  // Dim is an attribute, not an opacity, but RN has no colour arithmetic on a style
  // object and opacity on a nested Text composes the way the attribute does.
  if (run.dim) style.opacity = 0.62;
  return style;
}

module.exports = { ANSI_16, colorFor, paletteColor, runStyle };
