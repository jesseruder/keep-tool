'use strict';

// In-flight records past their maximum age.
//
// Keep leaves durable records under <registry>/.keep for every operation that has to
// survive a daemon restart while it waits for something: a delivery journal waits for
// its transcript receipt, an account transfer for the continuation to land, a
// compaction swap for its model to be restored, a review obligation for its verdict.
// Each has its own sweep that finishes the record when the event arrives. What none
// of them had was an answer for the event that never comes. On 2026-09-24 an account
// transfer sat in `recovery-needed` for fourteen hours (re-running `keep handoff` was
// the whole fix), and a delivery journal typed into a live pane whose box was later
// cleared was retried 2,894 times over two days. Both were visible, in a sense — the
// delivery row was red the whole time — but nobody was told what to do about them.
//
// So every kind gets a maximum age, chosen from how long the operation legitimately
// takes, and a record past it is escalated exactly once: a row in `keep stalled`, a
// failing `inflight` health row, and one Keep card naming each record, its age, what
// it is waiting for and the command that resolves it. The card is re-used while it is
// open and gets a check-in only when the set of records changes, never per tick.
//
// Escalation only. Nothing here mutates, settles, retires or deletes a record: the
// rules that decide when one may be retired (delivery.js reconcile's "a typed
// journal on a live pane is never retired automatically", the handoff recovery that
// must not type a continuation twice) belong to their owners, and a watchdog that
// second-guessed them would reintroduce exactly the double deliveries those rules
// exist to prevent. It also never asks a pane, a node or a transcript anything. A
// record for a session on another node may be unknowable right now, and "I could not
// tell" is not "stuck"; the age here comes from the record's own timestamps (its file
// mtime only when it carries none), so an unreachable node delays nothing and
// escalates nothing that is not old by its own account.
//
// Runs inside the stalled sweep (bin/serve/schedulers.js), once a minute. Every read
// is asynchronous and bounded by a directory listing plus one small JSON file per
// record; nothing walks a tree. Card writes go through keep.addTask/checkinTask,
// which hold the registry lock synchronously as every daemon card writer does, and
// happen only when the set of stuck records changes.

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const MINUTE_MS = 60e3;
const HOUR_MS = 60 * MINUTE_MS;
const HEALTH_NAME = 'inflight';
const CARD_TITLE = 'Keep: in-flight records past their max age';
const CARD_PROJECT = '~/keep-tool';
// A record file larger than this is not one of these small state records; it is
// skipped rather than parsed on the daemon's loop.
const MAX_RECORD_BYTES = 256 * 1024;

function rootOf(options = {}) {
  return options.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
}

function keepDir(options = {}) { return path.join(rootOf(options), '.keep'); }

function stateFile(options = {}) { return path.join(keepDir(options), 'stalled', 'inflight.json'); }

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Milliseconds from an epoch number or an ISO string; 0 when neither.
function timeMs(value) {
  if (value == null || value === '') return 0;
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// The latest of a record's own timestamps: the last time its owner wrote progress.
// The age is measured from there, so an operation that is still moving (a handoff
// that advanced a phase, a journal retyped) is not called stuck for having started
// long ago.
function latest(...values) {
  return Math.max(0, ...values.map(timeMs));
}

function duration(ms) {
  const value = Math.max(0, number(ms));
  if (value < 90e3) return `${Math.round(value / 1000)}s`;
  if (value < 90 * 60e3) return `${Math.round(value / 60e3)}m`;
  if (value < 36 * 3600e3) return `${Math.round(value / 3600e3)}h`;
  return `${Math.round(value / 86400e3)}d`;
}

function short(id) {
  const value = String(id || '');
  return value.length > 12 ? value.slice(0, 8) : value;
}

// Attention ids and console acks accept [A-Za-z0-9._:-] only (bin/serve/routes.js).
function safeId(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 160) || 'unknown';
}

function envMinutes(name, fallbackMs) {
  const minutes = Number(process.env[name]);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * MINUTE_MS : fallbackMs;
}

// ---------- the kinds ----------
//
// Each kind names its directory, which files in it are records, its maximum age, and
// a describe() that answers null for a record that is finished (or not one of this
// kind's in-flight states) and otherwise what it is waiting for and what resolves it.
// `since` is the record's own last-progress time; describe() falls back to the file's
// mtime only when the record carries no timestamp at all.

const json = (name) => name.endsWith('.json');

// Delivery journals, .keep/delivery/<sha256(session)>.json (bin/delivery.js). A
// journal is in flight for as long as it is in the top directory: a receipt moves it
// to settled/ or deletes it. A normal one settles inside a minute; reconcile expires
// an untyped one at 15 minutes and retires a typed one whose pane is gone. What it
// never retires is a typed journal on a live pane, or one on a node that did not
// answer, and those can sit for days (one was retried 2,894 times over two days,
// found 2026-09-24, its pane alive and its box long since cleared).
// Two hours is well past every automatic path, so what is left is a person's call.
// Aged from createdAt: a fresh send makes a fresh journal.
function deliveryStage(entry) {
  if (Number(entry.typedAt) > 0) return 'Enter pressed, no transcript receipt';
  const typing = entry.typing && typeof entry.typing === 'object' ? entry.typing : null;
  if (typing && Number(typing.acknowledgedChunks) >= Number(typing.chunkCount) && Number(typing.chunkCount) > 0
      && !Number.isInteger(typing.inFlightChunk)) return 'typed, Enter not confirmed';
  if (typing && (Number.isInteger(typing.inFlightChunk) || Number(typing.acknowledgedChunks) > 0)) return 'partially typed';
  return 'nothing typed yet';
}

