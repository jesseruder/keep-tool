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
function resetTime(resetsAt) {
  try { return typeof resetsAt === 'number' ? resetsAt : Date.parse(String(resetsAt || '')); }
  catch { return NaN; }
}

function describeReset(resetsAt) {
  const at = resetTime(resetsAt);
  if (!Number.isFinite(at)) return '';
  const when = new Date(at);
  const clock = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  return `, resets ${MONTHS[when.getMonth()]} ${when.getDate()} ${clock}`;
}

// The buckets one account's reading offers, for either provider, or null when there is
// nothing usable to read. Claude's come from the poller as `{limits, fetchedAt}`;
// Codex's are the `{windows, asOf}` its own rollout writes (bin/usage.js codexWindow),
// already carrying the same `{label, percent, resetsAt}` shape and the same `week` and
// `5h` labels. Only the age is judged differently: Claude's is polled, so half an hour
// old means the poller is broken, while Codex's only advances when a Codex session
// takes a turn, so the same age means nobody has used Codex — not that the reading is
// wrong. A reading nobody can parse is unknown, which still launches.
const CODEX_STALE_MS = 6 * 3600e3;

function accountLimits(snapshot, account) {
  const agent = account && account.agent;
  if (agent === 'codex') {
    const entry = snapshot && snapshot.accounts && snapshot.accounts[account.id];
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.windows)) return null;
    return { limits: entry.windows, fetchedAt: entry.asOf, staleMs: CODEX_STALE_MS };
  }
  const claude = review.accountLimits(snapshot, account && account.id);
  return claude ? { ...claude, staleMs: USAGE_STALE_MS } : null;
}

