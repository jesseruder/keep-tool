'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const restartEvidence = require('./restart-evidence');
const ID = /^[a-zA-Z0-9_-]{1,160}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
// History written to a file this ledger no longer reads, to a file rewritten
// under the checkpoint, or to a hook that named another transcript cannot come
// back; replaying the current file never restores it. invalid-ledger stays
// clearable: a full replay rebuilds every transcript-visible job, and only
// hook-only corroboration is lost with the unreadable snapshot.
const STICKY_GAP_REASONS = new Set(['transcript-replaced', 'checkpoint-anchor', 'hook-transcript-mismatch']);
// 3: the reducer reads `system`/local_command stdout and stderr rows as proof a
// typed slash command finished; older ledgers must replay to settle a failed /compact.
const restartVersion = agent => agent === 'claude' ? 3 : 1;
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const text = (v) => typeof v === 'string' ? v : Array.isArray(v) ? v.filter(x => ['text', 'input_text', 'output_text'].includes(x?.type)).map(x => x.text || '').join('\n') : '';

// Every gap records when and why it was marked so a cold replay can tell an
// inherited gap from one its own pass re-observed. Lost history outranks a later
// ordinary gap, so a sticky reason survives; the stamp always advances to the
// newest mark, which is the conservative end of the `gapAt < startedAt` test.
function markGap(state, now, reason) {
  const keepSticky = state.gap === true && STICKY_GAP_REASONS.has(state.gapReason) && !STICKY_GAP_REASONS.has(reason);
  state.gap = true;
  state.gapAt = now;
  if (!keepSticky) state.gapReason = reason;
}

// A `transcript-replaced` gap is sticky, so an auto-compacted session carries it
// forever and every non-forced restart or account transfer out of it refuses.
// That gap is safe to discount on its own. When the transcript is replaced, sync
// resets the checkpoint to offset 0, re-reads the entire new file, and retains
// every job that was non-terminal at that moment flagged
// `evidence: 'transcript-replaced'` -- so live work survives the replacement as
// an individually uncertain job rather than disappearing into the gap. A
// `transcript-replaced` gap with no open job, no unresolved call, no unconsumed
// hook evidence, a completed restart record and no recovery or cold replay in
// progress therefore stands only for history that predates the replacement and
// has no live work attached. That is the same evidence a forced restart already
// accepts, minus the parts force skips blindly (the restart record, the open
// jobs and the child graph, all of which are still checked here and by the
// callers). Only this reason qualifies: 'checkpoint-anchor' and
// 'hook-transcript-mismatch' can hide work the ledger never observed, a legacy
// gap carries no reason at all, and the non-sticky reasons clear themselves on
// a cold replay so they never need this door. A turn that the API ended by
// refusing it -- a terminal per-model rate limit -- leaves `restart.completed`
// false and `restart.rateLimitTerminal` true, because the agent never got to
// finish. That is an ended turn too, and it is the same end state
// restart-ledger.verify accepts under its own `allowTerminalRateLimit` flag, so
// this takes the option under the same name and only honours it when a caller
// passes it. `unconsumedHooks` has no default:
// a caller that cannot count the inbox must not get a settled verdict.
// Callers that know whether the ledger has read its source to EOF also require
// that (`caughtUp`); the ledger checks that separately where it matters.
// Residual: a launch written after the last checkpoint and dropped by the
// replacement is invisible to this ledger. A command that is still running is
// still a child process of the agent, which mcp-restart.inspect refuses before
// the source is stopped; an in-process agent lost that way is the same exposure
// a forced restart already accepts.
// `allowUnfinishedTurn` drops the ended-turn requirement for a caller that has
// verified the agent process is gone: a session killed mid-turn never records
// `restart.completed`, so its gap could otherwise never settle, yet a dead process
// has no turn left to launch anything from. Every other check still holds.
function settledGap(state, { unconsumedHooks, allowTerminalRateLimit = false, allowUnfinishedTurn = false } = {}) {
  if (!state || state.gap !== true || state.gapReason !== 'transcript-replaced') return false;
  if (state.recovering || state.coldReplay) return false;
  if (state.restart?.completed !== true && allowUnfinishedTurn !== true
      && !(allowTerminalRateLimit === true && state.restart?.rateLimitTerminal === true)) return false;
  if (unconsumedHooks !== 0) return false;
  if (!state.jobs || !state.calls || Object.keys(state.calls).length) return false;
  return !Object.values(state.jobs).some(j => !TERMINAL.has(j.status) && !['service', 'scheduled'].includes(j.kind));
}

// Scheduled jobs belong to an agent process, which may run inside a shell pane.
function processInstance(pane, agentPid = pane?.agentPid) {
  return pane && agentPid ? `${pane.id}:${pane.pid}:${agentPid}` : null;
}

function directory(root, agent, sid) {
  if (!['claude', 'codex'].includes(agent) || !ID.test(sid || '')) throw Error('Invalid job ledger identity');
  return path.join(root, '.keep', 'background-jobs', agent, sid);
}

function failure(message, code = 'KEEP_LEDGER_REBIND_UNSAFE') {
  const error = new Error(message); error.code = code; error.status = 409; return error;
}

function syncDirectory(target) {
  let fd;
  try { fd = fs.openSync(target, fs.constants.O_RDONLY); fs.fsyncSync(fd); } catch {}
  finally { if (fd != null) fs.closeSync(fd); }
}

