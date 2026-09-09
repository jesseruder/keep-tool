#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_BUFFER_BYTES = 4 * 1024 * 1024;
const DEFAULT_CLIENT_BUFFER_BYTES = 16 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 3 * 1024 * 1024;
const TERMINAL_SCROLLBACK = 10000;
const HANDOFF_DRAIN_MS = 2000;
const PANE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

class RingBuffer {
  constructor(maxBytes = DEFAULT_BUFFER_BYTES) {
    if (!Number.isFinite(Number(maxBytes)) || Number(maxBytes) < 0) {
      throw new Error('maxBytes must be a non-negative number');
    }
    this.maxBytes = Math.floor(Number(maxBytes));
    this.chunks = [];
    this.size = 0;
  }

  push(value) {
    let chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (!chunk.length) return;
    // Eviction can split an escape sequence. Snapshot attach avoids replaying this
    // raw tail; --raw callers explicitly opt into the retained byte stream.
    if (chunk.length >= this.maxBytes) {
      chunk = chunk.subarray(chunk.length - this.maxBytes);
      this.chunks = chunk.length ? [chunk] : [];
      this.size = chunk.length;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.maxBytes && this.chunks.length) {
      this.size -= this.chunks.shift().length;
    }
  }

  contents() {
    if (!this.chunks.length) return Buffer.alloc(0);
    if (this.chunks.length === 1) return Buffer.from(this.chunks[0]);
    return Buffer.concat(this.chunks, this.size);
  }

  clear() {
    this.chunks = [];
    this.size = 0;
  }
}

function encodeFrame(frame) {
  return Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8');
}

function decodeFrame(line) {
  const data = Buffer.isBuffer(line) ? line.toString('utf8') : String(line);
  return JSON.parse(data.endsWith('\n') ? data.slice(0, -1) : data);
}

class FrameDecoder {
  constructor(onFrame, onError, maxBytes = MAX_FRAME_BYTES) {
    this.onFrame = onFrame;
    this.onError = onError;
    this.maxBytes = maxBytes;
    this.fragments = [];
    this.pendingBytes = 0;
    this.failed = false;
  }

  push(value) {
    if (this.failed) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      const fragment = chunk.subarray(offset, end);
      const lineBytes = this.pendingBytes + fragment.length;
      if (lineBytes > this.maxBytes) {
        this.fail(new Error('frame too large'));
        return;
      }
      if (newline < 0) {
        if (fragment.length) {
          this.fragments.push(fragment);
          this.pendingBytes = lineBytes;
        }
        return;
      }
      const line = this.fragments.length
        ? Buffer.concat(fragment.length ? [...this.fragments, fragment] : this.fragments, lineBytes)
        : fragment;
      this.fragments = [];
      this.pendingBytes = 0;
      offset = newline + 1;
      if (!line.length) continue;
      try {
        this.onFrame(decodeFrame(line));
      } catch (error) {
        this.fail(new Error(`invalid frame: ${error.message}`));
        return;
      }
    }
  }

  fail(error) {
    this.failed = true;
    this.fragments = [];
    this.pendingBytes = 0;
    if (this.onError) this.onError(error);
  }
}

function trimLine(buffer, index) {
  const line = buffer.getLine(index);
  return line ? line.translateToString(true).replace(/\s+$/, '') : '';
}

function renderScreen(term, options = {}) {
  const buffer = term.buffer.active;
  const viewportRows = term.rows;
  const requestedLines = options.lines == null ? viewportRows : Math.max(0, Math.floor(Number(options.lines)));
  const requestedScrollback = options.scrollback == null ? 0 : Math.max(0, Math.floor(Number(options.scrollback)));
  const viewportStart = buffer.viewportY;
  // The viewport ends at its last non-blank row: a TUI that
  // draws at the top of a tall terminal must still put its prompt in the last N lines.
  let viewportEnd = viewportStart + viewportRows;
  while (viewportEnd > viewportStart && trimLine(buffer, viewportEnd - 1) === '') viewportEnd -= 1;
  const visibleStart = viewportStart + Math.max(0, (viewportEnd - viewportStart) - requestedLines);
  const first = Math.max(0, viewportStart - requestedScrollback);
  const rows = [];
  for (let index = first; index < viewportStart; index += 1) rows.push(trimLine(buffer, index));
  for (let index = visibleStart; index < viewportEnd; index += 1) rows.push(trimLine(buffer, index));
  return {
    text: rows.join('\n'),
    lines: rows,
    cursor: { x: buffer.cursorX, y: buffer.cursorY },
    cols: term.cols,
    rows: term.rows,
    alt: buffer.type === 'alternate',
    title: options.title == null ? (term.title || '') : options.title,
  };
}

