// Wire formats shared by the native host, the MCP server, the installer and the tests.
//
// Pure Node: no `chrome` global, no side effects on import, so the tests can load it.

import { createHash } from "node:crypto";
import fs from "node:fs";
import { endianness, homedir } from "node:os";
import path from "node:path";

// --- identity -------------------------------------------------------------

export const HOST_NAME = "com.keep.browser_bridge";
/** The launchd job that keeps the shared MCP daemon alive. */
export const DAEMON_LABEL = "com.keep.browser_bridge.daemon";

// Pinned by the "key" field in extension/manifest.json (see bin/gen-key.js). The
// native messaging manifest has to name this origin before the extension is ever
// loaded, which is the whole reason the id is fixed instead of random per profile.
export const EXTENSION_ID = "goijgcbiphelgdlpjmpepfkihboonjbg";
export const EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtAJWdp/oCTpkW7DYUbLGiOsu7LM0BpqVumqStVRdKpPfbMEZHFNIr8KwGbU+KJsOZeNT5sdWPECqJYaf+v/BOAAkLNmkWJT9pyQ2NCmnykB/gI/2TW2wwVEi9Kq5Y0NiPmZdwzLGcwvnKg/6kMFgcZm4uO9AUlMFWkvduFRftc6EO63Qbd0L6f2y/2emZttS4edJ0J7T9C1HU8ZoIxOLS+0NAM4jaNpwBBLMZoBW8QjnGhEVu4FLWko5EgM/YrxjfLbLLRzzxc03gs0tHbdAYsBUwaFt3L3QjaCEdmZV6Uda9o05qAxm8YBFuLiEpIbFU6czMw8vYV99Qn1ES95c4QIDAQAB";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

/** Chromium's id derivation: SHA-256 of the DER SPKI key, 32 hex chars mapped 0-9a-f -> a-p. */
export function extensionIdFromKey(base64Der) {
  const digest = createHash("sha256").update(Buffer.from(base64Der, "base64")).digest("hex");
  let id = "";
  for (const ch of digest.slice(0, 32)) id += String.fromCharCode(97 + parseInt(ch, 16));
  return id;
}

// --- limits ---------------------------------------------------------------

/** Chrome caps a native message at 1 MiB each way; split anything past this. */
export const MAX_CHUNK_BYTES = 768 * 1024;
/** Guard against a desynchronised stream claiming an absurd frame length. */
export const MAX_NATIVE_FRAME_BYTES = 64 * 1024 * 1024;
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 90_000;
/** Any traffic on the port resets the service worker's idle timer. */
export const PING_INTERVAL_MS = 20_000;

// --- native messaging framing --------------------------------------------

const NATIVE_LE = endianness() === "LE";

export function encodeNative(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.allocUnsafe(4);
  if (NATIVE_LE) header.writeUInt32LE(body.length, 0);
  else header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Feed stdin chunks in, get whole messages out. */
export class NativeDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : Buffer.from(chunk);
    const out = [];
    for (;;) {
      if (this.#buffer.length < 4) return out;
      const length = NATIVE_LE ? this.#buffer.readUInt32LE(0) : this.#buffer.readUInt32BE(0);
      if (length > MAX_NATIVE_FRAME_BYTES) {
        throw new Error(`native frame too large: ${length} bytes`);
      }
      if (this.#buffer.length < 4 + length) return out;
      const body = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);
      out.push(JSON.parse(body.toString("utf8")));
    }
  }
}

// --- chunking -------------------------------------------------------------

let chunkSeq = 0;

/** At most this many frames per message, so a bad peer cannot allocate forever. */
export const MAX_CHUNKS = 64;
/** And no reassembled message may be larger than this. */
export const MAX_ASSEMBLED_BYTES = 16 * 1024 * 1024;
/** Half a message that never finishes is dropped after this long. */
export const CHUNK_TTL_MS = 60_000;
/** Aggregate caps across every half-finished message, not just one. */
export const MAX_PARTIAL_MESSAGES = 8;
export const MAX_PENDING_BYTES = 32 * 1024 * 1024;

/**
 * A message the receiver could never reassemble. The sender turns this into a small
 * error reply rather than emitting frames that are certain to be dropped, which would
 * leave the caller waiting out its whole timeout.
 */
export class MessageTooLargeError extends Error {
  constructor(bytes, limit) {
    super(`result too large (${bytes} bytes, limit ${limit})`);
    this.name = "MessageTooLargeError";
    this.bytes = bytes;
    this.limit = limit;
  }
}

/**
 * How many UTF-8 bytes this code point costs once JSON-escaped inside a string.
 * The chunk's payload is escaped a second time when the frame is stringified, so
 * measuring the raw text is not enough: "\\" doubles and a control character sextuples.
 */
