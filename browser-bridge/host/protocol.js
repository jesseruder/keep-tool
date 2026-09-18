// Wire formats shared by the native host, the MCP server, the installer and the tests.
//
// Pure Node: no `chrome` global, no side effects on import, so the tests can load it.

import { createHash } from "node:crypto";
import { endianness, homedir } from "node:os";
import path from "node:path";

// --- identity -------------------------------------------------------------

export const HOST_NAME = "com.keep.browser_bridge";

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

/**
 * Split one logical message into native frames. Small messages pass through
 * untouched; big ones become `{id, chunk, of, data}` carrying slices of the JSON
 * text, which the receiver concatenates and parses once.
 */
export function chunkMessage(message, max = MAX_CHUNK_BYTES) {
  const text = JSON.stringify(message);
  if (Buffer.byteLength(text, "utf8") <= max) return [message];

  // Slice on UTF-8 byte boundaries so no surrogate pair is cut in half.
  const bytes = Buffer.from(text, "utf8");
  const parts = [];
  let offset = 0;
  while (offset < bytes.length) {
    let end = Math.min(offset + max, bytes.length);
    while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    parts.push(bytes.subarray(offset, end).toString("utf8"));
    offset = end;
  }

  const id = message.id ?? `chunked_${process.pid}_${chunkSeq++}`;
  return parts.map((data, index) => ({ id, chunk: index, of: parts.length, data }));
}

export function isChunk(message) {
  return message != null && typeof message === "object" && typeof message.chunk === "number"
    && typeof message.of === "number" && typeof message.data === "string";
}

/** Reassembles `chunkMessage` output; returns null until the last piece arrives. */
export class ChunkAssembler {
  #pending = new Map();

  accept(message) {
    if (!isChunk(message)) return message;
    const { id, chunk, of, data } = message;
    let slot = this.#pending.get(id);
    if (!slot) {
      slot = { of, parts: new Array(of).fill(null), seen: 0 };
      this.#pending.set(id, slot);
    }
    if (slot.parts[chunk] === null) slot.seen += 1;
    slot.parts[chunk] = data;
    if (slot.seen < slot.of) return null;
    this.#pending.delete(id);
    return JSON.parse(slot.parts.join(""));
  }

  get pendingCount() {
    return this.#pending.size;
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

/** Newline-delimited JSON with a hard cap, so a wedged peer cannot exhaust memory. */
export class LineDecoder {
  #buffer = "";

  push(chunk) {
    this.#buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const out = [];
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) {
        if (Buffer.byteLength(this.#buffer, "utf8") > MAX_LINE_BYTES) {
          throw new Error("socket line exceeded the 4 MiB limit");
        }
        return out;
      }
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        throw new Error("socket line exceeded the 4 MiB limit");
      }
      if (line.trim() === "") continue;
      out.push(JSON.parse(line));
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
