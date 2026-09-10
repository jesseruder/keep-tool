'use strict';

// Durable evidence for automatic retirement, deliberately stricter than the
// short-lived UI lifecycle hints. Missing history is not proof of completion.
const fs = require('node:fs');
const codex = require('./codex');
const ID = /^[a-z0-9_-]{1,160}$/i;
const CHILD_CALL = /(?:^|[._])(?:spawn_agent|spawn_agents|followup_task|send_input)$/;

// Bound memory by record size, not conversation age. Read only the captured
// file extent; the caller's inode/mtime/size check rejects concurrent changes.
function* records(file, size, deadline) {
  const fd = fs.openSync(file, 'r'), chunk = Buffer.alloc(64 * 1024);
  let offset = 0, parts = [], length = 0;
  try {
    while (offset < size) {
      if (Date.now() > deadline) throw Error('Codex history verification timed out');
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (!n) throw Error('Codex history changed during verification');
      offset += n;
      let start = 0;
      for (let i = 0; i < n; i++) if (chunk[i] === 10) {
        const end = chunk.subarray(start, i);
        length += end.length;
        if (length > 32 * 1024 * 1024) throw Error('Codex history record exceeds verification limit');
        const line = Buffer.concat([...parts, end], length).toString('utf8');
        parts = []; length = 0; start = i + 1;
        if (line.trim()) yield JSON.parse(line);
      }
      if (start < n) { const part = Buffer.from(chunk.subarray(start, n)); parts.push(part); length += part.length; }
      if (length > 32 * 1024 * 1024) throw Error('Codex history record exceeds verification limit');
    }
    if (length) throw Error('Codex history is still being written');
  } finally { fs.closeSync(fd); }
}

function verify(file, id, resolve = codex.findRolloutFile) {
  const snapshots = new Map();
  const visiting = new Set();
  const deadline = Date.now() + 15000;
  function walk(file, id, parent, depth) {
    if (!file || !ID.test(id) || depth > 8 || snapshots.size >= 128 || visiting.has(id)) throw Error('Codex child-agent history is unverified');
    const stat = fs.statSync(file);
    let meta;
    const jobs = { jobs: {}, calls: {}, notices: {} };
    snapshots.set(file, { size: stat.size, mtime: stat.mtimeMs, ino: stat.ino, id, child: Boolean(parent) });
    visiting.add(id);
    const children = new Set(), mapped = new Set(), calls = new Set(), pending = new Set();
    const owners = new Map();
    let completed = false;
    for (const r of records(file, stat.size, deadline)) {
      if (r.type === 'session_meta') {
        meta = r.payload;
        if (!meta || (meta.id || meta.session_id) !== id ||
            (parent && (meta.parent_thread_id || meta.source?.subagent?.thread_spawn?.parent_thread_id) !== parent)) throw Error('Codex child-agent identity is unverified');
      }
      require('./background-jobs').consume(jobs, r, 'codex', () => 'unknown', null);
      // Native completion may precede a wrapper's buffered launch response.
      // Retain tombstones until all calls and yielded cells have drained.
      if (!Object.keys(jobs.calls).length && !Object.values(jobs.jobs).some(j => j.id.startsWith('cell_') && j.status === 'pending')) {
        for (const [key, job] of Object.entries(jobs.jobs)) if (['completed', 'failed', 'cancelled'].includes(job.status)) delete jobs.jobs[key];
      }
      if (jobs.gap || Object.keys(jobs.calls).length > 10000 || pending.size > 10000 || calls.size > 10000 || mapped.size > 10000) throw Error('Codex unresolved evidence exceeds verification limit');
      const p = r.payload || {};
      if (r.type === 'response_item') {
        if (['function_call', 'custom_tool_call'].includes(p.type)) {
          pending.add(p.call_id);
          completed = false;
          if (CHILD_CALL.test(p.name || '') || (p.type === 'custom_tool_call'
              && require('./code-mode-polls').hasChildCall(p.input || ''))) calls.add(p.call_id);
        } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
          pending.delete(p.call_id);
          if (typeof p.output === 'string' && /^collab (?:spawn|tool) failed: agent thread limit reached$/.test(p.output.trim())) calls.delete(p.call_id);
        } else if (p.type === 'message' && p.role === 'user') completed = false;
      }
      if (r.type !== 'event_msg') continue;
      if (['task_started', 'user_message', 'turn_aborted'].includes(p.type)) completed = false;
      if (p.type === 'task_complete') completed = true;
      const item = p.item;
      if (item?.type === 'SubAgentActivity') {
        if (!ID.test(item.agent_thread_id || '')) throw Error('Codex child-agent identity is unverified');
        // Communication with a parent/sibling is also "interacted" activity.
        // Ownership comes from the target's metadata, never the message event.
        if (!owners.has(item.agent_thread_id)) {
          if (owners.size >= 128) throw Error('Codex child-agent history exceeds verification limit');
          const targetFile = resolve(item.agent_thread_id);
          const target = targetFile && codex.readSessionMeta(targetFile);
          owners.set(item.agent_thread_id, target && (target.id || target.session_id) === item.agent_thread_id
            ? target.parent_thread_id || target.source?.subagent?.thread_spawn?.parent_thread_id || '' : null);
        }
        if (owners.get(item.agent_thread_id) === id) {
          children.add(item.agent_thread_id);
          mapped.add(item.id);
        } else if (item.kind !== 'interacted' || owners.get(item.agent_thread_id) == null) {
          throw Error('Codex child-agent ownership is unverified');
        }
      }
      // Old collab formats do not supply the same identity/completion contract.
      if (item?.type === 'CollabAgentToolCall' && /spawn|send/i.test(item.tool || '')) throw Error('Legacy Codex child-agent history is unverified');
    }
    if (!meta) throw Error('Codex child-agent identity is unverified');
    if (Object.values(jobs.jobs).some(j => j.status === 'pending' && j.kind !== 'agent')) throw Error('Codex yielded background work is unverified');
    if ([...calls].some((call) => !mapped.has(call))) throw Error('Codex child-agent launch has no verified identity');
    if (!completed || pending.size || codex.scanRollout(file, { includeChild: true })?.pendingQuestion) throw Error('Codex background turn is not verifiably complete');
    for (const child of children) walk(resolve(child), child, id, depth + 1);
    visiting.delete(id);
  }
  walk(file, id, null, 0);
  const unchanged = () => {
    for (const [file, old] of snapshots) {
      if (old.child && resolve(old.id) !== file) throw Error('Codex child-agent history changed during cleanup');
      const s = fs.statSync(file);
      if (s.size !== old.size || s.mtimeMs !== old.mtime || s.ino !== old.ino) throw Error('Codex child-agent history changed during cleanup');
    }
  };
  unchanged();
  return unchanged;
}

module.exports = { verify };