function escapedByteLength(codePoint) {
  if (codePoint === 0x22 || codePoint === 0x5c) return 2; // " and \
  if (codePoint < 0x20) {
    // \b \t \n \f \r have two-character escapes; everything else becomes \u00xx.
    return codePoint === 8 || codePoint === 9 || codePoint === 10 || codePoint === 12 || codePoint === 13
      ? 2
      : 6;
  }
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  // Lone surrogates survive as \udXXX escapes; real pairs stay as 4 UTF-8 bytes.
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Split one logical message into native frames. Small messages pass through
 * untouched; big ones become `{id, chunk, of, data}` carrying slices of the JSON
 * text, which the receiver concatenates and parses once.
 *
 * Every returned frame is under `max` bytes *when encoded*, which is what Chrome's
 * 1 MiB native-messaging limit actually measures.
 */
export function chunkMessage(message, max = MAX_CHUNK_BYTES) {
  const text = JSON.stringify(message);
  const size = Buffer.byteLength(text, "utf8");
  if (size <= max) return [message];
  // The receiver would refuse to reassemble this, so say so now, while the caller can
  // still turn it into an error the model can read.
  if (size > MAX_ASSEMBLED_BYTES) throw new MessageTooLargeError(size, MAX_ASSEMBLED_BYTES);

  const id = message.id ?? `chunked_${process.pid}_${chunkSeq++}`;
  // The envelope with the largest plausible counters, so the budget is never optimistic.
  const overhead = Buffer.byteLength(
    JSON.stringify({ id, chunk: MAX_CHUNKS, of: MAX_CHUNKS, data: "" }),
    "utf8",
  );
  const budget = max - overhead;
  if (budget <= 0) throw new Error(`chunk limit ${max} is too small for a frame envelope`);

  const parts = [];
  let current = "";
  let used = 0;
  for (const character of text) {
    const cost = escapedByteLength(character.codePointAt(0));
    if (used + cost > budget) {
      parts.push(current);
      current = "";
      used = 0;
    }
    current += character;
    used += cost;
  }
  if (current) parts.push(current);

  if (parts.length > MAX_CHUNKS) {
    throw new Error(`message needs ${parts.length} chunks, over the ${MAX_CHUNKS} limit`);
  }
  return parts.map((data, index) => ({ id, chunk: index, of: parts.length, data }));
}

export function isChunk(message) {
  return message != null && typeof message === "object" && typeof message.chunk === "number"
    && typeof message.of === "number" && typeof message.data === "string";
}

/**
 * Reassembles `chunkMessage` output; returns null until the last piece arrives.
 *
 * `onEvict(id, reason)` fires whenever a half-finished message is thrown away. Silence
 * there would leave whoever is waiting for that reply to sit out their whole timeout,
 * so the host turns it into an error for that request.
 */
export class ChunkAssembler {
  #pending = new Map();
  #onEvict;

  constructor({ onEvict } = {}) {
    this.#onEvict = typeof onEvict === "function" ? onEvict : null;
  }

  #evict(id, reason) {
    this.#pending.delete(id);
    if (this.#onEvict) this.#onEvict(id, reason);
  }

  accept(message, now = Date.now()) {
    if (!isChunk(message)) return message;
    this.sweep(now);

    const { id, chunk, of, data } = message;
    if (!Number.isInteger(of) || of < 1 || of > MAX_CHUNKS) {
      throw new Error(`chunk count out of range: ${of}`);
    }
    if (!Number.isInteger(chunk) || chunk < 0 || chunk >= of) {
      throw new Error(`chunk index out of range: ${chunk} of ${of}`);
    }

    let slot = this.#pending.get(id);
    if (!slot) {
      slot = { of, parts: new Array(of).fill(null), seen: 0, bytes: 0, at: now };
      this.#pending.set(id, slot);
      this.#evictOldest();
    }
    if (slot.of !== of) throw new Error(`chunk count changed mid-message for ${id}`);
    if (slot.parts[chunk] === null) slot.seen += 1;
    else slot.bytes -= Buffer.byteLength(slot.parts[chunk], "utf8");
    slot.parts[chunk] = data;
    slot.bytes += Buffer.byteLength(data, "utf8");
    slot.at = now;
    if (slot.bytes > MAX_ASSEMBLED_BYTES) {
      this.#pending.delete(id);
      throw new Error(`chunked message ${id} exceeded ${MAX_ASSEMBLED_BYTES} bytes`);
    }

    this.#evictOldest();
    if (slot.seen < slot.of) return null;
    this.#pending.delete(id);
    return JSON.parse(slot.parts.join(""));
  }

  /**
   * Drop expired partials. Called on every accept, and on a timer by the owner: a peer
   * that abandons half a message and then goes quiet would otherwise pin it forever.
   */
  sweep(now = Date.now()) {
    for (const [id, slot] of this.#pending) {
      if (now - slot.at > CHUNK_TTL_MS) this.#evict(id, "it was left unfinished for too long");
    }
  }

  /** Aggregate caps: the oldest half-message gives way to the newest. */
  #evictOldest() {
    let total = 0;
    for (const slot of this.#pending.values()) total += slot.bytes;
    while (this.#pending.size > MAX_PARTIAL_MESSAGES || total > MAX_PENDING_BYTES) {
      let oldestId = null;
      let oldestAt = Infinity;
      for (const [id, slot] of this.#pending) {
        if (slot.at < oldestAt) {
          oldestAt = slot.at;
          oldestId = id;
        }
      }
      if (oldestId === null) return;
      total -= this.#pending.get(oldestId).bytes;
      this.#evict(oldestId, "too many unfinished messages were in flight at once");
    }
  }

  get pendingCount() {
    return this.#pending.size;
  }

  get pendingBytes() {
    let total = 0;
    for (const slot of this.#pending.values()) total += slot.bytes;
    return total;
  }
}

// --- socket line codec ----------------------------------------------------

export function encodeLine(object) {
  const text = JSON.stringify(object);
  if (Buffer.byteLength(text, "utf8") > MAX_LINE_BYTES) {
    throw new Error(`message too large for the socket: ${Buffer.byteLength(text, "utf8")} bytes`);
  }
  return `${text}\n`;
}

const NEWLINE = 0x0a;

/**
 * Newline-delimited JSON with a hard cap, so a wedged peer cannot exhaust memory.
 *
 * Buffering is done in bytes, not in a string: a socket read can land in the middle of
 * a multi-byte character, and decoding each read on its own would replace both halves
 * with U+FFFD. A newline byte can never be part of a UTF-8 sequence, so splitting on it
 * before decoding is safe.
 */
export class LineDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, bytes]) : Buffer.from(bytes);
    const out = [];
    for (;;) {
      const newline = this.#buffer.indexOf(NEWLINE);
      if (newline === -1) {
        if (this.#buffer.length > MAX_LINE_BYTES) {
          throw new Error("socket line exceeded the 4 MiB limit");
        }
        return out;
      }
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line.length > MAX_LINE_BYTES) {
        throw new Error("socket line exceeded the 4 MiB limit");
      }
      const text = line.toString("utf8").trim();
      if (text === "") continue;
      out.push(JSON.parse(text));
    }
  }
}

