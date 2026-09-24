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
          + 'an unconfirmed keep tell is recovered by re-running the byte-identical tell, which settles the journal',
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
      try { neverLeft = require('./account-handoff.js').abandonCandidate(entry, since + 16 * MINUTE_MS); } catch {}
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
          : `${retry} (it is past the point where Abandon is safe; only a retry finishes it)`,
      };
    },
  },
  // The handoff queue, .keep/handoff-queue/<session>.json (bin/handoff-queue.js).
  // `queued` is the only in-flight status: the queue's own tick parks an entry 45
  // minutes after it was enqueued (KEEP_HANDOFF_QUEUE_MAX_MIN), and parked, moved and
  // cancelled are decisions it has made. A `queued` entry older than that is one the
  // tick has stopped reaching, and the queue never collects a queued entry itself.
  {
    kind: 'handoff-queue',
    dir: 'handoff-queue',
    match: json,
    maxAgeMs: () => envMinutes('KEEP_INFLIGHT_HANDOFF_QUEUE_MIN', 90 * MINUTE_MS),
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
  // launch; nothing else ever does. Plain text, so its age is the file's mtime.
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
        waitingFor: 'the Pi session to start and read its opening message',
        resolve: `keep pane screen for Pi session ${sessionId}; if it never started, open it again (the file is its opening message)`,
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
  // Unblock records, .keep/unblocked/*.json (bin/unblock.js). A record waiting on its
  // upstream is legitimately open for as long as the upstream is, so only a resolved
  // one counts: resolvedAt set, nothing delivered, not given up. The sweep gives up a
  // day after creation or twelve tries, but only while the card has no check_after and
  // no open needs; a card with either keeps the record pending forever. A day from
  // the resolution covers every automatic path.
  {
    kind: 'unblock',
    dir: 'unblocked',
    match: json,
    maxAgeMs: () => envMinutes('KEEP_INFLIGHT_UNBLOCK_MIN', 24 * HOUR_MS),
    describe(entry, record) {
      if (Array.isArray(entry) || !entry.resolvedAt || entry.deliveredAt || entry.gaveUp || !entry.dependent) return null;
      return {
        id: record.name.replace(/\.json$/, ''),
        state: `resolved, undelivered (${number(entry.attempts)} attempts)`,
        since: latest(entry.resolvedAt),
        sessionId: entry.sessionId,
        waitingFor: `delivery of "${entry.upstream || entry.upstreamId || 'its upstream'} is resolved" to ${entry.dependent}`,
        resolve: `keep show ${entry.dependent}: pick it up (keep open ${entry.dependent}), `
          + `or keep wait-on ${entry.dependent} ${entry.upstream || entry.upstreamId || '<upstream>'} --remove`,
      };
    },
  },
  // The session restart queue, .keep/session-restarts.json (bin/session-restart.js),
  // one array. `queued` waits for the session to go idle, `restarting` for the
  // restart to finish, `recovery-needed` for someone to recover an interrupted forced
  // restart. A restart takes a minute; two hours covers a long idle wait.
  {
    kind: 'session-restart',
    dir: '.',
    match: (name) => name === 'session-restarts.json',
    maxAgeMs: () => envMinutes('KEEP_INFLIGHT_RESTART_MIN', 2 * HOUR_MS),
    describe(entry) {
      if (!Array.isArray(entry)) return null;
      return entry.filter((item) => item && ['queued', 'restarting', 'recovery-needed'].includes(item.status) && item.sessionId)
        .map((item) => ({
          id: item.sessionId,
          state: `${item.status} (${item.mode || 'now'})`,
          since: latest(item.at),
          sessionId: item.sessionId,
          pane: item.pane,
          waitingFor: item.status === 'queued' ? 'the session to go idle so it can restart'
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
        node: entry.node,
        pane: entry.pane,
        waitingFor: `the Codex session launched on ${entry.node || 'its node'} to be adopted${entry.card ? ` for ${entry.card}` : ''}`,
        resolve: `keep pane screen ${entry.pane || '<pane>'}: if the session is running, keep pane ls on ${entry.node || 'the node'} should adopt it; if not, open it again`,
      };
    },
  },
];

// ---------- scanning ----------

async function readRecords(dir, kind, io = fsp) {
  let names;
  try { names = await io.readdir(dir); }
  catch (error) {
    if (error && error.code === 'ENOENT') return { records: [], error: null };
    return { records: [], error };
  }
  const records = [];
  // `nested` kinds keep one directory per record with a fixed file inside
  // (.keep/pi-jobs/<id>/job.json): one level, never a walk.
  const wanted = names.filter(kind.match).sort().map((name) => (kind.nested ? path.join(name, kind.nested) : name));
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
    } catch {
      // Removed mid-scan (its owner finished it), or half-written. Neither is stuck;
      // an unreadable record that stays unreadable is its owner's watchdog's to name.
    }
  }
  return { records, error: null };
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
  };
}

