'use strict';

// Explicit user Close only. Automatic retirement keeps its conservative policy.
async function manualClose(body, deps) {
  if (!/^[a-z0-9_-]+$/i.test(body?.sessionId || '') || !/^[a-z0-9_-]+$/i.test(body?.pane || '')) throw new Error('Expected exact session and pane');
  const initial = await deps.getPane(body.pane);
  if (deps.requireSignalGuard && deps.signalGuarded !== true) {
    throw new Error('Terminal host must be refreshed before automatic force close');
  }
  let expectedInputCount = null;
  let expectedOutputCount = null;
  const verify = (pane) => {
    if (!pane || pane.id !== body.pane || pane.meta?.sessionId !== body.sessionId
        || !['claude', 'codex', 'pi'].includes(pane.meta?.agent) || (initial?.pid && pane.pid !== initial.pid)) {
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
  const wait = async (delay) => {
    let confirmed = false;
    let lastError = null;
    for (let i = 0; i < 10; i++) {
      let pane;
      try { pane = await deps.getPane(body.pane); }
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
        if (!verify(pane).alive) return { closed: true, confirmed, lastError };
      }
      await sleep(delay);
    }
    return { closed: false, confirmed, lastError };
  };
  const unconfirmed = (signal, delay, cause) => {
    const seconds = 10 * delay / 1000;
    const error = new Error(`${signal} signal sent; host did not confirm within ${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s${cause ? `: ${cause.message}` : ''}`);
    if (cause) error.cause = cause;
    return error;
  };
  // Try the normal /exit workflow first. If prompt/activity guards refuse it,
  // SIGTERM still gives the process a chance to clean up without typing into a draft.
  let gracefulResult;
  try { gracefulResult = await deps.graceful(body); } catch (error) {
    deps.onGracefulError?.(error);
    if (deps.requireGraceful) throw error;
  }
  if (deps.protectInput) expectedInputCount = gracefulResult?.expectedInputCount;
  if (deps.protectOutput) expectedOutputCount = gracefulResult?.expectedOutputCount;
  if ((await wait(200)).closed) return result();
  await gracefulResult?.beforeSignal?.();
  verify(await deps.getPane(body.pane));
  const guard = () => ({
    expectedPid: initial.pid,
    expectedSessionId: body.sessionId,
    expectedInputCount,
    expectedOutputCount,
  });
  await deps.signal(body.pane, 'SIGTERM', deps.requireSignalGuard ? guard() : null);
  const term = await wait(100);
  if (term.closed) return result();
  if (!term.confirmed) throw unconfirmed('SIGTERM', 100, term.lastError);
  await gracefulResult?.beforeSignal?.();
  let beforeKill;
  try { beforeKill = await deps.getPane(body.pane); }
  catch (error) { if (timedOut(error)) throw unconfirmed('SIGTERM', 100, error); throw error; }
  if (!beforeKill) throw unconfirmed('SIGTERM', 100);
  verify(beforeKill);
  await deps.signal(body.pane, 'SIGKILL', deps.requireSignalGuard ? guard() : null);
  const killed = await wait(100);
  if (killed.closed) return result(true);
  if (!killed.confirmed) throw unconfirmed('SIGKILL', 100, killed.lastError);
  throw new Error('Termination requested but the pane is still alive');
}

module.exports = { manualClose };
