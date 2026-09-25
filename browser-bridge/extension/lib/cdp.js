// chrome.debugger plumbing: attach per tab, send CDP commands, and keep the console and
// network buffers the read_* tools serve.
//
// Attaching also turns on flattened auto-attach, so every out-of-process iframe on the
// tab gets a child CDP session of its own. Those sessions are what read_page and find
// use to reach cross-origin frame content, and commands are addressed to them by passing
// `{ tabId, sessionId }` to chrome.debugger.sendCommand.
//
// Everything here is in-memory. A service worker restart loses the buffers; the tools
// say so rather than pretending the page was quiet.

import { RefTable } from "./ax.js";

const PROTOCOL_VERSION = "1.3";
const MAX_CONSOLE = 2000;
const MAX_NETWORK = 2000;
const DOMAINS = ["Runtime", "Log", "Network", "Page", "DOM", "Accessibility"];
// A child iframe session only has to answer questions about its own DOM and its own
// frame tree: console, network and log events keep coming from the main session alone,
// so the buffers the read_* tools serve do not change shape.
const FRAME_DOMAINS = ["DOM", "Accessibility", "Page"];

const attached = new Set();
const tabs = new Map(); // tabId -> tab state

export function stateFor(tabId) {
  let state = tabs.get(tabId);
  if (!state) {
    state = {
      console: [],
      network: [],
      networkById: new Map(),
      refs: new RefTable(),
      origin: null,
      attachedAt: null,
      // Which session's buffers and refs these are, and the group the tab was in when
      // that session last touched it.
      owner: null,
      groupId: null,
      // Bumped on every claim, so a cleanup that awaited can tell a reclaim apart from
      // the state it decided to drop, even when the owner is the same session.
      claimSeq: 0,
      // Out-of-process iframes: frameId -> sessionId and back. For an iframe target the
      // targetId *is* the frame id, which is what lets a tree be spliced under the right
      // iframe node.
      frameSessions: new Map(),
      sessionFrames: new Map(),
      // sessionId -> the session it attached from (null for a child of the page itself).
      // Auto-attach is not recursive, so a frame two levels down attaches from its own
      // parent's session, and this is what tells a detach which sessions go with it.
      sessionParents: new Map(),
      // sessionId -> the promise that enables its domains and arms its auto-attach, so
      // the event handler and a tool asking at the same time share one round of setup.
      frameDomains: new Map(),
      // frameId -> { sessionId, backendNodeId } of the iframe element that hosts it,
      // learned from DOM.describeNode. Backend node ids are stable within a document, so
      // this is cached until the main frame navigates.
      frameOwners: new Map(),
    };
    tabs.set(tabId, state);
  }
  return state;
}

/** State without creating any: a tab nobody has touched has nothing to clean up. */
export function peekTab(tabId) {
  return tabs.get(tabId) ?? null;
}

/**
 * Record who this tab's state belongs to. Console and network history and the ref table
 * are all scoped to one page seen by one session; handing the tab to another session
 * means starting over, not inheriting.
 */
export function claimTab(tabId, sessionKey, groupId) {
  const state = stateFor(tabId);
  if (state.owner !== null && state.owner !== sessionKey) {
    state.console.length = 0;
    state.network.length = 0;
    state.networkById.clear();
    state.refs.reset();
  }
  state.owner = sessionKey ?? null;
  if (groupId !== undefined) state.groupId = groupId;
  state.claimSeq += 1;
  return state;
}

export function refTable(tabId) {
  return stateFor(tabId).refs;
}

export function dropTab(tabId) {
  tabs.delete(tabId);
  attached.delete(tabId);
}

export function isAttached(tabId) {
  return attached.has(tabId);
}

export function attachedTabs() {
  return [...attached];
}

/**
 * `sessionId` addresses a flattened child session (an out-of-process iframe) instead of
 * the tab's own session.
 */
export async function sendRaw(tabId, method, params = {}, sessionId = null) {
  const target = sessionId ? { tabId, sessionId } : { tabId };
  return chrome.debugger.sendCommand(target, method, params);
}

