'use strict';

// One phase of polling: ten reads a tenth of a second apart. Every identity read
// on this path is bounded by it, because the caller holds the injection lock.
const READ_BUDGET_MS = 1000;
// A pane on another node is read over the node transport: a relayed link costs a
// round trip of ~100 ms, and that node's host answers one request per connection at
// a time, so a get can sit behind a screen or list reply still crossing the link.
// One second failed real closes of aws1 panes; this is the budget for those reads.
const REMOTE_READ_BUDGET_MS = 4000;

// A host read may not outlive its budget: a host that never answers is abandoned
// as a timeout (the read is idempotent and may finish on its own; a late reply
// answers nobody, since the request id no longer has a waiter).
function withinBudget(promise, remainingMs) {
  return new Promise((resolve, reject) => {
    // Not unref'd: the timer is what ends the wait, so it must keep the process
    // alive until it fires or is cleared; a CLI close with nothing else pending
    // would otherwise exit mid-close.
    const timer = setTimeout(() => reject(new Error(`host request timed out (get) after ${Math.round(remainingMs)}ms of the close phase`)), Math.max(0, remainingMs));
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

// Explicit user Close only. Automatic retirement keeps its conservative policy.
async function manualClose(body, deps) {
  // A pane may be named by the node it lives on (`<id>@<node>`); the host's own
  // alphabet has no '@', so the two shapes stay distinguishable here.
  if (!/^[a-z0-9_-]+$/i.test(body?.sessionId || '') || !/^[A-Za-z0-9_-]{1,64}(?:@[a-z0-9]+)?$/.test(body?.pane || '')) throw new Error('Expected exact session and pane');
  const readBudgetMs = require('./nodes.js').isRemotePane(body.pane) ? REMOTE_READ_BUDGET_MS : READ_BUDGET_MS;
  const initial = await withinBudget(deps.getPane(body.pane), readBudgetMs);
  if (deps.requireSignalGuard && deps.signalGuarded !== true) {
    throw new Error('Terminal host must be refreshed before automatic force close');
  }
  let expectedInputCount = null;
  let expectedOutputCount = null;
  // An agent's SessionEnd hook hands its pane back as it exits: sessionId cleared,
  // agent 'shell'. A node's panes run the agent under a shell, so a close there sees
  // this between the signal and the pane's exit; a pane Owner opened as a shell and
  // typed `claude` into keeps that shell alive afterwards. On the same pane process
  // it means the session has ended, so the close is done: nothing further is signalled,
  // least of all a shell someone may be typing into. Any other session binding the
  // pane, or a different process, still refuses.
  const releasedBySession = (pane) => pane !== initial && Boolean(initial?.pid) && pane.pid === initial.pid
    && pane.createdAt === initial.createdAt && pane.meta?.agent === 'shell' && !pane.meta?.sessionId;
  const ended = (pane) => !pane.alive || releasedBySession(pane);
  const verify = (pane) => {
    if (!pane || pane.id !== body.pane || (initial?.pid && pane.pid !== initial.pid)) {
      throw new Error('Session/pane identity changed; nothing terminated');
    }
    if (releasedBySession(pane)) return pane;
    if (pane.meta?.sessionId !== body.sessionId || !['claude', 'codex', 'pi'].includes(pane.meta?.agent)) {
      throw new Error('Session/pane identity changed; nothing terminated');
    }
    if (deps.protectInput && expectedInputCount !== null && pane.inputCount !== expectedInputCount) {
      throw new Error('Session received input after graceful close; nothing force-terminated');
    }
    if (deps.protectInput && !Number.isInteger(pane.inputCount)) {
      throw new Error('Session input activity cannot be verified; nothing force-terminated');
    }
    if (deps.protectOutput && expectedOutputCount !== null && pane.alive
        && pane.outputCount !== expectedOutputCount) {
      throw new Error('Session produced output after graceful close; nothing force-terminated');
    }
    if (deps.protectOutput && !Number.isInteger(pane.outputCount)) {
      throw new Error('Session output activity cannot be verified; nothing force-terminated');
    }
    return pane;
  };
  verify(initial);
  const result = (forced = false) => ({ ok: true, closed: true, forced, sessionId: body.sessionId, pane: body.pane });
  if (!initial.alive) return result();
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timedOut = (error) => /timed out/i.test(String(error && error.message || error));
  const now = deps.now || Date.now;
  // A phase is a poll every `delay` for its budget (ten polls on this node), ending
  // on whichever runs out first: a host that times out every read must not hold the
  // injection lock for ten full request timeouts, and the error reports the time
  // actually spent.
  const wait = async (delay) => {
    const started = now();
    // Never shorter than one read's budget, or a single slow remote read would end
    // the phase before the host had a chance to confirm anything.
    const budgetMs = Math.max(10 * delay, readBudgetMs);
    let confirmed = false;
    let lastError = null;
    for (let i = 0; i < Math.ceil(budgetMs / delay) && now() - started < budgetMs; i++) {
      let pane;
      try { pane = await withinBudget(deps.getPane(body.pane), budgetMs - (now() - started)); }
      catch (error) {
        if (!timedOut(error)) throw error;
        lastError = error;
        await sleep(delay);
        continue;
      }
      // After a signal, no record is not proof that the process changed identity or
      // exited. Keep polling for an affirmative host observation within this phase.
      if (pane) {
        confirmed = true;
        if (ended(verify(pane))) return { closed: true, confirmed, lastError, waitedMs: now() - started };
      }
      await sleep(delay);
    }
    return { closed: false, confirmed, lastError, waitedMs: now() - started };
  };
  const unconfirmed = (signal, waitedMs, cause) => {
    const seconds = Math.max(0, waitedMs) / 1000;
    const error = new Error(`${signal} signal sent; host did not confirm within ${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s${cause ? `: ${cause.message}` : ''}`);
    if (cause) error.cause = cause;
    return error;
  };
  // Try the normal /exit workflow first. If prompt/activity guards refuse it,
  // SIGTERM still gives the process a chance to clean up without typing into a draft.
  let gracefulResult;
  let gracefulRefused = false;
  try { gracefulResult = await deps.graceful(body); } catch (error) {
    deps.onGracefulError?.(error);
    if (deps.requireGraceful) throw error;
    gracefulRefused = true;
  }
  if (deps.protectInput) expectedInputCount = gracefulResult?.expectedInputCount;
  if (deps.protectOutput) expectedOutputCount = gracefulResult?.expectedOutputCount;
  // A refused /exit leaves nothing to wait for: polling would only spend the phase
  // (a whole remote read budget, since a remote pane's graceful close always refuses)
  // before the SIGTERM that comes next anyway.
  if (!gracefulRefused && (await wait(200)).closed) return result();
  await gracefulResult?.beforeSignal?.();
  // The identity reads around each signal get one phase's budget too; nothing has
  // been signalled yet here, so a timeout simply fails the close.
  if (ended(verify(await withinBudget(deps.getPane(body.pane), readBudgetMs)))) return result();
  const guard = () => ({
    expectedPid: initial.pid,
    expectedSessionId: body.sessionId,
    expectedInputCount,
    expectedOutputCount,
  });
  await deps.signal(body.pane, 'SIGTERM', deps.requireSignalGuard ? guard() : null);
  const term = await wait(100);
  if (term.closed) return result();
  if (!term.confirmed) throw unconfirmed('SIGTERM', term.waitedMs, term.lastError);
  await gracefulResult?.beforeSignal?.();
  let beforeKill;
  try { beforeKill = await withinBudget(deps.getPane(body.pane), readBudgetMs); }
  catch (error) { if (timedOut(error)) throw unconfirmed('SIGTERM', term.waitedMs, error); throw error; }
  if (!beforeKill) throw unconfirmed('SIGTERM', term.waitedMs);
  if (ended(verify(beforeKill))) return result();
  await deps.signal(body.pane, 'SIGKILL', deps.requireSignalGuard ? guard() : null);
  const killed = await wait(100);
  if (killed.closed) return result(true);
  if (!killed.confirmed) throw unconfirmed('SIGKILL', killed.waitedMs, killed.lastError);
  throw new Error('Termination requested but the pane is still alive');
}

module.exports = { manualClose, READ_BUDGET_MS, REMOTE_READ_BUDGET_MS };
