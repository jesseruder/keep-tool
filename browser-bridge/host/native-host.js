#!/usr/bin/env node
// The broker. Edge spawns exactly one of these when the extension's service worker
// calls connectNative, and kills it when the worker dies. It owns the Unix socket and
// multiplexes any number of MCP server processes onto the single native port.

import fs from "node:fs";
import net from "node:net";

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
  runtimeDir,
  socketPath,
} from "./protocol.js";

const DIR = runtimeDir();
const SOCKET = socketPath();
const LOG = logPath();
const MAX_LOG_BYTES = 1024 * 1024;

let logStream = null;

function log(...parts) {
  const line = `${new Date().toISOString()} [${process.pid}] ${parts.join(" ")}\n`;
  if (logStream) logStream.write(line);
}

function openLog() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  try {
    // Keep only the tail: this file is append-only across every host start.
    const stat = fs.statSync(LOG);
    if (stat.size > MAX_LOG_BYTES) {
      const fd = fs.openSync(LOG, "r");
      const keep = Buffer.allocUnsafe(MAX_LOG_BYTES);
      fs.readSync(fd, keep, 0, MAX_LOG_BYTES, stat.size - MAX_LOG_BYTES);
      fs.closeSync(fd);
      fs.writeFileSync(LOG, keep, { mode: 0o600 });
    }
  } catch {
    // no log yet
  }
  logStream = fs.createWriteStream(LOG, { flags: "a", mode: 0o600 });
}

// --- extension port -------------------------------------------------------

const decoder = new NativeDecoder();
const assembler = new ChunkAssembler();

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

function forward(client, message) {
  const wireId = `w${client.id}_${message.id}`;
  const timer = setTimeout(() => {
    pending.delete(wireId);
    replyToClient(client, message.id, false, {
      message: `Timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s waiting for the browser extension (${message.method})`,
    });
  }, REQUEST_TIMEOUT_MS);
  timer.unref?.();
  pending.set(wireId, { client, clientRequestId: message.id, timer });
  sendToExtension({
    id: wireId,
    sessionKey: client.sessionKey,
    method: message.method,
    params: message.params ?? {},
  });
}

function onClientMessage(client, message) {
  if (message == null || typeof message !== "object" || typeof message.method !== "string") {
    replyToClient(client, message?.id ?? null, false, { message: "malformed request" });
    return;
  }
  if (!client.sessionKey) {
    if (message.method !== "hello") {
      replyToClient(client, message.id ?? null, false, { message: "first message must be hello" });
      client.socket.end();
      return;
    }
    const params = message.params ?? {};
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
  if (!client.sessionKey) return;
  const stillOpen = [...clients.values()].some((c) => c.sessionKey === client.sessionKey);
  if (stillOpen) return;
  log("session closed", describeClient(client));
  if (extensionReady) {
    sendToExtension({ method: "session_closed", params: { sessionKey: client.sessionKey } });
  }
}

function onExtensionMessage(raw) {
  const message = assembler.accept(raw);
  if (message === null) return;

  if (message.event === "ready") {
    extensionReady = true;
    extensionVersion = message.version ?? null;
    log("extension ready", extensionVersion ?? "");
    // Clients that said hello before the port was up still need announcing.
    for (const client of clients.values()) announceSession(client);
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
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const dirStat = fs.lstatSync(DIR);
  if (!dirStat.isDirectory()) throw new Error(`${DIR} is not a directory`);
  if (dirStat.uid !== process.getuid()) throw new Error(`${DIR} is not owned by this user`);
  if (dirStat.mode & 0o077) fs.chmodSync(DIR, 0o700);

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
    const tryListen = () => {
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
          server.listen(SOCKET, resolve);
        };
        probe.on("timeout", takeOver);
        probe.on("error", takeOver);
      });
      server.listen(SOCKET, () => {
        fs.chmodSync(SOCKET, 0o600);
        resolve();
      });
    };
    tryListen();
  });
}

let shuttingDown = false;

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
  try {
    const stat = fs.lstatSync(SOCKET);
    if (stat.isSocket()) fs.unlinkSync(SOCKET);
  } catch {
    // never bound, or already removed
  }
  // Give the log write a tick, then go.
  setTimeout(() => process.exit(code), 10).unref?.();
}

async function main() {
  openLog();

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
      for (const message of messages) onClientMessage(client, message);
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
  }, PING_INTERVAL_MS);
  ping.unref?.();

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => shutdown(signal));
  }
  process.on("exit", () => {
    try {
      const stat = fs.lstatSync(SOCKET);
      if (stat.isSocket()) fs.unlinkSync(SOCKET);
    } catch {
      // fine
    }
  });
}

main().catch((error) => {
  log("fatal:", error.stack || error.message);
  process.exit(1);
});
