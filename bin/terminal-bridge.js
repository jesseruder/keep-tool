'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { parsePaneRef } = require('./nodes.js');

const RECONNECT_WINDOW_MS = Number(process.env.KEEP_CONSOLE_RECONNECT_MS) || 60_000;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_REPLY_BYTES = 4 * 1024;
// The attendance clear is best effort and off the keystroke's path: a short deadline
// per request, and one attempt per window when the host is not answering.
const ATTENDANCE_TIMEOUT_MS = 1000;
const ATTENDANCE_RETRY_MS = 5000;

// Keys that a person pressed, and that look exactly like the replies below: arrows,
// Home/End, Shift-Tab (CSI Z), the modified forms (`\x1b[1;5C`, and `\x1b[1;2P` for
// Shift-F1), the tilde keys (Delete, PgUp, F5…) and the SS3 forms an application-mode
// terminal sends instead.
//
// `\x1b[1;2R` — modified F3 — is byte-identical to a cursor-position report for row 1,
// column 2. Counting it as a key is the right way round: xterm's CPR answers reach Keep
// on the console's `auto` reply path, which never gets here, so a CSI R arriving as a
// binary frame is somebody's keyboard. The modifier parameter is bounded to the values
// xterm sends (2–16) so a row-1 report for any other column stays a reply.
const NAVIGATION_KEY = /\x1b\[[ABCDHFZ]|\x1b\[1;(?:[2-9]|1[0-6])[ABCDHFPQRS]|\x1b\[\d+(?:;\d+)?~|\x1bO[ABCDHFPQRS]/;

// What xterm.js emits on its own, with nobody at the keyboard: answers to the
// terminal's own queries (DECRPM `\x1b[?2026;2$y`, primary DA, cursor position),
// focus reports, mouse reports, colour and title replies. Matched structurally
// rather than by name so a reply Keep has never seen is still not a person.
const TERMINAL_REPLIES = [
  /\x1b\[M[\s\S]{3}/g,                  // X10 mouse: three arbitrary bytes, before the CSI rule
  /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g,     // CSI: DECRPM, DA, CPR, focus, SGR mouse, paste markers
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, // OSC: colour and title replies
  /\x1b[PX^_][\s\S]*?\x1b\\/g,          // DCS, SOS, PM, APC
  /\x1bO./g,                            // SS3
];

function containsKeystroke(data) {
  if (!data || !data.length) return false;
  // latin1 keeps one byte to one character, so a mouse report's high bytes stay the
  // three characters the X10 rule above expects.
  const text = Buffer.from(data).toString('latin1');
  if (NAVIGATION_KEY.test(text)) return true;
  let rest = text;
  for (const pattern of TERMINAL_REPLIES) rest = rest.replace(pattern, '');
  return rest.length > 0;
}

function createTerminalBridge(options = {}) {
  if (typeof options.hostClient !== 'function') throw new Error('terminal bridge needs a host client');
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const attendanceRetryMs = Number.isFinite(Number(options.attendanceRetryMs))
    ? Math.max(0, Number(options.attendanceRetryMs)) : ATTENDANCE_RETRY_MS;

  const onConnection = async (ws, pane, viewer, attachPrimary, snapshotScrollback) => {
    // The viewer asked for a pane by its fleet-wide name. The host that owns it knows
    // it by the bare id alone, so the qualifier is stripped on the way in and put
    // back on everything that goes out: the console holds one id for one pane.
    const ref = parsePaneRef(String(pane), { nodes: options.nodes });
    const hostPane = ref.paneId;
    const qualify = (value) => (ref.qualified && value && typeof value === 'object' && value.id === hostPane
      ? { ...value, id: pane } : value);
    let closed = false;
    let replayEnded = false;
    let replayTimer;
    let current = null;
    let connecting = null;
    const sendText = (value) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(value));
      return true;
    };
    const fail = (error) => {
      if (closed) return;
      sendText({ t: 'error', message: String(error && error.message || error) });
      ws.close(1011, 'pane bridge error');
    };
    const endReplay = () => {
      if (replayEnded || closed) return;
      replayEnded = true;
      if (replayTimer) clearTimeout(replayTimer);
      sendText({ t: 'replay-end' });
    };
    const forwardNow = (data, meta = {}) => {
      if (closed) return;
      if (!meta.replay) endReplay();
      else {
        if (replayTimer) clearTimeout(replayTimer);
        replayTimer = setTimeout(endReplay, 15);
      }
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        sendText({ t: 'error', message: 'terminal viewer fell behind' });
        ws.close(1013, 'viewer fell behind');
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
    };
    const forward = (state, data, meta = {}) => {
      if (closed || state.closed) return;
      if (!state.attached) {
        state.pending.push({ data, meta });
        return;
      }
      forwardNow(data, meta);
    };
    const forwardPane = (state, event) => {
      if (closed || state.closed || event?.ev !== 'pane' || event.pane?.id !== hostPane
          || !['resized', 'primary', 'title', 'meta', 'visibility'].includes(event.type)) return;
      const message = { t: 'pane', pane: qualify(event.pane) };
      if (!state.attached) state.pending.push({ message });
      else sendText(message);
    };
    const closeHost = (state, detach = false) => {
      if (!state || state.closed) return;
      state.closed = true;
      state.subscription?.unsubscribe();
      if (detach && state.attachment) Promise.resolve(state.attachment.detach()).catch(() => {});
      try { state.client.close(); } catch {}
    };
    const reconnect = (state) => {
      if (closed || state.reconnecting) return;
      state.reconnecting = true;
      if (current === state) current = null;
      closeHost(state);
      ensureConnected().catch(fail);
    };
    const exited = (state, codeOrInfo, signal) => {
      const info = codeOrInfo && typeof codeOrInfo === 'object'
        ? codeOrInfo : { code: codeOrInfo, signal };
      const code = info.code ?? info.exitCode ?? null;
      if (info.reload || info.disconnected || (code == null && info.signal == null)) {
        reconnect(state);
        return;
      }
      endReplay();
      sendText({ t: 'exit', code, signal: info.signal ?? null });
      ws.close(1000, 'pane exited');
    };
    const connectLoop = async () => {
      let delayMs = 25;
      const deadline = Date.now() + RECONNECT_WINDOW_MS;
      while (!closed) {
        let state;
        try {
          const client = await options.hostClient(ref.node);
          if (!client) throw new Error('terminal host is unavailable');
          state = {
            client, attachment: null, subscription: null, closed: false,
            reconnecting: false, attached: false, pending: [],
          };
          replayEnded = false;
          if (replayTimer) clearTimeout(replayTimer);
          state.attachment = await client.attach(
            hostPane,
            {
              snapshot: true, replay: false, viewer, primary: attachPrimary,
              ...(snapshotScrollback == null ? {} : { snapshotScrollback }),
            },
            (data, meta) => forward(state, data, meta),
            (codeOrInfo, signal) => exited(state, codeOrInfo, signal),
          );
          state.subscription = await client.subscribe((event) => {
            if (event?.ev === 'reload' || event?.disconnected) reconnect(state);
            else forwardPane(state, event);
          });
          if (closed || state.reconnecting) {
            closeHost(state, true);
            if (closed) return null;
            continue;
          }
          current = state;
          sendText({
            t: 'attached',
            pane: qualify(state.attachment.pane),
            ...(state.attachment.history ? { history: state.attachment.history } : {}),
          });
          state.attached = true;
          for (const pending of state.pending) {
            if (pending.message) sendText(pending.message);
            else forwardNow(pending.data, pending.meta);
          }
          state.pending.length = 0;
          replayTimer = setTimeout(endReplay, 15);
          return state;
        } catch (error) {
          closeHost(state);
          if (closed) return null;
          if (/no such pane|pane has exited/i.test(String(error && error.message || error))) {
            fail(error);
            return null;
          }
          if (Date.now() > deadline) {
            sendText({ t: 'error', fatal: true, message: `terminal host unavailable for ${Math.round(RECONNECT_WINDOW_MS / 1000)}s: ${error && error.message || error}` });
            ws.close(1011, 'terminal host unavailable');
            return null;
          }
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          delayMs = Math.min(500, delayMs * 2);
        }
      }
      return null;
    };
    function ensureConnected() {
      if (current && !current.closed) return Promise.resolve(current);
      if (!connecting) connecting = connectLoop().finally(() => { connecting = null; });
      return connecting;
    }
    const hostRequest = async (type, params) => {
      let state = await ensureConnected();
      if (!state) throw new Error('pane bridge closed');
      try { return await state.client.request(type, params); }
      catch (error) {
        reconnect(state);
        state = await ensureConnected();
        if (!state) throw error;
        return state.client.request(type, params);
      }
    };
    const validSize = (message) => Number.isInteger(message.cols) && message.cols >= 2 && message.cols <= 500
      && Number.isInteger(message.rows) && message.rows >= 2 && message.rows <= 300;
    const resize = (message, force = false) => hostRequest('resize', {
      pane: hostPane, cols: message.cols, rows: message.rows, ...(force ? { force: true } : {}),
    }).then((result) => {
      sendText({
        t: 'resize', applied: result.applied !== false,
        primary: result.primary ?? result.pane?.primary ?? null, pane: qualify(result.pane),
      });
      return result;
    });
    // A person typing into the console is the one thing that proves somebody is
    // reading this pane. Two rules keep this off the keystroke's own path: it runs on
    // a host client of its own — the relay's `hostRequest` reconnects on error, which
    // closes the shared client and rejects the input still in flight on it — and
    // nothing here is latched until it actually succeeded, so a host that was down
    // when the first key landed is asked again by a later one.
    let attended = false;
    let attending = null;
    let attemptedAt = 0;
    const markAttended = async () => {
      let client = null;
      try {
        client = await options.hostClient(ref.node);
        if (!client) return false;
        const current = await client.request('get', { pane: hostPane }, { timeoutMs: ATTENDANCE_TIMEOUT_MS });
        // Already attended, or never marked: there is nothing left to clear.
        if (current?.pane?.meta?.unattended !== true) return true;
        await client.request('meta', {
          pane: hostPane,
          patch: { unattended: false, attendedAt: Date.now(), attendedBy: 'console' },
        }, { timeoutMs: ATTENDANCE_TIMEOUT_MS });
        return true;
      } catch { return false; }
      finally { if (client) { try { client.close(); } catch {} } }
    };
    const noteAttended = (data) => {
      if (attended || attending || !containsKeystroke(data)) return;
      const now = Date.now();
      // A down host is retried on a later keystroke, not hammered on every one.
      if (attemptedAt && now - attemptedAt < attendanceRetryMs) return;
      attemptedAt = now;
      const attempt = markAttended();
      attending = attempt;
      const settle = (ok) => {
        if (attending !== attempt) return;
        attending = null;
        if (ok === true) attended = true;
      };
      attempt.then(settle, () => settle(false));
      // A factory that never settles must not block every later attempt either.
      setTimeout(() => settle(false), attendanceRetryMs).unref?.();
    };
    ws.on('message', (data, binary) => {
      if (closed) return;
      let operation;
      if (binary) {
        operation = hostRequest('input', { pane: hostPane, data: Buffer.from(data).toString('base64') });
        noteAttended(data);
      } else {
        let message;
        try { message = JSON.parse(data.toString('utf8')); }
        catch { fail(new Error('invalid WebSocket message')); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.t !== 'string') return;
        if (message.t === 'resize') {
          if (!validSize(message)) return;
          operation = resize(message);
        } else if (message.t === 'primary') {
          if (!validSize(message)) return;
          operation = resize(message, true);
        } else if (message.t === 'visibility') {
          if (typeof message.visible !== 'boolean') return;
          operation = hostRequest('visibility', { pane: hostPane, visible: message.visible });
        } else if (message.t === 'clear') {
          operation = hostRequest('clear', { pane: hostPane });
        } else if (message.t === 'reply') {
          if (typeof message.data !== 'string' || message.data.length % 4 !== 0
              || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)) return;
          const reply = Buffer.from(message.data, 'base64');
          if (reply.length > MAX_REPLY_BYTES) return;
          operation = hostRequest('input', { pane: hostPane, data: message.data, auto: true });
        } else {
          fail(new Error('unknown WebSocket message'));
          return;
        }
      }
      Promise.resolve(operation).catch(fail);
    });
    ws.on('close', () => {
      closed = true;
      if (replayTimer) clearTimeout(replayTimer);
      closeHost(current, true);
      current = null;
    });
    ws.on('error', () => {});

    ensureConnected().catch(fail);
  };

  return {
    handleUpgrade(req, socket, head, connection) {
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(
        ws, connection.pane, connection.viewer, connection.primary, connection.snapshotScrollback,
      ));
    },
    close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

module.exports = { createTerminalBridge, containsKeystroke };
