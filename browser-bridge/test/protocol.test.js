import assert from "node:assert/strict";
import test from "node:test";

import {
  CHUNK_TTL_MS,
  ChunkAssembler,
  EXTENSION_ID,
  EXTENSION_KEY,
  LineDecoder,
  MAX_ASSEMBLED_BYTES,
  MAX_CHUNKS,
  MAX_CHUNK_BYTES,
  MAX_PARTIAL_MESSAGES,
  MAX_PENDING_BYTES,
  NativeDecoder,
  chunkMessage,
  encodeLine,
  encodeNative,
  extensionIdFromKey,
  isChunk,
  runtimeDir,
  socketPath,
} from "../host/protocol.js";
import {
  ChunkAssembler as ExtensionAssembler,
  chunkMessage as extensionChunkMessage,
} from "../extension/lib/native.js";

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

test("an escape-heavy payload still produces frames Chrome will carry", () => {
  // Every backslash doubles when the chunk's data is put inside the frame's JSON, so
  // measuring the raw text would hand Chrome a frame well over its 1 MiB limit.
  const message = { id: "esc", ok: true, result: { blob: "\\".repeat(1_500_000) } };
  for (const chunk of [chunkMessage, extensionChunkMessage]) {
    const frames = chunk(message);
    for (const frame of frames) {
      const encoded = Buffer.byteLength(JSON.stringify(frame), "utf8");
      assert.ok(encoded <= MAX_CHUNK_BYTES, `frame of ${encoded} bytes is over the limit`);
    }
    const assembler = new ChunkAssembler();
    let assembled = null;
    for (const frame of frames) assembled = assembler.accept(frame) ?? assembled;
    assert.deepEqual(assembled, message);
  }
});

test("control characters are measured at their escaped size too", () => {
  const message = { id: "ctl", text: "".repeat(300_000) };
  for (const frame of chunkMessage(message)) {
    assert.ok(Buffer.byteLength(JSON.stringify(frame), "utf8") <= MAX_CHUNK_BYTES);
  }
});

test("the assembler refuses an absurd chunk count or index", () => {
  const assembler = new ChunkAssembler();
  assert.throws(() => assembler.accept({ id: "x", chunk: 0, of: MAX_CHUNKS + 1, data: "a" }), /out of range/);
  assert.throws(() => assembler.accept({ id: "x", chunk: 0, of: 0, data: "a" }), /out of range/);
  assert.throws(() => assembler.accept({ id: "x", chunk: 5, of: 2, data: "a" }), /out of range/);
  assert.throws(() => assembler.accept({ id: "x", chunk: -1, of: 2, data: "a" }), /out of range/);
});

test("the assembler caps how much one message may claim", () => {
  const assembler = new ChunkAssembler();
  const megabyte = "z".repeat(1024 * 1024);
  assert.throws(() => {
    for (let index = 0; index < 20; index++) {
      assembler.accept({ id: "big", chunk: index, of: 20, data: megabyte });
    }
  }, /exceeded/);
  assert.equal(assembler.pendingCount, 0, "the half-message is dropped, not kept");
});

test("a message too big for the receiver is refused instead of chunked", () => {
  const huge = { id: "x", ok: true, result: { blob: "z".repeat(MAX_ASSEMBLED_BYTES + 1000) } };
  for (const chunk of [chunkMessage, extensionChunkMessage]) {
    assert.throws(
      () => chunk(huge),
      (error) => {
        assert.equal(error.name, "MessageTooLargeError");
        assert.match(error.message, /^result too large \(\d+ bytes, limit 16777216\)$/);
        assert.ok(error.bytes > MAX_ASSEMBLED_BYTES);
        assert.equal(error.limit, MAX_ASSEMBLED_BYTES);
        return true;
      },
    );
  }
});

test("only a half-open partial count is kept; the oldest gives way", () => {
  for (const Assembler of [ChunkAssembler, ExtensionAssembler]) {
    const assembler = new Assembler();
    for (let index = 0; index < MAX_PARTIAL_MESSAGES + 3; index++) {
      assembler.accept({ id: `m${index}`, chunk: 0, of: 2, data: "x" }, 1000 + index);
    }
    assert.equal(assembler.pendingCount, MAX_PARTIAL_MESSAGES);
    // The newest survived and the oldest did not: finishing m0 starts a fresh slot.
    assert.equal(assembler.accept({ id: "m10", chunk: 0, of: 2, data: "y" }, 2000), null);
  }
});

test("the pending byte total is capped across messages", () => {
  const assembler = new ChunkAssembler();
  const big = "q".repeat(6 * 1024 * 1024);
  for (let index = 0; index < 8; index++) {
    assembler.accept({ id: `b${index}`, chunk: 0, of: 2, data: big }, 1000 + index);
  }
  assert.ok(assembler.pendingBytes <= MAX_PENDING_BYTES, `${assembler.pendingBytes} bytes held`);
  assert.ok(assembler.pendingCount < 8, "older partials were dropped");
});

