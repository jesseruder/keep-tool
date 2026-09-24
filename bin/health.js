'use strict';

// Persistent, model-free health for the timer-driven work in `keep serve`.
// The file is deliberately useful without the daemon: `keep health` reads it
// directly, and every write is rename-atomic so a dashboard read cannot observe
// half-written JSON.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
const FILE = path.join(ROOT, '.keep', 'health.json');
const HOUR_MS = 3600e3;
const DAY_MS = 24 * HOUR_MS;
const VERSION = 1;
// How long after `keep restart-daemon` the next start still counts as the one
// it asked for. The marker is written just before exit and launchd's KeepAlive
// relaunches within seconds, so a short window keeps it from covering a crash.
const RESTART_REQUEST_MS = 2 * 60e3;
// A deploy — a daemon start on a different commit from the one before it — is
// watched for this long: a scheduler row that was healthy when the new code
// started and records a failure inside the window is charged to that deploy on the
// `deploy` row. Rows as slow as the window or slower are watched until their first
// run has had time to happen (cadence plus half the window), never past the cap, so
// an hourly row still gets its first tick counted and a daily one only when it
// happens to run soon after the start.
const DEPLOY_ROW = 'deploy';
const DEPLOY_WATCH_MS = 30 * 60e3;
const DEPLOY_WATCH_MAX_MS = 2 * HOUR_MS;
// Rows a deploy is never charged with, because what fails them is the machine or
// the registry rather than the code, and a restart provokes exactly that: the new
// daemon's own startup can stall the loop past five seconds (`loop-stalls`), and
// `runs` fails on delivery into sessions whose host is still reattaching. `lint`
// and `git-pull` fail on registry and checkout state, `account-budget` on a spent
// account pool, and `inflight` on a durable record outliving its max age, which a
// restart can strand and which then ages past its limit an hour later. The same
// reasoning as bin/self-repair.js EXCLUDED, plus the budget.
const DEPLOY_UNWATCHED = new Set(['runs', 'lint', 'git-pull', 'loop-stalls', 'account-budget', 'inflight']);
let warnedWrite = false;

// Schedulers that no longer exist. Their rows stay in health.json from older
// daemons and would otherwise read as silent forever.
const RETIRED = new Set(['review-questions']);

const CADENCES = Object.freeze({
  review: { cadenceMs: 10 * 60e3 },
  'review-compact': { cadenceMs: 60e3 },
  runs: { cadenceMs: 60e3 },
  'review-obligations': { cadenceMs: 5 * 60e3 },
  delivery: { cadenceMs: 60e3 },
  unblock: { cadenceMs: 60e3 },
  notes: { cadenceMs: 60e3 },
  slack: { cadenceMs: 15 * 60e3 },
  discord: { cadenceMs: 15 * 60e3 },
  landed: { cadenceMs: 30 * 60e3 },
  'wt-gc': { cadenceMs: DAY_MS },
  'pane-retention': { cadenceMs: HOUR_MS },
  'auto-compact': { cadenceMs: 30e3 },
  'handoff-queue': { cadenceMs: 30e3 },
  leftovers: { cadenceMs: 5 * 60e3 },
  'limit-resume': { cadenceMs: 60e3 },
  usage: { onDemand: true },
  // Written by bin/account-budget.js when an automation launch finds its whole pool
  // spent, and again when one finds room. On demand: there is no tick to be late.
  'account-budget': { onDemand: true },
  'fleet-usage': { cadenceMs: 5 * 60e3 },
  'card-usage': { cadenceMs: 30e3 },
  lint: { cadenceMs: 30 * 60e3 },
  'git-pull': { cadenceMs: 30 * 60e3 },
  'push-receipts': { cadenceMs: 15 * 60e3 },
  // Written by the event-loop lag probe (bin/serve/schedulers.js), not a tick of
  // its own: a heartbeat every five minutes, plus a failure per >5 s stall, at most
  // one per ten minutes. Excluded from self-repair (bin/self-repair.js EXCLUDED).
  'loop-stalls': { cadenceMs: 5 * 60e3 },
  // Written by the stalled sweep (bin/inflight.js): failing while any in-flight record
  // is past its maximum age. It files its own card, so self-repair excludes it.
  inflight: { cadenceMs: 60e3 },
  digest: { onDemand: true },
  // Recorded once at daemon start and once if a Claude transcript watcher dies: no
  // cadence, so the row reads as a warning until the next start records it ok.
  'transcript-watcher': { onDemand: true },
  // Written from inside record() when a row that was healthy before a deploy starts
  // failing after it (see noteDeploy). On demand: it has no tick of its own, and
  // bin/self-repair.js skips on-demand rows, so the failing scheduler gets the repair
  // card and this row only names the deploy it started with.
  [DEPLOY_ROW]: { onDemand: true },
  // Written by the node-stats poller in serve.js after each round in which a node
  // reported its hook queue: failing while a node's queue is at its cap or holds an
  // event over ten minutes old (bin/node-stats.js hookQueueHealth). On demand: it has
  // no tick of its own, and an install with no nodes never writes it. Excluded from
  // self-repair (bin/self-repair.js EXCLUDED).
  'node-hook-queue': { onDemand: true },
  brief: { cadenceMs: DAY_MS, daily: true, hour: 8, minute: 0, windowMs: 2 * HOUR_MS },
  ideas: { cadenceMs: DAY_MS, daily: true, hour: 7, minute: 30, windowMs: 2 * HOUR_MS },
  standup: { cadenceMs: DAY_MS, daily: true, weekdays: true, hour: 11, minute: 30, windowMs: 2 * HOUR_MS },
});

