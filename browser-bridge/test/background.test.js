// The service worker's own behaviour: request dispatch, session teardown and the tab
// bookkeeping, against a stubbed chrome. node:test gives this file its own process.

import assert from "node:assert/strict";
import test from "node:test";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

const state = {
  storage: {},
  tabs: new Map(),
  groups: new Map(),
  nextTabId: 1,
  nextGroupId: 100,
  detached: [],
  ports: [],
  listeners: { tabsUpdated: [], tabsRemoved: [], groupsRemoved: [], alarm: [] },
};

function makePort() {
  const port = {
    sent: [],
    messageListeners: [],
    disconnectListeners: [],
    onMessage: { addListener: (fn) => port.messageListeners.push(fn) },
    onDisconnect: { addListener: (fn) => port.disconnectListeners.push(fn) },
    postMessage: (message) => port.sent.push(message),
    disconnect: () => {
      for (const fn of port.disconnectListeners) fn();
    },
  };
  return port;
}

globalThis.chrome = {
  runtime: {
    id: "test-extension",
    lastError: null,
    getManifest: () => ({ version: "0.1.0", name: "Browser Bridge" }),
    connectNative: () => {
      const port = makePort();
      state.ports.push(port);
      return port;
    },
    onStartup: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    onMessage: { addListener: () => {} },
  },
  alarms: {
    create: () => {},
    onAlarm: { addListener: (fn) => state.listeners.alarm.push(fn) },
  },
  storage: {
    session: {
      async get(key) {
        await tick();
        return key in state.storage ? { [key]: structuredClone(state.storage[key]) } : {};
      },
      async set(values) {
        await tick();
        for (const [key, value] of Object.entries(values)) state.storage[key] = structuredClone(value);
      },
    },
  },
  tabs: {
    onUpdated: { addListener: (fn) => state.listeners.tabsUpdated.push(fn) },
    onRemoved: { addListener: (fn) => state.listeners.tabsRemoved.push(fn) },
    async query({ groupId }) {
      await tick();
      return [...state.tabs.values()].filter((tab) => tab.groupId === groupId);
    },
    async get(id) {
      await tick();
      if (!state.tabs.has(id)) throw new Error("no tab");
      return state.tabs.get(id);
    },
    async create({ windowId, url }) {
      await tick();
      const tab = { id: state.nextTabId++, windowId, url, groupId: -1, active: false, title: "" };
      state.tabs.set(tab.id, tab);
      return tab;
    },
    async update(id, changes) {
      await tick();
      Object.assign(state.tabs.get(id), changes);
      return state.tabs.get(id);
    },
    async remove(ids) {
      await tick();
      for (const id of Array.isArray(ids) ? ids : [ids]) state.tabs.delete(id);
    },
    async group({ tabIds, groupId, createProperties }) {
      await tick();
      const id = groupId ?? state.nextGroupId++;
      state.groups.set(id, { id, title: null, windowId: createProperties?.windowId ?? 1 });
      for (const tabId of tabIds) state.tabs.get(tabId).groupId = id;
      return id;
    },
  },
  tabGroups: {
    onRemoved: { addListener: (fn) => state.listeners.groupsRemoved.push(fn) },
    async get(id) {
      await tick();
      if (!state.groups.has(id)) throw new Error("no group");
      return state.groups.get(id);
    },
    async update(id, changes) {
      await tick();
      if (!state.groups.has(id)) throw new Error("no group");
      Object.assign(state.groups.get(id), changes);
      return state.groups.get(id);
    },
  },
  windows: {
    async getLastFocused() {
      await tick();
      return { id: 1 };
    },
    async create() {
      await tick();
      return { id: 2, tabs: [] };
    },
    async update(id, changes) {
      await tick();
      return { id, ...changes };
    },
  },
  debugger: {
    onEvent: { addListener: () => {} },
    onDetach: { addListener: () => {} },
    async attach() {
      await tick();
    },
    async detach({ tabId }) {
      await tick();
      state.detached.push(tabId);
    },
    async sendCommand() {
      await tick();
      return {};
    },
  },
};

// Importing the worker entry starts it: it connects, registers its listeners and is
// then driven the way the host drives it.
await import("../extension/background.js");
const cdp = await import("../extension/lib/cdp.js");
const sessions = await import("../extension/lib/sessions.js");

const port = () => state.ports.at(-1);

function deliver(message) {
  for (const listener of port().messageListeners) listener(message);
}

async function waitFor(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await tick();
  }
}

function replyFor(id) {
  return port().sent.find((message) => message.id === id) ?? null;
}

async function makeSession(sessionKey, name) {
  const group = await sessions.ensureGroup(sessionKey, { name, createIfEmpty: true });
  const tab = [...state.tabs.values()].find((candidate) => candidate.groupId === group.groupId);
  return { group, tab };
}

function fireGroupChange(tabId, groupId) {
  state.tabs.get(tabId).groupId = groupId;
  for (const listener of state.listeners.tabsUpdated) listener(tabId, { groupId }, state.tabs.get(tabId));
}

test("the worker announces itself on the native port", () => {
  assert.deepEqual(port().sent[0], { event: "ready", version: "0.1.0" });
});

test("a request is dispatched and answered on the port it arrived on", async () => {
  deliver({
    id: "w1_c1",
    sessionKey: "dispatch",
    session: { name: "dispatch #1" },
    method: "tabs_context_mcp",
    params: { createIfEmpty: true },
  });
  const reply = await waitFor(() => replyFor("w1_c1"), "the tabs_context_mcp reply");
  assert.equal(reply.ok, true);
  const context = JSON.parse(reply.result.text);
  assert.equal(state.groups.get(context.groupId).title, "dispatch #1");
});

