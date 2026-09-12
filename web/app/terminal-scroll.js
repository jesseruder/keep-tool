const TRACKPAD_PIXEL_LIMIT = 50;
const MAX_PENDING_REPORTS = 24;
const REPORTS_PER_FRAME = 4;
const MAX_QUEUE_AGE_MS = 120;
const MOUSE_WHEEL_MODES = new Set(['vt200', 'drag', 'any']);

function renderedCellHeight(terminal) {
  const height = terminal.element?.querySelector('.xterm-screen')?.getBoundingClientRect().height;
  return Number.isFinite(height) && height > 0 && terminal.rows > 0 ? height / terminal.rows : 0;
}

function wheelInit(event, direction) {
  return {
    bubbles: true,
    cancelable: true,
    view: event.view,
    detail: event.detail,
    screenX: event.screenX,
    screenY: event.screenY,
    clientX: event.clientX,
    clientY: event.clientY,
    button: event.button,
    buttons: event.buttons,
    relatedTarget: event.relatedTarget,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    deltaX: 0,
    deltaY: direction,
    deltaZ: 0,
    deltaMode: WheelEvent.DOM_DELTA_LINE,
  };
}

/**
 * Preserve pixel trackpad distance when a terminal application owns the wheel.
 *
 * Xterm intentionally damps likely-trackpad deltas before converting them to rows,
 * then emits at most one application mouse report for each DOM wheel event. This
 * handler converts those deltas to unit line events first. Xterm still owns the
 * protocol encoding and terminal coordinates for every resulting report.
 */
export function createTrackedPixelWheelHandler(terminal, options = {}) {
  const requestFrame = options.requestFrame || requestAnimationFrame;
  const cancelFrame = options.cancelFrame || cancelAnimationFrame;
  const active = options.active || (() => true);
  const now = options.now || (() => performance.now());
  const forwarded = new WeakSet();
  const pending = [];
  let remainder = 0;
  let frame = 0;
  let mode = null;

  const cancel = () => {
    if (frame) cancelFrame(frame);
    frame = 0;
    pending.length = 0;
    remainder = 0;
    mode = null;
  };

  const flush = () => {
    frame = 0;
    if (!active() || terminal.modes.mouseTrackingMode !== mode || !MOUSE_WHEEL_MODES.has(mode)
        || now() - pending[0].queuedAt > MAX_QUEUE_AGE_MS) {
      cancel();
      return;
    }
    for (let sent = 0; sent < REPORTS_PER_FRAME && pending.length; sent++) {
      const report = pending.shift();
      const event = new WheelEvent('wheel', report.init);
      forwarded.add(event);
      terminal.element.dispatchEvent(event);
    }
    if (pending.length) frame = requestFrame(flush);
  };

  const handle = (event) => {
    if (forwarded.has(event)) {
      forwarded.delete(event);
      return true;
    }

    const currentMode = terminal.modes.mouseTrackingMode;
    const unmodified = !event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey;
    const likelyTrackpad = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
      && event.deltaY !== 0 && Math.abs(event.deltaY) < TRACKPAD_PIXEL_LIMIT;
    if (!MOUSE_WHEEL_MODES.has(currentMode) || !unmodified || !likelyTrackpad) {
      cancel();
      return true;
    }
    // Suppress tracked pixels while hidden or disconnected rather than allowing
    // xterm to turn them into input that can be replayed after the pane returns.
    if (!active()) {
      cancel();
      return false;
    }

    if (mode && mode !== currentMode) cancel();
    mode = currentMode;
    const cellHeight = renderedCellHeight(terminal);
    if (!cellHeight) {
      cancel();
      return true;
    }

    remainder += event.deltaY / cellHeight;
    const reports = Math.trunc(remainder);
    remainder -= reports;
    const available = MAX_PENDING_REPORTS - pending.length;
    const accepted = Math.min(Math.abs(reports), available);
    const direction = Math.sign(reports);
    const init = wheelInit(event, direction);
    const queuedAt = now();
    for (let index = 0; index < accepted; index++) pending.push({ init, queuedAt });
    if (pending.length && !frame) frame = requestFrame(flush);
    return false;
  };

  return {
    handle,
    cancel,
  };
}
