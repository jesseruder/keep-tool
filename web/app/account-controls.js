import { write } from './api.js';
import { openPortableTransfer } from './portable-transfer.js';

function accountFor(ctx, session, pane) {
  const id = session?.accountId || pane?.meta?.accountId;
  if (!id) return null;
  const configured = (ctx.data.accounts || []).find((account) => account.id === id);
  return configured || {
    id,
    agent: session?.kind || pane?.meta?.agent,
    label: session?.accountLabel || pane?.meta?.accountLabel || id,
    handoffSupported: false,
  };
}

function accountLabel(account, session, pane) {
  return session?.accountLabel || pane?.meta?.accountLabel || account?.label || account?.id;
}

function latestHandoff(ctx, sessionId) {
  return [...(ctx.data.handoffs || [])].reverse().find((entry) => entry.sessionId === sessionId);
}

export function hasPendingHandoff(ctx, sessionId, paneId) {
  const handoff = latestHandoff(ctx, sessionId);
  return Boolean(handoff && !['done', 'failed'].includes(handoff.status)
    && (!handoff.pane || handoff.pane === paneId));
}

function targetFor(ctx, handoff) {
  return (ctx.data.accounts || []).find((account) => account.id === handoff?.targetAccountId);
}

function usageHint(ctx, account) {
  const usage = ctx.data.usage?.accounts?.[account.id];
  const value = account.agent === 'claude' ? usage?.limits?.[0] : usage?.windows?.[0];
  if (!value) return '';
  const percent = Math.max(0, Math.min(100, Number(value.percent) || 0));
  return `${value.label || 'usage'} ${Math.round(percent)}%`;
}

export function accountLabelHTML(ctx, session, pane) {
  const account = accountFor(ctx, session, pane);
  if (!account) return '';
  const label = accountLabel(account, session, pane);
  return `<span class="account-label" title="Account: ${ctx.esc(label)}">${ctx.esc(label)}</span>`;
}

export function handoffDestinations(ctx, session, pane) {
  const current = accountFor(ctx, session, pane);
  if (!current?.handoffSupported || !current.agent) return [];
  return (ctx.data.accounts || []).filter((account) => account.id !== current.id
    && account.agent === current.agent && account.handoffSupported === true);
}

export function handoffControls(ctx, sessionId, paneId) {
  const session = (ctx.data.sessions || []).find((candidate) => candidate.id === sessionId);
  const pane = (ctx.data.panes || []).find((candidate) => candidate.id === paneId);
  const current = accountFor(ctx, session, pane);
  const handoff = latestHandoff(ctx, sessionId);
  const target = targetFor(ctx, handoff);
  const targetLabel = target?.label || handoff?.targetAccountId || 'another account';
  const fallback = handoff?.portableFallbackAvailable && handoff.pane === paneId && pane?.alive === true
    && current?.id === handoff.sourceAccountId
    ? `<button class="btn" data-portable-fallback="${ctx.esc(handoff.id || handoff.transactionId || '')}">Start fresh continuation</button>` : '';
  if (handoff?.status === 'recovery-needed') {
    return `<span class="handoff-error" role="alert" title="${ctx.esc(handoff.reason || '')}">Transfer interrupted</span><button class="btn" data-handoff-account="${ctx.esc(handoff.targetAccountId || '')}">Retry</button>${fallback}`;
  }
  if (handoff?.status === 'done' && current?.id !== handoff.targetAccountId) {
    return `<span class="handoff-status" role="status">Verifying transfer to ${ctx.esc(targetLabel)}…</span>`;
  }
  if (handoff && !['done', 'failed', 'recovery-needed'].includes(handoff.status)) {
    // Retrying the same transaction joins a live request, or resumes its durable
    // journal after a daemon crash. Do not strand a persisted in-flight status.
    return `<span class="handoff-status" role="status">Continuing on ${ctx.esc(targetLabel)}…</span><button class="btn" data-handoff-account="${ctx.esc(handoff.targetAccountId || '')}">Retry</button>`;
  }

  const error = handoff?.status === 'failed'
    ? `<span class="handoff-error" role="alert" title="${ctx.esc(handoff.reason || '')}">Transfer failed</span>` : '';
  const destinations = handoffDestinations(ctx, session, pane);
  if (!current || !destinations.length) return error;
  const chooser = `<details class="account-handoff"><summary class="btn">Continue on another account</summary><div class="account-menu">${destinations.map((account) => { const hint = usageHint(ctx, account); return `<button class="btn" data-handoff-account="${ctx.esc(account.id)}"><span>${ctx.esc(account.label || account.id)}</span>${hint ? `<small>${ctx.esc(hint)}</small>` : ''}</button>`; }).join('')}</div></details>`;
  return `${error}${fallback}${chooser}`;
}

function confirmedAccount(ctx, sessionId, paneId) {
  const session = (ctx.data.sessions || []).find((candidate) => candidate.id === sessionId);
  const pane = (ctx.data.panes || []).find((candidate) => candidate.id === paneId);
  return session?.accountId || pane?.meta?.accountId;
}

export function installHandoffControls(container, ctx, sessionId, pane) {
  container.querySelectorAll('[data-portable-fallback]').forEach((button) => {
    button.onclick = async () => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        await write('/api/abandon-account-handoff', { sessionId, pane, transactionId: button.dataset.portableFallback });
        await ctx.reload();
        openPortableTransfer(ctx, sessionId);
      } catch (error) { ctx.toast(`Fresh continuation unavailable: ${error.body?.reason || error.message}`); }
      finally { button.disabled = false; }
    };
  });
  container.querySelectorAll('[data-handoff-account]').forEach((button) => {
    button.onclick = async () => {
      if (button.disabled) return;
      const accountId = button.dataset.handoffAccount;
      const destination = (ctx.data.accounts || []).find((account) => account.id === accountId);
      const buttons = [...container.querySelectorAll('[data-handoff-account]')];
      buttons.forEach((candidate) => { candidate.disabled = true; });
      button.blur();
      try {
        const result = await write('/api/handoff-session', { sessionId, pane, accountId });
        if (result.status === 'recovery-needed') {
          ctx.toast(`Transfer needs recovery: ${result.reason || 'retry when the session is safe'}`);
        } else if (result.status === 'failed') {
          ctx.toast(`Not continued: ${result.reason || 'transfer failed'}`);
        } else if (result.status === 'done') {
          await ctx.reload();
          if (confirmedAccount(ctx, sessionId, pane) === accountId) {
            ctx.toast(`Continued on ${destination?.label || accountId}`);
          } else {
            ctx.toast(`Transfer finished; verifying ${destination?.label || accountId}…`);
          }
        } else {
          ctx.toast(`Continuing on ${destination?.label || accountId}…`);
          await ctx.reload();
        }
      } catch (error) {
        if (error.body?.status === 'recovery-needed') {
          ctx.toast(`Transfer needs recovery: ${error.body.reason || error.message}`);
          await ctx.reload();
        } else {
          ctx.toast(`Not continued: ${error.body?.reason || error.message}`);
        }
      } finally {
        buttons.forEach((candidate) => { candidate.disabled = false; });
      }
    };
  });
}
