'use strict';
// A review that was launched but has not yet produced a verdict.
//
// `keep reviewed` records that a review happened. Nothing recorded that one was
// *expected*: a session launched a Codex review, the run ended before the verdict came
// back, and the review evaporated — the commits were self-verified, or sat unlandable
// until somebody noticed. Three cards did exactly that over 2026-09-12..15.
//
// An obligation is that missing half. It is opened when a review is launched, it is
// settled by the daemon from the job's own state, and it blocks the implicit land of
// the commits it covers until a verdict is recorded. It never writes a verdict itself:
// a dead job fails the obligation so the review is re-run, and is never mistaken for a
// clean one. And it is bounded — every obligation reaches a terminal state on its own,
// so a job that died in the night cannot block a card forever.

const fs = require('node:fs');
const path = require('node:path');
const keep = require('./keep.js');
const notes = require('./notes.js');

const OPEN_STATES = ['open', 'awaiting-verdict'];
const TERMINAL_STATES = ['satisfied', 'failed', 'abandoned'];
const STATES = [...OPEN_STATES, ...TERMINAL_STATES];

// A job file the companion has not written yet is not a missing job. Fifteen minutes
// is far longer than the gap between launching a task and its job record appearing,
// and short enough that a mistyped job id is caught within one session.
const MISSING_JOB_GRACE_MS = 15 * 60e3;
// A Codex review that has been running for six hours is not going to answer. The
// obligation is abandoned rather than failed: nobody saw it die, so the honest
// statement is that Keep stopped waiting.
const MAX_RUNNING_MS = 6 * 3600e3;
// Matches codexjobs' own reaping threshold: a stalled job idle for longer than this is
// what that sweep would cancel.
const STALL_MS = 20 * 60e3;

const NOTE_LIMIT = 500;
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

class ObligationError extends Error {}
function fail(message) { throw new ObligationError(message); }

// ---------- storage ----------

function obligationsDir(root = keep.ROOT) { return path.join(root, '.keep', 'review-obligations'); }
function cardFile(id, root = keep.ROOT) { return path.join(obligationsDir(root), `${id}.json`); }

function readRecords(id, root = keep.ROOT) {
  try {
    const value = JSON.parse(fs.readFileSync(cardFile(id, root), 'utf8'));
    return Array.isArray(value) ? value.filter((record) => record && typeof record === 'object' && STATES.includes(record.state)) : [];
  } catch { return []; }
}

function writeRecords(id, records, root = keep.ROOT) {
  const file = cardFile(id, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function cards(root = keep.ROOT) {
  try {
    return fs.readdirSync(obligationsDir(root))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length));
  } catch { return []; }
}

