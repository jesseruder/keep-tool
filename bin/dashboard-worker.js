'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

class DashboardWorkerError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DashboardWorkerError';
    this.status = 503;
  }
}

function createDashboardWorker(options = {}) {
  const WorkerClass = options.Worker || Worker;
  const workerFile = options.workerFile || path.join(__dirname, 'dashboard-build-worker.js');
  const prepare = options.prepare || (async (input) => input);
  const finalize = options.finalize || (async (result) => result);
  const maxQueued = Math.max(1, Number(options.maxQueued) || 8);
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || 60e3);
  const queued = new Map();
  let worker = null;
  let generation = 0;
  let nextId = 1;
  let active = null;
  let closed = false;
  let latest = null;
  let invalidationVersion = 0;

  const keyFor = options.keyFor || ((input) => JSON.stringify(input));

  function rejectJob(job, error) {
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    for (const waiter of job.waiters) waiter.reject(error);
  }

  function failWorker(error, failedWorker = worker) {
    if (failedWorker !== worker) return;
    worker = null;
    generation++;
    if (active && active.phase !== 'finalizing') {
      const job = active;
      active = null;
      rejectJob(job, error instanceof DashboardWorkerError ? error
        : new DashboardWorkerError(`dashboard worker failed: ${error.message || error}`, error));
    }
    if (!closed) queueMicrotask(pump);
  }

  function spawnWorker() {
    if (worker || closed) return worker;
    const instance = new WorkerClass(workerFile, { workerData: options.workerData });
    const ownGeneration = ++generation;
    worker = instance;
    instance.on('message', (message) => {
      if (worker !== instance || ownGeneration !== generation || !active || message?.id !== active.id) return;
      const job = active;
      if (job.timer) clearTimeout(job.timer);
      job.phase = 'finalizing';
      Promise.resolve().then(() => {
        if (message.error) throw new DashboardWorkerError(`dashboard build failed: ${message.error.message || message.error}`);
        return finalize(message.result, job.input);
      })
        .then((value) => {
          if (closed || active !== job || job.settled) return;
          job.settled = true;
          latest = value;
          for (const waiter of job.waiters) waiter.resolve(value);
        }, (error) => {
          if (!job.settled) rejectJob(job, error instanceof DashboardWorkerError ? error
            : new DashboardWorkerError(`dashboard result finalization failed: ${error.message || error}`, error));
        })
        .finally(() => { if (active === job) active = null; pump(); });
    });
    instance.on('error', (error) => failWorker(error, instance));
    instance.on('exit', (code) => {
      if (worker !== instance) return;
      failWorker(new DashboardWorkerError(`dashboard worker exited ${code}`), instance);
    });
    return instance;
  }

  async function pump() {
    if (closed || active || !queued.size) return;
    const [key, job] = queued.entries().next().value;
    queued.delete(key);
    job.id = nextId++;
    active = job;
    try {
      const input = await prepare(job.input);
      if (closed || active !== job) return;
      spawnWorker().postMessage({ id: job.id, input });
      job.phase = 'building';
      job.timer = setTimeout(() => {
        if (active !== job || job.phase !== 'building') return;
        const instance = worker;
        failWorker(new DashboardWorkerError(`dashboard build timed out after ${timeoutMs}ms`), instance);
        instance?.terminate().catch(() => {});
      }, timeoutMs);
      job.timer.unref?.();
    } catch (error) {
      if (active === job) active = null;
      rejectJob(job, error instanceof DashboardWorkerError ? error
        : new DashboardWorkerError(`dashboard build preparation failed: ${error.message || error}`, error));
      queueMicrotask(pump);
    }
  }

  function build(input) {
    if (closed) return Promise.reject(new DashboardWorkerError('dashboard worker is closed'));
    let key;
    try { key = `${invalidationVersion}:${keyFor(input)}`; }
    catch (error) { return Promise.reject(new DashboardWorkerError(`dashboard input is not serializable: ${error.message}`, error)); }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      if (active?.key === key && !active.settled && active.phase !== 'finalizing') {
        active.waiters.push(waiter);
        return;
      }
      const existing = queued.get(key);
      if (existing) {
        existing.waiters.push(waiter);
        return;
      }
      if (queued.size >= maxQueued) {
        reject(new DashboardWorkerError('dashboard worker queue is full'));
        return;
      }
      queued.set(key, { key, input, waiters: [waiter], id: null });
      queueMicrotask(pump);
    });
  }

  function invalidate(change) {
    invalidationVersion++;
    try { worker?.postMessage({ type: 'invalidate', change }); } catch {}
  }

  function close() {
    if (closed) return;
    closed = true;
    const error = new DashboardWorkerError('dashboard worker is closed');
    if (active) { rejectJob(active, error); active = null; }
    for (const job of queued.values()) rejectJob(job, error);
    queued.clear();
    const instance = worker;
    worker = null;
    generation++;
    instance?.terminate().catch(() => {});
  }

  return { build, close, invalidate, latest: () => latest };
}

module.exports = { createDashboardWorker, DashboardWorkerError };
