import { reportWriteFailure, write } from './api.js';
import { runAction } from './action.js';

// A close of a pane on another node reads it over the node transport with a
// four-second budget per phase, so its worst case outlives the ordinary write
// deadline; the console must not report a close the daemon is still carrying out.
const CLOSE_TIMEOUT_MS = 45000;

export async function closeSession(ctx, sessionId, pane, button) {
  if (button?.disabled || !ctx.beginClose(sessionId, pane)) return;
  try {
    await runAction(button, async () => {
      const result = await write('/api/close-session', { sessionId, pane }, 'POST', { label: 'Closing session', timeoutMs: CLOSE_TIMEOUT_MS });
      if (!result.closed) {
        ctx.closingSessions.cancel(sessionId);
        ctx.toast('Graceful exit requested; history and task preserved');
        ctx.refresh();
        return;
      }
      if (ctx.isPanePinned(pane)) {
        const unpinned = await ctx.pinPane(pane, 'session');
        if (!unpinned) {
          ctx.closingSessions.confirm(sessionId);
          await ctx.reload();
          ctx.toast('Session closed, but unpinning failed; retry Unpin');
          return;
        }
      }
      ctx.closingSessions.confirm(sessionId);
      await ctx.reload();
      ctx.toast(`${result.forced ? 'Force-closed' : 'Session closed'}; history and task preserved`);
    }, { label: 'Closing…', ctx, retry: () => closeSession(ctx, sessionId, pane, button) });
  } catch (error) {
    ctx.closingSessions.cancel(sessionId);
    ctx.refresh();
    error.actionMessage = `Session was not closed; it is back in the list. ${error.message}`;
    // runAction has already published the failure; refresh it with rollback context.
    reportWriteFailure(error, { message: error.actionMessage, retry: () => closeSession(ctx, sessionId, pane, button) });
  }
}
