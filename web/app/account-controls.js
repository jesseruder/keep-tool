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

// The daemon's rate-limit transfer queue (bin/handoff-queue.js). One entry per
// session; only the ones still in flight or waiting for a person are rendered.
function queueEntry(ctx, sessionId) {
  const entry = (ctx.data.handoffQueue || []).find((candidate) => candidate.sessionId === sessionId);
  return entry && ['queued', 'parked'].includes(entry.status) ? entry : null;
}

export function hasPendingHandoff(ctx, sessionId, paneId) {
  const handoff = latestHandoff(ctx, sessionId);
  // A queued transfer is as pending as a running one: the session is about to be
  // stopped and resumed elsewhere, so nothing should offer to reopen or restart it.
  if (queueEntry(ctx, sessionId)?.status === 'queued') return true;
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

function labelForAccountId(ctx, accountId) {
  return (ctx.data.accounts || []).find((account) => account.id === accountId)?.label || accountId || 'another account';
}

// The sessions a batch would actually enqueue: rate-limited, on this account, and
// in a pane, because a transfer names the pane it moves.
function rateLimitedSessions(ctx, account) {
  if (!account?.id) return [];
  return (ctx.data.sessions || []).filter((session) => session.kind === 'claude' && session.rateLimit
    && (session.accountId || session.account) === account.id && session.pane);
}

function queueStatusHTML(ctx, entry) {
  const label = labelForAccountId(ctx, entry.targetAccountId);
  const reason = entry.lastReason || '';
  const cancel = `<button class="btn" data-queue-cancel="${ctx.esc(entry.sessionId)}" title="Stop retrying this transfer">Cancel</button>`;
  if (entry.status === 'queued') {
    const detail = reason ? `retrying (${reason})` : 'queued';
    return `<span class="handoff-status" role="status" title="${ctx.esc(reason)}">Moving to ${ctx.esc(label)}: ${ctx.esc(detail)}</span>${cancel}`;
  }
  // Parked. A transient class means the refusals kept clearing and coming back
  // until the queue ran out of patience, so retrying is worth offering. A blocked
  // one named something only a person can resolve, and retrying would just repeat it.
  const retry = entry.lastClass === 'transient'
    ? `<button class="btn" data-queue-retry="${ctx.esc(entry.sessionId)}" data-queue-source="${ctx.esc(entry.sourceAccountId || '')}" data-queue-target="${ctx.esc(entry.targetAccountId || '')}"${entry.force ? ' data-queue-force="1"' : ''} title="Queue this transfer again">Retry</button>`
    : '';
  const heading = entry.lastClass === 'transient' ? 'Transfer gave up' : 'Transfer needs you';
  return `<span class="handoff-error" role="alert" title="${ctx.esc(reason)}">${heading}: ${ctx.esc(reason || 'no reason was recorded')}</span>${retry}${cancel}`;
}

function bulkHandoffHTML(ctx, session, pane) {
  const current = accountFor(ctx, session, pane);
  const limited = rateLimitedSessions(ctx, current);
  if (!limited.length) return '';
  const destinations = handoffDestinations(ctx, session, pane);
  if (!destinations.length) return '';
  const count = limited.length;
  const noun = `${count} rate-limited session${count === 1 ? '' : 's'}`;
  const from = accountLabel(current, session, pane);
  return `<div class="bulk-handoff">${destinations.map((account) => {
    const hint = usageHint(ctx, account);
    const label = account.label || account.id;
    return `<button class="btn" data-bulk-handoff="${ctx.esc(account.id)}" data-bulk-source="${ctx.esc(current.id)}" title="Queue every rate-limited session on ${ctx.esc(from)} for transfer to ${ctx.esc(label)}; each one still passes every transfer check"><span>Move ${ctx.esc(noun)} to ${ctx.esc(label)}</span>${hint ? `<small>${ctx.esc(hint)}</small>` : ''}</button>`;
  }).join('')}</div>`;
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
  // A queue entry owns the transfer controls while it exists: offering Continue or
  // Retry beside it would race the daemon's own retry for the same session.
  const queued = queueEntry(ctx, sessionId);
  if (queued) return queueStatusHTML(ctx, queued);
  const handoff = latestHandoff(ctx, sessionId);
  const openOnly = handoff?.intent === 'open-only';
  const target = targetFor(ctx, handoff);
  const targetLabel = target?.label || handoff?.targetAccountId || 'another account';
  const fallback = handoff?.portableFallbackAvailable && handoff.pane === paneId && pane?.alive === true
    && current?.id === handoff.sourceAccountId
    ? `<button class="btn" data-portable-fallback="${ctx.esc(handoff.id || handoff.transactionId || '')}">Start fresh continuation</button>` : '';
  if (handoff?.status === 'recovery-needed') {
    // Only the background-job refusal is forceable; every other interruption
    // reason needs the ordinary retry.
    const forceable = String(handoff.reason || '').startsWith('Waiting for the turn and background work')
      ? `<button class="btn" data-handoff-account="${ctx.esc(handoff.targetAccountId || '')}" data-handoff-force="1" title="Ignore uncertain background-job evidence and transfer now; a session mid-turn is still refused">Force transfer</button>` : '';
    return `<span class="handoff-error" role="alert" title="${ctx.esc(handoff.reason || '')}">${openOnly ? 'Reopen interrupted' : 'Transfer interrupted'}</span><button class="btn" data-handoff-account="${ctx.esc(handoff.targetAccountId || '')}">Retry</button>${forceable}${fallback}`;
  }
  if (handoff?.status === 'done' && current?.id !== handoff.targetAccountId) {
    return `<span class="handoff-status" role="status">Verifying ${openOnly ? 'reopen on' : 'transfer to'} ${ctx.esc(targetLabel)}…</span>`;
  }
  if (handoff && !['done', 'failed', 'recovery-needed'].includes(handoff.status)) {
    // Retrying the same transaction joins a live request, or resumes its durable
    // journal after a daemon crash. Do not strand a persisted in-flight status.
    return `<span class="handoff-status" role="status">${openOnly ? 'Opening on' : 'Continuing on'} ${ctx.esc(targetLabel)}…</span><button class="btn" data-handoff-account="${ctx.esc(handoff.targetAccountId || '')}">Retry</button>`;
  }

  const error = handoff?.status === 'failed'
    ? `<span class="handoff-error" role="alert" title="${ctx.esc(handoff.reason || '')}">${openOnly ? 'Reopen failed' : 'Transfer failed'}</span>` : '';
  const destinations = handoffDestinations(ctx, session, pane);
  const bulk = bulkHandoffHTML(ctx, session, pane);
  if (!current || !destinations.length) return error;
  const provider = current.agent === 'codex' ? 'Codex' : 'Claude';
  const chooser = `<details class="account-handoff"><summary class="btn" title="Continue this ${provider} conversation on another account">Continue on another account</summary><div class="account-menu">${destinations.map((account) => { const hint = usageHint(ctx, account); const label = account.label || account.id; return `<button class="btn" data-handoff-account="${ctx.esc(account.id)}" title="Continue this conversation on ${ctx.esc(label)}"><span>${ctx.esc(label)}</span>${hint ? `<small>${ctx.esc(hint)}</small>` : ''}</button>`; }).join('')}</div></details>`;
  return `${error}${fallback}${chooser}${bulk}`;
}

function confirmedAccount(ctx, sessionId, paneId) {
  const session = (ctx.data.sessions || []).find((candidate) => candidate.id === sessionId);
  const pane = (ctx.data.panes || []).find((candidate) => candidate.id === paneId);
  return session?.accountId || pane?.meta?.accountId;
}

function once(button, run) {
  button.onclick = async () => {
    if (button.disabled) return;
    button.disabled = true;
    try { await run(); }
    finally { button.disabled = false; }
  };
}

export function installHandoffControls(container, ctx, sessionId, pane) {
  container.querySelectorAll('[data-bulk-handoff]').forEach((button) => {
    once(button, async () => {
      const targetAccountId = button.dataset.bulkHandoff;
      const sourceAccountId = button.dataset.bulkSource;
      try {
        const result = await write('/api/handoff-rate-limited', { sourceAccountId, targetAccountId });
        const queued = result.queued?.length || 0;
        const skipped = result.skipped?.length || 0;
        ctx.toast(queued
          ? `Queued ${queued} transfer${queued === 1 ? '' : 's'} to ${labelForAccountId(ctx, targetAccountId)}${skipped ? `; ${skipped} skipped` : ''}.`
          : `Nothing queued${skipped ? `; ${skipped} skipped` : ''}.`);
        await ctx.reload();
      } catch (error) { ctx.toast(`Not queued: ${error.message}`); }
    });
  });
  container.querySelectorAll('[data-queue-retry]').forEach((button) => {
    once(button, async () => {
      const targetAccountId = button.dataset.queueTarget;
      try {
        await write('/api/handoff-rate-limited', { sourceAccountId: button.dataset.queueSource, targetAccountId,
          sessionIds: [button.dataset.queueRetry], ...(button.dataset.queueForce === '1' ? { force: true } : {}) });
        ctx.toast(`Queued again for ${labelForAccountId(ctx, targetAccountId)}.`);
        await ctx.reload();
      } catch (error) { ctx.toast(`Not queued: ${error.message}`); }
    });
  });
  container.querySelectorAll('[data-queue-cancel]').forEach((button) => {
    once(button, async () => {
      try {
        await write('/api/handoff-queue-cancel', { sessionId: button.dataset.queueCancel });
        ctx.toast('Queued transfer cancelled.');
        await ctx.reload();
      } catch (error) { ctx.toast(`Not cancelled: ${error.message}`); }
    });
  });
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
      const openOnly = latestHandoff(ctx, sessionId)?.intent === 'open-only';
      const destination = (ctx.data.accounts || []).find((account) => account.id === accountId);
      const buttons = [...container.querySelectorAll('[data-handoff-account]')];
      buttons.forEach((candidate) => { candidate.disabled = true; });
      button.blur();
      try {
        const force = button.dataset.handoffForce === '1';
        const result = await write('/api/handoff-session', { sessionId, pane, accountId, ...(force ? { force: true } : {}) });
        const responseOpenOnly = result.intent === 'open-only' || openOnly;
        if (result.status === 'recovery-needed') {
          ctx.toast(`${responseOpenOnly ? 'Reopen' : 'Transfer'} needs recovery: ${result.reason || 'retry when the session is safe'}`);
        } else if (result.status === 'failed') {
          ctx.toast(`${responseOpenOnly ? 'Not reopened' : 'Not continued'}: ${result.reason || (responseOpenOnly ? 'reopen failed' : 'transfer failed')}`);
        } else if (result.status === 'done') {
          await ctx.reload();
          if (confirmedAccount(ctx, sessionId, pane) === accountId) {
            ctx.toast(`${responseOpenOnly ? 'Opened' : 'Continued'} on ${destination?.label || accountId}`);
          } else {
            ctx.toast(`Transfer finished; verifying ${destination?.label || accountId}…`);
          }
        } else {
          ctx.toast(`${responseOpenOnly ? 'Opening' : 'Continuing'} on ${destination?.label || accountId}…`);
          await ctx.reload();
        }
      } catch (error) {
        if (error.body?.status === 'recovery-needed') {
          ctx.toast(`${openOnly ? 'Reopen' : 'Transfer'} needs recovery: ${error.body.reason || error.message}`);
          await ctx.reload();
        } else {
          ctx.toast(`${openOnly ? 'Not reopened' : 'Not continued'}: ${error.body?.reason || error.message}`);
        }
      } finally {
        buttons.forEach((candidate) => { candidate.disabled = false; });
      }
    };
  });
}
