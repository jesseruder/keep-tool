// Cross-origin iframes: the pure splice, and the whole read_page / find / ref path
// against a stubbed CDP that speaks one tree per session.

import assert from "node:assert/strict";
import test from "node:test";

import { RefTable } from "../extension/lib/ax.js";
import { iframeNodes, namespaceNodes, spliceFrameTrees } from "../extension/lib/frames.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

// --- trees ---------------------------------------------------------------

function node(nodeId, role, options = {}) {
  const { name, childIds = [], backendDOMNodeId, ignored = false, focusable = true } = options;
  const axNode = { nodeId, role: { type: "role", value: role }, childIds, ignored };
  if (name !== undefined) axNode.name = { type: "computedString", value: name };
  if (backendDOMNodeId !== undefined) axNode.backendDOMNodeId = backendDOMNodeId;
  if (focusable) {
    axNode.properties = [{ name: "focusable", value: { type: "boolean", value: true } }];
  }
  return axNode;
}

/** The page: a heading, a same-process button, and an iframe element (backend 20). */
const MAIN_TREE = [
  node("1", "RootWebArea", { name: "Checkout", childIds: ["2", "3", "20"], backendDOMNodeId: 1 }),
  node("2", "heading", { name: "Checkout", backendDOMNodeId: 2, focusable: false }),
  node("3", "button", { name: "Use another card", backendDOMNodeId: 3 }),
  node("20", "Iframe", { name: "Payment form", backendDOMNodeId: 20 }),
];

/**
 * The payment frame's own tree, numbered from 1 exactly like the main one, with an iframe
 * element of its own (backend 4) for the nested-frame case.
 */
const FRAME_TREE = [
  node("1", "RootWebArea", { name: "Pay", childIds: ["2", "3", "4"], backendDOMNodeId: 1 }),
  node("2", "textbox", { name: "Card number", backendDOMNodeId: 2 }),
  node("3", "button", { name: "Pay now", backendDOMNodeId: 3 }),
  node("4", "Iframe", { name: "Verify card", backendDOMNodeId: 4 }),
];

/** A frame nested inside the payment frame (a 3-D secure challenge, say). */
const NESTED_TREE = [
  node("1", "RootWebArea", { name: "Verify", childIds: ["2"], backendDOMNodeId: 1 }),
  node("2", "button", { name: "Approve", backendDOMNodeId: 2 }),
];

// --- the pure splice -----------------------------------------------------

test("namespacing keeps two trees that both number from 1 apart", () => {
  const spliced = namespaceNodes(FRAME_TREE, "S1");
  assert.equal(spliced[0].nodeId, "S1::1");
  assert.deepEqual(spliced[0].childIds, ["S1::2", "S1::3", "S1::4"]);
  assert.equal(spliced[0].frameSessionId, "S1");
  // The source tree is untouched.
  assert.equal(FRAME_TREE[0].nodeId, "1");
  assert.equal(FRAME_TREE[0].frameSessionId, undefined);
});

test("a frame tree is spliced under the iframe element that hosts it", () => {
  const owners = new Map([["frame-1", { sessionId: null, backendNodeId: 20 }]]);
  const { nodes, placed, unplaced } = spliceFrameTrees(
    MAIN_TREE,
    [{ sessionId: "S1", frameId: "frame-1", nodes: FRAME_TREE }],
    owners,
  );
  assert.deepEqual(placed, ["frame-1"]);
  assert.deepEqual(unplaced, []);
  const host = nodes.find((item) => item.backendDOMNodeId === 20 && !item.frameSessionId);
  assert.deepEqual(host.childIds, ["S1::1"]);
  // Right after the host, so refs stay in document order.
  assert.equal(nodes[nodes.indexOf(host) + 1].nodeId, "S1::1");
  // The main tree's own nodes are not rewritten.
  assert.equal(MAIN_TREE[3].childIds.length, 0);
});

