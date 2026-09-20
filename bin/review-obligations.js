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
// And one look is not a confirmed absence: resolveJob answers null for an unreadable
// directory or a half-written job file too, so a job has to be missing on three
// consecutive sweeps before Keep is willing to call the review dead.
const MISSING_JOB_CONFIRMATIONS = 3;
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

// A card with no obligations file has no obligations; a card whose file cannot be read
// is a card Keep does not know about, and that is not the same thing. Swallowing the
// second would fail open at exactly the moment it matters — an unreadable file would let
// a land through as if no review were outstanding — and an append built on `[]` would
// overwrite the history it could not read.
function readRecords(id, root = keep.ROOT) {
  let text;
  try { text = fs.readFileSync(cardFile(id, root), 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return [];
    fail(`cannot read the pending reviews for ${id}: ${error.message || error}`);
  }
  let value;
  try { value = JSON.parse(text); }
  catch (error) { fail(`the pending reviews for ${id} are not readable JSON: ${error.message || error}`); }
  if (!Array.isArray(value)) fail(`the pending reviews for ${id} are not a list`);
  return value.filter((record) => record && typeof record === 'object' && STATES.includes(record.state));
}

// Terminal records are history, and history does not need to be re-parsed by the daemon
// every five minutes forever. A card whose last record ages out loses its file entirely.
const HISTORY_RETENTION_MS = 30 * 24 * 3600e3;

function keptRecords(records, now = Date.now()) {
  return records.filter((record) => {
    if (isOpen(record)) return true;
    const at = timeMs(record.stateAt || record.at);
    return at === null || now - at <= HISTORY_RETENTION_MS;
  });
}

function writeRecords(id, records, root = keep.ROOT, now = Date.now()) {
  const file = cardFile(id, root);
  const kept = keptRecords(records, now);
  if (!kept.length) {
    try { fs.unlinkSync(file); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    return kept;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(kept, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  return kept;
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
function citedBy(record, reviewRecords, now = Date.now()) {
  const opened = timeMs(record.at) ?? now;
  return (reviewRecords || []).some((review) => {
    if (!review || !review.job || review.job !== record.job) return false;
    // A record written before this obligation existed cannot be its answer: the same
    // job id registered twice would otherwise arrive pre-satisfied.
    const at = timeMs(review.at);
    return at === null || at >= opened;
  });
}

function samePatch(a, b) {
  if (!a || !b) return false;
  if (a.patchId && b.patchId) return a.patchId === b.patchId;
  return Boolean(a.sha) && a.sha === b.sha;
}

// Outstanding *for this land*: an obligation whose verdict has not been recorded and
// whose commits are part of what would land. Scoped by patch id, the same identity
// `keep reviewed` uses, so a rebase does not lose track of it.
function outstandingFor(records, reviewRecords, commits, now = Date.now()) {
  const landing = commits || [];
  return (records || []).filter(isOpen)
    .filter((record) => !citedBy(record, reviewRecords, now) && !satisfiedByCoverage(record, reviewRecords, now))
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
// An independent review of exactly these patches, recorded after this obligation was
// opened and carrying a verified job of its own, answers the question this obligation
// asks even though it is not the job it named. Without this, a review re-run under a new
// job id leaves the first obligation blocking a card that has in fact been reviewed.
function satisfiedByCoverage(record, reviewRecords, now) {
  const opened = timeMs(record.at) ?? now;
  return (reviewRecords || []).some((review) => {
    if (!review || !String(review.jobAccountId || '').trim()) return false;
    if (review.job && review.job === record.job) return false; // citedBy already covers it
    if ((timeMs(review.at) ?? 0) < opened) return false;
    return record.commits.every((commit) => (review.commits || []).some((other) => samePatch(commit, other)));
  });
}

function decide(record, { job, jobUnknown = false, live, discovery = 'ok', reviewRecords, now = Date.now() } = {}) {
  if (!isOpen(record)) return null;
  // A record with no readable `at` is not young — it is undated. Reading it as "opened
  // just now" would keep it inside its own grace forever, counting a miss and rewriting
  // the file every five minutes for as long as the daemon runs.
  const openedAt = timeMs(record.at) ?? timeMs(record.stateAt);
  const age = openedAt === null ? Infinity : now - openedAt;
  const sinceState = now - (timeMs(record.stateAt || record.at) ?? now);
  const touch = (misses) => (Number(record.misses) || 0) === misses
    ? null
    : { state: record.state, misses, note: record.note || '' };
  if (citedBy(record, reviewRecords, now)) {
    return { state: 'satisfied', note: 'the verdict was recorded on the card' };
  }
  if (satisfiedByCoverage(record, reviewRecords, now)) {
    return { state: 'satisfied', note: 'an independent review of the same patches was recorded under another job' };
  }
  // An obligation whose verdict nobody ever records must still end. Six hours after Keep
  // said the job had finished, the session that was going to read it is not coming back.
  const stopWaiting = (why) => ({ state: 'abandoned', note: why });
  if (record.state === 'awaiting-verdict' && sinceState > MAX_RUNNING_MS) {
    return stopWaiting(`Codex job ${record.job} finished ${Math.round(sinceState / 3600e3)}h ago and no verdict was ever recorded`);
  }
  // "I could not look" is never evidence that the job is gone. Three separate readers
  // can each fail to see it: the companion's discovery, the jobs directory, and the job
  // file itself. A live row for this job is the strongest of them — if the companion can
  // see the process, an unreadable job file says nothing about whether it is running.
  const cannotTell = jobUnknown || (!job && discovery !== 'ok') || (!job && live);
  if (cannotTell) {
    return age > MAX_RUNNING_MS
      ? stopWaiting(`Keep has not been able to see Codex job ${record.job} for ${Math.round(age / 3600e3)}h`)
      : touch(Number(record.misses) || 0);
  }
  if (!job) {
    const misses = (Number(record.misses) || 0) + 1;
    if (age < MISSING_JOB_GRACE_MS || misses < MISSING_JOB_CONFIRMATIONS) {
      return { state: record.state, misses, note: record.note || '' };
    }
    return {
      state: 'failed',
      note: `Keep cannot find Codex job ${record.job}${record.accountId ? ` in account ${record.accountId}` : ''}`,
    };
  }
  // The job answered. Whatever it says, the misses a failed read counted are stale —
  // cleared on every path from here, so three *non-consecutive* failures can never add
  // up to a confirmed absence.
  const status = String(job.status || '').toLowerCase();
  if (status === 'completed') {
    return record.state === 'awaiting-verdict'
      ? touch(0)
      : { state: 'awaiting-verdict', note: 'the job finished; the verdict is not recorded yet' };
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
    return stopWaiting(`Codex job ${record.job} has been running for ${Math.round(age / 3600e3)}h with no verdict`);
  }
  return touch(0);
}

// A decision that does not change the state is a touch — a miss counted, or one
// cleared. It keeps `stateAt`, so the abandonment clocks measure what they are named
// after rather than restarting on every sweep.
function applied(record, decision, now = Date.now()) {
  const moved = decision.state !== record.state;
  const next = {
    ...record,
    state: decision.state,
    stateAt: moved ? new Date(now).toISOString() : (record.stateAt || new Date(now).toISOString()),
    note: String(decision.note || '').slice(0, NOTE_LIMIT),
  };
  if (decision.misses) next.misses = decision.misses;
  else delete next.misses;
  // A transition that earns a check-in owes one until one lands. Without this, a
  // registry lock held at the wrong moment — or a crash between the write and the
  // commit — loses the announcement for good, because the record is already in the
  // state the next sweep would skip. A transition that earns none clears the debt.
  if (moved) {
    if (checkin(next, decision)) next.announce = true;
    else delete next.announce;
  }
  return next;
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
// What a record looked like when this pass read it. A write only replaces a record that
// still looks exactly like this: a `keep reviewing --drop` that landed in the window owns
// its record, and must not be overwritten by a state it has already moved past.
function basisOf(record) {
  return { state: record.state, stateAt: record.stateAt || '', misses: Number(record.misses) || 0 };
}

function sameBasis(record, basis) {
  if (!basis) return false;
  const now = basisOf(record);
  return now.state === basis.state && now.stateAt === basis.stateAt && now.misses === basis.misses;
}

function settle(deps = {}) {
  const root = deps.root || keep.ROOT;
  const now = deps.now || Date.now();
  const resolveJob = deps.resolveJob || ((id) => require('./reviews.js').resolveJob(id, { root }));
  const readReviews = deps.readReviews || ((id) => require('./reviews.js').readRecords(id, root));
  const checkinTask = deps.checkinTask || keep.checkinTask;
  const withLock = deps.withLock || keep.withLock;
  const liveJobs = deps.liveJobs || new Map();
  const discovery = deps.discovery || 'ok';
  const result = { considered: 0, settled: [], announced: 0, errors: [] };

  // One locked read-modify-write for a card, applying `change` only to records that are
  // still exactly as this pass saw them. Every writer of this file goes through the
  // registry lock — the CLI's append and drop included — so the last rename carries
  // everyone's work rather than the copy its own writer started from.
  const commit = (id, basis, change) => {
    const touched = new Set();
    withLock(() => {
      writeRecords(id, readRecords(id, root).map((record) => {
        if (!sameBasis(record, basis.get(record.id))) return record;
        const next = change(record);
        if (!next || next === record) return record;
        touched.add(record.id);
        return next;
      }), root, now);
    });
    return touched;
  };

  for (const id of deps.cards || cards(root)) {
    let records;
    try { records = readRecords(id, root); }
    catch (error) { result.errors.push(`${id}: ${error.message || error}`); continue; }

    // Check-ins this card still owes: from this pass, or from any earlier one whose
    // announcement never landed. Retried until one does, which is what makes delivery
    // durable rather than at-most-once.
    const owed = new Map(records.filter((record) => record.announce === true).map((record) => [record.id, record]));

    if (records.some(isOpen)) {
      let reviewRecords = [];
      try { reviewRecords = readReviews(id); }
      catch (error) { result.errors.push(`${id}: could not read the review records: ${error.message || error}`); continue; }

      const settled = new Map();
      const basis = new Map();
      for (const record of records) {
        if (!isOpen(record)) continue;
        result.considered += 1;
        let job = null;
        let jobUnknown = false;
        try { job = resolveJob(record.job); }
        catch (error) {
          // The jobs directory would not answer. That is not the job's absence, and it
          // is not a reason to skip the decisions that do not depend on it either.
          jobUnknown = true;
          result.errors.push(`${id}: could not resolve job ${record.job}: ${error.message || error}`);
        }
        const decision = decide(record, {
          job, jobUnknown, discovery, live: liveJobs.get(record.job) || null, reviewRecords, now,
        });
        if (!decision) continue;
        settled.set(record.id, { next: applied(record, decision, now), moved: decision.state !== record.state });
        basis.set(record.id, basisOf(record));
      }
      if (settled.size) {
        let written;
        try { written = commit(id, basis, (record) => (settled.get(record.id) || {}).next); }
        catch (error) {
          result.errors.push(`${id}: could not write obligations: ${error.message || error}`);
          continue;
        }
        for (const [recordId, { next, moved }] of settled) {
          if (!written.has(recordId)) continue;
          if (!moved) { if (!next.announce) owed.delete(recordId); continue; }
          result.settled.push({ card: id, id: recordId, job: next.job, state: next.state, note: next.note });
          if (next.announce) owed.set(recordId, next);
          else owed.delete(recordId);
        }
      }
    } else if (!owed.size && keptRecords(records, now).length !== records.length) {
      // A card whose obligations are all terminal still has to age out. Nothing else
      // would ever call writeRecords for it, so its file would sit on the sweep's scan
      // path forever; this is the only path that retires one.
      try { withLock(() => writeRecords(id, readRecords(id, root), root, now)); }
      catch (error) { result.errors.push(`${id}: could not prune obligations: ${error.message || error}`); }
    }

    for (const record of owed.values()) {
      const entry = checkin(record, { state: record.state, note: record.note });
      if (entry) {
        try { checkinTask(id, entry); }
        catch (error) {
          result.errors.push(`${id}: could not record the ${record.state} review: ${error.message || error}`);
          continue;
        }
        result.announced += 1;
      }
      // Clear the debt only once the commit is on the card, and only if the record has
      // not moved since: a retry must never resurrect a state somebody else changed.
      try { commit(id, new Map([[record.id, basisOf(record)]]), (current) => { const { announce, ...rest } = current; return rest; }); }
      catch (error) { result.errors.push(`${id}: could not clear the announcement for ${record.id}: ${error.message || error}`); }
    }
  }
  return result;
}

// `keep reviewed` closes the obligation the verdict answers, so the daemon never has to
// announce a review that a session already recorded by hand.
function settleFromRecord(id, review, root = keep.ROOT, now = Date.now(), deps = {}) {
  const withLock = deps.withLock || keep.withLock;
  const closed = [];
  withLock(() => {
    const records = readRecords(id, root);
    if (!records.some(isOpen)) return;
    const next = records.map((record) => {
      if (!isOpen(record) || !citedBy(record, [review])) return record;
      const landed = applied(record, { state: 'satisfied', note: `verdict ${review.verdict} recorded as ${review.id}` }, now);
      closed.push(landed);
      return landed;
    });
    if (closed.length) writeRecords(id, next, root, now);
  });
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
      // Unknown discovery is what stops the sweep failing a live obligation because the
      // companion could not be read this time; it is not a reason to skip the sweep,
      // which still settles verdicts that were recorded and reviews nobody answered.
      let discovery = 'unknown';
      if (companionSnapshot) {
        try {
          const report = await companionSnapshot();
          liveJobs = liveJobMap(report);
          discovery = report && report.discovery ? String(report.discovery) : 'unknown';
        } catch (error) { write(`keep review-obligations: companion snapshot unavailable: ${error.message}\n`); }
      }
      const result = run({ liveJobs, discovery });
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
  decide, applied, checkin, settle, settleFromRecord, summaryLine, satisfiedByCoverage,
  keptRecords, basisOf, sameBasis, HISTORY_RETENTION_MS, MISSING_JOB_CONFIRMATIONS,
  TICK_MS, liveJobMap, startScheduler,
};
