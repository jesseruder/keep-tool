import scopeRules from './scope-rules';
export const PROJECTS = { keep: { name: 'Keep', h: 210 } };
let scopeSettings = scopeRules.defaults;
let projectCatalog = {};
export function configureProjects(state) { scopeSettings = state?.scopes || scopeRules.defaults; projectCatalog = state?.projectCatalog || {}; }
const HOME = '';

export function timestamp(value) {
  if (typeof value === 'number') return value < 100000000000 ? value * 1000 : value;
  const numeric = Number(value);
  if (value !== '' && Number.isFinite(numeric)) return numeric < 100000000000 ? numeric * 1000 : numeric;
  return Date.parse(value);
}

export function rel(value) {
  const at = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(at)) return '—';
  const age = Math.max(0, Date.now() - at);
  if (age < 60e3) return 'now';
  if (age < 3600e3) return `${Math.floor(age / 60e3)}m`;
  if (age < 86400e3) return `${Math.floor(age / 3600e3)}h`;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (new Date(at).toDateString() === yesterday.toDateString()) return 'yesterday';
  return `${Math.floor(age / 86400e3)}d`;
}

export function waitText(value) {
  const at = timestamp(value);
  const age = Math.max(0, Date.now() - (Number.isFinite(at) ? at : Date.now()));
  const minutes = Math.floor(age / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function hashHue(value) {
  let hash = 2166136261;
  for (const character of String(value)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return Math.abs(hash) % 360;
}

export function projectFor(projectPath = '') {
  // Cards store projects as `~/castle/x` while sessions and panes use the absolute path;
  // both must resolve to the same PROJECTS entry or the card picker shows raw folder names.
  const clean = String(projectPath || 'unknown').replace(/\/$/, '');
  const relative = clean.replace(/^\/Users\/[^/]+\/|^\/home\/[^/]+\/|^~\//, '');
  const worktree = relative.match(/^wt\/([^/]+)\/([^/]+)/);
  let key = relative;
  if (worktree) key = Object.keys({ ...PROJECTS, ...projectCatalog }).find((candidate) => candidate.split('/').pop() === worktree[1]) || worktree[1];
  const known = projectCatalog[key] || PROJECTS[key];
  return {
    key,
    path: clean,
    name: known?.name || relative.split('/').filter(Boolean).pop() || 'Unknown',
    scope: scopeRules.scopeForProject(worktree && known ? '~/' + key : clean, scopeSettings, scopeSettings.home) || scopeSettings.default,
    h: known?.h ?? hashHue(clean),
    wt: worktree?.[2] || null,
  };
}

export function itemKey(item) {
  return item.sessionId || item.taskId || item.pane || `${item.kind}:${item.title}:${item.since}`;
}

export function eventKey(item) {
  return `${itemKey(item)}:${item.since || ''}`;
}

export function entityId(item) {
  return item.sessionId || item.taskId || `${item.project || ''}:${item.title || ''}`;
}

export function snoozeId(item) {
  return `${item.kind}:${entityId(item)}:${String(item.since ?? '')}`;
}

// The console's "waiting on you" queue is humanAttention (web/app/status.js): only the
// kinds a person can actually answer, and only when the item points at a session.
// Everything else — unblocked-delivery failures, completions, stalls, daemon health —
// is a log entry, not a question. Keep this set in step with that file.
export const HUMAN_KINDS = new Set(['question', 'permission', 'plan', 'input']);

export function humanAttention(data) {
  return (data.attention || []).filter((item) => item.sessionId && HUMAN_KINDS.has(item.kind));
}

export function visibleQueue(items) {
  return items.filter((item) => !item.setAside);
}

export function kindLabel(kind) {
  return ({
    question: 'question', permission: 'permission', rateLimit: 'limit', complete: 'done',
    input: 'input', plan: 'plan', pinned: 'pinned', recent: 'recent',
  })[kind] || kind || 'session';
}

export function optionLabel(option) {
  return typeof option === 'string' ? option : option?.label || option?.description || String(option ?? '');
}

export function itemSummary(item, session) {
  return item.question || item.detail || session?.lastAssistant || session?.lastAssistantFull || 'Waiting for your input.';
}

export function sessionFor(data, item) {
  return (data.sessions || []).find((session) => session.id === item?.sessionId) || item?._session || null;
}

export function paneFor(data, item) {
  const paneId = item?.pane || item?._session?.pane || null;
  return paneId ? (data.panes || []).find((pane) => pane.id === paneId) || null : null;
}

// A session with no live host pane can be reopened: the daemon resumes the transcript
// in a fresh pane, the same thing the console's Reopen button and `keep open` do.
// `alive === true` without a pane means the agent is running in a plain terminal —
// resuming it there would corrupt the transcript, and the daemon refuses.
export function isClosedSession(data, item) {
  if (!item?.sessionId) return false;
  const session = sessionFor(data, item);
  if (session?.exited || session?.state === 'exited') return true;
  const pane = paneFor(data, item);
  if (pane?.alive) return false;
  return session?.alive !== true;
}

export function taskFor(data, item) {
  return (data.tasks || []).find((task) => task.id === item?.taskId) || item?._task || null;
}

function hydrate(data, item) {
  const session = sessionFor(data, item);
  return { ...item, pane: item.pane || session?.pane || null, _session: session, _task: taskFor(data, item) };
}

// A parked session is not a question, so it stays out of the queue the way it does on
// the console; Fleet lists it as `limit` and the session view offers Continue there.
export function queueItems(data, handled = new Set()) {
  return humanAttention(data)
    .map((item) => hydrate(data, { ...item }))
    .filter((item) => !handled.has(snoozeId(item)))
    .sort((a, b) => Number(a.pri || 0) - Number(b.pri || 0)
      || (timestamp(a.since) || 0) - (timestamp(b.since) || 0));
}

// The rate-limit row the console answers with Continue / Leave parked. The daemon keys
// its set-aside entry by session id, so dismissing one here matches `keep`'s own store.
export function rateLimitFor(data, item) {
  const session = sessionFor(data, item);
  if (!session?.rateLimit || session.reviewer) return null;
  return { ...session.rateLimit, key: session.id, setAside: data.setAside?.[session.id]?.kind || null };
}

function representedItems(items) {
  return {
    sessions: new Set(items.map((item) => item.sessionId).filter(Boolean)),
    panes: new Set(items.map((item) => item.pane).filter(Boolean)),
  };
}

export function sessionItem(kind, session) {
  return {
    kind,
    sessionId: session.id,
    pane: session.pane || null,
    project: session.project,
    title: session.title,
    taskId: session.taskId || undefined,
    since: kind === 'recent' ? session.lastUserAt : session.mtime,
    state: session.state,
    _session: session,
  };
}

export function pinnedItems(data, layouts, waiting = queueItems(data)) {
  const represented = representedItems(waiting);
  const pinned = (layouts || []).find((layout) => layout.role === 'pinned')
    || (layouts || []).find((layout) => layout.name === 'Pinned');
  const panes = new Map((data.panes || []).map((pane) => [pane.id, pane]));
  const byPane = new Map((data.sessions || []).filter((session) => session.pane).map((session) => [session.pane, session]));
  return (pinned?.ids || []).flatMap((pane) => {
    const hostPane = panes.get(pane);
    if (!hostPane) return [];
    const session = byPane.get(pane);
    if (!session) {
      return [{
        kind: 'pinned',
        pane,
        project: hostPane.meta?.project || hostPane.cwd,
        title: hostPane.meta?.title || hostPane.title || 'shell',
        state: hostPane.alive ? 'running' : 'exited',
      }];
    }
    if (represented.sessions.has(session.id) || represented.panes.has(pane)) return [];
    return [hydrate(data, sessionItem('pinned', session))];
  });
}

export function recentItems(data, waiting = queueItems(data), pinned = []) {
  const represented = representedItems([...waiting, ...pinned]);
  return (data.sessions || []).filter((session) =>
    !session.reviewer && session.lastUserAt != null && Number.isFinite(Number(session.lastUserAt))
      && !represented.sessions.has(session.id) && (!session.pane || !represented.panes.has(session.pane)))
    .sort((a, b) => Number(b.lastUserAt) - Number(a.lastUserAt))
    .map((session) => hydrate(data, sessionItem('recent', session)));
}

// Mirrors the console's knownProjects (web/app/app.js): every project a session or pane
// mentions, one entry per project, absolute paths preferred so a shell can be spawned there.
export function knownProjects(data) {
  const values = new Map();
  const add = (projectPath) => {
    if (!projectPath) return;
    const project = projectFor(projectPath);
    if (!values.has(project.key) || !values.get(project.key).path.startsWith('/')) values.set(project.key, project);
  };
  for (const session of data.sessions || []) add(session.project);
  for (const pane of data.panes || []) add(pane.meta?.project || pane.cwd);
  return [...values.values()].filter((project) => project.path.startsWith('/'))
    .sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
}

export function tagsFor(data, item) {
  return taskFor(data, item)?.fm?.tags || [];
}
