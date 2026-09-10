// Focus diagnostics deliberately omit text, key values, titles and DOM content.
export function installFocusDebug(snapshot) {
  const client = globalThis.crypto?.randomUUID?.() || String(Date.now());
  let pending = [], timer, lastInput = 0;
  const targetName = (node) => node instanceof Element
    ? `${node.tagName.toLowerCase()}${node.closest('.xterm') ? '.xterm' : node.closest('.qitem') ? '.qitem' : ''}` : 'none';
  const flush = () => {
    timer = null;
    const events = pending.splice(0, 50);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    fetch('/api/ui-debug', { method: 'POST', headers: { 'content-type': 'application/json', 'x-keep': '1' }, body: JSON.stringify({ events }), signal: controller.signal }).catch(() => {}).finally(() => clearTimeout(timeout));
  };
  const log = (event, details = {}) => {
    pending.push({ client, at: Date.now(), event, ...snapshot(), windowFocused: document.hasFocus(), visibility: document.visibilityState,
      inputRecentMs: lastInput ? Date.now() - lastInput : -1, target: targetName(document.activeElement), ...details });
    if (pending.length > 50) pending.shift();
    if (!timer) timer = setTimeout(flush, 500);
  };
  document.addEventListener('keydown', () => { lastInput = Date.now(); }, true);
  for (const event of ['focusin', 'focusout', 'pointerdown', 'pointerup', 'pointercancel', 'click']) document.addEventListener(event, (e) => log(event, { target: targetName(e.target), related: targetName(e.relatedTarget), targetKey: e.target?.closest?.('[data-key]')?.dataset.key || '', pointerId: e.pointerId, x: e.clientX, y: e.clientY }), true);
  for (const event of ['focus', 'blur']) window.addEventListener(event, () => log(`window-${event}`));
  document.addEventListener('visibilitychange', () => log('visibility'));
  log('loaded');
  return log;
}
