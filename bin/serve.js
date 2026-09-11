'use strict';
// keep serve — local dashboard server. No dependencies.
// Data sources: the keep repo (via keep.js), live Claude Code transcripts,
// and top-level Codex rollouts (read-only tailing).

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const keep = require('./keep.js');
const runs = require('./runs.js');
const summarize = require('./summarize.js');
const titles = require('./titles.js');
const usage = require('./usage.js');
const cardUsage = require('./card-usage.js');
const codex = require('./codex.js');
const transcripts = require('./transcripts.js');
const review = require('./review.js');
const reviewQueue = require('./review-queue.js');
const who = require('./who.js');
const steps = require('./steps.js');
const alerts = require('./alerts.js');
const notifications = require('./notifications.js');
const slack = require('./slack.js');
const standup = require('./standup.js');
const ideas = require('./ideas.js');
const landed = require('./landed.js');
const unblock = require('./unblock.js');
const limitresume = require('./limitresume.js');
const health = require('./health.js');
const stalled = require('./stalled.js');
const keepConsole = require('./console.js');
const sessionStatus = require('./session-status.js');
const { sendStateJson } = require('./state-response.js');
const { MOBILE_VIEWS, projectMobileState } = require('./mobile-state.js');

const PORT = parseInt(process.env.KEEP_PORT || '7777', 10);
const { PROJECTS_DIR, TAIL_BYTES, textOf, readTranscriptTail, findSessionFile } = transcripts;
const WEB_ROOT = path.join(__dirname, '..', 'web');
const SESSION_WINDOW_MS = 48 * 3600e3; // ignore transcripts older than this
const claudeTranscriptIndex = require('./transcript-index').createTranscriptIndex(PROJECTS_DIR);
const { compactState, wantsCompactState, createJobChangeTracker } = require('./dashboard-state');
const execFileAsync = promisify(execFile);
const ATTENTION_KINDS = new Set(['question', 'plan', 'permission', 'complete', 'input', 'review', 'blocked', 'overdue', 'unblocked', 'health', 'stalled']);
const CODEX_DIALOG_MARKERS = [
  'Would you like to run the following command?',
  'Press enter to confirm or esc to cancel',
  'Do you trust the contents of this directory?',
  'Press enter to continue',
];
// Claude Code renders an AI prompt suggestion on the `❯` line only while the input box
// is empty; typing any character hides it. The host trims trailing whitespace from screen
// lines, so a space cannot tell a draft from a lagging re-render — a visible character can:
// a suggestion collapses to exactly the probe key, a draft grows by it. A comma is harmless
// at the Claude Code prompt (no leading-character mode like `/`, `!`, `#`, `@`, `:`, `?`)
// and a no-op in vim NORMAL mode. Escape is not usable: on an empty prompt it opens rewind.
const SUGGESTION_PROBE_KEY = ',';
const SUGGESTION_PROBE_WAIT_MS = 150;
const SUGGESTION_PROBE_MAX_MS = 2000;
// A frozen or non-advancing clock must not spin the poll loop forever.
const SUGGESTION_PROBE_MAX_READS = Math.ceil(SUGGESTION_PROBE_MAX_MS / SUGGESTION_PROBE_WAIT_MS) + 1;

function attentionAckKey(item) {
  if (item.kind === 'health' && item.id) {
    if (item.incidentId) return `${item.id}:incident:${item.incidentId}`;
    const errorHash = crypto.createHash('sha1').update(String(item.errorText || '')).digest('hex');
    return `${item.id}:${errorHash}`;
  }
  return item.id ? `${item.id}:${item.since || item.at}` : `${item.kind}:${item.sessionId || item.taskId || ''}:${item.since}`;
}

function attentionAckName(key) {
  return crypto.createHash('sha1').update(key).digest('hex');
}

function attentionItemKey(item) {
  return item.sessionId || item.taskId || `${item.kind}:${item.title}:${item.since}`;
}

function setAsideFile(root = keep.ROOT) {
  return path.join(root, '.keep', 'setaside.json');
}

function readSetAside(root = keep.ROOT) {
  try {
    const value = JSON.parse(fs.readFileSync(setAsideFile(root), 'utf8'));
    if (value && value.version === 1 && value.items && typeof value.items === 'object' && !Array.isArray(value.items)) {
      return { version: 1, items: { ...value.items } };
    }
  } catch {}
  return { version: 1, items: {} };
}

function writeSetAside(value, root = keep.ROOT) {
  const file = setAsideFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function setAsideEntryValid(entry) {
  return entry && ['dismiss', 'snooze', 'dependency'].includes(entry.kind)
    && Number.isFinite(entry.at)
    && (typeof entry.since === 'number' || typeof entry.since === 'string')
    && (entry.kind === 'snooze' ? Number.isFinite(entry.until) : entry.until === null)
    && (entry.kind !== 'dependency' || (typeof entry.taskId === 'string'
      && Array.isArray(entry.dependencies) && entry.dependencies.length > 0
      && entry.dependencies.every((id) => typeof id === 'string')));
}

function attentionSince(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dependencyAsideContext(session) {
  const dependencies = session?.activity?.background?.dependencies || [];
  return dependencies.length ? { taskId: session.taskId, dependencies: [...new Set(dependencies)].sort() } : {};
}

function setAsideCandidates(attention, sessions) {
  const represented = new Set(attention.map((item) => item.sessionId).filter(Boolean));
  const bySession = new Map(sessions.map((session) => [session.id, session]));
  return [
    ...attention.map((item) => {
      const lastUserAt = bySession.get(item.sessionId)?.lastUserAt;
      if (Number.isFinite(lastUserAt)) item.lastUserAt = lastUserAt;
      Object.assign(item, dependencyAsideContext(bySession.get(item.sessionId)));
      return item;
    }),
    ...sessions.filter((session) => !session.reviewer && !represented.has(session.id)).map((session) => ({
      kind: session.rateLimit ? 'rateLimit' : 'session',
      sessionId: session.id,
      since: session.rateLimit?.at || session.attentionAt || session.mtime,
      synthetic: true,
      ...dependencyAsideContext(session),
      ...(Number.isFinite(session.lastUserAt) ? { lastUserAt: session.lastUserAt } : {}),
    })),
  ];
}

function applySetAside(attention, options = {}) {
  const root = options.root || keep.ROOT;
  const now = options.now == null ? Date.now() : options.now;
  const store = options.store || readSetAside(root);
  const current = new Map();
  for (const item of attention) {
    item.key = attentionItemKey(item);
    const prior = current.get(item.key);
    const itemSince = attentionSince(item.since);
    const priorSince = prior && attentionSince(prior.since);
    if (!prior || (itemSince !== null && (priorSince === null || itemSince > priorSince))) current.set(item.key, item);
  }
  const items = {};
  let changed = store.version !== 1 || !store.items || typeof store.items !== 'object' || Array.isArray(store.items);
  for (const [key, entry] of Object.entries(store.items || {})) {
    if (!setAsideEntryValid(entry)) { changed = true; continue; }
    if (entry.kind === 'snooze') {
      const userAt = current.get(key)?.lastUserAt;
      if (entry.until <= now || (Number.isFinite(userAt) && userAt > entry.at)) { changed = true; continue; }
      items[key] = entry;
      continue;
    }
    const item = current.get(key);
    if (entry.kind === 'dependency' && (!item || item.taskId !== entry.taskId
        || JSON.stringify(item.dependencies) !== JSON.stringify(entry.dependencies)
        || (Number.isFinite(item.lastUserAt) && item.lastUserAt > entry.at))) {
      changed = true;
      continue;
    }
    const itemSince = item && attentionSince(item.since);
    const entrySince = attentionSince(entry.since);
    if (!item || (itemSince !== null && entrySince !== null && itemSince > entrySince)) {
      changed = true;
      continue;
    }
    items[key] = entry;
  }
  for (const item of attention) item.setAside = items[item.key]?.kind || null;
  const value = { version: 1, items };
  if (changed && options.write !== false) writeSetAside(value, root);
  return { value, changed };
}

function parseSetAsideRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InjectionError(400, 'bad set-aside request');
  }
  const keys = Object.keys(body);
  const allowed = body.kind === 'snooze' ? ['key', 'kind', 'minutes'] : ['key', 'kind'];
  if (!['dismiss', 'snooze', 'dependency', 'clear'].includes(body.kind)
      || typeof body.key !== 'string' || !body.key.trim() || body.key.length > 4096
      || keys.some((key) => !allowed.includes(key))
      || (body.kind !== 'snooze' && keys.length !== 2)
      || (body.kind === 'snooze' && body.minutes !== undefined
        && (!Number.isInteger(body.minutes) || body.minutes < 1 || body.minutes > 1440))) {
    throw new InjectionError(400, 'bad set-aside request');
  }
  return { key: body.key, kind: body.kind, minutes: body.kind === 'snooze' ? body.minutes ?? 60 : null };
}

function updateSetAside(body, attention, options = {}) {
  const input = parseSetAsideRequest(body);
  const root = options.root || keep.ROOT;
  const now = options.now == null ? Date.now() : options.now;
  const value = readSetAside(root);
  if (input.kind === 'clear') {
    delete value.items[input.key];
    writeSetAside(value, root);
    return null;
  }
  const item = attention.find((candidate) => (candidate.key || attentionItemKey(candidate)) === input.key);
  if (!item) throw new InjectionError(400, 'unknown attention key');
  if (input.kind === 'dependency' && (!item.taskId || !item.dependencies?.length)) {
    throw new InjectionError(400, 'session has no unresolved dependencies');
  }
  const entry = {
    ...(input.kind === 'dependency' ? { taskId: item.taskId, dependencies: [...item.dependencies] } : {}),
    kind: input.kind,
    until: input.kind === 'snooze' ? now + input.minutes * 60e3 : null,
    at: now,
    since: item.since,
  };
  value.items[input.key] = entry;
  writeSetAside(value, root);
  return entry;
}

const DIGEST_INSTRUCTION = "You are writing a concise morning briefing for a solo developer's work registry. In 2-4 short sentences (or a few bullets), say what moved, what needs their attention, and what is stuck or waiting. Be specific and skip anything routine. Output only the briefing.";
const RESUME_INSTRUCTION = "This developer is returning to work after a break. From these in-progress tasks, write a 2-4 sentence 'here's where you were' briefing that orients them fast: what was mid-flight, what's blocked, what to pick up first. Output only the briefing.";
const REVIEW_INSTRUCTION = "These items are awaiting the developer's decision. For each, give a one-line recommendation (ramp / kill / take a look / merge / etc.) based on its latest status. Output only the list, one '- Title — recommendation' bullet per item. Plain bullets only — never a markdown table, headers, or preamble.";
const TASK_INSTRUCTION = "Summarize where this task stands for someone resuming it. 2-4 sentences: the goal, what's been done, and the current state / next step. Draw only from the log below. Output only the summary.";
const SESSION_INSTRUCTION = "Write 2 to 4 short lines, newest first, each naming one thing this coding session worked on recently (feature, bug, file area) and its outcome or current state. Plain text, one item per line, no bullets, no preamble. Output only those lines.";
function sessionSummaryFile(session, deps = {}) {
  const reader = deps.codex || codex;
  return session && (session.kind === 'codex'
    ? reader.rolloutFileFor(session.id) || reader.findRolloutFile(session.id)
    : (deps.findSessionFile || findSessionFile)(session.id));
}
function prepareSessionSummary(session, options = {}, deps = {}) {
  const file = sessionSummaryFile(session, deps);
  if (!file) return { text: null, fresh: false };
  const input = session.kind === 'codex' ? (deps.codex || codex).recentText(file) : recentTranscriptText(file);
  return (deps.getSummary || summarize.getSummary)(`session-${session.id}`, input, SESSION_INSTRUCTION, onChange, options);
}

