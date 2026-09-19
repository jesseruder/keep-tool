// The shared streamable-HTTP daemon, on port 0 against a fake native host.
//
// Nothing here touches a browser, a real port or launchd. The MCP client is the SDK's
// own, so the session handshake, the session-id header and the SSE framing are the real
// thing; the plain refusals (401, 403, 404) are checked with fetch, because a compliant
// client cannot produce them.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { LineDecoder, encodeLine } from "../host/protocol.js";
import {
  IDLE_TIMEOUT_MS,
  MAX_LIVE_SESSIONS,
  STREAM_LOSS_IDLE_MS,
  createDaemon,
  sanitizeHeaderValue,
} from "../mcp/daemon.js";
import { deriveRegistryKey, deriveSessionKey } from "../mcp/identity.js";
import { TOOL_NAMES } from "../mcp/tools.js";

const DAEMON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp", "daemon.js");
const TOKEN = "f".repeat(64);
/** What session keys are derived from. Never sent anywhere; see mcp/identity.js. */
const SECRET = "a1b2c3d4".repeat(8);

/** A host stand-in on the bridge socket: records every line, answers what it is told. */
function fakeHost(t, dir, handler = defaultHandler) {
  const received = [];
  const sockets = [];
  const closed = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    const decoder = new LineDecoder();
    socket.on("error", () => {});
    socket.on("close", () => closed.push(socket));
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        received.push(message);
        const reply = handler(message, socket);
        if (reply) socket.write(encodeLine({ id: message.id, ...reply }));
      }
    });
  });
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return new Promise((resolve) => {
    server.listen(path.join(dir, "bridge.sock"), () =>
      resolve({ received, sockets, closed, hellos: () => received.filter((m) => m.method === "hello") }),
    );
  });
}

const HOST_STATUS = {
  hostPid: 4242,
  extensionConnected: true,
  extensionVersion: "0.1.0",
  sessions: [{ name: "somebody else" }],
};

function defaultHandler(message) {
  if (message.method === "hello" || message.method === "host_status") {
    return { ok: true, result: HOST_STATUS };
  }
  if (message.method === "bye") return { ok: true, result: { ok: true } };
  return { ok: true, result: { text: `ran ${message.method}` } };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-daemon-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A daemon listening on a free port, its runtime dir pointed at `dir`. */
async function startDaemon(t, dir, options = {}) {
  const logs = [];
  const daemon = createDaemon({
    token: TOKEN,
    secret: SECRET,
    env: { ...process.env, BROWSER_BRIDGE_RUNTIME_DIR: dir },
    log: (line) => logs.push(line),
    ...options,
  });
  const port = await daemon.listen(0);
  t.after(() => daemon.shutdown("test over"));
  return { daemon, port, logs, base: `http://127.0.0.1:${port}` };
}

async function connectClient(t, port, headers = {}) {
  const client = new Client({ name: "daemon-test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}`, ...headers } },
  });
  await client.connect(transport);
  t.after(() => client.close().catch(() => {}));
  return { client, transport };
}

/** One raw HTTP request on the daemon's port, so headers fetch() will not send can be set. */
function rawRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(request));
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

