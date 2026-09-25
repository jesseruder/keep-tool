import { write } from './api.js';
import { openPortableTransfer } from './portable-transfer.js';
import { runAction } from './action.js';

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

// A parked entry whose session has moved on. Queueing it again would only be
// skipped by the batch, and the status alone would hide the ordinary transfer and
// recovery controls the person actually needs now.
function parkedTransferIsStale(ctx, entry, session) {
  if (!entry || entry.status !== 'parked' || !session) return false;
  if (!session.rateLimit) return true;
  const on = session.accountId || session.account;
  return Boolean(entry.sourceAccountId && on && on !== entry.sourceAccountId);
}

function queueStatusHTML(ctx, entry, options = {}) {
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
  const retry = entry.lastClass === 'transient' && options.retry !== false
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
    return `<button class="btn" data-bulk-handoff="${ctx.esc(account.id)}" data-bulk-source="${ctx.esc(current.id)}" title="Queue every rate-limited session on ${ctx.esc(from)} for transfer to ${ctx.esc(label)}; each one still passes every transfer check, and one on another machine moves now, as its own Continue would"><span>Move ${ctx.esc(noun)} to ${ctx.esc(label)}</span>${hint ? `<small>${ctx.esc(hint)}</small>` : ''}</button>`;
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

// Offered only while the daemon says the transfer never touched the session: an
// interrupted one, or a working record a daemon restart orphaned (abandonCandidate).
function abandonButtonHTML(ctx, handoff) {
  return handoff?.abandonAvailable
    ? `<button class="btn" data-handoff-abandon="${ctx.esc(handoff.id || handoff.transactionId || '')}" title="Drop this transfer and leave the session on ${ctx.esc(labelForAccountId(ctx, handoff.sourceAccountId))}">Abandon</button>` : '';
}

export function handoffControls(ctx, sessionId, paneId) {
  const session = (ctx.data.sessions || []).find((candidate) => candidate.id === sessionId);
  const pane = (ctx.data.panes || []).find((candidate) => candidate.id === paneId);
  const current = accountFor(ctx, session, pane);
  // A queue entry owns the transfer controls while it exists: offering Continue or
  // Retry beside it would race the daemon's own retry for the same session. The one
  // exception is a parked entry the queue has already moved past — that stays on
  // screen as a note, with the ordinary controls beside it.
  const queued = queueEntry(ctx, sessionId);
  const stale = parkedTransferIsStale(ctx, queued, session);
  if (queued && !stale) return queueStatusHTML(ctx, queued);
  const parked = stale ? queueStatusHTML(ctx, queued, { retry: false }) : '';
  const handoff = latestHandoff(ctx, sessionId);
  const openOnly = handoff?.intent === 'open-only';
  const target = targetFor(ctx, handoff);
  const targetLabel = target?.label || handoff?.targetAccountId || 'another account';
  const fallback = handoff?.portableFallbackAvailable && handoff.pane === paneId && pane?.alive === true
    && current?.id === handoff.sourceAccountId
    ? `<button class="btn" data-portable-fallback="${ctx.esc(handoff.id || handoff.transactionId || '')}">Start fresh continuation</button>` : '';
  if (handoff?.status === 'recovery-needed') {
    // Every click is already forced (see ownerForce below), so Retry never needs a
    // second variant. Abandon appears only while the daemon says nothing was stopped.
    const abandon = abandonButtonHTML(ctx, handoff);
    return `${parked}<span class="handoff-error" role="alert" title="${ctx.esc(handoff.reason || '')}">${openOnly ? 'Reopen interrupted' : 'Transfer interrupted'}</span><button class="btn" data-handoff-account="${ctx.esc(handoff.targetAccountId || '')}">Retry</button>${abandon}${fallback}`;
  }
  if (handoff?.status === 'done' && current?.id !== handoff.targetAccountId) {
    return `${parked}<span class="handoff-status" role="status">Verifying ${openOnly ? 'reopen on' : 'transfer to'} ${ctx.esc(targetLabel)}…</span>`;
  }
  if (handoff && !['done', 'failed', 'recovery-needed'].includes(handoff.status)) {
    // Retrying the same transaction joins a live request, or resumes its durable
    // journal after a daemon crash. Do not strand a persisted in-flight status.
    return `${parked}<span class="handoff-status" role="status">${openOnly ? 'Opening on' : 'Continuing on'} ${ctx.esc(targetLabel)}…</span><button class="btn" data-handoff-account="${ctx.esc(handoff.targetAccountId || '')}">Retry</button>${abandonButtonHTML(ctx, handoff)}`;
  }

  // A transfer Owner abandoned is not a failure to report; the ordinary controls return.
  const error = handoff?.status === 'failed' && handoff.phase !== 'abandoned'
    ?`<span class="handoff-error" role="alert" title="${ctx.esc(handoff.reason || '')}">${openOnly ? 'Reopen failed' : 'Transfer failed'}</span>` : '';
  const destinations = handoffDestinations(ctx, session, pane);
  const bulk = bulkHandoffHTML(ctx, session, pane);
  if (!current || !destinations.length) return `${parked}${error}`;
  const provider = current.agent === 'codex' ? 'Codex' : 'Claude';
  const chooser = `<details class="account-handoff"><summary class="btn" title="Continue this ${provider} conversation on another account">Continue on another account</summary><div class="account-menu">${destinations.map((account) => { const hint = usageHint(ctx, account); const label = account.label || account.id; return `<button class="btn" data-handoff-account="${ctx.esc(account.id)}" title="Continue this conversation on ${ctx.esc(label)}"><span>${ctx.esc(label)}</span>${hint ? `<small>${ctx.esc(hint)}</small>` : ''}</button>`; }).join('')}</div></details>`;
  return `${parked}${error}${fallback}${chooser}${bulk}`;
}

function confirmedAccount(ctx, sessionId, paneId) {
  const session = (ctx.data.sessions || []).find((candidate) => candidate.id === sessionId);
  const pane = (ctx.data.panes || []).find((candidate) => candidate.id === paneId);
  return session?.accountId || pane?.meta?.accountId;
}

// One forced transfer on a node: an auth preflight alone can take 45 seconds, so the
// ordinary 20-second write deadline would call a move that is still landing a failure.
const BULK_MOVE_TIMEOUT_MS = 180000;
// The button can be re-rendered, enabled, mid-batch; a second press waits for the first.
let bulkMoving = false;

function once(button, run, ctx) {
  button.onclick = () => runAction(button, run, {
    label: 'Working…', ctx, retry: () => button.click(),
  }).catch(() => {});
}

export function installHandoffControls(container, ctx, sessionId, pane) {
  container.querySelectorAll('[data-bulk-handoff]').forEach((button) => {
    once(button, async () => {
      const targetAccountId = button.dataset.bulkHandoff;
      const sourceAccountId = button.dataset.bulkSource;
      const target = labelForAccountId(ctx, targetAccountId);
      if (bulkMoving) { ctx.toast('Already moving rate-limited sessions; wait for that to finish.'); return; }
      bulkMoving = true;
      try {
        const result = await write('/api/handoff-rate-limited', { sourceAccountId, targetAccountId }, 'POST',
          { label: 'Queueing transfers', retry: () => button.click() });
        // The queue never force-stops a session, and a session on another node moves
        // only when forced, so the batch hands those back with their pane. This click
        // is Owner's own, so each moves now as its own Continue button would move it,
        // except that he saw a count rather than the session: each transfer names the
        // limit and account the batch saw, and refuses a session that has since resumed
        // or moved rather than force-stopping it mid-turn.
        const remote = (result.skipped || []).filter((row) => row.node && row.pane);
        const skipped = (result.skipped || []).filter((row) => !remote.includes(row));
        const queued = result.queued?.length || 0;
        let moved = 0;
        const failed = [];
        const recovery = [];
        const running = [];
        if (remote.length) {
          const where = [...new Set(remote.map((row) => row.node))].join(', ');
          ctx.toast(`Moving ${remote.length} session${remote.length === 1 ? '' : 's'} on ${where} to ${target}…`);
        }
        for (const [index, row] of remote.entries()) {
          // A finished move re-renders the controls, which can replace this button;
          // the progress then lands on a detached copy, and the toasts still report.
          const progress = button.querySelector?.('span:last-child');
          if (progress) progress.textContent = `Moving ${index + 1} of ${remote.length}…`;
          try {
            // Background: the closing toast reports each one, so a single failure
            // does not leave an unnamed sticky banner that the next success clears.
            const moveResult = await write('/api/handoff-session', { sessionId: row.sessionId, pane: row.pane, accountId: targetAccountId,
              ownerForce: true, expectedSourceAccountId: sourceAccountId,
              ...(row.rateLimitAt != null ? { expectedRateLimitAt: row.rateLimitAt } : {}) }, 'POST',
            { label: 'Moving session', timeoutMs: BULK_MOVE_TIMEOUT_MS, background: true });
            if (moveResult.status === 'recovery-needed') recovery.push(moveResult.reason || 'retry when the session is safe');
            else if (moveResult.status === 'failed') failed.push(moveResult.reason || 'transfer failed');
            else moved += 1;
          } catch (error) {
            // Still running on the daemon: the next session waits for nothing, but the
            // person is told this one may yet land rather than that it failed.
            if (error.timeout) running.push(row.sessionId);
            else if (error.body?.status === 'recovery-needed') recovery.push(error.body.reason || error.message);
            else failed.push(error.body?.reason || error.body?.error || error.message);
          }
        }
        const reasons = (rows) => [...new Set(rows)].join('; ');
        const parts = [
          moved ? `moved ${moved}` : '',
          queued ? `queued ${queued}` : '',
          running.length ? `${running.length} still running` : '',
          recovery.length ? `${recovery.length} need${recovery.length === 1 ? 's' : ''} recovery (${reasons(recovery)})` : '',
          failed.length ? `${failed.length} failed (${reasons(failed)})` : '',
          skipped.length ? `${skipped.length} skipped (${reasons(skipped.map((row) => row.reason))})` : '',
        ].filter(Boolean);
        const summary = parts.join('; ');
        ctx.toast(moved || queued || running.length
          ? `${target}: ${summary}.` : `Nothing moved${summary ? `: ${summary}` : ''}.`);
        await ctx.reload();
      } catch (error) { ctx.toast(`Not queued: ${error.message}`); } finally { bulkMoving = false; }
    }, ctx);
  });
  container.querySelectorAll('[data-queue-retry]').forEach((button) => {
    once(button, async () => {
      const targetAccountId = button.dataset.queueTarget;
      const retried = button.dataset.queueRetry;
      try {
        const result = await write('/api/handoff-rate-limited', { sourceAccountId: button.dataset.queueSource, targetAccountId,
          sessionIds: [retried], ...(button.dataset.queueForce === '1' ? { force: true } : {}) }, 'POST',
        { label: 'Retrying transfer', retry: () => button.click() });
        // The batch decides what is still eligible. Saying "queued again" when it
        // skipped this session would leave the person watching a parked entry.
        const took = (result.queued || []).some((row) => row.sessionId === retried);
        const skipped = (result.skipped || []).find((row) => row.sessionId === retried);
        ctx.toast(took ? `Queued again for ${labelForAccountId(ctx, targetAccountId)}.`
          : `Not queued: ${skipped?.reason || 'this session no longer needs the transfer'}.`);
        await ctx.reload();
      } catch (error) { ctx.toast(`Not queued: ${error.message}`); }
    }, ctx);
  });
  container.querySelectorAll('[data-queue-cancel]').forEach((button) => {
    once(button, async () => {
      try {
        await write('/api/handoff-queue-cancel', { sessionId: button.dataset.queueCancel }, 'POST',
          { label: 'Cancelling transfer', retry: () => button.click() });
        ctx.toast('Queued transfer cancelled.');
        await ctx.reload();
      } catch (error) { ctx.toast(`Not cancelled: ${error.message}`); }
    }, ctx);
  });
  container.querySelectorAll('[data-handoff-abandon]').forEach((button) => {
    once(button, async () => {
      try {
        const result = await write('/api/abandon-transfer', { sessionId, transactionId: button.dataset.handoffAbandon }, 'POST',
          { label: 'Abandoning transfer' });
        // An interrupted stop can leave a typed /exit in the composer that the journal
        // never recorded; the next Enter there would end the session.
        ctx.toast(`Transfer abandoned; the session stays on ${labelForAccountId(ctx, result.sourceAccountId)}. Check its input box for a leftover /exit before pressing Enter.`);
        await ctx.reload();
      } catch (error) { ctx.toast(`Not abandoned: ${error.message}`); }
    }, ctx);
  });
  container.querySelectorAll('[data-portable-fallback]').forEach((button) => {
    button.onclick = () => runAction(button, async () => {
        await write('/api/abandon-account-handoff', { sessionId, pane, transactionId: button.dataset.portableFallback }, 'POST',
          { label: 'Preparing continuation' });
        await ctx.reload();
        openPortableTransfer(ctx, sessionId);
      }, { label: 'Preparing…', ctx, retry: () => button.click() }).catch(() => {});
  });
  container.querySelectorAll('[data-handoff-account]').forEach((button) => {
    button.onclick = async () => {
      if (button.disabled) return;
      const accountId = button.dataset.handoffAccount;
      const openOnly = latestHandoff(ctx, sessionId)?.intent === 'open-only';
      const destination = (ctx.data.accounts || []).find((account) => account.id === accountId);
      const buttons = [...container.querySelectorAll('[data-handoff-account]')];
      buttons.forEach((candidate) => { if (candidate !== button) candidate.disabled = true; });
      button.blur();
      try {
        // ownerForce: Owner clicked, so the daemon closes and kills the source instead of
        // asking it to exit and refusing whatever it cannot prove idle. He can see whether
        // the session is working. queueOnTransient stays for a daemon without ownerForce.
        const result = await runAction(button, () => write('/api/handoff-session', { sessionId, pane, accountId, queueOnTransient: true,
          ownerForce: true }, 'POST', { label: openOnly ? 'Opening on account' : 'Continuing on account' }),
        { label: openOnly ? 'Opening…' : 'Continuing…', ctx, retry: () => button.click() });
        const responseOpenOnly = result.intent === 'open-only' || openOnly;
        if (result.status === 'queued') {
          ctx.toast(`Transfer refused (${result.reason || 'it was busy'}); retrying in the background`);
          // The reloaded state carries the queue entry, and the controls become the
          // queue's own "Moving to ‹account›" with its Cancel button.
          await ctx.reload();
        } else if (result.status === 'recovery-needed') {
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
