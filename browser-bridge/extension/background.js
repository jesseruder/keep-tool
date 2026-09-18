// Service worker entry: hold the native port, dispatch requests, and keep the
// session -> tab group bookkeeping straight.

import { NativeBridge } from "./lib/native.js";
import { dropTab, detach, installListeners } from "./lib/cdp.js";
import {
  allSessions,
  forgetGroup,
  forgetSession,
  getSession,
  putSession,
  tabsInGroup,
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

async function handleRequest(message) {
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

  const handler = handlerFor(message.method);
  if (!handler) {
    bridge.send({ id: message.id, ok: false, error: { message: `Unknown method: ${message.method}` } });
    return;
  }
  const session = message.sessionKey ? await getSession(message.sessionKey) : null;
  const ctx = {
    sessionKey: message.sessionKey,
    sessionName: session?.name ?? "agent",
  };
  try {
    const result = await handler(ctx, message.params ?? {});
    bridge.send({ id: message.id, ok: true, result: result ?? { text: "ok" } });
  } catch (error) {
    bridge.send({
      id: message.id,
      ok: false,
      error: { message: String(error?.message ?? error) },
    });
  }
}

/**
 * On session exit, tidy up only what the user cannot possibly want: a group whose tabs
 * are all blank. Anything the agent actually opened stays for the user to look at.
 */
async function closeSession(sessionKey) {
  if (!sessionKey) return;
  const session = await getSession(sessionKey);
  if (session?.groupId != null) {
    let tabs = [];
    try {
      tabs = await tabsInGroup(session.groupId);
    } catch {
      tabs = [];
    }
    const allBlank = tabs.length > 0 && tabs.every((tab) => BLANK_URLS.has(tab.url ?? ""));
    for (const tab of tabs) {
      await detach(tab.id);
      dropTab(tab.id);
    }
    if (allBlank) {
      try {
        await chrome.tabs.remove(tabs.map((tab) => tab.id));
      } catch (error) {
        console.warn("browser-bridge: could not close the session's blank tabs", error);
      }
    } else if (tabs.length > 0) {
      try {
        await chrome.tabGroups.update(session.groupId, { title: `${session.name ?? "agent"} (ended)` });
      } catch {
        // the group may already be gone
      }
    }
  }
  await forgetSession(sessionKey);
}

chrome.tabs.onRemoved.addListener((tabId) => dropTab(tabId));

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
