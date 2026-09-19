'use strict';

// The shell <-> console bridge. The app is a WebView around the Keep console, and
// this module owns every piece of that contract that is pure data: the bootstrap
// URL, the two injected scripts, and the parser for the messages the page posts.
// Nothing here touches React or React Native, so the dispatch table is testable
// with plain `node --test`.

function normalizeServer(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

// One-shot bootstrap: the daemon answers `/app?token=…` with a 302 to `/app` after
// setting an HttpOnly `keep-token` cookie, so the token never stays in the address
// the page keeps, and later loads authenticate from the cookie jar alone.
function consoleUrl(server, token) {
  const base = normalizeServer(server);
  if (!base) return '';
  const value = String(token || '').trim();
  return value ? `${base}/app?token=${encodeURIComponent(value)}` : `${base}/app`;
}

// `injectJavaScript` and `injectedJavaScriptBeforeContentLoaded` take a source
// string, so every interpolated value is escaped: U+2028/U+2029 are newlines in JS
// but not in JSON, and `<` is escaped so the text can never close a script tag.
const JS_LINE_BREAKS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g');

function jsValue(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(JS_LINE_BREAKS, (character) => (character.charCodeAt(0) === 0x2028 ? '\\u2028' : '\\u2029'))
    .replace(/</g, '\\u003c');
}

function shellDefinition({ platform = 'android', version = '' } = {}) {
  return `window.keepShell = { platform: ${jsValue(String(platform))}, version: ${jsValue(String(version))}, post(message) { window.ReactNativeWebView.postMessage(JSON.stringify(message)); } };`;
}

// Runs before the console's own scripts, so the page can feature-detect the shell
// (`window.keepShell`) on its first line and post to it right away.
function bootstrapScript(options) {
  return `${shellDefinition(options)}\ntrue;`;
}

function shellReceiveScript(message) {
  return `window.keepShellReceive && window.keepShellReceive(${jsValue(message)});\ntrue;`;
}

// react-native-webview does not guarantee that the before-content-loaded injection
// beats the page's own scripts on Android, so this runs again once the page has
// loaded: it defines the shell if that injection lost the race, then says hello.
// The console answers `hello` by switching to mobile mode and re-posting `ready`
// and its last badge, which is why a second `ready` has to be harmless.
function helloScript(options) {
  return `if (!window.keepShell) { ${shellDefinition(options)} }\n${shellReceiveScript({ type: 'hello' })}`;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clip(value, max) {
  const trimmed = String(value ?? '').replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

// Only http(s) leaves the app. A `javascript:` or `file:` URL handed to
// Linking.openURL is the page choosing what the phone opens, so it is dropped.
function externalUrl(value) {
  const url = text(value);
  return /^https?:\/\/\S+$/i.test(url) ? url : '';
}

// Returns a normalized message, or null when the payload is not one the shell
// knows how to act on. Unknown types are dropped rather than guessed at: the page
// and the shell ship separately, so a newer console will post types this build has
// never heard of.
function parseBridgeMessage(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); }
    catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  switch (text(parsed.type)) {
    case 'ready':
      return { type: 'ready' };
    case 'unauthorized':
      return { type: 'unauthorized' };
    case 'badge': {
      const count = Number(parsed.count);
      if (!Number.isFinite(count) || count < 0) return null;
      return { type: 'badge', count: Math.min(9999, Math.floor(count)) };
    }
    case 'notify': {
      const title = clip(parsed.title, 120);
      const body = clip(parsed.body, 240);
      if (!title && !body) return null;
      return { type: 'notify', title: title || 'Keep', body, key: text(parsed.key) || null };
    }
    case 'openTerminal': {
      const session = text(parsed.session);
      const pane = text(parsed.pane);
      if (!session && !pane) return null;
      return { type: 'openTerminal', session: session || null, pane: pane || null, title: clip(parsed.title, 120) || null };
    }
    case 'openExternal': {
      const url = externalUrl(parsed.url);
      return url ? { type: 'openExternal', url } : null;
    }
    default:
      return null;
  }
}

// The `keep-session` cookie the `?token=` bootstrap sets is opaque and lives only in
// the daemon's memory, so every restart forgets it. Re-bootstrapping is therefore
// ordinary rather than exceptional, and these rules keep it from becoming a loop:
// the debounce guards *retries*, not the WebView's own first load, and two refusals
// in a row stop the retrying and put the token in front of the person instead.
const BOOTSTRAP_DEBOUNCE_MS = 10000;
const BOOTSTRAP_STALE_MS = 5 * 60 * 1000;
const BOOTSTRAP_MAX_FAILURES = 2;

function bootstrapState() {
  return { at: 0, failures: 0 };
}

// Pure: `{ action, state }` from the previous state, the trigger, and the clock.
// `event.reason` is 'unauthorized' (a 403 on the top frame, or the console saying
// so), 'foreground' (with `awayMs`), or 'ready' (the console came up).
function decideBootstrap(state, event = {}, now = Date.now()) {
  const at = Number(state?.at) || 0;
  const previous = Number(state?.failures) || 0;
  const reason = text(event.reason);

  // The console is up, so the session works; whatever failed before it does not count.
  if (reason === 'ready') return { action: 'ignore', state: { at, failures: 0 } };

  // A short trip to another app does not cost the session, and reloading the console
  // under someone who just switched back is worse than a stale page.
  if (reason === 'foreground' && !(Number(event.awayMs) >= BOOTSTRAP_STALE_MS)) {
    return { action: 'ignore', state: { at, failures: previous } };
  }

  const failures = reason === 'unauthorized' ? previous + 1 : previous;
  if (failures >= BOOTSTRAP_MAX_FAILURES) return { action: 'show-error', state: { at, failures } };

  // The first refusal since the console last came up always earns its retry: a
  // session dropped by a daemon restart is the common case and recovers unnoticed.
  if (reason === 'unauthorized' && failures === 1) return { action: 'bootstrap', state: { at: now, failures } };

  if (at && now - at < BOOTSTRAP_DEBOUNCE_MS) return { action: 'ignore', state: { at, failures } };
  return { action: 'bootstrap', state: { at: now, failures } };
}

// `handlers` is the dispatch table: { ready, unauthorized, badge, notify, openTerminal, openExternal }.
// Returns the message that was dispatched, or null when nothing ran.
function dispatchBridgeMessage(raw, handlers = {}) {
  const message = parseBridgeMessage(raw);
  if (!message) return null;
  const handler = handlers[message.type];
  if (typeof handler !== 'function') return null;
  handler(message);
  return message;
}

module.exports = {
  BOOTSTRAP_DEBOUNCE_MS,
  BOOTSTRAP_MAX_FAILURES,
  BOOTSTRAP_STALE_MS,
  bootstrapScript,
  bootstrapState,
  consoleUrl,
  decideBootstrap,
  dispatchBridgeMessage,
  helloScript,
  normalizeServer,
  parseBridgeMessage,
  shellReceiveScript,
};
