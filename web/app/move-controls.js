import { dismissWriteFailure, write } from './api.js';
import { runAction } from './action.js';

// Moving a Claude session to another machine (POST /api/move-session, bin/session-move.js):
// stopped where it runs, its files carried and verified, resumed on the other node.
// A real move takes minutes; the CLI gives it half an hour, and so does this.
const MOVE_TIMEOUT_MS = 30 * 60e3;

// Moves this console started and has not heard back from, by session id: shown as
// "Moving to …" until the published state's own `session.move` takes over.
const localMoves = new Map();

function nodesOf(ctx) {
  return Array.isArray(ctx.data?.nodes) ? ctx.data.nodes.filter((node) => node && typeof node.name === 'string' && node.name) : [];
}

function daemonNodeName(ctx) {
  return nodesOf(ctx).find((node) => node.daemon)?.name || '';
}

function movedText(result, fallbackTo) {
  const pane = result?.started?.pane || result?.launch?.pane;
  return `Moved to ${result?.to || fallbackTo}${pane ? ` (pane ${pane})` : ''}`;
}

// A refusal the daemon gave before touching anything: a bad request, no such session,
// or a 409 that names why (cwd-missing, busy, working, same-node, ...). A timeout, a
// restart, or a 5xx is not one, and keeps the sticky failure banner.
function refused(error) {
  return !error?.transient && !error?.timeout && [400, 404, 409].includes(error?.status);
}

// The same preflight refusing the real move: the session became busy, or a delivery
// went pending, between the check and the click's move. It names a reason code and
// nothing was stopped, so it is a toast too. Any 4xx that names one counts.
function refusedAtMove(error) {
  return !error?.transient && !error?.timeout && Number(error?.status) >= 400 && Number(error?.status) < 500
    && typeof error?.body?.reason === 'string' && Boolean(error.body.reason);
}

// The session's move controls, or '' when none apply. `live` is whether the session
// has a live pane here: only a running session is offered a move, while a move the
// state still carries is shown whether or not its pane survived the stop.
export function moveControlsHTML(ctx, session, { live = false, pendingHandoff = false } = {}) {
  if (!session?.id || (session.kind || session.agent) !== 'claude' || pendingHandoff) return '';
  const nodes = nodesOf(ctx);
  if (nodes.length < 2) return '';
  const move = session.move;
  if (move?.status === 'recovery-needed') {
    const message = move.message || `the move to ${move.to} stopped while ${move.phase || 'moving'}`;
    return `<span class="handoff-error" role="alert" title="${ctx.esc(message)}">Move to ${ctx.esc(move.to || 'another machine')} ${move.interrupted ? 'interrupted' : 'needs you'}</span>`
      + `<p class="move-message">${ctx.esc(message)}</p>`
      + `<button class="btn" data-move-recover="${ctx.esc(move.id)}" data-move-to="${ctx.esc(move.to || '')}" title="Continue the move from the step that did not finish">Retry</button>`
      + `<button class="btn" data-move-abandon="${ctx.esc(move.id)}" title="Drop the move and leave the session on ${ctx.esc(move.from || 'its machine')}">Abandon</button>`;
  }
  if (move?.status === 'in-flight') {
    return `<span class="handoff-status" role="status">Moving to ${ctx.esc(move.to || 'another machine')}…${move.phase ? ` (${ctx.esc(move.phase)})` : ''}</span>`;
  }
  const local = localMoves.get(session.id);
  if (local) return `<span class="handoff-status" role="status">Moving to ${ctx.esc(local)}…</span>`;
  if (!live) return '';
  const current = session.node || daemonNodeName(ctx);
  const targets = nodes.filter((node) => node.name !== current);
  if (!targets.length) return '';
  return `<details class="session-move"><summary class="btn" title="Stops this session on ${ctx.esc(current || 'its machine')} and resumes it on the machine you pick, which needs the same directory">Move to another machine</summary><div class="account-menu">${targets.map((node) => {
    const label = node.daemon ? `${node.name} (this machine)` : node.name;
    const down = node.ok === false;
    const reason = down ? `unreachable: ${node.reason || 'no answer'}` : '';
    return `<button class="btn" data-move-node="${ctx.esc(node.name)}" ${down ? `disabled title="${ctx.esc(`${node.name} is ${reason}`)}"` : `title="Move this session to ${ctx.esc(node.name)}"`}><span>${ctx.esc(label)}</span>${reason ? `<small>${ctx.esc(reason)}</small>` : ''}</button>`;
  }).join('')}</div></details>`;
}