async function sessionSummarySnapshot(deps = {}) {
  const panes = await listHostPanes(deps) || [];
  const live = [...hostPanesBySession(panes).values()].filter((p) => p.alive && ['claude', 'codex'].includes(p.meta?.agent));
  if (!live.length) return { sessions: [], panes };
  // Use the same marker-enriched classification as Triage. Raw transcript
  // lookups omit permission notifications that can arrive in the middle of a turn.
  const state = (deps.buildState || buildState)({ hostPanes: panes });
  return { sessions: state.sessions, panes };
}
const WEEKLY_INSTRUCTION = "Summarize what this solo developer completed in the last week. Group related work into 3-6 themed bullets and note anything notable that shipped. Be specific; output only the summary.";
const TAG_INSTRUCTION = "These tasks share a theme/tag. In 2-3 sentences describe the common thread and what's blocking or driving progress across them. Output only that.";
let onChange = () => {};
let onFocus = () => {};
let injectionBusy = false;
let sweepInFlight = false;
let inFlightSwap = null;
const daemonRestartGate = require('./daemon-restart').createGate({
  pending: () => {
    try { return fs.readdirSync(autoCompactDir()).filter(name => name.endsWith('.swap.json')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  },
  busy: () => sweepInFlight || injectionBusy,
});
let liveSessionTickInFlight = false;
let lastAutoCompactGc = 0;
let reviewStateCache = { at: 0, value: null };
const hostPaneCaches = new WeakMap();
let cachedHost = null;
let pendingHost = null;
let hostFailureAt = 0;
const HOST_FAILURE_CACHE_MS = 5000;
const HOST_PANE_CACHE_MS = 1000;
const HOST_CONNECT_TIMEOUT_MS = 3000;
const HOST_REQUEST_TIMEOUT_MS = 8000;
const HOST_RELOAD_RETRY_MS = 3000;

// ---------- session scanning ----------

const INJECTED_TURN_RE = /^<(?:system-reminder|task-notification|command-\w+|local-command-\w+|user-prompt-submit-hook|session-start-hook|cross-session-message)\b/i;
function isWrapperUser(text) {
  return /^<(system-reminder|command-|local-command|task-notification|bash-)/.test(text);
}

function isBoundedBackgroundWatcher(name, input) {
  if (name !== 'Bash' || !input || input.run_in_background !== true) return false;
  const command = String(input.command || '');
  // Finite build/test/device-install jobs also keep the session self-driven.
  // Do not infer completion from the assistant ending its foreground turn.
  const finiteWork = command.replace(/^\s*#.*$/gm, '');
  if (!/\b(?:while|until)\b|for\s*\(\([^;]*;\s*;|--(?:watch\w*|continuous)\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:dev|serve|watch)\b|\b(?:node|python3?)\b|tail\s+-\S*[fF]/.test(finiteWork)
      && /\b(?:adb\b[^\n;&|]*\b(?:install|install-multiple|screencap)|gradlew?\b[^\n;&|]*\b(?:assemble\w*|bundle\w*|test\w*)|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|test)\b|pytest\b|xcodebuild\b)/.test(finiteWork)) return true;
  // A finite timer or bounded polling watcher keeps the session self-driven. Dev
  // servers, tails, and loops with no exit path must still surface as needing input.
  if (/^\s*sleep\s+\d+(?:\.\d+)?(?:ms|s|m|h|d)?(?:\s*(?:;|&&)\s*(?:echo|printf)\b[^\n]*)?\s*$/.test(command)) return true;
  if (/(^|[;&|]\s*)keep\s+wait\b/.test(command)) return true;
  // Polling helpers hide their loop inside a script. A standalone wait_for_*
  // shell helper with an explicit execution bound is still self-driven work.
  // Do not classify arbitrary background scripts or compound commands this way.
  if (Number.isFinite(input.timeout) && input.timeout > 0
      && !/[\n;&|`$]/.test(command)
      && /^\s*(?:(?:bash|sh|zsh)\s+)?["']?(?:[\w./-]+\/)?wait_for_[\w-]+\.sh["']?(?:\s+[^\n;&|]*)?\s*$/.test(command)) return true;
  const loop = command.match(/\b(while|until|for)\b[\s\S]*?\bdo\b/);
  const done = [...command.matchAll(/\bdone\b/g)].at(-1);
  const loopCommand = loop && done ? command.slice(loop.index, done.index) : '';
  const arithmeticFor = loop?.[0].match(/^for\s*\(\([^;]*;([^;]*);[\s\S]*?\)\)/);
  const boundedFor = /^for\s+[A-Za-z_][A-Za-z0-9_]*\s+in\s+/.test(loop?.[0] || '')
    || Boolean(arithmeticFor?.[1].trim());
  const boundedLoop = Boolean(loop && done && /\bsleep\b/.test(loopCommand)
    && (/\b(?:break|exit)\b/.test(loopCommand)
      || loop[1] === 'until'
      || (loop[1] === 'for' && boundedFor)
      || /\bwhile\s+(?!(?:true|:)\s*(?:;|\bdo\b))/.test(loopCommand)));
  if (!boundedLoop) return false;
  const tail = command.slice(done.index + done[0].length)
    .trimStart().replace(/^(?:(?:;|&&|\|\|)\s*)+/, '').trim();
  if (!tail) return true;
  if (/[;&|\n]/.test(tail)) return false;
  const firstWord = tail.match(/^\S+/)?.[0];
  if (!['echo', 'printf', 'cat', 'date', 'node', 'python3', 'python', 'keep', 'tail'].includes(firstWord)) return false;
  return firstWord !== 'tail' || !/(?:^|\s)-\S*[fF]\S*(?:\s|$)/.test(tail);
}

function isBackgroundService(name, input) {
  if (name !== 'Bash') return false;
  const command = String(input?.command || '').replace(/^\s*#.*$/gm, '');
  return /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:dev|serve|watch)\b|\btail\s+-\S*[fF]|--(?:watch|continuous)\b/.test(command)
    || (/\bwhile\s+(?:true|:)\s*(?:;|\bdo\b)/.test(command) && !/\b(?:break|exit)\b/.test(command));
}

function stallAliveIds(ledger, now) {
  const cutoff = now - 10 * 60e3;
  if (!ledger || !(Number(ledger.updatedAt) >= cutoff)) return null;
  const liveIds = Object.entries(ledger.sessions || {})
    .filter(([, entry]) => entry && Number(entry.lastSeenAlive) >= cutoff)
    .map(([id]) => id);
  return liveIds.length ? new Set(liveIds) : null;
}

// A hit usage limit is written as a synthetic assistant record (model
// '<synthetic>'), not as a real turn. `error` is absent on some builds, so the
// 429 status is accepted on its own.
function isRateLimitError(j) {
  return j.isApiErrorMessage === true && (j.error === 'rate_limit' || j.apiErrorStatus === 429);
}

// The only window types the resume path knows how to reason about. Anything else
// (a transient 429, an overloaded upstream) is not a usage limit with a reset.
const RATE_LIMIT_TYPES = Object.freeze(['five_hour', 'seven_day']);

// quotaLimits.resetsAt is epoch SECONDS. Number(null) is 0 and Number('') is 0,
// which would read as the epoch and make the limit instantly eligible, so only a
// finite value inside a plausible range counts: 1e9s is 2001, 1e11s is the year
// 5138. A value past that upper bound is already milliseconds (some builds send
// ms), so it is taken as-is instead of multiplied again.
function rateLimitResetMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // Milliseconds must sit in the same 2001..5138 window; anything else is junk.
  if (n > 1e11) return n >= 1e12 && n <= 1e14 ? n : null;
  return n >= 1e9 ? n * 1000 : null;
}

function rateLimitInfo(j, text) {
  const quota = j.quotaLimits;
  const declared = quota && quota.rateLimitType;
  return {
    at: j.timestamp || '',
    text: String(text || '').slice(0, 200),
    // The 5h/weekly limits carry a machine-readable window; the per-model Fable
    // limit arrives with quotaLimits: null and only names itself in the prose, so
    // it is matched on the sentence the harness prints, not on a bare "Fable".
    type: RATE_LIMIT_TYPES.includes(declared) ? declared
      : /reached your Fable .* limit/i.test(String(text || '')) ? 'fable_weekly'
      : 'unknown',
    resetsAt: quota ? rateLimitResetMs(quota.resetsAt) : null,
  };
}

function scanTranscript(file, options = {}) {
  const text = options.full ? fs.readFileSync(file, 'utf8') : readTranscriptTail(file);
  const out = { title: '', cwd: '', gitBranch: '', lastUser: '', lastHuman: '', lastUserAt: null, lastAssistant: '', lastTs: '' };
  const pending = new Map();
  const bgAgents = new Set(); // launched background agents with no completion notification yet
  const agentResumedAt = {};
  const completedAgents = {};
  const seenCompletions = new Set();
  const bgTimers = new Set(); // finite background sleeps with no completion notification yet
  const bgMonitors = new Set();
  const bgCommands = new Set();
  const bgServices = new Set();
  let lastAssistantToolIds = [];
  let lastRealEvent = '';
  let lastStopReason = null;
  let lastAssistantHadText = false;
  let exitCommand = false;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.isSidechain && !options.includeSidechain) continue;
    // Claude can absorb completions mid-turn as attachments instead of user
    // messages. Queue records are also evidence that the job finished, even if
    // the notification has not yet been delivered to the model.
    const notification = j.type === 'queue-operation' ? j.content
      : j.type === 'attachment' && j.attachment?.type === 'queued_command' ? j.attachment.prompt
      : j.type === 'user' && j.message ? textOf(j.message.content) : '';
    if (typeof notification === 'string' && notification.trimStart().startsWith('<task-notification>')) {
      const id = notification.match(/<task-id>([a-z0-9_-]+)<\/task-id>/i)?.[1];
      const terminalStatus = /<status>(?:completed|failed|killed|stopped|cancelled)<\/status>/i.test(notification);
      const monitorTimeout = /<event>\s*\[Monitor timed out — re-arm if needed\.\]\s*<\/event>/.test(notification);
      const legacyCompletion = !/<status>|<event>|<summary>Monitor event:/i.test(notification);
      const queued = j.type === 'queue-operation' && (!j.operation || j.operation === 'enqueue');
      const delivered = j.type !== 'queue-operation' && !seenCompletions.has(notification.trim());
      if (id && (terminalStatus || legacyCompletion || monitorTimeout) && (queued || delivered)) {
        if (queued) seenCompletions.add(notification.trim());
        completedAgents[id] = Date.parse(j.timestamp || '') || 0;
        bgAgents.delete(id);
        bgTimers.delete(id);
        bgMonitors.delete(id);
        bgCommands.delete(id);
        bgServices.delete(id);
      }
    }
    if (out.exited && j.type !== 'file-history-snapshot') out.exited = false;
    // TUI-only record types: written from startup by interactive sessions,
    // never by headless `claude -p` runs (batch spawns from other projects).
    // NOTE: last-prompt/atis-latch appear in headless transcripts too — only
    // mode/permission-mode discriminate (validated against ~270 headless files).
    if (j.type === 'mode' || j.type === 'permission-mode') out.interactive = true;
    if (j.type === 'ai-title' && (j.title || j.aiTitle)) out.title = j.title || j.aiTitle;
    if (j.cwd) out.cwd = j.cwd;
    if (j.gitBranch) out.gitBranch = j.gitBranch;
    if (j.timestamp) out.lastTs = j.timestamp;
    if ((['user', 'assistant'].includes(j.type) || (j.type === 'attachment' && j.attachment?.type === 'queued_command'))
        && Number.isFinite(Date.parse(j.timestamp))) out.attentionAt = Date.parse(j.timestamp);
    if (j.type === 'user' && j.message) {
      if (Array.isArray(j.message.content)) {
        for (const item of j.message.content) {
          if (!item || item.type !== 'tool_result' || !item.tool_use_id) continue;
          const tool = pending.get(item.tool_use_id);
          pending.delete(item.tool_use_id);
          lastRealEvent = 'tool_result'; // The model still needs to continue after this result.
          const rt = typeof item.content === 'string' ? item.content : textOf(item.content);
          const backgroundCommand = rt && rt.match(/^Command running in background with ID:\s*([a-z0-9_-]+)/i);
          if (backgroundCommand) bgCommands.add(backgroundCommand[1]);
          if (backgroundCommand && tool?.backgroundService) bgServices.add(backgroundCommand[1]);
          if (rt && rt.includes('Async agent launched')) {
            const m = rt.match(/agentId:\s*([a-z0-9_-]+)/i);
            if (m) bgAgents.add(m[1]);
          }
          if (rt && tool?.name === 'SendMessage' && !item.is_error) {
            try {
              const result = JSON.parse(rt);
              if (result.success === true && /^[a-z0-9_-]+$/i.test(result.resumedAgentId || '')) {
                bgAgents.add(result.resumedAgentId);
                agentResumedAt[result.resumedAgentId] = Date.parse(j.timestamp || '') || 0;
              }
            } catch {} // Ordinary messages are not evidence of a new agent run.
          }
          if (rt && tool && tool.backgroundTimer) {
            const m = rt.match(/Command running in background with ID:\s*([a-z0-9_-]+)/i);
            if (m) bgTimers.add(m[1]);
          }
          if (rt && tool?.name === 'Monitor') {
            const m = rt.match(/^Monitor started \(task ([a-z0-9_-]+)/i);
            if (m) bgMonitors.add(m[1]);
          }
          if (tool?.name === 'TaskStop' && !item.is_error && /successfully stopped/i.test(rt)) {
            if (tool.input?.task_id) completedAgents[tool.input.task_id] = Date.parse(j.timestamp || '') || 0;
            bgMonitors.delete(tool.input?.task_id);
            bgTimers.delete(tool.input?.task_id);
            bgAgents.delete(tool.input?.task_id);
            bgCommands.delete(tool.input?.task_id);
            bgServices.delete(tool.input?.task_id);
          }
        }
      }
      const t = textOf(j.message.content).trimStart();
      if (t.startsWith('<command-name>')) {
        exitCommand = /^<command-name>\/(?:exit|quit)<\/command-name>/.test(t);
      }
      const hasToolResult = Array.isArray(j.message.content)
        && j.message.content.some((item) => item && item.type === 'tool_result');
      const humanAt = Date.parse(j.timestamp || '');
      if (t && !hasToolResult && !j.isCompactSummary && !isWrapperUser(t) && Number.isFinite(humanAt)) out.turnStartedAt = humanAt;
      // Hook and cross-session wrappers arrive as user turns too; they are not Owner typing.
      if (t && !hasToolResult && !isWrapperUser(t) && !INJECTED_TURN_RE.test(t) && !/^\[keep\](?:\s|$)/.test(t)
          && !j.isCompactSummary && Number.isFinite(humanAt)
          && (out.lastUserAt == null || humanAt > out.lastUserAt)) {
        out.lastUserAt = humanAt;
        out.lastHuman = t.slice(0, 600);
      }
      // skip harness wrappers, but keep real prompts that happen to start with <.
      // A compaction summary is stored as a user record too; it is not a prompt
      // awaiting an answer, and counting it left compacted sessions "mid-turn".
      if (t && !isWrapperUser(t) && !j.isCompactSummary) {
        out.exited = false;
        out.lastUser = t;
        lastRealEvent = 'user';
        // Owner (or the daemon) typed after the limit error: the session is no
        // longer parked on it, so it needs no resume.
        out.rateLimit = null;
      } else if (t.startsWith('<local-command-stdout>')) {
        // A typed local command (/compact, /model, ...) is logged as a bare user
        // prompt; this wrapper is the harness finishing it. The turn is over even
        // though no assistant record follows.
        // Claude Code randomizes the farewell (Goodbye!, Bye!, See ya!, ...), so the
        // /exit command that precedes it is the signal; the literals cover old transcripts.
        if (exitCommand || /^<local-command-stdout>(?:Goodbye!|Bye!|Catch you later!|See ya!)<\/local-command-stdout>$/.test(t.trim())) out.exited = true;
        exitCommand = false;
        lastRealEvent = 'assistant';
        lastStopReason = 'end_turn';
        lastAssistantHadText = true;
      }
      // Owner being at the keyboard also clears the stall, even when he typed a
      // slash command rather than a prompt: /model and /compact log a caveat, a
      // <command-name> record and a stdout wrapper, and a compaction writes its
      // summary as a user record. None of them is a prompt, but all of them mean
      // the session is no longer parked waiting for the window to roll over.
      // Tool results (content with no text) and sidechain records are not people.
      if (j.isCompactSummary || t.startsWith('<local-command-stdout>')
        || t.startsWith('<command-name>') || t.startsWith('<local-command-caveat>')) {
        out.rateLimit = null;
      }
    }
    if (j.type === 'assistant' && j.message) {
      out.exited = false;
      lastRealEvent = 'assistant';
      lastStopReason = j.message.stop_reason || null;
      lastAssistantHadText = Boolean(textOf(j.message.content));
      lastAssistantToolIds = [];
      if (Array.isArray(j.message.content)) {
        for (const item of j.message.content) {
          if (!item || item.type !== 'tool_use' || !item.id || !item.name) continue;
          lastAssistantToolIds.push(item.id);
          pending.set(item.id, ['AskUserQuestion', 'ExitPlanMode'].includes(item.name)
            ? { name: item.name, input: item.input, ts: j.timestamp || '' }
            : { name: item.name, input: item.name === 'TaskStop' ? item.input : undefined, waitingFor: sessionStatus.toolWaitReason(item.name, item.input), backgroundTimer: isBoundedBackgroundWatcher(item.name, item.input), backgroundService: isBackgroundService(item.name, item.input) });
        }
      }
      const t = textOf(j.message.content);
      if (t) out.lastAssistant = t;
      // A non-null rateLimit means the limit error is the session's last real
      // event; any later assistant record means the session already resumed.
      out.rateLimit = isRateLimitError(j) ? rateLimitInfo(j, t) : null;
    }
  }
  for (const p of pending.values()) {
    if (p.name !== 'AskUserQuestion') continue;
    const q = p.input && Array.isArray(p.input.questions) ? p.input.questions[0] || {} : {};
    out.pendingQuestion = {
      question: String(q.question || '').slice(0, 300),
      options: (Array.isArray(q.options) ? q.options : []).slice(0, 6).map((o) => String(o && o.label || '').slice(0, 60)),
      ts: p.ts,
    };
    break;
  }
  if (!out.pendingQuestion) {
    const p = [...pending.values()].find((x) => x.name === 'ExitPlanMode');
    if (p) out.pendingPlan = { ts: p.ts };
  }
  out.pendingOther = [...pending.values()].some((p) => !['AskUserQuestion', 'ExitPlanMode'].includes(p.name));
  out.toolRunning = lastAssistantToolIds.some((id) => pending.has(id));
  out.endedTurn = lastRealEvent === 'assistant' && pending.size === 0
    && (lastStopReason === 'end_turn' || (lastStopReason === null && lastAssistantHadText));
  out.explicitEndTurn = out.endedTurn && lastStopReason === 'end_turn';
  // Local slash commands may finish on screen before Claude flushes stdout to
  // its transcript. This is only permission to inspect the terminal, not idle proof.
  out.localCommandPending = lastRealEvent === 'user' && /^\/(?:compact|model)(?:\s|$)/.test(out.lastUser || '')
    ? out.lastUser : null;
  out.pendingBackground = bgAgents.size > 0 || bgTimers.size > 0 || bgMonitors.size > 0;
  out.backgroundAgents = [...bgAgents];
  out.agentResumedAt = agentResumedAt;
  out.completedAgents = completedAgents;
  out.backgroundTimerCount = bgTimers.size + bgMonitors.size;
  out.hasBackgroundCommands = bgCommands.size > 0;
  out.unknownBackgroundJobs = [...bgCommands].filter((id) => !bgTimers.has(id) && !bgServices.has(id));
  out.backgroundParentFile = file;
  out.waitingFor = [...pending.values()].find((tool) => tool.waitingFor)?.waitingFor || null;
  return out;
}

function sessionBackgroundPending(info) {
  if (!Array.isArray(info.backgroundAgents)) return Boolean(info.pendingBackground);
  if (info.backgroundTimerCount > 0) return true;
  return info.backgroundAgents.some((id) => {
    const parent = info.backgroundParentFile;
    const child = path.join(path.dirname(parent), path.basename(parent, '.jsonl'), 'subagents', `agent-${id}.jsonl`);
    try {
      // Notifications can be absent even after the child has finished. Consult
      // its actual final turn; unknown/missing children remain conservatively pending.
      const state = scanTranscript(child, { includeSidechain: true });
      // The child's previous completed turn cannot finish a newly resumed run.
      if (info.agentResumedAt?.[id] && !(state.attentionAt >= info.agentResumedAt[id])) return true;
      return !state.explicitEndTurn || state.pendingOther || state.pendingBackground;
    } catch { return true; }
  });
}

function transcriptActivityMs(info, fileMtimeMs) {
  const eventMs = Date.parse(info && info.lastTs || '');
  return Number.isFinite(eventMs) ? eventMs : fileMtimeMs;
}

function sessionNeedsInput(s, now) {
  return !s.reviewer && sessionStatus.activity(s).needsInput;
}

function recentTranscriptText(file) {
  const parts = [];
  for (const line of readTranscriptTail(file).split('\n')) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.isSidechain || !j.message) continue;
    if (j.type === 'user') {
      const t = textOf(j.message.content).trimStart();
      if (t && !isWrapperUser(t)) parts.push(`User: ${t}`);
    } else if (j.type === 'assistant') {
      const t = textOf(j.message.content);
      if (t) parts.push(`Assistant: ${t}`);
    }
  }
  return parts.join('\n\n').slice(-6000);
}

// ---------- terminal host session control ----------
// Keep used cmux as its terminal transport before the built-in host.

class InjectionError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

async function withInjectionLock(fn) {
  if (daemonRestartGate.stopping) throw new InjectionError(429, 'daemon restart is pending');
  if (injectionBusy) throw new InjectionError(429, 'another session injection is busy');
  injectionBusy = true;
  try {
    return await fn();
  } finally {
    injectionBusy = false;
  }
}

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function shouldCompactFirst(values, thresholds) {
  const idleMs = values && values.idleMs;
  const contextTokens = values && values.contextTokens;
  const ttlMs = thresholds && thresholds.ttlMs;
  const minTokens = thresholds && thresholds.minTokens;
  return [idleMs, contextTokens, ttlMs, minTokens].every(Number.isFinite)
    && idleMs > ttlMs && contextTokens >= minTokens;
}

function ensureCompactionRestored(result) {
  if (result && result.restoreUnconfirmed) {
    throw new InjectionError(409, 'model restore unconfirmed after compaction; not delivering');
  }
}

function afterCompactAction(result) {
  if (result && result.compacted) return 'proceed';
  const outcome = typeof result === 'string' ? result : result && result.reason;
  return outcome === 'timeout' ? 'defer' : 'proceed';
}

function lastTurnUsage(lines, kind) {
  const records = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  let result = { contextTokens: 0, model: '' };
  let sawClaudeUsage = false;
  for (const line of records) {
    let record;
    try { record = typeof line === 'string' ? JSON.parse(line) : line; } catch { continue; }
    if (kind === 'claude' && record && !record.isSidechain && record.type === 'assistant'
        && record.message && record.message.usage) {
      const usage = record.message.usage;
      let contextTokens = Number(usage.input_tokens || 0) + Number(usage.cache_creation_input_tokens || 0)
        + Number(usage.cache_read_input_tokens || 0);
      if (!Number.isFinite(contextTokens)) contextTokens = 0;
      result = { contextTokens, model: String(record.message.model || '') };
      sawClaudeUsage = true;
    } else if (kind === 'claude' && sawClaudeUsage && record && record.type === 'system'
        && record.subtype === 'compact_boundary') {
      result.contextTokens = Number(record.compactMetadata && record.compactMetadata.postTokens) || 0;
    } else if (kind === 'codex' && record && record.type === 'event_msg' && record.payload
        && record.payload.type === 'token_count' && record.payload.info && record.payload.info.last_token_usage) {
      const usage = record.payload.info.last_token_usage;
      let contextTokens = Number(usage.input_tokens || 0) + Number(usage.cached_input_tokens || 0);
      if (!Number.isFinite(contextTokens)) contextTokens = 0;
      result = { contextTokens, model: '' };
    }
  }
  return result;
}

function lastContextTokens(lines, kind) {
  return lastTurnUsage(lines, kind).contextTokens;
}

function screenTail(screen) {
  return String(screen || '').split(/\r?\n/).slice(-30).join('\n').slice(-600);
}

function isHostTarget(target) {
  return Boolean(target && typeof target.pane === 'string' && target.pane);
}

async function hostClient(deps = {}) {
  if (Object.prototype.hasOwnProperty.call(deps, 'host')) return deps.host || null;
  const runningTests = process.env.NODE_TEST_CONTEXT
    || process.argv.some((arg) => /(?:^|\/)bin\/[^/]+\.test\.js$/.test(arg));
  if (runningTests && typeof deps.connectHost !== 'function') return null;
  if (cachedHost && (!cachedHost.socket || !cachedHost.socket.destroyed)) return cachedHost;
  cachedHost = null;
  const now = deps.now || Date.now;
  if (!deps.forceHostReconnect && hostFailureAt && now() - hostFailureAt < HOST_FAILURE_CACHE_MS) return null;
  if (!pendingHost) {
    const connect = deps.connectHost
      || (deps.requireHostClient || require)('./hostclient.js').connect;
    pendingHost = connect({ timeoutMs: deps.hostConnectTimeoutMs || HOST_CONNECT_TIMEOUT_MS }).then((client) => {
      cachedHost = client;
      hostFailureAt = 0;
      if (client && typeof client.onDisconnect === 'function') {
        client.onDisconnect(() => {
          if (cachedHost === client) {
            cachedHost = null;
            hostFailureAt = 0;
          }
          hostPaneCaches.delete(client);
        });
      }
      return client;
    }).catch(() => {
      hostFailureAt = now();
      return null;
    }).finally(() => { pendingHost = null; });
  }
  return pendingHost;
}

function retryableHostError(error) {
  const code = error && error.code;
  return ['ECONNREFUSED', 'ECONNRESET', 'ENOENT', 'EPIPE'].includes(code)
    || /host (?:connection closed|is unavailable)|socket hang up/i.test(String(error && error.message || error));
}

function invalidateHost(client, deps = {}) {
  if (client && client === cachedHost) {
    try { client.close(); } catch {}
    cachedHost = null;
    hostFailureAt = (deps.now || Date.now)();
  }
  if (client && typeof client === 'object') hostPaneCaches.delete(client);
}

async function requestHostClient(client, type, params, deps = {}) {
  const timeoutMs = deps.hostRequestTimeoutMs == null ? HOST_REQUEST_TIMEOUT_MS : deps.hostRequestTimeoutMs;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => client.request(type, params || {}, { timeoutMs })),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`host request timed out (${type})`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function hostRequest(type, params, deps = {}) {
  const wallNow = deps.wallNow || Date.now;
  const retryMs = deps.hostReloadRetryMs == null ? HOST_RELOAD_RETRY_MS : deps.hostReloadRetryMs;
  const deadline = wallNow() + retryMs;
  const idempotent = ['hello', 'list', 'get', 'screen', 'meta'].includes(type);
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const notRetried = (reason, error) => {
    const failure = new Error(`terminal host ${reason} during non-idempotent ${type}; request was not retried`);
    failure.code = 'host_request_not_retried';
    failure.cause = error;
    return failure;
  };
  let forceHostReconnect = false;
  for (;;) {
    const remaining = deadline - wallNow();
    if (remaining <= 0) throw new Error(`terminal host reload retry timed out (${type})`);
    const connectTimeoutMs = Math.max(1, Math.min(
      deps.hostConnectTimeoutMs == null ? HOST_CONNECT_TIMEOUT_MS : deps.hostConnectTimeoutMs,
      remaining,
    ));
    let connectTimer;
    const client = await Promise.race([
      hostClient({ ...deps, forceHostReconnect, hostConnectTimeoutMs: connectTimeoutMs }),
      new Promise((resolve) => { connectTimer = setTimeout(() => resolve(null), remaining); }),
    ]);
    if (connectTimer) clearTimeout(connectTimer);
    if (!client) {
      const error = new Error('terminal host is unavailable');
      if (!idempotent) throw notRetried('was unavailable', error);
      if (wallNow() >= deadline) throw error;
      forceHostReconnect = true;
      await sleep(Math.min(50, Math.max(0, deadline - wallNow())));
      continue;
    }
    try {
      const attemptTimeoutMs = Math.max(1, Math.min(
        deps.hostRequestTimeoutMs == null ? HOST_REQUEST_TIMEOUT_MS : deps.hostRequestTimeoutMs,
        deadline - wallNow(),
      ));
      const result = await requestHostClient(client, type, params, {
        ...deps, hostRequestTimeoutMs: attemptTimeoutMs,
      });
      if (['spawn', 'meta', 'kill', 'remove', 'resize', 'clear'].includes(type)) hostPaneCaches.delete(client);
      return result;
    } catch (error) {
      if (client === cachedHost && client.socket && client.socket.destroyed) invalidateHost(client, deps);
      const reloadOrDisconnect = (error && error.code === 'reloading') || retryableHostError(error);
      if (!reloadOrDisconnect) throw error;
      if (!idempotent) {
        throw notRetried(error && error.code === 'reloading' ? 'was reloading' : 'disconnected', error);
      }
      if (wallNow() >= deadline) throw error;
      forceHostReconnect = true;
      await sleep(Math.min(50, Math.max(0, deadline - wallNow())));
    }
  }
}

async function listHostPanes(deps = {}, fresh = false) {
  const client = await hostClient(deps);
  if (!client) return null;
  const now = deps.now || Date.now;
  const cached = hostPaneCaches.get(client);
  if (!fresh && cached && now() - cached.at < HOST_PANE_CACHE_MS) return cached.panes;
  try {
    const result = await requestHostClient(client, 'list', {}, deps);
    const panes = Array.isArray(result && result.panes) ? result.panes : [];
    if (panes.some((p) => p?.alive && Number.isInteger(p.pid) && ['claude', 'codex'].includes(p.meta?.agent))) {
      try { annotatePaneAgents(panes, await (deps.agentProcessRows || agentProcessRows)(deps)); } catch {}
    }
    hostPaneCaches.set(client, { at: now(), panes });
    return panes;
  } catch {
    invalidateHost(client, deps);
    return null;
  }
}

function annotatePaneAgents(panes, rows) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  for (const pane of panes) {
    if (!pane?.alive || !['claude', 'codex'].includes(pane.meta?.agent)) continue;
    const root = byPid.get(pane.pid);
    if (!root) continue; // An incomplete process snapshot is not proof of exit.
    const tree = new Set([pane.pid]);
    for (let size = -1; size !== tree.size;) {
      size = tree.size;
      for (const row of rows) if (tree.has(row.ppid)) tree.add(row.pid);
    }
    const agent = rows.find((row) => tree.has(row.pid) && row.interactive && row.agent === pane.meta.agent);
    if (agent) { pane.agentAlive = true; pane.agentPid = agent.pid; }
    else if (tree.size === 1 && /^(?:\/bin\/(?:zsh|bash)|-(?:zsh|bash))(?:\s+-l)?$/.test(root.args)) {
      pane.agentAlive = false;
    }
  }
  return panes;
}

function sessionHostPane(panes, sessionId) {
  const matches = (Array.isArray(panes) ? panes : []).filter((pane) => pane && pane.meta
    && pane.meta.sessionId === sessionId);
  return matches.reduce((preferred, pane) => preferredHostPane(preferred, pane), null);
}

async function readScreenResult(target, lines, scrollback, deps = {}) {
  if (!isHostTarget(target)) throw new Error('terminal target needs a host pane');
  return hostRequest('screen', {
    pane: target.pane,
    lines,
    scrollback: scrollback ? lines : 0,
  }, deps);
}

async function readScreen(target, lines, scrollback, deps = {}) {
  const screen = await readScreenResult(target, lines, scrollback, deps);
  return String(screen && screen.text || '');
}

async function writeTarget(target, value, deps = {}) {
  if (!isHostTarget(target)) throw new Error('terminal target needs a host pane');
  await hostRequest('input', {
    pane: target.pane,
    data: Buffer.from(String(value), 'utf8').toString('base64'),
  }, deps);
}

async function pressTargetKey(target, key, deps = {}) {
  const named = {
    Enter: '\r', enter: '\r', Escape: '\x1b', escape: '\x1b', Backspace: '\x7f', backspace: '\x7f',
  };
  const value = Object.prototype.hasOwnProperty.call(named, key) ? named[key] : String(key);
  if (Array.from(value).length !== 1) throw new Error(`unsupported terminal key ${key}`);
  return writeTarget(target, value, deps);
}

function loadInjectionSession(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(id || ''))) throw new InjectionError(400, 'bad session id');
  const file = findSessionFile(id);
  if (!file) throw new InjectionError(404, 'no session transcript');
  try {
    return { file, info: scanTranscript(file) };
  } catch (e) {
    throw new Error(`cannot read session transcript: ${e.message}`);
  }
}

function sendPrecheck(screen) {
  const lines = String(screen || '').split(/\r?\n/);
  const bottom = lines.slice(-10);
  const hasPrompt = bottom.some((line) => /^\s*❯\s*$/.test(line));
  const hasModal = /(Enter to select|Enter to confirm|Held message|Esc to cancel)/.test(screen);
  if (hasModal && !hasPrompt) {
    throw new InjectionError(409, 'session is showing a modal; answer or dismiss it before sending a message', {
      screenTail: screenTail(screen),
    });
  }
  // typing appends to whatever is already in the input box — refuse rather than mangle a draft.
  // Take the bottom-most prompt line, bare `❯` included: the host strips trailing
  // whitespace, so an empty input box is `❯` alone, and skipping it would read an
  // echoed prompt just above (`❯ /model …` after a short reply) as a draft.
  const line = promptLine(screen);
  if (line && normalizedText(line.replace(/^\s*❯\s*/, ''))) {
    throw new InjectionError(409, 'the session input box already contains text; clear it in the terminal first', {
      screenTail: screenTail(screen),
    });
  }
}

function promptLine(screen) {
  return String(screen || '').split(/\r?\n/).slice(-10).reverse()
    .find((line) => /^\s*❯(?:\s|$)/.test(line));
}

function promptText(line) {
  return line == null ? '' : line.replace(/^\s*❯\s*/, '').trim();
}

// Did the probe keystroke actually reach the input box? Only two shapes prove it: the
// suggestion collapsed to exactly the probe key, or the existing text grew by it.
// Anything else (a user edit landing at the same moment) must not trigger a Backspace.
function probeLanded(beforeScreen, afterScreen, probe = SUGGESTION_PROBE_KEY) {
  const afterText = promptText(promptLine(afterScreen));
  if (afterText === probe) return true;
  if (!afterText.endsWith(probe)) return false;
  return normalizedText(afterText.slice(0, -probe.length))
    === normalizedText(promptText(promptLine(beforeScreen)));
}

function classifyPromptLine(beforeScreen, afterScreen, probe = SUGGESTION_PROBE_KEY) {
  const before = promptLine(beforeScreen);
  const beforeText = before == null ? '' : before.replace(/^\s*❯\s*/, '');
  if (!normalizedText(beforeText)) return 'empty';
  const after = promptLine(afterScreen);
  // No prompt line at all: Claude Code is mid-render. Not evidence either way — the
  // caller keeps polling and refuses at the deadline.
  if (after == null) return 'unchanged';
  const afterText = after.replace(/^\s*❯\s*/, '').trim();
  // The suggestion is drawn only while the input value is empty, so the probe key
  // replaces it outright. A draft keeps its text and grows by the probe key. A draft
  // that is *already* exactly the probe key is the one case the collapsed suggestion
  // cannot be told from a stale read, so it falls through to unchanged/draft instead.
  if (afterText === probe && normalizedText(beforeText) !== probe) return 'suggestion';
  if (normalizedText(afterText) === normalizedText(beforeText)) return 'unchanged';
  return 'draft';
}

// The 409 body carries the screen tail, but nothing wrote it down: 21 refusals against
// sessions that only showed a suggestion left no trace of what the prompt line held.
function logDraftRefusal(target, message, beforeScreen, afterScreen, probe, deps = {}) {
  const write = deps.stderr || process.stderr.write.bind(process.stderr);
  const show = (line) => (line == null ? '(none)' : JSON.stringify(line));
  const out = [`keep serve: draft refusal on pane ${(target && target.pane) || 'unknown'}: ${message}`];
  out.push(`  prompt before: ${show(promptLine(beforeScreen))}`);
  if (afterScreen != null) out.push(`  prompt after probe ${JSON.stringify(probe)}: ${show(promptLine(afterScreen))}`);
  out.push('  screen tail:');
  for (const line of screenTail(afterScreen == null ? beforeScreen : afterScreen).split('\n')) out.push(`    | ${line}`);
  write(`${out.join('\n')}\n`);
}

async function probeSuggestion(target, beforeScreen, deps = {}) {
  let precheckError;
  try {
    sendPrecheck(beforeScreen);
    return;
  } catch (error) {
    precheckError = error;
  }
  const containsText = /session input box already contains text/.test(precheckError.message);
  if (!containsText || process.env.KEEP_PROBE_SUGGESTION === '0') {
    if (containsText) logDraftRefusal(target, precheckError.message, beforeScreen, null, null, deps);
    throw precheckError;
  }

  const read = deps.readScreen || ((t, lines, scrollback) => readScreen(t, lines, scrollback, deps));
  const wait = deps.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || Date.now;
  const beforeText = promptText(promptLine(beforeScreen));
  let typed = false;
  // The error we are on our way out with, so the finally block knows whether a failed
  // Backspace is the only thing that went wrong.
  let failure = null;
  let lastScreen = null;
  try {
    try {
      await writeTarget(target, SUGGESTION_PROBE_KEY, deps);
      typed = true;
    } catch (error) {
      // A write that reported failure may still have delivered the keystroke. Watch
      // for the probe's own signature — never for "something changed", which would
      // Backspace a character the user typed at the same moment.
      for (let attempt = 0; attempt < 3 && !typed; attempt += 1) {
        await wait(SUGGESTION_PROBE_WAIT_MS);
        try {
          lastScreen = await read(target, 30, false);
        } catch {
          break;
        }
        if (probeLanded(beforeScreen, lastScreen)) typed = true;
      }
      throw error;
    }
    const startedAt = now();
    let reads = 0;
    for (;;) {
      await wait(SUGGESTION_PROBE_WAIT_MS);
      let afterScreen;
      try {
        afterScreen = await read(target, 30, false);
      } catch {
        logDraftRefusal(
          target,
          `${precheckError.message} (screen could not be re-read after the probe)`,
          beforeScreen, null, null, deps,
        );
        throw precheckError;
      }
      reads += 1;
      lastScreen = afterScreen;
      const outcome = classifyPromptLine(beforeScreen, afterScreen);
      // 'empty' cannot happen here (sendPrecheck already saw text), but an empty box
      // is as safe to type into as a suggestion.
      if (outcome === 'suggestion' || outcome === 'empty') return;
      const afterText = promptText(promptLine(afterScreen));
      const extra = () => ({
        screenTail: screenTail(afterScreen),
        probe: { key: SUGGESTION_PROBE_KEY, before: beforeText, after: afterText, outcome },
      });
      if (outcome === 'draft') {
        const message = 'the session input box contains a draft (not a prompt suggestion); clear it in the terminal first';
        logDraftRefusal(target, message, beforeScreen, afterScreen, SUGGESTION_PROBE_KEY, deps);
        throw new InjectionError(409, message, extra());
      }
      // 'unchanged': Claude Code may simply not have re-rendered yet. Keep polling
      // until the deadline, then refuse — an unreactive prompt is not provably empty.
      if (now() - startedAt >= SUGGESTION_PROBE_MAX_MS || reads >= SUGGESTION_PROBE_MAX_READS) {
        const message = 'the session input box shows text that did not react to a probe keystroke (a draft, or a prompt suggestion that has not re-rendered); clear it in the terminal first';
        logDraftRefusal(target, message, beforeScreen, afterScreen, SUGGESTION_PROBE_KEY, deps);
        throw new InjectionError(409, message, extra());
      }
    }
  } catch (error) {
    // Single place that records what we are throwing, so no exit path can reach the
    // cleanup below looking like a success.
    if (failure == null) failure = error;
    throw error;
  } finally {
    // Only undo a keystroke that actually landed: a failed send followed by Backspace
    // would eat the last character of a real draft.
    if (typed) {
      try {
        await pressTargetKey(target, 'Backspace', deps);
      } catch (error) {
        const message = 'the probe keystroke could not be undone; clear the session input box in the terminal first';
        if (failure == null) {
          // A probe we could not undo left a stray comma in the box, and nothing else
          // went wrong — that is the whole refusal.
          logDraftRefusal(target, message, beforeScreen, lastScreen, SUGGESTION_PROBE_KEY, deps);
          throw new InjectionError(409, message, { screenTail: screenTail(lastScreen == null ? beforeScreen : lastScreen) });
        }
        // A more specific refusal is already on its way out and wins, but the stray
        // comma still has to be visible to whoever reads the error or the log.
        const detail = String((error && error.message) || error);
        if (failure.extra) failure.extra.cleanupError = detail;
        const write = deps.stderr || process.stderr.write.bind(process.stderr);
        write(`keep serve: draft refusal cleanup failed on pane ${(target && target.pane) || 'unknown'}: ${detail}\n`);
      }
    }
  }
}

function codexSendPrecheck(screen) {
  const visibleDialogs = CODEX_DIALOG_MARKERS.filter((marker) => String(screen || '').includes(marker));
  if (visibleDialogs.length) {
    throw new InjectionError(409, `Codex is showing a dialog (${visibleDialogs.join('; ')}); answer or dismiss it before sending a message`, {
      screenTail: screenTail(screen),
    });
  }
  if (!String(screen || '').includes('› Ask Codex to do anything')) {
    throw new InjectionError(409, 'Codex is not showing the empty input placeholder; wait for the turn to finish or clear the terminal input first', {
      screenTail: screenTail(screen),
    });
  }
}

function typedTextFingerprint(text) {
  const normalized = String(text || '').replace(/\s/g, '');
  return normalized.length > 40 ? normalized.slice(-40) : normalized;
}

function codexTypedTextVisible(screen, text) {
  const lines = String(screen || '').split(/\r?\n/);
  let promptLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*›(?:\s|$)/.test(lines[index])) promptLine = index;
  }
  if (promptLine === -1) return false;
  return lines.slice(promptLine).join('').replace(/\s/g, '').includes(typedTextFingerprint(text));
}

function claudeTypedTextVisible(screen, text) {
  return String(screen || '').replace(/\s/g, '').includes(typedTextFingerprint(text));
}

function exactDraft(screen, text, kind) {
  if (CODEX_DIALOG_MARKERS.some((marker) => String(screen).includes(marker)) || /Do you want to proceed\?|Allow this|Accept this plan|Esc to cancel|Enter to select|Enter to confirm|Held message/i.test(String(screen))) return false;
  const lines = String(screen || '').split(/\r?\n/);
  const prompt = kind === 'codex' ? /^\s*›(?:\s|$)/ : /^\s*❯(?:\s|$)/;
  let start = -1;
  lines.forEach((line, i) => { if (prompt.test(line)) start = i; });
  if (start < 0) return false;
  const draft = [lines[start].replace(prompt, '')];
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].trim() || /^\s*[─━]/.test(lines[i])) break;
    draft.push(lines[i]);
  }
  const escaped = draft.map((line) => line.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('^' + escaped.join('\\s*') + '$').test(String(text).trim());
}

function closeDraftVisible(screen, text, kind) {
  if (kind !== 'claude') return exactDraft(screen, text, kind);
  const lines = String(screen || '').split(/\r?\n/);
  let start = -1;
  lines.forEach((line, i) => { if (/^\s*❯(?:\s|$)/.test(line)) start = i; });
  // Anchor to Claude's ruled input box, not an echoed prompt in output.
  if (start < 1 || !(/^\s*[─━]{3,}\s*$/.test(lines[start - 1])
      || /^\s*─{20,}\s\S[^─]{0,80}\s─\s*$/.test(lines[start - 1]))) return false;
  return exactDraft(lines.slice(start).join('\n'), text, kind);
}

function chunkForTyping(text, max) {
  const points = Array.from(String(text || ''));
  if (!points.length) return [];
  const limit = Math.floor(Number(max));
  if (!Number.isFinite(limit) || limit < 1) throw new RangeError('typing chunk size must be at least 1');
  const chunks = [];
  for (let start = 0; start < points.length;) {
    let end = Math.min(points.length, start + limit);
    if (end < points.length) {
      const space = points.lastIndexOf(' ', end - 1);
      if (space >= start) end = space + 1;
    }
    chunks.push(points.slice(start, end).join(''));
    start = end;
  }
  return chunks;
}

async function typeAndSubmit(target, text, confirmationCheck, deps = {}) {
  const read = deps.readScreen || ((t, lines, scrollback) => readScreen(t, lines, scrollback, deps));
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const chunkChars = Math.max(1, Math.floor(envNumber('KEEP_SEND_CHUNK_CHARS', 200)));
  const chunkDelayMs = envNumber('KEEP_SEND_CHUNK_DELAY_MS', 120);
  const chunks = chunkForTyping(text, chunkChars);
  deps.deliveryTrace?.('write-start');
  for (let index = 0; index < chunks.length; index += 1) {
    await writeTarget(target, chunks[index], deps);
    if (index + 1 < chunks.length && chunkDelayMs > 0) await sleep(chunkDelayMs);
  }
  deps.deliveryTrace?.('write-finished');
  let confirmed = false;
  let confirmation = '';
  for (let attempt = 0; attempt < 4 && !confirmed; attempt += 1) {
    await sleep(400);
    try { confirmation = await read(target, deps.confirmationLines === undefined ? 30 : deps.confirmationLines, false); } catch { deps.deliveryTrace?.('screen-read-failed'); continue; }
    confirmed = confirmationCheck(confirmation, text);
    deps.deliveryTrace?.('screen-confirmation', { matched: confirmed });
  }
  if (!confirmed) {
    throw new InjectionError(409, 'message was typed but could not be confirmed; Enter was not pressed', {
      screenTail: screenTail(confirmation),
    });
  }
  if (deps.beforeEnter) await deps.beforeEnter();
  deps.deliveryTrace?.('enter-start');
  await pressTargetKey(target, 'Enter', deps);
  deps.deliveryTrace?.('enter-sent');
  return { ok: true };
}

function transcriptFileForSession(session) {
  return session.kind === 'codex'
    ? codex.rolloutFileFor(session.id)
    : findSessionFile(session.id);
}

function appendedBytes(file, offset) {
  const stat = fs.statSync(file);
  if (stat.size <= offset) return { text: '', offset, stat, bytesRead: 0 };
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - offset);
    const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
    return { text: buffer.subarray(0, read).toString('utf8'), offset: offset + read, stat, bytesRead: read };
  } finally {
    fs.closeSync(fd);
  }
}

function deliveredMatches(content, text) {
  return normalizedText(content) === normalizedText(text);
}

function compactRefusal(screen) {
  const m = normalizedText(screen).match(/Not enough messages to compact\.?|Compaction failed[^.]*\.?/i);
  return m ? m[0] : '';
}

function compactCommand(instruction) {
  const suffix = normalizedText(instruction);
  return '/compact' + (suffix ? ' ' + suffix.slice(0, 1800) : '');
}

function hasCompactionMarker(text, kind) {
  if (kind === 'codex') return String(text || '').includes('ContextCompaction');
  for (const line of String(text || '').split(/\r?\n/)) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record && record.type === 'system' && record.subtype === 'compact_boundary') return true;
  }
  return false;
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function envString(name, fallback) {
  const value = String(process.env[name] || '').trim();
  return value || fallback;
}

function compactModelFamilies() {
  const families = envString('KEEP_AUTO_COMPACT_MODELS', 'fable')
    .split(',').map((model) => model.trim().toLowerCase()).filter(Boolean);
  return families.length ? families : ['fable'];
}

function claudeSettingsPath() {
  return envString(
    'KEEP_CLAUDE_SETTINGS_PATH',
    path.join(os.homedir(), '.claude', 'settings.json'),
  );
}

function readClaudeSettingsModel() {
  try {
    const settings = JSON.parse(fs.readFileSync(claudeSettingsPath(), 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('settings.json does not contain a JSON object');
    }
    const present = Object.prototype.hasOwnProperty.call(settings, 'model');
    return { ok: true, present, value: present ? settings.model : '' };
  } catch (e) {
    return {
      ok: false,
      present: false,
      value: '',
      error: String(e && e.message || e),
    };
  }
}

function repairClaudeSettingsModel(expected, expectedPresent = Boolean(expected)) {
  const expectedModel = typeof expected === 'string' ? expected : '';
  const file = claudeSettingsPath();
  let temp = '';
  try {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('settings.json does not contain a JSON object');
    }
    const hasModel = Object.prototype.hasOwnProperty.call(settings, 'model');
    const currentModel = hasModel ? settings.model : '';
    if ((expectedPresent && hasModel && currentModel === expectedModel)
        || (!expectedPresent && !hasModel)) {
      return { changed: false };
    }
    if (expectedPresent) settings.model = expectedModel;
    else delete settings.model;
    temp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
    );
    const mode = fs.statSync(file).mode & 0o777;
    fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`);
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
    temp = '';
    return { changed: true };
  } catch (e) {
    return { changed: false, error: String(e && e.message || e) };
  } finally {
    if (temp) {
      try { fs.unlinkSync(temp); } catch {}
    }
  }
}

function compactSwapPlan(session, opts) {
  const via = String(opts && opts.via || '').trim();
  if (!via || via.toLowerCase() === 'off' || !session || session.kind !== 'claude') return null;
  const originalModel = String(session.model || '').trim();
  if (!originalModel) return null;
  const modelLower = originalModel.toLowerCase();
  if (modelLower.includes(via.toLowerCase())) return null;
  const families = Array.isArray(opts && opts.families) ? opts.families : [];
  if (!families.some((family) => {
    const needle = String(family || '').trim().toLowerCase();
    return needle && modelLower.includes(needle);
  })) return null;
  const settingsPresent = typeof (opts && opts.settingsPresent) === 'boolean'
    ? opts.settingsPresent : Boolean(opts && opts.settingsModel);
  if (settingsPresent && typeof (opts && opts.settingsModel) !== 'string') return null;
  const settingsModelRaw = typeof (opts && opts.settingsModel) === 'string' ? opts.settingsModel : '';
  const settingsBase = settingsModelRaw.replace(/\[1m\]$/i, '');
  const restoreModel = settingsBase.toLowerCase() === modelLower ? settingsModelRaw : originalModel;
  return {
    switchCommand: `/model ${via}`,
    restoreCommand: `/model ${restoreModel}`,
    originalModel,
    settingsModelBefore: settingsModelRaw,
    settingsModelPresent: settingsPresent,
  };
}

function linesAfterLastEcho(screen, command) {
  const lines = String(screen || '').split(/\r?\n/).map(normalizedText);
  const needle = normalizedText(command);
  if (!needle) return [];
  let echoIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes(needle)) echoIndex = index;
  }
  return echoIndex === -1 ? [] : lines.slice(echoIndex + 1);
}

function modelSwitchConfirmed(screen, command) {
  const argument = String(command || '').replace(/^\s*\/model\s+/i, '');
  const family = ['opus', 'sonnet', 'haiku', 'fable']
    .find((candidate) => argument.toLowerCase().includes(candidate));
  // Match only below this command's final echo: the screen tail can retain an
  // earlier successful switch to the same family.
  return linesAfterLastEcho(screen, command).some((line) => {
    const status = line.match(/(?:^|[^A-Za-z])(?:Set model to|Switched to) ([^\n]*)/);
    if (!status) return false;
    if (!family) return true;
    return new RegExp(family, 'i').test(status[1]);
  });
}

function modelSwitchDialogVisible(screen, command) {
  const lines = command === undefined
    ? String(screen || '').split(/\r?\n/).map(normalizedText)
    : linesAfterLastEcho(screen, command);
  return lines.some((line) => /Switch model\?|Yes, switch to/i.test(line));
}

function compactModelBase(value) {
  return String(value || '').replace(/\[1m\]$/i, '').toLowerCase();
}

function compactModelContainsFamily(model, family) {
  const needle = compactModelBase(family);
  return Boolean(needle) && compactModelBase(model).includes(needle);
}

function writeCompactSwapRecord(file, record) {
  const dir = path.dirname(file);
  const sessionId = String(record && record.sessionId || path.basename(file, '.swap.json'));
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${sessionId}.swap.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const saved = { ...record };
  delete saved.file;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(saved)}\n`);
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

function writePendingCompactSwap(session, plan, dir = autoCompactDir(), at = Date.now()) {
  const sessionId = String(session && session.id || '');
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('bad compact session id');
  const file = path.join(dir, `${sessionId}.swap.json`);
  const record = {
    sessionId,
    originalModel: plan.originalModel,
    restoreCommand: plan.restoreCommand,
    switchModel: String(plan.switchCommand || '').replace(/^\s*\/model\s+/i, ''),
    settingsModelBefore: plan.settingsModelBefore,
    settingsModelPresent: plan.settingsModelPresent,
    at,
  };
  writeCompactSwapRecord(file, record);
  return file;
}

function readPendingCompactSwap(sessionId, dir = autoCompactDir()) {
  const id = String(sessionId || '');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const file = path.join(dir, `${id}.swap.json`);
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    return { ...record, file };
  } catch { return null; }
}

function pendingCompactSwaps(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((name) => name.endsWith('.swap.json')).sort().map((name) => {
    const file = path.join(dir, name);
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('swap record does not contain a JSON object');
      }
      return { ...record, file };
    } catch (e) {
      return {
        sessionId: name.slice(0, -'.swap.json'.length),
        restoreCommand: 'unknown (unreadable swap record)',
        file,
        error: String(e && e.message || e),
      };
    }
  });
}

async function waitForModelSwitch(target, command, sid, deps = {}) {
  const now = deps.now || Date.now;
  const read = deps.readScreen || ((t, lines, scrollback) => readScreen(t, lines, scrollback, deps));
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + envNumber('KEEP_MODEL_SWITCH_TIMEOUT_MS', 15000);
  let acceptedDialog = false;
  while (now() < deadline) {
    await sleep(Math.min(500, deadline - now()));
    try {
      const screen = await read(target, 30, false);
      if (modelSwitchConfirmed(screen, command)) return true;
      if (!acceptedDialog && modelSwitchDialogVisible(screen, command)) {
        // Mark first: even an ambiguous transport failure must not cause a second Enter.
        acceptedDialog = true;
        await pressTargetKey(target, 'Enter', deps);
        process.stderr.write(`keep serve: accepted the model-switch dialog for ${sid} (${command})\n`);
      }
    } catch {}
  }
  return false;
}

function shutdownSettingsRepair(swap, currentSettings) {
  if (!swap) return { repair: false, reason: 'no in-flight swap' };
  if (!currentSettings.ok) return { repair: false, reason: 'settings model is unreadable' };
  if (!compactModelContainsFamily(currentSettings.value, swap.switchModel || swap.via || 'opus')) {
    return { repair: false, reason: 'settings model does not match the compaction via family' };
  }
  return { repair: true, value: swap.settingsModelBefore, present: swap.settingsModelPresent };
}

function compactRestoreBusy(session) {
  return !session || session.exited || (session.endedTurn === false && !session.localCommandPending)
    || (session.state === 'running' && session.endedTurn === undefined)
    || session.toolRunning || session.pendingOther
    || session.pendingQuestion || session.pendingPlan
    || (session.notify && ['permission', 'question'].includes(session.notify.type));
}

function compactSwapRecordAt(record) {
  if (record.at != null && String(record.at).trim() !== '' && Number.isFinite(Number(record.at))) return Number(record.at);
  try { return fs.statSync(record.file).mtimeMs; } catch { return 0; }
}

async function sweepPendingCompactSwaps(deps = {}) {
  const summary = { checked: 0, restored: 0, dropped: 0, skipped: 0, repairedSettings: 0 };
  if (sweepInFlight) return summary;
  sweepInFlight = true;
  const now = deps.now || Date.now;
  const dir = deps.dir || autoCompactDir();
  const scan = deps.scanSessions || scanSessions;
  const resolve = deps.resolveSessionTarget || resolveSessionTarget;
  const precheck = deps.precheckSessionTarget || precheckSessionTarget;
  const read = deps.readScreen || ((t, lines, scrollback) => readScreen(t, lines, scrollback, deps));
  const submit = deps.typeAndSubmit || typeAndSubmit;
  const waitForSwitch = deps.waitForModelSwitch || waitForModelSwitch;
  const lock = deps.withInjectionLock || withInjectionLock;
  const readSettings = deps.readClaudeSettingsModel || readClaudeSettingsModel;
  const repairSettings = deps.repairClaudeSettingsModel || repairClaudeSettingsModel;
  try {
    const records = pendingCompactSwaps(dir);
    summary.checked = records.length;
    if (!records.length) return summary;
    const repairedSettingsRecords = new Set();
    const noteSettingsRepair = (record, repaired) => {
      if (!repaired.changed || repairedSettingsRecords.has(record.file)) return;
      repairedSettingsRecords.add(record.file);
      summary.repairedSettings += 1;
    };
    // Settings are process-global. Repair them even when the owning session has
    // exited, disappeared, or cannot safely receive a command this tick.
    const settingsRecord = records.filter((record) => !record.error)
      .sort((a, b) => compactSwapRecordAt(b) - compactSwapRecordAt(a))[0];
    if (settingsRecord && !inFlightSwap) {
      const sid = String(settingsRecord.sessionId || 'unknown').slice(0, 8);
      try {
        await lock(async () => {
          const settings = readSettings();
          const via = String(settingsRecord.switchModel || envString('KEEP_COMPACT_VIA_MODEL', 'opus')).trim();
          if (!settings.ok || !compactModelContainsFamily(settings.value, via)) return;
          const repaired = repairSettings(settingsRecord.settingsModelBefore, settingsRecord.settingsModelPresent);
          noteSettingsRepair(settingsRecord, repaired);
          if (repaired.changed) {
            process.stderr.write(`keep serve: restored settings.json model to "${settingsRecord.settingsModelBefore}" after an interrupted compaction of ${sid}\n`);
          } else if (repaired.error) {
            process.stderr.write(`keep serve: could not restore settings.json model after an interrupted compaction of ${sid}: ${repaired.error}\n`);
          }
        });
      } catch (e) {
        if (!(e instanceof InjectionError && e.status === 429)) {
          process.stderr.write(`keep serve: could not restore settings.json model after an interrupted compaction of ${sid}: ${String(e && e.message || e)}\n`);
        }
      }
    }
    let sessions;
    try { sessions = scan(); }
    catch (e) {
      for (const record of records) {
        summary.skipped += 1;
        const sid = String(record.sessionId || 'unknown').slice(0, 8);
        process.stderr.write(`keep serve: MODEL RESTORE UNCONFIRMED for claude session ${sid}: ${String(e && e.message || e)}\n`);
      }
      return summary;
    }
    const byId = new Map((sessions || []).map((session) => [session.id, session]));
    for (const record of records) {
      const sid = String(record.sessionId || 'unknown').slice(0, 8);
      const session = byId.get(record.sessionId);
      const stale = now() - compactSwapRecordAt(record) > envNumber('KEEP_COMPACT_SWAP_MAX_AGE_MIN', 24 * 60) * 60e3;
      if (stale) {
        try { fs.unlinkSync(record.file); } catch (e) {
          if (e.code !== 'ENOENT') {
            summary.skipped += 1;
            process.stderr.write(`keep serve: MODEL RESTORE UNCONFIRMED for claude session ${sid}: ${e.message}\n`);
            continue;
          }
        }
        summary.dropped += 1;
        process.stderr.write(`keep serve: expired model restore record for ${sid}\n`);
        continue;
      }
      if (record.error) {
        summary.skipped += 1;
        process.stderr.write(`keep serve: MODEL RESTORE UNCONFIRMED for claude session ${sid}: ${record.error}\n`);
        continue;
      }
      // Assistant usage lags /model commands. Always attempt the idempotent
      // restore for a live session, regardless of its last assistant model.
      if (compactRestoreBusy(session)) {
        summary.skipped += 1;
        continue;
      }
      if (Number.isFinite(Number(record.lastAttemptAt))
          && now() - Number(record.lastAttemptAt) < envNumber('KEEP_COMPACT_RESTORE_RETRY_MIN', 10) * 60e3) {
        summary.skipped += 1;
        continue;
      }

      try {
        const restored = await lock(async () => {
          const current = scan().find((candidate) => candidate.id === record.sessionId);
          if (compactRestoreBusy(current)) return null;
          const target = await resolve(current, null, deps);
          if (current.localCommandPending) {
            const screen = await read(target, 30, false);
            const after = linesAfterLastEcho(screen, current.localCommandPending).join('\n');
            const complete = /^\/compact(?:\s|$)/.test(current.localCommandPending)
              ? /(?:Compacted|Conversation compacted|Conversation recap|Not enough messages to compact)/i.test(after)
              : /(?:Set model to|Switched to) /i.test(after);
            if (!complete || !promptLine(screen) || /esc to (?:interrupt|cancel)|Compacting[.…]/i.test(screen)) return null;
          }
          await precheck(current, target, deps);
          // typeAndSubmit confirms the typed command, but does not check the
          // input box or modal before typing. The re-read goes through the suggestion
          // probe too: the probe's Backspace puts the prompt suggestion back, so a
          // bare sendPrecheck here would see it again and refuse.
          await probeSuggestion(target, await read(target, 30, false), deps);
          const via = String(record.switchModel || envString('KEEP_COMPACT_VIA_MODEL', 'opus')).trim();
          const before = readSettings();
          // /model also overwrites settings.json. Save a hand change so we can
          // put it back after our command, without overwriting a later hand edit.
          const saved = before.ok && !compactModelContainsFamily(before.value, via)
            ? { settingsModelBefore: before.value, settingsModelPresent: before.present }
            : settingsRecord;
          const restoreModel = String(record.restoreCommand || '').replace(/^\s*\/model\s+/i, '').trim();
          const repair = () => {
            const after = readSettings();
            if (!after.ok || (before.ok && after.value === before.value)) return;
            // Compare-and-swap: only undo the value our own /model command wrote. Anything
            // else is a newer hand change made while we waited, and it stays.
            if (compactModelBase(after.value) !== compactModelBase(restoreModel)) return;
            const repaired = repairSettings(saved.settingsModelBefore, saved.settingsModelPresent);
            noteSettingsRepair(record, repaired);
            if (repaired.error) {
              process.stderr.write(`keep serve: could not restore settings.json model after an interrupted compaction of ${sid}: ${repaired.error}\n`);
            }
          };
          try {
            record.at = compactSwapRecordAt(record); // Preserve mtime-based age across retry writes.
            record.lastAttemptAt = now();
            writeCompactSwapRecord(record.file, record);
            await submit(target, record.restoreCommand, claudeTypedTextVisible, deps);
            return await waitForSwitch(target, record.restoreCommand, sid, deps);
          } finally {
            repair();
          }
        });
        if (restored === null) {
          summary.skipped += 1;
          continue;
        }
        if (!restored) throw new Error(`expected "${record.restoreCommand}"`);
        fs.unlinkSync(record.file);
        summary.restored += 1;
        const restoreModel = String(record.restoreCommand || '').replace(/^\s*\/model\s+/i, '');
        process.stderr.write(`keep serve: restored claude session ${sid} to "${restoreModel}" after an interrupted compaction\n`);
      } catch (e) {
        if (e instanceof InjectionError && e.status === 429) {
          summary.skipped += 1;
          continue;
        }
        summary.skipped += 1;
        process.stderr.write(`keep serve: MODEL RESTORE UNCONFIRMED for claude session ${sid}: ${String(e && e.message || e)}\n`);
      }
    }
    return summary;
  } finally {
    sweepInFlight = false;
  }
}

async function compactSession(session, target, instruction, deps = {}) {
  const leave = daemonRestartGate.enter();
  try { return await compactSessionTransaction(session, target, instruction, deps); }
  finally { leave(); }
}

async function compactSessionTransaction(session, target, instruction, deps = {}) {
  const sid = String(session && session.id || 'unknown').slice(0, 8);
  process.stderr.write(`keep serve: compacting ${session && session.kind || 'unknown'} session ${sid}\n`);
  const dir = deps.dir || autoCompactDir();
  const lastTurn = (deps.sessionLastTurn || sessionLastTurn)(session);
  const pendingRecord = readPendingCompactSwap(session && session.id, dir);
  const configuredVia = envString('KEEP_COMPACT_VIA_MODEL', 'opus');
  const settingsSnapshot = session && session.kind === 'claude'
    ? (deps.readClaudeSettingsModel || readClaudeSettingsModel)() : { ok: true, present: false, value: '' };
  let swap = null;
  let via = null;
  let pendingSwapFile = '';
  const pendingVia = pendingRecord && String(pendingRecord.switchModel || configuredVia).trim();
  if (pendingRecord && compactModelContainsFamily(lastTurn.model, pendingVia)) {
    swap = {
      switchCommand: null,
      restoreCommand: pendingRecord.restoreCommand,
      originalModel: pendingRecord.originalModel,
      settingsModelBefore: pendingRecord.settingsModelBefore,
      settingsModelPresent: pendingRecord.settingsModelPresent,
    };
    pendingSwapFile = pendingRecord.file;
    via = pendingVia;
    process.stderr.write(`keep serve: ${sid} is still on ${via} from an interrupted compaction; restoring "${swap.restoreCommand}" afterwards\n`);
  } else if (!settingsSnapshot.ok) {
    process.stderr.write(`keep serve: skipping model swap for ${sid}: cannot read settings.json (${settingsSnapshot.error})\n`);
  } else {
    let settingsModel = settingsSnapshot.present ? settingsSnapshot.value : '';
    let settingsPresent = settingsSnapshot.present;
    const records = pendingCompactSwaps(dir).filter((record) => !record.error)
      .sort((a, b) => compactSwapRecordAt(b) - compactSwapRecordAt(a));
    if (compactModelBase(settingsModel) === compactModelBase(configuredVia) && records.length) {
      settingsModel = records[0].settingsModelBefore;
      settingsPresent = records[0].settingsModelPresent;
      process.stderr.write(`keep serve: using the pre-swap settings.json model from pending restore record ${String(records[0].sessionId || 'unknown').slice(0, 8)}\n`);
    }
    swap = compactSwapPlan({ ...session, model: lastTurn.model }, {
      via: configuredVia,
      families: compactModelFamilies(),
      settingsModel,
      settingsPresent,
    });
    via = swap ? configuredVia : null;
  }
  let result;
  let compactDiagnostic;
  inFlightSwap = swap ? { ...swap, switchModel: via } : null;
  try {
    const file = (deps.transcriptFileForSession || transcriptFileForSession)(session);
    if (!file) throw new Error('session transcript is unavailable');

    if (swap && swap.switchCommand) {
      pendingSwapFile = writePendingCompactSwap(session, swap, dir);
      try {
        await (deps.typeAndSubmit || typeAndSubmit)(target, swap.switchCommand, claudeTypedTextVisible, deps);
      } catch (e) {
        result = { compacted: false, reason: String(e && e.message || e), via };
      }
      if (!result) {
        if (await (deps.waitForModelSwitch || waitForModelSwitch)(target, swap.switchCommand, sid, deps)) {
          process.stderr.write(`keep serve: switched ${sid} to ${via} for compaction; restore is "${swap.restoreCommand}"\n`);
        } else {
          result = { compacted: false, reason: 'model switch unconfirmed', via };
        }
      }
    }

    if (!result) {
      const started = Date.now();
      const initialStat = fs.statSync(file);
      let offset = initialStat.size;
      compactDiagnostic = require('./compact-trace').compactTrace(session);
      compactDiagnostic.start(initialStat, offset);
      const confirmation = session.kind === 'codex' ? codexTypedTextVisible : claudeTypedTextVisible;
      await (deps.typeAndSubmit || typeAndSubmit)(target, compactCommand(instruction), confirmation, deps);
      compactDiagnostic.submitted();

      const timeoutMs = envNumber('KEEP_COMPACT_TIMEOUT_MS', 240000);
      let appended = '';
      while (Date.now() - started < timeoutMs) {
        const remaining = timeoutMs - (Date.now() - started);
        await new Promise((resolve) => setTimeout(resolve, Math.min(2000, Math.max(0, remaining))));
        // A too-short thread is refused on screen and never writes a marker; stop
        // instead of waiting out the timeout (seen live: "Not enough messages to compact.").
        let refusal = '';
        try { refusal = compactRefusal(await readScreen(target, 30, false, deps)); } catch { compactDiagnostic.screenError(); }
        if (refusal) {
          process.stderr.write(`keep serve: compaction refused for ${session.kind} session ${sid}: ${refusal}\n`);
          result = { compacted: false, reason: refusal, via };
          break;
        }
        const chunk = appendedBytes(file, offset);
        offset = chunk.offset;
        compactDiagnostic.poll(chunk.stat, offset, chunk.bytesRead);
        appended = `${appended}${chunk.text}`;
        if (hasCompactionMarker(appended, session.kind)) {
          const ms = Date.now() - started;
          process.stderr.write(`keep serve: compacted ${session.kind} session ${sid} in ${ms}ms\n`);
          result = { compacted: true, ms, via };
          break;
        }
        // Markers are single records; retaining a small suffix also covers a split read.
        if (appended.length > 256 * 1024) appended = appended.slice(-256 * 1024);
      }
      if (!result) {
        const ms = Date.now() - started;
        process.stderr.write(`keep serve: compaction timed out for ${session.kind} session ${sid} after ${ms}ms\n`);
        result = { compacted: false, reason: 'timeout', via };
      }
    }
  } catch (e) {
    const reason = String(e && e.message || e);
    process.stderr.write(`keep serve: compaction failed for ${session && session.kind || 'unknown'} session ${sid}: ${reason}\n`);
    result = { compacted: false, reason, via };
  } finally {
    compactDiagnostic?.finish(result?.compacted ? 'marker-confirmed' : result?.reason === 'timeout' ? 'timeout' : 'failed');
    if (swap && pendingSwapFile) {
      let restored = false;
      try {
        const screen = await (deps.readScreen || ((t, lines, scrollback) => readScreen(t, lines, scrollback, deps)))(target, 30, false);
        if (modelSwitchDialogVisible(screen)) {
          await pressTargetKey(target, 'Escape', deps);
          process.stderr.write(`keep serve: dismissed a stale model-switch dialog for ${sid}\n`);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch {}
      try {
        await (deps.typeAndSubmit || typeAndSubmit)(target, swap.restoreCommand, claudeTypedTextVisible, deps);
        restored = await (deps.waitForModelSwitch || waitForModelSwitch)(target, swap.restoreCommand, sid, deps);
      } catch {}
      const repaired = (deps.repairClaudeSettingsModel || repairClaudeSettingsModel)(swap.settingsModelBefore, swap.settingsModelPresent);
      if (repaired.changed) {
        process.stderr.write(`keep serve: restored settings.json model to "${swap.settingsModelBefore}" after compaction of ${sid}\n`);
      }
      if (repaired.error) {
        process.stderr.write(`keep serve: could not restore settings.json model after compaction of ${sid}: ${repaired.error}\n`);
      }
      if (restored) {
        try { fs.unlinkSync(pendingSwapFile); } catch (e) {
          process.stderr.write(`keep serve: could not clear model restore record for claude session ${sid}: ${e.message}\n`);
        }
      } else {
        process.stderr.write(`keep serve: MODEL RESTORE UNCONFIRMED for claude session ${sid}: expected "${swap.restoreCommand}" — restore it by hand\n`);
        if (!result) result = { compacted: false, reason: 'model restore unconfirmed', via };
        result.restoreUnconfirmed = true;
      }
    }
    inFlightSwap = null;
  }
  return result;
}

function answerPrecheck(screen, pending, option, label) {
  const question = normalizedText(pending.question).slice(0, 40);
  const normalizedScreen = normalizedText(screen);
  if (!question || !normalizedScreen.includes(question)) {
    throw new InjectionError(409, 'the pending question is not visible in the session', { screenTail: screenTail(screen) });
  }
  const prefix = `${option}. `;
  const expected = normalizedText(label);
  const optionMatches = String(screen || '').split(/\r?\n/).some((line) => {
    const text = normalizedText(line).replace(/^[❯›>]\s*/, '');
    return text.startsWith(prefix) && text.slice(prefix.length).startsWith(expected);
  });
  if (!optionMatches) {
    throw new InjectionError(409, 'the requested answer does not match the visible question options', {
      screenTail: screenTail(screen),
    });
  }
}

function validateTranscriptAnswer(pending, option, label) {
  if (!pending) throw new InjectionError(409, 'the session no longer has a pending question');
  if (pending.options[option - 1] !== label) {
    throw new InjectionError(409, 'the requested answer no longer matches the transcript question');
  }
}

function loadCurrentSession(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(id || ''))) throw new InjectionError(400, 'bad session id');
  const session = scanSessions().find((candidate) => candidate.id === id);
  if (!session) throw new InjectionError(404, 'no session');
  return session;
}

function readPaneRecord(sessionId, deps = {}) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(path.join(deps.root || keep.ROOT, '.keep', 'panes', `${sessionId}.json`), 'utf8'));
    if (record && typeof record === 'object' && record.pane) return record;
  } catch {}
  return null;
}

function sessionProjectFromTranscript(sessionId, deps = {}, agent = null) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return { project: '', agent: null };
  if (agent !== 'codex') {
    try {
      const file = (deps.findSessionFile || findSessionFile)(sessionId);
      if (file) {
        const stat = fs.statSync(file);
        const length = Math.min(stat.size, 64 * 1024);
        const buffer = Buffer.alloc(length);
        const fd = fs.openSync(file, 'r');
        try { fs.readSync(fd, buffer, 0, length, 0); } finally { fs.closeSync(fd); }
        for (const line of buffer.toString('utf8').split('\n')) {
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          const cwd = record && typeof record.cwd === 'string' ? record.cwd.trim() : '';
          if (cwd && (path.isAbsolute(cwd) || cwd.startsWith('~/'))) {
            return { project: cwd, agent: 'claude' };
          }
        }
      }
    } catch {}
  }
  if (agent !== 'claude') {
    try {
      const meta = (deps.codexSessionMeta || codex.sessionMetaFor)(sessionId);
      const cwd = meta && typeof meta.cwd === 'string' ? meta.cwd.trim() : '';
      if (cwd && (path.isAbsolute(cwd) || cwd.startsWith('~/'))) return { project: cwd, agent: 'codex' };
    } catch {}
  }
  return { project: '', agent: null };
}

const PS_TABLE_RE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4})\s*(.*)$/;

function parseProcessTable(output) {
  const rows = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = PS_TABLE_RE.exec(line);
    if (!match) continue;
    const args = match[5];
    const agentMatch = /(^|\/)(claude|codex)(\s|$)/.exec(args);
    const padded = ` ${args} `;
    const interactive = Boolean(agentMatch)
      && !padded.includes(' -p ')
      && !args.includes('--print')
      && !args.includes('app-server')
      && !args.includes('task-worker')
      && !args.includes('codex exec');
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      tty: match[3].replace(/^\/dev\//, ''),
      pidStart: match[4],
      args,
      agent: agentMatch && agentMatch[2],
      interactive,
    });
  }
  return rows;
}

async function agentProcessRows(deps = {}) {
  if (typeof deps.psTable === 'string') return parseProcessTable(deps.psTable);
  const result = await (deps.execFile || execFileAsync)('ps', ['-axo', 'pid=,ppid=,tty=,lstart=,args='], {
    encoding: 'utf8', timeout: 5e3, maxBuffer: 32e6, env: { ...process.env, LC_ALL: 'C' },
  });
  return parseProcessTable(String(result.stdout || ''));
}

function paneRecordEntries(deps = {}) {
  if (deps.paneRecords instanceof Map) return new Map(deps.paneRecords);
  const records = new Map();
  const dir = path.join(deps.root || keep.ROOT, '.keep', 'panes');
  let names;
  try { names = fs.readdirSync(dir); } catch { return records; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (record && typeof record === 'object') records.set(id, record);
    } catch {}
  }
  return records;
}

function setLiveSession(map, id, row, source, extra = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(id || '')) || map.has(id)) return;
  map.set(id, {
    pid: row.pid,
    pidStart: row.pidStart,
    agent: row.agent,
    source,
    primary: true,
    ...extra,
  });
}

async function liveSessionPids(deps = {}) {
  const live = new Map();
  let rows = [];
  try {
    const found = await (deps.agentProcessRows || agentProcessRows)(deps);
    if (Array.isArray(found)) rows = found;
  } catch {}
  const interactive = rows.filter((row) => row.interactive);
  const interactiveByPid = new Map(interactive.map((row) => [row.pid, row]));

  // Explicit resume argv is the strongest process-to-session identity.
  for (const row of interactive) {
    // A pane switch needs current open-file evidence; launch argv survives /new.
    if (deps.codexRolloutOnly && row.agent === 'codex') continue;
    const match = row.agent === 'claude'
      ? /(?:^|\s)--(?:resume|session-id)\s+([A-Za-z0-9_-]+)(?=\s|$)/.exec(row.args)
      : /(?:^|\s)(?:\S*\/)?codex\s+(?:--?[A-Za-z0-9-]+(?:=\S*)?\s+)*resume\s+([A-Za-z0-9_-]+)(?=\s|$)/.exec(row.args);
    if (match) setLiveSession(live, match[1], row, 'argv');
  }

  // Claude exports its session id to hook children, even for a fresh TUI whose
  // own argv has no --resume token.
  const claudeRows = interactive.filter((row) => row.agent === 'claude');
  const parentByChild = new Map();
  for (const child of rows) {
    const parent = claudeRows.find((row) => row.pid === child.ppid);
    if (parent) parentByChild.set(child.pid, parent);
  }
  if (parentByChild.size) {
    try {
      const pids = [...parentByChild.keys()];
      let output;
      if (typeof deps.psEnv === 'function') output = await deps.psEnv(pids);
      else {
        const result = await (deps.execFile || execFileAsync)('ps', ['-E', '-o', 'pid=,args=', '-p', pids.join(',')], {
          encoding: 'utf8', timeout: 5e3, maxBuffer: 32e6, env: { ...process.env, LC_ALL: 'C' },
        });
        output = result.stdout;
      }
      for (const line of String(output || '').split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+.*(?:^|\s)CLAUDE_CODE_SESSION_ID=([A-Za-z0-9_-]+)(?=\s|$)/.exec(line);
        const parent = match && parentByChild.get(Number(match[1]));
        if (parent) setLiveSession(live, match[2], parent, 'child-env');
      }
    } catch {}
  }

  // Codex holds rollout files open. All of them are alive, but only the newest
  // rollout for a TUI is the session that should be restored.
  const codexRows = interactive.filter((row) => row.agent === 'codex');
  if (codexRows.length) {
    try {
      const pids = codexRows.map((row) => row.pid);
      let output;
      if (typeof deps.lsof === 'function') output = await deps.lsof(pids);
      else {
        const result = await (deps.execFile || execFileAsync)('lsof', ['-p', pids.join(','), '-Fpn'], {
          encoding: 'utf8', timeout: 5e3, maxBuffer: 32e6,
        });
        output = result.stdout;
      }
      let pid = null;
      const rollouts = new Map();
      for (const line of String(output || '').split(/\r?\n/)) {
        if (/^p\d+$/.test(line)) { pid = Number(line.slice(1)); continue; }
        const match = pid && /^n(.*\/rollout-.*-([0-9a-f-]{36})\.jsonl)$/.exec(line);
        if (!match || !interactiveByPid.has(pid)) continue;
        const entries = rollouts.get(pid) || [];
        if (!entries.some((entry) => entry.id === match[2])) entries.push({ path: match[1], id: match[2] });
        rollouts.set(pid, entries);
      }
      for (const row of codexRows) {
        const entries = rollouts.get(row.pid) || [];
        for (const entry of entries) {
          try {
            entry.mtime = typeof deps.statMtime === 'function'
              ? Number(await deps.statMtime(entry.path))
              : fs.statSync(entry.path).mtimeMs;
          } catch { entry.mtime = -Infinity; }
        }
        entries.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
        entries.forEach((entry, index) => setLiveSession(live, entry.id, row, 'rollout', { primary: index === 0 }));
      }
    } catch {}
  }

  return live;
}

async function resolveSessionTarget(session, targetHint, deps = {}) {
  const panes = await listHostPanes(deps);
  if (targetHint?.expectedPane) {
    const selected = panes.find((pane) => pane.id === targetHint.expectedPane);
    if (!selected?.alive || selected.agentAlive === false || selected.meta?.sessionId !== session.id || selected.meta?.agent !== session.kind) {
      throw new InjectionError(409, 'selected pane is no longer a live instance of this session; nothing was sent');
    }
    return { pane: selected.id };
  }
  const hosted = sessionHostPane(panes, session.id);
  if (hosted && hosted.alive && hosted.agentAlive !== false) return { pane: hosted.id };
  throw new InjectionError(404, `${session.id} has no live host pane`, { notLive: true });
}

function resolveSessionId(value, deps = {}) {
  const wanted = String(value || '');
  if (!/^[A-Za-z0-9_-]+$/.test(wanted)) throw new InjectionError(400, 'bad session id');
  // A phone polls this every couple of seconds; a snapshot under 5 s old is fresh enough
  // to resolve an id and spares the event loop a full transcript scan per poll.
  const scanned = deps.scanSessions ? deps.scanSessions()
    : (Date.now() - sessionSnapshotAt < 5000 && sessionSnapshot.length ? sessionSnapshot : scanSessions());
  const exact = scanned.find((candidate) => candidate.id === wanted);
  const matches = exact ? [exact] : wanted.length >= 8
    ? scanned.filter((candidate) => candidate.id.startsWith(wanted))
    : [];
  if (matches.length > 1) {
    throw new InjectionError(400, `session prefix ${wanted} is ambiguous (${matches.map((candidate) => candidate.id.slice(0, 12)).join(', ')})`);
  }
  if (!matches.length) throw new InjectionError(400, 'bad session id');
  return matches[0];
}

function stripTerminalAnsi(value) {
  return String(value || '')
    // OSC: stop at BEL, ST, or the next ESC so two titles on one line cannot swallow the text between them
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x9d[^\x07\x9c]*(?:\x07|\x9c)?/g, '')
    // DCS / APC / PM, 7-bit and 8-bit, terminated or running to the end
    .replace(/\x1b[P_^][\s\S]*?(?:\x1b\\|$)/g, '')
    .replace(/[\x90\x9e\x9f][\s\S]*?(?:\x9c|$)/g, '')
    // CSI, 7-bit and 8-bit
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x9b[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '');
}

function sessionLinesLimit(value) {
  if (value == null || value === '') return 60;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new InjectionError(400, 'bad lines');
  return Math.min(number, 400);
}

// A shell pane has no session and no transcript, so the phone addresses it by pane id.
// Only a live pane the console itself spawned as a shell is reachable this way: an agent
// pane still goes through its session, where the injection safety checks live.
async function shellPaneTarget(paneId, deps = {}) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(paneId || ''))) throw new InjectionError(400, 'bad pane id');
  const panes = await (deps.listHostPanes || listHostPanes)(deps, true);
  const pane = (panes || []).find((entry) => entry.id === paneId);
  if (!pane) throw new InjectionError(404, 'no such pane');
  if (!pane.meta || pane.meta.agent !== 'shell') throw new InjectionError(409, 'not a shell pane');
  if (!pane.alive) throw new InjectionError(409, 'pane has exited');
  return { pane: pane.id };
}

async function writeToShellPane(body, deps = {}) {
  body = body && typeof body === 'object' ? body : {};
  const text = String(body.text ?? '');
  if (!text) throw new InjectionError(400, 'message is empty');
  if (text.length > 2000) throw new InjectionError(400, 'shell input is limited to 2000 characters');
  const target = await (deps.shellPaneTarget || shellPaneTarget)(body.pane, deps);
  await (deps.writeTarget || writeTarget)(target, `${text}\r`, deps);
  return { ok: true, pane: target.pane, sent: text.length };
}

async function screenSession(query, deps = {}) {
  const get = query && typeof query.get === 'function'
    ? (name) => query.get(name)
    : (name) => query && query[name];
  const shellPane = get('session') ? null : get('pane');
  const session = shellPane ? null : resolveSessionId(get('session'), deps);
  let target;
  try {
    target = shellPane
      ? await (deps.shellPaneTarget || shellPaneTarget)(shellPane, deps)
      : await (deps.resolveSessionTarget || resolveSessionTarget)(session, null, deps);
  } catch (error) {
    if (error instanceof InjectionError && error.status === 404 && !shellPane) throw new InjectionError(404, 'no host pane');
    throw error;
  }
  const limit = sessionLinesLimit(get('lines'));
  const screen = await (deps.readScreenResult || readScreenResult)(target, limit, false, deps);
  const rawLines = Array.isArray(screen && screen.lines)
    ? screen.lines
    : String(screen && screen.text || '').split('\n');
  const result = {
    ok: true,
    sessionId: session ? session.id : null,
    pane: target.pane,
    cols: screen && screen.cols,
    rows: screen && screen.rows,
    lines: rawLines.map(stripTerminalAnsi),
    title: String(screen && screen.title || ''),
  };
  if (screen && screen.cursor && Number.isFinite(screen.cursor.x) && Number.isFinite(screen.cursor.y)) {
    result.cursor = { x: screen.cursor.x, y: screen.cursor.y };
  }
  if (screen && typeof screen.alt === 'boolean') result.alt = screen.alt;
  return result;
}

const SESSION_KEY_BYTES = Object.freeze({
  Escape: '\x1b', Tab: '\t', Up: '\x1b[A', Down: '\x1b[B', Left: '\x1b[D', Right: '\x1b[C',
  Enter: '\r', CtrlC: '\x03', CtrlD: '\x04', CtrlL: '\x0c', CtrlU: '\x15', Backspace: '\x7f',
  Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~',
});

async function sendSessionKeys(body, deps = {}) {
  body = body && typeof body === 'object' ? body : {};
  if (!Array.isArray(body.keys) || body.keys.length > 16) throw new InjectionError(400, 'bad keys');
  const bytes = [];
  for (const key of body.keys) {
    if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(SESSION_KEY_BYTES, key)) {
      throw new InjectionError(400, `unknown key ${String(key)}`);
    }
    bytes.push(SESSION_KEY_BYTES[key]);
  }
  const shellPane = body.sessionId ? null : body.pane;
  const session = shellPane ? null : resolveSessionId(body.sessionId, deps);
  const lock = deps.withInjectionLock || withInjectionLock;
  return lock(async () => {
    let target;
    try {
      target = shellPane
        ? await (deps.shellPaneTarget || shellPaneTarget)(shellPane, deps)
        : await (deps.resolveSessionTarget || resolveSessionTarget)(session, null, deps);
    } catch (error) {
      if (error instanceof InjectionError && error.status === 404 && !shellPane) throw new InjectionError(404, 'no host pane');
      throw error;
    }
    await (deps.writeTarget || writeTarget)(target, bytes.join(''), deps);
    return { ok: true, sessionId: session ? session.id : null, pane: target.pane, sent: body.keys.length };
  });
}

async function closeExitedCodexShell(session, pane, deps = {}) {
  if (!deps.closePolicy?.manual || session?.kind !== 'codex' || session.reviewer || !pane?.alive
      || pane.meta?.sessionId !== session.id || pane.meta?.agent !== 'codex'
      || pane.cmd !== '/bin/zsh' || JSON.stringify(pane.args) !== '["-l"]') return false;
  const target = { pane: pane.id };
  const verify = async () => {
    const current = (await listHostPanes(deps, true))?.find((p) => p.id === pane.id);
    if (!current?.alive || current.pid !== pane.pid || current.meta?.sessionId !== session.id || current.meta?.agent !== 'codex') return false;
    const rows = await (deps.agentProcessRows || agentProcessRows)(deps);
    const shell = rows.find((p) => p.pid === pane.pid);
    if (!shell || !/^(?:\/bin\/zsh|-zsh)(?:\s+-l)?$/.test(shell.args) || rows.some((p) => p.ppid === pane.pid)) return false;
    const screen = await (deps.readScreenResult || readScreenResult)(target, null, false, deps);
    const lines = String(screen?.text || '').split('\n');
    const last = lines.findLastIndex((line) => line.trim());
    // This is the console's zsh prompt, not a general-purpose shell parser.
    // A draft after the prompt, a different prompt, or an unknown cursor fails closed.
    if (!/^\s*(?:\([^)]*\) )?(?:~|\/)[^>\n]* >\s*$/.test(lines[last] || '')) return false;
    if (!Number.isInteger(screen?.cursor?.x) || screen.cursor.x < lines[last].trimEnd().length
        || screen.cursor.x > lines[last].trimEnd().length + 1 || screen.cursor.y !== last) return false;
    return lines.slice(0, last).some((line) => line.trim() === `codex resume ${session.id}`);
  };
  if (!await verify()) return false;
  if (!await verify()) throw new InjectionError(409, 'Leftover shell changed during Close; nothing closed');
  // EOF closes an empty interactive shell without executing text or signalling a process.
  await writeTarget(target, '\x04', deps);
  return true;
}

// SessionEnd may demote the original pane to a shell before restart observes
// the exit. Accept only that narrow transition, never another conversation.
function restartPaneMatches(original, current, sessionId) {
  return current?.pid === original.pid && current.createdAt === original.createdAt
    && (current.meta?.sessionId === sessionId || (current.meta?.agent === 'shell' && !current.meta.sessionId));
}

async function closeRestartShell(original, session, originalAgentPid, deps) {
  if (original.cmd !== '/bin/zsh' || JSON.stringify(original.args) !== '["-l"]') return false;
  const verify = async () => {
    const current = (await hostRequest('get', { pane: original.id }, deps)).pane;
    if (!current?.alive || !restartPaneMatches(original, current, session.id)
        || (deps.queued && (current.visibleAttached ?? current.attached) !== 0)) return false;
    const rows = await (deps.agentProcessRows || agentProcessRows)(deps);
    const shell = rows.find(p => p.pid === original.pid);
    if (!shell || !/^(?:\/bin\/zsh|-zsh)(?:\s+-l)?$/.test(shell.args)
        || rows.some(p => p.pid === originalAgentPid || p.ppid === original.pid)) return false;
    const screen = await (deps.readScreenResult || readScreenResult)({ pane: original.id }, null, false, deps);
    const lines = String(screen?.text || '').split('\n');
    const last = lines.findLastIndex(line => line.trim());
    if (!/^\s*(?:\([^)]*\) )?(?:~|\/)[^>\n]* >\s*$/.test(lines[last] || '')
        || !Number.isInteger(screen?.cursor?.x) || screen.cursor.y !== last
        || screen.cursor.x < lines[last].trimEnd().length || screen.cursor.x > lines[last].trimEnd().length + 1) return false;
    const resume = session.kind === 'claude' ? `claude --resume ${session.id}` : `codex resume ${session.id}`;
    return lines.slice(0, last).some(line => line.trim() === resume);
  };
  if (!await verify()) return false;
  if (!await verify()) throw new InjectionError(409, 'Original shell changed during restart');
  await writeTarget({ pane: original.id }, '\x04', deps);
  return true;
}

async function restartSession(body, deps = {}) {
  const host = (type, params) => hostRequest(type, params, deps);
  let exitInputStarted = false;
  const transient = (reason) => body.mode === 'idle' && !exitInputStarted
    ? new (require('./session-restart').RestartDeferred)(reason) : new InjectionError(409, reason);
  return (deps.withInjectionLock || withInjectionLock)(async () => {
    if (!(await host('hello')).replaceExited) throw Error('Terminal host must be refreshed before restarting sessions');
    const pane = (await host('get', { pane: body.pane })).pane;
    const session = (await (deps.buildState || buildState)({ hostPanes: [pane] })).sessions.find((s) => s.id === body.sessionId);
    const reason = require('./session-restart').refusal(session, pane, body.mode === 'idle');
    if (pane.pid !== body.pid) throw new InjectionError(409, 'Session process changed');
    if (reason) {
      if (/^Waiting |^Pause session-local scheduled jobs/.test(reason)) throw transient(reason);
      throw new InjectionError(409, reason);
    }
    const cwd = session.project || pane.cwd;
    if (!cwd || !fs.statSync(cwd).isDirectory()) throw Error('Session directory is unavailable');
    const originalRows = await (deps.agentProcessRows || agentProcessRows)(deps);
    const originalIdentity = (await liveSessionPids({ ...deps, agentProcessRows: async () => originalRows })).get(session.id);
    if (!originalIdentity?.primary) throw Error('Original agent process identity is unverified');
    const originalArgs = originalRows.find((p) => p.pid === originalIdentity.pid)?.args || '';
    const ledger = require('./restart-ledger');
    const file = session.kind === 'codex' ? (deps.codexRolloutFile || codex.rolloutFileFor)(session.id)
      : (deps.claudeRolloutFile || findSessionFile)(session.id);
    const resolveChild = session.kind === 'codex' ? deps.codexChildRolloutFile || codex.findRolloutFile
      : (id, parentFile = file) => path.join(path.dirname(parentFile), path.basename(parentFile, '.jsonl'), 'subagents', `agent-${id}.jsonl`);
    let childProof;
    try {
      childProof = ledger.verify({ root: deps.root || keep.ROOT, agent: session.kind, sid: session.id, file,
        instance: { id: require('./background-jobs').processInstance(pane, originalIdentity.pid), processScoped: true, live: true }, resolveChild });
    } catch (error) {
      if (error instanceof ledger.Recovering) throw transient(error.message);
      throw error;
    }
    const mcpRestart = require('./mcp-restart');
    let restartHelpers;
    const checkChildren = async () => {
      const currentPane = (await host('get', { pane: pane.id })).pane;
      if (!currentPane.alive || currentPane.pid !== pane.pid || currentPane.meta?.sessionId !== session.id) throw Error('Session changed during restart');
      if (body.mode === 'idle' && (currentPane.visibleAttached ?? currentPane.attached) !== 0) throw transient('Waiting until the pane is no longer being viewed');
      const rows = await (deps.agentProcessRows || agentProcessRows)(deps);
      const identity = (await liveSessionPids({ ...deps, agentProcessRows: async () => rows })).get(session.id);
      if (!identity?.primary || identity.pid !== originalIdentity.pid || identity.pidStart !== originalIdentity.pidStart) throw Error('Agent process identity changed during restart');
      const parent = rows.find((p) => p.pid === identity.pid);
      const helpers = mcpRestart.inspect({ root: deps.root || keep.ROOT, agent: session.kind, sessionId: session.id, parent, rows });
      if (restartHelpers && JSON.stringify(helpers) !== JSON.stringify(restartHelpers)) throw Error('Session helper processes changed during restart');
      restartHelpers = helpers;
      try { childProof(); } catch (error) {
        if (['Job ledger source changed during restart', 'Job ledger evidence changed during restart', 'New hook activity arrived during restart'].includes(error.message)) throw transient(error.message);
        throw error;
      }
    };
    await checkChildren();
    try {
      await (deps.closeIdleSession || closeIdleSession)(body, { ...deps, restartProof: childProof, closePolicy: { manual: true, restart: true }, withInjectionLock: (fn) => fn(), beforeClose: checkChildren,
        beforeExitInput: () => { exitInputStarted = true; },
      });
    } catch (error) {
      if (!exitInputStarted && ['Session changed during cleanup; nothing closed', 'Waiting for the turn and background work to finish', 'Waiting for pending input to be resolved'].includes(error.message)) throw transient(error.message);
      throw error;
    }
    const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    let stopped;
    for (let i = 0; i < 30; i++) {
      stopped = (await host('get', { pane: body.pane })).pane;
      if (!restartPaneMatches(pane, stopped, session.id)) throw Error('Session process changed during restart');
      if (!stopped.alive) break;
      await closeRestartShell(pane, session, originalIdentity.pid, { ...deps, queued: body.mode === 'idle' });
      await sleep(200);
    }
    if (stopped.alive) throw Error('Graceful exit did not finish; session was not force-closed');
    let helpersStopped = false;
    for (let i = 0; i < 30; i++) {
      helpersStopped = mcpRestart.gone(restartHelpers || [], await (deps.agentProcessRows || agentProcessRows)(deps));
      if (helpersStopped) break;
      await sleep(200);
    }
    if (!helpersStopped) throw Error('Session helper did not exit; restart stopped without killing it');
    const live = await liveSessionPids(deps);
    if (live.has(session.id)) throw Error('An agent process still owns this conversation');
    // Preserve an explicit permission bypass only when the old process used it.
    // Do not apply the fresh-session defaults to a previously restricted agent.
    const bypass = session.kind === 'codex' ? '--dangerously-bypass-approvals-and-sandbox' : '--dangerously-skip-permissions';
    const flags = originalArgs.split(/\s+/).includes(bypass) ? [bypass] : [];
    const argv = [session.kind, ...flags, session.kind === 'codex' ? 'resume' : '--resume', session.id];
    const result = await host('replace-exited', { paneId: pane.id, expectedPid: pane.pid, sessionId: stopped.meta?.sessionId,
      cmd: '/bin/zsh', args: ['-lic', `exec ${argv.map(shellQuoteArg).join(' ')}`], cwd,
      cols: pane.cols, rows: pane.rows, meta: { ...pane.meta, agent: session.kind, sessionId: session.id, restartedAt: Date.now() } });
    await (deps.waitForHostAgent || waitForHostAgent)({ pane: pane.id }, session.kind, deps);
    return { ok: true, sessionId: session.id, pane: result.pane.id, pid: result.pane.pid };
  });
}

async function forceRestartSession(entry, save, deps = {}) {
  return (deps.withInjectionLock || withInjectionLock)(async () => {
    const host = (type, params) => hostRequest(type, params, deps);
    if (!(await host('hello')).replaceExited) throw Error('Terminal host must be refreshed before restarting sessions');
    const initial = (await host('get', { pane: entry.pane })).pane;
    const cwd = entry.original?.cwd || initial?.cwd;
    if (!cwd || !fs.statSync(cwd).isDirectory()) throw Error('Session directory is unavailable');
    const rows = deps.forceRows || (async () => {
      const result = await execFileAsync('ps', ['-axo', 'pid=,ppid=,tty=,lstart=,stat=,args='], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 32e6, env: { ...process.env, LC_ALL: 'C' },
      });
      return String(result.stdout).split('\n').flatMap(line => {
        const m = PS_TABLE_RE.exec(line);
        if (!m) return [];
        const state = /^(\S+)\s+(.*)$/.exec(m[5]);
        if (!state) return [];
        return parseProcessTable(`${m[1]} ${m[2]} ${m[3]} ${m[4]} ${state[2]}`).map(p => ({ ...p, zombie: state[1].includes('Z') }));
      });
    });
    return require('./force-restart').run(entry, {
      save, rows, sleep: deps.sleep,
      identifyOriginal: async (sid, snapshot) => (await liveSessionPids({ ...deps, agentProcessRows: async () => snapshot })).get(sid),
      verifyStarted: original => (deps.waitForHostAgent || waitForHostAgent)({ pane: entry.pane }, original.agent, deps),
      getPane: async pane => (await host('get', { pane })).pane,
      close: body => require('./manual-close').manualClose(body, {
        sleep: deps.sleep,
        getPane: async id => {
          const pane = (await host('get', { pane: id })).pane;
          // SessionEnd can clear the conversation link before the owning login
          // shell exits. Normalize only this exact captured pane instance.
          return pane?.id === entry.pane && pane.pid === entry.pid && pane.createdAt === entry.original.createdAt
            && pane.meta?.agent === 'shell' && !pane.meta.sessionId
            ? { ...pane, meta: { ...pane.meta, agent: entry.original.agent, sessionId: entry.sessionId } } : pane;
        },
        graceful: request => (deps.closeIdleSession || closeIdleSession)(request, { ...deps, closePolicy: { manual: true }, withInjectionLock: fn => fn() }),
        signal: (pane, signal) => host('kill', { pane, signal }),
      }),
      signal: async (pid, signal) => { try { process.kill(pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } },
      sessionLive: async sid => (await liveSessionPids({ ...deps, agentProcessRows: rows })).has(sid),
      replace: async (original, job, expectedPid) => {
        const bypass = original.agent === 'codex' ? '--dangerously-bypass-approvals-and-sandbox' : '--dangerously-skip-permissions';
        const argv = [original.agent, ...(original.bypass ? [bypass] : []), original.agent === 'codex' ? 'resume' : '--resume', job.sessionId];
        const stopped = (await host('get', { pane: job.pane })).pane;
        if (stopped.alive || stopped.pid !== expectedPid || (stopped.meta?.sessionId !== job.sessionId
          && !(stopped.meta?.agent === 'shell' && !stopped.meta.sessionId
            && ((expectedPid === job.pid && stopped.createdAt === original.createdAt) || stopped.meta.forceRestartToken === job.token)))) {
          throw Error('Exited pane changed before resume');
        }
        const result = await host('replace-exited', { paneId: job.pane, expectedPid, sessionId: stopped.meta?.sessionId,
          cmd: '/bin/zsh', args: ['-lic', `exec ${argv.map(shellQuoteArg).join(' ')}`], cwd: original.cwd,
          cols: original.cols, rows: original.rows, meta: { ...original.meta, forceRestartToken: job.token, restartedAt: Date.now() } });
        return { ok: true, pane: result.pane.id, pid: result.pane.pid, sessionId: job.sessionId };
      },
    });
  });
}

async function closeIdleSession(body, deps = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(body.sessionId || '')) || !/^[A-Za-z0-9_-]+$/.test(String(body.pane || ''))) throw new InjectionError(400, 'Expected an exact session and pane');
  return (deps.withInjectionLock || withInjectionLock)(async () => {
    const panes = await listHostPanes(deps, true);
    if (!panes) throw new InjectionError(409, 'Live pane state could not be verified');
    const state = await addHostSessionState(await (deps.buildState || buildState)({ hostPanes: panes }), { ...deps, panes });
    const session = state.sessions.find((s) => s.id === body.sessionId);
    const pane = state.panes.find((p) => p.id === body.pane);
    if (await closeExitedCodexShell(session, pane, deps)) return { ok: true, closing: true, sessionId: session.id, pane: pane.id };
    const layouts = await keepConsole.readLayouts(path.join(deps.root || keep.ROOT, '.keep', 'layouts.json'));
    const pinned = new Set((layouts.layouts || []).flatMap((layout) => layout.ids || []));
    const checkDonePolicy = async (current, currentPane = pane, policyPane = currentPane) => {
      if (!deps.closePolicy?.done) return null;
      const companion = await (deps.discoverCodexJobs || stalled.discoverCodexJobs)({
        root: deps.root || keep.ROOT,
        fallbackCacheMs: 0,
      }, deps);
      const allTasks = (deps.loadAll || keep.loadAll)(true);
      const questions = (deps.loadQuestions || review.loadQuestions)();
      const legacy = deps.closePolicy.legacyDoneAt || {};
      const plan = require('./session-cleanup').doneClosePlan(
        current.sessions.find((candidate) => candidate.id === session.id),
        policyPane,
        { ...current, allTasks, questions, pinned, companion },
        (deps.now || Date.now)(),
        {
          idleMs: deps.closePolicy.idleMs,
          legacyDoneAt: (task) => legacy[task.id],
        },
      );
      if (plan.reason) throw new InjectionError(409, plan.reason);
      return plan;
    };
    await checkDonePolicy(state);
    const reason = require('./session-cleanup').refusal(session, pane, pinned, Date.now(), deps.closePolicy);
    if (reason) throw new InjectionError(409, reason);
    const checkTaskSafety = (current) => {
      const owner = current.sessions.find((s) => s.id === session.id);
      const task = current.tasks.find((t) => t.id === owner?.taskId);
      const fm = task?.fm || task || {};
      if ((!deps.closePolicy?.manual && fm.check_after) || fm.needs?.length || (!deps.closePolicy?.restart && fm.depends_on?.length)) throw new InjectionError(409, 'Task has a scheduled check, need, or dependency; leave the session open');
      // Explicit Close retires the process, not its durable scheduled recipes.
      // The scheduler falls back to a headless run when the owner is closed.
      if (!deps.closePolicy?.manual && current.tasks.some((t) => { const f = t.fm || t; return f.check_after && (f.scheduled_by === session.id || f.sessions?.some((s) => s.id === session.id)); })) throw new InjectionError(409, 'Session owns a scheduled check on another card');
      if (require('./delivery').pendingForSession(path.join(deps.root || keep.ROOT, '.keep', 'delivery'), session.id)) throw new InjectionError(409, 'Session has an unconfirmed delivery');
    };
    checkTaskSafety(state);
    const target = await resolveSessionTarget(session, { expectedPane: pane.id }, deps);
    await precheckSessionTarget(session, target, deps); // Preserve unsent drafts and modal prompts.
    const fresh = session.kind === 'claude' ? (deps.claudeSessionFor || claudeSessionFor)(session.id) : (deps.codexSessionFor || codex.sessionFor)(session.id);
    if (!fresh || typeof fresh.endedTurn !== 'boolean' || !Number.isFinite(fresh.mtime)) throw new InjectionError(409, 'Session activity could not be verified');
    if (fresh.mtime !== session.mtime || fresh.endedTurn !== true || fresh.pendingBackground || fresh.toolRunning) throw new InjectionError(409, 'Session changed during cleanup; nothing closed');
    let verifyCodexChildren = null;
    let automaticProcessIdentity = null;
    let automaticProcessRows = null;
    if (deps.closePolicy?.done) {
      automaticProcessRows = await agentProcessRows(deps);
      automaticProcessIdentity = (await liveSessionPids({ ...deps, agentProcessRows: async () => automaticProcessRows })).get(session.id);
      if (!automaticProcessIdentity?.primary) throw new InjectionError(409, 'Session process identity could not be verified; nothing closed');
      if (automaticProcessRows.some((process) => process.ppid === automaticProcessIdentity.pid)) {
        throw new InjectionError(409, 'Session has child processes; leave it open');
      }
    }
    if (session.kind === 'claude' && !(deps.closePolicy?.restart && deps.restartProof)) {
      const file = findSessionFile(session.id);
      if (!file || fs.statSync(file).size > 64 * 1024 * 1024) throw new InjectionError(409, 'Session history is too large to safely verify background completion');
      const lifecycle = scanTranscript(file, { full: true });
      if (lifecycle.hasBackgroundCommands || sessionBackgroundPending(lifecycle)) throw new InjectionError(409, 'Background command completion is unverified; leave the session open');
    } else if (session.kind === 'codex') {
      // The transcript's ended turn does not prove that yielded Codex commands
      // ended. Automatic retirement requires no children; explicit Close may
      // override that conservative check (Codex also keeps idle runtime helpers).
      const processes = automaticProcessRows || await agentProcessRows(deps);
      const live = await liveSessionPids({ ...deps, agentProcessRows: async () => processes });
      const identity = live.get(session.id);
      if (!identity || !identity.primary) throw new InjectionError(409, 'Codex process identity could not be verified; nothing closed');
      if (!deps.closePolicy?.manual) {
        if (processes.some((p) => p.ppid === identity.pid)) throw new InjectionError(409, 'Automatic cleanup protects Codex child processes; use Close to request an explicit graceful exit');
        const file = (deps.codexRolloutFile || codex.rolloutFileFor)(session.id);
        if (!file || fs.statSync(file).size > 64 * 1024 * 1024) throw new InjectionError(409, 'Codex background history cannot be verified safely');
        // Remote children have no local PID. Verify durable child transcripts,
        // not expiring UI hints, before retiring a parent that used them.
        const launched = fs.readFileSync(file, 'utf8').split('\n').some((line) => {
          let r; try { r = JSON.parse(line); } catch { return false; }
          if (r.type === 'event_msg' && ['SubAgentActivity', 'CollabAgentToolCall'].includes(r.payload?.item?.type)) return true;
          const p = r.type === 'response_item' && r.payload;
          if (!p || !['function_call', 'custom_tool_call'].includes(p.type)) return false;
          return /spawn_agent|spawn_agents|followup_task|send_input/.test(`${p.name || ''} ${p.arguments || ''} ${p.input || ''}`);
        });
        if (launched) {
          try { verifyCodexChildren = require('./codex-cleanup').verify(file, session.id, deps.codexChildRolloutFile || codex.findRolloutFile); }
          catch (error) { throw new InjectionError(409, error.message); }
        }
      }
    }
    let authorizedPane = null;
    let submittedPane = null;
    const unchanged = async ({ expectedInputCount = null, useAuthorizedActivity = false } = {}) => {
      let currentPane = null;
      if (deps.closePolicy?.done) {
        const rows = await agentProcessRows(deps);
        const identity = (await liveSessionPids({ ...deps, agentProcessRows: async () => rows })).get(session.id);
        if (!identity?.primary || identity.pid !== automaticProcessIdentity.pid
            || rows.some((process) => process.ppid === identity.pid)) {
          throw new InjectionError(409, 'Session process or children changed during cleanup');
        }
      } else if (session.kind === 'codex' && !deps.closePolicy?.manual) {
        const rows = await agentProcessRows(deps);
        const identity = (await liveSessionPids({ ...deps, agentProcessRows: async () => rows })).get(session.id);
        if (!identity?.primary || rows.some((p) => p.ppid === identity.pid)) throw new InjectionError(409, 'Codex child processes changed during cleanup');
      }
      const latest = session.kind === 'claude' ? (deps.claudeSessionFor || claudeSessionFor)(session.id) : (deps.codexSessionFor || codex.sessionFor)(session.id);
      if (!latest || typeof latest.endedTurn !== 'boolean' || !Number.isFinite(latest.mtime)) throw new InjectionError(409, 'Session activity could not be verified');
      if (latest.mtime !== session.mtime || latest.endedTurn !== true || latest.pendingBackground
          || latest.unknownBackgroundJobs?.length || latest.toolRunning || latest.pendingQuestion || latest.pendingPlan) {
        throw new InjectionError(409, 'Session changed during cleanup; nothing closed');
      }
      if (deps.closePolicy?.automatic) {
        currentPane = (await listHostPanes(deps, true))?.find((p) => p.id === pane.id);
        if (!currentPane?.alive || currentPane.attached !== 0 || currentPane.meta?.sessionId !== session.id) throw new InjectionError(409, 'Session acquired a viewer or changed during cleanup');
        if (expectedInputCount !== null && currentPane.inputCount !== expectedInputCount) {
          throw new InjectionError(409, 'Session received unexpected input during cleanup');
        }
        const currentLayouts = await keepConsole.readLayouts(path.join(deps.root || keep.ROOT, '.keep', 'layouts.json'));
        if ((currentLayouts.layouts || []).some((layout) => layout.ids?.includes(pane.id))) throw new InjectionError(409, 'Session was pinned during cleanup');
        const currentState = await addHostSessionState(
          await (deps.buildState || buildState)({ hostPanes: [currentPane] }),
          { ...deps, panes: [currentPane] },
        );
        await checkDonePolicy(currentState, currentPane, useAuthorizedActivity ? authorizedPane : currentPane);
        checkTaskSafety(currentState);
      } else {
        checkTaskSafety(await (deps.buildState || buildState)({ hostPanes: panes }));
      }
      if (verifyCodexChildren) {
        try { verifyCodexChildren(); } catch (error) { throw new InjectionError(409, error.message); }
      }
      if (deps.beforeClose) await deps.beforeClose();
      return currentPane;
    };
    await unchanged();
    if (deps.closePolicy?.done) {
      authorizedPane = (await listHostPanes(deps, true))?.find((candidate) => candidate.id === pane.id);
      if (!authorizedPane || !Number.isInteger(authorizedPane.inputCount)) {
        throw new InjectionError(409, 'Pane input activity could not be verified');
      }
    }
    deps.beforeExitInput?.();
    // Claude's slash menu can occupy more than 30 rows below the input.
    await typeAndSubmit(target, '/exit', (screen, text) => closeDraftVisible(screen, text, session.kind), {
      ...deps,
      confirmationLines: session.kind === 'claude' ? null : 30,
      beforeEnter: async () => {
        submittedPane = await unchanged({
          expectedInputCount: authorizedPane ? authorizedPane.inputCount + 1 : null,
          useAuthorizedActivity: Boolean(authorizedPane),
        });
      },
    });
    // No process signals, forced exit, transcript removal, or task completion.
    return {
      ok: true,
      closing: true,
      sessionId: session.id,
      pane: pane.id,
      ...(authorizedPane ? {
        expectedInputCount: authorizedPane.inputCount + 2,
        expectedOutputCount: submittedPane.outputCount,
        beforeSignal: () => unchanged({
          expectedInputCount: authorizedPane.inputCount + 2,
          useAuthorizedActivity: true,
        }),
      } : {}),
    };
  });
}

async function precheckSessionTarget(session, target, deps = {}) {
  const screen = await (deps.readScreen || ((t, lines, scrollback) => readScreen(t, lines, scrollback, deps)))(target, 30, false);
  if (session.kind === 'codex') codexSendPrecheck(screen);
  else await probeSuggestion(target, screen, deps);
}

function sessionLastTurn(session) {
  const file = transcriptFileForSession(session);
  if (!file) return { contextTokens: 0, model: '' };
  try { return lastTurnUsage(readTranscriptTail(file), session.kind); }
  catch { return { contextTokens: 0, model: '' }; }
}

function sessionContextTokens(session) {
  return sessionLastTurn(session).contextTokens;
}

function autoCompactIdleMs(session, stamps, now, opts) {
  if (!session || session.kind !== 'claude') return null; // Automated Codex compaction is not proven yet.
  // Fleet reviewers have a separate context-pressure policy that preserves patterns.
  if (session.reviewer) return null;
  if (session.exited || session.endedTurn === false) return null; // Never interrupt an assistant turn in progress.
  if (session.pendingQuestion || session.pendingPlan || session.pendingBackground) return null; // Leave active/waiting work alone.
  // `waiting` is Claude Code's idle_prompt: the turn ended and Owner has not typed, which is exactly the idle state targeted here.
  if (session.notify && ['permission', 'question'].includes(session.notify.type)) return null; // Owner must answer a real prompt first.
  const idleMs = now - Number(session.mtime);
  if (!Number.isFinite(idleMs) || idleMs < opts.ttlMs || idleMs > opts.maxIdleMs) return null; // Cold, but not abandoned.
  const stamp = stamps instanceof Map ? stamps.get(session.id) : stamps && stamps[session.id];
  if (stamp && stamp.mtime === session.mtime) return null; // One attempt per unchanged idle period, regardless of outcome.
  return idleMs;
}

function autoCompactCandidates(sessions, stamps, now, opts) {
  const candidates = [];
  for (const session of sessions || []) {
    const idleMs = autoCompactIdleMs(session, stamps, now, opts);
    if (idleMs === null) continue;
    const model = String(session.model || '').toLowerCase();
    const models = Array.isArray(opts.models) ? opts.models : [];
    if (!model || !models.some((family) => {
      const needle = String(family).toLowerCase();
      return needle && model.includes(needle);
    })) continue;
    const contextTokens = Number(session.contextTokens);
    if (!Number.isFinite(contextTokens) || contextTokens < opts.minTokens) continue; // Avoid lossy work on small contexts.
    candidates.push({ session, idleMs, contextTokens });
  }
  return candidates.sort((a, b) => b.contextTokens - a.contextTokens);
}

function autoCompactDir() {
  return path.join(keep.ROOT, '.keep', 'compact');
}

function gcAutoCompactStamps(now) {
  if (now - lastAutoCompactGc < 86400e3) return;
  lastAutoCompactGc = now;
  const dir = autoCompactDir();
  const cutoff = now - 7 * 86400e3;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.swap.json')) continue;
    try {
      const file = path.join(dir, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {}
  }
}

function readAutoCompactStamps() {
  const stamps = {};
  let names = [];
  try { names = fs.readdirSync(autoCompactDir()); } catch { return stamps; }
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.swap.json')) continue;
    try {
      const stamp = JSON.parse(fs.readFileSync(path.join(autoCompactDir(), name), 'utf8'));
      if (stamp && typeof stamp.sessionId === 'string') stamps[stamp.sessionId] = stamp;
    } catch {}
  }
  return stamps;
}

function writeAutoCompactDecision(stamp) {
  if (!/^[A-Za-z0-9_-]+$/.test(stamp.sessionId)) throw new Error('bad auto-compact session id');
  const dir = autoCompactDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp.sessionId}.json`);
  const temp = path.join(dir, `.${stamp.sessionId}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(stamp)}\n`);
    fs.appendFileSync(path.join(dir, '_log.jsonl'), `${JSON.stringify(stamp)}\n`);
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  if (stamp.result === 'compacted' && review.isReviewerSession(stamp.sessionId)) {
    const context = Math.round(Number(stamp.contextTokens || 0) / 1000);
    const seconds = Math.round(Number(stamp.ms || 0) / 1000);
    review.appendReviewEvent({
      kind: 'compact', sessionId: stamp.sessionId, title: 'compacted',
      detail: `${context}k → 0% in ${seconds}s`,
    });
  }
}

