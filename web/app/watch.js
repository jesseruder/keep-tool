import * as api from './api.js';
import { sessionExplanation } from './status.js';
import { accountLabelHTML, handoffControls, installHandoffControls } from './account-controls.js';

const SHELL_PROJECT_KEY = 'keep.console.shellProject';

function savedShellProject() {
  try { return localStorage.getItem(SHELL_PROJECT_KEY) || ''; }
  catch { return ''; }
}

function currentLayout(ctx) {
  if (!ctx.state.layouts.length) ctx.state.layouts = [{ name: 'Pinned', ids: [], cols: 0, role: 'pinned' }];
  if (ctx.state.layout >= ctx.state.layouts.length) ctx.state.layout = 0;
  return ctx.state.layouts[ctx.state.layout];
}

async function save(ctx) {
  try { await ctx.saveLayouts(); }
  catch (error) { ctx.toast(`Layout save failed: ${error.message}`); }
}

function paneRow(ctx, pane, controls = '') {
  const entity = ctx.entityForPane(pane.id);
  return `<div class="row">${ctx.projectHTML(entity.project)}<b>${ctx.esc(entity.title)}${entity.reviewer ? ' <span class="rv">reviewer</span>' : ''}</b><span class="st" title="${ctx.esc(sessionExplanation(entity.session))}">${ctx.esc(entity.stateLabel || entity.state)}</span>${controls}</div>`;
}

function renderEditor(ctx, layout) {
  const editor = document.querySelector('#wedit');
  editor.classList.toggle('on', ctx.state.editing);
  document.querySelector('#editLayout').classList.toggle('on', ctx.state.editing);
  if (!ctx.state.editing) { ctx.clearElement(editor); return; }
  const paneMap = ctx.paneMap();
  const inLayout = layout.ids.map((id) => paneMap.get(id)).filter(Boolean);
  const candidates = [...paneMap.values()].filter((pane) => !layout.ids.includes(pane.id)).filter((pane) => {
    const entity = ctx.entityForPane(pane.id);
    return !ctx.state.pickFilter || `${entity.title} ${entity.project}`.toLowerCase().includes(ctx.state.pickFilter);
  });
  const html = `<label>Name <input name="name" value="${ctx.esc(layout.name)}" size="18"></label><label>Columns <select name="cols"><option value="0" ${layout.cols === 0 ? 'selected' : ''}>auto</option>${[1, 2, 3, 4].map((cols) => `<option value="${cols}" ${layout.cols === cols ? 'selected' : ''}>${cols}</option>`).join('')}</select></label><button class="btn danger" data-delete>Delete layout</button><button class="btn" data-done>Done</button><div class="col"><span class="lbl">In this layout · ${inLayout.length}</span>${inLayout.map((pane, index) => paneRow(ctx, pane, `<button data-move="${index}:-1" ${index === 0 ? 'disabled' : ''}>◀</button><button data-move="${index}:1" ${index === inLayout.length - 1 ? 'disabled' : ''}>▶</button><button data-remove="${ctx.esc(pane.id)}">✕</button>`)).join('') || '<div class="row muted">empty</div>'}</div><div class="col"><span class="lbl">Add a pane</span><input name="pick" placeholder="filter by title or project" value="${ctx.esc(ctx.state.pickFilter)}"><div class="pick">${candidates.map((pane) => paneRow(ctx, pane, `<button class="add" data-add="${ctx.esc(pane.id)}">+ add</button>`)).join('') || '<div class="row muted">nothing matches</div>'}</div></div>`;
  if (!ctx.patchHTML(editor, html)) return;
  editor.querySelector('[name=name]').addEventListener('input', (event) => {
    layout.name = event.target.value || 'Untitled';
    save(ctx);
    const active = document.querySelector('#layouts .chip.on');
    if (active) active.innerHTML = `${ctx.esc(layout.name)} <span class="n">${ctx.knownPaneCount(layout)}</span>`;
  });
  editor.querySelector('[name=cols]').addEventListener('change', (event) => { layout.cols = Number(event.target.value); save(ctx); ctx.refresh(); });
  editor.querySelector('[name=pick]').addEventListener('input', (event) => {
    ctx.state.pickFilter = event.target.value.toLowerCase();
    const position = event.target.selectionStart;
    ctx.refresh();
    const input = document.querySelector('#wedit [name=pick]');
    input?.focus();
    input?.setSelectionRange(position, position);
  });
  editor.querySelector('[data-delete]').addEventListener('click', () => {
    if (ctx.state.layouts.length === 1) { ctx.toast('Keep at least one layout'); return; }
    ctx.state.layouts.splice(ctx.state.layout, 1);
    ctx.state.layout = 0;
    save(ctx);
    ctx.refresh();
  });
  editor.querySelector('[data-done]').addEventListener('click', () => { ctx.state.editing = false; ctx.refresh(); });
  editor.querySelectorAll('[data-move]').forEach((button) => button.addEventListener('click', () => {
    const [index, direction] = button.dataset.move.split(':').map(Number);
    const target = index + direction;
    [layout.ids[index], layout.ids[target]] = [layout.ids[target], layout.ids[index]];
    save(ctx);
    ctx.refresh();
  }));
  editor.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => {
    layout.ids = layout.ids.filter((id) => id !== button.dataset.remove);
    save(ctx);
    ctx.refresh();
  }));
  editor.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => {
    layout.ids.push(button.dataset.add);
    save(ctx);
    ctx.refresh();
  }));
}