const KINDS = [
  {
    kind: 'delivery',
    dir: 'delivery',
    match: (name) => /^[a-f0-9]{64}\.json$/.test(name),
    maxAgeMs: () => envMinutes('KEEP_INFLIGHT_DELIVERY_MIN', 2 * HOUR_MS),
    describe(entry) {
      if (!entry.sessionId) return null;
      const stage = deliveryStage(entry);
      return {
        id: entry.sessionId,
        state: stage,
        since: entry.createdAt,
        sessionId: entry.sessionId,
        pane: entry.pane,
        node: entry.node,
        waitingFor: entry.node ? `the transcript receipt from node ${entry.node}` : 'its transcript receipt',
        resolve: `keep pane screen ${entry.pane || '<pane>'}: if the text is still in the input box, submit or clear it there; `
          + (stage === 'partially typed'
            ? 'once the box is empty, the next send to the session retires this record and types its own message whole'
            : 'an unconfirmed keep tell is recovered by re-running the byte-identical tell, which settles the journal'),
      };
    },
  },
  // Account transfers, .keep/account-handoffs/<session>.json (bin/account-handoff.js).
  // Records are never deleted; `done` and `failed` are terminal (failed/preflight only
  // resumes if someone retries it). The working statuses and `recovery-needed` wait for
  // the transfer to be driven again. A live transfer's own timeouts all end inside 15
  // minutes (WORKING_GRACE_MS), and across thirty completed transfers the slowest took
  // 16; a `recovery-needed` record is waiting for a retry that the daemon only makes
  // on its own for rate-limit handoffs. Thirty minutes from the last phase write
  // (updatedAt, stamped on every write) leaves both room. On 2026-09-24 one sat in
  // recovery-needed/delivering-continuation for fourteen hours: the source stopped,
  // the continuation never delivered, the session half-moved.
  //
  // A transfer refused before its source ever stopped (account-handoff.js
  // abandonCandidate) is a different animal: the session never left its account and
  // kept working there, so nothing is half-moved. The record still waits for a Retry
  // or an Abandon that nobody gives, and the console keeps offering both, so it is
  // named too, but after a day rather than half an hour, with Abandon as the answer.
  {
    kind: 'account-handoff',
    dir: 'account-handoffs',
    match: json,
    maxAgeMs: () => envMinutes('KEEP_INFLIGHT_HANDOFF_MIN', 30 * MINUTE_MS),
    describe(entry) {
      const inFlight = ['stopping', 'copying', 'starting', 'verifying', 'delivering', 'staged', 'recovery-needed'];
      if (!inFlight.includes(entry.status) || !entry.sessionId) return null;
      const target = entry.targetAccountId || '<account>';
      const since = latest(entry.updatedAt);
      // Asked as of a moment past the working grace, so a `stopping` record reads the
      // way it will once it is old enough to matter here.
      let neverLeft = false;
      let exitedOk = false;
      try {
        const handoff = require('./account-handoff.js');
        neverLeft = handoff.abandonCandidate(entry, since + 16 * MINUTE_MS);
        exitedOk = !neverLeft && handoff.exitedAbandonCandidate(entry, since + 16 * MINUTE_MS);
      } catch {}
      const retry = `keep handoff ${entry.sessionId} --pane ${entry.pane || '<pane>'} --account ${target}`;
      return {
        id: entry.sessionId,
        state: `${entry.status}${entry.phase ? `/${entry.phase}` : ''}`,
        since,
        ...(neverLeft ? { maxAgeMs: envMinutes('KEEP_INFLIGHT_HANDOFF_REFUSED_MIN', 24 * HOUR_MS) } : {}),
        sessionId: entry.sessionId,
        pane: entry.pane,
        waitingFor: entry.status === 'recovery-needed' || neverLeft
          ? `a retry of the transfer to ${target}${entry.reason ? ` (${String(entry.reason).slice(0, 120)})` : ''}`
          : `the ${entry.phase || entry.status} step of the transfer to ${target}`,
        resolve: neverLeft
          ? `the source never stopped, so the session is still on ${entry.sourceAccountId || 'its account'}: `
            + `Abandon it in the console (or retry: ${retry})`
          : exitedOk
            ? `if the session has exited, Abandon it in the console (Keep checks the exit first); otherwise ${retry}`
            : `${retry} (it is past the point where Abandon is safe; only a retry finishes it)`,
      };
    },
  },
  // The handoff queue, .keep/handoff-queue/<session>.json (bin/handoff-queue.js).
  // `queued` is the only in-flight status: the queue's own tick parks an entry once it
  // has been enqueued for KEEP_HANDOFF_QUEUE_MAX_MIN (45 by default), and parked, moved
  // and cancelled are decisions it has made. The max age is twice that cap, read from
  // the queue itself so the two cannot drift: a `queued` entry older than that is one
  // the tick has stopped reaching, and the queue never collects a queued entry itself.
  {
    kind: 'handoff-queue',
    dir: 'handoff-queue',
    match: json,
    maxAgeMs: () => {
      let capMs = 45 * MINUTE_MS;
      try { capMs = require('./handoff-queue.js').maxMinutes() * MINUTE_MS; } catch {}
      return envMinutes('KEEP_INFLIGHT_HANDOFF_QUEUE_MIN', Math.max(2 * capMs, 30 * MINUTE_MS));
    },
    describe(entry) {
      if (entry.status !== 'queued' || !entry.sessionId) return null;
      return {
        id: entry.sessionId,
        state: `queued (${number(entry.attempts)} attempts)`,
        since: latest(entry.enqueuedAt),
        sessionId: entry.sessionId,
        pane: entry.pane,
        waitingFor: `the handoff-queue tick to move it to ${entry.targetAccountId || 'its target account'} or park it`,
        resolve: 'keep health (the handoff-queue row); cancel or retry it from the console, or run '
          + `keep handoff ${entry.sessionId} --pane ${entry.pane || '<pane>'} --account ${entry.targetAccountId || '<account>'}`,
      };
    },
  },
  // Session moves between nodes, .keep/session-moves/mv-<hex>.json (bin/session-move.js).
  // In flight until done/abandoned; finished records are pruned, in-flight ones never
  // are. Completed moves took up to eighteen minutes and the CLI waits thirty, so an
  // hour since the last write is a move nothing is driving. The record names both
  // nodes; its age is its own updatedAt, so an unreachable node changes nothing here.
  {
    kind: 'session-move',
    dir: 'session-moves',
    match: (name) => /^mv-[a-f0-9]{24}\.json$/.test(name),
    maxAgeMs: () => envMinutes('KEEP_INFLIGHT_MOVE_MIN', HOUR_MS),
    describe(entry) {
      const inFlight = ['stopping', 'copying', 'staged', 'pinned', 'starting', 'verifying', 'recovery-needed'];
      if (!inFlight.includes(entry.status) || !entry.id) return null;
      return {
        id: entry.id,
        state: `${entry.status}${entry.phase ? `/${entry.phase}` : ''}`,
        since: latest(entry.updatedAt, entry.createdAt),
        sessionId: entry.sessionId,
        node: [entry.from, entry.to].filter(Boolean).join('->'),
        waitingFor: entry.status === 'recovery-needed'
          ? `recovery of the move${entry.reason ? ` (${String(entry.reason).slice(0, 120)})` : ''}`
          : `the ${entry.status} step of the move from ${entry.from || '?'} to ${entry.to || '?'}`,
        resolve: `keep move --recover ${entry.id} (or keep move --abandon ${entry.id})`,
      };
    },
  },
  // Portable (cross-agent) transfers, .keep/portable-transfers/<key>.json
  // (bin/portable-handoff.js). Only `done` is terminal and nothing deletes a record.
  // A launch binds its destination in seconds, so an hour without progress is stuck;
  // `awaiting-setup` waits on a person setting up the target account and gets six.
  {
    kind: 'portable-transfer',
    dir: 'portable-transfers',
    match: (name) => /^[a-f0-9]{64}\.json$/.test(name),
    maxAgeMs: () => envMinutes('KEEP_INFLIGHT_TRANSFER_MIN', HOUR_MS),
    describe(entry) {
      if (!['prepared', 'launching', 'awaiting-setup', 'ambiguous'].includes(entry.status)) return null;
      const opening = entry.opening && typeof entry.opening === 'object' ? entry.opening : {};
      const source = entry.sourceSessionId || '<session>';
      const target = entry.targetAccountId || '<account>';
      return {
        id: entry.requestKey || source,
        state: entry.status,
        since: latest(entry.preparedAt, entry.launchStartedAt, entry.launchBoundAt, entry.updatedAt, opening.deliveryStartedAt),
        ...(entry.status === 'awaiting-setup' ? { maxAgeMs: envMinutes('KEEP_INFLIGHT_TRANSFER_SETUP_MIN', 6 * HOUR_MS) } : {}),
        sessionId: entry.sourceSessionId,
        pane: entry.destinationPane,
        waitingFor: entry.status === 'awaiting-setup' ? `${entry.setupKind || 'account'} setup on ${target}`
          : entry.status === 'ambiguous' ? 'a person to say which session the transfer opened'
            : `the transfer from ${source} to ${target} to launch and bind its destination`,
        resolve: entry.status === 'ambiguous' || entry.status === 'launching'
          ? `keep transfer ${source} --account ${target} --context <file> --resolve-session <destination session>`
          : `re-run keep transfer ${source} --account ${target} --context <file> once the target is ready`,
      };
    },
  },
  // Compaction model swaps, .keep/compact/<session>.swap.json (bin/serve.js for Claude,
  // bin/codex-compact.js for Codex). A compaction takes one to three minutes and the
  // restore follows at once. The Claude record is retried every ten minutes and dropped
  // unrestored after 24 hours; the Codex record never expires, and one whose session
  // exited never clears. Aged from the last point it became due (the swap, or the end
  // of a deferral), never from the retry stamps, which move every ten minutes whether
  // or not anything is working. keep-ops says it: report one, never delete it.
  {
    kind: 'compact-swap',
    dir: 'compact',
    match: (name) => name.endsWith('.swap.json'),
    maxAgeMs: () => envMinutes('KEEP_INFLIGHT_COMPACT_MIN', 2 * HOUR_MS),
    describe(entry) {
      if (!entry.sessionId) return null;
      if (entry.kind === 'codex') {
        const original = entry.original && typeof entry.original === 'object' ? entry.original : {};
        return {
          id: entry.sessionId,
          state: `codex ${entry.phase || 'pending'}`,
          since: latest(entry.at, entry.switchedAt, entry.restorePreparedAt),
          sessionId: entry.sessionId,
          waitingFor: `the Codex model restore to ${original.model || 'the original model'}${original.effort ? ` (${original.effort})` : ''}`,
          resolve: `keep pane screen for session ${entry.sessionId}; if it exited the record cannot clear by itself: `
            + 'restore the model in its account config and report it (never delete the record)',
        };
      }
      return {
        id: entry.sessionId,
        state: entry.restoreDeferredReason ? `deferred (${entry.restoreDeferredReason})` : 'restore pending',
        since: latest(entry.at, entry.restoreExpiryFrom, entry.restoreDeferredUntil),
        // The restore pass drops it unrestored a day after this (KEEP_COMPACT_SWAP_MAX_AGE_MIN).
        expiresAfterMs: 24 * HOUR_MS,
        sessionId: entry.sessionId,
        waitingFor: `the model restore ${entry.restoreCommand || 'to the original model'}`,
        resolve: `type ${entry.restoreCommand || '/model <original>'} in the session's pane if it is alive; `
          + 'the daemon removes the record once it confirms the restore (never delete it by hand)',
      };
    },
  },
  // The registry lock, .keep/lock/owner.json (bin/keep-core.js acquireLock). Held for
  // one registry write, milliseconds to a few seconds. A lock over a minute old whose
  // owner is dead is reclaimed by the next acquire; one whose owner is alive is never
  // reclaimed, and every other writer gives up after five seconds. Ten minutes is a
  // live process holding it and doing nothing.
  {
    kind: 'registry-lock',
    dir: 'lock',
    match: (name) => name === 'owner.json',
    maxAgeMs: () => envMinutes('KEEP_INFLIGHT_LOCK_MIN', 10 * MINUTE_MS),
    describe(entry) {
      return {
        id: `pid-${number(entry.pid)}`,
        state: 'held',
        since: 0,
        waitingFor: `pid ${number(entry.pid)} to release the registry lock`,
        resolve: `ps -p ${number(entry.pid)} -o pid,etime,command: a hung keep process holding it is stopped by you; `
          + 'a dead owner\'s lock is reclaimed by the next write on its own',
      };
    },
  },
  // Worktree recreations, .keep/worktree-recreations/<hash>.json (bin/serve.js). Written
  // before wt recreates a recycled worktree and removed when it succeeds; a leftover one
  // refuses every open in that project. A recreation installs deps in about thirty
  // seconds, five minutes at worst.
  {
    kind: 'worktree-recreation',
    dir: 'worktree-recreations',
    match: json,
    maxAgeMs: () => envMinutes('KEEP_INFLIGHT_WORKTREE_MIN', 30 * MINUTE_MS),
    describe(entry) {
      if (!entry.project) return null;
      return {
        id: path.basename(String(entry.project)),
        state: 'recreating',
        since: latest(entry.startedAt),
        waitingFor: `wt to finish recreating ${entry.project}; opens there are refused until it does`,
        resolve: `inspect ${entry.project}; if the recreation died, wt rm --force --delete ${entry.project} and open the session again`,
      };
    },
  },
  // Pi opening messages, .keep/pi-opening/<session>-<uuid>.txt (bin/launch-prep.js).
  // The Pi extension deletes its file when the session starts, seconds after the
  // launch; nothing else ever does. Plain text, so its age is the file's mtime. A file
  // still here means that launch never started Pi, and nothing will ever read it: a
  // new launch writes a new file. So the answer is not "open it again" (that leaves
  // this one where it is) but to read it, relaunch if the work still matters, and then
  // remove the file by hand; Keep never removes it.
  {
    kind: 'pi-opening',
    dir: 'pi-opening',
    match: (name) => name.endsWith('.txt'),
    text: true,
    maxAgeMs: () => envMinutes('KEEP_INFLIGHT_PI_OPENING_MIN', 30 * MINUTE_MS),
    describe(entry, record) {
      const id = record.name.replace(/\.txt$/, '');
      const sessionId = id.replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, '');
      return {
        id,
        state: 'opening not read',
        since: 0,
        sessionId,
        waitingFor: 'a Pi session that never started to read its opening message',
        resolve: `read ${record.file ? path.basename(record.file) : 'the file'} (the opening Pi never received); `
          + 'relaunch the work if it still matters, then remove the file by hand: nothing else will',
      };
    },
  },
  // Review obligations, .keep/review-obligations/<card>.json (bin/review-obligations.js),
  // an array per card. `open` and `awaiting-verdict` wait for a verdict. The sweep
  // abandons a local one six hours after it opened or after the job finished
  // (MAX_RUNNING_MS), but one opened from another node never times out there: it has
  // no local job to watch. Eight hours is past the local ceiling, so this names the
  // node-opened ones and any the sweep has stopped reaching; the age is the record's
  // own `at`/`stateAt`, never a guess about the remote job. It blocks the implicit land.
  {
    kind: 'review-obligation',
    dir: 'review-obligations',
    match: json,
    maxAgeMs: () => envMinutes('KEEP_INFLIGHT_REVIEW_MIN', 8 * HOUR_MS),
    describe(entry, record) {
      if (!Array.isArray(entry)) return null;
      const card = record.name.replace(/\.json$/, '');
      return entry.filter((item) => item && ['open', 'awaiting-verdict'].includes(item.state) && item.id).map((item) => ({
        id: item.id,
        state: item.state,
        since: item.state === 'awaiting-verdict' ? latest(item.stateAt, item.at) : latest(item.at),
        sessionId: item.session && item.session.sessionId,
        node: item.node,
        waitingFor: `a verdict on ${card} from ${item.by || 'the reviewer'}${item.job ? ` (job ${item.job})` : ''}`,
        resolve: `keep reviewed ${card} --job ${item.job || '<job>'} --verdict <verdict>, `
          + `or keep reviewing ${card} --drop ${item.id} -m "why"`,
      }));
    },
  },
  // Unblock records (.keep/unblocked, bin/unblock.js) are deliberately not a kind.
  // resolvedAt is stamped when the record's own upstream resolves, even while the
  // dependent still waits on other upstreams, a check_after or an open need, and
  // telling those apart means loading every upstream card and asking
  // keep.dependencyResolved of each: the unblock sweep's own work, not a watchdog's.
  // And the one wait that is not legitimate, a deliverable record nobody delivered, is
  // already bounded there (given up a day after creation or after twelve tries, then
  // surfaced as an `unblocked` attention row). A stuck unblock sweep is its health row.
  // The session restart queue, .keep/session-restarts.json (bin/session-restart.js),
  // one array. `restarting` waits for the restart to finish, `recovery-needed` for
  // someone to recover an interrupted forced restart, and a `queued` now/force entry
  // runs at once. A restart takes a minute. A `queued` idle-mode entry is left out: it
  // waits for the session to stop working, keeps its original `at` while refused as
  // busy, and a session busy for an afternoon is not a stuck restart.
  {
    kind: 'session-restart',
    dir: '.',
    match: (name) => name === 'session-restarts.json',
    maxAgeMs: () => envMinutes('KEEP_INFLIGHT_RESTART_MIN', 2 * HOUR_MS),
    describe(entry) {
      if (!Array.isArray(entry)) return null;
      return entry.filter((item) => item && item.sessionId
        && (['restarting', 'recovery-needed'].includes(item.status) || item.status === 'queued' && item.mode !== 'idle'))
        .map((item) => ({
          id: item.sessionId,
          state: `${item.status} (${item.mode || 'now'})`,
          since: latest(item.at),
          sessionId: item.sessionId,
          pane: item.pane,
          waitingFor: item.status === 'queued' ? 'the restart queue to run it'
            : item.status === 'restarting' ? 'the restart to finish' : 'recovery of an interrupted forced restart',
          resolve: item.status === 'recovery-needed'
            ? `keep force-restart ${item.sessionId} --pane ${item.pane || '<pane>'} --recover (needs Owner's approval)`
            : `keep pane screen ${item.pane || '<pane>'}; cancel or retry the restart from the console`,
        }));
    },
  },
  // Pi jobs, .keep/pi-jobs/<id>/job.json (bin/pi-jobs.js). `queued`, `running` and
  // `cancelling` are active; reconcile marks a job failed when its runner dies, but
  // only when something reads it, and a runner that is alive and hung is never
  // capped. Twelve hours since its last write is well past a delegated task.
  {
    kind: 'pi-job',
    dir: 'pi-jobs',
    match: (name) => /^[a-f0-9]{24}$/.test(name),
    nested: 'job.json',
    maxAgeMs: () => envMinutes('KEEP_INFLIGHT_PI_JOB_MIN', 12 * HOUR_MS),
    describe(entry, record) {
      if (!['queued', 'running', 'cancelling'].includes(entry.status)) return null;
      const id = entry.id || path.dirname(record.name);
      return {
        id,
        state: entry.status,
        since: latest(entry.updatedAt, entry.startedAt, entry.createdAt, entry.cancelRequestedAt),
        sessionId: entry.parentSession,
        waitingFor: `Pi job ${id}${entry.card ? ` for ${entry.card}` : ''} to finish`,
        resolve: `keep pi (to see it), then keep pi cancel ${id} if its runner is hung`,
      };
    },
  },
  // Probe check-ins that failed to land, .keep/runs/*.pending.json (bin/runs.js).
  // retryPending lands one on the next tick; one that keeps failing is retried every
  // minute with no cap and only a stderr line. It carries no timestamp: its age is
  // the file's.
  {
    kind: 'pending-checkin',
    dir: 'runs',
    match: (name) => name.endsWith('.pending.json'),
    maxAgeMs: () => envMinutes('KEEP_INFLIGHT_PENDING_CHECKIN_MIN', HOUR_MS),
    describe(entry, record) {
      return {
        id: record.name.replace(/\.pending\.json$/, ''),
        state: 'check-in not landed',
        since: 0,
        waitingFor: `the check-in for ${entry.taskId || 'its card'} to land on the card`,
        resolve: `grep "pending check-in" .keep/serve.log for why it fails; keep show ${entry.taskId || '<card>'} `
          + '(a card that was renamed, archived or deleted never takes it)',
      };
    },
  },
  // Codex launches on another node awaiting adoption, .keep/node-codex-launches/<hash>.json
  // (bin/late-adoption.js). Consumed as soon as the session is known, normally within
  // a minute; ignored after 24 hours, which silently leaves the session untracked.
  {
    kind: 'node-codex-launch',
    dir: 'node-codex-launches',
    match: json,
    maxAgeMs: () => envMinutes('KEEP_INFLIGHT_NODE_LAUNCH_MIN', 2 * HOUR_MS),
    describe(entry, record) {
      return {
        id: record.name.replace(/\.json$/, '').slice(0, 16),
        state: 'awaiting adoption',
        since: latest(entry.launchedAt, entry.at),
        // late-adoption.js unlinks it by mtime a day on; gone after that is not adopted.
        expiresAfterMs: 24 * HOUR_MS,
        node: entry.node,
        pane: entry.pane,
        waitingFor: `the Codex session launched on ${entry.node || 'its node'} to be adopted${entry.card ? ` for ${entry.card}` : ''}`,
        resolve: `keep pane screen ${entry.pane || '<pane>'}: if the session is running, keep pane ls on ${entry.node || 'the node'} should adopt it; if not, open it again`,
      };
    },
  },
];

