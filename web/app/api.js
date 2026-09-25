import './shared/state-delta.js';

const { applyConsoleDelta } = globalThis.KeepStateDelta;
const WRITE_HEADERS = { 'content-type': 'application/json' };
const STATE_MUTATIONS = new Set([
  '/api/abandon-account-handoff', '/api/abandon-transfer', '/api/ack', '/api/add', '/api/answer', '/api/checkin',
  '/api/close-idle', '/api/close-session', '/api/compact', '/api/decisions/judge',
  '/api/handoff-queue-cancel', '/api/handoff-rate-limited', '/api/handoff-session', '/api/inbox-card',
  '/api/mark-session', '/api/move-session', '/api/notifications', '/api/open', '/api/panes/spawn',
  '/api/portable-transfers', '/api/reminders', '/api/rename-session', '/api/reopen-session',
  '/api/resolve-portable-transfer', '/api/restart-daemon', '/api/restart-session', '/api/review-queue',
  '/api/reviewtick', '/api/run', '/api/send', '/api/session-keep-running', '/api/setaside', '/api/transfer-session',
  '/api/secrets/fulfill', '/api/secrets/decline',
]);
let stateAfterMutation = '';
let observedMutationFence = '';
let unauthorizedPostedAt = 0;
let authenticatedPosted = false;

// Sniffed rather than imported so this module keeps working without a DOM.
function postShell(message) {
  if (!globalThis.window?.keepShell) return false;
  try { window.keepShell.post(message); } catch { return false; }
  return true;
}

// The mobile shell's session cookie can outlive the worker that issued it (they
// are in memory only). A 403 is how the page learns that; the shell answers by
// re-running its /app?token= bootstrap.
function reportUnauthorized() {
  const now = Date.now();
  if (now - unauthorizedPostedAt < 10e3) return;
  if (postShell({ type: 'unauthorized' })) unauthorizedPostedAt = now;
}

// The first state this page actually receives. The shell bounds its bootstrap
// loop on this rather than on `ready`, which says only that the console asked.
function reportAuthenticated() {
  if (authenticatedPosted) return;
  if (postShell({ type: 'authenticated' })) authenticatedPosted = true;
}

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

function stateMutation(pathname, method) {
  return (method || 'GET') !== 'GET'
    && (STATE_MUTATIONS.has(pathname) || /^\/api\/panes\/[^/]+\/(?:kill|remove)$/.test(pathname)
      || /^\/api\/agents\/[^/]+\/seen$/.test(pathname));
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
    if (response.status === 403) reportUnauthorized();
    // A refusal that still changed state (a move journalled as recovery-needed) carries
    // a fence too: the reload after it waits for a state built after the change.
    const refusedFence = response.headers.get('x-keep-mutation-fence') || '';
    if (refusedFence && stateMutation(pathname, options.method)) rememberMutationFence(refusedFence, observedFenceAtStart);
    const error = new Error(body?.error || text || `${response.status} ${response.statusText}`);
    error.status = response.status;
    error.body = body;
    // A starting daemon answers these until its first dashboard build is published.
    error.transient = response.status === 503
      && ['dashboard state is still loading', 'dashboard state refresh is pending'].includes(body?.error);
    throw error;
  }
  if (pathname === '/api/state') reportAuthenticated();
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
  else if (stateMutation(pathname, options.method) && fence) rememberMutationFence(fence, observedFenceAtStart);
  return body;
}

let stateRequest;
let queuedStateRequest;

// The snapshot the console already holds, kept pristine:
// `{ instance, version, state, fetchedAt }`. The worker answers
// `since=<instance>:<version>` with the deltas back to it, and falls back to a full
// envelope whenever it cannot name that chain.
let stateCache = null;
// However well the chain holds, an applicable-but-wrong delta would live in the tab
// forever. A snapshot this old is retired and rebuilt from a full projection.
const STATE_CACHE_MAX_AGE_MS = 30 * 60 * 1000;

