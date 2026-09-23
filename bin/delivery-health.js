'use strict';

// Observe durable attempts, not session activity: an idle agent with an unsent
// draft can otherwise look healthy forever. Never type, acknowledge, or delete.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { received, indexConfirms, completedTyping, nodeReceiptKey, collectNodeReceipts } = require('./delivery');
const STALE_MS = 2 * 60e3;
const safeId = value => /^[A-Za-z0-9_-]{1,160}$/.test(String(value || '')) ? String(value) : 'unknown';

function traceEvents(directory) {
  const events = [];
  for (const name of ['events.jsonl.1', 'events.jsonl']) {
    try {
      for (const line of fs.readFileSync(path.join(directory, 'diagnostics', name), 'utf8').split('\n')) {
        try { const row = JSON.parse(line); if (row && typeof row === 'object') events.push(row); } catch {}
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return events;
}

function inspect(options = {}) {
  const root = options.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
  const directory = options.directory || path.join(root, '.keep', 'delivery');
  const now = options.now ?? Date.now();
  let files;
  try { files = fs.readdirSync(directory).filter(name => name.endsWith('.json')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const events = traceEvents(directory);
  const issues = [];
  for (const name of files) {
    let entry, stat;
    try {
      const file = path.join(directory, name);
      stat = fs.statSync(file);
      entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!entry || !['claude', 'codex'].includes(entry.kind) || typeof entry.file !== 'string'
          || !Number.isSafeInteger(entry.offset) || entry.offset < 0 || !/^[a-f0-9]{64}$/.test(entry.hash)) throw Error('invalid journal');
    } catch (error) {
      if (error.code !== 'ENOENT') issues.push({ reason: 'journal-unreadable', journal: safeId(name.replace(/\.json$/, '')), since: stat?.mtimeMs });
      continue; // A receipt reconciliation may have removed it during this sweep.
    }
    const since = Number.isFinite(entry.createdAt) && entry.createdAt > 0 ? entry.createdAt : stat.mtimeMs;
    if (now - since < (options.staleMs ?? STALE_MS)) continue;
    let reason = 'receipt-missing';
    if (entry.node) {
      // A journal on a node is judged by that node's answer (options.nodeReceipts,
      // gathered by sweep). No answer is reported as such: the delivery may well have
      // landed, but nothing here has seen it do so.
      const answer = options.nodeReceipts instanceof Map ? options.nodeReceipts.get(nodeReceiptKey(name, entry)) : undefined;
      if (answer === true) continue;
      if (answer !== false) reason = 'node-unanswered';
    } else {
      try { if (received(entry)) continue; }
      catch { reason = 'transcript-unreadable'; }
    }
    // The turn index recorded the message, so it did arrive; the reconcile sweep
    // that runs before this inspection settles such a journal after a minute. One
    // still here past the stale window is one that sweep failed to settle, which is
    // still worth reporting, but not as an unconfirmed message. Read-only: settling
    // is reconcile's, under the injection lock.
    if ((Number(entry.typedAt) > 0 || completedTyping(entry)) && indexConfirms(entry, { db: options.indexDb })) reason = 'index-confirms-settling';
    const trace = events.filter(row => row.session === entry.sessionId && row.pane === entry.pane && row.at >= since - 1);
    if (reason === 'receipt-missing') {
      if (trace.some(row => ['enter-sent', 'submit-draft-ok'].includes(row.stage))) reason = 'receipt-missing-after-enter';
      else if (trace.some(row => ['screen-confirmation', 'draft-screen-check'].includes(row.stage) && row.matched === false)) reason = 'screen-verification-failed';
    }
    issues.push({ sessionId: safeId(entry.sessionId), agent: entry.kind, pane: safeId(entry.pane), since, ageMs: Math.max(0, now - since), reason,
      ...(entry.node ? { node: safeId(entry.node) } : {}) });
  }
  return issues.sort((a, b) => (a.since || 0) - (b.since || 0));
}

function tick(options = {}) {
  const health = options.health || require('./health');
  try {
    const issues = inspect(options);
    // A new stuck attempt must get a new attention event even if an older one
    // remains unresolved; routine polling and recovery of older ones must not.
    const first = issues.at(-1);
    const detail = first
      ? `${issues.length} unconfirmed delivery issue(s): ${first.agent || 'unknown'} ${first.sessionId || first.journal}; ${first.reason}. ${first.pane ? 'Inspect: keep pane screen ' + first.pane : 'Inspect delivery journals'}. Full list: node bin/delivery-health.js`
      : 'No stale unconfirmed deliveries';
    const incidentId = first && crypto.createHash('sha256').update(JSON.stringify([first.sessionId || first.journal, first.pane, first.since])).digest('hex');
    health.record('delivery', { at: options.now ?? Date.now(), ok: !issues.length, detail, ...(issues.length ? { error: detail, incidentAt: first.since, incidentId } : {}) });
    options.onChange?.();
    return issues;
  } catch (error) {
    // Paths and raw error messages can contain private information.
    health.record('delivery', { at: options.now ?? Date.now(), ok: false, error: 'Delivery watchdog could not inspect journals or diagnostics' });
    options.onChange?.();
    return null;
  }
}

// The reconcile takes the global injection lock, so any delivery in flight anywhere
// refuses it with 429. Skipping the sweep's cleanup on that is safe, but it is never
// made up: each 60s tick took one instantaneous sample of a lock that, on a loaded
// machine, is held most of the time. On 2026-09-18 a journal whose typing failed - no
// `typedAt`, which is exactly the entry reconcile deletes unread - lost 18 of those
// samples in a row. It outlived its 15-minute expiry by 19 minutes, crossed
// self-repair's 30-minute threshold and opened a repair card for a message the pane
// never kept. So contention is now waited out inside the tick, sampling across a span
// instead of at one instant, and still well short of the next tick.
// The window says when a new attempt may start, not when the sweep ends: an attempt
// begun just inside it still runs to completion, and on this machine one attempt is a
// host pane list that can spend seconds waiting on the host and seconds more in ps.
// A third of the cadence leaves that overrun room to land inside the 60s tick, and so
// inside the silence threshold health.js puts at twice the cadence, on the nominal
// timeouts those calls carry. It is margin, not a guarantee: a call that hangs past
// its own timeout hangs the sweep, which was true of the single attempt before this.
const RECONCILE_WAIT_MS = 20e3;
const RECONCILE_POLL_MS = 500;
// Only a non-negative whole number of milliseconds is a window. Anything else -
// null and '' coerce to 0, NaN and Infinity are numbers too, and a fraction is
// truncated by setTimeout so the attempt ceiling would stop counting the same thing
// the clock does - takes the default rather than quietly disabling the wait or the
// boundary that ends it.
const duration = (value, fallback) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;

async function reconcileWithRetry(options) {
  if (!options.reconcile) return;
  const waitMs = duration(options.reconcileWaitMs, RECONCILE_WAIT_MS);
  const pollMs = Math.max(1, duration(options.reconcilePollMs, RECONCILE_POLL_MS));
  // Monotonic: a wall clock that steps backwards - an NTP correction on a machine
  // already struggling - would hold the deadline in the future for the length of the
  // step, and the scheduler's re-entrancy guard suppresses every tick until this
  // returns. The attempt ceiling below ends the loop whatever the clock does.
  const clock = options.clock || (() => performance.now());
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // Spent on the clock, not counted off in sleeps: the reconcile itself lists the
  // host's panes before each attempt, and that call is slowest on exactly the loaded
  // machine this is waiting for. Summing the sleeps would let the sweep run for
  // minutes and fall past the health row's own silence threshold.
  const deadline = clock() + waitMs;
  const maxAttempts = Math.ceil(waitMs / pollMs) + 1;
  for (let attempt = 0; ; attempt += 1) {
    try { return await options.reconcile(); }
    // Anything but contention is a real fault, and stays the caller's to record.
    catch (error) { if (!error || error.status !== 429) throw error; }
    // Busy for the whole window: inspect without mutating, as before. Tested on both
    // sides of the sleep - before it, so an attempt that overran the window does not
    // buy another poll first; after it, so a timer that fires late does not start a
    // fresh pane list outside the window. An attempt begun inside the window may
    // still overrun, and that one is unavoidable.
    if (attempt + 1 >= maxAttempts || clock() >= deadline) return;
    // Never sleep past the window either, or a poll longer than the whole window
    // would overshoot it by the difference before anything looked at the clock.
    await sleep(Math.max(1, Math.min(pollMs, Math.ceil(deadline - clock()))));
    if (clock() >= deadline) return;
  }
}

async function sweep(options = {}) {
  try {
    await reconcileWithRetry(options);
    // A node's journals are asked of their nodes before the read-only inspection, which
    // cannot wait on a request. Without a receiptFor (a single-node install) nothing is
    // asked, and the tick is the one it always was.
    if (typeof options.receiptFor === 'function') {
      const root = options.root || process.env.KEEP_DIR || path.join(os.homedir(), 'keep');
      const directory = options.directory || path.join(root, '.keep', 'delivery');
      return tick({ ...options, nodeReceipts: await collectNodeReceipts(directory, options.receiptFor) });
    }
    return tick(options);
  } catch {
    (options.health || require('./health')).record('delivery', { ok: false, error: 'Delivery reconciliation could not run' });
    return null;
  }
}

function startScheduler(options = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await sweep(options); } finally { running = false; }
  };
  const interval = setInterval(run, 60e3);
  const initial = setTimeout(run, 5e3);
  interval.unref(); initial.unref();
  return () => { clearInterval(interval); clearTimeout(initial); };
}

module.exports = { inspect, tick, sweep, startScheduler, STALE_MS };
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(inspect(), null, 2) + '\n'); }
  catch { process.stderr.write('Delivery watchdog could not inspect journals or diagnostics\n'); process.exitCode = 1; }
}
