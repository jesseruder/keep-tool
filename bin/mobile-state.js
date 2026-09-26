'use strict';

// The phone app reads three projections: `notifications` (its connection check and
// the notification fallback), `terminal` (resolving a session to its pane) and
// `refs` (what the native terminal's `#n` and card-id links can name). The console
// itself runs in a WebView and reads the console projection.
const MOBILE_VIEWS = new Set(['notifications', 'terminal', 'refs']);
const HUMAN_ATTENTION_KINDS = new Set(['question', 'permission', 'plan', 'input']);

function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source && source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

const SESSION_SUMMARY_FIELDS = [
  'id', 'num', 'kind', 'agent', 'project', 'title', 'renamed', 'mark', 'taskId', 'taskStatus', 'mtime', 'lastUserAt',
  'state', 'stateLabel', 'endedTurn', 'alive', 'exited', 'pane', 'rateLimit', 'reviewer',
  // `agent` above is the provider (claude/codex); `agentName` is the standing
  // agent whose session this is, and gates the same controls `reviewer` does.
  'agentName',
  // The watcher's one-line "what this session just did and what is next", and the
  // verdict it came from. `pick` drops them when the watcher has not run.
  'gitBranch', 'stalled', 'stateLine', 'lastVerdict', 'lastVerdictAt', 'verdictConfidence', 'pendingDecision',
];
const PANE_FIELDS = ['id', 'cwd', 'alive', 'agentAlive', 'createdAt', 'exitedAt', 'title', 'meta'];

function clip(value, max = 500) {
  if (typeof value !== 'string' || value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function sessionSummary(session) {
  const summary = pick(session, SESSION_SUMMARY_FIELDS);
  if (session?.lastAssistant !== undefined) summary.lastAssistant = clip(session.lastAssistant);
  return summary;
}

function attentionSummary(item) {
  const summary = pick(item, [
    'id', 'pri', 'kind', 'sessionId', 'taskId', 'pane', 'project', 'title', 'since', 'state',
    'attentionLabel', 'lastUserAt', 'codex', 'key', 'setAside', 'question', 'detail', 'text', 'errorText',
  ]);
  for (const field of ['question', 'detail', 'text', 'errorText']) {
    if (summary[field] !== undefined) summary[field] = clip(summary[field]);
  }
  return summary;
}

function paneSummary(pane) {
  const summary = pick(pane, PANE_FIELDS);
  if (summary.meta) summary.meta = pick(summary.meta, ['agent', 'sessionId', 'project', 'title', 'card']);
  return summary;
}

function shared(state, view) {
  const stats = state.review?.stats || {};
  const health = state.health || {};
  return {
    view,
    scopes: state.scopes || {},
    projectCatalog: state.projectCatalog || {},
    health: {
      daemon: pick(health.daemon, ['running']),
      schedulers: (health.schedulers || []).map((scheduler) => pick(scheduler, ['name', 'state'])),
    },
    usage: state.usage || {},
    paneCount: (state.panes || []).length,
    needsCount: (state.attention || []).filter((item) => item.sessionId && HUMAN_ATTENTION_KINDS.has(item.kind) && !item.setAside).length,
    review: { stats: pick(stats, ['lastTickAt', 'reviewer']) },
    // One short row per agent — name, lifecycle, last event, unseen count. The
    // mobile client shows the same section the console's triage does.
    agents: state.agents || [],
  };
}

function requireId(view, id) {
  if (typeof id !== 'string' || !id) {
    const error = new Error(`${view} view requires id`);
    error.status = 400;
    throw error;
  }
}

function exactSession(state, id) {
  return (state.sessions || []).find((session) => session.id === id) || null;
}

function projectMobileState(state, view, id) {
  if (!MOBILE_VIEWS.has(view)) {
    const error = new Error(`unknown mobile state view: ${view}`);
    error.status = 400;
    throw error;
  }

  if (view === 'notifications') {
    return { view, attention: (state.attention || []).map(attentionSummary) };
  }

  // Every numbered session and every card in the console's list, a line each: the
  // phone decides from this which `#n` and card ids are links, and the tapped card
  // shows these fields at once while the rest (a card's log, who mentions a
  // session) loads from the same endpoints the console's hover cards use.
  if (view === 'refs') {
    return {
      view,
      sessions: (state.sessions || []).filter((session) => Number.isInteger(session?.num)).map((session) => ({
        ...pick(session, ['id', 'num', 'kind', 'title', 'project', 'taskId', 'pane', 'mtime', 'reviewer', 'accountLabel']),
        state: session.stateLabel || session.activity?.label || session.state || '',
      })),
      tasks: (state.tasks || []).filter((task) => task?.id).map((task) => ({
        id: task.id, title: task.fm?.title || task.id, status: task.fm?.status || '', project: task.fm?.project || '',
      })),
    };
  }

  requireId(view, id);
  const session = exactSession(state, id);
  const pane = (state.panes || []).find((candidate) => candidate.id === id || candidate.id === session?.pane) || null;
  return {
    ...shared(state, view),
    id,
    sessions: session ? [sessionSummary(session)] : [],
    panes: pane ? [paneSummary(pane)] : [],
  };
}

module.exports = {
  MOBILE_VIEWS,
  HUMAN_ATTENTION_KINDS,
  projectMobileState,
  sessionSummary,
  paneSummary,
  attentionSummary,
};
