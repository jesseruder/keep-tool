'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
// Separate from pending journals: bounded diagnostics, never message/screen text.
function recorder(directory, session, pane) {
  const attempt = crypto.randomUUID();
  const safe = v => /^[a-zA-Z0-9_-]{1,160}$/.test(String(v || '')) ? String(v) : null;
  return (stage, fields = {}) => {
    try {
      const dir = path.join(directory, 'diagnostics');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, 'events.jsonl');
      try { if (fs.statSync(file).size >= 1024 * 1024) fs.renameSync(file, file + '.1'); } catch (e) { if (e.code !== 'ENOENT') return; }
      const row = { at: Date.now(), attempt, session: safe(session.id), kind: safe(session.kind), pane: safe(pane), stage: safe(stage) };
      for (const k of ['matched', 'sameMessage', 'samePane', 'idle', 'question', 'plan', 'cursorInPrompt']) if (typeof fields[k] === 'boolean') row[k] = fields[k];
      fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
    } catch {} // Diagnostic failure must not affect input delivery.
  };
}
module.exports = { recorder };