test("an iframe inside an iframe lands under its own parent", () => {
  const owners = new Map([
    ["frame-1", { sessionId: null, backendNodeId: 20 }],
    // The nested frame is hosted by an element inside the payment frame.
    ["frame-2", { sessionId: "S1", backendNodeId: 4 }],
  ]);
  const { nodes, placed } = spliceFrameTrees(
    MAIN_TREE,
    [
      // Deliberately in the order that needs two passes: the child first.
      { sessionId: "S2", frameId: "frame-2", nodes: NESTED_TREE },
      { sessionId: "S1", frameId: "frame-1", nodes: FRAME_TREE },
    ],
    owners,
  );
  assert.deepEqual(placed.sort(), ["frame-1", "frame-2"]);
  const inner = nodes.find((item) => item.nodeId === "S1::4");
  assert.deepEqual(inner.childIds, ["S2::1"]);
});

test("a frame whose host element cannot be found is reported, not dropped silently", () => {
  const { nodes, placed, unplaced } = spliceFrameTrees(
    MAIN_TREE,
    [{ sessionId: "S1", frameId: "frame-1", nodes: FRAME_TREE }],
    new Map(),
  );
  assert.deepEqual(placed, []);
  assert.deepEqual(unplaced, ["frame-1"]);
  assert.equal(nodes.length, MAIN_TREE.length);
});

test("iframeNodes finds the iframe elements worth asking about", () => {
  assert.deepEqual(
    iframeNodes(MAIN_TREE).map((item) => item.backendDOMNodeId),
    [20],
  );
  assert.deepEqual(
    iframeNodes(FRAME_TREE).map((item) => item.backendDOMNodeId),
    [4],
  );
  assert.deepEqual(iframeNodes(NESTED_TREE), []);
});

// --- the stubbed browser -------------------------------------------------

const state = {
  storage: {},
  tabs: new Map(),
  groups: new Map(),
  events: [],
  commands: [],
  describeFails: false,
  quads: new Map(), // "sessionId|backendNodeId" -> quad
};

function eventListener() {
  return state.events[0];
}

globalThis.chrome = {
  runtime: { id: "test-extension", getManifest: () => ({ version: "0.1.0" }) },
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
    async get(id) {
      await tick();
      if (!state.tabs.has(id)) throw new Error("no tab");
      return state.tabs.get(id);
    },
    async query({ groupId }) {
      await tick();
      return [...state.tabs.values()].filter((tab) => tab.groupId === groupId);
    },
    async update(id, changes) {
      await tick();
      Object.assign(state.tabs.get(id), changes);
      return state.tabs.get(id);
    },
    onUpdated: { addListener: () => {}, removeListener: () => {} },
    onRemoved: { addListener: () => {} },
  },
  tabGroups: {
    async get(id) {
      await tick();
      if (!state.groups.has(id)) throw new Error("no group");
      return state.groups.get(id);
    },
    async update() {
      await tick();
    },
    onRemoved: { addListener: () => {} },
  },
  windows: {
    async getLastFocused() {
      return { id: 1 };
    },
  },
  debugger: {
    onEvent: { addListener: (fn) => state.events.push(fn) },
    onDetach: { addListener: () => {} },
    async attach() {
      await tick();
    },
    async detach() {
      await tick();
    },
    async sendCommand(target, method, params) {
      await tick();
      state.commands.push({ target, method, params });
      const sessionId = target.sessionId ?? null;

      if (method === "Accessibility.getFullAXTree") {
        if (sessionId === null) return { nodes: MAIN_TREE };
        if (sessionId === "S1") return { nodes: FRAME_TREE };
        if (sessionId === "S2") return { nodes: NESTED_TREE };
        throw new Error(`no tree for session ${sessionId}`);
      }
      if (method === "DOM.describeNode") {
        if (state.describeFails) return { node: {} };
        // The iframe element in the main tree hosts frame-1; the one in the payment
        // frame hosts frame-2.
        if (sessionId === null && params.backendNodeId === 20) {
          return { node: { nodeName: "IFRAME", frameId: "frame-1" } };
        }
        if (sessionId === "S1" && params.backendNodeId === 4) {
          return { node: { nodeName: "IFRAME", frameId: "frame-2" } };
        }
        return { node: { nodeName: "DIV" } };
      }
      if (method === "DOM.getContentQuads") {
        const quad = state.quads.get(`${sessionId ?? ""}|${params.backendNodeId}`);
        return quad ? { quads: [quad] } : { quads: [] };
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: `obj-${sessionId ?? "main"}-${params.backendNodeId}` } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: { ok: true, kind: "input", value: "4242" } } };
      }
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              width: 1000,
              height: 600,
              dpr: 1,
              scrollX: 0,
              scrollY: 0,
              url: "https://shop.example/checkout",
              title: "Checkout",
            },
          },
        };
      }
      return {};
    },
  },
};