export async function attach(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!/already attached/i.test(message)) {
      throw new Error(`Could not attach the debugger to tab ${tabId}: ${message}`);
    }
    // Another client (or a stale attach of ours) holds the tab. If it is ours we can
    // keep using it; if it is not, the first command fails with a clear message.
  }
  attached.add(tabId);
  const state = stateFor(tabId);
  state.attachedAt = Date.now();
  for (const domain of DOMAINS) {
    try {
      await sendRaw(tabId, `${domain}.enable`);
    } catch (error) {
      // Accessibility.enable is not available on every target; the rest matter more.
      console.warn(`browser-bridge: ${domain}.enable failed on tab ${tabId}`, error);
    }
  }
  // A tab in a window hidden behind the terminal renders no frames: every input event
  // then waits 5 s for an ack that never comes, wheel events never return, and
  // requestAnimationFrame never fires. Focus emulation makes the renderer treat the
  // page as visible and focused, which is exactly what an unattended agent wants
  // (measured on Edge 153: mouseMoved 5009 ms -> 82 ms, wheel from a hang to 125 ms).
  try {
    await sendRaw(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
  } catch (error) {
    console.warn(`browser-bridge: focus emulation failed on tab ${tabId}`, error);
  }
  await armAutoAttach(tabId, null);
}

/**
 * Flattened auto-attach: every out-of-process iframe of this target, existing and future,
 * reports itself through Target.attachedToTarget with its own sessionId on the same port.
 * Without it the accessibility tree stops at the frame boundary.
 *
 * It is not recursive (verified on Edge 153: a cross-origin frame inside a cross-origin
 * frame never attached until its parent's session asked), so every child session arms it
 * again for its own children. waitForDebuggerOnStart would pause each new frame until we
 * resumed it, which is not worth the risk of a missed resume hanging a page.
 */
async function armAutoAttach(tabId, sessionId) {
  try {
    await sendRaw(
      tabId,
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      sessionId,
    );
  } catch (error) {
    // An old browser, or a target that has no children: cross-origin frames are then
    // simply missing from read_page, which says so.
    console.warn(`browser-bridge: auto-attach failed on tab ${tabId} session ${sessionId}`, error);
  }
}

/**
 * Turn on the domains a child iframe session needs and arm its own auto-attach, once per
 * session. The promise is shared: the attach event starts this immediately so a frame two
 * levels down is usually already attached by the time a tool asks, and a tool that asks
 * first waits for the same work rather than racing it.
 */
export function ensureFrameDomains(tabId, sessionId) {
  const state = stateFor(tabId);
  const existing = state.frameDomains.get(sessionId);
  if (existing) return existing;
  const work = (async () => {
    for (const domain of FRAME_DOMAINS) {
      try {
        await sendRaw(tabId, `${domain}.enable`, {}, sessionId);
      } catch (error) {
        console.warn(`browser-bridge: ${domain}.enable failed on frame session ${sessionId}`, error);
      }
    }
    await armAutoAttach(tabId, sessionId);
  })();
  state.frameDomains.set(sessionId, work);
  return work;
}

/** The tab's attached out-of-process iframe sessions, in attach order. */
export function frameSessions(tabId) {
  const state = peekTab(tabId);
  if (!state) return [];
  return [...state.frameSessions].map(([frameId, sessionId]) => ({ frameId, sessionId }));
}

/** The cache of iframe-element -> frame id lookups for this tab's current document. */
export function frameOwners(tabId) {
  return stateFor(tabId).frameOwners;
}

/**
 * The iframe element that hosts a child session's frame, as
 * `{ sessionId, backendNodeId }` measured in the *parent* session — which is what turns
 * a point inside that frame into a point on the page. Null when nothing has looked the
 * frame up yet (read_page and find fill the cache).
 */
export function frameOwnerFor(tabId, sessionId) {
  const state = peekTab(tabId);
  if (!state || !sessionId) return null;
  const frameId = state.sessionFrames.get(sessionId);
  if (frameId == null) return null;
  return state.frameOwners.get(frameId) ?? null;
}