function renderGrid(ctx, layout) {
  const grid = document.querySelector('#wgrid');
  const panes = layout.ids.map((id) => ctx.paneMap().get(id)).filter((pane) => pane && !ctx.isClosingSession(pane.meta?.sessionId, pane.id));
  const columns = layout.cols || (panes.length <= 1 ? 1 : panes.length <= 4 ? 2 : 3);
  const gridKey = `${columns}:${panes.map((pane) => pane.id).join(',')}`;
  const gridChanged = grid.dataset.gridKey !== gridKey;
  grid.dataset.gridKey = gridKey;
  grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
  if (!panes.length) {
    const html = '<span>Nothing in this layout yet. Press <kbd>e</kbd> to add panes, or <kbd>p</kbd> on a triage item to pin it here.</span>';
    if (grid.children.length !== 1 || !grid.firstElementChild.classList.contains('wempty')) {
      grid.innerHTML = `<div class="wempty">${html}</div>`;
    } else if (grid.firstElementChild.innerHTML !== html) {
      grid.firstElementChild.innerHTML = html;
    }
    if (gridChanged) ctx.scheduleTerminalFit();
    return;
  }
  const existing = new Map([...grid.querySelectorAll(':scope > .wpane')].map((element) => [element.dataset.pane, element]));
  const retained = new Set();
  let cursor = grid.firstElementChild;
  for (const pane of panes) {
    const entity = ctx.entityForPane(pane.id);
    let element = existing.get(pane.id);
    if (!element) {
      element = document.createElement('div');
      element.className = 'wpane';
      element.dataset.pane = pane.id;
      element.innerHTML = '<div class="ph"></div><div class="pane-terminal"></div>';
    }
    const shell = pane.meta?.agent === 'shell';
    const closable = pane.alive && ['claude', 'codex'].includes(pane.meta?.agent) && pane.meta?.sessionId;
    const exitedAgent = pane.alive === false && ['claude', 'codex'].includes(pane.meta?.agent);
    ctx.patchHTML(element.querySelector('.ph'), `<div class="session-heading"><b>${ctx.esc(entity.title)}</b><div class="meta">${ctx.projectHTML(entity.project)}${entity.taskId ? `<span class="proj">${ctx.esc(entity.taskId)}</span>${ctx.tagsHTML(ctx.taskFor(entity))}` : ''}${accountLabelHTML(ctx, entity.session, pane)}</div></div><span class="st"><i class="${ctx.esc(entity.state)}"></i>${ctx.esc(entity.stateLabel || entity.state)}</span><button data-unpin title="unpin">✕</button>${closable ? '<button data-close-session>Close</button>' : ''}${shell ? `<button data-kill title="${pane.alive ? 'kill' : 'remove'}">${pane.alive ? '■' : '⌫'}</button>` : ''}${exitedAgent ? '<button data-reopen title="reopen">Reopen</button><button data-remove-pane title="remove">Remove</button>' : ''}`);
    retained.add(element);
    const closeButton = element.querySelector('[data-close-session]');
    if (closeButton) closeButton.onclick = () => closeSession(ctx, pane.meta.sessionId, pane.id, closeButton);
    if (closable && !entity.session?.reviewer) {
      const header = element.querySelector('.ph');
      let accounts = header.querySelector('.account-controls');
      if (!accounts) { accounts = document.createElement('div'); accounts.className = 'account-controls'; header.append(accounts); }
      ctx.patchHTML(accounts, handoffControls(ctx, pane.meta.sessionId, pane.id));
      installHandoffControls(accounts, ctx, pane.meta.sessionId, pane.id);
      let controls = header.querySelector('.restart-controls');
      if (!controls) { controls = document.createElement('span'); controls.className = 'restart-controls'; header.append(controls); }
      ctx.patchHTML(controls, restartControls(ctx, pane.meta.sessionId));
      installRestartControls(controls, ctx, pane.meta.sessionId, pane.id);
    }
    if (element !== cursor) grid.insertBefore(element, cursor);
    cursor = element.nextElementSibling;
    const focus = ctx.state.focusPane === pane.id;
    ctx.mount(element.querySelector('.pane-terminal'), pane.id, { slot: `watch:${pane.id}`, focus });
    if (focus) ctx.state.focusPane = null;
    element.querySelector('[data-unpin]').onclick = () => {
      layout.ids = layout.ids.filter((id) => id !== pane.id);
      save(ctx);
      ctx.refresh();
    };
    const kill = element.querySelector('[data-kill]');
    if (kill) kill.onclick = async () => {
      try {
        if (pane.alive) await api.killPane(pane.id);
        else await api.removePane(pane.id);
        await ctx.dropPane(pane.id);
        ctx.toast(pane.alive ? 'Pane kill requested' : 'Pane removed');
        await ctx.reload();
      } catch (error) { ctx.toast(error.message); }
    };
    const reopen = element.querySelector('[data-reopen]');
    if (reopen) reopen.onclick = async () => {
      if (reopen.disabled) return;
      reopen.disabled = true;
      try {
        await ctx.reopenSession({
          sessionId: pane.meta?.sessionId, agent: pane.meta?.agent, title: entity.title, stalePane: pane.id,
        });
      } finally { reopen.disabled = false; }
    };
    const remove = element.querySelector('[data-remove-pane]');
    if (remove) remove.onclick = async () => {
      if (remove.disabled) return;
      remove.disabled = true;
      try { await ctx.removePane(pane.id); ctx.toast('Pane removed'); }
      catch (error) { ctx.toast(`Could not remove: ${error.message}`); }
      finally { remove.disabled = false; }
    };
  }
  for (const child of [...grid.children]) if (!retained.has(child)) child.remove();
  if (gridChanged) ctx.scheduleTerminalFit();
}