function logAutoCompactDecision(candidate, stamp) {
  const sid = String(candidate.session.id).slice(0, 8);
  const title = JSON.stringify(normalizedText(candidate.session.title).slice(0, 120));
  const idle = Math.round(candidate.idleMs / 60e3);
  const context = Math.round(candidate.contextTokens / 1000);
  const model = normalizedText(stamp.model);
  const via = normalizedText(stamp.via) || 'none';
  if (stamp.result === 'would') {
    process.stderr.write(`keep serve: auto-compact would compact ${sid} ${title} idle ${idle}m ctx ${context}k model ${model} via ${via}\n`);
    return;
  }
  const detail = stamp.reason ? `: ${normalizedText(stamp.reason).slice(0, 300)}` : '';
  process.stderr.write(`keep serve: auto-compact ${stamp.result} ${sid} ${title} idle ${idle}m ctx ${context}k model ${model} via ${via}${detail}\n`);
}

function autoCompactOutcome(compacted) {
  const reason = String(compacted && compacted.reason || '');
  if (compacted && compacted.restoreUnconfirmed) return 'restore-unconfirmed';
  if (compacted && compacted.compacted) return 'compacted';
  if (reason === 'timeout') return 'timeout';
  if (compactRefusal(reason)) return 'refused';
  return 'error';
}