function writeState(snapshot, state) {
  const temp = `${snapshot}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, snapshot); syncDirectory(path.dirname(snapshot));
}

function fileEvidence(file, content = false) {
  const resolved = path.resolve(file);
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw failure(`ledger transcript is not a regular file: ${resolved}`);
    const anchorBytes = Buffer.alloc(Math.min(64, before.size));
    fs.readSync(fd, anchorBytes, 0, anchorBytes.length, before.size - anchorBytes.length);
    let contentDigest = null;
    if (content) {
      const digest = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (position < before.size) {
        const size = fs.readSync(fd, buffer, 0, Math.min(buffer.length, before.size - position), position);
        if (!size) break;
        digest.update(buffer.subarray(0, size)); position += size;
      }
      if (position !== before.size) throw failure(`ledger transcript changed while reading: ${resolved}`);
      contentDigest = digest.digest('hex');
    }
    const after = fs.fstatSync(fd);
    for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) {
      if (before[field] !== after[field]) throw failure(`ledger transcript changed while reading: ${resolved}`);
    }
    return { file: resolved, identity: `${hash(resolved)}:${after.dev}:${after.ino}`, dev: after.dev, ino: after.ino,
      size: after.size, mtime: after.mtimeMs, ctime: after.ctimeMs, anchor: hash(anchorBytes), ...(contentDigest ? { contentDigest } : {}) };
  } finally { fs.closeSync(fd); }
}

// An abandoned child has no ledger or transcript left to rebind or verify.
function verifiableChildren(state) {
  return Object.keys(state.restart?.children || {})
    .filter((child) => state.jobs?.[`job:${child}`]?.evidence !== 'abandoned-child');
}

function sameFrozenFile(file, evidence) {
  if (!evidence || path.resolve(file) !== evidence.file) return false;
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.dev === evidence.dev && stat.ino === evidence.ino && stat.size === evidence.size
      && stat.mtimeMs === evidence.mtime && stat.ctimeMs === evidence.ctime;
  } catch { return false; }
}

// Called only after the handoff artifact transaction has verified an exact copy
// and the source process has exited. Ordinary sync never invokes this escape
// hatch: unrelated path/inode changes remain permanent gaps.
function rebindSource({ root, agent, sid, sourceFile, targetFile, transactionId, sourceStopVerifiedAt,
  force = false, allowTerminalRateLimit = false }) {
  if (!['claude', 'codex'].includes(agent) || !ID.test(sid || '') || !ID.test(transactionId || '')
      || !Number.isFinite(sourceStopVerifiedAt) || sourceStopVerifiedAt <= 0
      || !path.isAbsolute(sourceFile || '') || !path.isAbsolute(targetFile || '')
      || path.resolve(sourceFile) === path.resolve(targetFile)) throw failure('invalid ledger rebind request');
  const ledgerDir = directory(root, agent, sid), snapshot = path.join(ledgerDir, 'state.json');
  const lock = path.join(ledgerDir, 'writer.lock');
  let locked = false;
  for (let attempt = 0; attempt < 2 && !locked; attempt++) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); locked = true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let alive = true;
      try { process.kill(Number(fs.readFileSync(lock, 'utf8')), 0); } catch (cause) { if (cause.code === 'ESRCH') alive = false; }
      if (alive) throw failure('job ledger is busy during account handoff', 'KEEP_LEDGER_BUSY');
      try { fs.unlinkSync(lock); } catch {}
    }
  }
  if (!locked) throw failure('job ledger is busy during account handoff', 'KEEP_LEDGER_BUSY');
  try {
    const state = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
    // A forced handoff tolerates a gapped ledger and a missing restart record --
    // the same evidence restart-ledger.verify skips under force -- and carries the
    // gap into the rebound state; it then reports no children, so the caller
    // rebinds the root alone. The writer lock, the state version, an in-flight
    // recovery and unconsumed hook evidence still hold. A settled
    // `transcript-replaced` gap (see settledGap) is accepted without force: the
    // gap is then the ledger's only uncertainty and carries no live work, and
    // every other check below -- the checkpoint being caught up with the stopped
    // source, the content digests, the child graph -- still runs in full. The
    // gap itself is carried into the rebound state unchanged either way, because
    // nothing here writes state.gap.
    let entries = [];
    try { entries = fs.readdirSync(path.join(ledgerDir, 'inbox')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (state.version !== 1 || state.restartVersion !== restartVersion(agent) || !state.jobs || !state.calls
        || (!force && (!state.restart || (state.gap && !settledGap(state, { unconsumedHooks: entries.length, allowTerminalRateLimit }))))
        || state.recovering) throw failure('job ledger evidence is incomplete');
    if (entries.length) throw failure('job ledger has unconsumed hook evidence');
    const source = fileEvidence(sourceFile, true), target = fileEvidence(targetFile, true);
    if (source.dev === target.dev && source.ino === target.ino) {
      throw failure('handoff transcript source and target are the same physical file');
    }
    if (source.size !== target.size || source.contentDigest !== target.contentDigest) {
      throw failure('handoff transcript copy does not match the stopped source');
    }
    const prior = state.handoffRebind;
    if (prior?.transactionId === transactionId && prior.source?.file === source.file && prior.target?.file === target.file) {
      if (state.checkpoint?.identity !== target.identity || state.checkpoint.offset !== target.size
          || state.checkpoint.mtime !== target.mtime || state.checkpoint.anchor !== target.anchor
          || state.source?.file !== target.file) throw failure('completed ledger rebind no longer matches its target');
      return { reused: true, children: force ? [] : verifiableChildren(state) };
    }
    const checkpoint = state.checkpoint;
    if (!checkpoint || state.source?.agent !== agent || state.source.sid !== sid || path.resolve(state.source.file || '') !== source.file
        || checkpoint.identity !== source.identity || checkpoint.offset !== source.size
        || checkpoint.mtime !== source.mtime || checkpoint.anchor !== source.anchor
        || (state.hookBarrier != null && checkpoint.offset <= state.hookBarrier)) {
      throw failure('job ledger is not caught up with the stopped source');
    }
    state.checkpoint = { ...checkpoint, identity: target.identity, offset: target.size, anchor: target.anchor, mtime: target.mtime };
    state.source = { ...state.source, file: target.file };
    const priorSources = Array.isArray(prior?.retiredSources) ? prior.retiredSources : prior?.source ? [prior.source] : [];
    const retained = [...priorSources, source].filter((entry, index, all) => entry?.file !== target.file
      && all.findLastIndex((candidate) => candidate?.file === entry.file) === index).slice(-128);
    state.handoffRebind = { version: 1, transactionId, sourceStopVerifiedAt, source, target,
      retiredSources: retained, reboundAt: Date.now() };
    writeState(snapshot, state);
    // Under force the child graph is unverified evidence, so it is never reported.
    return { reused: false, children: force ? [] : verifiableChildren(state) };
  } finally { try { fs.unlinkSync(lock); } catch {} }
}

// Hook processes never edit the shared snapshot. Immutable inbox files survive
// daemon downtime; consumption and deletion happen only after snapshot commit.
function recordHook(root, agent, sid, event) {
  if (!/^(?:SubagentStart|SubagentStop|SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|PostToolUseFailure|Stop|Interrupt|PermissionRequest)$/.test(event.event) || !ID.test(event.entity || '')) return;
  const dir = path.join(directory(root, agent, sid), 'inbox');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const transcriptId = /^[a-f0-9]{64}$/.test(event.transcriptId || '') ? event.transcriptId : null;
  const row = { event: event.event, entity: event.entity, at: event.at, offset: event.offset,
    ...(transcriptId ? { transcriptId } : {}), ...(event.missing === true ? { missing: true } : {}),
    ...(event.event === 'SessionStart' && event.freshStart === true ? { freshStart: true } : {}) };
  const body = JSON.stringify(row);
  try { fs.writeFileSync(path.join(dir, hash(body) + '.json'), body, { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
}

function clearReplayObligation(state, id, run) {
  if (!run) return false;
  const retired = `superseded_${hash(`${id}:${run}`).slice(0, 24)}`;
  let cleared = false;
  for (const [key, job] of Object.entries(state.jobs)) {
    if ((key.startsWith('replay:') || key === `job:${retired}`)
        && job.run === run && (job.id === id || job.id === retired)) {
      delete state.jobs[key]; cleared = true;
    }
  }
  return cleared;
}

function update(state, id, kind, status, at, evidence, instance, run = '') {
  if (!ID.test(String(id || ''))) return;
  const key = `job:${id}`, old = state.jobs[key];
  if (!old && Object.keys(state.jobs).length >= 2500) { markGap(state, Date.now(), 'jobs-cap'); return; }
  const clearedRetained = TERMINAL.has(status) && run && clearReplayObligation(state, id, run);
  if (old && TERMINAL.has(status) && run && old.run && run !== old.run && clearedRetained) return;
  const placeholderRun = old?.evidence === 'hook' && old.run?.startsWith('hook:');
  const correlatedUnlaunched = run && state.calls[`call:${run}`];
  if (old && TERMINAL.has(status) && run && old.run && run !== old.run && !placeholderRun && !correlatedUnlaunched) return;
  const correlatedLateCompletion = old && TERMINAL.has(status) && run && (old.run === run || placeholderRun || correlatedUnlaunched);
  if (old && at < old.eventAt && !correlatedLateCompletion) return;
  if (TERMINAL.has(status) && !run && old?.run) clearReplayObligation(state, id, old.run);
  if (old && TERMINAL.has(status) && run && old.run && run !== old.run && !placeholderRun && !TERMINAL.has(old.status)) {
    // A completion correlated to a reused ID's new launch cannot retire the
    // unresolved earlier run. Keep the old obligation until its own evidence arrives.
    const retired = `superseded_${hash(`${id}:${old.run}`).slice(0, 24)}`;
    state.jobs[`job:${retired}`] = { ...old, id: retired, kind: 'unknown', evidence: 'superseded-unverified' };
  }
  // Replaying the same launch cannot revive its completed run.
  if (old && status === 'pending' && old.run === run && run) {
    if (old.kind === 'unknown' && kind) old.kind = kind;
    if (kind === 'agent' && state.restart) state.restart.children[id] = 'owned';
    return;
  }
  if (old && status === 'pending' && at <= old.eventAt && TERMINAL.has(old.status)) return;
  const owner = instance && typeof instance === 'object' ? (instance.since && at >= instance.since ? instance.id : null) : instance;
  if (old && status === 'pending' && run && old.run && run !== old.run && (!owner || old.instance !== owner) && !TERMINAL.has(old.status) && kind !== 'agent') {
    // Reusing an ID is not evidence that its previous run finished. Preserve
    // the old obligation separately; an ID-only completion cannot resolve it.
    const retired = `superseded_${hash(`${id}:${old.run}`).slice(0, 24)}`;
    state.jobs[`job:${retired}`] = { ...old, id: retired, kind: 'unknown', evidence: 'superseded-unverified' };
  }
  state.jobs[key] = { id: String(id), kind: kind || old?.kind || 'unknown', status,
    startedAt: status === 'pending' && (!old || old.run !== run) ? at : old?.startedAt ?? at,
    eventAt: Math.max(at, old?.eventAt || 0), evidence,
    instance: status === 'pending' && run !== old?.run ? owner || null : old?.instance || owner || null, run: run || old?.run || '' };
  for (const [retainedKey, retained] of Object.entries(state.jobs)) {
    if (retainedKey.startsWith('replay:') && retained.run && retained.run === state.jobs[`job:${retained.id}`]?.run) delete state.jobs[retainedKey];
  }
  if (kind === 'agent' && state.restart) state.restart.children[id] = 'owned';
}

function consume(state, row, agent, classify, instance) {
  if (!row || row.isSidechain) return;
  restartEvidence.consume(state, row, agent);
  const at = Date.parse(row.timestamp || '') || 0;
  const content = row.message?.content;
  const userTurn = agent === 'claude' ? row.type === 'user' && !row.isCompactSummary && !restartEvidence.isClaudeInterruption(row)
    && text(content) && !/^<(system-reminder|command-|local-command|task-notification|bash-)/.test(text(content))
    && (typeof content === 'string' || (Array.isArray(content) && content.some(b => b.type === 'text') && !content.some(b => b.type === 'tool_result')))
    : (row.type === 'event_msg' && ['task_started', 'user_message'].includes(row.payload?.type))
      || (row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user');
  if (userTurn) state.turnStartedAt = Math.max(state.turnStartedAt || 0, at);
  const start = (id, kind, run) => update(state, id, kind, 'pending', at, 'transcript', instance, run);
  const finish = (id, status = 'completed', run = '') => update(state, id, null, status, at, 'transcript', instance, run);
  const remember = (id, name, input) => {
    if (!ID.test(id || '')) return;
    // Only classification and target IDs survive; never persist arguments.
    const target = String(input?.task_id || input?.session_id || input?.cell_id || input?.id || '');
    state.calls[`call:${id}`] = { name: String(name || '').slice(0, 100), kind: classify(name, input),
      target: ID.test(target) ? target : '', at };
  };
  if (agent === 'claude') {
    const notification = row.type === 'queue-operation' ? row.content
      : row.type === 'attachment' && row.attachment?.type === 'queued_command' ? row.attachment.prompt
      : row.type === 'user' ? text(row.message?.content) : '';
    if (typeof notification === 'string' && notification.trimStart().startsWith('<task-notification>')) {
      const id = notification.match(/<task-id>([\w-]+)<\/task-id>/)?.[1];
      const run = notification.match(/<tool-use-id>([\w-]+)<\/tool-use-id>/)?.[1];
      const status = notification.match(/<status>(completed|failed|killed|stopped|cancelled)<\/status>/)?.[1];
      const legacy = !/<status>|<event>|<summary>Monitor event:/.test(notification);
      const timedOut = /\[Monitor timed out — re-arm if needed\.\]/.test(notification);
      const key = hash(notification.trim());
      if (id && !state.notices[key] && (status || legacy || timedOut)
          && (row.type !== 'queue-operation' || !row.operation || row.operation === 'enqueue')) {
        state.notices[key] = at;
        finish(id, status === 'failed' ? 'failed' : ['killed', 'stopped', 'cancelled'].includes(status) ? 'cancelled' : 'completed', run);
      }
    }
    for (const item of Array.isArray(row.message?.content) ? row.message.content : []) {
      if (item?.type === 'tool_use') remember(item.id, item.name, item.input);
      if (item?.type !== 'tool_result') continue;
      const call = state.calls[`call:${item.tool_use_id}`];
      delete state.calls[`call:${item.tool_use_id}`];
      const value = text(item.content);
      if (call?.name === 'CronCreate' && !item.is_error) {
        const match = value.match(/^Scheduled (recurring|one-shot) job ([\w-]+)\b/);
        if (match) {
          const id = `cron_${match[2]}`;
          start(id, 'scheduled', item.tool_use_id);
          const j = state.jobs[`job:${id}`];
          if (j && j.run === item.tool_use_id && j.status === 'pending') {
            j.expiresAt = at + 7 * 86400e3;
            j.recurring = match[1] === 'recurring';
          }
        }
      }
      if (call?.name === 'CronDelete' && !item.is_error && /^Cancelled job [\w-]+\./.test(value)) finish(`cron_${call.target}`, 'cancelled');
      let id = value.match(/^Command running in background with ID:\s*([\w-]+)/i)?.[1];
      if (id && !item.is_error) start(id, call?.kind || 'unknown', item.tool_use_id);
      id = value.includes('Async agent launched') && value.match(/agentId:\s*([\w-]+)/i)?.[1];
      if (id && !item.is_error) start(id, 'agent', item.tool_use_id);
      id = value.match(/^Monitor started \(task ([\w-]+)/i)?.[1];
      if (id && !item.is_error) start(id, 'finite', item.tool_use_id);
      if (call?.name === 'TaskStop' && !item.is_error && /successfully stopped/i.test(value)) finish(call.target, 'cancelled');
      if (call?.name === 'SendMessage' && !item.is_error) {
        try { const r = JSON.parse(value); if (r.success && r.resumedAgentId) start(r.resumedAgentId, 'agent', item.tool_use_id); } catch {}
      }
    }
  } else {
    const p = row.payload || {};
    if (row.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type)) {
      let input = {}, name = String(p.name || ''), polls = [];
      try { input = JSON.parse(p.arguments || p.input || '{}'); } catch {
        // Only a parsed straight-line print sequence proves output ownership.
        const code = String(p.input || '');
        polls = require('./code-mode-polls').polls(code);
      }
      remember(p.call_id, name, input);
      if (polls.length && state.calls[`call:${p.call_id}`]) state.calls[`call:${p.call_id}`].polls = polls;
    }
    if (row.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
      const call = state.calls[`call:${p.call_id}`]; delete state.calls[`call:${p.call_id}`];
      const value = text(p.output) || JSON.stringify(p.output || '');
      // Legacy string envelopes lack result-block ownership. Do not mistake a
      // completed wrapper for proof that a process it yielded has also ended.
      if (typeof p.output === 'string' && /^Script (?:completed|running)\b/.test(value)
          && /\n(?:Output|Final output):[\s\S]*(?:"session_id"\s*:\s*\d+|Process running with session ID|Script running with cell ID)/.test(value)) markGap(state, Date.now(), 'legacy-output-envelope');
      const pieces = Array.isArray(p.output) ? p.output.map(b => b?.text).filter(v => typeof v === 'string') : [value];
      const objects = pieces.flatMap(v => { try { const o = JSON.parse(v); return o && !Array.isArray(o) && typeof o === 'object' ? [o] : []; } catch { return []; } });
      // Only protocol headers and top-level tool-result fields are evidence.
      // Searching stdout for these strings invents jobs from printed examples.
      const header = (pieces[0] || '').split(/\n(?:Output|Final output):/)[0];
      const cell = header.match(/^Script running with cell ID\s*[: ]\s*([\w-]+)/i)?.[1];
      const headers = pieces.map(piece => piece.split(/\n(?:Output|Final output):/)[0]);
      const numeric = [...headers.map(h => h.match(/(?:^|\n)Process running with session ID\s*[: ]\s*(\d+)/i)?.[1]), ...objects.map(o => o.session_id)].filter(id => /^\d+$/.test(String(id)));
      for (const [raw, prefix] of [[cell, 'cell_'], ...numeric.map(id => [id, 'process_'])]) {
        if (raw == null) continue;
        const id = prefix + raw, old = state.jobs[`job:${id}`];
        // A delayed launch response (or poll) must not revive a completed run,
        // but a later, distinct launch may legitimately reuse the same ID.
        if (old && TERMINAL.has(old.status)
            && (!call || call.at <= old.eventAt || old.run === p.call_id || /(?:wait|write_stdin)$/.test(call.name))) continue;
        if (old && (call?.target === String(raw) || call?.polls?.some(poll => poll.target === String(raw))
            || /(?:wait|write_stdin)$/.test(call?.name || '') || (call && call.at <= old.eventAt))) old.lastCorroboratedAt = at;
        else start(id, call?.kind || 'unknown', p.call_id);
      }
      if (call?.polls?.length && /^Script completed\b/.test(header)) for (const poll of call.polls) {
        if (pieces.length !== poll.count + 1) continue;
        const result = pieces[poll.index], h = result.split(/\n(?:Output|Final output):/)[0];
        let obj; try { obj = JSON.parse(result); } catch {}
        const code = obj?.exit_code ?? h.match(/(?:^|\n)Process exited with code\s*(-?\d+)/i)?.[1];
        const pollId = (poll.name === 'wait' ? 'cell_' : 'process_') + poll.target;
        if (String(obj?.session_id) === poll.target || code != null || (poll.name === 'wait' && /^Script completed\b/.test(h))) {
          // This call was a poll, not a distinct launch of the reused ID.
          clearReplayObligation(state, pollId, p.call_id);
        }
        if (obj?.session_id != null || /(?:^|\n)(?:Script running with cell ID|Process running with session ID)/.test(h)) continue;
        if ((poll.name === 'wait' && /^Script completed\b/.test(h)) || code != null) finish((poll.name === 'wait' ? 'cell_' : 'process_') + poll.target, Number(code || 0) ? 'failed' : 'completed');
      }
      const exitCode = objects.find(o => o.exit_code != null)?.exit_code ?? header.match(/(?:^|\n)Process exited with code\s*(-?\d+)/i)?.[1];
      if (call?.target && /(?:wait|write_stdin)$/.test(call.name)
          && !call?.polls?.length && cell == null
          && ((/wait$/.test(call.name) && /^Script completed/i.test(header)) || (!numeric.length && exitCode != null))) finish((/write_stdin$/.test(call.name) ? 'process_' : 'cell_') + call.target, Number(exitCode || 0) ? 'failed' : 'completed');
    }
    const item = p.item;
    if (row.type === 'event_msg' && item?.type === 'CommandExecution' && ID.test(String(item.process_id || ''))) {
      const id = `process_${item.process_id}`;
      if (p.type === 'item_completed' || ['completed', 'failed', 'cancelled'].includes(item.status)) finish(id, item.status === 'failed' || item.exit_code ? 'failed' : 'completed');
      else if (p.type === 'item_started') start(id, classify('Bash', { command: (item.command || []).join(' '), run_in_background: true }), item.id);
    }
    if (row.type === 'event_msg' && item?.type === 'SubAgentActivity') {
      if (item.kind === 'started') start(item.agent_thread_id, 'agent', item.id);
      else if (item.kind === 'completed') finish(item.agent_thread_id);
    }
  }
}

// Replaying from offset 0 keeps every unresolved obligation plus agent history,
// and rebuilds the restart observations the replay itself re-derives.
function retainForReplay(state, gap) {
  const jobs = Object.fromEntries(Object.entries(state.jobs).filter(([, j]) => gap || !TERMINAL.has(j.status) || j.kind === 'agent'));
  if (!state.source?.instance?.processScoped) for (const j of Object.values(jobs)) j.instance = null;
  const prior = state.restart || {};
  return { jobs,
    restart: { completed: false,
      children: { ...(prior.children || {}), ...Object.fromEntries(Object.values(jobs).filter(j => j.kind === 'agent').map(j => [j.id, 'owned'])) },
      launches: { ...(prior.launches || {}) }, mapped: { ...(prior.mapped || {}) } } };
}

function sync({ root, agent, sid, file, instance = null, classify = () => 'unknown', inspectAgent, childTranscriptFor, includeSidechain = false, now = Date.now(), budget = 4 * 1024 * 1024, maxRecord = 32 * 1024 * 1024, staleAfter = 30 * 60e3, coldReplay = false, abandonAfter = 3 * 3600e3 }) {
  const dir = directory(root, agent, sid);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const snapshot = path.join(dir, 'state.json'), lock = path.join(dir, 'writer.lock');
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let alive = true;
    try { process.kill(Number(fs.readFileSync(lock, 'utf8')), 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (!alive) { try { fs.unlinkSync(lock); } catch {} }
    return { pending: false, uncertain: ['ledger-busy'], jobs: [] };
  }
  try {
    let state = { version: 1, jobs: {}, calls: {}, notices: {}, checkpoint: null, gap: false };
    try { state = JSON.parse(fs.readFileSync(snapshot, 'utf8')); if (state.version !== 1 || !state.jobs || !state.calls || !state.notices) throw Error('invalid ledger'); }
    catch (e) {
      state = { version: 1, jobs: {}, calls: {}, notices: {}, checkpoint: null, gap: false };
      if (e.code !== 'ENOENT') markGap(state, now, 'invalid-ledger');
    }
    // A gap from before this bookkeeping has no reason on record; the transcript
    // is the only history such a ledger has, so a full replay is its best evidence.
    const legacyGap = Boolean(state.gap) && state.gapAt === undefined;
    if (legacyGap) markGap(state, now, 'legacy');
    const retiredSources = Array.isArray(state.handoffRebind?.retiredSources)
      ? state.handoffRebind.retiredSources.slice(0, 128) : state.handoffRebind?.source ? [state.handoffRebind.source] : [];
    const formerSource = retiredSources.find((entry) => entry?.file && path.resolve(file) === entry.file);
    if (formerSource) {
      if (!sameFrozenFile(file, formerSource)) { markGap(state, now, 'frozen-source-changed'); writeState(snapshot, state); }
      const currentJobs = Object.values(state.jobs);
      const open = currentJobs.filter(j => !TERMINAL.has(j.status) && !['service', 'scheduled'].includes(j.kind));
      const uncertain = open.filter(j => j.kind === 'unknown' || now - (j.lastCorroboratedAt || j.eventAt) > staleAfter
        || j.evidence === 'transcript-replaced').map(j => j.id);
      if (state.recovering || state.gap) uncertain.push(state.recovering ? 'history-recovery' : 'history-gap');
      // This file is a retired source; the live ledger is at state.source. The
      // inbox is not consumed on this path, so count what is waiting in it.
      let pendingHooks = 0;
      try { pendingHooks = fs.readdirSync(path.join(dir, 'inbox')).length; }
      catch (error) { if (error.code !== 'ENOENT') pendingHooks = 1; }
      return { pending: open.some(j => !uncertain.includes(j.id)), uncertain,
        jobs: currentJobs.map(j => ({ ...j, confidence: TERMINAL.has(j.status) ? 'observed' : uncertain.includes(j.id) ? 'uncertain' : 'observed' })),
        recovering: Boolean(state.recovering), gap: Boolean(state.gap), gapReason: state.gapReason,
        // A summary only says whether the gap still hides work; whether a
        // rate-limited session may be stopped at all is the session-level
        // rateLimit check and the caller's own allowTerminalRateLimit flag
        // (serve.js terminalLimit, restart-ledger.verify, rebindSource), so the
        // summary has no reason to withhold the verdict from them.
        gapSettled: settledGap(state, { unconsumedHooks: pendingHooks, allowTerminalRateLimit: true }),
        gapClearedAt: state.gapClearedAt, lastColdReplayAt: state.lastColdReplayAt,
        bytesRead: 0, lastReconciledAt: state.lastReconciledAt,
        redirect: state.source };
    }
    if (state.source?.includeSidechain) includeSidechain = true;
    if ((agent === 'codex' && state.pollVersion !== 2) || state.childStopVersion !== 3) {
      // Reinterpret old code-mode polls, retaining every unresolved obligation
      // until a correlated replay proves it finished or was only a poll.
      if (state.checkpoint) {
        let fd;
        try {
          fd = fs.openSync(file, 'r');
          const stat = fs.fstatSync(fd), cp = state.checkpoint, b = Buffer.alloc(Math.min(64, cp.offset));
          fs.readSync(fd, b, 0, b.length, cp.offset - b.length);
          if (cp.identity !== `${hash(path.resolve(file))}:${stat.dev}:${stat.ino}` || cp.offset > stat.size || hash(b) !== cp.anchor) markGap(state, now, 'checkpoint-anchor');
        } catch { markGap(state, now, 'read-error'); }
        finally { if (fd != null) fs.closeSync(fd); }
      }
      state.jobs = Object.fromEntries(Object.entries(state.jobs).filter(([, j]) => !TERMINAL.has(j.status) || j.kind === 'agent')
        .map(([key, j]) => [key.startsWith('replay:') ? key : `replay:${key}`, j]));
      state.checkpoint = null; state.calls = {}; state.notices = {};
      // Rebuild ordered turn observations from the beginning, not from the
      // previous end-of-file state. Keep ownership obligations until replay.
      if (state.restart) {
        for (const key of ['observedAt', 'finalTextAt', 'finalTextBlocked', 'finalTextSeen', 'aborted']) delete state.restart[key];
        state.restart.completed = false;
      }
      state.pollVersion = 2;
      state.childStopVersion = 3;
    }
    // One cold replay when the evidence contract changes. Do not mix old
    // tombstones/notice deduplication with the new reducer's recovery cursor.
    if (state.restartVersion !== restartVersion(agent)) {
      const migration = { gap: state.gap, gapAt: state.gapAt, gapReason: state.gapReason };
      if (state.checkpoint) {
        let fd;
        try {
          fd = fs.openSync(file, 'r');
          const stat = fs.fstatSync(fd), cp = state.checkpoint;
          const b = Buffer.alloc(Math.min(64, cp.offset));
          fs.readSync(fd, b, 0, b.length, cp.offset - b.length);
          if (cp.identity !== `${hash(path.resolve(file))}:${stat.dev}:${stat.ino}` || cp.offset > stat.size || hash(b) !== cp.anchor) markGap(migration, now, 'checkpoint-anchor');
        } catch { markGap(migration, now, 'read-error'); }
        finally { if (fd != null) fs.closeSync(fd); }
      }
      const { jobs: retained, restart } = retainForReplay(state, migration.gap);
      state = { version: 1, restartVersion: restartVersion(agent), jobs: retained, calls: {}, notices: {}, checkpoint: null,
        gap: Boolean(migration.gap), ...(migration.gap ? { gapAt: migration.gapAt, gapReason: migration.gapReason } : {}),
        restart,
        cronVersion: 1, turnVersion: 1, pollVersion: agent === 'codex' ? 2 : undefined, childStopVersion: 3,
        source: state.source, processEpoch: state.processEpoch, hookBarrier: state.hookBarrier,
        hookGeneration: state.hookGeneration, freshStartup: state.freshStartup, handoffRebind: state.handoffRebind };
    }
    // New Claude adapter evidence needs one replay; preserve existing job history.
    if (agent === 'claude' && (state.cronVersion !== 1 || state.turnVersion !== 1)) {
      state.checkpoint = null; state.calls = {}; state.notices = {}; state.turnStartedAt = null;
      state.cronVersion = 1; state.turnVersion = 1;
    }
    // A gapped ledger only regains complete evidence by replaying the whole
    // transcript; the gap clears at EOF unless this replay re-marks one.
    if (coldReplay && state.gap && !state.coldReplay && !legacyGap) {
      let fromIdentity = null;
      try { const stat = fs.statSync(file); fromIdentity = `${hash(path.resolve(file))}:${stat.dev}:${stat.ino}`; } catch {}
      if (fromIdentity) {
        const { jobs: retained, restart } = retainForReplay(state, true);
        state.jobs = retained; state.restart = restart;
        state.checkpoint = null; state.calls = {}; state.notices = {}; state.turnStartedAt = null;
        state.coldReplay = { startedAt: now, fromIdentity };
        state.lastColdReplayAt = now;
      }
    }
    const freshBaseEligible = !state.checkpoint && !state.gap && state.hookBarrier == null;
    let recovering = false, bytesRead = 0, sourceCaughtUp = false, sourceIdentity = null;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const stat = fs.fstatSync(fd), identity = `${hash(path.resolve(file))}:${stat.dev}:${stat.ino}`;
        sourceIdentity = identity;
        // On first observation of a process, historical launches have unknown
        // ownership. Only events appended after this watermark belong to it.
        // Never relabel old work as belonging to a newly resumed agent.
        if (instance?.processScoped && instance.id && state.processEpoch?.id !== instance.id) {
          state.processEpoch = { id: instance.id, from: stat.size, identity };
        }
        const anchor = (offset) => { const b = Buffer.alloc(Math.min(64, offset)); fs.readSync(fd, b, 0, b.length, offset - b.length); return hash(b); };
        let cp = state.checkpoint;
        if (!cp || cp.identity !== identity || cp.offset > stat.size || anchor(cp.offset) !== cp.anchor
            || (cp.offset === stat.size && cp.mtime !== stat.mtimeMs)) {
          if (cp) { markGap(state, now, 'transcript-replaced'); state.turnStartedAt = null; for (const j of Object.values(state.jobs)) if (!TERMINAL.has(j.status)) j.evidence = 'transcript-replaced'; }
          cp = { identity, offset: 0, skip: false }; state.calls = {};
        }
        let b = Buffer.alloc(Math.min(budget, stat.size - cp.offset));
        bytesRead = fs.readSync(fd, b, 0, b.length, cp.offset);
        // A large single result must not poison an otherwise complete history.
        // The per-tick budget is soft for one record, with a hard record cap.
        if (!cp.skip && bytesRead === budget && b.indexOf(10) < 0 && maxRecord > budget) {
          b = Buffer.alloc(Math.min(maxRecord, stat.size - cp.offset));
          bytesRead = fs.readSync(fd, b, 0, b.length, cp.offset);
        }
        let start = 0, end;
        while ((end = b.indexOf(10, start)) >= 0 && end < bytesRead) {
          if (cp.skip) cp.skip = false;
          else if (end > start) {
            try {
              const row = JSON.parse(b.subarray(start, end).toString('utf8'));
              const owner = instance?.processScoped
                ? state.processEpoch?.identity === identity && cp.offset + start >= state.processEpoch.from ? instance.id : null
                : instance;
              consume(state, includeSidechain ? { ...row, isSidechain: false } : row, agent, classify, owner);
            }
            catch { markGap(state, now, 'record-parse'); }
          }
          start = end + 1;
        }
        if (start === 0 && bytesRead >= (cp.skip ? budget : Math.max(budget, maxRecord))) { start = bytesRead; cp.skip = true; markGap(state, now, 'budget-skip'); }
        cp.offset += start; cp.anchor = anchor(cp.offset); cp.mtime = stat.mtimeMs; state.checkpoint = cp;
        recovering = cp.offset < stat.size;
        sourceCaughtUp = !recovering && cp.offset === stat.size && cp.mtime === stat.mtimeMs;
      } finally { fs.closeSync(fd); }
    } catch { recovering = true; }
    const inbox = path.join(dir, 'inbox');
    let consumed = [];
    try {
      consumed = fs.readdirSync(inbox).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).slice(0, 1000);
      const eventOrder = { SessionStart: 0, UserPromptSubmit: 1 };
      const events = consumed.map(n => JSON.parse(fs.readFileSync(path.join(inbox, n), 'utf8')))
        .sort((a, b) => a.at - b.at || (eventOrder[a.event] ?? 2) - (eventOrder[b.event] ?? 2));
      if (events.length) state.hookGeneration = (state.hookGeneration || 0) + events.length;
      const expectedTranscriptId = hash(path.resolve(file));
      for (const e of events) {
        if (e.event === 'SubagentStart') update(state, e.entity, 'agent', 'pending', e.at, 'hook', instance?.processScoped ? null : instance, `hook:${e.at}`);
        if (['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Interrupt', 'PermissionRequest'].includes(e.event)) {
          // A hook bridges the period before the transcript is flushed. Stop
          // alone never clears this barrier: it may be blocked by another hook.
          if (Number.isFinite(e.offset)) state.hookBarrier = Math.max(state.hookBarrier ?? -1, e.offset);
          else {
            const repeatedFreshStart = state.freshStartup?.transcriptId === expectedTranscriptId
              && state.freshStartup.at === e.at;
            const freshStart = e.event === 'SessionStart' && e.freshStart === true && e.missing === true
              && e.transcriptId === expectedTranscriptId && (freshBaseEligible || repeatedFreshStart);
            if (freshStart) {
              if (!repeatedFreshStart) state.freshStartup = { transcriptId: expectedTranscriptId, at: e.at, promptAt: null };
              state.hookBarrier = Math.max(state.hookBarrier ?? -1, 0);
            } else {
              const freshPrompt = e.event === 'UserPromptSubmit' && e.missing === true && e.transcriptId === expectedTranscriptId
                && state.freshStartup?.transcriptId === expectedTranscriptId
                && (state.freshStartup.promptAt === e.at
                  || (state.freshStartup.promptAt == null && e.at >= state.freshStartup.at));
              if (freshPrompt) { state.freshStartup.promptAt ??= e.at; state.hookBarrier = Math.max(state.hookBarrier ?? -1, 0); }
              else markGap(state, now, 'hook-transcript-mismatch');
            }
          }
          if (e.event === 'SessionStart' && !(e.freshStart === true && e.missing === true && e.transcriptId === expectedTranscriptId)) {
            delete state.freshStartup;
          }
        }
        // Stop hooks can be blocked. They are not completion evidence.
      }
    } catch (error) { if (error.code !== 'ENOENT') markGap(state, now, 'read-error'); consumed = []; }
    const caughtUp = sourceCaughtUp && (state.hookBarrier == null || state.checkpoint.offset > state.hookBarrier);
    // Abandonment is a conclusion about the whole history: never draw it from a
    // partial pass, or one whose hook evidence has not reached the transcript,
    // when the unread bytes may still carry the child's completion.
    const settledPass = caughtUp && !recovering && !state.coldReplay;
    for (const j of Object.values(state.jobs)) {
      if (j.kind === 'scheduled' && !TERMINAL.has(j.status)) {
        if (j.expiresAt <= now || (instance && typeof instance === 'object' && (instance.live === false || (instance.id && j.instance && j.instance !== instance.id)))) {
          update(state, j.id, 'scheduled', 'cancelled', now, 'schedule-lifetime', instance);
        }
      }
      if (j.kind !== 'agent' || TERMINAL.has(j.status) || !inspectAgent) continue;
      let childAt = null;
      try {
        const evidence = inspectAgent(j.id);
        if (evidence && Number.isFinite(evidence.at)) childAt = evidence.at;
        if (evidence && evidence.at >= j.eventAt) {
          if (evidence.done) update(state, j.id, 'agent', 'completed', evidence.at, 'child-transcript', instance);
          else { j.lastCorroboratedAt = evidence.at; j.evidence = 'child-transcript'; }
        }
      } catch {} // Missing child evidence remains uncertain, not completed.
      // A parent that finished its own turn after the child stopped writing is
      // evidence the subagent died, not that it is still working. A subagent has
      // no process of its own, so its transcript writes and the parent's
      // completed turn are the only liveness evidence there is. Residual risk: a
      // child running one tool call for longer than abandonAfter without writing
      // its transcript is abandoned while alive -- 3h exceeds every built-in
      // tool timeout, so that needs a tool that blocks far past its own limit.
      if (!settledPass || state.jobs[`job:${j.id}`] !== j || TERMINAL.has(j.status)) continue;
      const activeAt = childAt ?? (j.lastCorroboratedAt || j.eventAt);
      if (state.restart?.completed !== true || !(state.restart.observedAt > activeAt)
          || now - activeAt <= abandonAfter || now - j.eventAt <= abandonAfter) continue;
      // Resolved only once everything else already says abandoned: a missing
      // child file falls back to the launch time, a present one must be stale.
      let wroteAt = j.eventAt;
      const childFile = childTranscriptFor?.(j.id);
      if (childFile) { try { wroteAt = fs.statSync(childFile).mtimeMs; } catch {} }
      if (now - wroteAt > abandonAfter) {
        update(state, j.id, 'agent', 'cancelled', now, 'abandoned-child', instance);
        const abandoned = state.jobs[`job:${j.id}`];
        if (abandoned && abandoned.evidence === 'abandoned-child') abandoned.abandonedAt = now;
      }
    }
    const terminal = Object.entries(state.jobs).filter(([, j]) => TERMINAL.has(j.status)).sort((a, b) => b[1].eventAt - a[1].eventAt);
    if (!Object.keys(state.calls).length && !Object.values(state.jobs).some(j => j.id.startsWith('cell_') && j.status === 'pending')) {
      // An abandoned child's tombstone is what lets restart and rebind skip a
      // child the parent still names. Pruning it would revive that obligation.
      for (const [key, j] of terminal.slice(500)) {
        if (j.evidence === 'abandoned-child' && state.restart?.children?.[j.id]) continue;
        delete state.jobs[key];
      }
    }
    for (const field of ['calls', 'notices']) {
      const keys = Object.keys(state[field]);
      if (keys.length > 2000) { markGap(state, now, `${field}-cap`); for (const key of keys.slice(0, keys.length - 2000)) delete state[field][key]; }
    }
    const jobs = Object.values(state.jobs);
    if (jobs.length > 2500) markGap(state, now, 'jobs-cap');
    if (state.coldReplay) {
      const held = sourceIdentity === state.coldReplay.fromIdentity;
      const remarked = state.gapAt !== undefined && state.gapAt >= state.coldReplay.startedAt;
      const finished = held && sourceCaughtUp && !recovering && state.checkpoint?.skip !== true
        && !consumed.length && !Object.keys(state.calls).length;
      // Only a clean replay of the same file back to EOF restores the evidence
      // the gap stands for; anything less leaves the gap for a later attempt.
      if (finished && !remarked && !STICKY_GAP_REASONS.has(state.gapReason)) {
        state.gap = false; delete state.gapAt; delete state.gapReason;
        state.gapClearedAt = now; state.gapClearedBy = 'cold-replay';
      }
      if (finished || !held || remarked) delete state.coldReplay;
    }
    state.lastReconciledAt = now;
    state.source = { agent, sid, file, instance, includeSidechain };
    state.recovering = recovering;
    const tmp = path.join(dir, `state.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(tmp, snapshot);
    for (const name of consumed) try { fs.unlinkSync(path.join(inbox, name)); } catch {}
    const open = jobs.filter(j => !TERMINAL.has(j.status) && !['service', 'scheduled'].includes(j.kind));
    const uncertain = open.filter(j => j.kind === 'unknown' || now - (j.lastCorroboratedAt || j.eventAt) > staleAfter || j.evidence === 'transcript-replaced').map(j => j.id);
    if (recovering || state.gap) uncertain.push(recovering ? 'history-recovery' : 'history-gap');
    return { pending: open.some(j => !uncertain.includes(j.id)), uncertain,
      jobs: jobs.map(j => ({ ...j, confidence: TERMINAL.has(j.status) ? 'observed' : uncertain.includes(j.id) ? 'uncertain' : 'observed' })),
      recovering, gap: state.gap, gapReason: state.gapReason, gapClearedAt: state.gapClearedAt,
      // A ledger that has not read its source to EOF may still be hiding live
      // work behind the gap, so a settled verdict also requires being caught up.
      // The verdict covers a turn the API ended with a terminal rate limit too;
      // see the retired-source summary above for why the summary may report it.
      gapSettled: caughtUp === true && settledGap(state, { unconsumedHooks: consumed.length, allowTerminalRateLimit: true }),
      // Only for a caller that has verified the agent process exited (see settledGap).
      gapSettledIfExited: caughtUp === true && settledGap(state, { unconsumedHooks: consumed.length, allowUnfinishedTurn: true }),
      lastColdReplayAt: state.lastColdReplayAt, caughtUp, unresolvedCalls: Object.keys(state.calls).length,
      unconsumedHooks: consumed.length, bytesRead, lastReconciledAt: now };
  } finally { try { fs.unlinkSync(lock); } catch {} }
}