async function fetchState() {
  if (stateCache && Date.now() - stateCache.fetchedAt >= STATE_CACHE_MAX_AGE_MS) stateCache = null;
  const cached = stateCache;
  const since = cached ? `&since=${encodeURIComponent(`${cached.instance}:${cached.version}`)}` : '';
  const state = await absorbState(await freshRequest(`/api/state?console=1&delta=1${since}`), cached);
  // app.js reassigns `data` and edits its lists in place (spawned panes, dropped
  // panes, detail reconciliation), so the cached base must never be what it holds.
  return stateCache ? structuredClone(state) : state;
}

function adoptFull(body) {
  stateCache = { instance: body.instance, version: body.version, state: body.full, fetchedAt: Date.now() };
  return body.full;
}

// A fixture — or the daemon's own /api/state, which never learned `since` — can serve
// the bare console projection. Treat it as a one-off snapshot with no delta channel.
async function absorbState(body, cached) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) { stateCache = null; return body; }
  if (Object.hasOwn(body, 'full')) return adoptFull(body);
  if (!Object.hasOwn(body, 'deltas')) { stateCache = null; return body; }
  if (!cached || body.instance !== cached.instance || body.since !== cached.version) return refetchFull();
  let next;
  try {
    next = (body.deltas || []).reduce((state, delta) => applyConsoleDelta(state, delta), cached.state);
  } catch (error) {
    return refetchFull(error);
  }
  // fetchedAt stays the base snapshot's: the age that matters is how long the
  // console has gone without a projection it did not derive.
  stateCache = { instance: cached.instance, version: body.version, state: next, fetchedAt: cached.fetchedAt };
  return next;
}