function recordCompactRestoreHealth(summary) {
  if (!summary || summary.checked === 0) return;
  health.record('compact-restore', {
    ok: true,
    detail: `checked ${summary.checked}, restored ${summary.restored}, dropped ${summary.dropped}, skipped ${summary.skipped}, repaired settings ${summary.repairedSettings}`,
  });
}

async function autoCompactTick() {
  recordCompactRestoreHealth(await sweepPendingCompactSwaps());
  const mode = envString('KEEP_AUTO_COMPACT', 'off').toLowerCase();
  if (!['dry', 'on'].includes(mode)) return { ok: true, detail: 'nothing due' };
  const now = Date.now();
  const opts = {
    ttlMs: envNumber('KEEP_CACHE_TTL_MIN', 60) * 60e3,
    maxIdleMs: envNumber('KEEP_AUTO_COMPACT_MAX_IDLE_MIN', 1440) * 60e3,
    minTokens: envNumber('KEEP_AUTO_COMPACT_MIN_TOKENS', 100000),
    models: compactModelFamilies(),
  };
  gcAutoCompactStamps(now);
  const stamps = readAutoCompactStamps();
  const cheap = scanSessions().filter((session) => autoCompactIdleMs(session, stamps, now, opts) !== null);
  const candidates = autoCompactCandidates(
    cheap.map((session) => ({ ...session, ...sessionLastTurn(session) })),
    stamps,
    now,
    opts,
  );
  const candidate = candidates[0];
  if (!candidate) return { ok: true, detail: 'nothing due' };

  let result = 'would';
  let reason = '';
  let ms;
  let via = null;
  if (mode === 'on') {
    const started = Date.now();
    let phase = 'lock';
    try {
      const compacted = await withInjectionLock(async () => {
        phase = 'resolve';
        const session = loadCurrentSession(candidate.session.id);
        if (session.mtime !== candidate.session.mtime || autoCompactIdleMs(session, stamps, Date.now(), opts) === null) {
          phase = 'eligibility';
          throw new InjectionError(409, 'session changed or left the eligible cold idle window');
        }
        const target = await resolveSessionTarget(session, null);
        phase = 'precheck';
        await precheckSessionTarget(session, target);
        phase = 'compact';
        return compactSession(session, target);
      });
      via = compacted.via || null;
      reason = String(compacted.reason || '');
      result = autoCompactOutcome(compacted);
    } catch (e) {
      reason = String(e && e.message || e);
      // Another sender held the lock: the session itself was fine, so do not spend
      // its one attempt for this idle period. The next tick retries within the window.
      if (phase === 'lock') {
        process.stderr.write(`keep serve: auto-compact skipped ${String(candidate.session.id).slice(0, 8)} this tick: ${reason}\n`);
        return { ok: true, detail: 'nothing due' };
      }
      if (phase === 'precheck' || phase === 'eligibility') result = 'busy';
      else if (phase === 'resolve') result = 'unmatched';
      else result = 'error';
    }
    ms = Date.now() - started;
  }

  const stamp = {
    sessionId: candidate.session.id,
    mtime: candidate.session.mtime,
    at: Date.now(),
    idleMs: candidate.idleMs,
    contextTokens: candidate.contextTokens,
    model: String(candidate.session.model || ''),
    via,
    mode,
    result,
  };
  if (Number.isFinite(ms)) stamp.ms = ms;
  if (reason) stamp.reason = reason.slice(0, 500);
  let decisionError = null;
  try {
    writeAutoCompactDecision(stamp);
  } catch (e) {
    decisionError = e;
    process.stderr.write(`keep serve: could not save auto-compact decision for ${String(stamp.sessionId).slice(0, 8)}: ${e.message}\n`);
  }
  logAutoCompactDecision(candidate, stamp);
  const ok = ['would', 'compacted', 'busy'].includes(result);
  return { ok: ok && !decisionError, detail: decisionError ? 'decision write failed' : result, error: decisionError || (ok ? '' : reason || result) };
}

