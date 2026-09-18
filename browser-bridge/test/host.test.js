// The real host binary, a fake extension on its stdio, and real Unix socket clients.
// Socket paths live in os.tmpdir() because macOS caps a Unix socket path at 104 bytes.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXTENSION_ORIGIN,
  LineDecoder,
  NativeDecoder,
  encodeLine,
  encodeNative,
} from "../host/protocol.js";

const HOST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "host", "native-host.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 5000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}

/** A fake extension: speaks native messaging over the host's stdio. */
class FakeExtension {
  constructor(child) {
    this.child = child;
    this.messages = [];
    this.decoder = new NativeDecoder();
    child.stdout.on("data", (chunk) => {
      for (const message of this.decoder.push(chunk)) this.messages.push(message);
    });
  }

  send(message) {
    this.child.stdin.write(encodeNative(message));
  }

  find(predicate) {
    return this.messages.find(predicate) ?? null;
  }

  async waitFor(predicate, label) {
    return waitFor(() => this.find(predicate), { label });
  }
}

class FakeClient {
  constructor(socket) {
    this.socket = socket;
    this.replies = [];
    this.closed = false;
    this.decoder = new LineDecoder();
    socket.on("data", (chunk) => {
      for (const message of this.decoder.push(chunk)) this.replies.push(message);
    });
    socket.on("close", () => {
      this.closed = true;
    });
    socket.on("error", () => {});
  }

  send(message) {
    this.socket.write(encodeLine(message));
  }

  async reply(id) {
    return waitFor(() => this.replies.find((message) => message.id === id) ?? null, {
      label: `reply to ${id}`,
    });
  }
}