test("an unknown method is refused", async () => {
  deliver({ id: "w1_c2", sessionKey: "dispatch", method: "not_a_tool", params: {} });
  const reply = await waitFor(() => replyFor("w1_c2"), "the refusal");
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /Unknown method: not_a_tool/);
});

test("a tab handed to another session loses its previous owner's state", async () => {
  const a = await makeSession("owner-a", "A");
  const b = await makeSession("owner-b", "B");

  // Session A touches the tab, which is what attaches the debugger and claims its
  // buffers and refs.
  await cdp.attach(a.tab.id);
  await sessions.requireTab("owner-a", a.tab.id);
  const beforeState = cdp.peekTab(a.tab.id);
  beforeState.console.push({ level: "log", text: "secret from A", at: Date.now() });
  beforeState.refs.refFor(42);
  assert.equal(beforeState.owner, "owner-a");

  // The user drags it straight into B's group: it never leaves every group, so the
  // "is this group ours?" test alone would have kept A's console history for B.
  fireGroupChange(a.tab.id, b.group.groupId);

  await waitFor(() => cdp.peekTab(a.tab.id) === null, "A's tab state to be dropped");
  assert.ok(state.detached.includes(a.tab.id), "and its debugger detached");
});

test("a tab that stays in its own group keeps its state", async () => {
  const session = await makeSession("owner-c", "C");
  await sessions.requireTab("owner-c", session.tab.id);
  cdp.peekTab(session.tab.id).console.push({ level: "log", text: "kept", at: Date.now() });

  fireGroupChange(session.tab.id, session.group.groupId);
  await tick();
  await tick();

  assert.equal(cdp.peekTab(session.tab.id)?.console.length, 1);
});

test("a tab dragged out of every group is dropped", async () => {
  const session = await makeSession("owner-d", "D");
  await sessions.requireTab("owner-d", session.tab.id);
  fireGroupChange(session.tab.id, -1);
  await waitFor(() => cdp.peekTab(session.tab.id) === null, "the loose tab's state to be dropped");
});

test("claiming a tab for a new owner clears what the last owner saw", async () => {
  const session = await makeSession("owner-e", "E");
  await sessions.requireTab("owner-e", session.tab.id);
  const held = cdp.peekTab(session.tab.id);
  held.console.push({ level: "log", text: "E's", at: Date.now() });

  cdp.claimTab(session.tab.id, "owner-f", session.group.groupId);
  assert.equal(held.console.length, 0, "console history does not follow the tab to a new session");
  assert.equal(held.owner, "owner-f");
});

test("a session that ends with only blank tabs has them closed", async () => {
  const session = await makeSession("blank-session", "blank");
  assert.equal(session.tab.url, "about:blank");

  deliver({ method: "session_closed", params: { sessionKey: "blank-session" } });
  await waitFor(() => !state.tabs.has(session.tab.id), "the blank tab to be closed");
  await waitFor(async () => (await sessions.getSession("blank-session")) === null, "the mapping to go");
});

test("a session that ends with real tabs keeps them and its group", async () => {
  const session = await makeSession("real-session", "real");
  state.tabs.get(session.tab.id).url = "https://example.com/report";

  deliver({ method: "session_closed", params: { sessionKey: "real-session" } });
  await waitFor(
    () => state.groups.get(session.group.groupId).title === "real (ended)",
    "the group to be marked ended",
  );
  assert.ok(state.tabs.has(session.tab.id), "the user's tab stays open");
  await waitFor(
    async () => (await sessions.getSession("real-session"))?.ended === true,
    "the session to be marked ended",
  );
});

test("a request that arrives during teardown aborts it", async () => {
  const session = await makeSession("racing", "racing");
  assert.equal(session.tab.url, "about:blank");

  // The host died and came straight back: session_closed for the old connection is
  // still in flight when the same session key starts working again.
  deliver({ method: "session_closed", params: { sessionKey: "racing" } });
  deliver({
    id: "w2_c1",
    sessionKey: "racing",
    session: { name: "racing" },
    method: "tabs_context_mcp",
    params: { createIfEmpty: true },
  });

  const reply = await waitFor(() => replyFor("w2_c1"), "the revived session's reply");
  assert.equal(reply.ok, true);
  const context = JSON.parse(reply.result.text);
  assert.equal(context.groupId, session.group.groupId, "the same group, not a fresh one");
  assert.ok(state.tabs.has(session.tab.id), "the tab the revived session is using must survive");
  assert.notEqual(await sessions.getSession("racing"), null, "and its mapping must survive");

  // Let any queued teardown finish, then check again: the abort has to be final.
  await tick();
  await tick();
  await tick();
  assert.ok(state.tabs.has(session.tab.id));
  assert.notEqual(await sessions.getSession("racing"), null);
});

test("an ended session that comes back takes its group out of (ended)", async () => {
  const session = await makeSession("returning", "returning");
  state.tabs.get(session.tab.id).url = "https://example.com/a";
  deliver({ method: "session_closed", params: { sessionKey: "returning" } });
  await waitFor(
    () => state.groups.get(session.group.groupId).title === "returning (ended)",
    "the ended title",
  );

  deliver({
    id: "w3_c1",
    sessionKey: "returning",
    session: { name: "returning" },
    method: "tabs_context_mcp",
    params: {},
  });
  const reply = await waitFor(() => replyFor("w3_c1"), "the returning session's reply");
  assert.equal(reply.ok, true);
  assert.equal(state.groups.get(session.group.groupId).title, "returning");
  assert.equal((await sessions.getSession("returning")).ended, false);
});
