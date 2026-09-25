'use strict';
// keep runs — the scheduler for cards that carry a `check` recipe or a `probe`.
// Lives inside the serve process.
//
// Nothing here runs a model headless. A due check goes to the card's linked thread
// if one is open, and otherwise opens a fresh interactive session on the card; a
// probe is a shell command whose exit code decides the card with no model at all.
// The durable record is always the check-in. Delivery stamps and pending check-ins
// live in .keep/runs/ (gitignored, ephemeral).

const fs = require('fs');
const path = require('path');
const { ref: sessionRef } = require('./session-numbers.js');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const keep = require('./keep.js');
const health = require('./health.js');
const checkDeferrals = require('./check-deferrals.js');

const RUNS_DIR = path.join(keep.ROOT, '.keep', 'runs');
// Poll more often without shortening the default ~two-hour busy-thread grace.
const parsedMaxDeferrals = parseInt(process.env.KEEP_DELIVER_MAX_DEFERRALS || '120', 10);
const MAX_DELIVER_DEFERRALS = Number.isFinite(parsedMaxDeferrals) && parsedMaxDeferrals >= 0
  ? parsedMaxDeferrals
  : 120;
let onChange = () => {};
// Injected by serve.js: typing a due check into a card's linked thread, and opening
// a fresh session on the card when there is none. runs.js cannot require serve.js
// (serve requires runs), and the whole terminal/host/account stack lives there.
// Self-repair takes openSession through deps the same way.
let deliverToThread = async () => null;
const NO_OPENER = () => { throw new keep.KeepError('no openSession was wired into the runs scheduler'); };
let openSession = async () => NO_OPENER();
// { listPanes, sessions, closePane } — the ephemeral-pane sweep's view of the host.
let ephemeralHost = null;

function setOnChange(fn) { onChange = fn; }
function setDeliverer(fn) { deliverToThread = typeof fn === 'function' ? fn : async () => null; }
function setOpener(fn) { openSession = typeof fn === 'function' ? fn : async () => NO_OPENER(); }
function setEphemeralHost(host) { ephemeralHost = host && typeof host === 'object' ? host : null; }

function expandProject(p) {
  return p ? p.replace(/^~(?=\/|$)/, os.homedir()) : '';
}