// ---------- scanning ----------

const NOT_A_RECORD = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

async function readRecords(dir, kind, io = fsp) {
  let names;
  try { names = await io.readdir(dir); }
  catch (error) {
    if (error && NOT_A_RECORD.has(error.code)) return { records: [], failed: [] };
    // The directory itself: every record under it is unread this tick.
    return { records: [], failed: [{ file: dir, error }] };
  }
  const records = [];
  // `nested` kinds keep one directory per record with a fixed file inside
  // (.keep/pi-jobs/<id>/job.json): one level, never a walk.
  const wanted = names.filter(kind.match).sort().map((name) => (kind.nested ? path.join(name, kind.nested) : name));
  const failed = [];
  for (const name of wanted) {
    const file = path.join(dir, name);
    try {
      const stat = await io.stat(file);
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) continue;
      const raw = await io.readFile(file, 'utf8');
      const entry = kind.text ? { text: raw } : JSON.parse(raw);
      // Objects, or arrays for the kinds that keep several records in one file.
      if (!entry || typeof entry !== 'object') continue;
      records.push({ name, file, entry, mtimeMs: stat.mtimeMs });
    } catch (error) {
      // What says the file is not an in-flight record: it was removed mid-scan (its
      // owner finished it), it is half-written (its owner is mid-write), or it is not a
      // record at all (a stray file where a job directory belongs gives ENOTDIR). Any
      // other failure (EMFILE, EIO, EACCES) says nothing about the record, so this one
      // file is reported unread: escalation keeps what it last knew of the records it
      // held, for a while, rather than calling them finished. Only that file: the
      // rest of the kind was read, and a bad neighbour must not pin them.
      if (error && (NOT_A_RECORD.has(error.code) || error instanceof SyntaxError)) continue;
      failed.push({ file, error });
    }
  }
  return { records, failed };
}