function read(root, agent, sid, now = Date.now(), staleAfter = 30 * 60e3) {
  try {
    const dir = directory(root, agent, sid);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    const jobs = Object.values(state.jobs);
    const open = jobs.filter(j => !TERMINAL.has(j.status) && !['service', 'scheduled'].includes(j.kind));
    const uncertain = open.filter(j => j.kind === 'unknown' || now - (j.lastCorroboratedAt || j.eventAt) > staleAfter || j.evidence === 'transcript-replaced').map(j => j.id);
    if (state.recovering || state.gap) uncertain.push(state.recovering ? 'history-recovery' : 'history-gap');
    let caughtUp = false;
    try { const s = fs.statSync(state.source.file); caughtUp = !state.recovering && state.checkpoint.offset === s.size && state.checkpoint.mtime === s.mtimeMs; } catch {}
    let unconsumedHooks = 0, inboxReadable = true;
    try { unconsumedHooks = fs.readdirSync(path.join(dir, 'inbox')).length; }
    catch (error) { if (error.code !== 'ENOENT') inboxReadable = false; }
    return { pending: open.some(j => !uncertain.includes(j.id)), uncertain, jobs, caughtUp,
      recovering: Boolean(state.recovering), gap: Boolean(state.gap), gapReason: state.gapReason,
      // This is the ledger view the dashboard puts on session.backgroundJobs, so
      // it is the one the restart/transfer refusal reads. An inbox that cannot
      // be read yields no hook count, so the gap cannot settle on it. It reports
      // a terminal rate limit as settled too: see the retired-source summary
      // above -- the session-level rateLimit check, not this field, decides
      // whether a rate-limited session may be stopped.
      gapSettled: caughtUp === true && settledGap(state, { unconsumedHooks: inboxReadable ? unconsumedHooks : undefined, allowTerminalRateLimit: true }),
      gapSettledIfExited: caughtUp === true
        && settledGap(state, { unconsumedHooks: inboxReadable ? unconsumedHooks : undefined, allowUnfinishedTurn: true }),
      gapClearedAt: state.gapClearedAt, lastColdReplayAt: state.lastColdReplayAt,
      unresolvedCalls: Object.keys(state.calls || {}).length,
      unconsumedHooks,
      turnStartedAt: state.turnStartedAt || null, lastReconciledAt: state.lastReconciledAt };
  } catch { return { pending: false, uncertain: ['history-recovery'], jobs: [] }; }
}

