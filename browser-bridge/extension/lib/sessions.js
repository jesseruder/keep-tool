// sessionKey -> tab group, persisted in chrome.storage.session so the mapping survives
// a service worker restart (which happens constantly) but not a browser restart (where
// the tabs are gone anyway).

import { claimTab } from "./cdp.js";

const STORE_KEY = "bridge.sessions";
const COLOR_KEY = "bridge.colorIndex";

const GROUP_COLORS = ["blue", "cyan", "green", "yellow", "orange", "pink", "purple", "red", "grey"];

async function readStore() {
  const stored = await chrome.storage.session.get(STORE_KEY);
  return stored[STORE_KEY] ?? {};
}

async function writeStore(store) {
  await chrome.storage.session.set({ [STORE_KEY]: store });
}

/**
 * Every mutation is a read-modify-write of one storage key, and several requests are in
 * flight at once, so they queue behind each other. Without this, two sessions saying
 * hello together would each write back a store that predates the other.
 */
let mutationQueue = Promise.resolve();

function mutate(fn) {
  const run = mutationQueue.then(async () => {
    const store = await readStore();
    const result = await fn(store);
    await writeStore(store);
    return result;
  });
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function allSessions() {
  return readStore();
}

export async function getSession(sessionKey) {
  const store = await readStore();
  return store[sessionKey] ?? null;
}

export async function putSession(sessionKey, session) {
  return mutate((store) => {
    store[sessionKey] = { ...store[sessionKey], ...session };
    return store[sessionKey];
  });
}

export async function forgetSession(sessionKey) {
  return mutate((store) => {
    const session = store[sessionKey] ?? null;
    delete store[sessionKey];
    return session;
  });
}

export async function clearGroup(sessionKey) {
  return mutate((store) => {
    if (store[sessionKey]?.groupId != null) delete store[sessionKey].groupId;
  });
}

export async function forgetGroup(groupId) {
  return mutate((store) => {
    for (const session of Object.values(store)) {
      if (session.groupId === groupId) delete session.groupId;
    }
  });
}

async function nextColor() {
  return mutate(async () => {
    const stored = await chrome.storage.session.get(COLOR_KEY);
    const index = stored[COLOR_KEY] ?? 0;
    await chrome.storage.session.set({ [COLOR_KEY]: (index + 1) % GROUP_COLORS.length });
    return GROUP_COLORS[index % GROUP_COLORS.length];
  });
}

async function groupIsAlive(groupId) {
  if (groupId == null) return false;
  try {
    await chrome.tabGroups.get(groupId);
    return true;
  } catch {
    return false; // the user closed it by hand
  }
}

export async function tabsInGroup(groupId) {
  if (groupId == null) return [];
  const tabs = await chrome.tabs.query({ groupId });
  return tabs.map((tab) => ({
    id: tab.id,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    windowId: tab.windowId,
  }));
}

async function pickWindowId(newWindow) {
  if (newWindow) {
    // Never focused: stealing focus from the terminal is the one thing users hate.
    const created = await chrome.windows.create({ focused: false, url: "about:blank" });
    return { windowId: created.id, seedTabId: created.tabs?.[0]?.id ?? null };
  }
  try {
    const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (window && window.id != null) return { windowId: window.id, seedTabId: null };
  } catch {
    // no normal window open
  }
  const created = await chrome.windows.create({ focused: false, url: "about:blank" });
  return { windowId: created.id, seedTabId: created.tabs?.[0]?.id ?? null };
}

/** Give a live group its session's new name. */
export async function retitleGroup(groupId, name) {
  try {
    await chrome.tabGroups.update(groupId, { title: name });
  } catch {
    // the group may have gone in the meantime
  }
}

/** Undo what closeSession did to a group whose owner came back. */
export async function reviveSession(sessionKey, groupId, name) {
  await putSession(sessionKey, { ended: false });
  try {
    await chrome.tabGroups.update(groupId, { title: name ?? "agent" });
  } catch {
    // the group may have gone in the meantime; the caller re-checks
  }
}

// One piece of lifecycle work at a time per session: creating the group, reviving it
// and tearing it down all race each other otherwise.
const sessionWork = new Map();

/** Run `fn` after whatever else is already queued for this session. */
export function withSessionLock(sessionKey, fn) {
  const previous = sessionWork.get(sessionKey) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  sessionWork.set(sessionKey, run);
  run.catch(() => {}).then(() => {
    if (sessionWork.get(sessionKey) === run) sessionWork.delete(sessionKey);
  });
  return run;
}

// Bumped by every request that arrives for a session. Teardown reads it before and
// after its awaits: if it moved, the session came back and its tabs are in use again.
const activity = new Map();

export function noteActivity(sessionKey) {
  if (!sessionKey) return 0;
  const next = (activity.get(sessionKey) ?? 0) + 1;
  activity.set(sessionKey, next);
  return next;
}

export function activityGeneration(sessionKey) {
  return activity.get(sessionKey) ?? 0;
}

export function forgetActivity(sessionKey) {
  activity.delete(sessionKey);
}

/**
 * The session's tab group, creating it only when asked. Returns null when there is no
 * live group and createIfEmpty was not set.
 */
export function ensureGroup(sessionKey, options = {}) {
  return withSessionLock(sessionKey, () => ensureGroupOnce(sessionKey, options));
}

async function ensureGroupOnce(sessionKey, { name, createIfEmpty = false, newWindow = false } = {}) {
  const session = (await getSession(sessionKey)) ?? {};
  if (await groupIsAlive(session.groupId)) {
    const tabs = await tabsInGroup(session.groupId);
    if (tabs.length > 0) {
      // The session ended with tabs still open and has now come back (a host restart
      // reuses the same session key): take the group back and drop the "(ended)" title.
      if (session.ended) await reviveSession(sessionKey, session.groupId, name ?? session.name);
      return { groupId: session.groupId, windowId: tabs[0].windowId, name: session.name ?? name, tabs };
    }
    // An empty group is one Chrome is about to drop; treat it as gone.
  }
  if (!createIfEmpty) {
    if (session.groupId != null) await clearGroup(sessionKey);
    return null;
  }

  const { windowId, seedTabId } = await pickWindowId(newWindow);
  const tabId =
    seedTabId ?? (await chrome.tabs.create({ windowId, url: "about:blank", active: false })).id;
  const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
  const color = await nextColor();
  try {
    await chrome.tabGroups.update(groupId, { title: name ?? "agent", color, collapsed: false });
  } catch (error) {
    console.warn("browser-bridge: could not title the group", error);
  }
  await putSession(sessionKey, { groupId, windowId, name, color, ended: false });
  return { groupId, windowId, name, tabs: await tabsInGroup(groupId) };
}

/**
 * Tab-scope check for every page tool. The two error strings are part of the contract
 * with the model, so they are exact.
 */
export async function requireTab(sessionKey, tabId) {
  const numeric = Number(tabId);
  if (!Number.isInteger(numeric)) throw new Error(`No tab with id: ${tabId}`);
  let tab;
  try {
    tab = await chrome.tabs.get(numeric);
  } catch {
    throw new Error(`No tab with id: ${numeric}`);
  }
  const session = await getSession(sessionKey);
  if (!session || session.groupId == null || tab.groupId !== session.groupId) {
    throw new Error(`Tab ${numeric} is not in the same group`);
  }
  // Every tab-scoped tool comes through here, so this is where the tab's debugger state
  // gets its owner and the group it was in at the time.
  claimTab(numeric, sessionKey, tab.groupId);
  return tab;
}
