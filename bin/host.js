#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const v8 = require('node:v8');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const { localNode } = require('./nodes.js');

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_BUFFER_BYTES = 4 * 1024 * 1024;
const DEFAULT_CLIENT_BUFFER_BYTES = 16 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 3 * 1024 * 1024;
const TERMINAL_SCROLLBACK = 10000;
const DEFAULT_SNAPSHOT_SCROLLBACK = 100;
const HANDOFF_DRAIN_MS = 2000;
const COLD_FREEZE_CONCURRENCY = 2;
const COLD_RESTORE_CONCURRENCY = 4;
const PANE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const INPUT_OPERATION_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const INPUT_RECEIPT_LIMIT = 256;
const HOST_LOG_MAX_BYTES = 5 * 1024 * 1024;
// The wire contract a remote node agent speaks. The unix socket answers the same
// frames, so this is not a second protocol: it is the number a caller checks before
// it trusts a descriptor it reached over the network.
const PROTOCOL_VERSION = 1;
// The shapes of the verbs a caller checks for in the hello before it asks. Named once,
// because the `stats` verb reports them too.
const TRANSCRIPT_VERSION = 4;
const ARTIFACTS_VERSION = 2;
const STATS_VERSION = 1;
const INVENTORY_VERSION = 1;
const HELLO_FAILURE_LIMIT = 10;
const HELLO_FAILURE_WINDOW_MS = 60e3;
const HELLO_FAILURE_ADDRESSES = 256;
const HELLO_DEADLINE_MS = 10e3;

function hostLogFile(env = process.env) {
  return path.join(env.KEEP_DIR || path.join(os.homedir(), 'keep'), '.keep', 'host.log');
}

function rotateHostLog(options = {}) {
  const io = options.fs || fs;
  const file = options.file || hostLogFile(options.env);
  const maxBytes = Number(options.maxBytes) || HOST_LOG_MAX_BYTES;
  try {
    if (io.statSync(file).size > maxBytes) {
      io.truncateSync(file);
      return true;
    }
  } catch {}
  return false;
}

function createHostLogger(options = {}) {
  const checkEvery = Math.max(1, Number(options.checkEvery) || 256);
  let writes = 0;
  rotateHostLog(options);
  return (line) => {
    // launchd owns the open stdout descriptor, so truncating its target is the
    // only rotation that does not require restarting the terminal host.
    if (++writes % checkEvery === 0) rotateHostLog(options);
    (options.write || ((text) => process.stdout.write(text)))(`${line}\n`);
  };
}

function shouldLogPaneEvent(type, debug = false) {
  return !['title', 'visibility'].includes(type) || debug === true;
}

function inputOperationFingerprint(params) {
  return crypto.createHash('sha256').update(JSON.stringify([
    String(params.pane || ''), params.expectedPid, params.expectedInputCount,
    String(params.data || ''), params.auto === true,
  ])).digest('hex');
}

function inputReceiptMap(value) {
  const receipts = new Map();
  if (value == null) return receipts;
  if (!Array.isArray(value) || value.length > INPUT_RECEIPT_LIMIT) throw new Error('invalid input receipts in host handoff');
  for (const item of value) {
    if (!item || !INPUT_OPERATION_PATTERN.test(String(item.id || ''))
        || !/^[a-f0-9]{64}$/.test(String(item.fingerprint || ''))
        || !item.result || typeof item.result !== 'object' || Array.isArray(item.result)) {
      throw new Error('invalid input receipt in host handoff');
    }
    receipts.set(String(item.id), { fingerprint: String(item.fingerprint), result: { ...item.result } });
  }
  return receipts;
}

function rememberInputReceipt(pane, id, fingerprint, result) {
  pane.inputReceipts.set(id, { fingerprint, result: { ...result } });
  while (pane.inputReceipts.size > INPUT_RECEIPT_LIMIT) pane.inputReceipts.delete(pane.inputReceipts.keys().next().value);
}

// Key order is not part of what a caller asked for, and a retry that rebuilt its
// env or meta in another order is still the same request.
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value === undefined ? null : value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

// A spawn is the one request that cannot be retried blind: a lost reply leaves a
// process running that the caller does not know about, and asking again starts a
// second one. The journal is the host's, not a pane's, because at the moment the
// operation is named there is no pane yet.
function spawnOperationFingerprint(params) {
  return crypto.createHash('sha256').update(JSON.stringify([
    String(params.cmd || ''),
    (params.args == null ? [] : params.args).map(String),
    params.cwd == null ? null : String(params.cwd),
    params.cols === undefined ? null : params.cols,
    params.rows === undefined ? null : params.rows,
    stableValue(params.env),
    stableValue(params.meta),
    // A caller-chosen pane id is part of what was asked for: the same command in a
    // pane named something else is a different request, and answering it from this
    // receipt would hand back a pane the caller never asked about.
    params.paneId == null ? null : String(params.paneId),
  ])).digest('hex');
}

// What a receipt has to remember to answer a replay honestly: which pane it made,
// which process that pane was, and what it told the caller at the time. The pane
// snapshot is kept so a pane that has since been removed can still be answered —
// the operation did happen, and the honest answer is "it ran, and it is not alive".
function spawnReceiptMap(value) {
  const receipts = new Map();
  if (value == null) return receipts;
  if (!Array.isArray(value) || value.length > INPUT_RECEIPT_LIMIT) throw new Error('invalid spawn receipts in host handoff');
  for (const item of value) {
    // Every field a replay is decided by, checked here rather than trusted: the
    // pid and createdAt are what tell "this is still the pane this operation made"
    // from "somebody reused the id", and a snapshot that disagrees with them would
    // answer a replay with a pane description that was never true.
    if (!item || !INPUT_OPERATION_PATTERN.test(String(item.id || ''))
        || !/^[a-f0-9]{64}$/.test(String(item.fingerprint || ''))
        || !PANE_ID_PATTERN.test(String(item.paneId || ''))
        || !Number.isInteger(item.pid) || item.pid <= 0
        || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
        || !item.pane || typeof item.pane !== 'object' || Array.isArray(item.pane)
        || item.pane.id !== String(item.paneId)
        || item.pane.pid !== item.pid
        || item.pane.createdAt !== item.createdAt) {
      throw new Error('invalid spawn receipt in host handoff');
    }
    receipts.set(String(item.id), {
      fingerprint: String(item.fingerprint),
      paneId: String(item.paneId),
      pid: item.pid,
      createdAt: String(item.createdAt),
      pane: { ...item.pane },
    });
  }
  return receipts;
}

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
  const result = {
    ...(options.compact ? {} : { text: rows.join('\n') }),
    lines: rows,
    cursor: { x: buffer.cursorX, y: buffer.cursorY },
    cols: term.cols,
    rows: term.rows,
    alt: buffer.type === 'alternate',
    title: options.title == null ? (term.title || '') : options.title,
  };
  if (options.compact) {
    // Leave room for the protocol envelope. Count JSON bytes, including escaping,
    // rather than the smaller raw terminal text, before encoding the host frame.
    const limit = 7 * 1024 * 1024;
    const scrollbackLines = viewportStart - first;
    result.scrollbackLines = scrollbackLines;
    result.truncated = false;
    const metadataBytes = Buffer.byteLength(JSON.stringify({ ...result, lines: [], truncated: true }));
    const rowBytes = rows.map((row) => Buffer.byteLength(JSON.stringify(row)) + 1);
    let bytes = metadataBytes + rowBytes.reduce((sum, size) => sum + size, 0);
    let removed = 0;
    while (bytes > limit && removed < scrollbackLines) bytes -= rowBytes[removed++];
    if (bytes > limit) throw new Error('terminal viewport exceeds history snapshot limit');
    result.lines = rows.slice(removed);
    result.scrollbackLines -= removed;
    result.truncated = removed > 0;
  }
  return result;
}

// As in hostclient.js: an explicit socket never requires keep.js, so a host boots
// without a configuration or a registry.
function socketPath() {
  if (process.env.KEEP_HOST_SOCK) return process.env.KEEP_HOST_SOCK;
  return path.join(require('./keep.js').ROOT, '.keep', 'host.sock');
}