// Pure over what readRecords returned, so a test can feed it shapes directly.
function judge(kind, records, now) {
  const out = [];
  for (const record of records) {
    let found;
    try { found = kind.describe(record.entry, record); } catch { found = null; }
    // A file may hold several records (review obligations, the restart queue).
    for (const described of (Array.isArray(found) ? found : [found])) {
      if (!described || !described.id) continue;
      const item = judgeOne(kind, record, described, now);
      if (item) out.push(item);
    }
  }
  return out;
}

function judgeOne(kind, record, described, now) {
  const since = timeMs(described.since) || record.mtimeMs || 0;
  if (!since) return null;
  const ageMs = Math.max(0, number(now) - since);
  const maxAgeMs = number(described.maxAgeMs, kind.maxAgeMs());
  if (ageMs < maxAgeMs) return null;
  return {
    kind: 'inflight',
    recordKind: kind.kind,
    id: `${kind.kind}:${safeId(described.id)}`,
    recordId: String(described.id),
    state: String(described.state || ''),
    since,
    ageMs,
    maxAgeMs,
    waitingFor: String(described.waitingFor || ''),
    resolve: String(described.resolve || ''),
    file: record.file,
    ...(described.sessionId ? { sessionId: String(described.sessionId) } : {}),
    ...(described.node ? { node: String(described.node) } : {}),
    ...(described.pane ? { pane: String(described.pane) } : {}),
    ...(Number(described.expiresAfterMs) > 0 ? { expiresAfterMs: Number(described.expiresAfterMs) } : {}),
  };
}

