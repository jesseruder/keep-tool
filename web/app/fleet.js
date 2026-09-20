import { sessionLabel } from './status.js';
import { closeSession } from './close-session.js';
import { shadowSummaryHTML } from './state-line.js';
import { numBadgeHTML, numHaystack } from './session-number.js';
import { RENAMED_HINT } from './session-rename.js';
import { markHTML } from './session-mark.js';
import { providerIconHTML } from './provider-icon.js';
const FILTER_KEY = 'keep.console.fleet.filter';
const PROVIDER_FILTER_KEY = 'keep.console.fleet.provider';
let filter = '';
let providerFilter = 'all';
try { filter = sessionStorage.getItem(FILTER_KEY) || ''; } catch {}
try {
  const savedProvider = sessionStorage.getItem(PROVIDER_FILTER_KEY);
  if (['claude', 'codex'].includes(savedProvider)) providerFilter = savedProvider;
} catch {}

const providerLabel = (provider) => ({ claude: 'Claude Code', codex: 'Codex' }[provider] || 'All');

export function filterFleetRows(ctx, rows, text = filter, provider = providerFilter) {
  const needle = text.trim().toLowerCase();
  return rows.filter((row) => {
    if (provider !== 'all' && row.kind !== provider) return false;
    if (!needle) return true;
    const project = ctx.projectOf(row.project);
    return [row.title, row.id, row.taskId, project.name, project.key, project.path, row.branch, row.accountLabel, row.accountId,
      ...numHaystack(row.num)]
      .some((value) => String(value || '').toLowerCase().includes(needle));
  });
}

