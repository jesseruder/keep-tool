'use strict';

function createDashboardPublisher(options = {}) {
  if (typeof options.build !== 'function') throw new Error('dashboard publisher needs build');
  if (typeof options.publish !== 'function') throw new Error('dashboard publisher needs publish');
  const prepare = options.prepare || (() => ({}));
  const onError = options.onError || (() => {});
  const debounceMs = Math.max(0, Number(options.debounceMs ?? 100));
  const cadenceMs = Math.max(100, Number(options.cadenceMs ?? 30e3));
  let running = false;
  let dirty = false;
  let closed = false;
  let timer = null;
  let cadence = null;
  let latest = null;
  let version = 0;

  const clearDebounce = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const run = async () => {
    if (closed || running) return;
    clearDebounce();
    running = true;
    dirty = false;
    try {
      const input = await prepare();
      const value = await options.build(input);
      if (closed) return;
      latest = value;
      const generatedAt = Number(value?.state?.generatedAt) || Date.now();
      version = Math.max(version + 1, generatedAt);
      options.publish({ version, generatedAt, ...value });
    } catch (error) {
      if (!closed) onError(error);
    } finally {
      running = false;
      if (dirty && !closed) schedule(0);
    }
  };

  function schedule(delay = debounceMs) {
    if (closed) return;
    dirty = true;
    if (running || timer) return;
    timer = setTimeout(() => { timer = null; void run(); }, Math.max(0, delay));
    timer.unref?.();
  }

  cadence = setInterval(() => schedule(0), cadenceMs);
  cadence.unref?.();
  if (options.warmup !== false) schedule(0);

  return {
    invalidate: () => schedule(),
    refresh: () => { schedule(0); return running; },
    latest: () => latest,
    close() {
      if (closed) return;
      closed = true;
      clearDebounce();
      clearInterval(cadence);
    },
  };
}

module.exports = { createDashboardPublisher };
