// Renaming a session by hand. The daemon stores the name (bin/session-names.js)
// and stops generating titles for that session, so the console only has to write
// the name and let the next state reload show it.
//
// The editor lives inside a heading the renderer patches every few seconds, so
// the renderer asks isEditing() first and leaves the heading alone while an input
// is open. Cancelling restores the exact markup patchHTML last wrote, which keeps
// its "unchanged" cache honest.

export const RENAMED_HINT = 'Renamed by hand; automatic titles are off';

const escapeHTML = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renameFormHTML(esc = escapeHTML, title = '') {
  return `<form class="rename-session"><input name="title" maxlength="120" aria-label="Session name" spellcheck="false" value="${esc(title)}"></form>`;
}

// Rename is offered for anything with a session; the reset only for a session
// that actually carries a hand-typed name.
export function renameButtonsHTML(sessionId, renamed) {
  if (!sessionId) return '';
  return `<button class="btn" type="button" data-rename>Rename</button>${
    renamed ? '<button class="btn" type="button" data-rename-reset>Use automatic title</button>' : ''}`;
}

export function isEditing(heading) {
  return Boolean(heading && heading.querySelector && heading.querySelector('.rename-session'));
}

// `rename(sessionId, title)` is the api call, `onDone(result)` runs after it
// resolves (the caller reloads), `onError(message)` reports a failed write.
export function startRename(options = {}) {
  const { heading, sessionId, title = '', rename, onDone, onError } = options;
  const esc = options.esc || escapeHTML;
  if (!heading || !sessionId || typeof rename !== 'function' || isEditing(heading)) return null;
  const target = heading.querySelector('h2') || heading.querySelector('b') || heading;
  const restore = heading.innerHTML;
  let settled = false;
  const close = () => {
    if (settled) return false;
    settled = true;
    heading.innerHTML = restore;
    return true;
  };

  target.innerHTML = renameFormHTML(esc, title);
  const form = target.querySelector('.rename-session');
  const input = form.querySelector('input[name="title"]');
  form.addEventListener('submit', (event) => {
    event.preventDefault?.();
    if (settled) return;
    const value = input.value;
    // Close before the write so the blur the removal causes is a no-op and the
    // heading is never left with a dead input if the request hangs.
    close();
    Promise.resolve()
      .then(() => rename(sessionId, value))
      .then((result) => onDone?.(result))
      .catch((error) => onError?.(error && error.message ? error.message : String(error)));
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault?.();
    event.stopPropagation?.();
    close();
  });
  input.addEventListener('blur', () => close());
  input.focus?.();
  input.select?.();
  return { input, form, cancel: close };
}

// Wires the two Actions-menu buttons. `rename` is the api call so the stage and
// the Watch pane can share this without either importing the other.
export function installRenameControls(menu, ctx, heading, sessionId, title, rename) {
  if (!menu) return;
  const done = () => ctx.reload?.();
  const fail = (message) => ctx.toast?.(`Not renamed: ${message}`);
  const renameButton = menu.querySelector('[data-rename]');
  if (renameButton) renameButton.onclick = () => {
    menu.removeAttribute('open');
    startRename({ heading, sessionId, title, rename, esc: ctx.esc, onDone: done, onError: fail });
  };
  const resetButton = menu.querySelector('[data-rename-reset]');
  if (resetButton) resetButton.onclick = async () => {
    menu.removeAttribute('open');
    try { await rename(sessionId, ''); await done(); }
    catch (error) { fail(error.message); }
  };
}
