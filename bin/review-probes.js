'use strict';

// Exact, local fingerprints only. No prompts, results, or code are persisted.
// Eligibility is not permission to back off: a reviewer must acknowledge the
// fingerprint as a safe read-only probe first.
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const blockedTool = /^(Bash|Write|Edit|MultiEdit|NotebookEdit|Agent|Task|CronCreate|CronDelete|SendMessage)$|(?:^|__|_)(?:create|update|delete|send|publish|deploy|apply|install|terminate)(?:_|$)/i;
const noise = new Set(['queue-operation', 'progress', 'file-history-snapshot', 'last-prompt']);
const attachments = new Set(['total_tokens_reminder', 'skill_listing', 'budget_usd', 'token_usage']);

const metadataKeys = {
  'ai-title': ['type', 'sessionId', 'aiTitle'],
  'bridge-session': ['type', 'sessionId', 'bridgeSessionId', 'lastSequenceNum', 'ownerAccountUuid', 'ownerOrganizationUuid'],
  'cost-state': ['type', 'sessionId', 'totalCostUSD', 'totalAPIDuration', 'totalAPIDurationWithoutRetries', 'totalToolDuration', 'totalLinesAdded', 'totalLinesRemoved', 'totalDuration', 'startTime', 'modelUsage', 'hasUnknownModelCost'],
};
const onlyKeys = (record, keys) => Object.keys(record).every(key => keys.includes(key) || key === 'timestamp');
function benignMetadata(record) {
  const keys = metadataKeys[record.type];
  if (!keys || !onlyKeys(record, keys) || typeof record.sessionId !== 'string') return false;
  if (record.type === 'ai-title') return typeof record.aiTitle === 'string';
  if (record.type === 'bridge-session') return typeof record.bridgeSessionId === 'string' && Number.isSafeInteger(record.lastSequenceNum)
    && ['ownerAccountUuid', 'ownerOrganizationUuid'].every(key => record[key] === undefined || typeof record[key] === 'string');
  return keys.filter(key => !['type', 'sessionId', 'modelUsage', 'hasUnknownModelCost'].includes(key))
    .every(key => Number.isFinite(record[key])) && typeof record.hasUnknownModelCost === 'boolean'
    && record.modelUsage && typeof record.modelUsage === 'object' && !Array.isArray(record.modelUsage)
    && Object.values(record.modelUsage).every(value => value && typeof value === 'object' && Object.values(value).every(Number.isFinite));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}

