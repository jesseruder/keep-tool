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
    case 'authenticated':
      return { type: 'authenticated' };
    case 'unauthorized':
      return { type: 'unauthorized' };
    case 'history': {
      // How many history entries the console's phone layout holds over its base page.
      const depth = Number(parsed.depth);
      if (!Number.isFinite(depth) || depth < 0) return null;
      return { type: 'history', depth: Math.min(999, Math.floor(depth)) };
    }
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
// ordinary rather than exceptional — and, left ungoverned, a loop: the app reloads
// the page, the page refuses again, and nothing bounds it.
//
// Three independent brakes, because any one of them alone has a hole. The failure
// count stops a token that is simply wrong. The interval stops a fast flap. The
// ceiling stops a slow one that would otherwise clear the interval forever.
//
// Only `authenticated` clears the failure count, and only the daemon answering a
// real request 200 produces it. `ready` means the page's scripts ran, which happens
// before any request and again after every `hello`, so treating it as proof of a
// working session is what let alternating ready/unauthorized reload in a tight loop.
//
// A failure is an attempted bootstrap that `authenticated` never followed. A refusal
// the interval merely postponed is not one: counting those walled a phone with a
// perfectly good token behind the error panel after two daemon restarts close
// together, having never retried the second. Postponed refusals become a pending
// retry instead, and `retryAt` says when it may run.
const BOOTSTRAP_DEBOUNCE_MS = 10000;
const BOOTSTRAP_STALE_MS = 5 * 60 * 1000;
const BOOTSTRAP_MAX_FAILURES = 2;
const BOOTSTRAP_CEILING = 3;
const BOOTSTRAP_CEILING_MS = 5 * 60 * 1000;

function bootstrapState() {
  // `fresh` is the single exemption from the interval, spent on the first refusal
  // after a mount so a daemon restart recovers at once. Nothing re-arms it but a
  // deliberate retry.
  return { at: 0, failures: 0, recent: [], fresh: true, pending: false };
}

function normalizeBootstrapState(state) {
  return {
    at: Number(state?.at) || 0,
    failures: Number(state?.failures) || 0,
    recent: Array.isArray(state?.recent) ? state.recent.filter((at) => Number.isFinite(at)) : [],
    fresh: state?.fresh !== false,
    pending: state?.pending === true,
  };
}

// Pure: `{ action, state, retryAt }` from the previous state, the trigger, and the
// clock. `event.reason` is 'unauthorized' (a 403 on the top frame, or the console
// saying so), 'foreground' (with `awayMs`), 'authenticated', or 'retry' (the caller's
// timer, firing at a `retryAt` this returned). Anything else is ignored — an
// unrecognized reason must never be able to reach the reload.
function decideBootstrap(state, event = {}, now = Date.now()) {
  const current = normalizeBootstrapState(state);
  const reason = text(event.reason);

  // A working session settles everything behind it, including a waiting retry.
  if (reason === 'authenticated') {
    return { action: 'ignore', state: { ...current, failures: 0, pending: false }, retryAt: 0 };
  }

  let wanted = reason === 'unauthorized';
  // A short trip to another app does not cost the session, and reloading under
  // someone who just switched back is worse than a stale page.
  if (reason === 'foreground') wanted = Number(event.awayMs) >= BOOTSTRAP_STALE_MS;
  else if (reason === 'retry') wanted = current.pending;
  else if (reason !== 'unauthorized') wanted = false;
  // Whatever else happens, a retry already waiting keeps waiting.
  if (!wanted) {
    return {
      action: 'ignore',
      state: current,
      retryAt: current.pending ? current.at + BOOTSTRAP_DEBOUNCE_MS : 0,
    };
  }

  if (current.failures >= BOOTSTRAP_MAX_FAILURES) {
    return { action: 'show-error', state: { ...current, pending: false }, retryAt: 0 };
  }

  const recent = current.recent.filter((at) => now - at < BOOTSTRAP_CEILING_MS);
  if (recent.length >= BOOTSTRAP_CEILING) {
    return { action: 'show-error', state: { ...current, recent, pending: false }, retryAt: 0 };
  }

  const exempt = current.fresh && reason === 'unauthorized';
  if (!exempt && current.at && now - current.at < BOOTSTRAP_DEBOUNCE_MS) {
    // Postponed, not refused: nothing is counted, and the caller is told when to
    // come back so the refusal is not simply dropped.
    return {
      action: 'ignore',
      state: { ...current, recent, pending: true },
      retryAt: current.at + BOOTSTRAP_DEBOUNCE_MS,
    };
  }

  return {
    action: 'bootstrap',
    state: {
      at: now,
      failures: current.failures + 1,
      recent: [...recent, now],
      fresh: current.fresh && reason !== 'unauthorized',
      pending: false,
    },
    retryAt: 0,
  };
}

// Shell -> console messages for a console that is not up yet. `send` refuses until
// the page has posted `ready`, and a notification tapped from a cold start is
// delivered before the WebView has loaded anything at all, so the shell keeps what
// was refused rather than assuming a handover worked.
const SHELL_QUEUE_LIMIT = 5;

function queueShellMessage(queue, message, limit = SHELL_QUEUE_LIMIT) {
  return [...(Array.isArray(queue) ? queue : []), message].slice(-limit);
}

// Hands the queue to `send` in order and returns what is left: everything from the
// first refusal on. Stopping there is what keeps the order — a later message must
// never arrive at the console before an earlier one it was queued behind.
function drainShellQueue(queue, send) {
  const rows = Array.isArray(queue) ? queue : [];
  for (let index = 0; index < rows.length; index += 1) {
    if (!send(rows[index])) return rows.slice(index);
  }
  return [];
}

// `handlers` is the dispatch table: { ready, authenticated, unauthorized, badge,
// notify, openTerminal, openExternal }.
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
  BOOTSTRAP_CEILING,
  BOOTSTRAP_CEILING_MS,
  BOOTSTRAP_DEBOUNCE_MS,
  BOOTSTRAP_MAX_FAILURES,
  BOOTSTRAP_STALE_MS,
  SHELL_QUEUE_LIMIT,
  bootstrapScript,
  bootstrapState,
  consoleUrl,
  decideBootstrap,
  dispatchBridgeMessage,
  drainShellQueue,
  helloScript,
  normalizeServer,
  parseBridgeMessage,
  queueShellMessage,
  shellReceiveScript,
};
