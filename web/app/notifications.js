import { write } from './api.js';
import { isDesktop, notificationPermission, notify, requestPermission } from './shell.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function installNotifications({ reload, toast, openSession, openReviewer }) {
  const button = document.querySelector('#notificationsButton');
  const panel = document.querySelector('#notificationsPanel');
  const list = panel.querySelector('.notification-list');
  const preview = document.createElement('button');
  preview.className = 'notification-preview';
  preview.hidden = true;
  preview.setAttribute('aria-haspopup', 'dialog');
  preview.setAttribute('aria-controls', 'notificationsPanel');
  button.closest('.bar').after(preview);
  preview.addEventListener('click', () => open(preview.dataset.id));
  let data = {}, selected = null, filter = 'all', signature = '', afterClose = null;
  const attempted = new Set();
  const entries = () => data.notifications || [];
  const unread = () => entries().filter((entry) => !entry.read).length;
  const change = async (ids, action) => {
    try {
      // Bound each request; only mark the IDs the user actually saw in this snapshot.
      for (let start = 0; start < ids.length; start += 1000) {
        await write('/api/notifications', { ids: ids.slice(start, start + 1000), action });
      }
      await reload();
    } catch (error) { toast(`Could not update notifications: ${error.message}`); }
  };
  function render() {
    button.querySelector('.notification-count').textContent = unread() || '';
    button.setAttribute('aria-label', `Notifications${unread() ? `, ${unread()} unread` : ''}`);
    button.classList.toggle('has-unread', unread() > 0);
    const latest = entries().find((entry) => !entry.read && entry.level !== 'brief');
    preview.hidden = !latest || panel.open;
    if (latest) {
      preview.dataset.id = latest.id;
      preview.innerHTML = `<b>${esc(latest.from === 'manual' ? 'Keep' : latest.from || 'Keep')} · ${unread()} unread</b><span>${esc(latest.text)}</span><strong>Read notification →</strong>`;
    }
    if (!panel.open) return;
    panel.querySelector('[data-mark-all]').disabled = !unread();
    panel.querySelector('[data-filter="all"]').setAttribute('aria-pressed', filter === 'all');
    panel.querySelector('[data-filter="unread"]').setAttribute('aria-pressed', filter === 'unread');
    const permission = notificationPermission();
    const permissionButton = panel.querySelector('[data-enable]');
    permissionButton.hidden = permission === 'granted' || permission === 'unsupported';
    permissionButton.textContent = permission === 'denied' ? 'Notifications disabled in system settings' : 'Enable desktop notifications';
    permissionButton.disabled = permission === 'denied';
    const visible = entries().filter((entry) => filter !== 'unread' || !entry.read || entry.id === selected);
    const nextSignature = JSON.stringify([visible, selected, data.tasks, data.sessions]);
    if (signature === nextSignature) return;
    signature = nextSignature;
    const active = document.activeElement;
    const focused = list.contains(active) ? {
      id: active.closest('[data-id]')?.dataset.id,
      action: ['data-select', 'data-read', 'data-session', 'data-reviewer'].find((name) => active.hasAttribute(name)),
    } : null;
    list.innerHTML = visible.length ? visible.map((entry) => {
      const task = (data.tasks || []).find((task) => task.id === entry.card);
      const session = (data.sessions || []).find((session) => session.taskId === entry.card && !session.reviewer);
      const expanded = selected === entry.id;
      const date = new Date(entry.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      return `<article class="notification-item ${entry.read ? '' : 'unread'} ${expanded ? 'selected' : ''}" data-id="${esc(entry.id)}">
        <button class="notification-message" data-select="${esc(entry.id)}" aria-expanded="${expanded}">
          <span class="notification-meta"><b>${esc(entry.from === 'manual' ? 'Keep' : entry.from || 'Keep')}</b><time>${esc(date)}</time>${entry.level === 'urgent' ? '<strong>Urgent</strong>' : ''}${!entry.read ? '<span class="notification-unread" aria-label="Unread"></span>' : ''}</span>
          <span class="notification-text">${esc(entry.text)}</span>
          ${entry.card ? `<span class="notification-card">${esc(task?.fm?.title || entry.card)}</span>` : ''}
        </button>
        <div class="notification-actions"><button class="btn" data-read="${esc(entry.id)}" data-action="${entry.read ? 'unread' : 'read'}">Mark ${entry.read ? 'unread' : 'read'}</button>
          ${session ? `<button class="btn" data-session="${esc(session.id)}">Open session</button>` : ''}
          ${entry.caller === 'reviewer' ? '<button class="btn" data-reviewer>Open reviewer</button>' : ''}
        </div>
        ${expanded && entry.card ? `<div class="notification-detail">${task ? `<b>${esc(task.fm?.title || task.id)}</b><span class="muted">${esc(task.fm?.status || '')}</span><pre>${esc(task.body || 'No card notes yet.')}</pre>` : '<p>This card is no longer in the active task list.</p>'}</div>` : ''}
      </article>`;
    }).join('') : `<div class="qempty"><b>${filter === 'unread' ? 'You’re caught up' : 'No notifications yet'}</b>Reviewer findings, results, and agent heads-ups appear here.<br>Session questions stay in Waiting on you.</div>`;
    if (focused) {
      const replacement = [...list.querySelectorAll('button')].find((node) =>
        node.closest('[data-id]')?.dataset.id === focused.id && focused.action && node.hasAttribute(focused.action));
      (replacement || panel.querySelector(`[data-filter="${filter}"]`)).focus({ preventScroll: true });
    }
  }
  function open(id) {
    selected = id || null;
    if (id) filter = 'all';
    if (!panel.open) panel.showModal();
    button.setAttribute('aria-expanded', 'true');
    render();
    if (id) {
      [...list.querySelectorAll('[data-id]')].find((node) => node.dataset.id === id)?.scrollIntoView({ block: 'nearest' });
      if (entries().some((entry) => entry.id === id && !entry.read)) void change([id], 'read');
      else if (!entries().some((entry) => entry.id === id)) toast('This notification is no longer available.');
    }
  }
  button.addEventListener('click', () => open());
  panel.addEventListener('close', () => {
    button.setAttribute('aria-expanded', 'false');
    render();
    const navigate = afterClose;
    afterClose = null;
    if (navigate) navigate();
    else button.focus();
  });
  panel.addEventListener('click', (event) => {
    // Backdrop clicks target the dialog too; keep clicks in its empty space open.
    if (event.target === panel) {
      const rect = panel.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right
          || event.clientY < rect.top || event.clientY > rect.bottom) panel.close();
      return;
    }
    const target = event.target.closest('button');
    if (!target) return;
    if (target.hasAttribute('data-close')) panel.close();
    else if (target.dataset.filter) { filter = target.dataset.filter; selected = null; render(); }
    else if (target.hasAttribute('data-mark-all')) void change(entries().filter((entry) => !entry.read).map((entry) => entry.id), 'read');
    else if (target.dataset.read) void change([target.dataset.read], target.dataset.action);
    else if (target.dataset.select) open(target.dataset.select);
    else if (target.dataset.session) { afterClose = () => openSession(target.dataset.session); panel.close(); }
    else if (target.hasAttribute('data-reviewer')) { afterClose = openReviewer; panel.close(); }
    else if (target.hasAttribute('data-enable')) void requestPermission().then(render);
  });
  async function deliver(entry) {
    try {
      const result = await write('/api/notifications', { ids: [entry.id], action: 'claim' });
      if (result.claimed) await notify({ title: `${entry.from === 'manual' ? 'Keep' : entry.from || 'Keep'}${entry.level === 'urgent' ? ' · Urgent' : ''}`, body: entry.text, tag: `alert:${entry.id}`, onClick: () => open(entry.id) });
    } catch { attempted.delete(entry.id); }
  }
  return {
    open,
    update(nextData) {
      data = nextData;
      render();
      if (!isDesktop() || notificationPermission() !== 'granted') return;
      for (const entry of entries()) {
        if (attempted.has(entry.id) || entry.desktop !== true || entry.read || entry.deferred || entry.level === 'brief'
            || entry.presence?.state !== 'present' || Date.now() - entry.at >= 120000) continue;
        // Viewing the inbox is already delivery; claim without creating a banner.
        attempted.add(entry.id);
        if (panel.open && document.hasFocus()) {
          void write('/api/notifications', { ids: [entry.id], action: 'claim' }).catch(() => attempted.delete(entry.id));
        } else void deliver(entry);
      }
    },
    unread,
  };
}