// One retry without `since`; if that still answers with deltas the console has no
// base to apply them to, so surface the failure rather than render a stale list.
async function refetchFull(cause) {
  stateCache = null;
  const body = await freshRequest('/api/state?console=1&delta=1');
  if (body && typeof body === 'object' && Object.hasOwn(body, 'full')) return adoptFull(body);
  if (body && typeof body === 'object' && Object.hasOwn(body, 'deltas')) {
    throw cause || new Error('dashboard state deltas arrived without a base snapshot');
  }
  return body;
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
export const getCardPicture = (id) => request(`/api/card-picture?id=${encodeURIComponent(id)}`);
export const getDashboardDetail = (kind, id) => request(`/api/dashboard-detail?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`);
// Resolves null when a newer search (from any console) replaced this one.
export const searchSessionText = (query) => request(`/api/session-text-search?q=${encodeURIComponent(query)}`)
  .then((body) => (body?.superseded ? null : body?.results || []));
export const searchDashboardReviews = (query) => request(`/api/dashboard-review-search?q=${encodeURIComponent(query)}`);
export const getPortableTransfers = () => freshRequest('/api/portable-transfers');
export const getPortableTransferDraft = (sessionId) => request(`/api/portable-transfer-draft?session=${encodeURIComponent(sessionId)}`);
export const getPortableTransferPreview = (transferId) => request(`/api/portable-transfer-preview?id=${encodeURIComponent(transferId)}`);
export const preparePortableTransfer = (body) => write('/api/portable-transfers', body, 'POST', { label: 'Preparing transfer' });
export const launchPortableTransfer = (transferId) => write('/api/transfer-session', { transferId }, 'POST', { label: 'Launching transfer' });
export const resolvePortableTransfer = (transferId, destinationSessionId) => write('/api/resolve-portable-transfer', { transferId, destinationSessionId }, 'POST', { label: 'Resolving transfer' });
export const abandonAccountHandoff = (sessionId, pane, transactionId) => write('/api/abandon-account-handoff', { sessionId, pane, transactionId }, 'POST', { label: 'Abandoning handoff' });
export const getAgentEvents = (name, limit = 20) => request(`/api/agents/${encodeURIComponent(name)}/events?limit=${encodeURIComponent(limit)}`);
export const getCardArtifacts = (card) => request(`/api/card-artifacts?card=${encodeURIComponent(card)}`);
// One artifact's bytes, as a Blob. Fetched with the x-keep header like every other
// request rather than put in an <img src>: a browser session's cookie alone reaches
// only the console's own files (ui-request-server COOKIE_OPEN_PATHS), and the header
// is what keeps a cross-site page from reading anything else.
export async function fetchCardArtifact(card, name) {
  let response;
  try {
    response = await fetch(`/api/card-artifact?card=${encodeURIComponent(card)}&name=${encodeURIComponent(name)}`, { headers: { 'x-keep': '1' } });
  } catch (error) {
    if (error && typeof error === 'object') error.transient = true;
    throw error;
  }
  if (!response.ok) {
    if (response.status === 403) reportUnauthorized();
    let message = `${response.status} ${response.statusText}`;
    try { message = (await response.json()).error || message; } catch {}
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response.blob();
}
export const markAgentSeen = (name) => write(`/api/agents/${encodeURIComponent(name)}/seen`, {}, 'POST', { label: 'Marking agent seen', background: true });

// Every write is registered while it is in flight, so the header can say what the
// console is waiting on rather than leaving a disabled button with no explanation.
// A write that never answers used to hang forever: the daemon under load answers in
// seconds, and sometimes not at all, so each one carries its own deadline.
const DEFAULT_WRITE_TIMEOUT_MS = 20000;
const OPEN_TIMEOUT_MS = 60000;
const inFlightWrites = new Map();
const pendingListeners = new Set();
let writeSequence = 0;
let failureSequence = 0;
let writeFailureRecord = null;

function notifyPending() {
  for (const listener of [...pendingListeners]) { try { listener(); } catch {} }
}

// '/api/close-session' -> 'Close session'. Only a fallback: a call site that names
// its action ({ label: 'Closing session' }) gets a sentence a person would write.
function labelForUrl(url) {
  const path = String(url).split('?')[0].replace(/^\/api\//, '').replace(/\/$/, '');
  const words = path.split('/').filter(Boolean).join(' ').replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Request';
}

export function pendingWrites() {
  return [...inFlightWrites.values()].map((record) => ({ ...record }));
}

export function onPendingChange(listener) {
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
}

export function lastWriteFailure() {
  return writeFailureRecord ? { ...writeFailureRecord } : null;
}

export function dismissWriteFailure(id) {
  if (!writeFailureRecord || (id != null && writeFailureRecord.id !== id)) return false;
  writeFailureRecord = null;
  notifyPending();
  return true;
}

// UI helpers add the retry closure and, for optimistic actions, an explanation
// of what was restored. The request error keeps the id so this updates the same
// failure instead of briefly publishing two alerts for one click.
export function reportWriteFailure(error, { label, message, retry } = {}) {
  const existing = writeFailureRecord?.id === error?.writeFailureId ? writeFailureRecord : null;
  writeFailureRecord = {
    id: existing?.id || ++failureSequence,
    at: existing?.at || Date.now(),
    label: existing?.label || label || 'Action failed',
    message: message || existing?.message || error?.message || String(error),
    retry: retry || existing?.retry || null,
  };
  if (error && typeof error === 'object') error.writeFailureId = writeFailureRecord.id;
  notifyPending();
  return writeFailureRecord;
}

// `background` writes are the console's own housekeeping (project icons, a badge
// cleared on open): nobody clicked them, so they neither show in the chip as an
// action in flight nor leave a sticky failure behind; they keep the deadline.
async function trackedWrite(url, options, { label, timeoutMs = DEFAULT_WRITE_TIMEOUT_MS, retry, background = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const record = { id: `write-${++writeSequence}`, label: label || labelForUrl(url), url, startedAt: Date.now() };
  if (!background) {
    inFlightWrites.set(record.id, record);
    notifyPending();
  }
  try {
    const body = await request(url, { ...options, signal: controller.signal });
    // The same action succeeding is what retires its sticky failure; anything else
    // leaves it standing, because nobody has shown that this write works again.
    if (!background && writeFailureRecord?.label === record.label) writeFailureRecord = null;
    return body;
  } catch (error) {
    if (controller.signal.aborted) {
      const timeout = new Error(`${record.label} timed out after ${timeoutMs / 1000} s`
        + ' — the daemon may still be doing it');
      timeout.transient = true;
      timeout.timeout = true;
      if (background) throw timeout;
      writeFailureRecord = { id: ++failureSequence, at: Date.now(), label: record.label, message: timeout.message, retry: retry || null };
      timeout.writeFailureId = writeFailureRecord.id;
      throw timeout;
    }
    if (background) throw error;
    writeFailureRecord = { id: ++failureSequence, at: Date.now(), label: record.label,
      message: error?.message || String(error), retry: retry || null };
    if (error && typeof error === 'object') error.writeFailureId = writeFailureRecord.id;
    throw error;
  } finally {
    clearTimeout(timer);
    if (!background) {
      inFlightWrites.delete(record.id);
      notifyPending();
    }
  }
}

export function write(url, body, method = 'POST', options = {}) {
  return trackedWrite(url, { method, headers: WRITE_HEADERS, body: JSON.stringify(body || {}) }, options);
}

// Opening a session starts an agent process: it is slow by nature, so it keeps the
// minute it always had rather than the ordinary write deadline.
export function openSession(body) {
  return trackedWrite('/api/open', { method: 'POST', headers: WRITE_HEADERS, body: JSON.stringify(body || {}) },
    { label: 'Opening session', timeoutMs: OPEN_TIMEOUT_MS });
}
export const reopenSession = (body) => write('/api/reopen-session', body, 'POST', { label: 'Opening session' });

export async function putLayouts(layouts) {
  await write('/api/layouts', { layouts }, 'PUT', { label: 'Saving layout' });
  return getLayouts();
}
export const send = (sessionId, text) => write('/api/send', { sessionId, text }, 'POST', { label: 'Sending' });
export const answer = (sessionId, option, label) => write('/api/answer', { sessionId, option, label }, 'POST', { label: 'Answering' });
export const closeInboxCard = (id, action) => write('/api/inbox-card', { id, action }, 'POST', { label: 'Closing card' });
export const setAside = (key, kind, minutes) => write('/api/setaside', {
  key, kind, ...(minutes === undefined ? {} : { minutes }),
}, 'POST', { label: kind === 'clear' ? 'Restoring' : 'Setting aside' });
// An empty title clears the hand-typed name and restores automatic titling.
export const renameSession = (sessionId, title) => write('/api/rename-session', { sessionId, title }, 'POST', { label: 'Renaming' });
// A patch: an absent key is left alone, null or '' removes that half of the mark.
export const markSession = (sessionId, patch) => write('/api/mark-session', { sessionId, ...patch }, 'POST', { label: 'Marking' });
export const setSessionKeepRunning = (sessionId, keepRunning) => write('/api/session-keep-running', { sessionId, keepRunning }, 'POST', { label: 'Automatic close' });
export const spawnPane = (cwd, name) => write('/api/panes/spawn', { cwd, name }, 'POST', { label: 'Opening shell' });
export const killPane = (pane) => write(`/api/panes/${encodeURIComponent(pane)}/kill`, {}, 'POST', { label: 'Closing pane' });
export const removePane = (pane) => write(`/api/panes/${encodeURIComponent(pane)}/remove`, {}, 'POST', { label: 'Removing pane' });
export const reviewTick = () => write('/api/reviewtick', { force: true }, 'POST', { label: 'Reviewer tick' });

export function subscribe(onChange, onStatus, onFocus, timers = globalThis) {
  const events = new EventSource('/api/events');
  events.onopen = () => onStatus?.('live');
  events.onerror = () => onStatus?.('reconnecting');
  events.onmessage = () => onChange();
  events.addEventListener('focus', (event) => onFocus?.(String(event.data || '')));
  const poll = timers.setInterval(onChange, 30000);
  return () => { timers.clearInterval(poll); events.close(); };
}