function positiveInteger(value, fallback, name) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function snapshotScrollback(value) {
  if (value == null) return DEFAULT_SNAPSHOT_SCROLLBACK;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > TERMINAL_SCROLLBACK) {
    throw new Error(`snapshotScrollback must be an integer from 0 to ${TERMINAL_SCROLLBACK}`);
  }
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
  const activityTimes = [pane.lastInputAt, pane.lastOutputAt]
    .map((value) => Date.parse(value || ''))
    .filter(Number.isFinite);
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
    visibleAttached: [...pane.attachments.values()].filter(a => a.visible === true).length,
    createdAt: pane.createdAt,
    exitedAt: pane.exitedAt,
    lastInputAt: pane.lastInputAt,
    lastOutputAt: pane.lastOutputAt,
    lastReadAt: pane.lastReadAt,
    inputCount: pane.inputCount,
    outputCount: pane.outputCount,
    lastActivityAt: activityTimes.length ? new Date(Math.max(...activityTimes)).toISOString() : null,
    bytes: pane.bufferBytes,
    title: pane.title,
    alt: pane.term ? pane.term.buffer.active.type === 'alternate' : pane.coldSnapshot.alt,
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

// `<ip>:<port>`, with a bracketed literal for IPv6. The design binds one
// interface — the node's Tailscale address — so the form is deliberately narrow.
// fe80::/10: the first hextet is fe80 through febf, and it is the only range in
// which a scope zone means anything at all.
function linkLocalIp(canonical) {
  return /^fe[89ab][0-9a-f]:/i.test(canonical);
}

function parseIpv6(bare) {
  return new URL(`http://[${bare}]`).hostname.replace(/^\[/, '').replace(/\]$/, '');
}

// An address names an interface, never a machine: a hostname is resolved at bind
// time and could land on an interface nobody meant to expose. An IPv6 literal is
// canonicalised through the URL parser, so that `::0`, `0:0:0:0:0:0:0:0` and `::`
// are one address by the time anything decides whether it is the wildcard.
//
// A `%zone` suffix is split off first. net.isIP() accepts one, the URL parser does
// not, and a canonicalisation that fell back to the raw text would hand `::%0`
// straight past both wildcard comparisons — where libuv drops the zone and binds
// every interface on the machine. So the zone is separated, the address itself is
// canonicalised or refused, and a zone survives only on a link-local address, which
// is the only place it could have been meant.
function canonicalIp(value, source = value, parse = parseIpv6) {
  const raw = String(value).replace(/^\[/, '').replace(/\]$/, '');
  const percent = raw.indexOf('%');
  const bare = percent < 0 ? raw : raw.slice(0, percent);
  const zone = percent < 0 ? '' : raw.slice(percent + 1);
  const family = net.isIP(bare);
  if (!family) throw new Error(`a node listen address must be an IP literal, not ${JSON.stringify(raw)}: ${source}`);
  if (percent >= 0 && !zone) throw new Error(`a node listen address has an empty zone: ${source}`);
  if (family !== 6) {
    if (zone) throw new Error(`an IPv4 address takes no zone: ${source}`);
    return bare;
  }
  let canonical;
  // Never a fallback: an address this cannot read is an address nothing should bind.
  try { canonical = parse(bare); }
  catch (error) { throw new Error(`cannot read the IPv6 address ${JSON.stringify(bare)} (${error.message}): ${source}`); }
  if (!zone) return canonical;
  if (!linkLocalIp(canonical)) {
    throw new Error(`a zone is only meaningful on a link-local address (fe80::/10), not ${canonical}: ${source}`);
  }
  return `${canonical}%${zone}`;
}

