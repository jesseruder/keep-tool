'use strict';
// keep serve — local dashboard server. No dependencies.
// Data sources: the keep repo (via keep.js), live Claude Code transcripts,
// and top-level Codex rollouts (read-only tailing).

const fs = require('fs');
const path = require('path');
const { ref: sessionRef } = require('./session-numbers.js');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Worker } = require('node:worker_threads');
const { AsyncLocalStorage } = require('async_hooks');
const { promisify } = require('util');
const keep = require('./keep.js');
const nodes = require('./nodes.js');
const pressure = require('./pressure.js');
const runs = require('./runs.js');
const summarize = require('./summarize.js');
const titles = require('./titles.js');
const usage = require('./usage.js');
const cardUsage = require('./card-usage.js');
const codex = require('./codex.js');
const pi = require('./pi.js');
const codexCompact = require('./codex-compact.js');
const transcripts = require('./transcripts.js');
const accounts = require('./accounts.js');
const artifactTransport = require('./artifact-transport.js');
const openAccount = require('./open-account.js');
const tell = require('./tell.js');
const review = require('./review.js');
const reviewQueue = require('./review-queue.js');
const who = require('./who.js');
const steps = require('./steps.js');
const alerts = require('./alerts.js');
const agents = require('./agents.js');
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
const sessionNumbers = require('./session-numbers.js');
const sessionNames = require('./session-names.js');
const sessionMarks = require('./session-marks.js');
const keepConsole = require('./console.js');
const sessionStatus = require('./session-status.js');
const { sendStateJson } = require('./state-response.js');
const { MOBILE_VIEWS, projectMobileState } = require('./mobile-state.js');
const { createScreenHistoryCache } = require('./screen-history.js');
const { createSettledSessionCache } = require('./settled-session-cache.js');
const claudePrompts = require('./claude-prompts.js');
// One copy, shared with the recognizer that reads the same screen rows.
const { normalizedText } = claudePrompts;

const PORT = parseInt(process.env.KEEP_PORT || '7777', 10);
const { PROJECTS_DIR, TAIL_BYTES, textOf, readTranscriptTail, lastTurnUsage, findSessionFile } = transcripts;
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
  createJobChangeTracker, attachStateLines, shadowDecisionSummary,
  wantsConsoleState, consoleState,
  dashboardDetail, reviewQueueSearch,
} = require('./dashboard-state');
const { createDashboardWorker } = require('./dashboard-worker');
const { createDashboardPublisher } = require('./dashboard-publisher');
const { createUiRequestWorker } = require('./ui-request-worker');
const { routes: buildRequestRoutes, matchRoute, routeDenial } = require('./serve/routes.js');
// Names whoever holds the event loop, so the lag probe's stall line can say who
// (bin/loop-hold.js). The interval ticks started here run inside a hold, named
// after their health row where they have one and after the tick otherwise.
const loopHold = require('./loop-hold.js');
const { startSchedulers } = require('./serve/schedulers.js');
const execFileAsync = promisify(execFile);
const ATTENTION_KINDS = new Set(['question', 'plan', 'permission', 'complete', 'input', 'review', 'blocked', 'overdue', 'unblocked', 'health', 'stalled']);
// One line of ordinary text. No ESC, no carriage return, no newline, no other C0
// or C1 control: those are not characters in a box, they are instructions to the
// terminal - Up recalls an earlier prompt into the composer, Enter submits what is
// already there and starts another - and the pane's counter counts the write, never
// what the application made of it.
const PLAIN_ONE_LINE_RE = /^[^\u0000-\u001f\u007f-\u009f]+$/;
const CODEX_DIALOG_MARKERS = [
  'Would you like to run the following command?',
  'Press enter to confirm or esc to cancel',
  'Do you trust the contents of this directory?',
  'Press enter to continue',
];
// What the trust screen asks, as opposed to what its options say.
const CLAUDE_TRUST_QUESTIONS = [
  'Do you trust the contents of this directory?',
  'Do you trust the files in this folder?',
  'Is this a project you created or one you trust',
  'Quick safety check',
];
const CLAUDE_TRUST_MARKERS = [...CLAUDE_TRUST_QUESTIONS, 'Yes, I trust this folder'];
// One row of its option list, read as a row: a line that begins with the number.
const CLAUDE_TRUST_OPTION = /^\s*(?:❯\s*)?\d+\.\s+(?:Yes, I trust|No, exit|Yes, proceed)/m;

// A trust screen, not a mention of one. These phrases turn up in ordinary conversation
// -- Keep's own transcripts quote them -- and a session that has one on screen while it
// is still starting up is not a dialog. The question and an option row under it are.
function claudeTrustScreen(plain) {
  const asked = CLAUDE_TRUST_QUESTIONS.map((marker) => plain.indexOf(marker)).filter((at) => at >= 0);
  if (!asked.length) return false;
  const option = CLAUDE_TRUST_OPTION.exec(plain);
  return Boolean(option) && option.index > Math.min(...asked);
}
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
const PROCESS_ROWS_CACHE_MS = 2500;
let processRowsCache = { at: 0, value: null, pending: null };
// A frozen or non-advancing clock must not spin the poll loop forever.
const SUGGESTION_PROBE_MAX_READS = Math.ceil(SUGGESTION_PROBE_MAX_MS / SUGGESTION_PROBE_WAIT_MS) + 1;
// The probe's Backspace is sent, not awaited — but the very next screen read is often
// someone else's (the same tick's precheck and restore both read the pane). A read that
// still shows the collapsed probe key becomes the next probe's "before", and that probe
// sees `,` before and `,` after: 'unchanged', and a refusal every minute. Wait for the
// undo to render so a probe always leaves a settled screen behind it.
const SUGGESTION_PROBE_SETTLE_MS = 1000;
const SUGGESTION_PROBE_SETTLE_READS = Math.ceil(SUGGESTION_PROBE_SETTLE_MS / SUGGESTION_PROBE_WAIT_MS);

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
  return item.id ? `${item.id}:${item.since || item.at}` : `${item.kind}:${item.sessionId || item.taskId || item.pane || ''}:${item.since}`;
}

function attentionAckName(key) {
  return crypto.createHash('sha1').update(key).digest('hex');
}

function attentionItemKey(item) {
  return item.key || item.sessionId || item.taskId || item.pane || `${item.kind}:${item.title}:${item.since}`;
}

function pendingPaneAttention(panes, sessions, now = Date.now()) {
  const boundPanes = new Set((sessions || []).map((session) => session.pane).filter(Boolean));
  return (panes || []).flatMap((pane) => {
    if (!pane?.alive || pane.agentAlive === false || boundPanes.has(pane.id)
        || pane.meta?.sessionId || pane.meta?.awaitingOwnerInput !== true) return [];
    return [{ key: pane.id, kind: 'input', pri: 0, pane: pane.id,
      project: pane.meta?.project || pane.cwd || '', title: pane.meta?.title || pane.title || 'New session',
      detail: 'Ready for your next instruction.', attentionLabel: 'Ready for next instruction',
      since: Date.parse(pane.createdAt) || now }];
  });
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
    && (entry.paneId === undefined || typeof entry.paneId === 'string')
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
      if (entry.paneId && !current.has(key)) { changed = true; continue; }
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
    ...(item.pane && !item.sessionId ? { paneId: item.pane } : {}),
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
  if (session?.kind === 'pi') return session.sessionFile || pi.fileFor(session.id);
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
  const input = session.kind === 'codex' ? (deps.codex || codex).recentText(file)
    : session.kind === 'pi' ? pi.recentText(file) : recentTranscriptText(file);
  return (deps.getSummary || summarize.getSummary)(`session-${session.id}`, input, SESSION_INSTRUCTION, onChange, options);
}

async function sessionSummarySnapshot(deps = {}) {
  const panes = await listHostPanes(deps) || [];
  const live = [...hostPanesBySession(panes).values()].filter((p) => p.alive && ['claude', 'codex', 'pi'].includes(p.meta?.agent));
  if (!live.length) return { sessions: [], panes };
  // Use the same marker-enriched classification as Triage. Raw transcript
  // lookups omit permission notifications that can arrive in the middle of a turn.
  const state = await (deps.dashboardBuild || deps.buildState || buildState)({ hostPanes: panes, dashboard: true });
  return { sessions: state.sessions, panes };
}
const WEEKLY_INSTRUCTION = "Summarize what this solo developer completed in the last week. Group related work into 3-6 themed bullets and note anything notable that shipped. Be specific; output only the summary.";
let onChange = () => {};
let onFocus = () => {};
let sweepInFlight = false;
let inFlightSwap = null;
// A node's registry command the daemon is running (bin/registry-route.js): a
// restart that killed it would leave its mutation half-known. Set in start() when
// the node API is on; single-node it stays false.
let registryRunsInFlight = () => false;
const daemonRestartGate = require('./daemon-restart').createGate({
  busy: () => sweepInFlight || injectionLocked() || registryRunsInFlight(),
});
let liveSessionTickInFlight = false;
let lastAutoCompactGc = 0;
let reviewStateCache = { at: 0, value: null };
const hostPaneCaches = new WeakMap();
// Which host process each connection reaches, for the one question that outlives a
// single request: may a spawn sent on it be asked about again?
const hostGenerations = new WeakMap();
// The hello in flight for a connection, so concurrent first spawns share one.
const hostGenerationRequests = new WeakMap();
const lastKnownHostPaneMemo = { panes: null, at: 0 };
// Which pane results came from a cache rather than from a host this time round.
// Out of band because the result object itself is what a single-node install
// returns, and its shape must stay exactly what every caller already expects.
const cachedPaneResults = new WeakSet();
const nodePaneMemo = new Map();
// Bumped before every request that can change the host, so a list collected
// across a spawn or replacement is never remembered as the last known state.
let hostMutationEpoch = 0;
// One set of connections per node, keyed `<node>\0<channel>`. Each has its own
// client, its own negative cache and its own failure, so a node that is down
// cannot make its neighbours look down.
const hostChannels = new Map();
const HOST_FAILURE_CACHE_MS = 5000;
const HOST_PANE_CACHE_MS = 1000;
const HOST_CONNECT_TIMEOUT_MS = 3000;
const HOST_REQUEST_TIMEOUT_MS = 8000;
// A remote node's share of a pane list. Deliberately far below the request timeout:
// the list is a dashboard read, and a node that cannot answer inside it is reported
// as silent rather than allowed to hold up the panes on this machine.
const HOST_REMOTE_LIST_TIMEOUT_MS = 1500;
const HOST_RELOAD_RETRY_MS = 3000;
// Long enough for a healthy host to say who it is, short enough that a sick one
// cannot spend a spawn's window telling us it could have been retried.
const HOST_GENERATION_TIMEOUT_MS = 2000;

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
  const injected = Boolean(deps.discoverCodexJobs || deps.discoverPiJobs);
  const empty = () => ({ known: true, complete: true, discovery: 'ok', jobs: [] });
  const discoverCodex = deps.discoverCodexJobs
    || (injected ? empty : (options) => require('./codexjobs').list(options));
  const discoverPi = deps.discoverPiJobs
    || (injected ? empty : (options) => require('./pi-jobs').list(options));
  const discover = async (options) => {
    // Pane annotation, Codex companion discovery, and Pi job reconciliation all
    // need the same process table during one publication. agentProcessRows owns a
    // short cache so this joins the pane list's read instead of spawning more ps.
    const rows = Array.isArray(deps.processRows) ? deps.processRows
      : injected ? null : await agentProcessRows(deps);
    const shared = rows ? {
      ...options,
      processRows: rows,
      psKnown: true,
      psOutput: rows.map((row) => `${row.pid} ${row.elapsed || '00:00'} ${row.args || ''}`).join('\n'),
    } : options;
    const [codexJobs, piJobs] = await Promise.all([
      Promise.resolve(discoverCodex(shared, deps)),
      Promise.resolve(discoverPi(shared, deps)),
    ]);
    const snapshots = [codexJobs, piJobs].filter(Boolean);
    const known = snapshots.some((snapshot) => snapshot.known
      ?? (snapshot.discovery && snapshot.discovery !== 'unknown'));
    const complete = snapshots.every((snapshot) => snapshot.complete === true
      || snapshot.discovery === 'ok');
    return {
      known,
      complete,
      discovery: !known ? 'unknown' : complete ? 'ok' : 'partial',
      jobs: snapshots.flatMap((snapshot) => snapshot.jobs || []),
    };
  };
  const now = typeof deps.now === 'function' ? Number(deps.now()) : Number(deps.now ?? Date.now());
  // Injected discovery is request scoped and must not share production cache state.
  if (injected) {
    return discover({ root: deps.root || keep.ROOT, fallbackCacheMs: COMPANION_SNAPSHOT_MS });
  }
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
    if (!job.id || !['running', 'queued', 'cancelling', 'stalled'].includes(state) || typeof job.sessionId !== 'string' || !job.sessionId) continue;
    if (!byOwner.has(job.sessionId)) byOwner.set(job.sessionId, []);
    byOwner.get(job.sessionId).push({
      id: String(job.id), kind: 'companion', status: 'pending', recurring: false,
      startedAt: stalled.timeMs(job.startedAt || job.createdAt), expiresAt: null, current: true,
    });
  }
  for (const session of sessions || []) {
    const owned = byOwner.get(session.id) || [];
    const existing = session.backgroundJobs;
    const priorJobs = existing?.jobs || [];
    const hadCompanion = priorJobs.some((job) => job.kind === 'companion');
    if (!owned.length && !hadCompanion) continue;
    const background = existing || {
      jobs: [], uncertain: [], caughtUp: true, turnStartedAt: session.turnStartedAt || 0,
    };
    const companionIds = new Set(owned.map((job) => job.id));
    const nativeJobs = priorJobs.filter((job) => job.kind !== 'companion'
      && !companionIds.has(String(job.id)));
    const nativePending = nativeJobs.some((job) => {
      const state = job.state || job.status;
      return !['completed', 'failed', 'cancelled', 'succeeded', 'dead'].includes(state)
        && !['service', 'scheduled'].includes(job.kind);
    });
    session.backgroundJobs = {
      ...background,
      jobs: [...nativeJobs, ...owned],
      pending: owned.length > 0 || (hadCompanion ? nativePending : Boolean(background.pending)),
    };
    session.pendingBackground = owned.length > 0 || (hadCompanion ? nativePending : Boolean(session.pendingBackground));
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
    // it is matched on the sentence the harness prints, which names the model
    // version or not ("your Fable limit", "your Fable 5.1 limit"), rather than
    // on a bare "Fable".
    type: RATE_LIMIT_TYPES.includes(declared) ? declared
      : /reached your Fable\b.*\blimit/i.test(String(text || '')) ? 'fable_weekly'
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
  return scanTranscriptText(text, file, options);
}

// The scan itself, over text already in hand. `file` is only recorded as where a
// background agent's own transcripts live; a node's tail passes null.
function scanTranscriptText(text, file, options = {}) {
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
  // A typed local command (/compact, /model, ...) is logged as a bare user prompt;
  // the stdout/stderr wrapper that follows is the harness finishing it. The turn is
  // over even though no assistant record follows. Claude Code writes the wrapper
  // either as a user record or as a `system`/`local_command` record.
  const finishLocalCommand = (t, stdout) => {
    // Claude Code randomizes the farewell (Goodbye!, Bye!, See ya!, ...), so the
    // /exit command that precedes it is the signal; the literals cover old transcripts.
    if (stdout && (exitCommand || /^<local-command-stdout>(?:Goodbye!|Bye!|Catch you later!|See ya!)<\/local-command-stdout>$/.test(t.trim()))) out.exited = true;
    exitCommand = false;
    lastRealEvent = 'assistant';
    lastStopReason = 'end_turn';
    lastAssistantHadText = true;
  };
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
        finishLocalCommand(t, true);
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
    // Newer Claude Code logs the same local command as a `system` record with the
    // wrapper in a top-level string `content` and no `message`. A failed /compact
    // leaves only a stderr row, so without this the session stays "mid-turn" forever.
    // Only a wrapper that closes a command turn a bare slash-command prompt opened
    // ends anything. Claude also writes these rows mid-turn when Owner presses
    // /model while the model is working: there the last real event is the tool
    // result or the assistant, the turn resumes a second later, and treating the
    // wrapper as the end of it would hand a live turn to a restart or a cleanup.
    if (j.type === 'system' && j.subtype === 'local_command' && typeof j.content === 'string'
        && lastRealEvent === 'user' && (out.lastUser || '').startsWith('/')) {
      const t = j.content.trimStart();
      if (t.startsWith('<local-command-stdout>')) {
        finishLocalCommand(t, true);
        // Owner (or the daemon) was at the keyboard, so the session is no longer
        // parked on a limit error. A stderr row proves no such thing.
        out.rateLimit = null;
      } else if (t.startsWith('<local-command-stderr>')) {
        finishLocalCommand(t, false);
        // A /compact that the model's own window refuses ("Error during compaction:
        // You've reached your Fable limit.") leaves no assistant record at all, so this
        // stderr row is the only evidence the session is parked on the limit. Only a
        // row the classifier recognizes counts; every other stderr row says nothing
        // about the window and leaves rateLimit as it was.
        const limit = rateLimitInfo(j, t.replace(/^<local-command-stderr>/, '').replace(/<\/local-command-stderr>\s*$/, ''));
        if (limit.type !== 'unknown') out.rateLimit = limit;
      }
      // A <command-name> system row is only the echo of the typed command; the
      // user record already carried it. It neither starts nor ends a turn.
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

const CLOSE_TRANSCRIPT_TIMEOUT_MS = 30e3;
// Graceful close needs the complete lifecycle, not the last few megabytes: a
// background launch can be old while its completion is absent. Put that full read
// and JSON parsing in a short-lived worker so it cannot stall the daemon loop.
function inspectCloseTranscript(file, kind, deps = {}) {
  if (deps.inspectCloseTranscript) return deps.inspectCloseTranscript(file, kind);
  const WorkerClass = deps.Worker || Worker;
  const workerFile = deps.closeTranscriptWorker || path.join(__dirname, 'close-transcript-worker.js');
  const timeoutMs = deps.closeTranscriptTimeoutMs == null ? CLOSE_TRANSCRIPT_TIMEOUT_MS : deps.closeTranscriptTimeoutMs;
  return new Promise((resolve, reject) => {
    const worker = new WorkerClass(workerFile, { workerData: { file, kind } });
    let settled = false;
    // The caller holds the injection lock while this runs; a worker stuck on a
    // swapped-out disk must not hold it for the console's whole deadline and beyond.
    const timer = setTimeout(() => {
      finish(new Error(`close transcript scan timed out after ${Math.round(timeoutMs / 1000)}s; leave the session open`));
      try { worker.terminate(); } catch {}
    }, timeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    worker.once('message', (message) => {
      if (message?.error) finish(new Error(message.error.message || message.error));
      else finish(null, message?.result || {});
    });
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => {
      if (code !== 0) finish(new Error(`close transcript worker exited ${code}`));
      else if (!settled) finish(new Error('close transcript worker exited without a result'));
    });
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

// Only the contended-keys refusal, never the 429 the restart gate raises: one is
// worth starting an agent a different way, the other means no agent may start.
function injectionKeysBusy(error) {
  return error instanceof InjectionError && error.status === 429
    && error.message === injectionBusyError().message;
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

// A session parked on the rate limit has a tail of nothing but synthetic records, so the
// tail alone reports '<unknown>' for a model that is still perfectly knowable further
// back. Walk the transcript backwards for the newest genuine assistant record — bounded,
// because a long-lived session's transcript runs to hundreds of megabytes.
// Generous, because stopping short of byte zero now costs the handoff a refusal: a
// `/model` older than the bound could have set a context window nothing else records.
// The whole scan runs once per handoff inspect.
const HANDOFF_MODEL_SCAN_BYTES = 32 * 1024 * 1024;
const HANDOFF_MODEL_SCAN_CHUNKS = 128;
const HANDOFF_MODEL_LOOKAHEAD_CHARS = 64 * 1024;
// One transcript record the scan is willing to hold while looking for the newline that
// ends it. Past this it fails closed rather than buffering a tool result of any size.
const HANDOFF_MODEL_CARRY_BYTES = 2 * 1024 * 1024;

// lastClaudeHandoffModel's per-record rule, one record at a time: the model of a genuine
// assistant turn, '<unknown>' for a genuine turn whose model is malformed (which must
// keep failing closed), or null for anything that is not one — synthetic rate-limit
// records above all, which is what a parked session's transcript is made of.
function genuineAssistantModel(record) {
  if (!record || record.type !== 'assistant' || record.isSidechain || !record.message) return null;
  const candidate = typeof record.message.model === 'string' ? record.message.model : '<unknown>';
  if (record.isApiErrorMessage || candidate === '<synthetic>') return null;
  if (!record.message.usage) return null;
  return candidate || '<unknown>';
}

// Claude Code logs a typed local command either as a user record or, since 2.x, as a
// `system`/`local_command` record with the wrapper in a top-level string.
function localCommandText(record) {
  if (!record) return '';
  if (record.type === 'system' && record.subtype === 'local_command' && typeof record.content === 'string') {
    return record.content.trimStart();
  }
  if (record.type === 'user' && !record.isSidechain && record.message) return textOf(record.message.content).trimStart();
  return '';
}

function localModelSwitchArgs(record) {
  const text = localCommandText(record);
  if (!/^<command-name>\/model<\/command-name>/.test(text)) return null;
  return (text.match(/<command-args>([^<>]*)<\/command-args>/)?.[1] || '').trim();
}

function localCommandStdout(record) {
  const text = localCommandText(record);
  const open = '<local-command-stdout>';
  return text.startsWith(open) ? text.slice(open.length).trimStart() : null;
}

function localCommandStderr(record) {
  const text = localCommandText(record);
  const open = '<local-command-stderr>';
  return text.startsWith(open) ? text.slice(open.length).trimStart() : null;
}

// A `/model` the API refused: the harness answers it with an API error (`API error: 429
// rate_limit_error …`) instead of "Set model to …", and the session stays on the model it
// was on. That is no model change at all, so the scan steps over it to whatever set the
// model before. Read as ambiguous instead, a restore the daemon kept re-typing at a spent
// model made every handoff of the session refuse "cannot be reproduced safely".
const MODEL_SWITCH_API_ERROR_RE = /^(?:API\s+error\b|[^\n]*\brate_limit_error\b)/i;

function modelSwitchApiError(output) {
  const text = String(output == null ? '' : output).split(/\r?\n/)[0].split('</')[0].trim();
  return MODEL_SWITCH_API_ERROR_RE.test(text);
}

// The label out of a `/model` confirmation row: `Set model to `Fable 5.1` and saved as
// your default for new sessions` is the label `Fable 5.1`. null when the row is not a
// "Set model to …" confirmation at all — "Kept model as …" means the switch never
// happened, and nothing else is a confirmation either. The label may be '' when the
// harness printed none.
// The label is the harness speaking after the switch already took effect, and it names
// the context window outright (`Opus 5 (1M context)`), which is the one thing no assistant
// record ever carries. It is not evidence of the base model on its own — a display name
// is not an id — so a label only ever narrows a base that a record or the launch
// metadata has already proven.
// The trailers matter as much as the label: the harness also prints why it could not save
// the choice — `Set model to `Opus 5` for this session only · couldn't save it as your
// default: /tmp/1m/settings.json can't be written (EACCES)` — and a path in that sentence
// must never be read as part of the model name, least of all as its context window.
function modelSwitchLabel(stdout) {
  // First line only, and never the wrapper: localCommandStdout leaves the closing tag on.
  const text = String(stdout == null ? '' : stdout).split(/\r?\n/)[0].split('</')[0].trim();
  const set = /^Set model to\b([\s\S]*)$/i.exec(text);
  if (!set) return null;
  const rest = set[1].trim();
  // The harness wraps the label in backticks, which delimit it exactly: whatever follows
  // the closing one is a sentence about the switch, not part of the model.
  const quoted = /`([^`]*)`/.exec(rest);
  if (quoted) return quoted[1].trim();
  // Unquoted, the label runs to the first trailer the harness is known to append.
  return rest.replace(/\s+(?:and saved\b|for this session\b|·).*$/i, '').trim();
}

// Whether the confirmation says the harness also wrote the choice into settings.json:
// `Set model to `Fable 5.1` and saved as your default for new sessions`. Only then is the
// account's settings model a record of this very switch rather than of some earlier one.
function modelSwitchSavedDefault(stdout) {
  const text = String(stdout == null ? '' : stdout).split(/\r?\n/)[0].split('</')[0];
  return /\band saved as your default\b/i.test(text) && !/couldn't save/i.test(text);
}

// `Fable 5.1 (1M context)` → family `fable`, version `5-1`. Both are needed: a label with
// no family, or none of the version digits that tell `claude-opus-5` from
// `claude-opus-5-1`, names no model this could match.
const MODEL_LABEL_RE = /\b(fable|mythos|opus|sonnet|haiku)\s+(\d+(?:\.\d+)*)\b/i;

// The model id a label names, given a reference id that already proves the base — the
// assistant record right after the switch, or the launch metadata. '' when the two cannot
// be matched, which is the fail-closed answer everywhere this is used. The version is
// matched whole and anchored, so `Opus 5` matches `claude-opus-5` and the date-suffixed
// `claude-haiku-4-5-20251001` spelling, and never `claude-opus-5-1` or `claude-opus-4-5`.
// On a match the reference spells the model and the label decides the window: the picker
// labels the wide variant `(1M context)`, and that is the window to relaunch with.
function modelIdForSwitchLabel(label, reference) {
  const named = MODEL_LABEL_RE.exec(String(label || ''));
  const base = String(reference || '').trim().replace(/\[1m\]$/i, '');
  if (!named || !base) return '';
  const suffix = new RegExp(`-${named[1].toLowerCase()}-${named[2].replace(/\./g, '-')}(?:-\\d{8})?$`);
  if (!suffix.test(compactModelBase(base))) return '';
  return /\b1m\b/i.test(label) ? `${base}[1m]` : base;
}

// A `/model` typed after the newest genuine assistant record is the session's model, and
// no assistant record reflects it yet. The model only counts when it names a full id the
// resume could pass to `claude --model` and the harness confirmed the switch: a bare alias
// (`opus`) resolves against settings we cannot see, no argument opens the picker, and
// "Kept model as …" means the switch never happened.
// The label of a confirmed switch comes back either way: when the args named no id, the
// label is all that is left of which model the harness moved to, and the caller matches it
// against whatever proves the base at its level.
function resolveLocalModelSwitch(args, following) {
  const typed = /-/.test(args) && !/\s/.test(args) ? launchModelId(args) : '';
  for (const line of following) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    // Refused by the API, on either output stream: not a switch. The synthetic rate-limit
    // record is not read that way — a parked session's tail is full of those whatever the
    // /model before them did.
    const stderr = localCommandStderr(record);
    if (stderr != null && modelSwitchApiError(stderr)) return { model: '<unknown>', label: '', failed: true };
    const stdout = localCommandStdout(record);
    if (stdout == null) continue;
    if (modelSwitchApiError(stdout)) return { model: '<unknown>', label: '', failed: true };
    const label = modelSwitchLabel(stdout);
    if (label == null) return { model: '<unknown>', label: '' };
    const saved = modelSwitchSavedDefault(stdout);
    const savedAt = saved ? Date.parse(record.timestamp) : NaN;
    return { model: typed || '<unknown>', label, ...(saved && Number.isFinite(savedAt) ? { saved: true, savedAt } : {}) };
  }
  return { model: '<unknown>', label: '' };
}

// Everything in this slice that bears on the model, oldest first: genuine assistant turns
// and `/model` switches. A switch carries the rows that follow it, which is where its
// confirmation sits — including the rows of the slice we read before this one.
function modelEventsInText(text, newerText = '') {
  const lines = String(text || '').split(/\r?\n/);
  const newerLines = String(newerText || '').split(/\r?\n/);
  const events = [];
  for (let i = 0; i < lines.length; i += 1) {
    let record;
    try { record = JSON.parse(lines[i]); } catch { continue; }
    const model = genuineAssistantModel(record);
    if (model) { events.push({ kind: 'assistant', model }); continue; }
    const args = localModelSwitchArgs(record);
    if (args != null) {
      const following = () => lines.slice(i + 1).concat(newerLines);
      let resolved;
      events.push({ kind: 'switch', args, following,
        resolve: () => (resolved ||= resolveLocalModelSwitch(args, following())) });
    }
  }
  return events;
}

// A switch the API refused never happened; see modelSwitchApiError.
function refusedModelSwitch(event) {
  return event.kind === 'switch' && event.resolve().failed === true;
}

// The model over the whole file, newest slice first, as { model, source, window, label? }:
//  - source 'switch' is a model someone chose by hand, spelling and context window
//    included, so it is used exactly as it stands; 'assistant' is an API record, which
//    names the base model but not reliably the `[1m]` window.
//  - window 'exact' means the model string already carries the right window, 'launch'
//    that the launch metadata may supply it, and 'unknown' that it cannot be told —
//    a switch beyond the scan's bound could have set a window nothing else records.
//  - label is set only alongside the '<unknown>' sentinel, and only for a `/model` that
//    named no launchable id: it is the display name the harness echoed after the switch.
//    It is not a model — the picker's rows can be renamed in settings this scan does not
//    read — so the caller decides whether to believe it, and an unresolved label stays
//    '<unknown>'. labelReference comes with it when an assistant record newer than the
//    switch proves the base the label must match; without one the caller has only the
//    launch metadata, which this scan cannot see.
// The model is '' only after reading back to byte zero with no genuine record in the
// whole file; a scan cut short by the bound or by a read error reports the '<unknown>'
// sentinel, because unread bytes are not evidence of absence.
function lastClaudeHandoffModelInFile(file, deps = {}) {
  const chunkBytes = Number(deps.scanChunkBytes) || TAIL_BYTES;
  const maxBytes = Number(deps.scanMaxBytes) || HANDOFF_MODEL_SCAN_BYTES;
  const unreadable = { model: '<unknown>', source: '', window: 'unknown' };
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return unreadable; }
  let reachedStart = false;
  // The newest genuine assistant model, once one is found. The scan carries on past it:
  // a `/model` older than it still decided the window it is running with.
  let assistant = null;
  try {
    let end = fs.fstatSync(fd).size;
    reachedStart = end === 0;
    let scanned = 0;
    // The head of a record split across a chunk boundary, carried back to the slice that
    // holds the rest of it — as pieces, oldest first, joined only when the newline that
    // completes the record finally turns up. Bytes, not text: a split multi-byte
    // character must survive. Copying the accumulated carry into every chunk instead
    // would make one newline-free record (a huge tool result) quadratic.
    let carry = [];
    let carryBytes = 0;
    // The beginning of everything already scanned, so a `/model` row at the end of a
    // slice can still find the stdout row that confirms it.
    let newerText = '';
    for (let chunks = 0; chunks < HANDOFF_MODEL_SCAN_CHUNKS && end > 0 && scanned < maxBytes; chunks += 1) {
      const start = Math.max(0, end - chunkBytes);
      const slice = Buffer.alloc(end - start);
      // A short read means the file changed under us: the rest of the buffer is zeroes,
      // which would silently drop whatever evidence lived in those bytes.
      try {
        if (fs.readSync(fd, slice, 0, slice.length, start) !== slice.length) return unreadable;
      } catch { return unreadable; }
      scanned += slice.length;
      const newline = start > 0 ? slice.indexOf(0x0a) : -1;
      if (start > 0 && newline === -1) {
        // Still inside one record. Keep its pieces and read further back, up to a bound:
        // a record we cannot hold is a model we cannot prove.
        carryBytes += slice.length;
        if (carryBytes > HANDOFF_MODEL_CARRY_BYTES) return unreadable;
        carry.unshift(slice);
        end = start;
        if (end === 0) reachedStart = true;
        continue;
      }
      const text = Buffer.concat([slice.subarray(newline + 1), ...carry]).toString('utf8');
      carry = newline > 0 ? [slice.subarray(0, newline)] : [];
      carryBytes = newline > 0 ? newline : 0;
      const events = modelEventsInText(text, newerText);
      let seen = events.length - 1;
      if (assistant == null) while (seen >= 0 && refusedModelSwitch(events[seen])) seen -= 1;
      if (assistant == null && seen >= 0) {
        // The newest event in the file decides on its own when it is a switch: nothing
        // older can undo a model someone typed after it.
        if (events[seen].kind === 'switch') return switchResult(events[seen]);
        assistant = events[seen].model;
        seen -= 1;
      }
      // Older slices, and the rest of this one, are searched only for the switch that
      // last set the window the assistant record is running with.
      for (; seen >= 0; seen -= 1) {
        if (events[seen].kind === 'switch' && !refusedModelSwitch(events[seen])) return switchBehindAssistant(events[seen], assistant);
      }
      newerText = `${text}\n${newerText}`.slice(0, HANDOFF_MODEL_LOOKAHEAD_CHARS);
      end = start;
      if (end === 0) reachedStart = true;
    }
  } finally { fs.closeSync(fd); }
  // No switch anywhere in what was read. Reaching byte zero proves there is none, so the
  // launch metadata may fill in the window; stopping at the bound proves nothing.
  if (assistant != null) return { model: assistant, source: 'assistant', window: reachedStart ? 'launch' : 'unknown' };
  // Window 'launch' on the empty result is the same promise as above: the whole file was
  // read and it holds no switch, so whatever the session was launched with is still what
  // it is running. Stopping at the bound keeps the '<unknown>' sentinel instead.
  return reachedStart
    ? { model: '', source: '', window: 'launch' }
    : { model: '<unknown>', source: '', window: 'unknown' };
}

function switchResult(event) {
  const { model, label, saved, savedAt } = event.resolve ? event.resolve() : resolveLocalModelSwitch(event.args, event.following());
  if (model !== '<unknown>') return { model, source: 'switch', window: 'exact' };
  // Nothing newer than this switch, so no record names the base model it moved to. The
  // label travels out with the sentinel: only handoffCurrentModel holds the launch
  // metadata and account settings that could prove it.
  return { model, source: 'switch', window: 'unknown', label, ...(saved ? { saved: true, savedAt } : {}) };
}

// A `/model` older than the newest assistant record: the record confirms the base model,
// and the switch is still the only thing that named the context window.
function switchBehindAssistant(event, assistant) {
  const { model, label } = switchResult(event);
  if (model === '<unknown>') {
    // The picker, or a bare alias: no id was typed, but the harness echoed the model it
    // moved to and the record right after it proves that base. The scan reports both and
    // resolves neither — whether a display label can be believed at all depends on
    // settings only handoffCurrentModel can read.
    return { model, source: 'switch', window: 'unknown', label, labelReference: assistant };
  }
  if (compactModelBase(model) === compactModelBase(assistant)) return { model, source: 'switch', window: 'exact' };
  // The model changed after the switch by some other path, so the record is the evidence
  // and its window comes from the launch metadata as usual.
  return { model: assistant, source: 'assistant', window: 'launch' };
}

// A launch model is taken verbatim: `claude --model claude-fable-5-1[1m]` is a model this
// repo launches on purpose, so the 1M-context suffix is part of the id, not noise.
function launchModelId(value) {
  const model = String(value || '').trim();
  return model && keep.LAUNCH_MODEL_RE.test(model) ? model : '';
}

const HANDOFF_ARGV_MODEL_RE = /(?:^|\s)--model(?:=|\s+)["']?([A-Za-z0-9][A-Za-z0-9._:[\]/-]*)["']?(?=\s|$)/;

// The `model` in one account's settings.json, or '' if that file cannot be read as a JSON
// object. Never the daemon's own ~/.claude/settings.json (readClaudeSettingsModel): the
// account that launched a session is usually not the account this process runs under.
function readAccountSettingsModel(file) {
  try {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return '';
    return typeof settings.model === 'string' ? settings.model : '';
  } catch { return ''; }
}

// One settings file as a JSON object, or null when there is no such file. Anything else —
// unreadable, not JSON, not an object — throws, because the callers below have to tell
// "this file says nothing" from "we could not find out what this file says".
function readSettingsFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const settings = JSON.parse(text);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`settings file is not a JSON object: ${file}`);
  }
  return settings;
}

// The settings an administrator installs for every session on the machine; Claude Code
// reads them ahead of the account's own. Paths are the harness's, by platform.
const MANAGED_SETTINGS_FILES = process.platform === 'darwin'
  ? ['/Library/Application Support/ClaudeCode/managed-settings.json']
  : ['/etc/claude-code/managed-settings.json'];
const MANAGED_SETTINGS_DIRS = process.platform === 'darwin'
  ? ['/Library/Application Support/ClaudeCode/managed-settings.d']
  : ['/etc/claude-code/managed-settings.d'];

function managedSettingsFiles() {
  const files = [...MANAGED_SETTINGS_FILES];
  for (const dir of MANAGED_SETTINGS_DIRS) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (err) {
      // A directory that is not there holds no settings; one we cannot list might.
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) continue;
      throw err;
    }
    for (const entry of entries.sort()) if (entry.endsWith('.json')) files.push(path.join(dir, entry));
  }
  return files;
}

// Whether the `/model` picker this session used could have shown rows someone renamed.
// `modelPicker.options[]` in settings replaces or extends the built-in rows with
// `{ model, label }` pairs of their own, and the confirmation prints the row's label
// verbatim — so `{ model: 'claude-opus-5[1m]', label: 'Opus 5' }` makes a label that reads
// like a built-in name stand for a different model entirely. A renamed row cannot be told
// from a built-in one by looking at the string, so the only safe rule is to stop believing
// labels at all once custom rows are possible anywhere the harness would have read them:
// a `--settings` file passed on the command line (its contents are the caller's, not
// ours), the launching account's own settings.json, or the machine's managed settings.
// Project settings are deliberately not consulted: the harness ignores modelPicker there.
// Unreadable is the same as "may exist" — this decides whether a handoff is allowed to
// reproduce a model, and a guess is the one answer that must never come out of it.
function customModelPickerPossible(session, processArgs, deps = {}) {
  if (/(?:^|\s)--settings(?:=|\s|$)/.test(String(processArgs || ''))) return true;
  const read = deps.readSettingsFile || readSettingsFile;
  const files = [];
  try {
    const account = (deps.forSession || accounts.forSession)(session.id, 'claude', {
      root: deps.root || keep.ROOT, env: deps.env || process.env,
    });
    // No account resolves to no account settings file, exactly as sourceAccountSettingsModel
    // reads it: there is no second place to look for the one this session launched from.
    if (account && typeof account.configDir === 'string' && account.configDir) {
      files.push(path.join(account.configDir, 'settings.json'));
    }
  } catch { return true; }
  try {
    const managed = typeof deps.managedSettingsFiles === 'function'
      ? deps.managedSettingsFiles()
      : deps.managedSettingsFiles;
    files.push(...(managed || managedSettingsFiles()));
  } catch { return true; }
  for (const file of files) {
    let settings;
    try { settings = read(file); } catch { return true; }
    if (settings && settings.modelPicker != null) return true;
  }
  // macOS managed preferences (an MDM profile) are a policy source too, and a plist is not
  // parsed here: one that exists is taken as possibly carrying picker rows. Policy the
  // harness fetches from the organization's server is not on disk to check at all, and
  // neither is the settings file as it stood when the switch was made; those are the
  // residual the label rule accepts. Behind an assistant record it is bounded to the
  // context window, since the record proves the base; against launch metadata alone,
  // which proves only the model before the pick, a renamed row could hide a different
  // base too. docs/accounts.md states both.
  try {
    const preferences = typeof deps.managedPreferenceFiles === 'function'
      ? deps.managedPreferenceFiles()
      : deps.managedPreferenceFiles;
    const exists = deps.fileExists || fs.existsSync;
    for (const file of preferences || managedPreferenceFiles()) if (exists(file)) return true;
  } catch { return true; }
  return false;
}

function managedPreferenceFiles() {
  if (process.platform !== 'darwin') return [];
  const plist = 'com.anthropic.claudecode.plist';
  let user = '';
  try { user = os.userInfo().username; } catch { user = ''; }
  return [
    path.join('/Library/Managed Preferences', plist),
    ...(user ? [path.join('/Library/Managed Preferences', user, plist)] : []),
  ];
}

// The model a session launched with no `--model` inherited: `claude` reads it out of the
// launching account's settings.json at startup. That file is trustworthy here and only
// here — the caller has already proved, by reading the transcript back to byte zero
// without finding a `/model`, that nothing in the session ever moved off it. The target
// account's settings.json is a different file with its own value, which is precisely the
// silent model change this whole function exists to prevent, so the source account is
// resolved the way bin/account-handoff.js resolves it and no other account is consulted.
// Anything unresolvable — no account, no readable file, a value `claude --model` would
// not take — is '' and leaves the handoff refusing.
// The settings a confirmed "saved as your default" switch wrote, but only while nothing has
// written that file since: every session on the account shares it, and a compaction swap
// types its own /model into it and then restores an older value. Its mtime has to sit
// within a few seconds of the confirmation row, so any later write fails closed.
const SAVED_SWITCH_SETTINGS_SLACK_MS = 5000;
function savedSwitchSettingsModel(session, savedAt, deps = {}) {
  try {
    const account = (deps.forSession || accounts.forSession)(session.id, 'claude', {
      root: deps.root || keep.ROOT, env: deps.env || process.env,
    });
    if (!account || typeof account.configDir !== 'string' || !account.configDir) return '';
    const file = path.join(account.configDir, 'settings.json');
    const mtime = (deps.settingsMtimeMs || ((p) => fs.statSync(p).mtimeMs))(file);
    if (!Number.isFinite(savedAt) || !Number.isFinite(mtime)
        || Math.abs(mtime - savedAt) > SAVED_SWITCH_SETTINGS_SLACK_MS) return '';
    const read = deps.readAccountSettings || readAccountSettingsModel;
    return launchModelId(read(file));
  } catch { return ''; }
}

function sourceAccountSettingsModel(session, deps = {}) {
  try {
    const account = (deps.forSession || accounts.forSession)(session.id, 'claude', {
      root: deps.root || keep.ROOT, env: deps.env || process.env,
    });
    if (!account || typeof account.configDir !== 'string' || !account.configDir) return '';
    const read = deps.readAccountSettings || readAccountSettingsModel;
    return launchModelId(read(path.join(account.configDir, 'settings.json')));
  } catch { return ''; }
}

// The model the account handoff has to relaunch with. Every answer is either a model id
// or '<unknown>': the handoff refuses on the sentinel, and resuming with no `--model` at
// all would silently hand the session to the target account's default, so "we could not
// tell" must never look like "no model was configured". A transcript we could not finish
// reading, a genuine record whose model is malformed, and a transcript that names nothing
// with neither launch metadata nor readable source-account settings behind it all fail
// closed.
function handoffCurrentModel(session, pane, processArgs, deps = {}) {
  let found;
  try {
    const file = (deps.findSessionFile || findSessionFile)(session.id);
    found = file
      ? (deps.lastClaudeHandoffModelInFile || lastClaudeHandoffModelInFile)(file, deps)
      : { model: '', source: '' };
  } catch {
    // An unreadable or ambiguous transcript is not permission to guess from launch
    // metadata: the session may have switched model in-session since launch.
    return '<unknown>';
  }
  // Launch metadata, most specific first. It is the only place an assistant record's
  // model cannot name the context window: `claude --model claude-fable-5-1[1m]` and the
  // record's own `claude-fable-5-1` are the same model with different windows.
  const launch = launchModelId(pane?.meta?.model)
    || launchModelId(HANDOFF_ARGV_MODEL_RE.exec(String(processArgs || ''))?.[1]);
  const { model, source, window, label, labelReference, saved, savedAt } = found;
  // A `/model` that named no launchable id — the picker, or a bare alias — left the model
  // it moved to only in the label the harness echoed. Something else has to prove the base
  // that label narrows: the assistant record right after the switch when there is one, and
  // otherwise the launch metadata, which is all that is left when nothing in the file is
  // newer than the switch. The label then decides the window, because `(1M context)` is
  // named there and nowhere else. A label that names some other model proves nothing and
  // keeps failing closed — and neither does any label once the picker's rows could have
  // been renamed in settings, which is checked here and only when there is a label worth
  // resolving, so the ordinary path still reads no settings at all.
  if (model === '<unknown>' && label) {
    const reference = labelReference || launch;
    if ((reference || saved) && !customModelPickerPossible(session, processArgs, deps)) {
      // No turn since the switch: a switch the harness confirmed it saved as the default
      // wrote the full id, window included, into the account's settings.json, and it is
      // newer evidence than the launch. The picker's Fable 5.1 row is the 1M model with no
      // "(1M context)" in its label, so only this id carries its window. It is taken
      // verbatim when the file is untouched since, the label names its base, and the label
      // does not ask for a 1M window the id lacks; anything else falls through.
      if (!labelReference && saved) {
        const configured = savedSwitchSettingsModel(session, savedAt, deps);
        if (configured && modelIdForSwitchLabel(label, configured)
            && !(/\b1m\b/i.test(label) && !/\[1m\]$/i.test(configured))) return configured;
      }
      const labelled = reference ? modelIdForSwitchLabel(label, reference) : '';
      if (labelled) return labelled;
    }
  }
  if (model === '<unknown>') return model;
  // Nothing in the whole transcript names a model. Launch metadata first, and then — only
  // when the scan actually reached byte zero, so there is no switch it could have missed —
  // the settings the launch itself would have read. A session opened by `keep runs` passes
  // no `--model` and records none, and that is not the same as having no model.
  if (!model) return launch || (window === 'launch' ? sourceAccountSettingsModel(session, deps) : '') || '<unknown>';
  // A confirmed `/model` is someone naming the model and its window by hand. It is taken
  // exactly as typed, whichever side of the newest assistant record it fell on.
  if (source === 'switch') return model;
  // The scan stopped short of byte zero, so a `/model` older than the bound may have set
  // a window the launch metadata no longer describes. Launch metadata cannot rule that
  // out — only reading the rest of the file could, and it was too long to read.
  if (window === 'unknown') return '<unknown>';
  // A different base model means the transcript is the newer evidence.
  if (!launch || compactModelBase(launch) !== compactModelBase(model)) return model;
  // Same model, so the launch spelling carries the window. Never downgrade: whichever
  // side asked for the 1M context is the one that has to be relaunched.
  return /\[1m\]$/i.test(model) && !/\[1m\]$/i.test(launch) ? model : launch;
}

function lastContextTokens(lines, kind) {
  return lastTurnUsage(lines, kind).contextTokens;
}

function screenTail(screen) {
  return String(screen || '').split(/\r?\n/).slice(-30).join('\n').slice(-600);
}

// A pane a request may name: a host's own id, or that id qualified by the node it
// lives on. The host's alphabet has no '@', so the two shapes cannot be confused.
const PANE_REF_RE = /^[A-Za-z0-9_-]{1,64}(?:@[a-z0-9]+)?$/;

function validPaneRef(value) {
  return PANE_REF_RE.test(String(value == null ? '' : value));
}

function isHostTarget(target) {
  return Boolean(target && typeof target.pane === 'string' && target.pane);
}

// The slow verb set: they take the node's second connection, so a long call on one
// node can never sit in front of a keystroke bound for another. `transcript` goes
// further and has a connection of its own (HOST_CHANNEL_BY_TYPE): a receipt's long
// poll waits up to nine seconds, and a launch's prepare must not queue behind it.
const HOST_OPS_TYPES = new Set(['run', 'transcript', 'prepare-launch', 'usage', 'git-state', 'artifacts']);
// `artifacts` carries a moving session's files in 4 MiB frames: a connection of its
// own, so a move never sits in front of a receipt, a launch or a keystroke.
const HOST_CHANNEL_BY_TYPE = new Map([['transcript', 'transcript'], ['artifacts', 'artifacts']]);

function daemonNodeName(deps = {}) {
  return deps.daemonNode || nodes.daemonNode();
}

// The daemon node as openSession names it for a launch (from the launch's env), with
// a caller's deps.daemonNode still first. A Pi open's node checks and its phase reads
// (piEventFor, waitForPiStart) all compare the launch node with this one, so the two
// can never disagree about whether a phase file is local.
function launchDaemonNode(deps = {}) {
  return deps.daemonNode || nodes.daemonNode(deps.env || process.env);
}

// Parsing a ref has to use the same daemon node the answer is compared against, or
// a test that names one in `deps` would read its own panes as another machine's.
// Node identity is all the node helpers read out of an environment, so this carries
// that and nothing else.
function paneRefEnv(deps = {}) {
  return { KEEP_DAEMON_NODE: daemonNodeName(deps) };
}

// Which machine a session or a pane is on. The live pane answers first: a fleet
// listing stamps `node` on every pane and qualifies its id, so a ref or a stamped
// row is self-describing. A session whose pane is gone falls back to the durable
// authority its launch wrote. Neither says anything on a single-node install, where
// the answer is this machine — the only answer that install has ever had.
function sessionNodeOf(sessionOrPane, deps = {}) {
  const daemon = daemonNodeName(deps);
  if (sessionOrPane == null || typeof sessionOrPane === 'string') {
    return nodes.parsePaneRef(String(sessionOrPane == null ? '' : sessionOrPane), { env: paneRefEnv(deps) }).node;
  }
  if (typeof sessionOrPane !== 'object') return daemon;
  if (sessionOrPane.node) return String(sessionOrPane.node);
  const pane = sessionOrPane.pane;
  if (typeof pane === 'string' && pane) {
    const node = nodes.parsePaneRef(pane, { env: paneRefEnv(deps) }).node;
    if (node !== daemon) return node;
  }
  const sessionId = sessionOrPane.sessionId || sessionOrPane.id;
  // Authority is a file read per session, so it is asked only when there is more
  // than one node to name: a single-node install can have recorded nothing else.
  if (typeof sessionId === 'string' && sessionId && hostNodeNames(deps).length > 1) {
    try {
      const node = accounts.sessionNode(sessionId, { root: deps.root || keep.ROOT, env: deps.env || process.env });
      if (node) return node;
    } catch {}
  }
  return daemon;
}

function remoteSession(sessionOrPane, deps = {}) {
  return sessionNodeOf(sessionOrPane, deps) !== daemonNodeName(deps);
}

function hostChannel(node, channel = 'control') {
  const key = `${node}\u0000${channel}`;
  let state = hostChannels.get(key);
  if (!state) {
    state = { node, channel, client: null, pending: null, failureAt: 0, failureError: null };
    hostChannels.set(key, state);
  }
  return state;
}

async function hostClientFor(node, deps = {}, channel = 'control') {
  const daemon = daemonNodeName(deps);
  if (Object.prototype.hasOwnProperty.call(deps, 'host') && node === daemon) return deps.host || null;
  const runningTests = process.env.NODE_TEST_CONTEXT
    || process.argv.some((arg) => /(?:^|\/)bin\/[^/]+\.test\.js$/.test(arg));
  if (runningTests && typeof deps.connectHost !== 'function') return null;
  const state = hostChannel(node, channel);
  if (state.client && (!state.client.socket || !state.client.socket.destroyed)) return state.client;
  state.client = null;
  const now = deps.now || Date.now;
  if (!deps.forceHostReconnect && state.failureAt && now() - state.failureAt < HOST_FAILURE_CACHE_MS) return null;
  if (!state.pending) {
    const connect = deps.connectHost
      || (deps.requireHostClient || require)('./hostclient.js').connect;
    const timeoutMs = deps.hostConnectTimeoutMs == null ? HOST_CONNECT_TIMEOUT_MS : deps.hostConnectTimeoutMs;
    // The daemon node is reached exactly as it always was: no node name, no
    // registry lookup, the same socket a single-node install has always used.
    const target = node === daemon ? { timeoutMs } : { node, timeoutMs };
    state.pending = connect(target).then((client) => {
      state.client = client;
      state.failureAt = 0;
      state.failureError = null;
      if (client && typeof client.onDisconnect === 'function') {
        client.onDisconnect(() => {
          if (state.client === client) {
            // A closed socket is not a failed connect: `keep host reload` closes it
            // on purpose, and the next request must reconnect at once rather than
            // sit out the negative cache.
            state.client = null;
            state.failureAt = 0;
            state.failureError = null;
          }
          hostPaneCaches.delete(client);
        });
      }
      return client;
    }).catch((error) => {
      state.failureAt = now();
      state.failureError = error;
      return null;
    }).finally(() => { state.pending = null; });
  }
  return state.pending;
}

async function hostClient(deps = {}) {
  return hostClientFor(deps.node || daemonNodeName(deps), deps, deps.hostChannel || 'control');
}

// Hang up on the terminal host and forget the cache. The daemon never wants
// this — it holds one connection for its whole life — but a one-shot command
// that asked the host a single question does: the socket is a live handle, so
// the process would sit in the event loop long after its report is printed.
// Awaiting a connection still in flight first means a client that arrives late
// is closed too rather than being left behind as the cached one. The next
// hostClient() call simply reconnects.
async function closeHostClient() {
  let closed = false;
  for (const state of [...hostChannels.values()]) {
    if (state.pending) await state.pending.catch(() => null);
    const client = state.client;
    state.client = null;
    state.failureAt = 0;
    state.failureError = null;
    if (!client) continue;
    hostPaneCaches.delete(client);
    try { client.close(); } catch {}
    closed = true;
  }
  return closed;
}

// Puts the node back on a reply from it: `pane`, a list's `panes`, and the pane
// field of any event the daemon consumes. The host's own id is kept in hostPaneId
// so a later request can be unqualified again on the way out.
function qualifyPane(pane, node, daemon) {
  if (!pane || typeof pane !== 'object' || Array.isArray(pane) || typeof pane.id !== 'string') return pane;
  return {
    ...pane, node, id: nodes.formatPaneRef(node, pane.id, { KEEP_DAEMON_NODE: daemon }), hostPaneId: pane.id,
  };
}

function qualifyReply(result, node, daemon) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const out = { ...result };
  if (out.pane !== undefined) {
    out.pane = typeof out.pane === 'string'
      ? nodes.formatPaneRef(node, out.pane, { KEEP_DAEMON_NODE: daemon })
      : qualifyPane(out.pane, node, daemon);
  }
  if (Array.isArray(out.panes)) out.panes = out.panes.map((pane) => qualifyPane(pane, node, daemon));
  return out;
}

function retryableHostError(error) {
  const code = error && error.code;
  return ['ECONNREFUSED', 'ECONNRESET', 'ENOENT', 'EPIPE'].includes(code)
    || /host (?:connection closed|is unavailable)|socket hang up/i.test(String(error && error.message || error));
}

function hostRequestTimedOut(error) {
  return /(?:host|terminal host) request timed out|host connect timed out|reload retry timed out/i
    .test(String(error && error.message || error));
}

function invalidateHost(client, deps = {}, error = null) {
  if (client) {
    for (const state of hostChannels.values()) {
      if (state.client !== client) continue;
      try { client.close(); } catch {}
      state.client = null;
      state.failureAt = (deps.now || Date.now)();
      state.failureError = error || new Error('host connection closed');
    }
  }
  if (client && typeof client === 'object') hostPaneCaches.delete(client);
}

async function requestHostClient(client, type, params, deps = {}) {
  const timeoutMs = deps.hostRequestTimeoutMs == null ? HOST_REQUEST_TIMEOUT_MS : deps.hostRequestTimeoutMs;
  let timer;
  let pending = true;
  try {
    return await Promise.race([
      Promise.resolve().then(() => client.request(type, params || {}, { timeoutMs })),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          // Timers run before socket I/O callbacks. If the daemon was stalled past
          // the deadline, give poll one turn to drain a reply the host already sent.
          timer = setImmediate(() => {
            if (!pending) return;
            reject(new Error(pressure.annotate(`host request timed out (${type})`)));
          });
        }, timeoutMs);
      }),
    ]);
  } finally {
    pending = false;
    if (timer) { clearTimeout(timer); clearImmediate(timer); }
  }
}

// Which host process this connection reaches, and whether it journals spawns.
// Asked once per connection and remembered against the connection itself, never
// against the node: a node name outlives a host process, and the whole point of
// this is to tell one host process from the next one.
//
// It has a short budget of its own, because it is a convenience and the spawn is
// not: the spawn's own deadline must not be spent finding out whether it could be
// retried. A hello that fails or takes too long simply means "no journal on this
// connection" — the spawn goes out with its whole window and may not be retried —
// and that answer is never cached, so the next spawn on the same connection asks
// again rather than inheriting one slow moment as a permanent verdict.
//
// Concurrent first spawns share one hello: the in-flight promise is remembered, so
// ten opens starting at once cost one round trip, not ten.
async function hostGeneration(client, deps = {}) {
  if (hostGenerations.has(client)) return hostGenerations.get(client);
  if (hostGenerationRequests.has(client)) return hostGenerationRequests.get(client);
  if (client.descriptor && typeof client.descriptor.bootId === 'string' && client.descriptor.bootId) {
    const known = { bootId: client.descriptor.bootId, spawnReceipts: client.descriptor.spawnReceipts === true };
    hostGenerations.set(client, known);
    return known;
  }
  const timeoutMs = deps.hostGenerationTimeoutMs == null
    ? HOST_GENERATION_TIMEOUT_MS : deps.hostGenerationTimeoutMs;
  const pending = requestHostClient(client, 'hello', {}, { ...deps, hostRequestTimeoutMs: timeoutMs })
    .then((hello) => {
      if (!hello || typeof hello.bootId !== 'string' || !hello.bootId) return null;
      const generation = { bootId: hello.bootId, spawnReceipts: hello.spawnReceipts === true };
      // Only a real answer is remembered. A refusal is this connection saying it has
      // no journal, which is true now and need not be true in a second's time.
      hostGenerations.set(client, generation);
      return generation;
    }, () => null)
    .finally(() => { hostGenerationRequests.delete(client); });
  hostGenerationRequests.set(client, pending);
  return pending;
}

// Whether a spawn sent to `sent` may be replayed to `now`. Only the same host
// process can answer for what it ran: a host that restarted has no journal, so a
// "retry" against it would be a second spawn wearing the first one's name. The
// receipt capability must hold on both sides, because the reply the daemon lost
// may have come from a host that did not journal it.
function sameSpawnGeneration(sent, now) {
  return Boolean(sent && now && sent.bootId === now.bootId && sent.spawnReceipts && now.spawnReceipts);
}

async function hostRequest(type, params, deps = {}) {
  const wallNow = deps.wallNow || Date.now;
  const retryMs = deps.hostReloadRetryMs == null ? HOST_RELOAD_RETRY_MS : deps.hostReloadRetryMs;
  const requestTimeoutMs = deps.hostRequestTimeoutMs == null ? HOST_REQUEST_TIMEOUT_MS : deps.hostRequestTimeoutMs;
  const connectBudgetMs = deps.hostConnectTimeoutMs == null ? HOST_CONNECT_TIMEOUT_MS : deps.hostConnectTimeoutMs;
  // A reconnect has its own budget; it must not consume the request's intended
  // response window. The shorter reload window only bounds reconnect/reload churn.
  let deadline = wallNow() + connectBudgetMs + requestTimeoutMs;
  // Every request that only reads the host. `process` and `usage` are reads like the
  // rest: they ask a node about its own process table and an account's usage and change
  // nothing. Counting them as mutations made the annotation a listing does for a live
  // agent pane — a `process` call every 2.5s — clear the memo that outage listing is
  // built from, so a slow node holding an agent pane dropped off the list entirely
  // instead of staying on it marked stale.
  const idempotent = ['hello', 'list', 'get', 'screen', 'meta', 'process', 'usage', 'transcript'].includes(type)
    // An artifacts read or list changes nothing, a stage is continuity-checked on the
    // node (the same piece again is a no-op), and an abort only removes a stage. A
    // publish, a release and a queue drop are asked once: their caller looks before
    // it asks again.
    || (type === 'artifacts' && ['list', 'read', 'stage', 'abort', 'cwd'].includes(params && params.op));
  // A spawn naming an operation id is the one non-idempotent request that may be
  // asked again: the host journals it, so a second ask returns the pane the first
  // one made rather than starting a second process. Everything else keeps the
  // never-retry rule, and a spawn without an id keeps it too.
  const journalledSpawn = type === 'spawn' && typeof params?.operationId === 'string' && params.operationId;
  // The host process the spawn was actually sent to, captured before it was sent.
  // Permission to ask again is never cached: it is decided fresh on each attempt,
  // against whichever host answers then, and dies with the connection that earned it.
  let sentGeneration = null;
  let replaying = false;
  let retryReason = null;
  let retryCause = null;
  // A qualified pane names the node it lives on, so every existing call site that
  // passes target.pane routes to the right host without knowing nodes exist. A bare
  // pane is the daemon node's, and its params object is passed through untouched.
  // `paneId` is the same thing under another name — replace-exited's — and routes
  // identically, because a replacement must reach the host holding the original.
  const daemon = daemonNodeName(deps);
  const refs = ['pane', 'paneId']
    .filter((key) => params && typeof params[key] === 'string' && params[key])
    .map((key) => [key, nodes.parsePaneRef(params[key])]);
  const qualifiedRef = refs.find(([, value]) => value.qualified);
  const node = qualifiedRef ? qualifiedRef[1].node : (deps.node || daemon);
  // `p@main` is the daemon node's own pane under a name the host has never heard:
  // normalise every ref that differs from its pane id, not only the ones that
  // resolved to another node.
  const request = refs.some(([key, value]) => params[key] !== value.paneId)
    ? { ...params, ...Object.fromEntries(refs.map(([key, value]) => [key, value.paneId])) }
    : params;
  const channel = HOST_CHANNEL_BY_TYPE.get(type) || (HOST_OPS_TYPES.has(type) ? 'ops' : 'control');
  const state = hostChannel(node, channel);
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const notRetried = (reason, error) => {
    const detail = String(error && error.message || error).trim();
    const failure = new Error(`terminal host ${reason} during non-idempotent ${type}; request was not retried${detail ? `: ${detail}` : ''}`);
    failure.code = 'host_request_not_retried';
    failure.cause = error;
    return failure;
  };
  let forceHostReconnect = false;
  let retryDeadline = Infinity;
  let timeoutRetries = 0;
  for (;;) {
    const remaining = deadline - wallNow();
    if (remaining <= 0 || wallNow() >= retryDeadline) {
      throw new Error(pressure.annotate(`terminal host reload retry timed out (${type})`));
    }
    const connectTimeoutMs = Math.max(1, Math.min(
      connectBudgetMs,
      remaining,
    ));
    let connectTimer;
    const client = await Promise.race([
      hostClientFor(node, { ...deps, forceHostReconnect, hostConnectTimeoutMs: connectTimeoutMs }, channel),
      new Promise((resolve) => { connectTimer = setTimeout(() => resolve(null), remaining); }),
    ]);
    if (connectTimer) clearTimeout(connectTimer);
    if (!client) {
      const detail = String(state.failureError && state.failureError.message || '').trim();
      const error = new Error(pressure.annotate(`terminal host is unavailable${detail ? `: ${detail}` : ''}`),
        state.failureError ? { cause: state.failureError } : undefined);
      // Nothing to compare a generation against, so a spawn cannot earn a replay
      // here either: no host answered, and no host may be assumed to be the one
      // that ran it.
      if (!idempotent) throw notRetried(retryReason || 'was unavailable', retryCause || error);
      retryDeadline = Math.min(retryDeadline, wallNow() + retryMs);
      if (wallNow() >= deadline || wallNow() >= retryDeadline) throw error;
      forceHostReconnect = true;
      await sleep(Math.min(50, Math.max(0, Math.min(deadline, retryDeadline) - wallNow())));
      continue;
    }
    // Outside the try on purpose: a refusal raised in there is caught by the same
    // catch, which would read the detail it had just appended as a retryable error
    // and send the request round again.
    if (journalledSpawn) {
      const askedAt = wallNow();
      const generation = await hostGeneration(client, deps);
      // The hello has a budget of its own, so the spawn keeps the whole window it
      // came in with: finding out whether a request could be retried must never be
      // what stops it having time to run.
      deadline += wallNow() - askedAt;
      if (retryReason) {
        // A retry, and the only question that matters: is this the same host process
        // that ran the first attempt? If it is not, nothing here knows what happened,
        // and asking again would start a second agent.
        if (!sameSpawnGeneration(sentGeneration, generation)) throw notRetried(retryReason, retryCause);
        // Said on the wire, so the host refuses to spawn rather than quietly making a
        // new pane if its journal has lost the receipt after all.
        replaying = true;
      } else sentGeneration = generation;
    }
    try {
      const attemptTimeoutMs = Math.max(1, Math.min(
        requestTimeoutMs,
        deadline - wallNow(),
      ));
      const attempt = replaying ? { ...request, replay: true } : request;
      if (!idempotent) {
        // A stale identity/activity list is safe only until this daemon changes the
        // host, and the host may execute a request whose reply timed out here, so
        // the last known list is forgotten before the request goes out, not after
        // it is confirmed.
        hostMutationEpoch += 1;
        lastKnownHostPaneMemo.panes = null;
        lastKnownHostPaneMemo.at = 0;
        // The per-node memos are behind the same fence: a remote list from before
        // this mutation must not come back as that node's "last known" afterwards.
        nodePaneMemo.clear();
      }
      const result = await requestHostClient(client, type, attempt, {
        ...deps, hostRequestTimeoutMs: attemptTimeoutMs,
      });
      if (['spawn', 'meta', 'kill', 'remove', 'resize', 'clear'].includes(type)) hostPaneCaches.delete(client);
      // A spawn or a meta change can be the session's first pane or a new id on an
      // old one; a transcript lookup that missed before it must be asked again.
      // A meta patch concerns one pane, so only that pane's session is asked again
      // (the id the patch sets, else the one the reply's pane carries); a spawn, or a
      // meta change naming no session, forgets them all.
      if (type === 'spawn') forgetClaudeSessionMisses();
      else if (type === 'meta') {
        const named = [params?.patch?.sessionId, result?.pane?.meta?.sessionId].filter((id) => typeof id === 'string' && id);
        if (named.length) for (const id of named) forgetClaudeSessionMisses(id);
        else forgetClaudeSessionMisses();
      }
      // The host answers with its own id. The daemon asked about a pane it knows by
      // its fleet-wide name, and everything downstream — manual close, retirement's
      // identity checks, force-restart — compares the reply against that name, so
      // the qualifier goes back on before the reply leaves here.
      return node === daemon ? result : qualifyReply(result, node, daemon);
    } catch (error) {
      const disconnected = retryableHostError(error)
        || (client === state.client && client.socket && client.socket.destroyed);
      const reloading = error && error.code === 'reloading';
      const timedOut = hostRequestTimedOut(error);
      if (disconnected) invalidateHost(client, deps, error);
      if (!reloading && !disconnected && !timedOut) throw error;
      if (!idempotent) {
        const reason = reloading ? 'was reloading' : timedOut ? 'timed out' : 'disconnected';
        // A journalled spawn that reached a host which says it journals them may be
        // asked about again — but only of that same host, which the next attempt
        // checks before it sends anything. Everything else, and a spawn whose first
        // attempt never reached a host, keeps the never-retry rule.
        if (!journalledSpawn || !sentGeneration || !sentGeneration.spawnReceipts) throw notRetried(reason, error);
        // One replay. A second would be asking the same question of the same host.
        if (replaying) throw notRetried(reason, error);
        retryReason = reason;
        retryCause = error;
        // The replay gets a budget of its own: the attempt that failed has already
        // spent this one, and a receipt is answered at once.
        deadline = wallNow() + connectBudgetMs + requestTimeoutMs;
      }
      if (timedOut && timeoutRetries++ >= 1) throw error;
      if (reloading || disconnected) retryDeadline = Math.min(retryDeadline, wallNow() + retryMs);
      if (wallNow() >= deadline) throw error;
      if (reloading || disconnected) forceHostReconnect = true;
      const retryRemaining = Math.min(deadline, retryDeadline) - wallNow();
      if (retryRemaining <= 0) throw error;
      await sleep(Math.min(50, Math.max(0, retryRemaining)));
    }
  }
}

// Why a pane list could not be collected. 'unreachable': the host socket did not
// answer at all, so its panes may really be gone. 'timeout': the host owns the
// socket but did not answer `list` within HOST_REQUEST_TIMEOUT_MS, which under
// machine load says nothing about the panes — they are still there, still running.
function hostFailureKind(error) {
  return /timed out/i.test(String(error && error.message || error)) ? 'timeout' : 'unreachable';
}

// Whether a host is supposed to be there at all. `keep host` binds this socket and
// unlinks it on the way out, and it outlives daemon restarts, so its presence is
// the difference between "the host is not answering" and "no host is running".
function hostEndpointExists(deps = {}) {
  // Never throws: this runs inside the dashboard refresh, and a failed lookup only
  // means the endpoint is not evidence of anything.
  try {
    const node = deps.node || null;
    if (typeof deps.hostEndpointExists === 'function') return Boolean(deps.hostEndpointExists(node));
    if (!node || node === daemonNodeName(deps)) {
      return fs.existsSync(deps.hostSock || require('./hostclient.js').socketPath());
    }
    // A remote node has no socket file to look at. Being configured is all the
    // evidence there is that a host is supposed to be answering there.
    const resolved = require('./node-registry.js').resolveNode(node);
    return resolved.transport === 'tcp' ? true : fs.existsSync(resolved.sock);
  } catch { return false; }
}

// The nodes to collect panes from: the daemon node first, so the list a single-node
// install produces is the list it always produced. An entry that does not make sense
// travels with the rest, marked, because a node nobody can reach is still a node
// whose panes this daemon must not report as gone.
//
// The daemon node is never treated as invalid: it is reached through its own socket
// without consulting the registry at all, and a typo in its entry must not cost this
// machine its own pane list.
function hostNodeEntries(deps = {}) {
  const daemon = daemonNodeName(deps);
  const ordered = (entries) => {
    const known = entries.some((entry) => entry.name === daemon)
      ? entries : [{ name: daemon, invalid: false, reason: null }, ...entries];
    return [
      ...known.filter((entry) => entry.name === daemon).map((entry) => ({ ...entry, invalid: false })),
      ...known.filter((entry) => entry.name !== daemon),
    ];
  };
  if (Array.isArray(deps.hostNodes)) {
    return ordered(deps.hostNodes.map((entry) => (typeof entry === 'string'
      ? { name: entry, invalid: false, reason: null }
      : { name: entry.name, invalid: entry.invalid === true, reason: entry.reason || null })));
  }
  try { return ordered(nodes.configuredNodeEntries()); }
  catch (error) { return [{ name: daemon, invalid: false, reason: null, unreadable: true, detail: error.message }]; }
}

function hostNodeNames(deps = {}) {
  return hostNodeEntries(deps).filter((entry) => !entry.invalid).map((entry) => entry.name);
}

async function listNodePaneResult(node, deps = {}, fresh = false, epoch = hostMutationEpoch) {
  const client = await hostClientFor(node, deps);
  if (!client) return { panes: null, failure: 'unreachable', endpoint: hostEndpointExists({ ...deps, node }) };
  const now = deps.now || Date.now;
  const cached = hostPaneCaches.get(client);
  if (!fresh && cached && now() - cached.at < HOST_PANE_CACHE_MS) {
    // Marked out of band: this object is also the single-node install's whole
    // result, and its shape is the one every caller and snapshot already expects.
    const result = { panes: cached.panes, failure: null };
    cachedPaneResults.add(result);
    return result;
  }
  try {
    const result = await requestHostClient(client, 'list', {}, deps);
    const panes = Array.isArray(result && result.panes) ? result.panes : [];
    // A pane's agent liveness is its own node's to report, so each node's panes are
    // read against that node's table. A node that cannot answer leaves its panes
    // unannotated, which says "not known here" rather than "the agent is gone".
    if (panes.some((p) => p?.alive && Number.isInteger(p.pid) && ['claude', 'codex'].includes(p.meta?.agent))) {
      try {
        annotatePaneAgents(panes, await (deps.agentProcessRows || agentProcessRows)(deps, { node }),
          { ...deps, rowsNode: node });
      } catch {}
    }
    // A mutation that started while this list was in flight (or while it waited on
    // the process table) makes it a pre-mutation list: return it, remember nothing.
    //
    // The node's own memo is written here, not where the fan-out merges, so an
    // answer that arrives just after its budget still refreshes what this daemon
    // knows about that node. A node half a second too slow is stale for one read,
    // not until it happens to be quick.
    noteHostPaneSessions(panes);
    if (epoch === hostMutationEpoch) {
      hostPaneCaches.set(client, { at: now(), panes });
      rememberNodePanes(node, panes, now(), epoch);
    }
    return { panes, failure: null };
  } catch (error) {
    if (retryableHostError(error) || (client.socket && client.socket.destroyed)) invalidateHost(client, deps, error);
    // A client existed, so a host answered this daemon at least this far.
    return { panes: null, failure: hostFailureKind(error), endpoint: true, error };
  }
}

// Each node's own last known list, kept apart from the merged memo so that one
// node falling silent neither empties its panes nor overwrites what the others said.
function rememberNodePanes(node, panes, at, epoch = hostMutationEpoch) {
  if (epoch !== hostMutationEpoch) return;
  nodePaneMemo.set(node, { panes, at });
}

function lastKnownNodePanes(node, now) {
  const known = nodePaneMemo.get(node);
  return known && now - known.at < HOST_PANES_SLOW_REUSE_MS ? known : null;
}

// A remote pane is published under `<id>@<node>` and keeps the host's own id in
// hostPaneId, so a request can be unqualified again on the way back out.
function qualifyNodePanes(panes, node, daemon) {
  if (node === daemon) return panes.map((pane) => ({ ...pane, node }));
  return panes.map((pane) => ({
    ...pane, node, id: nodes.formatPaneRef(node, pane.id, { KEEP_DAEMON_NODE: daemon }), hostPaneId: pane.id,
  }));
}

async function listHostPaneResult(deps = {}, fresh = false) {
  const epoch = hostMutationEpoch;
  const entries = hostNodeEntries(deps);
  const daemon = daemonNodeName(deps);
  const now = deps.now || Date.now;
  const remember = (panes, complete) => {
    // Only a list this call actually collected, and that covers every node, is
    // remembered. A list from the per-node cache may predate a mutation that cleared
    // the memo; a partial one would quietly turn a node's panes into "gone".
    if (!complete || epoch !== hostMutationEpoch) return panes;
    const memo = deps.hostPaneMemo || lastKnownHostPaneMemo;
    memo.panes = panes;
    memo.at = now();
    return panes;
  };
  // Nobody could read the node list, so this is not "one node" — it is one node's
  // panes and no idea what else exists. Said out loud, because the answer changes
  // what a caller may conclude from a pane it cannot find.
  const unreadable = entries.some((entry) => entry.unreadable);
  // One node is the whole fleet: the result is the one the daemon has always
  // returned, pane for pane and field for field.
  if (entries.length === 1 && !unreadable) {
    const only = await listNodePaneResult(daemon, deps, fresh, epoch);
    if (Array.isArray(only.panes)) remember(only.panes, !cachedPaneResults.has(only));
    return only;
  }
  if (unreadable) {
    const only = await listNodePaneResult(daemon, deps, fresh, epoch);
    return { ...only, configurationUnreadable: true, nodes: {}, missingNodes: [] };
  }
  // Every node is asked at once, and each remote answer has its own, shorter budget
  // running from now. The console must never wait on a node in another building to
  // hear what the panes on this machine are doing.
  const budgetMs = deps.hostRemoteListTimeoutMs == null ? HOST_REMOTE_LIST_TIMEOUT_MS : deps.hostRemoteListTimeoutMs;
  const inFlight = new Map(entries.filter((entry) => !entry.invalid)
    .map((entry) => [entry.name, listNodePaneResult(entry.name, deps, fresh, epoch)]));
  const others = entries.filter((entry) => entry.name !== daemon).map(async (entry) => {
    // An entry nobody can resolve is asked nothing and reported as unusable.
    if (entry.invalid) return [entry.name, { panes: null, failure: 'invalid', detail: entry.reason }];
    let timer;
    const result = await Promise.race([
      inFlight.get(entry.name),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ panes: null, failure: 'timeout', late: true }), budgetMs); }),
    ]);
    if (timer) clearTimeout(timer);
    return [entry.name, result];
  });
  const primary = await inFlight.get(daemon);
  const settled = await Promise.all(others);
  const status = {};
  const missingNodes = [];
  const merged = [];
  let complete = Array.isArray(primary.panes) && !cachedPaneResults.has(primary);
  for (const [node, result] of settled) {
    if (Array.isArray(result.panes)) {
      // A list this call did not collect — one served from the node's own second-old
      // cache — is true enough to publish and not fresh enough to call the fleet
      // complete: the merged memo is what a later outage is reconstructed from.
      if (cachedPaneResults.has(result)) complete = false;
      status[node] = { ok: true };
      merged.push(...qualifyNodePanes(result.panes, node, daemon));
      continue;
    }
    // A node that did not answer in time has not lost its panes; it has stopped
    // saying anything about them. Show what it last said, say that it is stale,
    // and name the node so no caller reads the gap as an empty machine.
    const known = lastKnownNodePanes(node, now());
    status[node] = {
      ok: false,
      reason: result.failure || 'unreachable',
      ...(result.detail ? { detail: result.detail } : {}),
      ...(known ? { stale: true, panesAt: known.at } : {}),
    };
    missingNodes.push(node);
    if (known) merged.push(...qualifyNodePanes(known.panes, node, daemon));
    complete = false;
  }
  if (!Array.isArray(primary.panes)) {
    // The daemon node is the one whose failure the console reports, but the other
    // nodes answered and their panes are real: carry them so a publication can show
    // them instead of an empty fleet.
    return {
      ...primary, nodes: status, missingNodes, ...(merged.length ? { nodePanes: merged } : {}),
    };
  }
  const panes = [...qualifyNodePanes(primary.panes, daemon, daemon), ...merged];
  remember(panes, complete);
  return {
    panes, failure: null, nodes: status, ...(missingNodes.length ? { missingNodes } : {}),
  };
}

async function listHostPanes(deps = {}, fresh = false) {
  return (await listHostPaneResult(deps, fresh)).panes;
}

function lastKnownHostPanes({ maxAgeMs = HOST_PANES_SLOW_REUSE_MS } = {}, deps = {}) {
  const memo = deps.hostPaneMemo || lastKnownHostPaneMemo;
  const now = (deps.now || Date.now)();
  if (!Array.isArray(memo.panes) || now - memo.at >= maxAgeMs) return null;
  return { panes: memo.panes, ageMs: Math.max(0, now - memo.at), at: memo.at };
}

async function hostPanesForAction(deps = {}, fresh = false, maxAgeMs = HOST_PANES_SLOW_REUSE_MS) {
  let result;
  if (typeof deps.listHostPaneResult === 'function') result = await deps.listHostPaneResult(deps, fresh);
  else if (typeof deps.listHostPanes === 'function') {
    try {
      const panes = await deps.listHostPanes(deps, fresh);
      result = { panes, failure: Array.isArray(panes) ? null : 'unreachable' };
    } catch (error) {
      result = { panes: null, failure: hostFailureKind(error), error };
    }
  } else result = await listHostPaneResult(deps, fresh);
  if (Array.isArray(result.panes)) return { ...result, stale: false, ageMs: 0 };
  if (result.failure === 'timeout') {
    const known = (deps.lastKnownHostPanes || lastKnownHostPanes)({ maxAgeMs }, deps);
    if (known) return { ...result, ...known, stale: true };
  }
  return { ...result, stale: false };
}

function hostPaneVerificationError(action, result, status = 409) {
  const cause = result && result.error;
  const detail = String(cause && cause.message || '').trim();
  const reason = result && result.failure === 'timeout'
    ? `terminal host list timed out and no recent pane list is available${detail ? `: ${detail}` : ''}`
    : `terminal host is unreachable${detail ? `: ${detail}` : ''}`;
  const error = new InjectionError(status, `${action} cannot be verified because the ${reason}`);
  if (cause) error.cause = cause;
  return error;
}

// A failed host request leaves listHostPanes null. Publishing that as zero panes
// strips every session's liveness, so Waiting on you empties and sessions flash into
// Running & waiting. Reuse the last good list instead. A host that never answered the
// socket may genuinely be gone, so that reuse stays short; a host that answered but
// could not list in time is merely slow, and its last good list stays true far longer
// than a thrashing Mac takes to recover. Either way the publication says the list is
// stale, so the console reports an unresponsive host instead of vanished panes.
const HOST_PANES_REUSE_MS = 60e3;
const HOST_PANES_SLOW_REUSE_MS = 10 * 60e3;

// Writes a console waits on through its mutation fence rebuild the dashboard at once;
// every other write (project icons, UI debug, terminal profiles, keys) waits out the
// background rebuild throttle. Mirrors STATE_MUTATIONS in web/app/api.js.
const URGENT_DASHBOARD_MUTATIONS = new Set([
  '/api/abandon-account-handoff', '/api/abandon-transfer', '/api/ack', '/api/add', '/api/answer', '/api/checkin',
  '/api/close-idle', '/api/close-session', '/api/compact', '/api/decisions/judge',
  '/api/handoff-queue-cancel', '/api/handoff-rate-limited', '/api/handoff-session', '/api/inbox-card',
  '/api/mark-session', '/api/move-session', '/api/notifications', '/api/open', '/api/panes/spawn',
  '/api/portable-transfers', '/api/reminders', '/api/rename-session', '/api/reopen-session',
  '/api/resolve-portable-transfer', '/api/restart-daemon', '/api/restart-session', '/api/review-queue',
  '/api/reviewtick', '/api/run', '/api/send', '/api/session-keep-running', '/api/setaside', '/api/transfer-session',
]);
function urgentDashboardMutation(pathname) {
  return URGENT_DASHBOARD_MUTATIONS.has(pathname) || /^\/api\/panes\/[^/]+\/(?:kill|remove)$/.test(pathname)
    // Marking an agent's feed seen clears its badge, which only a rebuilt state shows.
    || /^\/api\/agents\/[^/]+\/seen$/.test(pathname);
}
// Takes a listHostPaneResult and returns the panes to publish alongside the host
// status that describes them: `{ ok: true }` for a list this host just answered,
// otherwise why the host is silent, since when, and whether the panes travelling
// with it are a reused older list.
// `epoch` is memo.epoch as it was when the lookup began: a mutation bumps it, so a list
// collected before the mutation is neither remembered nor reused for a later build.
// The other nodes' standing, alongside the daemon node's. Their panes travel in the
// same list, so this only says which of them answered and since when one has not.
function nodeStatusForPublish(result, memo, now) {
  if (!result || !result.nodes) return null;
  const tracked = memo.nodes || (memo.nodes = {});
  const status = {};
  for (const [name, reported] of Object.entries(result.nodes)) {
    const entry = tracked[name] || (tracked[name] = { failingSince: 0 });
    if (reported.ok) {
      entry.failingSince = 0;
      status[name] = { ok: true };
      continue;
    }
    if (!entry.failingSince) entry.failingSince = now;
    status[name] = {
      ok: false,
      reason: reported.reason || 'unreachable',
      since: entry.failingSince,
      // What the panes travelling under this node's name actually are: the last
      // thing it said, and when it said it. A console that shows them without this
      // is showing a live machine.
      ...(reported.stale ? { stale: true, panesAt: reported.panesAt } : {}),
      ...(reported.detail ? { detail: reported.detail } : {}),
    };
  }
  return status;
}

function hostPanesForPublish(result, memo, now, epoch = memo.epoch || 0) {
  const current = epoch === (memo.epoch || 0);
  const panes = result ? result.panes : null;
  const nodeStatus = nodeStatusForPublish(result, memo, now);
  const withNodes = (host) => (nodeStatus ? { ...host, nodes: nodeStatus } : host);
  // A list with a node missing from it is publishable and is not the fleet: this
  // memo is what a later outage is reconstructed from, and reconstructing it from a
  // partial list would report the missing node's panes as gone at the worst moment.
  const incomplete = Boolean(result && result.missingNodes && result.missingNodes.length);
  if (Array.isArray(panes)) {
    if (current) {
      if (!incomplete) {
        memo.panes = panes;
        memo.at = now;
      }
      memo.listed = true; // survives the mutation fence: this daemon has seen a host
      memo.failingSince = 0;
    }
    return { panes, host: withNodes({ ok: true }) };
  }
  const reason = (result && result.failure) || 'unreachable';
  // Nothing is bound to the host socket and this daemon has never listed a pane:
  // `keep host` is launched on demand and is simply not running, so there are no
  // panes and nothing is being hidden. Publishing that as an outage would put a
  // permanent warning on a console that is telling the truth. The socket is the
  // evidence, not the memo alone, because the host outlives daemon restarts.
  if (reason === 'unreachable' && !memo.listed && !(result && result.endpoint)) {
    // No host has ever answered here and nothing is bound to the socket — but the
    // other nodes answered, and their panes are real. Publishing null would report
    // a fleet that is running as an empty one.
    return { panes: (result && result.nodePanes) || panes, host: withNodes({ ok: true }) };
  }
  if (current && !memo.failingSince) memo.failingSince = now;
  const reuseMs = reason === 'timeout' ? HOST_PANES_SLOW_REUSE_MS : HOST_PANES_REUSE_MS;
  const reused = current && memo.panes && now - memo.at < reuseMs ? memo.panes : null;
  // The daemon node is silent, but the other nodes answered. Their panes are the
  // freshest thing there is, so they replace whatever the reused list last said
  // about those nodes rather than losing to it.
  const fromNodes = (result && result.nodePanes) || null;
  const answered = new Set((fromNodes || []).map((pane) => pane.node));
  const carried = reused && fromNodes
    ? [...reused.filter((pane) => !answered.has(pane.node)), ...fromNodes]
    : (reused || fromNodes || panes);
  return {
    panes: carried,
    host: withNodes({
      ok: false,
      reason,
      since: (current && memo.failingSince) || now,
      stale: Boolean(reused),
      panesAt: reused ? memo.at : null,
    }),
  };
}

function annotatePaneAgents(panes, rows, deps = {}) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  // Whose table this is. A pane that has not been tagged with a node came from the
  // same listing as these rows, so it is that machine's too.
  const rowsNode = deps.rowsNode || daemonNodeName(deps);
  for (const pane of panes) {
    if (!pane?.alive || !['claude', 'codex', 'pi'].includes(pane.meta?.agent)) continue;
    // Another machine's pane has another machine's pid. Leaving agentAlive undefined
    // says "not known here", which is the truth; reading it off the wrong process
    // table would be an answer about an unrelated process that happens to share a
    // number. A node that does not answer at all leaves it undefined too — never false.
    if (pane.node && pane.node !== rowsNode) continue;
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

// `expectedInputCount` and `expectedPid` make the write conditional: the host compares
// both against the live pane and writes only if they still agree, in one step, so a
// keystroke from a viewer cannot land between the check and the write, and a pane that
// was replaced under the same id cannot receive a key meant for the process before it.
// A refused write typed nothing at all, which is what inputDropped says.
async function writeTarget(target, value, deps = {}, options = {}) {
  if (!isHostTarget(target)) throw new Error('terminal target needs a host pane');
  const guarded = options.expectedInputCount !== undefined || options.expectedPid !== undefined;
  const result = await hostRequest('input', {
    pane: target.pane,
    data: Buffer.from(String(value), 'utf8').toString('base64'),
    ...(guarded ? { expectedInputCount: options.expectedInputCount, expectedPid: options.expectedPid } : {}),
    ...(options.operationId ? { operationId: String(options.operationId) } : {}),
  }, deps);
  if (result && result.dropped) {
    const replaced = result.reason === 'pane replaced';
    const error = new Error(replaced
      ? 'the pane was replaced before this keystroke; nothing was typed'
      : 'input arrived on the pane before this keystroke; nothing was typed');
    error.inputDropped = true;
    error.dropReason = typeof result.reason === 'string' ? result.reason : null;
    error.inputCount = Number.isInteger(result.inputCount) ? result.inputCount : null;
    throw error;
  }
  return result;
}

async function pressTargetKey(target, key, deps = {}, options = {}) {
  const named = {
    Enter: '\r', enter: '\r', Escape: '\x1b', escape: '\x1b', Backspace: '\x7f', backspace: '\x7f',
  };
  const value = Object.prototype.hasOwnProperty.call(named, key) ? named[key] : String(key);
  if (Array.from(value).length !== 1) throw new Error(`unsupported terminal key ${key}`);
  return writeTarget(target, value, deps, options);
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
  let promptAt = -1;
  lines.forEach((line, index) => { if (/^\s*❯(?:\s|$)/.test(line)) promptAt = index; });
  const hasModal = /(Enter to select|Enter to confirm|Held message|Esc to cancel)/
    .test(lines.slice(Math.max(0, promptAt)).join('\n'));
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

// A turn running on a Claude screen, with the phrase allowed to wrap across rows
// ("esc to" at the end of one, "interrupt" at the start of the next). Callers that
// may have typed those words into the composer exclude that parsed region below.
const CLAUDE_TURN_RUNNING_RE = /esc\s+to\s+interrupt|Compacting[.…]/i;
const CLAUDE_TURN_OR_DIALOG_RE = /esc\s+to\s+(?:interrupt|cancel)|Compacting[.…]/i;

function claudeTurnRunningOutsideDraft(screen, kind) {
  const region = draftRegionLines(screen, kind);
  if (!region) return CLAUDE_TURN_RUNNING_RE.test(String(screen || ''));
  return CLAUDE_TURN_RUNNING_RE.test(region.before.join('\n'))
    || CLAUDE_TURN_RUNNING_RE.test(region.after.join('\n'));
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

// Poll until the input box is provably back to what the probe found: empty, or holding
// the same text again (the suggestion re-rendered). Anything else fails closed — the
// caller is about to type, and its confirmation only looks for its own text as a
// substring, so a leftover `,` would be submitted as part of the command.
// Claude Code draws `❯ ` and then the input value, and paints a ghost suggestion past
// the cursor without moving it. So the cursor resting on the first input column means
// the input value is empty however much text the prompt line shows; a cursor after that
// text means the value is the text — someone accepted the suggestion.
function cursorAtInputStart(screen, cursor) {
  if (!cursor || !Number.isInteger(cursor.x) || !Number.isInteger(cursor.y)) return false;
  const lines = String(screen || '').split(/\r?\n/);
  let row = -1;
  lines.forEach((line, index) => { if (/^\s*❯(?:\s|$)/.test(line)) row = index; });
  if (row === -1 || cursor.y !== row) return false;
  return cursor.x === lines[row].indexOf('❯') + 2;
}

async function waitForProbeUndo(target, beforeScreen, lastScreen, read, wait, now, deps = {}) {
  // Only the collapsed-suggestion shape is ambiguous to the next reader. Any other box
  // visibly loses its trailing probe key, and an empty box is already settled.
  if (promptText(promptLine(lastScreen)) !== SUGGESTION_PROBE_KEY) return;
  const beforeText = normalizedText(promptText(promptLine(beforeScreen)));
  // The cursor is the only thing that tells a re-rendered ghost suggestion from a person
  // pressing Tab to accept it: both paint the same text. A caller that injected a
  // text-only reader gets no cursor, and then that shape is refused rather than trusted.
  const readResult = deps.readScreenResult
    || (deps.readScreen ? null : (t, lines, scrollback) => readScreenResult(t, lines, scrollback, deps));
  const startedAt = now();
  let screen = lastScreen;
  for (let reads = 0; reads < SUGGESTION_PROBE_SETTLE_READS; reads += 1) {
    await wait(SUGGESTION_PROBE_WAIT_MS);
    // A pane that cannot be read tells us nothing about the Backspace: the probe key is
    // still the last thing we saw, so it is still the answer we have to give.
    let cursor = null;
    try {
      // The whole viewport, not the last 30 rows: the host crops the text it returns but
      // always reports the cursor against the full viewport, so only an uncropped read
      // puts the rows and `cursor.y` in the same coordinate space. closeRestartShell
      // reads this way for the same reason.
      if (readResult) {
        const result = await readResult(target, null, false);
        screen = String((result && result.text) || '');
        cursor = result && result.cursor;
      } else screen = await read(target, null, false);
    } catch { break; }
    const line = promptLine(screen);
    // No prompt line at all is Claude Code mid-render, not an empty input box — the same
    // reading classifyPromptLine takes. It proves nothing, so it only costs a poll.
    const text = line == null ? null : normalizedText(promptText(line));
    if (text != null && !text) return { screen, cursor, ghost: false };
    if (text === beforeText && cursorAtInputStart(screen, cursor)) return { screen, cursor, ghost: true };
    if (text == null || text === SUGGESTION_PROBE_KEY) {
      if (now() - startedAt >= SUGGESTION_PROBE_SETTLE_MS) break;
      continue;
    }
    // Someone typed into the box, or accepted the suggestion into it, while we were
    // undoing our own keystroke. Either way it is no longer a box we may type into.
    const changed = 'the session input box changed while the probe was being undone; clear it in the terminal first';
    logDraftRefusal(target, changed, beforeScreen, screen, SUGGESTION_PROBE_KEY, deps);
    throw new InjectionError(409, changed, { screenTail: screenTail(screen) });
  }
  const stuck = 'the probe keystroke is still on screen after Backspace; clear the session input box in the terminal first';
  logDraftRefusal(target, stuck, beforeScreen, screen, SUGGESTION_PROBE_KEY, deps);
  throw new InjectionError(409, stuck, { screenTail: screenTail(screen) });
}

async function probeSuggestion(target, beforeScreen, deps = {}) {
  let precheckError;
  try {
    sendPrecheck(beforeScreen);
    return { kind: 'empty' };
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
  const proof = { kind: 'suggestion', settled: null };
  // A caller holding the pane's input counter (compactRestoreInputBaseline) gets both of
  // the probe's keys conditional on it: the comma at that count, its Backspace at one
  // more. Unguarded, a key someone typed after the comma landed would be the one the
  // Backspace deleted, and the comma would be left in their draft.
  const probeGuard = deps.probeInputGuard && Number.isInteger(deps.probeInputGuard.pid)
    && Number.isInteger(deps.probeInputGuard.inputCount) ? deps.probeInputGuard : null;
  try {
    try {
      await writeTarget(target, SUGGESTION_PROBE_KEY, deps, probeGuard
        ? { expectedInputCount: probeGuard.inputCount, expectedPid: probeGuard.pid } : {});
      typed = true;
    } catch (error) {
      // Refused by the host's guard: the key never reached the pane, so there is nothing
      // to watch for and nothing to undo.
      if (error && error.inputDropped) throw error;
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
      if (outcome === 'suggestion' || outcome === 'empty') return proof;
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
        // The box held exactly the probe key before we typed and still does: a
        // collapsed suggestion and a stale read are indistinguishable here, so say
        // which one the log should be read as instead of the generic "did not react".
        const message = normalizedText(beforeText) === SUGGESTION_PROBE_KEY && afterText === SUGGESTION_PROBE_KEY
          ? 'the input box held the probe key before the probe began; a previous probe\'s Backspace may not have rendered (or the box holds a literal comma); clear it in the terminal first'
          : 'the session input box shows text that did not react to a probe keystroke (a draft, or a prompt suggestion that has not re-rendered); clear it in the terminal first';
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
      let undone = false;
      try {
        await pressTargetKey(target, 'Backspace', deps, probeGuard
          ? { expectedInputCount: probeGuard.inputCount + 1, expectedPid: probeGuard.pid } : {});
        undone = true;
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
      // Leave a settled screen for whoever reads this pane next — including a probe
      // later in this same tick, and the caller that is about to type.
      if (undone) {
        try {
          proof.settled = await waitForProbeUndo(target, beforeScreen, lastScreen, read, wait, now, deps);
        } catch (error) {
          if (failure == null) throw error;
          // A more specific refusal is already on its way out and wins; the unsettled
          // box still has to reach whoever reads the error.
          if (failure.extra) failure.extra.cleanupError = String((error && error.message) || error);
        }
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
function draftRegionLines(screen, kind, options = {}) {
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
  // into a draft is content rather than the start of a new one. That is the safe
  // direction - it can only ever read MORE than the box, and more is refused.
  //
  // `fromLastGlyph` reads less: the last glyph alone, which is unambiguously the
  // composer's own (the bottom of the box is found from it) where the first is not,
  // because Codex draws no rule above its composer and this scan otherwise runs up
  // into the transcript. Anything above the last glyph becomes invisible, so it is
  // only ever safe for a caller holding separate proof that there is nothing up
  // there but its own keys. typeAndSubmit is the one such caller.
  let start = -1;
  for (let i = end - 1; i >= 0; i -= 1) {
    if (BOX_RULE_RE.test(lines[i])) break;
    if (prompt.test(lines[i])) { start = i; if (options.fromLastGlyph) break; }
  }
  if (start === -1) return null;
  const region = lines.slice(start, end);
  region[0] = region[0].replace(prompt, '');
  return {
    lines: region,
    width: Math.max(0, ...lines.map((line) => line.length)),
    before: lines.slice(0, start),
    after: lines.slice(end + 1),
  };
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
function draftRegionText(screen, kind, options) {
  const region = draftRegionLines(screen, kind, options);
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

// Match the rendered rows against the text without guessing the composer's width.
// Codex keeps a margin inside the terminal (currently three columns), while Claude's
// ruled box and both clients' status/footer rows can be wider or narrower than the
// editable area. Inferring a wrap from the widest row therefore turns a hard wrap in
// `release-` / `status` into `release- status` and strands the complete draft without
// pressing Enter.
//
// Terminal rendering removes a space at a soft-wrap boundary and inserts indentation
// on continuation rows, so the only honest comparison is row fragments separated by
// optional whitespace. Blank rows are not optional: automated messages are one line,
// and a blank inside the composer can hide text somebody added below our draft.
function renderedDraftMatches(screen, text, kind, options) {
  const region = draftRegionLines(screen, kind, options);
  if (!region || region.lines.some((line) => !line.trim())) return false;
  const fragments = region.lines.map((line) => line.trim());
  const escaped = fragments.map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('^' + escaped.join('\\s*') + '$').test(canonicalText(text));
}

// True only when the box holds exactly the message that was typed and nothing
// else. Containment is not enough: Owner typing while the watcher types leaves a
// box that contains our message and says something neither of us meant. Compared
// in NFC, because a terminal may echo back the other spelling of the same text.
function draftIsExactly(screen, text, kind, options) {
  const draft = draftRegionText(screen, kind, options);
  return draft !== null && draft === canonicalText(text);
}

// The pane's input counter and the process it belongs to, or null when either cannot
// be read. The host raises the counter for every keystroke that reaches the pane — a
// viewer's exactly as much as this daemon's. The two travel together everywhere,
// because `replace-exited` keeps the pane id and starts a new process's count at zero,
// so a count on its own says nothing about which program received those keys.
async function livePaneState(paneId, deps = {}) {
  try {
    const panes = await (deps.listHostPanes || listHostPanes)(deps, true);
    const live = Array.isArray(panes) ? panes.find((entry) => entry && entry.id === paneId) : null;
    if (!live || !Number.isInteger(live.inputCount) || !Number.isInteger(live.pid)) return null;
    return { inputCount: live.inputCount, pid: live.pid,
      ...(typeof live.lastInputAt === 'string' && live.lastInputAt ? { lastInputAt: live.lastInputAt } : {}) };
  } catch { return null; }
}

// Escape clears a non-empty Claude/Codex input box — but only ever *our* draft.
// If Owner has typed into the pane since, the box is his now: erasing it would
// destroy text nobody asked us to touch, so the draft is left exactly as found
// and the caller is told why.
//
// What `cleared: true` claims, exactly: from before Keep's first keystroke to after
// its last Escape, the only input this pane received was Keep's own, and the box was
// empty when that was read back. Nothing weaker would do. An empty box by itself is
// not proof — Owner can append a word and have the Escape wipe both, or press Enter
// and leave the box empty because a turn was sent, and a caller that believed the box
// would then retype a message the session already has.
//
// The claim has to reach back past the typing, which is why the expectation comes in
// through deps rather than being taken here: the count is read before the first chunk
// is written, and what arrives is `that count + one per chunk`. Taking a fresh baseline
// at this point would absorb an Enter that landed between the last confirmation read
// and the discard, and that Enter is exactly the one that matters.
//
// From there, two gaps, closed two ways. Between reading a count and our key reaching
// the pane there is nothing this process can check, so it does not try: the count and
// the pid travel with the keystroke and the host, which owns both, refuses the write
// if anything has changed. And around every screen this reads, the count is taken on
// both sides — a read spanning somebody else's keystroke says nothing about the box it
// shows, whichever side of the Escape it is on. A redraw arriving late needs no
// separate check: with the count unchanged, the only keys that could have put text
// back into that box are Keep's own, so an empty box after the Escape is conclusive.
async function discardTypedDraft(target, text, kind, deps = {}) {
  const read = deps.readScreen || ((t, lines, scrollback) => readScreen(t, lines, scrollback, deps));
  const write = deps.stderr || process.stderr.write.bind(process.stderr);
  const pane = (target && target.pane) || 'unknown';
  const paneState = () => livePaneState(pane, deps);
  const unverified = () => {
    write(`keep serve: left an aborted draft on pane ${pane}: its input activity could not be verified\n`);
    return { cleared: false, reason: 'input unverified' };
  };
  const arrived = () => {
    write(`keep serve: left an aborted draft on pane ${pane}: input arrived from elsewhere while it was being cleared\n`);
    return { cleared: false, reason: 'input arrived' };
  };
  const replaced = () => {
    write(`keep serve: left an aborted draft on pane ${pane}: the pane's process was replaced while it was being cleared\n`);
    return { cleared: false, reason: 'pane replaced' };
  };
  const left = (reason, detail, pid, inputCount) => {
    write(`keep serve: left an aborted draft on pane ${pane}: ${detail}\n`);
    return { cleared: false, reason, leftDraft: { pid, inputCount } };
  };
  // The guarded write is a host feature, and a host from before it ignores
  // expectedInputCount and expectedPid and writes the key anyway — the very race this
  // is here to avoid, run silently and reported as a clean clear. So the host is asked
  // what it supports first, the same way loading history and guarded kills ask, and a
  // host that has not been reloaded yet gets no keystrokes at all. `guardedInput`
  // promises both halves of the guard, which is what this relies on: a host honouring
  // only the count would still deliver an Escape to a replaced process. The caller's
  // refusal then keeps the message that says the draft is still on screen, which is
  // the true state of the pane until somebody runs `keep host reload`.
  const reloadRequired = (detail) => {
    write(`keep serve: left an aborted draft on pane ${pane}: ${detail}\n`);
    return { cleared: false, reason: 'host reload required' };
  };
  let capabilities;
  try {
    capabilities = await (deps.hostRequest || hostRequest)('hello', {}, deps);
  } catch (error) {
    return reloadRequired(`the terminal host could not be asked what it supports: ${String((error && error.message) || error)}`);
  }
  if (!capabilities || capabilities.guardedInput !== true) {
    return reloadRequired('the terminal host must be reloaded (keep host reload) before a typed draft can be cleared');
  }
  // What the pane must look like for any of this to be ours: the count the caller read
  // before it typed, plus its own chunks, on the process it read it from. An
  // expectation that could not be formed at all — the pane would not list before the
  // typing — presses nothing, and neither does a pane that has moved since: an Escape
  // this cannot account for is worse than a draft left where it is.
  const expected = deps.expectedPaneState;
  if (!expected || !Number.isInteger(expected.inputCount) || !Number.isInteger(expected.pid)) return unverified();
  const entry = await paneState();
  if (entry === null) return unverified();
  if (entry.pid !== expected.pid) return replaced();
  if (entry.inputCount !== expected.inputCount) return arrived();
  const pid = expected.pid;
  let count = expected.inputCount;
  let screen = '';
  try {
    screen = await read(target, deps.confirmationLines === undefined ? 30 : deps.confirmationLines, false);
  } catch (error) {
    write(`keep serve: could not read pane ${pane} to clear an aborted draft: ${String((error && error.message) || error)}\n`);
    return { cleared: false, reason: 'unreadable screen' };
  }
  // The other side of that read: the box just examined is only worth acting on if
  // nothing reached the pane while it was being read, and if it is still the same
  // process's box at all.
  const settled = await paneState();
  if (settled === null) return unverified();
  if (settled.pid !== pid) return replaced();
  if (settled.inputCount !== count) return arrived();
  if (!draftIsExactly(screen, text, kind)) {
    return left('mixed draft', 'the input box no longer holds only the typed message', pid, count);
  }
  // 2026-09-22 delivery:f1b206c1: Escape is Claude's interrupt key while a turn is
  // running, not a composer clear. A background notification began a turn after a
  // watcher typed, and the attempted cleanup interrupted that turn while leaving the
  // draft behind forever. Check the screen already bound to this exact pid/count,
  // and check it again before the menu-closing second Escape below: cleanup may wait;
  // somebody else's running turn may never be interrupted on its behalf.
  const turnRunning = (value) => (kind === 'claude' || deps.refuseRunningTurn)
    && claudeTurnRunningOutsideDraft(value, kind);
  if (turnRunning(screen)) {
    return left('turn running', 'a Claude turn is running, so Escape was not pressed', pid, count);
  }
  // Escape is a keystroke, not a guarantee. Read the box back after each one:
  // "cleared" is a claim about the session, so it is only made when the box is
  // actually empty. Twice at most, because a Claude slash draft has its command menu
  // open below the box and the first Escape may close only that menu. The second one
  // carries its own expected count, so it is refused by the host rather than typed
  // into text somebody started writing during the first round trip.
  let after = screen;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (turnRunning(after)) {
      return left('turn running', 'a Claude turn is running, so Escape was not pressed', pid, count);
    }
    if (attempt > 0 && !draftIsExactly(after, text, kind)) break;
    try {
      await pressTargetKey(target, 'Escape', deps, { expectedInputCount: count, expectedPid: pid });
    } catch (error) {
      if (error && error.inputDropped) return error.dropReason === 'pane replaced' ? replaced() : arrived();
      write(`keep serve: could not clear an aborted draft on pane ${pane}: ${String((error && error.message) || error)}\n`);
      return { cleared: false, reason: 'escape failed' };
    }
    try {
      after = await read(target, deps.confirmationLines === undefined ? 30 : deps.confirmationLines, false);
    } catch (error) {
      write(`keep serve: could not confirm the cleared draft on pane ${pane}: ${String((error && error.message) || error)}\n`);
      return { cleared: false, reason: 'unconfirmed clear', leftDraft: { pid, inputCount: count + 1 } };
    }
    // After the read, not before it: this is what says the screen just read is a
    // screen only our own Escape changed.
    const counted = await paneState();
    if (counted === null) return unverified();
    if (counted.pid !== pid) return replaced();
    if (counted.inputCount !== count + 1) return arrived();
    count = counted.inputCount;
    if (draftRegionText(after, kind) === '') return { cleared: true, reason: null };
  }
  write(`keep serve: the draft on pane ${pane} is still there after Escape\n`);
  return { cleared: false, reason: 'still there', leftDraft: { pid, inputCount: count } };
}

// Retire only drafts the discard-requesting delivery path positively left behind.
// The journal keeps no message plaintext, so the visible composer is parsed with the
// same exact-draft rules and its normalized hash is compared to the journal before it
// is handed back to discardTypedDraft. This is intentionally separate from reconcile:
// reconcile must preserve every other live-pane draft because a person may still press
// Enter. Here the pid and inputCount prove nobody did, the idle transcript state proves
// no turn or question is in flight, and discardTypedDraft rechecks both around its
// guarded Escape.
//
// 2026-09-22 delivery:f1b206c1: a watcher asked to discard its aborted draft, but a
// background-agent turn made Escape unsafe. Once that turn ended the complete draft
// and journal otherwise had no path to retirement. Retained scheduled-check journals
// are deleted without a receipt too: as in reconcile's dead-pane case, letting the
// owner fall back and possibly rerun is safer than stamping an unseen check delivered.
async function retireLeftDeliveryDrafts(directory, panes, deps = {}) {
  if (!Array.isArray(panes) || !panes.length) return [];
  const delivery = require('./delivery');
  const fileSystem = deps.fs || fs;
  const load = deps.loadDeliverySession || ((id, kind) => kind === 'claude' ? claudeSessionFor(id) : codex.sessionFor(id));
  const read = deps.readScreenResult || ((target, lines, scrollback) => readScreenResult(target, lines, scrollback, deps));
  const discard = deps.discardTypedDraft || discardTypedDraft;
  let names;
  try { names = fileSystem.readdirSync(directory).filter((name) => name.endsWith('.json')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const retired = [];
  for (const name of names) {
    const journal = path.join(directory, name);
    try {
      const entry = JSON.parse(fileSystem.readFileSync(journal, 'utf8'));
      const expected = entry && entry.leftDraft;
      if (name !== delivery.textHash(entry.sessionId) + '.json'
          || !expected || !Number.isInteger(expected.pid) || !Number.isInteger(expected.inputCount)
          || delivery.received(entry)) continue;
      const pane = panes.find((candidate) => candidate && candidate.id === entry.pane);
      if (!pane || pane.pid !== expected.pid || pane.inputCount !== expected.inputCount) continue;
      const session = load(entry.sessionId, entry.kind);
      if (!session || session.endedTurn !== true || session.pendingQuestion || session.pendingPlan) continue;
      const target = { pane: entry.pane };
      const snapshot = await read(target, 200, false);
      const screen = String(snapshot && snapshot.text || '');
      if (claudeTurnRunningOutsideDraft(screen, entry.kind)) continue;
      const visible = draftRegionText(screen, entry.kind);
      if (visible === null || delivery.textHash(visible) !== entry.hash) continue;
      const result = await discard(target, visible, entry.kind, {
        ...deps, expectedPaneState: expected, refuseRunningTurn: true,
      });
      if (!result || result.cleared !== true) {
        const left = result && result.leftDraft;
        if (left && Number.isInteger(left.pid) && Number.isInteger(left.inputCount)
            && (left.pid !== expected.pid || left.inputCount !== expected.inputCount)) {
          entry.leftDraft = { ...left, at: Date.now() };
          const temp = journal + '.tmp';
          fileSystem.writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 });
          fileSystem.renameSync(temp, journal);
        }
        continue;
      }
      try { fileSystem.unlinkSync(journal); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      retired.push(entry.sessionId);
    } catch {} // The ordinary health/reconcile pass keeps exposing anything uncertain.
  }
  return retired;
}

// Marks a failure as one that happened with characters already written to the
// pane. Read by bin/watcher-live.js, which may only give a delivery slot back
// when nothing was typed: an unconfirmed send is still a send.
function typedAlready(error) {
  if (error && typeof error === 'object') error.typingStarted = true;
  return error;
}

async function typeAndSubmit(target, text, confirmationCheck, deps = {}) {
  const deliveryJournal = require('./delivery');
  const read = deps.readScreen || ((t, lines, scrollback) => readScreen(t, lines, scrollback, deps));
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const savedTyping = deps.typingProgress?.state || null;
  const chunkChars = savedTyping?.chunkChars
    || Math.max(1, Math.floor(envNumber('KEEP_SEND_CHUNK_CHARS', 200)));
  const chunkDelayMs = envNumber('KEEP_SEND_CHUNK_DELAY_MS', 120);
  const chunks = chunkForTyping(text, chunkChars);
  const nothingTyped = (error) => {
    if (error && typeof error === 'object') error.nothingTyped = true;
    return error;
  };
  // A caller that may take its draft back has to be able to say that nothing but its
  // own keys reached the pane, and that claim starts before the first of them. Read
  // the pane now: each chunk is one input request, so after the typing the count must
  // be exactly this plus chunks.length, on this same process. discardTypedDraft is
  // given that expectation rather than taking a baseline of its own, which would
  // already contain anything Owner typed while the confirmation was being polled.
  // Only when a discard is possible at all: a plain send never looks at this, and
  // every send should not pay for a pane listing it will not read.
  let exactExpectation = null;
  // Every journaled delivery gets write-once chunks. Scheduled messages and agent
  // notes use this path too; limiting it to watcher-only flags would miss the
  // incidents this state is meant to recover.
  const guardedChunks = Boolean(deps.typingProgress);
  const pane = (target && target.pane) || 'unknown';
  let typingState = savedTyping;
  const stableScreen = async (expectedCount, expectedText, empty = false, alternate = null) => {
    const before = await livePaneState(pane, deps);
    const allowedCount = before && (before.inputCount === expectedCount
      || (alternate && before.inputCount === alternate.count));
    if (!before || before.pid !== typingState.pid || !allowedCount) {
      throw new InjectionError(409, 'pane input changed while a partial delivery was checked; no key was pressed');
    }
    let snapshot;
    try {
      snapshot = deps.readScreenResult
        ? await deps.readScreenResult(target, 200, false)
        : await readScreenResult(target, 200, false, deps);
    }
    catch { throw new InjectionError(409, 'partial delivery input could not be verified; no key was pressed'); }
    const screen = String(snapshot?.text || '');
    const after = await livePaneState(pane, deps);
    if (!after || after.pid !== before.pid || after.inputCount !== before.inputCount) {
      throw new InjectionError(409, 'input arrived while a partial delivery was checked; no key was pressed');
    }
    const screenLines = stripTerminalAnsi(screen).split(/\r?\n/);
    const promptPattern = deps.draftKind === 'codex' ? /^\s*›(?:\s|$)/ : /^\s*❯(?:\s|$)/;
    let activeStart = -1;
    screenLines.forEach((line, index) => { if (promptPattern.test(line)) activeStart = index; });
    const activeRegion = screenLines.slice(Math.max(0, activeStart)).join('\n');
    const modal = deps.draftKind === 'codex'
      ? CODEX_DIALOG_MARKERS.some((marker) => activeRegion.includes(marker))
      : Boolean(claudePrompts.recognize(activeRegion)?.live)
        || /(Enter to select|Enter to confirm|Held message|Esc to cancel)/.test(activeRegion);
    if (modal) throw new InjectionError(409, 'the session is showing a modal; partial delivery was not resumed');
    const wanted = alternate && before.inputCount === alternate.count ? alternate.text : expectedText;
    if (empty && !wanted) {
      if (deps.draftKind === 'codex') codexSendPrecheck(screen);
      else {
        const visibleText = promptText(promptLine(screen));
        if (visibleText) {
          const proof = deps.promptProof;
          const sameProbeState = proof?.kind === 'suggestion' && proof.settled?.ghost === true
            && proof.stable?.pid === before.pid && proof.stable?.inputCount === before.inputCount
            && normalizedText(promptText(promptLine(proof.settled.screen))) === normalizedText(visibleText)
            && cursorAtInputStart(screen, snapshot?.cursor);
          if (!sameProbeState) {
            throw new InjectionError(409, 'the input box was not empty; message was not typed');
          }
        } else sendPrecheck(screen);
      }
    } else {
      // The same reading the exact-draft guard takes below, on the same proof and
      // the same terms. This function has just checked the pane's pid and count on
      // both sides of the screen read, so nothing but our own keys is in the box and
      // the block under the last glyph is the box rather than a piece of it; a modal
      // has already been refused above. Without this a resume reads 200 rows, which
      // on a busy Codex pane drags in far more transcript than the 30 the guard
      // below reads, and every retry refuses a draft that is exactly right.
      const provenComposer = deps.draftKind === 'codex'
        && PLAIN_ONE_LINE_RE.test(wanted)
        && (draftIsExactly(screen, wanted, 'codex', { fromLastGlyph: true })
          || renderedDraftMatches(screen, wanted, 'codex', { fromLastGlyph: true }));
      if (!provenComposer && !draftIsExactly(screen, wanted, deps.draftKind)
          && !renderedDraftMatches(screen, wanted, deps.draftKind)) {
        throw new InjectionError(409, 'the partial delivery draft changed; no key was pressed');
      }
      const lines = screenLines;
      const prompt = promptPattern;
      let start = -1;
      lines.forEach((line, index) => { if (prompt.test(line)) start = index; });
      let end = start;
      while (end + 1 < lines.length && lines[end + 1].trim() && !BOX_RULE_RE.test(lines[end + 1])) end += 1;
      if (!Number.isFinite(snapshot?.cursor?.y) || snapshot.cursor.y < start || snapshot.cursor.y > end) {
        throw new InjectionError(409, 'the cursor is no longer in the partial delivery draft; no key was pressed');
      }
    }
    return screen;
  };
  if (guardedChunks) {
    let capabilities;
    let capabilityError;
    try { capabilities = await (deps.hostRequest || hostRequest)('hello', {}, deps); }
    catch (error) { capabilityError = error; }
    if (capabilityError && hostRequestTimedOut(capabilityError)) {
      throw nothingTyped(new InjectionError(503,
        `terminal host timed out while checking guarded-message support: ${capabilityError.message}`));
    }
    if (!capabilities || capabilities.guardedInput !== true || capabilities.guardedInputReceipts !== true) {
      throw nothingTyped(new InjectionError(409, 'terminal host reload required before a guarded message can be typed'));
    }
    if (typingState) {
      if (typingState.chunkChars !== chunkChars || typingState.chunkCount !== chunks.length
          || !Number.isInteger(typingState.acknowledgedChunks)
          || typingState.acknowledgedChunks < 0 || typingState.acknowledgedChunks > chunks.length) {
        throw new InjectionError(409, 'saved partial delivery plan does not match this message; no key was pressed');
      }
      const prefix = chunks.slice(0, typingState.acknowledgedChunks).join('');
      if (deliveryJournal.textHash(prefix) !== typingState.prefixHash) {
        throw new InjectionError(409, 'saved partial delivery prefix is invalid; no key was pressed');
      }
    } else {
      const baseline = await livePaneState(pane, deps);
      if (!baseline) throw nothingTyped(new InjectionError(409, 'pane input activity could not be verified before typing'));
      typingState = { pid: baseline.pid, initialInputCount: baseline.inputCount };
      try { await stableScreen(baseline.inputCount, '', true); }
      catch (error) { throw nothingTyped(error); }
      deps.typingProgress.plan({
        pid: baseline.pid,
        initialInputCount: baseline.inputCount,
        chunkChars,
        chunkCount: chunks.length,
        operationSeed: `delivery_${crypto.randomUUID().replace(/-/g, '')}`,
      });
      typingState = deps.typingProgress.state;
    }
    const writeChunk = async (index) => {
      const options = {
        expectedPid: typingState.pid,
        expectedInputCount: typingState.initialInputCount + index,
        operationId: deps.typingProgress.operationId(index),
      };
      let failure;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { return await writeTarget(target, chunks[index], deps, options); }
        catch (error) {
          if (error?.inputDropped) throw error;
          failure = error;
        }
      }
      throw failure;
    };
    deps.deliveryTrace?.('write-start');
    if (Number.isInteger(typingState.inFlightChunk)) {
      const index = typingState.inFlightChunk;
      const prefix = chunks.slice(0, index).join('');
      await stableScreen(
        typingState.initialInputCount + index,
        prefix,
        index === 0,
        { count: typingState.initialInputCount + index + 1, text: prefix + chunks[index] },
      );
      try {
        await writeChunk(index);
        deps.typingProgress.acknowledge(index, deliveryJournal.textHash(chunks.slice(0, index + 1).join('')));
      } catch (error) {
        // This operation predates this process attempt. A dropped replay can mean
        // the host restarted after accepting it but before persisting/replaying its
        // receipt; clearing inFlight would erase the only durable ambiguity marker.
        throw typedAlready(error);
      }
      typingState = deps.typingProgress.state;
    }
    if (typingState.acknowledgedChunks > 0) {
      await stableScreen(
        typingState.initialInputCount + typingState.acknowledgedChunks,
        chunks.slice(0, typingState.acknowledgedChunks).join(''),
      );
    }
    for (let index = typingState.acknowledgedChunks; index < chunks.length; index += 1) {
      deps.typingProgress.start(index);
      try {
        await writeChunk(index);
        deps.typingProgress.acknowledge(index, deliveryJournal.textHash(chunks.slice(0, index + 1).join('')));
      } catch (error) {
        if (error?.inputDropped) {
          deps.typingProgress.reject(index);
          if (index === 0) throw nothingTyped(error);
        }
        throw typedAlready(error);
      }
      if (index + 1 < chunks.length && chunkDelayMs > 0) await sleep(chunkDelayMs);
    }
    deps.typingProgress.complete();
    typingState = deps.typingProgress.state;
    exactExpectation = {
      pid: typingState.pid,
      inputCount: typingState.initialInputCount + chunks.length,
    };
  } else if (deps.discardDraftOnAbort && deps.requireExactDraft && deps.draftKind === 'codex') {
    // Direct (non-journaled) guarded sends retain the original stable-empty baseline.
    let capabilities;
    let capabilityError;
    try { capabilities = await (deps.hostRequest || hostRequest)('hello', {}, deps); }
    catch (error) { capabilityError = error; }
    if (capabilityError && hostRequestTimedOut(capabilityError)) {
      throw nothingTyped(new InjectionError(503,
        `terminal host timed out while checking guarded-input support: ${capabilityError.message}`));
    }
    if (!capabilities || capabilities.guardedInput !== true) {
      throw nothingTyped(new InjectionError(409, 'terminal host reload required before a guarded Codex message can be typed'));
    }
    const before = await livePaneState(pane, deps);
    if (!before) throw nothingTyped(new InjectionError(409, 'pane input activity could not be verified before typing'));
    let emptyScreen = '';
    try { emptyScreen = await read(target, deps.confirmationLines === undefined ? 30 : deps.confirmationLines, false); }
    catch { throw nothingTyped(new InjectionError(409, 'Codex input could not be verified empty before typing')); }
    const after = await livePaneState(pane, deps);
    if (!after || after.pid !== before.pid || after.inputCount !== before.inputCount) {
      throw nothingTyped(new InjectionError(409, 'input arrived while the Codex prompt was checked; message was not typed'));
    }
    try { codexSendPrecheck(emptyScreen); } catch (error) { throw nothingTyped(error); }
    exactExpectation = { pid: after.pid, inputCount: after.inputCount + chunks.length };
  }
  // A caller that proved the box itself and holds the pane's counter from that proof
  // (compactRestoreInputBaseline) types conditionally on it: each chunk is refused by the
  // host if any other key reached the pane since, and so is Enter, below.
  const inputBaseline = !guardedChunks && deps.inputBaseline
    && Number.isInteger(deps.inputBaseline.pid) && Number.isInteger(deps.inputBaseline.inputCount)
    ? deps.inputBaseline : null;
  if (inputBaseline) exactExpectation = { pid: inputBaseline.pid, inputCount: inputBaseline.inputCount + chunks.length };
  const discardExpectation = deps.discardDraftOnAbort
    ? exactExpectation || await (async () => {
      const before = await livePaneState(pane, deps);
      return before && { pid: before.pid, inputCount: before.inputCount + chunks.length };
    })()
    : null;
  const discardDeps = { ...deps, expectedPaneState: discardExpectation };
  if (!guardedChunks) {
    deps.deliveryTrace?.('write-start');
    for (let index = 0; index < chunks.length; index += 1) {
      if (!inputBaseline) await writeTarget(target, chunks[index], deps);
      else {
        try {
          await writeTarget(target, chunks[index], deps,
            { expectedInputCount: inputBaseline.inputCount + index, expectedPid: inputBaseline.pid });
        } catch (error) {
          if (error?.inputDropped && index === 0) throw nothingTyped(error);
          throw typedAlready(error);
        }
      }
      if (index + 1 < chunks.length && chunkDelayMs > 0) await sleep(chunkDelayMs);
    }
  }
  deps.deliveryTrace?.('write-finished');
  let confirmed = false;
  let confirmation = '';
  // Take the typed draft back (when the caller asked for that) and refuse: the one exit
  // for every abort between the typing and the Enter.
  const abortTyped = async (error) => {
    const discard = deps.discardDraftOnAbort
      ? await discardTypedDraft(target, text, deps.draftKind, discardDeps)
      : { cleared: false, reason: 'not requested' };
    deps.deliveryTrace?.('enter-aborted', { cleared: discard.cleared, reason: discard.reason });
    if (error && typeof error === 'object') {
      if (deps.discardDraftOnAbort && !discard.cleared) {
        error.draftLeftOnScreen = true;
        error.draftReason = discard.reason;
        if (discard.leftDraft) error.leftDraft = discard.leftDraft;
      }
      if (discard.cleared) error.draftCleared = true;
    }
    return typedAlready(error);
  };
  // A caller typing on a proven input baseline (the pending-swap restore) proved the
  // session idle, but a submit the host accepted just before that count may not have
  // rendered yet. Any screen read from here to the Enter that shows a turn running
  // refuses the Enter: the counter speaks only for keys, the screen for the turn.
  const turnRunning = (screen) => Boolean(inputBaseline) && CLAUDE_TURN_RUNNING_RE.test(String(screen || ''));
  const turnStarted = () => new InjectionError(409, 'the session started a turn while the command was typed; Enter was not pressed');
  // How long the screen is given to catch up, at 400ms a poll. Four is enough for a
  // plain message; a caller whose text makes Claude render more than the line — a
  // slash command draws its menu too — asks for more, because on a loaded machine
  // 1.6s was not enough and the typed /exit was abandoned in the box with its menu
  // open, which is the one state a retry cannot type into.
  const requested = Number(deps.confirmationAttempts);
  const attempts = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 4;
  for (let attempt = 0; attempt < attempts && !confirmed; attempt += 1) {
    await sleep(400);
    try { confirmation = await read(target, deps.confirmationLines === undefined ? (inputBaseline ? null : 30) : deps.confirmationLines, false); } catch { deps.deliveryTrace?.('screen-read-failed'); continue; }
    if (turnRunning(confirmation)) throw await abortTyped(turnStarted());
    confirmed = confirmationCheck(confirmation, text);
    deps.deliveryTrace?.('screen-confirmation', { matched: confirmed });
  }
  if (!confirmed) {
    // Same rule as the beforeEnter abort below: a caller that typed on nobody's
    // behalf takes its draft back rather than leaving it in the box. Without this the
    // text stays there forever — nothing pressed Enter and nothing pressed Escape —
    // and the next attempt refuses on a draft this one left behind.
    const discard = deps.discardDraftOnAbort
      ? await discardTypedDraft(target, text, deps.draftKind, discardDeps)
      : { cleared: false, reason: 'not requested' };
    deps.deliveryTrace?.('enter-aborted', { cleared: discard.cleared, reason: discard.reason });
    // Whether the pane was left with text in it is the difference between a refusal
    // worth retrying and one a person has to clear, so it is in the message itself.
    const label = /^\/[A-Za-z][A-Za-z0-9-]{0,19}$/.test(String(text)) ? String(text) : 'message';
    const error = new InjectionError(409, discard.cleared
      ? `message was typed but could not be confirmed; the typed ${label} was cleared`
      : 'message was typed but could not be confirmed; Enter was not pressed', {
      screenTail: screenTail(confirmation),
    });
    if (deps.discardDraftOnAbort && !discard.cleared) {
      error.draftLeftOnScreen = true;
      error.draftReason = discard.reason;
      if (discard.leftDraft) error.leftDraft = discard.leftDraft;
    }
    // Read with typingStarted by anything that has to decide what reached the pane:
    // characters were written, and then taken back off the screen under the guard, so
    // the pane ends where it began. bin/delivery.js keeps no journal for such a send.
    if (discard.cleared) error.draftCleared = true;
    throw typedAlready(error);
  }
  if (deps.beforeEnter) {
    try {
      await deps.beforeEnter(target);
    } catch (error) {
      // The text is in the box and Enter has not been pressed. Callers that
      // typed on nobody's behalf — the watcher, and a restart's own /exit — ask
      // for the draft to be cleared, because a draft nobody typed is worse than
      // no message at all, and a retry cannot type into a box that still holds
      // it. A close Owner asked for keeps its typed /exit on screen, as it always
      // has, so he can see what was about to happen.
      throw await abortTyped(error);
    }
  }
  // Last of all, and deliberately after beforeEnter rather than before it:
  // confirmation above asks whether the typed text is visible, this asks whether
  // it is the *only* thing in the box, and every millisecond between the two is
  // one in which Owner can start typing. Callers that type unprompted (the
  // watcher) demand exactness; a human-initiated send keeps the older, looser
  // check it has always had.
  if (deps.requireExactDraft || guardedChunks || inputBaseline) {
    let exactScreen = '';
    try {
      // On the guarded path the whole viewport, so its turn check sees a spinner however
      // tall the pane is.
      exactScreen = await read(target, deps.confirmationLines === undefined ? (inputBaseline ? null : 30) : deps.confirmationLines, false);
    } catch { exactScreen = ''; }
    if (turnRunning(exactScreen)) throw await abortTyped(turnStarted());
    // The ordinary parser remains deliberately conservative about whether a short
    // row is a hard wrap or a real line break. A watcher send has stronger evidence:
    // it counted the pane before typing, knows exactly how many chunk writes it made,
    // and can make Enter conditional on that same count. With that proof, compare all
    // rendered fragments directly and avoid guessing the composer's width.
    const guardedFragments = exactExpectation && renderedDraftMatches(exactScreen, text, deps.draftKind);
    // Codex draws no rule above its composer, so the parse above runs up into the
    // transcript on a busy pane and refuses a message that is exactly right: live on
    // 2026-09-21 a 496-character draft read as 2021 characters here, and the send
    // retried into the same refusal every minute until its journal went stale.
    // Reading from the last glyph instead gets the composer block on its own - but
    // that hides whatever is above it, so it is worth nothing by itself. What makes
    // it safe is the pane's own counter: the host bumps inputCount at the only two
    // pty writes it has, each chunk went in conditional on that count, and precheck
    // found the box empty, so a pane still standing at exactly this send's expected
    // count on the same process has had no key in it but ours. Then the block below
    // the last glyph is not a fragment of the box - it is the box.
    //
    // The counter speaks for the keys, and only for the keys. It says nothing about
    // what the application made of them, so this stays narrow: one line of plain
    // text, so the bytes cannot steer the composer or submit early; no dialog on
    // screen, because output alone can raise one after precheck and a dialog is not
    // a composer; and the block still has to match the message, so the accept rests
    // on what the pane shows now rather than on the loose fingerprint the screen
    // confirmation above settles for.
    const provenComposer = guardedChunks && exactExpectation && deps.draftKind === 'codex'
      && PLAIN_ONE_LINE_RE.test(text)
      && !CODEX_DIALOG_MARKERS.some((marker) => exactScreen.includes(marker))
      && (draftIsExactly(exactScreen, text, 'codex', { fromLastGlyph: true })
        || renderedDraftMatches(exactScreen, text, 'codex', { fromLastGlyph: true }))
      && await (async () => {
        const counted = await livePaneState(pane, deps);
        return Boolean(counted && counted.pid === exactExpectation.pid
          && counted.inputCount === exactExpectation.inputCount);
      })();
    if (!provenComposer && !draftIsExactly(exactScreen, text, deps.draftKind) && !guardedFragments) {
      deps.deliveryTrace?.('draft-not-exact');
      // Nothing is pressed and nothing is cleared: the box holds text this did
      // not write, and touching it is not this code's decision to make.
      throw typedAlready(new InjectionError(409, 'the input box no longer holds only the typed message; Enter was not pressed', {
        screenTail: screenTail(exactScreen), draftLeftOnScreen: true,
      }));
    }
  }
  // Every check above has passed and the next key is the Enter. A caller that has to
  // journal "this submit was committed" (an account handoff's stop proof) does it here —
  // not when typing starts, since a draft taken back or refused never became a submit —
  // and is told when the host refused the Enter outright, which is the only answer that
  // proves it did not land. A transport failure stays ambiguous and keeps the mark.
  // A hook that throws is an abort like any other before the Enter: the draft is taken
  // back rather than left in the composer.
  if (deps.beforeEnterKey) {
    try { await deps.beforeEnterKey(); } catch (error) { throw await abortTyped(error); }
  }
  deps.deliveryTrace?.('enter-start');
  try {
    await pressTargetKey(target, 'Enter', deps, exactExpectation
      ? { expectedInputCount: exactExpectation.inputCount, expectedPid: exactExpectation.pid }
      : {});
  } catch (error) {
    if (error && error.inputDropped && deps.enterKeyDropped) await deps.enterKeyDropped();
    throw error;
  }
  deps.deliveryTrace?.('enter-sent');
  return { ok: true };
}

// rolloutFileFor only knows the rollouts a codex.scan() has walked. A session opened
// since the last scan, or any session right after a daemon restart, is not in it;
// a caller that reaches one without a fleet scan first (a tell reads only the session
// it names) would otherwise hand delivery a null path. findRolloutFile locates it by
// the id in its file name, as sessionSummaryFile already does.
function transcriptFileForSession(session) {
  // A session on another node has no file here, and whatever local file shares its id
  // is some other machine's history. Its transcript is read through its node
  // (nodeTranscriptFileForSession); to every synchronous caller of this one it is
  // simply unavailable, the answer each of them already handles, and never a local path.
  if (session && session.node && session.node !== daemonNodeName()) return null;
  return session.kind === 'codex'
    ? codex.rolloutFileFor(session.id) || codex.findRolloutFile(session.id)
    : session.kind === 'pi' ? session.sessionFile || pi.fileFor(session.id)
    : findSessionFile(session.id);
}

// ---------- a node's transcripts, through its host ----------
//
// The daemon never opens a node's path as a file. It asks the node's host, whose
// `transcript` verb (bin/node-transcript.js) resolves the file itself from the
// session's kind, id and account and re-validates that account against its own
// configuration. The daemon's part is naming the account (the session's authority
// record, never discovery) and refusing clearly when the node's host predates the verb.

// hello answers, per node, for the capability check. A yes is remembered briefly;
// a no is asked again every time, so a node whose host was just updated is used at once.
const nodeTranscriptCapability = new Map();
const NODE_TRANSCRIPT_CAPABILITY_MS = 60e3;

async function requireNodeTranscript(node, deps = {}) {
  const now = Date.now();
  const known = nodeTranscriptCapability.get(node);
  if (known && now - known < NODE_TRANSCRIPT_CAPABILITY_MS) return;
  const hello = await (deps.hostRequest || hostRequest)('hello', {}, { ...deps, node });
  if (!hello || !(Number(hello.transcript) >= 1)) {
    nodeTranscriptCapability.delete(node);
    throw new InjectionError(409,
      `the terminal host on ${node} predates the transcript verb, so no delivery to its sessions can be confirmed; update keep-tool on ${node} and reload its host`,
      { reason: 'remote-node' });
  }
  nodeTranscriptCapability.set(node, now);
}

function nodeTranscriptAccount(session, deps = {}) {
  let account = null;
  try {
    account = accounts.forSession(session.id, session.kind, {
      root: deps.root || keep.ROOT, env: deps.env || process.env, allowDiscovery: false,
    });
  } catch (error) {
    throw new InjectionError(409, `the account of ${session.id} could not be resolved: ${error.message}`, { reason: 'remote-node' });
  }
  if (!account || typeof account.id !== 'string' || typeof account.configDir !== 'string') {
    throw new InjectionError(409, `${session.id} has no account record naming where its transcript lives`, { reason: 'remote-node' });
  }
  return { id: account.id, configDir: account.configDir };
}

// { stat(), tail(length), match(offset, hash, { timeoutMs }) } for one session on one
// node. Each call is one request on the node's transcript connection; a match's own
// wait (at most nine seconds on the node) gets two more on top as its reply window.
function nodeTranscript(node, session, deps = {}) {
  if (!node || node === daemonNodeName(deps)) throw new Error('nodeTranscript is for a session on another node');
  if (!session || !/^[A-Za-z0-9_-]+$/.test(String(session.id || '')) || !['claude', 'codex', 'pi'].includes(session.kind)) {
    throw new InjectionError(400, 'bad session for a node transcript');
  }
  const ask = async (op, extra = {}, replyTimeoutMs = null) => {
    await requireNodeTranscript(node, deps);
    const account = nodeTranscriptAccount(session, deps);
    return (deps.hostRequest || hostRequest)('transcript',
      { op, kind: session.kind, sessionId: session.id, account, ...extra },
      { ...deps, node, ...(replyTimeoutMs == null ? {} : { hostRequestTimeoutMs: replyTimeoutMs }) });
  };
  return {
    node,
    stat: () => ask('stat'),
    tail: (length) => ask('tail', length ? { length } : {}),
    // A Codex rollout's session_meta and last turn's model (transcript verb 4).
    meta: () => ask('meta'),
    match: (offset, hash, options = {}) => {
      const timeoutMs = Math.max(0, Math.min(9000, Math.floor(Number(options.timeoutMs) || 0)));
      return ask('match', { fromOffset: offset, hash, timeoutMs }, timeoutMs + 2000);
    },
  };
}

// Where a remote session's transcript is, as its node sees it right now: the node's
// own path (to be recorded, never opened here) and its size.
async function nodeTranscriptFileForSession(session, deps = {}) {
  const node = session && session.node;
  const stat = await nodeTranscript(node, session, deps).stat();
  return { node, path: stat.path, size: stat.size, mtimeMs: stat.mtimeMs, generation: stat.generation };
}

// A delivery journal's receipt, asked of the node it names (delivery.js's receiptFor
// and remote.receipt). True only when the node read the text in the transcript the
// journal recorded: a node now answering about a different file (another path, or
// the same path re-created) has not seen it there. A node that does not answer, or
// cannot be asked, throws, which every caller takes as "leave the journal alone".
async function deliveryReceiptFor(entry, deps = {}, timeoutMs = 0) {
  if (!entry || !entry.node) throw new Error('not a node delivery journal');
  const result = await nodeTranscript(entry.node, { id: entry.sessionId, kind: entry.kind }, deps)
    .match(entry.offset, entry.hash, { timeoutMs });
  if (!result || typeof result.matched !== 'boolean') throw new Error(`${entry.node} gave no receipt answer`);
  if (result.path !== entry.file) return false;
  if (typeof entry.generation === 'string' && result.generation !== entry.generation) return false;
  return result.matched;
}

// ---------- a moving session's files, on a node ----------
//
// The daemon's end of the `artifacts` verb (bin/session-artifacts.js on the node):
// the same interface artifact-transport's localArtifacts gives for this machine, so a
// push to a node and a pull from one are one walk with the ends swapped. The node
// re-validates the account and builds every path itself; nothing here names a path on
// the node beyond the relative ones its own list returned.
// node -> { at, version }: when its host last said it answers the verb, and which one.
const nodeArtifactsCapability = new Map();
const NODE_ARTIFACTS_CAPABILITY_MS = 60e3;
// The artifacts verb version a Codex session's move needs: 2 carries its rollouts.
const CODEX_ARTIFACTS_VERSION = 2;
const ARTIFACTS_TIMEOUT_MS = { list: 120e3, read: 30e3, stage: 30e3, publish: 120e3, release: 120e3, abort: 30e3, cwd: 8e3, 'drop-session': 8e3, account: 8e3 };

// `minimum` is the verb version the move needs: 1 for a Claude session, 2 for a Codex
// one. A host that answers an older one is refused by name, never asked and left to
// fail on a kind it does not know.
async function requireNodeArtifacts(node, deps = {}, minimum = 1) {
  const now = Date.now();
  const known = nodeArtifactsCapability.get(node);
  if (known && now - known.at < NODE_ARTIFACTS_CAPABILITY_MS && known.version >= minimum) return;
  const hello = await (deps.hostRequest || hostRequest)('hello', {}, { ...deps, node });
  const version = hello ? Number(hello.artifacts) : 0;
  if (!hello || !(version >= 1) || !(Number(hello.transcript) >= 1)) {
    nodeArtifactsCapability.delete(node);
    throw new InjectionError(409,
      `the terminal host on ${node} predates the artifacts verb, so no session can be moved to or from it; update keep-tool on ${node} and reload its host`,
      { reason: 'remote-node' });
  }
  nodeArtifactsCapability.set(node, { at: now, version });
  if (!(version >= minimum)) {
    throw new InjectionError(409,
      `the terminal host on ${node} predates Codex moves (its artifacts verb is version ${version}), so no Codex session can be moved to or from it; update keep-tool on ${node} and reload its host`,
      { reason: 'remote-node' });
  }
}

function nodeArtifacts(node, account, deps = {}) {
  if (!node || node === daemonNodeName(deps)) throw new Error('nodeArtifacts is for another node');
  const request = async (params) => {
    const unscoped = params.op === 'cwd' || params.op === 'drop-session';
    // Only the two ops that name no account may be asked without one.
    if (!unscoped && (!account || typeof account.id !== 'string' || typeof account.configDir !== 'string')) {
      throw new InjectionError(400, 'nodeArtifacts needs an account with an id and a config directory');
    }
    // A Codex account's files are its rollouts: the node is told so, and must know how.
    const codex = Boolean(account && account.agent === 'codex');
    await requireNodeArtifacts(node, deps, codex ? CODEX_ARTIFACTS_VERSION : 1);
    const scoped = unscoped ? params : { ...params, account: { id: account.id, configDir: account.configDir }, ...(codex ? { kind: 'codex' } : {}) };
    return (deps.hostRequest || hostRequest)('artifacts', scoped,
      { ...deps, node, hostRequestTimeoutMs: ARTIFACTS_TIMEOUT_MS[params.op] || HOST_REQUEST_TIMEOUT_MS });
  };
  return {
    ...artifactTransport.endpoint(request, { where: node }),
    cwd: (cwdPath) => request({ op: 'cwd', path: cwdPath }),
    dropSession: (sessionId) => request({ op: 'drop-session', sessionId }),
  };
}

function localSessionArtifacts(account, deps = {}) {
  return artifactTransport.localArtifacts(account, { env: deps.env || process.env, where: daemonNodeName(deps) });
}

// This machine's copy of a session, carried onto `toNode` under the same account (the
// fleet shares one home, so the node's account is this one unless a caller that knows
// otherwise names it). Resolves the transfer's manifest; throws before the publish if
// the source changed while it was carried.
async function pushSession(sessionId, fromLocalAccount, toNode, options = {}) {
  const deps = options.deps || {};
  return artifactTransport.transfer({
    sessionId, tx: options.tx, pieceBytes: options.pieceBytes,
    from: options.from || localSessionArtifacts(fromLocalAccount, deps),
    to: nodeArtifacts(toNode, options.nodeAccount || fromLocalAccount, deps),
  });
}

// A node's copy of a session, carried here under the same account.
async function pullSession(sessionId, fromNode, toLocalAccount, options = {}) {
  const deps = options.deps || {};
  return artifactTransport.transfer({
    sessionId, tx: options.tx, pieceBytes: options.pieceBytes,
    from: nodeArtifacts(fromNode, options.nodeAccount || toLocalAccount, deps),
    to: options.to || localSessionArtifacts(toLocalAccount, deps),
  });
}

// The text readTranscriptTail would have returned for the same bytes: a tail that
// does not start at the beginning drops its partial first line.
function tailText(tail) {
  let text = Buffer.from(String(tail && tail.bytes || ''), 'base64').toString('utf8');
  if (Number(tail && tail.from) > 0) text = text.slice(text.indexOf('\n') + 1);
  return text;
}

// The Claude session model from a node's tail: the same scan and the same row
// claudeSessionForEntry builds from a file here, from the same bytes. Two things are
// the node's and cannot be read from here, so they are answered conservatively: a
// background agent's own transcript (its launch still counts as pending) and the
// interactive marker past the tail (a transcript longer than the tail is taken as
// the interactive session its pane says it is).
function claudeSessionFromTail(id, tail, options = {}) {
  const info = { ...scanTranscriptText(tailText(tail), null), backgroundParentFile: null, backgroundAgents: undefined };
  const stat = { size: Number(tail.size) || 0, mtimeMs: Number(tail.mtimeMs) || 0 };
  if (options.interactiveOnly === true && !info.interactive && stat.size <= TAIL_BYTES) return null;
  let reviewer = false;
  try { reviewer = fs.readdirSync(path.join(options.root || keep.ROOT, '.keep', 'reviewer')).includes(id); } catch {}
  const dir = path.basename(path.dirname(String(tail.path || '')));
  const session = claudeSessionFromInfo(id, info, stat, dir, reviewer, Date.now(), options.accountId || null);
  return options.node ? { ...session, node: options.node } : session;
}

// ---------- a node session's freshness, for the publication ----------
//
// The console's idle and attention states and the stalled detector read a row's
// size, mtime and endedTurn. A local row has them from its transcript; a row for a
// pane on another node gets them from that node: a `stat` every listing cycle (at
// most once per 2.5 s per session, the process rows' cache), and a `tail` only when
// the stat says the transcript changed. Only for a Claude pane whose session the
// authority record places on the node that lists it. A node that does not answer
// leaves its rows as they were, without a transcript size.
const REMOTE_TRANSCRIPT_CACHE_MS = PROCESS_ROWS_CACHE_MS;
const REMOTE_TRANSCRIPT_CACHE_LIMIT = 512;
const remoteTranscriptCache = new Map(); // `${node}\0${sessionId}` -> { at, stat, tail, accountId, pending }

async function cachedRemoteSession(node, sessionId, deps = {}) {
  const key = `${node}\0${sessionId}`;
  let entry = remoteTranscriptCache.get(key);
  if (!entry) {
    entry = { at: 0, stat: null, tail: null, accountId: null, pending: null };
    remoteTranscriptCache.set(key, entry);
    while (remoteTranscriptCache.size > REMOTE_TRANSCRIPT_CACHE_LIMIT) {
      remoteTranscriptCache.delete(remoteTranscriptCache.keys().next().value);
    }
  }
  const now = typeof deps.now === 'function' ? Number(deps.now()) : Date.now();
  const model = () => claudeSessionFromTail(sessionId, entry.tail, { root: deps.root || keep.ROOT, accountId: entry.accountId, node });
  if (entry.tail && now - entry.at < REMOTE_TRANSCRIPT_CACHE_MS) return model();
  if (!entry.pending) {
    entry.pending = (async () => {
      const session = { id: sessionId, kind: 'claude', node };
      const client = nodeTranscript(node, session, deps);
      const stat = await client.stat();
      const same = entry.tail && entry.stat && stat.size === entry.stat.size
        && stat.mtimeMs === entry.stat.mtimeMs && stat.generation === entry.stat.generation;
      if (!same) {
        const tail = await client.tail();
        entry.tail = tail;
        entry.accountId = nodeTranscriptAccount(session, deps).id;
      }
      entry.stat = stat;
      entry.at = typeof deps.now === 'function' ? Number(deps.now()) : Date.now();
    })().finally(() => { entry.pending = null; });
  }
  await entry.pending;
  return model();
}

// A Pi session's phase on another node, for the publication: the node's own phase
// file (piEventFor), read at most once per 2.5 s per session as a Claude session's
// transcript is. A read that fails keeps what the last one said; the first one that
// fails is no signal (null).
const remotePiEventCache = new Map(); // `${node}\0${sessionId}` -> { at, event, pending }

// What the last read of that phase said, without asking (undefined before any read
// answered): a listing whose read runs past its budget publishes this meanwhile.
function peekRemotePiEvent(node, sessionId) {
  const entry = remotePiEventCache.get(`${node}\0${sessionId}`);
  return entry && entry.at ? entry.event : undefined;
}

async function cachedRemotePiEvent(node, sessionId, deps = {}) {
  const key = `${node}\0${sessionId}`;
  let entry = remotePiEventCache.get(key);
  if (!entry) {
    entry = { at: 0, event: null, pending: null };
    remotePiEventCache.set(key, entry);
    while (remotePiEventCache.size > REMOTE_TRANSCRIPT_CACHE_LIMIT) {
      remotePiEventCache.delete(remotePiEventCache.keys().next().value);
    }
  }
  const now = typeof deps.now === 'function' ? Number(deps.now()) : Date.now();
  if (entry.at && now - entry.at < REMOTE_TRANSCRIPT_CACHE_MS) return entry.event;
  if (!entry.pending) {
    entry.pending = (async () => {
      try {
        entry.event = await readNodePiEvent(sessionId, node, deps);
        entry.at = typeof deps.now === 'function' ? Number(deps.now()) : Date.now();
      } catch {}
    })().finally(() => { entry.pending = null; });
  }
  await entry.pending;
  return entry.event;
}

// { sessionId: row } for the live Claude panes on other nodes in a listing, or null
// when there are none (a single-node install always). Each is read in parallel; one
// whose node does not answer, or whose session is not recorded on the node that lists
// it, is simply absent.
//
// The console never waits on a node in another building: a node this listing could
// not hear from (`skipNodes`: its remembered panes are still listed) is not asked at
// all, and the reads that are asked share the remote-list budget listHostPaneResult
// gives a node's pane list. A read still running at the deadline leaves its row
// without a size this cycle; it finishes into the cache for the next one.
async function remoteSessionFreshness(panes, deps = {}, { skipNodes = null } = {}) {
  const env = paneRefEnv(deps);
  const skip = new Set(skipNodes || []);
  const wanted = (Array.isArray(panes) ? panes : []).filter((pane) => pane && pane.alive
    && nodes.isRemotePane(pane, env) && !skip.has(pane.node) && pane.meta
    && (pane.meta.agent === 'claude' || pane.meta.agent === 'pi')
    && typeof pane.meta.sessionId === 'string' && /^[A-Za-z0-9_-]+$/.test(pane.meta.sessionId));
  if (!wanted.length) return null;
  const out = {};
  const reads = Promise.all(wanted.map(async (pane) => {
    const id = pane.meta.sessionId;
    try {
      if (sessionNodeOf({ id }, deps) !== pane.node) return;
      // A Pi session on a node has no transcript row here: what the node gives is its
      // phase, which the host-only row (backfillHostSessions) takes its turn state from.
      if (pane.meta.agent === 'pi') {
        // The last answer first, so a node read slower than the budget below leaves
        // the row on its cached phase this cycle rather than on none; the read, when
        // it lands in time, replaces it.
        const cached = (deps.peekRemotePiEvent || peekRemotePiEvent)(pane.node, id);
        if (cached !== undefined) out[id] = { id, kind: 'pi', node: pane.node, piEvent: cached || null };
        const piEvent = await (deps.cachedRemotePiEvent || cachedRemotePiEvent)(pane.node, id, deps);
        out[id] = { id, kind: 'pi', node: pane.node, piEvent: piEvent || null };
        return;
      }
      const session = await (deps.cachedRemoteSession || cachedRemoteSession)(pane.node, id, deps);
      if (session) out[id] = session;
    } catch {}
  }));
  const budgetMs = deps.hostRemoteListTimeoutMs == null ? HOST_REMOTE_LIST_TIMEOUT_MS : deps.hostRemoteListTimeoutMs;
  let timer;
  await Promise.race([reads, new Promise((resolve) => { timer = setTimeout(resolve, budgetMs); })]);
  clearTimeout(timer);
  const answered = { ...out };
  return Object.keys(answered).length ? answered : null;
}

// The nodes a pane listing could not hear from this time: named missing, or reported
// as anything but ok. Their panes are what they last said, and nothing is asked of them.
function unansweredNodes(result) {
  const names = new Set((result && result.missingNodes) || []);
  for (const [name, status] of Object.entries((result && result.nodes) || {})) {
    if (!status || status.ok !== true) names.add(name);
  }
  return [...names];
}

// A remote session's current model, straight off its node: what claudeSessionFor is
// for a local one. Only Claude so far; a Codex rollout's state needs its first line
// as well as its tail, which the verb does not yet send, so one is refused by name.
async function remoteSessionRead(id, deps = {}) {
  const sessionId = String(id || '');
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new InjectionError(400, 'bad session id');
  const node = sessionNodeOf({ id: sessionId }, deps);
  if (node === daemonNodeName(deps)) return null;
  let location = null;
  try { location = (deps.sessionLocation || accounts.sessionLocation)(sessionId, { root: deps.root || keep.ROOT, env: deps.env || process.env }); } catch {}
  // A session placed on another node whose agent cannot be named is refused by name
  // (remoteDeliveryRefusal), never called unknown: it exists, and it is not here.
  if (!location || location.agent !== 'claude') {
    throw remoteDeliveryRefusal({ id: sessionId, node }, deps, location && location.agent ? location.agent : null);
  }
  const session = { id: sessionId, kind: 'claude', node };
  const account = nodeTranscriptAccount(session, deps);
  const tail = await nodeTranscript(node, session, deps).tail();
  return claudeSessionFromTail(sessionId, tail, {
    root: deps.root || keep.ROOT, accountId: account.id, node, interactiveOnly: deps.interactiveOnly === true,
  });
}

// loadCurrentSession for a session the fleet places on another node: the row a local
// one gets from loadSessionExact (the 48 h window, keep-spawned left out, attention
// marker, name, marks and number), built from the node's tail, plus `node`. Async,
// because the tail is a request; loadCurrentSession itself is unchanged, and still
// answers "no session" for such an id to every synchronous caller.
async function loadRemoteSession(id, deps = {}) {
  const session = await remoteSessionRead(id, deps);
  if (!session) return null;
  const root = deps.root || keep.ROOT;
  const now = Date.now();
  if (!(now - Number(session.mtime) <= SESSION_WINDOW_MS)) throw new InjectionError(404, 'no session');
  if (spawnedRecently(root, session.id, now)) throw new InjectionError(404, 'no session');
  attachClaudeMarker(session, path.join(root, '.keep', 'attention'), now, Number(session.mtime), true);
  sessionNames.apply([session], { root });
  sessionMarks.apply([session], { root });
  sessionNumbers.assign([session], { root, readOnly: true });
  return session;
}

// The session a send acts on: loadCurrentSession here, loadRemoteSession for one on
// another node. A single-node install never takes the second branch.
async function loadSessionForAction(id, deps = {}) {
  if (hostNodeNames(deps).length > 1 && /^[A-Za-z0-9_-]+$/.test(String(id || ''))
      && sessionNodeOf({ id: String(id) }, deps) !== daemonNodeName(deps)) {
    return loadRemoteSession(id, deps);
  }
  return loadCurrentSession(id);
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

function readClaudeSettingsModel(file = claudeSettingsPath()) {
  try {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
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

function repairClaudeSettingsModel(expected, expectedPresent = Boolean(expected), file = claudeSettingsPath()) {
  const expectedModel = typeof expected === 'string' ? expected : '';
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

// The model settings.json held before an in-flight compaction swapped it, for a caller
// that will name it on the command line rather than let the agent read the file. The
// compaction records it before typing /model and keeps it until the file is put back,
// so it is what an agent starting now should run on.
//
// Only an in-flight compaction answers. Every other holder of the model key — a typed
// /model, an interrupted compaction's restore — is in the middle of deciding what
// settings.json says, and reading it mid-decision is exactly what the key is there to
// prevent: the file still holds the old model, or a restore's transient one, and naming
// that would start the agent on a model about to stop being the right one.
//
// '' also covers a swap that recorded no model at all, which means the agent's own
// default: no command line can name that, so the caller must keep waiting for the key.
function compactionSwappedModel(deps = {}) {
  const swap = deps.inFlightCompactSwap !== undefined ? deps.inFlightCompactSwap : inFlightSwap;
  if (!swap || !swap.settingsModelPresent) return '';
  const model = typeof swap.settingsModelBefore === 'string' ? swap.settingsModelBefore : '';
  return keep.LAUNCH_MODEL_RE.test(model) ? model : '';
}

// The model the daemon's own compaction switch types. A full id, never the bare `opus`
// alias the setting used to default to: `/model opus` resolves against settings nobody
// records, is echoed back only as a display label, and a handoff reading the transcript
// afterwards cannot reproduce it — it refused "Current Claude model cannot be reproduced
// safely" on exactly that row. The legacy alias value is read as the default id, so a
// daemon still configured with `KEEP_COMPACT_VIA_MODEL=opus` types the id too; any other
// value, full id or not, is typed as configured.
//
// The default is "the latest Opus", not a pinned release: the newest `claude-opus-*` id a
// transcript under the same Claude account has reported (`message.model` is always the
// full id). Every turn scan offers its model to `noteSeenModel` with the account's config
// dir, and the newest Opus per account is kept in .keep/latest-opus.json, outside the
// compact directory whose stamps are swept after a week. Keying by account means an id
// one account runs (a preview, a staggered rollout, a proxy's own ids) is never typed in
// another. The floor is only a lower bound — what types before that account has run a
// newer Opus — never a pin.
const COMPACT_VIA_FLOOR_MODEL = 'claude-opus-5-5';

// [major, minor] for a bare `claude-opus-<major>[-<minor>]` release id, with or without a
// window suffix; null for anything else, including a date-suffixed snapshot.
function opusModelVersion(model) {
  const match = /^claude-opus-(\d{1,3})(?:-(\d{1,3}))?(?:\[1m\])?$/i.exec(String(model || '').trim());
  return match ? [Number(match[1]), Number(match[2] || 0)] : null;
}

function newerOpus(a, b) {
  const va = opusModelVersion(a);
  const vb = opusModelVersion(b);
  if (!vb) return false;
  if (!va) return true;
  return vb[0] > va[0] || (vb[0] === va[0] && vb[1] > va[1]);
}

function latestOpusModel(models = [], floor = COMPACT_VIA_FLOOR_MODEL) {
  let best = floor;
  for (const raw of models || []) {
    const model = String(raw || '').trim().replace(/\[1m\]$/i, '').toLowerCase();
    if (newerOpus(best, model)) best = model;
  }
  return best;
}

function latestOpusFile() {
  return path.join(keep.ROOT, '.keep', 'latest-opus.json');
}

// The Claude config dir a transcript (<dir>/projects/<project>/<id>.jsonl) or a
// settings.json (<dir>/settings.json) belongs to; '' when the path has neither shape.
function claudeConfigDirOf(file) {
  if (!file) return '';
  const resolved = path.resolve(String(file));
  if (path.basename(resolved) === 'settings.json') return path.dirname(resolved);
  const projects = path.dirname(path.dirname(resolved));
  return path.basename(projects) === 'projects' && resolved.endsWith('.jsonl') ? path.dirname(projects) : '';
}

// { <config dir>: model }, read once per file and then kept in memory; `noteSeenModel`
// updates both.
const latestOpusSeen = new Map();

function readLatestOpusSeen(file = latestOpusFile()) {
  if (!latestOpusSeen.has(file)) {
    const byAccount = {};
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [dir, entry] of Object.entries(value && value.accounts || {})) {
        if (opusModelVersion(entry && entry.model)) byAccount[dir] = String(entry.model).toLowerCase();
      }
    } catch {}
    latestOpusSeen.set(file, byAccount);
  }
  return latestOpusSeen.get(file);
}

// Called with every model a turn scan reads. Writes only when an account runs a newer
// Opus, which is once per release, so the scan path costs a string compare.
function noteSeenModel(model, configDir, file = latestOpusFile()) {
  const candidate = String(model || '').trim().replace(/\[1m\]$/i, '').toLowerCase();
  if (!configDir || !opusModelVersion(candidate)) return;
  const byAccount = readLatestOpusSeen(file);
  if (!newerOpus(byAccount[configDir] || '', candidate)) return;
  byAccount[configDir] = candidate;
  const at = new Date().toISOString();
  const accounts = Object.fromEntries(Object.entries(byAccount).map(([dir, seen]) => [dir, { model: seen, at }]));
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify({ accounts }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    try { fs.unlinkSync(temp); } catch {}
  }
}

// The account a Claude session runs under, read off its own transcript path — the same
// derivation `noteSeenModel` is keyed by. Not the settings file: most compaction paths
// pass none and would fall back to the default account's.
function sessionClaudeConfigDir(session, deps = {}) {
  if (!session || session.kind !== 'claude') return '';
  try { return claudeConfigDirOf((deps.transcriptFileForSession || transcriptFileForSession)(session)); }
  catch { return ''; }
}

// `configDir` names the account the switch will be typed in; without one only the floor
// is safe. `seen` replaces the recorded models (tests).
function compactViaModel({ configDir = '', seen, file } = {}) {
  const value = envString('KEEP_COMPACT_VIA_MODEL', 'opus');
  if (value.toLowerCase() !== 'opus') return value;
  return latestOpusModel(seen !== undefined ? seen : [configDir ? readLatestOpusSeen(file)[configDir] : '']);
}

function compactSwapPlan(session, opts) {
  const viaSetting = String(opts && opts.via || '').trim();
  if (!viaSetting || viaSetting.toLowerCase() === 'off' || !session || session.kind !== 'claude') return null;
  const originalModel = String(session.model || '').trim();
  if (!originalModel) return null;
  const modelLower = originalModel.toLowerCase();
  if (compactModelBase(originalModel).includes(compactModelBase(viaSetting))) return null;
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
  // A session on a 1M window compacts on the fallback's 1M window too: its context can be
  // far past what the 200k variant accepts, and the summary request would be refused. The
  // window comes from the same place the restore's does. Only a full id takes the suffix;
  // an alias (or a configured value already naming a window) is typed as configured.
  const via = /\[1m\]$/i.test(restoreModel) && /^claude-/i.test(viaSetting) && !/\[1m\]$/i.test(viaSetting)
    ? `${viaSetting}[1m]` : viaSetting;
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

const MODEL_SWITCH_STATUS = /(?:^|[^A-Za-z])(?:Set model to|Switched to) ([^\n]*)/;

function modelSwitchFamily(command) {
  const argument = String(command || '').replace(/^\s*\/model\s+/i, '').toLowerCase();
  return ['opus', 'sonnet', 'haiku', 'fable'].find((candidate) => argument.includes(candidate)) || '';
}

function modelSwitchStatusNames(line, family) {
  const status = String(line || '').match(MODEL_SWITCH_STATUS);
  if (!status) return false;
  if (!family) return true;
  return new RegExp(family, 'i').test(status[1]);
}

function modelSwitchConfirmed(screen, command) {
  const family = modelSwitchFamily(command);
  // Match only below this command's final echo: the screen tail can retain an
  // earlier successful switch to the same family.
  return linesAfterLastEcho(screen, command).some((line) => modelSwitchStatusNames(line, family));
}

// The reading above anchors on the command's echo, and the echo has only ever been seen on
// a /model that completed without a dialog. For one Keep answered itself, the anchor is the
// answer instead: the model the dialog offered is now named by a status line that was not
// on the screen when Enter was pressed. Without this a Claude Code that renders no echo
// after the dialog would leave the swap record unresolved — which blocks delivery to the
// session and re-types the restore every ten minutes for a day — on a switch that in fact
// happened.
//
// The offered model rather than the family, and the head of the status rather than
// anywhere in it, because neither half of the novelty test is airtight on its own: the
// screen read is anchored to the pane's last non-blank row (renderScreen in bin/host.js),
// so collapsing a dialog taller than the input box pulls rows back in at the top that were
// pushed out when it opened, and those rows are "new". `Switched to branch 'wt/opus-fix'`
// is an ordinary transcript row that the family reading alone would call a switch to Opus.
function modelSwitchSettled(screen, offeredModel, screenWhenAnswered) {
  const offered = normalizedText(offeredModel).toLowerCase();
  if (!offered) return false;
  const answered = new Set(String(screenWhenAnswered || '').split(/\r?\n/).map(normalizedText));
  return String(screen || '').split(/\r?\n/).map(normalizedText).some((line) => {
    if (answered.has(line)) return false;
    const status = line.match(MODEL_SWITCH_STATUS);
    return Boolean(status) && status[1].toLowerCase().startsWith(offered);
  });
}

// A session that entered a worktree with Claude Code's EnterWorktree tool does not leave
// on a typed /exit: the exit is intercepted by a modal asking whether to keep or remove
// the worktree, and the pane parks there until someone answers. Restart's wait answers
// it, but only for the option that destroys nothing, and only while the modal is the live
// UI — see bin/claude-prompts.js for what "live" costs and why a block is matched rather
// than the viewport.
function worktreeExitPromptKeepsWorktree(screenText) {
  return claudePrompts.answerable(claudePrompts.recognize(screenText));
}

// Any "Switch model?" text anywhere on the screen, live or retained. Neither reader of this
// spends it on a key it would be wrong about: the restore leg presses Escape, which closes
// a live dialog and does nothing at a prompt, and the wait only logs that a dialog it will
// not answer is up. The reading that decides an Enter is modelSwitchDialogOffer.
function modelSwitchDialogVisible(screen) {
  const lines = String(screen || '').split(/\r?\n/).map(normalizedText);
  return claudePrompts.showsDialog('model-switch', lines.join('\n'));
}

// The model a dialog Keep may press Enter on is offering, for the command it typed, or ''.
// The offered model is the answer's own anchor afterwards — see modelSwitchSettled.
//
// This cannot be anchored to that command's echo the way modelSwitchConfirmed is: Claude
// Code takes the typed /model off the screen when it puts the confirmation up, and echoes
// it into the transcript only once the switch completes, so while the dialog is open there
// is no echo anywhere on the screen. Every compaction model swap on this machine waited out
// its timeout below an echo that was not there, and not one was ever accepted.
//
// The dialog itself is the anchor instead, read the strict way, because this decides a
// keystroke. recognize()'s `live` refuses a copy retained above anything that would take
// the Enter, and the table below refuses a dialog whose Enter would mean something other
// than the switch Keep asked for: a bare `Esc to cancel` footer (which is some other
// affordance — see bin/claude-prompts.js), "No, go back" under the cursor, an option list
// Claude Code has since grown a third entry on, or an offer to switch to a model nobody
// asked for. The screens each of those reads are under bin/fixtures/claude-prompts/.
// Claude Code draws this dialog with no footer at all, so only a footer that is there has
// to offer the Enter.
function modelSwitchDialogOffer(screen, command) {
  const match = claudePrompts.recognize(screen);
  if (!match || !match.live || match.kind !== 'model-switch') return '';
  if (match.footer !== null && !/Enter to confirm/i.test(match.footer || '')) return '';
  const options = match.options || [];
  if (options.length !== 2) return '';
  const [yes] = options;
  if (!yes.highlighted) return '';
  const offer = String(yes.text || '').match(/^Yes, switch to\s+(.+)$/i);
  if (!offer) return '';
  // Unlike modelSwitchConfirmed, which only reads: with no family there is nothing left
  // tying this dialog to Keep's own command, and a keystroke needs that.
  const family = modelSwitchFamily(command);
  if (!family || !new RegExp(family, 'i').test(offer[1])) return '';
  return normalizedText(offer[1]);
}

function modelSwitchDialogAnswerable(screen, command) {
  return Boolean(modelSwitchDialogOffer(screen, command));
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
  // The record is this machine's promise to put its own settings.json back. It is
  // never written for a session elsewhere, where neither the swap nor the restore
  // would be ours to make.
  refuseRemoteCompaction(session);
  const file = path.join(dir, `${sessionId}.swap.json`);
  const record = {
    sessionId,
    originalModel: plan.originalModel,
    restoreCommand: plan.restoreCommand,
    switchModel: String(plan.switchCommand || '').replace(/^\s*\/model\s+/i, ''),
    settingsModelBefore: plan.settingsModelBefore,
    settingsModelPresent: plan.settingsModelPresent,
    ...(plan.settingsFile ? { settingsFile: plan.settingsFile, accountId: plan.accountId } : {}),
    at,
    // Every Enter the daemon sends for this swap's commands (see noteCompactDaemonTyped).
    daemonTyped: [],
  };
  writeCompactSwapRecord(file, record);
  return file;
}

function compactSwapSettingsFile(record, deps = {}) {
  if (!record.settingsFile) return claudeSettingsPath(); // Legacy records used the daemon profile.
  if (!record.accountId || !path.isAbsolute(record.settingsFile)) return null;
  const account = (deps.accountById || accounts.get)(record.accountId, deps.env || process.env);
  if (!account || account.agent !== 'claude' || !account.configDir
      || path.resolve(record.settingsFile) !== path.join(path.resolve(account.configDir), 'settings.json')) return null;
  return record.settingsFile;
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

function pendingCompactRestoreFile(sessionId, deps = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId || ''))) return null;
  const dir = deps.dir || deps.autoCompactDir || path.join(deps.root || keep.ROOT, '.keep', 'compact');
  const file = path.join(dir, `${sessionId}.swap.json`);
  return fs.existsSync(file) ? file : null;
}

// A restore deferred for a rate limit (see deferCompactRestore) is a settled state, not a
// transaction in flight: the session is running on the compaction model on purpose until
// the spent model's window resets, and nothing Keep types is due before then. Blocking
// delivery for that long wedged session #213 for a day on a Fable window that was not
// coming back. Every other record still blocks — one mid-flight, one whose last restore
// failed for any other reason, and one that cannot be read — because the guard exists so
// a message never lands on a swapped model in the middle of the daemon's own typing.
// A deferred restore that comes due is typed under the injection lock like any other.
function compactRestoreDeferred(record) {
  return Boolean(record && typeof record === 'object' && record.restoreDeferredReason
    && Number.isFinite(Number(record.restoreDeferredUntil)) && Number(record.restoreDeferredUntil) > 0);
}

function compactRestoreBlocking(sessionId, deps = {}) {
  const file = pendingCompactRestoreFile(sessionId, deps);
  if (!file) return null;
  try {
    if (compactRestoreDeferred(JSON.parse(fs.readFileSync(file, 'utf8')))) return null;
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
  }
  return file;
}

function assertCompactRestoreSettled(sessionId, deps = {}) {
  if (compactRestoreBlocking(sessionId, deps)) {
    throw new InjectionError(409, 'model restore is pending; message was not delivered');
  }
}

// A minute or two past the reset the usage source reported, so the first attempt does
// not land on the boundary itself and spend a retry on a window still closing.
const COMPACT_RESTORE_RESET_GRACE_MS = 2 * 60e3;

// Why a restore is being put off, and until when. With a reset time — the model-exhausted
// decision's, or the account snapshot's for the restore model — the restore waits for it;
// without one it backs off on its own clock, doubling per consecutive deferral
// (KEEP_COMPACT_RESTORE_BACKOFF_MIN, default 60, capped at
// KEEP_COMPACT_RESTORE_BACKOFF_MAX_MIN, default 360), so a Fable week with no reset on
// record is retried a handful of times a day instead of every ten minutes.
function compactRestoreDeferral(record, { reason, resetAt, now }) {
  const count = Math.max(0, Number(record && record.restoreDeferrals) || 0);
  const base = envNumber('KEEP_COMPACT_RESTORE_BACKOFF_MIN', 60) * 60e3;
  const cap = Math.max(base, envNumber('KEEP_COMPACT_RESTORE_BACKOFF_MAX_MIN', 360) * 60e3);
  const reset = Number.isFinite(resetAt) && resetAt > now ? resetAt : null;
  return {
    restoreDeferredReason: reason,
    restoreDeferredAt: now,
    restoreDeferredUntil: reset != null ? reset + COMPACT_RESTORE_RESET_GRACE_MS : now + Math.min(cap, base * 2 ** count),
    restoreDeferrals: count + 1,
    // What the record's 24h expiry counts from. Kept apart from the blocking state above,
    // which an attempt clears while it types: an attempt that then fails for some other
    // reason must not fall back to the swap's own age and expire a days-old deferral.
    restoreExpiryFrom: Math.max(Number(record && record.restoreExpiryFrom) || 0,
      reset != null ? reset + COMPACT_RESTORE_RESET_GRACE_MS : now + Math.min(cap, base * 2 ** count)),
    ...(reset != null ? { restoreResetAt: reset } : {}),
  };
}

function withoutCompactRestoreDeferral(record) {
  const next = { ...record };
  for (const key of ['restoreDeferredReason', 'restoreDeferredAt', 'restoreDeferredUntil', 'restoreResetAt']) delete next[key];
  return next;
}

function deferCompactRestore(file, deferral) {
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('swap record does not contain a JSON object');
  const next = { ...record, ...compactRestoreDeferral(record, deferral) };
  writeCompactSwapRecord(file, next);
  return next;
}

// The restore's own /model came back refused for a rate limit: Claude Code prints the API
// error under the command's echo. Only below that echo — an older refusal retained higher
// up the screen says nothing about this attempt.
function compactRestoreRateLimited(screen, command) {
  return linesAfterLastEcho(screen, command).some((line) =>
    /\bAPI\s+error\b[^\n]*\b429\b|\brate_limit_error\b|You've (?:hit|reached) your\b[^\n]*\blimit/i.test(line));
}

// A /model somebody chose by hand after the swap, or null. The swap record's restore is the
// daemon undoing its own switch; once a person has picked a model since, the restore would
// overwrite that choice — every ten minutes, in the incident that motivated this — and
// repairing settings.json to the pre-swap value would undo the saved default they just set.
//
// Read from the transcript records stamped at or after `since` (the record's `at`, written
// just before the switch was typed, unless the caller names another moment). A refused
// /model changed nothing (modelSwitchApiError). A /model row is the daemon's own only when
// the daemon really typed that command then: its text is the swap's switch or restore, and
// its timestamp falls within COMPACT_DAEMON_ROW_WINDOW_MS of a moment the swap record says
// the daemon sent that Enter (daemonTyped, journalled by noteCompactDaemonTyped). Matching
// by text alone let a person's pick of exactly the restore id pass as a restore the daemon
// never typed. A record from before the journal existed has only its switch to go by, in
// the minute after `at`. Any other confirmed /model is a person's, and so is one whose row
// carries no timestamp once the window has begun — leaving settings.json alone is the
// conservative outcome. A genuine assistant record on a model that is neither the swap's
// nor the restore's is the same evidence by another path.
//
// Read against some other session's transcript (a shared settings file's other sessions),
// the daemon rows are that session's own pending record's: options.daemon names that
// record, or null when the session has none, and then every confirmed /model counts.
// options.assistant false drops the assistant-record evidence, which only means something
// in the swapped session itself.
const COMPACT_SWAP_CHOICE_SCAN_BYTES = 8 * 1024 * 1024;
const COMPACT_DAEMON_ROW_WINDOW_MS = 15e3;
const COMPACT_LEGACY_SWITCH_WINDOW_MS = 60e3;

// A matcher for one scan of a transcript: true for a /model row that is the daemon's own.
// Each journalled Enter ({ at, model }) accounts for exactly one row — the first row of
// exactly that id at or after its moment, within COMPACT_DAEMON_ROW_WINDOW_MS — and every
// other row counts, however close: a person picking the other id seconds after a refused
// restore, or the same id right after the daemon's own row, is a person. A second of slack
// before `at` only for the host's and Claude Code's clocks being read a hair apart.
// A record from before the journal accounts for one switch row in the minute after `at`.
function compactDaemonRowMatcher(daemon) {
  if (!daemon) return () => false;
  const switchModel = String(daemon.switchModel || '').trim().toLowerCase();
  const entries = Array.isArray(daemon.daemonTyped)
    ? daemon.daemonTyped.map((entry) => ({ at: Number(entry && entry.at), model: String(entry && entry.model || '').trim().toLowerCase() }))
      .filter((entry) => Number.isFinite(entry.at) && entry.model)
    : [{ at: Number(daemon.at), model: switchModel, windowMs: COMPACT_LEGACY_SWITCH_WINDOW_MS, slackMs: 0 }]
      .filter((entry) => Number.isFinite(entry.at) && entry.model);
  const used = new Set();
  return (args, stamp) => {
    if (!Number.isFinite(stamp)) return false;
    const text = String(args || '').trim().toLowerCase();
    const index = entries.findIndex((entry, i) => !used.has(i) && entry.model === text
      && stamp >= entry.at - (entry.slackMs ?? 1000) && stamp - entry.at <= (entry.windowMs ?? COMPACT_DAEMON_ROW_WINDOW_MS));
    if (index === -1) return false;
    used.add(index);
    return true;
  };
}

// Journals the Enter the daemon is sending for one of this swap's commands — the moment and
// the exact id — so the transcript row it produces can be told from a person typing the
// same text. Read from the file rather than any caller's copy, which may carry state the
// file deliberately lost. The hooks go straight into typeAndSubmit: the moment is taken in
// beforeEnterKey, the Enter's own, and a refused Enter takes the entry back.
function noteCompactDaemonTyped(file, entry, remove = false) {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record)) return;
    const typed = (Array.isArray(record.daemonTyped) ? record.daemonTyped : [])
      .filter((value) => !(value && value.at === entry.at && value.model === entry.model));
    writeCompactSwapRecord(file, { ...record, daemonTyped: remove ? typed : [...typed, entry] });
  } catch {}
}

function compactDaemonEnterHooks(file, command, clock = Date.now, onChange = () => {}) {
  let entry = null;
  return {
    beforeEnterKey: () => {
      entry = { at: clock(), model: String(command || '').replace(/^\s*\/model\s+/i, '').trim() };
      noteCompactDaemonTyped(file, entry);
      onChange(entry, false);
    },
    enterKeyDropped: () => {
      if (!entry) return;
      noteCompactDaemonTyped(file, entry, true);
      onChange(entry, true);
      entry = null;
    },
  };
}

function compactSwapUserModelChoice(record, file, options = {}) {
  const at = Number.isFinite(options.since) ? options.since : Number(record && record.at);
  if (!file || !Number.isFinite(at) || at <= 0) return null;
  const daemon = options.daemon === undefined ? record : options.daemon;
  let text;
  let truncated = false;
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - envNumber('KEEP_COMPACT_SWAP_CHOICE_SCAN_BYTES', COMPACT_SWAP_CHOICE_SCAN_BYTES));
    truncated = start > 0;
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      if (fs.readSync(fd, buffer, 0, buffer.length, start) !== buffer.length) return null;
      text = buffer.toString('utf8');
    } finally { fs.closeSync(fd); }
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch { return null; }
  const lines = text.split(/\r?\n/);
  const switchModel = daemon ? String(daemon.switchModel || '').trim() : '';
  const restoreModel = daemon ? String(daemon.restoreCommand || '').replace(/^\s*\/model\s+/i, '').trim() : '';
  const daemonRow = compactDaemonRowMatcher(daemon);
  // The daemon's entries are consumed by their own rows from the swap (or its earliest
  // journalled Enter) onward, even rows older than `since`: an entry whose row lies before
  // `since` must not be left over to absorb a later hand row. `since` only decides which
  // of the remaining rows are reported.
  const journal = daemon && Array.isArray(daemon.daemonTyped) ? daemon.daemonTyped.map((entry) => Number(entry && entry.at)) : [];
  const scanFrom = Math.min(at, ...(daemon ? [Number(daemon.at)] : []), ...journal.map((value) => value - 1000)
    .filter(Number.isFinite));
  // A window that starts after the scan's start point cannot say nothing happened in the
  // part it did not read: the choice may be exactly the row that fell out of the tail. That
  // is "cannot prove there was no hand choice", and every caller treats it as one — no
  // restore typed, no settings.json written.
  if (truncated) {
    const first = lines.map((line) => { try { return Date.parse(JSON.parse(line).timestamp || ''); } catch { return NaN; } })
      .find(Number.isFinite);
    if (!(first <= scanFrom)) {
      return { model: '', incomplete: true, reason: 'the transcript is too long to verify no hand choice since the swap' };
    }
  }
  let inWindow = false;
  for (let i = 0; i < lines.length; i += 1) {
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    const stamp = Date.parse(row && row.timestamp || '');
    let report = true;
    if (Number.isFinite(stamp)) {
      if (stamp < scanFrom) continue;
      report = stamp >= at;
      if (report) inWindow = true;
    } else if (!inWindow) continue;
    const args = localModelSwitchArgs(row);
    if (args != null) {
      // Exact ids, window included: `/model claude-fable-5-1` against a pending
      // `claude-fable-5-1[1m]` restore is a person dropping the 1M window. Matched before
      // the outcome is read: a daemon /model the API refused is still the row its Enter
      // produced, and its entry is spent on it rather than on the person's retry.
      if (daemonRow(args, stamp)) continue;
      if (!report) continue;
      const outcome = resolveLocalModelSwitch(args, lines.slice(i + 1, i + 1 + 64));
      if (outcome.failed) continue;
      // Confirmed, or at least not refused by the harness: "Kept model as …" is no change.
      if (outcome.model === '<unknown>' && !outcome.label) continue;
      return { model: args || outcome.label, reason: `/model ${args || outcome.label} was chosen after the swap` };
    }
    const model = options.assistant === false || !report ? null : genuineAssistantModel(row);
    if (model && model !== '<unknown>'
        && !(switchModel && compactModelContainsFamily(model, switchModel))
        && !(restoreModel && compactModelBase(model) === compactModelBase(restoreModel))
        && !(!switchModel && compactModelContainsFamily(model, 'opus'))) {
      return { model, reason: `the session moved to ${model} after the swap` };
    }
  }
  return null;
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
  const press = deps.pressTargetKey || pressTargetKey;
  const paneState = deps.livePaneState || livePaneState;
  const deadline = now() + envNumber('KEEP_MODEL_SWITCH_TIMEOUT_MS', 15000);
  let acceptedDialog = false;
  let acceptedScreen = '';
  let acceptedOffer = '';
  let reportedUnanswerable = false;
  let reportedUnguardable = false;
  let reportedUnsnapshotted = false;
  let reportedTooLate = false;
  while (now() < deadline) {
    await sleep(Math.min(500, deadline - now()));
    try {
      const screen = await read(target, 30, false);
      if (modelSwitchConfirmed(screen, command)) return true;
      // Only once the dialog Keep answered no longer reads as one to press Enter at:
      // while it is still up, the Enter was dropped or ignored, and a status line
      // drifting into view says nothing about it.
      if (acceptedDialog && !modelSwitchDialogAnswerable(screen, command)
          && modelSwitchSettled(screen, acceptedOffer, acceptedScreen)) return true;
      if (acceptedDialog) continue;
      const offer = modelSwitchDialogOffer(screen, command);
      if (!offer) {
        // The dialog is on screen but is not one to press Enter at. This is the reading
        // that went wrong silently for six scheduler runs, so it says so once per wait.
        if (!reportedUnanswerable && modelSwitchDialogVisible(screen)) {
          reportedUnanswerable = true;
          process.stderr.write(`keep serve: a model-switch dialog for ${sid} is not answerable by Keep (${command})\n`);
        }
        continue;
      }
      // Two host round trips and a keystroke follow, and the deadline is otherwise only
      // read at the top of the loop. A key with no poll left to see it land reports the
      // switch unconfirmed whatever it does, and on the forward leg it puts Keep's Enter
      // and the restore leg's Escape at the same dialog at once. Declining says so: a
      // timeout under a second declines every iteration, and an operator reading nothing
      // but "model switch unconfirmed" is how this signature stayed invisible for six runs.
      if (deadline - now() < 500) {
        if (!reportedTooLate) {
          reportedTooLate = true;
          process.stderr.write(`keep serve: not answering the model-switch dialog for ${sid}: too little of the wait is left to see the switch land\n`);
        }
        continue;
      }
      // Taken before the evidence the key is spent on, so the host refuses the Enter
      // outright if anything reached the pane since — rather than submitting a message a
      // viewer started typing at the dialog meanwhile.
      const pane = await paneState((target && target.pane) || 'unknown', deps);
      if (!pane) {
        if (!reportedUnguardable) {
          reportedUnguardable = true;
          process.stderr.write(`keep serve: not answering the model-switch dialog for ${sid}: the pane's input count is unreadable\n`);
        }
        continue;
      }
      // The whole visible pane, not the 30 rows the dialog was found in: opening a dialog
      // taller than the input box pushes rows off the top of a short read, and collapsing
      // it gives them back, where modelSwitchSettled would read them as new. Read after
      // the count above, so unlike the screen that found the dialog this one is inside
      // what the guard covers — which is why it, and not that screen, has to still show
      // the dialog, and why a read that fails here costs the Enter rather than falling
      // back to a snapshot already known to be too small to tell a new row from an old one.
      const snapshot = await read(target, 200, false).catch(() => null);
      if (!snapshot || modelSwitchDialogOffer(snapshot, command) !== offer) {
        if (!reportedUnsnapshotted) {
          reportedUnsnapshotted = true;
          process.stderr.write(`keep serve: not answering the model-switch dialog for ${sid}: ${snapshot
            ? 'it is no longer the dialog the input count was taken at'
            : 'the whole pane could not be read back'}\n`);
        }
        continue;
      }
      // Both round trips above are spent by now. Nothing is gained by a key the wait has
      // already run out of time to watch.
      if (now() >= deadline) continue;
      // Mark first: even an ambiguous transport failure must not cause a second Enter.
      acceptedDialog = true;
      acceptedOffer = offer;
      acceptedScreen = snapshot;
      try {
        await press(target, 'Enter', deps, { expectedInputCount: pane.inputCount, expectedPid: pane.pid });
        process.stderr.write(`keep serve: accepted the model-switch dialog for ${sid} (${command})\n`);
      } catch (error) {
        process.stderr.write(`keep serve: the model-switch dialog for ${sid} was not answered: ${String(error && error.message || error)}\n`);
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

// The pane's input counter, and under it the proof that the session is idle with an empty
// (or suggestion-only) Claude box, for a restore the pending-swap pass is about to type.
// A deferred restore can come due hours after the compaction, when a person is far more
// likely to be at the keyboard, and typeAndSubmit alone only looks for its own text
// somewhere on screen before pressing Enter.
//
// The count is read first and everything else is read after it. That order is the whole
// point: a turn someone submits after the count is in the count, so the host refuses
// every key the restore sends (typeAndSubmit's inputBaseline); a turn submitted before it
// is on the screen this then reads — "esc to interrupt", a live dialog, an unfinished
// local command — and refuses here. The suggestion probe's own two keys are conditional on
// the same count (probeInputGuard), so nothing on this path is ever typed unguarded, and
// they are the only keys allowed between the two counts.
//
// null means "not now, and nothing was typed": a local command still finishing.
async function compactRestoreInputBaseline(target, deps = {}, current = null) {
  const read = deps.readScreen || ((t, lines, scrollback) => readScreen(t, lines, scrollback, deps));
  const paneState = deps.livePaneState || livePaneState;
  let capabilities;
  try { capabilities = await (deps.hostRequest || hostRequest)('hello', {}, deps); } catch {}
  if (!capabilities || capabilities.guardedInput !== true) {
    throw new InjectionError(409, 'terminal host reload required before a model restore can be typed');
  }
  const pane = (target && target.pane) || 'unknown';
  const before = await paneState(pane, deps);
  if (!before) throw new InjectionError(409, 'pane input activity could not be verified before the restore');
  // A submit the host accepted just before this count is inside it, and may not have
  // rendered as a running turn yet. So the counter must have been quiet for a moment —
  // the host's own lastInputAt when it reports one — and the idle screen is read only
  // after a settle window measured from the count either way, which gives a submit that
  // landed at the last instant time to draw its "esc to interrupt".
  const quietMs = envNumber('KEEP_COMPACT_RESTORE_INPUT_QUIET_MS', 2000);
  const lastInputAt = Date.parse(before.lastInputAt || '');
  if (Number.isFinite(lastInputAt) && (deps.now || Date.now)() - lastInputAt < quietMs) return null;
  await (deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
    envNumber('KEEP_COMPACT_RESTORE_SETTLE_MS', 1500));
  const settled = await paneState(pane, deps);
  if (!settled || settled.pid !== before.pid || settled.inputCount !== before.inputCount) return null;
  // The whole viewport (not scrollback): in a tall pane the spinner can sit far above the
  // last 30 rows.
  const screen = await read(target, null, false);
  if (current && current.localCommandPending) {
    const complete = /^\/compact(?:\s|$)/.test(current.localCommandPending)
      ? compactScreenConfirmed(screen, current.localCommandPending)
      : modelSwitchConfirmed(screen, current.localCommandPending)
        && Boolean(promptLine(screen))
        && !/esc to (?:interrupt|cancel)/i.test(screen);
    if (!complete) return null;
  }
  if (CLAUDE_TURN_OR_DIALOG_RE.test(screen) || claudePrompts.recognize(screen)?.live) {
    throw new InjectionError(409, 'the session is busy or showing a dialog; the restore was not typed', { screenTail: screenTail(screen) });
  }
  const proof = await probeSuggestion(target, screen, { ...deps, probeInputGuard: { pid: before.pid, inputCount: before.inputCount } });
  const after = await paneState(pane, deps);
  const own = proof && proof.kind === 'suggestion' ? 2 : 0;
  if (!after || after.pid !== before.pid || after.inputCount !== before.inputCount + own) {
    throw new InjectionError(409, 'input arrived while the prompt was checked; the restore was not typed');
  }
  return { pid: after.pid, inputCount: after.inputCount };
}

async function sweepPendingCompactSwaps(deps = {}) {
  const summary = { checked: 0, restored: 0, dropped: 0, skipped: 0, repairedSettings: 0 };
  if (sweepInFlight) return summary;
  sweepInFlight = true;
  const now = deps.now || Date.now;
  const dir = deps.dir || autoCompactDir();
  const scan = deps.scanSessions || scanSessions;
  const resolve = deps.resolveSessionTarget || resolveSessionTarget;
  const read = deps.readScreen || ((t, lines, scrollback) => readScreen(t, lines, scrollback, deps));
  const submit = deps.typeAndSubmit || typeAndSubmit;
  const waitForSwitch = deps.waitForModelSwitch || waitForModelSwitch;
  const lock = deps.withInjectionLock || withInjectionLock;
  const readSettings = deps.readClaudeSettingsModel || readClaudeSettingsModel;
  const repairSettings = deps.repairClaudeSettingsModel || repairClaudeSettingsModel;
  try {
    const allRecords = pendingCompactSwaps(dir);
    summary.checked = allRecords.length;
    if (!allRecords.length) return summary;
    let sessions;
    let scanError = null;
    try { sessions = scan(); } catch (e) { scanError = e; }
    // A model someone picked by hand after the swap retires the record before anything
    // below can act on it: no restore typed over the choice (see compactSwapUserModelChoice).
    const retired = new Set();
    const transcriptFor = deps.transcriptFileForSession || transcriptFileForSession;
    const sessionById = (id) => (sessions || []).find((session) => session.id === id);
    const userChoice = (record, session) => {
      try { return session ? (deps.compactSwapUserModelChoice || compactSwapUserModelChoice)(record, transcriptFor(session)) : null; }
      catch { return null; }
    };
    // The one retire path, for the first look and the one under the lock alike.
    const retireOnUserChoice = (record, session = sessionById(record.sessionId)) => {
      if (retired.has(record.file)) return true;
      if (scanError || record.error || codexCompact.isCodexCompactSwap(record)) return false;
      const choice = userChoice(record, session);
      if (!choice) return false;
      const sid = (sessionRef(record.sessionId) || 'unknown');
      try { fs.unlinkSync(record.file); } catch (e) {
        if (e.code !== 'ENOENT') {
          process.stderr.write(`keep serve: could not retire model restore record for ${sid}: ${e.message}\n`);
          return true; // Still a choice: nothing may be typed or repaired over it.
        }
      }
      retired.add(record.file);
      summary.dropped += 1;
      process.stderr.write(`keep serve: retired model restore record for ${sid}: ${choice.reason}; not restoring "${String(record.restoreCommand || '').replace(/^\s*\/model\s+/i, '')}" over it\n`);
      return true;
    };
    for (const record of allRecords) retireOnUserChoice(record);
    // A record whose session runs on another node is not this machine's to act on:
    // the settings.json it would repair is this machine's, and the restore would be
    // typed into a pane elsewhere. Left exactly where it is, and counted as skipped
    // so the health row says the sweep did not settle it.
    const elsewhere = new Set(allRecords.filter((record) => !retired.has(record.file)
      && remoteSession({ id: record.sessionId }, deps)).map((record) => record.file));
    for (const record of allRecords) {
      if (!elsewhere.has(record.file)) continue;
      summary.skipped += 1;
      process.stderr.write(`keep serve: model restore for claude session ${sessionRef(record.sessionId) || 'unknown'} belongs to node ${sessionNodeOf({ id: record.sessionId }, deps)}\n`);
    }
    const records = allRecords.filter((record) => !retired.has(record.file) && !elsewhere.has(record.file));
    const finished = new Set(); // Restored this pass: their records are gone.
    const repairedSettingsRecords = new Set();
    const noteSettingsRepair = (record, repaired) => {
      if (!repaired.changed || repairedSettingsRecords.has(record.file)) return;
      repairedSettingsRecords.add(record.file);
      summary.repairedSettings += 1;
    };
    // The only way this pass writes settings.json back to a record's pre-swap model:
    // compare-and-swap on the value this record's own daemon /model wrote (the id it
    // typed, exactly), and only while nothing else could own the file — no other pending
    // restore shares it, and no session (any live one whose transcript moved since the
    // swap) shows a model chosen by hand since. settings.json is an account's saved
    // default, so a hand choice anywhere is the person's, and it is left as-is. Returns
    // why not, or ''.
    const settingsRepairRefusal = (record, settingsFile, current) => {
      const typed = String(record.switchModel || '').trim().toLowerCase();
      if (!typed || !current.ok || String(current.value || '').trim().toLowerCase() !== typed) {
        return 'it no longer holds the model this compaction typed';
      }
      if (records.some((other) => other !== record && !retired.has(other.file) && !finished.has(other.file) && !other.error
          && !codexCompact.isCodexCompactSwap(other) && compactSwapSettingsFile(other, deps) === settingsFile)) {
        return 'another pending model restore shares it';
      }
      return handChoiceSince(record, compactSwapRecordAt(record), sessions) ? 'a model was chosen by hand since the swap' : '';
    };
    // Whether any live session (in `sessionList`, whose transcript moved since `since`)
    // shows a model chosen by hand since then. The record's own session exempts only its
    // own daemon rows (its switch and restores); any other session exempts only its own
    // pending record's rows, or none, and every other confirmed /model there counts.
    const handChoiceSince = (record, since, sessionList) => (sessionList || []).some((session) => {
      if (!session || session.kind !== 'claude' || Number(session.mtime) < since) return false;
      const own = session.id === record.sessionId ? undefined
        : records.find((other) => other.sessionId === session.id && !other.error && !codexCompact.isCodexCompactSwap(other)) || null;
      try {
        return Boolean((deps.compactSwapUserModelChoice || compactSwapUserModelChoice)(record, transcriptFor(session),
          own === undefined ? { since } : { since, daemon: own, assistant: false }));
      } catch { return false; }
    });
    const leftAsIs = (record, why) => process.stderr.write(`keep serve: left settings.json as-is for ${sessionRef(record.sessionId) || 'unknown'}'s model restore: ${why}\n`);
    // Crash recovery: a compaction that died between its switch and its repair left the
    // account's default on the compaction model. Repaired here even when its session
    // cannot take a restore this tick — under the rule above.
    const settingsRecords = new Map();
    for (const record of records.filter((item) => !item.error && !codexCompact.isCodexCompactSwap(item))
      .sort((a, b) => compactSwapRecordAt(b) - compactSwapRecordAt(a))) {
      const file = compactSwapSettingsFile(record, deps);
      if (file && !settingsRecords.has(file)) settingsRecords.set(file, record);
    }
    for (const [settingsFile, settingsRecord] of settingsRecords) if (!inFlightSwap) {
      const sid = (sessionRef(settingsRecord.sessionId) || 'unknown');
      try {
        await lock(async () => {
          const settings = readSettings(settingsFile);
          const via = String(settingsRecord.switchModel || envString('KEEP_COMPACT_VIA_MODEL', 'opus')).trim();
          if (!settings.ok || !compactModelContainsFamily(settings.value, via)) return;
          const refusal = settingsRepairRefusal(settingsRecord, settingsFile, settings);
          if (refusal) { leftAsIs(settingsRecord, refusal); return; }
          const repaired = repairSettings(settingsRecord.settingsModelBefore, settingsRecord.settingsModelPresent, settingsFile);
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
    if (scanError) {
      const e = scanError;
      for (const record of records) {
        summary.skipped += 1;
        const sid = (sessionRef(record.sessionId) || 'unknown');
        process.stderr.write(`keep serve: MODEL RESTORE UNCONFIRMED for claude session ${sid}: ${String(e && e.message || e)}\n`);
      }
      return summary;
    }
    const byId = new Map((sessions || []).map((session) => [session.id, session]));
    for (const record of records) {
      if (retired.has(record.file)) continue;
      const sid = (sessionRef(record.sessionId) || 'unknown');
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
      // A deferred restore ages from when it comes due, not from the swap: a Fable week
      // can be days away, and expiring the record first would strand the session on the
      // compaction model for good.
      const ageFrom = Math.max(compactSwapRecordAt(record), Number(record.restoreExpiryFrom) || 0,
        compactRestoreDeferred(record) ? Number(record.restoreDeferredUntil) : 0);
      const stale = now() - ageFrom > envNumber('KEEP_COMPACT_SWAP_MAX_AGE_MIN', 24 * 60) * 60e3;
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
      const settingsFile = compactSwapSettingsFile(record, deps);
      if (!settingsFile) {
        summary.skipped += 1;
        process.stderr.write(`keep serve: MODEL RESTORE UNCONFIRMED for claude session ${sid}: swap settings account is unavailable\n`);
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
      if (compactRestoreDeferred(record) && now() < Number(record.restoreDeferredUntil)) {
        summary.skipped += 1;
        continue;
      }
      if (Number.isFinite(Number(record.probeRefusedAt))
          && now() - Number(record.probeRefusedAt) < envNumber('KEEP_COMPACT_RESTORE_RETRY_MIN', 10) * 60e3) {
        summary.skipped += 1;
        continue;
      }

      try {
        const restored = await lock(async () => {
          const current = scan().find((candidate) => candidate.id === record.sessionId);
          if (compactRestoreBusy(current)) return null;
          const target = claimInjectionTarget(await resolve(current, null, deps));
          // The idle proof and the input count it is bound to (see
          // compactRestoreInputBaseline). It replaces precheckSessionTarget here, whose
          // suggestion probe types unguarded: every key this pass sends is conditional
          // on this count, from the probe's comma to the restore's Enter.
          let inputBaseline;
          try {
            inputBaseline = await (deps.compactRestoreInputBaseline || compactRestoreInputBaseline)(target, deps, current);
          } catch (error) {
            // Someone typed between the probe's comma and its guarded Backspace: their key
            // survived and so did our comma, and the refusal above is already logged with
            // the screen. The box now holds a draft, which every later probe refuses
            // without leaving anything behind — but give the person the retry interval to
            // deal with it instead of probing at their draft every tick.
            if (/probe keystroke could not be undone/.test(String(error && error.message || ''))) {
              record.probeRefusedAt = now();
              try { writeCompactSwapRecord(record.file, record); } catch {}
              process.stderr.write(`keep serve: a probe comma may be left in ${sid}'s input box after input arrived mid-probe; the restore waits ${envNumber('KEEP_COMPACT_RESTORE_RETRY_MIN', 10)} minutes\n`);
            }
            throw error;
          }
          if (inputBaseline === null) return null;
          const before = readSettings(settingsFile);
          const beforeAt = now();
          const restoreModel = String(record.restoreCommand || '').replace(/^\s*\/model\s+/i, '').trim();
          // Only after the restore was actually typed (a pass that retired or refused first
          // wrote nothing), and only to undo exactly what the restore's own /model wrote —
          // Claude Code saves it as the default. What goes back is what the file held just
          // before: a person's value stays theirs, and the compaction's own value goes back
          // to the pre-swap model only under settingsRepairRefusal's rule. When that
          // pre-swap model is the restore model itself, the restore already put it back.
          let typedRestore = false;
          const repair = () => {
            if (!typedRestore || !before.ok) return;
            const after = readSettings(settingsFile);
            if (!after.ok || String(after.value || '').toLowerCase() !== restoreModel.toLowerCase()) return;
            let value = before.value;
            let present = before.present;
            const refusal = settingsRepairRefusal(record, settingsFile, before);
            if (!refusal) {
              value = record.settingsModelBefore;
              present = record.settingsModelPresent;
            } else if (String(before.value || '').toLowerCase() === String(record.switchModel || '').toLowerCase()) {
              leftAsIs(record, refusal);
            }
            if (present && String(value || '').toLowerCase() === restoreModel.toLowerCase()) return;
            // The snapshot is from before the restore was typed. A person who picked a model
            // anywhere since — the restore's own model included — saved it as the default,
            // and writing the snapshot back would undo that. Read fresh: the pass's session
            // list predates the restore. A second of slack for rows stamped as it was taken.
            let live = null;
            try { live = scan(); } catch {}
            if (!live) { leftAsIs(record, 'live sessions could not be read to check for a hand-picked model'); return; }
            if (handChoiceSince(record, beforeAt - 1000, live)) {
              leftAsIs(record, 'a model was chosen by hand while the restore was typed');
              return;
            }
            const repaired = repairSettings(value, present, settingsFile);
            noteSettingsRepair(record, repaired);
            if (repaired.error) {
              process.stderr.write(`keep serve: could not restore settings.json model after an interrupted compaction of ${sid}: ${repaired.error}\n`);
            }
          };
          try {
            record.at = compactSwapRecordAt(record); // Preserve mtime-based age across retry writes.
            record.lastAttemptAt = now();
            writeCompactSwapRecord(record.file, record);
            // Anyone who started typing since the baseline — while settings were read and
            // the record written — moved the count, and the host refuses the restore's keys.
            // Again under the lock, at the last moment: a /model someone typed since the
            // pass's first look is as much a choice as one typed before it.
            if (retireOnUserChoice(record, current)) return { retired: true };
            // Only now, with the restore about to be typed, is the attempt a transaction in
            // flight again: until it is confirmed or re-deferred below, the record blocks
            // delivery like any other. A probe that refused above typed nothing, and a
            // deferred record it refused on stays deferred.
            if (compactRestoreDeferred(record)) writeCompactSwapRecord(record.file, withoutCompactRestoreDeferral(record));
            typedRestore = true;
            try {
              await submit(target, record.restoreCommand, claudeTypedTextVisible, {
                ...deps, inputBaseline, discardDraftOnAbort: true, draftKind: 'claude',
                ...compactDaemonEnterHooks(record.file, record.restoreCommand, now, (entry, removed) => {
                  const typed = Array.isArray(record.daemonTyped) ? record.daemonTyped : [];
                  record.daemonTyped = removed ? typed.filter((value) => value !== entry) : [...typed, entry];
                }),
              });
            } catch (error) {
              if (error && error.nothingTyped) {
                // The host refused the very first key: nothing reached the pane, so this
                // was a "not now", not an attempt. Nothing to repair in settings.json, and
                // a deferred record gets its deferral back so delivery is not blocked.
                typedRestore = false;
                writeCompactSwapRecord(record.file, record);
                return null;
              }
              throw error;
            }
            if (await waitForSwitch(target, record.restoreCommand, sid, deps)) return true;
            try {
              if (compactRestoreRateLimited(await read(target, 30, false), record.restoreCommand)) return 'rate-limited';
            } catch {}
            return false;
          } finally {
            repair();
          }
        }, { session: record.sessionId, model: true });
        if (restored === null) {
          summary.skipped += 1;
          continue;
        }
        if (restored && restored.retired) continue;
        if (restored === 'rate-limited') {
          const restoreModel = String(record.restoreCommand || '').replace(/^\s*\/model\s+/i, '').trim();
          const usageNow = deps.usageSnapshot !== undefined ? deps.usageSnapshot : readUsageCache();
          const resetAt = compactModelResetAt({ model: restoreModel, accountId: record.accountId, rateLimit: session && session.rateLimit },
            { usage: usageNow, now: now() });
          const deferred = deferCompactRestore(record.file, { reason: 'rate-limited', resetAt, now: now() });
          summary.skipped += 1;
          process.stderr.write(`keep serve: MODEL RESTORE DEFERRED for claude session ${sid} (rate-limited): "${record.restoreCommand}" was refused for a rate limit; next attempt ${new Date(deferred.restoreDeferredUntil).toISOString()}\n`);
          continue;
        }
        if (!restored) throw new Error(`expected "${record.restoreCommand}"`);
        fs.unlinkSync(record.file);
        finished.add(record.file);
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
// Every part of a compaction is local: the instruction is typed into a pane, the
// transcript it reads is this machine's, and the model it switches to is written
// into this machine's settings.json and put back from a record kept here. A session
// on another node is refused at the door, before any lock or gate is taken.
function refuseRemoteCompaction(sessionOrPane, deps = {}) {
  const node = sessionNodeOf(sessionOrPane, deps);
  if (node !== daemonNodeName(deps)) {
    throw new InjectionError(409, `compaction is not available for a session on ${node}`);
  }
}

async function compactSession(session, target, instruction, deps = {}) {
  refuseRemoteCompaction(isHostTarget(target) ? target.pane : session, deps);
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
  // Again here, not only in compactSession: the Codex cold fallback calls straight
  // into this, and so does anything else holding a transaction directly.
  refuseRemoteCompaction(isHostTarget(target) ? target.pane : session, deps);
  const sid = (sessionRef(session && session.id) || 'unknown');
  process.stderr.write(`keep serve: compacting ${session && session.kind || 'unknown'} session ${sid}\n`);
  const dir = deps.dir || autoCompactDir();
  const lastTurn = (deps.sessionLastTurn || sessionLastTurn)(session);
  const policy = deps.compactionPolicy || null;
  const pendingRecordValue = session?.kind === 'claude' ? readPendingCompactSwap(session && session.id, dir) : null;
  const pendingRecord = codexCompact.isCodexCompactSwap(pendingRecordValue) ? null : pendingRecordValue;
  const configuredVia = compactViaModel({ configDir: sessionClaudeConfigDir(session, deps) });
  const settingsFile = deps.compactSettingsFile || claudeSettingsPath();
  if (pendingRecord && compactSwapSettingsFile(pendingRecord, deps) !== settingsFile) {
    return { compacted: false, restoreUnconfirmed: true,
      reason: 'pending model restore belongs to a different or unavailable account' };
  }
  const settingsSnapshot = session && session.kind === 'claude' && policy?.path !== 'warm-current'
    ? (deps.readClaudeSettingsModel || readClaudeSettingsModel)(settingsFile) : { ok: true, present: false, value: '' };
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
      settingsFile: compactSwapSettingsFile(pendingRecord, deps),
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
    const records = pendingCompactSwaps(dir).filter((record) => !record.error && !codexCompact.isCodexCompactSwap(record)
      && compactSwapSettingsFile(record, deps) === settingsFile)
      .sort((a, b) => compactSwapRecordAt(b) - compactSwapRecordAt(a));
    if (records.length && [configuredVia, records[0].switchModel].some((value) =>
      value && compactModelBase(settingsModel) === compactModelBase(value))) {
      settingsModel = records[0].settingsModelBefore;
      settingsPresent = records[0].settingsModelPresent;
      process.stderr.write(`keep serve: using the pre-swap settings.json model from pending restore record ${(sessionRef(records[0].sessionId) || 'unknown')}\n`);
    }
    // A pane launched with `keep open --model` knows its model exactly; the transcript's
    // last-turn model is the fallback for sessions launched any other way.
    const launchModel = await (deps.hostPaneModel || hostPaneModel)(target, deps);
    swap = compactSwapPlan({ ...session, model: launchModel || lastTurn.model }, {
      via: configuredVia,
      families: deps.compactFamilies || compactModelFamilies(),
      settingsModel,
      settingsPresent,
    });
    via = swap ? String(swap.switchCommand).replace(/^\s*\/model\s+/i, '') : null;
    if (swap && deps.compactSettingsFile && deps.compactAccountId) {
      Object.assign(swap, { settingsFile, accountId: deps.compactAccountId });
    }
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
        await (deps.typeAndSubmit || typeAndSubmit)(target, swap.switchCommand, claudeTypedTextVisible, { ...deps,
          ...compactDaemonEnterHooks(pendingSwapFile, swap.switchCommand) });
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
      let deferral = null;
      const readRestoreScreen = deps.readScreen || ((t, lines, scrollback) => readScreen(t, lines, scrollback, deps));
      try {
        const screen = await readRestoreScreen(target, 30, false);
        if (modelSwitchDialogVisible(screen)) {
          await pressTargetKey(target, 'Escape', deps);
          process.stderr.write(`keep serve: dismissed a stale model-switch dialog for ${sid}\n`);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch {}
      if (policy?.reason === 'model-exhausted') {
        // The fallback was taken because the original model's window is spent, so a
        // restore typed now is answered with a 429 — and the record it leaves behind used
        // to block the session and re-type the same refused /model every ten minutes. Put
        // the restore off until that window resets instead; the session keeps running on
        // the compaction model meanwhile, which is the only model it had anyway.
        deferral = { reason: 'model-exhausted', resetAt: Number(policy.exhaustedResetAt) || null };
      } else {
        try {
          await (deps.typeAndSubmit || typeAndSubmit)(target, swap.restoreCommand, claudeTypedTextVisible, { ...deps,
            ...compactDaemonEnterHooks(pendingSwapFile, swap.restoreCommand) });
          restored = await (deps.waitForModelSwitch || waitForModelSwitch)(target, swap.restoreCommand, sid, deps);
        } catch {}
        if (!restored) {
          // The model was not known to be spent, but the API refused the /model for a
          // rate limit anyway: same deferral, on the backoff clock since nothing here
          // knows the reset.
          try {
            if (compactRestoreRateLimited(await readRestoreScreen(target, 30, false), swap.restoreCommand)) {
              deferral = { reason: 'rate-limited', resetAt: null };
            }
          } catch {}
        }
      }
      const repaired = (deps.repairClaudeSettingsModel || repairClaudeSettingsModel)(
        swap.settingsModelBefore, swap.settingsModelPresent, swap.settingsFile || settingsFile);
      if (repaired.changed) {
        process.stderr.write(`keep serve: restored settings.json model to "${swap.settingsModelBefore}" after compaction of ${sid}\n`);
      }
      if (repaired.error) {
        process.stderr.write(`keep serve: could not restore settings.json model after compaction of ${sid}: ${repaired.error}\n`);
      }
      let deferred = null;
      if (!restored && deferral) {
        try { deferred = deferCompactRestore(pendingSwapFile, { ...deferral, now: Date.now() }); } catch (e) {
          process.stderr.write(`keep serve: could not defer model restore for claude session ${sid}: ${String(e && e.message || e)}\n`);
        }
      }
      if (restored && !repaired.error) {
        restoreConfirmed = true;
        try { fs.unlinkSync(pendingSwapFile); } catch (e) {
          process.stderr.write(`keep serve: could not clear model restore record for claude session ${sid}: ${e.message}\n`);
        }
      } else if (deferred) {
        // Not unconfirmed: the session is deliberately left on the compaction model, and
        // the pending-swap pass types the restore once the deferral comes due.
        restoreConfirmed = true;
        process.stderr.write(`keep serve: MODEL RESTORE DEFERRED for claude session ${sid} (${deferred.restoreDeferredReason}): "${swap.restoreCommand}" is due ${new Date(deferred.restoreDeferredUntil).toISOString()}${deferred.restoreResetAt ? ' (after the model\'s limit resets)' : ' (backoff; no reset time known)'}; the session stays on ${via} until then\n`);
        if (!result) result = { compacted: false, reason: 'model restore deferred', via };
        result.restoreDeferred = true;
        result.restoreDeferredUntil = deferred.restoreDeferredUntil;
      } else {
        process.stderr.write(`keep serve: MODEL RESTORE UNCONFIRMED for claude session ${sid}: expected "${swap.restoreCommand}" and account settings repair — restore it by hand\n`);
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

// One session, read exactly, for an action about to touch it: a compaction, an
// answer, limit-resume, the turn-watcher's last look, a check or unblock delivery,
// an ephemeral close, an area delivery, a Codex swap recovery and sendToSession's
// in-lock load. It used to be scanSessions().find(id): a fresh fleet scan (every
// project directory re-listed, ~24,000 transcripts statted, every recent tail
// parsed) to return one row. loadSessionExact builds the same row from that
// session's own transcript; see it for what the row carries and what it skips.
//
// Parity with the old scan row, which is all these callers ever had: scanSessions
// never ran buildState's host passes (applySessionLiveness, applyHostedExitState,
// backfillHostSessions, addHostSessionState), so neither row carries a pane, a
// host-derived exited or deadMidTurn; `exited` is the transcript's own in both.
// Two scan-only details are left out on purpose: the live-title pass (no caller
// here reads `title`), and the snapshot refresh a scan did as a side effect.
// A keep-spawned run is still "no session" here, as the scan dropped it; so is a
// session recorded on another node, which has no transcript here to read.
function loadCurrentSession(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(id || ''))) throw new InjectionError(400, 'bad session id');
  const session = loadSessionExact(id, { excludeSpawned: true });
  if (!session || !session.kind) throw new InjectionError(404, 'no session');
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
  if (agent === 'pi' || agent == null) {
    const found = (deps.piSessionFor || pi.sessionFor)(sessionId, { root: deps.root || keep.ROOT });
    if (found?.project) return { project: found.project, agent: 'pi' };
  }
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

// The table both this daemon and every node agent read, parsed in one place so the
// two never disagree about what a row means. The daemon node keeps running its own
// `ps`; a node answers for its own machine through the `process` verb.
const processTable = require('./process-table.js');
const { parseProcessTable } = processTable;

// Each node's own last read of its own table, kept apart from this machine's so one
// node's snapshot can never be mistaken for another's — the pids in them are
// unrelated numbers that happen to share a range.
const nodeProcessRowsCaches = new Map();

async function remoteProcessRows(node, deps = {}) {
  let cache = nodeProcessRowsCaches.get(node);
  if (!cache) {
    cache = { value: null, at: 0, pending: null };
    nodeProcessRowsCaches.set(node, cache);
  }
  const now = typeof deps.now === 'function' ? Number(deps.now()) : Number(deps.now ?? Date.now());
  if (cache.value && now - cache.at < PROCESS_ROWS_CACHE_MS) return cache.value;
  if (cache.pending) return cache.pending;
  // The same short cache the local read has, for the same reason: the pane list asks
  // once per refresh, and a fleet must not answer that with a `ps` per node per second.
  cache.pending = hostRequest('process', {}, { ...deps, node }).then((result) => {
    const rows = Array.isArray(result && result.rows) ? result.rows : [];
    cache.value = rows;
    cache.at = typeof deps.now === 'function' ? Number(deps.now()) : Date.now();
    cache.pending = null;
    return rows;
  }, (error) => {
    cache.pending = null;
    throw error;
  });
  return cache.pending;
}

async function agentProcessRows(deps = {}, options = {}) {
  if (typeof deps.psTable === 'string') return parseProcessTable(deps.psTable);
  // A pid only means something on the machine that issued it, so a caller asking
  // about another node's panes is answered by that node's own table.
  const node = options.node || daemonNodeName(deps);
  if (node !== daemonNodeName(deps)) return remoteProcessRows(node, deps);
  const cache = deps.processRowsCache || processRowsCache;
  const now = typeof deps.now === 'function' ? Number(deps.now()) : Number(deps.now ?? Date.now());
  if (cache.value && now - cache.at < PROCESS_ROWS_CACHE_MS) return cache.value;
  if (cache.pending) return cache.pending;
  // A `ps` over every process on a swapping Mac has taken well past five seconds, and
  // the timeout lands as a refused transfer or a session that looks gone. Waiting is
  // cheaper than either.
  cache.pending = (deps.execFile || execFileAsync)(
    'ps', ['-axo', 'pid=,ppid=,tty=,lstart=,etime=,args='],
    { encoding: 'utf8', timeout: 15e3, maxBuffer: 32e6, env: { ...process.env, LC_ALL: 'C' } },
  ).then((result) => {
    const value = parseProcessTable(String(result.stdout || ''));
    cache.value = value;
    cache.at = typeof deps.now === 'function' ? Number(deps.now()) : Date.now();
    cache.pending = null;
    return value;
  }, (error) => {
    cache.pending = null;
    throw error;
  });
  return cache.pending;
}

function verifiedPiBackgroundPids(rows, deps = {}) {
  try {
    const found = (deps.verifiedPiJobPids || require('./pi-jobs').verifiedProcessPids)(rows, {
      root: deps.root || keep.ROOT,
    });
    return found instanceof Set ? found : new Set();
  } catch {
    // Failed verification is deliberately conservative: an unverified Pi process
    // remains eligible for the normal concurrent-resume guard.
    return new Set();
  }
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
    if (row && /(?:^|\/)(?:codex|claude|pi)$/.test(command)) return false;
  }
  return false;
}

// The session a row's own argv names, which is the strongest process-to-session
// identity there is.
function argvSessionId(row) {
  const match = row.agent === 'pi'
    ? /(?:^|\s)--(?:session-id|session)\s+([A-Za-z0-9_-]+)(?=\s|$)/.exec(row.args)
    : row.agent === 'claude'
    ? /(?:^|\s)--(?:resume|session-id)\s+([A-Za-z0-9_-]+)(?=\s|$)/.exec(row.args)
    : /(?:^|\s)(?:\S*\/)?codex\s+(?:--?[A-Za-z0-9-]+(?:=\S*)?\s+)*resume\s+([A-Za-z0-9_-]+)(?=\s|$)/.exec(row.args);
  return match ? match[1] : null;
}

// Whether a `ps` snapshot said nothing about this agent, as opposed to saying it is
// not the agent any more. Only two snapshots say nothing: an empty table, and one
// carrying the process at its own pid and start time with `(claude)` in place of its
// arguments, which is what macOS prints when it could not read argv. Those are
// snapshots to take again.
//
// Deliberately nothing else. A row that describes the process and simply does not name
// this session — a plain `claude`, or a shell where the agent used to be — is positive
// evidence that the process at that pid is no longer the agent, and treating it as an
// unreadable snapshot would retry until it was adopted.
function agentRowUnreadable(rows, identity) {
  if (!Array.isArray(rows) || !rows.length) return true;
  if (!identity) return false;
  const row = rows.find((candidate) => candidate.pid === identity.pid && candidate.pidStart === identity.pidStart);
  return Boolean(row && row.argsUnavailable === true);
}

// A transfer that names no rate limit names the moment it was requested instead, and
// everything that stops a session on its behalf compares a fresh read against it.
//
// Every one of those comparisons is needed, because every one of them is followed by
// more waiting: the restart's own `ps` reads retry for seconds, and closeIdleSession
// then takes its own freshness baseline — a baseline computed after all of that, which
// on its own would accept a turn the person finished in the meantime as simply how the
// session has always been. The wording matches account-handoff's own refusal so a
// queue reads it as blocked wherever it comes from.
function requireNoUserActivityAfter(boundary, latest) {
  if (boundary == null) return;
  const lastUserAt = Number(latest?.lastUserAt);
  if (Number.isFinite(lastUserAt) && lastUserAt > Number(boundary)) {
    throw new InjectionError(409, 'Session was used after the transfer was requested');
  }
}

// The freshest read of one session there is, which is what claudeSessionFor and
// codex.sessionFor give: straight off the transcript, past every state-build cache.
function freshSessionRead(session, deps = {}) {
  try {
    return session.kind === 'claude'
      ? (deps.claudeSessionFor || claudeSessionFor)(session.id)
      : session.kind === 'pi' ? (deps.piSessionFor || pi.sessionFor)(session.id, { root: keep.ROOT })
      : (deps.codexSessionFor || codex.sessionFor)(session.id);
  } catch { return null; }
}

// Every piece of process evidence, pointed at one machine. On the daemon node these
// are the local reads this daemon has always done, untouched. On any other node they
// are that machine's own answers about its own processes and its own files, which is
// the only place either means anything — and they are shaped like the local reads so
// the judgement above them is the same judgement, wherever the pane is.
function nodeEvidence(node, deps = {}) {
  if (node === daemonNodeName(deps)) return deps;
  // Rollout mtimes come back with the paths, because the files are on that machine
  // and this one cannot stat them. Keyed by node as well as path: these readers
  // travel in a deps object that a fan-out will point at other machines, and two
  // nodes can hold rollouts at the same path.
  const mtimes = new Map();
  const key = (where, file) => where + '\u0000' + file;
  // Every reader takes the node it is asked about and answers for that one. The
  // node named here is only the default — the machine whose pane started this —
  // because the same deps object is handed to a fleet listing that asks about each
  // node in turn, and a reader bound to one machine would answer every one of those
  // questions with one machine's processes. That is how a pane on aws1 came to be
  // judged by main's process table.
  const where = (options) => (options && options.node) || node;
  return {
    ...deps,
    agentProcessRows: deps.agentProcessRows
      || ((given, options = {}) => agentProcessRows(given, { node: where(options) })),
    psEnv: deps.psEnv || (async (pids, options = {}) => {
      const result = await hostRequest('process', { pids, env: true }, { ...deps, node: where(options) });
      // A Codex thread id (asked for only with codexEnv) is never a Claude session's.
      return (result.env || []).filter((entry) => !entry.agent || entry.agent === 'claude')
        .map((entry) => `${entry.pid} CLAUDE_CODE_SESSION_ID=${entry.sessionId}`).join('\n');
    }),
    lsof: deps.lsof || (async (pids, options = {}) => {
      const target = where(options);
      const result = await hostRequest('process', { pids, files: true }, { ...deps, node: target });
      const byPid = new Map();
      for (const entry of result.files || []) {
        if (!byPid.has(entry.pid)) byPid.set(entry.pid, []);
        byPid.get(entry.pid).push(entry.path);
        mtimes.set(key(target, entry.path), entry.mtime);
      }
      return [...byPid].flatMap(([pid, files]) => [`p${pid}`, ...files.map((file) => `n${file}`)]).join('\n');
    }),
    statMtime: deps.statMtime || (async (file, options = {}) => {
      const target = where(options);
      const value = mtimes.get(key(target, file));
      if (!Number.isFinite(value)) throw new Error(`no rollout mtime for ${file} on ${target}`);
      return value;
    }),
    // A forced stop re-reads the table after every signal, so this one is never
    // cached, and the kill goes to the machine that issued the pid: the node
    // compares the start time against its own live table and kills in the same step.
    forceRows: deps.forceRows || (async () => {
      const result = await hostRequest('process', {}, { ...deps, node });
      return Array.isArray(result && result.rows) ? result.rows : [];
    }),
    forceSignal: deps.forceSignal || ((pid, name, captured = {}) =>
      hostRequest('signal', {
        pid, pidStart: captured.pidStart, ppid: captured.ppid, args: captured.args, signal: name,
      }, { ...deps, node })),
  };
}

// The node-local half of a launch, run where the pane is: in this process on the
// daemon node, and through the node's own `prepare-launch` anywhere else.
async function prepareLaunchOn(node, options, deps = {}, localDeps = {}) {
  // `remote` is told, not inferred: it decides whether the machine preparing the
  // launch may assume the account is already installed there, and only the caller
  // knows whether this is the daemon node preparing for itself.
  if (node === daemonNodeName(deps)) {
    return require('./launch-prep.js').prepare({ ...options, remote: false }, localDeps);
  }
  // Keep's nodes share one home directory, and accounts.js has already expanded `~`
  // against this one before any path reached here. The node compares it with its own
  // and refuses rather than working on paths that belong to another machine.
  return hostRequest('prepare-launch', { ...options, remote: true, daemonHome: os.homedir() },
    { ...deps, node });
}

// Whether a liveSessionPids answer is strong enough for a guard to act on its
// silence. That map is empty both when nothing is running and when nobody could
// look, and for a guard whose job is to stop a second agent writing one transcript
// those are opposite answers. The process table alone does not find every agent
// either — a fresh Claude TUI is identified by the session id in a child's
// environment, a Codex one by the rollout files it holds open — so a failed read of
// the evidence this agent kind depends on means "not found for want of looking".
//
// Only asked about another node: on this machine these reads are local, and the
// guards that use it have always taken their answer as it comes.
function unverifiedProcesses(live, agent) {
  const report = (live && live.evidence) || {};
  const needed = agent === 'claude' ? report.env : agent === 'codex' ? report.files : 'ok';
  return report.table === 'failed' || !(report.rows > 0) || needed === 'failed';
}

async function liveSessionPids(deps = {}, options = {}) {
  // The machine every read below is about. Named on each one, not bound once, so a
  // deps object shared with a fleet listing cannot answer for the wrong machine.
  const node = options.node || null;
  if (node) deps = nodeEvidence(node, deps);
  const at = node ? { node } : {};
  const live = new Map();
  // What this answer is actually built on. Every read below can fail, and a caller
  // that only ever sees an empty map cannot tell "nothing is running" from "nobody
  // could look" — which for a guard whose job is to stop a second agent writing one
  // transcript are opposite answers. Reported rather than swallowed; whether a gap
  // is fatal is the caller's to decide, and only the caller knows what it needed.
  const evidence = { table: 'ok', rows: 0, env: 'skipped', files: 'skipped' };
  live.evidence = evidence;
  let rows = [];
  try {
    const found = await (deps.agentProcessRows || agentProcessRows)(deps, at);
    if (Array.isArray(found)) rows = found;
    else evidence.table = 'failed';
  } catch { evidence.table = 'failed'; }
  evidence.rows = rows.length;
  const backgroundPiPids = verifiedPiBackgroundPids(rows, deps);
  const interactive = rows.filter((row) => row.interactive && !backgroundPiPids.has(row.pid));
  const interactiveByPid = new Map(interactive.map((row) => [row.pid, row]));

  // Explicit resume argv is the strongest process-to-session identity.
  for (const row of interactive) {
    // A pane switch needs current open-file evidence; launch argv survives /new.
    if (deps.codexRolloutOnly && row.agent === 'codex') continue;
    const named = argvSessionId(row);
    if (named) setLiveSession(live, named, row, 'argv');
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
    evidence.env = 'ok';
    try {
      const pids = [...parentByChild.keys()];
      let output;
      if (typeof deps.psEnv === 'function') output = await deps.psEnv(pids, at);
      else {
        // The same patience agentProcessRows now has: this read is what gives a fresh
        // TUI its session id, and losing it under load loses the whole identity.
        const result = await (deps.execFile || execFileAsync)('ps', ['-E', '-o', 'pid=,args=', '-p', pids.join(',')], {
          encoding: 'utf8', timeout: 15e3, maxBuffer: 32e6, env: { ...process.env, LC_ALL: 'C' },
        });
        output = result.stdout;
      }
      for (const line of String(output || '').split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+.*(?:^|\s)CLAUDE_CODE_SESSION_ID=([A-Za-z0-9_-]+)(?=\s|$)/.exec(line);
        const parent = match && parentByChild.get(Number(match[1]));
        if (parent) setLiveSession(live, match[2], parent, 'child-env');
      }
    } catch (error) { evidence.env = 'failed'; deps.onEvidenceError?.(error); }
  }

  // Codex holds rollout files open. All of them are alive, but only the newest
  // rollout for a TUI is the session that should be restored.
  const codexRows = interactive.filter((row) => row.agent === 'codex');
  if (codexRows.length) {
    evidence.files = 'ok';
    try {
      const pids = codexRows.map((row) => row.pid);
      let output;
      if (typeof deps.lsof === 'function') output = await deps.lsof(pids, at);
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
              ? Number(await deps.statMtime(entry.path, at))
              : fs.statSync(entry.path).mtimeMs;
          } catch {
            // The mtime is what orders one TUI's rollouts; without it this cannot
            // say which conversation is the live one, so the read is incomplete.
            entry.mtime = -Infinity;
            evidence.files = 'failed';
          }
        }
        entries.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
        entries.forEach((entry, index) => setLiveSession(live, entry.id, row, 'rollout', {
          primary: index === 0, rolloutFile: entry.path,
        }));
      }
    } catch (error) { evidence.files = 'failed'; deps.onEvidenceError?.(error); }
  }

  return live;
}

async function resolveSessionTarget(session, targetHint, deps = {}) {
  const listed = await hostPanesForAction(deps);
  if (!Array.isArray(listed.panes)) throw hostPaneVerificationError('Session target', listed, 503);
  const panes = listed.panes;
  if (targetHint?.expectedPane) {
    const expected = nodes.parsePaneRef(String(targetHint.expectedPane));
    if (expected.qualified && (listed.missingNodes || []).includes(expected.node)) {
      throw new InjectionError(503, `cannot verify panes on ${expected.node}; nothing was sent`);
    }
    const selected = panes.find((pane) => pane.id === targetHint.expectedPane);
    if (!selected?.alive || selected.agentAlive === false || selected.meta?.sessionId !== session.id || selected.meta?.agent !== session.kind) {
      throw new InjectionError(409, 'selected pane is no longer a live instance of this session; nothing was sent');
    }
    return { pane: selected.id };
  }
  // With more than one node, the pane that answers for a session is the one on the
  // node its authority record names: another node's pane whose meta carries the same
  // id is not this session's, and typing into it would journal a receipt that node
  // could settle. A single-node install skips this and reads nothing.
  let sessionNode = null;
  let candidates = panes;
  if (hostNodeNames(deps).length > 1) {
    const env = paneRefEnv(deps);
    sessionNode = session.node ? String(session.node) : sessionNodeOf({ id: session.id }, deps);
    candidates = panes.filter((pane) => pane
      && (pane.node || nodes.parsePaneRef(String(pane.id || ''), { env }).node) === sessionNode);
  }
  const hosted = sessionHostPane(candidates, session.id);
  const liveHosted = Boolean(hosted && hosted.alive && hosted.agentAlive !== false);
  if (sessionNode && !liveHosted && !(listed.missingNodes || []).includes(sessionNode)) {
    const elsewhere = sessionHostPane(panes, session.id);
    if (elsewhere && elsewhere.alive && elsewhere.agentAlive !== false) {
      throw new InjectionError(409, `session ${session.id} is recorded on ${sessionNode} but its live pane ${elsewhere.id} is not; nothing was sent`);
    }
  }
  if (liveHosted) {
    // A pane carried over from a node that has gone quiet is the last thing it said,
    // not a pane this daemon can act on now.
    if (hosted.node && (listed.missingNodes || []).includes(hosted.node)) {
      throw new InjectionError(503, `cannot verify panes on ${hosted.node}; nothing was sent`);
    }
    return { pane: hosted.id };
  }
  // Silence from a node is not an answer about its panes. Say which node could not
  // be reached rather than report a session that lives there as having no pane.
  if ((listed.missingNodes || []).length) {
    throw new InjectionError(503, `cannot verify panes on ${listed.missingNodes.join(', ')}`);
  }
  throw new InjectionError(404, `${session.id} has no live host pane`, { notLive: true });
}

function resolveSessionId(value, deps = {}) {
  const wanted = String(value || '');
  // `#12` / `12` / `s12` name a session by its console number, unless a session
  // id is literally that string: an exact id always wins.
  const number = sessionNumbers.parseNumber(wanted);
  if (!number && !/^[A-Za-z0-9_-]+$/.test(wanted)) throw new InjectionError(400, 'bad session id');
  // A phone polls this every couple of seconds; a snapshot under 5 s old is fresh enough
  // to resolve an id and spares the event loop a full transcript scan per poll.
  const scanned = deps.scanSessions ? deps.scanSessions()
    : (Date.now() - sessionSnapshotAt < 5000 && sessionSnapshot.length ? sessionSnapshot : scanSessions());
  const exact = scanned.find((candidate) => candidate.id === wanted);
  if (number && !exact) {
    const numbered = scanned.filter((candidate) => candidate.num === number);
    if (numbered.length !== 1) throw new InjectionError(400, 'bad session id');
    return numbered[0];
  }
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
  if (!validPaneRef(paneId)) throw new InjectionError(400, 'bad pane id');
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
    let hello;
    try { hello = await hostRequest('hello', {}, innerDeps); }
    catch (error) {
      if (!hostRequestTimedOut(error)) throw error;
      throw new InjectionError(503, `terminal host timed out while checking history support: ${error.message}`);
    }
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

// A move proves its source stopped before the target starts, and the pane exiting is
// not yet that proof: children of the agent that still carry the session in their
// environment (an MCP server, a subagent) can outlive the pane by a moment. Only a
// move waits them out, reading the table every 500 ms for up to 15 s; the single read
// after this, unchanged, still decides. A restart on its own node never comes here.
async function waitForMovedSessionProcesses(session, remotePane, deps, sleep) {
  const started = Date.now();
  const polls = Math.ceil((deps.moveStopWaitMs ?? 15000) / 500);
  for (let i = 0; ; i++) {
    const live = await liveSessionPids(deps);
    // An unreadable remote table proves nothing either way; the read after this refuses it.
    if (remotePane && unverifiedProcesses(live, session.kind)) return;
    if (!live.has(session.id)) {
      process.stderr.write(`keep serve: move stop: no agent process owns ${session.id} ${Date.now() - started}ms after its pane exited (${i + 1} reads)\n`);
      return;
    }
    if (i + 1 >= polls) {
      process.stderr.write(`keep serve: move stop: an agent process still owns ${session.id} ${Date.now() - started}ms after its pane exited (${i + 1} reads)\n`);
      return;
    }
    await sleep(500);
  }
}

// Restarting a session means judging a process and then stopping it, and every piece
// of evidence for both — the `ps` table, liveSessionPids, the kill — belongs to the
// machine the pane is on. It is pointed at that machine here, once, and everything
// below reads it through `deps`. On the daemon node that is the local read this
// daemon has always done, unchanged.
async function restartSession(body, deps = {}) {
  const paneNode = sessionNodeOf(String(body.pane || ''), deps);
  const remotePane = paneNode !== daemonNodeName(deps);
  deps = nodeEvidence(paneNode, deps);
  const host = (type, params) => hostRequest(type, params, deps);
  // An explicit force discards uncertain background-job evidence only; the turn,
  // tool and process identity checks below stay exactly as strict.
  const force = body.force === true;
  // Owner asked for this himself (a console click, keep handoff --force): nothing is
  // typed into the session, so no idle, draft, dialog, ledger or helper proof is asked
  // for. forceStopThenResume signals the captured process tree directly, and the same
  // resume below starts the conversation again. The rate-limit handoff queue never
  // sets this; automatic work keeps every proof.
  const ownerForce = deps.ownerForce === true;
  let exitInputStarted = false;
  const transient = (reason) => body.mode === 'idle' && !exitInputStarted
    ? new (require('./session-restart').RestartDeferred)(reason) : new InjectionError(409, reason);
  // The resumed agent reads settings.json's model at startup, so a restart also holds
  // the model key: it never starts an agent while a compaction has swapped the file.
  // A busy key does not fail the restart — it runs again naming the model the compaction
  // swapped out, so the resumed agent never reads the file. Not every session can be
  // named that way, and the second attempt gives the 429 back before it closes anything.
  // `entered` keeps that attempt for a key this restart never got, never for a 429
  // raised once the body was underway and the session may already be gone.
  let entered = false;
  const attempt = (inheritedModel) => (deps.withInjectionLock || withInjectionLock)(async () => {
    entered = true;
    let capabilities;
    try { capabilities = await host('hello'); }
    catch (error) {
      if (!hostRequestTimedOut(error)) throw error;
      throw new Error(`Terminal host timed out while checking restart support: ${error.message}`, { cause: error });
    }
    if (!capabilities.replaceExited) throw Error('Terminal host must be refreshed before restarting sessions');
    const pane = (await host('get', { pane: body.pane })).pane;
    const session = (await (deps.buildState || buildState)({ hostPanes: [pane] })).sessions.find((s) => s.id === body.sessionId);
    if (session?.kind === 'pi') {
      throw new InjectionError(409, 'Pi in-place restart is unavailable; close the pane and use keep open to resume');
    }
    // An account handoff names the limit its transfer exists for. Its own
    // observation is minutes old by now — a login-shell auth preflight alone can
    // take 45 seconds — so this is the last look, inside the lock, on the session
    // this restart is about to close. The wording matches account-handoff's own
    // refusal so a queue reads it as blocked either way.
    if (deps.expectedRateLimitAt != null
        && String(session?.rateLimit?.at ?? '') !== String(deps.expectedRateLimitAt)) {
      throw new InjectionError(409, 'Session no longer carries the account limit this transfer was requested for');
    }
    // And the same look for a transfer that names no limit: it named the moment it was
    // asked for instead, and work the person did since then is them taking the session
    // back. Not the last one, though — see requireNoUserActivityAfter.
    requireNoUserActivityAfter(deps.expectedNoUserActivityAfter, session);
    // A session the API cut off mid-turn never ends its turn on its own, so the
    // terminal-limit path supplies the ended turn. Its ledger may also carry a
    // settled `transcript-replaced` history-gap, which is not live work and must
    // not defeat this the way any real unknown job still does.
    const terminalLimit = deps.allowTerminalRateLimit === true && session?.kind === 'claude' && session.rateLimit && !session.pendingBackground
      && !session.toolRunning && !session.pendingQuestion && !session.pendingPlan
      && !require('./session-restart').blockingUnknownJobs(session).length;
    const restartSessionState = terminalLimit ? { ...session, endedTurn: true, rateLimit: null } : session;
    // Forced or not, there has to be a live session in its own pane to stop.
    const reason = ownerForce
      ? (!session || !pane?.alive || pane.meta?.sessionId !== session.id ? 'Session is not live in its original pane' : null)
      : require('./session-restart').refusal(restartSessionState, pane, body.mode === 'idle', { force });
    if (ownerForce && reason) throw new InjectionError(409, reason);
    if (pane.pid !== body.pid) throw new InjectionError(409, 'Session process changed');
    if (reason) {
      if (/^Waiting |^Pause session-local scheduled jobs/.test(reason)) throw transient(reason);
      throw new InjectionError(409, reason);
    }
    const cwd = deps.resumeCwd == null ? session.project || pane.cwd
      : validatedCodexResumeCwd(session.kind, deps.resumeCwd);
    // The directory is on the machine the pane is on; this one cannot see another
    // node's filesystem, and the spawn there fails for itself if it is gone.
    if (!cwd || (!remotePane && !fs.statSync(cwd).isDirectory())) throw Error('Session directory is unavailable');
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
    // Which account the process being inspected belongs to, which is not the account
    // it is about to resume under: an account handoff passes the target as
    // resumeAccount while the live agent, and the MCP servers it declared, are still
    // the source's. Staged authority is read at its source for the same reason, and
    // an unresolved account is left unresolved rather than guessed at.
    let liveAccount = null;
    try {
      liveAccount = accounts.forSession(session.id, session.kind,
        { root: deps.root || keep.ROOT, env: deps.env || process.env, allowStagedSource: true });
    } catch { liveAccount = null; }
    if (!liveAccount && session.accountId) liveAccount = accounts.get(session.accountId, deps.env || process.env);
    // This attempt gave up the model key on the promise of naming the model itself, which
    // only describes a Claude agent on the built-in profile: Codex resumes on a model and
    // reasoning effort from config.toml, and a managed profile reads its own settings.json.
    // Hand the 429 back here, before anything is closed, rather than part way through.
    if (inheritedModel && !(session.kind === 'claude' && account.builtIn === true)) throw injectionBusyError();
    // On another node the account's config directory is that machine's, so its
    // shared setup is prepared there, through the node's own prepare-launch, and
    // the argument vector carries a placeholder until it answers.
    let resumeMcpConfig = deps.resumeMcpConfig || null;
    if (!remotePane && session.kind === 'claude' && account.managed) {
      try { resumeMcpConfig ||= (deps.ensureSharedMemory || require('./account-setup').ensureSharedMemory)(account, cwd).mcpConfig; }
      catch (error) { throw new InjectionError(409, `account shared setup is unavailable: ${error.message}`); }
    }
    const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // One `ps` snapshot is the whole evidence for who this agent is, and on a swapping
    // Mac a snapshot can come back without a usable row for a process that is running
    // and unchanged — empty, or with the arguments replaced by `(claude)`. Reading it
    // again costs a couple of seconds; refusing costs the transfer.
    const readAgentRows = () => (deps.agentProcessRows || agentProcessRows)(deps);
    const identityFrom = async (rows) => (await liveSessionPids({ ...deps, agentProcessRows: async () => rows })).get(session.id);
    let originalRows = await readAgentRows();
    let originalIdentity = await identityFrom(originalRows);
    for (let i = 0; i < 3 && !originalIdentity?.primary; i++) {
      await sleep(750);
      originalRows = await readAgentRows();
      originalIdentity = await identityFrom(originalRows);
    }
    if (!originalIdentity?.primary) throw Error('Original agent process identity is unverified');
    // A caller that has already inspected this agent says which process it inspected.
    // Patience above is only worth having if it cannot end up adopting a different one:
    // a session relaunched between the preflight and this read is primary and verifiable
    // and is still not the process the transfer was cleared against.
    const expectedIdentity = deps.expectedAgentIdentity;
    if (expectedIdentity && (originalIdentity.pid !== expectedIdentity.pid
        || originalIdentity.pidStart !== expectedIdentity.pidStart)) {
      throw Error('Agent process identity changed during restart');
    }
    const originalArgs = originalRows.find((p) => p.pid === originalIdentity.pid)?.args || '';
    // Starts the conversation again in the stopped pane, on `account`. An account handoff
    // wraps the host's replace-exited to copy the conversation first.
    const resume = async (stoppedPane) => {
      // Preserve an explicit permission bypass only when the old process used it.
      // Do not apply the fresh-session defaults to a previously restricted agent.
      const bypass = session.kind === 'codex' ? '--dangerously-bypass-approvals-and-sandbox' : '--dangerously-skip-permissions';
      const flags = originalArgs.split(/\s+/).includes(bypass) ? [bypass] : [];
      const reviewerSpec = reviewerResumeSpec(session, pane, deps);
      const requestedResumeModel = deps.resumeModel || pane.meta?.model;
      const launchModel = typeof requestedResumeModel === 'string' && keep.LAUNCH_MODEL_RE.test(requestedResumeModel) ? requestedResumeModel : '';
      const resumeModel = launchModel || (session.kind === 'claude' ? inheritedModel : '');
      const modelArgs = resumeModel ? (session.kind === 'codex' ? ['-m', resumeModel] : ['--model', resumeModel]) : [];
      const mcpArgs = session.kind !== 'claude' ? []
        : remotePane ? [{ insert: 'mcpConfig' }] : resumeMcpConfig ? ['--mcp-config', resumeMcpConfig] : [];
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
      // The shell word carries a node binary and a launcher path, so for a pane on
      // another machine it is built there. The daemon node's own path is untouched:
      // its shared setup was already prepared above, and preparing it twice is not
      // what this restart is for.
      const command = remotePane
        ? (await prepareLaunchOn(paneNode, {
          agent: session.kind,
          account: { id: account.id, agent: account.agent, configDir: account.configDir,
            builtIn: account.builtIn === true, managed: account.managed === true },
          cwd, bypass: false, argv, pi: null,
        }, deps)).command
        : require('./agent-launcher').profileCommand(argv, account);
      const result = await host('replace-exited', { paneId: pane.id, expectedPid: pane.pid, sessionId: stoppedPane.meta?.sessionId,
        cmd: '/bin/zsh', args: ['-lic', `exec ${command}`], cwd,
        env: require('./agent-launcher').launcherEnv({ ...repairEnvFor({ sessionId: session.id }, deps), ...reviewerSpec.env }),
        cols: pane.cols, rows: pane.rows, meta: { ...adoptedPaneMeta(pane.meta), agent: session.kind, sessionId: session.id,
          accountId: account.id, accountLabel: account.label, restartedAt: Date.now() } });
      await (deps.waitForHostAgent || waitForHostAgent)({ pane: pane.id }, session.kind, deps);
      return { ok: true, sessionId: session.id, pane: result.pane.id, pid: result.pane.pid,
        createdAt: result.pane.createdAt };
    };
    // A session move (bin/session-move.js) stops the session here and resumes it on
    // another machine: `afterStop` is handed the stopped pane in place of the resume.
    if (ownerForce) return forceStopThenResume({ session, pane, identity: originalIdentity, resume: deps.afterStop || resume }, deps);
    const ledger = require('./restart-ledger');
    const file = session.kind === 'codex' ? (deps.codexRolloutFile || codex.rolloutFileFor)(session.id)
      : (deps.claudeRolloutFile || findSessionFile)(session.id);
    // Claude child transcripts are looked for across the whole profile that holds the
    // transcript being walked, not just beside it: a session that changed cwd writes
    // later subagent files under the worktree's own project dir. That profile is the
    // one the live agent runs on, which during an account handoff is not `account` --
    // that is the account the session is about to resume under. The transcript's own
    // `<configDir>/projects/<project>/<sid>.jsonl` shape names it exactly; liveAccount
    // is the fallback when the path is not in that shape.
    const claudeProfileDir = typeof file === 'string' && path.basename(path.dirname(path.dirname(file))) === 'projects'
      ? path.dirname(path.dirname(path.dirname(file))) : (liveAccount || account).configDir;
    const resolveClaudeChild = deps.resolveClaudeChild || require('./child-transcripts').resolveClaudeChild;
    const resolveChild = session.kind === 'codex' ? deps.codexChildRolloutFile || codex.findRolloutFile
      : (id, parentFile = file) => resolveClaudeChild(id, parentFile, { configDir: claudeProfileDir });
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
      let rows = await readAgentRows();
      let identity = await identityFrom(rows);
      const changed = () => !identity?.primary || identity.pid !== originalIdentity.pid
        || identity.pidStart !== originalIdentity.pidStart;
      // A snapshot that could not describe the agent is not a changed agent. Read it
      // again before refusing: on 2026-09-17 two transfers died here for a process
      // whose pid and start time had not moved at all.
      if (changed() && agentRowUnreadable(rows, originalIdentity)) {
        // Only while the snapshot is still the thing that cannot answer: one that comes
        // back readable has answered, and its answer is the comparison below.
        for (let i = 0; i < 3 && changed() && agentRowUnreadable(rows, originalIdentity); i++) {
          await sleep(750);
          rows = await readAgentRows();
          identity = await identityFrom(rows);
        }
        if (changed() && agentRowUnreadable(rows, originalIdentity)) throw Error('Agent process identity could not be verified from ps');
        if (!changed()) process.stderr.write(`keep serve: ps snapshot missed ${session.id}'s agent (pid ${originalIdentity.pid}); a re-read found it\n`);
      }
      if (changed()) throw Error('Agent process identity changed during restart');
      // After the `ps` work above, not only at the top of the lock: those reads wait
      // seconds when a snapshot comes back unusable, and this runs again as the close
      // path's beforeClose, so the last word on it is taken as late as it can be.
      requireNoUserActivityAfter(deps.expectedNoUserActivityAfter, freshSessionRead(session, deps));
      const parent = rows.find((p) => p.pid === identity.pid);
      // process.env and not deps.env: the npx cache an `npx`-declared server unpacked
      // into is the one this daemon's own environment names, because the daemon is
      // what launched the session and the session inherited it. deps.env is the
      // account configuration's environment, which is a different thing.
      const helpers = mcpRestart.inspect({ root: deps.root || keep.ROOT, agent: session.kind, sessionId: session.id, parent, rows,
        cwd: session.project || pane.cwd, account: liveAccount, env: process.env });
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
        // onExitEnter lets a caller journal that the /exit's Enter is being sent, after
        // every check before it passed; onExitEnterDropped that the host refused it. An
        // account handoff may later have to prove, after the fact, a stop whose
        // confirmation it never saw, and only a committed Enter is a stop to prove.
        beforeEnterKey: deps.onExitEnter ? () => deps.onExitEnter() : undefined,
        enterKeyDropped: deps.onExitEnterDropped ? () => deps.onExitEnterDropped() : undefined,
      });
    } catch (error) {
      if (!exitInputStarted && ['Session changed during cleanup; nothing closed', 'Waiting for the turn and background work to finish', 'Waiting for pending input to be resolved'].includes(error.message)) throw transient(error.message);
      throw error;
    }
    let stopped;
    // The typed /exit can land on the worktree-exit modal instead of ending the session.
    // Answering it costs a round trip the plain exit does not, so the wait grows to ~15s
    // once — and only once — the prompt has been answered; every other screen waits the
    // same ~6s it always has. A screen that cannot be read is simply not the modal.
    //
    // Only Claude Code asks this question, and only a Claude session's screen is read at
    // all: the pane may become a plain shell mid-wait, and a Codex screen is a different
    // UI with its own prompt, so neither is a place to be typing a blind Enter.
    const answerable = session.kind === 'claude';
    let promptAnswered = false, screenReadReported = false, promptSkipReported = false;
    let refusedKind = null, refusalGrace = false;
    for (let i = 0, limit = 30; i < limit; i++) {
      stopped = (await host('get', { pane: body.pane })).pane;
      if (!restartPaneMatches(pane, stopped, session.id)) throw Error('Session process changed during restart');
      if (!stopped.alive) break;
      if (answerable && !promptAnswered) {
        const read = async () => {
          try { return await (deps.readScreenResult || readScreenResult)({ pane: body.pane }, null, false, deps); }
          catch (error) {
            if (!screenReadReported) {
              screenReadReported = true;
              process.stderr.write(`keep serve: could not read ${session.id}'s pane while waiting for it to exit: ${String(error && error.message || error)}\n`);
            }
            return null;
          }
        };
        const dialogOf = async () => claudePrompts.recognize(String((await read())?.text || ''));
        const dialog = await dialogOf();
        // Any other modal owning the pane is a question only Owner may answer, and the
        // /exit is parked behind it: waiting out the loop would end in a timeout that
        // names nothing. One frame is not a parked session, though — Owner may be
        // answering it as this reads, and a repaint can catch a dialog on its way out —
        // so the refusal needs the same dialog still live on a later poll, and the pause
        // below puts that poll far enough away (>300ms, plus the loop's own) to mean it.
        const refusing = dialog && dialog.live
          && claudePrompts.policyFor(dialog.kind).action === 'refuse' ? dialog : null;
        if (refusing && refusedKind === refusing.kind) {
          throw Error(`Claude Code is showing the ${claudePrompts.refusalLabel(refusing)} dialog; answer it in the pane before restarting`);
        }
        if (refusing) {
          await sleep(DIALOG_CONFIRM_MS);
          // A first sighting on the last poll would otherwise leave the loop to end in
          // the generic timeout, which names nothing, for a pane that is plainly parked
          // on a dialog. Keep one poll in hand for the read that confirms it — once, so
          // the wait stays bounded whatever the screen does.
          if (!refusalGrace && i + 1 >= limit) { refusalGrace = true; limit += 1; }
        }
        refusedKind = refusing && refusing.kind || null;
        if (claudePrompts.answerable(dialog)) {
          // The snapshot is already stale by the time it is read. Between it and the
          // write the agent can exit — its own exit finishing, or Owner answering the
          // modal himself — and the pane's root pid does not change when it falls back
          // to the login shell, so nothing else here would notice. Confirm the very
          // process that was asked the question is still running, then confirm the
          // question is still on screen, and only then answer it; the loop keeps
          // waiting either way, and the next poll reads the pane as dead or a shell.
          const rows = await (deps.agentProcessRows || agentProcessRows)(deps);
          const owner = rows.find((p) => p.pid === originalIdentity.pid && p.pidStart === originalIdentity.pidStart);
          if (owner && claudePrompts.answerable(await dialogOf())) {
            await writeTarget({ pane: body.pane }, claudePrompts.policyFor(dialog.kind).key, deps);
            promptAnswered = true;
            limit = 75;
            process.stderr.write(`keep serve: accepted "Keep worktree" for ${session.id} during graceful exit\n`);
          } else if (!promptSkipReported) {
            promptSkipReported = true;
            process.stderr.write(`keep serve: left the worktree prompt for ${session.id} alone; ${owner ? 'it went away' : 'the agent had already exited'} before the answer\n`);
          }
        }
      }
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
    if (deps.afterStop) await waitForMovedSessionProcesses(session, remotePane, deps, sleep);
    const live = await liveSessionPids(deps);
    // On another node this answer is a remote read, and a read that failed says
    // nothing about what is running there. Resuming on that silence is how a second
    // agent gets started on a transcript the first one is still writing.
    if (remotePane && unverifiedProcesses(live, session.kind)) {
      throw new InjectionError(409, `cannot verify processes on ${paneNode}`);
    }
    if (live.has(session.id)) throw Error('An agent process still owns this conversation');
    // An earlier Owner-forced stop of this transfer may have left a process it captured
    // running; nothing resumes the conversation while one does, forced or not.
    const prior = Array.isArray(deps.priorForcedProcesses) ? deps.priorForcedProcesses : [];
    if (prior.length) {
      const table = await (deps.agentProcessRows || agentProcessRows)(deps);
      if (priorForcedSurvivors(table, prior).length) {
        throw Error('A process from an earlier forced stop is still running; nothing resumed');
      }
    }
    return deps.afterStop ? deps.afterStop(stopped) : resume(stopped);
  }, { pane: body.pane, session: body.sessionId, ...(inheritedModel ? {} : { model: true }) });

  try { return await attempt(''); }
  catch (error) {
    if (entered || !injectionKeysBusy(error)) throw error;
    const inherited = (deps.compactionSwappedModel || compactionSwappedModel)(deps);
    if (!inherited) throw error;
    return attempt(inherited);
  }
}

// How force-restart stops a session: the graceful manual close, then SIGTERM and
// SIGKILL on the exact process instances it captured. Resuming is left to the caller.
function forceStopDeps(entry, deps, host, save) {
  // Never cached: this reads the same processes again after every signal, and a
  // stale snapshot here is how an old process is called gone. On another node
  // nodeEvidence has already pointed `forceRows` at that machine's `process` verb.
  const rows = deps.forceRows || (async () => {
    const result = await execFileAsync('ps', processTable.PS_FULL_ARGS, {
      encoding: 'utf8', timeout: 5000, maxBuffer: 32e6, env: { ...process.env, LC_ALL: 'C' },
    });
    return processTable.parseFullProcessTable(String(result.stdout));
  });
  const signal = deps.forceSignal
    || (async (pid, name) => { try { process.kill(pid, name); } catch (e) { if (e.code !== 'ESRCH') throw e; } });
  return {
    save, rows, sleep: deps.sleep,
    identifyOriginal: async (sid, snapshot) => (await liveSessionPids({ ...deps, agentProcessRows: async () => snapshot })).get(sid),
    verifyStarted: original => (deps.waitForHostAgent || waitForHostAgent)({ pane: entry.pane }, original.agent, deps),
    getPane: async pane => (await host('get', { pane })).pane,
    close: body => require('./manual-close').manualClose(body, {
      sleep: deps.sleep,
      getPane: async id => {
        const pane = (await host('get', { pane: id })).pane;
        // Only the captured pane instance may be closed: a pane relaunched since the
        // process snapshot is someone else's, and manualClose would adopt its pid.
        if (pane && (pane.pid !== entry.pid || pane.createdAt !== entry.original.createdAt)) {
          throw Error('Pane changed since it was inspected; nothing closed');
        }
        // SessionEnd can clear the conversation link before the owning login
        // shell exits. Normalize only this exact captured pane instance.
        return pane?.id === entry.pane && pane.pid === entry.pid && pane.createdAt === entry.original.createdAt
          && pane.meta?.agent === 'shell' && !pane.meta.sessionId
          ? { ...pane, meta: { ...pane.meta, agent: entry.original.agent, sessionId: entry.sessionId } } : pane;
      },
      graceful: request => (deps.closeIdleSession || closeIdleSession)(request, { ...deps, closePolicy: { manual: true }, withInjectionLock: fn => fn() }),
      signal: (pane, signal) => host('kill', { pane, signal, expectedPid: entry.pid }),
    }),
    // The captured process, not a bare pid: the comparison and the kill happen on the
    // machine that owns the pid, in one step, and a pid checked here and signalled
    // there is no check at all. The whole captured row rides along — start time,
    // parent and arguments — because that is what the node compares against.
    signal: async (target, name) => signal(target.pid, name, target),
    sessionLive: async sid => (await liveSessionPids({ ...deps, agentProcessRows: rows })).has(sid),
  };
}

// The processes an earlier forced stop captured that are still running: the same pid and
// the same start time, never a pid reused by a later process.
function priorForcedSurvivors(table, prior) {
  return (Array.isArray(prior) ? prior : []).filter((old) => old && Number.isInteger(old.pid) && typeof old.pidStart === 'string'
    && old.pidStart && (table || []).some((p) => p && !p.zombie && p.pid === old.pid && p.pidStart === old.pidStart));
}

// Owner-forced restart or handoff. Nothing is typed into the session and the host is
// never asked to signal "whatever this pane runs now": the pane's whole process tree is
// captured once, each process by pid and start time, journalled through onForcedStop,
// and only those exact instances are sent SIGTERM and then SIGKILL. Descendants that
// appear while it runs join the set only through a parent already in it. The caller's
// resume step then starts the conversation again (for a handoff, on the target account).
async function forceStopThenResume({ session, pane, identity, resume }, deps = {}) {
  const host = (type, params) => hostRequest(type, params, deps);
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const rows = forceStopDeps({ sessionId: session.id, pane: pane.id, pid: pane.pid }, deps, host, async () => {}).rows;
  const signal = deps.forceSignal || (async (pid, name) => { try { process.kill(pid, name); } catch (e) { if (e.code !== 'ESRCH') throw e; } });
  const same = (a, b) => a && b && a.pid === b.pid && a.pidStart === b.pidStart;
  const samePane = (current) => current && current.id === pane.id && current.pid === pane.pid && current.createdAt === pane.createdAt;

  const snapshot = await rows();
  const shell = snapshot.find((p) => p.pid === pane.pid);
  if (!shell?.pidStart) throw Error('Original process identity is incomplete');
  const processes = [{ pid: shell.pid, pidStart: shell.pidStart }];
  const grow = (table) => {
    const before = processes.length;
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of table) {
        if (processes.some((owned) => owned.pid === p.pid) || !processes.some((owned) => same(owned, table.find((q) => q.pid === p.ppid)))) continue;
        if (!p.pidStart || processes.length >= 256) {
          const error = Error('Process tree exceeds force-stop limit or lacks identity');
          error.incompleteCapture = true;
          throw error;
        }
        processes.push({ pid: p.pid, pidStart: p.pidStart }); changed = true;
      }
    }
    return processes.length > before;
  };
  // An earlier forced stop of this transfer that did not finish may have left processes it
  // captured running, orphaned from this tree: they are this stop's too.
  for (const prior of priorForcedSurvivors(snapshot, deps.priorForcedProcesses)) {
    if (!processes.some((owned) => owned.pid === prior.pid)) processes.push({ pid: prior.pid, pidStart: prior.pidStart });
  }
  grow(snapshot);
  if (!processes.some((p) => p.pid === identity.pid && p.pidStart === identity.pidStart)) {
    throw Error('Agent process identity changed during restart');
  }
  if (!samePane((await host('get', { pane: pane.id })).pane)) throw Error('Pane changed since it was inspected; nothing closed');
  // Journalled before the first signal: a handoff that loses the daemon from here on can
  // still prove the stop, and only once every one of these is gone.
  await deps.onForcedStop?.(processes.map((p) => ({ ...p })));

  let remaining = processes;
  for (const name of ['SIGTERM', 'SIGKILL']) {
    const table = await rows();
    // Anything newly captured is journalled before it is signalled, so recovery waits for it too.
    // A capture that could not finish is journalled as incomplete, which recovery never accepts.
    let grew;
    try { grew = grow(table); } catch (error) {
      if (error.incompleteCapture) await deps.onForcedStop?.(processes.map((p) => ({ ...p })), { incomplete: true });
      throw error;
    }
    if (grew) await deps.onForcedStop?.(processes.map((p) => ({ ...p })));
    for (const old of [...processes].reverse()) {
      const current = table.find((p) => p.pid === old.pid);
      // The live row this process was just matched against travels with the pid: on
      // another machine the comparison and the kill have to happen there, together,
      // and a pid on its own is not an identity. On this one it is the same local
      // kill it has always been.
      if (same(current, old) && !current.zombie) await signal(old.pid, name, current);
    }
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      const after = await rows();
      remaining = processes.filter((old) => after.some((p) => same(old, p) && !p.zombie));
      if (!remaining.length) break;
    }
    if (!remaining.length) break;
  }
  if (remaining.length) throw Error('Old processes remain; recovery required');

  let stopped;
  for (let i = 0; i < 25; i++) {
    stopped = (await host('get', { pane: pane.id })).pane;
    if (!samePane(stopped)) throw Error('Pane changed after the forced stop; nothing resumed');
    if (!stopped.alive) break;
    await sleep(200);
  }
  if (stopped.alive) throw Error('Pane did not exit after its processes were stopped');
  if ((await liveSessionPids({ ...deps, agentProcessRows: rows })).has(session.id)) {
    throw Error('An agent process still owns this conversation');
  }
  return resume(stopped);
}

// Same two attempts as restartSession: hold the model key so the resumed agent reads a
// settled settings.json, and if the key is busy, name the model a compaction swapped out.
async function forceRestartSession(entry, save, deps = {}) {
  // The pane's machine answers for the pane's processes, here as in restartSession.
  const paneNode = sessionNodeOf(String(entry.pane || ''), deps);
  const remotePane = paneNode !== daemonNodeName(deps);
  deps = nodeEvidence(paneNode, deps);
  let entered = false;
  const attempt = (inheritedModel) => (deps.withInjectionLock || withInjectionLock)(async () => {
    entered = true;
    const host = (type, params) => hostRequest(type, params, deps);
    let capabilities;
    try { capabilities = await host('hello'); }
    catch (error) {
      if (!hostRequestTimedOut(error)) throw error;
      throw new Error(`Terminal host timed out while checking restart support: ${error.message}`, { cause: error });
    }
    if (!capabilities.replaceExited) throw Error('Terminal host must be refreshed before restarting sessions');
    const initial = (await host('get', { pane: entry.pane })).pane;
    const cwd = entry.original?.cwd || initial?.cwd;
    // On another node the directory is that machine's; the resume there fails for
    // itself if it is gone.
    if (!cwd || (!remotePane && !fs.statSync(cwd).isDirectory())) throw Error('Session directory is unavailable');
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
    // Only a Claude agent on the built-in profile reads the settings.json this attempt
    // gave up the key to name: Codex resumes on a model and reasoning effort from
    // config.toml, and a managed profile reads a settings.json of its own. Hand the 429
    // back here, before the close, rather than part way through the restart.
    if (inheritedModel && !(resumeAgent === 'claude' && resumeAccount.builtIn === true)) throw injectionBusyError();
    // The account's config directory is on the machine the pane is on, so a remote
    // resume has its shared setup prepared there instead, through prepare-launch.
    let resumeMcpConfig = null;
    if (!remotePane && resumeAgent === 'claude' && resumeAccount.managed) {
      try { resumeMcpConfig = (deps.ensureSharedMemory || require('./account-setup').ensureSharedMemory)(resumeAccount, cwd).mcpConfig; }
      catch (error) { throw new InjectionError(409, `account shared setup is unavailable: ${error.message}`); }
    }
    // Kept to hand so the guard below reads the very table the stop signals against.
    const stop = forceStopDeps(entry, deps, host, save);
    return require('./force-restart').run(entry, {
      ...stop,
      sessionLive: async (sid) => {
        const live = await liveSessionPids({ ...deps, agentProcessRows: stop.rows });
        // Same reason as the in-place restart: "not live" from a node that could not
        // be read is not an answer a replace may be built on.
        if (remotePane && unverifiedProcesses(live, resumeAgent)) {
          throw new InjectionError(409, `cannot verify processes on ${paneNode}`);
        }
        return live.has(sid);
      },
      replace: async (original, job, expectedPid) => {
        const bypass = original.agent === 'codex' ? '--dangerously-bypass-approvals-and-sandbox' : '--dangerously-skip-permissions';
        const reviewerSpec = reviewerResumeSpec({ id: job.sessionId }, original, deps);
        const launchModel = typeof original.meta?.model === 'string' && keep.LAUNCH_MODEL_RE.test(original.meta.model) ? original.meta.model : '';
        const resumeModel = launchModel || (original.agent === 'claude' ? inheritedModel : '');
        const modelArgs = resumeModel ? (original.agent === 'codex' ? ['-m', resumeModel] : ['--model', resumeModel]) : [];
        const account = resumeAccount;
        const mcpArgs = original.agent !== 'claude' ? []
          : remotePane ? [{ insert: 'mcpConfig' }] : resumeMcpConfig ? ['--mcp-config', resumeMcpConfig] : [];
        const argv = [original.agent, ...(original.bypass ? [bypass] : []), ...reviewerSpec.flags, ...mcpArgs, ...modelArgs,
          original.agent === 'codex' ? 'resume' : '--resume', job.sessionId];
        const stopped = (await host('get', { pane: job.pane })).pane;
        if (stopped.alive || stopped.pid !== expectedPid || (stopped.meta?.sessionId !== job.sessionId
          && !(stopped.meta?.agent === 'shell' && !stopped.meta.sessionId
            && ((expectedPid === job.pid && stopped.createdAt === original.createdAt) || stopped.meta.forceRestartToken === job.token)))) {
          throw Error('Exited pane changed before resume');
        }
        // Built where it will run: the shell word names a node binary and a
        // launcher path, and those are the pane's machine's, not this one's.
        const command = remotePane
          ? (await prepareLaunchOn(paneNode, {
            agent: original.agent,
            account: { id: account.id, agent: account.agent, configDir: account.configDir,
              builtIn: account.builtIn === true, managed: account.managed === true },
            cwd: original.cwd, bypass: false, argv, pi: null,
          }, deps)).command
          : require('./agent-launcher').profileCommand(argv, account);
        const result = await host('replace-exited', { paneId: job.pane, expectedPid, sessionId: stopped.meta?.sessionId,
          cmd: '/bin/zsh', args: ['-lic', `exec ${command}`], cwd: original.cwd,
          env: require('./agent-launcher').launcherEnv({ ...repairEnvFor({ sessionId: job.sessionId }, deps), ...reviewerSpec.env }),
          cols: original.cols, rows: original.rows, meta: { ...adoptedPaneMeta(original.meta), accountId: account.id, accountLabel: account.label,
            forceRestartToken: job.token, restartedAt: Date.now() } });
        return { ok: true, pane: result.pane.id, pid: result.pane.pid, sessionId: job.sessionId };
      },
    });
  }, { pane: entry.pane, session: entry.sessionId, ...(inheritedModel ? {} : { model: true }) });

  try { return await attempt(''); }
  catch (error) {
    if (entered || !injectionKeysBusy(error)) throw error;
    const inherited = (deps.compactionSwappedModel || compactionSwappedModel)(deps);
    if (!inherited) throw error;
    return attempt(inherited);
  }
}

async function closeIdleSession(body, deps = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(body.sessionId || '')) || !validPaneRef(body.pane)) throw new InjectionError(400, 'Expected an exact session and pane');
  // Every automatic policy here reasons about this machine: the idle sweep reads
  // the local process table, and the shell close verifies a pid it can see. Until a
  // node answers those questions about itself, a pane on another machine is closed
  // only when a person asks for it by hand.
  const paneNode = nodes.parsePaneRef(String(body.pane || ''), { env: paneRefEnv(deps) });
  // An id qualified with this node's own name is this node's pane: everything below
  // compares against the ids the pane list publishes, which are bare here.
  if (!paneNode.qualified && paneNode.paneId !== body.pane) body = { ...body, pane: paneNode.paneId };
  if (remoteSession(body.pane, deps) && deps.closePolicy && !deps.closePolicy.manual) {
    throw new InjectionError(409, `automatic close is not available for a pane on ${paneNode.node}; close it by hand`);
  }
  // By hand, a pane on another node is judged by that node's answers about its own
  // processes, never by this machine's table: a pid there means nothing here.
  const elsewhere = remoteSession(body.pane, deps) ? paneNode.node : null;
  if (elsewhere) deps = nodeEvidence(elsewhere, deps);
  const scope = { pane: body.pane, session: body.sessionId };
  return (deps.withInjectionLock || withInjectionLock)(async () => {
    const listed = await hostPanesForAction(deps, true);
    if (!Array.isArray(listed.panes)) throw hostPaneVerificationError('Live pane state', listed);
    const panes = listed.panes;
    const state = await addHostSessionState(await (deps.buildState || buildState)({ hostPanes: panes }), { ...deps, panes });
    const session = state.sessions.find((s) => s.id === body.sessionId);
    const pane = state.panes.find((p) => p.id === body.pane);
    if (await closeExitedCodexShell(session, pane, deps)) return { ok: true, closing: true, sessionId: session.id, pane: pane.id };
    // Everything past here proves the session idle from its transcript, which is on
    // the machine it runs on. The Close button's own close does not stop at that: this
    // refusal is its graceful step declining, and manual-close goes on to signal the
    // pane through its host, which routes by the qualified ref to that machine.
    if (elsewhere && deps.closePolicy?.manual && !deps.closePolicy.restart) {
      throw new InjectionError(409, `a graceful close reads the session's transcript, which is on ${elsewhere}; nothing typed`);
    }
    const layouts = await keepConsole.readLayouts(path.join(deps.root || keep.ROOT, '.keep', 'layouts.json'));
    const pinned = new Set((layouts.layouts || []).flatMap((layout) => layout.ids || []));
    const assertRetirementPreference = () => {
      if (!deps.closePolicy?.retirement) return;
      try { require('./session-retirement').assertRetirable(deps.root || keep.ROOT, session.id); }
      catch (error) { throw new InjectionError(409, error.message); }
    };
    const checkDonePolicy = async (current, currentPane = pane, policyPane = currentPane) => {
      if (!deps.closePolicy?.done && !deps.closePolicy?.retirement) return null;
      const companion = await (deps.discoverCodexJobs || stalled.discoverCodexJobs)({
        root: deps.root || keep.ROOT,
      }, deps);
      const allTasks = (deps.loadAll || keep.loadAll)(true);
      let policySession = current.sessions.find((candidate) => candidate.id === session.id);
      if (deps.closePolicy?.retirement) {
        const prefs = require('./session-retirement').preferences(deps.root || keep.ROOT);
        policySession = { ...policySession, keepRunningKnown: prefs.known };
        if (prefs.value.sessions[session.id]?.keepRunning === true) policySession.keepRunning = true;
        else delete policySession.keepRunning;
      }
      const legacy = deps.closePolicy.legacyDoneAt || {};
      const plan = (deps.closePolicy?.retirement
        ? require('./session-cleanup').retirementPlan
        : require('./session-cleanup').doneClosePlan)(
        policySession,
        policyPane,
        { ...current, allTasks, pinned, companion },
        (deps.now || Date.now)(),
        {
          idleMs: deps.closePolicy.idleMs,
          doneIdleMs: deps.closePolicy.doneIdleMs,
          attentionIdleMs: deps.closePolicy.attentionIdleMs,
          unattendedIdleMs: deps.closePolicy.unattendedIdleMs,
          legacyDoneAt: (task) => legacy[task.id],
        },
      );
      if (plan.reason) throw new InjectionError(409, plan.reason);
      if (deps.closePolicy.expectedReason && plan.kind !== deps.closePolicy.expectedReason) {
        throw new InjectionError(409, 'Session retirement policy changed during cleanup');
      }
      return plan;
    };
    const checkedPlan = await checkDonePolicy(state);
    // The check sweep may only close panes that are still its own. A restart or an
    // account handoff drops `meta.ephemeral`, so a pane adopted between the sweep's
    // decision and this close belongs to whoever adopted it, not to the scheduler.
    if (deps.closePolicy?.ephemeral && !pane?.meta?.ephemeral) {
      throw new InjectionError(409, 'Pane is no longer a scheduler-opened check session');
    }
    const cleanupSession = deps.allowTerminalRateLimit && session.kind === 'claude' && session.rateLimit
      ? { ...session, endedTurn: true, rateLimit: null } : session;
    const reason = require('./session-cleanup').refusal(cleanupSession, pane, pinned, Date.now(), {
      ...deps.closePolicy,
      idleMs: checkedPlan?.idleMs ?? deps.closePolicy?.idleMs,
    });
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
      const ownsItsSchedule = deps.closePolicy?.manual || deps.closePolicy?.ephemeral || deps.closePolicy?.retirement;
      if ((!ownsItsSchedule && fm.check_after) || (!deps.closePolicy?.restart && !deps.closePolicy?.ephemeral
          && !deps.closePolicy?.retirement && (fm.needs?.length || fm.depends_on?.length))) {
        throw new InjectionError(409, 'Task has a scheduled check, need, or dependency; leave the session open');
      }
      // Explicit Close retires the process, not its durable scheduled recipes. The
      // scheduler opens a fresh session for the check when its owner is closed.
      if (!ownsItsSchedule && current.tasks.some((t) => { const f = t.fm || t; return f.check_after && (f.scheduled_by === session.id || f.sessions?.some((s) => s.id === session.id)); })) throw new InjectionError(409, 'Session owns a scheduled check on another card');
      if (require('./delivery').pendingForSession(path.join(deps.root || keep.ROOT, '.keep', 'delivery'), session.id)) throw new InjectionError(409, 'Session has an unconfirmed delivery');
      if (deps.closePolicy?.retirement) {
        const transfer = require('./account-handoff').transferInFlight(deps.root || keep.ROOT, session.id, (deps.now || Date.now)());
        if (transfer) throw new InjectionError(409, `Session has an account transfer in flight (${transfer.status}/${transfer.phase})`);
        if ((deps.readPendingCompactSwap || readPendingCompactSwap)(session.id, deps.autoCompactDir)) {
          throw new InjectionError(409, 'Session has a model switch or compaction restore in flight');
        }
        const restart = require('./session-restart').read(path.join(deps.root || keep.ROOT, '.keep', 'session-restarts.json'))
          .find((entry) => entry.sessionId === session.id && ['queued', 'restarting', 'recovery-needed'].includes(entry.status));
        if (restart) throw new InjectionError(409, 'Session has a restart request in flight');
      }
    };
    checkTaskSafety(state);
    const target = claimInjectionTarget(await resolveSessionTarget(session, { expectedPane: pane.id }, deps));
    await precheckSessionTarget(session, target, deps); // Preserve unsent drafts and modal prompts.
    const fresh = session.kind === 'claude' ? (deps.claudeSessionFor || claudeSessionFor)(session.id) : (deps.codexSessionFor || codex.sessionFor)(session.id);
    if (!fresh || typeof fresh.endedTurn !== 'boolean' || !Number.isFinite(fresh.mtime)) throw new InjectionError(409, 'Session activity could not be verified');
    const freshEnded = fresh.endedTurn === true || (deps.allowTerminalRateLimit && fresh.rateLimit && !fresh.pendingBackground
      && !fresh.toolRunning && !fresh.pendingQuestion && !fresh.pendingPlan
      && !require('./session-restart').blockingUnknownJobs(fresh).length);
    // A forced restart already accepted uncertain background evidence upstream;
    // the transcript's turn, tool and mtime checks still have to agree.
    if (fresh.mtime !== session.mtime || !freshEnded || (!deps.closePolicy?.force && fresh.pendingBackground) || fresh.toolRunning) throw new InjectionError(409, 'Session changed during cleanup; nothing closed');
    let verifyCodexChildren = null;
    let automaticProcessIdentity = null;
    let automaticProcessRows = null;
    let automaticHelpers = null;
    const inspectAutomaticProcesses = async ({ initial = false, requireGone = false } = {}) => {
      const rows = await (deps.agentProcessRows || agentProcessRows)(deps);
      const identity = (await (deps.liveSessionPids || liveSessionPids)({
        ...deps, agentProcessRows: async () => rows,
      })).get(session.id);
      if (!identity?.primary || (!initial && (identity.pid !== automaticProcessIdentity.pid
          || identity.pidStart !== automaticProcessIdentity.pidStart))) {
        throw new InjectionError(409, 'Session process identity could not be verified; nothing closed');
      }
      const parent = rows.find((process) => process.pid === identity.pid);
      if (!parent) throw new InjectionError(409, 'Session process identity could not be verified; nothing closed');
      let account = null;
      try { account = accounts.forSession(session.id, session.kind, { root: deps.root || keep.ROOT, env: deps.env || process.env }); }
      catch (error) { throw new InjectionError(409, error.message); }
      let helpers;
      try {
        helpers = require('./mcp-restart').inspect({
          root: deps.root || keep.ROOT,
          agent: session.kind,
          sessionId: session.id,
          parent,
          rows,
          cwd: session.project || pane.cwd,
          account,
          env: process.env,
          strictLeaves: deps.closePolicy?.retirement === true,
        });
      } catch (error) { throw new InjectionError(409, error.message); }
      if (initial) {
        automaticProcessIdentity = identity;
        automaticProcessRows = rows;
        automaticHelpers = helpers;
      } else {
        const original = new Set((automaticHelpers || []).map((helper) => `${helper.pid}:${helper.pidStart}:${helper.args}`));
        if (helpers.some((helper) => !original.has(`${helper.pid}:${helper.pidStart}:${helper.args}`))) {
          throw new InjectionError(409, 'Session helper processes changed during cleanup');
        }
      }
      if (requireGone && !require('./mcp-restart').gone(automaticHelpers || [], rows)) {
        throw new InjectionError(409, 'Session helper processes are still exiting; nothing force-terminated');
      }
      return rows;
    };
    if (deps.closePolicy?.retirement || deps.closePolicy?.done) await inspectAutomaticProcesses({ initial: true });
    if (session.kind === 'claude' && !(deps.closePolicy?.restart && deps.restartProof)) {
      const file = findSessionFile(session.id);
      if (!file) throw new InjectionError(409, 'Session history is unavailable for background completion verification');
      const lifecycle = await inspectCloseTranscript(file, 'claude', deps);
      if (lifecycle.hasBackgroundCommands || lifecycle.pendingBackground) throw new InjectionError(409, 'Background command completion is unverified; leave the session open');
    } else if (session.kind === 'codex') {
      // The transcript's ended turn does not prove that yielded Codex commands
      // ended. Automatic retirement requires no children; explicit Close may
      // override that conservative check (Codex also keeps idle runtime helpers).
      const processes = automaticProcessRows || await agentProcessRows(deps);
      const live = await (deps.liveSessionPids || liveSessionPids)({
        ...deps, agentProcessRows: async () => processes,
      });
      const identity = live.get(session.id);
      if (!identity || !identity.primary) throw new InjectionError(409, 'Codex process identity could not be verified; nothing closed');
      if (!deps.closePolicy?.manual) {
        if (!deps.closePolicy?.retirement && processes.some((p) => p.ppid === identity.pid)) throw new InjectionError(409, 'Automatic cleanup protects Codex child processes; use Close to request an explicit graceful exit');
        const file = (deps.codexRolloutFile || codex.rolloutFileFor)(session.id);
        if (!file) throw new InjectionError(409, 'Codex background history is unavailable');
        // Remote children have no local PID. Verify durable child transcripts,
        // not expiring UI hints, before retiring a parent that used them. The full
        // rollout scan stays off this event loop for the same reason as Claude's.
        const { launched } = await inspectCloseTranscript(file, 'codex', deps);
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
      if (deps.closePolicy?.retirement || deps.closePolicy?.done) {
        await inspectAutomaticProcesses();
      } else if (session.kind === 'codex' && !deps.closePolicy?.manual) {
        const rows = await agentProcessRows(deps);
        const identity = (await (deps.liveSessionPids || liveSessionPids)({
          ...deps, agentProcessRows: async () => rows,
        })).get(session.id);
        if (!identity?.primary || rows.some((p) => p.ppid === identity.pid)) throw new InjectionError(409, 'Codex child processes changed during cleanup');
      }
      const latest = session.kind === 'claude' ? (deps.claudeSessionFor || claudeSessionFor)(session.id) : (deps.codexSessionFor || codex.sessionFor)(session.id);
      if (!latest || typeof latest.endedTurn !== 'boolean' || !Number.isFinite(latest.mtime)) throw new InjectionError(409, 'Session activity could not be verified');
      // A transfer that named when it was requested is asking about this very read. The
      // comparison below is against `session`, the baseline this close was handed, which
      // was taken after the caller's own check and so already contains anything the
      // person did in between; only the boundary can tell that apart.
      requireNoUserActivityAfter(deps.expectedNoUserActivityAfter, latest);
      const latestEnded = latest.endedTurn === true || (deps.allowTerminalRateLimit && latest.rateLimit && !latest.pendingBackground
        && !latest.toolRunning && !latest.pendingQuestion && !latest.pendingPlan
        && !require('./session-restart').blockingUnknownJobs(latest).length);
      if (latest.mtime !== session.mtime || !latestEnded
          || (!deps.closePolicy?.force && (latest.pendingBackground
            || require('./session-restart').blockingUnknownJobs(latest).length))
          || latest.toolRunning || latest.pendingQuestion || latest.pendingPlan) {
        throw new InjectionError(409, 'Session changed during cleanup; nothing closed');
      }
      if (deps.closePolicy?.automatic) {
        currentPane = (await listHostPanes(deps, true))?.find((p) => p.id === pane.id);
        const viewers = currentPane && (currentPane.visibleAttached ?? currentPane.attached);
        if (!currentPane?.alive || !Number.isInteger(viewers) || viewers !== 0 || currentPane.meta?.sessionId !== session.id) throw new InjectionError(409, 'Session acquired a viewer or changed during cleanup');
        if (deps.closePolicy?.ephemeral && !currentPane.meta?.ephemeral) {
          throw new InjectionError(409, 'Pane stopped being a scheduler-opened check session during cleanup');
        }
        if (expectedInputCount !== null && currentPane.inputCount !== expectedInputCount) {
          throw new InjectionError(409, 'Session received unexpected input during cleanup');
        }
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
      assertRetirementPreference();
      return currentPane;
    };
    await unchanged();
    // The input/output counts a caller needs to guard its own SIGTERM/SIGKILL. Produced
    // for automatic retirement, and for the check sweep, which passes protectInput and
    // protectOutput to manual-close and cannot enforce either without them.
    if (deps.closePolicy?.retirement || deps.closePolicy?.done || deps.closePolicy?.ephemeral) {
      authorizedPane = (await listHostPanes(deps, true))?.find((candidate) => candidate.id === pane.id);
      if (!authorizedPane || !Number.isInteger(authorizedPane.inputCount)) {
        throw new InjectionError(409, 'Pane input activity could not be verified');
      }
    }
    assertRetirementPreference();
    deps.beforeExitInput?.();
    // Claude's slash menu can occupy more than 30 rows below the input, and on a
    // loaded machine it can take seconds to draw: 4s of polling for Claude rather
    // than 1.6s, because the alternative is a /exit stranded in the box.
    //
    // A restart types this on nobody's behalf and will be tried again, so an abort
    // has to take the draft back with it. A manual close does not: Owner asked for
    // it, and leaving the typed /exit on screen is how he sees what was about to
    // happen.
    await typeAndSubmit(target, '/exit', (screen, text) => closeDraftVisible(screen, text, session.kind), {
      ...deps,
      confirmationLines: session.kind === 'claude' ? null : 30,
      confirmationAttempts: session.kind === 'claude' ? 10 : 4,
      discardDraftOnAbort: deps.closePolicy?.restart === true,
      draftKind: session.kind,
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
        beforeSignal: async () => {
          await unchanged({
            expectedInputCount: authorizedPane.inputCount + 2,
            useAuthorizedActivity: true,
          });
          if (deps.closePolicy?.retirement || deps.closePolicy?.done) {
            await inspectAutomaticProcesses({ requireGone: true });
          }
          assertRetirementPreference();
        },
      } : {}),
    };
  }, scope);
}

async function precheckSessionTarget(session, target, deps = {}) {
  const screen = await (deps.readScreen || ((t, lines, scrollback) => readScreen(t, lines, scrollback, deps)))(target, 30, false);
  if (session.kind === 'codex') { codexSendPrecheck(screen); return { kind: 'empty' }; }
  return probeSuggestion(target, screen, deps);
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
    if (session.kind === 'claude') noteSeenModel(result.model, claudeConfigDirOf(file));
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
  // An agent that asked to be compacted said it is at a stopping point, so a short
  // quiet spell is enough; the sweep has no such word and waits on the cache clock.
  const minIdleMs = opts.requested?.(session) === true && Number.isFinite(opts.requestIdleMs) ? opts.requestIdleMs
    : Number.isFinite(opts.minIdleMs) ? opts.minIdleMs : opts.ttlMs;
  if (!Number.isFinite(idleMs) || idleMs < minIdleMs || idleMs > opts.maxIdleMs) return null;
  return idleMs;
}

// A snapshot older than this says nothing about the current window, so it counts as
// "unknown" rather than "exhausted". Same horizon the reviewer budget uses.
const COMPACT_USAGE_STALE_MS = 30 * 60e3;

// The on-disk usage snapshot the daemon's own refresh writes (serve/schedulers.js
// points usage.setCacheFile here). Read from disk rather than usage.getUsage() so a
// compaction tick never kicks off a network refresh of its own.
function readUsageCache() {
  try { return JSON.parse(fs.readFileSync(path.join(keep.ROOT, '.keep', 'usage-cache.json'), 'utf8')); }
  catch { return null; }
}

// True when compacting on the session's *own* model would answer "You've reached your
// <model> limit" instead of compacting. Session ed086c60 was compacted warm on a Fable
// account already at 100% of its "Fable wk" window; the attempt burned the idle period
// and stamped `timeout`. Two independent signals, either one is enough:
//   (a) the session is already parked on the per-model limit error, and
//   (b) the account's fresh usage snapshot says the model-scoped weekly bucket is spent.
// A stale or missing snapshot is unknown, never exhausted: guessing wrong here would
// push every warm compaction through the cold fallback for no reason.
function compactModelExhausted(session, options = {}) {
  if (!session || session.kind !== 'claude') return false;
  const model = String(session.model || '').trim();
  if (!model) return false;
  if (session.rateLimit && session.rateLimit.type === 'fable_weekly'
    && compactModelContainsFamily(model, 'fable')) return true;
  const scoped = compactScopedLimit(model, options.accountId || session.accountId, options);
  if (!scoped) return false;
  const percent = Number(scoped.percent);
  if (!Number.isFinite(percent)) return false;
  const minHeadroom = Number.isFinite(options.minHeadroom) ? options.minHeadroom : 0;
  return percent >= 100 || 100 - percent < minHeadroom;
}

// The account's fresh per-model weekly bucket for this model ("Fable wk"), resolved
// exactly as review.classifyBudget does, or null when the snapshot is missing, stale or
// has no such bucket.
function compactScopedLimit(model, accountId, options = {}) {
  if (!model || !accountId) return null;
  const claude = review.accountLimits(options.usage, accountId);
  if (!claude || !Array.isArray(claude.limits) || !claude.limits.length) return null;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : COMPACT_USAGE_STALE_MS;
  const fetchedAt = Number(claude.fetchedAt);
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0 || now - fetchedAt > staleMs) return null;
  const family = review.modelFamily(model);
  const prefix = (family === 'other' ? model : family).toLowerCase();
  return claude.limits.find((limit) => {
    const label = String(limit && limit.label || '').toLowerCase();
    return label.endsWith(' wk') && prefix && label.startsWith(prefix);
  }) || null;
}

function compactResetMs(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (Number.isFinite(number)) return number > 0 ? number : null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

// When a spent model's own window resets, from the same two signals compactModelExhausted
// reads: the reset the parked limit error recorded, else the account snapshot's reset for
// the model's weekly bucket. null when neither says, or the time is already past — the
// caller then backs off on its own clock rather than trusting a reset that did not happen.
// A model-exhausted compaction hands this to its restore, so the restore waits for the
// window instead of typing a /model the API is certain to answer with a 429.
function compactModelResetAt(session, options = {}) {
  const model = String(session && session.model || '').trim();
  if (!model) return null;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const candidates = [];
  if (session.rateLimit && compactModelContainsFamily(model, 'fable') && session.rateLimit.type === 'fable_weekly') {
    candidates.push(compactResetMs(session.rateLimit.resetsAt));
  }
  const scoped = compactScopedLimit(model, options.accountId || session.accountId, { ...options, now });
  if (scoped) candidates.push(compactResetMs(scoped.resetsAt));
  const future = candidates.filter((at) => at != null && at > now);
  return future.length ? Math.max(...future) : null;
}

function autoCompactPolicy(session, now, opts) {
  const model = String(session?.model || '').trim().toLowerCase();
  const models = Array.isArray(opts.models) ? opts.models : [];
  let swept;
  if (session?.kind === 'claude') {
    swept = Boolean(model) && models.some((family) => {
      const needle = String(family).trim().toLowerCase();
      return needle && model.includes(needle);
    });
  } else if (session?.kind === 'codex') {
    swept = model === 'gpt-6-astra';
  } else return null;
  if (!swept) {
    // The sweep leaves these models alone, but an agent that asked is compacted on its
    // own model: no fallback swap exists for them (compactSwapPlan needs a family), so
    // a cold cache still compacts on the current model, and there is no warm window to
    // wait for or miss. That holds without a usage record too — the model is all it
    // needs. `ownModel` tells the tick not to hold it to a cache deadline.
    if (!model || opts.requested?.(session) !== true) return null;
    // Unless that model's own window is spent: /compact would be answered with the limit
    // message and hold the model lock until it timed out. The request waits or expires.
    if (opts.modelExhausted?.(session) === true) return null;
    const cacheAgeMs = Number.isFinite(session.usageAt) && session.usageAt > 0 ? now - session.usageAt : null;
    return { path: 'warm-current', originalModel: model, targetModel: model, cacheAgeMs, cacheTtlMs: null,
      targetAgeMs: 0, ownModel: true };
  }
  const usageAt = session.usageAt;
  if (!Number.isFinite(usageAt) || usageAt <= 0) return null;
  const fallbackTtlMs = session.kind === 'codex'
    ? (opts.codexTtlMs ?? 30 * 60e3) : (opts.claudeTtlMs ?? opts.ttlMs);
  const cacheTtlMs = session.kind === 'claude' && Number.isFinite(session.cacheTtlMs)
    ? session.cacheTtlMs : fallbackTtlMs;
  const cacheAgeMs = now - usageAt;
  if (!Number.isFinite(cacheAgeMs)) return null;
  // The session's own model window is spent, so a warm compaction on it cannot run
  // at all. Both waiting-for-a-warm-cache rules below exist only to reuse that cache;
  // neither is worth anything once the model refuses the turn.
  const exhausted = opts.modelExhausted?.(session) === true;
  // The waits below guess when a session has stopped for good. An agent that asked
  // for compaction has already said so, so a requested session never waits on them.
  const requested = opts.requested?.(session) === true;
  // A five-minute Claude cache is too short to justify an immediate compaction.
  // Leave the session alone for an hour, then compact through the cheaper model.
  if (session.kind === 'claude' && session.cacheTtlMs === 5 * 60e3 && !exhausted) {
    const targetAgeMs = requested ? 0 : 60 * 60e3;
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
  const targetAgeMs = requested ? 0 : Math.min(configuredTarget, Math.max(0, cacheTtlMs - leadMs));
  if (cacheAgeMs < targetAgeMs) return null;
  const warm = !exhausted && cacheAgeMs < cacheTtlMs;
  return {
    path: warm ? 'warm-current' : 'cold-fallback',
    originalModel: model,
    targetModel: warm ? model
      : session.kind === 'claude' ? (opts.claudeFallbackModel || 'opus')
        : (opts.codexFallbackModel || 'gpt-5.6-sol'),
    cacheAgeMs,
    cacheTtlMs,
    targetAgeMs,
    ...(exhausted ? { reason: 'model-exhausted', exhaustedResetAt: opts.modelResetAt?.(session) ?? null } : {}),
  };
}

// Reopen has no idle target window or maximum age. Take this snapshot before the
// resumed agent writes startup records, since those can make a cold cache look new.
function reopenCompactPolicy(session, now = Date.now(), opts = {}) {
  if (!['claude', 'codex'].includes(session?.kind)) return null;
  const contextTokens = Number(session.contextTokens);
  if (!Number.isFinite(contextTokens) || contextTokens < (opts.minTokens ?? 100000)) return null;
  const model = String(session.model || '').trim();
  if (!model) return null;
  const families = opts.premiumFamilies || ['fable', 'astra'];
  const premium = families.some((family) => compactModelContainsFamily(model, family));
  const fallbackTtlMs = session.kind === 'codex'
    ? (opts.codexTtlMs ?? 30 * 60e3) : (opts.claudeTtlMs ?? 60 * 60e3);
  const cacheTtlMs = session.kind === 'claude' && Number.isFinite(session.cacheTtlMs)
    ? session.cacheTtlMs : fallbackTtlMs;
  const exhausted = opts.modelExhausted?.(session) === true;
  const warm = !opts.forceCold && !exhausted
    && Number.isFinite(session.usageAt) && session.usageAt > 0
    && now >= session.usageAt && now - session.usageAt < cacheTtlMs;
  return {
    path: premium && !warm ? 'cold-fallback' : 'warm-current',
    // Same meaning as autoCompactPolicy's: the restore after this fallback must wait for
    // the spent window rather than type a /model the API will refuse.
    ...(premium && exhausted ? { reason: 'model-exhausted', exhaustedResetAt: opts.modelResetAt?.(session) ?? null } : {}),
    originalModel: model,
    targetModel: premium && !warm
      ? session.kind === 'codex' ? (opts.codexFallbackModel || 'gpt-5.6-sol')
        : (opts.claudeFallbackModel || 'opus') : model,
    cacheTtlMs,
    cacheAgeMs: Number.isFinite(session.usageAt) ? now - session.usageAt : null,
    premium,
  };
}

function reopenPremiumFamilies() {
  return envString('KEEP_REOPEN_COMPACT_PREMIUM_MODELS', 'fable,astra')
    .split(',').map((family) => family.trim().toLowerCase()).filter(Boolean);
}

const reopenCompactAttempts = new Map();

function reopenHandoffSnapshotFile(root, sessionId) {
  return path.join(root, '.keep', 'compact', `${sessionId}.reopen-snapshot`);
}

function readReopenHandoffSnapshot(root, sessionId, accountId) {
  let record;
  try { record = JSON.parse(fs.readFileSync(reopenHandoffSnapshotFile(root, sessionId), 'utf8')); }
  catch { return null; }
  const turn = record?.turn;
  if (record?.sessionId !== sessionId || record?.accountId !== accountId || !turn
      || typeof turn.model !== 'string' || !keep.LAUNCH_MODEL_RE.test(turn.model)
      || !Number.isFinite(turn.contextTokens) || turn.contextTokens < 0
      || (turn.usageAt != null && !Number.isFinite(turn.usageAt))
      || (turn.cacheTtlMs != null && !Number.isFinite(turn.cacheTtlMs))) return null;
  return turn;
}

function writeReopenHandoffSnapshot(root, sessionId, accountId, turn) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !accounts.ID_RE.test(accountId)) return;
  if (!keep.LAUNCH_MODEL_RE.test(String(turn.model || ''))
      || !Number.isFinite(turn.contextTokens)
      || turn.contextTokens < envNumber('KEEP_AUTO_COMPACT_MIN_TOKENS', 100000)) return;
  writeCompactSwapRecord(reopenHandoffSnapshotFile(root, sessionId), {
    sessionId, accountId, turn: {
      model: turn.model, contextTokens: turn.contextTokens,
      usageAt: Number.isFinite(turn.usageAt) ? turn.usageAt : null,
      cacheTtlMs: Number.isFinite(turn.cacheTtlMs) ? turn.cacheTtlMs : null,
    },
  });
}

function clearReopenHandoffSnapshot(root, sessionId) {
  try { fs.unlinkSync(reopenHandoffSnapshotFile(root, sessionId)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function reopenTurnSnapshot(session, deps = {}, launchModel = '') {
  const turn = (deps.sessionLastTurn || sessionLastTurn)(session, deps);
  let model = launchModel || turn.model;
  if (session.kind === 'claude' && (!deps.sessionLastTurn || deps.reopenEffectiveModel) && !launchModel) {
    // A /model command after the last assistant usage is authoritative. The
    // handoff reader scans through those commands and preserves [1m] exactly.
    model = (deps.reopenEffectiveModel || handoffCurrentModel)(session, null, '', deps);
    if (model === '<unknown>') return { ...turn, model: '' };
  }
  return { ...turn, model, usageAt: model === turn.model
    ? turn.usageAt : null };
}

async function compactReopenedSession(session, target, account, turn, deps = {}) {
  if (deps.reopenCompaction === 'skip') return null;
  const dir = deps.dir || path.join(deps.root || keep.ROOT, '.keep', 'compact');
  if (compactRestoreBlocking(session.id, { ...deps, dir })) {
    throw new InjectionError(409, 'model restore is pending; opening message was not delivered');
  }
  const families = reopenPremiumFamilies();
  const policy = reopenCompactPolicy({ ...session, ...turn }, Date.now(), {
    minTokens: envNumber('KEEP_AUTO_COMPACT_MIN_TOKENS', 100000),
    premiumFamilies: families,
    forceCold: deps.reopenForceCold === true,
    modelExhausted: (candidate) => compactModelExhausted(candidate,
      { usage: usageSnapshot(deps), now: Date.now(), accountId: account.id }),
    modelResetAt: (candidate) => compactModelResetAt(candidate,
      { usage: usageSnapshot(deps), now: Date.now(), accountId: account.id }),
    claudeTtlMs: envNumber('KEEP_AUTO_COMPACT_CLAUDE_TTL_MIN', envNumber('KEEP_CACHE_TTL_MIN', 60)) * 60e3,
    codexTtlMs: envNumber('KEEP_AUTO_COMPACT_CODEX_TTL_MIN', 30) * 60e3,
    claudeFallbackModel: compactViaModel({ configDir: session.kind === 'claude' && account.configDir ? path.resolve(account.configDir) : '' }),
    codexFallbackModel: envString('KEEP_AUTO_COMPACT_CODEX_FALLBACK_MODEL', 'gpt-5.6-sol'),
  });
  if (!policy) return null;
  const signature = JSON.stringify([account.id, policy.originalModel, turn.contextTokens, turn.usageAt]);
  if (reopenCompactAttempts.get(session.id) === signature) return null;
  const accountSettingsFile = session.kind === 'claude' ? path.join(account.configDir, 'settings.json') : undefined;
  if (session.kind === 'claude' && policy.path === 'cold-fallback') {
    const settings = (deps.readClaudeSettingsModel || readClaudeSettingsModel)(accountSettingsFile);
    if (!settings.ok) {
      process.stderr.write(`keep serve: reopen compaction skipped ${sessionRef(session.id)}: account settings are unreadable (${settings.error})\n`);
      return { compacted: false, reason: `account settings are unreadable (${settings.error})` };
    }
  }
  await (deps.precheckSessionTarget || precheckSessionTarget)(session, target, deps);
  const result = await (deps.compactSession || compactSession)(
    { ...session, model: policy.originalModel, accountId: account.id }, target, null, {
      ...deps, dir, sessionLastTurn: () => turn, compactionPolicy: policy, compactFamilies: families,
      compactSettingsFile: accountSettingsFile,
      compactAccountId: account.id,
    });
  if (result?.restoreUnconfirmed || result?.reason === 'timeout'
      || (!result?.compacted && result?.attemptStage === 'submitted')) {
    throw new InjectionError(409, `reopen compaction ${result.reason || 'model restore unconfirmed'}; opening message was not delivered`);
  }
  if (result?.compacted) {
    reopenCompactAttempts.delete(session.id);
    reopenCompactAttempts.set(session.id, signature);
    if (reopenCompactAttempts.size > 1024) reopenCompactAttempts.delete(reopenCompactAttempts.keys().next().value);
  }
  if (!result?.compacted) process.stderr.write(`keep serve: reopen compaction skipped ${sessionRef(session.id)}: ${String(result?.reason || 'unconfirmed').slice(0, 300)}\n`);
  return result;
}

function autoCompactCandidates(sessions, stamps, now, opts) {
  const candidates = [];
  for (const session of sessions || []) {
    // A session on another node is never a candidate: everything a compaction does
    // is local to the machine running the agent. The node comes from the pane the
    // tick already holds, so this costs no lookup.
    if (nodes.isRemotePane(session, paneRefEnv(opts))) continue;
    const idleMs = autoCompactIdleMs(session, stamps, now, opts);
    if (idleMs === null) continue;
    const policy = autoCompactPolicy(session, now, opts);
    if (!policy) continue;
    const contextTokens = Number(session.contextTokens);
    // A requested compaction has its own, lower floor: the agent knows its old context
    // is done with, which the sweep can only assume of a much larger one.
    const requested = opts.requested?.(session) === true;
    const minTokens = requested && Number.isFinite(opts.requestMinTokens) ? opts.requestMinTokens : opts.minTokens;
    if (!Number.isFinite(contextTokens) || contextTokens < minTokens) continue; // Avoid lossy work on small contexts.
    const stamp = stamps instanceof Map ? stamps.get(session.id) : stamps && stamps[session.id];
    if (stamp && stamp.mtime === session.mtime) {
      // A warm attempt that hit the model's own limit ends as `timeout` (Claude Code
      // answers "You've reached your ... limit" and the compaction never lands), so the
      // ordinary rule would strand the session until its mtime moved. When the policy
      // now knows the model is spent, let that stamp fall back; only a compaction that
      // succeeded or is still running is off limits.
      const spent = policy.reason === 'model-exhausted';
      const done = spent ? ['compacted', 'in-progress'] : ['would', 'compacted', 'timeout', 'in-progress'];
      const warmCanFallBack = stamp.path === 'warm-current' && policy.path === 'cold-fallback'
        && !done.includes(stamp.result);
      if (!warmCanFallBack) continue;
    }
    candidates.push({ session, idleMs, contextTokens, ...policy, ...(requested ? { requested: true } : {}) });
  }
  return candidates.sort((a, b) =>
    Number(!a.requested) - Number(!b.requested)
      || Number(a.path !== 'warm-current') - Number(b.path !== 'warm-current')
      || (a.session.usageAt + a.cacheTtlMs) - (b.session.usageAt + b.cacheTtlMs)
      || b.contextTokens - a.contextTokens);
}

function autoCompactDir() {
  return path.join(keep.ROOT, '.keep', 'compact');
}

// ---- compaction an agent asked for ----
//
// The daemon cannot tell from outside when a session is at a good stopping point;
// the agent can. `keep compact` from inside a session leaves a request here, and the
// next idle tick compacts that session without waiting out the cache clock. A request
// is a hint, not a promise: it expires, and a missing or unreadable one just means
// the sweep's own rules apply.
function compactRequestFile(sessionId, dir) {
  return path.join(dir, `${sessionId}.request.json`);
}

function writeCompactRequest(sessionId, options = {}) {
  const id = String(sessionId || '');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('bad compact session id');
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : envNumber('KEEP_COMPACT_REQUEST_TTL_MIN', 30) * 60e3;
  const reason = normalizedText(options.reason).slice(0, 300);
  const record = {
    sessionId: id, at: now, expiresAt: now + ttlMs, by: options.by === 'agent' ? 'agent' : 'api',
    ...(reason ? { reason } : {}),
  };
  writeCompactSwapRecord(compactRequestFile(id, options.dir || autoCompactDir()), record);
  return record;
}

function readCompactRequest(sessionId, dir = autoCompactDir()) {
  const id = String(sessionId || '');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(compactRequestFile(id, dir), 'utf8'));
    return record && typeof record === 'object' && !Array.isArray(record) && record.sessionId === id ? record : null;
  } catch { return null; }
}

function clearCompactRequest(sessionId, dir = autoCompactDir()) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId || ''))) return;
  try { fs.unlinkSync(compactRequestFile(sessionId, dir)); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}

function expiredCompactRequest(record, now = Date.now()) {
  return !record || !Number.isFinite(record.expiresAt) || record.expiresAt <= now;
}

// Every live request, once per tick. An expired or unreadable one is deleted here, so
// an agent that asked and then carried on working is not compacted an hour later.
function readCompactRequests(dir = autoCompactDir(), now = Date.now()) {
  const requests = new Map();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return requests; }
  for (const name of names) {
    if (!name.endsWith('.request.json')) continue;
    const id = name.slice(0, -'.request.json'.length);
    const record = readCompactRequest(id, dir);
    if (expiredCompactRequest(record, now)) {
      try { clearCompactRequest(id, dir); } catch {}
      continue;
    }
    requests.set(id, record);
  }
  return requests;
}

function gcAutoCompactStamps(now) {
  if (now - lastAutoCompactGc < 86400e3) return;
  lastAutoCompactGc = now;
  const dir = autoCompactDir();
  const cutoff = now - 7 * 86400e3;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.swap.json') || name.endsWith('.request.json')) continue;
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
    if (!name.endsWith('.json') || name.endsWith('.swap.json') || name.endsWith('.request.json')) continue;
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
  const sid = sessionRef(candidate.session.id) + (stamp.requested ? ' (requested)' : '');
  const title = JSON.stringify(normalizedText(candidate.session.title).slice(0, 120));
  const idle = Math.round(candidate.idleMs / 60e3);
  const context = Math.round(candidate.contextTokens / 1000);
  const model = normalizedText(stamp.model);
  const compactionModel = normalizedText(stamp.compactionModel) || 'unknown';
  const cacheAge = Math.round(Number(stamp.cacheAgeMs || 0) / 60e3);
  const pathReason = normalizedText(stamp.pathReason);
  const pathName = (normalizedText(stamp.path) || 'unknown') + (pathReason ? ` (${pathReason})` : '');
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
  const configuredMode = envString('KEEP_AUTO_COMPACT', 'off').toLowerCase();
  const sweep = ['dry', 'on'].includes(configuredMode);
  const now = Date.now();
  // Read before the mode check: an agent that asked to be compacted asked explicitly,
  // so its request is honoured even where the sweep is off. With the sweep off the
  // tick then considers the requested sessions only, and runs them as `on` would.
  const dir = deps.autoCompactDir || autoCompactDir();
  const requests = (deps.readCompactRequests || readCompactRequests)(dir, now);
  if (!sweep && !requests.size) return { ok: true, detail: 'nothing due' };
  const mode = sweep ? configuredMode : 'on';
  // A session with a pending model-swap record is not compacted on request. Its restore
  // (or a deferred one, waiting out a spent window) owns what model it runs next, and a
  // compaction would type that restore straight after, which is the wedge the deferral
  // exists to prevent. The request file stays, so it runs once the record clears.
  const swapPending = new Set();
  if (requests.size) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const name of names) if (name.endsWith('.swap.json')) swapPending.add(name.slice(0, -'.swap.json'.length));
  }
  const opts = {
    minIdleMs: 0,
    ttlMs: 0,
    maxIdleMs: envNumber('KEEP_AUTO_COMPACT_MAX_IDLE_MIN', 1440) * 60e3,
    minTokens: envNumber('KEEP_AUTO_COMPACT_MIN_TOKENS', 100000),
    requested: (session) => requests.has(session?.id) && !swapPending.has(session?.id),
    requestIdleMs: envNumber('KEEP_COMPACT_REQUEST_IDLE_MIN', 1) * 60e3,
    requestMinTokens: envNumber('KEEP_COMPACT_REQUEST_MIN_TOKENS', 30000),
    models: compactModelFamilies(),
    claudeTtlMs: envNumber('KEEP_AUTO_COMPACT_CLAUDE_TTL_MIN', envNumber('KEEP_CACHE_TTL_MIN', 60)) * 60e3,
    claudeTargetMs: envNumber('KEEP_AUTO_COMPACT_CLAUDE_TARGET_MIN', 50) * 60e3,
    claudeFallbackModel: compactViaModel(),
    codexTtlMs: envNumber('KEEP_AUTO_COMPACT_CODEX_TTL_MIN', 30) * 60e3,
    codexTargetMs: envNumber('KEEP_AUTO_COMPACT_CODEX_TARGET_MIN', 20) * 60e3,
    codexFallbackModel: envString('KEEP_AUTO_COMPACT_CODEX_FALLBACK_MODEL', 'gpt-5.6-sol'),
  };
  (deps.gcAutoCompactStamps || gcAutoCompactStamps)(now);
  const stamps = (deps.readAutoCompactStamps || readAutoCompactStamps)();
  // Transcript-derived `exited` only observes explicit exit commands, not process
  // death. Keep live host state here rather than in the cached transcript record.
  const panes = await (deps.listHostPanes || listHostPanes)({}, true);
  const panesBySession = hostPanesBySession(panes);
  const liveIds = new Set([...panesBySession.entries()]
    .filter(([, pane]) => pane.alive && pane.agentAlive !== false)
    .map(([id]) => id));
  // One snapshot read per tick, shared by every candidate. The cheap `scanSessions`
  // rows carry no accountId, so the pane that is running the session names it; a
  // single-account fleet falls back to the default.
  const usageSnapshot = deps.usageSnapshot !== undefined ? deps.usageSnapshot : readUsageCache();
  const minHeadroom = envNumber('KEEP_AUTO_COMPACT_MIN_HEADROOM', 0);
  let defaultClaudeAccountId;
  const claudeAccountId = (session) => {
    if (session.accountId) return session.accountId;
    const fromPane = panesBySession.get(session.id)?.meta?.accountId;
    if (fromPane) return fromPane;
    if (defaultClaudeAccountId === undefined) {
      try { defaultClaudeAccountId = accounts.defaultFor('claude').id; } catch { defaultClaudeAccountId = null; }
    }
    return defaultClaudeAccountId;
  };
  opts.modelExhausted = (session) => compactModelExhausted(session, {
    usage: usageSnapshot, now, minHeadroom, accountId: claudeAccountId(session),
  });
  opts.modelResetAt = (session) => compactModelResetAt(session, {
    usage: usageSnapshot, now, accountId: claudeAccountId(session),
  });
  // Bounded: this only picks candidates; the chosen one is re-read by
  // loadCurrentSession under the lock before anything is typed.
  const cheap = (deps.scanSessions || scanSessions)({ fresh: false }).filter((session) =>
    (sweep || opts.requested(session))
    && liveIds.has(session.id) && autoCompactIdleMs(session, stamps, now, opts) !== null);
  const candidates = autoCompactCandidates(
    cheap.map((session) => {
      // The pane says which machine the agent is on; the cheap scanSessions row
      // cannot. A session on another node is stamped and left there — its transcript
      // is not here to read, and autoCompactCandidates drops it for the same reason.
      const pane = panesBySession.get(session.id);
      if (nodes.isRemotePane(pane)) return { ...session, node: pane.node };
      return { ...session, ...(deps.sessionLastTurn || sessionLastTurn)(session) };
    }),
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
              // A requested compaction on a model with no fallback has no warm window to
              // miss, so the transaction's cache-deadline refusal must not apply to it.
              cacheUsageAt: freshCandidate.ownModel ? null : freshCandidate.session.usageAt,
              cacheTtlMs: freshCandidate.cacheTtlMs,
              cacheAgeMs: freshCandidate.cacheAgeMs,
              ...(freshCandidate.reason ? { reason: freshCandidate.reason, exhaustedResetAt: freshCandidate.exhaustedResetAt ?? null } : {}),
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
          process.stderr.write(`keep serve: auto-compact skipped ${sessionRef(candidate.session.id)} this tick: ${reason}\n`);
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
    // The request is spent once an attempt was made, whatever its outcome: the stamp
    // says what happened, and a retryable skip above never reaches here, so that
    // request waits for the next tick. An agent that still wants it can ask again. A
    // request held back by a pending swap is spent too if the sweep compacted anyway.
    if (candidate.requested || (result === 'compacted' && requests.has(candidate.session.id))) {
      try { (deps.clearCompactRequest || clearCompactRequest)(candidate.session.id, dir); }
      catch (e) { process.stderr.write(`keep serve: could not clear the compaction request for ${sessionRef(candidate.session.id)}: ${e.message}\n`); }
    }
  }

  const request = candidate.requested ? requests.get(candidate.session.id) : null;
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
    // Why this path, when it was not the cache clock that chose it. `reason` below
    // is the failure text, so the policy's reason gets its own field.
    ...(candidate.reason ? { pathReason: candidate.reason } : {}),
    // So _log.jsonl tells the agent-driven compactions from the sweep's own.
    ...(request ? {
      requested: true, requestBy: String(request.by || ''),
      ...(request.reason ? { requestReason: String(request.reason) } : {}),
    } : {}),
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
    process.stderr.write(`keep serve: could not save auto-compact decision for ${sessionRef(stamp.sessionId)}: ${e.message}\n`);
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
  const held = loopHold.wrap('auto-compact', tick);
  setInterval(() => { void held(); }, 30e3).unref();
  setTimeout(() => { void held(); }, 15e3).unref();
}

// ---- the rate-limit transfer queue -------------------------------------
//
// bin/handoff-queue.js holds the entries and the retry policy. Everything it
// needs from the daemon arrives here: the live session rows (a transfer names a
// pane, so the host list has to be part of the state), the usage snapshot the
// policy reads, and handoffSession itself. Nothing else is handed over: the
// queue may only ask for the same transfer the console button asks for.
async function handoffQueueState(deps = {}) {
  const panes = await (deps.listHostPanes || listHostPanes)({}, true);
  return (deps.addHostSessionState || addHostSessionState)(
    await (deps.buildState || buildState)({ hostPanes: panes }), { panes });
}

async function handoffQueueSessions(deps = {}) {
  return (await (deps.handoffQueueState || handoffQueueState)(deps)).sessions || [];
}

// What the rateLimitHandoff policy reads on every tick. Only a session with a live
// Claude agent in a pane can be moved, so only those are resolved, each by its
// exact lookup, instead of a full state build over every transcript and pane. The
// policy only enqueues: an entry is transferred only after a fresh full build.
async function handoffPolicySessions(deps = {}) {
  const panes = await (deps.listHostPanes || listHostPanes)({}, true);
  if (!Array.isArray(panes)) return [];
  // A transfer stops an agent and proves it from this machine's process table, so a
  // pane on another node is never a candidate, as policyEnqueue itself refuses.
  const live = panes.filter((pane) => pane && pane.alive === true && pane.agentAlive !== false
    && pane.meta?.agent === 'claude' && !nodes.isRemotePane(pane));
  const lookup = deps.claudeSessionFor || ((id) => claudeSessionFor(id, { allowCachedMiss: true }));
  const sessions = [];
  for (const pane of hostPanesBySession(live).values()) {
    const id = pane.meta?.sessionId;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) continue;
    let session = null;
    try { session = lookup(id); } catch {}
    if (!session || !session.rateLimit) continue;
    // The pane's account wins over the transcript's, as it does in addHostSessionState.
    const accountId = typeof pane.meta.accountId === 'string' && pane.meta.accountId ? pane.meta.accountId : session.accountId;
    // The model the policy picks a target for, from the pane's launch record first.
    const model = launchModelId(pane.meta?.model) || session.model || '';
    // Whether Keep started it by itself: without a rateLimitHandoff key for its
    // source, only these are moved onto the automation pool.
    const unattended = pane.meta?.unattended === true || pane.meta?.reviewer === true;
    sessions.push({ ...session, id, kind: 'claude', pane: pane.id, ...(accountId ? { accountId } : {}),
      ...(model ? { model } : {}), unattended });
  }
  return sessions;
}

function handoffQueueTick(deps = {}) {
  return require('./handoff-queue').tick({
    root: keep.ROOT,
    sessions: () => handoffQueueSessions(deps),
    policySessions: () => (deps.handoffPolicySessions || handoffPolicySessions)(deps),
    readUsageCache,
    handoffSession: (body) => handoffSession(body),
    ...deps,
  });
}

async function handoffRateLimited(body, deps = {}) {
  return require('./handoff-queue').batch({
    root: deps.root || keep.ROOT,
    env: deps.env || process.env,
    sessions: await handoffQueueSessions(deps),
    sourceAccountId: body?.sourceAccountId,
    targetAccountId: body?.targetAccountId,
    ...(body?.force === undefined ? {} : { force: body.force }),
    ...(body?.sessionIds === undefined ? {} : { sessionIds: body.sessionIds }),
  });
}

function cancelQueuedHandoff(body, deps = {}) {
  return require('./handoff-queue').cancel(deps.root || keep.ROOT, body?.sessionId);
}

function startHandoffQueue() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await handoffQueueTick();
      health.record('handoff-queue', result.ok
        ? { ok: true, detail: result.detail }
        : { ok: false, error: result.error, detail: result.detail });
    }
    catch (e) {
      health.record('handoff-queue', { ok: false, error: e });
      process.stderr.write(`keep serve: handoff queue tick failed: ${e.message}\n`);
    }
    finally { running = false; }
  };
  const held = loopHold.wrap('handoff-queue', tick);
  setInterval(() => { void held(); }, 30e3).unref();
  setTimeout(() => { void held(); }, 20e3).unref();
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
  if (session.kind === 'pi') throw new InjectionError(409, 'Pi API message delivery is unavailable; type in its terminal pane');
  // Where this send is confirmed. The pane says where the keys go and the session
  // where its transcript is; a send whose two answers disagree is refused, and one on
  // another node takes its receipt from that node (deliver's `remote`). On a
  // single-node install both answers are this machine and `remote` stays null.
  const daemonNode = daemonNodeName(deps);
  const paneNode = nodes.parsePaneRef(String(target && target.pane || ''), { env: paneRefEnv(deps) }).node;
  // A session that carries no node is asked of its authority record, never taken
  // from the pane: a pane on another node whose meta names this id is not proof the
  // session lives there. sessionNodeOf reads nothing on a single-node install.
  const sessionNode = session.node ? String(session.node) : sessionNodeOf({ id: session.id }, deps);
  if (paneNode !== sessionNode) {
    throw new InjectionError(409, `pane ${target.pane} is on ${paneNode} but session ${session.id} is on ${sessionNode}; nothing was sent`);
  }
  let remote = null;
  if (sessionNode !== daemonNode) {
    const unsupported = remoteDeliveryRefusal({ id: session.id, node: sessionNode }, deps, session.kind);
    if (unsupported) throw unsupported;
    const onNode = { ...session, node: sessionNode };
    remote = {
      node: sessionNode,
      stat: () => nodeTranscriptFileForSession(onNode, deps),
      receipt: (entry, { timeoutMs } = {}) => deliveryReceiptFor(entry, deps, timeoutMs),
    };
  }
  // The same session read fresh, for the resume and draft checks below: off the local
  // transcript here, off the node's tail for a session elsewhere.
  const loadDeliverySession = (id) => (deps.loadDeliverySession ? deps.loadDeliverySession(id)
    : remote ? remoteSessionRead(id, deps)
    : session.kind === 'claude' ? claudeSessionFor(id) : codex.sessionFor(id));
  claimInjectionTarget(target);
  assertCompactRestoreSettled(session.id, deps);
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
  let promptProof = null;
  const bindPromptProof = async (proof) => {
    if (proof?.kind !== 'suggestion') return proof;
    const before = await livePaneState(target.pane, deps);
    const snapshot = deps.readScreenResult
      ? await deps.readScreenResult(target, 200, false)
      : await readScreenResult(target, 200, false, deps);
    const after = await livePaneState(target.pane, deps);
    const screen = String(snapshot?.text || '');
    if (!before || !after || before.pid !== after.pid || before.inputCount !== after.inputCount
        || before.pid !== proof.probeState?.pid || before.inputCount !== proof.probeState?.inputCount
        || !cursorAtInputStart(screen, snapshot?.cursor)
        || normalizedText(promptText(promptLine(screen)))
          !== normalizedText(promptText(promptLine(proof.settled?.screen)))) {
      throw new InjectionError(409, 'the input box changed after the prompt probe; message was not typed');
    }
    return { ...proof, stable: { pid: after.pid, inputCount: after.inputCount, screen } };
  };
  const checkedPromptProof = async () => {
    // Bind the probe's visual result to the counter from before its first key. Reading
    // a new baseline only after it returns would bless Tab+Home (or any two user keys)
    // that land in that gap as if they were the ghost suggestion we just proved.
    const before = await livePaneState(target.pane, deps);
    if (!before) throw new InjectionError(409, 'pane input activity could not be verified before the prompt check');
    const proof = await precheckSessionTarget(session, target, deps);
    const after = await livePaneState(target.pane, deps);
    const ownInputs = proof?.kind === 'suggestion' ? 2 : 0; // probe key plus its Backspace
    if (!after || after.pid !== before.pid || after.inputCount !== before.inputCount + ownInputs) {
      throw new InjectionError(409, 'input arrived while the prompt was checked; message was not typed');
    }
    return bindPromptProof({ ...proof, probeState: { pid: after.pid, inputCount: after.inputCount } });
  };
  const precheck = async () => {
  promptProof = await checkedPromptProof();
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
      promptProof = await checkedPromptProof();
    }
  }
  };
  const confirmation = session.kind === 'codex' ? codexTypedTextVisible : claudeTypedTextVisible;
  // The screen as draftMatches accepted it, for submitDraft to compare against. Raw,
  // not parsed: a parse can be talked into the same answer by text that looks like
  // composer chrome, and the rows of an idle session do not otherwise move. If they do
  // — a footer ticking over — the recovery is refused once and the next attempt takes
  // both reads again.
  let matchedScreen = null;
  // Whether the box holds anything after the draft exactDraft matched. exactDraft reads
  // from the last prompt glyph to the first blank line, so a line Owner added below one
  // is invisible to it; the box parser knows where the box ENDS, but guesses where it
  // starts and how wide the pane is from whatever else is on screen, so its text cannot
  // be compared with the message. Its lines can: from the last glyph in the box, past
  // the block exactDraft read, every remaining line has to be blank. Comparing tails
  // instead let "continue" / blank / "Actually, do not continue" through. A box that
  // cannot be parsed at all leaves exactDraft as the only witness.
  const nothingAfterDraft = (screenText) => {
    const region = draftRegionLines(screenText, session.kind);
    if (!region) return true;
    const prompt = session.kind === 'codex' ? /^\s*›(?:\s|$)/ : /^\s*❯(?:\s|$)/;
    let at = 0;
    region.lines.forEach((line, i) => { if (i > 0 && prompt.test(line)) at = i; });
    at += 1;
    while (at < region.lines.length && region.lines[at].trim()) at += 1;
    return region.lines.slice(at).every((line) => !line.trim());
  };
  try {
    // Claude does not transcript /mcp. A previously submitted command can be
    // recovered only while its native menu is still positively identified.
    if (observeMcp) await observeMcp();
    return await delivery.deliver({
      session, pane: target.pane, text, file: remote ? null : (deps.transcriptFileForSession || transcriptFileForSession)(session), remote, directory: pendingDirectory, trace,
      retainReceipt: opts?.retainReceipt === true,
      key: opts?.deliveryKey,
      observe: observeMcp,
      precheck,
      type: async (typingProgress) => {
        const resumingPartial = Boolean(typingProgress?.state);
        try {
          if (opts?.beforeType) await opts.beforeType();
          if (resumingPartial) {
            const current = await loadDeliverySession(session.id);
            if (!current || current.endedTurn !== true || current.pendingQuestion || current.pendingPlan) {
              throw new InjectionError(409, 'session is no longer idle enough to resume its partial delivery; no key was pressed');
            }
          }
          return await typeAndSubmit(target, text, confirmation, {
            ...deps, deliveryTrace: trace, draftKind: session.kind, typingProgress, promptProof,
          });
        } catch (error) {
          if (resumingPartial && error && typeof error === 'object') error.priorPartialDelivery = true;
          throw error;
        }
      },
      submitDraft: async () => {
        if (opts?.beforeType) await opts.beforeType();
        // draftMatches() ran before that await, and every millisecond since is one in
        // which Owner can have typed into the box. Read it again and leave a mixed
        // draft alone rather than submit it.
        //
        // draftMatches decided the box holds our message and nothing after it. All
        // that is left to ask is whether anything moved since: the same read, compared
        // whole.
        const screen = await readScreenResult(target, 200, false, deps);
        const unchanged = matchedScreen !== null && String(screen.text || '') === matchedScreen;
        if (!unchanged || !exactDraft(screen.text, text, session.kind)) {
          trace('draft-changed-before-enter');
          throw new InjectionError(409, 'the recovered draft changed before Enter; Enter was not pressed');
        }
        // From here the message may arrive: a caller deciding whether to give a
        // reservation back has to see that, exactly as it does for a first send.
        trace('enter-start');
        return pressTargetKey(target, 'Enter', deps);
      },
      draftMatches: async () => {
        const current = await loadDeliverySession(session.id);
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
        const matched = exactDraft(screen.text, text, session.kind) && nothingAfterDraft(screen.text);
        trace('draft-screen-check', { cursorInPrompt, matched });
        matchedScreen = cursorInPrompt && matched ? String(screen.text || '') : null;
        return cursorInPrompt && matched;
      },
      // The turn index's guard (bin/delivery.js) asks a different question from
      // draftMatches: not "is this exact draft ready to submit" but "is this text in
      // the box at all". draftMatches answers false without looking whenever the
      // session is mid-turn or showing a question or plan, which is exactly when
      // Claude may be holding an earlier identical message in its queue and write
      // that message's row late; the index would then confirm a send whose text is
      // still sitting in the box. So this reads the screen whatever the session is
      // doing and applies the same exactDraft comparison, with none of the idle,
      // cursor or nothing-after gates: each of those can only turn a draft that is
      // there into "not there", and here that error confirms a lost message. It
      // leaves matchedScreen alone, which belongs to the submit path.
      draftOnScreen: async () => {
        const screen = await readScreenResult(target, 200, false, deps);
        const matched = exactDraft(screen.text, text, session.kind);
        trace('index-draft-screen-check', { matched });
        return matched;
      },
      indexDb: deps.turnIndexDb,
    });
  } catch (error) {
    const failure = error instanceof InjectionError ? error : new InjectionError(409, error.message);
    // Read by bin/watcher-live.js: a reservation may only be given back when
    // nothing was typed.
    failure.typingStarted = error?.draftCleared
      ? false
      : error?.priorPartialDelivery
        ? true
        : error?.nothingTyped
          ? false
          : typingStarted || Boolean(error && error.typingStarted);
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

  // A session on another node is read from its node (loadSessionForAction); every
  // other one exactly as before. Awaited, so an injected loader may be either kind.
  const session = await (deps.loadCurrentSession || ((id) => loadSessionForAction(id, deps)))(body.sessionId);
  const target = claimInjectionTarget(await (deps.resolveSessionTarget || resolveSessionTarget)(
    session, body.pane ? { expectedPane: body.pane } : targetHint, deps,
  ));
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
  const request = body && typeof body === 'object' ? { ...body } : {};
  return withInjectionLock(async () => {
    const root = deps.root || keep.ROOT;
    const retirement = require('./session-retirement');
    const entry = retirement.lookup(root, request.sessionId);
    if (entry?.automatic === true) {
      const panes = await (deps.listHostPanes || listHostPanes)(deps, true);
      if (!Array.isArray(panes)) throw new InjectionError(503, 'terminal host is unavailable; retired session cannot be resumed');
      const matching = panes.filter((pane) => pane?.alive && pane.meta?.sessionId === request.sessionId
        && ['claude', 'codex'].includes(pane.meta?.agent));
      const live = matching.some((pane) => pane.agentAlive === true);
      if (!live && matching.some((pane) => pane.agentAlive !== false)) {
        throw new InjectionError(409, 'retired session agent liveness is unknown; retry after the host refreshes');
      }
      if (!live) {
        await (deps.openSession || openSession)({ sessionId: request.sessionId }, deps);
      }
      // A successful open (or proof it was already open) makes the retirement
      // historical. Drop the old pane hint before delivery: resume owns a new pane.
      retirement.clear(root, request.sessionId);
      delete request.pane;
    }
    return sendToSession(request, undefined, undefined, deps);
  },
    { session: request.sessionId, pane: request.pane, model: modelCommandText(request.text) });
}

// Resume a session that stalled on a usage limit. The scheduler decided this a
// tick ago, from a snapshot of the transcript, and outside the injection lock —
// in between, Owner can have typed, the session can have started a tool, or a
// permission prompt can have appeared. So every precondition is checked again
// here, inside the lock, against a freshly read session and the live screen:
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
    // The pane this would type into, and the transcript that says it is parked,
    // both have to be this machine's. A direct caller is refused here the way the
    // scheduler's session list refuses one before it ever decides.
    const node = sessionNodeOf({ sessionId, pane: session && session.pane }, deps);
    if (node !== daemonNodeName(deps)) {
      throw new InjectionError(409, `rate-limit resume is not available for a session on ${node}`);
    }
    // 'session moved on' is the one refusal that is not a failure: nothing went
    // wrong, the stall simply ended, so the caller drops the entry instead of
    // spending an attempt on it.
    const movedOn = (why) => new InjectionError(409, `session moved on before resume (${why})`);
    const verifyParked = (s) => {
      if (s.kind !== 'claude') throw movedOn('not a Claude session');
      if (!s.rateLimit || s.rateLimit.at !== hitAt) throw movedOn('no longer parked on that limit');
      // The scanner never reports endedTurn for a limit error: Claude Code writes that
      // synthetic record with stop_reason "stop_sequence", not end_turn. With rateLimit
      // verified as the last real event above, "ended" means nothing else is in flight.
      const parkedIdle = s.endedTurn === true
        || (!s.toolRunning && !s.pendingOther && !(s.unknownBackgroundJobs || []).length);
      if (!parkedIdle) throw movedOn('mid-turn');
      if (s.toolRunning) throw movedOn('a tool is running');
      if (s.pendingQuestion || s.pendingPlan) throw movedOn('waiting on a person');
      if (s.notify && ['permission', 'question'].includes(s.notify.type)) {
        throw movedOn(`showing a ${s.notify.type}`);
      }
    };
    verifyParked(session);
    const target = claimInjectionTarget(await resolve(session, null));
    // The transcript can say "parked" while the pane says otherwise (a restarted
    // Claude, a shell prompt, a dialog). Only type when the input box is on screen.
    const screen = await screenOf(target, 30, false);
    if (!agentPromptVisible('claude', screen)) {
      throw new InjectionError(409, 'no Claude prompt visible', { screenTail: screenTail(screen) });
    }
    // Resolving the pane and reading the screen are awaits: the session can have
    // taken a prompt, started a tool or hit the window again while they ran. The
    // transcript is re-read here so the checks describe the session being typed
    // into, not the one the scheduler saw a screen read ago.
    const fresh = load(sessionId);
    verifyParked(fresh);
    if (Number.isFinite(fresh.mtime) && Number.isFinite(session.mtime) && fresh.mtime !== session.mtime) {
      throw movedOn('transcript changed');
    }
    return deliver(fresh, target, text);
  }, { session: sessionId });
}

async function compactSessionById(body) {
  body = body && typeof body === 'object' ? body : {};
  const session = loadCurrentSession(body.sessionId);
  if (session.kind === 'pi') throw new InjectionError(409, 'Pi automatic compaction is unavailable');
  const target = claimInjectionTarget(await resolveSessionTarget(session, null));
  await precheckSessionTarget(session, target);
  return compactSession(session, target, body.instruction || (session.reviewer ? review.DEFAULT_REVIEW_COMPACT_INSTRUCTION : undefined));
}

// `keep compact` from inside a session: leave a request for the idle tick rather than
// compact now. The caller is usually mid-turn — that is where the command runs — and
// a session cannot be compacted while its own turn is in progress. Takes no lock:
// nothing is typed, and the tick re-checks everything under the lock before it acts.
function requestSessionCompaction(body, deps = {}) {
  body = body && typeof body === 'object' ? body : {};
  const session = (deps.loadCurrentSession || loadCurrentSession)(body.sessionId);
  if (session.kind === 'pi') throw new InjectionError(409, 'Pi automatic compaction is unavailable');
  // Reviewers have their own context-pressure policy, which the sweep also leaves them to.
  if (session.reviewer) throw new InjectionError(409, 'a reviewer session is compacted by its own policy, not on request');
  // The tick never compacts a session on another node, so a request for one would
  // only sit there until it expired.
  refuseRemoteCompaction(session, deps);
  const record = writeCompactRequest(session.id, {
    by: body.by === 'agent' ? 'agent' : 'api', reason: body.reason, dir: deps.dir,
  });
  return { ok: true, requested: true, sessionId: session.id, expiresAt: record.expiresAt };
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
    // resolveRollout reads the scan map itself and checks it against the session's
    // account, where rolloutFileFor alone would trust a rollout the session left
    // behind on its source account; answerSession's load no longer scans
    // (loadCurrentSession), so this is also what finds a rollout no scan walked.
    const rolloutFile = codex.resolveRollout(session.id)?.file;
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
// How long a dialog must still be live after it is first seen before a wait refuses,
// and the room a wait keeps so that confirming read always happens.
const DIALOG_CONFIRM_MS = 300;
const DIALOG_CONFIRM_GRACE_MS = 600;

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

// Codex's update notice: "✨ Update available! 0.155.1 -> 0.156.1". In the chat history
// it is information, and the prompt below it still takes a message; as the startup
// update prompt ("Update now (runs `npm install -g @openai/codex`)", "Skip", "Skip
// until next version", "Press enter to continue") it holds the pane before any prompt,
// and Keep never answers it: it would install software on Owner's machine. The notice
// is read only at a line's start (quoted text in a tool result is not Codex's own), and
// the prompt only by its own options: "Press enter to continue" or "[y/N]" under a
// notice can be another dialog's (the model-migration prompt), so they only enrich the
// timeout's message, which names the dialog when it is one Codex is known to show:
// the model-migration prompt ("Press enter to continue" with no update options) and
// the hook trust review ("review required"). Returns { from, to, prompt, asks, dialog }
// for a screen showing the notice (dialog null, 'model-migration' or 'hook-trust'),
// null otherwise. The sparkle may carry an emoji presentation selector (U+FE0F).
const CODEX_UPDATE_VERSION = String.raw`v?(\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.]{1,24})?)`;
const CODEX_UPDATE_RE = new RegExp(String.raw`^\s{0,40}(?:✨\uFE0F?\s{0,8})?Update available!\s{0,8}${CODEX_UPDATE_VERSION}\s{0,8}(?:->|→)\s{0,8}${CODEX_UPDATE_VERSION}`);
const CODEX_UPDATE_PROMPT_RE = /Update now \(runs|Skip until next version/;
const CODEX_UPDATE_ASKS_RE = /Press enter to continue|\[y\/N\]/i;
const CODEX_MIGRATION_ASKS_RE = /Press enter to continue/i;
const CODEX_HOOK_TRUST_RE = /review required/i;

function codexUpdateNotice(screen) {
  const lines = stripTerminalAnsi(String(screen || '')).split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = CODEX_UPDATE_RE.exec(lines[index].slice(0, 400));
    if (!match) continue;
    // The prompt's options sit under its title; anything further off is another screen's.
    const under = lines.slice(index + 1, index + 13);
    const prompt = under.some((line) => CODEX_UPDATE_PROMPT_RE.test(line));
    const asks = prompt || under.some((line) => CODEX_UPDATE_ASKS_RE.test(line));
    const dialog = prompt ? null : under.some((line) => CODEX_HOOK_TRUST_RE.test(line)) ? 'hook-trust'
      : under.some((line) => CODEX_MIGRATION_ASKS_RE.test(line)) ? 'model-migration' : null;
    return { from: match[1], to: match[2], prompt, asks, dialog };
  }
  return null;
}

function codexUpdateMessage(target, notice, deps = {}) {
  // Another dialog Codex is known to show, under a notice from its history: named for
  // itself, since the update is not what holds the pane.
  if (notice.dialog === 'model-migration') {
    return `codex in ${target.pane} is waiting at its model migration prompt; answer it in the pane`;
  }
  if (notice.dialog === 'hook-trust') {
    return `codex in ${target.pane} is waiting at its hook trust review (see keep doctor's Codex hook trust row); answer it in the pane`;
  }
  let node = '';
  try { node = sessionNodeOf(String(target.pane || ''), deps); } catch { node = ''; }
  const asking = notice.asks && !notice.prompt ? ', and a prompt under it waits for an answer' : '';
  return `codex in ${target.pane} is waiting at its update prompt (${notice.from} -> ${notice.to})${asking}; answer it in the pane or update Codex on ${node || 'its node'}`;
}

// What a refusal that names the notice carries: awaitingUpdate only when it is the
// update that holds the pane, else which other dialog does (additive).
const codexNoticeExtra = (notice) => (notice.dialog ? { awaitingDialog: notice.dialog } : { awaitingUpdate: true });

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
  let deadline = now() + AGENT_PROMPT_TIMEOUT_MS;
  let screen = '', refusedDialog = null, refusalGrace = false;
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
    // A modal is why the prompt is not there, and no wait resolves one: only Owner can
    // answer it (Keep types into a dialog nowhere but the worktree-exit prompt, and only
    // during a restart). Say which dialog, now, instead of timing out in 45s with a
    // message about an empty prompt.
    if (agent === 'claude') {
      const plain = stripTerminalAnsi(screen);
      const dialog = claudePrompts.recognize(plain);
      // A trust screen this module cannot read as a dialog -- its option list and
      // wording move from release to release -- is still a trust screen, and no wait
      // resolves one: an account handoff into an untrusted worktree waited this out on
      // 2026-09-17 and reported nothing but "never showed an empty prompt" 45 seconds
      // later. Confirmed across the same two reads a recognized dialog needs.
      const trustScreen = !dialog && claudeTrustScreen(plain);
      const refusing = trustScreen ? { kind: 'workspace-trust' } : dialog && dialog.live
        && claudePrompts.policyFor(dialog.kind).action === 'refuse' ? dialog : null;
      // Two reads a poll apart, or none: a single frame can catch a dialog Owner is
      // already dismissing, and that wait used to finish on the next poll.
      if (refusing && refusedDialog && refusedDialog.kind === refusing.kind
          && now() - refusedDialog.at >= DIALOG_CONFIRM_MS) {
        if (trustScreen) {
          throw new InjectionError(409, `${agent} is awaiting workspace trust in pane ${target.pane}; accept it there, then retry delivery`, {
            awaitingSetup: true, setupKind: 'workspace-trust', screenTail: screenTail(screen),
          });
        }
        throw new InjectionError(409, `Claude Code is showing the ${claudePrompts.refusalLabel(refusing)} dialog in ${target.pane}; message not sent`, {
          screenTail: screenTail(screen),
        });
      }
      if (!refusing) refusedDialog = null;
      else if (!refusedDialog || refusedDialog.kind !== refusing.kind) {
        refusedDialog = { kind: refusing.kind, at: now() };
        // A dialog first seen as the deadline arrives would expire before the read that
        // confirms it, and the caller would get the generic timeout for a pane that is
        // plainly parked on a dialog. Extend once, by just enough for that one read.
        if (!refusalGrace && deadline - now() < DIALOG_CONFIRM_GRACE_MS) {
          refusalGrace = true;
          deadline = now() + DIALOG_CONFIRM_GRACE_MS;
        }
      }
    }
    // Codex's startup update prompt, confirmed across two reads as a Claude dialog is,
    // is refused by name and never answered. The notice alone, with no prompt under
    // it, may still be followed by the prompt: that is waited for, and named if the
    // wait runs out with the notice still on screen.
    if (agent === 'codex') {
      const notice = codexUpdateNotice(screen);
      if (notice && notice.prompt && refusedDialog && refusedDialog.kind === 'codex-update'
          && now() - refusedDialog.at >= DIALOG_CONFIRM_MS) {
        throw new InjectionError(409, `${codexUpdateMessage(target, notice, deps)}; message not sent`, {
          awaitingUpdate: true, screenTail: screenTail(screen),
        });
      }
      if (!notice || !notice.prompt) refusedDialog = null;
      else if (!refusedDialog) {
        refusedDialog = { kind: 'codex-update', at: now() };
        if (!refusalGrace && deadline - now() < DIALOG_CONFIRM_GRACE_MS) {
          refusalGrace = true;
          deadline = now() + DIALOG_CONFIRM_GRACE_MS;
        }
      }
    }
    await sleep(Math.min(500, Math.max(0, deadline - now())));
  }
  const notice = agent === 'codex' ? codexUpdateNotice(screen) : null;
  if (notice) {
    throw new InjectionError(504, `${codexUpdateMessage(target, notice, deps)}; message not sent`, {
      ...codexNoticeExtra(notice), screenTail: screenTail(screen),
    });
  }
  throw new InjectionError(504, `${agent} session in ${target.pane} never showed an empty prompt; message not sent`, {
    screenTail: screenTail(screen),
  });
}

async function readHostSessionId(pane, deps = {}) {
  try {
    const result = await (deps.hostRequest || hostRequest)('get', { pane }, deps);
    const sessionId = result && result.pane && result.pane.meta && result.pane.meta.sessionId;
    return typeof sessionId === 'string' && /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : null;
  } catch { return null; }
}

async function verifyFreshOpenPane(launch, expected, deps = {}) {
  let result;
  try { result = await (deps.hostRequest || hostRequest)('get', { pane: launch.pane }, deps); }
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

// A fresh Codex launch on another node. Codex names its session only when its first
// turn fires SessionStart, and on a node that hook reaches the daemon only for a
// session the daemon already places there: so the daemon asks the node which rollouts
// its account has begun since the launch, in the launch's directory (the transcript
// verb's `find`), and adopts one only when it is the only one there, the pane is still
// this launch's and unbound, and the node's own process table shows the pane's
// process holding that rollout open. Then the session's account record names it and
// its node, and the pane is bound to it on the node's host. Anything short of that
// adopts nothing, and says why.
const NODE_CODEX_FIND_SLACK_MS = 10e3;

async function adoptNodeCodexLaunch(launch, expected, deps = {}) {
  const node = expected.node;
  const request = deps.hostRequest || hostRequest;
  const refuse = (why) => ({ sessionId: null, why });
  if (!node || node === daemonNodeName(deps)) return refuse('not a launch on another node');
  let hello = null;
  try { hello = await request('hello', {}, { ...deps, node }); } catch {}
  if (!hello || !(Number(hello.transcript) >= 2)) return refuse(`the terminal host on ${node} cannot list its rollouts (update keep-tool there)`);
  let found;
  try {
    found = await request('transcript', {
      op: 'find', kind: 'codex', account: { id: expected.account.id, configDir: expected.account.configDir },
      sinceMs: Math.max(0, Math.floor(expected.launchedAt - NODE_CODEX_FIND_SLACK_MS)), cwd: expected.project,
    }, { ...deps, node });
  } catch (error) { return refuse(`${node} could not list its Codex rollouts: ${error && error.message || error}`); }
  const candidates = (Array.isArray(found && found.rollouts) ? found.rollouts : []).filter((entry) => entry
    && typeof entry.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(entry.id) && entry.child !== true && entry.headless !== true);
  const ids = [...new Set(candidates.map((entry) => entry.id))];
  if (!ids.length) return refuse(`no Codex rollout begun in ${expected.project} on ${node} since the launch`);
  if (ids.length > 1) return refuse(`${ids.length} Codex rollouts begun in ${expected.project} on ${node} since the launch; which is this one's cannot be told`);
  const [sessionId] = ids;
  const entry = candidates.find((candidate) => candidate.id === sessionId);
  // Still this launch's pane, and nobody's yet (a SessionStart that did reach the
  // daemon meanwhile has bound it, and that binding is the answer).
  const bound = await verifyFreshOpenPane(launch, expected, deps);
  if (bound) return { sessionId: bound };
  let pane;
  try { pane = (await request('get', { pane: launch.pane }, deps))?.pane; } catch {}
  if (!pane) return refuse(`host pane ${launch.pane} could not be read again`);
  let owns = false;
  try {
    owns = await (deps.codexOwnsPane || require('./codex-pane').ownsPane)(sessionId, pane, {
      node,
      sessionMetaFor: () => ({ id: sessionId, ...(entry.originator ? { originator: entry.originator } : {}) }),
      // Uncached: the process that began the rollout is seconds old, younger than the
      // table the pane list keeps for a moment.
      agentProcessRows: async () => {
        const result = await request('process', {}, { ...deps, node });
        return Array.isArray(result && result.rows) ? result.rows : [];
      },
      liveSessionPids: (given) => liveSessionPids({ ...deps, ...given }, { node }),
    });
  } catch { owns = false; }
  if (!owns) return refuse(`rollout ${sessionId} on ${node} is not held open by the process in ${launch.pane}`);
  let authority;
  try {
    authority = (deps.accountForSession || accounts.forSession)(sessionId, 'codex', {
      root: deps.root || keep.ROOT, env: deps.env || process.env, allowDiscovery: false,
    });
  } catch (error) { return refuse(error.message); }
  if (authority && authority.id !== expected.account.id) return refuse(`session ${sessionRef(sessionId)} is pinned to account ${authority.id}`);
  // Pinned before the bind, so the node's hooks for it, once the pane names it, find
  // it placed and never race late adoption for the launch record.
  (deps.pinSession || accounts.pinSession)(sessionId, 'codex', expected.account.id,
    { root: deps.root || keep.ROOT, env: deps.env || process.env, node });
  let settled = null;
  let bindError = null;
  try {
    await request('meta', { pane: launch.pane, patch: { sessionId, agent: 'codex', project: expected.project } }, deps);
    settled = await readHostSessionId(launch.pane, deps);
  } catch (error) { bindError = error; }
  if (!bindError && settled === sessionId) return { sessionId };
  // The bind did not hold: the open learns no session, and the launch record goes
  // too, or late adoption could later take whatever session that pane names.
  let dropped = false;
  let card = null;
  if (expected.requestId != null) {
    // Read before it goes: the card a card open recorded, which nothing else would
    // put the session on once the record is consumed.
    const recorded = (deps.readNodeCodexLaunch || require('./late-adoption.js').readNodeCodexLaunch)(
      deps.root || keep.ROOT, node, expected.requestId);
    card = recorded && typeof recorded.card === 'string' ? recorded.card : null;
    try {
      (deps.consumeNodeCodexLaunch || require('./late-adoption.js').consumeNodeCodexLaunch)(
        deps.root || keep.ROOT, node, expected.requestId);
      dropped = true;
    } catch (error) {
      process.stderr.write(`keep serve: could not drop the Codex launch record for ${launch.pane}: ${error.message}\n`);
    }
  }
  // The session is pinned to the node all the same: on the card, so it is not left
  // placed but ownerless. The requester keeps the card too; the open fails.
  if (dropped && card && deps.linkLaunchedSession !== skipCardLink) {
    try {
      if (!(deps.linkLaunchedSession || keep.linkLaunchedSession)(card, { id: sessionId, agent: 'codex', node })) {
        process.stderr.write(`keep serve: could not link ${sessionRef(sessionId)} to ${card}: no such card\n`);
      }
    } catch (error) {
      process.stderr.write(`keep serve: could not link ${sessionRef(sessionId)} to ${card}: ${error.message}\n`);
    }
  }
  const why = bindError
    ? `host pane ${launch.pane} could not be bound to ${sessionRef(sessionId)}: ${bindError && bindError.message || bindError}`
    : `host pane ${launch.pane} was bound to ${settled || 'nothing'} instead`;
  return { ...refuse(why), ...(dropped ? { launchDropped: true } : {}) };
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

// The Keep Pi extension's phase for one session, read where the session runs: the
// registry's own .keep/pi-events on the daemon node, exactly as always, and the
// node's through its `transcript` verb (op pi-event) anywhere else. The node read
// throws when the node cannot answer; piEventFor takes that as no signal.
// The Keep CLI a Pi pane's extension runs its hooks with: this checkout's, which the
// shared home puts at the same path on every node.
const PI_KEEP_CLI = path.join(__dirname, 'keep.js');

async function readNodePiEvent(sessionId, node, deps = {}) {
  const answer = await (deps.hostRequest || hostRequest)('transcript',
    { op: 'pi-event', kind: 'pi', sessionId }, { ...deps, node });
  const event = answer && answer.event;
  return event && typeof event === 'object' && event.id === sessionId
    && ['start', 'running', 'settled', 'shutdown', 'prompt'].includes(event.phase) ? event : null;
}

async function piEventFor(sessionId, node, deps = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(sessionId || ''))) return null;
  if (!node || node === launchDaemonNode(deps)) {
    return (deps.piEventFor || pi.eventFor)(sessionId, path.join(deps.root || keep.ROOT, '.keep', 'pi-events'));
  }
  try { return await readNodePiEvent(sessionId, node, deps); } catch { return null; }
}

// Whether a Pi session can be started on another node: its host reads Pi phase files
// (transcript verb 3), Pi's account is set up there, the Keep Pi extension is
// installed where that Pi will look for it, and the Keep CLI the pane's
// KEEP_PI_KEEP_CLI names (this checkout's bin/keep.js) is there too. Asked of the node
// itself, before the pane. A node too old to answer the last is not refused for it.
async function assertNodePiReady(node, account, project, deps = {}) {
  const hello = await (deps.hostRequest || hostRequest)('hello', {}, { ...deps, node });
  if (!hello || !(Number(hello.transcript) >= 3)) {
    throw new InjectionError(409, `the terminal host on ${node} cannot read Pi session state; update keep-tool on ${node} and reload its host`);
  }
  let checked;
  try {
    checked = await prepareLaunchOn(node, {
      agent: 'pi', check: true, cwd: project, argv: ['pi'], piKeepCli: PI_KEEP_CLI,
      account: { id: account.id, agent: account.agent, configDir: account.configDir,
        builtIn: account.builtIn === true, managed: account.managed === true },
    }, deps);
  } catch (error) {
    if (error && ['shared-setup', 'account-missing', 'home-mismatch'].includes(error.code)) throw new InjectionError(409, error.message);
    throw error;
  }
  if (!checked || checked.piExtension !== true) {
    throw new InjectionError(409, `Pi Keep extension is not installed on ${node}`);
  }
  if (checked.piKeepCli === false) {
    throw new InjectionError(409, `the Keep CLI the Pi extension runs (${PI_KEEP_CLI}) is not on ${node}; install keep-tool at that path there`);
  }
}

// A start phase stamped on another node is stamped by that node's clock, and
// launchedAt by this one's: node clocks drift (an NTP step, a VM resumed from
// suspend), and a start a few seconds "before" its launch is still this launch's, since
// a fresh session id has no earlier phase file. So another node's phase gets 5 s of
// slack; the daemon node's own keeps its 1 s.
const PI_START_SLACK_MS = 1000;
const PI_START_NODE_SLACK_MS = 5000;

async function waitForPiStart(id, launchedAt, deps = {}, node = null) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + 12000;
  const slack = node && node !== launchDaemonNode(deps) ? PI_START_NODE_SLACK_MS : PI_START_SLACK_MS;
  while (now() < deadline) {
    const event = await piEventFor(id, node, deps);
    if (event && Date.parse(event.at || '') >= launchedAt - slack && event.phase !== 'shutdown') return event;
    await sleep(150);
  }
  throw new InjectionError(504, `Pi started but its Keep extension did not register session ${sessionRef(id)}; check the pane for extension errors`);
}

// The lock may be held by a delivery that started during the wait; give it a
// moment rather than failing the launch after the agent is already up.
async function withInjectionLockRetry(fn, deps = {}, scope) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (deps.injectionLockRetryMs ?? 10000);
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

// A card tag that may say a session needs something only some machines have. The tag
// and the capability are spelled the same on purpose: `keep nodes add --capabilities
// browser` and a card tagged `browser` are talking about one thing — but only on an
// install where some node declares that capability. Everywhere else these are just
// words somebody filed a card under, so placement takes them as hints, not demands.
const PLACEMENT_TAG_CAPABILITIES = ['browser', 'ios', 'android'];

function placementNodes(deps = {}) {
  if (Array.isArray(deps.placementNodes)) {
    return deps.placementNodes.map((node) => (typeof node === 'string'
      ? { name: node, capabilities: [] }
      : { name: node.name, capabilities: node.capabilities || [] }));
  }
  try {
    return require('./node-registry.js').listNodes(deps.env || process.env)
      .filter((node) => !node.invalid)
      .map((node) => ({ name: node.name, capabilities: node.capabilities || [] }));
  } catch {
    // Nobody could read the node list, so this install is one node as far as any
    // launch is concerned: the daemon node, with nothing claimed about it.
    return [{ name: daemonNodeName(deps), capabilities: [] }];
  }
}

// The machines a console may offer a new session or a move to, the daemon node first:
// what each one can do, and whether it answered the last pane list. Reachability is
// the host status's own (only the other nodes are in it); the daemon node is always
// reachable as far as its own console is concerned. A single-node install lists just
// the daemon node, so the console has one code path and hides the choice.
function consoleNodes(hostStatus, deps = {}) {
  const daemon = daemonNodeName(deps);
  const configured = placementNodes(deps);
  const reach = (hostStatus && hostStatus.nodes) || {};
  const own = configured.find((node) => node.name === daemon) || { name: daemon, capabilities: [] };
  return [own, ...configured.filter((node) => node.name !== daemon)].map((node) => {
    const capabilities = Array.isArray(node.capabilities) ? [...node.capabilities] : [];
    if (node.name === daemon) return { name: node.name, daemon: true, capabilities, ok: true };
    const status = Object.prototype.hasOwnProperty.call(reach, node.name) ? reach[node.name] : null;
    if (status && status.ok === false) {
      return { name: node.name, daemon: false, capabilities, ok: false, reason: status.reason || 'unreachable' };
    }
    return { name: node.name, daemon: false, capabilities, ok: true };
  });
}

// A session's unfinished move, as the console renders it: moving (no buttons), or
// waiting for a person (Retry / Abandon). Done and abandoned moves are history. A
// journal that says a move is in flight while this process runs none was left by a
// daemon that went away, and waits for the same recover or abandon as a failed one.
function consoleMove(record, running) {
  const failed = record.status === 'recovery-needed';
  const interrupted = !failed && !running;
  const phase = failed ? record.phase : record.status;
  const back = ['stopping', 'copying', 'staged'].includes(phase)
    ? `leaves it on ${record.from}` : `puts it back on ${record.from} once neither node runs it`;
  return {
    id: record.id, to: record.to, from: record.from,
    status: failed || interrupted ? 'recovery-needed' : 'in-flight',
    ...(phase ? { phase } : {}),
    ...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
    ...(failed && record.message ? { message: record.message } : {}),
    ...(interrupted ? { interrupted: true,
      message: `move ${record.id} of ${record.sessionId} was interrupted while ${phase}; Retry continues it, Abandon ${back}.` } : {}),
  };
}

// Adds `nodes` to a state build and `move` to each session with an unfinished move.
// One journal listing per build. Session rows are replaced, never edited, so a
// state object another waiter holds keeps what it was built with.
async function addNodeState(state, hostStatus, deps = {}) {
  const sessionMove = deps.sessionMove || require('./session-move');
  state.nodes = consoleNodes(hostStatus, deps);
  // Which moves this process runs, asked before the journal read and again after it:
  // a move that finishes while the journals are read has a journal still in flight and
  // no longer a runner, and is not shown as interrupted for it.
  const runningNow = () => {
    try { return new Set(typeof sessionMove.running === 'function' ? sessionMove.running() : []); }
    catch { return new Set(); }
  };
  const before = runningNow();
  let records = [];
  try { records = await sessionMove.listMovesAsync(deps.root || keep.ROOT); } catch {}
  const after = runningNow();
  const running = (sessionId) => before.has(sessionId) || after.has(sessionId) || sessionMove.isRunning(sessionId);
  const moves = new Map();
  for (const record of records) {
    if (!record || typeof record.sessionId !== 'string' || !sessionMove.IN_FLIGHT.includes(record.status)) continue;
    const held = moves.get(record.sessionId);
    if (held && (Number(held.createdAt) || 0) >= (Number(record.createdAt) || 0)) continue;
    moves.set(record.sessionId, record);
  }
  if (!Array.isArray(state.sessions)) return state;
  // A replaced row keeps the transcript path the build bound to the row it replaces:
  // the session summary reads it from this map, keyed by the row object.
  const sources = deps.sessionSources || dashboardSessionSources;
  const replaced = (session, copy) => {
    const file = sources.get(session);
    if (file) sources.set(copy, file);
    return copy;
  };
  state.sessions = state.sessions.map((session) => {
    const record = session && moves.get(session.id);
    if (record) return replaced(session, { ...session, move: consoleMove(record, running(record.sessionId)) });
    if (session && Object.prototype.hasOwnProperty.call(session, 'move')) {
      const { move: _stale, ...rest } = session;
      return replaced(session, rest);
    }
    return session;
  });
  return state;
}

// Which node a project is placed on. The key in the configuration is written the
// way a person writes a project — `~/castle/ghost-server` — and the project reaching
// here may be that, or the absolute path a standalone open resolved for itself. Both
// spellings name one directory, so both are compared as one: without this, placement
// applied to card opens and quietly did nothing for `keep open --fresh --cwd`.
function placementProjectNode(project, placement, deps = {}) {
  const candidates = (Array.isArray(project) ? project : [project]).filter((value) => typeof value === 'string' && value);
  if (!candidates.length) return null;
  const home = (deps.env || process.env).HOME || os.homedir();
  const expand = (value) => path.resolve(String(value).replace(/^~(?=\/|$)/, home));
  const entries = Object.entries(placement.projects || {});
  for (const candidate of candidates) {
    const wanted = expand(candidate);
    const hit = entries.find(([key]) => key === candidate || expand(key) === wanted);
    if (hit) return hit[1];
  }
  return null;
}

function placementConfiguration(deps = {}) {
  if (deps.placement) return { default: deps.placement.default || null, projects: deps.placement.projects || {} };
  try {
    const value = JSON.parse((deps.env || process.env).KEEP_PLACEMENT || '{}');
    return { default: value.default || null, projects: value.projects || {} };
  } catch { return { default: null, projects: {} }; }
}

// Which machine a session runs on.
//
// A session that already exists runs where it already runs: its transcript, its
// account's credentials and its working tree are all on that machine, and no open
// may move it. A fresh one takes the first answer available: what the caller asked
// for, then where this card last ran, then what the configuration says about this
// project, then its default, then the daemon node.
//
// A capability the work needs — asked for with --needs — is then a requirement of
// that machine. A node the caller named is never quietly swapped for another: being
// told "aws1 cannot do this" is the answer. A node nobody named may be, because
// nobody asked for that one in particular.
function resolvePlacement(request = {}, deps = {}) {
  const daemon = daemonNodeName(deps);
  const configured = placementNodes(deps);
  const capabilities = new Map(configured.map((node) => [node.name, node.capabilities || []]));
  let chosen;
  let named = false;
  if (request.pinned) {
    if (request.node && request.node !== request.pinned) {
      throw new InjectionError(409, `${request.label || 'this session'} runs on node ${request.pinned}`);
    }
    chosen = request.pinned;
    named = true;
  } else if (request.node) {
    chosen = request.node;
    named = true;
  } else if (request.lastCardNode !== undefined) {
    // A card that has run before runs there again. An entry written before nodes
    // existed names no node, and that is the daemon node by construction.
    chosen = request.lastCardNode || daemon;
  } else {
    const placement = placementConfiguration(deps);
    chosen = placementProjectNode(request.project, placement, deps) || placement.default || daemon;
  }
  // What the caller asked for outright is a demand; what a card tag carried is a
  // hint. `browser`, `ios` and `android` are ordinary words cards were tagged with
  // long before any machine declared a capability, so a hint no configured node can
  // answer for is dropped in silence — otherwise every such card would refuse to open
  // on an install whose nodes declare nothing. A hint some node does declare is held
  // to, because on that install the tag is saying something about machines.
  const demanded = [...new Set((request.needs || []).filter(Boolean))];
  const hinted = [...new Set((request.hints || []).filter(Boolean))]
    .filter((capability) => !demanded.includes(capability)
      && configured.some((node) => (node.capabilities || []).includes(capability)));
  const wanted = [...demanded, ...hinted];
  if (!wanted.length) return chosen;
  const satisfies = (name) => wanted.every((capability) => (capabilities.get(name) || []).includes(capability));
  if (satisfies(chosen)) return chosen;
  if (named) {
    const missing = wanted.find((capability) => !(capabilities.get(chosen) || []).includes(capability));
    throw new InjectionError(409, `node ${chosen} does not have ${missing}`);
  }
  const alternative = configured.find((node) => satisfies(node.name));
  if (alternative) return alternative.name;
  const unavailable = wanted.find((capability) => !configured.some((node) => (node.capabilities || []).includes(capability)));
  throw new InjectionError(409, `no configured node has ${unavailable || wanted.join(' and ')}`);
}

const freshOpenOperations = new Map();
const reopenOpenOperations = new Map();

// Pane metadata carried over when a pane is replaced — an in-place restart, a force
// restart, an account handoff. Launch-only readiness is dropped with `ephemeral`: it
// describes the original pane before its first turn, never the adopted process.
// `ephemeral` is dropped on purpose: it marks a pane the
// check scheduler opened and may close on its own, and the moment Owner restarts it or
// moves it to another account it is an ordinary session that nobody may reap. The
// original `launchedAt` rides along because the open-request dedupe reads it; with
// `ephemeral` gone the reaper never looks at it.
function adoptedPaneMeta(meta) {
  const { ephemeral, awaitingOwnerInput, openingMessage, ...rest } = meta || {};
  return rest;
}

// Pane metadata openSession resolves for itself. `repair` and the transfer ids are the
// sharp ones: the self-repair scheduler adopts a pane by `meta.repair`, so an
// annotation that could set it could hand a stray pane the repair agent's identity.
const RESERVED_LAUNCH_META = new Set([
  'agent', 'accountId', 'accountLabel', 'sessionId', 'model', 'project', 'card', 'repair',
  'requester', 'portableTransferId', 'reviewQueueLaunchId', 'openRequestId', 'launchedAt',
  'opener', 'unattended', 'awaitingOwnerInput', 'openingMessage',
]);

// Who Keep opened a pane for, and therefore whether anybody is reading it. Resolved
// from the launch facts openSession already has, never from an annotation: the hooks
// refuse a question in an unattended session, so a caller that could set this could
// silence the guard, or — worse — make Owner's own session refuse to ask him anything.
function resolveOpener(body = {}, deps = {}) {
  const inherited = deps.opener;
  if (inherited && typeof inherited === 'object' && typeof inherited.kind === 'string' && inherited.kind) {
    return {
      opener: { kind: inherited.kind, ...(inherited.id ? { id: String(inherited.id) } : {}) },
      unattended: inherited.unattended === true,
    };
  }
  const launchMeta = deps.launchMeta && typeof deps.launchMeta === 'object' ? deps.launchMeta : {};
  const card = body.taskId ? String(body.taskId) : '';
  const onCard = (kind) => ({ opener: { kind, ...(card ? { id: card } : {}) }, unattended: true });
  if (launchMeta.agentName) return { opener: { kind: 'agent', id: String(launchMeta.agentName) }, unattended: true };
  if (launchMeta.ephemeral === 'check') return onCard('check');
  if (deps.launchEnv && deps.launchEnv.KEEP_REPAIR === '1') return onCard('repair');
  // Another session ran `keep open <card>`. Above the review queue on purpose: if a
  // launch ever carried both, the session that asked for it is the truer opener.
  if (body.requester) return { opener: { kind: 'session', id: String(body.requester) }, unattended: true };
  // The review queue's Discuss, Investigate and Start work buttons are Owner in the
  // console — `launchReviewQueueSession` has no other caller — so the kind is recorded
  // for the pane's history and the session stays attended.
  if (body.reviewQueueLaunchId) return { opener: { kind: 'review-queue', ...(card ? { id: card } : {}) }, unattended: false };
  // Console "Start work", the console's "Run agent" button, `keep open` from Owner's
  // own shell: he clicked it and he is there.
  return { opener: { kind: 'owner' }, unattended: false };
}

// The console number of an already-numbered session, for the open result the CLI
// prints. A session launched a moment ago has none until the next scan numbers it.
function openedSessionNumber(id, deps = {}) {
  if (!id) return {};
  let num = null;
  try { num = sessionNumbers.lookup(id, { root: deps.root || keep.ROOT })?.num || null; } catch {}
  return num ? { num } : {};
}

// What the Browser Bridge should call the session's browser — and so its Edge tab
// group: `#12 fix-login`, or whichever half exists. A Codex launch has no session id
// and hence no number yet, and a session opened outside a card has no card; with
// neither there is nothing better than the bridge's own `<account> #<pid>` fallback.
function browserBridgeSessionName(num, card) {
  return [num ? `#${num}` : '', card ? String(card) : ''].filter(Boolean).join(' ');
}

function annotationMeta(launchMeta) {
  if (!launchMeta || typeof launchMeta !== 'object') return {};
  return Object.fromEntries(Object.entries(launchMeta).filter(([key]) => !RESERVED_LAUNCH_META.has(key)));
}

// The account chooser reads the in-memory usage view, which never blocks and may be
// empty. An unreadable snapshot means "unknown", which still launches.
function usageSnapshot(deps = {}) {
  try { return (deps.usageSnapshot || usage.getUsage)(); }
  catch { return null; }
}

// What the account chooser should judge one candidate against. An explicit `--model`
// is the whole answer and applies to every candidate. Without one, `claude` reads the
// launching account's own settings.json at startup, so the per-model weekly bucket that
// launch would spend against is that account's default model — not the generic week:
// `claude/default` sat at week 80% and `Fable wk` 100%, which the generic buckets read
// as fine although a session opened there could not take a turn. Each candidate has its
// own settings.json, so this is asked per account. Codex accounts have no such file and
// keep the generic windows. Anything unreadable is '' — today's generic behaviour — and
// nothing here throws: choosing an account is a convenience, never a gate.
function accountBudgetModel(account, deps = {}) {
  try {
    if (!account || account.agent !== 'claude'
      || typeof account.configDir !== 'string' || !account.configDir) return '';
    const read = deps.readAccountSettings || readAccountSettingsModel;
    return launchModelId(read(path.join(account.configDir, 'settings.json')));
  } catch { return ''; }
}

function openBudgetModel(launchModel, deps = {}) {
  return launchModel || ((account) => accountBudgetModel(account, deps));
}

// A resumed session whose recorded directory was a ~/wt worktree that has since
// been recycled gets that worktree back (a fresh wt/<name> branch off the default
// branch, as `wt new` makes it) instead of an unresumable "project directory does
// not exist". `wt new` installs dependencies synchronously, so it runs as a child
// process -- repository lookup included, since that runs git synchronously -- in
// its own process group, so a timeout stops its git and install children too. The
// bound stays under restore's 180s request timeout. Concurrent reopens of the same
// path share one creation, and a reopen that arrives once the directory exists but
// before creation finished still waits for it (awaitWorktreeRecreation).
const worktreeRecreations = new Map();
const WORKTREE_RECREATE_TIMEOUT_MS = 150e3;
function runWorktreeRecreation(project, { timeoutMs = WORKTREE_RECREATE_TIMEOUT_MS, script: override } = {}) {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  const script = override || `try { require(${JSON.stringify(path.join(__dirname, 'wt.js'))}).recreateRecycledWorktree(process.argv[1]); }
    catch (error) { process.stderr.write('wt: ' + error.message + '\\n'); process.exit(1); }`;
  return new Promise((resolve, reject) => {
    const child = require('child_process').spawn(process.execPath, ['-e', script, project],
      { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let killed = false;
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    const timer = setTimeout(() => {
      killed = true;
      stderr += `\nwt: timed out after ${timeoutMs / 1000}s; remove the partial worktree with wt rm --force --delete ${project} before retrying`;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // SIGKILL skips withRepoLock's cleanup, and wt keeps a dead owner's lock for
      // ten minutes; release it when the killed child is still the one holding it.
      if (killed) {
        try {
          const lock = path.join(path.dirname(project), '.lock');
          if (Number(fs.readFileSync(lock, 'utf8').trim()) === child.pid) fs.unlinkSync(lock);
        } catch {}
      }
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`wt exited ${code}`), { stderr }));
    });
  });
}
// A creation that did not finish -- a failure, a timeout's SIGKILL, or the daemon
// dying mid-way -- can leave a partial worktree that a later stat would accept. A
// record written before the child starts and removed only on success marks that
// path until the partial tree is gone (`wt rm --delete`; a plain `wt rm` recycles
// the directory and keeps it); a missing directory clears it.
function worktreeRecreationRecord(project, deps = {}) {
  const hash = require('crypto').createHash('sha256').update(project).digest('hex').slice(0, 32);
  return path.join(deps.root || keep.ROOT, '.keep', 'worktree-recreations', `${hash}.json`);
}
function recreationFailure(project, detail) {
  return new InjectionError(409, `project directory ${project} was a recycled worktree and recreating it failed: ${detail}`);
}
async function awaitWorktreeRecreation(project, deps = {}) {
  const running = worktreeRecreations.get(project);
  if (running) {
    try { await running; } catch (error) {
      throw recreationFailure(project, String(error?.stderr || error?.message || error).trim().split('\n').pop());
    }
    return;
  }
  const record = worktreeRecreationRecord(project, deps);
  if (!fs.existsSync(record)) return;
  if (!fs.existsSync(project)) { try { fs.unlinkSync(record); } catch {} return; }
  throw recreationFailure(project, `an earlier recreation did not finish; remove the partial worktree with wt rm --force --delete ${project} (or delete the directory if git does not list it as a worktree) and reopen`);
}
async function recreateRecycledWorktree(project, deps = {}) {
  let target = null;
  try { target = (deps.recycledWorktree || require('./wt.js').recycledWorktree)(project); } catch {}
  if (!target && !worktreeRecreations.has(project)) return false;
  if (!worktreeRecreations.has(project)) {
    const record = worktreeRecreationRecord(project, deps);
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, JSON.stringify({ project, startedAt: Date.now() }) + '\n');
    const running = Promise.resolve().then(() => (deps.recreateWorktree || (() => runWorktreeRecreation(project)))(target))
      .then(() => { try { fs.unlinkSync(record); } catch {} });
    worktreeRecreations.set(project, running);
    console.log(`keep serve: open recreating recycled worktree ${project}`);
    running.finally(() => { if (worktreeRecreations.get(project) === running) worktreeRecreations.delete(project); }).catch(() => {});
  }
  await awaitWorktreeRecreation(project, deps);
  try { return fs.statSync(project).isDirectory(); } catch { return false; }
}

async function openSession(body, deps = {}) {
  body = body && typeof body === 'object' ? body : {};
  const freshStandalone = body.fresh === true && !body.taskId && !body.sessionId;
  if (body.agent != null && !['claude', 'codex', 'pi'].includes(body.agent)) throw new InjectionError(400, 'agent must be claude, codex, or pi');
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
  if (body.model != null && (typeof body.model !== 'string'
      || !keep.PI_MODEL_RE.test(body.model) && !keep.LAUNCH_MODEL_RE.test(body.model))) {
    throw new InjectionError(400, 'model must be a model id');
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
  // `auto` is the CLI's own fresh open asking Keep to pick an account with usage
  // left. Every other caller — the check scheduler, the reviewer launch, restore,
  // reopen, the console — omits it and keeps the registry default it always had.
  if (body.accountPolicy != null && body.accountPolicy !== 'auto') {
    throw new InjectionError(400, 'accountPolicy must be auto');
  }
  if (body.callerAccountId != null && !accounts.ID_RE.test(String(body.callerAccountId))) {
    throw new InjectionError(400, 'bad caller account id');
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
  // Which machine to run on, and what that machine has to be able to do. Both are
  // checked here, against this install's own node list, so a name nobody has is a
  // refusal before anything is resolved rather than a launch that fails at the end.
  if (body.node != null && (typeof body.node !== 'string' || !nodes.NODE_NAME_RE.test(body.node))) {
    throw new InjectionError(400, 'node must be a node name');
  }
  if (body.node != null && !placementNodes(deps).some((node) => node.name === body.node)) {
    throw new InjectionError(400, `node ${body.node} is not configured`);
  }
  if (body.needs != null && (typeof body.needs !== 'string' || !body.needs.trim())) {
    throw new InjectionError(400, 'needs must be a capability name');
  }
  const needs = body.needs == null ? [] : [String(body.needs).trim()];
  // A card open with a request id joins the same in-flight dedupe: a fresh Codex card
  // open on another node can return pending, and a retry of it must not start a second.
  if ((freshStandalone || (body.taskId && !body.sessionId)) && body.requestId && !deps.freshOpenClaimed) {
    const identity = JSON.stringify({ cwd: body.cwd, agent: body.agent, accountId: body.accountId,
      model: body.model || '', node: body.node || '', needs: body.needs || '',
      ...(body.taskId ? { taskId: body.taskId, fresh: body.fresh === true, message: body.message || '' } : {}) });
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
  let card = null;
  if (body.taskId) {
    let task;
    try { task = (deps.loadTask || keep.loadTask)(body.taskId); } catch {}
    card = task || null;
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
  if (session && !body.fresh) await awaitWorktreeRecreation(project, deps);
  try { if (!fs.statSync(project).isDirectory()) throw new Error(); }
  catch {
    if (!session || body.fresh || !await recreateRecycledWorktree(project, deps)) {
      throw new InjectionError(400, 'project directory does not exist');
    }
  }
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

  // Which machine this session runs on, settled before anything can dedupe against
  // it. Two opens that disagree about the node are two different requests: the
  // second has to be refused, not handed the first one's answer, or asking for the
  // wrong node twice would quietly succeed.
  let launchNode;
  if (session) {
    if (typeof session.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(session.id)) {
      throw new InjectionError(400, 'bad session id');
    }
    let runsOn = null;
    try { runsOn = accounts.sessionNode(session.id, { root: deps.root || keep.ROOT, env: deps.env || process.env }); }
    catch (error) { throw new InjectionError(409, error.message); }
    launchNode = resolvePlacement({
      node: body.node || null,
      pinned: runsOn || nodes.daemonNode(deps.env || process.env),
      needs,
      label: `session ${sessionRef(session.id)}`,
    }, deps);
    // A session being moved between nodes is stopped on purpose while its files are
    // carried: only the move itself may start it again. A single-node install has
    // never recorded a move, so it never reads the directory.
    if (hostNodeNames(deps).length > 1) {
      const moving = require('./session-move').inFlight(deps.root || keep.ROOT, session.id);
      if (moving && deps.moveTransactionId !== moving.id) {
        throw new InjectionError(409, `session ${sessionRef(session.id)} is being moved from ${moving.from} to ${moving.to} (${moving.id}, ${moving.status}); keep move --recover ${moving.id} or --abandon ${moving.id}`);
      }
    }
  }

  if (session && !deps.reopenOpenClaimed) {
    const identity = JSON.stringify({ accountId: body.accountId || '', model: body.model || '', message,
      node: launchNode, needs: body.needs || '' });
    const running = reopenOpenOperations.get(session.id);
    if (running) {
      if (running.identity !== identity) throw new InjectionError(409, 'session reopen is already delivering a different request');
      return running.promise;
    }
    const promise = openSession(body, { ...deps, reopenOpenClaimed: true });
    reopenOpenOperations.set(session.id, { identity, promise });
    try { return await promise; }
    finally { if (reopenOpenOperations.get(session.id)?.promise === promise) reopenOpenOperations.delete(session.id); }
  }

  const agent = (session && (session.kind || session.agent)) || body.agent || 'claude';
  if (!['claude', 'codex', 'pi'].includes(agent)) throw new InjectionError(400, 'agent must be claude, codex, or pi');
  if (agent === 'pi' && (deps.onSessionReady || deps.onOpeningReady || deps.onOpeningDelivered)) {
    throw new InjectionError(409, 'Pi does not support reserved opening delivery');
  }
  if (launchModel && !(agent === 'pi' ? keep.PI_MODEL_RE : keep.LAUNCH_MODEL_RE).test(launchModel)) {
    throw new InjectionError(400, agent === 'pi' ? 'model is not valid for pi' : 'model must be a model id');
  }
  let account;
  let accountNote = '';
  let accountWarning = '';
  let reopenTurn = null;
  if (session) {
    // launchNode was settled above, before the reopen dedupe could answer for it.
    try { account = accounts.forSession(session.id, agent, { root: deps.root || keep.ROOT, env: deps.env || process.env }); }
    catch (error) { throw new InjectionError(409, error.message); }
    if (!account && session.accountId) {
      account = accounts.get(session.accountId, deps.env || process.env);
      if (!account || account.agent !== agent) {
        throw new InjectionError(409, `session ${sessionRef(session.id)} belongs to unavailable account ${session.accountId}`);
      }
    }
    account ||= accounts.defaultFor(agent, deps.env || process.env);
    if (body.accountId != null && body.accountId !== account.id) {
      throw new InjectionError(409, `session ${sessionRef(session.id)} is pinned to account ${account.id}; use handoff to transfer it`);
    }
    // No node here: the session's own node is what this open resolved against, and
    // a re-pin must never be what moves one.
    if (account.managed) {
      accounts.pinSession(session.id, agent, account.id,
        { root: deps.root || keep.ROOT, env: deps.env || process.env });
    }
  } else {
    // A fresh session: where the caller said, else where this card last ran, else
    // what the configuration says about this project, else the daemon node — and
    // whatever the work needs, demanded outright or hinted at by a card tag.
    const lastCardEntry = card ? (card.fm.sessions || []).slice(-1)[0] : undefined;
    launchNode = resolvePlacement({
      node: body.node || null,
      lastCardNode: lastCardEntry === undefined ? undefined : (lastCardEntry.node || null),
      // The card's project as it is written there, and the directory this open
      // actually resolved. A standalone open has only the second, and placement has
      // to reach it the same way it reaches a card's.
      project: [card ? card.fm.project : null, project],
      needs,
      hints: (card ? (card.fm.tags || []) : []).filter((tag) => PLACEMENT_TAG_CAPABILITIES.includes(tag)),
    }, deps);
    const env = deps.env || process.env;
    if (body.accountId != null) {
      account = accounts.get(body.accountId, env);
    } else if (body.accountPolicy === 'auto') {
      // Choosing an account is a convenience, never a gate: a malformed usage reading
      // or a chooser bug must not be able to stop a launch. Anything thrown here falls
      // back to the registry default, exactly as an open with no policy would.
      let choice = null;
      let note = '';
      try {
        choice = openAccount.chooseOpenAccount(agent, openAccount.orderOpenCandidates(agent, {
          accounts: accounts.list(env),
          defaultAccountId: accounts.defaultFor(agent, env).id,
          callerAccountId: body.callerAccountId,
        }), usageSnapshot(deps), openBudgetModel(launchModel, deps), Date.now());
        note = choice.account ? openAccount.accountNote(choice) : openAccount.noAccountMessage(agent, choice.skipped);
      } catch (error) {
        choice = null;
        process.stderr.write(`keep serve: could not choose a ${agent} account: ${String(error && error.message || error)}\n`);
      }
      // Launching a session that can only answer "you are out of usage" wastes the
      // pane and the caller's turn; say which accounts are spent and let Owner
      // override deliberately.
      if (choice && !choice.account) throw new InjectionError(409, note);
      account = choice ? choice.account : accounts.defaultFor(agent, env);
      accountNote = choice ? note : '';
    } else {
      account = accounts.defaultFor(agent, env);
    }
    if (!account || account.agent !== agent) throw new InjectionError(400, `account ${body.accountId || '?'} is not a ${agent} account`);
    if (body.accountId != null) {
      // Same rule: an unreadable snapshot costs the warning, never the launch.
      try { accountWarning = openAccount.exhaustedWarning(account, usageSnapshot(deps), openBudgetModel(launchModel, deps), Date.now()); }
      catch { accountWarning = ''; }
    }
  }
  if (agent === 'pi' && !account.builtIn) throw new InjectionError(400, 'Pi currently supports only pi/default');
  // The extension writes its phase file on the machine Pi runs on, and its hooks
  // reach this daemon from there (carried by the node's CLI). On the daemon node the
  // extension is checked here; on another node that node answers for itself.
  if (agent === 'pi' && launchNode !== launchDaemonNode(deps)) {
    await (deps.assertNodePiReady || assertNodePiReady)(launchNode, account, project, deps);
  } else if (agent === 'pi' && deps.piExtensionReady !== true
      && !fs.existsSync(path.join(os.homedir(), '.pi', 'agent', 'extensions', 'keep.ts'))) {
    throw new InjectionError(409, 'Pi Keep extension is not installed at ~/.pi/agent/extensions/keep.ts');
  }
  // A fresh Codex card open on another node with no opening message, named by a
  // request id: it has no session yet, so it may register late (below), and a retry
  // with the same id finds its pane. Only that case: a remote card open with a message,
  // or of Claude, waits for its session as it always has, with no request id on its
  // pane and no pane listing up front.
  const nodeCardRequest = Boolean(body.taskId) && !session && Boolean(body.requestId)
    && agent === 'codex' && !message
    && launchNode !== nodes.daemonNode(deps.env || process.env);
  // A fresh Codex with no opening message names its session only at its first turn,
  // which may come long after the open returns: the open returns pending instead of
  // failing. Standalone, anywhere; on a card, only on another node (on the daemon node
  // a card open still waits for its session and fails without one, as it always has).
  const allowPendingRegistration = (freshStandalone || nodeCardRequest) && agent === 'codex' && !message
    && Boolean(body.requestId)
    && !body.portableTransferId && !body.reviewQueueLaunchId
    && !deps.onSessionReady && !deps.onOpeningReady && !deps.onOpeningDelivered;
  const deferReadiness = freshStandalone && agent === 'claude' && !message
    && !body.portableTransferId && !body.reviewQueueLaunchId
    && !deps.onSessionReady && !deps.onOpeningReady && !deps.onOpeningDelivered;
  if ((freshStandalone || nodeCardRequest) && body.requestId) {
    const listed = await hostPanesForAction(deps, true);
    if (!Array.isArray(listed.panes)) throw hostPaneVerificationError('Open request identity', listed, 503);
    const panes = listed.panes;
    const matches = (panes || []).filter((entry) => entry?.meta?.openRequestId === body.requestId);
    if (matches.length > 1) throw new InjectionError(409, 'open request matches multiple host panes');
    if (matches.length === 1) {
      const existing = matches[0];
      if (existing.meta?.agent !== agent || existing.meta?.accountId !== account.id
          || path.resolve(existing.meta?.project || '') !== project
          || (existing.meta?.model || '') !== launchModel
          // The machine is part of what was asked for: a pane on another node is not
          // this request already satisfied, it is a different request wearing its id.
          || (existing.node || nodes.daemonNode(deps.env || process.env)) !== launchNode
          // A card's request is that card's: the same id on another card, or on none, is not it.
          || (existing.meta?.card || null) !== (body.taskId || null)
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
          throw new InjectionError(409, `session ${sessionRef(sessionId)} is pinned to account ${authority.id}`);
        }
        if (!authority) {
          (deps.pinSession || accounts.pinSession)(sessionId, agent, account.id,
            { root: deps.root || keep.ROOT, env: deps.env || process.env, node: launchNode });
        }
      }
      return { ok: true, existing: true, focus: 'console', pane: existing.id,
        // Named the same way a created pane names it, and for the same reason: the
        // caller is being told where to look, and on a fleet that is half the answer.
        ...(launchNode === nodes.daemonNode(deps.env || process.env) ? {} : { node: launchNode }),
        sessionId, ...openedSessionNumber(sessionId, deps),
        accountId: account.id, accountLabel: account.label,
        ...(accountNote ? { accountNote } : {}), ...(accountWarning ? { accountWarning } : {}),
        agent, recoverable: existing.agentAlive === false,
        ...(!sessionId && allowPendingRegistration ? { pendingRegistration: true, ...(body.taskId ? { card: body.taskId } : {}) } : {}) };
    }
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
  const openedFor = resolveOpener(body, deps);
  // Names this launch's spawn to the host, so a reply lost to a timeout or a core
  // reload can be asked for again instead of starting a second agent on the same
  // work. An open request id is the caller's own name for the same attempt and is
  // carried as a digest of itself, because the host's operation ids are 16-128
  // characters and an open request id may be shorter. One id per invocation: a
  // retry inside this call is the same operation, a new call is a new one.
  const spawnOperationId = body.requestId
    ? `open-${crypto.createHash('sha256').update(String(body.requestId)).digest('hex').slice(0, 32)}`
    : crypto.randomUUID();

  // `inheritedModel` is set only when the launch could not hold the model key and is
  // naming settings.json's model itself; it rides the command line exactly like an
  // explicit one, but stays out of the pane meta, which means "the caller asked for
  // this model" and is compared against the request when an open is retried.
  const launchHost = async (inheritedModel = '') => {
    const sessionId = session ? session.id : ['claude', 'pi'].includes(agent) ? (deps.randomUUID || crypto.randomUUID)() : null;
    // Number a new session before it starts, so its start hook can tell it which it is.
    if (sessionId && !session) {
      try { sessionNumbers.assign([{ id: sessionId, mtime: launchedAt }], { root: deps.root || keep.ROOT }); } catch {}
    }
    // Named after the number just assigned and the card, so the session's Edge tab
    // group is recognisable in the browser.
    const browserName = browserBridgeSessionName(openedSessionNumber(sessionId, deps).num, body.taskId);
    const commandModel = launchModel || inheritedModel;
    // The argument vector, with the two paths only the machine the agent runs on can
    // produce left as placeholders: the shared Claude setup's --mcp-config and Pi's
    // opening file. Everything else — flag order included — is decided here.
    const argvTemplate = agent === 'pi'
      ? ['pi', ...(commandModel ? ['--model', commandModel] : []),
        session ? '--session' : '--session-id', sessionId,
        ...(message ? [{ insert: 'piOpening' }] : [])]
      : agent === 'codex'
      ? ['codex', ...codexFlagArgs, ...(commandModel ? ['-m', commandModel] : []), ...(sessionId ? ['resume', sessionId] : [])]
      : ['claude', ...claudeFlagArgs, { insert: 'mcpConfig' }, ...(commandModel ? ['--model', commandModel] : []),
        ...(sessionId ? [session ? '--resume' : '--session-id', sessionId] : [])];
    // The node-local half of the launch: the account's shared setup, the project's
    // trust record, Pi's opening file and the shell word that carries the node binary
    // of the machine the pane lands on. On the daemon node it runs in-process,
    // exactly as it always did.
    let prepared;
    try {
      prepared = await (deps.prepareLaunch || ((options, local) => prepareLaunchOn(launchNode, options, deps, local)))({
        agent,
        account: { id: account.id, agent: account.agent, configDir: account.configDir,
          builtIn: account.builtIn === true, managed: account.managed === true },
        cwd: project,
        bypass: agent === 'claude' && claudeFlagArgs.includes('--dangerously-skip-permissions'),
        argv: argvTemplate,
        pi: agent === 'pi' && message
          ? { sessionId, message, openingDir: path.join(deps.root || keep.ROOT, '.keep', 'pi-opening') }
          : null,
      }, deps.trustProject
        ? { accountSetup: { ...require('./account-setup'), trustProject: deps.trustProject } }
        : {});
    } catch (error) {
      // Both are the machine saying it cannot run this account: a refusal to hand
      // back, not a fault to retry.
      if (error && ['shared-setup', 'account-missing', 'home-mismatch'].includes(error.code)) {
        throw new InjectionError(409, error.message);
      }
      throw error;
    }
    const piOpeningFile = prepared.piOpeningFile || null;
    const command = prepared.argv.join(' ');
    if (prepared.trustError) {
      process.stderr.write(`keep serve: could not pre-trust ${project} for ${account.id}: ${prepared.trustError}\n`);
    }
    const spawned = await hostRequest('spawn', {
      operationId: spawnOperationId,
      cmd: '/bin/zsh',
      args: ['-lic', `exec ${prepared.command}`],
      // A resume of a recorded repair session re-earns the marker; a fresh launch
      // carries it in deps.launchEnv, which the scheduler passes — and an internal
      // launch that named the browser itself keeps its own name.
      env: require('./agent-launcher').launcherEnv({
        ...repairEnvFor({ sessionId }, deps),
        ...(agent === 'pi' ? { KEEP_PI_SESSION_ID: sessionId, KEEP_PI_KEEP_CLI: PI_KEEP_CLI,
          ...(piOpeningFile ? { KEEP_PI_OPENING_FILE: piOpeningFile } : {}) } : {}),
        ...(browserName ? { BROWSER_BRIDGE_SESSION_NAME: browserName } : {}),
        ...deps.launchEnv,
      }),
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
        // The machine the pane lives on.
        node: launchNode,
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
        ...((freshStandalone || nodeCardRequest) && body.requestId ? { openRequestId: body.requestId } : {}),
        // A standalone console launch is actionable before Codex has written the
        // transcript that gives it a session id. Publish that short-lived readiness
        // from the pane itself. Automated opening delivery is marked separately so a
        // host-only row can never advertise it as waiting for Owner before delivery.
        ...(freshStandalone && !message ? { awaitingOwnerInput: true } : {}),
        ...(message ? { openingMessage: true } : {}),
        // Who this pane was opened for, and whether anybody is reading it. The session
        // asks its own pane at startup: an unattended one is told not to ask questions,
        // and the question hooks refuse it if it does.
        opener: openedFor.opener,
        ...(openedFor.unattended ? { unattended: true } : {}),
        launchedAt,
      },
    }, { ...deps, node: launchNode });
    const pane = spawned && spawned.pane && spawned.pane.id;
    if (!pane) throw new Error('terminal host did not return a pane');
    return { ok: true, created: 'pane', command, pane, sessionId,
      ...(launchNode === nodes.daemonNode(deps.env || process.env) ? {} : { node: launchNode }),
      ...openedSessionNumber(sessionId, deps),
      accountId: account.id, accountLabel: account.label,
      ...(accountNote ? { accountNote } : {}), ...(accountWarning ? { accountWarning } : {}),
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
      //
      // The processes that could be it are on the machine this session runs on, so
      // that is the machine asked. And this one fails closed: liveSessionPids treats
      // an unreadable table as "nothing is running", which is the right answer for a
      // guard that is advisory and exactly the wrong one for a guard whose job is to
      // stop a second agent writing the same transcript. A node that cannot answer
      // is a node this daemon may not resume on.
      let live;
      const onDaemonNode = launchNode === nodes.daemonNode(deps.env || process.env);
      // The node's process rows, read once and used by the Pi guard below as well.
      let nodeRows = null;
      if (onDaemonNode) {
        live = await (deps.liveSessionPids || liveSessionPids)(deps);
      } else {
        let rows = null;
        try { rows = await (deps.agentProcessRows || agentProcessRows)(deps, { node: launchNode }); } catch {}
        nodeRows = rows;
        live = await (deps.liveSessionPids || liveSessionPids)(
          { ...deps, agentProcessRows: async () => rows }, { node: launchNode },
        );
        if (unverifiedProcesses(live, agent)) {
          throw new InjectionError(409, `cannot verify processes on ${launchNode}`);
        }
      }
      const running = live.get(session.id);
      if (running) {
        throw new InjectionError(409, `session ${sessionRef(session.id)} is running outside the host (pid ${running.pid}); exit it there first, then keep open again`, { pid: running.pid });
      }
      if (agent === 'pi') {
        // Pi overwrites its argv with process.title="pi", so a raw external TUI
        // cannot be mapped to a session id by ps. Refuse an uncertain concurrent
        // resume instead of risking two writers on one Pi JSONL file.
        //
        // On another node the rows are that node's (read above, and verified there),
        // the host panes are that node's, and no Pi background worker runs there.
        const rows = onDaemonNode ? await (deps.agentProcessRows || agentProcessRows)(deps) : (nodeRows || []);
        const daemonNode = nodes.daemonNode(deps.env || process.env);
        const panes = (await (deps.listHostPanes || listHostPanes)(deps, true) || [])
          .filter((pane) => onDaemonNode || (pane.node || daemonNode) === launchNode);
        const backgroundPiPids = onDaemonNode ? verifiedPiBackgroundPids(rows, deps) : new Set();
        const hosts = new Set(panes.filter((pane) => pane.alive && pane.meta?.agent === 'pi')
          .map((pane) => pane.pid).filter(Number.isInteger));
        const byPid = new Map(rows.map((row) => [row.pid, row]));
        const external = rows.find((row) => {
          if (row.agent !== 'pi' || !row.interactive || backgroundPiPids.has(row.pid)) return false;
          let current = row;
          const seen = new Set();
          while (current && !seen.has(current.pid)) {
            if (hosts.has(current.pid)) return false;
            seen.add(current.pid);
            current = byPid.get(current.ppid);
          }
          return true;
        });
        if (external) throw new InjectionError(409,
          `a Pi process outside Keep is running (pid ${external.pid}); exit it before resuming this session`, { pid: external.pid });
      }
    }
    if (target) {
      return withInjectionLock(async () => {
        try { require('./session-retirement').clear(deps.root || keep.ROOT, session.id); } catch {}
        const result = {
          ok: true,
          existing: true,
          focus: 'console',
          sessionId: session.id,
          ...(session.num ? { num: session.num } : openedSessionNumber(session.id, deps)),
          pane: target.pane,
          // A pane already running on another machine is still a pane on another
          // machine, and `keep open` says so here exactly as it does for a new one.
          ...(launchNode === nodes.daemonNode(deps.env || process.env) ? {} : { node: launchNode }),
        };
        if (message) {
          assertCompactRestoreSettled(session.id, deps);
          await (deps.sendToResolvedTarget || sendToResolvedTarget)(
            { ...session, kind: agent }, target, message, undefined, deps,
          );
          result.sent = true;
        }
        return result;
      }, { pane: target.pane, session: session.id, model: modelCommandText(message) });
    }
    if (agent !== 'pi' && deps.reopenCompaction !== 'skip') {
      if (launchNode === nodes.daemonNode(deps.env || process.env)) {
        reopenTurn = reopenTurnSnapshot({ ...session, kind: agent }, deps, launchModel);
      } else {
        // The compaction reads and rewrites the transcript, and the transcript is on
        // the other machine. Said out loud rather than skipped quietly: a reopen that
        // normally restores the turn is doing less than usual here.
        process.stderr.write(`keep serve: not restoring ${sessionRef(session.id)}'s turn; it runs on node ${launchNode}, where this daemon cannot read its transcript\n`);
      }
    }
  }

  // A new pane has no lock to collide with, so the launch holds the model key for one
  // reason: the agent it starts reads its model out of a config file a compaction may
  // be swapping. A Claude launch that already names the model on the command line
  // reads nothing, because the Claude swap touches only settings.json's model. A Codex
  // one still does: that swap also rewrites model_reasoning_effort, which `-m` does not
  // override.
  //
  // When the key is busy the launch does not fail. It names the model the compaction
  // swapped out, which makes the file the agent never reads irrelevant. That only works
  // for a Claude agent on the built-in profile: Codex takes its model from a config.toml
  // whose own swap keeps no in-memory record, and a managed Claude profile reads its own
  // settings.json, which the recorded value does not describe.
  const readsSettingsModel = agent !== 'pi' && (!launchModel || agent === 'codex');
  const canNameSwappedModel = agent === 'claude' && !launchModel && account.builtIn === true;
  let launch;
  let spawnStarted = false;
  try {
    launch = await withInjectionLock(
      () => { spawnStarted = true; return launchHost(); }, readsSettingsModel ? { model: true } : {},
    );
  } catch (error) {
    // Only a key this launch never got earns a second attempt: nothing may spawn twice.
    const inherited = !spawnStarted && injectionKeysBusy(error) && canNameSwappedModel
      ? (deps.compactionSwappedModel || compactionSwappedModel)(deps) : '';
    if (!inherited) throw error;
    launch = await withInjectionLock(() => launchHost(inherited), {});
  }
  const handoff = Boolean(body.taskId) && !session;
  let releasePending = handoff && Boolean(body.requester);
  // The session that handed the card over leaves it only once the launched one is
  // linked to it, as late adoption does for a card open left pending: an open that
  // fails, or a link that fails, leaves the card with its requester, never ownerless.
  const release = () => {
    if (!releasePending || !launch.sessionId) return;
    try {
      if ((deps.releaseCardSession || keep.releaseCardSession)(body.taskId, body.requester)) {
        launch.unlinked = body.requester;
      }
      releasePending = false;
    } catch (error) {
      process.stderr.write(`keep serve: could not unlink ${body.requester.slice(0, 8)} from ${body.taskId}: ${error.message}\n`);
    }
  };

  // While the requester is still on the card, its Stop hook must not auto-continue it
  // onto the steps this open is handing over (bin/open-handoffs.js): recorded once the
  // pane is up, removed once the open is over, kept for late adoption when pending.
  let handoffRecorded = false;
  if (releasePending && launch.pane) {
    try {
      (deps.recordOpenHandoff || require('./open-handoffs.js').record)(deps.root || keep.ROOT,
        { requester: body.requester, card: body.taskId, pane: launch.pane });
      handoffRecorded = true;
    } catch (error) {
      process.stderr.write(`keep serve: could not record the handoff of ${body.taskId}: ${error.message}\n`);
    }
  }
  const clearHandoff = () => {
    if (!handoffRecorded) return;
    handoffRecorded = false;
    require('./open-handoffs.js').clear(deps.root || keep.ROOT, body.requester, body.taskId);
  };

  const target = { pane: launch.pane };
  // Set while the daemon holds a record of this launch that late adoption could still use.
  let nodeLaunchRecorded = false;
  // The error that kept that record from being written, if one did.
  let nodeLaunchRecordFailed = null;
  // Once this open knows the session, its launch record is consumed, so late adoption
  // can never take it again. A record that cannot be deleted is reported, not fatal:
  // late adoption refuses a session that has a location record anyway.
  const consumeNodeLaunch = () => {
    if (!nodeLaunchRecorded || !launch.sessionId) return;
    nodeLaunchRecorded = false;
    try {
      (deps.consumeNodeCodexLaunch || require('./late-adoption.js').consumeNodeCodexLaunch)(
        deps.root || keep.ROOT, launchNode, body.requestId);
    } catch (error) {
      process.stderr.write(`keep serve: could not consume the Codex launch record for ${launch.pane}: ${error.message}\n`);
    }
  };
  try {
    // A fresh Codex on another node may name its session only at its first turn, after
    // this open has returned pending: the daemon's record of the launch is what lets the
    // hook and registry routes adopt it then (bin/late-adoption.js).
    if (allowPendingRegistration && !launch.sessionId && launchNode !== nodes.daemonNode(deps.env || process.env)) {
      try {
        (deps.recordNodeCodexLaunch || require('./late-adoption.js').recordNodeCodexLaunch)(deps.root || keep.ROOT, {
          node: launchNode, requestId: body.requestId, accountId: account.id, launchedAt,
          pane: nodes.parsePaneRef(launch.pane, { env: deps.env || process.env }).paneId, project,
          // A card open: late adoption puts the session on the card when it registers.
          ...(body.taskId ? { card: body.taskId } : {}), ...(body.taskId && body.requester ? { requester: body.requester } : {}),
        });
        nodeLaunchRecorded = true;
      } catch (error) {
        nodeLaunchRecordFailed = error;
        process.stderr.write(`keep serve: could not record the Codex launch in ${launch.pane}: ${error.message}\n`);
      }
    }
    if (launch.sessionId) {
      (deps.pinSession || accounts.pinSession)(launch.sessionId, agent, account.id,
        { root: deps.root || keep.ROOT, env: deps.env || process.env, node: launchNode });
    }
    if (deps.onLaunched) await deps.onLaunched(launch);
    if (agent === 'pi') {
      // Pi receives the opening message as a positional prompt. Its extension
      // reports turn state; no Claude/Codex composer probing is involved.
      await (deps.waitForPiStart || waitForPiStart)(launch.sessionId, launchedAt, deps, launchNode);
      launch.settled = true;
      launch.sent = Boolean(message);
    } else if (deferReadiness) {
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
      consumeNodeLaunch();
      if (!launch.sessionId && launchNode !== nodes.daemonNode(deps.env || process.env)) {
        const adopted = await (deps.adoptNodeCodexLaunch || adoptNodeCodexLaunch)(launch, {
          agent, accountId: account.id, requestId: body.requestId, launchedAt, project, model: launchModel, node: launchNode, account,
        }, deps);
        launch.sessionId = adopted.sessionId;
        consumeNodeLaunch();
        if (!adopted.sessionId) launch.registrationNote = adopted.why;
        // A bind that did not hold dropped the launch record: nothing can adopt this
        // session later, so the open does not say it will.
        if (!adopted.sessionId && adopted.launchDropped) {
          nodeLaunchRecorded = false;
          throw new InjectionError(504, `${agent} started in host pane ${launch.pane} but its session could not be registered: ${adopted.why}`);
        }
      }
      // A card open whose launch could not be recorded cannot be adopted later, so it
      // is not left pending: it fails as a card open without its session always has.
      if (!launch.sessionId && body.taskId && nodeLaunchRecordFailed) {
        throw new InjectionError(504, `${agent} started in host pane ${launch.pane} but never registered its session id, `
          + `and its launch could not be recorded for later: ${nodeLaunchRecordFailed.message}`);
      }
      if (!launch.sessionId) {
        launch.pendingRegistration = true;
        // Late adoption puts the session on this card when it registers.
        if (body.taskId) launch.card = body.taskId;
      }
    } else if (!launch.sessionId && (handoff || freshStandalone || deps.onSessionReady)) {
      launch.sessionId = await (deps.waitForHostSessionId || waitForHostSessionId)(launch.pane, deps);
      let adoption = null;
      if (!launch.sessionId && agent === 'codex' && launchNode !== nodes.daemonNode(deps.env || process.env)) {
        adoption = await (deps.adoptNodeCodexLaunch || adoptNodeCodexLaunch)(launch, {
          agent, accountId: account.id, requestId: freshStandalone ? body.requestId : undefined, launchedAt, project,
          model: launchModel, node: launchNode, account,
        }, deps);
        launch.sessionId = adoption.sessionId;
      }
      if (!launch.sessionId && adoption) {
        throw new InjectionError(504, `${agent} started in host pane ${launch.pane} but never registered its session id: ${adoption.why}`);
      }
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
    if (session && reopenTurn && !message && agent !== 'pi') {
      await withInjectionLockRetry(() => compactReopenedSession(
        { ...session, kind: agent }, target, account, reopenTurn, deps),
      { ...deps, injectionLockRetryMs: envNumber('KEEP_COMPACT_TIMEOUT_MS', 240000) + 30000 },
      { pane: target.pane, session: session.id, model: true });
    }
    if (message && agent !== 'pi') {
      if (body.portableTransferId) {
        launch.sessionId ||= await (deps.waitForHostSessionId || waitForHostSessionId)(launch.pane, deps);
        if (!launch.sessionId || launch.sessionId === body.portableSourceSessionId) {
          throw new InjectionError(409, 'portable successor session identity was not verified before instructions were sent');
        }
      }
      await withInjectionLockRetry(
        async () => {
          if (session && reopenTurn) await compactReopenedSession(
            { ...session, kind: agent }, target, account, reopenTurn, deps);
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
        }, session && reopenTurn
          ? { ...deps, injectionLockRetryMs: envNumber('KEEP_COMPACT_TIMEOUT_MS', 240000) + 30000 } : deps,
        { pane: target.pane, session: session?.id, model: Boolean(session && reopenTurn) || modelCommandText(message) },
      );
      launch.sent = true;
      if (deps.onOpeningDelivered && await deps.onOpeningDelivered(launch) === false) {
        throw new InjectionError(409, 'opening-message reservation changed after instructions were sent');
      }
    }
    // A card open left pending is linked by late adoption when its session registers.
    if (!launch.sessionId && handoff && !launch.pendingRegistration) {
      launch.sessionId = await (deps.waitForHostSessionId || waitForHostSessionId)(launch.pane, deps);
      if (!launch.sessionId) {
        throw new InjectionError(504, `${agent} started in host pane ${launch.pane} but never registered its session id`);
      }
    }
    // Every later path that learned the session (the handoff's wait, a portable
    // successor's) consumes the record too, before the pin.
    consumeNodeLaunch();
    if (launch.sessionId && !deferReadiness) {
      (deps.pinSession || accounts.pinSession)(launch.sessionId, agent, account.id,
        { root: deps.root || keep.ROOT, env: deps.env || process.env, node: launchNode });
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
      if (error instanceof InjectionError) error.extra = { ...(error.extra || {}),
        ...(session ? { code: 'OPEN_EXISTING_PANE' } : {}), launch: started };
      else if (error && typeof error === 'object') error.launch ||= started;
    }
    // The requester keeps the card: the handoff is over.
    clearHandoff();
    throw error;
  }

  // The launched session goes on the card first; only then does the one that handed
  // it over leave, so a failed link leaves the card with its requester. A launch that
  // must not take the card (a review-queue discussion) links nothing on purpose, and
  // says nothing about it.
  if (handoff && launch.sessionId && deps.linkLaunchedSession !== skipCardLink) {
    try {
      if ((deps.linkLaunchedSession || keep.linkLaunchedSession)(body.taskId,
          { id: launch.sessionId, agent, node: launchNode })) {
        launch.linked = true;
      } else {
        process.stderr.write(`keep serve: could not link ${sessionRef(launch.sessionId)} to ${body.taskId}: no such card\n`);
      }
    } catch (error) {
      process.stderr.write(`keep serve: could not link ${sessionRef(launch.sessionId)} to ${body.taskId}: ${error.message}\n`);
      launch.linked = false;
    }
    if (launch.linked === true) release();
  }
  // Over, whether the requester left or kept the card, unless late adoption finishes it.
  if (!launch.pendingRegistration) clearHandoff();
  if (session && launch.sessionId) {
    try { require('./session-retirement').clear(deps.root || keep.ROOT, session.id); } catch {}
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
  const rememberedTurn = () => {
    const saved = readReopenHandoffSnapshot(root, session.id, target.id);
    if (saved) return saved;
    const turn = reopenTurnSnapshot({ ...session, kind: agent }, deps);
    writeReopenHandoffSnapshot(root, session.id, target.id, turn);
    return turn;
  };
  const validatedTurn = (saved) => {
    // Resume and account handoff can append startup records after the snapshot.
    // Only a newer model-usage record or an effective /model change replaces it.
    // Unknown model evidence must never restore the snapshot's older model.
    const fresh = reopenTurnSnapshot({ ...session, kind: agent }, deps);
    if (!keep.LAUNCH_MODEL_RE.test(String(fresh.model || ''))) {
      throw new InjectionError(409, 'current session model cannot be verified; reopen compaction was not started');
    }
    const savedUsage = Number.isFinite(saved.usageAt) ? saved.usageAt : null;
    const freshUsage = Number.isFinite(fresh.usageAt) ? fresh.usageAt : null;
    const modelChanged = fresh.model !== saved.model;
    const usedAgain = freshUsage != null && freshUsage !== savedUsage;
    if (!modelChanged && !usedAgain) {
      if (fresh.contextTokens > 0 && fresh.contextTokens !== saved.contextTokens) {
        throw new InjectionError(409, 'current session activity cannot be verified; reopen compaction was not started');
      }
      return saved;
    }
    if (!modelChanged && savedUsage != null && freshUsage < savedUsage) {
      throw new InjectionError(409, 'session usage record moved backward; reopen compaction was not started');
    }
    if (!Number.isFinite(fresh.contextTokens) || fresh.contextTokens < 0) {
      throw new InjectionError(409, 'current session context cannot be verified; reopen compaction was not started');
    }
    if (fresh.contextTokens < envNumber('KEEP_AUTO_COMPACT_MIN_TOKENS', 100000)) {
      clearReopenHandoffSnapshot(root, session.id);
    } else {
      writeReopenHandoffSnapshot(root, session.id, target.id, fresh);
    }
    return fresh;
  };
  const compactTarget = async (result, turn) => {
    if (result?.status !== 'done' || !result.pane) return result;
    try {
      let currentTurn = turn;
      const compacted = await withInjectionLockRetry(() => {
        assertCompactRestoreSettled(session.id, deps);
        currentTurn = validatedTurn(currentTurn);
        return compactReopenedSession(
          { ...session, kind: agent }, { pane: result.pane }, target, currentTurn,
          { ...deps, reopenForceCold: true });
      },
      { ...deps, injectionLockRetryMs: envNumber('KEEP_COMPACT_TIMEOUT_MS', 240000) + 30000 },
      { pane: result.pane, session: session.id, model: true });
      const signature = JSON.stringify([target.id, currentTurn.model, currentTurn.contextTokens, currentTurn.usageAt]);
      if (compacted?.compacted || reopenCompactAttempts.get(session.id) === signature) {
        clearReopenHandoffSnapshot(root, session.id);
      } else if (compacted && !compacted.compacted) {
        throw new InjectionError(409, `reopen compaction ${compacted.reason || 'failed'}; retry the open`);
      }
    } catch (error) {
      const launch = { pane: result.pane, sessionId: session.id, accountId: target.id, agent, recoverable: true };
      if (error instanceof InjectionError) error.extra = { ...(error.extra || {}), code: 'OPEN_EXISTING_PANE', launch };
      else error.launch = launch;
      throw error;
    }
    return result;
  };
  const promise = (async () => {
    const handoffs = require('./account-handoff').list(root);
    const recorded = handoffs.find((entry) => entry.sessionId === session.id);
    if (recorded && !['done', 'failed'].includes(recorded.status)) {
      if (recorded.targetAccountId !== target.id || recorded.intent !== 'open-only') {
        throw new InjectionError(409, 'A different account handoff is already pending for this session');
      }
      const turn = rememberedTurn();
      const resumed = await (deps.handoffSession || handoffSession)({ sessionId: session.id, pane: recorded.pane,
        accountId: target.id, intent: 'open-only', ownerForce: true }, deps);
      return compactTarget(resumed, turn);
    }
    if (recorded?.status === 'done' && recorded.targetAccountId === target.id && recorded.intent === 'open-only') {
      const turn = readReopenHandoffSnapshot(root, session.id, target.id);
      const opened = await (deps.openSession || openSession)({ sessionId: session.id, accountId: target.id },
        { ...deps, reopenForceCold: true, ...(turn ? { reopenCompaction: 'skip' } : {}) });
      if (turn && opened?.pane) await compactTarget({ status: 'done', pane: opened.pane }, turn);
      return opened;
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
    const turn = rememberedTurn();
    const opened = await (deps.openSession || openSession)({ sessionId: session.id, accountId: source.id },
      { ...deps, reopenCompaction: 'skip' });
    if (!opened?.pane) throw new InjectionError(502, 'Source session did not open in a verified pane');
    // Owner asked for this reopen, and the source is the pane just opened for it.
    const result = await (deps.handoffSession || handoffSession)({ sessionId: session.id, pane: opened.pane,
      accountId: target.id, intent: 'open-only', ownerForce: true }, deps);
    return compactTarget(result, turn);
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
  // The machine picked in the chooser, checked as /api/open checks it. None named is
  // the daemon node, where the review queue has always opened its conversations.
  if (body.node != null && (typeof body.node !== 'string' || !nodes.NODE_NAME_RE.test(body.node))) {
    throw new reviewQueue.QueueError(400, 'node must be a node name');
  }
  if (body.node != null && !placementNodes(deps).some((node) => node.name === body.node)) {
    throw new reviewQueue.QueueError(400, `node ${body.node} is not configured`);
  }
  return { agent, accountId: account.id, model, ...(body.node ? { node: body.node } : {}) };
}

// The link a launch that must not take its card passes openSession: it links
// nothing, and openSession, knowing it by identity, logs no failed link for it.
function skipCardLink() { return null; }

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
    // The review queue's own session, reserved and driven from here: on the machine
    // Owner picked in the chooser, else pinned to this node like every other session
    // Keep opens for itself.
    node: request.node || nodes.daemonNode(deps.env || process.env),
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
      ? skipCardLink
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
    catch (error) { process.stderr.write(`keep serve: could not link recovered review queue session ${sessionRef(sessionId)} to ${active.card}: ${error.message}\n`); }
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

// `interactiveOnly` applies the fleet scan's filter (claudeTranscriptIsInteractive,
// the same predicate scanClaudeSessions skips on): a caller that must not reach a
// session the fleet would not list, such as a tell, gets null for a headless
// `claude -p` transcript. Without it an exact lookup keeps any transcript, which is
// what hosted-pane backfill and delivery prechecks want.
function claudeSessionForEntry(id, file, stat, accountId = null, options = {}) {
  let info;
  const cached = claudeSessionParseCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    info = cached.info;
  } else {
    info = scanTranscript(file);
    cacheClaudeSessionLookup(claudeSessionParseCache, file, { mtimeMs: stat.mtimeMs, size: stat.size, info });
  }
  if (options.interactiveOnly === true && !claudeTranscriptIsInteractive(file, info, stat)) return null;
  const dir = path.basename(path.dirname(file));
  let reviewer = false;
  try { reviewer = fs.readdirSync(path.join(keep.ROOT, '.keep', 'reviewer')).includes(id); } catch {}
  return claudeSessionFromInfo(id, info, stat, dir, reviewer, Date.now(), accountId);
}

// A hosted session whose transcript does not exist yet (a pane opened and not yet
// spoken to) misses on every state build, and each miss walks every account's
// project tree. Build paths may take a recent miss as the answer for a short
// while: the rate-limit policy source, and the indexed resolver's fallback for an id
// its just-scanned fresh index covers (the index has just agreed with the miss).
// Direct action reads, and the indexed resolver's fallback over bounded rows or for
// an account the index does not cover, never read it. A pane appearing for the session, a spawn, or a meta change
// for that session forgets it early.
//
// Longer than the 30s handoff queue tick, so each policy read lands inside the
// window of the previous tick's miss instead of racing its expiry.
const CLAUDE_SESSION_MISS_TTL_MS = 45e3;
const CLAUDE_SESSION_MISS_LIMIT = 2048;
const claudeSessionMisses = new Map(); // session id -> when the miss was seen
const hostPaneSessionSignatures = new Map(); // session id -> the pane it was last seen in

function forgetClaudeSessionMisses(sessionId) {
  if (sessionId === undefined) claudeSessionMisses.clear();
  else claudeSessionMisses.delete(String(sessionId));
}

// A pane that is new for its session (or a pane that replaced one) is the moment a
// transcript can start existing, so an earlier miss for that id stops counting.
function noteHostPaneSessions(panes) {
  for (const pane of Array.isArray(panes) ? panes : []) {
    const id = pane?.meta?.sessionId;
    if (typeof id !== 'string' || !id) continue;
    const signature = `${pane.id}\0${pane.createdAt || ''}\0${pane.pid || ''}\0${pane.alive === true}`;
    if (hostPaneSessionSignatures.get(id) === signature) continue;
    hostPaneSessionSignatures.delete(id);
    hostPaneSessionSignatures.set(id, signature);
    claudeSessionMisses.delete(id);
    if (hostPaneSessionSignatures.size > CLAUDE_SESSION_MISS_LIMIT) {
      hostPaneSessionSignatures.delete(hostPaneSessionSignatures.keys().next().value);
    }
  }
}

function rememberClaudeSessionMiss(id, now) {
  claudeSessionMisses.delete(id);
  claudeSessionMisses.set(id, now);
  if (claudeSessionMisses.size > CLAUDE_SESSION_MISS_LIMIT) claudeSessionMisses.delete(claudeSessionMisses.keys().next().value);
}

function claudeSessionFor(sessionId, options = {}) {
  const id = String(sessionId || '');
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  if (options.allowCachedMiss === true) {
    const missedAt = claudeSessionMisses.get(id);
    if (missedAt !== undefined && now >= missedAt && now - missedAt < CLAUDE_SESSION_MISS_TTL_MS) return null;
  }
  const root = options.root || keep.ROOT;
  const env = options.env || process.env;
  const find = options.findSessionFile || ((sessionId) => findSessionFile(sessionId, { root, env }));
  // Durable authority only: letting forSession discover would walk every account's
  // project tree for a file this lookup finds anyway. A throw (an unfinished
  // handoff, an unavailable account) leaves it null and the cached file standing.
  let record = null;
  let recordFailed = false;
  try { record = accounts.forSession(id, 'claude', { root, env, allowDiscovery: false }); }
  catch { recordFailed = true; }
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
    // An account handoff copies the transcript and leaves the source's in place, so
    // a remembered file can be the old account's, carrying its old rate limit.
    // Authority that now names another account is answered from that account's copy:
    // the same project directory under its root (where a handoff copies to), or the
    // file an earlier walk found there. With neither, the remembered file is what
    // findSessionFile's own fallback would return, so it stands rather than paying
    // a walk of every project directory on every call to reach the same answer.
    if (file && record && accounts.claudeAccountForFile(file, env) !== record.id) {
      const moved = accounts.claudeFileInAccount(id, record.id, path.basename(path.dirname(file)), env)
        || accounts.knownClaudeFile(id, record.id, env)?.file || null;
      let movedStat = null;
      if (moved) try { movedStat = fs.statSync(moved); } catch {}
      if (movedStat && movedStat.isFile()) {
        file = moved;
        stat = movedStat;
      }
    }
  }
  if (!file) {
    file = find(id);
    if (file) {
      try { stat = fs.statSync(file); } catch { file = null; }
      if (file && !stat.isFile()) file = null;
    }
    if (!file) {
      rememberClaudeSessionMiss(id, now);
      return null;
    }
  }
  claudeSessionMisses.delete(id);
  cacheClaudeSessionLookup(claudeSessionPathCache, id, file);
  // With no record, the account is the one whose projects root holds the file,
  // which is what discovery would have answered (findSessionFile already refused
  // an ambiguous one). A record that could not be read names no account: an
  // unfinished handoff has no ordinary resume account, as in the dashboard resolver.
  let accountId = null;
  if (!recordFailed) {
    try { accountId = record ? record.id || null : accounts.claudeAccountForFile(file, env); } catch {}
  }
  return claudeSessionForEntry(id, file, stat, accountId, { interactiveOnly: options.interactiveOnly === true });
}

// Host-only sessions were absent from the recent-session result, but their old
// transcripts are already present in the dashboard index. Resolve every host
// pane from one snapshot instead of walking every account's project tree once
// or twice per pane. Action paths do not consume this bounded snapshot.
function createDashboardClaudeSessionResolver(deps = {}) {
  const rows = deps.rows || claudeTranscriptIndex.scan();
  const authority = deps.authority || accounts.authority(deps.root || keep.ROOT);
  const daemonNode = nodes.daemonNode(deps.env || process.env);
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
    // A session that runs on another node has no transcript on this machine. The
    // dashboard treats it as absent rather than reading whatever local file shares
    // its id, which is the same answer findSessionFile gives.
    if (record && record.node && record.node !== daemonNode) return null;
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

// The same one-snapshot resolution for a state build outside the dashboard, over
// the rows scanClaudeSessions just read. `fresh` says how those rows were read;
// rows handed in without it count as bounded. An id the rows do not hold, or one
// pinned to an account the index does not cover (added since the daemon started),
// goes to the exact lookup instead.
//
// That lookup may reuse a recent miss only when the rows were a fresh scan AND the
// index covers every account the transcript could be in: then a walk has just
// agreed with the miss. Fresh rows are what let action paths (inspectAccountHandoff,
// inspectPortableSource) use this. Bounded rows may simply not have indexed a
// transcript written since their last sweep, and an uncovered account was never
// looked at, so in either case a remembered miss could hide a first turn and the
// exact lookup walks instead.
function createIndexedClaudeSessionResolver(deps = {}) {
  const rowsFresh = deps.rows ? deps.fresh === true : deps.fresh !== false;
  const rows = deps.rows || claudeTranscriptIndex.scan({ fresh: rowsFresh });
  const authority = deps.authority || accounts.authority(deps.root || keep.ROOT);
  const indexedAccounts = new Set(deps.accountIds || claudeProjectRoots.map((entry) => entry.accountId));
  // A session with no record can be in any configured account, including one the
  // index was not built with. This compares ids only: an account whose configDir
  // changed under the same id still counts as indexed although the index scans its
  // old root, until a daemon restart builds the index over the new one.
  const configuredAccounts = deps.configuredAccountIds
    || accounts.projectRoots(deps.env || process.env).map((entry) => entry.accountId);
  const everyAccountIndexed = configuredAccounts.every((accountId) => indexedAccounts.has(accountId));
  const known = new Set(rows.map((row) => row.id));
  const indexed = createDashboardClaudeSessionResolver({ ...deps, rows, authority, accountIds: [...indexedAccounts] });
  const exact = deps.claudeSessionFor || ((id, options) => claudeSessionFor(id, options));
  return (sessionId) => {
    const id = String(sessionId || '');
    const record = authority[id];
    const covered = record
      ? record.agent !== 'claude' || indexedAccounts.has(record.accountId)
      : everyAccountIndexed;
    if (known.has(id) && covered) return indexed(id);
    return covered && rowsFresh ? exact(id, { allowCachedMiss: true }) : exact(id, {});
  };
}

// The transcript-watcher health row a daemon start records. A projects directory
// that does not exist yet (an account added and never used) is nothing to watch
// and nothing the index can miss, so it is named, not failed: the row stays ok.
// Any other start failure leaves the bounded index on sweeps alone, which is.
function transcriptWatcherStartHealth(starts) {
  const list = Array.isArray(starts) ? starts : [];
  const failed = list.find((start) => start && start.error && start.error.code !== 'ENOENT');
  if (failed) {
    const message = String(failed.error.message || failed.error);
    return { ok: false, error: `${failed.accountId || 'a Claude account'}: ${message}; bounded scans rely on sweeps until restart` };
  }
  const missing = list.filter((start) => start && start.error).map((start) => start.accountId || 'unknown');
  const watching = list.length - missing.length;
  return {
    ok: true,
    detail: `watching ${watching} of ${list.length} Claude project root${list.length === 1 ? '' : 's'}`
      + (missing.length ? ` (missing: ${missing.join(', ')})` : ''),
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
  // Fresh re-lists every project directory and stats every transcript (tens of
  // thousands on a long-lived machine); bounded trusts the watcher and re-stats a
  // transcript touched in the last 48 h at most every 5 s, anything older every
  // 60 s, and costs no I/O when nothing changed. A directory whose mtime moved is
  // re-listed and all its entries re-statted, so a created or renamed-over
  // transcript is seen by either mode. What bounded can miss, when a watcher event
  // is dropped (or the watcher is dead, see the transcript-watcher health row), is
  // an append: up to 5 s for a recent transcript, and up to 60 s for one idle over
  // 48 h. SESSION_WINDOW_MS is the same 48 h, so such a resumed session is not just
  // late but absent from bounded rows for up to that 60 s.
  //
  // Bounded (fresh: false) is for callers that only decide whether to act later and
  // re-read the session they pick before touching it: the auto-compact, limit-resume,
  // live-ledger, stall, reviewer first-look, turn-watcher and ephemeral-pane ticks. A
  // 5 s-stale mtime there costs at most one tick of delay, because the action itself
  // goes through loadCurrentSession or its own precheck. The notes sweep stays fresh:
  // it hands a note to Owner for good when the author is absent.
  //
  // Fresh is for a path that acts on a named session now (restart, close, account
  // and portable handoff inspection, delivery, restore): it must not miss a
  // transcript that exists or read one a turn behind. It stays the default outside
  // the dashboard, so a caller nobody classified keeps it. resolveSessionId and a dry
  // tell reuse sessionSnapshot when it is under 5 s old, whichever scan wrote it, as
  // they did with dashboard builds before scans had a mode.
  const fresh = typeof options.fresh === 'boolean' ? options.fresh : options.dashboard !== true;
  const transcriptRows = claudeTranscriptIndex.scan({ fresh });
  if (typeof options.onTranscriptRows === 'function') options.onTranscriptRows(transcriptRows, { fresh });
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
    attachClaudeMarker(session, attentionDir, now, activityMs, readOnly);
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

// A Claude session's attention marker, as the hooks wrote it: a pending permission
// prompt, an idle wait, or a completed turn. Shared by the fleet scan and the
// per-session read a tell makes (loadTellSession), so the two cannot disagree about
// whether a session is holding a prompt. A stale marker is deleted only by a caller
// that may write.
function attachClaudeMarker(session, attentionDir, now, activityMs, readOnly) {
  try {
    const markerFile = path.join(attentionDir, `${session.id}.json`);
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
  try { sessions.push(...pi.scan({ root: keep.ROOT })); } catch {}
  // Hand-typed names are stamped before every titling pass: the generator must
  // see `renamed` so it leaves the name alone.
  sessionNames.apply(sessions, { root: keep.ROOT });
  sessionMarks.apply(sessions, { root: keep.ROOT });
  titles.applyLiveTitles(sessions, { cachedOnly: true });
  sessions.sort((a, b) => b.mtime - a.mtime);
  // Every session carries its short number from here on: the snapshot below is
  // what the dashboard state, /api/state and the console all read.
  sessionNumbers.assign(sessions, { root: keep.ROOT, readOnly: options.allocateNumbers === false });
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
    // Bounded: a ledger of what was alive, refreshed every tick; nothing acts on it here.
    try { scanned = await (deps.scanSessions || scanSessions)({ fresh: false }); } catch {}
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

    const hasTranscript = agent === 'codex' ? true : agent === 'pi'
      ? Boolean((deps.piFileFor || pi.fileFor)(id)) : Boolean((deps.transcriptExists || findSessionFile)(id));
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
  // Bounded: a stall report already accepts a snapshot up to five minutes old.
  return scanSessions({ readOnly: true, fresh: false });
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
  // Outside the dashboard these rows answer host-only panes too. By default they are
  // a fresh scan, as current as a walk, which action paths rely on; a build asked for
  // with fresh: false gets bounded rows, and the resolver is told which it has.
  let indexedTranscriptRows = null;
  let indexedTranscriptRowsFresh = false;
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
    ...(typeof options.fresh === 'boolean' ? { fresh: options.fresh } : {}),
    dashboardWorker: workerMode,
    readOnly: workerMode,
    hostPanes: options.hostPanes || [],
    hostPanesBySession: panesBySession,
    independentLive,
    accountAuthority: dashboardAccountAuthority,
    onSessionSource: rememberDashboardSource,
    onSettledHit: (session, jobs) => settledBackgroundJobs.set(`${session.kind}:${session.id}`, jobs),
    onTranscriptRows: (rows, scan) => {
      if (options.dashboard === true) dashboardTranscriptRows = rows;
      else {
        indexedTranscriptRows = rows;
        indexedTranscriptRowsFresh = scan?.fresh === true;
      }
    },
  });
  // scanSessions just reconciled this exact index snapshot synchronously. Reuse
  // it for host-only rows instead of statting every project directory again.
  if (Object.prototype.hasOwnProperty.call(options, 'hostPanes')) {
    backfillHostSessions(sessions, options.hostPanes, {
      tasks,
      ...(options.nodeSessions ? { nodeSessions: options.nodeSessions } : {}),
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
      ...(indexedTranscriptRows ? {
        createIndexedClaudeSessionResolver: () => createIndexedClaudeSessionResolver({
          rows: indexedTranscriptRows,
          fresh: indexedTranscriptRowsFresh,
          onSessionSource: rememberDashboardSource,
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
  sessionNames.apply(sessions, { root: keep.ROOT });
  sessionMarks.apply(sessions, { root: keep.ROOT });
  titles.applyLiveTitles(sessions, {
    onChange,
    cachedOnly: workerMode,
    taskFor: (session) => taskById.get(session.taskId),
  });
  applySessionLiveness(sessions, liveLedger, options.hostPanes || [], now);
  const dependencyCache = new Map();
  const liveHostedSessions = new Set((options.hostPanes || []).filter((pane) => pane.alive && pane.agentAlive !== false).map((pane) => pane.meta?.sessionId));
  applyHostedExitState(sessions, options.hostPanes, independentLive);
  // Keep-running is a process preference, and automatic-retirement metadata is
  // conversation history. Attach both before activity is derived so an unread
  // completion preserved by retirement still produces the same attention state.
  require('./session-retirement').apply(sessions, {
    root: keep.ROOT,
    panes: options.hostPanes || [],
    write: !workerMode,
  });
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
      'backgroundJobs', 'activity', 'observation', 'stateLabel', 'stalled', 'renamed', 'mark',
      // Attached further down, after this block, and re-read from the usage snapshot
      // on every build. Listed so a reordering cannot freeze a settled session's
      // totals at whatever the collector had seen the moment it was cached.
      'modelUsage']);
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
      // A hand-typed name is re-applied on every build from its registry, so the
      // frozen row keeps the transcript title: a name cleared while the row was
      // cached must not come back with it.
      if (frozen.renamed && typeof frozen.baseTitle === 'string') frozen.title = frozen.baseTitle;
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
  // Agent records are on disk, and a session carrying a standing agent is marked
  // here so the console can tell it apart from a working session. It happens before
  // the attention queue below and not after it, which is where it used to sit: the
  // queue asks whether a session is an agent's, and an agent nobody is watching must
  // not take a "Waiting on you" slot. The reviewer's own row is derived further down,
  // once its stats have been built.
  let agentRecords = [];
  try {
    agentRecords = agents.records(keep.ROOT);
    agents.applySessions(sessions, agentRecords, options.hostPanes || []);
  } catch {}
  const attention = [];
  for (const s of sessions) {
    const item = sessionAttentionItem(s, now);
    if (item) attention.push(item);
  }
  // A message-less console launch is actionable before Codex registers its session
  // id. Include the pane row before acknowledgement and set-aside reconciliation so
  // Dismiss/Snooze use the same durable lifecycle as session-backed attention.
  attention.push(...pendingPaneAttention(options.hostPanes || [], sessions, now));
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
  // What this session itself has spent, beside the card total the header already
  // shows, so moving a session to a fresh card does not read as a usage reset. These
  // rows are rebuilt every pass (the settled cache hands back a clone, and scanCache
  // holds the parsed transcript rather than the row), so assigning in place is safe.
  // It happens after the settled-session freeze above so no usage figure is cached.
  for (const session of sessions) {
    if (session.kind !== 'claude' && session.kind !== 'codex') continue;
    session.modelUsage = cardUsage.forSession(cardUsageSummary, session.kind, session.id);
  }
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
    handoffQueue: require('./handoff-queue').visible(keep.ROOT, now),
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
  // The reviewer is the first agent, derived from the stats above rather than
  // stored: `.keep/reviewer/<id>` keeps owning the reviewer's own state, and
  // `session.reviewer` keeps its meaning.
  try {
    state.agents = agents.dashboardAgents({
      root: keep.ROOT, records: agentRecords, sessions, panes: options.hostPanes || [],
      reviewer: state.review?.stats?.reviewer || null,
    });
  } catch { state.agents = []; }
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
  sessionNames.apply(state.sessions, { root: keep.ROOT });
  sessionMarks.apply(state.sessions, { root: keep.ROOT });
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
  let nonDashboardIndexedClaudeSessionFor = null;
  for (const pane of hostPanesBySession(panes).values()) {
    try {
      const meta = pane && pane.meta;
      const id = meta && meta.sessionId;
      const agent = meta && meta.agent;
      if (!pane || typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)
        || !['claude', 'codex', 'pi'].includes(agent) || sessionIds.has(id)) continue;
      const lookup = agent === 'codex'
        ? deps.codexSessionFor || codex.sessionFor
        : agent === 'pi' ? deps.piSessionFor || pi.sessionFor
        : deps.claudeSessionFor || (deps.dashboard === true
          ? (indexedClaudeSessionFor ||= (deps.createDashboardClaudeSessionResolver || createDashboardClaudeSessionResolver)())
          : deps.createIndexedClaudeSessionResolver
            ? (nonDashboardIndexedClaudeSessionFor ||= deps.createIndexedClaudeSessionResolver())
            : deps.freshClaudeSessionFor || claudeSessionFor);
      let session = null;
      try { session = lookup(id); } catch {}
      // A session on another node has no transcript here. Its node's own read, taken
      // for this listing (remoteSessionFreshness), stands in for the local one: size,
      // mtime, endedTurn and the rest, as a local row has them. Without one the row is
      // the pane's alone and carries no transcript size, so nothing - the stalled
      // detector included - judges it by a size nobody read.
      const remotePane = !session && nodes.isRemotePane(pane, paneRefEnv(deps));
      const fromNode = remotePane && deps.nodeSessions && Object.prototype.hasOwnProperty.call(deps.nodeSessions, id)
        ? deps.nodeSessions[id] : null;
      const fromThisNode = Boolean(fromNode && fromNode.id === id && fromNode.node === pane.node && fromNode.kind === agent);
      // A Pi session on another node brings its phase, not a row: the row is the pane's.
      if (fromThisNode && agent !== 'pi') session = { ...fromNode };
      if (!session) {
        const piEvent = agent !== 'pi' ? null
          : remotePane ? (fromThisNode && fromNode.piEvent && fromNode.piEvent.id === id ? fromNode.piEvent : null)
          : pi.eventFor(id, path.join(deps.root || keep.ROOT, '.keep', 'pi-events'));
        const piPhase = piEvent?.phase || '';
        session = {
          id,
          kind: agent,
          project: meta.project || pane.cwd || '',
          title: meta.title || pane.title || '',
          lastUser: '',
          lastAssistant: '',
          lastAssistantFull: '',
          mtime: Math.max(Date.parse(pane.createdAt) || 0, Date.parse(piEvent?.at || '') || 0) || Date.now(),
          size: 0,
          endedTurn: agent === 'pi' ? piPhase !== 'running' : meta.openingMessage !== true,
          ...(agent === 'pi' ? { toolRunning: piPhase === 'running' }
            : meta.openingMessage === true ? { toolRunning: true } : {}),
          state: (agent === 'pi' && piPhase === 'running') || meta.openingMessage === true ? 'running' : 'recent',
        };
        // A Pi session on a node has only this row, so its phase says what pi.parse
        // says of a local one: idle after a turn, and waiting when Pi asks something.
        if (agent === 'pi' && remotePane && piEvent) {
          const ended = ['settled', 'start', 'prompt'].includes(piPhase);
          if (ended && Date.now() - session.mtime < 3600e3) session.state = 'idle';
          session.attentionAt = Date.parse(piEvent.at || '') || session.mtime;
          if (piPhase === 'prompt') session.pendingQuestion = { question: 'Pi is waiting for input.' };
        }
        if (remotePane) delete session.size;
      } else {
        session = { ...session };
      }
      session.id = id;
      session.pane = pane.id;
      // The machine the pane is on, carried into the publication so no consumer has
      // to re-derive it. Omitted on the daemon node, the way pane meta and card links
      // omit theirs: a single-node install publishes the rows it always published.
      if (nodes.isRemotePane(pane, paneRefEnv(deps))) session.node = pane.node;
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
  // Host-only rows join after scanSessions numbered the rest, so number them here;
  // the registry hands a known session its old number and a new one the next.
  if (added.length) {
    sessionNumbers.assign(added, { root: deps.root || keep.ROOT });
    // These rows never pass through a titling call, so their hand-typed name has
    // to be stamped here or a renamed host-only session shows its pane title.
    sessionNames.apply(added, { root: deps.root || keep.ROOT });
    sessionMarks.apply(added, { root: deps.root || keep.ROOT });
  }
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
    // As in backfillHostSessions: the pane says which machine, and only when it is
    // not this one. A registry session whose pane is here keeps no `node` key.
    if (pane && nodes.isRemotePane(pane, paneRefEnv(deps))) session.node = pane.node;
    // The launch model from `keep open --model`, when the pane carries one.
    const launchModel = pane && pane.meta && pane.meta.model;
    if (typeof launchModel === 'string' && launchModel) session.launchModel = launchModel;
    // Whether Keep opened this session for a program rather than for Owner. A console
    // keystroke clears the pane mark, so this follows the pane and not the launch.
    session.unattended = Boolean(pane?.meta?.unattended);
    session.opener = pane?.meta?.opener || null;
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
  state.attention ||= [];
  for (const item of state.attention || []) {
    if (item.sessionId) item.pane = sessionPanes.get(item.sessionId) || null;
  }
  const representedPanes = new Set(state.attention.map((item) => item.pane).filter(Boolean));
  for (const item of pendingPaneAttention(panes, state.sessions || [])) {
    if (representedPanes.has(item.pane)) continue;
    item.setAside = state.setAside?.[item.key]?.kind || null;
    state.attention.push(item);
  }
  state.panes = panes || [];
  return state;
}

// What the last builds read of each exited session's location record, by its file:
// a record whose (mtimeMs, size) has not changed is not read again. The worker keeps
// this across its 5 s builds; bounded, oldest out first.
const stoppedNodeCache = new Map(); // file -> { mtimeMs, size, node }
const STOPPED_NODE_CACHE_MAX = 4096;

function cachedSessionNode(sessionId, root, env, read) {
  const file = accounts.authorityFile(root, sessionId);
  let stat;
  try { stat = fs.statSync(file); } catch (error) {
    stoppedNodeCache.delete(file);
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  const hit = stoppedNodeCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.node;
  // A record that does not read is not cached: it throws again next build, as before.
  const node = read(sessionId, { root, env });
  stoppedNodeCache.delete(file);
  stoppedNodeCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, node });
  while (stoppedNodeCache.size > STOPPED_NODE_CACHE_MAX) stoppedNodeCache.delete(stoppedNodeCache.keys().next().value);
  return node;
}

// Where an exited session lives, from its location record: the pane that said so is
// gone (or is an old one on the machine it left), and the console still names the
// machine and offers a move from there. `node` keeps its live meaning, named only when
// it is not the daemon's own; `nodeRecorded` says the record exists, so the daemon's
// node is known rather than assumed. Only on a fleet: a single-node install has one
// answer and reads nothing. Sync, one stat per exited session and a read only for a
// record that changed (cachedSessionNode): this runs in the dashboard build worker,
// never on the daemon's loop.
function addStoppedSessionNodes(state, deps = {}) {
  if (!Array.isArray(state?.sessions) || hostNodeNames(deps).length < 2) return state;
  const root = deps.root || keep.ROOT;
  const env = deps.env || process.env;
  const daemon = daemonNodeName(deps);
  const lookup = deps.sessionNode
    || ((id) => cachedSessionNode(id, root, env, deps.readSessionNode || accounts.sessionNode));
  for (const session of state.sessions) {
    if (!session || typeof session.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(session.id)) continue;
    if (!(session.exited === true || session.state === 'exited' || session.alive === false)) continue;
    let node = null;
    try { node = lookup(session.id, { root, env }); } catch {}
    if (!node) continue;
    session.nodeRecorded = true;
    if (node !== daemon) session.node = node;
    else delete session.node;
  }
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

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > maxBytes) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad JSON body')); }
    });
    req.on('error', reject);
  });
}

async function inspectAccountHandoff(body, deps = {}) {
  const panes = await listHostPanes(deps, true);
  // A host that did not answer is not a missing pane: account-handoff refuses this one as
  // a transient host timeout rather than "needs the original pane".
  if (!panes) return { hostUnavailable: true };
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
    if (session?.kind === 'claude') currentModel = handoffCurrentModel(session, pane, processArgs, deps);
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

// An account transfer stops one agent, rewrites this machine's account authority
// and starts the conversation again from a transcript here, proving each step from
// this machine's process table. A session on another node is refused before any of
// it begins — account-handoff.run would refuse a qualified pane too, but with
// nothing to tell a person about which machine the session is actually on.
function refuseRemoteHandoff(body, deps = {}) {
  const node = sessionNodeOf({ sessionId: body?.sessionId, pane: body?.pane }, deps);
  if (node !== daemonNodeName(deps)) {
    throw new InjectionError(409, `account handoff is not available for a session on ${node}`);
  }
}

async function handoffSession(body, deps = {}) {
  refuseRemoteHandoff(body, deps);
  const root = deps.root || keep.ROOT;
  const deliveryDirectory = deps.deliveryDirectory || path.join(root, '.keep', 'delivery');
  return require('./account-handoff').run(body, {
    ...deps,
    root,
    inspect: deps.inspect || ((request) => inspectAccountHandoff(request, deps)),
    // A fresh snapshot for proving an unverified stop after the fact.
    agentProcessRows: deps.agentProcessRows ? () => deps.agentProcessRows(deps) : () => agentProcessRows(deps),
    host: deps.host || { request: (type, params) => hostRequest(type, params, deps) },
    restartSession: deps.restartSession || restartSession,
    restartDeps: deps.restartDeps || deps,
    resumeExited: deps.resumeExited || ((entry, account, mcpConfig, hooks = {}) => resumeExitedAccountHandoff(entry, account, mcpConfig,
      { ...deps, ...hooks })),
    waitForAccountRecord: deps.waitForAccountRecord || ((sid, pane, accountId, after) => waitForAccountRecord(sid, pane, accountId, after, deps)),
    continueSession: deps.continueSession || ((sessionId, text, options) => continueAccountHandoff(sessionId, body.pane, body.accountId,
      text, options?.deliveryId, options, { ...deps, deliveryDirectory })),
    deliveryStatus: deps.deliveryStatus || ((_sessionId, text, deliveryId) => require('./delivery').statusForTextAsync(deliveryDirectory, text, deliveryId,
      { receiptFor: (entry) => deliveryReceiptFor(entry, deps) })),
    verifyTargetSpec: deps.verifyTargetSpec || (async (entry, target) => {
      if (!entry.resumeSpec) return true;
      const verified = require('./codex-handoff-support').readResumeSpec(entry.targetTranscript, entry.sessionId);
      if (verified.digest !== entry.resumeSpec.digest) throw new InjectionError(409, 'Target Codex resume policy differs from the stopped source');
      return true;
    }),
  });
}

// ---------- keep move: a Claude or Codex session from one node to another ----------
//
// bin/session-move.js is the state machine; these are the machines it acts on. Every
// check that asks a node something fails closed: a node that does not answer is a
// node nothing is moved to or from.

// The account as a node keeps it. The fleet shares one home, so it is this machine's
// record; a test that gives a node a home of its own says otherwise through deps.
function moveNodeAccount(node, account, deps = {}) {
  return deps.moveNodeAccount ? deps.moveNodeAccount(node, account) : account;
}

function moveEndpoint(node, account, deps = {}) {
  return node === daemonNodeName(deps)
    ? localSessionArtifacts(account, deps)
    : nodeArtifacts(node, moveNodeAccount(node, account, deps), deps);
}

// Whether an agent process for this conversation runs on `node`, from that node's own
// table read now (not the listing's short cache, which may predate the stop being
// proven). A table that cannot be read, or the evidence the agent kind is named by
// (a Claude row's child environment, a Codex row's open rollouts) that could not be
// read, proves nothing either way and refuses, on the daemon node as on any other:
// this is the only stop proof when the stop had no live Keep pane to close.
async function agentLiveOn(node, sessionId, deps = {}, agent = 'claude') {
  let live;
  if (node === daemonNodeName(deps)) {
    live = await (deps.liveSessionPids || liveSessionPids)({ ...deps, processRowsCache: { value: null, at: 0, pending: null } });
  } else {
    nodeProcessRowsCaches.delete(node);
    let rows = null;
    try { rows = await (deps.agentProcessRows || agentProcessRows)(deps, { node }); } catch {}
    live = await (deps.liveSessionPids || liveSessionPids)({ ...deps, agentProcessRows: async () => rows }, { node });
  }
  if (unverifiedProcesses(live, agent === 'codex' ? 'codex' : 'claude')) {
    throw new InjectionError(409, `the process table on ${node} could not be read, so whether ${sessionRef(sessionId)} still runs there is unproven`,
      { reason: 'processes-unverified' });
  }
  return live.has(sessionId);
}

// No agent process for this conversation on `node`; anything short of that proof refuses.
async function requireNoAgentOn(node, sessionId, deps = {}, agent = 'claude') {
  if (await agentLiveOn(node, sessionId, deps, agent)) {
    throw new InjectionError(409, `an agent process still owns ${sessionRef(sessionId)} on ${node}`, { reason: 'source-running' });
  }
}

// How a Codex launch's argv names its model (`-m`, or `--model`), and the one Codex
// flag a move carries: the permission class Keep launches Codex in.
const CODEX_ARGV_MODEL_RE = /(?:^|\s)(?:-m|--model)(?:=|\s+)["']?([A-Za-z0-9][A-Za-z0-9._:[\]/-]*)["']?(?=\s|$)/;
const CODEX_BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox';

async function inspectSessionMove(sessionId, deps = {}) {
  const root = deps.root || keep.ROOT;
  const env = deps.env || process.env;
  const daemon = daemonNodeName(deps);
  let location = null;
  try { location = accounts.sessionLocation(sessionId, { root, env }); }
  catch (error) { throw new InjectionError(409, error.message); }
  const from = location ? location.node : daemon;
  // A Codex session on another node has no session row here (its state would need the
  // rollout's first line as well as its tail, and remoteSessionRead refuses one): what
  // the move needs comes from its pane, its node's process table and its rollout's
  // session_meta and last turn, read on that node.
  const hostOnly = Boolean(location && location.agent === 'codex' && from !== daemon);
  let session = null;
  if (!hostOnly) {
    try { session = await loadSessionForAction(sessionId, deps); }
    catch (error) { if (!(error instanceof InjectionError) || error.status !== 404) throw error; }
  }
  const panes = await (deps.listHostPanes || listHostPanes)(deps, true);
  if (!Array.isArray(panes)) throw new InjectionError(409, 'the terminal hosts did not list their panes; nothing was moved');
  const pane = panes.find((entry) => entry && entry.alive !== false && entry.meta && entry.meta.sessionId === sessionId) || null;
  const agent = (location && location.agent) || (session && session.kind) || (pane && pane.meta.agent) || null;
  let account = null;
  if (agent) {
    try { account = accounts.forSession(sessionId, agent, { root, env }); }
    catch (error) { throw new InjectionError(409, error.message); }
  }
  let args = '';
  if (pane) {
    const node = sessionNodeOf(pane, deps);
    let rows = null;
    try { rows = await (deps.agentProcessRows || agentProcessRows)(deps, { node }); } catch {}
    const live = await (deps.liveSessionPids || liveSessionPids)({ ...deps, agentProcessRows: async () => rows }, { node });
    const identity = live.get(sessionId);
    if (!identity) throw new InjectionError(409, `the agent process of ${sessionRef(sessionId)} could not be verified on ${node}`);
    args = ((rows || []).find((row) => row.pid === identity.pid) || {}).args || '';
  }
  if (agent === 'codex') return inspectCodexMove({ sessionId, from, hostOnly, session, pane, account, args }, deps);
  let model = launchModelId(pane && pane.meta && pane.meta.model) || launchModelId(HANDOFF_ARGV_MODEL_RE.exec(args)?.[1]) || '';
  if (!model && session && from === daemon && agent === 'claude') {
    try { model = handoffCurrentModel(session, pane, args, deps) || ''; } catch { model = '<unknown>'; }
  }
  const record = readPaneRecord(sessionId, deps);
  return {
    agent, from, account, session,
    pane: pane ? { id: pane.id, pid: pane.pid, createdAt: pane.createdAt, node: sessionNodeOf(pane, deps) } : null,
    cwd: (session && session.project) || (pane && (pane.meta.project || pane.cwd)) || (record && record.cwd) || null,
    model, bypass: args.split(/\s+/).includes('--dangerously-skip-permissions'),
  };
}

// The rest of inspectSessionMove for a Codex session. The model is the pane's launch
// model, else the `-m` its process was given, else what its rollout says it last ran
// on (a turn_context's model, then session_meta's), and `<unknown>` when none of
// those can be read, which the preflight refuses. `flags` is the Codex permission
// class its process runs in, to launch the target in the same one (null when there is
// no process to read it from: the target then gets Keep's default). `running`, for a
// session with no row here, is its node's process table: a live one there needs
// Owner's force to leave, and a table that cannot be read refuses.
async function inspectCodexMove({ sessionId, from, hostOnly, session, pane, account, args }, deps = {}) {
  const env = deps.env || process.env;
  const daemon = daemonNodeName(deps);
  let rollout;
  const readRollout = async () => {
    if (rollout !== undefined) return rollout;
    rollout = null;
    try {
      if (from === daemon) {
        const where = account && require('./codex').configuredRoots(env).find((entry) => entry.accountId === account.id);
        if (where) rollout = require('./node-transcript').rolloutMeta(where.configDir, sessionId);
      } else {
        rollout = await (deps.nodeTranscript || nodeTranscript)(from, { id: sessionId, kind: 'codex' }, deps).meta();
      }
    } catch { rollout = null; }
    return rollout;
  };
  let model = launchModelId(pane && pane.meta && pane.meta.model) || launchModelId(CODEX_ARGV_MODEL_RE.exec(args)?.[1]) || '';
  if (!model) {
    const read = await readRollout();
    model = launchModelId(read && read.model) || launchModelId(read && read.meta && read.meta.model) || '<unknown>';
  }
  const record = readPaneRecord(sessionId, deps);
  let cwd = (session && session.project) || (pane && (pane.meta.project || pane.cwd)) || (record && record.cwd) || null;
  if (!cwd) {
    const read = await readRollout();
    cwd = (read && read.meta && read.meta.cwd) || null;
  }
  const running = hostOnly && !pane ? await agentLiveOn(from, sessionId, deps, 'codex') : false;
  return {
    agent: 'codex', from, account, session,
    pane: pane ? { id: pane.id, pid: pane.pid, createdAt: pane.createdAt, node: sessionNodeOf(pane, deps) } : null,
    cwd, model, bypass: false,
    flags: pane ? (args.split(/\s+/).includes(CODEX_BYPASS_FLAG) ? CODEX_BYPASS_FLAG : '') : null,
    ...(running ? { running: true } : {}),
  };
}

// Why a Codex session cannot be moved yet, from what this daemon keeps for it that
// names this machine's files, or null. Neither record follows a move: a compaction
// swap record restores a config file here (even one deferred for a rate limit), and a
// restart ledger with open background jobs is synced against the rollout here.
function codexMoveObstacle(sessionId, deps = {}) {
  const root = deps.root || keep.ROOT;
  if (pendingCompactRestoreFile(sessionId, deps)) {
    return 'a Codex compaction swap record names this machine\'s config and rollout; it does not follow a move, so let its restore finish first';
  }
  let ledger = null;
  try { ledger = require('./background-jobs').read(root, 'codex', sessionId); } catch {}
  const open = ((ledger && ledger.jobs) || []).filter((job) => job && !['completed', 'failed', 'cancelled'].includes(job.status)
    && !['service', 'scheduled'].includes(job.kind));
  if (open.length) {
    return `its Codex restart ledger tracks ${open.length} open background job${open.length === 1 ? '' : 's'} against the rollout on this machine; they do not follow a move, so let them finish first`;
  }
  return null;
}

// A resumed Codex's start, from the target's own evidence: the launch's pane is still
// live and names the session, and an agent process under that pane runs it (its argv
// says `resume <id>`, or it holds the rollout open). Codex fires SessionStart only at
// its first turn, so an idle resumed session would otherwise never report. Written as
// the pane record late adoption writes (bound, claimed, on its node, its account),
// and resolved; null when the evidence is not there (yet).
async function verifyMovedCodexPane(record, deps = {}) {
  const daemon = daemonNodeName(deps);
  const node = record.to;
  const panes = await (deps.listHostPanes || listHostPanes)(deps, true);
  const pane = Array.isArray(panes) ? panes.find((entry) => entry && entry.id === record.launch.pane) : null;
  if (!pane || pane.alive === false || !Number.isInteger(pane.pid) || !pane.meta || pane.meta.sessionId !== record.sessionId
      || (pane.meta.agent && pane.meta.agent !== 'codex') || sessionNodeOf(pane, deps) !== node
      || (Number.isInteger(record.launch.pid) && pane.pid !== record.launch.pid)) return null;
  let rows = null;
  try { rows = await (deps.agentProcessRows || agentProcessRows)(deps, node === daemon ? {} : { node }); } catch {}
  if (!Array.isArray(rows)) return null;
  const live = await (deps.liveSessionPids || liveSessionPids)({ ...deps, agentProcessRows: async () => rows }, node === daemon ? {} : { node });
  if (unverifiedProcesses(live, 'codex')) return null;
  const identity = live.get(record.sessionId);
  if (!identity || identity.agent !== 'codex') return null;
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  let row = byPid.get(identity.pid);
  const seen = new Set();
  let under = false;
  while (row && !seen.has(row.pid)) {
    if (row.pid === pane.pid) { under = true; break; }
    seen.add(row.pid);
    row = byPid.get(row.ppid);
  }
  if (!under && identity.pid !== pane.pid) return null;
  const at = Date.now();
  const written = {
    at, startedAt: at, cwd: record.cwd, agent: 'codex', pane: record.launch.pane, claimed: true,
    ...(node === daemon ? {} : { node }), accountId: record.accountId, bound: true,
    unattended: pane.meta.unattended === true, opener: pane.meta.opener || null, moveTransactionId: record.id,
  };
  const file = path.join(deps.root || keep.ROOT, '.keep', 'panes', `${record.sessionId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temp, JSON.stringify(written));
  fs.renameSync(temp, file);
  return written;
}

function sessionMoveDeps(deps = {}) {
  const root = deps.root || keep.ROOT;
  const env = deps.env || process.env;
  const daemon = daemonNodeName(deps);
  const listPanes = () => (deps.listHostPanes || listHostPanes)(deps, true);
  // What a node the session left keeps for it: the daemon's mirror of that node's
  // transcript and the node's own hook queue and cursor. Nothing on the daemon node.
  const dropNodeState = async (record, node) => {
    const warnings = [];
    if (node === daemon) return warnings;
    const mirror = require('./transcript-mirror').paths(root, node, record.sessionId);
    for (const file of [mirror.file, mirror.sidecar]) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') warnings.push(`the daemon's mirror of ${node} was not removed: ${error.message}`); }
    }
    try { await nodeArtifacts(node, moveNodeAccount(node, accountOf(record), deps), deps).dropSession(record.sessionId); }
    catch (error) { warnings.push(`${node} did not drop its hook state: ${error.message}`); }
    return warnings;
  };
  // A side's artifacts for the session as that side lists them now, by digest.
  const digestsOn = async (record, node) => {
    const listed = await moveEndpoint(node, accountOf(record), deps).list(record.sessionId);
    if (!listed || !Array.isArray(listed.files)) throw new Error(`${node} listed no files`);
    return Object.fromEntries(listed.files.map((file) => [file.relPath, file.sha256]));
  };
  const accountOf = (record) => {
    const agent = record.agent || 'claude';
    const account = accounts.get(record.accountId, env);
    if (!account || account.agent !== agent) {
      throw new InjectionError(409, `account ${record.accountId} is not a ${agent === 'codex' ? 'Codex' : 'Claude'} account here`);
    }
    return account;
  };
  const agentOf = (record) => record.agent || 'claude';
  // Waits (bounded) for a fresh listing in which the source's pane is gone, exited, or
  // shown with no agent in it. Agent-agnostic: the agent has already been proven gone
  // from the source's process table; this is the pane list catching up with that.
  const sourcePaneGone = async (record) => {
    const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + (deps.moveStopPaneTimeoutMs || 15000);
    for (;;) {
      const panes = await listPanes();
      const pane = Array.isArray(panes) ? panes.find((entry) => entry && entry.id === record.pane.id) : undefined;
      if (Array.isArray(panes) && (!pane || pane.alive === false || pane.agentAlive === false
          || !pane.meta || pane.meta.sessionId !== record.sessionId)) return;
      if (Date.now() >= deadline) {
        throw new InjectionError(409, Array.isArray(panes)
          ? `the pane ${record.pane.id} on ${record.from} is still listed as running ${sessionRef(record.sessionId)} after its agent stopped`
          : 'the terminal hosts did not list their panes after the stop');
      }
      await sleep(250);
    }
  };
  return {
    root, env, daemonNode: daemon,
    nodeNames: () => placementNodes(deps).map((node) => node.name),
    inspect: (sessionId) => inspectSessionMove(sessionId, deps),
    requireNode: (node, agent) => requireNodeArtifacts(node, deps, agent === 'codex' ? CODEX_ARTIFACTS_VERSION : 1),
    cwdExists: async (node, cwd) => {
      if (node === daemon) { try { return fs.statSync(cwd).isDirectory(); } catch { return false; } }
      const answer = await nodeArtifacts(node, null, deps).cwd(cwd);
      return answer && answer.directory === true;
    },
    // Asked of the target before anything stops: it has the account (its own config
    // names it and its directory is there), and it could prepare the launch (shared
    // home, account installed, shared setup and MCP config derivable), writing nothing.
    targetReady: async (node, plan) => {
      const agent = agentOf(plan);
      const account = accountOf(plan);
      try { await moveEndpoint(node, account, deps).account(); }
      catch (error) {
        // A Codex move to a node that lacks the Codex account is refused as that.
        if (agent === 'codex' && !(error instanceof InjectionError && error.extra && error.extra.reason === 'remote-node')) {
          throw new InjectionError(409, `${node} does not have the Codex account ${plan.accountId}: ${error.message}`, { reason: 'account-missing' });
        }
        throw new InjectionError(409, `${node} cannot take ${plan.accountId}: ${error.message}`, { reason: 'target-account' });
      }
      const onNode = moveNodeAccount(node, account, deps);
      try {
        await (deps.prepareLaunchOn || prepareLaunchOn)(node, {
          agent, cwd: plan.cwd, check: true,
          account: { id: onNode.id, agent, configDir: onNode.configDir, builtIn: onNode.builtIn === true, managed: onNode.managed === true },
        }, deps);
      } catch (error) {
        throw new InjectionError(409, `${node} could not launch ${plan.accountId}: ${error.message}`, { reason: 'target-launch' });
      }
    },
    pendingDelivery: (sessionId) => require('./delivery').pendingForSessionAsync(path.join(root, '.keep', 'delivery'), sessionId,
      { receiptFor: (entry) => deliveryReceiptFor(entry, deps) }),
    busy: async (sessionId, plan = {}) => {
      if (plan.agent === 'codex') {
        const obstacle = codexMoveObstacle(sessionId, deps);
        if (obstacle) return obstacle;
      }
      const handoff = require('./account-handoff').transferInFlight(root, sessionId);
      if (handoff) return `an account handoff is ${handoff.status} (${handoff.phase})`;
      if (compactRestoreBlocking(sessionId, deps)) return 'a compaction has not restored its model yet';
      // A restart queued for idle (or one running, or one waiting for recovery) would
      // stop and resume the session on the node it knew, under the move.
      const restart = require('./session-restart').read(path.join(root, '.keep', 'session-restarts.json'))
        .find((entry) => entry.sessionId === sessionId && ['queued', 'restarting', 'recovery-needed'].includes(entry.status));
      if (restart) return `a restart is ${restart.status}${restart.mode ? ` (${restart.mode})` : ''}; cancel it or let it finish first`;
      return null;
    },
    stop: async (record) => {
      const panes = await listPanes();
      if (!Array.isArray(panes)) throw new InjectionError(409, 'the terminal hosts did not list their panes');
      const pane = record.pane && panes.find((entry) => entry.id === record.pane.id);
      if (pane && pane.alive && pane.pid === record.pane.pid && pane.meta && pane.meta.sessionId === record.sessionId) {
        await (deps.restartSession || restartSession)({ sessionId: record.sessionId, pane: pane.id, pid: pane.pid, mode: 'now' },
          { ...deps, ownerForce: record.ownerForce === true, afterStop: async (stopped) => ({ ok: true, stopped: stopped && stopped.id }) });
      }
      // Proven again from the source's own table whether or not it was just stopped.
      await requireNoAgentOn(record.from, record.sessionId, deps, agentOf(record));
      // And the source's pane seen gone from a listing taken now: the launch judges
      // the session's panes from a listing, and one taken before the stop (the pane
      // cache is a second long, and this stop's own list above fills it) would still
      // show the source live and refuse the target's start. A pane still listed live
      // with no agent in it proven gone refuses the stop, which the recovery retries.
      if (record.pane) await sourcePaneGone(record);
    },
    digestsOn,
    // The same proof, asked again before the flip and before every launch.
    requireStopped: (record) => requireNoAgentOn(record.from, record.sessionId, deps, agentOf(record)),
    // Whether the target runs the session now: a live pane for it there, or an agent
    // process in the target's own table. An unreadable table throws (unproven).
    //
    // A pane whose agent is proven gone (agentAlive false: the pane is back at its
    // shell) runs nothing. A pane still open with no agent proven in it either way is
    // `unproven`: the move neither waits on it nor launches beside it, and the refusal
    // names the pane to close by hand.
    targetState: async (record) => {
      const panes = await listPanes();
      if (!Array.isArray(panes)) throw new InjectionError(409, 'the terminal hosts did not list their panes');
      const open = panes.filter((entry) => entry && entry.alive !== false && entry.agentAlive !== false && entry.meta
        && entry.meta.sessionId === record.sessionId && sessionNodeOf(entry, deps) === record.to);
      const agent = await agentLiveOn(record.to, record.sessionId, deps, agentOf(record));
      const proven = open.find((entry) => entry.agentAlive === true) || null;
      const pane = proven || open[0] || null;
      const unproven = Boolean(pane) && !proven && !agent;
      return { running: Boolean(pane) || agent, pane: pane ? pane.id : null, agent, ...(unproven ? { unproven: true } : {}) };
    },
    // The abandon's flip back, the only other flip a move makes.
    pinBack: (record) => accounts.pinSession(record.sessionId, agentOf(record), record.accountId,
      { root, env, node: record.from, transferNode: true }),
    // The abandon's flip back leaves the target the same way a move leaves its source.
    dropTarget: (record) => dropNodeState(record, record.to),
    releaseTarget: (record) => moveEndpoint(record.to, accountOf(record), deps).release(record.sessionId),
    transfer: (record) => {
      const account = accountOf(record);
      return artifactTransport.transfer({ sessionId: record.sessionId, tx: record.id,
        from: moveEndpoint(record.from, account, deps), to: moveEndpoint(record.to, account, deps) });
    },
    location: (sessionId) => accounts.sessionLocation(sessionId, { root, env }),
    pin: (record) => accounts.pinSession(record.sessionId, agentOf(record), record.accountId,
      { root, env, node: record.to, transferNode: true }),
    open: async (record) => {
      // The target has no agent for this conversation before one is started there.
      // A Codex session resumes with `codex [flags] [-m model] resume <id>`, in the
      // permission class its source ran in (Keep's default when none was read).
      const flags = agentOf(record) === 'codex'
        ? (typeof record.flags === 'string' ? { codexFlags: record.flags } : {})
        : { claudeFlags: record.bypass ? '--dangerously-skip-permissions' : '' };
      // The launch reads the session's panes from a fresh listing, never the second-long
      // cache: one filled before the stop still shows the source's pane live.
      const listing = deps.listHostPaneResult || deps.listHostPanes ? {} : { listHostPaneResult: (given) => listHostPaneResult(given, true) };
      const launch = await (deps.openSession || openSession)({ sessionId: record.sessionId, node: record.to, accountId: record.accountId,
        ...(record.model ? { model: record.model } : {}) },
      { ...deps, ...listing, ...flags, reopenCompaction: 'skip', moveTransactionId: record.id });
      return launch;
    },
    waitForPaneRecord: async (record) => {
      const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
      const deadline = Date.now() + (deps.moveStartTimeoutMs || 45000);
      const codex = agentOf(record) === 'codex';
      let nextEvidence = 0;
      for (;;) {
        const found = readPaneRecord(record.sessionId, deps);
        if (found && found.pane === record.launch.pane && Number(found.startedAt) >= Number(record.launchStartedAt)
            && (found.node || daemon) === record.to) return found;
        // A resumed Codex reports its start only at its first turn: its own process
        // evidence on the target stands in for it, asked every two seconds.
        if (codex && Date.now() >= nextEvidence) {
          nextEvidence = Date.now() + 2000;
          let verified = null;
          try { verified = await (deps.verifyMovedCodexPane || verifyMovedCodexPane)(record, deps); } catch {}
          if (verified) return verified;
        }
        if (Date.now() >= deadline) return null;
        await sleep(250);
      }
    },
    // The card keeps its link where it stands: only the entry's node changes, never
    // its order, its time or who owns the card, and nothing is pushed.
    relink: (record) => {
      const scope = { root };
      const card = keep.loadAll(true, scope).find((task) => (task.fm.sessions || []).some((entry) => entry.id === record.sessionId));
      if (!card) return null;
      (deps.relinkSessionNode || keep.relinkSessionNode)(card.id, record.sessionId, record.to, scope);
      return card.id;
    },
    cleanup: async (record) => {
      const warnings = [];
      const account = accountOf(record);
      // The stopped pane on the source, which nothing will run again: removed only on
      // the same proof the move stopped it on (no agent for the session in the
      // source's own table) and only while the pane itself is still exited. A pane
      // somebody started again is left running, and said so.
      if (record.pane) {
        try {
          await requireNoAgentOn(record.from, record.sessionId, deps, agentOf(record));
          const panes = await listPanes();
          if (!Array.isArray(panes)) throw new Error('the terminal hosts did not list their panes');
          const pane = panes.find((entry) => entry && entry.id === record.pane.id);
          if (pane && pane.alive !== false) warnings.push(`the pane ${record.pane.id} on ${record.from} is running again; it was left as it is`);
          else if (pane) await (deps.hostRequest || hostRequest)('remove', { pane: record.pane.id }, deps);
        } catch (error) { warnings.push(`the stopped pane ${record.pane.id} was not removed: ${error.message}`); }
      }
      // What the session left on the source is a copy a later move back may replace,
      // but only while it is still exactly what was carried: a source that changed
      // since the copy holds bytes the target does not, and is not given up.
      try {
        const difference = record.manifest && record.manifest.digests
          ? require('./session-move').digestDifference(record.manifest.digests, await digestsOn(record, record.from)) : null;
        if (difference) warnings.push(`source changed since the copy (${record.from}: ${difference}); its copy was not released`);
        else await moveEndpoint(record.from, account, deps).release(record.sessionId);
      } catch (error) { warnings.push(`the copy left on ${record.from} was not released: ${error.message}`); }
      warnings.push(...await dropNodeState(record, record.from));
      // The transaction on the target: its emptied stage, its publish record and the
      // backups of what the publish replaced. The provenance record lives beside it,
      // not in it, and stays.
      try { await moveEndpoint(record.to, account, deps).abort(record.id); }
      catch (error) { warnings.push(`the move's transaction on ${record.to} was not cleared: ${error.message}`); }
      return warnings;
    },
    abortStage: async (record) => {
      const account = accountOf(record);
      await moveEndpoint(record.to, account, deps).abort(record.id);
    },
    ...(deps.moveDeps || {}),
  };
}

async function moveSession(body, deps = {}) {
  return require('./session-move').moveSession(body, sessionMoveDeps(deps));
}

// The rate limit this session carries now, which is the event a queue entry exists
// for. Three different answers, and the queue acts differently on each: a stamp is
// the event to watch, `null` is "watched, and there is no limit", and `undefined` is
// "could not look". Only the first two are worth queueing on — an entry built on a
// guess would either never cancel for a limit that cleared or cancel for one that was
// never there. Worth a state build only because nothing reaches here but a refusal.
//
// A session whose pane no longer holds a live agent is unobservable in the same sense:
// whatever the limit says, there is nothing left here to transfer, and the recovery
// controls are what that session needs.
async function handoffRateLimitAt(sessionId, deps = {}) {
  let state;
  try { state = await (deps.handoffQueueState || handoffQueueState)(deps); }
  catch { return undefined; }
  const session = (state?.sessions || []).find((entry) => entry.id === sessionId);
  if (!session) return undefined;
  const pane = (state?.panes || []).find((entry) => entry.id === session.pane);
  if (!pane || pane.alive === false || pane.agentAlive === false) return undefined;
  return session.rateLimit?.at ?? null;
}

// Whether the agent this transaction was going to stop is still running. A refusal
// that landed before `sourceStopVerifiedAt` was written does not prove it: the typed
// /exit can have succeeded and a later host call timed out, leaving the same
// pre-stop-looking record behind. Queueing that one would promise a retry that the
// recovery guard then parks, so it is left for the recovery controls instead.
//
// The `safe()` copy that rides back on the refusal drops sourceAgentPid, so the full
// record is read from disk. A record that names no agent identity says nothing either
// way and is left to the checks around it.
async function handoffSourceStillRunning(record, deps = {}) {
  if (!Number.isInteger(record?.sourceAgentPid) || record.sourceAgentPid <= 0
      || typeof record.sourceAgentPidStart !== 'string' || !record.sourceAgentPidStart) return true;
  const rows = await (deps.agentProcessRows || agentProcessRows)(deps);
  return (rows || []).some((row) => row.pid === record.sourceAgentPid && row.pidStart === record.sourceAgentPidStart);
}

// Whether a refused transfer is one the queue may simply ask for again: it refused
// transiently, it was a continuation rather than an open-only reopen, it stopped
// before the transaction passed its stop, and the source agent is still running. Past
// any of those the session is already half-moved and only the recovery path may
// touch it.
//
// The recovery-needed record stays exactly where it is. The queue's retry calls the
// same handoffSession, which picks that journaled transaction up — the same thing
// `keep handoff` does when a person runs it again.
async function queueRefusedHandoff(body, record, requestedAt, deps = {}) {
  const queue = deps.handoffQueue || require('./handoff-queue');
  const root = deps.root || keep.ROOT;
  if (!record || record.status !== 'recovery-needed' || record.refusalClass !== 'transient') return null;
  if (record.intent !== 'continue' || queue.transferPastStop(record)) return null;
  const sessionId = String(record.sessionId || body.sessionId || '');
  const pane = String(record.pane || body.pane || '');
  const reason = String(record.reason || 'the transfer was refused');
  const skip = (why) => {
    process.stderr.write(`keep serve: not queuing ${sessionId}: ${why}\n`);
    return null;
  };
  // The queue's only side effect is calling handoffSession again, and that transfer
  // cannot run from here for a session on another machine. Nothing is queued that
  // could only ever be refused.
  const node = sessionNodeOf({ sessionId, pane }, deps);
  if (node !== daemonNodeName(deps)) return skip(`the session runs on ${node}`);
  // Order matters, and it is the order of how long each answer stays true. The state
  // build is the slow one, so it goes first and everything after it is fresher than it
  // is; the `ps` snapshot is next, because a process described before that build would
  // be a memory by now. Cancel comes last of all, after every await: it arrives through
  // its own route at any moment, it is a person saying no to exactly this, and
  // enqueue() would start a cancelled entry over.
  const rateLimitAt = await handoffRateLimitAt(sessionId, deps);
  if (rateLimitAt === undefined) return skip('its live state could not be read, so the limit it carries is unknown');
  const journalled = (deps.handoffRecord || require('./account-handoff').readOne)(root, sessionId) || record;
  try {
    if (!await handoffSourceStillRunning(journalled, deps)) {
      return skip('source agent is no longer running; leaving the record for recovery');
    }
  } catch (error) {
    // No snapshot, no proof the source is alive. A `ps` this attempt could not take is
    // reason enough not to promise a retry.
    return skip(`could not check whether its source agent is still running: ${error.message}`);
  }
  const current = queue.readOne(root, sessionId);
  if (current && current.status === 'cancelled'
      && Number(current.cancelledAt || current.updatedAt || 0) >= Number(requestedAt || 0)) {
    return skip('its transfer was cancelled while this one ran');
  }
  let entry;
  try {
    ({ entry } = queue.enqueue(root, { sessionId, pane, sourceAccountId: record.sourceAccountId,
      targetAccountId: body.accountId, force: body.force === true, rateLimitAt,
      // Not the enqueue time: the person may have gone back to work while this refusal's
      // own preflight ran, and that work happened after the transfer was asked for.
      activityBoundary: Number.isFinite(requestedAt) ? requestedAt : null }));
  } catch (error) {
    // A queue that will not take this is no reason to lose the refusal itself.
    process.stderr.write(`keep serve: could not queue ${sessionId} after a transient refusal: ${error.message}\n`);
    return null;
  }
  process.stderr.write(`keep serve: handoff queue queued ${sessionId} after a transient refusal: ${reason}\n`);
  return { ok: true, status: 'queued', reason, sessionId, pane, targetAccountId: entry.targetAccountId };
}

// The console's transfer button. Every one of the twelve transfers a person asked for
// on 2026-09-17 ended at a recovery-needed record, each on a condition that clears by
// itself, while every one the queue drove through the same handoffSession landed — the
// only difference being that the queue tried again. So a console transfer refused that
// way joins the queue instead of stopping at a record nobody is watching.
//
// `queueOnTransient` is the console asking for that. `keep handoff` posts to the same
// route and does not ask: it reports the refusal to whoever typed it, unchanged.
async function handoffSessionRequest(body, deps = {}) {
  const { queueOnTransient, ...request } = body && typeof body === 'object' ? body : {};
  // Before the queue is offered one: a transfer that cannot run here must not be
  // retried here either, whatever the caller asked for.
  refuseRemoteHandoff(request, deps);
  const run = deps.handoffSession || handoffSession;
  // An Owner-forced transfer has nothing left to wait out, and a queued retry would run
  // without Owner behind it; its refusal goes straight back to the person who clicked.
  if (queueOnTransient !== true || request.ownerForce === true) return run(request, deps);
  // When this transfer was asked for, so a Cancel that arrives while it runs wins.
  const requestedAt = (deps.now ? deps.now() : Date.now());
  let result;
  try {
    result = await run(request, deps);
  } catch (error) {
    // account-handoff hands the record back on the error as `extra`; the route would
    // otherwise answer 409 with it.
    const queued = await queueRefusedHandoff(request, error && error.extra, requestedAt, deps);
    if (queued) return queued;
    throw error;
  }
  return await queueRefusedHandoff(request, result, requestedAt, deps) || result;
}

function abandonTransfer(body, deps = {}) {
  return require('./account-handoff').abandon(body, { ...deps, root: deps.root || keep.ROOT });
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
  // The dashboard's exited state comes from host panes and a periodic process
  // ledger, which can miss a resume started outside the host; an exited source is
  // only trusted once a fresh process scan (that itself succeeded) finds no agent
  // on this conversation. Every identity source counts (resume argv included, so
  // no codexRolloutOnly), and a lookup that failed part-way is inconclusive.
  let processGone = false;
  if (session?.exited === true) {
    try {
      const rows = await (deps.agentProcessRows || agentProcessRows)(deps);
      if (Array.isArray(rows) && rows.length) {
        // An agent row whose argv macOS could not read (`(claude)`) is a live
        // process with no identity, so it could be this conversation.
        let inconclusive = rows.some((row) => row.argsUnavailable === true && /^\((?:claude|codex|node)\)$/.test(row.args));
        const live = await (deps.liveSessionPids || liveSessionPids)({ ...deps, agentProcessRows: async () => rows,
          onEvidenceError: () => { inconclusive = true; } });
        processGone = !inconclusive && !live.has(sessionId);
      }
    } catch {}
  }
  return { session, nativeHandoff, portableHandoff, portableFallback, terminalRateLimit, processGone, panes: state.panes || [], state };
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
    catch (error) { process.stderr.write(`keep serve: could not link recovered portable session ${sessionRef(launch.sessionId)} to ${state.cardId}: ${error.message}\n`); }
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

// The opener a transfer's destination pane inherits from its source. Moving a session
// to another account does not give it a reader: a session Keep opened for a program is
// still unattended on the far side, and one Owner opened stays attended. A source pane
// nobody can read reads as attended — failing open here only costs a session the block.
async function inheritedOpener(sessionId, deps = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  let panes = null;
  try { panes = await (deps.listHostPanes || listHostPanes)(deps, true); } catch { return null; }
  const meta = hostPanesBySession(panes || []).get(sessionId)?.meta;
  if (!meta || meta.unattended !== true) return null;
  const opener = meta.opener && typeof meta.opener === 'object' && typeof meta.opener.kind === 'string' && meta.opener.kind
    ? meta.opener : { kind: 'transfer' };
  return { kind: opener.kind, ...(opener.id ? { id: String(opener.id) } : {}), unattended: true };
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
    open: deps.open || (async (payload) => {
      const opener = await (deps.inheritedOpener || inheritedOpener)(payload.portableSourceSessionId, deps);
      return openSession({ ...payload, portableTransferId: body.transferId }, {
        ...deps,
        ...(opener ? { opener } : {}),
        detectPortableSetup: true,
        onLaunched: hooks.onLaunched,
        onOpeningReady: hooks.onReady,
        onOpeningDelivered: hooks.onDelivered,
      });
    }),
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
  const prior = await require('./delivery').statusForTextAsync(deps.deliveryDirectory || path.join(keep.ROOT, '.keep', 'delivery'), text, runs.checkDeliveryKey(task),
    { receiptFor: (entry) => deliveryReceiptFor(entry, deps) });
  if (prior?.received) return { sessionId: prior.sessionId, kind: prior.kind, delivery: 'received' };
  // Picking stays on the scan: a card can link many old sessions, and an exact read
  // of each one no index names (no authority record, a Codex id, one that ended days
  // ago) walks every Claude project directory, which costs more than one scan. The
  // chosen candidate is then read exactly (loadCurrentSession) before it is typed into.
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
    // A thread on another node is a candidate like any other: it is read from its
    // node and its receipt is that node's (sendToResolvedTarget). One that cannot be
    // read or confirmed there is passed over as a closed one is.
    let session;
    let target;
    try {
      session = await (deps.loadCurrentSession || ((id) => loadSessionForAction(id, deps)))(candidate.id);
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
  const retirement = require('./session-retirement');
  const root = deps.root || keep.ROOT;
  const result = await lock(async () => {
    let session = null;
    try { session = (deps.loadCurrentSession || loadCurrentSession)(sessionId); } catch {}
    const entry = retirement.begin(root, {
      sessionId,
      pane: pane.id,
      reason: 'completed-check',
      idleMinutes: 0,
      activityAt: require('./session-cleanup').meaningfulActivityAt(session, pane) || Date.now(),
      notify: session?.notify,
      processIdentity: Number.isInteger(pane.agentPid) ? {
        pane: pane.id, panePid: pane.pid, agentPid: pane.agentPid,
      } : null,
    });
    let exitInputStarted = false;
    try {
      const capabilities = await host('hello');
      const closed = await (deps.manualClose || require('./manual-close').manualClose)(
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
          closePolicy: {
            automatic: true,
            retirement: true,
            ephemeral: true,
            expectedReason: 'completed-check',
            doneIdleMs: 0,
            attentionIdleMs: 0,
            unattendedIdleMs: 0,
            idleMs: 0,
          },
          beforeExitInput: () => { exitInputStarted = true; },
          withInjectionLock: (fn) => fn(),
        }),
        signal: (id, signal, guard) => {
          retirement.assertRetirable(root, sessionId);
          return host('guarded-kill', { pane: id, signal, ...guard });
        },
      });
      retirement.finish(root, sessionId, Date.now(), entry.transactionId);
      return closed;
    } catch (error) {
      if (!exitInputStarted) retirement.cancel(root, sessionId, entry.transactionId);
      else try {
        const panes = await (deps.listHostPanes || listHostPanes)(deps, true);
        const current = panes?.find((candidate) => candidate.id === pane.id);
        if (Array.isArray(panes) && (!current || !current.alive || current.agentAlive === false
            || current.meta?.sessionId !== sessionId)) {
          retirement.finish(root, sessionId, Date.now(), entry.transactionId);
        }
      } catch {} // Unknown process state retains the closing snapshot.
      throw error;
    }
  }, { pane: pane.id, session: sessionId });
  (deps.onChange || (() => {}))();
  return result;
}

// The scheduler's opener, used by every caller that opens a session on a card the
// scheduler would otherwise have opened one for.
function openCheckSession(body, openDeps) {
  // Pinned to this node, the way self-repair and the area sessions pin theirs: a
  // check runs the card's recipe, is delivered and reaped from here, and must not
  // land on another machine merely because the card's last session did.
  const open = (openDeps && openDeps.openSession) || openSession;
  return open({ ...body, node: nodes.daemonNode((openDeps || {}).env || process.env) },
    { ...openDeps, launchMeta: { ephemeral: 'check' } });
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
    // Here as in openCheckSession: a run Keep starts belongs to the daemon node,
    // whatever the card's last session did.
    node: nodes.daemonNode(deps.env || process.env),
  }, {});
  return { ok: true, sessionId: (opened && opened.sessionId) || null, pane: (opened && opened.pane) || null };
}

async function deliverUnblockToThread(task, text) {
  // On the scan for the same reason as deliverCheckToThread's pick.
  const { candidates, busy } = pickDeliveryCandidates(
    (task.fm.sessions || []).map((session) => session && session.id),
    scanSessions(),
    excludedSessionIds(),
  );
  for (const candidate of candidates) {
    // As with a check: a thread elsewhere is read from its node and confirmed there.
    let session;
    let target;
    try {
      session = await loadSessionForAction(candidate.id);
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

// The ordinary session scan expires stale attention and spawned markers and allocates
// console numbers, so it is not something `--dry` may run: a dry run promises to leave
// the registry exactly as it found it. Prefer the snapshot the daemon keeps warm — the
// same one resolveSessionId reads — and fall back to an explicitly read-only scan,
// which labels whatever is already numbered and writes nothing.
function tellSessions(dry, deps = {}) {
  const scan = deps.scanSessions || scanSessions;
  if (!dry) return scan({});
  if (!deps.scanSessions && Date.now() - sessionSnapshotAt < 5000 && sessionSnapshot.length) {
    return copySessions(sessionSnapshot);
  }
  return scan({ readOnly: true, allocateNumbers: false });
}

// A tell names its sessions: one id, a console number, or a card's linked ids. The
// fleet scan answers for every session on the machine — it re-lists every project
// directory, stats every transcript (tens of thousands) and parses every recent
// tail — and on the daemon that held the event loop for over a second per tell, of
// which the tell used one row. This builds the same row for one id from the
// per-session readers the delivery prechecks already use (claudeSessionFor,
// codex.sessionFor, pi.sessionFor: a stat and, when the transcript moved, a re-read
// of its tail), plus the parts of the scan a tell's guards and receipt read: the
// attention marker (a pending permission prompt), hand-typed names and marks, and
// the console number, read-only. It writes nothing: no stale marker is deleted and
// no number allocated, both of which the next fleet scan still does.
//
// A session the scan would not list is not a target here either, and each skip is
// the scan's own predicate, not a copy of it:
//   - Claude: claudeTranscriptIsInteractive (via claudeSessionFor's interactiveOnly),
//     so a headless `claude -p` transcript is absent; the account authority pins
//     the file as it does for the scan.
//   - Codex: codex.isChildSession / codex.isHeadlessSession on the rollout's
//     session_meta, the pair scanRollout filters on (codex.sessionFor itself already
//     drops children but keeps exec runs), and the scan's Companion-task title skip.
//     A staged handoff or an ambiguous unpinned id has no row from sessionFor either.
//   - The 48 h window on the row's activity time, for Claude and Codex; the scan
//     applies none to Pi, so neither does this.
// The one skip deliberately not repeated is keep-spawned: the scan drops those rows,
// and a tell reading one here refuses it by name (keep-spawned) instead of calling
// the id unknown, which is the answer the sender can act on.
//
// So an unknown id still reads as "bad session id" and a card's stale link as not
// live. One on another node has no transcript here; it comes back as a bare row
// carrying its node, so a tell to it by id is refused by name
// (remoteDeliveryRefusal). A card leaves such a row out (see tellSession).
//
// `pin`, when given, remembers what the first read found: the agent, and for Codex
// the rollout file. A tell reads its target up to five times (the decision, three
// re-checks inside the lock, and sendToSession's own load), and every read after the
// first goes straight to that agent's reader instead of trying the others again.
//
// `options.allowCachedMiss` lets the Claude read answer from a miss recorded in the
// last 45 s instead of walking every project directory again. A session the tell
// names — a full id, a card's linked id — is always read exactly: `keep open X
// --fresh` makes a pane, a state build looks X up before its transcript exists and
// records a miss, and a `keep tell X --wait` a few seconds later must see the
// transcript that has appeared since, not "bad session id". Only the speculative
// reads pass it (resolveTellTarget: a prefix tried as an exact id before the listing,
// a numeral tried as a literal id), and even then a miss is ignored while a live
// host pane names the id.
//
// The same reader serves loadCurrentSession (loadSessionExact below), which asks for
// `excludeSpawned`: an action path keeps the scan's answer for a keep-spawned run.
function loadTellSession(id, deps = {}, pin = null, options = {}) {
  return loadSessionExact(id, { deps, pin, allowCachedMiss: options.allowCachedMiss === true });
}

// A keep-spawned run as scanClaudeSessions judges one: a marker under .keep/spawned
// younger than seven days (the scan deletes an older one and lists the session).
function spawnedRecently(root, sessionId, now) {
  try { return now - fs.statSync(path.join(root, '.keep', 'spawned', sessionId)).mtimeMs <= 7 * 86400e3; }
  catch { return false; }
}

// loadSessionExact(id, { deps, pin, allowCachedMiss, excludeSpawned }) returns a
// row, a bare { id, node, mtime: 0 } row for a session on another node, or null.
// One transcript read (a stat, and the tail when it changed): no fleet scan, and no
// project-directory walk when an authority record names the agent. `deps` carries
// root / env / hostNodes as the tell passes them; `pin` and `allowCachedMiss` are
// the tell's (see above); `excludeSpawned` drops a keep-spawned Claude run as
// scanClaudeSessions does.
function loadSessionExact(id, options = {}) {
  const deps = options.deps || {};
  const pin = options.pin || null;
  const sessionId = String(id || '');
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  const root = deps.root || keep.ROOT;
  const node = sessionNodeOf({ id: sessionId }, deps);
  if (node !== daemonNodeName(deps)) return { id: sessionId, node, mtime: 0 };
  // Which reader to try first. A Claude miss walks every project directory (well
  // over a thousand), so it goes last whenever something cheaper names the agent:
  // the account record, or a rollout the last Codex scan indexed (a map lookup).
  let order;
  if (pin?.kind) order = [pin.kind];
  else {
    let agent = null;
    try { agent = JSON.parse(fs.readFileSync(accounts.authorityFile(root, sessionId), 'utf8')).agent || null; } catch {}
    if (['claude', 'codex', 'pi'].includes(agent)) order = [agent];
    else if (codex.rolloutFileFor(sessionId)) order = ['codex', 'claude', 'pi'];
    else order = ['claude', 'codex', 'pi'];
  }
  let session = null;
  for (const kind of order) {
    try {
      if (kind === 'claude') {
        session = claudeSessionFor(sessionId, { root, interactiveOnly: true,
          allowCachedMiss: options.allowCachedMiss === true && !hostPaneAliveFor(sessionId) });
        if (session && options.excludeSpawned === true && spawnedRecently(root, sessionId, Date.now())) return null;
      }
      else if (kind === 'codex') session = codexFleetSession(sessionId, pin);
      else session = pi.sessionFor(sessionId, { root });
    } catch { session = null; }
    if (session) {
      if (pin) pin.kind = kind;
      break;
    }
  }
  if (!session) return null;
  const now = Date.now();
  if (session.kind !== 'pi' && !(now - Number(session.mtime) <= SESSION_WINDOW_MS)) return null;
  const attentionDir = path.join(root, '.keep', 'attention');
  if (session.kind === 'claude') attachClaudeMarker(session, attentionDir, now, Number(session.mtime), true);
  else if (session.kind === 'codex') attachCodexMarkers([session], attentionDir, now, { readOnly: true });
  sessionNames.apply([session], { root });
  sessionMarks.apply([session], { root });
  sessionNumbers.assign([session], { root, readOnly: true });
  return session;
}

// Whether the last host pane list this daemon saw had a live pane for the session
// (noteHostPaneSessions records one signature per session, ending in its alive
// flag). A synchronous read of what is already known, for the loader's guard.
function hostPaneAliveFor(sessionId) {
  const signature = hostPaneSessionSignatures.get(String(sessionId || ''));
  return typeof signature === 'string' && signature.endsWith('\0true');
}

// codex.sessionFor keeps exec (headless) rollouts, because an explicitly hosted one
// is a conversation there. The fleet scan does not list them, nor children, nor a
// Companion task, and a tell targets only what the fleet lists. The title prefix is
// the one codex.js scan() tests inline; it has no exported predicate to share.
//
// The meta is the rollout's first line and never changes, so it is read once per
// tell: from the file the last scan indexed, else the one found by name (a walk of
// the dated folders, which codex.sessionMetaFor would repeat on every call), and
// the file is kept on the pin for the re-reads.
//
// codex.resolveRollout, where this codex.js has it, is sessionFor's own resolution
// made public: it searches the dated folders at most once and caches the file, so the
// meta is read from the very file sessionFor then reads, and sessionFor searches for
// nothing. Without it, the older pair (the scan's index, else a search by name).
function codexFleetSession(sessionId, pin = null) {
  const resolve = typeof codex.resolveRollout === 'function' ? codex.resolveRollout : null;
  const fleetMeta = (file) => {
    let meta = null;
    try { meta = file ? codex.readSessionMeta(file) : null; } catch {}
    return Boolean(meta) && !codex.isChildSession(meta) && !codex.isHeadlessSession(meta);
  };
  if (resolve && !pin?.codexChecked) {
    let resolved = null;
    try { resolved = resolve(sessionId); } catch {}
    if (!resolved || !fleetMeta(resolved.file)) return null;
    if (pin) { pin.codexFile = resolved.file; pin.codexChecked = true; }
  }
  const session = codex.sessionFor(sessionId);
  if (!session) return null;
  if (!pin?.codexChecked && !resolve) {
    const file = pin?.codexFile || codex.rolloutFileFor(sessionId) || codex.findRolloutFile(sessionId);
    if (!fleetMeta(file)) return null;
    if (pin) { pin.codexFile = file; pin.codexChecked = true; }
  }
  const companion = typeof codex.isCompanionTask === 'function'
    ? codex.isCompanionTask(session.title) : String(session.title || '').startsWith('Codex Companion Task:');
  if (companion) return null;
  return session;
}

// Where a tell's rows come from. `row(id)` is one session's row (null when there is
// none), `peek(id)` a row already in hand without reading anything, `list()` every
// session (only a prefix needs it), and `fresh(id)` a new read for the re-check
// inside the injection lock.
//
// A dry run keeps the snapshot path tellSessions gives it: it promises to write
// nothing, and a snapshot under 5 s old costs nothing. A caller that injects
// `scanSessions` (the tests) gets its rows from that scan, as before. Every other
// real tell reads the sessions it names and nothing else.
function tellRowSource(dry, deps = {}) {
  if (dry || deps.scanSessions) {
    let rows = null;
    const all = () => (rows ||= tellSessions(dry, deps));
    const find = (id) => all().find((session) => session && session.id === id) || null;
    return {
      scanned: true,
      row: find,
      peek: find,
      list: all,
      fresh: (id) => tellSessions(false, deps).find((session) => session && session.id === id) || null,
    };
  }
  const load = deps.loadTellSession || loadTellSession;
  const loaded = new Map();
  const pins = new Map();
  const pinFor = (id) => {
    if (!pins.has(id)) pins.set(id, {});
    return pins.get(id);
  };
  // A speculative read (`{ speculative: true }`) may answer from a cached Claude
  // miss; it is kept apart from the exact reads so a cached null can never stand in
  // for an exact read of the same id later in the tell.
  const guessed = new Map();
  return {
    scanned: false,
    row: (id, { speculative = false } = {}) => {
      if (loaded.has(id)) return loaded.get(id);
      if (speculative) {
        if (!guessed.has(id)) guessed.set(id, load(id, deps, pinFor(id), { allowCachedMiss: true }) || null);
        const row = guessed.get(id);
        if (row) loaded.set(id, row);
        return row;
      }
      loaded.set(id, load(id, deps, pinFor(id)) || null);
      return loaded.get(id);
    },
    peek: (id) => loaded.get(id) || null,
    // A prefix is the one address that names no session until it is matched against
    // the ids that exist, so it is the one case that lists. Bounded is enough to
    // find the id: the row the tell then acts on is read fresh with row(), and the
    // injection lock reads it again before the first character.
    list: () => (deps.listTellSessions || (() => (Date.now() - sessionSnapshotAt < 5000 && sessionSnapshot.length
      ? copySessions(sessionSnapshot)
      : scanSessions({ readOnly: true, allocateNumbers: false, fresh: false }))))(),
    fresh: (id) => load(id, deps, pinFor(id)) || null,
  };
}

// resolveSessionId's addressing — an exact id, a console number (`#12`, `12`,
// `s12`), or a prefix of eight characters or more — answered from the named rows
// instead of the fleet. A number goes through the numbers registry read-only, as
// `keep pane` resolves one (bin/commands/host.js resolveHostPane). resolveSessionId
// lets a session literally named `12` win over #12; here a number is looked up
// first and read as a literal id only when no session holds it, because trying a
// numeral as an id first would cost every numbered tell a walk of every project
// directory for an id no transcript has. Such a session is still reachable by its
// full id whenever #12 belongs to another session; real ids are UUIDs, so this is
// a corner nobody has yet.
//
// Which exact reads are speculative (see loadTellSession): a numeral read as a
// literal id, and a value that is not a full id, tried exactly before it is matched
// as a prefix. A full id is a UUID, or any id with an account record; those name a
// session and are read without a cached miss.
function resolveTellTarget(value, source, deps = {}) {
  if (deps.resolveSessionId || source.scanned) {
    return (deps.resolveSessionId || resolveSessionId)(value, { ...deps, scanSessions: () => source.list() });
  }
  const wanted = String(value || '');
  const number = sessionNumbers.parseNumber(wanted);
  const idShaped = /^[A-Za-z0-9_-]+$/.test(wanted);
  if (!number && !idShaped) throw new InjectionError(400, 'bad session id');
  if (number) {
    const found = sessionNumbers.lookup(number, { root: deps.root || keep.ROOT });
    const row = found ? source.row(found.id) : null;
    if (row) return row;
    if (!idShaped) throw new InjectionError(400, 'bad session id');
  }
  let fullId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wanted);
  if (!fullId && !number) {
    try { fullId = fs.existsSync(accounts.authorityFile(deps.root || keep.ROOT, wanted)); } catch {}
  }
  const exact = source.row(wanted, { speculative: !fullId });
  if (exact) return exact;
  if (number || wanted.length < 8) throw new InjectionError(400, 'bad session id');
  const matches = source.list().filter((candidate) => candidate && String(candidate.id || '').startsWith(wanted));
  if (matches.length > 1) {
    throw new InjectionError(400, `session prefix ${wanted} is ambiguous (${matches.map((candidate) => candidate.id.slice(0, 12)).join(', ')})`);
  }
  const row = matches.length ? source.row(matches[0].id) : null;
  if (!row) throw new InjectionError(400, 'bad session id');
  return row;
}

// `keep tell`: one session addressing another. Everything that decides whether the
// message may be typed at all — the frame, the target-state guards, the hourly brake —
// is data in bin/tell.js; this is the part that needs the daemon's live view.
//
// Three properties it must keep. The frame is built here, so a caller cannot dress its
// message up as Owner or as Keep itself. Every guard is re-checked inside the injection
// lock immediately before the first character, through watcherSend's precondition, so a
// session that took a turn or raised a question between the decision and the keystrokes
// stops it. And the ledger slot is reserved before the send and given back if the send
// fails, so a refused tell never spends the sender's hour.
async function tellSession(body, deps = {}) {
  body = body && typeof body === 'object' ? body : {};
  const root = deps.root || keep.ROOT;
  const dry = body.dry === true;
  const text = normalizedText(body.text || '');
  if (!text) throw new InjectionError(400, 'message is empty');
  // Validated, not sanitised, and before anything else looks at it: this text becomes
  // keystrokes, and a message that had to be rewritten is not the one the sender wrote.
  if (tell.unsafeText(text)) throw new InjectionError(400, tell.UNSAFE_TEXT_ERROR);
  if (body.senderSessionId != null && !/^[A-Za-z0-9_-]+$/.test(String(body.senderSessionId))) {
    throw new InjectionError(400, 'bad sender session id');
  }
  // The card rides inside the frame, so it may only ever be a card id.
  if (body.senderCard != null && !tell.CARD_ID_RE.test(String(body.senderCard))) {
    throw new InjectionError(400, 'bad sender card id');
  }
  const source = tellRowSource(dry, deps);
  const excluded = deps.excluded || excludedSessionIds();
  const senderId = body.senderSessionId ? String(body.senderSessionId) : '';

  let target;
  if (body.taskId) {
    let task;
    try { task = (deps.loadTask || keep.loadTask)(body.taskId); } catch {}
    if (!task) throw new InjectionError(400, 'no task');
    // The card's own linked sessions, minus the reviewer, keep-spawned runs and the
    // sender. pickDeliveryCandidates ranks the deliverable ones for us; the refusal,
    // when there are none, has to name the actual state rather than the count, because
    // `--wait` may sit through `busy` and must never sit through a question Owner is
    // holding. Ranked by tell.js's order, and the most recently active wins a tie.
    const skip = new Set([...excluded, ...(senderId ? [senderId] : [])]);
    const linked = new Set((task.fm.sessions || []).map((entry) => entry && entry.id).filter(Boolean));
    // Only the card's own sessions are read. The reviewer and keep-spawned runs are
    // skipped below whatever their state, so their rows are not needed; the sender's
    // is, even when it is excluded, because the self check asks whether it is live.
    // A session on another node is read from its node (the bare row loadTellSession
    // returns for one says nothing about its state), and is then a candidate like any
    // other. One its node could not answer for is no candidate, and its refusal does
    // not stand in for a local one: a card with a busy local thread still answers busy
    // (which --wait sits out). It is named only when nothing local is there at all. One
    // its node has no live transcript for is simply absent, as a stale local one is.
    const rows = (await Promise.all([...linked]
      .filter((id) => !excluded.has(id) || id === senderId)
      .map((id) => source.row(id))
      .filter(Boolean)
      .map((row) => (source.scanned ? row : readRemoteTellRow(row, deps)))))
      .filter(Boolean);
    const sessions = rows.filter((session) => !session.remoteUnreadable);
    const remoteUnreadable = rows.find((session) => session.remoteUnreadable && !skip.has(session.id));
    const { candidates } = pickDeliveryCandidates([...linked], sessions, skip);
    // Its predicate does not know about a usage limit or a turn that died, and ours
    // does: a rate-limited newest session must not hide a ready sibling behind it.
    target = candidates.find((session) => !tell.tellRefusal(session));
    if (!target) {
      // Terminal siblings (exited/deadMidTurn) are filtered out so a dead one cannot
      // mask the self check; live busy/rate-limited/waiting siblings still appear and
      // their refusals take precedence below.
      const present = sessions.filter((session) => session && linked.has(session.id) && !skip.has(session.id)
        && !session.exited && !session.deadMidTurn)
        .sort((a, b) => b.mtime - a.mtime);
      if (!present.length) {
        // The skip set excludes the sender, so check whether the sender is the only
        // live session linked to this card before calling the refusal self.
        if (senderId && sessions.some((session) => session && session.id === senderId && linked.has(session.id)
          && !session.exited && !session.deadMidTurn)) {
          throw new InjectionError(409, 'self: a session cannot tell its own card', { reason: 'self' });
        }
        if (remoteUnreadable) throw remoteUnreadable.remoteUnreadable;
        throw new InjectionError(409, `no live session on ${body.taskId}; start one with keep open ${body.taskId} --fresh -m "..."`, { reason: 'not-live' });
      }
      const refusals = present.map((session) => tell.tellRefusal(session) || { reason: 'busy', detail: 'session is mid-turn' });
      const worst = refusals.reduce((a, b) => (tell.cardRefusalRank(b) < tell.cardRefusalRank(a) ? b : a));
      throw new InjectionError(409, `${worst.reason}: ${worst.detail} (on ${body.taskId})`, { reason: worst.reason });
    }
  } else {
    target = resolveTellTarget(body.sessionId, source, deps);
    // A bare row for a session on another node becomes that node's read of it. Any
    // refusal (its host predates the transcript verb, it is not a Claude session, the
    // node did not answer) lands here, before the ledger is read, let alone reserved:
    // a message this daemon cannot confirm must not spend the sender's hour either.
    if (!source.scanned && bareRemoteRow(target, deps)) target = await loadRemoteSession(target.id, deps);
  }

  if (senderId && target.id === senderId) {
    throw new InjectionError(409, 'self: a session cannot tell itself', { reason: 'self' });
  }
  // What a node still cannot confirm (anything but a Claude session there) is refused
  // by name here, before the ledger is read.
  const elsewhere = remoteDeliveryRefusal(target, deps);
  if (elsewhere) throw elsewhere;
  // The same read, again, for the re-checks inside the lock and for the send itself:
  // off the node for a session elsewhere, off the tell's own source for any other.
  const remoteTarget = !source.scanned && remoteSession(target, deps);
  const freshTarget = remoteTarget
    ? async (id) => { try { return await loadRemoteSession(id, deps); } catch { return null; } }
    : async (id) => source.fresh(id);
  const marked = (dir) => {
    try { return fs.existsSync(path.join(root, '.keep', dir, target.id)); } catch { return false; }
  };
  // The reviewer's only input is its own tick, and a keep-spawned run is headless.
  if (target.reviewer || marked('reviewer')) {
    throw new InjectionError(409, 'reviewer: the reviewer session takes its work from its own tick', { reason: 'reviewer' });
  }
  if (marked('spawned')) {
    throw new InjectionError(409, 'keep-spawned: that session is a headless run, not a thread', { reason: 'keep-spawned' });
  }
  const refusal = tell.tellRefusal(target);
  if (refusal) throw new InjectionError(409, `${refusal.reason}: ${refusal.detail}`, { reason: refusal.reason });

  const sender = {
    sessionId: senderId || null,
    agent: body.senderAgent === 'codex' ? 'codex' : 'claude',
    card: body.senderCard || null,
    // Named from a row already in hand, else the numbers registry: the sender is not
    // read just to be named.
    name: tell.sessionName((senderId && source.peek(senderId))
      || (senderId ? { id: senderId, ...(sessionNumbers.lookup(senderId, { root }) || {}) } : null)),
  };
  const envelope = tell.tellEnvelope(sender, text);
  if (envelope.length > tell.SEND_LIMIT) throw new InjectionError(400, tell.TELL_TEXT_ERROR);

  const targetCard = body.taskId
    || (((deps.taskForSession || keep.taskForSession)(target.id) || {}).id || null);
  const receipt = {
    ok: true, sessionId: target.id, name: tell.sessionName(target), kind: target.kind,
    card: targetCard, text: envelope,
  };
  const now = Date.now();
  const slot = { sender: senderId || null, target: target.id, now };
  if (dry) {
    // Read-only all the way down: the ledger is consulted, never written.
    const decision = tell.tellDecision(tell.loadLedger(root), slot);
    if (!decision.ok) throw new InjectionError(409, `rate-limited: ${decision.why}`, { reason: 'rate-limited' });
    return { ...receipt, dry: true };
  }

  const gate = (deps.withLock || keep.withLock)(() => {
    const store = tell.loadLedger(root);
    const decision = tell.tellDecision(store, slot);
    if (decision.ok) tell.saveLedger(root, tell.recordTell(store, slot));
    return decision;
  });
  if (!gate.ok) throw new InjectionError(409, `rate-limited: ${gate.why}`, { reason: 'rate-limited' });

  // watcherSend runs this three times — entering the lock, immediately before the first
  // character, and again after the text is confirmed on screen and before Enter. Its
  // own verdict is kept here rather than parsed back out of the message, so the reason
  // reaches the CLI structurally and `--wait` keeps its one retryable state.
  let movedOnVerdict = null;
  try {
    // sendToSession loads the session it sends to (deps.loadCurrentSession), and its
    // default is a fresh fleet scan. The tell hands it the target's own read instead,
    // so from decision to Enter nothing scans the fleet. It is at least as fresh as a
    // scan row: the same transcript read, taken at that moment.
    const loadForSend = async (id) => {
      const row = await freshTarget(id);
      if (!row) throw new InjectionError(404, 'no session');
      return row;
    };
    await (deps.watcherSend || watcherSend)({
      sessionId: target.id,
      text: envelope,
      precondition: async () => {
        // The target alone, read again: this runs three times inside the lock.
        const fresh = await freshTarget(target.id);
        const moved = tell.tellRefusal(fresh);
        movedOnVerdict = moved;
        return moved ? `${moved.reason}: ${moved.detail}` : null;
      },
    }, { ...deps, sendDeps: { ...(deps.sendDeps || {}), loadCurrentSession: loadForSend } });
  } catch (error) {
    // An error after the first character may have arrived: the text can be sitting in
    // the box, or submitted with the receipt lost. Keeping the reservation is the
    // conservative read — a retry that double-delivers is worse than a slot spent on a
    // message that may already be there — and the caller is told it cannot know.
    const typed = Boolean(error && error.typingStarted);
    if (!typed) {
      try {
        (deps.withLock || keep.withLock)(() => tell.saveLedger(root, tell.releaseTell(tell.loadLedger(root), slot)));
      } catch {}
    } else {
      tell.logTell(root, {
        ts: keep.nowStamp(),
        sender: sender.sessionId, senderCard: sender.card,
        target: target.id, targetCard,
        text: text.slice(0, 200),
        delivery: 'unconfirmed',
      });
      throw new InjectionError(409,
        `unconfirmed: the message reached ${tell.sessionName(target)}'s input box but could not be confirmed; check the session before sending again (${String(error && error.message || error)})`,
        { reason: 'unconfirmed' });
    }
    // A session the scan still lists but whose pane has gone is a refusal like any
    // other, not a transport failure: say so in the same shape the guards use.
    if (error instanceof InjectionError && error.status === 404 && error.extra && error.extra.notLive) {
      throw new InjectionError(409, 'not-live: that session has no live host pane', { reason: 'not-live' });
    }
    if (movedOnVerdict) {
      throw new InjectionError(409, `${movedOnVerdict.reason}: ${movedOnVerdict.detail}`, { reason: movedOnVerdict.reason });
    }
    throw error;
  }
  tell.logTell(root, {
    ts: keep.nowStamp(),
    sender: sender.sessionId, senderCard: sender.card,
    target: target.id, targetCard,
    text: text.slice(0, 200),
  });
  return receipt;
}

// The bare { id, node, mtime: 0 } row loadSessionExact returns for a session on another
// node: no agent, no state, nothing a tell can decide on.
function bareRemoteRow(row, deps = {}) {
  return Boolean(row && row.node && row.node !== daemonNodeName(deps) && row.kind === undefined);
}

// A card's linked row, with a bare remote one replaced by its node's read. A node that
// has no live transcript for it (404) makes it absent, like a stale local session; any
// other failure keeps the row, marked with the refusal to give if nothing else is left.
async function readRemoteTellRow(row, deps = {}) {
  if (!bareRemoteRow(row, deps)) return row;
  try { return await loadRemoteSession(row.id, deps); }
  catch (error) {
    if (error instanceof InjectionError && error.status === 404) return null;
    const refusal = error instanceof InjectionError && error.status === 409 ? error
      : new InjectionError(409, `the session on ${row.node} could not be read from its node: ${String(error && error.message || error)}`, { reason: 'remote-node' });
    return { ...row, remoteUnreadable: refusal };
  }
}

// Delivery is a message with a receipt: the text is typed into a pane, confirmed
// against the session's transcript, and journalled here so one that was left
// unconfirmed can be finished rather than sent twice. For a Claude session on another
// node the receipt is that node's (the `transcript` verb, bin/node-transcript.js),
// so it takes a delivery like a local one. What still cannot is anything else there:
// a Codex session's state needs its rollout's first line as well as its tail, which
// the verb does not send yet, and a Pi session takes no API delivery anywhere. For
// those, and for a session whose agent is not known, every delivery path says so by
// name, and no journal is ever written. Null for a session on this machine, and for a
// Claude one elsewhere. `kind` names the agent when the caller has it.
function remoteDeliveryRefusal(sessionOrPane, deps = {}, kind = undefined) {
  const node = sessionNodeOf(sessionOrPane, deps);
  if (node === daemonNodeName(deps)) return null;
  const agent = kind !== undefined ? kind
    : sessionOrPane && typeof sessionOrPane === 'object' ? sessionOrPane.kind : undefined;
  if (agent === 'claude') return null;
  return new InjectionError(409,
    `delivery is not available for ${agent ? `a ${agent} session` : 'a session whose agent is not known'} on ${node} yet; only a Claude session's receipt can be read on a node`,
    { reason: 'remote-node' });
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
    // A sibling on another machine gets the note like a local one (sendToSession reads
    // it from its node); if it cannot, it is reported as unreached with the reason.
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
  // Bounded for finding the reviewer and deciding whether a tick is due; review.js
  // asks for { fresh: true } on the look it takes immediately before typing.
  sessions: (options = {}) => scanSessions({ fresh: false, ...options }),
  // The reviewer pane's meta names the account the automation policy launched it on;
  // the budget governor reads the reviewer's windows from that account.
  hostPanes: () => listHostPanes({}, false),
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

// A brief that found no configured channel is not a failed delivery: nothing was
// attempted, so retrying every 30 minutes until the noon cutoff only re-sends the
// same undelivered brief and holds the health row red for a channel the operator
// has not set up. sendAlert claims the day for it; this records the tick as done.
function briefTickOutcome(result) {
  if (result.duplicate) return { log: 'morning brief already claimed', health: { ok: true, skipped: true, detail: 'already delivered' } };
  if (result.deliveryOk) return { log: `morning brief sent via ${result.channels.join(', ')}`, health: { ok: true, skipped: false, detail: 'delivered' } };
  if (result.noChannel) return { log: 'morning brief recorded; no delivery channel configured', health: { ok: true, skipped: false, detail: 'no delivery channel configured' } };
  return { log: 'morning brief delivery failed; retrying in 30 minutes', health: { ok: false, error: 'delivery failed; retrying in 30 minutes' } };
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
      const outcome = briefTickOutcome(result);
      process.stderr.write(`keep serve: ${outcome.log}\n`);
      if (options.onChange) options.onChange();
      health.record('brief', outcome.health);
    } catch (error) {
      health.record('brief', { ok: false, error });
      process.stderr.write(`keep serve: morning brief failed: ${error.message}\n`);
    } finally {
      running = false;
    }
  };
  const held = loopHold.wrap('brief', tick);
  held();
  const timer = setInterval(held, 60e3);
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
  const held = loopHold.wrap('wt-gc', tick);
  const first = later(() => { void held(); }, options.firstRunMs ?? 5 * 60e3);
  first.unref?.();
  const timer = repeat(() => { void held(); }, options.intervalMs ?? 24 * 60 * 60e3);
  timer.unref?.();
  return { tick, first, timer };
}

function start(deps = {}) {
  health.record('daemon', { at: Date.now(), pid: process.pid, version: health.VERSION, ...health.codeCommit() });
  const terminalProfile = deps.terminalProfile || require('./terminal-profile').createTerminalProfileStore();
  let consoleServer = null;
  let dashboardBuilder = null;
  let dashboardPublisher = null;
  let uiWorker = null;
  let backendServer = null;
  let nodeApiServer = null;
  let backendSock = null;
  let retainedPublication = null;
  let announced = false;
  const mutationEpoch = crypto.randomBytes(12).toString('hex');
  let mutationSequence = 0;
  const mutationFence = () => `${mutationEpoch}:${mutationSequence}`;
  const shutdown = () => {
    if (inFlightSwap) {
      const settingsFile = inFlightSwap.settingsFile || claudeSettingsPath();
      const action = shutdownSettingsRepair(inFlightSwap, readClaudeSettingsModel(settingsFile));
      if (!action.repair) {
        process.stderr.write(`keep serve: left settings.json model alone during shutdown: ${action.reason}\n`);
      } else {
        const repaired = repairClaudeSettingsModel(action.value, action.present, settingsFile);
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
    nodeApiServer?.close();
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
    // Sessions on other nodes, as their nodes read them (remoteSessionFreshness). Only
    // present when there are any, so a single-node build input is what it always was.
    ...(options.nodeSessions ? { nodeSessions: options.nodeSessions } : {}),
  });
  const publishedPanes = { panes: null, at: 0, epoch: 0 };
  let lastPaneEpoch = 0;
  const attentionPush = require('./attention-push.js').createAttentionPush({
    root: keep.ROOT,
    onError: (error) => process.stderr.write(`keep serve: attention push failed: ${error.message}\n`),
  });
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
      const listedResult = await listHostPaneResult(deps, freshPanes);
      const listed = hostPanesForPublish(listedResult, publishedPanes, Date.now(), paneEpoch);
      await reviewQueue.reconcile({ inspectLaunch: (active) => inspectReviewQueueLaunch(active) });
      const companion = await companionSnapshot(deps);
      const nodeSessions = await remoteSessionFreshness(listed.panes, deps, { skipNodes: unansweredNodes(listedResult) });
      return { hostPanes: listed.panes, hostStatus: listed.host, companion, mutationFence: capturedMutationFence,
        ...(nodeSessions ? { nodeSessions } : {}) };
    },
    // hostStatus rides beside the build input, not inside it: it changes on every
    // second a silent host stays silent, and the worker keys its dedupe on the input.
    // `nodes` and each session's unfinished move ride beside it for the same reason:
    // a node's reachability and a move's journal change without the input changing.
    build: async (input) => {
      const hostStatus = input.hostStatus || { ok: true };
      const state = Object.assign(await dashboardBuild(input), { hostStatus });
      try { await addNodeState(state, hostStatus, deps); }
      catch (error) { process.stderr.write(`keep serve: node state skipped: ${error.message}\n`); }
      return { state, portableTransfers: listPortableTransfers(), mutationFence: input.mutationFence };
    },
    publish: (publication) => {
      retainedPublication = publication;
      uiWorker?.publish(publication);
      // A phone is not running the console, so the daemon raises the
      // waiting-session notifications the console raises for the desktop.
      try { attentionPush.observe(publication.state); }
      catch (error) { process.stderr.write(`keep serve: attention push failed: ${error.message}\n`); }
    },
    minIntervalMs: envNumber('KEEP_DASHBOARD_MIN_INTERVAL_MS', 5000),
    onError: (error) => process.stderr.write(`keep serve: dashboard refresh failed; retaining published state: ${error.message}\n`),
  });
  const broadcast = () => dashboardPublisher.invalidate();
  onChange = broadcast;
  // A focus request (mobile 'Open on Mac') is a named SSE event the console acts on.
  onFocus = (sessionId) => uiWorker?.event({ type: 'focus', data: sessionId });

  const watch = (target, opts, invalidate, onFailure) => {
    try {
      const w = fs.watch(target, opts || {}, (_event, name) => { invalidate?.(name); broadcast(); });
      // A dead watch must never crash the server; the client's 30s poll covers it.
      w.on('error', (error) => onFailure?.(error));
      return true;
    } catch (e) {
      if (onFailure) onFailure(e);
      else process.stderr.write(`keep serve: cannot watch ${target} (${e.message}); relying on client polling\n`);
      return false;
    }
  };
  watch(keep.TASKS, null, (name) => { dashboardBuilder.invalidate({ kind: 'tasks', name }); dashboardPublisher.invalidate(); });
  // Watch the directory so ledger creation and atomic read-state renames are seen.
  try {
    const inboxWatch = fs.watch(path.join(keep.ROOT, '.keep'), (_event, name) => {
      if (!name || ['alerts.jsonl', 'notifications.json', 'quiet.json',
        'session-preferences.json', 'session-retirements.json'].includes(String(name))) {
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
  // A move writes its journal at every step; the console shows the step it is on.
  try { fs.mkdirSync(path.join(keep.ROOT, '.keep', 'session-moves'), { recursive: true }); } catch {}
  watch(path.join(keep.ROOT, '.keep', 'session-moves'), null, () => dashboardPublisher.invalidate());
  try { fs.mkdirSync(path.join(keep.ROOT, '.keep', 'review'), { recursive: true }); } catch {}
  watch(path.join(keep.ROOT, '.keep', 'review'), null, (name) => { dashboardBuilder.invalidate({ kind: 'review', name }); dashboardPublisher.invalidate(); });
  // The bounded transcript index trusts these watchers to invalidate a changed
  // file between its sweeps. A dead one leaves the dashboard and every periodic tick
  // on sweeps alone (up to 5 s behind for a recent transcript, 60 s for an older
  // one) until the daemon restarts, so say so once, and keep a health row on it.
  let transcriptWatchFailed = false;
  const transcriptWatchFailure = (error) => {
    if (transcriptWatchFailed) return;
    transcriptWatchFailed = true;
    const message = String(error && error.message || error || 'unknown error');
    process.stderr.write(`keep serve: transcript watcher failed: ${message}; bounded scans rely on sweeps until restart\n`);
    try { health.record('transcript-watcher', { ok: false, error: `${message}; bounded scans rely on sweeps until restart` }); } catch {}
  };
  const transcriptWatchStarts = [];
  for (const entry of claudeProjectRoots) {
    // The same callback hears a start failure (synchronously, inside watch) and a
    // later error from a watcher that did start; only the second is reported here.
    let starting = true;
    let startError = null;
    watch(entry.root, { recursive: true }, (name) => {
      claudeTranscriptIndex.invalidate(entry.root, name);
      if (name) backgroundJobScheduler?.wakeFile(path.join(entry.root, String(name)));
      dashboardBuilder.invalidate({ kind: 'claude', root: entry.root, name });
      dashboardPublisher.invalidate();
    }, (error) => { if (starting) startError = error; else transcriptWatchFailure(error); });
    starting = false;
    if (startError?.code === 'ENOENT') {
      process.stderr.write(`keep serve: cannot watch ${entry.root} (${startError.message}); relying on client polling\n`);
    } else if (startError) {
      process.stderr.write(`keep serve: transcript watcher failed: ${startError.message}; bounded scans rely on sweeps until restart\n`);
    }
    transcriptWatchStarts.push({ accountId: entry.accountId, error: startError });
  }
  // Recorded on every start, so a clean start clears a failure an earlier daemon
  // recorded. A later error from a running watcher overwrites it with ok:false.
  try { health.record('transcript-watcher', transcriptWatcherStartHealth(transcriptWatchStarts)); } catch {}
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
  setInterval(loopHold.wrap('background-jobs', jobTick), 500).unref();

  // Everything the daemon's request ladder and periodic jobs need from this
  // module and from start()'s own scope. bin/serve/routes.js and
  // bin/serve/schedulers.js take this instead of requiring serve.js, which would
  // be a cycle. Bindings start() has not made yet, and the module-level state the
  // rest of the daemon rebinds, are getters so they are read live.
  const ctx = {
    ATTENTION_KINDS, InjectionError, MOBILE_VIEWS,
    TURN_INDEX_BUDGET_BYTES, TURN_INDEX_BUDGET_MS, TURN_INDEX_PRUNE_LIMIT, WATCHER_CONCURRENCY,
    WATCHER_TURNS_PER_TICK, WATCHER_WINDOW_MS,
    abandonAccountHandoff, abandonTransfer, accounts, addHostSessionState, agentProcessRows, announceStateNote,
    answerSession, attentionAckKey, attentionAckName, buildState, cancelQueuedHandoff, cardUsage, closeEphemeralPane,
    closeIdleSession, codex, compactSessionById, requestSessionCompaction, companionSnapshot, consoleState, daemonRestartGate,
    dashboardDetail, deliverCheckToThread, deliverUnblockToThread, discord, driftWakeFromVerdict,
    envNumber, features, forceRestartSession, fs, handoffRateLimited, handoffSession, handoffSessionRequest, health, hostRequest,
    ideas,
    inspectReviewQueueLaunch, keep, keepConsole, landed, launchReviewQueueSession,
    limitresume, listHostPaneResult, listHostPanes, listPortableTransfers, liveSessionTick, liveTurnIndexSessions,
    loadCurrentSession, notifications, openCheckSession, openSession, path, portableTransferDraft,
    portableTransferPreview, preparePortableTransfer, prepareSessionSummary, projectMobileState,
    readBody, readLiveSessionLedger, readScreenResult, recentTranscriptText, recoverReviewQueueLaunch, reminders,
    remoteSession, reopenSessionOnAccount, resolvePortableTransfer, resolveReviewLaunchSelection, resolveSessionTarget,
    restartSession,
    restorePlan, resumeAfterLimit, retireLeftDeliveryDrafts, review, reviewDeps, reviewQueue, reviewQueueSearch, runCheckNow,
    runTaskNow, runs, scanSessions, screenHistorySession, screenSession, sendSessionKeys,
    sendStateJson, sendToResolvedTarget, sendToSession, sendToSessionLocked, sessionMarks, sessionNames, sessionSummaryFile, sessionSummarySnapshot,
    setAsideCandidates, slack, stallAliveIds, stalled, stalledSessionSnapshot, standup, tellSession,
    startAutoCompact, startBriefScheduler, startHandoffQueue, startWtGcScheduler, summarize,
    transcriptFileForSession, pendingCompactSwaps, deliveryReceiptFor,
    transferSession, moveSession,
    unblock, updateSetAside, usage, wantsConsoleState, watcherSend,
    withInjectionLock, writeTarget, writeToShellPane,
    broadcast, dashboardBuild, dashboardBuilder, deps, shutdown, terminalProfile,
    get json() { return json; },
    get onChange() { return onChange; },
    get onFocus() { return onFocus; },
    // The dashboard state the console is actually showing. Routes that validate a
    // key the console handed back read it live, so they see the same items it did.
    get publishedState() { return retainedPublication ? retainedPublication.state : null; },
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

  // Decided once at boot, like the listener it describes: whether this daemon hears
  // from other nodes at all. On a single-node install it never does, and the node
  // API's routes match nothing.
  const nodeApiListen = require('./node-registry.js').nodeApiListen();
  ctx.nodeApiEnabled = () => nodeApiListen.enabled === true;
  ctx.registryService = nodeApiListen.enabled ? require('./registry-route.js').createRegistryService({
    root: keep.ROOT, stopping: () => daemonRestartGate.stopping,
  }) : null;
  if (ctx.registryService) registryRunsInFlight = () => ctx.registryService.busy();
  // A node's Claude hooks, through the registry service's journal and restart gate.
  ctx.hookService = ctx.registryService ? require('./hook-route.js').createHookService({
    root: keep.ROOT, stopping: () => daemonRestartGate.stopping, registry: ctx.registryService,
  }) : null;
  // The restart is the one /api/restart-daemon makes: wait for in-flight work, then
  // mark the request and exit after the answer has gone out.
  ctx.deploySelf = nodeApiListen.enabled ? require('./deploy-self.js').createDeploySelf({
    restart: async () => {
      const result = await daemonRestartGate.prepareWhenIdle();
      setTimeout(() => { health.recordRestartRequest(); shutdown(); }, 50);
      return result;
    },
  }) : null;
  const requestRoutes = buildRequestRoutes(ctx);
  // Read once at boot, like the public token above. Only the node listener below
  // honours one; it re-reads the directory itself when it is shown a token it does
  // not know, so this map is where it starts.
  const nodeTokenMap = nodes.nodeApiTokens(keep.ROOT);

  // Phone pushes carry the console's own badge count. Only the daemon has the
  // state it is computed from, so it hands alerts.js a reader for it rather than
  // every alert caller passing one.
  alerts.setBadgeProvider(() => alerts.badgeFromState(retainedPublication ? retainedPublication.state : null));

  const server = http.createServer(async (req, res) => {
    if (req.keepConsoleHandled) return;
    try {
      const url = new URL(req.url, 'http://localhost');

      // Who is asking, resolved once. `acceptNodeTokens` is false: a node reaches
      // the daemon only through the node listener (serve/node-api.js), never
      // through this server, whose proxy stamps the admin token.
      const auth = { isLocal, token, internalToken: backendToken, nodeTokens: nodeTokenMap, acceptNodeTokens: false };
      const authError = apiRequestAuthError(req, auth);
      if (authError) return json(res, authError.status, { error: authError.error });
      const principal = keepConsole.principal(req, auth);
      const forbidden = (route) => {
        const denial = routeDenial(route, principal);
        if (!denial) return false;
        json(res, denial.status, { error: denial.error });
        return true;
      };

      if (req.method === 'POST') {
        // custom header forces a CORS preflight, which no other origin passes —
        // keeps random web pages from firing POSTs at localhost
        let body;
        try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
        try {
          const route = matchRoute(requestRoutes, { req, url, body });
          if (route) {
            if (forbidden(route)) return;
            return await route.handle({ req, res, url, body, principal });
          }
          return json(res, 404, { error: 'not found' });
        } catch (e) {
          if (e instanceof keep.KeepError) return json(res, 400, { error: e.message });
          throw e;
        }
      }

      const route = matchRoute(requestRoutes, { req, url });
      if (route) {
        if (forbidden(route)) return;
        return await route.handle({ req, res, url, principal });
      }
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
    // A viewer names the node in the pane ref it asked for; the daemon node is
    // still reached without naming it, exactly as before.
    hostClient: (node) => require('./hostclient.js').connect(
      node && node !== daemonNodeName() ? { node, timeoutMs: HOST_CONNECT_TIMEOUT_MS } : { timeoutMs: HOST_CONNECT_TIMEOUT_MS },
    ),
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
  // A route whose refusal still changed state (res.keepStateChanged) is fenced too.
  server.prependListener('request', (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const writeHead = res.writeHead;
    let fenced = false;
    res.writeHead = function fencedWriteHead(status, ...args) {
      if (!fenced && ((status >= 200 && status < 300) || res.keepStateChanged === true)) {
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
  // The listener for other nodes, on its own interface, when one is configured and
  // this install has another node to hear from. A single-node install never gets
  // one: node-registry.nodeApiListen answers disabled before anything is bound.
  {
    const nodeApi = require('./serve/node-api.js');
    nodeApiServer = nodeApi.startNodeApi({
      listen: nodeApiListen,
      // What `keep doctor` reads to say whether the listener is actually bound.
      onState: (value) => nodeApi.writeState(keep.ROOT, value),
      handler: nodeApi.createNodeApiHandler({
        routes: requestRoutes, matchRoute, routeDenial, readBody, principal: keepConsole.principal,
        // A hook post carries up to 4 MiB of transcript, base64-encoded.
        bodyLimit: (pathname) => (pathname === '/api/hook' ? require('./hook-route.js').BODY_MAX_BYTES : undefined),
        tokenStore: nodeApi.createNodeTokenStore({ initial: nodeTokenMap, read: () => nodes.nodeApiTokens(keep.ROOT) }),
        json,
        onMutation: () => dashboardPublisher?.invalidate(),
      }),
    });
  }
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
        console.log(`keep serve — http://localhost:${PORT}/app`);
      },
    });
    if (retainedPublication) uiWorker.publish(retainedPublication);
  });
}

module.exports = {
  runWorktreeRecreation,
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
  compactModelExhausted,
  autoCompactPolicy,
  reopenCompactPolicy,
  autoCompactCandidates,
  autoCompactOutcome,
  autoCompactTick,
  readCompactRequest,
  readCompactRequests,
  writeCompactRequest,
  clearCompactRequest,
  expiredCompactRequest,
  requestSessionCompaction,
  readAutoCompactStamps,
  compactSession,
  compactSessionTransaction,
  compactRequestTelemetry,
  hasCompactionMarker,
  compactSwapPlan,
  compactionSwappedModel,
  ensureCompactionRestored,
  afterCompactAction,
  pendingCompactSwaps,
  readPendingCompactSwap,
  writePendingCompactSwap,
  sweepPendingCompactSwaps,
  compactRestoreBlocking,
  compactRestoreInputBaseline,
  assertCompactRestoreSettled,
  compactRestoreDeferral,
  compactRestoreRateLimited,
  compactSwapUserModelChoice,
  compactModelResetAt,
  compactViaModel,
  latestOpusModel,
  noteSeenModel,
  readLatestOpusSeen,
  claudeConfigDirOf,
  sessionClaudeConfigDir,
  shutdownSettingsRepair,
  readClaudeSettingsModel,
  linesAfterLastEcho,
  compactScreenConfirmed,
  modelSwitchConfirmed,
  modelSwitchDialogVisible,
  modelSwitchDialogOffer,
  modelSwitchDialogAnswerable,
  waitForModelSwitch,
  worktreeExitPromptKeepsWorktree,
  repairClaudeSettingsModel,
  pickNotifyTarget,
  pickDeliveryCandidates,
  checkDeliveryIds,
  deliverCheckToThread,
  tellSession,
  loadTellSession,
  loadCurrentSession,
  loadSessionExact,
  answerSession,
  shouldCompactFirst,
  lastTurnUsage,
  sessionLastTurn,
  lastClaudeHandoffModel,
  handoffCurrentModel,
  accountBudgetModel,
  openBudgetModel,
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
  priorForcedSurvivors,
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
  briefTickOutcome,
  startBriefScheduler,
  startWtGcScheduler,
  buildWhoSnapshot,
  scanTranscript,
  scanTranscriptText,
  claudeSessionFromTail,
  nodeTranscript,
  nodeTranscriptFileForSession,
  deliveryReceiptFor,
  nodeArtifacts,
  localSessionArtifacts,
  pushSession,
  pullSession,
  moveSession,
  addNodeState,
  consoleNodes,
  sessionMoveDeps,
  inspectSessionMove,
  remoteSessionFreshness, unansweredNodes, piEventFor, waitForPiStart, cachedRemotePiEvent,
  remoteSessionRead,
  loadRemoteSession,
  loadSessionForAction,
  claudeTranscriptIsInteractive,
  claudeSessionFromInfo,
  sessionBackgroundPending,
  inspectCloseTranscript,
  stallAliveIds,
  companionSnapshot,
  applyCompanionJobs,
  claudeSessionFor,
  forgetClaudeSessionMisses,
  noteHostPaneSessions,
  createDashboardClaudeSessionResolver,
  createIndexedClaudeSessionResolver,
  transcriptWatcherStartHealth,
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
  pendingPaneAttention,
  updateSetAside,
  classifyPromptLine,
  probeSuggestion,
  logDraftRefusal,
  sendPrecheck,
  SUGGESTION_PROBE_KEY,
  SUGGESTION_PROBE_MAX_READS,
  SUGGESTION_PROBE_SETTLE_READS,
  isHostTarget,
  hostClient,
  hostClientFor,
  validPaneRef,
  hostNodeEntries,
  resolvePlacement,
  nodeEvidence,
  unverifiedProcesses,
  sessionNodeOf,
  remoteSession,
  hostNodeNames,
  listNodePaneResult,
  sessionHostPane,
  closeHostClient,
  hostRequest,
  listHostPanes,
  listHostPaneResult,
  lastKnownHostPanes,
  readScreenResult,
  readScreen,
  writeTarget,
  pressTargetKey,
  typeAndSubmit,
  discardTypedDraft,
  retireLeftDeliveryDrafts,
  draftRegionText,
  draftIsExactly,
  watcherSend,
  resolveSessionTarget, remoteDeliveryRefusal,
  resolveSessionId, screenSession, screenHistorySession, sendSessionKeys, shellPaneTarget, stripTerminalAnsi, writeToShellPane,
  agentProcessRows, parseProcessTable, agentRowUnreadable, liveSessionPids, liveSessionTick, restorePlan,
  annotatePaneAgents,
  readPaneRecord, sessionProjectFromTranscript, openSession, reopenSessionOnAccount,
  runCheckNow, runTaskNow, openCheckSession, taskRunMessage, adoptedPaneMeta, closeEphemeralPane, resolveOpener, inheritedOpener,
  transcriptFileForSession,
  inspectAccountHandoff, waitForAccountRecord, resumeExitedAccountHandoff, continueAccountHandoff, handoffSession,
  abandonAccountHandoff,
  abandonTransfer,
  handoffQueueSessions, handoffPolicySessions, handoffQueueTick, handoffRateLimited, cancelQueuedHandoff, handoffSessionRequest,
  queueRefusedHandoff,
  listPortableTransfers, inspectPortableSource, portableTerminalRateLimitEvidence,
  portableTransferDraft, preparePortableTransfer,
  portableTransferPreview, transferSession, resolvePortableTransfer, recoverPortableOpening,
  resolveReviewLaunchSelection, launchReviewQueueSession, skipCardLink, inspectReviewQueueLaunch, recoverReviewQueueLaunch,
  waitForHostAgent, waitForHostSessionId, adoptNodeCodexLaunch, addHostSessionState, addStoppedSessionNodes,
  sendToSession, sendToResolvedTarget, precheckSessionTarget, InjectionError,
  claudeMcpMenuVisible,
  resumeAfterLimit,
};

if (require.main === module) start();
