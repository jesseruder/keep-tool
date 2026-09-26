// Browser view: a live, clickable picture of a session's browser tabs, over that
// session's terminal (`keep browser show`, bin/browser-view-requests.js).
//
// It floats over the terminal the way Secret Drop does, so the pane never changes size
// and the agent never redraws for it. The picture comes over /ws/browser/<pane>
// (bin/browser-view-bridge.js) from the machine the session runs on: frames are JPEGs
// from the tab's screencast, and Owner's mouse, wheel, keys and pastes go back as input
// events in the page's own CSS pixels. While it is open the page is laid out at the
// size the view has here, so an 800x600 headless window is usable on a phone.
//
// The session is not told when Owner closes it; it reads the page to find out.
import * as api from './api.js';

const GLOBE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';
const RESIZE_SETTLE_MS = 250;
const MAX_PIXEL_RATIO = 2;

// Views Owner closed on this page. The state that still lists one may predate the
// close, and a stage rebuilt in between would otherwise bring it back.
const closedHere = new Set();
// Views Owner folded to their button, for this page's life.
const folded = new Set();
const viewKey = (request) => `${request.id}:${request.createdAt}`;

// The one live view: a stage shows one session, and so at most one view.
let live = null;

export function browserViewFor(data, sessionId, closed = closedHere) {
  if (!sessionId) return null;
  return (data?.browserViews || []).find((r) => r && r.sessionId === sessionId && !closed.has(viewKey(r))) || null;
}

/** DOM modifier state -> CDP's bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifierBits(event) {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

const MOUSE_BUTTONS = ['left', 'middle', 'right', 'back', 'forward'];

/**
 * A point on the drawn picture -> the page's CSS pixels. The picture is letterboxed
 * into the screen, so this goes through the canvas's own box, not the screen's.
 */
export function pagePoint(rect, clientX, clientY, deviceWidth, deviceHeight) {
  const x = ((clientX - rect.left) / Math.max(1, rect.width)) * deviceWidth;
  const y = ((clientY - rect.top) / Math.max(1, rect.height)) * deviceHeight;
  return { x: Math.max(0, Math.min(deviceWidth, x)), y: Math.max(0, Math.min(deviceHeight, y)) };
}

/** A DOM keyboard event as the extension's `key` input (browser-bridge viewer.js). */
export function keyInput(event, type) {
  const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey;
  const special = { Enter: '\r', Tab: '\t' }[event.key];
  const text = type === 'keyUp' ? undefined : (printable ? event.key : (!event.ctrlKey && !event.metaKey ? special : undefined));
  return {
    kind: 'key',
    type: type === 'keyUp' ? 'keyUp' : (text ? 'keyDown' : 'rawKeyDown'),
    key: event.key,
    code: event.code,
    keyCode: event.keyCode || 0,
    modifiers: modifierBits(event),
    ...(text ? { text } : {}),
  };
}

/** The frame a binary message carries: [u32 header length][header JSON][JPEG]. */
export function parseFrame(buffer) {
  const view = new DataView(buffer);
  const length = view.getUint32(0);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length)));
  return { header, image: new Uint8Array(buffer, 4 + length) };
}

function tabLabel(tab) {
  const title = tab.title || tab.url || `tab ${tab.id}`;
  return title.length > 40 ? `${title.slice(0, 39)}…` : title;
}

