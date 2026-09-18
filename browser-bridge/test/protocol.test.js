import assert from "node:assert/strict";
import test from "node:test";

import {
  ChunkAssembler,
  EXTENSION_ID,
  EXTENSION_KEY,
  LineDecoder,
  MAX_CHUNK_BYTES,
  NativeDecoder,
  chunkMessage,
  encodeLine,
  encodeNative,
  extensionIdFromKey,
  isChunk,
  runtimeDir,
  socketPath,
} from "../host/protocol.js";

test("native framing round trips one message", () => {
  const message = { id: "c1", method: "hello", params: { sessionKey: "abc" } };
  const decoder = new NativeDecoder();
  const out = decoder.push(encodeNative(message));
  assert.deepEqual(out, [message]);
});

test("native framing handles several messages in one chunk and split headers", () => {
  const decoder = new NativeDecoder();
  const buffer = Buffer.concat([encodeNative({ a: 1 }), encodeNative({ b: 2 }), encodeNative({ c: 3 })]);

  assert.deepEqual(decoder.push(buffer), [{ a: 1 }, { b: 2 }, { c: 3 }]);

  // Now feed the same bytes one at a time: nothing may be lost or duplicated.
  const slow = new NativeDecoder();
  const collected = [];
  for (const byte of buffer) collected.push(...slow.push(Buffer.from([byte])));
  assert.deepEqual(collected, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test("native framing refuses an absurd frame length", () => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(0xffffffff, 0);
  header.writeUInt32BE(0xffffffff, 0);
  assert.throws(() => new NativeDecoder().push(header), /native frame too large/);
});

test("a message under the limit is not chunked", () => {
  const message = { id: "c1", ok: true, result: { text: "small" } };
  assert.deepEqual(chunkMessage(message), [message]);
});

test("a message over the 1 MiB native limit splits and reassembles", () => {
  const message = { id: "c9", ok: true, result: { image: "x".repeat(2 * 1024 * 1024) } };
  const frames = chunkMessage(message);

  assert.ok(frames.length >= 3, `expected several frames, got ${frames.length}`);
  for (const frame of frames) {
    assert.ok(isChunk(frame));
    assert.equal(frame.id, "c9");
    assert.ok(Buffer.byteLength(JSON.stringify(frame), "utf8") < 1024 * 1024);
    assert.ok(Buffer.byteLength(frame.data, "utf8") <= MAX_CHUNK_BYTES);
  }

  const assembler = new ChunkAssembler();
  let assembled = null;
  for (const frame of frames) assembled = assembler.accept(frame) ?? assembled;
  assert.deepEqual(assembled, message);
  assert.equal(assembler.pendingCount, 0);
});

test("chunking never splits a multi-byte character", () => {
  const message = { id: "u", text: "\u{1F600}".repeat(400_000) };
  const frames = chunkMessage(message);
  const assembler = new ChunkAssembler();
  let assembled = null;
  for (const frame of frames) {
    assert.ok(!frame.data.includes("�"), "a surrogate pair was cut in half");
    assembled = assembler.accept(frame) ?? assembled;
  }
  assert.deepEqual(assembled, message);
});

test("out-of-order chunks still reassemble", () => {
  const message = { id: "o", blob: "y".repeat(1_600_000) };
  const frames = chunkMessage(message);
  const assembler = new ChunkAssembler();
  let assembled = null;
  for (const frame of [...frames].reverse()) assembled = assembler.accept(frame) ?? assembled;
  assert.deepEqual(assembled, message);
});

test("a non-chunk message passes through the assembler untouched", () => {
  const assembler = new ChunkAssembler();
  assert.deepEqual(assembler.accept({ event: "pong" }), { event: "pong" });
});

test("the line codec splits on newlines and ignores blank lines", () => {
  const decoder = new LineDecoder();
  assert.deepEqual(decoder.push('{"id":"a"}\n\n{"id":"b"}\n'), [{ id: "a" }, { id: "b" }]);
});

test("the line codec buffers a partial line", () => {
  const decoder = new LineDecoder();
  assert.deepEqual(decoder.push('{"id":'), []);
  assert.deepEqual(decoder.push('"a"}\n'), [{ id: "a" }]);
});

test("the line codec rejects a line past the 4 MiB cap", () => {
  const decoder = new LineDecoder();
  assert.throws(() => decoder.push("z".repeat(5 * 1024 * 1024)), /4 MiB limit/);
});

test("encodeLine refuses an oversize message", () => {
  assert.throws(() => encodeLine({ blob: "z".repeat(5 * 1024 * 1024) }), /too large for the socket/);
  assert.equal(encodeLine({ a: 1 }), '{"a":1}\n');
});

test("malformed JSON on a line is an error, not silence", () => {
  assert.throws(() => new LineDecoder().push("not json\n"), SyntaxError);
});

test("the extension id is the documented derivation of the manifest key", () => {
  assert.equal(extensionIdFromKey(EXTENSION_KEY), EXTENSION_ID);
  assert.match(EXTENSION_ID, /^[a-p]{32}$/);
});

test("runtime paths follow BROWSER_BRIDGE_RUNTIME_DIR", () => {
  const env = { BROWSER_BRIDGE_RUNTIME_DIR: "/tmp/bb-test" };
  assert.equal(runtimeDir(env), "/tmp/bb-test");
  assert.equal(socketPath(env), "/tmp/bb-test/bridge.sock");
  assert.match(runtimeDir({ HOME: "/Users/example" }), /Application Support\/BrowserBridge$/);
});
