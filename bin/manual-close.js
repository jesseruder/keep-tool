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
        || !['claude', 'codex'].includes(pane.meta?.agent) || (initial?.pid && pane.pid !== initial.pid)) {
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
  const wait = async (delay) => {
    for (let i = 0; i < 10; i++) {
      if (!verify(await deps.getPane(body.pane)).alive) return true;
      await sleep(delay);
    }
    return !verify(await deps.getPane(body.pane)).alive;
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
  if (await wait(200)) return result();
  await gracefulResult?.beforeSignal?.();
  verify(await deps.getPane(body.pane));
  const guard = () => ({
    expectedPid: initial.pid,
    expectedSessionId: body.sessionId,
    expectedInputCount,
    expectedOutputCount,
  });
  await deps.signal(body.pane, 'SIGTERM', deps.requireSignalGuard ? guard() : null);
  if (await wait(100)) return result();
  await gracefulResult?.beforeSignal?.();
  verify(await deps.getPane(body.pane));
  await deps.signal(body.pane, 'SIGKILL', deps.requireSignalGuard ? guard() : null);
  if (await wait(100)) return result(true);
  throw new Error('Termination requested but the pane is still alive');
}

module.exports = { manualClose };