function atMs(value, fallback = 0) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clipError(error) {
  const value = String(error && error.message || error || '').replace(/\s+/g, ' ').trim();
  return value.length > 300 ? value.slice(0, 299) + '…' : value;
}

function readStore() {
  try {
    const value = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function writeStore(value) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const temp = `${FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(temp, FILE);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

// The commit and checkout of the code this process was loaded from. Read once
// at daemon start: a pull afterwards changes the files, not what is running.
function codeCommit(dir = path.join(__dirname, '..')) {
  try {
    const run = (args) => require('child_process').execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8', timeout: 5e3, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { commit: run(['rev-parse', 'HEAD']), checkout: run(['rev-parse', '--show-toplevel']) };
  } catch { return { commit: '', checkout: '' }; }
}

// Called by the daemon on `keep restart-daemon`, immediately before it exits.
function recordRestartRequest(options = {}) {
  const at = atMs(options.at, Date.now());
  const store = readStore();
  const daemon = store.daemon && typeof store.daemon === 'object' ? store.daemon : {};
  store.daemon = { ...daemon, restartRequestedAt: at };
  persist(store);
  return store.daemon;
}

// Daemon starts since `since` that nobody asked for: crashes, launchd relaunches.
function unrequestedStarts(daemon, since) {
  const requested = new Set((daemon && Array.isArray(daemon.requestedStartAts) ? daemon.requestedStartAts : []).map(Number));
  return (daemon && Array.isArray(daemon.startedAts) ? daemon.startedAts : [])
    .map(Number).filter((value) => Number.isFinite(value) && value >= since && !requested.has(value));
}

// One scheduler's stored row, as written: a single small read, for a writer that
// decides whether to record from what is on disk rather than from its own memory.
function row(name) {
  const value = readStore()[name];
  return value && typeof value === 'object' ? value : null;
}

function shortSha(value) {
  return String(value || '').slice(0, 7) || 'unknown';
}

// How long after the deploy's start a failure on `name` still counts against it.
function deployWatchUntil(watch, name) {
  const cadenceMs = Number((CADENCES[name] || {}).cadenceMs || 0);
  const span = cadenceMs >= DEPLOY_WATCH_MS ? Math.min(cadenceMs + DEPLOY_WATCH_MS / 2, DEPLOY_WATCH_MAX_MS) : DEPLOY_WATCH_MS;
  return Number(watch.startedAt) + span;
}

// The commit the daemon last reported loading. A start whose `git rev-parse` failed
// or timed out (likely under exactly the load a restart brings) records no commit,
// and comparing the next start against that blank would miss the next deploy; the
// last one known is carried forward instead.
function knownCommit(prior) {
  return String(prior.commit || prior.lastKnownCommit || '');
}

// The watch a daemon start arms: which rows were healthy (recorded, enabled, a zero
// streak) the moment the new commit started, every row the store held then (so a
// scheduler the deploy added is watched too), and which commit it replaced. Only a
// start on a new commit arms one; a start on the same commit, or with no commit
// (a crash, a restart with nothing landed, a git that did not answer), keeps the
// watch the deploy armed, so a crash inside the window does not forget it, and drops
// it once no row could still be watched. A deploy that lands inside an earlier
// deploy's window keeps that one's base: its failures could come from either, so the
// label names the whole range that went live since the last quiet start.
function deployWatchFor(store, prior, at, commit) {
  const previousCommit = knownCommit(prior);
  const watch = prior.deployWatch && typeof prior.deployWatch === 'object'
    && Number.isFinite(Number(prior.deployWatch.startedAt))
    && at - Number(prior.deployWatch.startedAt) <= DEPLOY_WATCH_MAX_MS ? prior.deployWatch : null;
  if (commit && previousCommit && commit !== previousCommit) {
    const rows = Object.keys(store).filter((name) => name !== 'daemon' && name !== DEPLOY_ROW);
    const healthy = rows.filter((name) => {
      if (RETIRED.has(name) || DEPLOY_UNWATCHED.has(name)) return false;
      const entry = store[name];
      return entry && typeof entry === 'object' && entry.disabled !== true && !Number(entry.consecutiveFailures || 0);
    });
    const open = watch && String(watch.commit || '') === previousCommit && at <= Number(watch.startedAt) + DEPLOY_WATCH_MS;
    const base = open && watch.previousCommit ? String(watch.previousCommit) : previousCommit;
    return { commit, previousCommit: base, startedAt: at, healthy, rows };
  }
  return watch;
}

// Whether a failure of `name` at `at` is one the deploy watch charges: a row healthy
// at the start, or a row that did not exist at the start (a scheduler the deploy
// added), failing inside its window. Watches armed before `rows` was recorded only
// know the healthy list.
function deployCharges(watch, name, at) {
  if (!watch || !Array.isArray(watch.healthy)) return null;
  if (at < Number(watch.startedAt) || at > deployWatchUntil(watch, name)) return null;
  if (watch.healthy.includes(name)) return { added: false };
  if (Array.isArray(watch.rows) && !watch.rows.includes(name) && !RETIRED.has(name) && !DEPLOY_UNWATCHED.has(name)) return { added: true };
  return null;
}

// Runs inside record(), on the store it already read and is about to write, so a
// deploy regression costs no extra file access. Two things land here: a row the
// watch saw healthy failing inside its window (a regression, charged to the deploy
// it started with), and a row already charged recording again (its streak is kept
// current, and a zero streak resolves it). The `deploy` row is rebuilt from what is
// left: failing on the worst open streak, so it turns red on the same three-in-a-row
// that turns the scheduler's own row red, and ok again once every regression cleared.
//
// A charged row that is disabled comes through here with a zero streak, and one that
// is retired or gone from the store is dropped on any record, so neither can hold the
// row failing with nothing left that could ever clear it. Nor can a row the deploy
// added that the running code has stopped writing (a revert took it out): see
// abandonedAdded.
function noteDeploy(store, name, entry, at, failed) {
  if (name === DEPLOY_ROW || name === 'daemon') return;
  const prior = store[DEPLOY_ROW] && typeof store[DEPLOY_ROW] === 'object' ? store[DEPLOY_ROW] : null;
  const regressions = {};
  let changed = false;
  for (const [row, value] of Object.entries(prior && prior.regressions && typeof prior.regressions === 'object' ? prior.regressions : {})) {
    if (value && typeof value === 'object' && !RETIRED.has(row) && store[row] && typeof store[row] === 'object'
      && !(value.added && abandonedAdded(store, row, at))) regressions[row] = value;
    else changed = true;
  }
  const failures = Number(entry.consecutiveFailures || 0);
  if (regressions[name]) {
    regressions[name] = { ...regressions[name], consecutiveFailures: failures, ...(failed ? { error: entry.lastError || '' } : {}) };
    changed = true;
  } else if (failed && failures) {
    const charge = deployCharges(store.daemon && store.daemon.deployWatch, name, at);
    if (charge) {
      const watch = store.daemon.deployWatch;
      regressions[name] = {
        commit: watch.commit, previousCommit: watch.previousCommit, deployedAt: Number(watch.startedAt),
        firstFailedAt: at, consecutiveFailures: failures, error: entry.lastError || '',
        ...(charge.added ? { added: true } : {}),
      };
      changed = true;
    }
  }
  if (!changed) return;
  const open = Object.entries(regressions).filter(([, value]) => Number(value.consecutiveFailures || 0) > 0);
  const says = ([row, value]) => `${row}${value.added ? ' (new)' : ''} started failing after deploy ${shortSha(value.commit)} (was ${shortSha(value.previousCommit)})`;
  const next = { ...(prior || {}), disabled: false, lastRunAt: at, cadenceMs: 0 };
  if (open.length) {
    // The row reads what the rows it blames read. A charge counts toward the streak
    // only while its row's fault stands (faultStands, the test `failing` uses); when
    // none does, the streak is the charged rows' own and the latest result a skip, so
    // the row reads recovered exactly when they do. The failure time is the blamed
    // rows' last real failure, never the time of this record: a skip on a charged row
    // rebuilds the row, and stamping it would keep the fault standing forever.
    const standing = open.filter(([row]) => faultStands({ ...store[row], name: row }, at));
    const counted = standing.length ? standing : open;
    next.consecutiveFailures = Math.max(...counted.map(([, value]) => Number(value.consecutiveFailures)));
    const lastErrorAt = Math.max(0, ...counted.map(([row]) => atMs(store[row].lastErrorAt)));
    if (lastErrorAt) next.lastErrorAt = lastErrorAt;
    next.lastResult = standing.length ? 'failed' : 'skipped';
    next.lastError = clipError(open.map((item) => `${says(item)}: ${item[1].error || 'tick failed'}`).join('; '));
    next.detail = clipError(open.map(says).join('; '));
    // A regression that cleared while another is still open is dropped, so a later
    // failure of it, outside any watch, is not charged to this deploy again.
    next.regressions = Object.fromEntries(open);
  } else {
    next.lastResult = 'ok';
    next.consecutiveFailures = 0;
    next.lastOkAt = at;
    next.detail = Object.keys(regressions).length
      ? clipError(`${Object.entries(regressions).map(says).join('; ')}; recovered`)
      : 'the rows charged to the deploy were disabled or removed, or are no longer scheduled';
    delete next.regressions;
  }
  store[DEPLOY_ROW] = next;
}

// Whether a charged row the deploy added has been taken out of the running code. A
// scheduler with no CADENCES entry cannot be told apart from a removed one by name
// (self-repair and the compact-restore rows write their own rows), so it is judged by
// behaviour instead: it has not recorded since the current daemon started, and that
// start is older than the watch window and two of its own cadences. A live one records
// again inside that and keeps its charge; a reverted one never does and is let go.
// Only reached for an open `added` charge, so the hot path pays nothing for it.
function abandonedAdded(store, row, at) {
  if (Object.prototype.hasOwnProperty.call(CADENCES, row)) return false;
  const startedAt = Number(store.daemon && store.daemon.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  const entry = store[row];
  if (atMs(entry.lastRunAt) >= startedAt) return false;
  return at - startedAt > Math.max(DEPLOY_WATCH_MS, 2 * Number(entry.cadenceMs || 0));
}

// record() calls this, never noteDeploy directly: a malformed deploy row or watch in
// health.json must cost the attribution, never the scheduler's own record.
function safeNoteDeploy(store, name, entry, at, failed) {
  try { noteDeploy(store, name, entry, at, failed); } catch {}
}

function persist(value) {
  try {
    writeStore(value);
    warnedWrite = false;
    return true;
  } catch (error) {
    if (!warnedWrite) process.stderr.write(`keep health: could not persist health: ${clipError(error)}\n`);
    warnedWrite = true;
    return false;
  }
}

// Records one row. Answers the stored row, or null when the store could not be
// written (the failure is warned about once and never thrown), so a caller that
// writes only on change can tell a row that reached the disk from one that did not.
// The `daemon` row answers the daemon entry whatever the write did.
function record(name, options = {}) {
  const at = atMs(options.at, Date.now());
  const store = readStore();
  if (name === 'daemon') {
    const prior = store.daemon && typeof store.daemon === 'object' ? store.daemon : {};
    const startedAts = Array.isArray(prior.startedAts) ? prior.startedAts.map(Number).filter(Number.isFinite) : [];
    if (Number.isFinite(Number(prior.startedAt)) && !startedAts.includes(Number(prior.startedAt))) startedAts.push(Number(prior.startedAt));
    if (!startedAts.includes(at)) startedAts.push(at);
    // A start the previous daemon asked for (a deploy's `keep restart-daemon`)
    // is not a crash, so the restart-loop check leaves it out.
    const requestedAt = Number(prior.restartRequestedAt);
    const requested = Number.isFinite(requestedAt) && requestedAt >= atMs(prior.startedAt) && requestedAt <= at && at - requestedAt <= RESTART_REQUEST_MS;
    const requestedSet = new Set((Array.isArray(prior.requestedStartAts) ? prior.requestedStartAts.map(Number) : [])
      .filter((value) => startedAts.includes(value) && value !== at));
    if (requested) requestedSet.add(at);
    // Retain each kind separately so a run of deploys cannot push crashes out.
    const sorted = startedAts.sort((a, b) => a - b);
    const requestedKept = sorted.filter((value) => requestedSet.has(value)).slice(-10);
    const unrequestedKept = sorted.filter((value) => !requestedSet.has(value)).slice(-10);
    // The deploy watch is a side channel: nothing in it may cost the start record.
    let deployWatch = null;
    try { deployWatch = deployWatchFor(store, prior, at, options.commit ? String(options.commit) : ''); } catch {}
    const lastKnownCommit = options.commit ? String(options.commit) : knownCommit(prior);
    store.daemon = {
      startedAt: at,
      pid: Number(options.pid || process.pid),
      version: options.version == null ? VERSION : options.version,
      // The code this daemon loaded, so a deploy can tell it is behind origin
      // even when the checkout was pulled and the restart never happened.
      ...(options.commit ? { commit: String(options.commit), checkout: String(options.checkout || '') } : {}),
      startedAts: [...requestedKept, ...unrequestedKept].sort((a, b) => a - b),
      requestedStartAts: requestedKept,
      ...(lastKnownCommit ? { lastKnownCommit } : {}),
      ...(deployWatch ? { deployWatch } : {}),
    };
    persist(store);
    return store.daemon;
  }

  const cadence = CADENCES[name] || {};
  const prior = store[name] && typeof store[name] === 'object' ? store[name] : {};
  if (options.disabled === true) {
    const entry = {
      ...prior,
      disabled: true,
      cadenceMs: Number(options.cadenceMs || cadence.cadenceMs || prior.cadenceMs || 0),
      detail: clipError(options.detail || 'not configured'),
    };
    delete entry.expected;
    store[name] = entry;
    // A disabled row cannot fail again, so it cannot stay charged to a deploy.
    safeNoteDeploy(store, name, { consecutiveFailures: 0 }, at, false);
        return persist(store) ? entry : null;
  }
  const ok = options.ok !== false;
  const skipped = options.skipped === true || (ok && options.detail === 'nothing due');
  if (skipped) {
    const entry = {
      ...prior,
      disabled: false,
      lastRunAt: at,
      cadenceMs: Number(options.cadenceMs || cadence.cadenceMs || prior.cadenceMs || 0),
    };
    // A skip ordinarily keeps the streak, so a scheduler that fails and then has
    // nothing to do still reads as unresolved. `expected` is for the opposite case: the
    // tick decided the state it is standing in for is one the scheduler tolerates and
    // no fault at all — an endpoint rate limit shared with every running session, a
    // browser reader whose tab is closed. It does two things, together so they cannot
    // drift apart. It zeroes the streak, because otherwise the inherited count keeps
    // the row amber and turns it red at three: stateOf answers 'failing' on the streak
    // before it ever looks at the skip, and bin/self-repair.js opens a card on the same
    // count. And it marks the row, because a tolerated state has no success to be late
    // against either — the Discord reader's tab can be closed for a weekend — which is
    // what bin/lint.js daemonHealth reads instead of naming schedulers. Every other
    // record clears the mark, so a real failure is lintable again the moment it lands.
    // lastError/lastErrorAt stay as history; presentationOf only reads them while the
    // streak is nonzero.
    if (options.expected === true) {
      entry.consecutiveFailures = 0;
      entry.expected = true;
    } else delete entry.expected;
    // What the latest record was, so stateOf can tell a row whose most recent attempt
    // failed (failing) from one that has run cleanly since (recovered): a skip that
    // follows a failure keeps the streak, so the streak alone cannot say which. A skip
    // is a clean run unless the tick says otherwise with `holdResult`: nothing new
    // ran, and the fault it last recorded still stands — the loop-stall heartbeat
    // while a severe stall is inside its hour, the usage poll while an account's
    // failure waits for its retry, a tick that gave up for the day or could not reach
    // what it drives. That skip moves lastRunAt (the row is alive, not silent) and
    // carries a stored failure forward; after anything else it is still a skip, so
    // the field never names a success for a record that was not one. An expected
    // state has no fault to hold, so it is always a clean skip.
    entry.lastResult = options.holdResult === true && options.expected !== true && resultOf(prior) === 'failed'
      ? 'failed'
      : 'skipped';
    if (options.detail == null || options.detail === '') delete entry.detail;
    else entry.detail = clipError(options.detail);
    store[name] = entry;
    safeNoteDeploy(store, name, entry, at, false);
        return persist(store) ? entry : null;
  }
  const entry = {
    ...prior,
    disabled: false,
    lastRunAt: at,
    runs: Number(prior.runs || 0) + 1,
    cadenceMs: Number(options.cadenceMs || cadence.cadenceMs || prior.cadenceMs || 0),
    consecutiveFailures: ok ? 0 : Number(prior.consecutiveFailures || 0) + 1,
  };
  entry.lastResult = ok ? 'ok' : 'failed';
  if (ok) entry.lastOkAt = at;
  else {
    entry.lastErrorAt = at;
    entry.lastError = clipError(options.error || 'tick failed');
  }
  if (!ok && Number.isFinite(options.incidentAt)) entry.incidentAt = options.incidentAt;
  else delete entry.incidentAt;
  if (!ok && typeof options.incidentId === 'string') entry.incidentId = options.incidentId;
  else delete entry.incidentId;
  delete entry.expected;
  if (options.detail == null || options.detail === '') delete entry.detail;
  else entry.detail = clipError(options.detail);
  store[name] = entry;
  safeNoteDeploy(store, name, entry, at, !ok);
    return persist(store) ? entry : null;
}

function nextExpectedAfter(value, config) {
  const date = new Date(atMs(value));
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate(), config.hour || 0, config.minute || 0, 0, 0);
  if (target.getTime() <= date.getTime()) target.setDate(target.getDate() + 1);
  if (config.weekdays) {
    while (target.getDay() === 0 || target.getDay() === 6) target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

// The latest record's kind: 'ok', 'failed', 'skipped', or null for a row that has
// never recorded one. Rows written since `lastResult` existed say so directly. An
// older row is read from its timestamps, which the three record paths leave in a
// known order: a failure sets lastErrorAt = lastRunAt, a success lastOkAt = lastRunAt,
// and a skip moves lastRunAt alone. So the latest record failed exactly when
// lastErrorAt has not been passed by either of the others. A streak with no failure
// time at all is a row nobody wrote through record(); it reads as failed, which is
// what stateOf answered for it before this distinction existed.
function resultOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (['ok', 'failed', 'skipped'].includes(entry.lastResult)) return entry.lastResult;
  const runAt = atMs(entry.lastRunAt);
  const okAt = atMs(entry.lastOkAt);
  const errorAt = atMs(entry.lastErrorAt);
  if (errorAt > 0 && errorAt >= runAt && errorAt > okAt) return 'failed';
  if (!errorAt && Number(entry.consecutiveFailures || 0) > 0) return 'failed';
  if (okAt > 0 && okAt >= runAt) return 'ok';
  return runAt > 0 ? 'skipped' : null;
}

// Whether the most recent attempt failed.
function latestFailed(entry) {
  return resultOf(entry) === 'failed';
}

// How long after its last failure a streak still counts as a fault that stands,
// whatever skips followed it. A skip is the scheduler finding nothing to do, not
// proof its work succeeds: a scheduler whose real attempts come hourly and all fail,
// with a clean "nothing due" every minute between them, is broken, and would read as
// recovered almost all the time if only the latest record counted. So the window is
// the longer of an hour and two of the row's own cadences (about the time in which
// it should have had a real attempt), capped at a day. An hour is the floor because
// self-repair ticks every five minutes and must see a candidate across ticks; a day
// is the cap, and what a daily scheduler gets, so yesterday's failed brief stays red
// until today's attempt. Past the window, a streak the scheduler has only skipped
// since reads as recovered.
const RECENT_FAILURE_MIN_MS = HOUR_MS;
const RECENT_FAILURE_MAX_MS = DAY_MS;

function recentFailureMs(entry) {
  const config = CADENCES[entry && entry.name] || {};
  const cadenceMs = Number(entry && entry.cadenceMs || config.cadenceMs || 0);
  return Math.min(RECENT_FAILURE_MAX_MS, Math.max(RECENT_FAILURE_MIN_MS, 2 * cadenceMs));
}

// Whether a row's streak is a fault that stands now: its latest attempt failed, or
// its last failure is inside recentFailureMs. What `failing` means at three, and what
// bin/self-repair.js and bin/lint.js daemonHealth ask before treating a streak as
// current rather than history. A row with no streak has no fault to stand.
function faultStands(entry, now = Date.now()) {
  if (!(Number(entry && entry.consecutiveFailures || 0) > 0)) return false;
  if (latestFailed(entry)) return true;
  const lastErrorAt = atMs(entry && entry.lastErrorAt);
  return lastErrorAt > 0 && atMs(now, Date.now()) - lastErrorAt <= recentFailureMs(entry);
}

function stateOf(entry, now = Date.now()) {
  if (entry?.disabled === true) return 'disabled';
  const at = atMs(now, Date.now());
  const config = CADENCES[entry && entry.name] || {};
  const cadenceMs = Number(entry && entry.cadenceMs || config.cadenceMs || 0);
  let startedAt = entry && (entry.daemonStartedAt || entry.startedAt);
  if (!startedAt) {
    const store = readStore();
    startedAt = store.daemon && store.daemon.startedAt;
  }
  const daemonStartedAt = atMs(startedAt);
  const lastRunAt = atMs(entry && entry.lastRunAt);

  // Red means broken now. A streak of three reads as failing while its fault stands:
  // the latest attempt failed, or the last failure is recent (faultStands). Once the
  // scheduler has gone past that with only clean skips, the streak stays (it still
  // awaits a real ok to clear it) but the row reads as recovered: amber, and out of
  // console attention, the review bundle and the brief's daemon line. Unlike a plain
  // skip, a recovered row still goes through the silence checks below, so a scheduler
  // that failed and then stopped ticking reads as silent or never, as red as it was.
  const failures = Number(entry && entry.consecutiveFailures || 0);
  const stands = faultStands(entry, at);
  if (failures >= 3 && stands) return 'failing';
  const recovered = failures > 0 && !stands;
  const lastResultAt = Math.max(atMs(entry && entry.lastOkAt), atMs(entry && entry.lastErrorAt));
  if (!recovered && lastRunAt > lastResultAt) return 'skipped';
  if (!config.onDemand && cadenceMs > 0 && daemonStartedAt > 0) {
    const ranThisBoot = lastRunAt >= daemonStartedAt;
    if (!ranThisBoot) {
      let graceUntil = daemonStartedAt + cadenceMs;
      if (config.daily) graceUntil = Math.max(graceUntil, nextExpectedAfter(daemonStartedAt, config) + Number(config.windowMs || 2 * HOUR_MS));
      if (at > graceUntil) return 'never';
    } else if (config.daily) {
      const deadline = nextExpectedAfter(lastRunAt, config) + Number(config.windowMs || 2 * HOUR_MS);
      if (at > daemonStartedAt + cadenceMs && at > deadline) return 'silent';
    } else if (at - lastRunAt > 2 * cadenceMs && at > daemonStartedAt + cadenceMs) {
      return 'silent';
    }
  }
  if (recovered) return 'recovered';
  if (entry && entry.detail === 'nothing due') return 'skipped';
  return 'ok';
}

function pidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error && error.code === 'EPERM'; }
}

function snapshot(now = Date.now()) {
  const store = readStore();
  const daemon = store.daemon && typeof store.daemon === 'object' ? { ...store.daemon } : {};
  daemon.running = pidAlive(daemon.pid);
  const names = [...new Set([
    ...Object.keys(CADENCES),
    ...Object.keys(store).filter((name) => name !== 'daemon' && !RETIRED.has(name)),
  ])];
  const schedulers = names.map((name) => {
    const config = CADENCES[name] || {};
    const entry = store[name] && typeof store[name] === 'object' ? store[name] : {};
    const row = {
      name,
      disabled: entry.disabled === true,
      lastRunAt: entry.lastRunAt || null,
      lastOkAt: entry.lastOkAt || null,
      lastErrorAt: entry.lastErrorAt || null,
      lastError: entry.lastError || '',
      incidentAt: entry.incidentAt || null,
      incidentId: entry.incidentId || null,
      consecutiveFailures: Number(entry.consecutiveFailures || 0),
      // The latest record's kind, derived from the timestamps for a row written
      // before the field existed: what separates failing from recovered.
      lastResult: resultOf(entry),
      cadenceMs: Number(entry.cadenceMs || config.cadenceMs || 0),
      detail: entry.detail || '',
      // Whether the latest record is a state the scheduler tolerates rather than
      // progress or a fault. Carried into the row so `keep health --json` can be
      // asked why a row has gone a long time without a success.
      expected: entry.expected === true,
      daemonStartedAt: daemon.startedAt || null,
    };
    row.state = stateOf(row, now);
    Object.assign(row, presentationOf(row, now));
    delete row.daemonStartedAt;
    return row;
  });
  return { daemon, schedulers };
}

function duration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 90e3) return `${Math.round(value / 1000)}s`;
  if (value < 90 * 60e3) return `${Math.round(value / 60e3)}m`;
  if (value < 36 * HOUR_MS) return `${Math.round(value / HOUR_MS)}h`;
  return `${Math.round(value / DAY_MS)}d`;
}

function unhealthyRows(value) {
  return (value && value.schedulers || []).filter((entry) => ['failing', 'silent', 'never'].includes(entry.state));
}

function attentionItems(value, now = Date.now()) {
  const at = atMs(now, Date.now());
  const daemon = value && value.daemon || {};
  const items = unhealthyRows(value).map((entry) => {
    const anchor = entry.lastRunAt || daemon.startedAt || at;
    const reason = entry.lastError || `no tick for ${duration(at - atMs(anchor, at))}`;
    const eventAt = entry.incidentAt || entry.lastErrorAt || entry.lastRunAt || daemon.startedAt || at;
    return {
      id: `health:${entry.name}`,
      text: `${entry.name} ${entry.state}: ${reason}`,
      kind: 'health',
      at: eventAt,
      lastError: entry.lastError || '',
      ...(entry.incidentId ? { incidentId: entry.incidentId } : {}),
    };
  });
  const recentStarts = unrequestedStarts(daemon, at - HOUR_MS);
  if (recentStarts.length > 3) {
    const eventAt = Math.max(...recentStarts);
    items.push({
      id: 'health:daemon',
      text: `daemon restarting: ${recentStarts.length} starts in 1h`,
      kind: 'health',
      at: eventAt,
      lastError: `daemon restarting: ${recentStarts.length} starts in 1h`,
    });
  }
  return items;
}

function relativeTime(value, now) {
  const at = atMs(value);
  return at ? `${duration(atMs(now, Date.now()) - at)} ago` : 'never';
}

function presentationOf(entry, now = Date.now()) {
  if (entry && entry.state === 'disabled') return { displayState: 'disabled', displayDetail: entry.detail || '' };
  const failures = Number(entry && entry.consecutiveFailures || 0);
  const lastErrorAt = atMs(entry && entry.lastErrorAt);
  const lastOkAt = atMs(entry && entry.lastOkAt);
  const unresolved = failures > 0 && lastErrorAt > lastOkAt;
  const displayState = unresolved && failures < 3 && ['ok', 'skipped'].includes(entry.state) ? 'warning' : entry.state;

  // Failed before, clean since: say when it last failed and what it said, and that
  // the streak is waiting on a real run rather than on a fix. The display state is
  // 'warning', not 'recovered': an open console tab keeps its JS across daemon
  // restarts, and older JS colors 'warning' amber but leaves a state it does not know
  // uncolored and out of its header. `state` says recovered; labelOf names it for the
  // table and the current console.
  if (entry && entry.state === 'recovered') {
    const parts = [`last failed ${relativeTime(lastErrorAt, now)}${entry.lastError ? ` (${entry.lastError})` : ''}`,
      `${failures} failed attempt${failures === 1 ? '' : 's'}`];
    if (atMs(entry.lastRunAt) > lastErrorAt) parts.push(`latest check skipped ${relativeTime(entry.lastRunAt, now)}`);
    parts.push('awaiting a real run');
    return { displayState: 'warning', displayDetail: parts.join(' · ') };
  }

  if (unresolved) {
    const attempts = `${failures} failed attempt${failures === 1 ? '' : 's'}`;
    const parts = [attempts, `last failed attempt ${relativeTime(lastErrorAt, now)}`];
    if (atMs(entry.lastRunAt) > lastErrorAt) parts.push(`latest check skipped ${relativeTime(entry.lastRunAt, now)}`);
    if (entry.lastError) parts.push(entry.lastError);
    return { displayState, displayDetail: parts.join(' · ') };
  }

  return { displayState, displayDetail: entry.detail || '' };
}

// The word a row is shown under: its display state, except that a recovered row,
// displayed as 'warning' for older consoles, is named for what it is.
function labelOf(row, now = Date.now()) {
  if (row && row.state === 'recovered') return 'recovered';
  return (row && row.displayState) || presentationOf(row, now).displayState;
}

function reviewSection(value, now = Date.now()) {
  const rows = unhealthyRows(value);
  const daemon = value && value.daemon || {};
  const uptime = daemon.startedAt ? duration(atMs(now, Date.now()) - atMs(daemon.startedAt)) : 'unknown';
  const total = (value && value.schedulers || []).length;
  if (!rows.length && daemon.running !== false) return `daemon health: all ${total} schedulers ok (uptime ${uptime})`;
  const lines = daemon.running === false
    ? [`daemon health: daemon down (last start ${relativeTime(daemon.startedAt, now)})`]
    : [];
  lines.push(...rows.map((entry) => {
    const lastError = String(entry.lastError || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    const clippedError = lastError.length > 160 ? lastError.slice(0, 159) + '…' : lastError;
    const error = clippedError ? ` — ${clippedError}` : '';
    return `daemon health: ${entry.name} ${entry.state}${error}; last ok ${relativeTime(entry.lastOkAt, now)}`;
  }));
  const section = lines.join('\n');
  return section.length > 600 ? section.slice(0, 599) + '…' : section;
}

function wrapTick(name, fn, options = {}) {
  return async function trackedTick(...args) {
    try {
      const result = await fn(...args);
      const detail = typeof options.detail === 'function' ? options.detail(result) : options.detail;
      record(name, { ok: true, detail: detail || undefined });
      return result;
    } catch (error) {
      record(name, { ok: false, error, detail: typeof options.failureDetail === 'function' ? options.failureDetail(error) : options.failureDetail });
      if (options.onError) options.onError(error);
      if (options.rethrow) throw error;
      return undefined;
    }
  };
}

function render(value, now = Date.now()) {
  const daemon = value.daemon || {};
  const code = daemon.commit ? `, code ${String(daemon.commit).slice(0, 7)}` : '';
  const status = daemon.running ? `running (pid ${daemon.pid}, uptime ${duration(atMs(now) - atMs(daemon.startedAt))}${code})`
    : daemon.startedAt ? `down (last start ${relativeTime(daemon.startedAt, now)})` : 'down (no start recorded)';
  const rows = [...(value.schedulers || [])].sort((a, b) => {
    const rank = { failing: 0, silent: 1, never: 2, warning: 3, recovered: 4, skipped: 5, ok: 6, disabled: 7 };
    return (rank[labelOf(a, now)] ?? 9) - (rank[labelOf(b, now)] ?? 9) || a.name.localeCompare(b.name);
  });
  const values = [['scheduler', 'state', 'last run', 'last ok', 'failures', 'detail']];
  for (const row of rows) {
    const presentation = row.displayState ? row : presentationOf(row, now);
    values.push([
      row.name,
      labelOf(row, now),
      relativeTime(row.lastRunAt, now),
      relativeTime(row.lastOkAt, now),
      String(row.consecutiveFailures),
      presentation.displayDetail || '',
    ]);
  }
  const widths = values[0].map((_, index) => Math.max(...values.map((row) => row[index].length)));
  return [`daemon: ${status}`, values.map((row) => row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths[index])).join('  ').trimEnd()).join('\n')].join('\n\n');
}

module.exports = {
  ROOT,
  FILE,
  VERSION,
  CADENCES,
  DEPLOY_ROW,
  DEPLOY_WATCH_MS,
  DEPLOY_UNWATCHED,
  RETIRED,
  record,
  row,
  clipError,
  codeCommit,
  recordRestartRequest,
  unrequestedStarts,
  stateOf,
  resultOf,
  latestFailed,
  recentFailureMs,
  faultStands,
  presentationOf,
  labelOf,
  snapshot,
  attentionItems,
  reviewSection,
  wrapTick,
  render,
  duration,
  pidAlive,
};
