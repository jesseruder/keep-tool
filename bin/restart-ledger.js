'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const jobs = require('./background-jobs');
const ID = /^[a-z0-9_-]{1,160}$/i;
const terminal = new Set(['completed', 'failed', 'cancelled']);
class Recovering extends Error {}
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const evidenceKey = state => digest(JSON.stringify({ jobs: state.jobs, calls: state.calls, restart: state.restart,
  checkpoint: state.checkpoint, gap: state.gap, hookBarrier: state.hookBarrier, hookGeneration: state.hookGeneration, processEpoch: state.processEpoch }));

// A proof is bound to the exact files and process instance observed here. It
// does not authorize exit by itself: the caller still checks live descendants,
// current foreground state, viewers and the actual input prompt before typing.
function verify({ root, agent, sid, file, instance, resolveChild, budget = 4 * 1024 * 1024, allowTerminalRateLimit = false }) {
  const snapshots = new Map(), visiting = new Set();
  let remaining = budget;
  const load = (id, source, parentSource) => {
    const child = Boolean(parentSource);
    if (!ID.test(id || '') || !source) throw Error('Job ledger identity is unverified');
    fs.statSync(source); // Missing history is a hard failure, not bootstrap progress.
    if (remaining <= 0) throw new Recovering('Waiting for job ledger recovery');
    const result = jobs.sync({ root, agent, sid: id, file: source, instance: child ? null : instance,
      budget: Math.max(1, remaining), includeSidechain: child && agent === 'claude' });
    remaining -= result.bytesRead || 0;
    if (result.uncertain?.includes('ledger-busy') || result.recovering) throw new Recovering('Waiting for job ledger recovery');
    const snapshot = path.join(root, '.keep', 'background-jobs', agent, id, 'state.json');
    const state = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
    if (state.restartVersion !== 1 || state.gap || !state.restart) throw Error('Job ledger evidence is incomplete');
    const stat = fs.statSync(source), cp = state.checkpoint;
    if (!cp || cp.identity !== `${digest(path.resolve(source))}:${stat.dev}:${stat.ino}` || cp.offset !== stat.size || cp.mtime !== stat.mtimeMs) throw new Recovering('Waiting for job ledger recovery');
    if (state.hookBarrier != null && cp.offset <= state.hookBarrier) throw new Recovering('Waiting for hook activity to reach the job ledger');
    const inbox = path.join(path.dirname(snapshot), 'inbox');
    const key = evidenceKey(state);
    const check = () => {
      const current = fs.statSync(source);
      if (current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) throw Error('Job ledger source changed during restart');
      let entries = [];
      try { entries = fs.readdirSync(inbox); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (entries.length) throw Error('New hook activity arrived during restart');
      if (evidenceKey(JSON.parse(fs.readFileSync(snapshot, 'utf8'))) !== key) throw Error('Job ledger evidence changed during restart');
      if (child && resolveChild(id, parentSource) !== source) throw Error('Child job ledger source changed during restart');
    };
    check(); snapshots.set(source, check);
    return state;
  };
  const walk = (id, source, parent, depth, parentSource = null, acknowledgement = null) => {
    if (depth > 8 || snapshots.size >= 128 || visiting.has(id)) throw Error('Job ledger child graph is unverified');
    visiting.add(id);
    const state = load(id, source, parentSource), s = state.restart;
    if (agent === 'codex' && (s.id !== id || (parent && s.parent !== parent))) throw Error('Child job ledger ownership is unverified');
    if (agent === 'claude' && !parent && s.id !== id) throw Error('Job ledger session identity is unverified');
    // Old Claude child transcripts omit stop_reason. Require both their current
    // final text and a later, explicit parent completion observation. Neither
    // alone suffices; every child job/hook and source race is still checked.
    const acknowledgedFinal = parent && agent === 'claude' && s.finalTextAt > 0 && s.finalTextAt === s.observedAt
      && acknowledgement?.kind === 'agent' && acknowledgement.status === 'completed' && acknowledgement.evidence === 'transcript'
      && acknowledgement.eventAt >= s.observedAt;
    const abortedChild = parent && agent === 'codex' && s.aborted === true;
    const terminalRateLimit = allowTerminalRateLimit && !parent && agent === 'claude' && s.rateLimitTerminal === true;
    if ((!s.completed && !acknowledgedFinal && !abortedChild && !terminalRateLimit) || Object.keys(state.calls).length) throw Error('Job ledger turn is not verifiably complete');
    if (agent === 'codex' && parent && require('./codex').scanRollout(source, { includeChild: true })?.pendingQuestion) throw Error('Child has pending input');
    for (const job of Object.values(state.jobs)) {
      if (!terminal.has(job.status) && job.kind !== 'agent') throw Error(`Job ledger has unresolved ${job.kind} work (${job.id})`);
    }
    for (const launch of Object.keys(s.launches)) if (!s.mapped[launch]) throw Error('Child launch has no verified job ledger identity');
    for (const [child, kind] of Object.entries(s.children)) {
      if (!ID.test(child) || !resolveChild) throw Error('Child job ledger identity is unverified');
      const childFile = resolveChild(child, source);
      if (agent === 'codex' && kind === 'interacted') {
        const meta = childFile && require('./codex').readSessionMeta(childFile);
        if (!meta || (meta.id || meta.session_id) !== child) throw Error('Child job ledger ownership is unverified');
        const owner = meta.parent_thread_id || meta.source?.subagent?.thread_spawn?.parent_thread_id;
        if (owner !== id) continue; // Parent/sibling communication is not ownership.
      }
      walk(child, childFile, id, depth + 1, source, state.jobs[`job:${child}`]);
    }
    visiting.delete(id);
  };
  walk(sid, file, null, 0);
  const unchanged = () => { for (const check of snapshots.values()) check(); };
  unchanged();
  return unchanged;
}
module.exports = { verify, Recovering };