function targets(root) {
  const result = [];
  for (const agent of ['claude', 'codex']) {
    const dir = path.join(root, '.keep', 'background-jobs', agent);
    let ids = []; try { ids = fs.readdirSync(dir); } catch {}
    for (const sid of ids.filter(id => ID.test(id))) {
      try {
        const state = JSON.parse(fs.readFileSync(path.join(dir, sid, 'state.json'), 'utf8'));
        if (state.source && Object.values(state.jobs).some(j => !TERMINAL.has(j.status))) result.push(state.source);
      } catch {}
    }
  }
  return result;
}

// Give live conversations three quarters of the bounded I/O ticks. Cold fleet
// history still advances without delaying a live 300MB recovery behind every card.
function nextTarget(targets, cursor) {
  const live = targets.filter(target => target.instance?.live === true);
  if (!live.length) return targets[cursor % targets.length];
  if (live.length && cursor % 4 !== 3) return live[(Math.floor(cursor / 4) * 3 + cursor % 4) % live.length];
  return targets[Math.floor(cursor / 4) % targets.length];
}

function targetKey(target) {
  return `${target?.agent || ''}:${target?.sid || ''}`;
}

function targetFingerprint(target) {
  const instance = target?.instance || {};
  return JSON.stringify([target?.agent || null, target?.sid || null,
    target?.file ? path.resolve(target.file) : null, target?.includeSidechain === true,
    target?.sourceFingerprint || null,
    instance.id || null, instance.processScoped === true, instance.live ?? null]);
}

