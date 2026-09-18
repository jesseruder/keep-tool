// The MCP server's socket client, against a scripted host.

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LineDecoder, encodeLine } from "../host/protocol.js";
import { BridgeClient, BridgeInterruptedError, BridgeUnavailableError } from "../mcp/client.js";

/** A stand-in host: records what it is told, answers what the script says. */
function scriptedHost(t, handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-"));
  const socketFile = path.join(dir, "bridge.sock");
  const received = [];
  const connections = [];

  const server = net.createServer((socket) => {
    connections.push(socket);
    const decoder = new LineDecoder();
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        received.push(message);
        const reply = handler(message, socket, connections.length);
        if (reply) socket.write(encodeLine(reply));
      }
    });
  });

  t.after(() => {
    server.close();
    for (const socket of connections) socket.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return new Promise((resolve) => {
    server.listen(socketFile, () => resolve({ socketFile, received, connections, server }));
  });
}

function clientFor(socketFile, overrides = {}) {
  return new BridgeClient({
    socketPath: socketFile,
    sessionKey: "session-key-1234",
    name: "test #1",
    agent: "claude",
    account: "claude-tertiary",
    ...overrides,
  });
}

test("hello goes first and carries the session identity", async (t) => {
  const { socketFile, received } = await scriptedHost(t, (message) => ({
    id: message.id,
    ok: true,
    result: { method: message.method },
  }));
  const client = clientFor(socketFile);
  t.after(() => client.close());

  const result = await client.request("tabs_context_mcp", { createIfEmpty: true });
  assert.deepEqual(result, { method: "tabs_context_mcp" });

  assert.equal(received[0].method, "hello");
  assert.equal(received[0].params.sessionKey, "session-key-1234");
  assert.equal(received[0].params.name, "test #1");
  assert.equal(received[0].params.account, "claude-tertiary");
  assert.equal(received[1].method, "tabs_context_mcp");
  assert.deepEqual(received[1].params, { createIfEmpty: true });
  assert.equal(client.lastHostStatus.method, "hello");
});

test("an error reply becomes a rejected request, not a crash", async (t) => {
  const { socketFile } = await scriptedHost(t, (message) =>
    message.method === "hello"
      ? { id: message.id, ok: true, result: {} }
      : { id: message.id, ok: false, error: { message: "No tab with id: 7" } },
  );
  const client = clientFor(socketFile);
  t.after(() => client.close());

  await assert.rejects(() => client.request("read_page", { tabId: 7 }), /No tab with id: 7/);
  // The connection survives an error reply.
  await assert.rejects(() => client.request("read_page", { tabId: 7 }), /No tab with id: 7/);
});

test("a host that dies between requests is reconnected and hello is replayed", async (t) => {
  let dropNext = true;
  const { socketFile, received } = await scriptedHost(t, (message, socket) => {
    if (message.method === "hello") return { id: message.id, ok: true, result: { hello: true } };
    if (dropNext) {
      // The service worker slept, Edge killed the host, the socket goes away. This one
      // is a read, so replaying it is safe; the client only knows that because the
      // write never left the process — see the next test for the other case.
      dropNext = false;
      socket.destroy();
      return null;
    }
    return { id: message.id, ok: true, result: { text: "second host" } };
  });

  const client = clientFor(socketFile);
  t.after(() => client.close());

  // The first request dies with the connection; the client must not replay it.
  await assert.rejects(() => client.request("get_page_text", { tabId: 3 }), BridgeInterruptedError);
  // The next one reconnects, replays hello, and goes through.
  const result = await client.request("get_page_text", { tabId: 3 });
  assert.deepEqual(result, { text: "second host" });

  const hellos = received.filter((message) => message.method === "hello");
  assert.equal(hellos.length, 2, "hello must be replayed on the new connection");
  assert.equal(hellos[1].params.sessionKey, "session-key-1234", "the same session key comes back");
});

test("a request that was already sent is never replayed", async (t) => {
  const { socketFile, received } = await scriptedHost(t, (message, socket) => {
    if (message.method === "hello") return { id: message.id, ok: true, result: {} };
    // Take the request and die without answering: a click may well have happened.
    socket.destroy();
    return null;
  });
  const client = clientFor(socketFile);
  t.after(() => client.close());

  await assert.rejects(
    () => client.request("computer", { action: "left_click", coordinate: [10, 10], tabId: 5 }),
    (error) => {
      assert.ok(error instanceof BridgeInterruptedError);
      assert.match(error.message, /may or may not have run/);
      assert.match(error.message, /screenshot or read the page/);
      return true;
    },
  );
  assert.equal(
    received.filter((message) => message.method === "computer").length,
    1,
    "the click must reach the browser at most once",
  );
});

test("a retried request is not sent twice to the same host", async (t) => {
  const { socketFile, received } = await scriptedHost(t, (message) => ({
    id: message.id,
    ok: true,
    result: { ok: true },
  }));
  const client = clientFor(socketFile);
  t.after(() => client.close());

  await client.request("tabs_create_mcp", {});
  assert.equal(received.filter((message) => message.method === "tabs_create_mcp").length, 1);
});

test("no host at all is a clear, actionable error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-"));
  const client = new BridgeClient({
    socketPath: path.join(dir, "bridge.sock"),
    sessionKey: "nobody-home",
    name: "test",
    attempts: 1,
  });
  await assert.rejects(
    () => client.request("browser_status", {}),
    (error) => {
      assert.ok(error instanceof BridgeUnavailableError);
      assert.match(error.message, /^Browser Bridge is not connected: /);
      assert.match(error.message, /Open Edge with the Browser Bridge extension enabled\.$/);
      return true;
    },
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("close says bye so the host can drop the session", async (t) => {
  const { socketFile, received } = await scriptedHost(t, (message) => ({
    id: message.id,
    ok: true,
    result: {},
  }));
  const client = clientFor(socketFile);
  await client.request("browser_status", {});
  await client.close();
  assert.equal(received.at(-1).method, "bye");
  assert.equal(client.connected, false);
  // Closing twice is harmless.
  await client.close();
});
