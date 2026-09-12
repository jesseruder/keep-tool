'use strict';

const { WebSocketServer, WebSocket } = require('ws');

const RECONNECT_WINDOW_MS = Number(process.env.KEEP_CONSOLE_RECONNECT_MS) || 60_000;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_REPLY_BYTES = 4 * 1024;

function createTerminalBridge(options = {}) {
  if (typeof options.hostClient !== 'function') throw new Error('terminal bridge needs a host client');
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  const onConnection = async (ws, pane, viewer, attachPrimary, snapshotScrollback) => {
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
      if (closed || state.closed || event?.ev !== 'pane' || event.pane?.id !== pane
          || !['resized', 'primary', 'title', 'meta', 'visibility'].includes(event.type)) return;
      const message = { t: 'pane', pane: event.pane };
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
          const client = await options.hostClient();
          if (!client) throw new Error('terminal host is unavailable');
          state = {
            client, attachment: null, subscription: null, closed: false,
            reconnecting: false, attached: false, pending: [],
          };
          replayEnded = false;
          if (replayTimer) clearTimeout(replayTimer);
          state.attachment = await client.attach(
            pane,
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
            pane: state.attachment.pane,
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
      pane, cols: message.cols, rows: message.rows, ...(force ? { force: true } : {}),
    }).then((result) => {
      sendText({
        t: 'resize', applied: result.applied !== false,
        primary: result.primary ?? result.pane?.primary ?? null, pane: result.pane,
      });
      return result;
    });
    ws.on('message', (data, binary) => {
      if (closed) return;
      let operation;
      if (binary) {
        operation = hostRequest('input', { pane, data: Buffer.from(data).toString('base64') });
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
          operation = hostRequest('visibility', { pane, visible: message.visible });
        } else if (message.t === 'clear') {
          operation = hostRequest('clear', { pane });
        } else if (message.t === 'reply') {
          if (typeof message.data !== 'string' || message.data.length % 4 !== 0
              || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)) return;
          const reply = Buffer.from(message.data, 'base64');
          if (reply.length > MAX_REPLY_BYTES) return;
          operation = hostRequest('input', { pane, data: message.data, auto: true });
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

module.exports = { createTerminalBridge };
