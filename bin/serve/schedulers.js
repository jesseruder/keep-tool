'use strict';
const path = require('node:path');
const nodes = require('../nodes.js');
// keep serve — the daemon's periodic jobs.
//
// Every block here was moved verbatim out of start() in serve.js: the schedulers
// the feature modules register, the timers the daemon ticks on, and the one-shot
// kicks that prime them. Nothing in this file may require ../serve.js, so the
// daemon's internals and start()'s locals arrive through `ctx` — the same object
// bin/serve/routes.js takes. `ctx.sessionSnapshot` and `ctx.sessionSnapshotAt`
// stay on ctx rather than being destructured: the dashboard rebinds them, and the
// watcher tick has to read whichever snapshot is current when it runs.

// The optional features' schedulers, in the order given. A feature that is off
// never starts one: its module is not asked for a tick and reads no state of its
// own. Its health row is written here instead, the way the wt-gc, self-repair,
// watcher and registry-pull branches below write theirs. Without that, a feature
// that used to be on keeps its last entry and health.snapshot() eventually calls
// it `silent` — dashboard attention and a lint finding for something switched off
// on purpose. Every one of these modules records under its own name, and
// health.js's cadence table already knows each row, so no cadence is passed here:
// a scheduler this process never starts has no cadence of its own to report.
// Exported on its own so a test can ask what a set of switches starts without
// standing up the daemon.
function startFeatureSchedulers(features, modules, options, health) {
  const started = [];
  for (const [name, module] of Object.entries(modules)) {
    if (!features.enabled(name)) {
      health.record(name, { disabled: true, detail: `features.${name} is off` });
      continue;
    }
    module.startScheduler(options);
    started.push(name);
  }
  return started;
}

const PULL_TIMEOUT_MS = 30e3;
const PUSH_RECEIPTS_MS = 15 * 60e3;

// git's own reason for refusing, which the old `stdio: 'ignore'` threw away and
// health showed as a bare exit status. A child killed for running past the timeout
// says so: "Command failed" reads the same whether git refused in a millisecond or
// the network hung for thirty seconds, and those want different answers.
function gitFailure(error, stderr) {
  const reason = String(stderr || '').trim() || error.message;
  // execFile marks a timed-out child `killed`; execFileSync says ETIMEDOUT instead.
  const timedOut = Boolean(error.killed) || error.code === 'ETIMEDOUT';
  return new Error(timedOut ? `${reason} (killed after ${PULL_TIMEOUT_MS / 1000}s)` : reason);
}

// Expo reports an uninstalled app in a push's receipt, minutes after the push
// itself was accepted, so the registry only learns about a dead phone if
// somebody asks. Nothing here is urgent: a phone that is gone costs one wasted
// request per push until the next run.
//
// One timer, rescheduled after each tick rather than an interval beside it: two
// mechanisms is how the first poll ended up running twice at once. The guard is
// the same rule the other slow ticks keep — a run that outlasts its cadence is
// never joined by a second one.
function startReceiptsPoller({
  keep, health,
  poll = (request) => require('../alerts.js').pollReceipts(request),
  setTimeout: st = setTimeout,
  write = (line) => process.stderr.write(line),
} = {}) {
  let running = false;
  let timer = null;
  const schedule = () => { timer = st(tick, PUSH_RECEIPTS_MS); timer?.unref?.(); };
  const tick = async () => {
    // The run in flight schedules the next one when it finishes, so a skipped
    // tick must not start a second timer beside it.
    if (running) return;
    running = true;
    try {
      const result = await poll({ root: keep.ROOT }) || {};
      health.record('push-receipts', {
        ok: result.ok !== false,
        cadenceMs: PUSH_RECEIPTS_MS,
        detail: result.detail,
        ...(result.ok === false ? { error: result.error || 'receipts request failed' } : {}),
      });
    } catch (error) {
      // pollReceipts does not throw; a bug that makes it throw is still not a
      // reason to lose the timer.
      health.record('push-receipts', { ok: false, cadenceMs: PUSH_RECEIPTS_MS, error });
      write(`keep serve: push receipts failed: ${error.message}\n`);
    } finally {
      running = false;
      schedule();
    }
  };
  schedule();
  return { tick, get running() { return running; } };
}

