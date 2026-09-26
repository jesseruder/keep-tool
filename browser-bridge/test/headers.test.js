// The headers helper. Both agents run this on every request to the daemon, so the one
// thing it may never do is fail: no daemon.json still has to be a clean `{}` and exit 0.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildHeaders } from "../bin/headers.js";
import { parsePsTable, processStarted } from "../host/protocol.js";

const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "headers.js");
const TOKEN = "a1b2c3d4".repeat(8);

function runtime(t, config = { port: 47331, token: TOKEN }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-headers-"));
  if (config) fs.writeFileSync(path.join(dir, "daemon.json"), JSON.stringify(config), { mode: 0o600 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("with a daemon.json the token comes back as a Bearer header", (t) => {
  const dir = runtime(t);
  const headers = buildHeaders({ BROWSER_BRIDGE_RUNTIME_DIR: dir });
  assert.deepEqual(headers, { Authorization: `Bearer ${TOKEN}` });
});

test("a pane Keep could not name at launch sends the name keep browser show left for it", (t) => {
  const dir = runtime(t);
  fs.mkdirSync(path.join(dir, "pane-names"));
  // Left by a command the agent ran: bound to the agent process, one of ours here.
  const leave = (pane, pid, started = processStarted(pid)) =>
    fs.writeFileSync(path.join(dir, "pane-names", pane), `${JSON.stringify({ name: "#405", pid, started })}\n`);
  leave("54738c1e", process.ppid);
  const named = (env) => buildHeaders({ BROWSER_BRIDGE_RUNTIME_DIR: dir, ...env })["X-Browser-Bridge-Session"];
  assert.equal(named({ KEEP_PANE: "54738c1e" }), "#405");
  // The launch name wins, another pane has none, and a pane id is never a path.
  assert.equal(named({ KEEP_PANE: "54738c1e", BROWSER_BRIDGE_SESSION_NAME: "#12 fix" }), "#12 fix");
  assert.equal(named({ KEEP_PANE: "0000aaaa" }), undefined);
  assert.equal(named({ KEEP_PANE: "../pane-names/54738c1e" }), undefined);

  // A name left by an earlier process in a reused pane is not this session's, and nor is
  // one left by a process whose pid has since been handed to ours.
  leave("54738c1e", 2 ** 30, "1");
  assert.equal(named({ KEEP_PANE: "54738c1e" }), undefined);
  leave("54738c1e", process.ppid, "0");
  assert.equal(named({ KEEP_PANE: "54738c1e" }), undefined);
  fs.writeFileSync(path.join(dir, "pane-names", "54738c1e"), "#405\n");
  assert.equal(named({ KEEP_PANE: "54738c1e" }), undefined);
});

test("the session name, agent and account ride along when the environment has them", (t) => {
  const dir = runtime(t);
  assert.deepEqual(
    buildHeaders({
      BROWSER_BRIDGE_RUNTIME_DIR: dir,
      BROWSER_BRIDGE_SESSION_NAME: "  #12 fix-login  ",
      CLAUDE_CONFIG_DIR: "/Users/x/.claude-tertiary",
    }),
    {
      Authorization: `Bearer ${TOKEN}`,
      "X-Browser-Bridge-Session": "#12 fix-login",
      "X-Browser-Bridge-Agent": "claude",
      // basename of the config dir, dot and all: exactly what a stdio session sends today.
      "X-Browser-Bridge-Account": ".claude-tertiary",
    },
  );

  // Codex names itself through CODEX_HOME, and KEEP_AGENT_ACCOUNT_ID wins over both.
  assert.deepEqual(buildHeaders({ BROWSER_BRIDGE_RUNTIME_DIR: dir, CODEX_HOME: "/Users/x/.codex-secondary" }), {
    Authorization: `Bearer ${TOKEN}`,
    "X-Browser-Bridge-Agent": "codex",
    "X-Browser-Bridge-Account": ".codex-secondary",
  });
  assert.equal(
    buildHeaders({
      BROWSER_BRIDGE_RUNTIME_DIR: dir,
      CLAUDE_CODE_SESSION_ID: "abc",
      KEEP_AGENT_ACCOUNT_ID: "claude-secondary",
    })["X-Browser-Bridge-Account"],
    "claude-secondary",
  );
});

test("an empty session name is left out rather than sent blank", (t) => {
  const dir = runtime(t);
  const headers = buildHeaders({ BROWSER_BRIDGE_RUNTIME_DIR: dir, BROWSER_BRIDGE_SESSION_NAME: "   " });
  assert.equal("X-Browser-Bridge-Session" in headers, false);
});

test("no daemon.json, a broken one or one with no token is an empty object", (t) => {
  assert.deepEqual(buildHeaders({ BROWSER_BRIDGE_RUNTIME_DIR: runtime(t, null) }), {});

  const broken = runtime(t, null);
  fs.writeFileSync(path.join(broken, "daemon.json"), "{ not json");
  assert.deepEqual(buildHeaders({ BROWSER_BRIDGE_RUNTIME_DIR: broken }), {});

  const tokenless = runtime(t, { port: 47331 });
  assert.deepEqual(buildHeaders({ BROWSER_BRIDGE_RUNTIME_DIR: tokenless }), {});

  // A directory where daemon.json should be is not a crash either.
  const weird = runtime(t, null);
  fs.mkdirSync(path.join(weird, "daemon.json"));
  assert.deepEqual(buildHeaders({ BROWSER_BRIDGE_RUNTIME_DIR: weird }), {});
});

test("the process prints one JSON object and exits 0, with or without a bridge", (t) => {
  const installed = runtime(t);
  const bare = runtime(t, null);

  for (const [dir, expected] of [
    [installed, { Authorization: `Bearer ${TOKEN}`, "X-Browser-Bridge-Session": "keep #7" }],
    [bare, {}],
  ]) {
    const result = spawnSync(process.execPath, [HELPER], {
      encoding: "utf8",
      env: {
        HOME: os.homedir(),
        PATH: process.env.PATH,
        BROWSER_BRIDGE_RUNTIME_DIR: dir,
        BROWSER_BRIDGE_SESSION_NAME: "keep #7",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), expected);
    assert.equal(result.stdout.trimEnd().split("\n").length, 1, "one line, nothing else");
  }
});

test("the helper still runs when started through a symlink, from a path a URL has to encode", (t) => {
  // import.meta.url is percent-encoded and symlink-resolved, so a plain comparison with
  // `file://${argv[1]}` would decide this is not the main module and print nothing at all.
  const dir = runtime(t);
  const odd = path.join(dir, "a dir with 100% spaces é");
  fs.mkdirSync(odd);
  const link = path.join(odd, "headers.js");
  fs.symlinkSync(HELPER, link);
  const result = spawnSync(process.execPath, [link], {
    encoding: "utf8",
    env: { HOME: dir, PATH: process.env.PATH, BROWSER_BRIDGE_RUNTIME_DIR: dir },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { Authorization: `Bearer ${TOKEN}` });
});

test("a hostile environment value cannot break the client's request", (t) => {
  const dir = runtime(t);

  // A CR/LF in a header value makes the client's own Headers constructor throw, and then the
  // browser server does not connect at all - not one call fails, every call does. So the
  // helper sanitises what it sends, exactly as the daemon sanitises what it receives.
  const injected = buildHeaders({
    BROWSER_BRIDGE_RUNTIME_DIR: dir,
    BROWSER_BRIDGE_SESSION_NAME: "evil\r\nX-Injected: 1",
  });
  assert.equal(injected["X-Browser-Bridge-Session"], "evilX-Injected: 1");
  assert.equal("X-Injected" in injected, false);

  // Twenty thousand bytes of session name is an HTTP 431 from anything sane: capped instead.
  const huge = buildHeaders({
    BROWSER_BRIDGE_RUNTIME_DIR: dir,
    BROWSER_BRIDGE_SESSION_NAME: "x".repeat(20_000),
  });
  assert.equal(huge["X-Browser-Bridge-Session"].length, 80);

  // A value a header cannot carry as-is is percent-encoded, not dropped: an em dash in a
  // branch name should not cost a session its name, and a code point above U+00FF makes the
  // client's own Headers constructor throw - which stops the whole connection, not one call.
  for (const name of ["fix 中文", "#12 fix—login", "#13 ship 🚀"]) {
    const wide = buildHeaders({ BROWSER_BRIDGE_RUNTIME_DIR: dir, BROWSER_BRIDGE_SESSION_NAME: name });
    assert.equal(decodeURIComponent(wide["X-Browser-Bridge-Session"]), name, name);
    assert.match(wide["X-Browser-Bridge-Session"], /^[\x20-\x7e]*$/, "on the wire it is plain ASCII");
    assert.equal(wide.Authorization, `Bearer ${TOKEN}`);
  }

  // Plain ASCII is left exactly as it is, so the common case still reads normally in a log.
  assert.equal(
    buildHeaders({ BROWSER_BRIDGE_RUNTIME_DIR: dir, BROWSER_BRIDGE_SESSION_NAME: "#12 fix-login" })[
      "X-Browser-Bridge-Session"
    ],
    "#12 fix-login",
  );

  // Every value the helper prints is one a real client can put in a real request.
  for (const env of [
    { BROWSER_BRIDGE_SESSION_NAME: "evil\r\nX-Injected: 1" },
    { BROWSER_BRIDGE_SESSION_NAME: "x".repeat(20_000) },
    { BROWSER_BRIDGE_SESSION_NAME: "fix 中文" },
    { BROWSER_BRIDGE_SESSION_NAME: "plain #1", KEEP_AGENT_ACCOUNT_ID: "acct ish", CLAUDE_CODE_SESSION_ID: "s" },
  ]) {
    const headers = buildHeaders({ BROWSER_BRIDGE_RUNTIME_DIR: dir, ...env });
    assert.doesNotThrow(() => new Headers(headers), JSON.stringify(headers));
  }
});

test("the helper's import graph never reaches the MCP SDK", () => {
  // It runs on every request both agents make; loading the SDK and zod cost ~60 ms a time.
  const imports = (file) =>
    [...fs.readFileSync(file, "utf8").matchAll(/^import[^;]*? from "([^"]+)";$/gm)].map((match) => match[1]);

  assert.deepEqual(imports(HELPER), ["../host/protocol.js", "../mcp/identity.js"]);

  // And those two are leaves themselves, so the graph really does stop there.
  for (const leaf of ["../host/protocol.js", "../mcp/identity.js"]) {
    const file = path.resolve(path.dirname(HELPER), leaf);
    for (const dependency of imports(file)) {
      assert.ok(dependency.startsWith("node:"), `${leaf} pulls in ${dependency}`);
    }
  }
});

test("ps rows parse into parent and start time, the way macOS prints them", () => {
  const table = parsePsTable("  812   1 Fri Sep 25 09:47:43 2026\n 4051  812 Fri Sep 25 10:02:11 2026\nnoise\n");
  assert.deepEqual(table.get(4051), { ppid: 812, started: "Fri Sep 25 10:02:11 2026" });
  assert.equal(table.get(812).ppid, 1);
  assert.equal(table.size, 2);
});