async function scan(options = {}) {
  const now = number(options.now, Date.now());
  const base = keepDir(options);
  const io = options.fs || fsp;
  const items = [];
  const errors = [];
  for (const kind of options.kinds || KINDS) {
    const dir = path.join(base, kind.dir);
    const { records, error } = await readRecords(dir, kind, io);
    if (error) { errors.push(`${kind.kind}: ${error.code || error.message}`); continue; }
    items.push(...judge(kind, records, now));
  }
  items.sort((a, b) => a.since - b.since || a.id.localeCompare(b.id));
  // Relative to the registry, so the card and the console never print a home path.
  const root = rootOf(options);
  for (const item of items) item.file = path.relative(root, item.file);
  return { items, errors };
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

async function readState(options = {}) {
  try {
    const value = JSON.parse(await fsp.readFile(stateFile(options), 'utf8'));
    return {
      cardId: typeof value.cardId === 'string' ? value.cardId : '',
      keys: Array.isArray(value.keys) ? value.keys.map(String) : [],
      changedAt: number(value.changedAt),
    };
  } catch { return { cardId: '', keys: [], changedAt: 0 }; }
}

async function writeState(value, options = {}) {
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

function defaultDeps(deps = {}) {
  const lazyKeep = () => require('./keep.js');
  return {
    addTask: deps.addTask || ((options) => lazyKeep().addTask(options)),
    checkin: deps.checkin || ((id, payload) => lazyKeep().checkinTask(id, payload)),
    // A card that will not load reads as closed, which is what an archived or deleted
    // one is: the next set of stuck records opens a fresh card.
    loadTask: deps.loadTask || ((id) => { try { return lazyKeep().loadTask(id); } catch { return null; } }),
  };
}

function cardOpen(task) {
  return Boolean(task && task.fm && task.fm.status && task.fm.status !== 'done');
}

// One card for every stuck record, keyed by the set of record identities. Returns
// { cardId, action } where action is 'opened', 'updated', 'cleared', 'unchanged',
// 'dismissed' or 'none'. Throws only when the card write itself fails; the caller
// records that on the health row, and the state is left as it was so the next tick
// retries.
//
// Closing the card is how Owner says "I have seen these": a closed card whose records
// are all ones it already named stays closed (the health row and `keep stalled` still
// show them). Only a record it never named opens a fresh card.
async function escalate(items, options = {}) {
  const now = number(options.now, Date.now());
  const deps = defaultDeps(options.deps);
  const state = await readState(options);
  const keys = [...new Set((items || []).map((item) => item.id))].sort();
  const task = state.cardId ? deps.loadTask(state.cardId) : null;
  const open = cardOpen(task);
  const same = keys.length === state.keys.length && keys.every((key, i) => key === state.keys[i]);
  const known = new Set(state.keys);

  if (!open && state.cardId && keys.length && keys.every((key) => known.has(key))) {
    if (!same) await writeState({ cardId: state.cardId, keys, changedAt: now }, options);
    return { cardId: state.cardId, action: 'dismissed' };
  }

  if (!keys.length) {
    if (!state.keys.length) return { cardId: state.cardId, action: 'none' };
    if (open) {
      deps.checkin(state.cardId, {
        heading: 'in-flight records cleared',
        message: `Every record this card named has finished or gone (${state.keys.join(', ')}). Keep leaves the card for you to close.`,
        linkSession: false, commitLabel: HEALTH_NAME,
      });
    }
    await writeState({ cardId: state.cardId, keys: [], changedAt: now }, options);
    return { cardId: state.cardId, action: 'cleared' };
  }

  if (open && same) return { cardId: state.cardId, action: 'unchanged' };

  if (open) {
    const before = new Set(state.keys);
    const after = new Set(keys);
    const added = keys.filter((key) => !before.has(key));
    const gone = state.keys.filter((key) => !after.has(key));
    const change = [
      added.length ? `New: ${added.join(', ')}.` : '',
      gone.length ? `Finished or gone: ${gone.join(', ')}.` : '',
    ].filter(Boolean).join(' ');
    deps.checkin(state.cardId, {
      heading: 'in-flight records changed',
      message: `${change}\n\n${cardText(items)}`,
      linkSession: false, commitLabel: HEALTH_NAME,
    });
    await writeState({ cardId: state.cardId, keys, changedAt: now }, options);
    return { cardId: state.cardId, action: 'updated' };
  }

  const created = deps.addTask({
    title: CARD_TITLE,
    kind: 'bug',
    status: 'active',
    project: CARD_PROJECT,
    tags: ['personal', HEALTH_NAME],
    note: cardText(items),
    linkSession: false,
    commit: true,
  });
  const cardId = created && created.id;
  if (!cardId) throw new Error('addTask returned no card');
  await writeState({ cardId, keys, changedAt: now }, options);
  return { cardId, action: 'opened' };
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
  const { items, errors } = result;
  let escalation = null;
  let escalationError = null;
  try { escalation = await escalate(items, { ...options, now }); }
  catch (error) { escalationError = error; }
  const cardId = escalation && escalation.cardId || '';
  if (items.length) {
    record(HEALTH_NAME, {
      at: now, ok: false, cadenceMs: MINUTE_MS,
      error: healthError(items, cardId)
        + (escalationError ? `; card write failed: ${escalationError.message || escalationError}` : ''),
    });
  } else if (escalationError || errors.length) {
    record(HEALTH_NAME, {
      at: now, ok: false, cadenceMs: MINUTE_MS,
      error: escalationError ? `card write failed: ${escalationError.message || escalationError}` : `unreadable: ${errors.join('; ')}`,
    });
  } else {
    record(HEALTH_NAME, { at: now, ok: true, cadenceMs: MINUTE_MS, detail: 'no in-flight record past its max age' });
  }
  return { items, escalation, error: escalationError };
}

module.exports = {
  HEALTH_NAME, CARD_TITLE, KINDS,
  scan, judge, escalate, tick, readState,
  attentionText, healthError, cardText, line, duration, safeId,
};
