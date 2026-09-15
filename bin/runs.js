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
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const keep = require('./keep.js');
const health = require('./health.js');

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
  // Reserve room for handoff guidance and the full card ID — and for the on-pass and
  // probe sentences, so a long recipe cannot push `Full card:` past the 2000-char cap.
  const recipeLimit = Math.max(200, 900
    - (fm.check_on_pass === 'done' ? 120 : 0)
    - (rearm ? 200 : 0)
    - (probeSentence ? probeSentence.length + 1 : 0));
  const clipped = recipe.length > recipeLimit;
  const shownRecipe = clipped ? `${recipe.slice(0, recipeLimit - 1)}…` : recipe;
  const title = String(fm.title || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const message = [
    probeSentence,
    `[keep] scheduled check due for ${task.id} ("${title}"), scheduled for ${fm.check_after || '(unspecified)'}.`,
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
      ? `This card re-arms: if every gate holds, check in with --check-after ${fm.check_every || '<the card\'s check_every>'} and the status unchanged; if not, record the failure and the status it deserves.`
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
    message: `The scheduled check was typed into ${delivery.kind} session ${String(delivery.sessionId || '').slice(0, 8)} but arrived truncated (${delivery.received}/${delivery.expected} chars); the full recipe is on this card (keep show ${task.id}).`,
    linkSession: false,
    commitLabel: 'check',
  };
}

function deliveryStampFile(taskId) {
  return path.join(RUNS_DIR, `${taskId}.delivered.json`);
}

