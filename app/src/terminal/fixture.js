'use strict';

// The spike's pane replay, decoded the same way on the device and in the node test.
// Hermes has no Buffer, so the base64 decode is written out rather than borrowed.
// The fixture itself is synthetic and rebuilt by ./fixtures/generate.js — a capture of
// a real pane would commit whoever happened to be working in it.

const fixture = require('./fixtures/pane-synthetic.json');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Uint8Array(128);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

function decodeBase64(text) {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x3d /* = */) end--;
  const bytes = new Uint8Array(Math.floor((end * 6) / 8));
  let value = 0;
  let bits = 0;
  let out = 0;
  for (let i = 0; i < end; i++) {
    value = (value << 6) | LOOKUP[text.charCodeAt(i)];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (value >> bits) & 0xff;
    }
  }
  return bytes;
}

// A text frame stays a string: xterm parses either, and re-encoding it would be a
// chance to corrupt the very bytes the spike is checking.
function frameData(frame) {
  return frame.kind === 'binary' ? decodeBase64(frame.data) : frame.data;
}

function dataFrames() {
  return fixture.frames.filter((frame) => frame.kind !== 'json').map(frameData);
}

function jsonFrames() {
  return fixture.frames.filter((frame) => frame.kind === 'json').map((frame) => JSON.parse(frame.data));
}

module.exports = { fixture, decodeBase64, frameData, dataFrames, jsonFrames };