export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // already gone
  }
  // chrome.debugger.onDetach does not fire for a detach we asked for, and a live view
  // of this tab has just lost its screencast with it.
  for (const listener of ownDetachListeners) {
    try {
      listener(tabId);
    } catch (error) {
      console.warn("browser-bridge: detach listener failed", error);
    }
  }
}

const ownDetachListeners = new Set();

/** Called after this extension detaches a tab itself (see detach). */
export function onOwnDetach(listener) {
  ownDetachListeners.add(listener);
}

/** Attach on demand and retry once if the debugger was detached under us. */
export async function send(tabId, method, params = {}, sessionId = null) {
  await attach(tabId);
  try {
    return await sendRaw(tabId, method, params, sessionId);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/not attached|Detached|target closed/i.test(message)) {
      if (sessionId) {
        // Re-attaching the tab would give the iframe a *new* session id, so the refs
        // pointing into this one are gone either way. Say so instead of retrying.
        throw new Error(
          `${method} failed: the cross-origin iframe session ${sessionId} is gone (${message}). Call read_page or find again.`,
        );
      }
      attached.delete(tabId);
      await attach(tabId);
      return await sendRaw(tabId, method, params);
    }
    throw new Error(`${method} failed: ${message}`);
  }
}

// --- buffers --------------------------------------------------------------

function pushConsole(tabId, entry) {
  const state = stateFor(tabId);
  state.console.push({ ...entry, at: Date.now() });
  if (state.console.length > MAX_CONSOLE) state.console.splice(0, state.console.length - MAX_CONSOLE);
}

