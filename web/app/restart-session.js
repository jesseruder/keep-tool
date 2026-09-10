import { write } from './api.js';

export function restartControls(ctx, sessionId) {
  const entry = [...(ctx.data.restarts || [])].reverse().find((e) => e.sessionId === sessionId);
  if (entry?.status === 'recovery-needed') return `<span title="${ctx.esc(entry.reason || '')}">Restart interrupted; recovery required</span>`;
  // A failed attempt belongs to its original process, not every later resume
  // of this conversation. Preserve history; do not claim a successful restart.
  const live = (ctx.data.panes || []).filter(p => p.alive === true && p.agentAlive !== false && p.meta?.sessionId === sessionId
    && ['codex', 'claude'].includes(p.meta?.agent) && Number.isSafeInteger(p.pid) && p.pid > 0);
  const replaced = live.length === 1 && Number.isSafeInteger(entry?.pid) && entry.pid > 0
    && (live[0].id !== entry.pane || live[0].pid !== entry.pid);
  if (entry?.status === 'restarting') return '<button class="btn" disabled>Restarting…</button>';
  if (entry?.status === 'queued') return `<span class="restart-reason">Restart queued: ${ctx.esc(entry.reason || 'Checking for a safe idle prompt')}</span><button class="btn" data-restart="cancel">Cancel restart</button>`;
  const failed = entry?.status === 'failed' && !replaced ? `<span title="${ctx.esc(entry.reason)}">Restart failed</span>` : '';
  return failed;
}

export function installRestartControls(container, ctx, sessionId, pane) {
  container.querySelectorAll('[data-restart]').forEach((button) => {
    button.onclick = async () => {
      if (button.disabled) return;
      button.disabled = true;
      button.blur();
      const origin = `${ctx.state.mode}:${ctx.state.selectedKey}:${ctx.state.layout}`;
      try {
        const result = await write('/api/restart-session', { sessionId, pane, mode: button.dataset.restart });
        ctx.toast(result.status === 'failed' ? `Not restarted: ${result.reason}`
          : result.status === 'done' ? 'Session restarted; conversation and pins preserved'
          : result.status === 'cancelled' ? 'Restart cancelled' : 'Restart queued; waits for an idle, unviewed pane');
        if (result.status === 'done' && document.activeElement === document.body
            && origin === `${ctx.state.mode}:${ctx.state.selectedKey}:${ctx.state.layout}`) ctx.state.focusPane = pane;
        await ctx.reload();
      } catch (error) { ctx.toast(`Not restarted: ${error.message}`); }
      finally { button.disabled = false; }
    };
  });
}
