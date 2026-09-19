'use strict';

const crypto = require('node:crypto');

const DETAIL_KINDS = new Set(['task', 'session', 'review']);
const SUMMARY_TEXT_LIMIT = 500;

function detailVersion(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 16);
}

function sessionDetailVersion(session) {
  // The desktop clients only defer the complete assistant tail. Keep this key
  // stable when process observations, account labels, or list status change so
  // an open historical session does not refetch the same transcript every poll.
  return detailVersion({ lastAssistantFull: session.lastAssistantFull || '' });
}

function taskDetailVersion(task) {
  // The card-usage collector stamps its run time on every card's modelUsage. Hashing
  // it gave all cards a new version each run, so consoles refetched unchanged cards
  // (and an open card could fail with "Details changed while loading").
  if (!task?.modelUsage || !Object.hasOwn(task.modelUsage, 'updatedAt')) return detailVersion(task);
  const { updatedAt: _updatedAt, ...modelUsage } = task.modelUsage;
  return detailVersion({ ...task, modelUsage });
}

function clipped(value, limit = SUMMARY_TEXT_LIMIT) {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function taskCreatedAt(task) {
  const logged = String(task.body || '').match(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) — created(?:\r?$)/m)?.[1];
  return logged ? logged.replace(' ', 'T') : task.fm?.created || null;
}

function taskSummary(task) {
  const { body: _body, modelUsage: _modelUsage, ...summary } = task;
  const { check, probe: _probe, ...fm } = task.fm || {};
  return {
    ...summary,
    fm,
    lastLog: clipped(task.lastLog),
    createdAt: taskCreatedAt(task),
    hasCheck: Boolean(check),
    _detailVersion: taskDetailVersion(task),
  };
}

// The turn watcher's one-line "what this session just did and what is next".
// One bounded query per state build, and entirely optional: an index that is
// missing, locked, or has never been written leaves the fields absent.
function attachStateLines(sessions, deps = {}) {
  const rows = Array.isArray(sessions) ? sessions : [];
  if (!rows.length) return rows;
  let lines;
  let pending = new Map();
  const ids = rows.map((session) => session && session.id);
  try {
    const watcher = deps.watcher || require('./turn-watcher.js');
    lines = watcher.stateLines(ids);
    // The common case — grading the verdict on the selected session — must not
    // need a second fetch, so the pending decision rides along with the state.
    try { pending = watcher.pendingDecisions(ids); } catch {}
  } catch { return rows; }
  for (const session of rows) {
    if (!session) continue;
    const found = lines.get(session.id);
    if (found) {
      if (found.stateLine) session.stateLine = found.stateLine;
      if (found.lastVerdict) session.lastVerdict = found.lastVerdict;
      if (found.lastVerdictAt) session.lastVerdictAt = found.lastVerdictAt;
      if (found.confidence != null) session.verdictConfidence = found.confidence;
    }
    const decision = pending.get(session.id);
    if (decision) {
      session.pendingDecision = { id: decision.id, type: decision.type, message: decision.message };
      if (decision.delivered) session.pendingDecision.delivered = true;
    }
  }
  return rows;
}

// One line of graduation progress for the console's fleet strip. Absent rather
// than fatal when the watcher has never run.
function shadowDecisionSummary(deps = {}) {
  try { return (deps.watcher || require('./turn-watcher.js')).shadowSummary(); }
  catch { return null; }
}

function sessionSummary(session) {
  const {
    observation: _observation,
    runtime: _runtime,
    backgroundJobs: _backgroundJobs,
    ...summary
  } = session;
  if (session.exited === true || session.state === 'exited') {
    delete summary.lastAssistantFull;
    delete summary.lastHuman;
    delete summary.size;
    delete summary.lifecycleForeground;
    delete summary.lifecycleStop;
    delete summary.lifecycleTurnAt;

    // Status labels and top-level pending flags carry the normal exited-row
    // state. Retain background detail only when it represents work the user
    // still needs to see; the full decision trace is diagnostic detail.
    const background = session.activity?.background;
    const meaningfulBackground = background && (background.pending
      || background.checkAfter
      || background.uncertain?.length
      || background.scheduled?.length
      || background.dependencies?.length);
    if (meaningfulBackground) summary.activity = { background };
    else delete summary.activity;
  }
  return { ...summary, _detailVersion: sessionDetailVersion(session) };
}

