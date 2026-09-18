// Service worker entry: hold the native port, dispatch requests, and keep the
// session -> tab group bookkeeping straight.

import { NativeBridge } from "./lib/native.js";
import { dropTab, detach, installListeners, peekTab } from "./lib/cdp.js";
import {
  activityGeneration,
  allSessions,
  forgetActivity,
  forgetGroup,
  forgetSession,
  getSession,
  noteActivity,
  putSession,
  reviveSession,
  tabsInGroup,
  withSessionLock,
} from "./lib/sessions.js";
import { handlerFor } from "./tools/index.js";

const KEEPALIVE_ALARM = "browser-bridge-keepalive";
const BLANK_URLS = new Set(["about:blank", "about:newtab", "chrome://newtab/", "edge://newtab/", ""]);

installListeners();

// Edge kills the host whenever the worker sleeps, so a disconnect is routine: retry
// quickly at first, then back off so a machine with no installed host is not woken
// every second forever. The keepalive alarm is the backstop.
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 15000, 30000];
let reconnectAttempt = 0;
let reconnectTimer = null;

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    bridge.connect();
  }, delay);
}

const bridge = new NativeBridge({
  onRequest: handleRequest,
  onStatus: (status) => {
    if (status.connected) reconnectAttempt = 0;
    else scheduleReconnect();
  },
});

async function handleRequest(message, generation) {
  if (message.method === "session_hello") {
    const { sessionKey, name, agent, account } = message.params ?? {};
    if (sessionKey) await putSession(sessionKey, { name, agent, account });
    return;
  }
  if (message.method === "session_closed") {
    await closeSession(message.params?.sessionKey);
    return;
  }
  if (typeof message.id !== "string") return;

  // A reply only goes back down the port the request came in on. The host that asked is
  // gone after a reconnect, and the new one hands out its own wire ids.
  const reply = (payload) => bridge.sendFor(generation, payload);

  const handler = handlerFor(message.method);
  if (!handler) {
    reply({ id: message.id, ok: false, error: { message: `Unknown method: ${message.method}` } });
    return;
  }
  // Mark the session live before anything else: a teardown already under way reads this
  // and aborts rather than closing tabs this request is about to use.
  noteActivity(message.sessionKey);

  // Then queue behind that teardown rather than racing it. Whichever way it goes, this
  // request sees a settled world: either the teardown aborted and the group is still
  // here, or it finished and the session starts fresh.
  const session = message.sessionKey
    ? await withSessionLock(message.sessionKey, () => lookUpSession(message))
    : null;
  const ctx = {
    sessionKey: message.sessionKey,
    sessionName: message.session?.name ?? session?.name ?? "agent",
  };
  try {
    const result = await handler(ctx, message.params ?? {});
    reply({ id: message.id, ok: true, result: result ?? { text: "ok" } });
  } catch (error) {
    reply({
      id: message.id,
      ok: false,
      error: { message: String(error?.message ?? error) },
    });
  }
}

/**
 * The session's stored record, refreshed from what the host told us and taken back out
 * of "(ended)" if this session key has returned. Runs under the session's lock; it must
 * not call anything that takes that lock again.
 */
async function lookUpSession(message) {
  let session = await getSession(message.sessionKey);
  if (message.session?.name && session?.name !== message.session.name) {
    session = await putSession(message.sessionKey, message.session);
  }
  if (session?.ended && session.groupId != null) {
    await reviveSession(message.sessionKey, session.groupId, message.session?.name ?? session.name);
    session = await getSession(message.sessionKey);
  }
  return session;
}

/**
 * On session exit, tidy up only what the user cannot possibly want: a group whose tabs
 * are all blank. Anything the agent actually opened stays for the user to look at, and
 * the mapping stays with it: a host restart brings the same session key back, and it
 * should find its own tabs rather than open a second group beside them.
 *
 * Runs under the session's lock, and every await is a chance for that session to come
 * back: a host restart re-uses the session key, and closing a tab the revived session
 * has just navigated would be the worst kind of surprise. The generation check is what
 * turns "the tabs were blank a moment ago" into "they are still blank now".
 */
