const WRITE_HEADERS = { 'content-type': 'application/json' };

// Read routes that expose session or handoff detail demand the header too — it forces
// a CORS preflight, so a hostile page cannot reach them. Sending it on every request
// keeps a newly guarded GET from 403ing the whole dashboard reload.
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'x-keep': '1', ...options.headers } });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const error = new Error(body?.error || text || `${response.status} ${response.statusText}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

let stateRequest;
let queuedStateRequest;

async function fetchState() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try { return await request('/api/state?compact=1', { signal: controller.signal }); }
  catch (error) {
    if (controller.signal.aborted) throw new Error('State refresh timed out after 10 seconds');
    throw error;
  } finally { clearTimeout(timer); }
}

export function getState() {
  if (stateRequest) {
    if (!queuedStateRequest) {
      let resolve;
      let reject;
      const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
      queuedStateRequest = { promise, resolve, reject };
    }
    return queuedStateRequest.promise;
  }
  stateRequest = fetchState().finally(() => {
    stateRequest = null;
    if (!queuedStateRequest) return;
    const queued = queuedStateRequest;
    queuedStateRequest = null;
    getState().then(queued.resolve, queued.reject);
  });
  return stateRequest;
}
export const getLayouts = () => request('/api/layouts');
export const getSessionSummary = (id) => request(`/api/sessionsummary?id=${encodeURIComponent(id)}`);
export const getPortableTransfers = () => request('/api/portable-transfers');
export const getPortableTransferDraft = (sessionId) => request(`/api/portable-transfer-draft?session=${encodeURIComponent(sessionId)}`);
export const getPortableTransferPreview = (transferId) => request(`/api/portable-transfer-preview?id=${encodeURIComponent(transferId)}`);
export const preparePortableTransfer = (body) => write('/api/portable-transfers', body);
export const launchPortableTransfer = (transferId) => write('/api/transfer-session', { transferId });
export const resolvePortableTransfer = (transferId, destinationSessionId) => write('/api/resolve-portable-transfer', { transferId, destinationSessionId });

export function write(url, body, method = 'POST') {
  return request(url, { method, headers: WRITE_HEADERS, body: JSON.stringify(body || {}) });
}

export async function openSession(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    return await request('/api/open', {
      method: 'POST', headers: WRITE_HEADERS, body: JSON.stringify(body || {}), signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Open timed out after 60 seconds');
    throw error;
  } finally { clearTimeout(timer); }
}

export async function putLayouts(layouts) {
  await write('/api/layouts', { layouts }, 'PUT');
  return getLayouts();
}
export const send = (sessionId, text) => write('/api/send', { sessionId, text });
export const answer = (sessionId, option, label) => write('/api/answer', { sessionId, option, label });
export const setAside = (key, kind, minutes) => write('/api/setaside', {
  key, kind, ...(minutes === undefined ? {} : { minutes }),
});
export const spawnPane = (cwd, name) => write('/api/panes/spawn', { cwd, name });
export const killPane = (pane) => write(`/api/panes/${encodeURIComponent(pane)}/kill`);
export const removePane = (pane) => write(`/api/panes/${encodeURIComponent(pane)}/remove`);
export const reviewTick = () => write('/api/reviewtick', { force: true });

export function subscribe(onChange, onStatus, onFocus, timers = globalThis) {
  const events = new EventSource('/api/events');
  events.onopen = () => onStatus?.('live');
  events.onerror = () => onStatus?.('reconnecting');
  events.onmessage = () => onChange();
  events.addEventListener('focus', (event) => onFocus?.(String(event.data || '')));
  const poll = timers.setInterval(onChange, 30000);
  return () => { timers.clearInterval(poll); events.close(); };
}
