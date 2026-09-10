'use strict';

// Explicit user Close only. Automatic retirement keeps its conservative policy.
async function manualClose(body, deps) {
  if (!/^[a-z0-9_-]+$/i.test(body?.sessionId || '') || !/^[a-z0-9_-]+$/i.test(body?.pane || '')) throw new Error('Expected exact session and pane');
  const initial = await deps.getPane(body.pane);
  const verify = (pane) => {
    if (!pane || pane.id !== body.pane || pane.meta?.sessionId !== body.sessionId
        || !['claude', 'codex'].includes(pane.meta?.agent) || (initial?.pid && pane.pid !== initial.pid)) {
      throw new Error('Session/pane identity changed; nothing terminated');
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
  try { await deps.graceful(body); } catch (error) { deps.onGracefulError?.(error); }
  if (await wait(200)) return result();
  verify(await deps.getPane(body.pane));
  await deps.signal(body.pane, 'SIGTERM');
  if (await wait(100)) return result();
  verify(await deps.getPane(body.pane));
  await deps.signal(body.pane, 'SIGKILL');
  if (await wait(100)) return result(true);
  throw new Error('Termination requested but the pane is still alive');
}

module.exports = { manualClose };