async function startHost(t, { timeoutMs } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-"));
  const socketFile = path.join(dir, "bridge.sock");
  const env = { ...process.env, BROWSER_BRIDGE_RUNTIME_DIR: dir };
  if (timeoutMs) env.BROWSER_BRIDGE_REQUEST_TIMEOUT_MS = String(timeoutMs);

  const child = spawn(process.execPath, [HOST, EXTENSION_ORIGIN], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

  const extension = new FakeExtension(child);
  t.after(() => {
    child.kill("SIGKILL");
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  await waitFor(() => fs.existsSync(socketFile), { label: `the socket at ${socketFile}` });
  extension.send({ event: "ready", version: "test-1" });

  return { child, dir, socketFile, extension, stderr };
}

async function connect(socketFile) {
  const socket = await new Promise((resolve, reject) => {
    const s = net.connect(socketFile);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
  return new FakeClient(socket);
}

test("two sessions are multiplexed onto one extension port", async (t) => {
  const { socketFile, extension } = await startHost(t);

  const one = await connect(socketFile);
  const two = await connect(socketFile);
  one.send({ id: "h1", method: "hello", params: { sessionKey: "session-one", name: "one" } });
  two.send({ id: "h2", method: "hello", params: { sessionKey: "session-two", name: "two" } });

  const helloReply = await one.reply("h1");
  assert.equal(helloReply.ok, true);
  assert.equal(helloReply.result.extensionConnected, true);
  assert.equal(helloReply.result.extensionVersion, "test-1");

  // The extension learns each session's name so it can title the tab group.
  const announced = await extension.waitFor(
    (message) => message.method === "session_hello" && message.params.sessionKey === "session-two",
    "session_hello for session two",
  );
  assert.equal(announced.params.name, "two");

  one.send({ id: "a1", method: "tabs_context_mcp", params: { createIfEmpty: true } });
  two.send({ id: "b1", method: "read_page", params: { tabId: 7 } });

  const forwardedOne = await extension.waitFor(
    (message) => message.method === "tabs_context_mcp",
    "the forwarded tabs_context_mcp",
  );
  const forwardedTwo = await extension.waitFor(
    (message) => message.method === "read_page",
    "the forwarded read_page",
  );
  assert.equal(forwardedOne.sessionKey, "session-one");
  assert.deepEqual(forwardedOne.params, { createIfEmpty: true });
  assert.equal(forwardedTwo.sessionKey, "session-two");

  // Answer out of order: each reply must find its own client.
  extension.send({ id: forwardedTwo.id, ok: true, result: { text: "page two" } });
  extension.send({ id: forwardedOne.id, ok: false, error: { message: "No tab with id: 7" } });

  const replyTwo = await two.reply("b1");
  assert.deepEqual(replyTwo, { id: "b1", ok: true, result: { text: "page two" } });
  const replyOne = await one.reply("a1");
  assert.equal(replyOne.ok, false);
  assert.equal(replyOne.error.message, "No tab with id: 7");

  assert.equal(one.replies.some((message) => message.id === "b1"), false);
});

test("a request before hello is rejected and the connection closed", async (t) => {
  const { socketFile } = await startHost(t);
  const client = await connect(socketFile);
  client.send({ id: "x1", method: "read_page", params: { tabId: 1 } });

  const reply = await client.reply("x1");
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /first message must be hello/);
  await waitFor(() => client.closed, { label: "the host to close the connection" });
});

test("hello without a session key is refused", async (t) => {
  const { socketFile } = await startHost(t);
  const client = await connect(socketFile);
  client.send({ id: "h", method: "hello", params: { name: "no key" } });
  const reply = await client.reply("h");
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /sessionKey/);
});

test("a request the extension never answers times out", async (t) => {
  const { socketFile, extension } = await startHost(t, { timeoutMs: 300 });
  const client = await connect(socketFile);
  client.send({ id: "h", method: "hello", params: { sessionKey: "slow-session", name: "slow" } });
  await client.reply("h");

  client.send({ id: "t1", method: "get_page_text", params: { tabId: 3 } });
  const forwarded = await extension.waitFor((m) => m.method === "get_page_text", "the forwarded request");

  const reply = await client.reply("t1");
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /Timed out/);

  // A late reply must not crash the host or reach the client twice.
  extension.send({ id: forwarded.id, ok: true, result: { text: "too late" } });
  await sleep(100);
  assert.equal(client.replies.filter((message) => message.id === "t1").length, 1);
});

test("a client disconnect tells the extension the session closed", async (t) => {
  const { socketFile, extension } = await startHost(t);
  const client = await connect(socketFile);
  client.send({ id: "h", method: "hello", params: { sessionKey: "going-away", name: "bye" } });
  await client.reply("h");

  client.socket.destroy();
  const closed = await extension.waitFor(
    (message) => message.method === "session_closed",
    "session_closed",
  );
  assert.equal(closed.params.sessionKey, "going-away");
});

test("host_status lists the connected sessions without touching the extension", async (t) => {
  const { socketFile, extension } = await startHost(t);
  const client = await connect(socketFile);
  client.send({ id: "h", method: "hello", params: { sessionKey: "status-session", name: "statusy", agent: "claude" } });
  await client.reply("h");

  const before = extension.messages.length;
  client.send({ id: "s1", method: "host_status", params: {} });
  const reply = await client.reply("s1");
  assert.equal(reply.ok, true);
  assert.equal(reply.result.sessions.length, 1);
  assert.equal(reply.result.sessions[0].name, "statusy");
  assert.equal(reply.result.sessions[0].agent, "claude");
  assert.equal(extension.messages.length, before, "host_status must not reach the extension");
});

test("the socket file is removed when the extension port closes", async (t) => {
  const { child, socketFile } = await startHost(t);
  assert.ok(fs.existsSync(socketFile));

  child.stdin.end();
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0);
  assert.equal(fs.existsSync(socketFile), false);
});

test("a host started for another extension origin refuses to run", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, [HOST, "chrome-extension://someoneelse/"], {
    env: { ...process.env, BROWSER_BRIDGE_RUNTIME_DIR: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 1);
  assert.equal(fs.existsSync(path.join(dir, "bridge.sock")), false);
});

test("a big reply is chunked over the native port and still reaches the client whole", async (t) => {
  const { socketFile, extension } = await startHost(t);
  const client = await connect(socketFile);
  client.send({ id: "h", method: "hello", params: { sessionKey: "big-session", name: "big" } });
  await client.reply("h");

  client.send({ id: "big", method: "computer", params: { action: "screenshot", tabId: 2 } });
  const forwarded = await extension.waitFor((m) => m.method === "computer", "the forwarded screenshot");

  const image = "A".repeat(1_500_000);
  // The extension chunks exactly as host/protocol.js does.
  const { chunkMessage } = await import("../host/protocol.js");
  for (const frame of chunkMessage({ id: forwarded.id, ok: true, result: { image } })) {
    extension.send(frame);
  }

  const reply = await client.reply("big");
  assert.equal(reply.ok, true);
  assert.equal(reply.result.image.length, image.length);
});