async function scan(options = {}) {
  const now = number(options.now, Date.now());
  const base = keepDir(options);
  const io = options.fs || fsp;
  const items = [];
  const errors = [];
  const failedFiles = [];
  const root = rootOf(options);
  for (const kind of options.kinds || KINDS) {
    const dir = path.join(base, kind.dir);
    const { records, failed } = await readRecords(dir, kind, io);
    for (const { file, error } of failed) {
      errors.push(`${kind.kind} ${path.relative(root, file)}: ${error.code || error.message}`);
      failedFiles.push(path.relative(root, file));
    }
    // What was read is named; a record in a file that could not be read is carried by
    // escalate() and the stalled sweep from what they last saw (unreadCovers).
    items.push(...judge(kind, records, now));
  }
  items.sort((a, b) => a.since - b.since || a.id.localeCompare(b.id));
  // Relative to the registry, so the card and the console never print a home path.
  for (const item of items) item.file = path.relative(root, item.file);
  return { items, errors, failedFiles };
}

// How long a record whose file cannot be read is carried as still stuck. After that
// it is reported unknown, not stuck: a file that stays unreadable is a problem of its
// own (named on the row), and must not pin a record that has long since finished.
const CARRY_UNREAD_MS = HOUR_MS;

// Whether a record last seen in `file` sits under one of this tick's unreadable paths
// (the file itself, or a directory that could not be listed).
function unreadCovers(failedFiles, file) {
  const target = String(file || '');
  return Boolean(target) && (failedFiles || []).some((failed) => target === failed || target.startsWith(`${failed}${path.sep}`));
}

