'use strict';

function createDigestRefresh(options = {}) {
  const root = options.root;
  const health = options.health;
  const mutationProcess = options.mutationProcess;
  const restartGate = options.restartGate;
  const now = options.now || (() => new Date());
  const onChange = options.onChange || (() => {});
  const write = options.write || ((line) => process.stderr.write(line));
  let cachedDate = null;
  let cachedDigest = null;
  let running = null;
  let lastAttemptAt = 0;

  const today = () => {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    const pad = (part) => String(part).padStart(2, '0');
    return {
      date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      hour: date.getHours(),
      at: date.getTime(),
    };
  };

  async function refresh() {
    if (running) return running;
    const due = today();
    lastAttemptAt = due.at;
    const job = Promise.resolve().then(async () => {
      let leave = () => {};
      try {
        leave = restartGate?.enter?.() || leave;
        const result = await mutationProcess.run('ensure-digest', {
          root, today: due.date, createAllowed: due.hour >= 5,
        });
        const next = result?.md == null ? null : { date: result.date || due.date, md: result.md };
        const changed = cachedDate !== due.date || cachedDigest?.md !== next?.md;
        cachedDate = due.date;
        cachedDigest = next;
        const detail = result?.detail || (next ? 'exists' : 'nothing due');
        health.record('digest', { ok: true, ...(next ? {} : { skipped: true }), detail });
        if (changed) onChange();
        return cachedDigest;
      } catch (error) {
        health.record('digest', { ok: false, error });
        write(`keep serve: digest failed: ${error.message}\n`);
        return cachedDate === due.date ? cachedDigest : null;
      } finally {
        leave();
      }
    });
    running = job;
    try { return await job; }
    finally { if (running === job) running = null; }
  }

  function snapshot() {
    const due = today();
    if (cachedDate !== due.date && !running) void refresh();
    else if (!running && cachedDigest === null && due.at - lastAttemptAt >= 60e3) void refresh();
    return cachedDate === due.date ? cachedDigest : null;
  }

  return { refresh, snapshot, get running() { return Boolean(running); } };
}

module.exports = { createDigestRefresh };