function scanProbes(lines, agent = 'claude') {
  if (agent !== 'claude') return { eligible: false, reason: 'unrecognized automation provenance', turns: [] };
  const turns = [];
  const modes = {};
  let current = null;
  let unsafe = '';
  const finish = () => {
    if (!current) return;
    const complete = current.done && current.calls.size === 0 && current.results > 0;
    turns.push({ at: current.at, eligible: complete && !current.unsafe,
      fingerprint: complete && !current.unsafe ? hash(current.parts) : null,
      reason: current.unsafe || (!complete ? 'incomplete probe' : '') });
  };
  for (const line of lines) {
    let r;
    try { r = typeof line === 'string' ? JSON.parse(line) : line; } catch { unsafe = 'unreadable record'; continue; }
    if (!r) { unsafe = 'unreadable record'; continue; }
    if (r.isSidechain) { unsafe = 'background activity'; continue; }
    if (noise.has(r.type) || benignMetadata(r)) continue;
    if (r.type === 'mode' || r.type === 'permission-mode') {
      const value = r.type === 'mode' ? r.mode : r.permissionMode;
      if (!onlyKeys(r, ['type', 'sessionId', r.type === 'mode' ? 'mode' : 'permissionMode']) || typeof value !== 'string' || (modes[r.type] !== undefined && modes[r.type] !== value)) unsafe = 'session mode changed';
      modes[r.type] = value;
      continue;
    }
    if (r.type === 'atis-latch' && r.atis === '' && onlyKeys(r, ['type', 'sessionId', 'atis'])) continue;
    if (r.type === 'attachment') {
      if (!attachments.has(r.attachment?.type)) unsafe = 'unrecognized attachment';
      continue;
    }
    if (r.type === 'system') {
      // Harness summaries and cron bookkeeping are not new task evidence.
      // Hook failures/context and compaction still require a fresh review.
      const benignHook = r.subtype === 'stop_hook_summary'
        && Array.isArray(r.hookErrors) && r.hookErrors.length === 0
        && Array.isArray(r.hookAdditionalContext) && r.hookAdditionalContext.length === 0
        && r.preventedContinuation === false && r.hasOutput === false && !r.stopReason;
      if (!['turn_duration', 'away_summary', 'scheduled_task_fire'].includes(r.subtype) && !benignHook) unsafe = 'system or compaction event';
      continue;
    }
    const content = r.message?.content;
    if (r.type === 'user' && (typeof content === 'string' || (Array.isArray(content) && content.some(c => c.type === 'text')))) {
      finish(); current = null;
      if (r.promptSource !== 'system' || r.isMeta !== true || !r.scheduledTaskId || !r.scheduledFireId) {
        unsafe = 'human or unrecognized prompt'; continue;
      }
      current = { parts: [r.scheduledTaskId, stable(content)], calls: new Map(), results: 0,
        done: false, at: Date.parse(r.timestamp), unsafe: '' };
      continue;
    }
    if (!['assistant', 'user'].includes(r.type)) { unsafe = 'unrecognized record'; continue; }
    if (!current || current.done) { unsafe = 'activity outside complete scheduled turns'; continue; }
    if (r.isApiErrorMessage || r.error) current.unsafe = 'error';
    if (r.type === 'assistant') {
      if (!Array.isArray(content)) { current.unsafe = 'unrecognized assistant output'; continue; }
      for (const item of content) {
        if (item.type === 'thinking') continue;
        if (item.type === 'text') { current.parts.push(['text', item.text]); continue; }
        if (item.type !== 'tool_use' || !item.id || !item.name || blockedTool.test(item.name)) {
          current.unsafe = 'unrecognized or mutating tool'; continue;
        }
        if (current.calls.has(item.id)) current.unsafe = 'duplicate tool call';
        current.calls.set(item.id, item.name);
        current.parts.push(['call', item.name, stable(item.input)]);
      }
      if (r.message.stop_reason === 'end_turn') current.done = true;
      else if (r.message.stop_reason !== 'tool_use') current.unsafe = 'incomplete assistant response';
    } else {
      if (!Array.isArray(content)) { current.unsafe = 'unrecognized result'; continue; }
      for (const item of content) {
        if (item.type !== 'tool_result' || !current.calls.has(item.tool_use_id)) { current.unsafe = 'unmatched tool result'; continue; }
        if (item.is_error) current.unsafe = 'tool error';
        // Images and opaque blocks are never treated as unchanged text evidence.
        if (typeof item.content !== 'string' && (!Array.isArray(item.content) || item.content.some(c => c.type !== 'text' || typeof c.text !== 'string'))) {
          current.unsafe = 'opaque tool result';
        }
        current.parts.push(['result', current.calls.get(item.tool_use_id), stable(item.content)]);
        current.calls.delete(item.tool_use_id); current.results++;
      }
    }
  }
  finish();
  const fingerprint = turns[0]?.fingerprint;
  const eligible = !unsafe && turns.length > 0 && turns.every(t => t.eligible && t.fingerprint === fingerprint);
  return { eligible, fingerprint: eligible ? hash([fingerprint, stable(modes)]) : null, count: turns.length,
    reason: unsafe || turns.find(t => !t.eligible)?.reason || (!eligible ? 'probe results changed' : ''), turns };
}

function combineProbes(entries) {
  if (!entries.length || entries.some(e => !e.probe?.eligible)) return null;
  return { fingerprint: hash(entries.map(e => [e.id, e.probe.fingerprint]).sort()),
    count: entries.reduce((n, e) => n + e.probe.count, 0) };
}

function acknowledgeProbe(previous, pending, safe, now) {
  if (!pending || (!safe && previous?.fingerprint !== pending.fingerprint)) return null;
  const clean = previous?.fingerprint === pending.fingerprint && Number.isSafeInteger(previous.clean) && previous.clean > 0 ? Math.min(100, previous.clean + 1) : 1;
  const intervalMs = Math.min(4 * 3600e3, 30 * 60e3 * 2 ** Math.min(3, clean - 1));
  return { fingerprint: pending.fingerprint, clean, reviewedAt: now, nextReviewAt: now + intervalMs };
}

function probeBackoff(previous, candidate, now, changed = false) {
  return !changed && previous?.clean >= 2 && candidate?.fingerprint === previous.fingerprint
    && Number.isFinite(previous.nextReviewAt) && now < previous.nextReviewAt;
}

module.exports = { scanProbes, combineProbes, acknowledgeProbe, probeBackoff };
