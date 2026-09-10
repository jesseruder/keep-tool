'use strict';

// Immutable, bounded hook evidence. No prompts, tool arguments, or results are
// persisted. Separate files avoid lost updates between concurrent hook processes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EVENTS = new Set(['SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'Interrupt']);
const ID = /^[a-z0-9_-]{1,160}$/i;
const LIMIT = 256;
const MAX_AGE = 24 * 3600e3;

function directory(root, sid) {
  if (!ID.test(sid || '')) throw new Error('Invalid lifecycle session id');
  return path.join(root, '.keep', 'lifecycle', sid);
}

function record(root, input, now = Date.now()) {
  if (!EVENTS.has(input?.hook_event_name) || !ID.test(input.session_id || '')) return false;
  const event = input.hook_event_name;
  // Hooks inside a child must not be interpreted as activity of its parent.
  if (input.agent_id && !event.startsWith('Subagent')) return false;
  const entity = event.startsWith('Subagent') ? input.agent_id
    : event === 'PermissionRequest' ? input.prompt_id || 'permission'
    : /ToolUse/.test(event) ? input.tool_use_id : input.prompt_id || 'turn';
  if (!ID.test(entity || '')) return false;
  let offset = null;
  try { offset = fs.statSync(input.transcript_path).size; } catch {}
  const value = { event, entity, at: now, offset, tool: String(input.tool_name || '').slice(0, 100),
    ...(event === 'Stop' ? { intent: require('./conversation-intent').stopHint(input.last_assistant_message) } : {}),
    wait: event === 'PreToolUse' ? require('./session-status').toolWaitReason(input.tool_name || '', input.tool_input) : null };
  const dir = directory(root, input.session_id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  require('./background-jobs').recordHook(root, input.agentKind || 'claude', input.session_id, value);
  const digest = crypto.createHash('sha256').update(JSON.stringify({ ...value, at: 0 })).digest('hex');
  // wx makes repeats idempotent without resetting their age.
  try { fs.writeFileSync(path.join(dir, `${digest}.json`), JSON.stringify(value), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const files = fs.readdirSync(dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => { try { return { name, at: fs.statSync(path.join(dir, name)).mtimeMs,
      child: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).event.startsWith('Subagent') }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.at - a.at);
  const counts = { child: 0, turn: 0 };
  for (const file of files.filter((file) => ++counts[file.child ? 'child' : 'turn'] > (file.child ? LIMIT : 64) || now - file.at > MAX_AGE)) {
    try { fs.unlinkSync(path.join(dir, file.name)); } catch {}
  }
  return true;
}

// Hooks bridge the short gap before a transcript write. Newer transcript
// activity always wins, and a missed end event cannot hold a stale UI forever.
function foreground(events, info, now = Date.now()) {
  const latest = events.filter((event) => !event.event.startsWith('Subagent'))
    .sort((a, b) => a.at - b.at).at(-1);
  if (!latest || latest.at <= (info.attentionAt || 0) || now - latest.at >= 30000 || latest.at > now) return null;
  if (latest.event === 'PermissionRequest') return { state: 'needs-input', reason: 'permission', at: latest.at };
  if (latest.event === 'PreToolUse' && (['AskUserQuestion', 'ExitPlanMode'].includes(latest.tool)
      || /(?:^|[._])request_user_input(?:_async)?$/.test(latest.tool))) return null;
  if (latest.event === 'PreToolUse' && latest.wait) return { state: 'waiting', reason: latest.wait, at: latest.at };
  if (['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(latest.event)) {
    return { state: 'running', reason: latest.event === 'UserPromptSubmit' ? 'turn started' : 'tool activity', at: latest.at };
  }
  return null;
}

function read(root, sid, now = Date.now()) {
  try {
    const dir = directory(root, sid);
    return fs.readdirSync(dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).flatMap((name) => {
      try {
        const value = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        return EVENTS.has(value.event) && ID.test(value.entity) && Number.isFinite(value.at)
          && value.at <= now && now - value.at < MAX_AGE ? [value] : [];
      } catch { return []; }
    }).sort((a, b) => (a.offset != null && b.offset != null ? a.offset - b.offset : 0)
      || a.at - b.at || Number(a.event === 'SubagentStop') - Number(b.event === 'SubagentStop'));
  } catch { return []; }
}

function stopReason(events, info) {
  if (info.endedTurn !== true && !info.explicitEndTurn) return null; // Stop may be blocked.
  const latest = events.filter(e => !e.event.startsWith('Subagent')).sort((a, b) => a.at - b.at).at(-1);
  if (latest?.event !== 'Stop' || latest.at < Math.max(info.lastUserAt || 0, info.attentionAt || 0) || !['needs-input', 'waiting'].includes(latest.intent)) return null;
  return { intent: latest.intent, at: latest.at };
}

function turnAt(events) {
  return Math.max(0, ...events.filter(e => ['UserPromptSubmit', 'SessionStart'].includes(e.event)).map(e => e.at));
}

function pendingAgents(events, parentFile, scanChild, now = Date.now(), completedAgents = {}) {
  const agents = new Map();
  for (const event of events) if (event.event.startsWith('Subagent')) agents.set(event.entity, event);
  return [...agents.values()].filter((event) => {
    const child = path.join(path.dirname(parentFile), path.basename(parentFile, '.jsonl'), 'subagents', `agent-${event.entity}.jsonl`);
    try {
      const state = scanChild(child);
      if (completedAgents[event.entity] >= event.at && !(state.attentionAt > completedAgents[event.entity])) return false;
      if (state.attentionAt >= event.at) return !state.explicitEndTurn || state.pendingOther || state.pendingBackground;
    } catch {}
    if (completedAgents[event.entity] >= event.at) return false;
    if (event.event !== 'SubagentStart') return false;
    // A startup gap is expected. An old completed/missing child is not indefinite
    // proof of work: expire uncorroborated evidence and defer to transcript state.
    return now - event.at < 120e3;
  }).map((event) => event.entity);
}

module.exports = { record, read, pendingAgents, foreground, stopReason, turnAt, EVENTS };
