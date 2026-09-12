import { write } from './api.js';

function latestTransfer(ctx, sessionId) {
  return (ctx.data.portableTransfers || [])
    .filter((transfer) => transfer.sourceSessionId === sessionId)
    .sort((a, b) => Number(new Date(b.preparedAt)) - Number(new Date(a.preparedAt)))[0];
}

function targetLabel(ctx, transfer) {
  return (ctx.data.accounts || []).find((account) => account.id === transfer?.targetAccountId)?.label
    || transfer?.targetAccountId || 'another account';
}

export function portableTransferControls(ctx, sessionId) {
  const transfer = latestTransfer(ctx, sessionId);
  if (!transfer || transfer.sourceAgent !== 'codex') return '';
  const label = targetLabel(ctx, transfer);
  if (transfer.status === 'done') {
    return transfer.destinationSessionId
      ? `<button class="btn portable-transfer" data-open-portable="${ctx.esc(transfer.destinationSessionId)}"><span>Open successor</span><small>${ctx.esc(label)} · fresh conversation with saved context</small></button>`
      : '<span class="portable-transfer-state" role="status">Successor is being indexed…</span>';
  }
  if (transfer.status === 'launching') {
    return `<button class="btn portable-transfer" disabled><span>Starting on ${ctx.esc(label)}…</span><small>fresh conversation with saved context</small></button>`;
  }
  if (transfer.status === 'ambiguous') {
    return '<span class="portable-transfer-state error" role="alert">Transfer needs attention; no duplicate was started</span>';
  }
  if (transfer.status !== 'prepared') {
    return `<span class="portable-transfer-state error" role="alert">Transfer ${ctx.esc(transfer.status || 'unavailable')}</span>`;
  }
  return `<button class="btn portable-transfer" data-portable-transfer="${ctx.esc(transfer.id)}"><span>Continue on ${ctx.esc(label)}</span><small>fresh conversation with saved context</small></button>`;
}

export function installPortableTransferControls(container, ctx) {
  container.querySelectorAll('[data-portable-transfer]').forEach((button) => {
    button.onclick = async () => {
      if (button.disabled) return;
      button.disabled = true;
      button.blur();
      try {
        const result = await write('/api/transfer-session', { transferId: button.dataset.portableTransfer });
        const transfer = result?.transfer;
        await ctx.reload();
        if (transfer?.status === 'done' && transfer.destinationSessionId) {
          ctx.toast('Opened a fresh conversation with the saved context; the original session is preserved');
          ctx.openReviewSession(transfer.destinationSessionId);
        } else {
          ctx.toast('Starting a fresh conversation with the saved context…');
        }
      } catch (error) {
        await ctx.reload();
        ctx.toast(`Transfer not started: ${error.message}`);
      } finally { button.disabled = false; }
    };
  });
  container.querySelectorAll('[data-open-portable]').forEach((button) => {
    button.onclick = () => ctx.openReviewSession(button.dataset.openPortable);
  });
}
