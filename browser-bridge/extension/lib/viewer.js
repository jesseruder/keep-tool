// The live view: Owner watching and driving a session's tabs from the Keep console.
//
// A viewer is not a session. It has no tab group and no sessionKey; it names a session
// by the "#<num>" its group title starts with, sees that session's tabs (and any tab one
// of them opened, which is where an OAuth pop-up lands), streams one tab at a time with
// Page.startScreencast, and sends Owner's mouse and keys back with Input.*. Only the
// native host can start one, and it only lets a client that proved it holds the daemon
// token ask (see host/native-host.js).
//
// Frames are events, not replies: the extension pushes them through the port as
// {event: "viewer_frame"} and the host routes them to the socket client that owns the
// viewer. CDP only sends the next frame once the last is acked, so the ack is held back
// until the viewer says it has drawn one: at most MAX_UNACKED frames are ever in flight,
// which is what keeps a slow link from queueing seconds of stale pictures.

import { attach, detach, isAttached, onOwnDetach, send } from "./cdp.js";
import { activityGeneration, allSessions, tabsInGroup, withSessionLock } from "./sessions.js";
import { CTRL, META, macCommands } from "./keys.js";

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform ?? "");

export const MAX_UNACKED = 2;
const MIN_SIDE = 200;
const MAX_SIDE = 4096;

const viewers = new Map(); // viewerId -> viewer

/** sha256 of a session key, hex, first 32: what mcp/daemon.js compares with its own. */
export async function ownerTag(sessionKey) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionKey));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** "#12" matches the groups titled "#12" and "#12 some-card", never "#123". */
export function nameMatches(name, session) {
  if (typeof name !== "string" || typeof session !== "string" || !session) return false;
  const bare = name.replace(/ \(ended\)$/, "");
  return bare === session || bare.startsWith(`${session} `);
}

/**
 * The tabs a viewer of `session` may see: every tab in a group titled for it, and every
 * tab opened from one of those, transitively. A window.open pop-up is not grouped (it
 * is not in a normal window), so its opener is the only link back to the session.
 */
export function tabsForSession(store, allTabs, session) {
  const groups = new Set();
  for (const record of Object.values(store)) {
    if (record?.groupId != null && nameMatches(record.name, session)) groups.add(record.groupId);
  }
  const ids = new Set(allTabs.filter((tab) => groups.has(tab.groupId)).map((tab) => tab.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const tab of allTabs) {
      if (!ids.has(tab.id) && tab.openerTabId != null && ids.has(tab.openerTabId)) {
        ids.add(tab.id);
        grew = true;
      }
    }
  }
  return allTabs
    .filter((tab) => ids.has(tab.id))
    .map((tab) => ({
      id: tab.id,
      url: tab.url ?? "",
      title: tab.title ?? "",
      active: Boolean(tab.active),
      popup: !groups.has(tab.groupId),
      openerTabId: tab.openerTabId ?? null,
    }));
}

async function sessionTabs(session) {
  const [store, allTabs] = await Promise.all([allSessions(), chrome.tabs.query({})]);
  return tabsForSession(store, allTabs, session);
}

function clampSide(value, fallback) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_SIDE, Math.max(MIN_SIDE, number));
}

function validViewerId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 200;
}

async function requireViewableTab(session, tabId) {
  const tabs = await sessionTabs(session);
  const tab = tabs.find((candidate) => candidate.id === Number(tabId));
  if (!tab) throw new Error(`tab ${tabId} is not one of ${session}'s tabs`);
  return tab;
}

/**
 * Handlers take (params, emit) where emit(event) sends an id-less event down the port the
 * request came in on. Each returns the reply's result.
 */
