#!/usr/bin/env node
'use strict';

const mode = process.argv[2];

if (mode === 'host') {
  const fs = require('node:fs');
  const net = require('node:net');
  const sock = process.argv[3];
  try { fs.unlinkSync(sock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pane = {
    id: 'relay-pane', alive: true, cols: 120, rows: 40, primary: null,
    meta: { agent: 'shell', title: 'relay fixture' },
  };
  const sockets = new Set();
  const send = (socket, frame) => socket.write(`${JSON.stringify(frame)}\n`);
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let pending = '';
    let viewer = null;
    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        if (request.type === 'attach') {
          viewer = request.viewer;
          if (request.primary && pane.primary == null) pane.primary = viewer;
          send(socket, {
            ok: true, id: request.id, pane: { ...pane },
            history: { lines: 1, sent: 1, truncated: false },
          });
          send(socket, {
            ev: 'data', pane: pane.id, data: Buffer.from('snapshot').toString('base64'),
            replay: true, snapshot: true,
          });
        } else if (request.type === 'subscribe' || request.type === 'detach'
            || request.type === 'clear' || request.type === 'visibility') {
          send(socket, { ok: true, id: request.id, pane: { ...pane } });
        } else if (request.type === 'input') {
          const data = Buffer.from(request.data, 'base64');
          process.send?.({ type: 'input', data: data.toString('base64'), auto: request.auto === true });
          send(socket, { ok: true, id: request.id, pane: { ...pane } });
          send(socket, { ev: 'data', pane: pane.id, data: request.data, replay: false });
        } else if (request.type === 'resize') {
          if (request.force) pane.primary = viewer;
          const applied = request.force || pane.primary === viewer;
          if (applied) {
            pane.cols = request.cols;
            pane.rows = request.rows;
          }
          process.send?.({
            type: 'resize', force: request.force === true, cols: request.cols, rows: request.rows,
            applied, primary: pane.primary,
          });
          send(socket, { ok: true, id: request.id, pane: { ...pane }, applied, primary: pane.primary });
        } else if (request.type === 'get') {
          send(socket, { ok: true, id: request.id, pane: { ...pane } });
        } else {
          send(socket, { ok: false, id: request.id, error: `unsupported ${request.type}` });
        }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  const stop = () => {
    for (const socket of sockets) socket.destroy();
    server.close(() => process.exit(0));
  };
  process.once('disconnect', stop);
  process.once('SIGTERM', stop);
  server.listen(sock, () => process.send?.({ type: 'ready' }));
} else if (mode === 'client') {
  const WebSocket = require('ws');
  const ws = new WebSocket(process.argv[3], {
    origin: process.argv[4],
    headers: process.argv[5] ? { 'x-keep-token': process.argv[5] } : undefined,
  });
  let sentAt = 0;
  ws.on('open', () => process.send?.({ type: 'open' }));
  ws.on('message', (data, binary) => {
    if (!binary) {
      let message;
      try { message = JSON.parse(data.toString('utf8')); } catch { return; }
      process.send?.({ type: 'text', message });
      return;
    }
    if (sentAt && data.toString('base64') !== Buffer.from('snapshot').toString('base64')) {
      process.send?.({ type: 'echo', data: data.toString('base64'), elapsed: Date.now() - sentAt });
      process.send?.({ type: 'timing', sentAt, echoAt: Date.now() });
      sentAt = 0;
    }
  });
  ws.on('close', (code) => process.send?.({ type: 'close', code }));
  ws.on('error', (error) => process.send?.({ type: 'error', error: error.message }));
  process.on('message', (message) => {
    if (message?.type === 'send') {
      setTimeout(() => {
        sentAt = Date.now();
        ws.send(Buffer.from(message.data, 'base64'));
      }, message.delay || 0);
    } else if (message?.type === 'text') {
      ws.send(JSON.stringify(message.message));
    } else if (message?.type === 'close') {
      ws.close();
    }
  });
  process.once('disconnect', () => {
    ws.terminate();
    process.exit(0);
  });
} else {
  throw new Error(`unknown fixture mode: ${mode}`);
}
