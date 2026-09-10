'use strict';
const fs = require('node:fs'), path = require('node:path');

class RestartDeferred extends Error {}

function refusal(session, pane, queued = false) {
  if (!session || !pane?.alive || pane.meta?.sessionId !== session.id || !['claude', 'codex'].includes(pane.meta?.agent)) return 'Session is not live in its original pane';
  if (session.reviewer) return 'The fleet reviewer needs a coordinated restart';
  if (session.activity?.background?.scheduled?.length || session.backgroundJobs?.jobs?.some(j => j.kind === 'scheduled' && j.status === 'pending')) return 'Pause session-local scheduled jobs before restarting';
  if (session.endedTurn !== true || session.toolRunning || session.pendingBackground || session.waitingFor || session.rateLimit
      || session.unknownBackgroundJobs?.length || session.lifecycleAgents?.length
      || session.backgroundJobs?.jobs?.some(j => j.status === 'pending')
      || session.lifecycleForeground?.state === 'running' || session.lifecycleForeground?.state === 'waiting') return 'Waiting for the turn and background work to finish';
  if (session.pendingQuestion || session.pendingPlan || session.ownerQuestion
      || ['permission', 'question'].includes(session.notify?.type)
      || session.lifecycleForeground?.state === 'needs-input'
      || require('./session-status').proseRequest(session.lastAssistantFull || session.lastAssistant)
      || (session.activity?.needsInput && session.activity.reason !== 'next instruction')) return 'Waiting for pending input to be resolved';
  // Durable registry checks and dependencies survive resume. Displayed readiness
  // is not proof of process-local work; the close path verifies the actual prompt.
  if (queued && (pane.visibleAttached ?? pane.attached) !== 0) return 'Waiting until the pane is no longer being viewed';
  return null;
}

function read(file) {
  try { const rows = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(rows) ? rows : []; } catch { return []; }
}

function createManager({ file, inspect, restart, onChange = () => {} }) {
  let entries = read(file).map((entry) => entry.status === 'restarting'
    ? { ...entry, status: 'failed', reason: 'Daemon stopped during restart; inspect the session before retrying' } : entry);
  let busy = false;
  const save = () => {
    const active = (e) => ['queued', 'restarting'].includes(e.status);
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
    if (busy) return entry;
    busy = true;
    try {
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
      entry.status = entry.mode === 'idle' && error instanceof RestartDeferred ? 'queued' : 'failed';
      entry.reason = error.message; entry.at = Date.now(); save();
      return entry;
    } finally { busy = false; }
  };
  return {
    snapshot: () => entries.map((e) => ({ ...e })),
    async request(body) {
      if (!/^[a-z0-9_-]+$/i.test(body?.sessionId || '') || !/^[a-z0-9_-]+$/i.test(body?.pane || '') || !['now', 'idle', 'cancel'].includes(body.mode)) throw Error('Expected exact session, pane and restart mode');
      const existing = entries.find((e) => e.sessionId === body.sessionId && ['queued', 'restarting'].includes(e.status));
      if (body.mode === 'cancel') {
        if (existing?.status === 'restarting') throw Error('Restart has already started');
        if (existing) { existing.status = 'cancelled'; save(); }
        return existing || { status: 'cancelled' };
      }
      if (existing) return existing;
      if (entries.filter((e) => ['queued', 'restarting'].includes(e.status)).length >= 50) throw Error('Restart queue is full');
      const { session, pane } = await inspect(body);
      const raced = entries.find((e) => e.sessionId === body.sessionId && ['queued', 'restarting'].includes(e.status));
      if (raced) return raced;
      if (!session || !pane?.alive || pane.meta?.sessionId !== body.sessionId || session.reviewer) throw Error('Expected a live non-reviewer session in this pane');
      const entry = { sessionId: body.sessionId, pane: body.pane, pid: pane.pid, mode: body.mode, status: 'queued', at: Date.now() };
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

module.exports = { refusal, read, createManager, RestartDeferred };
