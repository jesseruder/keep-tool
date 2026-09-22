'use strict';

const { createTerminalBridge } = require('./terminal-bridge.js');
const { connect } = require('./hostclient.js');

let bridge;
let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  try { bridge?.close(); } catch {}
  if (process.connected) process.disconnect();
  setImmediate(() => process.exit(0));
}

process.once('disconnect', stop);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.on('uncaughtException', (error) => {
  process.stderr.write(`[keep terminal relay] uncaught exception: ${error.stack || error.message}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  process.stderr.write(`[keep terminal relay] unhandled rejection: ${error && (error.stack || error.message) || error}\n`);
  process.exit(1);
});

process.on('message', (message, socket) => {
  if (!message || stopping) {
    socket?.destroy();
    return;
  }
  if (message.type === 'init') {
    if (bridge) return;
    // The node table arrives resolved, so the worker never reads the configuration
    // and a pane ref is all it needs to know which machine to open.
    const table = message.nodes && typeof message.nodes === 'object' ? message.nodes : {};
    bridge = createTerminalBridge({
      nodes: Object.keys(table),
      hostClient: (node) => {
        const resolved = table[node];
        if (!resolved) return Promise.reject(new Error(`unknown Keep node: ${node}`));
        return connect({
          node, resolvedNode: resolved, sock: resolved.sock, timeoutMs: message.hostConnectTimeoutMs,
        });
      },
    });
    const ready = () => process.send?.({ type: 'ready' });
    if (message.readyDelayMs > 0) setTimeout(ready, message.readyDelayMs);
    else ready();
    return;
  }
  if (message.type === 'shutdown') {
    stop();
    return;
  }
  if (message.type !== 'upgrade' || !socket || !bridge) {
    socket?.destroy();
    return;
  }
  try {
    const req = {
      method: message.request.method,
      url: message.request.url,
      headers: message.request.headers,
      rawHeaders: message.request.rawHeaders,
      httpVersion: message.request.httpVersion,
      socket,
      connection: socket,
    };
    bridge.handleUpgrade(req, socket, Buffer.from(message.head || '', 'base64'), message.connection);
    process.send?.({ type: 'accepted', id: message.id });
  } catch (error) {
    socket.destroy();
    process.send?.({ type: 'rejected', id: message.id, error: error.message });
  }
});