test("evictions are reported, so the owner can answer whoever was waiting", () => {
  for (const Assembler of [ChunkAssembler, ExtensionAssembler]) {
    const evicted = [];
    const assembler = new Assembler({ onEvict: (id, reason) => evicted.push({ id, reason }) });

    assembler.accept({ id: "expiring", chunk: 0, of: 2, data: "half" }, 1000);
    assembler.sweep(1000 + CHUNK_TTL_MS + 1);
    assert.deepEqual(evicted.map((entry) => entry.id), ["expiring"]);
    assert.match(evicted[0].reason, /unfinished for too long/);

    evicted.length = 0;
    for (let index = 0; index < MAX_PARTIAL_MESSAGES + 1; index++) {
      assembler.accept({ id: `c${index}`, chunk: 0, of: 2, data: "x" }, 2000 + index);
    }
    assert.deepEqual(evicted.map((entry) => entry.id), ["c0"]);
    assert.match(evicted[0].reason, /too many unfinished messages/);
  }
});

test("sweep expires partials without any new chunk arriving", () => {
  for (const Assembler of [ChunkAssembler, ExtensionAssembler]) {
    const assembler = new Assembler();
    assembler.accept({ id: "quiet", chunk: 0, of: 2, data: "half" }, 1000);
    assert.equal(assembler.pendingCount, 1);
    assembler.sweep(1000 + CHUNK_TTL_MS - 1);
    assert.equal(assembler.pendingCount, 1, "not expired yet");
    assembler.sweep(1000 + CHUNK_TTL_MS + 1);
    assert.equal(assembler.pendingCount, 0, "a quiet port must not pin a partial forever");
  }
});

test("a half-finished message is forgotten after its TTL", () => {
  const assembler = new ChunkAssembler();
  const start = 1_000_000;
  assert.equal(assembler.accept({ id: "half", chunk: 0, of: 2, data: '{"a":1' }, start), null);
  assert.equal(assembler.pendingCount, 1);
  // A later frame for a different message sweeps the stale one out.
  assembler.accept({ id: "other", chunk: 0, of: 2, data: "x" }, start + CHUNK_TTL_MS + 1);
  assert.equal(assembler.pendingCount, 1);
});

test("the extension's assembler enforces the same limits", () => {
  const assembler = new ExtensionAssembler();
  assert.throws(() => assembler.accept({ id: "x", chunk: 0, of: 999, data: "a" }), /out of range/);
  const frames = extensionChunkMessage({ id: "round", blob: "y".repeat(1_200_000) });
  let assembled = null;
  for (const frame of frames) assembled = assembler.accept(frame) ?? assembled;
  assert.equal(assembled.blob.length, 1_200_000);
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

test("the line codec survives a character split across two reads", () => {
  const decoder = new LineDecoder();
  const line = Buffer.from(`${JSON.stringify({ text: "A\u{1F600}B" })}\n`, "utf8");
  // Cut through the middle of the four-byte emoji.
  const emojiStart = line.indexOf(0xf0);
  const cut = emojiStart + 2;
  assert.deepEqual(decoder.push(line.subarray(0, cut)), []);
  assert.deepEqual(decoder.push(line.subarray(cut)), [{ text: "A\u{1F600}B" }]);
});

test("the line codec handles a newline arriving in a later read", () => {
  const decoder = new LineDecoder();
  const payload = Buffer.from(`${JSON.stringify({ a: "é" })}\n${JSON.stringify({ b: 2 })}\n`, "utf8");
  const collected = [];
  for (const byte of payload) collected.push(...decoder.push(Buffer.from([byte])));
  assert.deepEqual(collected, [{ a: "é" }, { b: 2 }]);
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
  assert.equal(runtimeDir({ ...env, XDG_STATE_HOME: "/home/test/.state" }, "linux"), "/tmp/bb-test");
  assert.match(runtimeDir({ HOME: "/Users/example" }, "darwin"), /Application Support\/BrowserBridge$/);
});

test("on Linux the runtime directory is the XDG state directory", () => {
  assert.equal(runtimeDir({ HOME: "/home/test" }, "linux"), "/home/test/.local/state/browser-bridge");
  assert.equal(
    runtimeDir({ HOME: "/home/test", XDG_STATE_HOME: "/home/test/.state" }, "linux"),
    "/home/test/.state/browser-bridge",
  );
  // The spec says a relative value is invalid and must be ignored.
  assert.equal(
    runtimeDir({ HOME: "/home/test", XDG_STATE_HOME: "state" }, "linux"),
    "/home/test/.local/state/browser-bridge",
  );
  assert.equal(socketPath({ HOME: "/home/test" }, "linux"), "/home/test/.local/state/browser-bridge/bridge.sock");
  // macOS ignores XDG_STATE_HOME: its paths are the ones an existing install already has.
  assert.equal(
    runtimeDir({ HOME: "/Users/example", XDG_STATE_HOME: "/Users/example/.state" }, "darwin"),
    "/Users/example/Library/Application Support/BrowserBridge",
  );
});
