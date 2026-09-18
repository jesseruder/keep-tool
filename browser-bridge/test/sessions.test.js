// The session -> tab group store, against a stubbed chrome. node:test gives each file
// its own process, so the global stub here cannot leak into another test file.

import assert from "node:assert/strict";
import test from "node:test";

/** A chrome.storage.session stand-in with a real async gap on every read and write. */
function makeChrome() {
  const storage = {};
  const state = { groups: new Map(), tabs: new Map(), nextGroupId: 100, nextTabId: 1, creates: 0 };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

  return {
    state,
    api: {
      storage: {
        session: {
          async get(key) {
            await tick();
            return key in storage ? { [key]: structuredClone(storage[key]) } : {};
          },
          async set(values) {
            await tick();
            for (const [key, value] of Object.entries(values)) storage[key] = structuredClone(value);
          },
        },
      },
      tabs: {
        async query({ groupId }) {
          await tick();
          return [...state.tabs.values()].filter((tab) => tab.groupId === groupId);
        },
        async create({ windowId, url }) {
          await tick();
          const tab = { id: state.nextTabId++, windowId, url, groupId: -1, active: false };
          state.tabs.set(tab.id, tab);
          return tab;
        },
        async get(id) {
          await tick();
          if (!state.tabs.has(id)) throw new Error("no tab");
          return state.tabs.get(id);
        },
        async group({ tabIds, groupId, createProperties }) {
          await tick();
          state.creates += groupId == null ? 1 : 0;
          const id = groupId ?? state.nextGroupId++;
          state.groups.set(id, { id, title: null, windowId: createProperties?.windowId ?? 1 });
          for (const tabId of tabIds) state.tabs.get(tabId).groupId = id;
          return id;
        },
      },
      tabGroups: {
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
      },
    },
  };
}

const { api, state } = makeChrome();
globalThis.chrome = api;

const sessions = await import("../extension/lib/sessions.js");

test("concurrent writes to different sessions all survive", async () => {
  const keys = ["a", "b", "c", "d", "e", "f", "g", "h"];
  // Without a queue these read the same snapshot and the last write wins.
  await Promise.all(keys.map((key) => sessions.putSession(key, { name: `session ${key}` })));
  const store = await sessions.allSessions();
  for (const key of keys) assert.equal(store[key]?.name, `session ${key}`, key);
});

test("concurrent writes to one session merge instead of clobbering", async () => {
  await Promise.all([
    sessions.putSession("merge", { name: "merged" }),
    sessions.putSession("merge", { agent: "claude" }),
    sessions.putSession("merge", { account: "claude-tertiary" }),
  ]);
  const session = await sessions.getSession("merge");
  assert.deepEqual(session, { name: "merged", agent: "claude", account: "claude-tertiary" });
});

test("two ensureGroup calls for one session create one group", async () => {
  const before = state.creates;
  const [first, second, third] = await Promise.all([
    sessions.ensureGroup("solo", { name: "solo", createIfEmpty: true }),
    sessions.ensureGroup("solo", { name: "solo", createIfEmpty: true }),
    sessions.ensureGroup("solo", { name: "solo", createIfEmpty: true }),
  ]);
  assert.equal(state.creates - before, 1, "only one group may be created");
  assert.equal(first.groupId, second.groupId);
  assert.equal(second.groupId, third.groupId);
  assert.equal(state.groups.get(first.groupId).title, "solo");
});

test("different sessions still get different groups", async () => {
  const [one, two] = await Promise.all([
    sessions.ensureGroup("par-1", { name: "one", createIfEmpty: true }),
    sessions.ensureGroup("par-2", { name: "two", createIfEmpty: true }),
  ]);
  assert.notEqual(one.groupId, two.groupId);
});

test("without createIfEmpty there is no group and no creation", async () => {
  const before = state.creates;
  assert.equal(await sessions.ensureGroup("absent", {}), null);
  assert.equal(state.creates, before);
});

test("a group the user closed is forgotten and replaced", async () => {
  const first = await sessions.ensureGroup("closed", { name: "closed", createIfEmpty: true });
  state.groups.delete(first.groupId);
  for (const tab of state.tabs.values()) {
    if (tab.groupId === first.groupId) state.tabs.delete(tab.id);
  }
  const second = await sessions.ensureGroup("closed", { name: "closed", createIfEmpty: true });
  assert.notEqual(second.groupId, first.groupId);
});

test("an ended session that still has tabs gets its group back", async () => {
  const group = await sessions.ensureGroup("ended", { name: "worker #1", createIfEmpty: true });
  // What closeSession does when the tabs are not all blank.
  await sessions.putSession("ended", { ended: true });
  await chrome.tabGroups.update(group.groupId, { title: "worker #1 (ended)" });

  const again = await sessions.ensureGroup("ended", { name: "worker #1", createIfEmpty: true });
  assert.equal(again.groupId, group.groupId, "the same group, not a second one");
  assert.equal(state.groups.get(group.groupId).title, "worker #1");
  assert.equal((await sessions.getSession("ended")).ended, false);
});

test("requireTab enforces the session's group with the exact contract errors", async () => {
  const group = await sessions.ensureGroup("scoped", { name: "scoped", createIfEmpty: true });
  const mine = [...state.tabs.values()].find((tab) => tab.groupId === group.groupId);
  const tab = await sessions.requireTab("scoped", mine.id);
  assert.equal(tab.id, mine.id);

  await assert.rejects(() => sessions.requireTab("scoped", 9999), /^Error: No tab with id: 9999$/);
  await assert.rejects(() => sessions.requireTab("scoped", "nope"), /^Error: No tab with id: nope$/);

  const other = await sessions.ensureGroup("other", { name: "other", createIfEmpty: true });
  const theirs = [...state.tabs.values()].find((tab) => tab.groupId === other.groupId);
  await assert.rejects(
    () => sessions.requireTab("scoped", theirs.id),
    new RegExp(`^Error: Tab ${theirs.id} is not in the same group$`),
  );
});

test("forgetGroup drops the mapping for every session on that group", async () => {
  const group = await sessions.ensureGroup("forgettable", { name: "f", createIfEmpty: true });
  await sessions.forgetGroup(group.groupId);
  assert.equal((await sessions.getSession("forgettable")).groupId, undefined);
});
