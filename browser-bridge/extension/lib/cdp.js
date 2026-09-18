// chrome.debugger plumbing: attach per tab, send CDP commands, and keep the console and
// network buffers the read_* tools serve.
//
// Everything here is in-memory. A service worker restart loses the buffers; the tools
// say so rather than pretending the page was quiet.

import { RefTable } from "./ax.js";

const PROTOCOL_VERSION = "1.3";
const MAX_CONSOLE = 2000;
const MAX_NETWORK = 2000;
const DOMAINS = ["Runtime", "Log", "Network", "Page", "DOM", "Accessibility"];

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

export async function sendRaw(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
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
}

export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // already gone
  }
}

/** Attach on demand and retry once if the debugger was detached under us. */
export async function send(tabId, method, params = {}) {
  await attach(tabId);
  try {
    return await sendRaw(tabId, method, params);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/not attached|Detached|target closed/i.test(message)) {
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

function handleEvent(source, method, params) {
  const tabId = source.tabId;
  if (tabId == null) return;
  const state = stateFor(tabId);

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
      // Backend node ids do not survive a document swap.
      state.refs.reset();
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
