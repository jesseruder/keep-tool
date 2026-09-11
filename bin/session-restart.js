'use strict';
const fs = require('node:fs'), path = require('node:path');

class RestartDeferred extends Error {}

// Reviewer identity is durable in the marker-backed session state and duplicated in
// pane meta so it survives the narrow interval where SessionEnd demotes the pane to a
// shell. Restart configuration and every viewer guard must use this same predicate.
function isReviewer(session, pane) {
  return Boolean(session?.reviewer || pane?.meta?.reviewer);
}

function refusal(session, pane, queued = false) {
  if (!session || !pane?.alive || pane.meta?.sessionId !== session.id || !['claude', 'codex'].includes(pane.meta?.agent)) return 'Session is not live in its original pane';
  // The fleet reviewer restarts like any other session: its pane keeps meta.reviewer,
  // and bin/serve.js rebuilds its launch flags and env on the resume, so the marker,
  // the model and the tick address all survive. Every guard below except the viewer
  // check still applies.
  if (session.activity?.background?.scheduled?.length || session.backgroundJobs?.jobs?.some(j => j.kind === 'scheduled' && j.status === 'pending')) return 'Pause session-local scheduled jobs before restarting';
  if (session.endedTurn !== true || session.toolRunning || session.pendingBackground || session.waitingFor || session.rateLimit
      || session.unknownBackgroundJobs?.length || session.lifecycleAgents?.length
      || session.backgroundJobs?.jobs?.some(j => j.status === 'pending')
      || session.lifecycleForeground?.state === 'running' || session.lifecycleForeground?.state === 'waiting') return 'Waiting for the turn and background work to finish';
  if (session.pendingQuestion || session.pendingPlan
      || ['permission', 'question'].includes(session.notify?.type)
      || session.lifecycleForeground?.state === 'needs-input'
      || require('./session-status').proseRequest(session.lastAssistantFull || session.lastAssistant)
      || (session.activity?.needsInput && session.activity.reason !== 'next instruction')) return 'Waiting for pending input to be resolved';
  // Durable registry checks and dependencies survive resume. Displayed readiness
  // is not proof of process-local work; the close path verifies the actual prompt.
  if (queued && !isReviewer(session, pane) && (pane.visibleAttached ?? pane.attached) !== 0) return 'Waiting until the pane is no longer being viewed';
  return null;
}

function read(file) {
  try { const rows = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(rows) ? rows : []; } catch { return []; }
}

function createManager({ file, inspect, restart, forceRestart, onChange = () => {} }) {
  let entries = read(file).map((entry) => entry.status === 'restarting'
    ? { ...entry, status: entry.mode === 'force' && entry.original ? 'recovery-needed' : 'failed', reason: 'Daemon stopped during restart; inspect the session before retrying' } : entry);
  let busy = false;
  const save = () => {
    const active = (e) => ['queued', 'restarting', 'recovery-needed'].includes(e.status);
    const history = new Set(entries.filter((e) => !active(e) && Date.now() - e.at < 86400e3).slice(-100));
    entries = entries.filter((e) => active(e) || history.has(e));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    onChange();
  };
  save();
  const run = async (entry) => {
    if (entry.status !== 'queued') return entry;
    if (busy) return entry;
    busy = true;
    try {
      if (entry.mode === 'force') {
        if (!forceRestart) throw Error('Force restart unavailable');
        entry.status = 'restarting'; entry.reason = ''; save();
        entry.result = await forceRestart(entry, save);
        entry.status = 'done'; entry.at = Date.now(); save(); return entry;
      }
      const { session, pane } = await inspect(entry);
      if (entry.status !== 'queued') return entry;
      // A missing observation (for example while the host reconnects) is not
      // evidence that the original process was replaced. No input has been sent.
      if (!pane) throw new RestartDeferred('Waiting for the original pane to be observable');
      if (pane.pid !== entry.pid) throw Error('Session process changed; restart cancelled');
      const reason = refusal(session, pane, entry.mode === 'idle');
      if (reason) {
        if (entry.mode === 'now') throw Error(reason);
        if (entry.reason !== reason) { entry.reason = reason; save(); }
        return entry;
      }
      entry.status = 'restarting'; entry.reason = ''; save();
      const result = await restart(entry);
      entry.status = 'done'; entry.result = result; entry.at = Date.now(); save();
      return entry;
    } catch (error) {
      entry.status = entry.mode === 'force' && entry.original ? 'recovery-needed'
        : entry.mode === 'idle' && error instanceof RestartDeferred ? 'queued' : 'failed';
      entry.reason = error.message; entry.at = Date.now(); save();
      return entry;
    } finally { busy = false; }
  };
  return {
    snapshot: () => entries.map((e) => ({ ...e })),
    async request(body) {
      if (!/^[a-z0-9_-]+$/i.test(body?.sessionId || '') || !/^[a-z0-9_-]+$/i.test(body?.pane || '') || !['now', 'idle', 'cancel', 'force', 'recover'].includes(body.mode)) throw Error('Expected exact session, pane and restart mode');
      if (['force', 'recover'].includes(body.mode) && body.confirmInterruption !== true) throw Error('Explicit interruption confirmation required');
      const recovery = entries.find(e => e.sessionId === body.sessionId && e.status === 'recovery-needed');
      if (recovery) {
        if (body.mode !== 'recover' || body.pane !== recovery.pane) throw Error('Interrupted restart requires explicit recovery');
        recovery.status = 'queued'; recovery.reason = ''; save(); return recovery;
      }
      if (body.mode === 'recover') throw Error('No interrupted restart to recover');
      const existing = entries.find((e) => e.sessionId === body.sessionId && ['queued', 'restarting'].includes(e.status));
      if (body.mode === 'cancel') {
        if (existing?.status === 'restarting') throw Error('Restart has already started');
        if (existing?.original) throw Error('Interrupted restart requires explicit recovery');
        if (existing) { existing.status = 'cancelled'; save(); }
        return existing || { status: 'cancelled' };
      }
      if (existing) {
        if (existing.mode !== body.mode || existing.pane !== body.pane) throw Error('A different restart is already pending; cancel it first');
        return existing;
      }
      if (entries.filter((e) => ['queued', 'restarting', 'recovery-needed'].includes(e.status)).length >= 50) throw Error('Restart queue is full');
      const { session, pane } = await inspect(body);
      if (entries.some(e => e.sessionId === body.sessionId && e.status === 'recovery-needed')) throw Error('Interrupted restart requires explicit recovery');
      const raced = entries.find((e) => e.sessionId === body.sessionId && ['queued', 'restarting'].includes(e.status));
      if (raced) {
        if (raced.mode !== body.mode || raced.pane !== body.pane) throw Error('A different restart is already pending; cancel it first');
        return raced;
      }
      if (entries.filter((e) => ['queued', 'restarting', 'recovery-needed'].includes(e.status)).length >= 50) throw Error('Restart queue is full');
      if (!session || !pane?.alive || pane.meta?.sessionId !== body.sessionId) throw Error('Expected a live session in this pane');
      const entry = { sessionId: body.sessionId, pane: body.pane, pid: pane.pid, mode: body.mode, status: 'queued', at: Date.now(),
        ...(body.mode === 'force' ? { token: require('node:crypto').randomUUID() } : {}) };
      entries.push(entry); save();
      return body.mode === 'now' ? run(entry) : entry;
    },
    async tick() {
      if (busy) return;
      for (const entry of entries.filter((e) => e.status === 'queued')) {
        await run(entry);
        if (entry.status === 'done') break;
      }
    },
  };
}

module.exports = { isReviewer, refusal, read, createManager, RestartDeferred };
