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

test("a client cannot send the host's own control messages", async (t) => {
  const { socketFile, extension } = await startHost(t);
  const client = await connect(socketFile);
  client.send({ id: "h", method: "hello", params: { sessionKey: "sneaky-session", name: "sneaky" } });
  await client.reply("h");

  const before = extension.messages.length;
  for (const [id, method] of [
    ["c1", "session_closed"],
    ["c2", "session_hello"],
    ["c3", "ping"],
    ["c4", "pong"],
    ["c5", "not_a_tool"],
  ]) {
    client.send({ id, method, params: { sessionKey: "someone-else" } });
    const reply = await client.reply(id);
    assert.equal(reply.ok, false, method);
    assert.match(reply.error.message, /Unknown method/, method);
  }
  assert.equal(extension.messages.length, before, "nothing reached the extension");
});

test("a hostile id is rejected instead of taking the broker down", async (t) => {
  const { socketFile } = await startHost(t);
  const client = await connect(socketFile);
  client.send({ id: "h", method: "hello", params: { sessionKey: "id-session", name: "ids" } });
  await client.reply("h");

  // An object id would throw the moment it was used as a Map key or template value.
  client.socket.write('{"id":{"toString":null},"method":"read_page","params":{"tabId":1}}\n');
  client.socket.write('{"id":[],"method":"read_page","params":{"tabId":1}}\n');
  await waitFor(() => client.replies.filter((message) => message.id === null).length >= 2, {
    label: "both malformed ids to be refused",
  });
  for (const reply of client.replies.filter((message) => message.id === null)) {
    assert.equal(reply.ok, false);
    assert.match(reply.error.message, /id must be a short string or a number/);
  }

  // The broker is still serving.
  client.send({ id: "after", method: "host_status", params: {} });
  const reply = await client.reply("after");
  assert.equal(reply.ok, true);
});

test("wire ids carry a per-host nonce so a new host cannot collide with an old one", async (t) => {
  const first = await startHost(t);
  const clientOne = await connect(first.socketFile);
  clientOne.send({ id: "h", method: "hello", params: { sessionKey: "nonce-one", name: "one" } });
  await clientOne.reply("h");
  clientOne.send({ id: "c1", method: "read_page", params: { tabId: 1 } });
  const fromFirst = await first.extension.waitFor((m) => m.method === "read_page", "the first forward");

  const second = await startHost(t);
  const clientTwo = await connect(second.socketFile);
  clientTwo.send({ id: "h", method: "hello", params: { sessionKey: "nonce-two", name: "two" } });
  await clientTwo.reply("h");
  clientTwo.send({ id: "c1", method: "read_page", params: { tabId: 1 } });
  const fromSecond = await second.extension.waitFor((m) => m.method === "read_page", "the second forward");

  // Same client number, same request id, different hosts: the ids must still differ.
  assert.notEqual(fromFirst.id, fromSecond.id);
  assert.match(fromFirst.id, /^w[0-9a-z]+_1_c1$/);
});

test("a reply that cannot be reassembled fails its client instead of hanging it", async (t) => {
  // The 90 s timeout is the fallback, not the answer: an unusable reply has to come back
  // as an error while the model is still waiting on the tool call.
  const { socketFile, extension } = await startHost(t, { timeoutMs: 60_000 });
  const client = await connect(socketFile);
  client.send({ id: "h", method: "hello", params: { sessionKey: "broken-session", name: "broken" } });
  await client.reply("h");

  client.send({ id: "r1", method: "read_page", params: { tabId: 1 } });
  const forwarded = await extension.waitFor((m) => m.method === "read_page", "the forwarded request");

  // A chunk count the assembler refuses (over the 64-frame cap).
  extension.send({ id: forwarded.id, chunk: 0, of: 500, data: "{" });

  const reply = await client.reply("r1");
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /could not be reassembled/);
  assert.match(reply.error.message, /out of range/);

  // And the host is still healthy.
  client.send({ id: "after", method: "host_status", params: {} });
  assert.equal((await client.reply("after")).ok, true);
});

test("a partial reply dropped for capacity fails its client rather than going quiet", async (t) => {
  const { socketFile, extension } = await startHost(t, { timeoutMs: 60_000 });
  const client = await connect(socketFile);
  client.send({ id: "h", method: "hello", params: { sessionKey: "crowded-session", name: "crowded" } });
  await client.reply("h");

  // Nine requests in flight, each answered with a first chunk and nothing more. The
  // ninth partial pushes the oldest out of the assembler.
  const count = 9;
  for (let index = 1; index <= count; index++) {
    client.send({ id: `q${index}`, method: "read_page", params: { tabId: index } });
  }
  const forwarded = await waitFor(
    () => {
      const seen = extension.messages.filter((message) => message.method === "read_page");
      return seen.length === count ? seen : null;
    },
    { label: "all nine requests to be forwarded" },
  );

  for (const request of forwarded) {
    extension.send({ id: request.id, chunk: 0, of: 2, data: '{"ok":true' });
  }

  const reply = await client.reply("q1");
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /the browser's reply was dropped before it completed/);
  assert.match(reply.error.message, /too many unfinished messages/);

  // The newest requests are untouched and still waiting for their second chunk.
  assert.equal(client.replies.some((message) => message.id === `q${count}`), false);
});

test("the socket file is removed when the extension port closes", async (t) => {
  const { child, socketFile } = await startHost(t);
  assert.ok(fs.existsSync(socketFile));

  child.stdin.end();
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0);
  assert.equal(fs.existsSync(socketFile), false);
});

test("shutdown leaves a socket this host did not bind alone", async (t) => {
  const { child, socketFile } = await startHost(t);
  assert.ok(fs.existsSync(socketFile));

  // Stand in for a newer host that took the path over while this one was still alive.
  fs.unlinkSync(socketFile);
  const replacement = net.createServer(() => {});
  await new Promise((resolve) => replacement.listen(socketFile, resolve));
  t.after(() => replacement.close());

  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(fs.existsSync(socketFile), true, "the replacement socket must survive");
});

test("a log that is a symlink is refused rather than followed", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-"));
  const target = path.join(dir, "victim.txt");
  fs.writeFileSync(target, "important\n");
  fs.symlinkSync(target, path.join(dir, "host.log"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const child = spawn(process.execPath, [HOST, EXTENSION_ORIGIN], {
    env: { ...process.env, BROWSER_BRIDGE_RUNTIME_DIR: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 1);
  assert.match(stderr, /symlink/);
  assert.equal(fs.readFileSync(target, "utf8"), "important\n");
  assert.equal(fs.existsSync(path.join(dir, "bridge.sock")), false);
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
