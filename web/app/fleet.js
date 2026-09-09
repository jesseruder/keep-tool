import { sessionLabel } from './status.js';
import { closeSession } from './close-session.js';
const FILTER_KEY = 'keep.console.fleet.filter';
let filter = '';
try { filter = sessionStorage.getItem(FILTER_KEY) || ''; } catch {}

export function renderFleet(ctx) {
  const rows = [];
  const panesBySession = new Map();
  const panes = ctx.paneMap();
  const waitingBySession = new Map();
  for (const item of ctx.queueItems()) {
    if (ctx.state.dismissed.has(ctx.itemKey(item))) continue;
    if (!item.sessionId || item.kind === 'health') continue; // every queue kind counts as waiting, including 'input'
    const prior = waitingBySession.get(item.sessionId);
    if (!prior || Number(item.pri || 0) < Number(prior.pri || 0)) waitingBySession.set(item.sessionId, item);
  }
  for (const session of ctx.data.sessions || []) {
    panesBySession.set(session.id, session.pane);
    const pane = session.pane ? panes.get(session.pane) : null;
    rows.push({
      id: session.id, pane: session.pane, project: session.project, title: session.title || 'untitled session',
      state: pane?.alive === false ? 'exited' : session.state || 'idle', stateLabel: pane?.alive === false ? 'Exited' : sessionLabel(session), kind: session.kind, reviewer: session.reviewer,
      taskId: session.taskId, branch: session.gitBranch || '', since: session.mtime, session: true,
      waiting: waitingBySession.get(session.id)?.kind || '', alive: Boolean(pane?.alive),
      sessionId: session.id, agent: session.kind,
    });
  }
  for (const pane of ctx.data.panes || []) {
    const sessionId = pane.meta?.sessionId;
    if (sessionId && panesBySession.has(sessionId)) continue;
    const agent = pane.meta?.agent;
    if (agent !== 'shell' && !(['claude', 'codex'].includes(agent) && pane.alive === false)) continue;
    rows.push({
      id: sessionId || pane.id, pane: pane.id, project: pane.meta?.project || pane.cwd,
      title: pane.meta?.title || pane.title || (agent === 'shell' ? 'shell' : 'exited session'),
      state: pane.alive ? 'running' : 'exited', kind: agent, branch: '', since: pane.createdAt,
      taskId: pane.meta?.card || '', session: false, waiting: '', alive: Boolean(pane.alive),
      sessionId, agent,
    });
  }

  const needle = filter.trim().toLowerCase();
  const visible = rows.filter((row) => {
    if (!needle) return true;
    const project = ctx.projectOf(row.project);
    return [row.title, row.id, row.taskId, project.name, project.key, project.path, row.branch]
      .some((value) => String(value || '').toLowerCase().includes(needle));
  });
  const groups = new Map();
  for (const row of visible) {
    const project = ctx.projectOf(row.project);
    if (!groups.has(project.key)) groups.set(project.key, { project, rows: [] });
    groups.get(project.key).rows.push(row);
  }
  const ordered = [...groups.values()].sort((a, b) => a.project.scope.localeCompare(b.project.scope) || a.project.name.localeCompare(b.project.name));
  const table = visible.length ? `<table><thead><tr><th>State</th><th>Session / pane</th><th>Branch</th><th>Card</th><th>Waiting</th><th>Last activity</th><th>Kind</th><th></th></tr></thead><tbody>${ordered.map((group) => {
    const waiting = group.rows.filter((row) => row.waiting).length;
    const sessions = group.rows.filter((row) => row.session).length;
    return `<tr class="grp"><td colspan="8">${ctx.projectHTML(group.project.path, true)} <span class="group-meta">${sessions} session${sessions === 1 ? '' : 's'}${waiting ? ` · ${waiting} waiting` : ''}</span></td></tr>${group.rows.map((row) => {
      const pinned = ctx.isPanePinned(row.pane);
      const reopen = row.sessionId && !row.alive ? `<button class="btn" data-reopen="${ctx.esc(row.sessionId)}" data-agent="${ctx.esc(row.agent)}" data-title="${ctx.esc(row.title)}" data-stale="${ctx.esc(row.pane || '')}">Reopen</button>` : '';
      const closeIdle = row.session && row.alive
        ? `<button class="btn" data-close-idle="${ctx.esc(row.sessionId)}" data-pane="${ctx.esc(row.pane)}">Close</button>` : '';
      const remove = (row.pane && panes.get(row.pane)?.alive === false ? `<button class="btn" data-remove="${ctx.esc(row.pane)}">Remove</button>` : '') + closeIdle;
      return `<tr><td><span class="st"><i class="${ctx.esc(row.state)}"></i>${ctx.esc(row.stateLabel || row.state)}</span></td><td>${ctx.esc(row.title)}${row.reviewer ? '<span class="rv">reviewer</span>' : ''} <span class="mono faint">${ctx.esc(row.id)}</span></td><td class="mono muted">${ctx.esc(row.branch)}</td><td class="mono info">${ctx.esc(row.taskId || '')}${ctx.tagsHTML(ctx.taskFor(row))}</td><td class="mono waiting-kind">${ctx.esc(row.waiting)}</td><td class="mono muted">${ctx.esc(ctx.rel(row.since))}</td><td class="mono ${row.kind === 'codex' ? 'kind-codex' : ''}">${ctx.esc(row.kind)}</td><td><button class="btn" data-pin="${ctx.esc(row.pane || '')}" data-title="${ctx.esc(row.title)}" ${row.alive && !pinned ? '' : 'disabled'}>${pinned ? 'Pinned' : 'Pin'}</button>${reopen}${remove}</td></tr>`;
    }).join('')}`;
  }).join('')}</tbody></table>` : '<div class="qempty"><b>No fleet rows match</b>Try another title, card, project, or branch.</div>';

  const root = document.querySelector('#fleet');
  if (!root.querySelector('.fleetbar')) {
    root.innerHTML = `<div class="fleetbar"><input type="search" aria-label="Filter fleet" placeholder="Filter title, session, card, project, or branch" value="${ctx.esc(filter)}"><span></span></div><div class="fleet-results"></div>`;
    const input = root.querySelector('.fleetbar input');
    input.addEventListener('input', () => {
      filter = input.value;
      try { sessionStorage.setItem(FILTER_KEY, filter); } catch {}
      renderFleet(ctx);
    });
  }
  root.querySelector('.fleetbar span').textContent = `${visible.length} of ${rows.length}`;
  const results = root.querySelector('.fleet-results');
  const changed = ctx.patchHTML(results, table);
  if (changed) {
    results.querySelectorAll('[data-close-idle]').forEach((button) => button.addEventListener('click', async () => {
      await closeSession(ctx, button.dataset.closeIdle, button.dataset.pane, button);
    }));
    results.querySelectorAll('[data-pin]').forEach((button) => button.addEventListener('click', () => ctx.pinPane(button.dataset.pin, button.dataset.title)));
    results.querySelectorAll('[data-reopen]').forEach((button) => button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        await ctx.reopenSession({ sessionId: button.dataset.reopen, agent: button.dataset.agent, title: button.dataset.title, stalePane: button.dataset.stale || undefined });
      } finally { button.disabled = false; }
    }));
    results.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      try { await ctx.removePane(button.dataset.remove); ctx.toast('Pane removed'); }
      catch (error) { ctx.toast(`Could not remove: ${error.message}`); }
      finally { button.disabled = false; }
    }));
  }
}
