import { effectiveTerminalRenderer } from './terminal-renderer.js';

export function actionsMenuHTML() {
  return '<details class="session-actions"><summary class="btn" aria-label="Session actions">Actions</summary><div class="session-actions-pop"><div class="session-actions-content"></div></div></details>';
}

function focusIdentity(element) {
  if (!(element instanceof Element)) return null;
  for (const name of ['renderer', 'restart', 'handoffAccount', 'portableTransfer', 'portableFallback', 'relaySession']) {
    if (element.dataset[name] != null) return `[data-${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}="${CSS.escape(element.dataset[name])}"]`;
  }
  return ['pin', 'unpin', 'closeSession', 'snooze', 'dismiss', 'waitDependency', 'reopen', 'kill', 'removePane',
    'rename', 'renameReset']
    .find((name) => element.dataset[name] != null);
}

function focusSelector(identity) {
  if (!identity) return null;
  if (identity.startsWith('[')) return identity;
  return `[data-${identity.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}]`;
}

export function patchActionsMenu(ctx, menu, html) {
  const content = menu.querySelector('.session-actions-content');
  const identity = menu.contains(document.activeElement) ? focusIdentity(document.activeElement) : null;
  const changed = ctx.patchHTML(content, html);
  if (changed && identity) content.querySelector(focusSelector(identity))?.focus({ preventScroll: true });
  return changed;
}

export function rendererControlsHTML(ctx, pane, paneState) {
  if (!pane) return '';
  const selected = effectiveTerminalRenderer(pane, paneState);
  const option = (renderer, label) => `<button class="btn renderer-choice ${selected === renderer ? 'selected' : ''}" type="button" aria-pressed="${selected === renderer}" data-renderer="${renderer}"><span>${label}</span><span class="renderer-check" aria-hidden="true">${selected === renderer ? '✓' : ''}</span></button>`;
  return `<div class="session-actions-label">Terminal renderer</div><div class="renderer-options" role="group" aria-label="Terminal renderer">${option('dom', 'Standard')}${option('webgl', 'GPU accelerated')}</div>`;
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