export function createViewerHandlers() {
  async function stopViewer(viewer, reason) {
    if (!viewers.has(viewer.id)) return;
    viewers.delete(viewer.id);
    viewer.stopped = true;
    if (viewer.tabId == null) return;
    const tabId = viewer.tabId;
    viewer.tabId = null;
    if (!isAttached(tabId)) return;
    try {
      await send(tabId, "Page.stopScreencast");
    } catch {
      // the tab or the attachment is already gone
    }
    if (viewer.fit && !otherViewerFits(tabId, viewer.id)) {
      try {
        await send(tabId, "Emulation.clearDeviceMetricsOverride");
      } catch {
        // same
      }
    }
    viewer.emit({ event: "viewer_state", viewer: viewer.id, state: "stopped", reason });
    await releaseTab(tabId);
  }

  /**
   * Detach a tab only a view was holding: a pop-up, or a tab of a session that has ended.
   * A live session's tab stays attached for its tools, and so does one another view is
   * watching. Otherwise headed Edge would keep its "being debugged" bar after the view.
   */
  async function releaseTab(tabId) {
    const held = () => starting.has(tabId) || [...viewers.values()].some((other) => other.tabId === tabId);
    if (!isAttached(tabId) || held()) return;
    let owner = null;
    let groupId = null;
    try {
      const tab = await chrome.tabs.get(tabId);
      groupId = tab.groupId;
      if (tab.groupId != null && tab.groupId >= 0) {
        const store = await allSessions();
        owner = Object.keys(store).find((key) => store[key]?.groupId === tab.groupId) ?? null;
        if (owner && !store[owner].ended) return;
      }
    } catch {
      return; // the tab is gone, and its attachment with it
    }
    if (!owner) {
      if (!held()) await detach(tabId);
      return;
    }
    // An ended session can come back at any moment, and with it a tool call on this tab.
    // Its return runs under the session's lock, so this does too: a request that came in
    // first has revived the session by the time the lock is ours, and one that comes in
    // later moves the activity count read here (the same test closeSession uses).
    const generation = activityGeneration(owner);
    await withSessionLock(owner, async () => {
      const store = await allSessions();
      if (!store[owner]?.ended || store[owner].groupId !== groupId) return;
      // The tab may have moved into another (live) session's group meanwhile.
      let tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        return;
      }
      if (tab.groupId !== groupId || activityGeneration(owner) !== generation || held()) return;
      await detach(tabId);
    });
  }

  function otherViewerFits(tabId, exceptId) {
    for (const other of viewers.values()) {
      if (other.id !== exceptId && other.tabId === tabId && other.fit) return true;
    }
    return false;
  }

  // A viewer's start and stop run one at a time: a resize restart racing a tab switch
  // must not leave a screencast or an override on a tab no viewer owns any more.
  const chains = new Map(); // viewerId -> promise
  const starting = new Map(); // tabId -> starts in progress
  function serial(id, fn) {
    const run = (chains.get(id) ?? Promise.resolve()).then(fn);
    const settled = run.then(() => {}, () => {});
    chains.set(id, settled);
    settled.then(() => {
      if (chains.get(id) === settled) chains.delete(id);
    });
    return run;
  }

  async function startScreencast(viewer) {
    const tabId = viewer.tabId;
    const current = () => !viewer.stopped && viewer.tabId === tabId;
    await attach(tabId);
    if (!current()) return;
    if (viewer.fit) {
      // Laid out at the view's size, but never switched to a mobile layout: the agent
      // is working in this page too, and a phone glance should not reflow it.
      await send(tabId, "Emulation.setDeviceMetricsOverride", {
        width: viewer.width,
        height: viewer.height,
        deviceScaleFactor: 0,
        mobile: false,
      });
    }
    // Taken over while this start was on its way: the override belongs to the view that
    // took the tab now, so it is only cleared when no view holds the tab.
    const abandon = async () => {
      if (!otherViewerFits(tabId, viewer.id)) await send(tabId, "Emulation.clearDeviceMetricsOverride").catch(() => {});
    };
    if (!current()) return abandon();
    // A tab streams once: a restart at a new size, or another view taking the tab over,
    // replaces the screencast that is running ("Screencast is already active" otherwise).
    await send(tabId, "Page.stopScreencast").catch(() => {});
    if (!current()) return abandon();
    const scale = viewer.pixelRatio;
    await send(tabId, "Page.startScreencast", {
      format: "jpeg",
      quality: viewer.quality,
      maxWidth: Math.round(viewer.width * scale),
      maxHeight: Math.round(viewer.height * scale),
      everyNthFrame: 1,
    });
  }

  async function ackCdp(viewer, sessionId) {
    if (viewer.tabId == null) return;
    try {
      await send(viewer.tabId, "Page.screencastFrameAck", { sessionId });
    } catch {
      // a screencast that stopped between the frame and the ack
    }
  }

  // Frames arrive on every attached tab's port; each goes to the viewers watching it.
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method !== "Page.screencastFrame" || source.sessionId) return;
    for (const viewer of viewers.values()) {
      if (viewer.tabId !== source.tabId) continue;
      viewer.seq += 1;
      const delivered = viewer.emit({
        event: "viewer_frame",
        viewer: viewer.id,
        tabId: source.tabId,
        seq: viewer.seq,
        data: params.data,
        metadata: params.metadata ?? {},
      });
      if (!delivered) {
        stopViewer(viewer, "the host went away");
        continue;
      }
      viewer.unacked += 1;
      if (viewer.unacked < MAX_UNACKED) ackCdp(viewer, params.sessionId);
      else viewer.heldAck = params.sessionId;
    }
  });

  // Something detached the debugger: an agent's session ended, or the tab closed. The
  // view says so and picks the screencast back up if the tab is still there.
  // Both kinds: a detach from outside (onDetach), and one this extension made itself when
  // a session ended or a tab left its group (onOwnDetach), which onDetach never reports.
  chrome.debugger.onDetach.addListener((source) => reattach(source.tabId));
  onOwnDetach((tabId) => reattach(tabId));

  function reattach(tabId) {
    for (const viewer of viewers.values()) {
      if (viewer.tabId !== tabId) continue;
      viewer.emit({ event: "viewer_state", viewer: viewer.id, state: "detached" });
      viewer.unacked = 0;
      viewer.heldAck = null;
      setTimeout(() => {
        if (viewer.stopped || viewer.tabId !== tabId) return;
        startScreencast(viewer).catch((error) =>
          viewer.emit({
            event: "viewer_state",
            viewer: viewer.id,
            state: "error",
            reason: String(error?.message ?? error),
          }),
        );
      }, 500);
    }
  }

  chrome.tabs.onRemoved.addListener((tabId) => {
    for (const viewer of viewers.values()) {
      if (viewer.tabId !== tabId) continue;
      viewer.tabId = null;
      viewer.emit({ event: "viewer_state", viewer: viewer.id, state: "tab-closed", tabId });
    }
  });

  return {
    /**
     * Which session's group a tab is in, as ownerTag() of its session key: the daemon
     * can match that against its own sessions, and the key itself never leaves here.
     */
    async viewer_tab_owner(params) {
      const tabId = Number(params.tabId);
      if (!Number.isInteger(tabId)) throw new Error("tabId is required");
      const tab = await chrome.tabs.get(tabId);
      if (tab.groupId == null || tab.groupId < 0) return { owner: null };
      const store = await allSessions();
      const key = Object.keys(store).find((k) => store[k]?.groupId === tab.groupId && !store[k].ended);
      return { owner: key ? await ownerTag(key) : null };
    },

    async viewer_tabs(params) {
      const session = String(params.session ?? "");
      if (!/^#\d+$/.test(session)) throw new Error("session must look like #12");
      return { tabs: await sessionTabs(session) };
    },

    /**
     * Start (or move) a viewer onto one tab. Width and height are the CSS size the view
     * has on Owner's screen; with `fit` the page is laid out at that size while it is
     * watched, which is what makes an 800x600 headless window usable on a phone.
     */
    viewer_start(params, emit) {
      if (!validViewerId(params.viewer)) return Promise.reject(new Error("viewer id is required"));
      // Marked before the start queues, so a view letting go of this tab meanwhile does
      // not detach it from under the start.
      const tabId = Number(params.tabId);
      starting.set(tabId, (starting.get(tabId) ?? 0) + 1);
      const run = serial(params.viewer, () => startNow(params, emit));
      const done = () => {
        const left = (starting.get(tabId) ?? 1) - 1;
        if (left > 0) return starting.set(tabId, left);
        starting.delete(tabId);
        // A release this start held off, for a start that then failed: try it now.
        releaseTab(tabId).catch(() => {});
      };
      run.then(done, done);
      return run;
    },

    /** The viewer drew a frame: release the ack CDP is waiting for, if one is held. */
    async viewer_ack(params) {
      const viewer = viewers.get(params.viewer);
      if (!viewer) return { stopped: true };
      viewer.unacked = Math.max(0, viewer.unacked - 1);
      if (viewer.heldAck != null && viewer.unacked < MAX_UNACKED) {
        const sessionId = viewer.heldAck;
        viewer.heldAck = null;
        await ackCdp(viewer, sessionId);
      }
      return { ok: true };
    },

    /** One input event, in the view's CSS pixels, which are the page's with `fit` on. */
    async viewer_input(params) {
      const viewer = viewers.get(params.viewer);
      if (!viewer || viewer.tabId == null) throw new Error("that view is not showing a tab");
      await dispatchInput(viewer.tabId, params.input ?? {});
      return { ok: true };
    },

    async viewer_navigate(params) {
      const viewer = viewers.get(params.viewer);
      if (!viewer || viewer.tabId == null) throw new Error("that view is not showing a tab");
      const action = String(params.action ?? "");
      if (action === "back") await chrome.tabs.goBack(viewer.tabId);
      else if (action === "forward") await chrome.tabs.goForward(viewer.tabId);
      else if (action === "reload") await chrome.tabs.reload(viewer.tabId);
      else throw new Error(`unknown navigation: ${action}`);
      return { ok: true };
    },

    viewer_stop(params) {
      return serial(String(params.viewer ?? ""), async () => {
        const viewer = viewers.get(params.viewer);
        if (viewer) await stopViewer(viewer, params.reason ?? "closed");
        return { ok: true };
      });
    },

    /** The host lost its port or its client: every viewer it carried is over. */
    stopAll(reason) {
      return Promise.all([...viewers.values()].map((viewer) => stopViewer(viewer, reason)));
    },
  };

  /**
   * Start (or move) a viewer onto one tab. Width and height are the CSS size the view
   * has on Owner's screen; with `fit` the page is laid out at that size while it is
   * watched, which is what makes an 800x600 headless window usable on a phone. A tab has
   * one view at a time: CDP gives a tab one screencast, so a second console opening the
   * same tab takes it over, and the first is told.
   */
  async function startNow(params, emit) {
    {
      const session = String(params.session ?? "");
      if (!/^#\d+$/.test(session)) throw new Error("session must look like #12");
      const tab = await requireViewableTab(session, params.tabId);
      for (const other of viewers.values()) {
        if (other.id === params.viewer || other.tabId !== tab.id) continue;
        other.tabId = null;
        other.emit({ event: "viewer_state", viewer: other.id, state: "taken-over", reason: "another view opened this tab" });
      }
      let viewer = viewers.get(params.viewer);
      if (viewer && viewer.tabId != null && viewer.tabId !== tab.id) {
        const previous = viewer.tabId;
        viewer.tabId = null;
        try {
          await send(previous, "Page.stopScreencast");
          if (viewer.fit && !otherViewerFits(previous, viewer.id)) {
            await send(previous, "Emulation.clearDeviceMetricsOverride");
          }
        } catch {
          // the old tab went away
        }
        await releaseTab(previous);
      }
      if (!viewer) {
        viewer = { id: params.viewer, seq: 0, stopped: false };
        viewers.set(viewer.id, viewer);
      }
      Object.assign(viewer, {
        session,
        tabId: tab.id,
        emit,
        width: clampSide(params.width, 1280),
        height: clampSide(params.height, 800),
        pixelRatio: Math.min(3, Math.max(1, Number(params.pixelRatio) || 1)),
        quality: Math.min(90, Math.max(20, Math.round(Number(params.quality) || 70))),
        fit: params.fit !== false,
        unacked: 0,
        heldAck: null,
      });
      try {
        await startScreencast(viewer);
      } catch (error) {
        await stopViewer(viewer, String(error?.message ?? error));
        throw error;
      }
      return { tab };
    }
  }
}

const MOUSE_TYPES = new Set(["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"]);
const BUTTONS = new Set(["none", "left", "middle", "right", "back", "forward"]);
const KEY_TYPES = new Set(["keyDown", "rawKeyDown", "keyUp", "char"]);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function modifierBits(value) {
  return Math.max(0, Math.min(15, Math.round(finite(value)))) | 0;
}

/**
 * The console sends what the browser it runs in reported: DOM mouse and key events, cut
 * down to their fields. They become CDP events here, and nothing else does: an unknown
 * kind is refused rather than passed through.
 */
export function cdpInput(input, { mac = IS_MAC } = {}) {
  const kind = String(input.kind ?? "");
  if (kind === "mouse") {
    const type = String(input.type ?? "");
    if (!MOUSE_TYPES.has(type)) throw new Error(`unknown mouse event: ${type}`);
    const button = BUTTONS.has(input.button) ? input.button : "none";
    return [
      "Input.dispatchMouseEvent",
      {
        type,
        x: Math.round(finite(input.x)),
        y: Math.round(finite(input.y)),
        button,
        buttons: Math.max(0, Math.round(finite(input.buttons))),
        clickCount: Math.max(0, Math.min(3, Math.round(finite(input.clickCount)))),
        modifiers: modifierBits(input.modifiers),
        ...(type === "mouseWheel"
          ? { deltaX: finite(input.deltaX), deltaY: finite(input.deltaY) }
          : {}),
      },
    ];
  }
  if (kind === "key") {
    const type = String(input.type ?? "");
    if (!KEY_TYPES.has(type)) throw new Error(`unknown key event: ${type}`);
    const text = typeof input.text === "string" ? input.text.slice(0, 16) : undefined;
    let modifiers = modifierBits(input.modifiers);
    // Owner types on a Mac. Cmd+A on a Linux browser means what Ctrl+A means there.
    if (!mac && modifiers & META && !(modifiers & CTRL)) modifiers = (modifiers & ~META) | CTRL;
    const keyCode = Math.max(0, Math.min(255, Math.round(finite(input.keyCode))));
    const key = typeof input.key === "string" ? input.key.slice(0, 32) : "";
    const params = {
      type,
      key,
      code: typeof input.code === "string" ? input.code.slice(0, 32) : "",
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
      ...(text ? { text, unmodifiedText: text } : {}),
    };
    if (mac && type !== "keyUp") {
      // On macOS a meta chord only edits (select all, undo) when the command is named.
      const commands = macCommands(modifiers, key.toLowerCase());
      if (commands?.length) params.commands = commands;
    }
    return ["Input.dispatchKeyEvent", params];
  }
  if (kind === "text") {
    const text = String(input.text ?? "");
    if (!text) throw new Error("text input needs text");
    return ["Input.insertText", { text: text.slice(0, 20_000) }];
  }
  throw new Error(`unknown input kind: ${kind}`);
}

async function dispatchInput(tabId, input) {
  const [method, params] = cdpInput(input);
  await send(tabId, method, params);
}