function recordId(now = Date.now()) {
  return `obl-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---------- opening one ----------

function open(input, options = {}) {
  const now = options.now || Date.now();
  const job = notes.scrub(input.job == null ? '' : input.job).trim().slice(0, 200);
  if (!job) fail('an obligation needs --job <codex-job-id>: it is what the daemon settles it from');
  if (!JOB_ID_RE.test(job)) fail(`--job "${job}" is not a Codex job id`);
  const commits = Array.isArray(input.commits) ? input.commits : [];
  if (!commits.length) fail('an obligation needs --commit <sha|range>: an obligation that covers nothing cannot gate a land');
  return {
    id: recordId(now),
    at: new Date(now).toISOString(),
    card: String(input.card || ''),
    job,
    accountId: notes.scrub(input.accountId == null ? '' : input.accountId).slice(0, 80),
    by: notes.scrub(input.by == null ? '' : input.by).slice(0, 120),
    commits,
    state: 'open',
    stateAt: new Date(now).toISOString(),
    note: notes.scrub(input.note == null ? '' : input.note).slice(0, NOTE_LIMIT),
    session: input.session && input.session.id
      ? { sessionId: String(input.session.id), agent: String(input.session.agent || '') }
      : null,
  };
}

function append(id, record, root = keep.ROOT) {
  const records = readRecords(id, root);
  records.push(record);
  writeRecords(id, records, root);
  return record;
}

// ---------- what counts as outstanding ----------

function isOpen(record) { return Boolean(record) && OPEN_STATES.includes(record.state); }

// A record whose `--job` is this obligation's job is the verdict this obligation was
// waiting for, whatever it says: `findings` settles it exactly as `clean` does, because
// the obligation asks whether the review came back, not whether it was happy.
function citedBy(record, reviewRecords) {
  return (reviewRecords || []).some((review) => review && review.job && review.job === record.job);
}

function samePatch(a, b) {
  if (!a || !b) return false;
  if (a.patchId && b.patchId) return a.patchId === b.patchId;
  return Boolean(a.sha) && a.sha === b.sha;
}

// Outstanding *for this land*: an obligation whose verdict has not been recorded and
// whose commits are part of what would land. Scoped by patch id, the same identity
// `keep reviewed` uses, so a rebase does not lose track of it.
function outstandingFor(records, reviewRecords, commits) {
  const landing = commits || [];
  return (records || []).filter(isOpen)
    .filter((record) => !citedBy(record, reviewRecords))
    .filter((record) => record.commits.some((commit) => landing.some((other) => samePatch(commit, other))));
}

// ---------- settling one from the job's own state ----------

function timeMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

const FAILED_STATUSES = new Set(['failed', 'error', 'cancelled', 'canceled', 'aborted', 'killed']);

// The pure decision: what this obligation becomes, given what Keep can see of its job.
// `job` is reviews.resolveJob's answer (null when no job file was found) and `live` is
// the codexjobs row for it (null when the sweep does not know it). Returns null to
// leave the obligation where it is.
function decide(record, { job, live, reviewRecords, now = Date.now() } = {}) {
  if (!isOpen(record)) return null;
  const age = now - (timeMs(record.at) ?? now);
  if (citedBy(record, reviewRecords)) {
    return { state: 'satisfied', note: 'the verdict was recorded on the card' };
  }
  if (!job) {
    if (age < MISSING_JOB_GRACE_MS) return null;
    return {
      state: 'failed',
      note: `Keep cannot find Codex job ${record.job}${record.accountId ? ` in account ${record.accountId}` : ''}`,
    };
  }
  const status = String(job.status || '').toLowerCase();
  if (status === 'completed') {
    return record.state === 'awaiting-verdict' ? null : { state: 'awaiting-verdict', note: 'the job finished; the verdict is not recorded yet' };
  }
  if (FAILED_STATUSES.has(status)) {
    return { state: 'failed', note: `Codex job ${record.job} ended ${status} without a verdict` };
  }
  if (live && live.state === 'dead') {
    return { state: 'failed', note: `Codex job ${record.job} is dead${live.reason ? ` (${live.reason})` : ''}` };
  }
  if (live && live.state === 'stalled' && Number(live.idleMs) > STALL_MS) {
    return { state: 'failed', note: `Codex job ${record.job} has been idle for ${Math.round(Number(live.idleMs) / 60e3)} minutes with no output` };
  }
  if (age > MAX_RUNNING_MS) {
    return { state: 'abandoned', note: `Codex job ${record.job} has been running for ${Math.round(age / 3600e3)}h with no verdict` };
  }
  return null;
}

function applied(record, decision, now = Date.now()) {
  return { ...record, state: decision.state, stateAt: new Date(now).toISOString(), note: String(decision.note || '').slice(0, NOTE_LIMIT) };
}

// ---------- what a settled obligation says on the card ----------

function range(record) {
  const shas = record.commits.map((commit) => String(commit.sha || '').slice(0, 12)).filter(Boolean);
  return shas.join(' ');
}

function checkin(record, decision) {
  const shas = range(record);
  const account = record.accountId ? ` --account ${record.accountId}` : '';
  if (decision.state === 'awaiting-verdict') {
    return {
      heading: 'review pending',
      message: `The review launched for ${shas || 'this card'} has finished but no verdict is recorded.`
        + ` Read it with \`keep codex${account} result ${record.job}\` and record it with`
        + ` \`keep reviewed ${record.card} --commit <range> --verdict clean|findings --job ${record.job}\`.`
        + ' Until then keep land refuses these commits.',
      linkSession: false,
      commitLabel: 'review',
    };
  }
  if (decision.state === 'failed' || decision.state === 'abandoned') {
    return {
      heading: 'review failed',
      message: `The review launched for ${shas || 'this card'} produced no verdict: ${decision.note}.`
        + ' Nothing was reviewed, so re-run it — a run that ends without a verdict is not a clean review.'
        + ` These commits still have no review record, which is what keep land refuses on.`,
      linkSession: false,
      commitLabel: 'review',
    };
  }
  return null;
}

// ---------- the daemon's sweep ----------

// Reads every card's obligations, asks the job what happened, writes the transition and
// its check-in. Everything that touches the outside world arrives through `deps`, so
// the sweep is testable without a Codex install.
function settle(deps = {}) {
  const root = deps.root || keep.ROOT;
  const now = deps.now || Date.now();
  const resolveJob = deps.resolveJob || ((id) => require('./reviews.js').resolveJob(id, { root }));
  const readReviews = deps.readReviews || ((id) => require('./reviews.js').readRecords(id, root));
  const checkinTask = deps.checkinTask || keep.checkinTask;
  const liveJobs = deps.liveJobs || new Map();
  const result = { considered: 0, settled: [], errors: [] };
  for (const id of deps.cards || cards(root)) {
    const records = readRecords(id, root);
    if (!records.some(isOpen)) continue;
    const reviewRecords = readReviews(id);
    const settled = new Map();
    for (const record of records) {
      if (!isOpen(record)) continue;
      result.considered += 1;
      let job = null;
      try { job = resolveJob(record.job); }
      catch (error) { result.errors.push(`${id}: ${error.message || error}`); continue; }
      const decision = decide(record, { job, live: liveJobs.get(record.job) || null, reviewRecords, now });
      if (!decision) continue;
      const landed = applied(record, decision, now);
      settled.set(record.id, landed);
      result.settled.push({ card: id, id: record.id, job: record.job, state: decision.state, note: decision.note });
      const entry = checkin(landed, decision);
      if (entry) {
        try { checkinTask(id, entry); }
        catch (error) { result.errors.push(`${id}: could not record the ${decision.state} review: ${error.message || error}`); }
      }
    }
    if (!settled.size) continue;
    // Re-read before writing and apply only the records this pass actually settled.
    // Resolving a job is file I/O, and a `keep reviewing` run in that window would
    // otherwise be overwritten by the copy this sweep started from.
    try {
      writeRecords(id, readRecords(id, root).map((record) => settled.get(record.id) || record), root);
    } catch (error) { result.errors.push(`${id}: could not write obligations: ${error.message || error}`); }
  }
  return result;
}

