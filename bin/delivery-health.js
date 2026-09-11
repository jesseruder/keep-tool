'use strict';

// Observe durable attempts, not session activity: an idle agent with an unsent
// draft can otherwise look healthy forever. Never type, acknowledge, or delete.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { received, cancelled } = require('./delivery');
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
    try { if (cancelled(entry, directory) || received(entry)) continue; }
    catch { reason = 'transcript-unreadable'; }
    const trace = events.filter(row => row.session === entry.sessionId && row.pane === entry.pane && row.at >= since - 1);
    if (reason !== 'transcript-unreadable') {
      if (trace.some(row => ['enter-sent', 'submit-draft-ok'].includes(row.stage))) reason = 'receipt-missing-after-enter';
      else if (trace.some(row => ['screen-confirmation', 'draft-screen-check'].includes(row.stage) && row.matched === false)) reason = 'screen-verification-failed';
    }
    issues.push({ sessionId: safeId(entry.sessionId), agent: entry.kind, pane: safeId(entry.pane), since, ageMs: Math.max(0, now - since), reason });
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

async function sweep(options = {}) {
  try {
    try { await options.reconcile?.(); }
    catch (error) { if (error.status !== 429) throw error; } // Routine injection contention; inspect without mutating.
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
