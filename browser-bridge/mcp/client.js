// Socket client: one per MCP server process, reconnecting to whichever host the
// browser last spawned and replaying `hello` so the session keeps its tab group.

import net from "node:net";

import { LineDecoder, encodeLine } from "../host/protocol.js";

/** The host's own timeout is 90 s; give it a little room before we give up too. */
const REQUEST_TIMEOUT_MS = 100_000;
const BACKOFF_MS = [100, 500, 1000, 2000];

export class BridgeUnavailableError extends Error {
  constructor(reason) {
    super(`Browser Bridge is not connected: ${reason}. Open Edge with the Browser Bridge extension enabled.`);
    this.name = "BridgeUnavailableError";
    this.reason = reason;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class BridgeClient {
  #socket = null;
  #decoder = new LineDecoder();
  #pending = new Map();
  #seq = 0;
  #connecting = null;

  constructor({ socketPath, sessionKey, name, agent = null, account = null, attempts = BACKOFF_MS.length }) {
    this.socketPath = socketPath;
    this.sessionKey = sessionKey;
    this.name = name;
    this.agent = agent;
    this.account = account;
    this.attempts = attempts;
    this.lastHostStatus = null;
  }

  get connected() {
    return this.#socket !== null && !this.#socket.destroyed;
  }

  #teardown(error) {
    const socket = this.#socket;
    this.#socket = null;
    this.#decoder = new LineDecoder();
    if (socket) socket.destroy();
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(error ?? new BridgeUnavailableError("the connection to the host closed"));
    }
    this.#pending.clear();
  }

  #openSocket() {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.socketPath);
      const onError = (error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        socket.setNoDelay(true);
        socket.on("data", (chunk) => {
          let messages;
          try {
            messages = this.#decoder.push(chunk);
          } catch (error) {
            this.#teardown(error);
            return;
          }
          for (const message of messages) this.#onMessage(message);
        });
        socket.on("error", () => this.#teardown(new BridgeUnavailableError("the socket errored")));
        socket.on("close", () => this.#teardown(new BridgeUnavailableError("the host closed the connection")));
        this.#socket = socket;
        resolve(socket);
      });
    });
  }

  async #ensureConnected() {
    if (this.connected) return;
    if (this.#connecting) return this.#connecting;
    this.#connecting = (async () => {
      let lastError = null;
      for (let attempt = 0; attempt < this.attempts; attempt++) {
        try {
          await this.#openSocket();
          this.lastHostStatus = await this.#send("hello", {
            sessionKey: this.sessionKey,
            name: this.name,
            agent: this.agent,
            account: this.account,
          });
          return;
        } catch (error) {
          lastError = error;
          this.#teardown(new BridgeUnavailableError("reconnecting"));
          const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
          if (attempt + 1 < this.attempts) await sleep(delay);
        }
      }
      const reason =
        lastError?.code === "ENOENT"
          ? "no host is listening on the bridge socket"
          : (lastError?.message ?? "unknown error");
      throw new BridgeUnavailableError(reason);
    })();
    try {
      await this.#connecting;
    } finally {
      this.#connecting = null;
    }
  }

  #onMessage(message) {
    const entry = this.#pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.#pending.delete(message.id);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error?.message ?? "the browser extension reported an error"));
  }

  #send(method, params) {
    const id = `c${++this.#seq}`;
    return new Promise((resolve, reject) => {
      if (!this.#socket) {
        reject(new BridgeUnavailableError("not connected"));
        return;
      }
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out after ${REQUEST_TIMEOUT_MS / 1000}s waiting for ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#socket.write(encodeLine({ id, method, params: params ?? {} }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  /** One retry: the host dies with the service worker, so a stale socket is routine. */
  async request(method, params, { retry = true } = {}) {
    await this.#ensureConnected();
    try {
      return await this.#send(method, params);
    } catch (error) {
      if (!retry || !(error instanceof BridgeUnavailableError)) throw error;
      this.#teardown(error);
      await this.#ensureConnected();
      return this.#send(method, params);
    }
  }

  async close() {
    if (!this.connected) return;
    try {
      await this.#send("bye", {});
    } catch {
      // the host may already be gone
    }
    this.#teardown(new BridgeUnavailableError("closed"));
  }
}
