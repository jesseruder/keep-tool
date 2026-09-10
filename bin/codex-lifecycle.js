'use strict';
// Codex hook payloads share the parent session_id. Only validated root
// transcripts may supply foreground status; children supply child evidence only.
const fs = require('node:fs');
const lifecycle = require('./session-lifecycle');
const ID = /^[a-z0-9_-]{1,160}$/i;
const childCache = new Map();
const childPaths = new Map();

function record(root, input, now = Date.now()) {
  if (!input || !ID.test(input.session_id || '')) return false;
  const codex = require('./codex');
  let meta;
  try { meta = codex.readSessionMeta(input.transcript_path); } catch { return false; }
  if (!meta || meta.originator === 'Claude Code') return false;
  const id = meta.id || meta.session_id;
  const subagent = /^Subagent(?:Start|Stop)$/.test(input.hook_event_name);
  if (subagent) {
    if (!ID.test(input.agent_id || '') || input.agent_id === input.session_id) return false;
    if (codex.isChildSession(meta)) {
      const parent = meta.parent_thread_id || meta.source?.subagent?.thread_spawn?.parent_thread_id;
      if (parent !== input.session_id || id !== input.agent_id) return false;
    } else if (id !== input.session_id) return false;
  } else if (codex.isChildSession(meta) || id !== input.session_id || input.agent_id) return false;
  return lifecycle.record(root, { ...input, agentKind: 'codex', prompt_id: input.turn_id || input.prompt_id }, now);
}

function childState(id, parent, now) {
  const codex = require('./codex');
  let resolved = childPaths.get(id);
  if (!resolved || now - resolved.at >= 30000 || now < resolved.at) {
    resolved = { file: codex.findRolloutFile(id), at: now };
    childPaths.delete(id);
    childPaths.set(id, resolved);
    if (childPaths.size > 256) childPaths.delete(childPaths.keys().next().value);
  }
  const file = resolved.file;
  if (!file) return null;
  const stat = fs.statSync(file);
  const cached = childCache.get(file);
  let entry = cached;
  if (!cached || cached.size !== stat.size || cached.mtime !== stat.mtimeMs) {
    const meta = codex.readSessionMeta(file);
    entry = { size: stat.size, mtime: stat.mtimeMs, meta, info: codex.scanRollout(file, { includeChild: true }) };
    childCache.delete(file);
    childCache.set(file, entry);
    if (childCache.size > 256) childCache.delete(childCache.keys().next().value);
  }
  const owner = entry.meta?.parent_thread_id || entry.meta?.source?.subagent?.thread_spawn?.parent_thread_id;
  return owner === parent && entry.info?.id === id ? entry.info : null;
}

function state(root, info, now = Date.now()) {
  const events = lifecycle.read(root, info.id, now);
  const agents = new Map();
  for (const event of events) if (event.event.startsWith('Subagent')) {
    const previous = agents.get(event.entity);
    // Parent/child transcript offsets are not comparable. Use arrival time.
    if (!previous || event.at >= previous.at) agents.set(event.entity, event);
  }
  const pending = [...agents.values()].filter((event) => {
    let child;
    try { child = childState(event.entity, info.id, now); } catch {}
    if (child && child.attentionAt >= event.at) return !child.endedTurn || child.toolRunning;
    // Stop runs before completion and can be blocked. Do not treat it as a
    // completed child until the transcript agrees; expire unconfirmed evidence.
    if (child && !child.endedTurn && now - event.at < 120e3) return true;
    return event.event === 'SubagentStart' && now - event.at < 120e3;
  }).map((event) => event.entity);
  return { lifecycleForeground: lifecycle.foreground(events, info, now),
    lifecycleStop: lifecycle.stopReason(events, info),
    lifecycleTurnAt: lifecycle.turnAt(events),
    lifecycleAgents: pending, pendingBackground: pending.length > 0 };
}

function inspectChild(id, parent, now = Date.now()) {
  const child = childState(id, parent, now);
  return child ? { at: child.attentionAt || 0, done: child.endedTurn && !child.toolRunning && !child.pendingBackground } : null;
}
module.exports = { record, state, inspectChild };
