'use strict';

// /new and /resume change conversation identity without replacing the TUI.
// Only its open rollout and process ancestry can authorize replacing a binding.
async function ownsPane(sessionId, pane, deps = {}) {
  if (!pane?.alive || !Number.isInteger(pane.pid)) return false;
  const codex = require('./codex');
  const meta = (deps.sessionMetaFor || codex.sessionMetaFor)(sessionId);
  if (!meta || (meta.id || meta.session_id) !== sessionId
      || codex.isChildSession(meta)) return false;
  const serve = require('./serve');
  const rows = await (deps.agentProcessRows || serve.agentProcessRows)();
  const live = await (deps.liveSessionPids || serve.liveSessionPids)({ agentProcessRows: async () => rows, codexRolloutOnly: true });
  const identity = live.get(sessionId);
  if (identity?.agent !== 'codex' || identity.source !== 'rollout' || !identity.primary) return false;
  const byPid = new Map(rows.map(row => [row.pid, row]));
  let row = byPid.get(identity.pid);
  const seen = new Set();
  while (row && !seen.has(row.pid)) {
    if (row.pid === pane.pid) return true;
    seen.add(row.pid);
    row = byPid.get(row.ppid);
    // A nested agent inherits KEEP_PANE, but does not own the outer TUI.
    if (row && /(?:^|\/)(?:codex|claude)$/.test(String(row.args || '').split(/\s+/)[0])) return false;
  }
  return false;
}

module.exports = { ownsPane };
