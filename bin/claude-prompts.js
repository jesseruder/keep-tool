'use strict';
// Claude Code's modal dialogs, read off a pane screen.
//
// Keep has to know when a session is parked on a modal instead of at its prompt: a
// restart's typed /exit can land on one, and a message typed at one goes nowhere. Each
// dialog used to get its own ad-hoc detector in serve.js, and each new dialog Claude Code
// shipped cost a failed transfer and a debugging session. This module recognizes the
// *shape* they all share — a heading, a numbered option list with exactly one highlighted
// row, and a footer — so an unknown dialog is still recognized as a dialog, and a new one
// is a fixture pair under bin/fixtures/claude-prompts/ plus (optionally) an entry here.
//
// The block rules below are the ones the worktree-exit detector learned the hard way:
// matching a *block* rather than the viewport, taking the lowest qualifying block, and
// calling a dialog live only when nothing but blank rows sits under its footer. Scrollback
// routinely retains old option lists and old copies of the same question; a viewport-wide
// reading both misses a real modal underneath them and accepts a heading and footer that
// belong to different screens — which, with no modal open, types a bare Enter into a live
// prompt.

// The window a block may occupy around its highlighted row.
const ABOVE = 12, BELOW = 20;

const OPTION = /^(?:❯\s*)?(\d+)\.\s*(.*)$/;
const HIGHLIGHTED = /^❯\s*\d+\./;
const FOOTER = /Enter to confirm|Esc to (?:cancel|exit)/i;

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// Known dialogs. `heading` anchors the block (it is what "the nearest heading above"
// means for a dialog we know); `options` must all match some option in the block, or the
// block is well formed but not this dialog and falls back to 'unknown'. `signals` is the
// looser text-only reading, for the one caller that needs to see a dialog whose footer
// has not rendered yet — see showsDialog.
const DIALOGS = [
  {
    kind: 'worktree-exit',
    heading: /Exiting worktree session/i,
    options: [/^Keep worktree\b/i, /^Remove worktree\b/i],
    signals: [/Exiting worktree session/i],
    // The only dialog Keep ever answers, and only on the option that destroys nothing.
    policy: { action: 'answer', key: '\r', label: 'worktree exit' },
  },
  {
    kind: 'folder-trust',
    heading: /Is this a project you created or one you trust|Do you trust the files in this folder/i,
    options: [/^Yes\b/i, /^No, exit\b/i],
    signals: [/Is this a project you created or one you trust/i, /Do you trust the files in this folder/i],
    policy: { action: 'refuse', label: 'folder trust' },
  },
  {
    kind: 'model-switch',
    heading: /Switch model\?/i,
    options: [/Yes, switch to/i],
    signals: [/Switch model\?/i, /Yes, switch to/i],
    policy: { action: 'refuse', label: 'model switch' },
  },
];

const KINDS = [...DIALOGS.map((dialog) => dialog.kind), 'unknown'];

// Anything else Claude Code puts up. Keep does not know what its options do, so it
// answers none of them — but naming it beats waiting out a timeout with no reason.
const UNKNOWN_POLICY = { action: 'refuse', label: 'unrecognized' };

function policyFor(kind) {
  const known = DIALOGS.find((dialog) => dialog.kind === kind);
  return { ...(known ? known.policy : UNKNOWN_POLICY) };
}

// What a refusal calls the dialog. An unrecognized one is only identifiable by its
// heading, so it carries one (truncated: a heading is a screen row, not a sentence).
function refusalLabel(match) {
  const kind = match && match.kind;
  const { label } = policyFor(kind);
  if (kind && kind !== 'unknown') return label;
  const heading = normalizedText(match && match.heading).slice(0, 80);
  return heading ? `${label} "${heading}"` : label;
}

// The heading of a dialog this module does not know: the topmost row of the paragraph
// directly above the option list, skipping blank rows and any sibling options above the
// highlighted one. A guess, and only ever used to name an unknown dialog in a refusal.
function unknownHeading(lines, index, top) {
  let i = index - 1;
  const skipBlanks = () => { while (i >= top && !lines[i]) i -= 1; };
  skipBlanks();
  while (i >= top && OPTION.test(lines[i])) { i -= 1; skipBlanks(); }
  if (i < top || !lines[i]) return -1;
  let heading = i;
  while (heading - 1 >= top && lines[heading - 1]) heading -= 1;
  return heading;
}

