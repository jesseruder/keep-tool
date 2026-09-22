'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const test = require('node:test');
const { FrameDecoder, encodeFrame } = require('./host.js');
const { connect } = require('./hostclient.js');

test('a reply delivered after the request timer fires wins before its immediate rejects', async () => {
  const originalCreateConnection = net.createConnection;
  const originalSetImmediate = global.setImmediate;
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.end = () => {};
  socket.destroy = () => { socket.destroyed = true; };
  const requests = new FrameDecoder((frame) => {
    setTimeout(() => socket.emit('data', encodeFrame({ id: frame.id, ok: true, value: 'late' })), 8);
  });
  socket.write = (data, callback) => { requests.push(data); callback?.(); return true; };
  let client;
  try {
    net.createConnection = () => { queueMicrotask(() => socket.emit('connect')); return socket; };
    client = await connect({ sock: '/tmp/unit-host.sock' });
    // Delay only the timeout's check-phase callback. The socket reply lands after the
    // timer became due but before that callback gets to reject the pending request.
    global.setImmediate = (callback, ...args) => setTimeout(callback, 15, ...args);
    assert.deepEqual(await client.request('late', {}, { timeoutMs: 5 }), { value: 'late' });
  } finally {
    global.setImmediate = originalSetImmediate;
    net.createConnection = originalCreateConnection;
    client?.close();
  }
});
