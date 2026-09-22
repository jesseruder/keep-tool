import { dismissWriteFailure, lastWriteFailure, onPendingChange, reportWriteFailure } from './api.js';

function setBusy(button, label) {
  if (!button) return () => {};
  const original = button.innerHTML;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.innerHTML = `<span class="spin" aria-hidden="true"></span><span>${label}</span>`;
  return () => {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.innerHTML = original;
  };
}

export async function runAction(button, fn, { label = 'Working…', ctx, retry } = {}) {
  if (button?.disabled) return undefined;
  const restore = setBusy(button, label);
  try {
    return await fn();
  } catch (error) {
    reportWriteFailure(error, {
      label: label.replace(/[.…]+$/, ''),
      message: error?.actionMessage || error?.message || String(error),
      retry,
    });
    ctx?.renderActionStatus?.();
    throw error;
  } finally {
    restore();
  }
}

function failureTime(at) {
  try { return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
}

export function installActionFeedback(root) {
  const render = () => {
    const failure = lastWriteFailure();
    root.hidden = !failure;
    if (!failure) { root.replaceChildren(); return; }
    root.innerHTML = `<div><b></b><span class="write-failure-time"></span><p></p></div>${failure.retry ? '<button class="btn" data-retry>Retry</button>' : ''}<button class="btn" data-dismiss>Dismiss</button>`;
    root.querySelector('b').textContent = failure.label;
    root.querySelector('p').textContent = failure.message;
    root.querySelector('.write-failure-time').textContent = failureTime(failure.at);
    root.querySelector('[data-dismiss]').onclick = () => dismissWriteFailure(failure.id);
    const retry = root.querySelector('[data-retry]');
    if (retry) retry.onclick = () => runAction(retry, failure.retry, { label: 'Retrying…', retry: failure.retry }).catch(() => {});
  };
  const unsubscribe = onPendingChange(render);
  render();
  return unsubscribe;
}
