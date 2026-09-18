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