function parseListenAddress(value, parse = parseIpv6) {
  const text = String(value || '').trim();
  const match = /^\[([^\]]+)\]:(\d+)$/.exec(text) || /^([^:]+):(\d+)$/.exec(text);
  if (!match) throw new Error(`a node listen address must be <ip>:<port>: ${text}`);
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid node listen port: ${text}`);
  return { address: canonicalIp(match[1], text, parse), port };
}

function wildcardAddress(address) {
  return ['0.0.0.0', '::'].includes(String(address));
}

// `::ffff:a.b.c.d` is an IPv4 address in an IPv6 spelling, and the kernel treats it
// as one: `::ffff:0.0.0.0` — canonically `::ffff:0:0` — binds INADDR_ANY, every
// interface on the machine, while reading like a specific address. Unmapped here so
// that the IPv4 wildcard rule is applied to it under every spelling.
//
// Only zeros and colons may come before the ffff; that is what makes an address
// mapped rather than one that merely ends in those two groups.
const MAPPED_PREFIX = '(?:0{1,4}:)*:{0,2}(?:0{1,4}:)*';
const MAPPED_DOTTED = new RegExp('^' + MAPPED_PREFIX + 'ffff:(\\d{1,3}(?:\\.\\d{1,3}){3})' + '$');
const MAPPED_HEX = new RegExp('^' + MAPPED_PREFIX + 'ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})' + '$');

function unmapIpv4(address) {
  const text = String(address).toLowerCase();
  const dotted = MAPPED_DOTTED.exec(text);
  if (dotted) return net.isIP(dotted[1]) === 4 ? dotted[1] : null;
  const hex = MAPPED_HEX.exec(text);
  if (!hex) return null;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  const mapped = [high >> 8, high & 255, low >> 8, low & 255].join('.');
  return net.isIP(mapped) === 4 ? mapped : null;
}

// The refusal the host makes at boot, in one place so `keep node init` refuses
// the same addresses before it writes a service that would bind them.
// `remedy` is what the refusal tells the reader to do: the host's own escape hatch
// by default, and something else for a listener that has none (the node API).
function assertBindable(address, source = address, remedy = 'set KEEP_HOST_LISTEN_ANY=1 to listen on every interface') {
  const mapped = unmapIpv4(address);
  if (wildcardAddress(mapped || address)) {
    throw new Error(`refusing to bind ${address}${mapped ? ` (IPv4 ${mapped})` : ''}: ${remedy}`);
  }
  return source;
}

function formatListenAddress(bound) {
  if (!bound || typeof bound !== 'object') return null;
  return String(bound.address).includes(':') ? `[${bound.address}]:${bound.port}` : `${bound.address}:${bound.port}`;
}

// The token is the only thing between the network and every pane on this machine,
// so a file another account can read is refused rather than quietly trusted.
function readNodeToken(file, io = fs) {
  const stat = io.statSync(file);
  const mode = stat.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`node token ${file} must be mode 0600 (found ${mode.toString(8).padStart(4, '0')})`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`node token ${file} must be owned by uid ${process.getuid()} (found ${stat.uid})`);
  }
  const token = io.readFileSync(file, 'utf8').trim();
  if (!token) throw new Error(`node token ${file} is empty`);
  return token;
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
  const coldDir = path.resolve(options.coldDir || `${sock}.screens`);
  const coldIO = options.coldIO || fs.promises;
  const log = options.log === undefined ? createHostLogger({
    file: options.logFile, maxBytes: options.logMaxBytes, checkEvery: options.logCheckEvery,
  }) : options.log;
  const debugEvents = options.debug === undefined ? Boolean(process.env.KEEP_DEBUG) : options.debug === true;
  const primaryReconnectGraceMs = Math.max(0, Number(options.primaryReconnectGraceMs ?? 60e3));
  const env = options.env || process.env;
  // The node agent transport. It is optional, it never touches the unix lock or the
  // socket file, and a failure on this side leaves the unix socket serving as before.
  const listenSpec = options.listen === undefined ? env.KEEP_HOST_LISTEN : options.listen;
  const tokenFile = (options.tokenFile === undefined ? env.KEEP_NODE_TOKEN_FILE : options.tokenFile) || null;
  const allowAnyAddress = options.listenAny === undefined ? env.KEEP_HOST_LISTEN_ANY === '1' : options.listenAny === true;
  const nodeName = options.node || localNode(env);
  // One identity per host process: a core reload carries it across in the handoff
  // record, so a caller can tell "the same panes, new code" from "a new process".
  const bootId = options.bootId
    || (adopt && typeof adopt.bootId === 'string' && adopt.bootId)
    || crypto.randomBytes(16).toString('hex');
  let listenTarget = null;
  let tcpAddress = null;
  let tcpError = null;
  let tokenDigest = null;
  if (listenSpec) {
    try {
      listenTarget = parseListenAddress(listenSpec);
      if (!allowAnyAddress) assertBindable(listenTarget.address, listenSpec);
      if (!tokenFile) throw new Error('a node listen address needs KEEP_NODE_TOKEN_FILE');
      tokenDigest = crypto.createHash('sha256').update(readNodeToken(tokenFile)).digest();
    } catch (error) {
      tcpError = error;
      listenTarget = null;
    }
  }
  const panes = new Map();
  // One journal for the whole host, carried across a core reload with the panes it
  // names: a caller retrying a spawn after a lost reply has to reach the same
  // answer whether or not the code swapped underneath it.
  const spawnReceipts = spawnReceiptMap(adopt && adopt.spawnReceipts);
  const connections = new Set();
  const subscribers = new Set();
  const server = net.createServer();
  const tcpServer = listenTarget ? net.createServer() : null;
  const helloFailures = new Map();
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
  let activeFreezes = 0;
  const freezeQueue = [];
  let activeRestores = 0;
  const restoreQueue = [];
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });

  const eventLog = (line) => {
    try { if (typeof log === 'function') log(line); } catch {}
  };
  // Compared as digests so the comparison is constant time in the token's content
  // and in its length; a shorter guess must not answer faster than a longer one.
  const tokenAccepted = (value) => {
    if (!tokenDigest || typeof value !== 'string' || !value) return false;
    return crypto.timingSafeEqual(crypto.createHash('sha256').update(value).digest(), tokenDigest);
  };
  // Returns whether this address is now over its limit. Only a failed hello counts,
  // and a successful one forgives the address outright, so the throttle can never
  // keep out the node that holds the token — it only makes guessing cheap to refuse.
  const noteHelloFailure = (remote) => {
    const now = Date.now();
    const entry = helloFailures.get(remote);
    if (!entry || now - entry.at > HELLO_FAILURE_WINDOW_MS) helloFailures.set(remote, { count: 1, at: now });
    else { entry.count += 1; entry.at = now; }
    while (helloFailures.size > HELLO_FAILURE_ADDRESSES) helloFailures.delete(helloFailures.keys().next().value);
    return helloFailures.get(remote).count > HELLO_FAILURE_LIMIT;
  };
  const validColdFile = (paneId, file) => {
    if (typeof file !== 'string') return false;
    const resolved = path.resolve(file);
    const name = path.basename(resolved);
    return path.dirname(resolved) === coldDir
      && name.startsWith(`${paneId}-`)
      && /^[A-Za-z0-9_-]+-[a-f0-9]{16}\.xterm$/.test(name);
  };
  const removeColdFile = async (pane, snapshot = pane.coldSnapshot) => {
    if (!snapshot || !validColdFile(pane.id, snapshot.file)) return;
    try { await coldIO.unlink(snapshot.file); }
    catch (error) { if (error.code !== 'ENOENT') eventLog(`host: could not remove cold screen ${pane.id}: ${error.message}`); }
    if (pane.coldSnapshot === snapshot) pane.coldSnapshot = null;
  };
  const decodeColdArchive = (pane, data) => {
    const archive = v8.deserialize(data);
    if (!archive || archive.version !== 1 || !Buffer.isBuffer(archive.screen)
        || !Buffer.isBuffer(archive.buffer) || archive.cols !== pane.cols || archive.rows !== pane.rows
        || typeof archive.title !== 'string' || typeof archive.alt !== 'boolean') {
      throw new Error(`invalid cold screen for pane ${pane.id}`);
    }
    return archive;
  };
  const captureTerminalState = (term) => {
    const active = term.buffer.active;
    const internal = active._buffer;
    return {
      cursorX: active.cursorX,
      cursorY: active.cursorY,
      scrollTop: internal.scrollTop,
      scrollBottom: internal.scrollBottom,
    };
  };
  const applyTerminalState = (term, state) => {
    if (!state || !Number.isInteger(state.cursorX) || !Number.isInteger(state.cursorY)
        || !Number.isInteger(state.scrollTop) || !Number.isInteger(state.scrollBottom)) return;
    const internal = term.buffer.active._buffer;
    internal.x = Math.max(0, Math.min(term.cols, state.cursorX));
    internal.y = Math.max(0, Math.min(term.rows - 1, state.cursorY));
    internal.scrollTop = Math.max(0, Math.min(term.rows - 1, state.scrollTop));
    internal.scrollBottom = Math.max(internal.scrollTop, Math.min(term.rows - 1, state.scrollBottom));
  };
  const readColdArchive = async (pane, snapshot = pane.coldSnapshot) => {
    if (!snapshot || !validColdFile(pane.id, snapshot.file)) {
      throw new Error(`invalid cold screen reference for pane ${pane.id}`);
    }
    return decodeColdArchive(pane, await coldIO.readFile(snapshot.file));
  };
  const runRestore = (task) => new Promise((resolve, reject) => {
    restoreQueue.push({ task, resolve, reject });
    const pump = () => {
      while (activeRestores < COLD_RESTORE_CONCURRENCY && restoreQueue.length) {
        const next = restoreQueue.shift();
        activeRestores += 1;
        Promise.resolve().then(next.task).then(next.resolve, next.reject).finally(() => {
          activeRestores -= 1;
          pump();
        });
      }
    };
    pump();
  });
  const runFreeze = (task) => new Promise((resolve, reject) => {
    freezeQueue.push({ task, resolve, reject });
    const pump = () => {
      while (activeFreezes < COLD_FREEZE_CONCURRENCY && freezeQueue.length) {
        const next = freezeQueue.shift();
        activeFreezes += 1;
        Promise.resolve().then(next.task).then(next.resolve, next.reject).finally(() => {
          activeFreezes -= 1;
          pump();
        });
      }
    };
    pump();
  });
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
  // A daemon restart closes its host connection without detaching, and its bridges
  // re-attach under the same viewer ids moments later. Keep that viewer primary for a
  // grace period so the terminal neither drops to a scaled observer nor gets resized
  // by whichever viewer claims first; a viewer that never returns hands off as before.
  const clearPrimaryGrace = (pane) => {
    if (!pane.primaryGraceTimer) return;
    clearTimeout(pane.primaryGraceTimer);
    pane.primaryGraceTimer = null;
  };
  const holdPrimary = (pane, viewer) => {
    if (pane.primaryGraceTimer) clearTimeout(pane.primaryGraceTimer);
    pane.primaryGraceTimer = setTimeout(() => {
      pane.primaryGraceTimer = null;
      if (panes.get(pane.id) !== pane || pane.primary !== viewer) return;
      if ([...pane.attachments.values()].some((candidate) => candidate.viewer === viewer)) return;
      promotePrimary(pane);
    }, primaryReconnectGraceMs);
    pane.primaryGraceTimer.unref?.();
  };
  const detachPane = (connection, pane, preservePrimary = false, graceful = false) => {
    const attachment = pane.attachments.get(connection);
    pane.attachments.delete(connection);
    connection.attached.delete(pane.id);
    connection.pendingAttach.delete(pane.id);
    connection.viewers.delete(pane.id);
    if (!preservePrimary && attachment && pane.primary === attachment.viewer
        && ![...pane.attachments.values()].some((candidate) => candidate.viewer === attachment.viewer)) {
      if (graceful) holdPrimary(pane, attachment.viewer);
      else promotePrimary(pane);
    }
    scheduleFreeze(pane);
  };
  const detachConnection = (connection, preservePrimary = false, graceful = false) => {
    subscribers.delete(connection);
    connection.subscribed = false;
    for (const id of [...connection.attached]) {
      const pane = panes.get(id);
      if (pane) detachPane(connection, pane, preservePrimary, graceful);
    }
    if (!preservePrimary) {
      for (const [paneId, viewer] of connection.primaryClaims) {
        const pane = panes.get(paneId);
        if (pane && pane.primary === viewer) {
          if (graceful) holdPrimary(pane, viewer);
          else promotePrimary(pane);
        }
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
    else if (shouldLogPaneEvent(type, debugEvents)) eventLog(`host: ${type} ${pane.id}`);
  };

  const newTerminal = (cols, rows) => {
    const term = new Terminal({ cols, rows, scrollback: TERMINAL_SCROLLBACK, allowProposedApi: true });
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);
    return { term, serializer };
  };
  const watchTitle = (pane) => pane.term.onTitleChange((title) => {
    if (closing || retired || panes.get(pane.id) !== pane) return;
    if (pane.title === title) return;
    pane.title = title;
    emitPane('title', pane);
  });
  const disposeTerminal = (pane) => {
    try { pane.titleDisposable?.dispose(); } catch {}
    pane.titleDisposable = null;
    try { pane.term?.dispose(); } catch {}
    pane.term = null;
    pane.serializer = null;
  };
  const terminalWrite = (pane, data, terminalState = null) => {
    pane.modelDirty = true;
    pane.modelGeneration += 1;
    pane.writeChain = pane.writeChain.then(() => new Promise((resolve) => pane.term.write(data, () => {
      applyTerminalState(pane.term, terminalState);
      resolve();
    })));
    return pane.writeChain;
  };
  const canFreeze = (pane) => !closing && !retired && !reloading && !pane.alive && pane.term
    && pane.attachments.size === 0 && pane.pendingAttachments === 0 && pane.modelUsers === 0
    && panes.get(pane.id) === pane;
  const freezePane = async (pane) => {
    if (pane.freezePromise) return pane.freezePromise;
    pane.freezePromise = runFreeze(async () => {
      await settled(pane);
      if (!canFreeze(pane)) return false;
      if (!pane.modelDirty && pane.coldSnapshot) {
        pane.buffer.clear();
        disposeTerminal(pane);
        return true;
      }
      const currentTerm = pane.term;
      const generation = pane.modelGeneration;
      const archive = {
        version: 1,
        cols: pane.cols,
        rows: pane.rows,
        title: pane.title,
        alt: pane.term.buffer.active.type === 'alternate',
        terminalState: captureTerminalState(pane.term),
        screen: Buffer.from(pane.serializer.serialize({
          scrollback: TERMINAL_SCROLLBACK,
          excludeAltBuffer: false,
        }), 'utf8'),
        buffer: pane.buffer.contents(),
      };
      const file = path.join(coldDir, `${pane.id}-${crypto.randomBytes(8).toString('hex')}.xterm`);
      const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      try {
        await coldIO.mkdir(coldDir, { recursive: true, mode: 0o700 });
        await coldIO.writeFile(temporary, v8.serialize(archive), { flag: 'wx', mode: 0o600 });
        await coldIO.rename(temporary, file);
      } catch (error) {
        try { await coldIO.unlink(temporary); } catch {}
        eventLog(`host: could not freeze pane ${pane.id}: ${error.message}`);
        return false;
      }
      if (!canFreeze(pane) || pane.term !== currentTerm || pane.modelGeneration !== generation) {
        try { await coldIO.unlink(file); } catch {}
        const timer = setImmediate(() => scheduleFreeze(pane));
        if (typeof timer.unref === 'function') timer.unref();
        return false;
      }
      const previous = pane.coldSnapshot;
      pane.coldSnapshot = {
        file,
        size: archive.screen.length,
        rawBytes: archive.buffer.length,
        alt: archive.alt,
      };
      pane.modelDirty = false;
      pane.buffer.clear();
      disposeTerminal(pane);
      if (previous && previous.file !== file) await removeColdFile(pane, previous);
      return true;
    }).finally(() => { pane.freezePromise = null; });
    return pane.freezePromise;
  };
  const scheduleFreeze = (pane) => {
    if (pane.freezeScheduled || !canFreeze(pane)) return;
    pane.freezeScheduled = true;
    const timer = setImmediate(() => {
      pane.freezeScheduled = false;
      freezePane(pane).catch((error) => eventLog(`host: could not freeze pane ${pane.id}: ${error.message}`));
    });
    if (typeof timer.unref === 'function') timer.unref();
  };
  const restorePane = async (pane) => {
    if (pane.term) return pane.term;
    if (pane.restorePromise) return pane.restorePromise;
    const snapshot = pane.coldSnapshot;
    pane.restorePromise = runRestore(async () => {
      const archive = await readColdArchive(pane, snapshot);
      const created = newTerminal(pane.cols, pane.rows);
      try {
        await new Promise((resolve) => created.term.write(archive.screen, resolve));
        applyTerminalState(created.term, archive.terminalState);
        if (panes.get(pane.id) !== pane || pane.coldSnapshot !== snapshot) {
          throw new Error('pane process changed');
        }
        pane.term = created.term;
        pane.serializer = created.serializer;
        pane.buffer.clear();
        pane.buffer.push(archive.buffer);
        pane.bufferBytes = pane.buffer.size;
        pane.modelDirty = false;
        pane.titleDisposable = watchTitle(pane);
        return pane.term;
      } catch (error) {
        created.term.dispose();
        throw error;
      }
    }).finally(() => { pane.restorePromise = null; });
    return pane.restorePromise;
  };
  const withTerminal = async (pane, action) => {
    pane.modelUsers += 1;
    try {
      await restorePane(pane);
      if (panes.get(pane.id) !== pane) throw new Error('pane process changed');
      return await action();
    } finally {
      pane.modelUsers -= 1;
      scheduleFreeze(pane);
    }
  };

  const createPane = (record) => {
    const coldSnapshot = record.coldSnapshot || null;
    if (coldSnapshot && (record.alive || !validColdFile(String(record.id), coldSnapshot.file)
        || !Number.isInteger(coldSnapshot.rawBytes) || coldSnapshot.rawBytes < 0
        || typeof coldSnapshot.alt !== 'boolean')) {
      throw new Error('invalid cold screen in host handoff record');
    }
    const created = coldSnapshot ? null : newTerminal(record.cols, record.rows);
    let resolveExit;
    const exit = new Promise((resolve) => { resolveExit = resolve; });
    const pane = {
      id: record.id, cmd: record.cmd, args: record.args, cwd: record.cwd,
      cols: record.cols, rows: record.rows,
      term: created && created.term, serializer: created && created.serializer, pty: record.pty,
      meta: record.meta === undefined ? {} : record.meta,
      alive: record.alive,
      exitCode: record.exitCode == null ? null : record.exitCode,
      signal: record.signal == null ? null : record.signal,
      createdAt: record.createdAt,
      exitedAt: record.exitedAt || null,
      lastInputAt: record.lastInputAt || null,
      lastOutputAt: record.lastOutputAt || null,
      lastReadAt: record.lastReadAt || null,
      inputCount: Number.isInteger(record.inputCount) ? record.inputCount : 0,
      inputReceipts: inputReceiptMap(record.inputReceipts),
      outputCount: Number.isInteger(record.outputCount) ? record.outputCount : 0,
      title: record.title || '',
      // Viewer connections do not survive a reload. Let the first eligible viewer
      // to attach or type claim the adopted pane instead of retaining a ghost owner.
      primary: record.adopted ? null : (record.primary == null ? null : String(record.primary)),
      buffer: new RingBuffer(maxBufferBytes),
      bufferBytes: coldSnapshot ? coldSnapshot.rawBytes : 0,
      coldSnapshot,
      modelDirty: false,
      modelGeneration: 0,
      modelUsers: 0,
      freezePromise: null,
      freezeScheduled: false,
      restorePromise: null,
      attachments: new Map(),
      pendingAttachments: 0,
      writeChain: Promise.resolve(),
      exit,
      resolveExit,
      titleDisposable: null,
      dataDisposable: null,
      exitDisposable: null,
    };
    if (!coldSnapshot && record.buffer) pane.buffer.push(record.buffer);
    if (!coldSnapshot) pane.bufferBytes = pane.buffer.size;
    if (!pane.alive) resolveExit();
    panes.set(pane.id, pane);
    if (pane.term) pane.titleDisposable = watchTitle(pane);
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
          pane.handoffRecord.outputCount = (pane.handoffRecord.outputCount || 0) + 1;
        }
        return;
      }
      pane.buffer.push(data);
      pane.bufferBytes = pane.buffer.size;
      pane.outputCount += 1;
      pane.lastOutputAt = new Date().toISOString();
      if ([...pane.attachments.values()].some((attachment) => attachment.visible === true)) {
        pane.lastReadAt = pane.lastOutputAt;
      }
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
      scheduleFreeze(pane);
    });
    if (!coldSnapshot) {
      if (record.screen) {
        const stateOffset = Number.isInteger(record.terminalStateOffset)
          && record.terminalStateOffset >= 0 && record.terminalStateOffset <= record.screen.length
          ? record.terminalStateOffset : record.screen.length;
        terminalWrite(pane, record.screen.subarray(0, stateOffset), record.terminalState).catch(() => {});
        if (stateOffset < record.screen.length) {
          terminalWrite(pane, record.screen.subarray(stateOffset)).catch(() => {});
        }
      }
      else if (pane.buffer.size) terminalWrite(pane, pane.buffer.contents()).catch(() => {});
      if (!pane.alive) scheduleFreeze(pane);
    }
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
        createdAt: new Date().toISOString(), exitedAt: null, lastInputAt: null,
        lastOutputAt: null, lastReadAt: null,
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
        // guardedInput: input requests honour expectedPid and expectedInputCount
        // together. A caller gates on this before it sends a keystroke it would not
        // send unguarded, so the flag names the whole guard and not a part of it: a
        // host that checked only one of the two would have to advertise something
        // else, because what the caller is asking about is the pair.
        return { result: {
          version: 1, replaceExited: true, guardedKill: true, compactScreen: true, guardedInput: true,
          guardedInputReceipts: true,
          // transcript: this host answers the `transcript` verb (bin/node-transcript.js)
          // for the sessions it runs, which is how the daemon confirms a delivery to a
          // pane on this machine. A number, so a later shape can say it is a later one:
          // 2 adds `find`, the Codex rollouts written since a launch; 3 adds
          // `pi-event`, the Keep Pi extension's phase file for a session here; 4
          // adds `meta`, a Codex rollout's session_meta and last turn's model.
          transcript: TRANSCRIPT_VERSION,
          // artifacts: this host answers the `artifacts` verb (bin/session-artifacts.js),
          // which lists, reads, stages and publishes a session's files under one of
          // this node's own accounts, so a session can be moved onto or off it. 2 adds
          // `kind: 'codex'`: a Codex session's root and child-thread rollouts.
          artifacts: ARTIFACTS_VERSION,
          // stats: this host answers the `stats` verb (bin/node-stats.js): memory, swap,
          // CPU, disk, uptime, pane and agent counts, its versions and its clock offset.
          stats: STATS_VERSION,
          // inventory: this host answers the `inventory` verb (bin/node-inventory.js):
          // the tools, agent config directories, skills, MCP servers, repos and logins
          // this machine is set up with, which `keep node audit` diffs against the
          // daemon node's.
          inventory: INVENTORY_VERSION,
          // Set while an earlier inventory is stuck past its grace (see runInventory).
          inventoryStuck: inventoryStuck ? inventoryStuck.text : null,
          // spawnReceipts: a spawn naming an operationId is journalled, so a caller
          // whose reply was lost may ask again instead of starting a second process.
          spawnReceipts: true,
          bootVersion: options.boot && options.boot.version || null,
          panes: panes.size, pid: process.pid, sock,
          residentTerminals: [...panes.values()].filter((pane) => pane.term).length,
          coldTerminals: [...panes.values()].filter((pane) => !pane.term && pane.coldSnapshot).length,
          reloads: options.boot && options.boot.reloads || 0,
          lastReload: options.boot && options.boot.lastReload || null,
          // The node descriptor: who answered, on what machine, as which process.
          protocol: PROTOCOL_VERSION,
          node: nodeName,
          platform: process.platform,
          home: os.homedir(),
          execPath: process.execPath,
          shell: env.SHELL || null,
          bootId,
          hostname: os.hostname(),
          // Only when the node transport is configured, so a single-node install's
          // hello — and every report printed from it — stays exactly as it was.
          ...(tcpAddress ? { listen: tcpAddress } : {}),
          ...(tokenFile ? { tokenFile } : {}),
          ...(tcpError ? { listenError: tcpError.message } : {}),
        } };
      case 'spawn': {
        // `replay: true` says the caller is asking again about a spawn it already
        // sent. It is the whole contract: a replay may only ever be answered from
        // the journal, never by starting something. A host that has never heard of
        // the operation — a different host process, or a receipt evicted by the
        // bound — says so, and the caller is left to look rather than to spawn a
        // second agent on the same work.
        if (params.operationId === undefined) {
          if (params.replay === true) throw new Error('a spawn replay needs an operation id');
          const pane = spawnPane(params);
          return { result: { pane: publicPane(pane) } };
        }
        const operationId = String(params.operationId || '');
        if (!INPUT_OPERATION_PATTERN.test(operationId)) throw new Error('invalid spawn operation id');
        const fingerprint = spawnOperationFingerprint(params);
        const prior = spawnReceipts.get(operationId);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new Error('spawn operation parameters changed');
          const existing = panes.get(prior.paneId);
          // The pane id is the caller's to reuse, and `replace-exited` keeps it
          // across a new process. A pane wearing that id which is not the process
          // this operation started is somebody else's pane: say so rather than hand
          // it over as though this spawn had made it.
          if (existing && (existing.pty.pid !== prior.pid || existing.createdAt !== prior.createdAt)) {
            return { result: { pane: null, outcome: 'pane replaced' } };
          }
          // Gone, but it did run: the answer is what the caller was told at the
          // time, marked as no longer alive.
          if (!existing) return { result: { pane: { ...prior.pane, alive: false } } };
          return { result: { pane: publicPane(existing) } };
        }
        if (params.replay === true) throw new Error('unknown spawn operation');
        const pane = spawnPane(params);
        const snapshot = publicPane(pane);
        spawnReceipts.set(operationId, {
          fingerprint, paneId: pane.id, pid: pane.pty.pid, createdAt: pane.createdAt, pane: snapshot,
        });
        while (spawnReceipts.size > INPUT_RECEIPT_LIMIT) spawnReceipts.delete(spawnReceipts.keys().next().value);
        return { result: { pane: snapshot } };
      }
      case 'prepare-launch': {
        // The node-local half of a launch, run where the agent will run: this
        // machine's account config directory, its trust record, its `node` binary
        // and launcher path. The daemon node calls the same module in-process, so a
        // single-node install never arrives here. Required lazily because a node
        // agent may hold no Keep registry at all.
        //
        // A refusal travels as the protocol's own failure frame — { ok: false,
        // error, code } — so the caller can tell "this machine cannot prepare that
        // launch, and here is why" from "the host is gone", and hand the reason
        // straight to whoever asked. The code rides along: `shared-setup` is the
        // one the daemon turns back into its own 409.
        return { result: require('./launch-prep.js').prepare(params) };
      }
      case 'artifacts': {
        // A session's files, for a move between nodes. Every path is built here from
        // this node's own account directory and a relative path the module checks
        // against the shapes a session's artifacts can have; refusals carry a code.
        return { result: await require('./session-artifacts.js').handle(params, { env }) };
      }
      case 'process': {
        // This machine's process table, for this machine's panes. The bootId rides
        // along because a pid only means anything alongside the host that saw it:
        // a caller comparing two reads has to know they came from the same host
        // process, not from one that restarted in between.
        const inspected = await require('./process-table.js').inspect(params);
        return { result: { ...inspected, bootId } };
      }
      case 'usage': {
        // Read where the credentials are. Nothing on the daemon side is rewired by
        // this: accounts do not belong to a node yet, so the usage manager goes on
        // reading every account locally, exactly as it always has. This verb is what
        // a node can be *asked*, and what `keep nodes usage` asks it.
        return { result: await require('./usage.js').readAccountUsage(params.account) };
      }
      case 'signal': {
        // Judging a process on one machine and signalling it from another is no
        // judgement at all — the pid would be a number that happens to exist in
        // both tables. Here the comparison and the kill are one step, in the
        // process whose machine owns the pid.
        return { result: await require('./process-table.js').signal(params) };
      }
      case 'replace-exited': {
        const old = needPane(params.paneId);
        if (old.alive || old.pty.pid !== params.expectedPid || old.meta?.sessionId !== params.sessionId) {
          throw new Error('replacement requires the exact exited session process');
        }
        await settled(old);
        if (old.restorePromise) await old.restorePromise;
        if (old.freezePromise) await old.freezePromise;
        if (panes.get(old.id) !== old) throw new Error('session process changed during replacement');
        clearPrimaryGrace(old);
        panes.delete(old.id);
        let replacement;
        try { replacement = spawnPane({ ...params, meta: { ...old.meta, ...params.meta } }); }
        catch (error) { panes.set(old.id, old); throw error; }
        for (const connection of old.attachments.keys()) detachPane(connection, old, true);
        for (const disposable of [old.dataDisposable, old.exitDisposable, old.titleDisposable]) {
          try { disposable?.dispose(); } catch {}
        }
        disposeTerminal(old);
        await removeColdFile(old);
        return { result: { pane: publicPane(replacement) } };
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
        let operationId = null;
        let operationFingerprint = null;
        if (params.operationId !== undefined) {
          operationId = String(params.operationId || '');
          if (!INPUT_OPERATION_PATTERN.test(operationId)) throw new Error('invalid input operation id');
          if (!Number.isInteger(params.expectedInputCount) || !Number.isInteger(params.expectedPid)) {
            throw new Error('an input operation requires a guarded input');
          }
          if (params.auto === true) throw new Error('an input operation cannot be automatic input');
          operationFingerprint = inputOperationFingerprint(params);
          const prior = pane.inputReceipts.get(operationId);
          if (prior) {
            if (prior.fingerprint !== operationFingerprint) throw new Error('input operation parameters changed');
            return { result: { ...prior.result } };
          }
        }
        // An optional guard for a keystroke that is only safe to send while nothing
        // else has typed into the pane. A caller cannot do this for itself: it would
        // read the count, and a viewer's key could still land before its own write
        // arrived. Here the compare and the write are one step in the single process
        // that owns the counter, so nothing can slip between them. Without the
        // parameters this is the ordinary unconditional write it has always been.
        //
        // The pid is part of the guard and not optional beside the count, because
        // `replace-exited` keeps the pane id and starts the replacement's count at
        // zero: a keystroke captured at count N would otherwise be delivered to a
        // different process that happens to have seen N inputs of its own. Compared
        // the way `guarded-kill` compares it.
        if (params.expectedInputCount !== undefined || params.expectedPid !== undefined) {
          if (!Number.isInteger(params.expectedInputCount) || !Number.isInteger(params.expectedPid)) {
            throw new Error('a guarded input requires expectedInputCount and expectedPid as integers');
          }
          if (pane.pty.pid !== params.expectedPid) {
            const result = { dropped: true, reason: 'pane replaced', pid: pane.pty.pid, inputCount: pane.inputCount };
            if (operationId) rememberInputReceipt(pane, operationId, operationFingerprint, result);
            return { result };
          }
          if (pane.inputCount !== params.expectedInputCount) {
            const result = { dropped: true, reason: 'input arrived', inputCount: pane.inputCount };
            if (operationId) rememberInputReceipt(pane, operationId, operationFingerprint, result);
            return { result };
          }
        }
        const attachment = pane.attachments.get(connection);
        if (params.auto === true) {
          if (!attachment || pane.primary !== attachment.viewer) {
            return { result: { dropped: true } };
          }
          pane.lastInputAt = new Date().toISOString();
          pane.inputCount += 1;
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
        pane.lastInputAt = new Date().toISOString();
        pane.inputCount += 1;
        pane.pty.write(Buffer.from(String(params.data || ''), 'base64'));
        const result = operationId ? { accepted: true, inputCount: pane.inputCount } : {};
        if (operationId) rememberInputReceipt(pane, operationId, operationFingerprint, result);
        return { result };
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
        // A reconnecting viewer re-claims at the size it already set. Resizing the PTY
        // anyway sends SIGWINCH and makes a full-screen TUI redraw for nothing.
        if (cols === pane.cols && rows === pane.rows) {
          return { result: { pane: publicPane(pane), applied: true, primary: pane.primary } };
        }
        await settled(pane);
        if (!pane.alive) throw new Error('pane has exited');
        if (panes.get(pane.id) !== pane) throw new Error('pane process changed');
        pane.pty.resize(cols, rows);
        pane.term.resize(cols, rows);
        pane.cols = cols;
        pane.rows = rows;
        pane.modelDirty = true;
        pane.modelGeneration += 1;
        emitPane('resized', pane);
        return { result: { pane: publicPane(pane), applied: true, primary: pane.primary } };
      }
      case 'attach': {
        const pane = needPane(params.pane);
        if (connection.attached.has(pane.id)) throw new Error('already attached on this connection');
        const viewer = params.viewer == null ? connection.id : String(params.viewer);
        if (!viewer) throw new Error('viewer cannot be empty');
        const attachment = {
          viewer,
          primary: params.primary !== false,
          visible: params.visible === true,
          order: nextAttachOrder++,
          readsHistory: params.snapshot === true || params.replay !== false,
        };
        let pending;
        let history = null;
        pane.pendingAttachments += 1;
        try {
          await restorePane(pane);
          if (connection.dropped || connection.socket.destroyed || panes.get(pane.id) !== pane) {
            throw new Error('host connection closed');
          }
          if (params.snapshot === true) {
            const scrollback = snapshotScrollback(params.snapshotScrollback);
            await settled(pane);
            if (connection.dropped || connection.socket.destroyed || panes.get(pane.id) !== pane) {
              throw new Error('host connection closed');
            }
            // Serialization and registration as a live consumer are one synchronous
            // boundary: earlier bytes are in the snapshot and later bytes are captured.
            const serialized = pane.serializer.serialize({
              scrollback,
              excludeAltBuffer: false,
            });
            // What the snapshot left behind, so a viewer can offer "load earlier
            // output" only when there is earlier output to load.
            const available = pane.term.buffer.normal.baseY;
            history = { lines: available, sent: Math.min(available, scrollback), truncated: available > scrollback };
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
          if (attachment.visible === true && attachment.readsHistory) pane.lastReadAt = new Date().toISOString();
          connection.attached.add(pane.id);
          connection.viewers.set(pane.id, viewer);
          connection.pendingAttach.set(pane.id, pending);
          if (attachment.primary && pane.primary === null) setPrimary(pane, viewer);
          if (pane.primary === viewer) {
            // The viewer came back while still holding primary (see holdPrimary). It owns
            // the pane again, ordinary resizes included, whether or not it has focus.
            attachment.primary = true;
            if (pane.primaryGraceTimer) {
              clearTimeout(pane.primaryGraceTimer);
              pane.primaryGraceTimer = null;
            }
          }
        } catch (error) {
          detachPane(connection, pane);
          throw error;
        } finally {
          pane.pendingAttachments -= 1;
          scheduleFreeze(pane);
        }
        return {
          result: { pane: publicPane(pane), viewer, ...(history ? { history } : {}) },
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
      case 'visibility': {
        const pane = needPane(params.pane);
        const attachment = pane.attachments.get(connection);
        if (!attachment || typeof params.visible !== 'boolean') throw new Error('Expected attached viewer and boolean visibility');
        attachment.visible = params.visible;
        if (params.visible && attachment.readsHistory) pane.lastReadAt = new Date().toISOString();
        emitPane('visibility', pane);
        return { result: { pane: publicPane(pane) } };
      }
      case 'screen': {
        const pane = needPane(params.pane);
        return withTerminal(pane, async () => {
          await settled(pane);
          if (panes.get(pane.id) !== pane) throw new Error('pane process changed');
          return { result: renderScreen(pane.term, { lines: params.compact ? null : params.lines, scrollback: params.scrollback, title: pane.title, compact: params.compact === true }) };
        });
      }
      case 'clear': {
        const pane = needPane(params.pane);
        return withTerminal(pane, async () => {
          await settled(pane);
          if (panes.get(pane.id) !== pane) throw new Error('pane process changed');
          await removeColdFile(pane);
          pane.modelDirty = true;
          pane.modelGeneration += 1;
          pane.buffer.clear();
          pane.bufferBytes = 0;
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
        });
      }
      case 'guarded-kill': {
        const pane = needPane(params.pane);
        if (!Number.isInteger(params.expectedPid) || typeof params.expectedSessionId !== 'string'
            || !Number.isInteger(params.expectedInputCount) || !Number.isInteger(params.expectedOutputCount)) {
          throw new Error('guarded kill requires exact pane identity and activity counts');
        }
        if (pane.pty.pid !== params.expectedPid || pane.meta?.sessionId !== params.expectedSessionId
            || !['claude', 'codex'].includes(pane.meta?.agent)
            || pane.inputCount !== params.expectedInputCount || pane.outputCount !== params.expectedOutputCount
            || pane.attachments.size !== 0 || pane.pendingAttachments !== 0) {
          const error = new Error('Pane identity or activity changed; nothing signalled');
          error.code = 'guard_rejected';
          throw error;
        }
        if (pane.alive) pane.pty.kill(params.signal || 'SIGTERM');
        return { result: { pane: publicPane(pane) } };
      }
      case 'kill': {
        const pane = needPane(params.pane);
        // A caller that names the process it inspected must not signal a replacement.
        if (params.expectedPid !== undefined && pane.pty.pid !== params.expectedPid) {
          const error = new Error('Pane process changed; nothing signalled');
          error.code = 'guard_rejected';
          throw error;
        }
        if (pane.alive) pane.pty.kill(params.signal || 'SIGTERM');
        return { result: { pane: publicPane(pane) } };
      }
      case 'remove': {
        const pane = needPane(params.pane);
        if (pane.alive) throw new Error('pane is still alive');
        await settled(pane);
        if (pane.restorePromise) await pane.restorePromise;
        if (pane.freezePromise) await pane.freezePromise;
        if (panes.get(pane.id) !== pane) throw new Error('pane process changed');
        for (const connection of pane.attachments.keys()) detachPane(connection, pane);
        pane.attachments.clear();
        clearPrimaryGrace(pane);
        panes.delete(pane.id);
        emitPane('removed', pane);
        const record = publicPane(pane);
        for (const disposable of [pane.dataDisposable, pane.exitDisposable, pane.titleDisposable]) {
          try { if (disposable) disposable.dispose(); } catch {}
        }
        disposeTerminal(pane);
        await removeColdFile(pane);
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

  // A machine's stats (bin/node-stats.js). The CPU sample waits a quarter of a second
  // on a timer, so like a transcript read it runs beside the connection's queue and
  // never holds a keystroke behind it. Bounded, since each one runs a sample.
  let statsInFlight = 0;
  const STATS_IN_FLIGHT_MAX = 4;
  const runStats = (connection, socket, request) => {
    const respond = (response) => {
      if (socket.destroyed) return;
      connection.send(encodeFrame(response));
    };
    if (statsInFlight >= STATS_IN_FLIGHT_MAX) {
      respond({ ok: false, id: request.id, error: 'too many stats requests in flight', code: 'stats-busy' });
      return;
    }
    statsInFlight += 1;
    Promise.resolve()
      .then(() => require('./node-stats.js').readStats({
        // A test seam only: an injected statfs or deadline for the bounded read.
        ...(options.statsOptions || {}),
        now: request.now,
        panes: [...panes.values()].filter((pane) => pane.alive).length,
        hostVersion: {
          protocol: PROTOCOL_VERSION, transcript: TRANSCRIPT_VERSION, artifacts: ARTIFACTS_VERSION,
          stats: STATS_VERSION, inventory: INVENTORY_VERSION, boot: (options.boot && options.boot.version) || null,
        },
      }))
      .then((stats) => respond({ ok: true, id: request.id, stats }), (error) => {
        respond({ ok: false, id: request.id, error: error.message });
      })
      .catch(() => {})
      .finally(() => { statsInFlight -= 1; });
  };

  // What this machine is set up with (bin/node-inventory.js), for `keep node audit`.
  // It runs subprocesses for tens of seconds, so it runs beside the connection's
  // queue like stats, and one at a time: a second ask while one runs is refused.
  // The slot is held until the collection is idle, not only until it has answered:
  // past its deadline it answers at once, and whatever it started must be gone
  // before another may start beside it.
  // The wait for idle is bounded too: a filesystem call on a hung mount never
  // returns and cannot be cancelled. Past INVENTORY_IDLE_GRACE_MS after the answer
  // the slot is released anyway, and what was still running is recorded as
  // `inventoryStuck` (in the hello and in every answer) until it does return. While
  // it names the filesystem a new collection is refused: it would pile onto the same
  // hung mount and could take every libuv thread the host needs for its own work.
  let inventoryInFlight = 0;
  let inventoryStuck = null;
  const INVENTORY_IN_FLIGHT_MAX = 1;
  const INVENTORY_IDLE_GRACE_MS = options.inventoryIdleGraceMs == null ? 30e3 : options.inventoryIdleGraceMs;
  const runInventory = (connection, socket, request) => {
    const respond = (response) => {
      if (socket.destroyed) return;
      connection.send(encodeFrame(response));
    };
    if (inventoryInFlight >= INVENTORY_IN_FLIGHT_MAX) {
      respond({ ok: false, id: request.id, error: 'an inventory is already being collected', code: 'inventory-busy' });
      return;
    }
    // A realpath from an earlier audit that never returned holds a libuv thread just
    // as a stuck collection does, whether or not its audit was marked stuck.
    const scopeBounds = options.inventoryScopeBounds || {};
    const hungRealpaths = require('./node-inventory.js').realpathsInFlight(scopeBounds.realpath);
    if ((inventoryStuck && inventoryStuck.reason === 'filesystem') || hungRealpaths > 0) {
      respond({ ok: false, id: request.id, error: 'inventory-stuck: filesystem; reload the host to clear', code: 'inventory-stuck' });
      return;
    }
    inventoryInFlight += 1;
    let idle = null;
    let collection = null;
    // Recorded as an object, and cleared only by the same one, so an earlier stuck
    // collection returning never clears a later one that is still stuck.
    const markStuck = (reason, pending) => {
      const record = { reason, text: `inventory stuck: ${reason}` };
      inventoryStuck = record;
      eventLog(`host: ${record.text}; its slot is released`);
      if (pending) Promise.resolve(pending).then(() => { if (inventoryStuck === record) inventoryStuck = null; }, () => {});
    };
    const waitIdle = () => {
      if (!idle) return undefined;
      let timer;
      const grace = new Promise((resolve) => { timer = setTimeout(() => resolve(false), INVENTORY_IDLE_GRACE_MS); });
      return Promise.race([Promise.resolve(idle).then(() => true, () => true), grace]).then((settled) => {
        clearTimeout(timer);
        if (settled) return;
        const counts = typeof collection.stats === 'function' ? collection.stats() : {};
        markStuck(counts.fsActive ? 'filesystem' : counts.active ? 'subprocess' : 'unknown', idle);
      });
    };
    Promise.resolve()
      .then(async () => {
        const inventory = require('./node-inventory.js');
        // Test seams only: a fake home and no tool or login reads, or a whole
        // replacement for the collection.
        const seam = options.inventoryOptions || {};
        const start = options.inventoryStart || inventory.startInventory;
        let scope;
        try {
          scope = await inventory.requestOptions(request, seam.home || os.homedir(), options.inventoryScopeBounds || {});
        } catch (error) {
          // A realpath on a hung mount that never returned: nothing will clear it but a
          // reload, and the next ask would only pile onto it.
          if (error && error.code === 'scope-timeout') markStuck('filesystem', null);
          throw error;
        }
        // Never the account list here: it is read synchronously, and the host's loop
        // carries keystrokes. A node without a requested directory looks at the
        // agents' default ones.
        collection = start({ useAccounts: false, ...seam, ...scope });
        idle = collection.idle;
        const entries = await collection.result;
        return { lines: inventory.toLines(entries), partial: inventory.partialOf(entries) || false };
      })
      .then(({ lines, partial }) => respond({
        ok: true, id: request.id, inventory: lines, partial, stuck: inventoryStuck ? inventoryStuck.text : null, version: INVENTORY_VERSION,
      }), (error) => {
        respond({ ok: false, id: request.id, error: error.message, ...(error && error.code ? { code: error.code } : {}) });
      })
      .catch(() => {})
      .then(waitIdle)
      .catch(() => {})
      .finally(() => { inventoryInFlight -= 1; });
  };

  let transcriptsInFlight = 0;
  const TRANSCRIPTS_IN_FLIGHT_MAX = 32;
  const runTranscript = (connection, socket, request) => {
    const respond = (response) => {
      if (socket.destroyed) return;
      connection.send(encodeFrame(response));
    };
    if (transcriptsInFlight >= TRANSCRIPTS_IN_FLIGHT_MAX) {
      respond({ ok: false, id: request.id, error: 'too many transcript requests in flight', code: 'transcript-busy' });
      return;
    }
    transcriptsInFlight += 1;
    Promise.resolve()
      .then(() => require('./node-transcript.js').handle(request, { env, closed: () => socket.destroyed }))
      .then((result) => respond({ ok: true, id: request.id, ...result }), (error) => {
        const response = { ok: false, id: request.id, error: error.message };
        if (error && error.code) response.code = String(error.code);
        respond(response);
      })
      .catch(() => {})
      .finally(() => { transcriptsInFlight -= 1; });
  };

  const acceptConnection = (socket, transport) => {
    const remote = transport === 'tcp' ? String(socket.remoteAddress || 'unknown') : 'unix';
    // The unix socket is reachable only by this account, so it stays token-free;
    // a network connection says who it is in its first frame or says nothing more.
    let authenticated = transport !== 'tcp';
    let refused = false;
    let helloTimer = null;
    if (transport === 'tcp') {
      socket.setNoDelay(true);
      // A connection that has not said who it is has one job and a short deadline to
      // do it in; that deadline, not a refusal to accept, is what bounds the sockets
      // an unauthenticated caller can hold open.
      helloTimer = setTimeout(() => { if (!authenticated) socket.destroy(); }, HELLO_DEADLINE_MS);
      helloTimer.unref?.();
    }
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
      if (refused) return;
      if (!authenticated) {
        if (!request || typeof request !== 'object' || request.type !== 'hello' || !tokenAccepted(request.token)) {
          refused = true;
          const throttled = noteHelloFailure(remote);
          eventLog(`host: refused node connection from ${remote}: hello required${throttled ? ' (throttled)' : ''}`);
          // Over the limit the connection is dropped where it stands: a guess gets
          // no answer, not even the courtesy of one.
          if (throttled) { socket.destroy(); return; }
          const frame = encodeFrame({ ok: false, id: (request && request.id) || null, error: 'hello required' });
          try { socket.end(frame, () => socket.destroy()); } catch { socket.destroy(); }
          return;
        }
        authenticated = true;
        if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
        helloFailures.delete(remote);
        eventLog(`host: node connection from ${remote} accepted`);
      }
      if (reloading) {
        connection.send(encodeFrame({
          ok: false,
          id: request && request.id,
          error: 'host reloading',
          code: 'reloading',
        }));
        return;
      }
      // A transcript read may wait up to nine seconds for a line to appear, and the
      // connection's queue answers one request at a time: run it beside the queue, so
      // a long poll never holds back a keystroke or a screen read behind it. Bounded
      // per host, since each one holds a descriptor and a timer.
      if (request && typeof request === 'object' && request.type === 'transcript') {
        runTranscript(connection, socket, request);
        return;
      }
      if (request && typeof request === 'object' && request.type === 'stats') {
        runStats(connection, socket, request);
        return;
      }
      if (request && typeof request === 'object' && request.type === 'inventory') {
        runInventory(connection, socket, request);
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
      if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
      connections.delete(connection);
      detachConnection(connection, handingOff, true);
    });
  };

  server.on('connection', (socket) => acceptConnection(socket, 'unix'));
  if (tcpServer) tcpServer.on('connection', (socket) => acceptConnection(socket, 'tcp'));

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

  // Kept out of the unix lock/probe/unlink dance on purpose: the node transport owns
  // no file, and it must never be able to make the local socket fail to come up.
  const openTcpServer = async () => {
    if (!tcpServer) {
      if (tcpError) eventLog(`host: node transport disabled: ${tcpError.message}`);
      return;
    }
    if (tcpServer.listening) return;
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { tcpServer.removeListener('listening', onListening); reject(error); };
        const onListening = () => { tcpServer.removeListener('error', onError); resolve(); };
        tcpServer.once('error', onError);
        tcpServer.once('listening', onListening);
        try {
          tcpServer.listen({ host: listenTarget.address, port: listenTarget.port });
        } catch (error) {
          tcpServer.removeListener('error', onError);
          tcpServer.removeListener('listening', onListening);
          reject(error);
        }
      });
      tcpAddress = formatListenAddress(tcpServer.address()) || String(listenSpec);
      tcpError = null;
      eventLog(`host: node transport listening ${tcpAddress} pid ${process.pid}`);
    } catch (error) {
      tcpError = error;
      tcpAddress = null;
      eventLog(`host: could not listen on ${listenSpec}: ${error.message}`);
    }
  };

  const closeTcpServer = () => new Promise((resolve) => {
    if (!tcpServer || !tcpServer.listening) {
      tcpAddress = null;
      return resolve();
    }
    tcpServer.close(() => { tcpAddress = null; resolve(); });
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
      await openTcpServer();
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
    try { if (pane.restorePromise) await pane.restorePromise; } catch {}
    try { if (pane.freezePromise) await pane.freezePromise; } catch {}
    for (const disposable of [pane.dataDisposable, pane.exitDisposable, pane.titleDisposable]) {
      try { if (disposable) disposable.dispose(); } catch {}
    }
    disposeTerminal(pane);
    await removeColdFile(pane);
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
      // Handed over with the socket: the replacement core binds the same port, so
      // this one must let go of it before that bind, on both paths below.
      const tcpClosed = closeTcpServer();
      let record;
      try {
      let drainTimer;
      await Promise.race([
        Promise.allSettled([...connections].map((connection) => connection.queue)),
        new Promise((resolve) => { drainTimer = setTimeout(resolve, HANDOFF_DRAIN_MS); }),
      ]);
      if (drainTimer) clearTimeout(drainTimer);

      await Promise.all([...panes.values()].map(async (pane) => {
        await settled(pane).catch(() => {});
        if (pane.freezePromise) await pane.freezePromise;
        if (pane.restorePromise) await pane.restorePromise;
      }));
      const coldArchives = new Map();
      for (const pane of panes.values()) {
        if (pane.coldSnapshot && !pane.modelDirty) {
          coldArchives.set(pane, await readColdArchive(pane));
        }
      }
      // Live PTYs may emit while cold archives are read. Settle once more, then
      // capture every record without yielding so output and exit callbacks are
      // either in the record or appended through handoffRecord after retirement.
      await Promise.all([...panes.values()].map((pane) => settled(pane).catch(() => {})));
      const paneRecords = [];
      for (const pane of panes.values()) {
        const reusableCold = pane.coldSnapshot && !pane.modelDirty;
        const archive = reusableCold ? coldArchives.get(pane) : null;
        const screen = archive ? archive.screen : Buffer.from(pane.serializer.serialize({
          scrollback: TERMINAL_SCROLLBACK,
          excludeAltBuffer: false,
        }), 'utf8');
        paneRecords.push({
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
          lastInputAt: pane.lastInputAt,
          lastOutputAt: pane.lastOutputAt,
          lastReadAt: pane.lastReadAt,
          inputCount: pane.inputCount,
          inputReceipts: [...pane.inputReceipts].map(([id, receipt]) => ({ id, ...receipt })),
          outputCount: pane.outputCount,
          title: pane.title,
          pid: pane.pty.pid,
          pty: pane.pty,
          buffer: archive ? archive.buffer : pane.buffer.contents(),
          screen,
          terminalState: archive ? archive.terminalState : captureTerminalState(pane.term),
          terminalStateOffset: screen.length,
          coldSnapshot: reusableCold ? pane.coldSnapshot : null,
          primary: null,
        });
      }
      record = {
        version: 1,
        sock,
        bootId,
        // Every receipt, including one whose pane is gone. Dropping those turned
        // remove-then-reload into a host that had never heard of the operation, and
        // a caller replaying it would have been told to look for a pane that had in
        // fact run. The receipt can still answer that honestly; the journal is the
        // record of what happened, not a list of what is still alive.
        spawnReceipts: [...spawnReceipts].map(([id, receipt]) => ({ id, ...receipt })),
        panes: paneRecords,
      };
      } catch (error) {
        // Nothing has been handed over yet: this core stays the owner. Reopen the
        // endpoint (server.close() leaves the socket file behind) and clear the
        // flags so requests flow again; the bootstrap keeps us while `serving` is true.
        dropAllConnections();
        for (const pane of panes.values()) {
          clearPrimaryGrace(pane);
          setPrimary(pane, null);
        }
        await serverClosed.catch(() => {});
        await tcpClosed.catch(() => {});
        listening = false;
        try { unlink(sock); } catch {}
        await startServer();
        fs.chmodSync(sock, 0o600);
        listening = true;
        endpointOwned = true;
        await openTcpServer();
        reloading = false;
        handingOff = false;
        handoffPromise = null;
        throw error;
      }
      for (const pane of panes.values()) {
        pane.handoffRecord = record.panes.find((candidate) => candidate.id === pane.id);
      }
      // A grace timer would keep this retired core's panes alive and could emit a
      // primary change from it; the adopting core starts with no primary anyway.
      for (const pane of panes.values()) clearPrimaryGrace(pane);
      retired = true;
      dropAllConnections();
      await serverClosed;
      await tcpClosed;
      listening = false;
      endpointOwned = false;
      for (const pane of panes.values()) {
        try { if (pane.titleDisposable) pane.titleDisposable.dispose(); } catch {}
        try { pane.term?.dispose(); } catch {}
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

      for (const pane of panes.values()) clearPrimaryGrace(pane);
      for (const connection of connections) {
        detachConnection(connection);
        connection.socket.destroy();
      }
      connections.clear();
      subscribers.clear();
      try { await closeServer(); } finally { listening = false; }
      await closeTcpServer();
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
    node: nodeName, bootId, tokenFile,
    get listenAddress() { return tcpAddress; },
    get listenError() { return tcpError; },
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
  DEFAULT_SNAPSHOT_SCROLLBACK,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  STATS_VERSION,
  INVENTORY_VERSION,
  canonicalIp,
  linkLocalIp,
  unmapIpv4,
  assertBindable,
  parseListenAddress,
  readNodeToken,
  RingBuffer,
  FrameDecoder,
  encodeFrame,
  decodeFrame,
  renderScreen,
  hostLogFile,
  rotateHostLog,
  createHostLogger,
  shouldLogPaneEvent,
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
