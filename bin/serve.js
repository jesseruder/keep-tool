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
const { AsyncLocalStorage } = require('async_hooks');
const { promisify } = require('util');
const keep = require('./keep.js');
const runs = require('./runs.js');
const summarize = require('./summarize.js');
const titles = require('./titles.js');
const usage = require('./usage.js');
const cardUsage = require('./card-usage.js');
const codex = require('./codex.js');
const codexCompact = require('./codex-compact.js');
const transcripts = require('./transcripts.js');
const accounts = require('./accounts.js');
const review = require('./review.js');
const reviewQueue = require('./review-queue.js');
const who = require('./who.js');
const steps = require('./steps.js');
const alerts = require('./alerts.js');
const notifications = require('./notifications.js');
const reminders = require('./reminders.js');
const slack = require('./slack.js');
const discord = require('./discord.js');
const standup = require('./standup.js');
const ideas = require('./ideas.js');
const landed = require('./landed.js');
const unblock = require('./unblock.js');
const limitresume = require('./limitresume.js');
const health = require('./health.js');
const features = require('./features.js');
const stalled = require('./stalled.js');
const keepConsole = require('./console.js');
const sessionStatus = require('./session-status.js');
const { sendStateJson } = require('./state-response.js');
const { MOBILE_VIEWS, projectMobileState } = require('./mobile-state.js');
const { createScreenHistoryCache } = require('./screen-history.js');
const { createSettledSessionCache } = require('./settled-session-cache.js');

