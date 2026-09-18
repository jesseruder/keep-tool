// The MCP server over a real stdio transport, with no host running: the tool list has
// to be complete and a call has to come back as a tool error, never a thrown exception.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LineDecoder, encodeLine } from "../host/protocol.js";
import { TOOL_NAMES } from "../mcp/tools.js";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp", "server.js");

/** A host stand-in on the bridge socket, so the server's whole path can be exercised. */
function fakeHost(t, dir, handler) {
  const received = [];
  const server = net.createServer((socket) => {
    const decoder = new LineDecoder();
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        received.push(message);
        const reply = handler(message);
        if (reply) socket.write(encodeLine({ id: message.id, ...reply }));
      }
    });
  });
  t.after(() => server.close());
  return new Promise((resolve) => {
    server.listen(path.join(dir, "bridge.sock"), () => resolve({ received }));
  });
}

function startServer(t, dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-"))) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      BROWSER_BRIDGE_RUNTIME_DIR: dir,
      BROWSER_BRIDGE_SESSION_NAME: "test session",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = new Map();
  const waiters = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id === undefined) continue;
      responses.set(message.id, message);
      waiters.get(message.id)?.(message);
    }
  });

  t.after(() => {
    child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (id, method, params) => {
    const done = new Promise((resolve) => {
      if (responses.has(id)) resolve(responses.get(id));
      else waiters.set(id, resolve);
    });
    send({ jsonrpc: "2.0", id, method, params });
    return done;
  };
  return { child, send, request, dir };
}

test("the server initializes, lists every tool and errors cleanly with no browser", async (t) => {
  const server = startServer(t);

  const initialized = await server.request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "browser-bridge-test", version: "0" },
  });
  assert.equal(initialized.result.serverInfo.name, "browser-bridge");
  assert.match(initialized.result.instructions, /tabs_context_mcp/);
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = await server.request(2, "tools/list", {});
  const names = list.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [...TOOL_NAMES].sort());
  const readPage = list.result.tools.find((tool) => tool.name === "read_page");
  // The schema must survive the transport exactly as tools.js wrote it.
  assert.deepEqual(readPage.inputSchema.required, ["tabId"]);
  assert.deepEqual(readPage.inputSchema.properties.filter.enum, ["interactive", "all"]);

  const call = await server.request(3, "tools/call", {
    name: "read_page",
    arguments: { tabId: 1 },
  });
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /^Browser Bridge is not connected: /);
  assert.match(call.result.content[0].text, /Open Edge with the Browser Bridge extension enabled\./);
  assert.equal(call.error, undefined, "a tool failure must not be a protocol error");
});

test("gif_creator answers with a clear not-implemented error", async (t) => {
  const server = startServer(t);
  await server.request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "browser-bridge-test", version: "0" },
  });
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const call = await server.request(2, "tools/call", {
    name: "gif_creator",
    arguments: { action: "start_recording", tabId: 1 },
  });
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /not implemented yet/);
});

test("browser_status reports the missing host instead of failing", async (t) => {
  const server = startServer(t);
  await server.request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "browser-bridge-test", version: "0" },
  });
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const call = await server.request(2, "tools/call", { name: "browser_status", arguments: {} });
  assert.notEqual(call.result.isError, true);
  const text = call.result.content[0].text;
  assert.match(text, /Session: test session/);
  assert.match(text, /Native host: unreachable/);
});

// A 1x1 transparent PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("a screenshot comes back as a text block followed by an image block", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-"));
  const host = await fakeHost(t, dir, (message) => {
    if (message.method === "hello") return { ok: true, result: { extensionConnected: true } };
    if (message.method === "computer") {
      return {
        ok: true,
        result: {
          text: "Screenshot of tab 5 (https://example.com): image 1440x900 px, viewport 1440x900 CSS px; coordinates are CSS pixels. Image id ss_1.",
          image: { data: PNG, mimeType: "image/png", width: 1440, height: 900 },
          imageId: "ss_1",
        },
      };
    }
    return { ok: false, error: { message: `unexpected ${message.method}` } };
  });

  const server = startServer(t, dir);
  await server.request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "browser-bridge-test", version: "0" },
  });
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const call = await server.request(2, "tools/call", {
    name: "computer",
    arguments: { action: "screenshot", tabId: 5, save_to_disk: true },
  });
  const content = call.result.content;
  assert.equal(content.length, 2);
  assert.equal(content[0].type, "text");
  assert.match(content[0].text, /viewport 1440x900 CSS px/);
  assert.equal(content[1].type, "image");
  assert.equal(content[1].mimeType, "image/png");
  assert.equal(content[1].data, PNG);

  // save_to_disk is the server's job, and it reports where the file landed.
  const saved = content[0].text.match(/Saved to (.+\.png)/);
  assert.ok(saved, content[0].text);
  assert.ok(fs.existsSync(saved[1]));
  assert.equal(fs.readFileSync(saved[1]).toString("base64"), PNG);

  assert.equal(host.received[0].method, "hello");
  assert.equal(host.received[1].method, "computer");
});