// ---------- rendering ----------

function line(item) {
  const where = [item.node ? `node ${item.node}` : '', item.pane ? `pane ${item.pane}` : ''].filter(Boolean).join(', ');
  return `${item.recordKind} ${item.recordId}${item.state ? ` (${item.state})` : ''}${where ? ` on ${where}` : ''}`
    + ` — ${duration(item.ageMs)} old, max ${duration(item.maxAgeMs)}; waiting for ${item.waitingFor || 'its owner'}`
    + `; resolve: ${item.resolve || 'see the owning module'}`;
}

function attentionText(item) {
  return `In flight past max age: ${line(item)}`;
}

// The health row's error text. It names identities only, never ages: a console ack
// is keyed on the error text (bin/serve/routes.js), and an age in it would change
// every minute and bring an acknowledged row back each tick.
function healthError(items, cardId) {
  const names = items.slice(0, 4).map((item) => `${item.recordKind} ${short(item.recordId)}`);
  const more = items.length > names.length ? ` and ${items.length - names.length} more` : '';
  return `${items.length} in-flight record${items.length === 1 ? '' : 's'} past max age: ${names.join(', ')}${more}`
    + `${cardId ? `; card ${cardId}` : ''}; keep stalled`;
}

function cardText(items) {
  return [
    'These durable records are waiting for an event that has not come within the',
    'time their operation legitimately takes. Keep does not retire them itself (see',
    'bin/inflight.js); run the resolving command for each, or decide it is safe to',
    'leave. `keep stalled` shows the current list.',
    '',
    ...items.map((item) => `- ${line(item)} [${item.file}]`),
  ].join('\n');
}

// ---------- escalation ----------
//
// The state in .keep/stalled/inflight.json:
//   cardId      the card this names records on (kept after it closes, to know it)
//   keys        the record ids the card last named
//   seen        id -> { lastSeenAt, since, recordKind, expiresAfterMs? } for every record
//               past its age, so one that blinks out for a tick (a glitch, a mid-write
//               read) is carried rather than reported finished and then new again
//   dismissed   id -> lastSeenAt for records a card named and Owner then closed
//   failedAt    the last card write that threw, for the retry backoff
//   pending     { sig, tag } of the check-in being attempted, so its retry reuses the tag
//
// The daemon also keeps the latest state in memory and reads that first, so a state
// file that will not write (a full disk) cannot make the next tick repeat a card
// write it already made.

// A record absent this long is finished or gone; shorter is a blink.
const GONE_AFTER_MS = 10 * MINUTE_MS;
// A dismissed record forgotten after this long absent: if it comes back after that, it
// is a new occurrence and may open a card again.
const DISMISS_FORGET_MS = 6 * HOUR_MS;
// After a card write throws, the next attempt waits this long. A card write takes the
// registry lock and commits; one that fails every minute would fail loudly for nothing.
const RETRY_BACKOFF_MS = 20 * MINUTE_MS;
// How many ids of a set change a check-in lists before summarising.
const CHANGE_LIST_MAX = 12;

const memory = new Map(); // root -> state

function emptyState() {
  return { cardId: '', keys: [], seen: {}, dismissed: {}, failedAt: 0, failedError: '', changedAt: 0, pending: null };
}

function normalizeState(value) {
  const object = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return {
    cardId: typeof value.cardId === 'string' ? value.cardId : '',
    keys: Array.isArray(value.keys) ? value.keys.map(String) : [],
    seen: object(value.seen),
    dismissed: object(value.dismissed),
    failedAt: number(value.failedAt),
    failedError: String(value.failedError || ''),
    changedAt: number(value.changedAt),
    pending: value.pending && typeof value.pending.sig === 'string' && typeof value.pending.tag === 'string'
      ? { sig: value.pending.sig, tag: value.pending.tag } : null,
  };
}

async function readState(options = {}) {
  const root = rootOf(options);
  if (memory.has(root)) return normalizeState(JSON.parse(JSON.stringify(memory.get(root))));
  try { return normalizeState(JSON.parse(await fsp.readFile(stateFile(options), 'utf8'))); }
  catch { return emptyState(); }
}

async function writeState(value, options = {}) {
  memory.set(rootOf(options), JSON.parse(JSON.stringify(value)));
  const file = stateFile(options);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(temp, JSON.stringify(value, null, 2) + '\n');
    await fsp.rename(temp, file);
  } catch (error) {
    try { await fsp.unlink(temp); } catch {}
    throw error;
  }
}

// The card's id is its title's slug, suffixed -2, -3, ... past every id that already
// exists in tasks/ or archive/ (keep-core slugify). So every card this has ever opened
// is on that one sequence, which ends at the first id in neither directory.
function cardSlug() {
  return CARD_TITLE.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
}

async function exists(file) {
  try { await fsp.access(file); return true; } catch { return false; }
}

function isOurCard(task) {
  return cardOpen(task) && task.fm.title === CARD_TITLE
    && Array.isArray(task.fm.tags) && task.fm.tags.includes(HEALTH_NAME);
}

function defaultDeps(deps = {}, options = {}) {
  const lazyKeep = () => require('./keep.js');
  const loadTask = deps.loadTask || ((id) => { try { return lazyKeep().loadTask(id); } catch { return null; } });
  return {
    addTask: deps.addTask || ((payload) => lazyKeep().addTask(payload)),
    checkin: deps.checkin || ((id, payload) => lazyKeep().checkinTask(id, payload)),
    // A card that will not load reads as closed, which is what an archived or deleted
    // one is: the next set of stuck records opens a fresh card.
    loadTask,
    // An open card of ours already in the registry: one a crashed tick created and
    // never recorded, or one whose creation threw after the file was saved (a held
    // git index.lock throws from commitAndPush, after saveTask).
    findOpenCard: deps.findOpenCard || (async () => {
      const root = rootOf(options);
      const base = cardSlug();
      // The sequence normally has no gaps, but a card deleted outright leaves one; a
      // few misses in a row, not the first, end it.
      let misses = 0;
      for (let n = 1; n < 200 && misses < 5; n += 1) {
        const id = n === 1 ? base : `${base}-${n}`;
        const live = await exists(path.join(root, 'tasks', `${id}.md`));
        if (!live && !await exists(path.join(root, 'archive', `${id}.md`))) { misses += 1; continue; }
        misses = 0;
        if (live && isOurCard(loadTask(id))) return id;
      }
      return '';
    }),
  };
}