function describeArg(arg) {
  if (!arg) return "";
  if (arg.type === "string") return arg.value ?? "";
  if ("value" in arg && arg.value !== undefined) return JSON.stringify(arg.value);
  if (arg.preview) {
    const props = (arg.preview.properties ?? [])
      .map((property) => `${property.name}: ${property.value}`)
      .join(", ");
    return `${arg.preview.description ?? arg.className ?? "Object"}{${props}}`;
  }
  return arg.description ?? arg.className ?? arg.type ?? "";
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** A session and every session that attached from it, deepest first. */
function subtreeOf(state, rootSessionId) {
  const out = [rootSessionId];
  for (let index = 0; index < out.length; index++) {
    for (const [sessionId, parentId] of state.sessionParents) {
      if (parentId === out[index] && !out.includes(sessionId)) out.push(sessionId);
    }
  }
  return out.reverse();
}

function handleEvent(source, method, params) {
  const tabId = source.tabId;
  if (tabId == null) return;
  const state = stateFor(tabId);

  // Target.* is how the tab learns about its out-of-process iframes.
  if (method === "Target.attachedToTarget") {
    const info = params.targetInfo ?? {};
    // Workers, service workers and the like also auto-attach; only frames have an
    // accessibility tree worth splicing, and for a frame target the targetId is the
    // frame id.
    if (info.type !== "iframe" || !params.sessionId || !info.targetId) return;
    state.frameSessions.set(info.targetId, params.sessionId);
    state.sessionFrames.set(params.sessionId, info.targetId);
    // The event arrives on the session the frame attached from, which for a nested
    // out-of-process frame is another child session, not the tab's own.
    state.sessionParents.set(params.sessionId, source.sessionId ?? null);
    // Set the new session up right away: that is what arms auto-attach inside it, and
    // its own children cannot attach until it does.
    ensureFrameDomains(tabId, params.sessionId).catch((error) =>
      console.warn(`browser-bridge: could not set up frame session ${params.sessionId}`, error),
    );
    return;
  }
  if (method === "Target.detachedFromTarget") {
    if (!params.sessionId) return;
    // A frame that goes takes everything inside it: the browser does not always report a
    // detach for each descendant, and a grandchild session left behind would be asked for
    // a tree that no longer exists.
    for (const sessionId of subtreeOf(state, params.sessionId)) {
      const frameId = state.sessionFrames.get(sessionId);
      state.sessionFrames.delete(sessionId);
      state.frameDomains.delete(sessionId);
      state.sessionParents.delete(sessionId);
      if (frameId != null) {
        state.frameSessions.delete(frameId);
        state.frameOwners.delete(frameId);
      }
      // Refs that pointed into that frame cannot be resolved any more; they are kept as
      // known-but-detached so the error names the reason instead of "unknown ref".
      state.refs.invalidateSession(sessionId);
    }
    return;
  }

  // Everything below is about the page the session owns. An event from a child iframe
  // session carries its sessionId, and its console, network and navigation belong to
  // that frame, not to the tab's buffers.
  if (source.sessionId) return;

  switch (method) {
    case "Runtime.consoleAPICalled": {
      const frame = params.stackTrace?.callFrames?.[0];
      pushConsole(tabId, {
        level: params.type,
        text: (params.args ?? []).map(describeArg).join(" "),
        url: frame?.url ?? null,
        line: frame ? frame.lineNumber + 1 : null,
      });
      break;
    }
    case "Runtime.exceptionThrown": {
      const details = params.exceptionDetails ?? {};
      pushConsole(tabId, {
        level: "error",
        text:
          details.exception?.description ??
          details.exception?.value ??
          details.text ??
          "uncaught exception",
        url: details.url ?? null,
        line: details.lineNumber != null ? details.lineNumber + 1 : null,
      });
      break;
    }
    case "Log.entryAdded": {
      const entry = params.entry ?? {};
      pushConsole(tabId, {
        level: entry.level ?? "log",
        text: entry.text ?? "",
        url: entry.url ?? null,
        line: entry.lineNumber != null ? entry.lineNumber + 1 : null,
      });
      break;
    }
    case "Network.requestWillBeSent": {
      const record = {
        requestId: params.requestId,
        method: params.request?.method ?? "GET",
        url: params.request?.url ?? "",
        resourceType: params.type ?? "Other",
        status: null,
        mimeType: null,
        encodedDataLength: null,
        startedAt: params.timestamp,
        durationMs: null,
        error: null,
      };
      state.network.push(record);
      state.networkById.set(params.requestId, record);
      if (state.network.length > MAX_NETWORK) {
        const dropped = state.network.splice(0, state.network.length - MAX_NETWORK);
        for (const item of dropped) state.networkById.delete(item.requestId);
      }
      break;
    }
    case "Network.responseReceived": {
      const record = state.networkById.get(params.requestId);
      if (!record) break;
      record.status = params.response?.status ?? null;
      record.mimeType = params.response?.mimeType ?? null;
      record.resourceType = params.type ?? record.resourceType;
      break;
    }
    case "Network.loadingFinished": {
      const record = state.networkById.get(params.requestId);
      if (!record) break;
      record.encodedDataLength = params.encodedDataLength ?? record.encodedDataLength;
      record.durationMs = Math.round((params.timestamp - record.startedAt) * 1000);
      break;
    }
    case "Network.loadingFailed": {
      const record = state.networkById.get(params.requestId);
      if (!record) break;
      record.error = params.errorText ?? "failed";
      record.durationMs = Math.round((params.timestamp - record.startedAt) * 1000);
      break;
    }
    case "Page.frameNavigated": {
      if (params.frame?.parentId) break; // subframe: refs and buffers still apply
      // Backend node ids do not survive a document swap, and neither do the iframe
      // elements the frame trees were spliced under.
      state.refs.reset();
      state.frameOwners.clear();
      const origin = originOf(params.frame?.url ?? "");
      if (origin && state.origin && origin !== state.origin) {
        state.console.length = 0;
        state.network.length = 0;
        state.networkById.clear();
      }
      state.origin = origin;
      break;
    }
    default:
      break;
  }
}

let listenersInstalled = false;

export function installListeners() {
  if (listenersInstalled) return;
  listenersInstalled = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    try {
      handleEvent(source, method, params ?? {});
    } catch (error) {
      console.error("browser-bridge: CDP event handler failed", method, error);
    }
  });
  chrome.debugger.onDetach.addListener((source) => {
    // The user hit "Cancel" on the infobar, or the tab went away. Either way the next
    // command re-attaches instead of failing.
    if (source.tabId != null) attached.delete(source.tabId);
  });
}
