// Deferred focus is an expiring user intent, not a property of the latest data.
// One clock per document covers every terminal and the application scheduler.
const clocks = new WeakMap();
export function captureFocusIntent(doc = document) {
  let clock = clocks.get(doc);
  if (!clock) {
    clock = { revision: 0 };
    const advance = () => { clock.revision++; };
    for (const event of ['pointerdown', 'keydown']) doc.addEventListener(event, advance, true);
    doc.defaultView?.addEventListener('blur', advance);
    clocks.set(doc, clock);
  }
  const revision = clock.revision, origin = doc.activeElement;
  return () => clock.revision === revision && doc.visibilityState !== 'hidden'
    && (doc.activeElement === origin || doc.activeElement === doc.body);
}
