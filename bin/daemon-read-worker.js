'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

class DaemonReadWorkerError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DaemonReadWorkerError';
    this.status = 503;
  }
}

// A deliberately small RPC boundary for filesystem discovery that is too broad to
// run on the daemon event loop.  The child owns no daemon authority: it returns
// observations, and callers perform their mutation-time checks in the main process.
function createDaemonReadWorker(options = {}) {
  const WorkerClass = options.Worker || Worker;
  const workerFile = options.workerFile || path.join(__dirname, 'daemon-read-worker-child.js');
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || 90e3);
  const maxQueued = Math.max(1, Number(options.maxQueued) || 32);
  let worker = null;
  let generation = 0;
  let nextId = 1;
  let active = null;
  let closed = false;
  const queued = new Map();

  function error(message, cause) {
    return cause instanceof DaemonReadWorkerError ? cause : new DaemonReadWorkerError(message, cause);
  }

  function settle(job, method, value) {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    for (const waiter of job.waiters) waiter[method](value);
  }

  function failWorker(reason, instance = worker) {
    if (worker !== instance) return;
    worker = null;
    generation += 1;
    if (active) {
      const job = active;
      active = null;
      settle(job, 'reject', error(`daemon read worker failed: ${reason.message || reason}`, reason));
    }
    if (!closed) queueMicrotask(pump);
  }

  function ensureWorker() {
    if (worker || closed) return worker;
    const instance = new WorkerClass(workerFile, { workerData: options.workerData });
    const ownGeneration = ++generation;
    worker = instance;
    instance.on('message', (message) => {
      if (worker !== instance || ownGeneration !== generation || !active || message?.id !== active.id) return;
      const job = active;
      active = null;
      if (message.error) settle(job, 'reject', new DaemonReadWorkerError(
        `daemon read ${job.operation} failed: ${message.error.message || message.error}`));
      else settle(job, 'resolve', message.result);
      queueMicrotask(pump);
    });
    instance.on('error', (reason) => failWorker(reason, instance));
    instance.on('exit', (code) => {
      if (worker === instance) failWorker(new Error(`exited ${code}`), instance);
    });
    return instance;
  }

  function pump() {
    if (closed || active || !queued.size) return;
    const [key, job] = queued.entries().next().value;
    queued.delete(key);
    active = job;
    job.id = nextId++;
    try {
      ensureWorker().postMessage({ id: job.id, operation: job.operation, input: job.input });
      job.timer = setTimeout(() => {
        if (active !== job) return;
        const instance = worker;
        failWorker(new Error(`${job.operation} timed out after ${timeoutMs}ms`), instance);
        instance?.terminate().catch(() => {});
      }, timeoutMs);
      job.timer.unref?.();
    } catch (reason) {
      active = null;
      settle(job, 'reject', error(`could not dispatch daemon read ${job.operation}`, reason));
      queueMicrotask(pump);
    }
  }

  function run(operation, input = {}, runOptions = {}) {
    if (closed) return Promise.reject(new DaemonReadWorkerError('daemon read worker is closed'));
    if (typeof operation !== 'string' || !operation) {
      return Promise.reject(new DaemonReadWorkerError('daemon read operation is required'));
    }
    let key;
    try { key = String(runOptions.key || `${operation}:${JSON.stringify(input)}`); }
    catch (reason) { return Promise.reject(error('daemon read input is not serializable', reason)); }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      if (active?.key === key && !active.settled) {
        active.waiters.push(waiter);
        return;
      }
      const existing = queued.get(key);
      if (existing) {
        existing.waiters.push(waiter);
        return;
      }
      if (queued.size >= maxQueued) {
        reject(new DaemonReadWorkerError('daemon read worker queue is full'));
        return;
      }
      queued.set(key, { key, operation, input, waiters: [waiter], settled: false, timer: null, id: null });
      queueMicrotask(pump);
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    const reason = new DaemonReadWorkerError('daemon read worker is closed');
    if (active) { settle(active, 'reject', reason); active = null; }
    for (const job of queued.values()) settle(job, 'reject', reason);
    queued.clear();
    const instance = worker;
    worker = null;
    generation += 1;
    instance?.terminate().catch(() => {});
  }

  return { run, close };
}

module.exports = { createDaemonReadWorker, DaemonReadWorkerError };
