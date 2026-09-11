'use strict';

const net = require('node:net');
const path = require('node:path');
const { FrameDecoder, encodeFrame } = require('./host.js');

function socketPath() {
  return process.env.KEEP_HOST_SOCK || path.join(require('./keep.js').ROOT, '.keep', 'host.sock');
}

function connect(options = {}) {
  const sock = options.sock || socketPath();
  const connectTimeoutMs = options.timeoutMs == null ? 3000 : Math.max(0, Number(options.timeoutMs) || 0);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sock);
    const pending = new Map();
    const attachments = new Map();
    const subscribers = new Set();
    const disconnectListeners = new Set();
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
            if (timer) clearTimeout(timer);
            requestResolve(value);
          },
          reject: (error) => {
            if (timer) clearTimeout(timer);
            requestReject(error);
          },
        };
        pending.set(id, waiter);
        timer = setTimeout(() => {
          if (pending.get(id) !== waiter) return;
          pending.delete(id);
          waiter.reject(new Error(`host request timed out (${type})`));
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

    const close = () => {
      if (closed) return;
      intentionalClose = true;
      closed = true;
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

    const client = { sock, socket, request, attach, subscribe, onDisconnect, close };
    connectTimer = setTimeout(() => {
      if (connected) return;
      const error = new Error('host connect timed out');
      socket.destroy(error);
      reject(error);
    }, connectTimeoutMs);
  });
}

module.exports = { connect, socketPath };
