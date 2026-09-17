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

// The heading's title advertises itself as the rename affordance: the renderers
// put these attributes on the h2/b whenever there is a session to rename, so the
// markup for the hint lives here next to the handler that reads it.
export function titleAttrsHTML(esc = escapeHTML, sessionId, renamed) {
  if (!sessionId) return '';
  const hint = renamed ? `${RENAMED_HINT}. Click to rename` : 'Click to rename';
  return ` data-rename-title tabindex="0" title="${esc(hint)}"`;
}

// The heading element survives every re-render; only its innerHTML is patched.
// So the click listener goes on the heading once and reads the session it points
// at now, not the one it pointed at when the listener was installed.
const renameTargets = new WeakMap();
const renameWired = new WeakSet();

function hasClass(node, name) {
  if (node?.classList?.contains) return node.classList.contains(name);
  const value = node?.attributes?.get?.('class') ?? node?.className ?? '';
  return String(value).split(/\s+/).includes(name);
}

// The chain from `root` down to `node`, or null when `node` is outside `root`.
// Walking `children` keeps this true for the console's DOM and for the fake DOM
// the tests use, neither of which needs `closest`.
function pathTo(root, node) {
  if (!root || !node) return null;
  if (root === node) return [root];
  for (const child of root.children || []) {
    const found = pathTo(child, node);
    if (found) return [root, ...found];
  }
  return null;
}

// Clicking the title starts the rename; the Actions menu keeps its buttons as
// the discoverable fallback. Called on every render to refresh the target.
export function installHeadingRename(heading, ctx, sessionId, title, rename) {
  if (!heading) return;
  renameTargets.set(heading, { ctx, sessionId, title, rename });
  if (renameWired.has(heading)) return;
  renameWired.add(heading);
  const open = (event) => {
    const target = renameTargets.get(heading);
    if (!target || !target.sessionId || typeof target.rename !== 'function') return;
    if (isEditing(heading)) return;
    const titleNode = heading.querySelector?.('h2') || heading.querySelector?.('b');
    const path = pathTo(titleNode, event?.target);
    // Only the title itself: not the meta line, not the number badge (whose
    // tooltip carries the session id), not the editor once it is open.
    if (!path) return;
    if (path.some((node) => hasClass(node, 'num-id') || hasClass(node, 'rename-session'))) return;
    event?.preventDefault?.();
    const context = target.ctx || {};
    startRename({
      heading,
      sessionId: target.sessionId,
      title: target.title,
      rename: target.rename,
      esc: context.esc,
      onDone: () => context.reload?.(),
      onError: (message) => context.toast?.(`Not renamed: ${message}`),
    });
  };
  heading.addEventListener('click', open);
  heading.addEventListener('keydown', (event) => {
    if (event?.key !== 'Enter') return;
    // ⌘Enter and friends belong to the global shortcuts (app.js handles them in
    // the capture phase and prevents the default without stopping propagation).
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const titleNode = heading.querySelector?.('h2') || heading.querySelector?.('b');
    if (!titleNode || event.target !== titleNode) return;
    open(event);
  });
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
