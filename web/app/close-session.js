import { write } from './api.js';

export async function closeSession(ctx, sessionId, pane, button) {
  if (button?.disabled || !ctx.beginClose(sessionId, pane)) return;
  if (button) button.disabled = true;
  ctx.toast('Closing session…');
  try {
    const result = await write('/api/close-session', { sessionId, pane });
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
  } catch (error) {
    ctx.closingSessions.cancel(sessionId);
    ctx.refresh();
    ctx.toast(`Not closed: ${error.message}`);
  } finally { if (button) button.disabled = false; }
}
