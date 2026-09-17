'use strict';
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

function startSchedulers(ctx) {
  const {
    TURN_INDEX_BUDGET_BYTES, TURN_INDEX_BUDGET_MS, TURN_INDEX_PRUNE_LIMIT,
    WATCHER_CONCURRENCY, WATCHER_TURNS_PER_TICK, WATCHER_WINDOW_MS,
    addHostSessionState, agentProcessRows, broadcast, buildState, cardUsage, closeEphemeralPane,
    closeIdleSession, dashboardBuild, dashboardBuilder, deliverCheckToThread, deliverUnblockToThread,
    deps, discord, driftWakeFromVerdict, envNumber, features, forceRestartSession, fs, health, hostRequest,
    ideas, keep, keepConsole, landed, limitresume, listHostPanes, liveSessionTick,
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
    listPanes: () => listHostPanes({}, true),
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
      const listed = await listHostPanes(deps, true);
      const panes = Array.isArray(listed) && listed.length
        ? new Set(listed.filter((pane) => typeof pane?.id === 'string').map((pane) => pane.id)) : null;
      return withInjectionLock(() => require('../delivery').reconcile(path.join(keep.ROOT, '.keep', 'delivery'), { panes }));
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
    const cleanupSnapshot = async () => {
      // Shell verification must see new viewers/output even inside the host-list cache TTL.
      const panes = await listHostPanes({}, true);
      const state = await addHostSessionState(await buildState({ hostPanes: panes }), { panes });
      const layouts = await keepConsole.readLayouts(path.join(keep.ROOT, '.keep', 'layouts.json'));
      return {
        ...state,
        allTasks: keep.loadAll(true),
        companion: await stalled.discoverCodexJobs({ root: keep.ROOT, fallbackCacheMs: 0 }),
        pinned: new Set((layouts.layouts || []).flatMap((layout) => layout.ids || [])),
      };
    };
    require('../session-cleanup').startScheduler({
      doneIdleMs,
      snapshot: cleanupSnapshot,
      closeShell: pane => withInjectionLock(() => require('../shell-cleanup').close(pane, {
        snapshot: cleanupSnapshot,
        processes: () => agentProcessRows(),
        screen: p => readScreenResult({ pane: p.id }, null, false),
        eof: p => writeTarget({ pane: p.id }, '\x04'),
      }), { pane: pane.id }),
      close: async (body) => {
        const hostCapabilities = await hostRequest('hello');
        const result = await withInjectionLock(() => require('../manual-close').manualClose(body, {
          requireGraceful: true,
          requireSignalGuard: true,
          signalGuarded: hostCapabilities.guardedKill === true,
          protectInput: true,
          protectOutput: true,
          getPane: async (pane) => (await hostRequest('get', { pane })).pane,
          graceful: (request) => closeIdleSession(request, {
            closePolicy: {
              automatic: true,
              done: true,
              idleMs: body.doneIdleMs,
              legacyDoneAt: body.legacyDoneAt,
            },
            withInjectionLock: (fn) => fn(),
          }),
          signal: (pane, signal, guard) => hostRequest('guarded-kill', { pane, signal, ...guard }),
        }), { pane: body.pane, session: body.sessionId });
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
  const foldFleetUsage = () => {
    try {
      review.foldFleetUsage(24 * 1024 * 1024);
      health.record('fleet-usage', { ok: true });
    } catch (error) {
      health.record('fleet-usage', { ok: false, error });
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

  // pull cloud-made commits (e.g. the overnight check routine) into the local repo
  const { execFileSync } = require('child_process');
  const pull = () => {
    try {
      keep.withLock(() => {
        execFileSync('git', ['-C', keep.ROOT, 'pull', '-q', '--rebase', '--autostash'], { timeout: 30e3, stdio: 'ignore' });
      });
      health.record('git-pull', { ok: true });
    } catch (error) {
      health.record('git-pull', { ok: false, error });
    } // offline or lock contention — next tick will catch up
  };
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

module.exports = { startFeatureSchedulers, startSchedulers };
