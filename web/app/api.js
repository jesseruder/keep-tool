const WRITE_HEADERS = { 'content-type': 'application/json' };
const STATE_MUTATIONS = new Set([
  '/api/abandon-account-handoff', '/api/ack', '/api/add', '/api/answer', '/api/checkin',
  '/api/close-idle', '/api/close-session', '/api/compact', '/api/decisions/judge',
  '/api/handoff-session', '/api/notifications', '/api/open', '/api/panes/spawn',
  '/api/portable-transfers', '/api/reminders', '/api/rename-session', '/api/reopen-session',
  '/api/resolve-portable-transfer', '/api/restart-daemon', '/api/restart-session', '/api/review-queue',
  '/api/reviewtick', '/api/run', '/api/send', '/api/setaside', '/api/transfer-session',
]);
let stateAfterMutation = '';
let observedMutationFence = '';

function rememberMutationFence(fence, observedAtStart) {
  const [epoch, sequenceText] = String(fence || '').split(':');
  const sequence = Number(sequenceText);
  if (!epoch || !Number.isSafeInteger(sequence)) return;
  const [currentEpoch, currentSequenceText] = observedMutationFence.split(':');
  const currentSequence = Number(currentSequenceText);
  const [observedEpochAtStart] = String(observedAtStart || '').split(':');
  const mayChangeEpoch = !observedMutationFence || currentEpoch === observedEpochAtStart;
  if ((epoch === currentEpoch && (!Number.isSafeInteger(currentSequence) || sequence > currentSequence))
      || (epoch !== currentEpoch && mayChangeEpoch)) {
    observedMutationFence = `${epoch}:${sequence}`;
    stateAfterMutation = observedMutationFence;
  }
}

// Read routes that expose session or handoff detail demand the header too — it forces
// a CORS preflight, so a hostile page cannot reach them. Sending it on every request
// keeps a newly guarded GET from 403ing the whole dashboard reload.
async function request(url, options = {}) {
  const pathname = new URL(url, location.origin).pathname;
  const requiredFence = stateAfterMutation;
  const observedFenceAtStart = observedMutationFence;
  const headers = { 'x-keep': '1', ...options.headers };
  if ((pathname === '/api/state' || pathname === '/api/portable-transfers') && requiredFence) {
    headers['x-keep-after-mutation'] = requiredFence;
  }
  let response;
  let text;
  try {
    response = await fetch(url, { ...options, headers });
    text = await response.text();
  } catch (error) {
    // The daemon is unreachable (refused, dropped, aborted): a restart looks like this.
    if (error && typeof error === 'object') error.transient = true;
    throw error;
  }
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const error = new Error(body?.error || text || `${response.status} ${response.statusText}`);
    error.status = response.status;
    error.body = body;
    // A starting daemon answers these until its first dashboard build is published.
    error.transient = response.status === 503
      && ['dashboard state is still loading', 'dashboard state refresh is pending'].includes(body?.error);
    throw error;
  }
  const fence = response.headers.get('x-keep-mutation-fence') || '';
  if (pathname === '/api/state' || pathname === '/api/portable-transfers') {
    const [publishedEpoch, publishedSequenceText] = fence.split(':');
    const latestRequired = observedMutationFence;
    const [requiredEpoch, requiredSequenceText] = latestRequired.split(':');
    const publishedSequence = Number(publishedSequenceText);
    const requiredSequence = Number(requiredSequenceText);
    const [sentEpoch] = requiredFence.split(':');
    const restarted = Boolean(publishedEpoch && publishedEpoch !== requiredEpoch
      && observedMutationFence === observedFenceAtStart
      && (!requiredFence || sentEpoch === requiredEpoch));
    const satisfied = !latestRequired || restarted
      || (publishedEpoch === requiredEpoch && Number.isSafeInteger(publishedSequence)
        && Number.isSafeInteger(requiredSequence) && publishedSequence >= requiredSequence);
    if (!satisfied) {
      const error = new Error('dashboard state refresh is pending');
      error.status = 503;
      error.body = { error: error.message };
      throw error;
    }
    if (!observedMutationFence || restarted) observedMutationFence = fence;
    if (pathname === '/api/state' && (!stateAfterMutation || stateAfterMutation === latestRequired || restarted)) {
      stateAfterMutation = '';
    }
  }
  else if ((options.method || 'GET') !== 'GET'
      && (STATE_MUTATIONS.has(pathname) || /^\/api\/panes\/[^/]+\/(?:kill|remove)$/.test(pathname)
        || /^\/api\/agents\/[^/]+\/seen$/.test(pathname))
      && fence) rememberMutationFence(fence, observedFenceAtStart);
  return body;
}

let stateRequest;
let queuedStateRequest;

async function fetchState() {
  return freshRequest('/api/state?summary=1');
}

async function freshRequest(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    while (true) {
      try { return await request(url, { signal: controller.signal }); }
      catch (error) {
        if (controller.signal.aborted || error.status !== 503
            || error.body?.error !== 'dashboard state refresh is pending') throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  catch (error) {
    if (controller.signal.aborted) {
      const timeout = new Error('State refresh timed out after 10 seconds');
      timeout.transient = true;
      throw timeout;
    }
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
export const getDashboardDetail = (kind, id) => request(`/api/dashboard-detail?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`);
export const searchDashboardReviews = (query) => request(`/api/dashboard-review-search?q=${encodeURIComponent(query)}`);
export const getPendingDecisions = (sessionId) => request(`/api/decisions?session=${encodeURIComponent(sessionId)}&pending=1`);
export const judgeDecision = (id, verdict, message) => write('/api/decisions/judge', { id, verdict, message });
export const getPortableTransfers = () => freshRequest('/api/portable-transfers');
export const getPortableTransferDraft = (sessionId) => request(`/api/portable-transfer-draft?session=${encodeURIComponent(sessionId)}`);
export const getPortableTransferPreview = (transferId) => request(`/api/portable-transfer-preview?id=${encodeURIComponent(transferId)}`);
export const preparePortableTransfer = (body) => write('/api/portable-transfers', body);
export const launchPortableTransfer = (transferId) => write('/api/transfer-session', { transferId });
export const resolvePortableTransfer = (transferId, destinationSessionId) => write('/api/resolve-portable-transfer', { transferId, destinationSessionId });
export const abandonAccountHandoff = (sessionId, pane, transactionId) => write('/api/abandon-account-handoff', { sessionId, pane, transactionId });
export const getAgentEvents = (name, limit = 20) => request(`/api/agents/${encodeURIComponent(name)}/events?limit=${encodeURIComponent(limit)}`);
export const markAgentSeen = (name) => write(`/api/agents/${encodeURIComponent(name)}/seen`);

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
export const reopenSession = (body) => write('/api/reopen-session', body);

export async function putLayouts(layouts) {
  await write('/api/layouts', { layouts }, 'PUT');
  return getLayouts();
}
export const send = (sessionId, text) => write('/api/send', { sessionId, text });
export const answer = (sessionId, option, label) => write('/api/answer', { sessionId, option, label });
export const setAside = (key, kind, minutes) => write('/api/setaside', {
  key, kind, ...(minutes === undefined ? {} : { minutes }),
});
// An empty title clears the hand-typed name and restores automatic titling.
export const renameSession = (sessionId, title) => write('/api/rename-session', { sessionId, title });
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