const cdp = await import("../extension/lib/cdp.js");
const sessions = await import("../extension/lib/sessions.js");
const { find, read_page } = await import("../extension/tools/read.js");
const { computer } = await import("../extension/tools/computer.js");
const { form_input } = await import("../extension/tools/form.js");
const { file_upload } = await import("../extension/tools/upload.js");

cdp.installListeners();

let nextTabId = 1;
let nextGroupId = 100;

/** A fresh tab in its own session's group, with no debugger state left over. */
async function makeTab({ sessionKey }) {
  const id = nextTabId++;
  const groupId = nextGroupId++;
  state.tabs.set(id, {
    id,
    groupId,
    url: "https://shop.example/checkout",
    title: "Checkout",
    active: true,
    windowId: 1,
  });
  state.groups.set(groupId, { id: groupId, title: sessionKey });
  await sessions.putSession(sessionKey, { name: sessionKey, groupId, windowId: 1 });
  state.commands.length = 0;
  state.describeFails = false;
  state.quads.clear();
  return state.tabs.get(id);
}

function attachFrame(tabId, { sessionId, frameId, type = "iframe" }) {
  eventListener()({ tabId }, "Target.attachedToTarget", {
    sessionId,
    targetInfo: { targetId: frameId, type, url: "https://pay.example/form" },
    waitingForDebugger: false,
  });
}

function detachFrame(tabId, sessionId) {
  eventListener()({ tabId }, "Target.detachedFromTarget", { sessionId, targetId: "frame-1" });
}

const ctx = (sessionKey) => ({ sessionKey, sessionName: sessionKey });

// --- a page with no out-of-process iframes -------------------------------

test("a page with no cross-origin iframes reads exactly as it always did", async () => {
  const tab = await makeTab({ sessionKey: "plain" });
  const result = await read_page(ctx("plain"), { tabId: tab.id });

  assert.match(result.text, /button "Use another card"/);
  assert.doesNotMatch(result.text, /Pay now/);
  assert.doesNotMatch(result.text, /cross-origin/);
  assert.equal(
    state.commands.filter((call) => call.method === "Accessibility.getFullAXTree").length,
    1,
    "one tree, no extra round trips",
  );
  assert.equal(
    state.commands.some((call) => call.method === "DOM.describeNode"),
    false,
    "and nothing is described when there is no frame session",
  );
});

