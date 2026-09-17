// Marking a session by hand: a color dot, an emoji, or both. The daemon stores
// the mark on the session row (`session.mark`) and the console only writes it and
// lets the next state reload show it — the same shape as the hand-typed name in
// session-rename.js. Marks are never assigned automatically: every one of them is
// something Owner typed or clicked.
//
// The mark rides along with the number badge, so it shows up wherever a session's
// title does: the stage heading, a Watch pane, the triage queue and the fleet.

// The fixed order the backend validates against; the swatch row follows it.
export const PALETTE = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'];

const escapeHTML = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colorOf(mark) {
  const color = mark?.color;
  return PALETTE.includes(color) ? color : '';
}

function emojiOf(mark) {
  const emoji = mark?.emoji;
  return emoji ? String(emoji) : '';
}

// Sits immediately before the title text. An unmarked session renders nothing at
// all, so every title that has no mark keeps exactly the markup it had.
export function markHTML(esc = escapeHTML, mark) {
  const emoji = emojiOf(mark);
  const color = colorOf(mark);
  if (!emoji && !color) return '';
  const dot = color ? `<i class="mark-dot mark-${color}" title="${esc(color)}"></i>` : '';
  return `<span class="mark">${esc(emoji)}${dot}</span>`;
}

// The Actions-menu block: eight swatches, a small emoji field, and a Clear that
// only appears once there is something to clear.
export function markControlsHTML(esc = escapeHTML, sessionId, mark) {
  if (!sessionId) return '';
  const color = colorOf(mark);
  const emoji = emojiOf(mark);
  const swatches = PALETTE.map((name) => `<button type="button" class="mark-swatch mark-${name}" data-mark-color="${name}" title="${name}" aria-pressed="${name === color}"></button>`).join('');
  const clear = color || emoji ? '<button type="button" class="btn" data-mark-clear>Clear mark</button>' : '';
  return `<div class="mark-controls" data-mark-controls><div class="session-actions-label">Mark</div><div class="mark-swatches" role="group" aria-label="Mark color">${swatches}</div><input class="mark-emoji" data-mark-emoji name="emoji" maxlength="16" placeholder="emoji" value="${esc(emoji)}" aria-label="Session emoji">${clear}</div>`;
}

// Per session, across re-installs: what the daemon last confirmed, the writes
// still on their way to it, and the queue that sends them one at a time. All of
// it outlives one render, because a reload re-renders the menu while an earlier
// write may still be in flight.
const sessions = new Map();

function applyPatch(base, patch) {
  const next = { ...base };
  for (const field of ['color', 'emoji']) if (patch[field] !== undefined) next[field] = patch[field] || '';
  return next;
}

function sessionState(sessionId, mark) {
  let state = sessions.get(sessionId);
  if (!state) {
    state = { chain: Promise.resolve(), confirmed: { color: '', emoji: '' }, queued: [] };
    sessions.set(sessionId, state);
  }
  // With nothing in flight the daemon's answer is the truth. While writes are
  // pending the confirmed base stays what it was, and the belief is that base
  // with the pending writes laid over it, so the blur after an Enter does not
  // write the same emoji twice and a write that fails simply drops out of the
  // picture, whatever was written before or after it.
  if (!state.queued.length) state.confirmed = { color: colorOf(mark), emoji: emojiOf(mark) };
  return state;
}

// The mark the console believes the session has right now.
function belief(state) {
  return state.queued.reduce(applyPatch, state.confirmed);
}

// `setMark(sessionId, patch)` is the api call. Handlers are assigned rather than
// added so that re-installing on every patchActionsMenu render — which happens
// every few seconds — leaves exactly one of each.
export function installMarkControls(menu, ctx = {}, sessionId, mark, setMark) {
  if (!menu || !sessionId || typeof setMark !== 'function') return;
  const state = sessionState(sessionId, mark);
  // Writes go out one after another, in the order Owner made them: a blur commit
  // of the emoji field followed by a click on Clear must end cleared, whichever
  // request the daemon would otherwise have handled first.
  const write = (patch, close) => {
    if (close) menu.removeAttribute?.('open');
    const entry = { ...patch };
    state.queued.push(entry);
    const drop = () => { state.queued = state.queued.filter((queued) => queued !== entry); };
    state.chain = state.chain
      .then(() => setMark(sessionId, entry))
      .then(() => {
        state.confirmed = applyPatch(state.confirmed, entry);
        drop();
        return ctx.reload?.();
      }, (error) => {
        drop();
        ctx.toast?.(`Not marked: ${error && error.message ? error.message : String(error)}`);
      })
      .catch(() => {});
    return state.chain;
  };

  for (const button of menu.querySelectorAll('[data-mark-color]') || []) {
    button.onclick = () => {
      const name = button.dataset?.markColor ?? button.getAttribute?.('data-mark-color');
      // Clicking the color a session already carries takes it off again.
      write({ color: name === belief(state).color ? null : name }, true);
    };
  }

  const input = menu.querySelector('[data-mark-emoji]');
  if (input) {
    const commit = () => {
      const value = String(input.value ?? '').trim();
      if (value === belief(state).emoji) return;
      // Typing is not finished until Enter, a change or a blur, and none of them
      // closes the menu: the emoji field is the one control Owner stays in.
      write({ emoji: value || null }, false);
    };
    input.onkeydown = (event) => {
      if (event?.key !== 'Enter') return;
      event.preventDefault?.();
      commit();
    };
    input.onchange = commit;
    input.onblur = commit;
  }

  const clear = menu.querySelector('[data-mark-clear]');
  if (clear) clear.onclick = () => write({ color: null, emoji: null }, true);
}
