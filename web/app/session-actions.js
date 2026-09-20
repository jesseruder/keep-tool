import { effectiveTerminalRenderer } from './terminal-renderer.js';

export function actionsMenuHTML() {
  return '<details class="session-actions"><summary class="btn" aria-label="Session actions">Actions</summary><div class="session-actions-pop"><div class="session-actions-content"></div></div></details>';
}

function focusIdentity(element) {
  if (!(element instanceof Element)) return null;
  for (const name of ['renderer', 'restart', 'handoffAccount', 'portableTransfer', 'portableFallback', 'relaySession',
    'markColor', 'emoji']) {
    if (element.dataset[name] != null) return `[data-${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}="${CSS.escape(element.dataset[name])}"]`;
  }
  return ['pin', 'unpin', 'closeSession', 'snooze', 'dismiss', 'waitDependency', 'reopen', 'kill', 'removePane',
    'rename', 'renameReset', 'markEmoji', 'emojiPick', 'emojiSearch', 'markClear', 'keepRunning']
    .find((name) => element.dataset[name] != null);
}

function focusSelector(identity) {
  if (!identity) return null;
  if (identity.startsWith('[')) return identity;
  return `[data-${identity.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}]`;
}

export function patchActionsMenu(ctx, menu, html) {
  const content = menu.querySelector('.session-actions-content');
  const focused = menu.contains(document.activeElement) ? document.activeElement : null;
  const identity = focused ? focusIdentity(focused) : null;
  // A text field Owner is typing in has a value the markup does not know about
  // yet — the emoji field is only written once it is committed. Carry it across
  // the patch so a refresh a second later does not type over it.
  const typed = identity && focused.tagName === 'INPUT' ? focused.value : null;
  const changed = ctx.patchHTML(content, html);
  if (changed && identity) {
    const restored = content.querySelector(focusSelector(identity));
    if (restored && typed != null) restored.value = typed;
    restored?.focus({ preventScroll: true });
  }
  return changed;
}

export function rendererControlsHTML(ctx, pane, paneState) {
  if (!pane) return '';
  const selected = effectiveTerminalRenderer(pane, paneState);
  const option = (renderer, label) => `<button class="btn renderer-choice ${selected === renderer ? 'selected' : ''}" type="button" aria-pressed="${selected === renderer}" data-renderer="${renderer}"><span>${label}</span><span class="renderer-check" aria-hidden="true">${selected === renderer ? '✓' : ''}</span></button>`;
  return `<div class="session-actions-label">Terminal renderer</div><div class="renderer-options" role="group" aria-label="Terminal renderer">${option('dom', 'Standard')}${option('webgl', 'GPU accelerated')}</div>`;
}

export function keepRunningControlHTML(session) {
  if (!session?.id) return '';
  const keepRunning = session.keepRunning === true;
  const label = keepRunning ? 'Allow automatic close' : 'Keep running';
  const help = keepRunning
    ? 'Keep running is on. Activate to allow Keep to pause this session after its work has settled'
    : 'Keep running is off. Activate to keep this session open until you allow automatic close';
  return `<div class="session-actions-label">Automatic close</div><button class="btn" type="button" data-keep-running aria-pressed="${keepRunning}" aria-label="${help}" title="${help}">${label}</button>`;
}

export function installKeepRunningControl(menu, ctx, session, setKeepRunning) {
  const button = menu.querySelector('[data-keep-running]');
  if (!button || !session?.id) return;
  button.onclick = async () => {
    if (button.disabled) return;
    const next = session.keepRunning !== true;
    const label = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Saving…';
    try {
      await setKeepRunning(session.id, next);
      session.keepRunning = next;
      ctx.refresh();
    } catch (error) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = label;
      ctx.toast(`Could not update automatic close: ${error.message}`);
    }
  };
}

let dismissInstalled = false;
function installOutsideDismiss() {
  if (dismissInstalled) return;
  dismissInstalled = true;
  document.addEventListener('pointerdown', (event) => {
    document.querySelectorAll('.session-actions[open]').forEach((menu) => {
      if (!menu.contains(event.target)) menu.removeAttribute('open');
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const menu = document.activeElement?.closest?.('.session-actions[open]')
      || document.querySelector('.session-actions[open]');
    if (!menu) return;
    menu.removeAttribute('open');
    menu.querySelector(':scope > summary')?.focus();
    event.preventDefault();
  });
}

export function installActionsMenu(menu, ctx, pane) {
  installOutsideDismiss();
  if (!menu.dataset.actionsInstalled) {
    menu.dataset.actionsInstalled = '1';
    menu.addEventListener('toggle', () => {
      if (!menu.open) return;
      const summary = menu.querySelector(':scope > summary');
      const popover = menu.querySelector('.session-actions-pop');
      const anchor = summary.getBoundingClientRect();
      popover.style.position = 'fixed';
      popover.style.right = `${Math.max(6, innerWidth - anchor.right)}px`;
      popover.style.top = `${anchor.bottom + 5}px`;
      const bounds = popover.getBoundingClientRect();
      if (bounds.bottom > innerHeight - 6) popover.style.top = `${Math.max(6, anchor.top - bounds.height - 5)}px`;
    });
  }
  menu.querySelectorAll('[data-renderer]').forEach((button) => {
    button.onclick = () => {
      const renderer = button.dataset.renderer;
      ctx.setTerminalRenderer(pane, renderer);
      menu.querySelector(`[data-renderer="${renderer}"]`)?.focus({ preventScroll: true });
    };
  });
}
