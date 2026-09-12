'use strict';

const path = require('node:path');
const { fork } = require('node:child_process');

const DEFAULT_MAX_QUEUE = 64;
const DEFAULT_STARTUP_TIMEOUT_MS = 5000;
const DEFAULT_TRANSFER_TIMEOUT_MS = 5000;
const MAX_TRANSFER_BYTES = 2 * 1024 * 1024;

function httpError(socket, status, reason) {
  if (!socket || socket.destroyed) return;
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {}
  socket.destroy();
}

function drainBuffered(socket, first) {
  const chunks = first?.length ? [first] : [];
  let length = first?.length || 0;
  if (length > MAX_TRANSFER_BYTES) throw new Error('too much WebSocket data arrived before relay transfer');
  let chunk;
  while ((chunk = socket.read()) !== null) {
    length += chunk.length;
    if (length > MAX_TRANSFER_BYTES) throw new Error('too much WebSocket data arrived before relay transfer');
    chunks.push(Buffer.from(chunk));
  }
  return chunks.length === 0 ? Buffer.alloc(0)
    : chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
}

function createTerminalRelay(options = {}) {
  const spawn = options.fork || fork;
  const workerPath = options.workerPath || path.join(__dirname, 'terminal-relay-worker.js');
  const maxQueue = options.maxQueue || DEFAULT_MAX_QUEUE;
  const startupTimeoutMs = options.startupTimeoutMs || DEFAULT_STARTUP_TIMEOUT_MS;
  const transferTimeoutMs = options.transferTimeoutMs || DEFAULT_TRANSFER_TIMEOUT_MS;
  const log = options.log || ((message) => process.stderr.write(`${message}\n`));
  const pending = [];
  const transfers = new Map();
  let child = null;
  let ready = false;
  let closing = false;
  let nextId = 1;
  let startupTimer = null;
  let sending = false;

  const totalQueued = () => pending.length + transfers.size;
  const closeEntry = (entry, status = 503, reason = 'Service Unavailable') => {
    clearTimeout(entry.timer);
    entry.socket.off('error', entry.onSocketError);
    entry.socket.off('close', entry.onSocketClose);
    httpError(entry.socket, status, reason);
  };
  const clearChild = (failedChild, why) => {
    if (child !== failedChild) return;
    clearTimeout(startupTimer);
    startupTimer = null;
    child = null;
    ready = false;
    sending = false;
    for (const entry of pending.splice(0)) closeEntry(entry);
    for (const entry of transfers.values()) closeEntry(entry);
    transfers.clear();
    if (!closing) log(`[keep terminal relay] ${why}; the next viewer will start a replacement`);
  };

  const flush = () => {
    if (!ready || !child || sending || pending.length === 0) return;
    const activeChild = child;
    const entry = pending.shift();
    clearTimeout(entry.timer);
    if (entry.socket.destroyed) {
      flush();
      return;
    }
    sending = true;
    entry.socket.off('error', entry.onSocketError);
    entry.socket.off('close', entry.onSocketClose);
    entry.socket.on('error', () => {});
    try { entry.head = drainBuffered(entry.socket, entry.head); }
    catch (error) {
      sending = false;
      closeEntry(entry, 413, 'Payload Too Large');
      log(`[keep terminal relay] refusing buffered upgrade: ${error.message}`);
      flush();
      return;
    }
    const message = {
      type: 'upgrade', id: entry.id,
      request: entry.request,
      connection: entry.connection,
      head: entry.head.toString('base64'),
    };
    transfers.set(entry.id, entry);
    entry.timer = setTimeout(() => {
      if (!transfers.delete(entry.id)) return;
      log('[keep terminal relay] socket transfer acknowledgment timed out; replacing worker');
      try { activeChild.kill('SIGKILL'); } catch {}
    }, transferTimeoutMs);
    entry.timer.unref?.();
    try {
      activeChild.send(message, entry.socket, { keepOpen: false }, (error) => {
        sending = false;
        if (error) {
          transfers.delete(entry.id);
          closeEntry(entry);
          log(`[keep terminal relay] socket transfer failed: ${error.message}`);
        }
        flush();
      });
    } catch (error) {
      sending = false;
      transfers.delete(entry.id);
      closeEntry(entry);
      log(`[keep terminal relay] socket transfer failed: ${error.message}`);
      flush();
    }
  };

  const start = () => {
    if (child || closing) return;
    let spawned;
    try {
      spawned = spawn(workerPath, [], {
        env: { ...process.env, ...(options.workerEnv || {}) },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
    } catch (error) {
      log(`[keep terminal relay] worker failed to start: ${error.message}`);
      for (const entry of pending.splice(0)) closeEntry(entry);
      return;
    }
    child = spawned;
    ready = false;
    spawned.on('message', (message) => {
      if (child !== spawned || !message) return;
      if (message.type === 'ready') {
        ready = true;
        clearTimeout(startupTimer);
        startupTimer = null;
        flush();
      } else if (message.type === 'accepted' || message.type === 'rejected') {
        const entry = transfers.get(message.id);
        if (!entry) return;
        transfers.delete(message.id);
        clearTimeout(entry.timer);
        if (message.type === 'rejected') {
          log(`[keep terminal relay] worker rejected an upgrade: ${message.error || 'unknown error'}`);
          entry.socket.destroy();
        }
      }
    });
    spawned.once('error', (error) => clearChild(spawned, `worker error: ${error.message}`));
    spawned.once('exit', (code, signal) => {
      clearChild(spawned, `worker exited (${signal || code})`);
    });
    startupTimer = setTimeout(() => {
      if (child !== spawned || ready) return;
      log('[keep terminal relay] worker startup timed out');
      try { spawned.kill('SIGKILL'); } catch {}
      clearChild(spawned, 'worker startup failed');
    }, startupTimeoutMs);
    startupTimer.unref?.();
    spawned.send({
      type: 'init',
      hostSock: options.hostSock,
      hostConnectTimeoutMs: options.hostConnectTimeoutMs,
      readyDelayMs: options.readyDelayMs || 0,
    }, (error) => {
      if (!error) return;
      log(`[keep terminal relay] worker initialization failed: ${error.message}`);
      try { spawned.kill('SIGKILL'); } catch {}
    });
  };

  return {
    accept(req, socket, head, connection) {
      if (closing) {
        httpError(socket, 503, 'Service Unavailable');
        return false;
      }
      if (totalQueued() >= maxQueue) {
        log(`[keep terminal relay] refusing upgrade: queue limit ${maxQueue} reached`);
        httpError(socket, 503, 'Service Unavailable');
        return false;
      }
      socket.pause();
      const entry = {
        id: nextId++, socket, head: Buffer.from(head || Buffer.alloc(0)), connection,
        request: {
          method: req.method,
          url: req.url,
          headers: { ...req.headers },
          rawHeaders: Array.isArray(req.rawHeaders) ? [...req.rawHeaders] : [],
          httpVersion: req.httpVersion,
        },
        timer: null,
      };
      const dropQueued = () => {
        const index = pending.indexOf(entry);
        if (index < 0) return;
        pending.splice(index, 1);
        clearTimeout(entry.timer);
      };
      entry.onSocketError = dropQueued;
      entry.onSocketClose = dropQueued;
      socket.once('error', entry.onSocketError);
      socket.once('close', entry.onSocketClose);
      entry.timer = setTimeout(() => {
        const index = pending.indexOf(entry);
        if (index < 0) return;
        pending.splice(index, 1);
        closeEntry(entry);
        log('[keep terminal relay] queued upgrade timed out');
      }, startupTimeoutMs);
      entry.timer.unref?.();
      pending.push(entry);
      start();
      flush();
      return true;
    },
    pid() { return child?.pid || null; },
    close() {
      if (closing) return;
      closing = true;
      clearTimeout(startupTimer);
      for (const entry of pending.splice(0)) closeEntry(entry);
      for (const entry of transfers.values()) closeEntry(entry);
      transfers.clear();
      const activeChild = child;
      child = null;
      ready = false;
      if (!activeChild) return;
      const killTimer = setTimeout(() => {
        try { activeChild.kill('SIGKILL'); } catch {}
      }, 1000);
      killTimer.unref?.();
      activeChild.once('exit', () => clearTimeout(killTimer));
      try {
        activeChild.send({ type: 'shutdown' }, () => {
          try { if (activeChild.connected) activeChild.disconnect(); } catch {}
        });
      } catch {
        try { activeChild.kill('SIGTERM'); } catch {}
      }
    },
  };
}

module.exports = { createTerminalRelay, drainBuffered };