function socketPath() {
  return process.env.KEEP_HOST_SOCK || path.join(require('./keep.js').ROOT, '.keep', 'host.sock');
}

function positiveInteger(value, fallback, name) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function bufferLimit(value) {
  const source = value == null ? process.env.KEEP_HOST_BUFFER_BYTES : value;
  if (source == null || source === '') return DEFAULT_BUFFER_BYTES;
  const number = Number(source);
  if (!Number.isInteger(number) || number < 0) throw new Error('KEEP_HOST_BUFFER_BYTES must be a non-negative integer');
  return number;
}

function clientBufferLimit(value) {
  const source = value == null ? process.env.KEEP_HOST_CLIENT_BUFFER_BYTES : value;
  if (source == null || source === '') return DEFAULT_CLIENT_BUFFER_BYTES;
  const number = Number(source);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error('KEEP_HOST_CLIENT_BUFFER_BYTES must be a non-negative integer');
  }
  return number;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function settled(pane) {
  let pending;
  do {
    pending = pane.writeChain;
    await pending;
  } while (pending !== pane.writeChain);
}

function publicPane(pane) {
  return {
    id: pane.id,
    cmd: pane.cmd,
    args: pane.args,
    cwd: pane.cwd,
    pid: pane.pty.pid,
    alive: pane.alive,
    exitCode: pane.exitCode,
    signal: pane.signal,
    cols: pane.cols,
    rows: pane.rows,
    attached: pane.attachments.size,
    createdAt: pane.createdAt,
    exitedAt: pane.exitedAt,
    lastOutputAt: pane.lastOutputAt,
    bytes: pane.buffer.size,
    title: pane.title,
    alt: pane.term.buffer.active.type === 'alternate',
    meta: pane.meta,
    primary: pane.primary,
  };
}

function streamData(connection, pane, data, flags = {}) {
  for (let offset = 0; offset < data.length; offset += STREAM_CHUNK_BYTES) {
    const chunk = data.subarray(offset, offset + STREAM_CHUNK_BYTES);
    const frame = { ev: 'data', pane: pane.id, data: chunk.toString('base64') };
    if (flags.replay) frame.replay = true;
    if (flags.snapshot) frame.snapshot = true;
    if (!connection.send(encodeFrame(frame))) return;
  }
}

function connectProbe(sock) {
  return new Promise((resolve) => {
    const client = net.createConnection(sock);
    let settled = false;
    const finish = (active) => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(active);
    };
    client.once('connect', () => finish(true));
    client.once('error', () => finish(false));
  });
}

