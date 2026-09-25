// A viewer's connection to the native host: what Keep's terminal host uses to stream a
// session's tabs to the console. It says hello with the daemon token (a viewer can watch
// and drive every session's tabs, so it needs what driving the browser needs), then sends
// viewer_* requests and hears viewer_frame / viewer_state events.
//
// One connection per open view. It does not reconnect: a host that restarts has lost the
// view anyway, and the console opens a new one.

import net from "node:net";

import { LineDecoder, encodeLine, readDaemonConfig, socketPath } from "./protocol.js";

const REQUEST_TIMEOUT_MS = 30_000;

export class ViewerUnavailableError extends Error {
  constructor(reason) {
    super(`the browser on this machine cannot be viewed: ${reason}`);
    this.name = "ViewerUnavailableError";
  }
}

/**
 * Connect and say hello. Resolves to {request, notify, close, hostStatus}; `onEvent` gets
 * every id-less message and `onClose` fires once when the socket goes.
 */
export function connectViewer({ env = process.env, name = "keep console", onEvent = () => {}, onClose = () => {} } = {}) {
  const config = readDaemonConfig(env);
  if (!config) return Promise.reject(new ViewerUnavailableError("Browser Bridge is not installed (no daemon.json)"));
  const pathToSocket = socketPath(env);

  return new Promise((resolve, reject) => {
    const socket = net.connect(pathToSocket);
    const decoder = new LineDecoder();
    const pending = new Map();
    let seq = 0;
    let closed = false;
    let helloDone = false;

    const finish = (error) => {
      if (closed) return;
      closed = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error ?? new ViewerUnavailableError("the connection to the browser closed"));
      }
      pending.clear();
      socket.destroy();
      if (!helloDone) reject(error ?? new ViewerUnavailableError("the browser closed the connection"));
      else onClose(error ?? null);
    };

    const request = (method, params = {}) => {
      if (closed) return Promise.reject(new ViewerUnavailableError("the connection to the browser closed"));
      const id = ++seq;
      return new Promise((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectRequest(new Error(`timed out waiting for the browser (${method})`));
        }, REQUEST_TIMEOUT_MS);
        timer.unref?.();
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
        socket.write(encodeLine({ id, method, params }));
      });
    };

    const notify = (method, params = {}) => {
      if (!closed) socket.write(encodeLine({ method, params }));
    };

    socket.on("connect", async () => {
      try {
        const status = await request("hello", { viewer: true, token: config.token, name });
        helloDone = true;
        resolve({
          request,
          notify,
          hostStatus: status,
          close: () => finish(null),
          get closed() {
            return closed;
          },
        });
      } catch (error) {
        finish(new ViewerUnavailableError(error.message));
      }
    });
    socket.on("data", (chunk) => {
      let messages;
      try {
        messages = decoder.push(chunk);
      } catch (error) {
        finish(error);
        return;
      }
      for (const message of messages) {
        if (message && typeof message.event === "string") {
          onEvent(message);
          continue;
        }
        const entry = pending.get(message?.id);
        if (!entry) continue;
        clearTimeout(entry.timer);
        pending.delete(message.id);
        if (message.ok) entry.resolve(message.result);
        else entry.reject(new Error(message.error?.message ?? "the browser refused the request"));
      }
    });
    socket.on("error", (error) => {
      const reason = error.code === "ENOENT" || error.code === "ECONNREFUSED"
        ? "Edge is not running with the Browser Bridge extension"
        : error.message;
      finish(new ViewerUnavailableError(reason));
    });
    socket.on("close", () => finish(null));
  });
}