// One account's verdict. `model` is the model this launch will actually run on, which
// the caller has already resolved: an explicit `--model`, or the launching account's own
// default (bin/serve.js openSession). Without one only the generic `week` and `5h`
// windows apply. Every applicable bucket is judged and the worst one decides: a week at
// 94% must not hide a five-hour window at 100%.
function accountBudget(snapshot, account, model, now) {
  const id = account && account.id;
  const reading = accountLimits(snapshot, account);
  if (!reading || !Array.isArray(reading.limits) || !reading.limits.length) {
    return { code: 8, reason: `no usage reading for ${id}` };
  }
  const limits = reading.limits;
  // A bucket that is not an object, or whose percent is not a number, makes every
  // headroom comparison false — which would read as "plenty left" — and reaches for
  // `.label` on whatever it is. Unknown is the honest answer, and unknown still
  // launches. Judged before the age, because a reading nobody can parse says nothing
  // whether it is minutes or hours old.
  if (limits.some((limit) => !limit || typeof limit !== 'object'
    || !Number.isFinite(Number(limit.percent)))) {
    return { code: 8, reason: `usage reading for ${id} is unreadable` };
  }
  const fetchedAt = Number(reading.fetchedAt);
  const stale = !Number.isFinite(fetchedAt) || !fetchedAt || now - fetchedAt > reading.staleMs;
  const family = review.modelFamily(model);
  const budget = preferences.modelBudgets()[family] || {};
  const min = budget.minHeadroom ?? MIN_HEADROOM;
  const headroom = (limit) => 100 - Number(limit.percent);
  const name = String(model || '').toLowerCase();
  const scoped = name ? limits.find((limit) => {
    const label = String(limit.label || '').toLowerCase();
    return budget.weeklyLabel ? label === budget.weeklyLabel.toLowerCase()
      : label.endsWith(' wk') && label.startsWith(family === 'other' ? name : family);
  }) : null;
  const week = limits.find((limit) => limit.label === 'week');
  // No weekly bucket at all means the schema moved under us; reading that as room
  // would launch against a window nobody can see.
  if (!week) return { code: 8, reason: `usage reading for ${id} has no weekly bucket` };
  const short = limits.find((limit) => limit.label === '5h');
  // 6 for a weekly window (scoped or shared), 7 for the short one, as classifyBudget
  // numbers them. Ordered so an exact headroom tie keeps the weekly reading, which is
  // the one that takes days rather than hours to come back.
  const applicable = [
    ...(scoped ? [{ limit: scoped, code: 6 }] : []),
    { limit: week, code: 6 },
    ...(short ? [{ limit: short, code: 7 }] : []),
  ];
  // A bucket whose recorded reset has already passed describes a window that no longer
  // exists. A Codex reading only advances when a Codex session takes a turn, so a spent
  // window can sit in the snapshot for hours after it reopened; believing it would
  // refuse an account that is fine. It is unknown, not exhausted and not room.
  const expired = (entry) => { const at = resetTime(entry.limit.resetsAt); return Number.isFinite(at) && at <= now; };
  const worstOf = (entries) => entries.reduce((a, b) => (headroom(b.limit) < headroom(a.limit) ? b : a));
  // Usage only rises until a bucket resets, so a bucket that read at or past 100% and
  // whose reset is still ahead of us is spent right now however old the reading is: the
  // poller being broken cannot have given the account room back. Nothing else survives
  // staleness — a stale reading never proves room, and a spent bucket whose reset has
  // passed describes a window that no longer exists.
  if (stale) {
    const walls = applicable.filter((entry) => {
      const at = resetTime(entry.limit.resetsAt);
      return Number(entry.limit.percent) >= 100 && Number.isFinite(at) && at > now;
    });
    if (!walls.length) return { code: 8, reason: `usage reading for ${id} is stale` };
    const worst = worstOf(walls);
    return { code: worst.code, reason: `${worst.limit.label} ${worst.limit.percent}%`,
      resetsAt: worst.limit.resetsAt, low: false };
  }
  const offending = applicable.filter((entry) => headroom(entry.limit) < min && !expired(entry));
  if (!offending.length) {
    return applicable.some(expired)
      ? { code: 8, reason: `usage reading for ${id} predates a reset` }
      : { code: 0, reason: 'within budget' };
  }
  const worst = worstOf(offending);
  // `low` is under the headroom floor but not yet at the wall: worth passing over for a
  // better account, still better than refusing to launch at all. A bucket at or past
  // 100% is the wall, whatever the other buckets say.
  return {
    code: worst.code,
    reason: `${worst.limit.label} ${worst.limit.percent}%`,
    resetsAt: worst.limit.resetsAt,
    low: Number(worst.limit.percent) < 100,
  };
}

// The model one candidate's launch would run on. An explicit `--model` is a single
// string that applies to every candidate; with no `--model` each account has its own
// default and the daemon passes a resolver instead, because judging `claude/default` on
// the generic buckets said "fine" while a session launched there ran on Fable, whose own
// weekly bucket was at 100%, and could not take a turn. A resolver that throws or
// answers with anything but a string leaves the generic buckets in charge — exactly
// what a launch naming no model did before.
function modelForAccount(model, account) {
  if (typeof model !== 'function') return model;
  try {
    const resolved = model(account);
    return typeof resolved === 'string' ? resolved : '';
  } catch { return ''; }
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
// refusal is for when every account is at the wall. `model` is a model string or a
// per-account resolver (modelForAccount).
function chooseOpenAccount(agent, candidates, snapshot, model, now) {
  const skipped = [];
  let unknown = null;
  let low = null;
  for (const account of candidates || []) {
    const verdict = accountBudget(snapshot, account, modelForAccount(model, account), now);
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
  const verdict = accountBudget(snapshot, account, modelForAccount(model, account), now);
  if (verdict.code !== 6 && verdict.code !== 7) return '';
  return `${account.id} is ${verdict.low ? 'low on' : 'out of'} usage (${verdict.reason}${describeReset(verdict.resetsAt)})`;
}

module.exports = {
  MIN_HEADROOM, USAGE_STALE_MS, CODEX_STALE_MS,
  describeReset, accountLimits, accountBudget, modelForAccount, orderOpenCandidates, chooseOpenAccount,
  accountNote, noAccountMessage, exhaustedWarning,
};
