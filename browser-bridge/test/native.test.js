// NativeBridge against a fake chrome.runtime port: what the extension puts on the wire.

import assert from "node:assert/strict";
import test from "node:test";

import { MAX_ASSEMBLED_BYTES, MAX_PARTIAL_MESSAGES } from "../extension/lib/native.js";

/** A port that records what was posted and lets the test drive the listeners. */
function makePort() {
  const port = {
    sent: [],
    messageListeners: [],
    disconnectListeners: [],
    disconnected: false,
    onMessage: { addListener: (fn) => port.messageListeners.push(fn) },
    onDisconnect: { addListener: (fn) => port.disconnectListeners.push(fn) },
    postMessage: (message) => port.sent.push(message),
    disconnect: () => {
      port.disconnected = true;
      for (const fn of port.disconnectListeners) fn();
    },
  };
  return port;
}

const ports = [];
globalThis.chrome = {
  runtime: {
    lastError: null,
    getManifest: () => ({ version: "0.1.0" }),
    connectNative: () => {
      const port = makePort();
      ports.push(port);
      return port;
    },
  },
};

const { NativeBridge } = await import("../extension/lib/native.js");

function connectedBridge(t, onRequest = () => {}) {
  const bridge = new NativeBridge({ onRequest });
  bridge.connect();
  t.after(() => bridge.disconnect());
  return { bridge, port: ports.at(-1) };
}

test("connecting announces the extension version", (t) => {
  const { port } = connectedBridge(t);
  assert.deepEqual(port.sent[0], { event: "ready", version: "0.1.0" });
});

test("a result the host could never reassemble becomes a small error reply", (t) => {
  const { bridge, port } = connectedBridge(t);
  port.sent.length = 0;

  // Chunking this would produce frames the host's assembler drops, and the client would
  // then wait out its whole timeout for a reply that never comes.
  const sent = bridge.send({
    id: "w1_c7",
    ok: true,
    result: { image: { data: "A".repeat(MAX_ASSEMBLED_BYTES + 1024) } },
  });
  assert.equal(sent, true);
  assert.equal(port.sent.length, 1, "one small frame, not a chunk stream");
  const frame = port.sent[0];
  assert.equal(frame.id, "w1_c7");
  assert.equal(frame.ok, false);
  assert.match(frame.error.message, /^result too large \(\d+ bytes, limit 16777216\)$/);
  assert.ok(JSON.stringify(frame).length < 200);
});

test("a big but carryable result is still chunked", (t) => {
  const { bridge, port } = connectedBridge(t);
  port.sent.length = 0;
  bridge.send({ id: "w1_c8", ok: true, result: { blob: "B".repeat(2 * 1024 * 1024) } });
  assert.ok(port.sent.length > 1);
  for (const frame of port.sent) assert.equal(frame.id, "w1_c8");
});

test("a reply for a dead port is dropped", (t) => {
  const { bridge, port } = connectedBridge(t);
  const generation = bridge.generation;
  port.disconnect();
  assert.equal(bridge.connected, false);

  bridge.connect();
  const fresh = ports.at(-1);
  fresh.sent.length = 0;
  // The host that asked is gone, and the new one may have reused this wire id.
  assert.equal(bridge.sendFor(generation, { id: "w1_c1", ok: true, result: {} }), false);
  assert.equal(fresh.sent.length, 0);
  assert.equal(bridge.sendFor(bridge.generation, { id: "w2_c1", ok: true, result: {} }), true);
  assert.equal(fresh.sent.length, 1);
});

test("a ping is answered with a pong on the same port", (t) => {
  const { port } = connectedBridge(t);
  port.sent.length = 0;
  for (const listener of port.messageListeners) listener({ method: "ping" });
  assert.deepEqual(port.sent, [{ event: "pong" }]);
});

test("requests are handed to the handler with their port generation", (t) => {
  const seen = [];
  const { bridge, port } = connectedBridge(t, (message, generation) => {
    seen.push({ message, generation });
  });
  for (const listener of port.messageListeners) {
    listener({ id: "w1_c1", method: "read_page", params: { tabId: 1 } });
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].message.method, "read_page");
  assert.equal(seen[0].generation, bridge.generation);
});

test("a request evicted mid-reassembly is answered with an error, an event is only logged", (t) => {
  const { port } = connectedBridge(t);
  port.sent.length = 0;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  t.after(() => {
    console.warn = originalWarn;
  });

  // One first chunk per id, more than the assembler keeps: the oldest is evicted.
  for (let index = 0; index <= MAX_PARTIAL_MESSAGES; index++) {
    const id = index === 0 ? "wnonce_1_c1" : `evt_${index}`;
    for (const listener of port.messageListeners) {
      listener({ id, chunk: 0, of: 2, data: "{" });
    }
  }

  const replies = port.sent.filter((frame) => frame.ok === false);
  assert.equal(replies.length, 1, "only the request id gets a reply");
  assert.equal(replies[0].id, "wnonce_1_c1");
  assert.match(replies[0].error.message, /dropped before it completed/);
  assert.ok(warnings.some((line) => line.includes("wnonce_1_c1")));
});