function startAutoCompact() {
  void sweepPendingCompactSwaps().then(recordCompactRestoreHealth).catch((e) => {
    process.stderr.write(`keep serve: compact restore sweep failed: ${e.message}\n`);
  });
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await autoCompactTick();
      health.record('auto-compact', result.ok
        ? { ok: true, detail: result.detail }
        : { ok: false, error: result.error, detail: result.detail });
    }
    catch (e) {
      health.record('auto-compact', { ok: false, error: e });
      process.stderr.write(`keep serve: auto-compact tick failed: ${e.message}\n`);
    }
    finally { running = false; }
  };
  setInterval(() => { void tick(); }, 2 * 60e3).unref();
  setTimeout(() => { void tick(); }, 60e3).unref();
}

async function sendToResolvedTarget(session, target, text, opts, deps = {}) {
  const pendingDirectory = deps.deliveryDirectory || path.join(keep.ROOT, '.keep', 'delivery');
  const trace = require('./delivery-trace').recorder(pendingDirectory, session, target.pane);
  const precheck = async () => {
  await precheckSessionTarget(session, target, deps);
  if (opts && opts.compactIfCold && !session.reviewer) {
    const ttlMs = envNumber('KEEP_CACHE_TTL_MIN', 60) * 60e3;
    const minTokens = envNumber('KEEP_COMPACT_MIN_TOKENS', 80000);
    const contextTokens = sessionContextTokens(session);
    if (shouldCompactFirst({ idleMs: Date.now() - session.mtime, contextTokens }, { ttlMs, minTokens })) {
      const result = await compactSession(session, target, null, deps);
      ensureCompactionRestored(result);
      if (afterCompactAction(result) === 'defer') {
        throw new InjectionError(409, 'compaction still in progress; deliver later');
      }
      await precheckSessionTarget(session, target, deps);
    }
  }
  };
  const confirmation = session.kind === 'codex' ? codexTypedTextVisible : claudeTypedTextVisible;
  try {
    return await require('./delivery').deliver({
      session, pane: target.pane, text, file: transcriptFileForSession(session), directory: pendingDirectory, trace,
      retainReceipt: opts?.retainReceipt === true,
      key: opts?.deliveryKey,
      precheck,
      type: () => typeAndSubmit(target, text, confirmation, { ...deps, deliveryTrace: trace }),
      submitDraft: () => pressTargetKey(target, 'Enter', deps),
      draftMatches: async () => {
        const current = session.kind === 'claude' ? claudeSessionFor(session.id) : codex.sessionFor(session.id);
        trace('draft-session-state', { idle: current?.endedTurn === true, question: Boolean(current?.pendingQuestion), plan: Boolean(current?.pendingPlan) });
        if (!current || current.endedTurn !== true || current.pendingQuestion || current.pendingPlan) return false;
        const screen = await readScreenResult(target, 200, false, deps);
        const lines = String(screen.text || '').split(/\r?\n/);
        const prompt = session.kind === 'codex' ? /^\s*›(?:\s|$)/ : /^\s*❯(?:\s|$)/;
        let start = -1;
        lines.forEach((line, i) => { if (prompt.test(line)) start = i; });
        let end = start;
        while (end + 1 < lines.length && lines[end + 1].trim() && !/^\s*[─━]/.test(lines[end + 1])) end++;
        const cursorInPrompt = Number.isFinite(screen.cursor?.y) && screen.cursor.y >= start && screen.cursor.y <= end;
        const matched = exactDraft(screen.text, text, session.kind);
        trace('draft-screen-check', { cursorInPrompt, matched });
        return cursorInPrompt && matched;
      },
    });
  } catch (error) {
    if (error instanceof InjectionError) throw error;
    throw new InjectionError(409, error.message);
  }
}

async function sendToSession(body, targetHint, opts, deps = {}) {
  body = body && typeof body === 'object' ? body : {};
  const text = body.pane ? String(body.text || '') : normalizedText(body.text).slice(0, 2000);
  if (!text.trim()) throw new InjectionError(400, 'message is empty');
  if (body.pane && text.length > 2000) throw new InjectionError(400, 'agent messages are limited to 2000 characters');

  // Bootstrap: a reviewer that has never taken a turn has no transcript, but its
  // chosen session id is already bound to the host pane at launch.
  if (targetHint && targetHint.bootstrap && !findSessionFile(body.sessionId)) {
    const hosted = sessionHostPane(await listHostPanes(deps), body.sessionId);
    if (!hosted || !hosted.alive) throw new InjectionError(409, 'reviewer has no transcript yet and no live host pane');
    const bootTarget = { pane: hosted.id };
    const bootBefore = await readScreen(bootTarget, 30, false, deps);
    await probeSuggestion(bootTarget, bootBefore, deps);
    return typeAndSubmit(bootTarget, text, claudeTypedTextVisible, deps);
  }

  const session = (deps.loadCurrentSession || loadCurrentSession)(body.sessionId);
  const target = await resolveSessionTarget(session, body.pane ? { expectedPane: body.pane } : targetHint, deps);
  return (deps.sendToResolvedTarget || sendToResolvedTarget)(session, target, text, opts, deps);
}

// Resume a session that stalled on a usage limit. The scheduler decided this a
// tick ago, from a snapshot of the transcript, and outside the injection lock —
// in between, Owner can have typed, the session can have started a tool, or a
// permission prompt can have appeared. So every precondition is checked again
// here, inside the lock, against a freshly scanned session and the live screen:
// "continue" typed into a session that moved on is an answer to whatever is
// actually on screen. `hitAt` pins the decision to the exact limit event.
async function resumeAfterLimit(sessionId, text, { hitAt } = {}, deps = {}) {
  const load = deps.loadCurrentSession || loadCurrentSession;
  const resolve = deps.resolveSessionTarget || resolveSessionTarget;
  const screenOf = deps.readScreen || ((t, lines, scrollback) => readScreen(t, lines, scrollback, deps));
  const deliver = deps.sendToResolvedTarget || sendToResolvedTarget;
  const lock = deps.withInjectionLock || withInjectionLock;
  return lock(async () => {
    const session = load(sessionId);
    // 'session moved on' is the one refusal that is not a failure: nothing went
    // wrong, the stall simply ended, so the caller drops the entry instead of
    // spending an attempt on it.
    const movedOn = (why) => new InjectionError(409, `session moved on before resume (${why})`);
    if (session.kind !== 'claude') throw movedOn('not a Claude session');
    if (!session.rateLimit || session.rateLimit.at !== hitAt) throw movedOn('no longer parked on that limit');
    if (session.endedTurn !== true) throw movedOn('mid-turn');
    if (session.toolRunning) throw movedOn('a tool is running');
    if (session.pendingQuestion || session.pendingPlan) throw movedOn('waiting on a person');
    if (session.notify && ['permission', 'question'].includes(session.notify.type)) {
      throw movedOn(`showing a ${session.notify.type}`);
    }
    const target = await resolve(session, null);
    // The transcript can say "parked" while the pane says otherwise (a restarted
    // Claude, a shell prompt, a dialog). Only type when the input box is on screen.
    const screen = await screenOf(target, 30, false);
    if (!agentPromptVisible('claude', screen)) {
      throw new InjectionError(409, 'no Claude prompt visible', { screenTail: screenTail(screen) });
    }
    return deliver(session, target, text);
  });
}

async function compactSessionById(body) {
  body = body && typeof body === 'object' ? body : {};
  const session = loadCurrentSession(body.sessionId);
  const target = await resolveSessionTarget(session, null);
  await precheckSessionTarget(session, target);
  return compactSession(session, target, body.instruction || (session.reviewer ? review.DEFAULT_REVIEW_COMPACT_INSTRUCTION : undefined));
}

async function answerSessionQuestion(body, session, deps = {}) {
  body = body && typeof body === 'object' ? body : {};
  const option = Number(body.option);
  const label = String(body.label || '');
  if (!Number.isInteger(option) || option < 1 || option > 9) throw new InjectionError(400, 'bad answer option');
  if (!label) throw new InjectionError(400, 'answer label is empty');

  const { file, info } = loadInjectionSession(body.sessionId);
  validateTranscriptAnswer(info.pendingQuestion, option, label);

  const target = await (deps.resolveSessionTarget || resolveSessionTarget)(session, null, deps);
  let current;
  try {
    current = scanTranscript(file);
  } catch (e) {
    throw new Error(`cannot refresh session transcript: ${e.message}`);
  }
  validateTranscriptAnswer(current.pendingQuestion, option, label);
  const before = await (deps.readScreen || ((t, lines, scrollback) => readScreen(t, lines, scrollback, deps)))(target, 30, false);
  answerPrecheck(before, current.pendingQuestion, option, label);
  await writeTarget(target, String(option), deps);

  let resolved = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      if (!scanTranscript(file).pendingQuestion) { resolved = true; break; }
    } catch {}
  }
  return { ok: true, resolved };
}

function liveCodexPermissionMarker(session) {
  const markerFile = path.join(keep.ROOT, '.keep', 'attention', `${session.id}.json`);
  let marker;
  let rolloutMtime;
  try {
    marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    const rolloutFile = codex.rolloutFileFor(session.id);
    if (!rolloutFile) throw new Error('missing rollout');
    rolloutMtime = fs.statSync(rolloutFile).mtimeMs;
  } catch {
    throw new InjectionError(409, 'this Codex session no longer has a live permission request');
  }
  const at = Number(marker.at);
  const ref = Number.isFinite(Number(marker.mt)) ? Number(marker.mt) + 1500 : at + 5000;
  if (marker.source !== 'codex' || marker.type !== 'permission' || !Number.isFinite(at) ||
      Date.now() - at > 24 * 3600e3 || rolloutMtime > ref) {
    throw new InjectionError(409, 'this Codex session no longer has a live permission request');
  }
  return { marker, markerFile };
}

function codexApprovalPrecheck(screen, marker) {
  const normalizedScreen = normalizedText(screen);
  if (!normalizedScreen.includes('Would you like to run') ||
      !normalizedScreen.includes('Press enter to confirm')) {
    throw new InjectionError(409, 'the Codex approval dialog is not visible in the session', {
      screenTail: screenTail(screen),
    });
  }
  const message = normalizedText(marker && marker.message);
  const fragment = message.slice(0, 120);
  if (fragment.length < 8 || !normalizedScreen.includes(fragment)) {
    throw new InjectionError(409, 'the visible Codex approval does not match the live permission request', {
      screenTail: screenTail(screen),
    });
  }
}

function codexApprovalDialogVisible(screen) {
  const normalized = normalizedText(screen);
  return normalized.includes('Would you like to run') || normalized.includes('Press enter to confirm');
}

async function answerCodexApproval(body, session, deps = {}) {
  // y/p must go through `send` (typed text) — a `send-key` key event does not
  // register on the dialog (verified live); escape must be a key event.
  const keys = { yes: ['send', 'y'], always: ['send', 'p'], no: ['send-key', 'escape'] };
  const approval = String(body.approval || '');
  if (!Object.prototype.hasOwnProperty.call(keys, approval)) {
    throw new InjectionError(400, 'bad Codex approval answer');
  }

  liveCodexPermissionMarker(session);
  const target = await (deps.resolveSessionTarget || resolveSessionTarget)(session, null, deps);
  const screenOf = deps.readScreen || ((t, lines, scrollback) => readScreen(t, lines, scrollback, deps));
  const before = await screenOf(target, 30, false);
  // Resolution can take several seconds. Revalidate marker liveness immediately
  // before the screen checks and the single keystroke.
  const { marker, markerFile } = liveCodexPermissionMarker(session);
  codexApprovalPrecheck(before, marker);
  const [verb, key] = keys[approval];
  if (verb === 'send') await writeTarget(target, key, deps);
  else await pressTargetKey(target, key, deps);

  let latest = before;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try { latest = await screenOf(target, 30, false); } catch { continue; }
    if (!codexApprovalDialogVisible(latest)) {
      try { fs.unlinkSync(markerFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return { ok: true, resolved: true };
    }
  }
  throw new InjectionError(409, 'the approval key was sent, but the dialog did not resolve within 6 seconds; the keystroke may still have landed', {
    screenTail: screenTail(latest),
  });
}

async function answerSession(body, deps = {}) {
  body = body && typeof body === 'object' ? body : {};
  const session = loadCurrentSession(body.sessionId);
  return session.kind === 'codex'
    ? answerCodexApproval(body, session, deps)
    : answerSessionQuestion(body, session, deps);
}

const AGENT_PROMPT_TIMEOUT_MS = 45e3;

// A bare `❯` alone is not enough: the shell prompt in these panes can be `❯` too,
// and a stale one stays on screen while Claude loads (or after it exits). Claude's
// input box draws a horizontal rule directly above its prompt line; a shell never does.
function agentPromptVisible(agent, screen) {
  const lines = String(screen || '').split(/\r?\n/).map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''));
  if (agent === 'codex') return lines.some((line) => line.includes('› Ask Codex to do anything'));
  const bottom = lines.slice(-12);
  for (let index = bottom.length - 1; index > 0; index -= 1) {
    if (!/^\s*❯\s*$/.test(bottom[index])) continue;
    // A named session draws its name into the rule: "──── fable-fleet-reviewer ─".
    if (/^\s*─{10,}\s*$/.test(bottom[index - 1])
        || /^\s*─{20,}\s\S[^─]{0,80}\s─\s*$/.test(bottom[index - 1])) return true;
  }
  return false;
}

// Under the injection lock: the prompt seen a moment ago must still be there
// (the agent may have exited back to a shell), then type like a live delivery.
async function typeOpeningMessage(target, agent, text, deps = {}) {
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let screen = '';
  try { screen = await readScreen(target, 30, false, deps); } catch { screen = ''; }
  if (!agentPromptVisible(agent, screen)) {
    throw new InjectionError(409, `${agent} prompt disappeared from ${target.pane} before the message could be typed`, { screenTail: screenTail(screen) });
  }
  const confirmation = agent === 'codex' ? codexTypedTextVisible : claudeTypedTextVisible;
  await typeAndSubmit(target, text, confirmation, { ...deps, sleep });
}

async function waitForHostAgent(target, agent, deps = {}) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + AGENT_PROMPT_TIMEOUT_MS;
  let screen = '';
  while (now() < deadline) {
    try { screen = await readScreen(target, 30, false, deps); } catch { screen = ''; }
    if (agentPromptVisible(agent, screen)) return true;
    await sleep(Math.min(500, Math.max(0, deadline - now())));
  }
  throw new InjectionError(504, `${agent} session in ${target.pane} never showed an empty prompt; message not sent`, {
    screenTail: screenTail(screen),
  });
}

async function waitForHostSessionId(pane, deps = {}) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + 15000;
  while (now() < deadline) {
    try {
      const result = await hostRequest('get', { pane }, deps);
      const sessionId = result && result.pane && result.pane.meta && result.pane.meta.sessionId;
      if (typeof sessionId === 'string' && /^[A-Za-z0-9_-]+$/.test(sessionId)) return sessionId;
    } catch {}
    await sleep(Math.min(250, Math.max(0, deadline - now())));
  }
  return null;
}

// The lock may be held by a delivery that started during the wait; give it a
// moment rather than failing the launch after the agent is already up.
async function withInjectionLockRetry(fn, deps = {}) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + 10000;
  for (;;) {
    try { return await withInjectionLock(fn); }
    catch (e) {
      if (!(e instanceof InjectionError) || e.status !== 429 || now() >= deadline) throw e;
      await sleep(250);
    }
  }
}

function isInjectionBusy() { return injectionBusy; }

function shellQuoteArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function openSession(body, deps = {}) {
  body = body && typeof body === 'object' ? body : {};
  if (body.agent != null && !['claude', 'codex'].includes(body.agent)) throw new InjectionError(400, 'agent must be claude or codex');
  if (body.command != null) throw new InjectionError(400, 'command is not accepted');
  if (body.message != null && String(body.message).length > keep.OPEN_MESSAGE_LIMIT) {
    throw new InjectionError(400, keep.OPEN_MESSAGE_ERROR);
  }
  const message = body.message == null ? '' : normalizedText(body.message);
  if (body.message != null && !message) throw new InjectionError(400, 'message is empty');
  if (body.requester != null && (typeof body.requester !== 'string' || !/^[A-Za-z0-9_-]+$/.test(body.requester))) {
    throw new InjectionError(400, 'bad requester session id');
  }

  let project;
  let session;
  if (body.taskId) {
    let task;
    try { task = (deps.loadTask || keep.loadTask)(body.taskId); } catch {}
    if (!task) throw new InjectionError(400, 'no task');
    project = task.fm.project;
    if (!body.fresh) session = (task.fm.sessions || []).slice(-1)[0];
  } else if (body.sessionId) {
    // Accept a unique prefix of at least 8 characters, the way ids are shown everywhere.
    try { session = resolveSessionId(body.sessionId, deps); } catch (error) {
      if (!(error instanceof InjectionError) || error.status !== 400 || error.message !== 'bad session id') throw error;
    }
    if (session) body.sessionId = session.id;
    project = session && session.project;
    if (!project) {
      const task = (deps.loadAll || keep.loadAll)(true)
        .find((candidate) => (candidate.fm.sessions || []).some((entry) => entry.id === body.sessionId));
      if (task) {
        project = task.fm.project;
        session = session || task.fm.sessions.find((entry) => entry.id === body.sessionId);
      }
    }
    if (!project) {
      const record = (deps.readPaneRecord || readPaneRecord)(body.sessionId, deps);
      if (record) {
        project = record.cwd;
        session = session || { id: body.sessionId, agent: record.agent };
      }
    }
    if (!project) {
      const transcript = sessionProjectFromTranscript(body.sessionId, deps);
      project = transcript.project;
      if (project && !session) session = { id: body.sessionId, agent: transcript.agent };
    }
  }

  if (typeof project !== 'string' || !project) throw new InjectionError(400, `no project for ${body.taskId ? `task ${body.taskId}` : `session ${body.sessionId || '?'}`}`);
  project = path.resolve(project.replace(/^~(?=\/|$)/, os.homedir()));
  try { if (!fs.statSync(project).isDirectory()) throw new Error(); }
  catch { throw new InjectionError(400, 'project directory does not exist'); }
  if (body.fresh) session = null;

  const agent = (session && (session.kind || session.agent)) || body.agent || 'claude';
  if (!['claude', 'codex'].includes(agent)) throw new InjectionError(400, 'agent must be claude or codex');
  if (session && (typeof session.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(session.id))) {
    throw new InjectionError(400, 'bad session id');
  }

  // Launched Claude sessions match Owner's permission-mode class so peer
  // messages are delivered instead of being held for mode parity.
  const claudeFlags = deps.claudeFlags != null ? deps.claudeFlags
    : (process.env.KEEP_OPEN_CLAUDE_FLAGS != null ? process.env.KEEP_OPEN_CLAUDE_FLAGS : '--dangerously-skip-permissions');
  const claudeFlagArgs = String(claudeFlags || '').trim().split(/\s+/).filter(Boolean);
  // Launched Codex sessions run in yolo mode, the same class as Owner's own
  // `codexd` alias, so they never stall on an approval prompt nobody is watching.
  const codexFlags = deps.codexFlags != null ? deps.codexFlags
    : (process.env.KEEP_OPEN_CODEX_FLAGS != null ? process.env.KEEP_OPEN_CODEX_FLAGS : '--dangerously-bypass-approvals-and-sandbox');
  const codexFlagArgs = String(codexFlags || '').trim().split(/\s+/).filter(Boolean);
  const launchedAt = (deps.now || Date.now)();

  const launchHost = async () => {
    const sessionId = session ? session.id : agent === 'claude' ? (deps.randomUUID || crypto.randomUUID)() : null;
    const argv = agent === 'codex'
      ? ['codex', ...codexFlagArgs, ...(sessionId ? ['resume', sessionId] : [])]
      : ['claude', ...claudeFlagArgs,
        ...(sessionId ? [session ? '--resume' : '--session-id', sessionId] : [])];
    const command = argv.join(' ');
    const spawned = await hostRequest('spawn', {
      cmd: '/bin/zsh',
      args: ['-lic', `exec ${argv.map(shellQuoteArg).join(' ')}`],
      cwd: project,
      cols: 200,
      rows: 50,
      meta: {
        agent,
        sessionId,
        project,
        card: body.taskId || null,
        requester: body.requester || null,
        launchedAt,
      },
    }, deps);
    const pane = spawned && spawned.pane && spawned.pane.id;
    if (!pane) throw new Error('terminal host did not return a pane');
    return { ok: true, created: 'pane', command, pane, sessionId };
  };

  if (session) {
    let target = null;
    try {
      target = await (deps.resolveSessionTarget || resolveSessionTarget)(
        { ...session, kind: agent, project }, null, deps,
      );
    } catch (error) {
      if (!(error instanceof InjectionError) || error.status !== 404 || !error.extra.notLive) throw error;
    }
    if (!target && !body.fresh) {
      // No host pane, but the agent may still be running in a plain terminal: a second
      // process on the same transcript would corrupt it, so refuse rather than resume.
      const live = await (deps.liveSessionPids || liveSessionPids)(deps);
      const running = live.get(session.id);
      if (running) {
        throw new InjectionError(409, `session ${session.id.slice(0, 8)} is running outside the host (pid ${running.pid}); exit it there first, then keep open again`, { pid: running.pid });
      }
    }
    if (target) {
      return withInjectionLock(async () => {
        const result = {
          ok: true,
          existing: true,
          focus: 'console',
          sessionId: session.id,
          pane: target.pane,
        };
        if (message) {
          await (deps.sendToResolvedTarget || sendToResolvedTarget)(
            { ...session, kind: agent }, target, message, undefined, deps,
          );
          result.sent = true;
        }
        return result;
      });
    }
  }

  const launch = await withInjectionLock(launchHost);
  if (deps.onLaunched) await deps.onLaunched(launch);
  const handoff = Boolean(body.taskId) && !session;
  let releasePending = handoff && Boolean(body.requester);
  const release = () => {
    if (!releasePending) return;
    try {
      if ((deps.releaseCardSession || keep.releaseCardSession)(body.taskId, body.requester)) {
        launch.unlinked = body.requester;
      }
      releasePending = false;
    } catch (error) {
      process.stderr.write(`keep serve: could not unlink ${body.requester.slice(0, 8)} from ${body.taskId}: ${error.message}\n`);
    }
  };

  release();
  const target = { pane: launch.pane };
  try {
    await (deps.waitForHostAgent || waitForHostAgent)(target, agent, deps);
    launch.settled = true;
    if (message) {
      if (deps.onOpeningReady && await deps.onOpeningReady(launch) === false) {
        throw new InjectionError(409, 'opening-message reservation changed before instructions were sent');
      }
      await withInjectionLockRetry(
        () => (deps.typeOpeningMessage || typeOpeningMessage)(target, agent, message, deps), deps,
      );
      launch.sent = true;
      if (deps.onOpeningDelivered && await deps.onOpeningDelivered(launch) === false) {
        throw new InjectionError(409, 'opening-message reservation changed after instructions were sent');
      }
    }
    if (!launch.sessionId && handoff) {
      launch.sessionId = await (deps.waitForHostSessionId || waitForHostSessionId)(launch.pane, deps);
      if (!launch.sessionId) {
        throw new InjectionError(504, `${agent} started in host pane ${launch.pane} but never registered its session id`);
      }
    }
  } finally {
    release();
  }

  if (handoff && launch.sessionId) {
    try {
      if ((deps.linkLaunchedSession || keep.linkLaunchedSession)(body.taskId, { id: launch.sessionId, agent })) {
        launch.linked = true;
      }
    } catch (error) {
      process.stderr.write(`keep serve: could not link ${launch.sessionId.slice(0, 8)} to ${body.taskId}: ${error.message}\n`);
      launch.linked = false;
    }
  }
  return launch;
}

async function launchReviewQueueSession(request, deps = {}) {
  const open = deps.openSession || openSession;
  return open({
    taskId: request.taskId,
    fresh: true,
    agent: 'claude',
    message: request.message,
  }, {
    ...deps,
    loadTask: deps.loadTask || keep.loadTaskAnywhere,
    randomUUID: () => request.sessionId,
    onLaunched: request.onLaunched,
    onOpeningReady: request.onReady,
    onOpeningDelivered: request.onDelivered,
    // A discussion is an advisory conversation. It must not take the parent
    // card's ownership/resume slot merely because somebody opened the item.
    linkLaunchedSession: request.action === 'discuss'
      ? () => null
      : (deps.linkLaunchedSession || keep.linkLaunchedSession),
  });
}

async function inspectReviewQueueLaunch(active, deps = {}) {
  let panes;
  try { panes = Object.prototype.hasOwnProperty.call(deps, 'panes') ? deps.panes : await listHostPanes({}, true); }
  catch (error) { return { state: 'unknown', message: `terminal host lookup failed: ${error.message}` }; }
  if (!Array.isArray(panes)) return { state: 'unknown', message: 'terminal host is unavailable; launch state cannot be reconciled safely' };
  const matches = panes.filter((pane) => pane?.meta?.sessionId === active.sessionId);
  const present = matches.find((pane) => pane.alive !== false && pane.agentAlive !== false);
  if (present) return { state: 'present', pane: present.id };
  const shell = matches.find((pane) => pane.alive !== false && pane.agentAlive === false);
  if (shell && active.pane !== shell.id) {
    return { state: 'unknown', pane: shell.id, message: 'reserved pane exists, but agent liveness needs another host observation' };
  }
  return { state: 'absent' };
}

async function recoverReviewQueueLaunch(active, hooks = {}, deps = {}) {
  if (!active?.pane || !active.pointer) throw new InjectionError(409, 'reserved conversation has no recoverable pane or opening-message pointer');
  if (typeof hooks.onReady !== 'function') throw new InjectionError(409, 'review queue recovery has no reservation readiness gate');
  const target = { pane: active.pane };
  await (deps.waitForHostAgent || waitForHostAgent)(target, 'claude', deps);
  if (await hooks.onReady() !== true) {
    throw new InjectionError(409, 'review queue launch reservation changed before opening instructions were sent');
  }
  await withInjectionLockRetry(
    () => (deps.typeOpeningMessage || typeOpeningMessage)(target, 'claude', active.pointer, deps), deps,
  );
  if (typeof hooks.onDelivered === 'function' && await hooks.onDelivered() !== true) {
    throw new InjectionError(409, 'review queue launch reservation changed after opening instructions were sent');
  }
  if (active.action === 'start' && active.card) {
    try { (deps.linkLaunchedSession || keep.linkLaunchedSession)(active.card, { id: active.sessionId, agent: 'claude' }); }
    catch (error) { process.stderr.write(`keep serve: could not link recovered review queue session ${active.sessionId.slice(0, 8)} to ${active.card}: ${error.message}\n`); }
  }
  return { sessionId: active.sessionId, pane: active.pane, sent: true };
}
const scanCache = new Map(); // file -> { mtimeMs, size, info }
const claudeSessionPathCache = new Map(); // session id -> transcript file
const backgroundTargets = new Map();
const claudeSessionParseCache = new Map(); // file -> { mtimeMs, size, info }
const SESSION_LOOKUP_CACHE_LIMIT = 300;
let sessionSnapshot = [];
let sessionSnapshotAt = 0;
let lastDashboardSessionScan = 0;
let lastStalledSessionScan = 0;

function cacheClaudeSessionLookup(cache, key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > SESSION_LOOKUP_CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function claudeSessionFromInfo(id, info, stat, dir, reviewer, now) {
  if (info.backgroundParentFile) cacheClaudeSessionLookup(claudeSessionPathCache, id, info.backgroundParentFile);
  const activityMs = transcriptActivityMs(info, stat.mtimeMs);
  const ageMs = now - activityMs;
  const lifecycle = require('./session-lifecycle');
  const lifecycleEvents = lifecycle.read(keep.ROOT, id, now);
  const lifecycleAgents = info.backgroundParentFile ? lifecycle.pendingAgents(lifecycleEvents,
    info.backgroundParentFile, (file) => scanTranscript(file, { includeSidechain: true }), now, info.completedAgents) : [];
  return {
    id,
    kind: 'claude',
    reviewer,
    project: info.cwd || dir.replace(/^-/, '/').replace(/-/g, '/'),
    title: info.title,
    gitBranch: info.gitBranch,
    lastUser: info.lastUser.slice(0, 300),
    lastHuman: info.lastHuman,
    lastUserAt: info.lastUserAt,
    turnStartedAt: info.turnStartedAt,
    lastAssistant: info.lastAssistant.slice(0, 300),
    lastAssistantFull: info.lastAssistant.slice(0, 12000),
    mtime: activityMs,
    attentionAt: info.attentionAt,
    size: stat.size,
    exited: info.exited === true,
    state: info.exited ? 'recent' : info.endedTurn ? (ageMs < 3600e3 ? 'idle' : 'recent') : 'running',
    pendingQuestion: info.pendingQuestion,
    pendingPlan: info.pendingPlan,
    endedTurn: info.endedTurn,
    localCommandPending: info.localCommandPending,
    pendingOther: info.pendingOther,
    pendingBackground: lifecycleAgents.length > 0 || sessionBackgroundPending(info),
    unknownBackgroundJobs: info.unknownBackgroundJobs || [],
    lifecycleAgents,
    lifecycleForeground: lifecycle.foreground(lifecycleEvents, info, now),
    lifecycleStop: lifecycle.stopReason(lifecycleEvents, info),
    lifecycleTurnAt: lifecycle.turnAt(lifecycleEvents),
    waitingFor: info.waitingFor,
    toolRunning: info.toolRunning,
    rateLimit: info.rateLimit || null,
    askedProse: /\?\s*$/.test(info.lastAssistant.trim()),
  };
}

function claudeSessionFor(sessionId) {
  const id = String(sessionId || '');
  let file = claudeSessionPathCache.get(id) || null;
  let stat;
  if (file) {
    try { stat = fs.statSync(file); } catch {
      claudeSessionPathCache.delete(id);
      claudeSessionParseCache.delete(file);
      file = null;
    }
    if (file && !stat.isFile()) {
      claudeSessionPathCache.delete(id);
      claudeSessionParseCache.delete(file);
      file = null;
    }
  }
  if (!file) {
    file = findSessionFile(id);
    if (!file) return null;
    try { stat = fs.statSync(file); } catch { return null; }
    if (!stat.isFile()) return null;
    cacheClaudeSessionLookup(claudeSessionPathCache, id, file);
  }
  let info;
  const cached = claudeSessionParseCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    info = cached.info;
  } else {
    info = scanTranscript(file);
    cacheClaudeSessionLookup(claudeSessionParseCache, file, { mtimeMs: stat.mtimeMs, size: stat.size, info });
  }
  const dir = path.basename(path.dirname(file));
  let reviewer = false;
  try { reviewer = fs.readdirSync(path.join(keep.ROOT, '.keep', 'reviewer')).includes(id); } catch {}
  return claudeSessionFromInfo(id, info, stat, dir, reviewer, Date.now());
}

function scanClaudeSessions(options = {}) {
  const readOnly = options.readOnly === true;
  const sessions = [];
  const now = Date.now();
  const spawnedDir = path.join(keep.ROOT, '.keep', 'spawned');
  const attentionDir = path.join(keep.ROOT, '.keep', 'attention');
  let reviewers = new Set();
  try { reviewers = new Set(fs.readdirSync(path.join(keep.ROOT, '.keep', 'reviewer'))); } catch {}
  let spawned = new Set();
  try {
    spawned = new Set(fs.readdirSync(spawnedDir));
    for (const id of spawned) {
      try {
        if (now - fs.statSync(path.join(spawnedDir, id)).mtimeMs > 7 * 86400e3) {
          if (!readOnly) fs.unlinkSync(path.join(spawnedDir, id));
          spawned.delete(id);
        }
      } catch {}
    }
  } catch {}
  const seen = new Set();
  const sessionIds = new Set();
  for (const { dir, file, id, stat } of claudeTranscriptIndex.scan({ fresh: options.dashboard !== true })) {
    sessionIds.add(id);
    if (spawned.has(id) || now - stat.mtimeMs > SESSION_WINDOW_MS) continue;
    seen.add(file);
    let info;
    const cached = scanCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      info = cached.info;
    } else {
      try { info = scanTranscript(file); } catch { continue; }
      scanCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, info });
    }
    // headless `claude -p` spawns (batch jobs from any project) have no TUI
    // records and never earn a title — they're pipeline noise, not sessions
    if (!info.title && !info.interactive) continue;
    // Claude can append untimestamped housekeeping records (ai-title, mode,
    // bridge-session) when an old session is merely reopened or inspected. Those
    // writes are not conversation activity and must not resurrect the session.
    const activityMs = transcriptActivityMs(info, stat.mtimeMs);
    const ageMs = now - activityMs;
    if (ageMs > SESSION_WINDOW_MS) continue;
    const session = claudeSessionFromInfo(id, info, stat, dir, reviewers.has(id), now);
    try {
      const markerFile = path.join(attentionDir, `${id}.json`);
      const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
      if (marker.source !== 'codex') {
        const at = Number(marker.at);
        // Liveness follows timestamped conversation activity, not raw file writes:
        // Claude appends untimestamped metadata when old sessions are reopened.
        // Prefer the mtime captured at hook time (mt); fall back to wall-clock for
        // markers written by older hooks.
        const ref = Number.isFinite(Number(marker.mt)) ? Number(marker.mt) + 1500 : at + 5000;
        if (!Number.isFinite(at) || now - at > 24 * 3600e3 || activityMs > ref) {
          if (!readOnly) try { fs.unlinkSync(markerFile); } catch {}
        } else if (['permission', 'waiting', 'complete'].includes(marker.type)) {
          session.notify = { type: marker.type, message: String(marker.message || '').slice(0, 200) };
        }
      }
    } catch {}
    sessions.push(session);
  }
  for (const key of scanCache.keys()) if (!seen.has(key)) scanCache.delete(key);
  if (!readOnly) try {
    for (const f of fs.readdirSync(attentionDir)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      const markerFile = path.join(attentionDir, f);
      try {
        const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
        const at = Number(marker.at);
        if (!Number.isFinite(at) || now - at > 24 * 3600e3) {
          fs.unlinkSync(markerFile);
        } else if (marker.source !== 'codex' && !sessionIds.has(id)) {
          fs.unlinkSync(markerFile);
        }
      } catch {}
    }
  } catch {}
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

function attachCodexMarkers(sessions, attentionDir, now, options = {}) {
  const readOnly = options.readOnly === true;
  for (const session of sessions) {
    const markerFile = path.join(attentionDir, `${session.id}.json`);
    try {
      const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
      if (marker.source !== 'codex') continue;
      const at = Number(marker.at);
      // Any rollout write after the hook means Codex has moved past the prompt.
      // Prefer the captured rollout mtime; retain the old wall-clock fallback.
      const ref = Number.isFinite(Number(marker.mt)) ? Number(marker.mt) + 1500 : at + 5000;
      if (!Number.isFinite(at) || now - at > 24 * 3600e3 || session.mtime > ref) {
        if (!readOnly) try { fs.unlinkSync(markerFile); } catch {}
      } else if (['question', 'permission', 'complete'].includes(marker.type)) {
        session.notify = {
          type: marker.type,
          message: String(marker.message || '').slice(0, 500),
          options: Array.isArray(marker.options)
            ? marker.options.filter((option) => typeof option === 'string').slice(0, 20)
            : [],
        };
      }
    } catch {}
  }
}

function copySessions(sessions) {
  return (sessions || []).map((session) => ({ ...session }));
}

function scanSessions(options = {}) {
  const now = Date.now();
  const attentionDir = path.join(keep.ROOT, '.keep', 'attention');
  const sessions = scanClaudeSessions(options);
  let codexSessions = [];
  try { codexSessions = codex.scan(); } catch {}
  attachCodexMarkers(codexSessions, attentionDir, now, options);
  sessions.push(...codexSessions);
  titles.applyLiveTitles(sessions, { cachedOnly: true });
  sessions.sort((a, b) => b.mtime - a.mtime);
  sessionSnapshot = copySessions(sessions);
  sessionSnapshotAt = now;
  if (options.dashboard === true) lastDashboardSessionScan = now;
  return copySessions(sessionSnapshot);
}

function normalizedProject(value) {
  if (typeof value !== 'string' || !value) return '';
  return path.resolve(value.replace(/^~(?=\/|$)/, os.homedir()));
}

function readLiveSessionLedger(deps = {}) {
  if (deps.ledger && typeof deps.ledger === 'object') return JSON.parse(JSON.stringify(deps.ledger));
  try {
    const value = JSON.parse(fs.readFileSync(path.join(deps.root || keep.ROOT, '.keep', 'live-sessions.json'), 'utf8'));
    if (value && typeof value === 'object') return value;
  } catch {}
  return { updatedAt: 0, sessions: {} };
}

