#!/usr/bin/env node
// The broker. Edge spawns exactly one of these when the extension's service worker
// calls connectNative, and kills it when the worker dies. It owns the Unix socket and
// multiplexes any number of MCP server processes onto the single native port.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";

import { TOOL_NAMES } from "../mcp/tools.js";
import {
  ChunkAssembler,
  EXTENSION_ORIGIN,
  LineDecoder,
  NativeDecoder,
  PING_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  chunkMessage,
  encodeLine,
  encodeNative,
  logPath,
  readDaemonConfig,
  runtimeDir,
  socketPath,
} from "./protocol.js";

const DIR = runtimeDir();
const SOCKET = socketPath();
const LOG = logPath();
const MAX_LOG_BYTES = 1024 * 1024;
// Only the tests set this; 90 s is the real per-request budget.
const TIMEOUT_MS = Number(process.env.BROWSER_BRIDGE_REQUEST_TIMEOUT_MS) || REQUEST_TIMEOUT_MS;

/**
 * Nothing this host sends the extension may collide with a request from an earlier
 * host: the extension can outlive us and answer a stale id against the new port.
 */
const WIRE_NONCE = `${process.pid.toString(36)}${randomBytes(4).toString("hex")}`;

/** Methods a socket client may ask us to forward: the tools, and nothing else. */
const FORWARDABLE = new Set(TOOL_NAMES);

/**
 * What a viewer may ask for, and all it may ask for: a live view of a session's tabs for
 * Owner, from the Keep console. A viewer is not a session and never gets the tools; a
 * session never gets these.
 */
const VIEWER_METHODS = new Set([
  "viewer_tab_owner",
  "viewer_tabs",
  "viewer_start",
  "viewer_ack",
  "viewer_input",
  "viewer_navigate",
  "viewer_stop",
]);

/**
 * A viewer can watch and drive any session's tabs, so saying hello as one takes the
 * daemon token: the same file that lets a process drive the browser at all.
 */
function viewerTokenAccepted(offered) {
  const expected = readDaemonConfig()?.token;
  if (typeof offered !== "string" || !offered || !expected) return false;
  const digest = (text) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(offered), digest(expected));
}

/** Frames queue behind this much unsent data on a viewer's socket, then are dropped. */
const MAX_VIEWER_BACKLOG_BYTES = 4 * 1024 * 1024;
const viewerRoutes = new Map(); // wire viewer id -> {client, viewer}

let logStream = null;

function log(...parts) {
  const line = `${new Date().toISOString()} [${process.pid}] ${parts.join(" ")}\n`;
  if (logStream) logStream.write(line);
}

/**
 * The runtime directory holds the socket and the log, so it is checked before either is
 * touched: a real directory, ours, and not readable by anyone else.
 */
function ensureRuntimeDir() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(DIR);
  if (!stat.isDirectory()) throw new Error(`${DIR} is not a directory`);
  if (stat.uid !== process.getuid()) throw new Error(`${DIR} is not owned by this user`);
  if (stat.mode & 0o077) fs.chmodSync(DIR, 0o700);
}

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/**
 * Open the log, rotating it in place if it has grown past the cap.
 *
 * The path is touched exactly once, by the lstat. Everything after that goes through
 * the descriptor and is checked against what the lstat saw, so a file swapped for a
 * symlink in the gap is refused rather than followed, truncated or written through.
 */
function openLog() {
  let existing = null;
  try {
    existing = fs.lstatSync(LOG);
  } catch {
    existing = null; // first run
  }

  if (!existing) {
    const fd = fs.openSync(
      LOG,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | NOFOLLOW,
      0o600,
    );
    logStream = fs.createWriteStream(null, { fd });
    return;
  }

  if (existing.isSymbolicLink()) throw new Error(`${LOG} is a symlink`);
  if (!existing.isFile()) throw new Error(`${LOG} is not a regular file`);
  if (existing.uid !== process.getuid()) throw new Error(`${LOG} is not owned by this user`);

  // O_APPEND from the start: two hosts overlapping for a moment must interleave lines
  // rather than overwrite each other from a fixed offset.
  const fd = fs.openSync(LOG, fs.constants.O_RDWR | fs.constants.O_APPEND | NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    // The descriptor must be the very file the lstat approved.
    if (!opened.isFile() || opened.uid !== process.getuid()) {
      throw new Error(`${LOG} is not a regular file owned by this user`);
    }
    if (opened.dev !== existing.dev || opened.ino !== existing.ino) {
      throw new Error(`${LOG} was replaced while it was being opened`);
    }
    if (opened.size > MAX_LOG_BYTES) {
      // Keep only the tail: this file is append-only across every host start. Reads take
      // an explicit position, and an O_APPEND write after the truncation lands at 0.
      const keep = Buffer.allocUnsafe(MAX_LOG_BYTES);
      fs.readSync(fd, keep, 0, MAX_LOG_BYTES, opened.size - MAX_LOG_BYTES);
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, keep, 0, keep.length);
    }
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  // Same descriptor, appending: the path is never resolved again.
  logStream = fs.createWriteStream(null, { fd });
}