// The block around one highlighted option row, or null.
function blockAt(lines, index) {
  const top = Math.max(0, index - ABOVE);
  const bottom = Math.min(lines.length - 1, index + BELOW);

  // The block starts at its own heading. Rows above that are scrollback — a dialog that
  // has just been answered still sits there, and it is not part of this modal.
  let heading = -1, dialog = null;
  for (let i = index - 1; i >= top && heading === -1; i -= 1) {
    const known = DIALOGS.find((candidate) => candidate.heading.test(lines[i]));
    if (known) { heading = i; dialog = known; }
  }
  if (heading === -1) heading = unknownHeading(lines, index, top);
  if (heading === -1) return null;

  // Inside the block, another highlighted option means a different, larger menu.
  for (let i = heading + 1; i < index; i += 1) if (HIGHLIGHTED.test(lines[i])) return null;

  const offset = lines.slice(index + 1, bottom + 1).findIndex((line) => FOOTER.test(line));
  if (offset === -1) return null;
  const footer = index + 1 + offset;
  for (let i = index + 1; i <= footer; i += 1) if (HIGHLIGHTED.test(lines[i])) return null;

  // A narrow pane wraps an option's text onto rows of its own, so an option runs until
  // the next row that starts an option — anything before that is the wrap, not a sibling.
  const options = [];
  for (let i = heading + 1; i < footer; i += 1) {
    const option = lines[i].match(OPTION);
    if (option) {
      options.push({ number: Number(option[1]), text: option[2], highlighted: i === index });
    } else if (options.length && lines[i]) {
      const last = options[options.length - 1];
      last.text = normalizedText(`${last.text} ${lines[i]}`);
    }
  }
  if (!options.length) return null;

  const named = dialog && dialog.options.every((pattern) => options.some((option) => pattern.test(option.text)));
  return {
    kind: named ? dialog.kind : 'unknown',
    heading: lines[heading],
    options,
    highlighted: options.find((option) => option.highlighted)?.number ?? null,
    footer: lines[footer],
    footerRow: footer,
  };
}

// The dialog on this screen, or null. The lowest qualifying block wins, so a retained
// copy above a live one cannot hide it.
function recognize(screenText) {
  const lines = String(screenText || '').split(/\r?\n/).map(normalizedText);
  let found = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (!HIGHLIGHTED.test(lines[index])) continue;
    const block = blockAt(lines, index);
    if (block && (!found || block.footerRow >= found.footerRow)) found = block;
  }
  if (!found) return null;
  const { footerRow, ...match } = found;
  // A live modal owns the bottom of the screen: nothing but blank rows sits under its
  // footer. A retained copy sits above whatever is open now instead, and that can be
  // anything — a Claude input box, a Codex `›` prompt, a zsh prompt with a half-typed
  // command, a status line — none of which wants a keystroke. Enumerating what may not
  // appear there would miss one, so nothing may. A live modal that some rendering puts
  // text under simply goes unrecognized, which is the timeout this already had.
  return { ...match, live: lines.slice(footerRow + 1).every((line) => !line) };
}

// A looser reading: is this dialog's text on screen at all? recognize() is the reliable
// one and the only one that can tell a live dialog from a retained copy, but a caller
// watching a dialog it expects (and is about to answer itself) also has to see it in the
// half-rendered states — footer not drawn yet, or the heading scrolled above the slice of
// screen being searched. Never use this to decide whether to send a key blind.
function showsDialog(kind, screenText) {
  if (recognize(screenText)?.kind === kind) return true;
  const known = DIALOGS.find((dialog) => dialog.kind === kind);
  if (!known) return false;
  const lines = String(screenText || '').split(/\r?\n/).map(normalizedText);
  return known.signals.some((pattern) => lines.some((line) => pattern.test(line)));
}

module.exports = { KINDS, recognize, policyFor, refusalLabel, showsDialog, normalizedText };