function writeLiveSessionLedger(ledger, deps = {}) {
  if (typeof deps.writeLedger === 'function') return deps.writeLedger(ledger);
  const dir = path.join(deps.root || keep.ROOT, '.keep');
  const file = path.join(dir, 'live-sessions.json');
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(ledger)}\n`);
  fs.renameSync(tmp, file);
}

async function liveSessionTick(deps = {}) {
  if (liveSessionTickInFlight) return { skipped: true };
  liveSessionTickInFlight = true;
  try {
    const now = (deps.now || Date.now)();
    const live = await (deps.liveSessionPids || liveSessionPids)(deps);
    const hostPanes = await listHostPanes(deps, true) || [];
    for (const pane of hostPanes) {
      const meta = pane && pane.meta;
      if (!pane.alive || pane.agentAlive === false || !meta || !/^[A-Za-z0-9_-]+$/.test(String(meta.sessionId || ''))) continue;
      live.set(meta.sessionId, {
        pid: pane.agentPid || (Number.isInteger(pane.pid) ? pane.pid : null),
        agent: meta.agent || 'claude',
        project: meta.project || '',
        source: 'host',
        primary: true,
      });
    }

    const prior = readLiveSessionLedger(deps);
    const ledger = {
      updatedAt: now,
      sessions: prior.sessions && typeof prior.sessions === 'object' ? prior.sessions : {},
    };
    const records = paneRecordEntries(deps);
    let scanned = [];
    try { scanned = await (deps.scanSessions || scanSessions)(); } catch {}
    const scannedById = new Map(scanned.map((session) => [session.id, session]));
    const exitedIds = new Set(scanned.filter((session) => session && session.exited).map((session) => session.id));
    for (const id of exitedIds) delete ledger.sessions[id];

    for (const [id, entry] of live) {
      if (exitedIds.has(id)) continue;
      const record = records.get(id);
      const session = scannedById.get(id);
      const previous = ledger.sessions[id];
      let project = entry.project || record && record.cwd || session && session.project
        || previous && typeof previous.project === 'string' && previous.project || '';
      if (!project) project = sessionProjectFromTranscript(id, deps, entry.agent).project;
      ledger.sessions[id] = {
        pid: entry.pid,
        agent: entry.agent,
        project,
        source: entry.source,
        primary: entry.primary !== false,
        lastSeenAlive: now,
      };
    }

    const cutoff = now - 7 * 86400e3;
    for (const [id, entry] of Object.entries(ledger.sessions)) {
      if (!entry || !Number.isFinite(entry.lastSeenAlive) || entry.lastSeenAlive < cutoff) delete ledger.sessions[id];
    }
    await writeLiveSessionLedger(ledger, deps);
    return { ok: true, mapped: live.size, ledger };
  } catch (error) {
    (deps.stderr || process.stderr.write.bind(process.stderr))(`keep serve: live session tick failed: ${error.message}\n`);
    return { ok: false, error: error.message };
  } finally {
    liveSessionTickInFlight = false;
  }
}

async function restorePlan(query, deps = {}) {
  const get = (name) => query && typeof query.get === 'function' ? query.get(name) : query && query[name];
  const rawSince = get('since');
  const since = rawSince == null || rawSince === '' ? 30 * 60e3 : Number(rawSince);
  if (!Number.isFinite(since) || since < 0) {
    throw new InjectionError(400, 'since must be a non-negative duration in milliseconds');
  }

  const now = (deps.now || Date.now)();
  const cutoff = now - since;
  const project = normalizedProject(get('project'));
  const ledger = readLiveSessionLedger(deps);
  let scanned = [];
  try { scanned = await (deps.scanSessions || scanSessions)(); } catch {}
  const scannedById = new Map(scanned.map((session) => [session.id, session]));
  const live = await (deps.liveSessionPids || liveSessionPids)(deps);
  const hostPanes = await listHostPanes(deps, true) || [];
  const candidates = new Map(Object.entries(ledger.sessions || {}));

  const paneBySession = new Map();
  for (const pane of hostPanes) {
    const id = pane && pane.meta && pane.meta.sessionId;
    if (!/^[A-Za-z0-9_-]+$/.test(String(id || ''))) continue;
    const current = paneBySession.get(id);
    paneBySession.set(id, preferredHostPane(current, pane));
  }
  for (const [id, pane] of paneBySession) {
    const meta = pane.meta || {};
    const previous = candidates.get(id) || {};
    candidates.set(id, {
      ...previous,
      pid: Number.isInteger(pane.pid) ? pane.pid : previous.pid,
      agent: meta.agent || previous.agent || 'claude',
      project: meta.project || previous.project || '',
      source: 'host',
      primary: true,
      lastSeenAlive: pane.alive && pane.agentAlive !== false ? now
        : Date.parse(pane.exitedAt || pane.lastOutputAt || pane.createdAt || '') || previous.lastSeenAlive || now,
    });
  }

  const rows = [];
  for (const [id, entry] of candidates) {
    if (!/^[A-Za-z0-9_-]+$/.test(id) || !entry || entry.primary === false
        || !Number.isFinite(entry.lastSeenAlive) || entry.lastSeenAlive < cutoff) continue;
    if (project && normalizedProject(entry.project) !== project) continue;

    const session = scannedById.get(id);
    const pane = paneBySession.get(id);
    const state = live.has(id) || pane && pane.alive && pane.agentAlive !== false ? 'alive' : 'gone';
    const agent = entry.agent || session && (session.kind || session.agent) || 'claude';
    let codexChild = false;
    if (agent === 'codex') {
      if (fs.existsSync(path.join(deps.root || keep.ROOT, '.keep', 'codex-parents', `${id}.json`))) {
        codexChild = true;
      } else {
        try {
          const meta = (deps.codexSessionMeta || codex.sessionMetaFor)(id);
          codexChild = codex.isChildSession(meta);
        } catch {}
      }
    }

    const hasTranscript = agent === 'codex' || Boolean((deps.transcriptExists || findSessionFile)(id));
    let action = 'skip';
    let reason;
    if (codexChild) reason = 'codex child session';
    else if (session && session.exited) reason = 'session exited';
    else if (!hasTranscript) reason = 'no transcript to resume (zero-turn session)';
    else if (state === 'alive') reason = 'agent process is alive';
    else {
      action = 'restore';
      reason = 'agent process is gone';
    }

    rows.push({
      id,
      sessionId: id,
      agent,
      project: entry.project || session && session.project || '',
      pane: pane && pane.id || null,
      state,
      mtime: session && Number.isFinite(Number(session.mtime)) ? Number(session.mtime) : entry.lastSeenAlive,
      lastSeenAlive: entry.lastSeenAlive,
      source: entry.source,
      action,
      reason,
    });
  }

  const restoreByPid = new Map();
  for (const row of rows) {
    if (row.action !== 'restore') continue;
    const pid = ledger.sessions && ledger.sessions[row.id] && ledger.sessions[row.id].pid;
    if (pid == null) continue;
    const current = restoreByPid.get(pid);
    if (!current || row.mtime > current.mtime) restoreByPid.set(pid, row);
  }
  for (const row of rows) {
    if (row.action !== 'restore') continue;
    const pid = ledger.sessions && ledger.sessions[row.id] && ledger.sessions[row.id].pid;
    const newest = pid == null ? null : restoreByPid.get(pid);
    if (newest && newest !== row) {
      row.action = 'skip';
      row.reason = `same process as ${newest.id}`;
    }
  }

  rows.sort((a, b) => b.lastSeenAlive - a.lastSeenAlive);
  return { ok: true, since, sessions: rows };
}
function stalledSessionSnapshot(now = Date.now()) {
  if (sessionSnapshotAt && now - lastDashboardSessionScan < 5 * 60e3) return copySessions(sessionSnapshot);
  if (lastStalledSessionScan && now - lastStalledSessionScan < 5 * 60e3) return copySessions(sessionSnapshot);
  lastStalledSessionScan = now;
  return scanSessions({ readOnly: true });
}

// ---------- state assembly ----------

function applyHostedExitState(sessions, panes, independentLive) {
  require('./session-model').attachRuntime(sessions, panes || [], independentLive);
}

function applySessionLiveness(sessions, ledger, panes, now = Date.now()) {
  const aliveIds = stallAliveIds(ledger, now);
  const paneAliveIds = new Set((panes || [])
    .filter((pane) => pane?.alive && pane.agentAlive !== false && pane.meta?.sessionId)
    .map((pane) => pane.meta.sessionId));
  const kept = [];
  for (const session of sessions || []) {
    session.alive = session.kind === 'claude' && aliveIds
      ? aliveIds.has(session.id) || paneAliveIds.has(session.id)
      : null;
    // Non-host TUIs only expose their id during hooks. A prior sighting or
    // recent transcript activity makes ledger absence inconclusive.
    if (session.alive === false && (ledger.sessions?.[session.id] !== undefined
      || !(Number(session.mtime) < now - 30 * 60e3))) session.alive = null;
    if (session.state === 'running' && session.alive === false) {
      session.state = 'recent';
      session.deadMidTurn = true;
    }
    if (session.alive === false && !session.lastAssistant && !session.title) continue;
    kept.push(session);
  }
  sessions.splice(0, sessions.length, ...kept);
  return sessions;
}

function ensureDigest() {
  const today = keep.nowStamp().slice(0, 10);
  const file = path.join(keep.ROOT, 'digests', `${today}.md`);
  if (fs.existsSync(file)) {
    try {
      const md = fs.readFileSync(file, 'utf8');
      health.record('digest', { ok: true, detail: 'exists' });
      return { date: today, md };
    } catch (error) {
      health.record('digest', { ok: false, error });
      throw error;
    }
  }
  if (new Date().getHours() < 5) {
    health.record('digest', { ok: true, skipped: true, detail: 'nothing due' });
    return null; // don't stamp "today" in the small hours
  }
  let md = null;
  let digestError = null;
  try {
    keep.withLock(() => {
      if (fs.existsSync(file)) return; // another process won the race
      md = keep.buildDigest(); // build inside the lock so no mutation is mid-flight
      fs.writeFileSync(file, md);
      keep.commitAndPush(`keep: digest ${today}`, ['digests']);
    });
  } catch (e) {
    digestError = e;
    health.record('digest', { ok: false, error: e });
    process.stderr.write(`keep serve: digest failed: ${e.message}\n`);
  }
  if (md === null && fs.existsSync(file)) {
    try { md = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      health.record('digest', { ok: false, error });
      throw error;
    }
  }
  if (md !== null && !digestError) health.record('digest', { ok: true, detail: 'generated' });
  return md === null ? null : { date: today, md };
}

function buildState(options = {}) {
  let cardUsageSummary = null;
  try { cardUsageSummary = cardUsage.snapshot(keep.ROOT); } catch (error) { health.record('card-usage', { ok: false, error }); }
  const tasks = keep.loadAll(false).map((t) => ({
    id: t.id,
    fm: t.fm,
    body: t.body,
    modelUsage: cardUsage.forCard(cardUsageSummary, t.id),
    lastLog: keep.lastLogLine(t),
    overdue: keep.isOverdue(t),
  }));
  const sessions = scanSessions({ dashboard: options.dashboard === true });
  const now = typeof options.now === 'function' ? Number(options.now()) : Number(options.now ?? Date.now());
  const liveLedger = readLiveSessionLedger(options);
  const independentLive = stallAliveIds({ ...liveLedger, sessions: Object.fromEntries(
    Object.entries(liveLedger.sessions || {}).filter(([, entry]) => entry.source !== 'host'),
  ) }, now);
  if (Object.prototype.hasOwnProperty.call(options, 'hostPanes')) {
    backfillHostSessions(sessions, options.hostPanes, {
      tasks,
      codexSessionFor: options.codexSessionFor,
      claudeSessionFor: options.claudeSessionFor,
      independentLive,
    });
  }
  // Current card links win over historical links; task progress stays separate
  // from the live conversation's readiness for another instruction.
  const allTasks = keep.loadAll(true);
  const byId = { ...sessionTaskOwners(allTasks), ...sessionTaskOwners(tasks) };
  const taskById = new Map([...allTasks, ...tasks].map((task) => [task.id, task]));
  for (const s of sessions) {
    s.taskId = byId[s.id] || null;
    s.taskStatus = taskById.get(s.taskId)?.fm.status || null;
  }
  titles.applyLiveTitles(sessions, { onChange, taskFor: (session) => taskById.get(session.taskId) });
  applySessionLiveness(sessions, liveLedger, options.hostPanes || [], now);
  const dependencyCache = new Map();
  const ownerQuestions = new Map();
  for (const question of review.loadQuestions()) {
    const id = question.from?.sessionId;
    if (['owner', 'jesse'].includes(question.to) && question.status === 'open' && id && !ownerQuestions.has(id)) ownerQuestions.set(id, question);
  }
  const liveHostedSessions = new Set((options.hostPanes || []).filter((pane) => pane.alive && pane.agentAlive !== false).map((pane) => pane.meta?.sessionId));
  applyHostedExitState(sessions, options.hostPanes, independentLive);
  for (const session of sessions) {
    if (['claude', 'codex'].includes(session.kind) && options.hostPanes) {
      const file = session.kind === 'claude' ? claudeSessionPathCache.get(session.id) : codex.rolloutFileFor(session.id);
      if (file) {
        const hosted = options.hostPanes.find(p => p.id === session.runtime?.paneId);
        backgroundTargets.set(`${session.kind}:${session.id}`, { agent: session.kind, sid: session.id, file,
          instance: { id: require('./background-jobs').processInstance(hosted),
            processScoped: true, live: session.runtime?.state === 'live' ? true : session.runtime?.state === 'exited' ? false : null } });
        const jobs = require('./background-jobs').read(keep.ROOT, session.kind, session.id, now);
        session.backgroundJobs = jobs;
        session.pendingBackground = jobs.pending || (!jobs.caughtUp && session.pendingBackground);
        session.unknownBackgroundJobs = [...new Set([...jobs.uncertain, ...(!jobs.caughtUp ? session.unknownBackgroundJobs || [] : [])])];
      }
    }
    const task = taskById.get(session.taskId);
    session.ownerQuestion = ownerQuestions.get(session.id) || null;
    if (task && !dependencyCache.has(task.id)) dependencyCache.set(task.id, keep.unresolvedDependencyIds(task));
    session.activity = sessionStatus.activity(session, { task, dependencies: dependencyCache.get(task?.id) || [], live: liveHostedSessions.has(session.id) });
    session.observation = require('./session-model').normalize(session, { task, dependencies: dependencyCache.get(task?.id) || [], live: liveHostedSessions.has(session.id) });
    session.state = session.activity.state;
    session.stateLabel = session.activity.label;
    require('./session-debug').record(session, now);
  }
  const stalledItems = stalled.readCurrent({ root: keep.ROOT });
  const stalledSessionIds = new Set(stalledItems.filter((item) => item.kind === 'session').map((item) => item.id));
  for (const s of sessions) s.stalled = stalledSessionIds.has(s.id);
  const attention = [];
  for (const s of sessions) {
    const item = sessionAttentionItem(s, now);
    if (item) attention.push(item);
  }
  const unblockRecords = unblock.readRecords({ root: keep.ROOT, now, days: 3 });
  const unblocked = unblockRecords.map((record) => ({
    dependent: record.dependent,
    upstream: record.upstream,
    state: unblock.recordState(record),
    attempts: Number(record.attempts || 0),
    at: record.deliveredAt || record.lastAttemptAt || record.resolvedAt || record.createdAt,
  }));
  for (const record of unblockRecords) {
    if (!record.gaveUp && Number(record.attempts || 0) < 3) continue;
    attention.push({
      kind: 'unblocked',
      pri: 1,
      taskId: record.dependent,
      title: `unblocked, no live session to tell: ${record.dependent}`,
      detail: `${record.upstream}${record.gaveUp ? ` — gave up: ${record.gaveUp}` : ` — ${record.attempts} attempts`}`,
      since: record.lastAttemptAt || record.resolvedAt || record.createdAt,
    });
  }
  const healthSnapshot = health.snapshot(now);
  attention.push(...health.attentionItems(healthSnapshot, now).map((item) => ({
    ...item,
    pri: / failing:|restarting:/.test(item.text) ? 0 : 1,
    title: item.id === 'health:daemon' ? 'Daemon restarts' : `Daemon: ${item.id.slice('health:'.length)}`,
    detail: item.text,
    errorText: item.lastError || '',
    since: item.at,
  })));
  attention.push(...stalled.attentionItems(stalledItems));
  // Task-status tiers (review/blocked/overdue) deliberately do NOT feed the
  // attention box — "Needs you" is live sessions only. Review has its own
  // triage strip; blocked/overdue live on the board.
  const timeOf = (x) => typeof x.since === 'number' ? x.since : Date.parse(x.since) || 0;
  attention.sort((a, b) => a.pri - b.pri || timeOf(b) - timeOf(a));
  let ackNames = new Set();
  try { ackNames = new Set(fs.readdirSync(path.join(keep.ROOT, '.keep', 'acks'))); } catch {}
  const visibleAttention = attention.filter((item) => {
    const key = attentionAckKey(item);
    return !ackNames.has(attentionAckName(key));
  });
  const setAsideState = applySetAside(setAsideCandidates(visibleAttention, sessions));
  if (setAsideState.changed) onChange();
  let digest = null;
  try { digest = ensureDigest(); } catch (e) { process.stderr.write(`keep serve: digest failed: ${e.message}\n`); }
  const alertMeta = alerts.loadMeta(keep.ROOT);
  const state = {
    generatedAt: Date.now(),
    scopes: { ...require('./preferences').scopes(), home: os.homedir() },
    projectCatalog: require('./preferences').projectCatalog(),
    restarts: require('./session-restart').read(path.join(keep.ROOT, '.keep', 'session-restarts.json')),
    tasks,
    sessions,
    attention: visibleAttention,
    setAside: setAsideState.value.items,
    stalled: stalledItems,
    unblocked,
    digest,
    notifications: notifications.snapshot(keep.ROOT),
    alerts: alerts.readAlerts({ root: keep.ROOT, all: true, limit: 10 }),
    brief: alertMeta.lastBriefText ? { at: alertMeta.lastBriefAt || null, text: alertMeta.lastBriefText } : null,
    standup: standup.dashboardState(),
    landed: landed.dashboardState(),
    limitResume: limitresume.dashboardState(keep.ROOT),
    slack: slack.dashboardState(),
    health: healthSnapshot,
    runs: runs.listRuns(),
    usage: usage.getUsage(),
    reviewQueue: reviewQueue.snapshot({ loadTasks: () => allTasks, now }),
  };
  try {
    if (digest) digest.summary = summarize.getSummary(`digest-${digest.date}`, digest.md, DIGEST_INSTRUCTION, onChange).text;
  } catch {}
  try {
    const input = tasks
      .filter((t) => ['active', 'review', 'landing'].includes(t.fm.status) && (t.fm.sessions || []).length)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((t) => {
        const logs = [...t.body.matchAll(/^## .*\n([^\n]+)/gm)].slice(0, 3).map((m) => m[1].trim()).filter(Boolean);
        return `Title: ${t.fm.title}\nStatus: ${t.fm.status}\nLatest logs:\n${logs.length ? logs.map((l) => `- ${l}`).join('\n') : '- (none)'}`;
      }).join('\n\n');
    if (input) state.resumeSummary = summarize.getSummary('resume', input, RESUME_INSTRUCTION, onChange).text;
  } catch {}
  try {
    const review = tasks.filter((t) => t.fm.status === 'review').sort((a, b) => a.id.localeCompare(b.id));
    if (review.length) {
      const input = review.map((t) => `Title: ${t.fm.title}\nLatest log: ${t.lastLog || '(none)'}`).join('\n\n');
      state.reviewSummary = summarize.getSummary('review', input, REVIEW_INSTRUCTION, onChange).text;
    }
  } catch {}
  try {
    const d = new Date(Date.now() - 7 * 864e5);
    const p = (n) => String(n).padStart(2, '0');
    const weekAgo = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    const weekly = keep.loadAll(true)
      .filter((t) => t.fm.status === 'done' && t.fm.updated >= weekAgo)
      .sort((a, b) => a.id.localeCompare(b.id));
    const input = weekly.map((t) => `- ${t.fm.title} (${keep.lastLogLine(t)})`).join('\n');
    if (input) state.weeklySummary = summarize.getSummary(`weekly-${weekAgo.slice(0, 10)}`, input, WEEKLY_INSTRUCTION, onChange).text;
  } catch {}
  try {
    state.reviewUsage = review.reviewerUsage();
    if (state.reviewUsage) {
      const limits = state.usage && state.usage.claude && state.usage.claude.limits;
      state.reviewUsage.weekly = review.reviewerWeekly(limits || []);
    }
  } catch {}
  try {
    const now = Date.now();
    if (reviewStateCache.value && now - reviewStateCache.at < 15e3) state.review = reviewStateCache.value;
    else {
      const reviewerStats = review.reviewStats();
      const dayKeys = Object.keys(reviewerStats.days || {}).sort().slice(-2);
      const current = reviewerStats.markers.find((marker) => !marker.ended);
      state.review = {
        events: review.readReviewEvents({ limit: 300 }),
        stats: {
          lastTickAt: reviewerStats.lastTickAt,
          lastSkip: reviewerStats.lastSkip,
          lastCompactAt: reviewerStats.lastCompactAt,
          days: Object.fromEntries(dayKeys.map((day) => [day, reviewerStats.days[day]])),
          medianContextTokens: reviewerStats.transcript?.medianContextTokens ?? null,
          compactionsToday: reviewerStats.transcript?.compactionsToday ?? 0,
          weekly: state.reviewUsage?.weekly ?? null,
          findingsTotal: reviewerStats.findingsTotal,
          dismissed: reviewerStats.dismissed,
          outcomes: reviewerStats.outcomes,
          tickIntervalMs: review.TICK_MS,
          reviewer: current ? { id: current.id, state: current.state, model: current.model } : null,
        },
      };
      reviewStateCache = { at: now, value: state.review };
    }
  } catch {
    state.review = { events: [], stats: {} };
  }
  return state;
}

// One pane per session: a live pane wins; among exited panes the newest wins, so
// a session relaunched after Ctrl+C is attached to the pane that carries its exit.
function preferredHostPane(current, pane) {
  if (!current) return pane;
  const liveAgent = (p) => Boolean(p.alive && p.agentAlive !== false);
  if (liveAgent(current) !== liveAgent(pane)) return liveAgent(pane) ? pane : current;
  if (Boolean(current.alive) !== Boolean(pane.alive)) return pane.alive ? pane : current;
  const stamp = (candidate) => Date.parse(candidate.exitedAt || candidate.createdAt || '') || 0;
  return stamp(pane) > stamp(current) ? pane : current;
}

function hostPanesBySession(panes) {
  const bySession = new Map();
  for (const pane of panes || []) {
    const id = pane && pane.meta && pane.meta.sessionId;
    if (typeof id !== 'string' || !id) continue;
    bySession.set(id, preferredHostPane(bySession.get(id), pane));
  }
  return bySession;
}

// Exited agent panes are backfilled too: the console lists them as exited so the
// session can be reopened or its pane removed instead of silently vanishing.
function backfillHostSessions(sessions, panes, deps = {}) {
  const sessionIds = new Set(sessions.map((session) => session.id));
  const owners = sessionTaskOwners(deps.tasks || []);
  const added = [];
  for (const pane of hostPanesBySession(panes).values()) {
    try {
      const meta = pane && pane.meta;
      const id = meta && meta.sessionId;
      const agent = meta && meta.agent;
      if (!pane || typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)
        || !['claude', 'codex'].includes(agent) || sessionIds.has(id)) continue;
      const lookup = agent === 'codex'
        ? deps.codexSessionFor || codex.sessionFor
        : deps.claudeSessionFor || claudeSessionFor;
      let session = null;
      try { session = lookup(id); } catch {}
      if (!session) {
        session = {
          id,
          kind: agent,
          project: meta.project || pane.cwd || '',
          title: meta.title || pane.title || '',
          lastUser: '',
          lastAssistant: '',
          lastAssistantFull: '',
          mtime: Date.parse(pane.createdAt) || Date.now(),
          size: 0,
          endedTurn: true,
          state: 'recent',
        };
      } else {
        session = { ...session };
      }
      session.id = id;
      session.pane = pane.id;
      session.hostOnly = true;
      session.taskId = owners[id] || null;
      if ((!pane.alive || pane.agentAlive === false) && !deps.independentLive?.has(id)) {
        // An exited agent cannot be answered: keep the transcript tail for display
        // but drop the prompts that would otherwise resurface in "Needs you".
        session.state = 'exited';
        session.exited = true;
        session.pendingQuestion = null;
        session.pendingPlan = null;
        session.rateLimit = null;
        session.toolRunning = false;
        session.pendingBackground = false;
      }
      sessions.push(session);
      added.push(session);
      sessionIds.add(id);
    } catch {}
  }
  sessions.sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0));
  return added;
}

async function addHostSessionState(state, deps = {}) {
  const panes = Object.prototype.hasOwnProperty.call(deps, 'panes') ? deps.panes : await listHostPanes(deps);
  if (!state.sessions) state.sessions = [];
  backfillHostSessions(state.sessions, panes, {
    tasks: state.tasks || [],
    codexSessionFor: deps.codexSessionFor,
    claudeSessionFor: deps.claudeSessionFor,
  });
  const bySession = hostPanesBySession(panes);
  for (const session of state.sessions || []) {
    const pane = bySession.get(session.id);
    session.pane = pane ? pane.id : null;
  }
  const sessionPanes = new Map((state.sessions || []).map((session) => [session.id, session.pane || null]));
  for (const item of state.attention || []) item.pane = item.sessionId ? sessionPanes.get(item.sessionId) || null : null;
  state.panes = panes || [];
  return state;
}

function buildWhoSnapshot(project) {
  const tasks = keep.loadAll(false);
  const sessions = scanSessions();
  const holds = keep.activeHolds(project, Date.now(), { devices: true });
  const owners = sessionTaskOwners(tasks);
  for (const session of sessions) session.taskId = owners[session.id] || null;
  return who.fleetSnapshot(project, {
    tasks,
    sessions,
    runs: runs.listRuns(),
    holds,
    deviceHolds: true,
    steps: steps.status(project, { tasks, holds: keep.activeHolds(project) }),
    git: who.gitSnapshot(project),
    now: Date.now(),
  });
}

function sessionAttentionItem(session, now) {
  return sessionStatus.attention(session);
}

function sessionTaskOwners(tasks) {
  const owners = {};
  for (const task of tasks) {
    for (const session of task.fm.sessions || []) {
      const candidate = { taskId: task.id, at: session.at || '' };
      const current = owners[session.id];
      if (!current || candidate.at > current.at ||
          (candidate.at === current.at && candidate.taskId < current.taskId)) {
        owners[session.id] = candidate;
      }
    }
  }
  return Object.fromEntries(Object.entries(owners).map(([id, owner]) => [id, owner.taskId]));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad JSON body')); }
    });
    req.on('error', reject);
  });
}

function apiRequestAuthError(req, deps) {
  if (!keepConsole.authorized(req, deps)) return { status: 403, error: 'unauthorized' };
  if (req.method === 'POST' && req.headers['x-keep'] !== '1') {
    return { status: 403, error: 'missing x-keep header' };
  }
  return null;
}

// ---------- server ----------

// Injected into review.js so the reviewer scheduler can reach the terminal send path
// and the live session list without review.js importing the server.
// A run's own session must never be the recipient: it is headless, already gone, and
// marked spawned. Same for the reviewer, whose ticks are its only input.
// Pure, so the rule is testable without a live daemon.
function pickNotifyTarget(linkedIds, sessions, excluded) {
  const linked = new Set((linkedIds || []).filter(Boolean));
  if (!linked.size) return null;
  const skip = excluded instanceof Set ? excluded : new Set(excluded || []);
  const live = (sessions || []).filter((s) => linked.has(s.id) && !skip.has(s.id)
    // mid-turn: the notice would land in the middle of unrelated work
    && (s.state === 'running' || s.state === 'idle') && s.endedTurn !== false);
  if (!live.length) return null;
  // one recipient: the thread that most recently touched this card
  live.sort((a, b) => b.mtime - a.mtime);
  return live[0];
}

function pickDeliveryCandidates(linkedIds, sessions, excluded) {
  const linked = new Set((linkedIds || []).filter(Boolean));
  const skip = excluded instanceof Set ? excluded : new Set(excluded || []);
  const present = (sessions || []).filter((session) => session && !session.exited && linked.has(session.id) && !skip.has(session.id));
  const safe = (session) => session.endedTurn !== false
    && !(session.endedTurn === undefined && session.state === 'running')
    && !session.pendingQuestion && !session.pendingPlan && session.askedProse !== true
    // `waiting` is Claude Code's idle_prompt: the turn ended and Owner has not typed, so it is safe for delivery.
    && !(session.notify && ['permission', 'question'].includes(session.notify.type));
  const candidates = present.filter(safe).sort((a, b) => b.mtime - a.mtime);
  return { candidates, busy: present.length - candidates.length };
}

function excludedSessionIds() {
  const excluded = new Set();
  for (const dir of ['spawned', 'reviewer']) {
    try { for (const id of fs.readdirSync(path.join(keep.ROOT, '.keep', dir))) excluded.add(id); } catch {}
  }
  return excluded;
}

function notifyTaskSession(taskId, text) {
  let task;
  try { task = keep.loadTask(taskId); } catch { return; }
  const target = pickNotifyTarget(
    (task.fm.sessions || []).map((s) => s && s.id),
    scanSessions(),
    excludedSessionIds(),
  );
  if (!target) return;
  withInjectionLock(() => sendToSession({ sessionId: target.id, text })).catch((e) => {
    // the card already carries the result; a busy or unreachable terminal is not a failure
    process.stderr.write(`keep runs: could not notify ${target.id.slice(0, 8)} about ${taskId}: ${e.message}\n`);
  });
}

// A card's `sessions` link follows its session to whatever card that session touched
// last, so the thread that scheduled a check is often no longer linked here. It is
// still the thread that wants the check, so it leads the candidate list.
function checkDeliveryIds(task) {
  const fm = (task && task.fm) || {};
  const ids = [fm.scheduled_by, ...(fm.sessions || []).map((s) => s && s.id)];
  return [...new Set(ids.filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id)))];
}

async function deliverCheckToThread(task, deps = {}) {
  const text = runs.checkDeliveryMessage(task);
  const prior = require('./delivery').statusForText(deps.deliveryDirectory || path.join(keep.ROOT, '.keep', 'delivery'), text, runs.checkDeliveryKey(task));
  if (prior?.received) return { sessionId: prior.sessionId, kind: prior.kind, delivery: 'received' };
  const { candidates, busy } = pickDeliveryCandidates(
    checkDeliveryIds(task),
    (deps.scanSessions || scanSessions)(),
    deps.excluded || excludedSessionIds(),
  );
  // pickDeliveryCandidates ranks by recency, so hoist the scheduler back to the
  // front; sort is stable, so the rest keeps its order and its busy/closed handling.
  const scheduler = task.fm && task.fm.scheduled_by;
  let ordered = scheduler
    ? candidates.slice().sort((a, b) => (b.id === scheduler) - (a.id === scheduler))
    : candidates;
  if (prior) {
    ordered = ordered.filter((s) => s.id === prior.sessionId);
    if (!ordered.length) return { deferred: true, uncertain: true, reason: 'Prior delivery unconfirmed; waiting for that same session, not launching another check' };
  }
  for (const candidate of ordered) {
    let session;
    let target;
    try {
      session = (deps.loadCurrentSession || loadCurrentSession)(candidate.id);
      target = await (deps.resolveSessionTarget || resolveSessionTarget)(session, null);
    } catch (e) {
      process.stderr.write(`keep serve: delivery candidate ${candidate.id.slice(0, 8)} is closed: ${String(e && e.message || e)}\n`);
      continue;
    }
    try {
      const result = await withInjectionLock(() => (deps.sendToResolvedTarget || sendToResolvedTarget)(session, target, text, { compactIfCold: true, retainReceipt: true, deliveryKey: runs.checkDeliveryKey(task) }));
      return {
        sessionId: session.id,
        kind: session.kind,
        ...(result && result.truncated ? {
          truncated: true,
          received: result.received,
          expected: result.expected,
        } : {}),
      };
    } catch (e) {
      return { deferred: true, reason: String(e && e.message || e) };
    }
  }
  return busy > 0
    ? { deferred: true, reason: 'linked thread is mid-turn or waiting on Owner' }
    : null;
}

async function deliverUnblockToThread(task, text) {
  const { candidates, busy } = pickDeliveryCandidates(
    (task.fm.sessions || []).map((session) => session && session.id),
    scanSessions(),
    excludedSessionIds(),
  );
  for (const candidate of candidates) {
    let session;
    let target;
    try {
      session = loadCurrentSession(candidate.id);
      target = await resolveSessionTarget(session, null);
    } catch (error) {
      process.stderr.write(`keep serve: unblock candidate ${candidate.id.slice(0, 8)} is closed: ${String(error && error.message || error)}\n`);
      continue;
    }
    try {
      const result = await withInjectionLock(() => sendToResolvedTarget(session, target, text, { compactIfCold: true }));
      return { sessionId: session.id, kind: session.kind, ...(result || {}) };
    } catch (error) {
      return { deferred: true, reason: String(error && error.message || error) };
    }
  }
  return busy > 0
    ? { deferred: true, reason: 'linked thread is mid-turn or waiting on Owner' }
    : null;
}

function sendReviewerMessage(sessionId, text, opts) {
  return sendToSession(
    { sessionId, text },
    { ...review.readReviewerMarker(sessionId), bootstrap: Boolean(opts && opts.bootstrap) },
  );
}

const reviewDeps = {
  send: (sessionId, text, opts) => withInjectionLock(() => sendReviewerMessage(sessionId, text, opts)),
  sendPlain: (sessionId, text) => withInjectionLock(() => sendToSession({ sessionId, text })),
  sessions: () => scanSessions(),
  sessionContextTokens,
  compact: (sessionId, instruction) => withInjectionLock(() => compactSessionById({ sessionId, instruction })),
  who: (project) => buildWhoSnapshot(project),
};

function briefClock(value) {
  const match = String(value || '08:00').match(/^(\d{2}):(\d{2})$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return { hour: 8, minute: 0, invalid: true };
  return { hour: Number(match[1]), minute: Number(match[2]), invalid: false };
}

function briefDue(meta, now, clock = briefClock('08:00')) {
  const at = Number(now);
  const date = new Date(at);
  const day = alerts.dayOf(at);
  if (meta.lastBriefDay === day || meta.lastBriefGiveUpDay === day) return false;
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate(), clock.hour, clock.minute).getTime();
  const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0).getTime();
  if (at < target || at >= noon) return false;
  const attemptedAt = Number(meta.lastBriefAttemptAt || 0);
  return alerts.dayOf(attemptedAt) !== day || at - attemptedAt >= 30 * 60e3;
}

function startBriefScheduler(options = {}) {
  const clock = briefClock(process.env.KEEP_BRIEF_AT || '08:00');
  if (clock.invalid) process.stderr.write(`keep serve: invalid KEEP_BRIEF_AT; using 08:00\n`);
  let running = false;
  const tick = async () => {
    if (running) return;
    const now = Date.now();
    const date = new Date(now);
    const day = alerts.dayOf(now);
    const meta = alerts.loadMeta(keep.ROOT);
    if (meta.lastBriefDay === day && !meta.lastBriefClaim) {
      health.record('brief', { ok: true, skipped: true, detail: 'nothing due' });
      return;
    }
    const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0).getTime();
    if (now >= noon) {
      let recorded;
      try {
        recorded = keep.withLock(() => {
          const latest = alerts.loadMeta(keep.ROOT);
          if ((latest.lastBriefDay === day && !latest.lastBriefClaim) || latest.lastBriefGiveUpDay === day) return false;
          if (latest.lastBriefClaim && now - Number(latest.lastBriefClaimAt || 0) < 10e3) return false;
          delete latest.lastBriefDay;
          delete latest.lastBriefClaim;
          delete latest.lastBriefClaimAt;
          latest.lastBriefGiveUpDay = day;
          alerts.appendAlert({
            id: `brief-failed-${day}`,
            at: now,
            level: 'brief',
            key: `brief:${day}`,
            text: 'Morning brief delivery failed until the noon cutoff.',
            from: 'daemon',
            caller: 'manual',
            channels: [],
            delivered: {},
            deferred: false,
            failed: true,
            why: 'no successful delivery by 12:00 local',
          }, keep.ROOT);
          alerts.saveMeta(latest, keep.ROOT);
          return true;
        });
      } catch (error) {
        health.record('brief', { ok: false, error });
        process.stderr.write(`keep serve: morning brief cutoff record failed: ${error.message}\n`);
        return;
      }
      if (recorded) {
        health.record('brief', { ok: false, error: 'no successful delivery by 12:00 local' });
        process.stderr.write(`keep serve: morning brief failed; giving up after 12:00 local\n`);
      } else health.record('brief', { ok: true, skipped: true, detail: 'nothing due' });
      return;
    }
    if (!briefDue(meta, now, clock)) {
      health.record('brief', { ok: true, skipped: true, detail: 'nothing due' });
      return;
    }
    running = true;
    try {
      const brief = keep.briefSnapshot(now);
      const result = await alerts.sendAlert({
        root: keep.ROOT,
        level: 'brief',
        key: `brief:${day}`,
        text: brief.text,
        spoken: brief.spoken,
        from: 'daemon',
        caller: 'manual',
        now,
        withLock: keep.withLock,
      });
      if (result.duplicate) process.stderr.write(`keep serve: morning brief already claimed\n`);
      else if (result.deliveryOk) process.stderr.write(`keep serve: morning brief sent via ${result.channels.join(', ')}\n`);
      else process.stderr.write(`keep serve: morning brief delivery failed; retrying in 30 minutes\n`);
      if (options.onChange) options.onChange();
      if (result.duplicate || result.deliveryOk) health.record('brief', { ok: true, skipped: result.duplicate, detail: result.duplicate ? 'already delivered' : 'delivered' });
      else health.record('brief', { ok: false, error: 'delivery failed; retrying in 30 minutes' });
    } catch (error) {
      health.record('brief', { ok: false, error });
      process.stderr.write(`keep serve: morning brief failed: ${error.message}\n`);
    } finally {
      running = false;
    }
  };
  tick();
  const timer = setInterval(tick, 60e3);
  timer.unref();
  return { tick, timer };
}

function start(deps = {}) {
  health.record('daemon', { at: Date.now(), pid: process.pid, version: health.VERSION });
  const shutdown = () => {
    if (inFlightSwap) {
      const action = shutdownSettingsRepair(inFlightSwap, readClaudeSettingsModel());
      if (!action.repair) {
        process.stderr.write(`keep serve: left settings.json model alone during shutdown: ${action.reason}\n`);
      } else {
        const repaired = repairClaudeSettingsModel(action.value, action.present);
        if (repaired.error) {
          process.stderr.write(`keep serve: could not restore settings.json model during shutdown: ${repaired.error}\n`);
        } else {
          process.stderr.write(`keep serve: restored settings.json model to "${action.value}" during shutdown\n`);
        }
      }
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // launchd appends stdout+stderr here forever; cap it at startup
  try {
    const logFile = path.join(keep.ROOT, '.keep', 'serve.log');
    if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.truncateSync(logFile);
  } catch {}

  const clients = new Set();
  let pending = null;
  const broadcast = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      for (const res of clients) res.write('data: change\n\n');
    }, 1500);
  };
  onChange = broadcast;
  // A focus request (mobile 'Open on Mac') is a named SSE event the console acts on.
  onFocus = (sessionId) => { for (const res of clients) res.write(`event: focus\ndata: ${sessionId}\n\n`); };

  const watch = (target, opts, invalidate) => {
    try {
      const w = fs.watch(target, opts || {}, (_event, name) => { invalidate?.(name); broadcast(); });
      w.on('error', () => {}); // a dead watch must never crash the server; the client's 30s poll covers it
    } catch (e) {
      process.stderr.write(`keep serve: cannot watch ${target} (${e.message}); relying on client polling\n`);
    }
  };
  watch(keep.TASKS);
  // Watch the directory so ledger creation and atomic read-state renames are seen.
  try {
    const inboxWatch = fs.watch(path.join(keep.ROOT, '.keep'), (_event, name) => {
      if (!name || ['alerts.jsonl', 'notifications.json', 'quiet.json'].includes(String(name))) broadcast();
    });
    inboxWatch.on('error', () => {});
  } catch {} // The console's periodic refresh also covers inbox changes.
  watch(path.join(keep.ROOT, 'digests'));
  try { fs.mkdirSync(path.join(keep.ROOT, '.keep', 'attention'), { recursive: true }); } catch {}
  watch(path.join(keep.ROOT, '.keep', 'attention'));
  try { fs.mkdirSync(path.join(keep.ROOT, '.keep', 'unblocked'), { recursive: true }); } catch {}
  watch(path.join(keep.ROOT, '.keep', 'unblocked'));
  try { fs.mkdirSync(path.join(keep.ROOT, '.keep', 'review'), { recursive: true }); } catch {}
  watch(path.join(keep.ROOT, '.keep', 'review'));
  watch(PROJECTS_DIR, { recursive: true }, (name) => claudeTranscriptIndex.invalidate(name));
  watch(path.join(os.homedir(), '.codex', 'sessions'), { recursive: true });
  try { fs.mkdirSync(path.join(keep.ROOT, '.keep', 'lifecycle'), { recursive: true }); } catch {}
  watch(path.join(keep.ROOT, '.keep', 'lifecycle'), { recursive: true });

  const jobLedger = require('./background-jobs');
  for (const target of jobLedger.targets(keep.ROOT)) backgroundTargets.set(`${target.agent}:${target.sid}`, target);
  // One bounded incremental read per tick, outside HTTP state assembly.
  let jobCursor = 0;
  const jobsChanged = createJobChangeTracker();
  const jobTick = () => {
    const targets = [...backgroundTargets.values()];
    if (!targets.length) return;
    const target = jobLedger.nextTarget(targets, jobCursor++);
    try {
      const result = jobLedger.sync({ root: keep.ROOT, ...target,
        classify: (name, input) => isBoundedBackgroundWatcher('Bash', { ...input, command: input?.command || input?.cmd, run_in_background: true }) ? 'finite'
          : isBackgroundService('Bash', { ...input, command: input?.command || input?.cmd }) ? 'service' : 'unknown',
        inspectAgent: (id) => {
          if (target.agent === 'claude') {
            if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) return null;
            const child = scanTranscript(path.join(path.dirname(target.file), path.basename(target.file, '.jsonl'), 'subagents', `agent-${id}.jsonl`), { includeSidechain: true });
            return { at: child.attentionAt || 0, done: child.explicitEndTurn && !child.pendingOther && !child.pendingBackground };
          }
          return require('./codex-lifecycle').inspectChild(id, target.sid);
        },
      });
      if (jobsChanged(`${target.agent}:${target.sid}`, result)) broadcast();
    } catch (error) { process.stderr.write(`keep jobs: ${error.message}\n`); }
  };
  setInterval(jobTick, 500).unref();

  runs.setOnChange(broadcast);
  runs.setNotifier(notifyTaskSession); // before recover(), which can finalize immediately
  runs.setDeliverer(deliverCheckToThread);
  summarize.setOnChange(broadcast);
  require('./session-summary').startScheduler({
    snapshot: sessionSummarySnapshot,
    prepare: prepareSessionSummary,
    onError: (error) => process.stderr.write(`keep session summaries: ${error.message}\n`),
  });
  usage.setOnChange(broadcast);
  usage.setCacheFile(path.join(keep.ROOT, '.keep', 'usage-cache.json'));
  runs.recover(); // surface any orphaned run logs from a prior crash/restart
  runs.startScheduler();
  require('./delivery-health').startScheduler({ root: keep.ROOT, onChange: broadcast,
    reconcile: () => withInjectionLock(() => require('./delivery').reconcile(path.join(keep.ROOT, '.keep', 'delivery'))),
  });
  unblock.startScheduler({
    onChange: broadcast,
    deps: { deliver: deliverUnblockToThread },
  });
  startAutoCompact();
  const restarts = require('./session-restart').createManager({
    file: path.join(keep.ROOT, '.keep', 'session-restarts.json'),
    inspect: async (body) => {
      const panes = await listHostPanes({}, true);
      const state = await addHostSessionState(await buildState({ hostPanes: panes }), { panes });
      return { session: state.sessions.find((s) => s.id === body.sessionId), pane: panes?.find((p) => p.id === body.pane) };
    },
    restart: restartSession, forceRestart: forceRestartSession, onChange: broadcast,
  });
  // Queued idle restarts need fresh safety evidence, but scanning the fleet every
  // two seconds competes with foreground work. Explicit restart-now stays immediate.
  const restartTimer = setInterval(() => restarts.tick().catch((error) => process.stderr.write(`keep restart: ${error.message}\n`)), 10000);
  restartTimer.unref();
  if (process.env.KEEP_AUTO_CLOSE !== '0') {
    const doneIdleMs = envNumber('KEEP_AUTO_CLOSE_DONE_MIN', 15) * 60e3;
    const cleanupSnapshot = async () => {
      // Shell verification must see new viewers/output even inside the host-list cache TTL.
      const panes = await listHostPanes({}, true);
      const state = await addHostSessionState(await buildState({ hostPanes: panes }), { panes });
      const layouts = await keepConsole.readLayouts(path.join(keep.ROOT, '.keep', 'layouts.json'));
      return {
        ...state,
        allTasks: keep.loadAll(true),
        questions: review.loadQuestions(),
        companion: await stalled.discoverCodexJobs({ root: keep.ROOT, fallbackCacheMs: 0 }),
        pinned: new Set((layouts.layouts || []).flatMap((layout) => layout.ids || [])),
      };
    };
    require('./session-cleanup').startScheduler({
      doneIdleMs,
      snapshot: cleanupSnapshot,
      closeShell: pane => withInjectionLock(() => require('./shell-cleanup').close(pane, {
        snapshot: cleanupSnapshot,
        processes: () => agentProcessRows(),
        screen: p => readScreenResult({ pane: p.id }, null, false),
        eof: p => writeTarget({ pane: p.id }, '\x04'),
      })),
      close: async (body) => {
        const result = await withInjectionLock(() => require('./manual-close').manualClose(body, {
          requireGraceful: true,
          protectInput: true,
          protectOutput: true,
          getPane: async (pane) => (await hostRequest('get', { pane })).pane,
          graceful: (request) => closeIdleSession(request, {
            closePolicy: {
              automatic: true,
              done: true,
              idleMs: body.doneIdleMs,
              legacyDoneAt: body.legacyDoneAt,
            },
            withInjectionLock: (fn) => fn(),
          }),
          signal: (pane, signal) => hostRequest('kill', { pane, signal }),
        }));
        keep.recordDaemonSessionClose(body.cardIds, body.sessionId, body.idleMinutes);
        broadcast();
        return result;
      },
      record: (entry) => {
        const file = path.join(keep.ROOT, '.keep', 'session-cleanup.json');
        let entries = [];
        try { const parsed = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(parsed)) entries = parsed; } catch {}
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify([...entries.slice(-499), entry]) + '\n', { mode: 0o600 });
        fs.renameSync(temp, file);
      },
      onError: (error) => process.stderr.write(`keep auto-close: ${error.message}\n`),
    });
  }
  limitresume.startScheduler({
    scanSessions,
    getUsage: usage.getUsage,
    send: (sessionId, text, opts) => resumeAfterLimit(sessionId, text, opts),
    root: keep.ROOT,
    onChange: broadcast,
  });
  review.startScheduler(reviewDeps);
  startBriefScheduler({ onChange: broadcast });
  standup.startScheduler({ onChange: broadcast });
  ideas.startScheduler({ onChange: broadcast });
  landed.startScheduler({ onChange: broadcast });
  slack.startScheduler({ onChange: broadcast });
  const configuredLiveTickMs = Number(process.env.KEEP_LIVE_TICK_MS);
  const liveTickMs = Number.isFinite(configuredLiveTickMs) && configuredLiveTickMs > 0
    ? configuredLiveTickMs
    : 120e3;
  liveSessionTick();
  setInterval(liveSessionTick, liveTickMs).unref();
  let stalledRunning = false;
  const stalledTick = async () => {
    if (stalledRunning) return;
    stalledRunning = true;
    try {
      const now = Date.now();
      const ledger = readLiveSessionLedger();
      const aliveIds = stallAliveIds(ledger, now);
      const result = await stalled.sweep({
        root: keep.ROOT, sessions: stalledSessionSnapshot(), runs: runs.listRuns(),
        ...(aliveIds ? { aliveIds } : {}),
      });
      health.record('stalled', { ok: true, cadenceMs: 60e3, detail: result.detail });
      broadcast();
    } catch (error) {
      health.record('stalled', { ok: false, cadenceMs: 60e3, error });
      process.stderr.write(`keep serve: stalled sweep failed: ${error.message}\n`);
    } finally {
      stalledRunning = false;
    }
  };
  setInterval(stalledTick, 60e3).unref();
  setTimeout(stalledTick, 5e3).unref();
  // Drip-fold fleet transcripts for the weekly attribution: ~750MB of history on a
  // cold start, folded 24MB at a time so no state build ever blocks on it.
  // Every pass is synchronous work on this event loop, and what it produces is a
  // percentage of a WEEKLY window - 30s freshness bought nothing and cost a full
  // directory walk each time. Five minutes is still 288 folds a day.
  const foldFleetUsage = () => {
    try {
      review.foldFleetUsage(24 * 1024 * 1024);
      health.record('fleet-usage', { ok: true });
    } catch (error) {
      health.record('fleet-usage', { ok: false, error });
    }
  };
  let cardUsageRunning = false;
  const collectCardUsage = () => {
    if (cardUsageRunning) return;
    cardUsageRunning = true;
    require('child_process').execFile(process.execPath, [path.join(__dirname, 'card-usage.js')], {
      env: { ...process.env, KEEP_DIR: keep.ROOT }, timeout: 120e3, maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => {
      cardUsageRunning = false;
      health.record('card-usage', { ok: !error, ...(error ? { error: new Error(stderr || error.message) } : {}) });
      broadcast();
      if (!error) {
        try { if (cardUsage.snapshot(keep.ROOT)?.backlog) setTimeout(collectCardUsage, 500).unref(); } catch {}
      }
    });
  };
  setInterval(collectCardUsage, 30e3).unref();
  setTimeout(collectCardUsage, 1000).unref();
  setInterval(foldFleetUsage, 5 * 60e3).unref();
  setTimeout(foldFleetUsage, 20e3).unref();

  // pull cloud-made commits (e.g. the overnight check routine) into the local repo
  const { execFileSync } = require('child_process');
  const pull = () => {
    try {
      keep.withLock(() => {
        execFileSync('git', ['-C', keep.ROOT, 'pull', '-q', '--rebase', '--autostash'], { timeout: 30e3, stdio: 'ignore' });
      });
      health.record('git-pull', { ok: true });
    } catch (error) {
      health.record('git-pull', { ok: false, error });
    } // offline or lock contention — next tick will catch up
  };
  if (process.env.KEEP_SYNC === '1') {
    health.record('git-pull', { skipped: true });
    setInterval(pull, 30 * 60e3).unref();
    setTimeout(pull, 60e3).unref();
  } else {
    health.record('git-pull', { disabled: true, detail: 'registry synchronization is off' });
  }

  const json = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(body);
  };

  // remote access (tailnet/LAN): everything except localhost requires the bearer
  // token in x-keep-token. The token lives in .keep/token (created on first start).
  let token = '';
  const tokenFile = path.join(keep.ROOT, '.keep', 'token');
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch {}
  if (!token) {
    token = require('crypto').randomBytes(24).toString('hex');
    try { fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 }); } catch (e) {
      process.stderr.write(`keep serve: cannot persist token: ${e.message}\n`);
    }
  }
  const isLocal = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

  const server = http.createServer(async (req, res) => {
    if (req.keepConsoleHandled) return;
    try {
      const url = new URL(req.url, 'http://localhost');

      const authError = apiRequestAuthError(req, { isLocal, token });
      if (authError) return json(res, authError.status, { error: authError.error });

      if (req.method === 'GET' && url.pathname === '/api/ui-debug') {
        return json(res, 200, { events: require('./ui-debug').read() });
      }
      if (req.method === 'GET' && url.pathname === '/api/session-debug') {
        return json(res, 200, { events: require('./session-debug').read(url.searchParams.get('session')) });
      }

      if (req.method === 'GET' && url.pathname === '/api/restore-plan') {
        if (req.headers['x-keep'] !== '1') return json(res, 403, { error: 'missing x-keep header' });
        try { return json(res, 200, await restorePlan(url.searchParams)); }
        catch (error) {
          if (error instanceof InjectionError) return json(res, error.status, { error: error.message, ...error.extra });
          throw error;
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/tasksummary') {
        let task;
        try { task = keep.loadTask(url.searchParams.get('id') || ''); }
        catch (e) {
          if (e instanceof keep.KeepError) return json(res, 400, { error: e.message });
          throw e;
        }
        if ((task.body.match(/^## /gm) || []).length < 3) return json(res, 200, { text: null, tooShort: true });
        const result = summarize.getSummary(`task-${task.id}`, task.body, TASK_INSTRUCTION, onChange);
        return json(res, 200, { text: result.text, fresh: result.fresh });
      }

      if (req.method === 'GET' && url.pathname === '/api/sessionsummary') {
        const id = url.searchParams.get('id') || '';
        if (!/^[A-Za-z0-9_-]+$/.test(id)) return json(res, 400, { error: 'bad session id' });
        const session = scanSessions().find((s) => s.id === id);
        const file = sessionSummaryFile(session);
        if (!session || !file) return json(res, 404, { error: 'no session' });
        const result = prepareSessionSummary(session, { priority: -1 });
        return json(res, 200, { text: result.text, fresh: result.fresh });
      }

      if (req.method === 'GET' && url.pathname === '/api/sessiontail') {
        const id = url.searchParams.get('id') || '';
        if (!/^[A-Za-z0-9-]+$/.test(id)) return json(res, 400, { error: 'bad session id' });
        const session = scanSessions().find((s) => s.id === id);
        const file = session && findSessionFile(id);
        if (!session || !file) return json(res, 404, { error: 'no session' });
        return json(res, 200, { text: recentTranscriptText(file) });
      }

      if (req.method === 'GET' && url.pathname === '/api/screen') {
        // The header forces a CORS preflight, so a hostile page cannot even trigger the read.
        if (req.headers['x-keep'] !== '1') return json(res, 403, { error: 'missing x-keep header' });
        try { return json(res, 200, await screenSession(url.searchParams)); }
        catch (error) {
          if (error instanceof InjectionError) return json(res, error.status, { error: error.message });
          throw error;
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/tagsummary') {
        const tag = url.searchParams.get('tag') || '';
        if (!/^[a-z0-9-]+$/.test(tag)) return json(res, 400, { error: 'bad tag' });
        const tasks = keep.loadAll(false)
          .filter((t) => (t.fm.tags || []).includes(tag))
          .sort((a, b) => a.id.localeCompare(b.id));
        if (tasks.length < 2) return json(res, 200, { text: null, tooFew: true });
        const input = tasks.map((t) => `- ${t.fm.title} [${t.fm.status}]: ${keep.lastLogLine(t)}`).join('\n');
        const result = summarize.getSummary(`tag-${tag}`, input, TAG_INSTRUCTION, onChange);
        return json(res, 200, { text: result.text, fresh: result.fresh });
      }

      if (req.method === 'POST') {
        // custom header forces a CORS preflight, which no other origin passes —
        // keeps random web pages from firing POSTs at localhost
        let body;
        try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
        try {
          if (url.pathname === '/api/restart-daemon') {
            try {
              const result = daemonRestartGate.prepare();
              // launchd KeepAlive starts the new daemon. The terminal host and
              // its PTYs are separate processes and are not stopped here.
              setTimeout(shutdown, 50);
              return json(res, 200, result);
            } catch (error) { return json(res, 409, { error: error.message }); }
          }
          if (url.pathname === '/api/notifications') {
            let result;
            try { result = notifications.update(keep.ROOT, body); }
            catch (error) { return json(res, 400, { error: error.message }); }
            broadcast();
            return json(res, 200, result);
          }
          if (url.pathname === '/api/review-queue') {
            try {
              const result = await reviewQueue.act(body, {
                launch: (request) => launchReviewQueueSession(request),
                inspectLaunch: (active) => inspectReviewQueueLaunch(active),
                recoverLaunch: (active, hooks) => recoverReviewQueueLaunch(active, hooks),
              });
              broadcast();
              return json(res, 200, result);
            } catch (error) {
              if (error instanceof reviewQueue.QueueError) {
                return json(res, error.status, { error: error.message, ...error.extra });
              }
              return json(res, 502, { error: String(error && error.message || error).slice(0, 500) });
            }
          }
          if (url.pathname === '/api/add') {
            const task = keep.addTask({
              title: body.title, kind: body.kind, tags: body.tags, project: body.project,
              checkAfter: body.checkAfter, check: body.check, status: body.status, note: body.note,
              experimentId: body.experimentId,
            });
            return json(res, 200, { ok: true, id: task.id });
          }
          if (url.pathname === '/api/checkin') {
            keep.checkinTask(body.id, {
              message: body.message, status: body.status,
              checkAfter: body.checkAfter, clearCheckAfter: body.clearCheckAfter,
              experimentId: body.experimentId,
            });
            broadcast();
            return json(res, 200, { ok: true });
          }
          if (url.pathname === '/api/ack') {
            const hasSessionId = Object.prototype.hasOwnProperty.call(body, 'sessionId');
            const hasTaskId = Object.prototype.hasOwnProperty.call(body, 'taskId');
            const isHealth = body.kind === 'health' && typeof body.id === 'string' && /^health:[A-Za-z0-9._-]+$/.test(body.id);
            const isStalled = body.kind === 'stalled' && typeof body.id === 'string' && /^stalled:[A-Za-z0-9._:-]+$/.test(body.id);
            const validId = /^[A-Za-z0-9._-]+$/;
            if (!ATTENTION_KINDS.has(body.kind) || (isHealth ? hasSessionId || hasTaskId : isStalled ? hasSessionId && hasTaskId : hasSessionId === hasTaskId) ||
                (hasSessionId && (typeof body.sessionId !== 'string' || !validId.test(body.sessionId))) ||
                (hasTaskId && (typeof body.taskId !== 'string' || !validId.test(body.taskId))) ||
                !['number', 'string'].includes(typeof body.since)) {
              return json(res, 400, { error: 'bad attention acknowledgement' });
            }
            let ackItem = body;
            if (isHealth) {
              const current = health.attentionItems(health.snapshot()).find((item) => item.id === body.id);
              if (!current) return json(res, 400, { error: 'health alert is no longer current' });
              ackItem = { ...body, errorText: current.lastError || '', incidentId: current.incidentId || null };
            }
            const key = attentionAckKey(ackItem);
            const ackDir = path.join(keep.ROOT, '.keep', 'acks');
            try {
              fs.mkdirSync(ackDir, { recursive: true });
              fs.writeFileSync(path.join(ackDir, attentionAckName(key)), JSON.stringify({ key, at: Date.now() }) + '\n');
            } catch (e) {
              process.stderr.write(`keep serve: acknowledgement failed: ${e.message}\n`);
              return json(res, 500, { error: 'could not save acknowledgement' });
            }
            try {
              const cutoff = Date.now() - 14 * 864e5;
              for (const name of fs.readdirSync(ackDir)) {
                try {
                  const file = path.join(ackDir, name);
                  if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
                } catch {}
              }
            } catch {}
            broadcast();
            return json(res, 200, { ok: true });
          }
          if (url.pathname === '/api/setaside') {
            try {
              const panes = await listHostPanes(deps);
              const state = buildState({ hostPanes: panes });
              const entry = updateSetAside(body, setAsideCandidates(state.attention, state.sessions));
              broadcast();
              return json(res, 200, { ok: true, entry });
            } catch (error) {
              if (error instanceof InjectionError) return json(res, error.status, { error: error.message });
              throw error;
            }
          }
          if (url.pathname === '/api/ui-debug') {
            try { require('./ui-debug').record(body.events); return json(res, 200, { ok: true }); }
            catch (error) { return json(res, 400, { error: error.message }); }
          }
          if (url.pathname === '/api/run') {
            const run = runs.startRun(body.id, body.kind === 'check' ? 'check' : 'task', body.prompt);
            return json(res, 200, { ok: true, runId: run.id });
          }
          if (url.pathname === '/api/focus') {
            const sessionId = String(body && body.sessionId || '');
            if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return json(res, 400, { error: 'bad session id' });
            onFocus(sessionId);
            return json(res, 200, { ok: true, focus: 'console', sessionId });
          }
          // A shell pane has no session to lock against and no agent to interrupt.
          if (url.pathname === '/api/send' && body && body.pane && !body.sessionId) {
            try { return json(res, 200, await writeToShellPane(body)); }
            catch (e) {
              if (e instanceof InjectionError) return json(res, e.status, { error: e.message });
              return json(res, 502, { error: String(e && e.message || e).slice(0, 500) });
            }
          }
          if (url.pathname === '/api/open' || url.pathname === '/api/send' || url.pathname === '/api/compact' ||
              url.pathname === '/api/answer') {
            if (injectionBusy) return json(res, 429, { error: 'another session injection is busy' });
            try {
              const result = url.pathname === '/api/open' ? await openSession(body) : await withInjectionLock(() => url.pathname === '/api/send' ? sendToSession(body)
                : url.pathname === '/api/compact'
                  ? compactSessionById(body)
                  : answerSession(body));
              broadcast();
              return json(res, 200, result);
            } catch (e) {
              if (e instanceof InjectionError) return json(res, e.status, { error: e.message, ...e.extra });
              return json(res, 502, { error: String(e && e.message || e).slice(0, 500) });
            }
          }
          if (url.pathname === '/api/restart-session') {
            try { return json(res, 200, await restarts.request(body)); }
            catch (error) { return json(res, error.status || 409, { error: error.message }); }
          }
          if (url.pathname === '/api/close-idle' || url.pathname === '/api/close-session') {
            try {
              const result = url.pathname === '/api/close-session'
                ? await require('./manual-close').manualClose(body, {
                  getPane: async (pane) => (await hostRequest('get', { pane })).pane,
                  graceful: (request) => closeIdleSession(request, { closePolicy: { manual: true } }),
                  signal: (pane, signal) => hostRequest('kill', { pane, signal }),
                })
                : await closeIdleSession(body);
              broadcast(); return json(res, 200, result);
            }
            catch (e) { return json(res, e.status || 500, { error: e.message }); }
          }
          if (url.pathname === '/api/keys') {
            try { return json(res, 200, await sendSessionKeys(body)); }
            catch (e) {
              if (e instanceof InjectionError) return json(res, e.status, { error: e.message });
              return json(res, 502, { error: String(e && e.message || e).slice(0, 500) });
            }
          }
          if (url.pathname === '/api/reviewtick') {
            // No early busy return: withInjectionLock throws the same 429, and landing it
            // in the catch records the healthy skip the scheduler would.
            try {
              const result = await withInjectionLock(() => review.reviewTick(
                { ...reviewDeps, send: sendReviewerMessage },
                { force: Boolean(body.force) },
              ));
              review.recordTickOutcome(result);
              if (result.sent) broadcast();
              return json(res, 200, result);
            } catch (e) {
              review.recordTickError(e);
              if (e instanceof InjectionError) return json(res, e.status, { error: e.message, ...e.extra });
              return json(res, 502, { error: String(e && e.message || e).slice(0, 500) });
            }
          }
          if (url.pathname === '/api/stop') {
            runs.stopRun(body.id);
            return json(res, 200, { ok: true });
          }
          return json(res, 404, { error: 'not found' });
        } catch (e) {
          if (e instanceof keep.KeepError) return json(res, 400, { error: e.message });
          throw e;
        }
      }

      if (url.pathname === '/api/rundiff') {
        const diff = runs.readDiff(url.searchParams.get('id') || '');
        return json(res, diff === null ? 404 : 200, diff === null ? { error: 'no diff' } : { diff });
      }

      if (url.pathname === '/api/panes') {
        const panes = await listHostPanes({}, true);
        return json(res, 200, panes ? { panes, host: true } : { panes: [], host: false });
      } else if (url.pathname === '/') {
        // build the full body before writeHead so a failure can still send a clean 500
        const body = fs.readFileSync(path.join(WEB_ROOT, 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
      } else if (url.pathname === '/api/state') {
        const mobileView = url.searchParams.get('view');
        if (mobileView && !MOBILE_VIEWS.has(mobileView)) return json(res, 400, { error: `unknown mobile state view: ${mobileView}` });
        const panes = await listHostPanes(deps);
        await reviewQueue.reconcile({
          // Reconciliation may authorize a replacement launch after absence, so
          // it must bypass the dashboard host-list cache and inspect a complete list.
          inspectLaunch: (active) => inspectReviewQueueLaunch(active),
        });
        const state = buildState({ hostPanes: panes, dashboard: true });
        const enriched = await addHostSessionState(state, { ...deps, panes });
        let responseState;
        try {
          responseState = mobileView
            ? projectMobileState(enriched, mobileView, url.searchParams.get('id') || '')
            : wantsCompactState(req, url) ? compactState(enriched) : enriched;
        } catch (error) {
          if (error.status === 400) return json(res, 400, { error: error.message });
          throw error;
        }
        const body = JSON.stringify(responseState);
        await sendStateJson(req, res, body);
      } else if (url.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write('data: hello\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    } catch (e) {
      process.stderr.write(`keep serve: request failed: ${e.message}\n`);
      try {
        if (!res.headersSent) res.writeHead(e instanceof keep.KeepError ? 400 : 500, { 'content-type': 'text/plain' });
        res.end(`keep serve error: ${e.message}`);
      } catch {}
    }
  });

  keepConsole.install({
    server,
    hostClient: () => require('./hostclient.js').connect({ timeoutMs: HOST_CONNECT_TIMEOUT_MS }),
    hostRequest,
    isLocal,
    token,
    root: keep.ROOT,
  });

  server.listen(PORT, process.env.KEEP_HOST || '127.0.0.1', () => {
    console.log(`keep serve — http://localhost:${PORT}`);
  });
}

