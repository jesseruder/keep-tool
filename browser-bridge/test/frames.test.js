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

/**
 * The page: a heading, a same-process button, the cross-origin payment iframe (backend
 * 20) and a same-origin terms iframe (backend 21).
 */
const MAIN_TREE = [
  node("1", "RootWebArea", { name: "Checkout", childIds: ["2", "3", "20", "21"], backendDOMNodeId: 1 }),
  node("2", "heading", { name: "Checkout", backendDOMNodeId: 2, focusable: false }),
  node("3", "button", { name: "Use another card", backendDOMNodeId: 3 }),
  node("20", "Iframe", { name: "Payment form", backendDOMNodeId: 20 }),
  node("21", "Iframe", { name: "Terms", backendDOMNodeId: 21 }),
];

/** The same-origin terms frame: same session as the page, but its own document. */
const LOCAL_TREE = [
  node("1", "RootWebArea", { name: "Terms", childIds: ["2"], backendDOMNodeId: 40 }),
  node("2", "checkbox", { name: "I agree", backendDOMNodeId: 41 }),
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

/**
 * A frame nested inside the payment frame (a 3-D secure challenge, say). Its backend node
 * ids do not overlap the payment frame's: a renderer numbers them per process, so two
 * documents that share a process never reuse one.
 */
const NESTED_TREE = [
  node("1", "RootWebArea", { name: "Verify", childIds: ["2"], backendDOMNodeId: 50 }),
  node("2", "button", { name: "Approve", backendDOMNodeId: 51 }),
];

// --- the pure splice -----------------------------------------------------

test("namespacing keeps two trees that both number from 1 apart", () => {
  const spliced = namespaceNodes(FRAME_TREE, "frame-1", "S1");
  assert.equal(spliced[0].nodeId, "frame-1::1");
  assert.deepEqual(spliced[0].childIds, ["frame-1::2", "frame-1::3", "frame-1::4"]);
  assert.equal(spliced[0].frameSessionId, "S1");
  // The source tree is untouched.
  assert.equal(FRAME_TREE[0].nodeId, "1");
  assert.equal(FRAME_TREE[0].frameSessionId, undefined);

  // A same-process frame is namespaced by its frame id too - two documents in one
  // session both number from 1 - but keeps its parent's session, because that is where
  // its nodes resolve.
  const local = namespaceNodes(LOCAL_TREE, "local-1", null);
  assert.equal(local[0].nodeId, "local-1::1");
  assert.equal(local[0].frameSessionId, null);
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
  assert.deepEqual(host.childIds, ["frame-1::1"]);
  // Right after the host, so refs stay in document order.
  assert.equal(nodes[nodes.indexOf(host) + 1].nodeId, "frame-1::1");
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
  const inner = nodes.find((item) => item.nodeId === "frame-1::4");
  assert.deepEqual(inner.childIds, ["frame-2::1"]);
});

test("a same-process frame is spliced under its iframe with its parent's session", () => {
  const owners = new Map([["local-1", { sessionId: null, backendNodeId: 21 }]]);
  const { nodes, placed } = spliceFrameTrees(
    MAIN_TREE,
    [{ sessionId: null, frameId: "local-1", nodes: LOCAL_TREE, kind: "local" }],
    owners,
  );
  assert.deepEqual(placed, ["local-1"]);
  const host = nodes.find((item) => item.backendDOMNodeId === 21);
  assert.deepEqual(host.childIds, ["local-1::1"]);
  const checkbox = nodes.find((item) => item.nodeId === "local-1::2");
  assert.equal(checkbox.frameSessionId, null, "its nodes resolve in the page's own session");
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
    [20, 21],
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
  boxes: new Map(), // "sessionId|backendNodeId" -> content quad of an iframe element
  // sessionId ("" for the page's own session) -> the frame ids its frame tree reports.
  childFrames: new Map(),
  // sessionId ("" for the page's own session) -> the OOPIFs that attach when *that*
  // session arms auto-attach. Chromium's auto-attach is not recursive, so a frame two
  // levels down appears only after its own parent's session asks for it.
  autoAttachChildren: new Map(),
};

function framesOf(sessionId) {
  return state.childFrames.get(sessionId ?? "") ?? [];
}

function addChildFrame(sessionId, frameId) {
  const key = sessionId ?? "";
  state.childFrames.set(key, [...framesOf(sessionId), frameId]);
}

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
        // With a frameId this is a same-process child document of that session; without
        // one it is the session's own document.
        if (params?.frameId) {
          if (sessionId === null && params.frameId === "local-1") return { nodes: LOCAL_TREE };
          if (sessionId === "S1" && params.frameId === "local-2") return { nodes: NESTED_TREE };
          // Exactly what Edge says when the frame lives in another process.
          throw new Error("Frame with the given id is not part of the target");
        }
        if (sessionId === null) return { nodes: MAIN_TREE };
        if (sessionId === "S1") return { nodes: FRAME_TREE };
        if (sessionId === "S2") return { nodes: NESTED_TREE };
        throw new Error(`no tree for session ${sessionId}`);
      }
      if (method === "Target.setAutoAttach") {
        // What the browser does when a session arms auto-attach: its own out-of-process
        // children attach, reporting on that session.
        const waiting = state.autoAttachChildren.get(sessionId ?? "") ?? [];
        state.autoAttachChildren.delete(sessionId ?? "");
        for (const child of waiting) {
          eventListener()({ tabId: target.tabId, sessionId: sessionId ?? undefined }, "Target.attachedToTarget", {
            sessionId: child.sessionId,
            targetInfo: { targetId: child.frameId, type: "iframe", url: "https://verify.example/" },
            waitingForDebugger: false,
          });
        }
        return {};
      }
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: `root-${sessionId ?? "main"}` },
            childFrames: framesOf(sessionId).map((id) => ({ frame: { id }, childFrames: [] })),
          },
        };
      }
      if (method === "DOM.getBoxModel") {
        const box = state.boxes.get(`${sessionId ?? ""}|${params.backendNodeId}`);
        if (!box) return {};
        const [x, y, width, height] = box;
        return {
          model: {
            content: [x, y, x + width, y, x + width, y + height, x, y + height],
            width,
            height,
          },
        };
      }
      if (method === "DOM.describeNode") {
        if (state.describeFails) return { node: {} };
        // The iframe element in the main tree hosts frame-1; the one in the payment
        // frame hosts frame-2.
        if (sessionId === null && params.backendNodeId === 20) {
          return { node: { nodeName: "IFRAME", frameId: "frame-1" } };
        }
        if (sessionId === null && params.backendNodeId === 21) {
          return { node: { nodeName: "IFRAME", frameId: "local-1" } };
        }
        if (sessionId === "S1" && params.backendNodeId === 4) {
          return { node: { nodeName: "IFRAME", frameId: state.nestedIsLocal ? "local-2" : "frame-2" } };
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
  state.nestedIsLocal = false;
  state.quads.clear();
  state.boxes.clear();
  state.childFrames.clear();
  state.autoAttachChildren.clear();
  return state.tabs.get(id);
}

/** An OOPIF that will attach once `parentSession` arms auto-attach inside itself. */
function queueAutoAttach(parentSession, { sessionId, frameId }) {
  const key = parentSession ?? "";
  const waiting = state.autoAttachChildren.get(key) ?? [];
  state.autoAttachChildren.set(key, [...waiting, { sessionId, frameId }]);
  addChildFrame(parentSession, frameId);
}

/**
 * An out-of-process iframe attaching. Its frame also shows up in the parent's frame tree,
 * exactly as Chromium reports it, so the same-process sweep has to skip it.
 */
function attachFrame(tabId, { sessionId, frameId, type = "iframe", parentSession = null }) {
  if (type === "iframe") addChildFrame(parentSession, frameId);
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

test("a page with no child frames at all reads exactly as it always did", async () => {
  const tab = await makeTab({ sessionKey: "plain" });
  const result = await read_page(ctx("plain"), { tabId: tab.id });

  assert.match(result.text, /button "Use another card"/);
  assert.doesNotMatch(result.text, /Pay now/);
  assert.doesNotMatch(result.text, /iframe\(s\)/);
  assert.equal(
    state.commands.filter((call) => call.method === "Accessibility.getFullAXTree").length,
    1,
    "one tree, no extra round trips",
  );
  assert.equal(
    state.commands.some((call) => call.method === "DOM.describeNode"),
    false,
    "and nothing is described when the frame tree has no children",
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
    ["DOM.enable", "Accessibility.enable", "Page.enable"],
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

test("a same-origin iframe's content is read through the page's own session", async () => {
  const tab = await makeTab({ sessionKey: "sameorigin" });
  addChildFrame(null, "local-1");

  const result = await read_page(ctx("sameorigin"), { tabId: tab.id });
  assert.match(result.text, /Iframe "Terms"/);
  assert.match(result.text, /checkbox "I agree"/);
  assert.match(result.text, /Includes the content of 1 same-origin iframe\(s\)/);
  assert.doesNotMatch(result.text, /cross-origin/);

  // Same session, asked for by frame id: no second debugger session is involved.
  const trees = state.commands.filter((call) => call.method === "Accessibility.getFullAXTree");
  assert.deepEqual(
    trees.map((call) => [call.target.sessionId ?? null, call.params?.frameId ?? null]),
    [
      [null, null],
      [null, "local-1"],
    ],
  );

  // And its elements resolve in the page's session, with no coordinate translation.
  const found = await find(ctx("sameorigin"), { tabId: tab.id, query: "i agree checkbox" });
  const ref = found.text.match(/\[(ref_\d+)\] checkbox/)[1];
  assert.deepEqual(cdp.refTable(tab.id).targetFor(ref), {
    sessionId: null,
    backendNodeId: 41,
    detached: false,
  });
  state.quads.set(`|41`, [100, 400, 120, 400, 120, 420, 100, 420]);
  state.commands.length = 0;
  const clicked = await computer(ctx("sameorigin"), { action: "left_click", tabId: tab.id, ref });
  assert.match(clicked.text, /at \(110, 410\)/);
  assert.equal(
    state.commands.some((call) => call.method === "DOM.getBoxModel"),
    false,
    "a same-process frame needs no offset",
  );
});

test("a page with one same-process child and one OOPIF child folds in both", async () => {
  const tab = await makeTab({ sessionKey: "both" });
  attachFrame(tab.id, { sessionId: "S1", frameId: "frame-1" });
  addChildFrame(null, "local-1");

  const result = await read_page(ctx("both"), { tabId: tab.id });
  assert.match(result.text, /button "Pay now"/);
  assert.match(result.text, /checkbox "I agree"/);
  assert.match(result.text, /Includes the content of 1 cross-origin and 1 same-origin iframe\(s\)/);

  const trees = state.commands.filter((call) => call.method === "Accessibility.getFullAXTree");
  assert.deepEqual(
    trees.map((call) => [call.target.sessionId ?? null, call.params?.frameId ?? null]),
    [
      [null, null],
      ["S1", null],
      [null, "local-1"],
    ],
    "the OOPIF is never asked for by frame id on the page's session",
  );
});

test("a same-process frame inside an OOPIF belongs to that frame's session", async () => {
  const tab = await makeTab({ sessionKey: "localnested" });
  attachFrame(tab.id, { sessionId: "S1", frameId: "frame-1" });
  addChildFrame("S1", "local-2");
  state.nestedIsLocal = true;

  const result = await read_page(ctx("localnested"), { tabId: tab.id });
  assert.match(result.text, /button "Approve"/);
  assert.match(result.text, /Includes the content of 1 cross-origin and 1 same-origin iframe\(s\)/);

  const found = await find(ctx("localnested"), { tabId: tab.id, query: "approve" });
  const ref = found.text.match(/\[(ref_\d+)\] button "Approve"/)[1];
  assert.equal(cdp.refTable(tab.id).targetFor(ref).sessionId, "S1");

  // One offset only: the OOPIF's. The same-process frame inside it adds nothing.
  state.boxes.set(`|20`, [22, 282, 500, 258]);
  state.quads.set(`S1|51`, [80, 40, 120, 40, 120, 60, 80, 60]);
  state.commands.length = 0;
  const clicked = await computer(ctx("localnested"), { action: "left_click", tabId: tab.id, ref });
  assert.match(clicked.text, /at \(122, 332\)/);
  assert.equal(state.commands.filter((call) => call.method === "DOM.getBoxModel").length, 1);
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

  // The numbers are the ones measured on Edge 153: the iframe's border box sits at
  // (20, 280) with a 2 px border, so its content starts at (22, 282), and the button the
  // frame reports at (430, 90) in its own viewport is really at (452, 372) on the page.
  state.boxes.set(`|20`, [22, 282, 500, 258]);
  state.quads.set(`S1|3`, [380, 70, 480, 70, 480, 110, 380, 110]);
  state.commands.length = 0;
  const clicked = await computer(ctx("clicking"), { action: "left_click", tabId: tab.id, ref });
  assert.match(clicked.text, /at ref_\d+ at \(452, 372\)/);

  const quads = state.commands.find((call) => call.method === "DOM.getContentQuads");
  assert.equal(quads.target.sessionId, "S1", "geometry comes from the frame's session");
  assert.equal(quads.params.backendNodeId, 3);
  const scrolled = state.commands.find((call) => call.method === "DOM.scrollIntoViewIfNeeded");
  assert.equal(scrolled.target.sessionId, "S1", "and the frame scrolls its own content");
  const box = state.commands.find((call) => call.method === "DOM.getBoxModel");
  assert.equal(box.target.sessionId, undefined, "the host iframe is measured in its parent");
  assert.equal(box.params.backendNodeId, 20);
  for (const call of state.commands.filter((entry) => entry.method === "Input.dispatchMouseEvent")) {
    assert.equal(call.target.sessionId, undefined, "input is dispatched through the main session");
    assert.deepEqual([call.params.x, call.params.y], [452, 372]);
  }
});

test("a point inside a frame inside a frame adds both offsets", async () => {
  const tab = await makeTab({ sessionKey: "twolevel" });
  attachFrame(tab.id, { sessionId: "S1", frameId: "frame-1" });
  attachFrame(tab.id, { sessionId: "S2", frameId: "frame-2", parentSession: "S1" });

  const found = await find(ctx("twolevel"), { tabId: tab.id, query: "approve" });
  const ref = found.text.match(/\[(ref_\d+)\] button "Approve"/)[1];

  // The payment frame's content starts at (22, 282) on the page; the verify frame's
  // content starts at (10, 40) inside the payment frame; the button sits at (100, 50)
  // inside the verify frame.
  state.boxes.set(`|20`, [22, 282, 500, 258]);
  state.boxes.set(`S1|4`, [10, 40, 300, 150]);
  state.quads.set(`S2|51`, [80, 40, 120, 40, 120, 60, 80, 60]);
  state.commands.length = 0;

  const clicked = await computer(ctx("twolevel"), { action: "left_click", tabId: tab.id, ref });
  assert.match(clicked.text, /at \(132, 372\)/);
  const boxes = state.commands.filter((call) => call.method === "DOM.getBoxModel");
  assert.deepEqual(
    boxes.map((call) => [call.target.sessionId ?? null, call.params.backendNodeId]),
    [
      ["S1", 4],
      [null, 20],
    ],
    "inner frame first, then its own host, outwards to the page",
  );
});

test("a ref whose frame position is unknown refuses instead of clicking a guess", async () => {
  const tab = await makeTab({ sessionKey: "noorigin" });
  attachFrame(tab.id, { sessionId: "S1", frameId: "frame-1" });
  const found = await find(ctx("noorigin"), { tabId: tab.id, query: "pay now" });
  const ref = found.text.match(/\[(ref_\d+)\] button "Pay now"/)[1];

  // The browser has forgotten the iframe element: no box model, no offset, no click.
  state.quads.set(`S1|3`, [380, 70, 480, 70, 480, 110, 380, 110]);
  await assert.rejects(
    () => computer(ctx("noorigin"), { action: "left_click", tabId: tab.id, ref }),
    /no box model for the iframe element/,
  );
  assert.equal(
    state.commands.some((call) => call.method === "Input.dispatchMouseEvent"),
    false,
    "and nothing was clicked",
  );
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

test("auto-attach is armed inside each frame, so a frame two levels down attaches", async () => {
  const tab = await makeTab({ sessionKey: "deep" });
  // The page's own session arms auto-attach when the tab is attached, which is what lets
  // the first frame attach at all; from here on only the frames' own arming matters.
  await cdp.attach(tab.id);
  state.commands.length = 0;

  attachFrame(tab.id, { sessionId: "S1", frameId: "frame-1" });
  // The verify frame is out-of-process inside an out-of-process frame: it attaches only
  // once S1's own session arms auto-attach, and its event arrives on S1.
  queueAutoAttach("S1", { sessionId: "S2", frameId: "frame-2" });

  const result = await read_page(ctx("deep"), { tabId: tab.id });
  assert.match(result.text, /button "Pay now"/);
  assert.match(result.text, /button "Approve"/);
  assert.match(result.text, /Includes the content of 2 cross-origin iframe\(s\)/);

  const armed = state.commands.filter((call) => call.method === "Target.setAutoAttach");
  assert.deepEqual(
    armed.map((call) => call.target.sessionId ?? null),
    ["S1", "S2"],
    "each frame arms it again for its own children",
  );
  for (const call of armed) {
    assert.deepEqual(call.params, { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  }

  // The grandchild's tree hangs off the iframe node inside the child's tree, not off the
  // page, and it is read through its own session.
  const lines = result.text.split("\n");
  const indent = (needle) => {
    const line = lines.find((entry) => entry.includes(needle));
    return line.length - line.trimStart().length;
  };
  assert.ok(indent('Iframe "Verify card"') > indent('Iframe "Payment form"'));
  assert.ok(indent('button "Approve"') > indent('Iframe "Verify card"'));

  const trees = state.commands.filter((call) => call.method === "Accessibility.getFullAXTree");
  assert.deepEqual(
    trees.map((call) => call.target.sessionId ?? null),
    [null, "S1", "S2"],
  );

  const found = await find(ctx("deep"), { tabId: tab.id, query: "approve" });
  const ref = found.text.match(/\[(ref_\d+)\] button "Approve"/)[1];
  assert.equal(cdp.refTable(tab.id).targetFor(ref).sessionId, "S2");
});

test("detaching a frame takes the frames inside it with it", async () => {
  const tab = await makeTab({ sessionKey: "subtree" });
  attachFrame(tab.id, { sessionId: "S1", frameId: "frame-1" });
  queueAutoAttach("S1", { sessionId: "S2", frameId: "frame-2" });
  await read_page(ctx("subtree"), { tabId: tab.id });

  const found = await find(ctx("subtree"), { tabId: tab.id, query: "approve" });
  const deepRef = found.text.match(/\[(ref_\d+)\] button "Approve"/)[1];
  assert.deepEqual(
    cdp.frameSessions(tab.id).map((entry) => entry.sessionId),
    ["S1", "S2"],
  );

  // Only the middle frame detaches; the browser says nothing about the one inside it.
  detachFrame(tab.id, "S1");
  assert.deepEqual(cdp.frameSessions(tab.id), [], "the whole subtree is forgotten");
  await assert.rejects(
    () => computer(ctx("subtree"), { action: "left_click", tabId: tab.id, ref: deepRef }),
    /was inside a cross-origin iframe that has since gone away/,
  );
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
