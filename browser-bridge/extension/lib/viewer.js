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

import { attach, isAttached, send } from "./cdp.js";
import { allSessions, tabsInGroup } from "./sessions.js";
import { CTRL, META, macCommands } from "./keys.js";

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform ?? "");

export const MAX_UNACKED = 2;
const MIN_SIDE = 200;
const MAX_SIDE = 4096;

const viewers = new Map(); // viewerId -> viewer

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
  }

  function otherViewerFits(tabId, exceptId) {
    for (const other of viewers.values()) {
      if (other.id !== exceptId && other.tabId === tabId && other.fit) return true;
    }
    return false;
  }

  async function startScreencast(viewer) {
    const tabId = viewer.tabId;
    await attach(tabId);
    if (viewer.fit) {
      await send(tabId, "Emulation.setDeviceMetricsOverride", {
        width: viewer.width,
        height: viewer.height,
        deviceScaleFactor: 0,
        mobile: viewer.width < 600,
      });
    }
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
  chrome.debugger.onDetach.addListener((source) => {
    for (const viewer of viewers.values()) {
      if (viewer.tabId !== source.tabId) continue;
      viewer.emit({ event: "viewer_state", viewer: viewer.id, state: "detached" });
      setTimeout(() => {
        if (viewer.stopped || viewer.tabId !== source.tabId) return;
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
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    for (const viewer of viewers.values()) {
      if (viewer.tabId !== tabId) continue;
      viewer.tabId = null;
      viewer.emit({ event: "viewer_state", viewer: viewer.id, state: "tab-closed", tabId });
    }
  });

  return {
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
    async viewer_start(params, emit) {
      if (!validViewerId(params.viewer)) throw new Error("viewer id is required");
      const session = String(params.session ?? "");
      if (!/^#\d+$/.test(session)) throw new Error("session must look like #12");
      const tab = await requireViewableTab(session, params.tabId);
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

    async viewer_stop(params) {
      const viewer = viewers.get(params.viewer);
      if (viewer) await stopViewer(viewer, params.reason ?? "closed");
      return { ok: true };
    },

    /** The host lost its port or its client: every viewer it carried is over. */
    stopAll(reason) {
      return Promise.all([...viewers.values()].map((viewer) => stopViewer(viewer, reason)));
    },
  };
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