// What a passing check does to this card, as the card declares it. Absent means the
// legacy behaviour every card written before `check_on_pass` existed relies on: a pass
// still goes to Owner. A rearm whose interval is missing or unparsable degrades to
// review rather than silently dropping the card off the schedule forever.
function onPassOutcome(task) {
  const fm = (task && task.fm) || {};
  const onPass = fm.check_on_pass || 'review';
  if (onPass === 'done') return { status: 'done', clearCheckAfter: true, why: 'closed as declared by on-pass: done' };
  if (onPass === 'rearm') {
    const every = fm.check_every;
    if (every && keep.relativeDurationMs(every) != null) {
      return { status: 'waiting', checkAfter: every, clearCheckAfter: false, why: `re-armed every ${every}` };
    }
    return {
      status: 'review',
      clearCheckAfter: true,
      why: `on-pass is rearm but check_every ${every ? `"${every}" is not an interval like +7d` : 'is missing'}, so this went to Owner review`,
    };
  }
  return { status: 'review', clearCheckAfter: true, why: null };
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function clip(s, n) {
  s = String(s ?? '').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// `updated` is minute-resolution, so it cannot tell whether a check-in happened
// while a short run was active. Hash the full durable card instead: a check-in that
// reaffirms the same status and schedule still appends to the body and is therefore
// visible here.
function cardFingerprint(task) {
  if (!task || !task.fm) return '';
  return crypto.createHash('sha256').update(JSON.stringify({
    fm: task.fm,
    body: String(task.body || ''),
  })).digest('hex');
}

function pendingCheckin(payload, taskNow) {
  const { taskId, _retryCardFingerprint, ...checkin } = payload;
  const stale = Boolean(_retryCardFingerprint && taskNow
    && cardFingerprint(taskNow) !== _retryCardFingerprint);
  if (stale && ('status' in checkin || 'clearCheckAfter' in checkin || 'checkAfter' in checkin)) {
    delete checkin.status;
    delete checkin.clearCheckAfter;
    delete checkin.checkAfter;
    checkin.message = `${checkin.message}\n\n(card changed after this result was queued; current status and check schedule preserved)`;
  }
  return { taskId, checkin, stale };
}

// Reasons an open may simply have room on a later tick: another open is already in
// flight for this selection, or the terminal host has not answered yet (a restart, a
// host still booting). Neither may burn the card's one scheduler-opened session per
// day. Matching only "runs active" locked a card out until tomorrow on the per-task race.
function isTransientStartError(e) {
  return /already .*(active|launching)|terminal host is unavailable|did not return a pane/i
    .test(String((e && e.message) || e));
}

function retryPending() {
  const errors = [];
  if (!fs.existsSync(RUNS_DIR)) return errors;
  const files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.pending.json')).sort();
  for (const file of files) {
    const pendingFile = path.join(RUNS_DIR, file);
    try {
      const payload = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
      let taskId;
      // Compare and mutate under the same registry lock so a newer card action
      // cannot land between the stale check and this retry.
      keep.withLock(() => {
        const taskNow = payload._retryCardFingerprint ? keep.loadTask(payload.taskId) : null;
        const prepared = pendingCheckin(payload, taskNow);
        taskId = prepared.taskId;
        keep.checkinTask(taskId, { ...prepared.checkin, withinLock: true });
      });
      fs.unlinkSync(pendingFile);
      process.stderr.write(`keep runs: landed pending check-in for ${taskId}\n`);
    } catch (e) {
      errors.push(e);
      process.stderr.write(`keep runs: pending check-in ${file} still failed: ${e.message}\n`);
    }
  }
  return errors;
}

// One sentence naming what the deterministic probe already saw, so an escalated check
// starts from the failure instead of rediscovering it. The tail is other programs'
// output, clipped hard so it cannot crowd out the recipe.
function probeFailureSentence(probe) {
  if (!probe) return '';
  const tail = clip(String(probe.output || '').trim() || '(no output)', 300);
  return `The deterministic probe just failed (exit ${probe.code}${probe.timedOut ? ', timed out' : ''}, tail: ${tail}).`;
}

// The text a due check is delivered as — into the linked thread when one is open, and
// into the fresh session Keep opens on the card when one is not. Both recipients get
// the same instruction, so the card records the same kind of outcome either way.
function checkDeliveryMessage(task, opts = {}) {
  const fm = task && task.fm || {};
  const recipe = String(fm.check || '').replace(/\s+/g, ' ').trim();
  const probeSentence = probeFailureSentence(opts && opts.probe);
  const rearm = fm.check_on_pass === 'rearm';
  // Validated with the same parser onPassOutcome uses, so the message never tells a
  // session to pass `--check-after next tuesday` to a flag that cannot read it. The
  // whole field is clipped too: `check_every` is card text like any other.
  const every = clip(String(fm.check_every || '').replace(/\s+/g, ' '), 40);
  const rearmEvery = every && keep.relativeDurationMs(every) != null ? every : '';
  // Reserve room for handoff guidance and the full card ID — and for the on-pass and
  // probe sentences, so a long recipe cannot push `Full card:` past the 2000-char cap.
  const recipeLimit = Math.max(200, 900
    - (fm.check_on_pass === 'done' ? 120 : 0)
    - (rearm ? 200 : 0)
    - (probeSentence ? probeSentence.length + 1 : 0));
  const clipped = recipe.length > recipeLimit;
  const shownRecipe = clipped ? `${recipe.slice(0, recipeLimit - 1)}…` : recipe;
  const title = String(fm.title || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const scheduledFor = clip(String(fm.check_after || '').replace(/\s+/g, ' '), 40) || '(unspecified)';
  const message = [
    probeSentence,
    `[keep] scheduled check due for ${task.id} ("${title}"), scheduled for ${scheduledFor}.`,
    `This is the reminder you scheduled; run the recipe now in this session: ${shownRecipe}`,
    clipped ? '(recipe truncated; full text on the card)' : '',
    `Do only the read-only check; report any required changes rather than performing them.`,
    `Then record the outcome with keep checkin ${task.id} -m "<findings and next step>" plus --clear-check-after (or --check-after <when> to reschedule) and the true status. Rescheduling yields this turn; add --handoff needs-input if Jesse must decide.`,
    // `review` is what a thread already does, so only the other two need wording. A
    // rearm card reaches a session now that scheduled checks open one, and nobody but
    // that session can re-arm the interval by hand.
    fm.check_on_pass === 'done'
      ? 'This card declares on-pass: done — if every gate holds, check in with --status done --clear-check-after.'
      : '',
    rearm
      ? (rearmEvery
        ? `This card re-arms: if every gate holds, check in with --check-after ${rearmEvery} and the status unchanged; if not, record the failure and the status it deserves.`
        : 'This card re-arms, but its check_every is unreadable: if every gate holds, re-arm with --check-after <a valid interval like +7d> and the status unchanged; if not, record the failure and the status it deserves.')
      : '',
    `Full card: keep show ${task.id}.`,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return message.slice(0, 2000);
}

function checkDeliveryKey(task) { return `${task.id}:${task.fm?.check_after || ''}`; }

function planDueCard(task, state) {
  if (state && state.stamp && state.stamp.checkAfter === task.fm.check_after) return 'skip-delivered';
  const count = typeof (state && state.deferrals) === 'number'
    ? state.deferrals
    : Number(state && state.deferrals && state.deferrals.count);
  const max = Number(state && state.maxDeferrals);
  if (Number.isFinite(count) && Number.isFinite(max) && count > max) return 'open-after-deferrals';
  return 'deliver';
}

function deliveryWarning(task, delivery) {
  if (!delivery || delivery.truncated !== true) return null;
  return {
    heading: 'delivery warning',
    message: `The scheduled check was typed into ${delivery.kind} session ${sessionRef(delivery.sessionId)} but arrived truncated (${delivery.received}/${delivery.expected} chars); the full recipe is on this card (keep show ${task.id}).`,
    linkSession: false,
    commitLabel: 'check',
  };
}

function deliveryStampFile(taskId) {
  return path.join(RUNS_DIR, `${taskId}.delivered.json`);
}

// A thread delivery is answered by a session Owner can see and talk to, so its stamp
// stands until the schedule moves. A session Keep opened by itself has nobody watching
// it: if it dies before checking in, the stamp would suppress the card's check forever.
// So a fresh-open stamp carries a TTL, after which the card simply comes due again.
const FRESH_OPEN_STAMP_TTL_MS = 2 * 3600e3;

function stampExpired(stamp, now = Date.now()) {
  const ttl = Number(stamp && stamp.ttlMs);
  if (!Number.isFinite(ttl) || ttl <= 0) return false;
  const at = stampMs(stamp.at);
  // A stamp whose own timestamp is unreadable has no measurable life left; treat it as
  // expired rather than as immortal.
  return !at || now - at >= ttl;
}

function readRawDeliveryStamp(taskId) {
  try { return JSON.parse(fs.readFileSync(deliveryStampFile(taskId), 'utf8')); } catch { return null; }
}

function removeDeliveryStamp(taskId) {
  const file = deliveryStampFile(taskId);
  if (!fs.existsSync(file)) return true;
  try { fs.unlinkSync(file); return true; }
  catch (e) {
    process.stderr.write(`keep runs: could not remove the delivery stamp for ${taskId}: ${e.message}\n`);
    return false;
  }
}

function readDeliveryStamp(task, now = Date.now()) {
  const file = deliveryStampFile(task.id);
  let stamp = null;
  try { stamp = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const live = stamp && !stampExpired(stamp, now)
    && (stamp.checkAfter === task.fm.check_after || (stamp.truncated && !stamp.warningLanded));
  if (live) return stamp;
  if (stamp && stampExpired(stamp, now)) {
    process.stderr.write(`keep runs: the check session stamp for ${task.id} expired without a result; the card is due again\n`);
  }
  removeDeliveryStamp(task.id);
  return null;
}

function writeDeliveryStamp(task, delivery) {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const file = deliveryStampFile(task.id);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const stamp = {
    taskId: task.id,
    sessionId: delivery.sessionId,
    kind: delivery.kind,
    checkAfter: delivery.checkAfter !== undefined ? delivery.checkAfter : task.fm.check_after,
    at: keep.nowStamp(),
    ...(Number(delivery.ttlMs) > 0 ? { ttlMs: Number(delivery.ttlMs) } : {}),
    ...(delivery.truncated ? {
      truncated: true,
      received: delivery.received,
      expected: delivery.expected,
      warningLanded: delivery.warningLanded === true,
    } : {}),
  };
  try {
    fs.writeFileSync(tmp, JSON.stringify(stamp, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

function landDeliveryWarning(task, delivery) {
  const warning = deliveryWarning(task, delivery);
  if (!warning) return true;
  try {
    const latest = keep.loadTask(task.id);
    if (!String(latest.body || '').includes(warning.message)) keep.checkinTask(task.id, warning);
    writeDeliveryStamp(task, { ...delivery, warningLanded: true });
    process.stderr.write(`keep runs: delivery warning landed on ${task.id}: truncated ${delivery.received}/${delivery.expected} chars\n`);
    return true;
  } catch (e) {
    process.stderr.write(`keep runs: could not land delivery warning on ${task.id}: ${e.message}\n`);
    return false;
  }
}

// ---------- opening a session for a due check ----------

// One scheduler-opened session per card per local day, and at most three per tick: a
// daemon that was down all night finds every card due at once, and three panes is
// already a lot of windows to come back to. A tick that defers many cards on budget
// logs them all but writes at most three check-ins, so a limit reset does not arrive
// as fifty commits.
const MAX_FRESH_OPENS_PER_TICK = 3;
const MAX_DEFERRAL_NOTICES_PER_TICK = 3;
// How many times a deferral escalation may be retried on a transient failure before the
// card gets its stalled record anyway.
const MAX_FALLBACK_ATTEMPTS = 3;
// The model a scheduled check runs as. Unset means the launched session takes the model
// in settings.json, and the budget is classified against the reviewer's model as a
// proxy. Set it and BOTH move together — the pane is launched with it and the budget is
// read for it, so the window Keep checks is the window Keep spends.
const CHECK_MODEL = process.env.KEEP_CHECK_MODEL || '';
const SCHEDULER_STATE_FILE = path.join(RUNS_DIR, 'scheduler-state.json');

// Per-card, per-day bookkeeping. Persisted, because it was all that stopped a card
// from being re-opened or re-noticed, and a daemon restart reset it: an afternoon of
// restarts used to mean an afternoon of duplicate panes and duplicate check-ins.
let schedulerState = null;

function dayRecord(value) {
  const out = new Map();
  if (value && typeof value === 'object') {
    for (const [id, day] of Object.entries(value)) {
      if (typeof id === 'string' && typeof day === 'string') out.set(id, day);
    }
  }
  return out;
}

function loadSchedulerState() {
  if (schedulerState) return schedulerState;
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(SCHEDULER_STATE_FILE, 'utf8')); } catch {}
  // Parsing included: this is bookkeeping read from a hand-editable file, and every
  // caller of it is inside a scheduler tick. Losing a day of it costs a duplicate pane;
  // throwing here cost the whole tick, and the next one, and the one after that.
  try {
    schedulerState = {
      opened: dayRecord(parsed && parsed.opened),
      budgetNotice: dayRecord(parsed && parsed.budgetNotice),
      reopened: dayRecord(parsed && parsed.reopened),
      deferred: checkDeferrals.parse(parsed && parsed.deferred),
      openedAt: timeRecord(parsed && parsed.openedAt),
    };
  } catch (e) {
    process.stderr.write(`keep runs: scheduler state was unreadable and has been reset: ${e.message}\n`);
    schedulerState = { opened: new Map(), budgetNotice: new Map(), reopened: new Map(), deferred: new Map(), openedAt: new Map() };
  }
  return schedulerState;
}

const DAY_MS = 24 * 3600e3;

// taskId -> ms of the last session the scheduler opened on it. Beside `opened`'s
// day: a card that re-arms more often than daily is allowed a fresh session once
// its interval has passed, which a day record cannot tell.
function timeRecord(value) {
  const map = new Map();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return map;
  for (const [id, at] of Object.entries(value)) {
    if (typeof id === 'string' && id && Number.isFinite(Number(at)) && Number(at) > 0) map.set(id, Number(at));
  }
  return map;
}

// How often a re-arming card may be opened: its `check_every`, when that is under a
// day (never less than MIN_CHECK_EVERY_MS, which cleanCheckEvery already enforces).
// Null for every other card, which keeps the one-per-day rule.
function subDailyEveryMs(task) {
  const fm = task && task.fm || {};
  if (fm.check_on_pass !== 'rearm' || !fm.check_every) return null;
  const every = keep.relativeDurationMs(String(fm.check_every));
  return Number.isFinite(every) && every > 0 && every < DAY_MS ? every : null;
}

// Written whole, atomically, and pruned to today: this file is bookkeeping, not a log,
// and a registry that has been running for a year should not carry a year of card ids.
function saveSchedulerState(today = keep.nowStamp().slice(0, 10)) {
  const state = loadSchedulerState();
  const prune = (map) => {
    for (const [id, day] of map) if (day !== today) map.delete(id);
    return Object.fromEntries(map);
  };
  const payload = {
    opened: prune(state.opened), budgetNotice: prune(state.budgetNotice), reopened: prune(state.reopened),
    // Not a day record: a deferral streak has to be able to see across midnight, so
    // this bucket prunes on its own retention rather than on today's date.
    deferred: checkDeferrals.serialize(state.deferred),
    // Nor is this one: a sub-daily interval is judged in wall time, so it keeps a
    // day's worth and drops the rest.
    openedAt: Object.fromEntries([...state.openedAt].filter(([, at]) => Date.now() - at < DAY_MS)),
  };
  const tmp = `${SCHEDULER_STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
    fs.renameSync(tmp, SCHEDULER_STATE_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    process.stderr.write(`keep runs: could not persist scheduler state: ${e.message}\n`);
  }
}

function markDay(bucket, taskId, today) {
  loadSchedulerState()[bucket].set(taskId, today);
  saveSchedulerState(today);
}

function markedToday(bucket, taskId, today) {
  return loadSchedulerState()[bucket].get(taskId) === today;
}

// After a reaped session ended without recording anything, the card gets exactly one
// more chance today. Without this the per-day cap and a crashed session together mean
// a card that is simply never checked.
function grantReopen(taskId, today) {
  const state = loadSchedulerState();
  if (state.reopened.get(taskId) === today) return false;
  state.reopened.set(taskId, today);
  state.opened.delete(taskId);
  saveSchedulerState(today);
  return true;
}

// The agent a card's checks run as: `agent:` in its frontmatter, when it is a usable
// agent name. Empty for the ordinary card.
function cardAgent(task, root = keep.ROOT) {
  const name = task && task.fm && typeof task.fm.agent === 'string' ? task.fm.agent.trim() : '';
  const agents = require('./agents.js');
  if (!name || !agents.validName(name)) return '';
  // The CLI refuses these at add/checkin time; the frontmatter can still be written
  // by hand, so the scheduler refuses again where the name is used.
  const owner = agents.reservedAgentName(name, root);
  if (owner) {
    process.stderr.write(`keep runs: ${task.id} names agent ${name}, which is ${owner}; its check opens as an ordinary session\n`);
    return '';
  }
  return name;
}

// The account a scheduled check spends against: the automation pool's pick for the
// `checks` purpose (`automationAccounts.checks` is a preference, like every other
// purpose since the pool). A spent pool names its best member all the same, so the
// scheduler's own deferral bookkeeping below — `check deferred`, the configured
// `checks-fallback`, `check stalled` — runs against a pool account and never against
// the owner's interactive default, which the pool exists to keep automation off.
// Undefined lets openSession pick the default, which is what a single-account
// install wants anyway.
//
// The pool is asked about the same model `checkBudget` below classifies against
// (`KEEP_CHECK_MODEL`, else the reviewer's model as the proxy the docs describe), and
// its ranking is walked with that same budget check: `rank` orders by weekly percent,
// which can put an account with a spent 5h window or a spent model bucket ahead of one
// that has room, and a check deferred while a pool member could have run it is the
// one outcome this exists to prevent. Health is not recorded here: this runs every
// scheduler tick whether or not a card is due, and a row rewritten once a minute
// would erase a model-scoped deferral the reviewer had just recorded.
function checksAccountId(env = process.env, deps = {}) {
  let choice = null;
  try {
    const model = CHECK_MODEL || (deps.proxyModel || (() => require('./review.js').reviewerModel()))();
    choice = (deps.selectAccount || require('./account-budget.js').select)({
      purpose: 'checks', model: model || undefined, env, recordHealth: false,
    });
  } catch {}
  if (choice) {
    const ranked = Array.isArray(choice.ranked) ? choice.ranked : [];
    if (!ranked.length && choice.account) return choice.account;
    const budget = deps.checkBudget || checkBudget;
    for (const row of ranked) {
      if (!row || !row.id || row.exhausted) continue;
      let verdict;
      try { verdict = budget(row.id); } catch { verdict = null; }
      if (!budgetDeferralReason(verdict)) return row.id;
    }
    if (choice.account) return choice.account;
    if (ranked[0] && ranked[0].id) return ranked[0].id;
  }
  try { return require('./accounts.js').automationFor('claude', 'checks', env).id; }
  catch { return undefined; }
}

function checkBudget(accountId, deps = {}) {
  const read = deps.reviewBudget
    || ((model, snapshot, id) => require('./review.js').reviewBudget(model, snapshot, id));
  try { return read(CHECK_MODEL || undefined, undefined, accountId); }
  catch (e) { return { code: 8, reason: String(e && e.message || e) }; }
}

// An exhausted window (6 weekly, 7 five-hour) is a reason to wait for the reset. An
// unreadable snapshot (8) is not: checks are the daemon's whole job, and a stale usage
// file must never silently stop every card on the board.
function budgetDeferralReason(verdict) {
  if (!verdict || (verdict.code !== 6 && verdict.code !== 7)) return null;
  return String(verdict.reason || `usage budget code ${verdict.code}`);
}

// One line and one check-in per card per day, and no status or schedule change: the
// card stays overdue, so the next tick after the reset picks it straight back up.
function noteBudgetDeferral(task, reason, today, deps = keep) {
  process.stderr.write(`keep runs: check for ${task.id} deferred: ${reason}\n`);
  if (markedToday('budgetNotice', task.id, today)) return false;
  if (deps.quiet) return false;
  markDay('budgetNotice', task.id, today);
  try {
    deps.checkinTask(task.id, {
      heading: 'check deferred',
      message: `check deferred: ${clip(reason, 400)}; will retry after the limit resets`,
      linkSession: false,
      commitLabel: 'check',
    });
  } catch (e) {
    process.stderr.write(`keep runs: could not record the deferred check for ${task.id}: ${e.message}\n`);
  }
  return true;
}

// ---------- bounding a deferral streak ----------

// The account a deferred check may be retried on. Only an explicitly configured
// `checks-fallback` purpose counts: accounts.automationFor falls back to the agent
// default for an unset purpose, and re-running the same exhausted account under
// another name is not a fallback. Undefined means the install configured none.
function checksFallbackAccountId(env = process.env, deps = {}) {
  const accounts = deps.accounts || require('./accounts.js');
  let configured;
  try { configured = accounts.publicState(env).automationAccounts['checks-fallback']; }
  catch { return undefined; }
  if (!configured) return undefined;
  const primary = (deps.checksAccountId || checksAccountId)(env);
  if (primary && configured === primary) return undefined;
  const account = accounts.get(configured, env);
  return account && account.agent === 'claude' ? configured : undefined;
}

// Bookkeeping for one budget deferral, keyed on the card's current `check_after`, so
// rescheduling a card starts its streak over. Returns the entry and whether this
// deferral is the one that has to stop being silent.
function recordBudgetDeferral(task, reason, today, now = Date.now()) {
  const state = loadSchedulerState();
  const { entry, changed } = checkDeferrals.note(state.deferred, task.id, {
    checkAfter: task.fm.check_after || '', reason, stamp: keep.nowStamp(), today,
  });
  // A tick a minute against an exhausted account must not be a disk write a minute.
  if (changed) saveSchedulerState(today);
  return { entry, escalate: checkDeferrals.escalationDue(entry, now) };
}

// A check that ran, or was delivered, is not deferred any more — and a card whose
// schedule moved has a new streak, not a continuing one.
function clearBudgetDeferral(taskId, today) {
  const state = loadSchedulerState();
  if (!checkDeferrals.clear(state.deferred, taskId)) return false;
  saveSchedulerState(today);
  return true;
}

// The end of the line: no fallback account, or one that is exhausted too. One
// check-in, with the streak in it, and `keep overdue` marks the card stalled from
// here on. Status and schedule are untouched — the check is still wanted, and the
// next tick after the reset still picks it up.
function noteStalledCheck(task, entry, reason, deps = keep) {
  const since = String(entry.since || '').replace('T', ' ');
  const days = entry.notices > 1 ? ` on ${entry.notices} separate days` : '';
  try {
    deps.checkinTask(task.id, {
      heading: 'check stalled',
      message: `check stalled: deferred since ${since}${days} because ${clip(reason, 300)}.`
        + ' No fallback account is configured or available, so this check has not run.'
        + ` Run it by hand with keep verify ${task.id}, reschedule it, or configure a checks-fallback automation account.`,
      linkSession: false,
      commitLabel: 'check',
    });
    return true;
  } catch (e) {
    process.stderr.write(`keep runs: could not record the stalled check for ${task.id}: ${e.message}\n`);
    return false;
  }
}

// A deferral streak that reached its ceiling: retry once on the configured fallback
// account, and say so on the card either way. Returns true when the escalation was
// carried out (and may be latched), false when it should be retried next tick.
async function escalateBudgetDeferral(task, reason, today, opts = {}) {
  // Read before anything opens: a successful open clears the streak, and the notice is
  // dated by the streak's own first deferral rather than by the card's due date — a
  // daemon that was down when the check fell due did not defer it for those days.
  const streak = loadSchedulerState().deferred.get(task.id);
  const since = String((streak && streak.since) || '').replace('T', ' ') || 'its first deferral';
  const fallbackId = opts.fallbackAccountId !== undefined
    ? opts.fallbackAccountId
    : (opts.checksFallbackAccountId || checksFallbackAccountId)();
  if (fallbackId) {
    let outcome;
    try {
      outcome = await openFreshCheckSession(task, { ...opts, today, accountId: fallbackId });
    } catch (e) {
      process.stderr.write(`keep runs: fallback check session for ${task.id} could not be opened: ${e.message}\n`);
      // A terminal host that was restarting, or an open already in flight, says nothing
      // about the fallback account. Latching the streak on it would spend the card's one
      // escalation on a condition that clears by itself a minute later — but a host that
      // has been "temporarily" unavailable for three escalations running is not
      // transient, and retrying every tick forever is the silence this ceiling exists to
      // stop. The count is on the streak, so it survives a restart.
      if (isTransientStartError(e)) {
        const state = loadSchedulerState();
        const tries = checkDeferrals.countAttempt(state.deferred, task.id);
        saveSchedulerState(today);
        if (tries < MAX_FALLBACK_ATTEMPTS) return false;
        outcome = { skipped: 'error', reason: `${tries} attempts failed, last: ${String(e && e.message || e)}` };
      } else outcome = { skipped: 'error', reason: String(e && e.message || e) };
    }
    if (!outcome.skipped) {
      process.stderr.write(`keep runs: check for ${task.id} opened on the fallback account ${fallbackId}\n`);
      try {
        (opts.checkinTask || keep.checkinTask)(task.id, {
          heading: 'check deferred',
          message: `check deferred since ${since} on the checks account (${clip(reason, 200)});`
            + ` opened on the configured fallback account ${fallbackId} instead.`,
          linkSession: false,
          commitLabel: 'check',
        });
      } catch (e) {
        process.stderr.write(`keep runs: could not record the fallback check for ${task.id}: ${e.message}\n`);
      }
      clearBudgetDeferral(task.id, today);
      return true;
    }
    // `opened-today` and `tick-cap` are this tick's own bookkeeping, not a verdict on
    // the fallback: leave the streak unlatched and try again on the next one.
    if (outcome.skipped !== 'budget' && outcome.skipped !== 'error') return false;
    reason = outcome.skipped === 'budget'
      ? `${reason}; the fallback account ${fallbackId} is out of budget too (${clip(outcome.reason || '', 200)})`
      : `${reason}; the fallback account ${fallbackId} could not be opened (${clip(outcome.reason || '', 200)})`;
  }
  const entry = loadSchedulerState().deferred.get(task.id);
  if (!entry) return true;
  if (!noteStalledCheck(task, entry, reason, { ...keep, ...(opts.checkinTask ? { checkinTask: opts.checkinTask } : {}) })) return false;
  checkDeferrals.markEscalated(loadSchedulerState().deferred, task.id);
  saveSchedulerState(today);
  return true;
}

// Every budget deferral goes through here: it records the streak, escalates the one
// that reached the ceiling, and otherwise writes the ordinary once-a-day notice.
async function handleBudgetDeferral(task, reason, today, opts = {}) {
  try { return await budgetDeferral(task, reason, today, opts); }
  catch (e) {
    // Bookkeeping, not the open. The caller's own catch marks the card opened for the
    // day on a non-transient failure, and a card whose deferral note could not be
    // written has had nothing opened on it at all.
    process.stderr.write(`keep runs: could not handle the deferred check for ${task.id}: ${e.message}\n`);
    return { noticed: false };
  }
}

async function budgetDeferral(task, reason, today, opts = {}) {
  const { entry, escalate } = (opts.recordBudgetDeferral || recordBudgetDeferral)(task, reason, today);
  if (escalate && opts.quietEscalation !== true) {
    const done = await (opts.escalate || escalateBudgetDeferral)(task, reason, today, opts);
    return { escalated: done === true, retry: done !== true };
  }
  // An already-escalated card is logged and nothing more. The stalled check-in and
  // the `keep overdue` annotation carry it from here; repeating the same sentence
  // every day is exactly the noise the ceiling exists to stop.
  return {
    noticed: (opts.noteBudgetDeferral || noteBudgetDeferral)(task, reason, today,
      { ...keep, ...(opts.checkinTask ? { checkinTask: opts.checkinTask } : {}), quiet: opts.quiet === true || entry.escalated }),
  };
}

// How many sessions this tick has opened. Module state, not a tick-local counter,
// because a probe escalation runs from an async probe callback that may land between
// ticks and must spend from the same allowance.
let freshOpensThisTick = 0;
// Which tick the current allowance belongs to. A probe callback can reserve an open at
// the end of one tick and have its opener reject during the next; without an identity,
// that refund would hand a slot back to a tick that never spent one, and the scheduler
// could launch four sessions in a tick capped at three.
let allowanceTick = 0;
function resetTickAllowance() { freshOpensThisTick = 0; allowanceTick += 1; }

// Everything that can refuse an open before one is attempted, in one place so the
// scheduler path and the probe-escalation path cannot drift apart.
function freshOpenRefusal(task, today, accountId, deps = {}) {
  const every = subDailyEveryMs(task);
  if (every) {
    // A card that re-arms more often than daily: one fresh session per interval.
    const last = loadSchedulerState().openedAt.get(task.id) || 0;
    if ((deps.now || Date.now()) - last < every) return { skipped: 'opened-within-interval' };
  } else if (markedToday('opened', task.id, today)) return { skipped: 'opened-today' };
  if (freshOpensThisTick >= MAX_FRESH_OPENS_PER_TICK) return { skipped: 'tick-cap' };
  const denial = budgetDeferralReason((deps.checkBudget || checkBudget)(accountId));
  if (denial) return { skipped: 'budget', reason: denial };
  return null;
}

// Two manual verifies, or a verify racing a scheduler tick, must not put two agents on
// one card. Same shape as serve.js's freshOpenOperations: the second caller waits for
// and returns the first result instead of opening anything.
const openInFlight = new Map(); // taskId -> promise

// A due check that no live thread took opens a fresh interactive session on the card
// and types the same instruction a thread would have got. openSession links the session
// to the card, so from here on the delivery stamp, planDueCard('skip-delivered') and
// the deferral machinery all treat it as the linked thread.
function openFreshCheckSession(task, opts = {}) {
  const running = openInFlight.get(task.id);
  if (running) return running;
  const promise = openFreshCheckSessionOnce(task, opts)
    .finally(() => { if (openInFlight.get(task.id) === promise) openInFlight.delete(task.id); });
  openInFlight.set(task.id, promise);
  return promise;
}

async function openFreshCheckSessionOnce(task, opts = {}) {
  const today = opts.today || keep.nowStamp().slice(0, 10);
  const accountId = opts.accountId !== undefined ? opts.accountId : checksAccountId();
  const open = opts.open || openSession;
  // `keep verify` is Owner asking for this check now. It never spends the scheduler's
  // one-per-day allowance and is never refused for it, but it does write the same
  // TTL'd stamp, so the tick a minute later does not open a second pane on the card.
  const enforce = opts.enforce !== false;
  if (enforce) {
    const refusal = (opts.refusal || freshOpenRefusal)(task, today, accountId);
    if (refusal) return { ...refusal, errors: [] };
  }
  // Reserved before the await, not counted after it. Opening a session is async, and
  // two cards whose opens overlap — a scheduler card and a probe escalation, now a
  // deferral's fallback too — both read the allowance before either spent it, and the
  // tick launched more panes than the cap allows. A failed open gives its slot back to
  // the tick it took it from, and to no other.
  const reservedIn = allowanceTick;
  if (enforce) freshOpensThisTick += 1;
  // A card that names its agent runs its check as a standing agent: the record
  // exists before the session does (an emit for a name with no record is dropped),
  // the opener stamps the pane with the name, and the record then carries the
  // session so the agent's row under Agents shows it working on this card.
  let agentName = (opts.cardAgent || cardAgent)(task, opts.root || keep.ROOT);
  const agentApi = opts.agents || require('./agents.js');
  if (agentName) {
    try {
      const record = agentApi.ensure(agentName, {
        role: 'scheduled check', project: task.fm.project || '', card: task.id,
      }, { root: opts.root || keep.ROOT });
      // A record that is somebody else's (a responder's, or one launched some other
      // way) is never taken over: the check opens as an ordinary session instead.
      if (record && record.role !== 'scheduled check') {
        process.stderr.write(`keep runs: agent ${agentName} is ${record.role || 'another agent'}, not a scheduled check; ${task.id} opens as an ordinary session\n`);
        agentName = '';
      }
    } catch (error) {
      process.stderr.write(`keep runs: could not create the agent record ${agentName} for ${task.id}: ${error.message}\n`);
      agentName = '';
    }
  }
  let opened;
  try {
    opened = await open({
      taskId: task.id,
      fresh: true,
      agent: 'claude',
      ...(accountId ? { accountId } : {}),
      ...(CHECK_MODEL ? { model: CHECK_MODEL } : {}),
      ...(agentName ? { agentName } : {}),
      message: checkDeliveryMessage(task, { probe: opts.probe }),
    }, {});
  } catch (error) {
    if (enforce && reservedIn === allowanceTick) freshOpensThisTick = Math.max(0, freshOpensThisTick - 1);
    throw error;
  }
  if (!enforce) freshOpensThisTick += 1;
  if (enforce) {
    markDay('opened', task.id, today);
    loadSchedulerState().openedAt.set(task.id, Date.now());
    saveSchedulerState(today);
  }
  if (agentName && opened && opened.sessionId) {
    try {
      agentApi.writeRecord(agentName, {
        session: { id: opened.sessionId, pane: opened.pane || '', startedAt: Date.now() },
        lifecycle: 'working', card: task.id,
      }, { root: opts.root || keep.ROOT });
      agentApi.flushCommits(opts.root || keep.ROOT);
    } catch (error) {
      process.stderr.write(`keep runs: could not record the session on agent ${agentName}: ${error.message}\n`);
    }
  }
  // A check that ran is not deferred any more, whichever path opened it — the
  // scheduler, a probe escalation, `keep verify`, or the fallback account. Clearing
  // only on the scheduler's path left a probe card carrying its old fallback attempts
  // into the next exhausted window.
  clearBudgetDeferral(task.id, today);
  const delivery = {
    sessionId: (opened && opened.sessionId) || '',
    kind: 'claude',
    checkAfter: task.fm.check_after,
    ttlMs: FRESH_OPEN_STAMP_TTL_MS,
  };
  return { opened, delivery, errors: stampFreshOpen(task, delivery) };
}

// Stamp the opened session the way a thread delivery is stamped, so a daemon restart
// does not open a second session for the same `check_after` — but with a TTL, because
// unlike a thread this session has nobody to notice that it died.
function stampFreshOpen(task, delivery) {
  const errors = [];
  try {
    writeDeliveryStamp(task, delivery);
    require('./delivery').acknowledge(path.join(keep.ROOT, '.keep', 'delivery'), checkDeliveryMessage(task), checkDeliveryKey(task));
  } catch (e) {
    errors.push(e);
    process.stderr.write(`keep runs: could not stamp the check session opened for ${task.id}: ${e.message}\n`);
  }
  if (!landDeliveryWarning(task, delivery)) errors.push(new Error(`could not land delivery warning for ${task.id}`));
  return errors;
}

// ---------- reaping scheduler-opened panes ----------

const EPHEMERAL_IDLE_MS = 60 * 60e3;

function stampMs(stamp) {
  const parsed = Date.parse(String(stamp || '').replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : 0;
}

// When this session last wrote to this card. `fm.updated` would answer for any writer —
// the reviewer, a probe landing, Owner — so a card that moved for an unrelated reason
// used to read as "the check is recorded". Entries are matched by attribution instead:
// an entry naming a session names its author, and an unattributed entry belongs to the
// card's own owning session, which for a pane this scheduler opened is that pane's.
//
// Log stamps are minute-resolution, which matters differently for the two cases. An
// entry that NAMES this session is proof whoever wrote it was this session, so it counts
// from the launch minute — a fast check that finishes in the same minute it was asked
// for is exactly the case that must not read as "no result". An UNATTRIBUTED entry is
// only inferred to be ours, so it counts from the next minute: one stamped in the launch
// minute may have been written a moment before the pane came up. A miss there falls back
// to the 60-minute idle rule, so the pane closes late, never early.
function checkinFromSessionAt(task, sessionId, since) {
  if (!task || !sessionId) return 0;
  let entries = [];
  try { entries = require('./review.js').logEntries(task.body); } catch { return 0; }
  const owns = Array.isArray(task.fm && task.fm.sessions)
    && task.fm.sessions.some((entry) => entry && entry.id === sessionId);
  const launchMinute = Math.floor(Number(since || 0) / 60e3) * 60e3;
  let latest = 0;
  for (const entry of entries) {
    const split = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) — ([\s\S]*)$/.exec(entry.heading || '');
    if (!split) continue;
    const at = stampMs(split[1]);
    if (!at) continue;
    const attributed = /\(by (?:claude|codex) ([A-Za-z0-9_-]+)\)/.exec(split[2]);
    const mine = attributed ? attributed[1] === sessionId : (owns && !/\(reviewer /.test(split[2]));
    if (!mine) continue;
    if (at < (attributed ? launchMinute : launchMinute + 60e3)) continue;
    if (at > latest) latest = at;
  }
  return latest;
}

// Whether a pane this scheduler opened has finished with its card. Pure so the policy
// can be tested without a host: the sweep supplies the pane, the session summary the
// console already computes, and when that session last wrote to the card.
//
// The one rule that is never traded away: a session mid-turn is never closed. An
// interactive session is the point — it may still be finishing the check.
function reapEphemeralPane({ pane, session, checkedInAt = 0, now = Date.now() } = {}, idleMs = EPHEMERAL_IDLE_MS) {
  const meta = (pane && pane.meta) || {};
  if (!meta.ephemeral) return { reap: false, reason: 'not a scheduler-opened pane' };
  const launchedAt = Number(meta.launchedAt) || 0;
  // Compared by minute, because a card log stamp has no seconds: a session opened at
  // 12:00:20 that checked in at 12:00 did check in after its launch. checkinFromSessionAt
  // has already decided which entries are in window, so anything it returns counts.
  const checkedIn = Boolean(launchedAt && checkedInAt > 0
    && checkedInAt >= Math.floor(launchedAt / 60e3) * 60e3);
  if (pane.alive === false || (session && session.exited)) {
    return { reap: true, checkedIn, reason: 'the agent has exited' };
  }
  if (session && session.endedTurn === false) return { reap: false, checkedIn, reason: 'mid-turn' };
  const ended = session ? session.endedTurn === true : null;
  if (ended && checkedIn) {
    return { reap: true, checkedIn: true, reason: 'the check is recorded on the card and the turn has ended' };
  }
  const idleSince = Math.max(launchedAt, Number(session && session.mtime) || 0);
  if (idleSince && now - idleSince >= idleMs) {
    return { reap: true, checkedIn, reason: `idle ${Math.round((now - idleSince) / 60e3)} min with no check-in` };
  }
  return { reap: false, checkedIn, reason: ended === null ? 'turn state unknown' : 'waiting for the check-in' };
}

// A session that was closed without ever recording anything leaves the card exactly as
// it was — except for the stamp that says it was delivered. Clear that, say so once on
// the card, and give the card one more open today: the alternative is a check that is
// silently skipped until someone notices.
function releaseUnfinishedCheck(cardId, sessionId, today = keep.nowStamp().slice(0, 10), deps = keep) {
  if (!cardId) return false;
  // Only this session's own stamp. Between the open and the reap the card may have been
  // rescheduled and re-delivered — to a thread, or to a later session — and clearing
  // that stamp would put a second agent on a check somebody else is already running.
  // Read raw, by id: this needs no card and must not take readDeliveryStamp's side
  // effect of deleting a stamp it considers stale.
  const stamp = readRawDeliveryStamp(cardId);
  if (stamp && stamp.sessionId !== sessionId) {
    process.stderr.write(`keep runs: ${cardId} was re-delivered to ${(sessionRef(stamp.sessionId) || 'another session')} while ${sessionRef(sessionId)} was open; its stamp stands\n`);
    return false;
  }
  removeDeliveryStamp(cardId);
  const reopened = grantReopen(cardId, today);
  const short = sessionRef(sessionId) || 'unknown';
  try {
    deps.checkinTask(cardId, {
      heading: 'check session ended',
      message: `check session ${short} ended without recording a result; the check will be re-opened on the next tick`,
      linkSession: false,
      commitLabel: 'check',
    });
  } catch (e) {
    process.stderr.write(`keep runs: could not record the unfinished check session for ${cardId}: ${e.message}\n`);
  }
  return reopened;
}

// Ask the host for every pane this scheduler opened, and close the ones that are done.
// Anything the host cannot answer leaves the pane alone: "I could not tell" is not
// "nobody is using it".
async function sweepEphemeralPanes(host = ephemeralHost, now = Date.now()) {
  if (!host || typeof host.listPanes !== 'function' || typeof host.closePane !== 'function') return [];
  let panes;
  try { panes = await host.listPanes(); }
  catch (e) {
    process.stderr.write(`keep runs: could not list host panes for the ephemeral sweep: ${e.message}\n`);
    return [];
  }
  if (!Array.isArray(panes)) return [];
  // Only with the host's own agents module: a host built without one (a test) must
  // never reach whatever registry this process points at.
  if (host.agents) idleOrphanedCheckAgents(panes, host.agents, now);
  // A pane on another node is left alone here even if a caller hands one over:
  // closing it and releasing its card's stamp both rest on evidence only the
  // machine running it can produce.
  const isRemotePane = require('./nodes.js').isRemotePane;
  const ephemeral = panes.filter((pane) => pane && pane.meta && pane.meta.ephemeral
    && !isRemotePane(pane));
  if (!ephemeral.length) return [];
  let sessions = [];
  try { sessions = (host.sessions ? await host.sessions() : []) || []; } catch {}
  const byId = new Map(sessions.filter((entry) => entry && entry.id).map((entry) => [entry.id, entry]));
  const today = keep.nowStamp().slice(0, 10);
  const closed = [];
  for (const pane of ephemeral) {
    const sessionId = pane.meta.sessionId || null;
    if (!sessionId) continue; // nothing to close against; the pane keeps its own record
    let card = null;
    if (pane.meta.card) { try { card = keep.loadTask(pane.meta.card); } catch {} }
    const checkedInAt = checkinFromSessionAt(card, sessionId, Number(pane.meta.launchedAt) || 0);
    const decision = reapEphemeralPane({ pane, session: byId.get(sessionId), checkedInAt, now });
    if (!decision.reap) continue;
    const label = `${pane.meta.ephemeral} session pane ${pane.id} for ${pane.meta.card || 'no card'}`;
    // An account transfer stops the source agent on purpose, so mid-transfer the pane
    // reads here as an agent that has exited. Closing it takes away the very pane the
    // transfer's retry resumes into, and the check is then cancelled for nothing.
    const transfer = require('./account-handoff').transferInFlight(keep.ROOT, sessionId, now);
    if (transfer) {
      process.stderr.write(`keep runs: left the ${label} open: an account transfer is in flight (${transfer.status}/${transfer.phase})\n`);
      continue;
    }
    try {
      // A pane that is already dead needs no graceful close, only removal; a live one
      // is closed through the guarded automatic path, which refuses rather than kills
      // when the session still has a draft, a question, or unverified work.
      if (pane.alive !== false) await host.closePane(pane, sessionId);
    } catch (e) {
      // Left alone and retried next tick: a refusal here is the guard doing its job.
      process.stderr.write(`keep runs: left the ${label} open: ${e.message}\n`);
      continue;
    }
    // Forget the pane so a dead one is not re-closed on every tick from now on. A host
    // that refuses — the usual reason is that the pane is alive again — means this pane
    // is not finished after all, so it is not reported closed and the card keeps its
    // stamp and its allowance.
    if (host.removePane) {
      try { await host.removePane(pane); }
      catch (e) {
        process.stderr.write(`keep runs: could not remove the ${label}, so its card is left as it was: ${e.message}\n`);
        continue;
      }
    }
    closed.push(pane.id);
    process.stderr.write(`keep runs: closed the ${label}: ${decision.reason}\n`);
    if (!decision.checkedIn) releaseUnfinishedCheck(pane.meta.card, sessionId, today, host.checkinTask ? host : keep);
    // A check that ran as an agent is idle again once its pane is gone, and lets the
    // session go in the same write (the pane's card check-ins are the log), so the
    // orphan pass above has nothing left to write next tick.
    const agentName = typeof pane.meta.agentName === 'string' ? pane.meta.agentName : '';
    if (agentName && host.agents) {
      try {
        const agentApi = host.agents;
        const record = agentApi.readRecord(agentName);
        if (record && record.session && record.session.id === sessionId) {
          agentApi.writeRecord(agentName, { lifecycle: 'idle', card: '', session: { id: '', pane: '', startedAt: 0 } });
          agentApi.flushCommits();
        }
      } catch (e) {
        process.stderr.write(`keep runs: could not idle agent ${agentName} after closing its pane: ${e.message}\n`);
      }
    }
  }
  return closed;
}

// A card agent's record names a session only while the check pane the scheduler
// opened is carrying it. Adoption (a restart, a handoff) releases the record itself,
// but a session move, a resume by hand or a pane closed outside this sweep never
// pass through adoption, and agents.applySessions binds by the record's session id
// as much as by the pane's name — so the record would read `working` forever. Once
// a tick, then: a scheduled-check record whose session no pane still carries as
// `ephemeral: 'check'` + `agentName` is idled and lets the session go. Judged over
// the whole pane list, alive or not: a dead check pane is reaped further down and
// idles the record itself; only a pane that lost the mark, or is gone, counts here.
// A record whose session started within the last minute is left for the next tick:
// `keep verify` opens a check beside the tick, and a pane list answered before that
// pane existed must not read as the pane being gone.
const ORPHAN_CHECK_GRACE_MS = 60e3;

function idleOrphanedCheckAgents(panes, agentApi, now = Date.now()) {
  let records;
  try { records = agentApi.records(); } catch { return []; }
  const carried = new Set((panes || [])
    .filter((pane) => pane && pane.meta && pane.meta.ephemeral === 'check' && typeof pane.meta.agentName === 'string')
    .map((pane) => pane.meta.agentName));
  const idled = [];
  for (const record of records || []) {
    if (!record || record.role !== 'scheduled check' || !record.session || !record.session.id) continue;
    if (carried.has(record.name)) continue;
    if (Number(record.session.startedAt) > now - ORPHAN_CHECK_GRACE_MS) continue;
    try {
      agentApi.writeRecord(record.name, { lifecycle: 'idle', card: '', session: { id: '', pane: '', startedAt: 0 } });
      idled.push(record.name);
    } catch (e) {
      process.stderr.write(`keep runs: could not idle card agent ${record.name} whose check pane is gone: ${e.message}\n`);
    }
  }
  if (idled.length) { try { agentApi.flushCommits(); } catch {} }
  return idled;
}

// ---------- deterministic probes ----------

const PROBE_REPEAT_MS = 10 * 60e3;
const PROBE_OUTPUT_TAIL = 500;
// Probes are cheap but not free, and after daemon downtime every card is due at once.
// Cap them like runs: the rest are skipped unstamped and picked up on a later tick.
const parsedMaxProbes = parseInt(process.env.KEEP_MAX_CONCURRENT_PROBES || '3', 10);
const MAX_CONCURRENT_PROBES = Number.isFinite(parsedMaxProbes) && parsedMaxProbes > 0 ? parsedMaxProbes : 3;
const probesInFlight = new Set(); // taskId
const probedAt = new Map(); // taskId -> { checkAfter, at }

// The daemon's half of `keep probe`: same shell, same cwd, same KEEP_PROBE marker, but
// asynchronous — a probe may take a minute and the tick runs every minute, so blocking
// on it would stall every other due card behind it.
function startProbe(task, onDone, timeoutMs = Number(process.env.KEEP_PROBE_TIMEOUT_MS || 120e3)) {
  const started = Date.now();
  const expanded = expandProject(task.fm.project);
  const cwd = expanded && fs.existsSync(expanded) ? expanded : keep.ROOT;
  const child = spawn(process.env.SHELL || '/bin/sh', ['-c', task.fm.probe], {
    cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, KEEP_PROBE: '1' },
  });
  let output = '';
  let timedOut = false;
  let settled = false;
  const collect = (chunk) => { output = (output + chunk).slice(-4000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  // detached: the probe is a shell, so its children have to die with it.
  const timer = setTimeout(() => { timedOut = true; killGroup(child, 'SIGKILL'); }, timeoutMs);
  const finish = (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const exit = code == null ? (timedOut ? 124 : 1) : code;
    onDone({
      ok: !timedOut && exit === 0,
      code: exit,
      timedOut,
      ms: Date.now() - started,
      output: output.trim().slice(-PROBE_OUTPUT_TAIL),
    });
  };
  child.on('error', (e) => { collect(`\n${e.message}`); finish(null); });
  child.on('close', (code) => finish(code));
  return child;
}

// The pure decision a probe result produces, factored out of the scheduler the same way
// finalizePayload is factored out of finalize: an exit code, and the card's own
// declaration of what a pass means. No model is involved on either path.
function probePayload(task, result) {
  const tail = String(result.output || '').trim();
  const base = { taskId: task.id, heading: 'probe result', linkSession: false, commitLabel: 'check' };
  if (!result.ok) {
    return {
      ...base,
      message: `probe FAILED (exit ${result.code}${result.timedOut ? ', timed out' : ''}, ${result.ms}ms): ${clip(tail || '(no output)', 800)}`,
      status: 'review',
      clearCheckAfter: true,
    };
  }
  const line = tail.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '(no output)';
  const outcome = onPassOutcome(task);
  const payload = {
    ...base,
    message: `probe passed (${result.ms}ms): ${clip(line, 400)}${outcome.why ? `\n\n(${outcome.why})` : ''}`,
    status: outcome.status,
    clearCheckAfter: outcome.clearCheckAfter,
  };
  if (outcome.checkAfter) payload.checkAfter = outcome.checkAfter;
  return payload;
}

// A probe runs for as long as it runs, so the card it decided about may have moved on.
// Reload under the registry lock and compare fingerprints before applying any state:
// the probe's reading is still worth recording, its verdict is not.
function landProbeResult(task, result) {
  const payload = probePayload(task, result);
  const snapshot = cardFingerprint(task);
  const { taskId, ...checkin } = payload;
  try {
    keep.withLock(() => {
      const taskNow = keep.loadTask(taskId);
      if (cardFingerprint(taskNow) !== snapshot) {
        keep.checkinTask(taskId, {
          heading: checkin.heading,
          message: `${checkin.message}\n\n(card changed while the probe ran; status and schedule preserved)`,
          linkSession: false,
          commitLabel: 'check',
          withinLock: true,
        });
        return;
      }
      keep.checkinTask(taskId, { ...checkin, withinLock: true });
    });
    return null;
  } catch (e) {
    const pendingFile = path.join(RUNS_DIR, `${taskId}-probe-${Date.now().toString(36)}.pending.json`);
    try {
      fs.mkdirSync(RUNS_DIR, { recursive: true });
      fs.writeFileSync(pendingFile, JSON.stringify({ ...payload, _retryCardFingerprint: snapshot }, null, 2) + '\n');
      process.stderr.write(`keep runs: probe check-in failed for ${taskId}; saved pending result to ${pendingFile}: ${e.message}\n`);
    } catch (pendingError) {
      process.stderr.write(`keep runs: probe check-in failed for ${taskId} (${e.message}) and pending result could not be saved: ${pendingError.message}\n`);
    }
    return e;
  }
}

// A failing probe on a card that also has a recipe is a question, not an answer: hand
// the model what the probe saw and let the recipe say why. Probe cards never use thread
// delivery — the point of a probe is that nobody has to be awake for it — so this opens
// a fresh session on the card rather than borrowing one.
async function escalateProbeFailure(task, result, opts = {}) {
  const today = opts.today || keep.nowStamp().slice(0, 10);
  try {
    // Same allowance as the scheduler path — the per-day open, the per-tick cap and the
    // budget. A probe failing every ten minutes must not be a way around any of them.
    const outcome = await openFreshCheckSession(task, { ...opts, today, probe: result });
    if (outcome.skipped) {
      if (outcome.skipped === 'budget') await handleBudgetDeferral(task, outcome.reason, today, { probe: result });
      else process.stderr.write(`keep runs: probe escalation for ${task.id} held back (${outcome.skipped})\n`);
      return null;
    }
    process.stderr.write(`keep runs: probe failed for ${task.id} (exit ${result.code}); opened a check session\n`);
    return outcome.errors[0] || null;
  } catch (e) {
    if (!isTransientStartError(e)) markDay('opened', task.id, today);
    process.stderr.write(`keep runs: probe escalation for ${task.id} could not open a session: ${e.message}\n`);
    return e;
  }
}

// A probe is skipped while one is in flight, and re-probed at most every ten minutes
// for the same schedule: a landing failure or a "3 runs active" refusal must not turn
// into a probe every sixty seconds. A card held back by the concurrency cap records
// nothing, so the next tick retries it rather than waiting out the repeat window.
function probeDue(task, now = Date.now(), inFlight = probesInFlight.size) {
  if (inFlight >= MAX_CONCURRENT_PROBES) return false;
  if (probesInFlight.has(task.id)) return false;
  const last = probedAt.get(task.id);
  return !(last && last.checkAfter === (task.fm.check_after || '') && now - last.at < PROBE_REPEAT_MS);
}

function startDueProbe(task, onSettled = () => {}) {
  probesInFlight.add(task.id);
  probedAt.set(task.id, { checkAfter: task.fm.check_after || '', at: Date.now() });
  try {
    return startProbe(task, (result) => {
      probesInFlight.delete(task.id);
      const fail = (e) => {
        process.stderr.write(`keep runs: probe result for ${task.id} could not be handled: ${e.message}\n`);
        onSettled(result, e);
      };
      if (result.ok || !task.fm.check) {
        try { onSettled(result, landProbeResult(task, result)); } catch (e) { fail(e); }
        return;
      }
      // Escalation opens a session, so it is async; a probe callback is not.
      try { escalateProbeFailure(task, result).then((error) => onSettled(result, error), fail); }
      catch (e) { fail(e); }
    });
  } catch (e) {
    probesInFlight.delete(task.id);
    process.stderr.write(`keep runs: probe for ${task.id} failed to start: ${e.message}\n`);
    onSettled(null, e);
    return null;
  }
}

const deferrals = new Map(); // taskId -> { day, count }
// Cards whose check open failed for good, and the day: the card is marked opened for
// the day (markDay) and is not retried, so a later tick that reaches it does nothing
// for it and must not count it as work, or that tick records ok and wipes the streak
// the failure started. With nothing else to do those ticks record a skip that holds
// the failure (bin/health.js record, holdResult) for the rest of that day rather than
// reading the row as recovered.
const givenUp = new Map(); // taskId -> day
function givenUpToday() {
  const today = keep.nowStamp().slice(0, 10);
  for (const [id, day] of givenUp) if (day !== today) givenUp.delete(id);
  return givenUp.size > 0;
}
let tickInFlight = false;
async function schedulerTick() {
  if (tickInFlight) return;
  tickInFlight = true;
  const tickErrors = [];
  let didWork = false;
  let deferralNotices = 0;
  let escalations = 0;
  const checksAccount = checksAccountId();
  resetTickAllowance();
  try {
    try {
      didWork = fs.existsSync(RUNS_DIR) && fs.readdirSync(RUNS_DIR).some((file) => file.endsWith('.pending.json'));
    } catch {}
    tickErrors.push(...retryPending()); // land any check-ins that a prior tick couldn't commit
    const today = keep.nowStamp().slice(0, 10);
    for (const t of keep.loadAll(false)) {
      const stamp = readDeliveryStamp(t);
      if (stamp && stamp.truncated && !stamp.warningLanded) {
        didWork = true;
        if (!landDeliveryWarning(t, stamp)) {
          tickErrors.push(new Error(`could not land delivery warning for ${t.id}`));
          continue;
        }
      }
      if (!keep.isOverdue(t) || (!t.fm.check && !t.fm.probe)) continue;
      let deferred = deferrals.get(t.id);
      if (!deferred || deferred.day !== today) {
        deferred = { day: today, count: 0 };
        deferrals.set(t.id, deferred);
      }
      // A card with a probe answers its own check: the exit code lands the result with
      // no model at all, and only a failure is worth a session. Never delivered to a
      // thread — a probe exists so nobody has to be awake for it.
      if (t.fm.probe) {
        if (!probeDue(t)) continue;
        didWork = true;
        startDueProbe(t);
        continue;
      }

      if (planDueCard(t, { stamp }) === 'skip-delivered') {
        require('./delivery').acknowledge(path.join(keep.ROOT, '.keep', 'delivery'), checkDeliveryMessage(t), checkDeliveryKey(t));
        continue;
      }
      const workBefore = didWork;
      didWork = true;

      // An unconfirmed typed attempt may already be executing. Reconcile its
      // receipt before choosing another recipient or falling back to headless.
      const pendingDelivery = require('./delivery').statusForText(path.join(keep.ROOT, '.keep', 'delivery'), checkDeliveryMessage(t), checkDeliveryKey(t));
      if (pendingDelivery?.received) {
        writeDeliveryStamp(t, pendingDelivery);
        require('./delivery').acknowledge(path.join(keep.ROOT, '.keep', 'delivery'), checkDeliveryMessage(t), checkDeliveryKey(t));
        continue;
      }

      let threadBusy = planDueCard(t, {
        deferrals: deferred,
        maxDeferrals: MAX_DELIVER_DEFERRALS,
      }) === 'open-after-deferrals';
      if (pendingDelivery) threadBusy = false;
      // A recurring check re-arms itself: a thread would have to remember the interval
      // and re-schedule it by hand, and a monitor needs none of that thread's context.
      const recurring = t.fm.check_on_pass === 'rearm';
      if (!threadBusy && !recurring) {
        let delivery = null;
        try {
          delivery = await deliverToThread(t);
        } catch (e) {
          delivery = { deferred: true, reason: String(e && e.message || e) };
        }
        if (delivery && delivery.deferred) {
          if (pendingDelivery || delivery.uncertain || require('./delivery').statusForText(path.join(keep.ROOT, '.keep', 'delivery'), checkDeliveryMessage(t), checkDeliveryKey(t))) {
            process.stderr.write(`keep runs: check for ${t.id} has an unconfirmed delivery; the fresh-session fallback is suppressed\n`);
            continue;
          }
          deferred.count += 1;
          process.stderr.write(`keep runs: check for ${t.id} deferred: ${delivery.reason}\n`);
          threadBusy = planDueCard(t, {
            deferrals: deferred,
            maxDeferrals: MAX_DELIVER_DEFERRALS,
          }) === 'open-after-deferrals';
          if (!threadBusy) continue;
        } else if (delivery) {
          try {
            writeDeliveryStamp(t, delivery);
            require('./delivery').acknowledge(path.join(keep.ROOT, '.keep', 'delivery'), checkDeliveryMessage(t), checkDeliveryKey(t));
          } catch (e) {
            tickErrors.push(e);
            process.stderr.write(`keep runs: could not stamp delivered check for ${t.id}: ${e.message}\n`);
          }
          clearBudgetDeferral(t.id, today);
          process.stderr.write(`keep runs: delivered check for ${t.id} into ${delivery.kind} session ${sessionRef(delivery.sessionId)}\n`);
          if (!landDeliveryWarning(t, delivery)) tickErrors.push(new Error(`could not land delivery warning for ${t.id}`));
          onChange();
          continue;
        }
      }

      if (pendingDelivery) continue;

      // Nothing headless is left: the check now runs in a fresh interactive session
      // opened on the card. One per card per local day, three per tick, none without
      // budget — freshOpenRefusal holds all three rules.
      try {
        const outcome = await openFreshCheckSession(t, { today, accountId: checksAccount });
        if (outcome.skipped === 'budget') {
          // Every deferral is logged; only the first few a tick are written to a card.
          // The quota counts check-ins that were actually written — a card that was
          // already noticed today costs nothing, so it must not spend another card's turn.
          // Escalations are rarer and carry the same per-tick ceiling; one held back
          // here is not lost, because its streak stays unlatched for the next tick.
          const handled = await handleBudgetDeferral(t, outcome.reason, today, {
            quiet: deferralNotices >= MAX_DEFERRAL_NOTICES_PER_TICK,
            quietEscalation: escalations >= MAX_DEFERRAL_NOTICES_PER_TICK,
          });
          if (handled.escalated) { escalations += 1; onChange(); }
          else if (handled.noticed) deferralNotices += 1;
          continue;
        }
        // A card whose open already failed for good today reaches here with nothing
        // tried for it (no thread took the check either), so it is not this tick's work.
        if ((outcome.skipped === 'opened-today' || outcome.skipped === 'opened-within-interval') && givenUp.get(t.id) === today) didWork = workBefore;
        if (outcome.skipped) continue;
        clearBudgetDeferral(t.id, today);
        const { delivery, errors } = outcome;
        process.stderr.write(`keep runs: opened a check session for ${t.id}${delivery.sessionId ? ` (session ${sessionRef(delivery.sessionId)})` : ''}\n`);
        tickErrors.push(...errors);
        onChange();
      } catch (e) {
        if (!isTransientStartError(e)) markDay('opened', t.id, today);
        if (!isTransientStartError(e)) { tickErrors.push(e); givenUp.set(t.id, today); }
        process.stderr.write(`keep runs: could not open a check session for ${t.id}: ${e.message}\n`);
      }
    }
    if ((await sweepEphemeralPanes()).length) didWork = true;
  } catch (e) {
    tickErrors.push(e);
    process.stderr.write(`keep runs: scheduler tick failed: ${String(e && e.message || e)}\n`);
  } finally {
    health.record('runs', tickErrors.length
      ? { ok: false, error: tickErrors.map((error) => String(error && error.message || error)).join('; ') }
      : didWork ? { ok: true, skipped: false, detail: undefined }
        : { ok: true, skipped: true, detail: 'nothing due', ...(givenUpToday() ? { holdResult: true } : {}) });
    tickInFlight = false;
  }
}

// Test seam only: the per-day escalation budget and the probe bookkeeping are module
// state, and a unit test has to start from a known one and leave none behind.
// Forget the in-memory copy only, so the next load reads the file back: what a
// daemon restart does.
function _resetSchedulerStateInMemory() { schedulerState = null; }

function _resetSchedulerState() {
  schedulerState = { opened: new Map(), budgetNotice: new Map(), reopened: new Map(), deferred: new Map(), openedAt: new Map() };
  try { fs.unlinkSync(SCHEDULER_STATE_FILE); } catch {}
  openInFlight.clear();
  resetTickAllowance();
  deferrals.clear();
  probesInFlight.clear();
  probedAt.clear();
}

function startScheduler() {
  const iv = setInterval(schedulerTick, 60e3);
  iv.unref();
  setTimeout(schedulerTick, 30e3).unref(); // first pass shortly after boot
}

module.exports = {
  retryPending, startScheduler, schedulerTick, setOnChange, setDeliverer, setOpener, setEphemeralHost,
  openFreshCheckSession, checksAccountId, checkBudget, budgetDeferralReason, noteBudgetDeferral,
  checksFallbackAccountId, recordBudgetDeferral, clearBudgetDeferral, noteStalledCheck,
  escalateBudgetDeferral, handleBudgetDeferral, MAX_FALLBACK_ATTEMPTS,
  freshOpenRefusal, resetTickAllowance, loadSchedulerState, releaseUnfinishedCheck,
  readDeliveryStamp, writeDeliveryStamp, readRawDeliveryStamp, stampExpired, checkinFromSessionAt,
  reapEphemeralPane, sweepEphemeralPanes, MAX_FRESH_OPENS_PER_TICK, MAX_DEFERRAL_NOTICES_PER_TICK,
  EPHEMERAL_IDLE_MS, FRESH_OPEN_STAMP_TTL_MS,
  checkDeliveryMessage, checkDeliveryKey, planDueCard, deliveryWarning,
  cardFingerprint, pendingCheckin, onPassOutcome,
  probePayload, startProbe, startDueProbe, probeDue, landProbeResult, escalateProbeFailure,
  isTransientStartError, MAX_CONCURRENT_PROBES, _resetSchedulerState, _resetSchedulerStateInMemory, subDailyEveryMs,
};
