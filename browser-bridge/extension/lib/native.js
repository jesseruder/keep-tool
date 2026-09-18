// The native messaging port: connect, reconnect, and chunk anything Chrome would
// refuse to carry in one message.
//
// Runs only inside the service worker (it touches chrome.runtime), so the tests do not
// import this file.

export const HOST_NAME = "com.keep.browser_bridge";
/** Chrome caps a native message at 1 MiB each way; split before we get near it. */
export const MAX_CHUNK_BYTES = 768 * 1024;
export const MAX_CHUNKS = 64;
export const MAX_ASSEMBLED_BYTES = 16 * 1024 * 1024;
export const CHUNK_TTL_MS = 60_000;
export const MAX_PARTIAL_MESSAGES = 8;
export const MAX_PENDING_BYTES = 32 * 1024 * 1024;
/** Expiry cannot wait for the next chunk: the port may go quiet mid-message. */
export const SWEEP_INTERVAL_MS = 30_000;

/** Mirrors host/protocol.js: a message the host could never reassemble. */
export class MessageTooLargeError extends Error {
  constructor(bytes, limit) {
    super(`result too large (${bytes} bytes, limit ${limit})`);
    this.name = "MessageTooLargeError";
    this.bytes = bytes;
    this.limit = limit;
  }
}

const encoder = new TextEncoder();

const byteLength = (text) => encoder.encode(text).length;

/**
 * Cost of one code point once JSON-escaped. The payload is escaped again when the frame
 * is stringified, so measuring the raw text would let a backslash-heavy screenshot
 * produce a frame over Chrome's 1 MiB limit. Mirrors host/protocol.js.
 */
function escapedByteLength(codePoint) {
  if (codePoint === 0x22 || codePoint === 0x5c) return 2;
  if (codePoint < 0x20) {
    return codePoint === 8 || codePoint === 9 || codePoint === 10 || codePoint === 12 || codePoint === 13
      ? 2
      : 6;
  }
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6;
  if (codePoint < 0x10000) return 3;
  return 4;
}

export function chunkMessage(message, max = MAX_CHUNK_BYTES) {
  const text = JSON.stringify(message);
  const size = byteLength(text);
  if (size <= max) return [message];
  if (size > MAX_ASSEMBLED_BYTES) throw new MessageTooLargeError(size, MAX_ASSEMBLED_BYTES);

  const id = message.id ?? `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const overhead = byteLength(JSON.stringify({ id, chunk: MAX_CHUNKS, of: MAX_CHUNKS, data: "" }));
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

export class ChunkAssembler {
  #pending = new Map();

  accept(message, now = Date.now()) {
    if (!message || typeof message.chunk !== "number" || typeof message.data !== "string") {
      return message;
    }
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
    else slot.bytes -= byteLength(slot.parts[chunk]);
    slot.parts[chunk] = data;
    slot.bytes += byteLength(data);
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

  /** Drop expired partials; called on accept and on the bridge's sweep timer. */
  sweep(now = Date.now()) {
    for (const [id, slot] of this.#pending) {
      if (now - slot.at > CHUNK_TTL_MS) this.#pending.delete(id);
    }
  }

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
      this.#pending.delete(oldestId);
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

export class NativeBridge {
  #port = null;
  #assembler = new ChunkAssembler();
  #onRequest;
  #onStatus;
  #connectedAt = null;
  #lastError = null;
  #generation = 0;
  #sweepTimer = null;

  constructor({ onRequest, onStatus }) {
    this.#onRequest = onRequest;
    this.#onStatus = onStatus ?? (() => {});
  }

  get connected() {
    return this.#port !== null;
  }

  /**
   * Bumped on every connect. A reply must carry the generation its request arrived on:
   * the host that asked is dead, and the new one may have handed the same wire id to a
   * different client.
   */
  get generation() {
    return this.#generation;
  }

  get status() {
    return {
      connected: this.connected,
      connectedAt: this.#connectedAt,
      lastError: this.#lastError,
    };
  }

  connect() {
    if (this.#port) return;
    try {
      this.#port = chrome.runtime.connectNative(HOST_NAME);
    } catch (error) {
      this.#lastError = error.message;
      this.#onStatus(this.status);
      return;
    }
    this.#connectedAt = new Date().toISOString();
    this.#lastError = null;
    this.#generation += 1;
    const generation = this.#generation;

    this.#port.onMessage.addListener((raw) => {
      let message;
      try {
        message = this.#assembler.accept(raw);
      } catch (error) {
        console.error("browser-bridge: bad chunk", error);
        return;
      }
      if (message === null) return;
      if (message.method === "ping") {
        this.sendFor(generation, { event: "pong" });
        return;
      }
      Promise.resolve(this.#onRequest(message, generation)).catch((error) => {
        console.error("browser-bridge: request handler threw", error);
      });
    });

    // Expiry that only runs when a chunk arrives never runs on a quiet port.
    this.#sweepTimer = setInterval(() => this.#assembler.sweep(), SWEEP_INTERVAL_MS);
    // Housekeeping should never be the reason a process stays alive (Node only; the
    // service worker's timer handle has no unref).
    this.#sweepTimer?.unref?.();

    this.#port.onDisconnect.addListener(() => {
      this.#lastError = chrome.runtime.lastError?.message ?? null;
      this.#port = null;
      this.#connectedAt = null;
      this.#assembler = new ChunkAssembler();
      this.#stopSweeping();
      this.#onStatus(this.status);
    });

    this.send({ event: "ready", version: chrome.runtime.getManifest().version });
    this.#onStatus(this.status);
  }

  send(message) {
    if (!this.#port) return false;
    let frames;
    try {
      frames = chunkMessage(message);
    } catch (error) {
      // A result the host could never reassemble becomes a readable error for the
      // model instead of frames it will drop, leaving the caller to time out.
      if (error instanceof MessageTooLargeError && message.id != null) {
        this.#lastError = error.message;
        frames = [{ id: message.id, ok: false, error: { message: error.message } }];
      } else {
        this.#lastError = error.message;
        return false;
      }
    }
    try {
      for (const frame of frames) this.#port.postMessage(frame);
      return true;
    } catch (error) {
      this.#lastError = error.message;
      return false;
    }
  }

  /** Send only if the port that asked is still the one we hold. */
  sendFor(generation, message) {
    if (generation !== this.#generation) return false;
    return this.send(message);
  }

  #stopSweeping() {
    if (this.#sweepTimer === null) return;
    clearInterval(this.#sweepTimer);
    this.#sweepTimer = null;
  }

  disconnect() {
    if (!this.#port) return;
    try {
      this.#port.disconnect();
    } finally {
      this.#port = null;
      this.#connectedAt = null;
      this.#stopSweeping();
    }
  }
}