const PORT = parseInt(process.env.KEEP_PORT || '7777', 10);
const { PROJECTS_DIR, TAIL_BYTES, textOf, readTranscriptTail, findSessionFile } = transcripts;
const WEB_ROOT = path.join(__dirname, '..', 'web');
const SESSION_WINDOW_MS = 48 * 3600e3; // ignore transcripts older than this
const TURN_INDEX_BUDGET_MS = 150; // how long one turn-index tick may hold the event loop
const TURN_INDEX_BUDGET_BYTES = 8 * 1024 * 1024;
const TURN_INDEX_PRUNE_LIMIT = 200; // sessions dropped per daily sweep; it resumes next tick
// The live ledger keeps a week of sightings; only sessions seen alive recently can
// still be writing turns. The live tick refreshes sightings every two minutes. Two
// hours also leaves a session that stopped with a backlog ~240 ticks (1 MiB per file
// each) to finish being indexed.
const TURN_INDEX_LIVE_WINDOW_MS = 2 * 3600e3;
const TURN_INDEX_ROLLOUT_MISS_MS = 10 * 60e3; // how long a failed codex rollout lookup is trusted
const WATCHER_TURNS_PER_TICK = 5;
const WATCHER_CONCURRENCY = 2;
const WATCHER_WINDOW_MS = 2 * 3600e3; // a turn older than this is history, not a live decision
const claudeProjectRoots = accounts.projectRoots();
const claudeTranscriptIndex = require('./transcript-index').createMultiRootTranscriptIndex(claudeProjectRoots);
const {
  compactState, wantsCompactState, createJobChangeTracker, attachStateLines, shadowDecisionSummary,
  wantsLightweightState, lightweightState, dashboardDetail, reviewQueueSearch,
} = require('./dashboard-state');
const { createDashboardWorker } = require('./dashboard-worker');
const { createDashboardPublisher } = require('./dashboard-publisher');
const { createUiRequestWorker } = require('./ui-request-worker');
const { routes: buildRequestRoutes, matchRoute } = require('./serve/routes.js');
const { startSchedulers } = require('./serve/schedulers.js');
const execFileAsync = promisify(execFile);
const ATTENTION_KINDS = new Set(['question', 'plan', 'permission', 'complete', 'input', 'review', 'blocked', 'overdue', 'unblocked', 'health', 'stalled']);
const CODEX_DIALOG_MARKERS = [
  'Would you like to run the following command?',
  'Press enter to confirm or esc to cancel',
  'Do you trust the contents of this directory?',
  'Press enter to continue',
];
const CLAUDE_TRUST_MARKERS = [
  'Do you trust the contents of this directory?',
  'Do you trust the files in this folder?',
  'Yes, I trust this folder',
  'Quick safety check',
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
const SCREEN_HISTORY_LINES = 200;
const SCREEN_HISTORY_SCROLLBACK = 10000;
const screenHistoryCache = createScreenHistoryCache();
const COMPANION_SNAPSHOT_MS = 1000;
let companionSnapshotCache = { at: 0, value: null, pending: null };
// A frozen or non-advancing clock must not spin the poll loop forever.
const SUGGESTION_PROBE_MAX_READS = Math.ceil(SUGGESTION_PROBE_MAX_MS / SUGGESTION_PROBE_WAIT_MS) + 1;

function messageWatcherDashboardState() {
  // A feature that is off looks to the console exactly like one that has never
  // polled: same keys, no stored state read.
  const slackState = features.dashboardState('slack', () => slack.dashboardState());
  const discordState = features.dashboardState('discord', () => discord.dashboardState());
  const recent = [...(slackState.recent || []), ...(discordState.recent || [])]
    .sort((a, b) => Number(a.at || 0) - Number(b.at || 0))
    .slice(-10);
  return {
    ...slackState,
    slackLastPollAt: slackState.lastPollAt || null,
    lastPollAt: Math.max(Number(slackState.lastPollAt || 0), Number(discordState.lastPollAt || 0)) || null,
    discord: discordState,
    recent,
  };
}

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
  return entry && ['dismiss', 'snooze', 'dependency', 'running'].includes(entry.kind)
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
    // "Mark running" overrides a misread status until the session gets a new
    // message; a newer attention event or a gone session also clears it below.
    if (entry.kind === 'running') {
      if (Number.isFinite(item?.lastUserAt) && item.lastUserAt > entry.at) {
        changed = true;
        continue;
      }
      // A synthetic candidate's since is the transcript mtime, which background
      // work keeps moving; only a real attention event counts as a new turn.
      if (item?.synthetic) {
        items[key] = entry;
        continue;
      }
    }
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
  if (!['dismiss', 'snooze', 'dependency', 'running', 'clear'].includes(body.kind)
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
const dashboardSessionSources = new WeakMap();
function associateDashboardSessionFiles(state, targets, store = dashboardSessionSources) {
  const files = new Map((targets || [])
    .filter((target) => target?.agent && target?.sid && target?.file)
    .map((target) => [`${target.agent}:${target.sid}`, target.file]));
  for (const session of state?.sessions || []) {
    const file = files.get(`${session.kind}:${session.id}`);
    if (file) store.set(session, file);
  }
  return state;
}
function sessionSummaryFile(session, deps = {}) {
  const published = session && dashboardSessionSources.get(session);
  if (published) return published;
  if (deps.publishedOnly) return null;
  const reader = deps.codex || codex;
  return session && (session.kind === 'codex'
    ? reader.rolloutFileFor(session.id) || reader.findRolloutFile(session.id)
    : (deps.findSessionFile || findSessionFile)(session.id));
}
function prepareSessionSummary(session, options = {}, deps = {}) {
  const file = deps.file || sessionSummaryFile(session, deps);
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
  const state = await (deps.dashboardBuild || deps.buildState || buildState)({ hostPanes: panes, dashboard: true });
  return { sessions: state.sessions, panes };
}
const WEEKLY_INSTRUCTION = "Summarize what this solo developer completed in the last week. Group related work into 3-6 themed bullets and note anything notable that shipped. Be specific; output only the summary.";
const TAG_INSTRUCTION = "These tasks share a theme/tag. In 2-3 sentences describe the common thread and what's blocking or driving progress across them. Output only that.";
let onChange = () => {};
let onFocus = () => {};
let sweepInFlight = false;
let inFlightSwap = null;
const daemonRestartGate = require('./daemon-restart').createGate({
  pending: () => {
    try { return fs.readdirSync(autoCompactDir()).filter(name => name.endsWith('.swap.json')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  },
  busy: () => sweepInFlight || injectionLocked(),
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

async function companionSnapshot(deps = {}) {
  const discover = deps.discoverCodexJobs || ((options) => require('./codexjobs').list(options));
  const now = typeof deps.now === 'function' ? Number(deps.now()) : Number(deps.now ?? Date.now());
  // Injected discovery is request scoped and must not share production cache state.
  if (deps.discoverCodexJobs) return discover({ root: deps.root || keep.ROOT, fallbackCacheMs: COMPANION_SNAPSHOT_MS }, deps);
  if (companionSnapshotCache.value && now - companionSnapshotCache.at < COMPANION_SNAPSHOT_MS) return companionSnapshotCache.value;
  if (companionSnapshotCache.pending) return companionSnapshotCache.pending;
  companionSnapshotCache.pending = discover({ root: deps.root || keep.ROOT, fallbackCacheMs: COMPANION_SNAPSHOT_MS })
    .then((value) => {
      companionSnapshotCache = { at: Date.now(), value, pending: null };
      return value;
    }, (error) => {
      companionSnapshotCache.pending = null;
      throw error;
    });
  return companionSnapshotCache.pending;
}

function applyCompanionJobs(sessions, companion) {
  const known = companion?.known ?? (companion?.discovery && companion.discovery !== 'unknown');
  if (!known) return sessions;
  const byOwner = new Map();
  for (const job of companion.jobs || []) {
    if (!job) continue;
    const state = job.state || job.status;
    if (!job.id || !['running', 'queued', 'stalled'].includes(state) || typeof job.sessionId !== 'string' || !job.sessionId) continue;
    if (!byOwner.has(job.sessionId)) byOwner.set(job.sessionId, []);
    byOwner.get(job.sessionId).push({
      id: String(job.id), kind: 'companion', status: 'pending', recurring: false,
      startedAt: stalled.timeMs(job.startedAt || job.createdAt), expiresAt: null, current: true,
    });
  }
  for (const session of sessions || []) {
    const owned = byOwner.get(session.id);
    if (!owned?.length) continue;
    const background = session.backgroundJobs || {
      jobs: [], uncertain: [], caughtUp: true, turnStartedAt: session.turnStartedAt || 0,
    };
    const companionIds = new Set(owned.map((job) => job.id));
    session.backgroundJobs = {
      ...background,
      jobs: [...(background.jobs || []).filter((job) => !companionIds.has(String(job.id))), ...owned],
      pending: true,
    };
    session.pendingBackground = true;
  }
  return sessions;
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

const { isClaudeInterruption } = require('./restart-evidence');

const interactiveMarkerCache = new Map();
const INTERACTIVE_MARKER_CACHE_MAX = 2048;
const INTERACTIVE_MARKER_LINE_MAX = 64 * 1024;

function cacheInteractiveMarker(key, value) {
  if (interactiveMarkerCache.has(key)) interactiveMarkerCache.delete(key);
  interactiveMarkerCache.set(key, value);
  if (interactiveMarkerCache.size > INTERACTIVE_MARKER_CACHE_MAX) {
    interactiveMarkerCache.delete(interactiveMarkerCache.keys().next().value);
  }
}

function transcriptHasInteractiveMarker(file, stat, includeSidechain = false) {
  const cacheKey = `${includeSidechain ? 'all' : 'main'}:${file}`;
  const cached = interactiveMarkerCache.get(cacheKey);
  const sameFile = cached && cached.dev === stat.dev && cached.ino === stat.ino;
  if (sameFile && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    cacheInteractiveMarker(cacheKey, cached);
    return cached.interactive;
  }
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  let carry = Buffer.alloc(0);
  let discardPartial = false;
  let offset = 0;
  let interactive = false;
  try {
    while (true) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (!bytes) break;
      offset += bytes;
      const chunk = buffer.subarray(0, bytes);
      let lineStart = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 10) continue;
        if (discardPartial) {
          discardPartial = false;
          carry = Buffer.alloc(0);
          lineStart = i + 1;
          continue;
        }
        const suffix = chunk.subarray(lineStart, i);
        const line = carry.length ? Buffer.concat([carry, suffix]) : suffix;
        let record;
        try { record = JSON.parse(line.toString('utf8')); } catch { lineStart = i + 1; carry = Buffer.alloc(0); continue; }
        lineStart = i + 1;
        carry = Buffer.alloc(0);
        if (record?.isSidechain && !includeSidechain) continue;
        if (record?.type === 'mode' || record?.type === 'permission-mode') {
          interactive = true;
          break;
        }
      }
      if (interactive) break;
      const suffix = chunk.subarray(lineStart);
      if (!discardPartial && suffix.length) {
        if (carry.length + suffix.length <= INTERACTIVE_MARKER_LINE_MAX) {
          carry = carry.length ? Buffer.concat([carry, suffix]) : Buffer.from(suffix);
        } else {
          carry = Buffer.alloc(0);
          discardPartial = true;
        }
      }
    }
    if (!interactive && !discardPartial && carry.length) {
      try {
        const record = JSON.parse(carry.toString('utf8'));
        interactive = (!record?.isSidechain || includeSidechain)
          && (record?.type === 'mode' || record?.type === 'permission-mode');
      } catch {}
    }
    cacheInteractiveMarker(cacheKey, {
      dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, interactive,
    });
    return interactive;
  } finally {
    fs.closeSync(fd);
  }
}

function claudeTranscriptIsInteractive(file, info, stat) {
  if (info.interactive) return true;
  // Long transcripts can push the startup marker outside the parsed tail. Scan
  // changed ambiguous history from the beginning and stop at the first marker.
  // This also retains a headless transcript after it is explicitly resumed in
  // the TUI and its resume marker later leaves the tail.
  if (stat.size <= TAIL_BYTES) return false;
  try { return transcriptHasInteractiveMarker(file, stat); } catch { return false; }
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
      const interrupted = isClaudeInterruption(j);
      if (interrupted) {
        // Claude records a human cancellation as a synthetic user row even
        // though its foreground turn is over. Keep independently observed
        // tool and background obligations; only settle the foreground.
        out.exited = false;
        out.rateLimit = null;
        lastRealEvent = 'interrupted';
        lastStopReason = null;
        exitCommand = false;
        continue;
      }
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
  out.endedTurn = pending.size === 0 && (lastRealEvent === 'interrupted'
    || (lastRealEvent === 'assistant' && (lastStopReason === 'end_turn' || (lastStopReason === null && lastAssistantHadText))));
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
      const state = scanChildTranscript(child);
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

// Injection is serialized per pane, not daemon-wide: a four-minute compaction of one
// session must not turn every other pane's send into a 429. A holder claims keys:
//   pane:<id>     the terminal pane it reads the prompt of and types into.
//   session:<id>  a conversation whose pane is resolved inside the lock. The holder
//                 claims the resolved pane (claimInjectionTarget) before any precheck
//                 or keystroke, so precheck and typing stay atomic for that pane.
//   model         settings.json's model and the in-flight compaction swap, shared by
//                 every Claude session: compactions, model restores, agent launches.
// A call with no scope takes the global lock, which excludes every holder and is
// excluded by any; keep global holders short. Nested calls in the same async context
// are reentrant: they claim only what the holder lacks and release that on return.
const injectionHolders = new Map(); // key -> holder
let injectionGlobalHolder = null;
const injectionContext = new AsyncLocalStorage();

function injectionBusyError() {
  return new InjectionError(429, 'another session injection is busy');
}

function injectionLocked() {
  return Boolean(injectionGlobalHolder) || injectionHolders.size > 0;
}

// Work started under a lock can outlive it (a fire-and-forget promise inherits the
// context), so a released holder never counts as the caller's own.
function activeInjectionHolder() {
  const holder = injectionContext.getStore();
  return holder && holder.active ? holder : null;
}

function injectionScopeKeys(scope) {
  const keys = [];
  if (scope.pane != null && scope.pane !== '') keys.push(`pane:${scope.pane}`);
  if (scope.session != null && scope.session !== '') keys.push(`session:${scope.session}`);
  if (scope.model) keys.push('model');
  return keys;
}

// Check and take in one synchronous step, so no other holder interleaves.
function takeInjectionKeys(holder, keys) {
  if (holder.global) return [];
  if (injectionGlobalHolder) throw injectionBusyError();
  const wanted = [...new Set(keys)].filter((key) => injectionHolders.get(key) !== holder);
  if (wanted.some((key) => injectionHolders.has(key))) throw injectionBusyError();
  for (const key of wanted) injectionHolders.set(key, holder);
  return wanted;
}

function takeInjectionGlobal(holder) {
  if (holder.global) return false;
  if (injectionGlobalHolder) throw injectionBusyError();
  for (const owner of injectionHolders.values()) if (owner !== holder) throw injectionBusyError();
  injectionGlobalHolder = holder;
  holder.global = true;
  return true;
}

async function withInjectionLock(fn, scope) {
  const outer = activeInjectionHolder();
  if (!outer && daemonRestartGate.stopping) throw new InjectionError(429, 'daemon restart is pending');
  const holder = outer || { active: true, global: false };
  let taken = [];
  let tookGlobal = false;
  if (scope == null) tookGlobal = takeInjectionGlobal(holder);
  else taken = takeInjectionKeys(holder, injectionScopeKeys(scope));
  try {
    return outer ? await fn() : await injectionContext.run(holder, fn);
  } finally {
    if (outer) {
      for (const key of taken) injectionHolders.delete(key);
      if (tookGlobal) { injectionGlobalHolder = null; holder.global = false; }
    } else {
      holder.active = false;
      for (const [key, owner] of injectionHolders) if (owner === holder) injectionHolders.delete(key);
      if (injectionGlobalHolder === holder) injectionGlobalHolder = null;
    }
  }
}

// A session-scoped holder learns its pane only once it resolves the session: claim
// that pane before reading its prompt or typing, until the holder releases. Outside
// any lock (a unit test's stub lock) there is nothing to claim against.
function claimInjectionTarget(target) {
  const holder = activeInjectionHolder();
  if (holder && isHostTarget(target)) takeInjectionKeys(holder, [`pane:${target.pane}`]);
  return target;
}

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// Comparison only, and never applied to text on its way to a terminal: a message
// typed in one Unicode spelling and echoed back in the other is the same message,
// so the receipt has to see it that way.
function canonicalText(value) {
  const text = normalizedText(value);
  try { return text.normalize('NFC'); } catch { return text; }
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
  let result = { contextTokens: 0, model: '', usageAt: null, cacheTtlMs: null };
  let sawClaudeUsage = false;
  let claudeCacheTtlMs = null;
  let claudeCacheTtlModel = '';
  let codexModel = '';
  let codexUsageResult = null;
  let codexTokenCountResult = null;
  const latestBoundary = kind === 'claude' ? records.map((line) => {
    try { return typeof line === 'string' ? JSON.parse(line) : line; } catch { return null; }
  }).filter((record) => record?.type === 'system' && record.subtype === 'compact_boundary'
    && Number.isFinite(Date.parse(record.timestamp))).at(-1) : null;
  const boundaryAt = latestBoundary ? Date.parse(latestBoundary.timestamp) : null;
  let boundaryModelAt = -Infinity;
  if (latestBoundary) {
    result.contextTokens = Number(latestBoundary.compactMetadata?.postTokens) || 0;
    result.usageAt = boundaryAt;
  }
  for (const line of records) {
    let record;
    try { record = typeof line === 'string' ? JSON.parse(line) : line; } catch { continue; }
    if (kind === 'claude' && record && !record.isSidechain && record.type === 'assistant'
        && record.message && record.message.usage) {
      const recordAt = Date.parse(record.timestamp);
      if (boundaryAt && (!Number.isFinite(recordAt) || recordAt <= boundaryAt)) {
        if (Number.isFinite(recordAt) && recordAt >= boundaryModelAt) {
          result.model = String(record.message.model || '');
          boundaryModelAt = recordAt;
        }
        continue;
      }
      const usage = record.message.usage;
      let contextTokens = Number(usage.input_tokens || 0) + Number(usage.cache_creation_input_tokens || 0)
        + Number(usage.cache_read_input_tokens || 0);
      if (!Number.isFinite(contextTokens)) contextTokens = 0;
      const cacheCreation = usage.cache_creation || {};
      const hasFiveMinute = Number(cacheCreation.ephemeral_5m_input_tokens || 0) > 0;
      const hasOneHour = Number(cacheCreation.ephemeral_1h_input_tokens || 0) > 0;
      const model = String(record.message.model || '');
      const inferredTtlMs = hasFiveMinute ? 5 * 60e3 : hasOneHour ? 60 * 60e3 : null;
      if (inferredTtlMs) {
        claudeCacheTtlMs = inferredTtlMs;
        claudeCacheTtlModel = model;
      } else if (claudeCacheTtlModel !== model) {
        claudeCacheTtlMs = null;
        claudeCacheTtlModel = model;
      }
      result = {
        contextTokens,
        model,
        usageAt: Date.parse(record.timestamp) || null,
        cacheTtlMs: claudeCacheTtlMs,
      };
      sawClaudeUsage = true;
    } else if (kind === 'claude' && !latestBoundary && sawClaudeUsage && record && record.type === 'system'
        && record.subtype === 'compact_boundary') {
      result.contextTokens = Number(record.compactMetadata && record.compactMetadata.postTokens) || 0;
    } else if (kind === 'codex' && record && record.type === 'session_meta') {
      codexModel = String(record.payload?.base_instructions?.provenance?.model || codexModel);
    } else if (kind === 'codex' && record && record.type === 'turn_context') {
      codexModel = String(record.payload?.model || codexModel);
    } else if (kind === 'codex' && record && record.type === 'event_msg'
        && record.payload?.type === 'thread_settings_applied') {
      codexModel = String(record.payload.thread_settings?.model || codexModel);
    } else if (kind === 'codex' && record?.type === 'token_usage_record' && record.payload?.usage) {
      const usage = record.payload.usage;
      const contextTokens = Number(usage.input_tokens || 0);
      if (Number.isFinite(contextTokens) && contextTokens > 0) {
        codexUsageResult = {
          contextTokens,
          model: codexModel,
          usageAt: Date.parse(record.timestamp) || null,
          cacheTtlMs: null,
        };
      }
    } else if (kind === 'codex' && record?.type === 'compacted') {
      // The matched usage in this row is the cost of producing the summary, not
      // the smaller context after replacement. Hold at zero until a later real
      // request supplies the new context; bookkeeping token_count rows can lag.
      codexUsageResult = {
        contextTokens: 0,
        model: codexModel,
        usageAt: Date.parse(record.timestamp) || null,
        cacheTtlMs: null,
      };
    } else if (kind === 'codex' && record && record.type === 'event_msg' && record.payload
        && record.payload.type === 'token_count' && record.payload.info && record.payload.info.last_token_usage) {
      const usage = record.payload.info.last_token_usage;
      // Codex input_tokens already includes cached_input_tokens.
      let contextTokens = Number(usage.input_tokens || 0);
      if (!Number.isFinite(contextTokens)) contextTokens = 0;
      codexTokenCountResult = {
        contextTokens,
        model: codexModel,
        usageAt: Date.parse(record.timestamp) || null,
        cacheTtlMs: null,
      };
    }
  }
  if (kind === 'codex') {
    result = codexUsageResult || codexTokenCountResult || result;
    if (codexModel && result.usageAt && codexModel !== result.model) {
      result = { ...result, model: codexModel, usageAt: null };
    } else if (codexModel) result.model = codexModel;
  }
  return result;
}

// Claude writes quota and API failures as synthetic assistant records. They can
// carry usage and therefore legitimately remain the newest accounting record, but
// their model is not a launch setting. Keep model selection separate from usage
// accounting. Preserve malformed genuine values so the handoff's existing model
// validator still fails closed instead of falling back past them. A synthetic-only
// tail returns an invalid sentinel so the handoff is refused rather than trusting
// launch metadata that an in-session model switch may have made stale.
function lastClaudeHandoffModel(lines) {
  const records = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  let model = '';
  let sawSynthetic = false;
  for (const line of records) {
    let record;
    try { record = typeof line === 'string' ? JSON.parse(line) : line; } catch { continue; }
    if (!record || record.type !== 'assistant' || record.isSidechain || !record.message) continue;
    const candidate = typeof record.message.model === 'string' ? record.message.model : '<unknown>';
    if (record.isApiErrorMessage || candidate === '<synthetic>') { sawSynthetic = true; continue; }
    if (!record.message.usage) continue;
    model = candidate || '<unknown>';
  }
  if (model || !sawSynthetic) return model;
  return '<unknown>';
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

// A timed-out host request leaves listHostPanes null. Publishing that as zero panes
// strips every session's liveness, so Waiting on you empties and sessions flash into
// Running & waiting. Reuse the last good list briefly. With no good list yet (a fresh
// daemon, or no host at all) publish as before rather than holding the dashboard.
const HOST_PANES_REUSE_MS = 60e3;

// Writes a console waits on through its mutation fence rebuild the dashboard at once;
// every other write (project icons, UI debug, terminal profiles, keys) waits out the
// background rebuild throttle. Mirrors STATE_MUTATIONS in web/app/api.js.
const URGENT_DASHBOARD_MUTATIONS = new Set([
  '/api/abandon-account-handoff', '/api/ack', '/api/add', '/api/answer', '/api/checkin',
  '/api/close-idle', '/api/close-session', '/api/compact', '/api/decisions/judge',
  '/api/handoff-session', '/api/notifications', '/api/open', '/api/panes/spawn',
  '/api/portable-transfers', '/api/reminders', '/api/reopen-session', '/api/resolve-portable-transfer',
  '/api/restart-daemon', '/api/restart-session', '/api/review-queue', '/api/reviewtick',
  '/api/run', '/api/send', '/api/setaside', '/api/transfer-session',
]);
function urgentDashboardMutation(pathname) {
  return URGENT_DASHBOARD_MUTATIONS.has(pathname) || /^\/api\/panes\/[^/]+\/(?:kill|remove)$/.test(pathname);
}
// `epoch` is memo.epoch as it was when the lookup began: a mutation bumps it, so a list
// collected before the mutation is neither remembered nor reused for a later build.
function hostPanesForPublish(panes, memo, now, epoch = memo.epoch || 0) {
  const current = epoch === (memo.epoch || 0);
  if (Array.isArray(panes)) {
    if (current) {
      memo.panes = panes;
      memo.at = now;
    }
    return panes;
  }
  if (current && memo.panes && now - memo.at < HOST_PANES_REUSE_MS) return memo.panes;
  return panes;
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

// The bottom of Claude's input box. Its rules span the pane, and the box is the
// only thing on screen drawn with them below a prompt glyph.
const BOX_RULE_RE = /^\s*[─━]{3,}/;

// The whole draft, from the prompt glyph that opens the input box down to the
// rule that closes it — blank lines and further glyphs included, because both
// are things a person can type into a multi-line draft and neither ends it.
// Reading only as far as the first blank line is what let
// `❯ ours` / blank / `theirs` / rule compare as exactly ours.
//
// Returns null when the box cannot be read with confidence, which every caller
// treats as "not ours": refusing is always safe, and clearing or submitting a
// box this could not parse is not.
function draftRegionLines(screen, kind) {
  const lines = stripTerminalAnsi(String(screen || '')).split(/\r?\n/);
  const prompt = kind === 'codex' ? /^\s*›(?:\s|$)/ : /^\s*❯(?:\s|$)/;
  // The bottom of the box, found from the bottom of the screen: the input box is
  // the last one there, and an echoed prompt above it belongs to a turn that is
  // already over. Claude closes its box with a rule. Codex has none, so its
  // composer is read as everything above the last blank-separated block, which is
  // the status line under it.
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (kind !== 'codex' && BOX_RULE_RE.test(lines[i]) && lines.slice(0, i).some((line) => prompt.test(line))) {
      end = i;
      break;
    }
    if (prompt.test(lines[i])) { end = codexComposerEnd(lines, i, kind); break; }
  }
  if (end === -1) return null;
  // The top of the box: the *first* glyph line inside it, so a second glyph typed
  // into a draft is content rather than the start of a new one.
  let start = -1;
  for (let i = end - 1; i >= 0; i -= 1) {
    if (BOX_RULE_RE.test(lines[i])) break;
    if (prompt.test(lines[i])) start = i;
  }
  if (start === -1) return null;
  const region = lines.slice(start, end);
  region[0] = region[0].replace(prompt, '');
  return { lines: region, width: Math.max(0, ...lines.map((line) => line.length)) };
}

// Where a Codex composer ends: above the last blank-separated block on screen,
// which is its status line. With no blank line below the glyph there is no status
// line either, and the composer runs to the bottom.
function codexComposerEnd(lines, promptLine, kind) {
  if (kind !== 'codex') return lines.length;
  for (let i = lines.length - 1; i > promptLine; i -= 1) {
    if (!lines[i].trim()) return i;
  }
  return lines.length;
}

// The draft as one string. A line the terminal wrapped mid-word has to join
// back into that word: the pane's width is the widest line on screen, and a line
// that reached it was cut rather than ended (the host trims trailing spaces, so a
// line that ended on one is shorter than the pane).
function draftRegionText(screen, kind) {
  const region = draftRegionLines(screen, kind);
  if (!region) return null;
  let out = '';
  region.lines.forEach((line, index) => {
    if (index === 0) { out = line; return; }
    const previous = region.lines[index - 1];
    const rendered = index === 1 ? previous.length + 2 : previous.length; // the glyph and its space
    // A composer indents the continuation of a cut line under the glyph. That
    // indent is the renderer's, not the message's, so it goes when the word is
    // joined back together; a soft-wrapped line keeps it, and canonicalText folds
    // it into the one space the wrap replaced.
    if (region.width && rendered >= region.width) out += line.replace(/^ {1,2}/, '');
    else out += ` ${line}`;
  });
  return canonicalText(out);
}

// True only when the box holds exactly the message that was typed and nothing
// else. Containment is not enough: Owner typing while the watcher types leaves a
// box that contains our message and says something neither of us meant. Compared
// in NFC, because a terminal may echo back the other spelling of the same text.
function draftIsExactly(screen, text, kind) {
  const draft = draftRegionText(screen, kind);
  return draft !== null && draft === canonicalText(text);
}

// Escape clears a non-empty Claude/Codex input box — but only ever *our* draft.
// If Owner has typed into the pane since, the box is his now: erasing it would
// destroy text nobody asked us to touch, so the draft is left exactly as found
// and the caller is told why.
async function discardTypedDraft(target, text, kind, deps = {}) {
  const read = deps.readScreen || ((t, lines, scrollback) => readScreen(t, lines, scrollback, deps));
  const write = deps.stderr || process.stderr.write.bind(process.stderr);
  const pane = (target && target.pane) || 'unknown';
  let screen = '';
  try {
    screen = await read(target, deps.confirmationLines === undefined ? 30 : deps.confirmationLines, false);
  } catch (error) {
    write(`keep serve: could not read pane ${pane} to clear an aborted draft: ${String((error && error.message) || error)}\n`);
    return { cleared: false, reason: 'unreadable screen' };
  }
  if (!draftIsExactly(screen, text, kind)) {
    write(`keep serve: left an aborted draft on pane ${pane}: the input box no longer holds only the typed message\n`);
    return { cleared: false, reason: 'mixed draft' };
  }
  try {
    await pressTargetKey(target, 'Escape', deps);
  } catch (error) {
    write(`keep serve: could not clear an aborted draft on pane ${pane}: ${String((error && error.message) || error)}\n`);
    return { cleared: false, reason: 'escape failed' };
  }
  // Escape is a keystroke, not a guarantee. Read the box back: "cleared" is a
  // claim about the session, so it is only made when the box is actually empty.
  let after = '';
  try {
    after = await read(target, deps.confirmationLines === undefined ? 30 : deps.confirmationLines, false);
  } catch (error) {
    write(`keep serve: could not confirm the cleared draft on pane ${pane}: ${String((error && error.message) || error)}\n`);
    return { cleared: false, reason: 'unconfirmed clear' };
  }
  if (draftRegionText(after, kind) !== '') {
    write(`keep serve: the draft on pane ${pane} is still there after Escape\n`);
    return { cleared: false, reason: 'still there' };
  }
  return { cleared: true, reason: null };
}

// Marks a failure as one that happened with characters already written to the
// pane. Read by bin/watcher-live.js, which may only give a delivery slot back
// when nothing was typed: an unconfirmed send is still a send.
function typedAlready(error) {
  if (error && typeof error === 'object') error.typingStarted = true;
  return error;
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
    throw typedAlready(new InjectionError(409, 'message was typed but could not be confirmed; Enter was not pressed', {
      screenTail: screenTail(confirmation),
    }));
  }
  if (deps.beforeEnter) {
    try {
      await deps.beforeEnter(target);
    } catch (error) {
      // The text is in the box and Enter has not been pressed. Callers that
      // typed on nobody's behalf (the watcher) ask for the draft to be cleared,
      // because a draft nobody typed is worse than no message at all. Session
      // cleanup keeps its typed /exit on screen, as it always has, so Owner can
      // see what was about to happen.
      const discard = deps.discardDraftOnAbort
        ? await discardTypedDraft(target, text, deps.draftKind, deps)
        : { cleared: false, reason: 'not requested' };
      deps.deliveryTrace?.('enter-aborted', { cleared: discard.cleared, reason: discard.reason });
      if (deps.discardDraftOnAbort && !discard.cleared && error && typeof error === 'object') {
        error.draftLeftOnScreen = true;
        error.draftReason = discard.reason;
      }
      throw typedAlready(error);
    }
  }
  // Last of all, and deliberately after beforeEnter rather than before it:
  // confirmation above asks whether the typed text is visible, this asks whether
  // it is the *only* thing in the box, and every millisecond between the two is
  // one in which Owner can start typing. Callers that type unprompted (the
  // watcher) demand exactness; a human-initiated send keeps the older, looser
  // check it has always had.
  if (deps.requireExactDraft) {
    let exactScreen = '';
    try {
      exactScreen = await read(target, deps.confirmationLines === undefined ? 30 : deps.confirmationLines, false);
    } catch { exactScreen = ''; }
    if (!draftIsExactly(exactScreen, text, deps.draftKind)) {
      deps.deliveryTrace?.('draft-not-exact');
      // Nothing is pressed and nothing is cleared: the box holds text this did
      // not write, and touching it is not this code's decision to make.
      throw typedAlready(new InjectionError(409, 'the input box no longer holds only the typed message; Enter was not pressed', {
        screenTail: screenTail(exactScreen), draftLeftOnScreen: true,
      }));
    }
  }
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
  return canonicalText(content) === canonicalText(text);
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
  for (const line of String(text || '').split(/\r?\n/)) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (kind === 'codex' && (record?.type === 'compacted'
        || (record?.type === 'event_msg' && record.payload?.type === 'item_completed'
          && record.payload.item?.type === 'ContextCompaction'))) return true;
    if (record && record.type === 'system' && record.subtype === 'compact_boundary') return true;
  }
  return false;
}

function compactRequestTelemetry(text, kind, submittedAt) {
  const records = String(text || '').split(/\r?\n/).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  if (kind === 'codex') {
    const compacted = records.filter((record) => record.type === 'compacted'
      && (!submittedAt || Date.parse(record.timestamp) >= submittedAt)).at(-1);
    const payload = compacted && compacted.payload;
    const latest = payload && payload.latest_token_usage_record;
    const usage = latest && latest.response_id === payload.compaction_response_id ? latest.usage : null;
    return { usage: usage || null, compactMetadata: null };
  }
  const boundary = records.filter((record) => record.type === 'system'
    && record.subtype === 'compact_boundary'
    && (!submittedAt || Date.parse(record.timestamp) >= submittedAt)).at(-1);
  const seen = new Set();
  const usages = [];
  for (const record of records) {
    if (record.type !== 'assistant' || !record.message?.usage) continue;
    if (submittedAt && Date.parse(record.timestamp) < submittedAt) continue;
    if (boundary && Date.parse(record.timestamp) > Date.parse(boundary.timestamp)) continue;
    const identity = record.requestId ? `request:${record.requestId}`
      : record.message.id ? `message:${record.message.id}` : '';
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    usages.push(record.message.usage);
  }
  if (!usages.length) return { usage: null, compactMetadata: boundary?.compactMetadata || null };
  const fields = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
  const usage = Object.fromEntries(fields.map((field) => [field,
    usages.reduce((sum, item) => sum + (Number(item[field]) || 0), 0)]));
  return { usage, compactMetadata: boundary?.compactMetadata || null };
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

function compactScreenConfirmed(screen, command) {
  const after = linesAfterLastEcho(screen, command);
  const completeAt = after.findLastIndex((line) => /(?:Compacted|Conversation compacted|Conversation recap|Not enough messages to compact)/i.test(line));
  return completeAt !== -1
    && after.slice(completeAt + 1).some((line) => /^❯\s*$/.test(line))
    && !/esc to (?:interrupt|cancel)|Compacting[.…]/i.test(screen);
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
    const settingsRecord = records.filter((record) => !record.error && !codexCompact.isCodexCompactSwap(record))
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
        }, { model: true });
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
      if (codexCompact.isCodexCompactSwap(record)) {
        try {
          const recoverCodexCompactSwap = deps.recoverCodexCompactSwap || codexCompact.recoverCodexCompactSwap;
          const recovered = await lock(() => recoverCodexCompactSwap(record, {
            ...deps,
            session,
            dir,
            scanSessions: scan,
            resolveSessionTarget: async (current) => claimInjectionTarget(await resolve(current, null, deps)),
            readScreen: read,
            typeAndSubmit: submit,
            pressTargetKey,
            writeTarget: deps.writeTarget || writeTarget,
            codexSendPrecheck,
            codexTypedTextVisible,
            transcriptFileForSession,
          }), { session: record.sessionId, model: true });
          if (recovered.restored) summary.restored += 1;
          else summary.skipped += 1;
        } catch (e) {
          summary.skipped += 1;
          process.stderr.write(`keep serve: CODEX MODEL RESTORE UNCONFIRMED for session ${sid}: ${String(e && e.message || e)}\n`);
        }
        continue;
      }
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
          const target = claimInjectionTarget(await resolve(current, null, deps));
          if (current.localCommandPending) {
            const screen = await read(target, 30, false);
            const complete = /^\/compact(?:\s|$)/.test(current.localCommandPending)
              ? compactScreenConfirmed(screen, current.localCommandPending)
              : modelSwitchConfirmed(screen, current.localCommandPending)
                && Boolean(promptLine(screen))
                && !/esc to (?:interrupt|cancel)/i.test(screen);
            if (!complete) return null;
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
        }, { session: record.sessionId, model: true });
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

// The model recorded on a host pane's meta by `keep open --model`, or '' when the pane
// was launched without one (or is not a host pane at all).
async function hostPaneModel(target, deps = {}) {
  const id = target && target.pane;
  if (!id) return '';
  let panes = [];
  try { panes = await listHostPanes(deps) || []; } catch { return ''; }
  const pane = panes.find((candidate) => candidate && candidate.id === id);
  const model = pane && pane.meta && pane.meta.model;
  return typeof model === 'string' && keep.LAUNCH_MODEL_RE.test(model) ? model : '';
}

// The whole compaction, model restore included, holds its pane (so no send lands
// mid-compaction or on the swapped model) and the model key (inFlightSwap and
// settings.json are shared, so compactions still run one at a time). It does
// not hold any other pane.
async function compactSession(session, target, instruction, deps = {}) {
  const leave = daemonRestartGate.enter();
  try {
    return await (deps.withInjectionLock || withInjectionLock)(
      () => {
        const policy = deps.compactionPolicy || null;
        const compactCodexFallback = deps.compactCodexFallback || codexCompact.compactCodexFallback;
        if (session?.kind === 'codex' && policy?.path === 'cold-fallback') {
          return compactCodexFallback(session, target, instruction, {
            ...deps,
            dir: deps.dir || autoCompactDir(),
            readScreen: deps.readScreen || ((t, lines, scrollback) => readScreen(t, lines, scrollback, deps)),
            typeAndSubmit: deps.typeAndSubmit || typeAndSubmit,
            pressTargetKey: deps.pressTargetKey || pressTargetKey,
            writeTarget: deps.writeTarget || writeTarget,
            codexSendPrecheck,
            codexTypedTextVisible,
            transcriptFileForSession: deps.transcriptFileForSession || transcriptFileForSession,
            compactCurrentModel: () => compactSessionTransaction(session, target, instruction, deps),
          });
        }
        return compactSessionTransaction(session, target, instruction, deps);
      },
      { pane: isHostTarget(target) ? target.pane : null, model: true },
    );
  }
  finally { leave(); }
}

async function compactSessionTransaction(session, target, instruction, deps = {}) {
  const sid = String(session && session.id || 'unknown').slice(0, 8);
  process.stderr.write(`keep serve: compacting ${session && session.kind || 'unknown'} session ${sid}\n`);
  const dir = deps.dir || autoCompactDir();
  const lastTurn = (deps.sessionLastTurn || sessionLastTurn)(session);
  const policy = deps.compactionPolicy || null;
  const pendingRecordValue = session?.kind === 'claude' ? readPendingCompactSwap(session && session.id, dir) : null;
  const pendingRecord = codexCompact.isCodexCompactSwap(pendingRecordValue) ? null : pendingRecordValue;
  const configuredVia = envString('KEEP_COMPACT_VIA_MODEL', 'opus');
  const settingsSnapshot = session && session.kind === 'claude' && policy?.path !== 'warm-current'
    ? (deps.readClaudeSettingsModel || readClaudeSettingsModel)() : { ok: true, present: false, value: '' };
  let swap = null;
  let via = null;
  let pendingSwapFile = '';
  const pendingVia = pendingRecord && String(pendingRecord.switchModel || configuredVia).trim();
  if (session?.kind !== 'claude') {
    // Codex switching has its own durable transaction.
  } else if (pendingRecord && compactModelContainsFamily(lastTurn.model, pendingVia)) {
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
  } else if (policy?.path === 'warm-current') {
    // Spend the still-live cache on the current Claude model.
  } else if (!settingsSnapshot.ok) {
    process.stderr.write(`keep serve: skipping model swap for ${sid}: cannot read settings.json (${settingsSnapshot.error})\n`);
  } else {
    let settingsModel = settingsSnapshot.present ? settingsSnapshot.value : '';
    let settingsPresent = settingsSnapshot.present;
    const records = pendingCompactSwaps(dir).filter((record) => !record.error && !codexCompact.isCodexCompactSwap(record))
      .sort((a, b) => compactSwapRecordAt(b) - compactSwapRecordAt(a));
    if (compactModelBase(settingsModel) === compactModelBase(configuredVia) && records.length) {
      settingsModel = records[0].settingsModelBefore;
      settingsPresent = records[0].settingsModelPresent;
      process.stderr.write(`keep serve: using the pre-swap settings.json model from pending restore record ${String(records[0].sessionId || 'unknown').slice(0, 8)}\n`);
    }
    // A pane launched with `keep open --model` knows its model exactly; the transcript's
    // last-turn model is the fallback for sessions launched any other way.
    const launchModel = await (deps.hostPaneModel || hostPaneModel)(target, deps);
    swap = compactSwapPlan({ ...session, model: launchModel || lastTurn.model }, {
      via: configuredVia,
      families: compactModelFamilies(),
      settingsModel,
      settingsPresent,
    });
    via = swap ? configuredVia : null;
  }
  let result;
  let compactDiagnostic;
  let compactWatch;
  let transcriptFile = '';
  let submittedAt = null;
  inFlightSwap = swap ? { ...swap, switchModel: via } : null;
  try {
    const file = (deps.transcriptFileForSession || transcriptFileForSession)(session);
    if (!file) throw new Error('session transcript is unavailable');
    transcriptFile = file;

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

    if (!result && policy?.path === 'warm-current'
        && Number.isFinite(policy.cacheUsageAt) && Number.isFinite(policy.cacheTtlMs)
        && Date.now() >= policy.cacheUsageAt + policy.cacheTtlMs) {
      result = { compacted: false, reason: 'warm cache deadline passed before submit', via };
    }

    if (!result) {
      const started = Date.now();
      const initialStat = fs.statSync(file);
      let offset = initialStat.size;
      compactWatch = { file, offset, appended: '' };
      compactDiagnostic = (deps.compactTrace || require('./compact-trace').compactTrace)(session);
      compactDiagnostic.start(initialStat, offset);
      const confirmation = session.kind === 'codex' ? codexTypedTextVisible : claudeTypedTextVisible;
      await (deps.typeAndSubmit || typeAndSubmit)(target, compactCommand(instruction), confirmation, deps);
      submittedAt = Date.now();
      compactDiagnostic.submitted();

      const timeoutMs = envNumber('KEEP_COMPACT_TIMEOUT_MS', 240000);
      let appended = '';
      while (Date.now() - started < timeoutMs) {
        const remaining = timeoutMs - (Date.now() - started);
        await new Promise((resolve) => setTimeout(resolve, Math.min(deps.compactPollMs ?? 2000, Math.max(0, remaining))));
        // A too-short thread is refused on screen and never writes a marker; stop
        // instead of waiting out the timeout (seen live: "Not enough messages to compact.").
        let screen = '';
        try {
          screen = await (deps.readScreen || ((t, lines, scrollback) => readScreen(t, lines, scrollback, deps)))(target, 30, false);
        } catch { compactDiagnostic.screenError(); }
        const refusal = compactRefusal(screen);
        if (refusal) {
          process.stderr.write(`keep serve: compaction refused for ${session.kind} session ${sid}: ${refusal}\n`);
          result = { compacted: false, reason: refusal, via };
          break;
        }
        const chunk = appendedBytes(file, offset);
        offset = chunk.offset;
        compactWatch.offset = offset;
        compactDiagnostic.poll(chunk.stat, offset, chunk.bytesRead);
        appended = `${appended}${chunk.text}`;
        compactWatch.appended = appended;
        if (hasCompactionMarker(appended, session.kind)) {
          const ms = Date.now() - started;
          process.stderr.write(`keep serve: compacted ${session.kind} session ${sid} in ${ms}ms\n`);
          result = { compacted: true, ms, via };
          break;
        }
        if (session.kind === 'claude' && compactScreenConfirmed(screen, compactCommand(instruction))) {
          const ms = Date.now() - started;
          process.stderr.write(`keep serve: compacted ${session.kind} session ${sid} in ${ms}ms (screen)\n`);
          result = { compacted: true, ms, via, confirmedBy: 'screen' };
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
    let restoreConfirmed = !swap;
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
        restoreConfirmed = true;
        try { fs.unlinkSync(pendingSwapFile); } catch (e) {
          process.stderr.write(`keep serve: could not clear model restore record for claude session ${sid}: ${e.message}\n`);
        }
      } else {
        process.stderr.write(`keep serve: MODEL RESTORE UNCONFIRMED for claude session ${sid}: expected "${swap.restoreCommand}" — restore it by hand\n`);
        if (!result) result = { compacted: false, reason: 'model restore unconfirmed', via };
        result.restoreUnconfirmed = true;
      }
    }
    let diagnosticStage = result?.reason === 'timeout' ? 'timeout' : 'failed';
    if (result?.compacted && result.confirmedBy !== 'screen') diagnosticStage = 'marker-confirmed';
    if (result?.compacted && result.confirmedBy === 'screen') {
      diagnosticStage = 'screen-confirmed-no-marker';
      if (restoreConfirmed && compactWatch) {
        const deadline = Date.now() + (deps.compactMarkerGraceMs ?? 10000);
        do {
          const chunk = appendedBytes(compactWatch.file, compactWatch.offset);
          compactWatch.offset = chunk.offset;
          compactWatch.appended = `${compactWatch.appended}${chunk.text}`;
          compactDiagnostic?.poll(chunk.stat, chunk.offset, chunk.bytesRead);
          if (hasCompactionMarker(compactWatch.appended, session.kind)) {
            diagnosticStage = 'screen-confirmed';
            break;
          }
          if (Date.now() >= deadline) break;
          await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
        } while (true);
      }
    }
    compactDiagnostic?.finish(diagnosticStage);
    inFlightSwap = null;
  }
  const originalModel = String(policy?.originalModel || lastTurn.model || '');
  const compactionModel = String(policy?.targetModel || (swap ? via : originalModel) || '');
  let telemetry = { usage: null, compactMetadata: null };
  if (submittedAt && transcriptFile) {
    try {
      const telemetryText = session.kind === 'codex' && compactWatch?.appended
        ? compactWatch.appended : readTranscriptTail(transcriptFile);
      telemetry = compactRequestTelemetry(telemetryText, session.kind, submittedAt);
    } catch {}
  }
  result.originalModel = originalModel;
  result.compactionModel = compactionModel;
  result.compactionPath = policy?.path || (swap ? 'manual-swap' : 'manual-current');
  result.compactionUsage = telemetry.usage;
  result.compactMetadata = telemetry.compactMetadata;
  result.attemptStage = submittedAt ? 'submitted' : 'pre-submit';
  result.submissionCacheAgeMs = submittedAt && Number.isFinite(policy?.cacheUsageAt)
    ? submittedAt - policy.cacheUsageAt : null;
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

function agentIdentityOwnsPane(identity, pane, rows) {
  if (!identity || !pane?.alive || !Number.isInteger(pane.pid) || pane.pid <= 0
      || !Number.isInteger(identity.pid) || identity.pid <= 0
      || typeof identity.pidStart !== 'string' || !identity.pidStart
      || !['claude', 'codex'].includes(identity.agent) || !Array.isArray(rows)) return false;
  const byPid = new Map(rows.filter((row) => Number.isInteger(row?.pid)).map((row) => [row.pid, row]));
  let row = byPid.get(identity.pid);
  if (!row || row.pidStart !== identity.pidStart || row.agent !== identity.agent) return false;
  const seen = new Set();
  while (row && !seen.has(row.pid)) {
    if (row.pid === pane.pid) return true;
    seen.add(row.pid);
    row = byPid.get(row.ppid);
    // A nested agent can inherit the outer pane's environment and open files,
    // but its conversation does not own the outer TUI input box.
    const command = String(row?.args || '').trim().split(/\s+/)[0];
    if (row && /(?:^|\/)(?:codex|claude)$/.test(command)) return false;
  }
  return false;
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
        entries.forEach((entry, index) => setLiveSession(live, entry.id, row, 'rollout', {
          primary: index === 0, rolloutFile: entry.path,
        }));
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

function historyLinesLimit(value) {
  if (value == null || value === '') return SCREEN_HISTORY_LINES;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new InjectionError(400, 'bad history lines');
  return Math.min(number, SCREEN_HISTORY_LINES);
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
  return (deps.withInjectionLock || withInjectionLock)(async () => {
    const target = await (deps.shellPaneTarget || shellPaneTarget)(body.pane, deps);
    await (deps.writeTarget || writeTarget)(target, `${text}\r`, deps);
    return { ok: true, pane: target.pane, sent: text.length };
  }, { pane: String(body.pane ?? '') });
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

async function paneIncarnation(target, deps = {}) {
  let result;
  try { result = await hostRequest('get', { pane: target.pane }, deps); }
  catch { throw new InjectionError(409, 'terminal pane changed; return to Live and load history again'); }
  const pane = result && result.pane;
  if (!pane || pane.id !== target.pane || !pane.createdAt) {
    throw new InjectionError(409, 'terminal pane changed; return to Live and load history again');
  }
  return `${pane.id}:${pane.pid || ''}:${pane.createdAt}`;
}

async function screenHistorySession(query, deps = {}) {
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

  const pageSize = historyLinesLimit(get('lines'));
  const cache = deps.screenHistoryCache || screenHistoryCache;
  const readIncarnation = deps.paneIncarnation || paneIncarnation;
  const incarnation = await readIncarnation(target, deps);
  const key = `${session ? session.id : 'shell'}:${target.pane}:${incarnation}`;
  const cursor = get('cursor');
  if (cursor) {
    const cached = cache.read(cursor, key, pageSize);
    if (cached.error === 'target') {
      throw new InjectionError(409, 'terminal target changed; return to Live and load history again');
    }
    if (cached.error) throw new InjectionError(410, 'history snapshot expired; return to Live and load again');
    return cached;
  }

  const tailLines = sessionLinesLimit(get('tailLines') == null ? 120 : get('tailLines'));
  const readHistoryScreen = deps.readHistoryScreen || (async (resolved, tail, innerDeps) => {
    const hello = await hostRequest('hello', {}, innerDeps);
    if (!hello.compactScreen) throw new InjectionError(503, 'terminal host reload required to load history');
    return hostRequest('screen', {
      pane: resolved.pane,
      lines: null,
      compact: true,
      scrollback: SCREEN_HISTORY_SCROLLBACK,
    }, innerDeps);
  });
  const screen = await readHistoryScreen(target, tailLines, deps);
  const confirmedIncarnation = await readIncarnation(target, deps);
  if (confirmedIncarnation !== incarnation) {
    throw new InjectionError(409, 'terminal pane changed; return to Live and load history again');
  }
  const rawLines = Array.isArray(screen && screen.lines)
    ? screen.lines
    : String(screen && screen.text || '').split('\n');
  const cleanLines = rawLines.map(stripTerminalAnsi);
  const viewportRows = Math.max(0, Math.floor(Number(screen && screen.rows) || tailLines));
  const tailCount = Math.min(tailLines, viewportRows, cleanLines.length);
  const splitAt = cleanLines.length - tailCount;
  const meta = {
    ok: true,
    sessionId: session ? session.id : null,
    pane: target.pane,
    cols: screen && screen.cols,
    rows: screen && screen.rows,
    title: String(screen && screen.title || ''),
  };
  if (screen && typeof screen.alt === 'boolean') meta.alt = screen.alt;
  try {
    return cache.create({
      key,
      truncated: screen && screen.truncated === true,
      lines: cleanLines.slice(0, splitAt),
      tail: cleanLines.slice(splitAt),
      meta,
    }, pageSize);
  } catch (error) {
    if (error instanceof RangeError) throw new InjectionError(413, error.message);
    throw error;
  }
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
    claimInjectionTarget(target);
    await (deps.writeTarget || writeTarget)(target, bytes.join(''), deps);
    return { ok: true, sessionId: session ? session.id : null, pane: target.pane, sent: body.keys.length };
  }, shellPane ? { pane: String(shellPane) } : { session: session.id });
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
  const reviewer = require('./session-restart').isReviewer(session, original);
  if (original.cmd !== '/bin/zsh' || JSON.stringify(original.args) !== '["-l"]') return false;
  const verify = async () => {
    const current = (await hostRequest('get', { pane: original.id }, deps)).pane;
    if (!current?.alive || !restartPaneMatches(original, current, session.id)
        || (deps.queued && !reviewer && (current.visibleAttached ?? current.attached) !== 0)) return false;
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

// One reviewer-aware resume spec for both restart transactions — the guarded restart
// and the explicit force/recover path. A bare `claude --resume` inherits none of the
// launch configuration, so rebuild it from the pane meta the launcher recorded plus
// the .keep/reviewer marker: without this the reviewer comes back nameless, on the
// wrong model, with prompt suggestions on and a 30k Bash cap that truncates every
// five-card bundle. The marker itself survives on its own (session-end tombstones it,
// the resumed process's session-start hook un-tombstones it).
function reviewerResumeSpec(session, pane, deps = {}) {
  if (!require('./session-restart').isReviewer(session, pane)) return { flags: [], env: null };
  const sessionId = session?.id || pane?.meta?.sessionId;
  const meta = pane?.meta;
  const marker = (deps.reviewerMarker || review.readReviewerMarker)(sessionId) || {};
  const family = marker.model || marker.name || 'fable';
  const launch = require('./reviewer-launch');
  return {
    flags: launch.reviewerFlags(meta?.reviewerModel || family),
    env: launch.reviewerEnv(deps.root || keep.ROOT, family, meta?.reviewerBashOutput),
  };
}

// KEEP_REPAIR marks a session as a daemon self-repair agent, and `keep hook
// pre-bash` refuses the restart and the live-checkout writes for anything that
// carries it. The first launch gets the marker from deps.launchEnv; a restart, a
// force-restart, an account handoff or a plain reopen has only a session id, so it
// asks the self-repair state whether that id is one the scheduler launched.
//
// Deliberately the launched session and nothing else. The repair CARD is not the
// test: Owner opening his own session on one to look at the fix would inherit a
// refusal on `keep restart-daemon`, which is exactly the restart he is there to do.
function repairEnvFor(context, deps = {}) {
  const sessionId = context && context.sessionId;
  if (!sessionId) return {};
  try {
    const isRepairSession = deps.isRepairSession || require('./self-repair.js').isRepairSession;
    return isRepairSession(sessionId, deps.root || keep.ROOT) ? { KEEP_REPAIR: '1' } : {};
  } catch (error) {
    // Unreadable state must not stop a restart. It fails open on the marker, which
    // is the same state as before this existed.
    process.stderr.write(`keep serve: could not check the self-repair session record: ${String(error && error.message || error)}\n`);
    return {};
  }
}

function validatedCodexResumeCwd(agent, value) {
  let available = agent === 'codex' && typeof value === 'string' && value.length > 0
    && !value.includes('\0') && path.isAbsolute(value);
  if (available) {
    try { available = fs.statSync(value).isDirectory(); } catch { available = false; }
  }
  if (!available) throw new InjectionError(409, 'Saved Codex working directory is unavailable');
  return value;
}

async function restartSession(body, deps = {}) {
  const host = (type, params) => hostRequest(type, params, deps);
  // An explicit force discards uncertain background-job evidence only; the turn,
  // tool and process identity checks below stay exactly as strict.
  const force = body.force === true;
  let exitInputStarted = false;
  const transient = (reason) => body.mode === 'idle' && !exitInputStarted
    ? new (require('./session-restart').RestartDeferred)(reason) : new InjectionError(409, reason);
  // The resumed agent reads settings.json's model at startup, so it also holds the
  // model key: a restart never starts an agent while a compaction has swapped it.
  return (deps.withInjectionLock || withInjectionLock)(async () => {
    if (!(await host('hello')).replaceExited) throw Error('Terminal host must be refreshed before restarting sessions');
    const pane = (await host('get', { pane: body.pane })).pane;
    const session = (await (deps.buildState || buildState)({ hostPanes: [pane] })).sessions.find((s) => s.id === body.sessionId);
    const terminalLimit = deps.allowTerminalRateLimit === true && session?.kind === 'claude' && session.rateLimit && !session.pendingBackground
      && !session.toolRunning && !session.pendingQuestion && !session.pendingPlan && !(session.unknownBackgroundJobs || []).length;
    const restartSessionState = terminalLimit ? { ...session, endedTurn: true, rateLimit: null } : session;
    const reason = require('./session-restart').refusal(restartSessionState, pane, body.mode === 'idle', { force });
    if (pane.pid !== body.pid) throw new InjectionError(409, 'Session process changed');
    if (reason) {
      if (/^Waiting |^Pause session-local scheduled jobs/.test(reason)) throw transient(reason);
      throw new InjectionError(409, reason);
    }
    const cwd = deps.resumeCwd == null ? session.project || pane.cwd
      : validatedCodexResumeCwd(session.kind, deps.resumeCwd);
    if (!cwd || !fs.statSync(cwd).isDirectory()) throw Error('Session directory is unavailable');
    let account = deps.resumeAccount || null;
    if (!account) {
      try { account = accounts.forSession(session.id, session.kind, { root: deps.root || keep.ROOT, env: deps.env || process.env }); }
      catch (error) { throw new InjectionError(409, error.message); }
      if (!account && session.accountId) {
        account = accounts.get(session.accountId, deps.env || process.env);
        if (!account || account.agent !== session.kind) throw new InjectionError(409, `session belongs to unavailable account ${session.accountId}`);
      }
      account ||= accounts.defaultFor(session.kind, deps.env || process.env);
    }
    let resumeMcpConfig = deps.resumeMcpConfig || null;
    if (session.kind === 'claude' && account.managed) {
      try { resumeMcpConfig ||= (deps.ensureSharedMemory || require('./account-setup').ensureSharedMemory)(account, cwd).mcpConfig; }
      catch (error) { throw new InjectionError(409, `account shared setup is unavailable: ${error.message}`); }
    }
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
        allowTerminalRateLimit: terminalLimit, force,
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
      if (body.mode === 'idle' && !require('./session-restart').isReviewer(session, pane)
          && (currentPane.visibleAttached ?? currentPane.attached) !== 0) throw transient('Waiting until the pane is no longer being viewed');
      const rows = await (deps.agentProcessRows || agentProcessRows)(deps);
      const identity = (await liveSessionPids({ ...deps, agentProcessRows: async () => rows })).get(session.id);
      if (!identity?.primary || identity.pid !== originalIdentity.pid || identity.pidStart !== originalIdentity.pidStart) throw Error('Agent process identity changed during restart');
      const parent = rows.find((p) => p.pid === identity.pid);
      const helpers = mcpRestart.inspect({ root: deps.root || keep.ROOT, agent: session.kind, sessionId: session.id, parent, rows, force });
      if (restartHelpers && JSON.stringify(helpers) !== JSON.stringify(restartHelpers)) throw Error('Session helper processes changed during restart');
      restartHelpers = helpers;
      try { childProof(); } catch (error) {
        if (['Job ledger source changed during restart', 'Job ledger evidence changed during restart', 'New hook activity arrived during restart'].includes(error.message)) throw transient(error.message);
        throw error;
      }
    };
    await checkChildren();
    try {
      await (deps.closeIdleSession || closeIdleSession)(body, { ...deps, allowTerminalRateLimit: terminalLimit,
        restartProof: childProof, closePolicy: { manual: true, restart: true, force }, withInjectionLock: (fn) => fn(), beforeClose: checkChildren,
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
    const reviewerSpec = reviewerResumeSpec(session, pane, deps);
    const requestedResumeModel = deps.resumeModel || pane.meta?.model;
    const launchModel = typeof requestedResumeModel === 'string' && keep.LAUNCH_MODEL_RE.test(requestedResumeModel) ? requestedResumeModel : '';
    const modelArgs = launchModel ? (session.kind === 'codex' ? ['-m', launchModel] : ['--model', launchModel]) : [];
    const mcpArgs = session.kind === 'claude' && resumeMcpConfig ? ['--mcp-config', resumeMcpConfig] : [];
    let argv;
    if (deps.resumeArgv != null) {
      if (session.kind !== 'codex' || !Array.isArray(deps.resumeArgv) || deps.resumeArgv.length < 3
          || deps.resumeArgv.some((value) => typeof value !== 'string' || !value || /[\r\n\0]/.test(value))
          || deps.resumeArgv[0] !== 'codex' || deps.resumeArgv.at(-2) !== 'resume' || deps.resumeArgv.at(-1) !== session.id) {
        throw new InjectionError(409, 'Codex resume policy changed before restart');
      }
      argv = [...deps.resumeArgv];
    } else {
      argv = [session.kind, ...flags, ...reviewerSpec.flags, ...mcpArgs, ...modelArgs,
        session.kind === 'codex' ? 'resume' : '--resume', session.id];
    }
    const result = await host('replace-exited', { paneId: pane.id, expectedPid: pane.pid, sessionId: stopped.meta?.sessionId,
      cmd: '/bin/zsh', args: ['-lic', `exec ${require('./agent-launcher').profileCommand(argv, account)}`], cwd,
      env: require('./agent-launcher').launcherEnv({ ...repairEnvFor({ sessionId: session.id }, deps), ...reviewerSpec.env }),
      cols: pane.cols, rows: pane.rows, meta: { ...adoptedPaneMeta(pane.meta), agent: session.kind, sessionId: session.id,
        accountId: account.id, accountLabel: account.label, restartedAt: Date.now() } });
    await (deps.waitForHostAgent || waitForHostAgent)({ pane: pane.id }, session.kind, deps);
    return { ok: true, sessionId: session.id, pane: result.pane.id, pid: result.pane.pid,
      createdAt: result.pane.createdAt };
  }, { pane: body.pane, session: body.sessionId, model: true });
}

async function forceRestartSession(entry, save, deps = {}) {
  return (deps.withInjectionLock || withInjectionLock)(async () => {
    const host = (type, params) => hostRequest(type, params, deps);
    if (!(await host('hello')).replaceExited) throw Error('Terminal host must be refreshed before restarting sessions');
    const initial = (await host('get', { pane: entry.pane })).pane;
    const cwd = entry.original?.cwd || initial?.cwd;
    if (!cwd || !fs.statSync(cwd).isDirectory()) throw Error('Session directory is unavailable');
    const resumeAgent = entry.original?.agent || initial?.meta?.agent;
    if (!['claude', 'codex'].includes(resumeAgent)) throw new InjectionError(409, 'Original agent is unavailable');
    const originalAccountId = entry.original?.meta?.accountId || initial?.meta?.accountId;
    let resumeAccount;
    try { resumeAccount = accounts.forSession(entry.sessionId, resumeAgent, { root: deps.root || keep.ROOT, env: deps.env || process.env }); }
    catch (error) { throw new InjectionError(409, error.message); }
    if (!resumeAccount && originalAccountId) {
      resumeAccount = accounts.get(originalAccountId, deps.env || process.env);
      if (!resumeAccount || resumeAccount.agent !== resumeAgent) {
        throw new InjectionError(409, `session belongs to unavailable account ${originalAccountId}`);
      }
    }
    resumeAccount ||= accounts.defaultFor(resumeAgent, deps.env || process.env);
    let resumeMcpConfig = null;
    if (resumeAgent === 'claude' && resumeAccount.managed) {
      try { resumeMcpConfig = (deps.ensureSharedMemory || require('./account-setup').ensureSharedMemory)(resumeAccount, cwd).mcpConfig; }
      catch (error) { throw new InjectionError(409, `account shared setup is unavailable: ${error.message}`); }
    }
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
        const reviewerSpec = reviewerResumeSpec({ id: job.sessionId }, original, deps);
        const launchModel = typeof original.meta?.model === 'string' && keep.LAUNCH_MODEL_RE.test(original.meta.model) ? original.meta.model : '';
        const modelArgs = launchModel ? (original.agent === 'codex' ? ['-m', launchModel] : ['--model', launchModel]) : [];
        const account = resumeAccount;
        const mcpArgs = resumeMcpConfig ? ['--mcp-config', resumeMcpConfig] : [];
        const argv = [original.agent, ...(original.bypass ? [bypass] : []), ...reviewerSpec.flags, ...mcpArgs, ...modelArgs,
          original.agent === 'codex' ? 'resume' : '--resume', job.sessionId];
        const stopped = (await host('get', { pane: job.pane })).pane;
        if (stopped.alive || stopped.pid !== expectedPid || (stopped.meta?.sessionId !== job.sessionId
          && !(stopped.meta?.agent === 'shell' && !stopped.meta.sessionId
            && ((expectedPid === job.pid && stopped.createdAt === original.createdAt) || stopped.meta.forceRestartToken === job.token)))) {
          throw Error('Exited pane changed before resume');
        }
        const result = await host('replace-exited', { paneId: job.pane, expectedPid, sessionId: stopped.meta?.sessionId,
          cmd: '/bin/zsh', args: ['-lic', `exec ${require('./agent-launcher').profileCommand(argv, account)}`], cwd: original.cwd,
          env: require('./agent-launcher').launcherEnv({ ...repairEnvFor({ sessionId: job.sessionId }, deps), ...reviewerSpec.env }),
          cols: original.cols, rows: original.rows, meta: { ...adoptedPaneMeta(original.meta), accountId: account.id, accountLabel: account.label,
            forceRestartToken: job.token, restartedAt: Date.now() } });
        return { ok: true, pane: result.pane.id, pid: result.pane.pid, sessionId: job.sessionId };
      },
    });
  }, { pane: entry.pane, session: entry.sessionId, model: true });
}

async function closeIdleSession(body, deps = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(body.sessionId || '')) || !/^[A-Za-z0-9_-]+$/.test(String(body.pane || ''))) throw new InjectionError(400, 'Expected an exact session and pane');
  const scope = { pane: body.pane, session: body.sessionId };
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
      const legacy = deps.closePolicy.legacyDoneAt || {};
      const plan = require('./session-cleanup').doneClosePlan(
        current.sessions.find((candidate) => candidate.id === session.id),
        policyPane,
        { ...current, allTasks, pinned, companion },
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
    // The check sweep may only close panes that are still its own. A restart or an
    // account handoff drops `meta.ephemeral`, so a pane adopted between the sweep's
    // decision and this close belongs to whoever adopted it, not to the scheduler.
    if (deps.closePolicy?.ephemeral && !pane?.meta?.ephemeral) {
      throw new InjectionError(409, 'Pane is no longer a scheduler-opened check session');
    }
    const cleanupSession = deps.allowTerminalRateLimit && session.kind === 'claude' && session.rateLimit
      ? { ...session, endedTurn: true, rateLimit: null } : session;
    const reason = require('./session-cleanup').refusal(cleanupSession, pane, pinned, Date.now(), deps.closePolicy);
    if (reason) throw new InjectionError(409, reason);
    const checkTaskSafety = (current) => {
      const owner = current.sessions.find((s) => s.id === session.id);
      const task = current.tasks.find((t) => t.id === owner?.taskId);
      const fm = task?.fm || task || {};
      // A restart or account transfer resumes the same session, so an open need or
      // dependency on its card is no reason to keep the old process alive. So is an
      // ephemeral check pane: Keep opened it for one recipe, and a `check_after` on
      // that card is the schedule this very session just re-armed — holding the
      // process open for it would mean a recurring card's pane is never closed.
      const ownsItsSchedule = deps.closePolicy?.manual || deps.closePolicy?.ephemeral;
      if ((!ownsItsSchedule && fm.check_after) || (!deps.closePolicy?.restart && !deps.closePolicy?.ephemeral && (fm.needs?.length || fm.depends_on?.length))) throw new InjectionError(409, 'Task has a scheduled check, need, or dependency; leave the session open');
      // Explicit Close retires the process, not its durable scheduled recipes. The
      // scheduler opens a fresh session for the check when its owner is closed.
      if (!ownsItsSchedule && current.tasks.some((t) => { const f = t.fm || t; return f.check_after && (f.scheduled_by === session.id || f.sessions?.some((s) => s.id === session.id)); })) throw new InjectionError(409, 'Session owns a scheduled check on another card');
      if (require('./delivery').pendingForSession(path.join(deps.root || keep.ROOT, '.keep', 'delivery'), session.id)) throw new InjectionError(409, 'Session has an unconfirmed delivery');
    };
    checkTaskSafety(state);
    const target = claimInjectionTarget(await resolveSessionTarget(session, { expectedPane: pane.id }, deps));
    await precheckSessionTarget(session, target, deps); // Preserve unsent drafts and modal prompts.
    const fresh = session.kind === 'claude' ? (deps.claudeSessionFor || claudeSessionFor)(session.id) : (deps.codexSessionFor || codex.sessionFor)(session.id);
    if (!fresh || typeof fresh.endedTurn !== 'boolean' || !Number.isFinite(fresh.mtime)) throw new InjectionError(409, 'Session activity could not be verified');
    const freshEnded = fresh.endedTurn === true || (deps.allowTerminalRateLimit && fresh.rateLimit && !fresh.pendingBackground
      && !fresh.toolRunning && !fresh.pendingQuestion && !fresh.pendingPlan && !(fresh.unknownBackgroundJobs || []).length);
    // A forced restart already accepted uncertain background evidence upstream;
    // the transcript's turn, tool and mtime checks still have to agree.
    if (fresh.mtime !== session.mtime || !freshEnded || (!deps.closePolicy?.force && fresh.pendingBackground) || fresh.toolRunning) throw new InjectionError(409, 'Session changed during cleanup; nothing closed');
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
      const latestEnded = latest.endedTurn === true || (deps.allowTerminalRateLimit && latest.rateLimit && !latest.pendingBackground
        && !latest.toolRunning && !latest.pendingQuestion && !latest.pendingPlan && !(latest.unknownBackgroundJobs || []).length);
      if (latest.mtime !== session.mtime || !latestEnded
          || (!deps.closePolicy?.force && (latest.pendingBackground || latest.unknownBackgroundJobs?.length))
          || latest.toolRunning || latest.pendingQuestion || latest.pendingPlan) {
        throw new InjectionError(409, 'Session changed during cleanup; nothing closed');
      }
      if (deps.closePolicy?.automatic) {
        currentPane = (await listHostPanes(deps, true))?.find((p) => p.id === pane.id);
        if (!currentPane?.alive || currentPane.attached !== 0 || currentPane.meta?.sessionId !== session.id) throw new InjectionError(409, 'Session acquired a viewer or changed during cleanup');
        if (deps.closePolicy?.ephemeral && !currentPane.meta?.ephemeral) {
          throw new InjectionError(409, 'Pane stopped being a scheduler-opened check session during cleanup');
        }
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
    // The input/output counts a caller needs to guard its own SIGTERM/SIGKILL. Produced
    // for automatic retirement, and for the check sweep, which passes protectInput and
    // protectOutput to manual-close and cannot enforce either without them.
    if (deps.closePolicy?.done || deps.closePolicy?.ephemeral) {
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
  }, scope);
}

async function precheckSessionTarget(session, target, deps = {}) {
  const screen = await (deps.readScreen || ((t, lines, scrollback) => readScreen(t, lines, scrollback, deps)))(target, 30, false);
  if (session.kind === 'codex') codexSendPrecheck(screen);
  else await probeSuggestion(target, screen, deps);
}

function sessionLastTurn(session, deps = {}) {
  const file = (deps.transcriptFileForSession || transcriptFileForSession)(session);
  if (!file) return { contextTokens: 0, model: '' };
  try {
    const result = lastTurnUsage(readTranscriptTail(file), session.kind);
    if (session.kind === 'codex' && !result.model) {
      const settings = codexCompact.readRolloutSettings(file, deps);
      if (settings?.model) result.model = settings.model;
    }
    return result;
  }
  catch { return { contextTokens: 0, model: '' }; }
}

function sessionContextTokens(session) {
  return sessionLastTurn(session).contextTokens;
}

function autoCompactIdleMs(session, stamps, now, opts) {
  if (!session || !['claude', 'codex'].includes(session.kind)) return null;
  // Fleet reviewers have a separate context-pressure policy that preserves patterns.
  if (session.reviewer) return null;
  if (session.exited || session.endedTurn === false) return null; // Never interrupt an assistant turn in progress.
  if (session.pendingQuestion || session.pendingPlan || session.pendingBackground) return null; // Leave active/waiting work alone.
  // `waiting` is Claude Code's idle_prompt: the turn ended and Owner has not typed, which is exactly the idle state targeted here.
  if (session.notify && ['permission', 'question'].includes(session.notify.type)) return null; // Owner must answer a real prompt first.
  const idleMs = now - Number(session.mtime);
  const minIdleMs = Number.isFinite(opts.minIdleMs) ? opts.minIdleMs : opts.ttlMs;
  if (!Number.isFinite(idleMs) || idleMs < minIdleMs || idleMs > opts.maxIdleMs) return null;
  return idleMs;
}

function autoCompactPolicy(session, now, opts) {
  const model = String(session?.model || '').trim().toLowerCase();
  const models = Array.isArray(opts.models) ? opts.models : [];
  if (session?.kind === 'claude') {
    if (!model || !models.some((family) => {
      const needle = String(family).trim().toLowerCase();
      return needle && model.includes(needle);
    })) return null;
  } else if (session?.kind === 'codex') {
    if (model !== 'gpt-6-astra') return null;
  } else return null;
  const usageAt = session.usageAt;
  if (!Number.isFinite(usageAt) || usageAt <= 0) return null;
  const fallbackTtlMs = session.kind === 'codex'
    ? (opts.codexTtlMs ?? 30 * 60e3) : (opts.claudeTtlMs ?? opts.ttlMs);
  const cacheTtlMs = session.kind === 'claude' && Number.isFinite(session.cacheTtlMs)
    ? session.cacheTtlMs : fallbackTtlMs;
  const cacheAgeMs = now - usageAt;
  if (!Number.isFinite(cacheAgeMs)) return null;
  // A five-minute Claude cache is too short to justify an immediate compaction.
  // Leave the session alone for an hour, then compact through the cheaper model.
  if (session.kind === 'claude' && session.cacheTtlMs === 5 * 60e3) {
    const targetAgeMs = 60 * 60e3;
    if (cacheAgeMs < targetAgeMs) return null;
    return {
      path: 'cold-fallback',
      originalModel: model,
      targetModel: opts.claudeFallbackModel || 'opus',
      cacheAgeMs,
      cacheTtlMs,
      targetAgeMs,
    };
  }
  const leadMs = cacheTtlMs <= 5 * 60e3 ? 60e3 : 10 * 60e3;
  const configuredTarget = session.kind === 'codex'
    ? (opts.codexTargetMs ?? cacheTtlMs - leadMs)
    : (opts.claudeTargetMs ?? cacheTtlMs - leadMs);
  const targetAgeMs = Math.min(configuredTarget, Math.max(0, cacheTtlMs - leadMs));
  if (cacheAgeMs < targetAgeMs) return null;
  const warm = cacheAgeMs < cacheTtlMs;
  return {
    path: warm ? 'warm-current' : 'cold-fallback',
    originalModel: model,
    targetModel: warm ? model
      : session.kind === 'claude' ? (opts.claudeFallbackModel || 'opus')
        : (opts.codexFallbackModel || 'gpt-5.6-sol'),
    cacheAgeMs,
    cacheTtlMs,
    targetAgeMs,
  };
}

function autoCompactCandidates(sessions, stamps, now, opts) {
  const candidates = [];
  for (const session of sessions || []) {
    const idleMs = autoCompactIdleMs(session, stamps, now, opts);
    if (idleMs === null) continue;
    const policy = autoCompactPolicy(session, now, opts);
    if (!policy) continue;
    const contextTokens = Number(session.contextTokens);
    if (!Number.isFinite(contextTokens) || contextTokens < opts.minTokens) continue; // Avoid lossy work on small contexts.
    const stamp = stamps instanceof Map ? stamps.get(session.id) : stamps && stamps[session.id];
    if (stamp && stamp.mtime === session.mtime) {
      const warmCanFallBack = stamp.path === 'warm-current' && policy.path === 'cold-fallback'
        && !['would', 'compacted', 'timeout', 'in-progress'].includes(stamp.result);
      if (!warmCanFallBack) continue;
    }
    candidates.push({ session, idleMs, contextTokens, ...policy });
  }
  return candidates.sort((a, b) =>
    Number(a.path !== 'warm-current') - Number(b.path !== 'warm-current')
      || (a.session.usageAt + a.cacheTtlMs) - (b.session.usageAt + b.cacheTtlMs)
      || b.contextTokens - a.contextTokens);
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
  const compactionModel = normalizedText(stamp.compactionModel) || 'unknown';
  const cacheAge = Math.round(Number(stamp.cacheAgeMs || 0) / 60e3);
  const pathName = normalizedText(stamp.path) || 'unknown';
  if (stamp.result === 'skipped') {
    process.stderr.write(`keep serve: auto-compact skipped ${sid}: ${normalizedText(stamp.reason).slice(0, 300)}\n`);
    return;
  }
  if (stamp.result === 'would') {
    process.stderr.write(`keep serve: auto-compact would compact ${sid} ${title} idle ${idle}m cache ${cacheAge}m ctx ${context}k model ${model} path ${pathName} on ${compactionModel}\n`);
    return;
  }
  const detail = stamp.reason ? `: ${normalizedText(stamp.reason).slice(0, 300)}` : '';
  process.stderr.write(`keep serve: auto-compact ${stamp.result} ${sid} ${title} idle ${idle}m cache ${cacheAge}m ctx ${context}k model ${model} path ${pathName} on ${compactionModel}${detail}\n`);
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

async function autoCompactTick(deps = {}) {
  recordCompactRestoreHealth(await (deps.sweepPendingCompactSwaps || sweepPendingCompactSwaps)());
  const mode = envString('KEEP_AUTO_COMPACT', 'off').toLowerCase();
  if (!['dry', 'on'].includes(mode)) return { ok: true, detail: 'nothing due' };
  const now = Date.now();
  const opts = {
    minIdleMs: 0,
    ttlMs: 0,
    maxIdleMs: envNumber('KEEP_AUTO_COMPACT_MAX_IDLE_MIN', 1440) * 60e3,
    minTokens: envNumber('KEEP_AUTO_COMPACT_MIN_TOKENS', 100000),
    models: compactModelFamilies(),
    claudeTtlMs: envNumber('KEEP_AUTO_COMPACT_CLAUDE_TTL_MIN', envNumber('KEEP_CACHE_TTL_MIN', 60)) * 60e3,
    claudeTargetMs: envNumber('KEEP_AUTO_COMPACT_CLAUDE_TARGET_MIN', 50) * 60e3,
    claudeFallbackModel: envString('KEEP_COMPACT_VIA_MODEL', 'opus'),
    codexTtlMs: envNumber('KEEP_AUTO_COMPACT_CODEX_TTL_MIN', 30) * 60e3,
    codexTargetMs: envNumber('KEEP_AUTO_COMPACT_CODEX_TARGET_MIN', 20) * 60e3,
    codexFallbackModel: envString('KEEP_AUTO_COMPACT_CODEX_FALLBACK_MODEL', 'gpt-5.6-sol'),
  };
  (deps.gcAutoCompactStamps || gcAutoCompactStamps)(now);
  const stamps = (deps.readAutoCompactStamps || readAutoCompactStamps)();
  // Transcript-derived `exited` only observes explicit exit commands, not process
  // death. Keep live host state here rather than in the cached transcript record.
  const panes = await (deps.listHostPanes || listHostPanes)({}, true);
  const liveIds = new Set([...hostPanesBySession(panes).entries()]
    .filter(([, pane]) => pane.alive && pane.agentAlive !== false)
    .map(([id]) => id));
  const cheap = (deps.scanSessions || scanSessions)().filter((session) =>
    liveIds.has(session.id) && autoCompactIdleMs(session, stamps, now, opts) !== null);
  const candidates = autoCompactCandidates(
    cheap.map((session) => ({ ...session, ...(deps.sessionLastTurn || sessionLastTurn)(session) })),
    stamps,
    now,
    opts,
  );
  let candidate = candidates[0];
  // A completed scan is healthy even when it has no candidates. Health treats
  // `nothing due` as an unattempted tick and preserves any prior failure.
  if (!candidate) return { ok: true, detail: 'no eligible sessions' };

  let result = 'would';
  let reason = '';
  let ms;
  let via = null;
  let compactedResult = null;
  if (mode === 'on') {
    let attempted = false;
    for (const nextCandidate of candidates) {
      candidate = nextCandidate;
      result = 'error';
      reason = '';
      via = null;
      compactedResult = null;
      const started = Date.now();
      let phase = 'lock';
      try {
        const compacted = await (deps.withInjectionLock || withInjectionLock)(async () => {
          phase = 'resolve';
          const session = (deps.loadCurrentSession || loadCurrentSession)(candidate.session.id);
          const freshNow = Date.now();
          const freshTurn = (deps.sessionLastTurn || sessionLastTurn)(session);
          const freshCandidate = autoCompactCandidates([{ ...session, ...freshTurn }], stamps, freshNow, opts)[0];
          if (session.mtime !== candidate.session.mtime || !freshCandidate
              || freshCandidate.path !== candidate.path || freshCandidate.originalModel !== candidate.originalModel) {
            phase = 'eligibility';
            throw new InjectionError(409, 'session changed or left the eligible compaction window');
          }
          const target = await (deps.resolveSessionTarget || resolveSessionTarget)(session, null);
          // A busy pane is another sender, not a busy session: stay in the lock phase.
          phase = 'lock';
          claimInjectionTarget(target);
          phase = 'precheck';
          await precheckSessionTarget(session, target, deps);
          phase = 'compact';
          return (deps.compactSession || compactSession)(session, target, null, {
            ...deps,
            compactionPolicy: {
              path: freshCandidate.path,
              originalModel: freshCandidate.originalModel,
              targetModel: freshCandidate.targetModel,
              cacheUsageAt: freshCandidate.session.usageAt,
              cacheTtlMs: freshCandidate.cacheTtlMs,
              cacheAgeMs: freshCandidate.cacheAgeMs,
            },
          });
        }, { session: candidate.session.id, model: true });
        via = compacted.via || null;
        reason = String(compacted.reason || '');
        result = autoCompactOutcome(compacted);
        compactedResult = compacted;
      } catch (e) {
        reason = String(e && e.message || e);
        // Retryable contention and precheck failures do not spend the idle period.
        // Try another candidate so one blocked pane cannot starve the fleet.
        if (phase === 'lock' || phase === 'precheck' || phase === 'eligibility') {
          process.stderr.write(`keep serve: auto-compact skipped ${String(candidate.session.id).slice(0, 8)} this tick: ${reason}\n`);
          continue;
        }
        if (phase === 'resolve' && e instanceof InjectionError && e.status === 404 && e.extra.notLive) result = 'skipped';
        else if (phase === 'resolve') result = 'unmatched';
        else result = 'error';
      }
      ms = Date.now() - started;
      attempted = true;
      break;
    }
    if (!attempted) return { ok: true, detail: 'nothing due' };
  }

  const stamp = {
    sessionId: candidate.session.id,
    mtime: candidate.session.mtime,
    at: Date.now(),
    idleMs: candidate.idleMs,
    contextTokens: candidate.contextTokens,
    model: String(candidate.session.model || ''),
    originalModel: String(compactedResult?.originalModel || candidate.originalModel || candidate.session.model || ''),
    compactionModel: String(compactedResult?.compactionModel || candidate.targetModel || ''),
    path: candidate.path,
    cacheAgeMs: compactedResult?.submissionCacheAgeMs ?? candidate.cacheAgeMs,
    cacheTtlMs: candidate.cacheTtlMs,
    targetAgeMs: candidate.targetAgeMs,
    via,
    mode,
    result,
  };
  stamp.attemptStage = compactedResult?.attemptStage || (mode === 'dry' ? 'planned' : 'pre-submit');
  stamp.compactionUsage = compactedResult?.compactionUsage || null;
  stamp.compactMetadata = compactedResult?.compactMetadata || null;
  if (Number.isFinite(ms)) stamp.ms = ms;
  if (reason) stamp.reason = reason.slice(0, 500);
  let decisionError = null;
  try {
    (deps.writeAutoCompactDecision || writeAutoCompactDecision)(stamp);
  } catch (e) {
    decisionError = e;
    process.stderr.write(`keep serve: could not save auto-compact decision for ${String(stamp.sessionId).slice(0, 8)}: ${e.message}\n`);
  }
  (deps.logAutoCompactDecision || logAutoCompactDecision)(candidate, stamp);
  const ok = ['would', 'compacted', 'busy', 'skipped'].includes(result);
  return { ok: ok && !decisionError, detail: decisionError ? 'decision write failed' : result === 'skipped' ? 'pane exited' : result, error: decisionError || (ok ? '' : reason || result) };
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
  setInterval(() => { void tick(); }, 30e3).unref();
  setTimeout(() => { void tick(); }, 15e3).unref();
}

function claudeMcpMenuVisible(screen) {
  const lines = stripTerminalAnsi(screen).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const title = lines.lastIndexOf('Manage MCP servers');
  if (title < 0) return false;
  const panel = lines.slice(title);
  const footer = /^↑\/↓(?: to)? navigate · Enter(?: to)? confirm · Esc(?: to)? cancel$/;
  return panel.some((line) => /^\d+ servers?$/.test(line))
    && footer.test(panel.at(-1));
}

async function observeClaudeMcpMenu(session, target, deps = {}) {
  const bound = (panes) => panes.find((candidate) => candidate.id === target.pane
    && candidate.alive && candidate.agentAlive !== false
    && candidate.meta?.sessionId === session.id && candidate.meta?.agent === 'claude');
  try {
    if (!bound(await listHostPanes(deps, true))) return false;
    const screen = await readScreenResult(target, null, false, deps);
    if (!claudeMcpMenuVisible(screen?.text)) return false;
    return Boolean(bound(await listHostPanes(deps, true)));
  } catch { return false; }
}

async function sendToResolvedTarget(session, target, text, opts, deps = {}) {
  claimInjectionTarget(target);
  const pendingDirectory = deps.deliveryDirectory || path.join(keep.ROOT, '.keep', 'delivery');
  const record = require('./delivery-trace').recorder(pendingDirectory, session, target.pane);
  // Whether a single character of this message has been written to the pane. A
  // caller that has to decide "could this have arrived?" cannot tell that from
  // the message of a failure, and guessing wrong either types twice or silently
  // spends a slot.
  let typingStarted = false;
  const trace = (stage, fields) => {
    if (stage === 'write-start' || stage === 'enter-start') typingStarted = true;
    return record(stage, fields);
  };
  const delivery = require('./delivery');
  const observeMcp = session.kind === 'claude' && text === '/mcp' ? async () => {
    if (!await observeClaudeMcpMenu(session, target, deps)) return false;
    const settled = delivery.settleObserved(pendingDirectory, {
      sessionId: session.id, pane: target.pane, expectedHash: delivery.textHash(text), evidence: 'claude-mcp-menu',
    });
    if (settled) trace('terminal-evidence-confirmed', { evidence: 'claude-mcp-menu' });
    return settled;
  } : null;
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
    // Claude does not transcript /mcp. A previously submitted command can be
    // recovered only while its native menu is still positively identified.
    if (observeMcp) await observeMcp();
    return await delivery.deliver({
      session, pane: target.pane, text, file: (deps.transcriptFileForSession || transcriptFileForSession)(session), directory: pendingDirectory, trace,
      retainReceipt: opts?.retainReceipt === true,
      key: opts?.deliveryKey,
      observe: observeMcp,
      precheck,
      type: async () => {
        if (opts?.beforeType) await opts.beforeType();
        return typeAndSubmit(target, text, confirmation, { ...deps, deliveryTrace: trace, draftKind: session.kind });
      },
      submitDraft: async () => {
        if (opts?.beforeType) await opts.beforeType();
        return pressTargetKey(target, 'Enter', deps);
      },
      draftMatches: async () => {
        const current = deps.loadDeliverySession ? deps.loadDeliverySession(session.id)
          : session.kind === 'claude' ? claudeSessionFor(session.id) : codex.sessionFor(session.id);
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
    const failure = error instanceof InjectionError ? error : new InjectionError(409, error.message);
    // Read by bin/watcher-live.js: a reservation may only be given back when
    // nothing was typed.
    failure.typingStarted = typingStarted || Boolean(error && error.typingStarted);
    throw failure;
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
    const bootTarget = claimInjectionTarget({ pane: hosted.id });
    const bootBefore = await readScreen(bootTarget, 30, false, deps);
    await probeSuggestion(bootTarget, bootBefore, deps);
    return typeAndSubmit(bootTarget, text, claudeTypedTextVisible, deps);
  }

  const session = (deps.loadCurrentSession || loadCurrentSession)(body.sessionId);
  const target = claimInjectionTarget(await resolveSessionTarget(session, body.pane ? { expectedPane: body.pane } : targetHint, deps));
  return (deps.sendToResolvedTarget || sendToResolvedTarget)(session, target, text, opts, deps);
}

// The watcher's transport: the only way a verdict becomes keystrokes. The same
// precondition is checked three times inside the injection lock — on entering it,
// again after the pane precheck and immediately before the first character, and
// once more after the typing is confirmed and before Enter. Resolving a target
// and typing 200 characters at a time is not instant, so a switch turned off, a
// session that moved on, or a human who started typing in between has to stop
// this at whichever of the three it reaches — and typeAndSubmit clears the draft
// when the abort lands after the text is already in the box.
function watcherSend({ sessionId, pane, text, precondition }, deps = {}) {
  const lock = deps.withInjectionLock || withInjectionLock;
  const send = deps.sendToSession || sendToSession;
  return lock(async () => {
    const guard = async () => {
      const movedOn = precondition ? await precondition() : null;
      if (movedOn) throw new InjectionError(409, movedOn);
    };
    await guard();
    return send({ sessionId, pane, text }, undefined, { beforeType: guard },
      { ...(deps.sendDeps || {}), beforeEnter: guard, discardDraftOnAbort: true, requireExactDraft: true });
  }, { session: sessionId, pane, model: modelCommandText(text) });
}

// A typed /model rewrites settings.json, which a running compaction restores
// unconditionally, so such a send also needs the model key.
function modelCommandText(text) {
  return /^\s*\/model(?:\s|$)/.test(String(text ?? ''));
}

// /api/send: lock the addressed session (and its selected pane, if any); sendToSession
// claims the resolved pane before the precheck, so sends to other panes proceed.
function sendToSessionLocked(body, deps = {}) {
  const request = body && typeof body === 'object' ? body : {};
  return withInjectionLock(() => sendToSession(request, undefined, undefined, deps),
    { session: request.sessionId, pane: request.pane, model: modelCommandText(request.text) });
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
    const target = claimInjectionTarget(await resolve(session, null));
    // The transcript can say "parked" while the pane says otherwise (a restarted
    // Claude, a shell prompt, a dialog). Only type when the input box is on screen.
    const screen = await screenOf(target, 30, false);
    if (!agentPromptVisible('claude', screen)) {
      throw new InjectionError(409, 'no Claude prompt visible', { screenTail: screenTail(screen) });
    }
    return deliver(session, target, text);
  }, { session: sessionId });
}

async function compactSessionById(body) {
  body = body && typeof body === 'object' ? body : {};
  const session = loadCurrentSession(body.sessionId);
  const target = claimInjectionTarget(await resolveSessionTarget(session, null));
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

  const target = claimInjectionTarget(await (deps.resolveSessionTarget || resolveSessionTarget)(session, null, deps));
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
  const target = claimInjectionTarget(await (deps.resolveSessionTarget || resolveSessionTarget)(session, null, deps));
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
    if (deps.detectPortableSetup === true) {
      const plain = stripTerminalAnsi(screen);
      const setupKind = CLAUDE_TRUST_MARKERS.some((marker) => plain.includes(marker)) ? 'workspace-trust' : '';
      if (setupKind) {
        const error = new InjectionError(409, `${agent} is awaiting workspace trust in pane ${target.pane}; accept it there, then retry delivery`, {
          awaitingSetup: true, setupKind, screenTail: screenTail(screen),
        });
        error.code = 'KEEP_PORTABLE_TRANSFER_AWAITING_SETUP';
        throw error;
      }
    }
    await sleep(Math.min(500, Math.max(0, deadline - now())));
  }
  throw new InjectionError(504, `${agent} session in ${target.pane} never showed an empty prompt; message not sent`, {
    screenTail: screenTail(screen),
  });
}

async function readHostSessionId(pane, deps = {}) {
  try {
    const result = await hostRequest('get', { pane }, deps);
    const sessionId = result && result.pane && result.pane.meta && result.pane.meta.sessionId;
    return typeof sessionId === 'string' && /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : null;
  } catch { return null; }
}

async function verifyFreshOpenPane(launch, expected, deps = {}) {
  let result;
  try { result = await hostRequest('get', { pane: launch.pane }, deps); }
  catch {
    throw new InjectionError(503, `host pane ${launch.pane} could not be verified after ${expected.agent} opened`);
  }
  const pane = result?.pane;
  const meta = pane?.meta || {};
  if (!pane || pane.id !== launch.pane || pane.alive !== true
      || Number.isInteger(launch.pid) && pane.pid !== launch.pid
      || launch.createdAt != null && pane.createdAt !== launch.createdAt
      || meta.agent !== expected.agent || meta.accountId !== expected.accountId
      || meta.openRequestId !== expected.requestId || meta.launchedAt !== expected.launchedAt
      || path.resolve(meta.project || '') !== expected.project
      || (meta.model || '') !== expected.model) {
    throw new InjectionError(409, `host pane ${launch.pane} changed before its session registration was verified`);
  }
  const sessionId = meta.sessionId;
  if (sessionId == null || sessionId === '') return null;
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new InjectionError(409, `host pane ${launch.pane} has an invalid session registration`);
  }
  return sessionId;
}

async function waitForHostSessionId(pane, deps = {}) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + 15000;
  while (now() < deadline) {
    const sessionId = await readHostSessionId(pane, deps);
    if (sessionId) return sessionId;
    await sleep(Math.min(250, Math.max(0, deadline - now())));
  }
  return null;
}

// The lock may be held by a delivery that started during the wait; give it a
// moment rather than failing the launch after the agent is already up.
async function withInjectionLockRetry(fn, deps = {}, scope) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + 10000;
  for (;;) {
    try { return await withInjectionLock(fn, scope); }
    catch (e) {
      if (!(e instanceof InjectionError) || e.status !== 429 || now() >= deadline) throw e;
      await sleep(250);
    }
  }
}

function isInjectionBusy() { return injectionLocked(); }

function shellQuoteArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const freshOpenOperations = new Map();

// Pane metadata carried over when a pane is replaced — an in-place restart, a force
// restart, an account handoff. `ephemeral` is dropped on purpose: it marks a pane the
// check scheduler opened and may close on its own, and the moment Owner restarts it or
// moves it to another account it is an ordinary session that nobody may reap. The
// original `launchedAt` rides along because the open-request dedupe reads it; with
// `ephemeral` gone the reaper never looks at it.
function adoptedPaneMeta(meta) {
  const { ephemeral, ...rest } = meta || {};
  return rest;
}

// Pane metadata openSession resolves for itself. `repair` and the transfer ids are the
// sharp ones: the self-repair scheduler adopts a pane by `meta.repair`, so an
// annotation that could set it could hand a stray pane the repair agent's identity.
const RESERVED_LAUNCH_META = new Set([
  'agent', 'accountId', 'accountLabel', 'sessionId', 'model', 'project', 'card', 'repair',
  'requester', 'portableTransferId', 'reviewQueueLaunchId', 'openRequestId', 'launchedAt',
]);

function annotationMeta(launchMeta) {
  if (!launchMeta || typeof launchMeta !== 'object') return {};
  return Object.fromEntries(Object.entries(launchMeta).filter(([key]) => !RESERVED_LAUNCH_META.has(key)));
}

async function openSession(body, deps = {}) {
  body = body && typeof body === 'object' ? body : {};
  const freshStandalone = body.fresh === true && !body.taskId && !body.sessionId;
  if (body.agent != null && !['claude', 'codex'].includes(body.agent)) throw new InjectionError(400, 'agent must be claude or codex');
  if (body.command != null) throw new InjectionError(400, 'command is not accepted');
  // `deps.launchEnv` is an internal seam — the self-repair scheduler sets
  // KEEP_REPAIR=1 on the pane it opens. It is never settable over HTTP: a body
  // that could name environment variables would hand any caller the guard's off
  // switch, and the auth tokens of whichever account the pane runs as.
  if (body.launchEnv != null || body.env != null) throw new InjectionError(400, 'env is not accepted');
  // `deps.launchMeta` is the same kind of internal seam for pane metadata — the check
  // scheduler stamps `ephemeral: 'check'` so its own sweep can find the pane again.
  // Never settable over HTTP: pane meta is what the dedupe, the repair guard and the
  // sweep all key on, so a caller that could write it could make a pane lie about
  // whose it is.
  if (body.launchMeta != null) throw new InjectionError(400, 'launch meta is not accepted');
  if (body.cwd != null && (typeof body.cwd !== 'string' || !body.cwd || /[\r\n\0]/.test(body.cwd))) {
    throw new InjectionError(400, 'cwd must be a directory path');
  }
  if (body.cwd != null && body.fresh !== true) {
    throw new InjectionError(400, 'cwd is accepted only for a fresh card or standalone agent session');
  }
  if (body.model != null && (typeof body.model !== 'string' || !keep.LAUNCH_MODEL_RE.test(body.model))) {
    throw new InjectionError(400, 'model must be a model id like claude-fable-5-1 or gpt-5.6-sol');
  }
  // The model rides the launched command line only; it never writes settings.json.
  const launchModel = body.model || '';
  if (body.message != null && String(body.message).length > keep.OPEN_MESSAGE_LIMIT) {
    throw new InjectionError(400, keep.OPEN_MESSAGE_ERROR);
  }
  const message = body.message == null ? '' : normalizedText(body.message);
  if (body.message != null && !message) throw new InjectionError(400, 'message is empty');
  if (body.requester != null && (typeof body.requester !== 'string' || !/^[A-Za-z0-9_-]+$/.test(body.requester))) {
    throw new InjectionError(400, 'bad requester session id');
  }
  if (body.portableTransferId != null && (typeof body.portableTransferId !== 'string'
      || !/^[a-f0-9]{64}$/.test(body.portableTransferId))) {
    throw new InjectionError(400, 'bad portable transfer id');
  }
  if (body.portableTransferId != null && (typeof body.portableSourceSessionId !== 'string'
      || !/^[A-Za-z0-9_-]+$/.test(body.portableSourceSessionId))) {
    throw new InjectionError(400, 'bad portable source session id');
  }
  if (body.reviewQueueLaunchId != null && (typeof body.reviewQueueLaunchId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(body.reviewQueueLaunchId))) {
    throw new InjectionError(400, 'bad review queue launch id');
  }
  if (body.requestId != null && (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.requestId))) {
    throw new InjectionError(400, 'bad open request id');
  }
  if (freshStandalone && body.requestId && !deps.freshOpenClaimed) {
    const identity = JSON.stringify({ cwd: body.cwd, agent: body.agent, accountId: body.accountId, model: body.model || '' });
    const running = freshOpenOperations.get(body.requestId);
    if (running) {
      if (running.identity !== identity) throw new InjectionError(409, 'open request is already launching a different selection');
      return running.promise;
    }
    const promise = openSession(body, { ...deps, freshOpenClaimed: true });
    freshOpenOperations.set(body.requestId, { identity, promise });
    try { return await promise; }
    finally { if (freshOpenOperations.get(body.requestId)?.promise === promise) freshOpenOperations.delete(body.requestId); }
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
  } else if (body.fresh === true && body.cwd) {
    project = body.cwd;
  }

  if (typeof project !== 'string' || !project) throw new InjectionError(400, `no project for ${body.taskId ? `task ${body.taskId}` : `session ${body.sessionId || '?'}`}`);
  project = path.resolve(project.replace(/^~(?=\/|$)/, os.homedir()));
  try { if (!fs.statSync(project).isDirectory()) throw new Error(); }
  catch { throw new InjectionError(400, 'project directory does not exist'); }
  if (body.cwd != null) {
    let launchCwd = path.resolve(body.cwd.replace(/^~(?=\/|$)/, os.homedir()));
    try {
      launchCwd = fs.realpathSync(launchCwd);
      if (!fs.statSync(launchCwd).isDirectory()) throw new Error();
    } catch { throw new InjectionError(400, 'cwd directory does not exist'); }
    if (body.taskId && !keep.projectMatchesCwd(project, launchCwd)) {
      throw new InjectionError(409, 'cwd is not part of the card project');
    }
    project = launchCwd;
  }
  if (body.fresh) session = null;

  const agent = (session && (session.kind || session.agent)) || body.agent || 'claude';
  if (!['claude', 'codex'].includes(agent)) throw new InjectionError(400, 'agent must be claude or codex');
  if (session && (typeof session.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(session.id))) {
    throw new InjectionError(400, 'bad session id');
  }
  let account;
  if (session) {
    try { account = accounts.forSession(session.id, agent, { root: deps.root || keep.ROOT, env: deps.env || process.env }); }
    catch (error) { throw new InjectionError(409, error.message); }
    if (!account && session.accountId) {
      account = accounts.get(session.accountId, deps.env || process.env);
      if (!account || account.agent !== agent) {
        throw new InjectionError(409, `session ${session.id.slice(0, 8)} belongs to unavailable account ${session.accountId}`);
      }
    }
    account ||= accounts.defaultFor(agent, deps.env || process.env);
    if (body.accountId != null && body.accountId !== account.id) {
      throw new InjectionError(409, `session ${session.id.slice(0, 8)} is pinned to account ${account.id}; use handoff to transfer it`);
    }
    if (account.managed) accounts.pinSession(session.id, agent, account.id, { root: deps.root || keep.ROOT, env: deps.env || process.env });
  } else {
    account = body.accountId == null ? accounts.defaultFor(agent, deps.env || process.env) : accounts.get(body.accountId, deps.env || process.env);
    if (!account || account.agent !== agent) throw new InjectionError(400, `account ${body.accountId || '?'} is not a ${agent} account`);
  }
  const allowPendingRegistration = freshStandalone && agent === 'codex' && !message && Boolean(body.requestId)
    && !body.portableTransferId && !body.reviewQueueLaunchId
    && !deps.onSessionReady && !deps.onOpeningReady && !deps.onOpeningDelivered;
  const deferReadiness = freshStandalone && agent === 'claude' && !message
    && !body.portableTransferId && !body.reviewQueueLaunchId
    && !deps.onSessionReady && !deps.onOpeningReady && !deps.onOpeningDelivered;
  if (freshStandalone && body.requestId) {
    const panes = await (deps.listHostPanes || listHostPanes)(deps, true);
    if (!Array.isArray(panes)) {
      throw new InjectionError(503, 'terminal host is unavailable; open request identity cannot be verified');
    }
    const matches = (panes || []).filter((entry) => entry?.meta?.openRequestId === body.requestId);
    if (matches.length > 1) throw new InjectionError(409, 'open request matches multiple host panes');
    if (matches.length === 1) {
      const existing = matches[0];
      if (existing.meta?.agent !== agent || existing.meta?.accountId !== account.id
          || path.resolve(existing.meta?.project || '') !== project
          || (existing.meta?.model || '') !== launchModel
          || !Number.isFinite(Number(existing.meta?.launchedAt))) {
        throw new InjectionError(409, 'open request was already used for a different launch');
      }
      const registeredId = existing.meta?.sessionId;
      if (registeredId != null && registeredId !== ''
          && (typeof registeredId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(registeredId))) {
        throw new InjectionError(409, 'open request has an invalid session registration');
      }
      const sessionId = registeredId || null;
      if (agent === 'codex' && (existing.alive !== true || existing.agentAlive === false)
          && (sessionId || allowPendingRegistration)) {
        throw new InjectionError(409, `existing host pane ${existing.id} is no longer running the requested Codex session`, {
          code: 'OPEN_EXISTING_PANE', launch: { pane: existing.id, sessionId,
            accountId: account.id, agent, recoverable: true },
        });
      }
      if (sessionId && agent === 'codex') {
        let authority;
        try {
          authority = (deps.accountForSession || accounts.forSession)(sessionId, agent, {
            root: deps.root || keep.ROOT, env: deps.env || process.env, allowDiscovery: false,
          });
        } catch (error) { throw new InjectionError(409, error.message); }
        if (authority && authority.id !== account.id) {
          throw new InjectionError(409, `session ${sessionId.slice(0, 8)} is pinned to account ${authority.id}`);
        }
        if (!authority) {
          (deps.pinSession || accounts.pinSession)(sessionId, agent, account.id,
            { root: deps.root || keep.ROOT, env: deps.env || process.env });
        }
      }
      return { ok: true, existing: true, focus: 'console', pane: existing.id,
        sessionId, accountId: account.id, accountLabel: account.label,
        agent, recoverable: existing.agentAlive === false,
        ...(!sessionId && allowPendingRegistration ? { pendingRegistration: true } : {}) };
    }
  }
  let accountMcpConfig = '';
  if (agent === 'claude' && require('./account-setup').readSetup(account)) {
    try { accountMcpConfig = require('./account-setup').ensureSharedMemory(account, project).mcpConfig; }
    catch (error) { throw new InjectionError(409, `account shared setup is unavailable: ${error.message}`); }
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
      ? ['codex', ...codexFlagArgs, ...(launchModel ? ['-m', launchModel] : []), ...(sessionId ? ['resume', sessionId] : [])]
      : ['claude', ...claudeFlagArgs, ...(accountMcpConfig ? ['--mcp-config', accountMcpConfig] : []), ...(launchModel ? ['--model', launchModel] : []),
        ...(sessionId ? [session ? '--resume' : '--session-id', sessionId] : [])];
    const command = argv.join(' ');
    // A launch that bypasses permission prompts has already crossed the boundary the
    // trust dialog guards; launches with the normal approval flags keep the dialog.
    if (agent === 'claude' && claudeFlagArgs.includes('--dangerously-skip-permissions')) {
      try { (deps.trustProject || require('./account-setup').trustProject)(account, project); }
      catch (error) {
        const detail = String(error?.message || error).replace(/[\r\n]+/g, ' ');
        process.stderr.write(`keep serve: could not pre-trust ${project} for ${account.id}: ${detail}\n`);
      }
    }
    const spawned = await hostRequest('spawn', {
      cmd: '/bin/zsh',
      args: ['-lic', `exec ${require('./agent-launcher').profileCommand(argv, account)}`],
      // A resume of a recorded repair session re-earns the marker; a fresh launch
      // carries it in deps.launchEnv, which the scheduler passes.
      env: require('./agent-launcher').launcherEnv({ ...repairEnvFor({ sessionId }, deps), ...deps.launchEnv }),
      cwd: project,
      cols: 200,
      rows: 50,
      meta: {
        // An internal launchMeta may annotate a pane, never claim to be a different
        // agent, account, card or scheduler: every key this block owns is stripped out
        // of it, and it is spread first so the resolved values win regardless.
        ...annotationMeta(deps.launchMeta),
        agent,
        accountId: account.id,
        accountLabel: account.label,
        sessionId,
        // Recorded so the console and the compaction restore read the launch model
        // from the pane instead of inferring it from the transcript.
        ...(launchModel ? { model: launchModel } : {}),
        project,
        card: body.taskId || null,
        // Marks the pane as the self-repair scheduler's own agent, not merely a
        // session on its card. Owner's "Start work" on a repair card, and a
        // reviewer's discuss session on it, both carry `card` and must never be
        // mistaken for the repair agent — by the scheduler's dedupe or anything else.
        ...(deps.launchEnv && deps.launchEnv.KEEP_REPAIR === '1' ? { repair: true } : {}),
        requester: body.requester || null,
        ...(body.portableTransferId ? { portableTransferId: body.portableTransferId } : {}),
        ...(body.reviewQueueLaunchId ? { reviewQueueLaunchId: body.reviewQueueLaunchId } : {}),
        ...(freshStandalone && body.requestId ? { openRequestId: body.requestId } : {}),
        launchedAt,
      },
    }, deps);
    const pane = spawned && spawned.pane && spawned.pane.id;
    if (!pane) throw new Error('terminal host did not return a pane');
    return { ok: true, created: 'pane', command, pane, sessionId, accountId: account.id, accountLabel: account.label,
      ...(Number.isInteger(spawned.pane.pid) ? { pid: spawned.pane.pid } : {}),
      ...(spawned.pane.createdAt != null ? { createdAt: spawned.pane.createdAt } : {}) };
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
      }, { pane: target.pane, session: session.id, model: modelCommandText(message) });
    }
  }

  // A new pane has no lock to collide with. The launched agent reads settings.json's
  // model at startup, so it holds only the model key: never start mid-compaction.
  const launch = await withInjectionLock(launchHost, { model: true });
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

  const target = { pane: launch.pane };
  let launchPrepared = false;
  try {
    if (launch.sessionId) {
      (deps.pinSession || accounts.pinSession)(launch.sessionId, agent, account.id,
        { root: deps.root || keep.ROOT, env: deps.env || process.env });
    }
    if (deps.onLaunched) await deps.onLaunched(launch);
    launchPrepared = true;
    release();
    if (deferReadiness) {
      // The console shows the pane immediately while Claude boots or displays its trust
      // dialog; openRequestId pane metadata still dedupes a retry of the same request.
      launch.settled = false;
    } else {
      await (deps.waitForHostAgent || waitForHostAgent)(target, agent,
        freshStandalone ? { ...deps, detectPortableSetup: true } : deps);
      launch.settled = true;
    }
    if (!launch.sessionId && allowPendingRegistration) {
      launch.sessionId = await (deps.verifyFreshOpenPane || verifyFreshOpenPane)(launch, {
        agent, accountId: account.id, requestId: body.requestId, launchedAt, project, model: launchModel,
      }, deps);
      if (!launch.sessionId) launch.pendingRegistration = true;
    } else if (!launch.sessionId && (handoff || freshStandalone || deps.onSessionReady)) {
      launch.sessionId = await (deps.waitForHostSessionId || waitForHostSessionId)(launch.pane, deps);
      if (!launch.sessionId) {
        throw new InjectionError(504, `${agent} started in host pane ${launch.pane} but never registered its session id`);
      }
    }
    if (body.reviewQueueLaunchId && launch.sessionId) {
      await assertReviewQueuePaneBinding({ pane: launch.pane, launchId: body.reviewQueueLaunchId,
        accountId: account.id, agent, sessionId: launch.sessionId, pid: launch.pid, createdAt: launch.createdAt }, deps);
    }
    if (launch.sessionId && deps.onSessionReady && await deps.onSessionReady(launch) === false) {
      throw new InjectionError(409, 'session launch reservation changed before opening instructions were sent');
    }
    if (message) {
      if (body.portableTransferId) {
        launch.sessionId ||= await (deps.waitForHostSessionId || waitForHostSessionId)(launch.pane, deps);
        if (!launch.sessionId || launch.sessionId === body.portableSourceSessionId) {
          throw new InjectionError(409, 'portable successor session identity was not verified before instructions were sent');
        }
      }
      await withInjectionLockRetry(
        async () => {
          if (body.portableTransferId) await assertPortablePaneBinding({
            pane: launch.pane, transferId: body.portableTransferId, accountId: account.id,
            cardId: body.taskId || null, sessionId: launch.sessionId, pid: launch.pid, createdAt: launch.createdAt,
          }, deps);
          if (body.reviewQueueLaunchId) await assertReviewQueuePaneBinding({
            pane: launch.pane, launchId: body.reviewQueueLaunchId, accountId: account.id,
            agent, sessionId: launch.sessionId, pid: launch.pid, createdAt: launch.createdAt,
          }, deps);
          if (deps.onOpeningReady && await deps.onOpeningReady(launch) === false) {
            throw new InjectionError(409, 'opening-message reservation changed before instructions were sent');
          }
          return (deps.typeOpeningMessage || typeOpeningMessage)(target, agent, message, deps);
        }, deps,
        { pane: target.pane, model: modelCommandText(message) },
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
    if (launch.sessionId && !deferReadiness) {
      (deps.pinSession || accounts.pinSession)(launch.sessionId, agent, account.id,
        { root: deps.root || keep.ROOT, env: deps.env || process.env });
    }
  } catch (error) {
    if (error?.extra?.awaitingSetup) error.extra.launch = { pane: launch.pane, sessionId: launch.sessionId, accountId: launch.accountId };
    if (freshStandalone) {
      const extra = { ...(error.extra || {}), code: 'OPEN_EXISTING_PANE',
        launch: { pane: launch.pane, sessionId: launch.sessionId || null, accountId: account.id,
          agent, recoverable: true } };
      if (!(error instanceof InjectionError)) {
        throw new InjectionError(Number(error?.status) || 502,
          String(error?.message || error).slice(0, 500), extra);
      }
      error.extra = extra;
    } else {
      // The pane is up and an agent is running in it. Everything that throws from
      // here on — the readiness wait, the opening message, a reservation check —
      // leaves that agent alive, so the caller has to be able to tell "nothing
      // started" from "it started and I could not confirm the rest". Without this
      // a caller that retries on failure opens a second agent on the same work.
      const started = { pane: launch.pane, sessionId: launch.sessionId || null, accountId: account.id, agent };
      if (error instanceof InjectionError) error.extra = { ...(error.extra || {}), launch: started };
      else if (error && typeof error === 'object') error.launch ||= started;
    }
    throw error;
  } finally {
    if (launchPrepared) release();
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

const reopenOperations = new Map();

async function reopenSessionOnAccount(body, deps = {}) {
  body = body && typeof body === 'object' ? body : {};
  if (Object.keys(body).some((key) => !['sessionId', 'accountId'].includes(key))
      || typeof body.sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(body.sessionId)
      || !accounts.ID_RE.test(String(body.accountId || ''))) {
    throw new InjectionError(400, 'Expected exact session and target account');
  }
  const root = deps.root || keep.ROOT;
  const env = deps.env || process.env;
  const session = (deps.resolveSessionId || resolveSessionId)(body.sessionId, deps);
  const agent = session.kind || session.agent;
  if (!['claude', 'codex'].includes(agent)) throw new InjectionError(409, 'Session provider does not support native account reopen');
  const target = accounts.get(body.accountId, env);
  if (!target || target.agent !== agent) throw new InjectionError(400, `account ${body.accountId} is not a ${agent} account`);
  const running = reopenOperations.get(session.id);
  if (running) {
    if (running.accountId !== target.id) throw new InjectionError(409, 'A different account reopen is already running for this session');
    return running.promise;
  }
  const promise = (async () => {
    const handoffs = require('./account-handoff').list(root);
    const recorded = handoffs.find((entry) => entry.sessionId === session.id);
    if (recorded && !['done', 'failed'].includes(recorded.status)) {
      if (recorded.targetAccountId !== target.id || recorded.intent !== 'open-only') {
        throw new InjectionError(409, 'A different account handoff is already pending for this session');
      }
      return (deps.handoffSession || handoffSession)({ sessionId: session.id, pane: recorded.pane,
        accountId: target.id, intent: 'open-only' }, deps);
    }
    if (recorded?.status === 'done' && recorded.targetAccountId === target.id && recorded.intent === 'open-only') {
      return (deps.openSession || openSession)({ sessionId: session.id, accountId: target.id }, deps);
    }
    let source;
    try { source = accounts.forSession(session.id, agent, { root, env }); }
    catch (error) { throw new InjectionError(409, error.message); }
    source ||= session.accountId ? accounts.get(session.accountId, env) : accounts.defaultFor(agent, env);
    if (!source || source.agent !== agent) throw new InjectionError(409, 'Recorded source account is unavailable');
    if (source.id === target.id) return (deps.openSession || openSession)({ sessionId: session.id, accountId: target.id }, deps);

    const panes = await (deps.listHostPanes || listHostPanes)(deps, true);
    const competing = (panes || []).filter((pane) => pane?.alive !== false && pane.meta?.sessionId === session.id);
    if (competing.length > 1) throw new InjectionError(409, 'Multiple live panes own this session; close the competing session before reopening it');
    if (competing[0]?.agentAlive === false) {
      throw new InjectionError(409, 'The source pane exists but its agent setup is incomplete; open that pane and finish setup', {
        code: 'OPEN_EXISTING_PANE', launch: { pane: competing[0].id, sessionId: session.id,
          accountId: source.id, agent, recoverable: true },
      });
    }
    const opened = await (deps.openSession || openSession)({ sessionId: session.id, accountId: source.id }, deps);
    if (!opened?.pane) throw new InjectionError(502, 'Source session did not open in a verified pane');
    return (deps.handoffSession || handoffSession)({ sessionId: session.id, pane: opened.pane,
      accountId: target.id, intent: 'open-only' }, deps);
  })();
  reopenOperations.set(session.id, { accountId: target.id, promise });
  try { return await promise; }
  finally { if (reopenOperations.get(session.id)?.promise === promise) reopenOperations.delete(session.id); }
}

function resolveReviewLaunchSelection(body, deps = {}) {
  const env = deps.env || process.env;
  const explicitAccount = body.accountId != null;
  let account = explicitAccount ? accounts.get(body.accountId, env) : null;
  if (explicitAccount && !account) throw new reviewQueue.QueueError(400, `unknown account ${body.accountId}`);
  const agent = body.agent || account?.agent || 'claude';
  if (!['claude', 'codex'].includes(agent)) throw new reviewQueue.QueueError(400, 'review queue agent is invalid');
  if (!explicitAccount) account = accounts.defaultFor(agent, env);
  if (!account || account.agent !== agent) {
    throw new reviewQueue.QueueError(400, `account ${body.accountId || '?'} is not a ${agent} account`);
  }
  const model = body.model || '';
  if (model && !keep.LAUNCH_MODEL_RE.test(model)) throw new reviewQueue.QueueError(400, 'review queue model is invalid');
  return { agent, accountId: account.id, model };
}

async function launchReviewQueueSession(request, deps = {}) {
  const open = deps.openSession || openSession;
  return open({
    taskId: request.taskId,
    fresh: true,
    agent: request.agent,
    accountId: request.accountId,
    ...(request.model ? { model: request.model } : {}),
    message: request.message,
    reviewQueueLaunchId: request.launchId,
  }, {
    ...deps,
    loadTask: deps.loadTask || keep.loadTaskAnywhere,
    randomUUID: () => request.sessionId,
    onLaunched: request.onLaunched,
    onSessionReady: request.onSessionReady,
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
  const matches = panes.filter((pane) => pane?.meta?.reviewQueueLaunchId === active.launchId
    || active.sessionId && pane?.meta?.sessionId === active.sessionId);
  if (matches.length > 1) return { state: 'unknown', message: 'multiple terminal panes match the reserved review conversation' };
  const present = matches.find((pane) => pane.alive !== false && pane.agentAlive !== false);
  if (present) {
    if (present.meta?.agent !== active.agent || present.meta?.accountId !== active.accountId
        || active.sessionId && present.meta?.sessionId !== active.sessionId
        || active.pane && present.id !== active.pane
        || active.panePid && present.pid !== active.panePid
        || active.paneCreatedAt != null && present.createdAt !== active.paneCreatedAt) {
      return { state: 'unknown', pane: present.id, message: 'reserved review conversation identity changed' };
    }
    return { state: 'present', pane: present.id, sessionId: present.meta?.sessionId || active.sessionId || null };
  }
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
  await (deps.waitForHostAgent || waitForHostAgent)(target, active.agent, deps);
  const sessionId = active.sessionId || await (deps.waitForHostSessionId || waitForHostSessionId)(active.pane, deps);
  if (!sessionId) throw new InjectionError(409, 'review queue conversation session identity was not verified');
  await assertReviewQueuePaneBinding({ pane: active.pane, launchId: active.launchId,
    accountId: active.accountId, agent: active.agent, sessionId,
    pid: active.panePid, createdAt: active.paneCreatedAt }, deps);
  if (typeof hooks.onSessionReady === 'function' && await hooks.onSessionReady({ ...active, sessionId }) !== true) {
    throw new InjectionError(409, 'review queue launch reservation changed before session registration');
  }
  await withInjectionLockRetry(
    async () => {
      await assertReviewQueuePaneBinding({ pane: active.pane, launchId: active.launchId,
        accountId: active.accountId, agent: active.agent, sessionId,
        pid: active.panePid, createdAt: active.paneCreatedAt }, deps);
      if (await hooks.onReady() !== true) {
        throw new InjectionError(409, 'review queue launch reservation changed before opening instructions were sent');
      }
      return (deps.typeOpeningMessage || typeOpeningMessage)(target, active.agent, active.pointer, deps);
    }, deps, { pane: target.pane },
  );
  if (typeof hooks.onDelivered === 'function' && await hooks.onDelivered() !== true) {
    throw new InjectionError(409, 'review queue launch reservation changed after opening instructions were sent');
  }
  if (active.action === 'start' && active.card) {
    try { (deps.linkLaunchedSession || keep.linkLaunchedSession)(active.card, { id: sessionId, agent: active.agent }); }
    catch (error) { process.stderr.write(`keep serve: could not link recovered review queue session ${sessionId.slice(0, 8)} to ${active.card}: ${error.message}\n`); }
  }
  return { sessionId, pane: active.pane, sent: true };
}
const scanCache = require('./stat-parse-cache').createStatParseCache({
  // The byte budget is the useful bound here. A busy fleet can have several
  // thousand small recent transcripts; a lower entry cap makes a stable scan
  // order evict the tail before the next pass reaches it and reparses every file.
  maxEntries: 16384,
  maxBytes: 64 * 1024 * 1024,
});
const childScanCache = require('./stat-parse-cache').createStatParseCache({
  maxEntries: 1024,
  maxBytes: 64 * 1024 * 1024,
});
const claudeSessionPathCache = new Map(); // session id -> transcript file
const backgroundTargets = new Map();
let backgroundJobScheduler = null;
const claudeSessionParseCache = new Map(); // file -> { mtimeMs, size, info }
const SESSION_LOOKUP_CACHE_LIMIT = 300;
// Dashboard-only: action paths never consult this cache. A worker restart starts
// cold, so restart inspection always rebuilds transcript and lifecycle state.
const settledSessionCache = createSettledSessionCache({ maxEntries: 512 });
let sessionSnapshot = [];
let sessionSnapshotAt = 0;
let lastDashboardSessionScan = 0;
let lastStalledSessionScan = 0;
let codexDashboardRows = new Map();
let codexDashboardFullScanAt = 0;
let codexDashboardDiscoveryDirty = true;
const CODEX_DASHBOARD_FULL_SCAN_MS = 5 * 60e3;

function scanChildTranscript(file) {
  try {
    const stat = fs.statSync(file);
    return childScanCache.get(file, stat,
      () => scanTranscript(file, { includeSidechain: true }),
      (value) => Buffer.byteLength(JSON.stringify(value)));
  } catch (error) {
    childScanCache.delete(file);
    throw error;
  }
}

// A permanent history gap can only clear by replaying the whole transcript, so
// ask for one on an idle live session whose transcript has been quiet for half
// an hour, at most hourly, and never while a turn or tool is still running.
function coldReplayDue(session, jobs, mtime, live, now) {
  return jobs?.gap === true && live === true && session.endedTurn === true
    && !session.toolRunning && !session.pendingQuestion && !session.pendingPlan
    && now - mtime >= 30 * 60e3
    && !(jobs.lastColdReplayAt > now - 60 * 60e3);
}

function registerBackgroundTarget(target) {
  if (!target?.agent || !target?.sid || !target?.file) return;
  backgroundTargets.set(`${target.agent}:${target.sid}`, target);
  backgroundJobScheduler?.register(target);
}

function cacheClaudeSessionLookup(cache, key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > SESSION_LOOKUP_CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function claudeSessionFromInfo(id, info, stat, dir, reviewer, now, accountId = null) {
  if (info.backgroundParentFile) cacheClaudeSessionLookup(claudeSessionPathCache, id, info.backgroundParentFile);
  const activityMs = transcriptActivityMs(info, stat.mtimeMs);
  const ageMs = now - activityMs;
  const lifecycle = require('./session-lifecycle');
  const lifecycleEvents = lifecycle.read(keep.ROOT, id, now);
  const lifecycleAgents = info.backgroundParentFile ? lifecycle.pendingAgents(lifecycleEvents,
    info.backgroundParentFile, scanChildTranscript, now, info.completedAgents) : [];
  return {
    id,
    kind: 'claude',
    ...(accountId ? { accountId } : {}),
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

function claudeSessionForEntry(id, file, stat, accountId = null) {
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
  return claudeSessionFromInfo(id, info, stat, dir, reviewer, Date.now(), accountId);
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
  }
  cacheClaudeSessionLookup(claudeSessionPathCache, id, file);
  let accountId = null;
  try { accountId = accounts.forSession(id, 'claude', { root: keep.ROOT })?.id || null; } catch {}
  return claudeSessionForEntry(id, file, stat, accountId);
}

// Host-only sessions were absent from the recent-session result, but their old
// transcripts are already present in the dashboard index. Resolve every host
// pane from one snapshot instead of walking every account's project tree once
// or twice per pane. Action paths do not consume this bounded snapshot.
function createDashboardClaudeSessionResolver(deps = {}) {
  const rows = deps.rows || claudeTranscriptIndex.scan();
  const authority = deps.authority || accounts.authority(deps.root || keep.ROOT);
  const configuredAccounts = new Set(deps.accountIds || claudeProjectRoots.map((entry) => entry.accountId));
  const byId = new Map();
  for (const row of rows) {
    const matches = byId.get(row.id) || [];
    matches.push(row);
    byId.set(row.id, matches);
  }
  const sessionForEntry = deps.sessionForEntry || claudeSessionForEntry;
  return (sessionId) => {
    const id = String(sessionId || '');
    const matches = byId.get(id) || [];
    const record = authority[id];
    let pinnedId = null;
    let accountId = null;
    let authorityFailed = false;
    if (record) {
      if (record.agent === 'claude' && configuredAccounts.has(record.accountId)) {
        pinnedId = record.accountId;
        // An unfinished handoff deliberately has no ordinary resume account.
        if (!record.stagedAccountId) accountId = record.accountId;
      } else {
        authorityFailed = true;
      }
    }
    if (!record) {
      const accountIds = [...new Set(matches.map((entry) => entry.accountId))];
      if (accountIds.length > 1) throw new Error(`session ${id} exists in multiple accounts without authority`);
      if (accountIds.length === 1) pinnedId = accountId = accountIds[0];
    }
    let entry = null;
    if (pinnedId) {
      entry = matches.find((candidate) => candidate.accountId === pinnedId) || null;
      if (!entry) {
        const fallback = matches.filter((candidate) => candidate.accountId !== pinnedId);
        if (fallback.length > 1) throw new Error(`session ${id} exists in multiple accounts without authority`);
        entry = fallback[0] || null;
      }
    } else {
      if (authorityFailed && matches.length > 1) throw new Error(`session ${id} exists in multiple accounts without authority`);
      entry = matches[0] || null;
    }
    if (!entry) return null;
    const cached = deps.dashboardWorker === true ? settledSessionCache.get({
      agent: 'claude', id, file: entry.file, stat: entry.stat, accountId,
      pane: deps.hostPanesBySession?.get(id), independentLive: deps.independentLive?.has(id), now: Date.now(),
    }) : null;
    const session = cached?.session || sessionForEntry(id, entry.file, entry.stat, accountId);
    if (cached?.backgroundJobs) deps.onSettledHit?.(session, cached.backgroundJobs);
    if (session) deps.onSessionSource?.(session, entry.file, entry.stat);
    return session;
  };
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
  const accountAuthority = options.accountAuthority || accounts.authority(keep.ROOT);
  const panesBySession = options.hostPanesBySession || hostPanesBySession(options.hostPanes || []);
  const transcriptRows = claudeTranscriptIndex.scan({ fresh: options.dashboard !== true });
  if (typeof options.onTranscriptRows === 'function') options.onTranscriptRows(transcriptRows);
  for (const { dir, file, id, stat, accountId } of transcriptRows) {
    if (accountAuthority[id]?.accountId && accountAuthority[id].accountId !== accountId) continue;
    if (sessionIds.has(id)) continue;
    sessionIds.add(id);
    if (spawned.has(id) || now - stat.mtimeMs > SESSION_WINDOW_MS) continue;
    seen.add(file);
    const cached = options.dashboardWorker === true ? settledSessionCache.get({
      agent: 'claude', id, file, stat, accountId, pane: panesBySession.get(id),
      independentLive: options.independentLive?.has(id), now,
    }) : null;
    let info;
    if (!cached) try {
      info = scanCache.get(file, stat, () => {
        const parsed = scanTranscript(file);
        // Most recent files in a large fleet are headless task transcripts.
        // Cache their negative classification as null instead of retaining the
        // much larger parse result solely to discard it below on every scan.
        return claudeTranscriptIsInteractive(file, parsed, stat) ? parsed : null;
      }, (value) => Buffer.byteLength(JSON.stringify(value)));
    } catch { continue; }
    // AI titles are now written to headless `claude -p` transcripts too. Only
    // TUI record types distinguish a conversation from a batch invocation.
    // Explicitly hosted headless history is restored below by host backfill,
    // whose exact session lookup intentionally does not apply this filter.
    if (!cached && !info) continue;
    // Claude can append untimestamped housekeeping records (ai-title, mode,
    // bridge-session) when an old session is merely reopened or inspected. Those
    // writes are not conversation activity and must not resurrect the session.
    const activityMs = cached ? cached.session.mtime : transcriptActivityMs(info, stat.mtimeMs);
    const ageMs = now - activityMs;
    if (ageMs > SESSION_WINDOW_MS) continue;
    const session = cached ? cached.session : claudeSessionFromInfo(id, info, stat, dir, reviewers.has(id), now, accountId);
    if (cached?.backgroundJobs) options.onSettledHit?.(session, cached.backgroundJobs);
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
    options.onSessionSource?.(session, file, stat);
  }
  scanCache.retain(seen);
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

function dashboardCodexSessionFor(id, options = {}) {
  let record = codexDashboardRows.get(id) || null;
  const authority = options.accountAuthority?.[id] || null;
  if (authority && (authority.agent !== 'codex' || authority.stagedAccountId)) {
    codexDashboardRows.delete(id);
    return null;
  }
  const authorityAccountId = authority?.accountId || null;
  const authorityChanged = Boolean(record)
    && (record.authorityAccountId || null) !== authorityAccountId;
  if (!record || authorityChanged || (authorityAccountId && record.accountId !== authorityAccountId)) {
    const file = codex.findRolloutFile(id);
    let stat = null;
    try { stat = file && fs.statSync(file); } catch {}
    if (!file || !stat) { codexDashboardRows.delete(id); return null; }
    record = { file, stat, accountId: authorityAccountId, authorityAccountId };
  } else {
    try { record.stat = fs.statSync(record.file); }
    catch { codexDashboardRows.delete(id); return null; }
  }
  const pane = options.hostPanesBySession?.get(id);
  const cached = settledSessionCache.get({ agent: 'codex', id, file: record.file, stat: record.stat,
    accountId: authorityAccountId || record.accountId || null, pane,
    independentLive: options.independentLive?.has(id), now: options.now });
  let session = cached?.session || record.session || null;
  if (!session) {
    try { session = codex.sessionFor(id); } catch {}
  }
  if (!session) { codexDashboardRows.delete(id); return null; }
  // A resolver refresh may have crossed an authority commit. Do not publish the
  // old row's file with the new account's text: re-resolve before exposing it.
  if (authorityAccountId && session.accountId !== authorityAccountId) {
    codexDashboardRows.delete(id);
    return null;
  }
  codexDashboardRows.set(id, { file: record.file, stat: record.stat,
    accountId: session.accountId || authorityAccountId || record.accountId || null,
    authorityAccountId });
  options.onSessionSource?.(session, record.file, record.stat);
  if (cached?.backgroundJobs) options.onSettledHit?.(session, cached.backgroundJobs);
  return session;
}

function scanDashboardCodexSessions(options, now) {
  const full = codexDashboardDiscoveryDirty || !codexDashboardRows.size
    || now < codexDashboardFullScanAt || now - codexDashboardFullScanAt >= CODEX_DASHBOARD_FULL_SCAN_MS;
  if (full) {
    let sessions = [];
    try { sessions = codex.scan({ dashboard: true }); } catch {}
    const next = new Map();
    for (const session of sessions) {
      const file = codex.rolloutFileFor(session.id);
      let stat = null;
      try { stat = file && fs.statSync(file); } catch {}
      const authority = options.accountAuthority?.[session.id];
      if (file && stat) next.set(session.id, { file, stat, accountId: session.accountId || null,
        authorityAccountId: authority?.accountId || null, session });
    }
    codexDashboardRows = next;
    codexDashboardFullScanAt = now;
    codexDashboardDiscoveryDirty = false;
  }
  const sessions = [];
  for (const id of [...codexDashboardRows.keys()]) {
    const session = dashboardCodexSessionFor(id, { ...options, now });
    if (session) sessions.push(session);
  }
  return sessions;
}

function scanSessions(options = {}) {
  const now = Date.now();
  const attentionDir = path.join(keep.ROOT, '.keep', 'attention');
  const sessions = scanClaudeSessions(options);
  let codexSessions = [];
  if (options.dashboardWorker === true) codexSessions = scanDashboardCodexSessions(options, now);
  else try { codexSessions = codex.scan({ dashboard: options.dashboard === true }); } catch {}
  attachCodexMarkers(codexSessions, attentionDir, now, options);
  sessions.push(...codexSessions);
  titles.applyLiveTitles(sessions, { cachedOnly: true });
  sessions.sort((a, b) => b.mtime - a.mtime);
  sessionSnapshot = copySessions(sessions);
  sessionSnapshotAt = now;
  if (options.dashboard === true) lastDashboardSessionScan = now;
  return copySessions(sessionSnapshot);
}

function invalidateDashboardSources(change = {}) {
  settledSessionCache.invalidate(change);
  if (change.kind === 'claude') claudeTranscriptIndex.invalidate(change.root, change.name);
  else if (change.kind === 'codex') {
    let known = false;
    if (change.root && change.name) {
      const changed = path.resolve(change.root, String(change.name));
      known = [...codexDashboardRows.values()].some((entry) => entry.file === changed);
    }
    if (!known) codexDashboardDiscoveryDirty = true;
    codex.invalidate();
  }
  else if (change.kind === 'accounts') codexDashboardDiscoveryDirty = true;
  else if (change.kind === 'all') {
    claudeTranscriptIndex.invalidate();
    codex.invalidate();
    codexDashboardDiscoveryDirty = true;
  }
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

// Which transcripts the turn index should re-read on this tick. Files come from
// the caches the daemon already maintains, so the sweep costs a map lookup per
// session rather than a project-tree walk.
// A codex rollout missing from the scan cache costs a walk of ~90 dated directories
// (60-180ms, synchronous). Found paths never move; misses are retried after a while.
const turnIndexRolloutLookups = new Map();
function liveTurnIndexSessions(deps = {}) {
  const ledger = readLiveSessionLedger(deps);
  const now = (deps.now || Date.now)();
  const wanted = new Map();
  for (const [id, entry] of Object.entries(ledger.sessions || {})) {
    if (!entry || !/^[A-Za-z0-9_-]+$/.test(id)) continue;
    const agent = entry.agent === 'codex' ? 'codex' : 'claude';
    // Week-old sightings would each cost a rollout walk here: hundreds of headless
    // codex runs blocked the event loop for tens of seconds per tick.
    if (!Number.isFinite(entry.lastSeenAlive) || now - entry.lastSeenAlive > TURN_INDEX_LIVE_WINDOW_MS) continue;
    wanted.set(id, { id, agent });
  }
  // A reviewer may be idle enough to have left the live ledger, and its turns are
  // exactly the ones the fleet wants measured.
  try {
    for (const id of fs.readdirSync(path.join(deps.root || keep.ROOT, '.keep', 'reviewer'))) {
      if (/^[A-Za-z0-9_-]+$/.test(id) && !wanted.has(id)) wanted.set(id, { id, agent: 'claude' });
    }
  } catch {}
  for (const id of turnIndexRolloutLookups.keys()) if (!wanted.has(id)) turnIndexRolloutLookups.delete(id);
  if (!wanted.size) return [];
  const claudeFiles = new Map();
  try { for (const row of (deps.scanClaudeTranscripts || (() => claudeTranscriptIndex.scan()))()) claudeFiles.set(row.id, row.file); } catch {}
  const rolloutFileFor = deps.rolloutFileFor || codex.rolloutFileFor;
  const findRolloutFile = deps.findRolloutFile || codex.findRolloutFile;
  const sessions = [];
  for (const entry of wanted.values()) {
    let file = null;
    if (entry.agent === 'codex') {
      try { file = rolloutFileFor(entry.id); } catch {}
      if (!file) {
        const cached = turnIndexRolloutLookups.get(entry.id);
        if (cached && (cached.file || now - cached.at < TURN_INDEX_ROLLOUT_MISS_MS)) file = cached.file;
        else {
          try { file = findRolloutFile(entry.id); } catch {}
          turnIndexRolloutLookups.set(entry.id, { file: file || null, at: now });
        }
      }
    } else file = claudeFiles.get(entry.id) || null;
    if (file) sessions.push({ ...entry, file });
  }
  return sessions;
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

function dashboardSummary(options, target, key, input, instruction, summaryOptions = {}) {
  if (options.dashboardWorker === true) {
    options.collectSummaryRequests?.push({ target, key, input, instruction, options: summaryOptions });
    return summarize.peekSummary(key)?.text || null;
  }
  return summarize.getSummary(key, input, instruction, onChange, summaryOptions).text;
}

function buildState(options = {}) {
  const workerMode = options.dashboardWorker === true;
  const now = typeof options.now === 'function' ? Number(options.now()) : Number(options.now ?? Date.now());
  const liveLedger = readLiveSessionLedger(options);
  const independentLive = stallAliveIds({ ...liveLedger, sessions: Object.fromEntries(
    Object.entries(liveLedger.sessions || {}).filter(([, entry]) => entry.source !== 'host'),
  ) }, now);
  const panesBySession = hostPanesBySession(options.hostPanes || []);
  const dashboardAccountAuthority = workerMode ? accounts.authority(keep.ROOT) : null;
  let cardUsageSummary = null;
  try { cardUsageSummary = cardUsage.snapshot(keep.ROOT); }
  catch (error) {
    if (workerMode) options.collectHealthErrors?.push({ name: 'card-usage', message: error.message });
    else health.record('card-usage', { ok: false, error });
  }
  const tasks = keep.loadAll(false).map((t) => ({
    id: t.id,
    fm: t.fm,
    body: t.body,
    modelUsage: cardUsage.forCard(cardUsageSummary, t.id),
    lastLog: keep.lastLogLine(t),
    overdue: keep.isOverdue(t),
  }));
  let dashboardTranscriptRows = null;
  // This map belongs to one build. Capture each selected source at discovery
  // time so the general-purpose 300-entry lookup LRU cannot evict an earlier
  // published session before its path is relayed to the parent.
  const dashboardSourceFiles = new Map();
  const dashboardSourceEvidence = new Map();
  const settledBackgroundJobs = new Map();
  const rememberDashboardSource = (session, file, stat = null) => {
    if (session?.kind && session?.id && file) {
      const key = `${session.kind}:${session.id}`;
      dashboardSourceFiles.set(key, file);
      if (stat) dashboardSourceEvidence.set(key, { file, stat, accountId: session.accountId || null });
    }
  };
  const sessions = scanSessions({
    dashboard: options.dashboard === true,
    dashboardWorker: workerMode,
    readOnly: workerMode,
    hostPanes: options.hostPanes || [],
    hostPanesBySession: panesBySession,
    independentLive,
    accountAuthority: dashboardAccountAuthority,
    onSessionSource: rememberDashboardSource,
    onSettledHit: (session, jobs) => settledBackgroundJobs.set(`${session.kind}:${session.id}`, jobs),
    ...(options.dashboard === true ? { onTranscriptRows: (rows) => { dashboardTranscriptRows = rows; } } : {}),
  });
  // scanSessions just reconciled this exact index snapshot synchronously. Reuse
  // it for host-only rows instead of statting every project directory again.
  if (Object.prototype.hasOwnProperty.call(options, 'hostPanes')) {
    backfillHostSessions(sessions, options.hostPanes, {
      tasks,
      codexSessionFor: options.codexSessionFor || (workerMode ? (id) => dashboardCodexSessionFor(id, {
        accountAuthority: dashboardAccountAuthority,
        hostPanesBySession: panesBySession,
        independentLive,
        now,
        onSessionSource: rememberDashboardSource,
        onSettledHit: (session, jobs) => settledBackgroundJobs.set(`${session.kind}:${session.id}`, jobs),
      }) : undefined),
      claudeSessionFor: options.claudeSessionFor,
      independentLive,
      dashboard: options.dashboard === true,
      ...(dashboardTranscriptRows ? {
        createDashboardClaudeSessionResolver: () => createDashboardClaudeSessionResolver({
          rows: dashboardTranscriptRows,
          onSessionSource: rememberDashboardSource,
          onSettledHit: (session, jobs) => settledBackgroundJobs.set(`${session.kind}:${session.id}`, jobs),
          dashboardWorker: workerMode,
          hostPanesBySession: panesBySession,
          independentLive,
        }),
      } : {}),
    });
  }
  for (const session of sessions) {
    const key = `${session.kind}:${session.id}`;
    if (session.kind === 'codex' && !dashboardSourceFiles.has(key)) {
      rememberDashboardSource(session, codex.rolloutFileFor(session.id));
    }
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
  titles.applyLiveTitles(sessions, {
    onChange,
    cachedOnly: workerMode,
    taskFor: (session) => taskById.get(session.taskId),
  });
  applySessionLiveness(sessions, liveLedger, options.hostPanes || [], now);
  const dependencyCache = new Map();
  const liveHostedSessions = new Set((options.hostPanes || []).filter((pane) => pane.alive && pane.agentAlive !== false).map((pane) => pane.meta?.sessionId));
  applyHostedExitState(sessions, options.hostPanes, independentLive);
  for (const session of sessions) {
    if (['claude', 'codex'].includes(session.kind) && options.hostPanes) {
      const file = dashboardSourceFiles.get(`${session.kind}:${session.id}`)
        || (session.kind === 'claude' ? claudeSessionPathCache.get(session.id) : codex.rolloutFileFor(session.id));
      if (file) {
        const hosted = options.hostPanes.find(p => p.id === session.runtime?.paneId);
        const sourceEvidence = dashboardSourceEvidence.get(`${session.kind}:${session.id}`)?.stat;
        const jobs = settledBackgroundJobs.get(`${session.kind}:${session.id}`)
          || require('./background-jobs').read(keep.ROOT, session.kind, session.id, now);
        const live = session.runtime?.state === 'live' ? true : session.runtime?.state === 'exited' ? false : null;
        const target = { agent: session.kind, sid: session.id, file,
          ...(sourceEvidence ? { sourceFingerprint: [sourceEvidence.dev, sourceEvidence.ino,
            sourceEvidence.size, sourceEvidence.mtimeMs, sourceEvidence.ctimeMs] } : {}),
          ...(coldReplayDue(session, jobs, sourceEvidence?.mtimeMs ?? session.mtime, live, now) ? { coldReplay: true } : {}),
          instance: { id: require('./background-jobs').processInstance(hosted), processScoped: true, live } };
        if (workerMode) options.collectBackgroundTargets?.push(target);
        else registerBackgroundTarget(target);
        session.backgroundJobs = jobs;
        session.pendingBackground = jobs.pending || (!jobs.caughtUp && session.pendingBackground);
        session.unknownBackgroundJobs = [...new Set([...jobs.uncertain, ...(!jobs.caughtUp ? session.unknownBackgroundJobs || [] : [])])];
      }
    }
  }
  applyCompanionJobs(sessions, options.companion);
  for (const session of sessions) {
    const task = taskById.get(session.taskId);
    if (task && !dependencyCache.has(task.id)) dependencyCache.set(task.id, keep.unresolvedDependencyIds(task));
    session.activity = sessionStatus.activity(session, { task, dependencies: dependencyCache.get(task?.id) || [], live: liveHostedSessions.has(session.id) });
    session.observation = require('./session-model').normalize(session, { task, dependencies: dependencyCache.get(task?.id) || [], live: liveHostedSessions.has(session.id) });
    session.state = session.activity.state;
    session.stateLabel = session.activity.label;
    if (!workerMode) require('./session-debug').record(session, now);
  }
  if (workerMode) {
    const terminal = new Set(['completed', 'failed', 'cancelled']);
    const derived = new Set(['taskId', 'taskStatus', 'runtime', 'pane', 'launchModel', 'accountLabel',
      'backgroundJobs', 'activity', 'observation', 'stateLabel', 'stalled']);
    for (const session of sessions) {
      const key = `${session.kind}:${session.id}`;
      const evidence = dashboardSourceEvidence.get(key);
      const pane = panesBySession.get(session.id);
      const jobs = session.backgroundJobs;
      const eligible = evidence && session.exited === true && session.runtime?.state === 'exited'
        && !independentLive?.has(session.id) && !session.pendingBackground
        && !session.lifecycleForeground && !(session.lifecycleAgents || []).length
        && jobs?.caughtUp === true && jobs.pending === false && !(jobs.uncertain || []).length
        && jobs.recovering === false && jobs.gap === false
        && jobs.unresolvedCalls === 0 && jobs.unconsumedHooks === 0
        && (jobs.jobs || []).every((job) => terminal.has(job.status));
      if (!eligible) {
        settledSessionCache.delete(session.kind, session.id);
        continue;
      }
      const frozen = { ...session };
      for (const field of derived) delete frozen[field];
      delete frozen.notify; // attention markers are refreshed on every build
      settledSessionCache.set({ agent: session.kind, id: session.id, file: evidence.file,
        stat: evidence.stat, accountId: evidence.accountId, pane, independentLive: false, now },
      { session: frozen, backgroundJobs: jobs });
    }
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
  const healthSnapshot = options.dashboardRuntime?.health || health.snapshot(now);
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
  const setAsideState = applySetAside(setAsideCandidates(visibleAttention, sessions), { write: !workerMode });
  if (setAsideState.changed && !workerMode) onChange();
  let digest = null;
  if (workerMode) digest = options.dashboardRuntime?.digest || null;
  else try { digest = ensureDigest(); } catch (e) { process.stderr.write(`keep serve: digest failed: ${e.message}\n`); }
  const alertMeta = alerts.loadMeta(keep.ROOT);
  attachStateLines(sessions);
  const state = {
    generatedAt: Date.now(),
    shadowDecisions: shadowDecisionSummary(),
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
    reminders: reminders.snapshot(),
    alerts: alerts.readAlerts({ root: keep.ROOT, all: true, limit: 10 }),
    brief: alertMeta.lastBriefText ? { at: alertMeta.lastBriefAt || null, text: alertMeta.lastBriefText } : null,
    standup: features.dashboardState('standup', () => standup.dashboardState()),
    landed: landed.dashboardState(),
    limitResume: limitresume.dashboardState(keep.ROOT),
    slack: messageWatcherDashboardState(),
    health: healthSnapshot,
    usage: options.dashboardRuntime?.usage || usage.getUsage(),
    reviewQueue: reviewQueue.snapshot({ loadTasks: () => allTasks, now }),
  };
  Object.assign(state, accounts.publicState(), {
    handoffs: require('./account-handoff').list(keep.ROOT),
  });
  const accountLabels = new Map(state.accounts.map((account) => [account.id, account.label]));
  for (const session of sessions) {
    let accountId = session.accountId;
    if (!accountId) {
      // Scanned transcripts and host metadata already carry discovered accounts.
      // For a missing dashboard row, consult durable authority without repeating
      // a project-tree search for a transcript that was not in the index.
      try { accountId = accounts.forSession(session.id, session.kind, {
        root: keep.ROOT,
        ...(options.dashboard === true ? { allowDiscovery: false } : {}),
      })?.id || null; } catch {}
    }
    if (accountId) { session.accountId = accountId; session.accountLabel = accountLabels.get(accountId) || accountId; }
  }
  try {
    if (digest) digest.summary = dashboardSummary(options, ['digest', 'summary'], `digest-${digest.date}`, digest.md, DIGEST_INSTRUCTION);
  } catch {}
  try {
    const input = tasks
      .filter((t) => ['active', 'review', 'landing'].includes(t.fm.status) && (t.fm.sessions || []).length)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((t) => {
        const logs = [...t.body.matchAll(/^## .*\n([^\n]+)/gm)].slice(0, 3).map((m) => m[1].trim()).filter(Boolean);
        return `Title: ${t.fm.title}\nStatus: ${t.fm.status}\nLatest logs:\n${logs.length ? logs.map((l) => `- ${l}`).join('\n') : '- (none)'}`;
      }).join('\n\n');
    if (input) state.resumeSummary = dashboardSummary(options, ['resumeSummary'], 'resume', input, RESUME_INSTRUCTION);
  } catch {}
  try {
    const review = tasks.filter((t) => t.fm.status === 'review').sort((a, b) => a.id.localeCompare(b.id));
    if (review.length) {
      const input = review.map((t) => `Title: ${t.fm.title}\nLatest log: ${t.lastLog || '(none)'}`).join('\n\n');
      state.reviewSummary = dashboardSummary(options, ['reviewSummary'], 'review', input, REVIEW_INSTRUCTION);
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
    if (input) state.weeklySummary = dashboardSummary(options, ['weeklySummary'], `weekly-${weekAgo.slice(0, 10)}`, input, WEEKLY_INSTRUCTION);
  } catch {}
  try {
    state.reviewUsage = review.reviewerUsage();
    if (state.reviewUsage) {
      const reviewerSession = (state.sessions || []).find((session) => session.reviewer);
      const accountId = reviewerSession && reviewerSession.accountId;
      const selected = accountId && state.usage && state.usage.accounts && state.usage.accounts[accountId];
      const limits = selected ? selected.limits : state.usage && state.usage.claude && state.usage.claude.limits;
      state.reviewUsage.weekly = review.reviewerWeekly(limits || [], accountId);
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
          tickIntervalMs: reviewerStats.cadence ? reviewerStats.cadence.tickIntervalMs : review.TICK_MS,
          cadence: reviewerStats.cadence || null,
          driftWakesToday: Number(((reviewerStats.days || {})[keep.nowStamp().slice(0, 10)] || {}).driftWakes || 0),
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

function dashboardRuntimeSnapshot() {
  let digest = null;
  try { digest = ensureDigest(); }
  catch (error) { process.stderr.write(`keep serve: digest failed: ${error.message}\n`); }
  return { digest, health: health.snapshot(), usage: usage.getUsage() };
}

function setPath(object, pathParts, value) {
  let target = object;
  for (const part of pathParts.slice(0, -1)) {
    if (!target?.[part]) return;
    target = target[part];
  }
  target[pathParts.at(-1)] = value;
}

function finalizeDashboardWorkerResult(result) {
  const state = result.state;
  // Bind source paths to these exact session objects. Paths stay private and a
  // later account handoff cannot make an older parent-process lookup win over
  // the worker snapshot that selected the session.
  associateDashboardSessionFiles(state, result.backgroundTargets);
  for (const item of result.healthErrors || []) health.record(item.name, { ok: false, error: item.message });
  for (const target of result.backgroundTargets || []) {
    registerBackgroundTarget(target);
  }

  const taskById = new Map((state.tasks || []).map((task) => [task.id, task]));
  titles.applyLiveTitles(state.sessions, { onChange, taskFor: (session) => taskById.get(session.taskId) });
  for (const session of state.sessions || []) require('./session-debug').record(session, Date.now());
  const sessionById = new Map((state.sessions || []).map((session) => [session.id, session]));
  for (const item of state.attention || []) {
    const session = sessionById.get(item.sessionId);
    const current = session && sessionAttentionItem(session, Date.now());
    if (current && current.kind === item.kind) {
      item.title = current.title;
      item.detail = current.detail;
    }
  }
  const setAsideState = applySetAside(setAsideCandidates(state.attention || [], state.sessions || []));
  state.setAside = setAsideState.value.items;
  if (setAsideState.changed) onChange();
  for (const request of result.summaryRequests || []) {
    const value = summarize.getSummary(request.key, request.input, request.instruction, onChange, request.options).text;
    setPath(state, request.target, value);
  }
  state.generatedAt = Date.now();
  sessionSnapshot = copySessions(state.sessions);
  sessionSnapshotAt = state.generatedAt;
  lastDashboardSessionScan = state.generatedAt;
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
  let indexedClaudeSessionFor = null;
  for (const pane of hostPanesBySession(panes).values()) {
    try {
      const meta = pane && pane.meta;
      const id = meta && meta.sessionId;
      const agent = meta && meta.agent;
      if (!pane || typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)
        || !['claude', 'codex'].includes(agent) || sessionIds.has(id)) continue;
      const lookup = agent === 'codex'
        ? deps.codexSessionFor || codex.sessionFor
        : deps.claudeSessionFor || (deps.dashboard === true
          ? (indexedClaudeSessionFor ||= (deps.createDashboardClaudeSessionResolver || createDashboardClaudeSessionResolver)())
          : deps.freshClaudeSessionFor || claudeSessionFor);
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
      if (!session.accountId && typeof meta.accountId === 'string' && meta.accountId) session.accountId = meta.accountId;
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
    // The launch model from `keep open --model`, when the pane carries one.
    const launchModel = pane && pane.meta && pane.meta.model;
    if (typeof launchModel === 'string' && launchModel) session.launchModel = launchModel;
    const accountId = pane?.meta?.accountId || session.accountId;
    if (accountId) {
      const account = accounts.get(accountId);
      session.accountId = accountId;
      session.accountLabel = pane?.meta?.accountLabel || account?.label || accountId;
      if (pane?.meta) {
        pane.meta.accountId = accountId;
        pane.meta.accountLabel = session.accountLabel;
      }
    }
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
    holds,
    deviceHolds: true,
    steps: steps.status(project, { tasks, holds: keep.activeHolds(project) }),
    notes: require('./notes.js').activeNotes(project),
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

async function inspectAccountHandoff(body, deps = {}) {
  const panes = await listHostPanes(deps, true);
  if (!panes) return {};
  const state = await addHostSessionState(await buildState({ hostPanes: panes }), { ...deps, panes });
  const session = state.sessions.find((entry) => entry.id === body.sessionId);
  const pane = panes.find((entry) => entry.id === body.pane);
  const rows = await agentProcessRows(deps);
  const identity = (await liveSessionPids({ ...deps, agentProcessRows: async () => rows,
    codexRolloutOnly: session?.kind === 'codex' })).get(body.sessionId);
  const ownsPane = agentIdentityOwnsPane(identity, pane, rows);
  const processArgs = identity ? rows.find((entry) => entry.pid === identity.pid)?.args || '' : '';
  let currentModel = '';
  try {
    if (session?.kind === 'claude') {
      currentModel = lastClaudeHandoffModel(readTranscriptTail(findSessionFile(session.id)));
    }
  } catch {}
  return { session, pane, processArgs, currentModel,
    agentIdentity: identity ? { pid: identity.pid, pidStart: identity.pidStart, primary: identity.primary === true,
      ownsPane, ...(identity.rolloutFile ? { rolloutFile: identity.rolloutFile } : {}) } : null };
}

async function waitForAccountRecord(sessionId, pane, accountId, startedAfter, deps = {}) {
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const record = readPaneRecord(sessionId, deps);
    if (record?.pane === pane && record.accountId === accountId && Number(record.startedAt) > Number(startedAfter)) return record;
    await sleep(250);
  }
  return null;
}

function accountClaudeTranscript(sessionId, account, env = process.env) {
  const matches = accounts.locateClaudeFiles(sessionId, env).filter((entry) => entry.accountId === account.id);
  if (matches.length !== 1) throw new InjectionError(409, `Expected one target transcript for ${sessionId} in account ${account.id}`);
  return matches[0].file;
}

function accountClaudeSession(sessionId, account, file) {
  const stat = fs.statSync(file);
  return claudeSessionFromInfo(sessionId, scanTranscript(file), stat, path.dirname(file), false, Date.now(), account.id);
}

function accountCodexSession(sessionId, accountId, file) {
  const stat = fs.statSync(file);
  const info = codex.scanRollout(file, { includeHeadless: true });
  if (!info || info.id !== sessionId) throw new InjectionError(409, 'Target Codex rollout identity was not verified');
  return { ...info, kind: 'codex', project: info.cwd, accountId, file, mtime: stat.mtimeMs, state: info.endedTurn ? 'waiting' : 'running' };
}

async function verifyAccountHandoffTarget(sessionId, paneId, accountId, agent, targetTranscript, options, deps = {}) {
  const expected = options?.targetIdentity;
  const validStamp = (value) => typeof value === 'string' ? value.length > 0 : Number.isFinite(value);
  if (!expected || expected.sessionId !== sessionId || expected.pane !== paneId || expected.accountId !== accountId
      || expected.transactionId !== options.transactionId
      || !Number.isInteger(expected.panePid) || expected.panePid <= 0 || !validStamp(expected.paneCreatedAt)
      || !Number.isInteger(expected.agentPid) || expected.agentPid <= 0
      || typeof expected.agentPidStart !== 'string' || !expected.agentPidStart
      || expected.ownsPane !== true
      || !validStamp(expected.sessionStartedAt)
      || !Number.isFinite(options.sourceStopVerifiedAt) || options.sourceStopVerifiedAt <= 0) {
    throw new InjectionError(409, 'Native handoff destination identity is incomplete; nothing was sent');
  }
  const assertPane = (pane) => {
    if (!pane?.alive || pane.agentAlive === false || pane.id !== expected.pane || pane.pid !== expected.panePid
        || pane.createdAt !== expected.paneCreatedAt || pane.meta?.sessionId !== expected.sessionId
        || pane.meta?.agent !== agent || pane.meta?.accountId !== expected.accountId
        || pane.meta?.handoffTransactionId !== expected.transactionId) {
      throw new InjectionError(409, 'Native handoff destination pane identity changed; nothing was sent');
    }
  };
  const currentPane = async () => {
    const panes = await listHostPanes(deps, true);
    const pane = panes?.find((candidate) => candidate.id === expected.pane);
    assertPane(pane);
    return pane;
  };
  const currentAgent = async (pane) => {
    const rows = await (deps.agentProcessRows || agentProcessRows)(deps);
    const live = await (deps.liveSessionPids || liveSessionPids)({ ...deps, agentProcessRows: async () => rows,
      codexRolloutOnly: agent === 'codex' });
    const identity = live.get(sessionId);
    if (!identity?.primary || identity.agent !== agent || identity.pid !== expected.agentPid
        || identity.pidStart !== expected.agentPidStart || !agentIdentityOwnsPane(identity, pane, rows)) {
      throw new InjectionError(409, 'Native handoff destination agent identity changed; nothing was sent');
    }
    if (agent === 'codex') {
      let actual, wanted;
      try { actual = fs.realpathSync(identity.rolloutFile); wanted = fs.realpathSync(targetTranscript); }
      catch { throw new InjectionError(409, 'Native handoff destination rollout ownership is unavailable; nothing was sent'); }
      if (identity.source !== 'rollout' || actual !== wanted) {
        throw new InjectionError(409, 'Native handoff destination rollout ownership changed; nothing was sent');
      }
    }
  };
  const currentRecord = () => {
    const record = (deps.readPaneRecord || readPaneRecord)(sessionId, deps);
    if (!record || record.pane !== expected.pane || record.accountId !== expected.accountId
        || record.startedAt !== expected.sessionStartedAt) {
      throw new InjectionError(409, 'Native handoff destination SessionStart identity changed; nothing was sent');
    }
  };
  const pane = await currentPane(); currentRecord(); await currentAgent(pane);
  // Re-read both host and process identity after the other proofs. This runs in
  // the delivery type callback under the injection lock, immediately before the
  // first byte or an already typed draft's Enter is sent.
  const finalPane = await currentPane(); await currentAgent(finalPane); currentRecord();
}

function continueAccountHandoff(sessionId, pane, accountId, text, deliveryId, options = {}, deps = {}) {
  if (!options.agent && Object.keys(deps).length === 0
      && ['root', 'env', 'host', 'deliveryDirectory'].some((key) => Object.hasOwn(options, key))) {
    deps = options; options = {};
  }
  const env = deps.env || process.env;
  const target = accounts.get(accountId, env);
  const agent = options.agent || 'claude';
  if (!target || target.agent !== agent) throw new InjectionError(409, 'Target account changed before continuation delivery');
  let file;
  if (agent === 'codex') {
    if (typeof options.targetTranscript !== 'string' || !path.isAbsolute(options.targetTranscript)
        || options.targetTranscript.includes('\0')) {
      throw new InjectionError(409, 'Target Codex rollout path is unavailable');
    }
    file = path.resolve(options.targetTranscript);
    const profileRoot = path.resolve(target.configDir);
    const relative = path.relative(profileRoot, file);
    let profileStat, fileStat;
    try { profileStat = fs.lstatSync(profileRoot); fileStat = fs.lstatSync(file); }
    catch { throw new InjectionError(409, 'Target Codex rollout is unavailable'); }
    let physicalRelative;
    try { physicalRelative = path.relative(fs.realpathSync(profileRoot), fs.realpathSync(file)); }
    catch { throw new InjectionError(409, 'Target Codex rollout is unavailable'); }
    if (!profileStat.isDirectory() || profileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.isSymbolicLink()
        || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)
        || physicalRelative.startsWith(`..${path.sep}`) || physicalRelative === '..' || path.isAbsolute(physicalRelative)) {
      throw new InjectionError(409, 'Target Codex rollout path is outside its account');
    }
  } else file = accountClaudeTranscript(sessionId, target, env);
  const loadTarget = () => agent === 'codex' ? accountCodexSession(sessionId, target.id, file)
    : accountClaudeSession(sessionId, target, file);
  const exactDeps = {
    ...deps, loadCurrentSession: loadTarget, loadDeliverySession: loadTarget,
    transcriptFileForSession: () => file,
  };
  exactDeps.sendToResolvedTarget = (session, resolved, message) => sendToResolvedTarget(session, resolved, message,
    { retainReceipt: true, deliveryKey: deliveryId,
      beforeType: () => verifyAccountHandoffTarget(sessionId, pane, accountId, agent, file, options, exactDeps) }, exactDeps);
  return sendToSessionLocked({ sessionId, pane, text }, exactDeps);
}

async function resumeExitedAccountHandoff(entry, account, mcpConfig, deps = {}) {
  const host = (type, params) => hostRequest(type, params, deps);
  const pane = (await host('get', { pane: entry.pane })).pane;
  if (pane.alive || pane.pid !== entry.pid) throw new InjectionError(409, 'Exited handoff pane changed before recovery');
  if ((await liveSessionPids(deps)).has(entry.sessionId)) throw new InjectionError(409, 'An agent process still owns this conversation');
  const agent = entry.agent || 'claude';
  const cwd = agent === 'codex' ? validatedCodexResumeCwd(agent, entry.cwd) : entry.cwd;
  let argv, reviewerSpec = { env: null };
  if (agent === 'codex') {
    argv = entry.resumeSpec?.argv;
    if (!Array.isArray(argv) || argv.length < 3
        || argv.some((value) => typeof value !== 'string' || !value || /[\r\n\0]/.test(value))
        || argv[0] !== 'codex' || argv.at(-2) !== 'resume' || argv.at(-1) !== entry.sessionId) {
      throw new InjectionError(409, 'Saved Codex resume policy is invalid');
    }
  } else {
    const flags = entry.permissionClass === 'bypass' ? ['--dangerously-skip-permissions'] : [];
    const modelArgs = entry.model && keep.LAUNCH_MODEL_RE.test(entry.model) ? ['--model', entry.model] : [];
    reviewerSpec = reviewerResumeSpec({ id: entry.sessionId }, pane, deps);
    argv = ['claude', ...flags, ...reviewerSpec.flags, ...(mcpConfig ? ['--mcp-config', mcpConfig] : []), ...modelArgs, '--resume', entry.sessionId];
  }
  const result = await host('replace-exited', {
    paneId: pane.id, expectedPid: entry.pid, sessionId: pane.meta?.sessionId,
    cmd: '/bin/zsh', args: ['-lic', `exec ${require('./agent-launcher').profileCommand(argv, account)}`], cwd,
    env: require('./agent-launcher').launcherEnv({ ...repairEnvFor({ sessionId: entry.sessionId }, deps), ...reviewerSpec.env }),
    cols: entry.cols, rows: entry.rows,
    meta: { ...adoptedPaneMeta(pane.meta), agent, sessionId: entry.sessionId, accountId: account.id, accountLabel: account.label,
      handoffTransactionId: entry.id, restartedAt: Date.now() },
  });
  const launched = { ok: true, pane: result.pane.id, pid: result.pane.pid,
    createdAt: result.pane.createdAt, sessionId: entry.sessionId };
  if (deps.onLaunched) await deps.onLaunched(launched);
  await (deps.waitForHostAgent || waitForHostAgent)({ pane: pane.id }, agent, deps);
  return launched;
}

async function handoffSession(body, deps = {}) {
  const root = deps.root || keep.ROOT;
  const deliveryDirectory = deps.deliveryDirectory || path.join(root, '.keep', 'delivery');
  return require('./account-handoff').run(body, {
    ...deps,
    root,
    inspect: deps.inspect || ((request) => inspectAccountHandoff(request, deps)),
    host: deps.host || { request: (type, params) => hostRequest(type, params, deps) },
    restartSession: deps.restartSession || restartSession,
    restartDeps: deps.restartDeps || deps,
    resumeExited: deps.resumeExited || ((entry, account, mcpConfig, hooks = {}) => resumeExitedAccountHandoff(entry, account, mcpConfig,
      { ...deps, ...hooks })),
    waitForAccountRecord: deps.waitForAccountRecord || ((sid, pane, accountId, after) => waitForAccountRecord(sid, pane, accountId, after, deps)),
    continueSession: deps.continueSession || ((sessionId, text, options) => continueAccountHandoff(sessionId, body.pane, body.accountId,
      text, options?.deliveryId, options, { ...deps, deliveryDirectory })),
    deliveryStatus: deps.deliveryStatus || ((_sessionId, text, deliveryId) => require('./delivery').statusForText(deliveryDirectory, text, deliveryId)),
    verifyTargetSpec: deps.verifyTargetSpec || (async (entry, target) => {
      if (!entry.resumeSpec) return true;
      const verified = require('./codex-handoff-support').readResumeSpec(entry.targetTranscript, entry.sessionId);
      if (verified.digest !== entry.resumeSpec.digest) throw new InjectionError(409, 'Target Codex resume policy differs from the stopped source');
      return true;
    }),
  });
}

async function abandonAccountHandoff(body, deps = {}) {
  const root = deps.root || keep.ROOT;
  return require('./account-handoff').abandonForPortable(body, {
    ...deps, root,
    inspect: deps.inspect || ((request) => inspectAccountHandoff(request, deps)),
  });
}

function listPortableTransfers(deps = {}) {
  return (deps.portable || require('./portable-handoff')).list(deps.root || keep.ROOT);
}

const PORTABLE_TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'cancelled']);
const PORTABLE_TERMINAL_QUOTA_TYPES = new Set(['five_hour', 'seven_day', 'fable_weekly']);
const PORTABLE_LEDGER_LIMIT = 4 * 1024 * 1024;

function portableRecordMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function portableTerminalJobsValid(jobs) {
  // A completed parent tombstone does not prove an owned child's own ledger
  // has no background work. Refuse descendants until that graph is proven.
  return Array.isArray(jobs) && jobs.every((job) => portableRecordMap(job)
    && typeof job.id === 'string' && job.id.length > 0
    && typeof job.kind === 'string' && job.kind.length > 0 && job.kind !== 'agent'
    && PORTABLE_TERMINAL_JOB_STATES.has(job.status));
}

function readPortableJobState(root, sessionId) {
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(sessionId || '')) return null;
  const file = path.join(root, '.keep', 'background-jobs', 'claude', sessionId, 'state.json');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > PORTABLE_LEDGER_LIMIT) return null;
    const buffer = Buffer.alloc(before.size);
    if (before.size && fs.readSync(fd, buffer, 0, before.size, 0) !== before.size) return null;
    const after = fs.fstatSync(fd);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some((field) => before[field] !== after[field])) return null;
    return { value: JSON.parse(buffer.toString('utf8')), file, stat: after,
      contentDigest: crypto.createHash('sha256').update(buffer).digest('hex') };
  } catch { return null; }
  finally { if (fd != null) fs.closeSync(fd); }
}

function portableTerminalLedgerEvidence(session, transcriptFile, root) {
  const loaded = readPortableJobState(root, session.id);
  if (!loaded || !transcriptFile) return null;
  let transcript;
  try {
    transcript = fs.lstatSync(transcriptFile);
    const currentLedger = fs.lstatSync(loaded.file);
    const inbox = fs.readdirSync(path.join(path.dirname(loaded.file), 'inbox'));
    if (!transcript.isFile() || transcript.isSymbolicLink() || inbox.length
        || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some((field) => currentLedger[field] !== loaded.stat[field])) return null;
  } catch { return null; }
  const value = loaded.value;
  const restart = value?.restart;
  const checkpoint = value?.checkpoint;
  const jobs = portableRecordMap(value?.jobs) ? Object.values(value.jobs) : null;
  const rateLimitAt = Date.parse(session.rateLimit?.at || '');
  const transcriptIdentity = `${crypto.createHash('sha256').update(path.resolve(transcriptFile)).digest('hex')}:${transcript.dev}:${transcript.ino}`;
  // Reconciliation may observe trailing duration/cost metadata after the quota
  // response. The scanner keeps rateLimit only while no later real turn exists.
  if (!portableRecordMap(value) || value.version !== 1
      || value.restartVersion !== require('./background-jobs').restartVersion('claude')
      || value.recovering !== false || !portableTerminalJobsValid(jobs)
      || !portableRecordMap(value.calls) || Object.keys(value.calls).length
      || !portableRecordMap(value.notices) || !portableRecordMap(restart)
      || !portableRecordMap(restart.children) || !portableRecordMap(restart.launches) || !portableRecordMap(restart.mapped)
      || Object.keys(restart.children).length || Object.keys(restart.launches).length || Object.keys(restart.mapped).length
      || restart?.id !== session.id || restart.rateLimitTerminal !== true
      || !Number.isFinite(restart.observedAt) || restart.observedAt < rateLimitAt
      || !Number.isFinite(rateLimitAt) || !PORTABLE_TERMINAL_QUOTA_TYPES.has(session.rateLimit?.type)
      || value.source?.agent !== 'claude' || value.source.sid !== session.id
      || path.resolve(value.source.file || '') !== path.resolve(transcriptFile)
      || checkpoint?.identity !== transcriptIdentity || checkpoint.offset !== transcript.size || checkpoint.mtime !== transcript.mtimeMs
      || value.hookBarrier != null && (!Number.isFinite(value.hookBarrier) || checkpoint.offset <= value.hookBarrier)
      || !portableRecordMap(value.source) || !portableRecordMap(checkpoint)) return null;
  return { rateLimitAt, transcriptIdentity, gap: value.gap === true,
    fingerprint: `${loaded.contentDigest}:${loaded.stat.dev}:${loaded.stat.ino}:${loaded.stat.size}:${loaded.stat.mtimeMs}:${loaded.stat.ctimeMs}`
      + `:${transcriptIdentity}:${transcript.size}:${transcript.mtimeMs}:${transcript.ctimeMs}` };
}

async function portableTerminalRateLimitEvidence(session, state, deps = {}) {
  const rateLimitAt = Date.parse(session?.rateLimit?.at || '');
  const background = session?.backgroundJobs;
  const unknown = session?.unknownBackgroundJobs;
  const lastUserAt = session?.lastUserAt == null ? 0 : Number(session.lastUserAt);
  const lifecycleTurnAt = session?.lifecycleTurnAt == null ? 0 : Number(session.lifecycleTurnAt);
  if (session?.kind !== 'claude' || !Number.isFinite(rateLimitAt)
      || !PORTABLE_TERMINAL_QUOTA_TYPES.has(session.rateLimit?.type)
      || session.toolRunning || session.pendingOther || session.pendingQuestion || session.pendingPlan || session.pendingBackground !== false
      || !Array.isArray(session.lifecycleAgents) || session.lifecycleAgents.length
      || !background || background.pending !== false || background.caughtUp !== true || background.recovering !== false
      || background.unresolvedCalls !== 0 || background.unconsumedHooks !== 0
      || !portableTerminalJobsValid(background.jobs)
      || !Array.isArray(background.uncertain) || background.uncertain.some((entry) => entry !== 'history-gap')
      || !Array.isArray(unknown) || unknown.some((entry) => entry !== 'history-gap')
      || !Number.isFinite(lastUserAt) || lastUserAt > rateLimitAt
      || !Number.isFinite(lifecycleTurnAt) || lifecycleTurnAt > rateLimitAt) return null;
  const foregroundHook = session.observation?.foreground?.hook;
  if (foregroundHook && (!Number.isFinite(foregroundHook.at) || foregroundHook.at > rateLimitAt)) return null;
  let transcriptFile;
  try {
    transcriptFile = deps.portableTranscriptFile
      ? deps.portableTranscriptFile(session)
      : findSessionFile(session.id, { root: deps.root || keep.ROOT, env: deps.env || process.env });
  } catch { return null; }
  const ledger = portableTerminalLedgerEvidence(session, transcriptFile, deps.root || keep.ROOT);
  if (!ledger) return null;
  const pane = (state.panes || []).find((entry) => entry.id === session.runtime?.paneId);
  if (!pane || pane.meta?.sessionId !== session.id || pane.meta?.agent !== 'claude'
      || !session.accountId || pane.meta?.accountId !== session.accountId) return null;
  if (session.runtime?.state === 'exited') {
    if (session.runtime.liveInstances !== 0 || session.exited !== true || pane.alive !== false && pane.agentAlive !== false) return null;
    const finalLedger = portableTerminalLedgerEvidence(session, transcriptFile, deps.root || keep.ROOT);
    if (!finalLedger || finalLedger.fingerprint !== ledger.fingerprint) return null;
    return { version: 1, rateLimitAt, runtimeState: 'exited', pane: pane.id, ledgerGap: ledger.gap };
  }
  if (session.runtime?.state !== 'live' || session.runtime.liveInstances !== 1 || pane.alive !== true || pane.agentAlive === false) return null;
  try {
    const rows = await (deps.agentProcessRows || agentProcessRows)(deps);
    const identity = (await (deps.liveSessionPids || liveSessionPids)({ ...deps,
      agentProcessRows: async () => rows })).get(session.id);
    if (!identity || identity.primary !== true || !agentIdentityOwnsPane(identity, pane, rows)
        || !Number.isInteger(identity.pid) || identity.pid <= 0 || !identity.pidStart) return null;
    const finalLedger = portableTerminalLedgerEvidence(session, transcriptFile, deps.root || keep.ROOT);
    if (!finalLedger || finalLedger.fingerprint !== ledger.fingerprint) return null;
    return { version: 1, rateLimitAt, runtimeState: 'live', pane: pane.id,
      sourceAgentPid: identity.pid, sourceAgentPidStart: identity.pidStart, ledgerGap: ledger.gap };
  } catch { return null; }
}

async function inspectPortableSource(sessionId, options = {}, deps = {}) {
  let state;
  if (deps.inspectState) state = await deps.inspectState();
  else {
    const panes = await listHostPanes(deps, true);
    if (!panes) throw new InjectionError(503, 'terminal host is unavailable; source activity cannot be verified');
    state = await addHostSessionState(await buildState({ hostPanes: panes }), { ...deps, panes });
  }
  const session = state.sessions?.find((entry) => entry.id === sessionId);
  const handoff = require('./account-handoff');
  const root = deps.root || keep.ROOT;
  let nativeHandoff = (state.handoffs || handoff.list(root))
    .find((entry) => entry.sessionId === sessionId && !['done', 'failed'].includes(entry.status));
  const abandoned = handoff.abandonedForPortable(root, sessionId);
  const abandonedPane = abandoned && (state.panes || []).find((entry) => entry.id === abandoned.pane);
  let abandonedIdentity = null;
  let abandonedOwnsPane = false;
  if (abandoned) {
    try {
      const rows = await (deps.agentProcessRows || agentProcessRows)(deps);
      abandonedIdentity = (await (deps.liveSessionPids || liveSessionPids)({ ...deps,
        agentProcessRows: async () => rows, codexRolloutOnly: session?.kind === 'codex' })).get(sessionId) || null;
      abandonedOwnsPane = agentIdentityOwnsPane(abandonedIdentity, abandonedPane, rows);
    } catch {}
  }
  const portableFallback = abandoned && abandoned.sourceOwnsPane === true
    && session?.accountId === abandoned.sourceAccountId
    && abandonedPane?.alive === true && abandonedPane.meta?.sessionId === sessionId
    && abandonedPane.meta?.accountId === abandoned.sourceAccountId && abandonedPane.agentAlive !== false
    && abandonedIdentity?.primary === true && abandonedOwnsPane
    && (!abandoned.sourceAgentPid || abandonedIdentity.pid === abandoned.sourceAgentPid)
    && (!abandoned.sourceAgentPidStart || abandonedIdentity.pidStart === abandoned.sourceAgentPidStart) ? abandoned : null;
  if (abandoned && !portableFallback) nativeHandoff ||= abandoned;
  const portableHandoff = listPortableTransfers(deps).find((entry) => entry.sourceSessionId === sessionId
    && entry.id !== options.transferId && ['launching', 'awaiting-setup', 'ambiguous', 'done'].includes(entry.status));
  const terminalRateLimit = session && !nativeHandoff && !portableHandoff
    ? await portableTerminalRateLimitEvidence(session, state, deps) : null;
  return { session, nativeHandoff, portableHandoff, portableFallback, terminalRateLimit, panes: state.panes || [], state };
}

async function assertPortablePaneBinding(expected, deps = {}) {
  const pane = (await hostRequest('get', { pane: expected.pane }, deps))?.pane;
  if (!pane || pane.alive !== true || pane.id !== expected.pane
      || pane.meta?.portableTransferId !== expected.transferId || pane.meta?.accountId !== expected.accountId
      || pane.meta?.card !== expected.cardId || pane.meta?.sessionId !== expected.sessionId
      || expected.pid && pane.pid !== expected.pid
      || expected.createdAt != null && pane.createdAt !== expected.createdAt) {
    throw new InjectionError(409, 'portable successor pane identity changed before instructions were sent');
  }
  return pane;
}

async function assertReviewQueuePaneBinding(expected, deps = {}) {
  const pane = deps.getPane
    ? await deps.getPane(expected.pane)
    : (await hostRequest('get', { pane: expected.pane }, deps))?.pane;
  if (!pane || pane.alive !== true || pane.agentAlive === false || pane.id !== expected.pane
      || pane.meta?.reviewQueueLaunchId !== expected.launchId || pane.meta?.accountId !== expected.accountId
      || pane.meta?.agent !== expected.agent || pane.meta?.sessionId !== expected.sessionId
      || expected.pid && pane.pid !== expected.pid
      || expected.createdAt != null && pane.createdAt !== expected.createdAt) {
    throw new InjectionError(409, 'review queue pane identity changed before instructions were sent');
  }
  return pane;
}

async function recoverPortableOpening(state, message, hooks = {}, deps = {}) {
  if (!state?.destinationPane || !state.opening || state.opening.text !== message) {
    throw new InjectionError(409, 'portable transfer has no recoverable opening reservation');
  }
  const result = await hostRequest('get', { pane: state.destinationPane }, deps);
  const pane = result?.pane;
  if (!pane || pane.alive !== true || pane.id !== state.destinationPane
      || pane.meta?.portableTransferId !== state.requestKey || pane.meta?.accountId !== state.targetAccountId
      || pane.meta?.card !== state.cardId || state.destinationSessionId && pane.meta?.sessionId !== state.destinationSessionId) {
    throw new InjectionError(409, 'the saved portable successor pane identity changed');
  }
  const launch = { pane: pane.id, sessionId: state.destinationSessionId || pane.meta?.sessionId || null,
    accountId: state.targetAccountId };
  const target = { pane: pane.id };
  try {
    await (deps.waitForHostAgent || waitForHostAgent)(target, state.targetAgent, { ...deps, detectPortableSetup: true });
    launch.sessionId ||= await (deps.waitForHostSessionId || waitForHostSessionId)(pane.id, deps);
    if (!launch.sessionId || launch.sessionId === state.sourceSessionId) {
      throw new InjectionError(409, 'portable successor session identity was not verified before instructions were sent');
    }
    await withInjectionLockRetry(
      async () => {
        await assertPortablePaneBinding({ pane: state.destinationPane, transferId: state.requestKey,
          accountId: state.targetAccountId, cardId: state.cardId, sessionId: launch.sessionId,
          pid: state.destinationPanePid, createdAt: state.destinationPaneCreatedAt }, deps);
        if (!hooks.onReady || await hooks.onReady(launch) !== true) {
          throw new InjectionError(409, 'portable opening reservation changed before instructions were sent');
        }
        return (deps.typeOpeningMessage || typeOpeningMessage)(target, state.targetAgent, message, deps);
      }, deps,
      { pane: pane.id, model: modelCommandText(message) },
    );
    if (!hooks.onDelivered || await hooks.onDelivered(launch) !== true) {
      throw new InjectionError(409, 'portable opening reservation changed after instructions were sent');
    }
    accounts.pinSession(launch.sessionId, state.targetAgent, state.targetAccountId,
      { root: deps.root || keep.ROOT, env: deps.env || process.env });
    try { (deps.linkLaunchedSession || keep.linkLaunchedSession)(state.cardId, { id: launch.sessionId, agent: state.targetAgent }); }
    catch (error) { process.stderr.write(`keep serve: could not link recovered portable session ${launch.sessionId.slice(0, 8)} to ${state.cardId}: ${error.message}\n`); }
    return launch;
  } catch (error) {
    if (error?.extra?.awaitingSetup) error.extra.launch = launch;
    throw error;
  }
}

function portableDeps(deps = {}) {
  const root = deps.root || keep.ROOT;
  const portable = deps.portable || require('./portable-handoff');
  const storePackage = deps.storePackage || (async ({ cardId, fileName, content, note }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-portable-transfer-'));
    const file = path.join(directory, fileName);
    try {
      fs.writeFileSync(file, content, { mode: 0o600 });
      const stored = keep.artifactCommandCli([cardId, file, '-m', note], { quiet: true });
      if (!stored?.[0]?.destination) throw new Error('portable transfer artifact was not stored');
      return stored[0].destination;
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  return {
    ...deps, root, accounts: deps.accounts || accounts,
    taskForSession: deps.taskForSession || keep.taskForSession,
    nextStep: deps.nextStep || keep.nextStep,
    taskFile: deps.taskFile || ((task) => path.join(root, 'tasks', `${task.id}.md`)),
    storePackage,
    inspectSource: deps.inspectSource || ((sessionId, options) => inspectPortableSource(sessionId, options, deps)),
    open: deps.open || ((payload) => openSession(payload, deps)),
  };
}

async function portableTransferDraft(query, deps = {}) {
  const sourceSessionId = String(query?.get ? query.get('session') : query?.sourceSessionId || '');
  return { ok: true, draft: await (deps.portable || require('./portable-handoff')).draft({ sourceSessionId }, portableDeps(deps)) };
}

async function preparePortableTransfer(body, deps = {}) {
  const keys = Object.keys(body || {});
  if (keys.some((key) => !['sourceSessionId', 'accountId', 'model', 'context', 'cwd'].includes(key))) {
    throw new InjectionError(400, 'portable transfer preparation contains unsupported fields');
  }
  if (typeof body?.sourceSessionId !== 'string' || typeof body?.accountId !== 'string'
      || typeof body?.context !== 'string' || Buffer.byteLength(body.context) > require('./portable-handoff').CONTEXT_LIMIT
      || body.model != null && typeof body.model !== 'string'
      || body.cwd != null && (typeof body.cwd !== 'string' || Buffer.byteLength(body.cwd) > 4096)) {
    throw new InjectionError(400, 'portable transfer preparation is invalid or too large');
  }
  const portable = deps.portable || require('./portable-handoff');
  const result = await portable.run({ sourceSessionId: body.sourceSessionId, accountId: body.accountId,
    model: body.model || '', contextText: body.context, ...(body.cwd ? { cwd: body.cwd } : {}), prepareOnly: true }, portableDeps(deps));
  const preview = portable.readPreview(result.requestKey, { root: deps.root || keep.ROOT });
  return { ok: true, ...preview };
}

function portableTransferPreview(query, deps = {}) {
  const transferId = String(query?.get ? query.get('id') : query?.transferId || '');
  return { ok: true, ...(deps.portable || require('./portable-handoff')).readPreview(transferId, { root: deps.root || keep.ROOT }) };
}

async function transferSession(body, deps = {}) {
  if (!body || typeof body.transferId !== 'string' || !/^[a-f0-9]{64}$/.test(body.transferId)) {
    throw new InjectionError(400, 'portable transfer id is invalid');
  }
  const portable = deps.portable || require('./portable-handoff');
  const hooks = {
    onLaunched: async (launch) => {
      portable.recordLaunch(body.transferId, launch, { root: deps.root || keep.ROOT });
      return deps.onLaunched ? deps.onLaunched(launch) : true;
    },
    onReady: async (launch) => portable.reserveDelivery(body.transferId, launch, { root: deps.root || keep.ROOT }),
    onDelivered: async (launch) => {
      portable.recordDelivery(body.transferId, launch, { root: deps.root || keep.ROOT });
      return deps.onOpeningDelivered ? deps.onOpeningDelivered(launch) : true;
    },
  };
  const result = await portable.launchPrepared(body.transferId, {
    ...portableDeps(deps),
    requireDeliveryReceipt: true,
    resumeOpening: deps.resumeOpening || ((state, message) => recoverPortableOpening(state, message, hooks, deps)),
    open: deps.open || ((payload) => openSession({ ...payload, portableTransferId: body.transferId }, {
      ...deps,
      detectPortableSetup: true,
      onLaunched: hooks.onLaunched,
      onOpeningReady: hooks.onReady,
      onOpeningDelivered: hooks.onDelivered,
    })),
  });
  const transfer = portable.safeSummary(result);
  if (!transfer) throw new InjectionError(500, 'portable transfer result is invalid');
  return { ok: true, transfer };
}

async function resolvePortableTransfer(body, deps = {}) {
  if (!body || typeof body.transferId !== 'string' || typeof body.destinationSessionId !== 'string') {
    throw new InjectionError(400, 'portable transfer resolution is invalid');
  }
  const portable = deps.portable || require('./portable-handoff');
  const result = await portable.resolvePrepared(body.transferId, body.destinationSessionId, {
    ...portableDeps(deps),
    validateResolution: deps.validateResolution || (async (sessionId, transfer) => {
      const inspection = await inspectPortableSource(transfer.sourceSessionId, { transferId: transfer.requestKey }, deps);
      const session = inspection.state.sessions?.find((entry) => entry.id === sessionId);
      const pane = inspection.panes.find((entry) => entry.meta?.sessionId === sessionId);
      const receipt = portable.deliveryReceipt(transfer.requestKey, { root: deps.root || keep.ROOT });
      if (!session || session.accountId !== transfer.targetAccountId || !pane
          || pane.meta?.accountId !== transfer.targetAccountId
          || pane.meta?.portableTransferId !== transfer.requestKey || receipt?.pane !== pane.id
          || receipt.deliveredAt < Number(transfer.launchStartedAt || 0)
          || transfer.policyVersion === 2 && (receipt.version !== 2 || receipt.openingDigest !== transfer.opening?.digest)) return false;
      if (session.taskId && session.taskId !== transfer.cardId) return false;
      if (session.taskId === transfer.cardId) return true;
      if (pane.meta?.card !== transfer.cardId) return false;
      const owner = (deps.taskForSession || keep.taskForSession)(sessionId);
      if (owner?.id && owner.id !== transfer.cardId) return false;
      if (owner?.id === transfer.cardId) return true;
      return Boolean((deps.linkLaunchedSession || keep.linkLaunchedSession)(
        transfer.cardId, { id: sessionId, agent: transfer.targetAgent },
      ));
    }),
  });
  const transfer = portable.safeSummary(result);
  if (!transfer) throw new InjectionError(500, 'portable transfer result is invalid');
  return { ok: true, transfer };
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
      const result = await withInjectionLock(() => (deps.sendToResolvedTarget || sendToResolvedTarget)(session, target, text, { compactIfCold: true, retainReceipt: true, deliveryKey: runs.checkDeliveryKey(task) }),
        { pane: target.pane, session: session.id });
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

// Closing a pane the check scheduler opened, on the automatic-retirement path rather
// than the Close button's. Nobody asked for this close, so a refusal from
// closeIdleSession — an unsent draft, a modal prompt, a pending question, unverified
// background work, a viewer who attached, recent pane input or output, a session that
// changed under the sweep, a pane that stopped being the scheduler's — is final:
// `requireGraceful` re-throws it and the caller leaves the pane for the next tick
// rather than signalling it anyway. The signals that do follow a successful /exit are
// guarded by pid, session id and input/output counts, so a pane that came back to life
// between the steps is never killed.
async function closeEphemeralPane(pane, sessionId, deps = {}) {
  const host = deps.hostRequest || hostRequest;
  const lock = deps.withInjectionLock || withInjectionLock;
  const capabilities = await host('hello');
  const result = await lock(() => (deps.manualClose || require('./manual-close').manualClose)(
    { pane: pane.id, sessionId }, {
      requireGraceful: true,
      requireSignalGuard: true,
      signalGuarded: capabilities.guardedKill === true,
      protectInput: true,
      protectOutput: true,
      getPane: async (id) => (await host('get', { pane: id })).pane,
      // `ephemeral` says only that Keep opened this pane for one recipe, so the card's
      // own schedule does not pin it; `automatic` keeps every unattended-retirement
      // guard, and `idleMs: 0` is what lets a pane that just finished its check close
      // now instead of in eight hours.
      graceful: (request) => (deps.closeIdleSession || closeIdleSession)(request, {
        closePolicy: { automatic: true, ephemeral: true, idleMs: 0 },
        withInjectionLock: (fn) => fn(),
      }),
      signal: (id, signal, guard) => host('guarded-kill', { pane: id, signal, ...guard }),
    }), { pane: pane.id, session: sessionId });
  (deps.onChange || (() => {}))();
  return result;
}

// The scheduler's opener, used by every caller that opens a session on a card the
// scheduler would otherwise have opened one for.
function openCheckSession(body, openDeps) {
  return openSession(body, { ...openDeps, launchMeta: { ephemeral: 'check' } });
}

// `keep verify <id>` and the console's "Run check now": run a card's check recipe now
// instead of waiting for its schedule. The linked thread gets it if one is open — it
// has the context the recipe may assume — and otherwise Keep opens a fresh session on
// the card, exactly as the scheduler does when the check comes due. Nothing runs
// headless, so there is no run id to report: what comes back is a session.
async function runCheckNow(taskId, deps = {}) {
  const task = (deps.loadTask || keep.loadTask)(taskId);
  if (!task.fm.check) throw new keep.KeepError(`${taskId} has no check recipe`);
  let delivery = null;
  try { delivery = await (deps.deliverCheckToThread || deliverCheckToThread)(task); }
  catch (error) { delivery = { deferred: true, reason: String(error && error.message || error) }; }
  if (delivery && !delivery.deferred && delivery.sessionId) {
    return { ok: true, delivered: 'thread', sessionId: delivery.sessionId, kind: delivery.kind || 'claude' };
  }
  // `enforce: false`: Owner asked for this check now, so it is neither refused by the
  // scheduler's one-open-per-card-per-day allowance nor counted against it. It still
  // writes the same TTL'd delivery stamp, so the tick a minute later does not put a
  // second agent on the card, and runs.js's per-card in-flight guard covers two
  // verifies racing each other.
  const outcome = await runs.openFreshCheckSession(task, { enforce: false, open: deps.open || openCheckSession });
  // Joining an open that was already in flight can return that open's refusal — the
  // per-tick cap, the account budget. Saying ok with a null session would report a
  // check that is not running.
  if (outcome.skipped) {
    throw new InjectionError(409, outcome.reason
      ? `check not opened (${outcome.skipped}): ${outcome.reason}`
      : `check not opened (${outcome.skipped})`);
  }
  const { opened } = outcome;
  return { ok: true, delivered: 'session', sessionId: (opened && opened.sessionId) || null,
    pane: (opened && opened.pane) || null, kind: 'claude' };
}

// The console's "Run agent" button. A pointer, not a brief: the session reads the card
// itself rather than working from a copy of it that was already stale when it was typed.
function taskRunMessage(taskId, prompt) {
  const instructions = String(prompt || '').replace(/\s+/g, ' ').trim();
  const head = `[keep] Work on card ${taskId}: keep show ${taskId}.`;
  if (!instructions) return head;
  const room = keep.OPEN_MESSAGE_LIMIT - head.length - ' Operator instructions: '.length - 1;
  return `${head} Operator instructions: ${instructions.length > room ? `${instructions.slice(0, room)}…` : instructions}`;
}

async function runTaskNow(taskId, prompt, deps = {}) {
  (deps.loadTask || keep.loadTask)(taskId); // refuse an unknown card before opening anything
  const opened = await (deps.open || openSession)({
    taskId, fresh: true, agent: 'claude', message: taskRunMessage(taskId, prompt),
  }, {});
  return { ok: true, sessionId: (opened && opened.sessionId) || null, pane: (opened && opened.pane) || null };
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
      const result = await withInjectionLock(() => sendToResolvedTarget(session, target, text, { compactIfCold: true }),
        { pane: target.pane, session: session.id });
      return { sessionId: session.id, kind: session.kind, ...(result || {}) };
    } catch (error) {
      return { deferred: true, reason: String(error && error.message || error) };
    }
  }
  return busy > 0
    ? { deferred: true, reason: 'linked thread is mid-turn or waiting on Owner' }
    : null;
}

// A state note reaches the sibling sessions in the same checkout as information.
// Not a gate, not a question, and never a reason to stop: the text says so, and
// nothing here waits for an answer. Reviewer and spawned sessions are excluded
// the same way every other automated delivery excludes them, and a session that
// is mid-turn or holding a prompt is simply skipped — the note is still on the
// card, in `keep notes`, and in the next session-start block.
async function announceStateNote(id, deps = {}) {
  const notes = deps.notes || require('./notes.js');
  const note = notes.findNote(id);
  if (!note) return { error: `no state note "${id}"` };
  // The event is the note's own state, never the caller's word for it, and it
  // happens once: a replayed request is a second identical message typed into
  // every sibling session in the project.
  const event = notes.announceEventFor(note);
  if (notes.announcedAlready(note, event)) {
    return { duplicate: true, id: note.id, event, error: `${note.id} has already been announced as ${event}` };
  }
  notes.markAnnounced(note.id, event, Date.now());
  const text = notes.announcementFor(note, event);
  const author = String((note.by && note.by.sessionId) || '');
  const ledger = (deps.liveSessionsInCheckout || review.liveSessionsInCheckout)(
    note.project, author ? [author] : [], Date.now(),
  );
  const { candidates, busy } = pickDeliveryCandidates(
    (ledger.sessions || []).map((session) => session.id),
    (deps.scanSessions || scanSessions)(),
    deps.excluded || excludedSessionIds(),
  );
  const send = deps.send || ((sessionId) => withInjectionLock(() => sendToSession({ sessionId, text }), { session: sessionId }));
  const sent = [];
  const failed = [];
  for (const candidate of candidates) {
    if (candidate.reviewer) continue; // the reviewer writes no code; it has nothing to coordinate
    try {
      await send(candidate.id, text);
      sent.push(candidate.id);
    } catch (error) {
      failed.push({ sessionId: candidate.id, reason: String((error && error.message) || error) });
    }
  }
  return { id: note.id, event, text, sent, failed, busy, available: ledger.available !== false };
}

function sendReviewerMessage(sessionId, text, opts) {
  return sendToSession(
    { sessionId, text },
    { ...review.readReviewerMarker(sessionId), bootstrap: Boolean(opts && opts.bootstrap) },
  );
}

// The bridge from a drift verdict to a reviewer wake. Exported because the field
// mapping is the whole risk: judge() hands back camelCase (bin/turn-watcher.js
// parseVerdict/judge) while the turn-index columns are snake_case, and reading the
// wrong spelling renders "(no state line)" on every drift tick without failing
// anything. Returns the pending wake, or null when this verdict is not one.
function driftWakeFromVerdict(turn, verdict, deps = {}) {
  const reviewApi = deps.review || review;
  if (reviewApi.cadenceMode() !== 'events') return null;
  if (!verdict || verdict.skipped || verdict.verdict !== 'drift') return null;
  if (String(verdict.model || '').endsWith(':replay')) return null;
  return reviewApi.driftWake(deps.reviewDeps || reviewDeps, {
    sessionId: turn.session_id,
    turn: turn.n,
    cardId: verdict.cardId,
    stateLine: verdict.stateLine,
    reason: verdict.reason,
    message: verdict.message,
    confidence: verdict.confidence,
    decisionId: verdict.decisionId,
  });
}

const reviewDeps = {
  send: (sessionId, text, opts) => withInjectionLock(() => sendReviewerMessage(sessionId, text, opts), { session: sessionId }),
  sendPlain: (sessionId, text) => withInjectionLock(() => sendToSession({ sessionId, text }), { session: sessionId }),
  sessions: () => scanSessions(),
  sessionContextTokens,
  compact: (sessionId, instruction) => withInjectionLock(() => compactSessionById({ sessionId, instruction }), { session: sessionId, model: true }),
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

function startWtGcScheduler(options = {}) {
  const run = options.execFile || execFile;
  const record = options.record || health.record;
  const write = options.write || process.stderr.write.bind(process.stderr);
  const later = options.setTimeout || setTimeout;
  const repeat = options.setInterval || setInterval;
  let running = false;
  const tick = () => {
    if (running) return Promise.resolve({ skipped: true });
    running = true;
    return new Promise((resolve) => {
      run(process.execPath, [path.join(__dirname, 'wt.js'), 'gc'], {
        env: process.env, timeout: 30 * 60e3, maxBuffer: 4 << 20,
      }, (error, stdout, stderr) => {
        const output = [stdout, stderr].map((value) => String(value || '').trim()).filter(Boolean).join('\n');
        if (output) write(`${output}\n`);
        if (error) {
          record('wt-gc', { ok: false, error });
          write(`keep serve: wt gc failed: ${error.message}\n`);
        } else {
          const mutations = String(stdout || '').split(/\r?\n/)
            .filter((line) => /^(?:recycle|delete)\s/.test(line)).length;
          record('wt-gc', { ok: true, detail: `${mutations} worktree(s) cleaned` });
          options.onChange?.();
        }
        running = false;
        resolve({ ok: !error });
      });
    });
  };
  const first = later(() => { void tick(); }, options.firstRunMs ?? 5 * 60e3);
  first.unref?.();
  const timer = repeat(() => { void tick(); }, options.intervalMs ?? 24 * 60 * 60e3);
  timer.unref?.();
  return { tick, first, timer };
}

function start(deps = {}) {
  health.record('daemon', { at: Date.now(), pid: process.pid, version: health.VERSION });
  const terminalProfile = deps.terminalProfile || require('./terminal-profile').createTerminalProfileStore();
  let consoleServer = null;
  let dashboardBuilder = null;
  let dashboardPublisher = null;
  let uiWorker = null;
  let backendServer = null;
  let backendSock = null;
  let retainedPublication = null;
  let announced = false;
  const mutationEpoch = crypto.randomBytes(12).toString('hex');
  let mutationSequence = 0;
  const mutationFence = () => `${mutationEpoch}:${mutationSequence}`;
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
    dashboardPublisher?.close();
    dashboardBuilder?.close();
    uiWorker?.close();
    consoleServer?.close();
    backendServer?.close();
    try { if (backendSock) fs.unlinkSync(backendSock); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // launchd appends stdout+stderr here forever; cap it at startup
  try {
    const logFile = path.join(keep.ROOT, '.keep', 'serve.log');
    if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.truncateSync(logFile);
  } catch {}

  dashboardBuilder = deps.dashboardWorker || createDashboardWorker({
    prepare: (input) => ({ ...input, dashboardRuntime: dashboardRuntimeSnapshot() }),
    finalize: finalizeDashboardWorkerResult,
  });
  const jobLedger = require('./background-jobs');
  backgroundJobScheduler = jobLedger.createScheduler({ fallbackMs: 10 * 60e3, fallbackSlotTicks: 20 });
  for (const target of backgroundTargets.values()) backgroundJobScheduler.register(target);
  const dashboardBuild = (options) => dashboardBuilder.build({
    hostPanes: options.hostPanes || [],
    companion: options.companion || null,
  });
  const publishedPanes = { panes: null, at: 0, epoch: 0 };
  let lastPaneEpoch = 0;
  dashboardPublisher = createDashboardPublisher({
    prepare: async () => {
      // Fence before every source read. A mutation that completes while panes,
      // review launch state, or companion jobs are being collected invalidates
      // this running pass and forces a follow-up carrying the newer fence.
      const capturedMutationFence = mutationFence();
      const paneEpoch = publishedPanes.epoch;
      // After a mutation, skip listHostPanes' one-second cache: a lookup that began
      // before the mutation may have filled it with the panes the mutation changed.
      const freshPanes = paneEpoch !== lastPaneEpoch;
      lastPaneEpoch = paneEpoch;
      const panes = hostPanesForPublish(await listHostPanes(deps, freshPanes), publishedPanes, Date.now(), paneEpoch);
      await reviewQueue.reconcile({ inspectLaunch: (active) => inspectReviewQueueLaunch(active) });
      const companion = await companionSnapshot(deps);
      return { hostPanes: panes, companion, mutationFence: capturedMutationFence };
    },
    build: async (input) => ({
      state: await dashboardBuild(input),
      portableTransfers: listPortableTransfers(),
      mutationFence: input.mutationFence,
    }),
    publish: (publication) => {
      retainedPublication = publication;
      uiWorker?.publish(publication);
    },
    minIntervalMs: envNumber('KEEP_DASHBOARD_MIN_INTERVAL_MS', 5000),
    onError: (error) => process.stderr.write(`keep serve: dashboard refresh failed; retaining published state: ${error.message}\n`),
  });
  const broadcast = () => dashboardPublisher.invalidate();
  onChange = broadcast;
  // A focus request (mobile 'Open on Mac') is a named SSE event the console acts on.
  onFocus = (sessionId) => uiWorker?.event({ type: 'focus', data: sessionId });

  const watch = (target, opts, invalidate) => {
    try {
      const w = fs.watch(target, opts || {}, (_event, name) => { invalidate?.(name); broadcast(); });
      w.on('error', () => {}); // a dead watch must never crash the server; the client's 30s poll covers it
    } catch (e) {
      process.stderr.write(`keep serve: cannot watch ${target} (${e.message}); relying on client polling\n`);
    }
  };
  watch(keep.TASKS, null, (name) => { dashboardBuilder.invalidate({ kind: 'tasks', name }); dashboardPublisher.invalidate(); });
  // Watch the directory so ledger creation and atomic read-state renames are seen.
  try {
    const inboxWatch = fs.watch(path.join(keep.ROOT, '.keep'), (_event, name) => {
      if (!name || ['alerts.jsonl', 'notifications.json', 'quiet.json'].includes(String(name))) {
        dashboardBuilder.invalidate({ kind: 'runtime', name });
        dashboardPublisher.invalidate();
        broadcast();
      }
    });
    inboxWatch.on('error', () => {});
  } catch {} // The console's periodic refresh also covers inbox changes.
  watch(path.join(keep.ROOT, 'digests'), null, (name) => { dashboardBuilder.invalidate({ kind: 'digests', name }); dashboardPublisher.invalidate(); });
  try { fs.mkdirSync(path.join(keep.ROOT, '.keep', 'attention'), { recursive: true }); } catch {}
  watch(path.join(keep.ROOT, '.keep', 'attention'), null, (name) => { dashboardBuilder.invalidate({ kind: 'attention', name }); dashboardPublisher.invalidate(); });
  try { fs.mkdirSync(path.join(keep.ROOT, '.keep', 'unblocked'), { recursive: true }); } catch {}
  watch(path.join(keep.ROOT, '.keep', 'unblocked'), null, (name) => { dashboardBuilder.invalidate({ kind: 'unblocked', name }); dashboardPublisher.invalidate(); });
  try { fs.mkdirSync(path.join(keep.ROOT, '.keep', 'review'), { recursive: true }); } catch {}
  watch(path.join(keep.ROOT, '.keep', 'review'), null, (name) => { dashboardBuilder.invalidate({ kind: 'review', name }); dashboardPublisher.invalidate(); });
  for (const entry of claudeProjectRoots) {
    watch(entry.root, { recursive: true }, (name) => {
      claudeTranscriptIndex.invalidate(entry.root, name);
      if (name) backgroundJobScheduler?.wakeFile(path.join(entry.root, String(name)));
      dashboardBuilder.invalidate({ kind: 'claude', root: entry.root, name });
      dashboardPublisher.invalidate();
    });
  }
  for (const sessionsRoot of new Set(codex.configuredRoots().map((entry) => path.join(entry.configDir, 'sessions')))) {
    watch(sessionsRoot, { recursive: true }, (name) => {
      if (name) backgroundJobScheduler?.wakeFile(path.join(sessionsRoot, String(name)));
      dashboardBuilder.invalidate({ kind: 'codex', root: sessionsRoot, name });
      dashboardPublisher.invalidate();
    });
  }
  try { fs.mkdirSync(path.join(keep.ROOT, '.keep', 'lifecycle'), { recursive: true }); } catch {}
  watch(path.join(keep.ROOT, '.keep', 'lifecycle'), { recursive: true },
    (name) => { dashboardBuilder.invalidate({ kind: 'lifecycle', name }); dashboardPublisher.invalidate(); });
  try { fs.mkdirSync(path.join(keep.ROOT, '.keep', 'session-accounts'), { recursive: true }); } catch {}
  watch(path.join(keep.ROOT, '.keep', 'session-accounts'), null,
    (name) => { dashboardBuilder.invalidate({ kind: 'accounts', name }); dashboardPublisher.invalidate(); });
  try { fs.mkdirSync(path.join(keep.ROOT, '.keep', 'background-jobs'), { recursive: true }); } catch {}
  // Only immutable hook inbox writes wake a parked ledger here. sync() itself
  // atomically rewrites state.json, and waking on that write would immediately
  // undo every park and recreate the old polling loop.
  try {
    const jobsWatch = fs.watch(path.join(keep.ROOT, '.keep', 'background-jobs'), { recursive: true }, (_event, name) => {
      if (!backgroundJobScheduler?.wakeInbox(name)) return;
      const key = String(name).split(/[\\/]+/).slice(0, 2).join(':');
      dashboardBuilder.invalidate({ kind: 'background-jobs', name: key });
      dashboardPublisher.invalidate();
      broadcast();
    });
    jobsWatch.on('error', () => {});
  } catch {}

  for (const target of jobLedger.targets(keep.ROOT)) registerBackgroundTarget(target);
  // One bounded incremental read per tick, outside HTTP state assembly.
  const jobsChanged = createJobChangeTracker();
  const jobTick = () => {
    const selected = backgroundJobScheduler.select(Date.now());
    if (!selected) return;
    const { key, target } = selected;
    // The same child transcript paths restart-ledger resolves: inspection reads
    // them, abandonment needs their mtime as the child's last writing evidence.
    const childTranscriptFor = (id) => {
      if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) return null;
      return target.agent === 'claude'
        ? path.join(path.dirname(target.file), path.basename(target.file, '.jsonl'), 'subagents', `agent-${id}.jsonl`)
        : codex.findRolloutFile(id);
    };
    try {
      const result = jobLedger.sync({ root: keep.ROOT, ...target,
        classify: (name, input) => isBoundedBackgroundWatcher('Bash', { ...input, command: input?.command || input?.cmd, run_in_background: true }) ? 'finite'
          : isBackgroundService('Bash', { ...input, command: input?.command || input?.cmd }) ? 'service' : 'unknown',
        inspectAgent: (id) => {
          if (target.agent === 'claude') {
            const file = childTranscriptFor(id);
            if (!file) return null;
            const child = scanChildTranscript(file);
            return { at: child.attentionAt || 0, done: child.explicitEndTurn && !child.pendingOther && !child.pendingBackground };
          }
          return require('./codex-lifecycle').inspectChild(id, target.sid);
        },
        childTranscriptFor,
      });
      // One replay per decision: the next dashboard pass re-asks, rate limited.
      delete target.coldReplay;
      backgroundJobScheduler.observe(key, target, result, Date.now());
      if (result.redirect?.agent === target.agent && result.redirect.sid === target.sid && result.redirect.file) {
        registerBackgroundTarget(result.redirect);
      }
      if (jobsChanged(key, result)) {
        dashboardBuilder.invalidate({ kind: 'background-jobs', name: key });
        dashboardPublisher.invalidate();
        broadcast();
      }
    } catch (error) { process.stderr.write(`keep jobs: ${error.message}\n`); }
  };
  setInterval(jobTick, 500).unref();

  // Everything the daemon's request ladder and periodic jobs need from this
  // module and from start()'s own scope. bin/serve/routes.js and
  // bin/serve/schedulers.js take this instead of requiring serve.js, which would
  // be a cycle. Bindings start() has not made yet, and the module-level state the
  // rest of the daemon rebinds, are getters so they are read live.
  const ctx = {
    ATTENTION_KINDS, InjectionError, MOBILE_VIEWS, TAG_INSTRUCTION, TASK_INSTRUCTION,
    TURN_INDEX_BUDGET_BYTES, TURN_INDEX_BUDGET_MS, TURN_INDEX_PRUNE_LIMIT, WATCHER_CONCURRENCY,
    WATCHER_TURNS_PER_TICK, WATCHER_WINDOW_MS, WEB_ROOT,
    abandonAccountHandoff, accounts, addHostSessionState, agentProcessRows, announceStateNote,
    answerSession, attentionAckKey, attentionAckName, buildState, cardUsage, closeEphemeralPane,
    closeIdleSession, codex, compactSessionById, compactState, companionSnapshot, daemonRestartGate,
    dashboardDetail, deliverCheckToThread, deliverUnblockToThread, discord, driftWakeFromVerdict,
    envNumber, features, forceRestartSession, fs, handoffSession, health, hostRequest, ideas,
    inspectReviewQueueLaunch, keep, keepConsole, landed, launchReviewQueueSession, lightweightState,
    limitresume, listHostPanes, listPortableTransfers, liveSessionTick, liveTurnIndexSessions,
    loadCurrentSession, notifications, openCheckSession, openSession, path, portableTransferDraft,
    portableTransferPreview, preparePortableTransfer, prepareSessionSummary, projectMobileState,
    readLiveSessionLedger, readScreenResult, recentTranscriptText, recoverReviewQueueLaunch, reminders,
    reopenSessionOnAccount, resolvePortableTransfer, resolveReviewLaunchSelection, restartSession,
    restorePlan, resumeAfterLimit, review, reviewDeps, reviewQueue, reviewQueueSearch, runCheckNow,
    runTaskNow, runs, scanSessions, screenHistorySession, screenSession, sendSessionKeys,
    sendStateJson, sendToSession, sendToSessionLocked, sessionSummaryFile, sessionSummarySnapshot,
    setAsideCandidates, slack, stallAliveIds, stalled, stalledSessionSnapshot, standup,
    startAutoCompact, startBriefScheduler, startWtGcScheduler, summarize, transferSession,
    unblock, updateSetAside, usage, wantsCompactState, wantsLightweightState, watcherSend,
    withInjectionLock, writeTarget, writeToShellPane,
    broadcast, dashboardBuild, dashboardBuilder, deps, shutdown, terminalProfile,
    get json() { return json; },
    get onChange() { return onChange; },
    get onFocus() { return onFocus; },
    get restarts() { return restarts; },
    get sessionSnapshot() { return sessionSnapshot; },
    get sessionSnapshotAt() { return sessionSnapshotAt; },
  };

  const { restarts } = startSchedulers(ctx);

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

  const requestRoutes = buildRequestRoutes(ctx);

  const server = http.createServer(async (req, res) => {
    if (req.keepConsoleHandled) return;
    try {
      const url = new URL(req.url, 'http://localhost');

      const authError = apiRequestAuthError(req, { isLocal, token, internalToken: backendToken });
      if (authError) return json(res, authError.status, { error: authError.error });

      if (req.method === 'POST') {
        // custom header forces a CORS preflight, which no other origin passes —
        // keeps random web pages from firing POSTs at localhost
        let body;
        try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
        try {
          const route = matchRoute(requestRoutes, { req, url, body });
          if (route) return await route.handle({ req, res, url, body });
          return json(res, 404, { error: 'not found' });
        } catch (e) {
          if (e instanceof keep.KeepError) return json(res, 400, { error: e.message });
          throw e;
        }
      }

      const route = matchRoute(requestRoutes, { req, url });
      if (route) return await route.handle({ req, res, url });
      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      process.stderr.write(`keep serve: request failed: ${e.message}\n`);
      try {
        if (!res.headersSent) res.writeHead(e instanceof keep.KeepError ? 400 : 500, { 'content-type': 'text/plain' });
        res.end(`keep serve error: ${e.message}`);
      } catch {}
    }
  });

  const backendToken = crypto.randomBytes(32).toString('hex');
  consoleServer = keepConsole.install({
    server,
    hostClient: () => require('./hostclient.js').connect({ timeoutMs: HOST_CONNECT_TIMEOUT_MS }),
    hostRequest,
    hostSock: require('./hostclient.js').socketPath(),
    hostConnectTimeoutMs: HOST_CONNECT_TIMEOUT_MS,
    isLocal,
    token,
    internalToken: backendToken,
    root: keep.ROOT,
  });
  // This listener runs before both the console and daemon route handlers. A
  // successful authoritative request receives a core-owned fence only after its
  // mutation has completed, at writeHead. Dashboard builds capture the fence in
  // prepare(), so an older in-flight build can never satisfy a post-write reload.
  server.prependListener('request', (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const writeHead = res.writeHead;
    let fenced = false;
    res.writeHead = function fencedWriteHead(status, ...args) {
      if (!fenced && status >= 200 && status < 300) {
        fenced = true;
        mutationSequence += 1;
        res.setHeader('x-keep-mutation-fence', mutationFence());
        // A client waits for this fence after a real mutation; skip the background
        // rebuild throttle only then. Read-only POSTs arrive every few seconds.
        let pathname = '';
        try { pathname = new URL(req.url, 'http://localhost').pathname; } catch {}
        if (urgentDashboardMutation(pathname)) {
          // A mutation may have changed panes (kill, remove, open). A remembered pane
          // list predates it and must not be republished under the post-mutation fence.
          publishedPanes.panes = null;
          publishedPanes.at = 0;
          publishedPanes.epoch += 1; // a lookup already in flight must not refill it
          dashboardPublisher.refresh();
        } else dashboardPublisher.invalidate();
      }
      return writeHead.call(this, status, ...args);
    };
  });

  backendServer = server;
  // Unix-domain socket paths are limited to roughly 100 bytes on macOS. Keep the
  // endpoint short; the random backend credential and mode 0600 provide the trust boundary.
  backendSock = path.join('/tmp', `keep-ui-${process.getuid?.() ?? 'user'}-${process.pid}.sock`);
  try { fs.unlinkSync(backendSock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  server.listen(backendSock, () => {
    try { fs.chmodSync(backendSock, 0o600); } catch (error) {
      process.stderr.write(`keep serve: cannot protect UI backend socket: ${error.message}\n`);
      shutdown();
      return;
    }
    uiWorker = createUiRequestWorker({
      workerOptions: {
        root: keep.ROOT,
        token,
        backendToken,
        backendSock,
        hostSock: require('./hostclient.js').socketPath(),
        hostConnectTimeoutMs: HOST_CONNECT_TIMEOUT_MS,
        webRoot: WEB_ROOT,
        modulesRoot: path.join(__dirname, '..', 'node_modules'),
        port: PORT,
        host: process.env.KEEP_HOST || '127.0.0.1',
      },
      onPublished: () => {
        if (announced) return;
        announced = true;
        console.log(`keep serve — http://localhost:${PORT}`);
      },
    });
    if (retainedPublication) uiWorker.publish(retainedPublication);
  });
}

module.exports = {
  repairEnvFor,
  messageWatcherDashboardState,
  prepareSessionSummary, sessionSummarySnapshot, associateDashboardSessionFiles,
  start,
  apiRequestAuthError,
  agentPromptVisible,
  typeOpeningMessage,
  isInjectionBusy,
  withInjectionLock,
  sendToSessionLocked,
  startAutoCompact,
  autoCompactIdleMs,
  autoCompactPolicy,
  autoCompactCandidates,
  autoCompactOutcome,
  autoCompactTick,
  compactSession,
  compactRequestTelemetry,
  hasCompactionMarker,
  compactSwapPlan,
  ensureCompactionRestored,
  afterCompactAction,
  pendingCompactSwaps,
  readPendingCompactSwap,
  sweepPendingCompactSwaps,
  shutdownSettingsRepair,
  readClaudeSettingsModel,
  linesAfterLastEcho,
  compactScreenConfirmed,
  modelSwitchConfirmed,
  modelSwitchDialogVisible,
  repairClaudeSettingsModel,
  pickNotifyTarget,
  pickDeliveryCandidates,
  checkDeliveryIds,
  deliverCheckToThread,
  shouldCompactFirst,
  lastTurnUsage,
  sessionLastTurn,
  lastClaudeHandoffModel,
  lastContextTokens,
  compactRefusal,
  compactCommand,
  chunkForTyping,
  deliveredMatches,
  exactDraft,
  driftWakeFromVerdict,
  announceStateNote,
  closeDraftVisible,
  codexTypedTextVisible,
  claudeTypedTextVisible,
  closeIdleSession,
  restartSession,
  reviewerResumeSpec,
  forceRestartSession,
  applyHostedExitState,
  coldReplayDue,
  closeExitedCodexShell,
  scanSessions,
  invalidateDashboardSources,
  stalledSessionSnapshot,
  liveTurnIndexSessions,
  hostPanesForPublish,
  urgentDashboardMutation,
  buildState,
  applySessionLiveness,
  backfillHostSessions,
  briefDue,
  startBriefScheduler,
  startWtGcScheduler,
  buildWhoSnapshot,
  scanTranscript,
  claudeTranscriptIsInteractive,
  claudeSessionFromInfo,
  sessionBackgroundPending,
  stallAliveIds,
  companionSnapshot,
  applyCompanionJobs,
  claudeSessionFor,
  createDashboardClaudeSessionResolver,
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
  discardTypedDraft,
  draftRegionText,
  draftIsExactly,
  watcherSend,
  resolveSessionTarget,
  resolveSessionId, screenSession, screenHistorySession, sendSessionKeys, shellPaneTarget, stripTerminalAnsi, writeToShellPane,
  agentProcessRows, liveSessionPids, liveSessionTick, restorePlan,
  annotatePaneAgents,
  readPaneRecord, sessionProjectFromTranscript, openSession, reopenSessionOnAccount,
  runCheckNow, runTaskNow, taskRunMessage, adoptedPaneMeta, closeEphemeralPane,
  inspectAccountHandoff, waitForAccountRecord, resumeExitedAccountHandoff, continueAccountHandoff, handoffSession,
  abandonAccountHandoff,
  listPortableTransfers, inspectPortableSource, portableTerminalRateLimitEvidence,
  portableTransferDraft, preparePortableTransfer,
  portableTransferPreview, transferSession, resolvePortableTransfer, recoverPortableOpening,
  resolveReviewLaunchSelection, launchReviewQueueSession, inspectReviewQueueLaunch, recoverReviewQueueLaunch,
  waitForHostAgent, waitForHostSessionId, addHostSessionState,
  sendToSession, sendToResolvedTarget, precheckSessionTarget, InjectionError,
  claudeMcpMenuVisible,
  resumeAfterLimit,
};

if (require.main === module) start();
