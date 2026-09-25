'use strict';

// Whether Keep can trust what it reads off Claude Code's footer (bin/claude-footer.js).
// The footer is Claude Code's UI, so a Claude Code update can change its wording
// without notice. Each dashboard build checks it against two signals that do not
// read the screen:
//   - the process table: a background shell under the pane's claude process
//     (pane.agentShells) must show in the footer as a running shell;
//   - the transcript ledger: an agent the session launched a minute or more ago and
//     has not finished must show in the footer as a running agent.
// A disagreement that lasts PERSIST_MS, or footers that stop being recognized across
// the fleet, marks the footer untrusted: status stops using it (session-status.js
// keeps RUNNING verdicts as they are) and the daemon records a failing health row.
// It is trusted again after RECOVER_MS with no disagreement.

const PERSIST_MS = 90e3;
const RECOVER_MS = 10 * 60e3;
const AGENT_MIN_AGE_MS = 60e3;
const AGENT_MAX_AGE_MS = 60 * 60e3;

function createTracker() {
  return { since: new Map(), brokenAt: 0, clearSince: 0 };
}

// An agent job the ledger is sure is still running: caught-up ledger, pending, and
// launched between a minute and an hour ago (a long-stale entry proves nothing).
function ledgerAgents(ledger, now) {
  if (!ledger || ledger.caughtUp !== true) return 0;
  return (ledger.jobs || []).filter((job) => job.kind === 'agent' && job.status === 'pending'
    && Number.isFinite(job.startedAt) && now - job.startedAt >= AGENT_MIN_AGE_MS && now - job.startedAt <= AGENT_MAX_AGE_MS).length;
}

// observations: [{ pane, footer, agentShells, agentAlive, ledger }] for live Claude panes.
function observe(tracker, observations, now = Date.now()) {
  const current = new Map();
  let seen = 0;
  let unrecognized = 0;
  for (const item of observations || []) {
    if (!item || !item.footer || item.agentAlive === false) continue;
    seen += 1;
    // One pane without an input box is usually a dialog (a permission, a question);
    // only the whole fleet losing it says the format moved.
    if (!item.footer.recognized) { unrecognized += 1; continue; }
    if (item.footer.turnRunning) continue;
    if (Number.isInteger(item.agentShells) && item.agentShells > 0 && item.footer.shells === 0) {
      current.set(`${item.pane}:shell`, `pane ${item.pane}: ${item.agentShells} background shell process(es), the footer shows none`);
    }
    const agents = ledgerAgents(item.ledger, now);
    if (agents > 0 && item.footer.agents === 0) {
      current.set(`${item.pane}:agent`, `pane ${item.pane}: the ledger has ${agents} running agent(s), the footer shows none`);
    }
  }
  if (seen >= 3 && unrecognized * 2 >= seen) {
    current.set('fleet:unrecognized', `${unrecognized} of ${seen} Claude panes show no recognizable footer`);
  }
  for (const key of [...tracker.since.keys()]) if (!current.has(key)) tracker.since.delete(key);
  for (const key of current.keys()) if (!tracker.since.has(key)) tracker.since.set(key, now);
  const problems = [...current].filter(([key]) => now - tracker.since.get(key) >= PERSIST_MS).map(([, detail]) => detail);
  if (problems.length) {
    tracker.brokenAt ||= now;
    tracker.clearSince = 0;
  } else if (tracker.brokenAt) {
    tracker.clearSince ||= now;
    if (now - tracker.clearSince >= RECOVER_MS) { tracker.brokenAt = 0; tracker.clearSince = 0; }
  }
  return { trusted: !tracker.brokenAt, problems, observed: seen, since: tracker.brokenAt || null };
}

// The daemon records the health row only when trust changes, so a steady state
// writes nothing. Answers the row it wrote, or null.
function record(status, health, memo) {
  if (!status || !health) return null;
  const key = status.trusted ? 'ok' : 'broken';
  if (status.problems.length) memo.problems = status.problems;
  // Nothing is written for a steady state, nor for the first healthy build.
  if (memo.last === key || (key === 'ok' && memo.last == null)) { memo.last = key; return null; }
  memo.last = key;
  return health.record('claude-footer', status.trusted ? { ok: true }
    : { ok: false, error: `Claude Code's footer disagrees with the process table or ledger; Keep stopped using it for status. ${(memo.problems || []).join('; ')}`.slice(0, 1000) });
}

module.exports = { PERSIST_MS, RECOVER_MS, createTracker, observe, record, ledgerAgents };