module.exports = {
  prepareSessionSummary, sessionSummarySnapshot,
  start,
  apiRequestAuthError,
  agentPromptVisible,
  typeOpeningMessage,
  isInjectionBusy,
  startAutoCompact,
  autoCompactIdleMs,
  autoCompactCandidates,
  autoCompactOutcome,
  compactSession,
  compactSwapPlan,
  ensureCompactionRestored,
  afterCompactAction,
  pendingCompactSwaps,
  readPendingCompactSwap,
  sweepPendingCompactSwaps,
  shutdownSettingsRepair,
  readClaudeSettingsModel,
  linesAfterLastEcho,
  modelSwitchConfirmed,
  modelSwitchDialogVisible,
  repairClaudeSettingsModel,
  pickNotifyTarget,
  pickDeliveryCandidates,
  checkDeliveryIds,
  deliverCheckToThread,
  shouldCompactFirst,
  lastTurnUsage,
  lastContextTokens,
  compactRefusal,
  compactCommand,
  chunkForTyping,
  deliveredMatches,
  exactDraft,
  closeDraftVisible,
  codexTypedTextVisible,
  claudeTypedTextVisible,
  closeIdleSession,
  restartSession,
  forceRestartSession,
  applyHostedExitState,
  closeExitedCodexShell,
  scanSessions,
  stalledSessionSnapshot,
  buildState,
  applySessionLiveness,
  backfillHostSessions,
  briefDue,
  startBriefScheduler,
  buildWhoSnapshot,
  scanTranscript,
  claudeSessionFromInfo,
  sessionBackgroundPending,
  stallAliveIds,
  claudeSessionFor,
  transcriptActivityMs,
  sessionNeedsInput,
  sessionTaskOwners,
  sessionAttentionItem,
  attentionAckKey,
  attentionItemKey,
  readSetAside,
  setAsideCandidates,
  applySetAside,
  parseSetAsideRequest,
  updateSetAside,
  classifyPromptLine,
  probeSuggestion,
  logDraftRefusal,
  sendPrecheck,
  SUGGESTION_PROBE_KEY,
  SUGGESTION_PROBE_MAX_READS,
  isHostTarget,
  hostClient,
  hostRequest,
  listHostPanes,
  readScreenResult,
  readScreen,
  writeTarget,
  pressTargetKey,
  typeAndSubmit,
  resolveSessionTarget,
  resolveSessionId, screenSession, sendSessionKeys, shellPaneTarget, stripTerminalAnsi, writeToShellPane,
  agentProcessRows, liveSessionPids, liveSessionTick, restorePlan,
  annotatePaneAgents,
  readPaneRecord, sessionProjectFromTranscript, openSession,
  launchReviewQueueSession, inspectReviewQueueLaunch, recoverReviewQueueLaunch,
  waitForHostAgent, waitForHostSessionId, addHostSessionState,
  sendToSession, sendToResolvedTarget, precheckSessionTarget, InjectionError,
  resumeAfterLimit,
};

if (require.main === module) start();
