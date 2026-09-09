#!/usr/bin/env node
'use strict';
const path = require('node:path');
const BOOT_VERSION = 1;
const CORE_RELOAD_ALLOWLIST = [];
function clearLocalCoreModules(corePath) {
  // A reload swaps host.js only. Shared modules such as keep.js stay cached so a
  // core upgrade cannot replace process-wide singletons behind the daemon's back.
  const targets = [corePath, ...CORE_RELOAD_ALLOWLIST].map((file) => path.resolve(file));
  for (const target of targets) delete require.cache[target];
}
function createBootstrap(options = {}) {
  const corePath = options.corePath || path.join(__dirname, 'host.js');
  const loadCore = options.loadCore || ((fresh) => {
    if (fresh) clearLocalCoreModules(corePath);
    return require(corePath);
  });
  const hostOptions = { ...options };
  delete hostOptions.corePath;
  delete hostOptions.loadCore;
  let current = null;
  let currentModule = null;
  let reloadPromise = null;
  let reloads = 0;
  let lastReload = null;
  let stopped = false;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const report = (line, error = false) => {
    if (typeof options.log === 'function') return options.log(line);
    if (options.log === null) return;
    (error ? process.stderr : process.stdout).write(`${line}\n`);
  };
  const boot = {
    version: BOOT_VERSION,
    closed,
    get core() { return current; },
    get reloads() { return reloads; },
    get lastReload() { return lastReload; },
    async start() {
      if (current) return current;
      currentModule = loadCore(false);
      const core = currentModule.createHost({ ...hostOptions, boot });
      await core.listen();
      current = core;
      return core;
    },
    reload() {
      if (reloadPromise) return reloadPromise;
      reloadPromise = (async () => {
        if (!current || stopped) throw new Error('host bootstrap is not running');
        const started = Date.now();
        const previousModule = currentModule;
        const previous = current;
        current = null;
        let record;
        try { record = await previous.handoff(); }
        catch (error) {
          // A rejected handoff may have left the old core half-stopped. Keep it only
          // if it is still (or can again be) serving; otherwise the panes are
          // unreachable and a launchd restart beats a zombie owner.
          // handoff() rolls its own state back before rejecting; `serving` says whether that worked.
          const serving = () => previous.serving === true;
          reloads += 1;
          lastReload = { at: new Date().toISOString(), panesAdopted: 0, fallback: true, error: error.message };
          if (serving()) {
            current = previous;
            report(`host: reload aborted (${error.message}); previous core still serving`, true);
            throw error;
          }
          report(`host: reload failed during handoff (${error.message}) and the previous core is unusable; exiting so launchd restarts (panes lost)`, true);
          process.exit(1);
        }
        let candidate;
        try {
          const nextModule = loadCore(true);
          candidate = nextModule.createHost({ ...hostOptions, boot, adopt: record });
          await candidate.listen();
          previous.finalizeHandoff();
          current = candidate;
          currentModule = nextModule;
          reloads += 1;
          lastReload = {
            at: new Date().toISOString(), panesAdopted: record.panes.length, fallback: false, error: null,
          };
          report(`host: reloaded core in ${Date.now() - started} ms, ${record.panes.length} panes adopted`);
          return { panesAdopted: record.panes.length, fallback: false };
        } catch (error) {
          let source = previous;
          if (candidate && !candidate.retired) {
            try {
              record = await candidate.handoff();
              source = candidate;
            } catch {}
          }
          let fallback;
          try {
            fallback = previousModule.createHost({ ...hostOptions, boot, adopt: record });
            await fallback.listen();
          } catch (fallbackError) {
            reloads += 1;
            lastReload = {
              at: new Date().toISOString(),
              panesAdopted: 0,
              fallback: true,
              error: `${error.message}; fallback failed: ${fallbackError.message}`,
            };
            current = null;
            report('host: reload fallback failed; exiting so launchd restarts (panes lost)', true);
            process.exit(1);
            throw fallbackError;
          }
          source.finalizeHandoff();
          if (source !== previous) previous.finalizeHandoff();
          current = fallback;
          currentModule = previousModule;
          reloads += 1;
          lastReload = {
            at: new Date().toISOString(),
            panesAdopted: record.panes.length,
            fallback: true,
            error: error.message,
          };
          report(`host: reload failed (${error.message}); previous core restored`, true);
          return { panesAdopted: record.panes.length, fallback: true, error: error.message };
        }
      })().finally(() => { reloadPromise = null; });
      return reloadPromise;
    },
    async close() {
      if (stopped) return closed;
      stopped = true;
      if (reloadPromise) await reloadPromise.catch(() => {});
      if (current) await current.close();
      resolveClosed();
      return closed;
    },
  };
  return boot;
}
async function runHost(options = {}) {
  const boot = createBootstrap(options);
  const guard = () => {};
  const stop = () => boot.close().catch((error) => process.stderr.write(`host: ${error.message}\n`));
  process.stdout.on('error', guard);
  process.stderr.on('error', guard);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try { await boot.start(); await boot.closed; }
  finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    process.stdout.removeListener('error', guard);
    process.stderr.removeListener('error', guard);
  }
}
module.exports = { BOOT_VERSION, CORE_RELOAD_ALLOWLIST, clearLocalCoreModules, createBootstrap, runHost };
if (require.main === module) runHost().catch((error) => {
  process.stderr.write(`host: ${error.message}\n`);
  process.exitCode = 1;
});
