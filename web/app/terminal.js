import { getPalette, resolvedTheme, xtermTheme } from './theme.js';

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
  wrapper.innerHTML = `<div class="findbar"><input aria-label="find in terminal" placeholder="Find"><button data-prev>↑</button><button data-next>↓</button><button data-close>✕</button></div><div class="xterm-host"></div><div class="term-status"><span class="term-state">connecting</span><span class="term-note"></span></div>`;
  container.replaceChildren(wrapper);

  const status = wrapper.querySelector('.term-status');
  const statusState = wrapper.querySelector('.term-state');
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
  let retry = 0;
  let retryTimer;
  let resizeTimer;
  let showFrame = 0;
  let showFocus = false;
  let showFocusOrigin = null;
  let showFocusContainer = null;
  let observing = false;
  let connectedOnce = false;
  let retryable = true;
  let replayDone = false;
  let isPrimary = false;
  let claimPending = false;
  let paneState = null;
  let sentCols = null;
  let sentRows = null;
  let userInputUntil = 0;
  let observerGeometry = '';
  const pendingInput = [];

  const sendJson = (value) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
  };
  const setStatus = (value) => { statusState.textContent = value; };
  const isVisible = () => {
    const bounds = wrapper.getClientRects()[0];
    return wrapper.isConnected && Boolean(bounds?.width && bounds?.height);
  };
  const disposeWebgl = () => {
    webglContextLoss?.dispose();
    webglContextLoss = null;
    webglAddon?.dispose();
    webglAddon = null;
  };
  const loadWebgl = () => {
    if (disposed || webglAddon || !isVisible()) return;
    let addon;
    try {
      addon = new window.WebglAddon.WebglAddon();
      terminal.loadAddon(addon);
      webglAddon = addon;
      webglContextLoss = addon.onContextLoss(() => {
        if (webglAddon !== addon) return;
        disposeWebgl();
      });
    } catch { addon?.dispose(); }
  };
  const stopObserving = () => {
    if (!observing) return;
    observer.disconnect();
    observing = false;
  };
  const note = () => {
    const sized = Number.isInteger(paneState?.cols) && Number.isInteger(paneState?.rows);
    statusNote.textContent = !isPrimary && sized
      ? `viewing at ${paneState.cols}×${paneState.rows} · click to take control` : '';
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
    const geometry = `${width}:${height}:${terminal.cols}:${terminal.rows}`;
    if (geometry !== observerGeometry) {
      observerGeometry = geometry;
      if (terminal.options.fontSize !== 12.5) {
        terminal.options.fontSize = 12.5;
        fitAndResize();
        return;
      }
    }
    // Shrink monotonically until it fits. Growing into the rounding slack can
    // oscillate forever between adjacent fonts with different rounded cell heights.
    const scale = Math.min(1, width / screen.offsetWidth, height / screen.offsetHeight);
    // Use xterm's own cell metrics, not CSS transforms: its pointer coordinates
    // must agree with rendered cells when selecting/copying observer output.
    const fontSize = Math.max(1, Math.min(12.5, Math.floor(terminal.options.fontSize * scale * 4) / 4));
    if (fontSize !== terminal.options.fontSize) {
      terminal.options.fontSize = fontSize;
      fitAndResize(); // settle rounded cell measurements after xterm's render
    }
  };
  const adoptPaneSize = () => {
    if (!replayDone || isPrimary || !Number.isInteger(paneState?.cols) || !Number.isInteger(paneState?.rows)) return;
    try {
      if (terminal.cols !== paneState.cols || terminal.rows !== paneState.rows) {
        terminal.resize(paneState.cols, paneState.rows);
      }
    } catch {}
    scaleObserver();
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
    if (disposed || exited || paneState?.primary === viewer || claimPending) return;
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

  const connect = () => {
    if (disposed || exited || !retryable) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const focused = (!connectedOnce && Boolean(options.focus)) || wrapper.contains(document.activeElement);
    // The upgrade query is the attach handshake. This mount's viewer id is stable
    // across host reconnects (and page reloads in the same tab); only focus sets primary=1.
    const query = new URLSearchParams({ viewer, primary: focused ? '1' : '0' });
    socket = new WebSocket(`${protocol}//${location.host}/ws/pane/${encodeURIComponent(pane)}?${query}`);
    const connection = socket;
    socket.binaryType = 'arraybuffer';
    setStatus(connectedOnce ? 'reconnecting' : 'connecting');
    replayDone = false;
    const flushInput = () => {
      if (socket?.readyState !== WebSocket.OPEN || !replayDone) return;
      for (const chunk of pendingInput) socket.send(chunk);
      pendingInput.length = 0;
    };
    const markHealthy = () => {
      retry = 0;
      setStatus('live');
      status.classList.remove('error');
      flushInput();
    };
    socket.onopen = () => {
      connectedOnce = true;
      sentCols = null;
      sentRows = null;
      if (claimPending && replayDone) fitNow(true);
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        terminal.write(new Uint8Array(event.data));
        if (replayDone) markHealthy();
        return;
      }
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.t === 'attached') {
        // The bridge guarantees this precedes the serialized snapshot, so stale
        // local scrollback cannot be doubled when the host reconnects after reload.
        terminal.reset();
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
        options.onExit?.(pane);
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
      if (disposed || exited || !retryable) return;
      setStatus('reconnecting');
      const delay = Math.min(8000, 250 * (2 ** retry++));
      retryTimer = setTimeout(connect, delay);
    };
    socket.onerror = () => {};
  };

  const sendInput = (data, { user }) => {
    const bytes = encoder.encode(data);
    if (user) {
      takeControl();
      if (socket?.readyState === WebSocket.OPEN && replayDone) socket.send(bytes);
      else pendingInput.push(bytes);
      return;
    }
    // xterm answers CSI 6n, OSC 11, and CSI ?u queries through onData. Only the
    // host-confirmed primary may answer, or observers produce duplicate replies.
    if (!isPrimary || claimPending || socket?.readyState !== WebSocket.OPEN || !replayDone) return;
    socket.send(JSON.stringify({ t: 'reply', data: base64Bytes(bytes) }));
  };
  terminal.onData((data) => sendInput(data, { user: performance.now() <= userInputUntil }));
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
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
  terminal.textarea?.addEventListener('paste', markInsertedInput, true);
  terminal.textarea?.addEventListener('compositionend', markInsertedInput, true);
  terminal.textarea?.addEventListener('input', markInsertedInput, true);
  // Pointer and focus reports are terminal input, so count them as typing before xterm handles them.
  for (const type of ['pointerdown', 'pointerup', 'wheel', 'focusin', 'focusout']) {
    wrapper.addEventListener(type, () => { userInputUntil = performance.now() + 250; }, true);
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
    if (!event.target.closest('.findbar')) takeControl();
    options.onFocus?.(terminal, wrapper);
  });
  wrapper.addEventListener('mousedown', (event) => {
    if (!event.target.closest('.findbar')) takeControl();
    options.onFocus?.(terminal, wrapper);
  });

  const show = (focus = false) => {
    showFocus = showFocus || focus;
    if (focus) {
      showFocusOrigin = document.activeElement;
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
          && (document.activeElement === showFocusOrigin || document.activeElement === document.body)) terminal.focus();
    });
  };
  show(Boolean(options.focus));
  connect();

  return {
    element: wrapper,
    terminal,
    get socket() { return socket; },
    focus: () => terminal.focus(),
    fit: fitNow,
    setTheme(theme) { terminal.options.theme = theme?.mode ? xtermTheme(theme.mode, theme.palette) : theme; },
    show,
    hide() {
      showFocus = false;
      stopObserving();
      disposeWebgl();
    },
    syncVisibility() {
      if (isVisible()) show(false);
      else {
        stopObserving();
        disposeWebgl();
      }
    },
    dispose() {
      disposed = true;
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
