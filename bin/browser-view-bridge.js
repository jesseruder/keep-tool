'use strict';

// The console's end of a live browser view: /ws/browser/<pane>?session=<n>.
//
// One WebSocket is one view of one session's tabs, on the machine that runs the pane.
// It opens its own host connection (a stream of pictures has no business sharing a
// connection with a terminal), opens a `browser-view` there, and relays:
//
//   host -> console   text {t: 'open'|'tabs'|'started'|'state'|'error', ...}
//                     binary [u32 header length][header JSON][JPEG bytes] per frame
//   console -> host   text {t: 'start', tabId, width, height, pixelRatio, fit}
//                          {t: 'ack'} after a frame is drawn
//                          {t: 'input', input} / {t: 'nav', action} / {t: 'tabs'}
//
// A console that falls behind loses frames here (and the browser is told they were
// taken), never the connection: the next picture is the one worth showing.

const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { parsePaneRef } = require('./nodes.js');

const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const TABS_POLL_MS = 2000;
const OPEN_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;

function frameMessage(event) {
  const header = Buffer.from(JSON.stringify({
    seq: event.seq, tabId: event.tabId, metadata: event.metadata || {},
  }), 'utf8');
  const image = Buffer.from(String(event.data || ''), 'base64');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(header.length, 0);
  return Buffer.concat([length, header, image]);
}

function createBrowserViewBridge(options = {}) {
  if (typeof options.hostClient !== 'function') throw new Error('browser view bridge needs a host client');
  const tabsPollMs = options.tabsPollMs == null ? TABS_POLL_MS : options.tabsPollMs;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const live = new Set();

  const onConnection = async (ws, pane, session) => {
    const ref = parsePaneRef(String(pane));
    const view = `v${crypto.randomBytes(6).toString('hex')}`;
    let client = null;
    let closed = false;
    let pollTimer = null;
    let lastTabs = '';
    const sendText = (value) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(value));
      return true;
    };
    const request = (op, params = {}) => client.request('browser-view', { op, view, ...params }, { timeoutMs: REQUEST_TIMEOUT_MS });
    const shutdown = () => {
      if (closed) return;
      closed = true;
      live.delete(ws);
      if (pollTimer) clearInterval(pollTimer);
      if (client) {
        request('close').catch(() => {}).finally(() => { try { client.close(); } catch {} });
      }
    };
    const fail = (error) => {
      sendText({ t: 'error', fatal: true, message: String(error && error.message || error) });
      ws.close(1011, 'browser view error');
      shutdown();
    };
    ws.on('close', shutdown);
    ws.on('error', shutdown);

    const onEvent = (event) => {
      if (closed) return;
      if (event.event === 'viewer_frame') {
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          request('ack').catch(() => {});
          return;
        }
        ws.send(frameMessage(event), { binary: true });
        return;
      }
      if (event.event === 'viewer_state') {
        sendText({ t: 'state', state: event.state, reason: event.reason || null, tabId: event.tabId ?? null });
        if (event.state === 'closed') {
          ws.close(1011, 'browser view closed');
          shutdown();
        }
      }
    };

    const refreshTabs = async () => {
      if (closed) return;
      try {
        const { tabs } = await request('tabs');
        const text = JSON.stringify(tabs || []);
        if (text !== lastTabs) {
          lastTabs = text;
          sendText({ t: 'tabs', tabs: tabs || [] });
        }
      } catch (error) {
        sendText({ t: 'error', message: `could not list the tabs: ${error.message}` });
      }
    };

    try {
      client = await options.hostClient(ref.node || null);
      if (closed) { client.close(); return; }
      client.onBrowserEvent(view, onEvent);
      client.onDisconnect?.(() => fail(new Error('the connection to the machine running this session closed')));
      const opened = await client.request('browser-view', { op: 'open', view, session }, { timeoutMs: OPEN_TIMEOUT_MS });
      if (closed) return;
      sendText({ t: 'open', node: ref.node || null, session, extensionConnected: opened.extensionConnected === true });
      await refreshTabs();
      pollTimer = setInterval(refreshTabs, tabsPollMs);
      pollTimer.unref?.();
    } catch (error) {
      fail(error);
      return;
    }

    ws.on('message', (data, isBinary) => {
      if (closed || isBinary) return;
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      if (!message || typeof message !== 'object') return;
      const reportError = (error) => sendText({ t: 'error', message: String(error && error.message || error) });
      switch (message.t) {
        case 'ack':
          request('ack').catch(() => {});
          break;
        case 'start':
          request('start', {
            tabId: message.tabId,
            width: message.width,
            height: message.height,
            pixelRatio: message.pixelRatio,
            fit: message.fit !== false,
          }).then((result) => sendText({ t: 'started', tab: result && result.tab || null }), reportError);
          break;
        case 'input':
          request('input', { input: message.input || {} }).catch(reportError);
          break;
        case 'nav':
          request('navigate', { action: message.action }).catch(reportError);
          break;
        case 'tabs':
          lastTabs = '';
          refreshTabs();
          break;
        default:
          break;
      }
    });
  };

  return {
    handleUpgrade(req, socket, head, { pane, session }) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        live.add(ws);
        onConnection(ws, pane, session);
      });
    },
    close() {
      for (const ws of live) { try { ws.terminate(); } catch {} }
      live.clear();
      wss.close();
    },
  };
}

/** `/ws/browser/<pane>?session=<n>` -> {pane, session}, or null when it is not one. */
function parseBrowserViewUrl(url) {
  const match = url.pathname.match(/^\/ws\/browser\/([^/]+)$/);
  if (!match) return null;
  let pane;
  try { pane = decodeURIComponent(match[1]); } catch { pane = ''; }
  const number = String(url.searchParams.get('session') || '').replace(/^#/, '');
  if (!pane || !/^\d{1,9}$/.test(number)) return { error: 'bad request' };
  return { pane, session: `#${number}` };
}

module.exports = { createBrowserViewBridge, parseBrowserViewUrl, frameMessage };
