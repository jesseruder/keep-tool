// The installer, against a temp HOME. Nothing here touches the real browser profiles:
// the dry run writes nothing, and the plan is checked as data.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPlan,
  claudeConfigDirs,
  codexHomes,
  hostManifest,
  hostManifestPath,
  launcherScript,
  main,
  parseArgs,
} from "../bin/install.js";
import { EXTENSION_ID, EXTENSION_ORIGIN, HOST_NAME } from "../host/protocol.js";

function fakeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bb-home-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude-secondary"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude-secondary", ".claude.json"), "{}");
  // A ~/.claude-* directory with no config is not a config directory.
  fs.mkdirSync(path.join(home, ".claude-notes"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { HOME: home };
}

function capture(fn) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

test("arguments select the browsers and the mode", () => {
  assert.deepEqual(parseArgs([]), { browsers: ["edge"], dryRun: false, uninstall: false });
  assert.deepEqual(parseArgs(["--browser", "chrome"]).browsers, ["chrome"]);
  assert.deepEqual(parseArgs(["--chrome-too"]).browsers, ["edge", "chrome"]);
  assert.equal(parseArgs(["--dry-run"]).dryRun, true);
  assert.equal(parseArgs(["--uninstall"]).uninstall, true);
  assert.throws(() => parseArgs(["--browser", "safari"]), /--browser must be edge or chrome/);
  assert.throws(() => parseArgs(["--wat"]), /Unknown argument/);
});

test("the native messaging manifest names the launcher and only our extension", (t) => {
  const env = fakeHome(t);
  const manifest = hostManifest(env);
  assert.equal(manifest.name, HOST_NAME);
  assert.equal(manifest.type, "stdio");
  assert.deepEqual(manifest.allowed_origins, [EXTENSION_ORIGIN]);
  assert.equal(manifest.allowed_origins[0], `chrome-extension://${EXTENSION_ID}/`);
  assert.equal(manifest.path, path.join(env.HOME, "Library/Application Support/BrowserBridge/native-host"));

  assert.equal(
    hostManifestPath("edge", env),
    path.join(env.HOME, "Library/Application Support/Microsoft Edge/NativeMessagingHosts", `${HOST_NAME}.json`),
  );
  assert.equal(
    hostManifestPath("chrome", env),
    path.join(
      env.HOME,
      "Library/Application Support/Google/Chrome/NativeMessagingHosts",
      `${HOST_NAME}.json`,
    ),
  );
});

test("the launcher execs an absolute node with an absolute script", () => {
  const script = launcherScript("/opt/node/bin/node", "/srv/browser-bridge");
  assert.equal(script, '#!/bin/sh\nexec /opt/node/bin/node /srv/browser-bridge/host/native-host.js "$@"\n');
  assert.equal(script.split("\n").filter(Boolean).length, 2);
});

test("every Claude config directory with a config is registered, plus the default", (t) => {
  const env = fakeHome(t);
  const dirs = claudeConfigDirs(env);
  assert.deepEqual(
    dirs.map((entry) => path.basename(entry.dir)),
    [".claude", ".claude-secondary"],
  );
  // The default directory keeps its config at ~/.claude.json, so no CLAUDE_CONFIG_DIR.
  assert.equal(dirs[0].useEnv, false);
  assert.equal(dirs[1].useEnv, true);
  assert.deepEqual(codexHomes(env), [path.join(env.HOME, ".codex")]);
});

test("the plan writes the launcher and the manifests and registers both CLIs", (t) => {
  const env = fakeHome(t);
  const plan = buildPlan({ browsers: ["edge", "chrome"], uninstall: false }, env);

  assert.deepEqual(
    plan.files.map((file) => file.path),
    [
      path.join(env.HOME, "Library/Application Support/BrowserBridge/native-host"),
      hostManifestPath("edge", env),
      hostManifestPath("chrome", env),
    ],
  );
  assert.equal(plan.files[0].mode, 0o700);
  assert.match(plan.files[0].content, /^#!\/bin\/sh\n/);
  assert.deepEqual(JSON.parse(plan.files[1].content), hostManifest(env));

  const claude = plan.commands.filter((command) => command.name === "claude");
  assert.equal(claude.length, 2);
  // The default dir must shed an inherited CLAUDE_CONFIG_DIR, or a session started
  // under another config dir would register the server there twice.
  assert.deepEqual(claude[0].env, { CLAUDE_CONFIG_DIR: null });
  assert.deepEqual(claude[0].args.slice(0, 5), ["mcp", "add", "--scope", "user", "browser"]);
  assert.equal(claude[0].args[5], "--");
  assert.equal(claude[0].args[6], process.execPath);
  assert.match(claude[0].args[7], /mcp\/server\.js$/);
  assert.equal(claude[1].env.CLAUDE_CONFIG_DIR, path.join(env.HOME, ".claude-secondary"));

  const codex = plan.commands.filter((command) => command.name === "codex");
  assert.equal(codex.length, 1);
  assert.equal(codex[0].env.CODEX_HOME, path.join(env.HOME, ".codex"));
  assert.deepEqual(codex[0].args.slice(0, 3), ["mcp", "add", "browser"]);
  assert.equal(codex[0].args[3], "--");
});

test("uninstall removes the manifests and unregisters the servers", (t) => {
  const env = fakeHome(t);
  const plan = buildPlan({ browsers: ["edge"], uninstall: true }, env);
  assert.equal(plan.files.length, 0);
  assert.deepEqual(plan.removals, [
    path.join(env.HOME, "Library/Application Support/BrowserBridge/native-host"),
    hostManifestPath("edge", env),
  ]);
  for (const command of plan.commands) assert.ok(command.args.includes("remove"), command.label);
});

test("a missing CLI still tells the user exactly what to add", (t) => {
  const env = fakeHome(t);
  const plan = buildPlan({ browsers: ["edge"], uninstall: false }, env);
  for (const command of plan.commands) {
    assert.match(command.fallback, /browser/);
    if (command.name === "codex") assert.match(command.fallback, /\[mcp_servers\.browser\]/);
    else assert.match(command.fallback, /"mcpServers"/);
  }
});

test("--dry-run prints every file and command and changes nothing", (t) => {
  const env = fakeHome(t);
  const output = capture(() => main(["--dry-run", "--chrome-too"], env));

  assert.match(output, /# Browser Bridge install/);
  assert.match(output, /write .*BrowserBridge\/native-host \(mode 700\)/);
  assert.match(output, /#!\/bin\/sh/);
  assert.match(output, /Microsoft Edge\/NativeMessagingHosts\/com\.keep\.browser_bridge\.json/);
  assert.match(output, /Google\/Chrome\/NativeMessagingHosts\/com\.keep\.browser_bridge\.json/);
  assert.match(output, new RegExp(`chrome-extension://${EXTENSION_ID}/`));
  assert.match(output, /run {2}.*mcp add --scope user browser --/);
  assert.match(output, /CLAUDE_CONFIG_DIR=.*\.claude-secondary/);
  assert.match(output, /CODEX_HOME=.*\.codex /);
  assert.match(output, /Load unpacked/);
  assert.match(output, new RegExp(EXTENSION_ID));

  assert.equal(fs.existsSync(path.join(env.HOME, "Library")), false, "a dry run writes nothing");
});

test("a real run into a temp HOME writes the launcher and manifest", (t) => {
  const env = fakeHome(t);
  // Skip the CLI registration by pointing the plan at a HOME with no agent homes.
  fs.rmSync(path.join(env.HOME, ".claude"), { recursive: true, force: true });
  fs.rmSync(path.join(env.HOME, ".claude-secondary"), { recursive: true, force: true });
  fs.rmSync(path.join(env.HOME, ".codex"), { recursive: true, force: true });

  const plan = buildPlan({ browsers: ["edge"], uninstall: false }, env);
  assert.equal(plan.commands.length, 0, "nothing to register, so nothing is run");

  capture(() => main([], env));
  const launcher = path.join(env.HOME, "Library/Application Support/BrowserBridge/native-host");
  assert.ok(fs.existsSync(launcher));
  assert.equal(fs.statSync(launcher).mode & 0o777, 0o700);
  const manifest = JSON.parse(fs.readFileSync(hostManifestPath("edge", env), "utf8"));
  assert.deepEqual(manifest.allowed_origins, [EXTENSION_ORIGIN]);
  assert.equal(manifest.path, launcher);

  capture(() => main(["--uninstall"], env));
  assert.equal(fs.existsSync(launcher), false);
  assert.equal(fs.existsSync(hostManifestPath("edge", env)), false);
});