// --- extension port -------------------------------------------------------

const decoder = new NativeDecoder();
// An evicted partial is a reply that will never arrive. Whoever asked for it hears so
// now rather than waiting out the request timeout for nothing.
const assembler = new ChunkAssembler({
  onEvict: (wireId, reason) => {
    log("dropped a partial reply:", wireId, reason);
    failPending(wireId, `the browser's reply was dropped before it completed: ${reason}`);
  },
});

let extensionVersion = null;
let extensionReady = false;

function sendToExtension(message) {
  for (const frame of chunkMessage(message)) {
    process.stdout.write(encodeNative(frame));
  }
}

// --- clients --------------------------------------------------------------

let nextClientId = 1;
const clients = new Map(); // clientId -> client
const pending = new Map(); // wireId -> {client, clientRequestId, timer}

function describeClient(client) {
  return `${client.name || "unnamed"} (${client.sessionKey ? client.sessionKey.slice(0, 8) : "-"})`;
}

function replyToClient(client, id, ok, payload) {
  if (client.socket.destroyed) return;
  const message = ok ? { id, ok: true, result: payload } : { id, ok: false, error: payload };
  try {
    client.socket.write(encodeLine(message));
  } catch (error) {
    // A result too big for the line cap still has to become a visible error.
    if (ok) replyToClient(client, id, false, { message: error.message });
    else log("failed to write error to client:", error.message);
  }
}

function hostStatus() {
  return {
    hostPid: process.pid,
    socket: SOCKET,
    extensionConnected: extensionReady,
    extensionVersion,
    sessions: [...clients.values()]
      .filter((c) => c.sessionKey)
      .map((c) => ({
        sessionKey: c.sessionKey,
        name: c.name,
        agent: c.agent,
        account: c.account,
        connectedAt: c.connectedAt,
      })),
  };
}

/** The extension titles the tab group with the session name, so it needs it up front. */
function announceSession(client) {
  if (!extensionReady || !client.sessionKey) return;
  sendToExtension({
    method: "session_hello",
    params: {
      sessionKey: client.sessionKey,
      name: client.name,
      agent: client.agent,
      account: client.account,
    },
  });
}

/** Ids have to survive a JSON round trip and be usable as a Map key. */
function validRequestId(id) {
  if (typeof id === "string") return id.length > 0 && id.length <= 200;
  return typeof id === "number" && Number.isFinite(id);
}

function forward(client, message) {
  const wireId = `w${WIRE_NONCE}_${client.id}_${message.id}`;
  const timer = setTimeout(() => {
    pending.delete(wireId);
    replyToClient(client, message.id, false, {
      message: `Timed out after ${Math.round(TIMEOUT_MS / 1000)}s waiting for the browser extension (${message.method})`,
    });
  }, TIMEOUT_MS);
  timer.unref?.();
  pending.set(wireId, { client, clientRequestId: message.id, timer });
  try {
    sendToExtension({
      id: wireId,
      sessionKey: client.sessionKey,
      // Carried on every request: the extension may not have stored session_hello yet
      // when the first tabs_context_mcp arrives right behind it.
      session: { name: client.name, agent: client.agent, account: client.account },
      method: message.method,
      params: message.params ?? {},
    });
  } catch (error) {
    // Nothing went out, so the client hears about it now instead of at the timeout.
    failPending(wireId, `the request could not be sent to the browser: ${error.message}`);
  }
}

/**
 * A viewer names its views with its own ids; the extension sees them prefixed with this
 * host and client, so two clients' "v1" never meet and events find their way back. A
 * request without an id (an ack) is fire-and-forget.
 */