function paneSummary(pane) {
  if (pane.alive !== false && pane.agentAlive !== false) return pane;
  const {
    cmd: _cmd,
    args: _args,
    cols: _cols,
    rows: _rows,
    attached: _attached,
    visibleAttached: _visibleAttached,
    lastInputAt: _lastInputAt,
    lastOutputAt: _lastOutputAt,
    lastReadAt: _lastReadAt,
    inputCount: _inputCount,
    outputCount: _outputCount,
    bytes: _bytes,
    alt: _alt,
    primary: _primary,
    ...summary
  } = pane;
  return summary;
}

function reviewItemSummary(item) {
  const {
    body: _body,
    evidence: _evidence,
    outcome: _outcome,
    sessions: _sessions,
    ...summary
  } = item;
  return { ...summary, _detailVersion: detailVersion(item) };
}

// The dashboard list response keeps all counters, notifications, attention rows,
// and operational state. Only per-item content that is rendered after opening an
// item moves behind /api/dashboard-detail.
function lightweightState(state) {
  return {
    ...state,
    tasks: (state.tasks || []).map(taskSummary),
    sessions: (state.sessions || []).map(sessionSummary),
    panes: (state.panes || []).map(paneSummary),
    reviewQueue: state.reviewQueue ? {
      ...state.reviewQueue,
      items: (state.reviewQueue.items || []).map(reviewItemSummary),
    } : state.reviewQueue,
  };
}

function wantsLightweightState(url) {
  return url.searchParams.get('summary') === '1';
}

function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source && source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

// The web console (web/app) reads exactly these top-level fields. Everything the
// legacy board at web/index.html needs but the console never renders — digest,
// alerts, brief, standup, landed, slack, defaults, the weekly rollups — is dropped.
// A new top-level field the console reads must be added here AND to the allowlist
// test in dashboard-state.test.js, or it silently arrives undefined in the browser.
const CONSOLE_STATE_KEYS = [
  'generatedAt', 'shadowDecisions', 'scopes', 'projectCatalog', 'restarts', 'tasks', 'sessions',
  'attention', 'setAside', 'notifications', 'reminders', 'limitResume', 'health', 'usage',
  'reviewQueue', 'accounts', 'handoffs', 'handoffQueue', 'review', 'agents', 'panes', 'hostStatus',
];

// An exited session is a list row and a transcript link; the console never reads
// the rest of the observation, lifecycle, or background detail off a dead row.
const CONSOLE_DEAD_SESSION_FIELDS = [
  'id', 'num', 'kind', 'agent', 'agentName', 'title', 'renamed', 'mark', 'project', 'gitBranch',
  'taskId', 'taskStatus', 'state', 'stateLabel', 'alive', 'exited', 'pane', 'mtime', 'lastUserAt',
  'turnStartedAt', 'accountId', 'accountLabel', 'reviewer', 'rateLimit', 'lastAssistant', 'stateLine',
  'lastVerdict', 'lastVerdictAt', 'verdictConfidence', 'pendingDecision', 'pendingQuestion',
  'pendingPlan', 'activity', '_detailVersion',
];

const CONSOLE_DEAD_PANE_FIELDS = [
  'id', 'alive', 'agentAlive', 'cwd', 'title', 'createdAt', 'exitedAt', 'pid', 'scope', 'meta',
];

const CONSOLE_PANE_META_FIELDS = [
  'agent', 'agentName', 'sessionId', 'project', 'title', 'card', 'accountId', 'accountLabel',
  'portableTransferId', 'url', 'attributes', 'terminalRendererTrial',
];

// Closed cards outnumber open ones several to one on a live daemon, and the
// console only renders a done card when something still in flight points at it.
function referencedCardIds(state) {
  const ids = new Set();
  const add = (value) => { if (typeof value === 'string' && value) ids.add(value); };
  const rows = (value) => (Array.isArray(value) ? value : []);
  for (const session of rows(state.sessions)) add(session?.taskId);
  for (const item of rows(state.attention)) add(item?.taskId);
  for (const item of rows(state.reviewQueue?.items)) add(item?.card);
  for (const entry of rows(state.notifications)) add(entry?.card);
  for (const agent of rows(state.agents)) add(agent?.card);
  for (const restart of rows(state.restarts)) add(restart?.taskId);
  return ids;
}

function consoleSession(session) {
  if (!session) return session;
  const dead = session.exited === true || session.state === 'exited' || session.alive === false;
  return dead ? pick(session, CONSOLE_DEAD_SESSION_FIELDS) : session;
}

function consolePane(pane) {
  if (!pane) return pane;
  if (pane.alive !== false && pane.agentAlive !== false) return pane;
  const summary = pick(pane, CONSOLE_DEAD_PANE_FIELDS);
  if (summary.meta !== undefined) summary.meta = pick(summary.meta, CONSOLE_PANE_META_FIELDS);
  return summary;
}