// `keep reviewed` closes the obligation the verdict answers, so the daemon never has to
// announce a review that a session already recorded by hand.
function settleFromRecord(id, review, root = keep.ROOT, now = Date.now()) {
  const records = readRecords(id, root);
  if (!records.some(isOpen)) return [];
  const closed = [];
  const next = records.map((record) => {
    if (!isOpen(record) || !citedBy(record, [review])) return record;
    const landed = applied(record, { state: 'satisfied', note: `verdict ${review.verdict} recorded as ${review.id}` }, now);
    closed.push(landed);
    return landed;
  });
  if (closed.length) writeRecords(id, next, root);
  return closed;
}

// ---------- the daemon's timer ----------

const TICK_MS = 5 * 60e3;

// The live view of the Codex jobs, keyed by id, so `decide` can tell a job that is
// working from one whose process is gone. A companion whose discovery is unknown or
// partial contributes nothing rather than a wrong answer: an obligation is only ever
// failed on evidence, and "I could not look" is not evidence.
function liveJobMap(report) {
  const map = new Map();
  if (!report || report.discovery !== 'ok' || !Array.isArray(report.jobs)) return map;
  for (const job of report.jobs) if (job && job.id) map.set(String(job.id), job);
  return map;
}

function startScheduler({ onChange = () => {}, companionSnapshot, health = require('./health.js'),
  settle: run = settle, setInterval: si = setInterval, setTimeout: st = setTimeout,
  write = (line) => process.stderr.write(line) } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      let liveJobs = new Map();
      if (companionSnapshot) {
        try { liveJobs = liveJobMap(await companionSnapshot()); }
        catch (error) { write(`keep review-obligations: companion snapshot unavailable: ${error.message}\n`); }
      }
      const result = run({ liveJobs });
      if (result.settled.length) {
        for (const entry of result.settled) {
          write(`keep review-obligations: ${entry.card} review ${entry.id} → ${entry.state} (${entry.note})\n`);
        }
        onChange();
      }
      health.record('review-obligations', result.errors.length
        ? { ok: false, cadenceMs: TICK_MS, error: result.errors.join('; ') }
        : { ok: true, cadenceMs: TICK_MS, skipped: !result.considered,
          detail: result.considered ? `${result.settled.length} settled of ${result.considered} pending` : 'nothing pending' });
    } catch (error) {
      health.record('review-obligations', { ok: false, cadenceMs: TICK_MS, error });
      write(`keep review-obligations: sweep failed: ${error.message}\n`);
    } finally {
      running = false;
    }
  };
  const timer = si(() => { void tick(); }, TICK_MS);
  timer?.unref?.();
  // A daemon that was down while a review finished should not wait out a full cadence
  // before the card learns about it.
  st(() => { void tick(); }, 45e3)?.unref?.();
  return { tick, timer };
}

function summaryLine(record) {
  const when = String(record.stateAt || record.at || '').replace('T', ' ').slice(0, 16);
  const who = record.by ? ` by ${record.by}` : '';
  const account = record.accountId ? ` (${record.accountId})` : '';
  return `${record.state} — job ${record.job}${account}${who}, ${record.commits.length} commit(s): ${range(record)}`
    + `\n  opened ${String(record.at || '').replace('T', ' ').slice(0, 16)}, ${record.state} at ${when}`
    + (record.note ? `\n  ${record.note}` : '')
    + `\n  record: ${record.id}`;
}

module.exports = {
  ObligationError, OPEN_STATES, TERMINAL_STATES, STATES,
  MISSING_JOB_GRACE_MS, MAX_RUNNING_MS, STALL_MS,
  obligationsDir, cardFile, readRecords, writeRecords, cards, recordId,
  open, append, isOpen, citedBy, samePatch, outstandingFor,
  decide, applied, checkin, settle, settleFromRecord, summaryLine,
  TICK_MS, liveJobMap, startScheduler,
};
