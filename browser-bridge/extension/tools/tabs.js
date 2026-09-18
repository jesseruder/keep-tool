// tabs_context_mcp, tabs_create_mcp, tabs_close_mcp, resize_window.

import { attach, dropTab, detach } from "../lib/cdp.js";
import { ensureGroup, requireTab, tabsInGroup } from "../lib/sessions.js";

function contextText(context) {
  return JSON.stringify(context, null, 2);
}

async function attachQuietly(tabId) {
  // Attaching as soon as the tab exists is what makes page-load console and network
  // events visible; a failure here must not fail the tool.
  try {
    await attach(tabId);
  } catch (error) {
    console.warn("browser-bridge: eager attach failed", tabId, error.message);
  }
}

export async function tabs_context_mcp(ctx, params = {}) {
  const group = await ensureGroup(ctx.sessionKey, {
    name: ctx.sessionName,
    createIfEmpty: Boolean(params.createIfEmpty),
    newWindow: Boolean(params.newWindow),
  });
  if (!group) {
    const context = { groupId: null, windowId: null, tabs: [] };
    return {
      text: `No tab group for this session yet.\n${contextText(context)}`,
      context,
    };
  }
  for (const tab of group.tabs) await attachQuietly(tab.id);
  const context = {
    groupId: group.groupId,
    windowId: group.windowId,
    name: group.name ?? ctx.sessionName,
    tabs: group.tabs.map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      active: tab.active,
    })),
  };
  return { text: contextText(context), context };
}

export async function tabs_create_mcp(ctx) {
  const group = await ensureGroup(ctx.sessionKey, {
    name: ctx.sessionName,
    createIfEmpty: true,
  });
  const created = await chrome.tabs.create({
    windowId: group.windowId,
    url: "about:blank",
    active: false,
  });
  await chrome.tabs.group({ tabIds: [created.id], groupId: group.groupId });
  await attachQuietly(created.id);
  const context = {
    groupId: group.groupId,
    windowId: group.windowId,
    tabs: await tabsInGroup(group.groupId),
  };
  return { text: JSON.stringify({ tabId: created.id, ...context }, null, 2), tabId: created.id };
}

export async function tabs_close_mcp(ctx, params = {}) {
  const tab = await requireTab(ctx.sessionKey, params.tabId);
  await detach(tab.id);
  dropTab(tab.id);
  await chrome.tabs.remove(tab.id);
  return { text: `Closed tab ${tab.id}.` };
}

export async function resize_window(ctx, params = {}) {
  const tab = await requireTab(ctx.sessionKey, params.tabId);
  const width = Math.round(Number(params.width));
  const height = Math.round(Number(params.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 100 || height < 100) {
    throw new Error("width and height must be numbers of at least 100 pixels");
  }
  const window = await chrome.windows.update(tab.windowId, { width, height, state: "normal" });
  return {
    text: `Window ${window.id} is now ${window.width}x${window.height} at (${window.left}, ${window.top}).`,
  };
}