function forwardViewer(client, message) {
  const params = { ...(message.params ?? {}) };
  if (params.viewer !== undefined) {
    if (typeof params.viewer !== "string" || !params.viewer || params.viewer.length > 100) {
      replyToClient(client, message.id ?? null, false, { message: "viewer must be a short string" });
      return;
    }
    const wireViewer = `v${WIRE_NONCE}_${client.id}_${params.viewer}`;
    if (message.method === "viewer_start") viewerRoutes.set(wireViewer, { client, viewer: params.viewer });
    if (message.method === "viewer_stop") viewerRoutes.delete(wireViewer);
    params.viewer = wireViewer;
  }
  const forwarded = { method: message.method, params };
  if (message.id === undefined || message.id === null) {
    try {
      sendToExtension(forwarded);
    } catch (error) {
      log("could not forward a viewer notification:", error.message);
    }
    return;
  }
  forward(client, { ...forwarded, id: message.id });
}

/**
 * An event for one view goes to the client that started it and nobody else. A client
 * too far behind loses the frame, and the extension is told it was taken, so the stream
 * keeps going with the next picture instead of stalling on an ack that will never come.
 */
function routeViewerEvent(message) {
  const route = viewerRoutes.get(message.viewer);
  if (!route || route.client.socket.destroyed) {
    // Nobody will ack a frame for a view that is gone; release it so the tab's
    // screencast is not left waiting on it.
    if (message.event === "viewer_frame") sendToExtension({ method: "viewer_ack", params: { viewer: message.viewer } });
    return;
  }
  const { client } = route;
  if (message.event === "viewer_frame" && client.socket.writableLength > MAX_VIEWER_BACKLOG_BYTES) {
    sendToExtension({ method: "viewer_ack", params: { viewer: message.viewer } });
    return;
  }
  // Routes go only with a viewer_stop or the client: a late "stopped" from a start that
  // failed must not take the route of the start that followed it.
  try {
    client.socket.write(encodeLine({ ...message, viewer: route.viewer }));
  } catch (error) {
    log("could not deliver a viewer event:", error.message);
    if (message.event === "viewer_frame") {
      sendToExtension({ method: "viewer_ack", params: { viewer: message.viewer } });
    }
  }
}

