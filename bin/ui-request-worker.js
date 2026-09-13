'use strict';

const path = require('node:path');
const { fork } = require('node:child_process');

function createUiRequestWorker(options = {}) {
  const spawn = options.fork || fork;
  const workerPath = options.workerPath || path.join(__dirname, 'ui-request-worker-child.js');
  const restartDelayMs = Math.max(0, Number(options.restartDelayMs ?? 100));
  const maxRestartDelayMs = Math.max(restartDelayMs, Number(options.maxRestartDelayMs ?? 5000));
  const startupTimeoutMs = Math.max(100, Number(options.startupTimeoutMs ?? 5000));
  const log = options.log || ((message) => process.stderr.write(`${message}\n`));
  let child = null;
  let ready = false;
  let closing = false;
  let retained = null;
  let pendingPublication = false;
  let publishing = false;
  let queued = null;
  let changePending = false;
  let restartTimer = null;
  let startupTimer = null;
  let retryDelay = restartDelayMs;

  const sendLatest = () => {
    if (!child || !ready || publishing || !retained || !pendingPublication) return;
    const activeChild = child;
    const value = retained;
    pendingPublication = false;
    publishing = true;
    try {
      activeChild.send({ type: 'publish', value }, (error) => {
        if (activeChild !== child) return;
        if (error) {
          publishing = false;
          pendingPublication = true;
          return;
        }
      });
    } catch (error) {
      publishing = false;
      pendingPublication = true;
      log(`[keep ui] snapshot publish failed: ${error.message}`);
    }
  };

  const sendChange = () => {
    if (!child || !ready || changePending || !queued) return;
    const activeChild = child;
    const value = queued;
    queued = null;
    changePending = true;
    try {
      activeChild.send({ type: 'event', value }, (error) => {
        if (activeChild !== child || !error) return;
        changePending = false;
        queued = queued || value;
      });
    } catch (error) {
      changePending = false;
      queued = queued || value;
    }
  };

  const start = () => {
    if (child || closing) return;
    restartTimer = null;
    let instance;
    try {
      instance = spawn(workerPath, [], {
        env: { ...process.env, ...(options.workerEnv || {}) },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
    } catch (error) {
      log(`[keep ui] worker failed to start: ${error.message}`);
      restartTimer = setTimeout(start, retryDelay);
      restartTimer.unref?.();
      retryDelay = Math.min(maxRestartDelayMs, Math.max(100, retryDelay * 2 || 100));
      return;
    }
    child = instance;
    ready = false;
    publishing = false;
    changePending = false;
    startupTimer = setTimeout(() => {
      if (child !== instance || ready) return;
      log(`[keep ui] worker did not become ready within ${startupTimeoutMs}ms`);
      try { instance.kill('SIGKILL'); } catch {}
    }, startupTimeoutMs);
    startupTimer.unref?.();
    instance.on('message', (message) => {
      if (child !== instance || !message) return;
      if (message.type === 'ready') {
        if (startupTimer) clearTimeout(startupTimer);
        startupTimer = null;
        ready = true;
        retryDelay = restartDelayMs;
        pendingPublication = Boolean(retained);
        options.onReady?.(message);
        sendLatest();
        sendChange();
      } else if (message.type === 'published') {
        publishing = false;
        options.onPublished?.(message);
        sendLatest();
      } else if (message.type === 'event-sent') {
        changePending = false;
        sendChange();
      }
    });
    const failed = (why) => {
      if (child !== instance) return;
      child = null;
      if (startupTimer) clearTimeout(startupTimer);
      startupTimer = null;
      ready = false;
      publishing = false;
      pendingPublication = Boolean(retained);
      changePending = false;
      if (!closing) {
        log(`[keep ui] ${why}; restarting frontend worker`);
        restartTimer = setTimeout(start, retryDelay);
        restartTimer.unref?.();
        retryDelay = Math.min(maxRestartDelayMs, Math.max(100, retryDelay * 2 || 100));
      }
    };
    instance.once('error', (error) => failed(`worker error: ${error.message}`));
    instance.once('exit', (code, signal) => failed(`worker exited (${signal || code})`));
    instance.send({ type: 'init', options: options.workerOptions });
  };

  start();
  return {
    publish(value) {
      retained = value;
      pendingPublication = true;
      sendLatest();
    },
    event(value) {
      queued = value;
      sendChange();
    },
    pid: () => child?.pid || null,
    close() {
      if (closing) return;
      closing = true;
      if (restartTimer) clearTimeout(restartTimer);
      if (startupTimer) clearTimeout(startupTimer);
      retained = null;
      pendingPublication = false;
      queued = null;
      const instance = child;
      child = null;
      ready = false;
      if (!instance) return;
      const killTimer = setTimeout(() => { try { instance.kill('SIGKILL'); } catch {} }, 1000);
      killTimer.unref?.();
      instance.once('exit', () => clearTimeout(killTimer));
      try { instance.send({ type: 'shutdown' }); } catch { try { instance.kill('SIGTERM'); } catch {} }
    },
  };
}

module.exports = { createUiRequestWorker };