function createHost(options = {}) {
  const adopt = options.adopt || null;
  if (adopt && (adopt.version !== 1 || !Array.isArray(adopt.panes))) {
    throw new Error('unsupported host handoff record');
  }
  const sock = options.sock || (adopt && adopt.sock) || socketPath();
  if (adopt && adopt.sock !== sock) throw new Error('handoff socket does not match host socket');
  const lockPath = `${sock}.lock`;
  const maxBufferBytes = bufferLimit(options.bufferBytes);
  const maxClientBufferBytes = clientBufferLimit(options.clientBufferBytes);
  const log = options.log === undefined ? (line) => process.stdout.write(`${line}\n`) : options.log;
  const panes = new Map();
  const connections = new Set();
  const subscribers = new Set();
  const server = net.createServer();
  let listening = false;
  let closing = false;
  let listenPromise = null;
  let closePromise = null;
  let handoffPromise = null;
  let handoffFinalized = false;
  let lockOwned = false;
  let endpointOwned = false;
  let retired = false;
  let handingOff = false;
  let reloading = false;
  let nextConnectionId = 1;
  let nextAttachOrder = 1;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });

  const eventLog = (line) => {
    try { if (typeof log === 'function') log(line); } catch {}
  };
  const setPrimary = (pane, viewer) => {
    const next = viewer == null ? null : String(viewer);
    if (pane.primary === next) return;
    pane.primary = next;
    emitPane('primary', pane);
  };
  const promotePrimary = (pane) => {
    const remaining = [...pane.attachments.values()]
      .filter((attachment) => attachment.primary !== false)
      .sort((a, b) => b.order - a.order);
    setPrimary(pane, remaining.length ? remaining[0].viewer : null);
  };
  const detachPane = (connection, pane, preservePrimary = false) => {
    const attachment = pane.attachments.get(connection);
    pane.attachments.delete(connection);
    connection.attached.delete(pane.id);
    connection.pendingAttach.delete(pane.id);
    connection.viewers.delete(pane.id);
    if (!preservePrimary && attachment && pane.primary === attachment.viewer
        && ![...pane.attachments.values()].some((candidate) => candidate.viewer === attachment.viewer)) {
      promotePrimary(pane);
    }
  };
  const detachConnection = (connection, preservePrimary = false) => {
    subscribers.delete(connection);
    connection.subscribed = false;
    for (const id of [...connection.attached]) {
      const pane = panes.get(id);
      if (pane) detachPane(connection, pane, preservePrimary);
    }
    if (!preservePrimary) {
      for (const [paneId, viewer] of connection.primaryClaims) {
        const pane = panes.get(paneId);
        if (pane && pane.primary === viewer) promotePrimary(pane);
      }
    }
    connection.primaryClaims.clear();
    connection.attached.clear();
    connection.pendingAttach.clear();
    connection.viewers.clear();
  };
  const dropConnection = (connection) => {
    if (connection.dropped) return;
    connection.dropped = true;
    detachConnection(connection);
    connections.delete(connection);
    connection.socket.destroy();
    eventLog('host: dropped slow client');
  };
  const writeConnection = (connection, data, callback) => {
    if (connection.dropped || connection.socket.destroyed) return false;
    if (connection.socket.writableLength > maxClientBufferBytes) {
      dropConnection(connection);
      return false;
    }
    connection.socket.write(data, callback);
    if (connection.socket.writableLength > maxClientBufferBytes) {
      dropConnection(connection);
      return false;
    }
    return true;
  };
  const emitPane = (type, pane) => {
    const record = publicPane(pane);
    const frame = encodeFrame({ ev: 'pane', type, pane: record });
    for (const connection of subscribers) connection.send(frame);
    if (type === 'spawned') eventLog(`host: spawned ${pane.id} ${pane.cmd} pid ${pane.pty.pid}`);
    else if (type === 'exited') eventLog(`host: exited ${pane.id} code ${pane.exitCode} signal ${pane.signal}`);
    else if (type === 'removed') eventLog(`host: removed ${pane.id}`);
    else eventLog(`host: ${type} ${pane.id}`);
  };

  const terminalWrite = (pane, data) => {
    pane.writeChain = pane.writeChain.then(() => new Promise((resolve) => pane.term.write(data, resolve)));
    return pane.writeChain;
  };

  const createPane = (record) => {
    const term = new Terminal({
      cols: record.cols, rows: record.rows, scrollback: TERMINAL_SCROLLBACK, allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);
    let resolveExit;
    const exit = new Promise((resolve) => { resolveExit = resolve; });
    const pane = {
      id: record.id, cmd: record.cmd, args: record.args, cwd: record.cwd,
      cols: record.cols, rows: record.rows, term, serializer, pty: record.pty,
      meta: record.meta === undefined ? {} : record.meta,
      alive: record.alive,
      exitCode: record.exitCode == null ? null : record.exitCode,
      signal: record.signal == null ? null : record.signal,
      createdAt: record.createdAt,
      exitedAt: record.exitedAt || null,
      lastOutputAt: record.lastOutputAt || null,
      title: record.title || '',
      // Viewer connections do not survive a reload. Let the first eligible viewer
      // to attach or type claim the adopted pane instead of retaining a ghost owner.
      primary: record.adopted ? null : (record.primary == null ? null : String(record.primary)),
      buffer: new RingBuffer(maxBufferBytes),
      attachments: new Map(),
      writeChain: Promise.resolve(),
      exit,
      resolveExit,
      titleDisposable: null,
      dataDisposable: null,
      exitDisposable: null,
    };
    if (record.buffer) pane.buffer.push(record.buffer);
    if (!pane.alive) resolveExit();
    panes.set(pane.id, pane);
    pane.titleDisposable = term.onTitleChange((title) => {
      if (closing || retired || panes.get(pane.id) !== pane) return;
      if (pane.title === title) return;
      pane.title = title;
      emitPane('title', pane);
    });
    pane.dataDisposable = pane.pty.onData((value) => {
      if (closing) return;
      const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (retired) {
        if (pane.handoffRecord) {
          const combined = Buffer.concat([pane.handoffRecord.buffer, data]);
          pane.handoffRecord.buffer = combined.length > maxBufferBytes
            ? combined.subarray(combined.length - maxBufferBytes) : combined;
          pane.handoffRecord.screen = Buffer.concat([pane.handoffRecord.screen, data]);
          pane.handoffRecord.lastOutputAt = new Date().toISOString();
        }
        return;
      }
      pane.buffer.push(data);
      pane.lastOutputAt = new Date().toISOString();
      terminalWrite(pane, data).catch(() => {});
      for (const connection of pane.attachments.keys()) {
        const pending = connection.pendingAttach.get(pane.id);
        if (pending) pending.live.push(data);
        else streamData(connection, pane, data);
      }
    });
    pane.exitDisposable = pane.pty.onExit(({ exitCode, signal }) => {
      if (!pane.alive) return;
      pane.alive = false;
      pane.exitCode = exitCode;
      pane.signal = signal ? signal : null;
      pane.exitedAt = new Date().toISOString();
      pane.resolveExit();
      if (retired && pane.handoffRecord) {
        Object.assign(pane.handoffRecord, {
          alive: false, exitCode: pane.exitCode, signal: pane.signal, exitedAt: pane.exitedAt,
        });
      }
      if (closing || retired) return;
      const frame = encodeFrame({ ev: 'exit', pane: pane.id, exitCode: pane.exitCode, signal: pane.signal });
      for (const connection of pane.attachments.keys()) {
        const pending = connection.pendingAttach.get(pane.id);
        if (pending) pending.exit = { exitCode: pane.exitCode, signal: pane.signal };
        else connection.send(frame);
      }
      emitPane('exited', pane);
    });
    if (record.screen) terminalWrite(pane, record.screen).catch(() => {});
    else if (pane.buffer.size) terminalWrite(pane, pane.buffer.contents()).catch(() => {});
    return pane;
  };

  const spawnPane = (params = {}) => {
    const cmd = String(params.cmd || '');
    if (!cmd) throw new Error('spawn needs cmd');
    if (!Array.isArray(params.args == null ? [] : params.args)) throw new Error('args must be an array');
    const args = params.args == null ? [] : params.args.map(String);
    const cols = positiveInteger(params.cols, 120, 'cols');
    const rows = positiveInteger(params.rows, 40, 'rows');
    const cwd = params.cwd == null ? os.homedir() : String(params.cwd);
    const id = params.paneId == null ? crypto.randomBytes(4).toString('hex') : String(params.paneId);
    if (!PANE_ID_PATTERN.test(id)) {
      throw new Error('paneId must be 1-64 letters, digits, underscores, or hyphens');
    }
    if (panes.has(id)) throw new Error('pane already exists');
    const env = {
      ...process.env,
      ...(params.env && typeof params.env === 'object' ? params.env : {}),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      KEEP_PANE: id,
    };
    const processPty = pty.spawn(cmd, args, {
      name: 'xterm-256color', cols, rows, cwd, env, encoding: null,
    });
    let pane;
    try {
      pane = createPane({
        id, cmd, args, cwd, cols, rows, pty: processPty,
        meta: params.meta === undefined ? {} : params.meta,
        alive: true, exitCode: null, signal: null,
        createdAt: new Date().toISOString(), exitedAt: null, lastOutputAt: null,
        title: '', buffer: null, primary: null,
      });
    } catch (error) {
      try { processPty.kill('SIGHUP'); } catch {}
      throw error;
    }
    emitPane('spawned', pane);
    return pane;
  };

  if (adopt) {
    for (const record of adopt.panes) {
      if (!record || !record.id || !record.pty || panes.has(String(record.id))) {
        throw new Error('invalid pane in host handoff record');
      }
      createPane({ ...record, id: String(record.id), adopted: true });
    }
  }

  const needPane = (id) => {
    const pane = panes.get(String(id || ''));
    if (!pane) throw new Error('no such pane');
    return pane;
  };

  const handleRequest = async (connection, request) => {
    const params = request && typeof request === 'object' ? request : {};
    switch (params.type) {
      case 'hello':
        return { result: {
          version: 1, bootVersion: options.boot && options.boot.version || null,
          panes: panes.size, pid: process.pid, sock,
          reloads: options.boot && options.boot.reloads || 0,
          lastReload: options.boot && options.boot.lastReload || null,
        } };
      case 'spawn': {
        const pane = spawnPane(params);
        return { result: { pane: publicPane(pane) } };
      }
      case 'list':
        return { result: { panes: [...panes.values()].map(publicPane) } };
      case 'get':
        return { result: { pane: publicPane(needPane(params.pane)) } };
      case 'meta': {
        const pane = needPane(params.pane);
        if (!params.patch || typeof params.patch !== 'object' || Array.isArray(params.patch)) {
          throw new Error('patch must be an object');
        }
        const meta = pane.meta && typeof pane.meta === 'object' && !Array.isArray(pane.meta) ? { ...pane.meta } : {};
        for (const [key, value] of Object.entries(params.patch)) {
          if (value === null) delete meta[key];
          else meta[key] = value;
        }
        pane.meta = meta;
        emitPane('meta', pane);
        return { result: { pane: publicPane(pane) } };
      }
      case 'input': {
        const pane = needPane(params.pane);
        if (!pane.alive) throw new Error('pane has exited');
        const attachment = pane.attachments.get(connection);
        if (params.auto === true) {
          if (!attachment || pane.primary !== attachment.viewer) {
            return { result: { dropped: true } };
          }
          pane.pty.write(Buffer.from(String(params.data || ''), 'base64'));
          return { result: {} };
        }
        // An owner-less pane (fresh after a reload) goes to whoever types first, observer or not.
        if (attachment && (attachment.primary !== false || pane.primary === null)) {
          attachment.primary = true;
          setPrimary(pane, attachment.viewer);
        } else if (!attachment) {
          const viewer = params.viewer == null ? connection.id : String(params.viewer);
          connection.primaryClaims.set(pane.id, viewer);
          setPrimary(pane, viewer);
        }
        pane.pty.write(Buffer.from(String(params.data || ''), 'base64'));
        return { result: {} };
      }
      case 'resize': {
        const pane = needPane(params.pane);
        if (!pane.alive) throw new Error('pane has exited');
        const cols = positiveInteger(params.cols, null, 'cols');
        const rows = positiveInteger(params.rows, null, 'rows');
        const attachment = pane.attachments.get(connection);
        const viewer = params.viewer == null
          ? (attachment && attachment.viewer) : String(params.viewer);
        if (params.force === true) {
          const forcedViewer = viewer || connection.id;
          if (!attachment) connection.primaryClaims.set(pane.id, forcedViewer);
          setPrimary(pane, forcedViewer);
        } else if ((attachment && attachment.primary === false)
            || (viewer && pane.primary !== viewer) || (!viewer && pane.primary !== null)) {
          return { result: { pane: publicPane(pane), applied: false, primary: pane.primary } };
        }
        await settled(pane);
        if (!pane.alive) throw new Error('pane has exited');
        pane.pty.resize(cols, rows);
        pane.term.resize(cols, rows);
        pane.cols = cols;
        pane.rows = rows;
        emitPane('resized', pane);
        return { result: { pane: publicPane(pane), applied: true, primary: pane.primary } };
      }
      case 'attach': {
        const pane = needPane(params.pane);
        if (connection.attached.has(pane.id)) throw new Error('already attached on this connection');
        const viewer = params.viewer == null ? connection.id : String(params.viewer);
        if (!viewer) throw new Error('viewer cannot be empty');
        const attachment = { viewer, primary: params.primary !== false, order: nextAttachOrder++ };
        let pending;
        try {
          if (params.snapshot === true) {
            await settled(pane);
            if (connection.dropped || connection.socket.destroyed || panes.get(pane.id) !== pane) {
              throw new Error('host connection closed');
            }
            // Serialization and registration as a live consumer are one synchronous
            // boundary: earlier bytes are in the snapshot and later bytes are captured.
            const serialized = pane.serializer.serialize({
              scrollback: TERMINAL_SCROLLBACK,
              excludeAltBuffer: false,
            });
            pending = {
              replay: null,
              snapshot: Buffer.from(`\x1bc${serialized}`, 'utf8'),
              live: [],
              exit: null,
            };
          } else {
            pending = {
              replay: params.replay === false ? null : pane.buffer.contents(),
              snapshot: null,
              live: [],
              exit: null,
            };
          }
          pane.attachments.set(connection, attachment);
          connection.attached.add(pane.id);
          connection.viewers.set(pane.id, viewer);
          connection.pendingAttach.set(pane.id, pending);
          if (attachment.primary && pane.primary === null) setPrimary(pane, viewer);
        } catch (error) {
          detachPane(connection, pane);
          throw error;
        }
        return {
          result: { pane: publicPane(pane), viewer },
          after: () => {
            const ready = connection.pendingAttach.get(pane.id);
            if (!ready) return;
            if (ready.snapshot) streamData(connection, pane, ready.snapshot, { replay: true, snapshot: true });
            else if (ready.replay) streamData(connection, pane, ready.replay, { replay: true });
            for (const data of ready.live) streamData(connection, pane, data);
            connection.pendingAttach.delete(pane.id);
            const exit = ready.exit || (!pane.alive && { exitCode: pane.exitCode, signal: pane.signal });
            if (exit) {
              connection.send(encodeFrame({
                ev: 'exit', pane: pane.id, exitCode: exit.exitCode, signal: exit.signal,
              }));
            }
          },
        };
      }
      case 'detach': {
        const pane = needPane(params.pane);
        detachPane(connection, pane);
        return { result: { pane: publicPane(pane) } };
      }
      case 'screen': {
        const pane = needPane(params.pane);
        await settled(pane);
        return { result: renderScreen(pane.term, { lines: params.lines, scrollback: params.scrollback, title: pane.title }) };
      }
      case 'clear': {
        const pane = needPane(params.pane);
        await settled(pane);
        pane.buffer.clear();
        pane.term.clear();
        if (params.repaint !== false && pane.alive && pane.cols > 1) {
          const cols = pane.cols;
          try {
            pane.pty.resize(cols - 1, pane.rows);
            pane.term.resize(cols - 1, pane.rows);
            await new Promise((resolve) => setTimeout(resolve, 30));
            if (pane.alive) pane.pty.resize(cols, pane.rows);
          } finally {
            pane.term.resize(cols, pane.rows);
          }
        }
        return { result: { pane: publicPane(pane) } };
      }
      case 'kill': {
        const pane = needPane(params.pane);
        if (pane.alive) pane.pty.kill(params.signal || 'SIGTERM');
        return { result: { pane: publicPane(pane) } };
      }
      case 'remove': {
        const pane = needPane(params.pane);
        if (pane.alive) throw new Error('pane is still alive');
        await settled(pane);
        for (const connection of pane.attachments.keys()) detachPane(connection, pane);
        pane.attachments.clear();
        panes.delete(pane.id);
        emitPane('removed', pane);
        const record = publicPane(pane);
        for (const disposable of [pane.dataDisposable, pane.exitDisposable, pane.titleDisposable]) {
          try { if (disposable) disposable.dispose(); } catch {}
        }
        pane.term.dispose();
        return { result: { pane: record } };
      }
      case 'subscribe':
        subscribers.add(connection);
        connection.subscribed = true;
        return { result: {} };
      case 'reload':
        if (!options.boot || typeof options.boot.reload !== 'function') {
          throw new Error('host reload is unavailable without the bootstrap');
        }
        return {
          result: { panesAdopted: panes.size, reloads: options.boot.reloads || 0 },
          after: () => options.boot.reload().catch((error) => eventLog(`host: reload failed: ${error.message}`)),
        };
      case 'shutdown':
        return { result: {}, after: () => {
          const stopping = options.boot && typeof options.boot.close === 'function'
            ? options.boot.close() : close();
          Promise.resolve(stopping).catch((error) => eventLog(`host: shutdown failed: ${error.message}`));
        } };
      default:
        throw new Error('unknown request');
    }
  };

  server.on('connection', (socket) => {
    const connection = {
      id: `viewer-${process.pid}-${nextConnectionId++}`,
      socket,
      attached: new Set(),
      viewers: new Map(),
      primaryClaims: new Map(),
      pendingAttach: new Map(),
      subscribed: false,
      dropped: false,
      queue: Promise.resolve(),
    };
    connection.send = (data, callback) => writeConnection(connection, data, callback);
    connections.add(connection);
    const fail = (error) => {
      if (socket.destroyed) return;
      if (!connection.send(encodeFrame({ ok: false, id: null, error: error.message }), () => socket.end())) {
        socket.destroy();
      }
    };
    const decoder = new FrameDecoder((request) => {
      if (reloading) {
        connection.send(encodeFrame({
          ok: false,
          id: request && request.id,
          error: 'host reloading',
          code: 'reloading',
        }));
        return;
      }
      connection.queue = connection.queue.then(async () => {
        let response;
        let after;
        try {
          const handled = await handleRequest(connection, request);
          response = { ok: true, id: request.id, ...handled.result };
          after = handled.after;
        } catch (error) {
          response = { ok: false, id: request && request.id, error: error.message };
          if (error && error.code) response.code = error.code;
        }
        if (!socket.destroyed) {
          await new Promise((resolve) => {
            if (!connection.send(encodeFrame(response), resolve)) resolve();
          });
          if (after) after();
        }
      }).catch(fail);
    }, fail);
    socket.on('data', (data) => decoder.push(data));
    socket.on('error', () => {});
    socket.on('close', () => {
      connections.delete(connection);
      detachConnection(connection, handingOff);
    });
  });

  const unlink = (file) => {
    try { fs.unlinkSync(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };

  const releaseLock = () => {
    if (!lockOwned) return;
    lockOwned = false;
    try {
      if (Number(fs.readFileSync(lockPath, 'utf8').trim()) === process.pid) unlink(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };

  const acquireLock = () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let fd;
      let created = false;
      try {
        fd = fs.openSync(lockPath, 'wx', 0o600);
        created = true;
        fs.writeFileSync(fd, `${process.pid}\n`);
        lockOwned = true;
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          if (created) {
            try { unlink(lockPath); } catch {}
          }
          throw error;
        }
        let owner = NaN;
        try { owner = Number(fs.readFileSync(lockPath, 'utf8').trim()); } catch {}
        if (adopt && owner === process.pid) {
          lockOwned = true;
          return;
        }
        if (pidAlive(owner)) throw new Error(`host already running (pid ${owner})`);
        if (attempt === 1) throw new Error(`could not acquire host lock at ${lockPath}`);
        unlink(lockPath);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
  };

  const closeServer = () => new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => error ? reject(error) : resolve());
  });

  const startServer = () => new Promise((resolve, reject) => {
    const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    const previousUmask = process.umask(0o077);
    try {
      server.listen(sock);
    } catch (error) {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
      reject(error);
    } finally {
      process.umask(previousUmask);
    }
  });

  const doListen = async () => {
    // macOS truncates sun_path at 104 bytes silently, so a long path binds a different name than we chmod.
    if (Buffer.byteLength(sock) > 103) throw new Error(`socket path too long (${Buffer.byteLength(sock)} bytes, max 103): ${sock}`);
    fs.mkdirSync(path.dirname(sock), { recursive: true });
    acquireLock();
    try {
      if (fs.existsSync(sock)) {
        const active = await connectProbe(sock);
        if (active) throw new Error(`host already running at ${sock}`);
        unlink(sock);
        if (closing) return host;
      }
      await startServer();
      endpointOwned = true;
      listening = true;
      if (closing) {
        await closeServer();
        listening = false;
        return host;
      }
      fs.chmodSync(sock, 0o600);
      eventLog(`host: listening ${sock} pid ${process.pid}`);
      return host;
    } catch (error) {
      if (server.listening) {
        try { await closeServer(); } catch {}
      }
      listening = false;
      if (endpointOwned) {
        endpointOwned = false;
        try { unlink(sock); } catch {}
      }
      releaseLock();
      throw error;
    }
  };

  const listen = () => {
    if (closing || retired) return Promise.resolve(host);
    if (listening) return Promise.resolve(host);
    if (listenPromise) return listenPromise;
    listenPromise = doListen().finally(() => { listenPromise = null; });
    return listenPromise;
  };

  const disposePaneCore = async (pane) => {
    try { await settled(pane); } catch {}
    for (const disposable of [pane.dataDisposable, pane.exitDisposable, pane.titleDisposable]) {
      try { if (disposable) disposable.dispose(); } catch {}
    }
    try { pane.term.dispose(); } catch {}
  };

  const finalizeHandoff = () => {
    if (handoffFinalized) return;
    handoffFinalized = true;
    for (const pane of panes.values()) {
      for (const disposable of [pane.dataDisposable, pane.exitDisposable]) {
        try { if (disposable) disposable.dispose(); } catch {}
      }
      pane.handoffRecord = null;
    }
  };

  // Tell every client to reconnect and drop it. server.close() only completes once
  // its connections are gone, so both the successful handoff and the rollback
  // must do this before awaiting it.
  const dropAllConnections = () => {
    const reloadFrame = encodeFrame({ ev: 'reload' });
    for (const connection of connections) {
      detachConnection(connection, true);
      try {
        connection.socket.end(reloadFrame, () => connection.socket.destroy());
        const timer = setTimeout(() => connection.socket.destroy(), 100);
        if (typeof timer.unref === 'function') timer.unref();
      } catch { connection.socket.destroy(); }
    }
    connections.clear();
    subscribers.clear();
  };

  const handoff = () => {
    if (handoffPromise) return handoffPromise;
    if (closing) return Promise.reject(new Error('host is shutting down'));
    handingOff = true;
    reloading = true;
    handoffPromise = (async () => {
      if (listenPromise) await listenPromise;
      // Stop accepting first, but keep the endpoint until the replacement is ready
      // to bind. Its listen path probes and unlinks the now-stale socket immediately
      // before server.listen().
      const serverClosed = closeServer();
      let record;
      try {
      let drainTimer;
      await Promise.race([
        Promise.allSettled([...connections].map((connection) => connection.queue)),
        new Promise((resolve) => { drainTimer = setTimeout(resolve, HANDOFF_DRAIN_MS); }),
      ]);
      if (drainTimer) clearTimeout(drainTimer);

      await Promise.all([...panes.values()].map((pane) => settled(pane).catch(() => {})));
      record = {
        version: 1,
        sock,
        panes: [...panes.values()].map((pane) => ({
          id: pane.id,
          cmd: pane.cmd,
          args: pane.args,
          cwd: pane.cwd,
          cols: pane.cols,
          rows: pane.rows,
          meta: pane.meta,
          alive: pane.alive,
          exitCode: pane.exitCode,
          signal: pane.signal,
          createdAt: pane.createdAt,
          exitedAt: pane.exitedAt,
          lastOutputAt: pane.lastOutputAt,
          title: pane.title,
          pid: pane.pty.pid,
          pty: pane.pty,
          buffer: pane.buffer.contents(),
          screen: Buffer.from(pane.serializer.serialize({
            scrollback: TERMINAL_SCROLLBACK,
            excludeAltBuffer: false,
          }), 'utf8'),
          primary: null,
        })),
      };
      } catch (error) {
        // Nothing has been handed over yet: this core stays the owner. Reopen the
        // endpoint (server.close() leaves the socket file behind) and clear the
        // flags so requests flow again; the bootstrap keeps us while `serving` is true.
        dropAllConnections();
        for (const pane of panes.values()) setPrimary(pane, null);
        await serverClosed.catch(() => {});
        listening = false;
        try { unlink(sock); } catch {}
        await startServer();
        fs.chmodSync(sock, 0o600);
        listening = true;
        endpointOwned = true;
        reloading = false;
        handingOff = false;
        handoffPromise = null;
        throw error;
      }
      for (const pane of panes.values()) {
        pane.handoffRecord = record.panes.find((candidate) => candidate.id === pane.id);
      }
      retired = true;
      dropAllConnections();
      await serverClosed;
      listening = false;
      endpointOwned = false;
      for (const pane of panes.values()) {
        try { if (pane.titleDisposable) pane.titleDisposable.dispose(); } catch {}
        try { pane.term.dispose(); } catch {}
      }
      // The bootstrap keeps the pid-stamped lock across the core swap.
      lockOwned = false;
      resolveClosed();
      return record;
    })();
    return handoffPromise;
  };

  const close = () => {
    if (closePromise) return closePromise;
    if (retired) return Promise.resolve();
    closing = true;
    closePromise = (async () => {
      if (listenPromise) {
        try { await listenPromise; } catch {}
      }

      const alive = [...panes.values()].filter((pane) => pane.alive);
      for (const pane of alive) {
        try { pane.pty.kill('SIGHUP'); } catch {}
      }
      if (alive.length) {
        await Promise.race([
          Promise.all(alive.map((pane) => pane.exit)),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      }
      const survivors = alive.filter((pane) => pane.alive);
      for (const pane of survivors) {
        try { pane.pty.kill('SIGKILL'); } catch {}
      }
      if (survivors.length) {
        await Promise.all(survivors.map((pane) => pane.exit));
      }

      for (const connection of connections) {
        detachConnection(connection);
        connection.socket.destroy();
      }
      connections.clear();
      subscribers.clear();
      try { await closeServer(); } finally { listening = false; }
      if (endpointOwned) {
        endpointOwned = false;
        unlink(sock);
      }
      releaseLock();
      await Promise.all([...panes.values()].map(disposePaneCore));
      eventLog('host: stopped');
      resolveClosed();
    })();
    return closePromise;
  };

  const host = {
    sock, panes, server, closed, listen, close, handoff, finalizeHandoff,
    get closing() { return closing; },
    get retired() { return retired; },
    get serving() { return !retired && !reloading && listening && server.listening; },
  };
  return host;
}

async function runHost(options = {}) {
  return require('./host-boot.js').runHost(options);
}

module.exports = {
  MAX_FRAME_BYTES,
  RingBuffer,
  FrameDecoder,
  encodeFrame,
  decodeFrame,
  renderScreen,
  createHost,
  runHost,
  socketPath,
};

if (require.main === module) {
  runHost().catch((error) => {
    process.stderr.write(`host: ${error.message}\n`);
    process.exitCode = 1;
  });
}