// --- runtime paths --------------------------------------------------------

export function runtimeDir(env = process.env) {
  if (env.BROWSER_BRIDGE_RUNTIME_DIR) return path.resolve(env.BROWSER_BRIDGE_RUNTIME_DIR);
  return path.join(env.HOME || homedir(), "Library", "Application Support", "BrowserBridge");
}

export function socketPath(env = process.env) {
  return path.join(runtimeDir(env), "bridge.sock");
}

export function logPath(env = process.env) {
  return path.join(runtimeDir(env), "host.log");
}

export function screenshotsDir(env = process.env) {
  return path.join(runtimeDir(env), "screenshots");
}

export function configPath(env = process.env) {
  return path.join(runtimeDir(env), "config.json");
}

export function launcherPath(env = process.env) {
  return path.join(runtimeDir(env), "native-host");
}

// --- the shared MCP daemon ------------------------------------------------

/**
 * Loopback port for the streamable-HTTP MCP daemon. Nothing registers it with IANA;
 * it only has to be a port nothing else on this machine wants. The installer writes it
 * into daemon.json, and that file is what everything reads, so changing the constant
 * only affects a fresh install.
 */
export const DEFAULT_DAEMON_PORT = 47331;

export function daemonConfigPath(env = process.env) {
  return path.join(runtimeDir(env), "daemon.json");
}

export function daemonLogPath(env = process.env) {
  return path.join(runtimeDir(env), "daemon.log");
}

/** Which MCP session id had which browser sessionKey; see mcp/registry.js. */
export function sessionsPath(env = process.env) {
  return path.join(runtimeDir(env), "sessions.json");
}

/**
 * `{port, token, secret}` from daemon.json, or null when it is missing or unreadable. A
 * missing file is the normal state before the installer has ever run, and neither the daemon
 * nor the headers helper may treat it as a crash: a session must start either way.
 *
 * `token` authenticates a request. `secret` is what session keys are derived from and never
 * leaves this machine - the helper does not read it and it is never sent in a header. An
 * install from before it existed has a token and no secret; the daemon says so and the
 * installer adds one without touching the token.
 */
export function readDaemonConfig(env = process.env) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(daemonConfigPath(env), "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const token = typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null;
  if (!token) return null;
  const secret = typeof parsed.secret === "string" && /^[0-9a-f]{32,}$/.test(parsed.secret) ? parsed.secret : null;
  // Port 0 means "any free port"; the tests use it, and the daemon reports what it got.
  const port = Number.isInteger(parsed.port) && parsed.port >= 0 && parsed.port <= 65535
    ? parsed.port
    : DEFAULT_DAEMON_PORT;
  return { port, token, secret };
}

export function daemonUrl(port) {
  return `http://127.0.0.1:${port}/mcp`;
}
