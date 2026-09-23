'use strict';
// keep serve — the daemon's HTTP request ladder.
//
// Every handler here was moved verbatim out of the http.createServer callback in
// serve.js's start(). Nothing in this file may require ../serve.js: that would be
// a cycle, so the daemon's own internals and start()'s locals all arrive through
// `ctx`, which start() assembles once and hands to routes().
//
// The array keeps the old ladder's order, and matchRoute() reproduces its method
// rules: a POST only ever sees POST routes (serve.js answers an unmatched POST
// with the ladder's own 404 JSON), and every other method falls through the GET
// routes to the methodless tail.

function routes(ctx) {
  const {
    // serve.js internals
    ATTENTION_KINDS, InjectionError, MOBILE_VIEWS,
    abandonAccountHandoff, abandonTransfer, accounts, announceStateNote, answerSession, attentionAckKey, attentionAckName,
    cancelQueuedHandoff, closeIdleSession, codex, compactSessionById, requestSessionCompaction, companionSnapshot, consoleState,
    daemonRestartGate, dashboardDetail, fs, handoffRateLimited, handoffSessionRequest, health, hostRequest,
    inspectReviewQueueLaunch,
    keep, launchReviewQueueSession, listHostPanes, listPortableTransfers, notifications,
    openSession, path, portableTransferDraft, portableTransferPreview, preparePortableTransfer,
    prepareSessionSummary, projectMobileState, readBody, recentTranscriptText, recoverReviewQueueLaunch, reminders,
    reopenSessionOnAccount, resolvePortableTransfer, resolveReviewLaunchSelection, restorePlan, review,
    reviewDeps, reviewQueue, reviewQueueSearch, runCheckNow, runTaskNow, screenHistorySession, screenSession,
    sendSessionKeys, sendStateJson, sendToSessionLocked, sessionMarks, sessionNames, sessionSummaryFile, setAsideCandidates,
    tellSession, transferSession, updateSetAside, wantsConsoleState, withInjectionLock,
    writeToShellPane,
    // start()'s own locals. onChange and onFocus are the module-level hooks start()
    // has already pointed at its broadcaster by the time routes() is called.
    broadcast, dashboardBuild, dashboardBuilder, deps, json, onChange, onFocus, restarts, shutdown,
    terminalProfile,
  } = ctx;

  // The node API's routes exist only where the daemon listens for nodes: on a
  // single-node install they match nothing, and a request for one is the same 404
  // it always was. ctx is read at request time, not destructured, so a caller that
  // builds this list without them gets that 404 too.
  const nodeApiEnabled = () => typeof ctx.nodeApiEnabled === 'function' && ctx.nodeApiEnabled() === true;
  const NODE_API_ALLOW = ['node', 'admin', 'local'];

  return withLoopHolds([
    {
      // A pane-only node's registry command, run by the daemon's own CLI
      // (bin/registry-route.js holds every rule about what may run).
      method: 'POST',
      path: '/api/registry',
      allow: NODE_API_ALLOW,
      when: nodeApiEnabled,
      handle: async ({ res, body, principal }) => {
        const result = await ctx.registryService.handle(principal, body);
        return json(res, result.status, result.body);
      },
    },
    {
      // A Claude hook on a pane-only node, run by the daemon's own `keep hook`
      // against the session's transcript mirror (bin/hook-route.js).
      method: 'POST',
      path: '/api/hook',
      allow: NODE_API_ALLOW,
      when: nodeApiEnabled,
      handle: async ({ res, body, principal }) => {
        const result = await ctx.hookService.handle(principal, body);
        return json(res, result.status, result.body);
      },
    },
    {
      // What a node's pre-bash hook needs before it posts: the step fingerprints
      // and whether the session is a self-repair agent (bin/hook-route.js).
      method: 'GET',
      path: '/api/hook/context',
      allow: ['node'],
      when: nodeApiEnabled,
      handle: async ({ res, url, principal }) => {
        const result = ctx.hookService.context(principal, url.searchParams.get('session'));
        return json(res, result.status, result.body);
      },
    },
    {
      method: 'GET',
      path: '/api/registry/ping',
      allow: NODE_API_ALLOW,
      when: nodeApiEnabled,
      handle: async ({ res, principal }) => {
        const result = ctx.registryService.ping(principal);
        return json(res, result.status, result.body);
      },
    },
    {
      // A node landed keep-tool; the daemon fast-forwards its own checkout and
      // restarts, with wt land's refusals (bin/deploy-self.js).
      method: 'POST',
      path: '/api/deploy-self',
      allow: NODE_API_ALLOW,
      when: nodeApiEnabled,
      handle: async ({ res, body, principal }) => {
        // As in registry-route.callerNode: no node token speaks for the daemon node.
        if (principal && principal.class === 'node' && principal.node === require('../nodes.js').daemonNode()) {
          return json(res, 403, { error: 'unauthorized' });
        }
        const result = await ctx.deploySelf.handle(body);
        return json(res, result.status, result.body);
      },
    },
    {
      method: 'GET',
      path: '/api/terminal-profile',
      handle: async ({ req, res, url }) => {
        try {
          return json(res, 200, terminalProfile.view(
            url.searchParams.get('pane'), url.searchParams.get('runtime'),
          ));
        } catch (error) {
          return json(res, error.status || 500, { error: error.message });
        }
      },
    },
    {
      method: 'GET',
      path: '/api/ui-debug',
      handle: async ({ req, res, url }) => {
        return json(res, 200, { events: require('../ui-debug').read() });
      },
    },
    {
      method: 'GET',
      path: '/api/session-debug',
      handle: async ({ req, res, url }) => {
        return json(res, 200, { events: require('../session-debug').read(url.searchParams.get('session')) });
      },
    },
    {
      method: 'GET',
      path: '/api/accounts',
      handle: async ({ req, res, url }) => {
        if (req.headers['x-keep'] !== '1') return json(res, 403, { error: 'missing x-keep header' });
        try {
          return json(res, 200, { ok: true, ...accounts.publicState(), handoffs: require('../account-handoff').list(keep.ROOT) });
        } catch (error) { return json(res, 500, { error: error.message }); }
      },
    },
    {
      method: 'GET',
      path: '/api/portable-transfers',
      handle: async ({ req, res, url }) => {
        if (req.headers['x-keep'] !== '1') return json(res, 403, { error: 'missing x-keep header' });
        try { return json(res, 200, { ok: true, transfers: listPortableTransfers() }); }
        catch (error) { return json(res, error.status || 500, { error: error.message }); }
      },
    },
    {
      method: 'GET',
      path: '/api/dashboard-detail',
      handle: async ({ req, res, url }) => {
        const state = dashboardBuilder.latest();
        if (!state) return json(res, 503, { error: 'dashboard state is still loading' });
        try { return json(res, 200, dashboardDetail(state, url.searchParams.get('kind'), url.searchParams.get('id'))); }
        catch (error) { return json(res, error.status === 400 || error.status === 404 ? error.status : 500, { error: error.message }); }
      },
    },
    {
      method: 'GET',
      path: '/api/dashboard-review-search',
      handle: async ({ req, res, url }) => {
        const state = dashboardBuilder.latest();
        if (!state) return json(res, 503, { error: 'dashboard state is still loading' });
        try { return json(res, 200, reviewQueueSearch(state, url.searchParams.get('q') || '')); }
        catch (error) { return json(res, error.status === 400 || error.status === 404 ? error.status : 500, { error: error.message }); }
      },
    },
    {
      method: 'GET',
      path: '/api/portable-transfer-draft',
      handle: async ({ req, res, url }) => {
        if (req.headers['x-keep'] !== '1') return json(res, 403, { error: 'missing x-keep header' });
        try { return json(res, 200, await portableTransferDraft(url.searchParams)); }
        catch (error) { return json(res, error.status || 500, { error: error.message }); }
      },
    },
    {
      method: 'GET',
      path: '/api/portable-transfer-preview',
      handle: async ({ req, res, url }) => {
        if (req.headers['x-keep'] !== '1') return json(res, 403, { error: 'missing x-keep header' });
        try { return json(res, 200, portableTransferPreview(url.searchParams)); }
        catch (error) { return json(res, error.status || 500, { error: error.message }); }
      },
    },
    {
      method: 'GET',
      path: '/api/restore-plan',
      handle: async ({ req, res, url }) => {
        if (req.headers['x-keep'] !== '1') return json(res, 403, { error: 'missing x-keep header' });
        try { return json(res, 200, await restorePlan(url.searchParams)); }
        catch (error) {
          if (error instanceof InjectionError) return json(res, error.status, { error: error.message, ...error.extra });
          throw error;
        }
      },
    },
    {
      method: 'GET',
      path: '/api/sessionsummary',
      handle: async ({ req, res, url }) => {
        const id = url.searchParams.get('id') || '';
        if (!/^[A-Za-z0-9_-]+$/.test(id)) return json(res, 400, { error: 'bad session id' });
        const current = dashboardBuilder.latest();
        if (!current) return json(res, 503, { error: 'dashboard state is still loading' });
        const session = current.sessions?.find((s) => s.id === id);
        const file = sessionSummaryFile(session, { publishedOnly: true });
        if (!session || !file) return json(res, 404, { error: 'no session' });
        // The dashboard snapshot identifies the session; the transcript itself is
        // still read now, so summary input includes bytes written after that scan.
        let result;
        try { result = prepareSessionSummary(session, { priority: -1 }, { file }); }
        catch (error) {
          if (error.code === 'ENOENT') return json(res, 404, { error: 'no session' });
          throw error;
        }
        return json(res, 200, { text: result.text, fresh: result.fresh });
      },
    },
    // Shadow decisions the watcher recorded and Owner has not graded yet. The
    // state payload already carries the newest one per session; this is for the
    // edit flow and for refreshing after a grade.
    {
      method: 'GET',
      path: '/api/decisions',
      handle: async ({ req, res, url }) => {
        const session = url.searchParams.get('session') || '';
        if (!/^[A-Za-z0-9_-]+$/.test(session)) return json(res, 400, { error: 'bad session id' });
        if (url.searchParams.get('pending') !== '1') return json(res, 400, { error: 'only pending=1 is supported' });
        return json(res, 200, {
          decisions: require('../turn-watcher.js').pendingDecisionsForSession(session),
        });
      },
    },
    {
      method: 'GET',
      path: '/api/sessiontail',
      handle: async ({ req, res, url }) => {
        const id = url.searchParams.get('id') || '';
        if (!/^[A-Za-z0-9_-]+$/.test(id)) return json(res, 400, { error: 'bad session id' });
        const current = dashboardBuilder.latest();
        if (!current) return json(res, 503, { error: 'dashboard state is still loading' });
        const session = current.sessions?.find((s) => s.id === id);
        const file = sessionSummaryFile(session, { publishedOnly: true });
        if (!session || !file) return json(res, 404, { error: 'no session' });
        let text;
        try { text = session.kind === 'codex' ? codex.recentText(file)
          : session.kind === 'pi' ? require('../pi').recentText(file) : recentTranscriptText(file); }
        catch (error) {
          if (error.code === 'ENOENT') return json(res, 404, { error: 'no session' });
          throw error;
        }
        return json(res, 200, { text });
      },
    },
    {
      method: 'GET',
      path: '/api/screen',
      handle: async ({ req, res, url }) => {
        // The header forces a CORS preflight, so a hostile page cannot even trigger the read.
        if (req.headers['x-keep'] !== '1') return json(res, 403, { error: 'missing x-keep header' });
        try { return json(res, 200, await screenSession(url.searchParams)); }
        catch (error) {
          if (error instanceof InjectionError) return json(res, error.status, { error: error.message });
          throw error;
        }
      },
    },
    {
      method: 'GET',
      path: '/api/screen/history',
      handle: async ({ req, res, url }) => {
        if (req.headers['x-keep'] !== '1') return json(res, 403, { error: 'missing x-keep header' });
        try { return json(res, 200, await screenHistorySession(url.searchParams)); }
        catch (error) {
          if (error instanceof InjectionError) return json(res, error.status, { error: error.message });
          throw error;
        }
      },
    },
    {
      method: 'GET',
      path: /^\/api\/agents\/[^/]+\/events$/,
      handle: async ({ req, res, url }) => {
        if (req.headers['x-keep'] !== '1') return json(res, 403, { error: 'missing x-keep header' });
        const agents = require('../agents.js');
        const name = agents.nameFromPath(url.pathname);
        if (!name) return json(res, 400, { error: 'bad agent name' });
        try {
          return json(res, 200, {
            ok: true, name,
            events: agents.readEvents(name, {
              root: keep.ROOT,
              limit: Number(url.searchParams.get('limit')) || agents.DEFAULT_EVENT_LIMIT,
              unseen: url.searchParams.get('unseen') === '1',
            }),
          });
        } catch (error) { return json(res, error.status || 500, { error: error.message }); }
      },
    },
    {
      method: 'POST',
      path: /^\/api\/agents\/[^/]+\/seen$/,
      handle: async ({ req, res, url, body }) => {
        const agents = require('../agents.js');
        const name = agents.nameFromPath(url.pathname);
        if (!name) return json(res, 400, { error: 'bad agent name' });
        try {
          const result = agents.markSeen(name, Number(body && body.until) || Date.now(), { root: keep.ROOT });
          agents.flushCommits(keep.ROOT);
          broadcast();
          return json(res, 200, { ok: true, name, ...result });
        } catch (error) { return json(res, error.status || 500, { error: error.message }); }
      },
    },
    {
      method: 'POST',
      path: '/api/terminal-profile',
      handle: async ({ req, res, url, body }) => {
        try { return json(res, 200, terminalProfile.act(body)); }
        catch (error) { return json(res, error.status || 500, { error: error.message }); }
      },
    },
    {
      method: 'POST',
      path: '/api/restart-daemon',
      handle: async ({ req, res, url, body }) => {
        try {
          const result = await daemonRestartGate.prepareWhenIdle();
          // launchd KeepAlive starts the new daemon. The terminal host and
          // its PTYs are separate processes and are not stopped here. The
          // request is marked right before exit so the new start is not read
          // as a crash, and a daemon that dies before this point is.
          setTimeout(() => { health.recordRestartRequest(); shutdown(); }, 50);
          return json(res, 200, result);
        } catch (error) { return json(res, 409, { error: error.message }); }
      },
    },
    {
      method: 'POST',
      path: '/api/notifications',
      handle: async ({ req, res, url, body }) => {
        let result;
        try { result = notifications.update(keep.ROOT, body); }
        catch (error) { return json(res, 400, { error: error.message }); }
        broadcast();
        return json(res, 200, result);
      },
    },
    {
      method: 'POST',
      path: '/api/reminders',
      handle: async ({ req, res, url, body }) => {
        let result;
        try { result = reminders.update(body); }
        catch (error) { return json(res, 400, { error: error.message }); }
        broadcast();
        return json(res, 200, result);
      },
    },
    {
      method: 'POST',
      path: '/api/review-queue',
      handle: async ({ req, res, url, body }) => {
        try {
          const result = await reviewQueue.act(body, {
            resolveLaunchSelection: (selection) => resolveReviewLaunchSelection(selection),
            launch: (request) => launchReviewQueueSession(request),
            inspectLaunch: (active) => inspectReviewQueueLaunch(active),
            recoverLaunch: (active, hooks) => recoverReviewQueueLaunch(active, hooks),
          });
          broadcast();
          return json(res, 200, result);
        } catch (error) {
          if (error instanceof reviewQueue.QueueError) {
            return json(res, error.status, { error: error.message, ...error.extra });
          }
          return json(res, 502, { error: String(error && error.message || error).slice(0, 500) });
        }
      },
    },
    {
      method: 'POST',
      path: '/api/reopen-session',
      handle: async ({ req, res, url, body }) => {
        try {
          const result = await reopenSessionOnAccount(body);
          broadcast();
          return json(res, 200, result);
        } catch (error) {
          if (error instanceof InjectionError) return json(res, error.status, { error: error.message, ...error.extra });
          return json(res, Number(error.status) || 502, { error: String(error && error.message || error).slice(0, 500), ...error.extra });
        }
      },
    },
    {
      method: 'POST',
      path: '/api/add',
      handle: async ({ req, res, url, body }) => {
        const task = keep.addTask({
          title: body.title, kind: body.kind, tags: body.tags, project: body.project,
          checkAfter: body.checkAfter, check: body.check, status: body.status, note: body.note,
          experimentId: body.experimentId,
        });
        return json(res, 200, { ok: true, id: task.id });
      },
    },
    // Owner grading a shadow verdict from the console. decisions.judge
    // takes the registry lock, exactly as `keep decisions` does, so the
    // console and the CLI cannot both write the ledger at once.
    {
      method: 'POST',
      path: '/api/decisions/judge',
      handle: async ({ req, res, url, body }) => {
        const watcher = require('../turn-watcher.js');
        const decisions = require('../decisions.js');
        if (!body || typeof body.id !== 'string' || !body.id) return json(res, 400, { error: 'a decision id is required' });
        if (!decisions.VERDICTS.includes(body.verdict)) {
          return json(res, 400, { error: `verdict must be one of: ${decisions.VERDICTS.join(', ')}` });
        }
        // The ledger's reason is read back by the reviewer; an object coerced to
        // "[object Object]" would corrupt it, so only a real string gets through.
        if (body.message !== undefined && typeof body.message !== 'string') {
          return json(res, 400, { error: 'message must be a string' });
        }
        if (body.verdict !== 'agree' && !(typeof body.message === 'string' && body.message.trim())) {
          return json(res, 400, { error: `${body.verdict} needs a non-empty message` });
        }
        try {
          const result = watcher.judgeDecision(body.id, body.verdict, body.message);
          broadcast();
          return json(res, 200, { ok: true, id: result.entry.id, type: result.entry.type,
            verdict: result.entry.verdict, stats: result.stats, totals: result.totals });
        } catch (error) {
          if (error instanceof decisions.DecisionError) return json(res, 400, { error: error.message });
          throw error;
        }
      },
    },
    {
      method: 'POST',
      path: '/api/notes/announce',
      handle: async ({ req, res, url, body }) => {
        if (!body || typeof body.id !== 'string' || !/^note-[a-z0-9]+$/.test(body.id)) {
          return json(res, 400, { error: 'a state note id is required' });
        }
        const result = await announceStateNote(body.id);
        if (result.duplicate) return json(res, 409, result);
        if (result.error) return json(res, 404, result);
        broadcast();
        return json(res, 200, result);
      },
    },
    {
      method: 'POST',
      path: '/api/checkin',
      handle: async ({ req, res, url, body }) => {
        keep.checkinTask(body.id, {
          message: body.message, status: body.status,
          checkAfter: body.checkAfter, clearCheckAfter: body.clearCheckAfter,
          experimentId: body.experimentId,
        });
        broadcast();
        return json(res, 200, { ok: true });
      },
    },
    // The console Queue's Inbox rows: Done and Dismiss both close the card, and
    // the log line says which. Only an inbox card: a card someone started since
    // the row was drawn is refused rather than closed under them.
    {
      method: 'POST',
      path: '/api/inbox-card',
      handle: async ({ req, res, url, body }) => {
        const messages = { done: 'done from console inbox', dismiss: 'dismissed from console inbox' };
        if (!body || typeof body.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(body.id)) {
          return json(res, 400, { error: 'a card id is required' });
        }
        if (!Object.hasOwn(messages, body.action)) return json(res, 400, { error: 'action must be done or dismiss' });
        try {
          keep.checkinTask(body.id, {
            message: messages[body.action], status: 'done', expectStatus: 'inbox',
            heading: 'console', linkSession: false,
          });
        } catch (error) {
          if (error?.code === 'STATUS_CHANGED') return json(res, 409, { error: error.message });
          if (error instanceof keep.KeepError) return json(res, 400, { error: error.message });
          throw error;
        }
        broadcast();
        return json(res, 200, { ok: true, id: body.id, action: body.action });
      },
    },
    {
      method: 'POST',
      path: '/api/ack',
      handle: async ({ req, res, url, body }) => {
        const hasSessionId = Object.prototype.hasOwnProperty.call(body, 'sessionId');
        const hasTaskId = Object.prototype.hasOwnProperty.call(body, 'taskId');
        const isHealth = body.kind === 'health' && typeof body.id === 'string' && /^health:[A-Za-z0-9._-]+$/.test(body.id);
        const isStalled = body.kind === 'stalled' && typeof body.id === 'string' && /^stalled:[A-Za-z0-9._:-]+$/.test(body.id);
        const validId = /^[A-Za-z0-9._-]+$/;
        if (!ATTENTION_KINDS.has(body.kind) || (isHealth ? hasSessionId || hasTaskId : isStalled ? hasSessionId && hasTaskId : hasSessionId === hasTaskId) ||
            (hasSessionId && (typeof body.sessionId !== 'string' || !validId.test(body.sessionId))) ||
            (hasTaskId && (typeof body.taskId !== 'string' || !validId.test(body.taskId))) ||
            !['number', 'string'].includes(typeof body.since)) {
          return json(res, 400, { error: 'bad attention acknowledgement' });
        }
        let ackItem = body;
        if (isHealth) {
          const current = health.attentionItems(health.snapshot()).find((item) => item.id === body.id);
          if (!current) return json(res, 400, { error: 'health alert is no longer current' });
          ackItem = { ...body, errorText: current.lastError || '', incidentId: current.incidentId || null };
        }
        const key = attentionAckKey(ackItem);
        const ackDir = path.join(keep.ROOT, '.keep', 'acks');
        try {
          fs.mkdirSync(ackDir, { recursive: true });
          fs.writeFileSync(path.join(ackDir, attentionAckName(key)), JSON.stringify({ key, at: Date.now() }) + '\n');
          if (hasSessionId) require('../session-retirement').acknowledge(keep.ROOT, body.sessionId);
        } catch (e) {
          process.stderr.write(`keep serve: acknowledgement failed: ${e.message}\n`);
          return json(res, 500, { error: 'could not save acknowledgement' });
        }
        try {
          const cutoff = Date.now() - 14 * 864e5;
          for (const name of fs.readdirSync(ackDir)) {
            try {
              const file = path.join(ackDir, name);
              if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
            } catch {}
          }
        } catch {}
        broadcast();
        return json(res, 200, { ok: true });
      },
    },
    {
      method: 'POST',
      path: '/api/setaside',
      handle: async ({ req, res, url, body }) => {
        try {
          // The key came from what the console rendered, so validate it against the
          // state that was published to it (read live off ctx, never destructured).
          // A fresh host list can time out under load, and a rebuild with no panes
          // then hides every hosted session and rejects a key that is perfectly good.
          let state = ctx.publishedState;
          if (!state) {
            // Nothing published yet: build once, and treat a silent host as no panes rather than failing.
            const panes = await listHostPanes(deps);
            state = await dashboardBuild({ hostPanes: panes || [] });
          }
          // setAsideCandidates writes onto the items it is handed; the published
          // state's own objects must not be mutated in place.
          const attention = (state.attention || []).map((item) => ({ ...item }));
          const entry = updateSetAside(body, setAsideCandidates(attention, state.sessions || []));
          broadcast();
          return json(res, 200, { ok: true, entry });
        } catch (error) {
          if (error instanceof InjectionError) return json(res, error.status, { error: error.message });
          throw error;
        }
      },
    },
    {
      method: 'POST',
      path: '/api/ui-debug',
      handle: async ({ req, res, url, body }) => {
        try { require('../ui-debug').record(body.events); return json(res, 200, { ok: true }); }
        catch (error) { return json(res, 400, { error: error.message }); }
      },
    },
    {
      method: 'POST',
      path: '/api/run',
      handle: async ({ req, res, url, body }) => {
        try {
          const result = body.kind === 'check' ? await runCheckNow(body.id) : await runTaskNow(body.id, body.prompt);
          broadcast();
          return json(res, 200, result);
        } catch (e) {
          if (e instanceof InjectionError) return json(res, e.status, { error: e.message, ...e.extra });
          if (e instanceof keep.KeepError) return json(res, 400, { error: e.message });
          return json(res, 502, { error: String(e && e.message || e).slice(0, 500) });
        }
      },
    },
    // A name Owner typed replaces the generated title and switches generation off
    // for that session; an empty title clears the name and hands it back.
    {
      method: 'POST',
      path: '/api/rename-session',
      handle: async ({ req, res, url, body }) => {
        const sessionId = String(body && body.sessionId || '');
        if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return json(res, 400, { error: 'bad session id' });
        if (typeof (body && body.title) !== 'string') return json(res, 400, { error: 'title must be a string' });
        let result;
        try { result = sessionNames.set(sessionId, body.title, { root: keep.ROOT }); }
        catch (error) { return json(res, 500, { error: `could not save the name: ${String(error && error.message || error).slice(0, 200)}` }); }
        broadcast();
        return json(res, 200, { ok: true, sessionId, title: result.title });
      },
    },
    // A mark is Owner's own color and emoji on a session, independent of its name.
    // Each field is an instruction: absent leaves it alone, null or '' removes it,
    // a string sets it. `mark` comes back null when nothing is left.
    {
      method: 'POST',
      path: '/api/mark-session',
      handle: async ({ req, res, url, body }) => {
        const sessionId = String(body && body.sessionId || '');
        if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return json(res, 400, { error: 'bad session id' });
        const patch = {};
        for (const field of ['color', 'emoji']) {
          if (!body || !Object.prototype.hasOwnProperty.call(body, field) || body[field] === undefined) continue;
          if (body[field] !== null && typeof body[field] !== 'string') return json(res, 400, { error: `${field} must be a string` });
          patch[field] = body[field];
        }
        let result;
        try { result = sessionMarks.set(sessionId, patch, { root: keep.ROOT }); }
        catch (error) {
          const message = String(error && error.message || error);
          if (message === 'bad color' || message === 'bad emoji') return json(res, 400, { error: message });
          return json(res, 500, { error: `could not save the mark: ${message.slice(0, 200)}` });
        }
        broadcast();
        return json(res, 200, { ok: true, sessionId, mark: result.mark });
      },
    },
    {
      method: 'POST',
      path: '/api/session-keep-running',
      handle: async ({ req, res, url, body }) => {
        const sessionId = String(body && body.sessionId || '');
        if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || typeof body?.keepRunning !== 'boolean'
            || Object.keys(body || {}).some((key) => !['sessionId', 'keepRunning'].includes(key))) {
          return json(res, 400, { error: 'Expected exact sessionId and boolean keepRunning' });
        }
        let result;
        try { result = require('../session-retirement').setKeepRunning(keep.ROOT, sessionId, body.keepRunning); }
        catch (error) { return json(res, 500, { error: `could not save keep-running preference: ${error.message}` }); }
        broadcast();
        return json(res, 200, { ok: true, ...result });
      },
    },
    {
      method: 'POST',
      path: '/api/focus',
      handle: async ({ req, res, url, body }) => {
        const sessionId = String(body && body.sessionId || '');
        if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return json(res, 400, { error: 'bad session id' });
        onFocus(sessionId);
        return json(res, 200, { ok: true, focus: 'console', sessionId });
      },
    },
    // A shell pane has no session to lock against and no agent to interrupt.
    {
      method: 'POST',
      path: '/api/send',
      when: ({ body }) => Boolean(body && body.pane && !body.sessionId),
      handle: async ({ req, res, url, body }) => {
        try { return json(res, 200, await writeToShellPane(body)); }
        catch (e) {
          if (e instanceof InjectionError) return json(res, e.status, { error: e.message });
          return json(res, 502, { error: String(e && e.message || e).slice(0, 500) });
        }
      },
    },
    // `keep compact` from inside a session: a request the idle tick carries out, not a
    // compaction now. No injection lock, because nothing is typed here. Its own path,
    // not a field on /api/compact: a daemon older than the CLI answers an unknown path
    // with a 404, where it would read the request as "compact now" and type /compact
    // into the calling session mid-turn.
    {
      method: 'POST',
      path: '/api/compact-request',
      handle: async ({ res, body }) => {
        try { return json(res, 200, requestSessionCompaction(body)); }
        catch (e) {
          if (e instanceof InjectionError) return json(res, e.status, { error: e.message });
          return json(res, 500, { error: String(e && e.message || e).slice(0, 500) });
        }
      },
    },
    {
      method: 'POST',
      path: ['/api/open', '/api/send', '/api/compact', '/api/answer'],
      handle: async ({ req, res, url, body }) => {
        // Each call locks only its own session and pane (compaction also the model
        // key); a collision there is the same 429 the global lock used to return.
        const sessionId = body && body.sessionId;
        // An Open from the console Queue's Inbox row: the card must still be in the
        // inbox, or nothing launches (another tab may have closed or started it
        // while the chooser was up). A launch that succeeds moves it to active, so
        // the row leaves the inbox and its Done and Dismiss can no longer close a
        // card that now has a session working on it. The move is guarded on the
        // card still being inbox, under the registry lock.
        const fromInbox = url.pathname === '/api/open' && body && body.fromInbox === true;
        if (fromInbox) {
          if (typeof body.taskId !== 'string' || !body.taskId) return json(res, 400, { error: 'an inbox open needs a card id' });
          let card = null;
          try { card = keep.loadTask(body.taskId); } catch {}
          if (!card) return json(res, 400, { error: 'no task' });
          if (card.fm.status !== 'inbox') {
            return json(res, 409, { error: `${body.taskId} is ${card.fm.status || 'unset'}, not inbox`, code: 'NOT_INBOX' });
          }
          delete body.fromInbox;
        }
        try {
          const result = url.pathname === '/api/open' ? await openSession(body)
            : url.pathname === '/api/send' ? await sendToSessionLocked(body)
              : url.pathname === '/api/compact'
                ? await withInjectionLock(() => compactSessionById(body), { session: sessionId, model: true })
                : await withInjectionLock(() => answerSession(body), { session: sessionId });
          if (fromInbox) {
            try {
              keep.checkinTask(body.taskId, {
                message: 'opened from console inbox', status: 'active', expectStatus: 'inbox',
                heading: 'console', linkSession: false,
              });
            } catch (error) {
              // The session is running and linked, so the request has succeeded
              // whatever happens to the card: a failure here must not read as a
              // failed open, or a retry would launch a second session. Closed or
              // started elsewhere while it launched, a busy lock, a git failure,
              // an archived card: the card keeps whatever status it has, and the
              // console says which.
              let status = 'unknown';
              try { status = keep.loadTask(body.taskId).fm.status || 'unset'; } catch {}
              const reason = String(error?.message || error).split('\n')[0].slice(0, 300);
              if (error?.code !== 'STATUS_CHANGED') {
                process.stderr.write(`keep serve: inbox open of ${body.taskId} launched, but the card was not moved to active: ${reason}\n`);
              }
              result.statusWarning = `card left ${status}: ${reason}`;
            }
          }
          broadcast();
          return json(res, 200, result);
        } catch (e) {
          if (e instanceof InjectionError) return json(res, e.status, { error: e.message, ...e.extra });
          return json(res, 502, { error: String(e && e.message || e).slice(0, 500) });
        }
      },
    },
    // One session addressing another. Its own route rather than a shape of /api/send:
    // the guards, the frame and the hourly brake all belong to this path, and the
    // refusal reason rides back in the body so `keep tell --wait` can tell a session
    // that is merely mid-turn from one that is waiting on Owner.
    {
      method: 'POST',
      path: '/api/tell',
      handle: async ({ req, res, url, body }) => {
        try {
          const result = await tellSession(body);
          broadcast();
          return json(res, 200, result);
        } catch (e) {
          if (e instanceof InjectionError) return json(res, e.status, { error: e.message, ...e.extra });
          return json(res, 502, { error: String(e && e.message || e).slice(0, 500) });
        }
      },
    },
    {
      method: 'POST',
      path: '/api/restart-session',
      handle: async ({ req, res, url, body }) => {
        try { return json(res, 200, await restarts.request(body)); }
        catch (error) { return json(res, error.status || 409, { error: error.message }); }
      },
    },
    {
      // One session's transfer, for the console button and for `keep handoff` alike.
      // A caller that sends `queueOnTransient` asks for a refusal that clears on its
      // own to join the retry queue instead of ending here; the answer is then
      // `{ status: 'queued' }` and the CLI, which does not ask, still sees the refusal.
      method: 'POST',
      path: '/api/handoff-session',
      handle: async ({ req, res, url, body }) => {
        try {
          const result = await handoffSessionRequest(body);
          broadcast();
          return json(res, 200, result);
        } catch (error) {
          return json(res, error.status || 500, { error: error.message, ...(error.extra || {}) });
        }
      },
    },
    {
      // keep move: a Claude session from one node to another (bin/session-move.js).
      // The daemon node's own callers only: the CLI arrives through the UI worker as
      // the proxy class, the console as proxy too (no button yet), and no node may
      // ask for one, so this is the default allow list with node left out.
      method: 'POST',
      path: '/api/move-session',
      allow: ['proxy', 'local', 'admin'],
      handle: async ({ res, body }) => {
        try {
          const result = await ctx.moveSession(body);
          broadcast();
          return json(res, 200, result);
        } catch (error) {
          // A move that stopped part way was journalled as recovery-needed: the
          // console's reload after this 409 must see Retry and Abandon, so it is fenced.
          if (error.extra && error.extra.status === 'recovery-needed') {
            res.keepStateChanged = true;
            broadcast();
          }
          return json(res, error.status || 500, { error: error.message, ...(error.extra || {}) });
        }
      },
    },
    {
      // The batch behind "Move N rate-limited sessions": it only enqueues, and the
      // daemon's queue tick performs each transfer through the same handoffSession
      // this ladder's /api/handoff-session calls.
      method: 'POST',
      path: '/api/handoff-rate-limited',
      handle: async ({ req, res, url, body }) => {
        if (req.headers['x-keep'] !== '1') return json(res, 403, { error: 'missing x-keep header' });
        try {
          const result = await handoffRateLimited(body);
          broadcast();
          return json(res, 200, result);
        } catch (error) {
          return json(res, error.status || 500, { error: error.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/api/handoff-queue-cancel',
      handle: async ({ req, res, url, body }) => {
        if (req.headers['x-keep'] !== '1') return json(res, 403, { error: 'missing x-keep header' });
        try {
          const result = cancelQueuedHandoff(body);
          broadcast();
          return json(res, 200, result);
        } catch (error) {
          return json(res, error.status || 500, { error: error.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/api/abandon-transfer',
      handle: async ({ req, res, url, body }) => {
        if (req.headers['x-keep'] !== '1') return json(res, 403, { error: 'missing x-keep header' });
        try {
          const result = abandonTransfer(body);
          broadcast();
          return json(res, 200, result);
        } catch (error) {
          return json(res, error.status || 500, { error: error.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/api/abandon-account-handoff',
      handle: async ({ req, res, url, body }) => {
        try {
          const result = await abandonAccountHandoff(body);
          broadcast();
          return json(res, 200, result);
        } catch (error) {
          return json(res, error.status || 500, { error: error.message, ...(error.extra || {}) });
        }
      },
    },
    {
      method: 'POST',
      path: '/api/transfer-session',
      handle: async ({ req, res, url, body }) => {
        try {
          const result = await transferSession(body);
          broadcast();
          return json(res, 200, result);
        } catch (error) {
          return json(res, error.status || 500, { error: error.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/api/portable-transfers',
      handle: async ({ req, res, url, body }) => {
        try {
          const result = await preparePortableTransfer(body);
          broadcast();
          return json(res, 200, result);
        } catch (error) {
          return json(res, error.status || 500, { error: error.message });
        }
      },
    },
    {
      method: 'POST',
      path: '/api/resolve-portable-transfer',
      handle: async ({ req, res, url, body }) => {
        try {
          const result = await resolvePortableTransfer(body);
          broadcast();
          return json(res, 200, result);
        } catch (error) {
          return json(res, error.status || 500, { error: error.message });
        }
      },
    },
    {
      method: 'POST',
      path: ['/api/close-idle', '/api/close-session'],
      handle: async ({ req, res, url, body }) => {
        try {
          const result = url.pathname === '/api/close-session'
            ? await require('../manual-close').manualClose(body, {
              getPane: async (pane) => (await hostRequest('get', { pane })).pane,
              graceful: (request) => closeIdleSession(request, { closePolicy: { manual: true } }),
              signal: (pane, signal) => hostRequest('kill', { pane, signal }),
            })
            : await closeIdleSession(body);
          broadcast(); return json(res, 200, result);
        }
        catch (e) { return json(res, e.status || 500, { error: e.message }); }
      },
    },
    {
      method: 'POST',
      path: '/api/keys',
      handle: async ({ req, res, url, body }) => {
        try { return json(res, 200, await sendSessionKeys(body)); }
        catch (e) {
          if (e instanceof InjectionError) return json(res, e.status, { error: e.message });
          return json(res, 502, { error: String(e && e.message || e).slice(0, 500) });
        }
      },
    },
    {
      method: 'POST',
      path: '/api/reviewtick',
      handle: async ({ req, res, url, body }) => {
        // The tick's send locks only the reviewer's pane. A collision there throws the
        // same 429, and landing it in the catch records the healthy skip the scheduler would.
        try {
          const result = await review.reviewTick(reviewDeps, { force: Boolean(body.force) });
          review.recordTickOutcome(result);
          if (result.sent) broadcast();
          return json(res, 200, result);
        } catch (e) {
          review.recordTickError(e);
          if (e instanceof InjectionError) return json(res, e.status, { error: e.message, ...e.extra });
          return json(res, 502, { error: String(e && e.message || e).slice(0, 500) });
        }
      },
    },
    // The phones registered for Expo push. All three carry `x-keep: 1` like the
    // other writes: a cookie session is same-site with every other service on
    // this host, and that header is what such a page cannot add.
    {
      method: 'POST',
      path: '/api/devices',
      handle: async ({ req, res, url, body }) => {
        if (req.headers['x-keep'] !== '1') return json(res, 403, { error: 'missing x-keep header' });
        try { return json(res, 200, require('../devices.js').register(body || {}, keep.ROOT)); }
        catch (error) { return json(res, error.status || 500, { error: error.message }); }
      },
    },
    {
      method: 'DELETE',
      path: '/api/devices',
      handle: async ({ req, res, url }) => {
        if (req.headers['x-keep'] !== '1') return json(res, 403, { error: 'missing x-keep header' });
        // Only POST bodies are read by the ladder; a DELETE reads its own.
        let body;
        try { body = await readBody(req); } catch (error) { return json(res, 400, { error: error.message }); }
        try { return json(res, 200, require('../devices.js').unregister(body && body.expoPushToken, keep.ROOT)); }
        catch (error) { return json(res, error.status || 500, { error: error.message }); }
      },
    },
    {
      method: 'GET',
      path: '/api/devices',
      handle: async ({ req, res, url }) => {
        if (req.headers['x-keep'] !== '1') return json(res, 403, { error: 'missing x-keep header' });
        try { return json(res, 200, { ok: true, devices: require('../devices.js').publicList(keep.ROOT) }); }
        catch (error) { return json(res, error.status || 500, { error: error.message }); }
      },
    },
    {
      method: null,
      path: '/api/panes',
      handle: async ({ res }) => {
        const panes = await listHostPanes({}, true);
        return json(res, 200, panes ? { panes, host: true } : { panes: [], host: false });
      },
    },
    {
      method: null,
      path: '/api/state',
      handle: async ({ req, res, url }) => {
        const mobileView = url.searchParams.get('view');
        if (mobileView && !MOBILE_VIEWS.has(mobileView)) return json(res, 400, { error: `unknown mobile state view: ${mobileView}` });
        const panes = await listHostPanes(deps);
        await reviewQueue.reconcile({
          // Reconciliation may authorize a replacement launch after absence, so
          // it must bypass the dashboard host-list cache and inspect a complete list.
          inspectLaunch: (active) => inspectReviewQueueLaunch(active),
        });
        const companion = await companionSnapshot(deps);
        const enriched = await dashboardBuild({ hostPanes: panes, companion });
        let responseState;
        try {
          responseState = mobileView
            ? projectMobileState(enriched, mobileView, url.searchParams.get('id') || '')
            : wantsConsoleState(url) ? consoleState(enriched) : enriched;
        } catch (error) {
          if (error.status === 400) return json(res, 400, { error: error.message });
          throw error;
        }
        const body = JSON.stringify(responseState);
        await sendStateJson(req, res, body);
      },
    },
    {
      method: null,
      path: '/api/events',
      handle: async ({ res }) => json(res, 503, { error: 'events are served by the frontend worker' }),
    },
  ]);
}

// Every handler runs inside a loop hold named `<method> <path>`, so the lag probe
// can name a route that held the event loop (bin/loop-hold.js). The one wrapper
// sits here, where the ladder is built, rather than in each handler. The path is
// the request's own pathname: a pattern route (an agent's name in the path) is
// named by what was asked, which is what an operator reading serve.log wants.
// The route object is otherwise the one declared above, so matchRoute and the
// allow checks see exactly the same fields.
function withLoopHolds(list) {
  const loopHold = require('../loop-hold.js');
  return list.map((route) => {
    const handle = route.handle;
    const declared = Array.isArray(route.path) ? route.path[0] : route.path;
    return {
      ...route,
      handle: (args) => loopHold.run(
        `${args?.req?.method || route.method || 'ANY'} ${args?.url?.pathname || String(declared)}`,
        handle, args),
    };
  });
}

// The first route whose method, path and guard all match, or null. A route with
// `method: null` answers any method, exactly as the old trailing if/else chain did,
// except that a POST never reaches it: the ladder answered an unmatched POST with
// its own JSON 404 before that chain.
function matchRoute(list, { req, url, body }) {
  const post = req.method === 'POST';
  for (const route of list) {
    if (post ? route.method !== 'POST' : route.method === 'POST' || (route.method && route.method !== req.method)) continue;
    const paths = Array.isArray(route.path) ? route.path : [route.path];
    // A path is an exact pathname or, where a route owns a segment it does not
    // choose (an agent's name), the pattern that pathname must match.
    if (!paths.some((value) => value instanceof RegExp ? value.test(url.pathname) : value === url.pathname)) continue;
    if (route.when && !route.when({ req, url, body })) continue;
    return route;
  }
  return null;
}

// The classes a route answers when it names none. A node is never among them:
// no route is a node's to call yet, and a route that becomes one says so with
// its own `allow`.
const DEFAULT_ALLOW = ['proxy', 'local', 'admin'];

function routeAllows(route, principal) {
  if (!principal) return false;
  return (route.allow || DEFAULT_ALLOW).includes(principal.class);
}

// The 403 a dispatcher answers with, or null when the principal may proceed. The
// class is named so a refusal reads as "you are the wrong caller", not "your
// token is wrong".
function routeDenial(route, principal) {
  if (routeAllows(route, principal)) return null;
  return { status: 403, error: `forbidden for ${principal ? principal.class : 'unauthorized'}` };
}

module.exports = { routes, matchRoute, routeAllows, routeDenial, DEFAULT_ALLOW };
