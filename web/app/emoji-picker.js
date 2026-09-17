// A small emoji picker for the Mark row in the Actions menu, so setting a
// session's emoji never depends on the OS emoji keyboard. It offers only what
// emoji-list.js holds — every one of them a single RGI emoji, the shape the daemon
// validates a mark against — so nothing the picker hands over can be refused.
//
// The picker lives inside the Actions menu, which re-renders every few seconds and
// closes on a pointerdown outside itself. Two consequences run through the whole
// file:
//
//   * Handlers are assigned (`onclick`, `oninput`, `onkeydown`), never added, so
//     re-installing on every render leaves exactly one of each — the same rule
//     installMarkControls follows.
//   * The grid is filled when the panel opens rather than written into the markup,
//     so the menu's HTML string stays short and patchActionsMenu has almost nothing
//     to diff. An open panel is open by attribute and property only, so the HTML is
//     unchanged across a refresh and patchHTML leaves the DOM — and the open panel —
//     alone.
import { EMOJI } from './emoji-list.js';

const RECENT_KEY = 'keep.console.recentEmoji';
const RECENT_MAX = 8;

const escapeHTML = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Storage is always someone else's to break: a private window, blocked site data,
// a value another tab wrote. Every read and write is wrapped, and a failure is an
// empty list rather than a broken picker.
function storageOf(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

// The last few emoji picked here, newest first.
export function recentEmoji(storage) {
  try {
    const parsed = JSON.parse(storageOf(storage)?.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const recent = [];
    for (const entry of parsed) {
      // Only what the picker itself offers: a stored value from another build
      // or a hand-edited one must not become a selectable, refusable pick.
      if (typeof entry !== 'string' || !labels.has(entry) || recent.includes(entry)) continue;
      recent.push(entry);
    }
    return recent.slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

// Moves `emoji` to the front, keeping the list deduplicated and capped. Returns
// the list as it now stands, whether or not the write landed.
export function rememberEmoji(emoji, storage) {
  if (!emoji) return recentEmoji(storage);
  const next = [emoji, ...recentEmoji(storage).filter((entry) => entry !== emoji)].slice(0, RECENT_MAX);
  try { storageOf(storage)?.setItem(RECENT_KEY, JSON.stringify(next)); } catch {}
  return next;
}

const labels = new Map(EMOJI);

function cellHTML(emoji, label) {
  const title = label || emoji;
  return `<button type="button" class="emoji-cell" data-emoji="${escapeHTML(emoji)}" title="${escapeHTML(title)}">${escapeHTML(emoji)}</button>`;
}

// Entries whose search words or emoji contain the query; everything when it is
// empty. Exported shape is deliberately the EMOJI entry, so the caller can read
// both halves.
function matching(query) {
  const term = String(query ?? '').trim().toLowerCase();
  if (!term) return EMOJI;
  return EMOJI.filter(([emoji, words]) => words.includes(term) || emoji.includes(term));
}

// The markup for a closed picker: the toggle, and a panel whose grid is empty
// until it is opened.
export function pickerHTML(esc = escapeHTML) {
  return `<button type="button" class="btn emoji-pick" data-emoji-pick title="${esc('Pick an emoji')}" aria-expanded="false">😀</button>`
    + `<div class="emoji-picker" data-emoji-picker hidden>`
    + `<input class="emoji-search" data-emoji-search placeholder="${esc('search')}" aria-label="${esc('Search emoji')}">`
    + `<div class="emoji-recent" data-emoji-recent></div>`
    + `<div class="emoji-grid" data-emoji-grid role="group" aria-label="${esc('Emoji')}"></div></div>`;
}

// `host` is the element holding the toggle, the panel and the mark's own emoji
// input — the `.mark-controls` div. `onPick(emoji)` is what actually sets the
// mark; the picker itself only decides which emoji that is.
export function installEmojiPicker(host, options = {}) {
  if (!host) return;
  const onPick = typeof options.onPick === 'function' ? options.onPick : null;
  const storage = options.storage;
  const toggle = host.querySelector('[data-emoji-pick]');
  const panel = host.querySelector('[data-emoji-picker]');
  const search = host.querySelector('[data-emoji-search]');
  const grid = host.querySelector('[data-emoji-grid]');
  const recentBox = host.querySelector('[data-emoji-recent]');
  if (!toggle || !panel || !search || !grid) return;

  const wireCells = (root) => {
    for (const cell of root.querySelectorAll('[data-emoji]') || []) {
      const emoji = cell.dataset?.emoji ?? cell.getAttribute?.('data-emoji');
      cell.onclick = () => choose(emoji);
    }
  };

  const renderGrid = (query) => {
    grid.innerHTML = matching(query).map(([emoji, words]) => cellHTML(emoji, words)).join('');
    wireCells(grid);
  };

  const renderRecents = () => {
    if (!recentBox) return;
    const recent = recentEmoji(storage);
    recentBox.innerHTML = recent.map((emoji) => cellHTML(emoji, labels.get(emoji) || emoji)).join('');
    recentBox.hidden = recent.length === 0;
    wireCells(recentBox);
  };

  const close = (toToggle) => {
    panel.hidden = true;
    toggle.setAttribute?.('aria-expanded', 'false');
    if (toToggle) toggle.focus?.({ preventScroll: true });
  };

  const open = () => {
    panel.hidden = false;
    toggle.setAttribute?.('aria-expanded', 'true');
    search.value = '';
    renderRecents();
    renderGrid('');
    search.focus?.({ preventScroll: true });
  };

  function choose(emoji) {
    if (!emoji) return;
    rememberEmoji(emoji, storage);
    renderRecents();
    // Closing first means the write onPick starts — and the reload behind it —
    // finds the panel already shut, whatever it does to the menu's markup.
    close(false);
    onPick?.(emoji);
  }

  toggle.onclick = () => (panel.hidden === false ? close(true) : open());

  // Every keydown inside the panel stops here. Two different listeners would
  // otherwise take it: app.js's global shortcuts, which only skip inputs and so
  // would fire plain single keys while a cell button has focus, and the Actions
  // menu's own Escape, which closes the whole menu. Escape is the deliberate
  // case — it belongs to the panel while the panel is open, so it shuts the
  // picker and hands focus back to the toggle. A second Escape, with the panel
  // now closed and this handler out of the path, reaches the menu and closes it.
  const onKeyDown = (event) => {
    event?.stopPropagation?.();
    const key = event?.key;
    if (key === 'Escape') {
      event.preventDefault?.();
      close(true);
      return;
    }
    if (key !== 'Enter') return;
    const target = event?.target;
    const picked = target?.dataset?.emoji ?? target?.getAttribute?.('data-emoji');
    if (picked) {
      // Handled here rather than left to the button's native activation, so
      // Enter on a cell picks exactly once.
      event.preventDefault?.();
      choose(picked);
      return;
    }
    if (target !== search) return;
    const matches = matching(search.value);
    event.preventDefault?.();
    if (matches.length === 1) choose(matches[0][0]);
  };

  search.oninput = () => renderGrid(search.value);
  search.onkeydown = onKeyDown;
  panel.onkeydown = onKeyDown;
  // Cells already on screen (a panel left open across a re-render) take this
  // install's choose, so a menu rebound to another session writes to that one.
  wireCells(grid);
  if (recentBox) wireCells(recentBox);
}