test("a header names the session, and the host's hello carries that name", async (t) => {
  const dir = tempDir(t);
  const host = await fakeHost(t, dir);
  const { port, logs } = await startDaemon(t, dir);

  const { client, transport } = await connectClient(t, port, {
    "X-Browser-Bridge-Session": "#12 fix-login",
    "X-Browser-Bridge-Agent": "claude",
    "X-Browser-Bridge-Account": "claude-tertiary",
  });
  assert.ok(transport.sessionId, "the daemon hands out an Mcp-Session-Id");

  // The socket client only connects on the first tool call, as it always has.
  const status = await client.callTool({ name: "browser_status", arguments: {} });
  assert.match(status.content[0].text, /Session: #12 fix-login/);

  const hello = host.hellos().at(-1);
  assert.equal(hello.params.name, "#12 fix-login");
  assert.equal(hello.params.agent, "claude");
  assert.equal(hello.params.account, "claude-tertiary");
  // Derived from the session id under daemon.json's secret, not stored anywhere.
  assert.equal(hello.params.sessionKey, deriveSessionKey(SECRET, transport.sessionId));

  assert.ok(
    logs.some((line) => line.includes("session start") && line.includes("fix-login")),
    logs.join("\n"),
  );
});

test("without the header the session is named after the client, numbered", async (t) => {
  const dir = tempDir(t);
  const host = await fakeHost(t, dir);
  const { port } = await startDaemon(t, dir);

  const first = await connectClient(t, port);
  await first.client.callTool({ name: "browser_status", arguments: {} });
  const second = await connectClient(t, port);
  await second.client.callTool({ name: "browser_status", arguments: {} });

  const names = host.hellos().map((message) => message.params.name);
  assert.deepEqual(names, ["daemon-test #1", "daemon-test #2"]);
  // Nothing was claimed about the agent, so nothing is invented.
  assert.equal(host.hellos()[0].params.agent, null);
});

test("tools/list is the whole contract and a call is forwarded to the host", async (t) => {
  const dir = tempDir(t);
  const host = await fakeHost(t, dir, (message) => {
    if (message.method === "hello") return defaultHandler(message);
    if (message.method === "read_page") return { ok: true, result: { text: "[ref_1] button \"Sign in\"" } };
    return { ok: false, error: { message: `unexpected ${message.method}` } };
  });
  const { port } = await startDaemon(t, dir);
  const { client } = await connectClient(t, port, { "X-Browser-Bridge-Session": "lister" });

  const list = await client.listTools();
  assert.deepEqual(
    list.tools.map((tool) => tool.name).sort(),
    [...TOOL_NAMES].sort(),
  );
  const readPage = list.tools.find((tool) => tool.name === "read_page");
  assert.deepEqual(readPage.inputSchema.required, ["tabId"]);
  assert.deepEqual(readPage.inputSchema.properties.filter.enum, ["interactive", "all"]);

  const call = await client.callTool({ name: "read_page", arguments: { tabId: 7 } });
  assert.notEqual(call.isError, true);
  assert.match(call.content[0].text, /Sign in/);
  const forwarded = host.received.find((message) => message.method === "read_page");
  assert.equal(forwarded.params.tabId, 7);

  // The validation lives in session.js and still runs on this path.
  const bad = await client.callTool({ name: "read_console_messages", arguments: { tabId: 5, clear: "false" } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /clear must be boolean/);
});

test("two sessions get two session ids and two socket clients", async (t) => {
  const dir = tempDir(t);
  const host = await fakeHost(t, dir);
  const { port, daemon } = await startDaemon(t, dir);

  const a = await connectClient(t, port, { "X-Browser-Bridge-Session": "session A" });
  const b = await connectClient(t, port, { "X-Browser-Bridge-Session": "session B" });
  assert.notEqual(a.transport.sessionId, b.transport.sessionId);
  assert.equal(daemon.sessions.size, 2);

  await a.client.callTool({ name: "browser_status", arguments: {} });
  await b.client.callTool({ name: "browser_status", arguments: {} });

  const hellos = host.hellos();
  assert.deepEqual(
    hellos.map((message) => message.params.name),
    ["session A", "session B"],
  );
  assert.notEqual(hellos[0].params.sessionKey, hellos[1].params.sessionKey, "two sessions, two keys");
  assert.equal(host.sockets.length, 2, "one socket connection per MCP session");
});

test("healthz answers without a token and never opens a socket of its own", async (t) => {
  const dir = tempDir(t);
  await fakeHost(t, dir);
  const { port, base } = await startDaemon(t, dir);

  const empty = await (await fetch(`${base}/healthz`)).json();
  assert.equal(empty.ok, true);
  assert.equal(empty.sessions, 0);
  assert.equal(empty.host.extensionConnected, null, "nothing has spoken to the host yet");
  assert.equal(empty.host.socket, path.join(dir, "bridge.sock"));

  const { client } = await connectClient(t, port, { "X-Browser-Bridge-Session": "healthy" });
  await client.callTool({ name: "browser_status", arguments: {} });
  const filled = await (await fetch(`${base}/healthz`)).json();
  assert.equal(filled.sessions, 1);
  assert.equal(filled.host.connected, 1);
  assert.equal(filled.host.extensionConnected, true);
  assert.equal(filled.host.extensionVersion, "0.1.0");
  assert.equal(filled.port, port);
});

test("a missing or wrong token is 401 and no session is created", async (t) => {
  const dir = tempDir(t);
  await fakeHost(t, dir);
  const { base, daemon } = await startDaemon(t, dir);

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } },
  });
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

  for (const auth of [null, "Bearer wrong", `Bearer ${TOKEN}x`, "Basic abc", `bearer ${TOKEN.slice(0, 10)}`]) {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: auth ? { ...headers, Authorization: auth } : headers,
      body,
    });
    assert.equal(response.status, 401, `auth ${auth}`);
    const payload = await response.json();
    assert.equal(payload.error.code, -32000);
    assert.match(payload.error.message, /Bearer token/);
  }
  assert.equal(daemon.sessions.size, 0);

  // The same request with the right token, lower-cased scheme and all, does initialize.
  const ok = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...headers, Authorization: `bearer ${TOKEN}` },
    body,
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.headers.get("mcp-session-id"));
});

test("any Origin header is 403, with no CORS headers anywhere", async (t) => {
  const dir = tempDir(t);
  await fakeHost(t, dir);
  const { base, daemon } = await startDaemon(t, dir);

  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
      Origin: "https://evil.example",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error.message, /Origin header is not accepted/);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(daemon.sessions.size, 0);

  // Even a same-origin-looking value is refused: a CLI never sends one at all.
  const loopback = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
      Origin: base,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(loopback.status, 403);
});