export function renderWatch(ctx) {
  const layouts = document.querySelector('#layouts');
  const layout = currentLayout(ctx);
  layouts.innerHTML = ctx.state.layouts.map((item, index) => `<button class="chip ${index === ctx.state.layout ? 'on' : ''}" data-layout="${index}">${ctx.esc(item.name)} <span class="n">${ctx.knownPaneCount(item)}</span></button>`).join('');
  layouts.querySelectorAll('[data-layout]').forEach((button) => button.addEventListener('click', () => { ctx.state.layout = Number(button.dataset.layout); ctx.refresh(); }));
  const projectSelect = document.querySelector('#shellProject');
  const projects = ctx.knownProjects().filter((project) => project.path);
  const selected = projectSelect.value;
  const values = projects.map((project) => project.path);
  const currentValues = [...projectSelect.options].map((option) => option.value);
  if (values.join('\n') !== currentValues.join('\n')) {
    projectSelect.innerHTML = projects.map((project) => `<option value="${ctx.esc(project.path)}">${ctx.esc(project.name)}</option>`).join('');
    const restored = [selected, savedShellProject(), values[0]].find((value) => values.includes(value));
    if (restored) projectSelect.value = restored;
  }
  renderEditor(ctx, layout);
  renderGrid(ctx, layout);
}

export function installWatchControls(ctx) {
  const projectSelect = document.querySelector('#shellProject');
  const savedProject = savedShellProject();
  if ([...projectSelect.options].some((option) => option.value === savedProject)) projectSelect.value = savedProject;
  projectSelect.addEventListener('change', () => {
    try { localStorage.setItem(SHELL_PROJECT_KEY, projectSelect.value); } catch {}
  });
  document.querySelector('#newLayout').addEventListener('click', () => {
    ctx.state.layouts.push({ name: 'New layout', ids: [], cols: 0 });
    ctx.state.layout = ctx.state.layouts.length - 1;
    ctx.state.editing = true;
    save(ctx);
    ctx.refresh();
    document.querySelector('#wedit [name=name]')?.select();
  });
  document.querySelector('#editLayout').addEventListener('click', () => { ctx.state.editing = !ctx.state.editing; ctx.refresh(); });
  document.querySelector('#spawnShell').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (button.disabled) return;
    const cwd = document.querySelector('#shellProject').value;
    if (!cwd) { ctx.toast('No known project directory'); return; }
    button.disabled = true;
    button.blur();
    ctx.state.pendingFocus = true;
    try {
      const pane = await ctx.startShell(cwd);
      if (!currentLayout(ctx).ids.includes(pane.id)) currentLayout(ctx).ids.push(pane.id);
      ctx.state.focusPane = pane.id;
      ctx.refresh();
      await ctx.saveLayouts();
      await ctx.reload();
      ctx.toast(`Shell started in ${ctx.projectOf(cwd).name}`);
    } catch (error) { ctx.toast(error.message); }
    finally { button.disabled = false; ctx.state.pendingFocus = false; }
  });
}
import { closeSession } from './close-session.js';
import { restartControls, installRestartControls } from './restart-session.js';