function viewHTML(esc, request) {
  const where = `#${request.num}${request.node ? ` · ${request.node}` : ''}`;
  return `<div class="bv-card" role="dialog" aria-label="Browser view for ${esc(where)}">`
    + `<div class="bv-bar"><span class="bv-icon">${GLOBE_ICON}</span><span class="bv-title">Browser <span class="bv-where mono">${esc(where)}</span></span>`
    + '<span class="bv-nav"><button type="button" class="btn bv-back" title="Back" aria-label="Back">‹</button><button type="button" class="btn bv-forward" title="Forward" aria-label="Forward">›</button><button type="button" class="btn bv-reload" title="Reload" aria-label="Reload">↻</button></span>'
    + '<span class="bv-url mono" title=""></span>'
    + '<button type="button" class="btn bv-keyboard" title="Type with the on-screen keyboard" aria-label="Keyboard">⌨</button>'
    + '<button type="button" class="btn bv-fold" title="Hide over the terminal; the globe button brings it back">Hide</button>'
    + '<button type="button" class="btn bv-close" title="Close the view for good">Close</button></div>'
    + (request.note ? `<div class="bv-note">${esc(request.note)}</div>` : '')
    + '<div class="bv-tabs" role="tablist" aria-label="Tabs"></div>'
    + '<div class="bv-screen" tabindex="0" aria-label="Browser page: click to control it"><canvas class="bv-canvas"></canvas><div class="bv-status mono" role="status">connecting</div>'
    + '<textarea class="bv-keys" aria-label="Type into the page" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea></div>'
    + '</div>'
    + `<button type="button" class="bv-pill" title="Show the browser view for ${esc(where)}" aria-label="Show the browser view">${GLOBE_ICON}<span>${esc(where)}</span></button>`;
}

function setFolded(root, isFolded) {
  root.classList.toggle('folded', isFolded);
  root.querySelector('.bv-card').hidden = isFolded;
  root.querySelector('.bv-pill').hidden = !isFolded;
}

function teardown() {
  if (!live) return;
  const current = live;
  live = null;
  current.dispose();
}

export function syncBrowserView(stage, ctx, item) {
  let root = stage.querySelector('.browser-view');
  const request = browserViewFor(ctx.data, item?.sessionId);
  if (!request) {
    if (live && (!live.root.isConnected || live.sessionId === item?.sessionId || live.root === root)) teardown();
    if (root && !root.hidden) { root.hidden = true; root.replaceChildren(); delete root.dataset.viewKey; }
    return;
  }
  if (!root) {
    const body = stage.querySelector('.stage-body');
    if (!body) return;
    root = document.createElement('section');
    root.className = 'browser-view';
    root.hidden = true;
    root.setAttribute('aria-label', 'Browser view');
    body.append(root);
  }
  const aside = stage.querySelector('.stage-agent-log');
  root.style.setProperty('--bv-right', aside && !aside.hidden && aside.offsetWidth ? `${aside.offsetWidth}px` : '0px');
  const key = viewKey(request);
  if (live && live.key === key && live.root === root) return;
  teardown();
  root.innerHTML = viewHTML(ctx.esc, request);
  root.dataset.viewKey = key;
  root.hidden = false;
  const isFolded = folded.has(key);
  setFolded(root, isFolded);
  live = startView(root, ctx, request, key);
  if (!isFolded) live.connect();
}

