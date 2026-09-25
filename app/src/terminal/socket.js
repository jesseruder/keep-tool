'use strict';

// The phone's half of the pane relay, as an observer only. The desktop console owns
// the pane geometry and the primary claim (`web/app/terminal.js`); this client never
// sends `resize` or `primary`, so attaching from the phone cannot reflow a session
// somebody is typing into on the Mac. What it does send is `visibility`, which is how
// the host knows a viewer is actually looking.
//
// The handshake, in order: the upgrade carries `x-keep-token` and no Origin (the
// daemon accepts that pairing), then the server sends `{t:'attached', pane}`, a
// serialized replay of the screen, `{t:'replay-end'}`, and from there raw terminal
// bytes plus pane-state JSON.

const DEFAULT_MAX_BACKOFF_MS = 8000;
const DEFAULT_BASE_BACKOFF_MS = 250;
// A socket can sit in CONNECTING forever behind a silent network, and a socket that
// opens is not yet a socket that attached. Neither state ever closes on its own, so
// without a deadline the client waits out the trip instead of retrying.
const DEFAULT_ATTACH_TIMEOUT_MS = 15000;

// A frame is JSON only when it is a text frame carrying an object with a `t` tag;
// anything else textual is replay/terminal output that must reach the parser
// unchanged, and binary frames always are. Keeping this pure is what lets the fixture
// exercise it off-device.
function classifyFrame(data) {
  if (typeof data === 'string') {
    if (data.length === 0 || data.charCodeAt(0) !== 0x7b /* { */) return 'text';
    let parsed;
    try { parsed = JSON.parse(data); } catch { return 'text'; }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.t !== 'string') return 'text';
    return 'json';
  }
  return 'binary';
}

function parseFrame(data) {
  const kind = classifyFrame(data);
  if (kind !== 'json') return null;
  try { return JSON.parse(data); } catch { return null; }
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
  return data;
}