test("a Host header that is not the loopback daemon is refused", async (t) => {
  const dir = tempDir(t);
  await fakeHost(t, dir);
  const { port, daemon } = await startDaemon(t, dir);

  // fetch() will not let a Host header through, so this one goes over a raw socket.
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } },
  });
  const raw = await new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `POST /mcp HTTP/1.1\r\nHost: evil.example\r\nAuthorization: Bearer ${TOKEN}\r\n` +
          `Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
  assert.match(raw, /^HTTP\/1\.1 403/);
  assert.match(raw, /Invalid Host header/);
  assert.equal(daemon.sessions.size, 0, "a refused initialize leaves nothing behind");
});

test("an unknown session id is adopted, not refused", async (t) => {
  const dir = tempDir(t);
  const host = await fakeHost(t, dir);
  const { port, base, daemon, logs } = await startDaemon(t, dir);

  // A 404 here would be fatal rather than recoverable: the SDK's client throws
  // `Session not found` and never clears its session id, so that agent's browser access is
  // gone for good - and `node bin/install.js` restarts this daemon on every landing.
  const call = await rpc(
    port,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_status", arguments: {} } },
    { sessionId: "a-session-from-a-daemon-that-has-restarted", headers: { "X-Browser-Bridge-Session": "survivor" } },
  );
  assert.equal(call.response.status, 200);
  assert.match(JSON.stringify(call.message), /Session: survivor/);
  assert.equal(daemon.sessions.size, 1);
  assert.ok(
    logs.some((line) => line.includes("session adopted") && line.includes("labels=from the request")),
    logs.join("\n"),
  );

  // It is a real session: it talks to the host under a key of its own.
  const hello = host.hellos().at(-1);
  assert.equal(hello.params.name, "survivor");
  assert.equal(hello.params.sessionKey, deriveSessionKey(SECRET, "a-session-from-a-daemon-that-has-restarted"));

  // A request with no session id at all is still a 400, not a silent new session.
  const bare = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  assert.equal(bare.status, 400);
});

test("a restarted daemon gives an adopted session the sessionKey it had", async (t) => {
  const dir = tempDir(t);
  const host = await fakeHost(t, dir);

  // One daemon, one session, one tool call: the host learns its sessionKey.
  const first = await startDaemon(t, dir);
  const sessionId = await rawSession(first.port, "#12 fix-login");
  const firstKey = host.hellos().at(-1).params.sessionKey;
  await first.daemon.shutdown("restarting for a landing");

  // A second daemon over the same runtime directory - which is what `kickstart -k` does -
  // and the client carries on with the id it already has.
  const second = await startDaemon(t, dir);
  // Nothing was looked up: the key is an HMAC of the id under daemon.json's secret, so the
  // same id gives the same key with no stored mapping to steal or to lose.
  assert.equal(firstKey, deriveSessionKey(SECRET, sessionId));
  assert.equal(second.daemon.registry.get(deriveRegistryKey(SECRET, sessionId)).name, "#12 fix-login");

  const call = await rpc(
    second.port,
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "browser_status", arguments: {} } },
    { sessionId, headers: { "X-Browser-Bridge-Session": "#12 fix-login" } },
  );
  assert.equal(call.response.status, 200);
  assert.equal(
    host.hellos().at(-1).params.sessionKey,
    firstKey,
    "the same key, so the extension hands back the tab group instead of opening a second one",
  );
  assert.ok(second.logs.some((line) => line.includes("session adopted") && line.includes("labels=remembered")));
});

test("a session ended early is revived with its old sessionKey", async (t) => {
  const dir = tempDir(t);
  const host = await fakeHost(t, dir);
  let clock = 2_000;
  const { port, daemon, logs } = await startDaemon(t, dir, { now: () => clock });

  const sessionId = await rawSession(port, "came back");
  const stream = await openStream(port, sessionId);
  await settle();
  stream.close();
  await settle();
  const originalKey = host.hellos().at(-1).params.sessionKey;

  // The stream-loss rule fires while the agent is merely asleep.
  assert.deepEqual(await daemon.sweep(clock + STREAM_LOSS_IDLE_MS), [sessionId]);
  assert.equal(daemon.sessions.size, 0);
  const tomb = daemon.registry.get(deriveRegistryKey(SECRET, sessionId));
  assert.ok(tomb.ended > 0, "a tombstone, not a deletion");
  assert.equal(tomb.endedBy, "daemon", "the sweep ended it, so it may be adopted back");

  // The laptop wakes up and the agent carries on with the id it has.
  clock += 1_000;
  const call = await rpc(
    port,
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "browser_status", arguments: {} } },
    { sessionId, headers: { "X-Browser-Bridge-Session": "came back" } },
  );
  assert.equal(call.response.status, 200);
  assert.equal(host.hellos().at(-1).params.sessionKey, originalKey, "its own tabs, not a second group");
  assert.ok(logs.some((line) => line.includes("labels=remembered (ended)")));
});

test("the registry file is private, atomic and pruned", async (t) => {
  const dir = tempDir(t);
  await fakeHost(t, dir);
  let clock = 2_000;
  const { port, daemon } = await startDaemon(t, dir, { now: () => clock });

  const sessionId = await rawSession(port, "on disk");
  daemon.registry.flush();

  const file = path.join(dir, "sessions.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const text = fs.readFileSync(file, "utf8");

  // The file holds no session key and no session id. Storing keys meant any local reader -
  // an agent told to `cat` something by a page it was reading - could hello on the socket as
  // somebody else and drive their tab group.
  assert.equal(text.includes(sessionId), false, "not even the id is in there");
  assert.equal(text.includes(deriveSessionKey(SECRET, sessionId)), false, "and certainly not the key");
  assert.deepEqual(Object.keys(saved.sessions), [deriveRegistryKey(SECRET, sessionId)]);
  const entry = saved.sessions[deriveRegistryKey(SECRET, sessionId)];
  assert.equal(entry.name, "on disk");
  assert.equal("sessionKey" in entry, false);
  assert.equal(fs.existsSync(`${file}.tmp`), false, "the tmp file is renamed over, not left behind");

  // A day of silence ends the session, and the entry stays as a tombstone: the client may
  // still come back with that id, and then it needs this key to find its own tabs.
  clock += 25 * 60 * 60 * 1000;
  assert.deepEqual(await daemon.sweep(clock), [sessionId]);
  assert.ok(daemon.registry.get(deriveRegistryKey(SECRET, sessionId)).ended > 0);

  // A day after *that*, nothing is coming back for it.
  clock += 25 * 60 * 60 * 1000;
  await daemon.sweep(clock);
  assert.equal(daemon.registry.get(deriveRegistryKey(SECRET, sessionId)), null);
  daemon.registry.flush();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).sessions, {});
});

test("DELETE closes the session's socket client", async (t) => {
  const dir = tempDir(t);
  const host = await fakeHost(t, dir);
  const { port, daemon, logs } = await startDaemon(t, dir);

  const { client, transport } = await connectClient(t, port, { "X-Browser-Bridge-Session": "leaving" });
  await client.callTool({ name: "browser_status", arguments: {} });
  assert.equal(daemon.sessions.size, 1);

  await transport.terminateSession();
  // endSession runs from the DELETE handler; give the bye a turn to land.
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(daemon.sessions.size, 0);
  assert.equal(host.received.at(-1).method, "bye", "the host is told, so it emits session_closed");
  assert.ok(logs.some((line) => line.includes("session end") && line.includes("client closed")));
});

/**
 * One JSON-RPC round trip over raw HTTP. These tests cannot use the SDK client, because it
 * opens the standalone GET stream itself and the daemon's second one is then a 409 - which
 * is itself the proof that a client holds exactly one. Claude Code's shape is POSTs plus
 * one long-lived GET, and that is what this builds.
 */
async function rpc(port, body, { sessionId, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "Mcp-Session-Id": sessionId, "Mcp-Protocol-Version": "2025-06-18" } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const id = response.headers.get("mcp-session-id");
  if (response.status === 202) return { response, sessionId: id, message: null };
  const text = await response.text();
  // An answer arrives as an SSE frame; a refusal (401/403/404/503) is plain JSON.
  const data = text.split("\n").find((line) => line.startsWith("data:"));
  let message = null;
  if (data) message = JSON.parse(data.slice(5).trim());
  else if (text.trim().startsWith("{")) message = JSON.parse(text);
  return { response, sessionId: id, message };
}

/** A session in the state Claude Code leaves one in: initialized and in use, no stream yet. */
async function rawSession(port, name) {
  const init = await rpc(
    port,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
    },
    { headers: { "X-Browser-Bridge-Session": name } },
  );
  assert.equal(init.response.status, 200);
  const sessionId = init.sessionId;
  await rpc(port, { jsonrpc: "2.0", method: "notifications/initialized" }, { sessionId });
  // One tool call, so the BridgeClient is actually connected and a `bye` is observable.
  const call = await rpc(
    port,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_status", arguments: {} } },
    { sessionId },
  );
  assert.notEqual(call.message, null);
  return sessionId;
}

/**
 * Open the standalone GET event stream the way a real client does, and hand back a way to
 * drop it. Claude Code holds this open for the whole session and never sends DELETE, so it
 * is the only signal that its agent has gone.
 */
async function openStream(port, sessionId, accept = "text/event-stream") {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: accept,
      "Mcp-Session-Id": sessionId,
      "Mcp-Protocol-Version": "2025-06-18",
    },
    signal: controller.signal,
  });
  return { response, close: () => controller.abort() };
}

/** The server's `close` handler runs on its own turn; let it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("a client that drops its event stream and then goes quiet is closed", async (t) => {
  const dir = tempDir(t);
  const host = await fakeHost(t, dir);
  let clock = 2_000;
  const { port, daemon, logs } = await startDaemon(t, dir, { now: () => clock });

  const sessionId = await rawSession(port, "no delete");
  const stream = await openStream(port, sessionId);
  assert.equal(stream.response.status, 200);
  await settle();
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).streams, 1);

  // While the stream is open nothing expires, however long the grace has been - and not
  // the idle clock either: a session holding a stream open all day is not abandoned, and
  // ending it would cost it the tab group it is still using.
  assert.deepEqual(await daemon.sweep(clock + STREAM_LOSS_IDLE_MS * 10), []);
  assert.deepEqual(await daemon.sweep(clock + IDLE_TIMEOUT_MS * 3), [], "an open stream is not idle");
  assert.equal(daemon.sessions.size, 1);

  stream.close();
  await settle();
  assert.deepEqual(await daemon.sweep(clock + STREAM_LOSS_IDLE_MS - 1), [], "ten minutes is not up yet");
  assert.equal(daemon.sessions.size, 1);

  const ended = await daemon.sweep(clock + STREAM_LOSS_IDLE_MS);
  assert.equal(ended.length, 1);
  assert.equal(daemon.sessions.size, 0);
  assert.equal(host.received.at(-1).method, "bye", "the host is told, so the tab group stops being live");
  assert.ok(logs.some((line) => line.includes("nothing on the wire for 10 minutes")), logs.join("\n"));
});

test("a request after the stream is gone keeps the session alive", async (t) => {
  const dir = tempDir(t);
  await fakeHost(t, dir);
  let clock = 2_000;
  const { port, daemon } = await startDaemon(t, dir, { now: () => clock });

  const sessionId = await rawSession(port, "sleeping laptop");
  const stream = await openStream(port, sessionId);
  await settle();
  stream.close();
  await settle();

  // The SDK client stops reconnecting its stream after two tries, so a live session can
  // simply have no stream. What says it is alive is that it keeps making requests.
  for (let step = 0; step < 3; step++) {
    clock += STREAM_LOSS_IDLE_MS - 1_000;
    await rpc(port, { jsonrpc: "2.0", id: 20 + step, method: "tools/list", params: {} }, { sessionId });
    assert.deepEqual(await daemon.sweep(clock + STREAM_LOSS_IDLE_MS - 1), [], "still in use");
    assert.equal(daemon.sessions.size, 1);
  }
  // Only once it goes quiet for the whole ten minutes does it end.
  assert.deepEqual(await daemon.sweep(clock + STREAM_LOSS_IDLE_MS), [sessionId]);
});

test("a session is never ended out from under a tool call", async (t) => {
  const dir = tempDir(t);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  // A host that does not answer read_page until the test lets it.
  const host = await fakeHost(t, dir, (message, socket) => {
    if (message.method === "hello" || message.method === "host_status") return { ok: true, result: HOST_STATUS };
    if (message.method === "bye") return { ok: true, result: {} };
    if (message.method === "read_page") {
      void held.then(() => socket.write(encodeLine({ id: message.id, ok: true, result: { text: "late" } })));
      return null;
    }
    return { ok: true, result: { text: "ok" } };
  });
  let clock = 2_000;
  const { port, daemon } = await startDaemon(t, dir, { now: () => clock });

  const sessionId = await rawSession(port, "mid call");
  const stream = await openStream(port, sessionId);
  await settle();
  stream.close();
  await settle();

  const pending = rpc(
    port,
    { jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "read_page", arguments: { tabId: 1 } } },
    { sessionId },
  );
  await settle();

  // Everything says this session should be swept, except that it is in the middle of a call.
  assert.deepEqual(await daemon.sweep(clock + IDLE_TIMEOUT_MS * 2), [], "a call is in flight");
  assert.equal(daemon.sessions.size, 1);

  release();
  const answer = await pending;
  assert.match(JSON.stringify(answer.message), /late/);
  await settle();
  // And now it can be.
  assert.deepEqual(await daemon.sweep(clock + IDLE_TIMEOUT_MS * 2), [sessionId]);
  assert.equal(host.received.at(-1).method, "bye");
});

test("a stream reopened before the ten minutes are up keeps the session", async (t) => {
  const dir = tempDir(t);
  await fakeHost(t, dir);
  let clock = 2_000;
  const { port, daemon } = await startDaemon(t, dir, { now: () => clock });

  const sessionId = await rawSession(port, "reconnector");

  const first = await openStream(port, sessionId);
  first.close();
  await settle();

  // The client comes back before the grace runs out, which is what an SSE reconnect is.
  clock += 1_000;
  const second = await openStream(port, sessionId);
  assert.equal(second.response.status, 200);
  await settle();
  assert.deepEqual(
    await daemon.sweep(clock + STREAM_LOSS_IDLE_MS + 1),
    [],
    "an open stream is enough on its own, however long ago the last request was",
  );
  assert.equal(daemon.sessions.size, 1);

  // A plain request counts as coming back too, and pushes the ten minutes out from there.
  second.close();
  await settle();
  clock += 1_000;
  await rpc(port, { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }, { sessionId });
  assert.deepEqual(await daemon.sweep(clock + STREAM_LOSS_IDLE_MS - 1), []);
  assert.equal(daemon.sessions.size, 1);
  assert.deepEqual(await daemon.sweep(clock + STREAM_LOSS_IDLE_MS), [sessionId], "and then it is quiet enough");
});

test("a session that never opened a stream is left to the idle clock", async (t) => {
  const dir = tempDir(t);
  await fakeHost(t, dir);
  let clock = 2_000;
  const { port, daemon } = await startDaemon(t, dir, { now: () => clock });

  await rawSession(port, "no stream");

  // Codex does not hold a stream open, so the grace must never apply to it.
  assert.deepEqual(await daemon.sweep(clock + STREAM_LOSS_IDLE_MS * 100), []);
  assert.equal(daemon.sessions.size, 1);
  const [id] = [...daemon.sessions.keys()];
  assert.deepEqual(await daemon.sweep(clock + IDLE_TIMEOUT_MS + 1), [id], "only the idle clock can end it");
});

test("a GET the SDK refuses does not make a session look like one that streams", async (t) => {
  const dir = tempDir(t);
  await fakeHost(t, dir);
  let clock = 2_000;
  const { port, daemon } = await startDaemon(t, dir, { now: () => clock });

  const sessionId = await rawSession(port, "bad get");

  // No text/event-stream in Accept: the SDK refuses (406) and never opens a stream.
  const refused = await openStream(port, sessionId, "application/json");
  assert.equal(refused.response.status, 406);
  await refused.response.text();
  await settle();

  assert.equal((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).streams, 0);
  assert.deepEqual(await daemon.sweep(clock + STREAM_LOSS_IDLE_MS + 1), [], "a refused GET is not a lost stream");
  assert.equal(daemon.sessions.size, 1);

  // And a second GET while a stream is already open is a 409 that must not disturb the
  // count either: closing it would otherwise look like the real stream going away.
  const real = await openStream(port, sessionId);
  assert.equal(real.response.status, 200);
  await settle();
  const second = await openStream(port, sessionId);
  assert.equal(second.response.status, 409);
  await second.response.text();
  await settle();
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).streams, 1);
  assert.deepEqual(await daemon.sweep(clock + STREAM_LOSS_IDLE_MS + 1), [], "the real stream is still open");

  real.close();
  await settle();
  assert.deepEqual(await daemon.sweep(clock + STREAM_LOSS_IDLE_MS), [sessionId], "now it is gone");
});

test("a session idle for a day is closed the same way, on a fake clock", async (t) => {
  const dir = tempDir(t);
  const host = await fakeHost(t, dir);
  let clock = 1_000_000;
  const { port, daemon, logs } = await startDaemon(t, dir, { now: () => clock });

  // A raw session, with no event stream: the idle clock is the only thing that can end it,
  // and the SDK client would open a stream and hand it to the grace instead.
  await rawSession(port, "sleeper");
  assert.equal(daemon.sessions.size, 1);

  assert.deepEqual(await daemon.sweep(clock + IDLE_TIMEOUT_MS), [], "not yet");
  assert.equal(daemon.sessions.size, 1);

  const expired = await daemon.sweep(clock + IDLE_TIMEOUT_MS + 1);
  assert.equal(expired.length, 1);
  assert.equal(daemon.sessions.size, 0);
  assert.equal(host.received.at(-1).method, "bye");
  assert.ok(logs.some((line) => line.includes("idle for 24 hours")));
});

test("every request pushes the idle deadline out", async (t) => {
  const dir = tempDir(t);
  await fakeHost(t, dir);
  let clock = 5_000;
  const { port, daemon } = await startDaemon(t, dir, { now: () => clock });

  const sessionId = await rawSession(port, "busy but slow");
  clock += IDLE_TIMEOUT_MS - 1;
  await rpc(port, { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }, { sessionId });
  assert.deepEqual(await daemon.sweep(clock + IDLE_TIMEOUT_MS), [], "the tools/list reset the clock");
  assert.equal(daemon.sessions.size, 1);
});

test("a body over the cap is refused before it is parsed", async (t) => {
  const dir = tempDir(t);
  await fakeHost(t, dir);
  const { base, daemon } = await startDaemon(t, dir);

  const huge = "x".repeat(17 * 1024 * 1024);
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { pad: huge } }),
  }).catch((error) => error);
  // The daemon destroys the request, so either the 413 lands or the write fails first.
  if (response instanceof Error) assert.match(String(response), /fetch failed|terminated|socket/i);
  else assert.equal(response.status, 413);
  assert.equal(daemon.sessions.size, 0);
});

test("a malformed body is a parse error, not a crash", async (t) => {
  const dir = tempDir(t);
  await fakeHost(t, dir);
  const { base } = await startDaemon(t, dir);

  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: "{not json",
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, -32700);
});

test("an unknown path is 404 and needs no token", async (t) => {
  const dir = tempDir(t);
  await fakeHost(t, dir);
  const { base } = await startDaemon(t, dir);
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 404);
});

test("SIGTERM closes every session's socket before the daemon exits", async (t) => {
  const dir = tempDir(t);
  const host = await fakeHost(t, dir);
  fs.writeFileSync(path.join(dir, "daemon.json"), JSON.stringify({ port: 0, token: TOKEN, secret: SECRET }), { mode: 0o600 });

  const child = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, BROWSER_BRIDGE_RUNTIME_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  let stderr = "";
  const port = await new Promise((resolve, reject) => {
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(stderr);
      if (match) resolve(Number(match[1]));
    });
    child.once("exit", (code) => reject(new Error(`the daemon exited with ${code}: ${stderr}`)));
  });

  const { client } = await connectClient(t, port, { "X-Browser-Bridge-Session": "doomed" });
  await client.callTool({ name: "browser_status", arguments: {} });
  assert.equal(host.hellos().at(-1).params.name, "doomed");

  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
  assert.equal(host.received.at(-1).method, "bye", "the socket was closed cleanly, not dropped");
  assert.match(stderr, /session end/);
});

test("the headers the helper prints are the headers the daemon accepts", async (t) => {
  const dir = tempDir(t);
  const host = await fakeHost(t, dir);
  fs.writeFileSync(path.join(dir, "daemon.json"), JSON.stringify({ port: 0, token: TOKEN, secret: SECRET }), { mode: 0o600 });

  // Exactly what an agent does: run the helper in the session's environment, then send
  // whatever it printed. Nothing in between knows what the headers are called.
  const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "headers.js");
  const printed = spawnSync(process.execPath, [helper], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: os.homedir(),
      BROWSER_BRIDGE_RUNTIME_DIR: dir,
      BROWSER_BRIDGE_SESSION_NAME: "#12 fix-login",
      CLAUDE_CONFIG_DIR: "/Users/x/.claude-tertiary",
    },
  });
  assert.equal(printed.status, 0, printed.stderr);
  const headers = JSON.parse(printed.stdout);

  const { port } = await startDaemon(t, dir);
  const client = new Client({ name: "helper-driven", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers },
  });
  await client.connect(transport);
  t.after(() => client.close().catch(() => {}));

  await client.callTool({ name: "browser_status", arguments: {} });
  const hello = host.hellos().at(-1);
  assert.equal(hello.params.name, "#12 fix-login");
  assert.equal(hello.params.agent, "claude");
  assert.equal(hello.params.account, ".claude-tertiary");
});

test("the daemon refuses to start without a daemon.json", async (t) => {
  const dir = tempDir(t);
  const child = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, BROWSER_BRIDGE_RUNTIME_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 1);
  assert.match(stderr, /daemon\.json/);
  assert.match(stderr, /bin\/install\.js/);
});

test("header values are trimmed, stripped of control characters and capped", () => {
  assert.equal(sanitizeHeaderValue("  #12 fix-login  "), "#12 fix-login");
  assert.equal(sanitizeHeaderValue("a\r\nX-Injected: 1"), "aX-Injected: 1");
  assert.equal(sanitizeHeaderValue("x".repeat(200)).length, 80);
  assert.equal(sanitizeHeaderValue("agent", 3), "age");
  assert.equal(sanitizeHeaderValue(""), null);
  assert.equal(sanitizeHeaderValue("   "), null);
  assert.equal(sanitizeHeaderValue(" "), null);
  assert.equal(sanitizeHeaderValue(undefined), null);
  assert.equal(sanitizeHeaderValue(["first", "second"]), "first");
});

test("healthz is behind the same Host and Origin checks as everything else", async (t) => {
  const dir = tempDir(t);
  await fakeHost(t, dir);
  const { port, base } = await startDaemon(t, dir);

  // It needs no token - it is loopback-only and the installer waits on it - but it does say
  // this machine's pid and the socket path, and so the username. A page that got the browser
  // to resolve a name to 127.0.0.1 could read all of that.
  const withOrigin = await fetch(`${base}/healthz`, { headers: { Origin: "https://evil.example" } });
  assert.equal(withOrigin.status, 403);
  assert.equal(withOrigin.headers.get("access-control-allow-origin"), null);
  assert.equal((await withOrigin.json()).error.message, "Origin header is not accepted");

  const raw = await rawRequest(port, "GET /healthz HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n");
  assert.match(raw, /^HTTP\/1\.1 403/);
  assert.match(raw, /Invalid Host header: evil\.example/);
  assert.equal(raw.includes(dir), false, "and it leaks nothing while refusing");

  // A Host header with no port at all is refused too, not treated as loopback.
  const bare = await rawRequest(port, "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
  assert.match(bare, /^HTTP\/1\.1 403/);

  // The real thing still answers.
  assert.equal((await (await fetch(`${base}/healthz`)).json()).ok, true);
});

test("an unknown path is refused before it is routed, too", async (t) => {
  const dir = tempDir(t);
  await fakeHost(t, dir);
  const { port } = await startDaemon(t, dir);
  const raw = await rawRequest(port, "GET /nope HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n");
  assert.match(raw, /^HTTP\/1\.1 403/, "the Host check comes first, so no endpoint can skip it");
});

test("shutdown does not wait out a wedged host", async (t) => {
  const dir = tempDir(t);
  // A host that takes `bye` and never answers. The client's own request timeout is 100 s, so
  // waiting for the reply meant launchd SIGKILLed the daemon before any session said
  // goodbye - and the extension kept every tab group listed as live.
  const host = await fakeHost(t, dir, (message) => {
    if (message.method === "hello" || message.method === "host_status") return { ok: true, result: HOST_STATUS };
    if (message.method === "bye") return null;
    return { ok: true, result: { text: "ok" } };
  });
  const { port, daemon } = await startDaemon(t, dir);

  await rawSession(port, "session one");
  await rawSession(port, "session two");
  await rawSession(port, "session three");
  assert.equal(daemon.sessions.size, 3);

  const started = Date.now();
  await daemon.shutdown("SIGTERM received");
  const took = Date.now() - started;

  assert.equal(daemon.sessions.size, 0);
  assert.equal(host.received.filter((message) => message.method === "bye").length, 3, "all three said bye");
  // Three sessions in parallel against a 2 s deadline, not 3 x 100 s in series.
  assert.ok(took < 6_000, `shutdown took ${took} ms`);
});

test("a session whose initialize fails after it was registered does not linger", async (t) => {
  const dir = tempDir(t);
  const host = await fakeHost(t, dir);
  // The session is registered by onsessioninitialized *before* its initialize response goes
  // out, so a throw in between used to leave it and its socket for the 24-hour sweep. Nothing
  // real throws there, which is why the daemon takes a hook.
  const { port, daemon, logs } = await startDaemon(t, dir, {
    onSessionServer: async () => {
      throw new Error("the transport fell over");
    },
  });

  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
      "X-Browser-Bridge-Session": "doomed at birth",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
    }),
  }).catch((error) => error);
  if (!(response instanceof Error)) await response.text().catch(() => {});

  assert.equal(daemon.sessions.size, 0, "nothing is left holding a socket");
  assert.ok(
    logs.some((line) => line.includes("session end") && /its initialize (failed|answered)/.test(line)),
    logs.join("\n"),
  );
  assert.equal(host.hellos().length, 0, "it never got as far as the host");
});

test("a stream lost after a long quiet spell still gets its ten minutes", async (t) => {
  const dir = tempDir(t);
  await fakeHost(t, dir);
  let clock = 2_000;
  const { port, daemon } = await startDaemon(t, dir, { now: () => clock });

  const sessionId = await rawSession(port, "long thinker");
  const stream = await openStream(port, sessionId);
  await settle();

  // Half an hour of thinking with the stream open, which is an ordinary agent turn.
  clock += 30 * 60 * 1000;
  assert.deepEqual(await daemon.sweep(clock), [], "an open stream is alive");

  // Now the stream drops. Measuring the ten minutes from the last *request* would have ended
  // this session on the very next sweep, having given it no grace at all.
  stream.close();
  await settle();
  assert.deepEqual(await daemon.sweep(clock), [], "the clock starts when the stream goes");
  assert.deepEqual(await daemon.sweep(clock + STREAM_LOSS_IDLE_MS - 1), []);
  assert.equal(daemon.sessions.size, 1);
  assert.deepEqual(await daemon.sweep(clock + STREAM_LOSS_IDLE_MS), [sessionId]);
});

test("an id the client itself closed is dead, not adopted", async (t) => {
  const dir = tempDir(t);
  const host = await fakeHost(t, dir);
  const { port, daemon } = await startDaemon(t, dir);

  const sessionId = await rawSession(port, "said goodbye");
  const byes = () => host.received.filter((message) => message.method === "bye").length;

  const deleted = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Mcp-Session-Id": sessionId,
      "Mcp-Protocol-Version": "2025-06-18",
    },
  });
  assert.equal(deleted.status, 200);
  await settle();
  assert.equal(byes(), 1);
  assert.equal(daemon.sessions.size, 0);

  // DELETE released the tab group; the extension has let it go. Adopting the id back would
  // take the group with it, so an id its own client closed stays closed.
  const after = await rpc(
    port,
    { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} },
    { sessionId, headers: { "X-Browser-Bridge-Session": "said goodbye" } },
  );
  assert.equal(after.response.status, 404);
  assert.equal(after.message.error.code, -32001);
  assert.equal(daemon.sessions.size, 0);
  assert.equal(host.hellos().length, 1, "no second hello, so no revived group");
  assert.equal(daemon.registry.get(deriveRegistryKey(SECRET, sessionId)).endedBy, "client");

  // And the same for a session the daemon *adopted* rather than started, which is the path a
  // client takes after a restart. Its DELETE has to be just as final; it was not, and the id
  // could be adopted a second time and take back the group DELETE had released.
  const adopted = "an-id-this-daemon-never-issued";
  await rpc(
    port,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_status", arguments: {} } },
    { sessionId: adopted, headers: { "X-Browser-Bridge-Session": "adopted then gone" } },
  );
  assert.equal(daemon.sessions.size, 1);
  const goodbye = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Mcp-Session-Id": adopted,
      "Mcp-Protocol-Version": "2025-06-18",
    },
  });
  assert.equal(goodbye.status, 200);
  await settle();
  assert.equal(daemon.registry.get(deriveRegistryKey(SECRET, adopted)).endedBy, "client");
  const again = await rpc(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { sessionId: adopted });
  assert.equal(again.response.status, 404, "an adopted session's DELETE is final too");
  assert.equal(byes(), 2);
});

test("an initialize carrying a stale session id starts a new session", async (t) => {
  const dir = tempDir(t);
  const host = await fakeHost(t, dir);
  const { port, daemon, logs } = await startDaemon(t, dir);

  // An adopted transport is already initialized, so handing it an initialize would be a 400
  // for the life of that session. A client starting over is not a session to adopt.
  const started = await rpc(
    port,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
    },
    { sessionId: "an-id-from-a-previous-life", headers: { "X-Browser-Bridge-Session": "starting over" } },
  );
  assert.equal(started.response.status, 200);
  assert.notEqual(started.sessionId, "an-id-from-a-previous-life", "a new id, and a new derived key");
  assert.equal(daemon.sessions.size, 1);
  assert.ok(logs.some((line) => line.includes("initialize carried a session id this daemon does not have")));

  // And the new session works, under the key its new id derives.
  await rpc(port, { jsonrpc: "2.0", method: "notifications/initialized" }, { sessionId: started.sessionId });
  const call = await rpc(
    port,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_status", arguments: {} } },
    { sessionId: started.sessionId },
  );
  assert.match(JSON.stringify(call.message), /Session: starting over/);
  assert.equal(host.hellos().at(-1).params.sessionKey, deriveSessionKey(SECRET, started.sessionId));
});

test("two requests for the same unknown id share one adoption", async (t) => {
  const dir = tempDir(t);
  const host = await fakeHost(t, dir);
  const { port, daemon } = await startDaemon(t, dir);

  // An agent that resumes with a tool call while its event stream reconnects sends exactly
  // this: two requests for one unknown id, on separate connections, at the same time.
  const sessionId = "two-at-once-for-the-same-id";
  const [a, b] = await Promise.all([
    rpc(
      port,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_status", arguments: {} } },
      { sessionId, headers: { "X-Browser-Bridge-Session": "racer" } },
    ),
    rpc(
      port,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { sessionId, headers: { "X-Browser-Bridge-Session": "racer" } },
    ),
  ]);

  assert.equal(a.response.status, 200);
  assert.equal(b.response.status, 200);
  assert.equal(daemon.sessions.size, 1, "one session, not two");
  assert.equal(host.hellos().length, 1, "and one socket client on that tab group");
});

test("the daemon refuses an absurd session id and a runaway number of sessions", async (t) => {
  const dir = tempDir(t);
  await fakeHost(t, dir);
  const { port, daemon } = await startDaemon(t, dir);

  for (const bad of ["", "x".repeat(129), "has\ttab", "café"]) {
    const response = await rpc(port, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { sessionId: bad });
    // An empty header is simply absent, so that one is the no-session-id 400; the rest are
    // refused on their shape. Either way nothing is adopted.
    assert.equal(response.response.status, 400, JSON.stringify(bad));
  }
  assert.equal(daemon.sessions.size, 0);

  // A cap, so a client looping on new session ids cannot take the machine with it.
  for (let index = 0; index < MAX_LIVE_SESSIONS; index++) {
    daemon.sessions.set(`filler-${index}`, { inFlight: 0, openStreams: 0, lastSeenAt: 0 });
  }
  const full = await rpc(port, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { sessionId: "one-more" });
  assert.equal(full.response.status, 503);
  assert.match(full.message.error.message, new RegExp(`already holding ${MAX_LIVE_SESSIONS} sessions`));
});

test("the sweep keeps a live but quiet session's registry entry", async (t) => {
  const dir = tempDir(t);
  await fakeHost(t, dir);
  let clock = 2_000;
  const { port, daemon } = await startDaemon(t, dir, { now: () => clock });

  const sessionId = await rawSession(port, "quiet but here");
  const stream = await openStream(port, sessionId);
  await settle();

  // A day and a half of an open stream and no calls. The session lives (the stream says so),
  // and its entry must live with it - pruning it would cost the session its name and, before
  // keys were derived, its tab group.
  clock += 36 * 60 * 60 * 1000;
  assert.deepEqual(await daemon.sweep(clock), []);
  assert.equal(daemon.sessions.size, 1);
  assert.ok(daemon.registry.get(deriveRegistryKey(SECRET, sessionId)), "still remembered");
  stream.close();
});

test("a session name with an em dash or an emoji survives both paths", async (t) => {
  const dir = tempDir(t);
  const host = await fakeHost(t, dir);
  const { port } = await startDaemon(t, dir);

  for (const [label, name] of [
    ["em dash", "#12 fix—login"],
    ["emoji", "#13 ship 🚀"],
    ["curly quote", "#14 don’t break"],
  ]) {
    // The helper's path: percent-encoded, because a code point above U+00FF makes a Headers
    // constructor throw and that stops the whole MCP connection, not one call.
    const encoded = await rawSession(port, encodeURIComponent(name));
    assert.equal(host.hellos().at(-1).params.name, name, `${label} via the helper`);

    // Codex's path: env_http_headers sends the raw UTF-8 bytes, which arrive latin1-decoded.
    const raw = Buffer.from(name, "utf8").toString("latin1");
    await rawSession(port, raw);
    assert.equal(host.hellos().at(-1).params.name, name, `${label} via env_http_headers`);
    assert.ok(encoded);
  }

  // And a name that really is Latin-1 is left alone rather than reinterpreted.
  await rawSession(port, "café #15");
  assert.equal(host.hellos().at(-1).params.name, "café #15");
});

test("no log line ever carries a session id", async (t) => {
  const dir = tempDir(t);
  await fakeHost(t, dir);
  let clock = 2_000;
  const { port, daemon, logs } = await startDaemon(t, dir, { now: () => clock });

  // daemon.log is a file, and an id plus daemon.json's secret derives that session's key. So a
  // log that printed ids put back exactly the exposure that deriving keys removed.
  const started = await rawSession(port, "#12 in the log");
  const adopted = "an-id-from-before-the-restart";
  await rpc(
    port,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_status", arguments: {} } },
    { sessionId: adopted, headers: { "X-Browser-Bridge-Session": "adopted into the log" } },
  );
  const stream = await openStream(port, started);
  await settle();
  stream.close();
  await settle();
  clock += STREAM_LOSS_IDLE_MS;
  await daemon.sweep(clock);
  await daemon.shutdown("test over");

  const written = logs.join("\n");
  assert.ok(written.includes("session start"), written);
  assert.ok(written.includes("session adopted"));
  assert.ok(written.includes("session end"));
  for (const id of [started, adopted]) {
    assert.equal(written.includes(id), false, `the log names ${id}`);
    // What it does carry is eight characters of a one-way tag: enough to follow one session
    // through a log and tell two apart, and no use to anybody deriving a key.
    const tag = deriveRegistryKey(SECRET, id).slice(0, 8);
    assert.ok(written.includes(tag), `no tag for ${id}`);
    assert.equal(written.includes(deriveRegistryKey(SECRET, id)), false, "and not the whole tag");
    assert.equal(written.includes(deriveSessionKey(SECRET, id)), false, "and never the key");
  }
  // The names are there, because that is what a person reads the log for.
  assert.ok(written.includes("#12 in the log"));
  assert.ok(written.includes("adopted into the log"));
});

test("the session cap holds on every path that would make a session", async (t) => {
  const dir = tempDir(t);
  await fakeHost(t, dir);
  const { port, daemon } = await startDaemon(t, dir);

  for (let index = 0; index < MAX_LIVE_SESSIONS; index++) {
    daemon.sessions.set(`filler-${index}`, { inFlight: 0, openStreams: 0, lastSeenAt: 0 });
  }
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
  };

  // A plain initialize is refused...
  assert.equal((await rpc(port, initialize)).response.status, 503);
  // ...and so is one carrying an unknown session id, which used to walk straight past the cap
  // on its way to starting a session anyway.
  const withStaleId = await rpc(port, initialize, { sessionId: "any-old-id" });
  assert.equal(withStaleId.response.status, 503);
  assert.match(withStaleId.message.error.message, new RegExp(`already holding ${MAX_LIVE_SESSIONS}`));
  assert.equal(daemon.sessions.size, MAX_LIVE_SESSIONS, "no 201st session");
});

test("a second initialize on a live session is refused, not forked", async (t) => {
  const dir = tempDir(t);
  const host = await fakeHost(t, dir);
  const { port, daemon } = await startDaemon(t, dir);

  const sessionId = await rawSession(port, "already going");
  assert.equal(daemon.sessions.size, 1);

  // Starting a new session here would fork the client in two and abandon the tab group it is
  // using. It belongs to the transport, which knows it is already initialized.
  const again = await rpc(
    port,
    {
      jsonrpc: "2.0",
      id: 5,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
    },
    { sessionId },
  );
  assert.equal(again.response.status, 400);
  assert.match(again.message.error.message, /already initialized/i);
  assert.equal(daemon.sessions.size, 1, "the session it already had, and only that one");
  assert.ok(daemon.sessions.has(sessionId));
  assert.equal(host.hellos().length, 1, "and one socket client on that tab group");
});
