// Background renders must not move or replace a control between press and click.
// Let the browser own click/drag/cancel semantics; never synthesize activation.
export function installInteractionGuard(render, doc = document) {
  let pointer = null, pending = false, releaseTimer;
  const flush = () => {
    clearTimeout(releaseTimer);
    pointer = null;
    if (pending) { pending = false; render(); }
  };
  doc.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.isPrimary === false || !event.target.closest?.('button, a, .qitem, .queue-strip, .rside-strip')
        || event.target.closest('.xterm')) return;
    clearTimeout(releaseTimer);
    pointer = event.pointerId;
  }, true);
  doc.addEventListener('click', () => {
    if (pointer === null) return;
    clearTimeout(releaseTimer);
    pointer = null;
    // Handlers select against current data before a queued background render.
    releaseTimer = setTimeout(flush, 0);
  }, true);
  doc.addEventListener('pointerup', event => {
    if (event.pointerId === pointer) releaseTimer = setTimeout(flush, event.pointerType === 'touch' ? 350 : 0);
  }, true);
  doc.addEventListener('pointercancel', flush, true);
  // A release outside the window may not deliver pointerup to this document.
  doc.addEventListener('pointermove', event => { if (pointer !== null && event.buttons === 0) flush(); }, true);
  doc.addEventListener('keydown', flush, true);
  doc.defaultView?.addEventListener('blur', flush);
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') flush(); });
  return { defer() { if (pointer === null) { pending = false; return false; } pending = true; return true; } };
}