// The console's own projection: lightweight state, minus the top-level fields only
// the legacy board reads, minus closed cards nothing points at, minus the detail
// that exited sessions and dead panes carry for the full API shape.
// `lightweight` is an optional already-built summary of the same state: the
// frontend worker publishes both projections at once, and the detail-version
// hashing over every card and session is the expensive half of the pass.
function consoleState(state, lightweight) {
  const light = lightweight || lightweightState(state);
  const keep = referencedCardIds(light);
  const projected = pick(light, CONSOLE_STATE_KEYS);
  if (projected.tasks !== undefined) {
    projected.tasks = (light.tasks || [])
      .filter((task) => task?.fm?.status !== 'done' || keep.has(task?.id))
      .map((task) => { const { lastLog: _lastLog, ...summary } = task; return summary; });
  }
  if (projected.sessions !== undefined) projected.sessions = (light.sessions || []).map(consoleSession);
  if (projected.panes !== undefined) projected.panes = (light.panes || []).map(consolePane);
  return projected;
}

function wantsConsoleState(url) {
  return url.searchParams.get('console') === '1';
}

function detailError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function dashboardDetail(state, kind, id) {
  if (!DETAIL_KINDS.has(kind)) throw detailError(400, `unknown dashboard detail kind: ${kind || '(empty)'}`);
  if (typeof id !== 'string' || !id) throw detailError(400, 'dashboard detail id is required');
  const rows = kind === 'task' ? state.tasks : kind === 'session' ? state.sessions : state.reviewQueue?.items;
  const value = (rows || []).find((row) => row.id === id);
  if (!value) throw detailError(404, `${kind} detail not found: ${id}`);
  return { kind, id, version: kind === 'session' ? sessionDetailVersion(value)
    : kind === 'task' ? taskDetailVersion(value) : detailVersion(value), value };
}

function reviewQueueSearch(state, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return { ids: (state.reviewQueue?.items || []).map((item) => item.id) };
  return {
    ids: (state.reviewQueue?.items || []).filter((item) =>
      [item.title, item.card, item.project, item.body]
        .some((value) => String(value || '').toLowerCase().includes(needle)))
      .map((item) => item.id),
  };
}

// The console only displays card histories in its notification inbox. Keep the
// full API shape for legacy/read-only clients and all internal safety decisions.
function compactState(state) {
  const cards = new Set((state.notifications || []).map(entry => entry.card).filter(Boolean));
  return {
    ...state,
    tasks: (state.tasks || []).map(task => {
      if (cards.has(task.id)) return task;
      const { body, ...summary } = task;
      return summary;
    }),
    sessions: (state.sessions || []).map(session => {
      const { backgroundJobs, ...summary } = session;
      return summary;
    }),
  };
}

function wantsCompactState(req, url) {
  if (url.searchParams.has('compact')) return url.searchParams.get('compact') === '1';
  // Already-open consoles retain their JS across daemon restarts. Their field
  // requirements are the same, so no window reload or PTY interruption is needed.
  // The legacy dashboard lives at / and keeps the full response.
  try { return /^\/app(?:\/|$)/.test(new URL(req.headers.referer).pathname); }
  catch { return false; }
}

function createJobChangeTracker() {
  const signatures = new Map();
  return (key, result) => {
    // Lock contention provides no new evidence about the last observed jobs.
    if (result.uncertain?.includes('ledger-busy')) return false;
    // Reconciliation timestamps and bytes read are bookkeeping, not a state
    // transition. Confidence changes and child-only completions still notify.
    const signature = JSON.stringify({
      pending: result.pending, uncertain: result.uncertain, recovering: result.recovering, gap: result.gap,
      jobs: (result.jobs || []).map(({ lastCorroboratedAt, ...job }) => job),
    });
    const changed = signatures.get(key) !== signature;
    signatures.set(key, signature);
    return changed;
  };
}
module.exports = {
  attachStateLines,
  shadowDecisionSummary,
  compactState,
  wantsCompactState,
  lightweightState,
  wantsLightweightState,
  consoleState,
  wantsConsoleState,
  CONSOLE_STATE_KEYS,
  CONSOLE_DEAD_SESSION_FIELDS,
  CONSOLE_DEAD_PANE_FIELDS,
  CONSOLE_PANE_META_FIELDS,
  dashboardDetail,
  reviewQueueSearch,
  createJobChangeTracker,
};