test("attaching turns on flattened auto-attach", async () => {
  const tab = await makeTab({ sessionKey: "autoattach" });
  await cdp.attach(tab.id);
  const call = state.commands.find((entry) => entry.method === "Target.setAutoAttach");
  assert.deepEqual(call.params, { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  assert.equal(call.target.sessionId, undefined, "on the tab's own session");
});

test("a worker target is ignored: only iframes have a tree to splice", async () => {
  const tab = await makeTab({ sessionKey: "worker" });
  attachFrame(tab.id, { sessionId: "W1", frameId: "worker-1", type: "worker" });
  assert.deepEqual(cdp.frameSessions(tab.id), []);
  const result = await read_page(ctx("worker"), { tabId: tab.id });
  assert.doesNotMatch(result.text, /cross-origin/);
});

// --- a page with one -----------------------------------------------------

test("read_page includes the cross-origin frame's elements and says so", async () => {
  const tab = await makeTab({ sessionKey: "framed" });
  attachFrame(tab.id, { sessionId: "S1", frameId: "frame-1" });

  const result = await read_page(ctx("framed"), { tabId: tab.id });
  assert.match(result.text, /Iframe "Payment form"/);
  assert.match(result.text, /textbox "Card number"/);
  assert.match(result.text, /button "Pay now"/);
  assert.match(result.text, /Includes the content of 1 cross-origin iframe\(s\)/);

  // The frame's own session answered for it, and the child domains were enabled once.
  const trees = state.commands.filter((call) => call.method === "Accessibility.getFullAXTree");
  assert.deepEqual(
    trees.map((call) => call.target.sessionId ?? null),
    [null, "S1"],
  );
  const enables = state.commands.filter(
    (call) => call.target.sessionId === "S1" && call.method.endsWith(".enable"),
  );
  assert.deepEqual(
    enables.map((call) => call.method),
    ["DOM.enable", "Accessibility.enable"],
  );

  // The frame's content is nested under the iframe element, not dumped at the top level.
  const lines = result.text.split("\n");
  const iframeLine = lines.findIndex((line) => line.includes('Iframe "Payment form"'));
  const payLine = lines.findIndex((line) => line.includes('button "Pay now"'));
  assert.ok(payLine > iframeLine);
  const indent = (line) => line.length - line.trimStart().length;
  assert.ok(indent(lines[payLine]) > indent(lines[iframeLine]), "deeper than the iframe node");

  // A second read reuses the cached frame-id lookup instead of describing again.
  state.commands.length = 0;
  await read_page(ctx("framed"), { tabId: tab.id });
  assert.equal(
    state.commands.some((call) => call.method === "DOM.describeNode"),
    false,
    "the iframe element -> frame id lookup is cached for the document",
  );
});

test("a frame whose host element cannot be described is named in a note", async () => {
  const tab = await makeTab({ sessionKey: "unplaced" });
  attachFrame(tab.id, { sessionId: "S1", frameId: "frame-1" });
  state.describeFails = true;

  const result = await read_page(ctx("unplaced"), { tabId: tab.id });
  assert.doesNotMatch(result.text, /Pay now/);
  assert.match(result.text, /1 cross-origin iframe\(s\) are attached but their iframe element/);
});

test("find reaches into the frame and its ref clicks through the frame's session", async () => {
  const tab = await makeTab({ sessionKey: "clicking" });
  attachFrame(tab.id, { sessionId: "S1", frameId: "frame-1" });

  const found = await find(ctx("clicking"), { tabId: tab.id, query: "pay now button" });
  assert.match(found.text, /button "Pay now"/);
  const ref = found.text.match(/\[(ref_\d+)\] button "Pay now"/)[1];

  // Chromium reports OOPIF quads in the main frame's viewport, so the point needs no
  // translation; the geometry query goes to the frame, the mouse to the page.
  state.quads.set(`S1|3`, [500, 300, 600, 300, 600, 340, 500, 340]);
  state.commands.length = 0;
  const clicked = await computer(ctx("clicking"), { action: "left_click", tabId: tab.id, ref });
  assert.match(clicked.text, /at ref_\d+ at \(550, 320\)/);

  const quads = state.commands.find((call) => call.method === "DOM.getContentQuads");
  assert.equal(quads.target.sessionId, "S1", "geometry comes from the frame's session");
  assert.equal(quads.params.backendNodeId, 3);
  const scrolled = state.commands.find((call) => call.method === "DOM.scrollIntoViewIfNeeded");
  assert.equal(scrolled.target.sessionId, "S1");
  for (const call of state.commands.filter((entry) => entry.method === "Input.dispatchMouseEvent")) {
    assert.equal(call.target.sessionId, undefined, "input is dispatched through the main session");
  }
});

test("a ref in the main frame still carries no session", async () => {
  const tab = await makeTab({ sessionKey: "mainref" });
  attachFrame(tab.id, { sessionId: "S1", frameId: "frame-1" });
  const found = await find(ctx("mainref"), { tabId: tab.id, query: "use another card" });
  const ref = found.text.match(/\[(ref_\d+)\] button/)[1];
  assert.deepEqual(cdp.refTable(tab.id).targetFor(ref), {
    sessionId: null,
    backendNodeId: 3,
    detached: false,
  });
});

test("form_input and file_upload address the frame's own session", async () => {
  const tab = await makeTab({ sessionKey: "forms" });
  attachFrame(tab.id, { sessionId: "S1", frameId: "frame-1" });
  const found = await find(ctx("forms"), { tabId: tab.id, query: "card number" });
  const ref = found.text.match(/\[(ref_\d+)\] textbox/)[1];

  state.commands.length = 0;
  await form_input(ctx("forms"), { tabId: tab.id, ref, value: "4242" });
  const resolved = state.commands.find((call) => call.method === "DOM.resolveNode");
  assert.equal(resolved.target.sessionId, "S1");
  const called = state.commands.find((call) => call.method === "Runtime.callFunctionOn");
  assert.equal(called.target.sessionId, "S1");
  assert.equal(called.params.objectId, "obj-S1-2");

  state.commands.length = 0;
  await file_upload(ctx("forms"), { tabId: tab.id, ref, paths: ["/tmp/card.png"] });
  const setFiles = state.commands.find((call) => call.method === "DOM.setFileInputFiles");
  assert.equal(setFiles.target.sessionId, "S1");
  assert.deepEqual(setFiles.params.files, ["/tmp/card.png"]);
});

test("a detached frame invalidates its refs with a clear error", async () => {
  const tab = await makeTab({ sessionKey: "detaching" });
  attachFrame(tab.id, { sessionId: "S1", frameId: "frame-1" });
  const found = await find(ctx("detaching"), { tabId: tab.id, query: "pay now" });
  const frameRef = found.text.match(/\[(ref_\d+)\] button "Pay now"/)[1];
  const mainRef = found.text.match(/\[(ref_\d+)\] button "Use another card"/)?.[1] ?? null;

  detachFrame(tab.id, "S1");

  await assert.rejects(
    () => computer(ctx("detaching"), { action: "left_click", tabId: tab.id, ref: frameRef }),
    /was inside a cross-origin iframe that has since gone away/,
  );
  assert.deepEqual(cdp.frameSessions(tab.id), [], "and the session is forgotten");

  // A ref from the page itself is untouched by the frame going away.
  if (mainRef) {
    state.quads.set(`|3`, [10, 10, 20, 10, 20, 20, 10, 20]);
    const clicked = await computer(ctx("detaching"), {
      action: "left_click",
      tabId: tab.id,
      ref: mainRef,
    });
    assert.match(clicked.text, /at \(15, 15\)/);
  }

  // And the frame is simply gone from the next read.
  const result = await read_page(ctx("detaching"), { tabId: tab.id });
  assert.doesNotMatch(result.text, /Pay now/);
  assert.doesNotMatch(result.text, /cross-origin/);
});

test("a nested frame is read through its own session too", async () => {
  const tab = await makeTab({ sessionKey: "nested" });
  attachFrame(tab.id, { sessionId: "S1", frameId: "frame-1" });
  attachFrame(tab.id, { sessionId: "S2", frameId: "frame-2" });

  const result = await read_page(ctx("nested"), { tabId: tab.id });
  assert.match(result.text, /button "Pay now"/);
  assert.match(result.text, /button "Approve"/);
  assert.match(result.text, /Includes the content of 2 cross-origin iframe\(s\)/);

  const found = await find(ctx("nested"), { tabId: tab.id, query: "approve" });
  const ref = found.text.match(/\[(ref_\d+)\] button "Approve"/)[1];
  assert.equal(cdp.refTable(tab.id).targetFor(ref).sessionId, "S2");
});

test("ref numbers are unique across frames even when backend ids collide", async () => {
  const tab = await makeTab({ sessionKey: "collide" });
  attachFrame(tab.id, { sessionId: "S1", frameId: "frame-1" });
  await read_page(ctx("collide"), { tabId: tab.id });

  const refs = cdp.refTable(tab.id);
  // Backend node 3 exists in both the page ("Use another card") and the frame ("Pay now").
  const mainRef = refs.refFor(3, null);
  const frameRef = refs.refFor(3, "S1");
  assert.notEqual(mainRef, frameRef);
  assert.equal(refs.targetFor(mainRef).sessionId, null);
  assert.equal(refs.targetFor(frameRef).sessionId, "S1");
});

test("an unknown ref and a detached ref say different things", () => {
  const refs = new RefTable();
  const ref = refs.refFor(7, "S9");
  assert.equal(refs.invalidateSession("S9"), 1);
  assert.deepEqual(refs.targetFor(ref), { sessionId: "S9", backendNodeId: 7, detached: true });
  assert.equal(refs.targetFor("ref_999"), null);
  // A new ref for the same node in a new session is a different ref.
  const again = refs.refFor(7, "S10");
  assert.notEqual(again, ref);
});