test("browser_batch stops at the first failure and says where it stopped", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-"));
  await fakeHost(t, dir, (message) => {
    if (message.method === "hello") return { ok: true, result: {} };
    if (message.method === "navigate") return { ok: true, result: { text: "Tab 5: https://example.com" } };
    return { ok: false, error: { message: "No tab with id: 99" } };
  });

  const server = startServer(t, dir);
  await server.request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "browser-bridge-test", version: "0" },
  });
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const call = await server.request(2, "tools/call", {
    name: "browser_batch",
    arguments: {
      actions: [
        { name: "navigate", input: { url: "example.com", tabId: 5 } },
        { name: "find", input: { query: "search", tabId: 99 } },
        { name: "get_page_text", input: { tabId: 5 } },
      ],
    },
  });
  assert.equal(call.result.isError, true);
  const text = call.result.content.map((block) => block.text).join("\n");
  assert.match(text, /1\/3 navigate:/);
  assert.match(text, /2\/3 find failed: No tab with id: 99/);
  assert.match(text, /Stopped after 1 of 3 actions\./);
  assert.equal(text.includes("3/3"), false);
});

test("a page tool inside a batch must name its tab", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-"));
  await fakeHost(t, dir, () => ({ ok: true, result: { text: "ok" } }));

  const server = startServer(t, dir);
  await server.request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "browser-bridge-test", version: "0" },
  });
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const call = await server.request(2, "tools/call", {
    name: "browser_batch",
    arguments: { actions: [{ name: "navigate", input: { url: "example.com" } }] },
  });
  assert.equal(call.result.isError, true);
  const text = call.result.content.map((block) => block.text).join("\n");
  assert.match(text, /navigate requires an explicit tabId inside browser_batch/);
});

test("a nested browser_batch is refused", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-"));
  await fakeHost(t, dir, () => ({ ok: true, result: { text: "ok" } }));

  const server = startServer(t, dir);
  await server.request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "browser-bridge-test", version: "0" },
  });
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const call = await server.request(2, "tools/call", {
    name: "browser_batch",
    arguments: { actions: [{ name: "browser_batch", input: { actions: [] } }] },
  });
  assert.equal(call.result.isError, true);
  assert.match(
    call.result.content.map((block) => block.text).join("\n"),
    /browser_batch cannot be nested/,
  );
});

test("navigate refuses a host listed in config.json's blockedHosts", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ blockedHosts: ["*.internal.example"] }));
  const host = await fakeHost(t, dir, () => ({ ok: true, result: { text: "navigated" } }));

  const server = startServer(t, dir);
  await server.request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "browser-bridge-test", version: "0" },
  });
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const blocked = await server.request(2, "tools/call", {
    name: "navigate",
    arguments: { url: "admin.internal.example/secrets", tabId: 5 },
  });
  assert.equal(blocked.result.isError, true);
  assert.match(blocked.result.content[0].text, /blocked by config\.json's blockedHosts/);

  const allowed = await server.request(3, "tools/call", {
    name: "navigate",
    arguments: { url: "example.com", tabId: 5 },
  });
  assert.notEqual(allowed.result.isError, true);
  // The server normalises the URL before the browser ever sees it.
  const navigate = host.received.find((message) => message.method === "navigate");
  assert.equal(navigate.params.url, "https://example.com");
});

test("file_upload checks the paths before the browser is asked", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-"));
  const host = await fakeHost(t, dir, () => ({ ok: true, result: { text: "attached" } }));
  const good = path.join(dir, "upload.txt");
  fs.writeFileSync(good, "hello");

  const server = startServer(t, dir);
  await server.request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "browser-bridge-test", version: "0" },
  });
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const missing = await server.request(2, "tools/call", {
    name: "file_upload",
    arguments: { paths: [path.join(dir, "nope.txt")], ref: "ref_1", tabId: 5 },
  });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /No such file/);

  const ok = await server.request(3, "tools/call", {
    name: "file_upload",
    arguments: { paths: [good], ref: "ref_1", tabId: 5, files: [{ data: "x", name: "y" }] },
  });
  assert.notEqual(ok.result.isError, true);
  const upload = host.received.find((message) => message.method === "file_upload");
  assert.deepEqual(upload.params.paths, [good]);
  assert.equal(upload.params.files, undefined, "the files field is dropped, not forwarded");
});
