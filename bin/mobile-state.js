'use strict';

const MOBILE_VIEWS = new Set(['needs', 'fleet', 'reviewer', 'session', 'task', 'new', 'notifications', 'terminal']);

function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source && source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

const TASK_FRONTMATTER_FIELDS = ['title', 'status', 'project', 'tags', 'next', 'next_step', 'updated'];
const SESSION_SUMMARY_FIELDS = [
  'id', 'kind', 'agent', 'project', 'title', 'taskId', 'taskStatus', 'mtime', 'lastUserAt',
  'state', 'stateLabel', 'endedTurn', 'alive', 'exited', 'pane', 'rateLimit', 'reviewer',
  'gitBranch', 'stalled',
];
const SESSION_DETAIL_FIELDS = [
  ...SESSION_SUMMARY_FIELDS, 'lastAssistantFull', 'pendingQuestion', 'pendingPlan', 'waitingFor',
  'toolRunning', 'pendingBackground', 'unknownBackgroundJobs', 'askedProse', 'attentionAt',
];
const PANE_FIELDS = ['id', 'cwd', 'alive', 'agentAlive', 'createdAt', 'exitedAt', 'title', 'meta'];

function clip(value, max = 500) {
  if (typeof value !== 'string' || value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function taskSummary(task) {
  return {
    id: task.id,
    fm: pick(task.fm, TASK_FRONTMATTER_FIELDS),
    ...(task.lastLog !== undefined ? { lastLog: clip(task.lastLog) } : {}),
    ...(task.overdue !== undefined ? { overdue: task.overdue } : {}),
  };
}

function taskPickerSummary(task) {
  return { id: task.id, fm: pick(task.fm, ['title', 'status', 'project', 'tags']) };
}

function openTaskSummaries(state) {
  return (state.tasks || []).filter((task) => task?.fm?.status !== 'done').map(taskPickerSummary);
}

function sessionSummary(session) {
  return pick(session, SESSION_SUMMARY_FIELDS);
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
    review: { stats: pick(stats, ['lastTickAt', 'reviewer']) },
  };
}

function attentionState(state, view) {
  return {
    ...shared(state, view),
    attention: (state.attention || []).map(attentionSummary),
    setAside: state.setAside || {},
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

function exactTask(state, id) {
  return (state.tasks || []).find((task) => task.id === id) || null;
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

  if (view === 'reviewer') {
    return {
      ...attentionState(state, view),
      review: state.review || { events: [], stats: {} },
    };
  }

  if (view === 'task') {
    requireId(view, id);
    const task = exactTask(state, id);
    if (!task) return { ...shared(state, view), task: null };
    return { ...shared(state, view), task };
  }

  if (view === 'session') {
    requireId(view, id);
    const session = exactSession(state, id);
    const task = session?.taskId ? exactTask(state, session.taskId) : null;
    const attention = (state.attention || []).filter((item) => item.sessionId === id);
    const pane = session?.pane ? (state.panes || []).find((candidate) => candidate.id === session.pane) : null;
    return {
      ...shared(state, view),
      sessions: session ? [pick(session, SESSION_DETAIL_FIELDS)] : [],
      tasks: task ? [taskSummary(task)] : [],
      attention,
      setAside: state.setAside || {},
      panes: pane ? [paneSummary(pane)] : [],
    };
  }

  if (view === 'terminal') {
    requireId(view, id);
    const session = exactSession(state, id);
    const pane = (state.panes || []).find((candidate) => candidate.id === id || candidate.id === session?.pane) || null;
    return {
      ...shared(state, view),
      sessions: session ? [sessionSummary(session)] : [],
      panes: pane ? [paneSummary(pane)] : [],
    };
  }

  if (view === 'new') {
    return {
      ...shared(state, view),
      tasks: openTaskSummaries(state),
      sessions: (state.sessions || []).map((session) => pick(session, ['id', 'project'])),
      panes: (state.panes || []).map((pane) => {
        const summary = pick(pane, ['id', 'cwd', 'alive', 'title']);
        summary.meta = pick(pane.meta, ['project']);
        return summary;
      }),
    };
  }

  if (view === 'fleet') {
    return {
      ...attentionState(state, view),
      sessions: (state.sessions || []).map(sessionSummary),
      panes: (state.panes || []).map(paneSummary),
      tasks: [],
    };
  }

  return {
    ...attentionState(state, view),
    tasks: (() => {
      const taskIds = new Set([
        ...(state.sessions || []).map((session) => session.taskId),
        ...(state.attention || []).map((item) => item.taskId),
      ].filter(Boolean));
      return (state.tasks || []).filter((task) => taskIds.has(task.id) && task?.fm?.status !== 'done').map(taskPickerSummary);
    })(),
    sessions: (state.sessions || []).map(sessionSummary),
    panes: (state.panes || []).map((pane) => {
      const summary = pick(pane, ['id', 'cwd', 'alive', 'createdAt', 'title']);
      summary.meta = pick(pane.meta, ['agent', 'sessionId', 'project', 'title']);
      return summary;
    }),
  };
}

module.exports = {
  MOBILE_VIEWS,
  projectMobileState,
  taskSummary,
  taskPickerSummary,
  sessionSummary,
  paneSummary,
  attentionSummary,
};
