'use strict';

const path = require('node:path');
const { fork } = require('node:child_process');

class DaemonMutationError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DaemonMutationError';
    this.status = 503;
  }
}

// Registry mutations use keep-core's synchronous PID-owned lock. Run the whole
// transaction in a child process: the daemon never waits for the lock on its event
// loop, and a killed child leaves a dead PID that stale-lock recovery can reclaim.
// Each child is its own process group so a timed-out git grandchild cannot outlive
// the transaction that launched it.
function createDaemonMutationProcess(options = {}) {
  const forkChild = options.fork || fork;
  const killProcess = options.kill || process.kill;
  const childFile = options.childFile || path.join(__dirname, 'daemon-mutation-child.js');
  const defaultTimeoutMs = Math.max(100, Number(options.timeoutMs) || 90e3);
  const killGraceMs = Math.max(10, Number(options.killGraceMs) || 1000);
  const cleanupPollMs = Math.max(1, Number(options.cleanupPollMs) || 10);
  const maxStderrBytes = Math.max(1024, Number(options.maxStderrBytes) || 64 * 1024);
  const maxActive = Math.max(1, Number(options.maxActive) || 8);
  const enterAdmission = options.enterAdmission || options.enter || null;
  const children = new Set();
  let closed = false;

  const mutationError = (operation, reason) => reason instanceof DaemonMutationError ? reason
    : new DaemonMutationError(`daemon mutation ${operation} failed: ${reason.message || reason}`, reason);

  function run(operation, input = {}, runOptions = {}) {
    if (closed) return Promise.reject(new DaemonMutationError('daemon mutation process is closed'));
    if (typeof operation !== 'string' || !operation) {
      return Promise.reject(new DaemonMutationError('daemon mutation operation is required'));
    }
    const timeoutMs = Math.max(100, Number(runOptions.timeoutMs) || defaultTimeoutMs);
    try { JSON.stringify(input); }
    catch (error) { return Promise.reject(new DaemonMutationError('daemon mutation input is not serializable', error)); }

    let leaveAdmission = () => {};
    try { leaveAdmission = enterAdmission?.() || leaveAdmission; }
    catch (error) { return Promise.reject(mutationError(operation, error)); }
    let admissionReleased = false;
    const releaseAdmission = () => {
      if (admissionReleased) return;
      admissionReleased = true;
      try { leaveAdmission(); } catch {}
    };
    if (children.size >= maxActive) {
      releaseAdmission();
      return Promise.reject(new DaemonMutationError(`daemon mutation capacity is full (${maxActive} active)`));
    }

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = forkChild(childFile, [], {
          detached: true,
          env: { ...process.env, ...(runOptions.env || {}) },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
      } catch (error) {
        releaseAdmission();
        reject(new DaemonMutationError(`could not start daemon mutation ${operation}`, error));
        return;
      }

      let response = null;
      let stderr = '';
      let settled = false;
      let cleanupReason = null;
      let timeout = null;
      let killTimer = null;
      let pollTimer = null;
      let doneResolve;
      const done = new Promise((doneNow) => { doneResolve = doneNow; });
      const state = { child, done, cleanup: null };
      children.add(state);

      const signalGroup = (signal) => {
        if (!Number.isInteger(child.pid) || child.pid <= 0) return false;
        try { killProcess(-child.pid, signal); return true; }
        catch {
          try { child.kill(signal); return true; } catch { return false; }
        }
      };
      const groupAlive = () => {
        if (!Number.isInteger(child.pid) || child.pid <= 0) return false;
        try { killProcess(-child.pid, 0); return true; }
        catch (error) { return error?.code !== 'ESRCH'; }
      };
      const finish = (method, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(killTimer);
        clearTimeout(pollTimer);
        children.delete(state);
        releaseAdmission();
        doneResolve();
        method(value);
      };
      const finishCleanupWhenGone = () => {
        signalGroup('SIGKILL');
        if (!groupAlive()) {
          finish(reject, cleanupReason);
          return;
        }
        pollTimer = setTimeout(finishCleanupWhenGone, cleanupPollMs);
      };
      const beginCleanup = (reason) => {
        if (cleanupReason || settled) return;
        cleanupReason = mutationError(operation, reason);
        signalGroup('SIGTERM');
        killTimer = setTimeout(finishCleanupWhenGone, killGraceMs);
        // A failed spawn/send can have no running PID and no later close event.
        if (!groupAlive()) finish(reject, cleanupReason);
      };
      state.cleanup = beginCleanup;

      child.stderr?.on('data', (chunk) => {
        if (stderr.length >= maxStderrBytes) return;
        stderr += String(chunk).slice(0, maxStderrBytes - stderr.length);
      });
      child.on('message', (message) => { response = message; });
      child.once('error', (error) => beginCleanup(
        new DaemonMutationError(`daemon mutation ${operation} process error: ${error.message}`, error)));
      child.once('close', (code, signal) => {
        if (cleanupReason) {
          finishCleanupWhenGone();
          return;
        }
        if (response?.error) {
          const detail = response.error.message || response.error;
          const error = new DaemonMutationError(`daemon mutation ${operation} failed: ${detail}`);
          if (response.error.type !== undefined || response.error.name !== undefined) {
            error.remoteName = response.error.type || response.error.name;
          }
          if (response.error.code !== undefined) error.code = response.error.code;
          if (response.error.stderr !== undefined) error.stderr = response.error.stderr;
          finish(reject, error);
          return;
        }
        if (response && Object.prototype.hasOwnProperty.call(response, 'result') && code === 0) {
          finish(resolve, response.result);
          return;
        }
        const suffix = stderr.trim() ? `: ${stderr.trim()}` : signal ? ` (${signal})` : '';
        finish(reject, new DaemonMutationError(`daemon mutation ${operation} exited ${code}${suffix}`));
      });
      try {
        child.send({ operation, input }, (error) => {
          if (error) beginCleanup(new DaemonMutationError(`could not dispatch daemon mutation ${operation}`, error));
        });
      } catch (error) {
        beginCleanup(new DaemonMutationError(`could not dispatch daemon mutation ${operation}`, error));
      }
      timeout = setTimeout(() => beginCleanup(
        new DaemonMutationError(`daemon mutation ${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
      timeout.unref?.();
    });
  }

  async function close() {
    if (closed) return;
    closed = true;
    const active = [...children];
    for (const state of active) state.cleanup(new DaemonMutationError('daemon mutation process is closed'));
    await Promise.all(active.map((state) => state.done));
  }

  return { run, close };
}

module.exports = { createDaemonMutationProcess, DaemonMutationError };
