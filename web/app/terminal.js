import { createImagePasteHandler } from './image-paste.js';
import { getPalette, resolvedTheme, xtermTheme } from './theme.js';
import { captureFocusIntent } from './focus-intent.js';
import { createTrackedPixelWheelHandler } from './terminal-scroll.js';
import { createTerminalProfiler } from './terminal-profile.js';

const encoder = new TextEncoder();

function base64Bytes(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function mountViewerId(pane, slot) {
  const key = `keep.console.viewer:${slot || pane}:${pane}`;
  try {
    let viewer = sessionStorage.getItem(key);
    if (!viewer) {
      viewer = `console-${crypto.randomUUID()}`;
      sessionStorage.setItem(key, viewer);
    }
    return viewer;
  } catch { return `console-${crypto.randomUUID()}`; }
}

export function mountTerminal(container, pane, options = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'term';
  wrapper.tabIndex = 0;
  wrapper.dataset.pane = pane;
  wrapper.innerHTML = `<div class="findbar"><input aria-label="find in terminal" placeholder="Find"><button data-prev>↑</button><button data-next>↓</button><button data-close>✕</button></div><div class="xterm-host"></div><div class="term-status"><span class="term-state">connecting</span><button class="term-history" type="button" hidden>Load earlier output</button><span class="term-note"></span></div>`;
  container.replaceChildren(wrapper);

  const status = wrapper.querySelector('.term-status');
  const statusState = wrapper.querySelector('.term-state');
  const historyButton = wrapper.querySelector('.term-history');
  historyButton.hidden = true;
  const statusNote = wrapper.querySelector('.term-note');
  const host = wrapper.querySelector('.xterm-host');
  const terminal = new window.Terminal({
    scrollback: 50000,
    allowProposedApi: true,
    fontFamily: '"SF Mono", Menlo, monospace',
    fontSize: 12.5,
    macOptionIsMeta: true,
    cursorBlink: true,
    theme: xtermTheme(resolvedTheme(), getPalette()),
  });
  const fit = new window.FitAddon.FitAddon();
  const search = new window.SearchAddon.SearchAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  terminal.open(host);

  const viewer = mountViewerId(pane, options.slot);
  let socket;
  let webglAddon;
  let webglContextLoss;
  let disposed = false;
  let exited = false;
  let exitReported = false;
  let retry = 0;
  let retryTimer;
  let resizeTimer;
  let showFrame = 0;
  let showFocus = false;
  let showFocusIntent = null;
  let showFocusContainer = null;
  let presented = true;
  let observing = false;
  let connectedOnce = false;
  let retryable = true;
  let replayDone = false;
  let fullHistory = false;
  // Whether the attach snapshot left scrollback behind on the host. A new terminal
  // has nothing earlier to load, so the button stays hidden until it does.
  let moreHistory = false;
  let isPrimary = false;
  let claimPending = false;
  let paneState = null;
  let sentCols = null;
  let sentRows = null;
  let userInputUntil = 0;
  let observerGeometry = '';
  let observerFont = null;
  let profileNote = null;
  let profileCapture = null;
  const pendingInput = [];

  const sendJson = (value) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
  };
  const setStatus = (value) => {
    if (statusState.textContent !== value) statusState.textContent = value;
  };
  const isVisible = () => {
    const bounds = wrapper.getClientRects()[0];
    return presented && wrapper.isConnected && Boolean(bounds?.width && bounds?.height);
  };
  const note = () => {
    const sized = Number.isInteger(paneState?.cols) && Number.isInteger(paneState?.rows);
    statusNote.textContent = profileNote || (!isPrimary && sized
      ? `viewing at ${paneState.cols}×${paneState.rows} · click to take control` : '');
  };
  const profiler = createTerminalProfiler({
    pane, terminal, wrapper,
    runtime: window.__TAURI__ ? 'desktop' : 'web',
    active: () => !disposed && !exited && !document.hidden && isVisible()
      && socket?.readyState === WebSocket.OPEN && replayDone,
    focused: () => document.hasFocus?.() !== false,
    capture: (value) => { profileCapture = value; },
    status: (value) => { profileNote = value; note(); },
  });
  const trackpadWheel = createTrackedPixelWheelHandler(terminal, {
    active: () => !disposed && !document.hidden && presented && isVisible()
      && socket?.readyState === WebSocket.OPEN && replayDone,
  });
  terminal.attachCustomWheelEventHandler(trackpadWheel.handle);
  const disposeWebgl = () => {
    webglContextLoss?.dispose();
    webglContextLoss = null;
    webglAddon?.dispose();
    webglAddon = null;
    observerGeometry = '';
  };
  const loadWebgl = () => {
    if (disposed || webglAddon || !isVisible()) return;
    let addon;
    try {
      addon = new window.WebglAddon.WebglAddon();
      terminal.loadAddon(addon);
      webglAddon = addon;
      observerGeometry = '';
      webglContextLoss = addon.onContextLoss(() => {
        if (webglAddon !== addon) return;
        disposeWebgl();
        if (!disposed && isVisible()) scaleObserver();
      });
    } catch { addon?.dispose(); }
  };
  const stopObserving = () => {
    if (!observing) return;
    observer.disconnect();
    observing = false;
  };
  const scaleObserver = () => {
    const element = terminal.element;
    if (!element) return;
    if (isPrimary) { terminal.options.fontSize = 12.5; return; }
    const screen = element.querySelector('.xterm-screen');
    const padding = getComputedStyle(host);
    const width = host.clientWidth - parseFloat(padding.paddingLeft || 0) - parseFloat(padding.paddingRight || 0);
    const height = host.clientHeight - parseFloat(padding.paddingTop || 0) - parseFloat(padding.paddingBottom || 0);
    if (!screen?.offsetWidth || !screen.offsetHeight || width <= 0 || height <= 0) return;
    const geometry = `${width}:${height}:${terminal.cols}:${terminal.rows}:${devicePixelRatio}:${terminal.options.fontFamily}:${terminal.options.lineHeight}:${terminal.options.letterSpacing}`;
    const currentBounds = screen.getBoundingClientRect();
    if (geometry === observerGeometry && terminal.options.fontSize === observerFont
        && currentBounds.width <= width && currentBounds.height <= height) return;
    // Xterm updates cell/screen dimensions synchronously on font changes. Search
    // the quarter-pixel sizes before the browser paints, instead of flashing a
    // full-size font and shrinking it over multiple 50ms timers. No CSS transform:
    // pointer coordinates continue to match xterm's actual rendered cell metrics.
    let low = 4; let high = 50; let best = 4;
    while (low <= high) {
      const candidate = Math.floor((low + high) / 2);
      terminal.options.fontSize = candidate / 4;
      const bounds = screen.getBoundingClientRect();
      if (bounds.width <= width && bounds.height <= height) {
        best = candidate;
        low = candidate + 1;
      } else high = candidate - 1;
    }
    observerFont = best / 4;
    terminal.options.fontSize = observerFont;
    observerGeometry = geometry;
  };
  const adoptPaneSize = () => {
    if (!replayDone || isPrimary || !Number.isInteger(paneState?.cols) || !Number.isInteger(paneState?.rows)) return;
    try {
      if (terminal.cols !== paneState.cols || terminal.rows !== paneState.rows) {
        terminal.resize(paneState.cols, paneState.rows);
      }
    } catch {}
    // Hidden observers still parse incoming cursor-addressed output. Their local
    // buffer must track host dimensions even though they cannot resize the PTY.
    if (isVisible()) scaleObserver();
  };
  const setPaneState = (next) => {
    if (!next || next.id !== pane) return;
    paneState = next;
    const primary = next.primary === viewer;
    if (primary) claimPending = false;
    const controlling = primary || claimPending;
    if (controlling !== isPrimary) {
      isPrimary = controlling;
      if (isPrimary) startObserving();
      else {
        clearTimeout(resizeTimer);
        startObserving();
      }
    }
    wrapper.classList.toggle('observer', !isPrimary);
    if (isPrimary) terminal.options.fontSize = 12.5;
    // A watching viewer must not look typeable: dim, non-blinking underline cursor.
    terminal.options.cursorBlink = isPrimary;
    terminal.options.cursorStyle = isPrimary ? 'block' : 'underline';
    terminal.options.cursorInactiveStyle = isPrimary ? 'outline' : 'underline';
    if (isPrimary && replayDone) fitAndResize();
    else adoptPaneSize();
    note();
  };
  const fitNow = (force = false) => {
    clearTimeout(resizeTimer);
    // Snapshot escape sequences address rows at the host's original dimensions.
    // Parsing them after a local resize clamps bottom rows onto the same line.
    if (!replayDone) return;
    if (disposed || !isVisible()) {
      stopObserving();
      disposeWebgl();
      return;
    }
    if (!isPrimary) {
      adoptPaneSize();
      return;
    }
    try {
      fit.fit();
      if (!exited && terminal.cols > 1 && terminal.rows > 1
          && (force || terminal.cols !== sentCols || terminal.rows !== sentRows)
          && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          t: force ? 'primary' : 'resize', cols: terminal.cols, rows: terminal.rows,
        }));
        sentCols = terminal.cols;
        sentRows = terminal.rows;
      }
    } catch {}
  };
  const fitAndResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitNow, 50);
  };
  const observer = new ResizeObserver(fitAndResize);
  const startObserving = () => {
    if (observing || disposed || !isVisible()) return;
    observer.observe(wrapper);
    observer.observe(host);
    observing = true;
  };
  const takeControl = () => {
    if (disposed || !isVisible() || exited || paneState?.primary === viewer || claimPending) return;
    claimPending = true;
    isPrimary = true;
    wrapper.classList.remove('observer');
    terminal.options.fontSize = 12.5;
    terminal.options.cursorBlink = true;
    terminal.options.cursorStyle = 'block';
    terminal.options.cursorInactiveStyle = 'outline';
    note();
    startObserving();
    if (replayDone) fitNow(true);
  };

  let reportedVisibility;
  const reportVisibility = (force = false) => {
    const visible = !document.hidden && isVisible();
    if (!disposed && socket?.readyState === WebSocket.OPEN && (force || visible !== reportedVisibility)) {
      socket.send(JSON.stringify({ t: 'visibility', visible }));
      reportedVisibility = visible;
    }
  };
  const connect = () => {
    if (disposed || exited || !retryable) return;
    trackpadWheel.cancel();
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const focused = (!connectedOnce && Boolean(options.focus)) || wrapper.contains(document.activeElement);
    // The upgrade query is the attach handshake. This mount's viewer id is stable
    // across host reconnects (and page reloads in the same tab); only focus sets primary=1.
    const query = new URLSearchParams({ viewer, primary: focused ? '1' : '0' });
    if (fullHistory) query.set('history', 'full');
    socket = new WebSocket(`${protocol}//${location.host}/ws/pane/${encodeURIComponent(pane)}?${query}`);
    const connection = socket;
    socket.binaryType = 'arraybuffer';
    setStatus(fullHistory ? 'loading history' : (connectedOnce ? 'reconnecting' : 'connecting'));
    replayDone = false;
    const flushInput = () => {
      if (!pendingInput.length || socket?.readyState !== WebSocket.OPEN || !replayDone) return;
      for (const chunk of pendingInput) {
        profileCapture?.inputSent(chunk, socket.bufferedAmount);
        socket.send(chunk);
      }
      pendingInput.length = 0;
    };
    const markHealthy = () => {
      retry = 0;
      setStatus('live');
      if (status.classList.contains('error')) status.classList.remove('error');
      flushInput();
    };
    socket.onopen = () => {
      if (disposed || socket !== connection) return;
      connectedOnce = true;
      sentCols = null;
      sentRows = null;
      if (claimPending && replayDone) fitNow(true);
    };
    socket.onmessage = (event) => {
      if (disposed || socket !== connection) return;
      if (typeof event.data !== 'string') {
        const bytes = new Uint8Array(event.data);
        const capture = profileCapture;
        if (capture) {
          const output = capture.outputReceived(bytes.byteLength);
          terminal.write(bytes, () => capture.outputParsed(output));
        } else terminal.write(bytes);
        if (replayDone) markHealthy();
        return;
      }
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.t === 'attached') {
        reportVisibility(true);
        // The bridge guarantees this precedes the serialized snapshot, so stale
        // local scrollback cannot be doubled when the host reconnects after reload.
        terminal.reset();
        moreHistory = message.history?.truncated === true;
        setPaneState(message.pane);
        if (Number.isInteger(message.pane?.cols) && Number.isInteger(message.pane?.rows)
            && (terminal.cols !== message.pane.cols || terminal.rows !== message.pane.rows)) {
          try { terminal.resize(message.pane.cols, message.pane.rows); } catch {}
        }
        if (claimPending || wrapper.contains(document.activeElement)) takeControl();
      } else if (message.t === 'replay-end') {
        // Receiving the last frame is not the same as xterm having parsed it:
        // write() is asynchronous. Drain its queue before resizing or typing.
        terminal.write('', () => {
          if (disposed || socket !== connection || (!exited && connection.readyState !== WebSocket.OPEN)) return;
          replayDone = true;
          historyButton.hidden = fullHistory || !moreHistory;
          if (isPrimary) fitNow(true);
          else adoptPaneSize();
          if (!exited) markHealthy();
        });
      } else if (message.t === 'pane') {
        setPaneState(message.pane);
      } else if (message.t === 'resize') {
        if (message.pane) setPaneState(message.pane);
        else if (message.applied === false && paneState) {
          setPaneState({ ...paneState, primary: message.primary });
        }
      }
      else if (message.t === 'exit') {
        exited = true;
        const detail = message.code == null ? (message.signal || '') : `code ${message.code}`;
        setStatus(`exited${detail ? ` (${detail})` : ''}`);
        status.classList.add('exited');
        if (!exitReported) {
          exitReported = true;
          options.onExit?.(pane);
        }
      } else if (message.t === 'error') {
        setStatus(message.message || 'terminal error');
        status.classList.add('error');
        if (message.fatal || /already attached|no such pane/i.test(message.message || '')) {
          retryable = false;
          if (message.fatal) setStatus(`${message.message || 'terminal host unavailable'} · ⌘R to retry`);
          socket.close();
        }
      }
    };
    socket.onclose = () => {
      if (disposed || socket !== connection || exited || !retryable) return;
      profiler.stop('error');
      setStatus('reconnecting');
      const delay = Math.min(8000, 250 * (2 ** retry++));
      retryTimer = setTimeout(connect, delay);
    };
    socket.onerror = () => {};
  };

  historyButton.addEventListener('click', (event) => {
    event.stopPropagation();
    if (disposed || fullHistory || !replayDone) return;
    fullHistory = true;
    historyButton.hidden = true;
    const previous = socket;
    // Exited panes remain attachable long enough to inspect their retained screen.
    // The second exit frame is presentation state, not a second lifecycle event.
    exited = false;
    connect();
    if (previous && previous.readyState < WebSocket.CLOSING) previous.close();
  });

  const sendUserBytes = (bytes) => {
    takeControl();
    if (socket?.readyState === WebSocket.OPEN && replayDone) {
      profileCapture?.inputSent(bytes, socket.bufferedAmount);
      socket.send(bytes);
    }
    else pendingInput.push(bytes);
  };
  const sendBytes = (bytes, { user }) => {
    if (user) return sendUserBytes(bytes);
    // Xterm answers terminal queries through onData; unmarked mouse motion can
    // arrive through either callback. Only the host-confirmed primary may reply.
    if (!isPrimary || claimPending || socket?.readyState !== WebSocket.OPEN || !replayDone) return;
    profileCapture?.inputSent(bytes, socket.bufferedAmount);
    socket.send(JSON.stringify({ t: 'reply', data: base64Bytes(bytes) }));
  };
  const sendInput = (data, options) => sendBytes(encoder.encode(data), options);
  terminal.onData((data) => sendInput(data, { user: performance.now() <= userInputUntil }));
  // Legacy mouse reports arrive through onBinary because their coordinate bytes
  // are not UTF-8. Preserve each byte when forwarding them to the PTY.
  terminal.onBinary((data) => sendBytes(
    Uint8Array.from(data, char => char.charCodeAt(0) & 0xff),
    { user: performance.now() <= userInputUntil },
  ));
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    trackpadWheel.cancel();
    userInputUntil = performance.now() + 50;
    // Shift+Enter (and Cmd+Enter) insert a newline in Claude Code and Codex: send
    // the Option+Enter sequence, since xterm would otherwise send a bare CR.
    if ((event.shiftKey || event.metaKey) && !event.ctrlKey && !event.altKey && event.key === 'Enter') {
      // Cancel the keydown's default or the browser also fires a keypress, which
      // xterm turns into a bare CR right after our ESC CR (newline, then submit).
      event.preventDefault();
      sendInput('\x1b\r', { user: true });
      return false;
    }
    if (event.metaKey && event.key.toLowerCase() === 'c') {
      if (terminal.hasSelection()) navigator.clipboard?.writeText(terminal.getSelection()).catch(() => {});
      return false;
    }
    if (event.metaKey && event.key.toLowerCase() === 'k') {
      terminal.clear();
      sendJson({ t: 'clear' });
      return false;
    }
    if (event.metaKey && event.key.toLowerCase() === 'f') {
      wrapper.classList.add('finding');
      wrapper.querySelector('.findbar input').focus();
      return false;
    }
    return true;
  });
  const markInsertedInput = (event) => {
    if (event.type !== 'input' || String(event.inputType || '').startsWith('insert')) {
      userInputUntil = performance.now() + 250;
    }
  };
  wrapper.addEventListener('paste', createImagePasteHandler({
    isDesktop: () => Boolean(window.__TAURI__),
    agent: () => paneState?.meta?.agent,
    active: () => !disposed && !exited && isVisible() && document.activeElement === terminal.textarea,
    ready: () => socket?.readyState === WebSocket.OPEN && replayDone,
    hasClipboardImage: () => window.__TAURI__.core.invoke('clipboard_has_image'),
    pasteImage: () => sendInput('\x16', { user: true }),
    report: (message) => { statusNote.textContent = message; },
  }), true);
  terminal.textarea?.addEventListener('paste', markInsertedInput, true);
  terminal.textarea?.addEventListener('compositionend', markInsertedInput, true);
  terminal.textarea?.addEventListener('input', markInsertedInput, true);
  // Mouse motion and focus reports bypass the wheel frame queue in xterm. Clear
  // delayed wheel reports in capture phase so they cannot overtake either one.
  for (const type of ['pointermove', 'mousemove', 'focus', 'blur']) {
    wrapper.addEventListener(type, () => trackpadWheel.cancel(), true);
  }
  // Pointer and focus reports are terminal input, so count them as typing before xterm handles them.
  for (const type of ['pointerdown', 'pointerup', 'wheel', 'focusin', 'focusout']) {
    wrapper.addEventListener(type, () => {
      if (type === 'pointerdown' || type === 'pointerup') trackpadWheel.cancel();
      userInputUntil = performance.now() + 250;
    }, true);
  }

  const findInput = wrapper.querySelector('.findbar input');
  const find = (previous = false) => {
    const value = findInput.value;
    if (!value) return;
    (previous ? search.findPrevious(value) : search.findNext(value));
  };
  findInput.addEventListener('input', () => find());
  findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { find(event.shiftKey); event.preventDefault(); }
    if (event.key === 'Escape') { wrapper.classList.remove('finding'); terminal.focus(); event.preventDefault(); }
  });
  wrapper.querySelector('[data-prev]').addEventListener('click', () => find(true));
  wrapper.querySelector('[data-next]').addEventListener('click', () => find(false));
  wrapper.querySelector('[data-close]').addEventListener('click', () => { wrapper.classList.remove('finding'); terminal.focus(); });
  wrapper.addEventListener('focusin', (event) => {
    if (!event.target.closest('.findbar, .term-history')) takeControl();
    options.onFocus?.(terminal, wrapper);
  });
  wrapper.addEventListener('mousedown', (event) => {
    if (!event.target.closest('.findbar, .term-history')) takeControl();
    options.onFocus?.(terminal, wrapper);
  });

  const show = (focus = false) => {
    presented = true;
    reportVisibility();
    showFocus = showFocus || focus;
    if (focus) {
      showFocusIntent = captureFocusIntent();
      showFocusContainer = wrapper.parentElement;
    }
    if (showFrame) return;
    showFrame = requestAnimationFrame(() => {
      showFrame = 0;
      const wanted = showFocus;
      showFocus = false;
      if (disposed || !isVisible()) return;
      startObserving();
      loadWebgl();
      fitNow();
      if (wanted && wrapper.parentElement === showFocusContainer
          && showFocusIntent?.()) terminal.focus();
    });
  };
  show(Boolean(options.focus));
  connect();

  return {
    element: wrapper,
    terminal,
    get socket() { return socket; },
    focus: () => { if (!disposed && isVisible()) terminal.focus(); },
    fit: fitNow,
    setTheme(theme) { terminal.options.theme = theme?.mode ? xtermTheme(theme.mode, theme.palette) : theme; },
    show,
    hide() {
      profiler.stop('hidden');
      presented = false;
      trackpadWheel.cancel();
      reportVisibility();
      showFocus = false;
      clearTimeout(resizeTimer);
      cancelAnimationFrame(showFrame);
      showFrame = 0;
      stopObserving();
      disposeWebgl();
    },
    syncVisibility() {
      if (document.hidden) profiler.stop('hidden');
      reportVisibility();
      if (isVisible()) show(false);
      else {
        stopObserving();
        disposeWebgl();
      }
    },
    dispose() {
      profiler.stop('disposed');
      disposed = true;
      trackpadWheel.cancel();
      clearTimeout(retryTimer);
      clearTimeout(resizeTimer);
      cancelAnimationFrame(showFrame);
      stopObserving();
      disposeWebgl();
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
      terminal.dispose();
    },
  };
}