// Pulls cloud-made commits (the overnight check routine's, say) into the local
// registry, in two halves that are deliberately not one `git pull`.
//
// The fetch is the slow, network-bound half, and it runs unlocked in a child: it
// touches nothing but .git/refs, and holding the registry lock across it was the
// whole problem. Nothing else here may hold that lock asynchronously — every other
// keep.withLock caller in this process waits for it by blocking the event loop in
// a `sleep 0.1` loop, so an async holder could never be woken to release it, and
// the collision would be a guaranteed five seconds followed by the lock error.
//
// The rebase is the only part that touches the working tree, and with the objects
// already local it is a fast-forward or a few commits — tens of milliseconds. It
// runs synchronously under the ordinary lock, exactly like every other registry
// mutation the daemon makes. When the remote has not moved, the counting stops the
// tick and the lock is never taken at all.
//
// Built by a factory so a test can drive it without standing up startSchedulers.
function createRegistryPull({
  keep, health,
  execFile = require('child_process').execFile,
  execFileSync = require('child_process').execFileSync,
  now = Date.now,
} = {}) {
  const run = (...args) => new Promise((resolve, reject) => {
    execFile('git', ['-C', keep.ROOT, ...args], { timeout: PULL_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(gitFailure(error, stderr));
        else resolve(String(stdout || ''));
      });
  });
  let running = false;
  return async function pull() {
    // A pull slow enough to still be running at the next tick must not be joined by
    // a second one; the same guard collectCardUsage uses.
    if (running) return;
    running = true;
    const startedAt = now();
    try {
      await run('fetch', '-q');
      const behind = Number(String(await run('rev-list', '--count', 'HEAD..@{u}')).trim()) || 0;
      if (!behind) {
        health.record('git-pull', { ok: true, detail: `up to date, ${now() - startedAt}ms` });
        return;
      }
      keep.withLock(() => {
        try {
          execFileSync('git', ['-C', keep.ROOT, 'rebase', '-q', '--autostash', '@{u}'], {
            timeout: PULL_TIMEOUT_MS, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8',
          });
        } catch (error) {
          // A conflict must not leave the registry mid-rebase for the next keep
          // command to walk into. The abort happens inside the same lock, and its
          // own failure says nothing the rebase's stderr does not already say.
          try {
            execFileSync('git', ['-C', keep.ROOT, 'rebase', '--abort'], {
              timeout: PULL_TIMEOUT_MS, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8',
            });
          } catch {}
          throw gitFailure(error, error.stderr);
        }
      });
      health.record('git-pull', { ok: true, detail: `${behind} behind, rebased in ${now() - startedAt}ms` });
    } catch (error) {
      // offline, a rebase that needs hands, or lock contention — the next tick catches up
      health.record('git-pull', { ok: false, error });
    } finally {
      running = false;
    }
  };
}

// The stall detector. A timer that asks to run every second and arrives much
// later than that arrived late because something held the event loop for the
// difference, so the lateness is the measurement. launchd appends the daemon's
// stderr to ~/keep/.keep/serve.log, which makes this the one record of a stall
// that outlives the process it happened in.
function startLoopLagProbe({ thresholdMs = 500, intervalMs = 1000, write = (line) => process.stderr.write(line),
  setInterval: si = setInterval, now = Date.now } = {}) {
  let expectedAt = now() + intervalMs;
  const timer = si(() => {
    const at = now();
    const lag = at - expectedAt;
    if (lag > thresholdMs) write(`keep serve: event loop stalled ${Math.round(lag)}ms\n`);
    // Measured against when this tick actually landed, so one stall is reported
    // once rather than as a lasting offset on every tick after it.
    expectedAt = at + intervalMs;
  }, intervalMs);
  timer?.unref?.();
  return timer;
}

function createCleanupSnapshot({
  keep, keepConsole, listHostPanes, dashboardBuild, companionSnapshot, deps = {},
  reconcile = (root, sessions, panes) => require('../session-retirement').reconcile(root, sessions, panes),
} = {}) {
  return async () => {
    // Shell verification must see new viewers/output even inside the host-list cache TTL.
    // That freshness guarantee belongs to the pane list. The fleet build and companion
    // discovery can use their workers and ordinary caches without weakening it.
    const panes = await listHostPanes({}, true);
    // Every automatic policy fed from this snapshot reasons about this machine: the
    // shell close verifies a pid in the local process table, and retirement compares
    // an agent pid it can see. A pane on another node answers none of those questions
    // here, so it is kept out of the snapshot entirely until (landing 1b) the node
    // can answer them about itself. The dashboard build below still sees the whole fleet.
    const local = (panes || []).filter((pane) => !pane?.node || pane.node === nodes.daemonNode());
    const companion = await companionSnapshot(deps);
    const state = await dashboardBuild({ hostPanes: panes, companion, dashboard: true });
    reconcile(keep.ROOT, state.sessions, local);
    const layouts = await keepConsole.readLayouts(path.join(keep.ROOT, '.keep', 'layouts.json'));
    return {
      ...state,
      // The panes every automatic policy is allowed to touch: this machine's.
      panes: local,
      // The build's task list excludes the archive; a session on an archived card
      // must still find it here or cleanup treats it as cardless.
      allTasks: keep.loadAll(true),
      companion,
      pinned: new Set((layouts.layouts || []).flatMap((layout) => layout.ids || [])),
    };
  };
}

