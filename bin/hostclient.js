'use strict';

const net = require('node:net');
const path = require('node:path');
const {
  FrameDecoder, encodeFrame, parseListenAddress, readNodeToken, PROTOCOL_VERSION,
} = require('./host.js');
const { annotate } = require('./pressure.js');

// An explicit socket is answered before keep.js is required at all: a host runs
// on a machine that may have no configuration and no registry to read, and
// requiring keep.js is what boots both.
function socketPath() {
  if (process.env.KEEP_HOST_SOCK) return process.env.KEEP_HOST_SOCK;
  return path.join(require('./keep.js').ROOT, '.keep', 'host.sock');
}

function connectEndpoint(options = {}) {
  const tcp = options.tcp || null;
  const sock = tcp ? `${tcp.host}:${tcp.port}` : (options.sock || socketPath());
  const connectTimeoutMs = options.timeoutMs == null ? 3000 : Math.max(0, Number(options.timeoutMs) || 0);
  return new Promise((resolve, reject) => {
    const socket = tcp ? net.createConnection({ host: tcp.host, port: tcp.port }) : net.createConnection(sock);
    if (tcp && typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
    const pending = new Map();
    const attachments = new Map();
    const subscribers = new Set();
    const disconnectListeners = new Set();
    const browserViews = new Map(); // view id -> event listener
    let nextId = 1;
    let connected = false;
    let closed = false;
    let intentionalClose = false;
    let disconnected = false;
    let connectTimer;

    const clearConnectTimer = () => {
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = null;
    };

    const rejectPending = (error) => {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    };

    const notifyDisconnected = () => {
      if (intentionalClose || disconnected) return;
      disconnected = true;
      closed = true;
      const info = { disconnected: true };
      for (const listener of attachments.values()) {
        try { if (listener.onExit) listener.onExit(info); } catch {}
      }
      for (const listener of subscribers) {
        try { listener({ ev: 'disconnect', disconnected: true }); } catch {}
      }
      for (const listener of disconnectListeners) {
        try { listener(info); } catch {}
      }
      for (const listener of browserViews.values()) {
        try { listener({ event: 'viewer_state', state: 'closed', reason: 'the host connection closed' }); } catch {}
      }
      browserViews.clear();
      attachments.clear();
      subscribers.clear();
      disconnectListeners.clear();
    };

    const dispatchEvent = (frame) => {
      if (frame.ev === 'data') {
        const listener = attachments.get(frame.pane);
        if (!listener) return;
        const data = Buffer.from(String(frame.data || ''), 'base64');
        listener.onData(data, { replay: frame.replay === true, snapshot: frame.snapshot === true });
      } else if (frame.ev === 'exit') {
        const listener = attachments.get(frame.pane);
        if (listener && listener.onExit) listener.onExit(frame.exitCode, frame.signal);
      } else if (frame.ev === 'pane') {
        for (const listener of subscribers) listener(frame);
      } else if (frame.ev === 'browser') {
        const listener = browserViews.get(frame.view);
        if (listener) listener(frame.event || {});
      } else if (frame.ev === 'reload') {
        for (const listener of attachments.values()) {
          try { if (listener.onExit) listener.onExit({ reload: true }); } catch {}
        }
        for (const listener of subscribers) listener(frame);
      }
    };

    const decoder = new FrameDecoder((frame) => {
      if (frame && frame.ev) {
        dispatchEvent(frame);
        return;
      }
      const waiter = pending.get(frame && frame.id);
      if (!waiter) return;
      pending.delete(frame.id);
      if (!frame.ok) {
        const error = new Error(String(frame.error || 'host request failed'));
        if (frame.code) error.code = String(frame.code);
        waiter.reject(error);
        return;
      }
      const { ok, id, ...result } = frame;
      waiter.resolve(result);
    }, (error) => {
      rejectPending(error);
      notifyDisconnected();
      socket.destroy();
    });

    socket.on('data', (data) => decoder.push(data));
    socket.once('connect', () => {
      clearConnectTimer();
      connected = true;
      resolve(client);
    });
    socket.once('error', (error) => {
      if (!connected) {
        clearConnectTimer();
        reject(error);
      }
      rejectPending(error);
      if (connected) notifyDisconnected();
    });
    socket.once('close', () => {
      clearConnectTimer();
      if (!connected) reject(new Error('host connection closed'));
      closed = true;
      rejectPending(new Error('host connection closed'));
      notifyDisconnected();
    });

    const request = (type, params = {}, requestOptions = {}) => {
      if (closed || socket.destroyed) return Promise.reject(new Error('host connection closed'));
      const id = `${process.pid}-${nextId++}`;
      const timeoutMs = requestOptions.timeoutMs == null ? 8000
        : Math.max(0, Number(requestOptions.timeoutMs) || 0);
      return new Promise((requestResolve, requestReject) => {
        let timer;
        const waiter = {
          resolve: (value) => {
            if (timer) { clearTimeout(timer); clearImmediate(timer); }
            requestResolve(value);
          },
          reject: (error) => {
            if (timer) { clearTimeout(timer); clearImmediate(timer); }
            requestReject(error);
          },
        };
        pending.set(id, waiter);
        timer = setTimeout(() => {
          // Timers run before socket I/O callbacks. If this process was stalled past
          // the deadline, give poll one turn to drain a reply the host already sent.
          timer = setImmediate(() => {
            if (pending.get(id) !== waiter) return;
            pending.delete(id);
            waiter.reject(new Error(annotate(`host request timed out (${type})`)));
          });
        }, timeoutMs);
        socket.write(encodeFrame({ ...params, type, id }), (error) => {
          if (!error) return;
          pending.delete(id);
          waiter.reject(error);
        });
      });
    };

    const attach = async (pane, attachOptions = {}, onData, onExit) => {
      if (typeof onData !== 'function') throw new Error('attach needs an onData callback');
      if (attachments.has(pane)) throw new Error('already attached on this connection');
      const listener = { onData, onExit };
      attachments.set(pane, listener);
      try {
        const result = await request('attach', {
          pane,
          replay: attachOptions.replay !== false,
          snapshot: attachOptions.snapshot === true,
          ...(attachOptions.snapshotScrollback == null
            ? {} : { snapshotScrollback: attachOptions.snapshotScrollback }),
          ...(attachOptions.viewer == null ? {} : { viewer: attachOptions.viewer }),
          ...(attachOptions.primary == null ? {} : { primary: attachOptions.primary === true }),
          ...(attachOptions.visible == null ? {} : { visible: attachOptions.visible === true }),
        });
        let detached = false;
        return {
          pane: result.pane,
          ...(result.history ? { history: result.history } : {}),
          detach: async () => {
            if (detached) return;
            detached = true;
            if (attachments.get(pane) === listener) attachments.delete(pane);
            await request('detach', { pane });
          },
        };
      } catch (error) {
        if (attachments.get(pane) === listener) attachments.delete(pane);
        throw error;
      }
    };

    const subscribe = async (onEvent) => {
      if (typeof onEvent !== 'function') throw new Error('subscribe needs an event callback');
      subscribers.add(onEvent);
      try {
        await request('subscribe');
        let subscribed = true;
        return {
          unsubscribe: () => {
            if (!subscribed) return;
            subscribed = false;
            subscribers.delete(onEvent);
          },
        };
      } catch (error) {
        subscribers.delete(onEvent);
        throw error;
      }
    };

    // Events for one open browser view (bin/browser-view-host.js). The caller opens the
    // view with request('browser-view', {op: 'open', view, session}) after this.
    const onBrowserEvent = (view, listener) => {
      if (typeof listener !== 'function') throw new Error('onBrowserEvent needs a callback');
      browserViews.set(String(view), listener);
      return { dispose: () => { if (browserViews.get(String(view)) === listener) browserViews.delete(String(view)); } };
    };

    const close = () => {
      if (closed) return;
      intentionalClose = true;
      closed = true;
      browserViews.clear();
      attachments.clear();
      subscribers.clear();
      disconnectListeners.clear();
      socket.end();
      socket.destroy();
      rejectPending(new Error('host connection closed'));
    };

    const onDisconnect = (listener) => {
      if (typeof listener !== 'function') throw new Error('onDisconnect needs a callback');
      if (disconnected) {
        queueMicrotask(() => { try { listener({ disconnected: true }); } catch {} });
        return { dispose() {} };
      }
      disconnectListeners.add(listener);
      return { dispose: () => disconnectListeners.delete(listener) };
    };

    const client = { sock, socket, request, attach, subscribe, onBrowserEvent, onDisconnect, close };
    connectTimer = setTimeout(() => {
      if (connected) return;
      const error = new Error(annotate('host connect timed out'));
      socket.destroy(error);
      reject(error);
    }, connectTimeoutMs);
  });
}

// A named node, resolved through the registry. An unnamed connect is untouched:
// the daemon node's socket is reached exactly as it always was, without reading
// the configuration at all, so a single-node install behaves as before.
async function connectNode(options) {
  const name = String(options.node);
  const resolved = options.resolvedNode
    || require('./node-registry.js').resolveNode(name, options.env || process.env);
  if (resolved.name !== name) throw new Error(`Keep node ${name} resolved to ${resolved.name}`);
  if (resolved.transport === 'unix') {
    const client = await connectEndpoint({ ...options, tcp: null, sock: options.sock || resolved.sock });
    client.node = name;
    return client;
  }
  const token = readNodeToken(resolved.tokenFile);
  const { address, port } = parseListenAddress(resolved.address);
  const client = await connectEndpoint({ ...options, sock: null, tcp: { host: address, port } });
  try {
    // The first frame on a network connection, and the only one the host will read
    // before it knows who is calling. Its reply says which machine answered.
    const hello = await client.request('hello', { token }, {
      ...(options.helloTimeoutMs == null ? {} : { timeoutMs: options.helloTimeoutMs }),
    });
    if (hello.protocol !== PROTOCOL_VERSION) {
      throw new Error(`Keep node ${name} at ${resolved.address} speaks protocol ${hello.protocol}, this client speaks ${PROTOCOL_VERSION}`);
    }
    if (hello.node !== name) {
      throw new Error(`${resolved.address} answers for Keep node ${hello.node}, not ${name}`);
    }
    client.node = name;
    client.descriptor = hello;
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

function connect(options = {}) {
  if (!options.node) return connectEndpoint(options);
  return connectNode(options);
}

function resolveNode(name, env = process.env) {
  return require('./node-registry.js').resolveNode(name, env);
}

module.exports = { connect, socketPath, resolveNode };
