// browser_status: what the extension knows about itself and every session using it.

import { attachedTabs } from "../lib/cdp.js";
import { allSessions, tabsInGroup } from "../lib/sessions.js";

export async function browser_status(ctx) {
  const manifest = chrome.runtime.getManifest();
  const store = await allSessions();

  const sessions = [];
  for (const [sessionKey, session] of Object.entries(store)) {
    let tabs = [];
    if (session.groupId != null) {
      try {
        tabs = await tabsInGroup(session.groupId);
      } catch {
        tabs = [];
      }
    }
    sessions.push({
      sessionKey,
      mine: sessionKey === ctx.sessionKey,
      name: session.name ?? null,
      agent: session.agent ?? null,
      account: session.account ?? null,
      groupId: session.groupId ?? null,
      windowId: session.windowId ?? null,
      tabs: tabs.map((tab) => ({ id: tab.id, url: tab.url, title: tab.title })),
    });
  }

  const status = {
    extension: {
      id: chrome.runtime.id,
      version: manifest.version,
      name: manifest.name,
    },
    debuggerAttachedTabs: attachedTabs(),
    sessions,
  };
  return { text: JSON.stringify(status, null, 2), status };
}
