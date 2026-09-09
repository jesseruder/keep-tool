import { write } from './api.js';

export async function closeSession(ctx, sessionId, pane, button) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  ctx.toast('Closing session…');
  try {
    await write('/api/close-session', { sessionId, pane });
    if (ctx.isPanePinned(pane)) {
      const unpinned = await ctx.pinPane(pane, 'session');
      if (!unpinned) {
        ctx.toast('Exit requested, but unpinning failed; retry Unpin');
        ctx.refresh();
        return;
      }
    }
    ctx.toast('Graceful exit requested; history and task preserved');
    ctx.refresh();
  } catch (error) { ctx.toast(`Not closed: ${error.message}`); }
  finally { if (button) button.disabled = false; }
}