// A numbered session is listed as "#12" with the uuid in the badge tooltip; rows
// with no session of their own (shells, exited panes) keep the plain id.
export function fleetRowHTML(ctx, row, panes) {
  const pinned = ctx.isPanePinned(row.pane);
  const reopen = row.sessionId && !row.alive ? `<button class="btn" data-reopen="${ctx.esc(row.sessionId)}" data-agent="${ctx.esc(row.agent)}" data-title="${ctx.esc(row.title)}" data-stale="${ctx.esc(row.pane || '')}">Reopen</button>` : '';
  const closeIdle = row.session && row.alive
    ? `<button class="btn" data-close-idle="${ctx.esc(row.sessionId)}" data-pane="${ctx.esc(row.pane)}">Close</button>` : '';
  const remove = (row.pane && panes.get(row.pane)?.alive === false ? `<button class="btn" data-remove="${ctx.esc(row.pane)}">Remove</button>` : '') + closeIdle;
  // The phone hands live terminals to the app; `mobile.js` owns the click and
  // `.mobile-only` keeps the button off every other screen.
  const terminal = row.alive && row.pane
    ? `<button class="btn mobile-only" data-open-terminal="${ctx.esc(row.pane)}" data-session="${ctx.esc(row.sessionId || '')}" data-title="${ctx.esc(row.title)}">Terminal</button>` : '';
  const configured = (ctx.data.accounts || []).find((account) => account.id === row.accountId);
  const account = row.accountLabel || configured?.label || row.accountId;
  const badge = numBadgeHTML(ctx.esc, row.num, row.id);
  const identity = badge || `<span class="mono faint">${ctx.esc(row.id)}</span>`;
  return `<tr><td><span class="st"><i class="${ctx.esc(row.state)}"></i>${ctx.esc(row.stateLabel || row.state)}</span></td><td${row.renamed ? ` title="${ctx.esc(RENAMED_HINT)}"` : ''}>${markHTML(ctx.esc, row.mark)}${providerIconHTML(row.kind, ctx.esc)}${ctx.esc(row.title)}${row.reviewer ? '<span class="rv">reviewer</span>' : ''} ${identity}</td><td class="mono muted">${ctx.esc(row.branch)}</td><td class="mono info">${ctx.esc(row.taskId || '')}${ctx.tagsHTML(ctx.taskFor(row))}</td><td class="mono waiting-kind">${ctx.esc(row.waiting)}</td><td class="mono muted">${ctx.esc(ctx.rel(row.since))}</td><td class="mono ${row.kind === 'codex' ? 'kind-codex' : ''}">${ctx.esc(row.kind)}</td><td>${ctx.esc(account || '—')}</td><td><button class="btn" data-pin="${ctx.esc(row.pane || '')}" data-title="${ctx.esc(row.title)}" ${row.alive && !pinned ? '' : 'disabled'}>${pinned ? 'Pinned' : 'Pin'}</button>${terminal}${reopen}${remove}</td></tr>`;
}

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
    if (ctx.isClosingSession(session.id, session.pane)) continue;
    panesBySession.set(session.id, session.pane);
    const pane = session.pane ? panes.get(session.pane) : null;
    rows.push({
      id: session.id, num: session.num, pane: session.pane, project: session.project, title: session.title || 'untitled session',
      renamed: Boolean(session.renamed), mark: session.mark,
      state: pane?.alive === false ? 'exited' : session.state || 'idle', stateLabel: pane?.alive === false ? 'Exited' : sessionLabel(session), kind: session.kind, reviewer: session.reviewer,
      taskId: session.taskId, branch: session.gitBranch || '', since: session.mtime, session: true,
      waiting: waitingBySession.get(session.id)?.kind || '', alive: Boolean(pane?.alive),
      sessionId: session.id, agent: session.kind, accountId: session.accountId || pane?.meta?.accountId || '',
      accountLabel: session.accountLabel || pane?.meta?.accountLabel || '',
    });
  }
  for (const pane of ctx.data.panes || []) {
    if (ctx.isClosingSession(pane.meta?.sessionId, pane.id)) continue;
    const sessionId = pane.meta?.sessionId;
    if (sessionId && panesBySession.has(sessionId)) continue;
    const agent = pane.meta?.agent;
    if (agent !== 'shell' && !(['claude', 'codex'].includes(agent) && pane.alive === false)) continue;
    rows.push({
      id: sessionId || pane.id, pane: pane.id, project: pane.meta?.project || pane.cwd,
      title: pane.meta?.title || pane.title || (agent === 'shell' ? 'shell' : 'exited session'),
      state: pane.alive ? 'running' : 'exited', kind: agent, branch: '', since: pane.createdAt,
      taskId: pane.meta?.card || '', session: false, waiting: '', alive: Boolean(pane.alive),
      sessionId, agent, accountId: pane.meta?.accountId || '', accountLabel: pane.meta?.accountLabel || '',
    });
  }

  const visible = filterFleetRows(ctx, rows);
  const groups = new Map();
  for (const row of visible) {
    const project = ctx.projectOf(row.project);
    if (!groups.has(project.key)) groups.set(project.key, { project, rows: [] });
    groups.get(project.key).rows.push(row);
  }
  const ordered = [...groups.values()].sort((a, b) => a.project.scope.localeCompare(b.project.scope) || a.project.name.localeCompare(b.project.name));
  const table = visible.length ? `<table><thead><tr><th>State</th><th>Session / pane</th><th>Branch</th><th>Card</th><th>Waiting</th><th>Last activity</th><th>Kind</th><th>Account</th><th></th></tr></thead><tbody>${ordered.map((group) => {
    const waiting = group.rows.filter((row) => row.waiting).length;
    const sessions = group.rows.filter((row) => row.session).length;
    return `<tr class="grp"><td colspan="9">${ctx.projectHTML(group.project.path, true)} <span class="group-meta">${sessions} session${sessions === 1 ? '' : 's'}${waiting ? ` · ${waiting} waiting` : ''}</span></td></tr>${group.rows.map((row) => fleetRowHTML(ctx, row, panes)).join('')}`;
  }).join('')}</tbody></table>` : `<div class="qempty"><b>No ${providerFilter === 'all' ? '' : `${providerLabel(providerFilter)} `}fleet rows match</b>Try another search or choose another provider.</div>`;

  const root = document.querySelector('#fleet');
  if (!root.querySelector('.fleetbar')) {
    root.innerHTML = `<div class="fleetbar"><input type="search" aria-label="Filter fleet" placeholder="Filter title, session, card, project, or branch" value="${ctx.esc(filter)}"><select aria-label="Filter fleet by provider"><option value="all">All</option><option value="claude">Claude Code</option><option value="codex">Codex</option></select><span class="fleet-count"></span><span class="fleet-shadow"></span></div><div class="fleet-results"></div>`;
    const input = root.querySelector('.fleetbar input');
    const select = root.querySelector('.fleetbar select');
    select.value = providerFilter;
    input.addEventListener('input', () => {
      filter = input.value;
      try { sessionStorage.setItem(FILTER_KEY, filter); } catch {}
      renderFleet(ctx);
    });
    select.addEventListener('change', () => {
      providerFilter = ['claude', 'codex'].includes(select.value) ? select.value : 'all';
      try { sessionStorage.setItem(PROVIDER_FILTER_KEY, providerFilter); } catch {}
      renderFleet(ctx);
    });
  }
  root.querySelector('.fleet-count').textContent = `${visible.length} of ${rows.length}`;
  // Graduation progress, so Owner can see it without `keep decisions stats`.
  ctx.patchHTML(root.querySelector('.fleet-shadow'), shadowSummaryHTML(ctx.data.shadowDecisions, ctx.esc));
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
        const row = rows.find((candidate) => candidate.sessionId === button.dataset.reopen);
        await ctx.reopenSession({ sessionId: button.dataset.reopen, agent: button.dataset.agent, title: button.dataset.title,
          stalePane: button.dataset.stale || undefined, project: row?.project });
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