function settledResult(target, result) {
  return target?.instance?.live === false
    && result?.caughtUp === true
    && result?.recovering === false
    && result?.gap === false
    && result?.pending === false
    && Array.isArray(result.uncertain) && result.uncertain.length === 0
    && result?.unresolvedCalls === 0
    && result?.unconsumedHooks === 0
    && Array.isArray(result.jobs)
    && result.jobs.every((job) => TERMINAL.has(job.status));
}

// Active ledgers retain the existing 500ms round-robin. Settled exited ledgers
// leave that loop until a source/inbox/host event wakes them; one parked ledger
// gets a fallback probe every fallbackSlotTicks to cover dropped fs.watch events.
function createScheduler(options = {}) {
  const active = new Map();
  const parked = new Map();
  const fallbackMs = Math.max(1000, Number(options.fallbackMs) || 10 * 60e3);
  const fallbackSlotTicks = Math.max(1, Number(options.fallbackSlotTicks) || 20);
  let cursor = 0;
  let ticks = 0;
  const stats = { registered: 0, selected: 0, parked: 0, woken: 0, fallback: 0 };

  function register(target) {
    const key = targetKey(target);
    if (!target?.file || !['claude', 'codex'].includes(target.agent) || !ID.test(target.sid || '')) return false;
    const fingerprint = targetFingerprint(target);
    const sleeping = parked.get(key);
    if (sleeping && sleeping.fingerprint === fingerprint) {
      sleeping.target = target;
      return false;
    }
    if (sleeping) { parked.delete(key); stats.woken++; }
    const current = active.get(key);
    if (current?.fingerprint === fingerprint) { current.target = target; return false; }
    active.set(key, { target, fingerprint });
    stats.registered++;
    return true;
  }

  function wake(key) {
    const sleeping = parked.get(key);
    if (!sleeping) return false;
    parked.delete(key);
    active.set(key, { target: sleeping.target, fingerprint: sleeping.fingerprint });
    stats.woken++;
    return true;
  }

  function wakeFile(file) {
    let resolved;
    try { resolved = path.resolve(file); } catch { return 0; }
    let count = 0;
    for (const [key, entry] of parked) {
      if (path.resolve(entry.target.file) === resolved && wake(key)) count++;
    }
    return count;
  }

  function wakeInbox(relativeName) {
    const parts = String(relativeName || '').split(/[\\/]+/);
    if (parts.length < 4 || parts[2] !== 'inbox') return false;
    return wake(`${parts[0]}:${parts[1]}`);
  }

  function select(now = Date.now()) {
    ticks++;
    const fallbackDue = ticks % fallbackSlotTicks === 0 || active.size === 0;
    if (fallbackDue) {
      for (const [key, entry] of parked) {
        if (now < entry.probeAt) continue;
        parked.delete(key);
        active.set(key, { target: entry.target, fingerprint: entry.fingerprint });
        stats.fallback++;
        stats.selected++;
        return { key, target: entry.target, fallback: true };
      }
    }
    if (!active.size) return null;
    const rows = [...active.values()].map((entry) => entry.target);
    const target = nextTarget(rows, cursor++);
    stats.selected++;
    return { key: targetKey(target), target, fallback: false };
  }

  function observe(key, target, result, now = Date.now()) {
    if (result?.redirect?.agent === target?.agent && result.redirect.sid === target.sid && result.redirect.file) {
      active.delete(key);
      parked.delete(key);
      register(result.redirect);
      return 'redirected';
    }
    if (!settledResult(target, result)) return 'active';
    active.delete(key);
    const fingerprint = targetFingerprint(target);
    // Stable jitter prevents a daemon start from lining up every fallback read.
    let jitter = 0;
    for (const char of key) jitter = (jitter * 33 + char.charCodeAt(0)) >>> 0;
    parked.set(key, { target, fingerprint, probeAt: now + fallbackMs + (jitter % Math.max(1, Math.floor(fallbackMs / 2))) });
    stats.parked++;
    return 'parked';
  }

  return {
    register, wake, wakeFile, wakeInbox, select, observe,
    stats: () => ({ ...stats, active: active.size, parked: parked.size }),
  };
}

module.exports = { restartVersion, processInstance, sync, read, targets, recordHook, consume, markGap, settledGap, nextTarget, rebindSource,
  targetKey, targetFingerprint, settledResult, createScheduler };
