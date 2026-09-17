'use strict';
// Which account a fresh `keep open` launches on.
//
// The registry default used to decide this by itself, which put new sessions on an
// account with nothing left the moment that default ran out of week: the session
// launched, answered its opening message with a limit notice, and then sat there
// costing a pane. A fresh open with no `--account` now walks an ordered list — the
// caller's own account, then the registry default, then the rest — and takes the
// first one that still has room.
//
// The verdict ladder is classifyBudget's (bin/review.js): 0 within budget, 6 weekly
// exhausted, 7 five-hour window low, 8 unknown. It is re-stated here rather than
// called because that one is the reviewer's spend gate: it reads the wall clock, and
// it fails closed when a configured per-model bucket is missing. A chooser must do
// neither — an account nobody has a reading for still has to be launchable, and
// `now` has to be a parameter for the order to be testable.

const review = require('./review.js');
const preferences = require('./preferences.js');

// The same headroom floor and staleness window the reviewer's gate uses.
const MIN_HEADROOM = parseInt(process.env.KEEP_REVIEW_MIN_HEADROOM || '10', 10);
const USAGE_STALE_MS = 30 * 60e3;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Claude limits carry an ISO string, Codex ones epoch milliseconds; a reset nobody
// can parse simply goes unmentioned rather than printing "Invalid Date".
function describeReset(resetsAt) {
  const at = typeof resetsAt === 'number' ? resetsAt : Date.parse(String(resetsAt || ''));
  if (!Number.isFinite(at)) return '';
  const when = new Date(at);
  const clock = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  return `, resets ${MONTHS[when.getMonth()]} ${when.getDate()} ${clock}`;
}

// One account's verdict, from the buckets classifyBudget reads. `model` names the
// per-model weekly bucket when the launch names a model; without one only the generic
// `week` and `5h` windows apply, because a launch that names no model does not yet
// know which per-model window it will spend against.
function accountBudget(snapshot, account, model, now) {
  const id = account && account.id;
  const claude = review.accountLimits(snapshot, id);
  if (!claude || !Array.isArray(claude.limits) || !claude.limits.length) {
    return { code: 8, reason: `no usage reading for ${id}` };
  }
  if (!claude.fetchedAt || now - claude.fetchedAt > USAGE_STALE_MS) {
    return { code: 8, reason: `usage reading for ${id} is stale` };
  }
  const limits = claude.limits;
  // A non-numeric percent makes every headroom comparison false, which would read as
  // "plenty left". Unknown is the honest answer, and unknown is still launchable.
  if (limits.some((limit) => !Number.isFinite(Number(limit && limit.percent)))) {
    return { code: 8, reason: `usage reading for ${id} has an unreadable percent` };
  }
  const family = review.modelFamily(model);
  const budget = preferences.modelBudgets()[family] || {};
  const min = budget.minHeadroom ?? MIN_HEADROOM;
  const headroom = (limit) => 100 - Number(limit.percent);
  // `low` is under the headroom floor but not yet at the wall: worth passing over for a
  // better account, still better than refusing to launch at all.
  const spent = (code, limit) => ({ code, reason: `${limit.label} ${limit.percent}%`, resetsAt: limit.resetsAt, low: Number(limit.percent) < 100 });
  const name = String(model || '').toLowerCase();
  const scoped = name ? limits.find((limit) => {
    const label = String(limit.label || '').toLowerCase();
    return budget.weeklyLabel ? label === budget.weeklyLabel.toLowerCase()
      : label.endsWith(' wk') && label.startsWith(family === 'other' ? name : family);
  }) : null;
  if (scoped && headroom(scoped) < min) return spent(6, scoped);
  const week = limits.find((limit) => limit.label === 'week');
  // No weekly bucket at all means the schema moved under us; reading that as room
  // would launch against a window nobody can see.
  if (!week) return { code: 8, reason: `usage reading for ${id} has no weekly bucket` };
  if (headroom(week) < min) return spent(6, week);
  const short = limits.find((limit) => limit.label === '5h');
  if (short && headroom(short) < min) return spent(7, short);
  return { code: 0, reason: 'within budget' };
}

// Registered accounts for `agent`, in the order a fresh open should try them: the
// caller's own first (a session that is itself running is the best evidence its
// account has room), then the registry default, then the rest in registry order.
// A `callerAccountId` belonging to the other provider is ignored — an account id
// means nothing across agents, and following one would launch Codex on whatever
// Claude account happened to share its name.
function orderOpenCandidates(agent, { accounts = [], defaultAccountId, callerAccountId } = {}) {
  const registered = accounts.filter((account) => account && account.agent === agent);
  const ordered = [];
  const add = (id) => {
    const account = registered.find((entry) => entry.id === id);
    if (account && !ordered.includes(account)) ordered.push(account);
  };
  add(callerAccountId);
  add(defaultAccountId);
  for (const account of registered) if (!ordered.includes(account)) ordered.push(account);
  return ordered;
}

// The first candidate with room. 6 and 7 are out of usage and skipped; 8 is merely
// unreadable, which is no reason to refuse a launch — but an account we can see is
// fine beats one we cannot read, wherever it sits in the order. When nothing is fine or
// unreadable, an account that is only under the headroom floor still launches; the
// refusal is for when every account is at the wall.
function chooseOpenAccount(agent, candidates, snapshot, model, now) {
  const skipped = [];
  let unknown = null;
  let low = null;
  for (const account of candidates || []) {
    const verdict = accountBudget(snapshot, account, model, now);
    if (verdict.code === 6 || verdict.code === 7) {
      skipped.push({ id: account.id, reason: verdict.reason, resetsAt: verdict.resetsAt || null });
      if (verdict.low) low = low || { account, reason: verdict.reason };
      continue;
    }
    if (verdict.code === 0) return { account, reason: verdict.reason, skipped };
    unknown = unknown || { account, reason: verdict.reason };
  }
  const fallback = unknown || low;
  if (fallback) {
    return { account: fallback.account, reason: fallback.reason, skipped: skipped.filter((entry) => entry.id !== fallback.account.id) };
  }
  return { account: null, reason: `every ${agent} account is out of usage`, skipped };
}

// What the CLI prints under the result line when the chooser had to pass over an
// account. Empty when it did not: the ordinary open says nothing extra.
function accountNote(choice) {
  if (!choice || !choice.account || !choice.skipped.length) return '';
  const passed = choice.skipped.map((entry) => `${entry.id} skipped: ${entry.reason}${describeReset(entry.resetsAt)}`);
  return `${passed.join('; ')}; opened on ${choice.account.id}`;
}

function noAccountMessage(agent, skipped) {
  const listed = (skipped || []).map((entry) => `${entry.id} (${entry.reason}${describeReset(entry.resetsAt)})`);
  return `no ${agent} account has usage left: ${listed.join('; ')}; pass --account <id> to launch anyway`;
}

// An explicit --account is honoured even when it is spent — Owner may be waiting for
// the reset on purpose — but the launch says so, because the alternative is a silent
// session that can do nothing.
function exhaustedWarning(account, snapshot, model, now) {
  const verdict = accountBudget(snapshot, account, model, now);
  if (verdict.code !== 6 && verdict.code !== 7) return '';
  return `${account.id} is ${verdict.low ? 'low on' : 'out of'} usage (${verdict.reason}${describeReset(verdict.resetsAt)})`;
}

module.exports = {
  MIN_HEADROOM, USAGE_STALE_MS,
  describeReset, accountBudget, orderOpenCandidates, chooseOpenAccount,
  accountNote, noAccountMessage, exhaustedWarning,
};
