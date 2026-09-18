// Popup: is the native host up, and which sessions hold tab groups right now.

const stateEl = document.getElementById("state");
const detailEl = document.getElementById("detail");
const sessionsEl = document.getElementById("sessions");
const versionEl = document.getElementById("version");

function render(status) {
  if (!status || status.error) {
    stateEl.textContent = "unavailable";
    stateEl.className = "state disconnected";
    detailEl.textContent = status?.error ?? "the service worker did not answer";
    return;
  }
  versionEl.textContent = `v${status.version}`;
  const connected = status.native?.connected;
  stateEl.textContent = connected ? "connected" : "disconnected";
  stateEl.className = `state ${connected ? "connected" : "disconnected"}`;
  detailEl.textContent = connected
    ? `since ${new Date(status.native.connectedAt).toLocaleTimeString()}`
    : (status.native?.lastError ?? "no native host; run the installer, then reconnect");

  sessionsEl.replaceChildren();
  if (!status.sessions?.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No agent sessions right now.";
    sessionsEl.append(li);
    return;
  }
  for (const session of status.sessions) {
    const li = document.createElement("li");
    const name = document.createElement("div");
    name.textContent = session.name ?? session.sessionKey.slice(0, 8);
    const meta = document.createElement("div");
    meta.className = "muted";
    meta.textContent =
      session.groupId == null
        ? "no tab group"
        : `group ${session.groupId} · ${session.tabCount} tab${session.tabCount === 1 ? "" : "s"}`;
    li.append(name, meta);
    sessionsEl.append(li);
  }
}

function refresh() {
  chrome.runtime.sendMessage({ type: "status" }, (response) => {
    if (chrome.runtime.lastError) {
      render({ error: chrome.runtime.lastError.message });
      return;
    }
    render(response);
  });
}

document.getElementById("reconnect").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 400));
});

refresh();
setInterval(refresh, 2000);