function paneSocketUrl(server, pane, viewer, options = {}) {
  const base = String(server || '').replace(/\/+$/, '');
  const scheme = base.startsWith('https://') ? 'wss://' : 'ws://';
  const host = base.replace(/^https?:\/\//, '');
  // primary=0 is not a default worth relying on: say it, so a server-side change of
  // mind about the default cannot hand the phone a pane it should not steer.
  // `history=full` is how the console loads earlier output (web/app/terminal.js): the
  // attach snapshot carries the pane's whole scrollback instead of the last hundred
  // lines, so the replay itself is the history and nothing has to be stitched on.
  return `${scheme}${host}/ws/pane/${encodeURIComponent(pane)}`
    + `?viewer=${encodeURIComponent(viewer)}&primary=0`
    + (options.history === 'full' ? '&history=full' : '');
}

function loadAppState() {
  try { return require('react-native').AppState; } catch { return null; }
}

function openPaneSocket(options = {}) {
  const {
    server, token, pane, viewer,
    onAttached, onReplay, onReplayEnd, onData, onPaneState, onClose, onStatus,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
    attachTimeoutMs = DEFAULT_ATTACH_TIMEOUT_MS,
    // Receiving `replay-end` is not the same as the parser having applied the replay.
    // The consumer supplies its emulator's drain so the screen is current before this
    // client calls the replay done and lets input through — the desktop console does
    // the same with `terminal.write('', cb)`.
    drain,
  } = options;
  const Socket = options.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  if (!Socket) throw new Error('no WebSocket implementation available');
  if (!server || !pane || !viewer) throw new Error('openPaneSocket needs a server, a pane and a viewer id');

  const appState = options.appState === undefined ? loadAppState() : options.appState;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;

  let socket = null;
  let closed = false;
  let retry = 0;
  let retryTimer = null;
  // Two flags, not one. `replayEnded` says the replay frames are all in hand, which
  // is the moment live output starts; `replayDone` says the parser has caught up,
  // which is when input may be sent. They are not the same instant, and a frame that
  // arrives in between is live output — routing it through the replay path would
  // hand it to a consumer that is not tracking what it changed.
  let replayEnded = false;
  let replayDone = false;
  let reportedVisible;
  let subscription = null;
  let attachTimer = null;
  let history = options.history === 'full' ? 'full' : null;
  const pendingInput = [];

  const status = (state, detail) => { try { onStatus && onStatus(state, detail); } catch {} };

  const sendJson = (message) => {
    if (!socket || socket.readyState !== 1) return false;
    try { socket.send(JSON.stringify(message)); return true; } catch { return false; }
  };

  const reportVisibility = (visible, force) => {
    if (!force && visible === reportedVisible) return;
    if (sendJson({ t: 'visibility', visible })) reportedVisible = visible;
  };

  const clearAttachTimer = () => {
    if (attachTimer === null) return;
    clearTimer(attachTimer);
    attachTimer = null;
  };

  const scheduleRetry = (reason) => {
    if (closed) return;
    status('reconnecting', reason);
    const delay = Math.min(maxBackoffMs, baseBackoffMs * (2 ** retry++));
    retryTimer = setTimer(connect, delay);
  };

  const connect = () => {
    if (closed) return;
    replayEnded = false;
    replayDone = false;
    clearAttachTimer();
    status(retry === 0 ? 'connecting' : 'reconnecting');
    const connection = new Socket(paneSocketUrl(server, pane, viewer, { history }), [], {
      headers: { 'x-keep-token': token },
    });
    socket = connection;
    try { connection.binaryType = 'arraybuffer'; } catch {}

    // One deadline covers both halves of the handshake, because from here they fail
    // the same way: nothing arrives and nothing closes.
    attachTimer = setTimer(() => {
      attachTimer = null;
      if (socket !== connection || closed) return;
      socket = null;
      try { connection.close(); } catch {}
      scheduleRetry('the pane did not attach');
    }, attachTimeoutMs);

    connection.onopen = () => {
      if (socket !== connection) return;
      reportedVisible = undefined;
      // The host tracks visible viewers separately from attached ones; a phone that
      // never says so counts as attached-but-hidden.
      reportVisibility(currentlyVisible(), true);
    };

    connection.onmessage = (event) => {
      if (socket !== connection) return;
      const kind = classifyFrame(event.data);
      if (kind === 'binary' || kind === 'text') {
        const data = kind === 'binary' ? toBytes(event.data) : event.data;
        if (replayEnded) {
          onData && onData(data);
          markHealthy();
        } else {
          onReplay && onReplay(data);
        }
        return;
      }
      const message = parseFrame(event.data);
      if (!message) return;
      if (message.t === 'attached') {
        clearAttachTimer();
        replayEnded = false;
        replayDone = false;
        reportVisibility(currentlyVisible(), true);
        onAttached && onAttached(message);
      } else if (message.t === 'replay-end') {
        // From this frame on everything is live output, even though the parser has
        // not finished the replay: the drain below only covers writes queued before
        // it, so anything routed to onReplay after this point would be parsed after
        // the consumer had already repainted and would sit on screen unseen until
        // the next byte arrived — which, on a waiting agent, is never.
        replayEnded = true;
        whenDrained(() => {
          if (socket !== connection || closed) return;
          replayDone = true;
          markHealthy();
          flushInput();
          onReplayEnd && onReplayEnd(message);
        });
      } else if (message.t === 'pane' || message.t === 'resize') {
        if (message.pane) onPaneState && onPaneState(message.pane, message);
      } else if (message.t === 'exit' || message.t === 'error') {
        onPaneState && onPaneState(null, message);
        if (message.t === 'error' && (message.fatal || /already attached|no such pane/i.test(message.message || ''))) {
          close(message.message || 'terminal error');
        }
      }
    };

    connection.onerror = () => {};
    connection.onclose = (event) => {
      if (socket !== connection) return;
      socket = null;
      clearAttachTimer();
      scheduleRetry(event && event.reason);
    };
  };

  // `drain` may answer with a promise or through the callback; either way the
  // continuation runs once.
  const whenDrained = (done) => {
    if (typeof drain !== 'function') { done(); return; }
    let ran = false;
    const once = () => { if (ran) return; ran = true; done(); };
    let result;
    try { result = drain(once); } catch { once(); return; }
    if (result && typeof result.then === 'function') result.then(once, once);
    else if (drain.length === 0) once();
  };

  const flushInput = () => {
    if (!pendingInput.length) return;
    const queued = pendingInput.splice(0);
    for (const bytes of queued) {
      if (!socket || socket.readyState !== 1) return;
      try { socket.send(bytes); } catch { return; }
    }
  };

  const markHealthy = () => {
    if (retry === 0) return;
    retry = 0;
    status('live');
  };

  let visible = true;
  const currentlyVisible = () => visible;

  if (appState && typeof appState.addEventListener === 'function') {
    subscription = appState.addEventListener('change', (next) => {
      visible = next === 'active';
      reportVisibility(visible, false);
    });
    if (typeof appState.currentState === 'string') visible = appState.currentState === 'active';
  }

  function close(reason) {
    if (closed) return;
    closed = true;
    pendingInput.length = 0;
    clearAttachTimer();
    if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
    if (subscription && typeof subscription.remove === 'function') { try { subscription.remove(); } catch {} }
    subscription = null;
    const connection = socket;
    socket = null;
    if (connection) { try { connection.close(); } catch {} }
    status('closed', reason);
    try { onClose && onClose(reason); } catch {}
  }

  connect();

  return {
    // Raw bytes for keystrokes, exactly as the console sends them; a JSON `reply`
    // frame is how the console answers the terminal's own queries, and an observer
    // has no business doing that, so it is not offered here. The keyboard hands over
    // strings, and a string goes out as a text frame, which the bridge reads as a
    // control message and refuses (closing the socket); keystrokes have to be a
    // binary frame, so they are encoded here.
    sendInput(input) {
      if (closed) return false;
      const bytes = inputBytes(input);
      if (!bytes.length) return false;
      // Typing before the replay has been parsed would land the keystroke in a screen
      // the emulator has not caught up to, so it waits with the rest of the handshake.
      if (!socket || socket.readyState !== 1 || !replayDone) {
        pendingInput.push(bytes);
        return false;
      }
      try { socket.send(bytes); return true; } catch { return false; }
    },
    // "Load earlier output": reattach asking for the pane's whole scrollback, which
    // arrives as an ordinary replay (prefixed with a reset, so the consumer's
    // emulator cannot end up holding the old screen twice). Every later reconnect
    // keeps asking for it, the way the console's own history button does.
    loadFullHistory() {
      if (closed || history === 'full') return false;
      history = 'full';
      if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
      const previous = socket;
      socket = null;
      clearAttachTimer();
      if (previous) { try { previous.close(); } catch {} }
      connect();
      return true;
    },
    isFullHistory() { return history === 'full'; },
    setVisible(next) {
      visible = Boolean(next);
      reportVisibility(visible, false);
    },
    isReplayDone() { return replayDone; },
    isClosed() { return closed; },
    close,
  };
}

// UTF-8 bytes for a keystroke: strings are encoded (TextEncoder where the runtime has
// it, a small encoder otherwise), byte arrays pass through.
function utf8(text) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  const out = [];
  for (const char of text) {
    let code = char.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return new Uint8Array(out);
}

function inputBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (typeof input === 'string') return utf8(input);
  return toBytes(input);
}

module.exports = { openPaneSocket, classifyFrame, parseFrame, paneSocketUrl, toBytes, inputBytes };
