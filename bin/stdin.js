'use strict';

// Read all of fd 0 without touching process.stdin. Reading process.stdin (even its
// isTTY getter) wraps fd 0 in a stream that switches a pipe to non-blocking, and
// fs.readFileSync(0) then fails with EAGAIN as soon as the writer is slower than the
// reader: any input past the pipe buffer (about 64 KiB) was read as nothing. The same
// happens when a parent hands over a pipe that is already non-blocking, so EAGAIN is
// waited out here instead of ending the read.
const fs = require('fs');
const tty = require('tty');

const CHUNK = 64 * 1024;
const WAIT_MS = 5;
// A writer that stops mid-input for this long is treated as done. A blocking pipe
// never reaches this: readSync waits in the kernel, as readFileSync(0) always did.
const STALL_MS = 10000;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Returns null when fd 0 is a terminal (run by hand: never block on a TTY) or is not
// open; otherwise the whole input as a string (possibly empty). `readSync` is fs's
// unless a test stands in for the descriptor.
function readStdin({ fd = 0, isatty = tty.isatty, stallMs = STALL_MS, readSync = fs.readSync } = {}) {
  if (isatty(fd)) return null;
  const chunks = [];
  let lastProgress = Date.now();
  for (;;) {
    const buffer = Buffer.allocUnsafe(CHUNK);
    let read;
    try {
      read = readSync(fd, buffer, 0, CHUNK, null);
    } catch (error) {
      if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK') {
        if (Date.now() - lastProgress > stallMs) break;
        sleep(WAIT_MS);
        continue;
      }
      if (error.code === 'EOF') break;
      if (!chunks.length && (error.code === 'EBADF' || error.code === 'EINVAL' || error.code === 'ENXIO')) return null;
      throw error;
    }
    if (read === 0) break;
    chunks.push(buffer.subarray(0, read));
    lastProgress = Date.now();
  }
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = { readStdin };