/** Answer a client whose in-flight request can never complete, and forget it. */
function failPending(wireId, message) {
  const entry = pending.get(wireId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(wireId);
  replyToClient(entry.client, entry.clientRequestId, false, { message });
  return true;
}

function onClientMessage(client, message) {
  if (message == null || typeof message !== "object" || typeof message.method !== "string") {
    replyToClient(client, null, false, { message: "malformed request" });
    return;
  }
  if (message.id !== undefined && message.id !== null && !validRequestId(message.id)) {
    replyToClient(client, null, false, { message: "id must be a short string or a number" });
    return;
  }
  if (!client.sessionKey && !client.viewer) {
    if (message.method !== "hello") {
      replyToClient(client, message.id ?? null, false, { message: "first message must be hello" });
      client.socket.end();
      return;
    }
    const params = message.params ?? {};
    if (params.viewer === true) {
      if (!viewerTokenAccepted(params.token)) {
        log("refused a viewer hello: wrong or missing token");
        replyToClient(client, message.id ?? null, false, { message: "a viewer hello needs the daemon token" });
        client.socket.end();
        return;
      }
      client.viewer = true;
      client.name = typeof params.name === "string" ? params.name.slice(0, 80) : "viewer";
      log("viewer hello from", client.name);
      replyToClient(client, message.id ?? null, true, hostStatus());
      return;
    }
    if (typeof params.sessionKey !== "string" || params.sessionKey.length < 8) {
      replyToClient(client, message.id ?? null, false, { message: "hello needs a sessionKey" });
      client.socket.end();
      return;
    }
    client.sessionKey = params.sessionKey;
    client.name = typeof params.name === "string" ? params.name : "unnamed";
    client.agent = params.agent ?? null;
    client.account = params.account ?? null;
    log("hello from", describeClient(client));
    replyToClient(client, message.id ?? null, true, hostStatus());
    announceSession(client);
    return;
  }

  if (message.method === "hello") {
    replyToClient(client, message.id, true, hostStatus());
    return;
  }
  if (message.method === "bye") {
    replyToClient(client, message.id, true, { ok: true });
    client.socket.end();
    return;
  }
  if (message.method === "host_status") {
    replyToClient(client, message.id, true, hostStatus());
    return;
  }
  if (client.viewer) {
    if (!VIEWER_METHODS.has(message.method)) {
      replyToClient(client, message.id ?? null, false, { message: `Unknown method: ${message.method}` });
      return;
    }
    if (!extensionReady) {
      replyToClient(client, message.id ?? null, false, {
        message: "the browser extension has not finished connecting",
      });
      return;
    }
    forwardViewer(client, message);
    return;
  }
  // A session renames only itself: the name travels with its own requests, and the
  // extension retitles its own group when it changes.
  if (message.method === "rename") {
    const name = typeof message.params?.name === "string" ? message.params.name.slice(0, 200) : "";
    if (!name) {
      replyToClient(client, message.id, false, { message: "rename needs a name" });
      return;
    }
    log("rename", describeClient(client), "->", JSON.stringify(name));
    client.name = name;
    replyToClient(client, message.id, true, { ok: true });
    announceSession(client);
    return;
  }
  // session_hello, session_closed and ping are ours to send, never a client's: a client
  // that could name them could rename or evict another session's tab group.
  if (!FORWARDABLE.has(message.method)) {
    replyToClient(client, message.id, false, { message: `Unknown method: ${message.method}` });
    return;
  }
  if (!extensionReady) {
    replyToClient(client, message.id, false, {
      message: "the browser extension has not finished connecting",
    });
    return;
  }
  forward(client, message);
}

function onClientClose(client) {
  clients.delete(client.id);
  for (const [wireId, entry] of pending) {
    if (entry.client === client) {
      clearTimeout(entry.timer);
      pending.delete(wireId);
    }
  }
  for (const [wireViewer, route] of viewerRoutes) {
    if (route.client !== client) continue;
    viewerRoutes.delete(wireViewer);
    if (extensionReady) {
      sendToExtension({ method: "viewer_stop", params: { viewer: wireViewer, reason: "the viewer disconnected" } });
    }
  }
  if (!client.sessionKey) return;
  const stillOpen = [...clients.values()].some((c) => c.sessionKey === client.sessionKey);
  if (stillOpen) return;
  log("session closed", describeClient(client));
  if (extensionReady) {
    sendToExtension({ method: "session_closed", params: { sessionKey: client.sessionKey } });
  }
}

function onExtensionMessage(raw) {
  let message;
  try {
    message = assembler.accept(raw);
  } catch (error) {
    // The reply is unusable. If we know whose it was, say so now: the alternative is
    // that client sitting out the full 90 s timeout for a result that will never come.
    log("chunk error:", error.message);
    if (typeof raw?.id === "string") {
      failPending(raw.id, `the browser's reply could not be reassembled: ${error.message}`);
    }
    return;
  }
  if (message === null) return;

  if (message.event === "ready") {
    extensionReady = true;
    extensionVersion = message.version ?? null;
    log("extension ready", extensionVersion ?? "");
    // Clients that said hello before the port was up still need announcing.
    for (const client of clients.values()) announceSession(client);
    return;
  }
  if (message.event === "viewer_frame" || message.event === "viewer_state") {
    routeViewerEvent(message);
    return;
  }
  if (message.event === "pong" || message.event === "log") {
    if (message.event === "log") log("extension:", message.text ?? "");
    return;
  }
  if (typeof message.id !== "string") return;
  const entry = pending.get(message.id);
  if (!entry) return; // a late reply after a timeout
  clearTimeout(entry.timer);
  pending.delete(message.id);
  replyToClient(
    entry.client,
    entry.clientRequestId,
    message.ok !== false,
    message.ok !== false ? message.result : (message.error ?? { message: "unknown error" }),
  );
}

// --- socket ---------------------------------------------------------------

/**
 * Bind the socket only where it is safe to: our own 0700 directory, and never over a
 * path someone else could have planted. A socket that nobody answers is a leftover
 * from a host that was killed, so it is ours to remove.
 */
function secureBind(server) {
  ensureRuntimeDir();

  let existing = null;
  try {
    existing = fs.lstatSync(SOCKET);
  } catch {
    // nothing there, the common case
  }
  if (existing) {
    if (!existing.isSocket()) throw new Error(`${SOCKET} exists and is not a socket`);
    if (existing.uid !== process.getuid()) throw new Error(`${SOCKET} is not owned by this user`);
  }

  return new Promise((resolve, reject) => {
    const bound = () => {
      fs.chmodSync(SOCKET, 0o600);
      // Remember exactly which file we created, so shutdown cannot unlink a socket a
      // later host bound at the same path.
      const stat = fs.statSync(SOCKET);
      boundSocket = { dev: stat.dev, ino: stat.ino };
      resolve();
    };
    server.once("error", (error) => {
      if (error.code !== "EADDRINUSE") return reject(error);
      // Live host or corpse? Ask it.
      const probe = net.connect(SOCKET);
      probe.setTimeout(1000);
      probe.on("connect", () => {
        probe.destroy();
        reject(new Error("another Browser Bridge host is already listening"));
      });
      const takeOver = () => {
        probe.destroy();
        try {
          fs.unlinkSync(SOCKET);
        } catch {
          // raced with another host; the listen below will fail loudly
        }
        server.once("error", reject);
        server.listen(SOCKET, bound);
      };
      probe.on("timeout", takeOver);
      probe.on("error", takeOver);
    });
    server.listen(SOCKET, bound);
  });
}

let shuttingDown = false;
let boundSocket = null;

/** Only ever remove the socket file this process created. */
function removeOwnSocket() {
  if (!boundSocket) return;
  try {
    const stat = fs.lstatSync(SOCKET);
    if (stat.isSocket() && stat.dev === boundSocket.dev && stat.ino === boundSocket.ino) {
      fs.unlinkSync(SOCKET);
    }
  } catch {
    // already removed, or replaced by a newer host's socket, which is not ours to touch
  }
  boundSocket = null;
}

function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down:", reason);
  for (const client of clients.values()) {
    try {
      client.socket.destroy();
    } catch {
      // already gone
    }
  }
  removeOwnSocket();
  // Give the log write a tick, then go.
  setTimeout(() => process.exit(code), 10).unref?.();
}

