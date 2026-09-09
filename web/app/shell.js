let lastBadge;
let desktopPermission = 'default';

export function isDesktop() {
  return Boolean(window.__TAURI__);
}

document.documentElement.classList.toggle('desktop', isDesktop());

export function setBadge(count) {
  const next = Math.max(0, Math.floor(Number(count) || 0));
  if (next === lastBadge) return;
  lastBadge = next;
  if (isDesktop()) {
    try {
      Promise.resolve(window.__TAURI__.core?.invoke?.('set_badge', { count: next || null })).catch(() => {});
    } catch {}
    return;
  }
  document.title = next ? `(${next}) Keep` : 'Keep';
}

export function notificationPermission() {
  if (isDesktop()) return desktopPermission;
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export async function requestPermission() {
  try {
    if (isDesktop()) {
      const notification = window.__TAURI__.notification;
      if (!notification) return desktopPermission = 'unsupported';
      if (await notification.isPermissionGranted()) return desktopPermission = 'granted';
      const result = await notification.requestPermission();
      desktopPermission = result === 'granted' ? 'granted' : 'denied';
      return desktopPermission;
    }
    if (typeof Notification === 'undefined') return 'unsupported';
    if (Notification.permission !== 'default') return Notification.permission;
    return await Notification.requestPermission();
  } catch {
    return notificationPermission();
  }
}

export async function notify({ title, body, tag, onClick } = {}) {
  try {
    if (isDesktop()) {
      const notification = window.__TAURI__.notification;
      if (!notification) return;
      let granted = await notification.isPermissionGranted();
      if (!granted) granted = await requestPermission() === 'granted';
      if (!granted) return;
      const content = { title: String(title || 'Keep'), body: String(body || '') };
      try {
        await window.__TAURI__.core.invoke('send_notification', { ...content, key: String(tag || '') });
      } catch {
        // The daemon serves this JS to older installed shells too.
        await notification.sendNotification(content);
      }
      return;
    }
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const message = new Notification(String(title || 'Keep'), { body: String(body || ''), tag });
    message.onclick = () => {
      window.focus();
      onClick?.();
      message.close();
    };
  } catch {}
}

export async function installNotificationClicks(onClick) {
  if (!isDesktop()) return;
  const drain = async () => {
    const key = await window.__TAURI__.core.invoke('get_notification_click');
    if (key) await onClick(key);
  };
  try {
    await window.__TAURI__.event.listen('keep-notification-click', () => { drain().catch(() => {}); });
    await drain(); // Also recover a click delivered before the page loaded.
  } catch {}
}

export async function acknowledgeNotificationClick(key) {
  if (!isDesktop()) return;
  try { await window.__TAURI__.core.invoke('acknowledge_notification_click', { key }); } catch {}
}

if (isDesktop()) {
  Promise.resolve(window.__TAURI__.notification?.isPermissionGranted?.())
    .then((granted) => { if (granted) desktopPermission = 'granted'; })
    .catch(() => {});
}