function readDeliveryStamp(task) {
  const file = deliveryStampFile(task.id);
  let stamp = null;
  try { stamp = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (stamp && (stamp.checkAfter === task.fm.check_after || (stamp.truncated && !stamp.warningLanded))) return stamp;
  if (fs.existsSync(file)) {
    try { fs.unlinkSync(file); } catch (e) {
      process.stderr.write(`keep runs: could not remove stale delivery stamp for ${task.id}: ${e.message}\n`);
    }
  }
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
// already a lot of windows to come back to.
const MAX_FRESH_OPENS_PER_TICK = 3;
const openedToday = new Map(); // taskId -> YYYY-MM-DD
const budgetNoticeDay = new Map(); // taskId -> YYYY-MM-DD

// The account a scheduled check spends against. Undefined lets openSession pick the
// default, which is what a single-account install wants anyway.
function checksAccountId(env = process.env) {
  try { return require('./accounts.js').automationFor('claude', 'checks', env).id; }
  catch { return undefined; }
}

function checkBudget(accountId, deps = {}) {
  const read = deps.reviewBudget
    || ((model, snapshot, id) => require('./review.js').reviewBudget(model, snapshot, id));
  try { return read(process.env.KEEP_CHECK_MODEL || undefined, undefined, accountId); }
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
  if (budgetNoticeDay.get(task.id) === today) return false;
  budgetNoticeDay.set(task.id, today);
  process.stderr.write(`keep runs: check for ${task.id} deferred: ${reason}\n`);
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

// A due check that no live thread took opens a fresh interactive session on the card
// and types the same instruction a thread would have got. openSession links the session
// to the card, so from here on the delivery stamp, planDueCard('skip-delivered') and
// the deferral machinery all treat it as the linked thread.
async function openFreshCheckSession(task, opts = {}) {
  const today = opts.today || keep.nowStamp().slice(0, 10);
  const accountId = opts.accountId !== undefined ? opts.accountId : checksAccountId();
  const open = opts.open || openSession;
  const opened = await open({
    taskId: task.id,
    fresh: true,
    agent: 'claude',
    ...(accountId ? { accountId } : {}),
    message: checkDeliveryMessage(task, { probe: opts.probe }),
  }, {});
  openedToday.set(task.id, today);
  const delivery = {
    sessionId: (opened && opened.sessionId) || '',
    kind: 'claude',
    checkAfter: task.fm.check_after,
  };
  return { opened, delivery, errors: stampFreshOpen(task, delivery) };
}

// Stamp the opened session exactly as a thread delivery is stamped, so a daemon
// restart does not open a second session for the same `check_after`.
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

// Whether a pane this scheduler opened has finished with its card. Pure so the policy
// can be tested without a host: the sweep only supplies the pane, the session summary
// the console already computes, and when the card was last written.
//
// The one rule that is never traded away: a session mid-turn is never closed. An
// interactive session is the point — it may still be finishing the check.
function reapEphemeralPane({ pane, session, checkedInAt = 0, now = Date.now() } = {}, idleMs = EPHEMERAL_IDLE_MS) {
  const meta = (pane && pane.meta) || {};
  if (!meta.ephemeral) return { reap: false, reason: 'not a scheduler-opened pane' };
  if (pane.alive === false || (session && session.exited)) return { reap: true, reason: 'the agent has exited' };
  const ended = session ? session.endedTurn === true : null;
  if (session && session.endedTurn === false) return { reap: false, reason: 'mid-turn' };
  const launchedAt = Number(meta.launchedAt) || 0;
  if (ended && launchedAt && checkedInAt > launchedAt) {
    return { reap: true, reason: 'the check is recorded on the card and the turn has ended' };
  }
  const idleSince = Math.max(launchedAt, Number(session && session.mtime) || 0);
  if (idleSince && now - idleSince >= idleMs) {
    return { reap: true, reason: `idle ${Math.round((now - idleSince) / 60e3)} min with no check-in` };
  }
  return { reap: false, reason: ended === null ? 'turn state unknown' : 'waiting for the check-in' };
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
  const ephemeral = panes.filter((pane) => pane && pane.meta && pane.meta.ephemeral);
  if (!ephemeral.length) return [];
  let sessions = [];
  try { sessions = (host.sessions ? await host.sessions() : []) || []; } catch {}
  const byId = new Map(sessions.filter((s) => s && s.id).map((s) => [s.id, s]));
  const closed = [];
  for (const pane of ephemeral) {
    const sessionId = pane.meta.sessionId || null;
    if (!sessionId) continue; // nothing to close against; the pane keeps its own record
    let checkedInAt = 0;
    if (pane.meta.card) {
      try { checkedInAt = stampMs(keep.loadTask(pane.meta.card).fm.updated); } catch {}
    }
    const decision = reapEphemeralPane({ pane, session: byId.get(sessionId), checkedInAt, now });
    if (!decision.reap) continue;
    try {
      await host.closePane(pane, sessionId);
      closed.push(pane.id);
      process.stderr.write(`keep runs: closed the ${pane.meta.ephemeral} session pane ${pane.id} for ${pane.meta.card || 'no card'}: ${decision.reason}\n`);
    } catch (e) {
      process.stderr.write(`keep runs: could not close the ${pane.meta.ephemeral} session pane ${pane.id}: ${e.message}\n`);
    }
  }
  return closed;
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
  if (openedToday.get(task.id) === today) return null;
  try {
    const { errors } = await openFreshCheckSession(task, { ...opts, today, probe: result });
    process.stderr.write(`keep runs: probe failed for ${task.id} (exit ${result.code}); opened a check session\n`);
    return errors[0] || null;
  } catch (e) {
    if (!isTransientStartError(e)) openedToday.set(task.id, today);
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
let tickInFlight = false;
async function schedulerTick() {
  if (tickInFlight) return;
  tickInFlight = true;
  const tickErrors = [];
  let didWork = false;
  let freshOpens = 0;
  const checksAccount = checksAccountId();
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
          process.stderr.write(`keep runs: delivered check for ${t.id} into ${delivery.kind} session ${String(delivery.sessionId).slice(0, 8)}\n`);
          if (!landDeliveryWarning(t, delivery)) tickErrors.push(new Error(`could not land delivery warning for ${t.id}`));
          onChange();
          continue;
        }
      }

      if (pendingDelivery) continue;

      // Nothing headless is left: the check now runs in a fresh interactive session
      // opened on the card. One per card per local day, three per tick.
      if (openedToday.get(t.id) === today) continue;
      if (freshOpens >= MAX_FRESH_OPENS_PER_TICK) continue;
      const denial = budgetDeferralReason(checkBudget(checksAccount));
      if (denial) { noteBudgetDeferral(t, denial, today); continue; }
      try {
        const { delivery, errors } = await openFreshCheckSession(t, { today, accountId: checksAccount });
        freshOpens += 1;
        process.stderr.write(`keep runs: opened a check session for ${t.id}${delivery.sessionId ? ` (session ${String(delivery.sessionId).slice(0, 8)})` : ''}\n`);
        tickErrors.push(...errors);
        onChange();
      } catch (e) {
        if (!isTransientStartError(e)) openedToday.set(t.id, today);
        if (!isTransientStartError(e)) tickErrors.push(e);
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
      : { ok: true, skipped: !didWork, detail: didWork ? undefined : 'nothing due' });
    tickInFlight = false;
  }
}

// Test seam only: the per-day escalation budget and the probe bookkeeping are module
// state, and a unit test has to start from a known one and leave none behind.
function _resetSchedulerState() {
  openedToday.clear();
  budgetNoticeDay.clear();
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
  reapEphemeralPane, sweepEphemeralPanes, MAX_FRESH_OPENS_PER_TICK, EPHEMERAL_IDLE_MS,
  checkDeliveryMessage, checkDeliveryKey, planDueCard, deliveryWarning,
  cardFingerprint, pendingCheckin, onPassOutcome,
  probePayload, startProbe, startDueProbe, probeDue, landProbeResult, escalateProbeFailure,
  isTransientStartError, MAX_CONCURRENT_PROBES, _resetSchedulerState,
};
