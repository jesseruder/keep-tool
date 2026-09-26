// Socket client: one per MCP server process, reconnecting to whichever host the
// browser last spawned and replaying `hello` so the session keeps its tab group.

import net from "node:net";

import { LineDecoder, encodeLine } from "../host/protocol.js";

/** The host's own timeout is 90 s; give it a little room before we give up too. */
const REQUEST_TIMEOUT_MS = 100_000;
/** How long `close()` waits for the host to acknowledge `bye`. See close(). */
export const CLOSE_TIMEOUT_MS = 2_000;
const BACKOFF_MS = [100, 500, 1000, 2000];

export class BridgeUnavailableError extends Error {
  constructor(reason) {
    super(`Browser Bridge is not connected: ${reason}. Open Edge with the Browser Bridge extension enabled.`);
    this.name = "BridgeUnavailableError";
    this.reason = reason;
  }
}

/**
 * The connection dropped after the request was already on the wire. The browser may
 * have carried it out, so replaying it could click, type or run the code twice.
 */
export class BridgeInterruptedError extends Error {
  constructor(method) {
    super(
      `The connection to the browser dropped after ${method} was sent, so it may or may not have run. ` +
        "Take a screenshot or read the page before retrying.",
    );
    this.name = "BridgeInterruptedError";
    this.method = method;
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
      // A request that never left this process is safe to replay; one that did is not.
      entry.reject(
        entry.written && entry.method !== "hello"
          ? new BridgeInterruptedError(entry.method)
          : (error ?? new BridgeUnavailableError("the connection to the host closed")),
      );
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
      const entry = { resolve, reject, timer, method, written: false };
      this.#pending.set(id, entry);
      try {
        this.#socket.write(encodeLine({ id, method, params: params ?? {} }));
        entry.written = true;
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        // Nothing went out, so this one is safe to retry on a fresh connection.
        reject(new BridgeUnavailableError(`could not write to the host socket: ${error.message}`));
      }
    });
  }

  /**
   * A new name for this session, which the host passes to the extension with every request
   * from now on. A disconnected client connects to deliver it, and a host from before
   * rename is reconnected: either way the hello carries it, and this resolves only then.
   */
  async rename(name) {
    const previous = this.name;
    this.name = name;
    try {
      // Not connected: the hello that connects carries the name.
      if (!this.connected) {
        await this.#ensureConnected();
        return;
      }
      try {
        await this.#send("rename", { name });
      } catch (error) {
        // A host from before rename: start again, and the new hello carries the name.
        if (!/Unknown method: rename/.test(error?.message ?? "")) throw error;
        this.#teardown(new BridgeUnavailableError("reconnecting with a new name"));
        await this.#ensureConnected();
      }
    } catch (error) {
      // Refused: a later reconnect must not slip the name in behind the daemon's back.
      this.name = previous;
      throw error;
    }
  }

  /**
   * One retry, and only when the request never reached the socket: the host dies with
   * the service worker, so a stale connection is routine, but a request that was already
   * sent may have clicked something and must not be replayed.
   */
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

  /**
   * Say `bye` so the host can drop the session, but never wait long for the answer. On
   * SIGTERM the daemon closes every session at once and launchd will SIGKILL it shortly
   * after; a wedged host that let `bye` run out the full request timeout used to mean *no*
   * session said goodbye and the extension kept every tab group listed as live. The write is
   * what the host needs, and that has already happened by the time we stop waiting.
   */
  async close({ timeoutMs = CLOSE_TIMEOUT_MS } = {}) {
    if (!this.connected) return;
    let timer = null;
    try {
      // The timer is cleared rather than left to fire: an unreferenced pending timeout
      // would hold the process open for its whole duration after a close that was quick.
      const deadline = new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([this.#send("bye", {}), deadline]);
    } catch {
      // the host may already be gone
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.#teardown(new BridgeUnavailableError("closed"));
  }
}
