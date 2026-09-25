'use strict';

// Whether Keep can trust what it reads off Claude Code's footer (bin/claude-footer.js).
// The footer is Claude Code's UI, so a Claude Code update can change its wording
// without notice. Each full dashboard build checks it against two signals that do
// not read the screen:
//   - the process table: a background shell under the pane's claude process
//     (pane.agentShells) must show in the footer as a running shell;
//   - the transcript ledger: an agent the session launched a minute or more ago and
//     has not finished must show in the footer as a running agent.
// A shell disagreement that lasts PERSIST_MS, agent disagreements on two or more
// panes, or footers unrecognized across the fleet mark the footer untrusted: status
// stops using it (session-status.js keeps RUNNING verdicts as they are) and the
// daemon records a failing health row. It is trusted again after RECOVER_MS with no
// disagreement. An agent disagreement on one pane distrusts only that pane: one
// stale ledger entry is not a format change. A fresh tracker (a new worker) trusts
// nothing until it has watched for PERSIST_MS.

const PERSIST_MS = 90e3;
const RECOVER_MS = 10 * 60e3;
const AGENT_MIN_AGE_MS = 60e3;
const AGENT_MAX_AGE_MS = 60 * 60e3;

const AGENT_WINDOW_MS = 60 * 60e3;

function createTracker() {
  return { since: new Map(), agentPanes: new Map(), firstAt: 0, brokenAt: 0, clearSince: 0, last: null };
}

// An agent job the ledger is sure is still running: caught-up ledger, pending, and
// launched between a minute and an hour ago (a long-stale entry proves nothing).
function ledgerAgents(ledger, now) {
  if (!ledger || ledger.caughtUp !== true) return 0;
  return (ledger.jobs || []).filter((job) => job.kind === 'agent' && job.status === 'pending'
    && Number.isFinite(job.startedAt) && now - job.startedAt >= AGENT_MIN_AGE_MS && now - job.startedAt <= AGENT_MAX_AGE_MS).length;
}

function verdict(tracker, now, problems = [], untrustedPanes = []) {
  const warmedUp = tracker.firstAt && now - tracker.firstAt >= PERSIST_MS;
  return { trusted: Boolean(warmedUp) && !tracker.brokenAt, problems, untrustedPanes, since: tracker.brokenAt || null };
}

// The last verdict without observing: for a build that does not see the whole fleet.
function peek(tracker, now = Date.now()) {
  return tracker.last ? { ...tracker.last, trusted: tracker.last.trusted && Boolean(tracker.firstAt) } : verdict(tracker, now);
}

// observations: [{ pane, footer, agentShells, agentAlive, ledger, endedTurn }] for
// live Claude panes, from a build over the whole pane list.
function observe(tracker, observations, now = Date.now()) {
  tracker.firstAt ||= now;
  const current = new Map();
  let seen = 0;
  let unrecognized = 0;
  for (const item of observations || []) {
    if (!item || !item.footer || item.agentAlive === false) continue;
    seen += 1;
    // One pane without an input box is usually a dialog (a permission, a question);
    // only the whole fleet losing it says the format moved.
    if (!item.footer.recognized) { unrecognized += 1; continue; }
    // Mid-turn, by either the screen or the transcript: a foreground tool is running.
    if (item.footer.turnRunning || item.endedTurn === false) continue;
    if (Number.isInteger(item.agentShells) && item.agentShells > 0 && item.footer.shells === 0) {
      current.set(`${item.pane}:shell`, { pane: item.pane, fleet: true,
        detail: `pane ${item.pane}: ${item.agentShells} background shell process(es), the footer shows none` });
    }
    const agents = ledgerAgents(item.ledger, now);
    if (agents > 0 && item.footer.agents === 0) {
      current.set(`${item.pane}:agent`, { pane: item.pane, agent: true,
        detail: `pane ${item.pane}: the ledger has ${agents} running agent(s), the footer shows none` });
    }
  }
  if (seen >= 3 && unrecognized * 2 >= seen) {
    current.set('fleet:unrecognized', { fleet: true, detail: `${unrecognized} of ${seen} Claude panes show no recognizable footer` });
  }
  for (const key of [...tracker.since.keys()]) if (!current.has(key)) tracker.since.delete(key);
  for (const key of current.keys()) if (!tracker.since.has(key)) tracker.since.set(key, now);
  const persisted = [...current].filter(([key]) => now - tracker.since.get(key) >= PERSIST_MS).map(([, problem]) => problem);
  // Agent disagreements from two different panes within an hour, not necessarily at
  // once, say the agent wording moved; one pane's stale ledger entry does not.
  for (const problem of persisted.filter((item) => item.agent)) tracker.agentPanes.set(problem.pane, { at: now, detail: problem.detail });
  for (const [pane, entry] of [...tracker.agentPanes]) if (now - entry.at > AGENT_WINDOW_MS) tracker.agentPanes.delete(pane);
  const agentProblems = tracker.agentPanes.size >= 2 ? [...tracker.agentPanes.values()].map((entry) => ({ detail: entry.detail })) : [];
  const fleetProblems = [...persisted.filter((problem) => problem.fleet), ...agentProblems];
  if (fleetProblems.length) {
    tracker.brokenAt ||= now;
    tracker.clearSince = 0;
  } else if (tracker.brokenAt) {
    tracker.clearSince ||= now;
    if (now - tracker.clearSince >= RECOVER_MS) { tracker.brokenAt = 0; tracker.clearSince = 0; }
  }
  const untrustedPanes = persisted.filter((problem) => problem.pane).map((problem) => problem.pane);
  tracker.last = verdict(tracker, now, fleetProblems.map((problem) => problem.detail), [...new Set(untrustedPanes)]);
  return tracker.last;
}

// The daemon writes the health row when trust changes, and once at its first result
// so a failing row from before a restart does not outlive a healthy footer.
function record(status, health, memo) {
  if (!status || !health) return null;
  const key = status.trusted ? 'ok' : status.since ? 'broken' : 'warming';
  if (status.problems.length) memo.problems = status.problems;
  if (key === 'warming' || memo.last === key) return null;
  memo.last = key;
  return health.record('claude-footer', status.trusted ? { ok: true }
    : { ok: false, error: `Claude Code's footer disagrees with the process table or ledger; Keep stopped using it for status. ${(memo.problems || []).join('; ')}`.slice(0, 1000) });
}

module.exports = { PERSIST_MS, RECOVER_MS, createTracker, observe, peek, record, ledgerAgents };