async function main() {
  try {
    ensureRuntimeDir();
    openLog();
  } catch (error) {
    // Without a safe log there is nowhere to record anything; stderr reaches Edge's own log.
    process.stderr.write(`browser-bridge: ${error.message}\n`);
    process.exit(1);
  }

  const origin = process.argv.slice(2).find((arg) => arg.startsWith("chrome-extension://"));
  if (origin && origin.replace(/\/$/, "") !== EXTENSION_ORIGIN.replace(/\/$/, "")) {
    log("refusing unknown origin", origin);
    process.exit(1);
  }
  log("start", origin ?? "(no origin argument)", "socket", SOCKET);

  const server = net.createServer((socket) => {
    const client = {
      id: nextClientId++,
      socket,
      sessionKey: null,
      viewer: false,
      name: null,
      agent: null,
      account: null,
      connectedAt: new Date().toISOString(),
      decoder: new LineDecoder(),
    };
    clients.set(client.id, client);
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      let messages;
      try {
        messages = client.decoder.push(chunk);
      } catch (error) {
        log("bad client data:", error.message);
        socket.destroy();
        return;
      }
      for (const message of messages) {
        try {
          onClientMessage(client, message);
        } catch (error) {
          // One malformed request must not take the broker down with it.
          log("error handling client message:", error.stack || error.message);
          replyToClient(client, validRequestId(message?.id) ? message.id : null, false, {
            message: `the bridge could not handle that request: ${error.message}`,
          });
        }
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => onClientClose(client));
  });

  try {
    await secureBind(server);
  } catch (error) {
    log("cannot bind socket:", error.message);
    process.exit(1);
  }
  log("listening");

  process.stdin.on("data", (chunk) => {
    let messages;
    try {
      messages = decoder.push(chunk);
    } catch (error) {
      log("bad native data:", error.message);
      shutdown("native framing error", 1);
      return;
    }
    for (const message of messages) {
      try {
        onExtensionMessage(message);
      } catch (error) {
        log("error handling extension message:", error.stack || error.message);
      }
    }
  });
  process.stdin.on("end", () => shutdown("extension port closed"));
  process.stdin.on("error", () => shutdown("extension port error"));
  process.stdout.on("error", () => shutdown("extension port write error"));

  const ping = setInterval(() => {
    if (extensionReady) sendToExtension({ method: "ping" });
    // A half-received reply whose sender went quiet is only ever dropped on a timer.
    assembler.sweep();
  }, PING_INTERVAL_MS);
  ping.unref?.();

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => shutdown(signal));
  }
  process.on("exit", removeOwnSocket);
}

main().catch((error) => {
  log("fatal:", error.stack || error.message);
  process.exit(1);
});
