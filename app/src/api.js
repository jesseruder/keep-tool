import { configureProjects } from './model';
const { createStateCache, normalizeServer } = require('./state-cache');
const { screenHistoryPath } = require('./screen-history');
const stateCache = createStateCache();
export { normalizeServer };

export async function request(config, path, options = {}) {
  if (!config?.server || !config?.token) throw new Error('Server is not configured');
  const method = options.method || 'GET';
  const timeoutMs = options.timeoutMs ?? 10000;
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const headers = {
    'x-keep': '1',
    'x-keep-token': config.token,
  };
  if (method !== 'GET') headers['content-type'] = 'application/json';

  try {
    const response = await fetch(`${normalizeServer(config.server)}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = {};
    if (raw) {
      try { data = JSON.parse(raw); }
      catch { data = { error: raw }; }
    }
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status})`);
      error.screenTail = data.screenTail;
      throw error;
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted) {
      const abortError = new Error(timedOut
        ? `Request timed out after ${Math.round(timeoutMs / 1000)} seconds`
        : 'Request aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }
    if (error && Object.prototype.hasOwnProperty.call(error, 'screenTail')) throw error;
    throw new Error(error.message || 'Could not reach the server');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

export const getState = async (config, descriptor = { view: 'needs' }, options = {}) => {
  const result = await stateCache.load(config, descriptor, options);
  configureProjects(result.state);
  return result;
};
export const getNotifications = (config, options = {}) => stateCache.load(config, { view: 'notifications' }, options);
export const getLayouts = (config) => request(config, '/api/layouts');
// Terminals address either an agent session or a bare shell pane; `target` is
// { sessionId } or { pane }, and the daemon rejects the mixture of both.
export const send = (config, target, text) => request(config, '/api/send', {
  method: 'POST', body: { ...target, text },
});
export const screen = (config, target, lines = 60, signal) => request(
  config,
  target.pane && !target.sessionId
    ? `/api/screen?pane=${encodeURIComponent(target.pane)}&lines=${encodeURIComponent(lines)}`
    : `/api/screen?session=${encodeURIComponent(target.sessionId)}&lines=${encodeURIComponent(lines)}`,
  { signal, timeoutMs: 5000 },
);
export const screenHistory = (config, target, options = {}, signal) => request(
  config,
  screenHistoryPath(target, options),
  { signal, timeoutMs: 10000 },
);
export const keys = (config, target, names) => request(config, '/api/keys', {
  method: 'POST', body: { ...target, keys: names },
});
export const spawnShell = (config, cwd, name) => request(config, '/api/panes/spawn', {
  method: 'POST', body: { cwd, ...(name ? { name } : {}) }, timeoutMs: 30000,
});
export const answer = (config, sessionId, option, label) => request(config, '/api/answer', {
  method: 'POST', body: { sessionId, option, label },
});
export const ack = (config, item) => {
  const body = { kind: item.kind, since: item.since };
  if (item.id) body.id = item.id;
  else if (item.sessionId) body.sessionId = item.sessionId;
  else if (item.taskId) body.taskId = item.taskId;
  return request(config, '/api/ack', { method: 'POST', body });
};
export const setAside = (config, key, kind, minutes) => request(config, '/api/setaside', {
  method: 'POST', body: { key, kind, ...(minutes === undefined ? {} : { minutes }) },
});
// A fresh launch waits on the daemon's own budget: 45s for the agent prompt, up to
// 15s more for a Codex session id, plus the spawn and any opening message. A client
// timeout shorter than that reports failure for a launch that then succeeds, and the
// natural retry starts a second agent.
export const openSession = (config, body) => request(config, '/api/open', {
  method: 'POST', body, timeoutMs: 90000,
});
export const focus = (config, sessionId) => request(config, '/api/focus', {
  method: 'POST', body: { sessionId },
});
export const reviewTick = (config) => request(config, '/api/reviewtick', {
  method: 'POST', body: { force: true },
});
export const getSessionTail = (config, sessionId) => request(
  config,
  `/api/sessiontail?id=${encodeURIComponent(sessionId)}`,
);
export const getTask = async (config, taskId, options = {}) => {
  const result = await getState(config, { view: 'task', id: taskId }, options);
  if (!result.state.task) throw new Error('Card no longer exists');
  return result.state.task;
};
