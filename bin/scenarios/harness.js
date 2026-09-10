'use strict';
// Test-only adapter boundary: transcripts/hooks/registry observations enter the
// production parsers and policy. No daemon, network, agent, or real registry.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { activity, attention } = require('../session-status');
const lifecycle = require('../session-lifecycle');
const jobs = require('../background-jobs');
const selection = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../web/app/selection.js'), 'utf8').replaceAll('export function', 'function'), selection);
const TYPES = new Set(['user', 'stop', 'schedule', 'cancel', 'hook', 'advance', 'output', 'restart', 'truncate', 'close', 'reopen', 'job-start', 'job-end', 'agent-start', 'agent-end', 'cron-start', 'cron-end', 'wrapper', 'expect']);
class ScenarioFailure extends Error {
  constructor(rule, index, expected, observed, timeline) {
    super(`${rule} at event ${index}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`);
    Object.assign(this, { rule, index, expected, observed, timeline });
  }
}
function replay(agent, events, { observe = x => x } = {}) {
  if (!['claude', 'codex'].includes(agent)) throw Error('agent must be claude or codex');
  if (!Array.isArray(events) || events.length > 1000) throw Error('events must be an array of at most 1000 entries');
  for (const e of events) if (!e || !TYPES.has(e.type)) throw Error(`Unknown event: ${e?.type}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-scenario-'));
  const file = path.join(root, 'session.jsonl');
  const childFile = agent === 'claude' ? path.join(root, 'session/subagents/agent-child.jsonl') : path.join(root, 'child.jsonl');
  let now = Date.parse('2026-09-09T12:00:00Z'), instance = 1, live = true;
  let task = { id: 'card', status: 'active' }, parsers = loadParsers();
  const timeline = [], ranks = new Map(), known = new Set(['subject', 'neighbor']);
  const current = { kind: 'running', sessionId: 'subject', pane: 'fixture' };
  const key = x => x.sessionId, section = x => `${x.kind}:${key(x)}`;
  const originalNow = Date.now;
  const append = row => {
    fs.appendFileSync(file, JSON.stringify({ timestamp: new Date(now).toISOString(), ...row }) + '\n');
    fs.utimesSync(file, new Date(now), new Date(now));
  };
  const header = () => {
    fs.writeFileSync(file, '');
    if (agent === 'codex') append({ type: 'session_meta', payload: { id: 'subject', source: 'cli', cwd: root } });
  };
  const user = text => append(agent === 'claude' ? { type: 'user', message: { content: text } }
    : { type: 'event_msg', payload: { type: 'user_message', message: text } });
  const tool = (id, name, input) => append(agent === 'claude'
    ? { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' } }
    : { type: 'response_item', payload: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(input) } });
  const result = (id, output) => append(agent === 'claude'
    ? { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] } }
    : { type: 'response_item', payload: { type: 'function_call_output', call_id: id, output } });
  try {
    Date.now = () => now;
    header();
    for (let index = 0; index < events.length; index++) {
      const e = events[index]; now += 1000;
      switch (e.type) {
        case 'user': user(e.automated ? '[keep] scheduled check due' : 'Please investigate this.'); break;
        case 'stop': {
          const text = e.text || 'Here is the proposed fix.';
          if (agent === 'claude') append({ type: 'assistant', message: { content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
          else {
            append({ type: 'event_msg', payload: { type: 'agent_message', message: text } });
            append({ type: 'event_msg', payload: { type: 'task_complete' } });
          }
          break;
        }
        case 'schedule': {
          const due = new Date(now + 600000).toISOString();
          task = { ...task, status: 'waiting', check_after: due, check: 'Read-only fixture check', scheduled_at: new Date(now).toISOString(),
            scheduled_by: 'subject', scheduled_for: due, scheduled_intent: e.intent || 'waiting' }; break;
        }
        case 'cancel': delete task.check_after; delete task.check; break;
        case 'hook': {
          const input = { session_id: 'subject', agentKind: agent, transcript_path: file, hook_event_name: e.event || 'Stop',
            last_assistant_message: e.text || 'Here is the proposed fix.', prompt_id: e.id || 'turn' };
          const at = now - (e.lag || 0);
          lifecycle.record(root, input, at);
          if (e.duplicate) lifecycle.record(root, input, at);
          break;
        }
        case 'advance': {
          if (!Number.isFinite(e.ms) || e.ms < 0 || e.ms > 8 * 86400e3) throw Error('Invalid clock advance');
          now += e.ms; break;
        }
        case 'output': result('noise', 'x'.repeat(e.large ? 300000 : 32)); break;
        case 'restart': parsers = loadParsers(true); break;
        case 'truncate': header(); break;
        case 'close': live = false; break;
        case 'reopen': live = true; instance++; break;
        case 'wrapper': if (agent === 'claude') user('<local-command-stdout>Set model to opus</local-command-stdout>'); break;
        case 'job-start':
          tool('background', 'Bash', { command: 'fixture-build', run_in_background: true });
          result('background', agent === 'claude' ? 'Command running in background with ID: build' : 'Process running with session ID 1234');
          break;
        case 'job-end':
          if (agent === 'claude') user('<task-notification><task-id>build</task-id><status>completed</status></task-notification>');
          else { tool('poll', 'write_stdin', { session_id: 1234, chars: '' }); result('poll', 'Process exited with code 0'); }
          break;
        case 'agent-start': case 'agent-end':
          fs.mkdirSync(path.dirname(childFile), { recursive: true });
          if (e.type === 'agent-start') fs.writeFileSync(childFile, agent === 'claude' ? '' : JSON.stringify({ type: 'session_meta', payload: { id: 'child', source: 'cli' } }) + '\n');
          for (const row of agent === 'claude'
            ? [{ type: e.type === 'agent-start' ? 'user' : 'assistant', message: e.type === 'agent-start' ? { content: 'Review the fixture.' } : { content: [{ type: 'text', text: 'Review complete.' }], stop_reason: 'end_turn' } }]
            : [{ type: 'event_msg', payload: { type: e.type === 'agent-start' ? 'user_message' : 'task_complete', message: 'Review the fixture.' } }]) {
            fs.appendFileSync(childFile, JSON.stringify({ timestamp: new Date(now).toISOString(), ...row }) + '\n');
          }
          lifecycle.record(root, { session_id: 'subject', agentKind: agent, transcript_path: file,
            hook_event_name: e.type === 'agent-start' ? 'SubagentStart' : 'SubagentStop', agent_id: 'child' }, now);
          break;
        case 'cron-start': case 'cron-end':
          if (agent !== 'claude') throw Error('Claude cron events are not a Codex capability');
          tool(e.type, e.type === 'cron-start' ? 'CronCreate' : 'CronDelete', { id: 'watcher' });
          result(e.type, e.type === 'cron-start' ? 'Scheduled recurring job watcher (* * * * *). Session-only. Auto-expires after 7 days.' : 'Cancelled job watcher.');
          break;
      }
      const info = (agent === 'claude' ? parsers.scanTranscript(file) : parsers.scanRollout(file)) || {};
      jobs.sync({ root, file, sid: 'subject', agent, now, instance: { id: `fixture:${instance}`, since: 1, live }, classify: () => 'finite',
        inspectAgent: () => {
          if (!fs.existsSync(childFile)) return null;
          const child = agent === 'claude' ? parsers.scanTranscript(childFile) : parsers.scanRollout(childFile);
          return child && { at: child.attentionAt || 0, done: agent === 'claude' ? child.explicitEndTurn && !child.pendingOther && !child.pendingBackground : child.endedTurn && !child.toolRunning };
        } });
      const ledger = jobs.read(root, agent, 'subject', now);
      const hooks = lifecycle.read(root, 'subject', now);
      const session = { ...info, id: 'subject', kind: agent, pane: live ? 'fixture' : null, taskId: 'card',
        runtime: { state: live ? 'live' : 'exited', instance: `fixture:${instance}`, observedAt: 1 },
        lastAssistantFull: (info.lastAssistant || '').slice(0, 12000), backgroundJobs: ledger,
        pendingBackground: ledger.pending, unknownBackgroundJobs: ledger.uncertain,
        lifecycleAgents: agent === 'claude' ? lifecycle.pendingAgents(hooks, file, parsers.scanTranscript, now, info.completedAgents) : [],
        lifecycleForeground: lifecycle.foreground(hooks, info, now), lifecycleStop: lifecycle.stopReason(hooks, info), lifecycleTurnAt: lifecycle.turnAt(hooks) };
      const status = observe(activity(session, { task, now }));
      const input = Boolean(attention({ ...session, activity: status }));
      const observed = { state: status.state, input, pending: ledger.pending, rule: status.decision.rule, source: status.decision.source };
      timeline.push({ index, event: e, ...observed });
      const check = (ok, rule, expected, actual) => { if (!ok) throw new ScenarioFailure(rule, index, expected, actual, timeline); };
      check(!input || status.state === 'needs-input', 'input-queue-contract', 'needs-input', status.state);
      check(live || !input, 'closed-not-in-input-queue', false, input);
      // Exercise the production ordering/selection helpers while rows change groups.
      const ordered = selection.stableSessionOrder([{ id: 'neighbor', state: index % 2 ? 'running' : 'waiting' }, { id: 'subject', state: status.state }], ranks, known);
      check(!ordered.some((x, i) => i && ordered[i - 1].state === 'waiting' && x.state === 'running'), 'running-before-waiting', true, false);
      const rows = ordered.map(x => ({ kind: x.state === 'needs-input' ? 'attention' : 'running', sessionId: x.id, pane: x.id === 'subject' ? 'fixture' : 'other' }));
      check(rows[selection.selectionIndex(rows, section(current), current, 0, key, section)].sessionId === 'subject', 'stable-selection', 'subject', rows);
      if (e.type === 'expect') {
        for (const field of ['state', 'input', 'pending']) if (e[field] !== undefined) check(observed[field] === e[field], `expect-${field}`, e[field], observed[field]);
      }
    }
    return timeline;
  } finally {
    Date.now = originalNow;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function loadParsers(cold = false) {
  if (cold) for (const name of ['../serve', '../codex']) delete require.cache[require.resolve(name)];
  return { scanTranscript: require('../serve').scanTranscript, scanRollout: require('../codex').scanRollout };
}
// Minimize perturbations while preserving semantic preconditions. Deleting a
// user turn or a completion can manufacture a different, perfectly correct state
// that fails the same assertion; never call that a reproduction of the bug.
function minimize(agent, events, failure, options) {
  const removable = new Set(['advance', 'output', 'restart', 'wrapper', 'hook']);
  let result = events.slice(0, failure.index + 1);
  for (let size = Math.floor(result.length / 2); size >= 1; size = Math.floor(size / 2)) {
    for (let i = 0; i + size <= result.length;) {
      if (!result.slice(i, i + size).every(e => removable.has(e.type))) { i++; continue; }
      const candidate = [...result.slice(0, i), ...result.slice(i + size)];
      try { replay(agent, candidate, options); i++; }
      catch (error) {
        if (error instanceof ScenarioFailure && error.rule === failure.rule && JSON.stringify(error.expected) === JSON.stringify(failure.expected)) result = candidate;
        else i++;
      }
    }
  }
  return result;
}
module.exports = { replay, minimize, ScenarioFailure };