// Open means anything but done: a card Owner moved to waiting, blocked or deferred
// has been parked, not dismissed, so changes still land on it as check-ins rather
// than opening a second card beside it. Only `done` (or archived, which will not
// load) dismisses the records it named.
function cardOpen(task) {
  return Boolean(task && task.fm && task.fm.status && task.fm.status !== 'done');
}


function listIds(ids) {
  if (ids.length <= CHANGE_LIST_MAX) return ids.join(', ');
  return `${ids.slice(0, CHANGE_LIST_MAX).join(', ')} and ${ids.length - CHANGE_LIST_MAX} more`;
}

// A check-in that is safe to retry. checkinTask saves the card before it commits, so
// a throw can come after the entry is already on the card; the tag says whether it
// is, and a retry then counts as done rather than appending a second copy. The tag
// must be this attempt's alone: one derived from the key set would match an earlier,
// landed check-in whenever a set returns (A, then A+B, then A, then A+B again) and
// call a check-in landed that never was. So escalate() draws a random tag per
// attempt and writes it to its state before trying; only a retry of that same
// attempt (same card, label and set) reuses it.
function checkinOnce(deps, cardId, payload, tag) {
  try {
    deps.checkin(cardId, { ...payload, message: `${payload.message}\n${tag}` });
  } catch (error) {
    const task = deps.loadTask(cardId);
    if (task && String(task.body || '').includes(tag)) return;
    throw error;
  }
}

// One card for every stuck record, keyed by record identity. Returns { cardId, action }
// where action is 'opened', 'adopted', 'updated', 'cleared', 'unchanged', 'dismissed',
// 'backoff' or 'none'. A card write that throws is rethrown after arming the backoff;
// the caller records it on the health row.
//
// Closing the card is how Owner says "I have seen these". The ids it named are then
// dismissed, and stay dismissed while they keep turning up and for six hours after
// they last did; only a record none of those covers opens a new card. Identity is the
// record (the session, the move, the journal), not its timestamp, so a console Retry
// that restamps a record which then sticks again is still the one Owner dismissed.
async function escalate(items, options = {}) {
  const now = number(options.now, Date.now());
  const deps = defaultDeps(options.deps, options);
  const failedFiles = options.failedFiles || [];
  const state = await readState(options);

  // Every id this tick knows is past its age: the ones read now, plus the ones read
  // recently (a blink) or in a kind that could not be read this tick.
  const byKey = new Map((items || []).map((item) => [item.id, item]));
  const seen = {};
  for (const [key, item] of byKey) {
    seen[key] = { lastSeenAt: now, since: item.since, recordKind: item.recordKind, file: item.file,
      ...(item.expiresAfterMs ? { expiresAfterMs: item.expiresAfterMs } : {}) };
  }
  // Absent this tick: carried while it is a blink, or while its own file is unreadable
  // (for at most CARRY_UNREAD_MS); otherwise it has left, as finished or as unknown.
  const unknown = new Set();
  for (const [key, entry] of Object.entries(state.seen)) {
    if (seen[key]) continue;
    const absentMs = now - number(entry.lastSeenAt);
    const unread = unreadCovers(failedFiles, entry.file);
    if (absentMs < GONE_AFTER_MS || unread && absentMs < CARRY_UNREAD_MS) seen[key] = entry;
    else if (unread) unknown.add(key);
  }
  const keys = Object.keys(seen).sort();

  const dismissed = {};
  for (const [key, at] of Object.entries(state.dismissed)) {
    if (seen[key]) dismissed[key] = now;
    else if (now - number(at) < DISMISS_FORGET_MS) dismissed[key] = number(at);
  }

  const next = { ...state, seen, dismissed };
  const save = async (patch = {}) => { await writeState({ ...next, ...patch }, options); };
  // The tag for this check-in, reused only by a retry of the very same attempt.
  const tagFor = async (id, label, set) => {
    const sig = JSON.stringify([id, label, set]);
    const tag = state.pending && state.pending.sig === sig ? state.pending.tag
      : `[inflight ${require('crypto').randomBytes(6).toString('hex')}]`;
    next.pending = { sig, tag };
    // Memory holds it even if the file will not write, which is all a retry in this
    // process needs; a write error here must not stop the check-in itself.
    await save().catch(() => {});
    return tag;
  };

  const cardFailed = async (error) => {
    await save({ failedAt: now, failedError: String(error && error.message || error) }).catch(() => {});
    throw error;
  };
  if (state.failedAt && now - state.failedAt < RETRY_BACKOFF_MS) {
    await save();
    return { cardId: state.cardId, action: 'backoff' };
  }
  next.failedAt = 0;
  next.failedError = '';

  let cardId = state.cardId;
  const open = cardId ? cardOpen(deps.loadTask(cardId)) : false;
  if (cardId && !open && state.keys.length) {
    // The card was closed with records on it: those are dismissed now.
    for (const key of state.keys) dismissed[key] = now;
    next.keys = [];
  }
  const named = open ? state.keys : [];

  if (!keys.length) {
    if (!named.length) { await save({ keys: [] }); return { cardId, action: 'none' }; }
    try {
      const tag = await tagFor(cardId, 'cleared', named);
      checkinOnce(deps, cardId, {
        heading: 'in-flight records cleared',
        message: unknown.size
          ? `No record is past its max age now. Finished or gone: ${listIds(named.filter((key) => !unknown.has(key))) || 'none'}; `
            + `unknown, their record unreadable for over ${duration(CARRY_UNREAD_MS)}: ${listIds(named.filter((key) => unknown.has(key)))}.`
          : `Every record this card named has finished or gone (${listIds(named)}). Keep leaves the card for you to close.`,
        linkSession: false, commitLabel: HEALTH_NAME,
      }, tag);
    } catch (error) { return cardFailed(error); }
    await save({ keys: [], changedAt: now, pending: null });
    return { cardId, action: 'cleared' };
  }

  if (open) {
    const same = keys.length === named.length && keys.every((key, i) => key === named[i]);
    if (same) { await save(); return { cardId, action: 'unchanged' }; }
    const before = new Set(named);
    const added = keys.filter((key) => !before.has(key));
    const left = named.filter((key) => !seen[key]);
    // A record whose owner drops it on a timer (a node launch nobody adopted, a model
    // swap the restore pass gave up on) did not finish: it expired unresolved.
    const expired = left.filter((key) => {
      const entry = state.seen[key];
      return entry && entry.expiresAfterMs && now >= number(entry.since) + number(entry.expiresAfterMs);
    });
    const finished = left.filter((key) => !expired.includes(key) && !unknown.has(key));
    const unknownLeft = left.filter((key) => unknown.has(key));
    const addedItems = added.map((key) => byKey.get(key)).filter(Boolean);
    const message = [
      `${keys.length} record${keys.length === 1 ? '' : 's'} past max age now (was ${named.length}).`,
      finished.length ? `Finished or gone: ${listIds(finished)}.` : '',
      expired.length ? `Expired unresolved (dropped by their owner's own timeout): ${listIds(expired)}.` : '',
      unknownLeft.length ? `Unknown, their record unreadable for over ${duration(CARRY_UNREAD_MS)} (see the inflight health row): ${listIds(unknownLeft)}.` : '',
      addedItems.length ? `New:\n${addedItems.slice(0, CHANGE_LIST_MAX).map((item) => `- ${line(item)} [${item.file}]`).join('\n')}` : '',
      addedItems.length > CHANGE_LIST_MAX ? `and ${addedItems.length - CHANGE_LIST_MAX} more; keep stalled lists them all.` : '',
    ].filter(Boolean).join('\n');
    try {
      const tag = await tagFor(cardId, 'changed', keys);
      checkinOnce(deps, cardId, { heading: 'in-flight records changed', message, linkSession: false, commitLabel: HEALTH_NAME }, tag);
    } catch (error) { return cardFailed(error); }
    await save({ keys, changedAt: now, pending: null });
    return { cardId, action: 'updated' };
  }

  // No open card. Records Owner dismissed do not open one; anything else does.
  if (keys.every((key) => dismissed[key])) {
    await save({ keys: [] });
    return { cardId, action: cardId ? 'dismissed' : 'none' };
  }
  const current = keys.map((key) => byKey.get(key)).filter(Boolean);
  let action = 'opened';
  try {
    cardId = await deps.findOpenCard();
    if (cardId) {
      // A card of ours this state does not know (a lost state file): what it names is
      // unknown, so it is told the whole current list once.
      action = 'adopted';
      const tag = await tagFor(cardId, 'adopted', keys);
      checkinOnce(deps, cardId, {
        heading: 'in-flight records',
        message: `Keep lost track of this card and picked it up again. Current list:\n\n${cardText(current)}`,
        linkSession: false, commitLabel: HEALTH_NAME,
      }, tag);
    } else {
      try {
        const created = deps.addTask({
          title: CARD_TITLE,
          kind: 'bug',
          status: 'active',
          project: CARD_PROJECT,
          tags: ['personal', HEALTH_NAME],
          note: cardText(current),
          linkSession: false,
          commit: true,
        });
        cardId = created && created.id;
        if (!cardId) throw new Error('addTask returned no card');
      } catch (error) {
        // addTask saves the card before it commits: a throw from the commit leaves a
        // perfectly good card, which must be adopted, not duplicated next tick.
        cardId = await deps.findOpenCard();
        if (!cardId) throw error;
        action = 'adopted';
      }
    }
  } catch (error) { return cardFailed(error); }
  // A new card names everything current, dismissed or not, so dismissal starts over
  // with it.
  await save({ cardId, keys, dismissed: {}, changedAt: now, pending: null });
  return { cardId, action };
}

