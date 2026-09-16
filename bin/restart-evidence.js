'use strict';
// Restart-only reducer. Persist identities and protocol state, never prompts or
// tool arguments. UI readiness is deliberately not a source of completion proof.
const ID = /^[a-z0-9_-]{1,160}$/i;
const CHILD_CALL = /(?:^|[._])(?:spawn_agent|spawn_agents|followup_task|send_input)$/;
const CLAUDE_INTERRUPTION_MESSAGES = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]);
function isClaudeInterruption(row) {
  const content = row?.message?.content;
  return row?.type === 'user' && typeof row.interruptedMessageId === 'string' && row.interruptedMessageId.length > 0
    && Array.isArray(content) && content.length === 1 && content[0]?.type === 'text'
    && CLAUDE_INTERRUPTION_MESSAGES.has(content[0].text);
}
// The reducer has no clock of its own, but the gaps it marks still need a stamp
// so a cold replay cannot clear a gap this same pass re-observed.
const markGap = (state, reason) => require('./background-jobs').markGap(state, Date.now(), reason);
function consume(state, row, agent) {
  const s = state.restart ||= { completed: false, children: {}, launches: {}, mapped: {} };
  const at = Date.parse(row.timestamp || '') || 0;
  s.observedAt = Math.max(s.observedAt || 0, at);
  if (agent === 'claude') {
    if (row.sessionId) {
      if (s.id && s.id !== row.sessionId) markGap(state, 'session-identity');
      s.id = row.sessionId;
    }
    const content = row.message?.content;
    if (row.type === 'user') s.finalTextAt = 0;
    if (row.type === 'user' && !row.isCompactSummary) {
      s.rateLimitTerminal = false;
      if (isClaudeInterruption(row)) { s.completed = true; s.localCommandOpen = false; return; }
      const t = typeof content === 'string' ? content : '';
      const wrapper = /^<(?:system-reminder|task-notification|command-|local-command|bash-)/.test(t);
      if (!wrapper) s.completed = false;
      // A bare slash prompt opens a command turn that only the harness closes. The
      // caveat and <command-name> wrappers belong to that same turn; a tool result
      // or a typed prompt means the model is working, so no later wrapper is its end.
      if (t.startsWith('/')) s.localCommandOpen = true;
      else if (!wrapper) s.localCommandOpen = false;
      const human = typeof content === 'string' ? t && !t.startsWith('<')
        : Array.isArray(content) && content.some(b => b.type === 'text') && !content.some(b => b.type === 'tool_result');
      // Compare against the last completed-text candidate, not duplicated
      // prompt/context records within the same new turn.
      if (human) s.finalTextBlocked = Boolean(s.finalTextSeen) && (!at || at <= s.finalTextSeen);
      if (t.startsWith('<local-command-stdout>')) s.completed = true;
    }
    // Newer Claude Code logs the local command's output as a `system` record
    // instead. Either stream means the harness finished the command; a failed
    // /compact writes only stderr, and without this the turn never settles. The
    // same rows also appear mid-turn when Owner presses /model while the model is
    // working, so only an open command turn may be closed by one.
    if (row.type === 'system' && row.subtype === 'local_command' && typeof row.content === 'string') {
      const t = row.content.trimStart();
      // A <command-name> row is the echo of the typed command; it proves nothing.
      if (s.localCommandOpen && (t.startsWith('<local-command-stdout>') || t.startsWith('<local-command-stderr>'))) {
        s.completed = true;
        s.localCommandOpen = false;
      }
    }
    if (row.type === 'assistant') {
      s.completed = row.message?.stop_reason === 'end_turn';
      s.localCommandOpen = false;
      s.rateLimitTerminal = row.isApiErrorMessage === true && (row.error === 'rate_limit' || row.apiErrorStatus === 429);
      s.finalTextAt = !s.finalTextBlocked && row.message?.stop_reason == null && (typeof content === 'string' ? content.trim().length > 0
        : Array.isArray(content) && content.length > 0 && content.every(b => b.type === 'text') && content.some(b => b.text?.trim())) ? at : 0;
      if (s.finalTextAt) s.finalTextSeen = Math.max(s.finalTextSeen || 0, s.finalTextAt);
    }
    return;
  }
  const p = row.payload || {};
  if (row.type === 'session_meta') {
    const id = p.id || p.session_id;
    if (!ID.test(id || '') || (s.id && s.id !== id)) markGap(state, 'session-identity');
    s.id = id;
    s.parent = p.parent_thread_id || p.source?.subagent?.thread_spawn?.parent_thread_id || null;
  }
  if (row.type === 'response_item') {
    if (['function_call', 'custom_tool_call'].includes(p.type)) {
      s.completed = false;
      s.aborted = false;
      const codeMode = p.type === 'custom_tool_call' && /^(?:functions[._])?exec$/.test(p.name || '');
      if (CHILD_CALL.test(p.name || '') || (codeMode && require('./code-mode-polls').hasChildCall(p.input || ''))) {
        if (ID.test(p.call_id || '')) {
          s.launches[p.call_id] = true;
          if (codeMode && require('./code-mode-polls').syntaxInvalid(p.input || '')) (s.invalidSyntax ||= {})[p.call_id] = true;
        }
        else markGap(state, 'unverified-launch');
      } else delete s.launches[p.call_id]; // Replay can disprove old dynamic-dispatch false positives.
    } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
      if (typeof p.output === 'string' && /^collab (?:spawn|tool) failed: agent thread limit reached$/.test(p.output.trim())) delete s.launches[p.call_id];
      // Both the source parser and harness must agree this failed before any
      // execution. A runtime SyntaxError (e.g. eval after spawning) is not proof.
      if (s.invalidSyntax?.[p.call_id] && Array.isArray(p.output) && p.output.length === 2
          && /^Script failed\nWall time [\d.]+ seconds\nOutput:\n$/.test(p.output[0]?.text || '')
          && /^Script error:\nSyntaxError: [^\n]+$/.test(p.output[1]?.text || '')) delete s.launches[p.call_id];
      if (s.invalidSyntax) delete s.invalidSyntax[p.call_id];
    } else if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) { s.aborted = false; if (p.role === 'user') s.completed = false; }
  }
  if (row.type !== 'event_msg') return;
  if (['task_started', 'user_message', 'turn_aborted'].includes(p.type)) s.completed = false;
  if (['task_started', 'user_message', 'task_complete'].includes(p.type)) s.aborted = false;
  if (p.type === 'turn_aborted') s.aborted = true;
  if (p.type === 'task_complete') s.completed = true;
  const item = p.item;
  if (item?.type === 'SubAgentActivity') {
    if (!ID.test(item.agent_thread_id || '') || !ID.test(item.id || '')) { markGap(state, 'unverified-child'); return; }
    // Keep even completed children: a child can start another turn without a
    // fresh parent-side launch. Its own ledger must be rechecked before exit.
    s.children[item.agent_thread_id] = s.children[item.agent_thread_id] === 'owned' || item.kind !== 'interacted' ? 'owned' : 'interacted';
    s.mapped[item.id] = item.agent_thread_id;
  }
  if (item?.type === 'CollabAgentToolCall' && /spawn|send/i.test(item.tool || '')) markGap(state, 'collab-tool-call');
  if (Object.keys(s.children).length > 128 || Object.keys(s.launches).length > 10000 || Object.keys(s.mapped).length > 10000) markGap(state, 'restart-graph-cap');
}
module.exports = { consume, isClaudeInterruption };
