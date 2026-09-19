let lastBadge;
let desktopPermission = 'default';
let mobileNotificationClick = null;
let readyRequested = false;

export function isDesktop() {
  return Boolean(window.__TAURI__);
}

// The Android WebView shell injects `window.keepShell` before page scripts run:
// `{ platform, version, post(message) }`, where post() serializes `{type, ...}`
// to the app. The app calls `window.keepShellReceive(message)` the other way.
// Evaluated on every call: WebView pre-load injection is best-effort on Android,
// so the shell may only appear after this module has run, announcing itself with
// `{type:'hello'}`.
export function isMobileShell() {
  return Boolean(window.keepShell);
}

export function postShell(message) {
  if (!isMobileShell()) return false;
  try {
    window.keepShell.post(message);
    return true;
  } catch { return false; }
}

document.documentElement.classList.toggle('desktop', isDesktop());
document.documentElement.classList.toggle('mobile', isMobileShell());

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
  // A WebView has no title bar to count in; the app owns the launcher badge.
  if (isMobileShell()) {
    postShell({ type: 'badge', count: next });
    return;
  }
  document.title = next ? `(${next}) Keep` : 'Keep';
}

export function notificationPermission() {
  if (isDesktop()) return desktopPermission;
  if (isMobileShell()) return 'granted'; // the app owns the OS permission
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
    if (isMobileShell()) return 'granted';
    if (typeof Notification === 'undefined') return 'unsupported';
    if (Notification.permission !== 'default') return Notification.permission;
    return await Notification.requestPermission();
  } catch {
    return notificationPermission();
  }
}

export async function notify({ title, body, tag, onClick } = {}) {
  try {
    const content = { title: String(title || 'Keep'), body: String(body || '') };
    if (isDesktop()) {
      const notification = window.__TAURI__.notification;
      if (!notification) return;
      let granted = await notification.isPermissionGranted();
      if (!granted) granted = await requestPermission() === 'granted';
      if (!granted) return;
      try {
        await window.__TAURI__.core.invoke('send_notification', { ...content, key: String(tag || '') });
      } catch {
        // The daemon serves this JS to older installed shells too.
        await notification.sendNotification(content);
      }
      return;
    }
    if (isMobileShell()) {
      postShell({ type: 'notify', ...content, key: String(tag || '') });
      return;
    }
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const message = new Notification(content.title, { body: content.body, tag });
    message.onclick = () => {
      window.focus();
      onClick?.();
      message.close();
    };
  } catch {}
}

export async function installNotificationClicks(onClick) {
  // Kept whether or not the shell is here yet: the app delivers taps through
  // keepShellReceive, and there is nothing to poll or unwind if it never comes.
  mobileNotificationClick = onClick;
  if (isMobileShell() || !isDesktop()) return;
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
  if (!isDesktop()) return; // the mobile app dismisses its own notifications
  try { await window.__TAURI__.core.invoke('acknowledge_notification_click', { key }); } catch {}
}

// The console is subscribed and has asked for its first state: the shell may
// show the page instead of its splash.
export function shellReady() {
  readyRequested = true;
  postShell({ type: 'ready' });
}

export function receiveShellMessage(message) {
  const type = message?.type;
  if (type === 'hello') {
    // The shell arrived after this module ran, or reattached to a live page.
    // Redo the load-time work and replay what it missed.
    document.documentElement.classList.toggle('mobile', isMobileShell());
    // The phone layout listens for this: it has to borrow the rail and raise the
    // tab bar when the shell only shows up after the page has loaded.
    try { window.dispatchEvent(new Event('keep-shell-hello')); } catch {}
    if (readyRequested) postShell({ type: 'ready' });
    if (lastBadge != null) postShell({ type: 'badge', count: lastBadge });
  } else if (type === 'notificationClick') {
    const key = message.key;
    if (key && mobileNotificationClick) Promise.resolve(mobileNotificationClick(key)).catch(() => {});
  } else if (type === 'reload') location.reload();
}

// Defined unconditionally: a shell that shows up late still has somewhere to
// send its hello, and on any other page nothing ever calls it.
window.keepShellReceive = receiveShellMessage;

if (isDesktop()) {
  Promise.resolve(window.__TAURI__.notification?.isPermissionGranted?.())
    .then((granted) => { if (granted) desktopPermission = 'granted'; })
    .catch(() => {});
}

export async function playAttentionSound() {
  if (!isDesktop()) return; // a no-op on mobile: the app owns its own sounds
  try { await window.__TAURI__.core.invoke('play_attention_sound'); } catch {}
}