// A move that stopped part way: the daemon journalled it as recovery-needed, and the
// reloaded state renders Retry and Abandon. The banner would only repeat that.
async function recoveryNeeded(ctx, error) {
  dismissWriteFailure(error.writeFailureId);
  ctx.toast(`Move needs recovery: ${error.body?.message || error.body?.error || error.message}`);
  await ctx.reload();
}

async function alreadyMoving(ctx, error) {
  dismissWriteFailure(error.writeFailureId);
  const phase = error.body.status === 'in-flight' ? error.body.phase : error.body.status;
  ctx.toast(`A move to ${error.body.to || 'another machine'} is already running${phase ? ` (${phase})` : ''}`);
  await ctx.reload();
}

async function moveTo(ctx, sessionId, node) {
  try {
    await write('/api/move-session', { sessionId, node, ownerForce: true, dry: true }, 'POST', { label: 'Checking move' });
  } catch (error) {
    if (!refused(error)) throw error;
    // Nothing was stopped: say why, and leave the controls as they were.
    if (error.body?.id && error.body?.status) {
      // A move of this session is journalled already. Still in flight (started from
      // the CLI, or by another console) it is running, not waiting for anyone; the
      // reloaded state shows its step.
      if (error.body.status !== 'recovery-needed') return alreadyMoving(ctx, error);
      return recoveryNeeded(ctx, error);
    }
    dismissWriteFailure(error.writeFailureId);
    ctx.toast(`Not moved: ${error.body?.error || error.message}`);
    return undefined;
  }
  localMoves.set(sessionId, node);
  ctx.refresh?.();
  let result;
  try {
    // ownerForce: Owner clicked, which is the console's force: the session is stopped
    // even mid-turn, and a live session on another node can be moved off it.
    result = await write('/api/move-session', { sessionId, node, ownerForce: true }, 'POST',
      { label: 'Moving session', timeoutMs: MOVE_TIMEOUT_MS });
  } catch (error) {
    if (error.body?.status === 'recovery-needed') return recoveryNeeded(ctx, error);
    if (!refusedAtMove(error)) throw error;
    // Nothing was stopped: the controls go back to what they were.
    localMoves.delete(sessionId);
    ctx.refresh?.();
    dismissWriteFailure(error.writeFailureId);
    ctx.toast(`Not moved: ${error.body?.error || error.message}`);
    return undefined;
  } finally {
    localMoves.delete(sessionId);
  }
  await ctx.reload();
  ctx.toast(movedText(result, node));
  if (result?.warnings?.length) ctx.toast(`Move warnings: ${result.warnings.join('; ')}`);
  return result;
}

async function settle(ctx, body, label, fallbackTo) {
  let result;
  try {
    result = await write('/api/move-session', body, 'POST', { label, timeoutMs: MOVE_TIMEOUT_MS });
  } catch (error) {
    if (error.body?.status === 'recovery-needed') return recoveryNeeded(ctx, error);
    throw error;
  }
  await ctx.reload();
  ctx.toast(result?.status === 'done' ? movedText(result, fallbackTo) : result?.message || 'Move settled');
  if (result?.warnings?.length) ctx.toast(`Move warnings: ${result.warnings.join('; ')}`);
  return result;
}

export function installMoveControls(container, ctx, sessionId) {
  if (!container) return;
  const nodeButtons = [...container.querySelectorAll('[data-move-node]')];
  nodeButtons.forEach((button) => {
    button.onclick = async () => {
      if (button.disabled) return;
      const node = button.dataset.moveNode;
      const others = nodeButtons.filter((candidate) => candidate !== button && !candidate.disabled);
      others.forEach((candidate) => { candidate.disabled = true; });
      button.blur?.();
      try {
        await runAction(button, () => moveTo(ctx, sessionId, node),
          { label: `Moving to ${node}…`, ctx, retry: () => button.click() });
      } catch {} finally {
        others.forEach((candidate) => { candidate.disabled = false; });
      }
    };
  });
  container.querySelectorAll('[data-move-recover]').forEach((button) => {
    button.onclick = () => runAction(button, () => settle(ctx, { recover: button.dataset.moveRecover }, 'Retrying move', button.dataset.moveTo),
      { label: 'Retrying…', ctx, retry: () => button.click() }).catch(() => {});
  });
  container.querySelectorAll('[data-move-abandon]').forEach((button) => {
    button.onclick = () => runAction(button, () => settle(ctx, { abandon: button.dataset.moveAbandon }, 'Abandoning move'),
      { label: 'Abandoning…', ctx, retry: () => button.click() }).catch(() => {});
  });
}