function startView(root, ctx, request, key) {
  const screen = root.querySelector('.bv-screen');
  const canvas = root.querySelector('.bv-canvas');
  const status = root.querySelector('.bv-status');
  const tabsBar = root.querySelector('.bv-tabs');
  const urlBox = root.querySelector('.bv-url');
  const keys = root.querySelector('.bv-keys');
  const draw = canvas.getContext('2d');
  let socket = null;
  let disposed = false;
  let tabs = [];
  let tabId = null;
  let device = { width: 0, height: 0 };
  let sentSize = null;
  let resizeTimer = null;
  let pendingMove = null;
  let moveScheduled = false;
  let buttonsDown = 0;
  let touch = null;
  let decoding = false;
  let queued = null;
  let needsStart = false;
  // needsStart came from a failed restart: a frame arriving after it means the tab came
  // back by itself, and a click is input again.
  let retryArmed = false;

  const setStatus = (text) => {
    status.textContent = text || '';
    status.hidden = !text;
  };
  const send = (value) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
  };
  const input = (value) => send({ t: 'input', input: value });

  const size = () => {
    const box = screen.getBoundingClientRect();
    return {
      width: Math.max(200, Math.round(box.width)),
      height: Math.max(200, Math.round(box.height)),
      pixelRatio: Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1),
    };
  };
  const start = (id) => {
    if (id == null) return;
    tabId = id;
    needsStart = false;
    retryArmed = false;
    sentSize = size();
    send({ t: 'start', tabId: id, ...sentSize, fit: true });
    renderTabs();
    setStatus('loading');
  };

  const renderTabs = () => {
    tabsBar.replaceChildren(...tabs.map((tab) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `bv-tab${tab.id === tabId ? ' on' : ''}${tab.popup ? ' popup' : ''}`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(tab.id === tabId));
      button.title = `${tab.title || ''}\n${tab.url || ''}`.trim();
      button.textContent = `${tab.popup ? '↗ ' : ''}${tabLabel(tab)}`;
      button.addEventListener('click', () => { if (tab.id !== tabId) start(tab.id); });
      return button;
    }));
    tabsBar.hidden = tabs.length < 2;
    const current = tabs.find((tab) => tab.id === tabId);
    urlBox.textContent = current?.url || '';
    urlBox.title = current?.url || '';
  };

  const pickTab = () => {
    if (tabs.some((tab) => tab.id === tabId)) return tabId;
    if (request.tabId != null && tabs.some((tab) => tab.id === request.tabId)) return request.tabId;
    // A pop-up the session's page just opened is where a sign-in usually is.
    const popup = [...tabs].reverse().find((tab) => tab.popup);
    return (popup || tabs.find((tab) => tab.active) || tabs[0])?.id ?? null;
  };

  // Every frame is acked exactly once, drawn or not: the stream waits on those acks.
  // A frame belongs to the socket it came on: one still decoding when the view
  // reconnected is neither drawn nor acked on the new one.
  const drawFrame = async (buffer) => {
    const from = socket;
    try {
      const { header, image } = parseFrame(buffer);
      if (header.tabId !== tabId) return;
      const bitmap = await createImageBitmap(new Blob([image], { type: 'image/jpeg' }));
      if (disposed || from !== socket) return;
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      draw.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      if (retryArmed) { retryArmed = false; needsStart = false; }
      const meta = header.metadata || {};
      device = {
        width: meta.deviceWidth || bitmap.width / (sentSize?.pixelRatio || 1),
        height: meta.deviceHeight || bitmap.height / (sentSize?.pixelRatio || 1),
      };
      setStatus('');
    } finally {
      if (from === socket) send({ t: 'ack' });
    }
  };
  // One decode at a time, and only the newest waiting frame: a slow phone skips
  // pictures rather than falling behind.
  const onFrame = async (buffer) => {
    if (decoding) {
      // The frame it replaces is never drawn; its ack goes back now.
      if (queued) send({ t: 'ack' });
      queued = buffer;
      return;
    }
    decoding = true;
    try {
      await drawFrame(buffer);
      while (queued && !disposed) {
        const next = queued;
        queued = null;
        await drawFrame(next);
      }
    } catch (error) {
      console.warn('browser view: bad frame', error);
      if (queued) { queued = null; send({ t: 'ack' }); }
    } finally {
      decoding = false;
    }
  };

  const onMessage = (message) => {
    if (message.t === 'open') {
      setStatus(message.extensionConnected ? 'finding tabs' : 'the browser extension is not connected on that machine');
    } else if (message.t === 'tabs') {
      tabs = Array.isArray(message.tabs) ? message.tabs : [];
      const next = pickTab();
      if (next == null) {
        tabId = null;
        renderTabs();
        setStatus('this session has no browser tabs open');
      } else if (next !== tabId) start(next);
      else renderTabs();
    } else if (message.t === 'started') {
      if (message.tab?.url) { urlBox.textContent = message.tab.url; urlBox.title = message.tab.url; }
    } else if (message.t === 'state') {
      if (message.state === 'detached') setStatus('reconnecting to the tab');
      else if (message.state === 'tab-closed') { tabId = null; send({ t: 'tabs' }); }
      // A restart after the tab detached failed: a click tries again.
      else if (message.state === 'error') { needsStart = true; retryArmed = true; setStatus(`${message.reason || 'the view stopped'} · click to retry`); }
      else if (message.state === 'taken-over') { needsStart = true; retryArmed = false; setStatus('another view opened this tab · click to take it back'); }
      else if (message.state === 'stopped') { needsStart = true; retryArmed = false; setStatus(`the view stopped${message.reason ? `: ${message.reason}` : ''} · click to restart`); }
    } else if (message.t === 'error') {
      setStatus(message.message || 'error');
    }
  };

  const connect = () => {
    if (disposed || socket) return;
    // A new connection is a new view on the far side: it has to be started again, on
    // whichever tab the tab list picks.
    tabId = null;
    sentSize = null;
    needsStart = false;
    retryArmed = false;
    queued = null;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const query = new URLSearchParams({ session: String(request.num) });
    const connection = new WebSocket(`${protocol}//${location.host}/ws/browser/${encodeURIComponent(request.pane)}?${query}`);
    socket = connection;
    socket.binaryType = 'arraybuffer';
    setStatus('connecting');
    socket.addEventListener('message', (event) => {
      if (connection !== socket) return;
      if (typeof event.data === 'string') {
        try { onMessage(JSON.parse(event.data)); } catch {}
      } else onFrame(event.data);
    });
    socket.addEventListener('close', () => {
      if (connection !== socket) return;
      socket = null;
      if (!disposed && !root.classList.contains('folded')) setStatus('disconnected · click to reconnect');
    });
  };
  const disconnect = () => {
    const current = socket;
    socket = null;
    try { current?.close(); } catch {}
  };

  // --- input -------------------------------------------------------------

  const point = (event) => pagePoint(canvas.getBoundingClientRect(), event.clientX, event.clientY, device.width || 1, device.height || 1);
  const flushMove = () => {
    moveScheduled = false;
    if (!pendingMove) return;
    input(pendingMove);
    pendingMove = null;
  };
  // PointerEvent.detail is 0 in Chromium, so double and triple clicks are counted here:
  // the same button pressed again within half a second, a few pixels from the last.
  let lastPress = null;
  const clickCount = (event) => {
    const now = performance.now();
    const again = lastPress && lastPress.button === event.button && now - lastPress.at < 500
      && Math.abs(event.clientX - lastPress.x) + Math.abs(event.clientY - lastPress.y) < 6;
    const count = again ? Math.min(3, lastPress.count + 1) : 1;
    lastPress = { button: event.button, at: now, x: event.clientX, y: event.clientY, count };
    return count;
  };
  canvas.addEventListener('pointerdown', (event) => {
    screen.focus({ preventScroll: true });
    if (!socket) { connect(); return; }
    if (needsStart) {
      // Taken over by another view, or stopped on the far side: a click takes it back.
      start(tabId ?? pickTab());
      return;
    }
    if (event.pointerType === 'touch') {
      touch = { x: event.clientX, y: event.clientY, lastY: event.clientY, lastX: event.clientX, moved: false };
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    const button = MOUSE_BUTTONS[event.button] || 'left';
    buttonsDown = event.buttons;
    canvas.setPointerCapture(event.pointerId);
    input({ kind: 'mouse', type: 'mousePressed', ...point(event), button, buttons: event.buttons, clickCount: clickCount(event), modifiers: modifierBits(event) });
    event.preventDefault();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') {
      if (!touch) return;
      const dx = touch.lastX - event.clientX;
      const dy = touch.lastY - event.clientY;
      if (Math.abs(event.clientX - touch.x) + Math.abs(event.clientY - touch.y) > 8) touch.moved = true;
      if (touch.moved && (dx || dy)) {
        const scale = (device.width || 1) / Math.max(1, canvas.getBoundingClientRect().width);
        input({ kind: 'mouse', type: 'mouseWheel', ...point(event), deltaX: dx * scale, deltaY: dy * scale });
      }
      touch.lastX = event.clientX;
      touch.lastY = event.clientY;
      return;
    }
    pendingMove = { kind: 'mouse', type: 'mouseMoved', ...point(event), button: buttonsDown ? 'left' : 'none', buttons: event.buttons, modifiers: modifierBits(event) };
    if (!moveScheduled) { moveScheduled = true; requestAnimationFrame(flushMove); }
  });
  canvas.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'touch') {
      if (touch && !touch.moved) {
        const at = point(event);
        input({ kind: 'mouse', type: 'mouseMoved', ...at, button: 'none', buttons: 0 });
        input({ kind: 'mouse', type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount: 1 });
        input({ kind: 'mouse', type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1 });
      }
      touch = null;
      return;
    }
    flushMove();
    const button = MOUSE_BUTTONS[event.button] || 'left';
    buttonsDown = event.buttons;
    input({ kind: 'mouse', type: 'mouseReleased', ...point(event), button, buttons: event.buttons, clickCount: lastPress?.count || 1, modifiers: modifierBits(event) });
  });
  canvas.addEventListener('pointercancel', () => { touch = null; buttonsDown = 0; });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const lines = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? (device.height || 600) : 1;
    input({ kind: 'mouse', type: 'mouseWheel', ...point(event), deltaX: event.deltaX * lines, deltaY: event.deltaY * lines, modifiers: modifierBits(event) });
  }, { passive: false });

  // Keys go to the page while the picture has focus, and stay out of the console's
  // own shortcuts. A paste is let through to become a paste event, which carries the
  // text; the page cannot read this machine's clipboard otherwise.
  const isPaste = (event) => (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v';
  screen.addEventListener('keydown', (event) => {
    if (event.target === keys) return;
    event.stopPropagation();
    if (isPaste(event)) return;
    event.preventDefault();
    input(keyInput(event, 'keyDown'));
  });
  screen.addEventListener('keyup', (event) => {
    if (event.target === keys) return;
    event.stopPropagation();
    if (isPaste(event)) return;
    event.preventDefault();
    input(keyInput(event, 'keyUp'));
  });
  screen.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text/plain');
    event.preventDefault();
    // The extension inserts at most 20,000 characters, and a bigger message would
    // close the socket.
    if (text) input({ kind: 'text', text: text.slice(0, 20_000) });
  });

  // The on-screen keyboard: a text field the phone types into, emptied as it goes.
  keys.addEventListener('keydown', (event) => {
    event.stopPropagation();
    const named = ['Backspace', 'Enter', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete'];
    if (named.includes(event.key) || event.metaKey || event.ctrlKey) {
      event.preventDefault();
      input(keyInput(event, 'keyDown'));
      input(keyInput(event, 'keyUp'));
    }
  });
  keys.addEventListener('input', (event) => {
    if (event.inputType === 'deleteContentBackward') {
      const backspace = { key: 'Backspace', code: 'Backspace', keyCode: 8, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
      input(keyInput(backspace, 'keyDown'));
      input(keyInput(backspace, 'keyUp'));
    } else if (keys.value) {
      input({ kind: 'text', text: keys.value.slice(0, 20_000) });
    }
    keys.value = '';
  });
  root.querySelector('.bv-keyboard').addEventListener('click', () => keys.focus());

  root.querySelector('.bv-back').addEventListener('click', () => send({ t: 'nav', action: 'back' }));
  root.querySelector('.bv-forward').addEventListener('click', () => send({ t: 'nav', action: 'forward' }));
  root.querySelector('.bv-reload').addEventListener('click', () => send({ t: 'nav', action: 'reload' }));
  root.querySelector('.bv-fold').addEventListener('click', () => {
    folded.add(key);
    setFolded(root, true);
    disconnect();
    root.closest('.stage-body')?.querySelector('.stage-terminal .xterm-helper-textarea')?.focus();
  });
  root.querySelector('.bv-pill').addEventListener('click', () => {
    folded.delete(key);
    setFolded(root, false);
    connect();
    screen.focus({ preventScroll: true });
  });
  root.querySelector('.bv-close').addEventListener('click', () => {
    closedHere.add(key);
    teardown();
    root.hidden = true;
    root.replaceChildren();
    delete root.dataset.viewKey;
    root.closest('.stage-body')?.querySelector('.stage-terminal .xterm-helper-textarea')?.focus();
    api.write('/api/browser-view/close', { id: request.id }, 'POST', { label: 'Closing browser view', background: true });
  });

  // The page follows the view's size while it is open, once the size settles.
  const observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const next = size();
      // A view another console took over stays put until Owner clicks to take it back.
      if (needsStart) return;
      if (tabId != null && socket && (!sentSize || next.width !== sentSize.width || next.height !== sentSize.height)) start(tabId);
    }, RESIZE_SETTLE_MS);
  });
  observer.observe(screen);

  return {
    key,
    root,
    sessionId: request.sessionId,
    connect,
    dispose() {
      disposed = true;
      observer.disconnect();
      clearTimeout(resizeTimer);
      disconnect();
    },
  };
}
