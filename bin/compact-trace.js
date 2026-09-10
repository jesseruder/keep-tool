'use strict';
const crypto = require('node:crypto');

// Metadata only: never include transcript paths, commands, or screen contents.
function compactTrace(session, write = line => process.stderr.write(line), now = Date.now) {
  const started = now();
  const safe = value => /^[a-zA-Z0-9_-]{1,160}$/.test(String(value || '')) ? String(value) : null;
  const row = { attempt: crypto.randomUUID(), session: safe(session.id), kind: safe(session.kind),
    polls: 0, bytesRead: 0, replacements: 0, truncations: 0, screenReadErrors: 0, maxPollGapMs: 0 };
  let prior, lastPoll;
  function emit(stage) {
    try { write(`keep serve: compact diagnostic ${JSON.stringify({ ...row, stage, elapsedMs: now() - started })}\n`); } catch {}
  }
  return {
    start(stat, offset) {
      prior = stat;
      Object.assign(row, { initialSize: stat.size, initialInode: stat.ino, initialOffset: offset });
      emit('watch-start');
    },
    submitted() { row.submitMs = now() - started; emit('submitted'); },
    screenError() { row.screenReadErrors++; },
    poll(stat, offset, bytes) {
      const at = now();
      row.maxPollGapMs = Math.max(row.maxPollGapMs, at - (lastPoll ?? started));
      lastPoll = at;
      row.polls++;
      row.bytesRead += bytes;
      if (prior && (prior.ino !== stat.ino || prior.dev !== stat.dev)) row.replacements++;
      if (prior && stat.size < prior.size) row.truncations++;
      Object.assign(row, { finalSize: stat.size, finalInode: stat.ino, finalOffset: offset,
        offsetPastEnd: offset > stat.size });
      prior = stat;
    },
    finish(stage) { emit(stage); },
  };
}
module.exports = { compactTrace };