function closeSession(sessionKey) {
  if (!sessionKey) return Promise.resolve();
  // Read the generation now, not inside the lock: a request delivered while this is
  // still queued is exactly the case the check exists for.
  const generation = activityGeneration(sessionKey);
  return withSessionLock(sessionKey, () => closeSessionOnce(sessionKey, generation));
}

async function closeSessionOnce(sessionKey, generation) {
  const cameBack = () => activityGeneration(sessionKey) !== generation;

  const session = await getSession(sessionKey);
  if (cameBack()) return;
  if (session?.groupId == null) {
    await forgetSession(sessionKey);
    forgetActivity(sessionKey);
    return;
  }

  let tabs = [];
  try {
    tabs = await tabsInGroup(session.groupId);
  } catch {
    tabs = [];
  }
  if (cameBack()) return;

  const allBlank = tabs.length > 0 && tabs.every((tab) => BLANK_URLS.has(tab.url ?? ""));
  for (const tab of tabs) {
    await detach(tab.id);
    dropTab(tab.id);
  }
  // Detaching is harmless if the session came back (the next command re-attaches), but
  // closing tabs and forgetting the mapping are not.
  if (cameBack()) return;

  if (tabs.length === 0) {
    await forgetSession(sessionKey);
    forgetActivity(sessionKey);
    return;
  }
  if (allBlank) {
    try {
      await chrome.tabs.remove(tabs.map((tab) => tab.id));
    } catch (error) {
      console.warn("browser-bridge: could not close the session's blank tabs", error);
    }
    await forgetSession(sessionKey);
    forgetActivity(sessionKey);
    return;
  }

  try {
    await chrome.tabGroups.update(session.groupId, { title: `${session.name ?? "agent"} (ended)` });
  } catch {
    // the group may already be gone
  }
  await putSession(sessionKey, { ended: true });
}

chrome.tabs.onRemoved.addListener((tabId) => dropTab(tabId));

/**
 * A tab that changes group stops being the state we hold for it: dragged out of every
 * group, or handed to another session. Console history, network history and ref ids all
 * belong to one session looking at one page, so they go with the tab rather than
 * following it to its new owner.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.groupId === undefined) return;
  const state = peekTab(tabId);
  if (!state) return; // nothing of ours to clean up
  const owner = state.owner;
  try {
    if (owner) {
      const session = await getSession(owner);
      // Still in its owner's group (the group id can be re-reported unchanged).
      if (session?.groupId != null && session.groupId === changeInfo.groupId) return;
    } else {
      const store = await allSessions();
      const ours = Object.values(store).some(
        (session) => session.groupId != null && session.groupId === changeInfo.groupId,
      );
      if (ours) return;
    }
    await detach(tabId);
    // The destination session may have claimed the tab while we were awaiting, and its
    // fresh state is not ours to throw away. Detaching it was harmless: the next command
    // re-attaches.
    const current = peekTab(tabId);
    if (!current) return;
    if (current.owner !== owner) return;
    dropTab(tabId);
  } catch (error) {
    console.warn("browser-bridge: group change cleanup failed", error);
  }
});

chrome.tabGroups.onRemoved.addListener((group) => {
  forgetGroup(group.id).catch((error) => console.warn("browser-bridge: forgetGroup", error));
});

// Waking the worker is what reconnects the native host, so keep a slow heartbeat.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) bridge.connect();
});

chrome.runtime.onStartup.addListener(() => bridge.connect());
chrome.runtime.onInstalled.addListener(() => bridge.connect());

// The popup asks for status and can force a reconnect.
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "status") {
    allSessions()
      .then(async (store) => {
        const sessions = [];
        for (const [sessionKey, session] of Object.entries(store)) {
          const tabs = session.groupId != null ? await tabsInGroup(session.groupId).catch(() => []) : [];
          sessions.push({
            sessionKey,
            name: session.name ?? null,
            groupId: session.groupId ?? null,
            tabCount: tabs.length,
          });
        }
        respond({ native: bridge.status, sessions, version: chrome.runtime.getManifest().version });
      })
      .catch((error) => respond({ error: String(error?.message ?? error) }));
    return true;
  }
  if (message?.type === "reconnect") {
    bridge.disconnect();
    bridge.connect();
    respond({ native: bridge.status });
    return false;
  }
  return false;
});

bridge.connect();
