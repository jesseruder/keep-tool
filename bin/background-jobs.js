'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ID = /^[a-zA-Z0-9_-]{1,160}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const text = (v) => typeof v === 'string' ? v : Array.isArray(v) ? v.filter(x => ['text', 'input_text', 'output_text'].includes(x?.type)).map(x => x.text || '').join('\n') : '';

// Scheduled jobs belong to an agent process, which may run inside a shell pane.
function processInstance(pane, agentPid = pane?.agentPid) {
  return pane && agentPid ? `${pane.id}:${pane.pid}:${agentPid}` : null;
}

function directory(root, agent, sid) {
  if (!['claude', 'codex'].includes(agent) || !ID.test(sid || '')) throw Error('Invalid job ledger identity');
  return path.join(root, '.keep', 'background-jobs', agent, sid);
}

// Hook processes never edit the shared snapshot. Immutable inbox files survive
// daemon downtime; consumption and deletion happen only after snapshot commit.
function recordHook(root, agent, sid, event) {
  if (!/^(?:SubagentStart|SubagentStop|SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|PostToolUseFailure|Stop|Interrupt|PermissionRequest)$/.test(event.event) || !ID.test(event.entity || '')) return;
  const dir = path.join(directory(root, agent, sid), 'inbox');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const row = { event: event.event, entity: event.entity, at: event.at, offset: event.offset };
  const body = JSON.stringify(row);
  try { fs.writeFileSync(path.join(dir, hash(body) + '.json'), body, { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
}

function clearReplayObligation(state, id, run) {
  if (!run) return;
  const retired = `superseded_${hash(`${id}:${run}`).slice(0, 24)}`;
  for (const [key, job] of Object.entries(state.jobs)) {
    if (key.startsWith('replay:') && job.run === run && (job.id === id || job.id === retired)) delete state.jobs[key];
  }
}

function update(state, id, kind, status, at, evidence, instance, run = '') {
  if (!ID.test(String(id || ''))) return;
  const key = `job:${id}`, old = state.jobs[key];
  if (!old && Object.keys(state.jobs).length >= 2500) { state.gap = true; return; }
  if (old && at < old.eventAt) return;
  if (TERMINAL.has(status) && old?.run) clearReplayObligation(state, id, old.run);
  // Replaying the same launch cannot revive its completed run.
  if (old && status === 'pending' && old.run === run && run) return;
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
    eventAt: at, evidence, instance: status === 'pending' && run !== old?.run ? owner || null : old?.instance || owner || null, run: run || old?.run || '' };
  for (const [retainedKey, retained] of Object.entries(state.jobs)) {
    if (retainedKey.startsWith('replay:') && retained.run && retained.run === state.jobs[`job:${retained.id}`]?.run) delete state.jobs[retainedKey];
  }
  if (kind === 'agent' && state.restart) state.restart.children[id] = 'owned';
}

function consume(state, row, agent, classify, instance) {
  if (!row || row.isSidechain) return;
  require('./restart-evidence').consume(state, row, agent);
  const at = Date.parse(row.timestamp || '') || 0;
  const content = row.message?.content;
  const userTurn = agent === 'claude' ? row.type === 'user' && !row.isCompactSummary
    && text(content) && !/^<(system-reminder|command-|local-command|task-notification|bash-)/.test(text(content))
    && (typeof content === 'string' || (Array.isArray(content) && content.some(b => b.type === 'text') && !content.some(b => b.type === 'tool_result')))
    : (row.type === 'event_msg' && ['task_started', 'user_message'].includes(row.payload?.type))
      || (row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user');
  if (userTurn) state.turnStartedAt = Math.max(state.turnStartedAt || 0, at);
  const start = (id, kind, run) => update(state, id, kind, 'pending', at, 'transcript', instance, run);
  const finish = (id, status = 'completed') => update(state, id, null, status, at, 'transcript', instance);
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
      const status = notification.match(/<status>(completed|failed|killed|stopped|cancelled)<\/status>/)?.[1];
      const legacy = !/<status>|<event>|<summary>Monitor event:/.test(notification);
      const timedOut = /\[Monitor timed out — re-arm if needed\.\]/.test(notification);
      const key = hash(notification.trim());
      if (id && !state.notices[key] && (status || legacy || timedOut)
          && (row.type !== 'queue-operation' || !row.operation || row.operation === 'enqueue')) {
        state.notices[key] = at;
        finish(id, status === 'failed' ? 'failed' : ['killed', 'stopped', 'cancelled'].includes(status) ? 'cancelled' : 'completed');
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
          && /\n(?:Output|Final output):[\s\S]*(?:"session_id"\s*:\s*\d+|Process running with session ID|Script running with cell ID)/.test(value)) state.gap = true;
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

function sync({ root, agent, sid, file, instance = null, classify = () => 'unknown', inspectAgent, includeSidechain = false, now = Date.now(), budget = 4 * 1024 * 1024, maxRecord = 32 * 1024 * 1024, staleAfter = 30 * 60e3 }) {
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
    catch (e) { state = { version: 1, jobs: {}, calls: {}, notices: {}, checkpoint: null, gap: e.code !== 'ENOENT' }; }
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
          if (cp.identity !== `${hash(path.resolve(file))}:${stat.dev}:${stat.ino}` || cp.offset > stat.size || hash(b) !== cp.anchor) state.gap = true;
        } catch { state.gap = true; }
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
    if (state.restartVersion !== 1) {
      let migrationGap = state.gap;
      if (state.checkpoint) {
        let fd;
        try {
          fd = fs.openSync(file, 'r');
          const stat = fs.fstatSync(fd), cp = state.checkpoint;
          const b = Buffer.alloc(Math.min(64, cp.offset));
          fs.readSync(fd, b, 0, b.length, cp.offset - b.length);
          if (cp.identity !== `${hash(path.resolve(file))}:${stat.dev}:${stat.ino}` || cp.offset > stat.size || hash(b) !== cp.anchor) migrationGap = true;
        } catch { migrationGap = true; }
        finally { if (fd != null) fs.closeSync(fd); }
      }
      const retained = Object.fromEntries(Object.entries(state.jobs).filter(([, j]) => migrationGap || !TERMINAL.has(j.status) || j.kind === 'agent'));
      if (!state.source?.instance?.processScoped) for (const j of Object.values(retained)) j.instance = null;
      state = { version: 1, restartVersion: 1, jobs: retained, calls: {}, notices: {}, checkpoint: null, gap: migrationGap,
        restart: { completed: false, children: Object.fromEntries(Object.values(retained).filter(j => j.kind === 'agent').map(j => [j.id, 'owned'])), launches: {}, mapped: {} },
        cronVersion: 1, turnVersion: 1, pollVersion: agent === 'codex' ? 2 : undefined, childStopVersion: 3 };
    }
    // New Claude adapter evidence needs one replay; preserve existing job history.
    if (agent === 'claude' && (state.cronVersion !== 1 || state.turnVersion !== 1)) {
      state.checkpoint = null; state.calls = {}; state.notices = {}; state.turnStartedAt = null;
      state.cronVersion = 1; state.turnVersion = 1;
    }
    let recovering = false, bytesRead = 0;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const stat = fs.fstatSync(fd), identity = `${hash(path.resolve(file))}:${stat.dev}:${stat.ino}`;
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
          if (cp) { state.gap = true; state.turnStartedAt = null; for (const j of Object.values(state.jobs)) if (!TERMINAL.has(j.status)) j.evidence = 'transcript-replaced'; }
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
            catch { state.gap = true; }
          }
          start = end + 1;
        }
        if (start === 0 && bytesRead >= (cp.skip ? budget : Math.max(budget, maxRecord))) { start = bytesRead; cp.skip = true; state.gap = true; }
        cp.offset += start; cp.anchor = anchor(cp.offset); cp.mtime = stat.mtimeMs; state.checkpoint = cp;
        recovering = cp.offset < stat.size;
      } finally { fs.closeSync(fd); }
    } catch { recovering = true; }
    const inbox = path.join(dir, 'inbox');
    let consumed = [];
    try {
      consumed = fs.readdirSync(inbox).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).slice(0, 1000);
      const events = consumed.map(n => JSON.parse(fs.readFileSync(path.join(inbox, n), 'utf8'))).sort((a, b) => a.at - b.at);
      if (events.length) state.hookGeneration = (state.hookGeneration || 0) + events.length;
      for (const e of events) {
        if (e.event === 'SubagentStart') update(state, e.entity, 'agent', 'pending', e.at, 'hook', instance?.processScoped ? null : instance, `hook:${e.at}`);
        if (['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Interrupt', 'PermissionRequest'].includes(e.event)) {
          // A hook bridges the period before the transcript is flushed. Stop
          // alone never clears this barrier: it may be blocked by another hook.
          if (Number.isFinite(e.offset)) state.hookBarrier = Math.max(state.hookBarrier ?? -1, e.offset);
          else state.gap = true;
        }
        // Stop hooks can be blocked. They are not completion evidence.
      }
    } catch (error) { if (error.code !== 'ENOENT') state.gap = true; consumed = []; }
    for (const j of Object.values(state.jobs)) {
      if (j.kind === 'scheduled' && !TERMINAL.has(j.status)) {
        if (j.expiresAt <= now || (instance && typeof instance === 'object' && (instance.live === false || (instance.id && j.instance && j.instance !== instance.id)))) {
          update(state, j.id, 'scheduled', 'cancelled', now, 'schedule-lifetime', instance);
        }
      }
      if (j.kind !== 'agent' || TERMINAL.has(j.status) || !inspectAgent) continue;
      try {
        const evidence = inspectAgent(j.id);
        if (evidence && evidence.at >= j.eventAt) {
          if (evidence.done) update(state, j.id, 'agent', 'completed', evidence.at, 'child-transcript', instance);
          else { j.lastCorroboratedAt = evidence.at; j.evidence = 'child-transcript'; }
        }
      } catch {} // Missing child evidence remains uncertain, not completed.
    }
    const terminal = Object.entries(state.jobs).filter(([, j]) => TERMINAL.has(j.status)).sort((a, b) => b[1].eventAt - a[1].eventAt);
    if (!Object.keys(state.calls).length && !Object.values(state.jobs).some(j => j.id.startsWith('cell_') && j.status === 'pending')) {
      for (const [key] of terminal.slice(500)) delete state.jobs[key];
    }
    for (const field of ['calls', 'notices']) {
      const keys = Object.keys(state[field]);
      if (keys.length > 2000) { state.gap = true; for (const key of keys.slice(0, keys.length - 2000)) delete state[field][key]; }
    }
    const jobs = Object.values(state.jobs);
    if (jobs.length > 2500) state.gap = true;
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
      recovering, gap: state.gap, bytesRead, lastReconciledAt: now };
  } finally { try { fs.unlinkSync(lock); } catch {} }
}

function read(root, agent, sid, now = Date.now(), staleAfter = 30 * 60e3) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(directory(root, agent, sid), 'state.json'), 'utf8'));
    const jobs = Object.values(state.jobs);
    const open = jobs.filter(j => !TERMINAL.has(j.status) && !['service', 'scheduled'].includes(j.kind));
    const uncertain = open.filter(j => j.kind === 'unknown' || now - (j.lastCorroboratedAt || j.eventAt) > staleAfter || j.evidence === 'transcript-replaced').map(j => j.id);
    if (state.recovering || state.gap) uncertain.push(state.recovering ? 'history-recovery' : 'history-gap');
    let caughtUp = false;
    try { const s = fs.statSync(state.source.file); caughtUp = !state.recovering && state.checkpoint.offset === s.size && state.checkpoint.mtime === s.mtimeMs; } catch {}
    return { pending: open.some(j => !uncertain.includes(j.id)), uncertain, jobs, caughtUp, turnStartedAt: state.turnStartedAt || null, lastReconciledAt: state.lastReconciledAt };
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

module.exports = { processInstance, sync, read, targets, recordHook, consume, nextTarget };
