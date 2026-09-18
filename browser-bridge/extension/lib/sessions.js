// sessionKey -> tab group, persisted in chrome.storage.session so the mapping survives
// a service worker restart (which happens constantly) but not a browser restart (where
// the tabs are gone anyway).

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

export async function allSessions() {
  return readStore();
}

export async function getSession(sessionKey) {
  const store = await readStore();
  return store[sessionKey] ?? null;
}

export async function putSession(sessionKey, session) {
  const store = await readStore();
  store[sessionKey] = { ...store[sessionKey], ...session };
  await writeStore(store);
  return store[sessionKey];
}

export async function forgetSession(sessionKey) {
  const store = await readStore();
  const session = store[sessionKey];
  delete store[sessionKey];
  await writeStore(store);
  return session ?? null;
}

export async function clearGroup(sessionKey) {
  const store = await readStore();
  if (store[sessionKey]?.groupId != null) {
    delete store[sessionKey].groupId;
    await writeStore(store);
  }
}

export async function forgetGroup(groupId) {
  const store = await readStore();
  let changed = false;
  for (const [key, session] of Object.entries(store)) {
    if (session.groupId === groupId) {
      delete store[key].groupId;
      changed = true;
    }
  }
  if (changed) await writeStore(store);
}

async function nextColor() {
  const stored = await chrome.storage.session.get(COLOR_KEY);
  const index = stored[COLOR_KEY] ?? 0;
  await chrome.storage.session.set({ [COLOR_KEY]: (index + 1) % GROUP_COLORS.length });
  return GROUP_COLORS[index % GROUP_COLORS.length];
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

/**
 * The session's tab group, creating it only when asked. Returns null when there is no
 * live group and createIfEmpty was not set.
 */
export async function ensureGroup(sessionKey, { name, createIfEmpty = false, newWindow = false } = {}) {
  const session = (await getSession(sessionKey)) ?? {};
  if (await groupIsAlive(session.groupId)) {
    const tabs = await tabsInGroup(session.groupId);
    if (tabs.length > 0) {
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
  await putSession(sessionKey, { groupId, windowId, name, color });
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
  return tab;
}
