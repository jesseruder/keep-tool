'use strict';

// The terminal host's side of the console's browser view: one Browser Bridge viewer
// connection per open view, on the machine whose browser it is. The host runs this for
// the `browser-view` verb, beside its request queue, so a frame never waits behind a
// keystroke or a screen read.
//
// Frames come back as `{ev: 'browser', view, event}` host events. A connection that is
// behind drops frames here rather than letting the host's own slow-client guard drop the
// whole connection, and tells the browser the frame was taken so the stream goes on.

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const VIEWER_CLIENT = path.join(__dirname, '..', 'browser-bridge', 'host', 'viewer-client.js');
const MAX_VIEWS_PER_CONNECTION = 4;
const FRAME_BACKLOG_BYTES = 2 * 1024 * 1024;
const VIEW_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION = /^#\d{1,9}$/;

let viewerModule = null;
function loadViewerClient() {
  if (!viewerModule) viewerModule = import(pathToFileURL(VIEWER_CLIENT).href);
  return viewerModule;
}

function views(connection) {
  if (!connection.browserViews) connection.browserViews = new Map();
  return connection.browserViews;
}

function needView(connection, id) {
  const view = views(connection).get(String(id || ''));
  if (!view) throw new Error('no such browser view on this connection');
  return view;
}

/**
 * One `browser-view` request. `send(frame)` writes a host event to this connection,
 * `backlog()` says how much is queued on it. Resolves to the reply's result.
 */
async function handle(connection, request, { send, backlog, env = process.env, connectViewer } = {}) {
  const op = String(request.op || '');
  const id = String(request.view || '');
  if (!VIEW_ID.test(id)) throw new Error('view must be a short id');

  if (op === 'open') {
    const session = String(request.session || '');
    if (!SESSION.test(session)) throw new Error('session must look like #12');
    if (views(connection).has(id)) throw new Error('that view is already open');
    if (views(connection).size >= MAX_VIEWS_PER_CONNECTION) throw new Error('too many browser views on this connection');
    const connect = connectViewer || (await loadViewerClient()).connectViewer;
    const view = { id, session, client: null, closed: false };
    views(connection).set(id, view);
    try {
      view.client = await connect({
        env,
        name: `keep console ${session}`,
        onEvent: (event) => {
          if (view.closed) return;
          if (event.event === 'viewer_frame' && backlog() > FRAME_BACKLOG_BYTES) {
            view.client?.notify('viewer_ack', { viewer: id });
            return;
          }
          send({ ev: 'browser', view: id, event });
        },
        onClose: () => {
          if (view.closed) return;
          view.closed = true;
          views(connection).delete(id);
          send({ ev: 'browser', view: id, event: { event: 'viewer_state', state: 'closed' } });
        },
      });
    } catch (error) {
      views(connection).delete(id);
      throw error;
    }
    if (view.closed || connection.dropped || (connection.socket && connection.socket.destroyed)) {
      view.client.close();
      throw new Error('host connection closed');
    }
    return { open: true, extensionConnected: view.client.hostStatus?.extensionConnected === true };
  }

  const view = needView(connection, id);
  const { client, session } = view;
  switch (op) {
    case 'tabs':
      return client.request('viewer_tabs', { session });
    case 'start':
      return client.request('viewer_start', {
        viewer: id,
        session,
        tabId: Number(request.tabId),
        width: Number(request.width),
        height: Number(request.height),
        pixelRatio: Number(request.pixelRatio),
        quality: request.quality == null ? undefined : Number(request.quality),
        fit: request.fit !== false,
      });
    case 'ack':
      client.notify('viewer_ack', { viewer: id });
      return { ok: true };
    case 'input':
      return client.request('viewer_input', { viewer: id, input: request.input || {} });
    case 'navigate':
      return client.request('viewer_navigate', { viewer: id, action: String(request.action || '') });
    case 'close':
      closeView(connection, view);
      return { closed: true };
    default:
      throw new Error(`unknown browser-view op: ${op}`);
  }
}

function closeView(connection, view) {
  if (view.closed) return;
  view.closed = true;
  views(connection).delete(view.id);
  try { view.client?.notify('viewer_stop', { viewer: view.id, reason: 'closed' }); } catch {}
  try { view.client?.close(); } catch {}
}

/** The host connection went away: every view it carried goes with it. */
function closeAll(connection) {
  if (!connection.browserViews) return;
  for (const view of [...connection.browserViews.values()]) closeView(connection, view);
}

module.exports = { handle, closeAll, MAX_VIEWS_PER_CONNECTION };