function startSchedulers(ctx) {
  const {
    TURN_INDEX_BUDGET_BYTES, TURN_INDEX_BUDGET_MS, TURN_INDEX_PRUNE_LIMIT,
    WATCHER_CONCURRENCY, WATCHER_TURNS_PER_TICK, WATCHER_WINDOW_MS,
    addHostSessionState, agentProcessRows, broadcast, buildState, cardUsage, closeEphemeralPane,
    closeIdleSession, companionSnapshot, dashboardBuild, dashboardBuilder, deliverCheckToThread, deliverUnblockToThread,
    deps, discord, driftWakeFromVerdict, envNumber, features, forceRestartSession, fs, health, hostRequest,
    ideas, keep, keepConsole, landed, limitresume, listHostPaneResult, listHostPanes, liveSessionTick,
    liveTurnIndexSessions, loadCurrentSession, openCheckSession, openSession, path,
    prepareSessionSummary, readLiveSessionLedger, readScreenResult, resolveSessionTarget, restartSession,
    resumeAfterLimit,
    review, reviewDeps, runs, scanSessions, sendToResolvedTarget, sendToSession, sessionSummarySnapshot, slack,
    stallAliveIds, stalled, stalledSessionSnapshot, standup, startAutoCompact, startBriefScheduler,
    startHandoffQueue, startWtGcScheduler, summarize, transcriptFileForSession,
    unblock, usage, watcherSend, withInjectionLock, writeTarget,
  } = ctx;

  runs.setOnChange(broadcast);
  runs.setDeliverer(deliverCheckToThread);
  // A due check that no live thread took opens an ordinary interactive session on its
  // card — the same thing self-repair does, and for the same reason: a headless run
  // dies at the end of its turn, has no memory, and cannot be looked at.
  runs.setOpener(openCheckSession);
  runs.setEphemeralHost({
    // The same boundary the cleanup snapshot keeps: this sweep closes a pane and
    // then releases the check's delivery stamp on the strength of a local
    // observation. An exited pane on another node is not this machine's to reap.
    listPanes: async () => (await listHostPanes({}, true) || [])
      .filter((pane) => !pane?.node || pane.node === nodes.daemonNode()),
    sessions: () => scanSessions(),
    closePane: (pane, sessionId) => closeEphemeralPane(pane, sessionId, { onChange: broadcast }),
    // A closed pane still sits in the host's list. Forget it, or the sweep re-decides
    // about a dead pane on every tick and the `runs` health row never reports idle.
    removePane: (pane) => hostRequest('remove', { pane: pane.id }),
  });
  summarize.setOnChange(broadcast);
  require('../session-summary').startScheduler({
    snapshot: () => sessionSummarySnapshot({ ...deps, dashboardBuild }),
    prepare: prepareSessionSummary,
    onError: (error) => process.stderr.write(`keep session summaries: ${error.message}\n`),
  });
  usage.setOnChange(broadcast);
  usage.setCacheFile(path.join(keep.ROOT, '.keep', 'usage-cache.json'));
  runs.startScheduler();
  require('../delivery-health').startScheduler({ root: keep.ROOT, onChange: broadcast,
    // Global on purpose: reconcile reads every session's pending delivery record, so no
    // delivery may be mid-flight anywhere. It is synchronous file work, so the hold is brief.
    // The pane list is read first, outside the lock: a typed entry whose pane the host no
    // longer lists at all is retired. Exited panes still count (replace-exited keeps the
    // id), so a replacement racing this snapshot cannot retire a live draft. An
    // unreachable host or an empty list (see findCardPane) retires nothing.
    reconcile: async () => {
      const listed = await listHostPaneResult(deps, true);
      const panes = Array.isArray(listed.panes) && listed.panes.length
        ? new Set(listed.panes.filter((pane) => typeof pane?.id === 'string').map((pane) => pane.id)) : null;
      // The nodes this list could not speak for: one that did not answer, and one
      // whose panes came from its own memo rather than from the machine. A journal
      // on either is unresolved, not retired.
      const unknownNodes = new Set([
        ...(listed.missingNodes || []),
        ...Object.entries(listed.nodes || {}).filter(([, status]) => status.stale || !status.ok).map(([name]) => name),
      ]);
      // With no readable node list there is no way to name the nodes that were not
      // asked, so every pane that is not this node's counts as unknown.
      const unknownRemote = listed.configurationUnreadable === true;
      return withInjectionLock(() => require('../delivery')
        .reconcile(path.join(keep.ROOT, '.keep', 'delivery'), { panes, unknownNodes, unknownRemote }));
    },
  });
  unblock.startScheduler({
    onChange: broadcast,
    deps: { deliver: deliverUnblockToThread },
  });
  // One nag per expired state note, and only to its own author. Nothing else in
  // the system reads an expired note as a reason to stop.
  require('../notes.js').startScheduler({
    onChange: broadcast,
    sessions: () => scanSessions(),
    send: (sessionId, text) => withInjectionLock(() => sendToSession({ sessionId, text }), { session: sessionId }),
  });
  startAutoCompact();
  // Retries the transfers a rate-limited session's move was refused for, and
  // nothing else: no launch, no input, no check skipped. See bin/handoff-queue.js.
  startHandoffQueue();
  // Dev servers, watchers and test runners a session started in the background and
  // left behind when its pane went away. See bin/leftover-processes.js.
  if (process.env.KEEP_LEFTOVER_SWEEP === '0') {
    health.record('leftovers', { disabled: true, detail: 'KEEP_LEFTOVER_SWEEP=0' });
  } else {
    const leftovers = require('../leftover-processes');
    let exclude = null;
    try { if (process.env.KEEP_LEFTOVER_EXCLUDE) exclude = new RegExp(process.env.KEEP_LEFTOVER_EXCLUDE); }
    catch (error) { process.stderr.write(`keep serve: KEEP_LEFTOVER_EXCLUDE ignored: ${error.message}\n`); }
    const seen = new Map();
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const result = await leftovers.reap({ deps: {
          seen, exclude, keepRoot: keep.ROOT,
          graceMs: envNumber('KEEP_LEFTOVER_GRACE_MIN', 15) * 60e3,
          panes: () => listHostPanes({}, true),
        } });
        for (const item of result.stopped) process.stderr.write(`keep serve: stopped leftover ${leftovers.describe(item)}\n`);
        const failed = result.skipped.find((item) => item.pid == null);
        const mb = Math.round(result.stopped.reduce((sum, item) => sum + item.rssKb, 0) / 1024);
        health.record('leftovers', failed
          ? { ok: false, error: failed.why }
          : { ok: true, detail: `${result.stopped.length} stopped${mb ? ` (${mb} MB)` : ''}, ${result.waiting.length} in grace` });
      } catch (error) {
        health.record('leftovers', { ok: false, error });
        process.stderr.write(`keep serve: leftover sweep failed: ${error.message}\n`);
      } finally { running = false; }
    };
    setInterval(() => { void tick(); }, 5 * 60e3).unref();
    setTimeout(() => { void tick(); }, 60e3).unref();
  }
  const restarts = require('../session-restart').createManager({
    file: path.join(keep.ROOT, '.keep', 'session-restarts.json'),
    inspect: async (body) => {
      const panes = await listHostPanes({}, true);
      // A queued restart needs a new observation, but its fleet scan need not run
      // on the request loop. Give it a distinct worker generation so it cannot
      // join an older dashboard request with the same pane snapshot.
      dashboardBuilder.invalidate({ kind: 'all', name: 'restart-inspection' });
      const state = await dashboardBuild({ hostPanes: panes });
      return { session: state.sessions.find((s) => s.id === body.sessionId), pane: panes?.find((p) => p.id === body.pane) };
    },
    restart: restartSession, forceRestart: forceRestartSession, onChange: broadcast,
  });
  // Queued idle restarts need fresh safety evidence, but scanning the fleet every
  // two seconds competes with foreground work. Explicit restart-now stays immediate.
  const restartTimer = setInterval(() => restarts.tick().catch((error) => process.stderr.write(`keep restart: ${error.message}\n`)), 10000);
  restartTimer.unref();
  if (process.env.KEEP_AUTO_CLOSE !== '0') {
    const doneIdleMs = envNumber('KEEP_AUTO_CLOSE_DONE_MIN', 15) * 60e3;
    const attentionIdleMs = envNumber('KEEP_AUTO_CLOSE_ATTENTION_MIN', 30) * 60e3;
    const unattendedIdleMs = envNumber('KEEP_AUTO_CLOSE_UNATTENDED_MIN', 60) * 60e3;
    const cleanupSnapshot = createCleanupSnapshot({
      keep, keepConsole, listHostPanes, dashboardBuild, companionSnapshot, deps,
    });
    require('../session-cleanup').startScheduler({
      doneIdleMs,
      attentionIdleMs,
      unattendedIdleMs,
      snapshot: cleanupSnapshot,
      closeShell: pane => withInjectionLock(() => require('../shell-cleanup').close(pane, {
        snapshot: cleanupSnapshot,
        processes: () => agentProcessRows(),
        screen: p => readScreenResult({ pane: p.id }, null, false),
        eof: p => writeTarget({ pane: p.id }, '\x04'),
      }), { pane: pane.id }),
      close: async (body) => {
        const retirement = require('../session-retirement');
        const result = await withInjectionLock(async () => {
          const entry = retirement.begin(keep.ROOT, body);
          let exitInputStarted = false;
          try {
            const hostCapabilities = await hostRequest('hello');
            const closed = await require('../manual-close').manualClose(body, {
              requireGraceful: true,
              requireSignalGuard: true,
              signalGuarded: hostCapabilities.guardedKill === true,
              protectInput: true,
              protectOutput: true,
              getPane: async (pane) => (await hostRequest('get', { pane })).pane,
              graceful: (request) => closeIdleSession(request, {
                closePolicy: {
                  automatic: true,
                  retirement: true,
                  expectedReason: body.reason,
                  doneIdleMs,
                  attentionIdleMs,
                  unattendedIdleMs,
                  idleMs: body.idleMs,
                  legacyDoneAt: body.legacyDoneAt,
                },
                beforeExitInput: () => { exitInputStarted = true; },
                withInjectionLock: (fn) => fn(),
              }),
              signal: (pane, signal, guard) => {
                retirement.assertRetirable(keep.ROOT, body.sessionId);
                return hostRequest('guarded-kill', { pane, signal, ...guard });
              },
            });
            retirement.finish(keep.ROOT, body.sessionId, Date.now(), entry.transactionId);
            return closed;
          } catch (error) {
            if (!exitInputStarted) retirement.cancel(keep.ROOT, body.sessionId, entry.transactionId);
            else try {
              const panes = await listHostPanes({}, true);
              const current = panes?.find((pane) => pane.id === body.pane);
              if (Array.isArray(panes) && (!current || !current.alive || current.agentAlive === false
                  || current.meta?.sessionId !== body.sessionId)) {
                retirement.finish(keep.ROOT, body.sessionId, Date.now(), entry.transactionId);
              }
            } catch {} // Unknown process state retains the closing snapshot.
            throw error;
          }
        }, { pane: body.pane, session: body.sessionId });
        keep.recordDaemonSessionClose(body.cardIds, body.sessionId, body.idleMinutes);
        broadcast();
        return result;
      },
      record: (entry) => {
        const file = path.join(keep.ROOT, '.keep', 'session-cleanup.json');
        let entries = [];
        try { const parsed = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(parsed)) entries = parsed; } catch {}
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify([...entries.slice(-499), entry]) + '\n', { mode: 0o600 });
        fs.renameSync(temp, file);
      },
      onError: (error) => process.stderr.write(`keep auto-close: ${error.message}\n`),
    });
  }
  limitresume.startScheduler({
    scanSessions,
    getUsage: usage.getUsage,
    send: (sessionId, text, opts) => resumeAfterLimit(sessionId, text, opts),
    root: keep.ROOT,
    onChange: broadcast,
  });
  review.startScheduler(reviewDeps);
  startBriefScheduler({ onChange: broadcast });
  startFeatureSchedulers(features, { standup, ideas }, { onChange: broadcast }, health);
  // Deterministic hygiene, refreshed on a clock: the reviewer bundle splices the
  // persisted snapshot in and review-land refuses notes against it, so a day-old
  // file is the same as no lint at all.
  require('../lint.js').startScheduler({ onChange: broadcast });
  landed.startScheduler({ onChange: broadcast });
  // Reviews that were launched and never answered. The sweep reads the Codex job's own
  // state through the snapshot the console already keeps warm, so it costs no extra ps.
  require('../review-obligations.js').startScheduler({ onChange: broadcast, companionSnapshot });
  if (process.env.KEEP_WT_GC === '0') {
    health.record('wt-gc', { disabled: true, detail: 'KEEP_WT_GC=0' });
  } else startWtGcScheduler({ onChange: broadcast });
  // The daemon watching itself: a failure signature that keeps coming back gets
  // one card, one worktree and one agent. It never restarts this process — that
  // stays Owner's, and `keep hook pre-bash` refuses it from inside the run.
  if (process.env.KEEP_SELF_REPAIR === '0') {
    health.record('self-repair', { disabled: true, detail: 'KEEP_SELF_REPAIR=0', cadenceMs: require('../self-repair.js').CADENCE_MS });
  } else require('../self-repair.js').startScheduler({
    onChange: broadcast,
    // The repair agent is an ordinary interactive session in the terminal host,
    // not a headless run that dies at the end of its turn. self-repair.js takes
    // these through deps rather than requiring serve.js, which would be a cycle.
    openSession: (body, openDeps) => openSession(body, openDeps),
    // The spawn response can be lost after the pane is up — a host timeout, a
    // daemon that died between the two. The host itself is the authority on
    // whether this card already has a repair agent, so ask it before opening
    // another. `meta.repair` and not just `meta.card`: a lost-response pane was
    // spawned by this scheduler so it carries the flag, while Owner's own session
    // on the card does not and must never be adopted as the repair agent.
    findCardPane: async (cardId, sessionId) => {
      const panes = await listHostPanes({}, true);
      // An empty list is a host that has told us nothing useful — a host still
      // starting, a list that raced a restart — not a host with no panes. Treating
      // it as "no agent anywhere" is how a live session gets a second one.
      if (!Array.isArray(panes) || !panes.length) return null;
      const match = panes.find((pane) => pane && pane.alive && pane.agentAlive !== false
        && pane.meta && pane.meta.repair === true
        && (pane.meta.card === cardId || (sessionId && pane.meta.sessionId === sessionId)));
      return match ? { pane: match.id, sessionId: match.meta.sessionId || null } : null;
    },
    // A recorded launch whose pane has since exited is not a launch any more. Null
    // means "could not tell" — the caller leaves the entry alone rather than
    // relaunching into a host it cannot see.
    //
    // Matched by session id as well as pane id: an in-place restart or an account
    // handoff replaces the pane, and between the agent stopping and
    // `replace-exited` the old pane id is dead while the session is very much
    // alive. Finding it under its new pane is what stops that window from looking
    // like an exit.
    paneAlive: async (paneId, sessionId) => {
      const panes = await listHostPanes({}, true);
      if (!Array.isArray(panes) || !panes.length) return null;
      const match = panes.find((pane) => pane
        && (pane.id === paneId || (sessionId && pane.meta && pane.meta.sessionId === sessionId)));
      return Boolean(match && match.alive && match.agentAlive !== false);
    },
  });
  // Incidents ride on the Slack poll's clock: every alert that could close one
  // arrived through it, so a sweep after each poll is both timely and free. It
  // is deliberately not its own timer, and it never throws into the tick.
  //
  // The area-session tick hangs off the same hook, after the sweep and after the
  // emitter has written the poll's events, because launch/deliver/restart all
  // react to exactly what those two just produced. `afterPoll` is called
  // synchronously and not awaited, so the tick is started and left to run: it
  // opens panes and types into terminals, and a poll must never wait on that.
  // Everything bin/area-session.js needs from the daemon, so it requires nothing
  // of serve.js itself. Cheap to rebuild per tick and always the live bindings.
  const areaSessionDeps = () => ({
    openSession: (body, openDeps) => openSession(body, openDeps),
    // `true` bypasses the host-list cache: a launch decision made from a stale
    // list is how a second session gets opened, and a close decision made from
    // one would signal a pane that has come back to life.
    listPanes: () => listHostPanes(deps, true),
    scanSessions: () => scanSessions(),
    loadCurrentSession: (id) => loadCurrentSession(id),
    resolveSessionTarget: (session, hint) => resolveSessionTarget(session, hint),
    sendToResolvedTarget: (session, target, text, opts) => sendToResolvedTarget(session, target, text, opts),
    withInjectionLock: (fn, scope) => withInjectionLock(fn, scope),
    // Graceful only, and nothing behind it: nobody asked for this close, so a
    // refusal is the answer rather than the first step of an escalation.
    closeIdleSession: (body, closeDeps) => closeIdleSession(body, closeDeps),
    // Did this session already accept this exact message? The last witness when a
    // confirmed send finished its delivery journal and the daemon died before
    // recording that it was confirmed. Scans the transcript, so area-session.js
    // asks it only when retrying a batch it was part-way through sending — and it
    // must be wired, because without an answer that retry cannot be made safely.
    //
    // The message carries its own delivery key on its first line, so this matches
    // one seq range's message and cannot be satisfied by an older batch that
    // happened to render the same way.
    transcriptShows: (session, text) => require('../area-session.js')
      .transcriptShowsIn(session, text, transcriptFileForSession),
    onChange: broadcast,
  });
  const areaSessionTick = (options = {}) => require('../area-session.js').tickQuietly(options, areaSessionDeps());
  startFeatureSchedulers(features, { slack, discord }, {
    onChange: broadcast,
    afterPoll: () => {
      require('../incidents.js').sweepQuietly({}, {
        // The quiet close is a lifecycle change like any other, so it reaches the
        // area agent's feed the way the poll's own events do.
        emitAgentEvent: require('../agents.js').incidentEmitter({ root: keep.ROOT }),
      });
      void areaSessionTick();
    },
  }, health);
  // Once at daemon start too: a restart must not leave an area without its
  // responder until the next poll comes round.
  setTimeout(() => { void areaSessionTick(); }, 20e3).unref();
  const configuredLiveTickMs = Number(process.env.KEEP_LIVE_TICK_MS);
  const liveTickMs = Number.isFinite(configuredLiveTickMs) && configuredLiveTickMs > 0
    ? configuredLiveTickMs
    : 120e3;
  liveSessionTick();
  setInterval(liveSessionTick, liveTickMs).unref();
  let stalledRunning = false;
  const stalledTick = async () => {
    if (stalledRunning) return;
    stalledRunning = true;
    try {
      const now = Date.now();
      const ledger = readLiveSessionLedger();
      const aliveIds = stallAliveIds(ledger, now);
      const result = await stalled.sweep({
        root: keep.ROOT, sessions: stalledSessionSnapshot(), includeAgents: true,
        ...(aliveIds ? { aliveIds } : {}),
      });
      health.record('stalled', { ok: true, cadenceMs: 60e3, detail: result.detail });
      broadcast();
    } catch (error) {
      health.record('stalled', { ok: false, cadenceMs: 60e3, error });
      process.stderr.write(`keep serve: stalled sweep failed: ${error.message}\n`);
    } finally {
      stalledRunning = false;
    }
  };
  setInterval(stalledTick, 60e3).unref();
  setTimeout(stalledTick, 5e3).unref();
  // Stop hooks feed the turn index, but a session can run for hours without
  // stopping and an agent that never loaded the hooks would be missing entirely.
  // The bound is wall time and bytes, not files: this runs on the daemon's event
  // loop, so what must stay small is how long one tick blocks it. The round-robin
  // cursor lives in the module, so the next tick resumes where this one stopped.
  let turnIndexRunning = false;
  let lastTurnIndexPruneAt = 0;
  const turnIndexTick = () => {
    if (turnIndexRunning) return;
    turnIndexRunning = true;
    try {
      const turnIndex = require('../turn-index.js');
      const result = turnIndex.ingestSessionsFromLiveState(liveTurnIndexSessions(), {
        budgetMs: TURN_INDEX_BUDGET_MS, maxBytes: TURN_INDEX_BUDGET_BYTES, busyTimeoutMs: 250,
      });
      let detail = `${result.files} files, ${result.bytes} bytes, ${result.ms} ms`
        + `${result.partial ? ', more pending' : ''}${result.skipped ? `, ${result.skipped} skipped` : ''}`;
      // Retention is a once-a-day sweep, not tick work; it rides along here so it
      // needs no second timer and shows up in the same health row.
      if (Date.now() - lastTurnIndexPruneAt >= 86400e3) {
        const pruned = turnIndex.prune({ busyTimeoutMs: 250, limit: TURN_INDEX_PRUNE_LIMIT });
        // A sweep that hit its limit keeps the clock unset so the next tick
        // continues it; only a finished sweep counts as today's prune.
        if (!pruned.more) lastTurnIndexPruneAt = Date.now();
        if (pruned.sessions) detail += `; pruned ${pruned.sessions} sessions${pruned.more ? ', more to go' : ''}`;
      }
      health.record('turn-index', { ok: true, cadenceMs: 30e3, detail });
    } catch (error) {
      health.record('turn-index', { ok: false, cadenceMs: 30e3, error });
    } finally {
      turnIndexRunning = false;
    }
  };
  // The watcher judges turns the tick above just indexed, so it runs after it.
  // Shadow mode still spends tokens: it stays off until Owner sets KEEP_WATCHER=1.
  let watcherRunning = false;
  let watcherDisabledRecorded = false;
  const watcherTick = async () => {
    if (watcherRunning) return;
    const watcher = require('../turn-watcher.js');
    if (!watcher.enabled()) {
      // Say so once, not every 30 seconds: health.record rewrites the whole file.
      if (!watcherDisabledRecorded) {
        watcherDisabledRecorded = true;
        health.record('watcher', { disabled: true, detail: 'KEEP_WATCHER is not 1' });
      }
      return;
    }
    watcherDisabledRecorded = false;
    watcherRunning = true;
    try {
      const live = require('../watcher-live.js');
      // The snapshot the dashboard just built: whether the session is mid-turn,
      // has a question on screen, or has exited is exactly what decides delivery.
      // A stale snapshot would be deciding from a session that has moved on, so
      // rescan rather than trust one older than the tick interval.
      const sessions = Date.now() - ctx.sessionSnapshotAt < 30e3 && ctx.sessionSnapshot.length
        ? ctx.sessionSnapshot : scanSessions();
      // Whichever of the two was used, the snapshot clock now describes it, so a
      // later reading means the dashboard has rebuilt since.
      const sessionsAt = ctx.sessionSnapshotAt;
      const result = await watcher.tick({
        limit: WATCHER_TURNS_PER_TICK, concurrency: WATCHER_CONCURRENCY, windowMs: WATCHER_WINDOW_MS,
        // What the console itself said about this session, recorded beside the
        // verdict so the two can be compared later (`keep watcher compare`,
        // docs/turn-watcher.md). Read as late as the verdict, from the freshest
        // list there is — a rebuild since this tick started wins.
        //
        // Only buildState's own `activity` counts. Recomputing one here would
        // run activity() without the task, dependencies and liveness buildState
        // passes it, and would record a decision the console never made; a
        // session that has left the newest snapshot has no current answer at
        // all. Either way the turn is left uncomparable rather than compared
        // against something else. Measurement only — nothing here changes what
        // the console shows.
        attentionFor: (sessionId) => {
          const pool = ctx.sessionSnapshotAt > sessionsAt && ctx.sessionSnapshot.length ? ctx.sessionSnapshot : sessions;
          const session = pool.find((candidate) => candidate.id === sessionId);
          return (session && session.activity) || null;
        },
        // The live path exists only here. It uses the same guarded send the
        // console's POST /api/send uses, so target resolution, the precheck and
        // the injection mutex all apply to a watcher message too.
        deliver: async (turn, verdict) => {
          const outcome = await live.maybeDeliver(turn, verdict, {
            session: sessions.find((candidate) => candidate.id === turn.session_id),
            // Re-read the session the same way the injection path does, so the
            // last-moment check is against what is actually on screen now.
            freshSession: (id) => loadCurrentSession(id),
            // The precondition runs inside the injection lock, immediately before
            // the characters are typed: the mutex is the only place where "nothing
            // has changed" can still be true when the keystrokes land.
            send: (payload) => watcherSend(payload),
          });
          // A drift verdict is the one event worth waking the reviewer for, so on
          // the events cadence it ticks here instead of on a ten-minute clock.
          // Deliberately NOT awaited: the wake types a whole message under the
          // injection lock, and there are only two watcher workers - holding one of
          // them for that would stall judging behind a terminal. Never fatal either:
          // the verdict and its own delivery stand on their own.
          const wake = driftWakeFromVerdict(turn, verdict);
          if (wake) {
            wake.then((woken) => {
              review.recordTickOutcome(woken);
              if (woken.sent) broadcast();
            }).catch((error) => {
              review.recordTickError(error);
              process.stderr.write(`keep review: drift wake failed: ${error && error.message || error}\n`);
            });
          }
          return outcome;
        },
        // The same transport and the same gates, minus the confidence one: this
        // is a rule match, not a judgment. Off by default like every other type.
        deliverObservation: async (turn, observation) => {
          try {
            return await live.maybeDeliverObservation(turn, observation, {
              session: sessions.find((candidate) => candidate.id === turn.session_id),
              freshSession: (id) => loadCurrentSession(id),
              send: (payload) => watcherSend(payload),
            });
          } catch (error) {
            process.stderr.write(`keep watcher: observation failed: ${error && error.message || error}\n`);
            return null;
          }
        },
      });
      health.record('watcher', {
        ok: result.failures === 0, cadenceMs: 30e3,
        detail: `${result.judged} judged, ${result.delivered} delivered, ${result.failures} model failures, ${result.ms} ms`,
        ...(result.failures ? { error: new Error(`${result.failures} watcher model failures`) } : {}),
      });
      if (result.judged) broadcast();
    } catch (error) {
      health.record('watcher', { ok: false, cadenceMs: 30e3, error });
    } finally {
      watcherRunning = false;
    }
  };
  const turnTicks = () => { turnIndexTick(); watcherTick(); };
  setInterval(turnTicks, 30e3).unref();
  setTimeout(turnTicks, 10e3).unref();
  // Drip-fold fleet transcripts for the weekly attribution: ~750MB of history on a
  // cold start, folded 24MB at a time so no state build ever blocks on it.
  // Every pass is synchronous work on this event loop, and what it produces is a
  // percentage of a WEEKLY window - 30s freshness bought nothing and cost a full
  // directory walk each time. Five minutes is still 288 folds a day.
  let fleetUsageRunning = false;
  const foldFleetUsage = async () => {
    if (fleetUsageRunning) return;
    fleetUsageRunning = true;
    const startedAt = Date.now();
    try {
      await review.foldFleetUsageInWorker(24 * 1024 * 1024);
      health.record('fleet-usage', { ok: true, detail: `${Date.now() - startedAt}ms` });
    } catch (error) {
      health.record('fleet-usage', { ok: false, error });
    } finally {
      fleetUsageRunning = false;
    }
  };
  let cardUsageRunning = false;
  const collectCardUsage = () => {
    if (cardUsageRunning) return;
    cardUsageRunning = true;
    require('child_process').execFile(process.execPath, [path.join(__dirname, '..', 'card-usage.js')], {
      env: { ...process.env, KEEP_DIR: keep.ROOT }, timeout: 120e3, maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => {
      cardUsageRunning = false;
      health.record('card-usage', { ok: !error, ...(error ? { error: new Error(stderr || error.message) } : {}) });
      broadcast();
      if (!error) {
        try { if (cardUsage.snapshot(keep.ROOT)?.backlog) setTimeout(collectCardUsage, 500).unref(); } catch {}
      }
    });
  };
  setInterval(collectCardUsage, 30e3).unref();
  setTimeout(collectCardUsage, 1000).unref();
  setInterval(foldFleetUsage, 5 * 60e3).unref();
  setTimeout(foldFleetUsage, 20e3).unref();

  startReceiptsPoller({ keep, health });

  startLoopLagProbe();
  const pull = createRegistryPull({ keep, health });
  if (process.env.KEEP_SYNC === '1') {
    health.record('git-pull', { skipped: true });
    setInterval(pull, 30 * 60e3).unref();
    setTimeout(pull, 60e3).unref();
  } else {
    health.record('git-pull', { disabled: true, detail: 'registry synchronization is off' });
  }
  // The queued-restart manager outlives this call: start()'s /api/restart-session
  // route hands it requests.
  return { restarts };
}

module.exports = {
  startFeatureSchedulers, startSchedulers, createRegistryPull, createCleanupSnapshot,
  startLoopLagProbe, startReceiptsPoller,
};
