// The console itself talks to the daemon from inside the WebView, with the
// `keep-token` cookie the `?token=` bootstrap sets. What is left here is what the
// native shell still does on its own: the setup check, the background sweep's
// server address, and the fallback terminal viewer.
const { normalizeServer } = require('./bridge');
const { screenHistoryPath } = require('./screen-history');
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

// Setup's connection check: the smallest state view there is, so an address typo or
// a stale token fails here rather than as a blank WebView.
export const ping = (config) => request(config, '/api/state?view=notifications');

// Push registration. The body is `{ expoPushToken, platform, name, appVersion }`;
// the daemon keys devices by the token, so re-registering the same one refreshes it
// rather than adding a row. `src/push.js` decides when either of these runs.
export const registerDevice = (config, body) => request(config, '/api/devices', {
  method: 'POST', body, timeoutMs: 8000,
});
export const unregisterDevice = (config, expoPushToken) => request(config, '/api/devices', {
  method: 'DELETE', body: { expoPushToken }, timeoutMs: 8000,
});
// Every device the daemon holds, each masked down to its token's last six
// characters — enough for this phone to tell whether it is still on the list.
export const listDevices = (config) => request(config, '/api/devices', { timeoutMs: 8000 });

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

// The native terminal attaches to a pane, not to a session, so a target that names
// only a session has to be resolved first. The `terminal` projection answers for
// either id: it takes a session id or a pane id and returns the pane behind it.
export const terminalView = (config, id, signal) => request(
  config,
  `/api/state?view=terminal&id=${encodeURIComponent(id)}`,
  { signal, timeoutMs: 8000 },
);

// What the native terminal's tappable references can name (src/terminal/refs.js),
// and what a tapped one's sheet loads: the same lookups as the console's hover cards.
export const refsView = (config, signal) => request(config, '/api/state?view=refs', { signal, timeoutMs: 10000 });
export const holds = (config, signal) => request(config, '/api/holds', { signal, timeoutMs: 8000 })
  .then((body) => body?.holds || []);
export const sessionMentions = (config, num) => request(config, `/api/session-mentions?num=${encodeURIComponent(num)}`, { timeoutMs: 8000 })
  .then((body) => (body?.superseded ? undefined : { sessions: body?.sessions || [], cards: body?.cards || [] }));
export const commitInfo = (config, sha, project) => request(config,
  `/api/commit-info?sha=${encodeURIComponent(sha)}${project ? `&project=${encodeURIComponent(project)}` : ''}`, { timeoutMs: 8000 })
  .then((body) => body?.info || null);
export const cardDetail = (config, id) => request(config, `/api/dashboard-detail?kind=task&id=${encodeURIComponent(id)}`, { timeoutMs: 8000 })
  .then((body) => body?.value || null);

// "Open on Mac": the console on the desktop brings this session's terminal forward.
export const focus = (config, sessionId) => request(config, '/api/focus', {
  method: 'POST', body: { sessionId },
});