// The whole tick: scan, escalate, and the health row. Never throws; a failure lands
// on the row. `record` is health.record.
async function tick(options = {}) {
  const record = options.record || require('./health.js').record;
  const now = number(options.now, Date.now());
  let result;
  try {
    // The stalled sweep hands over its own scan, so the list, the row and the card
    // are one reading; its failure arrives as `scanned.error`.
    result = options.scanned || await scan({ ...options, now });
    if (result.error) throw result.error;
  } catch (error) {
    // No escalation on a failed scan: an empty list from a scan that did not happen
    // would read as "everything cleared" and check in on the card.
    record(HEALTH_NAME, { at: now, ok: false, cadenceMs: MINUTE_MS, error: `in-flight scan failed: ${error.message || error}` });
    return { items: [], error };
  }
  const { items, errors = [], failedFiles = [] } = result;
  let escalation = null;
  let escalationError = null;
  try { escalation = await escalate(items, { ...options, now, failedFiles }); }
  catch (error) { escalationError = error; }
  const cardId = escalation && escalation.cardId || '';
  const unread = errors.length ? `; unreadable: ${errors.join('; ')}` : '';
  if (items.length) {
    record(HEALTH_NAME, {
      at: now, ok: false, cadenceMs: MINUTE_MS,
      error: healthError(items, cardId) + unread
        + (escalationError ? `; card write failed: ${escalationError.message || escalationError}` : ''),
    });
  } else if (escalationError || errors.length) {
    record(HEALTH_NAME, {
      at: now, ok: false, cadenceMs: MINUTE_MS,
      error: escalationError ? `card write failed: ${escalationError.message || escalationError}${unread}` : unread.slice(2),
    });
  } else {
    record(HEALTH_NAME, { at: now, ok: true, cadenceMs: MINUTE_MS, detail: 'no in-flight record past its max age' });
  }
  return { items, escalation, error: escalationError };
}

module.exports = {
  HEALTH_NAME, CARD_TITLE, KINDS, GONE_AFTER_MS, DISMISS_FORGET_MS, RETRY_BACKOFF_MS, CARRY_UNREAD_MS,
  unreadCovers,
  scan, judge, escalate, tick, readState, cardSlug,
  // Tests only: forget the in-memory state, as a daemon restart does.
  _resetMemory: () => memory.clear(),
  attentionText, healthError, cardText, line, duration, safeId,
};
