'use strict';

function normalizeServer(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function stateViewKey(descriptor = {}) {
  const view = descriptor.view || 'needs';
  return descriptor.id ? `${view}:${descriptor.id}` : view;
}

function statePath(descriptor = {}) {
  const params = new URLSearchParams({ view: descriptor.view || 'needs' });
  if (descriptor.id) params.set('id', descriptor.id);
  return `/api/state?${params}`;
}

function createStateResultGate() {
  let activeKey = null;
  let latest = 0;
  return {
    activate(key) {
      if (key !== activeKey) {
        activeKey = key;
        latest += 1;
      }
    },
    begin(key) {
      latest += 1;
      return { key, sequence: latest };
    },
    accepts(ticket) {
      return Boolean(ticket && ticket.key === activeKey && ticket.sequence === latest);
    },
    key() { return activeKey; },
  };
}

function requiresNotificationPoll(descriptor) {
  return descriptor === null || ['session', 'new', 'task', 'terminal'].includes(descriptor?.view);
}

function nextQueueItem(items, current, handled, keyOf) {
  const source = Array.isArray(items) ? items : [];
  const currentKey = keyOf(current);
  const currentIndex = source.findIndex((item) => keyOf(item) === currentKey);
  if (currentIndex < 0) return source.find((item) => !item.setAside && !handled.has(keyOf(item))) || null;
  for (let offset = 1; offset <= source.length; offset += 1) {
    const candidate = source[(currentIndex + offset) % source.length];
    if (!candidate.setAside && !handled.has(keyOf(candidate))) return candidate;
  }
  return null;
}

function createStateCache(fetchImpl = (...args) => fetch(...args)) {
  const entries = new Map();
  const generations = new Map();

  async function load(config, descriptor = {}, options = {}) {
    if (!config?.server || !config?.token) throw new Error('Server is not configured');
    const viewKey = stateViewKey(descriptor);
    const cacheKey = `${normalizeServer(config.server)}\n${config.token}\n${viewKey}`;
    const cached = entries.get(cacheKey);
    const generation = (generations.get(cacheKey) || 0) + 1;
    generations.set(cacheKey, generation);
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs ?? 10000);

    const headers = { 'x-keep': '1', 'x-keep-token': config.token };
    if (cached?.etag) headers['if-none-match'] = cached.etag;
    try {
      const response = await fetchImpl(`${normalizeServer(config.server)}${statePath(descriptor)}`, {
        headers,
        signal: controller.signal,
      });
      if (response.status === 304) {
        if (!cached) throw new Error('Server returned 304 without a cached state');
        return { state: cached.state, etag: cached.etag, unchanged: true, key: viewKey };
      }
      const raw = await response.text();
      let state = {};
      if (raw) {
        try { state = JSON.parse(raw); }
        catch { state = { error: raw }; }
      }
      if (!response.ok) throw new Error(state.error || `Request failed (${response.status})`);
      const etag = response.headers.get('etag');
      if (generations.get(cacheKey) === generation) entries.set(cacheKey, { etag, state });
      return { state, etag, unchanged: false, key: viewKey };
    } catch (error) {
      if (controller.signal.aborted) {
        const abortError = new Error(timedOut
          ? `Request timed out after ${Math.round((options.timeoutMs ?? 10000) / 1000)} seconds`
          : 'Request aborted');
        abortError.name = 'AbortError';
        throw abortError;
      }
      throw new Error(error.message || 'Could not reach the server');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  return { load };
}

module.exports = {
  createStateCache,
  createStateResultGate,
  nextQueueItem,
  normalizeServer,
  requiresNotificationPoll,
  statePath,
  stateViewKey,
};
