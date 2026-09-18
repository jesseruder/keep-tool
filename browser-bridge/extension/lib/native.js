// The native messaging port: connect, reconnect, and chunk anything Chrome would
// refuse to carry in one message.
//
// Runs only inside the service worker (it touches chrome.runtime), so the tests do not
// import this file.

export const HOST_NAME = "com.keep.browser_bridge";
/** Chrome caps a native message at 1 MiB each way; split before we get near it. */
export const MAX_CHUNK_BYTES = 768 * 1024;

const encoder = new TextEncoder();

export function chunkMessage(message, max = MAX_CHUNK_BYTES) {
  const text = JSON.stringify(message);
  const bytes = encoder.encode(text);
  if (bytes.length <= max) return [message];

  const decoder = new TextDecoder();
  const parts = [];
  let offset = 0;
  while (offset < bytes.length) {
    let end = Math.min(offset + max, bytes.length);
    // Never cut a UTF-8 sequence in half.
    while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    parts.push(decoder.decode(bytes.subarray(offset, end)));
    offset = end;
  }
  const id = message.id ?? `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return parts.map((data, index) => ({ id, chunk: index, of: parts.length, data }));
}

export class ChunkAssembler {
  #pending = new Map();

  accept(message) {
    if (!message || typeof message.chunk !== "number" || typeof message.data !== "string") {
      return message;
    }
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
}

export class NativeBridge {
  #port = null;
  #assembler = new ChunkAssembler();
  #onRequest;
  #onStatus;
  #connectedAt = null;
  #lastError = null;

  constructor({ onRequest, onStatus }) {
    this.#onRequest = onRequest;
    this.#onStatus = onStatus ?? (() => {});
  }

  get connected() {
    return this.#port !== null;
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
        this.send({ event: "pong" });
        return;
      }
      Promise.resolve(this.#onRequest(message)).catch((error) => {
        console.error("browser-bridge: request handler threw", error);
      });
    });

    this.#port.onDisconnect.addListener(() => {
      this.#lastError = chrome.runtime.lastError?.message ?? null;
      this.#port = null;
      this.#connectedAt = null;
      this.#assembler = new ChunkAssembler();
      this.#onStatus(this.status);
    });

    this.send({ event: "ready", version: chrome.runtime.getManifest().version });
    this.#onStatus(this.status);
  }

  send(message) {
    if (!this.#port) return false;
    try {
      for (const frame of chunkMessage(message)) this.#port.postMessage(frame);
      return true;
    } catch (error) {
      this.#lastError = error.message;
      return false;
    }
  }

  disconnect() {
    if (!this.#port) return;
    try {
      this.#port.disconnect();
    } finally {
      this.#port = null;
      this.#connectedAt = null;
    }
  }
}
